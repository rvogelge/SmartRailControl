const $ = (id) => document.getElementById(id);

const el = {
  statusChip: $('statusChip'),
  statusText: $('statusText'),
  openSettings: $('openSettings'),
  list: $('controllerList'),
  addController: $('addController'),
  deleteController: $('deleteController'),
  name: $('controllerName'),
  decoderId: $('decoderId'),
  speed: $('speed'),
  speedValue: $('speedValue'),
  directionBadge: $('directionBadge'),
  segments: document.querySelectorAll('.segment'),
  stop: $('stopButton'),
  emergency: $('emergencyButton'),
  response: $('responseBox'),
  dialog: $('settingsDialog'),
  serialForm: $('serialConfigForm'),
  portSelect: $('serialPortSelect'),
  baudSelect: $('baudRateSelect'),
  refreshPorts: $('refreshPorts'),
  infoProtocol: $('infoProtocol'),
  infoLine: $('infoLine'),
  infoStatus: $('infoStatus'),
  settingsMessage: $('settingsMessage')
};

const state = {
  controllers: [],
  activeId: null,
  serial: null
};

// crypto.randomUUID is unavailable on plain-http LAN pages, so build our own id.
const newId = () => `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const active = () => state.controllers.find((c) => c.id === state.activeId) || state.controllers[0];

const setMessage = (target, text, kind = '') => {
  target.textContent = text;
  target.classList.toggle('error', kind === 'error');
  target.classList.toggle('ok', kind === 'ok');
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
      // Keep local edits; only adopt server-side sanitized values for ids we know.
      state.activeId = data.activeControllerId;
    } catch (error) {
      setMessage(el.response, `Could not save controllers: ${error.message}`, 'error');
    }
  }, 400);
};

/* ---------- Rendering ---------- */

const renderList = () => {
  el.list.replaceChildren(
    ...state.controllers.map((c) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'controller-item';
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(c.id === state.activeId));
      button.dataset.id = c.id;

      const name = document.createElement('span');
      name.className = 'ci-name';
      name.textContent = c.name;

      const meta = document.createElement('span');
      meta.className = 'ci-meta';
      meta.textContent = `#${c.decoderId} · ${c.direction === 'reverse' ? '◀ reverse' : 'forward ▶'}`;

      const speed = document.createElement('span');
      speed.className = `ci-speed${c.speed > 0 ? ' moving' : ''}`;
      speed.textContent = c.speed;

      button.append(name, meta, speed);
      li.append(button);
      return li;
    })
  );
  el.deleteController.disabled = state.controllers.length <= 1;
  el.deleteController.hidden = state.controllers.length <= 1;
};

const renderSpeed = (c) => {
  el.speedValue.textContent = c.speed;
  el.speed.value = c.speed;
  el.speed.style.setProperty('--fill', `${(c.speed / Number(el.speed.max)) * 100}%`);
};

const renderDirection = (c) => {
  el.segments.forEach((segment) => {
    segment.setAttribute('aria-checked', String(segment.dataset.direction === c.direction));
  });
  el.directionBadge.textContent = c.direction === 'reverse' ? 'Reverse' : 'Forward';
};

const renderThrottle = () => {
  const c = active();
  if (!c) return;
  if (document.activeElement !== el.name) el.name.value = c.name;
  if (document.activeElement !== el.decoderId) el.decoderId.value = c.decoderId;
  renderSpeed(c);
  renderDirection(c);
};

const render = () => {
  renderList();
  renderThrottle();
};

/* ---------- Locomotive commands ---------- */

