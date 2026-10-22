// Turns S.items into DOM and SVG (arrows, tag threads, music radii).
//
// Built for big boards: anything well outside the view is "culled" (display:
// none, so the browser does no work for it at all), threads and arrows are
// only drawn near the view, and the small extras on an item (title, tag pills,
// badges, resize handle) only exist on items that actually use them.
import { S, emit, on, getItem } from './state.js';
import { box, center, edgePoint, intersects, MUSIC_NODE } from './geom.js';
import { viewBox, isMoving } from './canvas.js';
import { roughRect, roughCurve, arrowHead, icon, rng } from './doodle.js';
import { itemTags, tagColor, threadEdges } from './tags.js';
import { renderMarkdown, esc } from './markdown.js';
import { assetUrl } from './api.js';
import { musicLabel, getMaster } from './music.js';
import { activeJobFor } from './jobs.js';
import { trackImage, untrack, untrackAll } from './anim.js';

export const FONTS = {
  round: "'Fredoka', 'Nunito', system-ui, sans-serif",
  chunky: "'Fredoka', 'Nunito', system-ui, sans-serif",
  print: "'Patrick Hand', 'Comic Sans MS', cursive",
  hand: "'Caveat', 'Segoe Print', cursive",
  marker: "'Permanent Marker', 'Comic Sans MS', cursive",
  sans: "system-ui, 'Segoe UI', Roboto, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  mono: "ui-monospace, Consolas, 'Cascadia Mono', monospace",
};
export const FONT_ORDER = ['round', 'chunky', 'print', 'hand', 'marker', 'sans', 'serif', 'mono'];
// round and chunky are the same typeface (Fredoka) at different weights
const FONT_WEIGHT = { round: 500, chunky: 700 };
export const FONT_LABEL = { round: 'rounded', chunky: 'chunky', print: 'print', hand: 'scrawl', marker: 'marker', sans: 'clean', serif: 'serif', mono: 'mono' };

export const INKS = {
  ink: 'var(--item-ink, var(--ink))', pink: '#ff2e93', red: '#e03131', orange: '#f08c00',
  green: '#2f9e44', blue: '#1c7ed6', purple: '#7048e8', gray: '#868e96',
};
export const PAPERS = {
  paper: 'var(--note)', yellow: '#fff1a6', pink: '#ffd3e8', mint: '#cdf3dd',
  sky: '#d3e9ff', lilac: '#e5dbff', peach: '#ffe0c7', ink: 'var(--ink)',
};

const itemsEl = document.getElementById('items');
const threadsG = document.getElementById('threads');
const arrowsG = document.getElementById('arrows');
const radiiG = document.getElementById('radii');

const els = new Map();
export const elFor = id => els.get(id);
const strip = (k, v) => (k.startsWith('_') ? undefined : v);

let pending = false;
export function requestRender() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(renderNow);
}
on('change', requestRender);
on('selection', requestRender);

/** Forget cached DOM state, e.g. after a theme change (tag colors differ). */
export function invalidate() {
  for (const el of els.values()) el._key = null;
  requestRender();
}

export function clearAll() {
  untrackAll();
  for (const el of els.values()) el.remove();
  els.clear();
  S.measured.clear();
  threadsG.innerHTML = arrowsG.innerHTML = radiiG.innerHTML = '';
  shownThreads = shownArrows = '';
  threadLinks = arrowLinks = [];
}

export function renderNow() {
  pending = false;
  const live = new Set();
  let z = 0;
  for (const it of S.items) {
    if (it.type === 'arrow') continue;
    live.add(it.id);
    let el = els.get(it.id);
    if (!el || el._type !== it.type) {
      el?.remove();
      el = create(it);
      els.set(it.id, el);
    }
    if (el.parentNode !== itemsEl) itemsEl.appendChild(el);
    if (el._z !== ++z) { el._z = z; el.style.zIndex = z; }
    update(el, it);
  }
  for (const [id, el] of els) {
    if (!live.has(id)) {
      el.querySelector('video')?.pause();
      untrack(id);
      el.remove();
      els.delete(id);
      S.measured.delete(id);
    }
  }
  cull();
  // auto-height text: measure after layout (only items that are drawn)
  for (const it of S.items) {
    if (it.type !== 'text') continue;
    const el = els.get(it.id);
    if ((el._measure || S.editing === it.id) && el._on) {
      S.measured.set(it.id, el.offsetHeight);
      el._measure = false;
    }
  }
  buildLinks();
  drawLinks();
  decorate();
  emit('rendered');
}

