/* global TrackCatalog */
const SVG_NS = 'http://www.w3.org/2000/svg';
const CELL = 100; // SVG units per grid square
const CELL_PX = 56; // on-screen size of one square
const { cellsOf, footprint, statesOf, addressSlots, MAX_ADDRESS } = TrackCatalog;

// Each element is drawn in a 100×100 square (or size×100 for larger elements).
// Connection points are the edge midpoints — west (0,50), east (100,50),
// north (50,0), south (50,100) — and the corners for 45° diagonal track:
// NW (0,0), NE (100,0), SE (100,100), SW (0,100).
//
// Switchable elements define `routes` (one set of paths per state, first state is
// the default). In each state the active route is drawn bright and the others dimmed.
// Which squares an element occupies, its states and decoder addresses are defined in
// trackCatalog.js (shared with the server).

// 45° curve: leaves an edge midpoint horizontally and arrives at a corner at 45°.
// Arc radius 50 / (√2 − 1) ≈ 120.71 ends at (85.36, 85.36), then a short diagonal.
const CURVE45_W_SE = 'M0 50 A120.71 120.71 0 0 1 85.36 85.36 L100 100'; // west → south-east corner
const CURVE45_W_NE = 'M0 50 A120.71 120.71 0 0 0 85.36 14.64 L100 0'; // west → north-east corner
const CURVE45_SW_E = 'M0 100 L14.64 85.36 A120.71 120.71 0 0 1 100 50'; // south-west corner → east
const ARC90_R1 = 'M0 50 A50 50 0 0 1 50 100'; // west → south, radius 50, centre at SW corner
// R2: radius 150 around the same centre as an R1 curve placed in the block's free
// SW square, so R1 and R2 run exactly one track apart (2×2 block).
const ARC90_R2 = 'M0 50 A150 150 0 0 1 150 200';
const STRAIGHT_WE = 'M0 50 H100';
const STRAIGHT_NS = 'M50 0 V100';
const DIAGONAL_SW_NE = 'M0 100 L100 0';

const ELEMENTS = {
  straight: { label: 'Straight', paths: [STRAIGHT_WE] },
  diagonal: { label: 'Diagonal', paths: [DIAGONAL_SW_NE] },
  'curve-45-left': { label: 'Curve 45° left', paths: [CURVE45_W_NE] },
  'curve-45-right': { label: 'Curve 45° right', paths: [CURVE45_W_SE] },
  curve: { label: 'Curve 90° R1', paths: [ARC90_R1] },
  'curve-r2': { label: 'Curve 90° R2 (parallel)', paths: [ARC90_R2] },
  'turnout-left': {
    label: 'Turnout left',
    routes: { straight: [STRAIGHT_WE], diverging: [CURVE45_W_NE] },
    stateLabels: { straight: 'straight', diverging: 'diverging' },
    switchPoint: true
  },
  'turnout-right': {
    label: 'Turnout right',
    routes: { straight: [STRAIGHT_WE], diverging: [CURVE45_W_SE] },
    stateLabels: { straight: 'straight', diverging: 'diverging' },
    switchPoint: true
  },
  'turnout-3way': {
    label: 'Three-way turnout',
    routes: { straight: [STRAIGHT_WE], left: [CURVE45_W_NE], right: [CURVE45_W_SE] },
    stateLabels: { straight: 'straight', left: 'left', right: 'right' },
    switchPoint: true
  },
  'double-slip': {
    label: 'Crossover switch',
    // Straight W–E crossing the SW–NE diagonal; the slip routes curve W→NE and SW→E.
    routes: { straight: [STRAIGHT_WE, DIAGONAL_SW_NE], turn: [CURVE45_W_NE, CURVE45_SW_E] },
    stateLabels: { straight: 'straight', turn: 'turning' },
    switchPoint: true
  },
  'crossing-45': { label: 'Crossing 45°', paths: [STRAIGHT_WE, DIAGONAL_SW_NE] },
  crossing: { label: 'Crossing 90°', paths: [STRAIGHT_WE, STRAIGHT_NS] },
  buffer: { label: 'Buffer stop', paths: ['M0 50 H62'], extra: 'buffer' },
  signal: {
    label: 'Signal',
    paths: [STRAIGHT_WE],
    stateLabels: { stop: 'stop (red)', go: 'go (green)' },
    extra: 'signal'
  },
  contact: { label: 'Contact track', paths: [STRAIGHT_WE], extra: 'contact' },
  uncoupler: { label: 'Uncoupler', paths: [STRAIGHT_WE], extra: 'uncoupler' }
};

