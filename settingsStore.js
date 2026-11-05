const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_FILE = path.join(__dirname, 'data', 'settings.json');
const MAX_SPEED = 126;
const MAX_CONTROLLERS = 50;
const FUNCTION_COUNT = 4; // F1-F4, like the f1-f4 keys of the Intellibox
const MAX_NOTE_LENGTH = 60;

// Decoder test page: what the user found out about an accessory address,
// e.g. { "12": "Entry turnout, station left" }.
const sanitizeDecoderNotes = (input) => {
  const notes = {};
  if (!input || typeof input !== 'object') return notes;
  Object.entries(input).forEach(([key, value]) => {
    const address = toInt(key);
    const text = String(value || '').trim().slice(0, MAX_NOTE_LENGTH);
    if (address >= 1 && address <= TrackCatalog.MAX_ADDRESS && text) notes[address] = text;
  });
  return notes;
};
const LANGUAGES = ['en', 'de'];
const DEFAULT_UI = { language: 'en' };

const TrackCatalog = require('./public/trackCatalog');

const TRACK_TYPES = TrackCatalog.TYPE_NAMES;
const ELEMENT_STATES = Object.fromEntries(
  TRACK_TYPES.filter((type) => TrackCatalog.statesOf(type)).map((type) => [type, TrackCatalog.statesOf(type)])
);
const ROTATIONS = TrackCatalog.ROTATIONS;
// The browser shows as many squares as fit at the current zoom and saves only the
// extent the elements use, so the upper limits are generous.
const GRID_LIMITS = { minCols: 4, maxCols: 250, minRows: 4, maxRows: 250 };
const DEFAULT_LAYOUT = { cols: 20, rows: 12, tiles: [] };

const toInt = (value) => (Number.isInteger(Number(value)) ? Number(value) : NaN);

const sanitizeAddresses = (type, input) => {
  const slots = TrackCatalog.addressSlots(type);
  const values = Array.isArray(input) ? input : [];
  return slots.map((_label, i) => {
    const value = values[i];
    if (value === null || value === undefined || value === '') return null;
    const address = toInt(value);
    if (!(address >= 1 && address <= TrackCatalog.MAX_ADDRESS)) {
      throw new Error(`Decoder address must be between 1 and ${TrackCatalog.MAX_ADDRESS}.`);
    }
    return address;
  });
};

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
    if (!(Number.isInteger(x) && Number.isInteger(y))) {
      throw new Error('Track element has an invalid position.');
    }

    const rotation = ROTATIONS.includes(toInt(tile.rotation)) ? toInt(tile.rotation) : 0;

    TrackCatalog.cellsOf({ type: tile.type, x, y, rotation }).forEach(([cx, cy]) => {
      if (!(cx >= 0 && cx < cols && cy >= 0 && cy < rows)) {
        throw new Error('Track element is outside the layout grid.');
      }
      const cell = `${cx},${cy}`;
      if (occupied.has(cell)) {
        throw new Error(`More than one element at cell ${cell}.`);
      }
      occupied.add(cell);
    });

    let id = typeof tile.id === 'string' && /^[\w-]{1,64}$/.test(tile.id) ? tile.id : crypto.randomUUID();
    if (ids.has(id)) id = crypto.randomUUID();
    ids.add(id);

    const sanitized = { id, type: tile.type, x, y, rotation };
    const states = ELEMENT_STATES[tile.type];
    if (states) {
      sanitized.state = states.includes(tile.state) ? tile.state : states[0];
    }
    if (TrackCatalog.addressSlots(tile.type).length > 0) {
      sanitized.addresses = sanitizeAddresses(tile.type, tile.addresses);
    }
    // Contact track that starts a block, with the block direction (arrow in the symbol).
    if (tile.type === 'contact' && TrackCatalog.BLOCK_DIRECTIONS.includes(tile.block)) {
      sanitized.block = tile.block;
    }
    // Inverted drives (green and red swapped): kept only when at least one is inverted.
    if (TrackCatalog.canInvert(tile.type) && Array.isArray(tile.invert) && tile.invert.some(Boolean)) {
      sanitized.invert = TrackCatalog.addressSlots(tile.type).map((_label, i) => Boolean(tile.invert[i]));
    }
    return sanitized;
  });

  return { cols, rows, tiles: sanitizedTiles };
};

/* ---------- Logic rules ---------- */

const MAX_RULES = 200;
const MAX_RULE_ITEMS = 20;
const MAX_DELAY_S = 3600;
const ID_PATTERN = /^[\w-]{1,64}$/;

