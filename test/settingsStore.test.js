const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SettingsStore = require('../settingsStore');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'birdrail-')), 'settings.json');

test('creates a default controller when no settings file exists', () => {
  const store = new SettingsStore(tmpFile());
  const { controllers, activeControllerId } = store.getControllers();
  assert.equal(controllers.length, 1);
  assert.equal(controllers[0].decoderId, 3);
  assert.equal(activeControllerId, controllers[0].id);
});

test('persists controllers and serial settings across instances', () => {
  const file = tmpFile();
  const store = new SettingsStore(file);
  store.setControllers({
    controllers: [
      { id: 'a', name: 'BR 218', decoderId: 242, speed: 40, direction: 'reverse' },
      { id: 'b', name: 'V 100', decoderId: 12, speed: 0, direction: 'forward' }
    ],
    activeControllerId: 'b'
  });
  store.setSerial({ portName: '/dev/ttyUSB1', baudRate: 2400 });

  const reloaded = new SettingsStore(file);
  assert.deepEqual(reloaded.getControllers().controllers[0], { id: 'a', name: 'BR 218', decoderId: 242, speed: 40, direction: 'reverse' });
  assert.equal(reloaded.getControllers().activeControllerId, 'b');
  assert.deepEqual(reloaded.getSerial(), { portName: '/dev/ttyUSB1', baudRate: 2400 });
});

test('sanitizes speed and direction, rejects bad decoder IDs and empty lists', () => {
  const store = new SettingsStore(tmpFile());
  const { controllers } = store.setControllers({
    controllers: [{ id: 'x', name: '', decoderId: 5, speed: 999, direction: 'sideways' }]
  });
  assert.deepEqual(controllers[0], { id: 'x', name: 'Locomotive 5', decoderId: 5, speed: 126, direction: 'forward' });
  assert.throws(() => store.setControllers({ controllers: [{ decoderId: 0 }] }));
  assert.throws(() => store.setControllers({ controllers: [] }));
});
