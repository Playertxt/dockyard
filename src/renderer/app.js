'use strict';
/* global window, document */
const api = window.lookout;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const lc = (s) => String(s || '').toLowerCase();
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = {
  view: 'overview', tick: null, names: {}, icons: {}, iconQueue: new Set(), settings: {}, rules: [], recent: [], focus: { active: false }, focusPrefs: {},
  procMode: 'apps', sort: { key: 'cpu', dir: -1 }, expanded: new Set(), collapsed: new Set(), sel: null, search: '', armed: null, platform: 'win32', caps: {},
  hist: { metric: 'cpu', range: 15, data: null, hidden: new Set(), hover: null, pinned: null, evFilter: 'actions' },
  netOpen: new Set(), netSearch: '', winSearch: '', diag: null, netSpark: { rx: [], tx: [] }, editing: null, focusPick: null, focusPause: new Set()
};

// ------------------------------------------------------------------ formatting
function fmtBytes(b, digits) {
  if (b == null || !(b > 0)) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return (b >= 100 || i === 0 ? Math.round(b) : b.toFixed(digits == null ? 1 : digits)) + ' ' + u[i];
}
const fmtRate = (b) => (b > 0 ? fmtBytes(b) + '/s' : '0');
const fmtPct = (v) => (v == null || v < 0 ? '–' : v < 0.05 ? '0%' : v < 10 ? v.toFixed(1) + '%' : Math.round(v) + '%');
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const shortClock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function ago(t) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  return Math.floor(s / 86400) + ' d ago';
}
function dur(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}
const PRI = { idle: 'Low', below: 'Below normal', normal: 'Normal', above: 'Above normal', high: 'High', realtime: 'Realtime' };
const COLORS = () => [1, 2, 3, 4, 5, 6, 7].map((i) => cssVar('--c' + i));
function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

// ------------------------------------------------------------------ icons
function iconHtml(exe, cls = '') {
  const key = lc(exe);
  if (key && S.icons[key]) return `<img class="${cls}" src="${S.icons[key]}" alt="">`;
  if (key && !(key in S.icons)) queueIcon(exe);
  return `<span class="noicon ${cls}"></span>`;
}
let iconTimer = null;
function queueIcon(exe) {
  S.iconQueue.add(exe);
  if (iconTimer) return;
  iconTimer = setTimeout(async () => {
    iconTimer = null;
    const paths = [...S.iconQueue].slice(0, 80);
    paths.forEach((p) => S.iconQueue.delete(p));
    for (const p of paths) S.icons[lc(p)] = S.icons[lc(p)] || null;
    const got = await api.invoke('icons', { paths });
    Object.assign(S.icons, got);
    rerender();
  }, 120);
}

// ------------------------------------------------------------------ toasts & menu
function toast(text, opts = {}) {
  const el = document.createElement('div');
  el.className = 'toast' + (opts.err ? ' err' : '');
  el.innerHTML = `<span>${esc(text)}</span>` + (opts.undo ? '<button data-undo>Undo</button>' : '') + (opts.action ? `<button data-act>${esc(opts.action.label)}</button>` : '');
  $('#toasts').appendChild(el);
  const kill = () => el.remove();
  if (opts.undo) $('[data-undo]', el).onclick = async () => { kill(); const r = await api.invoke('recent:relaunch', { id: opts.undo }); toast(r.ok ? 'Started it again.' : r.reason, { err: !r.ok }); };
  if (opts.action) $('[data-act]', el).onclick = () => { kill(); opts.action.fn(); };
  setTimeout(kill, opts.ms || (opts.undo ? 9000 : 4500));
}

function showMenu(items, x, y) {
  const m = $('#menu');
  m.innerHTML = items.map((it, i) => {
    if (it === '-') return '<hr>';
    if (it.header) return `<div class="mh">${esc(it.header)}</div>`;
    return `<button data-i="${i}" class="${it.danger ? 'danger' : ''}" ${it.disabled ? 'disabled' : ''} title="${esc(it.title || '')}"><span>${esc(it.label)}</span>${it.hint ? `<small>${esc(it.hint)}</small>` : ''}</button>`;
  }).join('');
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
  m.onclick = (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b || b.disabled) return;
    hideMenu();
    items[+b.dataset.i].fn();
  };
}
function hideMenu() { $('#menu').hidden = true; }
document.addEventListener('mousedown', (e) => { if (!e.target.closest('#menu')) hideMenu(); });
window.addEventListener('blur', hideMenu);

// Two-click confirmation for destructive buttons.
function armed(id) { return S.armed && S.armed.id === id && Date.now() < S.armed.until; }
function arm(id) { S.armed = { id, until: Date.now() + 3000 }; setTimeout(() => { if (S.armed && S.armed.id === id && Date.now() >= S.armed.until) { S.armed = null; rerender(); } }, 3100); }
function needsConfirm(id) {
  if (!S.settings.confirmEnd) return false;
  if (armed(id)) { S.armed = null; return false; }
  arm(id);
  rerender();
  return true;
}

// ------------------------------------------------------------------ actions
const VERB = { end: 'Ended', endtree: 'Ended', restart: 'Restarted', pause: 'Paused', resume: 'Resumed', priority: 'Changed priority of', lower: 'Lowered priority of', open: '', search: '', copy: 'Copied details of' };
async function act(kind, target, action, extra = {}) {
  const payload = kind === 'app' ? { app: target.app, action, ...extra } : { pid: target.pid, k: target.k, action, ...extra };
  const r = await api.invoke(kind === 'app' ? 'app:action' : 'proc:action', payload);
  if (r && r.cancelled) return r;
  if (!r || !r.ok) { toast((r && r.reason) || 'That didn\'t work.', { err: true }); return r; }
  const name = target.display || S.names[target.app] || target.name;
  const v = VERB[action];
  if (action === 'pause') toast(`Paused ${name}. It uses no CPU until you resume it.`);
  else if (action === 'priority' || action === 'lower') toast(`${name} now runs at ${PRI[extra.level || 'idle']} priority.`);
  else if (action === 'end' || action === 'endtree') toast(`${v} ${name}` + (r.killed > 1 ? ` (${r.killed} processes)` : '') + (r.failed ? `. ${r.failed} couldn't be ended.` : '.'), { undo: r.undo });
  else if (v) toast(`${v} ${name}.`);
  return r;
}

// ------------------------------------------------------------------ navigation
const VIEWS = {};
function setView(v) {
  if (!document.getElementById('v-' + v)) v = 'overview';
  if (S.view && VIEWS[S.view] && VIEWS[S.view].leave) VIEWS[S.view].leave();
  S.view = v;
  $$('.view').forEach((el) => el.classList.toggle('active', el.id === 'v-' + v));
  $$('.nav button[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  api.invoke('view', { view: v });
  hideMenu();
  if (VIEWS[v] && VIEWS[v].enter) VIEWS[v].enter();
}
$$('.nav button[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

function rerender() { const v = VIEWS[S.view]; if (v && v.render) v.render(); }

// ------------------------------------------------------------------ live data
function onTick(t) {
  S.tick = t;
  S.focus = t.focus || S.focus;
  S.netSpark.rx.push(t.rx); S.netSpark.tx.push(t.tx);
  if (S.netSpark.rx.length > 150) { S.netSpark.rx.shift(); S.netSpark.tx.shift(); }
  $('#miniStats').innerHTML = `<span>CPU</span><b>${fmtPct(t.cpu)}</b><span>Memory</span><b>${fmtPct(t.memPct)}</b><span>Network</span><b>${fmtRate(t.rx + t.tx)}</b>`;
  $('#focusBadge').hidden = !S.focus.active;
  $('#resumeAllBtn').hidden = !t.pausedCount;
  $('#resumeAllBtn').textContent = `Resume all paused (${t.pausedCount})`;
  const v = VIEWS[S.view];
  if (v && v.tick) v.tick(t);
}

// ================================================================== Overview
VIEWS.overview = {
  enter() { this.refresh(); clearInterval(this.timer); this.timer = setInterval(() => this.refresh(), 4000); },
  leave() { clearInterval(this.timer); },
  async refresh() {
    const d = await api.invoke('diagnose');
    if (!d || !d.ready) return;
    S.diag = d;
    this.render();
  },
  tick() { this.renderMeters(); this.renderChips(); },
  renderChips() {
    const t = S.tick;
    if (!t) return;
    const chips = [];
    if (t.admin) chips.push('<span class="chip on">Administrator</span>');
    if (S.focus.active) chips.push(`<button class="chip on" data-go="focus">Focus mode: ${esc(S.focus.name)}</button>`);
    if (t.pausedCount) chips.push(`<button class="chip warn" data-resumeall>${t.pausedCount} paused · resume</button>`);
    $('#chips').innerHTML = chips.join('');
  },
  renderMeters() {
    const t = S.tick;
    if (!t) return;
    const sp = S.diag && S.diag.spark;
    const memSeries = sp ? sp.mem.system : [];
    const cards = [
      { k: 'CPU', v: fmtPct(t.cpu), s: `${t.cpus} threads`, data: sp ? sp.cpu.system : [], max: 100, c: '--c1' },
      { k: 'Memory', v: fmtBytes(t.memUsed), s: `of ${fmtBytes(t.memTotal)} · ${fmtPct(t.memPct)}`, data: memSeries, max: 100, c: '--c2' },
      { k: 'Network', v: fmtRate(t.rx + t.tx), s: `↓ ${fmtRate(t.rx)}  ↑ ${fmtRate(t.tx)}`, data: sp ? sp.net.system : [], c: '--c3' },
      { k: 'Disk & file I/O', v: fmtRate(t.io), s: 'all apps', data: sp ? sp.io.system : [], c: '--c4' }
    ];
    const box = $('#meters');
    if (box.children.length !== 4) box.innerHTML = cards.map(() => '<div class="meter"><div class="k"><span></span><span></span></div><div class="v"></div><canvas></canvas></div>').join('');
    cards.forEach((c, i) => {
      const el = box.children[i];
      el.querySelector('.k span').textContent = c.k;
      el.querySelector('.k span:last-child').textContent = c.s;
      el.querySelector('.v').textContent = c.v;
      drawSpark(el.querySelector('canvas'), c.data, { max: c.max, color: cssVar(c.c) });
    });
  },
  render() {
    this.renderMeters();
    this.renderChips();
    const d = S.diag;
    if (!d) return;
    const icon = (f) => {
      if (!f.app || !S.tick) return '';
      const p = S.tick.procs.find((x) => x.app === f.app && x.exe);
      return p ? iconHtml(p.exe) : '';
    };
    const ACT = { lower: 'Lower priority', pause: 'Pause', end: 'End task', restart: 'Restart it', resumeall: 'Resume all', history: 'Open History', network: 'Open Network' };
    $('#findings').innerHTML = d.findings.map((f) => `
      <div class="finding ${f.sev}" data-id="${esc(f.id)}">
        <div class="bar"></div>
        <div><div class="t">${icon(f)}<span>${esc(f.title)}</span></div><div class="d">${esc(f.detail)}</div></div>
        <div class="acts">${(f.actions || []).map((a) => {
          const id = 'f-' + f.id + '-' + a;
          const danger = a === 'end' || a === 'restart';
          return `<button class="btn small ${danger ? 'danger' : ''} ${armed(id) ? 'armed' : ''}" data-fa="${a}">${armed(id) ? 'Sure?' : ACT[a] || a}</button>`;
        }).join('')}${f.app ? `<button class="btn small ghost" data-fa="details">Details</button>` : ''}</div>
      </div>`).join('');
    const s = d.sys;
    const disks = (s.disks || []).map((x) => {
      const used = x.total ? 1 - x.free / x.total : 0;
      return `<div class="fact"><div class="k">Drive ${esc(x.mount)}</div><div class="v">${fmtBytes(x.free)} free of ${fmtBytes(x.total)}</div><div class="diskbar"><i class="${x.free / x.total < 0.1 ? 'low' : ''}" style="width:${(used * 100).toFixed(1)}%"></i></div></div>`;
    }).join('');
    $('#facts').innerHTML = `
      <div class="fact"><div class="k">Processor</div><div class="v" title="${esc(s.cpuModel)}">${esc((s.cpuModel || '').replace(/\(R\)|\(TM\)|CPU|Processor/gi, '').replace(/\s+/g, ' ').trim() || s.cpus + ' threads')}</div></div>
      <div class="fact"><div class="k">Running</div><div class="v">${s.procs} processes · ${s.threads.toLocaleString()} threads</div></div>
      <div class="fact"><div class="k">Up for</div><div class="v">${dur(s.uptime)}</div></div>
      ${S.platform === 'win32' ? `<div class="fact"><div class="k">Handles</div><div class="v">${s.handles.toLocaleString()}</div></div>` : ''}
      ${disks}`;
  }
};
$('#findings').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-fa]');
  if (!b) return;
  const f = S.diag.findings.find((x) => x.id === b.closest('.finding').dataset.id);
  if (!f) return;
  const a = b.dataset.fa;
  const target = { app: f.app, display: S.names[f.app] || f.app };
  if (a === 'history') return setView('history');
  if (a === 'network') return setView('network');
  if (a === 'resumeall') { await api.invoke('resumeAll'); toast('Resumed everything Lookout paused.'); return VIEWS.overview.refresh(); }
  if (a === 'details') { S.sel = { type: 'app', id: f.app }; S.procMode = 'apps'; setView('processes'); return; }
  if ((a === 'end' || a === 'restart') && needsConfirm('f-' + f.id + '-' + a)) return;
  if (a === 'restart' && f.pid) await act('proc', { pid: f.pid, k: null, display: target.display }, 'restart');
  else if (a === 'lower') await act('app', target, 'lower', { level: 'idle' });
  else await act('app', target, a);
  VIEWS.overview.refresh();
});
document.addEventListener('click', async (e) => {
  const g = e.target.closest('[data-go]');
  if (g) setView(g.dataset.go);
  if (e.target.closest('[data-resumeall]')) { await api.invoke('resumeAll'); toast('Resumed everything Lookout paused.'); }
});

