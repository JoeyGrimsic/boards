// In-place text editing with #tag autocomplete and a few markdown conveniences.
import { S, getItem, emit, snap, pushUndo, changed, removeItems } from './state.js';
import { elFor, renderNow, requestRender } from './render.js';
import { allTags } from './tags.js';
import * as ac from './ac.js';
import { cycleFont, changeSize } from './actions.js';

let ta = null;
let before = null;
let ignoreAt = -1; // position of a "#" whose suggestions were dismissed with Esc

const TYPING_TAG = new RegExp(`(^|[^\\p{L}\\p{N}_&#/])#([\\p{L}\\p{N}_\\-]*)$`, 'u');
const LIST_RE = /^(\s*)([-*] \[[ xX]\] |\[[ xX]\] |[-*•] |(\d+)([.)]) )/;

export const editor = () => ta;

export function startEdit(id, { caret = 'end', undoBase = null } = {}) {
  if (S.editing === id) return;
  if (S.editing) endEdit();
  const it = getItem(id);
  if (!it || it.type !== 'text') return;
  before = undoBase ?? snap();
  S.editing = id;
  S.sel = new Set([id]);
  emit('selection');
  renderNow();

  const el = elFor(id);
  ta = document.createElement('textarea');
  ta.className = 'editor';
  ta.value = it.text || '';
  ta.spellcheck = true;
  ta.placeholder = it.bg ? 'jot it down…' : 'type… (# for tags)';
  el.querySelector('.body').appendChild(ta);
  autosize();
  ta.focus({ preventScroll: true });
  const n = ta.value.length;
  if (caret === 'all') ta.select();
  else ta.setSelectionRange(n, n);
  ignoreAt = -1;

  ta.addEventListener('input', onInput);
  ta.addEventListener('keydown', onKey);
  ta.addEventListener('blur', () => setTimeout(() => {
    if (ta && document.activeElement !== ta && document.hasFocus()) endEdit();
  }, 0));
  ta.addEventListener('click', updateSuggest);
}

export function endEdit() {
  if (!S.editing) return;
  const id = S.editing;
  const it = getItem(id);
  S.editing = null;
  ac.close();
  ta?.remove();
  ta = null;
  if (it) {
    it.text = (it.text || '').replace(/\s+$/, '');
    if (!it.text.trim()) removeItems([id]);
  }
  if (before) pushUndo(before);
  before = null;
  changed();
  emit('selection');
}

function autosize() {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
}

function onInput() {
  const it = getItem(S.editing);
  if (!it) return;
  it.text = ta.value;
  autosize();
  changed(); // re-render + autosave while typing
  updateSuggest();
}

// ---------------------------------------------------------------- tag suggestions

function updateSuggest() {
  if (!ta) return;
  const pos = ta.selectionStart;
  if (pos !== ta.selectionEnd) return ac.close();
  const m = ta.value.slice(0, pos).match(TYPING_TAG);
  if (!m) return ac.close();
  const prefix = m[2].toLowerCase();
  const hashAt = pos - m[2].length - 1;
  if (hashAt === ignoreAt) return ac.close();
  const tags = [...allTags(S.editing)];
  let opts = tags.filter(([t]) => t.startsWith(prefix))
    .concat(prefix ? tags.filter(([t]) => !t.startsWith(prefix) && t.includes(prefix)) : [])
    .slice(0, 7)
    .map(([tag, count]) => ({ tag, count }));
  if (opts.length === 1 && opts[0].tag === prefix) opts = [];
  if (!opts.length) return ac.close();
  const p = ac.caretPoint(ta, hashAt, S.cam.z);
  ac.open(p.x, p.y, opts, prefix, tag => {
    const start = hashAt + 1;
    const after = ta.value.slice(pos);
    const space = /^\s/.test(after) ? '' : ' ';
    ta.value = ta.value.slice(0, start) + tag + space + after;
    const caret = start + tag.length + space.length;
    ta.setSelectionRange(caret, caret);
    onInput();
  });
}

// ---------------------------------------------------------------- keys

