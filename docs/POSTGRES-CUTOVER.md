# Postgres cutover runbook

The `postgres-migration` branch replaces the SQLite storage layer with Postgres
(async `pg`). It is **built and fully tested** but NOT yet cut over in production.
This is the deliberate, reviewed procedure to flip production. Do it when you can
watch it — not unattended.

## What's already done (on the branch)

- `src/db.js`, `src/auth.js`, `src/server.js` rewritten for async Postgres. Every
  handler awaits the data layer; a shared `ah()` wrapper turns a rejected promise
  into a clean 500 instead of a hung request.
- `src/backup.js` now takes a Postgres logical snapshot (gzipped JSON of every
  table) to S3 — the same bucket, kept as an independent off-Render copy.
- `scripts/migrate-sqlite-to-pg.mjs` copies all rows from the production SQLite
  file into Postgres, preserving ids and advancing sequences.
- Verified locally against Postgres 16: a 37-case integration suite (auth,
  sessions, bridge tokens, revocation cascade, groups, messages, pagination,
  checkpoints, feed, websocket) passes, and the **real production data** (9 users,
  8 groups, 47 messages, 14 bridge tokens) migrated with exact matching counts,
  correct sequences, and preserved timestamp formats.

## Why this is a reviewed step, not automatic

Cutover provisions a billable Render Postgres instance and repoints the live
database. A botched flip means downtime. The data is safe (backups exist), but
availability is not — so a human runs this.

## Procedure

1. **Provision Render Postgres** (dashboard → New → Postgres, or API). Same region
   as the web service (`oregon`). Pick a plan (the free tier expires in 30 days;
   the smallest paid tier is fine for now). Note the **internal** connection string.

2. **Take a final SQLite backup** so the migration source is current:
   ```
   curl -X POST https://buildhall.ai/api/admin/backup -H "Authorization: Bearer $BACKUP_TRIGGER_TOKEN"
   ```
   Then download the newest `.db` object from the bucket — that's the migration source.

3. **Migrate the data** into the new Postgres (from any machine with `DATABASE_URL`
   set to the new instance's *external* URL, or from a Render shell with the
   internal URL):
   ```
   DATABASE_URL=<new-postgres-url> node scripts/migrate-sqlite-to-pg.mjs ./<downloaded>.db
   ```
   It prints per-table counts — confirm they match the SQLite source.

4. **Set env vars** on the `buildhall` service:
   - `DATABASE_URL` → the new Postgres internal connection string
   - keep all `BACKUP_S3_*` vars (the S3 backup now stores JSON snapshots)
   - `DATA_DIR` and the disk can stay for now; `db.js` ignores them.

5. **Deploy the branch**: merge `postgres-migration` → `main` (auto-deploys), or
   deploy the branch directly. On boot the server runs `init()` (idempotent schema)
   and then serves. Watch the deploy logs for `Buildhall listening`.

6. **Verify** before trusting it:
   - `GET /health` → `200`, `db: ok`
   - log in on the site; open a group; post a message; confirm the websocket
     delivers it; check the public feed.
   - `POST /api/admin/backup` → confirm a `.json.gz` snapshot lands in S3 and
     `node scripts/restore-backup.mjs <key> --verify` reads it back.

7. **Only after** the above passes for a day or two: remove the SQLite disk and
   `DATA_DIR` from the service/blueprint to reclaim it. Keep a copy of the final
   `.db` backup in S3 as an archival fallback.

## Rollback

If step 6 fails, revert the service to the previous deploy (main/SQLite) in the
Render dashboard and unset `DATABASE_URL`. The SQLite disk is untouched until
step 7, so rollback is immediate and lossless.

## Not migrated

- `scripts/purge-legacy.mjs` still uses the old synchronous SQLite API. It was a
  one-off cleanup already run; leave it or port it to `pg` if needed again.
