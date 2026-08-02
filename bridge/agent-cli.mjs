// Shared CLI invocation for the responder and the panel's "Test" button, so
// what you test is exactly what auto-respond runs.
//
// The prompt is always passed as a REAL argument (never a shell string, which
// mangles multi-line text). Dispatch is by file extension because Node cannot
// exec a Windows .cmd/.bat/.ps1 shim directly — it needs cmd.exe / PowerShell.
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { homedir } from 'node:os';

// How each known CLI takes a one-shot prompt and prints the answer to stdout.
// `codex exec` runs non-interactively; --skip-git-repo-check stops it refusing
// to run outside a git repo (the bridge's folder is not one).
export const AGENT_ARGS = {
  claude: (prompt) => ['-p', prompt],
  codex: (prompt) => ['exec', '--skip-git-repo-check', prompt],
};

const LOG_FILE = join(homedir(), '.buildhall', 'responder.log');

export function log(line) {
  try { appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`); }
  catch { /* logging is best-effort */ }
}

/**
 * Run an agent CLI once with a prompt.
 * Returns { ok, status, stdout, stderr, error } — never throws.
 */
export function invokeAgent(agent, command, prompt) {
  const bin = command || agent;
  const buildArgs = AGENT_ARGS[agent];
  if (!buildArgs) return { ok: false, error: `unknown agent "${agent}"` };
  const args = buildArgs(prompt);
  const ext = extname(bin).toLowerCase();
  const opts = { encoding: 'utf8', timeout: 180000, windowsHide: true };

  let run;
  try {
    if (process.platform === 'win32' && (ext === '.cmd' || ext === '.bat')) {
      run = spawnSync('cmd', ['/c', bin, ...args], opts);
    } else if (process.platform === 'win32' && ext === '.ps1') {
      run = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bin, ...args], opts);
    } else {
      run = spawnSync(bin, args, opts);
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }

  if (run.error) {
    // ENOENT etc — the command could not be launched at all.
    return { ok: false, error: `${run.error.code || 'spawn failed'}: ${run.error.message}`,
      status: run.status, stdout: '', stderr: '' };
  }
  const stdout = (run.stdout || '').trim();
  const stderr = (run.stderr || '').trim();
  return {
    ok: run.status === 0 && stdout.length > 0,
    status: run.status,
    stdout,
    stderr,
    // A common real cause of "connected but silent": the CLI ran but printed
    // nothing to stdout (auth prompt, needs login, wrote to stderr instead).
    error: run.status !== 0 ? `${agent} exited ${run.status}`
      : stdout.length === 0 ? `${agent} produced no output` : null,
  };
}
