// Verification for checkpoint 7 — session-bound authentication.
// Run: node verify-checkpoint7.mjs   (spawns its own server on a temp DATA_DIR)
//
// The headline assertion is "logout kills the bridge": revoking rows in the
// database is not enough, an already-open connector WebSocket must actually be
// disconnected. That is checked by waiting for a real close event, not by
// re-reading the database.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

const dataDir = mkdtempSync(path.join(tmpdir(), 'buildhall-verify7-'));
const PORT = 3997;
const base = `http://localhost:${PORT}`;
const wsBase = `ws://localhost:${PORT}`;

const server = spawn(process.execPath, ['src/server.js'], {
  env: {
    ...process.env,
    DATA_DIR: dataDir,
    PORT: String(PORT),
    // Tighten the login lockout so the brute-force checks are reachable, and
    // raise the per-IP ceiling so the rest of the suite (all from 127.0.0.1)
    // does not trip it before those checks run.
    LOGIN_MAX_FAILURES: '4',
    LOGIN_IP_MAX_FAILURES: '500',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function api(method, url, { token, body, headers = {} } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

function openSocket(token, groupId) {
  // An empty token must send only the marker — ['bh-token', ''] is an invalid
  // subprotocol list and would throw client-side instead of testing the server.
  const protocols = token ? ['bh-token', token] : ['bh-token'];
  const ws = new WebSocket(`${wsBase}/ws?groupId=${groupId}`, protocols);
  const opened = new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 8000);
    ws.on('open', () => { clearTimeout(t); resolve(true); });
    ws.on('error', () => { clearTimeout(t); resolve(false); });
    ws.on('close', () => { clearTimeout(t); resolve(false); });
  });
  const closed = new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 8000);
    ws.on('close', (code) => { clearTimeout(t); resolve(code); });
  });
  return { ws, opened, closed };
}

