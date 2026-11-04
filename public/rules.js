/* global TrackCatalog, I18n */
// Logic rules editor (separate window). Rules are saved on the server and run there:
// WHEN <contact> turns on/off · AND IF <element> is <state> … · THEN <element> → <state> (after n s) …
const { ruleRoles, conditionStates, actionStates, addressSlots, sensorStatesOf } = TrackCatalog;
// Translated texts (`t` is used for tiles in this file).
const tr = (key, vars) => I18n.t(key, vars);
const labelOf = (type) => I18n.label(type);
const stateLabel = (type, value) => I18n.stateLabel(type, value);

const LIVE_INTERVAL_MS = 1000;
const LAYOUT_INTERVAL_MS = 10000;

// Device groups in the device list, in this order.
const GROUPS = [
  { key: 'grp.sensors', match: (type) => Boolean(sensorStatesOf(type)) },
  { key: 'grp.turnouts', match: (type) => /^turnout|double-slip/.test(type) },
  { key: 'grp.signals', match: (type) => type === 'signal' },
  { key: 'grp.uncouplers', match: (type) => type === 'uncoupler' }
];

const $ = (id) => document.getElementById(id);
const ui = {
  deviceList: $('deviceList'),
  deviceCount: $('deviceCount'),
  feedback: $('feedbackStatus'),
  ruleList: $('ruleList'),
  addRule: $('addRule'),
  logList: $('logList'),
  saveState: $('saveState'),
  status: $('statusLine'),
  filterChip: $('filterChip'),
  filterText: $('filterText'),
  clearFilter: $('clearFilter')
};

const state = {
  tiles: [],
  rules: [],
  live: { states: {}, sensors: {}, log: [] },
  filter: null // device id: show only rules that use it
};

const newId = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([key, value]) => {
    if (value === undefined || value === null || value === false) return;
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value === true ? '' : value);
  });
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
};

const setStatus = (text, kind = '') => {
  ui.status.textContent = text;
  ui.status.classList.toggle('error', kind === 'error');
  ui.status.classList.toggle('ok', kind === 'ok');
};

/* ---------- Devices ---------- */

const isDevice = (tile) => {
  const roles = ruleRoles(tile.type);
  return roles.trigger || roles.condition || roles.action;
};
const devices = () => state.tiles.filter(isDevice);
const tileById = (id) => state.tiles.find((t) => t.id === id) || null;

const addressText = (tile) => {
  if (addressSlots(tile.type).length === 0) return '';
  const values = addressSlots(tile.type).map((_s, i) => (tile.addresses && tile.addresses[i]) || '?');
  return values.join('/');
};

// "Turnout left #12" — or "(no address)"; position tells equal elements apart.
const deviceName = (tile) => {
  const addr = addressText(tile);
  return /^[?/]+$/.test(addr) ? tr('lay.noAddress', { label: labelOf(tile.type) }) : `${labelOf(tile.type)} #${addr}`;
};
const position = (tile) => tr('lay.where', { x: tile.x + 1, y: tile.y + 1 });

const currentState = (tile) => {
  if (sensorStatesOf(tile.type)) return state.live.sensors[tile.id] ? 'on' : 'off';
  return state.live.states[tile.id] !== undefined ? state.live.states[tile.id] : tile.state;
};

const ruleUses = (rule, id) =>
  rule.trigger.device === id || rule.conditions.some((c) => c.device === id) || rule.actions.some((a) => a.device === id);

/* ---------- Persistence ---------- */

let saveTimer = null;
const scheduleSave = () => {
  ui.saveState.textContent = tr('common.saving');
  ui.saveState.classList.remove('error');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const response = await fetch('/api/rules', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules: state.rules })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Save failed.');
      ui.saveState.textContent = tr('common.saved');
    } catch (error) {
      ui.saveState.textContent = tr('common.notSaved');
      ui.saveState.classList.add('error');
      setStatus(tr('rules.saveFailed', { msg: error.message }), 'error');
    }
  }, 400);
};

/* ---------- Rule helpers ---------- */

const firstDevice = (role) => devices().find((t) => ruleRoles(t.type)[role]) || null;
const statesFor = (role, type) => (role === 'action' ? actionStates(type) : conditionStates(type));

