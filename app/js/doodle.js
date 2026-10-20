// Hand-drawn look: seeded jitter, sketchy shapes and doodle icons.

export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function rng(seed) {
  let a = typeof seed === 'string' ? hash(seed) : seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const f = n => Math.round(n * 10) / 10;

/** A wobbly rectangle drawn with two loose passes, like a marker outline. */
export function roughRect(w, h, seed, jitter = 2.2) {
  const r = rng(seed);
  const j = (k = 1) => (r() - 0.5) * 2 * jitter * k;
  let d = '';
  for (let pass = 0; pass < 2; pass++) {
    const pts = [[0, 0], [w, 0], [w, h], [0, h], [0, 0]];
    d += `M${f(pts[0][0] + j())} ${f(pts[0][1] + j())}`;
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      const mx = (x0 + x1) / 2 + j(1.6), my = (y0 + y1) / 2 + j(1.6);
      const over = i === pts.length - 1 ? 6 : 0; // overshoot the last corner a touch
      d += `Q${f(mx)} ${f(my)} ${f(x1 + j() + (x1 > x0 ? over : x1 < x0 ? -over : 0))} ${f(y1 + j() + (y1 > y0 ? over : y1 < y0 ? -over : 0))}`;
    }
  }
  return d;
}

/** A slightly bowed line with a bit of wobble. */
export function roughCurve(x1, y1, x2, y2, seed, bow = 0.08) {
  const r = rng(seed);
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const side = r() > 0.5 ? 1 : -1;
  const k = len * bow * side * (0.6 + r() * 0.6);
  const cx = (x1 + x2) / 2 - (dy / len) * k;
  const cy = (y1 + y2) / 2 + (dx / len) * k;
  return { d: `M${f(x1)} ${f(y1)}Q${f(cx)} ${f(cy)} ${f(x2)} ${f(y2)}`, cx, cy };
}

/** Arrow head lines at (x,y) pointing away from (fx,fy). */
export function arrowHead(x, y, fx, fy, size = 14) {
  const a = Math.atan2(y - fy, x - fx);
  const s = 0.45;
  const p1 = [x - size * Math.cos(a - s), y - size * Math.sin(a - s)];
  const p2 = [x - size * Math.cos(a + s), y - size * Math.sin(a + s)];
  return `M${f(p1[0])} ${f(p1[1])}L${f(x)} ${f(y)}L${f(p2[0])} ${f(p2[1])}`;
}

