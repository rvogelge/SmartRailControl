/* global TrackCatalog, I18n */
const SVG_NS = 'http://www.w3.org/2000/svg';
const CELL = 100; // SVG units per grid square
const CELL_PX = 56; // on-screen size of one square
const { cellsOf, footprint, statesOf, addressSlots, addressSpace, findAddressConflicts, MAX_ADDRESS } = TrackCatalog;
// Translated text (`t` is used for tiles in this file).
const tr = (key, vars) => I18n.t(key, vars);

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

// Labels and state names come from i18n.js (falling back to trackCatalog.js).
const ELEMENTS = {
  straight: { paths: [STRAIGHT_WE] },
  diagonal: { paths: [DIAGONAL_SW_NE] },
  'curve-45-left': { paths: [CURVE45_W_NE] },
  'curve-45-right': { paths: [CURVE45_W_SE] },
  curve: { paths: [ARC90_R1] },
  'curve-r2': { paths: [ARC90_R2] },
  'turnout-left': {
    routes: { straight: [STRAIGHT_WE], diverging: [CURVE45_W_NE] },
    switchPoint: true
  },
  'turnout-right': {
    routes: { straight: [STRAIGHT_WE], diverging: [CURVE45_W_SE] },
    switchPoint: true
  },
  'turnout-3way': {
    routes: { straight: [STRAIGHT_WE], left: [CURVE45_W_NE], right: [CURVE45_W_SE] },
    switchPoint: true
  },
  'double-slip': {
    // Straight W–E crossing the SW–NE diagonal; the slip routes curve W→NE and SW→E.
    routes: { straight: [STRAIGHT_WE, DIAGONAL_SW_NE], turn: [CURVE45_W_NE, CURVE45_SW_E] },
    switchPoint: true
  },
  'crossing-45': { paths: [STRAIGHT_WE, DIAGONAL_SW_NE] },
  crossing: { paths: [STRAIGHT_WE, STRAIGHT_NS] },
  buffer: { paths: ['M0 50 H62'], extra: 'buffer' },
  signal: {
    paths: [STRAIGHT_WE],
    extra: 'signal'
  },
  contact: { paths: [STRAIGHT_WE], extra: 'contact' },
  uncoupler: { paths: [STRAIGHT_WE], extra: 'uncoupler' }
};

const isSwitchable = (type) => Boolean(statesOf(type));
const isMomentary = (type) => Boolean(TrackCatalog.TYPES[type] && TrackCatalog.TYPES[type].momentary);
const isClickableInRun = (type) => isSwitchable(type) || isMomentary(type) || type === 'contact';
const defaultState = (type) => (statesOf(type) ? statesOf(type)[0] : undefined);

const TOOLS = ['select', ...Object.keys(ELEMENTS), 'eraser'].map((id) => ({ id }));
const toolLabel = (id) => (ELEMENTS[id] ? I18n.label(id) : tr(`tool.${id}`));

const ZOOM_MIN = 16;
const ZOOM_MAX = 140;
const ZOOM_STEP = 1.25;
const ZOOM_KEY = 'birdrail.layoutZoom';
const MODE_KEY = 'birdrail.layoutMode';

const $ = (id) => document.getElementById(id);
const ui = {
  palette: $('palette'),
  board: $('board'),
  boardCard: document.querySelector('.board-card'),
  boardScroll: document.querySelector('.board-scroll'),
  gridRect: $('gridRect'),
  tiles: $('tilesLayer'),
  overlay: $('overlayLayer'),
  rotate: $('rotateButton'),
  remove: $('deleteButton'),
  check: $('checkButton'),
  issues: $('issuesPanel'),
  issuesList: $('issuesList'),
  clear: $('clearButton'),
  zoomIn: $('zoomIn'),
  zoomOut: $('zoomOut'),
  zoomFit: $('zoomFit'),
  zoomLabel: $('zoomLabel'),
  status: $('statusLine'),
  saveState: $('saveState'),
  props: $('propsBar'),
  propsTitle: $('propsTitle'),
  propsFields: $('propsFields'),
  rules: $('rulesButton'),
  modeButtons: document.querySelectorAll('[data-mode]')
};

const state = {
  mode: 'edit', // 'edit' | 'run'
  cols: 20,
  rows: 12,
  tiles: [],
  tool: 'select',
  placeRotation: 0,
  selection: new Set(), // ids of selected tiles
  hoverCell: null,
  drag: null, // { ids, start, delta, moved, clickedId, modifier }
  marquee: null, // { start, end, base }
  flashing: new Set(), // momentary elements briefly highlighted in run mode
  sensors: {}, // contact tracks that are on (occupied): { id: true }
  propsFor: null, // key the properties bar was built for
  zoom: CELL_PX, // on-screen pixels per grid square
  zoomFit: true,
  issuesOpen: false
};

