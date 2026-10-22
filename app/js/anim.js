// Images at the right level of detail, so a board can hold any number of them.
//
// Every image gets a small preview (made once, off the main thread, and saved
// in the board's .thumbs folder so it's never made again). An image that's
// small on screen shows its preview; one that's big shows the original. GIFs
// only animate while visible and big enough, the biggest first, up to a budget;
// the rest show their preview. Originals that were loaded stay loaded (just
// hidden), so zooming back and forth never re-downloads or re-decodes them.
import { S, on, getItem } from './state.js';
import { viewBox, isMoving } from './canvas.js';
import { box, intersects } from './geom.js';
import { api, assetUrl } from './api.js';
import { hash } from './doodle.js';

const BUDGET = 16;   // most GIFs animating at the same time
const MIN_PX = 56;   // a GIF smaller than this on screen doesn't need to move
const THUMB = 384;   // preview size (longest side)
const MAKERS = 2;    // previews being made at once

export const isAnimated = src => /\.(gif|webp)(\?|#|$)/i.test(src || '');

const thumbFile = src => hash(src).toString(16).padStart(8, '0') + '.webp';

const tracked = new Map(); // item id -> state

/** Called by the renderer whenever an image item is created or its file changes. */
export function trackImage(el, it) {
  const prev = tracked.get(it.id);
  if (prev && prev.el === el && prev.src === it.src) return;
  const st = {
    id: it.id, el, src: it.src, url: assetUrl(S.name, it.src), gif: isAnimated(it.src),
    full: el.querySelector('img.full'), thumb: el.querySelector('img.thumb'),
    thumbState: 'unknown', // unknown -> ok | missing -> making -> ok | failed
    want: 'off', lod: null,
  };
  tracked.set(it.id, st);
  st.full.removeAttribute('src');
  st.thumb.removeAttribute('src');
  st.thumb.onload = () => { st.thumbState = 'ok'; schedule(); };
  st.thumb.onerror = () => {
    if (st.thumbState === 'unknown') { st.thumbState = 'missing'; queueMake(st); }
    schedule();
  };
  schedule();
}

export function untrack(id) {
  tracked.delete(id);
}

export function untrackAll() {
  tracked.clear();
  queue.length = 0;
}

// ---------------------------------------------------------------- choosing what to show

let queued = false;
export function schedule() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(evaluate);
}

function evaluate() {
  queued = false;
  if (!S.name || !tracked.size || isMoving()) return; // 'camera-settled' runs us again
  const vb = viewBox();
  const z = S.cam.z;
  const gifs = [];
  for (const st of tracked.values()) {
    const it = getItem(st.id);
    if (!it || !st.el._on) { st.want = 'off'; continue; } // culled: not drawn at all
    // ask for the saved preview the first time the image comes near the screen
    if (st.thumbState === 'unknown' && !st.thumb.getAttribute('src')) st.thumb.src = assetUrl(S.name, '.thumbs/' + thumbFile(st.src));
    const b = box(it);
    const px = Math.max(b.w, b.h) * z;
    if (st.gif) {
      st.want = 'thumb';
      if (px >= MIN_PX && intersects(vb, b)) {
        const ix = Math.max(0, Math.min(b.x + b.w, vb.x + vb.w) - Math.max(b.x, vb.x));
        const iy = Math.max(0, Math.min(b.y + b.h, vb.y + vb.h) - Math.max(b.y, vb.y));
        gifs.push([st, ix * iy]);
      }
    } else {
      st.want = px > THUMB * 0.9 ? 'full' : 'thumb';
    }
  }
  gifs.sort((a, b) => b[1] - a[1]);
  for (let i = 0; i < Math.min(BUDGET, gifs.length); i++) gifs[i][0].want = 'full';
  for (const st of tracked.values()) show(st);
  pump();
}

function show(st) {
  if (st.want === 'off') return; // hidden by culling; leave it as it was
  let lod = st.want;
  if (lod === 'thumb' && st.thumbState !== 'ok') {
    // no preview yet: a plain placeholder for the moment (loading every original
    // at once is exactly what makes a big board stutter), unless it can't have one
    lod = st.thumbState === 'failed' ? 'full' : 'wait';
    if (st.thumbState === 'missing') queueMake(st);
  }
  if (lod === 'full' && !st.full.getAttribute('src')) st.full.src = st.url;
  if (st.lod !== lod) {
    st.lod = lod;
    st.el.dataset.lod = lod;
  }
}

// ---------------------------------------------------------------- making previews

const queue = [];
let making = 0;

function queueMake(st) {
  if (st.thumbState === 'making') return;
  st.thumbState = 'making';
  queue.push(st);
  pump();
}

function pump() {
  // previews are made off the main thread, so this can keep going while you move
  while (making < MAKERS && queue.length) {
    const st = queue.shift();
    if (tracked.get(st.id) !== st) continue;
    making++;
    makeThumb(st).finally(() => { making--; pump(); });
  }
}

/** Shrink an image file to a small WebP preview (decoding happens off the main thread). */
async function previewOf(blob, tall) {
  const bmp = await createImageBitmap(blob, tall
    ? { resizeHeight: THUMB, resizeQuality: 'medium' }
    : { resizeWidth: THUMB, resizeQuality: 'medium' });
  const cv = new OffscreenCanvas(bmp.width, bmp.height);
  cv.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close();
  return cv.convertToBlob({ type: 'image/webp', quality: 0.82 });
}

/** Make and save the preview for a just-added image file (the file is already in memory). */
export async function prepareThumb(board, src, file, tall) {
  try {
    await api.saveThumb(board, thumbFile(src), await previewOf(file, tall));
  } catch { /* it'll be made later when the image is shown */ }
}

async function makeThumb(st) {
  const board = S.name;
  try {
    const blob = await (await fetch(st.url)).blob();
    const it = getItem(st.id);
    const out = await previewOf(blob, it && it.h > it.w);
    if (S.name !== board || tracked.get(st.id) !== st) return;
    api.saveThumb(board, thumbFile(st.src), out).catch(() => {});
    st.thumbState = 'unknown';
    st.thumb.src = URL.createObjectURL(out); // onload marks it ready
  } catch {
    st.thumbState = 'failed'; // e.g. an SVG: it just always shows the original
    schedule();
  }
}

on('camera-settled', () => { schedule(); pump(); });
on('rendered', schedule);
