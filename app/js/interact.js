// Pointer, wheel, keyboard, clipboard and drag & drop.
import { S, emit, getItem, select, snap, pushUndo, changed, selected, mutate, saveNow } from './state.js';
import { vp, screenToWorld, zoomAt, panBy } from './canvas.js';
import { box, center, contains, intersects, clamp } from './geom.js';
import { requestRender, elFor } from './render.js';
import { startEdit, endEdit } from './text.js';
import * as A from './actions.js';
import {
  run, openContextMenu, closeContextMenu, toggleArrowMode, openTagEditor, openSearch,
  videoToggle, editCenterTitle, fitView, togglePanel, toggleThreads, closeSearch,
} from './chrome.js';
import { handlePaste, ingest } from './media.js';
import { openMusicDialog } from './music.js';
import { modalOpen, toast } from './ui.js';
import { toggleCheck } from './markdown.js';
import { assetUrl } from './api.js';
import { go as goPiece, togglePiece } from './centers.js';

const overlay = document.getElementById('overlay');
const marquee = document.getElementById('marquee');
const R = Math.round;

let drag = null;
let spaceDown = false;
let lastClick = { t: 0, x: 0, y: 0, id: undefined };
let hoverVideo = null;

const boardOpen = () => S.name && !document.getElementById('board').hidden;

/** Topmost item at a world point. */
function itemAt(p, exclude) {
  for (let i = S.items.length - 1; i >= 0; i--) {
    const it = S.items[i];
    if (it.type !== 'arrow' && it.id !== exclude && contains(box(it), p)) return it.id;
  }
  return null;
}

// ---------------------------------------------------------------- pointer

vp.addEventListener('pointerdown', e => {
  closeContextMenu();
  if (e.target.closest('textarea.editor')) return;
  const p = screenToWorld(e.clientX, e.clientY);
  S.mouse = p;
  const id = e.target.closest('.item')?.dataset.id || e.target.closest('g.arrow')?.dataset.id;
  const base = { sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, start: p, moved: false, button: e.button, target: e.target, id };

  if (e.button === 1 || e.button === 2 || spaceDown) {
    e.preventDefault();
    drag = { ...base, kind: 'pan' };
  } else if (e.button !== 0) {
    return;
  } else {
    if (S.editing && id === S.editing) return;
    if (S.editing) endEdit();
    const it = id && getItem(id);
    if (it && e.target.dataset.handle === 'resize') {
      drag = { ...base, kind: 'resize', before: snap(), orig: { ...it, bh: box(it).h } };
    } else if (it && it.type !== 'arrow' && (e.altKey || S.arrowMode)) {
      drag = { ...base, kind: 'arrow' };
    } else if (it) {
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      const wasSelected = S.sel.has(id);
      if (additive && wasSelected) {
        S.sel.delete(id);
        emit('selection');
        requestRender();
        drag = { ...base, kind: 'none' };
      } else {
        if (!wasSelected) select([id], additive);
        drag = { ...base, kind: it.type === 'arrow' ? 'none' : 'move', before: snap(), wasSelected, ...moverSet() };
      }
    } else if (e.shiftKey) {
      drag = { ...base, kind: 'marquee', base: new Set(S.sel) };
    } else {
      drag = { ...base, kind: 'pan', empty: true };
    }
  }
  requestRender();
  vp.setPointerCapture(e.pointerId);
});

/** Where everything in the selection started, for dragging. */
function moverSet() {
  const movers = selected().filter(i => i.type !== 'arrow');
  return { orig: new Map(movers.map(it => [it.id, { x: it.x, y: it.y }])) };
}

addEventListener('pointermove', e => {
  if (!boardOpen()) return;
  const p = screenToWorld(e.clientX, e.clientY);
  S.mouse = p;
  if (!drag) return hover(e);
  if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 4) return;
  drag.moved = true;
  const d = drag;

  if (d.kind === 'pan') {
    vp.classList.add('panning');
    panBy(e.clientX - d.lx, e.clientY - d.ly);
  } else if (d.kind === 'move') {
    const dx = p.x - d.start.x, dy = p.y - d.start.y;
    for (const [id, o] of d.orig) {
      const it = getItem(id);
      if (it) { it.x = R(o.x + dx); it.y = R(o.y + dy); }
    }
    document.body.classList.add('dragging');
    requestRender();
  } else if (d.kind === 'resize') {
    resize(d, p, e.shiftKey);
    requestRender();
  } else if (d.kind === 'marquee') {
    const x = Math.min(d.sx, e.clientX), y = Math.min(d.sy, e.clientY);
    Object.assign(marquee.style, { left: x + 'px', top: y + 'px', width: Math.abs(e.clientX - d.sx) + 'px', height: Math.abs(e.clientY - d.sy) + 'px' });
    marquee.hidden = false;
    const a = d.start;
    const r = { x: Math.min(a.x, p.x), y: Math.min(a.y, p.y), w: Math.abs(p.x - a.x), h: Math.abs(p.y - a.y) };
    S.sel = new Set(d.base);
    for (const it of S.items) if (it.type !== 'arrow' && intersects(r, box(it))) S.sel.add(it.id);
    emit('selection');
    requestRender();
  } else if (d.kind === 'arrow') {
    const from = center(box(getItem(d.id)));
    const target = itemAt(p, d.id);
    const to = target ? center(box(getItem(target))) : p;
    overlay.innerHTML = `<path class="preview" d="M${from.x} ${from.y}L${to.x} ${to.y}"/>` +
      (target ? `<rect class="preview-target" x="${box(getItem(target)).x - 6}" y="${box(getItem(target)).y - 6}" width="${box(getItem(target)).w + 12}" height="${box(getItem(target)).h + 12}" rx="10"/>` : '');
  }
  d.lx = e.clientX;
  d.ly = e.clientY;
});