// ------------------------------------------------------------------ charts
function setupCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}
function drawSpark(cv, data, { max, color } = {}) {
  if (!cv || !cv.clientWidth) return;
  const { g, w, h } = setupCanvas(cv);
  if (!data || data.length < 2) return;
  const top = max || Math.max(1, ...data) * 1.15;
  const x = (i) => i / (data.length - 1) * w;
  const y = (v) => h - 2 - Math.min(1, v / top) * (h - 4);
  g.beginPath();
  data.forEach((v, i) => (i ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v))));
  g.strokeStyle = color; g.lineWidth = 1.6; g.stroke();
  g.lineTo(w, h); g.lineTo(0, h); g.closePath();
  g.globalAlpha = 0.14; g.fillStyle = color; g.fill(); g.globalAlpha = 1;
}

// ================================================================== Processes
const COLS = [
  { key: 'name', label: 'Name' }, { key: 'cpu', label: 'CPU', r: true }, { key: 'mem', label: 'Memory', r: true },
  { key: 'io', label: 'Disk & I/O', r: true }, { key: 'net', label: 'Network', r: true }, { key: 'pid', label: 'PID', r: true }
];
function renderProcHead() {
  $('#procHead').className = 'thead proc-cols';
  $('#procHead').innerHTML = COLS.map((c) => `<span data-sort="${c.key}" class="${c.r ? 'r' : ''} ${S.sort.key === c.key ? 'sorted' : ''}">${c.label}${S.sort.key === c.key ? (S.sort.dir < 0 ? ' ↓' : ' ↑') : ''}</span>`).join('');
}
$('#procHead').addEventListener('click', (e) => {
  const s = e.target.closest('[data-sort]');
  if (!s) return;
  const key = s.dataset.sort;
  if (S.sort.key === key) S.sort.dir *= -1; else S.sort = { key, dir: key === 'name' || key === 'pid' ? 1 : -1 };
  renderProcHead();
  VIEWS.processes.render();
});
$('#procMode').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  if (!b) return;
  S.procMode = b.dataset.mode;
  VIEWS.processes.render();
});
$('#procSearch').addEventListener('input', (e) => { S.search = e.target.value; VIEWS.processes.render(); });
$('#resumeAllBtn').addEventListener('click', async () => { const r = await api.invoke('resumeAll'); toast(`Resumed ${r.count || 0} paused ${r.count === 1 ? 'process' : 'processes'}.`); });

function displayOf(p) { return S.names[p.app] || p.name; }
function netOf(list) {
  if (list.every((p) => p.netIn == null)) return null;
  return list.reduce((s, p) => s + (p.netIn || 0) + (p.netOut || 0), 0);
}
function makeGroup(key, procs) {
  const first = procs.find((p) => p.exe) || procs[0];
  const prot = procs.every((p) => p.prot === 'self') ? 'self' : procs.some((p) => p.prot === 'blocked') ? 'blocked' : procs.some((p) => p.prot === 'risky') ? 'risky' : '';
  return {
    type: 'app', id: key, app: key, name: first.name, display: S.names[key] || first.name, exe: first.exe, procs,
    cpu: procs.reduce((s, p) => s + p.cpu, 0), mem: procs.reduce((s, p) => s + Math.max(0, p.mem), 0), io: procs.reduce((s, p) => s + p.io, 0), net: netOf(procs),
    pid: procs.length === 1 ? procs[0].pid : null, paused: procs.every((p) => p.paused), somePaused: procs.some((p) => p.paused), hung: procs.some((p) => p.hung),
    focus: procs.some((p) => p.focus), prot, noPause: procs.every((p) => p.noPause), windows: procs.reduce((s, p) => s + p.windows, 0), title: (procs.find((p) => p.title) || {}).title
  };
}
function sortVal(x, key) {
  if (key === 'name') return lc(x.display || x.name);
  if (key === 'status') return (x.hung ? 4 : 0) + (x.paused ? 2 : 0) + (x.focus ? 1 : 0);
  if (key === 'net') return x.net == null ? -1 : x.net;
  if (key === 'pid') return x.pid || 0;
  return x[key] || 0;
}
function sorter(a, b) {
  const k = S.sort.key, va = sortVal(a, k), vb = sortVal(b, k);
  if (va < vb) return -S.sort.dir;
  if (va > vb) return S.sort.dir;
  return a.pid - b.pid;
}
function procItem(p) {
  return { type: 'proc', id: p.k, k: p.k, pid: p.pid, app: p.app, name: p.name, display: displayOf(p), exe: p.exe, cpu: p.cpu, mem: Math.max(0, p.mem), io: p.io,
    net: p.netIn == null ? null : (p.netIn || 0) + (p.netOut || 0), paused: p.paused, hung: p.hung, focus: p.focus, prot: p.prot, noPause: p.noPause, title: p.title, windows: p.windows };
}
function matches(p, q) {
  return lc(displayOf(p)).includes(q) || lc(p.name).includes(q) || String(p.pid) === q || lc(p.exe).includes(q) || lc(p.title).includes(q);
}

function buildRows() {
  const t = S.tick;
  if (!t) return [];
  const q = lc(S.search.trim());
  const procs = q ? t.procs.filter((p) => matches(p, q)) : t.procs;
  const rows = [];
  if (S.procMode === 'apps') {
    const by = new Map();
    for (const p of procs) { if (!by.has(p.app)) by.set(p.app, []); by.get(p.app).push(p); }
    const groups = [...by].map(([k, list]) => makeGroup(k, list)).sort(sorter);
    for (const g of groups) {
      if (g.procs.length === 1) { const it = procItem(g.procs[0]); it.depth = 0; rows.push(it); continue; }
      g.depth = 0; g.count = g.procs.length; g.open = S.expanded.has(g.id) || !!q;
      rows.push(g);
      if (g.open) for (const p of g.procs.map(procItem).sort(sorter)) { p.depth = 1; p.child = true; rows.push(p); }
    }
  } else if (S.procMode === 'tree') {
    const byPid = new Map(t.procs.map((p) => [p.pid, p]));
    const kids = new Map();
    const roots = [];
    for (const p of t.procs) {
      const parent = byPid.get(p.ppid);
      if (parent && parent.pid !== p.pid && (parent.start || 0) <= (p.start || 0) + 1000) { if (!kids.has(parent.pid)) kids.set(parent.pid, []); kids.get(parent.pid).push(p); } else roots.push(p);
    }
    const show = q ? new Set() : null;
    if (q) {
      for (const p of procs) { let c = p; let guard = 0; while (c && guard++ < 64) { show.add(c.pid); c = byPid.get(c.ppid); if (c && show.has(c.pid)) break; } }
    }
    const walk = (list, depth) => {
      for (const p of list.map(procItem).sort(sorter)) {
        if (show && !show.has(p.pid)) continue;
        const ch = kids.get(p.pid) || [];
        p.depth = depth; p.count = ch.length ? countDesc(p.pid, kids) : 0; p.tree = true; p.open = !S.collapsed.has(p.k) || !!q;
        rows.push(p);
        if (ch.length && p.open) walk(ch, depth + 1);
      }
    };
    walk(roots, 0);
  } else {
    for (const p of procs.map(procItem).sort(sorter)) { p.depth = 0; rows.push(p); }
  }
  return rows;
}
function countDesc(pid, kids) {
  let n = 0;
  const stack = [...(kids.get(pid) || [])];
  while (stack.length && n < 5000) { const c = stack.pop(); n++; stack.push(...(kids.get(c.pid) || [])); }
  return n;
}

