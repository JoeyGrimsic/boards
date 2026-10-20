// #tags: parsing, colors and the faint "threads" that tie tagged items together.
import { S } from './state.js';
import { hash } from './doodle.js';
import { box, center } from './geom.js';

export const TAG_BODY = '[\\p{L}\\p{N}_][\\p{L}\\p{N}_\\-]*';
// a # that starts a word (not "page#anchor" or "&#39;")
export const TAG_RE = () => new RegExp(`(^|[^\\p{L}\\p{N}_&#/])#(${TAG_BODY})`, 'gu');

export function parseTags(text) {
  const out = new Set();
  if (!text) return out;
  for (const m of text.matchAll(TAG_RE())) out.add(m[2].toLowerCase());
  return out;
}

const cache = new WeakMap();
export function itemTags(it) {
  const key = (it.tags || []).join(',') + '|' + (it.text || '') + '|' + (it.title || '');
  const hit = cache.get(it);
  if (hit && hit.key === key) return hit.tags;
  const tags = new Set((it.tags || []).map(t => t.toLowerCase()));
  for (const t of parseTags(it.text)) tags.add(t);
  for (const t of parseTags(it.title)) tags.add(t);
  cache.set(it, { key, tags });
  return tags;
}

/** tag -> number of items using it, most used first (optionally ignoring one item's text) */
export function allTags(skipTextOf = null) {
  const counts = new Map();
  for (const it of S.items) {
    const tags = it.id === skipTextOf ? (it.tags || []) : itemTags(it);
    for (const t of tags) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return new Map([...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

export function tagColor(tag) {
  const h = hash(tag) % 360;
  return `hsl(${h} 68% 44%)`;
}

/** Minimum spanning tree over points (Prim) -> list of [i, j] edges. */
function mst(pts) {
  const n = pts.length;
  if (n < 2) return [];
  const inTree = new Array(n).fill(false);
  const dist = new Array(n).fill(Infinity);
  const from = new Array(n).fill(-1);
  dist[0] = 0;
  const edges = [];
  for (let k = 0; k < n; k++) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!inTree[i] && (u < 0 || dist[i] < dist[u])) u = i;
    inTree[u] = true;
    if (from[u] >= 0) edges.push([from[u], u]);
    for (let v = 0; v < n; v++) {
      if (inTree[v]) continue;
      const d = (pts[u].x - pts[v].x) ** 2 + (pts[u].y - pts[v].y) ** 2;
      if (d < dist[v]) { dist[v] = d; from[v] = u; }
    }
  }
  return edges;
}

/** For every tag shared by 2+ items: the edges to draw between them. */
export function threadEdges() {
  const groups = new Map();
  for (const it of S.items) {
    if (it.type === 'arrow') continue;
    for (const t of itemTags(it)) {
      if (!groups.has(t)) groups.set(t, []);
      groups.get(t).push(it);
    }
  }
  const out = [];
  for (const [tag, items] of groups) {
    if (items.length < 2) continue;
    const list = items.slice(0, 80);
    const boxes = list.map(box);
    const pts = boxes.map(center);
    for (const [a, b] of mst(pts)) out.push({ tag, a: list[a], b: list[b], ba: boxes[a], bb: boxes[b] });
  }
  return out;
}
