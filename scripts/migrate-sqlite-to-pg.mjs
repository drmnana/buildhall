// One-time data migration: copy every row from the production SQLite database
// into Postgres, preserving primary keys, then advance each id sequence past
// the imported max so new inserts don't collide.
//
//   node scripts/migrate-sqlite-to-pg.mjs <path-to-buildhall.db>
//
// Requires DATABASE_URL (target Postgres). The target schema must already exist
// (start the server once, or it is created by importing db.js which runs init
// below). Idempotency is NOT assumed — run against a fresh/empty target.
import { DatabaseSync } from 'node:sqlite';
import { pool, init } from '../src/db.js';

const src = process.argv[2];
if (!src) { console.error('usage: node scripts/migrate-sqlite-to-pg.mjs <sqlite.db>'); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error('set DATABASE_URL to the target Postgres'); process.exit(1); }

// Parent-first so foreign keys resolve. messages is ordered by id at read time
// so a checkpoint's pinned_message_id (always an earlier, lower id) is inserted
// after its target.
const TABLES = {
  users: ['id', 'username', 'display_name', 'password_hash', 'created_at'],
  groups: ['id', 'slug', 'name', 'description', 'goal', 'visibility', 'created_by', 'created_at'],
  memberships: ['group_id', 'user_id', 'role', 'joined_at'],
  messages: ['id', 'group_id', 'user_id', 'actor_type', 'agent_name', 'kind', 'pinned_message_id', 'text', 'created_at'],
  sessions: ['id', 'user_id', 'token_hash', 'created_at', 'expires_at', 'revoked_at'],
  bridge_tokens: ['id', 'session_id', 'user_id', 'agent_name', 'token_hash', 'created_at', 'revoked_at'],
};

const sqlite = new DatabaseSync(src, { readOnly: true });
await init(); // ensure target schema exists

const client = await pool.connect();
const counts = {};
try {
  await client.query('BEGIN');
  // Defer FK checks so intra-batch ordering quirks can't trip us up.
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
    // Advance the BIGSERIAL sequence past the imported max id (tables with id).
    if (cols.includes('id')) {
      await client.query(
        `SELECT setval(pg_get_serial_sequence($1, 'id'),
                       GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${table}), 1))`,
        [table],
      );
    }
  }
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  console.error('migration failed, rolled back:', err.message);
  process.exit(1);
} finally {
  client.release();
  sqlite.close();
}

console.log('migrated rows:', JSON.stringify(counts));
await pool.end();
