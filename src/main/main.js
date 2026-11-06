'use strict';
// Lookout: a task manager that explains, remembers and automates.
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification, dialog, shell, screen, clipboard, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const dns = require('dns');
const { createPlatform } = require('./platform');
const { Monitor } = require('./monitor');
const { diagnose, fmtBytes } = require('./diagnose');
const { RuleEngine, DEFAULT_RULES, describeRule } = require('./rules');
const known = require('./known');

const argv = process.argv.slice(1);
const flag = (name) => argv.some((a) => a === '--' + name || a.startsWith('--' + name + '='));
const flagValue = (name) => { const a = argv.find((x) => x.startsWith('--' + name + '=')); return a ? a.split('=').slice(1).join('=') : null; };

// Developer test harness: renders off-screen with its own settings folder and runs a script against the UI.
const HARNESS = process.env.LOOKOUT_HARNESS ? path.resolve(process.env.LOOKOUT_HARNESS) : null;
if (HARNESS) app.setPath('userData', path.join(app.getPath('temp'), 'lookout-harness'));

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const DEBUG = !!process.env.LOOKOUT_DEBUG;
function dbg(...a) {
  if (!DEBUG) return;
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'debug.log'), new Date().toISOString() + ' ' + a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') + String.fromCharCode(10)); } catch (_) { /* ignore */ }
}

// ------------------------------------------------------------------ persistent state
const DEFAULT_SETTINGS = { interval: 2, closeToTray: true, notifications: true, theme: 'system', startWithOS: false, confirmEnd: true };
let store = null;
let storePath = '';
let safetyPath = '';
let saveTimer = null;

function loadStore() {
  storePath = path.join(app.getPath('userData'), 'lookout.json');
  safetyPath = path.join(app.getPath('userData'), 'safety.json');
  let s = {};
  try { s = JSON.parse(fs.readFileSync(storePath, 'utf8')); } catch (_) { /* first run */ }
  store = {
    settings: { ...DEFAULT_SETTINGS, ...(s.settings || {}) },
    rules: Array.isArray(s.rules) ? s.rules : DEFAULT_RULES.map((r) => ({ ...r })),
    recent: Array.isArray(s.recent) ? s.recent.slice(0, 30) : [],
    focusPrefs: { lower: true, boost: true, pause: [], ...(s.focusPrefs || {}) },
    describe: s.describe || {}
  };
}

function saveStore(now) {
  clearTimeout(saveTimer);
  const write = () => { try { fs.writeFileSync(storePath, JSON.stringify(store, null, 1)); } catch (e) { dbg('save failed', e.message); } };
  if (now) write(); else saveTimer = setTimeout(write, 800);
}

// Anything Lookout changed that must be undone even after a crash.
function saveSafety() {
  const data = {
    paused: [...paused.values()].map((p) => ({ pid: p.pid, start: p.start, name: p.name })),
    priorities: [...focus.changed.values()].filter((c) => c.prevPriority).map((c) => ({ pid: c.pid, start: c.start, priority: c.prevPriority }))
  };
  try { fs.writeFileSync(safetyPath, JSON.stringify(data)); } catch (_) { /* ignore */ }
}

// ------------------------------------------------------------------ globals
const platform = createPlatform();
const monitor = new Monitor({ capacity: 1800 });
const rules = new RuleEngine();
const sets = known.makeSets(process.platform);
let win = null;
let tray = null;
let snap = null;
let quitting = false;
let loopTimer = null;
let currentView = 'overview';
let lastConns = { t: 0, conns: [], admin: false };
let disks = [];
let names = new Map();
let namesDirty = false;
const icons = new Map();
const paused = new Map(); // k -> { pid, start, name, by }
const focus = { active: false, app: null, started: 0, opts: null, changed: new Map() };
const notifyThrottle = new Map();
const hostnames = new Map();
let selfPids = new Set();
let pendingRecovery = null;

// ------------------------------------------------------------------ helpers
const lc = (s) => String(s || '').toLowerCase();

function prettyName(p) {
  const d = store.describe[lc(p.exe)];
  const desc = d && d.desc;
  if (desc && desc.length > 1 && !/^(n\/a|-)$/i.test(desc)) return desc;
  if (d && d.product && d.product.length > 1 && !/operating system/i.test(d.product)) return d.product;
  const base = String(p.name || '').replace(/\.exe$/i, '');
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : '?';
}

function protection(p) {
  const n = lc(p.name);
  if (p.self) return 'self';
  if (sets.blocked.has(n) || p.pid === 4 || p.pid === 0 || p.kernel) return 'blocked';
  if (sets.risky.has(n) || (!p.user && process.platform === 'win32')) return 'risky';
  return '';
}

function canPause(p) { return !p.self && protection(p) !== 'blocked' && !sets.noPause.has(lc(p.name)); }

function findProc(pid, k) {
  if (!snap) return null;
  return snap.procs.find((p) => (k ? p.k === k : p.pid === pid)) || null;
}

function appProcs(appKey) { return snap ? snap.procs.filter((p) => p.app === appKey) : []; }

function send(channel, data) { if (win && !win.isDestroyed()) win.webContents.send(channel, data); }

function toast(text, extra) { send('toast', { text, ...(extra || {}) }); }

function notify(title, body, key) {
  if (HARNESS) { dbg('notify', title, body); return; }
  if (!store.settings.notifications || !Notification.isSupported()) return;
  if (key) {
    const last = notifyThrottle.get(key) || 0;
    if (Date.now() - last < 10 * 60000) return;
    notifyThrottle.set(key, Date.now());
  }
  const n = new Notification({ title, body, icon: path.join(__dirname, '..', 'assets', 'icon.png'), silent: false });
  n.on('click', () => showWindow());
  n.show();
}

