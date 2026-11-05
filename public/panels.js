/* global I18n */
// Panels inside the main window for the secondary pages (Logic rules, Blocks,
// Locomotives, Decoder test): a title bar to drag, ✕ to close, a corner to resize.
// The page itself runs in a frame and hides its own header there (window.js).
// Browsers always show the address bar in pop-up windows; panels have none.
(() => {
const tr = (key, vars) => I18n.t(key, vars);

const PANELS = {
  rules: { path: '/rules.html', title: 'rules.title', width: 1180, height: 820 },
  blocks: { path: '/blocks.html', title: 'blocks.title', width: 1000, height: 700 },
  locos: { path: '/locomotives.html', title: 'locos.title', width: 900, height: 620 },
  decoders: { path: '/decoders.html', title: 'dec.title', width: 1060, height: 760 }
};
const GEOMETRY_KEY = 'smartrailcontrol.panels';
const MARGIN = 8;

const storage = {
  get() {
    try {
      return JSON.parse(localStorage.getItem(GEOMETRY_KEY)) || {};
    } catch (_error) {
      return {};
    }
  },
  set(value) {
    try {
      localStorage.setItem(GEOMETRY_KEY, JSON.stringify(value));
    } catch (_error) {
      // Not remembered in this browser.
    }
  }
};

const open = new Map(); // key -> { panel, frame, title, resizeObserver }

// Top of the usable area: below the top bar.
const minTop = () => {
  const bar = document.querySelector('.topbar');
  return bar ? bar.getBoundingClientRect().bottom + MARGIN : MARGIN;
};

// Keeps the panel inside the window, with its title bar reachable.
const place = (panel, { left, top, width, height }) => {
  const maxWidth = window.innerWidth - 2 * MARGIN;
  const maxHeight = window.innerHeight - minTop() - MARGIN;
  const w = Math.max(320, Math.min(maxWidth, width));
  const h = Math.max(240, Math.min(maxHeight, height));
  panel.style.width = `${w}px`;
  panel.style.height = `${h}px`;
  panel.style.left = `${Math.max(MARGIN, Math.min(window.innerWidth - w - MARGIN, left))}px`;
  panel.style.top = `${Math.max(minTop(), Math.min(window.innerHeight - 48, top))}px`;
};

const remember = (key, panel) => {
  const rect = panel.getBoundingClientRect();
  const all = storage.get();
  all[key] = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  storage.set(all);
};

// The front panel sits above the others (the throttle and the top bar stay above all).
const toFront = (key) => {
  open.forEach((entry, k) => entry.panel.classList.toggle('front', k === key));
};

const close = (key) => {
  const entry = open.get(key);
  if (!entry) return;
  remember(key, entry.panel);
  entry.resizeObserver.disconnect();
  entry.panel.remove();
  open.delete(key);
  // The Blocks page highlights blocks in the layout: clear that when it goes away.
  if (key === 'blocks' && typeof BroadcastChannel === 'function') {
    new BroadcastChannel('smartrailcontrol').postMessage({ type: 'highlightBlocks', blocks: [] });
  }
};

const create = (key) => {
  const def = PANELS[key];
  const panel = document.createElement('section');
  panel.className = 'app-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'false');

  const head = document.createElement('div');
  head.className = 'app-panel-head';
  const title = document.createElement('h2');
  title.textContent = tr(def.title);
  panel.setAttribute('aria-label', title.textContent);
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'icon-button app-panel-close';
  closeButton.textContent = '✕';
  closeButton.setAttribute('aria-label', tr('common.close'));
  closeButton.title = tr('common.close');
  closeButton.addEventListener('click', () => close(key));
  head.append(title, closeButton);

  const frame = document.createElement('iframe');
  frame.className = 'app-panel-frame';
  frame.title = title.textContent;
  frame.src = def.path;
  // Clicks inside the page bring the panel to the front (same origin).
  frame.addEventListener('load', () => {
    try {
      frame.contentWindow.addEventListener('pointerdown', () => toFront(key));
    } catch (_error) {
      // Not reachable: the panel comes to the front from its title bar only.
    }
  });

  panel.append(head, frame);
  panel.addEventListener('pointerdown', () => toFront(key));
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close(key);
    }
  });
  document.body.append(panel);

  // Saved place, else a cascade from the top left of the layout.
  const saved = storage.get()[key];
  const offset = 30 * open.size;
  place(panel, saved || { left: 40 + offset, top: minTop() + 20 + offset, width: def.width, height: def.height });

  // Drag by the title bar.
  let drag = null;
  head.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('button')) return;
    const rect = panel.getBoundingClientRect();
    drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    head.setPointerCapture(event.pointerId);
    panel.classList.add('dragging');
  });
  head.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const rect = panel.getBoundingClientRect();
    place(panel, { left: event.clientX - drag.dx, top: event.clientY - drag.dy, width: rect.width, height: rect.height });
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    panel.classList.remove('dragging');
    remember(key, panel);
  };
  head.addEventListener('pointerup', endDrag);
  head.addEventListener('pointercancel', endDrag);

  // Resized with the corner: remember the size.
  let resizeTimer = null;
  const resizeObserver = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => remember(key, panel), 300);
  });
  resizeObserver.observe(panel);

  open.set(key, { panel, frame, title, resizeObserver });
};

const openPanel = (key) => {
  if (!PANELS[key]) return;
  if (!open.has(key)) create(key);
  toFront(key);
  const entry = open.get(key);
  entry.panel.querySelector('.app-panel-close').focus({ preventScroll: true });
};

// The page in a panel asks to be closed (its Esc key).
window.addEventListener('message', (event) => {
  if (event.origin !== location.origin) return;
  const data = event.data || {};
  if (data.type !== 'closePanel') return;
  open.forEach((entry, key) => {
    if (entry.frame.contentWindow === event.source) close(key);
  });
});

window.addEventListener('resize', () => {
  open.forEach(({ panel }) => {
    const rect = panel.getBoundingClientRect();
    place(panel, { left: rect.left, top: rect.top, width: rect.width, height: rect.height });
  });
});

window.addEventListener('languagechange', () => {
  open.forEach(({ panel, title, frame }, key) => {
    title.textContent = tr(PANELS[key].title);
    panel.setAttribute('aria-label', title.textContent);
    frame.title = title.textContent;
  });
});

window.SmartRailControl = window.SmartRailControl || {};
window.SmartRailControl.openPanel = openPanel;
})();
