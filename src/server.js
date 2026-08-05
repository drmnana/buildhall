// Buildhall sync server — Express REST API + websocket fan-out.
// Storage is Postgres (see db.js); every request handler is async and awaits
// the data-access layer. Auth is session-bound (checkpoint 7): identity comes
// only from a server-minted token, never from anything the client asserts.
import express from 'express';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, init } from './db.js';
import { scheduleBackups, backupOnce, backupsConfigured } from './backup.js';
import {
  createSession,
  createBridgeToken,
  digestToken,
  hashPassword,
  createAuthToken,
  consumeAuthToken,
  VERIFY_TTL_MS,
  RESET_TTL_MS,
  listBridgeTokens,
  publicUser,
  resolveToken,
  revokeBridgeToken,
  revokeSession,
  verifyPassword,
} from './auth.js';
import { sendVerificationEmail, sendPasswordResetEmail } from './email.js';
import { providerConfigured, authorizeUrl, verifyState, exchangeCode } from './oauth.js';
import {
  consumeFailure,
  createRateLimiter,
  ipKey,
  resetOnSuccess,
  usernameKey,
  LOGIN_MAX_FAILURES,
  LOGIN_WINDOW_MS,
  LOGIN_IP_MAX_FAILURES,
  REGISTER_MAX,
  REGISTER_WINDOW_MS,
} from './rate-limit.js';
import {
  getGroupBySlug,
  getGroupById,
  listGroupsForUser,
  getMembership,
  joinGroup,
  createGroup,
  addMessage,
  getMessageInGroup,
  listMessages,
  lastMessages,
  listCheckpoints,
  publicFeed,
  getUser,
  getUserByEmail,
  getUserByUsername,
  createUser,
  markEmailVerified,
  updatePasswordHash,
  findUserByIdentity,
  linkIdentity,
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// Wrap an async route handler / middleware so a rejected promise becomes
// next(err) instead of an unhandled rejection that hangs the request. Express 4
// does not await handlers, so every async one goes through this.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const app = express();
// Render terminates TLS at its load balancer, so the socket address is always
// the proxy. Trusting exactly one hop makes req.ip the real client address,
// which the auth rate limiter keys on. Without this every request would share
// a single key and one attacker would lock out everyone.
app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));

// --- health check ----------------------------------------------------------
// Declared before the static middleware so a file named health/ in public or
// brand can never shadow it. Render polls this to gate deploys and to restart
// unhealthy instances, so it also pings the database: a process that is up but
// whose database is unreachable is not actually serving, and reports 503.
app.get('/health', ah(async (_req, res) => {
  let dbOk = true;
  try {
    await pool.query('SELECT 1');
  } catch {
    dbOk = false;
  }
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? 'ok' : 'degraded',
    db: dbOk ? 'ok' : 'unreachable',
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
}));

// Manual backup trigger — for on-demand backups and verifying the restore path.
// Guarded by a shared secret in BACKUP_TRIGGER_TOKEN; the route does not exist
// unless that secret is set, so it can't be probed on an unconfigured server.
app.post('/api/admin/backup', ah(async (req, res) => {
  const secret = process.env.BACKUP_TRIGGER_TOKEN;
  if (!secret) return res.status(404).json({ error: 'not found' });
  const auth = req.get('authorization') || '';
  if (auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'unauthorized' });
  if (!backupsConfigured()) return res.status(503).json({ error: 'backups not configured' });
  const r = await backupOnce();
  return res.status(r.ok ? 200 : 500).json(r);
}));

