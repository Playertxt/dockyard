'use strict';
// Rules: "when <app> <condition>, <action>". Rules work on whole apps (all processes with the same name).
//
// rule = { id, enabled, target: 'chrome.exe, discord*' | '*', cond: 'cpu'|'mem'|'hung'|'start'|'while', value, seconds,
//          whileApp: 'obs64.exe', action: 'notify'|'priority'|'pause'|'end', level: 'idle'|'below'|'normal'|'above'|'high' }

function globToRegex(g) {
  const s = String(g).trim().toLowerCase().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + s + '$');
}

function matcher(pattern) {
  const parts = String(pattern || '*').split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length || parts.includes('*')) return () => true;
  const res = parts.map((p) => globToRegex(/\.\w+$|\*$/.test(p) ? p : p + '*'));
  return (name) => { const n = String(name || '').toLowerCase(); return res.some((r) => r.test(n)); };
}

function describeRule(r) {
  const who = !r.target || r.target.trim() === '*' ? 'any app' : r.target;
  const cond = {
    cpu: `uses more than ${r.value}% CPU` + (r.seconds ? ` for ${r.seconds} s` : ''),
    mem: `uses more than ${r.value >= 1024 ? (r.value / 1024).toFixed(r.value % 1024 ? 1 : 0) + ' GB' : r.value + ' MB'} of memory`,
    hung: 'stops responding' + (r.seconds ? ` for ${r.seconds} s` : ''),
    start: 'starts',
    while: `is running while ${r.whileApp || '?'} is running`
  }[r.cond] || r.cond;
  const lv = { idle: 'Low', below: 'Below normal', normal: 'Normal', above: 'Above normal', high: 'High' };
  const act = {
    notify: 'tell me',
    priority: `set its priority to ${lv[r.level] || 'Normal'}`,
    pause: r.cond === 'while' ? 'pause it (and resume it afterwards)' : 'pause it',
    end: 'end it'
  }[r.action] || r.action;
  return `When ${who} ${cond}, ${act}.`;
}

class RuleEngine {
  constructor() {
    this.rules = [];
    this.state = new Map(); // `${ruleId}|${app}` -> { since, fired, clearedAt }
    this.whileActive = new Map(); // ruleId -> Set of process keys we acted on
    this.seenApps = new Set();
    this.primed = false;
  }

  setRules(rules) {
    this.rules = (rules || []).map((r) => ({ ...r, _m: matcher(r.target), _w: r.whileApp ? matcher(r.whileApp) : null }));
    for (const id of [...this.whileActive.keys()]) if (!this.rules.some((r) => r.id === id && r.enabled)) this.whileActive.delete(id);
  }

  // Returns a list of actions: { rule, kind: 'notify'|'priority'|'pause'|'resume'|'end'|'restorePriority', app, name, procs, text }
  evaluate(snap) {
    const now = snap.t;
    const apps = new Map();
    for (const p of snap.procs) {
      if (p.self) continue;
      const a = apps.get(p.app) || { key: p.app, name: p.name, cpu: 0, mem: 0, hung: false, procs: [] };
      a.cpu += p.cpu; a.mem += Math.max(0, p.mem || 0); a.hung = a.hung || p.hung; a.procs.push(p);
      apps.set(p.app, a);
    }
    const started = new Set();
    for (const key of apps.keys()) if (!this.seenApps.has(key)) { if (this.primed) started.add(key); this.seenApps.add(key); }
    for (const key of [...this.seenApps]) if (!apps.has(key)) this.seenApps.delete(key);
    this.primed = true;

    const actions = [];
    for (const r of this.rules) {
      if (!r.enabled) continue;
      if (r.cond === 'while') { this._evalWhile(r, apps, actions); continue; }
      for (const a of apps.values()) {
        if (!r._m(a.name)) continue;
        const sk = r.id + '|' + a.key;
        let st = this.state.get(sk);
        if (!st) { st = { since: null, fired: false, clearedAt: 0 }; this.state.set(sk, st); }
        let hit = false;
        if (r.cond === 'cpu') hit = a.cpu > Number(r.value || 0);
        else if (r.cond === 'mem') hit = a.mem > Number(r.value || 0) * 2 ** 20;
        else if (r.cond === 'hung') hit = a.hung;
        else if (r.cond === 'start') hit = started.has(a.key);
        if (!hit) {
          if (st.fired && r.cond !== 'start') st.clearedAt = st.clearedAt || now;
          if (st.fired && st.clearedAt && now - st.clearedAt > 60000) st.fired = false;
          st.since = null;
          continue;
        }
        st.clearedAt = 0;
        if (st.since == null) st.since = now;
        const need = (r.cond === 'start' ? 0 : Number(r.seconds || 0)) * 1000;
        if (st.fired || now - st.since < need) continue;
        st.fired = true;
        actions.push({ rule: r, kind: r.action, level: r.level, app: a.key, name: a.name, procs: a.procs, text: describeRule(r) });
      }
    }
    for (const sk of [...this.state.keys()]) {
      const [rid, app] = sk.split('|');
      if (!apps.has(app) || !this.rules.some((r) => r.id === rid)) this.state.delete(sk);
    }
    return actions;
  }

  _evalWhile(r, apps, actions) {
    const trigger = [...apps.values()].some((a) => r._w && r._w(a.name) && !r._m(a.name));
    let acted = this.whileActive.get(r.id);
    if (trigger) {
      if (!acted) { acted = new Map(); this.whileActive.set(r.id, acted); }
      for (const a of apps.values()) {
        if (!r._m(a.name) || (r._w && r._w(a.name))) continue;
        const fresh = a.procs.filter((p) => !acted.has(p.k));
        if (!fresh.length) continue;
        for (const p of fresh) acted.set(p.k, { pid: p.pid, priority: p.priority });
        actions.push({ rule: r, kind: r.action, level: r.level, app: a.key, name: a.name, procs: fresh, text: describeRule(r) });
      }
    } else if (acted) {
      this.whileActive.delete(r.id);
      const live = new Map();
      for (const a of apps.values()) for (const p of a.procs) live.set(p.k, p);
      const procs = [...acted.entries()].filter(([k]) => live.has(k)).map(([k, v]) => ({ ...live.get(k), prevPriority: v.priority }));
      if (procs.length && (r.action === 'pause' || r.action === 'priority')) {
        actions.push({ rule: r, kind: r.action === 'pause' ? 'resume' : 'restorePriority', app: procs[0].app, name: procs[0].name, procs, text: `${r.whileApp} closed, so Lookout undid: ` + describeRule(r) });
      }
    }
  }
}

const DEFAULT_RULES = [
  { id: 'r-mem', enabled: true, target: '*', cond: 'mem', value: 4096, seconds: 0, action: 'notify' },
  { id: 'r-hung', enabled: true, target: '*', cond: 'hung', value: 0, seconds: 30, action: 'notify' },
  { id: 'r-game', enabled: false, target: 'game.exe', cond: 'start', value: 0, seconds: 0, action: 'priority', level: 'high' },
  { id: 'r-obs', enabled: false, target: 'discord.exe', cond: 'while', whileApp: 'obs64.exe', value: 0, seconds: 0, action: 'priority', level: 'idle' }
];

module.exports = { RuleEngine, matcher, describeRule, DEFAULT_RULES };
