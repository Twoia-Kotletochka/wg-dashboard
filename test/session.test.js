const assert = require('node:assert/strict');
const test = require('node:test');

const { createSessionStore, parseCookies, serializeCookie } = require('../src/session');

test('parseCookies extracts named cookie values', () => {
  assert.deepEqual(parseCookies('a=1; session=abc%20123; empty='), {
    a: '1',
    session: 'abc 123',
    empty: '',
  });
  assert.equal(parseCookies('bad=%E0%A4%A').bad, '%E0%A4%A');
});

test('serializeCookie formats httpOnly session cookie', () => {
  assert.equal(
    serializeCookie('session', 'abc 123', {
      httpOnly: true,
      maxAge: 60,
      path: '/',
      sameSite: 'Strict',
      secure: true,
    }),
    'session=abc%20123; Max-Age=60; Path=/; HttpOnly; Secure; SameSite=Strict'
  );
});

test('createSessionStore verifies and expires sessions', () => {
  let now = 1000;
  const store = createSessionStore({ ttlMs: 100, now: () => now });
  const session = store.create('admin');

  assert.equal(store.verify(session.token), true);
  now = 1101;
  assert.equal(store.verify(session.token), false);
});
