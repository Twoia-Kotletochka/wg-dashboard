function createSerialQueue() {
  let current = Promise.resolve();

  return function runSerial(task) {
    const next = current.then(task, task);
    current = next.catch(() => {});
    return next;
  };
}

module.exports = {
  createSerialQueue,
};
