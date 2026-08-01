// SQLite storage via node:sqlite (built into Node >= 22.5) — zero native deps,
// swappable for Postgres when we deploy to Render.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'buildhall.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS groups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slug        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    goal        TEXT NOT NULL DEFAULT '',
    -- groups start private and opt IN to the public feed
    visibility  TEXT NOT NULL DEFAULT 'private'
                CHECK (visibility IN ('public','unlisted','private')),
    created_by  INTEGER NOT NULL REFERENCES users(id),
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS memberships (
    group_id    INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        TEXT NOT NULL DEFAULT 'member'
                CHECK (role IN ('admin','member','viewer')),
    joined_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (group_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id    INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    -- who actually authored this: the human at the keyboard, their agent
    -- via the connector, or the system itself
    actor_type  TEXT NOT NULL CHECK (actor_type IN ('human','ai','system')),
    -- e.g. 'claude', 'codex' — only set when actor_type = 'ai'
    agent_name  TEXT,
    -- checkpoints are admin-posted summaries, pinned in the UI and shown
    -- as the group's preview in the public feed
    kind        TEXT NOT NULL DEFAULT 'message'
                CHECK (kind IN ('message','checkpoint')),
    -- a checkpoint may pin the specific message it marks; null for plain
    -- checkpoints and for every non-checkpoint message
    pinned_message_id INTEGER REFERENCES messages(id),
    text        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE INDEX IF NOT EXISTS idx_messages_group_time
    ON messages (group_id, id);
  CREATE INDEX IF NOT EXISTS idx_messages_checkpoints
    ON messages (group_id, kind) WHERE kind = 'checkpoint';

  -- Checkpoint 7 auth. A login session is the root credential; a bridge token
  -- (what an agent/connector authenticates with) hangs off one via ON DELETE
  -- CASCADE, so a session can never leave an orphaned child token behind.
  -- Only SHA-256 digests are stored: the raw token exists once, in the
  -- response that minted it.
  CREATE TABLE IF NOT EXISTS sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    expires_at  TEXT NOT NULL,
    revoked_at  TEXT
  );

  CREATE TABLE IF NOT EXISTS bridge_tokens (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_name  TEXT NOT NULL,
    token_hash  TEXT NOT NULL UNIQUE,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    revoked_at  TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_bridge_tokens_session
    ON bridge_tokens (session_id);
`);

// Migration for databases created before pinned_message_id existed: CREATE
// TABLE IF NOT EXISTS won't touch them, so add the column in place.
const messageColumns = db.prepare(`SELECT name FROM pragma_table_info('messages')`).all();
if (!messageColumns.some((c) => c.name === 'pinned_message_id')) {
  db.exec(`ALTER TABLE messages ADD COLUMN pinned_message_id INTEGER REFERENCES messages(id)`);
}

// Same in-place migration for auth: databases created under the pre-checkpoint-7
// schema have no password_hash. It stays NULL for those rows, and a NULL hash
// can never satisfy verifyPassword, so legacy accounts are inert rather than
// silently loginable.
const userColumns = db.prepare(`SELECT name FROM pragma_table_info('users')`).all();
if (!userColumns.some((c) => c.name === 'password_hash')) {
  db.exec(`ALTER TABLE users ADD COLUMN password_hash TEXT`);
}

// --- users ---------------------------------------------------------------

export function findOrCreateUser(username) {
  const existing = db
    .prepare('SELECT * FROM users WHERE username = ?')
    .get(username);
  if (existing) return existing;
  const { lastInsertRowid } = db
    .prepare('INSERT INTO users (username, display_name) VALUES (?, ?)')
    .run(username, username);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
}

export function getUser(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

// --- groups --------------------------------------------------------------

export function createGroup({ slug, name, description, goal, visibility, createdBy }) {
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO groups (slug, name, description, goal, visibility, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(slug, name, description ?? '', goal ?? '', visibility ?? 'private', createdBy);
  // creator starts as admin
  db.prepare(
    `INSERT INTO memberships (group_id, user_id, role) VALUES (?, ?, 'admin')`
  ).run(lastInsertRowid, createdBy);
  return getGroupBySlug(slug);
}

export function getGroupBySlug(slug) {
  return db.prepare('SELECT * FROM groups WHERE slug = ?').get(slug);
}

export function getGroupById(id) {
  return db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
}

export function listGroupsForUser(userId) {
  return db
    .prepare(
      `SELECT g.*, m.role FROM groups g
       JOIN memberships m ON m.group_id = g.id
       WHERE m.user_id = ?
       ORDER BY g.created_at DESC`
    )
    .all(userId);
}

export function getMembership(groupId, userId) {
  return db
    .prepare('SELECT * FROM memberships WHERE group_id = ? AND user_id = ?')
    .get(groupId, userId);
}

export function joinGroup(groupId, userId, role = 'member') {
  db.prepare(
    `INSERT OR IGNORE INTO memberships (group_id, user_id, role) VALUES (?, ?, ?)`
  ).run(groupId, userId, role);
  return getMembership(groupId, userId);
}

// --- messages ------------------------------------------------------------

export function addMessage({ groupId, userId, actorType, agentName, kind, pinnedMessageId, text }) {
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO messages (group_id, user_id, actor_type, agent_name, kind, pinned_message_id, text)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(groupId, userId, actorType, agentName ?? null, kind ?? 'message', pinnedMessageId ?? null, text);
  return db
    .prepare(
      `SELECT m.*, u.username, u.display_name FROM messages m
       JOIN users u ON u.id = m.user_id WHERE m.id = ?`
    )
    .get(lastInsertRowid);
}

export function getMessageInGroup(groupId, messageId) {
  return db
    .prepare('SELECT * FROM messages WHERE id = ? AND group_id = ?')
    .get(messageId, groupId);
}

export const MESSAGES_PAGE_LIMIT = 200;

export function listMessages(groupId, { afterId = 0, beforeId = 0, limit = MESSAGES_PAGE_LIMIT } = {}) {
  limit = Math.min(Math.max(1, limit), MESSAGES_PAGE_LIMIT);
  if (beforeId > 0) {
    // backward page (loading older history): newest `limit` rows below beforeId,
    // returned in ascending order like every other message response
    return db
      .prepare(
        `SELECT * FROM (
           SELECT m.*, u.username, u.display_name FROM messages m
           JOIN users u ON u.id = m.user_id
           WHERE m.group_id = ? AND m.id < ?
           ORDER BY m.id DESC LIMIT ?
         ) ORDER BY id ASC`
      )
      .all(groupId, beforeId, limit);
  }
  return db
    .prepare(
      `SELECT m.*, u.username, u.display_name FROM messages m
       JOIN users u ON u.id = m.user_id
       WHERE m.group_id = ? AND m.id > ?
       ORDER BY m.id ASC LIMIT ?`
    )
    .all(groupId, afterId, limit);
}

// Newest `limit` messages in ascending order — the "last N" slice an agent
// needs to catch up on a conversation without paging through history.
export function lastMessages(groupId, limit = 50) {
  limit = Math.min(Math.max(1, limit), MESSAGES_PAGE_LIMIT);
  return db
    .prepare(
      `SELECT * FROM (
         SELECT m.*, u.username, u.display_name FROM messages m
         JOIN users u ON u.id = m.user_id
         WHERE m.group_id = ?
         ORDER BY m.id DESC LIMIT ?
       ) ORDER BY id ASC`
    )
    .all(groupId, limit);
}

// --- checkpoints ----------------------------------------------------------

export function listCheckpoints(groupId, limit = 20) {
  limit = Math.min(Math.max(1, limit), 100);
  return db
    .prepare(
      `SELECT m.*, u.username, u.display_name FROM messages m
       JOIN users u ON u.id = m.user_id
       WHERE m.group_id = ? AND m.kind = 'checkpoint'
       ORDER BY m.id DESC LIMIT ?`
    )
    .all(groupId, limit);
}

export function latestCheckpoint(groupId) {
  return listCheckpoints(groupId, 1)[0] ?? null;
}

// --- public feed ---------------------------------------------------------

// One card per public group: name, description, member/agent counts, and the
// latest checkpoint (falling back to the latest message) as the preview.
export function publicFeed(limit = 50) {
  return db
    .prepare(
      `SELECT g.slug, g.name, g.description, g.goal, g.created_at,
              (SELECT COUNT(*) FROM memberships m WHERE m.group_id = g.id) AS member_count,
              (SELECT COUNT(*) FROM messages ms WHERE ms.group_id = g.id) AS message_count,
              (SELECT text FROM messages ms
                WHERE ms.group_id = g.id AND ms.kind = 'checkpoint'
                ORDER BY ms.id DESC LIMIT 1) AS latest_checkpoint,
              (SELECT text FROM messages ms
                WHERE ms.group_id = g.id
                ORDER BY ms.id DESC LIMIT 1) AS latest_message,
              (SELECT MAX(created_at) FROM messages ms
                WHERE ms.group_id = g.id) AS last_activity_at
       FROM groups g
       WHERE g.visibility = 'public'
       ORDER BY last_activity_at DESC NULLS LAST
       LIMIT ?`
    )
    .all(limit);
}
