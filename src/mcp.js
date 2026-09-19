#!/usr/bin/env node
// MCP bridge: a thin stdio MCP server Claude Code loads. It holds no state of
// its own -- it forwards every tool call to the hub's localhost control API,
// so agents stay connected across Claude restarts.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
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

server.registerTool('start_command', {
  title: 'Start a long-running command (streaming)',
  description: 'Start a command on the agent in its workdir WITHOUT waiting for it to finish. Returns a jobId immediately. Poll it with read_output to follow the output live (builds, test watchers, servers). Use kill_command to stop it. For quick commands prefer run_command.',
  inputSchema: {
    agentId: z.string().describe('id from list_agents'),
    cmd: z.string().describe('command line to run in the agent shell'),
    timeout: z.number().optional().describe('ms before the job is force-killed (default 3600000 = 1h)'),
  },
}, async ({ agentId, cmd, timeout }) => {
  const r = await ctrl('POST', '/start', { agentId, cmd, timeout });
  if (!r.ok) return text('start failed: ' + r.error);
  return text(`started job ${r.jobId} in ${r.cwd}\nPoll it with read_output { jobId: "${r.jobId}", cursor: 0 }.`);
});

server.registerTool('read_output', {
  title: 'Read new output from a running job',
  description: 'Fetch output from a job started with start_command, from `cursor` onward. Long-polls: if there is no new output yet and the job is still running, it waits up to ~8s before returning. Pass the returned `cursor` on the next call to get only newer output; repeat until running is false. That loop is how you watch output stream in.',
  inputSchema: {
    jobId: z.string(),
    cursor: z.number().optional().describe('byte/chunk cursor from the previous call; start at 0'),
    wait: z.number().optional().describe('max ms to long-poll for new output (default 8000, max 55000)'),
  },
}, async ({ jobId, cursor, wait }) => {
  const r = await ctrl('POST', '/output', { jobId, cursor: cursor || 0, wait });
  if (!r.ok) return text('read_output failed: ' + r.error);
  const status = r.running
    ? `[running · cursor=${r.cursor}]`
    : `[exited ${r.code}${r.signal ? ' ' + r.signal : ''}${r.error ? ' error=' + r.error : ''} · cursor=${r.cursor}]`;
  const out = r.text ? r.text.replace(/\s+$/, '') : (r.running ? '(no new output yet)' : '(no output)');
  return text(out + '\n' + status);
});

server.registerTool('kill_command', {
  title: 'Stop a running job',
  description: 'Force-kill a job started with start_command (kills the whole process tree on Windows).',
  inputSchema: { agentId: z.string(), jobId: z.string() },
}, async ({ agentId, jobId }) => {
  const r = await ctrl('POST', '/kill', { agentId, jobId });
  return text(r.ok ? `killed ${jobId}` : 'kill failed: ' + r.error);
});

server.registerTool('push_path', {
  title: 'Push a local file or directory to an agent',
  description: 'Copy a file or an entire directory tree from THIS machine (where the hub runs) to the agent, under remotePath (relative to the agent workdir, or absolute). For a directory, the tree is mirrored. With overwrite:true the destination directory is wiped first (clean overwrite); otherwise files are merged/replaced. node_modules and .git are skipped by default.',
  inputSchema: {
    agentId: z.string().describe('id from list_agents'),
    localPath: z.string().describe('file or directory on the hub machine to send'),
    remotePath: z.string().optional().describe('destination on the agent (relative to workdir or absolute); default: the basename of localPath'),
    overwrite: z.boolean().optional().describe('if true, wipe the destination directory before copying (clean mirror)'),
    exclude: z.array(z.string()).optional().describe('directory/file names to skip; default ["node_modules",".git",".DS_Store"]'),
  },
}, async ({ agentId, localPath, remotePath, overwrite, exclude }) => {
  const absLocal = path.resolve(localPath);
  let st;
  try { st = fs.statSync(absLocal); } catch { return text('local path not found: ' + absLocal); }
  const dest = remotePath || path.basename(absLocal);

  try {
    if (st.isFile()) {
      const dataB64 = fs.readFileSync(absLocal).toString('base64');
      const r = await ctrl('POST', '/push', { agentId, dest, single: true, files: [{ rel: path.basename(absLocal), dataB64 }] });
      return text(r.ok ? `pushed file -> ${r.abs} (1 file)` : 'push failed: ' + r.error);
    }
    // directory: walk it, honoring excludes
    const ex = new Set(exclude ?? ['node_modules', '.git', '.DS_Store']);
    const files = [], dirs = [];
    (function walk(dir, rel) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ex.has(e.name)) continue;
        const full = path.join(dir, e.name);
        const r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) { dirs.push(r); walk(full, r); }
        else if (e.isFile()) files.push({ full, rel: r });
      }
    })(absLocal, '');

    // send in batches (~6 MB of base64 per call) so no single message is huge
    const BATCH = 6 * 1024 * 1024;
    let batch = [], size = 0, first = true, wrote = 0, lastAbs = dest;
    const flush = async () => {
      if (!first && !batch.length) return;
      const r = await ctrl('POST', '/push', {
        agentId, dest, clear: first && !!overwrite,
        dirs: first ? dirs : [], files: batch,
      });
      if (!r.ok) throw new Error(r.error);
      wrote += r.wrote || 0; lastAbs = r.abs || lastAbs; first = false; batch = []; size = 0;
    };
    for (const f of files) {
      const dataB64 = fs.readFileSync(f.full).toString('base64');
      batch.push({ rel: f.rel, dataB64 });
      size += dataB64.length;
      if (size >= BATCH) await flush();
    }
    await flush();
    return text(`pushed directory -> ${lastAbs}\n${wrote} files, ${dirs.length} dirs${overwrite ? ' (destination overwritten)' : ''}`);
  } catch (e) {
    return text('push failed: ' + e.message);
  }
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
