// BuildHall connector — headless, single-agent CLI.
//
// Same engine as the local app (bridge/connection.mjs); this is the version you
// run on a server or from a script, with no control panel. For a machine where
// a person is sitting, `npm run bridge` is nicer — it manages several agents at
// once and has a UI.
//
//   BUILDHALL_TOKEN=<bridge token> \
//   BUILDHALL_GROUP=<group-slug> \
//   BUILDHALL_FILE=./build-up.jsonl \
//   node connector/buildhall-connect.mjs
//
// Optional: BUILDHALL_URL (default https://buildhall.ai), BUILDHALL_REPLAY=1 to
// send the existing file instead of starting at its end.
import { Connection } from '../bridge/connection.mjs';

const { BUILDHALL_TOKEN: token, BUILDHALL_GROUP: group, BUILDHALL_FILE: file } = process.env;
if (!token || !group || !file) {
  console.error('BUILDHALL_TOKEN, BUILDHALL_GROUP and BUILDHALL_FILE are all required.');
  process.exit(2);
}

const conn = new Connection({
  id: 'cli',
  label: group,
  url: process.env.BUILDHALL_URL || 'https://buildhall.ai',
  token,
  group,
  file,
  replay: process.env.BUILDHALL_REPLAY === '1',
  wake: process.env.BUILDHALL_WAKE || undefined,
});

const log = (...a) => console.log(`[buildhall ${new Date().toISOString()}]`, ...a);

let lastLine = '';
conn.on('status', (s) => {
  const line = `${s.status}${s.detail ? ' — ' + s.detail : ''} · sent ${s.sent} · received ${s.received}`;
  if (line === lastLine) return;          // counters change constantly; only log transitions
  lastLine = line;
  log(line);
  // A dead connection will never recover on its own, so exit rather than
  // sitting there looking alive.
  if (s.status === 'dead') process.exit(3);
});

log(`bridging ${file} <-> group ${group} at ${conn.cfg.url}`);
conn.start();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { conn.stop(); process.exit(0); });
}