const isSwitchable = (type) => Boolean(statesOf(type));
const isMomentary = (type) => Boolean(TrackCatalog.TYPES[type] && TrackCatalog.TYPES[type].momentary);
const isClickableInRun = (type) => isSwitchable(type) || isMomentary(type) || type === 'contact';
const defaultState = (type) => (statesOf(type) ? statesOf(type)[0] : undefined);

const TOOLS = [
  { id: 'select', label: 'Select / move' },
  ...Object.entries(ELEMENTS).map(([id, el]) => ({ id, label: el.label })),
  { id: 'eraser', label: 'Eraser' }
];

const $ = (id) => document.getElementById(id);
const ui = {
  palette: $('palette'),
  board: $('board'),
  gridRect: $('gridRect'),
  tiles: $('tilesLayer'),
  overlay: $('overlayLayer'),
  rotate: $('rotateButton'),
  remove: $('deleteButton'),
  clear: $('clearButton'),
  cols: $('colsInput'),
  rows: $('rowsInput'),
  status: $('statusLine'),
  saveState: $('saveState'),
  props: $('propsBar'),
  propsTitle: $('propsTitle'),
  propsFields: $('propsFields'),
  modeButtons: document.querySelectorAll('[data-mode]')
};

const state = {
  mode: 'edit', // 'edit' | 'run'
  cols: 20,
  rows: 12,
  tiles: [],
  tool: 'select',
  placeRotation: 0,
  selectedId: null,
  hoverCell: null,
  drag: null, // { id, offset: {dx, dy}, anchor: {x, y}, moved }
  flashing: new Set(), // momentary elements briefly highlighted in run mode
  propsFor: null // id of the tile the properties bar was built for
};

const newId = () => `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const setStatus = (text, kind = '') => {
  ui.status.textContent = text;
  ui.status.classList.toggle('error', kind === 'error');
  ui.status.classList.toggle('ok', kind === 'ok');
};

/* ---------- Persistence ---------- */

let saveTimer = null;
const scheduleSave = () => {
  ui.saveState.textContent = 'Saving…';
  ui.saveState.classList.remove('error');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const response = await fetch('/api/layout', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols: state.cols, rows: state.rows, tiles: state.tiles })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Save failed.');
      ui.saveState.textContent = 'Saved';
    } catch (error) {
      ui.saveState.textContent = 'Not saved';
      ui.saveState.classList.add('error');
      setStatus(`Could not save layout: ${error.message}`, 'error');
    }
  }, 400);
};

/* ---------- Geometry helpers ---------- */

const svg = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
  return node;
};

const sameCell = ([ax, ay], [bx, by]) => ax === bx && ay === by;
const tileAt = (x, y) => state.tiles.find((t) => cellsOf(t).some((c) => sameCell(c, [x, y])));
const selected = () => state.tiles.find((t) => t.id === state.selectedId);
const inBounds = ([x, y]) => x >= 0 && y >= 0 && x < state.cols && y < state.rows;

// Checks whether an element of `type` fits at anchor (x, y) with `rotation`.
const checkFit = (type, x, y, rotation, ignoreId = null) => {
  const cells = cellsOf({ type, x, y, rotation });
  const outside = cells.some((c) => !inBounds(c));
  const overlapping = state.tiles.filter(
    (t) => t.id !== ignoreId && cellsOf(t).some((tc) => cells.some((c) => sameCell(c, tc)))
  );
  return { cells, outside, overlapping };
};

const cellFromEvent = (event) => {
  const point = ui.board.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  const local = point.matrixTransform(ui.board.getScreenCTM().inverse());
  const cell = { x: Math.floor(local.x / CELL), y: Math.floor(local.y / CELL) };
  return inBounds([cell.x, cell.y]) ? cell : null;
};

const addressText = (tile) => {
  const slots = addressSlots(tile.type);
  if (slots.length === 0) return null;
  const values = slots.map((_s, i) => (tile.addresses && tile.addresses[i]) || null);
  return { text: values.map((v) => (v === null ? '?' : v)).join('/'), missing: values.some((v) => v === null) };
};

const describe = (tile) => {
  const addr = addressText(tile);
  const label = ELEMENTS[tile.type].label;
  if (!addr) return label;
  return /^[?/]+$/.test(addr.text) ? `${label} (no address)` : `${label} #${addr.text}`;
};

