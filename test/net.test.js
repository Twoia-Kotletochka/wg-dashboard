const assert = require('node:assert/strict');
const test = require('node:test');

const {
  allowedIpMatches,
  intToIpv4,
  ipInCidr,
  ipv4ToInt,
  nextIpFromPeers,
  normalizeIp,
  parseCidr,
} = require('../src/net');

test('normalizes IPv4-mapped and loopback addresses', () => {
  assert.equal(normalizeIp('::ffff:10.0.70.5'), '10.0.70.5');
  assert.equal(normalizeIp('::1'), '127.0.0.1');
});

test('converts IPv4 addresses to integers and back', () => {
  assert.equal(intToIpv4(ipv4ToInt('10.0.70.5')), '10.0.70.5');
});

test('checks CIDR membership', () => {
  assert.equal(ipInCidr('10.0.70.99', '10.0.70.0/24'), true);
  assert.equal(ipInCidr('10.0.71.1', '10.0.70.0/24'), false);
});

test('parses CIDR network boundaries and prefix', () => {
  assert.deepEqual(parseCidr('10.0.70.0/24'), {
    network: ipv4ToInt('10.0.70.0'),
    prefix: 24,
    mask: ipv4ToInt('255.255.255.0'),
    broadcast: ipv4ToInt('10.0.70.255'),
    size: 256,
  });
});

test('allows localhost, configured IPs, configured CIDRs, and VPN CIDR', () => {
  assert.equal(allowedIpMatches('127.0.0.1', [], '10.0.70.0/24'), true);
  assert.equal(allowedIpMatches('203.0.113.10', ['203.0.113.10'], '10.0.70.0/24'), true);
  assert.equal(allowedIpMatches('198.51.100.7', ['198.51.100.0/24'], '10.0.70.0/24'), true);
  assert.equal(allowedIpMatches('10.0.70.2', [], '10.0.70.0/24'), true);
  assert.equal(allowedIpMatches('192.0.2.5', [], '10.0.70.0/24'), false);
});

test('finds the next available client IP', () => {
  assert.equal(nextIpFromPeers('10.0.70.0/24', []), '10.0.70.2');
  assert.equal(
    nextIpFromPeers('10.0.70.0/24', [{ ip: '10.0.70.2' }, { ip: '10.0.70.3' }]),
    '10.0.70.4'
  );
});
