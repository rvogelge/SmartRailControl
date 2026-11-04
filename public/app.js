/* global I18n, t */
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
  settingsMessage: $('settingsMessage'),
  languageSwitch: $('languageSwitch'),
  languageMessage: $('languageMessage'),
  storageFile: $('storageFile'),
  storagePersistence: $('storagePersistence'),
  storagePointer: $('storagePointer'),
  storageChange: $('storageChange'),
  storagePicker: $('storagePicker'),
  storageUp: $('storageUp'),
  storagePath: $('storagePath'),
  storageOpen: $('storageOpen'),
  storageDirs: $('storageDirs'),
  storageFolderInfo: $('storageFolderInfo'),
  storageConflict: $('storageConflict'),
  storageConflictText: $('storageConflictText'),
  storageLoad: $('storageLoad'),
  storageReplace: $('storageReplace'),
  storageCancel: $('storageCancel'),
  storageUse: $('storageUse'),
  storageMessage: $('storageMessage')
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
      setMessage(el.response, t('ctl.saveFailed', { msg: error.message }), 'error');
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
      meta.textContent = `#${c.decoderId} · ${c.direction === 'reverse' ? `◀ ${t('ctl.dirReverse')}` : `${t('ctl.dirForward')} ▶`}`;

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
  el.directionBadge.textContent = c.direction === 'reverse' ? t('ctl.reverse') : t('ctl.forward');
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
      throw new Error(data.error || t('ctl.sendFailed'));
    }

    const dir = c.direction === 'reverse' ? t('ctl.dirReverse') : t('ctl.dirForward');
    const label = emergency ? t('ctl.emergency') : stop ? t('ctl.stopped') : t('ctl.speedDir', { speed: c.speed, dir });
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
  setMessage(el.response, t('ctl.selected', { name: active().name }));
});

el.addController.addEventListener('click', () => {
  const usedIds = new Set(state.controllers.map((c) => c.decoderId));
  let decoderId = 3;
  while (usedIds.has(decoderId)) decoderId += 1;

  const controller = {
    id: newId(),
    name: t('ctl.newLoco', { n: state.controllers.length + 1 }),
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
  setMessage(el.response, t('ctl.deleted', { name: c.name }));
});

el.name.addEventListener('input', () => {
  updateActive({ name: el.name.value.slice(0, 40) });
});

el.name.addEventListener('blur', () => {
  if (!el.name.value.trim()) {
    updateActive({ name: t('ctl.newLoco', { n: active().decoderId }) });
    renderThrottle();
  }
});

el.decoderId.addEventListener('change', () => {
  const value = Number(el.decoderId.value);
  if (!Number.isInteger(value) || value < 1 || value > 10239) {
    setMessage(el.response, t('ctl.decoderRange'), 'error');
    el.decoderId.value = active().decoderId;
    return;
  }
  updateActive({ decoderId: value });
  setMessage(el.response, t('ctl.decoderSet', { value }));
});

/* ---------- Interface status & settings dialog ---------- */

const updateStatus = (serial) => {
  if (!serial) return;
  state.serial = serial;
  const online = Boolean(serial.connected);
  el.statusChip.classList.toggle('online', online);
  el.statusChip.classList.toggle('offline', !online);
  el.statusText.textContent = online ? `${serial.port} · ${serial.baudRate}` : t('ctl.offline');
  el.infoProtocol.textContent = serial.protocol || '–';
  el.infoLine.textContent = serial.hardwareHandshake ? '8N2 · RTS/CTS' : '8N2';
  el.infoStatus.textContent = online ? t('set.connected') : t('set.notConnected');
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
  setMessage(el.languageMessage, '');
  setMessage(el.storageMessage, '');
  closePicker();
  renderLanguage();
  await pollStatus();
  el.baudSelect.value = String((state.serial && state.serial.baudRate) || 19200);
  await Promise.all([loadPorts(), loadStorage()]);
  el.dialog.showModal();
};

/* ---------- Language ---------- */

const renderLanguage = () => {
  el.languageSwitch.querySelectorAll('[data-language]').forEach((button) => {
    button.setAttribute('aria-checked', String(button.dataset.language === I18n.language));
  });
};

el.languageSwitch.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-language]');
  if (!button || button.dataset.language === I18n.language) return;
  try {
    await I18n.saveLanguage(button.dataset.language);
    setMessage(el.languageMessage, t('set.languageSaved'), 'ok');
  } catch (error) {
    setMessage(el.languageMessage, error.message, 'error');
  }
  renderLanguage();
});

/* ---------- Data storage ---------- */

let storage = null; // GET /api/storage
let browsing = null; // GET /api/storage/browse

const persistenceText = (info) =>
  t(`set.persist.${info.reason}`, { mount: info.mount || '' });

