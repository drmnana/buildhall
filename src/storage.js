// Database storage monitoring — know BEFORE the disk fills, not after.
//
// Render's plan gives a fixed disk (currently 15 GB, autoscaling off) and does
// not clearly document proactive storage alerts, so we watch it ourselves.
// Postgres can't see Render's disk limit, so the limit is configured via env
// (DB_STORAGE_LIMIT_GB, default 15) and compared against pg_database_size(),
// which slightly undercounts real disk (WAL, temp files) — the alert threshold
// is set at 80% to leave margin for that.
//
// Daily at 03:05 UTC (just before the backup at 03:15):
//   * always logs one line: [storage] used X MB of Y GB (Z%)
//   * at >= ALERT_PCT: console.error + one alert email per UTC day to
//     STORAGE_ALERT_EMAIL (if set and the mailer is configured).
//
// INERT-ish by default: with no env vars it still logs (free, useful) and
// simply skips email. Same graceful-degradation pattern as backups/classifier.
import { pool } from './db.js';
import { sendEmail } from './email.js';

const LIMIT_BYTES = Number(process.env.DB_STORAGE_LIMIT_GB || 15) * 1024 * 1024 * 1024;
const ALERT_PCT = Number(process.env.DB_STORAGE_ALERT_PCT || 80);
const ALERT_EMAIL = process.env.STORAGE_ALERT_EMAIL || '';

let lastAlertDay = null; // 'YYYY-MM-DD' of the last email, so we send at most one per day

export async function storageCheckOnce() {
  const { rows } = await pool.query('SELECT pg_database_size(current_database()) AS bytes');
  const used = Number(rows[0].bytes);
  const pct = (used / LIMIT_BYTES) * 100;
  const usedMB = (used / 1024 / 1024).toFixed(1);
  const limitGB = (LIMIT_BYTES / 1024 / 1024 / 1024).toFixed(0);
  const line = `[storage] used ${usedMB} MB of ${limitGB} GB (${pct.toFixed(2)}%)`;

  if (pct < ALERT_PCT) {
    console.log(line);
    return { ok: true, usedBytes: used, pct: Number(pct.toFixed(2)), alerted: false };
  }

  console.error(`${line} — ABOVE ${ALERT_PCT}% ALERT THRESHOLD`);
  const today = new Date().toISOString().slice(0, 10);
  let emailed = false;
  if (ALERT_EMAIL && lastAlertDay !== today) {
    const r = await sendEmail({
      to: ALERT_EMAIL,
      subject: `BuildHall DB storage at ${pct.toFixed(1)}% — action needed`,
      text: `Database storage is at ${pct.toFixed(1)}% of the ${limitGB} GB plan limit (${usedMB} MB used).\n\n` +
        `Options: increase storage on the Render dashboard (any multiple of 5 GB, no downtime), ` +
        `enable storage autoscaling, or prune old data.\n\n` +
        `This alert repeats at most once per day while usage stays above ${ALERT_PCT}%.`,
    });
    emailed = r.ok;
    if (r.ok) lastAlertDay = today;
    else console.error('[storage] alert email failed:', r.error);
  }
  return { ok: true, usedBytes: used, pct: Number(pct.toFixed(2)), alerted: true, emailed };
}

/** Start the daily check (call once at boot). Also runs once shortly after boot. */
export function scheduleStorageChecks(log = console.log) {
  const run = () => storageCheckOnce().catch((e) => console.error('[storage] check failed:', e.message)).finally(schedule);
  const schedule = () => {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(3, 5, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    const t = setTimeout(run, next - now);
    t.unref?.();
  };
  schedule();
  // First reading shortly after boot so every deploy logs current usage.
  const t = setTimeout(() => storageCheckOnce().catch(() => {}), 20000);
  t.unref?.();
  log(`[storage] daily check scheduled (limit ${(LIMIT_BYTES / 1024 ** 3).toFixed(0)} GB, alert at ${ALERT_PCT}%${ALERT_EMAIL ? `, email to ${ALERT_EMAIL}` : ', no alert email set'})`);
}
