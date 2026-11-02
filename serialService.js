const { SerialPort } = require('serialport');

class SerialService {
  constructor(portName) {
    this.portName = portName || process.env.SERIAL_PORT || '/dev/ttyUSB0';
    this.connection = null;
    this.connected = false;
    this.lastPacket = [];
    this.connect();
  }

  connect() {
    try {
      this.connection = new SerialPort({
        path: this.portName,
        baudRate: 19200,
        dataBits: 8,
        stopBits: 1,
        parity: 'none'
      });

      this.connection.on('open', () => {
        this.connected = true;
        console.log(`Connected to serial interface on ${this.portName}`);
      });

      this.connection.on('close', () => {
        this.connected = false;
        console.log(`Serial interface closed on ${this.portName}`);
      });

      this.connection.on('error', (error) => {
        this.connected = false;
        console.error(`Serial error on ${this.portName}: ${error.message}`);
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
      lastPacket: this.lastPacket
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

    if (!this.connection || !this.connection.isOpen) {
      return {
        success: false,
        packet: packetHex,
        error: `Serial port ${this.portName} is not open. Check that the USB serial adapter is connected.`
      };
    }

    this.connection.write(Buffer.from(packet), (error) => {
      if (error) {
        console.error('Failed to write packet:', error.message);
      }
    });

    return {
      success: true,
      packet: packetHex
    };
  }
}

module.exports = SerialService;
