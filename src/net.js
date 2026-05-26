function normalizeIp(value) {
  let ip = String(value || '').trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') ip = '127.0.0.1';
  return ip;
}

function ipv4ToInt(value) {
  const ip = normalizeIp(value);
  const parts = ip.split('.');
  if (parts.length !== 4) throw new Error(`Invalid IPv4 address: ${value}`);

  return parts.reduce((acc, part) => {
    if (!/^\d{1,3}$/.test(part)) throw new Error(`Invalid IPv4 address: ${value}`);
    const octet = Number(part);
    if (octet < 0 || octet > 255) throw new Error(`Invalid IPv4 address: ${value}`);
    return ((acc << 8) + octet) >>> 0;
  }, 0);
}

function intToIpv4(value) {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ].join('.');
}

function parseCidr(value) {
  const [ip, prefixValue] = String(value || '').split('/');
  const prefix = Number(prefixValue);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`Invalid CIDR prefix: ${value}`);
  }

  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = ipv4ToInt(ip) & mask;
  const size = 2 ** (32 - prefix);
  return { network, prefix, mask, broadcast: (network + size - 1) >>> 0, size };
}

function ipInCidr(ip, cidr) {
  const parsed = parseCidr(cidr);
  return (ipv4ToInt(ip) & parsed.mask) === parsed.network;
}

function allowedIpMatches(ip, rules, vpnCidr) {
  const normalized = normalizeIp(ip);
  if (normalized === '127.0.0.1') return true;

  const matchesRule = rules.some((rule) => {
    if (rule.includes('/')) return ipInCidr(normalized, rule);
    return normalizeIp(rule) === normalized;
  });

  return matchesRule || ipInCidr(normalized, vpnCidr);
}

function nextIpFromPeers(vpnCidr, peers) {
  const parsed = parseCidr(vpnCidr);
  if (parsed.prefix > 30) throw new Error(`WG_NET has no usable client addresses: ${vpnCidr}`);

  const used = new Set((peers || []).map((peer) => peer.ip).filter(Boolean));
  const firstClient = parsed.network + 2;
  const lastClient = parsed.broadcast - 1;
  const maxScan = Math.min(lastClient, firstClient + 65533);

  for (let candidate = firstClient; candidate <= maxScan; candidate += 1) {
    const ip = intToIpv4(candidate >>> 0);
    if (!used.has(ip)) return ip;
  }

  throw new Error('Свободных IP больше нет');
}

module.exports = {
  allowedIpMatches,
  intToIpv4,
  ipInCidr,
  ipv4ToInt,
  nextIpFromPeers,
  normalizeIp,
  parseCidr,
};
