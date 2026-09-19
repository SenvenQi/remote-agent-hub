#!/usr/bin/env node
// MCP bridge: a thin stdio MCP server Claude Code loads. It holds no state of
// its own -- it forwards every tool call to the hub's localhost control API,
// so agents stay connected across Claude restarts.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { HUB_CTRL_PORT, CTRL_HOST } from './protocol.js';

const BASE = process.env.RAH_CTRL_URL || `http://${CTRL_HOST}:${HUB_CTRL_PORT}`;
const CTRL_TOKEN = process.env.RAH_CTRL_TOKEN || '';

async function ctrl(method, path, body) {
  const headers = { 'content-type': 'application/json' };
  if (CTRL_TOKEN) headers['x-ctrl-token'] = CTRL_TOKEN;
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`hub ${r.status}: ${await r.text()}`);
  return r.json();
}
const text = (s) => ({ content: [{ type: 'text', text: s }] });

const server = new McpServer({ name: 'remote-agent-hub', version: '1.0.0' });

server.registerTool('list_agents', {
  title: 'List connected agents',
  description: 'List the agents currently connected to the hub, with their name, platform and id.',
  inputSchema: {},
}, async () => {
  const { agents } = await ctrl('GET', '/agents');
  if (!agents.length) return text('No agents connected.');
  return text(agents.map(a =>
    `• ${a.name}  [${a.id}]\n    ${a.meta.platform}/${a.meta.arch}  user=${a.meta.user}  cwd=${a.meta.cwd}  since ${a.connectedAt}  inflight=${a.inflight}`
  ).join('\n'));
});

server.registerTool('run_command', {
  title: 'Run a shell command on an agent',
  description: 'Execute a shell command on the chosen agent and return stdout/stderr/exit code. Pick agentId from list_agents.',
  inputSchema: {
    agentId: z.string().describe('id from list_agents'),
    cmd: z.string().describe('command line to run in the agent shell'),
    cwd: z.string().optional().describe('working directory on the agent'),
    timeout: z.number().optional().describe('ms before the command is killed (default 120000)'),
  },
}, async ({ agentId, cmd, cwd, timeout }) => {
  const r = await ctrl('POST', '/exec', { agentId, cmd, cwd, timeout });
  const parts = [];
  if (r.stdout) parts.push(r.stdout.trimEnd());
  if (r.stderr) parts.push('[stderr]\n' + r.stderr.trimEnd());
  parts.push(`[exit ${r.code}${r.signal ? ' ' + r.signal : ''}${r.error ? ' error=' + r.error : ''}]`);
  return text(parts.join('\n'));
});

server.registerTool('read_file', {
  title: 'Read a file from an agent',
  description: 'Read a file on the chosen agent and return its text contents.',
  inputSchema: { agentId: z.string(), path: z.string() },
}, async ({ agentId, path }) => {
  const r = await ctrl('POST', '/read', { agentId, path });
  if (!r.ok) return text('read failed: ' + r.error);
  return text(Buffer.from(r.dataB64, 'base64').toString('utf8'));
});

server.registerTool('write_file', {
  title: 'Write a file on an agent',
  description: 'Write text contents to a file on the chosen agent (overwrites).',
  inputSchema: { agentId: z.string(), path: z.string(), content: z.string() },
}, async ({ agentId, path, content }) => {
  const r = await ctrl('POST', '/write', { agentId, path, dataB64: Buffer.from(content, 'utf8').toString('base64') });
  return text(r.ok ? `wrote ${Buffer.byteLength(content)} bytes to ${path}` : 'write failed: ' + r.error);
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[mcp] remote-agent-hub bridge ready ->', BASE);