/* ---------- Drawing ---------- */

const drawElement = (type, { rotation = 0, state: current = defaultState(type), className = '', active = false } = {}) => {
  const def = ELEMENTS[type];
  const half = (footprint(type).size * CELL) / 2;
  const group = svg('g', { class: `track ${className}${active ? ' active' : ''}`.trim() });
  const inner = svg('g', { transform: `rotate(${rotation} ${half} ${half})` });

  if (def.routes) {
    Object.values(def.routes)
      .flat()
      .forEach((d) => inner.append(svg('path', { d, class: 'ballast' })));
    // Inactive routes first so the active route is drawn on top.
    Object.entries(def.routes)
      .sort(([a], [b]) => (a === current) - (b === current))
      .forEach(([name, paths]) => {
        paths.forEach((d) => inner.append(svg('path', { d, class: name === current ? 'rail' : 'rail inactive' })));
      });
  } else {
    def.paths.forEach((d) => inner.append(svg('path', { d, class: 'ballast' })));
    def.paths.forEach((d) => inner.append(svg('path', { d, class: 'rail' })));
  }

  if (def.switchPoint) inner.append(svg('circle', { cx: 6, cy: 50, r: 7, class: 'switch-point' }));

  if (def.extra === 'buffer') {
    inner.append(svg('rect', { x: 60, y: 26, width: 14, height: 48, rx: 3, class: 'bumper' }));
  } else if (def.extra === 'signal') {
    // Mast beside the track, lamp facing along the direction of travel (west → east).
    inner.append(svg('path', { d: 'M28 40 V18 H50', class: 'signal-mast' }));
    inner.append(svg('circle', { cx: 64, cy: 18, r: 13, class: `signal-lamp ${current}` }));
  } else if (def.extra === 'contact') {
    inner.append(svg('rect', { x: 32, y: 36, width: 36, height: 28, rx: 6, class: 'contact-mark' }));
  } else if (def.extra === 'uncoupler') {
    inner.append(svg('path', { d: 'M40 30 V70 M60 30 V70', class: 'uncoupler-mark' }));
  }

  group.append(inner);
  return group;
};

/* ---------- Rendering ---------- */

const renderBoard = () => {
  const width = state.cols * CELL;
  const height = state.rows * CELL;
  ui.board.setAttribute('viewBox', `0 0 ${width} ${height}`);
  ui.board.setAttribute('width', state.cols * CELL_PX);
  ui.board.setAttribute('height', state.rows * CELL_PX);
  ui.gridRect.setAttribute('width', width);
  ui.gridRect.setAttribute('height', height);
  if (document.activeElement !== ui.cols) ui.cols.value = state.cols;
  if (document.activeElement !== ui.rows) ui.rows.value = state.rows;
};

const cellRects = (tile, className) =>
  cellsOf(tile).map(([cx, cy]) =>
    svg('rect', { x: (cx - tile.x) * CELL, y: (cy - tile.y) * CELL, width: CELL, height: CELL, class: className })
  );

const renderTiles = () => {
  ui.tiles.replaceChildren(
    ...state.tiles.map((tile) => {
      const isDragging = state.drag && state.drag.moved && state.drag.id === tile.id;
      const classes = ['tile'];
      if (tile.id === state.selectedId) classes.push('selected');
      if (isDragging) classes.push('dragging');
      if (state.mode === 'run' && isClickableInRun(tile.type)) classes.push('switchable');

      const g = svg('g', {
        transform: `translate(${tile.x * CELL} ${tile.y * CELL})`,
        'data-id': tile.id,
        class: classes.join(' ')
      });
      g.append(...cellRects(tile, 'tile-bg'));
      g.append(drawElement(tile.type, { rotation: tile.rotation, state: tile.state, active: state.flashing.has(tile.id) }));

      // Address badge (not rotated). In run mode only set addresses are shown.
      const addr = addressText(tile);
      if (addr && (state.mode === 'edit' || !/^[?/]+$/.test(addr.text))) {
        const [cx, cy] = cellsOf(tile)[0];
        const bx = (cx - tile.x) * CELL + 4;
        const by = (cy - tile.y) * CELL + 4;
        const width = 12 + addr.text.length * 12;
        const badge = svg('g', { class: `addr-badge${addr.missing ? ' missing' : ''}` });
        badge.append(svg('rect', { x: bx, y: by, width, height: 26, rx: 7 }));
        const text = svg('text', { x: bx + width / 2, y: by + 19, 'text-anchor': 'middle' });
        text.textContent = addr.text;
        badge.append(text);
        g.append(badge);
      }
      return g;
    })
  );
};

