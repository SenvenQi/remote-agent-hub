#!/usr/bin/env node
// Hub: long-running broker that agents connect back to, and that the MCP
// bridge drives over a localhost-only control API.
//
//   - WebSocket server (:8787) accepts agents that present the shared token.
//   - HTTP control API (127.0.0.1:8788) lets the local MCP bridge list agents
//     and dispatch exec / read / write requests to a chosen agent.
//
// Every dispatched command is written to an append-only audit log so there is
// always a record of what ran where. This is your own infrastructure: agents
// are installed by you, name themselves on connect, and are addressed explicitly.

import { WebSocketServer } from 'ws';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { HUB_WS_PORT, HUB_CTRL_PORT, CTRL_HOST, newId, send } from './protocol.js';

const AGENT_TOKEN = process.env.RAH_TOKEN || '';
const CTRL_TOKEN = process.env.RAH_CTRL_TOKEN || '';
if (!AGENT_TOKEN) {
  console.error('[hub] refusing to start: set RAH_TOKEN (shared secret agents must present).');
  process.exit(1);
}

const LOG_PATH = process.env.RAH_LOG || path.join(process.cwd(), 'hub-audit.log');
function audit(event, data) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + '\n';
  fs.appendFile(LOG_PATH, line, () => {});
}

/** @type {Map<string, {id, name, meta, ws, connectedAt, pending: Map, cwd: string}>} */
const agents = new Map();

// Working directory remembered per agent NAME (not id), so it survives the
// agent reconnecting with a fresh id -- like keeping your shell's cwd.
/** @type {Map<string, string>} */
const workdirs = new Map();

// ---- WebSocket side: agents connect here ---------------------------------
const wss = new WebSocketServer({ port: HUB_WS_PORT, host: '0.0.0.0' });
wss.on('listening', () => console.log(`[hub] agents: ws://0.0.0.0:${HUB_WS_PORT}`));

wss.on('connection', (ws, req) => {
  let agent = null;
  const ip = req.socket.remoteAddress;

  ws.on('message', (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }

    if (!agent) {
      if (msg.t !== 'register') return; // must register first
      if (msg.token !== AGENT_TOKEN) {
        send(ws, { t: 'denied', reason: 'bad token' });
        audit('register_denied', { ip, name: msg.name });
        ws.close();
        return;
      }
      const id = newId('agent');
      const name = String(msg.name || 'unnamed');
      // restore remembered cwd for this name, else default to what the agent reported
      const cwd = workdirs.get(name) || (msg.meta && msg.meta.cwd) || '.';
      agent = { id, name, meta: msg.meta || {}, ws, connectedAt: Date.now(), pending: new Map(), cwd };
      agents.set(id, agent);
      send(ws, { t: 'registered', id });
      audit('register', { id, name: agent.name, ip, meta: agent.meta });
      console.log(`[hub] + agent ${agent.name} (${id}) from ${ip}`);
      return;
    }

    // responses to in-flight control requests
    const p = agent.pending.get(msg.reqId);
    if (!p) return;
    if (msg.t === 'stdout') p.stdout.push(msg.chunk);
    else if (msg.t === 'stderr') p.stderr.push(msg.chunk);
    else if (msg.t === 'exit') {
      p.resolve({ ok: !msg.error, code: msg.code, signal: msg.signal, error: msg.error,
        stdout: p.stdout.join(''), stderr: p.stderr.join('') });
      agent.pending.delete(msg.reqId);
    } else if (msg.t === 'result') {
      p.resolve({ ok: msg.ok, dataB64: msg.dataB64, error: msg.error,
        abs: msg.abs, entries: msg.entries, truncated: msg.truncated });
      agent.pending.delete(msg.reqId);
    }
  });

  ws.on('close', () => {
    if (agent) {
      agents.delete(agent.id);
      for (const p of agent.pending.values()) p.resolve({ ok: false, error: 'agent disconnected' });
      audit('disconnect', { id: agent.id, name: agent.name });
      console.log(`[hub] - agent ${agent.name} (${agent.id})`);
    }
  });

  ws.on('error', () => {});
});

// heartbeat: drop dead sockets
setInterval(() => {
  for (const a of agents.values()) {
    if (a.ws.readyState === a.ws.OPEN) send(a.ws, { t: 'ping' });
  }
}, 20000);

