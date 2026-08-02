const $ = (s) => document.querySelector(s);
const api = async (path, opts = {}) => {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status}`);
  return body;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const showErr = (sel, msg) => { const el = $(sel); el.textContent = msg; el.hidden = false; };
const hideErr = (sel) => { $(sel).hidden = true; };

let account = null;

function setView() {
  $('#signin-card').hidden = !!account;
  $('#agents-card').hidden = !account;
  $('#connections-card').hidden = !account;
  $('#advanced-card').hidden = !account;
  $('#signout').hidden = !account;
  $('#account-chip').textContent = account ? `signed in as ${account.username}` : '';
}

// --- sign in / out ----------------------------------------------------------

$('#signin').addEventListener('submit', async (e) => {
  e.preventDefault(); hideErr('#signin-err');
  try {
    ({ account } = await api('/api/account/login', {
      method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))),
    }));
    e.target.reset(); setView(); refresh();
  } catch (err) { showErr('#signin-err', err.message); }
});

$('#signout').addEventListener('click', async () => {
  await api('/api/account/logout', { method: 'POST' }).catch(() => {});
  account = null; setView();
});

$('#quit').addEventListener('click', async () => {
  if (!confirm('Stop the bridge? Every connection will disconnect until you launch it again.')) return;
  await api('/api/quit', { method: 'POST' }).catch(() => {});
  document.body.innerHTML =
    '<p style="font-family:Inter,sans-serif;padding:2rem">BuildHall Bridge stopped. You can close this tab.</p>';
});

// --- groups -----------------------------------------------------------------

async function loadGroups(selectSlug) {
  try {
    const { groups } = await api('/api/groups');
    const sel = $('#group-select');
    sel.innerHTML = '';
    for (const g of groups) {
      const o = document.createElement('option');
      o.value = g.slug; o.textContent = `${g.name} (${g.slug})`;
      sel.append(o);
    }
    if (selectSlug) sel.value = selectSlug;
    if (!groups.length) {
      const o = document.createElement('option');
      o.value = ''; o.textContent = 'no groups yet — create one →';
      sel.append(o);
    }
  } catch { /* shown via agents-err on connect */ }
}

$('#new-group').addEventListener('submit', async (e) => {
  e.preventDefault(); hideErr('#agents-err');
  const name = new FormData(e.target).get('name');
  if (!String(name || '').trim()) return;
  try {
    const { group } = await api('/api/groups', { method: 'POST', body: JSON.stringify({ name }) });
    e.target.reset();
    await loadGroups(group.slug);
  } catch (err) { showErr('#agents-err', err.message); }
});

// --- AIs --------------------------------------------------------------------

async function loadAgents() {
  const { agents } = await api('/api/agents');
  const list = $('#agent-list');
  list.innerHTML = '';
  for (const a of agents) {
    const el = document.createElement('div');
    el.className = 'conn';
    const status = a.connected ? '<span class="pill live">connected</span>'
      : a.installed ? '<span class="pill idle">found</span>'
        : '<span class="pill stopped">not found</span>';
    const detail = a.installed
      ? `found at <code>${esc(a.path || a.name)}</code>`
      : `${esc(a.reason || 'not found')} · <a href="${esc(a.installHint)}" target="_blank">get ${esc(a.title)}</a>`;
    el.innerHTML =
      `${status}
       <div class="grow">
         <div class="name">${esc(a.title)}</div>
         <div class="meta">${detail}</div>
       </div>`;
    if (!a.installed) {
      // Let the user point the bridge at a CLI auto-detect missed.
      const setPath = document.createElement('button');
      setPath.className = 'btn tiny2';
      setPath.textContent = a.override ? 'Change path' : 'Set path';
      setPath.onclick = async () => {
        const command = prompt(
          `Full path or command for ${a.title} (as you'd type it in your terminal):`,
          a.override || a.name);
        if (command === null) return;
        try { await api(`/api/agents/${a.name}/command`, { method: 'POST', body: JSON.stringify({ command }) }); refresh(); }
        catch (err) { showErr('#agents-err', err.message); }
      };
      el.append(setPath);
    }
    if (a.installed) {
      const test = document.createElement('button');
      test.className = 'btn tiny2';
      test.textContent = 'Test';
      test.title = 'Run the AI once and show what it replies';
      test.onclick = async () => {
        test.disabled = true; const was = test.textContent; test.textContent = 'Testing…';
        try {
          const r = await api(`/api/agents/${a.name}/test`, { method: 'POST' });
          const box = document.createElement('div');
          box.className = 'testout ' + (r.ok ? 'good' : 'bad');
          box.textContent = r.ok
            ? `OK — the AI replied: ${r.stdout.slice(0, 200)}`
            : `Problem: ${r.error || 'no reply'}${r.stderr ? `\n${r.stderr.slice(0, 400)}` : ''}`;
          el.parentElement.insertBefore(box, el.nextSibling);
          setTimeout(() => box.remove(), 15000);
        } catch (err) { showErr('#agents-err', err.message); }
        test.disabled = false; test.textContent = was;
      };
      el.append(test);
    }
    if (a.installed && !a.connected) {
      const respond = document.createElement('label');
      respond.className = 'checkbox';
      respond.innerHTML = '<input type="checkbox" checked> Auto-respond';
      const connect = document.createElement('button');
      connect.className = 'btn primary tiny2';
      connect.textContent = 'Connect';
      connect.onclick = async () => {
        hideErr('#agents-err');
        const group = $('#group-select').value;
        if (!group) return showErr('#agents-err', 'pick or create a group first');
        connect.disabled = true; connect.textContent = 'Connecting…';
        try {
          await api(`/api/agents/${a.name}/connect`, {
            method: 'POST',
            body: JSON.stringify({ group, respond: respond.querySelector('input').checked }),
          });
          refresh();
        } catch (err) {
          showErr('#agents-err', err.message);
          connect.disabled = false; connect.textContent = 'Connect';
        }
      };
      const login = document.createElement('button');
      login.className = 'btn tiny2';
      login.textContent = 'Open login';
      login.title = `Opens a terminal running "${a.name}" so you can sign in to it`;
      login.onclick = () => api(`/api/agents/${a.name}/login`, { method: 'POST' }).catch(() => {});
      el.append(respond, login, connect);
    }
    list.append(el);
  }
}

