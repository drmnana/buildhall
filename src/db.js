// Postgres storage via node-postgres (pg). Async data-access layer.
//
// Migrated from node:sqlite. Two things worth knowing:
//   * Timestamps stay TEXT in ISO-8601 millis-Z form (e.g. 2026-08-03T04:51:58.447Z),
//     exactly as the old SQLite schema produced them. The API shape is unchanged
//     and resolveToken()'s lexical `expires_at <= now` comparison keeps working.
//   * BIGINT ids are parsed back into JS numbers (see setTypeParser below), so
//     ids stay numbers everywhere the app already treats them as numbers.
import pg from 'pg';

const { Pool, types } = pg;

// pg returns int8/BIGINT as strings by default (to avoid precision loss beyond
// 2^53). Our ids are nowhere near that, and the app compares/serializes ids as
// numbers, so parse OID 20 (int8) into a JS number to match SQLite's behaviour.
types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));

// SSL: Render's internal database URL needs none; an external URL does. Default
// to no SSL for localhost and relaxed SSL otherwise; DATABASE_SSL overrides.
function sslConfig() {
  const mode = process.env.DATABASE_SSL;
  if (mode === 'disable') return false;
  if (mode === 'require') return { rejectUnauthorized: false };
  const url = process.env.DATABASE_URL || '';
  if (/@(localhost|127\.0\.0\.1)/.test(url) || !url) return false;
  return { rejectUnauthorized: false };
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig(),
  max: Number(process.env.PG_POOL_MAX || 10),
});

// Small query helpers. `one` returns the first row (or undefined); `many`
// returns all rows; `run` returns the raw result (for rowCount).
async function one(sql, params) {
  const r = await pool.query(sql, params);
  return r.rows[0];
}
async function many(sql, params) {
  const r = await pool.query(sql, params);
  return r.rows;
}
async function run(sql, params) {
  return pool.query(sql, params);
}

// The Postgres expression that reproduces SQLite's strftime('%Y-%m-%dT%H:%M:%fZ')
// UTC-millis-Z string, used for every created_at/joined_at default and every
// revoked_at stamp so timestamps stay byte-identical to the old schema.
const NOW_ISO = `to_char((now() at time zone 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const SCHEMA = `
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  username      CITEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT,
  created_at    TEXT NOT NULL DEFAULT ${NOW_ISO}
);

CREATE TABLE IF NOT EXISTS groups (
  id          BIGSERIAL PRIMARY KEY,
  slug        CITEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  goal        TEXT NOT NULL DEFAULT '',
  visibility  TEXT NOT NULL DEFAULT 'private'
              CHECK (visibility IN ('public','unlisted','private')),
  created_by  BIGINT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT ${NOW_ISO}
);

