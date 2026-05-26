const assert = require('node:assert/strict');
const path = require('path');
const test = require('node:test');

const { loadConfig, parseBoolean, splitCsv } = require('../src/config');

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
  const config = loadConfig({ PORT: '12345', BASE_DIR: 'runtime' }, root);

  assert.equal(config.port, 12345);
  assert.equal(config.wgIf, 'wg0');
  assert.equal(config.baseDir, path.join(root, 'runtime'));
});