function refreshSelfPids() {
  const pids = new Set([process.pid]);
  try { for (const m of app.getAppMetrics()) pids.add(m.pid); } catch (_) { /* ignore */ }
  if (platform.helperPid) pids.add(platform.helperPid);
  selfPids = pids;
  platform.excludePids([...pids]);
}

function refreshDisks() {
  const out = [];
  const tryDisk = (mount) => {
    try {
      const st = fs.statfsSync(mount);
      out.push({ mount: mount.replace(/\\$/, ''), free: st.bavail * st.bsize, total: st.blocks * st.bsize });
    } catch (_) { /* not a disk */ }
  };
  if (process.platform === 'win32') {
    for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') { if (fs.existsSync(l + ':\\')) tryDisk(l + ':\\'); }
  } else {
    tryDisk('/');
    if (fs.existsSync('/home')) { const h = fs.statSync('/home'); const r = fs.statSync('/'); if (h.dev !== r.dev) tryDisk('/home'); }
  }
  disks = out;
}

// ------------------------------------------------------------------ descriptions & icons
let describing = false;
async function describeNew() {
  if (describing || !snap || !platform.caps.describe) return;
  const todo = [...new Set(snap.procs.map((p) => lc(p.exe)).filter((e) => e && !store.describe[e]))].slice(0, 120);
  if (!todo.length) return;
  describing = true;
  try {
    const items = await platform.describe(todo);
    for (const it of items) store.describe[lc(it.path)] = { desc: it.desc, company: it.company, product: it.product, version: it.version };
    for (const e of todo) if (!store.describe[e]) store.describe[e] = { desc: '', company: '' };
    namesDirty = true;
    saveStore();
  } catch (e) { dbg('describe failed', e.message); }
  describing = false;
}

function rebuildNames() {
  if (!snap) return;
  const next = new Map();
  for (const p of snap.procs) if (!next.has(p.app)) next.set(p.app, prettyName(p));
  names = next;
  namesDirty = false;
  send('names', Object.fromEntries(names));
}

async function iconFor(exe) {
  const key = lc(exe);
  if (icons.has(key)) return icons.get(key);
  let url = null;
  try {
    const img = await app.getFileIcon(exe, { size: 'normal' });
    if (img && !img.isEmpty()) url = img.toDataURL();
  } catch (_) { /* no icon */ }
  icons.set(key, url);
  return url;
}

// ------------------------------------------------------------------ sampling loop
async function tick() {
  clearTimeout(loopTimer);
  const started = Date.now();
  try {
    const s = await platform.sample();
    // Pick up connection counters every tick when we can measure per-app speed.
    if (s.admin || currentView === 'network') {
      try {
        const c = await platform.connections();
        lastConns = { t: Date.now(), conns: c.conns, admin: c.admin };
        monitor.ingestConnections(c.conns, lastConns.t);
      } catch (e) { dbg('conns failed', e.message); }
    }
    for (const p of s.procs) if (selfPids.has(p.pid)) p.self = true;
    snap = monitor.ingest(s);
    // Forget paused entries for processes that ended.
    const live = new Set(snap.procs.map((p) => p.k));
    let pausedChanged = false;
    for (const k of [...paused.keys()]) if (!live.has(k)) { paused.delete(k); pausedChanged = true; }
    for (const p of snap.procs) p.paused = paused.has(p.k) || p.suspended;
    if (pausedChanged) { saveSafety(); send('paused', paused.size); }

    if (pendingRecovery) await recoverFromCrash();
    await runRules();
    if (focus.active) await maintainFocus();
    if (namesDirty || names.size === 0 || snap.n % 15 === 1) rebuildNames();
    if (snap.n % 5 === 1) describeNew();
    if (snap.n % 15 === 0) { refreshDisks(); refreshSelfPids(); }
    pushTick();
    updateTray();
  } catch (e) {
    dbg('tick failed', e.message);
  }
  const interval = Math.max(1, Number(store.settings.interval) || 2) * 1000;
  if (!quitting) loopTimer = setTimeout(tick, Math.max(200, interval - (Date.now() - started)));
}

function pushTick() {
  if (!win || win.isDestroyed() || (!HARNESS && (!win.isVisible() || win.isMinimized()))) return;
  const procs = snap.procs.map((p) => ({
    k: p.k, pid: p.pid, ppid: p.ppid, name: p.name, exe: p.exe, app: p.app, cpu: p.cpu, mem: p.mem, priv: p.priv, io: p.ioRate,
    netIn: p.netIn, netOut: p.netOut, threads: p.threads, handles: p.handles, priority: p.priority, user: p.user, paused: p.paused,
    hung: p.hung, windows: p.windows, title: p.title, start: p.start, prot: protection(p), noPause: !canPause(p),
    focus: focus.active && (p.app === focus.app || focus.changed.has(p.k))
  }));
  send('tick', {
    t: snap.t, cpu: snap.cpu, cpus: snap.cpus, memUsed: snap.memUsed, memTotal: snap.memTotal, memPct: snap.memPct,
    rx: snap.rxRate, tx: snap.txRate, io: snap.ioRate, admin: snap.admin, netPerApp: snap.netPerApp, procs,
    focus: focusSummary(), pausedCount: paused.size, uptime: os.uptime()
  });
}

function updateTray() {
  if (!tray) return;
  tray.setToolTip(`Lookout - CPU ${Math.round(snap.cpu)}%, memory ${Math.round(snap.memPct)}%` + (paused.size ? `, ${paused.size} paused` : '') + (focus.active ? ', focus mode on' : ''));
}

