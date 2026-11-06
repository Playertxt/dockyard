'use strict';
// Plain Node tests (no Electron needed): node test/run-tests.js
const assert = require('assert');
const { Monitor, linearFit } = require('../src/main/monitor');
const { RuleEngine, matcher, describeRule } = require('../src/main/rules');
const { diagnose, fmtBytes } = require('../src/main/diagnose');
const L = require('../src/main/platform/linux');
const known = require('../src/main/known');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n       ')); }
}

const MB = 2 ** 20, GB = 2 ** 30;
function proc(pid, name, extra = {}) {
  return { pid, ppid: 1, name, exe: 'C:\\x\\' + name, start: 1000 + pid, threads: 4, handles: 10, cpu: 0, mem: 100 * MB, priv: 80 * MB, io: 0, user: true, windows: 0, hung: false, ...extra };
}
function sample(t, procs, extra = {}) {
  return { t, cpus: 8, cpu: 10, rx: 0, tx: 0, admin: false, memTotal: 16 * GB, memUsed: 8 * GB, procs, ...extra };
}

console.log('monitor');
test('computes I/O rates and logs starts and exits', () => {
  const m = new Monitor({ capacity: 100 });
  m.ingest(sample(0, [proc(1, 'a.exe', { io: 0 }), proc(2, 'b.exe')]));
  const s = m.ingest(sample(2000, [proc(1, 'a.exe', { io: 4 * MB }), proc(3, 'c.exe')]));
  assert.strictEqual(Math.round(s.procs.find((p) => p.pid === 1).ioRate), 2 * MB);
  const types = m.events.map((e) => e.type + ':' + e.name);
  assert.deepStrictEqual(types.sort(), ['exit:b.exe', 'start:c.exe']);
});
test('groups apps in history and ranks the timeline', () => {
  const m = new Monitor({ capacity: 100 });
  for (let i = 0; i < 10; i++) m.ingest(sample(i * 2000, [proc(1, 'chrome.exe', { cpu: 20 }), proc(2, 'chrome.exe', { cpu: 10 }), proc(3, 'idle.exe', { cpu: 1 })]));
  const tl = m.timeline('cpu', 60, { top: 2 });
  assert.strictEqual(tl.series[0].key, 'chrome.exe');
  assert.ok(Math.abs(tl.series[0].values[tl.series[0].values.length - 1] - 30) < 0.01);
  const at = m.at(8000, 'cpu');
  assert.strictEqual(at.items[0].name, 'chrome.exe');
  assert.ok(Math.abs(m.appAverages('cpu', 60).get('chrome.exe') - 30) < 0.01);
});
test('ring buffer wraps without losing the newest samples', () => {
  const m = new Monitor({ capacity: 10 });
  for (let i = 0; i < 25; i++) m.ingest(sample(i * 1000, [proc(1, 'a.exe', { cpu: i })]));
  const s = m.procSeries('1:1001', 3600);
  assert.strictEqual(s.cpu.length, 10);
  assert.strictEqual(s.cpu[s.cpu.length - 1], 24);
  assert.strictEqual(s.cpu[0], 15);
});
test('appAboveFor measures how long an app has been busy', () => {
  const m = new Monitor({ capacity: 100 });
  for (let i = 0; i < 10; i++) m.ingest(sample(i * 1000, [proc(1, 'a.exe', { cpu: i < 4 ? 1 : 50 })]));
  assert.strictEqual(m.appAboveFor('a.exe', 'cpu', 10), 5000);
});
test('per-connection byte counters become per-process speeds', () => {
  const m = new Monitor({ capacity: 10 });
  const c = (inB, outB) => [{ pid: 7, proto: 'tcp', la: '1.1.1.1', lp: 5, ra: '2.2.2.2', rp: 443, in: inB, out: outB }];
  m.ingestConnections(c(0, 0), 0);
  m.ingestConnections(c(2 * MB, MB), 2000);
  assert.strictEqual(m.netByPid.get(7).in, MB);
  assert.strictEqual(m.netByPid.get(7).out, MB / 2);
});
test('linear fit finds slope and r2', () => {
  const f = linearFit([0, 1, 2, 3], [10, 12, 14, 16]);
  assert.ok(Math.abs(f.slope - 2) < 1e-9 && Math.abs(f.r2 - 1) < 1e-9);
});
test('leak detector flags steady growth and ignores flat memory', () => {
  const m = new Monitor({ capacity: 2000 });
  for (let i = 0; i <= 400; i++) {
    m.ingest(sample(i * 3000, [proc(1, 'leaky.exe', { priv: 200 * MB + i * 1.5 * MB }), proc(2, 'flat.exe', { priv: 500 * MB + (i % 7) * MB })]));
  }
  m.leakCache.t = 0;
  const leaks = m.leaks();
  assert.deepStrictEqual(leaks.map((l) => l.name), ['leaky.exe']);
});

