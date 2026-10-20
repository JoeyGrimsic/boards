// Turns S.items into DOM and SVG (arrows, tag threads, music radii).
import { S, emit, on, getItem } from './state.js';
import { box, center, edgePoint, MUSIC_NODE } from './geom.js';
import { roughRect, roughCurve, arrowHead, icon, rng } from './doodle.js';
import { itemTags, tagColor, threadEdges } from './tags.js';
import { renderMarkdown, esc } from './markdown.js';
import { assetUrl } from './api.js';
import { musicLabel, getMaster } from './music.js';

export const FONTS = {
  print: "'Patrick Hand', 'Comic Sans MS', cursive",
  hand: "'Caveat', 'Segoe Print', cursive",
  marker: "'Permanent Marker', 'Comic Sans MS', cursive",
  sans: "system-ui, 'Segoe UI', Roboto, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  mono: "ui-monospace, Consolas, 'Cascadia Mono', monospace",
};
export const FONT_ORDER = ['print', 'hand', 'marker', 'sans', 'serif', 'mono'];
export const FONT_LABEL = { print: 'print', hand: 'scrawl', marker: 'marker', sans: 'clean', serif: 'serif', mono: 'mono' };

export const INKS = {
  ink: 'var(--item-ink, var(--ink))', pink: '#ff2e93', red: '#e03131', orange: '#f08c00',
  green: '#2f9e44', blue: '#1c7ed6', purple: '#7048e8', gray: '#868e96',
};
export const PAPERS = {
  paper: 'var(--panel)', yellow: '#fff1a6', pink: '#ffd3e8', mint: '#cdf3dd',
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
  for (const el of els.values()) el.remove();
  els.clear();
  S.measured.clear();
  threadsG.innerHTML = arrowsG.innerHTML = radiiG.innerHTML = '';
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
    el.style.zIndex = ++z;
    update(el, it);
  }
  for (const [id, el] of els) {
    if (!live.has(id)) {
      el.querySelector('video')?.pause();
      el.remove();
      els.delete(id);
      S.measured.delete(id);
    }
  }
  // auto-height text: measure after layout
  for (const it of S.items) {
    if (it.type !== 'text') continue;
    const el = els.get(it.id);
    if (el._measure || S.editing === it.id) {
      S.measured.set(it.id, el.offsetHeight);
      el._measure = false;
    }
  }
  drawLinks();
  decorate();
  emit('rendered');
}

// ---------------------------------------------------------------- items

function create(it) {
  const el = document.createElement('div');
  el.className = `item ${it.type}`;
  el.dataset.id = it.id;
  el._type = it.type;
  let body = '';
  if (it.type === 'text') body = '<div class="content"></div>';
  else if (it.type === 'image') body = '<img draggable="false" alt="">';
  else if (it.type === 'video')
    body = '<video muted loop playsinline preload="metadata"></video><div class="vplay">' + icon('play') + '</div><div class="vbar"><i></i><b class="vin"></b><b class="vout"></b></div>';
  else if (it.type === 'music')
    body = `<div class="mn">${icon('music')}</div><div class="mlabel"></div>`;
  el.innerHTML = `<div class="ctitle" title="center piece — double-click to rename"></div><div class="body">${body}</div><div class="pills"></div>` +
    `<div class="mbadge" title="has music">${icon('music')}</div><div class="rh" data-handle="resize"></div>`;
  if (it.type === 'video') wireVideo(el);
  if (it.type === 'image') {
    const img = el.querySelector('img');
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
    s.setProperty('--ff', FONTS[it.font] || FONTS.print);
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
    const img = el.querySelector('img');
    const url = assetUrl(S.name, it.src);
    if (img._src !== url) { img.src = url; img._src = url; }
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
  if (it.center) el.querySelector('.ctitle').textContent = '✶ ' + (it.center.title || 'untitled');

  // tag pills (manually added tags; tags written in text are highlighted inline)
  el.querySelector('.pills').innerHTML = (it.tags || [])
    .map(t => `<span class="pill tg" data-tag="${esc(t)}" style="--tc:${tagColor(t)}">#${esc(t)}</span>`).join('');
  el.classList.toggle('has-music', !!it.music && it.type !== 'music');
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
  }
}

// ---------------------------------------------------------------- svg layer

function drawLinks() {
  // tag threads
  let h = '';
  if (S.showThreads || S.focusTag || S.hoverTag) {
    for (const e of threadEdges()) {
      const hot = e.tag === S.hoverTag || e.tag === S.focusTag;
      if (S.focusTag && e.tag !== S.focusTag) continue;
      if (!S.showThreads && !hot) continue;
      const p1 = edgePoint(e.ba, center(e.bb), 6);
      const p2 = edgePoint(e.bb, center(e.ba), 6);
      const { d } = roughCurve(p1.x, p1.y, p2.x, p2.y, e.tag + e.a.id + e.b.id, 0.14);
      h += `<path class="thread${hot ? ' hot' : ''}" d="${d}" style="stroke:${tagColor(e.tag)}"/>`;
    }
  }
  threadsG.innerHTML = h;

  // arrows
  h = '';
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
    h += `<g class="arrow${sel}${dim}" data-id="${a.id}"><path class="hit" d="${d}"/>` +
      `<path class="stroke" d="${d}${arrowHead(p2.x, p2.y, cx, cy, 16)}" style="stroke:${col}"/>` +
      (a.label ? `<text class="alabel" x="${mx}" y="${my}" style="fill:${col}">${esc(a.label)}</text>` : '') + '</g>';
  }
  arrowsG.innerHTML = h;

  // music radius for selected music sources, plus the live preview while the
  // music dialog is open
  h = '';
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
