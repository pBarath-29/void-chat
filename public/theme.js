'use strict';

const THEMES = ['void', 'love', 'ocean', 'sunset', 'aurora', 'midnight'];
const KEY = 'void_theme';

function applyTheme(name) {
  const t = THEMES.includes(name) ? name : 'void';
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem(KEY, t);
  document.querySelectorAll('.theme-swatch').forEach(el => {
    el.classList.toggle('active', el.dataset.theme === t);
  });
}

function buildPicker() {
  const panel = document.createElement('div');
  panel.className = 'theme-panel';
  THEMES.forEach(name => {
    const btn = document.createElement('button');
    btn.className = 'theme-swatch';
    btn.dataset.theme = name;
    btn.title = name;
    btn.setAttribute('aria-label', name + ' theme');
    btn.onclick = () => applyTheme(name);
    panel.appendChild(btn);
  });
  return panel;
}

function initThemePicker(triggerEl) {
  let panel = null;
  triggerEl.addEventListener('click', e => {
    e.stopPropagation();
    if (panel && panel.isConnected) { panel.remove(); return; }
    panel = buildPicker();
    triggerEl.parentElement.appendChild(panel);
    const current = localStorage.getItem(KEY) || 'void';
    panel.querySelectorAll('.theme-swatch').forEach(el => {
      el.classList.toggle('active', el.dataset.theme === current);
    });
  });
  document.addEventListener('click', () => { if (panel) panel.remove(); });
}

// Apply saved theme immediately on script load (before first paint)
applyTheme(localStorage.getItem(KEY) || 'void');

window.__initThemePicker = initThemePicker;
