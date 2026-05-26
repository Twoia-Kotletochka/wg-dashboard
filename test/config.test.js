const assert = require('node:assert/strict');
const path = require('path');
const test = require('node:test');

const { loadConfig, normalizeBasePath, parseBoolean, publicUrlBasePath, splitCsv } = require('../src/config');

test('splitCsv trims empty values', () => {
  assert.deepEqual(splitCsv(' 1.1.1.1, ,2.2.2.2 '), ['1.1.1.1', '2.2.2.2']);
});

test('parseBoolean supports common enabled values and defaults', () => {
  assert.equal(parseBoolean(undefined, true), true);
  assert.equal(parseBoolean('false', true), false);
  assert.equal(parseBoolean('0', true), false);
  assert.equal(parseBoolean('yes', false), true);
  assert.throws(() => parseBoolean('maybe', true), /Invalid boolean/);
});

test('loadConfig applies defaults and resolves BASE_DIR', () => {
  const root = path.join('/tmp', 'wg-dashboard-root');
  const config = loadConfig({
    BASE_DIR: 'runtime',
    PORT: '12345',
    PUBLIC_URL: 'https://vpn.example.com/wg-easy',
  }, root);

  assert.equal(config.port, 12345);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.wgIf, 'wg0');
  assert.equal(config.baseDir, path.join(root, 'runtime'));
  assert.equal(config.publicBasePath, '/wg-easy');
});

test('normalizes public base path', () => {
  assert.equal(normalizeBasePath(''), '');
  assert.equal(normalizeBasePath('/'), '');
  assert.equal(normalizeBasePath('wg-easy/'), '/wg-easy');
  assert.equal(publicUrlBasePath('https://vpn.example.com/wg-easy/'), '/wg-easy');
  assert.throws(() => normalizeBasePath('/bad path'), /Invalid PUBLIC_BASE_PATH/);
});
