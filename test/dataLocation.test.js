const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SettingsStore = require('../settingsStore');
const DataLocation = require('../dataLocation');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'birdrail-loc-'));

// Point the location pointer at a temp file so tests never touch the real data/ folder.
const withPointer = (fn) => {
  const saved = { file: process.env.BIRDRAIL_SETTINGS_FILE, pointer: process.env.BIRDRAIL_LOCATION_FILE };
  delete process.env.BIRDRAIL_SETTINGS_FILE;
  process.env.BIRDRAIL_LOCATION_FILE = path.join(tmpDir(), 'location.json');
  try {
    return fn(process.env.BIRDRAIL_LOCATION_FILE);
  } finally {
    if (saved.file === undefined) delete process.env.BIRDRAIL_SETTINGS_FILE;
    else process.env.BIRDRAIL_SETTINGS_FILE = saved.file;
    if (saved.pointer === undefined) delete process.env.BIRDRAIL_LOCATION_FILE;
    else process.env.BIRDRAIL_LOCATION_FILE = saved.pointer;
  }
};

test('language defaults to English, is validated and persisted', () => {
  const file = path.join(tmpDir(), 'settings.json');
  const store = new SettingsStore(file);
  assert.deepEqual(store.getUi(), { language: 'en' });
  assert.throws(() => store.setUi({ language: 'fr' }), /Language/);
  store.setUi({ language: 'de' });
  assert.equal(new SettingsStore(file).getUi().language, 'de');
});

test('switchFile copies the current data or loads the data found there', () => {
  const store = new SettingsStore(path.join(tmpDir(), 'settings.json'));
  store.setUi({ language: 'de' });

  const copyTarget = path.join(tmpDir(), 'settings.json');
  store.switchFile(copyTarget);
  assert.equal(store.filePath, copyTarget);
  assert.equal(JSON.parse(fs.readFileSync(copyTarget, 'utf8')).ui.language, 'de');

  const other = path.join(tmpDir(), 'settings.json');
  fs.writeFileSync(other, JSON.stringify({ ui: { language: 'en' }, controllers: [{ id: 'x', name: 'V 200', decoderId: 7 }] }));
  store.switchFile(other, { useExisting: true });
  assert.equal(store.getUi().language, 'en');
  assert.equal(store.getControllers().controllers[0].name, 'V 200');

  const broken = path.join(tmpDir(), 'settings.json');
  fs.writeFileSync(broken, 'not json');
  assert.throws(() => store.switchFile(broken, { useExisting: true }), /Cannot read/);
  assert.equal(store.filePath, other, 'keeps the previous file after a failed switch');
});

test('resolve: environment, chosen folder, default', () => {
  withPointer((pointer) => {
    assert.equal(DataLocation.resolve().source, 'default');
    const dir = tmpDir();
    DataLocation.remember(dir);
    assert.deepEqual(DataLocation.resolve(), { file: path.join(dir, 'settings.json'), source: 'custom' });
    DataLocation.remember(DataLocation.DEFAULT_DIR);
    assert.equal(fs.existsSync(pointer), false, 'the default folder needs no pointer');

    process.env.BIRDRAIL_SETTINGS_FILE = '/somewhere/settings.json';
    assert.deepEqual(DataLocation.resolve(), { file: '/somewhere/settings.json', source: 'env' });
    assert.throws(() => DataLocation.prepare(tmpDir()), /BIRDRAIL_SETTINGS_FILE/);
  });
});

test('prepare creates folders, rejects relative paths and reports existing data', () => {
  withPointer(() => {
    const base = tmpDir();
    const fresh = path.join(base, 'new', 'nested');
    assert.deepEqual(DataLocation.prepare(fresh), { dir: fresh, file: path.join(fresh, 'settings.json'), exists: false });
    assert.ok(fs.statSync(fresh).isDirectory());
    fs.writeFileSync(path.join(fresh, 'settings.json'), '{}');
    assert.equal(DataLocation.prepare(fresh).exists, true);
    assert.throws(() => DataLocation.prepare('relative/path'), /absolute/);
  });
});

test('browse lists sub-folders only', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'b'));
  fs.mkdirSync(path.join(dir, 'a'));
  fs.writeFileSync(path.join(dir, 'file.txt'), '');
  const result = DataLocation.browse(dir);
  assert.deepEqual(result.dirs, ['a', 'b']);
  assert.equal(result.parent, path.dirname(dir));
  assert.equal(result.writable, true);
  assert.throws(() => DataLocation.browse(path.join(dir, 'missing')), /does not exist/);
});
