const test = require('node:test');
const assert = require('node:assert/strict');
const SerialService = require('../serialService');
const FeedbackPoller = require('../feedbackPoller');

// Serial service with a fake port. `respond(packet)` returns the bytes the
// "Intellibox" answers; they are delivered in small chunks to test reassembly.
const fakeIntellibox = (respond, protocol) => {
  if (protocol) process.env.INTELLIBOX_PROTOCOL = protocol;
  process.env.SMARTRAILCONTROL_SERIAL_DISABLED = '1';
  const service = new SerialService('/dev/null');
  delete process.env.SMARTRAILCONTROL_SERIAL_DISABLED;
  delete process.env.INTELLIBOX_PROTOCOL;
  service.disabled = false;
  const written = [];
  let line = Promise.resolve(); // one serial line: replies arrive one after another
  service.connection = {
    isOpen: true,
    write: (buffer, callback) => {
      const packet = [...buffer];
      written.push(packet);
      callback();
      const reply = respond(packet) || [];
      // Deliver one byte at a time, asynchronously.
      reply.forEach((byte) => {
        line = line.then(() => new Promise((resolve) => setTimeout(resolve, 1))).then(() => service.handleData(Buffer.from([byte])));
      });
    }
  };
  return { service, written };
};

const quietLogs = () => {
  const log = console.log;
  console.log = () => {};
  return () => {
    console.log = log;
  };
};

test('decodeModule: bit 7 of the first byte is the first contact of the module', () => {
  const contacts = FeedbackPoller.decodeModule(2, [0b10000000, 0b00000001]);
  assert.deepEqual(contacts[0], [17, true]);
  assert.deepEqual(contacts[1], [18, false]);
  assert.deepEqual(contacts[15], [32, true]);
});

test('reply readers frame variable-length P50X replies', () => {
  const { event, sensorEvents, sensor } = SerialService.REPLY_READERS;
  assert.equal(event([0x84]), 0);
  assert.equal(event([0x84, 0x01]), 2);
  assert.equal(sensorEvents([1, 0x80]), 0);
  assert.equal(sensorEvents([1, 0x80, 0x00, 0]), 4);
  assert.equal(sensorEvents([0]), 1);
  assert.equal(sensor([0x02]), 1);
  assert.equal(sensor([0x00, 0x01]), 0);
  assert.equal(sensor([0x00, 0x01, 0x02]), 3);
});

test('replies are matched in order, also with turnout commands in between', async () => {
  const restore = quietLogs();
  const { service } = fakeIntellibox((packet) => {
    if (packet[1] === 0x98) return [0x00, packet[2] === 1 ? 0x40 : 0x00, 0x01]; // XSensor
    if (packet[1] === 0x90) return [0x00]; // XTrnt OK
    return [];
  });
  const [first, , second] = await Promise.all([
    service.readSensorModule(1),
    service.writePacket(service.buildAccessoryPacket({ address: 3, color: 'green', on: true })),
    service.readSensorModule(2)
  ]);
  restore();
  assert.deepEqual(first, [0x40, 0x01]);
  assert.deepEqual(second, [0x00, 0x01]);
  assert.equal(service.pendingReplies.length, 0);
});

test('P50X poller: silent initial read, then reports changes from XEvtSen', async () => {
  const restore = quietLogs();
  let events = [];
  const { service, written } = fakeIntellibox((packet) => {
    if (packet[1] === 0x98) return packet[2] === 1 ? [0x00, 0x80, 0x00] : [0x00, 0x00, 0x00]; // contact 1 occupied
    if (packet[1] === 0xc8) return events.length ? [0x04] : [0x00];
    if (packet[1] === 0xcb) {
      const reply = [...events.flat(), 0];
      events = [];
      return reply;
    }
    return [];
  });
  const changes = [];
  const poller = new FeedbackPoller({ serial: service, getModuleCount: () => 2, onChange: (c) => changes.push(c) });

  await poller.poll();
  assert.deepEqual(changes, [{ contact: 1, on: true, initial: true }]);
  assert.deepEqual(written.slice(0, 2), [[0x58, 0x98, 1], [0x58, 0x98, 2]]);

  await poller.poll(); // nothing pending
  assert.equal(changes.length, 1);

  events = [[1, 0x00, 0x00], [2, 0x00, 0x01]]; // contact 1 free, contact 32 on
  await poller.poll();
  restore();
  assert.deepEqual(changes.slice(1), [
    { contact: 1, on: false, initial: false },
    { contact: 32, on: true, initial: false }
  ]);
  poller.running = true; // as after start(), without the timer
  assert.equal(poller.getStatus().state, 'live');
});

