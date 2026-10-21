// Just enough markdown for brainstorm notes: headings, bullets, checkboxes,
// quotes, **bold**, *italic*, ~~strike~~, `code`, links and #tags.
import { TAG_RE, tagColor } from './tags.js';

export const esc = s =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(raw) {
  const keep = [];
  const hold = html => `\u0000${keep.push(html) - 1}\u0000`;
  let s = raw
    .replace(/`([^`]+)`/g, (_, c) => hold(`<code>${esc(c)}</code>`))
    .replace(/\bhttps?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]']/g, url =>
      hold(`<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url.replace(/^https?:\/\/(www\.)?/, ''))}</a>`));
  s = esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/(^|[^\w])_(?!\s)(.+?)_(?!\w)/g, '$1<i>$2</i>')
    .replace(/~~(.+?)~~/g, '<s>$1</s>')
    .replace(TAG_RE(), (m, pre, tag) => {
      const t = tag.toLowerCase();
      return `${pre}<span class="tg" data-tag="${esc(t)}" style="--tc:${tagColor(t)}">#${tag}</span>`;
    });
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[+i]);
}

/** Indent level of a line's leading whitespace: two spaces (or one tab) per level. */
export function indentLevel(ws) {
  let cols = 0;
  for (const c of ws) cols += c === '\t' ? 2 : 1;
  return Math.min(Math.floor(cols / 2), 8);
}

export function renderMarkdown(text) {
  let html = '';
  const lines = String(text || '').split('\n');
  lines.forEach((raw, i) => {
    const ws = raw.match(/^[ \t]*/)[0];
    const lvl = indentLevel(ws);
    const line = raw.slice(ws.length);
    const st = lvl ? ` style="--lvl:${lvl}"` : '';
    let m;
    if (!lvl && (m = line.match(/^(#{1,3}) (.*)$/))) {
      html += `<div class="h${m[1].length}">${inline(m[2]) || '&nbsp;'}</div>`;
    } else if ((m = line.match(/^(?:[-*] )?\[( |x|X)\] ?(.*)$/))) {
      const done = m[1] !== ' ';
      html += `<div class="ck${done ? ' done' : ''}"${st}><span class="box" data-check="${i}"></span><span>${inline(m[2]) || '&nbsp;'}</span></div>`;
    } else if ((m = line.match(/^[-*•] (.*)$/))) {
      // bullet shape follows the level: ● ○ ■, then around again
      html += `<div class="li b${lvl % 3}"${st}>${inline(m[1]) || '&nbsp;'}</div>`;
    } else if ((m = line.match(/^(\d+)[.)] (.*)$/))) {
      html += `<div class="li num" data-n="${m[1]}."${st}>${inline(m[2]) || '&nbsp;'}</div>`;
    } else if ((m = line.match(/^> ?(.*)$/))) {
      html += `<div class="quote"${st}>${inline(m[1]) || '&nbsp;'}</div>`;
    } else if (!lvl && /^(-{3,}|_{3,}|\*{3,})\s*$/.test(line)) {
      html += '<hr>';
    } else {
      html += `<div class="p"${st}>${inline(line) || '&nbsp;'}</div>`;
    }
  });
  return html;
}

/** Flip the checkbox on line `i`. */
export function toggleCheck(text, i) {
  const lines = text.split('\n');
  lines[i] = lines[i].replace(/\[( |x|X)\]/, (_, c) => (c === ' ' ? '[x]' : '[ ]'));
  return lines.join('\n');
}
