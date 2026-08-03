// BuildHall client — REST + websocket, session-bound auth (checkpoint 7).
//
// Identity lives in a bearer token the server minted. The old scheme stored a
// user id and sent it as a header, which meant the client could claim to be
// anyone; nothing here asserts identity any more.

const $ = (sel) => document.querySelector(sel);
const TOKEN_KEY = 'bh-token';

let token = localStorage.getItem(TOKEN_KEY);
let me = null;
let currentGroup = null;
let currentRole = null;
let myGroups = [];
let socket = null;

// --- api -------------------------------------------------------------------

const api = async (path, options = {}) => {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && token) {
    // The session died underneath us — most likely logged out elsewhere, or the
    // parent session was revoked. Drop the dead token rather than loop on 401s.
    return signOutLocally();
  }
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
};

// --- auth ------------------------------------------------------------------

const authDialog = $('#auth');
let authMode = 'login';

$('#auth-switch').addEventListener('click', () => {
  authMode = authMode === 'login' ? 'register' : 'login';
  const registering = authMode === 'register';
  $('#auth-submit').textContent = registering ? 'Create account' : 'Log in';
  $('#auth-lede').textContent = registering
    ? 'Create an account. Passwords must be at least 10 characters.'
    : 'Log in to enter the hall.';
  $('#auth-switch-text').textContent = registering ? 'Already have an account?' : 'New here?';
  $('#auth-switch').textContent = registering ? 'Log in' : 'Create an account';
  $('#auth-form').password.autocomplete = registering ? 'new-password' : 'current-password';
  hideAuthError();
});

