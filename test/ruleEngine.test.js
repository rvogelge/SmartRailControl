const test = require('node:test');
const assert = require('node:assert/strict');
const RuleEngine = require('../ruleEngine');
const SettingsStore = require('../settingsStore');

const tiles = [
  { id: 'c1', type: 'contact', addresses: [5] },
  { id: 'c2', type: 'contact', addresses: [6] },
  { id: 't1', type: 'turnout-left', state: 'straight', addresses: [12] },
  { id: 's1', type: 'signal', state: 'stop', addresses: [20] },
  { id: 'u1', type: 'uncoupler', addresses: [30] }
];

const setup = (rules) => {
  const layout = new Map(tiles.map((t) => [t.id, { ...t }]));
  const calls = [];
  const waits = [];
  const engine = new RuleEngine({
    getRules: () => rules,
    getTile: (id) => (layout.has(id) ? { ...layout.get(id) } : null),
    operate: async (tile, state) => {
      calls.push([tile.id, state]);
      if (tile.state !== undefined) layout.get(tile.id).state = state;
      return { sent: true };
    },
    wait: async (ms) => {
      waits.push(ms);
    }
  });
  return { engine, calls, waits, layout };
};

const rule = (overrides) => ({
  id: 'r1',
  name: 'Rule',
  enabled: true,
  trigger: { device: 'c1', state: 'on' },
  conditions: [],
  actions: [{ device: 't1', state: 'diverging', delay: 0 }],
  ...overrides
});

test('switches a turnout when a contact turns on', async () => {
  const { engine, calls } = setup([rule()]);
  const result = engine.setSensor('c1', true);
  await result.done;
  assert.deepEqual(result.fired, ['r1']);
  assert.deepEqual(calls, [['t1', 'diverging']]);
  assert.deepEqual(engine.getLive().sensors, { c1: true });
});

test('fires only on a change to the trigger state', async () => {
  const { engine, calls } = setup([rule()]);
  await engine.setSensor('c1', true).done;
  await engine.setSensor('c1', true).done; // no change
  await engine.setSensor('c1', false).done; // wrong state
  assert.equal(calls.length, 1);
});

test('off triggers, conditions and disabled rules', async () => {
  const { engine, calls } = setup([
    rule({ id: 'off', trigger: { device: 'c1', state: 'off' }, actions: [{ device: 's1', state: 'go', delay: 0 }] }),
    rule({ id: 'cond', conditions: [{ device: 'c2', state: 'on' }], actions: [{ device: 'u1', state: 'trigger', delay: 0 }] }),
    rule({ id: 'disabled', enabled: false })
  ]);
  await engine.setSensor('c1', true).done; // c2 off: 'cond' does not fire
  assert.deepEqual(calls, []);
  await engine.setSensor('c1', false).done;
  assert.deepEqual(calls, [['s1', 'go']]);
  engine.setSensor('c2', true);
  const result = engine.setSensor('c1', true);
  await result.done;
  assert.deepEqual(result.fired, ['cond']);
  assert.deepEqual(calls.at(-1), ['u1', 'trigger']);
});

test('runs actions in order with their delays and skips removed elements', async () => {
  const { engine, calls, waits } = setup([
    rule({
      actions: [
        { device: 's1', state: 'go', delay: 0 },
        { device: 'gone', state: 'go', delay: 0 },
        { device: 's1', state: 'stop', delay: 2.5 }
      ]
    })
  ]);
  await engine.setSensor('c1', true).done;
  assert.deepEqual(calls, [['s1', 'go'], ['s1', 'stop']]);
  assert.deepEqual(waits, [2500]);
  assert.ok(engine.getLive().log.some((e) => e.error && /no longer exists/.test(e.text)));
});

test('rejects unknown sensors', () => {
  const { engine } = setup([]);
  assert.throws(() => engine.setSensor('t1', true), /Unknown sensor/);
  assert.throws(() => engine.setSensor('nope', true), /Unknown sensor/);
});

test('sanitizeRules checks kinds and states of existing elements', () => {
  const ok = SettingsStore.sanitizeRules([rule({ actions: [{ device: 't1', state: 'diverging', delay: 9999 }] })], tiles);
  assert.equal(ok[0].actions[0].delay, 3600);
  // Turnouts and signals can trigger (switched by hand), with their own states; uncouplers cannot.
  assert.equal(SettingsStore.sanitizeRules([rule({ trigger: { device: 't1', state: 'diverging' } })], tiles)[0].trigger.state, 'diverging');
  assert.throws(() => SettingsStore.sanitizeRules([rule({ trigger: { device: 't1', state: 'on' } })], tiles), /invalid state/);
  assert.throws(() => SettingsStore.sanitizeRules([rule({ trigger: { device: 'u1', state: 'trigger' } })], tiles), /cannot be used as a trigger/);
  assert.throws(() => SettingsStore.sanitizeRules([rule({ actions: [{ device: 'c2', state: 'on' }] })], tiles), /cannot be used as an action/);
  assert.throws(() => SettingsStore.sanitizeRules([rule({ actions: [{ device: 't1', state: 'left' }] })], tiles), /invalid state/);
  // References to removed elements are kept.
  const dangling = SettingsStore.sanitizeRules([rule({ actions: [{ device: 'gone', state: 'go' }] })], tiles);
  assert.equal(dangling[0].actions[0].device, 'gone');
});