const renderOverlay = () => {
  ui.overlay.replaceChildren();

  if (state.mode === 'run') {
    const cell = state.hoverCell;
    const tile = cell && tileAt(cell.x, cell.y);
    if (tile && isClickableInRun(tile.type)) {
      const g = svg('g', { transform: `translate(${tile.x * CELL} ${tile.y * CELL})` });
      g.append(...cellRects(tile, 'hover-cell run'));
      ui.overlay.append(g);
    }
    return;
  }

  let ghost = null; // { type, x, y, rotation, state }
  let blocked = false;

  if (state.drag && state.drag.moved) {
    const tile = state.tiles.find((t) => t.id === state.drag.id);
    ghost = { ...tile, ...state.drag.anchor };
    const fit = checkFit(tile.type, ghost.x, ghost.y, tile.rotation, tile.id);
    blocked = fit.outside || fit.overlapping.length > 0;
  } else if (state.hoverCell && ELEMENTS[state.tool]) {
    ghost = { type: state.tool, x: state.hoverCell.x, y: state.hoverCell.y, rotation: state.placeRotation };
    blocked = checkFit(ghost.type, ghost.x, ghost.y, ghost.rotation).outside;
  } else if (state.hoverCell) {
    const g = svg('g', { transform: `translate(${state.hoverCell.x * CELL} ${state.hoverCell.y * CELL})` });
    const hovered = tileAt(state.hoverCell.x, state.hoverCell.y);
    const toolClass = state.tool === 'eraser' ? ' erase' : '';
    if (hovered) {
      const tg = svg('g', { transform: `translate(${hovered.x * CELL} ${hovered.y * CELL})` });
      tg.append(...cellRects(hovered, `hover-cell${toolClass}`));
      ui.overlay.append(tg);
    } else {
      g.append(svg('rect', { width: CELL, height: CELL, class: `hover-cell${toolClass}` }));
      ui.overlay.append(g);
    }
    return;
  }

  if (!ghost) return;
  const g = svg('g', { transform: `translate(${ghost.x * CELL} ${ghost.y * CELL})` });
  cellsOf(ghost).forEach(([cx, cy]) => {
    const outside = !inBounds([cx, cy]);
    g.append(
      svg('rect', {
        x: (cx - ghost.x) * CELL,
        y: (cy - ghost.y) * CELL,
        width: CELL,
        height: CELL,
        class: `hover-cell${blocked || outside ? ' blocked' : ''}`
      })
    );
  });
  g.append(drawElement(ghost.type, { rotation: ghost.rotation, state: ghost.state, className: 'ghost-track' }));
  ui.overlay.append(g);
};

const renderPalette = () => {
  ui.palette.replaceChildren(
    ...TOOLS.map((tool) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'palette-item';
      button.dataset.tool = tool.id;
      button.title = tool.label;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(state.tool === tool.id));

      const size = ELEMENTS[tool.id] ? footprint(tool.id).size * CELL : 100;
      const preview = svg('svg', { viewBox: `0 0 ${size} ${size}`, class: 'palette-preview', 'aria-hidden': 'true' });
      preview.append(svg('rect', { width: size, height: size, rx: 10 * (size / 100), class: 'preview-bg' }));
      if (ELEMENTS[tool.id]) {
        preview.append(drawElement(tool.id, { rotation: state.tool === tool.id ? state.placeRotation : 0 }));
      } else if (tool.id === 'select') {
        preview.append(svg('path', { d: 'M34 24 L34 74 L46 62 L55 80 L63 76 L54 58 L70 58 Z', class: 'preview-icon' }));
      } else {
        preview.append(svg('path', { d: 'M30 70 L60 30 L78 44 L54 76 Z M30 70 L54 76 M24 80 H78', class: 'preview-icon outline' }));
      }

      const label = document.createElement('span');
      label.textContent = tool.label;

      button.append(preview, label);
      li.append(button);
      return li;
    })
  );
};

const renderMode = () => {
  document.body.dataset.mode = state.mode;
  ui.board.dataset.mode = state.mode;
  ui.modeButtons.forEach((button) => {
    button.setAttribute('aria-checked', String(button.dataset.mode === state.mode));
  });
};