// ------------------------------------------------------------------ safety-checked actions
function guard(p, action) {
  if (!p) return { ok: false, reason: 'That process has already ended.' };
  const prot = protection(p);
  if (prot === 'self') return { ok: false, reason: "That's Lookout itself." };
  if (action === 'end' || action === 'endtree' || action === 'restart') {
    if (prot === 'blocked') return { ok: false, reason: `${p.name} is a core part of the system. Ending it would crash your computer, so Lookout won't.` };
    if (prot === 'risky') return { ok: true, confirm: true };
  }
  if (action === 'pause' && !canPause(p)) return { ok: false, reason: `Pausing ${p.name} would freeze your screen or desktop, so Lookout won't.` };
  if (action === 'priority' && prot === 'blocked') return { ok: false, reason: `${p.name} is a core part of the system.` };
  return { ok: true };
}

async function confirmRisky(list, verb) {
  const names = [...new Set(list.map((p) => p.name))].join(', ');
  const r = await dialog.showMessageBox(win, {
    type: 'warning', buttons: [verb, 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
    title: 'Lookout', message: `${verb} ${names}?`,
    detail: (list.some((p) => known.about(p.name)) ? known.about(list[0].name) + '\n\n' : '') + 'This is a system or service process. Ending it can close other apps, sign you out, or need a restart to fix.'
  });
  return r.response === 0;
}

async function captureForUndo(procs) {
  // Only the "root" processes are worth relaunching; the app starts its own helpers.
  const pids = new Set(procs.map((p) => p.pid));
  const roots = procs.filter((p) => !pids.has(p.ppid));
  const out = [];
  for (const p of roots.slice(0, 5)) {
    let d = null;
    try { d = await platform.details(p.pid); } catch (_) { /* ended */ }
    const exe = (d && d.exe) || p.exe;
    if (!exe && !(d && d.cmd)) continue;
    out.push({ cmd: (d && d.cmd) || platform.commandFor(exe), exe, cwd: (d && d.cwd) || (exe ? path.dirname(exe) : '') });
  }
  // Same command twice (e.g. two windows of one app) only needs relaunching once.
  const seen = new Set();
  return out.filter((x) => (seen.has(x.cmd) ? false : seen.add(x.cmd)));
}

function addRecent(procs, launches, how) {
  if (!launches.length) return null;
  const p = procs[0];
  const item = { id: 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), t: Date.now(), name: p.name, display: names.get(p.app) || prettyName(p),
    exe: launches[0].exe, launches, count: procs.length, how };
  store.recent.unshift(item);
  store.recent = store.recent.slice(0, 30);
  saveStore();
  send('recent', store.recent);
  return item;
}

async function endProcs(procs, { tree = false, how = 'you', silent = false } = {}) {
  procs = procs.filter(Boolean);
  if (!procs.length) return { ok: false, reason: 'Nothing to end.' };
  for (const p of procs) {
    const g = guard(p, tree ? 'endtree' : 'end');
    if (!g.ok) return g;
  }
  if (!silent && procs.some((p) => guard(p, 'end').confirm)) {
    if (!(await confirmRisky(procs, 'End'))) return { ok: false, cancelled: true };
  }
  const launches = await captureForUndo(procs);
  let killed = 0, failed = 0, reason = '';
  for (const p of procs) {
    const r = tree ? await platform.killTree(p.pid) : await platform.kill(p.pid);
    if (r && r.ok) killed += r.killed || 1; else { failed++; reason = (r && r.reason) || reason; }
    paused.delete(p.k);
  }
  saveSafety();
  if (!killed) return { ok: false, reason: reason || 'Windows refused.' };
  const item = addRecent(procs, launches, how);
  monitor.log('kill', { pid: procs[0].pid, name: procs[0].name, text: `${how === 'you' ? 'You ended' : 'A rule ended'} ${names.get(procs[0].app) || procs[0].name}` + (killed > 1 ? ` (${killed} processes)` : '') });
  return { ok: true, killed, failed, undo: item ? item.id : null, reason: failed ? reason : undefined };
}

async function relaunch(id) {
  const item = store.recent.find((r) => r.id === id);
  if (!item) return { ok: false, reason: 'Nothing to relaunch.' };
  let ok = 0, reason = '';
  for (const l of item.launches) {
    const r = await platform.launch(l.cmd, l.cwd);
    if (r && r.ok) ok++; else reason = (r && r.reason) || reason;
  }
  if (ok) {
    store.recent = store.recent.filter((r) => r.id !== id);
    saveStore();
    send('recent', store.recent);
    monitor.log('relaunch', { name: item.name, text: `Relaunched ${item.display}` });
  }
  return ok ? { ok: true } : { ok: false, reason: reason || "Couldn't start it again." };
}

async function pauseProcs(procs, by = 'you') {
  let ok = 0, reason = '';
  for (const p of procs) {
    const g = guard(p, 'pause');
    if (!g.ok) { reason = g.reason; continue; }
    const r = await platform.suspend(p.pid);
    if (r && r.ok) { ok++; paused.set(p.k, { pid: p.pid, start: p.start, name: p.name, by }); } else reason = (r && r.reason) || reason;
  }
  saveSafety();
  send('paused', paused.size);
  if (ok) monitor.log('pause', { pid: procs[0].pid, name: procs[0].name, text: `Paused ${names.get(procs[0].app) || procs[0].name}` + (by !== 'you' ? ` (${by})` : '') });
  return ok ? { ok: true, count: ok } : { ok: false, reason: reason || "Couldn't pause it." };
}