function heat(v, max) { const a = Math.min(0.42, (v / max) * 0.42); return a > 0.02 ? `background: rgba(${cssVar('--heat')}, ${a.toFixed(3)})` : ''; }

function rowHtml(x, t) {
  const indent = x.depth ? `<span style="width:${x.depth * 16}px;flex:none"></span>` : '';
  const tw = (x.type === 'app' && x.count > 1) || (x.tree && x.count) ? `<span class="tw" data-tw>${x.open ? '▾' : '▸'}</span>` : (x.tree || S.procMode === 'apps' ? '<span class="tw"></span>' : '');
  const tags = [];
  if (x.hung) tags.push('<span class="tag hung">Not responding</span>');
  if (x.paused) tags.push('<span class="tag paused">Paused</span>'); else if (x.somePaused) tags.push('<span class="tag paused">Part paused</span>');
  if (x.focus) tags.push('<span class="tag focus">Focus</span>');
  if (x.prot === 'blocked') tags.push('<span class="tag sys" title="Core system process: Lookout won\'t end it">System</span>');
  if (x.prot === 'self') tags.push('<span class="tag sys">Lookout</span>');
  const memMax = t.memTotal / 4;
  return `<span class="name">${indent}${tw}${iconHtml(x.exe)}<span class="nm" title="${esc(x.name + (x.title ? ' — ' + x.title : ''))}">${esc(x.child ? (x.title || x.name) : x.display)}</span>${x.count ? `<span class="count">${x.count}</span>` : ''}${tags.join('')}</span>
    <span class="r cell-heat" style="${heat(x.cpu, 60)}">${fmtPct(x.cpu)}</span>
    <span class="r cell-heat" style="${heat(x.mem, memMax)}">${x.mem > 0 ? fmtBytes(x.mem) : '–'}</span>
    <span class="r">${x.io > 1024 ? fmtRate(x.io) : '0'}</span>
    <span class="r" title="${x.net == null ? (S.platform === 'win32' ? 'Restart as administrator to see per-app network speed' : 'Not available on Linux') : ''}">${x.net == null ? '–' : x.net > 0 ? fmtRate(x.net) : '0'}</span>
    <span class="r">${x.pid || ''}</span>`;
}
function actsHtml(x) {
  const id = 'end-' + x.id;
  const canEnd = x.prot !== 'blocked' && x.prot !== 'self';
  const pauseBtn = x.paused ? '<button class="ib" data-a="resume" title="Resume">▶</button>' : `<button class="ib" data-a="pause" title="Pause (uses no CPU until resumed)" ${x.noPause ? 'disabled' : ''}>❚❚</button>`;
  return `${pauseBtn}<button class="ib ${armed(id) ? 'armed' : ''}" data-a="end" ${canEnd ? '' : 'disabled'} title="End task">${armed(id) ? 'Sure?' : 'End'}</button>`;
}

// Keyed rows: only cells that changed are rewritten, so buttons under the mouse stay put.
function syncRows(body, rows, html, acts, cls) {
  const existing = new Map();
  for (const el of body.children) existing.set(el.dataset.key, el);
  const frag = [];
  for (const x of rows) {
    let el = existing.get(x.type + ':' + x.id);
    if (!el) {
      el = document.createElement('div');
      el.dataset.key = x.type + ':' + x.id;
      el.innerHTML = '<div style="display:contents" class="cells"></div><div class="hover-acts"></div>';
    } else existing.delete(el.dataset.key);
    const c = cls(x);
    if (el.className !== c) el.className = c;
    const h = html(x);
    const cells = el.firstChild;
    if (cells._h !== h) { cells.innerHTML = h; cells._h = h; }
    const a = acts ? acts(x) : '';
    if (el.lastChild._h !== a) { el.lastChild.innerHTML = a; el.lastChild._h = a; }
    el._item = x;
    frag.push(el);
  }
  for (const el of existing.values()) el.remove();
  frag.forEach((el, i) => { if (body.children[i] !== el) body.insertBefore(el, body.children[i] || null); });
}

VIEWS.processes = {
  enter() { renderProcHead(); this.render(); this.detail(); clearInterval(this.timer); this.timer = setInterval(() => this.detail(), 2000); },
  leave() { clearInterval(this.timer); },
  tick() { this.render(); },
  render() {
    $$('#procMode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === S.procMode));
    $('#procHead').classList.toggle('no-pid', S.procMode === 'apps');
    const t = S.tick;
    if (!t) return;
    const rows = buildRows();
    this.rows = rows;
    syncRows($('#procBody'), rows, (x) => rowHtml(x, t), actsHtml, (x) => 'trow proc-cols' + (x.child ? ' child' : '') + (S.sel && S.sel.type === x.type && S.sel.id === x.id ? ' sel' : ''));
  },
  select(x) {
    S.sel = { type: x.type, id: x.id };
    this.render();
    this.detail(true);
  },
  async detail(force) {
    const box = $('#procDetail');
    if (!S.sel) { box.innerHTML = '<div class="empty">Select a process to see what it is and what you can do with it.</div>'; return; }
    if (this.loading && !force) return;
    // Don't rebuild the panel under the mouse (it would close dropdowns and move buttons).
    if (!force && (box.matches(':hover') || box.contains(document.activeElement))) return;
    this.loading = true;
    const sel = S.sel;
    let d;
    try {
      if (sel.type === 'app') d = await api.invoke('app:details', { app: sel.id });
      else { const p = S.tick && S.tick.procs.find((x) => x.k === sel.id); d = await api.invoke('proc:details', { k: sel.id, pid: p ? p.pid : 0 }); }
    } finally { this.loading = false; }
    if (S.sel !== sel) return;
    if (!d || !d.ok) { box.innerHTML = `<div class="empty">${esc((d && d.reason) || 'It has ended.')}</div>`; return; }
    this.renderDetail(d, sel);
  },
  renderDetail(d, sel) {
    const box = $('#procDetail');
    const isApp = sel.type === 'app';
    const x = (this.rows || []).find((r) => r.type === sel.type && r.id === sel.id) || {};
    const live = isApp ? null : S.tick.procs.find((p) => p.k === sel.id);
    const paused = isApp ? x.paused : live && live.paused;
    const prot = d.prot;
    const noPause = isApp ? x.noPause : d.noPause;
    const endId = 'dend-' + sel.id;
    const notice = prot === 'blocked' ? '<div class="notice bad">This is a core part of the operating system. Lookout won\'t end or pause it.</div>'
      : prot === 'risky' ? '<div class="notice warn">This is a system or service process. You can end it, but Lookout will ask first.</div>'
        : prot === 'self' ? '<div class="notice warn">This is Lookout itself.</div>' : '';
    const kv = [];
    if (!isApp) {
      kv.push(['PID', d.pid]);
      if (d.parent) kv.push(['Started by', d.parent.k ? `<span class="link" data-goto="${esc(d.parent.k)}">${esc(d.parent.name)}</span> (${d.parent.pid})` : esc(d.parent.name)]);
      if (live) {
        kv.push(['Running for', live.start ? dur((Date.now() - live.start) / 1000) : '–']);
        kv.push(['Priority', esc(PRI[live.priority] || live.priority || '–')]);
        kv.push(['Threads', live.threads]);
        if (S.platform === 'win32' || live.handles) kv.push([S.platform === 'win32' ? 'Handles' : 'Open files', live.handles || '–']);
        kv.push(['Private memory', fmtBytes(live.priv)]);
        if (live.windows) kv.push(['Windows', live.windows + (live.title ? ' · ' + esc(live.title) : '')]);
      }
      if (d.conns != null) kv.push(['Connections', d.conns]);
      if (d.children && d.children.length) kv.push(['Started', d.children.slice(0, 8).map((c) => `<span class="link" data-goto="${esc(c.k)}">${esc(c.name)}</span>`).join(', ') + (d.children.length > 8 ? ` +${d.children.length - 8} more` : '')]);
    } else {
      kv.push(['Processes', d.count]);
      kv.push(['CPU', fmtPct(x.cpu)]);
      kv.push(['Memory', fmtBytes(x.mem)]);
    }
    if (d.company) kv.push(['Publisher', esc(d.company)]);
    if (d.version) kv.push(['Version', esc(d.version)]);
    const s = d.series || { cpu: [], mem: [] };
    box.innerHTML = `
      <div class="dh">${iconHtml(d.exe)}<div><div class="t">${esc(d.display)}</div><div class="s">${esc(d.name)}${d.desc && d.desc !== d.display ? ' · ' + esc(d.desc) : ''}</div></div></div>
      ${notice}
      ${d.about ? `<div class="about"><b>What is this?</b>${esc(d.about)}</div>` : ''}
      <div class="acts-grid">
        <button class="btn danger ${armed(endId) ? 'armed' : ''}" data-d="end" ${prot === 'blocked' || prot === 'self' ? 'disabled' : ''}>${armed(endId) ? 'Click again to end' : isApp ? `End all ${d.count}` : 'End task'}</button>
        ${paused ? '<button class="btn" data-d="resume">Resume</button>' : `<button class="btn" data-d="pause" ${noPause ? 'disabled' : ''}>Pause</button>`}
        <button class="btn" data-d="restart" ${prot === 'blocked' || prot === 'self' ? 'disabled' : ''}>Restart</button>
        <select class="btn" data-d="priority" ${prot === 'blocked' ? 'disabled' : ''}>
          <option value="">Priority…</option>${Object.entries(PRI).filter(([k]) => k !== 'realtime').map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
        </select>
        ${!isApp ? `<button class="btn" data-d="endtree" ${prot === 'blocked' || prot === 'self' ? 'disabled' : ''}>End with its children</button>` : ''}
        <button class="btn" data-d="open" ${d.exe ? '' : 'disabled'}>Open file location</button>
        <button class="btn" data-d="search">Search online</button>
        <button class="btn" data-d="rule">Make a rule…</button>
      </div>
      <div class="spark-h"><span>CPU · last 10 min</span><span>${fmtPct(s.cpu.length ? Math.max(...s.cpu) : 0)} peak</span></div><canvas id="dsCpu"></canvas>
      <div class="spark-h"><span>Memory · last 10 min</span><span>${fmtBytes(s.mem.length ? s.mem[s.mem.length - 1] : 0)} now</span></div><canvas id="dsMem"></canvas>
      <div class="kv">${kv.map(([k, v]) => `<div class="k">${k}</div><div class="v">${v}</div>`).join('')}</div>
      ${d.exe ? `<div class="k" style="color:var(--muted);font-size:12px">Location</div><div class="mono">${esc(d.exe)}</div>` : ''}
      ${d.cmd ? `<div class="k" style="color:var(--muted);font-size:12px;margin-top:8px">Command line <span class="link" data-copy>copy</span></div><div class="mono">${esc(d.cmd)}</div>` : ''}`;
    drawSpark($('#dsCpu'), s.cpu, { max: Math.max(5, ...s.cpu) * 1.1, color: cssVar('--c1') });
    drawSpark($('#dsMem'), s.mem, { color: cssVar('--c2') });
    box._d = d;
  }
};

$('#procBody').addEventListener('click', async (e) => {
  const row = e.target.closest('.trow');
  if (!row) return;
  const x = row._item;
  const tw = e.target.closest('[data-tw]');
  if (tw) {
    if (x.type === 'app') { if (S.expanded.has(x.id)) S.expanded.delete(x.id); else S.expanded.add(x.id); } else if (S.collapsed.has(x.k)) S.collapsed.delete(x.k); else S.collapsed.add(x.k);
    VIEWS.processes.render();
    return;
  }
  const a = e.target.closest('[data-a]');
  if (a && !a.disabled) {
    const kind = x.type === 'app' ? 'app' : 'proc';
    if (a.dataset.a === 'end') { if (needsConfirm('end-' + x.id)) return; }
    await act(kind, x, a.dataset.a);
    return;
  }
  VIEWS.processes.select(x);
});
$('#procBody').addEventListener('dblclick', (e) => {
  const row = e.target.closest('.trow');
  if (!row || e.target.closest('[data-a]')) return;
  const x = row._item;
  if (x.type === 'app') { if (S.expanded.has(x.id)) S.expanded.delete(x.id); else S.expanded.add(x.id); VIEWS.processes.render(); }
});
$('#procBody').addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.trow');
  if (!row) return;
  e.preventDefault();
  const x = row._item;
  VIEWS.processes.select(x);
  showMenu(procMenu(x), e.clientX, e.clientY);
});