// Email-link landing pages are handled by the SPA (app.js reads the token from
// the URL). Serve index.html for them so a fresh navigation doesn't 404.
for (const p of ['/verify', '/reset', '/pair']) {
  app.get(p, (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
}

app.use(express.static(path.join(__dirname, '..', 'public')));

// Brand assets are served straight from brand/ (read-only originals from the
// Fable kit) so the UI references them without copying or modifying them.
const brandDir = path.join(__dirname, '..', 'brand');
app.use(express.static(path.join(brandDir, 'favicon')));
app.use(express.static(path.join(brandDir, 'color')));
app.use(express.static(path.join(brandDir, 'logo', 'svg')));

// --- AI Bridge download ------------------------------------------------------
// The bridge is dependency-free (Node built-ins only), so "installing" it is
// fetching these files. The installer downloads the manifest, then each file
// from /bridge-src, and needs nothing but Node on the user's machine.
const installerDir = path.join(__dirname, '..', 'installer');
const bridgeSrcDir = path.join(__dirname, '..', 'bridge');
// Build the manifest from what's actually on disk, so adding a bridge file can
// never leave the installer fetching a file that imports one it didn't download.
function bridgeManifest() {
  const files = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else if (/\.(mjs|js|html|css)$/.test(entry.name)) files.push(rel);
    }
  };
  walk(bridgeSrcDir, '');
  return files;
}
app.get('/download/manifest.json', (_req, res) => res.json({ files: bridgeManifest() }));
app.use('/bridge-src', express.static(path.join(__dirname, '..', 'bridge'), { index: false }));
app.get('/download/bridge.ps1', (_req, res) => {
  res.type('text/plain').sendFile(path.join(installerDir, 'bridge-installer.ps1'));
});
app.get('/download/bridge-setup.cmd', (_req, res) => {
  res.set('Content-Disposition', 'attachment; filename="BuildHall-Bridge-Setup.cmd"');
  res.type('application/octet-stream').sendFile(path.join(installerDir, 'bridge-setup.cmd'));
});
app.get('/download/bridge-mac.command', (_req, res) => {
  res.set('Content-Disposition', 'attachment; filename="BuildHall-Bridge-Setup.command"');
  res.type('application/octet-stream').sendFile(path.join(installerDir, 'bridge-installer.command'));
});

// --- auth ------------------------------------------------------------------
// Checkpoint 7: identity is never asserted by the client. The caller presents
// `Authorization: Bearer <token>` and the server resolves it against stored
// digests. The old `x-user-id` header is not read anywhere and carries no
// privilege — see verify-checkpoint7.mjs, which asserts that explicitly.

const USERNAME_RE = /^[a-z0-9_-]{2,32}$/i;
const MIN_PASSWORD_LENGTH = 10;

function bearerToken(req) {
  const header = req.get('authorization') || '';
  const [scheme, value] = header.split(' ');
  return /^bearer$/i.test(scheme || '') ? (value || '').trim() : null;
}

// Login is guarded twice: per email so one account cannot be ground down, and
// per client address so an attacker cannot spray many emails from one host.
// Both count failures only. Registration counts every request, since the cost
// there is account creation + an outbound email.
const loginByEmail = createRateLimiter({
  windowMs: LOGIN_WINDOW_MS, max: LOGIN_MAX_FAILURES,
  key: (req) => `login-email:${String(req.body?.email || '').toLowerCase().trim()}`,
});
const loginByIp = createRateLimiter({
  windowMs: LOGIN_WINDOW_MS, max: LOGIN_IP_MAX_FAILURES, key: ipKey('login-ip'),
});
const registerByIp = createRateLimiter({
  windowMs: REGISTER_WINDOW_MS, max: REGISTER_MAX, key: ipKey('register-ip'),
  countAllRequests: true,
});

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// A public handle (username) must exist for every account — it drives display
// and agent naming. Derive a valid, unique one from a seed (name or email).
async function uniqueHandle(seed) {
  let base = String(seed || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '').slice(0, 24);
  if (base.length < 2) base = `user${base}`;
  let handle = base;
  for (let i = 0; i < 50; i++) {
    if (!(await getUserByUsername(handle))) return handle;
    handle = `${base}${Math.floor(Math.random() * 9000) + 1000}`.slice(0, 32);
  }
  return `${base}${Date.now().toString(36)}`.slice(0, 32);
}

