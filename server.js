require('dotenv').config();

const express = require('express');
const path = require('path');
const SerialService = require('./serialService');
const SettingsStore = require('./settingsStore');
const TrackCatalog = require('./public/trackCatalog');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const settingsStore = new SettingsStore();
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
    app: 'bird_rail',
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
    return res.json(settingsStore.setLayout(req.body || {}));
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

// Run mode: operate a layout element. The browser sends only the element id and the
// new state; addresses come from the saved layout. The state is saved even when the
// command cannot be sent, and the reply says whether it reached the Intellibox.
app.post('/api/layout/operate', async (req, res) => {
  const { id, state } = req.body || {};
  const tile = settingsStore.getTile(String(id || ''));
  if (!tile) {
    return res.status(404).json({ error: 'Unknown layout element.' });
  }

  const momentary = Boolean(TrackCatalog.TYPES[tile.type] && TrackCatalog.TYPES[tile.type].momentary);
  let current = tile;
  if (!momentary) {
    try {
      current = settingsStore.setTileState(tile.id, state);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  }

  const commands = TrackCatalog.commandsFor(tile.type, momentary ? 'trigger' : state);
  if (!commands) {
    return res.status(400).json({ error: `${tile.type} cannot be operated.` });
  }

  const addresses = tile.addresses || [];
  const missing = commands.filter(([slot]) => !addresses[slot]).map(([slot]) => slot);
  if (missing.length > 0) {
    return res.json({ ok: false, sent: false, tile: current, error: 'no decoder address set.' });
  }

  try {
    const result = await serialService.sendAccessoryCommands(
      commands.map(([slot, color]) => ({ address: addresses[slot], color }))
    );
    return res.json({
      ok: result.success,
      sent: result.success,
      tile: current,
      packets: result.packets,
      error: result.error
    });
  } catch (error) {
    // Address out of range for the selected protocol.
    return res.json({ ok: false, sent: false, tile: current, error: error.message });
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

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`BirdRail is running at http://localhost:${PORT}`);
  console.log(`Serial port configured: ${serialService.getStatus().port}`);
});