function procMenu(x) {
  const kind = x.type === 'app' ? 'app' : 'proc';
  const blocked = x.prot === 'blocked' || x.prot === 'self';
  const items = [{ header: x.display + (x.type === 'app' ? ` (${x.count} processes)` : ` · PID ${x.pid}`) }];
  items.push({ label: x.type === 'app' ? 'End all its processes' : 'End task', hint: 'Del', danger: true, disabled: blocked, fn: () => act(kind, x, 'end') });
  if (kind === 'proc') items.push({ label: 'End task and everything it started', danger: true, disabled: blocked, fn: () => act(kind, x, 'endtree') });
  items.push({ label: 'Restart', disabled: blocked, fn: () => act(kind, x, 'restart') });
  items.push(x.paused ? { label: 'Resume', fn: () => act(kind, x, 'resume') } : { label: 'Pause', disabled: x.noPause, title: x.noPause ? 'Pausing this would freeze your desktop' : '', fn: () => act(kind, x, 'pause') });
  items.push('-', { header: 'Priority' });
  for (const [k, v] of Object.entries(PRI)) if (k !== 'realtime') items.push({ label: v, disabled: x.prot === 'blocked', fn: () => act(kind, x, 'priority', { level: k }) });
  items.push('-');
  items.push({ label: 'Open file location', disabled: !x.exe, fn: () => act(kind, x, 'open') });
  items.push({ label: 'Search online', fn: () => act(kind, x, 'search') });
  if (kind === 'proc') items.push({ label: 'Copy name, path and command line', fn: () => act(kind, x, 'copy') });
  items.push({ label: 'Show in History', fn: () => { S.hist.only = [x.app]; setView('history'); } });
  items.push({ label: 'Make a rule for it…', fn: () => newRuleFor(x.name) });
  return items;
}

$('#procDetail').addEventListener('click', async (e) => {
  const d = $('#procDetail')._d;
  if (!d) return;
  const go = e.target.closest('[data-goto]');
  if (go) { S.procMode = S.procMode === 'apps' ? 'all' : S.procMode; S.sel = { type: 'proc', id: go.dataset.goto }; VIEWS.processes.render(); VIEWS.processes.detail(true); return; }
  if (e.target.closest('[data-copy]')) { await api.invoke('copy', { text: d.cmd }); toast('Copied the command line.'); return; }
  const b = e.target.closest('button[data-d]');
  if (!b || b.disabled) return;
  const sel = S.sel;
  const kind = sel.type === 'app' ? 'app' : 'proc';
  const target = kind === 'app' ? { app: sel.id, display: d.display } : { pid: d.pid, k: d.k, display: d.display };
  const a = b.dataset.d;
  if (a === 'rule') return newRuleFor(d.name);
  if ((a === 'end' || a === 'endtree') && needsConfirm('dend-' + sel.id)) { VIEWS.processes.renderDetail(d, sel); return; }
  await act(kind, target, a);
  VIEWS.processes.detail(true);
});
$('#procDetail').addEventListener('change', async (e) => {
  const s = e.target.closest('select[data-d="priority"]');
  if (!s || !s.value) return;
  const d = $('#procDetail')._d;
  const sel = S.sel;
  const kind = sel.type === 'app' ? 'app' : 'proc';
  await act(kind, kind === 'app' ? { app: sel.id, display: d.display } : { pid: d.pid, k: d.k, display: d.display }, 'priority', { level: s.value });
  s.value = '';
  VIEWS.processes.detail(true);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { hideMenu(); if (S.view === 'processes' && S.search) { S.search = ''; $('#procSearch').value = ''; VIEWS.processes.render(); } }
  if (S.view !== 'processes') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); $('#procSearch').focus(); $('#procSearch').select(); return; }
  if (e.target.matches('input, select, textarea')) return;
  const rows = VIEWS.processes.rows || [];
  const i = S.sel ? rows.findIndex((r) => r.type === S.sel.type && r.id === S.sel.id) : -1;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (n) { VIEWS.processes.select(n); const el = $(`#procBody [data-key="${CSS.escape(n.type + ':' + n.id)}"]`); if (el) el.scrollIntoView({ block: 'nearest' }); }
  }
  if (e.key === 'Delete' && i >= 0) {
    const x = rows[i];
    if (x.prot === 'blocked' || x.prot === 'self') return toast("Lookout won't end that one.", { err: true });
    const id = 'del-' + x.id;
    if (!armed(id)) { arm(id); toast(`Press Delete again to end ${x.display}.`); return; }
    S.armed = null;
    act(x.type === 'app' ? 'app' : 'proc', x, 'end');
  }
  if (e.key === 'ContextMenu' && i >= 0) {
    const el = $(`#procBody [data-key="${CSS.escape(rows[i].type + ':' + rows[i].id)}"]`);
    const r = el ? el.getBoundingClientRect() : { left: 200, bottom: 200 };
    showMenu(procMenu(rows[i]), r.left + 40, r.bottom);
  }
});

// ================================================================== Windows
VIEWS.windows = {
  enter() { this.load(); clearInterval(this.timer); this.timer = setInterval(() => this.load(), 3000); },
  leave() { clearInterval(this.timer); },
  async load() {
    const r = await api.invoke('windows:list', { invisible: $('#winInvisible').checked });
    if (!r || !r.windows) return;
    this.list = r.windows;
    this.render();
  },
  lostReason(w) {
    if (w.ours) return 'Hidden by Lookout';
    if (w.offscreen) return 'Off-screen';
    // Overlays (game bars, screen recorders) are see-through on purpose; only real app windows count.
    if (w.visible && w.alpha < 40 && (w.taskbar || w.appLike)) return 'Invisible (fully see-through)';
    if (w.visible && !w.minimized && w.taskbar && (w.w < 60 || w.h < 40)) return 'Too small to see';
    return null;
  },
  render() {
    const list = this.list || [];
    const q = lc(S.winSearch);
    const ok = (w) => !q || lc(w.title).includes(q) || lc(w.appName).includes(q) || lc(w.exe).includes(q);
    const lost = list.filter((w) => this.lostReason(w) && ok(w));
    const normal = list.filter((w) => !this.lostReason(w) && w.visible && (w.taskbar || w.appLike) && ok(w));
    const tools = list.filter((w) => !this.lostReason(w) && w.visible && !w.taskbar && !w.appLike && ok(w));
    const invisible = list.filter((w) => !w.visible && !w.ours && ok(w));
    const badge = list.filter((w) => this.lostReason(w)).length;
    $('#lostBadge').hidden = !badge;
    $('#lostBadge').textContent = badge;
    const card = (w, lostWhy) => {
      const tags = [];
      if (lostWhy) tags.push(`<span class="tag warn">${esc(lostWhy)}</span>`);
      if (w.minimized) tags.push('<span class="tag sys">Minimised</span>');
      if (w.maximized) tags.push('<span class="tag sys">Maximised</span>');
      if (w.topmost) tags.push('<span class="tag focus">Always on top</span>');
      if (w.hung) tags.push('<span class="tag hung">Not responding</span>');
      if (w.visible && w.alpha < 250 && w.alpha >= 40) tags.push(`<span class="tag paused">${Math.round(w.alpha / 2.55)}% visible</span>`);
      const pct = Math.round(w.alpha / 2.55);
      const acts = lostWhy || !w.visible
        ? `<button class="btn small primary" data-w="${w.ours ? 'show' : 'bringback'}">${w.ours ? 'Show' : 'Bring it back'}</button>`
        : `<button class="btn small" data-w="focus">Switch to</button>
           <button class="ib" data-w="minimize" title="Minimise">–</button>
           <button class="ib ${w.topmost ? 'armed' : ''}" data-w="topmost" title="Always on top">📌</button>
           <select class="btn small" data-w="opacity" title="See-through">${[100, 90, 75, 60, 40].map((v) => `<option value="${v}" ${Math.abs(v - pct) < 6 ? 'selected' : ''}>${v}%</option>`).join('')}</select>
           <button class="btn small" data-w="hide" title="Hide it without closing (the app keeps running)">Hide</button>
           <button class="btn small danger" data-w="close">Close</button>`;
      return `<div class="win ${lostWhy ? 'lost' : ''}" data-id="${w.id}">
        <div style="min-width:0"><div class="wt">${esc(w.title || '(no title)')}</div>
        <div class="ws">${iconHtml(w.exe)}<span>${esc(w.appName)}</span>${w.pid ? `<span>· PID ${w.pid}</span>` : ''}${tags.join('')}</div></div>
        <div class="wa">${acts}</div></div>`;
    };
    $('#lostWins').innerHTML = lost.length ? `<div class="lost-box"><h3>Lost windows <span class="tag warn">${lost.length}</span></h3><p class="hint">These windows are open but you can't see them. "Bring it back" shows them in the middle of your main screen.</p><div class="cards">${lost.map((w) => card(w, this.lostReason(w))).join('')}</div></div>` : '';
    $('#winList').innerHTML = (normal.length ? normal.map((w) => card(w)).join('') : '<div class="empty">No windows match.</div>') +
      (tools.length ? `<h3 class="section">Small tool and overlay windows</h3>${tools.map((w) => card(w)).join('')}` : '') +
      (invisible.length ? `<h3 class="section">Invisible windows (${invisible.length})</h3><p class="hint">Apps keep many hidden windows for their own use. Showing one is safe, but it may look odd. Use this when an app is running but you can't find its window.</p>${invisible.map((w) => card(w, null)).join('')}` : '');
  }
};
$('#winInvisible').addEventListener('change', () => VIEWS.windows.load());
$('#winSearch').addEventListener('input', (e) => { S.winSearch = e.target.value; VIEWS.windows.render(); });
async function winClick(e) {
  const b = e.target.closest('[data-w]');
  if (!b || b.tagName === 'SELECT') return;
  const id = +b.closest('.win').dataset.id;
  const a = b.dataset.w;
  const r = await api.invoke('win:action', { id, action: a, arg: a === 'topmost' ? -1 : undefined });
  if (!r || !r.ok) toast((r && r.reason) || "That window didn't respond.", { err: true });
  else if (a === 'hide') toast('Hidden. The app is still running; find it under Lost windows to show it again.');
  else if (a === 'bringback') toast('Brought it back to the middle of your screen.');
  setTimeout(() => VIEWS.windows.load(), 250);
}
$('#winList').addEventListener('click', winClick);
$('#lostWins').addEventListener('click', winClick);
$('#winList').addEventListener('change', async (e) => {
  const s = e.target.closest('select[data-w="opacity"]');
  if (!s) return;
  await api.invoke('win:action', { id: +s.closest('.win').dataset.id, action: 'opacity', arg: +s.value });
  setTimeout(() => VIEWS.windows.load(), 200);
});

