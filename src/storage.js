const fs = require('fs');
const path = require('path');

function readJsonArray(file) {
  try {
    const content = fs.readFileSync(file, 'utf8').trim();
    if (!content) return [];
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value || [], null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function createStorage(baseDir) {
  const dataDir = path.resolve(baseDir, 'data');
  const clientsDir = path.resolve(dataDir, 'clients');
  const peersFile = path.resolve(dataDir, 'peers.json');

  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(clientsDir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(peersFile)) writeJsonAtomic(peersFile, []);

  return {
    dataDir,
    clientsDir,
    peersFile,
    loadPeers() {
      return readJsonArray(peersFile);
    },
    savePeers(peers) {
      writeJsonAtomic(peersFile, peers);
    },
    clientConfigPath(name) {
      return path.join(clientsDir, `${name}.conf`);
    },
  };
}

module.exports = {
  createStorage,
  readJsonArray,
  writeJsonAtomic,
};