const renderToolbar = () => {
  const hasSelection = Boolean(selected());
  ui.rotate.disabled = !(hasSelection || ELEMENTS[state.tool]);
  ui.remove.disabled = !hasSelection;
};

// Properties bar: rebuilt only when the selection changes, so typing is not interrupted.
const renderProps = () => {
  const tile = state.mode === 'edit' ? selected() : null;
  if (!tile) {
    ui.props.hidden = true;
    state.propsFor = null;
    return;
  }
  ui.props.hidden = false;
  if (state.propsFor === tile.id) return;
  state.propsFor = tile.id;

  ui.propsTitle.textContent = `${ELEMENTS[tile.type].label} · column ${tile.x + 1}, row ${tile.y + 1}`;
  const slots = addressSlots(tile.type);
  if (slots.length === 0) {
    const note = document.createElement('span');
    note.className = 'props-note';
    note.textContent = 'No decoder address needed.';
    ui.propsFields.replaceChildren(note);
    return;
  }

  ui.propsFields.replaceChildren(
    ...slots.map((labelText, i) => {
      const label = document.createElement('label');
      label.className = 'props-field';
      const span = document.createElement('span');
      span.textContent = labelText;
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '1';
      input.max = String(MAX_ADDRESS);
      input.inputMode = 'numeric';
      input.placeholder = '–';
      input.value = (tile.addresses && tile.addresses[i]) || '';
      input.dataset.slot = String(i);
      input.addEventListener('change', () => setAddress(tile.id, i, input));
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') input.blur();
      });
      label.append(span, input);
      return label;
    })
  );
};

const render = () => {
  renderMode();
  renderBoard();
  renderTiles();
  renderOverlay();
  renderPalette();
  renderToolbar();
  renderProps();
};

/* ---------- Actions ---------- */

const setAddress = (tileId, slot, input) => {
  const tile = state.tiles.find((t) => t.id === tileId);
  if (!tile) return;
  const raw = input.value.trim();
  const value = raw === '' ? null : Number(raw);
  if (value !== null && !(Number.isInteger(value) && value >= 1 && value <= MAX_ADDRESS)) {
    setStatus(`Decoder address must be between 1 and ${MAX_ADDRESS}.`, 'error');
    input.value = (tile.addresses && tile.addresses[slot]) || '';
    return;
  }
  const slots = addressSlots(tile.type);
  tile.addresses = slots.map((_s, i) => (i === slot ? value : (tile.addresses && tile.addresses[i]) || null));
  scheduleSave();
  renderTiles();
  setStatus(value === null ? `${ELEMENTS[tile.type].label}: address cleared.` : `${describe(tile)} saved.`, 'ok');
};

const setTool = (tool) => {
  state.tool = tool;
  if (tool !== 'select') state.selectedId = null;
  ui.board.dataset.tool = tool;
  render();
  if (ELEMENTS[tool]) setStatus(`${ELEMENTS[tool].label}: click a square to place it. Press R to rotate.`);
  else if (tool === 'eraser') setStatus('Eraser: click an element to remove it.');
  else setStatus('Select: click an element to select it and set its address, drag to move it.');
};

const MODE_KEY = 'birdrail.layoutMode';

const setMode = (mode) => {
  state.mode = mode === 'run' ? 'run' : 'edit';
  state.selectedId = null;
  state.drag = null;
  try {
    localStorage.setItem(MODE_KEY, state.mode);
  } catch (_error) {
    // Storage unavailable: mode simply is not remembered.
  }
  render();
  if (state.mode === 'run') {
    setStatus('Run mode: click a turnout, crossover switch, signal or uncoupler to operate it.');
  } else {
    setTool(state.tool);
  }
};

const operate = (tile) => {
  if (isSwitchable(tile.type)) {
    const states = statesOf(tile.type);
    tile.state = states[(states.indexOf(tile.state) + 1) % states.length];
    scheduleSave();
    render();
    setStatus(`${describe(tile)}: ${ELEMENTS[tile.type].stateLabels[tile.state]}.`, 'ok');
  } else if (isMomentary(tile.type)) {
    state.flashing.add(tile.id);
    render();
    setTimeout(() => {
      state.flashing.delete(tile.id);
      render();
    }, 700);
    setStatus(`${describe(tile)}: triggered.`, 'ok');
  } else if (tile.type === 'contact') {
    setStatus(`${describe(tile)}.`);
  }
};

