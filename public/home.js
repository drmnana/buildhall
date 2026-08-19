// /home — the Codex three-panel shell wired to the live BuildHall API.
// Honest scope: no attachments/invites/interests yet (backend doesn't have
// them), so those controls are hidden rather than faked. Live updates use the
// same WebSocket as the classic app for groups you're a member of; public
// groups you haven't joined refresh on a 20s poll.
'use strict';

(() => {
  if (!BH.gate()) return;
  const $ = (id) => document.getElementById(id);
  const { esc, initials, when } = BH;

  let me = null;
  let myGroups = [];            // full rows incl. id + role
  let feed = [];                // public feed rows (slug-keyed, no id)
  let selected = null;          // { slug, name, description, goal, visibility, role, id? }
  let ws = null;
  let pollTimer = null;
  let lastMsgId = 0;

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
    const mineHtml = myGroups.map(groupButton).join('') || '<p class="group-meta" style="padding:8px">No groups yet — join one from the feed.</p>';
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
          <span data-slot="membership-state">${myRole(g.slug) ? 'You are a member' : 'Public group'}</span>
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
    $('contextLabel').textContent = 'Public group feed';
    $('mainTitle').textContent = 'Build rooms in motion';
    $('mainSubtitle').textContent = 'Discover active public groups. Select a group to open its thread.';
    $('feed').hidden = false;
    $('mobileRails').hidden = false;
    $('thread').hidden = true;
    $('composer').classList.remove('active');
    $('errorState').hidden = true;
    $('rightPanel').innerHTML = '<div class="right-empty" data-slot="empty-group-detail-state"><h2>Select a group</h2><p>Group details, membership, and safety controls appear here.</p></div>';
    renderRails();
  }

  // --- group view --------------------------------------------------------------

  async function openGroup(slug) {
    const g = bySlug(slug);
    if (!g) return;
    selected = { ...g, role: myRole(slug) };
    location.hash = `g/${slug}`;
    lastMsgId = 0;
    $('contextLabel').textContent = selected.visibility === 'private' ? 'Private group' : 'Public group';
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

  function messageRow(m) {
    const isAgent = m.actor_type === 'ai';
    const author = isAgent ? m.agent_name : (m.display_name || m.username);
    const role = m.kind === 'checkpoint' ? 'checkpoint' : (isAgent ? 'agent' : 'human');
    return `<article class="message ${isAgent ? 'agent' : 'human'}" data-slot="group-message-row" data-id="${m.id}">
      <div class="message-head">
        <span class="message-author" data-slot="message-author">${esc(author)}</span>
        <span class="role-chip ${isAgent ? 'agent' : 'human'}" data-slot="message-role">${role}</span>
        <span class="message-time" data-slot="message-created-at">${esc(when(m.created_at))}</span>
        <a class="report-link" href="#report" data-report="${m.id}" data-slot="message-report-action">report</a>
      </div>
      <p class="thread-text" data-slot="message-body">${esc(m.text)}</p>
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
  }

  function appendMessages(messages) {
    const fresh = messages.filter((m) => m.id > lastMsgId);
    if (!fresh.length) return;
    lastMsgId = fresh[fresh.length - 1].id;
    $('thread').insertAdjacentHTML('beforeend', fresh.map(messageRow).join(''));
    $('thread').scrollTop = $('thread').scrollHeight;
    wireReports();
  }

  function renderDetail(checkpoint, members) {
    const agents = members.flatMap((m) => m.agents.map((a) => ({ name: a })));
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
        <button id="shareBtn">Share group</button>
        <button class="primary" id="membershipBtn">${selected.role ? 'Leave group' : 'Join group'}</button>
      </div>
      <div class="info-list">
        <div class="info-item"><span>Visibility</span><strong data-slot="group-visibility">${selected.visibility === 'private' ? 'Private' : 'Public'}</strong></div>
        <div class="info-item"><span>Members</span><strong data-slot="group-member-count">${members.length}</strong></div>
        <div class="info-item"><span>Your role</span><strong>${esc(selected.role || 'visitor')}</strong></div>
      </div>
      <h3 style="margin-top:18px;font-size:18px">Agents</h3>
      <div class="member-list" data-slot="paired-agents">${agents.map((a) => `<div class="member"><span class="member-main"><span class="avatar">${esc(initials(a.name))}</span><span>${esc(a.name)}</span></span><span class="badge">paired</span></div>`).join('') || '<p class="group-meta">No agents in this group yet.</p>'}</div>
      <h3 style="margin-top:18px;font-size:18px">Members</h3>
      <div class="member-list" data-slot="member-list">${members.map((m) => `<div class="member"><span class="member-main"><span class="avatar">${esc(initials(m.display_name || m.username))}</span><span>${esc(m.display_name || m.username)}</span></span>${m.role === 'admin' ? '<span class="badge">admin</span>' : ''}</div>`).join('')}</div>
    </div>`;
    $('shareBtn').onclick = async () => {
      await navigator.clipboard.writeText(`${location.origin}/home#g/${selected.slug}`).catch(() => {});
      $('shareBtn').textContent = 'Link copied';
      setTimeout(() => { $('shareBtn').textContent = 'Share group'; }, 1500);
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
  }

  // --- composer ----------------------------------------------------------------

  function setupComposer() {
    const composer = $('composer');
    composer.classList.add('active');
    // Attachments aren't supported by the backend yet — hide, don't fake.
    $('fileButton').style.display = 'none';
    $('fileName').style.display = 'none';
    const cpToggle = $('checkpointToggle').closest('label');
    cpToggle.style.display = selected.role === 'admin' ? '' : 'none';
    if (!selected.role) {
      $('postText').placeholder = 'Join the group to post.';
      $('postText').disabled = true;
      return;
    }
    $('postText').disabled = false;
    $('postText').placeholder = 'Write a post, checkpoint, question, or instruction for this group...';
    composer.onsubmit = async (e) => {
      e.preventDefault();
      const text = $('postText').value.trim();
      if (!text) return;
      try {
        const { message } = await BH.api(`/groups/${selected.slug}/messages`, {
          method: 'POST',
          body: JSON.stringify({ text, kind: $('checkpointToggle').checked ? 'checkpoint' : 'message' }),
        });
        $('postText').value = '';
        $('checkpointToggle').checked = false;
        appendMessages([message]);
      } catch (err) { alert(err.message); }
    };
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
