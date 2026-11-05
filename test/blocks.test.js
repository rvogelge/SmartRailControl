const test = require('node:test');
const assert = require('node:assert/strict');
const TrackCatalog = require('../public/trackCatalog');
const BlockTracker = require('../blockTracker');

// A loop-free line, left to right:
// c1(block →) s1 t1(turnout right) s2 c2(block →) s3 c3(block ←) s4
//                 └ d1 (diagonal down-right from the turnout's SE corner)
const line = () => [
  { id: 'c1', type: 'contact', x: 0, y: 0, rotation: 0, block: 'right' },
  { id: 's1', type: 'straight', x: 1, y: 0, rotation: 0 },
  { id: 't1', type: 'turnout-right', x: 2, y: 0, rotation: 0 },
  { id: 's2', type: 'straight', x: 3, y: 0, rotation: 0 },
  { id: 'c2', type: 'contact', x: 4, y: 0, rotation: 0, block: 'right' },
  { id: 'd1', type: 'diagonal', x: 3, y: 1, rotation: 90 },
  { id: 's3', type: 'straight', x: 5, y: 0, rotation: 0 },
  { id: 'c3', type: 'contact', x: 6, y: 0, rotation: 0, block: 'left' },
  { id: 's4', type: 'straight', x: 7, y: 0, rotation: 0 }
];

test('track ends follow the rotation of the element', () => {
  assert.deepEqual(TrackCatalog.tileEnd({ type: 'straight', x: 1, y: 2, rotation: 0 }, 'E'), { name: 'E', x: 4, y: 5, dir: 'E', key: '4,5,E' });
  assert.equal(TrackCatalog.tileEnd({ type: 'straight', x: 0, y: 0, rotation: 90 }, 'W').dir, 'N');
  assert.equal(TrackCatalog.tileEnd({ type: 'diagonal', x: 3, y: 1, rotation: 90 }, 'SW').dir, 'NW');
  assert.deepEqual(TrackCatalog.tileEnd({ type: 'curve-r2', x: 0, y: 0, rotation: 0 }, 'S2'), { name: 'S2', x: 3, y: 4, dir: 'S', key: '3,4,S' });
});

test('a block runs in its arrow direction up to the next block start or turnout', () => {
  const blocks = TrackCatalog.findBlocks(line());
  const byId = Object.fromEntries(blocks.map((b) => [b.id, b]));
  // Ends before turnout t1; s2 and d1 behind it belong to no block.
  assert.deepEqual(byId.c1.tiles, ['c1', 's1']);
  // A train can still reach c2 over the turnout.
  assert.deepEqual(byId.c1.next, ['c2']);
  // c2 → stops at c3 (a block start, whatever its direction)
  assert.deepEqual(byId.c2.tiles, ['c2', 's3']);
  assert.deepEqual(byId.c2.next, ['c3']);
  // c3 points left: back over s3 to c2
  assert.deepEqual(byId.c3.tiles, ['c3', 's3']);
  assert.deepEqual(byId.c3.next, ['c2']);
});

test('contacts that are not block starts are part of the block', () => {
  const tiles = line();
  tiles[4].block = undefined; // c2 is a plain contact now
  const c3 = TrackCatalog.findBlocks(tiles).find((b) => b.id === 'c3');
  assert.deepEqual(c3.tiles, ['c3', 's3', 'c2', 's2']); // stops at turnout t1
  assert.deepEqual(TrackCatalog.findBlocks(tiles).find((b) => b.id === 'c1').next, ['c3']);
});

test('turnouts end blocks over every route, crossings do not', () => {
  assert.equal(TrackCatalog.isTurnout('turnout-left'), true);
  assert.equal(TrackCatalog.isTurnout('turnout-3way'), true);
  assert.equal(TrackCatalog.isTurnout('double-slip'), true);
  assert.equal(TrackCatalog.isTurnout('crossing'), false);
  assert.equal(TrackCatalog.isTurnout('signal'), false);
  // Block c2 pointing left runs back to the turnout's straight end, not into it.
  const tiles = line();
  tiles[4].block = 'left';
  assert.deepEqual(TrackCatalog.findBlocks(tiles).find((b) => b.id === 'c2').tiles, ['c2', 's2']);
});

test('the loco name sits on the middle straight track of the block', () => {
  const tiles = line();
  const c1 = TrackCatalog.findBlocks(tiles).find((b) => b.id === 'c1');
  assert.equal(TrackCatalog.blockLabelTile(c1, tiles).id, 's1');
});

