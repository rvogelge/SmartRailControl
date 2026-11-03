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
  // footprint: { size, cells } — an element occupies an size×size block; `cells`
  // lists the squares (at rotation 0) its track actually uses. Default: 1×1.
  const TYPES = {
    straight: {},
    diagonal: {},
    'curve-45-left': {},
    'curve-45-right': {},
    curve: {},
    'curve-r2': { footprint: { size: 2, cells: [[0, 0], [1, 0], [1, 1]] } },
    'turnout-left': { states: ['straight', 'diverging'], addresses: ['Turnout address'] },
    'turnout-right': { states: ['straight', 'diverging'], addresses: ['Turnout address'] },
    'turnout-3way': {
      states: ['straight', 'left', 'right'],
      addresses: ['Drive 1 (left)', 'Drive 2 (right)']
    },
    'double-slip': { states: ['straight', 'turn'], addresses: ['Drive 1', 'Drive 2'] },
    'crossing-45': {},
    crossing: {},
    buffer: {},
    signal: { states: ['stop', 'go'], addresses: ['Signal address'] },
    contact: { addresses: ['Contact no. (feedback)'] },
    uncoupler: { addresses: ['Uncoupler address'], momentary: true }
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
    cellsOf
  };
});
