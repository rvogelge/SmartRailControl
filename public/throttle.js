/* global t */
// Locomotive control: docked right of the track layout in run mode.
// Locomotives are added and edited on the Locomotives page; this window only drives
// them. It saves the driving state of the selected locomotive (speed, direction,
// functions, light) and picks up changes to the list from the server.
(() => {
const $ = (id) => document.getElementById(id);

const FUNCTION_COUNT = 4;
const MAX_SPEED = 126;
const REFRESH_MS = 2000;

const el = {
  address: $('throttleAddress'),
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

// How far the slider is filled (the slider ends at the locomotive's max speed).
const fill = (c) => Math.round((c.speed / c.maxSpeed) * 100);

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
  // The real speed step (0..126), not a percentage.
  el.speedValue.textContent = String(c.speed);
  el.speed.style.setProperty('--fill', `${fill(c)}%`);
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
    const label = message || (emergency ? t('ctl.emergency') : stop ? t('ctl.stopped') : t('ctl.speedDir', { speed: c.speed, dir }));
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

// Locomotives added, renamed or removed on the Locomotives page (or in another browser),
// and locomotives stopped by automated operation: take over the server's list and driving
// state, except for a change of this window that is still being saved (or the slider
// being dragged).
const refresh = async () => {
  try {
    const data = await api('/api/controllers');
    const local = new Map(state.controllers.map((c) => [c.id, c]));
    const busy = (id) => saveTimers.has(id) || (document.activeElement === el.speed && id === state.activeId);
    const next = data.controllers.map((c) => {
      const mine = local.get(c.id);
      return normalize(mine && busy(c.id) ? { ...c, speed: mine.speed, direction: mine.direction, functions: mine.functions, light: mine.light } : c);
    });
    if (JSON.stringify(next) === JSON.stringify(state.controllers)) return;
    state.controllers = next;
    if (!next.some((c) => c.id === state.activeId)) state.activeId = data.activeControllerId;
    render();
  } catch (_error) {
    // Server not reachable: try again later.
  }
};

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
};

window.addEventListener('languagechange', render);
window.addEventListener('focus', refresh);
setInterval(() => {
  if (document.visibilityState === 'visible') refresh();
}, REFRESH_MS);

init();
})();
