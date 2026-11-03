const { SerialPort } = require('serialport');

// Intellibox (1st generation) serial interface: 2400/4800/9600/19200/38400 baud,
// 8 data bits, 2 stop bits, no parity, RTS/CTS hardware handshake.
const DEFAULT_BAUD_RATE = 19200;
const SUPPORTED_BAUD_RATES = [2400, 4800, 9600, 19200, 38400];
const DEFAULT_PROTOCOL = 'P50X';

// P50Xb: every binary command starts with 'X' (0x58).
const P50X_PREFIX = 0x58;
const P50X_XLOK = 0x80;
const P50X_DIR_FORWARD = 0x20;
const P50X_LIGHT = 0x10;
const P50X_STATUS_OK = 0x00;

// UI speed range 0..126; P50X uses 0 = stop, 1 = emergency stop, 2..127 = speed steps.
const MAX_SPEED = 126;

const clampSpeed = (speed) => Math.max(0, Math.min(MAX_SPEED, Math.round(Number(speed) || 0)));

class SerialService {
  constructor(portName, baudRate = Number(process.env.SERIAL_BAUD_RATE || DEFAULT_BAUD_RATE)) {
    this.portName = portName || process.env.SERIAL_PORT || '/dev/ttyUSB0';
    this.baudRate = Number.isInteger(baudRate) ? Number(baudRate) : DEFAULT_BAUD_RATE;
    this.protocol = (process.env.INTELLIBOX_PROTOCOL || DEFAULT_PROTOCOL).toUpperCase();
    this.hardwareHandshake = process.env.SERIAL_RTSCTS !== 'false';
    this.p50Directions = new Map();
    this.connection = null;
    this.connected = false;
    this.lastPacket = [];
    this.lastReceivedPacket = [];
    this.connect();
  }

  formatPacketHex(packet) {
    const bytes = Array.isArray(packet) ? packet : Array.from(packet || []);
    return bytes.map((byte) => `0x${Number(byte).toString(16).padStart(2, '0').toUpperCase()}`).join(' ');
  }

  logCommunication(direction, packet, metadata = {}) {
    const message = this.formatPacketHex(packet);
    const info = Object.keys(metadata).length > 0 ? ` ${JSON.stringify(metadata)}` : '';
    const label = direction === 'rx' ? '[Intellibox RX]' : direction === 'tx' ? '[Intellibox TX]' : `[${direction}]`;
    console.log(`${label} ${new Date().toISOString()} ${message}${info}`);
  }

  async listPorts() {
    return SerialPort.list();
  }

  setConfiguration({ portName, baudRate }) {
    if (portName) {
      this.portName = portName;
    }

    if (baudRate) {
      this.baudRate = Number(baudRate);
    }

    this.connect();
    return this.getStatus();
  }

  connect() {
    if (this.connection && this.connection.isOpen) {
      this.connection.close();
    }

    try {
      this.connection = new SerialPort({
        path: this.portName,
        baudRate: this.baudRate,
        dataBits: 8,
        stopBits: 2,
        parity: 'none',
        rtscts: this.hardwareHandshake
      });

      this.connection.on('open', () => {
        this.connected = true;
        console.log(`Connected to serial interface on ${this.portName} @ ${this.baudRate} baud`);
      });

      this.connection.on('data', (chunk) => {
        const bytes = Array.from(chunk);
        this.lastReceivedPacket = bytes;
        const metadata = { length: bytes.length };
        if (this.protocol !== 'P50' && bytes.length > 0) {
          metadata.status = bytes[0] === P50X_STATUS_OK ? 'OK' : `error 0x${bytes[0].toString(16).padStart(2, '0').toUpperCase()}`;
        }
        this.logCommunication('rx', bytes, metadata);
      });

      this.connection.on('close', () => {
        this.connected = false;
        console.log(`Serial interface closed on ${this.portName}`);
      });

      this.connection.on('error', (error) => {
        this.connected = false;
        console.error(`[Intellibox ERROR] ${this.portName}: ${error.message}`);
      });
    } catch (error) {
      console.error(`Unable to open serial port ${this.portName}: ${error.message}`);
      this.connection = null;
      this.connected = false;
    }
  }