try {
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try { await fetch(base + '/health'); up = true; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  if (!up) throw new Error('server did not start:\n' + serverLog);

  // --- registration and login ---------------------------------------------

  const reg = await api('POST', '/api/auth/register', {
    body: { username: 'alice', password: 'correct-horse-battery' },
  });
  const aliceToken = reg.json?.token;
  check('register -> 201 with token', reg.status === 201 && !!aliceToken, `status ${reg.status}`);
  check('register never returns password_hash',
    reg.json?.user && !('password_hash' in reg.json.user), JSON.stringify(Object.keys(reg.json?.user ?? {})));

  const short = await api('POST', '/api/auth/register', { body: { username: 'bob', password: 'short' } });
  check('short password -> 400', short.status === 400, `status ${short.status}`);

  const dupe = await api('POST', '/api/auth/register', {
    body: { username: 'alice', password: 'another-password-99' },
  });
  check('duplicate username -> 409 (no takeover of existing account)', dupe.status === 409, `status ${dupe.status}`);

  const badPw = await api('POST', '/api/auth/login', { body: { username: 'alice', password: 'wrong-password' } });
  check('login wrong password -> 401', badPw.status === 401, `status ${badPw.status}`);

  const noUser = await api('POST', '/api/auth/login', { body: { username: 'ghost', password: 'wrong-password' } });
  check('login unknown user -> 401 with identical message (no enumeration)',
    noUser.status === 401 && noUser.json?.error === badPw.json?.error,
    `${noUser.json?.error} vs ${badPw.json?.error}`);

  const login = await api('POST', '/api/auth/login', {
    body: { username: 'alice', password: 'correct-horse-battery' },
  });
  check('login correct password -> 200 with token', login.status === 200 && !!login.json?.token, `status ${login.status}`);

  // --- the old spoof must be dead -----------------------------------------

  const spoofHeader = await api('GET', '/api/groups', { headers: { 'x-user-id': '1' } });
  check('x-user-id header grants nothing -> 401', spoofHeader.status === 401, `status ${spoofHeader.status}`);

  const noAuth = await api('GET', '/api/groups');
  check('no credentials -> 401', noAuth.status === 401, `status ${noAuth.status}`);

  const garbage = await api('GET', '/api/groups', { token: 'not-a-real-token' });
  check('garbage bearer token -> 401', garbage.status === 401, `status ${garbage.status}`);

  const me = await api('GET', '/api/auth/me', { token: aliceToken });
  check('session token resolves to the right user',
    me.status === 200 && me.json?.user?.username === 'alice' && me.json?.tokenKind === 'session',
    `status ${me.status}, kind ${me.json?.tokenKind}`);

  // --- group setup ---------------------------------------------------------

  const grp = await api('POST', '/api/groups', {
    token: aliceToken, body: { slug: 'cp7', name: 'CP7', visibility: 'private' },
  });
  const groupId = grp.json?.group?.id;
  check('group created', grp.status === 201 && !!groupId, `status ${grp.status}`);
  await api('POST', '/api/groups/cp7/join', { token: aliceToken });

  // --- bridge tokens are children of the session ---------------------------

  const bridge = await api('POST', '/api/auth/bridge-tokens', {
    token: aliceToken, body: { agentName: 'claude' },
  });
  const bridgeToken = bridge.json?.token;
  const bridgeId = bridge.json?.bridgeTokenId;
  check('bridge token minted -> 201', bridge.status === 201 && !!bridgeToken, `status ${bridge.status}`);

  const bridgeMe = await api('GET', '/api/auth/me', { token: bridgeToken });
  check('bridge token resolves to same user, kind=bridge',
    bridgeMe.status === 200 && bridgeMe.json?.user?.username === 'alice' && bridgeMe.json?.tokenKind === 'bridge',
    `kind ${bridgeMe.json?.tokenKind}, agent ${bridgeMe.json?.agentName}`);

  const bridgeEscalate = await api('POST', '/api/auth/bridge-tokens', {
    token: bridgeToken, body: { agentName: 'sneaky' },
  });
  check('bridge token cannot mint more bridge tokens -> 403', bridgeEscalate.status === 403, `status ${bridgeEscalate.status}`);

  const bridgeLogout = await api('POST', '/api/auth/logout', { token: bridgeToken });
  check('bridge token cannot log out the parent session -> 403', bridgeLogout.status === 403, `status ${bridgeLogout.status}`);

  // --- attribution comes from the credential, not the body -----------------

  const humanTriesAi = await api('POST', '/api/groups/cp7/messages', {
    token: aliceToken, body: { text: 'i am totally an agent', actorType: 'ai', agentName: 'gpt-9' },
  });
  check('session token cannot post as an agent (body ignored)',
    humanTriesAi.status === 201 && humanTriesAi.json?.message?.actor_type === 'human'
      && humanTriesAi.json?.message?.agent_name === null,
    `actor_type ${humanTriesAi.json?.message?.actor_type}, agent ${humanTriesAi.json?.message?.agent_name}`);

  const agentPost = await api('POST', '/api/groups/cp7/messages', {
    token: bridgeToken, body: { text: 'posted by the bridge', actorType: 'human', agentName: 'impersonated' },
  });
  check('bridge token posts as its own agent (body ignored)',
    agentPost.status === 201 && agentPost.json?.message?.actor_type === 'ai'
      && agentPost.json?.message?.agent_name === 'alice claude',
    `actor_type ${agentPost.json?.message?.actor_type}, agent ${agentPost.json?.message?.agent_name}`);

  // --- websocket authentication -------------------------------------------

  const anon = openSocket('', groupId);
  check('websocket without a token is rejected', (await anon.opened) === false);
  anon.ws.terminate();

  const bogus = openSocket('not-a-real-token', groupId);
  check('websocket with a bogus token is rejected', (await bogus.opened) === false);
  bogus.ws.terminate();

  const humanSock = openSocket(aliceToken, groupId);
  check('websocket with a session token connects', (await humanSock.opened) === true);

  // --- revoking one bridge token closes only its socket --------------------

  const b2 = await api('POST', '/api/auth/bridge-tokens', { token: aliceToken, body: { agentName: 'codex' } });
  const sock2 = openSocket(b2.json?.token, groupId);
  check('second bridge socket connects', (await sock2.opened) === true);

  const revoke2 = await api('DELETE', `/api/auth/bridge-tokens/${b2.json?.bridgeTokenId}`, { token: aliceToken });
  check('revoking one bridge token reports a closed connection',
    revoke2.status === 200 && revoke2.json?.closedConnections === 1,
    `status ${revoke2.status}, closed ${revoke2.json?.closedConnections}`);
  check('that bridge socket actually closed', (await sock2.closed) !== null);
  check('revoked bridge token is rejected by the API',
    (await api('GET', '/api/auth/me', { token: b2.json?.token })).status === 401);
  check('the session socket survived an unrelated revocation',
    humanSock.ws.readyState === WebSocket.OPEN, `readyState ${humanSock.ws.readyState}`);

  // --- THE HEADLINE: logout kills the bridge -------------------------------

  const agentSock = openSocket(bridgeToken, groupId);
  check('agent bridge socket connected before logout', (await agentSock.opened) === true);

  const logout = await api('POST', '/api/auth/logout', { token: aliceToken });
  check('logout -> 200, reports revoked tokens and closed connections',
    logout.status === 200 && logout.json?.revokedBridgeTokens >= 1 && logout.json?.closedConnections >= 2,
    `revoked ${logout.json?.revokedBridgeTokens}, closed ${logout.json?.closedConnections}`);

  const agentCloseCode = await agentSock.closed;
  check('LOGOUT KILLS BRIDGE: the agent websocket actually disconnected',
    agentCloseCode !== null, `close code ${agentCloseCode}`);
  check('LOGOUT KILLS BRIDGE: the human websocket also disconnected',
    (await humanSock.closed) !== null);

  check('bridge token is dead after parent logout -> 401',
    (await api('GET', '/api/auth/me', { token: bridgeToken })).status === 401);
  check('session token is dead after logout -> 401',
    (await api('GET', '/api/auth/me', { token: aliceToken })).status === 401);
  check('dead bridge token cannot post -> 401',
    (await api('POST', '/api/groups/cp7/messages', { token: bridgeToken, body: { text: 'zombie' } })).status === 401);
  check('dead bridge token cannot reconnect a websocket',
    (await openSocket(bridgeToken, groupId).opened) === false);

  // A fresh login must not resurrect the old children.
  const relogin = await api('POST', '/api/auth/login', {
    body: { username: 'alice', password: 'correct-horse-battery' },
  });
  check('re-login issues a new working session', relogin.status === 200
    && (await api('GET', '/api/auth/me', { token: relogin.json?.token })).status === 200);
  check('old bridge token stays dead after re-login',
    (await api('GET', '/api/auth/me', { token: bridgeToken })).status === 401);

  // --- brute-force protection ----------------------------------------------
  // The server under test runs with LOGIN_MAX_FAILURES=4 (see spawn env) so the
  // lockout is reachable without hammering it hundreds of times.
  await api('POST', '/api/auth/register', { body: { username: 'target', password: 'target-password-1' } });

  let lockedAt = null;
  for (let i = 1; i <= 6 && lockedAt === null; i++) {
    const r = await api('POST', '/api/auth/login', { body: { username: 'target', password: 'wrong-guess' } });
    if (r.status === 429) lockedAt = i;
  }
  check('repeated wrong passwords lock the account out', lockedAt !== null, `429 on attempt ${lockedAt}`);
  check('lockout arrives only after the allowed failures', lockedAt === 5, `attempt ${lockedAt}`);

  const locked = await api('POST', '/api/auth/login', { body: { username: 'target', password: 'target-password-1' } });
  check('the CORRECT password is also refused while locked out', locked.status === 429, `status ${locked.status}`);
  check('429 carries a retryAfterSeconds hint', Number(locked.json?.retryAfterSeconds) > 0, JSON.stringify(locked.json));

  const otherUser = await api('POST', '/api/auth/login', { body: { username: 'alice', password: 'nope-wrong' } });
  check('lockout is scoped to the username, not the whole server', otherUser.status === 401, `status ${otherUser.status}`);

  const ghostLocked = await api('POST', '/api/auth/login', { body: { username: 'target', password: 'x' } });
  check('locked response is identical for any password (no probing)',
    ghostLocked.status === 429 && ghostLocked.json?.error === locked.json?.error);

  // A correct password must clear the counter so real users are not punished
  // for their own typos.
  await api('POST', '/api/auth/register', { body: { username: 'typist', password: 'typist-password-1' } });
  for (let i = 0; i < 3; i++) {
    await api('POST', '/api/auth/login', { body: { username: 'typist', password: 'oops' } });
  }
  const recovered = await api('POST', '/api/auth/login', { body: { username: 'typist', password: 'typist-password-1' } });
  check('a correct password after some typos still succeeds', recovered.status === 200, `status ${recovered.status}`);
  // Three failures already happened before that success. With a max of 4, three
  // MORE failures can only all return 401 if the success genuinely zeroed the
  // counter — otherwise the total would be 6 and the tail would be 429.
  let afterReset = null;
  for (let i = 0; i < 3; i++) {
    afterReset = await api('POST', '/api/auth/login', { body: { username: 'typist', password: 'oops' } });
  }
  check('success reset the counter (3 more failures still only 401)',
    afterReset.status === 401, `status ${afterReset.status}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) console.log('FAILED:', failed.map((f) => f.name).join(' | '));
  process.exitCode = failed.length ? 1 : 0;
} catch (e) {
  console.error('VERIFY ERROR:', e.message, '\n', serverLog);
  process.exitCode = 1;
} finally {
  server.kill();
  setTimeout(() => rmSync(dataDir, { recursive: true, force: true }), 500);
}
