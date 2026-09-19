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

function fmtEntries(entries, truncated) {
  if (!entries) return '';
  const lines = entries
    .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name))
    .map((e) => e.dir ? `  ${e.name}/` : `  ${e.name}  (${e.size ?? '?'}b)`);
  if (truncated) lines.push('  … (truncated at 500)');
  return lines.join('\n') || '  (empty)';
}

const server = new McpServer({ name: 'remote-agent-hub', version: '1.0.0' });

server.registerTool('list_agents', {
  title: 'List connected agents',
  description: 'List the agents currently connected to the hub, with their name, platform and id.',
  inputSchema: {},
}, async () => {
  const { agents } = await ctrl('GET', '/agents');
  if (!agents.length) return text('No agents connected.');
  return text(agents.map(a =>
    `• ${a.name}  [${a.id}]\n    ${a.meta.platform}/${a.meta.arch}  user=${a.meta.user}  workdir=${a.cwd}  since ${a.connectedAt}  inflight=${a.inflight}`
  ).join('\n'));
});

server.registerTool('set_workdir', {
  title: 'Set the working directory on an agent',
  description: 'Change the persistent working directory for an agent, like `cd`. Accepts an absolute path or one relative to the current workdir (including ".."). All later run_command / read_file / write_file / list_dir calls use it, and it survives the agent reconnecting. Returns the new directory and its contents.',
  inputSchema: {
    agentId: z.string().describe('id from list_agents'),
    path: z.string().describe('absolute path, or relative to the current workdir'),
  },
}, async ({ agentId, path }) => {
  const r = await ctrl('POST', '/setwd', { agentId, path });
  if (!r.ok) return text('cd failed: ' + r.error);
  return text(`workdir -> ${r.cwd}\n` + fmtEntries(r.entries, r.truncated));
});

server.registerTool('list_dir', {
  title: 'List a directory on an agent',
  description: 'List a directory on the agent, relative to its current workdir (default: the workdir itself). Does not change the workdir.',
  inputSchema: {
    agentId: z.string(),
    path: z.string().optional().describe('relative to the current workdir; default "."'),
  },
}, async ({ agentId, path }) => {
  const r = await ctrl('POST', '/list', { agentId, path: path || '.' });
  if (!r.ok) return text('list failed: ' + r.error);
  return text(`${r.abs}\n` + fmtEntries(r.entries, r.truncated));
});

server.registerTool('run_command', {
  title: 'Run a shell command on an agent',
  description: 'Execute a shell command on the chosen agent, in its current workdir, and return stdout/stderr/exit code. Use set_workdir first to choose where it runs.',
  inputSchema: {
    agentId: z.string().describe('id from list_agents'),
    cmd: z.string().describe('command line to run in the agent shell'),
    timeout: z.number().optional().describe('ms before the command is killed (default 120000)'),
  },
}, async ({ agentId, cmd, timeout }) => {
  const r = await ctrl('POST', '/exec', { agentId, cmd, timeout });
  const parts = [];
  if (r.stdout) parts.push(r.stdout.trimEnd());
  if (r.stderr) parts.push('[stderr]\n' + r.stderr.trimEnd());
  parts.push(`[exit ${r.code}${r.signal ? ' ' + r.signal : ''}${r.error ? ' error=' + r.error : ''}]`);
  return text(parts.join('\n'));
});

server.registerTool('read_file', {
  title: 'Read a file from an agent',
  description: 'Read a file on the chosen agent and return its text contents. Path is relative to the agent workdir (or absolute).',
  inputSchema: { agentId: z.string(), path: z.string() },
}, async ({ agentId, path }) => {
  const r = await ctrl('POST', '/read', { agentId, path });
  if (!r.ok) return text('read failed: ' + r.error);
  return text(Buffer.from(r.dataB64, 'base64').toString('utf8'));
});

server.registerTool('write_file', {
  title: 'Write a file on an agent',
  description: 'Write text contents to a file on the chosen agent (creates parent dirs, overwrites). Path is relative to the agent workdir (or absolute).',
  inputSchema: { agentId: z.string(), path: z.string(), content: z.string() },
}, async ({ agentId, path, content }) => {
  const r = await ctrl('POST', '/write', { agentId, path, dataB64: Buffer.from(content, 'utf8').toString('base64') });
  return text(r.ok ? `wrote ${Buffer.byteLength(content)} bytes to ${r.abs}` : 'write failed: ' + r.error);
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[mcp] remote-agent-hub bridge ready ->', BASE);
