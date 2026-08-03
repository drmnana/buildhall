# Database backups & restore

BuildHall's database is Postgres. Render Postgres provides managed daily backups
and point-in-time recovery, but those live with the same vendor — so this ships
an **independent** nightly snapshot to S3-compatible object storage as an off-
Render, off-vendor copy. Defense in depth, not the only defense.

> Storage was SQLite until the Postgres migration; this doc and `src/backup.js`
> now describe the Postgres logical-snapshot format. Old `.db` (SQLite) backups
> in the bucket remain readable with the pre-migration restore script.

## How it works

- `src/backup.js` runs **in the web-service process**.
- Each run reads every table inside one `REPEATABLE READ` transaction (a
  point-in-time **consistent** view across tables), serializes it to JSON,
  gzips it, uploads it to S3 as `buildhall-<timestamp>.json.gz`, and prunes to
  a rolling window (`BACKUP_KEEP`, default 14).
- Scheduled nightly at ~03:15 UTC. Inert (logs `[backup] disabled`) until the
  env vars below are set, so it's safe to deploy before the bucket exists.

## Configure (one-time)

Create a private bucket on any S3-compatible provider — AWS S3, Cloudflare R2,
or Backblaze B2 — and set these in the Render dashboard (Environment) on the
`buildhall` service. Path-style vs virtual-hosted addressing is auto-detected
(AWS → virtual-hosted, others → path-style); override with
`BACKUP_S3_FORCE_PATH_STYLE` only if needed.

### AWS S3 specifics

- `BACKUP_S3_ENDPOINT` = `https://s3.<region>.amazonaws.com`
- `BACKUP_S3_REGION` = the bucket's real region (e.g. `us-east-1`) — not `auto`
- Turn on "Block all public access" for the bucket.
- Create an IAM user with an access key and this least-privilege policy (replace
  `YOUR_BUCKET`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": "arn:aws:s3:::YOUR_BUCKET" },
    { "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::YOUR_BUCKET/*" }
  ]
}
```

### All providers

| Env var | Example |
|---|---|
| `BACKUP_S3_ENDPOINT` | `https://<acct>.r2.cloudflarestorage.com` |
| `BACKUP_S3_BUCKET` | `buildhall-backups` |
| `BACKUP_S3_KEY_ID` | access key id |
| `BACKUP_S3_SECRET` | secret access key |
| `BACKUP_S3_REGION` | `auto` (R2) or the bucket's region (B2/S3) |
| `BACKUP_S3_PREFIX` | `buildhall/` (optional) |
| `BACKUP_KEEP` | `14` (optional) |
| `BACKUP_TRIGGER_TOKEN` | a random secret, to allow manual runs (optional) |

The bucket keys grant write to a backup bucket only — keep them scoped to that
bucket, not account-wide.

## Trigger a backup on demand

If `BACKUP_TRIGGER_TOKEN` is set:

```
curl -X POST https://buildhall.ai/api/admin/backup \
  -H "Authorization: Bearer $BACKUP_TRIGGER_TOKEN"
```

Returns the uploaded key, byte size, and how many old copies were pruned.

## Restore

From a machine with the same `BACKUP_S3_*` env vars:

```
npm run restore                              # list available backups (newest first)
npm run restore <key> -- --verify            # download, decompress, validate, row counts
npm run restore <key> -- --restore           # load into DATABASE_URL (must be empty)
```

`--verify` downloads and decompresses the snapshot, confirms every table is
present, and prints per-table row counts so you confirm it's complete **before**
trusting it. `--restore` loads it into the Postgres pointed to by `DATABASE_URL`
and **refuses** to run if the target already has rows, so it can never clobber a
live database. Restore preserves ids and advances sequences.

For most incidents, prefer Render Postgres's own point-in-time recovery (finer
granularity, no data-since-last-snapshot loss). Reach for these S3 snapshots when
you need an independent copy — a full Render/account outage, or to clone the DB
elsewhere.

## Known limitation

The snapshot is a logical JSON dump loaded row-by-row — fine at this scale, slow
for a very large database. At that point, switch to `pg_dump`/`pg_restore` or
lean entirely on Render's managed PITR. The nightly run reads inside one
`REPEATABLE READ` transaction, so it never blocks writers.
