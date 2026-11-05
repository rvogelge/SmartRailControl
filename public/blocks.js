/* global I18n */
// Blocks page: the blocks of the layout (found from block-start contacts, numbered).
// Hovering a block highlights its tracks in the layout window.
(() => {
const tr = (key, vars) => I18n.t(key, vars);
const $ = (id) => document.getElementById(id);

const POLL_MS = 1000;

const ui = {
  blockRows: $('blockRows'),
  status: $('statusLine')
};

const state = {
  blocks: []
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

// Hovering a block highlights its tracks in the layout window.
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('smartrailcontrol') : null;
const highlight = (blocks) => {
  if (channel) channel.postMessage({ type: 'highlightBlocks', blocks });
};
// The innermost hovered element with blocks wins.
const highlightOn = (node, blocks) => {
  node.dataset.highlight = JSON.stringify(blocks);
};
let lastHighlight = '[]';
document.addEventListener('mouseover', (event) => {
  const node = event.target.closest('[data-highlight]');
  const key = node ? node.dataset.highlight : '[]';
  if (key === lastHighlight) return;
  lastHighlight = key;
  highlight(JSON.parse(key));
});
document.documentElement.addEventListener('mouseleave', () => {
  lastHighlight = '[]';
  highlight([]);
});
window.addEventListener('pagehide', () => highlight([]));

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
      highlightOn(row, [b.id]);
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

/* ---------- Loading ---------- */

const load = async () => {
  try {
    const data = await api('/api/blocklist');
    if (JSON.stringify(data.blocks) === JSON.stringify(state.blocks)) return;
    state.blocks = data.blocks;
    renderBlocks();
  } catch (error) {
    setStatus(error.message, 'error');
  }
};

window.addEventListener('languagechange', renderBlocks);

load();
setInterval(() => {
  if (document.visibilityState === 'visible') load();
}, POLL_MS);
})();
