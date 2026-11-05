/* global I18n */
// Blocks page: the blocks of the layout (found from block-start contacts, numbered),
// and Fahrstraßen: sequences of blocks for automated operation, with start / stop.
(() => {
const tr = (key, vars) => I18n.t(key, vars);
const $ = (id) => document.getElementById(id);

const POLL_MS = 1000;

const ui = {
  blockRows: $('blockRows'),
  routeList: $('routeList'),
  addRoute: $('addRoute'),
  status: $('statusLine'),
  saveState: $('saveState')
};

const state = {
  blocks: [],
  routes: [], // edited here, saved to the server
  runs: {},
  routesKey: null, // routes as last rendered
  confirmDelete: null
};

const setStatus = (text, kind = '') => {
  ui.status.textContent = text;
  ui.status.classList.toggle('error', kind === 'error');
  ui.status.classList.toggle('ok', kind === 'ok');
};

const api = async (url, options = {}) => {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
};

const newId = () => `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const blockById = (id) => state.blocks.find((b) => b.id === id);
const label = (id) => {
  const block = blockById(id);
  return block ? `B${block.number}` : '?';
};
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/* ---------- Blocks ---------- */

const renderBlocks = () => {
  if (state.blocks.length === 0) {
    ui.blockRows.replaceChildren(el('p', 'hint block-empty', tr('blocks.none')));
    return;
  }
  ui.blockRows.replaceChildren(
    ...state.blocks.map((b) => {
      const row = el('div', 'block-row');
      row.setAttribute('role', 'row');
      const number = el('strong', 'block-number', `B${b.number}`);
      const arrow = b.direction === 'left' ? '←' : '→';
      const start = el('span', '', `${arrow} ${tr('blk.where', { contact: b.contact || '?', where: tr('lay.where', { x: b.x + 1, y: b.y + 1 }) })}`);
      const tracks = el('span', 'block-tracks', String(b.tracks));
      const next = el('span', 'block-next', b.next.length ? b.next.map(label).join(', ') : '–');
      const status = el('span', `block-status ${b.occupied ? 'occupied' : 'free'}`);
      status.textContent = b.occupied ? (b.loco ? tr('blocks.occupiedBy', { loco: b.loco }) : tr('blocks.occupied')) : tr('blk.isFree');
      [number, start, tracks, next, status].forEach((cell) => cell.setAttribute('role', 'cell'));
      row.append(number, start, tracks, next, status);
      return row;
    })
  );
};

/* ---------- Routes: editing ---------- */

let saveTimer = null;
const saveRoutes = (message) => {
  clearTimeout(saveTimer);
  ui.saveState.textContent = tr('common.saving');
  saveTimer = setTimeout(async () => {
    try {
      const data = await api('/api/routes', { method: 'PUT', body: JSON.stringify({ routes: state.routes }) });
      state.routes = data.routes;
      ui.saveState.textContent = tr('common.saved');
      if (message) setStatus(message, 'ok');
      saveTimer = null;
      await load(true);
    } catch (error) {
      saveTimer = null;
      ui.saveState.textContent = '';
      setStatus(tr('routes.saveFailed', { msg: error.message }), 'error');
    }
  }, 300);
};

// The page reloads the routes every second, so a rendered control may hold an older copy
// of its route: always change the current one (looked up by id). `changes` is an object
// or a function of the current route.
const change = (route, changes, message) => {
  const current = state.routes.find((r) => r.id === route.id);
  if (!current) return;
  Object.assign(current, typeof changes === 'function' ? changes(current) : changes);
  renderRoutes(true);
  saveRoutes(message);
};

const runText = (run) => {
  if (!run) return tr('routes.notRunning');
  const vars = { loco: run.loco, from: label(run.current), to: label(run.next) };
  return tr(`routes.code.${run.code}`, vars);
};

// Locomotives that can start this route: the ones in one of its blocks.
const locosInRoute = (route) =>
  [...new Set(route.blocks.map((id) => blockById(id)).filter((b) => b && b.loco).map((b) => b.loco))];

const renderRunControls = (route, box) => {
  const run = state.runs[route.id];
  box.replaceChildren();
  const status = el('span', `route-status ${run ? run.code : 'idle'}`, runText(run));
  if (run && !run.ended) {
    const stop = el('button', 'ghost small danger-text', tr('routes.stop'));
    stop.type = 'button';
    stop.addEventListener('click', () => stopRun(route));
    box.append(stop, status);
    return;
  }
  const locos = locosInRoute(route);
  const select = el('select', 'route-loco');
  select.setAttribute('aria-label', tr('routes.loco'));
  if (locos.length === 0) select.append(el('option', '', tr('routes.noLoco')));
  locos.forEach((name) => {
    const option = el('option', '', name);
    option.value = name;
    select.append(option);
  });
  select.disabled = locos.length === 0;
  const start = el('button', 'primary small', tr('routes.start'));
  start.type = 'button';
  start.disabled = locos.length === 0 || route.blocks.length < 2;
  start.addEventListener('click', () => startRun(route, select.value));
  box.append(select, start);
  if (run) {
    const clear = el('button', 'ghost small', tr('routes.clear'));
    clear.type = 'button';
    clear.addEventListener('click', () => stopRun(route));
    box.append(clear);
  }
  box.append(status);
};

const renderRoute = (route) => {
  const card = el('div', 'route');
  card.dataset.id = route.id;

  // Head: name, loop, delete
  const head = el('div', 'route-head');
  const name = el('input', 'route-name');
  name.type = 'text';
  name.maxLength = 40;
  name.value = route.name;
  name.setAttribute('aria-label', tr('routes.name'));
  name.addEventListener('change', () =>
    change(route, (r) => ({ name: name.value.trim() || r.name }), tr('routes.saved', { name: name.value.trim() || route.name }))
  );
  name.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') name.blur();
  });
  const loop = el('label', 'route-loop');
  const loopBox = el('input');
  loopBox.type = 'checkbox';
  loopBox.checked = route.loop;
  loopBox.addEventListener('change', () => change(route, { loop: loopBox.checked }, tr('routes.saved', { name: route.name })));
  loop.append(loopBox, el('span', '', tr('routes.loop')));
  const del = el('button', 'ghost small danger-text', state.confirmDelete === route.id ? tr('ctl.deleteConfirm') : tr('routes.delete'));
  del.type = 'button';
  del.addEventListener('click', () => deleteRoute(route));
  head.append(name, loop, del);

  // Sequence of blocks
  const seq = el('div', 'route-seq');
  route.blocks.forEach((id, i) => {
    if (i > 0) seq.append(el('span', 'route-arrow', '→'));
    const chip = el('span', `route-chip${blockById(id) ? '' : ' missing'}`);
    const left = el('button', 'chip-btn', '◀');
    left.type = 'button';
    left.title = tr('routes.moveLeft');
    left.disabled = i === 0;
    left.addEventListener('click', () =>
      change(route, (r) => {
        const blocks = [...r.blocks];
        [blocks[i - 1], blocks[i]] = [blocks[i], blocks[i - 1]];
        return { blocks };
      })
    );
    const right = el('button', 'chip-btn', '▶');
    right.type = 'button';
    right.title = tr('routes.moveRight');
    right.disabled = i === route.blocks.length - 1;
    right.addEventListener('click', () =>
      change(route, (r) => {
        const blocks = [...r.blocks];
        [blocks[i + 1], blocks[i]] = [blocks[i], blocks[i + 1]];
        return { blocks };
      })
    );
    const remove = el('button', 'chip-btn', '×');
    remove.type = 'button';
    remove.title = tr('routes.removeBlock');
    remove.addEventListener('click', () => change(route, (r) => ({ blocks: r.blocks.filter((_b, j) => j !== i) })));
    chip.append(left, el('strong', '', label(id)), right, remove);
    seq.append(chip);
  });
  if (route.loop && route.blocks.length > 1) seq.append(el('span', 'route-arrow', `→ ${label(route.blocks[0])} ↺`));

  const add = el('select', 'route-add');
  add.setAttribute('aria-label', tr('routes.addBlock'));
  const placeholder = el('option', '', tr('routes.addBlock'));
  placeholder.value = '';
  add.append(placeholder);
  state.blocks.forEach((b) => {
    const option = el('option', '', `B${b.number}`);
    option.value = b.id;
    add.append(option);
  });
  add.addEventListener('change', () => {
    if (add.value) change(route, (r) => ({ blocks: [...r.blocks, add.value] }), tr('routes.blockAdded', { block: label(add.value) }));
  });
  seq.append(add);

  // Track connections between consecutive blocks
  const checks = el('div', 'route-checks');
  const links = route.links || [];
  const broken = links.filter((l) => !l.connected);
  if (route.blocks.length < 2) checks.append(el('span', 'route-check warn', tr('routes.needTwo')));
  else if (broken.length) broken.forEach((l) => checks.append(el('span', 'route-check warn', tr('routes.noConnection', { from: label(l.from), to: label(l.to) }))));
  else if (links.length) checks.append(el('span', 'route-check ok', tr('routes.connected')));

  const run = el('div', 'route-run');
  renderRunControls(route, run);

  card.append(head, seq, checks, run);
  return card;
};

// Rebuilt only when the routes changed (not while typing), run controls every poll.
const renderRoutes = (force = false) => {
  const key = JSON.stringify([state.routes, state.blocks.map((b) => [b.id, b.number])]);
  const editing = ui.routeList.contains(document.activeElement) && document.activeElement.matches('input[type="text"]');
  if (force || (key !== state.routesKey && !editing)) {
    state.routesKey = key;
    ui.routeList.replaceChildren(
      ...(state.routes.length ? state.routes.map(renderRoute) : [el('p', 'hint block-empty', tr('routes.none'))])
    );
    return;
  }
  ui.routeList.querySelectorAll('.route').forEach((card) => {
    const route = state.routes.find((r) => r.id === card.dataset.id);
    const box = card.querySelector('.route-run');
    if (route && box && !box.contains(document.activeElement)) renderRunControls(route, box);
  });
};

let confirmTimer = null;
const deleteRoute = (route) => {
  if (state.confirmDelete !== route.id) {
    state.confirmDelete = route.id;
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => {
      state.confirmDelete = null;
      renderRoutes(true);
    }, 3000);
    renderRoutes(true);
    return;
  }
  state.confirmDelete = null;
  state.routes = state.routes.filter((r) => r.id !== route.id);
  renderRoutes(true);
  saveRoutes(tr('routes.deleted', { name: route.name }));
};

ui.addRoute.addEventListener('click', () => {
  const route = { id: newId(), name: tr('routes.newName', { n: state.routes.length + 1 }), blocks: [], loop: false };
  state.routes.push(route);
  renderRoutes(true);
  saveRoutes(tr('routes.added', { name: route.name }));
});

/* ---------- Routes: running ---------- */

const startRun = async (route, loco) => {
  try {
    const data = await api(`/api/routes/${encodeURIComponent(route.id)}/start`, { method: 'POST', body: JSON.stringify({ loco }) });
    state.runs = data.runs;
    renderRoutes();
    setStatus(tr('routes.started', { name: route.name, loco }), 'ok');
  } catch (error) {
    setStatus(error.message, 'error');
  }
};

const stopRun = async (route) => {
  try {
    const data = await api(`/api/routes/${encodeURIComponent(route.id)}/stop`, { method: 'POST' });
    state.runs = data.runs;
    renderRoutes();
    setStatus(tr('routes.stopped', { name: route.name }), 'ok');
  } catch (error) {
    setStatus(error.message, 'error');
  }
};

/* ---------- Loading ---------- */

const load = async (takeRoutes = false) => {
  try {
    const data = await api('/api/blocklist');
    state.blocks = data.blocks;
    state.runs = data.runs;
    // Routes from the server (with their connection checks), unless an edit is being saved.
    if (takeRoutes || !saveTimer) state.routes = data.routes;
    renderBlocks();
    renderRoutes();
  } catch (error) {
    setStatus(error.message, 'error');
  }
};

window.addEventListener('languagechange', () => {
  renderBlocks();
  renderRoutes(true);
});

load(true);
setInterval(() => {
  if (document.visibilityState === 'visible') load();
}, POLL_MS);
})();
