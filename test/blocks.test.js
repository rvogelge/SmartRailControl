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

test('a block runs in its arrow direction over all turnout routes up to the next block start', () => {
  const blocks = TrackCatalog.findBlocks(line());
  const byId = Object.fromEntries(blocks.map((b) => [b.id, b]));
  assert.deepEqual(byId.c1.tiles, ['c1', 's1', 't1', 's2', 'd1']);
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
  const c1 = TrackCatalog.findBlocks(tiles).find((b) => b.id === 'c1');
  assert.deepEqual(c1.tiles, ['c1', 's1', 't1', 's2', 'd1', 'c2', 's3']);
  assert.deepEqual(c1.next, ['c3']);
});

test('the loco name sits on the middle straight track of the block', () => {
  const tiles = line();
  const c1 = TrackCatalog.findBlocks(tiles).find((b) => b.id === 'c1');
  assert.equal(TrackCatalog.blockLabelTile(c1, tiles).id, 's1'); // straights: s1, s2
});

test('a train occupies blocks one after another and takes its loco along', () => {
  let saved = {};
  const tracker = new BlockTracker({ getTiles: line, save: (s) => (saved = s) });
  tracker.set('c1', { occupied: true, loco: 'BR 218' });
  assert.deepEqual(tracker.getLive(), { c1: { loco: 'BR 218' } });

  const result = tracker.contactOn('c2');
  assert.deepEqual(result, { block: 'c2', loco: 'BR 218', freed: ['c1'] });
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