// ---------------------------------------------------------------- icons
// 24x24, drawn a little imperfectly on purpose.
const P = d => `<path d="${d}"/>`;
const ICONS = {
  home: P('M3.5 11.2L12 3.8l8.6 7.6M6 9.6v10.1h12.2V9.4M10 19.6v-5.4h4.1v5.5'),
  text: P('M5 6.4c4-.7 9.8-.6 14.1.1M12.1 6.1c-.3 4.4-.2 9.1.1 13.6M9.2 19.7h5.8'),
  heading: P('M6.1 5v14.1M17.9 5.2v13.8M6.3 12.2c3.9-.4 7.7-.3 11.6 0'),
  note: P('M5 4.6h14.2v9.8l-5 5.1H5.1zM14.2 19.4v-5h5'),
  zone: P('M4 7.2V4.2h3M10.5 4h3M17 4.1h3v3M20 10.5v3M20 17v3h-3M13.5 20h-3M7 20H4v-3M4 13.5v-3'),
  arrow: P('M4.5 19.2C8 14 12.5 9.8 19.2 5M13.4 4.6l5.9.3-.9 5.8'),
  music: P('M9 17.5V5.8l10-2.3v11.7') + '<circle cx="6.6" cy="17.7" r="2.4"/><circle cx="16.6" cy="15.3" r="2.4"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><circle cx="8.6" cy="9.4" r="1.6"/>' + P('M4 17.5l5-5 3.6 3.4 2.6-2.4 4.6 4.3'),
  video: '<rect x="3" y="5.6" width="12.8" height="12.8" rx="2"/>' + P('M16.2 10.4l4.8-3v9.4l-4.8-3'),
  youtube: '<rect x="2.8" y="5.4" width="18.4" height="13.2" rx="3.6"/>' + P('M10 9.2v5.6l4.8-2.8z'),
  tag: P('M9.3 3.8L7.2 20.4M16.6 3.6l-2.2 16.7M4.2 8.7h16.2M3.6 15.4h16.1'),
  search: '<circle cx="10.4" cy="10.2" r="6.2"/>' + P('M15 14.9l5.3 5.2'),
  trash: P('M4.5 6.6h15M9.4 6.4V4.2h5.2v2.2M6.4 6.8l1 13.1h9.3l1-13.2M10.2 10.4v6.2M13.8 10.4v6.2'),
  copy: '<rect x="8.4" y="8.2" width="11.6" height="11.8" rx="1.5"/>' + P('M15.6 8V4.4H4.2v11.4h4'),
  undo: P('M8.6 4.8L4.2 9.2l4.4 4.3M4.6 9.2h9.6c3.4 0 6 2.4 6 5.4s-2.6 5.4-6 5.4h-3.3'),
  redo: P('M15.4 4.8l4.4 4.4-4.4 4.3M19.4 9.2H9.8c-3.4 0-6 2.4-6 5.4s2.6 5.4 6 5.4h3.3'),
  help: P('M8.8 8.6c.2-2.7 2.1-4.3 4-4.1 2.2.2 3.7 2 3.2 4-.5 2.1-3.6 2.6-3.8 5.6M12.2 18.4v.7'),
  theme: '<circle cx="12" cy="12" r="7.8"/>' + P('M12 4.3v15.4M12 7.6l5-2M12 11.6l7.6-1.6M12 15.6l6.4 1.2'),
  sound: P('M4 9.4h3.8l5-4.3v13.8l-5-4.2H4zM16.2 9a4.4 4.4 0 0 1 0 6M18.6 6.4a8 8 0 0 1 0 11.2'),
  mute: P('M4 9.4h3.8l5-4.3v13.8l-5-4.2H4zM16.4 9.4l4.6 5M21 9.4l-4.6 5'),
  plus: P('M12 4.6v14.8M4.6 12.2h14.8'),
  minus: P('M4.6 12.2h14.8'),
  fit: P('M4 9V4h5M15 4.1h5v5M20 15v5h-5M9 20H4v-5'),
  font: P('M3.6 18.6L8.4 5.4l4.8 13.2M5.4 13.8h6M20 11.6v7.2M20 14.8c0-2.1-1.3-3.2-2.8-3.2-1.6 0-2.8 1.4-2.8 3.5s1.2 3.6 2.8 3.6c1.5 0 2.8-1.3 2.8-3.4'),
  color: P('M12 3.8c3.4 4.4 6 7.6 6 10.6a6 6 0 0 1-12 0c0-3 2.6-6.2 6-10.6z'),
  front: '<rect x="8" y="8" width="12" height="12" rx="1.5"/>' + '<path stroke-dasharray="2 2.6" d="M5.6 15.8H4V4h11.8v1.6"/>',
  back: '<rect x="4" y="4" width="12" height="12" rx="1.5"/>' + '<path stroke-dasharray="2 2.6" d="M18.4 8.2H20V20H8.2v-1.6"/>',
  play: P('M7.2 4.8L19 12 7.2 19.4z'),
  pause: P('M8 5.2v13.6M16 5.2v13.6'),
  link: P('M10 14.2l4.2-4.2M8.6 11.2l-2.4 2.4a3.4 3.4 0 0 0 4.8 4.8l2.4-2.4M15.4 12.8l2.4-2.4a3.4 3.4 0 0 0-4.8-4.8l-2.4 2.4'),
  close: P('M6.2 6l11.6 12.1M17.9 6.1L6 18'),
  sparkle: P('M12 3.5l1.8 6.6 6.6 1.9-6.6 1.9L12 20.5l-1.8-6.6-6.6-1.9 6.6-1.9z'),
  folder: P('M3.6 6.4h6l2 2.2h8.8v10.8H3.6z'),
  pencil: P('M4.6 19.4l1-4.4L15.8 4.8l3.4 3.4L9 18.4zM13.6 7l3.4 3.4'),
  compass: '<circle cx="12" cy="12" r="8.2"/>' + P('M15.4 8.6l-2 5-4.8 1.8 2-5z'),
  swap: P('M5 8.2h13.6l-3-3M19 16H5.6l3 3'),
  upload: P('M12 15.6V4.6M7.6 8.8L12 4.4l4.4 4.4M4.6 15v4.4h14.8V15'),
  check: P('M4.8 12.6l4.6 4.6L19.4 6.6'),
  back_arrow: P('M10.2 5.2L3.8 12l6.4 6.8M4.4 12h16'),
  threads: '<circle cx="5.5" cy="6.5" r="2"/><circle cx="18.5" cy="8" r="2"/><circle cx="10" cy="18" r="2"/>' + '<path stroke-dasharray="2 2.4" d="M7.4 7c3.4 0 6.6.2 9.2.6M17.4 9.8c-1.8 3-4.4 5.6-6 6.6"/>',
  lock: '<rect x="5" y="10.6" width="14" height="9.6" rx="1.6"/>' + P('M8 10.4V7.6a4 4 0 0 1 8 0v2.8'),
  dots: '<circle cx="5.5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18.5" cy="12" r="1.2"/>',
  scissors: '<circle cx="6.4" cy="6.8" r="2.6"/><circle cx="6.4" cy="17.2" r="2.6"/>' + P('M8.6 8.4L20 17.8M8.6 15.6L20 6.2'),
  up: P('M12 19.4V5M6.4 10.4L12 4.8l5.6 5.6'),
  down: P('M12 4.6v14.4M6.4 13.6l5.6 5.6 5.6-5.6'),
  next: P('M5.2 5.4l9.2 6.6-9.2 6.6zM18.6 5.6v12.8'),
  inpoint: P('M8.6 4.6H5.2v14.8h3.4M10.6 12h8.2M15.6 8.8l3.2 3.2-3.2 3.2'),
  outpoint: P('M15.4 4.6h3.4v14.8h-3.4M13.4 12H5.2M10.2 8.8L13.4 12l-3.2 3.2'),
};

export function icon(name, cls = '') {
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

/** Fill every [data-icon] element in a root with its doodle icon. */
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => {
    if (!el.querySelector(':scope > svg.ic')) el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon));
  });
}

/** Scribbled underline as an inline SVG string. */
export function scribble(width = 200, seed = 1) {
  const r = rng(seed);
  let d = `M2 ${8 + r() * 3}`;
  const n = 6;
  for (let i = 1; i <= n; i++) {
    const x = (width / n) * i;
    d += ` Q${f(x - width / n / 2)} ${f(4 + r() * 8)} ${f(x)} ${f(7 + r() * 4)}`;
  }
  return `<svg viewBox="0 0 ${width} 16" preserveAspectRatio="none" class="scribble"><path d="${d}" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>`;
}