// Resolve (or create) the local user for an OAuth profile. Order matters:
// already-linked wins; otherwise link to an existing account by VERIFIED email
// (never an unverified one — that would be account takeover); otherwise a new
// account. Returns null if the provider gives us no email to key on.
async function resolveOAuthUser(provider, profile) {
  const existing = await findUserByIdentity(provider, profile.providerUserId);
  if (existing) return existing;
  if (profile.email && profile.emailVerified) {
    const byEmail = await getUserByEmail(profile.email.toLowerCase());
    if (byEmail) {
      await linkIdentity(byEmail.id, provider, profile.providerUserId, profile.email);
      if (!byEmail.email_verified) await markEmailVerified(byEmail.id);
      return byEmail;
    }
  }
  if (!profile.email) return null;
  const handle = await uniqueHandle(profile.name || profile.email.split('@')[0]);
  const user = await createUser({
    username: handle,
    displayName: profile.name || handle,
    email: profile.email.toLowerCase(),
    passwordHash: null,
    emailVerified: !!profile.emailVerified,
  });
  await linkIdentity(user.id, provider, profile.providerUserId, profile.email);
  return user;
}

// Register with email + password. The account is created UNVERIFIED and no
// session is issued: the user must click the emailed link first. A handle may
// be supplied, else one is derived from the email.
app.post('/api/auth/register', registerByIp, ah(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  let handle = String(req.body?.handle || req.body?.username || '').trim();
  if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ error: 'a valid email is required' });
  if (password.length < MIN_PASSWORD_LENGTH) return res.status(400).json({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  if (handle && !USERNAME_RE.test(handle)) return res.status(400).json({ error: 'handle must be 2-32 chars: letters, digits, _ or -' });
  if (await getUserByEmail(email)) return res.status(409).json({ error: 'an account with this email already exists' });
  if (handle) {
    if (await getUserByUsername(handle)) return res.status(409).json({ error: 'handle already taken' });
  } else {
    handle = await uniqueHandle(email.split('@')[0]);
  }
  const user = await createUser({ username: handle, email, passwordHash: hashPassword(password), emailVerified: false });
  const token = await createAuthToken(user.id, 'verify_email', VERIFY_TTL_MS);
  await sendVerificationEmail(email, token);
  res.status(201).json({ ok: true, pendingVerification: true, email, handle });
}));

// Complete verification (the SPA's /verify page calls this with the token from
// the email link). On success the email is verified and a session is issued.
app.get('/api/auth/verify', ah(async (req, res) => {
  const userId = await consumeAuthToken(String(req.query.token || ''), 'verify_email');
  if (!userId) return res.status(400).json({ error: 'invalid or expired verification link' });
  await markEmailVerified(userId);
  const user = await getUser(userId);
  const { token } = await createSession(userId);
  res.json({ ok: true, user: { ...publicUser(user), email: user.email }, token });
}));

app.post('/api/auth/resend-verification', registerByIp, ah(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const user = await getUserByEmail(email);
  if (user && !user.email_verified) {
    const token = await createAuthToken(user.id, 'verify_email', VERIFY_TTL_MS);
    await sendVerificationEmail(email, token);
  }
  res.json({ ok: true }); // always 200 — don't reveal whether the email exists
}));

app.post('/api/auth/login', loginByEmail, loginByIp, ah(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const user = await getUserByEmail(email);
  // One generic failure for unknown email, OAuth-only (null hash), and wrong
  // password, so the response cannot be used to enumerate accounts.
  if (!user || !verifyPassword(password, user.password_hash)) {
    consumeFailure(req);
    return res.status(401).json({ error: 'invalid email or password' });
  }
  if (!user.email_verified) {
    consumeFailure(req);
    return res.status(403).json({ error: 'please verify your email first', needsVerification: true });
  }
  resetOnSuccess(req);
  const { token } = await createSession(user.id);
  res.json({ user: { ...publicUser(user), email: user.email }, token });
}));

app.post('/api/auth/forgot', registerByIp, ah(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const user = await getUserByEmail(email);
  if (user && user.password_hash) { // only password accounts can reset a password
    const token = await createAuthToken(user.id, 'reset_password', RESET_TTL_MS);
    await sendPasswordResetEmail(email, token);
  }
  res.json({ ok: true }); // always 200 — don't reveal whether the email exists
}));

