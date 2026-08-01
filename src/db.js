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
    text        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE INDEX IF NOT EXISTS idx_messages_group_time
    ON messages (group_id, id);
  CREATE INDEX IF NOT EXISTS idx_messages_checkpoints
    ON messages (group_id, kind) WHERE kind = 'checkpoint';
`);

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

export function addMessage({ groupId, userId, actorType, agentName, kind, text }) {
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO messages (group_id, user_id, actor_type, agent_name, kind, text)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(groupId, userId, actorType, agentName ?? null, kind ?? 'message', text);
  return db
    .prepare(
      `SELECT m.*, u.username, u.display_name FROM messages m
       JOIN users u ON u.id = m.user_id WHERE m.id = ?`
    )
    .get(lastInsertRowid);
}

export function listMessages(groupId, { afterId = 0, limit = 200 } = {}) {
  return db
    .prepare(
      `SELECT m.*, u.username, u.display_name FROM messages m
       JOIN users u ON u.id = m.user_id
       WHERE m.group_id = ? AND m.id > ?
       ORDER BY m.id ASC LIMIT ?`
    )
    .all(groupId, afterId, limit);
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
