// Keeps boards smooth no matter how many GIFs they hold. Only GIFs that are on
// screen and big enough to see actually animate (largest first, up to a
// budget); every other one shows a still frame grabbed from itself, and its
// animation is unloaded so the browser stops decoding it. Still frames are
// kept as small ordinary images (painting <canvas> elements is much slower).
import { S, on, getItem } from './state.js';
import { viewBox } from './canvas.js';
import { box, intersects } from './geom.js';

const BUDGET = 16;       // most GIFs animating at the same time
const MIN_PX = 56;       // smaller than this on screen and a still frame looks the same
const POSTER_MAX = 480;  // still frames are kept at most this big
const MAX_LOADS = 4;     // GIFs loading at once just to grab their still frame

export const isAnimated = src => /\.(gif|webp)(\?|#|$)/i.test(src || '');

const tracked = new Map(); // item id -> { img, cv, url, poster, want, loading }

/** Called by the renderer for every animated image item. */
export function track(el, id, url) {
  let st = tracked.get(id);
  if (st && st.url === url && st.img === el.querySelector('img:not(.poster)')) return;
  st = { id, img: el.querySelector('img:not(.poster)'), cv: el.querySelector('img.poster'), url, poster: false, want: 'off', loading: false };
  tracked.set(id, st);
  st.img.onload = () => loaded(st);
  st.img.onerror = () => { st.loading = false; };
  drop(st);
  schedule();
}

export function untrack(id) {
  const st = tracked.get(id);
  if (st) drop(st);
  tracked.delete(id);
}

export function untrackAll() {
  for (const id of [...tracked.keys()]) untrack(id);
}

/** Show / hide without touching the page when nothing changes. */
const vis = (el, on) => { if (el.hidden === on) el.hidden = !on; };

function drop(st) {
  st.img.onload = st.img.onerror = null;
  st.img.removeAttribute('src');
  st.img.onload = () => loaded(st);
  st.img.onerror = () => { st.loading = false; };
  st.loading = false;
}

function grabPoster(st) {
  const { naturalWidth: w, naturalHeight: h } = st.img;
  if (!w || !h) return;
  const s = Math.min(1, POSTER_MAX / Math.max(w, h));
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(w * s));
  cv.height = Math.max(1, Math.round(h * s));
  try {
    cv.getContext('2d').drawImage(st.img, 0, 0, cv.width, cv.height);
  } catch { return; /* leave it animated if the frame can't be read */ }
  st.cv.src = cv.toDataURL('image/webp', 0.9); // webp keeps transparency and stays small
  st.poster = true;
}

function loaded(st) {
  st.loading = false;
  if (!st.poster) grabPoster(st);
  if (st.want === 'play') {
    vis(st.img, true);
    vis(st.cv, false);
  } else {
    show(st); // it was only loaded for its still frame
  }
}

/** Put a GIF into the state the scheduler picked for it. */
function show(st) {
  if (st.want === 'play') {
    if (!st.img.getAttribute('src')) {
      st.loading = true;
      st.img.src = st.url; // shown once loaded; the still frame covers the gap
      if (st.poster) { vis(st.cv, true); vis(st.img, false); }
    } else if (!st.loading) {
      vis(st.img, true);
      vis(st.cv, false);
    }
    return;
  }
  if (st.poster) {
    vis(st.cv, true);
    vis(st.img, false);
    if (st.img.getAttribute('src')) drop(st); // stop decoding it
  } else if (st.want === 'off') {
    if (st.img.getAttribute('src') && !st.loading) drop(st);
  }
}

let queued = false;
export function schedule() {
  if (queued) return;
  queued = true;
  setTimeout(evaluate, 120);
}

function evaluate() {
  queued = false;
  if (!S.name || !tracked.size) return;
  const vb = viewBox();
  const z = S.cam.z;
  const m = 200 / z;
  const near = { x: vb.x - m, y: vb.y - m, w: vb.w + 2 * m, h: vb.h + 2 * m };
  const candidates = [];
  for (const [id, st] of tracked) {
    const it = getItem(id);
    if (!it) continue;
    const b = box(it);
    if (!intersects(near, b)) { st.want = 'off'; continue; }
    if (Math.min(b.w, b.h) * z < MIN_PX) { st.want = 'still'; continue; }
    const ix = Math.max(0, Math.min(b.x + b.w, vb.x + vb.w) - Math.max(b.x, vb.x));
    const iy = Math.max(0, Math.min(b.y + b.h, vb.y + vb.h) - Math.max(b.y, vb.y));
    candidates.push([st, ix * iy]);
  }
  // the biggest on screen get to move
  candidates.sort((a, b) => b[1] - a[1]);
  candidates.forEach(([st], i) => { st.want = i < BUDGET ? 'play' : 'still'; });

  let loading = [...tracked.values()].filter(s => s.loading).length;
  for (const st of tracked.values()) {
    // a visible GIF with no still frame yet has to load once to get one
    if (st.want === 'still' && !st.poster && !st.img.getAttribute('src')) {
      if (loading >= MAX_LOADS) { schedule(); continue; }
      loading++;
      st.loading = true;
      st.img.src = st.url;
      continue;
    }
    show(st);
  }
}

on('camera', schedule);
on('rendered', schedule);