CREATE TABLE IF NOT EXISTS memberships (
  group_id  BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'member'
            CHECK (role IN ('admin','member','viewer')),
  joined_at TEXT NOT NULL DEFAULT ${NOW_ISO},
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id                BIGSERIAL PRIMARY KEY,
  group_id          BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id           BIGINT NOT NULL REFERENCES users(id),
  actor_type        TEXT NOT NULL CHECK (actor_type IN ('human','ai','system')),
  agent_name        TEXT,
  kind              TEXT NOT NULL DEFAULT 'message'
                    CHECK (kind IN ('message','checkpoint')),
  pinned_message_id BIGINT REFERENCES messages(id),
  text              TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT ${NOW_ISO}
);
CREATE INDEX IF NOT EXISTS idx_messages_group_time ON messages (group_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_checkpoints
  ON messages (group_id, kind) WHERE kind = 'checkpoint';

CREATE TABLE IF NOT EXISTS sessions (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT ${NOW_ISO},
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS bridge_tokens (
  id         BIGSERIAL PRIMARY KEY,
  session_id BIGINT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT ${NOW_ISO},
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_bridge_tokens_session ON bridge_tokens (session_id);
`;

// Create the schema. Idempotent; call once at boot before serving.
export async function init() {
  await pool.query(SCHEMA);
}

// Re-export the stamp expression so auth.js uses the identical timestamp form.
export { NOW_ISO };

// --- users ---------------------------------------------------------------

export async function findOrCreateUser(username) {
  const created = await one(
    `INSERT INTO users (username, display_name) VALUES ($1, $2)
     ON CONFLICT (username) DO NOTHING RETURNING *`,
    [username, username],
  );
  if (created) return created;
  return one('SELECT * FROM users WHERE username = $1', [username]);
}

export async function getUser(id) {
  return one('SELECT * FROM users WHERE id = $1', [id]);
}

// --- groups --------------------------------------------------------------

export async function createGroup({ slug, name, description, goal, visibility, createdBy }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO groups (slug, name, description, goal, visibility, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [slug, name, description ?? '', goal ?? '', visibility ?? 'private', createdBy],
    );
    const group = rows[0];
    // creator starts as admin
    await client.query(
      `INSERT INTO memberships (group_id, user_id, role) VALUES ($1, $2, 'admin')`,
      [group.id, createdBy],
    );
    await client.query('COMMIT');
    return group;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getGroupBySlug(slug) {
  return one('SELECT * FROM groups WHERE slug = $1', [slug]);
}

export async function getGroupById(id) {
  return one('SELECT * FROM groups WHERE id = $1', [id]);
}

export async function listGroupsForUser(userId) {
  return many(
    `SELECT g.*, m.role FROM groups g
     JOIN memberships m ON m.group_id = g.id
     WHERE m.user_id = $1
     ORDER BY g.created_at DESC`,
    [userId],
  );
}

export async function getMembership(groupId, userId) {
  return one('SELECT * FROM memberships WHERE group_id = $1 AND user_id = $2', [groupId, userId]);
}

export async function joinGroup(groupId, userId, role = 'member') {
  await run(
    `INSERT INTO memberships (group_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (group_id, user_id) DO NOTHING`,
    [groupId, userId, role],
  );
  return getMembership(groupId, userId);
}

// --- messages ------------------------------------------------------------

export async function addMessage({ groupId, userId, actorType, agentName, kind, pinnedMessageId, text }) {
  // Insert and join the author in one round trip via a CTE.
  return one(
    `WITH ins AS (
       INSERT INTO messages (group_id, user_id, actor_type, agent_name, kind, pinned_message_id, text)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *
     )
     SELECT ins.*, u.username, u.display_name FROM ins JOIN users u ON u.id = ins.user_id`,
    [groupId, userId, actorType, agentName ?? null, kind ?? 'message', pinnedMessageId ?? null, text],
  );
}

export async function getMessageInGroup(groupId, messageId) {
  return one('SELECT * FROM messages WHERE id = $1 AND group_id = $2', [messageId, groupId]);
}

export const MESSAGES_PAGE_LIMIT = 200;

export async function listMessages(groupId, { afterId = 0, beforeId = 0, limit = MESSAGES_PAGE_LIMIT } = {}) {
  limit = Math.min(Math.max(1, limit), MESSAGES_PAGE_LIMIT);
  if (beforeId > 0) {
    // backward page (older history): newest `limit` rows below beforeId, then
    // flipped back to ascending like every other message response
    return many(
      `SELECT * FROM (
         SELECT m.*, u.username, u.display_name FROM messages m
         JOIN users u ON u.id = m.user_id
         WHERE m.group_id = $1 AND m.id < $2
         ORDER BY m.id DESC LIMIT $3
       ) sub ORDER BY id ASC`,
      [groupId, beforeId, limit],
    );
  }
  return many(
    `SELECT m.*, u.username, u.display_name FROM messages m
     JOIN users u ON u.id = m.user_id
     WHERE m.group_id = $1 AND m.id > $2
     ORDER BY m.id ASC LIMIT $3`,
    [groupId, afterId, limit],
  );
}

// Newest `limit` messages in ascending order — the "last N" slice an agent
// needs to catch up on a conversation without paging through history.
export async function lastMessages(groupId, limit = 50) {
  limit = Math.min(Math.max(1, limit), MESSAGES_PAGE_LIMIT);
  return many(
    `SELECT * FROM (
       SELECT m.*, u.username, u.display_name FROM messages m
       JOIN users u ON u.id = m.user_id
       WHERE m.group_id = $1
       ORDER BY m.id DESC LIMIT $2
     ) sub ORDER BY id ASC`,
    [groupId, limit],
  );
}

// --- checkpoints ----------------------------------------------------------

export async function listCheckpoints(groupId, limit = 20) {
  limit = Math.min(Math.max(1, limit), 100);
  return many(
    `SELECT m.*, u.username, u.display_name FROM messages m
     JOIN users u ON u.id = m.user_id
     WHERE m.group_id = $1 AND m.kind = 'checkpoint'
     ORDER BY m.id DESC LIMIT $2`,
    [groupId, limit],
  );
}

export async function latestCheckpoint(groupId) {
  return (await listCheckpoints(groupId, 1))[0] ?? null;
}

// --- public feed ---------------------------------------------------------

// One card per public group: name, description, member/agent counts, and the
// latest checkpoint (falling back to the latest message) as the preview.
export async function publicFeed(limit = 50) {
  return many(
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
     LIMIT $1`,
    [limit],
  );
}
