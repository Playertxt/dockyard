'use strict';
// Turns raw samples into live rates, an hour of history (per process and per app), an event log and leak detection.

const METRICS = ['cpu', 'mem', 'io', 'net'];

function appKeyOf(p) { return String(p.name || '').toLowerCase(); }

class Ring {
  constructor(cap, first) {
    this.first = first;
    this.last = first;
    for (const m of METRICS) this[m] = new Float32Array(cap);
  }
}

class Monitor {
  constructor({ capacity = 1800 } = {}) {
    this.cap = capacity;
    this.n = -1; // index of the newest sample
    this.times = new Float64Array(capacity);
    this.sys = { cpu: new Float32Array(capacity), mem: new Float32Array(capacity), io: new Float32Array(capacity), net: new Float32Array(capacity) };
    this.procHist = new Map(); // key -> Ring (+ priv)
    this.appHist = new Map(); // app key -> Ring
    this.appNames = new Map();
    this.prev = new Map();
    this.prevSys = null;
    this.connPrev = new Map();
    this.netByPid = new Map();
    this.events = [];
    this.latest = null;
    this.leakCache = { t: 0, list: [] };
    this.onEvent = null;
  }

  log(type, data) {
    const e = { t: Date.now(), type, ...data };
    this.events.push(e);
    if (this.events.length > 3000) this.events.splice(0, this.events.length - 3000);
    if (this.onEvent) this.onEvent(e);
    return e;
  }

  // conns: optional list with cumulative per-connection byte counters ({pid, proto, la, lp, ra, rp, in, out}).
  ingestConnections(conns, t) {
    const dt = this._connT != null ? (t - this._connT) / 1000 : 0;
    this._connT = t;
    const next = new Map();
    const by = new Map();
    for (const c of conns) {
      if (c.in == null) continue;
      const key = c.proto + '|' + c.la + ':' + c.lp + '|' + c.ra + ':' + c.rp + '|' + c.pid;
      next.set(key, { in: c.in, out: c.out });
      const p = this.connPrev.get(key);
      if (!p || dt <= 0) continue;
      const din = Math.max(0, c.in - p.in) / dt, dout = Math.max(0, c.out - p.out) / dt;
      const e = by.get(c.pid) || { in: 0, out: 0 };
      e.in += din; e.out += dout;
      by.set(c.pid, e);
    }
    this.connPrev = next;
    this.netByPid = by;
    this.netAt = t;
  }

  ingest(s) {
    const t = s.t != null ? s.t : Date.now();
    const dtSys = this.prevSys ? (t - this.prevSys.t) / 1000 : 0;
    const rxRate = dtSys > 0 ? Math.max(0, s.rx - this.prevSys.rx) / dtSys : 0;
    const txRate = dtSys > 0 ? Math.max(0, s.tx - this.prevSys.tx) / dtSys : 0;
    this.prevSys = { t, rx: s.rx, tx: s.tx };
    const netFresh = this.netAt && t - this.netAt < 6000;

    const first = this.n < 0;
    this.n++;
    const i = this.n % this.cap;
    this.times[i] = t;

    const next = new Map();
    const procs = [];
    let ioTotal = 0;
    const apps = new Map();
    for (const p of s.procs) {
      const k = p.pid + ':' + (p.start || 0);
      const prev = this.prev.get(k);
      const dt = prev ? (t - prev.t) / 1000 : 0;
      const ioRate = prev && dt > 0 ? Math.max(0, (p.io || 0) - prev.io) / dt : 0;
      next.set(k, { t, io: p.io || 0 });
      const net = netFresh ? this.netByPid.get(p.pid) : null;
      const cpu = Math.max(0, p.cpu || 0);
      const proc = { ...p, k, cpu, ioRate, netIn: net ? net.in : (netFresh ? 0 : null), netOut: net ? net.out : (netFresh ? 0 : null), app: appKeyOf(p) };
      procs.push(proc);
      ioTotal += ioRate;

      let h = this.procHist.get(k);
      if (!h) { h = new Ring(this.cap, this.n); h.priv = new Float32Array(this.cap); h.name = p.name; h.pid = p.pid; this.procHist.set(k, h); }
      h.last = this.n;
      h.cpu[i] = cpu; h.mem[i] = Math.max(0, p.mem || 0); h.io[i] = ioRate; h.net[i] = net ? net.in + net.out : 0; h.priv[i] = Math.max(0, p.priv || 0);

      const a = apps.get(proc.app) || { cpu: 0, mem: 0, io: 0, net: 0 };
      a.cpu += cpu; a.mem += Math.max(0, p.mem || 0); a.io += ioRate; a.net += net ? net.in + net.out : 0;
      apps.set(proc.app, a);
      if (!this.appNames.has(proc.app)) this.appNames.set(proc.app, p.name);

      if (!first && !prev) this.log('start', { pid: p.pid, name: p.name, k });
    }
    if (!first) {
      for (const [k] of this.prev) {
        if (next.has(k)) continue;
        const h = this.procHist.get(k);
        this.log('exit', { pid: h ? h.pid : +k.split(':')[0], name: h ? h.name : '?', k });
      }
    }
    this.prev = next;

    for (const [key, a] of apps) {
      let h = this.appHist.get(key);
      if (!h) { h = new Ring(this.cap, this.n); this.appHist.set(key, h); }
      h.last = this.n;
      h.cpu[i] = a.cpu; h.mem[i] = a.mem; h.io[i] = a.io; h.net[i] = a.net;
    }

    const memPct = s.memTotal ? s.memUsed / s.memTotal * 100 : 0;
    this.sys.cpu[i] = s.cpu; this.sys.mem[i] = memPct; this.sys.io[i] = ioTotal; this.sys.net[i] = rxRate + txRate;

    // Forget histories that have scrolled out of the window.
    const oldest = this.n - this.cap + 1;
    for (const [k, h] of this.procHist) if (h.last < oldest) this.procHist.delete(k);
    for (const [k, h] of this.appHist) if (h.last < oldest) { this.appHist.delete(k); this.appNames.delete(k); }

    this.latest = {
      t, cpus: s.cpus, cpu: s.cpu, memUsed: s.memUsed, memTotal: s.memTotal, memPct, rxRate, txRate, ioRate: ioTotal,
      admin: !!s.admin, netPerApp: !!netFresh, procs, n: this.n
    };
    return this.latest;
  }

