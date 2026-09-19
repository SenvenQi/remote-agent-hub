#!/usr/bin/env node
// Agent: runs on a machine you control, dials back to the hub, and executes
// the exec / read / write requests the hub forwards. Reconnects on drop.
//
// Config resolution (env wins, then config file):
//   RAH_HUB     ws/wss URL of the hub, e.g. ws://1.2.3.4:8787   (required)
//   RAH_TOKEN   shared secret, must match the hub                (required)
//   RAH_NAME    friendly name shown to the operator             (default: hostname)
//   RAH_SHELL   shell to run commands with (default: powershell on win, /bin/sh)
//   RAH_CONFIG  path to a JSON config file with {hub,token,name,shell,logfile}
//               default: %ProgramData%\remote-agent-hub\config.json (win) or
//                        /etc/remote-agent-hub/config.json
//   RAH_LOGFILE append log lines here as well as stderr (used by the service)

import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { send } from './protocol.js';

const isWin = process.platform === 'win32';

function loadConfig() {
  const def = isWin
    ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'remote-agent-hub', 'config.json')
    : '/etc/remote-agent-hub/config.json';
  const p = process.env.RAH_CONFIG || def;
  let file = {};
  try { file = JSON.parse(fss.readFileSync(p, 'utf8')); } catch { /* no file is fine */ }
  return {
    hub: process.env.RAH_HUB || file.hub,
    token: process.env.RAH_TOKEN || file.token,
    name: process.env.RAH_NAME || file.name || os.hostname(),
    shell: process.env.RAH_SHELL || file.shell || (isWin ? 'powershell.exe' : '/bin/sh'),
    logfile: process.env.RAH_LOGFILE || file.logfile || '',
  };
}

const cfg = loadConfig();
if (!cfg.hub || !cfg.token) {
  console.error('[agent] need hub URL and token (env RAH_HUB/RAH_TOKEN or config.json)');
  process.exit(1);
}