test('a train occupies blocks one after another and takes its loco along', () => {
  let saved = {};
  const tracker = new BlockTracker({ getTiles: line, save: (s) => (saved = s) });
  tracker.set('c1', { occupied: true, loco: 'BR 218' });
  assert.deepEqual(tracker.getLive(), { c1: { loco: 'BR 218' } });

  const result = tracker.contactOn('c2');
  assert.deepEqual(result, { block: 'c2', loco: 'BR 218', freed: ['c1'], ambiguous: [] });
  assert.deepEqual(tracker.getLive(), { c2: { loco: 'BR 218' } });
  assert.equal(saved.c2.loco, 'BR 218');

  // Repeated pulses of the same contact change nothing.
  tracker.contactOn('c2');
  assert.deepEqual(tracker.getLive(), { c2: { loco: 'BR 218' } });

  // A contact that does not start a block is ignored.
  assert.equal(tracker.contactOn('s3'), null);
});

test('an unknown train occupies its block without a name; blocks can be freed by hand', () => {
  const tracker = new BlockTracker({ getTiles: line });
  tracker.contactOn('c1');
  assert.deepEqual(tracker.getLive(), { c1: { loco: null } });
  tracker.set('c1', { occupied: true, loco: '  ICE  ' });
  assert.deepEqual(tracker.getLive(), { c1: { loco: 'ICE' } });
  tracker.set('c1', { occupied: false });
  assert.deepEqual(tracker.getLive(), {});
  assert.throws(() => tracker.set('s1', { occupied: true }), /Unknown block/);
});

test('saved occupancy of blocks that no longer exist is dropped', () => {
  const tracker = new BlockTracker({ getTiles: line, load: () => ({ c2: { loco: 'V 100' }, gone: { loco: 'x' } }) });
  assert.deepEqual(tracker.getLive(), { c2: { loco: 'V 100' } });
});

// Two blocks merge over turnout t into block d (all pointing left):
//   d(←) s0 ← t ← s3 ← a(←)          straight route: a
//               ↖ dg ← cu ← b(←)     diverging route: b
const merge = (turnout = 'straight') => [
  { id: 's0', type: 'straight', x: 0, y: 0, rotation: 0 },
  { id: 'd', type: 'contact', x: 1, y: 0, rotation: 0, block: 'left' },
  { id: 't', type: 'turnout-right', x: 2, y: 0, rotation: 0, state: turnout },
  { id: 's3', type: 'straight', x: 3, y: 0, rotation: 0 },
  { id: 'a', type: 'contact', x: 4, y: 0, rotation: 0, block: 'left' },
  { id: 'dg', type: 'diagonal', x: 3, y: 1, rotation: 90 },
  { id: 'cu', type: 'curve-45-right', x: 4, y: 2, rotation: 180 },
  { id: 'b', type: 'contact', x: 5, y: 2, rotation: 0, block: 'left' }
];

test('merging blocks: only the route set by the turnout leads on', () => {
  const byId = (tiles) => Object.fromEntries(TrackCatalog.findBlocks(tiles).map((x) => [x.id, x]));
  const straight = byId(merge('straight'));
  assert.deepEqual(straight.a.next, ['d']);
  assert.deepEqual(straight.b.next, ['d']);
  assert.deepEqual(straight.a.nextSet, ['d']);
  assert.deepEqual(straight.b.nextSet, []);
  const diverging = byId(merge('diverging'));
  assert.deepEqual(diverging.a.nextSet, []);
  assert.deepEqual(diverging.b.nextSet, ['d']);
});

test('merging blocks: only the block the train came from is freed', () => {
  let turnout = 'straight';
  const tracker = new BlockTracker({ getTiles: () => merge(turnout) });
  tracker.set('a', { occupied: true, loco: 'BR 218' });
  tracker.set('b', { occupied: true, loco: 'V 100' });

  turnout = 'diverging'; // the train from b enters d
  assert.deepEqual(tracker.contactOn('d'), { block: 'd', loco: 'V 100', freed: ['b'], ambiguous: [] });
  assert.deepEqual(tracker.getLive(), { a: { loco: 'BR 218' }, d: { loco: 'V 100' } });
});

test('a locomotive can be in one block only', () => {
  const tracker = new BlockTracker({ getTiles: line });
  tracker.set('c1', { occupied: true, loco: 'BR 218' });
  assert.throws(
    () => tracker.set('c2', { occupied: true, loco: 'BR 218' }),
    (error) => error.code === 'locoInBlock' && error.block === 'c1' && error.loco === 'BR 218'
  );
  tracker.set('c1', { occupied: true, loco: 'BR 218' }); // same block again: fine
  tracker.set('c2', { occupied: true, loco: null }); // unknown trains: any number
  tracker.set('c3', { occupied: true, loco: null });
  tracker.set('c1', { occupied: false });
  tracker.set('c2', { occupied: true, loco: 'BR 218' }); // after freeing c1
  assert.deepEqual(tracker.getLive(), { c2: { loco: 'BR 218' }, c3: { loco: null } });
});
