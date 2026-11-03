const test = require('node:test');
const assert = require('node:assert/strict');
const SerialService = require('../serialService');

test('serial service defaults to the Intellibox-compatible baud rate', () => {
  const service = new SerialService('/dev/null');
  assert.equal(service.baudRate, 57600);
});

test('locomotive packet uses a valid DCC-like speed command', () => {
  const service = new SerialService('/dev/null');
  const packet = service.buildLocomotivePacket({ decoderId: 3, speed: 50, direction: 'forward', stop: false });
  assert.deepEqual(packet, [0x83, 0x59, 0x00]);
  assert.deepEqual(service.lastPacket, packet);
});
