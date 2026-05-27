require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const { createAuthMiddleware, verifyBasicAuth } = require('./src/auth');
const { loadConfig } = require('./src/config');
const { createSerialQueue } = require('./src/mutation-queue');
const { allowedIpMatches, normalizeIp, nextIpFromPeers, parseCidr } = require('./src/net');
const { createSessionStore, parseCookies, serializeCookie } = require('./src/session');
const { createStorage } = require('./src/storage');
const { createWireGuard } = require('./src/wireguard');

const SESSION_COOKIE = 'wg_dashboard_session';
const TRAFFIC_SYNC_INTERVAL_MS = 30_000;
const BLOCKED_ALLOWED_IP = '0.0.0.0/32';

const config = loadConfig(process.env, __dirname);
parseCidr(config.wgNet);
const sessions = createSessionStore();
const storage = createStorage(config.baseDir);
const wg = createWireGuard(config);

const app = express();
const routes = express.Router();
const server = http.createServer(app);
const io = new Server(server, {
  path: config.publicBasePath ? `${config.publicBasePath}/socket.io` : '/socket.io',
});
const runMutation = createSerialQueue();

function isSecureRequest(req) {
  return req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function sessionTokenFromHeader(cookieHeader) {
  return parseCookies(cookieHeader)[SESSION_COOKIE] || '';
}

function sessionTokenFromRequest(req) {
  return sessionTokenFromHeader(req.headers.cookie);
}

function sessionCookie(req, token, maxAge) {
  return serializeCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    maxAge,
    path: config.publicBasePath || '/',
    sameSite: 'Strict',
    secure: isSecureRequest(req),
  });
}

function issueSessionCookie(req, res) {
  const session = sessions.create(config.adminUser);
  res.setHeader('Set-Cookie', sessionCookie(req, session.token, Math.floor(sessions.ttlMs / 1000)));
}

function clearSessionCookie(req, res) {
  sessions.destroy(sessionTokenFromRequest(req));
  res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
}

function isRequestSessionValid(req) {
  return sessions.verify(sessionTokenFromRequest(req));
}

const requireAuth = createAuthMiddleware(config, {
  isSessionValid: isRequestSessionValid,
  onBasicAuthSuccess: issueSessionCookie,
});

function assertClientConfigReady() {
  if (!config.wgEndpoint) throw new Error('WG_ENDPOINT is required');
  try {
    wg.assertPublicKey(config.wgServerPub);
  } catch {
    throw new Error('WG_SERVER_PUB must be a valid WireGuard public key');
  }
}

if (config.autoStartWg) {
  assertClientConfigReady();
}

function requestIp(req) {
  return normalizeIp(req.socket?.remoteAddress || req.ip || '');
}

function socketIp(socket) {
  return normalizeIp(socket.handshake.address || socket.request?.socket?.remoteAddress || '');
}

function requireAllowedIp(req, res, next) {
  try {
    if (allowedIpMatches(requestIp(req), config.allowedIps, config.wgNet)) return next();
  } catch (error) {
    console.error('IP whitelist error:', error.message);
  }

  console.warn(`Access denied from ${requestIp(req)} -> ${req.method} ${req.url}`);
  return res.status(403).send('Forbidden');
}

function apiError(res, status, error, detail) {
  return res.status(status).json(detail ? { error, detail } : { error });
}

function safeBytes(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(number));
}

