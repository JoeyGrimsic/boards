// Item boxes and simple geometry.
import { S } from './state.js';

export const MUSIC_NODE = 72;

export function box(it) {
  if (it.type === 'music') return { x: it.x, y: it.y, w: MUSIC_NODE, h: MUSIC_NODE };
  const h = it.type === 'text' ? Math.max(it.h || 0, S.measured.get(it.id) || 40) : it.h;
  return { x: it.x, y: it.y, w: it.w, h };
}

export const center = b => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

export function union(boxes) {
  if (!boxes.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export const intersects = (a, b) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

export const contains = (b, p) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;

/** Where the ray from the box's center toward `t` leaves the box (+pad). */
export function edgePoint(b, t, pad = 8) {
  const c = center(b);
  const dx = t.x - c.x, dy = t.y - c.y;
  const hw = b.w / 2 + pad, hh = b.h / 2 + pad;
  const s = Math.min(
    Math.abs(dx) > 1e-6 ? hw / Math.abs(dx) : Infinity,
    Math.abs(dy) > 1e-6 ? hh / Math.abs(dy) : Infinity,
  );
  if (!isFinite(s) || s >= 1) return c;
  return { x: c.x + dx * s, y: c.y + dy * s };
}

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
