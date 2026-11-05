/* global t */
// Locomotive control window: shown over the track layout in run mode.
// Locomotives are added and edited on the Locomotives page; this window only drives
// them. It saves the driving state of the selected locomotive (speed, direction,
// functions, light) and picks up changes to the list from the server.
(() => {
const $ = (id) => document.getElementById(id);

const FUNCTION_COUNT = 4;
const MAX_SPEED = 126;
const POSITION_KEY = 'smartrailcontrol.throttlePosition';
const REFRESH_MS = 5000;

const el = {
  window: $('throttleWindow'),
  handle: $('throttleHandle'),
  close: $('throttleClose'),
  address: $('throttleAddress'),
  topbar: document.querySelector('.topbar'),
  open: $('throttleOpen'),
  select: $('locoSelect'),
  speed: $('speed'),
  speedValue: $('speedValue'),
  directionBadge: $('directionBadge'),
  directions: $('directionSwitch').querySelectorAll('[data-direction]'),
  functions: $('functionButtons').querySelectorAll('[data-function]'),
  light: $('lightButton'),
  stop: $('stopButton'),
  emergency: $('emergencyButton'),
  response: $('responseBox')
};

const state = {
  controllers: [],
  activeId: null
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
      // Not remembered in this browser.
    }
  }
};

const normalize = (c) => {
  const maxSpeed = Math.max(1, Math.min(MAX_SPEED, Number(c.maxSpeed) || MAX_SPEED));
  return {
    ...c,
    maxSpeed,
    speed: Math.max(0, Math.min(maxSpeed, Number(c.speed) || 0)),
    light: Boolean(c.light),
    functions: Array.from({ length: FUNCTION_COUNT }, (_v, i) => Boolean(c.functions && c.functions[i]))
  };
};

const active = () => state.controllers.find((c) => c.id === state.activeId) || state.controllers[0];

// Speed as a percentage of the locomotive's max speed.
const percent = (c) => Math.round((c.speed / c.maxSpeed) * 100);

const setMessage = (text, kind = '') => {
  el.response.textContent = text;
  el.response.classList.toggle('error', kind === 'error');
  el.response.classList.toggle('ok', kind === 'ok');
};

const api = async (url, options = {}) => {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status}).`);
  }
  return data;
};

const reportStatus = (status) => {
  if (window.SmartRailControl && window.SmartRailControl.updateStatus) window.SmartRailControl.updateStatus(status);
};

/* ---------- Persistence ---------- */

// Driving state, per locomotive (switching locomotives never loses a pending save).
const saveTimers = new Map();
const saveState = (c) => {
  clearTimeout(saveTimers.get(c.id));
  saveTimers.set(
    c.id,
    setTimeout(async () => {
      saveTimers.delete(c.id);
      try {
        await api(`/api/controllers/${encodeURIComponent(c.id)}/state`, {
          method: 'PUT',
          body: JSON.stringify({ speed: c.speed, direction: c.direction, functions: c.functions, light: c.light })
        });
      } catch (error) {
        setMessage(t('ctl.saveFailed', { msg: error.message }), 'error');
      }
    }, 400)
  );
};

const saveActive = async () => {
  try {
    await api('/api/controllers/active', { method: 'PUT', body: JSON.stringify({ id: state.activeId }) });
  } catch (error) {
    setMessage(t('ctl.saveFailed', { msg: error.message }), 'error');
  }
};

/* ---------- Rendering ---------- */

const renderSelect = () => {
  el.select.replaceChildren(
    ...state.controllers.map((c) => {
      const option = document.createElement('option');
      option.value = c.id;
      option.textContent = c.name;
      option.title = `#${c.decoderId}`;
      return option;
    })
  );
  el.select.value = state.activeId;
  el.address.textContent = active() ? `#${active().decoderId}` : '';
};

const renderSpeed = (c) => {
  el.speed.max = String(c.maxSpeed);
  el.speed.value = c.speed;
  el.speedValue.textContent = `${percent(c)}%`;
  el.speed.style.setProperty('--fill', `${percent(c)}%`);
};

