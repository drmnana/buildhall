// BuildHall Bridge — the local app.
//
// Runs on your machine, holds any number of connections (one per agent), and
// serves a small control panel in your browser. Not Electron: a local server
// plus the browser you already have is the same experience without a 100MB
// download or an unsigned binary that trips SmartScreen.
//
//   npm run bridge          -> http://127.0.0.1:7391
//
// Config lives in ~/.buildhall/bridge.json. Bridge tokens are stored there in
// plain text — they are scoped credentials that any logout revokes, but the
// file is written owner-only and the directory is outside the repo.
import express from 'express';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Connection } from './connection.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BRIDGE_PORT) || 7391;
// Bound to loopback on purpose. This panel holds bridge tokens and has no auth
// of its own; it must never be reachable from the network.
const HOST = '127.0.0.1';
const CONFIG_DIR = process.env.BRIDGE_CONFIG_DIR || path.join(homedir(), '.buildhall');
const CONFIG_FILE = path.join(CONFIG_DIR, 'bridge.json');

/** @type {Map<string, Connection>} */
const connections = new Map();

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return { connections: [] };
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return { connections: [] }; }
}

function saveConfig() {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const data = {
    connections: [...connections.values()].map((c) => ({
      id: c.cfg.id, label: c.cfg.label, url: c.cfg.url,
      token: c.cfg.token, group: c.cfg.group, file: c.cfg.file, wake: c.cfg.wake,
    })),
  };
  writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
  try { chmodSync(CONFIG_FILE, 0o600); } catch { /* windows */ }
}

function addConnection(cfg) {
  const conn = new Connection(cfg);
  connections.set(cfg.id, conn);
  conn.start();
  return conn;
}

for (const c of loadConfig().connections) addConnection(c);

// --- control panel API -----------------------------------------------------

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/connections', (_req, res) => {
  res.json({ connections: [...connections.values()].map((c) => c.toJSON()) });
});

app.post('/api/connections', async (req, res) => {
  const { label, token, group, file, url, wake } = req.body ?? {};
  if (!String(token || '').trim()) return res.status(400).json({ error: 'a bridge token is required' });
  if (!String(group || '').trim()) return res.status(400).json({ error: 'a group slug is required' });
  if (!String(file || '').trim()) return res.status(400).json({ error: 'a file path is required' });

  const cfg = {
    id: randomUUID(),
    label: String(label || '').trim() || String(group).trim(),
    token: String(token).trim(),
    group: String(group).trim(),
    file: String(file).trim(),
    url: String(url || 'https://buildhall.ai').trim(),
    wake: String(wake || '').trim() || undefined,
  };

  // Check the token before saving, so a typo surfaces immediately instead of
  // sitting in the config as a permanently broken row.
  try {
    const probe = await fetch(`${cfg.url.replace(/\/$/, '')}/api/auth/me`, {
      headers: { authorization: `Bearer ${cfg.token}` },
    });
    if (probe.status === 401) return res.status(400).json({ error: 'that bridge token was rejected' });
    if (!probe.ok) return res.status(400).json({ error: `could not reach ${cfg.url}` });
    const me = await probe.json();
    if (me.tokenKind !== 'bridge') {
      return res.status(400).json({ error: 'that is a login token, not a bridge token — create one under "Your agents"' });
    }
  } catch {
    return res.status(400).json({ error: `could not reach ${cfg.url}` });
  }

  const conn = addConnection(cfg);
  saveConfig();
  res.status(201).json({ connection: conn.toJSON() });
});

app.delete('/api/connections/:id', (req, res) => {
  const conn = connections.get(req.params.id);
  if (!conn) return res.status(404).json({ error: 'no such connection' });
  conn.stop();
  connections.delete(req.params.id);
  saveConfig();
  res.json({ ok: true });
});

app.post('/api/connections/:id/restart', (req, res) => {
  const conn = connections.get(req.params.id);
  if (!conn) return res.status(404).json({ error: 'no such connection' });
  conn.stop();
  connections.delete(req.params.id);
  const revived = addConnection({ ...conn.cfg });
  connections.set(revived.cfg.id, revived);
  saveConfig();
  res.json({ connection: revived.toJSON() });
});

app.get('/api/config-path', (_req, res) => res.json({ path: CONFIG_FILE }));

const server = createServer(app);
server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`BuildHall Bridge running at ${url}`);
  console.log(`Config: ${CONFIG_FILE}`);
  console.log(`${connections.size} connection(s) restored.`);
  if (process.env.BRIDGE_NO_OPEN !== '1') openBrowser(url);
});

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); }
  catch { /* the URL is printed above either way */ }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const c of connections.values()) c.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
