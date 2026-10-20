// Entry point: routing between the board picker and a board.
import './ui.js';
import { S, reindex, resetHistory, saveNow, scheduleSave, isDirty, serialize, emit, on } from './state.js';
import { api } from './api.js';
import { applyCamera, fitAll } from './canvas.js';
import { clearAll, renderNow, invalidate } from './render.js';
import { initChrome, showBoardName, syncButtons, togglePanel } from './chrome.js';
import { stopAll, normalizeMusic } from './music.js';
import { showHome } from './home.js';
import { toast } from './ui.js';
import { endEdit } from './text.js';
import { resetPieces } from './centers.js';
import './interact.js';

const boardEl = document.getElementById('board');
const homeEl = document.getElementById('home');

async function closeBoard() {
  if (!S.name) return;
  endEdit();
  await saveNow();
  stopAll();
  S.name = null;
  S.items = [];
  reindex();
  S.sel.clear();
  clearAll();
  togglePanel(false);
  boardEl.hidden = true;
}

async function openBoard(name) {
  if (S.name === name && !boardEl.hidden) return;
  await closeBoard();
  let data;
  try {
    data = await api.loadBoard(name);
  } catch (e) {
    toast(e.message, 'error');
    location.hash = '#/';
    return;
  }
  S.name = data.name || name;
  S.items = Array.isArray(data.items) ? data.items.filter(i => i && i.id && i.type) : [];
  // zones were retired: drop them (and arrows that pointed at them)
  const ids = new Set(S.items.filter(i => i.type !== 'zone').map(i => i.id));
  S.items = S.items.filter(i => ids.has(i.id) && (i.type !== 'arrow' || (ids.has(i.from) && ids.has(i.to))));
  normalizeMusic(S.items);
  S.musicPreview = null;
  reindex();
  S.sel.clear();
  S.editing = null;
  S.focusTag = null;
  S.hoverTag = null;
  S.matches = new Set();
  S.showThreads = data.settings?.threads !== false;
  resetHistory();
  clearAll();
  homeEl.hidden = true;
  boardEl.hidden = false;
  showBoardName();
  syncButtons();
  renderNow();
  if (data.camera && isFinite(data.camera.z) && data.camera.z > 0) {
    Object.assign(S.cam, data.camera);
    applyCamera(false);
  } else {
    fitAll(false);
  }
  emit('selection');
  emit('savestate', 'saved');
  resetPieces();
  // handwriting fonts change text heights once they load
  document.fonts?.ready.then(() => invalidate());
}

async function route() {
  const m = location.hash.match(/^#\/b\/(.+)$/);
  if (m) await openBoard(decodeURIComponent(m[1]));
  else {
    await closeBoard();
    await showHome();
  }
}

on('settings', () => scheduleSave());
on('theme', () => invalidate());

addEventListener('hashchange', route);
addEventListener('beforeunload', () => {
  if (S.name && isDirty()) api.beaconSave(S.name, serialize());
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveNow();
});

initChrome();
route();
