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
    straight: { label: 'Straight' },
    diagonal: { label: 'Diagonal' },
    'curve-45-left': { label: 'Curve 45° left' },
    'curve-45-right': { label: 'Curve 45° right' },
    curve: { label: 'Curve 90° R1' },
    'curve-r2': { label: 'Curve 90° R2 (parallel)', footprint: { size: 2, cells: [[0, 0], [1, 0], [1, 1]] } },
    'turnout-left': {
      label: 'Turnout left',
      stateLabels: { straight: 'straight', diverging: 'diverging' },
      states: ['straight', 'diverging'],
      addresses: ['Turnout address'],
      commands: { straight: [[0, 'green']], diverging: [[0, 'red']] }
    },
    'turnout-right': {
      label: 'Turnout right',
      stateLabels: { straight: 'straight', diverging: 'diverging' },
      states: ['straight', 'diverging'],
      addresses: ['Turnout address'],
      commands: { straight: [[0, 'green']], diverging: [[0, 'red']] }
    },
    'turnout-3way': {
      label: 'Three-way turnout',
      stateLabels: { straight: 'straight', left: 'left', right: 'right' },
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
      label: 'Crossover switch',
      stateLabels: { straight: 'straight', turn: 'turning' },
      states: ['straight', 'turn'],
      // Only two states, so both drives are wired to one decoder output.
      addresses: ['Crossover address'],
      commands: { straight: [[0, 'green']], turn: [[0, 'red']] }
    },
    'crossing-45': { label: 'Crossing 45°' },
    crossing: { label: 'Crossing 90°' },
    buffer: { label: 'Buffer stop' },
    signal: {
      label: 'Signal',
      stateLabels: { stop: 'stop (red)', go: 'go (green)' },
      states: ['stop', 'go'],
      addresses: ['Signal address'],
      commands: { stop: [[0, 'red']], go: [[0, 'green']] }
    },
    contact: {
      label: 'Contact track',
      addresses: ['Contact no. (feedback)'],
      addressSpace: 'feedback',
      // Input: occupied (on) / free (off). Not saved; reported at run time.
      sensorStates: ['off', 'on'],
      stateLabels: { on: 'on (occupied)', off: 'off (free)' }
    },
    uncoupler: {
      label: 'Uncoupler',
      stateLabels: { trigger: 'trigger' },
      addresses: ['Uncoupler address'],
      momentary: true,
      commands: { trigger: [[0, 'green']] }
    }
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

  const statesOf = (type) => (TYPES[type] && TYPES[type].states) || null;
  const sensorStatesOf = (type) => (TYPES[type] && TYPES[type].sensorStates) || null;
  const isMomentary = (type) => Boolean(TYPES[type] && TYPES[type].momentary);

  // Logic rules: what each element can be used for and which states apply.
  // A sensor can start a rule, a condition can test any element with a state,
  // an action can switch any element that has commands.
  const ruleRoles = (type) => ({
    trigger: Boolean(sensorStatesOf(type)),
    condition: Boolean(sensorStatesOf(type) || statesOf(type)),
    action: Boolean(statesOf(type) || isMomentary(type))
  });
  const conditionStates = (type) => sensorStatesOf(type) || statesOf(type) || [];
  const actionStates = (type) => statesOf(type) || (isMomentary(type) ? ['trigger'] : []);
  const labelOf = (type) => (TYPES[type] && TYPES[type].label) || type;
  const stateLabel = (type, state) =>
    (TYPES[type] && TYPES[type].stateLabels && TYPES[type].stateLabels[state]) || state;

  return {
    MAX_ADDRESS,
    ROTATIONS,
    TYPES,
    TYPE_NAMES: Object.keys(TYPES),
    statesOf,
    sensorStatesOf,
    isMomentary,
    ruleRoles,
    conditionStates,
    actionStates,
    labelOf,
    stateLabel,
    addressSlots: (type) => (TYPES[type] && TYPES[type].addresses) || [],
    footprint,
    cellsOf,
    ADDRESS_SPACES,
    addressSpace,
    commandsFor: (type, state) => (TYPES[type] && TYPES[type].commands && TYPES[type].commands[state]) || null,
    findAddressConflicts
  };
});