  getStatus() {
    return {
      connected: this.connected,
      port: this.portName,
      baudRate: this.baudRate,
      protocol: this.protocol,
      hardwareHandshake: this.hardwareHandshake,
      lastPacket: this.lastPacket,
      lastReceivedPacket: this.lastReceivedPacket
    };
  }

  // Legacy P50 (Märklin 6050 compatible): 2 bytes per command,
  // [speed 0..14 (+16 = light on), address 1..80]. Speed 15 toggles direction,
  // so the absolute direction has to be tracked per locomotive.
  buildLegacyP50LocomotivePacket({ decoderId, speed, direction, stop }) {
    const address = Number(decoderId);
    if (!Number.isInteger(address) || address < 1 || address > 80) {
      throw new Error('P50 supports decoder addresses 1-80 only.');
    }

    const uiSpeed = stop ? 0 : clampSpeed(speed);
    const p50Speed = uiSpeed === 0 ? 0 : Math.max(1, Math.round((uiSpeed * 14) / MAX_SPEED));
    const wanted = direction === 'reverse' ? 'reverse' : 'forward';
    const current = this.p50Directions.get(address) || 'forward';

    const packet = [];
    if (wanted !== current) {
      // Locomotive must be stopped before the direction change command.
      packet.push(0x00, address, 0x0f, address);
      this.p50Directions.set(address, wanted);
    }
    packet.push(p50Speed, address);
    return packet;
  }

  // P50Xb XLok: 'X', 0x80, address low, address high, speed, flags.
  // speed: 0 = stop, 1 = emergency stop, 2..127 = speed.
  // flags: bit5 = direction (1 = forward), bit4 = light (F0).
  buildP50XLocomotivePacket({ decoderId, speed, direction, stop, emergency }) {
    const address = Number(decoderId);
    if (!Number.isInteger(address) || address < 1 || address > 10239) {
      throw new Error('P50X supports decoder addresses 1-10239.');
    }

    const uiSpeed = stop ? 0 : clampSpeed(speed);
    const p50xSpeed = emergency ? 0x01 : uiSpeed === 0 ? 0x00 : uiSpeed + 1;
    const flags = direction === 'reverse' ? 0x00 : P50X_DIR_FORWARD;

    return [
      P50X_PREFIX,
      P50X_XLOK,
      address & 0xff,
      (address >> 8) & 0xff,
      p50xSpeed,
      flags
    ];
  }

  buildLocomotivePacket({ decoderId, speed, direction, stop, emergency }) {
    const packet = this.protocol === 'P50'
      ? this.buildLegacyP50LocomotivePacket({ decoderId, speed, direction, stop })
      : this.buildP50XLocomotivePacket({ decoderId, speed, direction, stop, emergency });

    this.lastPacket = packet;
    return packet;
  }

  sendLocomotiveCommand({ decoderId, speed, direction, stop, emergency }) {
    const packet = this.buildLocomotivePacket({
      decoderId,
      speed,
      direction,
      stop,
      emergency
    });

    const packetHex = packet.map((byte) => `0x${byte.toString(16).padStart(2, '0').toUpperCase()}`);
    this.logCommunication('tx', packet, {
      decoderId,
      speed: stop ? 0 : clampSpeed(speed),
      direction,
      stop,
      emergency: Boolean(emergency),
      protocol: this.protocol
    });

    if (!this.connection || !this.connection.isOpen) {
      return {
        success: false,
        packet: packetHex,
        response: this.lastReceivedPacket,
        error: `Serial port ${this.portName} is not open. Check the USB serial adapter and serial settings.`
      };
    }

    this.connection.write(Buffer.from(packet), (error) => {
      if (error) {
        console.error('[Intellibox TX ERROR]', error.message);
      }
    });

    return {
      success: true,
      packet: packetHex,
      response: this.lastReceivedPacket,
      protocol: this.protocol
    };
  }
}

SerialService.DEFAULT_BAUD_RATE = DEFAULT_BAUD_RATE;
SerialService.SUPPORTED_BAUD_RATES = SUPPORTED_BAUD_RATES;
SerialService.MAX_SPEED = MAX_SPEED;

module.exports = SerialService;