const placeTile = (cell) => {
  const fit = checkFit(state.tool, cell.x, cell.y, state.placeRotation);
  if (fit.outside) {
    setStatus(`${ELEMENTS[state.tool].label} does not fit here — it needs more room inside the grid.`, 'error');
    return;
  }
  const replaced = new Set(fit.overlapping.map((t) => t.id));
  state.tiles = state.tiles.filter((t) => !replaced.has(t.id));
  const tile = { id: newId(), type: state.tool, x: cell.x, y: cell.y, rotation: state.placeRotation };
  if (isSwitchable(state.tool)) tile.state = defaultState(state.tool);
  const slots = addressSlots(state.tool);
  if (slots.length > 0) tile.addresses = slots.map(() => null);
  state.tiles.push(tile);
  scheduleSave();
};

const removeTile = (tile) => {
  if (!tile) return;
  state.tiles = state.tiles.filter((t) => t.id !== tile.id);
  if (state.selectedId === tile.id) state.selectedId = null;
  scheduleSave();
  setStatus(`Removed ${ELEMENTS[tile.type].label.toLowerCase()}.`);
};

const rotate = () => {
  const tile = selected();
  if (tile) {
    const next = (tile.rotation + 90) % 360;
    const fit = checkFit(tile.type, tile.x, tile.y, next, tile.id);
    if (fit.outside || fit.overlapping.length > 0) {
      setStatus('Cannot rotate: another element or the grid edge is in the way.', 'error');
      return;
    }
    tile.rotation = next;
    scheduleSave();
  } else if (ELEMENTS[state.tool]) {
    state.placeRotation = (state.placeRotation + 90) % 360;
  }
  render();
};

/* ---------- Pointer interaction ---------- */

ui.board.addEventListener('pointermove', (event) => {
  const cell = cellFromEvent(event);
  if (state.drag) {
    if (cell) {
      const anchor = { x: cell.x - state.drag.offset.dx, y: cell.y - state.drag.offset.dy };
      if (anchor.x !== state.drag.start.x || anchor.y !== state.drag.start.y) state.drag.moved = true;
      state.drag.anchor = anchor;
    }
    renderTiles();
  } else {
    state.hoverCell = cell;
  }
  renderOverlay();
});

ui.board.addEventListener('pointerleave', () => {
  if (state.drag) return;
  state.hoverCell = null;
  renderOverlay();
});

ui.board.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  const cell = cellFromEvent(event);
  if (!cell) return;
  const tile = tileAt(cell.x, cell.y);

  if (state.mode === 'run') {
    if (tile && isClickableInRun(tile.type)) operate(tile);
    return;
  }

  if (ELEMENTS[state.tool]) {
    placeTile(cell);
  } else if (state.tool === 'eraser') {
    removeTile(tile);
  } else {
    state.selectedId = tile ? tile.id : null;
    if (tile) {
      state.drag = {
        id: tile.id,
        offset: { dx: cell.x - tile.x, dy: cell.y - tile.y },
        start: { x: tile.x, y: tile.y },
        anchor: { x: tile.x, y: tile.y },
        moved: false
      };
      ui.board.setPointerCapture(event.pointerId);
      const hint = addressSlots(tile.type).length > 0 ? ' Set its address above the grid.' : '';
      setStatus(`${describe(tile)} selected. Drag to move, R to rotate, Del to remove.${hint}`);
    }
  }
  render();
});

const endDrag = (event, cancelled = false) => {
  if (!state.drag) return;
  const { id, anchor, moved } = state.drag;
  state.drag = null;
  if (ui.board.hasPointerCapture(event.pointerId)) ui.board.releasePointerCapture(event.pointerId);

  if (moved && !cancelled) {
    const tile = state.tiles.find((t) => t.id === id);
    const fit = checkFit(tile.type, anchor.x, anchor.y, tile.rotation, id);
    if (fit.outside) {
      setStatus('The element does not fit there.', 'error');
    } else if (fit.overlapping.length > 0) {
      setStatus('That square is already occupied.', 'error');
    } else if (tile.x !== anchor.x || tile.y !== anchor.y) {
      tile.x = anchor.x;
      tile.y = anchor.y;
      state.propsFor = null; // refresh position in the properties bar
      scheduleSave();
      setStatus(`Moved to column ${anchor.x + 1}, row ${anchor.y + 1}.`);
    }
  }
  state.hoverCell = cellFromEvent(event);
  render();
};

