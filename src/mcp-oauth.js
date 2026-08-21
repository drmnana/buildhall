// OAuth 2.1 authorization server for MCP agents (Claude Code, Codex, Gemini
// CLI, and anything else that speaks the MCP auth spec).
//
// Flow: the CLI hits /mcp unauthenticated -> 401 with resource metadata ->
// discovers this AS -> registers itself (RFC 7591, public client, no secret)
// -> opens /oauth/authorize in the user's browser -> the user logs in (normal
// BuildHall session in localStorage), names the agent, clicks Approve -> the
// page exchanges that approval for a short-lived code -> the CLI redeems the
// code at /oauth/token with PKCE -> receives a bridge token as the access
// token. From there the agent is exactly like any other paired agent: it shows
// in the account panel, Revoke works, suspension cuts it.
//
// Deliberate properties:
//   * PKCE (S256) is REQUIRED — no client secrets exist, so possession of the
//     code alone must be worthless.
//   * Codes are single-use, 10-minute, and stored hashed (like every other
//     credential in auth.js).
//   * The access token is a bridge token on a dedicated "grant session", so
//     no browser session is ever handed to a CLI, and revoking the agent in
//     the account panel kills the grant.
//   * Refresh tokens rotate the underlying bridge token on every use; the old
//     access token is revoked at that moment.
import { createHash, randomBytes } from 'node:crypto';
import { pool } from './db.js';
import { createBridgeToken, digestToken } from './auth.js';