async function resumeProcs(procs, by = 'you') {
  let ok = 0, reason = '';
  for (const p of procs) {
    const r = await platform.resume(p.pid);
    if (r && r.ok) ok++; else reason = (r && r.reason) || reason;
    paused.delete(p.k);
  }
  saveSafety();
  send('paused', paused.size);
  if (ok) monitor.log('resume', { pid: procs[0].pid, name: procs[0].name, text: `Resumed ${names.get(procs[0].app) || procs[0].name}` + (by !== 'you' ? ` (${by})` : '') });
  return ok ? { ok: true } : { ok: false, reason: reason || "Couldn't resume it." };
}

async function resumeAll() {
  const list = [...paused.entries()].map(([k, v]) => ({ k, ...v }));
  for (const p of list) await platform.resume(p.pid);
  await platform.resumeAll();
  paused.clear();
  saveSafety();
  send('paused', 0);
  if (list.length) monitor.log('resume', { text: `Resumed ${list.length} paused ${list.length === 1 ? 'process' : 'processes'}` });
  return { ok: true, count: list.length };
}

async function setPriorityProcs(procs, level, by = 'you') {
  let ok = 0, reason = '';
  for (const p of procs) {
    const g = guard(p, 'priority');
    if (!g.ok) { reason = g.reason; continue; }
    const r = await platform.setPriority(p.pid, level);
    if (r && r.ok) ok++; else reason = (r && r.reason) || reason;
  }
  const lv = { idle: 'Low', below: 'Below normal', normal: 'Normal', above: 'Above normal', high: 'High' }[level] || level;
  if (ok) monitor.log('priority', { pid: procs[0].pid, name: procs[0].name, text: `Set ${names.get(procs[0].app) || procs[0].name} to ${lv} priority` + (by !== 'you' ? ` (${by})` : '') });
  return ok ? { ok: true } : { ok: false, reason: reason || "Couldn't change its priority." };
}

async function restartProcs(procs) {
  const r = await endProcs(procs, { how: 'you' });
  if (!r.ok) return r;
  await new Promise((res) => setTimeout(res, 1500));
  if (r.undo) return relaunch(r.undo);
  return { ok: false, reason: "It ended, but Lookout couldn't find how to start it again." };
}

// ------------------------------------------------------------------ rules
async function runRules() {
  rules.setRules(store.rules);
  const actions = rules.evaluate(snap);
  for (const a of actions) {
    const display = names.get(a.app) || a.name;
    const procs = a.procs.filter((p) => !p.self);
    const prot = procs.map(protection);
    const r = a.rule;
    let what = '';
    try {
      if (a.kind === 'notify') {
        const cond = r.cond === 'cpu' ? `is using ${Math.round(procs.reduce((s, p) => s + p.cpu, 0))}% CPU`
          : r.cond === 'mem' ? `is using ${fmtBytes(procs.reduce((s, p) => s + Math.max(0, p.mem), 0))} of memory`
            : r.cond === 'hung' ? 'is not responding' : r.cond === 'start' ? 'just started' : 'is running';
        notify(`${display} ${cond}`, describeRule(r), r.id + '|' + a.app);
        what = `Told you: ${display} ${cond}`;
      } else if (a.kind === 'priority') {
        await setPriorityProcs(procs, a.level || 'normal', 'rule');
        what = `Set ${display} to ${a.level} priority`;
      } else if (a.kind === 'restorePriority') {
        for (const p of procs) if (p.prevPriority) await platform.setPriority(p.pid, p.prevPriority);
        what = `Put ${display} back to its usual priority`;
      } else if (a.kind === 'pause') {
        await pauseProcs(procs.filter((p, i) => prot[i] === ''), 'rule');
        what = `Paused ${display}`;
      } else if (a.kind === 'resume') {
        await resumeProcs(procs, 'rule');
        what = `Resumed ${display}`;
      } else if (a.kind === 'end') {
        const safe = procs.filter((p, i) => prot[i] === '');
        if (safe.length) {
          const res = await endProcs(safe, { how: 'rule', silent: true });
          what = res.ok ? `Ended ${display}` : `Tried to end ${display}: ${res.reason}`;
          if (res.ok) notify(`Lookout ended ${display}`, describeRule(r) + ' You can start it again from Recently ended.', null);
        }
      }
    } catch (e) { what = 'Rule failed: ' + e.message; }
    if (what) monitor.log('rule', { name: a.name, text: what, rule: r.id });
  }
}

// ------------------------------------------------------------------ focus mode
function focusSummary() {
  if (!focus.active) return { active: false };
  const changed = [...focus.changed.values()];
  return { active: true, app: focus.app, name: names.get(focus.app) || focus.app, started: focus.started,
    lowered: changed.filter((c) => c.lowered).length, paused: changed.filter((c) => c.paused).length, boosted: changed.filter((c) => c.boosted).length,
    items: changed.slice(0, 60).map((c) => ({ name: c.name, lowered: !!c.lowered, paused: !!c.paused, boosted: !!c.boosted })) };
}