  // Index range covering the last `seconds` (oldest first).
  _range(seconds) {
    if (this.n < 0) return [];
    const now = this.times[this.n % this.cap];
    const out = [];
    for (let n = this.n; n >= 0 && n > this.n - this.cap; n--) {
      if (now - this.times[n % this.cap] > seconds * 1000) break;
      out.push(n);
    }
    return out.reverse();
  }

  _val(h, metric, n) {
    if (!h || n < h.first || n > h.last) return 0;
    return h[metric][n % this.cap];
  }

  // Average of a metric per app over the last `seconds`.
  appAverages(metric, seconds) {
    const idx = this._range(seconds);
    const out = new Map();
    if (!idx.length) return out;
    for (const [key, h] of this.appHist) {
      let sum = 0;
      for (const n of idx) sum += this._val(h, metric, n);
      out.set(key, sum / idx.length);
    }
    return out;
  }

  sysAverage(metric, seconds) {
    const idx = this._range(seconds);
    if (!idx.length) return 0;
    let s = 0;
    for (const n of idx) s += this.sys[metric][n % this.cap];
    return s / idx.length;
  }

  // How long (ms) an app has continuously been at or above `threshold`.
  appAboveFor(key, metric, threshold) {
    const h = this.appHist.get(key);
    if (!h || this.n < 0) return 0;
    const now = this.times[this.n % this.cap];
    let since = now;
    for (let n = this.n; n >= Math.max(h.first, this.n - this.cap + 1); n--) {
      if (h[metric][n % this.cap] < threshold) break;
      since = this.times[n % this.cap];
    }
    return now - since;
  }

  procSeries(k, seconds) {
    const h = this.procHist.get(k);
    const idx = this._range(seconds);
    const out = { t: [], cpu: [], mem: [], io: [], net: [] };
    for (const n of idx) {
      out.t.push(this.times[n % this.cap]);
      for (const m of METRICS) out[m].push(this._val(h, m, n));
    }
    return out;
  }

  appSeries(key, seconds) {
    const h = this.appHist.get(key);
    const idx = this._range(seconds);
    const out = { t: [], cpu: [], mem: [], io: [], net: [] };
    for (const n of idx) {
      out.t.push(this.times[n % this.cap]);
      for (const m of METRICS) out[m].push(this._val(h, m, n));
    }
    return out;
  }