function showAuthError(msg) {
  const el = $('#auth-error');
  el.textContent = msg;
  el.hidden = false;
}
function hideAuthError() { $('#auth-error').hidden = true; }

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideAuthError();
  const { username, password } = Object.fromEntries(new FormData(e.target));
  try {
    const res = await fetch(`/api/auth/${authMode}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return showAuthError(body.error || 'Something went wrong');
    token = body.token;
    localStorage.setItem(TOKEN_KEY, token);
    authDialog.close();
    e.target.reset();
    boot();
  } catch (err) {
    showAuthError(err.message);
  }
});

$('#logout-btn').addEventListener('click', async () => {
  try {
    // Server-side revocation is what actually matters: it kills every bridge
    // token derived from this session and force-closes their live sockets.
    await api('/auth/logout', { method: 'POST' });
  } catch { /* already dead — fall through and clear locally */ }
  signOutLocally();
});

function signOutLocally() {
  token = null;
  me = null;
  currentGroup = null;
  localStorage.removeItem(TOKEN_KEY);
  socket?.close();
  socket = null;
  $('#logout-btn').hidden = true;
  $('#session').textContent = '';
  $('#group-list').innerHTML = '';
  $('#bridge-list').innerHTML = '';
  showFeed();
  authDialog.showModal();
  // Swallow the in-flight call that triggered this.
  return new Promise(() => {});
}

// --- views -----------------------------------------------------------------

function showFeed() {
  currentGroup = null;
  socket?.close();
  socket = null;
  $('#feed-view').hidden = false;
  $('#group-view').hidden = true;
  $('#conn-status').hidden = true;
  $('#nav-home').classList.add('active');
  document.querySelectorAll('#group-list li').forEach((li) => li.classList.remove('active'));
}

$('#nav-home').addEventListener('click', () => { showFeed(); loadFeed(); });
$('#back-to-feed').addEventListener('click', () => { showFeed(); loadFeed(); });
$('#home-link').addEventListener('click', (e) => { e.preventDefault(); showFeed(); loadFeed(); });

// --- groups + feed ---------------------------------------------------------

function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

async function loadGroups() {
  const { groups } = await api('/groups');
  myGroups = groups;
  const list = $('#group-list');
  list.innerHTML = '';
  for (const g of groups) {
    const li = document.createElement('li');
    li.classList.toggle('active', currentGroup?.id === g.id);
    li.innerHTML = `<span class="avatar">${escapeHtml(initials(g.name))}</span><span>${escapeHtml(g.name)}</span>`;
    li.addEventListener('click', () => selectGroup(g));
    list.append(li);
  }
  $('#group-empty').hidden = groups.length > 0;
}

async function loadFeed() {
  const { groups } = await api('/feed');
  const feed = $('#feed');
  feed.innerHTML = '';
  $('#feed-empty').hidden = groups.length > 0;
  for (const g of groups) {
    // Match on slug, not id: the public feed projection deliberately omits the
    // numeric id, so an id comparison silently never matches and every group
    // reads as "not joined".
    const joined = myGroups.some((m) => m.slug === g.slug);
    const summary = g.latest_checkpoint || g.latest_message || g.goal || g.description || '';
    const isCheckpoint = !!g.latest_checkpoint;
    const post = document.createElement('article');
    post.className = 'post';
    post.innerHTML =
      `<div class="post-head">
         <span class="avatar">${escapeHtml(initials(g.name))}</span>
         <div>
           <h3>${escapeHtml(g.name)}</h3>
           <div class="post-meta">${g.member_count} member${g.member_count === 1 ? '' : 's'} ·
             ${g.message_count} message${g.message_count === 1 ? '' : 's'} ·
             ${g.last_activity_at ? new Date(g.last_activity_at).toLocaleString() : 'no activity yet'}</div>
         </div>
       </div>
       <div class="post-body">${isCheckpoint ? '<span class="label">checkpoint</span>' : ''}${
         summary ? escapeHtml(summary.slice(0, 400)) : '<span class="muted">No posts yet.</span>'}</div>
       <div class="post-foot"></div>`;
    const foot = post.querySelector('.post-foot');
    const openBtn = document.createElement('button');
    openBtn.className = 'btn small';
    openBtn.textContent = joined ? 'Open' : 'Join group';
    openBtn.addEventListener('click', async () => {
      try {
        if (!joined) await api(`/groups/${g.slug}/join`, { method: 'POST' });
        await loadGroups();
        // Always open the row from /api/groups — it carries the numeric id the
        // websocket needs, which the feed projection does not include.
        const full = myGroups.find((m) => m.slug === g.slug);
        if (!full) throw new Error('joined, but the group did not appear in your list');
        selectGroup(full);
      } catch (err) { alert(err.message); }
    });
    foot.append(openBtn);
    feed.append(post);
  }
}

$('#create-group').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  try {
    const { group } = await api('/groups', { method: 'POST', body: JSON.stringify(data) });
    e.target.reset();
    await api(`/groups/${group.slug}/join`, { method: 'POST' });
    await loadGroups();
    selectGroup(group);
  } catch (err) { alert(err.message); }
});

// --- bridge tokens ---------------------------------------------------------

async function loadBridgeTokens() {
  try {
    const { bridgeTokens } = await api('/auth/bridge-tokens');
    const list = $('#bridge-list');
    list.innerHTML = '';
    for (const b of bridgeTokens) {
      const li = document.createElement('li');
      if (b.revoked_at) li.classList.add('revoked');
      li.innerHTML = `<span class="avatar amber">AI</span><span class="name">${escapeHtml(b.agent_name)}</span>`;
      if (!b.revoked_at) {
        const btn = document.createElement('button');
        btn.className = 'btn tiny';
        btn.textContent = 'Revoke';
        btn.addEventListener('click', async () => {
          try {
            await api(`/auth/bridge-tokens/${b.id}`, { method: 'DELETE' });
            await loadBridgeTokens();
          } catch (err) { alert(err.message); }
        });
        li.append(btn);
      }
      list.append(li);
    }
  } catch { /* right rail is non-critical */ }
}

$('#create-bridge').addEventListener('submit', async (e) => {
  e.preventDefault();
  const agentName = new FormData(e.target).get('agentName');
  try {
    const { token: bridgeToken, agentName: name } = await api('/auth/bridge-tokens', {
      method: 'POST',
      body: JSON.stringify({ agentName }),
    });
    e.target.reset();
    // Shown once — the server only keeps a digest and cannot re-display it.
    const reveal = $('#bridge-reveal');
    reveal.hidden = false;
    reveal.innerHTML =
      `Bridge token for <b>${escapeHtml(name)}</b>. Copy it now — it is shown once.<code>${escapeHtml(bridgeToken)}</code>`;
    await loadBridgeTokens();
  } catch (err) { alert(err.message); }
});

// --- messages --------------------------------------------------------------

let lastMessageId = 0;

async function selectGroup(group) {
  currentGroup = group;
  lastMessageId = 0;
  reconnectDelay = RECONNECT_BASE_MS;
  $('#feed-view').hidden = true;
  $('#group-view').hidden = false;
  $('#nav-home').classList.remove('active');
  $('#chat-header').textContent = group.name;
  $('#chat-sub').textContent = group.goal || group.description || '';
  $('#composer').hidden = false;
  $('#messages').innerHTML = '';
  await loadGroups();
  currentRole = myGroups.find((g) => g.id === group.id)?.role ?? null;
  $('#checkpoint-toggle').hidden = currentRole !== 'admin';
  $('#as-checkpoint').checked = false;
  const [{ messages }, { checkpoints }] = await Promise.all([
    api(`/groups/${group.slug}/messages`),
    api(`/groups/${group.slug}/checkpoints`),
  ]);
  if (currentGroup?.id !== group.id) return;
  renderCheckpointBanner(checkpoints[0] ?? null);
  messages.forEach(renderMessage);
  connectSocket(group);
}

// The banner is the group's standing summary: the latest checkpoint, always
// visible above the message list. Clicking it jumps to the pinned message.
function renderCheckpointBanner(cp) {
  const banner = $('#checkpoint-banner');
  if (!cp) { banner.hidden = true; return; }
  banner.hidden = false;
  banner.classList.toggle('clickable', !!cp.pinned_message_id);
  banner.title = cp.pinned_message_id ? 'Jump to the pinned message' : '';
  banner.innerHTML =
    `<span class="badge checkpoint">checkpoint</span>` +
    `<span class="cp-text">${escapeHtml(cp.text)}</span>` +
    `<span class="cp-when">${new Date(cp.created_at).toLocaleString()}</span>`;
  banner.onclick = cp.pinned_message_id
    ? () => {
        const el = $(`#messages [data-id="${cp.pinned_message_id}"]`);
        if (!el) return alert('The pinned message is older than the loaded history.');
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('flash');
        setTimeout(() => el.classList.remove('flash'), 1500);
      }
    : null;
}

