// Google + GitHub OAuth 2.0 (authorization-code flow), hand-rolled on Node's
// built-in fetch + crypto — no passport/openid-client dependency.
//
// CSRF: the `state` parameter is an HMAC-signed, short-lived token (nonce +
// timestamp). We verify the signature and freshness on the callback, so an
// attacker can't forge a state. Config comes from env; a provider is simply
// "not configured" (its button 404s) until its client id/secret are set.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE = (process.env.APP_BASE_URL || 'https://buildhall.ai').replace(/\/$/, '');
const STATE_SECRET = process.env.OAUTH_STATE_SECRET || process.env.BACKUP_TRIGGER_TOKEN || 'dev-only-insecure-state-secret';
const STATE_TTL_MS = 10 * 60 * 1000; // an auth round-trip should take well under 10 min

const PROVIDERS = {
  google: {
    clientId: () => process.env.GOOGLE_CLIENT_ID,
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    // Google returns the profile from the OIDC userinfo endpoint.
    async profile(accessToken) {
      const r = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!r.ok) throw new Error(`google userinfo ${r.status}`);
      const u = await r.json();
      return { providerUserId: String(u.sub), email: u.email, emailVerified: !!u.email_verified, name: u.name || u.given_name };
    },
  },
  github: {
    clientId: () => process.env.GITHUB_CLIENT_ID,
    clientSecret: () => process.env.GITHUB_CLIENT_SECRET,
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scope: 'read:user user:email',
    async profile(accessToken) {
      const headers = { authorization: `Bearer ${accessToken}`, accept: 'application/vnd.github+json', 'user-agent': 'BuildHall' };
      const ur = await fetch('https://api.github.com/user', { headers });
      if (!ur.ok) throw new Error(`github user ${ur.status}`);
      const u = await ur.json();
      // GitHub may hide the public email; fetch the verified primary explicitly.
      let email = u.email;
      let emailVerified = false;
      const er = await fetch('https://api.github.com/user/emails', { headers });
      if (er.ok) {
        const emails = await er.json();
        const primary = emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified);
        if (primary) { email = primary.email; emailVerified = true; }
      }
      return { providerUserId: String(u.id), email, emailVerified, name: u.name || u.login };
    },
  },
};

export function providerConfigured(provider) {
  const p = PROVIDERS[provider];
  return !!(p && p.clientId() && p.clientSecret());
}

export function redirectUri(provider) {
  return `${BASE}/api/auth/${provider}/callback`;
}

// --- signed state (CSRF) ---------------------------------------------------
function signState(provider) {
  const payload = `${provider}.${Date.now()}.${randomBytes(12).toString('hex')}`;
  const sig = createHmac('sha256', STATE_SECRET).update(payload).digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${sig}`;
}

export function verifyState(provider, state) {
  if (!state || typeof state !== 'string') return false;
  const [b64, sig] = state.split('.');
  if (!b64 || !sig) return false;
  const payload = Buffer.from(b64, 'base64url').toString('utf8');
  const expected = createHmac('sha256', STATE_SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig); const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const [p, tsStr] = payload.split('.');
  const ts = Number(tsStr);
  return p === provider && Number.isFinite(ts) && Date.now() - ts < STATE_TTL_MS;
}

// The URL to send the browser to, to begin login with this provider.
export function authorizeUrl(provider) {
  const p = PROVIDERS[provider];
  const params = new URLSearchParams({
    client_id: p.clientId(),
    redirect_uri: redirectUri(provider),
    response_type: 'code',
    scope: p.scope,
    state: signState(provider),
  });
  if (provider === 'google') { params.set('access_type', 'online'); params.set('prompt', 'select_account'); }
  return `${p.authUrl}?${params.toString()}`;
}

// Exchange the authorization code for the user's profile.
export async function exchangeCode(provider, code) {
  const p = PROVIDERS[provider];
  const body = new URLSearchParams({
    client_id: p.clientId(),
    client_secret: p.clientSecret(),
    code,
    redirect_uri: redirectUri(provider),
    grant_type: 'authorization_code',
  });
  const r = await fetch(p.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
  });
  if (!r.ok) throw new Error(`${provider} token ${r.status}`);
  const tok = await r.json();
  if (!tok.access_token) throw new Error(`${provider} token: no access_token`);
  return p.profile(tok.access_token);
}