// Rule: { id, name, enabled,
//   trigger:    { device: <contact tile id>, state: 'on' | 'off' },
//   conditions: [{ device, state }]          — all must hold (AND),
//   actions:    [{ device, state, delay }] } — run in order, delay in seconds before each.
// Devices are referenced by tile id. A rule may point at an element that was removed
// from the layout later; it is kept (the editor flags it, the engine skips it), but a
// device that exists must have the right kind and a valid state.
const sanitizeRules = (input, tiles = []) => {
  const list = Array.isArray(input) ? input : [];
  if (list.length > MAX_RULES) throw new Error(`At most ${MAX_RULES} rules are supported.`);
  const byId = new Map(tiles.map((t) => [t.id, t]));
  const ids = new Set();

  const ref = (item, what, role, statesFor, ruleName) => {
    const device = item && typeof item.device === 'string' && ID_PATTERN.test(item.device) ? item.device : null;
    const state = item && typeof item.state === 'string' ? item.state.slice(0, 20) : '';
    const tile = device && byId.get(device);
    if (tile) {
      if (!TrackCatalog.ruleRoles(tile.type)[role]) {
        throw new Error(`Rule "${ruleName}": ${TrackCatalog.labelOf(tile.type)} cannot be used as ${what}.`);
      }
      if (!statesFor(tile.type).includes(state)) {
        throw new Error(`Rule "${ruleName}": invalid state "${state}" for ${TrackCatalog.labelOf(tile.type)}.`);
      }
    }
    return { device, state };
  };

  const items = (value, map) => (Array.isArray(value) ? value.slice(0, MAX_RULE_ITEMS).map(map) : []);

  return list.map((rule, index) => {
    if (!rule || typeof rule !== 'object') throw new Error('Invalid rule.');
    let id = typeof rule.id === 'string' && ID_PATTERN.test(rule.id) ? rule.id : crypto.randomUUID();
    if (ids.has(id)) id = crypto.randomUUID();
    ids.add(id);
    const name = String(rule.name || '').trim().slice(0, 60) || `Rule ${index + 1}`;

    const trigger = ref(rule.trigger, 'a trigger', 'trigger', TrackCatalog.conditionStates, name);
    if (!['on', 'off'].includes(trigger.state)) trigger.state = 'on';

    return {
      id,
      name,
      enabled: rule.enabled !== false,
      trigger,
      conditions: items(rule.conditions, (c) => ref(c, 'a condition', 'condition', TrackCatalog.conditionStates, name)),
      actions: items(rule.actions, (a) => {
        const delay = Math.round(Math.max(0, Math.min(MAX_DELAY_S, Number(a && a.delay) || 0)) * 10) / 10;
        return { ...ref(a, 'an action', 'action', TrackCatalog.actionStates, name), delay };
      })
    };
  });
};

