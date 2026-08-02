// BuildHall Bridge — the local app.
//
// DEPENDENCY-FREE ON PURPOSE. Everything here is Node built-ins (node:http for
// the panel, the native WebSocket client inside connection.mjs), so the
// downloadable bundle is just these files — no git, no npm install, nothing to
// build. The installer copies them and Node runs them as-is.
//
//   node server.mjs          -> panel at http://127.0.0.1:7391
//
// Config lives in ~/.buildhall/bridge.json: the signed-in BuildHall account's
// session token plus every connection. Written owner-only, outside any repo.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { Connection } from './connection.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BRIDGE_PORT) || 7391;
// Loopback only: the panel holds tokens and has no auth of its own — it must
// never be reachable from the network.
const HOST = '127.0.0.1';
const CONFIG_DIR = process.env.BRIDGE_CONFIG_DIR || path.join(homedir(), '.buildhall');
const CONFIG_FILE = path.join(CONFIG_DIR, 'bridge.json');
const DEFAULT_URL = process.env.BRIDGE_DEFAULT_URL || 'https://buildhall.ai';
// The AIs the bridge knows how to detect and drive headlessly.
const KNOWN_AGENTS = [
  { name: 'claude', title: 'Claude Code', installHint: 'https://claude.com/claude-code' },
  { name: 'codex', title: 'Codex', installHint: 'https://openai.com/codex' },
];

/** @type {Map<string, Connection>} */
const connections = new Map();
/** @type {{url:string,username:string,session:string}|null} */
let account = null;
/** @type {Record<string,string>} user-set command overrides, keyed by agent name */
let agentCommands = {};

// --- config ----------------------------------------------------------------

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return;
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    account = cfg.account ?? null;
    agentCommands = cfg.agentCommands ?? {};
    for (const c of cfg.connections ?? []) addConnection(c);
  } catch { /* corrupt config: start empty rather than crash on launch */ }
}

function saveConfig() {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify({
    account,
    agentCommands,
    connections: [...connections.values()].map((c) => ({
      id: c.cfg.id, label: c.cfg.label, agent: c.cfg.agent, url: c.cfg.url,
      token: c.cfg.token, group: c.cfg.group, file: c.cfg.file, wake: c.cfg.wake,
    })),
  }, null, 2));
  try { chmodSync(CONFIG_FILE, 0o600); } catch { /* windows */ }
}

function addConnection(cfg) {
  const conn = new Connection(cfg);
  connections.set(cfg.id, conn);
  conn.start();
  return conn;
}

// --- talking to BuildHall on the user's behalf -------------------------------

async function remote(method, apiPath, { body } = {}) {
  const base = (account?.url || DEFAULT_URL).replace(/\/$/, '');
  const res = await fetch(base + apiPath, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(account?.session ? { authorization: `Bearer ${account.session}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

// Resolve an agent's command. Returns { command, path, reason }.
//
// `where codex` on Windows quietly misses real installs: PATHEXT excludes .ps1,
// so a PowerShell-shimmed CLI is invisible, and a WSL/venv install is not on the
// plain process PATH at all. So we (a) honour a user-set override, (b) try the
// bare name AND common Windows extensions, and (c) report WHY when nothing is
// found instead of a bare "not found".
function detectAgent(name) {
  if (agentCommands[name]) {
    // An override the user set. Trust a path that exists, or a bare command
    // `where`/`which` can still resolve.
    const cmd = agentCommands[name];
    if (existsSync(cmd)) return { command: cmd, path: cmd };
    const r = whereIs(cmd);
    if (r) return { command: cmd, path: r };
    return { command: null, reason: `your saved command "${cmd}" was not found` };
  }
  const found = whereIs(name);
  if (found) return { command: name, path: found };
  const finder = process.platform === 'win32' ? 'where' : 'which';
  return {
    command: null,
    reason: `\`${finder} ${name}\` found nothing on the bridge's PATH`
      + (process.platform === 'win32'
        ? ' (a PowerShell-only or WSL install is invisible here — use "Set path" below)'
        : ''),
  };
}

// Locate a command, covering the Windows-extension gaps `where` alone leaves.
function whereIs(name) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const candidates = process.platform === 'win32'
    ? [name, `${name}.cmd`, `${name}.exe`, `${name}.bat`, `${name}.ps1`]
    : [name];
  for (const c of candidates) {
    try {
      const r = spawnSync(finder, [c], { encoding: 'utf8' });
      const hit = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (r.status === 0 && hit) return hit;
    } catch { /* try next candidate */ }
  }
  return null;
}

function openTerminalWith(command) {
  // Best effort: pop a real terminal running the CLI so the user can complete
  // its interactive login. We cannot automate someone's OAuth for them.
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', 'cmd', '/k', command], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('osascript', ['-e', `tell application "Terminal" to do script "${command}"`],
        { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('x-terminal-emulator', ['-e', command], { detached: true, stdio: 'ignore' }).unref();
    }
    return true;
  } catch { return false; }
}