app.post('/api/auth/reset', ah(async (req, res) => {
  const password = String(req.body?.password || '');
  if (password.length < MIN_PASSWORD_LENGTH) return res.status(400).json({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  const userId = await consumeAuthToken(String(req.body?.token || ''), 'reset_password');
  if (!userId) return res.status(400).json({ error: 'invalid or expired reset link' });
  await updatePasswordHash(userId, hashPassword(password));
  await markEmailVerified(userId); // proving control of the inbox verifies it too
  const user = await getUser(userId);
  const { token } = await createSession(userId);
  res.json({ ok: true, user: { ...publicUser(user), email: user.email }, token });
}));

// --- social login (Google, GitHub) ----------------------------------------
// GET /api/auth/:provider redirects to the provider; the callback exchanges the
// code, resolves the user, and hands the session token to the SPA via the URL
// fragment (never a query param — fragments don't reach server/proxy logs).
// The `next()` guards make these safe to register alongside the specific
// /api/auth/* routes: a non-oauth path just falls through.
app.get('/api/auth/:provider', ah(async (req, res, next) => {
  const provider = req.params.provider;
  if (provider !== 'google' && provider !== 'github') return next();
  if (!providerConfigured(provider)) return res.status(404).json({ error: `${provider} login is not configured` });
  res.redirect(authorizeUrl(provider));
}));

app.get('/api/auth/:provider/callback', ah(async (req, res, next) => {
  const provider = req.params.provider;
  if (provider !== 'google' && provider !== 'github') return next();
  if (!providerConfigured(provider)) return res.status(404).json({ error: 'not configured' });
  if (req.query.error) return res.redirect(`/?auth_error=${encodeURIComponent(String(req.query.error))}`);
  const code = String(req.query.code || '');
  if (!code || !verifyState(provider, String(req.query.state || ''))) {
    return res.redirect('/?auth_error=invalid_state');
  }
  let profile;
  try {
    profile = await exchangeCode(provider, code);
  } catch {
    return res.redirect('/?auth_error=exchange_failed');
  }
  const user = await resolveOAuthUser(provider, profile);
  if (!user) return res.redirect('/?auth_error=no_email');
  const { token } = await createSession(user.id);
  res.redirect(`/#token=${encodeURIComponent(token)}`);
}));

const requireUser = ah(async (req, res, next) => {
  const identity = await resolveToken(bearerToken(req));
  if (!identity) return res.status(401).json({ error: 'authentication required' });
  req.user = identity.user;
  req.identity = identity;
  next();
});

/** Bridge tokens may read and post, but must not manage the session itself. */
function requireSessionToken(req, res, next) {
  if (req.identity.kind !== 'session') {
    return res.status(403).json({ error: 'this endpoint requires a login session, not a bridge token' });
  }
  next();
}

app.get('/api/auth/me', requireUser, (req, res) => {
  res.json({
    user: { ...publicUser(req.user), email: req.user.email, emailVerified: req.user.email_verified },
    tokenKind: req.identity.kind,
    agentName: req.identity.agentName,
  });
});

app.post('/api/auth/logout', requireUser, requireSessionToken, ah(async (req, res) => {
  const { revokedBridgeTokenIds } = await revokeSession(req.identity.sessionId);
  // Revoking rows does not disconnect anyone: sockets already open would keep
  // streaming. Tear them down here so "log out" genuinely severs the agent.
  const closed = closeSocketsForSession(req.identity.sessionId);
  res.json({ ok: true, revokedBridgeTokens: revokedBridgeTokenIds.length, closedConnections: closed });
}));

// --- bridge tokens (agent/connector credentials) ---------------------------

app.get('/api/auth/bridge-tokens', requireUser, requireSessionToken, ah(async (req, res) => {
  res.json({ bridgeTokens: await listBridgeTokens(req.identity.sessionId) });
}));

app.post('/api/auth/bridge-tokens', requireUser, requireSessionToken, ah(async (req, res) => {
  const agentName = String(req.body?.agentName || '').trim();
  if (!/^[a-z0-9 _.-]{2,32}$/i.test(agentName)) {
    return res.status(400).json({ error: 'agentName must be 2-32 chars: letters, digits, space, _ . or -' });
  }
  // The stored identity is "<username> <name>", with the username taken from
  // the login session — never from input. Whatever the token is called, the
  // group always sees whose agent it is, and nobody can name their agent after
  // someone else's.
  const composedName = `${req.user.username} ${agentName}`;
  const { token, bridgeTokenId } = await createBridgeToken(req.identity.sessionId, req.user.id, composedName);
  // Returned once and never retrievable again — only its digest is stored.
  res.status(201).json({ bridgeTokenId, agentName: composedName, token });
}));

app.delete('/api/auth/bridge-tokens/:id', requireUser, requireSessionToken, ah(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid bridge token id' });
  if (!(await revokeBridgeToken(req.identity.sessionId, id))) {
    return res.status(404).json({ error: 'no such live bridge token on this session' });
  }
  res.json({ ok: true, closedConnections: closeSocketsForBridgeToken(id) });
}));

// --- device pairing --------------------------------------------------------
// One-click bridge setup, device-code style (think "pair your TV app"):
//   1. bridge POSTs /api/pair/start (no auth)  -> { code, secret }
//   2. bridge opens https://buildhall.ai/pair?code=... in the user's browser
//   3. the logged-in user clicks Approve       -> a NEW session is minted and
//      parked (raw) on the pairing row
//   4. bridge polls /api/pair/claim with its secret -> receives the session
//      token exactly once; the row is wiped
// The secret stops a third party who saw the code (it's in a URL) from
// claiming the session; only the device that started the pairing can.
const PAIR_TTL_MS = 10 * 60 * 1000;

function pairCode() {
  // 8 chars, unambiguous alphabet (no 0/O/1/I) — short enough to read out.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(randomBytes(8), (b) => alphabet[b % alphabet.length]).join('');
}

app.post('/api/pair/start', ah(async (req, res) => {
  // Housekeeping: expired rows are dead weight; clear them on the write path.
  await pool.query("DELETE FROM pairings WHERE expires_at <= $1", [new Date().toISOString()]);
  const agents = Array.isArray(req.body?.agents)
    ? req.body.agents.map((a) => String(a).slice(0, 32)).slice(0, 8)
    : [];
  const code = pairCode();
  const secret = randomBytes(32).toString('base64url');
  await pool.query(
    'INSERT INTO pairings (code, secret_hash, agents, expires_at) VALUES ($1, $2, $3, $4)',
    [code, digestToken(secret), JSON.stringify(agents), new Date(Date.now() + PAIR_TTL_MS).toISOString()],
  );
  res.status(201).json({ code, secret, expiresInSeconds: PAIR_TTL_MS / 1000 });
}));

// What the approval page shows. Requires a login so the page can also prove
// the user is signed in before offering the Approve button.
app.get('/api/pair/:code', requireUser, requireSessionToken, ah(async (req, res) => {
  const r = await pool.query('SELECT agents, expires_at, session_token, claimed_at FROM pairings WHERE code = $1', [String(req.params.code)]);
  const row = r.rows[0];
  if (!row || row.expires_at <= new Date().toISOString()) return res.status(404).json({ error: 'pairing expired or unknown — start again from the bridge' });
  res.json({
    agents: JSON.parse(row.agents || '[]'),
    approved: !!row.session_token || !!row.claimed_at,
    expiresAt: row.expires_at,
  });
}));

app.post('/api/pair/:code/approve', requireUser, requireSessionToken, ah(async (req, res) => {
  const code = String(req.params.code);
  const r = await pool.query('SELECT id, expires_at, session_token, claimed_at FROM pairings WHERE code = $1', [code]);
  const row = r.rows[0];
  if (!row || row.expires_at <= new Date().toISOString()) return res.status(404).json({ error: 'pairing expired or unknown — start again from the bridge' });
  if (row.session_token || row.claimed_at) return res.status(409).json({ error: 'already approved' });
  // A fresh session, distinct from the browser's: signing out of the browser
  // later must not disconnect the bridge.
  const { token } = await createSession(req.user.id);
  await pool.query('UPDATE pairings SET session_token = $1, username = $2 WHERE id = $3', [token, req.user.username, row.id]);
  res.json({ ok: true });
}));

app.post('/api/pair/claim', ah(async (req, res) => {
  const { code, secret } = req.body ?? {};
  const r = await pool.query('SELECT * FROM pairings WHERE code = $1', [String(code || '')]);
  const row = r.rows[0];
  if (!row || row.claimed_at || row.expires_at <= new Date().toISOString()) {
    return res.status(410).json({ error: 'pairing expired' });
  }
  if (digestToken(String(secret || '')) !== row.secret_hash) return res.status(403).json({ error: 'wrong secret' });
  if (!row.session_token) return res.json({ pending: true });
  // Hand over exactly once, then scrub the raw token from the row.
  await pool.query(`UPDATE pairings SET session_token = NULL, claimed_at = $1 WHERE id = $2`, [new Date().toISOString(), row.id]);
  res.json({ token: row.session_token, username: row.username });
}));

// --- groups ----------------------------------------------------------------

app.get('/api/feed', ah(async (_req, res) => res.json({ groups: await publicFeed() })));

app.get('/api/groups', requireUser, ah(async (req, res) => {
  res.json({ groups: await listGroupsForUser(req.user.id) });
}));

app.post('/api/groups', requireUser, ah(async (req, res) => {
  const { slug, name, description, goal, visibility } = req.body ?? {};
  if (!/^[a-z0-9-]{2,48}$/.test(String(slug || ''))) {
    return res.status(400).json({ error: 'slug must be 2-48 chars: lowercase letters, digits, -' });
  }
  const trimmedName = String(name || '').trim();
  if (!trimmedName) return res.status(400).json({ error: 'name is required' });
  if (trimmedName.length > 80) return res.status(400).json({ error: 'name must be 80 characters or fewer' });
  if (String(description || '').length > 500 || String(goal || '').length > 500) {
    return res.status(400).json({ error: 'description and goal must be 500 characters or fewer' });
  }
  // reject unknown visibility here so it's a 400, not a database CHECK failure (500)
  if (visibility != null && !['public', 'unlisted', 'private'].includes(visibility)) {
    return res.status(400).json({ error: "visibility must be 'public', 'unlisted' or 'private'" });
  }
  if (await getGroupBySlug(slug)) return res.status(409).json({ error: 'slug already taken' });
  const group = await createGroup({
    slug, name: trimmedName, description, goal, visibility, createdBy: req.user.id,
  });
  res.status(201).json({ group });
}));

app.post('/api/groups/:slug/join', requireUser, ah(async (req, res) => {
  const group = await getGroupBySlug(req.params.slug);
  if (!group) return res.status(404).json({ error: 'no such group' });
  if (group.visibility === 'private' && !(await getMembership(group.id, req.user.id))) {
    return res.status(403).json({ error: 'group is private — ask an admin for an invite' });
  }
  res.json({ membership: await joinGroup(group.id, req.user.id) });
}));

// --- messages --------------------------------------------------------------

const requireMember = ah(async (req, res, next) => {
  const group = await getGroupBySlug(req.params.slug);
  if (!group) return res.status(404).json({ error: 'no such group' });
  const membership = await getMembership(group.id, req.user.id);
  if (!membership && group.visibility === 'private') {
    return res.status(403).json({ error: 'not a member of this group' });
  }
  req.group = group;
  req.membership = membership;
  next();
});

// Query params must be non-negative integers; anything else is a 400 rather
// than silently coercing to 0 and returning the wrong page.
function intParam(value, fallback) {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

app.get('/api/groups/:slug/messages', requireUser, requireMember, ah(async (req, res) => {
  if (req.query.after !== undefined && req.query.before !== undefined) {
    return res.status(400).json({ error: 'after and before are mutually exclusive — pass one or neither' });
  }
  const afterId = intParam(req.query.after, 0);
  const beforeId = intParam(req.query.before, 0);
  const limit = intParam(req.query.limit, 200);
  if (afterId === null || beforeId === null || limit === null) {
    return res.status(400).json({ error: 'after, before and limit must be non-negative integers' });
  }
  res.json({
    messages: await listMessages(req.group.id, {
      afterId, beforeId, limit: Math.min(Math.max(limit, 1), 200),
    }),
  });
}));

app.get('/api/groups/:slug/checkpoints', requireUser, requireMember, ah(async (req, res) => {
  res.json({ checkpoints: await listCheckpoints(req.group.id) });
}));

// Catch-up slice for agents: the newest `limit` messages in reading order,
// plus the latest checkpoint so the caller knows where summarized history ends.
app.get('/api/groups/:slug/context', requireUser, requireMember, ah(async (req, res) => {
  const limit = intParam(req.query.limit, 50);
  if (limit === null || limit < 1) {
    return res.status(400).json({ error: 'limit must be a positive integer' });
  }
  const [checkpoint] = await listCheckpoints(req.group.id, 1);
  res.json({
    checkpoint: checkpoint ?? null,
    messages: await lastMessages(req.group.id, limit),
  });
}));

app.post('/api/groups/:slug/messages', requireUser, requireMember, ah(async (req, res) => {
  if (!req.membership) return res.status(403).json({ error: 'join the group to post' });
  const { kind, text, pinnedMessageId } = req.body ?? {};
  // Attribution is derived from the credential, never from the request body.
  // A bridge token posts as its own agent; a login session posts as the human.
  // Neither can claim to be the other.
  const actorType = req.identity.kind === 'bridge' ? 'ai' : 'human';
  const agentName = req.identity.kind === 'bridge' ? req.identity.agentName : null;
  if (kind != null && !['message', 'checkpoint'].includes(kind)) {
    return res.status(400).json({ error: "kind must be 'message' or 'checkpoint'" });
  }
  if (kind === 'checkpoint' && req.membership.role !== 'admin') {
    return res.status(403).json({ error: 'only admins can post checkpoints' });
  }
  // a checkpoint may pin the message it marks; the pin must be a real message
  // in this same group, so a stale or cross-group id is a 400, not a dead link
  let pinId = null;
  if (pinnedMessageId != null) {
    if (kind !== 'checkpoint') {
      return res.status(400).json({ error: 'pinnedMessageId is only allowed on checkpoints' });
    }
    pinId = Number(pinnedMessageId);
    if (!Number.isInteger(pinId) || pinId <= 0 || !(await getMessageInGroup(req.group.id, pinId))) {
      return res.status(400).json({ error: 'pinnedMessageId must reference a message in this group' });
    }
  }
  const body = String(text || '').trim();
  if (!body) return res.status(400).json({ error: 'text is required' });
  if (body.length > 4000) return res.status(400).json({ error: 'text must be 4000 characters or fewer' });
  const message = await addMessage({
    groupId: req.group.id,
    userId: req.user.id,
    actorType,
    agentName,
    kind,
    text: body,
    pinnedMessageId: pinId,
  });
  broadcast(req.group.id, { type: 'message', message });
  res.status(201).json({ message });
}));

// --- error handler ----------------------------------------------------------
// Any handler that throws (or whose promise rejects via ah) lands here. Log the
// real error server-side; return a generic 500 so internals never leak.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('request error:', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'internal error' });
});

