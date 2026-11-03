const { SerialPort } = require('serialport');

const DEFAULT_BAUD_RATE = 57600;

class SerialService {
  constructor(portName, baudRate = Number(process.env.SERIAL_BAUD_RATE || DEFAULT_BAUD_RATE)) {
    this.portName = portName || process.env.SERIAL_PORT || '/dev/ttyUSB0';
    this.baudRate = Number.isInteger(baudRate) ? Number(baudRate) : DEFAULT_BAUD_RATE;
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
        stopBits: 1,
        parity: 'none'
      });

      this.connection.on('open', () => {
        this.connected = true;
        console.log(`Connected to serial interface on ${this.portName} @ ${this.baudRate} baud`);
      });

      this.connection.on('data', (chunk) => {
        const bytes = Array.from(chunk);
        this.lastReceivedPacket = bytes;
        this.logCommunication('rx', bytes, { length: bytes.length });
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
      lastPacket: this.lastPacket,
      lastReceivedPacket: this.lastReceivedPacket
    };
  }

  buildLocomotivePacket({ decoderId, speed, direction, stop }) {
    const address = Number(decoderId);
    const safeSpeed = stop ? 0 : Math.max(0, Math.min(127, Number(speed) || 0));
    const dirBit = direction === 'reverse' ? 0x20 : 0x00;

    const rawPacket = [
      0x80 | (address & 0x7f),
      0x40 | dirBit | Math.min(0x1f, safeSpeed >> 1),
      0x00
    ];

    this.lastPacket = rawPacket;
    return rawPacket;
  }

  sendLocomotiveCommand({ decoderId, speed, direction, stop }) {
    const packet = this.buildLocomotivePacket({
      decoderId,
      speed,
      direction,
      stop
    });

    const packetHex = packet.map((byte) => `0x${byte.toString(16).padStart(2, '0').toUpperCase()}`);
    this.logCommunication('tx', packet, {
      decoderId,
      speed: stop ? 0 : Math.max(0, Math.min(127, Number(speed) || 0)),
      direction,
      stop
    });

    if (!this.connection || !this.connection.isOpen) {
      return {
        success: false,
        packet: packetHex,
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
      packet: packetHex
    };
  }
}

module.exports = SerialService;
