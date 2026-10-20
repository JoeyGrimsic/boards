// Tag autocomplete popup (used by the text editor and the tag editor).
import { tagColor } from './tags.js';
import { esc } from './markdown.js';

const el = document.getElementById('ac');
let st = null; // { opts, idx, onPick, prefix }

function draw() {
  el.innerHTML =
    st.opts.map((o, i) =>
      `<div class="opt${i === st.idx ? ' on' : ''}" data-i="${i}">` +
      `<i style="background:${tagColor(o.tag)}"></i>#${esc(o.tag)}` +
      (o.count ? `<small>${o.count}</small>` : '<small>new</small>') + '</div>').join('') +
    '<div class="hint"><kbd>tab</kbd> accept · <kbd>esc</kbd> ignore</div>';
}

el.addEventListener('mousedown', e => {
  e.preventDefault(); // keep focus in the editor
  const o = e.target.closest('.opt');
  if (o && st) pick(+o.dataset.i);
});

function pick(i) {
  const s = st;
  close();
  s.onPick(s.opts[i].tag);
}

export function close() {
  st = null;
  el.hidden = true;
}

export const isOpen = () => !!st;
export const current = () => (st ? { tag: st.opts[st.idx].tag, moved: !!st.moved } : null);

/** opts: [{tag, count}]  — shown under screen point (x, y). */
export function open(x, y, opts, prefix, onPick) {
  if (!opts.length) return close();
  const prevTag = st?.opts[st.idx]?.tag;
  const keep = opts.findIndex(o => o.tag === prevTag);
  st = { opts, idx: keep >= 0 ? keep : 0, onPick, prefix };
  draw();
  el.hidden = false;
  const r = el.getBoundingClientRect();
  el.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  el.style.top = (y + r.height > innerHeight - 8 ? y - r.height - 34 : y + 4) + 'px';
}

/** Returns true when the key was consumed by the popup. */
export function handleKey(e) {
  if (!st) return false;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    st.idx = (st.idx + (e.key === 'ArrowDown' ? 1 : -1) + st.opts.length) % st.opts.length;
    st.moved = true;
    draw();
    return true;
  }
  if (e.key === 'Tab') { pick(st.idx); return true; }
  if (e.key === 'Enter') {
    // Enter only accepts when it would actually change something (so typing a
    // complete tag then Enter still makes a new line).
    if (st.moved || st.opts[st.idx].tag !== st.prefix) { pick(st.idx); return true; }
    close();
    return false;
  }
  if (e.key === 'Escape') { close(); return true; }
  return false;
}

/** Screen position of character `pos` in a (possibly zoomed) textarea. */
export function caretPoint(ta, pos, zoom = 1) {
  const cs = getComputedStyle(ta);
  const m = document.createElement('div');
  for (const p of ['boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'fontFamily', 'fontSize',
    'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'textTransform', 'wordSpacing', 'tabSize', 'textIndent'])
    m.style[p] = cs[p];
  Object.assign(m.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', top: '0', left: '-9999px' });
  m.textContent = ta.value.slice(0, pos);
  const sp = document.createElement('span');
  sp.textContent = ta.value.slice(pos) || '.';
  m.appendChild(sp);
  document.body.appendChild(m);
  const r = ta.getBoundingClientRect();
  const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3;
  const out = { x: r.left + sp.offsetLeft * zoom, y: r.top + (sp.offsetTop + lh) * zoom };
  m.remove();
  return out;
}
