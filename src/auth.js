// Checkpoint 7 — session-bound authentication.
//
// Replaces the dev-grade `x-user-id` handshake, where the client simply
// asserted who it was. Three rules shape everything below:
//
//   1. Nothing the client sends identifies the user. Identity comes only from
//      a token the server minted and can look up.
//   2. Tokens are stored hashed. A leaked database does not hand over live
//      credentials, the same reason passwords are hashed.
//   3. A bridge token (the credential an agent/connector uses) is a CHILD of a
//      login session, never a standalone key. Killing the parent kills it.
//      This is what makes "log out" actually mean "my agent is disconnected".
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { db } from './db.js';

const SESSION_TTL_DAYS = 30;
const SCRYPT_KEYLEN = 64;

// --- password hashing ------------------------------------------------------

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const candidate = scryptSync(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(hash, 'hex');
  // Lengths must match before timingSafeEqual, which throws otherwise.
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

// --- token minting ---------------------------------------------------------
// The raw token is returned to the caller exactly once and never persisted.
// Only its SHA-256 digest is stored, so lookup is a digest comparison.

function mintToken() {
  const raw = randomBytes(32).toString('base64url');
  return { raw, digest: digestToken(raw) };
}

export function digestToken(raw) {
  return createHash('sha256').update(String(raw)).digest('hex');
}

function expiryISO(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

// --- sessions --------------------------------------------------------------

export function createSession(userId) {
  const { raw, digest } = mintToken();
  const { lastInsertRowid } = db
    .prepare('INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)')
    .run(userId, digest, expiryISO(SESSION_TTL_DAYS));
  return { token: raw, sessionId: Number(lastInsertRowid) };
}

/**
 * Resolve a bearer token to an identity.
 * Returns null for unknown, revoked, or expired tokens — the caller cannot
 * distinguish these cases, which is deliberate.
 */
export function resolveToken(raw) {
  if (!raw) return null;
  const digest = digestToken(raw);
  const now = new Date().toISOString();

  const session = db
    .prepare(
      `SELECT s.id AS session_id, s.user_id, s.expires_at, s.revoked_at
         FROM sessions s WHERE s.token_hash = ?`,
    )
    .get(digest);
  if (session) {
    if (session.revoked_at || session.expires_at <= now) return null;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
    if (!user) return null;
    return { user, sessionId: session.session_id, kind: 'session', agentName: null, bridgeTokenId: null };
  }

  // A bridge token is only valid while its parent session is valid. The join
  // enforces that in one query so a revoked session can never leave a usable
  // child token behind.
  const bridge = db
    .prepare(
      `SELECT b.id AS bridge_id, b.agent_name, b.revoked_at AS bridge_revoked,
              s.id AS session_id, s.user_id, s.expires_at, s.revoked_at AS session_revoked
         FROM bridge_tokens b
         JOIN sessions s ON s.id = b.session_id
        WHERE b.token_hash = ?`,
    )
    .get(digest);
  if (!bridge) return null;
  if (bridge.bridge_revoked || bridge.session_revoked || bridge.expires_at <= now) return null;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(bridge.user_id);
  if (!user) return null;
  return {
    user,
    sessionId: bridge.session_id,
    kind: 'bridge',
    agentName: bridge.agent_name,
    bridgeTokenId: bridge.bridge_id,
  };
}

// --- bridge tokens ---------------------------------------------------------

export function createBridgeToken(sessionId, userId, agentName) {
  const { raw, digest } = mintToken();
  const { lastInsertRowid } = db
    .prepare(
      'INSERT INTO bridge_tokens (session_id, user_id, agent_name, token_hash) VALUES (?, ?, ?, ?)',
    )
    .run(sessionId, userId, agentName, digest);
  return { token: raw, bridgeTokenId: Number(lastInsertRowid) };
}

export function listBridgeTokens(sessionId) {
  return db
    .prepare(
      `SELECT id, agent_name, created_at, revoked_at
         FROM bridge_tokens WHERE session_id = ? ORDER BY id`,
    )
    .all(sessionId);
}

export function revokeBridgeToken(sessionId, bridgeTokenId) {
  const { changes } = db
    .prepare(
      `UPDATE bridge_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND session_id = ? AND revoked_at IS NULL`,
    )
    .run(bridgeTokenId, sessionId);
  return changes > 0;
}

/**
 * Revoke a login session and every bridge token derived from it, in one
 * transaction so a crash cannot leave a live child behind a dead parent.
 * Returns the ids of bridge tokens that were live, so the caller can close
 * their sockets — revoking a row does not by itself disconnect anyone.
 */
export function revokeSession(sessionId) {
  const live = db
    .prepare('SELECT id FROM bridge_tokens WHERE session_id = ? AND revoked_at IS NULL')
    .all(sessionId)
    .map((r) => r.id);
  db.exec('BEGIN');
  try {
    db.prepare(
      `UPDATE sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND revoked_at IS NULL`,
    ).run(sessionId);
    db.prepare(
      `UPDATE bridge_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE session_id = ? AND revoked_at IS NULL`,
    ).run(sessionId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { revokedBridgeTokenIds: live };
}

// --- users -----------------------------------------------------------------

export function createUserWithPassword(username, password) {
  const hash = hashPassword(password);
  const { lastInsertRowid } = db
    .prepare('INSERT INTO users (username, display_name, password_hash) VALUES (?, ?, ?)')
    .run(username, username, hash);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
}

export function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

/** Strip secrets before a user row is ever serialized to a client. */
export function publicUser(user) {
  if (!user) return null;
  const { password_hash: _omit, ...safe } = user;
  return safe;
}
