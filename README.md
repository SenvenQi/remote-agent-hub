# remote-agent-hub

Self-hosted remote-development orchestration. You install a small **agent** on
each machine you control; every agent dials back to a long-running **hub** on
your server. Claude Code, through an **MCP bridge**, can then list the connected
agents and pick one to run commands, read files, and write files on — for
coding and debugging work on that machine.

This is your own infrastructure. It is built to look and behave like legitimate
remote-admin tooling, not a backdoor:

- **Shared-secret auth** — agents must present `RAH_TOKEN` to register; wrong
  token is refused and logged.
- **Explicit addressing** — each agent names itself on connect; Claude targets
  one by id. Nothing runs "everywhere" implicitly.
- **Audit log** — every exec / read / write is appended to `hub-audit.log` with
  a timestamp.
- **Control API is localhost-only** — the MCP bridge reaches the hub on
  `127.0.0.1`; only the agent WebSocket port is exposed to your network.

Only install the agent on machines you own or are authorized to administer, and
tell the people who use those machines it is there.

## Layout

| file | role |
|------|------|
| `src/hub.js`      | broker: agents connect (WS :8787); MCP bridge drives it (HTTP 127.0.0.1:8788) |
| `src/agent.js`    | runs on a target machine, dials the hub, executes requests, auto-reconnects |
| `src/mcp.js`      | stdio MCP server Claude Code loads; forwards tool calls to the hub |
| `src/protocol.js` | shared message shapes + helpers |

## 1. Run the hub (on this server)

```bash
export RAH_TOKEN=$(openssl rand -hex 16)    # shared secret; keep it
node src/hub.js
```

Open the agent port (8787) to the networks your agents live on. Keep the
control port (8788) closed — it is bound to localhost. For a real deployment,
front the agent port with TLS (e.g. a reverse proxy giving `wss://`).

## 2. Install an agent (on each client machine)

```bash
# Windows PowerShell
$env:RAH_HUB="ws://YOUR-SERVER:8787"; $env:RAH_TOKEN="<same secret>"; $env:RAH_NAME="dev-box-1"
node src/agent.js

# macOS / Linux
RAH_HUB=ws://YOUR-SERVER:8787 RAH_TOKEN=<same secret> RAH_NAME=dev-box-1 node src/agent.js
```

Only `src/agent.js` + `src/protocol.js` + `ws` are needed on a client. The
agent reconnects every 3s if the hub restarts or the link drops.

## 3. Point Claude Code at the hub

```bash
claude mcp add remote-agent-hub -- node C:/Users/Administrator/Repos/remote-agent-hub/src/mcp.js
```

Then in a session:

- `list_agents` — see who is connected, with each agent's current **workdir**
- `set_workdir { agentId, path }` — like `cd`; absolute or relative (incl. `..`).
  Sticks for all later calls and **survives the agent reconnecting**.
- `list_dir { agentId, path? }` — list a directory relative to the workdir
- `run_command { agentId, cmd, timeout? }` — run a shell command **in the workdir**,
  waiting for it to finish (best for quick commands)
- `start_command { agentId, cmd, timeout? }` — start a long-running command
  (build, test watcher, server) and get a `jobId` back immediately
- `read_output { jobId, cursor?, wait? }` — pull new output from a job from
  `cursor` onward; **long-polls** up to ~8s so output streams in near real time.
  Loop it, passing back the returned `cursor`, until `running` is false
- `kill_command { agentId, jobId }` — force-kill a job (whole process tree)
- `read_file { agentId, path }` / `write_file { agentId, path, content }` — paths
  are relative to the workdir (or absolute); write creates parent dirs

The working directory is remembered by the hub, keyed by agent **name**, so it
behaves like a persistent shell session: set it once and keep working with
relative paths, just like a local checkout.

## Environment

| var | who | meaning |
|-----|-----|---------|
| `RAH_TOKEN`      | hub + agent | shared secret agents present (required) |
| `RAH_HUB`        | agent | ws/wss URL of the hub (required) |
| `RAH_NAME`       | agent | display name (default: hostname) |
| `RAH_SHELL`      | agent | shell for commands (default: powershell on Windows, /bin/sh else) |
| `RAH_CTRL_TOKEN` | hub + mcp | optional extra token on the local control API |
| `RAH_WS_PORT` / `RAH_CTRL_PORT` | hub | override default ports |
| `RAH_LOG`        | hub | audit log path (default: ./hub-audit.log) |

## Hardening before real use

- Put `wss://` (TLS) in front of the agent port; never run the token over plain
  `ws://` across an untrusted network.
- Rotate `RAH_TOKEN` per fleet; a leaked token lets any host register.
- Run agents as a low-privilege user unless a task needs more.
- Ship the audit log somewhere append-only.
