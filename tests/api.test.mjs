// Integration tests: boot the real server against a disposable Postgres and
// exercise the API over HTTP — the same surface the frontends and agents use.
//
//   DATABASE_URL must point at a DISPOSABLE database (tables are created by
//   the server's own schema bootstrap; rows accumulate per run — CI uses a
//   fresh container, local runs use a scratch db).
//
// Run: npm test   (node --test tests/)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const PORT = process.env.TEST_PORT || 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const RUN = `${Date.now().toString(36)}${process.pid % 100}`; // unique per run
const PASSWORD = 'Correct-Horse-9-Battery';

let child;
let serverLog = '';

function api(path, { token, ...opts } = {}) {
  return fetch(`${BASE}/api${path}`, {
    ...opts,
    headers: {
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...opts.headers,
    },
  });
}

async function json(path, opts) {
  const res = await api(path, opts);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, res };
}

// Register + verify (via the console email provider's log) + log in.
async function makeUser(handle) {
  const email = `${handle}@test.local`;
  const mark = serverLog.length;
  const reg = await json('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username: handle, email, password: PASSWORD }),
  });
  assert.equal(reg.status, 201, `register ${handle}: ${JSON.stringify(reg.body)}`);
  // the verification token lands in the captured server log
  await new Promise((r) => setTimeout(r, 300));
  const m = serverLog.slice(mark).match(/verify\?token=([A-Za-z0-9_-]+)/);
  assert.ok(m, 'verification link in server log');
  const ver = await api(`/auth/verify?token=${m[1]}`);
  assert.ok(ver.status < 400, 'verify link works');
  const login = await json('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  assert.equal(login.status, 200, `login ${handle}`);
  return { handle, email, token: login.body.token };
}

before(async () => {
  child = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      ADMIN_HANDLES: `root${RUN}`,
      EMAIL_PROVIDER: 'console',
    },
  });
  child.stdout.on('data', (d) => { serverLog += d; });
  child.stderr.on('data', (d) => { serverLog += d; });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server did not come up; log:\n${serverLog.slice(-2000)}`);
});

after(() => { child?.kill('SIGKILL'); });

// Shared actors, created once in order.
let root, alice, bob, carol;
let slug;

test('setup: users register, verify and log in', async () => {
  root = await makeUser(`root${RUN}`);   // in ADMIN_HANDLES → site admin
  alice = await makeUser(`alice${RUN}`);
  bob = await makeUser(`bob${RUN}`);
  carol = await makeUser(`carol${RUN}`);
  const me = await json('/auth/me', { token: root.token });
  assert.equal(me.body.isAdmin, true, 'root is site admin');
});

test('profile: display name updates, bad values rejected', async () => {
  const ok = await json('/auth/me', { token: alice.token, method: 'PATCH', body: JSON.stringify({ displayName: 'Alice A.' }) });
  assert.equal(ok.status, 200);
  const bad = await json('/auth/me', { token: alice.token, method: 'PATCH', body: JSON.stringify({ displayName: '' }) });
  assert.equal(bad.status, 400);
});

test('projects: create, slug conflict, join, feed', async () => {
  slug = `rocket-${RUN}`;
  const created = await json('/groups', { token: alice.token, method: 'POST', body: JSON.stringify({ slug, name: 'Rocket Lab', goal: 'Build a rocket', visibility: 'public' }) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const dup = await json('/groups', { token: bob.token, method: 'POST', body: JSON.stringify({ slug, name: 'Copycat' }) });
  assert.equal(dup.status, 409);
  assert.equal((await json(`/groups/${slug}/join`, { token: bob.token, method: 'POST' })).status, 200);
  assert.equal((await json(`/groups/${slug}/join`, { token: carol.token, method: 'POST' })).status, 200);
  const feed = await json('/feed');
  assert.ok(feed.body.groups.some((g) => g.slug === slug), 'public project appears in feed');
});

test('messages: post, attachments incl. type/count limits, download headers', async () => {
  const post = await json(`/groups/${slug}/messages`, { token: alice.token, method: 'POST', body: JSON.stringify({ text: 'hello team' }) });
  assert.equal(post.status, 201);

  const md = Buffer.from('# spec\nbuild it').toString('base64');
  const withFile = await json(`/groups/${slug}/messages`, {
    token: bob.token, method: 'POST',
    body: JSON.stringify({ text: 'spec attached', files: [{ name: 'spec.md', type: 'text/markdown', data: md }] }),
  });
  assert.equal(withFile.status, 201, JSON.stringify(withFile.body));
  assert.equal(withFile.body.message.attachments.length, 1);
  const attId = withFile.body.message.attachments[0].id;

  const svg = await json(`/groups/${slug}/messages`, {
    token: bob.token, method: 'POST',
    body: JSON.stringify({ text: 'evil', files: [{ name: 'x.svg', type: 'image/svg+xml', data: md }] }),
  });
  assert.equal(svg.status, 400, 'svg rejected');

  const five = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.md`, type: 'text/markdown', data: md }));
  assert.equal((await json(`/groups/${slug}/messages`, { token: bob.token, method: 'POST', body: JSON.stringify({ text: 'too many', files: five }) })).status, 400, 'max 4 files');

  const list = await json(`/groups/${slug}/messages`, { token: carol.token });
  const msg = list.body.messages.find((m) => m.text === 'spec attached');
  assert.ok(msg?.attachments?.length === 1, 'attachment meta in list');

  const dl = await api(`/groups/${slug}/attachments/${attId}`, { token: carol.token });
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
  assert.match(dl.headers.get('content-disposition'), /attachment/);
  assert.equal(await dl.text(), '# spec\nbuild it');
});

