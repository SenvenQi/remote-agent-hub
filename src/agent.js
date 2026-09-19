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
    if (m.t === 'read') return doRead(ws, m);
    if (m.t === 'write') return doWrite(ws, m);
  });

  ws.on('close', () => { log('[agent] disconnected, retrying in 3s'); setTimeout(connect, 3000); });
  ws.on('error', (e) => { log('[agent] ws error:', e.message); });
}

function runExec(ws, m) {
  const args = isWin ? ['-NoProfile', '-NonInteractive', '-Command', m.cmd] : ['-c', m.cmd];
  let child;
  try {
    child = spawn(cfg.shell, args, { cwd: m.cwd || process.cwd(), env: process.env, windowsHide: true });
  } catch (e) {
    return send(ws, { t: 'exit', reqId: m.reqId, code: -1, error: e.message });
  }
  child.stdout.on('data', (d) => send(ws, { t: 'stdout', reqId: m.reqId, chunk: d.toString() }));
  child.stderr.on('data', (d) => send(ws, { t: 'stderr', reqId: m.reqId, chunk: d.toString() }));
  child.on('error', (e) => send(ws, { t: 'exit', reqId: m.reqId, code: -1, error: e.message }));
  child.on('close', (code, signal) => send(ws, { t: 'exit', reqId: m.reqId, code, signal }));

  const t = setTimeout(() => { try { child.kill(); } catch {} }, m.timeout || 120000);
  child.on('close', () => clearTimeout(t));
}

async function doRead(ws, m) {
  try {
    const data = await fs.readFile(m.path);
    send(ws, { t: 'result', reqId: m.reqId, ok: true, dataB64: data.toString('base64') });
  } catch (e) { send(ws, { t: 'result', reqId: m.reqId, ok: false, error: e.message }); }
}

async function doWrite(ws, m) {
  try {
    await fs.writeFile(m.path, Buffer.from(m.dataB64 || '', 'base64'));
    send(ws, { t: 'result', reqId: m.reqId, ok: true });
  } catch (e) { send(ws, { t: 'result', reqId: m.reqId, ok: false, error: e.message }); }
}

log(`[agent] ${cfg.name} dialing ${cfg.hub}`);
connect();
