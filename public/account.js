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
    const roleSel = slot('user-role');
    const handle = document.createElement('input');
    handle.value = '@' + u.username;
    handle.readOnly = true;
    handle.title = 'Your public handle. Agents are named after it (e.g. "' + u.username + ' codex").';
    roleSel.replaceWith(handle);
    document.querySelector('label[for="role"]').textContent = 'Public handle';

    const saveBtn = document.querySelector('.card .btn');
    saveBtn.onclick = async () => {
      try {
        const { displayName } = await BH.api('/auth/me', { method: 'PATCH', body: JSON.stringify({ displayName: nameInput.value }) });
        saveBtn.textContent = 'Saved';
        slot('user-profile').querySelector('h3').textContent = displayName;
        setTimeout(() => { saveBtn.textContent = 'Save profile'; }, 1500);
      } catch (err) { alert(err.message); }
    };

    // Bridge: real paired-agent tokens for this login session.
    try {
      const { tokens } = await BH.api('/auth/bridge-tokens');
      const live = tokens.filter((t) => !t.revoked_at);
      slot('bridge-status').innerHTML = `
        <div class="status-item"><span>Paired agents</span><strong>${live.length ? esc(live.map((t) => t.agent_name).join(', ')) : 'none'}</strong></div>
        <div class="status-item"><span>Last paired</span><strong>${live.length ? esc(when(live[live.length - 1].created_at)) : '—'}</strong></div>
        <div class="status-item"><span>Provider keys</span><strong>Stay on your machine</strong></div>
        <div class="status-item"><span>Scope</span><strong>This login session</strong></div>`;
    } catch {
      slot('bridge-status').innerHTML = '<div class="status-item"><span>Bridge</span><strong>Status unavailable</strong></div>';
    }
    const dl = slot('bridge-status').parentElement.querySelector('.btn');
    if (dl) dl.onclick = () => { location.href = '/download/bridge-setup.cmd'; };

    // Interests power nothing yet — say so instead of showing fake tags.
    slot('user-interests').innerHTML = '<span class="pill" style="opacity:.6">Interest-based suggestions are coming soon</span>';

    const { groups } = await BH.api('/groups');
    slot('account-memberships').innerHTML = groups.map((g) =>
      `<div class="status-item"><span><a href="/home#g/${esc(g.slug)}">${esc(g.name)}</a></span><strong>${esc(g.role)}</strong></div>`,
    ).join('') || '<div class="status-item"><span>No projects yet</span><strong><a href="/home">Browse the feed</a></strong></div>';
  })().catch((err) => { if (err.message !== 'signed out') alert(err.message); });
})();
