const test = require('node:test');
const assert = require('node:assert/strict');
const TrackCatalog = require('../public/trackCatalog');
const BlockTracker = require('../blockTracker');
const RouteRunner = require('../routeRunner');

// Two blocks merge over turnout t into block d (all pointing left):
//   d(←) s0 ← t ← s3 ← a(←)          straight route: a
//               ↖ dg ← cu ← b(←)     diverging route: b
const merge = () => [
  { id: 's0', type: 'straight', x: 0, y: 0, rotation: 0 },
  { id: 'd', type: 'contact', x: 1, y: 0, rotation: 0, block: 'left' },
  { id: 't', type: 'turnout-right', x: 2, y: 0, rotation: 0, state: 'straight' },
  { id: 's3', type: 'straight', x: 3, y: 0, rotation: 0 },
  { id: 'a', type: 'contact', x: 4, y: 0, rotation: 0, block: 'left' },
  { id: 'dg', type: 'diagonal', x: 3, y: 1, rotation: 90 },
  { id: 'cu', type: 'curve-45-right', x: 4, y: 2, rotation: 180 },
  { id: 'b', type: 'contact', x: 5, y: 2, rotation: 0, block: 'left' }
];

test('findPath gives the turnout positions from one block into the next', () => {
  assert.deepEqual(TrackCatalog.findPath(merge(), 'a', 'd'), { tiles: ['a', 's3', 't', 'd'], turnouts: { t: 'straight' } });
  assert.deepEqual(TrackCatalog.findPath(merge(), 'b', 'd').turnouts, { t: 'diverging' });
  assert.equal(TrackCatalog.findPath(merge(), 'd', 'a'), null); // against the block direction
  assert.equal(TrackCatalog.findPath(merge(), 'a', 'b'), null); // no track between them
});

// A layout whose tiles the runner can switch, a tracker and a runner around it.
const setup = (routes) => {
  const tiles = merge();
  const stopped = [];
  const switched = [];
  const tracker = new BlockTracker({ getTiles: () => tiles, getLocoSpeed: () => 30 });
  const runner = new RouteRunner({
    tracker,
    getTiles: () => tiles,
    getRoutes: () => routes,
    setTurnout: async (id, state) => {
      switched.push([id, state]);
      tiles.find((t) => t.id === id).state = state;
    },
    stopLoco: (name) => stopped.push(name)
  });
  return { tiles, tracker, runner, stopped, switched };
};

test('a run sets the turnouts towards the next block of the sequence', async () => {
  const { tracker, runner, switched, stopped } = setup([{ id: 'r', name: 'R', blocks: ['b', 'd'], loop: false }]);
  tracker.set('b', { occupied: true, loco: 'V200' });
  await runner.start('r', 'V200');
  assert.deepEqual(switched, [['t', 'diverging']]);
  assert.equal(runner.getLive().r.code, 'running');
  assert.deepEqual(stopped, []);

  // The train reaches d: end of a route that is not a loop.
  tracker.contactOn('d');
  await runner.evaluate();
  assert.equal(runner.getLive().r.code, 'finished');
  assert.deepEqual(stopped, ['V200']);
});

test('an occupied next block stops the locomotive; when it is free, the turnouts are set', async () => {
  const { tracker, runner, switched, stopped } = setup([{ id: 'r', name: 'R', blocks: ['b', 'd'], loop: false }]);
  tracker.set('b', { occupied: true, loco: 'V200' });
  tracker.set('d', { occupied: true, loco: null });
  await runner.start('r', 'V200');
  assert.equal(runner.getLive().r.code, 'waiting');
  assert.deepEqual(stopped, ['V200']);
  assert.deepEqual(switched, []);

  tracker.set('d', { occupied: false });
  await runner.evaluate();
  assert.equal(runner.getLive().r.code, 'free'); // driver may restart
  assert.deepEqual(switched, [['t', 'diverging']]);
  assert.deepEqual(stopped, ['V200']); // not stopped again
});

test('starting needs the locomotive in a block of the route; unconnected blocks end the run', async () => {
  const { tracker, runner, stopped } = setup([{ id: 'r', name: 'R', blocks: ['a', 'b'], loop: false }]);
  assert.throws(() => runner.start('r', 'V200'), /not in a block of this route/);
  tracker.set('a', { occupied: true, loco: 'V200' });
  await runner.start('r', 'V200');
  assert.equal(runner.getLive().r.code, 'noConnection');
  assert.deepEqual(stopped, ['V200']);
});

test('the runner stops a locomotive that leaves the route', async () => {
  const { tracker, runner, stopped } = setup([{ id: 'r', name: 'R', blocks: ['b', 'd'], loop: false }]);
  tracker.set('b', { occupied: true, loco: 'V200' });
  await runner.start('r', 'V200');
  tracker.set('b', { occupied: false });
  tracker.set('a', { occupied: true, loco: 'V200' });
  await runner.evaluate();
  assert.equal(runner.getLive().r.code, 'leftRoute');
  assert.deepEqual(stopped, ['V200']);
  assert.equal(runner.stop('r'), true);
  assert.deepEqual(runner.getLive(), {});
});