console.log('rules');
test('matcher handles names, globs and lists', () => {
  assert.ok(matcher('chrome.exe')('Chrome.exe'));
  assert.ok(!matcher('chrome.exe')('chromedriver.exe'));
  assert.ok(matcher('discord')('Discord.exe'));
  assert.ok(matcher('steam*, epic*')('EpicGamesLauncher.exe'));
  assert.ok(matcher('*')('anything'));
});
test('cpu rule needs the condition to last, fires once and re-arms', () => {
  const r = new RuleEngine();
  r.setRules([{ id: 'x', enabled: true, target: 'hog.exe', cond: 'cpu', value: 50, seconds: 10, action: 'notify' }]);
  const snapAt = (t, cpu) => ({ t, procs: [{ pid: 1, k: '1:1', name: 'hog.exe', app: 'hog.exe', cpu, mem: 0 }] });
  assert.strictEqual(r.evaluate(snapAt(0, 80)).length, 0);
  assert.strictEqual(r.evaluate(snapAt(5000, 80)).length, 0);
  assert.strictEqual(r.evaluate(snapAt(10000, 80)).length, 1);
  assert.strictEqual(r.evaluate(snapAt(12000, 80)).length, 0);
  r.evaluate(snapAt(14000, 5));
  r.evaluate(snapAt(80000, 5));
  r.evaluate(snapAt(81000, 90));
  assert.strictEqual(r.evaluate(snapAt(92000, 90)).length, 1);
});
test('memory rule adds up all processes of an app', () => {
  const r = new RuleEngine();
  r.setRules([{ id: 'm', enabled: true, target: '*', cond: 'mem', value: 1000, action: 'notify' }]);
  const procs = [1, 2, 3].map((i) => ({ pid: i, k: i + ':1', name: 'chrome.exe', app: 'chrome.exe', cpu: 0, mem: 400 * MB }));
  const a = r.evaluate({ t: 0, procs });
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].procs.length, 3);
});
test('start rule ignores apps already running when Lookout opens', () => {
  const r = new RuleEngine();
  r.setRules([{ id: 's', enabled: true, target: 'game.exe', cond: 'start', action: 'priority', level: 'high' }]);
  const g = { pid: 1, k: '1:1', name: 'game.exe', app: 'game.exe', cpu: 0, mem: 0 };
  assert.strictEqual(r.evaluate({ t: 0, procs: [g] }).length, 0);
  assert.strictEqual(r.evaluate({ t: 1, procs: [] }).length, 0);
  assert.strictEqual(r.evaluate({ t: 2, procs: [{ ...g, pid: 2, k: '2:2' }] }).length, 1);
});
test('"while" rule acts while the other app runs and undoes afterwards', () => {
  const r = new RuleEngine();
  r.setRules([{ id: 'w', enabled: true, target: 'discord.exe', cond: 'while', whileApp: 'obs64.exe', action: 'pause' }]);
  const d = { pid: 1, k: '1:1', name: 'Discord.exe', app: 'discord.exe', cpu: 0, mem: 0, priority: 'normal' };
  const o = { pid: 2, k: '2:2', name: 'obs64.exe', app: 'obs64.exe', cpu: 0, mem: 0 };
  assert.strictEqual(r.evaluate({ t: 0, procs: [d] }).length, 0);
  const on = r.evaluate({ t: 1, procs: [d, o] });
  assert.strictEqual(on.length, 1);
  assert.strictEqual(on[0].kind, 'pause');
  assert.strictEqual(r.evaluate({ t: 2, procs: [d, o] }).length, 0);
  const off = r.evaluate({ t: 3, procs: [d] });
  assert.strictEqual(off.length, 1);
  assert.strictEqual(off[0].kind, 'resume');
});
test('rules never act on Lookout itself', () => {
  const r = new RuleEngine();
  r.setRules([{ id: 'm', enabled: true, target: '*', cond: 'mem', value: 1, action: 'end' }]);
  assert.strictEqual(r.evaluate({ t: 0, procs: [{ pid: 1, k: '1', name: 'lookout.exe', app: 'lookout.exe', cpu: 0, mem: GB, self: true }] }).length, 0);
});
test('describeRule reads like a sentence', () => {
  assert.strictEqual(describeRule({ target: '*', cond: 'mem', value: 2048, action: 'notify' }), 'When any app uses more than 2 GB of memory, tell me.');
});

