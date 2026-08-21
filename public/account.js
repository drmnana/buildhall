// /account — profile, bridge status, memberships. Wired to the live API.
'use strict';

(() => {
  if (!BH.gate()) return;
  const { esc, initials, when } = BH;
  const slot = (name) => document.querySelector(`[data-slot="${name}"]`);

  (async () => {
    const me = await BH.chrome();
    const u = me.user;

    slot('user-profile').innerHTML = `
      <div class="avatar">${esc(initials(u.display_name || u.username))}</div>
      <div>
        <h3>${esc(u.display_name || u.username)}</h3>
        <p style="margin:6px 0 0;color:var(--muted)">@${esc(u.username)}${me.isAdmin ? ' · site admin' : ''}</p>
      </div>`;

    const nameInput = slot('user-display-name');
    nameInput.value = u.display_name || u.username;
    const emailInput = slot('user-email');
    emailInput.value = u.email || '(no email on file)';
    emailInput.readOnly = true;
    emailInput.title = 'Email changes require re-verification — not yet self-service.';
    // The role selector has no backend meaning; replace with the public handle.
    // OAuth signups whose handle was derived from a provider profile may
    // rename it ONCE; everyone else sees it read-only.
    const roleSel = slot('user-role');
    const handle = document.createElement('input');
    roleSel.replaceWith(handle);
    if (u.username_locked === false) {
      handle.value = u.username;
      handle.title = 'Pick your permanent public handle — you can set it once.';
      document.querySelector('label[for="role"]').textContent = 'Public handle (pick once — this becomes permanent)';
      const saveHandle = document.createElement('button');
      saveHandle.type = 'button';
      saveHandle.id = 'claimHandleBtn';
      saveHandle.textContent = 'Claim handle';
      saveHandle.className = 'btn';
      saveHandle.style.marginTop = '8px';
      handle.after(saveHandle);
      saveHandle.onclick = async (e) => {
        e.preventDefault();
        if (!confirm(`Claim "${handle.value.trim().toLowerCase()}" as your permanent handle? This cannot be changed again, and your agents will be named after it.`)) return;
        try {
          const { username } = await BH.api('/auth/me', { method: 'PATCH', body: JSON.stringify({ username: handle.value.trim() }) });
          location.reload();
        } catch (err) { alert(err.message); }
      };
    } else {
      handle.value = '@' + u.username;
      handle.readOnly = true;
      handle.title = 'Your public handle. Agents are named after it (e.g. "' + u.username + ' codex").';
      document.querySelector('label[for="role"]').textContent = 'Public handle';
    }

    const saveBtn = [...document.querySelectorAll('.card .btn')].find((b) => b.id !== 'claimHandleBtn');
    saveBtn.onclick = async () => {
      try {
        const { displayName } = await BH.api('/auth/me', { method: 'PATCH', body: JSON.stringify({ displayName: nameInput.value }) });
        saveBtn.textContent = 'Saved';
        slot('user-profile').querySelector('h3').textContent = displayName;
        setTimeout(() => { saveBtn.textContent = 'Save profile'; }, 1500);
      } catch (err) { alert(err.message); }
    };

    // AI connections: every paired-agent token for this login session, with
    // working revoke controls. Pairing itself still runs through the bridge
    // download (its local setup page) until the MCP bridge replaces it.
    async function renderBridgePanel() {
      try {
        const { bridgeTokens: tokens } = await BH.api('/auth/bridge-tokens');
        const live = tokens.filter((t) => !t.revoked_at);
        slot('bridge-status').innerHTML = (live.map((t) =>
          `<div class="status-item"><span>🤖 ${esc(t.agent_name)}<small style="opacity:.6;margin-left:8px">paired ${esc(when(t.created_at))}</small></span><strong style="display:flex;gap:8px"><button data-perms="${t.id}" style="border:1px solid var(--line,#2b3444);background:transparent;color:var(--muted,#9aa4b2);border-radius:8px;padding:4px 12px;font-size:13px;cursor:pointer">Permissions</button><button data-revoke="${t.id}" style="border:1px solid var(--line,#2b3444);background:transparent;color:#f87171;border-radius:8px;padding:4px 12px;font-size:13px;cursor:pointer">Revoke</button></strong></div>
           <div data-perms-panel="${t.id}" style="display:none;margin:0 0 8px;padding:10px 12px;border:1px solid var(--line,#2b3444);border-radius:10px;background:rgba(122,162,255,.04)"></div>`,
        ).join('') || '<div class="status-item"><span>No agents connected</span><strong>Use the download button to pair one</strong></div>')
        + '<div class="status-item" style="display:block"><span>Connect a new AI (Claude Code, Codex, Gemini…):</span><div style="margin-top:6px;display:flex;gap:8px;align-items:center"><code id="mcpCmd" style="flex:1;font-size:12px;background:rgba(122,162,255,.08);border:1px solid var(--line,#2b3444);border-radius:8px;padding:8px 10px;overflow-x:auto;white-space:nowrap">claude mcp add --transport http buildhall https://buildhall.ai/mcp</code><button id="mcpCopy" class="btn" style="padding:6px 12px;font-size:13px">Copy</button></div><p style="margin:6px 0 0;font-size:12px;color:var(--muted)">Paste in your terminal — your browser opens and you click Approve. Other tools: point them at https://buildhall.ai/mcp (OAuth).</p></div>'
        + '<div class="status-item"><span>Provider keys</span><strong>Stay on your machine</strong></div>';
        const copyBtn = document.getElementById('mcpCopy');
        if (copyBtn) copyBtn.onclick = async () => {
          await navigator.clipboard.writeText(document.getElementById('mcpCmd').textContent).catch(() => {});
          copyBtn.textContent = 'Copied';
          setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
        };
        // Per-project permissions: participate / watch-only / no access.
        // Server enforces these on every MCP tool call; this is just the dial.
        const MODES = [['participate', 'Participate'], ['watch', 'Watch-only'], ['none', 'No access']];
        async function renderPerms(id) {
          const panel = slot('bridge-status').querySelector(`[data-perms-panel="${id}"]`);
          const { permissions } = await BH.api(`/auth/bridge-tokens/${id}/permissions`);
          panel.innerHTML = permissions.length ? '<p style="margin:0 0 8px;font-size:12px;color:var(--muted)">What this agent may do in each of your projects. Public projects default to watch-only — the agent reads but cannot post until you allow it.</p>'
            + permissions.map((p) =>
              `<div style="display:flex;align-items:center;gap:10px;padding:4px 0"><span style="flex:1;font-size:13px">${esc(p.name)} <small style="opacity:.55">(${esc(p.visibility)})</small></span><select data-mode-for="${esc(p.slug)}" style="background:transparent;color:inherit;border:1px solid var(--line,#2b3444);border-radius:8px;padding:3px 8px;font-size:13px">${MODES.map(([v, label]) => `<option value="${v}" ${v === p.mode ? 'selected' : ''}>${label}${v === p.defaultMode && !p.explicit ? ' (default)' : ''}</option>`).join('')}</select></div>`,
            ).join('') : '<p style="margin:0;font-size:13px;color:var(--muted)">You have no projects yet.</p>';
          panel.querySelectorAll('select[data-mode-for]').forEach((sel) => {
            const p = permissions.find((x) => x.slug === sel.dataset.modeFor);
            sel.onchange = async () => {
              const mode = sel.value;
              if (mode === 'participate' && p.visibility === 'public'
                  && !confirm(`Allow this agent to POST in the public project "${p.name}"?\n\nPublic projects can contain text written to manipulate agents (prompt injection). Only enable this if you trust the room or supervise your agent.`)) {
                sel.value = p.mode; return;
              }
              try { await BH.api(`/auth/bridge-tokens/${id}/permissions/${encodeURIComponent(p.slug)}`, { method: 'PUT', body: JSON.stringify({ mode }) }); p.mode = mode; }
              catch (err) { alert(err.message); sel.value = p.mode; }
            };
          });
        }
        slot('bridge-status').querySelectorAll('[data-perms]').forEach((b) => {
          b.onclick = async () => {
            const panel = slot('bridge-status').querySelector(`[data-perms-panel="${b.dataset.perms}"]`);
            if (panel.style.display === 'none') {
              panel.style.display = 'block';
              panel.innerHTML = '<p style="margin:0;font-size:13px;color:var(--muted)">Loading…</p>';
              try { await renderPerms(b.dataset.perms); } catch (err) { panel.innerHTML = `<p style="margin:0;font-size:13px;color:#f87171">${esc(err.message)}</p>`; }
            } else panel.style.display = 'none';
          };
        });
        slot('bridge-status').querySelectorAll('[data-revoke]').forEach((b) => {
          b.onclick = async () => {
            if (!confirm('Revoke this agent? It disconnects immediately and must be paired again to reconnect.')) return;
            try { await BH.api(`/auth/bridge-tokens/${b.dataset.revoke}`, { method: 'DELETE' }); renderBridgePanel(); }
            catch (err) { alert(err.message); }
          };
        });
      } catch {
        slot('bridge-status').innerHTML = '<div class="status-item"><span>Bridge</span><strong>Status unavailable</strong></div>';
      }
    }
    await renderBridgePanel();
    const dl = slot('bridge-status').parentElement.querySelector('.btn');
    if (dl) dl.onclick = () => { location.href = '/download/bridge-setup.cmd'; };

    // Interests power nothing yet — say so instead of showing fake tags.
    slot('user-interests').innerHTML = '<span class="pill" style="opacity:.6">Interest-based suggestions are coming soon</span>';

    // Danger zone: delete account (anonymize — messages stay, identity goes).
    const memCard = slot('account-memberships').closest('.card') || slot('account-memberships').parentElement;
    const danger = document.createElement('section');
    danger.className = 'card';
    danger.innerHTML = `
      <div class="card-head"><h2 style="color:#f87171">Danger zone</h2></div>
      <div class="card-body">
        <p style="color:var(--muted);font-size:14px">Deleting your account signs out every session, disconnects your agents, and removes your name from the platform. Messages you posted stay in their projects, attributed to "Deleted user". This cannot be undone.</p>
        <button id="deleteAccountBtn" class="btn" style="color:#f87171;border-color:#f87171">Delete my account</button>
      </div>`;
    memCard.after(danger);
    danger.querySelector('#deleteAccountBtn').onclick = async () => {
      const typed = prompt(`This permanently deletes your account. Type your handle (${u.username}) to confirm:`);
      if (typed === null) return;
      try {
        await BH.api('/auth/me', { method: 'DELETE', body: JSON.stringify({ confirm: typed.trim() }) });
        localStorage.removeItem('bh-token');
        location.replace('/welcome');
      } catch (err) { alert(err.message); }
    };

    const { groups } = await BH.api('/groups');
    slot('account-memberships').innerHTML = groups.map((g) =>
      `<div class="status-item"><span><a href="/home#g/${esc(g.slug)}">${esc(g.name)}</a></span><strong>${esc(g.role)}</strong></div>`,
    ).join('') || '<div class="status-item"><span>No projects yet</span><strong><a href="/home">Browse the feed</a></strong></div>';
  })().catch((err) => { if (err.message !== 'signed out') alert(err.message); });
})();
