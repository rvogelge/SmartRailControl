const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SettingsStore = require('../settingsStore');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'smartrailcontrol-')), 'settings.json');

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
  assert.deepEqual(reloaded.getControllers().controllers[0], { id: 'a', name: 'BR 218', decoderId: 242, speed: 40, direction: 'reverse', functions: [false, false, false, false], light: false, maxSpeed: 126 });
  assert.equal(reloaded.getControllers().activeControllerId, 'b');
  assert.deepEqual(reloaded.getSerial(), { portName: '/dev/ttyUSB1', baudRate: 2400 });
});

test('sanitizes speed and direction, rejects bad decoder IDs and empty lists', () => {
  const store = new SettingsStore(tmpFile());
  const { controllers } = store.setControllers({
    controllers: [{ id: 'x', name: '', decoderId: 5, speed: 999, direction: 'sideways' }]
  });
  assert.deepEqual(controllers[0], { id: 'x', name: 'Locomotive 5', decoderId: 5, speed: 126, direction: 'forward', functions: [false, false, false, false], light: false, maxSpeed: 126 });
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
  assert.deepEqual(reloaded.tiles[1], { id: 't2', type: 'turnout-left', x: 9, y: 5, rotation: 0, state: 'straight', addresses: [null] });

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

test('accepts 45° track elements', () => {
  const store = new SettingsStore(tmpFile());
  const types = ['diagonal', 'curve-45-left', 'curve-45-right', 'crossing-45'];
  const { tiles } = store.setLayout({
    cols: 6,
    rows: 6,
    tiles: types.map((type, i) => ({ id: `n${i}`, type, x: i, y: 0, rotation: 90 }))
  });
  assert.deepEqual(tiles.map((t) => t.type), types);
});

test('stores decoder addresses per element and validates them', () => {
  const store = new SettingsStore(tmpFile());
  const { tiles } = store.setLayout({
    cols: 6,
    rows: 6,
    tiles: [
      { id: 'a', type: 'turnout-right', x: 0, y: 0, addresses: [12] },
      { id: 'b', type: 'double-slip', x: 1, y: 0, addresses: ['7', 8] },
      { id: 'c', type: 'contact', x: 2, y: 0, addresses: [101, 999] },
      { id: 'd', type: 'straight', x: 3, y: 0, addresses: [5] }
    ]
  });
  assert.deepEqual(tiles.map((t) => t.addresses), [[12], [7], [101], undefined]);
  assert.throws(() => store.setLayout({ cols: 6, rows: 6, tiles: [{ type: 'signal', x: 0, y: 0, addresses: [0] }] }));
  assert.throws(() => store.setLayout({ cols: 6, rows: 6, tiles: [{ type: 'signal', x: 0, y: 0, addresses: [2049] }] }));
});

test('R2 curve occupies three squares of its 2×2 block and leaves the inner corner free', () => {
  const store = new SettingsStore(tmpFile());
  // R2 at (0,0) rotation 0 uses (0,0), (1,0), (1,1); the R1 curve fits into (0,1).
  store.setLayout({
    cols: 6,
    rows: 6,
    tiles: [
      { id: 'r2', type: 'curve-r2', x: 0, y: 0 },
      { id: 'r1', type: 'curve', x: 0, y: 1 }
    ]
  });
  assert.throws(() => store.setLayout({
    cols: 6, rows: 6, tiles: [{ type: 'curve-r2', x: 0, y: 0 }, { type: 'straight', x: 1, y: 1 }]
  }), /More than one element/);
  // Rotated 90°: uses (1,0), (1,1), (0,1) of the block — (0,0) is free.
  store.setLayout({
    cols: 6, rows: 6, tiles: [{ type: 'curve-r2', x: 0, y: 0, rotation: 90 }, { type: 'straight', x: 0, y: 0 }]
  });
  assert.throws(() => store.setLayout({ cols: 6, rows: 6, tiles: [{ type: 'curve-r2', x: 5, y: 0 }] }), /outside/);
});

test('rejects duplicate decoder addresses within an address space', () => {
  const store = new SettingsStore(tmpFile());
  const base = { cols: 6, rows: 6 };
  // Turnout and signal share the accessory range.
  assert.throws(() => store.setLayout({ ...base, tiles: [
    { type: 'turnout-left', x: 0, y: 0, addresses: [5] },
    { type: 'signal', x: 1, y: 0, addresses: [5] }
  ] }), /Duplicate decoder addresses: accessory address 5/);
  // Both drives of one three-way turnout.
  assert.throws(() => store.setLayout({ ...base, tiles: [
    { type: 'turnout-3way', x: 0, y: 0, addresses: [9, 9] }
  ] }), /Duplicate/);
  // Contact numbers are a separate range, so contact 5 next to turnout 5 is fine.
  store.setLayout({ ...base, tiles: [
    { type: 'turnout-left', x: 0, y: 0, addresses: [5] },
    { type: 'contact', x: 1, y: 0, addresses: [5] },
    { type: 'uncoupler', x: 2, y: 0, addresses: [null] },
    { type: 'signal', x: 3, y: 0, addresses: [null] }
  ] });
});

test('state commands: three-way turnout resets the other drive first', () => {
  const TrackCatalog = require('../public/trackCatalog');
  assert.deepEqual(TrackCatalog.commandsFor('turnout-left', 'diverging'), [[0, 'red']]);
  assert.deepEqual(TrackCatalog.commandsFor('signal', 'go'), [[0, 'green']]);
  assert.deepEqual(TrackCatalog.commandsFor('turnout-3way', 'left'), [[1, 'green'], [0, 'red']]);
  assert.deepEqual(TrackCatalog.commandsFor('double-slip', 'turn'), [[0, 'red']]);
  assert.deepEqual(TrackCatalog.commandsFor('uncoupler', 'trigger'), [[0, 'green']]);
  assert.equal(TrackCatalog.commandsFor('contact', 'x'), null);
});

test('setTileState changes and saves only the state of one element', () => {
  const file = tmpFile();
  const store = new SettingsStore(file);
  store.setLayout({ cols: 6, rows: 6, tiles: [{ id: 's1', type: 'signal', x: 0, y: 0, addresses: [4] }] });
  assert.equal(store.setTileState('s1', 'go').state, 'go');
  assert.equal(new SettingsStore(file).getTile('s1').state, 'go');
  assert.throws(() => store.setTileState('s1', 'diverging'));
  assert.throws(() => store.setTileState('nope', 'go'));
});

test('keeps the F1-F4 function states of a controller', () => {
  const file = tmpFile();
  new SettingsStore(file).setControllers({
    controllers: [{ id: 'f', name: 'BR 50', decoderId: 50, functions: [true, 'yes', 0, true, true] }]
  });
  const [controller] = new SettingsStore(file).getControllers().controllers;
  assert.deepEqual(controller.functions, [true, true, false, true]);
});

test('saves, trims and removes decoder notes', () => {
  const file = tmpFile();
  const store = new SettingsStore(file);
  store.setDecoderNote(12, '  Entry turnout  ');
  store.setDecoderNote('7', 'Signal A');
  assert.deepEqual(new SettingsStore(file).getDecoderNotes(), { 7: 'Signal A', 12: 'Entry turnout' });
  store.setDecoderNote(7, '');
  assert.deepEqual(new SettingsStore(file).getDecoderNotes(), { 12: 'Entry turnout' });
  assert.throws(() => store.setDecoderNote(0, 'x'));
});

test('inverted drives swap green and red, per address', () => {
  const TrackCatalog = require('../public/trackCatalog');
  assert.deepEqual(TrackCatalog.commandsForTile({ type: 'turnout-left', invert: [true] }, 'straight'), [[0, 'red']]);
  assert.deepEqual(TrackCatalog.commandsForTile({ type: 'turnout-left' }, 'straight'), [[0, 'green']]);
  assert.deepEqual(TrackCatalog.commandsForTile({ type: 'turnout-3way', invert: [false, true] }, 'left'), [[1, 'red'], [0, 'red']]);
  assert.deepEqual(TrackCatalog.commandsForTile({ type: 'signal', invert: [true] }, 'go'), [[0, 'red']]);
  assert.equal(TrackCatalog.commandsForTile({ type: 'contact', invert: [true] }, 'on'), null);
  assert.equal(TrackCatalog.canInvert('turnout-right'), true);
  assert.equal(TrackCatalog.canInvert('contact'), false);
  assert.equal(TrackCatalog.canInvert('straight'), false);
});

test('the layout keeps inverted drives, only for actor elements', () => {
  const file = tmpFile();
  const store = new SettingsStore(file);
  store.setLayout({
    cols: 10,
    rows: 6,
    tiles: [
      { id: 'a', type: 'turnout-3way', x: 0, y: 0, addresses: [5, 6], invert: [false, 1] },
      { id: 'b', type: 'signal', x: 2, y: 0, invert: [false] },
      { id: 'c', type: 'contact', x: 4, y: 0, invert: [true] }
    ]
  });
  const tiles = new SettingsStore(file).getLayout().tiles;
  assert.deepEqual(tiles[0].invert, [false, true]);
  assert.equal('invert' in tiles[1], false);
  assert.equal('invert' in tiles[2], false);
});

test('locomotives: max speed caps the speed; driving state and selection are saved on their own', () => {
  const file = tmpFile();
  const store = new SettingsStore(file);
  store.setControllers({
    controllers: [{ id: 'a', name: 'V200', decoderId: 242, maxSpeed: 50, speed: 90 }, { id: 'b', name: 'Werkslok', decoderId: 40 }],
    activeControllerId: 'a'
  });
  const [v200, werkslok] = store.getControllers().controllers;
  assert.equal(v200.maxSpeed, 50);
  assert.equal(v200.speed, 50); // capped
  assert.equal(werkslok.maxSpeed, 126); // default

  const updated = store.updateControllerState('a', { speed: 30, light: true, name: 'ignored', maxSpeed: 126 });
  assert.equal(updated.speed, 30);
  assert.equal(updated.light, true);
  assert.equal(updated.name, 'V200');
  assert.equal(updated.maxSpeed, 50);
  assert.throws(() => store.updateControllerState('zz', { speed: 1 }), /Unknown/);

  assert.equal(store.setActiveController('b').activeControllerId, 'b');
  assert.equal(new SettingsStore(file).getControllers().activeControllerId, 'b');
});