// --- websocket fan-out -----------------------------------------------------
// Clients connect to /ws?groupId=N and authenticate with the same bearer token
// as the REST API, passed via the WebSocket subprotocol rather than the query
// string — browsers cannot set headers on a WebSocket handshake, and a token
// in a URL leaks into access logs, proxy logs and Referer headers.
//
// Every socket records the session (and bridge token, if any) it was opened
// with, which is what lets logout hunt down and close live connections.

const server = createServer(app);
const WS_TOKEN_PROTOCOL = 'bh-token';
// `noServer` so authentication runs during the HTTP upgrade. Rejecting inside
// the 'connection' event would be too late: the handshake would already have
// completed and an unauthenticated peer would see a briefly-open socket.
const wss = new WebSocketServer({
  noServer: true,
  // Echo back only our marker, never the token itself.
  handleProtocols: (protocols) => (protocols.has(WS_TOKEN_PROTOCOL) ? WS_TOKEN_PROTOCOL : false),
});

/** @type {Map<number, Set<WebSocket>>} groupId -> sockets */
const rooms = new Map();
/** @type {Set<WebSocket>} every authenticated socket, for targeted teardown */
const liveSockets = new Set();

function tokenFromHandshake(req) {
  // Sent as: new WebSocket(url, ['bh-token', '<token>'])
  const raw = req.headers['sec-websocket-protocol'];
  if (!raw) return null;
  const parts = String(raw).split(',').map((s) => s.trim());
  const idx = parts.indexOf(WS_TOKEN_PROTOCOL);
  return idx === -1 ? null : parts[idx + 1] || null;
}

