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

test('stores a track layout and validates elements', () => {
  const file = tmpFile();
  const store = new SettingsStore(file);
  assert.deepEqual(store.getLayout(), { cols: 20, rows: 12, tiles: [] });

  store.setLayout({
    cols: 10,
    rows: 6,
    tiles: [
      { id: 't1', type: 'straight', x: 0, y: 0, rotation: 90 },
      { id: 't2', type: 'turnout-left', x: 9, y: 5, rotation: 45 }
    ]
  });
  const reloaded = new SettingsStore(file).getLayout();
  assert.equal(reloaded.cols, 10);
  assert.deepEqual(reloaded.tiles[1], { id: 't2', type: 'turnout-left', x: 9, y: 5, rotation: 0, state: 'straight' });

  assert.throws(() => store.setLayout({ cols: 10, rows: 6, tiles: [{ type: 'bridge', x: 0, y: 0 }] }));
  assert.throws(() => store.setLayout({ cols: 10, rows: 6, tiles: [{ type: 'curve', x: 10, y: 0 }] }));
  assert.throws(() => store.setLayout({
    cols: 10, rows: 6, tiles: [{ type: 'curve', x: 1, y: 1 }, { type: 'straight', x: 1, y: 1 }]
  }));
  assert.throws(() => store.setLayout({ cols: 2, rows: 6, tiles: [] }));
});

test('keeps switch and signal states, defaults invalid ones', () => {
  const store = new SettingsStore(tmpFile());
  const { tiles } = store.setLayout({
    cols: 6,
    rows: 6,
    tiles: [
      { id: 'a', type: 'turnout-right', x: 0, y: 0, state: 'diverging' },
      { id: 'b', type: 'double-slip', x: 1, y: 0, state: 'bogus' },
      { id: 'c', type: 'signal', x: 2, y: 0, state: 'go' },
      { id: 'd', type: 'straight', x: 3, y: 0, state: 'go' },
      { id: 'e', type: 'buffer', x: 4, y: 0 },
      { id: 'f', type: 'crossing', x: 5, y: 0 }
    ]
  });
  assert.deepEqual(tiles.map((t) => t.state), ['diverging', 'straight', 'go', undefined, undefined, undefined]);
});
