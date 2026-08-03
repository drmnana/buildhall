// Shared CLI invocation for the responder and the panel's "Test" button.
//
// The invocations here mirror a proven-working local setup (local-chat-viewer's
// trigger.js). Two things that setup gets right and earlier versions did not:
//
//  * The prompt is a real command-line ARGUMENT, passed through spawn's args
//    array with shell:false — so there is no shell to mangle newlines/quotes,
//    and no need for stdin tricks.
//  * The agents run in NON-INTERACTIVE, pre-approved modes. Without
//    `--sandbox workspace-write` codex exec stops to ask for approval (the
//    blank window that never answers); claude needs its permission bypass.
//
// Codex is launched via `powershell.exe -File codex.ps1` because it ships as a
// PowerShell/.cmd shim with no bare-executable on PATH.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { extname, dirname, join } from 'node:path';
import { homedir } from 'node:os';

const LOG_FILE = join(homedir(), '.buildhall', 'responder.log');

export function log(line) {
  try { appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`); }
  catch { /* logging is best-effort */ }
}

// Build the exact command + args for an agent. `dir` is the working directory
// the agent may read/write (the folder holding the bridge file).
function buildInvocation(agent, bin, prompt, dir) {
  const ext = extname(bin).toLowerCase();
  if (agent === 'claude') {
    const args = [
      '-p', '--add-dir', dir,
      '--permission-mode', 'bypassPermissions',
      '--dangerously-skip-permissions',
      prompt,
    ];
    if (process.platform === 'win32' && (ext === '.cmd' || ext === '.bat')) return { cmd: 'cmd', args: ['/c', bin, ...args] };
    if (process.platform === 'win32' && ext === '.ps1') return { cmd: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bin, ...args] };
    return { cmd: bin, args };            // claude.exe / unix binary
  }
  // codex
  const flags = [
    'exec', '--cd', dir, '--add-dir', dir,
    '--skip-git-repo-check',
    '--sandbox', 'workspace-write',       // pre-approve, or exec hangs waiting
    prompt,
  ];
  if (process.platform === 'win32' && ext === '.ps1') return { cmd: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bin, ...flags] };
  if (process.platform === 'win32' && (ext === '.cmd' || ext === '.bat')) return { cmd: 'cmd', args: ['/c', bin, ...flags] };
  return { cmd: bin, args: flags };       // codex binary / unix
}

/**
 * Run an agent CLI once with a prompt. Returns { ok, status, stdout, stderr,
 * error } — never throws.
 */
export function invokeAgent(agent, command, prompt, dir) {
  if (agent !== 'claude' && agent !== 'codex') return { ok: false, error: `unknown agent "${agent}"` };
  const bin = command || agent;
  // A non-existent cwd makes spawnSync throw ENOENT that looks exactly like a
  // missing CLI. Fall back to the home dir so a valid binary always runs.
  const workdir = dir && existsSync(dir) ? dir : homedir();
  const { cmd, args } = buildInvocation(agent, bin, prompt, workdir);
  // A Finder/GUI-launched bridge inherits a stripped PATH, so the agent CLI
  // can't find `node` or its own helpers. Append the real bin dirs on
  // macOS/Linux (harmless if already present); leave Windows PATH untouched.
  const env = process.platform === 'win32' ? process.env : {
    ...process.env,
    PATH: [
      process.env.PATH || '',
      '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin',
      join(homedir(), '.local', 'bin'), join(homedir(), '.claude', 'local'),
      join(homedir(), '.npm-global', 'bin'),
    ].filter(Boolean).join(':'),
  };
  const opts = {
    encoding: 'utf8',
    timeout: 180000,
    windowsHide: true,
    cwd: workdir,
    env,
    maxBuffer: 16 * 1024 * 1024,
    // shell:false (default) — args are passed verbatim, so the multi-line
    // prompt is never re-parsed by a shell.
  };

  let run;
  try { run = spawnSync(cmd, args, opts); }
  catch (e) { return { ok: false, error: e.message }; }

  if (run.error) {
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
    error: timedOut ? `${agent} timed out after 180s (is it waiting for login or approval?)`
      : run.status !== 0 ? `${agent} exited ${run.status}`
        : stdout.length === 0 ? `${agent} produced no output (it may need login — try "Open login")`
          : null,
  };
}
