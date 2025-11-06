// --- Инициализация окружения ---
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const http = require('http');
const fs = require('fs');
const fse = require('fs-extra');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { execSync } = require('child_process');
const { Server } = require('socket.io');
const os = require('os');

// --- Константы из .env ---
const {
  WG_IF = 'wg0',
  WG_CONF = '/etc/wireguard/wg0.conf',
  WG_SERVER_PUB = '',
  WG_ENDPOINT = '',
  WG_DNS = '1.1.1.1,8.8.8.8',
  WG_NET = '10.0.70.0/24',
  PORT = 54763,
} = process.env;

// --- Express + Socket.io ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// --- Простой IP whitelist ---
//app.set('trust proxy', false); // не доверяем X-Forwarded-For

app.use((req, res, next) => {
  const allowedExact = new Set([
    '127.0.0.1',        // localhost
    '::1',              // IPv6 localhost
    'you_ip*',
  ]);

  // реальный IP клиента
  let ip = req.socket?.remoteAddress || req.ip || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7); // IPv6-mapped IPv4
  if (ip === '::1') ip = '127.0.0.1';

  // Разрешаем:
  // 1. точные IP из списка
  // 2. все адреса 10.0.70.0/24 (VPN)
  if (
    allowedExact.has(ip) ||
    ip.startsWith('10.0.70.')
  ) {
    return next();
  }

  console.warn(`🚫 Access denied from ${ip} -> ${req.method} ${req.url}`);
  res.status(403).send('Forbidden');
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));


// --- Хранилище ---
const BASE_DIR = '/opt/wg-dashboard';
const DATA_DIR = path.resolve(BASE_DIR, 'data');
const PEERS_JSON = path.resolve(DATA_DIR, 'peers.json');
const CLIENTS_DIR = path.resolve(DATA_DIR, 'clients');

fse.ensureDirSync(DATA_DIR);
fse.ensureDirSync(CLIENTS_DIR);
if (!fs.existsSync(PEERS_JSON)) fs.writeFileSync(PEERS_JSON, '[]');

console.log('📁 DATA_DIR =', DATA_DIR);
console.log('📁 CLIENTS_DIR =', CLIENTS_DIR);

// --- Утилиты ---
const run = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();
const safeLoadJSON = (file) => {
  try {
    const s = fs.readFileSync(file, 'utf8').trim();
    return s ? JSON.parse(s) : [];
  } catch {
    return [];
  }
};
const loadPeers = () => safeLoadJSON(PEERS_JSON);
const savePeers = (peers) => fs.writeFileSync(PEERS_JSON, JSON.stringify(peers || [], null, 2));

function nextIp() {
  const peers = loadPeers();
  const base = WG_NET.split('/')[0].split('.');
  for (let i = 2; i < 255; i++) {
    const ip = `${base[0]}.${base[1]}.${base[2]}.${i}`;
    if (!peers.find((p) => p.ip === ip)) return ip;
  }
  throw new Error('Свободных IP больше нет');
}
// Добавление peer с PSK
function addPeerWithPSK(pub, ip, wgIf) {
  const psk = execSync('wg genpsk', { encoding: 'utf8' }).trim();
  const tmp = path.join(os.tmpdir(), `psk-${Date.now()}.key`);
  fs.writeFileSync(tmp, psk + '\n');
  try {
    execSync(`wg set ${wgIf} peer ${pub} preshared-key ${tmp} allowed-ips ${ip}/32`);
  } finally {
    fs.unlinkSync(tmp);
  }
  return psk;
}

// --- Маркеры ---
const MARK_BEGIN = '# [WG-DASHBOARD BEGIN';
const MARK_END = '# [WG-DASHBOARD END]';

// Добавление peer-блока в wg0.conf
function addPeerBlockToConf({ name, pub, ip, psk }) {
  const block =
    `${MARK_BEGIN} name="${name}" pub="${pub}"]
[Peer]
PublicKey = ${pub}
PresharedKey = ${psk}
AllowedIPs = ${ip}/32
${MARK_END}
`;
  fs.appendFileSync(WG_CONF, `\n${block}`);
}

// Безопасное удаление peer-блока
function removePeerBlockFromConf(pub) {
  try {
    let conf = fs.readFileSync(WG_CONF, 'utf8');
    conf = conf.replace(/\r\n/g, '\n');
    const escapedPub = pub.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(
      `# \\[WG-DASHBOARD BEGIN[^\\n]*?pub="${escapedPub}"\\][\\s\\S]*?# \\[WG-DASHBOARD END\\]\\s*`,
      'gm'
    );
    const newConf = conf.replace(regex, '').replace(/\n{3,}/g, '\n\n').trim() + '\n';
    fs.writeFileSync(WG_CONF, newConf);
  } catch (e) {
    console.error('Ошибка при очистке wg0.conf:', e.message);
  }
}