const renderDirection = (c) => {
  el.directions.forEach((button) => {
    button.setAttribute('aria-checked', String(button.dataset.direction === c.direction));
  });
  el.directionBadge.textContent = c.direction === 'reverse' ? t('ctl.reverse') : t('ctl.forward');
};

const renderFunctions = (c) => {
  el.functions.forEach((button) => {
    button.setAttribute('aria-pressed', String(c.functions[Number(button.dataset.function)]));
  });
  el.light.setAttribute('aria-pressed', String(c.light));
};

const render = () => {
  const c = active();
  if (!c) return;
  renderSelect();
  renderSpeed(c);
  renderDirection(c);
  renderFunctions(c);
};

/* ---------- Locomotive commands ---------- */

// Speed, direction and light (F0) go together in one locomotive command.
const sendCommand = async ({ stop = false, emergency = false, message = null } = {}) => {
  const c = active();
  if (!c) return;
  try {
    const data = await api('/api/locomotive/control', {
      method: 'POST',
      body: JSON.stringify({ decoderId: c.decoderId, speed: c.speed, direction: c.direction, light: c.light, stop, emergency })
    });
    reportStatus(data.status);
    if (!data.ok) throw new Error(data.error || t('ctl.sendFailed'));

    const dir = c.direction === 'reverse' ? t('ctl.dirReverse') : t('ctl.dirForward');
    const label = message || (emergency ? t('ctl.emergency') : stop ? t('ctl.stopped') : t('ctl.speedDir', { speed: `${percent(c)}%`, dir }));
    setMessage(label, 'ok');
  } catch (error) {
    setMessage(error.message, 'error');
  }
};

const sendFunctions = async (index) => {
  const c = active();
  try {
    const data = await api('/api/locomotive/functions', {
      method: 'POST',
      body: JSON.stringify({ decoderId: c.decoderId, functions: c.functions })
    });
    reportStatus(data.status);
    if (!data.ok) throw new Error(data.error || t('ctl.sendFailed'));
    setMessage(t(c.functions[index] ? 'ctl.functionOn' : 'ctl.functionOff', { n: index + 1 }), 'ok');
  } catch (error) {
    setMessage(error.message, 'error');
  }
};

// While dragging the slider, send at most one command every 150 ms.
let lastSend = 0;
let pendingSend = null;
const throttledSend = () => {
  const wait = 150 - (Date.now() - lastSend);
  clearTimeout(pendingSend);
  if (wait <= 0) {
    lastSend = Date.now();
    sendCommand();
  } else {
    pendingSend = setTimeout(() => {
      lastSend = Date.now();
      sendCommand();
    }, wait);
  }
};

const updateActive = (changes) => {
  Object.assign(active(), changes);
  saveState(active());
};

el.speed.addEventListener('input', () => {
  updateActive({ speed: Number(el.speed.value) });
  renderSpeed(active());
  throttledSend();
});

el.speed.addEventListener('change', () => {
  clearTimeout(pendingSend);
  lastSend = Date.now();
  sendCommand();
});

el.directions.forEach((button) => {
  button.addEventListener('click', () => {
    if (active().direction === button.dataset.direction) return;
    updateActive({ direction: button.dataset.direction });
    renderDirection(active());
    sendCommand();
  });
});

el.functions.forEach((button) => {
  button.addEventListener('click', () => {
    const index = Number(button.dataset.function);
    const functions = [...active().functions];
    functions[index] = !functions[index];
    updateActive({ functions });
    renderFunctions(active());
    sendFunctions(index);
  });
});

el.light.addEventListener('click', () => {
  updateActive({ light: !active().light });
  renderFunctions(active());
  sendCommand({ message: t(active().light ? 'ctl.lightOn' : 'ctl.lightOff') });
});

const halt = (options) => {
  clearTimeout(pendingSend);
  updateActive({ speed: 0 });
  renderSpeed(active());
  sendCommand(options);
};

el.stop.addEventListener('click', () => halt({ stop: true }));
el.emergency.addEventListener('click', () => halt({ emergency: true }));

/* ---------- Locomotive selection ---------- */

