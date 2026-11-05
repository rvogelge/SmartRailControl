const TrackCatalog = require('./public/trackCatalog');

const MAX_LOG = 50;
// A contact pressed by hand stays on this long, then turns off again (like a passing train).
const PULSE_MS = 2000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs the logic rules. Triggers: sensors (contact tracks) report on/off, and switchable
// elements (turnouts, signals) switched by hand report their new state. Every enabled
// rule whose trigger matches and whose conditions all hold runs its actions in order.
// Sensor states live in memory only (they describe the track right now, not the
// layout), switch states come from the saved layout.
//
// Actions switch elements (not as "by hand") and set locomotive speeds; they never
// change sensors, so one rule cannot start a chain of other rules.
class RuleEngine {
  // getRules(): saved rules · getTile(id): layout element or null
  // operate(tile, state): switches an element, resolves to { sent, error }
  // setLocoSpeed(block id, percent): speed of the locomotive in a block,
  //   resolves to { sent, error, loco }
  // isBlockOccupied(block id): for block conditions
  constructor({
    getRules,
    getTile,
    operate,
    setLocoSpeed = async () => ({ sent: false, error: 'not available' }),
    isBlockOccupied = () => false,
    wait = sleep
  }) {
    this.getRules = getRules;
    this.getTile = getTile;
    this.operate = operate;
    this.setLocoSpeed = setLocoSpeed;
    this.isBlockOccupied = isBlockOccupied;
    this.wait = wait;
    this.sensors = new Map(); // tile id -> true (on) / false (off)
    this.pulses = new Map(); // tile id -> timer of a manual press
    this.log = [];
    this.logSeq = 0;
  }

  sensorState(id) {
    return this.sensors.get(id) ? 'on' : 'off';
  }

  // Current state of any element a condition can test.
  stateOf(tile) {
    if (TrackCatalog.sensorStatesOf(tile.type)) return this.sensorState(tile.id);
    return tile.state;
  }

  addLog(entry) {
    this.logSeq += 1;
    this.log.unshift({ seq: this.logSeq, time: new Date().toISOString(), ...entry });
    this.log.length = Math.min(this.log.length, MAX_LOG);
  }

  // Returns { changed, fired: [rule ids] } and a promise for the running actions
  // (`done`), so callers can answer right away and tests can wait for completion.
  setSensor(id, active) {
    const tile = this.getTile(id);
    if (!tile || !TrackCatalog.sensorStatesOf(tile.type)) {
      throw new Error('Unknown sensor.');
    }
    const next = Boolean(active);
    const changed = Boolean(this.sensors.get(id)) !== next;
    this.sensors.set(id, next);
    if (!changed) return { changed, fired: [], done: Promise.resolve() };

    const state = next ? 'on' : 'off';
    const rules = this.getRules().filter(
      (rule) => rule.enabled && rule.trigger.device === id && rule.trigger.state === state
    );
    const fired = rules.filter((rule) => this.conditionsHold(rule));
    const done = Promise.all(fired.map((rule) => this.run(rule)));
    return { changed, fired: fired.map((rule) => rule.id), done };
  }

  // A turnout or signal was switched by hand (click): run the rules it triggers.
  // Returns { fired: [rule ids], done }.
  elementSwitched(id, state) {
    const rules = this.getRules().filter((rule) => rule.enabled && rule.trigger.device === id && rule.trigger.state === state);
    const fired = rules.filter((rule) => this.conditionsHold(rule));
    const done = Promise.all(fired.map((rule) => this.run(rule)));
    return { fired: fired.map((rule) => rule.id), done };
  }

  // Manual press: the contact turns on and, after `ms`, off again. Both changes run
  // their rules. Pressing again while it is on restarts the time.
  pulseSensor(id, ms = PULSE_MS) {
    this.cancelPulse(id);
    const result = this.setSensor(id, true);
    const timer = setTimeout(() => {
      this.pulses.delete(id);
      this.setSensor(id, false);
    }, ms);
    if (timer.unref) timer.unref();
    this.pulses.set(id, timer);
    return { ...result, pulseMs: ms };
  }

  // A real contact report wins over a running manual press.
  cancelPulse(id) {
    clearTimeout(this.pulses.get(id));
    this.pulses.delete(id);
  }

  // Takes over a sensor state without running rules (state at startup, layout changes).
  syncSensor(id, active) {
    this.sensors.set(id, Boolean(active));
  }

  conditionsHold(rule) {
    return rule.conditions.every((condition) => {
      if (condition.type === 'block') {
        if (!condition.block) return false;
        return Boolean(this.isBlockOccupied(condition.block)) === (condition.state === 'occupied');
      }
      const tile = this.getTile(condition.device);
      return Boolean(tile) && this.stateOf(tile) === condition.state;
    });
  }

  async run(rule) {
    this.addLog({ rule: rule.id, name: rule.name, kind: 'started', text: 'started' });
    for (const action of rule.actions) {
      if (action.delay > 0) await this.wait(action.delay * 1000);
      if (action.type === 'loco') {
        await this.runLocoAction(rule, action);
        continue;
      }
      const tile = this.getTile(action.device);
      if (!tile) {
        this.addLog({ rule: rule.id, name: rule.name, kind: 'missing', text: 'skipped an action: element no longer exists', error: true });
        continue;
      }
      const what = `${TrackCatalog.labelOf(tile.type)} → ${TrackCatalog.stateLabel(tile.type, action.state)}`;
      try {
        const result = await this.operate(tile, action.state);
        this.addLog({
          rule: rule.id,
          name: rule.name,
          kind: 'action',
          device: tile.id,
          type: tile.type,
          state: action.state,
          sent: Boolean(result.sent),
          reason: result.sent ? undefined : result.error,
          text: result.sent ? what : `${what} (not sent: ${result.error})`,
          error: !result.sent
        });
      } catch (error) {
        this.addLog({
          rule: rule.id,
          name: rule.name,
          kind: 'action',
          device: tile.id,
          type: tile.type,
          state: action.state,
          sent: false,
          reason: error.message,
          text: `${what} failed: ${error.message}`,
          error: true
        });
      }
    }
  }

  async runLocoAction(rule, action) {
    let result;
    try {
      result = await this.setLocoSpeed(action.block, action.speed);
    } catch (error) {
      result = { sent: false, error: error.message };
    }
    this.addLog({
      rule: rule.id,
      name: rule.name,
      kind: 'loco',
      block: action.block,
      speed: action.speed,
      loco: result.loco || null,
      sent: Boolean(result.sent),
      reason: result.sent ? undefined : result.error,
      text: result.sent ? `${result.loco} → ${action.speed}%` : `loco speed not set: ${result.error}`,
      error: !result.sent
    });
  }

  getLive() {
    return {
      sensors: Object.fromEntries([...this.sensors].filter(([, on]) => on).map(([id]) => [id, true])),
      log: this.log.slice()
    };
  }
}

RuleEngine.PULSE_MS = PULSE_MS;

module.exports = RuleEngine;
