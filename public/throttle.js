/* global t */
// Locomotive control window: shown over the track layout in run mode.
(() => {
const $ = (id) => document.getElementById(id);

const FUNCTION_COUNT = 4;
const POSITION_KEY = 'birdrail.throttlePosition';

const el = {
  window: $('throttleWindow'),
  handle: $('throttleHandle'),
  close: $('throttleClose'),
  address: $('throttleAddress'),
  topbar: document.querySelector('.topbar'),
  open: $('throttleOpen'),
  select: $('locoSelect'),
  editToggle: $('locoEditToggle'),
  edit: $('locoEdit'),
  name: $('controllerName'),
  decoderId: $('decoderId'),
  addController: $('addController'),
  deleteController: $('deleteController'),
  speed: $('speed'),
  speedValue: $('speedValue'),
  directionBadge: $('directionBadge'),
  directions: $('directionSwitch').querySelectorAll('[data-direction]'),
  functions: $('functionButtons').querySelectorAll('[data-function]'),
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

// crypto.randomUUID is unavailable on plain-http LAN pages, so build our own id.
const newId = () => `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const normalize = (c) => ({
  ...c,
  functions: Array.from({ length: FUNCTION_COUNT }, (_v, i) => Boolean(c.functions && c.functions[i]))
});

const active = () => state.controllers.find((c) => c.id === state.activeId) || state.controllers[0];

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
  if (window.BirdRail && window.BirdRail.updateStatus) window.BirdRail.updateStatus(status);
};

/* ---------- Persistence ---------- */

let saveTimer = null;
const scheduleSave = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const data = await api('/api/controllers', {
        method: 'PUT',
        body: JSON.stringify({ controllers: state.controllers, activeControllerId: state.activeId })
      });
      state.activeId = data.activeControllerId;
    } catch (error) {
      setMessage(t('ctl.saveFailed', { msg: error.message }), 'error');
    }
  }, 400);
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
  el.address.textContent = `#${active().decoderId}`;
  el.deleteController.hidden = state.controllers.length <= 1;
};

const renderSpeed = (c) => {
  el.speedValue.textContent = c.speed;
  el.speed.value = c.speed;
  el.speed.style.setProperty('--fill', `${(c.speed / Number(el.speed.max)) * 100}%`);
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
};

const render = () => {
  const c = active();
  if (!c) return;
  renderSelect();
  if (document.activeElement !== el.name) el.name.value = c.name;
  if (document.activeElement !== el.decoderId) el.decoderId.value = c.decoderId;
  renderSpeed(c);
  renderDirection(c);
  renderFunctions(c);
};

/* ---------- Locomotive commands ---------- */

const sendCommand = async ({ stop = false, emergency = false } = {}) => {
  const c = active();
  if (!c) return;
  try {
    const data = await api('/api/locomotive/control', {
      method: 'POST',
      body: JSON.stringify({ decoderId: c.decoderId, speed: c.speed, direction: c.direction, stop, emergency })
    });
    reportStatus(data.status);
    if (!data.ok) throw new Error(data.error || t('ctl.sendFailed'));

    const dir = c.direction === 'reverse' ? t('ctl.dirReverse') : t('ctl.dirForward');
    const label = emergency ? t('ctl.emergency') : stop ? t('ctl.stopped') : t('ctl.speedDir', { speed: c.speed, dir });
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
  scheduleSave();
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

const halt = (options) => {
  clearTimeout(pendingSend);
  updateActive({ speed: 0 });
  renderSpeed(active());
  sendCommand(options);
};

el.stop.addEventListener('click', () => halt({ stop: true }));
el.emergency.addEventListener('click', () => halt({ emergency: true }));

/* ---------- Locomotive selection and editing ---------- */

el.select.addEventListener('change', () => {
  state.activeId = el.select.value;
  render();
  scheduleSave();
  setMessage(t('ctl.selected', { name: active().name }));
});

el.editToggle.addEventListener('click', () => {
  const open = el.edit.hidden;
  el.edit.hidden = !open;
  el.editToggle.setAttribute('aria-expanded', String(open));
  if (open) el.name.focus();
});

el.addController.addEventListener('click', () => {
  const usedIds = new Set(state.controllers.map((c) => c.decoderId));
  let decoderId = 3;
  while (usedIds.has(decoderId)) decoderId += 1;

  const controller = normalize({
    id: newId(),
    name: t('ctl.newLoco', { n: state.controllers.length + 1 }),
    decoderId,
    speed: 0,
    direction: 'forward'
  });
  state.controllers.push(controller);
  state.activeId = controller.id;
  render();
  scheduleSave();
  el.name.focus();
  el.name.select();
});

el.deleteController.addEventListener('click', () => {
  if (state.controllers.length <= 1) return;
  const c = active();
  if (el.deleteController.dataset.confirm !== c.id) {
    el.deleteController.dataset.confirm = c.id;
    el.deleteController.textContent = t('ctl.deleteConfirm');
    setTimeout(() => {
      delete el.deleteController.dataset.confirm;
      el.deleteController.textContent = t('ctl.delete');
    }, 3000);
    return;
  }

  delete el.deleteController.dataset.confirm;
  el.deleteController.textContent = t('ctl.delete');
  state.controllers = state.controllers.filter((x) => x.id !== c.id);
  state.activeId = state.controllers[0].id;
  render();
  scheduleSave();
  setMessage(t('ctl.deleted', { name: c.name }));
});

el.name.addEventListener('input', () => {
  updateActive({ name: el.name.value.slice(0, 40) });
  renderSelect();
});

el.name.addEventListener('blur', () => {
  if (!el.name.value.trim()) {
    updateActive({ name: t('ctl.newLoco', { n: active().decoderId }) });
    render();
  }
});

el.decoderId.addEventListener('change', () => {
  const value = Number(el.decoderId.value);
  if (!Number.isInteger(value) || value < 1 || value > 10239) {
    setMessage(t('ctl.decoderRange'), 'error');
    el.decoderId.value = active().decoderId;
    return;
  }
  updateActive({ decoderId: value });
  renderSelect();
  setMessage(t('ctl.decoderSet', { value }));
});

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
    state.controllers = [normalize({ id: newId(), name: 'Locomotive', decoderId: 3, speed: 0, direction: 'forward' })];
    state.activeId = state.controllers[0].id;
    setMessage(t('ctl.loadFailed', { msg: error.message }), 'error');
  }
  render();
  // Run mode may already be active (it is chosen before this script finishes loading).
  if (document.body.dataset.mode === 'run') openWindow();
};

window.addEventListener('languagechange', render);

init();
})();