  // Timeline for the History view: the system total plus the top apps, downsampled.
  timeline(metric, seconds, { top = 6, maxPoints = 600, only = null } = {}) {
    const idx = this._range(seconds);
    const step = Math.max(1, Math.ceil(idx.length / maxPoints));
    const buckets = [];
    for (let b = 0; b < idx.length; b += step) buckets.push(idx.slice(b, b + step));
    const avg = (fn, bucket) => bucket.reduce((s, n) => s + fn(n), 0) / bucket.length;
    const t = buckets.map((b) => this.times[b[b.length - 1] % this.cap]);
    const system = buckets.map((b) => avg((n) => this.sys[metric][n % this.cap], b));
    const ranked = [];
    for (const [key, h] of this.appHist) {
      if (only && !only.includes(key)) continue;
      let sum = 0, peak = 0;
      for (const n of idx) { const v = this._val(h, metric, n); sum += v; if (v > peak) peak = v; }
      if (sum > 0) ranked.push({ key, sum, peak });
    }
    ranked.sort((a, b) => b.sum - a.sum);
    const series = ranked.slice(0, only ? ranked.length : top).map((r) => {
      const h = this.appHist.get(r.key);
      return { key: r.key, name: this.appNames.get(r.key) || r.key, peak: r.peak, values: buckets.map((b) => avg((n) => this._val(h, metric, n), b)) };
    });
    return { metric, t, system, series };
  }

  // The apps using the most of a metric at a moment in time.
  at(time, metric, limit = 8) {
    if (this.n < 0) return { t: 0, items: [] };
    let best = this.n, bestD = Infinity;
    for (let n = this.n; n >= 0 && n > this.n - this.cap; n--) {
      const d = Math.abs(this.times[n % this.cap] - time);
      if (d < bestD) { bestD = d; best = n; }
      if (this.times[n % this.cap] < time - 60000) break;
    }
    const items = [];
    for (const [key, h] of this.appHist) {
      const v = this._val(h, metric, best);
      if (v > 0) items.push({ key, name: this.appNames.get(key) || key, value: v });
    }
    items.sort((a, b) => b.value - a.value);
    return { t: this.times[best % this.cap], system: this.sys[metric][best % this.cap], items: items.slice(0, limit) };
  }

  // Processes whose private memory has grown steadily for at least `minMinutes`.
  leaks({ minMinutes = 10, minGrowth = 100 * 2 ** 20, minSlope = 2 ** 20, minR2 = 0.8 } = {}) {
    const now = Date.now();
    if (now - this.leakCache.t < 20000) return this.leakCache.list;
    const list = [];
    const idxAll = this._range(60 * 60);
    for (const [k, h] of this.procHist) {
      if (h.last !== this.n) continue;
      const idx = idxAll.filter((n) => n >= h.first);
      if (idx.length < 20) continue;
      const t0 = this.times[idx[0] % this.cap];
      const t1 = this.times[idx[idx.length - 1] % this.cap];
      const minutes = (t1 - t0) / 60000;
      if (minutes < minMinutes) continue;
      const step = Math.max(1, Math.floor(idx.length / 120));
      const xs = [], ys = [];
      for (let j = 0; j < idx.length; j += step) {
        xs.push((this.times[idx[j] % this.cap] - t0) / 60000);
        ys.push(h.priv[idx[j] % this.cap]);
      }
      const fit = linearFit(xs, ys);
      const growth = ys[ys.length - 1] - ys[0];
      const max = Math.max(...ys);
      if (fit.slope >= minSlope && fit.r2 >= minR2 && growth >= minGrowth && ys[ys.length - 1] >= max * 0.95) {
        list.push({ k, pid: h.pid, name: h.name, slope: fit.slope, r2: fit.r2, growth, minutes, now: ys[ys.length - 1] });
      }
    }
    list.sort((a, b) => b.growth - a.growth);
    this.leakCache = { t: now, list };
    return list;
  }

  eventsBetween(from, to) { return this.events.filter((e) => e.t >= from && e.t <= to); }
}

function linearFit(xs, ys) {
  const n = xs.length;
  if (n < 2) return { slope: 0, r2: 0 };
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; syy += ys[i] * ys[i]; }
  const den = n * sxx - sx * sx;
  if (!den) return { slope: 0, r2: 0 };
  const slope = (n * sxy - sx * sy) / den;
  const r = (n * sxy - sx * sy) / Math.sqrt(den * (n * syy - sy * sy) || 1);
  return { slope, r2: r * r };
}

module.exports = { Monitor, linearFit, appKeyOf, METRICS };
