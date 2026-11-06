/* global TrackCatalog, I18n */
// Logic rules editor (separate window). Rules are saved on the server and run there:
// WHEN <contact> turns on/off | <turnout/signal> is switched to <state> (by hand)
// · AND IF <element> is <state> … · THEN <element> → <state> | loco in <block> → n % (after n s) …
// Rules are grouped by route (Fahrstraße); a route's switch turns all its rules on or off.
const { ruleRoles, conditionStates, triggerStates, actionStates, addressSlots, sensorStatesOf } = TrackCatalog;
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
  addRoute: $('addRoute'),
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
  routes: [], // rule groups: [{ id, name }]
  blocks: [], // [{ id, number }] for loco actions
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
  rule.trigger.device === id ||
  rule.conditions.some((c) => c.device === id || c.block === id) ||
  rule.actions.some((a) => a.device === id || a.block === id);

const isBlockCondition = (condition) => condition.type === 'block';

const isLocoAction = (action) => action.type === 'loco';
const blockLabel = (id) => {
  const block = state.blocks.find((b) => b.id === id);
  return block ? `B${block.number}` : tr('rules.removedBlock');
};

/* ---------- Persistence ---------- */

let saveTimer = null;
const save = async ({ keepalive = false } = {}) => {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    const response = await fetch('/api/rules', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules: state.rules, routes: state.routes }),
      keepalive
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Save failed.');
    if (!saveTimer) ui.saveState.textContent = tr('common.saved');
  } catch (error) {
    ui.saveState.textContent = tr('common.notSaved');
    ui.saveState.classList.add('error');
    setStatus(tr('rules.saveFailed', { msg: error.message }), 'error');
  }
};
const scheduleSave = () => {
  ui.saveState.textContent = tr('common.saving');
  ui.saveState.classList.remove('error');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
};

// The panel or the page closes: take over a value still being typed (its change
// event) and send what is still waiting right away.
const flushSave = () => {
  const active = document.activeElement;
  if (active && active !== document.body && typeof active.blur === 'function') active.blur();
  if (saveTimer) save({ keepalive: true });
};
window.flushPendingSave = flushSave;
window.addEventListener('pagehide', flushSave);

// Redrawing the rules replaces their fields: never while one of them is being edited
// (a typed delay or an open list would be lost). The redraw follows when it is left.
let renderDeferred = false;
const editingRule = () => {
  const active = document.activeElement;
  return Boolean(active && ui.ruleList.contains(active) && active.matches('input, select, textarea'));
};
const refreshRules = () => {
  if (editingRule()) {
    renderDeferred = true;
    return;
  }
  renderDeferred = false;
  renderRules();
};
ui.ruleList.addEventListener('focusout', () => {
  if (!renderDeferred) return;
  // After the change handlers of the field that was left; not while the next one is edited.
  setTimeout(() => {
    if (renderDeferred) refreshRules();
  }, 0);
});

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
  rule.conditions.forEach((c) => {
    if (!isBlockCondition(c)) check(c, 'Condition');
    else if (!c.block) problems.push(tr('rules.chooseBlockCondition'));
    else if (!state.blocks.some((b) => b.id === c.block)) problems.push(tr('rules.blockRemoved'));
  });
  rule.actions.forEach((a) => {
    if (!isLocoAction(a)) check(a, 'Action');
    else if (!a.block) problems.push(tr('rules.chooseBlock'));
    else if (!state.blocks.some((b) => b.id === a.block)) problems.push(tr('rules.blockRemoved'));
  });
  if (rule.actions.length === 0) problems.push(tr('rules.noActions'));
  const sensor = tileById(rule.trigger.device);
  if (sensor && sensorStatesOf(sensor.type) && /^[?/]+$/.test(addressText(sensor))) problems.push(tr('rules.noContactNo'));
  return [...new Set(problems)];
};

const nameOf = (id) => {
  const tile = tileById(id);
  return tile ? deviceName(tile) : tr('rules.removedName');
};

