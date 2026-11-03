// Shared track element rules, used by the browser (window.TrackCatalog) and by the
// server (require). Drawing lives in layout.js; this file only holds the facts both
// sides must agree on: which element types exist, their states, how many decoder
// addresses they need and which grid squares they occupy.
(function (root, factory) {
  const catalog = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = catalog;
  } else {
    root.TrackCatalog = catalog;
  }
})(typeof self !== 'undefined' ? self : this, () => {
  const MAX_ADDRESS = 2048;

  // states: first entry is the default.
  // addresses: one label per decoder address the element needs.
  // commands: per state (or 'trigger' for momentary elements) the outputs to switch,
  // in order, as [address slot, 'green' | 'red']. Green = straight / go, red = diverging / stop.
  // footprint: { size, cells } — an element occupies an size×size block; `cells`
  // lists the squares (at rotation 0) its track actually uses. Default: 1×1.
  const TYPES = {
    straight: {},
    diagonal: {},
    'curve-45-left': {},
    'curve-45-right': {},
    curve: {},
    'curve-r2': { footprint: { size: 2, cells: [[0, 0], [1, 0], [1, 1]] } },
    'turnout-left': {
      states: ['straight', 'diverging'],
      addresses: ['Turnout address'],
      commands: { straight: [[0, 'green']], diverging: [[0, 'red']] }
    },
    'turnout-right': {
      states: ['straight', 'diverging'],
      addresses: ['Turnout address'],
      commands: { straight: [[0, 'green']], diverging: [[0, 'red']] }
    },
    'turnout-3way': {
      states: ['straight', 'left', 'right'],
      addresses: ['Drive 1 (left)', 'Drive 2 (right)'],
      // Only one drive may be diverging: reset the other one first.
      commands: {
        straight: [[0, 'green'], [1, 'green']],
        left: [[1, 'green'], [0, 'red']],
        right: [[0, 'green'], [1, 'red']]
      }
    },
    'double-slip': {
      states: ['straight', 'turn'],
      addresses: ['Drive 1', 'Drive 2'],
      commands: { straight: [[0, 'green'], [1, 'green']], turn: [[0, 'red'], [1, 'red']] }
    },
    'crossing-45': {},
    crossing: {},
    buffer: {},
    signal: {
      states: ['stop', 'go'],
      addresses: ['Signal address'],
      commands: { stop: [[0, 'red']], go: [[0, 'green']] }
    },
    contact: { addresses: ['Contact no. (feedback)'], addressSpace: 'feedback' },
    uncoupler: { addresses: ['Uncoupler address'], momentary: true, commands: { trigger: [[0, 'green']] } }
  };

  // Turnouts, signals and uncouplers share the accessory address range of the command
  // station; feedback contacts are numbered separately.
  const ADDRESS_SPACES = { accessory: 'accessory address', feedback: 'contact no.' };
  const addressSpace = (type) => (TYPES[type] && TYPES[type].addressSpace) || 'accessory';

  // Returns every address that is used more than once within its address space,
  // including two drives of the same element: [{ space, address, uses: [{ id, slot }] }].
  const findAddressConflicts = (tiles) => {
    const uses = new Map();
    tiles.forEach((tile) => {
      (tile.addresses || []).forEach((address, slot) => {
        if (address === null || address === undefined || address === '') return;
        const key = `${addressSpace(tile.type)}:${Number(address)}`;
        if (!uses.has(key)) uses.set(key, []);
        uses.get(key).push({ id: tile.id, slot });
      });
    });
    return [...uses.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([key, list]) => {
        const [space, address] = key.split(':');
        return { space, address: Number(address), uses: list };
      });
  };

  const DEFAULT_FOOTPRINT = { size: 1, cells: [[0, 0]] };
  const ROTATIONS = [0, 90, 180, 270];

  const footprint = (type) => (TYPES[type] && TYPES[type].footprint) || DEFAULT_FOOTPRINT;

  // Squares a tile covers, in grid coordinates. Rotation turns the block about its centre:
  // a 90° clockwise turn maps block cell (cx, cy) to (size − 1 − cy, cx).
  const cellsOf = (tile) => {
    const { size, cells } = footprint(tile.type);
    const turns = ((tile.rotation || 0) / 90) % 4;
    return cells.map(([cx, cy]) => {
      let x = cx;
      let y = cy;
      for (let i = 0; i < turns; i += 1) {
        [x, y] = [size - 1 - y, x];
      }
      return [tile.x + x, tile.y + y];
    });
  };

  return {
    MAX_ADDRESS,
    ROTATIONS,
    TYPES,
    TYPE_NAMES: Object.keys(TYPES),
    statesOf: (type) => (TYPES[type] && TYPES[type].states) || null,
    addressSlots: (type) => (TYPES[type] && TYPES[type].addresses) || [],
    footprint,
    cellsOf,
    ADDRESS_SPACES,
    addressSpace,
    commandsFor: (type, state) => (TYPES[type] && TYPES[type].commands && TYPES[type].commands[state]) || null,
    findAddressConflicts
  };
});