test('checkpoints: admin-only, no attachments', async () => {
  assert.equal((await json(`/groups/${slug}/messages`, { token: bob.token, method: 'POST', body: JSON.stringify({ text: 'cp', kind: 'checkpoint' }) })).status, 403, 'member cannot checkpoint');
  const md = Buffer.from('x').toString('base64');
  assert.equal((await json(`/groups/${slug}/messages`, { token: alice.token, method: 'POST', body: JSON.stringify({ text: 'cp', kind: 'checkpoint', files: [{ name: 'a.md', type: 'text/markdown', data: md }] }) })).status, 400, 'checkpoint cannot carry files');
  assert.equal((await json(`/groups/${slug}/messages`, { token: alice.token, method: 'POST', body: JSON.stringify({ text: 'checkpoint 1', kind: 'checkpoint' }) })).status, 201);
});

test('membership: sole-admin leave guard, kick rules', async () => {
  assert.equal((await json(`/groups/${slug}/leave`, { token: alice.token, method: 'POST' })).body.error, 'promote another member to admin before leaving');
  assert.equal((await json(`/groups/${slug}/members/${carol.handle}`, { token: bob.token, method: 'DELETE' })).status, 403, 'non-admin cannot kick');
  assert.equal((await json(`/groups/${slug}/members/${alice.handle}`, { token: alice.token, method: 'DELETE' })).status, 400, 'self-kick is leave');
  assert.equal((await json(`/groups/${slug}/members/${carol.handle}`, { token: alice.token, method: 'DELETE' })).status, 200, 'admin kicks member');
  assert.equal((await json(`/groups/${slug}/join`, { token: carol.token, method: 'POST' })).status, 200, 'kicked user may rejoin (public)');
});

test('freeze: project-admin freeze, moderation outranks', async () => {
  assert.equal((await json(`/groups/${slug}/freeze`, { token: bob.token, method: 'POST' })).status, 403, 'member cannot freeze');
  assert.equal((await json(`/groups/${slug}/freeze`, { token: alice.token, method: 'POST' })).status, 200);
  const blocked = await json(`/groups/${slug}/messages`, { token: bob.token, method: 'POST', body: JSON.stringify({ text: 'nope' }) });
  assert.equal(blocked.status, 403);
  assert.match(blocked.body.error, /frozen by its admin/);
  // moderation takes over the freeze; project admin can no longer lift it
  assert.equal((await json(`/admin/mod/groups/${slug}/freeze`, { token: root.token, method: 'POST' })).status, 200);
  assert.equal((await json(`/groups/${slug}/unfreeze`, { token: alice.token, method: 'POST' })).status, 403);
  assert.equal((await json(`/admin/mod/groups/${slug}/unfreeze`, { token: root.token, method: 'POST' })).status, 200);
  const posts = await json(`/groups/${slug}/messages`, { token: bob.token, method: 'POST', body: JSON.stringify({ text: 'back' }) });
  assert.equal(posts.status, 201, 'posting works after unfreeze');
});

test('soft delete: hidden everywhere, admin restores', async () => {
  assert.equal((await json(`/groups/${slug}`, { token: bob.token, method: 'DELETE' })).status, 403, 'member cannot delete');
  assert.equal((await json(`/groups/${slug}`, { token: alice.token, method: 'DELETE' })).status, 200);
  assert.equal((await json(`/groups/${slug}/messages`, { token: alice.token })).status, 404, 'deleted project unreadable');
  const feed = await json('/feed');
  assert.ok(!feed.body.groups.some((g) => g.slug === slug), 'deleted project gone from feed');
  assert.equal((await json(`/admin/mod/groups/${slug}/restore`, { token: alice.token, method: 'POST' })).status, 403, 'non-site-admin cannot restore');
  assert.equal((await json(`/admin/mod/groups/${slug}/restore`, { token: root.token, method: 'POST' })).status, 200);
  assert.equal((await json(`/groups/${slug}/messages`, { token: alice.token })).status, 200, 'restored project readable');
});

