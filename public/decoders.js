/* global TrackCatalog, I18n */
// Decoder test page: switch any accessory address by hand to find out which turnout,
// signal or uncoupler it belongs to, and keep a note per address.
(() => {
const tr = (key, vars) => I18n.t(key, vars);
const $ = (id) => document.getElementById(id);

const RANGE_KEY = 'birdrail.decoderRange';
const MAX_ROWS = 256;
const MAX_ADDRESS = { P50X: 2047, P50: 256 };

const ui = {
  form: $('rangeForm'),
  from: $('rangeFrom'),
  to: $('rangeTo'),
  onlyNoted: $('onlyNoted'),
  rows: $('decoderRows'),
  status: $('statusLine'),
  chip: $('interfaceState'),
  chipText: $('interfaceText')
};

const state = {
  from: 1,
  to: 32,
  onlyNoted: false,
  protocol: 'P50X',
  connected: false,
  uses: new Map(), // address -> [{ tile, slot }]
  notes: {}, // address -> text
  last: {} // address -> { color, ok }
};

const storage = {
  get() {
    try {
      return JSON.parse(localStorage.getItem(RANGE_KEY));
    } catch (_error) {
      return null;
    }
  },
  set(value) {
    try {
      localStorage.setItem(RANGE_KEY, JSON.stringify(value));
    } catch (_error) {
      // Not remembered in this browser.
    }
  }
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

const maxAddress = () => MAX_ADDRESS[state.protocol] || MAX_ADDRESS.P50X;

/* ---------- Data ---------- */

const loadLayout = async () => {
  const layout = await api('/api/layout');
  state.uses = new Map();
  layout.tiles.forEach((tile) => {
    if (TrackCatalog.addressSpace(tile.type) !== 'accessory') return;
    (tile.addresses || []).forEach((address, slot) => {
      if (!address) return;
      if (!state.uses.has(address)) state.uses.set(address, []);
      state.uses.get(address).push({ tile, slot });
    });
  });
};

const loadStatus = async () => {
  try {
    const { serial } = await api('/api/status');
    state.protocol = serial.protocol === 'P50' ? 'P50' : 'P50X';
    state.connected = Boolean(serial.connected);
    ui.chipText.textContent = state.connected ? `${serial.port} · ${serial.protocol}` : tr('ctl.offline');
  } catch (_error) {
    state.connected = false;
    ui.chipText.textContent = tr('ctl.offline');
  }
  ui.chip.classList.toggle('online', state.connected);
  ui.chip.classList.toggle('offline', !state.connected);
  ui.from.max = maxAddress();
  ui.to.max = maxAddress();
};

/* ---------- Rendering ---------- */

const useText = ({ tile, slot }) => {
  const label = I18n.label(tile.type);
  const where = tr('lay.where', { x: tile.x + 1, y: tile.y + 1 });
  const slots = TrackCatalog.addressSlots(tile.type);
  const slotText = slots.length > 1 ? ` · ${I18n.addressLabel(tile.type, slot)}` : '';
  return `${label} · ${where}${slotText}`;
};

const addresses = () => {
  const list = [];
  for (let a = state.from; a <= state.to; a += 1) {
    if (!state.onlyNoted || state.notes[a] || state.uses.has(a)) list.push(a);
  }
  return list;
};

const switchButton = (address, color) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `ghost small dec-switch ${color}`;
  button.dataset.address = address;
  button.dataset.color = color;
  button.textContent = tr(`dec.${color}`);
  button.title = tr(`dec.${color}Title`);
  const last = state.last[address];
  if (last && last.color === color) button.classList.add(last.ok ? 'sent' : 'failed');
  return button;
};

const renderRow = (address) => {
  const row = document.createElement('div');
  row.className = 'decoder-row';
  row.setAttribute('role', 'row');
  row.dataset.address = address;

  const addr = document.createElement('span');
  addr.className = 'dec-address';
  addr.setAttribute('role', 'cell');
  addr.textContent = address;

  const buttons = document.createElement('span');
  buttons.className = 'dec-buttons';
  buttons.setAttribute('role', 'cell');
  buttons.append(switchButton(address, 'red'), switchButton(address, 'green'));

  const uses = document.createElement('span');
  uses.className = 'dec-uses';
  uses.setAttribute('role', 'cell');
  const list = state.uses.get(address) || [];
  if (list.length === 0) {
    uses.textContent = '–';
    uses.classList.add('muted');
  } else {
    list.forEach((use) => {
      const chip = document.createElement('span');
      chip.className = 'dec-use';
      chip.textContent = useText(use);
      uses.append(chip);
    });
    if (list.length > 1) uses.classList.add('conflict');
  }

  const noteCell = document.createElement('span');
  noteCell.className = 'dec-note';
  noteCell.setAttribute('role', 'cell');
  const note = document.createElement('input');
  note.type = 'text';
  note.maxLength = 60;
  note.value = state.notes[address] || '';
  note.dataset.address = address;
  note.placeholder = tr('dec.notePlaceholder');
  note.setAttribute('aria-label', tr('dec.noteFor', { address }));
  noteCell.append(note);

  row.append(addr, buttons, uses, noteCell);
  return row;
};

const render = () => {
  const list = addresses();
  if (list.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = tr('dec.empty');
    ui.rows.replaceChildren(empty);
    return;
  }
  ui.rows.replaceChildren(...list.map(renderRow));
};

/* ---------- Range ---------- */

const applyRange = (from, to) => {
  const max = maxAddress();
  let a = Math.max(1, Math.min(max, Math.round(Number(from) || 1)));
  let b = Math.max(1, Math.min(max, Math.round(Number(to) || a)));
  if (b < a) [a, b] = [b, a];
  if (b - a + 1 > MAX_ROWS) {
    b = a + MAX_ROWS - 1;
    setStatus(tr('dec.limited', { n: MAX_ROWS }));
  }
  state.from = a;
  state.to = b;
  ui.from.value = a;
  ui.to.value = b;
  storage.set({ from: a, to: b, onlyNoted: state.onlyNoted });
};

ui.form.addEventListener('submit', (event) => {
  event.preventDefault();
  setStatus('');
  applyRange(ui.from.value, ui.to.value);
  render();
});

ui.onlyNoted.addEventListener('change', () => {
  state.onlyNoted = ui.onlyNoted.checked;
  storage.set({ from: state.from, to: state.to, onlyNoted: state.onlyNoted });
  render();
});

/* ---------- Switching ---------- */

ui.rows.addEventListener('click', async (event) => {
  const button = event.target.closest('.dec-switch');
  if (!button) return;
  const address = Number(button.dataset.address);
  const { color } = button.dataset;
  const row = button.closest('.decoder-row');
  row.querySelectorAll('.dec-switch').forEach((b) => b.classList.remove('sent', 'failed'));
  button.classList.add('busy');
  setStatus(tr('dec.sending', { address, color: tr(`dec.${color}`) }));
  try {
    const data = await api('/api/accessory/test', {
      method: 'POST',
      body: JSON.stringify({ address, color })
    });
    if (!data.ok) throw new Error(data.error || tr('ctl.sendFailed'));
    state.last[address] = { color, ok: true };
    button.classList.add('sent');
    setStatus(tr('dec.sent', { address, color: tr(`dec.${color}`) }), 'ok');
  } catch (error) {
    state.last[address] = { color, ok: false };
    button.classList.add('failed');
    setStatus(tr('dec.failed', { address, msg: error.message }), 'error');
  } finally {
    button.classList.remove('busy');
  }
});

/* ---------- Notes ---------- */

const saveNote = async (input) => {
  const address = Number(input.dataset.address);
  const note = input.value.trim();
  if ((state.notes[address] || '') === note) return;
  try {
    state.notes = await api('/api/decoders/notes', {
      method: 'PUT',
      body: JSON.stringify({ address, note })
    });
    input.classList.add('saved');
    setTimeout(() => input.classList.remove('saved'), 1200);
    setStatus(tr(note ? 'dec.noteSaved' : 'dec.noteRemoved', { address }), 'ok');
  } catch (error) {
    setStatus(error.message, 'error');
  }
};

ui.rows.addEventListener('change', (event) => {
  if (event.target.matches('.dec-note input')) saveNote(event.target);
});

ui.rows.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.target.matches('.dec-note input')) event.target.blur();
});

/* ---------- Startup ---------- */

const init = async () => {
  await loadStatus();
  try {
    const [notes] = await Promise.all([api('/api/decoders/notes'), loadLayout()]);
    state.notes = notes;
  } catch (error) {
    setStatus(error.message, 'error');
  }

  const saved = storage.get();
  const highest = Math.max(0, ...state.uses.keys(), ...Object.keys(state.notes).map(Number));
  state.onlyNoted = Boolean(saved && saved.onlyNoted);
  ui.onlyNoted.checked = state.onlyNoted;
  if (saved && saved.from && saved.to) applyRange(saved.from, saved.to);
  else applyRange(1, Math.max(32, Math.ceil(highest / 16) * 16));
  render();
};

window.addEventListener('languagechange', render);
setInterval(() => {
  if (document.visibilityState === 'visible') loadStatus();
}, 5000);

init();
})();