async function startFocus(opts) {
  if (focus.active) await stopFocus();
  focus.active = true;
  focus.app = opts.app;
  focus.started = Date.now();
  focus.opts = { lower: !!opts.lower, boost: !!opts.boost, pause: opts.pause || [] };
  focus.changed.clear();
  store.focusPrefs = { lower: focus.opts.lower, boost: focus.opts.boost, pause: focus.opts.pause };
  saveStore();
  if (focus.opts.boost) {
    for (const p of appProcs(focus.app)) {
      if (protection(p)) continue;
      const r = await platform.setPriority(p.pid, 'high');
      if (r && r.ok) focus.changed.set(p.k, { pid: p.pid, start: p.start, name: p.name, prevPriority: p.priority || 'normal', boosted: true });
    }
  }
  for (const appKey of focus.opts.pause) {
    if (appKey === focus.app) continue;
    const procs = appProcs(appKey).filter((p) => canPause(p) && protection(p) === '');
    for (const p of procs) {
      const r = await platform.suspend(p.pid);
      if (r && r.ok) {
        paused.set(p.k, { pid: p.pid, start: p.start, name: p.name, by: 'focus mode' });
        focus.changed.set(p.k, { pid: p.pid, start: p.start, name: p.name, paused: true });
      }
    }
  }
  saveSafety();
  await maintainFocus();
  monitor.log('focus', { text: `Focus mode on for ${names.get(focus.app) || focus.app}` });
  send('focus', focusSummary());
  return focusSummary();
}

// Keeps background hogs at low priority while focus mode is on (including ones that start later).
async function maintainFocus() {
  if (!focus.opts.lower) return;
  let changed = false;
  for (const p of snap.procs) {
    if (p.app === focus.app || focus.changed.has(p.k) || !p.user || protection(p)) continue;
    if (p.priority === 'idle') continue;
    const s = monitor.procSeries(p.k, 20).cpu;
    const avg = s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0;
    if (avg < 3) continue;
    const r = await platform.setPriority(p.pid, 'idle');
    if (r && r.ok) { focus.changed.set(p.k, { pid: p.pid, start: p.start, name: p.name, prevPriority: p.priority || 'normal', lowered: true }); changed = true; }
  }
  if (changed) { saveSafety(); send('focus', focusSummary()); }
}

async function stopFocus() {
  if (!focus.active) return { active: false };
  const live = new Map((snap ? snap.procs : []).map((p) => [p.k, p]));
  for (const [k, c] of focus.changed) {
    if (!live.has(k)) continue;
    if (c.prevPriority) await platform.setPriority(c.pid, c.prevPriority);
    if (c.paused && paused.get(k) && paused.get(k).by === 'focus mode') { await platform.resume(c.pid); paused.delete(k); }
  }
  monitor.log('focus', { text: `Focus mode off (${focus.changed.size} changes undone)` });
  focus.active = false;
  focus.app = null;
  focus.changed.clear();
  saveSafety();
  send('focus', focusSummary());
  send('paused', paused.size);
  return { active: false };
}

// After a crash, resume anything we left paused and restore priorities we changed.
async function recoverFromCrash() {
  const rec = pendingRecovery;
  pendingRecovery = null;
  const live = new Map(snap.procs.map((p) => [p.pid, p]));
  let n = 0;
  for (const p of rec.paused || []) {
    const cur = live.get(p.pid);
    if (cur && Math.abs((cur.start || 0) - (p.start || 0)) < 2000) { await platform.resume(p.pid); n++; }
  }
  for (const p of rec.priorities || []) {
    const cur = live.get(p.pid);
    if (cur && Math.abs((cur.start || 0) - (p.start || 0)) < 2000) { await platform.setPriority(p.pid, p.priority); n++; }
  }
  saveSafety();
  if (n) monitor.log('recover', { text: `Undid ${n} leftover change${n === 1 ? '' : 's'} from last time Lookout closed unexpectedly` });
}

// ------------------------------------------------------------------ network
function reverseLookup(ip) {
  if (!ip || hostnames.has(ip) || /^(0\.0\.0\.0|::|127\.|::1$|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fe80)/.test(ip)) return;
  hostnames.set(ip, null);
  dns.reverse(ip, (err, list) => { hostnames.set(ip, !err && list && list.length ? list[0] : ''); });
}

function isListen(c) { return c.proto.startsWith('tcp') && (c.state === 'listen' || ((c.ra === '0.0.0.0' || c.ra === '::') && c.rp === 0)); }

async function networkView() {
  let c = lastConns;
  if (Date.now() - c.t > 2500) {
    try { const r = await platform.connections(); c = lastConns = { t: Date.now(), conns: r.conns, admin: r.admin }; monitor.ingestConnections(r.conns, c.t); } catch (e) { return { ok: false, reason: e.message }; }
  }
  const byPid = new Map((snap ? snap.procs : []).map((p) => [p.pid, p]));
  const apps = new Map();
  for (const x of c.conns) {
    const p = byPid.get(x.pid);
    const key = p ? p.app : (x.pid ? 'pid ' + x.pid : 'system');
    let a = apps.get(key);
    if (!a) {
      a = { app: key, name: p ? (names.get(p.app) || prettyName(p)) : key, exe: p ? p.exe : '', pids: new Set(), established: 0, listening: 0, udp: 0, in: 0, out: 0, conns: [] };
      apps.set(key, a);
    }
    a.pids.add(x.pid);
    const listen = isListen(x);
    if (x.proto.startsWith('udp')) a.udp++; else if (listen) a.listening++; else if (x.state === 'established') a.established++;
    if (!listen && x.ra && x.rp) reverseLookup(x.ra);
    if (a.conns.length < 200) a.conns.push({ proto: x.proto, la: x.la, lp: x.lp, ra: x.ra, rp: x.rp, state: listen ? 'listening' : x.state, host: hostnames.get(x.ra) || '', pid: x.pid });
  }
  for (const a of apps.values()) {
    for (const pid of a.pids) { const n = monitor.netByPid.get(pid); if (n && snap.netPerApp) { a.in += n.in; a.out += n.out; } }
    a.pids = [...a.pids];
  }
  return { ok: true, admin: c.admin, perApp: !!(snap && snap.netPerApp), rx: snap ? snap.rxRate : 0, tx: snap ? snap.txRate : 0, apps: [...apps.values()] };
}

