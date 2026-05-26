require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const { createAuthMiddleware, verifyBasicAuth } = require('./src/auth');
const { loadConfig } = require('./src/config');
const { allowedIpMatches, normalizeIp, nextIpFromPeers, parseCidr } = require('./src/net');
const { createStorage } = require('./src/storage');
const { createWireGuard } = require('./src/wireguard');

const config = loadConfig(process.env, __dirname);
const wgNet = parseCidr(config.wgNet);
const storage = createStorage(config.baseDir);
const wg = createWireGuard(config);

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const requireAuth = createAuthMiddleware(config);

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
  wg.assertPublicKey(pub);
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

app.use(requireAllowedIp);
app.use(express.json({ limit: '64kb' }));
app.use(express.static(config.publicDir));

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
    broadcast();
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

app.post('/api/block', requireAuth, (req, res) => {
  const pub = String(req.body?.pub || '').trim();
  if (!isPublicKey(pub)) return apiError(res, 400, 'bad_pub');
  try {
    const peers = storage.loadPeers();
    const peer = peers.find((item) => item.pub === pub);
    if (!peer) return apiError(res, 404, 'not_found');

    wg.blockPeer(pub);
    wg.updatePeerAllowedIp(pub, '0.0.0.0/32');
    peer.blocked = true;
    storage.savePeers(peers);
    res.json({ ok: true });
    broadcast();
  } catch (error) {
    return apiError(res, 500, 'block_failed', String(error.message || error));
  }
});

app.post('/api/unblock', requireAuth, (req, res) => {
  const pub = String(req.body?.pub || '').trim();
  if (!isPublicKey(pub)) return apiError(res, 400, 'bad_pub');
  try {
    const peers = storage.loadPeers();
    const peer = peers.find((item) => item.pub === pub);
    if (!peer) return apiError(res, 404, 'not_found');

    wg.unblockPeer(pub, peer.ip);
    wg.updatePeerAllowedIp(pub, `${peer.ip}/32`);
    peer.blocked = false;
    storage.savePeers(peers);
    res.json({ ok: true });
    broadcast();
  } catch (error) {
    return apiError(res, 500, 'unblock_failed', String(error.message || error));
  }
});

app.post('/api/delete', requireAuth, (req, res) => {
  const pub = String(req.body?.pub || '').trim();
  if (!isPublicKey(pub)) return apiError(res, 400, 'bad_pub');
  try {
    const peers = storage.loadPeers();
    const peer = peers.find((item) => item.pub === pub);
    if (!peer) return apiError(res, 404, 'not_found');

    try {
      wg.removePeer(pub);
    } catch (error) {
      console.warn('WireGuard runtime peer remove failed:', error.message);
    }

    const configPath = storage.clientConfigPath(peer.name);
    fs.rmSync(configPath, { force: true });
    storage.savePeers(peers.filter((item) => item.pub !== pub));

    try {
      wg.removePeerBlock(pub);
    } catch (error) {
      console.error('Ошибка при очистке wg config:', error.message);
    }

    res.json({ ok: true });
    broadcast();
  } catch (error) {
    return apiError(res, 500, 'delete_failed', String(error.message || error));
  }
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
  try {
    const out = wg.restart();
    res.json({ ok: true, out });
    setTimeout(broadcast, 500);
  } catch (error) {
    return apiError(res, 500, 'restart_failed', String(error.message || error));
  }
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
  return next(new Error('unauthorized'));
});

io.on('connection', (socket) => {
  socket.emit('status', { ifname: config.wgIf, text: wg.status() });
  socket.emit('peers', peersWithRates());
});

setInterval(() => {
  if (io.engine.clientsCount > 0) broadcast();
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
