// Small UI kit: toasts, modals, prompts and themes.
import { icon, hydrateIcons } from './doodle.js';
import { esc } from './markdown.js';
import { emit } from './state.js';

const toasts = document.getElementById('toasts');
const modalRoot = document.getElementById('modal-root');

export function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast sketch ${kind}`;
  el.innerHTML = (kind === 'busy' ? '<span class="spin"></span>' : '') + `<span class="msg">${esc(msg)}</span>`;
  toasts.appendChild(el);
  const close = () => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 250);
  };
  if (kind !== 'busy') setTimeout(close, kind === 'error' ? 6000 : kind === 'quiet' ? 1200 : 2600);
  return { close, set: m => (el.querySelector('.msg').textContent = m) };
}

let openModals = 0;
export const modalOpen = () => openModals > 0;

export function modal({ title, body, cls = '', onClose, docked = false }) {
  const back = document.createElement('div');
  // docked dialogs sit at the side and leave the board visible and usable
  back.className = docked ? 'modal-back docked' : 'modal-back';
  back.innerHTML = `<div class="modal sketch ${cls}" role="dialog" aria-label="${esc(title)}">` +
    `<button class="btn icon x" data-act="x" title="close (esc)">${icon('close')}</button>` +
    `<h2>${title}</h2><div class="mbody">${body}</div></div>`;
  modalRoot.appendChild(back);
  hydrateIcons(back);
  openModals++;
  let closed = false;
  const m = {
    el: back.querySelector('.modal'),
    $: sel => back.querySelector(sel),
    get closed() { return closed; },
    close() {
      if (closed) return;
      closed = true;
      openModals--;
      back.classList.add('out');
      setTimeout(() => back.remove(), 180);
      onClose?.();
    },
  };
  back.addEventListener('pointerdown', e => { if (e.target === back && !docked) m.close(); });
  back.addEventListener('click', e => { if (e.target.closest('[data-act="x"]')) m.close(); });
  back.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Escape') m.close();
  });
  requestAnimationFrame(() => (back.querySelector('[autofocus]') || back.querySelector('input,select,button:not(.x)'))?.focus());
  return m;
}

export function promptText(title, value = '', placeholder = '', okLabel = 'ok') {
  return new Promise(resolve => {
    let result = null;
    const m = modal({
      title,
      body: `<input class="input" autofocus placeholder="${esc(placeholder)}" value="${esc(value)}">` +
        `<div class="actions"><span class="grow"></span><button class="btn txt" data-act="cancel">cancel</button>` +
        `<button class="btn txt primary" data-act="ok">${esc(okLabel)}</button></div>`,
      onClose: () => resolve(result),
    });
    const input = m.$('input');
    requestAnimationFrame(() => { input.focus(); input.select(); });
    const ok = () => { result = input.value.trim(); m.close(); };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
    m.$('[data-act="ok"]').onclick = ok;
    m.$('[data-act="cancel"]').onclick = () => m.close();
  });
}

export function confirmBox(title, message, okLabel = 'yes') {
  return new Promise(resolve => {
    let result = false;
    const m = modal({
      title,
      body: `<p>${message}</p><div class="actions"><span class="grow"></span>` +
        `<button class="btn txt" data-act="cancel">nope</button><button class="btn txt primary danger" data-act="ok">${esc(okLabel)}</button></div>`,
      onClose: () => resolve(result),
    });
    m.$('[data-act="ok"]').onclick = () => { result = true; m.close(); };
    m.$('[data-act="cancel"]').onclick = () => m.close();
  });
}

// ---------------------------------------------------------------- themes

export const THEMES = ['pink', 'blue', 'red'];
export const THEME_LABEL = { pink: 'cream & hot pink', blue: 'cream & blue', red: 'cream & red' };

function readTheme() {
  try { return localStorage.getItem('doodle-theme'); } catch { return null; }
}

export function setTheme(t) {
  if (!THEMES.includes(t)) t = 'pink';
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('doodle-theme', t); } catch { /* private mode */ }
  emit('theme', t);
}

export function cycleTheme() {
  const cur = document.documentElement.dataset.theme;
  const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
  setTheme(next);
  toast(`theme · ${THEME_LABEL[next]}`, 'quiet');
}

setTheme(readTheme() || 'pink');