function boolValue(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function normalizeTrafficPeer(peer) {
  const normalized = { ...peer };
  let changed = false;

  function setDefault(field, value) {
    if (!(field in normalized)) {
      normalized[field] = value;
      changed = true;
    }
  }

  setDefault('traffic_limit_bytes', 0);
  setDefault('traffic_used_bytes', 0);
  setDefault('traffic_limit_enabled', false);
  setDefault('traffic_blocked', false);
  setDefault('traffic_reset_at', null);
  setDefault('traffic_updated_at', null);
  setDefault('traffic_last_runtime_bytes', 0);

  const numericFields = ['traffic_limit_bytes', 'traffic_used_bytes', 'traffic_last_runtime_bytes'];
  for (const field of numericFields) {
    const value = safeBytes(normalized[field]);
    if (value !== normalized[field]) {
      normalized[field] = value;
      changed = true;
    }
  }

  for (const field of ['traffic_limit_enabled', 'traffic_blocked']) {
    const value = boolValue(normalized[field]);
    if (value !== normalized[field]) {
      normalized[field] = value;
      changed = true;
    }
  }

  if (normalized.traffic_limit_bytes === 0 && normalized.traffic_limit_enabled) {
    normalized.traffic_limit_enabled = false;
    changed = true;
  }

  return { peer: normalized, changed };
}

function normalizeTrafficPeers(peers) {
  let changed = false;
  const normalized = (peers || []).map((peer) => {
    const result = normalizeTrafficPeer(peer);
    if (result.changed) changed = true;
    return result.peer;
  });
  return { peers: normalized, changed };
}

function migrateTrafficFields() {
  const result = normalizeTrafficPeers(storage.loadPeers());
  if (result.changed) storage.savePeers(result.peers);
}

function parseTrafficLimit(body = {}) {
  const enabled = boolValue(body.traffic_limit_enabled);
  const bytes = safeBytes(body.traffic_limit_bytes);
  if (enabled && bytes <= 0) {
    const error = new Error('bad_limit');
    error.status = 400;
    throw error;
  }
  return {
    traffic_limit_enabled: enabled,
    traffic_limit_bytes: enabled ? bytes : 0,
  };
}

function runtimeTrafficTotal(stat) {
  if (!stat) return null;
  return safeBytes(stat.rx) + safeBytes(stat.tx);
}

function trafficLimitPercent(peer) {
  if (!peer.traffic_limit_enabled || peer.traffic_limit_bytes <= 0) return null;
  return Math.min(100, (peer.traffic_used_bytes / peer.traffic_limit_bytes) * 100);
}

function applyPeerAccess(peer, { strict = true } = {}) {
  const blocked = Boolean(peer.blocked || peer.traffic_blocked);
  try {
    if (blocked) {
      wg.blockPeer(peer.pub);
      wg.updatePeerAllowedIp(peer.pub, BLOCKED_ALLOWED_IP);
    } else {
      wg.unblockPeer(peer.pub, peer.ip);
      wg.updatePeerAllowedIp(peer.pub, `${peer.ip}/32`);
    }
  } catch (error) {
    console.error(`Peer access update failed for ${peer.name || peer.pub}:`, error.message || error);
    if (strict) throw error;
  }
}

function enforceTrafficLimit(peer) {
  if (!peer.traffic_limit_enabled || peer.traffic_limit_bytes <= 0) return false;
  if (peer.traffic_used_bytes < peer.traffic_limit_bytes) return false;

  if (!peer.traffic_blocked) {
    peer.traffic_blocked = true;
    peer.traffic_updated_at = Date.now();
    console.warn(`Traffic limit reached for ${peer.name}: ${peer.traffic_used_bytes}/${peer.traffic_limit_bytes}`);
  }
  applyPeerAccess(peer, { strict: false });
  return true;
}

function syncTrafficUsage({ enforceLimits = true } = {}) {
  const dump = wg.dump();
  const result = normalizeTrafficPeers(storage.loadPeers());
  const { peers } = result;
  let changed = result.changed;
  const now = Date.now();

  for (const peer of peers) {
    const runtimeTotal = runtimeTrafficTotal(dump.get(peer.pub));
    if (runtimeTotal !== null) {
      const lastRuntime = safeBytes(peer.traffic_last_runtime_bytes);
      const delta = runtimeTotal >= lastRuntime ? runtimeTotal - lastRuntime : runtimeTotal;
      if (delta > 0) peer.traffic_used_bytes = safeBytes(peer.traffic_used_bytes + delta);
      if (runtimeTotal !== lastRuntime || delta > 0) {
        peer.traffic_last_runtime_bytes = runtimeTotal;
        peer.traffic_updated_at = now;
        changed = true;
      }
    }

    if (enforceLimits && enforceTrafficLimit(peer)) changed = true;
  }

  if (changed) storage.savePeers(peers);
  return { peers, dump, changed };
}

function peerWithTrafficStats(peer, stat = {}) {
  return {
    ...peer,
    ...(stat || {}),
    allowed: `${peer.ip}/32`,
    traffic_effective_blocked: Boolean(peer.blocked || peer.traffic_blocked),
    traffic_limit_percent: trafficLimitPercent(peer),
  };
}

function peerByPublicKey(pub, peers = storage.loadPeers()) {
  return normalizeTrafficPeers(peers).peers.find((peer) => peer.pub === pub);
}

function isPublicKey(pub) {
  try {
    wg.assertPublicKey(pub);
    return true;
  } catch {
    return false;
  }
}

function peersWithStats() {
  const dump = wg.dump();
  return normalizeTrafficPeers(storage.loadPeers()).peers.map((peer) => (
    peerWithTrafficStats(peer, dump.get(peer.pub))
  ));
}

function buildClientConfig({ privateKey, ip, presharedKey }) {
  assertClientConfigReady();
  return `[Interface]
PrivateKey = ${privateKey}
Address = ${ip}/32
DNS = ${config.wgDns}

[Peer]
PublicKey = ${config.wgServerPub}
PresharedKey = ${presharedKey}
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = ${config.wgEndpoint}
`;
}

function securityHeaders(_req, res, next) {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'self'",
      "connect-src 'self' ws: wss:",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "img-src 'self' blob: data:",
      "object-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
    ].join('; ')
  );
  next();
}

