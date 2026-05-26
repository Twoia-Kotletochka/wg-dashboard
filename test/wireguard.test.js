const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { parseDump, updatePeerAllowedIp } = require('../src/wireguard');

test('parseDump maps peer rows and skips interface row', () => {
  const output = [
    'wg0\tprivate\tpublic\t51820\toff',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=\tpsk\t198.51.100.1:51820\t10.0.70.2/32\t0\t100\t200\ton',
  ].join('\n');

  const peers = parseDump(output, 'wg0');
  const peer = peers.get('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=');

  assert.equal(peers.size, 1);
  assert.equal(peer.endpoint, '198.51.100.1:51820');
  assert.equal(peer.allowed, '10.0.70.2/32');
  assert.equal(peer.rx, 100);
  assert.equal(peer.tx, 200);
  assert.equal(peer.online, false);
});

test('updatePeerAllowedIp persists block state in managed config block', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-dashboard-test-'));
  const file = path.join(dir, 'wg0.conf');
  const pub = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=';

  fs.writeFileSync(file, `# [WG-DASHBOARD BEGIN name="phone" pub="${pub}"]
[Peer]
PublicKey = ${pub}
PresharedKey = psk
AllowedIPs = 10.0.70.2/32
# [WG-DASHBOARD END]
`);

  assert.equal(updatePeerAllowedIp(file, pub, '0.0.0.0/32'), true);
  assert.match(fs.readFileSync(file, 'utf8'), /AllowedIPs = 0\.0\.0\.0\/32/);

  fs.rmSync(dir, { recursive: true, force: true });
});