// ---------------------------------------------------------------- culling

/** The part of the board worth drawing: the view plus half a screen around it. */
function nearView() {
  const vb = viewBox();
  return { x: vb.x - vb.w / 2, y: vb.y - vb.h / 2, w: vb.w * 2, h: vb.h * 2 };
}

/** Hide (display:none) everything far from the view; show what came near.
 *  While the camera moves this is all that happens (no re-render, no redrawing
 *  threads); the rest catches up when it settles. */
function cull(moving = false) {
  const area = nearView();
  const vb = viewBox();
  // while moving, only hide things that are well away (so zooming in sheds the
  // rest of the board) without flickering items in and out at the edges
  const keep = moving ? { x: vb.x - vb.w * 1.5, y: vb.y - vb.h * 1.5, w: vb.w * 4, h: vb.h * 4 } : area;
  const entering = [];
  for (const it of S.items) {
    if (it.type === 'arrow') continue;
    const el = els.get(it.id);
    if (!el) continue;
    const pinned = S.sel.has(it.id) || S.editing === it.id;
    const b = box(it);
    const on = pinned || intersects(el._on ? keep : area, b);
    if (el._on === on) continue;
    if (!on) {
      el._on = false;
      el.classList.add('culled');
      continue;
    }
    entering.push([el, intersects(vb, box(it)) ? 1 : 0]);
  }
  // what's actually on screen first, then the margin around it
  entering.sort((a, b) => b[1] - a[1]);
  backlog = entering.map(e => e[0]);
  showSome();
}

// Showing hundreds of items in one go (e.g. zooming out over a big board) would
// freeze a frame, so they're brought in a batch per frame instead.
const SHOW_PER_FRAME = 120;
let backlog = [];
let backlogFrame = 0;
function showSome() {
  cancelAnimationFrame(backlogFrame);
  let needMeasure = false;
  for (const el of backlog.splice(0, SHOW_PER_FRAME)) {
    el._on = true;
    el.classList.remove('culled');
    if (el._measure) needMeasure = true;
  }
  if (backlog.length) backlogFrame = requestAnimationFrame(showSome);
  if (needMeasure && !isMoving()) requestRender();
}

let lastCull = 0;
on('camera', () => {
  // while moving, keep up every ~100ms so things are there before they're on screen
  const now = performance.now();
  if (now - lastCull > 100) { lastCull = now; cull(true); }
});
on('camera-settled', () => { cull(); drawLinks(); });

// ---------------------------------------------------------------- items

function create(it) {
  const el = document.createElement('div');
  el.className = `item ${it.type}`;
  el.dataset.id = it.id;
  el._type = it.type;
  let body = '';
  if (it.type === 'text') body = '<div class="content"></div>';
  else if (it.type === 'image') body = '<img class="full" draggable="false" alt=""><img class="thumb" draggable="false" alt="">';
  else if (it.type === 'video')
    body = '<video muted loop playsinline preload="metadata"></video><div class="vplay">' + icon('play') + '</div><div class="vbar"><i></i><b class="vin"></b><b class="vout"></b></div>';
  else if (it.type === 'music')
    body = `<div class="mn">${icon('music')}</div><div class="mlabel"></div>`;
  el.innerHTML = `<div class="body">${body}</div>`;
  el._on = true;
  if (it.type === 'video') wireVideo(el);
  if (it.type === 'image') {
    const img = el.querySelector('img.full');
    img.addEventListener('error', () => el.classList.add('broken'));
    img.addEventListener('load', () => el.classList.remove('broken'));
  }
  return el;
}

