// Buildhall sync server — Express REST API + websocket fan-out.
// Auth is a dev-grade username handshake for now (no passwords); real auth is
// a flagged follow-up before any public deployment.
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import {
  createSession,
  createBridgeToken,
  createUserWithPassword,
  getUserByUsername,
  listBridgeTokens,
  publicUser,
  resolveToken,
  revokeBridgeToken,
  revokeSession,
  verifyPassword,
} from './auth.js';
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
  getUser,
  createGroup,
  getGroupBySlug,
  getGroupById,
  listGroupsForUser,
  getMembership,
  joinGroup,
  addMessage,
  getMessageInGroup,
  listMessages,
  lastMessages,
  listCheckpoints,
  publicFeed,
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

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
// unhealthy instances, so it also pings SQLite: a process that is up but whose
// database is unreachable is not actually serving, and should not report ok.
app.get('/health', (_req, res) => {
  let dbOk = true;
  try {
    db.prepare('SELECT 1').get();
  } catch {
    dbOk = false;
  }
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? 'ok' : 'degraded',
    db: dbOk ? 'ok' : 'unreachable',
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

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
const BRIDGE_FILES = [
  'server.mjs', 'connection.mjs', 'responder.mjs',
  'public/index.html', 'public/styles.css', 'public/app.js',
];
app.get('/download/manifest.json', (_req, res) => res.json({ files: BRIDGE_FILES }));
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

// Login is guarded twice: per username so one account cannot be ground down,
// and per client address so an attacker cannot spray many usernames from one
// host. Both count failures only. Registration counts every request, since the
// cost there is account creation itself.
const loginByUsername = createRateLimiter({
  windowMs: LOGIN_WINDOW_MS, max: LOGIN_MAX_FAILURES, key: usernameKey('login-user'),
});
const loginByIp = createRateLimiter({
  windowMs: LOGIN_WINDOW_MS, max: LOGIN_IP_MAX_FAILURES, key: ipKey('login-ip'),
});
const registerByIp = createRateLimiter({
  windowMs: REGISTER_WINDOW_MS, max: REGISTER_MAX, key: ipKey('register-ip'),
  countAllRequests: true,
});

app.post('/api/auth/register', registerByIp, (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'username must be 2-32 chars: letters, digits, _ or -' });
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  }
  // Taken means taken, including legacy passwordless rows. Letting a caller
  // set a password on an existing account would be account takeover.
  if (getUserByUsername(username)) return res.status(409).json({ error: 'username already taken' });
  const user = createUserWithPassword(username, password);
  const { token } = createSession(user.id);
  res.status(201).json({ user: publicUser(user), token });
});

app.post('/api/auth/login', loginByUsername, loginByIp, (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const user = getUserByUsername(username);
  // One generic failure for unknown user, legacy NULL hash, and wrong
  // password, so the response cannot be used to enumerate accounts.
  if (!user || !verifyPassword(password, user.password_hash)) {
    consumeFailure(req);
    return res.status(401).json({ error: 'invalid username or password' });
  }
  // A correct password clears the counters, so a legitimate user is never
  // locked out by their own earlier typos.
  resetOnSuccess(req);
  const { token } = createSession(user.id);
  res.json({ user: publicUser(user), token });
});

function requireUser(req, res, next) {
  const identity = resolveToken(bearerToken(req));
  if (!identity) return res.status(401).json({ error: 'authentication required' });
  req.user = identity.user;
  req.identity = identity;
  next();
}

/** Bridge tokens may read and post, but must not manage the session itself. */
function requireSessionToken(req, res, next) {
  if (req.identity.kind !== 'session') {
    return res.status(403).json({ error: 'this endpoint requires a login session, not a bridge token' });
  }
  next();
}

app.get('/api/auth/me', requireUser, (req, res) => {
  res.json({
    user: publicUser(req.user),
    tokenKind: req.identity.kind,
    agentName: req.identity.agentName,
  });
});

app.post('/api/auth/logout', requireUser, requireSessionToken, (req, res) => {
  const { revokedBridgeTokenIds } = revokeSession(req.identity.sessionId);
  // Revoking rows does not disconnect anyone: sockets already open would keep
  // streaming. Tear them down here so "log out" genuinely severs the agent.
  const closed = closeSocketsForSession(req.identity.sessionId);
  res.json({ ok: true, revokedBridgeTokens: revokedBridgeTokenIds.length, closedConnections: closed });
});

// --- bridge tokens (agent/connector credentials) ---------------------------

app.get('/api/auth/bridge-tokens', requireUser, requireSessionToken, (req, res) => {
  res.json({ bridgeTokens: listBridgeTokens(req.identity.sessionId) });
});

app.post('/api/auth/bridge-tokens', requireUser, requireSessionToken, (req, res) => {
  const agentName = String(req.body?.agentName || '').trim();
  if (!/^[a-z0-9 _.-]{2,32}$/i.test(agentName)) {
    return res.status(400).json({ error: 'agentName must be 2-32 chars: letters, digits, space, _ . or -' });
  }
  // The stored identity is "<username> <name>", with the username taken from
  // the login session — never from input. Whatever the token is called, the
  // group always sees whose agent it is, and nobody can name their agent after
  // someone else's.
  const composedName = `${req.user.username} ${agentName}`;
  const { token, bridgeTokenId } = createBridgeToken(req.identity.sessionId, req.user.id, composedName);
  // Returned once and never retrievable again — only its digest is stored.
  res.status(201).json({ bridgeTokenId, agentName: composedName, token });
});

