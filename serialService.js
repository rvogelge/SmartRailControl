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
        baudRate: 57600,
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
    // The Intellibox connected via a LocoNet-capable serial adapter expects a
    // LocoNet-style serial packet, not a raw DCC locomotive packet.
    const address = Number(decoderId);
    const safeSpeed = stop ? 0 : Math.max(0, Math.min(127, Number(speed) || 0));
    const directionByte = direction === 'reverse' ? 0x20 : 0x00;

    // LocoNet-style frame skeleton: packet marker, operation code, address bytes,
    // speed/direction byte, and a checksum byte.
    const frame = [
      0x80,
      0xA5,
      address & 0xFF,
      (address >> 8) & 0xFF,
      (directionByte | (safeSpeed & 0x1F)) & 0xFF,
      0x00
    ];

    const checksum = (0x100 - (frame.slice(1).reduce((sum, byte) => sum + byte, 0) & 0xFF)) & 0xFF;
    const loconetPacket = [...frame.slice(0, -1), checksum];

    this.lastPacket = loconetPacket;
    return loconetPacket;
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
