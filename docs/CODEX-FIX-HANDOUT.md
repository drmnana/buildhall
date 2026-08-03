# BuildHall Bridge — Codex-not-responding bug. Handout for Codex to fix.

You (Codex) are running on the user's Windows machine (`C:\Users\drmna`). A companion
app called the **BuildHall Bridge** is supposed to wake you up when a human posts in a
BuildHall group, feed you the message, and post your reply back. **Claude works. You
(Codex) don't.** Your job is to make the Codex path work, on this machine, and prove it.

Don't trust this document blindly — verify each claim against the real files and logs
before you change anything. Paths and versions below are what we believe is true; check them.

---

## 1. What the bridge is, and the exact flow that's broken

The bridge is a dependency-free Node app. For each "connection" it holds a local JSONL
file open against one BuildHall group. Two directions:

- **group → file**: a websocket receives a new group message and appends a line to the
  JSONL file, then calls a **wake** command.
- **file → group**: a tailer watches the file; new non-bridge lines get POSTed to the group.

The **wake** command is what runs *you*. It is:

```
node responder.mjs <agent> <file> <resolvedCommandPath>
```

`responder.mjs` calls `invokeAgent()` in `agent-cli.mjs`, which does a **synchronous**
`spawnSync` of the agent CLI with the human's message as a prompt, captures stdout, and
appends it back to the JSONL file — which the tailer then posts to the group.

So the chain is: **human posts → ws appends line → wake → responder → `spawnSync(codex …)`
→ stdout appended → tailer posts.** If `spawnSync` fails or produces no stdout, nothing is
posted and it looks like "Codex connected but never answers."

---

## 2. Exact locations on THIS machine (verify they exist)

Installed bridge (this is what actually runs — `%LOCALAPPDATA%\BuildHall`):

```
C:\Users\drmna\AppData\Local\BuildHall\server.mjs
C:\Users\drmna\AppData\Local\BuildHall\agent-cli.mjs
C:\Users\drmna\AppData\Local\BuildHall\responder.mjs
C:\Users\drmna\AppData\Local\BuildHall\connection.mjs
C:\Users\drmna\AppData\Local\BuildHall\public\
```

Config + logs (`%USERPROFILE%\.buildhall`):

```
C:\Users\drmna\.buildhall\bridge.json        <- account + connections + per-connection "wake"
C:\Users\drmna\.buildhall\bridge.log         <- the bridge process's own stdout/stderr
C:\Users\drmna\.buildhall\responder.log      <- every wake attempt + spawn result. READ THIS FIRST.
```

The codex CLI shims npm dropped (the runnable ones matter):

```
C:\Users\drmna\AppData\Roaming\npm\codex       <- bare bash shim. Windows CANNOT run this. This is the bug.
C:\Users\drmna\AppData\Roaming\npm\codex.cmd
C:\Users\drmna\AppData\Roaming\npm\codex.ps1   <- the one that works cleanly via powershell -File
```

There is a **known-good reference** on this machine that already runs Codex headlessly and
works. Copy its approach, don't reinvent:

```
C:\Users\drmna\OneDrive\Desktop\local-chat-viewer\trigger.js
```

---

## 3. Root cause (confirmed from responder.log)

The freshest failing log line was:

```
codex: ENOENT: spawnSync C:\Users\drmna\AppData\Roaming\npm\codex ENOENT
```

Two things cause the Codex path to fail where Claude's doesn't:

1. **Resolution picks the unrunnable shim.** `where codex` returns the **extensionless**
   `...\npm\codex` (a bash script) *before* `codex.cmd`/`codex.ps1`. Node's `spawnSync`
   on Windows cannot execute an extensionless bash script → `ENOENT`. The command handed
   to the responder must be `codex.ps1` (preferred) or `codex.cmd`, **never** bare `codex`.

2. **Even with the right shim, the invocation must be non-interactive.** `codex exec`
   without `--sandbox workspace-write` stops and waits for an approval that never comes
   (this is the *empty PowerShell window that just sits there*). And the prompt must be a
   real command-line **argument**, not piped on stdin (stdin mangles a multi-line prompt).

Claude doesn't hit either: `claude.exe`/`claude.cmd` is directly runnable, and `claude -p`
is non-interactive by default.

---

## 4. The proven-working invocation (copied from trigger.js on this machine)

trigger.js runs Codex like this, and it works:

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\Users\drmna\AppData\Roaming\npm\codex.ps1 ^
  exec --cd <dir> --add-dir <dir> --skip-git-repo-check --sandbox workspace-write "<PROMPT AS ONE ARG>"