const summary = (rule) => {
  const sensor = tileById(rule.trigger.device);
  const when =
    sensor && !sensorStatesOf(sensor.type)
      ? tr('rules.sumWhenSwitched', { name: nameOf(rule.trigger.device), state: stateLabel(sensor.type, rule.trigger.state) })
      : tr('rules.sumWhen', { sensor: nameOf(rule.trigger.device), state: tr(`sensorWord.${rule.trigger.state}`) });
  const conds = rule.conditions.map((c) => {
    if (isBlockCondition(c)) return tr('rules.sumBlock', { block: c.block ? blockLabel(c.block) : '?', state: tr(`rules.block.${c.state}`) });
    const tile = tileById(c.device);
    return tr('rules.sumIs', { name: nameOf(c.device), state: tile ? stateLabel(tile.type, c.state) : c.state });
  });
  const acts = rule.actions.map((a) => {
    const tile = tileById(a.device);
    const what = isLocoAction(a)
      ? tr(a.emergency ? 'rules.sumLocoEmergency' : 'rules.sumLoco', { block: a.block ? blockLabel(a.block) : '?', speed: a.speed })
      : `${nameOf(a.device)} → ${tile ? stateLabel(tile.type, a.state) : a.state}`;
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

// ▲ ▼: move an action earlier or later (actions run from top to bottom).
const moveButtons = (i, count) =>
  el(
    'span',
    { className: 'move-buttons' },
    el('button', { type: 'button', className: 'icon-button small-x', 'data-move': `${i}:-1`, disabled: i === 0, 'aria-label': tr('rules.moveUp'), title: tr('rules.moveUp'), text: '▲' }),
    el('button', { type: 'button', className: 'icon-button small-x', 'data-move': `${i}:1`, disabled: i === count - 1, 'aria-label': tr('rules.moveDown'), title: tr('rules.moveDown'), text: '▼' })
  );

const removeButton = (field, label) =>
  el('button', { type: 'button', className: 'icon-button small-x', 'data-remove': field, 'aria-label': label, title: label, text: '×' });

const renderRule = (rule, index) => {
  const problems = ruleProblems(rule);
  const used = state.filter && ruleUses(rule, state.filter);

  // Contacts turn on / off; turnouts and signals are switched (by hand) to a state.
  const triggerTile = tileById(rule.trigger.device);
  const switched = triggerTile && !sensorStatesOf(triggerTile.type);
  const triggerRow = el(
    'div',
    { className: 'rule-row' },
    el('span', { className: 'rule-kw when', text: tr('rules.when') }),
    deviceSelect('trigger', rule.trigger.device, 'trigger.device'),
    el('span', { className: 'rule-word', text: tr(switched ? 'rules.switchedTo' : 'rules.turns') }),
    switched
      ? stateSelect('trigger', rule.trigger, 'trigger.state')
      : el(
          'select',
          { 'data-field': 'trigger.state', 'aria-label': tr('rules.sensorState') },
          ...['on', 'off'].map((s) => el('option', { value: s, text: stateLabel('contact', s), selected: s === rule.trigger.state }))
        ),
    switched ? el('span', { className: 'rule-word muted', text: tr('rules.byHand') }) : null
  );

  // Block selection shared by block conditions (and loco actions).
  const blockSelect = (selected, field) =>
    el(
      'select',
      { 'data-field': field, 'aria-label': tr('rules.block') },
      !selected ? el('option', { value: '', text: tr(state.blocks.length ? 'rules.chooseBlockOption' : 'rules.noBlocks'), selected: true }) : null,
      selected && !state.blocks.some((b) => b.id === selected) ? el('option', { value: selected, text: tr('rules.removedBlock'), selected: true }) : null,
      ...state.blocks.map((b) => el('option', { value: b.id, text: `B${b.number}`, selected: b.id === selected }))
    );

  const blockConditionRow = (c, i) =>
    el(
      'div',
      { className: 'rule-row' },
      el('span', { className: 'rule-kw and', text: tr(i === 0 ? 'rules.andIf' : 'rules.and') }),
      el('span', { className: 'rule-word', text: tr('rules.block') }),
      blockSelect(c.block, `conditions.${i}.block`),
      el('span', { className: 'rule-word', text: tr('rules.is') }),
      el(
        'select',
        { 'data-field': `conditions.${i}.state`, 'aria-label': tr('rules.state') },
        ...['free', 'occupied'].map((s) => el('option', { value: s, text: tr(`rules.block.${s}`), selected: s === c.state }))
      ),
      removeButton(`conditions.${i}`, tr('rules.removeCondition'))
    );

  const conditionRows = rule.conditions.map((c, i) =>
    isBlockCondition(c)
      ? blockConditionRow(c, i)
      : el(
      'div',
      { className: 'rule-row' },
      el('span', { className: 'rule-kw and', text: tr(i === 0 ? 'rules.andIf' : 'rules.and') }),
      deviceSelect('condition', c.device, `conditions.${i}.device`),
      el('span', { className: 'rule-word', text: tr('rules.is') }),
      stateSelect('condition', c, `conditions.${i}.state`),
      removeButton(`conditions.${i}`, tr('rules.removeCondition'))
    )
  );

  const locoActionRow = (a, i) =>
    el(
      'div',
      { className: 'rule-row' },
      el('span', { className: 'rule-kw then', text: tr(i === 0 ? 'rules.then' : 'rules.andThen') }),
      el('span', { className: 'rule-word', text: tr('rules.setSpeedOf') }),
      blockSelect(a.block, `actions.${i}.block`),
      el('span', { className: 'rule-word', text: tr('rules.to') }),
      el(
        'label',
        { className: 'delay-field speed-field', title: tr('rules.speedTitle') },
        el('input', { type: 'number', min: '0', max: '100', step: '5', value: String(a.speed || 0), 'data-field': `actions.${i}.speed`, 'aria-label': tr('rules.speed') }),
        el('span', { text: '%' })
      ),
      // At 0 %: stop at once instead of braking with the decoder's delay.
      Number(a.speed) === 0
        ? el(
            'label',
            { className: 'emergency-field', title: tr('rules.emergencyTitle') },
            el('input', { type: 'checkbox', 'data-field': `actions.${i}.emergency`, checked: Boolean(a.emergency) }),
            el('span', { text: tr('rules.emergency') })
          )
        : null,
      el(
        'label',
        { className: 'delay-field', title: tr('rules.delayTitle') },
        el('span', { text: tr('rules.after') }),
        el('input', { type: 'number', min: '0', max: '3600', step: '0.5', value: String(a.delay || 0), 'data-field': `actions.${i}.delay` }),
        el('span', { text: 's' })
      ),
      moveButtons(i, rule.actions.length),
      removeButton(`actions.${i}`, tr('rules.removeAction'))
    );

  const actionRows = rule.actions.map((a, i) =>
    isLocoAction(a)
      ? locoActionRow(a, i)
      : el(
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
      moveButtons(i, rule.actions.length),
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
      el(
        'select',
        { className: 'rule-route', 'data-field': 'route', 'aria-label': tr('rg.routeOfRule'), title: tr('rg.routeOfRule') },
        el('option', { value: '', text: tr('rg.noRoute'), selected: !rule.route }),
        ...state.routes.map((r) => el('option', { value: r.id, text: r.name, selected: rule.route === r.id }))
      ),
      el('button', { type: 'button', className: 'ghost small', 'data-action': 'duplicate', text: tr('rules.duplicate') }),
      el('button', { type: 'button', className: 'ghost small danger-text', 'data-action': 'delete', text: tr('rules.delete') })
    ),
    triggerRow,
    ...conditionRows,
    el(
      'div',
      { className: 'rule-row add-row' },
      el('button', { type: 'button', className: 'link-button', 'data-action': 'add-condition', text: tr('rules.addCondition') }),
      el('button', { type: 'button', className: 'link-button', 'data-action': 'add-block-condition', text: tr('rules.addBlockCondition') })
    ),
    ...actionRows,
    el(
      'div',
      { className: 'rule-row add-row' },
      el('button', { type: 'button', className: 'link-button', 'data-action': 'add-action', text: tr('rules.addAction') }),
      el('button', { type: 'button', className: 'link-button', 'data-action': 'add-loco-action', text: tr('rules.addLocoAction') })
    ),
    el('p', { className: 'rule-summary', text: summary(rule) }),
    problems.length ? el('ul', { className: 'rule-problems' }, ...problems.map((p) => el('li', { text: p }))) : null
  );
};

// Folded routes (per browser): their rules are hidden, the head stays.
const COLLAPSED_KEY = 'smartrailcontrol.collapsedRoutes';
const LOOSE = '_loose'; // the section of rules without route
const collapsed = (() => {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY)) || []);
  } catch (_error) {
    return new Set();
  }
})();
const setCollapsed = (id, folded) => {
  if (folded) collapsed.add(id);
  else collapsed.delete(id);
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch (_error) {
    // Not remembered in this browser.
  }
};
// While filtering by a device, matching rules are always shown.
const isFolded = (id) => collapsed.has(id) && !state.filter;

