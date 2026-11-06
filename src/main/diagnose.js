'use strict';
// "Why is my PC slow?": turns live numbers and recent history into a short list of plain-English findings.

function fmtBytes(b) {
  if (!(b > 0)) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return (b >= 100 || i === 0 ? Math.round(b) : b.toFixed(1)) + ' ' + u[i];
}

function fmtDuration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'less than a minute';
  if (m < 60) return m + (m === 1 ? ' minute' : ' minutes');
  const h = Math.floor(m / 60), r = m % 60;
  return h + (h === 1 ? ' hour' : ' hours') + (r ? ' ' + r + ' min' : '');
}

const SEV = { bad: 0, warn: 1, info: 2, good: 3 };

// ctx: { monitor, snap, displayName(appKey) -> string, disks: [{mount, free, total}], uptime (s), paused: n, protectedApp(appKey) -> bool, focus }
function diagnose(ctx) {
  const { monitor, snap } = ctx;
  const out = [];
  if (!snap) return out;
  const name = (key) => ctx.displayName(key) || key;
  const cpu1 = monitor.sysAverage('cpu', 60);
  const appCpu = monitor.appAverages('cpu', 60);
  const appIo = monitor.appAverages('io', 30);
  const appNet = monitor.appAverages('net', 30);
  const memPct = snap.memPct;
  const byApp = new Map();
  for (const p of snap.procs) {
    const a = byApp.get(p.app) || { mem: 0, count: 0, pids: [], hung: false, windows: 0, user: false };
    a.mem += Math.max(0, p.mem || 0); a.count++; a.pids.push(p.pid); a.hung = a.hung || p.hung; a.windows += p.windows || 0; a.user = a.user || p.user;
    byApp.set(p.app, a);
  }
  const skip = (key) => key === 'system idle process' || key === 'idle';

  // CPU
  const hogs = [...appCpu].filter(([k, v]) => !skip(k) && v >= 15).sort((a, b) => b[1] - a[1]);
  if (cpu1 >= 80) {
    out.push({ id: 'cpu-high', sev: 'bad', title: `Your processor is very busy (${Math.round(cpu1)}% for the last minute)`,
      detail: hogs.length ? 'Biggest users: ' + hogs.slice(0, 3).map(([k, v]) => `${name(k)} ${Math.round(v)}%`).join(', ') + '.' : 'No single app stands out, so it\'s the sum of many small ones.',
      app: hogs.length ? hogs[0][0] : null, actions: hogs.length ? ['lower', 'pause', 'end'] : [] });
  }
  for (const [k, v] of hogs.slice(0, 3)) {
    const dur = monitor.appAboveFor(k, 'cpu', 10);
    if (v < 25 && dur < 5 * 60000) continue;
    const bg = !(byApp.get(k) || {}).windows;
    out.push({ id: 'cpu-app-' + k, sev: v >= 40 ? 'bad' : 'warn',
      title: `${name(k)} is using ${Math.round(v)}% of your CPU`,
      detail: (dur >= 60000 ? `It has been busy for ${fmtDuration(dur)}. ` : '') + (bg ? 'It has no window, so it\'s working in the background.' : ''),
      app: k, actions: ['lower', 'pause', 'end'] });
  }

  // Memory
  const memHogs = [...byApp].filter(([k]) => !skip(k)).sort((a, b) => b[1].mem - a[1].mem);
  if (memPct >= 85) {
    out.push({ id: 'mem-high', sev: memPct >= 93 ? 'bad' : 'warn', title: `Memory is almost full (${Math.round(memPct)}% used)`,
      detail: `${fmtBytes(snap.memTotal - snap.memUsed)} free of ${fmtBytes(snap.memTotal)}. Windows starts using the much slower disk when memory runs out. Biggest: ` +
        memHogs.slice(0, 3).map(([k, a]) => `${name(k)} ${fmtBytes(a.mem)}`).join(', ') + '.',
      app: memHogs.length ? memHogs[0][0] : null, actions: ['end'] });
  }
  for (const [k, a] of memHogs.slice(0, 3)) {
    const share = snap.memTotal ? a.mem / snap.memTotal : 0;
    if (share < 0.2 && a.mem < 3 * 2 ** 30) continue;
    out.push({ id: 'mem-app-' + k, sev: share >= 0.35 ? 'bad' : 'warn', title: `${name(k)} is using ${fmtBytes(a.mem)} of memory`,
      detail: `That's ${Math.round(share * 100)}% of your RAM` + (a.count > 1 ? `, spread over ${a.count} processes.` : '.') + ' Closing tabs or windows in it frees memory.',
      app: k, actions: ['end'] });
  }

  // Leaks
  for (const l of monitor.leaks().slice(0, 3)) {
    out.push({ id: 'leak-' + l.k, sev: 'warn', title: `${name(l.name.toLowerCase())}'s memory keeps growing`,
      detail: `Up ${fmtBytes(l.growth)} in ${fmtDuration(l.minutes * 60000)} (about ${fmtBytes(l.slope)} a minute) and it hasn't gone back down. That often means a memory leak. Restarting it will give the memory back.`,
      pid: l.pid, app: l.name.toLowerCase(), actions: ['restart', 'end'] });
  }

  // Not responding
  for (const [k, a] of byApp) {
    if (!a.hung) continue;
    out.push({ id: 'hung-' + k, sev: 'bad', title: `${name(k)} isn't responding`, detail: 'Its window has stopped reacting. Wait a little, or end it and start it again.', app: k, actions: ['end', 'restart'] });
  }

  // Disk / network
  const ioHog = [...appIo].filter(([k, v]) => !skip(k) && v >= 30 * 2 ** 20).sort((a, b) => b[1] - a[1])[0];
  if (ioHog) {
    out.push({ id: 'io-' + ioHog[0], sev: 'warn', title: `${name(ioHog[0])} is reading and writing a lot (${fmtBytes(ioHog[1])}/s)`,
      detail: 'Heavy disk or file activity can make everything else feel slow, especially on a hard drive.', app: ioHog[0], actions: ['lower', 'pause'] });
  }
  const netHog = [...appNet].filter(([k, v]) => !skip(k) && v >= 2 ** 20).sort((a, b) => b[1] - a[1])[0];
  if (netHog && snap.netPerApp) {
    out.push({ id: 'net-' + netHog[0], sev: 'info', title: `${name(netHog[0])} is using ${fmtBytes(netHog[1])}/s of network`,
      detail: 'If your internet feels slow, this is why.', app: netHog[0], actions: ['pause', 'end'] });
  } else if (snap.rxRate + snap.txRate >= 3 * 2 ** 20) {
    out.push({ id: 'net-total', sev: 'info', title: `Your network is busy (${fmtBytes(snap.rxRate)}/s down, ${fmtBytes(snap.txRate)}/s up)`,
      detail: snap.admin ? 'No single app stands out.' : 'Open Network to see which apps have connections. Restart as administrator to see the speed of each app.', actions: ['network'] });
  }

  // Disks
  for (const d of ctx.disks || []) {
    if (!d.total) continue;
    const pct = d.free / d.total;
    if (pct < 0.1 || d.free < 5 * 2 ** 30) {
      out.push({ id: 'disk-' + d.mount, sev: d.free < 2 * 2 ** 30 ? 'bad' : 'warn', title: `Drive ${d.mount} is almost full (${fmtBytes(d.free)} left)`,
        detail: 'A nearly full system drive slows down updates, the page file and apps. Empty the Recycle Bin or Downloads, or uninstall things you don\'t use.', actions: [] });
    }
  }

  if (ctx.paused) out.push({ id: 'paused', sev: 'info', title: `${ctx.paused} ${ctx.paused === 1 ? 'process is' : 'processes are'} paused by Lookout`, detail: 'Paused apps use no CPU but look frozen until you resume them.', actions: ['resumeall'] });
  if (ctx.uptime > 7 * 86400) out.push({ id: 'uptime', sev: 'info', title: `Your PC hasn't restarted in ${Math.floor(ctx.uptime / 86400)} days`, detail: 'A restart clears leaked memory and finishes pending updates.', actions: [] });

  out.sort((a, b) => SEV[a.sev] - SEV[b.sev]);
  if (!out.some((f) => f.sev === 'bad' || f.sev === 'warn')) {
    out.unshift({ id: 'ok', sev: 'good', title: 'Nothing looks wrong right now', detail: `CPU ${Math.round(cpu1)}% over the last minute, memory ${Math.round(memPct)}% used. If something felt slow a moment ago, check History.`, actions: ['history'] });
  }
  return out;
}

module.exports = { diagnose, fmtBytes, fmtDuration };