// --- WG Dump ---
function parseWgDump() {
  let out = '';
  try { out = run(`wg show ${WG_IF} dump`); } catch { return new Map(); }
  const lines = out.split('\n').filter(Boolean);
  const map = new Map();
  for (const line of lines) {
    const p = line.split('\t');
    if (p.length < 8 || p[0] === WG_IF) continue;
    const pub = p[0];
    const endpoint = p[2] === '(none)' ? '' : p[2];
    const allowed = p[3];
    const latest_ts = Number(p[4] || 0);
    const rx = Number(p[5] || 0);
    const tx = Number(p[6] || 0);
    const nowSec = Math.floor(Date.now() / 1000);
    const delta = latest_ts ? nowSec - latest_ts : 0;
    const online = latest_ts > 0 && delta < 180; // 3 минуты — порог "онлайна"
    const latest = latest_ts > 0 ? `${delta}s ago` : 'no handshake';
    map.set(pub, { endpoint, allowed, latest_ts, latest, rx, tx, online });
  }
  return map;
}

// --- Авторизация ---
const { ADMIN_USER = '', ADMIN_PASS = '' } = process.env;
function requireAuth(req, res, next) {
  if (!ADMIN_USER || !ADMIN_PASS) {
    return res.status(403).send('Access disabled: set ADMIN_USER and ADMIN_PASS in .env');
  }
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="WG Panel"');
    return res.status(401).send('Auth required');
  }
  const creds = Buffer.from(auth.slice(6), 'base64').toString('utf8');
  const [user, pass] = creds.split(':');
  if (user === ADMIN_USER && pass === ADMIN_PASS) return next();
  res.setHeader('WWW-Authenticate', 'Basic realm="WG Panel"');
  return res.status(401).send('Invalid credentials');
}

// --- API ---
app.get('/api/status', requireAuth, (req, res) => {
  let iface = '';
  try { iface = run(`wg show ${WG_IF}`); } catch (e) { iface = String(e.message || e); }
  res.json({ iface, ifname: WG_IF });
});

app.get('/api/peers', requireAuth, (req, res) => {
  const peers = loadPeers();
  const dump = parseWgDump();
  res.json(peers.map(p => ({ ...p, ...(dump.get(p.pub) || {}), allowed: `${p.ip}/32` })));
});

app.post('/api/add', requireAuth, (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!/^[a-zA-Z0-9._-]{2,32}$/.test(name)) return res.status(400).json({ error: 'bad_name' });

  const peers = loadPeers();
  if (peers.find((p) => p.name === name)) return res.status(400).json({ error: 'exists' });

  const priv = run('wg genkey');
  const pub = run(`bash -lc "printf %s '${priv}' | wg pubkey"`);
  const ip = nextIp();

  // генерим PSK и добавляем peer в рантайме (БЕЗ <(...)>!)
  let psk = '';
  try {
    psk = execSync('wg genpsk', { encoding: 'utf8' }).trim();
    const tmp = path.join(os.tmpdir(), `psk-${Date.now()}.key`);
    fs.writeFileSync(tmp, psk + '\n');
    try {
      execSync(`wg set ${WG_IF} peer ${pub} preshared-key ${tmp} allowed-ips ${ip}/32`);
    } finally {
      fs.unlinkSync(tmp);
    }
  } catch (e) {
    return res.status(500).json({ error: 'wg_set_failed', detail: String(e.message || e) });
  }

  // persist в wg0.conf (ОДИН раз, с PSK)
  try {
    addPeerBlockToConf({ name, pub, ip, psk });
  } catch (e) {
    return res.status(500).json({ error: 'persist_failed', detail: String(e.message || e) });
  }

  // конфиг клиента (c PSK)
  const conf = `[Interface]
PrivateKey = ${priv}
Address = ${ip}/24
DNS = ${WG_DNS}

[Peer]
PublicKey = ${WG_SERVER_PUB}
PresharedKey = ${psk}
AllowedIPs = 0.0.0.0/0
Endpoint = ${WG_ENDPOINT}
`;
  const confPath = path.join(CLIENTS_DIR, `${name}.conf`);
  fs.writeFileSync(confPath, conf, { mode: 0o600 });

  const rec = { name, ip, pub, created: Date.now(), blocked: false };
  peers.push(rec);
  savePeers(peers);

  res.json({ ok: true, peer: rec });
  broadcast();
});

// Заблокировать клиента (обнуляем allowed-ips и помечаем в peers.json)
app.post('/api/block', requireAuth, (req, res) => {
  const pub = String(req.body?.pub || '').trim();
  if (!pub) return res.status(400).json({ error: 'no_pub' });

  const peers = loadPeers();
  const p = peers.find(x => x.pub === pub);
  if (!p) return res.status(404).json({ error: 'not_found' });

  try { run(`wg set ${WG_IF} peer ${pub} allowed-ips 0.0.0.0/32`); }
  catch (e) {
    return res.status(500).json({ error: 'wg_set_failed', detail: String(e.message || e) });
  }

  p.blocked = true; savePeers(peers);
  res.json({ ok: true });
  broadcast();
});