test('a manual press turns the contact on, then off again after the pulse time', async () => {
  const offRule = rule({ id: 'off', trigger: { device: 'c1', state: 'off' }, actions: [{ device: 's1', state: 'stop', delay: 0 }] });
  const { engine, calls } = setup([rule(), offRule]);
  const pressed = engine.pulseSensor('c1', 30);
  await pressed.done;
  assert.deepEqual(pressed.fired, ['r1']);
  assert.deepEqual(engine.getLive().sensors, { c1: true });

  await new Promise((resolve) => setTimeout(resolve, 20));
  engine.pulseSensor('c1', 30); // pressed again: still on, time restarts, no second "on"
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(engine.getLive().sensors, { c1: true });

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(engine.getLive().sensors, {});
  assert.deepEqual(calls, [['t1', 'diverging'], ['s1', 'stop']]);
});

test('a real contact report cancels a running press', async () => {
  const { engine } = setup([]);
  engine.pulseSensor('c1', 30);
  engine.cancelPulse('c1');
  engine.setSensor('c1', true); // the s88 module says: occupied
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(engine.getLive().sensors, { c1: true });
});

test('a turnout or signal switched by hand runs the rules it triggers', async () => {
  const byTurnout = rule({ id: 'sw', trigger: { device: 't1', state: 'diverging' }, actions: [{ device: 's1', state: 'go', delay: 0 }] });
  const { engine, calls } = setup([byTurnout, rule()]);
  const other = engine.elementSwitched('t1', 'straight');
  await other.done;
  assert.deepEqual(other.fired, []);
  const result = engine.elementSwitched('t1', 'diverging');
  await result.done;
  assert.deepEqual(result.fired, ['sw']);
  assert.deepEqual(calls, [['s1', 'go']]);
});

test('loco action: sets the speed of the locomotive in a block, logged with the result', async () => {
  const speeds = [];
  const engine = new RuleEngine({
    getRules: () => [],
    getTile: () => null,
    operate: async () => ({ sent: true }),
    setLocoSpeed: async (block, percent) => {
      speeds.push([block, percent]);
      return block === 'b1' ? { sent: true, loco: 'V200' } : { sent: false, error: 'the block is free' };
    },
    wait: async () => {}
  });
  const r = rule({ trigger: { device: 'c1', state: 'on' }, actions: [{ type: 'loco', block: 'b1', speed: 40, delay: 0 }, { type: 'loco', block: 'b2', speed: 0, delay: 0 }] });
  await engine.run(r);
  assert.deepEqual(speeds, [['b1', 40], ['b2', 0]]);
  const [free, set] = engine.getLive().log; // newest first
  assert.equal(set.kind, 'loco');
  assert.equal(set.loco, 'V200');
  assert.equal(set.sent, true);
  assert.equal(free.sent, false);
  assert.equal(free.reason, 'the block is free');
});

test('sanitizeRules keeps loco actions with block and speed 0..100', () => {
  const [r] = SettingsStore.sanitizeRules([rule({ actions: [{ type: 'loco', block: 'b1', speed: 250, delay: 2 }, { type: 'loco', block: '../x', speed: -5 }] })], tiles);
  assert.deepEqual(r.actions, [{ type: 'loco', block: 'b1', speed: 100, emergency: false, delay: 2 }, { type: 'loco', block: null, speed: 0, emergency: false, delay: 0 }]);
});

test('block condition: the rule runs only while the block is free (or occupied)', async () => {
  const occupied = new Set(['b2']);
  const calls = [];
  const engine = new RuleEngine({
    getRules: () => [
      rule({ id: 'free', conditions: [{ type: 'block', block: 'b1', state: 'free' }] }),
      rule({ id: 'busy', conditions: [{ type: 'block', block: 'b2', state: 'occupied' }] }),
      rule({ id: 'notFree', conditions: [{ type: 'block', block: 'b2', state: 'free' }] }),
      rule({ id: 'noBlock', conditions: [{ type: 'block', block: null, state: 'free' }] })
    ],
    getTile: (id) => tiles.find((t) => t.id === id) || null,
    operate: async (tile, state) => {
      calls.push([tile.id, state]);
      return { sent: true };
    },
    isBlockOccupied: (id) => occupied.has(id),
    wait: async () => {}
  });
  const result = engine.setSensor('c1', true);
  await result.done;
  assert.deepEqual(result.fired, ['free', 'busy']);
});

test('sanitizeRules keeps block conditions (free / occupied)', () => {
  const [r] = SettingsStore.sanitizeRules([rule({ conditions: [{ type: 'block', block: 'b1', state: 'occupied' }, { type: 'block', block: 'b2', state: 'weird' }] })], tiles);
  assert.deepEqual(r.conditions, [{ type: 'block', block: 'b1', state: 'occupied' }, { type: 'block', block: 'b2', state: 'free' }]);
});

test('loco action at 0 % can stop immediately (emergency stop); only at 0 %', async () => {
  const [r] = SettingsStore.sanitizeRules([rule({ actions: [{ type: 'loco', block: 'b1', speed: 0, emergency: true }, { type: 'loco', block: 'b1', speed: 20, emergency: true }] })], tiles);
  assert.deepEqual(r.actions.map((a) => a.emergency), [true, false]);
  const calls = [];
  const engine = new RuleEngine({
    getRules: () => [],
    getTile: () => null,
    operate: async () => ({ sent: true }),
    setLocoSpeed: async (block, percent, options) => {
      calls.push([block, percent, options]);
      return { sent: true, loco: 'V200' };
    },
    wait: async () => {}
  });
  await engine.run(r);
  assert.deepEqual(calls, [['b1', 0, { emergency: true }], ['b1', 20, { emergency: false }]]);
  assert.equal(engine.getLive().log[1].emergency, true);
});
