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

const config = loadConfig(process.env, __dirname);
const wgNet = parseCidr(config.wgNet);
const sessions = createSessionStore();
const storage = createStorage(config.baseDir);
const wg = createWireGuard(config);

const app = express();
const server = http.createServer(app);
const io = new Server(server);
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
    path: '/',
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

function peerByPublicKey(pub) {
  return storage.loadPeers().find((peer) => peer.pub === pub);
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
  return storage.loadPeers().map((peer) => ({
    ...peer,
    ...(dump.get(peer.pub) || {}),
    allowed: `${peer.ip}/32`,
  }));
}

function buildClientConfig({ privateKey, ip, presharedKey }) {
  assertClientConfigReady();
  return `[Interface]
PrivateKey = ${privateKey}
Address = ${ip}/${wgNet.prefix}
DNS = ${config.wgDns}

[Peer]
PublicKey = ${config.wgServerPub}
PresharedKey = ${presharedKey}
AllowedIPs = 0.0.0.0/0
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
app.use(express.json({ limit: '64kb' }));
app.use(express.static(config.publicDir));

app.post('/api/logout', (req, res) => {
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

app.get('/api/status', requireAuth, (_req, res) => {
  res.json({ iface: wg.status(), ifname: config.wgIf });
});

app.get('/api/peers', requireAuth, (_req, res) => {
  res.json(peersWithStats());
});

app.post('/api/add', requireAuth, (req, res) => {
  const name = String(req.body?.name || '').trim();
  try {
    wg.assertClientName(name);
  } catch {
    return apiError(res, 400, 'bad_name');
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

      const peer = { name, ip, pub, created: Date.now(), blocked: false };
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

app.post('/api/block', requireAuth, (req, res) => {
  const pub = String(req.body?.pub || '').trim();
  if (!isPublicKey(pub)) return apiError(res, 400, 'bad_pub');
  return mutate(res, 'block_failed', () => {
    const peers = storage.loadPeers();
    const peer = peers.find((item) => item.pub === pub);
    if (!peer) return apiError(res, 404, 'not_found');

    wg.blockPeer(pub);
    wg.updatePeerAllowedIp(pub, '0.0.0.0/32');
    peer.blocked = true;
    storage.savePeers(peers);
    res.json({ ok: true });
    safeBroadcast();
  });
});

app.post('/api/unblock', requireAuth, (req, res) => {
  const pub = String(req.body?.pub || '').trim();
  if (!isPublicKey(pub)) return apiError(res, 400, 'bad_pub');
  return mutate(res, 'unblock_failed', () => {
    const peers = storage.loadPeers();
    const peer = peers.find((item) => item.pub === pub);
    if (!peer) return apiError(res, 404, 'not_found');

    wg.unblockPeer(pub, peer.ip);
    wg.updatePeerAllowedIp(pub, `${peer.ip}/32`);
    peer.blocked = false;
    storage.savePeers(peers);
    res.json({ ok: true });
    safeBroadcast();
  });
});

app.post('/api/delete', requireAuth, (req, res) => {
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

app.get('/api/qr', requireAuth, (req, res) => {
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

app.get('/api/conf', requireAuth, (req, res) => {
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

app.post('/api/restart', requireAuth, (_req, res) => {
  return mutate(res, 'restart_failed', () => {
    const out = wg.restart();
    res.json({ ok: true, out });
    safeBroadcast(500);
  });
});

app.use((error, _req, res, next) => {
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return apiError(res, 400, 'invalid_json');
  }
  return next(error);
});

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
wg.ensureStarted();

if (require.main === module) {
  server.listen(config.port, '0.0.0.0', () => {
    console.log(`WG Panel listening on http://0.0.0.0:${config.port}`);
  });
}

module.exports = {
  app,
  server,
  config,
};
