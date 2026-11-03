const test = require('node:test');
const assert = require('node:assert/strict');
const SerialService = require('../serialService');

test('serial service defaults to the Intellibox-compatible baud rate', () => {
  const service = new SerialService('/dev/null');
  assert.equal(service.baudRate, 57600);
});

test('P50X locomotive packet uses a five-byte XLok command for locomotive 242 forward speed 27', () => {
  const service = new SerialService('/dev/null');
  const packet = service.buildLocomotivePacket({ decoderId: 242, speed: 27, direction: 'forward', stop: false });
  assert.deepEqual(packet, [0x80, 0xF2, 0x00, 0x1B, 0x20]);
  assert.deepEqual(service.lastPacket, packet);
});
