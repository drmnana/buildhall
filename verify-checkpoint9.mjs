// Verification for checkpoint 9 — the local Bridge app.
// Run: node verify-checkpoint9.mjs
//
// The point of the app over the single-agent CLI is that ONE process runs
// several connections at once and remembers them across restarts. Both of those
// are asserted here, along with the two ways a user gets it wrong: pasting a
// login token instead of a bridge token, and pasting a dead one.
import { spawn } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'bh-verify9-'));
const workDir = mkdtempSync(path.join(tmpdir(), 'bh-work9-'));
const cfgDir = mkdtempSync(path.join(tmpdir(), 'bh-cfg9-'));
const APP_PORT = 3994;
const BRIDGE_PORT = 7394;
const app = `http://127.0.0.1:${APP_PORT}`;
const bridge = `http://127.0.0.1:${BRIDGE_PORT}`;
const fileA = path.join(workDir, 'claude.jsonl');
const fileB = path.join(workDir, 'codex.jsonl');

// A fake `claude` CLI on PATH: detection finds it, and the responder invokes it.
const binDir = mkdtempSync(path.join(tmpdir(), 'bh-bin9-'));
writeFileSync(path.join(binDir, 'claude'), '#!/bin/sh\necho "auto-reply from fake claude"\n');
chmodSync(path.join(binDir, 'claude'), 0o755);

