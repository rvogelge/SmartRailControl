const SVG_NS = 'http://www.w3.org/2000/svg';
const CELL = 100; // SVG units per grid square
const CELL_PX = 56; // on-screen size of one square

// Each element is drawn in a 100×100 square. Connection points are the edge
// midpoints — west (0,50), east (100,50), north (50,0), south (50,100) — and the
// corners for 45° diagonal track: NW (0,0), NE (100,0), SE (100,100), SW (0,100).
//
// Switchable elements define `routes` (one set of paths per state, first state is
// the default). In each state the active route is drawn bright and the others dimmed.

// 45° curve: leaves an edge midpoint horizontally and arrives at a corner at 45°.
// Arc radius 50 / (√2 − 1) ≈ 120.71 ends at (85.36, 85.36), then a short diagonal.
const CURVE45_W_SE = 'M0 50 A120.71 120.71 0 0 1 85.36 85.36 L100 100'; // west → south-east corner
const CURVE45_W_NE = 'M0 50 A120.71 120.71 0 0 0 85.36 14.64 L100 0'; // west → north-east corner
const CURVE45_SW_E = 'M0 100 L14.64 85.36 A120.71 120.71 0 0 1 100 50'; // south-west corner → east
const ARC90_WS = 'M0 50 A50 50 0 0 1 50 100'; // west → south (90°)
const STRAIGHT_WE = 'M0 50 H100';
const STRAIGHT_NS = 'M50 0 V100';
const DIAGONAL_SW_NE = 'M0 100 L100 0';

const ELEMENTS = {
  straight: {
    label: 'Straight',
    paths: [STRAIGHT_WE]
  },
  diagonal: {
    label: 'Diagonal',
    paths: [DIAGONAL_SW_NE]
  },
  'curve-45-left': {
    label: 'Curve 45° left',
    paths: [CURVE45_W_NE]
  },
  'curve-45-right': {
    label: 'Curve 45° right',
    paths: [CURVE45_W_SE]
  },
  curve: {
    label: 'Curve 90°',
    paths: [ARC90_WS]
  },
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
  'double-slip': {
    label: 'Crossover switch',
    // Straight W–E crossing the SW–NE diagonal; the slip routes curve W→NE and SW→E.
    routes: { straight: [STRAIGHT_WE, DIAGONAL_SW_NE], turn: [CURVE45_W_NE, CURVE45_SW_E] },
    stateLabels: { straight: 'straight', turn: 'turning' },
    switchPoint: true
  },
  'crossing-45': {
    label: 'Crossing 45°',
    paths: [STRAIGHT_WE, DIAGONAL_SW_NE]
  },
  crossing: {
    label: 'Crossing 90°',
    paths: [STRAIGHT_WE, STRAIGHT_NS]
  },
  buffer: {
    label: 'Buffer stop',
    paths: ['M0 50 H62'],
    extra: 'buffer'
  },
  signal: {
    label: 'Signal',
    paths: [STRAIGHT_WE],
    states: ['stop', 'go'],
    stateLabels: { stop: 'stop (red)', go: 'go (green)' },
    extra: 'signal'
  }
};

const statesOf = (type) => {
  const def = ELEMENTS[type];
  return def.routes ? Object.keys(def.routes) : def.states || null;
};
const isSwitchable = (type) => Boolean(statesOf(type));
const defaultState = (type) => (statesOf(type) ? statesOf(type)[0] : undefined);

const TOOLS = [
  { id: 'select', label: 'Select / move', icon: 'select' },
  ...Object.entries(ELEMENTS).map(([id, el]) => ({ id, label: el.label, icon: 'track' })),
  { id: 'eraser', label: 'Eraser', icon: 'eraser' }
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
  drag: null // { id, startCell, cell, moved }
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

/* ---------- Helpers ---------- */

const svg = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
  return node;
};

const tileAt = (x, y) => state.tiles.find((t) => t.x === x && t.y === y);
const selected = () => state.tiles.find((t) => t.id === state.selectedId);
const inBounds = (cell) => cell && cell.x >= 0 && cell.y >= 0 && cell.x < state.cols && cell.y < state.rows;

const cellFromEvent = (event) => {
  const point = ui.board.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  const local = point.matrixTransform(ui.board.getScreenCTM().inverse());
  const cell = { x: Math.floor(local.x / CELL), y: Math.floor(local.y / CELL) };
  return inBounds(cell) ? cell : null;
};

