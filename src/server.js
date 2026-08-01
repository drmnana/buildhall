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
  findOrCreateUser,
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

// --- dev auth: client sends its username, gets back the user record --------

app.post('/api/session', (req, res) => {
  const username = String(req.body?.username || '').trim();
  if (!/^[a-z0-9_-]{2,32}$/i.test(username)) {
    return res.status(400).json({ error: 'username must be 2-32 chars: letters, digits, _ or -' });
  }
  res.json({ user: findOrCreateUser(username) });
});

// Every API call below identifies the caller via x-user-id (dev only).
function requireUser(req, res, next) {
  const user = getUser(Number(req.get('x-user-id')));
  if (!user) return res.status(401).json({ error: 'unknown user — create a session first' });
  req.user = user;
  next();
}

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
  const { actorType = 'human', agentName, kind, text, pinnedMessageId } = req.body ?? {};
  if (!['human', 'ai'].includes(actorType)) {
    return res.status(400).json({ error: "actorType must be 'human' or 'ai'" });
  }
  if (actorType === 'ai' && !/^[a-z0-9 _.-]{2,32}$/i.test(String(agentName || '').trim())) {
    return res.status(400).json({ error: 'agentName is required for ai messages (2-32 chars)' });
  }
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
    agentName: actorType === 'ai' ? agentName.trim() : null,
    kind,
    text: body,
    pinnedMessageId: pinId,
  });
  broadcast(req.group.id, { type: 'message', message });
  res.status(201).json({ message });
});

// --- websocket fan-out -----------------------------------------------------
// Clients connect to /ws?groupId=N&userId=M and receive every new message in
// that group. Posting still goes through the REST API so validation and
// attribution live in one place.

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

/** @type {Map<number, Set<WebSocket>>} */
const rooms = new Map();

wss.on('connection', (ws, req) => {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const groupId = Number(params.get('groupId'));
  const user = getUser(Number(params.get('userId')));
  if (!groupId || !user) return ws.close(4001, 'groupId and userId required');
  const group = getGroupById(groupId);
  if (!group) return ws.close(4004, 'no such group');
  if (group.visibility === 'private' && !getMembership(groupId, user.id)) {
    return ws.close(4003, 'not a member of this group');
  }

  let room = rooms.get(groupId);
  if (!room) rooms.set(groupId, (room = new Set()));
  room.add(ws);
  ws.on('close', () => {
    room.delete(ws);
    if (room.size === 0) rooms.delete(groupId);
  });
});

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