function mutate(res, error, fn) {
  return runMutation(fn).catch((caught) => (
    apiError(res, 500, error, String(caught.message || caught))
  ));
}

function safeBroadcast(delayMs = 0) {
  const send = () => {
    try {
      broadcast();
    } catch (error) {
      console.error('Broadcast failed:', error.message || error);
    }
  };

  if (delayMs > 0) setTimeout(send, delayMs);
  else send();
}

app.use(securityHeaders);
app.use(requireAllowedIp);
if (config.publicBasePath) {
  app.use((req, res, next) => {
    if (req.path === config.publicBasePath) return res.redirect(308, `${config.publicBasePath}/`);
    return next();
  });
}

migrateTrafficFields();

routes.use(express.json({ limit: '64kb' }));
routes.use(express.static(config.publicDir));

routes.post('/api/logout', (req, res) => {
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

routes.get('/api/status', requireAuth, (_req, res) => {
  res.json({ iface: wg.status(), ifname: config.wgIf });
});

routes.get('/api/peers', requireAuth, (_req, res) => {
  return mutate(res, 'traffic_sync_failed', () => {
    const { peers, dump } = syncTrafficUsage();
    res.json(peers.map((peer) => peerWithTrafficStats(peer, dump.get(peer.pub))));
  });
});

routes.post('/api/add', requireAuth, (req, res) => {
  const name = String(req.body?.name || '').trim();
  try {
    wg.assertClientName(name);
  } catch {
    return apiError(res, 400, 'bad_name');
  }

  let trafficLimit;
  try {
    trafficLimit = parseTrafficLimit(req.body || {});
  } catch (error) {
    return apiError(res, error.status || 400, error.message || 'bad_limit');
  }

  return mutate(res, 'add_failed', () => {
    assertClientConfigReady();
    const peers = storage.loadPeers();
    if (peers.some((peer) => peer.name === name)) return apiError(res, 400, 'exists');

    let pub = '';
    let runtimeAdded = false;
    let peerBlockAdded = false;
    let configPath = '';
    try {
      const privateKey = wg.generatePrivateKey();
      pub = wg.derivePublicKey(privateKey);
      const ip = nextIpFromPeers(config.wgNet, peers);
      const presharedKey = wg.generatePresharedKey();

      wg.addPeerRuntime({ pub, psk: presharedKey, ip });
      runtimeAdded = true;
      wg.appendPeerBlock({ name, pub, ip, psk: presharedKey });
      peerBlockAdded = true;
      configPath = storage.clientConfigPath(name);

      fs.writeFileSync(
        configPath,
        buildClientConfig({ privateKey, ip, presharedKey }),
        { mode: 0o600 }
      );

      const now = Date.now();
      const peer = normalizeTrafficPeer({
        name,
        ip,
        pub,
        created: now,
        blocked: false,
        ...trafficLimit,
        traffic_used_bytes: 0,
        traffic_blocked: false,
        traffic_reset_at: null,
        traffic_updated_at: now,
        traffic_last_runtime_bytes: 0,
      }).peer;
      storage.savePeers([...peers, peer]);
      res.json({ ok: true, peer });
      safeBroadcast();
    } catch (error) {
      if (runtimeAdded && pub) {
        try { wg.removePeer(pub); } catch { /* best-effort rollback */ }
      }
      if (peerBlockAdded && pub) {
        try { wg.removePeerBlock(pub); } catch { /* best-effort rollback */ }
      }
      if (configPath) fs.rmSync(configPath, { force: true });
      return apiError(res, 500, 'add_failed', String(error.message || error));
    }
  });
});

routes.post('/api/block', requireAuth, (req, res) => {
  const pub = String(req.body?.pub || '').trim();
  if (!isPublicKey(pub)) return apiError(res, 400, 'bad_pub');
  return mutate(res, 'block_failed', () => {
    const peers = normalizeTrafficPeers(storage.loadPeers()).peers;
    const peer = peers.find((item) => item.pub === pub);
    if (!peer) return apiError(res, 404, 'not_found');

    peer.blocked = true;
    applyPeerAccess(peer);
    storage.savePeers(peers);
    res.json({ ok: true });
    safeBroadcast();
  });
});

routes.post('/api/unblock', requireAuth, (req, res) => {
  const pub = String(req.body?.pub || '').trim();
  if (!isPublicKey(pub)) return apiError(res, 400, 'bad_pub');
  return mutate(res, 'unblock_failed', () => {
    const peers = normalizeTrafficPeers(storage.loadPeers()).peers;
    const peer = peers.find((item) => item.pub === pub);
    if (!peer) return apiError(res, 404, 'not_found');

    peer.blocked = false;
    applyPeerAccess(peer);
    storage.savePeers(peers);
    res.json({ ok: true });
    safeBroadcast();
  });
});

routes.post('/api/delete', requireAuth, (req, res) => {
  const pub = String(req.body?.pub || '').trim();
  if (!isPublicKey(pub)) return apiError(res, 400, 'bad_pub');
  return mutate(res, 'delete_failed', () => {
    const peers = storage.loadPeers();
    const peer = peers.find((item) => item.pub === pub);
    if (!peer) return apiError(res, 404, 'not_found');

    try {
      wg.removePeer(pub);
    } catch (error) {
      console.warn('WireGuard runtime peer remove failed:', error.message);
    }

    wg.removePeerBlock(pub);

    const configPath = storage.clientConfigPath(peer.name);
    fs.rmSync(configPath, { force: true });
    storage.savePeers(peers.filter((item) => item.pub !== pub));
    res.json({ ok: true });
    safeBroadcast();
  });
});

routes.get('/api/traffic', requireAuth, (req, res) => {
  const pub = String(req.query?.pub || '').trim();
  if (!isPublicKey(pub)) return apiError(res, 400, 'bad_pub');
  return mutate(res, 'traffic_sync_failed', () => {
    const { peers, dump } = syncTrafficUsage();
    const peer = peers.find((item) => item.pub === pub);
    if (!peer) return apiError(res, 404, 'not_found');
    return res.json(peerWithTrafficStats(peer, dump.get(peer.pub)));
  });
});

routes.post('/api/traffic/limit', requireAuth, (req, res) => {
  const pub = String(req.body?.pub || '').trim();
  if (!isPublicKey(pub)) return apiError(res, 400, 'bad_pub');

  let trafficLimit;
  try {
    trafficLimit = parseTrafficLimit(req.body || {});
  } catch (error) {
    return apiError(res, error.status || 400, error.message || 'bad_limit');
  }

  return mutate(res, 'traffic_limit_failed', () => {
    const { peers } = syncTrafficUsage({ enforceLimits: false });
    const peer = peers.find((item) => item.pub === pub);
    if (!peer) return apiError(res, 404, 'not_found');

    const wasTrafficBlocked = peer.traffic_blocked;
    peer.traffic_limit_enabled = trafficLimit.traffic_limit_enabled;
    peer.traffic_limit_bytes = trafficLimit.traffic_limit_bytes;
    peer.traffic_updated_at = Date.now();

    if (!peer.traffic_limit_enabled || peer.traffic_used_bytes < peer.traffic_limit_bytes) {
      peer.traffic_blocked = false;
    } else {
      peer.traffic_blocked = true;
      console.warn(`Traffic limit update blocks ${peer.name}: ${peer.traffic_used_bytes}/${peer.traffic_limit_bytes}`);
    }

    if (wasTrafficBlocked !== peer.traffic_blocked) applyPeerAccess(peer);
    storage.savePeers(peers);
    console.log(`Traffic limit updated for ${peer.name}`);
    res.json({ ok: true, peer: peerWithTrafficStats(peer) });
    safeBroadcast();
  });
});

routes.post('/api/traffic/reset', requireAuth, (req, res) => {
  const pub = String(req.body?.pub || '').trim();
  if (!isPublicKey(pub)) return apiError(res, 400, 'bad_pub');

  return mutate(res, 'traffic_reset_failed', () => {
    const dump = wg.dump();
    const peers = normalizeTrafficPeers(storage.loadPeers()).peers;
    const peer = peers.find((item) => item.pub === pub);
    if (!peer) return apiError(res, 404, 'not_found');

    const wasTrafficBlocked = peer.traffic_blocked;
    const runtimeTotal = runtimeTrafficTotal(dump.get(peer.pub));
    peer.traffic_used_bytes = 0;
    peer.traffic_last_runtime_bytes = runtimeTotal || 0;
    peer.traffic_blocked = false;
    peer.traffic_reset_at = Date.now();
    peer.traffic_updated_at = peer.traffic_reset_at;

    if (wasTrafficBlocked) applyPeerAccess(peer);
    storage.savePeers(peers);
    console.log(`Traffic usage reset for ${peer.name}`);
    res.json({ ok: true, peer: peerWithTrafficStats(peer, dump.get(peer.pub)) });
    safeBroadcast();
  });
});

routes.post('/api/traffic/unblock', requireAuth, (req, res) => {
  const pub = String(req.body?.pub || '').trim();
  if (!isPublicKey(pub)) return apiError(res, 400, 'bad_pub');

  return mutate(res, 'traffic_unblock_failed', () => {
    const { peers, dump } = syncTrafficUsage({ enforceLimits: false });
    const peer = peers.find((item) => item.pub === pub);
    if (!peer) return apiError(res, 404, 'not_found');
    if (
      peer.traffic_limit_enabled &&
      peer.traffic_limit_bytes > 0 &&
      peer.traffic_used_bytes >= peer.traffic_limit_bytes
    ) {
      return apiError(res, 400, 'limit_reached');
    }

    const wasTrafficBlocked = peer.traffic_blocked;
    peer.traffic_blocked = false;
    peer.traffic_updated_at = Date.now();
    if (wasTrafficBlocked) applyPeerAccess(peer);
    storage.savePeers(peers);
    console.log(`Traffic block cleared for ${peer.name}`);
    res.json({ ok: true, peer: peerWithTrafficStats(peer, dump.get(peer.pub)) });
    safeBroadcast();
  });
});

routes.get('/api/qr', requireAuth, (req, res) => {
  try {
    const pub = String(req.query?.pub || '').trim();
    if (!isPublicKey(pub)) return res.status(400).send('bad pub');
    const peer = peerByPublicKey(pub);
    if (!peer) return res.status(404).send('peer not found');

    const file = storage.clientConfigPath(peer.name);
    if (!fs.existsSync(file)) return res.status(404).send('no file');

    res.setHeader('Content-Type', 'image/png');
    return res.end(wg.qrPng(file));
  } catch (error) {
    console.error('qr error:', error.message || error);
    return res.status(500).send('qrencode failed');
  }
});

routes.get('/api/conf', requireAuth, (req, res) => {
  try {
    const pub = String(req.query?.pub || '').trim();
    if (!isPublicKey(pub)) return res.status(400).send('bad pub');
    const peer = peerByPublicKey(pub);
    if (!peer) return res.status(404).send('peer not found');

    const file = storage.clientConfigPath(peer.name);
    if (!fs.existsSync(file)) return res.status(404).send('no file');

    const content = fs.readFileSync(file, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(peer.name)}.conf"`,
      'Content-Length': Buffer.byteLength(content, 'utf8'),
    });
    return res.end(content, 'utf8');
  } catch (error) {
    console.error('conf download error:', error.message || error);
    return res.status(500).send('internal error');
  }
});

