// Verification for checkpoint 8 — the local connector.
// Run: node verify-checkpoint8.mjs
//
// The two things that actually matter are echo loops and replay. A naive
// bridge appends an incoming message to the file, reads it back, posts it, and
// loops forever; and on restart it re-sends the whole file. Both are asserted
// here against a real server and a real connector process.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'buildhall-verify8-'));
const workDir = mkdtempSync(path.join(tmpdir(), 'buildhall-conn-'));
const FILE = path.join(workDir, 'build-up.jsonl');
const PORT = 3995;
const base = `http://localhost:${PORT}`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, ['src/server.js'], {
  env: { ...process.env, DATA_DIR: dataDir, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

let connector = null;
const startConnector = (extraEnv = {}) => spawn(
  process.execPath, ['connector/buildhall-connect.mjs'],
  {
    env: {
      ...process.env,
      BUILDHALL_URL: base,
      BUILDHALL_TOKEN: bridgeToken,
      BUILDHALL_GROUP: 'bridge',
      BUILDHALL_FILE: FILE,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

async function api(method, url, { token, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const lines = () => readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
async function waitFor(fn, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await fn()) return true; await sleep(300); }
  return false;
}

let bridgeToken = null;

try {
  for (let i = 0; i < 40; i++) {
    try { await fetch(base + '/health'); break; }
    catch { await sleep(250); }
  }

  // Two accounts: the connector's owner, and a separate human posting into the
  // group so we can prove the group -> file direction.
  const owner = (await api('POST', '/api/auth/register', { body: { username: 'owner', password: 'owner-password-1' } })).json.token;
  const other = (await api('POST', '/api/auth/register', { body: { username: 'other', password: 'other-password-1' } })).json.token;

  await api('POST', '/api/groups', { token: owner, body: { slug: 'bridge', name: 'Bridge', visibility: 'public' } });
  await api('POST', '/api/groups/bridge/join', { token: owner });
  await api('POST', '/api/groups/bridge/join', { token: other });

  bridgeToken = (await api('POST', '/api/auth/bridge-tokens', { token: owner, body: { agentName: 'codex' } })).json.token;
  check('bridge token minted for the connector', !!bridgeToken);

  // Pre-existing history that must NOT be replayed on first start.
  writeFileSync(FILE, JSON.stringify({ time: new Date().toISOString(), author: 'codex', text: 'ancient history' }) + '\n');

  connector = startConnector();
  let connLog = '';
  connector.stdout.on('data', (d) => (connLog += d));
  connector.stderr.on('data', (d) => (connLog += d));
  await sleep(3000);

  const afterStart = (await api('GET', '/api/groups/bridge/messages', { token: owner })).json.messages;
  check('existing file history is NOT replayed on first start', afterStart.length === 0, `${afterStart.length} messages`);

  // --- file -> group -------------------------------------------------------
  appendFileSync(FILE, JSON.stringify({ time: new Date().toISOString(), author: 'codex', text: 'hello from the file' }) + '\n');
  const posted = await waitFor(async () => {
    const m = (await api('GET', '/api/groups/bridge/messages', { token: owner })).json.messages;
    return m.some((x) => x.text === 'hello from the file');
  });
  check('a new line in the file is posted to the group', posted);

  const msgs = (await api('GET', '/api/groups/bridge/messages', { token: owner })).json.messages;
  const mine = msgs.find((m) => m.text === 'hello from the file');
  check('posted as the agent the bridge token names, not a human',
    mine?.actor_type === 'ai' && mine?.agent_name === 'codex', `${mine?.actor_type}/${mine?.agent_name}`);

  // --- no echo loop --------------------------------------------------------
  await sleep(3000);
  const echoCount = (await api('GET', '/api/groups/bridge/messages', { token: owner }))
    .json.messages.filter((m) => m.text === 'hello from the file').length;
  check('the connector does not repost its own message (no echo loop)', echoCount === 1, `${echoCount} copies`);

  // --- group -> file -------------------------------------------------------
  await api('POST', '/api/groups/bridge/messages', { token: other, body: { text: 'hello from a human' } });
  const landed = await waitFor(() => lines().some((l) => l.text === 'hello from a human'));
  check('a group message is appended back to the file', landed);

  const appended = lines().find((l) => l.text === 'hello from a human');
  check('appended line is tagged as ours so it is never re-posted',
    appended?.source === 'buildhall', JSON.stringify(appended));

  await sleep(3000);
  const humanCopies = (await api('GET', '/api/groups/bridge/messages', { token: owner }))
    .json.messages.filter((m) => m.text === 'hello from a human').length;
  check('the appended line is not sent back to the group (no loop)', humanCopies === 1, `${humanCopies} copies`);

  const ownEcho = lines().filter((l) => l.text === 'hello from the file').length;
  check('our own posted message is not appended back to the file', ownEcho === 1, `${ownEcho} copies`);

  // --- restart must not replay --------------------------------------------
  connector.kill();
  await sleep(1000);
  const before = (await api('GET', '/api/groups/bridge/messages', { token: owner })).json.messages.length;
  connector = startConnector();
  await sleep(4000);
  const after = (await api('GET', '/api/groups/bridge/messages', { token: owner })).json.messages.length;
  check('restarting the connector does not replay the file', after === before, `${before} -> ${after}`);

  // --- a line written while it was down is still delivered -----------------
  connector.kill();
  await sleep(500);
  appendFileSync(FILE, JSON.stringify({ time: new Date().toISOString(), author: 'codex', text: 'written while offline' }) + '\n');
  connector = startConnector();
  const caughtUp = await waitFor(async () => {
    const m = (await api('GET', '/api/groups/bridge/messages', { token: owner })).json.messages;
    return m.some((x) => x.text === 'written while offline');
  }, 20000);
  check('a line added while the connector was down is delivered on restart', caughtUp);

  // --- revoked token exits rather than spinning ----------------------------
  await api('POST', '/api/auth/logout', { token: owner });
  const exited = await waitFor(() => connector.exitCode !== null, 15000);
  check('connector exits when its parent session is logged out', exited, `exit code ${connector.exitCode}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) console.log('FAILED:', failed.map((f) => f.name).join(' | '), '\n', connLog);
  process.exitCode = failed.length ? 1 : 0;
} catch (e) {
  console.error('VERIFY ERROR:', e.message, '\n', serverLog);
  process.exitCode = 1;
} finally {
  connector?.kill();
  server.kill();
  setTimeout(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }, 500);
}
