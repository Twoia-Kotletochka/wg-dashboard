const crypto = require('crypto');

const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function parseCookies(header) {
  return String(header || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const index = part.indexOf('=');
      if (index === -1) return cookies;
      const name = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      if (name) {
        try {
          cookies[name] = decodeURIComponent(value);
        } catch {
          cookies[name] = value;
        }
      }
      return cookies;
    }, {});
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, options.maxAge)}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  return parts.join('; ');
}

function createSessionStore({ ttlMs = DEFAULT_SESSION_TTL_MS, now = () => Date.now() } = {}) {
  const sessions = new Map();

  function prune(nowMs = now()) {
    for (const [token, session] of sessions) {
      if (session.expiresAt <= nowMs) sessions.delete(token);
    }
  }

  function create(user) {
    prune();
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = now() + ttlMs;
    sessions.set(token, { user, expiresAt });
    return { token, expiresAt };
  }

  function verify(token) {
    if (!token) return false;
    const session = sessions.get(token);
    if (!session) return false;
    if (session.expiresAt <= now()) {
      sessions.delete(token);
      return false;
    }
    return true;
  }

  function destroy(token) {
    if (token) sessions.delete(token);
  }

  return {
    create,
    destroy,
    prune,
    ttlMs,
    verify,
  };
}

module.exports = {
  DEFAULT_SESSION_TTL_MS,
  createSessionStore,
  parseCookies,
  serializeCookie,
};
