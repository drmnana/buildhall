// One-time cutover import: pull the newest SQLite backup (.db) from S3 and load
// it into Postgres, from inside the running service.
//
// Why it lives server-side: the migration must run where Postgres is reachable
// (Render's internal network). It's driven over HTTPS via a guarded admin
// endpoint, so it works even where outbound Postgres ports are firewalled.
//
// Refuses if the target already has rows, so it can never double-import or
// clobber live data. Safe to leave in place; it's inert without the token and
// no-ops on a populated database.
import { DatabaseSync } from 'node:sqlite';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pool } from './db.js';

// Same table/column order as the backup + migration scripts (parent-first).
const TABLES = {
  users: ['id', 'username', 'display_name', 'password_hash', 'created_at'],
  groups: ['id', 'slug', 'name', 'description', 'goal', 'visibility', 'created_by', 'created_at'],
  memberships: ['group_id', 'user_id', 'role', 'joined_at'],
  messages: ['id', 'group_id', 'user_id', 'actor_type', 'agent_name', 'kind', 'pinned_message_id', 'text', 'created_at'],
  sessions: ['id', 'user_id', 'token_hash', 'created_at', 'expires_at', 'revoked_at'],
  bridge_tokens: ['id', 'session_id', 'user_id', 'agent_name', 'token_hash', 'created_at', 'revoked_at'],
};

function s3Client() {
  const endpoint = process.env.BACKUP_S3_ENDPOINT;
  const forcePathStyle = process.env.BACKUP_S3_FORCE_PATH_STYLE != null
    ? process.env.BACKUP_S3_FORCE_PATH_STYLE === 'true'
    : !/amazonaws\.com/i.test(endpoint || '');
  return new S3Client({
    endpoint,
    region: process.env.BACKUP_S3_REGION || 'auto',
    credentials: {
      accessKeyId: process.env.BACKUP_S3_KEY_ID,
      secretAccessKey: process.env.BACKUP_S3_SECRET,
    },
    forcePathStyle,
  });
}

export async function importLatestSqliteBackup() {
  const bucket = process.env.BACKUP_S3_BUCKET;
  const prefix = process.env.BACKUP_S3_PREFIX || 'buildhall/';
  if (!bucket || !process.env.BACKUP_S3_ENDPOINT) return { ok: false, error: 'S3 not configured' };

  // Refuse if the target already has data.
  const existing = await pool.query('SELECT count(*)::int AS n FROM users');
  if (existing.rows[0].n > 0) return { ok: false, error: 'target already has users — refusing to import' };

  const s3 = s3Client();
  const list = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
  const newest = (list.Contents || [])
    .filter((o) => o.Key.endsWith('.db'))
    .sort((a, b) => (a.Key < b.Key ? 1 : -1))[0];
  if (!newest) return { ok: false, error: 'no .db backup found in bucket' };

  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: newest.Key }));
  const bytes = Buffer.from(await obj.Body.transformToByteArray());
  const tmp = path.join(tmpdir(), `import-${Date.now()}.db`);
  writeFileSync(tmp, bytes);

  const sqlite = new DatabaseSync(tmp, { readOnly: true });
  const client = await pool.connect();
  const counts = {};
  try {
    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    for (const [table, cols] of Object.entries(TABLES)) {
      const order = cols.includes('id') ? 'ORDER BY id' : '';
      const rows = sqlite.prepare(`SELECT * FROM ${table} ${order}`).all();
      counts[table] = rows.length;
      for (const row of rows) {
        const values = cols.map((c) => (row[c] === undefined ? null : row[c]));
        const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
        await client.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${ph})`, values);
      }
      if (cols.includes('id')) {
        await client.query(
          `SELECT setval(pg_get_serial_sequence($1, 'id'),
                         GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${table}), 1))`,
          [table],
        );
      }
    }
    await client.query('COMMIT');
    return { ok: true, source: newest.Key, rows: counts };
  } catch (err) {
    await client.query('ROLLBACK');
    return { ok: false, error: err.message };
  } finally {
    client.release();
    sqlite.close();
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
  }
}
