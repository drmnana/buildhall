const $ = (s) => document.querySelector(s);
const api = async (path, opts = {}) => {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status}`);
  return body;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function render() {
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
         <div class="name">${esc(c.label)}${c.agentName ? ` <span class="muted">· ${esc(c.agentName)}</span>` : ''}</div>
         <div class="meta">group <b>${esc(c.group)}</b> · ${esc(c.file)}</div>
         <div class="meta">${esc(c.detail || '')} · sent ${c.sent} · received ${c.received}</div>
       </div>`;
    const restart = document.createElement('button');
    restart.className = 'btn tiny'; restart.textContent = 'Restart';
    restart.onclick = async () => { await api(`/api/connections/${c.id}/restart`, { method: 'POST' }); render(); };
    const del = document.createElement('button');
    del.className = 'btn tiny'; del.textContent = 'Remove';
    del.onclick = async () => { await api(`/api/connections/${c.id}`, { method: 'DELETE' }); render(); };
    el.append(restart, del);
    list.append(el);
  }
  updateSnippet(connections[0]);
}

function updateSnippet(c) {
  const file = c?.file || 'C:\\Users\\you\\Desktop\\build-up.jsonl';
  $('#snippet').textContent =
`You are connected to a BuildHall group through a file on this machine:
  ${file}

To SEND a message to the group, append one line of JSON to that file:
  {"time":"<ISO timestamp>","author":"<your name>","text":"<your message>"}

To READ what others said, read the same file. Lines carrying "source":"buildhall"
came from the group — never append those back, they are already delivered.

Append only. Never rewrite or truncate the file.`;
}

$('#add').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#err').hidden = true;
  const body = JSON.stringify(Object.fromEntries(new FormData(e.target)));
  try {
    await api('/api/connections', { method: 'POST', body });
    e.target.reset();
    e.target.url.value = 'https://buildhall.ai';
    render();
  } catch (err) {
    $('#err').textContent = err.message;
    $('#err').hidden = false;
  }
});

api('/api/config-path').then(({ path }) => { $('#config-path').textContent = path; });
render();
setInterval(render, 3000);
