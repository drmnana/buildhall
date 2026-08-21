// OAuth 2.1 + MCP integration: act as a real MCP client — discovery, dynamic
// registration, PKCE authorize/token, refresh rotation, then the JSON-RPC
// tool surface. Runs its own server instance on its own port so it can run
// concurrently with api.test.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';

const PORT = 3998;
const BASE = `http://127.0.0.1:${PORT}`;
const RUN = `m${Date.now().toString(36)}${process.pid % 100}`;
const PASSWORD = 'Correct-Horse-9-Battery';

let child;
let serverLog = '';

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function json(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { ...(opts.body && !opts.form ? { 'content-type': 'application/json' } : {}), ...opts.headers },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, res };
}

async function makeUser(handle) {
  const email = `${handle}@test.local`;
  const mark = serverLog.length;
  await json('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: handle, email, password: PASSWORD }) });
  await new Promise((r) => setTimeout(r, 300));
  const m = serverLog.slice(mark).match(/verify\?token=([A-Za-z0-9_-]+)/);
  assert.ok(m, 'verification link');
  await fetch(`${BASE}/api/auth/verify?token=${m[1]}`);
  const login = await json('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password: PASSWORD }) });
  return { handle, email, token: login.body.token };
}

function mcp(accessToken, method, params, id = 1) {
  return fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
}

async function callTool(accessToken, name, args) {
  const res = await mcp(accessToken, 'tools/call', { name, arguments: args });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return body.result;
}

before(async () => {
  child = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      ADMIN_HANDLES: `zadmin${RUN}`,
      EMAIL_PROVIDER: 'console',
      APP_BASE_URL: BASE,
    },
  });
  child.stdout.on('data', (d) => { serverLog += d; });
  child.stderr.on('data', (d) => { serverLog += d; });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server did not come up:\n${serverLog.slice(-2000)}`);
});

after(() => { child?.kill('SIGKILL'); });

let owner;        // BuildHall user
let clientId;     // registered OAuth client
let accessToken;  // bridge token via OAuth
let refreshToken;
let agentTokenId;  // the agent's bridge_tokens.id, for the permissions API
const REDIRECT = 'http://127.0.0.1:41234/callback';

test('unauthenticated /mcp returns 401 with resource metadata pointer', async () => {
  const res = await mcp(null, 'initialize', {});
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate') || '', /resource_metadata=/);
  const meta = await json('/.well-known/oauth-protected-resource/mcp');
  assert.equal(meta.body.resource, `${BASE}/mcp`);
  const as = await json('/.well-known/oauth-authorization-server');
  assert.equal(as.body.token_endpoint, `${BASE}/oauth/token`);
  assert.deepEqual(as.body.code_challenge_methods_supported, ['S256']);
});

test('dynamic client registration validates redirect URIs', async () => {
  const bad = await json('/oauth/register', { method: 'POST', body: JSON.stringify({ client_name: 'x', redirect_uris: ['http://evil.example.com/cb'] }) });
  assert.equal(bad.status, 400, 'non-loopback http rejected');
  const ok = await json('/oauth/register', { method: 'POST', body: JSON.stringify({ client_name: 'Claude Code (test)', redirect_uris: [REDIRECT] }) });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  clientId = ok.body.client_id;
  assert.match(clientId, /^bh_/);
});

test('authorize page renders and approve issues a working code (PKCE)', async () => {
  owner = await makeUser(`maher${RUN}`);
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());

  const page = await fetch(`${BASE}/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&code_challenge=${challenge}&code_challenge_method=S256&state=xyz`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Connect Claude Code \(test\)/);

  // the browser page calls this with the logged-in session
  const approve = await json('/api/oauth/approve', {
    method: 'POST',
    headers: { authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, state: 'xyz', agentName: 'claude' }),
  });
  assert.equal(approve.status, 200, JSON.stringify(approve.body));
  const redirect = new URL(approve.body.redirect);
  assert.equal(redirect.searchParams.get('state'), 'xyz');
  const code = redirect.searchParams.get('code');
  assert.ok(code);

  // wrong verifier must fail
  const badTok = await json('/oauth/token', {
    method: 'POST', form: true,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: 'wrong-verifier-wrong-verifier-wrong-verifier' }).toString(),
  });
  assert.equal(badTok.status, 400, 'bad PKCE rejected');

  const tok = await json('/oauth/token', {
    method: 'POST', form: true,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier }).toString(),
  });
  assert.equal(tok.status, 200, JSON.stringify(tok.body));
  assert.equal(tok.body.token_type, 'Bearer');
  accessToken = tok.body.access_token;
  refreshToken = tok.body.refresh_token;
  assert.ok(accessToken && refreshToken);

  // the code is single-use
  const reuse = await json('/oauth/token', {
    method: 'POST', form: true,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier }).toString(),
  });
  assert.equal(reuse.status, 400, 'code reuse rejected');
});

test('MCP initialize + tools/list under the OAuth token', async () => {
  const init = await (await mcp(accessToken, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })).json();
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.match(init.result.instructions, new RegExp(`maher${RUN} claude`));
  const list = await (await mcp(accessToken, 'tools/list', {})).json();
  assert.deepEqual(list.result.tools.map((t) => t.name).sort(),
    ['list_my_projects', 'post_checkpoint', 'post_message', 'read_messages']);
});

test('tools work end to end: list, post (as agent), read with provenance', async () => {
  // operator creates a project in the app
  const slug = `mcp-${RUN}`;
  await json('/api/groups', { method: 'POST', headers: { authorization: `Bearer ${owner.token}` }, body: JSON.stringify({ slug, name: 'MCP Lab', visibility: 'public', goal: 'test the bridge' }) });

  const projects = await callTool(accessToken, 'list_my_projects', {});
  assert.match(projects.content[0].text, new RegExp(slug));
  assert.match(projects.content[0].text, /WATCH-ONLY/, 'public project defaults to watch-only');

  // default-safe: posting to a public project is blocked until the human flips it
  const blocked = await callTool(accessToken, 'post_message', { project: slug, text: 'should not land' });
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /WATCH-ONLY/i);

  // reading is allowed in watch-only
  const watchRead = await callTool(accessToken, 'read_messages', { project: slug });
  assert.equal(watchRead.isError, false);

  // operator flips the agent to participate from the account panel API
  const toks = await json('/api/auth/bridge-tokens', { headers: { authorization: `Bearer ${owner.token}` } });
  agentTokenId = toks.body.bridgeTokens.find((t) => !t.revoked_at).id;
  const matrix = await json(`/api/auth/bridge-tokens/${agentTokenId}/permissions`, { headers: { authorization: `Bearer ${owner.token}` } });
  const entry = matrix.body.permissions.find((p) => p.slug === slug);
  assert.equal(entry.mode, 'watch');
  assert.equal(entry.defaultMode, 'watch');
  const flip = await json(`/api/auth/bridge-tokens/${agentTokenId}/permissions/${slug}`, {
    method: 'PUT', headers: { authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ mode: 'participate' }),
  });
  assert.equal(flip.status, 200, JSON.stringify(flip.body));

  const posted = await callTool(accessToken, 'post_message', { project: slug, text: 'hello from the agent​ side' });
  assert.equal(posted.isError, false);
  assert.match(posted.content[0].text, new RegExp(`maher${RUN} claude`));

  const read = await callTool(accessToken, 'read_messages', { project: slug });
  const text = read.content[0].text;
  assert.match(text, /PROVENANCE/, 'provenance wrapper present');
  assert.match(text, new RegExp(`agent "maher${RUN} claude"`), 'agent attribution');
  assert.ok(text.includes('hello from the agent side'), 'zero-width char stripped');
  assert.ok(!text.includes('​'), 'no invisible chars in output');

  // the message is visible in the normal app API too, attributed to the agent
  const appView = await json(`/api/groups/${slug}/messages`, { headers: { authorization: `Bearer ${owner.token}` } });
  const msg = appView.body.messages.find((m) => m.actor_type === 'ai');
  assert.equal(msg.agent_name, `maher${RUN} claude`);

  // checkpoint works because the operator is project admin
  const cp = await callTool(accessToken, 'post_checkpoint', { project: slug, text: 'first agent checkpoint' });
  assert.equal(cp.isError, false);

  // unknown project is a tool error, not a crash
  const nope = await callTool(accessToken, 'read_messages', { project: 'does-not-exist' });
  assert.equal(nope.isError, true);
});

test('mode none hides the project; private projects default to participate', async () => {
  const slug = `mcp-${RUN}`;
  // none: read blocked, hidden from list
  await json(`/api/auth/bridge-tokens/${agentTokenId}/permissions/${slug}`, {
    method: 'PUT', headers: { authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ mode: 'none' }),
  });
  const denied = await callTool(accessToken, 'read_messages', { project: slug });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /blocked/);
  const listing = await callTool(accessToken, 'list_my_projects', {});
  assert.ok(!listing.content[0].text.includes(slug), 'none-mode project hidden from list');
  // restore participate for the rate-limit test below
  await json(`/api/auth/bridge-tokens/${agentTokenId}/permissions/${slug}`, {
    method: 'PUT', headers: { authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ mode: 'participate' }),
  });

  // private project: agent participates by default, no flip needed
  const priv = `mcp-priv-${RUN}`;
  await json('/api/groups', { method: 'POST', headers: { authorization: `Bearer ${owner.token}` }, body: JSON.stringify({ slug: priv, name: 'Private Lab', visibility: 'private' }) });
  const posted = await callTool(accessToken, 'post_message', { project: priv, text: 'private post, default participate' });
  assert.equal(posted.isError, false, posted.content?.[0]?.text);

  // invalid mode and non-owned token are rejected
  const bad = await json(`/api/auth/bridge-tokens/${agentTokenId}/permissions/${slug}`, {
    method: 'PUT', headers: { authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ mode: 'yolo' }),
  });
  assert.equal(bad.status, 400);
});

test('agent posting rate limit trips at 10/minute', async () => {
  const slug = `mcp-${RUN}`;
  let hitLimit = false;
  for (let i = 0; i < 12; i++) {
    const r = await callTool(accessToken, 'post_message', { project: slug, text: `spam ${i}` });
    if (r.isError && /rate limit/.test(r.content[0].text)) { hitLimit = true; break; }
  }
  assert.ok(hitLimit, 'rate limit engaged');
});

test('refresh rotates the access token and revoking the agent kills the grant', async () => {
  const ref = await json('/oauth/token', {
    method: 'POST', form: true,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }).toString(),
  });
  assert.equal(ref.status, 200, JSON.stringify(ref.body));
  const newAccess = ref.body.access_token;
  assert.ok(newAccess && newAccess !== accessToken);

  // old access token is dead, new one works
  assert.equal((await mcp(accessToken, 'ping', {})).status, 401, 'old token revoked on rotation');
  assert.equal((await mcp(newAccess, 'ping', {})).status, 200, 'new token works');
  accessToken = newAccess;

  // permissions survive rotation: the participate flip on mcp-${RUN} must have
  // been copied to the new bridge token, so the agent can still post
  const stillPosts = await callTool(accessToken, 'post_message', { project: `mcp-${RUN}`, text: 'still participating after refresh' });
  assert.equal(stillPosts.isError, false, 'permission carried across refresh rotation: ' + stillPosts.content?.[0]?.text);

  // operator revokes the agent from the account panel -> everything dies
  const list = await json('/api/auth/bridge-tokens', { headers: { authorization: `Bearer ${owner.token}` } });
  const live = list.body.bridgeTokens.filter((t) => !t.revoked_at);
  for (const t of live) {
    await json(`/api/auth/bridge-tokens/${t.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${owner.token}` } });
  }
  assert.equal((await mcp(accessToken, 'ping', {})).status, 401, 'access dead after panel revoke');
  const refAgain = await json('/oauth/token', {
    method: 'POST', form: true,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }).toString(),
  });
  assert.equal(refAgain.status, 400, 'refresh dead after panel revoke');
});

test('browser session tokens are refused by /mcp', async () => {
  const res = await mcp(owner.token, 'ping', {});
  assert.equal(res.status, 403);
});
