require('dotenv').config();

const express = require('express');
const path = require('path');
const SerialService = require('./serialService');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const serialService = new SerialService(
  process.env.SERIAL_PORT || '/dev/ttyUSB0',
  Number(process.env.SERIAL_BAUD_RATE || SerialService.DEFAULT_BAUD_RATE)
);

app.use(express.json());
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
    return res.json({ ok: true, serial: status });
  } catch (error) {
    return res.status(500).json({ error: error.message });
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
