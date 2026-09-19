// Shared protocol constants + tiny helpers for the remote-agent-hub.
// Message shapes (JSON over WebSocket, agent <-> hub):
//   agent -> hub : {t:"register", token, name, meta}
//   hub -> agent : {t:"registered", id} | {t:"denied", reason}
//   hub -> agent : {t:"exec", reqId, cmd, cwd, timeout}
//   agent -> hub : {t:"stdout"|"stderr", reqId, chunk}
//   agent -> hub : {t:"exit", reqId, code, signal, error?}
//   hub -> agent : {t:"read", reqId, path} | {t:"write", reqId, path, dataB64}
//   agent -> hub : {t:"result", reqId, ok, dataB64?, error?}
//   both        : {t:"ping"} / {t:"pong"}

export const HUB_WS_PORT = Number(process.env.RAH_WS_PORT || 8787);
export const HUB_CTRL_PORT = Number(process.env.RAH_CTRL_PORT || 8788);
export const CTRL_HOST = '127.0.0.1'; // control API is localhost-only by design

export function newId(prefix = 'r') {
  return prefix + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function send(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch { /* socket closing */ }
}
