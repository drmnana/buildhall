// Restore the database from an off-box backup.
//
//   node scripts/restore-backup.mjs            # list available backups
//   node scripts/restore-backup.mjs <key>      # download <key> to ./restored-buildhall.db
//   node scripts/restore-backup.mjs <key> --verify   # download AND sanity-check it
//
// It NEVER overwrites the live database. It writes the restored copy beside the
// current working dir; promoting it into place is a deliberate manual step (stop
// the service, move it to $DATA_DIR/buildhall.db, restart) so a restore can't
// clobber good data by accident.
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';

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

const s3 = new S3Client({
  endpoint: CFG.endpoint, region: CFG.region,
  credentials: { accessKeyId: CFG.accessKeyId, secretAccessKey: CFG.secretAccessKey },
  forcePathStyle: true,
});

const [key, flag] = process.argv.slice(2);

if (!key) {
  const list = await s3.send(new ListObjectsV2Command({ Bucket: CFG.bucket, Prefix: CFG.prefix }));
  const objs = (list.Contents || []).filter((o) => o.Key.endsWith('.db')).sort((a, b) => (a.Key < b.Key ? 1 : -1));
  if (!objs.length) { console.log('No backups found under', CFG.prefix); process.exit(0); }
  console.log('Available backups (newest first):');
  for (const o of objs) console.log(`  ${o.Key}\t${o.Size} bytes\t${o.LastModified?.toISOString?.() || ''}`);
  console.log('\nRestore with:  node scripts/restore-backup.mjs <key> --verify');
  process.exit(0);
}

const out = 'restored-buildhall.db';
const res = await s3.send(new GetObjectCommand({ Bucket: CFG.bucket, Key: key }));
const bytes = Buffer.from(await res.Body.transformToByteArray());
writeFileSync(out, bytes);
console.log(`Downloaded ${key} -> ${out} (${bytes.length} bytes)`);

if (flag === '--verify') {
  // Open the restored file and confirm it is a valid, non-empty BuildHall DB.
  const rdb = new DatabaseSync(out);
  const integ = rdb.prepare('PRAGMA integrity_check').get();
  const users = rdb.prepare('SELECT COUNT(*) n FROM users').get().n;
  const groups = rdb.prepare('SELECT COUNT(*) n FROM groups').get().n;
  const messages = rdb.prepare('SELECT COUNT(*) n FROM messages').get().n;
  rdb.close();
  const okIntegrity = integ && Object.values(integ)[0] === 'ok';
  console.log(`integrity_check: ${Object.values(integ)[0]}`);
  console.log(`rows -> users:${users} groups:${groups} messages:${messages}`);
  if (!okIntegrity) { console.error('INTEGRITY CHECK FAILED — do not promote this file.'); process.exit(2); }
  console.log('\nVerified. To promote: stop the service, move this file to $DATA_DIR/buildhall.db, restart.');
}