test('admin search: by slug fragment and by id; authz enforced', async () => {
  assert.equal((await api(`/admin/groups?q=rocket`)).status, 401, 'unauthenticated');
  assert.equal((await json(`/admin/groups?q=rocket`, { token: alice.token })).status, 403, 'non-admin');
  const byName = await json(`/admin/groups?q=rocket-${RUN}`, { token: root.token });
  assert.equal(byName.body.groups.length, 1);
  const id = byName.body.groups[0].id;
  const byId = await json(`/admin/groups?q=${id}`, { token: root.token });
  assert.ok(byId.body.groups.some((g) => g.id === id), 'search by exact id');
});

test('bridge tokens: user-scoped list/revoke, cross-user isolation', async () => {
  const created = await json('/auth/bridge-tokens', { token: alice.token, method: 'POST', body: JSON.stringify({ agentName: 'codex' }) });
  assert.equal(created.status, 201);
  const id = created.body.bridgeTokenId;
  // a SECOND login session still sees and can revoke it
  const login2 = await json('/auth/login', { method: 'POST', body: JSON.stringify({ email: alice.email, password: PASSWORD }) });
  const list2 = await json('/auth/bridge-tokens', { token: login2.body.token });
  assert.ok(list2.body.bridgeTokens.some((t) => t.id === id && !t.revoked_at), 'agent visible from other session');
  // bob sees nothing of alice's and cannot revoke
  const bobList = await json('/auth/bridge-tokens', { token: bob.token });
  assert.ok(!bobList.body.bridgeTokens.some((t) => t.id === id), 'isolation');
  assert.equal((await json(`/auth/bridge-tokens/${id}`, { token: bob.token, method: 'DELETE' })).status, 404);
  assert.equal((await json(`/auth/bridge-tokens/${id}`, { token: login2.body.token, method: 'DELETE' })).status, 200);
});

test('reports land in the moderation queue', async () => {
  const post = await json(`/groups/${slug}/messages`, { token: bob.token, method: 'POST', body: JSON.stringify({ text: 'report me' }) });
  const rep = await json(`/groups/${slug}/messages/${post.body.message.id}/report`, {
    token: carol.token, method: 'POST', body: JSON.stringify({ reason: 'spam', detail: 'test report' }),
  });
  assert.equal(rep.status, 201, JSON.stringify(rep.body));
  const queue = await json('/admin/mod/queue', { token: root.token });
  assert.ok(queue.body.reports.some((r) => r.message_text === 'report me'), 'report visible to moderators');
});

test('handle pick: locked for email signups; deletion flow works', async () => {
  // email signups chose their handle — locked
  const locked = await json('/auth/me', { token: carol.token, method: 'PATCH', body: JSON.stringify({ username: 'newname' + RUN }) });
  assert.equal(locked.status, 403, 'email signup cannot rename');

  // deletion: wrong confirm rejected; sole-admin guard blocks; then works
  const victim = await makeUser(`victim${RUN}`);
  assert.equal((await json('/auth/me', { token: victim.token, method: 'DELETE', body: JSON.stringify({ confirm: 'nope' }) })).status, 400);

  const vslug = `vproj-${RUN}`;
  await json('/groups', { token: victim.token, method: 'POST', body: JSON.stringify({ slug: vslug, name: 'Victim Project', visibility: 'public' }) });
  await json(`/groups/${vslug}/join`, { token: bob.token, method: 'POST' });
  const guarded = await json('/auth/me', { token: victim.token, method: 'DELETE', body: JSON.stringify({ confirm: victim.handle }) });
  assert.equal(guarded.status, 400, 'sole-admin guard');
  assert.match(guarded.body.error, /only admin/);

  await json(`/groups/${vslug}`, { token: victim.token, method: 'DELETE' }); // soft-delete own project
  const del = await json('/auth/me', { token: victim.token, method: 'DELETE', body: JSON.stringify({ confirm: victim.handle }) });
  assert.equal(del.status, 200, JSON.stringify(del.body));

  // session is dead, login impossible, handle freed for nobody (anonymized)
  assert.equal((await json('/auth/me', { token: victim.token })).status, 401, 'sessions revoked');
  assert.equal((await json('/auth/login', { method: 'POST', body: JSON.stringify({ email: victim.email, password: PASSWORD }) })).status, 401, 'login gone');
});