const createController = (overrides = {}) => ({
  id: crypto.randomUUID(),
  name: 'Locomotive',
  decoderId: 3,
  speed: 0,
  direction: 'forward',
  functions: Array(FUNCTION_COUNT).fill(false),
  light: false,
  maxSpeed: MAX_SPEED,
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

  // Highest speed step the throttle may send (1..126); the throttle shows % of it.
  const maxSpeed = Math.max(1, Math.min(MAX_SPEED, Math.round(Number(input.maxSpeed) || MAX_SPEED)));

  return {
    id,
    name,
    decoderId,
    speed: Math.max(0, Math.min(maxSpeed, Math.round(Number(input.speed) || 0))),
    direction: input.direction === 'reverse' ? 'reverse' : 'forward',
    functions: Array.from({ length: FUNCTION_COUNT }, (_v, i) =>
      Boolean(Array.isArray(input.functions) && input.functions[i])
    ),
    light: Boolean(input.light), // F0
    maxSpeed
  };
};

class SettingsStore {
  constructor(filePath = process.env.SMARTRAILCONTROL_SETTINGS_FILE || DEFAULT_FILE) {
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

    let rules = [];
    try {
      // Structure only: references are checked against the layout when rules are saved.
      rules = sanitizeRules(raw.rules);
    } catch (error) {
      console.error(`Ignoring invalid saved rules: ${error.message}`);
    }

    const ui = { ...DEFAULT_UI };
    if (raw.ui && LANGUAGES.includes(raw.ui.language)) ui.language = raw.ui.language;

    return {
      serial: raw.serial && typeof raw.serial === 'object' ? raw.serial : {},
      ui,
      controllers,
      activeControllerId,
      layout,
      rules,
      decoderNotes: sanitizeDecoderNotes(raw.decoderNotes),
      // Occupied blocks: { start contact id: { loco, since } } (checked by BlockTracker).
      blocks: raw.blocks && typeof raw.blocks === 'object' && !Array.isArray(raw.blocks) ? raw.blocks : {}
    };
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpFile = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmpFile, this.filePath);
  }

  // Switches to another settings file. useExisting: load the data found there;
  // otherwise the current data is written to the new file.
  switchFile(filePath, { useExisting = false } = {}) {
    const previous = this.filePath;
    this.filePath = filePath;
    try {
      if (useExisting) {
        JSON.parse(fs.readFileSync(filePath, 'utf8')); // refuse files that are not JSON
        this.data = this.load();
      } else {
        this.save();
      }
    } catch (error) {
      this.filePath = previous;
      throw new Error(useExisting ? `Cannot read ${filePath}: ${error.message}` : `Cannot write ${filePath}: ${error.message}`);
    }
  }

  getUi() {
    return { ...this.data.ui };
  }

  setUi({ language }) {
    if (!LANGUAGES.includes(language)) {
      throw new Error(`Language must be one of: ${LANGUAGES.join(', ')}.`);
    }
    this.data.ui = { ...this.data.ui, language };
    this.save();
    return this.getUi();
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

  // Driving state of one locomotive (throttle): speed, direction, functions, light.
  updateControllerState(id, changes = {}) {
    const index = this.data.controllers.findIndex((c) => c.id === id);
    if (index === -1) throw new Error('Unknown locomotive.');
    const current = this.data.controllers[index];
    const next = sanitizeController({
      ...current,
      ...['speed', 'direction', 'functions', 'light'].reduce((acc, key) => {
        if (changes[key] !== undefined) acc[key] = changes[key];
        return acc;
      }, {})
    });
    this.data.controllers[index] = next;
    this.save();
    return { ...next, functions: [...next.functions] };
  }

  setActiveController(id) {
    if (!this.data.controllers.some((c) => c.id === id)) throw new Error('Unknown locomotive.');
    this.data.activeControllerId = id;
    this.save();
    return this.getControllers();
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
    const sanitized = sanitizeLayout(layout);
    // Checked on save only, so a layout saved by an older version still loads and can be fixed.
    const conflicts = TrackCatalog.findAddressConflicts(sanitized.tiles);
    if (conflicts.length > 0) {
      const list = conflicts
        .map((c) => `${TrackCatalog.ADDRESS_SPACES[c.space]} ${c.address} (${c.uses.length}×)`)
        .join(', ');
      throw new Error(`Duplicate decoder addresses: ${list}.`);
    }
    this.data.layout = sanitized;
    this.save();
    return this.getLayout();
  }

  getBlocks() {
    return JSON.parse(JSON.stringify(this.data.blocks || {}));
  }

  setBlocks(blocks) {
    this.data.blocks = JSON.parse(JSON.stringify(blocks || {}));
    this.save();
  }

  getDecoderNotes() {
    return { ...this.data.decoderNotes };
  }

  // An empty note removes the entry.
  setDecoderNote(address, note) {
    const value = toInt(address);
    if (!(value >= 1 && value <= TrackCatalog.MAX_ADDRESS)) {
      throw new Error(`Decoder address must be between 1 and ${TrackCatalog.MAX_ADDRESS}.`);
    }
    const text = String(note || '').trim().slice(0, MAX_NOTE_LENGTH);
    if (text) this.data.decoderNotes[value] = text;
    else delete this.data.decoderNotes[value];
    this.save();
    return this.getDecoderNotes();
  }

  getRules() {
    return JSON.parse(JSON.stringify(this.data.rules));
  }

  setRules(rules) {
    this.data.rules = sanitizeRules(rules, this.data.layout.tiles);
    this.save();
    return this.getRules();
  }

  getTile(id) {
    const tile = this.data.layout.tiles.find((t) => t.id === id);
    return tile ? { ...tile } : null;
  }

  // Run mode: change only the state of one element. Does not re-validate addresses,
  // so operating a layout keeps working while address conflicts are being fixed.
  setTileState(id, state) {
    const tile = this.data.layout.tiles.find((t) => t.id === id);
    const states = tile && ELEMENT_STATES[tile.type];
    if (!tile) throw new Error('Unknown layout element.');
    if (!states || !states.includes(state)) throw new Error(`Invalid state for ${tile.type}: ${state}`);
    tile.state = state;
    this.save();
    return { ...tile };
  }
}

SettingsStore.FUNCTION_COUNT = FUNCTION_COUNT;
SettingsStore.TRACK_TYPES = TRACK_TYPES;
SettingsStore.ELEMENT_STATES = ELEMENT_STATES;
SettingsStore.GRID_LIMITS = GRID_LIMITS;
SettingsStore.sanitizeRules = sanitizeRules;
SettingsStore.LANGUAGES = LANGUAGES;

module.exports = SettingsStore;