const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' — ' + d : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, ['src/server.js'], {
  env: { ...process.env, DATA_DIR: dataDir, PORT: String(APP_PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = ''; server.stdout.on('data', (d) => (serverLog += d)); server.stderr.on('data', (d) => (serverLog += d));

let bridgeProc = null;
const startBridge = () => {
  const p = spawn(process.execPath, ['bridge/server.mjs'], {
    env: {
      ...process.env,
      BRIDGE_PORT: String(BRIDGE_PORT),
      BRIDGE_CONFIG_DIR: cfgDir,
      BRIDGE_NO_OPEN: '1',      // never launch a browser inside a test
      PATH: `${binDir}:${process.env.PATH}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', (d) => (bridgeLog += d));
  p.stderr.on('data', (d) => (bridgeLog += d));
  return p;
};
let bridgeLog = '';

const api = async (baseUrl, method, url, { token, body } = {}) => {
  const res = await fetch(baseUrl + url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const lines = (f) => readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const waitFor = async (fn, ms = 20000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await fn()) return true; await sleep(400); }
  return false;
};
const conns = async () => (await api(bridge, 'GET', '/api/connections')).json.connections;

try {
  for (let i = 0; i < 40; i++) { try { await fetch(app + '/health'); break; } catch { await sleep(250); } }

  const owner = (await api(app, 'POST', '/api/auth/register', { body: { username: 'bridgeowner', password: 'bridge-owner-pw-1' } })).json.token;
  await api(app, 'POST', '/api/groups', { token: owner, body: { slug: 'hall', name: 'Hall', visibility: 'private' } });
  await api(app, 'POST', '/api/groups/hall/join', { token: owner });
  const tokA = (await api(app, 'POST', '/api/auth/bridge-tokens', { token: owner, body: { agentName: 'claude' } })).json.token;
  const tokB = (await api(app, 'POST', '/api/auth/bridge-tokens', { token: owner, body: { agentName: 'codex' } })).json.token;

  writeFileSync(fileA, ''); writeFileSync(fileB, '');
  bridgeProc = startBridge();
  for (let i = 0; i < 40; i++) { try { await fetch(bridge + '/api/connections'); break; } catch { await sleep(250); } }
  check('bridge app starts with no connections', (await conns()).length === 0);

  // --- input validation ----------------------------------------------------
  const loginTok = await api(bridge, 'POST', '/api/connections', {
    body: { label: 'oops', token: owner, group: 'hall', file: fileA, url: app },
  });
  check('a LOGIN token is rejected with a useful message',
    loginTok.status === 400 && /bridge token/i.test(loginTok.json?.error || ''), loginTok.json?.error);

  const badTok = await api(bridge, 'POST', '/api/connections', {
    body: { label: 'oops', token: 'not-a-token', group: 'hall', file: fileA, url: app },
  });
  check('a dead token is rejected before it is saved', badTok.status === 400, badTok.json?.error);
  check('nothing broken was saved', (await conns()).length === 0);

  // --- two agents, one app -------------------------------------------------
  const marker = path.join(workDir, 'woke.txt');
  const a = await api(bridge, 'POST', '/api/connections', {
    body: { label: 'Claude', token: tokA, group: 'hall', file: fileA, url: app,
            wake: `echo woke >> ${marker}` },
  });
  const b = await api(bridge, 'POST', '/api/connections', {
    body: { label: 'Codex', token: tokB, group: 'hall', file: fileB, url: app },
  });
  check('two connections added to one app', a.status === 201 && b.status === 201);
  check('both report live', await waitFor(async () => (await conns()).filter((c) => c.status === 'live').length === 2),
    JSON.stringify((await conns()).map((c) => c.status)));

  // --- each file posts as its own agent ------------------------------------
  appendFileSync(fileA, JSON.stringify({ time: new Date().toISOString(), author: 'claude', text: 'from claude file' }) + '\n');
  appendFileSync(fileB, JSON.stringify({ time: new Date().toISOString(), author: 'codex', text: 'from codex file' }) + '\n');
  const bothArrived = await waitFor(async () => {
    const m = (await api(app, 'GET', '/api/groups/hall/messages', { token: owner })).json.messages;
    return m.some((x) => x.text === 'from claude file') && m.some((x) => x.text === 'from codex file');
  });
  check('both agents deliver into the same group', bothArrived);

  const msgs = (await api(app, 'GET', '/api/groups/hall/messages', { token: owner })).json.messages;
  const fromA = msgs.find((m) => m.text === 'from claude file');
  const fromB = msgs.find((m) => m.text === 'from codex file');
  check('each is attributed to its own agent name',
    fromA?.agent_name === 'bridgeowner claude' && fromB?.agent_name === 'bridgeowner codex', `${fromA?.agent_name} / ${fromB?.agent_name}`);

  // --- cross delivery: each agent sees the other's message ------------------
  check("claude's file receives codex's message", await waitFor(() => lines(fileA).some((l) => l.text === 'from codex file')));
  check("codex's file receives claude's message", await waitFor(() => lines(fileB).some((l) => l.text === 'from claude file')));
  check('wake command fires when a message lands in the file',
    await waitFor(() => existsSync(marker), 15000));

  await sleep(4000);
  const after = (await api(app, 'GET', '/api/groups/hall/messages', { token: owner })).json.messages;
  check('no cross-talk loop between the two connections',
    after.filter((m) => m.text === 'from claude file').length === 1
    && after.filter((m) => m.text === 'from codex file').length === 1, `${after.length} messages total`);

  // --- persistence across an app restart -----------------------------------
  const saved = JSON.parse(readFileSync(path.join(cfgDir, 'bridge.json'), 'utf8'));
  check('config persisted to disk', saved.connections?.length === 2);
  bridgeProc.kill(); await sleep(1200);
  bridgeProc = startBridge();
  for (let i = 0; i < 40; i++) { try { await fetch(bridge + '/api/connections'); break; } catch { await sleep(250); } }
  check('both connections restored after restarting the app',
    await waitFor(async () => (await conns()).filter((c) => c.status === 'live').length === 2),
    JSON.stringify((await conns()).map((c) => c.status)));

  const beforeCount = (await api(app, 'GET', '/api/groups/hall/messages', { token: owner })).json.messages.length;
  await sleep(3000);
  const afterCount = (await api(app, 'GET', '/api/groups/hall/messages', { token: owner })).json.messages.length;
  check('restart does not replay either file', beforeCount === afterCount, `${beforeCount} -> ${afterCount}`);

  // --- second launch while running -----------------------------------------
  const dupe = startBridge();
  check('a second launch notices the running app and exits cleanly',
    await waitFor(() => dupe.exitCode === 0, 10000), `exit ${dupe.exitCode}`);

  // --- removing one leaves the other alone ---------------------------------
  const list = await conns();
  await api(bridge, 'DELETE', `/api/connections/${list[0].id}`);
  const remaining = await conns();
  check('removing one connection leaves the other running',
    remaining.length === 1 && remaining[0].status === 'live', JSON.stringify(remaining.map((c) => c.status)));

  // --- logout kills every connection ---------------------------------------
  await api(app, 'POST', '/api/auth/logout', { token: owner });
  check('logging out marks the surviving connection dead',
    await waitFor(async () => (await conns()).every((c) => c.status === 'dead')),
    JSON.stringify((await conns()).map((c) => `${c.status}:${c.detail}`)));

  // --- guided flow: sign in, detect, one-click connect, auto-respond -------
  const panelLogin = await api(bridge, 'POST', '/api/account/login', {
    body: { url: app, username: 'bridgeowner', password: 'bridge-owner-pw-1' },
  });
  check('panel sign-in works', panelLogin.status === 200 && panelLogin.json?.account?.username === 'bridgeowner',
    JSON.stringify(panelLogin.json));

  const agents = (await api(bridge, 'GET', '/api/agents')).json.agents;
  const claudeAgent = agents.find((a) => a.name === 'claude');
  check('claude CLI detected on this machine', claudeAgent?.installed === true,
    JSON.stringify(agents.map((a) => `${a.name}:${a.installed}`)));

  const mkGroup = await api(bridge, 'POST', '/api/groups', { body: { name: 'Guided Hall' } });
  check('panel can create a group', mkGroup.status === 201 && mkGroup.json?.group?.slug === 'guided-hall',
    JSON.stringify(mkGroup.json));
  const proxied = (await api(bridge, 'GET', '/api/groups')).json.groups;
  check('panel lists the account groups', proxied.some((g) => g.slug === 'guided-hall'));

  const oneClick = await api(bridge, 'POST', '/api/agents/claude/connect', {
    body: { group: 'guided-hall', respond: true },
  });
  check('one-click connect mints a token and starts a connection',
    oneClick.status === 201 && oneClick.json?.connection?.label === 'bridgeowner claude',
    JSON.stringify(oneClick.json));
  check('guided connection reports live', await waitFor(async () =>
    (await conns()).some((c) => c.group === 'guided-hall' && c.status === 'live')));

  // A human posts; the fake CLI must answer as the agent — the full loop. The
  // group is private (panel default), so the human is the owner: a fresh login
  // session posting as themselves.
  const human2 = (await api(app, 'POST', '/api/auth/login',
    { body: { username: 'bridgeowner', password: 'bridge-owner-pw-1' } })).json.token;
  await api(app, 'POST', '/api/groups/guided-hall/messages', { token: human2, body: { text: 'hello agent' } });
  check('auto-respond: human message gets an AI reply in the group', await waitFor(async () => {
    const msgs = (await api(app, 'GET', '/api/groups/guided-hall/messages', { token: human2 })).json.messages;
    return msgs.some((x) => x.text === 'auto-reply from fake claude'
      && x.actor_type === 'ai' && x.agent_name === 'bridgeowner claude');
  }, 30000));

  // Loop safety: agent-authored messages must NOT trigger a reply.
  const aiTok = (await api(app, 'POST', '/api/auth/bridge-tokens',
    { token: human2, body: { agentName: 'otherbot' } })).json.token;
  await api(app, 'POST', '/api/groups/guided-hall/messages', { token: aiTok, body: { text: 'ai chatter' } });
  await sleep(7000);
  const finalMsgs = (await api(app, 'GET', '/api/groups/guided-hall/messages', { token: human2 })).json.messages;
  check('responder ignores AI-authored messages (no agent-to-agent loop)',
    finalMsgs.filter((x) => x.text === 'auto-reply from fake claude').length === 1,
    `${finalMsgs.length} messages total`);

  // --- download endpoints on the main server --------------------------------
  const manifest = await api(app, 'GET', '/download/manifest.json');
  check('download manifest lists the bridge files',
    manifest.status === 200 && manifest.json?.files?.includes('server.mjs'));
  const src = await fetch(`${app}/bridge-src/server.mjs`);
  check('bridge source files are served', src.status === 200 && (await src.text()).includes('BuildHall Bridge'));
  const ps1 = await fetch(`${app}/download/bridge.ps1`);
  check('windows installer served', ps1.status === 200 && (await ps1.text()).includes('BuildHall'));
  const cmd = await fetch(`${app}/download/bridge-setup.cmd`);
  check('setup.cmd download served as attachment',
    cmd.status === 200 && /attachment/.test(cmd.headers.get('content-disposition') || ''));
  const traversal = await fetch(`${app}/bridge-src/../src/db.js`);
  check('path traversal out of bridge-src is blocked', traversal.status !== 200, `status ${traversal.status}`);

  // --- quit endpoint --------------------------------------------------------
  const quit = await api(bridge, 'POST', '/api/quit');
  check('quit endpoint stops the app',
    quit.status === 200 && await waitFor(() => bridgeProc.exitCode !== null, 10000),
    `exit ${bridgeProc.exitCode}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) console.log('FAILED:', failed.map((f) => f.n).join(' | '), '\n', bridgeLog.slice(-1500));
  process.exitCode = failed.length ? 1 : 0;
} catch (e) {
  console.error('VERIFY ERROR:', e.message, '\n', serverLog.slice(-800), '\n', bridgeLog.slice(-800));
  process.exitCode = 1;
} finally {
  bridgeProc?.kill();
  server.kill();
  setTimeout(() => {
    for (const d of [dataDir, workDir, cfgDir, binDir]) rmSync(d, { recursive: true, force: true });
  }, 500);
}