const newRule = () => {
  const sensor = firstDevice('trigger');
  const target = firstDevice('action');
  return {
    id: newId('r'),
    name: tr('rules.defaultName', { n: state.rules.length + 1 }),
    enabled: true,
    trigger: { device: sensor ? sensor.id : null, state: 'on' },
    conditions: [],
    actions: target ? [{ device: target.id, state: actionStates(target.type)[0], delay: 0 }] : []
  };
};

// Problems that stop a rule from doing what it says.
const ruleProblems = (rule) => {
  const problems = [];
  const check = (item, what) => {
    if (!item.device) problems.push(tr(`rules.choose${what}`));
    else if (!tileById(item.device)) problems.push(tr(`rules.${what.toLowerCase()}Removed`));
  };
  check(rule.trigger, 'Sensor');
  rule.conditions.forEach((c) => check(c, 'Condition'));
  rule.actions.forEach((a) => check(a, 'Action'));
  if (rule.actions.length === 0) problems.push(tr('rules.noActions'));
  const sensor = tileById(rule.trigger.device);
  if (sensor && /^[?/]+$/.test(addressText(sensor))) problems.push(tr('rules.noContactNo'));
  return [...new Set(problems)];
};

const nameOf = (id) => {
  const tile = tileById(id);
  return tile ? deviceName(tile) : tr('rules.removedName');
};

const summary = (rule) => {
  const sensor = tileById(rule.trigger.device);
  const when = tr('rules.sumWhen', { sensor: nameOf(rule.trigger.device), state: tr(`sensorWord.${rule.trigger.state}`) });
  const conds = rule.conditions.map((c) => {
    const tile = tileById(c.device);
    return tr('rules.sumIs', { name: nameOf(c.device), state: tile ? stateLabel(tile.type, c.state) : c.state });
  });
  const acts = rule.actions.map((a) => {
    const tile = tileById(a.device);
    const what = `${nameOf(a.device)} → ${tile ? stateLabel(tile.type, a.state) : a.state}`;
    return a.delay > 0 ? tr('rules.sumAfter', { s: a.delay, what }) : what;
  });
  if (!sensor && !rule.trigger.device) return tr('rules.incomplete');
  const and = tr('rules.sumAnd');
  return `${when}${conds.length ? `${and}${conds.join(and)}` : ''}: ${acts.join(tr('rules.sumThen')) || tr('rules.sumNothing')}.`;
};

/* ---------- Rendering: devices ---------- */

const renderDevices = () => {
  const list = devices();
  ui.deviceCount.textContent = list.length ? `${list.length}` : '';
  if (list.length === 0) {
    ui.deviceList.replaceChildren(
      el('p', { className: 'empty', text: tr('rules.noDevices') })
    );
    return;
  }

  ui.deviceList.replaceChildren(
    ...GROUPS.flatMap((group) => {
      const items = list.filter((t) => group.match(t.type)).sort((a, b) => a.y - b.y || a.x - b.x);
      if (items.length === 0) return [];
      return el(
        'section',
        { className: 'device-group' },
        el('h3', { text: `${tr(group.key)} (${items.length})` }),
        el(
          'ul',
          {},
          ...items.map((tile) => {
            const current = currentState(tile);
            const uses = state.rules.filter((r) => ruleUses(r, tile.id)).length;
            const isSensor = Boolean(sensorStatesOf(tile.type));
            const noAddress = /^[?/]+$/.test(addressText(tile));

            const stateNode = isSensor
              ? el('button', {
                  type: 'button',
                  className: `state-chip sensor ${current}`,
                  'data-sensor': tile.id,
                  'aria-pressed': String(current === 'on'),
                  title: tr('rules.simulate'),
                  text: tr(`sensor.${current}`)
                })
              : current
                ? el('span', { className: `state-chip ${current}`, text: stateLabel(tile.type, current) })
                : null;

            return el(
              'li',
              {},
              el(
                'div',
                { className: 'device-item', 'aria-pressed': String(state.filter === tile.id) },
                el(
                  'button',
                  { type: 'button', className: 'device-main', 'data-filter': tile.id, title: tr('rules.showUsing') },
                  el('span', { className: `device-name${noAddress ? ' missing' : ''}`, text: deviceName(tile) }),
                  el('span', { className: 'device-meta', text: `${position(tile)}${uses ? ` · ${tr('rules.usedIn', { n: uses })}` : ''}` })
                ),
                stateNode
              )
            );
          })
        )
      );
    })
  );
};

