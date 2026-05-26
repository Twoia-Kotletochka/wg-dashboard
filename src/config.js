const path = require('path');

const DEFAULTS = Object.freeze({
  HOST: '127.0.0.1',
  WG_IF: 'wg0',
  WG_CONF: '/etc/wireguard/wg0.conf',
  WG_DNS: '1.1.1.1,8.8.8.8',
  WG_NET: '10.0.70.0/24',
  PORT: 54763,
  AUTO_START_WG: true,
});

function normalizeBasePath(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === '/') return '';

  const pathValue = raw.startsWith('/') ? raw : `/${raw}`;
  const normalized = pathValue.replace(/\/+$/, '');
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@/-]*$/.test(normalized)) {
    throw new Error(`Invalid PUBLIC_BASE_PATH: ${value}`);
  }
  if (normalized.includes('//')) throw new Error(`Invalid PUBLIC_BASE_PATH: ${value}`);
  return normalized;
}

function publicUrlBasePath(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  try {
    return normalizeBasePath(new URL(raw).pathname);
  } catch {
    throw new Error(`Invalid PUBLIC_URL: ${value}`);
  }
}

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

function parsePort(value) {
  const port = Number.parseInt(String(value), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }
  return port;
}

function loadConfig(env = process.env, rootDir = path.resolve(__dirname, '..')) {
  const baseDir = path.resolve(rootDir, env.BASE_DIR || '.');
  const wgConf = env.WG_CONF || DEFAULTS.WG_CONF;
  const publicUrl = String(env.PUBLIC_URL || '').trim();
  const publicBasePath = normalizeBasePath(env.PUBLIC_BASE_PATH || publicUrlBasePath(publicUrl));

  return Object.freeze({
    rootDir,
    publicDir: path.join(rootDir, 'public'),
    host: env.HOST || DEFAULTS.HOST,
    publicUrl,
    publicBasePath,
    wgIf: env.WG_IF || DEFAULTS.WG_IF,
    wgConf,
    wgServerPub: env.WG_SERVER_PUB || '',
    wgEndpoint: env.WG_ENDPOINT || '',
    wgDns: env.WG_DNS || DEFAULTS.WG_DNS,
    wgNet: env.WG_NET || DEFAULTS.WG_NET,
    port: parsePort(env.PORT || DEFAULTS.PORT),
    adminUser: env.ADMIN_USER || '',
    adminPass: env.ADMIN_PASS || '',
    allowedIps: splitCsv(env.ALLOWED_IPS),
    baseDir,
    autoStartWg: parseBoolean(env.AUTO_START_WG, DEFAULTS.AUTO_START_WG),
  });
}

module.exports = {
  DEFAULTS,
  loadConfig,
  normalizeBasePath,
  publicUrlBasePath,
  parseBoolean,
  splitCsv,
};
