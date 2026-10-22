// Center pieces: the main stops of a board. ← / → hop between them in
// left-to-right order and loop around; the bar at the top shows where you are.
import { S, on, getItem, mutate, selected } from './state.js';
import { box, center, contains } from './geom.js';
import { flyCam, camFor, viewCenter, viewBox } from './canvas.js';
import { esc } from './markdown.js';
import { toast } from './ui.js';
import { editCenterTitle } from './chrome.js';

const bar = document.getElementById('centerbar');
let current = null; // id of the piece we last flew to

/** All center pieces, left to right (top to bottom when they line up). */
export function pieces() {
  return S.items
    .filter(i => i.center && i.type !== 'arrow')
    .map(it => ({ it, c: center(box(it)) }))
    .sort((a, b) => a.c.x - b.c.x || a.c.y - b.c.y)
    .map(p => p.it);
}

/** A sensible title from the item itself, used until you name it. */
export function defaultTitle(it) {
  const line = (it.text || '').split('\n').find(l => l.trim()) || '';
  const clean = line.replace(/^#+\s+|^[-*]\s+|^\[[ xX]\]\s*/, '').replace(/[*_~`]/g, '').trim();
  const file = it.src?.split('/').pop().replace(/(-[0-9a-f]{8})?\.\w+$/, '');
  return (clean || it.music?.tracks?.[0]?.title || file || 'untitled').slice(0, 40);
}

export const pieceTitle = it => it.center?.title || defaultTitle(it);

/** The piece you're looking at right now, as an index into `list` (or -1).
 *  It has to be near the middle of the screen and big enough to be the focus. */
function currentIndex(list) {
  const vb = viewBox();
  const middle = { x: vb.x + vb.w * 0.25, y: vb.y + vb.h * 0.25, w: vb.w * 0.5, h: vb.h * 0.5 };
  const inFocus = it => {
    const b = box(it);
    return contains(middle, center(b)) && (b.w > vb.w * 0.2 || b.h > vb.h * 0.2);
  };
  const i = list.findIndex(it => it.id === current);
  if (i >= 0 && inFocus(list[i])) return i;
  const vc = viewCenter();
  let best = -1, bestD = Infinity;
  list.forEach((it, k) => {
    if (!inFocus(it)) return;
    const c = center(box(it));
    const d = Math.hypot(c.x - vc.x, c.y - vc.y);
    if (d < bestD) { best = k; bestD = d; }
  });
  return best;
}

/** Neighbours of the current view: the pieces to the left and right of it. */
function around() {
  const list = pieces();
  const n = list.length;
  if (!n) return null;
  const i = currentIndex(list);
  if (i >= 0) return { list, i, prev: list[(i - 1 + n) % n], next: list[(i + 1) % n] };
  const vc = viewCenter();
  let r = list.findIndex(it => center(box(it)).x > vc.x);
  if (r < 0) r = 0;
  return { list, i: -1, prev: list[(r - 1 + n) % n], next: list[r] };
}

export function go(dir) {
  const a = around();
  if (!a) {
    toast('no center pieces yet — select something and press P', 'quiet');
    return;
  }
  const n = a.list.length;
  const target = a.i >= 0 ? a.list[(a.i + dir + n) % n] : dir > 0 ? a.next : a.prev;
  flyToPiece(target);
}

export function flyToPiece(it) {
  current = it.id;
  const b = box(it);
  // leave room for the title above it
  flyCam(camFor({ x: b.x, y: b.y - 60, w: b.w, h: b.h + 60 }, { pad: 120, maxZ: 1.4 }), 520);
}

/** P: make the selection a center piece, or stop it being one. */
export function togglePiece() {
  const items = selected().filter(i => i.type !== 'arrow');
  if (!items.length) {
    toast('select something first, then press P', 'quiet');
    return;
  }
  const allOn = items.every(i => i.center);
  mutate(() => items.forEach(it => {
    if (allOn) delete it.center;
    else if (!it.center) it.center = { title: defaultTitle(it) };
  }));
  if (allOn) toast(items.length > 1 ? 'no longer center pieces' : 'no longer a center piece', 'quiet');
  else if (items.length === 1) requestAnimationFrame(() => editCenterTitle(items[0].id));
}

// ---------------------------------------------------------------- the bar

let queued = false;
function draw() {
  queued = false;
  const a = S.name && around();
  bar.hidden = !a;
  if (!a) return;
  const n = a.list.length;
  const here = a.i >= 0 ? a.list[a.i] : null;
  bar.innerHTML =
    `<button class="btn txt side" data-cmd="prevpiece" title="previous center piece (←)"><span class="chev">‹</span><span class="nm">${esc(pieceTitle(a.prev))}</span></button>` +
    `<div class="now">${here ? `<b>✶ ${esc(pieceTitle(here))}</b>` : '<i>between pieces</i>'}` +
    `<span class="dots">${a.list.map((it, k) => `<i class="${k === a.i ? 'on' : ''}" data-piece="${it.id}" title="${esc(pieceTitle(it))}"></i>`).join('')}</span></div>` +
    `<button class="btn txt side" data-cmd="nextpiece" title="next center piece (→)"><span class="nm">${esc(pieceTitle(a.next))}</span><span class="chev">›</span></button>`;
  bar.classList.toggle('single', n === 1);
}

const queue = () => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(draw);
};
on('camera-settled', queue);
on('change', queue);
on('rendered', queue);

bar.addEventListener('click', e => {
  const dot = e.target.closest('[data-piece]');
  const it = dot && getItem(dot.dataset.piece);
  if (it) flyToPiece(it);
});

export function resetPieces() {
  current = null;
  queue();
}