/* ---------- Rendering: rules ---------- */

const deviceSelect = (role, selectedId, field) => {
  const candidates = devices().filter((t) => ruleRoles(t.type)[role]);
  const select = el('select', { 'data-field': field, 'aria-label': tr(role === 'trigger' ? 'rules.sensor' : 'rules.element') });
  if (!selectedId) select.append(el('option', { value: '', text: tr(candidates.length ? 'rules.choose' : 'rules.noSuitable'), selected: true }));
  if (selectedId && !tileById(selectedId)) {
    select.append(el('option', { value: selectedId, text: tr('rules.removedOption'), selected: true }));
  }
  GROUPS.forEach((group) => {
    const items = candidates.filter((t) => group.match(t.type));
    if (items.length === 0) return;
    select.append(
      el(
        'optgroup',
        { label: tr(group.key) },
        ...items.map((t) => el('option', { value: t.id, text: `${deviceName(t)} · ${position(t)}`, selected: t.id === selectedId }))
      )
    );
  });
  return select;
};

const stateSelect = (role, item, field) => {
  const tile = tileById(item.device);
  const options = tile ? statesFor(role, tile.type) : item.state ? [item.state] : [];
  return el(
    'select',
    { 'data-field': field, 'aria-label': tr('rules.state'), disabled: !tile },
    ...options.map((s) => el('option', { value: s, text: tile ? stateLabel(tile.type, s) : s, selected: s === item.state }))
  );
};

const removeButton = (field, label) =>
  el('button', { type: 'button', className: 'icon-button small-x', 'data-remove': field, 'aria-label': label, title: label, text: '×' });

const renderRule = (rule, index) => {
  const problems = ruleProblems(rule);
  const used = state.filter && ruleUses(rule, state.filter);

  const triggerRow = el(
    'div',
    { className: 'rule-row' },
    el('span', { className: 'rule-kw when', text: tr('rules.when') }),
    deviceSelect('trigger', rule.trigger.device, 'trigger.device'),
    el('span', { className: 'rule-word', text: tr('rules.turns') }),
    el(
      'select',
      { 'data-field': 'trigger.state', 'aria-label': tr('rules.sensorState') },
      ...['on', 'off'].map((s) => el('option', { value: s, text: stateLabel('contact', s), selected: s === rule.trigger.state }))
    )
  );

  const conditionRows = rule.conditions.map((c, i) =>
    el(
      'div',
      { className: 'rule-row' },
      el('span', { className: 'rule-kw and', text: tr(i === 0 ? 'rules.andIf' : 'rules.and') }),
      deviceSelect('condition', c.device, `conditions.${i}.device`),
      el('span', { className: 'rule-word', text: tr('rules.is') }),
      stateSelect('condition', c, `conditions.${i}.state`),
      removeButton(`conditions.${i}`, tr('rules.removeCondition'))
    )
  );

  const actionRows = rule.actions.map((a, i) =>
    el(
      'div',
      { className: 'rule-row' },
      el('span', { className: 'rule-kw then', text: tr(i === 0 ? 'rules.then' : 'rules.andThen') }),
      el('span', { className: 'rule-word', text: tr('rules.set') }),
      deviceSelect('action', a.device, `actions.${i}.device`),
      el('span', { className: 'rule-word', text: tr('rules.to') }),
      stateSelect('action', a, `actions.${i}.state`),
      el(
        'label',
        { className: 'delay-field', title: tr('rules.delayTitle') },
        el('span', { text: tr('rules.after') }),
        el('input', { type: 'number', min: '0', max: '3600', step: '0.5', value: String(a.delay || 0), 'data-field': `actions.${i}.delay` }),
        el('span', { text: 's' })
      ),
      removeButton(`actions.${i}`, tr('rules.removeAction'))
    )
  );

  return el(
    'article',
    { className: `rule${rule.enabled ? '' : ' disabled'}${problems.length ? ' has-problems' : ''}${used ? ' highlighted' : ''}`, 'data-rule': rule.id },
    el(
      'div',
      { className: 'rule-head' },
      el(
        'label',
        { className: 'switch', title: tr(rule.enabled ? 'rules.activeTitle' : 'rules.inactiveTitle') },
        el('input', { type: 'checkbox', 'data-field': 'enabled', checked: rule.enabled, 'aria-label': tr('rules.activeAria') }),
        el('span', { className: 'switch-track', 'aria-hidden': 'true' })
      ),
      el('input', { className: 'rule-name', type: 'text', maxlength: '60', value: rule.name, 'data-field': 'name', 'aria-label': tr('rules.nameAria') }),
      el('span', { className: 'rule-index', text: `#${index + 1}` }),
      el('button', { type: 'button', className: 'ghost small', 'data-action': 'duplicate', text: tr('rules.duplicate') }),
      el('button', { type: 'button', className: 'ghost small danger-text', 'data-action': 'delete', text: tr('rules.delete') })
    ),
    triggerRow,
    ...conditionRows,
    el('div', { className: 'rule-row add-row' }, el('button', { type: 'button', className: 'link-button', 'data-action': 'add-condition', text: tr('rules.addCondition') })),
    ...actionRows,
    el('div', { className: 'rule-row add-row' }, el('button', { type: 'button', className: 'link-button', 'data-action': 'add-action', text: tr('rules.addAction') })),
    el('p', { className: 'rule-summary', text: summary(rule) }),
    problems.length ? el('ul', { className: 'rule-problems' }, ...problems.map((p) => el('li', { text: p }))) : null
  );
};

