const crypto = require('crypto');

function timingSafeEqualString(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseBasicAuth(header) {
  if (!header || !header.startsWith('Basic ')) return null;

  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator === -1) return null;
    return {
      user: decoded.slice(0, separator),
      pass: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

function verifyBasicAuth(header, expectedUser, expectedPass) {
  if (!expectedUser || !expectedPass) return false;
  const credentials = parseBasicAuth(header);
  if (!credentials) return false;

  return (
    timingSafeEqualString(credentials.user, expectedUser) &&
    timingSafeEqualString(credentials.pass, expectedPass)
  );
}

function createAuthMiddleware(config, options = {}) {
  return function requireAuth(req, res, next) {
    if (!config.adminUser || !config.adminPass) {
      return res.status(403).send('Access disabled: set ADMIN_USER and ADMIN_PASS in .env');
    }

    if (options.isSessionValid?.(req)) {
      return next();
    }

    if (verifyBasicAuth(req.headers.authorization || '', config.adminUser, config.adminPass)) {
      options.onBasicAuthSuccess?.(req, res);
      return next();
    }

    res.setHeader('WWW-Authenticate', 'Basic realm="WG Panel"');
    return res.status(401).send('Auth required');
  };
}

module.exports = {
  createAuthMiddleware,
  parseBasicAuth,
  verifyBasicAuth,
};
