// Secondary windows (Logic rules, Blocks, Locomotives, Decoder test): the ✕ top right
// closes the window. A page opened as a normal tab cannot close itself; then the ✕
// goes to the main window instead.
(() => {
const button = document.getElementById('windowClose');
if (!button) return;

const close = () => {
  window.close();
  setTimeout(() => {
    if (!window.closed) location.href = '/';
  }, 150);
};

button.addEventListener('click', close);
document.addEventListener('keydown', (event) => {
  // Escape closes, unless it is used in a field or a list.
  if (event.key === 'Escape' && !event.target.closest('input, select, textarea')) close();
});
})();