function resize(d, p, shift) {
  const it = getItem(d.id);
  const o = d.orig;
  const dx = p.x - d.start.x, dy = p.y - d.start.y;
  if (it.type === 'text') {
    if (shift) {
      const f = Math.max(0.1, (o.w + dx) / o.w);
      it.size = clamp(R(o.size * f), 8, 600);
      it.w = R(o.w * f);
      if (o.h) it.h = R(o.h * f);
    } else {
      it.w = Math.max(60, R(o.w + dx));
      if (Math.abs(dy) > 8 || o.bg) it.h = Math.max(30, R(o.bh + dy));
    }
  } else if (it.type === 'image' || it.type === 'video') {
    const w = Math.max(40, o.w + dx);
    it.w = R(w);
    it.h = shift ? Math.max(30, R(o.h + dy)) : R(w * (o.h / o.w));
  }
}

function endDrag(e) {
  if (!drag) return;
  const d = drag;
  drag = null;
  vp.classList.remove('panning');
  document.body.classList.remove('dragging');
  marquee.hidden = true;
  overlay.innerHTML = '';
  try { vp.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
  if (e.type === 'pointercancel') return;
  const p = screenToWorld(e.clientX, e.clientY);

  if (d.kind === 'pan' && !d.moved) {
    if (d.button === 2) return openContextMenu(e.clientX, e.clientY, d.id);
    if (d.empty) {
      if (!e.shiftKey && S.sel.size) select([]);
      clickCheck(null, p, e, null);
    }
  } else if (d.kind === 'move' || d.kind === 'resize') {
    if (d.moved) { pushUndo(d.before); changed(); }
    else if (d.kind === 'move') click(d, p, e);
  } else if (d.kind === 'arrow') {
    const target = itemAt(p, d.id);
    if (d.moved && target) A.addArrow(d.id, target);
    else if (!d.moved) select([d.id]);
  } else if (d.kind === 'none' && !d.moved) {
    clickCheck(d.id, p, e, d.target);
  }
  requestRender();
}
addEventListener('pointerup', endDrag);
addEventListener('pointercancel', endDrag);

/** A click (no drag) on an item. */
function click(d, p, e) {
  const it = getItem(d.id);
  const t = d.target;
  const check = t.closest?.('[data-check]');
  if (check && it.type === 'text') {
    mutate(() => (it.text = toggleCheck(it.text, +check.dataset.check)));
    return;
  }
  const link = t.closest?.('a[href]');
  if (link) { window.open(link.href, '_blank', 'noopener'); return; }
  const tag = t.closest?.('.tg');
  if (tag && d.wasSelected) { A.focusTag(tag.dataset.tag); return; }
  if (d.wasSelected && S.sel.size > 1 && !(e.shiftKey || e.ctrlKey || e.metaKey)) select([d.id]);
  clickCheck(d.id, p, e, t);
}

function clickCheck(id, p, e, target) {
  const now = performance.now();
  const dbl = now - lastClick.t < 380 && Math.hypot(e.clientX - lastClick.x, e.clientY - lastClick.y) < 8 && lastClick.id === id;
  lastClick = dbl ? { t: 0 } : { t: now, x: e.clientX, y: e.clientY, id };
  if (dbl) doubleClick(id, p, target);
}

function doubleClick(id, p, target) {
  const it = id && getItem(id);
  if (!it) return A.createText(p);
  if (target?.closest?.('.ctitle')) editCenterTitle(id);
  else if (it.type === 'text') startEdit(id);
  else if (it.type === 'video') videoToggle(id);
  else if (it.type === 'music') openMusicDialog({ targetId: id });
  else if (it.type === 'image') window.open(assetUrl(S.name, it.src), '_blank');
  else if (it.type === 'arrow') run('alabel');
}

function hover(e) {
  const t = e.target.closest?.('.tg')?.dataset.tag || null;
  if (t !== S.hoverTag) { S.hoverTag = t; requestRender(); }
  const v = e.target.closest?.('.item.video');
  if (v !== hoverVideo) {
    if (hoverVideo?._hoverPlay) { hoverVideo.querySelector('video').pause(); hoverVideo._hoverPlay = false; }
    hoverVideo = v;
    const vid = v?.querySelector('video');
    if (vid && vid.paused) { v._hoverPlay = true; vid.muted = true; vid.play().catch(() => {}); }
  }
}

// ---------------------------------------------------------------- wheel

vp.addEventListener('wheel', e => {
  e.preventDefault();
  closeContextMenu();
  const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
  if (e.ctrlKey || e.metaKey) {
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * unit * 0.01)); // pinch / ctrl+wheel
  } else if (e.shiftKey) {
    panBy(-(e.deltaX || e.deltaY) * unit, 0);
  } else if (Math.abs(e.deltaX) > 0.5) {
    panBy(-e.deltaX * unit, -e.deltaY * unit); // two-finger trackpad scroll
  } else {
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * unit * 0.0015));
  }
}, { passive: false });