// ------------------------------------------------------------------ window & tray
function themeBg() {
  const dark = store.settings.theme === 'dark' || (store.settings.theme === 'system' && nativeTheme.shouldUseDarkColors);
  return dark ? '#0f1216' : '#f5f6f8';
}

function createWindow(show) {
  win = new BrowserWindow({
    width: 1240, height: 800, minWidth: 940, minHeight: 600, show: false, backgroundColor: themeBg(), autoHideMenuBar: true,
    title: 'Lookout', icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: !!HARNESS }
  });
  if (HARNESS) {
    show = false;
    win.webContents.once('did-finish-load', () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const capture = async (file) => { await wait(150); const img = await win.webContents.capturePage(); fs.writeFileSync(file, img.toPNG()); };
      const exec = (js) => win.webContents.executeJavaScript(js, true);
      require(HARNESS)({ app, win, wait, capture, exec, platform, getSnap: () => snap, quit: () => { quitting = true; app.quit(); } })
        .catch((e) => { dbg('harness failed', e.stack); quitting = true; app.quit(); });
    });
  }
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { query: { view: flagValue('view') || '' } });
  win.once('ready-to-show', () => { if (show) win.show(); });
  win.on('show', () => { if (snap) pushTick(); });
  win.on('restore', () => { if (snap) pushTick(); });
  win.on('close', (e) => {
    if (!quitting && store.settings.closeToTray) { e.preventDefault(); win.hide(); }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  if (flag('dev')) win.webContents.openDevTools({ mode: 'detach' });
}

function showWindow(view) {
  if (!win || win.isDestroyed()) createWindow(true);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (view) send('navigate', view);
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('Lookout');
  const menu = () => Menu.buildFromTemplate([
    { label: 'Open Lookout', click: () => showWindow() },
    { label: 'Why is my PC slow?', click: () => showWindow('overview') },
    { type: 'separator' },
    { label: focus.active ? 'Turn off focus mode' : 'Focus mode…', click: () => (focus.active ? stopFocus() : showWindow('focus')) },
    { label: `Resume everything paused (${paused.size})`, enabled: paused.size > 0, click: () => resumeAll() },
    { type: 'separator' },
    { label: 'Quit Lookout', click: () => { quitting = true; app.quit(); } }
  ]);
  tray.on('click', () => showWindow());
  tray.on('right-click', () => tray.popUpContextMenu(menu()));
  if (process.platform !== 'win32') tray.setContextMenu(menu());
}

function restartAsAdmin() {
  const exe = process.execPath;
  const args = app.isPackaged ? [] : [app.getAppPath()];
  if (process.platform === 'win32') {
    const quoted = args.map((a) => "'" + a.replace(/'/g, "''") + "'").join(',');
    const ps = `Start-Process -FilePath '${exe.replace(/'/g, "''")}'` + (quoted ? ` -ArgumentList ${quoted}` : '') + ' -Verb RunAs';
    const { spawn } = require('child_process');
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true });
    child.on('exit', (code) => {
      if (code === 0) { quitting = true; app.releaseSingleInstanceLock(); setTimeout(() => app.quit(), 300); } else toast('Lookout is still running without administrator rights.');
    });
    return { ok: true };
  }
  return { ok: false, reason: 'On Linux, start Lookout with sudo (for example: sudo -E lookout --no-sandbox).' };
}

// ------------------------------------------------------------------ IPC
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, data) => {
    try { return await fn(data || {}); } catch (e) { dbg(channel, 'failed', e.stack || e.message); return { ok: false, reason: e.message }; }
  });
}

