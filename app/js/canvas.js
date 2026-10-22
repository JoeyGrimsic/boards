// Camera: pan, zoom, fly-to and the dot grid.
import { S, emit, on } from './state.js';
import { box, union, clamp } from './geom.js';

export const MIN_Z = 0.03;
export const MAX_Z = 6;

export const vp = document.getElementById('viewport');
export const world = document.getElementById('world');

let flying = null;

// Zoomed out past this, text is too small to read and is drawn simplified.
export const FAR_Z = 0.22;

let settleTimer = null;
let moving = false;
export const isMoving = () => moving;

/**
 * Move the camera. Per frame this only changes one transform: while the camera
 * moves the board slides around as one finished picture. Everything that costs
 * real work (outline thickness via --iz, which items are drawn, GIFs, the
 * center-piece bar...) waits for 'camera-settled', a moment after it stops.
 */
export function applyCamera(save = true) {
  const { x, y, z } = S.cam;
  if (!moving) {
    moving = true;
    world.classList.add('moving');
  }
  world.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
  drawGrid();
  emit('camera');
  clearTimeout(settleTimer);
  settleTimer = setTimeout(settleCamera, 140);
  if (save) saveCamera();
}

/** The camera stopped (or a board just opened): catch up on the deferred work. */
export function settleCamera() {
  clearTimeout(settleTimer);
  moving = false;
  world.classList.remove('moving');
  world.style.setProperty('--iz', 1 / S.cam.z);
  world.classList.toggle('far', S.cam.z < FAR_Z);
  emit('camera-settled');
}

// The camera is remembered per board in this browser, not written into
// board.json on every move (that meant re-saving the whole board constantly).
let camTimer = null;
function saveCamera() {
  clearTimeout(camTimer);
  camTimer = setTimeout(() => {
    try { localStorage.setItem(`doodle-cam:${S.name}`, JSON.stringify(S.cam)); } catch { /* ignore */ }
  }, 400);
}

export function savedCamera(name) {
  try {
    const c = JSON.parse(localStorage.getItem(`doodle-cam:${name}`));
    return c && isFinite(c.z) && c.z > 0 ? c : null;
  } catch { return null; }
}

// One dot per tile, drawn as a tiny SVG image: tiling an image is far cheaper
// to redraw than a CSS radial-gradient. Kept per tile size so the dots stay
// the same size on screen as you zoom.
const dotTiles = new Map();
let dotColor = '';