const foldButton = (id, name) =>
  el('button', {
    type: 'button',
    className: 'icon-button fold-button',
    'data-fold': id,
    'aria-expanded': String(!isFolded(id)),
    'aria-label': tr(isFolded(id) ? 'rg.expand' : 'rg.collapse', { name }),
    title: tr(isFolded(id) ? 'rg.expand' : 'rg.collapse', { name }),
    text: isFolded(id) ? '▸' : '▾'
  });

// Switch state of a route: all of its rules on, all off, or some.
const routeState = (route) => {
  const rules = state.rules.filter((r) => r.route === route.id);
  const on = rules.filter((r) => r.enabled).length;
  return { rules, on, all: rules.length > 0 && on === rules.length, none: on === 0, partly: on > 0 && on < rules.length };
};

const renderRouteGroup = (route, items) => {
  if (state.filter && items.length === 0) return null;
  const { rules, on, all, partly } = routeState(route);
  const toggle = el('input', {
    type: 'checkbox',
    'data-route-field': 'active',
    checked: all,
    disabled: rules.length === 0,
    'aria-label': tr('rg.switchAria', { name: route.name })
  });
  toggle.indeterminate = partly;
  const status = rules.length === 0 ? tr('rg.noRules') : partly ? tr('rg.partly', { on, n: rules.length }) : tr(all ? 'rg.allOn' : 'rg.allOff', { n: rules.length });
  const folded = isFolded(route.id);
  return el(
    'section',
    { className: `route-group${all ? ' active' : partly ? ' partly' : ''}${folded ? ' folded' : ''}`, 'data-route': route.id },
    el(
      'div',
      { className: 'route-group-head' },
      foldButton(route.id, route.name),
      el('label', { className: 'switch', title: tr('rg.switchTitle') }, toggle, el('span', { className: 'switch-track', 'aria-hidden': 'true' })),
      el('input', { className: 'route-group-name', type: 'text', maxlength: '40', value: route.name, 'data-route-field': 'name', 'aria-label': tr('rg.nameAria') }),
      el('span', { className: 'route-group-status', text: status }),
      el('button', { type: 'button', className: 'ghost small', 'data-route-action': 'add-rule', text: tr('rg.addRule') }),
      el('button', { type: 'button', className: 'ghost small danger-text', 'data-route-action': 'delete', text: tr('rg.delete') })
    ),
    folded
      ? null
      : items.length
        ? el('div', { className: 'route-group-rules' }, ...items.map(({ rule, index }) => renderRule(rule, index)))
        : el('p', { className: 'route-group-empty', text: tr('rg.empty') })
  );
};

