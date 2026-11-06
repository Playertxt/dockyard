'use strict';
// Linux backend: /proc for processes, connections and open files; wmctrl / xdotool / xprop for windows.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLK_TCK = 100;
const LEVEL_NICE = { idle: 19, below: 10, normal: 0, above: -5, high: -10 };

function niceToLevel(n) {
  if (n >= 15) return 'idle';
  if (n >= 5) return 'below';
  if (n > -3) return 'normal';
  if (n > -8) return 'above';
  return 'high';
}

// /proc/<pid>/stat: the name can contain spaces and brackets, so split at the last ')'.
function parseProcStat(text) {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < 0) return null;
  const f = text.slice(close + 2).split(' ');
  return {
    pid: parseInt(text.slice(0, open), 10),
    name: text.slice(open + 1, close),
    state: f[0],
    ppid: parseInt(f[1], 10),
    utime: parseInt(f[11], 10),
    stime: parseInt(f[12], 10),
    nice: parseInt(f[16], 10),
    threads: parseInt(f[17], 10),
    starttime: parseInt(f[19], 10),
    rss: parseInt(f[21], 10)
  };
}

function parseCpuLine(text) {
  const line = text.split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;
  const v = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (v[3] || 0) + (v[4] || 0);
  const total = v.reduce((a, b) => a + (b || 0), 0);
  return { idle, total };
}

function parseNetDev(text) {
  let rx = 0, tx = 0;
  for (const line of text.split('\n').slice(2)) {
    const m = line.match(/^\s*([^:]+):\s*(.*)$/);
    if (!m || m[1].trim() === 'lo') continue;
    const v = m[2].trim().split(/\s+/).map(Number);
    rx += v[0] || 0;
    tx += v[8] || 0;
  }
  return { rx, tx };
}

function parseMeminfo(text) {
  const get = (k) => { const m = text.match(new RegExp('^' + k + ':\\s+(\\d+)', 'm')); return m ? parseInt(m[1], 10) * 1024 : 0; };
  return { total: get('MemTotal'), available: get('MemAvailable') || get('MemFree') };
}

function hexIp4(h) {
  const n = parseInt(h, 16);
  return [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255].join('.');
}

function hexIp6(h) {
  // Four little-endian 32-bit words.
  const parts = [];
  for (let w = 0; w < 4; w++) {
    const word = h.slice(w * 8, w * 8 + 8);
    const bytes = word.match(/../g).reverse().join('');
    parts.push(bytes.slice(0, 4), bytes.slice(4, 8));
  }
  const g = parts.map((p) => parseInt(p, 16).toString(16));
  // Compress the longest run of zero groups to "::".
  let best = -1, bestLen = 0;
  for (let i = 0; i < 8;) {
    if (g[i] !== '0') { i++; continue; }
    let j = i;
    while (j < 8 && g[j] === '0') j++;
    if (j - i > bestLen && j - i >= 2) { best = i; bestLen = j - i; }
    i = j;
  }
  if (best < 0) return g.join(':');
  return g.slice(0, best).join(':') + '::' + g.slice(best + bestLen).join(':');
}

const TCP_STATES = { '01': 'established', '02': 'syn-sent', '03': 'syn-received', '04': 'fin-wait-1', '05': 'fin-wait-2', '06': 'time-wait',
  '07': 'closed', '08': 'close-wait', '09': 'last-ack', '0A': 'listen', '0B': 'closing' };

// /proc/net/tcp, tcp6, udp, udp6 -> [{proto, la, lp, ra, rp, state, inode}]
function parseNetTable(text, proto) {
  const out = [];
  const v6 = proto.endsWith('6');
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const [la, lp] = f[1].split(':');
    const [ra, rp] = f[2].split(':');
    out.push({
      proto, la: v6 ? hexIp6(la) : hexIp4(la), lp: parseInt(lp, 16), ra: v6 ? hexIp6(ra) : hexIp4(ra), rp: parseInt(rp, 16),
      state: proto.startsWith('tcp') ? (TCP_STATES[f[3]] || '') : '', inode: f[9]
    });
  }
  return out;
}

