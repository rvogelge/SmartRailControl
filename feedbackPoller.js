// Reads the s88 feedback modules through the Intellibox and reports every contact
// that changes. Contact numbers count across modules: module 1 = contacts 1–16,
// module 2 = 17–32, … Within a module the first byte holds contacts 1–8 (bit 7 =
// contact 1), the second byte contacts 9–16.
//
// P50X: after (re)connecting, every module is read once with XSensor; contacts that
// are already occupied then are reported with `initial: true` (they should not fire
// rules). After that the Intellibox is asked for events (XEvent) and only changed
// modules are fetched (XEvtSen), so short pulses are not missed between polls.
// Legacy P50: modules 1..n are read on every poll.

const DEFAULT_POLL_MS = 150;
const ERROR_RETRY_MS = 2000;
const P50X_EVENT_SENSOR = 0x04;

// [byte1, byte2] of module m → [[contact, on], …] for all 16 contacts.
const decodeModule = (module, [high, low]) =>
  Array.from({ length: 16 }, (_v, i) => {
    const byte = i < 8 ? high : low;
    const on = Boolean((byte >> (7 - (i % 8))) & 1);
    return [(module - 1) * 16 + i + 1, on];
  });

class FeedbackPoller {
  // serial: SerialService · getModuleCount(): how many s88 modules to read
  // onChange({ contact, on, initial }) is called for every change.
  constructor({ serial, getModuleCount, onChange, pollMs = DEFAULT_POLL_MS }) {
    this.serial = serial;
    this.getModuleCount = getModuleCount;
    this.onChange = onChange;
    this.pollMs = pollMs;
    this.contacts = new Map(); // contact number -> on
    this.initialized = false;
    this.moduleCount = 0;
    this.timer = null;
    this.running = false;
    this.lastError = null;
    this.lastPollAt = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
  }

  schedule(ms) {
    if (!this.running) return;
    this.timer = setTimeout(() => this.loop(), ms);
    if (this.timer.unref) this.timer.unref();
  }

  async loop() {
    let wait = this.pollMs;
    try {
      await this.poll();
    } catch (error) {
      if (this.lastError !== error.message) console.error(`[s88] ${error.message}`);
      this.lastError = error.message;
      this.initialized = false; // read everything again once the Intellibox answers
      wait = ERROR_RETRY_MS;
    }
    this.schedule(wait);
  }

  async poll() {
    const modules = Math.min(this.serial.constructor.MAX_S88_MODULES || 31, this.getModuleCount());
    if (!this.serial.isOpen() || modules < 1) {
      this.initialized = false;
      return;
    }
    if (modules !== this.moduleCount) {
      // More or fewer modules than before: read all of them again.
      this.moduleCount = modules;
      this.initialized = false;
    }

    if (this.serial.protocol === 'P50') {
      const all = await this.serial.readP50Sensors(modules);
      all.forEach(({ module, bytes }) => this.apply(module, bytes, !this.initialized));
    } else if (!this.initialized) {
      for (let module = 1; module <= modules; module += 1) {
        this.apply(module, await this.serial.readSensorModule(module), true);
      }
      // Clear events the Intellibox collected before: the full read already covers them.
      const flags = await this.serial.readEvents();
      if (flags[0] & P50X_EVENT_SENSOR) await this.serial.readSensorEvents();
    } else {
      const flags = await this.serial.readEvents();
      if (flags[0] & P50X_EVENT_SENSOR) {
        const changed = await this.serial.readSensorEvents();
        changed.forEach(({ module, bytes }) => this.apply(module, bytes, false));
      }
    }

    if (!this.initialized || this.lastError) {
      console.log(`[s88] reading ${modules} feedback module${modules > 1 ? 's' : ''} (contacts 1–${modules * 16})`);
    }
    this.initialized = true;
    this.lastError = null;
    this.lastPollAt = new Date().toISOString();
  }

  apply(module, bytes, initial) {
    decodeModule(module, bytes).forEach(([contact, on]) => {
      const known = this.contacts.has(contact);
      if (known && this.contacts.get(contact) === on) return;
      this.contacts.set(contact, on);
      // On the first read only occupied contacts are news; free is the default.
      if (!known && !on) return;
      this.onChange({ contact, on, initial: initial || !known });
    });
  }

  isOn(contact) {
    return Boolean(this.contacts.get(contact));
  }

  // state: live | starting | error | off · code + params let the browser word it.
  getStatus() {
    const modules = this.getModuleCount();
    const status = (state, code, params = {}, text) => ({ state, code, params, text, modules, lastPollAt: this.lastPollAt });
    if (this.serial.disabled) return status('off', 'disabled', {}, 'serial interface disabled');
    if (!this.running) return status('off', 'stopped', {}, 'feedback reading switched off');
    if (modules < 1) return status('off', 'noContacts', {}, 'no contact track has a contact number');
    if (!this.serial.isOpen()) {
      return status('error', 'portClosed', { port: this.serial.portName }, `serial port ${this.serial.portName} not open`);
    }
    if (this.lastError) return status('error', 'error', { message: this.lastError }, this.lastError);
    if (!this.initialized) return status('starting', 'starting', {}, 'reading s88 modules…');
    return status('live', 'live', { modules }, `reading ${modules} s88 module${modules === 1 ? '' : 's'}`);
  }
}

FeedbackPoller.decodeModule = decodeModule;
FeedbackPoller.DEFAULT_POLL_MS = DEFAULT_POLL_MS;

module.exports = FeedbackPoller;