app.delete('/api/auth/bridge-tokens/:id', requireUser, requireSessionToken, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid bridge token id' });
  if (!revokeBridgeToken(req.identity.sessionId, id)) {
    return res.status(404).json({ error: 'no such live bridge token on this session' });
  }
  res.json({ ok: true, closedConnections: closeSocketsForBridgeToken(id) });
});

// --- groups ----------------------------------------------------------------

app.get('/api/feed', (_req, res) => res.json({ groups: publicFeed() }));

app.get('/api/groups', requireUser, (req, res) => {
  res.json({ groups: listGroupsForUser(req.user.id) });
});

app.post('/api/groups', requireUser, (req, res) => {
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
  // reject unknown visibility here so it's a 400, not a SQLite CHECK failure (500)
  if (visibility != null && !['public', 'unlisted', 'private'].includes(visibility)) {
    return res.status(400).json({ error: "visibility must be 'public', 'unlisted' or 'private'" });
  }
  if (getGroupBySlug(slug)) return res.status(409).json({ error: 'slug already taken' });
  const group = createGroup({
    slug, name: trimmedName, description, goal, visibility, createdBy: req.user.id,
  });
  res.status(201).json({ group });
});

app.post('/api/groups/:slug/join', requireUser, (req, res) => {
  const group = getGroupBySlug(req.params.slug);
  if (!group) return res.status(404).json({ error: 'no such group' });
  if (group.visibility === 'private' && !getMembership(group.id, req.user.id)) {
    return res.status(403).json({ error: 'group is private — ask an admin for an invite' });
  }
  res.json({ membership: joinGroup(group.id, req.user.id) });
});

// --- messages --------------------------------------------------------------

function requireMember(req, res, next) {
  const group = getGroupBySlug(req.params.slug);
  if (!group) return res.status(404).json({ error: 'no such group' });
  const membership = getMembership(group.id, req.user.id);
  if (!membership && group.visibility === 'private') {
    return res.status(403).json({ error: 'not a member of this group' });
  }
  req.group = group;
  req.membership = membership;
  next();
}

// Query params must be non-negative integers; anything else is a 400 rather
// than silently coercing to 0 and returning the wrong page.
function intParam(value, fallback) {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

app.get('/api/groups/:slug/messages', requireUser, requireMember, (req, res) => {
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
    messages: listMessages(req.group.id, {
      afterId, beforeId, limit: Math.min(Math.max(limit, 1), 200),
    }),
  });
});

app.get('/api/groups/:slug/checkpoints', requireUser, requireMember, (req, res) => {
  res.json({ checkpoints: listCheckpoints(req.group.id) });
});

// Catch-up slice for agents: the newest `limit` messages in reading order,
// plus the latest checkpoint so the caller knows where summarized history ends.
app.get('/api/groups/:slug/context', requireUser, requireMember, (req, res) => {
  const limit = intParam(req.query.limit, 50);
  if (limit === null || limit < 1) {
    return res.status(400).json({ error: 'limit must be a positive integer' });
  }
  const [checkpoint] = listCheckpoints(req.group.id, 1);
  res.json({
    checkpoint: checkpoint ?? null,
    messages: lastMessages(req.group.id, limit),
  });
});

app.post('/api/groups/:slug/messages', requireUser, requireMember, (req, res) => {
  if (!req.membership) return res.status(403).json({ error: 'join the group to post' });
  const { kind, text, pinnedMessageId } = req.body ?? {};
  // Attribution is derived from the credential, never from the request body.
  // Previously a caller could set actorType/agentName freely, so any human
  // could post as any agent — the same class of spoof as the old x-user-id
  // header. A bridge token posts as its own agent; a login session posts as
  // the human. Neither can claim to be the other.
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
    if (!Number.isInteger(pinId) || pinId <= 0 || !getMessageInGroup(req.group.id, pinId)) {
      return res.status(400).json({ error: 'pinnedMessageId must reference a message in this group' });
    }
  }
  const body = String(text || '').trim();
  if (!body) return res.status(400).json({ error: 'text is required' });
  if (body.length > 4000) return res.status(400).json({ error: 'text must be 4000 characters or fewer' });
  const message = addMessage({
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

server.on('upgrade', (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return rejectUpgrade(socket, 400, 'Bad Request');
  }
  if (url.pathname !== '/ws') return rejectUpgrade(socket, 404, 'Not Found');

  const identity = resolveToken(tokenFromHandshake(req));
  if (!identity) return rejectUpgrade(socket, 401, 'Unauthorized');

  const groupId = Number(url.searchParams.get('groupId'));
  if (!groupId) return rejectUpgrade(socket, 400, 'Bad Request');
  const group = getGroupById(groupId);
  if (!group) return rejectUpgrade(socket, 404, 'Not Found');
  if (group.visibility === 'private' && !getMembership(groupId, identity.user.id)) {
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
});

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

server.listen(PORT, () => {
  console.log(`Buildhall listening on http://localhost:${PORT}`);
});