// --- connections ------------------------------------------------------------

async function loadConnections() {
  const { connections } = await api('/api/connections');
  const list = $('#list');
  list.innerHTML = '';
  $('#empty').hidden = connections.length > 0;
  for (const c of connections) {
    const el = document.createElement('div');
    el.className = 'conn';
    el.innerHTML =
      `<span class="pill ${esc(c.status)}">${esc(c.status)}</span>
       <div class="grow">
         <div class="name">${esc(c.label)}</div>
         <div class="meta">group <b>${esc(c.group)}</b> · ${esc(c.file)}</div>
         <div class="meta">${esc(c.detail || '')} · sent ${c.sent} · received ${c.received}</div>
       </div>`;
    const restart = document.createElement('button');
    restart.className = 'btn tiny'; restart.textContent = 'Restart';
    restart.onclick = async () => { await api(`/api/connections/${c.id}/restart`, { method: 'POST' }); refresh(); };
    const del = document.createElement('button');
    del.className = 'btn tiny'; del.textContent = 'Remove';
    del.onclick = async () => { await api(`/api/connections/${c.id}`, { method: 'DELETE' }); refresh(); };
    el.append(restart, del);
    list.append(el);
  }
}

$('#add').addEventListener('submit', async (e) => {
  e.preventDefault(); hideErr('#err');
  try {
    await api('/api/connections', {
      method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))),
    });
    e.target.reset();
    e.target.url.value = 'https://buildhall.ai';
    refresh();
  } catch (err) { showErr('#err', err.message); }
});

// --- boot -------------------------------------------------------------------

async function refresh() {
  if (!account) return;
  await Promise.all([loadAgents(), loadConnections()]);
}

(async () => {
  ({ account } = await api('/api/account').catch(() => ({ account: null })));
  setView();
  if (account) { await loadGroups(); refresh(); setInterval(refresh, 4000); }
})();
