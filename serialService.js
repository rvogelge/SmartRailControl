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
// XLok byte 4, bit 6: take the locomotive over even when another controller (e.g. the
// Intellibox's own throttle) has it; without it the Intellibox answers 0x0D (XLKBUSY).
const P50X_FORCE = 0x40;
const P50X_LIGHT = 0x10;
const P50X_XFUNC = 0x88; // F1-F8 of a locomotive
const P50_FUNCTION = 0x40; // legacy P50: 64 + f1..f4 bits, then the address
const FUNCTION_COUNT = 4;
const P50X_XTRNT = 0x90;
const P50X_XSENSOR = 0x98; // read one s88 module
const P50X_XEVENT = 0xc8; // which kinds of events are pending
const P50X_XEVTSEN = 0xcb; // s88 modules that changed
const P50X_XSTATUS = 0xa2; // one status byte, bit 3 = track power on (Go)
const P50X_XSTOP = 0xa6; // track power off (Stop)
const P50X_XGO = 0xa7; // track power on (Go)
const P50X_STATUS_GO = 0x08;
const P50_GO = 0x60; // legacy P50: no reply
const P50_STOP = 0x61;
const P50_S88_READ = 0x80; // legacy P50: 0x80 + n reads modules 1..n (2 bytes each)
const MAX_S88_MODULES = 31;
// A reply that does not arrive within this time is given up and the input is resynced.
const REPLY_TIMEOUT_MS = 1000;
// settle(): the line counts as quiet once nothing arrived for this long.
const SETTLE_QUIET_MS = 500;
// A port that closed by itself (USB adapter gone) is opened again this often.
const RECONNECT_MS = 2000;
const SETTLE_MAX_MS = 5000;
const P50X_STATUS_OK = 0x00;
// One-byte replies of the Intellibox to P50X commands.
const P50X_REPLIES = {
  0x00: 'OK',
  0x01: 'XERROR (unknown command)',
  0x02: 'XBADPRM (bad parameter)',
  0x06: 'XPWOFF (track power off)',
  0x08: 'XNOLSPC (no space in the loco command queue)',
  0x0a: 'XNODATA (no data)',
  0x0b: 'XNOSLOT (command queue full)',
  0x0c: 'XLOKBADPRM (bad loco parameter)',
  0x0d: 'XLKBUSY (loco is controlled by another device)',
  0x0e: 'XBADTRNT (bad turnout address)',
  0x41: 'XLKHALT (accepted, Intellibox in halt mode)',
  0x42: 'XLKPOFF (accepted, track power off)'
};

// Solenoid outputs are switched on and off again after this time (like a keyboard press).
const DEFAULT_SWITCH_TIME_MS = 250;
const P50X_MAX_ACCESSORY = 2047; // 11-bit address field
const P50_MAX_ACCESSORY = 256;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// UI speed range 0..126; P50X uses 0 = stop, 1 = emergency stop, 2..127 = speed steps.
const MAX_SPEED = 126;

// Reply readers: given the bytes received so far, return how many bytes form the
// complete reply, or 0 while it is still incomplete.
const fixedReply = (length) => (bytes) => (bytes.length >= length ? length : 0);
const REPLY_READERS = {
  status: fixedReply(1),
  // XEvent: 1..n bytes, bit 7 set = another byte follows.
  event: (bytes) => {
    const end = bytes.findIndex((b) => (b & 0x80) === 0);
    return end === -1 ? 0 : end + 1;
  },
  // XEvtSen: [module, contacts 1-8, contacts 9-16] per changed module, then 0x00.
  sensorEvents: (bytes) => {
    let pos = 0;
    while (pos < bytes.length) {
      if (bytes[pos] === 0) return pos + 1;
      if (pos + 3 > bytes.length) return 0;
      pos += 3;
    }
    return 0;
  },
  // XSensor: status byte, then (only if OK) contacts 1-8 and 9-16.
  sensor: (bytes) => {
    if (bytes.length === 0) return 0;
    if (bytes[0] !== P50X_STATUS_OK) return 1;
    return bytes.length >= 3 ? 3 : 0;
  }
};

