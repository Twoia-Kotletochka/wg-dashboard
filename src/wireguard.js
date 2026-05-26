const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const IFACE_RE = /^[a-zA-Z0-9_.:-]{1,32}$/;
const PUBLIC_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
const CLIENT_NAME_RE = /^[a-zA-Z0-9._-]{2,32}$/;

const MARK_BEGIN = '# [WG-DASHBOARD BEGIN';
const MARK_END = '# [WG-DASHBOARD END]';

function runFile(command, args = [], options = {}) {
  return execFileSync(command, args, {
    encoding: options.encoding || 'utf8',
    input: options.input,
    stdio: options.stdio,
  }).trim();
}

function runFileBuffer(command, args = []) {
  return execFileSync(command, args, { encoding: 'buffer' });
}

function commandErrorMessage(error, command) {
  if (error?.code === 'ENOENT' || String(error?.message || '').includes(`spawnSync ${command} ENOENT`)) {
    return `${command} не найден. Установите WireGuard на сервере или используйте AUTO_START_WG=false для локальной проверки.`;
  }
  return String(error?.stderr || error?.message || error);
}

function assertInterface(value) {
  if (!IFACE_RE.test(String(value || ''))) throw new Error(`Invalid WireGuard interface: ${value}`);
}

function assertPublicKey(value) {
  if (!PUBLIC_KEY_RE.test(String(value || ''))) throw new Error('Invalid WireGuard public key');
}

function assertClientName(value) {
  if (!CLIENT_NAME_RE.test(String(value || ''))) throw new Error('bad_name');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseDump(output, wgIf) {
  const map = new Map();
  const nowSec = Math.floor(Date.now() / 1000);

  for (const line of String(output || '').split('\n').filter(Boolean)) {
    const parts = line.split('\t');
    if (parts.length < 8 || parts[0] === wgIf) continue;

    const pub = parts[0];
    const latestTs = Number(parts[4] || 0);
    const delta = latestTs ? Math.max(0, nowSec - latestTs) : 0;

    map.set(pub, {
      endpoint: parts[2] === '(none)' ? '' : parts[2],
      allowed: parts[3],
      latest_ts: latestTs,
      latest: latestTs > 0 ? `${delta}s ago` : 'no handshake',
      rx: Number(parts[5] || 0),
      tx: Number(parts[6] || 0),
      online: latestTs > 0 && delta < 180,
    });
  }

  return map;
}

function appendPeerBlock(wgConf, { name, pub, ip, psk }) {
  const block = `${MARK_BEGIN} name="${name}" pub="${pub}"]
[Peer]
PublicKey = ${pub}
PresharedKey = ${psk}
AllowedIPs = ${ip}/32
${MARK_END}
`;
  fs.appendFileSync(wgConf, `\n${block}`, { mode: 0o600 });
}

function removePeerBlock(wgConf, pub) {
  let conf = fs.readFileSync(wgConf, 'utf8').replace(/\r\n/g, '\n');
  const regex = new RegExp(
    `# \\[WG-DASHBOARD BEGIN[^\\n]*?pub="${escapeRegExp(pub)}"\\][\\s\\S]*?# \\[WG-DASHBOARD END\\]\\s*`,
    'gm'
  );
  conf = conf.replace(regex, '').replace(/\n{3,}/g, '\n\n').trim();
  fs.writeFileSync(wgConf, `${conf}\n`, { mode: 0o600 });
}

function updatePeerAllowedIp(wgConf, pub, allowedIp) {
  let conf = fs.readFileSync(wgConf, 'utf8').replace(/\r\n/g, '\n');
  const regex = new RegExp(
    `(# \\[WG-DASHBOARD BEGIN[^\\n]*?pub="${escapeRegExp(pub)}"\\][\\s\\S]*?AllowedIPs = )[^\\n]*(\\n[\\s\\S]*?# \\[WG-DASHBOARD END\\])`,
    'm'
  );
  let changed = false;
  conf = conf.replace(regex, (_match, before, after) => {
    changed = true;
    return `${before}${allowedIp}${after}`;
  });
  if (changed) fs.writeFileSync(wgConf, `${conf.trim()}\n`, { mode: 0o600 });
  return changed;
}

function withTempKeyFile(content, fn) {
  const file = path.join(os.tmpdir(), `wg-dashboard-${process.pid}-${Date.now()}.key`);
  fs.writeFileSync(file, `${content}\n`, { mode: 0o600 });
  try {
    return fn(file);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

function createWireGuard(config) {
  assertInterface(config.wgIf);

  function show(args = []) {
    return runFile('wg', ['show', config.wgIf, ...args]);
  }

  return {
    assertClientName,
    assertPublicKey,
    generatePrivateKey() {
      return runFile('wg', ['genkey']);
    },
    derivePublicKey(privateKey) {
      return runFile('wg', ['pubkey'], { input: privateKey });
    },
    generatePresharedKey() {
      return runFile('wg', ['genpsk']);
    },
    addPeerRuntime({ pub, psk, ip }) {
      assertPublicKey(pub);
      return withTempKeyFile(psk, (pskFile) => {
        runFile('wg', [
          'set',
          config.wgIf,
          'peer',
          pub,
          'preshared-key',
          pskFile,
          'allowed-ips',
          `${ip}/32`,
        ]);
      });
    },
    blockPeer(pub) {
      assertPublicKey(pub);
      runFile('wg', ['set', config.wgIf, 'peer', pub, 'allowed-ips', '0.0.0.0/32']);
    },
    unblockPeer(pub, ip) {
      assertPublicKey(pub);
      runFile('wg', ['set', config.wgIf, 'peer', pub, 'allowed-ips', `${ip}/32`]);
    },
    removePeer(pub) {
      assertPublicKey(pub);
      runFile('wg', ['set', config.wgIf, 'peer', pub, 'remove']);
    },
    appendPeerBlock(peer) {
      appendPeerBlock(config.wgConf, peer);
    },
    removePeerBlock(pub) {
      removePeerBlock(config.wgConf, pub);
    },
    updatePeerAllowedIp(pub, allowedIp) {
      return updatePeerAllowedIp(config.wgConf, pub, allowedIp);
    },
    dump() {
      try {
        return parseDump(show(['dump']), config.wgIf);
      } catch {
        return new Map();
      }
    },
    status() {
      try {
        return show();
      } catch (error) {
        return commandErrorMessage(error, 'wg');
      }
    },
    qrPng(file) {
      return runFileBuffer('qrencode', ['-t', 'PNG', '-o', '-', '-r', file]);
    },
    restart() {
      runFile('wg-quick', ['down', config.wgIf]);
      runFile('wg-quick', ['up', config.wgIf]);
      return 'restarted';
    },
    ensureStarted() {
      if (!config.autoStartWg) return;
      try {
        const output = show();
        if (!output.includes('interface:')) runFile('wg-quick', ['up', config.wgIf]);
      } catch {
        try {
          runFile('wg-quick', ['up', config.wgIf]);
        } catch (error) {
          console.error('Не удалось поднять интерфейс:', error.message);
        }
      }
    },
  };
}

module.exports = {
  createWireGuard,
  parseDump,
  updatePeerAllowedIp,
};