function update(el, it) {
  const key = JSON.stringify(it, strip) + (S.editing === it.id ? '#e' : '');
  if (el._key === key) return;
  el._key = key;
  el._measure = true;
  const s = el.style;
  s.left = it.x + 'px';
  s.top = it.y + 'px';

  if (it.type === 'text') {
    s.width = it.w + 'px';
    s.minHeight = it.h ? it.h + 'px' : '';
    s.setProperty('--fs', (it.size || 24) + 'px');
    s.setProperty('--ff', FONTS[it.font] || FONTS.round);
    s.setProperty('--fw', FONT_WEIGHT[it.font] || 400);
    s.setProperty('--fc', INKS[it.color] || INKS.ink);
    s.setProperty('--paper', it.bg ? PAPERS[it.bg] || PAPERS.paper : 'transparent');
    s.setProperty('--rot', it.bg ? ((rng(it.id)() - 0.5) * 2.4).toFixed(2) + 'deg' : '0deg');
    el.classList.toggle('note', !!it.bg);
    el.classList.toggle('pastel', !!it.bg && it.bg !== 'paper' && it.bg !== 'ink');
    el.classList.toggle('inknote', it.bg === 'ink');
    el.dataset.align = it.align || 'left';
    if (S.editing !== it.id) el.querySelector('.content').innerHTML = renderMarkdown(it.text || '');
  } else if (it.type === 'image') {
    s.width = it.w + 'px';
    s.height = it.h + 'px';
    trackImage(el, it); // anim.js picks preview vs original, and which GIFs animate
  } else if (it.type === 'video') {
    s.width = it.w + 'px';
    s.height = it.h + 'px';
    const v = el.querySelector('video');
    const url = assetUrl(S.name, it.src);
    if (v._src !== url) { v.src = url; v._src = url; }
    v.muted = !el._sound;
    const dur = v.duration || 0;
    el.querySelector('.vin').style.left = dur && it.inT ? (it.inT / dur) * 100 + '%' : '0%';
    el.querySelector('.vout').style.left = dur && it.outT ? (it.outT / dur) * 100 + '%' : '100%';
    el.classList.toggle('snippet', !!(it.inT || it.outT));
  } else if (it.type === 'music') {
    s.width = s.height = MUSIC_NODE + 'px';
    el.querySelector('.mlabel').textContent = musicLabel(it.music) || 'add music…';
  }

  // center piece title
  el.classList.toggle('center', !!it.center);
  const title = part(el, 'ctitle', !!it.center);
  if (title) {
    title.title = 'center piece — double-click to rename';
    title.textContent = '✶ ' + (it.center.title || 'untitled');
  }

  // tag pills (manually added tags; tags written in text are highlighted inline)
  const pills = part(el, 'pills', !!it.tags?.length);
  if (pills) pills.innerHTML = it.tags.map(t => `<span class="pill tg" data-tag="${esc(t)}" style="--tc:${tagColor(t)}">#${esc(t)}</span>`).join('');
  const hasMusic = !!it.music && it.type !== 'music';
  el.classList.toggle('has-music', hasMusic);
  const badge = part(el, 'mbadge', hasMusic);
  if (badge && !badge.firstChild) { badge.title = 'has music'; badge.innerHTML = icon('music'); }
}

/** Get (creating if needed) or remove an optional part of an item. */
function part(el, cls, want) {
  const parts = (el._parts ||= {});
  let p = parts[cls];
  if (!want) {
    if (p) { p.remove(); delete parts[cls]; }
    return null;
  }
  if (!p) {
    p = parts[cls] = document.createElement('div');
    p.className = cls;
    if (cls === 'ctitle') el.prepend(p);
    else el.appendChild(p);
  }
  return p;
}

function wireVideo(el) {
  const v = el.querySelector('video');
  const bar = el.querySelector('.vbar i');
  v.volume = getMaster();
  v.addEventListener('loadedmetadata', () => {
    const it = getItem(el.dataset.id);
    if (it?.inT) v.currentTime = it.inT;
    el._key = null;
    requestRender();
  });
  v.addEventListener('timeupdate', () => {
    const it = getItem(el.dataset.id);
    if (!it) return;
    if (it.outT && v.currentTime >= it.outT) v.currentTime = it.inT || 0;
    if (it.inT && v.currentTime < it.inT - 0.3) v.currentTime = it.inT;
    bar.style.width = v.duration ? (v.currentTime / v.duration) * 100 + '%' : '0';
  });
  v.addEventListener('play', () => el.classList.add('playing'));
  v.addEventListener('pause', () => el.classList.remove('playing'));
}

// ---------------------------------------------------------------- state classes

function decorate() {
  document.body.classList.toggle('multi', S.sel.size > 1);
  for (const it of S.items) {
    if (it.type === 'arrow') continue;
    const el = els.get(it.id);
    const tags = itemTags(it);
    el.classList.toggle('selected', S.sel.has(it.id));
    el.classList.toggle('editing', S.editing === it.id);
    el.classList.toggle('dim', !!S.focusTag && !tags.has(S.focusTag));
    el.classList.toggle('hot', !!S.hoverTag && tags.has(S.hoverTag));
    el.classList.toggle('match', S.matches.has(it.id));
    // resize handle: only on a single selected item
    const rh = part(el, 'rh', S.sel.size === 1 && S.sel.has(it.id) && it.type !== 'music');
    if (rh) rh.dataset.handle = 'resize';
    // background music download for this item: show its progress right on it
    const job = activeJobFor(it.id);
    el.classList.toggle('downloading', !!job);
    const badge = part(el, 'dlbadge', !!job);
    if (badge) {
      const total = job.entries?.length || 0;
      const text = job.kind === 'playlist' && total ? `${Math.min(job.next + 1, total)}/${total}` : 'downloading';
      if (badge._t !== text) { badge._t = text; badge.title = 'downloading music in the background'; badge.innerHTML = `<span class="spin"></span>${text}`; }
    }
  }
}

