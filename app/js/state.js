// Board state, undo history, autosave and a tiny event bus.
import { api } from './api.js';

export const S = {
  name: null,            // board (folder) name
  items: [],             // everything on the canvas, in z-order
  byId: new Map(),
  sel: new Set(),        // selected ids
  editing: null,         // id of the text item being edited
  cam: { x: 0, y: 0, z: 1 },
  focusTag: null,        // tag being focused (others dimmed)
  hoverTag: null,
  showThreads: true,
  mouse: { x: 0, y: 0 }, // last pointer position in world coords
  measured: new Map(),   // id -> rendered height for auto-height text
  arrowMode: false,
  matches: new Set(),    // search hits
};

// ---------------------------------------------------------------- events
const listeners = {};
export const on = (evt, fn) => (listeners[evt] ||= []).push(fn);
export const off = (evt, fn) => { listeners[evt] = (listeners[evt] || []).filter(f => f !== fn); };
export const emit = (evt, data) => (listeners[evt] || []).forEach(fn => fn(data));

// ---------------------------------------------------------------- items
export const uid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
export const getItem = id => S.byId.get(id);
const strip = (k, v) => (k.startsWith('_') ? undefined : v);

export function reindex() {
  S.byId = new Map(S.items.map(i => [i.id, i]));
}

export function changed() {
  emit('change');
  scheduleSave();
}

export function addItem(item) {
  S.items.push(item);
  S.byId.set(item.id, item);
  return item;
}

/** Remove items (and any arrows attached to them). */
export function removeItems(ids) {
  const gone = new Set(ids);
  for (const it of S.items)
    if (it.type === 'arrow' && (gone.has(it.from) || gone.has(it.to))) gone.add(it.id);
  S.items = S.items.filter(i => !gone.has(i.id));
  reindex();
  for (const id of gone) S.sel.delete(id);
  emit('selection');
}

export function select(ids, additive = false) {
  if (!additive) S.sel.clear();
  for (const id of ids) S.sel.add(id);
  emit('selection');
}

export const selected = () => [...S.sel].map(getItem).filter(Boolean);

// ---------------------------------------------------------------- history
const undoStack = [];
const redoStack = [];

export const snap = () => JSON.stringify(S.items, strip);

export function pushUndo(before) {
  if (before === snap()) return;
  undoStack.push(before);
  if (undoStack.length > 300) undoStack.shift();
  redoStack.length = 0;
}

/** Run a change as one undoable step. */
export function mutate(fn) {
  const before = snap();
  const out = fn();
  pushUndo(before);
  changed();
  return out;
}

function restore(json) {
  S.items = JSON.parse(json);
  reindex();
  S.sel = new Set([...S.sel].filter(id => S.byId.has(id)));
  changed();
  emit('selection');
}

export function undo() {
  if (!undoStack.length) return false;
  redoStack.push(snap());
  restore(undoStack.pop());
  return true;
}

export function redo() {
  if (!redoStack.length) return false;
  undoStack.push(snap());
  restore(redoStack.pop());
  return true;
}

export function resetHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
}

// ---------------------------------------------------------------- saving
let saveTimer = null;
let saving = false;
let dirty = false;

export function serialize() {
  return JSON.parse(JSON.stringify({
    version: 1,
    camera: S.cam,
    settings: { threads: S.showThreads },
    items: S.items,
  }, strip));
}

export function scheduleSave(delay = 600) {
  if (!S.name) return;
  dirty = true;
  emit('savestate', 'dirty');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, delay);
}

export async function saveNow() {
  clearTimeout(saveTimer);
  if (!S.name || !dirty) return;
  if (saving) { saveTimer = setTimeout(saveNow, 250); return; }
  saving = true;
  dirty = false;
  emit('savestate', 'saving');
  try {
    await api.saveBoard(S.name, serialize());
    emit('savestate', dirty ? 'dirty' : 'saved');
  } catch (e) {
    dirty = true;
    emit('savestate', 'error');
    console.error(e);
    saveTimer = setTimeout(saveNow, 3000);
  } finally {
    saving = false;
  }
}

export const isDirty = () => dirty;