console.log('diagnose');
test('flags a CPU hog, a memory hog and a hung app', () => {
  const m = new Monitor({ capacity: 200 });
  let snap;
  for (let i = 0; i < 40; i++) {
    snap = m.ingest(sample(i * 2000, [proc(1, 'hog.exe', { cpu: 60 }), proc(2, 'big.exe', { mem: 6 * GB }), proc(3, 'stuck.exe', { hung: true })], { cpu: 70 }));
  }
  const f = diagnose({ monitor: m, snap, displayName: (k) => k, disks: [{ mount: 'C:', free: GB, total: 500 * GB }], uptime: 10 * 86400, paused: 0 });
  const ids = f.map((x) => x.id);
  assert.ok(ids.includes('cpu-app-hog.exe'), ids.join());
  assert.ok(ids.includes('mem-app-big.exe'), ids.join());
  assert.ok(ids.includes('hung-stuck.exe'), ids.join());
  assert.ok(ids.includes('disk-C:'), ids.join());
  assert.ok(ids.includes('uptime'), ids.join());
  assert.strictEqual(f[0].sev, 'bad');
});
test('says all is well when nothing is wrong', () => {
  const m = new Monitor({ capacity: 50 });
  let snap;
  for (let i = 0; i < 5; i++) snap = m.ingest(sample(i * 2000, [proc(1, 'calm.exe', { cpu: 1 })]));
  const f = diagnose({ monitor: m, snap, displayName: (k) => k, disks: [], uptime: 3600, paused: 0 });
  assert.strictEqual(f[0].id, 'ok');
});
test('fmtBytes', () => {
  assert.strictEqual(fmtBytes(0), '0 B');
  assert.strictEqual(fmtBytes(1536), '1.5 KB');
  assert.strictEqual(fmtBytes(5 * GB), '5.0 GB');
});

console.log('safety lists');
test('core Windows processes are blocked, shells are risky and never paused', () => {
  const s = known.makeSets('win32');
  assert.ok(s.blocked.has('csrss.exe') && s.blocked.has('lsass.exe'));
  assert.ok(s.risky.has('explorer.exe'));
  assert.ok(s.noPause.has('dwm.exe'));
  assert.ok(known.about('svchost.exe'));
});

console.log('linux parsing');
test('parseProcStat handles names with spaces and brackets', () => {
  const st = L.parseProcStat('1234 (Web Content (x)) S 1000 1234 1234 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 7 0 5000 100000 2500 18446744073709551615');
  assert.strictEqual(st.name, 'Web Content (x)');
  assert.strictEqual(st.ppid, 1000);
  assert.strictEqual(st.utime, 250);
  assert.strictEqual(st.stime, 50);
  assert.strictEqual(st.threads, 7);
  assert.strictEqual(st.starttime, 5000);
  assert.strictEqual(st.rss, 2500);
});
test('parseCpuLine, parseNetDev and parseMeminfo', () => {
  const c = L.parseCpuLine('cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 1 2 3');
  assert.deepStrictEqual(c, { idle: 800, total: 1000 });
  const n = L.parseNetDev('Inter-|\n face |\n    lo: 500 1 0 0 0 0 0 0 500 1 0 0 0 0 0 0\n  eth0: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0\n');
  assert.deepStrictEqual(n, { rx: 1000, tx: 2000 });
  const mi = L.parseMeminfo('MemTotal:       16000000 kB\nMemFree:  100 kB\nMemAvailable:    8000000 kB\n');
  assert.strictEqual(mi.total, 16000000 * 1024);
  assert.strictEqual(mi.available, 8000000 * 1024);
});
test('parseNetTable reads /proc/net/tcp and tcp6', () => {
  const t4 = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0\n';
  const r = L.parseNetTable(t4, 'tcp')[0];
  assert.deepStrictEqual([r.la, r.lp, r.state, r.inode], ['127.0.0.1', 3000, 'listen', '12345']);
  const t6 = 'header\n   0: 00000000000000000000000001000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 999 1\n';
  const r6 = L.parseNetTable(t6, 'tcp6')[0];
  assert.strictEqual(r6.la, '::1');
  assert.strictEqual(r6.lp, 8080);
  assert.strictEqual(r6.ra, '::');
});
test('parseWmctrl with titles containing spaces', () => {
  const w = L.parseWmctrl('0x03a00007  0 4242   10 20  800 600 host My Document - Editor\n0x01000001 -1 99 0 0 1920 30 host panel\n');
  assert.strictEqual(w.length, 2);
  assert.deepStrictEqual([w[0].id, w[0].pid, w[0].x, w[0].w, w[0].title], [0x03a00007, 4242, 10, 800, 'My Document - Editor']);
  assert.strictEqual(w[1].desk, -1);
});
test('shellQuote and niceToLevel', () => {
  assert.strictEqual(L.shellQuote(['/usr/bin/app', 'a b', "it's"]), "/usr/bin/app 'a b' 'it'\\''s'");
  assert.strictEqual(L.niceToLevel(19), 'idle');
  assert.strictEqual(L.niceToLevel(0), 'normal');
  assert.strictEqual(L.niceToLevel(-10), 'high');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