const renderLooseGroup = (items) => {
  // Only foldable when there are routes (otherwise it is the whole list).
  const folded = state.routes.length > 0 && isFolded(LOOSE);
  return el(
    'section',
    { className: `route-group loose${folded ? ' folded' : ''}` },
    state.routes.length
      ? el(
          'div',
          { className: 'route-group-head' },
          foldButton(LOOSE, tr('rg.withoutRoute')),
          el('h3', { text: tr('rg.withoutRoute') }),
          el('span', { className: 'route-group-status', text: tr('rg.count', { n: items.length }) })
        )
      : null,
    folded
      ? null
      : items.length
        ? el('div', { className: 'route-group-rules' }, ...items.map(({ rule, index }) => renderRule(rule, index)))
        : el('p', { className: 'route-group-empty', text: tr('rg.looseEmpty') })
  );
};

const renderRules = () => {
  // Keep focus on the same field across re-renders.
  const active = document.activeElement;
  const focusRule = active && active.closest && active.closest('[data-rule]');
  const focusKey = focusRule && active.dataset ? [focusRule.dataset.rule, active.dataset.field || active.dataset.action] : null;

  const visible = state.rules.map((rule, index) => ({ rule, index })).filter(({ rule }) => !state.filter || ruleUses(rule, state.filter));

  if (state.rules.length === 0 && state.routes.length === 0) {
    ui.ruleList.replaceChildren(
      el('div', { className: 'empty' }, el('p', { text: tr('rules.empty') }), el('p', { className: 'example', text: tr('rules.example') }))
    );
  } else if (state.filter && visible.length === 0) {
    ui.ruleList.replaceChildren(el('p', { className: 'empty', text: tr('rules.noneUse') }));
  } else {
    // One section per route, then the rules without route. While filtering, sections
    // without matching rules are left out.
    const sections = state.routes.map((route) => renderRouteGroup(route, visible.filter(({ rule }) => rule.route === route.id)));
    const loose = visible.filter(({ rule }) => !rule.route || !state.routes.some((r) => r.id === rule.route));
    if (loose.length || !state.filter) sections.push(renderLooseGroup(loose));
    ui.ruleList.replaceChildren(...sections.filter(Boolean));
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
  if (e.kind === 'loco') {
    const block = e.block ? blockLabel(e.block) : '?';
    if (!e.sent) return tr('log.locoNotSet', { block, reason: e.reason });
    return tr(e.emergency ? 'log.locoEmergency' : 'log.loco', { loco: e.loco, block, speed: e.speed });
  }
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
  if (field === 'route') {
    rule.route = input.value || null;
    return true;
  }
  const item = parts[0] === 'trigger' ? rule.trigger : rule[parts[0]][Number(parts[1])];
  const key = parts[parts.length - 1];
  if (key === 'delay') {
    item.delay = Math.max(0, Math.min(3600, Math.round((Number(input.value) || 0) * 10) / 10));
    return true;
  }
  if (key === 'speed') {
    item.speed = Math.max(0, Math.min(100, Math.round(Number(input.value) || 0)));
    if (item.speed !== 0) item.emergency = false;
    return true;
  }
  if (key === 'emergency') {
    item.emergency = input.checked;
    return true;
  }
  item[key] = input.value || null;
  if (key === 'device') {
    // New element: keep the state if it still applies, otherwise take its first state
    // (a contact as trigger: 'on').
    const tile = tileById(item.device);
    const role = parts[0] === 'trigger' ? 'trigger' : parts[0] === 'actions' ? 'action' : 'condition';
    const states = !tile ? [] : role === 'trigger' ? triggerStates(tile.type) : statesFor(role, tile.type);
    if (!states.includes(item.state)) item.state = role === 'trigger' && tile && sensorStatesOf(tile.type) ? 'on' : states[0] || '';
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
  } else if (button.dataset.move) {
    const [index, step] = button.dataset.move.split(':').map(Number);
    const target = index + step;
    if (target < 0 || target >= rule.actions.length) return;
    [rule.actions[index], rule.actions[target]] = [rule.actions[target], rule.actions[index]];
  } else if (button.dataset.action === 'add-block-condition') {
    rule.conditions.push({ type: 'block', block: state.blocks.length ? state.blocks[0].id : null, state: 'free' });
  } else if (button.dataset.action === 'add-condition') {
    const device = firstDevice('condition');
    rule.conditions.push({ device: device ? device.id : null, state: device ? conditionStates(device.type)[0] : '' });
  } else if (button.dataset.action === 'add-action') {
    const last = rule.actions[rule.actions.length - 1];
    const device = (last && tileById(last.device)) || firstDevice('action');
    rule.actions.push({ device: device ? device.id : null, state: device ? actionStates(device.type)[0] : '', delay: 0 });
  } else if (button.dataset.action === 'add-loco-action') {
    rule.actions.push({ type: 'loco', block: state.blocks.length ? state.blocks[0].id : null, speed: 50, delay: 0 });
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

const addRule = (route = null) => {
  const rule = newRule();
  rule.route = route;
  setCollapsed(route || LOOSE, false); // show the new rule
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
};
ui.addRule.addEventListener('click', () => addRule());

/* ---------- Routes (rule groups) ---------- */

const routeOf = (node) => {
  const section = node.closest('[data-route]');
  return section ? state.routes.find((r) => r.id === section.dataset.route) : null;
};

ui.addRoute.addEventListener('click', () => {
  const route = { id: newId('g'), name: tr('rg.defaultName', { n: state.routes.length + 1 }) };
  state.routes.push(route);
  renderRules();
  scheduleSave();
  const section = ui.ruleList.querySelector(`[data-route="${CSS.escape(route.id)}"]`);
  if (section) {
    section.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    section.querySelector('.route-group-name').select();
  }
});

ui.ruleList.addEventListener('input', (event) => {
  if (event.target.dataset.routeField !== 'name') return;
  const route = routeOf(event.target);
  if (!route) return;
  route.name = event.target.value.slice(0, 40);
  scheduleSave();
});

// The route switch turns all of its rules on or off.
ui.ruleList.addEventListener('change', (event) => {
  if (event.target.dataset.routeField !== 'active') return;
  const route = routeOf(event.target);
  if (!route) return;
  const rules = state.rules.filter((r) => r.route === route.id);
  rules.forEach((r) => {
    r.enabled = event.target.checked;
  });
  setStatus(tr(event.target.checked ? 'rg.activated' : 'rg.deactivated', { name: route.name, n: rules.length }), 'ok');
  renderRules();
  renderDevices();
  scheduleSave();
});

ui.ruleList.addEventListener('click', (event) => {
  const fold = event.target.closest('[data-fold]');
  if (fold) {
    setCollapsed(fold.dataset.fold, !collapsed.has(fold.dataset.fold));
    renderRules();
    const again = ui.ruleList.querySelector(`[data-fold="${CSS.escape(fold.dataset.fold)}"]`);
    if (again) again.focus();
  }
});

ui.ruleList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-route-action]');
  const route = button && routeOf(button);
  if (!route) return;
  if (button.dataset.routeAction === 'add-rule') {
    addRule(route.id);
    return;
  }
  if (button.dataset.routeAction === 'delete') {
    if (button.dataset.confirm !== 'yes') {
      // Second click deletes; its rules stay, without route.
      button.dataset.confirm = 'yes';
      button.textContent = tr('rules.deleteConfirm');
      setTimeout(() => {
        if (!button.isConnected) return;
        delete button.dataset.confirm;
        button.textContent = tr('rg.delete');
      }, 3000);
      return;
    }
    state.routes = state.routes.filter((r) => r.id !== route.id);
    state.rules.forEach((r) => {
      if (r.route === route.id) r.route = null;
    });
    setStatus(tr('rg.deleted', { name: route.name }));
    renderRules();
    scheduleSave();
  }
});