vp.addEventListener('contextmenu', e => e.preventDefault());
vp.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); }); // no autoscroll on middle-drag
vp.addEventListener('scroll', () => { vp.scrollTop = 0; vp.scrollLeft = 0; });

// ---------------------------------------------------------------- keyboard

addEventListener('keydown', e => {
  if (!boardOpen() || modalOpen()) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key;

  if (k === ' ') {
    spaceDown = true;
    vp.classList.add('grab');
    e.preventDefault();
    return;
  }

  if (mod) {
    const step = e.shiftKey ? 20 : 2;
    const map = {
      arrowleft: () => A.nudge(-step, 0), arrowright: () => A.nudge(step, 0),
      arrowup: () => A.nudge(0, -step), arrowdown: () => A.nudge(0, step),
      z: () => run(e.shiftKey ? 'redo' : 'undo'), y: () => run('redo'), d: () => A.duplicate(),
      a: () => A.selectAll(), s: () => { saveNow(); toast('saved', 'quiet'); }, f: () => openSearch(),
      '=': () => run('zoomin'), '+': () => run('zoomin'), '-': () => run('zoomout'), 0: () => fitView(),
    };
    const fn = map[k.toLowerCase()];
    if (fn) { e.preventDefault(); fn(); }
    return; // ctrl+c / ctrl+v / ctrl+x go to the clipboard events
  }
  if (e.altKey) return;

  const byKey = {
    Escape: () => {
      if (!document.getElementById('searchbox').hidden) closeSearch();
      else if (S.arrowMode) toggleArrowMode(false);
      else if (S.focusTag) A.focusTag(S.focusTag);
      else select([]);
    },
    Delete: () => A.deleteSelection(),
    Backspace: () => A.deleteSelection(),
    Enter: () => { const [it] = selected(); if (it && S.sel.size === 1) A.startEditing(it.id); },
    ArrowLeft: () => goPiece(-1), ArrowRight: () => goPiece(1),
    '#': () => (S.sel.size ? openTagEditor() : togglePanel()),
    '?': () => run('help'),
    '/': () => openSearch(),
    '[': () => A.changeSize(-1),
    ']': () => A.changeSize(1),
    0: () => fitView(),
    1: () => run('zoom100'),
    '+': () => run('zoomin'), '=': () => run('zoomin'), '-': () => run('zoomout'),
  };
  // letters go by the character typed, so they match the key caps on any layout
  const byLetter = {
    t: () => (e.shiftKey ? run('theme') : A.createText()),
    h: () => A.createHeading(),
    n: () => A.createNote(),
    p: () => togglePiece(),
    a: () => toggleArrowMode(),
    m: () => (e.shiftKey ? run('sound') : run('music')),
    i: () => run('media'),
    v: () => run('clip'),
    f: () => A.cycleFont(e.shiftKey ? -1 : 1),
    c: () => A.cycleColor(),
    g: () => togglePanel(),
    l: () => toggleThreads(),
  };
  const fn = byKey[k] || (k.length === 1 && byLetter[k.toLowerCase()]);
  if (fn) { e.preventDefault(); fn(); }
});

addEventListener('keyup', e => {
  if (e.key === ' ') { spaceDown = false; vp.classList.remove('grab'); }
});
addEventListener('blur', () => { spaceDown = false; vp.classList.remove('grab'); });

// ---------------------------------------------------------------- clipboard & drop

const inField = e => e.target.closest?.('input, textarea, select');

document.addEventListener('copy', e => { if (boardOpen() && !inField(e) && !S.editing) A.copySelection(e); });
document.addEventListener('cut', e => { if (boardOpen() && !inField(e) && !S.editing) A.copySelection(e, true); });
document.addEventListener('paste', e => { if (boardOpen()) handlePaste(e); });

vp.addEventListener('dragover', e => {
  e.preventDefault();
  vp.classList.add('drop');
});
vp.addEventListener('dragleave', () => vp.classList.remove('drop'));
vp.addEventListener('drop', e => {
  e.preventDefault();
  vp.classList.remove('drop');
  ingest(e.dataTransfer, screenToWorld(e.clientX, e.clientY));
});

export function cancelDrag() {
  drag = null;
}
