// Throwaway verification for pinned checkpoints + mutually-exclusive paging.
// Run: DATA_DIR=<tmp> PORT=3999 node verify-checkpoint5.mjs (server spawned here)
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'buildhall-verify-'));
const PORT = 3999;
const base = `http://localhost:${PORT}`;

const server = spawn(process.execPath, ['src/server.js'], {
  env: { ...process.env, DATA_DIR: dataDir, PORT: String(PORT) },
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

async function api(method, url, { user, body } = {}) {
  // `user` is now a bearer token (checkpoint 7 removed the x-user-id header).
  const res = await fetch(base + url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(user ? { authorization: `Bearer ${user}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

try {
  // wait for server
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try {
      await fetch(base + '/api/feed');
      up = true;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (!up) throw new Error('server did not start:\n' + serverLog);

  const sess = await api('POST', '/api/auth/register', {
    body: { username: 'verifier', password: 'verify-pass-123' },
  });
  const userId = sess.json?.token;
  check('session created', sess.status === 201 && !!userId, `status ${sess.status}`);

  const grp = await api('POST', '/api/groups', {
    user: userId,
    body: { slug: 'verify-cp5', name: 'Verify CP5' },
  });
  check('group created', grp.status === 201, `status ${grp.status}`);

  await api('POST', '/api/groups/verify-cp5/join', { user: userId });

  const msg = await api('POST', '/api/groups/verify-cp5/messages', {
    user: userId,
    body: { text: 'plain message to pin' },
  });
  const msgId = msg.json?.message?.id;
  check('plain message posted', msg.status === 201 && Number.isInteger(msgId), `status ${msg.status}, id ${msgId}`);

  const cpOk = await api('POST', '/api/groups/verify-cp5/messages', {
    user: userId,
    body: { kind: 'checkpoint', text: 'checkpoint pinning msg', pinnedMessageId: msgId },
  });
  check(
    'checkpoint with valid pin -> 201 and stores pin',
    cpOk.status === 201 && cpOk.json?.message?.pinned_message_id === msgId,
    `status ${cpOk.status}, pinned_message_id ${cpOk.json?.message?.pinned_message_id}`
  );

  const cpBadPin = await api('POST', '/api/groups/verify-cp5/messages', {
    user: userId,
    body: { kind: 'checkpoint', text: 'bad pin', pinnedMessageId: 999999 },
  });
  check('checkpoint with unknown pin -> 400', cpBadPin.status === 400, `status ${cpBadPin.status}`);

  const pinOnPlain = await api('POST', '/api/groups/verify-cp5/messages', {
    user: userId,
    body: { text: 'not a checkpoint', pinnedMessageId: msgId },
  });
  check('pin on non-checkpoint -> 400', pinOnPlain.status === 400, `status ${pinOnPlain.status}`);

  const cpBadType = await api('POST', '/api/groups/verify-cp5/messages', {
    user: userId,
    body: { kind: 'checkpoint', text: 'bad pin type', pinnedMessageId: 'abc' },
  });
  check('non-integer pin -> 400', cpBadType.status === 400, `status ${cpBadType.status}`);

  const both = await api('GET', '/api/groups/verify-cp5/messages?after=1&before=5', { user: userId });
  check('after+before together -> 400', both.status === 400, `status ${both.status}`);

  const afterOnly = await api('GET', '/api/groups/verify-cp5/messages?after=0', { user: userId });
  check('after alone -> 200', afterOnly.status === 200, `status ${afterOnly.status}`);

  const ctx = await api('GET', '/api/groups/verify-cp5/context?limit=2', { user: userId });
  check(
    'context returns last-N in order + latest checkpoint',
    ctx.status === 200 &&
      ctx.json?.messages?.length === 2 &&
      ctx.json.messages[0].id < ctx.json.messages[1].id &&
      ctx.json?.checkpoint?.kind === 'checkpoint',
    `status ${ctx.status}, ${ctx.json?.messages?.length} messages, checkpoint ${ctx.json?.checkpoint?.id}`
  );

  const ctxBad = await api('GET', '/api/groups/verify-cp5/context?limit=0', { user: userId });
  check('context limit=0 -> 400', ctxBad.status === 400, `status ${ctxBad.status}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exitCode = failed.length ? 1 : 0;
} catch (e) {
  console.error('VERIFY ERROR:', e.message);
  process.exitCode = 1;
} finally {
  server.kill();
  setTimeout(() => rmSync(dataDir, { recursive: true, force: true }), 500);
}