// ================================================================== Network
VIEWS.network = {
  enter() { this.load(); clearInterval(this.timer); this.timer = setInterval(() => this.load(), 3000); },
  leave() { clearInterval(this.timer); },
  tick() { this.meters(); },
  async load() {
    const r = await api.invoke('net:list');
    if (!r || !r.ok) return;
    this.data = r;
    this.render();
  },
  meters() {
    const t = S.tick;
    if (!t) return;
    const box = $('#netMeters');
    if (box.children.length !== 2) box.innerHTML = '<div class="meter"><div class="k"><span>Download</span><span></span></div><div class="v"></div><canvas></canvas></div><div class="meter"><div class="k"><span>Upload</span><span></span></div><div class="v"></div><canvas></canvas></div>';
    box.children[0].querySelector('.v').textContent = fmtRate(t.rx);
    box.children[1].querySelector('.v').textContent = fmtRate(t.tx);
    drawSpark(box.children[0].querySelector('canvas'), S.netSpark.rx, { color: cssVar('--c2') });
    drawSpark(box.children[1].querySelector('canvas'), S.netSpark.tx, { color: cssVar('--c3') });
  },
  render() {
    this.meters();
    const r = this.data;
    if (!r) return;
    $('#netBanner').innerHTML = r.perApp ? '' : S.platform === 'win32'
      ? '<div class="banner"><span>Windows only shares how fast each app is downloading with administrator programs. You can still see every app\'s connections below.</span><button class="btn primary" data-admin>Restart as administrator</button></div>'
      : '<div class="banner"><span>Per-app network speed isn\'t available on Linux yet. Connections for your own apps are shown below (run with sudo to see everyone\'s).</span></div>';
    const q = lc(S.netSearch);
    let apps = r.apps.filter((a) => a.established || a.listening || a.udp);
    if (q) apps = apps.filter((a) => lc(a.name).includes(q) || a.conns.some((c) => lc(c.host).includes(q) || c.ra.includes(q) || String(c.rp) === q || String(c.lp) === q));
    apps.sort((a, b) => (b.in + b.out) - (a.in + a.out) || b.established - a.established || b.listening - a.listening);
    const body = $('#netBody');
    body.innerHTML = apps.map((a) => {
      const open = S.netOpen.has(a.app);
      const est = a.conns.filter((c) => c.state !== 'listening' && c.proto.startsWith('tcp') && c.state === 'established');
      const rest = a.conns.filter((c) => !est.includes(c));
      const conns = open ? `<div class="conns">${[...est, ...rest].map((c) => `<div class="conn"><span class="h" title="${esc(c.host)}">${esc(c.state === 'listening' ? 'Listening for connections' : c.host || c.ra || '–')}</span><span class="mono">${c.state === 'listening' || !c.rp ? esc(c.la) + ':' + c.lp : esc(c.ra) + ':' + c.rp}</span><span>${c.state === 'listening' ? 'port ' + c.lp : esc(c.state || '')}</span><span class="sub2">local ${c.lp}</span><span class="sub2">${esc(c.proto)}</span></div>`).join('')}</div>` : '';
      return `<div class="trow net-cols net-row" data-app="${esc(a.app)}"><span class="name"><span class="tw">${open ? '▾' : '▸'}</span>${iconHtml(a.exe)}<span class="nm">${esc(a.name)}</span><span class="sub2">${a.pids.length > 1 ? a.pids.length + ' processes' : a.pids[0] ? 'PID ' + a.pids[0] : ''}</span></span>
        <span class="r">${a.established || ''}</span><span class="r">${a.listening ? a.listening + ' port' + (a.listening > 1 ? 's' : '') : ''}</span>
        <span class="r">${r.perApp ? fmtRate(a.in) : '–'}</span><span class="r">${r.perApp ? fmtRate(a.out) : '–'}</span></div>${conns}`;
    }).join('') || '<div class="empty">No connections right now.</div>';
  }
};
$('#netBody').addEventListener('click', (e) => {
  const row = e.target.closest('.net-row');
  if (!row) return;
  const k = row.dataset.app;
  if (S.netOpen.has(k)) S.netOpen.delete(k); else S.netOpen.add(k);
  VIEWS.network.render();
});
$('#netSearch').addEventListener('input', (e) => { S.netSearch = e.target.value; VIEWS.network.render(); });
document.addEventListener('click', async (e) => {
  if (!e.target.closest('[data-admin]')) return;
  const r = await api.invoke('admin:restart');
  if (!r.ok) toast(r.reason, { err: true });
});

