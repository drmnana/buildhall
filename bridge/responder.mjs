// BuildHall responder — makes an AI actually answer.
//
// Run by the bridge's wake command when messages arrive:
//   node responder.mjs <claude|codex> <file>
//
// Reads the new incoming lines from the bridge file, asks the local CLI
// headlessly (claude -p / codex exec), and appends the reply as a plain line —
// which the bridge then posts to the group as this agent.
//
// Loop safety, because two auto-responding agents in one group would otherwise
// talk to each other forever: the responder only answers HUMAN-authored
// messages. Agent chatter is delivered to the file but never replied to.
import { readFileSync, writeFileSync, existsSync, appendFileSync, statSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const [agent, file] = process.argv.slice(2);
if (!agent || !file || !existsSync(file)) process.exit(2);

const OFFSET_FILE = `${file}.responder-offset`;
const LOCK_FILE = `${file}.responder-lock`;
const CLI = {
  claude: (prompt) => ['claude', ['-p', prompt]],
  codex: (prompt) => ['codex', ['exec', prompt]],
}[agent];
if (!CLI) process.exit(2);

// One responder at a time per file: a slow CLI run must not race a second
// invocation over the same offset. A stale lock (crash) expires after 5 min.
if (existsSync(LOCK_FILE) && Date.now() - statSync(LOCK_FILE).mtimeMs < 5 * 60 * 1000) process.exit(0);
writeFileSync(LOCK_FILE, String(process.pid));

try {
  let offset = 0;
  if (existsSync(OFFSET_FILE)) {
    const n = Number(readFileSync(OFFSET_FILE, 'utf8').trim());
    if (Number.isInteger(n) && n >= 0) offset = n;
  }
  const content = readFileSync(file, 'utf8');
  if (content.length <= offset) process.exit(0);

  const fresh = content.slice(offset);
  const lastNewline = fresh.lastIndexOf('\n');
  if (lastNewline === -1) process.exit(0);
  const complete = fresh.slice(0, lastNewline + 1);
  // Advance past everything we looked at, whether or not we reply — a message
  // must never be answered twice.
  writeFileSync(OFFSET_FILE, String(offset + complete.length));

  const parsed = complete.split('\n').filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l)]; } catch { return []; }
  });
  // Only messages delivered FROM the group, and only human ones.
  const incoming = parsed.filter((l) => l.source === 'buildhall' && l.actorType === 'human' && l.text);
  if (incoming.length === 0) process.exit(0);

  // Context: the tail of the conversation so the reply is not amnesiac.
  const tail = content.trim().split('\n').slice(-20).flatMap((l) => {
    try { const o = JSON.parse(l); return o.text ? [`${o.author}: ${o.text}`] : []; } catch { return []; }
  }).join('\n');

  const prompt =
    `You are "${agent}", an AI agent participating in a BuildHall group chat on behalf of your user.\n` +
    `Recent conversation:\n${tail}\n\n` +
    `New message(s) addressed to the group:\n` +
    incoming.map((l) => `${l.author}: ${l.text}`).join('\n') + '\n\n' +
    `Write your reply to the group. Respond with the message text only — no preamble, no quoting.`;

  const [cmd, args] = CLI(prompt);
  const run = spawnSync(cmd, args, { encoding: 'utf8', timeout: 180000, windowsHide: true });
  const reply = (run.stdout || '').trim();
  if (!reply) process.exit(0);

  // A plain line (no "source" tag), so the bridge tailer picks it up and posts
  // it to the group under this agent's bridge token.
  appendFileSync(file, JSON.stringify({
    time: new Date().toISOString(), author: agent, text: reply.slice(0, 4000),
  }) + '\n');
} finally {
  try { unlinkSync(LOCK_FILE); } catch { /* best effort */ }
}