function registerIpc() {
  handle('init', () => ({
    platform: process.platform, caps: platform.caps, settings: store.settings, rules: store.rules, recent: store.recent,
    focus: focusSummary(), focusPrefs: store.focusPrefs, names: Object.fromEntries(names), version: app.getVersion(),
    view: flagValue('view') || ''
  }));

  handle('view', ({ view }) => { currentView = view; return { ok: true }; });

  handle('proc:action', async ({ pid, k, action, level }) => {
    const p = findProc(pid, k);
    if (!p && action !== 'relaunch') return { ok: false, reason: 'That process has already ended.' };
    switch (action) {
      case 'end': return endProcs([p]);
      case 'endtree': return endProcs([p], { tree: true });
      case 'restart': return restartProcs([p]);
      case 'pause': return pauseProcs([p]);
      case 'resume': return resumeProcs([p]);
      case 'priority': return setPriorityProcs([p], level);
      case 'open': if (p.exe) shell.showItemInFolder(p.exe); return { ok: !!p.exe, reason: p.exe ? undefined : 'Lookout can\'t see where this program lives (it may belong to the system).' };
      case 'search': shell.openExternal('https://www.bing.com/search?q=' + encodeURIComponent(`"${p.name}" process`)); return { ok: true };
      case 'copy': {
        let d = null;
        try { d = await platform.details(p.pid); } catch (_) { /* ignore */ }
        clipboard.writeText([`${p.name} (PID ${p.pid})`, p.exe, d && d.cmd].filter(Boolean).join('\n'));
        return { ok: true };
      }
    }
    return { ok: false, reason: 'Unknown action.' };
  });

  handle('app:action', async ({ app: key, action, level }) => {
    const procs = appProcs(key).filter((p) => !p.self);
    if (!procs.length) return { ok: false, reason: 'That app has already closed.' };
    switch (action) {
      case 'end': return endProcs(procs);
      case 'restart': return restartProcs(procs);
      case 'pause': return pauseProcs(procs.filter(canPause));
      case 'resume': return resumeProcs(procs);
      case 'priority': return setPriorityProcs(procs, level);
      case 'lower': return setPriorityProcs(procs, 'idle');
      case 'open': { const p = procs.find((x) => x.exe); if (p) shell.showItemInFolder(p.exe); return { ok: !!p }; }
      case 'search': shell.openExternal('https://www.bing.com/search?q=' + encodeURIComponent(`"${procs[0].name}" process`)); return { ok: true };
    }
    return { ok: false, reason: 'Unknown action.' };
  });

  handle('proc:details', async ({ pid, k }) => {
    const p = findProc(pid, k);
    if (!p) return { ok: false, reason: 'That process has ended.' };
    let d = {};
    try { d = await platform.details(p.pid); } catch (_) { /* ignore */ }
    const info = store.describe[lc(p.exe)] || {};
    const parent = findProc(p.ppid);
    const children = snap.procs.filter((x) => x.ppid === p.pid && x.pid !== p.pid).map((x) => ({ pid: x.pid, k: x.k, name: x.name }));
    let conns = 0;
    for (const c of lastConns.conns) if (c.pid === p.pid) conns++;
    return {
      ok: true, pid: p.pid, k: p.k, name: p.name, display: names.get(p.app) || prettyName(p), exe: d.exe || p.exe, cmd: d.cmd || null, cwd: d.cwd || null,
      about: known.about(p.name), desc: info.desc || '', company: info.company || '', version: info.version || '',
      parent: parent ? { pid: parent.pid, k: parent.k, name: parent.name } : (p.ppid ? { pid: p.ppid, name: '(ended)' } : null),
      children, conns: lastConns.t ? conns : null, series: monitor.procSeries(p.k, 600), prot: protection(p), noPause: !canPause(p)
    };
  });

  handle('app:details', async ({ app: key }) => {
    const procs = appProcs(key);
    if (!procs.length) return { ok: false, reason: 'That app has closed.' };
    const p = procs.find((x) => x.exe) || procs[0];
    const info = store.describe[lc(p.exe)] || {};
    return { ok: true, app: key, display: names.get(key) || prettyName(p), name: p.name, exe: p.exe, about: known.about(p.name), desc: info.desc || '', company: info.company || '',
      version: info.version || '', count: procs.length, series: monitor.appSeries(key, 600), prot: procs.some((x) => protection(x) === 'blocked') ? 'blocked' : procs.some((x) => protection(x)) ? 'risky' : '' };
  });

  handle('icons', async ({ paths }) => {
    const out = {};
    for (const p of (paths || []).slice(0, 80)) out[lc(p)] = await iconFor(p);
    return out;
  });

  handle('windows:list', async ({ invisible }) => {
    const r = await platform.windows(!!invisible);
    const byPid = new Map((snap ? snap.procs : []).map((p) => [p.pid, p]));
    for (const w of r.windows) {
      const p = byPid.get(w.pid);
      w.app = p ? p.app : lc(path.basename(w.exe || ''));
      w.appName = p ? (names.get(p.app) || prettyName(p)) : path.basename(w.exe || '') || '?';
      w.k = p ? p.k : null;
    }
    return r;
  });

  handle('win:action', async ({ id, action, arg }) => {
    const r = await platform.winAction(id, action, arg);
    if (r && r.ok && ['hide', 'show', 'bringback'].includes(action)) monitor.log('window', { text: { hide: 'Hid', show: 'Showed', bringback: 'Brought back' }[action] + ' a window' });
    return r;
  });

  handle('windows:unhideAll', () => platform.unhideAll());
  handle('net:list', () => networkView());

  handle('find:file', async ({ path: target }) => {
    if (!target) return { ok: false, reason: 'Pick a file or folder first.' };
    const r = await platform.whoFile(target);
    if (!r.ok) return r;
    const byPid = new Map((snap ? snap.procs : []).map((p) => [p.pid, p]));
    r.procs = r.procs.map((x) => {
      const p = byPid.get(x.pid);
      return { ...x, k: p ? p.k : null, name: p ? p.name : x.app, display: p ? (names.get(p.app) || prettyName(p)) : x.app, exe: p ? p.exe : '', prot: p ? protection(p) : 'risky' };
    });
    return r;
  });

  handle('find:port', async ({ port }) => {
    port = parseInt(port, 10);
    if (!(port > 0 && port < 65536)) return { ok: false, reason: 'Ports are numbers from 1 to 65535.' };
    const c = await platform.connections();
    lastConns = { t: Date.now(), conns: c.conns, admin: c.admin };
    const byPid = new Map((snap ? snap.procs : []).map((p) => [p.pid, p]));
    const hits = c.conns.filter((x) => x.lp === port || x.rp === port).map((x) => {
      const p = byPid.get(x.pid);
      return { ...x, state: isListen(x) ? 'listening' : x.state, local: x.lp === port, k: p ? p.k : null, name: p ? p.name : (x.pid ? 'PID ' + x.pid : 'System'),
        display: p ? (names.get(p.app) || prettyName(p)) : '', exe: p ? p.exe : '', prot: p ? protection(p) : 'blocked' };
    });
    return { ok: true, port, hits, admin: c.admin };
  });

  handle('dialog:pick', async ({ folder }) => {
    const r = await dialog.showOpenDialog(win, { properties: [folder ? 'openDirectory' : 'openFile'] });
    return r.canceled ? null : r.filePaths[0];
  });

  handle('history:timeline', ({ metric, minutes, only }) => monitor.timeline(metric || 'cpu', (minutes || 15) * 60, { only: only && only.length ? only : null }));
  handle('history:at', ({ t, metric }) => monitor.at(t, metric || 'cpu'));
  handle('history:events', ({ from, to }) => monitor.eventsBetween(from || 0, to || Date.now()).slice(-600));

  handle('diagnose', () => {
    if (!snap) return { findings: [], ready: false };
    return {
      ready: true,
      findings: diagnose({ monitor, snap, displayName: (k) => names.get(k), disks, uptime: os.uptime(), paused: paused.size }),
      sys: { cpu: snap.cpu, memPct: snap.memPct, memUsed: snap.memUsed, memTotal: snap.memTotal, rx: snap.rxRate, tx: snap.txRate, io: snap.ioRate,
        procs: snap.procs.length, threads: snap.procs.reduce((s, p) => s + (p.threads || 0), 0), handles: snap.procs.reduce((s, p) => s + (p.handles || 0), 0),
        uptime: os.uptime(), cpus: snap.cpus, cpuModel: (os.cpus()[0] || {}).model || '', disks },
      spark: { cpu: monitor.timeline('cpu', 300, { top: 0, maxPoints: 150 }), mem: monitor.timeline('mem', 300, { top: 0, maxPoints: 150 }),
        net: monitor.timeline('net', 300, { top: 0, maxPoints: 150 }), io: monitor.timeline('io', 300, { top: 0, maxPoints: 150 }) }
    };
  });

  handle('rules:set', ({ rules: list }) => {
    store.rules = (list || []).map((r) => ({ id: r.id || 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), enabled: !!r.enabled, target: String(r.target || '*'),
      cond: r.cond, value: Number(r.value) || 0, seconds: Number(r.seconds) || 0, whileApp: r.whileApp || '', action: r.action, level: r.level || 'normal' }));
    saveStore();
    send('rules', store.rules);
    return { ok: true, rules: store.rules };
  });
  handle('rules:describe', ({ rule }) => ({ text: describeRule(rule) }));

  handle('focus:start', (opts) => startFocus(opts));
  handle('focus:stop', () => stopFocus());
  handle('focus:candidates', () => {
    const apps = new Map();
    const fg = snap ? snap.procs : [];
    for (const p of fg) {
      if (!p.user || p.self || protection(p)) continue;
      const a = apps.get(p.app) || { app: p.app, name: names.get(p.app) || prettyName(p), exe: p.exe, windows: 0, cpu: 0, mem: 0, canPause: true };
      a.windows += p.windows || 0; a.mem += Math.max(0, p.mem || 0);
      a.canPause = a.canPause && canPause(p);
      apps.set(p.app, a);
    }
    const avg = monitor.appAverages('cpu', 30);
    for (const a of apps.values()) a.cpu = avg.get(a.app) || 0;
    return [...apps.values()].sort((a, b) => b.windows - a.windows || b.cpu - a.cpu);
  });

  handle('recent:relaunch', ({ id }) => relaunch(id));
  handle('recent:clear', () => { store.recent = []; saveStore(); send('recent', store.recent); return { ok: true }; });
  handle('resumeAll', () => resumeAll());

  handle('settings:set', (patch) => {
    store.settings = { ...store.settings, ...patch };
    if ('startWithOS' in patch && process.platform === 'win32') {
      app.setLoginItemSettings({ openAtLogin: !!patch.startWithOS, args: ['--hidden'] });
    }
    if ('theme' in patch) nativeTheme.themeSource = store.settings.theme === 'system' ? 'system' : store.settings.theme;
    saveStore();
    send('settings', store.settings);
    return { ok: true, settings: store.settings };
  });

  handle('admin:restart', () => restartAsAdmin());
  handle('open:external', ({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { ok: true }; });
  handle('copy', ({ text }) => { clipboard.writeText(String(text || '')); return { ok: true }; });
}

