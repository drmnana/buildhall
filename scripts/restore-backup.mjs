// List, verify, or restore a Postgres logical backup (gzipped JSON snapshot).
//
//   node scripts/restore-backup.mjs                     # list available backups
//   node scripts/restore-backup.mjs <key> --verify      # download + validate + row counts
//   node scripts/restore-backup.mjs <key> --restore     # load into DATABASE_URL (must be empty)
//
// Requires the same BACKUP_S3_* env vars the server uses. --restore also needs
// DATABASE_URL and refuses to run unless the target tables are empty, so it can
// never silently clobber a live database.
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { gunzipSync } from 'node:zlib';

const CFG = {
  endpoint: process.env.BACKUP_S3_ENDPOINT,
  region: process.env.BACKUP_S3_REGION || 'auto',
  bucket: process.env.BACKUP_S3_BUCKET,
  accessKeyId: process.env.BACKUP_S3_KEY_ID,
  secretAccessKey: process.env.BACKUP_S3_SECRET,
  prefix: process.env.BACKUP_S3_PREFIX || 'buildhall/',
};
if (!CFG.endpoint || !CFG.bucket || !CFG.accessKeyId || !CFG.secretAccessKey) {
  console.error('Missing BACKUP_S3_* env vars. Set them to the same values the server uses.');
  process.exit(1);
}

const forcePathStyle = process.env.BACKUP_S3_FORCE_PATH_STYLE != null
  ? process.env.BACKUP_S3_FORCE_PATH_STYLE === 'true'
  : !/amazonaws\.com/i.test(CFG.endpoint || '');
const s3 = new S3Client({
  endpoint: CFG.endpoint, region: CFG.region,
  credentials: { accessKeyId: CFG.accessKeyId, secretAccessKey: CFG.secretAccessKey },
  forcePathStyle,
});

// Parent-first, matching the backup order, so FK references resolve on restore.
const TABLES = {
  users: ['id', 'username', 'display_name', 'password_hash', 'created_at'],
  groups: ['id', 'slug', 'name', 'description', 'goal', 'visibility', 'created_by', 'created_at'],
  memberships: ['group_id', 'user_id', 'role', 'joined_at'],
  messages: ['id', 'group_id', 'user_id', 'actor_type', 'agent_name', 'kind', 'pinned_message_id', 'text', 'created_at'],
  sessions: ['id', 'user_id', 'token_hash', 'created_at', 'expires_at', 'revoked_at'],
  bridge_tokens: ['id', 'session_id', 'user_id', 'agent_name', 'token_hash', 'created_at', 'revoked_at'],
};

const [key, flag] = process.argv.slice(2);

if (!key) {
  const list = await s3.send(new ListObjectsV2Command({ Bucket: CFG.bucket, Prefix: CFG.prefix }));
  const objs = (list.Contents || []).filter((o) => o.Key.endsWith('.json.gz')).sort((a, b) => (a.Key < b.Key ? 1 : -1));
  if (!objs.length) { console.log('No backups found under', CFG.prefix); process.exit(0); }
  console.log('Available backups (newest first):');
  for (const o of objs) console.log(`  ${o.Key}\t${o.Size} bytes\t${o.LastModified?.toISOString?.() || ''}`);
  console.log('\nVerify:  node scripts/restore-backup.mjs <key> --verify');
  process.exit(0);
}

const res = await s3.send(new GetObjectCommand({ Bucket: CFG.bucket, Key: key }));
const gz = Buffer.from(await res.Body.transformToByteArray());
const snap = JSON.parse(gunzipSync(gz).toString('utf8'));
console.log(`Downloaded ${key} (${gz.length} bytes gzip) — snapshot from ${snap.created_at}`);
const counts = Object.fromEntries(Object.entries(snap.tables || {}).map(([t, r]) => [t, r.length]));
console.log('rows ->', JSON.stringify(counts));

const missing = Object.keys(TABLES).filter((t) => !Array.isArray(snap.tables?.[t]));
if (missing.length) { console.error('INVALID snapshot — missing tables:', missing.join(', ')); process.exit(2); }

if (flag === '--verify') {
  console.log('\nVerified: snapshot is readable and contains every table. To load it into an');
  console.log('empty database, set DATABASE_URL and re-run with --restore.');
  process.exit(0);
}

if (flag === '--restore') {
  if (!process.env.DATABASE_URL) { console.error('set DATABASE_URL to the (empty) target Postgres'); process.exit(1); }
  const { pool, init } = await import('../src/db.js');
  await init();
  const client = await pool.connect();
  try {
    const existing = await client.query('SELECT count(*)::int AS n FROM users');
    if (existing.rows[0].n > 0) { console.error('REFUSING: target users table is not empty.'); process.exit(3); }
    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    for (const [table, cols] of Object.entries(TABLES)) {
      for (const row of snap.tables[table]) {
        const values = cols.map((c) => (row[c] === undefined ? null : row[c]));
        const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
        await client.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${ph})`, values);
      }
      if (cols.includes('id')) {
        await client.query(
          `SELECT setval(pg_get_serial_sequence($1,'id'), GREATEST((SELECT COALESCE(MAX(id),0) FROM ${table}),1))`,
          [table],
        );
      }
    }
    await client.query('COMMIT');
    console.log('Restore complete.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('restore failed, rolled back:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
  process.exit(0);
}

console.log('\nPass --verify to validate or --restore to load into DATABASE_URL.');