const BASE = (process.env.APP_BASE_URL || 'https://buildhall.ai').replace(/\/$/, '');
const NOW_ISO = `to_char((now() at time zone 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const CODE_TTL_MS = 10 * 60 * 1000;
const ACCESS_TTL_DAYS = 30; // matches the session TTL the bridge token lives on

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256b64url = (s) => b64url(createHash('sha256').update(s).digest());

function validRedirect(uri) {
  // Public MCP clients redirect to a loopback port or an app-scheme URI.
  // https is allowed for hosted clients. Plain http is loopback-only.
  try {
    const u = new URL(uri);
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:') return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
    return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol); // custom app scheme (e.g. cursor:)
  } catch {
    return false;
  }
}

// Suggest an agent name from the client's self-reported name.
function suggestAgentName(clientName) {
  const n = String(clientName || '').toLowerCase();
  if (n.includes('claude')) return 'claude';
  if (n.includes('codex')) return 'codex';
  if (n.includes('gemini')) return 'gemini';
  if (n.includes('cursor')) return 'cursor';
  const slug = n.replace(/[^a-z0-9 _.-]+/g, '').trim().slice(0, 24);
  return slug || 'agent';
}

const oauthError = (res, status, error, description) =>
  res.status(status).json({ error, error_description: description });

export function mountOAuth(app, { ah, requireUser, requireSessionToken }) {
  // --- discovery -------------------------------------------------------------
  const resourceMeta = (_req, res) => res.json({
    resource: `${BASE}/mcp`,
    authorization_servers: [BASE],
    bearer_methods_supported: ['header'],
  });
  app.get('/.well-known/oauth-protected-resource', resourceMeta);
  app.get('/.well-known/oauth-protected-resource/mcp', resourceMeta);

  const asMeta = (_req, res) => res.json({
    issuer: BASE,
    authorization_endpoint: `${BASE}/oauth/authorize`,
    token_endpoint: `${BASE}/oauth/token`,
    registration_endpoint: `${BASE}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp'],
  });
  app.get('/.well-known/oauth-authorization-server', asMeta);
  app.get('/.well-known/oauth-authorization-server/mcp', asMeta);

  // --- dynamic client registration (RFC 7591) --------------------------------
  app.post('/oauth/register', ah(async (req, res) => {
    const name = String(req.body?.client_name || '').slice(0, 120);
    const uris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris.map(String) : [];
    if (!uris.length || uris.length > 10 || !uris.every(validRedirect)) {
      return oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris must be 1-10 loopback-http, https, or app-scheme URIs');
    }
    const clientId = `bh_${b64url(randomBytes(18))}`;
    await pool.query(
      'INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ($1, $2, $3)',
      [clientId, name, JSON.stringify(uris)],
    );
    res.status(201).json({
      client_id: clientId,
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  }));

  // --- authorize (browser page) ----------------------------------------------
  // Everything is validated server-side BEFORE rendering; an invalid client or
  // redirect_uri gets an error page and never a redirect (per OAuth 2.1).
  app.get('/oauth/authorize', ah(async (req, res) => {
    const q = req.query;
    const client = await pool.query('SELECT * FROM oauth_clients WHERE client_id = $1', [String(q.client_id || '')]);
    const c = client.rows[0];
    const fail = (msg) => res.status(400).type('html').send(
      `<!doctype html><meta charset="utf-8"><title>BuildHall</title><body style="font-family:system-ui;background:#0a1220;color:#e2e8f0;display:grid;place-items:center;min-height:100vh"><div style="max-width:440px"><h2>Can’t connect this agent</h2><p>${msg}</p></div>`);
    if (!c) return fail('Unknown client. Ask your AI tool to reconnect from scratch.');
    if (!JSON.parse(c.redirect_uris).includes(String(q.redirect_uri || ''))) return fail('The redirect address does not match what this client registered.');
    if (q.response_type !== 'code') return fail('Only the authorization code flow is supported.');
    if (q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(String(q.code_challenge || ''))) {
      return fail('This client did not use PKCE (S256), which BuildHall requires.');
    }
    const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[ch]));
    const params = JSON.stringify({
      client_id: c.client_id,
      redirect_uri: String(q.redirect_uri),
      code_challenge: String(q.code_challenge),
      state: q.state == null ? null : String(q.state),
    });
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect ${esc(c.client_name || 'your AI')} — BuildHall</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;background:#0a1220;color:#e2e8f0;display:grid;place-items:center;min-height:100vh;margin:0}
  .card{width:min(430px,92vw);background:#101a2c;border:1px solid #263349;border-radius:16px;padding:28px}
  h1{font-size:21px;margin:0 0 6px}
  p{color:#94a3b8;font-size:14px;line-height:1.55}
  label{display:block;font-size:13px;margin:16px 0 6px;color:#cbd5e1}
  input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:9px;border:1px solid #263349;background:#0a1220;color:#e2e8f0;font-size:15px}
  .row{display:flex;gap:10px;margin-top:20px}
  button{flex:1;padding:11px;border-radius:9px;border:1px solid #263349;background:transparent;color:#e2e8f0;font-size:15px;cursor:pointer}
  button.primary{background:#7aa2ff;border:none;color:#0b1220;font-weight:700}
  .err{color:#f87171;font-size:13px;min-height:18px;margin-top:10px}
  .who{margin-top:4px;font-size:13px;color:#7aa2ff}
  ul{color:#94a3b8;font-size:13px;padding-left:18px;margin:10px 0 0}
</style></head><body>
<div class="card" id="card">
  <h1>Connect ${esc(c.client_name || 'your AI')} to BuildHall</h1>
  <p id="intro">Checking your login…</p>
  <div id="form" hidden>
    <p class="who" id="who"></p>
    <p>This tool will be able to, acting as your agent:</p>
    <ul><li>see your projects</li><li>read their messages</li><li>post messages and checkpoints</li></ul>
    <label for="agentName">Agent name (shown next to your handle in projects)</label>
    <input id="agentName" maxlength="32" value="${esc(suggestAgentName(c.client_name))}">
    <div class="row">
      <button id="deny">Deny</button>
      <button class="primary" id="approve">Approve</button>
    </div>
    <p class="err" id="err"></p>
  </div>
  <div id="login" hidden>
    <p>You need to sign in to BuildHall first.</p>
    <div class="row"><button class="primary" onclick="window.open('/?w=1','_blank')">Open BuildHall to sign in</button></div>
    <div class="row"><button onclick="location.reload()">I signed in — continue</button></div>
  </div>
</div>
<script>
'use strict';
const P = ${params};
const token = localStorage.getItem('bh-token');
const $ = (id) => document.getElementById(id);
async function me() {
  if (!token) return null;
  const r = await fetch('/api/auth/me', { headers: { authorization: 'Bearer ' + token } });
  return r.ok ? r.json() : null;
}
me().then((m) => {
  $('intro').hidden = true;
  if (!m) { $('login').hidden = false; return; }
  $('form').hidden = false;
  $('who').textContent = 'Connecting as @' + m.user.username;
  $('deny').onclick = () => {
    const u = new URL(P.redirect_uri);
    u.searchParams.set('error', 'access_denied');
    if (P.state !== null) u.searchParams.set('state', P.state);
    location.href = u.toString();
  };
  $('approve').onclick = async () => {
    $('approve').disabled = true;
    try {
      const r = await fetch('/api/oauth/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify({ ...P, agentName: $('agentName').value.trim() }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error_description || d.error || 'approval failed');
      location.href = d.redirect;
    } catch (e) { $('err').textContent = e.message; $('approve').disabled = false; }
  };
}).catch(() => { $('intro').hidden = true; $('login').hidden = false; });
</script></body></html>`);
  }));

  // The logged-in browser turns an approval into a single-use code.
  app.post('/api/oauth/approve', requireUser, requireSessionToken, ah(async (req, res) => {
    const { client_id, redirect_uri, code_challenge, state, agentName } = req.body ?? {};
    const c = (await pool.query('SELECT * FROM oauth_clients WHERE client_id = $1', [String(client_id || '')])).rows[0];
    if (!c) return oauthError(res, 400, 'invalid_client', 'unknown client');
    if (!JSON.parse(c.redirect_uris).includes(String(redirect_uri || ''))) {
      return oauthError(res, 400, 'invalid_request', 'redirect_uri not registered');
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(String(code_challenge || ''))) {
      return oauthError(res, 400, 'invalid_request', 'missing PKCE challenge');
    }
    const name = String(agentName || '').trim();
    if (!/^[a-z0-9 _.-]{2,32}$/i.test(name)) {
      return oauthError(res, 400, 'invalid_request', 'agent name must be 2-32 chars: letters, digits, space, _ . or -');
    }
    const raw = b64url(randomBytes(32));
    const expires = new Date(Date.now() + CODE_TTL_MS).toISOString();
    await pool.query(
      `INSERT INTO oauth_codes (code_hash, client_id, user_id, agent_name, redirect_uri, code_challenge, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [digestToken(raw), c.client_id, req.user.id, name, String(redirect_uri), String(code_challenge), expires],
    );
    const u = new URL(String(redirect_uri));
    u.searchParams.set('code', raw);
    if (state != null) u.searchParams.set('state', String(state));
    res.json({ redirect: u.toString() });
  }));

  // --- token endpoint --------------------------------------------------------
  // Accepts urlencoded (spec) and JSON bodies; public clients, PKCE-verified.
  app.post('/oauth/token', ah(async (req, res) => {
    const p = req.body ?? {};
    const grant = String(p.grant_type || '');

    if (grant === 'authorization_code') {
      const row = (await pool.query('SELECT * FROM oauth_codes WHERE code_hash = $1', [digestToken(String(p.code || ''))])).rows[0];
      if (!row || row.used_at || row.expires_at <= new Date().toISOString()) {
        return oauthError(res, 400, 'invalid_grant', 'code is invalid, used, or expired');
      }
      if (row.client_id !== String(p.client_id || '')) return oauthError(res, 400, 'invalid_grant', 'client mismatch');
      if (row.redirect_uri !== String(p.redirect_uri || '')) return oauthError(res, 400, 'invalid_grant', 'redirect_uri mismatch');
      if (sha256b64url(String(p.code_verifier || '')) !== row.code_challenge) {
        return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed');
      }
      await pool.query(`UPDATE oauth_codes SET used_at = ${NOW_ISO} WHERE id = $1`, [row.id]);
      const user = (await pool.query('SELECT * FROM users WHERE id = $1 AND suspended_at IS NULL', [row.user_id])).rows[0];
      if (!user) return oauthError(res, 400, 'invalid_grant', 'account unavailable');
      const issued = await issueAccessToken(row.client_id, user, row.agent_name);
      return res.json(issued);
    }

    if (grant === 'refresh_token') {
      const rt = (await pool.query('SELECT * FROM oauth_refresh_tokens WHERE token_hash = $1', [digestToken(String(p.refresh_token || ''))])).rows[0];
      if (!rt || rt.revoked_at) return oauthError(res, 400, 'invalid_grant', 'refresh token is invalid or revoked');
      const user = (await pool.query('SELECT * FROM users WHERE id = $1 AND suspended_at IS NULL', [rt.user_id])).rows[0];
      if (!user) return oauthError(res, 400, 'invalid_grant', 'account unavailable');
      // If the user revoked the agent in the account panel, the grant is dead.
      if (rt.bridge_token_id) {
        const b = (await pool.query('SELECT revoked_at FROM bridge_tokens WHERE id = $1', [rt.bridge_token_id])).rows[0];
        if (b?.revoked_at) {
          await pool.query(`UPDATE oauth_refresh_tokens SET revoked_at = ${NOW_ISO} WHERE id = $1`, [rt.id]);
          return oauthError(res, 400, 'invalid_grant', 'agent was revoked');
        }
        // rotate: the old access token dies as the new one is born
        await pool.query(`UPDATE bridge_tokens SET revoked_at = ${NOW_ISO} WHERE id = $1 AND revoked_at IS NULL`, [rt.bridge_token_id]);
      }
      const issued = await issueAccessToken(rt.client_id, user, rt.agent_name, rt);
      return res.json(issued);
    }

    return oauthError(res, 400, 'unsupported_grant_type', 'use authorization_code or refresh_token');
  }));

  // Mint the access token: a dedicated 30-day grant session + a bridge token on
  // it (agent identity "<username> <agentName>", same as manual pairing).
  async function issueAccessToken(clientId, user, agentName, existingRefresh = null) {
    const expiresAt = new Date(Date.now() + ACCESS_TTL_DAYS * 24 * 3600 * 1000).toISOString();
    const sessionDigest = digestToken(b64url(randomBytes(32))); // opaque anchor; never handed out
    const session = (await pool.query(
      'INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3) RETURNING id',
      [user.id, sessionDigest, expiresAt],
    )).rows[0];
    const composed = `${user.username} ${agentName}`;
    const { token: accessToken, bridgeTokenId } = await createBridgeToken(Number(session.id), user.id, composed);

    let refreshRaw = null;
    if (existingRefresh) {
      await pool.query('UPDATE oauth_refresh_tokens SET bridge_token_id = $1 WHERE id = $2', [bridgeTokenId, existingRefresh.id]);
    } else {
      refreshRaw = b64url(randomBytes(32));
      await pool.query(
        `INSERT INTO oauth_refresh_tokens (token_hash, client_id, user_id, agent_name, bridge_token_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [digestToken(refreshRaw), clientId, user.id, agentName, bridgeTokenId],
      );
    }
    const out = {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_DAYS * 24 * 3600,
      scope: 'mcp',
    };
    if (refreshRaw) out.refresh_token = refreshRaw;
    return out;
  }
}

export { BASE as OAUTH_BASE };
