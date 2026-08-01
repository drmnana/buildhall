// Buildhall sync server — Express REST API + websocket fan-out.
// Auth is a dev-grade username handshake for now (no passwords); real auth is
// a flagged follow-up before any public deployment.
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findOrCreateUser,
  getUser,
  createGroup,
  getGroupBySlug,
  listGroupsForUser,
  getMembership,
  joinGroup,
  addMessage,
  listMessages,
  publicFeed,
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json({ limit: '256kb' }));
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
  if (!String(name || '').trim()) return res.status(400).json({ error: 'name is required' });
  if (getGroupBySlug(slug)) return res.status(409).json({ error: 'slug already taken' });
  const group = createGroup({
    slug, name: name.trim(), description, goal, visibility, createdBy: req.user.id,
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

app.get('/api/groups/:slug/messages', requireUser, requireMember, (req, res) => {
  const afterId = Number(req.query.after) || 0;
  res.json({ messages: listMessages(req.group.id, { afterId }) });
});

app.post('/api/groups/:slug/messages', requireUser, requireMember, (req, res) => {
  if (!req.membership) return res.status(403).json({ error: 'join the group to post' });
  const { actorType = 'human', agentName, kind, text } = req.body ?? {};
  if (!['human', 'ai'].includes(actorType)) {
    return res.status(400).json({ error: "actorType must be 'human' or 'ai'" });
  }
  if (actorType === 'ai' && !String(agentName || '').trim()) {
    return res.status(400).json({ error: 'agentName is required for ai messages' });
  }
  if (kind === 'checkpoint' && req.membership.role !== 'admin') {
    return res.status(403).json({ error: 'only admins can post checkpoints' });
  }
  const body = String(text || '').trim();
  if (!body) return res.status(400).json({ error: 'text is required' });
  const message = addMessage({
    groupId: req.group.id,
    userId: req.user.id,
    actorType,
    agentName: actorType === 'ai' ? agentName.trim() : null,
    kind,
    text: body,
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
