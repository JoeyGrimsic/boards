// Commands: creating things, styling, ordering, copy/paste between boards.
import { S, uid, addItem, mutate, getItem, selected, removeItems, select, snap, changed, emit } from './state.js';
import { viewCenter, viewBox, flyTo, itemsBox } from './canvas.js';
import { startEdit, endEdit } from './text.js';
import { FONT_ORDER, FONT_LABEL, INKS, PAPERS, requestRender } from './render.js';
import { box, union, contains, clamp } from './geom.js';
import { itemTags } from './tags.js';
import { toast } from './ui.js';
import { editCenterTitle } from './chrome.js';
import { api } from './api.js';
import { normalizeMusic, tracksOf } from './music.js';

const theme = () => document.documentElement.dataset.theme;
const R = Math.round;

/** Where new things go: under the pointer if it's on screen, else the middle. */
export function spot() {
  return contains(viewBox(), S.mouse) ? { ...S.mouse } : viewCenter();
}

/** Like mutate(), but while typing just apply (the edit session owns undo). */
function apply(fn) {
  if (S.editing) { fn(); changed(); requestRender(); } else mutate(fn);
}

// ---------------------------------------------------------------- create

export function createText(p = spot(), opts = {}) {
  endEdit();
  const before = snap();
  const it = addItem({
    id: uid(), type: 'text', x: R(p.x - 10), y: R(p.y - 20), w: 300, h: 0,
    text: '', font: 'print', size: 24, color: 'ink', bg: null, ...opts,
  });
  changed();
  startEdit(it.id, { undoBase: before });
  return it;
}

export const createHeading = (p = spot()) =>
  createText({ x: p.x, y: p.y - 20 }, { font: 'marker', size: 60, w: 640 });

export const createNote = (p = spot()) =>
  createText({ x: p.x - 110, y: p.y - 80 }, {
    font: 'hand', size: 30, w: 240, h: 200, bg: { blue: 'sky', red: 'peach' }[theme()] || 'pink',
  });

export function addArrow(from, to) {
  if (!from || !to || from === to) return;
  if (S.items.some(a => a.type === 'arrow' && a.from === from && a.to === to)) return;
  const a = mutate(() => addItem({ id: uid(), type: 'arrow', from, to, color: 'ink', label: '' }));
  select([a.id]);
}

// ---------------------------------------------------------------- edit

export function deleteSelection() {
  if (!S.sel.size) return;
  mutate(() => removeItems([...S.sel]));
}

export function duplicate() {
  const items = selected().filter(i => i.type !== 'arrow');
  if (!items.length) return;
  const map = new Map();
  mutate(() => {
    for (const it of items) {
      const c = JSON.parse(JSON.stringify(it));
      c.id = uid();
      c.x += 30;
      c.y += 30;
      map.set(it.id, c.id);
      addItem(c);
    }
    for (const a of S.items.filter(a => a.type === 'arrow' && map.has(a.from) && map.has(a.to)))
      addItem({ ...a, id: uid(), from: map.get(a.from), to: map.get(a.to) });
  });
  select([...map.values()]);
}

export function bringToFront() {
  mutate(() => {
    const sel = S.items.filter(i => S.sel.has(i.id));
    S.items = S.items.filter(i => !S.sel.has(i.id)).concat(sel);
  });
}

export function sendToBack() {
  mutate(() => {
    const sel = S.items.filter(i => S.sel.has(i.id));
    S.items = sel.concat(S.items.filter(i => !S.sel.has(i.id)));
  });
}

export function selectAll() {
  endEdit();
  select(S.items.filter(i => i.type !== 'arrow').map(i => i.id));
}

export function nudge(dx, dy) {
  const items = selected().filter(i => i.type !== 'arrow');
  if (items.length) mutate(() => items.forEach(i => { i.x += dx; i.y += dy; }));
}

// ---------------------------------------------------------------- style

export function cycleFont(dir = 1) {
  const texts = selected().filter(i => i.type === 'text');
  if (!texts.length) return;
  const cur = FONT_ORDER.indexOf(texts[0].font);
  const next = FONT_ORDER[(cur + dir + FONT_ORDER.length) % FONT_ORDER.length];
  apply(() => texts.forEach(t => (t.font = next)));
  toast(`font · ${FONT_LABEL[next]}`, 'quiet');
}

