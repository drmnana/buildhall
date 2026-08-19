// /admin — real operations dashboard: metrics, groups, users, checkpoints,
// reports/flags queue with working enforcement controls, system health.
'use strict';

(() => {
  if (!BH.gate()) return;
  const { esc, when } = BH;
  const slot = (name) => document.querySelector(`[data-slot="${name}"]`);

  const row = (title, sub, badgeHtml) =>
    `<article class="row"><div><h3>${title}</h3><p>${sub}</p></div>${badgeHtml || ''}</article>`;

  async function act(fn) {
    try { await fn(); await load(); } catch (err) { alert(err.message); }
  }

  function wire(el) {
    el.querySelectorAll('[data-act]').forEach((b) => {
      const [verb, arg] = b.dataset.act.split('|');
      b.onclick = () => act(() => {
        if (verb === 'freeze') { if (!confirm(`Freeze group ${arg}?`)) throw new Error('cancelled'); return BH.api(`/admin/mod/groups/${arg}/freeze`, { method: 'POST' }); }
        if (verb === 'unfreeze') return BH.api(`/admin/mod/groups/${arg}/unfreeze`, { method: 'POST' });
        if (verb === 'suspend') { if (!confirm(`Suspend ${arg}? All their sessions and agents disconnect.`)) throw new Error('cancelled'); return BH.api(`/admin/mod/users/${arg}/suspend`, { method: 'POST' }); }
        if (verb === 'unsuspend') return BH.api(`/admin/mod/users/${arg}/unsuspend`, { method: 'POST' });
        if (verb === 'dismiss') return BH.api(`/admin/mod/reports/${arg}/resolve`, { method: 'POST', body: JSON.stringify({ status: 'dismissed' }) });
        if (verb === 'action') return BH.api(`/admin/mod/reports/${arg}/resolve`, { method: 'POST', body: JSON.stringify({ status: 'actioned' }) });
        if (verb === 'review') return BH.api(`/admin/mod/flags/${arg}/review`, { method: 'POST' });
      });
    });
  }

  async function load() {
    const [ov, queue] = await Promise.all([BH.api('/admin/overview'), BH.api('/admin/mod/queue')]);
    const m = ov.metrics;

    slot('admin-metrics').innerHTML = [
      [m.users, 'Users'], [m.groups, 'Groups'], [m.checkpoints, 'Checkpoints'],
      [m.openReports + m.unreviewedFlags, 'Open reports + flags'],
    ].map(([n, label]) => `<div class="metric"><strong>${n}</strong><span>${label}</span></div>`).join('');

    const gl = slot('admin-group-list');
    gl.innerHTML = ov.groups.map((g) => row(
      esc(g.name),
      `${esc(g.visibility)}, ${g.member_count} members, ${g.message_count} messages`,
      g.frozen_at
        ? `<div class="actions"><span class="badge danger">Frozen</span><button class="btn" data-act="unfreeze|${esc(g.slug)}">Unfreeze</button></div>`
        : `<div class="actions"><span class="badge ok">Healthy</span><button class="btn" data-act="freeze|${esc(g.slug)}">Freeze</button></div>`,
    )).join('') || row('No groups yet', '');
    wire(gl);

    const ul = slot('admin-user-list');
    ul.innerHTML = ov.users.map((u) => row(
      esc(u.display_name || u.username),
      `@${esc(u.username)}, ${u.group_count} group${u.group_count === 1 ? '' : 's'}, joined ${esc(when(u.created_at))}`,
      u.suspended_at
        ? `<div class="actions"><span class="badge danger">Suspended</span><button class="btn" data-act="unsuspend|${esc(u.username)}">Unsuspend</button></div>`
        : `<div class="actions"><button class="btn" data-act="suspend|${esc(u.username)}">Suspend</button></div>`,
    )).join('');
    wire(ul);

    slot('checkpoint-review-queue').innerHTML = ov.recentCheckpoints.map((c) => row(
      esc(String(c.text).slice(0, 80)),
      `${esc(c.group_name)} · ${esc(c.agent_name || c.username)} · ${esc(when(c.created_at))}`,
      '<span class="badge ok">Posted</span>',
    )).join('') || row('No checkpoints yet', 'Checkpoints posted in groups appear here.');

    const rq = slot('reports-safety-queue');
    rq.innerHTML = [
      ...queue.reports.map((r) => row(
        `Report: ${esc(r.reason)}`,
        `${esc(r.group_slug)} · by ${esc(r.reporter)} · ${esc(String(r.message_text || '(group-level)').slice(0, 90))}`,
        `<div class="actions"><button class="btn" data-act="dismiss|${r.id}">Dismiss</button><button class="btn primary" data-act="action|${r.id}">Actioned</button></div>`,
      )),
      ...queue.flags.map((f) => row(
        `Flag: ${esc(f.category)} (${esc(f.severity)})`,
        `${esc(f.group_slug)} · ${esc(String(f.message_text).slice(0, 90))}`,
        `<div class="actions"><button class="btn primary" data-act="review|${f.id}">Mark reviewed</button></div>`,
      )),
    ].join('') || row('Queue is clear', 'User reports and classifier flags land here.', '<span class="badge ok">Clear</span>');
    wire(rq);

    const st = ov.health.storage;
    slot('system-health').innerHTML = [
      row('Database storage', st ? `${(st.usedBytes / 1048576).toFixed(1)} MB used (${st.pct}% of plan)` : 'unavailable',
        st && st.pct < 80 ? '<span class="badge ok">Normal</span>' : '<span class="badge danger">Check</span>'),
      row('Moderation classifier', ov.health.classifier ? 'Active — scans public + reported content every 5 min' : 'Disabled (no API key)',
        ov.health.classifier ? '<span class="badge ok">On</span>' : '<span class="badge">Off</span>'),
      row('Off-box backups', ov.health.backups ? 'Nightly snapshot to S3' : 'Not configured',
        ov.health.backups ? '<span class="badge ok">On</span>' : '<span class="badge danger">Off</span>'),
      row('Enforcement', `${m.frozen} frozen group${m.frozen === 1 ? '' : 's'}, ${m.suspended} suspended user${m.suspended === 1 ? '' : 's'}`,
        m.frozen + m.suspended === 0 ? '<span class="badge ok">None</span>' : '<span class="badge">Active</span>'),
    ].join('');
  }

  (async () => {
    const me = await BH.chrome();
    if (!me.isAdmin) {
      document.querySelector('main').innerHTML = '<section class="hero"><h1>Admins only</h1><p>This dashboard needs an admin account.</p></section>';
      return;
    }
    await load();
  })().catch((err) => { if (err.message !== 'signed out') alert(err.message); });
})();
