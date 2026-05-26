const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function basic(user, pass) {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(url, options = {}) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < 6000) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;
      lastError = new Error(`${res.status} ${res.statusText}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

async function main() {
  const port = await freePort();
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-dashboard-smoke-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      AUTO_START_WG: 'false',
      PORT: String(port),
      BASE_DIR: baseDir,
      ADMIN_USER: 'test',
      ADMIN_PASS: 'test',
      WG_CONF: path.join(baseDir, 'wg0.conf'),
      WG_SERVER_PUB: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=',
      WG_ENDPOINT: '127.0.0.1:51820',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const index = await waitFor(baseUrl);
    if (index.headers.get('x-frame-options') !== 'DENY') {
      throw new Error('Missing X-Frame-Options security header');
    }
    if (index.headers.get('x-content-type-options') !== 'nosniff') {
      throw new Error('Missing X-Content-Type-Options security header');
    }
    if (!String(index.headers.get('content-security-policy') || '').includes("default-src 'self'")) {
      throw new Error('Missing Content-Security-Policy security header');
    }

    const unauthorized = await fetch(`${baseUrl}/api/peers`);
    if (unauthorized.status !== 401) throw new Error(`/api/peers without auth returned ${unauthorized.status}`);

    const peers = await waitFor(`${baseUrl}/api/peers`, {
      headers: { Authorization: basic('test', 'test') },
    });
    const json = await peers.json();
    if (!Array.isArray(json)) throw new Error('/api/peers did not return an array');

    const badConf = await fetch(`${baseUrl}/api/conf?pub=not-a-key`, {
      headers: { Authorization: basic('test', 'test') },
    });
    if (badConf.status !== 400) throw new Error(`/api/conf bad pub returned ${badConf.status}`);

    const badPub = await fetch(`${baseUrl}/api/block`, {
      method: 'POST',
      headers: {
        Authorization: basic('test', 'test'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ pub: 'not-a-key' }),
    });
    if (badPub.status !== 400) throw new Error(`/api/block bad pub returned ${badPub.status}`);

    console.log(`Smoke OK: ${baseUrl}`);
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(baseDir, { recursive: true, force: true });
  }

  if (child.exitCode && child.exitCode !== 0) {
    throw new Error(output);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