export function setFont(font) {
  const texts = selected().filter(i => i.type === 'text');
  apply(() => texts.forEach(t => (t.font = font)));
}

export function changeSize(dir) {
  const f = dir > 0 ? 1.15 : 1 / 1.15;
  const items = selected();
  if (!items.length) return;
  apply(() => {
    for (const it of items) {
      if (it.type === 'text') it.size = clamp(R((it.size || 24) * f), 8, 600);
      else if (it.type === 'image' || it.type === 'video') {
        const w = R(it.w * f), h = R(it.h * f);
        it.x = R(it.x - (w - it.w) / 2);
        it.y = R(it.y - (h - it.h) / 2);
        it.w = w;
        it.h = h;
      }
    }
  });
}

export function cycleColor() {
  const items = selected();
  if (!items.length) return;
  const inks = Object.keys(INKS), papers = Object.keys(PAPERS);
  const next = (list, cur) => list[(list.indexOf(cur) + 1) % list.length];
  apply(() => {
    for (const it of items) {
      if (it.type === 'text' && it.bg) it.bg = next(papers, it.bg);
      else if (['text', 'arrow'].includes(it.type)) it.color = next(inks, it.color || 'ink');
    }
  });
}

export function setInk(key) {
  apply(() => selected().forEach(it => {
    if (['text', 'arrow'].includes(it.type)) it.color = key;
  }));
}

export function setPaper(key) {
  apply(() => selected().forEach(it => {
    if (it.type !== 'text') return;
    it.bg = key;
    if (key && !it.h) it.h = 120;
    if (!key) it.h = 0;
  }));
}

// ---------------------------------------------------------------- tags

export function focusTag(tag) {
  S.focusTag = S.focusTag === tag ? null : tag;
  if (S.focusTag) {
    const items = S.items.filter(i => i.type !== 'arrow' && itemTags(i).has(tag));
    flyTo(itemsBox(items), { maxZ: 1 });
  }
  emit('focus');
  requestRender();
}

/** Update the manual tags of several items: fn(oldTags) -> newTags */
export function setTagsFor(ids, fn) {
  mutate(() => ids.map(getItem).filter(Boolean).forEach(it => (it.tags = fn(it.tags || []))));
}

// ---------------------------------------------------------------- clipboard (items)

export function copySelection(e, cut = false) {
  const items = selected();
  if (!items.length) return false;
  const ids = new Set(items.map(i => i.id));
  const arrows = S.items.filter(a => a.type === 'arrow' && ids.has(a.from) && ids.has(a.to) && !ids.has(a.id));
  const data = { board: S.name, items: JSON.parse(JSON.stringify([...items, ...arrows])) };
  e.clipboardData.setData('text/plain', 'doodleboard:' + JSON.stringify(data));
  e.preventDefault();
  if (cut) deleteSelection();
  return true;
}

export async function pasteItems(data, p = spot()) {
  const nodes = data.items.filter(i => i.type !== 'arrow');
  if (!nodes.length) return;
  const b = union(nodes.map(box));
  const dx = R(p.x - (b.x + b.w / 2)), dy = R(p.y - (b.y + b.h / 2));
  if (data.board && data.board !== S.name) {
    // bring media files along from the other board's folder
    for (const it of nodes) {
      normalizeMusic([it]);
      for (const holder of [it, ...tracksOf(it.music)]) {
        if (!holder?.src || /^(https?|data|blob):/.test(holder.src)) continue;
        try { holder.src = (await api.importAsset(S.name, data.board, holder.src)).src; }
        catch (err) { toast(`couldn't copy ${holder.src}: ${err.message}`, 'error'); }
      }
    }
  }
  const map = new Map();
  mutate(() => {
    for (const it of nodes) {
      const c = { ...it, id: uid(), x: it.x + dx, y: it.y + dy };
      map.set(it.id, c.id);
      addItem(c);
    }
    for (const a of data.items.filter(a => a.type === 'arrow' && map.has(a.from) && map.has(a.to)))
      addItem({ ...a, id: uid(), from: map.get(a.from), to: map.get(a.to) });
  });
  select([...map.values()]);
}

export function startEditing(id) {
  const it = getItem(id);
  if (it?.type === 'text') startEdit(id);
  else if (it?.center) editCenterTitle(id);
}