const clampSpeed = (speed) => Math.max(0, Math.min(MAX_SPEED, Math.round(Number(speed) || 0)));

class SerialService {
  constructor(portName, baudRate = Number(process.env.SERIAL_BAUD_RATE || DEFAULT_BAUD_RATE)) {
    const serialDisabledValue = String(process.env.SMARTRAILCONTROL_SERIAL_DISABLED ?? '').toLowerCase();
    const serialEnabledValue = String(process.env.SMARTRAILCONTROL_SERIAL_ENABLED ?? '').toLowerCase();

    this.disabled = ['1', 'true', 'yes', 'on'].includes(serialDisabledValue) || (
      serialDisabledValue === '' &&
      serialEnabledValue !== '' &&
      ['0', 'false', 'no', 'off'].includes(serialEnabledValue)
    );

    this.portName = portName || process.env.SERIAL_PORT || '/dev/ttyUSB0';
    this.baudRate = Number.isInteger(baudRate) ? Number(baudRate) : DEFAULT_BAUD_RATE;
    this.protocol = (process.env.INTELLIBOX_PROTOCOL || DEFAULT_PROTOCOL).toUpperCase();
    this.hardwareHandshake = process.env.SERIAL_RTSCTS !== 'false';
    this.p50Directions = new Map();
    this.switchTimeMs = Number(process.env.ACCESSORY_SWITCH_TIME_MS || DEFAULT_SWITCH_TIME_MS);
    this.queue = Promise.resolve();
    this.connection = null;
    this.connected = false;
    this.lastPacket = [];
    this.lastReceivedPacket = [];
    this.rxBuffer = [];
    this.pendingReplies = []; // FIFO: the Intellibox answers commands in order
    this.unexpectedBytes = 0; // bytes no command waited for: replies may be out of step
    this.lastRxAt = 0;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    if (this.disabled) {
      console.log('Serial interface disabled via SMARTRAILCONTROL_SERIAL_DISABLED. Running in layout-only mode.');
      return;
    }
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

  // Opens the port. When it closes by itself (USB adapter gone, e.g. after a power dip)
  // or cannot be opened, it is tried again every RECONNECT_MS until it works.
  connect() {
    if (this.disabled) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;

    const previous = this.connection;
    this.connection = null; // its close event no longer counts as "lost"
    if (previous && previous.isOpen) {
      previous.close();
    }

    let conn;
    try {
      conn = new SerialPort({
        path: this.portName,
        baudRate: this.baudRate,
        dataBits: 8,
        stopBits: 2,
        parity: 'none',
        rtscts: this.hardwareHandshake
      });
    } catch (error) {
      console.error(`Unable to open serial port ${this.portName}: ${error.message}`);
      this.connected = false;
      this.scheduleReconnect();
      return;
    }
    this.connection = conn;

    conn.on('open', () => {
      if (this.connection !== conn) return;
      this.connected = true;
      this.lastRxAt = Date.now(); // settle() waits a quiet period from here
      if (this.reconnectAttempts > 0) {
        console.log(`Reconnected to serial interface on ${this.portName} @ ${this.baudRate} baud after ${this.reconnectAttempts} attempt(s)`);
      } else {
        console.log(`Connected to serial interface on ${this.portName} @ ${this.baudRate} baud`);
      }
      this.reconnectAttempts = 0;
    });

    conn.on('data', (chunk) => {
      if (this.connection === conn) this.handleData(chunk);
    });

    conn.on('close', () => {
      if (this.connection !== conn) return; // replaced on purpose (new settings)
      this.connected = false;
      this.failPendingReplies('Serial port closed.');
      console.log(`Serial interface closed on ${this.portName}`);
      this.scheduleReconnect();
    });

    conn.on('error', (error) => {
      if (this.connection !== conn) return;
      this.connected = false;
      if (this.reconnectAttempts === 0) console.error(`[Intellibox ERROR] ${this.portName}: ${error.message}`);
      // Opening failed (no 'close' follows): try again later.
      if (!conn.isOpen) this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.disabled || this.reconnectTimer) return;
    if (this.reconnectAttempts === 0) console.log(`Serial port ${this.portName} lost: trying to reconnect every ${RECONNECT_MS / 1000} s`);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_MS);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
  }

  isOpen() {
    return !this.disabled && Boolean(this.connection && this.connection.isOpen);
  }

  /* ---------- Replies ---------- */

  // Bytes from the Intellibox are matched, in order, to the commands that expect a reply.
  handleData(chunk) {
    this.lastRxAt = Date.now();
    this.rxBuffer.push(...chunk);
    while (this.rxBuffer.length > 0) {
      const pending = this.pendingReplies[0];
      if (!pending) {
        this.unexpectedBytes += this.rxBuffer.length;
        this.logCommunication('rx', this.rxBuffer, { unexpected: true });
        this.rxBuffer = [];
        return;
      }
      const length = pending.reader(this.rxBuffer);
      if (length === 0) return;
      const reply = this.rxBuffer.slice(0, length);
      this.rxBuffer = this.rxBuffer.slice(length);
      this.pendingReplies.shift();
      clearTimeout(pending.timer);
      if (!pending.quiet) {
        this.lastReceivedPacket = reply;
        const metadata = { reply: pending.label };
        if (pending.reader === REPLY_READERS.status) {
          metadata.status = P50X_REPLIES[reply[0]] || `unknown reply 0x${reply[0].toString(16).padStart(2, '0').toUpperCase()}`;
        }
        this.logCommunication('rx', reply, metadata);
      }
      pending.resolve(reply);
    }
  }

  // Registers the reply for a command that is about to be written.
  expectReply(reader, { label, quiet = false } = {}) {
    return new Promise((resolve, reject) => {
      const pending = { reader, label, quiet, resolve, reject };
      pending.timer = setTimeout(() => {
        const index = this.pendingReplies.indexOf(pending);
        if (index !== -1) this.pendingReplies.splice(index, 1);
        // Whatever arrived for this reply is unusable: start over with an empty buffer.
        this.rxBuffer = [];
        reject(new Error(`No reply from the Intellibox (${label}).`));
      }, REPLY_TIMEOUT_MS);
      if (pending.timer.unref) pending.timer.unref();
      this.pendingReplies.push(pending);
    });
  }

  // Waits until the Intellibox has stopped sending (no reply pending, nothing received for
  // quietMs), then drops whatever is left in the input. After opening the port or after
  // stray bytes, replies would otherwise be matched to the wrong command.
  async settle({ quietMs = SETTLE_QUIET_MS, maxMs = SETTLE_MAX_MS } = {}) {
    const start = Date.now();
    while (this.pendingReplies.length > 0 || Date.now() - this.lastRxAt < quietMs) {
      if (Date.now() - start > maxMs) throw new Error('the Intellibox keeps sending unexpected data');
      await sleep(Math.min(50, quietMs));
    }
    this.rxBuffer = [];
  }

  failPendingReplies(message) {
    const pending = this.pendingReplies;
    this.pendingReplies = [];
    this.rxBuffer = [];
    pending.forEach((p) => {
      clearTimeout(p.timer);
      p.reject(new Error(message));
    });
  }

  // Writes a command and resolves with its reply bytes.
  async request(packet, reader, { label, quiet = false } = {}) {
    if (!this.isOpen()) {
      throw new Error(`Serial port ${this.portName} is not open.`);
    }
    const reply = this.expectReply(reader, { label, quiet });
    this.write(packet, { label, quiet }).catch(() => {});
    return reply;
  }

  // Raw write. Does not wait for a reply.
  write(packet, { label, quiet = false } = {}) {
    if (!quiet) {
      this.lastPacket = packet;
      this.logCommunication('tx', packet, { request: label, protocol: this.protocol });
    }
    return new Promise((resolve, reject) => {
      this.connection.write(Buffer.from(packet), (error) => {
        if (error) {
          console.error('[Intellibox TX ERROR]', error.message);
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /* ---------- Feedback (s88) ---------- */

  // P50X: kinds of pending events, as the raw flag bytes.
  readEvents() {
    return this.request([P50X_PREFIX, P50X_XEVENT], REPLY_READERS.event, { label: 'XEvent', quiet: true });
  }

  // P50X: modules whose contacts changed: [{ module, bytes: [contacts 1-8, contacts 9-16] }].
  async readSensorEvents() {
    const reply = await this.request([P50X_PREFIX, P50X_XEVTSEN], REPLY_READERS.sensorEvents, { label: 'XEvtSen', quiet: true });
    const modules = [];
    for (let pos = 0; reply[pos] !== 0; pos += 3) {
      modules.push({ module: reply[pos], bytes: [reply[pos + 1], reply[pos + 2]] });
    }
    return modules;
  }

  // P50X: current state of one module, [contacts 1-8, contacts 9-16].
  async readSensorModule(module) {
    const reply = await this.request([P50X_PREFIX, P50X_XSENSOR, module], REPLY_READERS.sensor, { label: `XSensor ${module}`, quiet: true });
    if (reply[0] !== P50X_STATUS_OK) {
      throw new Error(`s88 module ${module}: ${P50X_REPLIES[reply[0]] || `error 0x${reply[0].toString(16)}`}`);
    }
    return reply.slice(1);
  }

  // Legacy P50: modules 1..count, [{ module, bytes }].
  async readP50Sensors(count) {
    const n = Math.max(1, Math.min(MAX_S88_MODULES, count));
    const reply = await this.request([P50_S88_READ + n], fixedReply(2 * n), { label: `s88 read 1-${n}`, quiet: true });
    return Array.from({ length: n }, (_v, i) => ({ module: i + 1, bytes: [reply[2 * i], reply[2 * i + 1]] }));
  }

  /* ---------- Track power (Go / Stop) ---------- */

  // P50X: true = track power on (Go), false = off (Stop). P50 cannot tell: null.
  async readPower() {
    if (this.protocol === 'P50') return null;
    const reply = await this.request([P50X_PREFIX, P50X_XSTATUS], REPLY_READERS.status, { label: 'XStatus', quiet: true });
    return Boolean(reply[0] & P50X_STATUS_GO);
  }

  // Switches the track power on (Go) or off (Stop).
  async setPower(on) {
    if (this.disabled) throw new Error('Serial output is disabled.');
    if (!this.isOpen()) throw new Error(`Serial port ${this.portName} is not open.`);
    if (this.protocol === 'P50') {
      await this.write([on ? P50_GO : P50_STOP], { label: on ? 'Go' : 'Stop' });
      return { ok: true };
    }
    const label = on ? 'XGo' : 'XStop';
    const reply = await this.request([P50X_PREFIX, on ? P50X_XGO : P50X_XSTOP], REPLY_READERS.status, { label });
    if (reply[0] !== P50X_STATUS_OK) {
      throw new Error(`${label}: ${P50X_REPLIES[reply[0]] || `reply 0x${reply[0].toString(16)}`}`);
    }
    return { ok: true };
  }

  getStatus() {
    return {
      connected: this.connected,
      disabled: this.disabled,
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
  buildLegacyP50LocomotivePacket({ decoderId, speed, direction, stop, light = false }) {
    const address = Number(decoderId);
    if (!Number.isInteger(address) || address < 1 || address > 80) {
      throw new Error('P50 supports decoder addresses 1-80 only.');
    }

    const uiSpeed = stop ? 0 : clampSpeed(speed);
    const p50Speed = uiSpeed === 0 ? 0 : Math.max(1, Math.round((uiSpeed * 14) / MAX_SPEED));
    const wanted = direction === 'reverse' ? 'reverse' : 'forward';
    const current = this.p50Directions.get(address) || 'forward';

    // P50: +16 in the speed byte switches the function (light, F0) on.
    const fn = light ? 0x10 : 0x00;
    const packet = [];
    if (wanted !== current) {
      // Locomotive must be stopped before the direction change command.
      packet.push(0x00 | fn, address, 0x0f | fn, address);
      this.p50Directions.set(address, wanted);
    }
    packet.push(p50Speed | fn, address);
    return packet;
  }

  // P50Xb XLok: 'X', 0x80, address low, address high, speed, flags.
  // speed: 0 = stop, 1 = emergency stop, 2..127 = speed.
  // flags: bit5 = direction (1 = forward), bit4 = light (F0).
  buildP50XLocomotivePacket({ decoderId, speed, direction, stop, emergency, light = false }) {
    const address = Number(decoderId);
    if (!Number.isInteger(address) || address < 1 || address > 10239) {
      throw new Error('P50X supports decoder addresses 1-10239.');
    }

    const uiSpeed = stop ? 0 : clampSpeed(speed);
    const p50xSpeed = emergency ? 0x01 : uiSpeed === 0 ? 0x00 : uiSpeed + 1;
    const flags = (direction === 'reverse' ? 0x00 : P50X_DIR_FORWARD) | P50X_FORCE | (light ? P50X_LIGHT : 0x00);

    return [
      P50X_PREFIX,
      P50X_XLOK,
      address & 0xff,
      (address >> 8) & 0xff,
      p50xSpeed,
      flags
    ];
  }

  buildLocomotivePacket({ decoderId, speed, direction, stop, emergency, light }) {
    const packet = this.protocol === 'P50'
      ? this.buildLegacyP50LocomotivePacket({ decoderId, speed, direction, stop, light })
      : this.buildP50XLocomotivePacket({ decoderId, speed, direction, stop, emergency, light });

    this.lastPacket = packet;
    return packet;
  }

  sendLocomotiveCommand({ decoderId, speed, direction, stop, emergency, light }) {
    const packet = this.buildLocomotivePacket({
      decoderId,
      speed,
      direction,
      stop,
      emergency,
      light
    });

    const packetHex = packet.map((byte) => `0x${byte.toString(16).padStart(2, '0').toUpperCase()}`);
    this.logCommunication('tx', packet, {
      decoderId,
      speed: stop ? 0 : clampSpeed(speed),
      direction,
      stop,
      emergency: Boolean(emergency),
      light: Boolean(light),
      protocol: this.protocol
    });

    if (this.disabled) {
      return {
        success: false,
        packet: packetHex,
        error: 'Serial output is disabled. This deployment is running in layout-only mode.'
      };
    }

    if (!this.connection || !this.connection.isOpen) {
      return {
        success: false,
        packet: packetHex,
        response: this.lastReceivedPacket,
        error: `Serial port ${this.portName} is not open. Check the USB serial adapter and serial settings.`
      };
    }

    if (this.protocol !== 'P50') {
      // XLok answers with one status byte; it is logged when it arrives.
      this.expectReply(REPLY_READERS.status, { label: 'XLok' }).catch(() => {});
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

  /* ---------- Locomotive functions (F1-F4) ---------- */

  // functions: array of booleans, index 0 = F1. F5-F8 are always sent as off.
  // P50X XFunc: 'X', 0x88, address low, address high, bit0 = F1 ... bit7 = F8.
  // Legacy P50: [64 + f1*1 + f2*2 + f3*4 + f4*8, address 1..80].
  buildFunctionPacket({ decoderId, functions }) {
    const address = Number(decoderId);
    const bits = Array.from({ length: FUNCTION_COUNT }, (_v, i) => Boolean(functions && functions[i]))
      .reduce((value, on, i) => value | (on ? 1 << i : 0), 0);

    if (this.protocol === 'P50') {
      if (!Number.isInteger(address) || address < 1 || address > 80) {
        throw new Error('P50 supports decoder addresses 1-80 only.');
      }
      return [P50_FUNCTION + bits, address];
    }
    if (!Number.isInteger(address) || address < 1 || address > 10239) {
      throw new Error('P50X supports decoder addresses 1-10239.');
    }
    return [P50X_PREFIX, P50X_XFUNC, address & 0xff, (address >> 8) & 0xff, bits];
  }

  sendFunctionCommand({ decoderId, functions }) {
    const packet = this.buildFunctionPacket({ decoderId, functions });
    this.lastPacket = packet;
    const packetHex = packet.map((byte) => `0x${byte.toString(16).padStart(2, '0').toUpperCase()}`);
    this.logCommunication('tx', packet, { decoderId, functions, protocol: this.protocol });

    if (this.disabled) {
      return {
        success: false,
        packet: packetHex,
        error: 'Serial output is disabled. This deployment is running in layout-only mode.'
      };
    }
    if (!this.connection || !this.connection.isOpen) {
      return {
        success: false,
        packet: packetHex,
        error: `Serial port ${this.portName} is not open. Check the USB serial adapter and serial settings.`
      };
    }

    if (this.protocol !== 'P50') {
      this.expectReply(REPLY_READERS.status, { label: 'XFunc' }).catch(() => {});
    }
    this.connection.write(Buffer.from(packet), (error) => {
      if (error) console.error('[Intellibox TX ERROR]', error.message);
    });
    return { success: true, packet: packetHex, protocol: this.protocol };
  }

  /* ---------- Accessories (turnouts, signals, uncouplers) ---------- */

  // color: 'green' (straight / go) or 'red' (diverging / stop); on: output on or off.
  // P50X XTrnt: 'X', 0x90, address low, [bit7 = green, bit6 = on, bits2..0 = address high].
  // Legacy P50: [33 = green | 34 = red, address 1..256 (256 sent as 0)], off = [32].
  buildAccessoryPacket({ address, color, on }) {
    const value = Number(address);
    const green = color === 'green';

    if (this.protocol === 'P50') {
      if (!on) return [0x20];
      if (!Number.isInteger(value) || value < 1 || value > P50_MAX_ACCESSORY) {
        throw new Error(`P50 supports accessory addresses 1-${P50_MAX_ACCESSORY} only.`);
      }
      return [green ? 0x21 : 0x22, value & 0xff];
    }

    if (!Number.isInteger(value) || value < 1 || value > P50X_MAX_ACCESSORY) {
      throw new Error(`P50X supports accessory addresses 1-${P50X_MAX_ACCESSORY}.`);
    }
    return [
      P50X_PREFIX,
      P50X_XTRNT,
      value & 0xff,
      ((value >> 8) & 0x07) | (green ? 0x80 : 0x00) | (on ? 0x40 : 0x00)
    ];
  }

  writePacket(packet, metadata = {}) {
    this.lastPacket = packet;
    this.logCommunication('tx', packet, { ...metadata, protocol: this.protocol });

    if (this.disabled) {
      return Promise.reject(
        new Error('Serial output is disabled. This deployment is running in layout-only mode.')
      );
    }

    if (!this.connection || !this.connection.isOpen) {
      return Promise.reject(
        new Error(`Serial port ${this.portName} is not open. Check the USB serial adapter and serial settings.`)
      );
    }

    if (this.protocol !== 'P50') {
      // XTrnt answers with one status byte; it is logged when it arrives.
      this.expectReply(REPLY_READERS.status, { label: 'XTrnt' }).catch(() => {});
    }
    return this.write(packet, { quiet: true });
  }

  // Sends [{ address, color }] one after another: output on, wait, output off.
  // Calls are queued so commands from fast clicks never interleave.
  sendAccessoryCommands(commands) {
    const packets = commands.flatMap(({ address, color }) => [
      this.buildAccessoryPacket({ address, color, on: true }),
      this.buildAccessoryPacket({ address, color, on: false })
    ]);
    const toHex = (packet) => this.formatPacketHex(packet);

    const run = async () => {
      for (const { address, color } of commands) {
        await this.writePacket(this.buildAccessoryPacket({ address, color, on: true }), { accessory: address, color, on: true });
        await sleep(this.switchTimeMs);
        await this.writePacket(this.buildAccessoryPacket({ address, color, on: false }), { accessory: address, color, on: false });
      }
    };

    const job = this.queue.then(run);
    this.queue = job.catch(() => {});
    return job.then(
      () => ({ success: true, packets: packets.map(toHex) }),
      (error) => ({ success: false, packets: packets.map(toHex), error: error.message })
    );
  }
}

SerialService.P50X_STATUS_OK = P50X_STATUS_OK;
SerialService.DEFAULT_BAUD_RATE = DEFAULT_BAUD_RATE;
SerialService.SUPPORTED_BAUD_RATES = SUPPORTED_BAUD_RATES;
SerialService.MAX_SPEED = MAX_SPEED;
SerialService.MAX_S88_MODULES = MAX_S88_MODULES;
SerialService.REPLY_READERS = REPLY_READERS;

module.exports = SerialService;