routes.post('/api/restart', requireAuth, (_req, res) => {
  return mutate(res, 'restart_failed', () => {
    const out = wg.restart();
    res.json({ ok: true, out });
    safeBroadcast(500);
  });
});

routes.use((error, _req, res, next) => {
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return apiError(res, 400, 'invalid_json');
  }
  return next(error);
});

app.use(config.publicBasePath || '/', routes);

const lastStat = new Map();
function peersWithRates() {
  const now = Date.now();
  const seen = new Set();
  const peers = peersWithStats().map((peer) => {
    seen.add(peer.pub);
    const prev = lastStat.get(peer.pub) || { rx: peer.rx || 0, tx: peer.tx || 0, ts: now };
    const dt = Math.max(1, (now - prev.ts) / 1000);
    const rxRate = Math.max(0, ((peer.rx || 0) - prev.rx) / dt);
    const txRate = Math.max(0, ((peer.tx || 0) - prev.tx) / dt);
    lastStat.set(peer.pub, { rx: peer.rx || 0, tx: peer.tx || 0, ts: now });
    return { ...peer, rxRate, txRate };
  });

  for (const pub of lastStat.keys()) {
    if (!seen.has(pub)) lastStat.delete(pub);
  }

  return peers;
}

function broadcast() {
  io.emit('status', { ifname: config.wgIf, text: wg.status() });
  io.emit('peers', peersWithRates());
}

