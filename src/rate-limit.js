// Fixed-window rate limiting for the auth endpoints. No dependencies.
//
// Two deliberate choices:
//
//   1. Login limits count FAILURES, not requests. A legitimate user signing in
//      repeatedly is never punished, while a password guesser is stopped after
//      a handful of misses. The route decides what counts, via req.rateLimit.
//   2. Counters live in memory. The service is pinned to a single instance by
//      its SQLite disk, so one process sees every attempt. If this ever scales
//      horizontally, this must move to shared storage or it becomes per-instance
//      and the effective limit multiplies by the instance count.
//
// State is swept on a timer so an attacker cycling usernames cannot grow the
// map without bound.

const MINUTE = 60 * 1000;

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export const LOGIN_MAX_FAILURES = envInt('LOGIN_MAX_FAILURES', 5);
export const LOGIN_WINDOW_MS = envInt('LOGIN_WINDOW_MS', 15 * MINUTE);
export const LOGIN_IP_MAX_FAILURES = envInt('LOGIN_IP_MAX_FAILURES', 60);
export const REGISTER_MAX = envInt('REGISTER_MAX', 10);
export const REGISTER_WINDOW_MS = envInt('REGISTER_WINDOW_MS', 60 * MINUTE);

export function createRateLimiter({ windowMs, max, key, countAllRequests = false }) {
  /** @type {Map<string, {count: number, resetAt: number}>} */
  const hits = new Map();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, windowMs);
  // Never hold the process open just to expire counters.
  sweep.unref?.();

  return function rateLimit(req, res, next) {
    const k = key(req);
    if (!k) return next();

    const now = Date.now();
    let entry = hits.get(k);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(k, entry);
    }

    if (entry.count >= max) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.set('Retry-After', String(retryAfter));
      // Identical response whether or not the account exists, so a lockout
      // cannot be used to probe for valid usernames.
      return res.status(429).json({
        error: 'too many attempts — try again later',
        retryAfterSeconds: retryAfter,
      });
    }

    if (countAllRequests) entry.count += 1;
    req.rateLimit = req.rateLimit ?? { consume: [], reset: [] };
    req.rateLimit.consume.push(() => { entry.count += 1; });
    req.rateLimit.reset.push(() => { hits.delete(k); });
    next();
  };
}

/** Call from a route when an attempt failed. */
export function consumeFailure(req) {
  req.rateLimit?.consume.forEach((fn) => fn());
}

/** Call from a route when an attempt succeeded, clearing the user's counters. */
export function resetOnSuccess(req) {
  req.rateLimit?.reset.forEach((fn) => fn());
}

/**
 * Client address. Behind Render the socket address is the load balancer, so
 * Express must be told to trust the proxy for req.ip to be the real client —
 * see `app.set('trust proxy', ...)` in server.js. Without that, every request
 * shares one key and the per-IP limit would lock out the whole world at once.
 */
export function ipKey(prefix) {
  return (req) => `${prefix}:${req.ip || 'unknown'}`;
}

export function usernameKey(prefix) {
  return (req) => {
    const u = String(req.body?.username || '').trim().toLowerCase();
    return u ? `${prefix}:${u}` : null;
  };
}