function wrap(mark) {
  const { selectionStart: a, selectionEnd: b, value: v } = ta;
  ta.setRangeText(mark + v.slice(a, b) + mark, a, b, 'end');
  if (a === b) ta.setSelectionRange(a + mark.length, a + mark.length);
  onInput();
}

function lineStart(pos) {
  return ta.value.lastIndexOf('\n', pos - 1) + 1;
}

/** Indent (dir 1) or outdent (dir -1) every line the selection touches by one level. */
function indentLines(dir) {
  const v = ta.value;
  const a = ta.selectionStart, b = ta.selectionEnd;
  const start = lineStart(a);
  // a selection ending right after a newline doesn't include the next line
  const last = b > a && v[b - 1] === '\n' ? b - 1 : b;
  let end = v.indexOf('\n', last);
  if (end < 0) end = v.length;
  const lines = v.slice(start, end).split('\n');
  const multi = lines.length > 1;
  let da = 0, db = 0;
  const out = lines.map((l, k) => {
    let d = 0;
    if (dir > 0) {
      if (!(multi && !l.trim())) { l = '  ' + l; d = 2; } // leave blank lines alone
    } else {
      const n = l.startsWith('\t') ? 1 : (l.match(/^ {1,2}/)?.[0].length || 0);
      l = l.slice(n);
      d = -n;
    }
    if (k === 0) da = d;
    db += d;
    return l;
  });
  ta.setRangeText(out.join('\n'), start, end, 'preserve');
  ta.setSelectionRange(Math.max(start, a + da), Math.max(start, b + db));
  onInput();
}

function onKey(e) {
  e.stopPropagation(); // keep global shortcuts out of the editor
  const mod = e.ctrlKey || e.metaKey;

  if (ac.isOpen()) {
    if (e.key === 'Escape') {
      const m = ta.value.slice(0, ta.selectionStart).match(TYPING_TAG);
      if (m) ignoreAt = ta.selectionStart - m[2].length - 1;
    }
    if (ac.handleKey(e)) { e.preventDefault(); return; }
  }

  if (e.key === 'Escape' || (mod && e.key === 'Enter')) {
    e.preventDefault();
    endEdit();
    return;
  }
  if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); wrap('**'); return; }
  if (mod && e.key.toLowerCase() === 'i') { e.preventDefault(); wrap('*'); return; }
  // like Google Docs: ctrl+] / ctrl+[ indent, ctrl+shift+> / < change the size
  if (mod && !e.shiftKey && (e.key === ']' || e.key === '[')) { e.preventDefault(); indentLines(e.key === ']' ? 1 : -1); return; }
  if (mod && e.shiftKey && (e.code === 'Period' || e.code === 'Comma')) { e.preventDefault(); changeSize(e.code === 'Period' ? 1 : -1); return; }
  if (e.altKey && e.code === 'KeyF') { e.preventDefault(); cycleFont(e.shiftKey ? -1 : 1); return; }

  const pos = ta.selectionStart;
  const ls = lineStart(pos);
  const line = ta.value.slice(ls, pos);

  if (e.key === 'Enter' && !e.shiftKey && pos === ta.selectionEnd) {
    const m = line.match(LIST_RE);
    if (m) {
      e.preventDefault();
      if (line.trim() === m[0].trim()) {
        if (m[1].length) {
          // empty nested item: step back out one level (like Google Docs)
          const n = m[1].startsWith('\t') ? 1 : Math.min(2, m[1].length);
          ta.setRangeText('', ls, ls + n, 'end');
          ta.setSelectionRange(pos - n, pos - n);
        } else {
          ta.setRangeText('', ls, pos, 'end'); // empty top-level item: end the list
        }
      } else {
        let marker = m[2];
        if (m[3]) marker = `${+m[3] + 1}${m[4]} `;
        marker = marker.replace(/\[[xX]\]/, '[ ]');
        ta.setRangeText('\n' + m[1] + marker, pos, pos, 'end');
      }
      onInput();
      return;
    }
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    indentLines(e.shiftKey ? -1 : 1);
    return;
  }
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) setTimeout(updateSuggest, 0);
}