function dotTile(s) {
  const key = Math.round(s);
  if (!dotTiles.has(key)) {
    const r = (1.3 / key) * 100; // ~1.3px dot whatever the tile size
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='50' r='${r.toFixed(2)}' fill='${dotColor}'/></svg>`;
    dotTiles.set(key, `url("data:image/svg+xml,${encodeURIComponent(svg)}")`);
  }
  return dotTiles.get(key);
}

on('theme', () => {
  dotColor = getComputedStyle(document.documentElement).getPropertyValue('--grid').trim();
  dotTiles.clear();
  drawGrid();
});

const grid = document.getElementById('grid');
let lastTile = '';
let lastSize = 0;
function drawGrid() {
  const { x, y, z } = S.cam;
  let s = 32 * z;
  while (s < 18) s *= 4;
  while (s > 90) s /= 4;
  if (!dotColor) dotColor = getComputedStyle(document.documentElement).getPropertyValue('--grid').trim();
  const tile = dotTile(s);
  if (tile !== lastTile) { grid.style.backgroundImage = tile; lastTile = tile; }
  // the dots only need redrawing when their spacing changes (zooming);
  // panning just slides the layer
  if (s !== lastSize) { grid.style.backgroundSize = `${s}px ${s}px`; lastSize = s; }
  const wrap = v => ((v % s) + s) % s - s;
  grid.style.transform = `translate(${wrap(x - s / 2)}px, ${wrap(y - s / 2)}px)`;
}

// The viewport always fills the window, so its rectangle only changes on resize.
// Caching it keeps mouse/wheel handling from forcing the browser to re-layout.
let vpRect = null;
const rect = () => (vpRect ||= vp.getBoundingClientRect());
addEventListener('resize', () => { vpRect = null; settleCamera(); });

export function screenToWorld(sx, sy) {
  const r = rect();
  return { x: (sx - r.left - S.cam.x) / S.cam.z, y: (sy - r.top - S.cam.y) / S.cam.z };
}

export function worldToScreen(wx, wy) {
  const r = rect();
  return { x: wx * S.cam.z + S.cam.x + r.left, y: wy * S.cam.z + S.cam.y + r.top };
}

export function viewCenter() {
  const r = rect();
  return screenToWorld(r.left + r.width / 2, r.top + r.height / 2);
}

export function viewBox() {
  const r = rect();
  const a = screenToWorld(r.left, r.top);
  return { x: a.x, y: a.y, w: r.width / S.cam.z, h: r.height / S.cam.z };
}

export function zoomAt(sx, sy, factor) {
  stopFly();
  const r = rect();
  const w = screenToWorld(sx, sy);
  const z = clamp(S.cam.z * factor, MIN_Z, MAX_Z);
  S.cam.z = z;
  S.cam.x = sx - r.left - w.x * z;
  S.cam.y = sy - r.top - w.y * z;
  applyCamera();
}

export function zoomCenter(factor) {
  const r = rect();
  zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
}

export function panBy(dx, dy) {
  stopFly();
  S.cam.x += dx;
  S.cam.y += dy;
  applyCamera();
}

function stopFly() {
  if (flying) cancelAnimationFrame(flying);
  flying = null;
}

/** Smoothly move the camera to a target {x,y,z}. */
export function flyCam(target, ms = 420) {
  stopFly();
  const from = { ...S.cam };
  const t0 = performance.now();
  // interpolate zoom in log space so it feels even
  const lz0 = Math.log(from.z), lz1 = Math.log(target.z);
  const r = rect();
  const cw = { x: (r.width / 2 - from.x) / from.z, y: (r.height / 2 - from.y) / from.z };
  const tw = { x: (r.width / 2 - target.x) / target.z, y: (r.height / 2 - target.y) / target.z };
  const step = now => {
    const t = Math.min(1, (now - t0) / ms);
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const z = Math.exp(lz0 + (lz1 - lz0) * e);
    const wx = cw.x + (tw.x - cw.x) * e, wy = cw.y + (tw.y - cw.y) * e;
    S.cam.z = z;
    S.cam.x = r.width / 2 - wx * z;
    S.cam.y = r.height / 2 - wy * z;
    applyCamera(t === 1);
    flying = t < 1 ? requestAnimationFrame(step) : null;
  };
  flying = requestAnimationFrame(step);
}

export function camFor(b, { pad = 80, maxZ = 1.2, minZ = MIN_Z } = {}) {
  const r = rect();
  const z = clamp(Math.min((r.width - pad * 2) / Math.max(b.w, 1), (r.height - pad * 2) / Math.max(b.h, 1)), minZ, maxZ);
  return { z, x: r.width / 2 - (b.x + b.w / 2) * z, y: r.height / 2 - (b.y + b.h / 2) * z };
}

export function flyTo(b, opts) {
  if (b) flyCam(camFor(b, opts));
}

export function itemsBox(items) {
  return union(items.filter(i => i.type !== 'arrow').map(box));
}

export function fitAll(animate = true) {
  const b = itemsBox(S.items);
  if (!b) {
    const target = { x: rect().width / 2, y: rect().height / 2, z: 1 };
    animate ? flyCam(target) : (Object.assign(S.cam, target), applyCamera(false));
    return;
  }
  const target = camFor(b, { maxZ: 1 });
  animate ? flyCam(target) : (Object.assign(S.cam, target), applyCamera(false));
}

export function resetZoom() {
  const c = viewCenter();
  flyCam({ ...camFor({ x: c.x, y: c.y, w: 0, h: 0 }, { maxZ: 1, minZ: 1 }) });
}