function rejectUpgrade(socket, status, reason) {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

// Auth now touches the database (async). Any thrown/rejected error rejects the
// upgrade rather than crashing the process.
server.on('upgrade', (req, socket, head) => {
  handleUpgrade(req, socket, head).catch(() => {
    try { rejectUpgrade(socket, 500, 'Internal Server Error'); } catch { /* socket gone */ }
  });
});

async function handleUpgrade(req, socket, head) {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return rejectUpgrade(socket, 400, 'Bad Request');
  }
  if (url.pathname !== '/ws') return rejectUpgrade(socket, 404, 'Not Found');

  const identity = await resolveToken(tokenFromHandshake(req));
  if (!identity) return rejectUpgrade(socket, 401, 'Unauthorized');

  const groupId = Number(url.searchParams.get('groupId'));
  if (!groupId) return rejectUpgrade(socket, 400, 'Bad Request');
  const group = await getGroupById(groupId);
  if (!group) return rejectUpgrade(socket, 404, 'Not Found');
  if (group.visibility === 'private' && !(await getMembership(groupId, identity.user.id))) {
    return rejectUpgrade(socket, 403, 'Forbidden');
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.bhSessionId = identity.sessionId;
    ws.bhBridgeTokenId = identity.bridgeTokenId;
    ws.bhGroupId = groupId;
    liveSockets.add(ws);

    let room = rooms.get(groupId);
    if (!room) rooms.set(groupId, (room = new Set()));
    room.add(ws);
    ws.on('close', () => {
      liveSockets.delete(ws);
      room.delete(ws);
      if (room.size === 0) rooms.delete(groupId);
    });
    wss.emit('connection', ws, req);
  });
}