// ================================================================== History
const UNIT = { cpu: (v) => fmtPct(v), mem: (v) => fmtBytes(v), io: (v) => fmtRate(v), net: (v) => fmtRate(v) };
VIEWS.history = {
  enter() { this.load(); clearInterval(this.timer); this.timer = setInterval(() => { if (!S.hist.hover) this.load(); }, 4000); },
  leave() { clearInterval(this.timer); },
  async load() {
    const h = S.hist;
    $$('#histMetric button').forEach((b) => b.classList.toggle('on', b.dataset.m === h.metric));
    $$('#histRange button').forEach((b) => b.classList.toggle('on', +b.dataset.r === h.range));
    $$('#evFilter button').forEach((b) => b.classList.toggle('on', b.dataset.f === h.evFilter));
    const [data, events] = await Promise.all([
      api.invoke('history:timeline', { metric: h.metric, minutes: h.range, only: h.only || null }),
      api.invoke('history:events', { from: Date.now() - h.range * 60000, to: Date.now() })
    ]);
    if (h.metric === 'mem' && S.tick) data.system = data.system.map((v) => v / 100 * S.tick.memTotal);
    h.data = data;
    h.events = events;
    this.draw();
    this.renderEvents();
  },
  draw() {
    const h = S.hist, d = h.data;
    const cv = $('#histChart');
    const { g, w, hgt = cv.clientHeight } = setupCanvas(cv);
    const H = hgt;
    const pad = { l: 58, r: 12, t: 10, b: 24 };
    const cw = w - pad.l - pad.r, ch = H - pad.t - pad.b;
    const colors = COLORS();
    if (!d || d.t.length < 2) {
      g.fillStyle = cssVar('--muted'); g.font = '13px Segoe UI, sans-serif'; g.fillText('Collecting history… come back in a minute.', pad.l, pad.t + 30);
      $('#histLegend').innerHTML = '';
      return;
    }
    const visible = d.series.filter((s) => !h.hidden.has(s.key));
    let max = h.metric === 'cpu' ? 100 : Math.max(1, ...d.system, ...visible.flatMap((s) => s.values)) * 1.1;
    if (h.metric === 'cpu' && !h.hidden.has('__sys')) max = 100;
    const t0 = d.t[0], t1 = d.t[d.t.length - 1];
    const X = (t) => pad.l + (t - t0) / Math.max(1, t1 - t0) * cw;
    const Y = (v) => pad.t + ch - Math.min(1, v / max) * ch;
    this.geom = { X, Y, pad, cw, ch, t0, t1 };
    // grid
    g.strokeStyle = cssVar('--line'); g.lineWidth = 1; g.fillStyle = cssVar('--muted'); g.font = '11px Segoe UI, sans-serif';
    for (let i = 0; i <= 4; i++) {
      const v = max / 4 * i, y = Y(v);
      g.beginPath(); g.moveTo(pad.l, y); g.lineTo(w - pad.r, y); g.stroke();
      g.textAlign = 'right'; g.fillText(UNIT[h.metric](v), pad.l - 6, y + 4);
    }
    g.textAlign = 'center';
    const ticks = 6;
    const fmtT = t1 - t0 < 10 * 60000 ? clock : shortClock;
    for (let i = 0; i <= ticks; i++) { const t = t0 + (t1 - t0) / ticks * i; g.fillText(fmtT(t), X(t), H - 6); }
    // system total as an area
    if (!h.hidden.has('__sys')) {
      g.beginPath();
      d.t.forEach((t, i) => (i ? g.lineTo(X(t), Y(d.system[i])) : g.moveTo(X(t), Y(d.system[i]))));
      g.lineTo(X(t1), Y(0)); g.lineTo(X(t0), Y(0)); g.closePath();
      g.fillStyle = cssVar('--panel2'); g.fill();
      g.strokeStyle = cssVar('--faint'); g.lineWidth = 1; g.stroke();
    }
    d.series.forEach((s, si) => {
      if (h.hidden.has(s.key)) return;
      g.beginPath();
      d.t.forEach((t, i) => (i ? g.lineTo(X(t), Y(s.values[i])) : g.moveTo(X(t), Y(s.values[i]))));
      g.strokeStyle = colors[si % colors.length]; g.lineWidth = 1.8; g.stroke();
    });
    // markers for things Lookout or you did
    for (const e of h.events || []) {
      if (!['kill', 'rule', 'pause', 'resume', 'priority', 'focus', 'relaunch'].includes(e.type) || e.t < t0) continue;
      const x = X(e.t);
      g.fillStyle = e.type === 'kill' ? cssVar('--bad') : cssVar('--accent');
      g.beginPath(); g.moveTo(x, pad.t + ch); g.lineTo(x - 4, pad.t + ch + 7); g.lineTo(x + 4, pad.t + ch + 7); g.closePath(); g.fill();
    }
    // hover / pinned line
    const mark = h.hover || h.pinned;
    if (mark) {
      const x = X(mark.t);
      g.strokeStyle = cssVar('--accent'); g.setLineDash([4, 3]); g.beginPath(); g.moveTo(x, pad.t); g.lineTo(x, pad.t + ch); g.stroke(); g.setLineDash([]);
    }
    const sysLabel = { cpu: 'Whole PC', mem: 'Whole PC', io: 'All apps', net: 'Whole PC' }[h.metric];
    $('#histLegend').innerHTML = `<button data-key="__sys" class="${h.hidden.has('__sys') ? 'off' : ''}"><i style="background:${cssVar('--faint')}"></i>${sysLabel}</button>` +
      d.series.map((s, i) => `<button data-key="${esc(s.key)}" class="${h.hidden.has(s.key) ? 'off' : ''}"><i style="background:${colors[i % colors.length]}"></i>${esc(S.names[s.key] || s.name)} <span style="color:var(--muted)">peak ${UNIT[h.metric](s.peak)}</span></button>`).join('') +
      (h.only ? '<button data-key="__all" style="color:var(--accent)">Show the top apps again</button>' : '');
  },
  indexAt(clientX) {
    const d = S.hist.data, gm = this.geom;
    if (!d || !gm) return -1;
    const rect = $('#histChart').getBoundingClientRect();
    const x = clientX - rect.left;
    const t = gm.t0 + (x - gm.pad.l) / gm.cw * (gm.t1 - gm.t0);
    let best = 0;
    for (let i = 0; i < d.t.length; i++) if (Math.abs(d.t[i] - t) < Math.abs(d.t[best] - t)) best = i;
    return best;
  },
  renderEvents() {
    const h = S.hist;
    const ICON = { start: '▶', exit: '■', kill: '✕', rule: '⚡', pause: '❚❚', resume: '▶', priority: '↕', focus: '◎', relaunch: '↻', window: '▢', recover: '✓' };
    const ACTIONS = ['kill', 'rule', 'pause', 'resume', 'priority', 'focus', 'relaunch', 'window', 'recover'];
    const list = (h.events || []).filter((e) => h.evFilter === 'all' || (h.evFilter === 'actions' ? ACTIONS.includes(e.type) : e.type === h.evFilter)).slice(-300).reverse();
    $('#events').innerHTML = list.map((e) => `<div class="ev"><span class="tm">${clock(e.t)}</span><span>${ICON[e.type] || '•'}</span><span>${esc(e.text || (e.type === 'start' ? `${e.name} started` : e.type === 'exit' ? `${e.name} ended` : e.type))}${e.pid && (e.type === 'start' || e.type === 'exit') ? ` <span style="color:var(--muted)">PID ${e.pid}</span>` : ''}</span></div>`).join('') ||
      `<div class="empty">${h.evFilter === 'actions' ? 'Nothing has been ended, paused or changed in this time.' : 'Nothing yet.'}</div>`;
  },
  async pin(t) {
    const h = S.hist;
    h.pinned = { t };
    const r = await api.invoke('history:at', { t, metric: h.metric });
    const sys = h.metric === 'mem' && S.tick ? r.system / 100 * S.tick.memTotal : r.system;
    $('#momentTitle').textContent = `At ${clock(r.t)} (${ago(r.t)})`;
    const max = Math.max(1, ...r.items.map((i) => i.value));
    $('#moment').innerHTML = `<div class="mrow"><b>${{ cpu: 'Whole PC', mem: 'Whole PC', io: 'All apps', net: 'Whole PC' }[h.metric]}</b><span class="r"><b>${UNIT[h.metric](sys)}</b></span></div>` +
      r.items.map((i) => `<div class="mrow"><div>${esc(S.names[i.key] || i.name)}<div class="mbar"><i style="width:${(i.value / max * 100).toFixed(1)}%"></i></div></div><span class="r">${UNIT[h.metric](i.value)}</span></div>`).join('');
    this.draw();
  }
};
$('#histMetric').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S.hist.metric = b.dataset.m; S.hist.hidden.clear(); S.hist.pinned = null; VIEWS.history.load(); });
$('#histRange').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S.hist.range = +b.dataset.r; VIEWS.history.load(); });
$('#evFilter').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S.hist.evFilter = b.dataset.f; $$('#evFilter button').forEach((x) => x.classList.toggle('on', x === b)); VIEWS.history.renderEvents(); });
$('#histLegend').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const k = b.dataset.key;
  if (k === '__all') { S.hist.only = null; VIEWS.history.load(); return; }
  if (S.hist.hidden.has(k)) S.hist.hidden.delete(k); else S.hist.hidden.add(k);
  VIEWS.history.draw();
});
$('#histChart').addEventListener('mousemove', (e) => {
  const h = S.hist, d = h.data;
  const i = VIEWS.history.indexAt(e.clientX);
  if (i < 0) return;
  h.hover = { t: d.t[i] };
  VIEWS.history.draw();
  const colors = COLORS();
  const tip = $('#histTip');
  const items = d.series.map((s, si) => ({ s, si, v: s.values[i] })).filter((x) => !h.hidden.has(x.s.key)).sort((a, b) => b.v - a.v);
  tip.innerHTML = `<div class="tt">${clock(d.t[i])}</div><div class="ti"><span>Whole PC</span><b>${UNIT[h.metric](d.system[i])}</b></div>` +
    items.map((x) => `<div class="ti"><span><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${colors[x.si % colors.length]};margin-right:5px"></i>${esc(S.names[x.s.key] || x.s.name)}</span><span>${UNIT[h.metric](x.v)}</span></div>`).join('') +
    '<div class="tt" style="margin:4px 0 0">Click to see every app at this moment</div>';
  tip.hidden = false;
  const card = $('.chart-card').getBoundingClientRect();
  let left = e.clientX - card.left + 16;
  if (left + 240 > card.width) left = e.clientX - card.left - 250;
  tip.style.left = left + 'px';
  tip.style.top = Math.max(8, e.clientY - card.top - 40) + 'px';
});
$('#histChart').addEventListener('mouseleave', () => { S.hist.hover = null; $('#histTip').hidden = true; VIEWS.history.draw(); });
$('#histChart').addEventListener('click', (e) => { const i = VIEWS.history.indexAt(e.clientX); if (i >= 0) VIEWS.history.pin(S.hist.data.t[i]); });
window.addEventListener('resize', () => { if (S.view === 'history') VIEWS.history.draw(); });