// dispatch a request to an agent and await its reply (with timeout)
function dispatch(agentId, message, timeoutMs) {
  const agent = agents.get(agentId);
  if (!agent) return Promise.resolve({ ok: false, error: `no agent ${agentId}` });
  const reqId = newId('req');
  return new Promise((resolve) => {
    const entry = { resolve, stdout: [], stderr: [], timer: null };
    entry.timer = setTimeout(() => {
      if (agent.pending.has(reqId)) {
        agent.pending.delete(reqId);
        resolve({ ok: false, error: 'timeout', stdout: entry.stdout.join(''), stderr: entry.stderr.join('') });
      }
    }, timeoutMs);
    const wrapped = (v) => { clearTimeout(entry.timer); resolve(v); };
    entry.resolve = wrapped;
    agent.pending.set(reqId, entry);
    send(agent.ws, { ...message, reqId });
  });
}

// ---- Control side: the MCP bridge (localhost only) -----------------------
function readBody(req) {
  return new Promise((res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => res(b)); });
}

const ctrl = http.createServer(async (req, res) => {
  if (CTRL_TOKEN && req.headers['x-ctrl-token'] !== CTRL_TOKEN) {
    res.writeHead(401).end('unauthorized'); return;
  }
  const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

  if (req.method === 'GET' && req.url === '/agents') {
    return json(200, {
      agents: [...agents.values()].map(a => ({
        id: a.id, name: a.name, meta: a.meta, cwd: a.cwd,
        connectedAt: new Date(a.connectedAt).toISOString(),
        inflight: a.pending.size,
      })),
    });
  }

  if (req.method === 'POST') {
    let body; try { body = JSON.parse(await readBody(req) || '{}'); } catch { return json(400, { error: 'bad json' }); }
    const agent = agents.get(body.agentId);
    if (!agent) return json(404, { ok: false, error: `no agent ${body.agentId}` });

    if (req.url === '/exec') {
      const { cmd, timeout } = body;
      if (!cmd) return json(400, { error: 'cmd required' });
      audit('exec', { agentId: agent.id, cwd: agent.cwd, cmd });
      const r = await dispatch(agent.id, { t: 'exec', cmd, cwd: agent.cwd, timeout: timeout || 120000 }, (timeout || 120000) + 5000);
      return json(200, r);
    }
    if (req.url === '/read') {
      audit('read', { agentId: agent.id, cwd: agent.cwd, path: body.path });
      const r = await dispatch(agent.id, { t: 'read', cwd: agent.cwd, path: body.path }, 30000);
      return json(200, r);
    }
    if (req.url === '/write') {
      const { path: p, dataB64 } = body;
      audit('write', { agentId: agent.id, cwd: agent.cwd, path: p, bytes: dataB64 ? Buffer.byteLength(dataB64, 'base64') : 0 });
      const r = await dispatch(agent.id, { t: 'write', cwd: agent.cwd, path: p, dataB64 }, 30000);
      return json(200, r);
    }
    if (req.url === '/list') {
      const r = await dispatch(agent.id, { t: 'list', cwd: agent.cwd, path: body.path || '.' }, 30000);
      return json(200, r);
    }
    if (req.url === '/setwd') {
      // resolve+validate on the agent (real filesystem, real path rules) so
      // relative moves like "src" or ".." behave like a shell cd.
      const r = await dispatch(agent.id, { t: 'list', cwd: agent.cwd, path: body.path || '.' }, 30000);
      if (!r.ok) return json(200, { ok: false, error: r.error || 'cannot cd there', cwd: agent.cwd });
      agent.cwd = r.abs;
      workdirs.set(agent.name, r.abs);
      audit('setwd', { agentId: agent.id, name: agent.name, cwd: r.abs });
      return json(200, { ok: true, cwd: r.abs, entries: r.entries, truncated: r.truncated });
    }
  }
  json(404, { error: 'not found' });
});

ctrl.listen(HUB_CTRL_PORT, CTRL_HOST, () =>
  console.log(`[hub] control: http://${CTRL_HOST}:${HUB_CTRL_PORT}  (audit -> ${LOG_PATH})`));
