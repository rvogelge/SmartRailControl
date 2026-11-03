const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_FILE = path.join(__dirname, 'data', 'settings.json');
const MAX_SPEED = 126;
const MAX_CONTROLLERS = 50;

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

    return {
      serial: raw.serial && typeof raw.serial === 'object' ? raw.serial : {},
      controllers,
      activeControllerId
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
}

module.exports = SettingsStore;