// ------------------------------------------------------------------ lifecycle
app.on('second-instance', (_e, args) => {
  if (args.includes('--quit')) { quitting = true; app.quit(); return; }
  showWindow();
});

app.whenReady().then(async () => {
  if (flag('quit')) { app.quit(); return; }
  if (process.platform === 'win32') app.setAppUserModelId('app.lookout.taskmanager');
  loadStore();
  nativeTheme.themeSource = store.settings.theme === 'system' ? 'system' : store.settings.theme;
  try { pendingRecovery = JSON.parse(fs.readFileSync(safetyPath, 'utf8')); } catch (_) { pendingRecovery = null; }
  if (pendingRecovery && !(pendingRecovery.paused || []).length && !(pendingRecovery.priorities || []).length) pendingRecovery = null;
  registerIpc();
  createWindow(!flag('hidden'));
  createTray();
  const ok = await platform.init(app.getPath('userData'));
  dbg('platform ready', ok);
  if (platform.setScreens) {
    const upd = () => platform.setScreens(screen.getAllDisplays().map((d) => d.bounds));
    upd();
    screen.on('display-added', upd); screen.on('display-removed', upd); screen.on('display-metrics-changed', upd);
  }
  refreshSelfPids();
  refreshDisks();
  monitor.onEvent = (e) => send('event', e);
  tick();
});

let cleanedUp = false;
app.on('before-quit', (e) => {
  quitting = true;
  if (cleanedUp || !store) return;
  e.preventDefault();
  cleanedUp = true;
  clearTimeout(loopTimer);
  (async () => {
    try { if (focus.active) await stopFocus(); } catch (_) { /* ignore */ }
    try { await resumeAll(); } catch (_) { /* ignore */ }
    try { await platform.unhideAll(); } catch (_) { /* ignore */ }
    saveSafety();
    saveStore(true);
    platform.quit();
    setTimeout(() => app.quit(), 300);
  })();
});

app.on('window-all-closed', () => { if (quitting) app.quit(); });