const renderRules = () => {
  // Keep focus on the same field across re-renders.
  const active = document.activeElement;
  const focusRule = active && active.closest && active.closest('[data-rule]');
  const focusKey = focusRule && active.dataset ? [focusRule.dataset.rule, active.dataset.field || active.dataset.action] : null;

  const visible = state.rules.map((rule, index) => ({ rule, index })).filter(({ rule }) => !state.filter || ruleUses(rule, state.filter));

  if (state.rules.length === 0) {
    ui.ruleList.replaceChildren(
      el('div', { className: 'empty' }, el('p', { text: tr('rules.empty') }), el('p', { className: 'example', text: tr('rules.example') }))
    );
  } else if (visible.length === 0) {
    ui.ruleList.replaceChildren(el('p', { className: 'empty', text: tr('rules.noneUse') }));
  } else {
    ui.ruleList.replaceChildren(...visible.map(({ rule, index }) => renderRule(rule, index)));
  }

  const filterTile = state.filter && tileById(state.filter);
  ui.filterChip.hidden = !filterTile;
  if (filterTile) ui.filterText.textContent = tr('rules.filterUsing', { name: deviceName(filterTile) });

  if (focusKey) {
    const card = ui.ruleList.querySelector(`[data-rule="${CSS.escape(focusKey[0])}"]`);
    const target = card && card.querySelector(`[data-field="${focusKey[1]}"], [data-action="${focusKey[1]}"]`);
    if (target) target.focus();
  }
};

// Log entries carry data (kind, element type, state) so they can be shown in any language.
const logText = (e) => {
  if (e.kind === 'started') return tr('log.started');
  if (e.kind === 'missing') return tr('log.missing');
  if (e.kind === 'action') {
    const what = `${labelOf(e.type)} → ${stateLabel(e.type, e.state)}`;
    return e.sent ? what : tr('log.notSent', { what, reason: e.reason });
  }
  return e.text;
};

const renderLog = () => {
  const entries = state.live.log;
  if (entries.length === 0) {
    ui.logList.replaceChildren(el('li', { className: 'empty', text: tr('log.empty') }));
    return;
  }
  ui.logList.replaceChildren(
    ...entries.slice(0, 20).map((e) =>
      el(
        'li',
        { className: e.error ? 'error' : '' },
        el('time', { text: new Date(e.time).toLocaleTimeString() }),
        el('strong', { text: e.name }),
        el('span', { text: logText(e) })
      )
    )
  );
};


