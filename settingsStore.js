const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_FILE = path.join(__dirname, 'data', 'settings.json');
const MAX_SPEED = 126;
const MAX_CONTROLLERS = 50;

const TRACK_TYPES = ['straight', 'curve', 'turnout-left', 'turnout-right'];
const ROTATIONS = [0, 90, 180, 270];
const GRID_LIMITS = { minCols: 4, maxCols: 60, minRows: 4, maxRows: 40 };
const DEFAULT_LAYOUT = { cols: 20, rows: 12, tiles: [] };

const toInt = (value) => (Number.isInteger(Number(value)) ? Number(value) : NaN);

const sanitizeLayout = (input) => {
  if (!input || typeof input !== 'object') {
    throw new Error('Invalid layout.');
  }

  const cols = toInt(input.cols);
  const rows = toInt(input.rows);
  if (!(cols >= GRID_LIMITS.minCols && cols <= GRID_LIMITS.maxCols)) {
    throw new Error(`Columns must be between ${GRID_LIMITS.minCols} and ${GRID_LIMITS.maxCols}.`);
  }
  if (!(rows >= GRID_LIMITS.minRows && rows <= GRID_LIMITS.maxRows)) {
    throw new Error(`Rows must be between ${GRID_LIMITS.minRows} and ${GRID_LIMITS.maxRows}.`);
  }

  const tiles = Array.isArray(input.tiles) ? input.tiles : [];
  const occupied = new Set();
  const ids = new Set();

  const sanitizedTiles = tiles.map((tile) => {
    const x = toInt(tile && tile.x);
    const y = toInt(tile && tile.y);
    if (!TRACK_TYPES.includes(tile && tile.type)) {
      throw new Error(`Unknown track element: ${tile && tile.type}`);
    }
    if (!(x >= 0 && x < cols && y >= 0 && y < rows)) {
      throw new Error('Track element is outside the layout grid.');
    }
    const cell = `${x},${y}`;
    if (occupied.has(cell)) {
      throw new Error(`More than one element at cell ${cell}.`);
    }
    occupied.add(cell);

    let id = typeof tile.id === 'string' && /^[\w-]{1,64}$/.test(tile.id) ? tile.id : crypto.randomUUID();
    if (ids.has(id)) id = crypto.randomUUID();
    ids.add(id);

    const rotation = toInt(tile.rotation);
    return {
      id,
      type: tile.type,
      x,
      y,
      rotation: ROTATIONS.includes(rotation) ? rotation : 0
    };
  });

  return { cols, rows, tiles: sanitizedTiles };
};

const createController = (overrides = {}) => ({
  id: crypto.randomUUID(),
  name: 'Locomotive',
  decoderId: 3,
  speed: 0,
  direction: 'forward',
  ...overrides
});

const sanitizeController = (input) => {
  if (!input || typeof input !== 'object') {
    throw new Error('Invalid controller entry.');
  }

  const decoderId = Number(input.decoderId);
  if (!Number.isInteger(decoderId) || decoderId < 1 || decoderId > 10239) {
    throw new Error('Decoder ID must be an integer between 1 and 10239.');
  }

  const name = String(input.name || '').trim().slice(0, 40) || `Locomotive ${decoderId}`;
  const id = typeof input.id === 'string' && /^[\w-]{1,64}$/.test(input.id) ? input.id : crypto.randomUUID();

  return {
    id,
    name,
    decoderId,
    speed: Math.max(0, Math.min(MAX_SPEED, Math.round(Number(input.speed) || 0))),
    direction: input.direction === 'reverse' ? 'reverse' : 'forward'
  };
};

class SettingsStore {
  constructor(filePath = process.env.BIRDRAIL_SETTINGS_FILE || DEFAULT_FILE) {
    this.filePath = filePath;
    this.data = this.load();
  }

  load() {
    let raw = {};
    try {
      raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error(`Unable to read settings file ${this.filePath}: ${error.message}`);
      }
    }

    let controllers = [];
    try {
      controllers = Array.isArray(raw.controllers) ? raw.controllers.map(sanitizeController) : [];
    } catch (_error) {
      controllers = [];
    }

    if (controllers.length === 0) {
      controllers = [createController()];
    }

    const activeControllerId = controllers.some((c) => c.id === raw.activeControllerId)
      ? raw.activeControllerId
      : controllers[0].id;

    let layout = { ...DEFAULT_LAYOUT };
    try {
      if (raw.layout) layout = sanitizeLayout(raw.layout);
    } catch (error) {
      console.error(`Ignoring invalid saved layout: ${error.message}`);
    }

    return {
      serial: raw.serial && typeof raw.serial === 'object' ? raw.serial : {},
      controllers,
      activeControllerId,
      layout
    };
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpFile = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmpFile, this.filePath);
  }

  getSerial() {
    return { ...this.data.serial };
  }

  setSerial({ portName, baudRate }) {
    this.data.serial = { portName, baudRate: Number(baudRate) };
    this.save();
  }

  getControllers() {
    return {
      controllers: this.data.controllers.map((c) => ({ ...c })),
      activeControllerId: this.data.activeControllerId
    };
  }

  setControllers({ controllers, activeControllerId }) {
    if (!Array.isArray(controllers) || controllers.length === 0) {
      throw new Error('At least one controller is required.');
    }
    if (controllers.length > MAX_CONTROLLERS) {
      throw new Error(`At most ${MAX_CONTROLLERS} controllers are supported.`);
    }

    const sanitized = controllers.map(sanitizeController);
    const ids = new Set(sanitized.map((c) => c.id));
    if (ids.size !== sanitized.length) {
      throw new Error('Controller IDs must be unique.');
    }

    this.data.controllers = sanitized;
    this.data.activeControllerId = ids.has(activeControllerId) ? activeControllerId : sanitized[0].id;
    this.save();
    return this.getControllers();
  }

  getLayout() {
    const { cols, rows, tiles } = this.data.layout;
    return { cols, rows, tiles: tiles.map((t) => ({ ...t })) };
  }

  setLayout(layout) {
    this.data.layout = sanitizeLayout(layout);
    this.save();
    return this.getLayout();
  }
}

SettingsStore.TRACK_TYPES = TRACK_TYPES;
SettingsStore.GRID_LIMITS = GRID_LIMITS;

module.exports = SettingsStore;