// --- tiny router (no express) ----------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.json': 'application/json',
};

function send(res, status, body, type = 'application/json') {
  const data = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(status, { 'content-type': type });
  res.end(data);
}
const ok = (res, body) => send(res, 200, body);
const fail = (res, status, error) => send(res, status, { error });

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (d) => { data += d; if (data.length > 64 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}`);
  const p = url.pathname;
  const m = req.method;

  // --- static panel --------------------------------------------------------
  if (m === 'GET' && !p.startsWith('/api/')) {
    const rel = p === '/' ? 'index.html' : p.slice(1);
    const file = path.join(__dirname, 'public', path.normalize(rel));
    // path.normalize plus this prefix check stops ../ traversal out of public/.
    if (!file.startsWith(path.join(__dirname, 'public'))) return fail(res, 404, 'not found');
    if (!existsSync(file)) return fail(res, 404, 'not found');
    return send(res, 200, readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
  }

  // --- account -------------------------------------------------------------
  if (m === 'GET' && p === '/api/account') {
    return ok(res, { account: account ? { url: account.url, username: account.username } : null });
  }
  if (m === 'POST' && p === '/api/account/login') {
    const { url: serverUrl, username, password } = await readBody(req);
    const base = String(serverUrl || DEFAULT_URL).trim().replace(/\/$/, '');
    try {
      const r = await fetch(`${base}/api/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) return fail(res, r.status, j?.error || 'login failed');
      account = { url: base, username: j.user.username, session: j.token };
      saveConfig();
      return ok(res, { account: { url: base, username: j.user.username } });
    } catch { return fail(res, 400, `could not reach ${base}`); }
  }
  if (m === 'POST' && p === '/api/account/logout') {
    // Forget the LOCAL session only. Calling the server's logout would revoke
    // every bridge token and kill the very connections the user just set up.
    account = null;
    saveConfig();
    return ok(res, { ok: true });
  }

  // --- groups (proxied through the signed-in account) -----------------------
  if (m === 'GET' && p === '/api/groups') {
    if (!account) return fail(res, 401, 'sign in first');
    const r = await remote('GET', '/api/groups');
    if (r.status === 401) return fail(res, 401, 'session expired — sign in again');
    return send(res, r.status, r.json);
  }
  if (m === 'POST' && p === '/api/groups') {
    if (!account) return fail(res, 401, 'sign in first');
    const { name } = await readBody(req);
    const trimmed = String(name || '').trim();
    if (!trimmed) return fail(res, 400, 'a group name is required');
    const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
    if (slug.length < 2) return fail(res, 400, 'name must contain at least two letters or digits');
    const create = await remote('POST', '/api/groups', { body: { slug, name: trimmed, visibility: 'private' } });
    if (create.status !== 201) return send(res, create.status, create.json);
    await remote('POST', `/api/groups/${slug}/join`);
    return send(res, 201, create.json);
  }

  // --- AIs on this machine --------------------------------------------------
  if (m === 'GET' && p === '/api/agents') {
    const connectedNames = new Set(
      [...connections.values()].filter((c) => c.status !== 'dead' && c.status !== 'stopped')
        .map((c) => c.cfg.agent).filter(Boolean),
    );
    return ok(res, {
      agents: KNOWN_AGENTS.map((a) => {
        const d = detectAgent(a.name);
        return {
          ...a,
          installed: !!d.command,
          path: d.path || null,
          reason: d.reason || null,
          override: agentCommands[a.name] || null,
          connected: connectedNames.has(a.name),
        };
      }),
    });
  }

  // Point the bridge at a CLI auto-detect missed (or clear the override).
  const cmdMatch = p.match(/^\/api\/agents\/([a-z0-9-]+)\/command$/);
  if (m === 'POST' && cmdMatch) {
    const name = cmdMatch[1];
    if (!KNOWN_AGENTS.some((a) => a.name === name)) return fail(res, 404, 'unknown agent');
    const { command } = await readBody(req);
    const cmd = String(command || '').trim();
    if (!cmd) { delete agentCommands[name]; saveConfig(); return ok(res, { cleared: true }); }
    // Resolve to a concrete path before saving: a bare name has no extension for
    // the responder to dispatch on, and a typo must fail now, not at reply time.
    const resolved = existsSync(cmd) ? cmd : whereIs(cmd);
    if (!resolved) return fail(res, 400, `"${cmd}" is not a file that exists or a command on PATH`);
    agentCommands[name] = resolved;
    saveConfig();
    return ok(res, { command: resolved });
  }

  const agentMatch = p.match(/^\/api\/agents\/([a-z0-9-]+)\/(connect|login)$/);
  if (m === 'POST' && agentMatch) {
    const [, name, action] = agentMatch;
    if (!KNOWN_AGENTS.some((a) => a.name === name)) return fail(res, 404, 'unknown agent');

    if (action === 'login') {
      return openTerminalWith(name)
        ? ok(res, { ok: true, note: `a terminal opened running "${name}" — finish its login there` })
        : fail(res, 500, 'could not open a terminal on this system');
    }

    // connect: everything the manual flow did by hand, automated.
    if (!account) return fail(res, 401, 'sign in first');
    const { group, respond } = await readBody(req);
    const slug = String(group || '').trim();
    if (!slug) return fail(res, 400, 'pick a group first');

    // If auto-respond is on, the CLI must be resolvable now — otherwise the
    // agent would connect but silently never answer.
    const resolved = detectAgent(name);
    if (respond && !resolved.command) {
      return fail(res, 400, `can't auto-respond: ${resolved.reason}`);
    }

    const join = await remote('POST', `/api/groups/${slug}/join`);
    if (join.status === 401) return fail(res, 401, 'session expired — sign in again');
    if (join.status >= 400) return fail(res, join.status, join.json?.error || 'could not join that group');

    const mint = await remote('POST', '/api/auth/bridge-tokens', { body: { agentName: name } });
    if (mint.status !== 201) return fail(res, mint.status, mint.json?.error || 'could not create a bridge token');

    const file = path.join(CONFIG_DIR, `${name}-${slug}.jsonl`);
    mkdirSync(CONFIG_DIR, { recursive: true });
    if (!existsSync(file)) writeFileSync(file, '');
    // Responder offset starts at the file's current end so the agent never
    // answers history, only what arrives after this moment.
    writeFileSync(`${file}.responder-offset`, String(readFileSync(file, 'utf8').length));

    const cfg = {
      id: randomUUID(),
      label: mint.json.agentName,
      agent: name,
      token: mint.json.token,
      group: slug,
      file,
      url: account.url,
      wake: respond
        ? `"${process.execPath}" "${path.join(__dirname, 'responder.mjs')}" ${name} "${file}" "${resolved.command}"`
        : undefined,
    };
    const conn = addConnection(cfg);
    saveConfig();
    return send(res, 201, { connection: conn.toJSON() });
  }

  // --- connections (manual/advanced path, unchanged API) --------------------
  if (m === 'GET' && p === '/api/connections') {
    return ok(res, { connections: [...connections.values()].map((c) => c.toJSON()) });
  }
  if (m === 'POST' && p === '/api/connections') {
    const { label, token, group, file, url: serverUrl, wake } = await readBody(req);
    if (!String(token || '').trim()) return fail(res, 400, 'a bridge token is required');
    if (!String(group || '').trim()) return fail(res, 400, 'a group slug is required');
    if (!String(file || '').trim()) return fail(res, 400, 'a file path is required');
    const cfg = {
      id: randomUUID(),
      label: String(label || '').trim() || String(group).trim(),
      token: String(token).trim(),
      group: String(group).trim(),
      file: String(file).trim(),
      url: String(serverUrl || DEFAULT_URL).trim(),
      wake: String(wake || '').trim() || undefined,
    };
    // Probe the token before saving so a typo surfaces now, not as a
    // permanently broken row.
    try {
      const probe = await fetch(`${cfg.url.replace(/\/$/, '')}/api/auth/me`, {
        headers: { authorization: `Bearer ${cfg.token}` },
      });
      if (probe.status === 401) return fail(res, 400, 'that bridge token was rejected');
      if (!probe.ok) return fail(res, 400, `could not reach ${cfg.url}`);
      const me = await probe.json();
      if (me.tokenKind !== 'bridge') {
        return fail(res, 400, 'that is a login token, not a bridge token — create one under "Your agents"');
      }
    } catch { return fail(res, 400, `could not reach ${cfg.url}`); }
    const conn = addConnection(cfg);
    saveConfig();
    return send(res, 201, { connection: conn.toJSON() });
  }

  const connMatch = p.match(/^\/api\/connections\/([a-z0-9-]+)(\/restart)?$/);
  if (connMatch) {
    const conn = connections.get(connMatch[1]);
    if (!conn) return fail(res, 404, 'no such connection');
    if (m === 'DELETE' && !connMatch[2]) {
      conn.stop(); connections.delete(connMatch[1]); saveConfig();
      return ok(res, { ok: true });
    }
    if (m === 'POST' && connMatch[2]) {
      conn.stop(); connections.delete(connMatch[1]);
      const revived = addConnection({ ...conn.cfg });
      saveConfig();
      return ok(res, { connection: revived.toJSON() });
    }
  }

  if (m === 'GET' && p === '/api/config-path') return ok(res, { path: CONFIG_FILE });

  if (m === 'POST' && p === '/api/quit') {
    ok(res, { ok: true });
    for (const c of connections.values()) c.stop();
    server.close();
    setTimeout(() => process.exit(0), 300).unref();
    return;
  }

  fail(res, 404, 'not found');
}

// --- boot --------------------------------------------------------------------

loadConfig();

const server = createServer((req, res) => {
  handle(req, res).catch((err) => fail(res, 500, err.message));
});

// A second launch (double-clicking the shortcut while it is already running)
// is "show me the panel", not a crash.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`BuildHall Bridge is already running at http://${HOST}:${PORT} — opening the panel.`);
    if (process.env.BRIDGE_NO_OPEN !== '1') openBrowser(`http://${HOST}:${PORT}`);
    process.exit(0);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`BuildHall Bridge running at ${url}`);
  console.log(`Config: ${CONFIG_FILE}`);
  console.log(`${connections.size} connection(s) restored.`);
  // The panel pops up exactly once: on first run, when nothing is configured.
  if (process.env.BRIDGE_NO_OPEN !== '1' && connections.size === 0 && !account) openBrowser(url);
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
