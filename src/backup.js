// Off-box database backups.
//
// WHY THIS EXISTS: the whole platform is one SQLite file on one Render disk in
// one region. A disk fault, a bad deploy, or a corrupt write with no independent
// copy means total, unrecoverable data loss. This ships a *consistent* copy of
// the database to S3-compatible object storage (Cloudflare R2 / Backblaze B2 /
// AWS S3) on a nightly schedule, keeps a rolling window, and prunes the rest.
//
// CONSISTENCY: we use SQLite's `VACUUM INTO`, which writes a fully-checkpointed,
// transactionally-consistent copy — never a half-written page. A plain file copy
// of a live WAL database can capture it mid-write and restore corrupt; this can't.
//
// IN-PROCESS ON PURPOSE: a Render cron job does NOT mount the persistent disk, so
// it cannot read /var/data. The web service process owns the DB and the disk, so
// the backup runs here, inside it.
//
// INERT UNTIL CONFIGURED: with no S3 env vars set, this logs once and does
// nothing — safe to deploy before the bucket exists.
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { db } from './db.js';

const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const DB_FILE = path.join(DATA_DIR, 'buildhall.db');

// Config from env. All five are required to enable backups.
const CFG = {
  endpoint: process.env.BACKUP_S3_ENDPOINT,     // e.g. https://<acct>.r2.cloudflarestorage.com
  region: process.env.BACKUP_S3_REGION || 'auto',
  bucket: process.env.BACKUP_S3_BUCKET,
  accessKeyId: process.env.BACKUP_S3_KEY_ID,
  secretAccessKey: process.env.BACKUP_S3_SECRET,
  prefix: process.env.BACKUP_S3_PREFIX || 'buildhall/',
  keep: Number(process.env.BACKUP_KEEP || 14),  // rolling window of nightly copies
};

export function backupsConfigured() {
  return Boolean(CFG.endpoint && CFG.bucket && CFG.accessKeyId && CFG.secretAccessKey);
}

function client() {
  return new S3Client({
    endpoint: CFG.endpoint,
    region: CFG.region,
    credentials: { accessKeyId: CFG.accessKeyId, secretAccessKey: CFG.secretAccessKey },
    forcePathStyle: true, // R2/B2/MinIO are happiest with path-style addressing
  });
}

// ISO-ish, filesystem/key-safe timestamp. Injected so callers control the clock
// (and so tests are deterministic).
function stamp(now) {
  return now.toISOString().replace(/[:.]/g, '-');
}

// Produce a consistent on-disk snapshot of the DB and return its path. The
// caller must delete it after upload.
function snapshot(now) {
  const out = path.join(DATA_DIR, `.backup-${stamp(now)}.db`);
  if (existsSync(out)) rmSync(out, { force: true });
  // VACUUM INTO cannot be parameterised; `out` is a server-controlled path with
  // no quotes, so there is nothing to inject.
  db.exec(`VACUUM INTO '${out}'`);
  return out;
}

/**
 * Run one backup: snapshot -> upload -> prune old copies. Returns a result
 * object; never throws (so a failed nightly run can't crash the server).
 */
export async function backupOnce(now = new Date()) {
  if (!backupsConfigured()) return { ok: false, skipped: true, reason: 'backups not configured' };
  let snapPath;
  try {
    snapPath = snapshot(now);
    const body = readFileSync(snapPath);
    const key = `${CFG.prefix}buildhall-${stamp(now)}.db`;
    const s3 = client();
    await s3.send(new PutObjectCommand({
      Bucket: CFG.bucket, Key: key, Body: body,
      ContentType: 'application/x-sqlite3',
    }));
    const pruned = await prune(s3);
    return { ok: true, key, bytes: body.length, pruned };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (snapPath) { try { rmSync(snapPath, { force: true }); } catch { /* best effort */ } }
  }
}

// Keep the newest CFG.keep objects under the prefix; delete the rest.
async function prune(s3) {
  const list = await s3.send(new ListObjectsV2Command({ Bucket: CFG.bucket, Prefix: CFG.prefix }));
  const objs = (list.Contents || [])
    .filter((o) => o.Key.endsWith('.db'))
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