/** Close every live socket opened with this session or any of its children. */
function closeSocketsForSession(sessionId) {
  let closed = 0;
  for (const ws of liveSockets) {
    if (ws.bhSessionId !== sessionId) continue;
    closed++;
    try {
      ws.close(4401, 'session revoked');
    } catch {
      /* already closing */
    }
    // Give the close frame a moment to flush before killing the socket.
    // Terminating immediately means the peer sees code 1005 (no status) rather
    // than 4401, so a well-behaved client cannot tell "you were revoked" from
    // "the network blipped" and will reconnect forever. A peer that ignores the
    // frame still gets dropped when the timer fires.
    setTimeout(() => ws.terminate(), 250).unref?.();
  }
  return closed;
}

/** Same, scoped to a single revoked bridge token. */
function closeSocketsForBridgeToken(bridgeTokenId) {
  let closed = 0;
  for (const ws of liveSockets) {
    if (ws.bhBridgeTokenId !== bridgeTokenId) continue;
    closed++;
    try {
      ws.close(4401, 'bridge token revoked');
    } catch {
      /* already closing */
    }
    ws.terminate();
  }
  return closed;
}

function broadcast(groupId, payload) {
  const room = rooms.get(groupId);
  if (!room) return;
  const data = JSON.stringify(payload);
  for (const ws of room) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

// Create the schema, then start serving. A failed DB init is fatal — better to
// crash the deploy than to serve a broken instance that health-checks as down.
init()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Buildhall listening on http://localhost:${PORT}`);
      scheduleBackups();
    });
  })
  .catch((err) => {
    console.error('database init failed:', err);
    process.exit(1);
  });
