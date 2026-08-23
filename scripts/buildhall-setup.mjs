#!/usr/bin/env node
// BuildHall one-click setup — "Bring your AI to the Hall".
//
// What it does, in order:
//   1. Finds which AI CLIs are installed (claude, codex).
//   2. Opens the browser ONCE for you to approve the connection.
//   3. Mints one BuildHall credential per CLI and writes it into that CLI's
//      MCP configuration — no OAuth dance inside the CLI, nothing to type.
//   4. Downloads the watcher, configures it for every CLI found, and installs
//      it to start with your computer (background, no window).
//
// After this: your agents appear on buildhall.ai/account, you let them into
// projects from each project's panel, and they answer when mentioned.
// Everything survives reboots and browser logouts. Revoke any agent any time
// from the account page.
import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = (process.env.BUILDHALL_BASE || 'https://buildhall.ai').replace(/\/$/, '');
const CONF_DIR = join(homedir(), '.buildhall');
const log = (m) => console.log(m);

function has(cmd) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(probe, [cmd], { stdio: 'ignore', shell: true }).status === 0;
}

function run(cmd) {
  // Used for CLI config commands — output shown so failures are visible.
  const r = spawnSync(cmd, { shell: true, encoding: 'utf8' });
  if (r.status !== 0) log(`  (warning) "${cmd}" exited ${r.status}: ${(r.stderr || r.stdout || '').trim().slice(0, 200)}`);
  return r.status === 0;
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  try { spawn(cmd, { shell: true, stdio: 'ignore', detached: true }).unref(); } catch { /* link printed anyway */ }
}

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    ...opts,
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...opts.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status} on ${path}`);
  return body;
}

// Insert a key into the [mcp_servers.buildhall] block of codex's config.toml,
// right after our url line, if it isn't already there.
function patchCodexConfig() {
  const cfg = join(homedir(), '.codex', 'config.toml');
  if (!existsSync(cfg)) return false;
  let text = readFileSync(cfg, 'utf8');
  if (text.includes('bearer_token_env_var = "BUILDHALL_TOKEN"')) return true;
  const urlLine = new RegExp(`(url\\s*=\\s*"${BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/mcp")`);
  if (!urlLine.test(text)) return false;
  text = text.replace(urlLine, `$1\nbearer_token_env_var = "BUILDHALL_TOKEN"`);
  writeFileSync(cfg, text);
  return true;
}

function persistEnvVar(name, value) {
  if (process.platform === 'win32') {
    return spawnSync(`setx ${name} "${value}"`, { shell: true, stdio: 'ignore' }).status === 0;
  }
  // macOS/Linux: append an export line to the common shell profiles.
  let ok = false;
  for (const rc of ['.zshrc', '.bashrc', '.profile']) {
    const p = join(homedir(), rc);
    try {
      const cur = existsSync(p) ? readFileSync(p, 'utf8') : '';
      if (!cur.includes(`export ${name}=`)) writeFileSync(p, `${cur}${cur.endsWith('\n') || !cur ? '' : '\n'}export ${name}="${value}"\n`);
      ok = true;
    } catch { /* try the next profile */ }
  }
  return ok;
}

async function main() {
  log('');
  log('==============================================');
  log('  BuildHall — Bring your AI to the Hall');
  log('==============================================');
  log('');

  // 1. what's on this machine?
  const clis = ['claude', 'codex'].filter(has);
  const hasNode = true; // we ARE running under node
  if (!clis.length) {
    log('No AI CLI found on this computer (looked for: claude, codex).');
    log(`Install one first — step-by-step instructions: ${BASE}/connect`);
    openBrowser(`${BASE}/connect`);
    process.exitCode = 1;
    return;
  }
  log(`Found on this computer: ${clis.join(', ')}`);
  log('');

  // 2. one browser approval
  const pair = await api('/pair/start', { method: 'POST', body: JSON.stringify({ agents: clis }) });
  const url = `${BASE}/pair?code=${pair.code}`;
  log('Approve the connection in your browser (one click):');
  log(`  ${url}`);
  log('(if the browser did not open by itself, copy that link into it)');
  openBrowser(url);
  let claim;
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    claim = await api('/pair/claim', { method: 'POST', body: JSON.stringify({ code: pair.code, secret: pair.secret }) });
    if (claim.token) break;
  }
  const { token, username } = claim;
  log(`Approved — connected as @${username}.`);
  log('');

  // 3. mint one credential per CLI and write each CLI's MCP config
  const mint = await api('/setup/agents', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ agents: clis }),
  });
  const results = [];
  for (const a of mint.agents) {
    if (a.cli === 'claude') {
      run('claude mcp remove buildhall');
      const ok = run(`claude mcp add --transport http buildhall ${BASE}/mcp --header "Authorization: Bearer ${a.token}"`);
      results.push([a.agentName, ok]);
    } else if (a.cli === 'codex') {
      persistEnvVar('BUILDHALL_TOKEN', a.token);
      process.env.BUILDHALL_TOKEN = a.token;
      run('codex mcp remove buildhall');
      const added = run(`codex mcp add buildhall --url ${BASE}/mcp`);
      const patched = patchCodexConfig();
      if (!patched) log('  (warning) could not wire the codex credential automatically — codex may ask you to log in to buildhall on first use, which also works.');
      results.push([a.agentName, added]);
    }
  }
  log('');

  // 4. the watcher: download, configure for every CLI, install as background service
  mkdirSync(CONF_DIR, { recursive: true });
  const watchPath = join(CONF_DIR, 'buildhall-watch.mjs');
  const watchSrc = await fetch(`${BASE}/watch.mjs`).then((r) => r.text());
  writeFileSync(watchPath, watchSrc);
  for (const cli of clis) {
    writeFileSync(join(CONF_DIR, `watch-${cli}.json`), JSON.stringify({ base: BASE, token, username, cli, lastSeen: {} }, null, 2), { mode: 0o600 });
    run(`node "${watchPath}" --install --cli ${cli}`);
  }
  log('');

  log('==============================================');
  log('  Done. Your Hall setup:');
  for (const [name, ok] of results) log(`   ${ok ? '✓' : '✗'} agent "${name}" connected`);
  log(`   ✓ watcher installed for ${clis.join(' and ')} — starts with your computer, no window`);
  log('');
  log(`  Next: open ${BASE}/home, enter a project, and use`);
  log('  the "Your AI agents" panel to let your agents in.');
  log('  Mention them by name ("claude, ...") and they answer.');
  log('==============================================');
}

main().catch((err) => { console.error(`setup failed: ${err.message}`); process.exitCode = 1; });