// Разблокировать клиента (восстанавливаем его /32)
app.post('/api/unblock', requireAuth, (req, res) => {
  const pub = String(req.body?.pub || '').trim();
  if (!pub) return res.status(400).json({ error: 'no_pub' });

  const peers = loadPeers();
  const p = peers.find(x => x.pub === pub);
  if (!p) return res.status(404).json({ error: 'not_found' });

  try { run(`wg set ${WG_IF} peer ${pub} allowed-ips ${p.ip}/32`); }
  catch (e) {
    return res.status(500).json({ error: 'wg_set_failed', detail: String(e.message || e) });
  }

  p.blocked = false; savePeers(peers);
  res.json({ ok: true });
  broadcast();
});

// QR-код для клиента (PNG)
app.get('/api/qr', requireAuth, (req, res) => {
  try {
    const pub = String(req.query?.pub || '').trim();
    if (!pub) return res.status(400).send('no pub');

    const peers = loadPeers();
    const peer = peers.find(p => p.pub === pub);
    if (!peer) return res.status(404).send('peer not found');

    const file = path.join(CLIENTS_DIR, `${peer.name}.conf`);
    if (!fs.existsSync(file)) return res.status(404).send('no file');

    // qrencode -> stdout (PNG)
    const png = execSync(`qrencode -t PNG -o - -r ${file}`, { encoding: 'buffer' });
    res.setHeader('Content-Type', 'image/png');
    return res.end(png);
  } catch (e) {
    console.error('qr error:', e.message || e);
    return res.status(500).send('qrencode failed');
  }
});

// Перезапуск интерфейса wg
app.post('/api/restart', requireAuth, (req, res) => {
  try {
    const out = run(`bash -lc "wg-quick down ${WG_IF} && wg-quick up ${WG_IF}"`);
    res.json({ ok: true, out });
    setTimeout(broadcast, 500);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// --- Скачать конфиг по публичному ключу ---
app.get('/api/conf', requireAuth, (req, res) => {
  try {
    const pub = String(req.query?.pub || '').trim();
    if (!pub) return res.status(400).send('no pub');

    const peers = loadPeers();
    const peer = peers.find((p) => p.pub === pub);
    if (!peer) return res.status(404).send('peer not found');

    const file = path.join(CLIENTS_DIR, `${peer.name}.conf`);
    if (!fs.existsSync(file)) {
      console.error('⚠️ conf: файл не найден', file);
      return res.status(404).send('no file');
    }

    const content = fs.readFileSync(file, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(peer.name)}.conf"`,
      'Content-Length': Buffer.byteLength(content, 'utf8'),
    });
    res.end(content, 'utf8');
  } catch (err) {
    console.error('conf download error:', err);
    res.status(500).send('internal error');
  }
});

app.post('/api/delete', requireAuth, (req, res) => {
  const pub = String(req.body?.pub || '').trim();
  if (!pub) return res.status(400).json({ error: 'no_pub' });

  try { run(`wg set ${WG_IF} peer ${pub} remove`); } catch { }

  let peers = loadPeers();
  const victim = peers.find((p) => p.pub === pub);
  if (victim) {
    const f = path.join(CLIENTS_DIR, `${victim.name}.conf`);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  peers = peers.filter((p) => p.pub !== pub);
  savePeers(peers);
  removePeerBlockFromConf(pub);

  res.json({ ok: true });
  broadcast();
});

// --- Live Updates ---
const lastStat = new Map();
function currentPeersWithRates() {
  const peers = loadPeers();
  const dump = parseWgDump();
  const now = Date.now();
  return peers.map((p) => {
    const d = dump.get(p.pub) || {};
    const prev = lastStat.get(p.pub) || { rx: d.rx || 0, tx: d.tx || 0, ts: now };
    const dt = Math.max(1, (now - prev.ts) / 1000);
    const rxRate = Math.max(0, ((d.rx || 0) - prev.rx) / dt);
    const txRate = Math.max(0, ((d.tx || 0) - prev.tx) / dt);
    lastStat.set(p.pub, { rx: d.rx || 0, tx: d.tx || 0, ts: now });
    return { ...p, ...d, rxRate, txRate };
  });
}
function ifaceStatus() {
  try { return run(`wg show ${WG_IF}`); } catch (e) { return String(e.message || e); }
}
function broadcast() {
  io.emit('status', { ifname: WG_IF, text: ifaceStatus() });
  io.emit('peers', currentPeersWithRates());
}
io.on('connection', (socket) => {
  socket.emit('status', { ifname: WG_IF, text: ifaceStatus() });
  socket.emit('peers', currentPeersWithRates());
});
setInterval(broadcast, 5000);

// --- Автозапуск wg ---
try {
  const output = run(`wg show ${WG_IF}`);
  if (output.includes('interface:')) console.log(`✅ WireGuard (${WG_IF}) уже запущен`);
  else { console.log(`🔄 Запускаем WireGuard (${WG_IF})...`); run(`wg-quick up ${WG_IF}`); }
} catch {
  console.log(`🔄 Запускаем WireGuard (${WG_IF})...`);
  try { run(`wg-quick up ${WG_IF}`); } catch (e) { console.error('Не удалось поднять интерфейс:', e.message); }
}

// --- Старт ---
server.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`🌐 WG Panel on http://0.0.0.0:${PORT}`);
});