// ================================================================== Rules
function describeRule(r) {
  const who = !r.target || r.target.trim() === '*' ? 'any app' : r.target;
  const mem = (v) => (v >= 1024 ? (v / 1024).toFixed(v % 1024 ? 1 : 0) + ' GB' : v + ' MB');
  const cond = { cpu: `uses more than <b>${r.value}% CPU</b>` + (r.seconds ? ` for <b>${r.seconds} s</b>` : ''), mem: `uses more than <b>${mem(r.value)}</b> of memory`,
    hung: 'stops responding' + (r.seconds ? ` for <b>${r.seconds} s</b>` : ''), start: 'starts', while: `is running while <b>${esc(r.whileApp || '?')}</b> is running` }[r.cond] || r.cond;
  const act = { notify: '<b>tell me</b>', priority: `set its priority to <b>${PRI[r.level] || 'Normal'}</b>` + (r.cond === 'while' ? ' (and put it back afterwards)' : ''),
    pause: r.cond === 'while' ? '<b>pause it</b> (and resume it afterwards)' : '<b>pause it</b>', end: '<b>end it</b>' }[r.action] || r.action;
  return `When <b>${esc(who)}</b> ${cond}, ${act}.`;
}
const PRESETS = [
  { t: 'Warn me about memory hogs', d: 'A notification when any app goes over 2 GB.', r: { target: '*', cond: 'mem', value: 2048, action: 'notify' } },
  { t: 'Tame CPU hogs', d: 'Any app over 50% CPU for 2 minutes gets Low priority.', r: { target: '*', cond: 'cpu', value: 50, seconds: 120, action: 'priority', level: 'idle' } },
  { t: 'Auto-close frozen apps', d: 'End an app that hasn\'t responded for 2 minutes (you can relaunch it).', r: { target: '*', cond: 'hung', seconds: 120, action: 'end' } },
  { t: 'Quiet Discord while streaming', d: 'Lower Discord while OBS is open, put it back after.', r: { target: 'discord.exe', cond: 'while', whileApp: 'obs64.exe', action: 'priority', level: 'idle' } },
  { t: 'Pause OneDrive while gaming', d: 'Pause OneDrive while a game runs, resume it after.', r: { target: 'onedrive.exe', cond: 'while', whileApp: 'game.exe', action: 'pause' } },
  { t: 'Always fast', d: 'Start an app at High priority every time.', r: { target: 'game.exe', cond: 'start', action: 'priority', level: 'high' } }
];
async function saveRules(list) {
  const r = await api.invoke('rules:set', { rules: list });
  if (r && r.ok) S.rules = r.rules;
  VIEWS.rules.render();
}
function newRuleFor(name) {
  S.editing = { id: null, enabled: true, target: name || '*', cond: 'cpu', value: 50, seconds: 60, whileApp: '', action: 'notify', level: 'idle' };
  setView('rules');
}
VIEWS.rules = {
  enter() { this.render(); },
  render() {
    $('#ruleList').innerHTML = S.rules.length ? S.rules.map((r) => `<div class="rule ${r.enabled ? '' : 'off'}" data-id="${esc(r.id)}">
      <label class="toggle"><input type="checkbox" data-r="toggle" ${r.enabled ? 'checked' : ''}><i></i></label>
      <div class="sentence">${describeRule(r)}</div>
      <div style="display:flex;gap:6px"><button class="btn small" data-r="edit">Edit</button><button class="btn small danger ${armed('rd-' + r.id) ? 'armed' : ''}" data-r="delete">${armed('rd-' + r.id) ? 'Sure?' : 'Delete'}</button></div></div>`).join('')
      : '<div class="empty">No rules yet. Pick an idea below or make your own.</div>';
    $('#rulePresets').innerHTML = PRESETS.map((p, i) => `<button class="preset" data-p="${i}"><b>${esc(p.t)}</b><span>${esc(p.d)}</span></button>`).join('');
    this.editor();
  },
  editor() {
    const e = S.editing;
    const box = $('#ruleEditor');
    if (!e) { box.innerHTML = ''; return; }
    const apps = S.tick ? [...new Set(S.tick.procs.map((p) => p.name))].sort((a, b) => a.localeCompare(b)) : [];
    const showVal = e.cond === 'cpu' || e.cond === 'mem';
    const showSec = e.cond === 'cpu' || e.cond === 'hung';
    const acts = e.cond === 'while' ? ['priority', 'pause', 'notify'] : ['notify', 'priority', 'pause', 'end'];
    if (!acts.includes(e.action)) e.action = acts[0];
    box.innerHTML = `<div class="card editor"><h3>${e.id ? 'Edit rule' : 'New rule'}</h3>
      <datalist id="appNames">${apps.map((a) => `<option value="${esc(a)}">`).join('')}</datalist>
      <div class="grid">
        <label>App (name, *, or a list)<input data-e="target" list="appNames" value="${esc(e.target)}" placeholder="chrome.exe, discord*"></label>
        <label>When it…<select data-e="cond">${[['cpu', 'uses a lot of CPU'], ['mem', 'uses a lot of memory'], ['hung', 'stops responding'], ['start', 'starts'], ['while', 'runs while another app runs']].map(([v, l]) => `<option value="${v}" ${e.cond === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        ${showVal ? `<label>${e.cond === 'cpu' ? 'More than (% CPU)' : 'More than (MB)'}<input data-e="value" type="number" min="1" value="${esc(e.value)}"></label>` : ''}
        ${showSec ? `<label>For at least (seconds)<input data-e="seconds" type="number" min="0" value="${esc(e.seconds)}"></label>` : ''}
        ${e.cond === 'while' ? `<label>Other app<input data-e="whileApp" list="appNames" value="${esc(e.whileApp)}" placeholder="obs64.exe"></label>` : ''}
        <label>Then<select data-e="action">${acts.map((v) => `<option value="${v}" ${e.action === v ? 'selected' : ''}>${{ notify: 'Tell me', priority: 'Change its priority', pause: 'Pause it', end: 'End it' }[v]}</option>`).join('')}</select></label>
        ${e.action === 'priority' ? `<label>Priority<select data-e="level">${Object.entries(PRI).filter(([k]) => k !== 'realtime').map(([k, v]) => `<option value="${k}" ${e.level === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>` : ''}
      </div>
      <div class="preview">${describeRule(e)}</div>
      ${e.action === 'end' ? '<p class="hint">Ended apps appear in Recently ended, so you can start them again. Lookout never ends system processes with a rule.</p>' : ''}
      <div class="row"><button class="btn primary" data-e="save">Save rule</button><button class="btn" data-e="cancel">Cancel</button></div></div>`;
  }
};
$('#addRule').addEventListener('click', () => newRuleFor('*'));
$('#rulePresets').addEventListener('click', (e) => {
  const b = e.target.closest('[data-p]');
  if (!b) return;
  S.editing = { id: null, enabled: true, value: 0, seconds: 0, whileApp: '', level: 'idle', ...PRESETS[+b.dataset.p].r };
  VIEWS.rules.editor();
  window.scrollTo(0, 0);
  $('#v-rules').scrollTop = 0;
});
$('#ruleEditor').addEventListener('input', (e) => {
  const f = e.target.closest('[data-e]');
  if (!f || !S.editing) return;
  S.editing[f.dataset.e] = f.type === 'number' ? Number(f.value) : f.value;
  if (f.tagName === 'SELECT') VIEWS.rules.editor(); else $('#ruleEditor .preview').innerHTML = describeRule(S.editing);
});
$('#ruleEditor').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-e]');
  if (!b) return;
  if (b.dataset.e === 'cancel') { S.editing = null; VIEWS.rules.editor(); return; }
  const r = { ...S.editing };
  if (!String(r.target || '').trim()) return toast('Type an app name, or * for any app.', { err: true });
  if (r.cond === 'while' && !String(r.whileApp || '').trim()) return toast('Type the other app\'s name.', { err: true });
  const list = S.rules.slice();
  const i = r.id ? list.findIndex((x) => x.id === r.id) : -1;
  if (i >= 0) list[i] = r; else list.push(r);
  S.editing = null;
  await saveRules(list);
  toast('Rule saved.');
});
$('#ruleList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-r]');
  if (!b) return;
  const id = b.closest('.rule').dataset.id;
  const rule = S.rules.find((r) => r.id === id);
  if (b.dataset.r === 'edit') { S.editing = { ...rule }; VIEWS.rules.editor(); $('#v-rules').scrollTop = 0; }
  if (b.dataset.r === 'delete') { if (needsConfirm('rd-' + id) && S.settings.confirmEnd) return; await saveRules(S.rules.filter((r) => r.id !== id)); }
});
$('#ruleList').addEventListener('change', async (e) => {
  const c = e.target.closest('[data-r="toggle"]');
  if (!c) return;
  const id = c.closest('.rule').dataset.id;
  await saveRules(S.rules.map((r) => (r.id === id ? { ...r, enabled: c.checked } : r)));
});

// ================================================================== Focus mode
VIEWS.focus = {
  async enter() { this.cands = await api.invoke('focus:candidates'); this.render(); },
  tick() { if (S.focus.active) this.render(); },
  render() {
    const f = S.focus;
    const box = $('#focusBody');
    if (f.active) {
      box.innerHTML = `<div class="card focus-on"><div class="ring"></div><div class="big">Focusing on ${esc(f.name)}</div>
        <div class="sub">Since ${shortClock(f.started)}. ${f.boosted ? 'It runs at High priority. ' : ''}${f.lowered} background app${f.lowered === 1 ? '' : 's'} lowered, ${f.paused} paused.</div>
        <div class="changes">${(f.items || []).map((i) => `<span class="chip ${i.paused ? 'warn' : i.boosted ? 'on' : ''}">${esc(i.name)} · ${i.paused ? 'paused' : i.boosted ? 'boosted' : 'lowered'}</span>`).join('')}</div>
        <button class="btn primary" id="focusStop">Stop focus mode and put everything back</button></div>`;
      $('#focusStop').onclick = async () => { await api.invoke('focus:stop'); S.focus = { active: false }; toast('Focus mode is off. Everything is back to how it was.'); this.enter(); };
      return;
    }
    const cands = this.cands || [];
    if (!S.focusPick || !cands.some((c) => c.app === S.focusPick)) S.focusPick = (cands.find((c) => c.windows) || cands[0] || {}).app;
    if (!this.prefsLoaded) { (S.focusPrefs.pause || []).forEach((a) => S.focusPause.add(a)); this.prefsLoaded = true; }
    const withWin = cands.filter((c) => c.windows);
    const pausable = cands.filter((c) => c.app !== S.focusPick && c.canPause).slice(0, 40);
    box.innerHTML = `<div class="card">
      <h3>1. What do you want to focus on?</h3>
      <div class="pick" id="fPick">${withWin.map((c) => `<label class="${c.app === S.focusPick ? 'on' : ''}" data-app="${esc(c.app)}"><input type="radio" name="fapp" ${c.app === S.focusPick ? 'checked' : ''} hidden>${iconHtml(c.exe)}<span>${esc(c.name)}</span><small>${fmtPct(c.cpu)}</small></label>`).join('') || '<div class="empty">Open the app you want to focus on first.</div>'}</div>
      <h3>2. What should Lookout do?</h3>
      <div class="opts">
        <label class="check"><input type="checkbox" id="fBoost" ${S.focusPrefs.boost !== false ? 'checked' : ''}> Give it High priority, so it wins when apps compete for the CPU</label>
        <label class="check"><input type="checkbox" id="fLower" ${S.focusPrefs.lower !== false ? 'checked' : ''}> Set any background app that keeps using CPU to Low priority (including ones that start later)</label>
      </div>
      <h3>3. Pause these apps completely while you focus (optional)</h3>
      <p class="hint">Paused apps use no CPU and stop syncing or downloading until focus mode ends. Don't pause apps you still need, like voice chat.</p>
      <div class="pick" id="fPause">${pausable.map((c) => `<label class="${S.focusPause.has(c.app) ? 'on' : ''}" data-app="${esc(c.app)}"><input type="checkbox" ${S.focusPause.has(c.app) ? 'checked' : ''} hidden>${iconHtml(c.exe)}<span>${esc(c.name)}</span><small>${fmtBytes(c.mem)}</small></label>`).join('')}</div>
      <button class="btn primary" id="focusStart" ${S.focusPick ? '' : 'disabled'}>Start focus mode</button></div>`;
    $('#fPick').onclick = (e) => { const l = e.target.closest('label[data-app]'); if (!l) return; e.preventDefault(); S.focusPick = l.dataset.app; S.focusPause.delete(S.focusPick); this.render(); };
    $('#fPause').onclick = (e) => { const l = e.target.closest('label[data-app]'); if (!l) return; e.preventDefault(); const a = l.dataset.app; if (S.focusPause.has(a)) S.focusPause.delete(a); else S.focusPause.add(a); this.render(); };
    $('#fBoost').onchange = (e) => { S.focusPrefs.boost = e.target.checked; };
    $('#fLower').onchange = (e) => { S.focusPrefs.lower = e.target.checked; };
    $('#focusStart').onclick = async () => {
      const r = await api.invoke('focus:start', { app: S.focusPick, boost: $('#fBoost').checked, lower: $('#fLower').checked, pause: [...S.focusPause] });
      S.focus = r;
      toast(`Focus mode is on for ${r.name}.`);
      this.render();
    };
  }
};

