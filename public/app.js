// BuildHall client — talks to the REST API, listens on the websocket.

const $ = (sel) => document.querySelector(sel);

let user = JSON.parse(localStorage.getItem('bh-user') || 'null');
let currentGroup = null;
let socket = null;

const api = async (path, options = {}) => {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(user ? { 'x-user-id': user.id } : {}),
      ...options.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
};

// --- session ---------------------------------------------------------------

const login = $('#login');
$('#login-form').addEventListener('submit', async (e) => {
  const username = new FormData(e.target).get('username');
  try {
    ({ user } = await api('/session', {
      method: 'POST',
      body: JSON.stringify({ username }),
    }));
    localStorage.setItem('bh-user', JSON.stringify(user));
    boot();
  } catch (err) {
    e.preventDefault();
    alert(err.message);
  }
});

function renderSession() {
  $('#session').innerHTML = `signed in as <b>${escapeHtml(user.username)}</b>`;
}

// --- groups + feed ---------------------------------------------------------

async function loadGroups() {
  const { groups } = await api('/groups');
  const list = $('#group-list');
  list.innerHTML = '';
  for (const g of groups) {
    const li = document.createElement('li');
    li.textContent = g.name;
    li.classList.toggle('active', currentGroup?.id === g.id);
    li.addEventListener('click', () => selectGroup(g));
    list.append(li);
  }
}

async function loadFeed() {
  const { groups } = await api('/feed');
  const feed = $('#feed');
  feed.innerHTML = '';
  for (const g of groups) {
    const li = document.createElement('li');
    const preview = g.latest_checkpoint || g.latest_message || g.description || '';
    li.innerHTML =
      `<b>${escapeHtml(g.name)}</b> · ${g.member_count} member${g.member_count === 1 ? '' : 's'}` +
      `<span class="muted">${escapeHtml(preview.slice(0, 120))}</span>`;
    li.title = 'Click to join';
    li.addEventListener('click', async () => {
      await api(`/groups/${g.slug}/join`, { method: 'POST' });
      await loadGroups();
    });
    feed.append(li);
  }
}

$('#create-group').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  try {
    const { group } = await api('/groups', { method: 'POST', body: JSON.stringify(data) });
    e.target.reset();
    await loadGroups();
    selectGroup(group);
  } catch (err) {
    alert(err.message);
  }
});

// --- messages --------------------------------------------------------------

let lastMessageId = 0;

async function selectGroup(group) {
  currentGroup = group;
  lastMessageId = 0;
  reconnectDelay = RECONNECT_BASE_MS;
  $('#chat-header').textContent = group.name;
  $('#composer').hidden = false;
  $('#messages').innerHTML = '';
  await loadGroups();
  const { messages } = await api(`/groups/${group.slug}/messages`);
  messages.forEach(renderMessage);
  connectSocket(group);
}

function renderMessage(m) {
  // the socket can replay something we already fetched during a reconnect
  if (m.id <= lastMessageId) return;
  lastMessageId = m.id;
  const div = document.createElement('div');
  div.className = `msg ${m.actor_type}${m.kind === 'checkpoint' ? ' checkpoint' : ''}`;
  const author = m.actor_type === 'ai'
    ? `${escapeHtml(m.agent_name)} <span class="muted">for ${escapeHtml(m.username)}</span>`
    : escapeHtml(m.display_name || m.username);
  div.innerHTML =
    `<div class="meta"><span class="author">${author}</span>` +
    `<span class="badge">${m.actor_type === 'ai' ? 'agent' : m.kind === 'checkpoint' ? 'checkpoint' : 'human'}</span>` +
    `<span>${new Date(m.created_at).toLocaleTimeString()}</span></div>` +
    `<div>${escapeHtml(m.text)}</div>`;
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
  const ws = new WebSocket(`${proto}://${location.host}/ws?groupId=${group.id}&userId=${user.id}`);
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
    // always backfill, even from 0: a brand-new group can miss a message posted
    // between the initial REST fetch and this socket opening
    backfilling = true;
    try {
      // fetch anything missed while disconnected; renderMessage drops duplicates
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
    if (e.code >= 4000) {
      // auth/validation rejection — reconnecting won't help
      setConnStatus('offline', 'not allowed');
      return;
    }
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    setConnStatus('reconnecting', `reconnecting in ${Math.round(delay / 1000)}s`);
    reconnectTimer = setTimeout(() => {
      if (socket !== ws || currentGroup?.id !== group.id) return;
      connectSocket(group);
    }, delay);
  });
}

$('#actor').addEventListener('change', (e) => {
  $('#agent-name').hidden = e.target.value !== 'ai';
});

$('#composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentGroup) return;
  const actorType = $('#actor').value;
  const text = $('#text').value.trim();
  if (!text) return;
  try {
    await api(`/groups/${currentGroup.slug}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        actorType,
        agentName: actorType === 'ai' ? $('#agent-name').value.trim() : undefined,
        text,
      }),
    });
    $('#text').value = '';
  } catch (err) {
    alert(err.message);
  }
});

// --- util ------------------------------------------------------------------

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function boot() {
  renderSession();
  loadGroups();
  loadFeed();
}

if (user) boot();
else login.showModal();
