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

async function selectGroup(group) {
  currentGroup = group;
  $('#chat-header').textContent = group.name;
  $('#composer').hidden = false;
  $('#messages').innerHTML = '';
  await loadGroups();
  const { messages } = await api(`/groups/${group.slug}/messages`);
  messages.forEach(renderMessage);
  connectSocket(group);
}

function renderMessage(m) {
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

function connectSocket(group) {
  socket?.close();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${proto}://${location.host}/ws?groupId=${group.id}&userId=${user.id}`);
  socket.addEventListener('message', (e) => {
    const payload = JSON.parse(e.data);
    if (payload.type === 'message' && currentGroup?.id === group.id) {
      renderMessage(payload.message);
    }
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