const renderFeedback = () => {
  const status = state.live.feedback;
  ui.feedback.hidden = !status;
  if (!status) return;
  ui.feedback.className = `feedback-status ${status.state}`;
  ui.feedback.replaceChildren(
    el('span', { className: 'dot', 'aria-hidden': 'true' }),
    el('strong', { text: tr(`fb.${status.state}`) }),
    el('span', { className: 'feedback-text', text: status.code ? tr(`fb.code.${status.code}`, { ...status.params, n: status.params.modules }) : status.text })
  );
};

const renderAll = () => {
  renderFeedback();
  renderDevices();
  renderRules();
  renderLog();
};

/* ---------- Editing ---------- */

const ruleOf = (node) => {
  const card = node.closest('[data-rule]');
  return card ? state.rules.find((r) => r.id === card.dataset.rule) : null;
};

// field: 'name' | 'enabled' | 'trigger.device' | 'conditions.0.state' | 'actions.1.delay' …
const applyField = (rule, field, input) => {
  const parts = field.split('.');
  if (field === 'name') {
    rule.name = input.value.slice(0, 60);
    return false;
  }
  if (field === 'enabled') {
    rule.enabled = input.checked;
    return true;
  }
  const item = parts[0] === 'trigger' ? rule.trigger : rule[parts[0]][Number(parts[1])];
  const key = parts[parts.length - 1];
  if (key === 'delay') {
    item.delay = Math.max(0, Math.min(3600, Math.round((Number(input.value) || 0) * 10) / 10));
    return true;
  }
  item[key] = input.value || null;
  if (key === 'device' && parts[0] !== 'trigger') {
    // New element: keep the state if it still applies, otherwise take its first state.
    const tile = tileById(item.device);
    const states = tile ? statesFor(parts[0] === 'actions' ? 'action' : 'condition', tile.type) : [];
    if (!states.includes(item.state)) item.state = states[0] || '';
  }
  return true;
};

ui.ruleList.addEventListener('input', (event) => {
  const rule = ruleOf(event.target);
  if (!rule || event.target.dataset.field !== 'name') return;
  applyField(rule, 'name', event.target);
  scheduleSave();
});

ui.ruleList.addEventListener('change', (event) => {
  const field = event.target.dataset.field;
  const rule = ruleOf(event.target);
  if (!rule || !field || field === 'name') return;
  if (applyField(rule, field, event.target)) {
    renderRules();
    renderDevices();
  }
  scheduleSave();
});

ui.ruleList.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  const rule = button && ruleOf(button);
  if (!rule) return;

  if (button.dataset.remove) {
    const [list, index] = button.dataset.remove.split('.');
    rule[list].splice(Number(index), 1);
  } else if (button.dataset.action === 'add-condition') {
    const device = firstDevice('condition');
    rule.conditions.push({ device: device ? device.id : null, state: device ? conditionStates(device.type)[0] : '' });
  } else if (button.dataset.action === 'add-action') {
    const last = rule.actions[rule.actions.length - 1];
    const device = (last && tileById(last.device)) || firstDevice('action');
    rule.actions.push({ device: device ? device.id : null, state: device ? actionStates(device.type)[0] : '', delay: 0 });
  } else if (button.dataset.action === 'duplicate') {
    const copy = JSON.parse(JSON.stringify(rule));
    copy.id = newId('r');
    copy.name = tr('rules.copy', { name: rule.name }).slice(0, 60);
    state.rules.splice(state.rules.indexOf(rule) + 1, 0, copy);
  } else if (button.dataset.action === 'delete') {
    if (button.dataset.confirm !== 'yes') {
      // Second click deletes.
      button.dataset.confirm = 'yes';
      button.textContent = tr('rules.deleteConfirm');
      setTimeout(() => {
        if (!button.isConnected) return;
        delete button.dataset.confirm;
        button.textContent = tr('rules.delete');
      }, 3000);
      return;
    }
    state.rules.splice(state.rules.indexOf(rule), 1);
    setStatus(tr('rules.deleted', { name: rule.name }));
  } else {
    return;
  }
  renderRules();
  renderDevices();
  scheduleSave();
});