function runTrafficSync() {
  runMutation(() => {
    const result = syncTrafficUsage();
    if (result.changed) safeBroadcast();
  }).catch((error) => {
    console.error('Traffic sync failed:', error.message || error);
  });
}

io.use((socket, next) => {
  try {
    if (!allowedIpMatches(socketIp(socket), config.allowedIps, config.wgNet)) return next(new Error('forbidden'));
  } catch {
    return next(new Error('forbidden'));
  }

  const header = socket.handshake.auth?.authorization || socket.handshake.headers?.authorization || '';
  if (verifyBasicAuth(header, config.adminUser, config.adminPass)) return next();
  if (sessions.verify(sessionTokenFromHeader(socket.handshake.headers?.cookie))) return next();
  return next(new Error('unauthorized'));
});

io.on('connection', (socket) => {
  socket.emit('status', { ifname: config.wgIf, text: wg.status() });
  socket.emit('peers', peersWithRates());
});

setInterval(() => {
  if (io.engine.clientsCount > 0) safeBroadcast();
}, 5000);
setInterval(runTrafficSync, TRAFFIC_SYNC_INTERVAL_MS);
wg.ensureStarted();

if (require.main === module) {
  server.listen(config.port, config.host, () => {
    const localPath = config.publicBasePath || '/';
    console.log(`WG Panel listening on http://${config.host}:${config.port}${localPath}`);
  });
}

module.exports = {
  app,
  server,
  config,
};