ui.deviceList.addEventListener('click', async (event) => {
  const sensorButton = event.target.closest('[data-sensor]');
  if (sensorButton) {
    // A press: on for 2 s, then off again (the server keeps the time).
    const id = sensorButton.dataset.sensor;
    const tile = tileById(id);
    try {
      const response = await fetch('/api/sensors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, pulse: true })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || tr('lay.rejected'));
      state.live.sensors[id] = true;
      const fired = data.fired.length;
      const result = fired ? tr('rules.fired', { n: fired }) : tr('rules.noneFired');
      setStatus(tr('rules.sensorPressed', { name: deviceName(tile), result }), fired ? 'ok' : '');
      renderDevices();
      // The live poll shows it off again; poll right after the release for a prompt update.
      setTimeout(pollLive, (data.pulseMs || 2000) + 100);
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

// Blocks for loco actions (numbers B1, B2, …).
const loadBlocks = async () => {
  try {
    const response = await fetch('/api/blocklist');
    const data = await response.json();
    if (!response.ok) return;
    const blocks = data.blocks.map((b) => ({ id: b.id, number: b.number }));
    if (JSON.stringify(blocks) === JSON.stringify(state.blocks)) return;
    state.blocks = blocks;
    refreshRules();
  } catch (_error) {
    // Try again with the next layout reload.
  }
};

// The layout can change in the other window: reload it, re-render only when it did.
const loadLayout = async () => {
  loadBlocks();
  try {
    const response = await fetch('/api/layout');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Load failed.');
    if (JSON.stringify(data.tiles) !== JSON.stringify(state.tiles)) {
      // Switched turnouts and signals change only their position: the rules stay as drawn.
      const structure = (tiles) => JSON.stringify(tiles.map(({ state: _position, ...rest }) => rest));
      const rulesChanged = structure(data.tiles) !== structure(state.tiles);
      state.tiles = data.tiles;
      if (state.filter && !tileById(state.filter)) state.filter = null;
      renderDevices();
      if (rulesChanged) refreshRules();
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
    state.routes = rules.routes || [];
  } catch (error) {
    setStatus(error.message, 'error');
  }
  await loadBlocks();
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
