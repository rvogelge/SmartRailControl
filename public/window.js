// Secondary pages (Operating Rules, Blocks, Locomotives, Decoder test).
// In a panel of the main window (a frame): the page hides its own header; Esc asks the
// main window to close the panel. Opened on its own: the ✕ top right (and Esc) closes
// the window, or goes to the main window when the page is a normal tab.
(() => {
const embedded = window.self !== window.top;
if (embedded) document.documentElement.classList.add('embedded');

const close = () => {
  if (embedded) {
    window.parent.postMessage({ type: 'closePanel' }, location.origin);
    return;
  }
  window.close();
  setTimeout(() => {
    if (!window.closed) location.href = '/';
  }, 150);
};

const button = document.getElementById('windowClose');
if (button) button.addEventListener('click', close);
document.addEventListener('keydown', (event) => {
  // Escape closes, unless it is used in a field or a list.
  if (event.key === 'Escape' && !event.target.closest('input, select, textarea')) close();
});
})();