```

Key points, all of which the bridge must match:
- launched through **`powershell.exe -File codex.ps1`**, not bare `codex`
- `exec` subcommand (headless one-shot)
- `--sandbox workspace-write` so it never waits for approval
- `--skip-git-repo-check` so it runs outside a git repo
- the prompt is a **single positional argument**, passed via the args array with
  `shell:false` — never stdin, never string-concatenated into a shell line
- stdin is ignored; the reply comes from **stdout**

For reference, Claude's working form (already fine) is:
`claude -p --add-dir <dir> --permission-mode bypassPermissions --dangerously-skip-permissions "<PROMPT>"`.

---

## 5. What to change (fix the INSTALLED files directly — fastest path)

You can fix this locally without waiting for a server redeploy. Edit the files under
`C:\Users\drmna\AppData\Local\BuildHall\`, then restart the bridge.

### 5a. Resolution — `server.mjs`

Find `whereIs()` and `detectAgent()`. The requirement: **for codex, resolve to
`codex.ps1` first**, then `codex.cmd`, then `codex.exe`; **never return the extensionless
`codex`** on Windows. There is also a `probeKnownLocations()` that should look in
`%APPDATA%\npm` and `%LOCALAPPDATA%\npm`. If `where codex` on this machine returns the
bare shim, make sure the resolver either (a) asks `where codex.ps1` explicitly, or
(b) filters `where` output to lines ending in `.ps1/.cmd/.exe/.bat`, or (c) falls through
to `probeKnownLocations` which builds `%APPDATA%\npm\codex.ps1` directly.

Quick check of what resolution currently returns on this machine:

```powershell
where.exe codex
where.exe codex.ps1
where.exe codex.cmd
Test-Path "$env:APPDATA\npm\codex.ps1"
```

The resolved command that ends up in `bridge.json`'s `wake` string (and in `responder.log`)
**must** end in `.ps1` (or `.cmd`), not be bare `codex`.

### 5b. Invocation — `agent-cli.mjs`

`buildInvocation()` already branches on the file extension:
- `.ps1` → `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <bin> exec --cd <dir> --add-dir <dir> --skip-git-repo-check --sandbox workspace-write <prompt>`
- `.cmd`/`.bat` → `cmd /c <bin> …same flags…`

If resolution (5a) now hands it `codex.ps1`, this branch produces the exact proven command.
Confirm the flags match section 4 verbatim — especially `--sandbox workspace-write` and the
prompt as the **last positional arg**, with `spawnSync(..., { shell:false })`.

### 5c. Fix the already-saved wake in bridge.json

`bridge.json` may still contain a `wake` string that bakes in the **bare `codex`** path
from before the fix. `server.mjs`'s `addConnection()` rebuilds `wake` from live detection
on launch — but only if detection now returns `.ps1`. After fixing 5a, either delete the
codex connection's `wake` field (it gets rebuilt) or confirm on next launch it now reads
`...\npm\codex.ps1`. **The running bridge owns this file — stop the bridge before editing it
by hand, or your edit gets overwritten.**

---

## 6. How to test — in isolation, then end-to-end

**Step 1 — prove Codex itself works headless** (removes the bridge from the equation):

```powershell
& "$env:APPDATA\npm\codex.ps1" exec --skip-git-repo-check --sandbox workspace-write "Reply with exactly: codex-ok"
```

If this doesn't print `codex-ok`, the problem is your Codex login/CLI, not the bridge —
fix that first (run `codex login` / check `codex --version`).

**Step 2 — prove the responder works** (this is exactly what the wake runs). Use the real
resolved path and a scratch file:

```powershell
node "$env:LOCALAPPDATA\BuildHall\responder.mjs" codex "$env:TEMP\bh-test.jsonl" "$env:APPDATA\npm\codex.ps1"
```

Then read the tail of `C:\Users\drmna\.buildhall\responder.log`. You want a line showing a
successful spawn and non-empty stdout — **not** `ENOENT`, **not** `exited <n>`, **not**
`produced no output`.

**Step 3 — end-to-end.** Restart the bridge (close the "BuildHall Bridge" tray/VBS launcher
and relaunch the Desktop shortcut, or `node server.mjs` from
`C:\Users\drmna\AppData\Local\BuildHall`). In the BuildHall web app, post a message in the
codex group. Within a few seconds `responder.log` should show a successful codex run and the
reply should appear in the group signed **`drmnana codex`**.

---

## 7. Already tried (don't loop on these)

- Returning the **bare** `codex` from detection → `ENOENT` (Windows can't run the extensionless shim). Dead end.
- Passing the prompt on **stdin** → mangled / empty; codex needs it as an arg.
- Omitting `--sandbox workspace-write` → codex waits for approval = the empty PowerShell window. Must include it.
- Editing `bridge.json` by hand **while the bridge is running** → the running process overwrites it. Stop it first.
- `--detached`/new console on wake → spawns visible popup windows; use `windowsHide:true`, no detach.

## 8. Definition of done

1. `responder.log` shows a codex run with `status:0` and non-empty stdout (no ENOENT).
2. The codex connection's `wake` in `bridge.json` references `codex.ps1` (or `.cmd`), not bare `codex`.
3. Posting in the codex group yields a reply in the group, signed `drmnana codex`, within ~10s.
4. Claude still works (don't regress the claude path).

If you change the installed files and it works, tell the user which files you edited and
what the fix was, so it can be folded back into the shipped bridge on the server.
