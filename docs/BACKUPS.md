# Database backups & restore

BuildHall's database is a single SQLite file (`$DATA_DIR/buildhall.db`) on one
Render persistent disk. This is the interim safety net until we migrate to
Postgres: a nightly, off-Render, consistent copy so a disk fault, a bad deploy,
or a corrupt write is recoverable.

## How it works

- `src/backup.js` runs **in the web-service process** (a Render cron job can't
  see `/var/data` — the disk isn't mounted for jobs).
- Each run does `VACUUM INTO` — a transactionally **consistent** snapshot, never
  a half-written page — then uploads it to S3-compatible object storage and
  prunes to a rolling window (`BACKUP_KEEP`, default 14).
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
npm run restore <key> -- --verify            # download + integrity_check + row counts
```

`--verify` runs `PRAGMA integrity_check` and prints user/group/message counts so
you confirm the file is valid **before** trusting it. The restored copy is
written to `restored-buildhall.db` and never overwrites the live DB.

To promote a verified restore:

1. Stop / suspend the `buildhall` service (so nothing writes during the swap).
2. Replace `$DATA_DIR/buildhall.db` with the restored file. Remove any stale
   `buildhall.db-wal` / `buildhall.db-shm` sidecar files.
3. Restart the service and hit `/health` (expect `200`, `db: ok`).

## Known limitation

`VACUUM INTO` is synchronous and briefly blocks the event loop while it runs —
negligible for a small DB at 03:15 UTC, but a reason (among others) the real fix
is the Postgres migration, which brings managed backups + point-in-time recovery
and removes the single-instance ceiling.
