'use strict';

document.body.dataset.theme = new URLSearchParams(window.location.search).get('theme') === 'light' ? 'light' : 'dark';
const started = performance.now();
const elapsed = document.getElementById('elapsed');
let failed = false;
const timer = setInterval(() => {
  if (failed) return;
  const seconds = Math.floor((performance.now() - started) / 1000);
  elapsed.textContent = seconds < 1 ? 'Starting up' : `${seconds}s elapsed`;
}, 1000);

const unsubscribe = window.startup.onState((state) => {
  failed = state.failed;
  document.body.dataset.theme = state.theme;
  document.body.dataset.failed = String(failed);
  document.getElementById('status-title').textContent = state.title;
  document.getElementById('status-detail').textContent = state.detail;
  document.getElementById('version').textContent = `Version ${state.version}`;
  if (failed) elapsed.textContent = 'Startup interrupted';
  for (const item of document.querySelectorAll('[data-step]')) {
    const index = Number(item.dataset.step);
    item.dataset.state = index < state.step ? 'complete' : index === state.step ? 'active' : 'pending';
    if (index === state.step) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  }
});
document.getElementById('close').addEventListener('click', () => window.startup.close());
window.addEventListener('unload', () => {
  clearInterval(timer);
  unsubscribe();
});
