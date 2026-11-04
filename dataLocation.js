const fs = require('fs');
const path = require('path');

// Where BirdRail keeps settings.json (controllers, layout, rules, language).
//
// 1. BIRDRAIL_SETTINGS_FILE (environment) — fixed by the deployment, cannot be changed in the UI.
// 2. A folder chosen in the settings dialog — remembered in data/location.json next to the app.
// 3. Default: data/ next to the app.
const DEFAULT_DIR = path.join(__dirname, 'data');
const SETTINGS_NAME = 'settings.json';
const MAX_DIRS = 500;

const pointerFile = () => process.env.BIRDRAIL_LOCATION_FILE || path.join(DEFAULT_DIR, 'location.json');

const resolve = () => {
  if (process.env.BIRDRAIL_SETTINGS_FILE) {
    return { file: path.resolve(process.env.BIRDRAIL_SETTINGS_FILE), source: 'env' };
  }
  try {
    const { dir } = JSON.parse(fs.readFileSync(pointerFile(), 'utf8'));
    if (typeof dir === 'string' && path.isAbsolute(dir)) {
      return { file: path.join(dir, SETTINGS_NAME), source: 'custom' };
    }
  } catch (_error) {
    // No folder chosen yet (or unreadable pointer): use the default.
  }
  return { file: path.join(DEFAULT_DIR, SETTINGS_NAME), source: 'default' };
};

const inContainer = () => fs.existsSync('/run/.containerenv') || fs.existsSync('/.dockerenv');

// Linux: the mount a folder lives on, from /proc/self/mountinfo. null elsewhere (macOS).
const mountOf = (dir) => {
  let text;
  try {
    text = fs.readFileSync('/proc/self/mountinfo', 'utf8');
  } catch (_error) {
    return null;
  }
  let best = null;
  text.split('\n').forEach((line) => {
    const parts = line.split(' ');
    if (parts.length < 10) return;
    const point = parts[4].replace(/\\040/g, ' ');
    const fsType = parts[parts.indexOf('-') + 1];
    const inside = dir === point || dir.startsWith(point.endsWith('/') ? point : `${point}/`);
    if (inside && (!best || point.length > best.point.length)) best = { point, fsType };
  });
  return best;
};

// Does data in this folder survive a restart / container re-creation?
// true / false, or null when it cannot be told. `reason` says why.
const persistence = (dir) => {
  const mount = mountOf(dir);
  const container = inContainer();
  if (mount && ['tmpfs', 'ramfs'].includes(mount.fsType)) {
    return { persistent: false, reason: 'tmpfs', mount: mount.point };
  }
  if (container) {
    if (!mount) return { persistent: null, reason: 'unknown', mount: null };
    if (mount.point === '/') return { persistent: false, reason: 'container-layer', mount: '/' };
    return { persistent: true, reason: 'volume', mount: mount.point };
  }
  return { persistent: true, reason: 'disk', mount: mount ? mount.point : null };
};

const isWritable = (dir) => {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch (_error) {
    return false;
  }
};

const info = (file) => {
  const dir = path.dirname(file);
  const { source } = resolve();
  const pointerDir = path.dirname(pointerFile());
  return {
    file,
    dir,
    source,
    defaultDir: DEFAULT_DIR,
    container: inContainer(),
    writable: fs.existsSync(dir) ? isWritable(dir) : false,
    ...persistence(dir),
    // The chosen folder is remembered in the default folder: it must survive too.
    pointer: source === 'custom' ? { file: pointerFile(), ...persistence(pointerDir) } : null
  };
};

const normalizeDir = (input) => {
  const raw = String(input || '').trim();
  if (!raw || !path.isAbsolute(raw)) throw new Error('Please enter an absolute folder path (starting with /).');
  return path.resolve(raw);
};

// Sub-folders of `dir` for the folder picker.
const browse = (input) => {
  const dir = input ? normalizeDir(input) : path.dirname(resolve().file);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    const err = new Error(error.code === 'ENOENT' ? `Folder ${dir} does not exist.` : `Cannot open ${dir}: ${error.code || error.message}`);
    err.status = error.code === 'ENOENT' ? 404 : 400;
    throw err;
  }
  const dirs = entries
    .filter((e) => e.isDirectory() || (e.isSymbolicLink() && safeIsDir(path.join(dir, e.name))))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_DIRS);
  return {
    path: dir,
    parent: dir === path.dirname(dir) ? null : path.dirname(dir),
    dirs,
    writable: isWritable(dir),
    hasSettings: fs.existsSync(path.join(dir, SETTINGS_NAME)),
    ...persistence(dir)
  };
};

const safeIsDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_error) {
    return false;
  }
};

// Prepares `dir` as the new location. Returns { file, exists }. Creates the folder if
// needed and checks that BirdRail can write there.
const prepare = (input) => {
  if (process.env.BIRDRAIL_SETTINGS_FILE) {
    throw new Error('The data location is set by BIRDRAIL_SETTINGS_FILE. Remove that variable to choose it here.');
  }
  const dir = normalizeDir(input);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw new Error(`Cannot create ${dir}: ${error.code || error.message}`);
  }
  if (!safeIsDir(dir)) throw new Error(`${dir} is not a folder.`);
  const probe = path.join(dir, `.birdrail-write-test-${process.pid}`);
  try {
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
  } catch (error) {
    throw new Error(`BirdRail cannot write to ${dir}: ${error.code || error.message}`);
  }
  const file = path.join(dir, SETTINGS_NAME);
  return { dir, file, exists: fs.existsSync(file) };
};

// Remembers the chosen folder (the default folder needs no pointer).
const remember = (dir) => {
  const file = pointerFile();
  if (path.resolve(dir) === DEFAULT_DIR) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ dir: path.resolve(dir) }, null, 2));
};

module.exports = { resolve, info, browse, prepare, remember, persistence, DEFAULT_DIR, SETTINGS_NAME };
