// Burger menu in the top bar: Settings, Layout (edit mode), Run (run mode).
// On the main page the entries act in place; on other pages they open the main page.
(() => {
const button = document.getElementById('menuButton');
const menu = document.getElementById('mainMenu');
if (!button || !menu) return;

const items = () => [...menu.querySelectorAll('[role="menuitem"]')];

const open = () => {
  menu.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  (menu.querySelector('[aria-current="true"]') || items()[0]).focus();
};

const close = ({ focus = false } = {}) => {
  if (menu.hidden) return;
  menu.hidden = true;
  button.setAttribute('aria-expanded', 'false');
  if (focus) button.focus();
};

button.addEventListener('click', () => (menu.hidden ? open() : close()));

menu.addEventListener('click', (event) => {
  const item = event.target.closest('[data-action]');
  if (!item) return;
  const action = window.SmartRailControl && window.SmartRailControl[item.dataset.action];
  close();
  if (typeof action !== 'function') return; // Not on the main page: follow the link.
  event.preventDefault();
  if (location.hash) history.replaceState(null, '', location.pathname);
  action();
});

menu.addEventListener('keydown', (event) => {
  const list = items();
  const index = list.indexOf(document.activeElement);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    list[(index + step + list.length) % list.length].focus();
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    list[event.key === 'Home' ? 0 : list.length - 1].focus();
  } else if (event.key === 'Tab') {
    close();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !menu.hidden) {
    event.stopPropagation();
    close({ focus: true });
  }
}, true);

document.addEventListener('pointerdown', (event) => {
  if (!menu.hidden && !menu.contains(event.target) && !button.contains(event.target)) close();
});

// Mark the active mode (main page only).
window.addEventListener('modechange', (event) => {
  menu.querySelectorAll('[data-action="edit"], [data-action="run"]').forEach((item) => {
    if (item.dataset.action === event.detail.mode) item.setAttribute('aria-current', 'true');
    else item.removeAttribute('aria-current');
  });
});
})();
