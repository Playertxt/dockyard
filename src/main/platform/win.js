'use strict';
// Windows backend: a persistent PowerShell-hosted C# helper (helper.cs), compiled once and cached.
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const b64 = (s) => Buffer.from(String(s == null ? '' : s), 'utf8').toString('base64');

class WinPlatform {
  constructor() {
    this.name = 'win32';
    this.proc = null;
    this.pending = new Map();
    this.nextId = 1;
    this.restarts = 0;
    this.excluded = [];
    this.caps = { hung: true, perAppNet: 'admin', fileLocks: true, opacity: true, describe: true };
  }

  init(workDir) {
    this.workDir = workDir;
    this._start();
    return this.ready;
  }

  _start() {
    const src = fs.readFileSync(path.join(__dirname, 'helper.cs'), 'utf8');
    const loader = fs.readFileSync(path.join(__dirname, 'helper.ps1'), 'utf8');
    const hash = crypto.createHash('sha1').update(src).update(os.release()).digest('hex').slice(0, 12);
    const dir = path.join(this.workDir, 'helper');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) {
      if (/^lookout-helper-.*\.dll$/.test(f) && !f.includes(hash)) { try { fs.unlinkSync(path.join(dir, f)); } catch (_) { /* in use */ } }
    }
    const cs = path.join(dir, 'helper.cs');
    const ps1 = path.join(dir, 'helper.ps1');
    const dll = path.join(dir, `lookout-helper-${hash}.dll`);
    fs.writeFileSync(cs, src);
    fs.writeFileSync(ps1, loader);

    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    this.proc = spawn(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Source', cs, '-Dll', dll], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let resolveReady;
    this.ready = new Promise((r) => { resolveReady = r; });
    const timeout = setTimeout(() => resolveReady(false), 45000);

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => {
      const sp = line.indexOf(' ');
      if (sp < 0) return;
      const id = line.slice(0, sp);
      let payload;
      try { payload = JSON.parse(line.slice(sp + 1)); } catch (e) { return; }
      if (id === '0') {
        clearTimeout(timeout);
        resolveReady(true);
        if (this.excluded.length) this._send('exclude', ...this.excluded).catch(() => {});
        return;
      }
      const p = this.pending.get(id);
      if (p) {
        this.pending.delete(id);
        clearTimeout(p.timer);
        if (payload && payload.error) p.reject(new Error(payload.error));
        else p.resolve(payload);
      }
    });
    this.proc.stderr.on('data', (d) => console.error('[helper]', d.toString().trim()));
    this.proc.on('exit', (code) => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('helper exited')); }
      this.pending.clear();
      this.proc = null;
      if (this._quitting) return;
      if (this.restarts++ < 5) {
        console.error('[helper] exited with', code, '- restarting');
        setTimeout(() => this._start(), 1000);
      }
    });
  }

  _send(cmd, ...args) {
    if (!this.proc) return Promise.reject(new Error('helper not running'));
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('helper timeout: ' + cmd));
      }, cmd === 'whofile' ? 60000 : 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write([id, cmd, ...args.map((a) => String(a))].join(' ') + '\n');
    });
  }

  get helperPid() { return this.proc ? this.proc.pid : 0; }

  excludePids(pids) {
    const fresh = pids.filter((p) => !this.excluded.includes(p));
    if (!fresh.length) return;
    this.excluded.push(...fresh);
    if (this.proc) this._send('exclude', ...fresh).catch(() => {});
  }

  // ---- sampling
  async sample() {
    const r = await this._send('sample');
    const total = os.totalmem();
    return {
      t: r.t, cpus: r.cpus, cpu: r.cpu, rx: r.rx, tx: r.tx, admin: r.admin,
      memTotal: total, memUsed: total - os.freemem(),
      procs: r.procs
    };
  }

  async connections() {
    const r = await this._send('conns');
    return { admin: r.admin, conns: r.conns };
  }

  async windows(includeInvisible) { return this._send('windows', includeInvisible ? 1 : 0); }
  winAction(id, action, arg) { return this._send('win', id, action, arg == null ? -1 : Math.round(arg)); }
  unhideAll() { return this._send('unhideall'); }

  // ---- process control
  kill(pid) { return this._send('kill', pid); }
  killTree(pid) { return this._send('killtree', pid); }
  setPriority(pid, level) { return this._send('priority', pid, level); }
  suspend(pid) { return this._send('suspend', pid); }
  resume(pid) { return this._send('resume', pid); }
  resumeAll() { return this._send('resumeall'); }
  details(pid) { return this._send('details', pid); }
  async describe(paths) {
    const out = [];
    for (let i = 0; i < paths.length; i += 40) {
      const r = await this._send('describe', ...paths.slice(i, i + 40).map(b64));
      out.push(...r.items);
    }
    return out;
  }
  whoFile(p) { return this._send('whofile', b64(p)); }
  launch(cmd, cwd) { return this._send('launch', b64(cmd), b64(cwd || '')); }
  commandFor(exe) { return '"' + exe + '"'; }

  quit() {
    this._quitting = true;
    if (this.proc) {
      try { this.proc.stdin.write('999999 quit\n'); } catch (_) { /* ignore */ }
      const p = this.proc;
      setTimeout(() => { try { p.kill(); } catch (_) { /* ignore */ } }, 800);
    }
  }
}

module.exports = { WinPlatform };