// ---------------------------------------------------------------- svg layer

// Threads and arrows are worked out when the board changes (buildLinks), and
// only the ones near the view are put on the page (drawLinks, also re-run when
// the camera settles).
let threadLinks = [];
let arrowLinks = [];

const spanBox = (p, q) => ({ x: Math.min(p.x, q.x) - 40, y: Math.min(p.y, q.y) - 40, w: Math.abs(p.x - q.x) + 80, h: Math.abs(p.y - q.y) + 80 });

function buildLinks() {
  threadLinks = [];
  if (S.showThreads || S.focusTag || S.hoverTag) {
    for (const e of threadEdges()) {
      const hot = e.tag === S.hoverTag || e.tag === S.focusTag;
      if (S.focusTag && e.tag !== S.focusTag) continue;
      if (!S.showThreads && !hot) continue;
      const p1 = edgePoint(e.ba, center(e.bb), 6);
      const p2 = edgePoint(e.bb, center(e.ba), 6);
      const { d } = roughCurve(p1.x, p1.y, p2.x, p2.y, e.tag + e.a.id + e.b.id, 0.14);
      threadLinks.push({ b: spanBox(p1, p2), html: `<path class="thread${hot ? ' hot' : ''}" d="${d}" style="stroke:${tagColor(e.tag)}"/>` });
    }
  }
  arrowLinks = [];
  for (const a of S.items) {
    if (a.type !== 'arrow') continue;
    const A = getItem(a.from), B = getItem(a.to);
    if (!A || !B) continue;
    const ba = box(A), bb = box(B);
    const p1 = edgePoint(ba, center(bb), 10);
    const p2 = edgePoint(bb, center(ba), 14);
    const { d, cx, cy } = roughCurve(p1.x, p1.y, p2.x, p2.y, a.id, 0.1);
    const col = INKS[a.color] || INKS.ink;
    const sel = S.sel.has(a.id) ? ' selected' : '';
    const dim = S.focusTag && !(itemTags(A).has(S.focusTag) && itemTags(B).has(S.focusTag)) ? ' dim' : '';
    const mx = 0.25 * p1.x + 0.5 * cx + 0.25 * p2.x, my = 0.25 * p1.y + 0.5 * cy + 0.25 * p2.y;
    arrowLinks.push({
      b: spanBox(p1, p2),
      html: `<g class="arrow${sel}${dim}" data-id="${a.id}"><path class="hit" d="${d}"/>` +
        `<path class="stroke" d="${d}${arrowHead(p2.x, p2.y, cx, cy, 16)}" style="stroke:${col}"/>` +
        (a.label ? `<text class="alabel" x="${mx}" y="${my}" style="fill:${col}">${esc(a.label)}</text>` : '') + '</g>',
    });
  }
}

let shownThreads = '', shownArrows = '';
function drawLinks() {
  const area = nearView();
  const pick = list => list.filter(l => intersects(area, l.b)).map(l => l.html).join('');
  const t = pick(threadLinks), a = pick(arrowLinks);
  if (t !== shownThreads) threadsG.innerHTML = shownThreads = t;
  if (a !== shownArrows) arrowsG.innerHTML = shownArrows = a;

  // music radius for selected music sources, plus the live preview while the
  // music dialog is open
  let h = '';
  const pv = S.musicPreview;
  const ring = (b, r, cls) => {
    const c = center(b);
    return `<circle class="${cls}" cx="${c.x}" cy="${c.y}" r="${r}"/>`;
  };
  for (const id of S.sel) {
    const it = getItem(id);
    if (!it?.music || pv?.id === id) continue;
    h += ring(box(it), it.music.radius ?? 900, 'radius');
  }
  if (pv) {
    const it = pv.id && getItem(pv.id);
    const b = it ? box(it) : { x: pv.at.x, y: pv.at.y, w: 0, h: 0 };
    h += ring(b, pv.radius, 'radius live');
  }
  radiiG.innerHTML = h;
}