ui.addRule.addEventListener('click', () => {
  const rule = newRule();
  // A new rule made while filtering by a sensor starts from that sensor.
  const filterTile = state.filter && tileById(state.filter);
  if (filterTile && ruleRoles(filterTile.type).trigger) rule.trigger.device = filterTile.id;
  else if (filterTile && ruleRoles(filterTile.type).action) {
    rule.actions = [{ device: filterTile.id, state: actionStates(filterTile.type)[0], delay: 0 }];
  }
  state.rules.push(rule);
  renderRules();
  renderDevices();
  scheduleSave();
  const card = ui.ruleList.querySelector(`[data-rule="${CSS.escape(rule.id)}"]`);
  if (card) {
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    card.querySelector('.rule-name').select();
  }
});

ui.deviceList.addEventListener('click', async (event) => {
  const sensorButton = event.target.closest('[data-sensor]');
  if (sensorButton) {
    const id = sensorButton.dataset.sensor;
    const active = !state.live.sensors[id];
    const tile = tileById(id);
    try {
      const response = await fetch('/api/sensors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, active })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || tr('lay.rejected'));
      if (active) state.live.sensors[id] = true;
      else delete state.live.sensors[id];
      const fired = data.fired.length;
      const result = fired ? tr('rules.fired', { n: fired }) : tr('rules.noneFired');
      setStatus(tr('rules.sensorResult', { name: deviceName(tile), state: tr(active ? 'sensor.on' : 'sensor.off'), result }), fired ? 'ok' : '');
      renderDevices();
      pollLive();
    } catch (error) {
      setStatus(tr('rules.sensorFailed', { msg: error.message }), 'error');
    }
    return;
  }

  const filterButton = event.target.closest('[data-filter]');
  if (filterButton) {
    state.filter = state.filter === filterButton.dataset.filter ? null : filterButton.dataset.filter;
    renderDevices();
    renderRules();
  }
});

ui.clearFilter.addEventListener('click', () => {
  state.filter = null;
  renderDevices();
  renderRules();
});

/* ---------- Live data ---------- */

const pollLive = async () => {
  try {
    const response = await fetch('/api/live');
    if (!response.ok) return;
    const live = await response.json();
    const changed = JSON.stringify(live) !== JSON.stringify(state.live);
    state.live = live;
    if (changed) {
      renderFeedback();
      renderDevices();
      renderLog();
    }
  } catch (_error) {
    // Server not reachable: try again on the next tick.
  }
};

// The layout can change in the other window: reload it, re-render only when it did.
const loadLayout = async () => {
  try {
    const response = await fetch('/api/layout');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Load failed.');
    if (JSON.stringify(data.tiles) !== JSON.stringify(state.tiles)) {
      state.tiles = data.tiles;
      if (state.filter && !tileById(state.filter)) state.filter = null;
      renderDevices();
      renderRules();
    }
  } catch (error) {
    setStatus(tr('rules.layoutFailed', { msg: error.message }), 'error');
  }
};

const init = async () => {
  try {
    const [layoutResponse, rulesResponse] = await Promise.all([fetch('/api/layout'), fetch('/api/rules')]);
    const layout = await layoutResponse.json();
    const rules = await rulesResponse.json();
    if (!layoutResponse.ok) throw new Error(layout.error || 'Layout could not be loaded.');
    if (!rulesResponse.ok) throw new Error(rules.error || 'Rules could not be loaded.');
    state.tiles = layout.tiles;
    state.rules = rules.rules;
  } catch (error) {
    setStatus(error.message, 'error');
  }
  renderAll();
  await pollLive();
  setInterval(() => {
    if (document.visibilityState === 'visible') pollLive();
  }, LIVE_INTERVAL_MS);
  setInterval(() => {
    if (document.visibilityState === 'visible') loadLayout();
  }, LAYOUT_INTERVAL_MS);
  window.addEventListener('focus', loadLayout);
};

window.addEventListener('languagechange', renderAll);

init();