const newId = () => `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const setStatus = (text, kind = '') => {
  ui.status.textContent = text;
  ui.status.classList.toggle('error', kind === 'error');
  ui.status.classList.toggle('ok', kind === 'ok');
};

const storage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch (_error) {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (_error) {
      // Storage unavailable: preference simply is not remembered.
    }
  }
};

/* ---------- Persistence ---------- */

let saveTimer = null;
const scheduleSave = () => {
  ui.saveState.textContent = tr('common.saving');
  ui.saveState.classList.remove('error');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const response = await fetch('/api/layout', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...extent(), tiles: state.tiles })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Save failed.');
      ui.saveState.textContent = tr('common.saved');
    } catch (error) {
      ui.saveState.textContent = tr('common.notSaved');
      ui.saveState.classList.add('error');
      setStatus(tr('lay.saveFailed', { msg: error.message }), 'error');
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
const tileById = (id) => state.tiles.find((t) => t.id === id);
const tileAt = (x, y) => state.tiles.find((t) => cellsOf(t).some((c) => sameCell(c, [x, y])));
const selectedTiles = () => state.tiles.filter((t) => state.selection.has(t.id));
const singleSelected = () => (state.selection.size === 1 ? tileById([...state.selection][0]) : null);
const inBounds = ([x, y]) => x >= 0 && y >= 0 && x < state.cols && y < state.rows;

// Squares the placed elements need (at least the minimum grid of the server).
const MIN_GRID = 4;
const MAX_GRID = 250;
const extent = () => {
  let cols = MIN_GRID;
  let rows = MIN_GRID;
  state.tiles.forEach((tile) => {
    cellsOf(tile).forEach(([x, y]) => {
      cols = Math.max(cols, x + 1);
      rows = Math.max(rows, y + 1);
    });
  });
  return { cols, rows };
};
const where = (tile) => tr('lay.where', { x: tile.x + 1, y: tile.y + 1 });

// Checks whether an element of `type` fits at anchor (x, y) with `rotation`.
const checkFit = (type, x, y, rotation, ignoreId = null) => {
  const cells = cellsOf({ type, x, y, rotation });
  const outside = cells.some((c) => !inBounds(c));
  const overlapping = state.tiles.filter(
    (t) => t.id !== ignoreId && cellsOf(t).some((tc) => cells.some((c) => sameCell(c, tc)))
  );
  return { cells, outside, overlapping };
};

// Checks a set of transformed tiles (a moved or rotated group) against the grid
// edge and against every tile that is not part of the group.
const checkGroupFit = (movedTiles) => {
  const ids = new Set(movedTiles.map((t) => t.id));
  const cells = movedTiles.flatMap((t) => cellsOf(t));
  const outside = cells.some((c) => !inBounds(c));
  const blocked = state.tiles.some(
    (t) => !ids.has(t.id) && cellsOf(t).some((tc) => cells.some((c) => sameCell(c, tc)))
  );
  return { outside, blocked, ok: !outside && !blocked };
};

const shifted = (tiles, dx, dy) => tiles.map((t) => ({ ...t, x: t.x + dx, y: t.y + dy }));

// Rotates a group 90° clockwise around its bounding box (a single tile rotates in place).
const rotatedGroup = (tiles) => {
  const blocks = tiles.map((t) => ({ t, n: footprint(t.type).size }));
  const minX = Math.min(...blocks.map(({ t }) => t.x));
  const minY = Math.min(...blocks.map(({ t }) => t.y));
  const maxY = Math.max(...blocks.map(({ t, n }) => t.y + n - 1));
  return blocks.map(({ t, n }) => ({
    ...t,
    x: minX + (maxY - (t.y + n - 1)),
    y: minY + (t.x - minX),
    rotation: (t.rotation + 90) % 360
  }));
};

const cellFromEvent = (event, clamp = false) => {
  const point = ui.board.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  const local = point.matrixTransform(ui.board.getScreenCTM().inverse());
  let x = Math.floor(local.x / CELL);
  let y = Math.floor(local.y / CELL);
  if (clamp) {
    x = Math.max(0, Math.min(state.cols - 1, x));
    y = Math.max(0, Math.min(state.rows - 1, y));
  }
  return inBounds([x, y]) ? { x, y } : null;
};

/* ---------- Addresses & consistency ---------- */

const addressText = (tile) => {
  const slots = addressSlots(tile.type);
  if (slots.length === 0) return null;
  const values = slots.map((_s, i) => (tile.addresses && tile.addresses[i]) || null);
  return { text: values.map((v) => (v === null ? '?' : v)).join('/'), missing: values.some((v) => v === null) };
};

const describe = (tile) => {
  const addr = addressText(tile);
  const label = I18n.label(tile.type);
  if (!addr) return label;
  return /^[?/]+$/.test(addr.text) ? tr('lay.noAddress', { label }) : `${label} #${addr.text}`;
};

// Who else uses `address` in the address space of `tile` (other elements or the other drive).
const addressUser = (tile, slot, address) => {
  const space = addressSpace(tile.type);
  for (const other of state.tiles) {
    if (addressSpace(other.type) !== space) continue;
    const list = other.addresses || [];
    for (let i = 0; i < list.length; i += 1) {
      if (other.id === tile.id && i === slot) continue;
      if (list[i] === address) return { tile: other, slot: i };
    }
  }
  return null;
};

