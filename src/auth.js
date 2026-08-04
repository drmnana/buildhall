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
import { pool, NOW_ISO } from './db.js';

const SESSION_TTL_DAYS = 30;
const SCRYPT_KEYLEN = 64;

// --- query helpers ---------------------------------------------------------
async function one(sql, params) {
  const r = await pool.query(sql, params);
  return r.rows[0];
}

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

export async function createSession(userId) {
  const { raw, digest } = mintToken();
  const row = await one(
    'INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3) RETURNING id',
    [userId, digest, expiryISO(SESSION_TTL_DAYS)],
  );
  return { token: raw, sessionId: Number(row.id) };
}

/**
 * Resolve a bearer token to an identity.
 * Returns null for unknown, revoked, or expired tokens — the caller cannot
 * distinguish these cases, which is deliberate.
 */
export async function resolveToken(raw) {
  if (!raw) return null;
  const digest = digestToken(raw);
  const now = new Date().toISOString();

  const session = await one(
    `SELECT s.id AS session_id, s.user_id, s.expires_at, s.revoked_at
       FROM sessions s WHERE s.token_hash = $1`,
    [digest],
  );
  if (session) {
    if (session.revoked_at || session.expires_at <= now) return null;
    const user = await one('SELECT * FROM users WHERE id = $1', [session.user_id]);
    if (!user) return null;
    return { user, sessionId: session.session_id, kind: 'session', agentName: null, bridgeTokenId: null };
  }

  // A bridge token is only valid while its parent session is valid. The join
  // enforces that in one query so a revoked session can never leave a usable
  // child token behind.
  const bridge = await one(
    `SELECT b.id AS bridge_id, b.agent_name, b.revoked_at AS bridge_revoked,
            s.id AS session_id, s.user_id, s.expires_at, s.revoked_at AS session_revoked
       FROM bridge_tokens b
       JOIN sessions s ON s.id = b.session_id
      WHERE b.token_hash = $1`,
    [digest],
  );
  if (!bridge) return null;
  if (bridge.bridge_revoked || bridge.session_revoked || bridge.expires_at <= now) return null;
  const user = await one('SELECT * FROM users WHERE id = $1', [bridge.user_id]);
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

export async function createBridgeToken(sessionId, userId, agentName) {
  const { raw, digest } = mintToken();
  const row = await one(
    'INSERT INTO bridge_tokens (session_id, user_id, agent_name, token_hash) VALUES ($1, $2, $3, $4) RETURNING id',
    [sessionId, userId, agentName, digest],
  );
  return { token: raw, bridgeTokenId: Number(row.id) };
}

export async function listBridgeTokens(sessionId) {
  const r = await pool.query(
    `SELECT id, agent_name, created_at, revoked_at
       FROM bridge_tokens WHERE session_id = $1 ORDER BY id`,
    [sessionId],
  );
  return r.rows;
}

export async function revokeBridgeToken(sessionId, bridgeTokenId) {
  const r = await pool.query(
    `UPDATE bridge_tokens SET revoked_at = ${NOW_ISO}
      WHERE id = $1 AND session_id = $2 AND revoked_at IS NULL`,
    [bridgeTokenId, sessionId],
  );
  return r.rowCount > 0;
}

/**
 * Revoke a login session and every bridge token derived from it, in one
 * transaction so a crash cannot leave a live child behind a dead parent.
 * Returns the ids of bridge tokens that were live, so the caller can close
 * their sockets — revoking a row does not by itself disconnect anyone.
 */
export async function revokeSession(sessionId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const live = (await client.query(
      'SELECT id FROM bridge_tokens WHERE session_id = $1 AND revoked_at IS NULL',
      [sessionId],
    )).rows.map((r) => r.id);
    await client.query(
      `UPDATE sessions SET revoked_at = ${NOW_ISO} WHERE id = $1 AND revoked_at IS NULL`,
      [sessionId],
    );
    await client.query(
      `UPDATE bridge_tokens SET revoked_at = ${NOW_ISO} WHERE session_id = $1 AND revoked_at IS NULL`,
      [sessionId],
    );
    await client.query('COMMIT');
    return { revokedBridgeTokenIds: live };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// --- verification / reset tokens -------------------------------------------
// Same hashed-token discipline as sessions: the raw token is emailed once, only
// its digest is stored. Single-use and expiring.

export const VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24h
export const RESET_TTL_MS = 60 * 60 * 1000;       // 1h

export async function createAuthToken(userId, kind, ttlMs) {
  const { raw, digest } = mintToken();
  const expires = new Date(Date.now() + ttlMs).toISOString();
  await pool.query(
    'INSERT INTO auth_tokens (user_id, kind, token_hash, expires_at) VALUES ($1, $2, $3, $4)',
    [userId, kind, digest, expires],
  );
  return raw;
}

// Atomically consume a token: the single UPDATE ... RETURNING both checks
// validity (right kind, unused, unexpired) and marks it used, so a token can
// never be redeemed twice even under a race. Returns the user_id or null.
export async function consumeAuthToken(raw, kind) {
  if (!raw) return null;
  const digest = digestToken(raw);
  const now = new Date().toISOString();
  const r = await pool.query(
    `UPDATE auth_tokens SET used_at = ${NOW_ISO}
      WHERE token_hash = $1 AND kind = $2 AND used_at IS NULL AND expires_at > $3
      RETURNING user_id`,
    [digest, kind, now],
  );
  return r.rows[0]?.user_id ?? null;
}

// --- users -----------------------------------------------------------------

export async function createUserWithPassword(username, password) {
  const hash = hashPassword(password);
  return one(
    'INSERT INTO users (username, display_name, password_hash) VALUES ($1, $2, $3) RETURNING *',
    [username, username, hash],
  );
}

/** Strip secrets before a user row is ever serialized to a client. */
export function publicUser(user) {
  if (!user) return null;
  const { password_hash: _omit, email: _omit2, ...safe } = user;
  return safe;
}