el.select.addEventListener('change', () => {
  state.activeId = el.select.value;
  render();
  saveActive();
  setMessage(t('ctl.selected', { name: active().name }));
});

// Locomotives added, renamed or removed on the Locomotives page (or in another browser):
// take over the list; this window keeps the driving state it has for each locomotive.
const refresh = async () => {
  try {
    const data = await api('/api/controllers');
    const local = new Map(state.controllers.map((c) => [c.id, c]));
    const next = data.controllers.map((c) => {
      const mine = local.get(c.id);
      return normalize(mine ? { ...c, speed: mine.speed, direction: mine.direction, functions: mine.functions, light: mine.light } : c);
    });
    if (JSON.stringify(next) === JSON.stringify(state.controllers)) return;
    state.controllers = next;
    if (!next.some((c) => c.id === state.activeId)) state.activeId = data.activeControllerId;
    render();
  } catch (_error) {
    // Server not reachable: try again later.
  }
};

/* ---------- Window: show, hide, drag ---------- */

const clampPosition = (left, top) => {
  const rect = el.window.getBoundingClientRect();
  const minTop = el.topbar ? el.topbar.getBoundingClientRect().bottom + 8 : 0;
  return {
    left: Math.max(0, Math.min(window.innerWidth - rect.width, left)),
    top: Math.max(minTop, Math.min(window.innerHeight - Math.min(rect.height, 60), top))
  };
};

const placeWindow = (left, top) => {
  const pos = clampPosition(left, top);
  el.window.style.left = `${pos.left}px`;
  el.window.style.top = `${pos.top}px`;
  el.window.style.right = 'auto';
  el.window.style.bottom = 'auto';
  return pos;
};

const restorePosition = () => {
  try {
    const saved = JSON.parse(storage.get(POSITION_KEY));
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) placeWindow(saved.left, saved.top);
  } catch (_error) {
    // No saved position: keep the default corner from the stylesheet.
  }
};

const openWindow = () => {
  el.window.hidden = false;
  if (el.open) el.open.setAttribute('aria-pressed', 'true');
  restorePosition();
};

const closeWindow = () => {
  el.window.hidden = true;
  if (el.open) el.open.setAttribute('aria-pressed', 'false');
};

el.close.addEventListener('click', closeWindow);
if (el.open) el.open.addEventListener('click', () => (el.window.hidden ? openWindow() : closeWindow()));

// The window appears whenever run mode is selected and goes away in edit mode.
window.addEventListener('modechange', (event) => {
  if (event.detail.mode === 'run') openWindow();
  else closeWindow();
});

let drag = null;
el.handle.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || event.target.closest('button')) return;
  const rect = el.window.getBoundingClientRect();
  drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
  el.handle.setPointerCapture(event.pointerId);
  el.window.classList.add('dragging');
});
el.handle.addEventListener('pointermove', (event) => {
  if (drag) placeWindow(event.clientX - drag.dx, event.clientY - drag.dy);
});
const endDrag = () => {
  if (!drag) return;
  drag = null;
  el.window.classList.remove('dragging');
  const rect = el.window.getBoundingClientRect();
  storage.set(POSITION_KEY, JSON.stringify({ left: rect.left, top: rect.top }));
};
el.handle.addEventListener('pointerup', endDrag);
el.handle.addEventListener('pointercancel', endDrag);

window.addEventListener('resize', () => {
  if (!el.window.hidden && el.window.style.left) {
    const rect = el.window.getBoundingClientRect();
    placeWindow(rect.left, rect.top);
  }
});

/* ---------- Startup ---------- */

const init = async () => {
  try {
    const data = await api('/api/controllers');
    state.controllers = data.controllers.map(normalize);
    state.activeId = data.activeControllerId;
  } catch (error) {
    setMessage(t('ctl.loadFailed', { msg: error.message }), 'error');
  }
  render();
  // Run mode may already be active (it is chosen before this script finishes loading).
  if (document.body.dataset.mode === 'run') openWindow();
};

window.addEventListener('languagechange', render);
window.addEventListener('focus', refresh);
setInterval(() => {
  if (document.visibilityState === 'visible') refresh();
}, REFRESH_MS);

init();
})();
