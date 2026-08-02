// Shared CLI invocation for the responder and the panel's "Test" button, so
// what you test is exactly what auto-respond runs.
//
// The prompt is NEVER put on the command line as a huge multi-line argument —
// cmd.exe and PowerShell mangle that (newlines and quotes break parsing), which
// makes a CLI see an empty/garbage prompt and, for Codex, fall back to its
// interactive screen (the blank popup window). Instead the prompt goes on
// stdin. Dispatch is by file extension because Node cannot exec a Windows
// .cmd/.bat/.ps1 shim directly — it needs cmd.exe / PowerShell.
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { homedir } from 'node:os';

// Per-agent invocation. `flags` are fixed CLI args; the prompt is piped to
// stdin. `claude -p` and `codex exec` both read the prompt from stdin when no
// positional prompt is given.
export const AGENTS = {
  claude: { flags: ['-p'] },
  codex: { flags: ['exec', '--skip-git-repo-check'] },
};

const LOG_FILE = join(homedir(), '.buildhall', 'responder.log');

export function log(line) {
  try { appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`); }
  catch { /* logging is best-effort */ }
}

/**
 * Run an agent CLI once with a prompt (delivered on stdin).
 * Returns { ok, status, stdout, stderr, error } — never throws.
 */
export function invokeAgent(agent, command, prompt) {
  const spec = AGENTS[agent];
  if (!spec) return { ok: false, error: `unknown agent "${agent}"` };
  const bin = command || agent;
  const ext = extname(bin).toLowerCase();
  const opts = {
    encoding: 'utf8',
    timeout: 180000,
    windowsHide: true,
    input: prompt,           // prompt on stdin — never on the command line
    maxBuffer: 8 * 1024 * 1024,
  };

  let run;
  try {
    if (process.platform === 'win32' && (ext === '.cmd' || ext === '.bat')) {
      run = spawnSync('cmd', ['/c', bin, ...spec.flags], opts);
    } else if (process.platform === 'win32' && ext === '.ps1') {
      run = spawnSync('powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bin, ...spec.flags], opts);
    } else {
      run = spawnSync(bin, spec.flags, opts);
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }

  if (run.error) {
    // ENOENT etc — the command could not be launched at all.
    return {
      ok: false,
      error: `${run.error.code || 'spawn failed'}: ${run.error.message}`,
      status: run.status, stdout: '', stderr: '',
    };
  }
  const stdout = (run.stdout || '').trim();
  const stderr = (run.stderr || '').trim();
  const timedOut = run.signal === 'SIGTERM' || run.error?.code === 'ETIMEDOUT';
  return {
    ok: run.status === 0 && stdout.length > 0,
    status: run.status,
    stdout,
    stderr,
    // The common real causes of "connected but silent", named explicitly.
    error: timedOut ? `${agent} timed out after 180s (is it waiting for login or approval?)`
      : run.status !== 0 ? `${agent} exited ${run.status}`
        : stdout.length === 0 ? `${agent} produced no output (it may need login — try "Open login")`
          : null,
  };
}