const renderStorage = () => {
  if (!storage) return;
  el.storageFile.textContent = storage.file;
  const notes = [persistenceText(storage)];
  if (!storage.writable) notes.push(t('set.notWritable'));
  if (storage.source === 'env') notes.push(t('set.dataEnv'));
  el.storagePersistence.textContent = notes.join(' ');
  el.storagePersistence.className = `storage-note ${storage.persistent === false || !storage.writable ? 'warn' : storage.persistent ? 'ok' : ''}`;
  const pointerLost = storage.pointer && storage.pointer.persistent === false;
  el.storagePointer.hidden = !pointerLost;
  if (pointerLost) {
    el.storagePointer.textContent = t('set.pointerWarn', { file: storage.pointer.file, dir: storage.defaultDir });
  }
  el.storageChange.hidden = storage.source === 'env';
};

const loadStorage = async () => {
  try {
    storage = await api('/api/storage');
    renderStorage();
  } catch (error) {
    setMessage(el.storageMessage, error.message, 'error');
  }
};

const renderFolder = () => {
  el.storagePath.value = browsing.path;
  el.storageUp.disabled = !browsing.parent;
  el.storageDirs.replaceChildren(
    ...(browsing.dirs.length
      ? browsing.dirs.map((name) => {
          const li = document.createElement('li');
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'storage-dir';
          button.dataset.dir = name;
          button.textContent = `📁 ${name}`;
          li.append(button);
          return li;
        })
      : [Object.assign(document.createElement('li'), { className: 'storage-empty', textContent: t('set.noSubfolders') })])
  );
  const notes = [persistenceText(browsing)];
  if (browsing.hasSettings) notes.unshift(t('set.hasData'));
  if (!browsing.writable) notes.push(t('set.notWritable'));
  el.storageFolderInfo.textContent = notes.join(' ');
  el.storageFolderInfo.className = `storage-note ${browsing.persistent === false || !browsing.writable ? 'warn' : browsing.persistent ? 'ok' : ''}`;
};

const browse = async (dir) => {
  el.storageConflict.hidden = true;
  try {
    browsing = await api(`/api/storage/browse${dir ? `?path=${encodeURIComponent(dir)}` : ''}`);
    renderFolder();
    setMessage(el.storageMessage, '');
  } catch (error) {
    // A folder that does not exist yet is fine: it is created on "Use this folder".
    setMessage(el.storageMessage, error.message, 'error');
  }
};

const closePicker = () => {
  el.storagePicker.hidden = true;
  el.storageConflict.hidden = true;
  el.storageChange.hidden = Boolean(storage && storage.source === 'env');
};

el.storageChange.addEventListener('click', () => {
  el.storagePicker.hidden = false;
  el.storageChange.hidden = true;
  browse(storage && storage.dir);
});
el.storageCancel.addEventListener('click', closePicker);
el.storageUp.addEventListener('click', () => browsing && browsing.parent && browse(browsing.parent));
el.storageOpen.addEventListener('click', () => browse(el.storagePath.value.trim()));
el.storagePath.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    browse(el.storagePath.value.trim());
  }
});
el.storageDirs.addEventListener('click', (event) => {
  const button = event.target.closest('[data-dir]');
  if (!button || !browsing) return;
  browse(`${browsing.path.replace(/\/$/, '')}/${button.dataset.dir}`);
});

const moveData = async (mode) => {
  const dir = el.storagePath.value.trim();
  setMessage(el.storageMessage, t('common.saving'));
  try {
    const response = await fetch('/api/storage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir, mode })
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 409 && data.exists) {
      el.storageConflictText.textContent = t('set.exists', { file: data.file });
      el.storageConflict.hidden = false;
      setMessage(el.storageMessage, '');
      return;
    }
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);

    storage = data.storage;
    renderStorage();
    closePicker();
    if (data.unchanged) {
      setMessage(el.storageMessage, t('set.unchanged'));
    } else if (data.loaded) {
      // Other controllers, layout and language: start over with the loaded data.
      setMessage(el.storageMessage, t('set.loaded', { dir: storage.dir }), 'ok');
      setTimeout(() => location.reload(), 1200);
    } else {
      setMessage(el.storageMessage, t('set.moved', { dir: storage.dir }), 'ok');
    }
  } catch (error) {
    setMessage(el.storageMessage, error.message, 'error');
  }
};

el.storageUse.addEventListener('click', () => moveData('copy'));
el.storageLoad.addEventListener('click', () => moveData('use'));
el.storageReplace.addEventListener('click', () => moveData('replace'));

el.openSettings.addEventListener('click', openSettings);
el.statusChip.addEventListener('click', openSettings);
el.refreshPorts.addEventListener('click', loadPorts);
el.dialog.querySelectorAll('[data-close]').forEach((button) => {
  button.addEventListener('click', () => el.dialog.close());
});

el.serialForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setMessage(el.settingsMessage, t('set.applying'));
  try {
    const data = await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({ portName: el.portSelect.value, baudRate: Number(el.baudSelect.value) })
    });
    updateStatus(data.serial);
    setMessage(el.response, t('set.applied', { port: el.portSelect.value, baud: el.baudSelect.value }), 'ok');
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
    setMessage(el.response, t('ctl.loadFailed', { msg: error.message }), 'error');
  }
  render();
  pollStatus();
  setInterval(pollStatus, 5000);
};

window.addEventListener('languagechange', () => {
  render();
  updateStatus(state.serial);
  renderLanguage();
  renderStorage();
  if (browsing && !el.storagePicker.hidden) renderFolder();
});

init();