// Draws one track element into a <g> covering a single 100×100 square.
const drawElement = (type, { rotation = 0, state, className = '' } = {}) => {
  const def = ELEMENTS[type];
  const current = state || defaultState(type);
  const group = svg('g', { class: `track ${className}`.trim() });
  const inner = svg('g', { transform: `rotate(${rotation} 50 50)` });

  if (def.routes) {
    const all = Object.values(def.routes).flat();
    all.forEach((d) => inner.append(svg('path', { d, class: 'ballast' })));
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
  ui.cols.value = state.cols;
  ui.rows.value = state.rows;
};

const renderTiles = () => {
  ui.tiles.replaceChildren(
    ...state.tiles.map((tile) => {
      const isDragging = state.drag && state.drag.moved && state.drag.id === tile.id;
      const g = svg('g', {
        transform: `translate(${tile.x * CELL} ${tile.y * CELL})`,
        'data-id': tile.id,
        class: `tile${tile.id === state.selectedId ? ' selected' : ''}${isDragging ? ' dragging' : ''}`
      });
      g.append(svg('rect', { width: CELL, height: CELL, class: 'tile-bg' }));
      g.append(drawElement(tile.type, { rotation: tile.rotation, state: tile.state }));
      if (state.mode === 'run' && isSwitchable(tile.type)) g.classList.add('switchable');
      return g;
    })
  );
};

const renderOverlay = () => {
  ui.overlay.replaceChildren();
  const cell = state.drag ? state.drag.cell : state.hoverCell;
  if (!cell) return;

  if (state.mode === 'run') {
    const tile = tileAt(cell.x, cell.y);
    if (tile && isSwitchable(tile.type)) {
      const g = svg('g', { transform: `translate(${cell.x * CELL} ${cell.y * CELL})` });
      g.append(svg('rect', { width: CELL, height: CELL, class: 'hover-cell run' }));
      ui.overlay.append(g);
    }
    return;
  }

  let type = null;
  let rotation = 0;
  let ghostState;
  let blocked = false;

  if (state.drag && state.drag.moved) {
    const tile = state.tiles.find((t) => t.id === state.drag.id);
    type = tile.type;
    rotation = tile.rotation;
    ghostState = tile.state;
    const occupant = tileAt(cell.x, cell.y);
    blocked = Boolean(occupant && occupant.id !== tile.id);
  } else if (ELEMENTS[state.tool]) {
    type = state.tool;
    rotation = state.placeRotation;
  }

  const g = svg('g', { transform: `translate(${cell.x * CELL} ${cell.y * CELL})` });
  const toolClass = state.tool === 'eraser' ? ' erase' : '';
  g.append(svg('rect', { width: CELL, height: CELL, class: `hover-cell${blocked ? ' blocked' : ''}${toolClass}` }));
  if (type) g.append(drawElement(type, { rotation, state: ghostState, className: 'ghost-track' }));
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
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(state.tool === tool.id));

      const preview = svg('svg', { viewBox: '0 0 100 100', class: 'palette-preview', 'aria-hidden': 'true' });
      preview.append(svg('rect', { width: 100, height: 100, rx: 10, class: 'preview-bg' }));
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

const render = () => {
  renderMode();
  renderBoard();
  renderTiles();
  renderOverlay();
  renderPalette();
  renderToolbar();
};

/* ---------- Actions ---------- */

const setTool = (tool) => {
  state.tool = tool;
  if (tool !== 'select') state.selectedId = null;
  ui.board.dataset.tool = tool;
  render();
  if (ELEMENTS[tool]) setStatus(`${ELEMENTS[tool].label}: click a square to place it. Press R to rotate.`);
  else if (tool === 'eraser') setStatus('Eraser: click an element to remove it.');
  else setStatus('Select: click an element to select it, drag to move it.');
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
    setStatus('Run mode: click a turnout, crossover switch or signal to change it.');
  } else {
    setTool(state.tool);
  }
};

const toggleState = (tile) => {
  const states = statesOf(tile.type);
  const next = states[(states.indexOf(tile.state) + 1) % states.length];
  tile.state = next;
  scheduleSave();
  render();
  const def = ELEMENTS[tile.type];
  setStatus(`${def.label} at column ${tile.x + 1}, row ${tile.y + 1}: ${def.stateLabels[next]}.`, 'ok');
};

const placeTile = (cell) => {
  const existing = tileAt(cell.x, cell.y);
  if (existing) state.tiles = state.tiles.filter((t) => t !== existing);
  const tile = { id: newId(), type: state.tool, x: cell.x, y: cell.y, rotation: state.placeRotation };
  if (isSwitchable(state.tool)) tile.state = defaultState(state.tool);
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
    tile.rotation = (tile.rotation + 90) % 360;
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
      if (cell.x !== state.drag.startCell.x || cell.y !== state.drag.startCell.y) state.drag.moved = true;
      state.drag.cell = cell;
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
    if (tile && isSwitchable(tile.type)) toggleState(tile);
    return;
  }

  if (ELEMENTS[state.tool]) {
    placeTile(cell);
  } else if (state.tool === 'eraser') {
    removeTile(tile);
  } else {
    state.selectedId = tile ? tile.id : null;
    if (tile) {
      state.drag = { id: tile.id, startCell: cell, cell, moved: false };
      ui.board.setPointerCapture(event.pointerId);
      setStatus(`${ELEMENTS[tile.type].label} selected. Drag to move, R to rotate, Del to remove.`);
    }
  }
  render();
});

const endDrag = (event, cancelled = false) => {
  if (!state.drag) return;
  const { id, cell, moved } = state.drag;
  state.drag = null;
  if (ui.board.hasPointerCapture(event.pointerId)) ui.board.releasePointerCapture(event.pointerId);

  if (moved && !cancelled) {
    const tile = state.tiles.find((t) => t.id === id);
    const occupant = tileAt(cell.x, cell.y);
    if (occupant && occupant.id !== id) {
      setStatus('That square is already occupied.', 'error');
    } else if (tile.x !== cell.x || tile.y !== cell.y) {
      tile.x = cell.x;
      tile.y = cell.y;
      scheduleSave();
      setStatus(`Moved to column ${cell.x + 1}, row ${cell.y + 1}.`);
    }
  }
  state.hoverCell = cellFromEvent(event);
  render();
};

ui.board.addEventListener('pointerup', (event) => endDrag(event));
ui.board.addEventListener('pointercancel', (event) => endDrag(event, true));

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
    renderBoard();
    return;
  }
  const outside = state.tiles.filter((t) => t.x >= cols || t.y >= rows);
  if (outside.length > 0) {
    setStatus(`Cannot shrink: ${outside.length} element(s) would be outside the grid. Move them first.`, 'error');
    renderBoard();
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

init();
