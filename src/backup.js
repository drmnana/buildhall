// Off-box database backups (Postgres edition).
//
// Render Postgres has managed daily backups + point-in-time recovery, but those
// live with the same vendor. This ships an INDEPENDENT logical snapshot to
// S3-compatible object storage (the AWS bucket set up for this) on a nightly
// schedule, so a full Render outage or account problem still leaves a recover-
// able copy somewhere else entirely. Defense in depth, not the only defense.
//
// Format: a gzipped JSON document { version, created_at, tables: {name: rows} }.
// Small and dependency-light (pg + zlib); fine at this scale. See
// scripts/restore-backup.mjs for the read-back / verify path.
//
// INERT UNTIL CONFIGURED: with no S3 env vars set, this logs once and does
// nothing — safe to deploy before the bucket exists.
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { gzipSync } from 'node:zlib';
import { pool } from './db.js';

// Dumped parent-first so a restore can insert in FK order.
const TABLES = ['users', 'groups', 'memberships', 'messages', 'sessions', 'bridge_tokens'];

const CFG = {
  endpoint: process.env.BACKUP_S3_ENDPOINT,
  region: process.env.BACKUP_S3_REGION || 'auto',
  bucket: process.env.BACKUP_S3_BUCKET,
  accessKeyId: process.env.BACKUP_S3_KEY_ID,
  secretAccessKey: process.env.BACKUP_S3_SECRET,
  prefix: process.env.BACKUP_S3_PREFIX || 'buildhall/',
  keep: Number(process.env.BACKUP_KEEP || 14),
};

export function backupsConfigured() {
  return Boolean(CFG.endpoint && CFG.bucket && CFG.accessKeyId && CFG.secretAccessKey);
}

// AWS S3 uses virtual-hosted-style addressing (it has deprecated path-style);
// R2/B2/MinIO want path-style. Auto-detect, with an explicit override.
function usePathStyle() {
  if (process.env.BACKUP_S3_FORCE_PATH_STYLE != null) return process.env.BACKUP_S3_FORCE_PATH_STYLE === 'true';
  return !/amazonaws\.com/i.test(CFG.endpoint || '');
}

function client() {
  return new S3Client({
    endpoint: CFG.endpoint,
    region: CFG.region,
    credentials: { accessKeyId: CFG.accessKeyId, secretAccessKey: CFG.secretAccessKey },
    forcePathStyle: usePathStyle(),
  });
}

function stamp(now) {
  return now.toISOString().replace(/[:.]/g, '-');
}

// Build a consistent snapshot inside one REPEATABLE READ transaction, so every
// table is read at the same point in time (no torn state across tables).
async function snapshot(now) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tables = {};
    for (const t of TABLES) {
      // Table names come from the fixed TABLES allowlist above, never input.
      tables[t] = (await c.query(`SELECT * FROM ${t} ORDER BY 1`)).rows;
    }
    await c.query('COMMIT');
    return { version: 1, created_at: now.toISOString(), tables };
  } catch (err) {
    try { await c.query('ROLLBACK'); } catch { /* already gone */ }
    throw err;
  } finally {
    c.release();
  }
}

/**
 * Run one backup: snapshot -> gzip -> upload -> prune old copies. Returns a
 * result object; never throws (so a failed nightly run can't crash the server).
 */
export async function backupOnce(now = new Date()) {
  if (!backupsConfigured()) return { ok: false, skipped: true, reason: 'backups not configured' };
  try {
    const snap = await snapshot(now);
    const body = gzipSync(Buffer.from(JSON.stringify(snap), 'utf8'));
    const key = `${CFG.prefix}buildhall-${stamp(now)}.json.gz`;
    const s3 = client();
    await s3.send(new PutObjectCommand({
      Bucket: CFG.bucket, Key: key, Body: body,
      ContentType: 'application/gzip',
    }));
    const rows = Object.fromEntries(Object.entries(snap.tables).map(([t, r]) => [t, r.length]));
    const pruned = await prune(s3);
    return { ok: true, key, bytes: body.length, rows, pruned };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Keep the newest CFG.keep objects under the prefix; delete the rest.
async function prune(s3) {
  const list = await s3.send(new ListObjectsV2Command({ Bucket: CFG.bucket, Prefix: CFG.prefix }));
  const objs = (list.Contents || [])
    .filter((o) => o.Key.endsWith('.json.gz'))
    .sort((a, b) => (a.Key < b.Key ? 1 : -1)); // newest first (timestamped keys sort lexically)
  const stale = objs.slice(CFG.keep);
  if (!stale.length) return 0;
  await s3.send(new DeleteObjectsCommand({
    Bucket: CFG.bucket,
    Delete: { Objects: stale.map((o) => ({ Key: o.Key })) },
  }));
  return stale.length;
}

// Schedule a backup every night at ~03:15 UTC (low-traffic). Reschedules itself
// after each run. Uses wall-clock so it survives long uptimes without drift.
export function scheduleBackups(log = console.log) {
  if (!backupsConfigured()) {
    log('[backup] disabled — set BACKUP_S3_* env vars to enable off-box backups');
    return;
  }
  const run = async () => {
    const r = await backupOnce();
    if (r.ok) log(`[backup] uploaded ${r.key} (${r.bytes} bytes), pruned ${r.pruned}`);
    else log(`[backup] FAILED: ${r.error || r.reason}`);
    schedule();
  };
  const schedule = () => {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(3, 15, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    const ms = next - now;
    const t = setTimeout(run, ms);
    t.unref?.();
    log(`[backup] next run at ${next.toISOString()} (${Math.round(ms / 3600000)}h)`);
  };
  schedule();
}