// ================================================================== Who's using
const drop = $('#drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const f = e.dataTransfer.files[0];
  if (!f) return;
  const p = api.pathForFile(f);
  if (p) { $('#filePath').value = p; checkFile(); }
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());
$('#pickFile').onclick = async () => { const p = await api.invoke('dialog:pick', { folder: false }); if (p) { $('#filePath').value = p; checkFile(); } };
$('#pickFolder').onclick = async () => { const p = await api.invoke('dialog:pick', { folder: true }); if (p) { $('#filePath').value = p; checkFile(); } };
$('#checkFile').onclick = () => checkFile();
$('#filePath').addEventListener('keydown', (e) => { if (e.key === 'Enter') checkFile(); });
function resultRows(list, kind) {
  return list.map((x) => {
    const id = kind + '-' + x.pid;
    const can = x.k && x.prot !== 'blocked' && x.prot !== 'self';
    return `<div class="rrow"><div><div class="name">${iconHtml(x.exe)}<b>${esc(x.display || x.name)}</b></div><div class="s">${esc(x.name)} · PID ${x.pid}${x.service ? ' · service ' + esc(x.service) : ''}${x.extra ? ' · ' + x.extra : ''}</div></div>
      <button class="btn small danger ${armed(id) ? 'armed' : ''}" data-end="${x.pid}" data-k="${esc(x.k || '')}" ${can ? '' : 'disabled'} title="${can ? '' : 'Lookout won\'t end system processes'}">${armed(id) ? 'Sure?' : 'End task'}</button></div>`;
  }).join('');
}
async function checkFile() {
  const p = $('#filePath').value.trim();
  if (!p) return;
  $('#fileResult').innerHTML = '<div class="empty">Checking…</div>';
  const r = await api.invoke('find:file', { path: p });
  if (!r.ok) { $('#fileResult').innerHTML = `<div class="notice bad">${esc(r.reason)}</div>`; return; }
  S.fileHits = r.procs;
  renderFileResult(r);
}
function renderFileResult(r) {
  r = r || { procs: S.fileHits, files: 0 };
  $('#fileResult').innerHTML = `<div class="result">${r.procs.length ? `<p class="hint">${r.procs.length} app${r.procs.length === 1 ? ' is' : 's are'} using it. Close ${r.procs.length === 1 ? 'it' : 'them'} normally if you can, or end ${r.procs.length === 1 ? 'it' : 'them'} here.</p>` + resultRows(r.procs, 'ff') : `<div class="notice" style="background:var(--good-soft);color:var(--good)">Nothing is using it${r.files > 1 ? ` (checked ${r.files} files)` : ''}. ${S.platform === 'linux' ? 'Only your own apps can be checked without sudo.' : ''}</div>`}</div>`;
}
$('#fileResult').addEventListener('click', (e) => endFromResult(e, 'ff', () => { renderFileResult(); }, checkFile));
const PORTS = [80, 443, 3000, 5173, 8080, 8000, 5000, 5432, 3306, 27017, 6379];
$('#portQuick').innerHTML = PORTS.map((p) => `<button class="chip" data-port="${p}">${p}</button>`).join('');
$('#portQuick').onclick = (e) => { const b = e.target.closest('[data-port]'); if (b) { $('#portNum').value = b.dataset.port; checkPort(); } };
$('#checkPort').onclick = () => checkPort();
$('#portNum').addEventListener('keydown', (e) => { if (e.key === 'Enter') checkPort(); });
async function checkPort() {
  const port = $('#portNum').value;
  const r = await api.invoke('find:port', { port });
  if (!r.ok) { $('#portResult').innerHTML = `<div class="notice bad">${esc(r.reason)}</div>`; return; }
  const by = new Map();
  for (const h of r.hits) {
    const e = by.get(h.pid) || { ...h, extra: [] };
    e.extra.push(h.local ? (h.state === 'listening' ? `listening on ${h.la}:${h.lp}` : `${h.proto} local port ${h.lp} → ${h.ra}:${h.rp} (${h.state || 'open'})`) : `connected to ${h.ra}:${h.rp} (${h.state || 'open'})`);
    by.set(h.pid, e);
  }
  const list = [...by.values()].map((x) => ({ ...x, extra: esc(x.extra.slice(0, 3).join('; ')) + (x.extra.length > 3 ? ` +${x.extra.length - 3} more` : '') }));
  S.portHits = list;
  $('#portResult').innerHTML = `<div class="result">${list.length ? resultRows(list, 'pp') : `<div class="notice" style="background:var(--good-soft);color:var(--good)">Port ${r.port} is free. Nothing is using it.</div>`}</div>`;
}
$('#portResult').addEventListener('click', (e) => endFromResult(e, 'pp', () => { $('#portResult .result').innerHTML = resultRows(S.portHits, 'pp'); }, checkPort));
async function endFromResult(e, kind, redraw, recheck) {
  const b = e.target.closest('[data-end]');
  if (!b || b.disabled) return;
  const id = kind + '-' + b.dataset.end;
  if (needsConfirm(id)) { redraw(); return; }
  await act('proc', { pid: +b.dataset.end, k: b.dataset.k, name: 'it' }, 'end');
  setTimeout(recheck, 600);
}

// ================================================================== Recently ended
VIEWS.recent = {
  enter() { this.render(); },
  render() {
    $('#recentBadge').hidden = !S.recent.length;
    $('#recentBadge').textContent = S.recent.length;
    $('#recentList').innerHTML = S.recent.length ? S.recent.map((r) => `<div class="rec" data-id="${esc(r.id)}">
      <div style="min-width:0"><div class="name">${iconHtml(r.exe)}<b>${esc(r.display)}</b><span class="s">${esc(r.name)}${r.count > 1 ? ` · ${r.count} processes` : ''} · ${r.how === 'rule' ? 'ended by a rule' : 'ended by you'} ${ago(r.t)}</span></div>
      ${r.launches.map((l) => `<div class="mono cmd">${esc(l.cmd)}</div>`).join('')}</div>
      <button class="btn primary" data-relaunch>Start it again</button></div>`).join('') : '<div class="empty">Nothing ended yet. When you end something, it shows up here so you can bring it back.</div>';
  }
};
$('#recentList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-relaunch]');
  if (!b) return;
  b.disabled = true;
  const r = await api.invoke('recent:relaunch', { id: b.closest('.rec').dataset.id });
  toast(r.ok ? 'Started it again.' : r.reason, { err: !r.ok });
  b.disabled = false;
});
$('#clearRecent').onclick = () => api.invoke('recent:clear');

// ================================================================== Settings
VIEWS.settings = {
  enter() { this.render(); },
  tick() { if (this.lastAdmin !== (S.tick && S.tick.admin)) this.render(); },
  render() {
    const s = S.settings;
    const admin = S.tick && S.tick.admin;
    this.lastAdmin = admin;
    const tog = (k) => `<label class="toggle"><input type="checkbox" data-s="${k}" ${s[k] ? 'checked' : ''}><i></i></label>`;
    $('#settingsBody').innerHTML = `
      <div class="set"><div><div class="k">Update every</div><div class="d">How often Lookout measures. Faster is smoother but uses a little more CPU.</div></div>
        <select class="btn" data-s="interval">${[1, 2, 5].map((v) => `<option value="${v}" ${+s.interval === v ? 'selected' : ''}>${v} second${v > 1 ? 's' : ''}</option>`).join('')}</select></div>
      <div class="set"><div><div class="k">Keep running in the tray when closed</div><div class="d">Rules, focus mode and history keep working in the background.</div></div>${tog('closeToTray')}</div>
      <div class="set"><div><div class="k">Notifications</div><div class="d">Used by rules that "tell me".</div></div>${tog('notifications')}</div>
      <div class="set"><div><div class="k">Ask before ending</div><div class="d">End buttons need a second click.</div></div>${tog('confirmEnd')}</div>
      ${S.platform === 'win32' ? `<div class="set"><div><div class="k">Start with Windows</div><div class="d">Starts quietly in the tray.</div></div>${tog('startWithOS')}</div>` : ''}
      <div class="set"><div><div class="k">Theme</div></div><select class="btn" data-s="theme">${['system', 'light', 'dark'].map((v) => `<option value="${v}" ${s.theme === v ? 'selected' : ''}>${v[0].toUpperCase() + v.slice(1)}</option>`).join('')}</select></div>
      <div class="set"><div><div class="k">Administrator</div><div class="d">${admin ? 'Lookout is running as administrator: it can see per-app network speed and control more processes.' : 'Without administrator rights Lookout can\'t see per-app network speed or control some system processes.'}</div></div>
        ${admin ? '<span class="chip on">On</span>' : '<button class="btn" data-admin>Restart as administrator</button>'}</div>
      <div class="set"><div><div class="k">Lookout ${esc(S.version || '')}</div><div class="d">Everything stays on this computer. Lookout never sends your data anywhere (network host names come from your own DNS).</div></div>
        <button class="btn ghost" data-ext="https://github.com/Playertxt/dockyard">Website</button></div>`;
  }
};
$('#settingsBody').addEventListener('change', async (e) => {
  const f = e.target.closest('[data-s]');
  if (!f) return;
  const k = f.dataset.s;
  const v = f.type === 'checkbox' ? f.checked : k === 'interval' ? Number(f.value) : f.value;
  const r = await api.invoke('settings:set', { [k]: v });
  S.settings = r.settings;
  applyTheme();
});
document.addEventListener('click', (e) => { const x = e.target.closest('[data-ext]'); if (x) api.invoke('open:external', { url: x.dataset.ext }); });

function applyTheme() {
  const t = S.settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  rerender();
}

// ================================================================== boot
(async function boot() {
  const init = await api.invoke('init');
  S.platform = init.platform;
  S.caps = init.caps;
  S.settings = init.settings;
  S.rules = init.rules;
  S.recent = init.recent;
  S.focus = init.focus;
  S.focusPrefs = init.focusPrefs || {};
  S.names = init.names || {};
  S.version = init.version;
  applyTheme();
  api.on('tick', onTick);
  api.on('names', (n) => { S.names = n; });
  api.on('toast', (t) => toast(t.text));
  api.on('focus', (f) => { S.focus = f; $('#focusBadge').hidden = !f.active; if (S.view === 'focus') VIEWS.focus.render(); });
  api.on('rules', (r) => { S.rules = r; if (S.view === 'rules') VIEWS.rules.render(); });
  api.on('recent', (r) => { S.recent = r; VIEWS.recent.render(); if (S.view !== 'recent') { $('#recentBadge').hidden = !r.length; $('#recentBadge').textContent = r.length; } });
  api.on('settings', (s) => { S.settings = s; applyTheme(); });
  api.on('navigate', (v) => setView(v));
  api.on('event', (e) => { if (S.view === 'history' && ['kill', 'rule', 'pause', 'resume', 'priority', 'focus', 'relaunch'].includes(e.type)) VIEWS.history.load(); });
  VIEWS.recent.render();
  const q = new URLSearchParams(location.search).get('view');
  setView(q || 'overview');
})();
