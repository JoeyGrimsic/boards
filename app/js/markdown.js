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

export function renderMarkdown(text) {
  let html = '';
  const lines = String(text || '').split('\n');
  lines.forEach((line, i) => {
    let m;
    if ((m = line.match(/^(#{1,3}) (.*)$/))) {
      html += `<div class="h${m[1].length}">${inline(m[2]) || '&nbsp;'}</div>`;
    } else if ((m = line.match(/^(\s*)(?:[-*] )?\[( |x|X)\] ?(.*)$/))) {
      const done = m[2] !== ' ';
      html += `<div class="ck${done ? ' done' : ''}" style="--ind:${m[1].length}"><span class="box" data-check="${i}"></span><span>${inline(m[3]) || '&nbsp;'}</span></div>`;
    } else if ((m = line.match(/^(\s*)[-*•] (.*)$/))) {
      html += `<div class="li" style="--ind:${m[1].length}">${inline(m[2]) || '&nbsp;'}</div>`;
    } else if ((m = line.match(/^(\s*)(\d+)[.)] (.*)$/))) {
      html += `<div class="li num" data-n="${m[2]}." style="--ind:${m[1].length}">${inline(m[3]) || '&nbsp;'}</div>`;
    } else if ((m = line.match(/^> ?(.*)$/))) {
      html += `<div class="quote">${inline(m[1]) || '&nbsp;'}</div>`;
    } else if (/^\s*(-{3,}|_{3,}|\*{3,})\s*$/.test(line)) {
      html += '<hr>';
    } else {
      html += `<div class="p">${inline(line) || '&nbsp;'}</div>`;
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
