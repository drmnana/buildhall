// Shared wiring for the /home, /account and /admin shells (Codex UI, real API).
// Auth model matches app.js: bearer token in localStorage('bh-token').
'use strict';

const BH = (() => {
  const TOKEN_KEY = 'bh-token';
  const token = () => localStorage.getItem(TOKEN_KEY);

  // Anonymous visitors have nothing to see here — send them to the landing.
  function gate() {
    if (!token()) { location.replace('/welcome'); return false; }
    return true;
  }

  async function api(path, opts = {}) {
    const res = await fetch(`/api${path}`, {
      ...opts,
      headers: {
        ...(opts.body ? { 'content-type': 'application/json' } : {}),
        authorization: `Bearer ${token()}`,
        ...opts.headers,
      },
    });
    if (res.status === 401) { localStorage.removeItem(TOKEN_KEY); location.replace('/welcome'); throw new Error('signed out'); }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `request failed (${res.status})`);
    return body;
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  const initials = (name) => String(name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

  function when(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const today = new Date().toDateString();
    return d.toDateString() === today
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // Topbar chrome shared by all three pages: user chip, bridge state, and
  // hiding the Admin link from non-admins (the API enforces it regardless).
  async function chrome() {
    const me = await api('/auth/me');
    // Every shell page gets a Sign out control in the topbar nav.
    const nav = document.querySelector('.nav');
    if (nav && !document.getElementById('signOutLink')) {
      const a = document.createElement('a');
      a.id = 'signOutLink';
      a.href = '#';
      a.textContent = 'Sign out';
      a.onclick = async (e) => {
        e.preventDefault();
        try { await api('/auth/logout', { method: 'POST' }); } catch { /* token may already be dead */ }
        localStorage.removeItem(TOKEN_KEY);
        location.replace('/welcome');
      };
      nav.appendChild(a);
    }
    const chip = document.querySelector('[data-slot="current-user"]');
    if (chip) chip.innerHTML = `<span class="avatar">${esc(initials(me.user.display_name || me.user.username))}</span><span>${esc(me.user.display_name || me.user.username)}</span>`;
    if (!me.isAdmin) document.querySelectorAll('a[href="/admin"]').forEach((a) => a.remove());
    const bridgeEl = document.querySelector('[data-slot="bridge-connection-state"]');
    if (bridgeEl) {
      try {
        const { bridgeTokens: tokens } = await api('/auth/bridge-tokens');
        const live = (tokens || []).filter((t) => !t.revoked_at).length;
        bridgeEl.innerHTML = `<span class="status-dot"${live ? '' : ' style="background:#94a3b8;box-shadow:none"'}></span><span>${live ? `${live} agent${live === 1 ? '' : 's'} paired` : 'No agents paired'}</span>`;
      } catch { bridgeEl.innerHTML = '<span class="status-dot" style="background:#94a3b8;box-shadow:none"></span><span>Bridge status unavailable</span>'; }
    }
    // The old downloadable bridge is retired — "connect" now lives on /account
    // (MCP connect commands + the watcher). Rewire any leftover buttons there.
    document.querySelectorAll('a[href="#download-bridge"]').forEach((a) => { a.href = '/connect'; a.textContent = 'Connect your AI'; });
    // OAuth signups get a guessed handle — nudge until they claim a real one.
    if (me.user.username_locked === false && !document.getElementById('handleNudge') && location.pathname !== '/account') {
      const bar = document.createElement('div');
      bar.id = 'handleNudge';
      bar.style.cssText = 'background:rgba(122,162,255,.14);border-bottom:1px solid var(--line,#2b3444);padding:8px 16px;text-align:center;font-size:14px';
      bar.innerHTML = `Your handle "@${esc(me.user.username)}" was guessed from your sign-in provider. <a href="/account" style="font-weight:700">Pick your real handle</a> — it becomes permanent.`;
      document.body.prepend(bar);
    }
    return me;
  }

  const REPORT_REASONS = ['hacking-malware', 'fraud-scam', 'harassment', 'illegal', 'spam', 'other'];
  async function report(slug, messageId) {
    const reason = prompt(`Report this message. Reason — type one of:\n${REPORT_REASONS.join(', ')}`, 'other');
    if (reason === null) return;
    if (!REPORT_REASONS.includes(reason.trim())) return alert(`Reason must be one of: ${REPORT_REASONS.join(', ')}`);
    const detail = prompt('Anything to add? (optional)') || '';
    try {
      await api(`/groups/${slug}/messages/${messageId}/report`, { method: 'POST', body: JSON.stringify({ reason: reason.trim(), detail }) });
      alert('Reported — a human will review it. Thank you.');
    } catch (err) { alert(err.message); }
  }

  return { gate, api, esc, initials, when, chrome, report, token };
})();