const sendCommand = async ({ stop = false, emergency = false } = {}) => {
  const c = active();
  if (!c) return;

  try {
    const data = await api('/api/locomotive/control', {
      method: 'POST',
      body: JSON.stringify({
        decoderId: c.decoderId,
        speed: c.speed,
        direction: c.direction,
        stop,
        emergency
      })
    });

    if (!data.ok) {
      throw new Error(data.error || 'Command could not be sent to the Intellibox.');
    }

    const label = emergency ? 'Emergency stop' : stop ? 'Stopped' : `Speed ${c.speed}, ${c.direction}`;
    setMessage(el.response, `${c.name} (#${c.decoderId}): ${label}`, 'ok');
    updateStatus(data.status);
  } catch (error) {
    setMessage(el.response, error.message, 'error');
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
  renderList();
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

el.segments.forEach((segment) => {
  segment.addEventListener('click', () => {
    if (active().direction === segment.dataset.direction) return;
    updateActive({ direction: segment.dataset.direction });
    renderDirection(active());
    sendCommand();
  });
});

el.stop.addEventListener('click', () => {
  updateActive({ speed: 0 });
  renderSpeed(active());
  sendCommand({ stop: true });
});

el.emergency.addEventListener('click', () => {
  updateActive({ speed: 0 });
  renderSpeed(active());
  sendCommand({ emergency: true });
});

/* ---------- Controller management ---------- */

el.list.addEventListener('click', (event) => {
  const item = event.target.closest('.controller-item');
  if (!item || item.dataset.id === state.activeId) return;
  state.activeId = item.dataset.id;
  render();
  scheduleSave();
  setMessage(el.response, `Selected ${active().name}. Move the slider to drive.`);
});

el.addController.addEventListener('click', () => {
  const usedIds = new Set(state.controllers.map((c) => c.decoderId));
  let decoderId = 3;
  while (usedIds.has(decoderId)) decoderId += 1;

  const controller = {
    id: newId(),
    name: `Locomotive ${state.controllers.length + 1}`,
    decoderId,
    speed: 0,
    direction: 'forward'
  };
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
    el.deleteController.textContent = 'Click again to delete';
    setTimeout(() => {
      delete el.deleteController.dataset.confirm;
      el.deleteController.textContent = 'Delete controller';
    }, 3000);
    return;
  }

  delete el.deleteController.dataset.confirm;
  el.deleteController.textContent = 'Delete controller';
  state.controllers = state.controllers.filter((x) => x.id !== c.id);
  state.activeId = state.controllers[0].id;
  render();
  scheduleSave();
  setMessage(el.response, `Deleted ${c.name}.`);
});

el.name.addEventListener('input', () => {
  updateActive({ name: el.name.value.slice(0, 40) });
});

el.name.addEventListener('blur', () => {
  if (!el.name.value.trim()) {
    updateActive({ name: `Locomotive ${active().decoderId}` });
    renderThrottle();
  }
});

el.decoderId.addEventListener('change', () => {
  const value = Number(el.decoderId.value);
  if (!Number.isInteger(value) || value < 1 || value > 10239) {
    setMessage(el.response, 'Decoder ID must be between 1 and 10239.', 'error');
    el.decoderId.value = active().decoderId;
    return;
  }
  updateActive({ decoderId: value });
  setMessage(el.response, `Decoder ID set to ${value}.`);
});

/* ---------- Interface status & settings dialog ---------- */

const updateStatus = (serial) => {
  if (!serial) return;
  state.serial = serial;
  const online = Boolean(serial.connected);
  el.statusChip.classList.toggle('online', online);
  el.statusChip.classList.toggle('offline', !online);
  el.statusText.textContent = online ? `${serial.port} · ${serial.baudRate}` : 'offline';
  el.infoProtocol.textContent = serial.protocol || '–';
  el.infoLine.textContent = serial.hardwareHandshake ? '8N2 · RTS/CTS' : '8N2';
  el.infoStatus.textContent = online ? 'Connected' : 'Not connected';
};

const pollStatus = async () => {
  try {
    const data = await api('/api/status');
    updateStatus(data.serial);
  } catch (_error) {
    updateStatus({ connected: false });
  }
};

const loadPorts = async () => {
  const current = (state.serial && state.serial.port) || '/dev/ttyUSB0';
  let paths = [];
  try {
    const data = await api('/api/serial/ports');
    paths = [...new Set((data.ports || []).map((p) => p.path).filter(Boolean))];
  } catch (_error) {
    paths = [];
  }
  if (!paths.includes(current)) paths.unshift(current);

  el.portSelect.replaceChildren(
    ...paths.map((path) => {
      const option = document.createElement('option');
      option.value = path;
      option.textContent = path;
      return option;
    })
  );
  el.portSelect.value = current;
};

const openSettings = async () => {
  setMessage(el.settingsMessage, '');
  await pollStatus();
  el.baudSelect.value = String((state.serial && state.serial.baudRate) || 19200);
  await loadPorts();
  el.dialog.showModal();
};

el.openSettings.addEventListener('click', openSettings);
el.statusChip.addEventListener('click', openSettings);
el.refreshPorts.addEventListener('click', loadPorts);
el.dialog.querySelectorAll('[data-close]').forEach((button) => {
  button.addEventListener('click', () => el.dialog.close());
});

el.serialForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setMessage(el.settingsMessage, 'Applying…');
  try {
    const data = await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({ portName: el.portSelect.value, baudRate: Number(el.baudSelect.value) })
    });
    updateStatus(data.serial);
    setMessage(el.response, `Interface set to ${el.portSelect.value} @ ${el.baudSelect.value} baud.`, 'ok');
    el.dialog.close();
    setTimeout(pollStatus, 800);
  } catch (error) {
    setMessage(el.settingsMessage, error.message, 'error');
  }
});

/* ---------- Startup ---------- */

const init = async () => {
  try {
    const data = await api('/api/controllers');
    state.controllers = data.controllers;
    state.activeId = data.activeControllerId;
  } catch (error) {
    state.controllers = [{ id: newId(), name: 'Locomotive', decoderId: 3, speed: 0, direction: 'forward' }];
    state.activeId = state.controllers[0].id;
    setMessage(el.response, `Could not load saved controllers: ${error.message}`, 'error');
  }
  render();
  pollStatus();
  setInterval(pollStatus, 5000);
};

init();
