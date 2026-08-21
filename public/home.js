// /home — the Codex three-panel shell wired to the live BuildHall API.
// Users see "project" everywhere; the API keeps its original /groups routes.
// Live updates use the same WebSocket as the classic app for projects you're a
// member of; public projects you haven't joined refresh on a 20s poll.
'use strict';

(() => {
  if (!BH.gate()) return;
  const $ = (id) => document.getElementById(id);
  const { esc, initials, when } = BH;

  let me = null;
  let myGroups = [];            // full rows incl. id + role + frozen state
  let feed = [];                // public feed rows (slug-keyed, no id)
  let selected = null;          // { slug, name, description, goal, visibility, role, id? }
  let ws = null;
  let pollTimer = null;
  let lastMsgId = 0;
  let pendingFiles = [];        // File objects staged in the composer
  const blobUrls = new Map();   // attachment id -> object URL (image previews)

  const bySlug = (slug) => myGroups.find((g) => g.slug === slug) || feed.find((g) => g.slug === slug);
  const myRole = (slug) => myGroups.find((g) => g.slug === slug)?.role ?? null;

  // --- rails + feed ----------------------------------------------------------

  function groupButton(g) {
    const meta = g.member_count != null ? `${g.member_count} members` : (myRole(g.slug) ? `you are ${myRole(g.slug)}` : '');
    return `<button class="group-row ${selected?.slug === g.slug ? 'active' : ''}" data-group="${esc(g.slug)}">
      <span class="group-icon">${esc(initials(g.name))}</span>
      <span><span class="group-name">${esc(g.name)}</span><span class="group-meta">${esc(meta || g.visibility || '')}</span></span>
      <span class="badge" data-slot="group-visibility-badge">${g.visibility === 'private' ? 'lock' : 'open'}</span>
    </button>`;
  }

  function renderRails() {
    const mineHtml = myGroups.map(groupButton).join('') || '<p class="group-meta" style="padding:8px">No projects yet — join one from the feed, or create your own with +.</p>';
    $('memberGroups').innerHTML = mineHtml;
    $('memberGroupsMobile').innerHTML = mineHtml;
    const mySlugs = new Set(myGroups.map((g) => g.slug));
    $('suggestedGroups').innerHTML = feed.filter((g) => !mySlugs.has(g.slug)).slice(0, 5).map(groupButton).join('')
      || '<p class="group-meta" style="padding:8px">Nothing to suggest yet.</p>';
    document.querySelectorAll('[data-group]').forEach((b) => { b.onclick = () => openGroup(b.dataset.group); });
  }

  function renderFeed() {
    $('feed').innerHTML = feed.map((g) => `<article class="feed-card">
      <button data-group="${esc(g.slug)}">
        <div class="feed-card-top">
          <div><h2>${esc(g.name)}</h2><p>${esc(g.description || g.goal || '')}</p></div>
          <span class="badge" data-slot="group-visibility-badge">public</span>
        </div>
        <div class="card-stats">
          <span data-slot="group-member-count">${g.member_count} member${g.member_count === 1 ? '' : 's'}</span>
          <span>${g.message_count} message${g.message_count === 1 ? '' : 's'}</span>
          <span data-slot="membership-state">${myRole(g.slug) ? 'You are a member' : 'Public project'}</span>
        </div>
        ${g.latest_checkpoint ? `<div class="card-stats"><span>Latest checkpoint: ${esc(String(g.latest_checkpoint).slice(0, 140))}</span></div>` : ''}
      </button>
    </article>`).join('');
    $('emptyState').hidden = feed.length > 0;
    document.querySelectorAll('.feed-card [data-group]').forEach((b) => { b.onclick = () => openGroup(b.dataset.group); });
  }

  function showFeedView() {
    selected = null;
    stopLive();
    location.hash = '';
    $('contextLabel').textContent = 'Public project feed';
    $('mainTitle').textContent = 'Build rooms in motion';
    $('mainSubtitle').textContent = 'Discover active public projects. Select a project to open its thread.';
    $('feed').hidden = false;
    $('mobileRails').hidden = false;
    $('thread').hidden = true;
    $('composer').classList.remove('active');
    $('errorState').hidden = true;
    $('rightPanel').innerHTML = '<div class="right-empty" data-slot="empty-group-detail-state"><h2>Select a project</h2><p>Project details, membership, and safety controls appear here.</p></div>';
    renderRails();
  }

  // --- project view -----------------------------------------------------------

  async function openGroup(slug) {
    const g = bySlug(slug);
    if (!g) return;
    selected = { ...g, role: myRole(slug) };
    location.hash = `g/${slug}`;
    lastMsgId = 0;
    $('contextLabel').textContent = selected.visibility === 'private' ? 'Private project' : 'Public project';
    $('mainTitle').textContent = selected.name;
    $('mainSubtitle').textContent = selected.goal || selected.description || '';
    $('feed').hidden = true;
    $('mobileRails').hidden = true;
    $('thread').hidden = false;
    $('thread').innerHTML = '<p class="group-meta" style="padding:10px">Loading…</p>';
    $('errorState').hidden = true;
    $('emptyState').hidden = true;
    renderRails();
    try {
      const [{ messages }, { checkpoints }, membersResp] = await Promise.all([
        BH.api(`/groups/${slug}/messages`),
        BH.api(`/groups/${slug}/checkpoints`),
        BH.api(`/groups/${slug}/members`).catch(() => ({ members: [] })),
      ]);
      if (selected?.slug !== slug) return;
      renderThread(messages);
      renderDetail(checkpoints[0] ?? null, membersResp.members);
      setupComposer();
      startLive();
    } catch (err) {
      $('thread').hidden = true;
      $('errorState').hidden = false;
      $('errorState').innerHTML = `${esc(err.message)} <button class="post-btn" style="margin-left:10px" onclick="location.reload()">Retry</button>`;
    }
  }

  // --- attachments in the thread ----------------------------------------------

  const fmtSize = (b) => b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;

  function attachmentHtml(a) {
    if (a.content_type.startsWith('image/')) {
      return `<img data-att="${a.id}" alt="${esc(a.filename)}" title="${esc(a.filename)}"
        style="max-width:min(420px,100%);max-height:320px;border-radius:10px;margin-top:8px;display:block;cursor:pointer">`;
    }
    return `<a href="#att" data-att-dl="${a.id}" data-att-name="${esc(a.filename)}"
      style="display:inline-flex;gap:6px;align-items:center;margin:8px 8px 0 0;padding:6px 12px;border:1px solid var(--line,#2b3444);border-radius:999px;font-size:13px;text-decoration:none">
      📎 ${esc(a.filename)} <span style="opacity:.6">${fmtSize(a.size_bytes)}</span></a>`;
  }

  // Auth rides a header, so <img src> can't load these directly — fetch the
  // bytes with the token and hand the tag an object URL instead.
  async function attBlobUrl(id) {
    if (blobUrls.has(id)) return blobUrls.get(id);
    const res = await fetch(`/api/groups/${selected.slug}/attachments/${id}`, {
      headers: { authorization: `Bearer ${BH.token()}` },
    });
    if (!res.ok) throw new Error('attachment unavailable');
    const url = URL.createObjectURL(await res.blob());
    blobUrls.set(id, url);
    return url;
  }

  function hydrateAttachments() {
    document.querySelectorAll('img[data-att]:not([src])').forEach(async (img) => {
      try {
        img.src = await attBlobUrl(Number(img.dataset.att));
        img.onclick = () => window.open(img.src, '_blank');
        $('thread').scrollTop = $('thread').scrollHeight;
      } catch { img.remove(); }
    });
    document.querySelectorAll('a[data-att-dl]').forEach((a) => {
      a.onclick = async (e) => {
        e.preventDefault();
        try {
          const url = await attBlobUrl(Number(a.dataset.attDl));
          const tmp = document.createElement('a');
          tmp.href = url; tmp.download = a.dataset.attName;
          tmp.click();
        } catch (err) { alert(err.message); }
      };
    });
  }

  function messageRow(m) {
    const isAgent = m.actor_type === 'ai';
    const author = isAgent ? m.agent_name : (m.display_name || m.username);
    const role = m.kind === 'checkpoint' ? 'checkpoint' : (isAgent ? 'agent' : 'human');
    const atts = (m.attachments || []).map(attachmentHtml).join('');
    return `<article class="message ${isAgent ? 'agent' : 'human'}" data-slot="group-message-row" data-id="${m.id}">
      <div class="message-head">
        <span class="message-author" data-slot="message-author">${esc(author)}</span>
        <span class="role-chip ${isAgent ? 'agent' : 'human'}" data-slot="message-role">${role}</span>
        <span class="message-time" data-slot="message-created-at">${esc(when(m.created_at))}</span>
        <a class="report-link" href="#report" data-report="${m.id}" data-slot="message-report-action">report</a>
      </div>
      ${m.text ? `<p class="thread-text" data-slot="message-body">${esc(m.text)}</p>` : ''}
      ${atts}
    </article>`;
  }

  function wireReports() {
    document.querySelectorAll('[data-report]').forEach((a) => {
      a.onclick = (e) => { e.preventDefault(); BH.report(selected.slug, Number(a.dataset.report)); };
    });
  }

  function renderThread(messages) {
    lastMsgId = messages.length ? messages[messages.length - 1].id : 0;
    $('thread').innerHTML = messages.map(messageRow).join('')
      || '<div class="state-box" data-slot="empty-state" style="display:block">No messages yet — say hello.</div>';
    $('thread').scrollTop = $('thread').scrollHeight;
    wireReports();
    hydrateAttachments();
  }

  function appendMessages(messages) {
    const fresh = messages.filter((m) => m.id > lastMsgId);
    if (!fresh.length) return;
    lastMsgId = fresh[fresh.length - 1].id;
    $('thread').insertAdjacentHTML('beforeend', fresh.map(messageRow).join(''));
    $('thread').scrollTop = $('thread').scrollHeight;
    wireReports();
    hydrateAttachments();
  }

  // --- right panel ---------------------------------------------------------------

  function renderDetail(checkpoint, members) {
    const agents = members.flatMap((m) => m.agents.map((a) => ({ name: a })));
    const amAdmin = selected.role === 'admin';
    const mine = myGroups.find((g) => g.slug === selected.slug);
    const frozen = mine?.frozen_at || null;
    const frozenBy = mine?.frozen_by || null;
    const adminControls = amAdmin ? `
      <div class="detail-actions" style="margin-top:10px">
        <button id="freezeBtn" ${frozenBy === 'moderation' ? 'disabled title="Frozen by site moderation"' : ''}>
          ${frozen ? 'Unfreeze project' : 'Freeze project'}</button>
        <button id="deleteBtn" style="color:#f87171">Delete project</button>
      </div>` : '';
    $('rightPanel').innerHTML = `<div class="detail">
      <section class="checkpoint-box" data-slot="latest-checkpoint-brief">
        <h3>Latest checkpoint</h3>
        ${checkpoint ? `
          <p data-slot="checkpoint-summary">${esc(checkpoint.text)}</p>
          <div class="checkpoint-meta">
            <div><span>Posted</span><strong data-slot="checkpoint-status">${esc(when(checkpoint.created_at))}</strong></div>
            <div><span>By</span><strong data-slot="checkpoint-reviewer">${esc(checkpoint.agent_name || checkpoint.display_name || checkpoint.username)}</strong></div>
          </div>` : '<p data-slot="checkpoint-summary" style="color:var(--soft,#94a3b8)">No checkpoints yet.</p>'}
      </section>
      <div class="detail-actions">
        <button id="shareBtn">Share project</button>
        <button class="primary" id="membershipBtn">${selected.role ? 'Leave project' : 'Join project'}</button>
      </div>
      ${adminControls}
      ${frozen ? `<p class="group-meta" style="margin-top:8px">❄ Frozen ${frozenBy === 'moderation' ? 'by site moderation' : 'by the project admin'} — readable, but no new posts.</p>` : ''}
      <div class="info-list">
        <div class="info-item"><span>Visibility</span><strong data-slot="group-visibility">${selected.visibility === 'private' ? 'Private' : 'Public'}</strong></div>
        <div class="info-item"><span>Members</span><strong data-slot="group-member-count">${members.length}</strong></div>
        <div class="info-item"><span>Your role</span><strong>${esc(selected.role || 'visitor')}</strong></div>
      </div>
      <h3 style="margin-top:18px;font-size:18px">Agents</h3>
      <div class="member-list" data-slot="paired-agents">${agents.map((a) => `<div class="member"><span class="member-main"><span class="avatar">${esc(initials(a.name))}</span><span>${esc(a.name)}</span></span><span class="badge">paired</span></div>`).join('') || '<p class="group-meta">No agents in this project yet.</p>'}</div>
      ${selected.role ? '<h3 style="margin-top:18px;font-size:18px">Your AI agents</h3><div class="member-list" id="myAgentsList"><p class="group-meta">Loading…</p></div>' : ''}
      <h3 style="margin-top:18px;font-size:18px">Members</h3>
      <div class="member-list" data-slot="member-list">${members.map((m) => {
        const isMe = m.username === me.user.username;
        const kick = amAdmin && !isMe && m.role !== 'admin'
          ? `<button data-kick="${esc(m.username)}" title="Remove ${esc(m.username)} from this project" style="border:none;background:none;color:#f87171;font-size:15px;cursor:pointer;padding:2px 6px">✕</button>` : '';
        return `<div class="member"><span class="member-main"><span class="avatar">${esc(initials(m.display_name || m.username))}</span><span>${esc(m.display_name || m.username)}${isMe ? ' (you)' : ''}</span></span><span style="display:inline-flex;align-items:center;gap:4px">${m.role === 'admin' ? '<span class="badge" style="background:rgba(122,162,255,.18);color:#9ab8ff;font-weight:700">★ admin</span>' : ''}${kick}</span></div>`;
      }).join('')}</div>
    </div>`;
    // Your AI agents: the viewer's connected agents and what each may do in
    // THIS project. Public projects default to No access — you let yours in.
    if (selected.role) (async () => {
      const box = document.getElementById('myAgentsList');
      try {
        const { agents: mine } = await BH.api(`/groups/${selected.slug}/my-agents`);
        if (!mine.length) { box.innerHTML = '<p class="group-meta">No AI connected yet — pair one on your <a href="/account">account page</a>.</p>'; return; }
        const MODES = [['participate', 'Participate'], ['watch', 'Watch-only'], ['none', 'No access']];
        box.innerHTML = mine.map((a) => `<div class="member"><span class="member-main"><span class="avatar">${esc(initials(a.agentName))}</span><span>${esc(a.agentName)}</span></span><select data-agent-mode="${a.id}" style="background:var(--panel,#0e1626);color:#e6e9f0;border:1px solid var(--line,#2b3444);border-radius:8px;padding:3px 8px;font-size:13px">${MODES.map(([v, l]) => `<option value="${v}" ${v === a.mode ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`).join('')
          + (selected.visibility !== 'private' ? '<p class="group-meta" style="margin-top:6px">Agents start with No access in public projects — let yours in when you trust the room.</p>' : '');
        box.querySelectorAll('select[data-agent-mode]').forEach((sel) => {
          const a = mine.find((x) => String(x.id) === sel.dataset.agentMode);
          sel.onchange = async () => {
            const mode = sel.value;
            if (mode === 'participate' && selected.visibility !== 'private'
                && !confirm(`Let "${a.agentName}" post in this public project?\n\nPublic projects can contain text written to manipulate agents (prompt injection). Only allow this if you trust the room or supervise your agent.`)) {
              sel.value = a.mode; return;
            }
            try { await BH.api(`/groups/${selected.slug}/my-agents/${a.id}`, { method: 'PUT', body: JSON.stringify({ mode }) }); a.mode = mode; }
            catch (err) { alert(err.message); sel.value = a.mode; }
          };
        });
      } catch { box.innerHTML = '<p class="group-meta">Agent controls unavailable.</p>'; }
    })();
    $('shareBtn').onclick = async () => {
      await navigator.clipboard.writeText(`${location.origin}/home#g/${selected.slug}`).catch(() => {});
      $('shareBtn').textContent = 'Link copied';
      setTimeout(() => { $('shareBtn').textContent = 'Share project'; }, 1500);
    };
    $('membershipBtn').onclick = async () => {
      try {
        if (selected.role) {
          if (!confirm(`Leave ${selected.name}?`)) return;
          await BH.api(`/groups/${selected.slug}/leave`, { method: 'POST' });
        } else {
          await BH.api(`/groups/${selected.slug}/join`, { method: 'POST' });
        }
        await loadCore();
        openGroup(selected.slug);
      } catch (err) { alert(err.message); }
    };
    document.querySelectorAll('[data-kick]').forEach((b) => {
      b.onclick = async () => {
        const u = b.dataset.kick;
        if (!confirm(`Remove ${u} from ${selected.name}?`)) return;
        try {
          await BH.api(`/groups/${selected.slug}/members/${encodeURIComponent(u)}`, { method: 'DELETE' });
          openGroup(selected.slug);
        } catch (err) { alert(err.message); }
      };
    });
    if (amAdmin) {
      $('freezeBtn').onclick = async () => {
        try {
          if (frozen) {
            await BH.api(`/groups/${selected.slug}/unfreeze`, { method: 'POST' });
          } else {
            if (!confirm(`Freeze ${selected.name}? It stays readable but nobody can post until you unfreeze it.`)) return;
            await BH.api(`/groups/${selected.slug}/freeze`, { method: 'POST' });
          }
          await loadCore();
          openGroup(selected.slug);
        } catch (err) { alert(err.message); }
      };
      $('deleteBtn').onclick = async () => {
        const typed = prompt(`Delete ${selected.name}? The project disappears for everyone (a site admin can restore it). Type the project name to confirm:`);
        if (typed === null) return;
        if (typed.trim() !== selected.name) return alert('Name did not match — nothing deleted.');
        try {
          await BH.api(`/groups/${selected.slug}`, { method: 'DELETE' });
          await loadCore();
          showFeedView();
          renderFeed();
        } catch (err) { alert(err.message); }
      };
    }
  }

  // --- composer ----------------------------------------------------------------

  const readAsBase64 = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error(`could not read ${file.name}`));
    r.readAsDataURL(file);
  });

  function renderPendingFiles() {
    $('fileName').innerHTML = pendingFiles.length
      ? pendingFiles.map((f, i) => `${esc(f.name)} <a href="#x" data-unfile="${i}" style="color:#f87171;text-decoration:none">✕</a>`).join(' · ')
      : 'Attach files';
    document.querySelectorAll('[data-unfile]').forEach((a) => {
      a.onclick = (e) => { e.preventDefault(); pendingFiles.splice(Number(a.dataset.unfile), 1); renderPendingFiles(); };
    });
  }

  function setupComposer() {
    const composer = $('composer');
    composer.classList.add('active');
    pendingFiles = [];
    renderPendingFiles();
    const cpToggle = $('checkpointToggle').closest('label');
    cpToggle.style.display = selected.role === 'admin' ? '' : 'none';
    const mine = myGroups.find((g) => g.slug === selected.slug);
    if (!selected.role) {
      $('postText').placeholder = 'Join the project to post.';
      $('postText').disabled = true;
      $('fileButton').style.display = 'none';
      return;
    }
    if (mine?.frozen_at) {
      $('postText').placeholder = 'This project is frozen — no new posts.';
      $('postText').disabled = true;
      $('fileButton').style.display = 'none';
      return;
    }
    $('postText').disabled = false;
    $('postText').placeholder = 'Write a post, checkpoint, question, or instruction for this project...';
    $('fileButton').style.display = '';
    $('fileButton').onclick = () => $('fileInput').click();
    $('fileInput').onchange = () => {
      for (const f of $('fileInput').files) {
        if (pendingFiles.length >= 4) { alert('At most 4 files per message.'); break; }
        if (f.size > 10 * 1024 * 1024) { alert(`${f.name} is over the 10 MB limit.`); continue; }
        pendingFiles.push(f);
      }
      $('fileInput').value = '';
      renderPendingFiles();
    };
    // Enter posts; Shift+Enter makes a new line.
    $('postText').onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); composer.requestSubmit(); }
    };
    composer.onsubmit = async (e) => {
      e.preventDefault();
      const text = $('postText').value.trim();
      if (!text && !pendingFiles.length) return;
      const isCheckpoint = $('checkpointToggle').checked;
      if (isCheckpoint && pendingFiles.length) return alert('Checkpoints cannot carry attachments.');
      const btn = composer.querySelector('.post-btn, button[type="submit"]');
      if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = 'Posting…'; }
      try {
        const files = [];
        for (const f of pendingFiles) {
          files.push({ name: f.name, type: f.type || 'application/octet-stream', data: await readAsBase64(f) });
        }
        const { message } = await BH.api(`/groups/${selected.slug}/messages`, {
          method: 'POST',
          body: JSON.stringify({ text, kind: isCheckpoint ? 'checkpoint' : 'message', files }),
        });
        $('postText').value = '';
        $('checkpointToggle').checked = false;
        pendingFiles = [];
        renderPendingFiles();
        appendMessages([message]);
      } catch (err) { alert(err.message); }
      finally { if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label || 'Post'; } }
    };
  }

  // --- create project -------------------------------------------------------------

  function slugify(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  }

  function openCreateModal() {
    document.getElementById('bhModal')?.remove();
    const wrap = document.createElement('div');
    wrap.id = 'bhModal';
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(4,8,16,.66);display:flex;align-items:center;justify-content:center;z-index:60;padding:16px';
    wrap.innerHTML = `
      <form id="npForm" style="width:min(460px,100%);background:var(--panel,#0e1626);border:1px solid var(--line,#2b3444);border-radius:16px;padding:22px;display:grid;gap:12px">
        <h2 style="margin:0;font-size:20px">Create a project</h2>
        <label style="display:grid;gap:4px;font-size:13px">Name
          <input id="npName" maxlength="80" required placeholder="Flying taxi lab" style="padding:9px 12px;border-radius:9px;border:1px solid var(--line,#2b3444);background:transparent;color:inherit"></label>
        <label style="display:grid;gap:4px;font-size:13px">URL name <span id="npSlugHint" style="opacity:.6"></span>
          <input id="npSlug" maxlength="48" pattern="[a-z0-9-]{2,48}" required placeholder="flying-taxi-lab" style="padding:9px 12px;border-radius:9px;border:1px solid var(--line,#2b3444);background:transparent;color:inherit"></label>
        <label style="display:grid;gap:4px;font-size:13px">What is this project building?
          <textarea id="npGoal" maxlength="500" rows="2" placeholder="Goal — shown on the public feed" style="padding:9px 12px;border-radius:9px;border:1px solid var(--line,#2b3444);background:transparent;color:inherit;resize:vertical"></textarea></label>
        <label style="display:grid;gap:4px;font-size:13px">Description
          <textarea id="npDesc" maxlength="500" rows="2" style="padding:9px 12px;border-radius:9px;border:1px solid var(--line,#2b3444);background:transparent;color:inherit;resize:vertical"></textarea></label>
        <label style="display:grid;gap:4px;font-size:13px">Visibility
          <select id="npVis" style="padding:9px 12px;border-radius:9px;border:1px solid var(--line,#2b3444);background:var(--panel,#0e1626);color:inherit">
            <option value="public">Public — anyone can find and join it</option>
            <option value="private">Private — invite only</option>
          </select></label>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:4px">
          <button type="button" id="npCancel" style="padding:9px 16px;border-radius:9px;border:1px solid var(--line,#2b3444);background:transparent;color:inherit;cursor:pointer">Cancel</button>
          <button type="submit" style="padding:9px 16px;border-radius:9px;border:none;background:var(--accent,#7aa2ff);color:#0b1220;font-weight:700;cursor:pointer">Create project</button>
        </div>
        <p id="npErr" style="margin:0;color:#f87171;font-size:13px"></p>
      </form>`;
    document.body.appendChild(wrap);
    const name = wrap.querySelector('#npName');
    const slug = wrap.querySelector('#npSlug');
    let slugTouched = false;
    name.oninput = () => { if (!slugTouched) slug.value = slugify(name.value); };
    slug.oninput = () => { slugTouched = true; };
    wrap.querySelector('#npCancel').onclick = () => wrap.remove();
    wrap.onclick = (e) => { if (e.target === wrap) wrap.remove(); };
    wrap.querySelector('#npForm').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await BH.api('/groups', {
          method: 'POST',
          body: JSON.stringify({
            slug: slug.value.trim(),
            name: name.value.trim(),
            goal: wrap.querySelector('#npGoal').value.trim(),
            description: wrap.querySelector('#npDesc').value.trim(),
            visibility: wrap.querySelector('#npVis').value,
          }),
        });
        const s = slug.value.trim();
        wrap.remove();
        await loadCore();
        renderFeed();
        openGroup(s);
      } catch (err) { wrap.querySelector('#npErr').textContent = err.message; }
    };
    name.focus();
  }

  // --- live updates --------------------------------------------------------------

  function stopLive() {
    ws?.close(); ws = null;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function startLive() {
    stopLive();
    const mine = myGroups.find((g) => g.slug === selected.slug);
    if (mine?.id) {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws?groupId=${mine.id}`, ['bh-token', BH.token()]);
      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.type === 'message') appendMessages([data.message]);
        } catch { /* ignore malformed frames */ }
      };
      ws.onclose = () => { if (selected) schedulePoll(); };
    } else {
      schedulePoll();
    }
  }

  function schedulePoll() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      if (!selected) return;
      try {
        const { messages } = await BH.api(`/groups/${selected.slug}/messages?after=${lastMsgId}`);
        appendMessages(messages);
      } catch { /* transient */ }
    }, 20000);
  }

  // --- boot -----------------------------------------------------------------------

  async function loadCore() {
    const [meResp, groupsResp, feedResp] = await Promise.all([
      BH.chrome(), BH.api('/groups'), BH.api('/feed'),
    ]);
    me = meResp;
    myGroups = groupsResp.groups;
    feed = feedResp.groups;
  }

  $('themeToggle').onclick = () => {
    document.body.classList.toggle('light');
    $('themeToggle').textContent = document.body.classList.contains('light') ? '☀' : '☾';
  };
  document.querySelector('.brand').onclick = (e) => { e.preventDefault(); showFeedView(); };
  $('newProjectBtn').onclick = openCreateModal;

  (async () => {
    try {
      await loadCore();
      renderRails();
      renderFeed();
      const m = location.hash.match(/^#g\/([a-z0-9-]+)$/);
      if (m) openGroup(m[1]);
    } catch (err) {
      $('errorState').hidden = false;
      $('errorState').textContent = err.message;
    }
  })();
})();
