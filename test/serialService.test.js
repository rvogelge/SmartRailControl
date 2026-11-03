const test = require('node:test');
const assert = require('node:assert/strict');
const SerialService = require('../serialService');

const createService = (protocol) => {
  if (protocol) {
    process.env.INTELLIBOX_PROTOCOL = protocol;
  } else {
    delete process.env.INTELLIBOX_PROTOCOL;
  }
  const service = new SerialService('/dev/null');
  delete process.env.INTELLIBOX_PROTOCOL;
  return service;
};

test('serial service defaults to an Intellibox-supported baud rate', () => {
  const service = createService();
  assert.equal(service.baudRate, 19200);
  assert.ok(SerialService.SUPPORTED_BAUD_RATES.includes(service.baudRate));
});

test('P50Xb XLok packet has the X prefix for locomotive 242 forward speed 27', () => {
  const service = createService();
  const packet = service.buildLocomotivePacket({ decoderId: 242, speed: 27, direction: 'forward', stop: false });
  assert.deepEqual(packet, [0x58, 0x80, 0xF2, 0x00, 0x1C, 0x20]);
  assert.deepEqual(service.lastPacket, packet);
});

test('P50X speed 1 is never sent for a normal speed command (1 = emergency stop)', () => {
  const service = createService();
  assert.equal(service.buildLocomotivePacket({ decoderId: 3, speed: 1, direction: 'forward' })[4], 0x02);
  assert.equal(service.buildLocomotivePacket({ decoderId: 3, speed: 126, direction: 'forward' })[4], 0x7F);
  assert.equal(service.buildLocomotivePacket({ decoderId: 3, speed: 500, direction: 'forward' })[4], 0x7F);
});

test('P50X stop, emergency stop and reverse', () => {
  const service = createService();
  assert.deepEqual(service.buildLocomotivePacket({ decoderId: 3, speed: 50, direction: 'reverse', stop: true }), [0x58, 0x80, 0x03, 0x00, 0x00, 0x00]);
  assert.deepEqual(service.buildLocomotivePacket({ decoderId: 3, speed: 50, direction: 'forward', emergency: true }), [0x58, 0x80, 0x03, 0x00, 0x01, 0x20]);
});

test('P50X encodes long addresses little-endian', () => {
  const service = createService();
  assert.deepEqual(service.buildLocomotivePacket({ decoderId: 1234, speed: 0, direction: 'forward' }).slice(0, 4), [0x58, 0x80, 0xD2, 0x04]);
});

test('legacy P50 uses two-byte commands and toggles direction with speed 15', () => {
  const service = createService('P50');
  assert.deepEqual(service.buildLocomotivePacket({ decoderId: 24, speed: 126, direction: 'forward' }), [14, 24]);
  assert.deepEqual(service.buildLocomotivePacket({ decoderId: 24, speed: 63, direction: 'reverse' }), [0, 24, 15, 24, 7, 24]);
  assert.deepEqual(service.buildLocomotivePacket({ decoderId: 24, speed: 63, direction: 'reverse' }), [7, 24]);
  assert.throws(() => service.buildLocomotivePacket({ decoderId: 81, speed: 0, direction: 'forward' }));
});

test('P50X XTrnt accessory packets: colour bit 7, on bit 6, 11-bit address', () => {
  const service = createService();
  assert.deepEqual(service.buildAccessoryPacket({ address: 12, color: 'red', on: true }), [0x58, 0x90, 0x0C, 0x40]);
  assert.deepEqual(service.buildAccessoryPacket({ address: 12, color: 'green', on: true }), [0x58, 0x90, 0x0C, 0xC0]);
  assert.deepEqual(service.buildAccessoryPacket({ address: 12, color: 'green', on: false }), [0x58, 0x90, 0x0C, 0x80]);
  assert.deepEqual(service.buildAccessoryPacket({ address: 1025, color: 'red', on: true }), [0x58, 0x90, 0x01, 0x44]);
  assert.throws(() => service.buildAccessoryPacket({ address: 0, color: 'red', on: true }));
  assert.throws(() => service.buildAccessoryPacket({ address: 2048, color: 'red', on: true }));
});

test('legacy P50 accessory packets: 33 green, 34 red, 32 off', () => {
  const service = createService('P50');
  assert.deepEqual(service.buildAccessoryPacket({ address: 5, color: 'green', on: true }), [0x21, 5]);
  assert.deepEqual(service.buildAccessoryPacket({ address: 5, color: 'red', on: true }), [0x22, 5]);
  assert.deepEqual(service.buildAccessoryPacket({ address: 5, color: 'red', on: false }), [0x20]);
});

test('accessory commands switch each output on, then off, in order and queued', async () => {
  const service = createService();
  service.switchTimeMs = 5;
  const writes = [];
  service.connection = { isOpen: true, write: (buffer, callback) => { writes.push([...buffer]); callback(); } };

  const [first, second] = await Promise.all([
    service.sendAccessoryCommands([{ address: 3, color: 'green' }, { address: 4, color: 'red' }]),
    service.sendAccessoryCommands([{ address: 9, color: 'red' }])
  ]);
  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.deepEqual(writes, [
    [0x58, 0x90, 3, 0xC0], [0x58, 0x90, 3, 0x80],
    [0x58, 0x90, 4, 0x40], [0x58, 0x90, 4, 0x00],
    [0x58, 0x90, 9, 0x40], [0x58, 0x90, 9, 0x00]
  ]);
});

test('accessory commands report an error when the port is not open', async () => {
  const service = createService();
  service.connection = null;
  const result = await service.sendAccessoryCommands([{ address: 3, color: 'green' }]);
  assert.equal(result.success, false);
  assert.match(result.error, /not open/);
});