ui.board.addEventListener('pointerup', (event) => endDrag(event));
ui.board.addEventListener('pointercancel', (event) => endDrag(event, true));

// Double-click an element in edit mode to jump to its address field.
ui.board.addEventListener('dblclick', () => {
  if (state.mode !== 'edit') return;
  const input = ui.propsFields.querySelector('input');
  if (input) {
    input.focus();
    input.select();
  }
});

/* ---------- Palette, toolbar, keyboard ---------- */

ui.palette.addEventListener('click', (event) => {
  const item = event.target.closest('.palette-item');
  if (!item) return;
  if (item.dataset.tool === state.tool && ELEMENTS[state.tool]) {
    rotate(); // clicking the active element again rotates it
  } else {
    setTool(item.dataset.tool);
  }
});

ui.rotate.addEventListener('click', rotate);
ui.remove.addEventListener('click', () => {
  removeTile(selected());
  render();
});

ui.clear.addEventListener('click', () => {
  if (state.tiles.length === 0) return;
  if (ui.clear.dataset.confirm !== 'yes') {
    ui.clear.dataset.confirm = 'yes';
    ui.clear.textContent = 'Click again to clear';
    setTimeout(() => {
      delete ui.clear.dataset.confirm;
      ui.clear.textContent = 'Clear all';
    }, 3000);
    return;
  }
  delete ui.clear.dataset.confirm;
  ui.clear.textContent = 'Clear all';
  state.tiles = [];
  state.selectedId = null;
  scheduleSave();
  render();
  setStatus('Layout cleared.');
});

const resizeGrid = () => {
  const cols = Number(ui.cols.value);
  const rows = Number(ui.rows.value);
  if (!(Number.isInteger(cols) && cols >= 4 && cols <= 60 && Number.isInteger(rows) && rows >= 4 && rows <= 40)) {
    setStatus('Grid size: 4–60 columns and 4–40 rows.', 'error');
    ui.cols.value = state.cols;
    ui.rows.value = state.rows;
    return;
  }
  const outside = state.tiles.filter((t) => cellsOf(t).some(([x, y]) => x >= cols || y >= rows));
  if (outside.length > 0) {
    setStatus(`Cannot shrink: ${outside.length} element(s) would be outside the grid. Move them first.`, 'error');
    ui.cols.value = state.cols;
    ui.rows.value = state.rows;
    return;
  }
  state.cols = cols;
  state.rows = rows;
  scheduleSave();
  render();
  setStatus(`Grid is now ${cols} × ${rows}.`);
};

ui.cols.addEventListener('change', resizeGrid);
ui.rows.addEventListener('change', resizeGrid);

ui.modeButtons.forEach((button) => {
  button.addEventListener('click', () => setMode(button.dataset.mode));
});

document.addEventListener('keydown', (event) => {
  if (event.target.matches('input, select, textarea')) return;
  if (event.key === 'e' || event.key === 'E') {
    setMode(state.mode === 'edit' ? 'run' : 'edit');
    return;
  }
  if (state.mode === 'run') return;
  if (event.key === 'r' || event.key === 'R') {
    rotate();
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    if (selected()) {
      event.preventDefault();
      removeTile(selected());
      render();
    }
  } else if (event.key === 'Escape') {
    state.selectedId = null;
    setTool('select');
  }
});

/* ---------- Startup ---------- */

const init = async () => {
  try {
    const response = await fetch('/api/layout');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Load failed.');
    state.cols = data.cols;
    state.rows = data.rows;
    state.tiles = data.tiles;
  } catch (error) {
    setStatus(`Could not load layout: ${error.message}`, 'error');
  }
  ui.board.dataset.tool = state.tool;
  let savedMode = null;
  try {
    savedMode = localStorage.getItem(MODE_KEY);
  } catch (_error) {
    savedMode = null;
  }
  // URL hash (#edit / #run) wins; otherwise the last used mode; otherwise run mode
  // when a layout already exists.
  const hashMode = ['#edit', '#run'].includes(location.hash) ? location.hash.slice(1) : null;
  setMode(hashMode || savedMode || (state.tiles.length > 0 ? 'run' : 'edit'));
};

window.addEventListener('hashchange', () => {
  if (['#edit', '#run'].includes(location.hash)) setMode(location.hash.slice(1));
});

init();
