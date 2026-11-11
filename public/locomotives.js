/* global I18n */
// Locomotives page: the list of locomotives with name, decoder address and max speed.
// Add, edit and remove; every change is saved right away. The driving state (speed,
// direction, functions, light) belongs to the throttle and is kept by the server.
(() => {
const tr = (key, vars) => I18n.t(key, vars);
const $ = (id) => document.getElementById(id);

const MAX_SPEED = 126;
const MAX_DECODER = 10239;

const ui = {
  rows: $('locoRows'),
  add: $('addLoco'),
  status: $('statusLine'),
  saveState: $('saveState')
};

const state = {
  controllers: [],
  activeControllerId: null,
  confirmRemove: null // id waiting for the second click
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

// crypto.randomUUID is unavailable on plain-http LAN pages, so build our own id.
const newId = () => `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/* ---------- Saving ---------- */

// Every change goes to the server for that one locomotive only (by its id), right away.
// So a second window or an older page can never overwrite the other locomotives.
let pending = 0;
const request = async (url, options, message) => {
  pending += 1;
  ui.saveState.textContent = tr('common.saving');
  try {
    const data = await api(url, options);
    if (message) setStatus(message, 'ok');
    return data;
  } catch (error) {
    setStatus(tr('locos.saveFailed', { msg: error.message }), 'error');
    // The server's list is the truth: show it again.
    load({ force: true });
    return null;
  } finally {
    pending -= 1;
    ui.saveState.textContent = pending > 0 ? tr('common.saving') : tr('common.saved');
  }
};

// One field of one locomotive (name, decoderId or maxSpeed).
const saveField = async (c, field, value) => {
  const data = await request(
    `/api/controllers/${encodeURIComponent(c.id)}`,
    { method: 'PATCH', body: JSON.stringify({ [field]: value }) },
    tr('locos.saved', { name: c.name })
  );
  if (data && data.controller) {
    const mine = state.controllers.find((x) => x.id === data.controller.id);
    if (mine) Object.assign(mine, data.controller);
    renderWarnings();
  }
};

// The panel or the page closes: a value still being typed is saved by its change event.
const flushSave = () => {
  const active = document.activeElement;
  if (active && active !== document.body && typeof active.blur === 'function') active.blur();
};
window.flushPendingSave = flushSave;
window.addEventListener('pagehide', flushSave);

/* ---------- Rendering ---------- */

const duplicateAddresses = () => {
  const counts = new Map();
  state.controllers.forEach((c) => counts.set(c.decoderId, (counts.get(c.decoderId) || 0) + 1));
  return new Set([...counts].filter(([, n]) => n > 1).map(([id]) => id));
};

// Two locomotives on one decoder address would both move: mark them.
const renderWarnings = () => {
  const dupes = duplicateAddresses();
  ui.rows.querySelectorAll('[data-id]').forEach((row) => {
    const c = state.controllers.find((x) => x.id === row.dataset.id);
    const dup = Boolean(c && dupes.has(c.decoderId));
    row.querySelector('.loco-decoder input').classList.toggle('invalid', dup);
    row.querySelector('.loco-warning').textContent = dup ? tr('locos.duplicate', { address: c.decoderId }) : '';
  });
};

const numberInput = ({ value, min, max, label, onChange }) => {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = String(min);
  input.max = String(max);
  input.inputMode = 'numeric';
  input.value = value;
  input.setAttribute('aria-label', label);
  input.addEventListener('change', () => {
    const n = Number(input.value);
    if (!Number.isInteger(n) || n < min || n > max) {
      setStatus(tr('locos.range', { label, min, max }), 'error');
      input.value = value;
      return;
    }
    onChange(n);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') input.blur();
  });
  return input;
};

const renderRow = (c) => {
  const row = document.createElement('div');
  row.className = 'loco-row';
  row.setAttribute('role', 'row');
  row.dataset.id = c.id;

  const nameCell = document.createElement('span');
  nameCell.className = 'loco-name';
  nameCell.setAttribute('role', 'cell');
  const name = document.createElement('input');
  name.type = 'text';
  name.maxLength = 40;
  name.value = c.name;
  name.setAttribute('aria-label', tr('locos.name'));
  name.addEventListener('change', () => {
    const text = name.value.trim() || tr('ctl.newLoco', { n: c.decoderId });
    name.value = text;
    if (text === c.name) return;
    c.name = text;
    saveField(c, 'name', text);
  });
  name.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') name.blur();
  });
  nameCell.append(name);

  const decoderCell = document.createElement('span');
  decoderCell.className = 'loco-decoder';
  decoderCell.setAttribute('role', 'cell');
  decoderCell.append(
    numberInput({
      value: c.decoderId,
      min: 1,
      max: MAX_DECODER,
      label: tr('locos.decoder'),
      onChange: (n) => {
        c.decoderId = n;
        renderWarnings();
        saveField(c, 'decoderId', n);
      }
    })
  );
  const warning = document.createElement('small');
  warning.className = 'loco-warning';
  decoderCell.append(warning);

  const maxCell = document.createElement('span');
  maxCell.className = 'loco-max';
  maxCell.setAttribute('role', 'cell');
  const of = document.createElement('span');
  of.className = 'loco-max-of';
  const percent = (n) => tr('locos.ofMax', { max: MAX_SPEED, pct: Math.round((n / MAX_SPEED) * 100) });
  of.textContent = percent(c.maxSpeed);
  maxCell.append(
    numberInput({
      value: c.maxSpeed,
      min: 1,
      max: MAX_SPEED,
      label: tr('locos.maxSpeed'),
      onChange: (n) => {
        c.maxSpeed = n;
        of.textContent = percent(n);
        saveField(c, 'maxSpeed', n);
      }
    }),
    of
  );

  const removeCell = document.createElement('span');
  removeCell.className = 'loco-remove';
  removeCell.setAttribute('role', 'cell');
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'ghost small danger-text';
  const confirming = state.confirmRemove === c.id;
  remove.textContent = confirming ? tr('ctl.deleteConfirm') : tr('locos.remove');
  remove.disabled = state.controllers.length <= 1;
  if (remove.disabled) remove.title = tr('locos.keepOne');
  remove.addEventListener('click', () => removeLoco(c));
  removeCell.append(remove);

  row.append(nameCell, decoderCell, maxCell, removeCell);
  return row;
};

const render = () => {
  ui.rows.replaceChildren(...state.controllers.map(renderRow));
  renderWarnings();
};

/* ---------- Actions ---------- */

let confirmTimer = null;
const removeLoco = (c) => {
  if (state.controllers.length <= 1) return;
  if (state.confirmRemove !== c.id) {
    state.confirmRemove = c.id;
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => {
      state.confirmRemove = null;
      render();
    }, 3000);
    render();
    return;
  }
  state.confirmRemove = null;
  state.controllers = state.controllers.filter((x) => x.id !== c.id);
  render();
  request(`/api/controllers/${encodeURIComponent(c.id)}`, { method: 'DELETE' }, tr('ctl.deleted', { name: c.name })).then((data) => {
    if (data) take(data);
  });
};

ui.add.addEventListener('click', () => {
  const used = new Set(state.controllers.map((c) => c.decoderId));
  let decoderId = 3;
  while (used.has(decoderId)) decoderId += 1;
  const controller = {
    id: newId(),
    name: tr('ctl.newLoco', { n: state.controllers.length + 1 }),
    decoderId,
    maxSpeed: MAX_SPEED
  };
  state.controllers.push(controller);
  render();
  request('/api/controllers', { method: 'POST', body: JSON.stringify(controller) }, tr('locos.added', { name: controller.name })).then((data) => {
    if (data) take(data);
  });
  const input = ui.rows.querySelector(`[data-id="${controller.id}"] .loco-name input`);
  if (input) {
    input.focus();
    input.select();
  }
});

/* ---------- Loading ---------- */

// Takes the server's list. The objects of rows on screen are kept (their fields edit
// them); the rows are drawn again only when locomotives or values changed.
const take = (data) => {
  const byId = new Map(state.controllers.map((c) => [c.id, c]));
  const shown = JSON.stringify(state.controllers.map(({ id, name, decoderId, maxSpeed }) => [id, name, decoderId, maxSpeed]));
  state.controllers = data.controllers.map((next) => Object.assign(byId.get(next.id) || {}, next));
  state.activeControllerId = data.activeControllerId;
  const now = JSON.stringify(state.controllers.map(({ id, name, decoderId, maxSpeed }) => [id, name, decoderId, maxSpeed]));
  return now !== shown;
};

// Changes from other windows or browsers show up here too, but never while a field is
// being edited or a change is on its way.
const editing = () => {
  const active = document.activeElement;
  return Boolean(active && ui.rows.contains(active) && active.matches('input'));
};
const load = async ({ force = false } = {}) => {
  if (!force && (pending > 0 || editing() || state.confirmRemove)) return;
  try {
    const data = await api('/api/controllers');
    if (!force && (pending > 0 || editing())) return;
    if (take(data) || force) render();
  } catch (error) {
    setStatus(tr('ctl.loadFailed', { msg: error.message }), 'error');
  }
};

/* ---------- Startup ---------- */

const REFRESH_MS = 3000;
const init = async () => {
  await load({ force: true });
  setInterval(() => {
    if (document.visibilityState === 'visible') load();
  }, REFRESH_MS);
  window.addEventListener('focus', () => load());
};

window.addEventListener('languagechange', render);

init();
})();