// wmctrl -lpG: id desk pid x y w h host title
function parseWmctrl(out) {
  const wins = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^(0x[0-9a-f]+)\s+(-?\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+\S+\s?(.*)$/i);
    if (!m) continue;
    wins.push({ id: parseInt(m[1], 16), desk: parseInt(m[2], 10), pid: parseInt(m[3], 10), x: +m[4], y: +m[5], w: +m[6], h: +m[7], title: m[8] || '' });
  }
  return wins;
}

function shellQuote(args) { return args.map((a) => /^[\w@%+=:,./-]+$/.test(a) ? a : "'" + a.replace(/'/g, "'\\''") + "'").join(' '); }

function run(cmd, args, timeout = 3000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; } };

class LinuxPlatform {
  constructor() {
    this.name = 'linux';
    this.excluded = new Set();
    this.prev = new Map();
    this.prevSys = null;
    this.prevWall = 0;
    this.suspended = new Set();
    this.hidden = new Set();
    this.opacity = new Set();
    this.screens = [];
    this.caps = { hung: false, perAppNet: false, fileLocks: true, opacity: true, describe: false };
    this.btime = 0;
    this.uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  }

  async init() {
    const stat = read('/proc/stat') || '';
    const m = stat.match(/^btime\s+(\d+)/m);
    this.btime = m ? parseInt(m[1], 10) : Math.floor(Date.now() / 1000 - os.uptime());
    this.hasWmctrl = !!(await run('which', ['wmctrl']));
    this.hasXdotool = !!(await run('which', ['xdotool']));
    return true;
  }

  get helperPid() { return 0; }
  excludePids(pids) { pids.forEach((p) => this.excluded.add(p)); }
  setScreens(rects) { this.screens = rects; }

  async _windowsByPid() {
    const map = new Map();
    if (!this.hasWmctrl) return map;
    const out = await run('wmctrl', ['-lpG']);
    if (!out) return map;
    for (const w of parseWmctrl(out)) {
      if (w.desk === -1) continue;
      const e = map.get(w.pid) || { count: 0, title: w.title };
      e.count++;
      map.set(w.pid, e);
    }
    return map;
  }

  async sample() {
    const now = Date.now();
    const sys = parseCpuLine(read('/proc/stat') || '');
    let cpu = 0;
    if (sys && this.prevSys) {
      const dt = sys.total - this.prevSys.total;
      if (dt > 0) cpu = Math.max(0, Math.min(100, (1 - (sys.idle - this.prevSys.idle) / dt) * 100));
    }
    this.prevSys = sys;
    const net = parseNetDev(read('/proc/net/dev') || '');
    const mem = parseMeminfo(read('/proc/meminfo') || '');
    const cpus = os.cpus().length || 1;
    const wall = (now - this.prevWall) / 1000;
    const wins = await this._windowsByPid();
    const next = new Map();
    const procs = [];
    let entries = [];
    try { entries = fs.readdirSync('/proc'); } catch (_) { /* none */ }
    for (const d of entries) {
      if (!/^\d+$/.test(d)) continue;
      const pid = +d;
      const st = parseProcStat(read(`/proc/${d}/stat`) || '');
      if (!st) continue;
      const status = read(`/proc/${d}/status`) || '';
      const uidM = status.match(/^Uid:\s+(\d+)/m);
      const uid = uidM ? +uidM[1] : -1;
      const statm = (read(`/proc/${d}/statm`) || '').split(' ').map(Number);
      const page = 4096;
      const ws = (statm[1] || st.rss || 0) * page;
      const priv = Math.max(0, ((statm[1] || 0) - (statm[2] || 0)) * page);
      const io = read(`/proc/${d}/io`);
      let ior = 0, iow = 0, iot = 0;
      if (io) {
        const g = (k) => { const m = io.match(new RegExp('^' + k + ':\\s+(\\d+)', 'm')); return m ? +m[1] : 0; };
        ior = g('read_bytes'); iow = g('write_bytes'); iot = g('rchar') + g('wchar');
      }
      let exe = '';
      try { exe = fs.readlinkSync(`/proc/${d}/exe`); } catch (_) { /* not ours */ }
      let handles = 0;
      try { handles = fs.readdirSync(`/proc/${d}/fd`).length; } catch (_) { /* not ours */ }
      const start = Math.round((this.btime + st.starttime / CLK_TCK) * 1000);
      const ticks = st.utime + st.stime;
      const prev = this.prev.get(pid);
      let pcpu = 0;
      if (prev && prev.start === start && wall > 0) pcpu = Math.max(0, Math.min(100, ((ticks - prev.ticks) / CLK_TCK) / (wall * cpus) * 100));
      next.set(pid, { start, ticks });
      const w = wins.get(pid);
      procs.push({
        pid, ppid: st.ppid, name: st.name, exe, start, threads: st.threads, handles,
        cpu: Math.round(pcpu * 100) / 100, mem: ws, priv, io: iot, ior, iow,
        priority: niceToLevel(st.nice), user: uid === this.uid, suspended: this.suspended.has(pid) || st.state === 'T',
        self: this.excluded.has(pid), windows: w ? w.count : 0, hung: false, title: w ? w.title : null, kernel: st.ppid === 2 || pid === 2
      });
    }
    this.prev = next;
    this.prevWall = now;
    for (const p of this.suspended) if (!next.has(p)) this.suspended.delete(p);
    return { t: now, cpus, cpu, rx: net.rx, tx: net.tx, admin: this.uid === 0, memTotal: mem.total || os.totalmem(), memUsed: (mem.total || os.totalmem()) - (mem.available || os.freemem()), procs };
  }

  // Map socket inodes to pids by scanning /proc/*/fd (only our own processes unless root).
  _inodeOwners() {
    const owners = new Map();
    let entries = [];
    try { entries = fs.readdirSync('/proc'); } catch (_) { return owners; }
    for (const d of entries) {
      if (!/^\d+$/.test(d)) continue;
      let fds;
      try { fds = fs.readdirSync(`/proc/${d}/fd`); } catch (_) { continue; }
      for (const fd of fds) {
        let link;
        try { link = fs.readlinkSync(`/proc/${d}/fd/${fd}`); } catch (_) { continue; }
        const m = link.match(/^socket:\[(\d+)\]$/);
        if (m) owners.set(m[1], +d);
      }
    }
    return owners;
  }

  async connections() {
    const owners = this._inodeOwners();
    const conns = [];
    for (const proto of ['tcp', 'tcp6', 'udp', 'udp6']) {
      const t = read('/proc/net/' + proto);
      if (!t) continue;
      for (const c of parseNetTable(t, proto)) {
        const pid = owners.get(c.inode) || 0;
        delete c.inode;
        conns.push({ pid, ...c });
      }
    }
    return { admin: this.uid === 0, conns };
  }

  async windows() {
    const list = [];
    if (this.hasWmctrl) {
      const out = await run('wmctrl', ['-lpG']);
      for (const w of parseWmctrl(out || '')) {
        if (w.desk === -1) continue;
        const offscreen = this.screens.length > 0 && !this.screens.some((s) => w.x < s.x + s.width && w.x + w.w > s.x && w.y < s.y + s.height && w.y + w.h > s.y);
        let exe = '';
        try { exe = fs.readlinkSync(`/proc/${w.pid}/exe`); } catch (_) { /* ignore */ }
        list.push({ id: w.id, title: w.title, pid: w.pid, exe, cls: '', visible: true, ours: false, taskbar: true, appLike: true, minimized: false,
          maximized: false, topmost: false, hung: false, offscreen, alpha: this.opacity.has(w.id) ? 128 : 255, x: w.x, y: w.y, w: w.w, h: w.h });
      }
    }
    for (const id of this.hidden) {
      if (list.some((w) => w.id === id)) continue;
      list.push({ id, title: '(hidden by Lookout)', pid: 0, exe: '', cls: '', visible: false, ours: true, taskbar: false, appLike: true,
        minimized: false, maximized: false, topmost: false, hung: false, offscreen: false, alpha: 255, x: 0, y: 0, w: 0, h: 0 });
    }
    return { foreground: 0, windows: list };
  }

  async winAction(id, action, arg) {
    const hex = '0x' + Number(id).toString(16);
    const ok = (r) => ({ ok: r !== null });
    switch (action) {
      case 'focus': return ok(await run('wmctrl', ['-i', '-a', hex]));
      case 'minimize': return this.hasXdotool ? ok(await run('xdotool', ['windowminimize', String(id)])) : { ok: false, reason: 'Install xdotool.' };
      case 'maximize': return ok(await run('wmctrl', ['-i', '-r', hex, '-b', 'add,maximized_vert,maximized_horz']));
      case 'restore': return ok(await run('wmctrl', ['-i', '-r', hex, '-b', 'remove,maximized_vert,maximized_horz']));
      case 'close': return ok(await run('wmctrl', ['-i', '-c', hex]));
      case 'topmost': return ok(await run('wmctrl', ['-i', '-r', hex, '-b', arg === 1 ? 'add,above' : arg === 0 ? 'remove,above' : 'toggle,above']));
      case 'opacity': {
        if (arg >= 100) { this.opacity.delete(id); return ok(await run('xprop', ['-id', hex, '-remove', '_NET_WM_WINDOW_OPACITY'])); }
        this.opacity.add(id);
        const v = Math.round(Math.max(15, arg) / 100 * 0xffffffff);
        return ok(await run('xprop', ['-id', hex, '-f', '_NET_WM_WINDOW_OPACITY', '32c', '-set', '_NET_WM_WINDOW_OPACITY', String(v)]));
      }
      case 'hide':
        if (!this.hasXdotool) return { ok: false, reason: 'Install xdotool.' };
        this.hidden.add(id);
        return ok(await run('xdotool', ['windowunmap', String(id)]));
      case 'show':
        this.hidden.delete(id);
        if (this.hasXdotool) await run('xdotool', ['windowmap', String(id)]);
        return ok(await run('wmctrl', ['-i', '-a', hex]));
      case 'bringback': {
        this.hidden.delete(id);
        if (this.hasXdotool) await run('xdotool', ['windowmap', String(id)]);
        await run('xprop', ['-id', hex, '-remove', '_NET_WM_WINDOW_OPACITY']);
        this.opacity.delete(id);
        const s = this.screens[0] || { x: 0, y: 0, width: 1280, height: 720 };
        const w = Math.min(900, s.width), h = Math.min(600, s.height);
        await run('wmctrl', ['-i', '-r', hex, '-b', 'remove,maximized_vert,maximized_horz,hidden']);
        await run('wmctrl', ['-i', '-r', hex, '-e', `0,${s.x + Math.round((s.width - w) / 2)},${s.y + Math.round((s.height - h) / 2)},${w},${h}`]);
        return ok(await run('wmctrl', ['-i', '-a', hex]));
      }
    }
    return { ok: false, reason: 'Unknown action.' };
  }

  async unhideAll() {
    for (const id of this.hidden) { if (this.hasXdotool) await run('xdotool', ['windowmap', String(id)]); }
    for (const id of this.opacity) await run('xprop', ['-id', '0x' + id.toString(16), '-remove', '_NET_WM_WINDOW_OPACITY']);
    const n = this.hidden.size;
    this.hidden.clear();
    this.opacity.clear();
    return { ok: true, shown: n };
  }

  _signal(pid, sig) {
    try { process.kill(pid, sig); return { ok: true }; } catch (e) {
      return { ok: false, reason: e.code === 'EPERM' ? 'Permission denied. It belongs to another user (try running with sudo).' : e.code === 'ESRCH' ? 'It has already ended.' : e.message };
    }
  }

  async kill(pid) {
    if (this.excluded.has(pid)) return { ok: false, reason: "Lookout won't end itself." };
    const r = this._signal(pid, 'SIGTERM');
    if (!r.ok) return r;
    await new Promise((res) => setTimeout(res, 1500));
    try { process.kill(pid, 0); this._signal(pid, 'SIGKILL'); } catch (_) { /* gone */ }
    return { ok: true };
  }

  async killTree(root) {
    const kids = new Map();
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      const st = parseProcStat(read(`/proc/${d}/stat`) || '');
      if (!st) continue;
      if (!kids.has(st.ppid)) kids.set(st.ppid, []);
      kids.get(st.ppid).push(st.pid);
    }
    const order = [];
    const stack = [root];
    const seen = new Set();
    while (stack.length) {
      const p = stack.pop();
      if (seen.has(p)) continue;
      seen.add(p);
      order.push(p);
      for (const c of kids.get(p) || []) stack.push(c);
    }
    order.reverse();
    let killed = 0, failed = 0;
    for (const p of order) {
      if (this.excluded.has(p)) { failed++; continue; }
      if (this._signal(p, 'SIGKILL').ok) killed++; else failed++;
    }
    return { ok: killed > 0, killed, failed, reason: killed ? undefined : 'Permission denied.' };
  }

  async setPriority(pid, level) {
    try { os.setPriority(pid, LEVEL_NICE[level] == null ? 0 : LEVEL_NICE[level]); return { ok: true }; } catch (e) {
      return { ok: false, reason: (LEVEL_NICE[level] || 0) < 0 ? 'Raising priority needs root on Linux.' : 'Permission denied.' };
    }
  }

  async suspend(pid) {
    if (this.excluded.has(pid)) return { ok: false, reason: "Lookout won't pause itself." };
    const r = this._signal(pid, 'SIGSTOP');
    if (r.ok) this.suspended.add(pid);
    return r;
  }

  async resume(pid) {
    const r = this._signal(pid, 'SIGCONT');
    this.suspended.delete(pid);
    return r;
  }

  async resumeAll() {
    let n = 0;
    for (const p of this.suspended) if (this._signal(p, 'SIGCONT').ok) n++;
    this.suspended.clear();
    return { ok: true, resumed: n };
  }

  async details(pid) {
    const raw = read(`/proc/${pid}/cmdline`);
    let exe = '';
    try { exe = fs.readlinkSync(`/proc/${pid}/exe`); } catch (_) { /* ignore */ }
    let cwd = '';
    try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch (_) { /* ignore */ }
    const args = raw ? raw.split('\0').filter((a, i, arr) => a || i < arr.length - 1) : null;
    return { pid, cmd: args && args.length ? shellQuote(args) : null, exe, cwd };
  }

  async describe() { return []; }

  async whoFile(target) {
    let real;
    try { real = fs.realpathSync(target); } catch (_) { return { ok: false, reason: "That file or folder doesn't exist." }; }
    let isDir = false;
    try { isDir = fs.statSync(real).isDirectory(); } catch (_) { /* ignore */ }
    const hits = new Map();
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      const check = (link) => link === real || (isDir && link.startsWith(real + '/'));
      let found = false;
      try { if (check(fs.readlinkSync(`/proc/${d}/cwd`))) found = true; } catch (_) { /* ignore */ }
      if (!found) {
        let fds = [];
        try { fds = fs.readdirSync(`/proc/${d}/fd`); } catch (_) { continue; }
        for (const fd of fds) {
          try { if (check(fs.readlinkSync(`/proc/${d}/fd/${fd}`))) { found = true; break; } } catch (_) { /* ignore */ }
        }
      }
      if (found) {
        const st = parseProcStat(read(`/proc/${d}/stat`) || '');
        hits.set(+d, { pid: +d, app: st ? st.name : '', service: '', type: 0 });
      }
    }
    return { ok: true, files: 1, procs: [...hits.values()] };
  }

  async launch(cmd, cwd) {
    try {
      const child = spawn('/bin/sh', ['-c', cmd], { cwd: cwd && fs.existsSync(cwd) ? cwd : os.homedir(), detached: true, stdio: 'ignore' });
      child.unref();
      return { ok: true, pid: child.pid };
    } catch (e) { return { ok: false, reason: e.message }; }
  }

  commandFor(exe) { return shellQuote([exe]); }

  quit() {
    this.resumeAll();
    this.unhideAll();
  }
}

module.exports = { LinuxPlatform, parseProcStat, parseCpuLine, parseNetDev, parseMeminfo, parseNetTable, parseWmctrl, niceToLevel, hexIp4, hexIp6, shellQuote, LEVEL_NICE };