function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`;
  process.stderr.write(line + '\n');
  if (cfg.logfile) { try { fss.appendFileSync(cfg.logfile, line + '\n'); } catch {} }
}

function connect() {
  const ws = new WebSocket(cfg.hub);

  ws.on('open', () => {
    send(ws, { t: 'register', token: cfg.token, name: cfg.name,
      meta: { platform: process.platform, arch: process.arch, cwd: process.cwd(),
        user: os.userInfo().username, host: os.hostname(), node: process.version } });
  });

  ws.on('message', (buf) => {
    let m; try { m = JSON.parse(buf.toString()); } catch { return; }
    if (m.t === 'registered') { log(`[agent] registered as ${cfg.name} -> ${m.id}`); return; }
    if (m.t === 'denied') { log('[agent] denied:', m.reason); ws.close(); return; }
    if (m.t === 'ping') { send(ws, { t: 'pong' }); return; }
    if (m.t === 'exec') return runExec(ws, m);
    if (m.t === 'kill') return doKill(m);
    if (m.t === 'read') return doRead(ws, m);
    if (m.t === 'write') return doWrite(ws, m);
    if (m.t === 'list') return doList(ws, m);
    if (m.t === 'push') return doPush(ws, m);
  });

  ws.on('close', () => { log('[agent] disconnected, retrying in 3s'); setTimeout(connect, 3000); });
  ws.on('error', (e) => { log('[agent] ws error:', e.message); });
}

// running children, keyed by reqId, so a job can be killed on demand
const children = new Map();

function runExec(ws, m) {
  const args = isWin ? ['-NoProfile', '-NonInteractive', '-Command', m.cmd] : ['-c', m.cmd];
  let child;
  try {
    child = spawn(cfg.shell, args, { cwd: m.cwd || process.cwd(), env: process.env, windowsHide: true });
  } catch (e) {
    return send(ws, { t: 'exit', reqId: m.reqId, code: -1, error: e.message });
  }
  children.set(m.reqId, child);
  child.stdout.on('data', (d) => send(ws, { t: 'stdout', reqId: m.reqId, chunk: d.toString() }));
  child.stderr.on('data', (d) => send(ws, { t: 'stderr', reqId: m.reqId, chunk: d.toString() }));
  child.on('error', (e) => send(ws, { t: 'exit', reqId: m.reqId, code: -1, error: e.message }));
  child.on('close', (code, signal) => send(ws, { t: 'exit', reqId: m.reqId, code, signal }));

  const t = setTimeout(() => { try { child.kill(); } catch {} }, m.timeout || 120000);
  child.on('close', () => { clearTimeout(t); children.delete(m.reqId); });
}

// Kill a running job. On Windows a tree-kill (taskkill /T) also reaps the
// shell's grandchildren; elsewhere a plain signal.
function doKill(m) {
  const child = children.get(m.reqId);
  if (!child) return;
  if (isWin) {
    try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); }
    catch { try { child.kill(); } catch {} }
  } else {
    try { child.kill(m.signal || 'SIGTERM'); } catch {}
  }
}

// Paths from the operator may be relative; resolve them against the agent's
// current working directory so remote work feels like local work.
function abs(m) {
  return path.resolve(m.cwd || process.cwd(), m.path || '.');
}

async function doRead(ws, m) {
  try {
    const p = abs(m);
    const data = await fs.readFile(p);
    send(ws, { t: 'result', reqId: m.reqId, ok: true, abs: p, dataB64: data.toString('base64') });
  } catch (e) { send(ws, { t: 'result', reqId: m.reqId, ok: false, error: e.message }); }
}

async function doWrite(ws, m) {
  try {
    const p = abs(m);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, Buffer.from(m.dataB64 || '', 'base64'));
    send(ws, { t: 'result', reqId: m.reqId, ok: true, abs: p });
  } catch (e) { send(ws, { t: 'result', reqId: m.reqId, ok: false, error: e.message }); }
}

// Receive a batch of files (a whole file or directory tree) and write them
// under `dest`. `clear` wipes dest first for a clean mirror/overwrite. Paths
// that would escape dest are skipped defensively.
async function doPush(ws, m) {
  try {
    const dest = path.resolve(m.cwd || process.cwd(), m.dest || '.');
    if (m.single) {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, Buffer.from((m.files?.[0]?.dataB64) || '', 'base64'));
      return send(ws, { t: 'result', reqId: m.reqId, ok: true, abs: dest, wrote: 1 });
    }
    if (m.clear) await fs.rm(dest, { recursive: true, force: true });
    await fs.mkdir(dest, { recursive: true });
    for (const d of (m.dirs || [])) {
      const dp = path.resolve(dest, d);
      if (dp === dest || dp.startsWith(dest + path.sep)) await fs.mkdir(dp, { recursive: true });
    }
    let n = 0;
    for (const f of (m.files || [])) {
      const p = path.resolve(dest, f.rel);
      if (p !== dest && !p.startsWith(dest + path.sep)) continue; // no traversal
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, Buffer.from(f.dataB64 || '', 'base64'));
      n++;
    }
    send(ws, { t: 'result', reqId: m.reqId, ok: true, abs: dest, wrote: n });
  } catch (e) { send(ws, { t: 'result', reqId: m.reqId, ok: false, error: e.message }); }
}

// Also doubles as validation when the operator sets a working directory.
async function doList(ws, m) {
  try {
    const p = abs(m);
    const st = await fs.stat(p);
    if (!st.isDirectory()) {
      return send(ws, { t: 'result', reqId: m.reqId, ok: false, abs: p, error: 'not a directory' });
    }
    const ents = await fs.readdir(p, { withFileTypes: true });
    const entries = await Promise.all(ents.slice(0, 500).map(async (e) => {
      let size = null;
      if (e.isFile()) { try { size = (await fs.stat(path.join(p, e.name))).size; } catch {} }
      return { name: e.name, dir: e.isDirectory(), size };
    }));
    send(ws, { t: 'result', reqId: m.reqId, ok: true, abs: p, entries, truncated: ents.length > 500 });
  } catch (e) { send(ws, { t: 'result', reqId: m.reqId, ok: false, error: e.message }); }
}

log(`[agent] ${cfg.name} dialing ${cfg.hub}`);
connect();
