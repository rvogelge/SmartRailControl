/* global I18n, t */
// Settings dialog (interface, language, data storage) and the interface status chip.
(() => {
const $ = (id) => document.getElementById(id);

const el = {
  statusChip: $('statusChip'),
  statusText: $('statusText'),
  dialog: $('settingsDialog'),
  serialForm: $('serialConfigForm'),
  portSelect: $('serialPortSelect'),
  baudSelect: $('baudRateSelect'),
  refreshPorts: $('refreshPorts'),
  infoProtocol: $('infoProtocol'),
  infoLine: $('infoLine'),
  infoStatus: $('infoStatus'),
  settingsMessage: $('settingsMessage'),
  languageSelect: $('languageSelect'),
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
  serial: null
};

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

// Options are named in their own language, so they read the same whichever language is active.
el.languageSelect.replaceChildren(
  ...Object.entries(I18n.LANGUAGES).map(([code, name]) => {
    const option = document.createElement('option');
    option.value = code;
    option.lang = code;
    option.textContent = name;
    return option;
  })
);

const renderLanguage = () => {
  el.languageSelect.value = I18n.language;
};

el.languageSelect.addEventListener('change', async () => {
  const language = el.languageSelect.value;
  if (language === I18n.language) return;
  try {
    await I18n.saveLanguage(language);
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
    setMessage(el.settingsMessage, t('set.applied', { port: el.portSelect.value, baud: el.baudSelect.value }), 'ok');
    setTimeout(pollStatus, 800);
  } catch (error) {
    setMessage(el.settingsMessage, error.message, 'error');
  }
});

/* ---------- Startup ---------- */

window.SmartRailControl = window.SmartRailControl || {};
window.SmartRailControl.settings = openSettings;
window.SmartRailControl.updateStatus = updateStatus;

window.addEventListener('languagechange', () => {
  updateStatus(state.serial);
  renderLanguage();
  renderStorage();
  if (browsing && !el.storagePicker.hidden) renderFolder();
});

// Opened from another page's menu (/#settings).
if (location.hash === '#settings') {
  history.replaceState(null, '', location.pathname);
  openSettings();
}

pollStatus();
setInterval(pollStatus, 5000);
})();