const computeIssues = () => {
  const conflicts = findAddressConflicts(state.tiles);
  const conflictIds = new Set(conflicts.flatMap((c) => c.uses.map((u) => u.id)));
  const missing = state.tiles.filter((t) => {
    const addr = addressText(t);
    return addr && addr.missing;
  });
  return { conflicts, conflictIds, missing };
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

const cellRects = (tile, className) =>
  cellsOf(tile).map(([cx, cy]) =>
    svg('rect', { x: (cx - tile.x) * CELL, y: (cy - tile.y) * CELL, width: CELL, height: CELL, class: className })
  );

/* ---------- Rendering ---------- */

// Height left for the pane: from its top to the window bottom, minus what sits below it
// (status line, card padding, page margin).
const paneHeight = () => {
  // Measured from the status line, not the card: in edit mode the card is stretched
  // to the height of the element palette next to it.
  const pane = ui.boardScroll.getBoundingClientRect();
  const card = getComputedStyle(ui.boardCard);
  const below =
    ui.status.getBoundingClientRect().bottom -
    pane.bottom +
    parseFloat(card.paddingBottom) +
    parseFloat(card.borderBottomWidth) +
    parseFloat(getComputedStyle(ui.boardCard.parentElement).paddingBottom);
  return Math.max(240, Math.floor(window.innerHeight - (pane.top + window.scrollY) - below));
};

// The grid fills the pane at the current zoom: zooming out shows more squares, zooming in
// fewer. It never gets smaller than the placed elements need; then the pane scrolls.
const updateGrid = () => {
  ui.boardScroll.style.height = `${paneHeight()}px`;
  const used = extent();
  const visibleCols = Math.floor(ui.boardScroll.clientWidth / state.zoom);
  const visibleRows = Math.floor(ui.boardScroll.clientHeight / state.zoom);
  state.cols = Math.min(MAX_GRID, Math.max(used.cols, visibleCols));
  state.rows = Math.min(MAX_GRID, Math.max(used.rows, visibleRows));
};

const renderBoard = () => {
  updateGrid();
  // The drawing reaches the pane edges: the last, partial square is shown but takes no
  // elements (it is outside state.cols / state.rows).
  const pxWidth = Math.max(Math.round(state.cols * state.zoom), ui.boardScroll.clientWidth);
  const pxHeight = Math.max(Math.round(state.rows * state.zoom), ui.boardScroll.clientHeight);
  const width = (pxWidth / state.zoom) * CELL;
  const height = (pxHeight / state.zoom) * CELL;
  ui.board.setAttribute('viewBox', `0 0 ${width} ${height}`);
  ui.board.setAttribute('width', pxWidth);
  ui.board.setAttribute('height', pxHeight);
  ui.gridRect.setAttribute('width', width);
  ui.gridRect.setAttribute('height', height);
  ui.zoomLabel.textContent = `${Math.round((state.zoom / CELL_PX) * 100)}%`;
  ui.zoomFit.setAttribute('aria-pressed', String(state.zoomFit));
  ui.zoomIn.disabled = state.zoom >= ZOOM_MAX;
  ui.zoomOut.disabled = state.zoom <= ZOOM_MIN;
};

const renderTiles = (issues = computeIssues()) => {
  const dragging = state.drag && state.drag.moved ? new Set(state.drag.ids) : new Set();
  ui.tiles.replaceChildren(
    ...state.tiles.map((tile) => {
      const classes = ['tile'];
      if (state.selection.has(tile.id)) classes.push('selected');
      if (dragging.has(tile.id)) classes.push('dragging');
      if (state.mode === 'edit' && issues.conflictIds.has(tile.id)) classes.push('conflict');
      if (state.mode === 'run' && isClickableInRun(tile.type)) classes.push('switchable');

      const g = svg('g', {
        transform: `translate(${tile.x * CELL} ${tile.y * CELL})`,
        'data-id': tile.id,
        class: classes.join(' ')
      });
      g.append(...cellRects(tile, 'tile-bg'));
      const active = state.flashing.has(tile.id) || (state.mode === 'run' && Boolean(state.sensors[tile.id]));
      g.append(drawElement(tile.type, { rotation: tile.rotation, state: tile.state, active }));

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

const appendGhost = (tile, blocked) => {
  const g = svg('g', { transform: `translate(${tile.x * CELL} ${tile.y * CELL})` });
  cellsOf(tile).forEach(([cx, cy]) => {
    const outside = !inBounds([cx, cy]);
    g.append(
      svg('rect', {
        x: (cx - tile.x) * CELL,
        y: (cy - tile.y) * CELL,
        width: CELL,
        height: CELL,
        class: `hover-cell${blocked || outside ? ' blocked' : ''}`
      })
    );
  });
  g.append(drawElement(tile.type, { rotation: tile.rotation, state: tile.state, className: 'ghost-track' }));
  ui.overlay.append(g);
};

const appendHoverTile = (tile, className) => {
  const g = svg('g', { transform: `translate(${tile.x * CELL} ${tile.y * CELL})` });
  g.append(...cellRects(tile, className));
  ui.overlay.append(g);
};

const renderOverlay = () => {
  ui.overlay.replaceChildren();

  if (state.mode === 'run') {
    const cell = state.hoverCell;
    const tile = cell && tileAt(cell.x, cell.y);
    if (tile && isClickableInRun(tile.type)) appendHoverTile(tile, 'hover-cell run');
    return;
  }

  if (state.marquee) {
    const { start, end } = state.marquee;
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    ui.overlay.append(
      svg('rect', {
        x: x * CELL,
        y: y * CELL,
        width: (Math.abs(end.x - start.x) + 1) * CELL,
        height: (Math.abs(end.y - start.y) + 1) * CELL,
        class: 'marquee'
      })
    );
    return;
  }

  if (state.drag && state.drag.moved) {
    const moved = shifted(state.drag.ids.map(tileById), state.drag.delta.dx, state.drag.delta.dy);
    const fit = checkGroupFit(moved);
    moved.forEach((t) => appendGhost(t, !fit.ok));
    return;
  }

  if (!state.hoverCell) return;

  if (ELEMENTS[state.tool]) {
    const ghost = { type: state.tool, x: state.hoverCell.x, y: state.hoverCell.y, rotation: state.placeRotation };
    appendGhost(ghost, checkFit(ghost.type, ghost.x, ghost.y, ghost.rotation).outside);
    return;
  }

  const toolClass = state.tool === 'eraser' ? ' erase' : '';
  const hovered = tileAt(state.hoverCell.x, state.hoverCell.y);
  if (hovered) {
    appendHoverTile(hovered, `hover-cell${toolClass}`);
  } else {
    const g = svg('g', { transform: `translate(${state.hoverCell.x * CELL} ${state.hoverCell.y * CELL})` });
    g.append(svg('rect', { width: CELL, height: CELL, class: `hover-cell${toolClass}` }));
    ui.overlay.append(g);
  }
};

const renderPalette = () => {
  ui.palette.replaceChildren(
    ...TOOLS.map((tool) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'palette-item';
      button.dataset.tool = tool.id;
      button.title = toolLabel(tool.id);
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
      label.textContent = toolLabel(tool.id);

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

const renderToolbar = (issues) => {
  const count = state.selection.size;
  ui.rotate.disabled = !(count > 0 || ELEMENTS[state.tool]);
  ui.remove.disabled = count === 0;
  ui.remove.textContent = count > 1 ? tr('lay.removeN', { n: count }) : tr('lay.remove');

  const conflictCount = issues.conflicts.length;
  ui.check.classList.toggle('has-conflicts', conflictCount > 0);
  ui.check.textContent = conflictCount > 0 ? tr('lay.conflicts', { n: conflictCount }) : tr('lay.check');
  ui.check.setAttribute('aria-expanded', String(state.issuesOpen));
};

const renderIssues = (issues) => {
  ui.issues.hidden = !(state.issuesOpen && state.mode === 'edit');
  if (ui.issues.hidden) return;

  const items = [];
  const addItem = (text, ids, kind) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `issue ${kind}`;
    button.textContent = text;
    button.addEventListener('click', () => {
      state.tool = 'select';
      ui.board.dataset.tool = 'select';
      state.selection = new Set(ids);
      render();
      setStatus(ids.length > 1 ? tr('lay.nSelected', { n: ids.length }) : tr('lay.oneSelected', { name: describe(tileById(ids[0])) }));
    });
    li.append(button);
    items.push(li);
  };

  issues.conflicts.forEach((c) => {
    const users = c.uses.map((u) => {
      const t = tileById(u.id);
      const drive = addressSlots(t.type).length > 1 ? ` (${I18n.addressLabel(t.type, u.slot)})` : '';
      return tr('lay.at', { label: `${I18n.label(t.type)}${drive}`, where: where(t) });
    });
    addItem(
      tr('lay.conflictItem', { space: tr(`space.${c.space}`), address: c.address, n: c.uses.length, users: users.join(' · ') }),
      [...new Set(c.uses.map((u) => u.id))],
      'conflict'
    );
  });
  issues.missing.forEach((tile) => addItem(tr('lay.missingItem', { label: I18n.label(tile.type), where: where(tile) }), [tile.id], 'missing'));

  if (items.length === 0) {
    const li = document.createElement('li');
    li.className = 'issue ok';
    li.textContent = tr('lay.allGood');
    items.push(li);
  }
  ui.issuesList.replaceChildren(...items);
};

// Properties bar: rebuilt only when the selection changes, so typing is not interrupted.
const renderProps = () => {
  // The bar always keeps its place in edit mode, so selecting never shifts the grid
  // under the mouse pointer.
  ui.props.hidden = state.mode !== 'edit';
  const tiles = state.mode === 'edit' ? selectedTiles() : [];
  if (tiles.length === 0) {
    if (state.propsFor === 'none') return;
    state.propsFor = 'none';
    ui.propsTitle.textContent = tr('lay.noSelection');
    const note = document.createElement('span');
    note.className = 'props-note';
    note.textContent = tr('lay.noSelectionNote');
    ui.propsFields.replaceChildren(note);
    return;
  }
  const key = tiles.length === 1 ? `${tiles[0].id}@${tiles[0].x},${tiles[0].y}` : `multi:${tiles.length}`;
  if (state.propsFor === key) return;
  state.propsFor = key;

  if (tiles.length > 1) {
    ui.propsTitle.textContent = tr('lay.multiTitle', { n: tiles.length });
    const note = document.createElement('span');
    note.className = 'props-note';
    note.textContent = tr('lay.multiNote');
    ui.propsFields.replaceChildren(note);
    return;
  }

  const tile = tiles[0];
  ui.propsTitle.textContent = `${I18n.label(tile.type)} · ${where(tile)}`;
  const slots = addressSlots(tile.type);
  if (slots.length === 0) {
    const note = document.createElement('span');
    note.className = 'props-note';
    note.textContent = tr('lay.noAddressNeeded');
    ui.propsFields.replaceChildren(note);
    return;
  }

  ui.propsFields.replaceChildren(
    ...slots.map((_slot, i) => {
      const label = document.createElement('label');
      label.className = 'props-field';
      const span = document.createElement('span');
      span.textContent = I18n.addressLabel(tile.type, i);
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '1';
      input.max = String(MAX_ADDRESS);
      input.inputMode = 'numeric';
      input.placeholder = '–';
      input.value = (tile.addresses && tile.addresses[i]) || '';
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
  const issues = computeIssues();
  renderMode();
  renderBoard();
  renderTiles(issues);
  renderOverlay();
  renderPalette();
  renderToolbar(issues);
  renderIssues(issues);
  renderProps();
};

/* ---------- Zoom ---------- */


// Fit: zoom so that all placed elements fill the pane (an empty layout gets the default size).
const fitZoom = () => {
  if (state.tiles.length === 0) return CELL_PX;
  ui.boardScroll.style.height = `${paneHeight()}px`;
  const used = extent();
  const width = ui.boardScroll.clientWidth;
  const height = ui.boardScroll.clientHeight;
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.floor(Math.min(width / used.cols, height / used.rows))));
};

const setZoom = (zoom, { fit = false } = {}) => {
  const scroll = ui.boardScroll;
  // Keep the point in the middle of the view in place while zooming.
  const cx = (scroll.scrollLeft + scroll.clientWidth / 2) / (state.cols * state.zoom);
  const cy = (scroll.scrollTop + scroll.clientHeight / 2) / (state.rows * state.zoom);

  state.zoomFit = fit;
  state.zoom = fit ? fitZoom() : Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(zoom)));
  storage.set(ZOOM_KEY, fit ? 'fit' : String(state.zoom));
  renderBoard();

  scroll.scrollLeft = cx * state.cols * state.zoom - scroll.clientWidth / 2;
  scroll.scrollTop = cy * state.rows * state.zoom - scroll.clientHeight / 2;
};

const zoomBy = (factor) => setZoom(state.zoom * factor);

ui.zoomIn.addEventListener('click', () => zoomBy(ZOOM_STEP));
ui.zoomOut.addEventListener('click', () => zoomBy(1 / ZOOM_STEP));
ui.zoomFit.addEventListener('click', () => setZoom(0, { fit: true }));

ui.boardScroll.addEventListener(
  'wheel',
  (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1);
  },
  { passive: false }
);

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => (state.zoomFit ? setZoom(0, { fit: true }) : renderBoard()), 120);
});

/* ---------- Actions ---------- */

const setAddress = (tileId, slot, input) => {
  const tile = tileById(tileId);
  if (!tile) return;
  const previous = (tile.addresses && tile.addresses[slot]) || '';
  const raw = input.value.trim();
  const value = raw === '' ? null : Number(raw);
  if (value !== null && !(Number.isInteger(value) && value >= 1 && value <= MAX_ADDRESS)) {
    setStatus(tr('lay.addrRange', { max: MAX_ADDRESS }), 'error');
    input.value = previous;
    return;
  }
  if (value !== null) {
    const user = addressUser(tile, slot, value);
    if (user) {
      const whom =
        user.tile.id === tile.id
          ? tr('lay.otherDrive', { label: I18n.label(tile.type) })
          : tr('lay.at', { label: I18n.label(user.tile.type), where: where(user.tile) });
      setStatus(tr('lay.addrUsed', { space: tr(`space.${addressSpace(tile.type)}`), value, whom }), 'error');
      input.value = previous;
      input.select();
      return;
    }
  }
  const slots = addressSlots(tile.type);
  tile.addresses = slots.map((_s, i) => (i === slot ? value : (tile.addresses && tile.addresses[i]) || null));
  scheduleSave();
  const issues = computeIssues();
  renderTiles(issues);
  renderToolbar(issues);
  renderIssues(issues);
  setStatus(value === null ? tr('lay.addrCleared', { label: I18n.label(tile.type) }) : tr('lay.addrSaved', { name: describe(tile) }), 'ok');
};

const setTool = (tool) => {
  state.tool = tool;
  if (tool !== 'select') state.selection.clear();
  ui.board.dataset.tool = tool;
  render();
  if (ELEMENTS[tool]) setStatus(tr('lay.toolHint', { label: I18n.label(tool) }));
  else if (tool === 'eraser') setStatus(tr('lay.eraserHint'));
  else setStatus(tr('lay.selectHint'));
};

const setMode = (mode) => {
  state.mode = mode === 'run' ? 'run' : 'edit';
  state.selection.clear();
  state.drag = null;
  state.marquee = null;
  storage.set(MODE_KEY, state.mode);
  render();
  if (state.zoomFit) setZoom(0, { fit: true });
  if (state.mode === 'run') {
    pollLive();
    setStatus(tr('lay.runHint'));
  } else {
    setTool(state.tool);
  }
  window.dispatchEvent(new CustomEvent('modechange', { detail: { mode: state.mode } }));
};

// Menu entries of the top bar (menu.js).
window.BirdRail = window.BirdRail || {};
window.BirdRail.edit = () => setMode('edit');
window.BirdRail.run = () => setMode('run');

// Sends the operation to the server, which switches the decoder(s) on the Intellibox.
const sendOperation = async (tile, newState, label) => {
  try {
    const response = await fetch('/api/layout/operate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: tile.id, state: newState })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || tr('lay.rejected'));
    if (data.sent) {
      setStatus(tr('lay.sent', { label }), 'ok');
    } else {
      setStatus(tr('lay.notSent', { label, msg: data.error }), 'error');
    }
  } catch (error) {
    setStatus(tr('lay.notSent', { label, msg: error.message }), 'error');
  }
};

const operate = (tile) => {
  if (isSwitchable(tile.type)) {
    const states = statesOf(tile.type);
    tile.state = states[(states.indexOf(tile.state) + 1) % states.length];
    render();
    const label = `${describe(tile)}: ${I18n.stateLabel(tile.type, tile.state)}`;
    setStatus(tr('lay.sending', { label }));
    sendOperation(tile, tile.state, label);
  } else if (isMomentary(tile.type)) {
    state.flashing.add(tile.id);
    render();
    setTimeout(() => {
      state.flashing.delete(tile.id);
      render();
    }, 700);
    const label = `${describe(tile)}: ${tr('lay.triggered')}`;
    setStatus(tr('lay.sending', { label }));
    sendOperation(tile, undefined, label);
  } else if (tile.type === 'contact') {
    pressSensor(tile);
  }
};

// Contact tracks are inputs read from the s88 feedback modules. A click is a button
// press: the contact is on for 2 s, then off again (to test rules without a train).
// The server keeps the time and runs the logic rules for both changes.
const sensorTimers = new Map();
const pressSensor = async (tile) => {
  const label = describe(tile);
  state.sensors[tile.id] = true;
  render();
  try {
    const response = await fetch('/api/sensors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: tile.id, pulse: true })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || tr('lay.rejected'));
    const fired = data.fired.length;
    setStatus(`${tr('lay.pressed', { label })} — ${fired ? tr('rules.fired', { n: fired }) : tr('rules.noneFired')}.`, fired ? 'ok' : '');
    // Show it off again when the server releases it (the live poll confirms).
    clearTimeout(sensorTimers.get(tile.id));
    sensorTimers.set(tile.id, setTimeout(() => {
      sensorTimers.delete(tile.id);
      delete state.sensors[tile.id];
      render();
      pollLive();
    }, data.pulseMs || 2000));
  } catch (error) {
    delete state.sensors[tile.id];
    render();
    setStatus(`${label} — ${error.message}`, 'error');
  }
};

// Rules switch elements on the server: pick up their states and the active sensors.
// Only states are taken over, so edits that are not saved yet are never lost.
const pollLive = async () => {
  try {
    const response = await fetch('/api/live');
    if (!response.ok) return;
    const live = await response.json();
    let changed = JSON.stringify(live.sensors) !== JSON.stringify(state.sensors);
    state.sensors = live.sensors;
    state.tiles.forEach((tile) => {
      const next = live.states[tile.id];
      if (next !== undefined && next !== tile.state) {
        tile.state = next;
        changed = true;
      }
    });
    if (changed && !state.drag && !state.marquee) render();
  } catch (_error) {
    // Server not reachable: try again on the next tick.
  }
};

const openRulesWindow = () => {
  const win = window.open('/rules.html', 'birdrail-rules', 'popup,width=1180,height=820');
  if (win) win.focus();
  else location.href = '/rules.html'; // Popups blocked: open it here instead.
};

const placeTile = (cell) => {
  const fit = checkFit(state.tool, cell.x, cell.y, state.placeRotation);
  if (fit.outside) {
    setStatus(tr('lay.noFit', { label: I18n.label(state.tool) }), 'error');
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

const removeTiles = (ids) => {
  if (ids.length === 0) return;
  const remove = new Set(ids);
  const removed = state.tiles.filter((t) => remove.has(t.id));
  state.tiles = state.tiles.filter((t) => !remove.has(t.id));
  ids.forEach((id) => state.selection.delete(id));
  scheduleSave();
  setStatus(
    removed.length === 1 ? tr('lay.removedOne', { label: I18n.label(removed[0].type) }) : tr('lay.removedN', { n: removed.length })
  );
};

// Replaces the given tiles by their transformed versions if the result fits.
const applyGroup = (moved, errorText) => {
  const fit = checkGroupFit(moved);
  if (!fit.ok) {
    setStatus(tr(fit.outside ? 'lay.edgeInWay' : 'lay.elementInWay', { action: errorText }), 'error');
    return false;
  }
  const byId = new Map(moved.map((t) => [t.id, t]));
  state.tiles = state.tiles.map((t) => byId.get(t.id) || t);
  scheduleSave();
  return true;
};

const rotate = () => {
  const tiles = selectedTiles();
  if (tiles.length > 0) {
    if (applyGroup(rotatedGroup(tiles), tr('lay.cannotRotate'))) {
      setStatus(tiles.length > 1 ? tr('lay.rotatedN', { n: tiles.length }) : tr('lay.rotatedOne', { label: I18n.label(tiles[0].type) }));
    }
  } else if (ELEMENTS[state.tool]) {
    state.placeRotation = (state.placeRotation + 90) % 360;
  }
  render();
};

const nudge = (dx, dy) => {
  const tiles = selectedTiles();
  if (tiles.length === 0) return;
  if (applyGroup(shifted(tiles, dx, dy), tr('lay.cannotMove'))) render();
};

/* ---------- Pointer interaction ---------- */

const hasModifier = (event) => event.shiftKey || event.ctrlKey || event.metaKey;

ui.board.addEventListener('pointermove', (event) => {
  if (state.drag) {
    const cell = cellFromEvent(event, true);
    const delta = { dx: cell.x - state.drag.start.x, dy: cell.y - state.drag.start.y };
    if (delta.dx !== 0 || delta.dy !== 0) state.drag.moved = true;
    state.drag.delta = delta;
    renderTiles();
  } else if (state.marquee) {
    state.marquee.end = cellFromEvent(event, true);
  } else {
    state.hoverCell = cellFromEvent(event);
  }
  renderOverlay();
});

ui.board.addEventListener('pointerleave', () => {
  if (state.drag || state.marquee) return;
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
    render();
    return;
  }
  if (state.tool === 'eraser') {
    if (tile) removeTiles([tile.id]);
    render();
    return;
  }

  // Select tool
  const modifier = hasModifier(event);
  ui.board.setPointerCapture(event.pointerId);

  if (!tile) {
    // Start a selection frame; with a modifier it adds to the current selection.
    if (!modifier) state.selection.clear();
    state.marquee = { start: cell, end: cell, base: new Set(state.selection) };
    render();
    return;
  }

  if (modifier) {
    if (state.selection.has(tile.id)) state.selection.delete(tile.id);
    else state.selection.add(tile.id);
  } else if (!state.selection.has(tile.id)) {
    state.selection = new Set([tile.id]);
  }

  if (state.selection.has(tile.id)) {
    state.drag = {
      ids: [...state.selection],
      start: cell,
      delta: { dx: 0, dy: 0 },
      moved: false,
      clickedId: tile.id,
      modifier
    };
  }

  const count = state.selection.size;
  if (count === 1) {
    const only = singleSelected();
    const hint = addressSlots(only.type).length > 0 ? tr('lay.setAddressHint') : '';
    setStatus(`${tr('lay.selectedOneHint', { name: describe(only) })}${hint}`);
  } else if (count > 1) {
    setStatus(tr('lay.selectedNHint', { n: count }));
  }
  render();
});

const endPointer = (event, cancelled = false) => {
  if (ui.board.hasPointerCapture(event.pointerId)) ui.board.releasePointerCapture(event.pointerId);

  if (state.marquee) {
    const { start, end, base } = state.marquee;
    state.marquee = null;
    if (!cancelled) {
      const x1 = Math.min(start.x, end.x);
      const x2 = Math.max(start.x, end.x);
      const y1 = Math.min(start.y, end.y);
      const y2 = Math.max(start.y, end.y);
      const inside = state.tiles.filter((t) => cellsOf(t).some(([x, y]) => x >= x1 && x <= x2 && y >= y1 && y <= y2));
      state.selection = new Set([...base, ...inside.map((t) => t.id)]);
      if (state.selection.size > 0) setStatus(tr('lay.nSelected', { n: state.selection.size }));
    }
  }

  if (state.drag) {
    const { ids, delta, moved, clickedId, modifier } = state.drag;
    state.drag = null;
    if (moved && !cancelled) {
      if (applyGroup(shifted(ids.map(tileById), delta.dx, delta.dy), tr('lay.cannotMove'))) {
        setStatus(ids.length > 1 ? tr('lay.movedN', { n: ids.length }) : tr('lay.movedTo', { where: where(tileById(ids[0])) }));
      }
    } else if (!moved && !modifier && state.selection.size > 1) {
      // Plain click on one element of a group selects just that element.
      state.selection = new Set([clickedId]);
    }
  }

  state.hoverCell = cellFromEvent(event);
  render();
};

ui.board.addEventListener('pointerup', (event) => endPointer(event));
ui.board.addEventListener('pointercancel', (event) => endPointer(event, true));

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
ui.rules.addEventListener('click', openRulesWindow);

ui.remove.addEventListener('click', () => {
  removeTiles([...state.selection]);
  render();
});

ui.check.addEventListener('click', () => {
  state.issuesOpen = !state.issuesOpen;
  const issues = computeIssues();
  renderToolbar(issues);
  renderIssues(issues);
  if (state.zoomFit) setZoom(0, { fit: true });
  if (state.issuesOpen) {
    setStatus(
      issues.conflicts.length > 0
        ? tr('lay.dupFound', { n: issues.conflicts.length })
        : tr('lay.noDup', { n: issues.missing.length }),
      issues.conflicts.length > 0 ? 'error' : 'ok'
    );
  }
});

ui.clear.addEventListener('click', () => {
  if (state.tiles.length === 0) return;
  if (ui.clear.dataset.confirm !== 'yes') {
    ui.clear.dataset.confirm = 'yes';
    ui.clear.textContent = tr('lay.clearConfirm');
    setTimeout(() => {
      delete ui.clear.dataset.confirm;
      ui.clear.textContent = tr('lay.clear');
    }, 3000);
    return;
  }
  delete ui.clear.dataset.confirm;
  ui.clear.textContent = tr('lay.clear');
  state.tiles = [];
  state.selection.clear();
  scheduleSave();
  render();
  setStatus(tr('lay.cleared'));
});


ui.modeButtons.forEach((button) => {
  button.addEventListener('click', () => setMode(button.dataset.mode));
});

const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

document.addEventListener('keydown', (event) => {
  if (event.target.matches('input, select, textarea')) return;

  // Zoom works in both modes.
  if (event.key === '+' || event.key === '=') {
    zoomBy(ZOOM_STEP);
    return;
  }
  if (event.key === '-' || event.key === '_') {
    zoomBy(1 / ZOOM_STEP);
    return;
  }
  if (event.key === '0') {
    setZoom(0, { fit: true });
    return;
  }
  if (event.key === 'e' || event.key === 'E') {
    setMode(state.mode === 'edit' ? 'run' : 'edit');
    return;
  }
  if (state.mode === 'run') return;

  if ((event.ctrlKey || event.metaKey) && (event.key === 'a' || event.key === 'A')) {
    event.preventDefault();
    state.tool = 'select';
    ui.board.dataset.tool = 'select';
    state.selection = new Set(state.tiles.map((t) => t.id));
    render();
    setStatus(tr('lay.nSelected', { n: state.selection.size }));
  } else if (ARROWS[event.key] && state.selection.size > 0) {
    event.preventDefault();
    nudge(...ARROWS[event.key]);
  } else if (event.key === 'r' || event.key === 'R') {
    rotate();
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    if (state.selection.size > 0) {
      event.preventDefault();
      removeTiles([...state.selection]);
      render();
    }
  } else if (event.key === 'Escape') {
    state.selection.clear();
    setTool('select');
  }
});

/* ---------- Startup ---------- */

window.addEventListener('hashchange', () => {
  if (['#edit', '#run'].includes(location.hash)) setMode(location.hash.slice(1));
});

const init = async () => {
  try {
    const response = await fetch('/api/layout');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Load failed.');
    state.tiles = data.tiles; // grid size follows the pane and the zoom
  } catch (error) {
    setStatus(tr('lay.loadFailed', { msg: error.message }), 'error');
  }
  ui.board.dataset.tool = state.tool;

  const savedZoom = storage.get(ZOOM_KEY);
  state.zoomFit = !savedZoom || savedZoom === 'fit';
  if (!state.zoomFit) state.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number(savedZoom) || CELL_PX));

  // URL hash (#edit / #run) wins; otherwise the last used mode; otherwise run mode
  // when a layout already exists.
  const hashMode = ['#edit', '#run'].includes(location.hash) ? location.hash.slice(1) : null;
  setMode(hashMode || storage.get(MODE_KEY) || (state.tiles.length > 0 ? 'run' : 'edit'));

  const issues = computeIssues();
  if (issues.conflicts.length > 0) {
    state.issuesOpen = true;
    render();
    if (state.zoomFit) setZoom(0, { fit: true });
    setStatus(tr('lay.dupOnLoad'), 'error');
  }
};

// Language switched (here or in another window): redraw texts built by script.
window.addEventListener('languagechange', () => {
  state.propsFor = null;
  render();
  if (state.mode === 'run') setStatus(tr('lay.runHint'));
  else setTool(state.tool);
});

init();

setInterval(() => {
  if (document.visibilityState === 'visible') pollLive();
}, 1000);
