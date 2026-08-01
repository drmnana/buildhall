// One-off maintenance: remove pre-checkpoint-7 accounts and their data.
//
// Accounts created under the old passwordless handshake have a NULL
// password_hash and can never log in, so they are dead weight — but their
// groups still appear in the public feed. This deletes those accounts, any
// group they created, and the messages in those groups.
//
// Dry run by default. Run for real with CONFIRM=yes:
//   DATA_DIR=/var/data CONFIRM=yes node scripts/purge-legacy.mjs
//
// Deletion order matters: messages reference users and groups, groups
// reference their creator. Removing a user first would violate those keys.
import { db } from '../src/db.js';

const confirm = process.env.CONFIRM === 'yes';

const legacyUsers = db
  .prepare('SELECT id, username FROM users WHERE password_hash IS NULL')
  .all();

if (legacyUsers.length === 0) {
  console.log('No legacy passwordless accounts found — nothing to do.');
  process.exit(0);
}

const ids = legacyUsers.map((u) => u.id);
const placeholders = ids.map(() => '?').join(',');

const groups = db
  .prepare(`SELECT id, slug, name FROM groups WHERE created_by IN (${placeholders})`)
  .all(...ids);
const groupIds = groups.map((g) => g.id);
const gph = groupIds.map(() => '?').join(',');

const messageCount = groupIds.length
  ? db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE group_id IN (${gph})`).get(...groupIds).n
  : 0;

console.log('Legacy accounts :', legacyUsers.map((u) => `${u.id}:${u.username}`).join(', '));
console.log('Groups to remove:', groups.map((g) => `${g.id}:${g.slug}`).join(', ') || '(none)');
console.log('Messages to remove:', messageCount);

if (!confirm) {
  console.log('\nDRY RUN — nothing was deleted. Re-run with CONFIRM=yes to apply.');
  process.exit(0);
}

db.exec('BEGIN');
try {
  if (groupIds.length) {
    // pinned_message_id is a self-reference inside messages; clear it first so
    // the row deletes cannot trip over their own foreign key.
    db.prepare(`UPDATE messages SET pinned_message_id = NULL WHERE group_id IN (${gph})`).run(...groupIds);
    db.prepare(`DELETE FROM messages WHERE group_id IN (${gph})`).run(...groupIds);
    db.prepare(`DELETE FROM memberships WHERE group_id IN (${gph})`).run(...groupIds);
    db.prepare(`DELETE FROM groups WHERE id IN (${gph})`).run(...groupIds);
  }
  // Any message these users left in groups they did not create must go too, or
  // the user delete fails on the messages.user_id reference.
  db.prepare(`UPDATE messages SET pinned_message_id = NULL WHERE user_id IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM messages WHERE user_id IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM memberships WHERE user_id IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM users WHERE id IN (${placeholders})`).run(...ids);
  db.exec('COMMIT');
  console.log('\nPurged.');
} catch (err) {
  db.exec('ROLLBACK');
  console.error('Rolled back:', err.message);
  process.exit(1);
}

const left = db.prepare('SELECT COUNT(*) AS n FROM users WHERE password_hash IS NULL').get().n;
console.log('Legacy accounts remaining:', left);
