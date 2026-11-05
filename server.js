require('dotenv').config();

const express = require('express');
const path = require('path');
const SerialService = require('./serialService');
const SettingsStore = require('./settingsStore');
const DataLocation = require('./dataLocation');
const TrackCatalog = require('./public/trackCatalog');
const RuleEngine = require('./ruleEngine');
const FeedbackPoller = require('./feedbackPoller');
const BlockTracker = require('./blockTracker');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const dataLocation = DataLocation.resolve();
const settingsStore = new SettingsStore(dataLocation.file);
console.log(`Data file: ${dataLocation.file} (${dataLocation.source})`);
const savedSerial = settingsStore.getSerial();

// Settings saved from the web interface win over environment defaults.
const serialService = new SerialService(
  savedSerial.portName || process.env.SERIAL_PORT || '/dev/ttyUSB0',
  Number(savedSerial.baudRate || process.env.SERIAL_BAUD_RATE || SerialService.DEFAULT_BAUD_RATE)
);

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (_req, res) => {
  res.json({
    app: 'SmartRailControl',
    serial: serialService.getStatus()
  });
});

app.get('/api/serial/ports', async (_req, res) => {
  try {
    const ports = await serialService.listPorts();
    res.json({ ports: ports.map((port) => ({ path: port.path, manufacturer: port.manufacturer || null })) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/config', (req, res) => {
  try {
    const portName = req.body.portName || serialService.portName;
    const baudRate = Number(req.body.baudRate || serialService.baudRate || SerialService.DEFAULT_BAUD_RATE);

    if (!SerialService.SUPPORTED_BAUD_RATES.includes(baudRate)) {
      return res.status(400).json({ error: `Intellibox supports ${SerialService.SUPPORTED_BAUD_RATES.join(', ')} baud.` });
    }

    if (!portName) {
      return res.status(400).json({ error: 'A serial port is required.' });
    }

    const status = serialService.setConfiguration({ portName, baudRate });
    settingsStore.setSerial({ portName, baudRate });
    return res.json({ ok: true, serial: status });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

/* ---------- User interface & data location ---------- */

app.get('/api/ui', (_req, res) => {
  res.json({ ...settingsStore.getUi(), languages: SettingsStore.LANGUAGES });
});

app.put('/api/ui', (req, res) => {
  try {
    return res.json(settingsStore.setUi(req.body || {}));
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.get('/api/storage', (_req, res) => {
  res.json(DataLocation.info(settingsStore.filePath));
});

app.get('/api/storage/browse', (req, res) => {
  try {
    return res.json(DataLocation.browse(req.query.path));
  } catch (error) {
    return res.status(error.status || 400).json({ error: error.message });
  }
});

// Moves the data to another folder.
// mode 'copy' (default): write the current data there; refused with 409 if the folder
//   already holds a settings.json, so the user can choose:
// mode 'use': load the data found there · mode 'replace': overwrite it with the current data.
app.post('/api/storage', (req, res) => {
  const { dir, mode = 'copy' } = req.body || {};
  try {
    const target = DataLocation.prepare(dir);
    if (target.file === settingsStore.filePath) {
      return res.json({ ok: true, unchanged: true, storage: DataLocation.info(target.file) });
    }
    if (target.exists && mode === 'copy') {
      return res.status(409).json({ exists: true, file: target.file, error: `${target.file} already exists.` });
    }
    if (mode === 'use' && !target.exists) {
      return res.status(400).json({ error: `There is no ${DataLocation.SETTINGS_NAME} in ${target.dir}.` });
    }
    const previous = settingsStore.filePath;
    settingsStore.switchFile(target.file, { useExisting: mode === 'use' });
    DataLocation.remember(target.dir);
    console.log(`Data file moved: ${previous} → ${target.file} (${mode})`);
    blocks.reload(); // occupancy of the blocks in that data

    if (mode === 'use') {
      // Other data: take over its interface settings and contact states.
      const serial = settingsStore.getSerial();
      if (serial.portName && (serial.portName !== serialService.portName || Number(serial.baudRate) !== serialService.baudRate)) {
        serialService.setConfiguration(serial);
      }
      syncContactsFromFeedback();
    }
    return res.json({ ok: true, loaded: mode === 'use', previous, storage: DataLocation.info(target.file) });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.get('/api/controllers', (_req, res) => {
  res.json(settingsStore.getControllers());
});

app.put('/api/controllers', (req, res) => {
  try {
    return res.json(settingsStore.setControllers(req.body || {}));
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.get('/api/layout', (_req, res) => {
  res.json(settingsStore.getLayout());
});

app.put('/api/layout', (req, res) => {
  try {
    const layout = settingsStore.setLayout(req.body || {});
    syncContactsFromFeedback();
    blocks.prune();
    return res.json(layout);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

// Switches a layout element: saves the new state and sends the decoder command(s).
// Addresses come from the saved layout. The state is saved even when the command
// cannot be sent; the result says whether it reached the Intellibox.
// Throws (with `status`) for unknown elements or invalid states.
const operateTile = async (tile, state) => {
  const momentary = TrackCatalog.isMomentary(tile.type);
  let current = tile;
  if (!momentary) {
    try {
      current = settingsStore.setTileState(tile.id, state);
    } catch (error) {
      error.status = 400;
      throw error;
    }
  }

  // Inverted drives get green and red swapped.
  const commands = TrackCatalog.commandsForTile(tile, momentary ? 'trigger' : state);
  if (!commands) {
    const error = new Error(`${tile.type} cannot be operated.`);
    error.status = 400;
    throw error;
  }

  const addresses = tile.addresses || [];
  if (commands.some(([slot]) => !addresses[slot])) {
    return { ok: false, sent: false, tile: current, error: 'no decoder address set.' };
  }

  try {
    const result = await serialService.sendAccessoryCommands(
      commands.map(([slot, color]) => ({ address: addresses[slot], color }))
    );
    return { ok: result.success, sent: result.success, tile: current, packets: result.packets, error: result.error };
  } catch (error) {
    // Address out of range for the selected protocol.
    return { ok: false, sent: false, tile: current, error: error.message };
  }
};

const ruleEngine = new RuleEngine({
  getRules: () => settingsStore.getRules(),
  getTile: (id) => settingsStore.getTile(id),
  operate: operateTile
});

/* ---------- Block signalling ---------- */

const blocks = new BlockTracker({
  getTiles: () => settingsStore.getLayout().tiles,
  load: () => settingsStore.getBlocks(),
  save: (state) => settingsStore.setBlocks(state)
});

// A contact track switched on (s88 or pressed by hand): occupy its block, if it starts one.
const blockContactOn = (tileId) => {
  const result = blocks.contactOn(tileId);
  if (result) {
    const freed = result.freed.length ? `, freed ${result.freed.length} block(s) behind` : '';
    console.log(`[blocks] block ${result.block} occupied${result.loco ? ` by ${result.loco}` : ''}${freed}`);
    if (result.ambiguous.length) {
      console.log(`[blocks] ${result.ambiguous.length} occupied blocks lead into block ${result.block} and the turnouts do not tell which one the train came from: none freed`);
    }
  }
};

// Run mode: occupy a block (optionally with a loco name) or free it, by hand.
app.post('/api/blocks', (req, res) => {
  const { id, occupied, loco } = req.body || {};
  try {
    return res.json({ ok: true, blocks: blocks.set(String(id || ''), { occupied: Boolean(occupied), loco }) });
  } catch (error) {
    if (error.code === 'locoInBlock') {
      return res.status(409).json({ error: error.message, code: error.code, block: error.block, loco: error.loco });
    }
    return res.status(404).json({ error: error.message });
  }
});

/* ---------- s88 feedback ---------- */

const contactTiles = () => settingsStore.getLayout().tiles.filter((t) => t.type === 'contact');
const contactNumber = (tile) => (tile.addresses && tile.addresses[0]) || null;

// Modules to read: S88_MODULES, otherwise enough for the highest contact number in the layout.
const s88ModuleCount = () => {
  if (process.env.S88_MODULES) return Number(process.env.S88_MODULES) || 0;
  const highest = Math.max(0, ...contactTiles().map((t) => contactNumber(t) || 0));
  return Math.ceil(highest / 16);
};

// s88 monitor (edit mode): the last contacts that changed, newest last.
const S88_MONITOR_SIZE = 20;
// A contact track is often closed for only 0.2–0.3 s, shorter than the browsers poll
// /api/live. For the display it stays on at least this long, so no closure goes unseen.
// The rules still get the real on and off.
const S88_DISPLAY_HOLD_MS = 1500;
const s88Events = [];
let s88Seq = 0;
const recordS88Event = (contact, on, tiles) => {
  s88Seq += 1;
  s88Events.push({ seq: s88Seq, contact, on, at: new Date().toISOString(), tiles: tiles.map((t) => t.id) });
  if (s88Events.length > S88_MONITOR_SIZE) s88Events.shift();
};

const feedback = new FeedbackPoller({
  serial: serialService,
  getModuleCount: s88ModuleCount,
  pollMs: Number(process.env.S88_POLL_MS || FeedbackPoller.DEFAULT_POLL_MS),
  debug: ['1', 'true', 'yes', 'on'].includes(String(process.env.S88_DEBUG || '').toLowerCase()),
  onChange: ({ contact, on, initial }) => {
    const tiles = contactTiles().filter((t) => contactNumber(t) === contact);
    if (!initial) {
      console.log(`[s88] contact ${contact} ${on ? 'on' : 'off'}${tiles.length ? '' : ' (no contact track with this number)'}`);
      recordS88Event(contact, on, tiles);
    }
    tiles.forEach((tile) => {
      ruleEngine.cancelPulse(tile.id);
      if (initial) {
        ruleEngine.syncSensor(tile.id, on);
      } else {
        if (on) blockContactOn(tile.id);
        const { fired } = ruleEngine.setSensor(tile.id, on);
        if (fired.length) console.log(`[rules] contact ${contact} ${on ? 'on' : 'off'}: ${fired.length} rule(s) fired`);
      }
    });
  }
});

// Contact tracks added or renumbered in the layout take over the contact's current state.
const syncContactsFromFeedback = () => {
  if (feedback.getStatus().state !== 'live') return;
  contactTiles().forEach((tile) => {
    const number = contactNumber(tile);
    if (number) ruleEngine.syncSensor(tile.id, feedback.isOn(number));
  });
};

if (!['0', 'false', 'no', 'off'].includes(String(process.env.S88_FEEDBACK || '').toLowerCase())) {
  feedback.start();
}

// Run mode: operate a layout element. The browser sends only the element id and the new state.
app.post('/api/layout/operate', async (req, res) => {
  const { id, state } = req.body || {};
  const tile = settingsStore.getTile(String(id || ''));
  if (!tile) {
    return res.status(404).json({ error: 'Unknown layout element.' });
  }
  try {
    return res.json(await operateTile(tile, state));
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message });
  }
});

// Contact track pressed by hand (run mode, rules window) to test rules without a train:
// { id, pulse: true } turns it on for 2 s, then off again. { id, active } sets it.
// Real contacts come from the s88 feedback modules. Matching rules run.
app.post('/api/sensors', (req, res) => {
  const { id, active, pulse } = req.body || {};
  try {
    if (pulse) {
      const { changed, fired, pulseMs } = ruleEngine.pulseSensor(String(id || ''));
      blockContactOn(String(id || ''));
      return res.json({ ok: true, changed, fired, active: true, pulseMs });
    }
    ruleEngine.cancelPulse(String(id || ''));
    const { changed, fired } = ruleEngine.setSensor(String(id || ''), active);
    if (active && changed) blockContactOn(String(id || ''));
    return res.json({ ok: true, changed, fired, active: Boolean(active) });
  } catch (error) {
    return res.status(404).json({ error: error.message });
  }
});

// Live view for run mode and the rules window: element states, active sensors, rule log.
app.get('/api/live', (_req, res) => {
  const states = Object.fromEntries(
    settingsStore.getLayout().tiles.filter((t) => t.state !== undefined).map((t) => [t.id, t.state])
  );
  const live = ruleEngine.getLive();
  const contactsOn = new Set([...feedback.contacts].filter(([, on]) => on).map(([contact]) => contact));
  const holdSince = Date.now() - S88_DISPLAY_HOLD_MS;
  s88Events
    .filter((event) => event.on && Date.parse(event.at) >= holdSince)
    .forEach((event) => {
      contactsOn.add(event.contact);
      event.tiles.forEach((id) => {
        live.sensors[id] = true;
      });
    });
  res.json({
    states,
    ...live,
    feedback: feedback.getStatus(),
    blocks: blocks.getLive(),
    s88: { events: s88Events, contactsOn: [...contactsOn].sort((a, b) => a - b) }
  });
});

app.get('/api/rules', (_req, res) => {
  res.json({ rules: settingsStore.getRules() });
});

app.put('/api/rules', (req, res) => {
  try {
    return res.json({ rules: settingsStore.setRules((req.body || {}).rules) });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post('/api/locomotive/control', (req, res) => {
  try {
    const decoderId = Number(req.body.decoderId);
    const speed = Number(req.body.speed ?? 0);
    const direction = req.body.direction === 'reverse' ? 'reverse' : 'forward';
    const stop = Boolean(req.body.stop);
    const emergency = Boolean(req.body.emergency);

    if (!Number.isInteger(decoderId) || decoderId <= 0) {
      return res.status(400).json({ error: 'Decoder ID must be a positive integer.' });
    }

    const result = serialService.sendLocomotiveCommand({
      decoderId,
      speed: stop ? 0 : speed,
      direction,
      stop,
      emergency
    });

    return res.json({
      ok: result.success,
      decoderId,
      speed: stop ? 0 : Math.max(0, Math.min(SerialService.MAX_SPEED, speed)),
      direction,
      stop,
      packet: result.packet,
      error: result.error,
      status: serialService.getStatus()
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

/* ---------- Decoder test (switch a bare accessory address) ---------- */

// Accessory decoders cannot be detected: they only receive commands. This lets the user
// switch any address and watch which turnout, signal or uncoupler moves.
app.post('/api/accessory/test', async (req, res) => {
  const address = Number(req.body && req.body.address);
  const color = req.body && req.body.color === 'red' ? 'red' : 'green';
  if (!Number.isInteger(address) || address < 1) {
    return res.status(400).json({ error: 'Decoder address must be a positive integer.' });
  }
  try {
    const result = await serialService.sendAccessoryCommands([{ address, color }]);
    return res.json({ ok: result.success, address, color, packets: result.packets, error: result.error });
  } catch (error) {
    // Address out of range for the selected protocol.
    return res.status(400).json({ error: error.message });
  }
});

app.get('/api/decoders/notes', (_req, res) => {
  res.json(settingsStore.getDecoderNotes());
});

app.put('/api/decoders/notes', (req, res) => {
  try {
    const { address, note } = req.body || {};
    return res.json(settingsStore.setDecoderNote(address, note));
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post('/api/locomotive/functions', (req, res) => {
  try {
    const decoderId = Number(req.body.decoderId);
    if (!Number.isInteger(decoderId) || decoderId <= 0) {
      return res.status(400).json({ error: 'Decoder ID must be a positive integer.' });
    }
    const functions = Array.isArray(req.body.functions) ? req.body.functions.map(Boolean) : [];
    const result = serialService.sendFunctionCommand({ decoderId, functions });
    return res.json({
      ok: result.success,
      decoderId,
      functions,
      packet: result.packet,
      error: result.error,
      status: serialService.getStatus()
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`SmartRailControl is running at http://localhost:${PORT}`);
  console.log(`Serial port configured: ${serialService.getStatus().port}`);
});