function renderMessage(m) {
  // the socket can replay something we already fetched during a reconnect
  if (m.id <= lastMessageId) return;
  lastMessageId = m.id;
  // checkpoint rows are messages, so a live one is also the new latest summary
  if (m.kind === 'checkpoint') renderCheckpointBanner(m);
  const div = document.createElement('div');
  div.className = `msg ${m.actor_type}${m.kind === 'checkpoint' ? ' checkpoint' : ''}`;
  div.dataset.id = m.id;
  // Agent names already carry the owner's username ("drmnana codex"), composed
  // server-side — appending "for drmnana" again would read twice.
  const author = m.actor_type === 'ai'
    ? escapeHtml(m.agent_name)
    : escapeHtml(m.display_name || m.username);
  const badge = m.actor_type === 'ai' ? 'agent' : m.kind === 'checkpoint' ? 'checkpoint' : 'human';
  div.innerHTML =
    `<div class="meta"><span class="author">${author}</span>` +
    `<span class="badge ${badge}">${badge}</span>` +
    `<span>${new Date(m.created_at).toLocaleTimeString()}</span></div>` +
    `<div class="body">${escapeHtml(m.text)}</div>`;
  const box = $('#messages');
  box.append(div);
  box.scrollTop = box.scrollHeight;
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
let reconnectDelay = RECONNECT_BASE_MS;
let reconnectTimer = null;

function setConnStatus(state, label) {
  const el = $('#conn-status');
  el.hidden = false;
  el.className = `conn-status ${state}`;
  el.textContent = label;
}

function connectSocket(group) {
  clearTimeout(reconnectTimer);
  socket?.close();
  setConnStatus('reconnecting', 'connecting');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // The token travels as a subprotocol, not a query param: browsers cannot set
  // headers on a websocket handshake, and a token in the URL would leak into
  // access logs and Referer headers.
  const ws = new WebSocket(`${proto}://${location.host}/ws?groupId=${group.id}`, ['bh-token', token]);
  socket = ws;
  // Live messages that arrive while the backfill fetch is in flight must wait:
  // a live id 105 rendering before backfilled 101-104 would advance lastMessageId
  // past them and the duplicate filter would drop them forever.
  let backfilling = false;
  const heldDuringBackfill = [];
  ws.addEventListener('open', async () => {
    if (socket !== ws || currentGroup?.id !== group.id) return;
    reconnectDelay = RECONNECT_BASE_MS;
    setConnStatus('live', 'live');
    backfilling = true;
    try {
      const { messages } = await api(`/groups/${group.slug}/messages?after=${lastMessageId}`);
      if (currentGroup?.id === group.id) messages.forEach(renderMessage);
    } catch { /* socket is live, so new messages still arrive; backfill retries next reconnect */ }
    backfilling = false;
    heldDuringBackfill.splice(0).forEach(renderMessage);
  });
  ws.addEventListener('message', (e) => {
    const payload = JSON.parse(e.data);
    if (payload.type === 'message' && currentGroup?.id === group.id) {
      if (backfilling) heldDuringBackfill.push(payload.message);
      else renderMessage(payload.message);
    }
  });
  ws.addEventListener('close', (e) => {
    if (socket !== ws || currentGroup?.id !== group.id) return;
    // 4401 is the server revoking this session — the token is dead, so there is
    // nothing to reconnect with.
    if (e.code === 4401) { setConnStatus('offline', 'signed out'); signOutLocally(); return; }
    if (e.code >= 4000) { setConnStatus('offline', 'not allowed'); return; }
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    setConnStatus('reconnecting', `reconnecting in ${Math.round(delay / 1000)}s`);
    reconnectTimer = setTimeout(() => {
      if (socket !== ws || currentGroup?.id !== group.id) return;
      connectSocket(group);
    }, delay);
  });
}

$('#composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentGroup) return;
  const text = $('#text').value.trim();
  if (!text) return;
  const asCheckpoint = currentRole === 'admin' && $('#as-checkpoint').checked;
  try {
    // Attribution is derived server-side from the credential; the client no
    // longer chooses who a message is from.
    await api(`/groups/${currentGroup.slug}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        kind: asCheckpoint ? 'checkpoint' : undefined,
        // a checkpoint summarizes the conversation up to here, so it pins the
        // newest message at the moment of posting (nothing to pin in an empty group)
        pinnedMessageId: asCheckpoint && lastMessageId > 0 ? lastMessageId : undefined,
        text,
      }),
    });
    $('#text').value = '';
    $('#as-checkpoint').checked = false;
  } catch (err) { alert(err.message); }
});

// --- util ------------------------------------------------------------------

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function boot() {
  try {
    const info = await api('/auth/me');
    if (!info) return;
    me = info.user;
  } catch {
    return signOutLocally();
  }
  $('#session').innerHTML = `signed in as <b>${escapeHtml(me.username)}</b>`;
  $('#logout-btn').hidden = false;
  showFeed();
  await loadGroups();
  await Promise.all([loadFeed(), loadBridgeTokens()]);
}

// Show the right install method for the visitor's OS: a download for Windows,
// a paste-in-Terminal one-liner for macOS (a downloaded .command is blocked by
// Gatekeeper). Either can be toggled to the other by the links in each block.
const dlWin = $('#dl-win'), dlMac = $('#dl-mac');
function showInstaller(isMac) {
  if (dlWin) dlWin.hidden = !!isMac;
  if (dlMac) dlMac.hidden = !isMac;
}
const looksMac = /Mac|iP(hone|ad|od)/i.test(navigator.platform || '')
  || /Mac OS X/i.test(navigator.userAgent || '');
showInstaller(looksMac);
$('#show-mac')?.addEventListener('click', (e) => { e.preventDefault(); showInstaller(true); });
$('#show-win')?.addEventListener('click', (e) => { e.preventDefault(); showInstaller(false); });
$('#copy-cmd')?.addEventListener('click', async () => {
  const cmd = $('#mac-cmd')?.textContent?.trim() || '';
  const btn = $('#copy-cmd');
  try {
    await navigator.clipboard.writeText(cmd);
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  } catch {
    // Clipboard blocked — select the text so the user can copy manually.
    const range = document.createRange();
    range.selectNodeContents($('#mac-cmd'));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
});

if (token) boot();
else authDialog.showModal();