test('legacy P50 poller reads modules 1..n with 0x80 + n', async () => {
  const restore = quietLogs();
  let second = 0x00;
  const { service, written } = fakeIntellibox((packet) => (packet[0] === 0x82 ? [0, 0, second, 0] : []), 'P50');
  const changes = [];
  const poller = new FeedbackPoller({ serial: service, getModuleCount: () => 2, onChange: (c) => changes.push(c) });
  await poller.poll();
  second = 0x20; // contact 19
  await poller.poll();
  restore();
  assert.deepEqual(written[0], [0x82]);
  assert.deepEqual(changes, [{ contact: 19, on: true, initial: false }]);
});

test('a missing reply times out and the next request still works', async () => {
  const restore = quietLogs();
  let answer = false;
  const { service } = fakeIntellibox(() => (answer ? [0x00, 0x00, 0x00] : []));
  await assert.rejects(service.readSensorModule(1), /No reply/);
  answer = true;
  assert.deepEqual(await service.readSensorModule(1), [0x00, 0x00]);
  restore();
});

test('stray bytes from the Intellibox: changes are dropped and no rule-firing change is reported', async () => {
  const restore = quietLogs();
  let stray = false;
  const { service } = fakeIntellibox((packet) => {
    if (packet[1] === 0x98) return [0x00, 0x00, 0x00];
    if (packet[1] === 0xc8) return [0x04];
    if (packet[1] === 0xcb) {
      // Misread module (contacts 1-13, 16), followed by stray bytes.
      if (stray) setTimeout(() => service.handleData(Buffer.from([0xa4, 0x40])), 25); // after the reply, within the guard time
      return [1, 0xff, 0xf9, 0];
    }
    return [];
  });
  const changes = [];
  const poller = new FeedbackPoller({ serial: service, getModuleCount: () => 1, onChange: (c) => changes.push(c) });
  await poller.poll(); // initial read: all free
  stray = true;
  await assert.rejects(poller.poll(), /unexpected data/);
  restore();
  assert.deepEqual(changes, []);
});

test('an XEvtSen reply naming a module that is not read is rejected', async () => {
  const restore = quietLogs();
  const { service } = fakeIntellibox((packet) => {
    if (packet[1] === 0x98) return [0x00, 0x00, 0x00];
    if (packet[1] === 0xc8) return [0x04];
    if (packet[1] === 0xcb) return [0x07, 0x80, 0x00, 0];
    return [];
  });
  const changes = [];
  const poller = new FeedbackPoller({ serial: service, getModuleCount: () => 1, onChange: (c) => changes.push(c) });
  await poller.poll();
  await assert.rejects(poller.poll(), /out of step/);
  restore();
  assert.deepEqual(changes, []);
});

test('settle waits until the line is quiet, then drops what is left', async () => {
  const { service } = fakeIntellibox(() => []);
  service.lastRxAt = Date.now();
  service.rxBuffer = [0xff];
  const start = Date.now();
  await service.settle({ quietMs: 60 });
  assert.ok(Date.now() - start >= 50);
  assert.deepEqual(service.rxBuffer, []);
  service.lastRxAt = Date.now();
  const noise = setInterval(() => (service.lastRxAt = Date.now()), 10);
  await assert.rejects(service.settle({ quietMs: 60, maxMs: 150 }), /keeps sending/);
  clearInterval(noise);
});
