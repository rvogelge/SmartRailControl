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
  // links: which track ends are joined inside the element (at rotation 0), see TRACK_ENDS.
  // routes (turnouts): the links each position connects.
  // A train entering at one end may leave at any end it is linked to (all turnout routes).
  const TYPES = {
    straight: { label: 'Straight', links: [['W', 'E']] },
    diagonal: { label: 'Diagonal', links: [['SW', 'NE']] },
    'curve-45-left': { label: 'Curve 45° left', links: [['W', 'NE']] },
    'curve-45-right': { label: 'Curve 45° right', links: [['W', 'SE']] },
    curve: { label: 'Curve 90° R1', links: [['W', 'S']] },
    'curve-r2': {
      label: 'Curve 90° R2 (parallel)',
      footprint: { size: 2, cells: [[0, 0], [1, 0], [1, 1]] },
      links: [['W', 'S2']]
    },
    'turnout-left': {
      label: 'Turnout left',
      links: [['W', 'E'], ['W', 'NE']],
      routes: { straight: [['W', 'E']], diverging: [['W', 'NE']] },
      stateLabels: { straight: 'straight', diverging: 'diverging' },
      states: ['straight', 'diverging'],
      addresses: ['Turnout address'],
      commands: { straight: [[0, 'green']], diverging: [[0, 'red']] }
    },
    'turnout-right': {
      label: 'Turnout right',
      links: [['W', 'E'], ['W', 'SE']],
      routes: { straight: [['W', 'E']], diverging: [['W', 'SE']] },
      stateLabels: { straight: 'straight', diverging: 'diverging' },
      states: ['straight', 'diverging'],
      addresses: ['Turnout address'],
      commands: { straight: [[0, 'green']], diverging: [[0, 'red']] }
    },
    'turnout-3way': {
      label: 'Three-way turnout',
      links: [['W', 'E'], ['W', 'NE'], ['W', 'SE']],
      routes: { straight: [['W', 'E']], left: [['W', 'NE']], right: [['W', 'SE']] },
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
      links: [['W', 'E'], ['SW', 'NE'], ['W', 'NE'], ['SW', 'E']],
      routes: { straight: [['W', 'E'], ['SW', 'NE']], turn: [['W', 'NE'], ['SW', 'E']] },
      stateLabels: { straight: 'straight', turn: 'turning' },
      states: ['straight', 'turn'],
      // Only two states, so both drives are wired to one decoder output.
      addresses: ['Crossover address'],
      commands: { straight: [[0, 'green']], turn: [[0, 'red']] }
    },
    'crossing-45': { label: 'Crossing 45°', links: [['W', 'E'], ['SW', 'NE']] },
    crossing: { label: 'Crossing 90°', links: [['W', 'E'], ['N', 'S']] },
    buffer: { label: 'Buffer stop', links: [['W', null]] },
    signal: {
      label: 'Signal',
      links: [['W', 'E']],
      stateLabels: { stop: 'stop (red)', go: 'go (green)' },
      states: ['stop', 'go'],
      addresses: ['Signal address'],
      commands: { stop: [[0, 'red']], go: [[0, 'green']] }
    },
    contact: {
      label: 'Contact track',
      links: [['W', 'E']],
      addresses: ['Contact no. (feedback)'],
      addressSpace: 'feedback',
      // Input: occupied (on) / free (off). Not saved; reported at run time.
      sensorStates: ['off', 'on'],
      stateLabels: { on: 'on (occupied)', off: 'off (free)' }
    },
    uncoupler: {
      label: 'Uncoupler',
      links: [['W', 'E']],
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

  const commandsFor = (type, state) => (TYPES[type] && TYPES[type].commands && TYPES[type].commands[state]) || null;

  // Actor elements (turnouts, signals, uncouplers) can have each decoder address inverted:
  // green and red are swapped, for a drive that is wired the other way round.
  const canInvert = (type) => Boolean(TYPES[type] && TYPES[type].commands);
  const SWAPPED = { green: 'red', red: 'green' };
  const commandsForTile = (tile, state) => {
    const commands = commandsFor(tile.type, state);
    if (!commands) return null;
    const invert = tile.invert || [];
    return commands.map(([slot, color]) => [slot, invert[slot] ? SWAPPED[color] : color]);
  };

  /* ---------- Track connections and blocks ---------- */

  // Track ends at rotation 0 in half-square units ([x, y] from the top-left corner of the
  // element) with the direction the track leaves in. Edge midpoints and corners.
  const TRACK_ENDS = {
    W: [0, 1, 'W'],
    E: [2, 1, 'E'],
    N: [1, 0, 'N'],
    S: [1, 2, 'S'],
    NE: [2, 0, 'NE'],
    SE: [2, 2, 'SE'],
    SW: [0, 2, 'SW'],
    NW: [0, 0, 'NW'],
    S2: [3, 4, 'S'] // R2 curve: bottom edge of the lower right square of its 2×2 block
  };
  const TURN_CW = { N: 'E', NE: 'SE', E: 'S', SE: 'SW', S: 'W', SW: 'NW', W: 'N', NW: 'NE' };
  const OPPOSITE = { N: 'S', NE: 'SW', E: 'W', SE: 'NW', S: 'N', SW: 'NE', W: 'E', NW: 'SE' };

  // A track end of a placed tile in grid half-units: { x, y, dir, key }.
  const tileEnd = (tile, name) => {
    const size = footprint(tile.type).size * 2;
    let [x, y, dir] = TRACK_ENDS[name];
    const turns = ((tile.rotation || 0) / 90) % 4;
    for (let i = 0; i < turns; i += 1) {
      [x, y] = [size - y, x];
      dir = TURN_CW[dir];
    }
    x += tile.x * 2;
    y += tile.y * 2;
    return { name, x, y, dir, key: `${x},${y},${dir}` };
  };
  const linksOf = (type) => (TYPES[type] && TYPES[type].links) || [];
  // Links a train can use right now: for turnouts only those of their current position.
  const setLinksOf = (tile) => {
    const routes = TYPES[tile.type] && TYPES[tile.type].routes;
    if (!routes) return linksOf(tile.type);
    return routes[tile.state] || routes[TYPES[tile.type].states[0]];
  };

  // Block start: a contact track with `block: 'right' | 'left'` (the arrow in its symbol,
  // at rotation 0). The block covers the contact and the track behind it in arrow
  // direction up to the next block-start contact or turnout (the turnout is not part of
  // any block). Past turnouts the search goes on, to find the blocks a train can reach.
  const BLOCK_DIRECTIONS = ['right', 'left'];
  const isBlockStart = (tile) => tile.type === 'contact' && BLOCK_DIRECTIONS.includes(tile.block);
  // Turnouts end blocks: switchable track with more than one route.
  const isTurnout = (type) => Boolean(TYPES[type] && TYPES[type].states && linksOf(type).length > 1);

  // Every block of the layout: [{ id (= start contact id), start, tiles: [ids in track
  // order], next: [ids of the block-start contacts a train can reach from it, also over
  // turnouts and track outside blocks], nextSet: [the same, but only over the turnout
  // positions currently set] }]. The block itself covers all turnout routes.
  const findBlocks = (tiles) => {
    const ends = new Map(); // "x,y,dir" -> [{ tile, name }]
    tiles.forEach((tile) => {
      new Set(linksOf(tile.type).flat().filter(Boolean)).forEach((name) => {
        const end = tileEnd(tile, name);
        if (!ends.has(end.key)) ends.set(end.key, []);
        ends.get(end.key).push({ tile, name });
      });
    });
    // The ends that meet a given end: same point, facing the other way.
    const meeting = (end) => ends.get(`${end.x},${end.y},${OPPOSITE[end.dir]}`) || [];

    // Block-start contacts reachable from `exit`, over all routes or only the set ones.
    const reachable = (exit, linksFor, onTile = () => {}) => {
      const found = new Set();
      const visited = new Set();
      // [track end left behind, still inside the block?]
      const queue = [[exit, true]];
      while (queue.length) {
        const [end, inBlock] = queue.shift();
        meeting(end).forEach(({ tile, name }) => {
          if (isBlockStart(tile)) {
            found.add(tile.id);
            return;
          }
          if (visited.has(`${tile.id}:${name}`)) return;
          visited.add(`${tile.id}:${name}`);
          const stillIn = inBlock && !isTurnout(tile.type);
          if (stillIn) onTile(tile);
          linksFor(tile).forEach(([a, b]) => {
            const other = a === name ? b : b === name ? a : undefined;
            if (other) queue.push([tileEnd(tile, other), stillIn]);
          });
        });
      }
      return found;
    };

    return tiles.filter(isBlockStart).map((start) => {
      const order = [start.id];
      const exit = tileEnd(start, start.block === 'left' ? 'W' : 'E');
      const next = reachable(exit, (tile) => linksOf(tile.type), (tile) => {
        if (!order.includes(tile.id)) order.push(tile.id);
      });
      const nextSet = reachable(exit, setLinksOf);
      next.delete(start.id);
      nextSet.delete(start.id);
      return { id: start.id, start: start.id, tiles: order, next: [...next], nextSet: [...nextSet] };
    });
  };

  // Where the loco name of a block is shown: the middle straight track, else the middle tile.
  const blockLabelTile = (block, tiles) => {
    const byId = new Map(tiles.map((t) => [t.id, t]));
    const list = block.tiles.map((id) => byId.get(id)).filter(Boolean);
    const straight = list.filter((t) => t.type === 'straight');
    const pick = straight.length ? straight : list;
    return pick[Math.floor((pick.length - 1) / 2)] || null;
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
    commandsFor,
    commandsForTile,
    BLOCK_DIRECTIONS,
    isBlockStart,
    isTurnout,
    findBlocks,
    blockLabelTile,
    tileEnd,
    canInvert,
    findAddressConflicts
  };
});
