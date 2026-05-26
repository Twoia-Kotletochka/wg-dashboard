const assert = require('node:assert/strict');
const test = require('node:test');

const { createSerialQueue } = require('../src/mutation-queue');

test('createSerialQueue runs concurrent tasks one at a time', async () => {
  const runSerial = createSerialQueue();
  let active = 0;
  let maxActive = 0;
  const order = [];

  async function task(id) {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push(`start:${id}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push(`end:${id}`);
    active -= 1;
  }

  await Promise.all([
    runSerial(() => task(1)),
    runSerial(() => task(2)),
    runSerial(() => task(3)),
  ]);

  assert.equal(maxActive, 1);
  assert.deepEqual(order, ['start:1', 'end:1', 'start:2', 'end:2', 'start:3', 'end:3']);
});
