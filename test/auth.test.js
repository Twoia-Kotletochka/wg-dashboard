const assert = require('node:assert/strict');
const test = require('node:test');

const { parseBasicAuth, verifyBasicAuth } = require('../src/auth');

function basic(user, pass) {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

test('parseBasicAuth decodes valid credentials', () => {
  assert.deepEqual(parseBasicAuth(basic('admin', 'secret')), {
    user: 'admin',
    pass: 'secret',
  });
});

test('verifyBasicAuth rejects malformed or wrong credentials', () => {
  assert.equal(verifyBasicAuth('', 'admin', 'secret'), false);
  assert.equal(verifyBasicAuth('Basic not-base64', 'admin', 'secret'), false);
  assert.equal(verifyBasicAuth(basic('admin', 'wrong'), 'admin', 'secret'), false);
  assert.equal(verifyBasicAuth(basic('admin', 'secret'), 'admin', 'secret'), true);
});
