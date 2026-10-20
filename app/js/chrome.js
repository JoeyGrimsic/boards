// Everything around the canvas: toolbars, selection toolbar, tag editor,
// search, the center pieces & tags map, context menu and help.
import { S, on, emit, getItem, selected, mutate, select, undo, redo, saveNow } from './state.js';
import { icon, hydrateIcons } from './doodle.js';
import { worldToScreen, zoomCenter, fitAll, resetZoom, flyTo, itemsBox, screenToWorld } from './canvas.js';
import { box, union } from './geom.js';
import { FONT_LABEL, INKS, PAPERS, requestRender, elFor, invalidate } from './render.js';
import { allTags, itemTags, tagColor, TAG_BODY } from './tags.js';
import * as A from './actions.js';
import { pieces, pieceTitle, flyToPiece, go as goPiece, togglePiece } from './centers.js';
import { endEdit } from './text.js';
import { openMusicDialog, toggleSound, syncSoundUI, toggleVolumePopover, skipTrack, tracksOf, musicLabel } from './music.js';
import { pickFiles, openClipDialog, ingest } from './media.js';
import { toast, modal, promptText, cycleTheme } from './ui.js';
import { esc } from './markdown.js';
import * as ac from './ac.js';
import { api } from './api.js';

const $ = id => document.getElementById(id);
const seltools = $('seltools');
const panel = $('panel');
const searchbox = $('searchbox');
const ctx = $('ctx');
const tagedit = $('tagedit');
const titleEdit = $('title-edit');

// ---------------------------------------------------------------- commands

export const commands = {
  home: () => (location.hash = '#/'),
  text: () => A.createText(),
  heading: () => A.createHeading(),
  note: () => A.createNote(),
  piece: () => togglePiece(),
  prevpiece: () => goPiece(-1),
  nextpiece: () => goPiece(1),
  ptitle: () => { const [it] = selected(); if (it?.center) editCenterTitle(it.id); },
  arrow: () => toggleArrowMode(),
  music: () => openMusic(),
  media: () => pickFiles(),
  clip: () => openClipDialog(),
  undo: () => { endEdit(); undo() || toast('nothing to undo', 'quiet'); },
  redo: () => { endEdit(); redo() || toast('nothing to redo', 'quiet'); },
  search: () => openSearch(),
  nav: () => togglePanel(),
  threads: () => toggleThreads(),
  sound: () => toggleSound(),
  volume: btn => toggleVolumePopover(btn || document.querySelector('#top-right [data-cmd="volume"]')),
  skip: () => skipTrack(),
  theme: () => cycleTheme(),
  help: () => showHelp(),
  zoomin: () => zoomCenter(1.25),
  zoomout: () => zoomCenter(0.8),
  fit: () => fitView(),
  zoom100: () => resetZoom(),
  rename: () => renameBoard(),
  // selection
  font: () => A.cycleFont(1),
  bigger: () => A.changeSize(1),
  smaller: () => A.changeSize(-1),
  color: () => togglePalette(),
  tags: () => openTagEditor(),
  dup: () => A.duplicate(),
  front: () => A.bringToFront(),
  back: () => A.sendToBack(),
  del: () => A.deleteSelection(),
  edit: () => { const [it] = selected(); if (it) A.startEditing(it.id); },
  vplay: () => videoToggle(),
  vsound: () => videoSound(),
  vin: () => videoMark('inT'),
  vout: () => videoMark('outT'),
  vclear: () => videoClear(),
  alabel: () => arrowLabel(),
  aswap: () => arrowSwap(),
};

export function run(cmd) {
  commands[cmd]?.();
}

export function openMusic() {
  const items = selected().filter(i => i.type !== 'arrow');
  if (items.length === 1) openMusicDialog({ targetId: items[0].id });
  else openMusicDialog({ at: A.spot() });
}

export function fitView() {
  const items = selected().filter(i => i.type !== 'arrow');
  if (items.length) flyTo(itemsBox(items), { maxZ: 1.5 });
  else fitAll();
}

export function toggleArrowMode(on = !S.arrowMode) {
  S.arrowMode = on;
  document.body.classList.toggle('arrow-mode', on);
  syncButtons();
  if (on) toast('arrow mode · drag from one thing to another (esc to stop)', 'quiet');
}

export function toggleThreads() {
  S.showThreads = !S.showThreads;
  syncButtons();
  requestRender();
  toast(S.showThreads ? 'tag threads visible' : 'tag threads hidden (hover a tag to peek)', 'quiet');
  emit('settings');
}

export function syncButtons() {
  syncSoundUI();
  document.querySelector('[data-cmd="threads"]')?.classList.toggle('on', S.showThreads);
  document.querySelector('[data-cmd="arrow"]')?.classList.toggle('on', S.arrowMode);
  document.querySelector('[data-cmd="nav"]')?.classList.toggle('on', !panel.hidden);
}

document.addEventListener('click', e => {
  const b = e.target.closest('[data-cmd]');
  if (!b || !b.closest('#board')) return;
  commands[b.dataset.cmd]?.(b);
});

// keep the editor focused (and keyboard shortcuts working) when clicking toolbar buttons
seltools.addEventListener('mousedown', e => { if (!e.target.closest('input')) e.preventDefault(); });
document.getElementById('board').addEventListener('mousedown', e => { if (e.target.closest('.btn')) e.preventDefault(); });

// ---------------------------------------------------------------- board name + save state

export function showBoardName() {
  $('board-name').textContent = S.name || '';
  document.title = `${S.name} · doodleboard`;
}

async function renameBoard() {
  const name = await promptText('rename board', S.name, 'board name', 'rename');
  if (!name || name === S.name) return;
  try {
    await saveNow();
    const res = await api.renameBoard(S.name, name);
    S.name = res.name;
    history.replaceState(null, '', `#/b/${encodeURIComponent(res.name)}`);
    showBoardName();
    invalidate();
  } catch (e) {
    toast(e.message, 'error');
  }
}

on('savestate', st => {
  const el = $('save-state');
  el.dataset.state = st;
  el.textContent = { saved: 'saved', saving: 'saving…', dirty: '•', error: 'not saved!' }[st];
  el.title = st === 'error' ? "couldn't save — is the server still running?" : '';
});

// ---------------------------------------------------------------- zoom label, hint

on('camera', () => {
  $('zoom-label').textContent = Math.round(S.cam.z * 100) + '%';
  placeSeltools();
  placeTagEdit();
});

on('rendered', () => {
  $('hint').hidden = S.items.length > 0;
  placeSeltools();
  placeTagEdit();
});

// ---------------------------------------------------------------- selection toolbar

let selKey = '';

function swatch(color) {
  return `<span class="swatch" style="background:${color}"></span>`;
}

function buildSeltools() {
  const items = selected();
  const key = items.map(i => [i.id, i.type, i.font, i.color, i.bg, i.music ? 'm' : '', i.center ? 'c' : '', i.inT, i.outT].join('|')).join() + S.editing;
  if (key === selKey && !seltools.hidden) return;
  selKey = key;
  if (!items.length) { seltools.hidden = true; return; }
  const types = new Set(items.map(i => i.type));
  const one = items.length === 1 ? items[0] : null;
  const B = (cmd, title, inner) => `<button class="btn icon" data-cmd="${cmd}" title="${title}">${inner}</button>`;
  let h = '';
  const text = items.find(i => i.type === 'text');
  if (text) {
    h += `<button class="btn txt font" data-cmd="font" title="font (F, or alt+F while typing)">${icon('font')}<span>${FONT_LABEL[text.font] || 'print'}</span></button>`;
  }
  if (text || types.has('image') || types.has('video')) {
    h += B('smaller', 'smaller ( [ )', '<b class="t">A−</b>') + B('bigger', 'bigger ( ] )', '<b class="t">A+</b>');
  }
  const colorable = items.find(i => ['text', 'arrow'].includes(i.type));
  if (colorable) {
    const c = colorable.bg ? PAPERS[colorable.bg] : INKS[colorable.color] || INKS.ink;
    h += B('color', 'color (C)', swatch(c));
  }
  if (one?.type === 'video') {
    h += '<span class="sep"></span>' + B('vplay', 'play / pause', icon('play')) + B('vsound', 'sound on/off', icon('sound')) +
      B('vin', 'snippet starts here', icon('inpoint')) + B('vout', 'snippet ends here', icon('outpoint'));
    if (one.inT || one.outT) h += B('vclear', 'clear snippet', icon('close'));
  }
  if (one?.type === 'arrow') h += B('alabel', 'label', icon('pencil')) + B('aswap', 'flip direction', icon('swap'));
  if (one?.type === 'text') h += B('edit', 'edit text (enter)', icon('pencil'));
  if (!types.has('arrow') || items.length > 1) {
    h += '<span class="sep"></span>' + B('tags', 'tags (#)', icon('tag'));
    if (one) h += B('music', 'music (M)', icon('music')).replace('btn icon', one.music ? 'btn icon on' : 'btn icon');
    const allCenter = items.filter(i => i.type !== 'arrow').every(i => i.center);
    h += B('piece', allCenter ? 'stop being a center piece (P)' : 'make a center piece (P)', icon('sparkle')).replace('btn icon', allCenter ? 'btn icon on' : 'btn icon');
  }
  h += '<span class="sep"></span>';
  if (!types.has('arrow')) h += B('dup', 'duplicate (ctrl+D)', icon('copy')) + B('front', 'bring to front', icon('front')) + B('back', 'send to back', icon('back'));
  h += B('del', 'delete (del)', icon('trash'));
  h += '<div id="palette" class="sketch" hidden></div>';
  seltools.innerHTML = h;
  seltools.hidden = false;
  placeSeltools();
}

function placeSeltools() {
  if (seltools.hidden) return;
  const items = selected();
  const boxes = items.map(i => (i.type === 'arrow' ? arrowBox(i) : box(i))).filter(Boolean);
  const b = union(boxes);
  if (!b) { seltools.hidden = true; return; }
  const a = worldToScreen(b.x, b.y);
  const c = worldToScreen(b.x + b.w, b.y + b.h);
  const w = seltools.offsetWidth, h = seltools.offsetHeight;
  let x = (a.x + c.x) / 2 - w / 2;
  let y = a.y - h - 22;
  if (y < 64) y = c.y + 22;
  if (y > innerHeight - h - 10) y = Math.max(64, innerHeight / 2);
  x = Math.max(70, Math.min(innerWidth - w - 10, x));
  seltools.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

function arrowBox(a) {
  const f = getItem(a.from), t = getItem(a.to);
  return f && t ? union([box(f), box(t)]) : null;
}

on('selection', () => {
  buildSeltools();
  closeTagEditor();
});
on('change', buildSeltools);

function togglePalette() {
  const pal = $('palette');
  if (!pal) return;
  if (!pal.hidden) { pal.hidden = true; return; }
  const items = selected();
  const hasText = items.some(i => i.type === 'text');
  let h = '<div class="row">' + Object.entries(INKS).map(([k, v]) => `<button class="sw" data-ink="${k}" title="${k}">${swatch(v)}</button>`).join('') + '</div>';
  if (hasText) {
    h += '<div class="row"><button class="sw" data-paper="" title="no background (plain text)">' + swatch('transparent') + '</button>' +
      Object.entries(PAPERS).map(([k, v]) => `<button class="sw paper" data-paper="${k}" title="${k} note">${swatch(v)}</button>`).join('') + '</div>';
  }
  pal.innerHTML = h;
  pal.hidden = false;
}

seltools.addEventListener('click', e => {
  const sw = e.target.closest('.sw');
  if (!sw) return;
  if (sw.dataset.ink !== undefined) A.setInk(sw.dataset.ink);
  if (sw.dataset.paper !== undefined) A.setPaper(sw.dataset.paper || null);
});

// ---------------------------------------------------------------- video controls

const videoOf = () => {
  const [it] = selected();
  return it?.type === 'video' ? { it, el: elFor(it.id), v: elFor(it.id)?.querySelector('video') } : null;
};

export function videoToggle(id) {
  const o = id ? { it: getItem(id), el: elFor(id), v: elFor(id)?.querySelector('video') } : videoOf();
  if (!o?.v) return;
  if (o.v.paused || o.el._hoverPlay) {
    o.el._hoverPlay = false;
    o.el._sound = true;
    o.v.muted = false;
    o.v.play();
  } else o.v.pause();
}

function videoSound() {
  const o = videoOf();
  if (!o) return;
  o.el._sound = !o.el._sound;
  o.v.muted = !o.el._sound;
  toast(o.el._sound ? 'video sound on' : 'video muted', 'quiet');
}

function videoMark(key) {
  const o = videoOf();
  if (!o) return;
  const t = Math.round(o.v.currentTime * 10) / 10;
  mutate(() => {
    o.it[key] = t;
    if (o.it.inT && o.it.outT && o.it.outT <= o.it.inT) delete o.it[key === 'inT' ? 'outT' : 'inT'];
  });
  toast(`snippet ${key === 'inT' ? 'starts' : 'ends'} at ${t.toFixed(1)}s`, 'quiet');
}

function videoClear() {
  const o = videoOf();
  if (o) mutate(() => { delete o.it.inT; delete o.it.outT; });
}

// ---------------------------------------------------------------- arrows

async function arrowLabel() {
  const [a] = selected();
  if (a?.type !== 'arrow') return;
  const label = await promptText('arrow label', a.label || '', 'e.g. leads to, because, but…');
  if (label !== null) mutate(() => (a.label = label));
}

function arrowSwap() {
  const [a] = selected();
  if (a?.type === 'arrow') mutate(() => ([a.from, a.to] = [a.to, a.from]));
}

// ---------------------------------------------------------------- center piece titles

export function editCenterTitle(id) {
  const it = getItem(id);
  const el = elFor(id)?.querySelector('.ctitle');
  if (!it?.center || !el) return;
  endEdit();
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  titleEdit.hidden = false;
  titleEdit.value = it.center.title || '';
  Object.assign(titleEdit.style, {
    left: r.left + 'px', top: r.top + 'px',
    fontSize: parseFloat(cs.fontSize) * S.cam.z + 'px',
    minWidth: Math.max(160, r.width + 40) + 'px',
  });
  titleEdit.focus();
  titleEdit.select();
  const before = it.center.title;
  let done = false;
  const finish = commit => {
    if (done) return;
    done = true;
    titleEdit.hidden = true;
    titleEdit.onkeydown = titleEdit.onblur = null;
    const v = titleEdit.value.trim();
    if (commit && v && v !== before) mutate(() => (it.center = { ...it.center, title: v }));
  };
  titleEdit.onkeydown = e => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  };
  titleEdit.onblur = () => finish(true);
}

// ---------------------------------------------------------------- tag editor

let tagTargets = [];

export function openTagEditor() {
  const items = selected().filter(i => i.type !== 'arrow');
  if (!items.length) return;
  endEdit();
  tagTargets = items.map(i => i.id);
  tagedit.hidden = false;
  drawTagEdit();
  placeTagEdit();
  tagedit.querySelector('input').focus();
}

function closeTagEditor() {
  if (tagedit.hidden) return;
  tagedit.hidden = true;
  tagTargets = [];
  ac.close();
}

function currentTags() {
  const set = new Set();
  for (const id of tagTargets) for (const t of getItem(id)?.tags || []) set.add(t);
  return [...set];
}

function drawTagEdit() {
  const tags = currentTags();
  const inline = [...new Set(tagTargets.flatMap(id => [...itemTags(getItem(id) || {})]))].filter(t => !tags.includes(t));
  tagedit.innerHTML =
    '<div class="pills">' +
    tags.map(t => `<span class="pill tg" style="--tc:${tagColor(t)}">#${esc(t)}<button data-rm="${esc(t)}" title="remove">×</button></span>`).join('') +
    inline.map(t => `<span class="pill tg ghost" style="--tc:${tagColor(t)}" title="written in the text">#${esc(t)}</span>`).join('') +
    `<input placeholder="${tags.length ? 'add another…' : 'add a tag…'}" spellcheck="false"></div>` +
    '<div class="hint">enter to add · backspace removes · esc closes</div>';
  const input = tagedit.querySelector('input');
  input.addEventListener('input', suggestTags);
  input.addEventListener('keydown', tagKey);
  input.addEventListener('blur', () => setTimeout(() => {
    if (!tagedit.contains(document.activeElement)) closeTagEditor();
  }, 120));
}

tagedit.addEventListener('mousedown', e => {
  if (e.target.tagName !== 'INPUT') e.preventDefault();
  const rm = e.target.closest('[data-rm]');
  if (rm) {
    const t = rm.dataset.rm;
    A.setTagsFor(tagTargets, cur => cur.filter(x => x !== t));
    drawTagEdit();
    tagedit.querySelector('input').focus();
  }
});

const cleanTag = s => (s.replace(/^#+/, '').match(new RegExp(`^${TAG_BODY}`, 'u'))?.[0] || '').toLowerCase();

function addTag(raw) {
  const t = cleanTag(raw);
  if (!t) return;
  A.setTagsFor(tagTargets, cur => (cur.includes(t) ? cur : [...cur, t]));
  drawTagEdit();
  tagedit.querySelector('input').focus();
}

function suggestTags() {
  const input = tagedit.querySelector('input');
  const q = cleanTag(input.value);
  const have = new Set(currentTags());
  const opts = [...allTags()].filter(([t]) => !have.has(t) && t.startsWith(q) && t !== q)
    .slice(0, 7).map(([tag, count]) => ({ tag, count }));
  const r = input.getBoundingClientRect();
  ac.open(r.left, r.bottom, opts, q, addTag);
}

function tagKey(e) {
  e.stopPropagation();
  const input = e.target;
  if (ac.isOpen() && ['ArrowUp', 'ArrowDown', 'Tab'].includes(e.key)) {
    e.preventDefault();
    ac.handleKey(e);
    return;
  }
  if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab' || (e.key === ' ' && input.value)) {
    // enter adds what you typed, unless you arrowed to a suggestion
    e.preventDefault();
    const c = ac.current();
    ac.close();
    addTag(c?.moved ? c.tag : input.value);
  } else if (e.key === 'Backspace' && !input.value) {
    const tags = currentTags();
    if (tags.length) {
      const t = tags[tags.length - 1];
      A.setTagsFor(tagTargets, cur => cur.filter(x => x !== t));
      drawTagEdit();
      tagedit.querySelector('input').focus();
    }
  } else if (e.key === 'Escape') {
    if (ac.isOpen()) ac.close();
    else closeTagEditor();
  }
}

function placeTagEdit() {
  if (tagedit.hidden) return;
  const b = union(tagTargets.map(getItem).filter(Boolean).map(box));
  if (!b) return closeTagEditor();
  const p = worldToScreen(b.x + b.w / 2, b.y + b.h);
  const w = tagedit.offsetWidth;
  tagedit.style.transform = `translate(${Math.round(Math.max(10, Math.min(innerWidth - w - 10, p.x - w / 2)))}px, ${Math.round(Math.min(innerHeight - 90, p.y + 16))}px)`;
}

// ---------------------------------------------------------------- search

let hits = [];
let hitIdx = -1;

export function openSearch() {
  endEdit();
  searchbox.hidden = false;
  const input = searchbox.querySelector('input');
  input.focus();
  input.select();
  doSearch();
}

export function closeSearch() {
  searchbox.hidden = true;
  S.matches = new Set();
  requestRender();
}

function haystack(it) {
  return [it.text, it.center?.title, it.label, ...tracksOf(it.music).map(t => t.title), it.src?.split('/').pop(), ...(it.tags || []).map(t => '#' + t)]
    .filter(Boolean).join(' ').toLowerCase();
}

function doSearch() {
  const q = searchbox.querySelector('input').value.trim().toLowerCase();
  hits = [];
  if (q) {
    const tag = q.startsWith('#') ? q.slice(1) : null;
    hits = S.items.filter(it => it.type !== 'arrow' && (tag ? itemTags(it).has(tag) || haystack(it).includes(q) : haystack(it).includes(q)));
  }
  S.matches = new Set(hits.map(h => h.id));
  hitIdx = -1;
  const res = searchbox.querySelector('.results');
  res.innerHTML = q && !hits.length ? '<div class="none">nothing found</div>' :
    hits.slice(0, 8).map((it, i) => {
      const label = it.center?.title || musicLabel(it.music) || (it.text || '').replace(/\s+/g, ' ').slice(0, 70) || it.src?.split('/').pop() || it.type;
      return `<div class="hit" data-i="${i}"><span class="ty">${icon({ text: 'text', image: 'image', video: 'video', music: 'music' }[it.type] || 'dots')}</span>${esc(label)}</div>`;
    }).join('') + (hits.length > 8 ? `<div class="none">+${hits.length - 8} more (enter to step through)</div>` : '');
  requestRender();
}

function gotoHit(i) {
  if (!hits.length) return;
  hitIdx = (i + hits.length) % hits.length;
  const it = hits[hitIdx];
  flyTo(box(it), { maxZ: 1.2, pad: 160 });
  select([it.id]);
}

searchbox.querySelector('input').addEventListener('input', doSearch);
searchbox.querySelector('input').addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Enter') gotoHit(hitIdx + (e.shiftKey ? -1 : 1));
  if (e.key === 'Escape') closeSearch();
});
searchbox.querySelector('.results').addEventListener('mousedown', e => {
  e.preventDefault();
  const h = e.target.closest('.hit');
  if (h) gotoHit(+h.dataset.i);
});

// ---------------------------------------------------------------- navigator panel

export function togglePanel(show = panel.hidden) {
  panel.hidden = !show;
  if (show) drawPanel();
  syncButtons();
}

let panelTimer = null;
on('change', () => {
  if (panel.hidden) return;
  clearTimeout(panelTimer);
  panelTimer = setTimeout(drawPanel, 250);
});
on('focus', () => { if (!panel.hidden) drawPanel(); });

function drawPanel() {
  const centers = pieces();
  const music = S.items.filter(i => tracksOf(i.music).length);
  const tags = [...allTags()];
  panel.innerHTML =
    `<div class="phead"><h3>${icon('compass')} map</h3><button class="btn icon mini" data-close>${icon('close')}</button></div>` +
    `<h4>center pieces</h4>` +
    (centers.length ? centers.map(c => `<button class="nav-row" data-piece="${c.id}">${icon('sparkle', 'mini lead')}${esc(pieceTitle(c))}${c.music ? icon('music', 'mini') : ''}</button>`).join('')
      : '<p class="empty">select something and press <kbd>P</kbd> to make it a center piece — then hop between them with <kbd>←</kbd> <kbd>→</kbd></p>') +
    `<h4>tags <label class="tog"><input type="checkbox" data-threads ${S.showThreads ? 'checked' : ''}> threads</label></h4>` +
    (tags.length ? '<div class="tagcloud">' + tags.map(([t, n]) =>
      `<button class="pill tg${S.focusTag === t ? ' on' : ''}" data-tag="${esc(t)}" style="--tc:${tagColor(t)}">#${esc(t)} <small>${n}</small></button>`).join('') + '</div>'
      : '<p class="empty">type <kbd>#something</kbd> in any text, or press <kbd>#</kbd> on a selected item</p>') +
    (S.focusTag ? `<p class="focus-note">focusing <b>#${esc(S.focusTag)}</b> · <button class="link" data-unfocus>show everything</button></p>` : '') +
    (music.length ? '<h4>music</h4>' + music.map(m => `<button class="nav-row" data-go="${m.id}">${icon('music', 'mini')}${esc(musicLabel(m.music) || 'music')}</button>`).join('') : '');
}

panel.addEventListener('click', e => {
  const piece = e.target.closest('[data-piece]');
  if (piece && getItem(piece.dataset.piece)) flyToPiece(getItem(piece.dataset.piece));
  const go = e.target.closest('[data-go]');
  if (go) {
    const it = getItem(go.dataset.go);
    if (it) { flyTo(box(it), { maxZ: 1, pad: 60 }); select([it.id]); }
  }
  const tag = e.target.closest('[data-tag]');
  if (tag) A.focusTag(tag.dataset.tag);
  if (e.target.closest('[data-unfocus]')) A.focusTag(S.focusTag);
  if (e.target.closest('[data-close]')) togglePanel(false);
});
panel.addEventListener('change', e => {
  if (e.target.matches('[data-threads]')) toggleThreads();
});
panel.addEventListener('mouseover', e => {
  const t = e.target.closest('[data-tag]')?.dataset.tag || null;
  if (t !== S.hoverTag) { S.hoverTag = t; requestRender(); }
});
panel.addEventListener('mouseleave', () => { S.hoverTag = null; requestRender(); });

// ---------------------------------------------------------------- context menu

export function openContextMenu(sx, sy, itemId) {
  const p = screenToWorld(sx, sy);
  const it = itemId && getItem(itemId);
  const row = (act, ic, label, key = '') => `<button data-ctx="${act}">${icon(ic)}<span>${label}</span><kbd>${key}</kbd></button>`;
  let h = '';
  if (it) {
    if (it.type === 'text') h += row('edit', 'pencil', 'edit', 'enter');
    if (it.type !== 'arrow') h += row('piece', 'sparkle', it.center ? 'stop being a center piece' : 'make a center piece', 'P');
    if (it.center) h += row('ptitle', 'pencil', 'rename center piece', '');
    if (it.type !== 'arrow') h += row('tags', 'tag', 'tags', '#') + row('music', 'music', it.music ? 'change music' : 'add music', 'M');
    if (it.type === 'video') h += row('vplay', 'play', 'play / pause', '');
    if (it.type !== 'arrow') h += row('dup', 'copy', 'duplicate', 'ctrl D') + row('front', 'front', 'bring to front', '') + row('back', 'back', 'send to back', '');
    h += row('del', 'trash', 'delete', 'del');
  } else {
    h += row('text', 'text', 'text', 'T') + row('heading', 'heading', 'heading', 'H') + row('note', 'note', 'sticky note', 'N') +
      row('music', 'music', 'music spot', 'M') + row('media', 'image', 'image / video file…', 'I') +
      row('clip', 'youtube', 'YouTube clip…', 'V') + row('paste', 'copy', 'paste here', 'ctrl V') + '<hr>' + row('fit', 'fit', 'show everything', '0');
  }
  ctx.innerHTML = h;
  ctx.hidden = false;
  const w = ctx.offsetWidth, hh = ctx.offsetHeight;
  ctx.style.left = Math.min(sx, innerWidth - w - 8) + 'px';
  ctx.style.top = Math.min(sy, innerHeight - hh - 8) + 'px';
  ctx.onclick = async e => {
    const act = e.target.closest('[data-ctx]')?.dataset.ctx;
    if (!act) return;
    ctx.hidden = true;
    S.mouse = p;
    if (it) select([it.id]);
    if (act === 'text') A.createText(p);
    else if (act === 'heading') A.createHeading(p);
    else if (act === 'note') A.createNote(p);
    else if (act === 'media') pickFiles(p);
    else if (act === 'clip') openClipDialog('', p);
    else if (act === 'music' && !it) openMusicDialog({ at: p });
    else if (act === 'paste') pasteFromClipboard(p);
    else run(act);
  };
}

export function closeContextMenu() {
  ctx.hidden = true;
}

async function pasteFromClipboard(p) {
  try {
    const items = await navigator.clipboard.read();
    const dt = new DataTransfer();
    for (const item of items) {
      for (const type of item.types) {
        const blob = await item.getType(type);
        if (type.startsWith('image/')) dt.items.add(new File([blob], 'paste', { type }));
        else if (type === 'text/plain' || type === 'text/html') dt.setData(type, await blob.text());
      }
    }
    ingest(dt, p);
  } catch {
    toast('the browser blocked clipboard access — use ctrl+V instead', 'error');
  }
}

// ---------------------------------------------------------------- help

export function showHelp() {
  const k = (keys, what) => `<tr><td>${keys.split(' ').map(x => `<kbd>${x.replace(/_/g, ' ')}</kbd>`).join(' ')}</td><td>${what}</td></tr>`;
  modal({
    title: 'shortcuts',
    cls: 'help',
    body: `<div class="cols"><table>
      <tr><th colspan="2">make things</th></tr>
      ${k('double-click', 'text box right there')}
      ${k('T', 'text')}${k('H', 'heading / title')}${k('N', 'sticky note')}
      ${k('A', 'arrow mode (or alt+drag from a thing)')}
      ${k('M', 'music for selection / new music spot')}
      ${k('I', 'image / video / audio file')}${k('V', 'YouTube clip')}
      ${k('ctrl+V', 'paste images, links, text, items')}
      <tr><th colspan="2">tags</th></tr>
      ${k('#', 'tag the selected things')}
      ${k('tab', 'accept a tag suggestion')}${k('esc', 'ignore suggestions')}
      ${k('L', 'show / hide tag threads')}
      ${k('G', 'map: center pieces, tags, music')}
      <tr><th colspan="2">center pieces</th></tr>
      ${k('P', 'make the selection a center piece (or stop)')}
      ${k('← →', 'hop to the previous / next center piece')}
      ${k('double-click_title', 'rename it')}
    </table><table>
      <tr><th colspan="2">text</th></tr>
      ${k('enter', 'edit selected text')}${k('esc', 'stop editing')}
      ${k('F', 'next font (alt+F while typing)')}
      ${k('[ ]', 'smaller / bigger (ctrl+[ ] while typing)')}
      ${k('C', 'next color')}
      ${k('ctrl+B ctrl+I', 'bold / italic')}
      <tr><td colspan="2">start a line with <code>- </code> bullet · <code>[ ] </code> checkbox · <code># </code> big heading</td></tr>
      <tr><th colspan="2">move around</th></tr>
      ${k('drag', 'pan (on empty space)')}${k('wheel', 'zoom')}
      ${k('space+drag', 'pan from anywhere')}${k('shift+drag', 'box select')}
      ${k('0', 'fit all / fit selection')}${k('1', '100%')}
      ${k('/', 'search')}${k('shift+M', 'music on/off')}${k('speaker_button', 'volume slider')}${k('shift+T', 'theme')}
      ${k('ctrl+arrows', 'nudge the selection')}
      ${k('ctrl+Z ctrl+Y', 'undo / redo')}${k('ctrl+D', 'duplicate')}${k('del', 'delete')}
    </table></div>
    <p class="sub">everything saves automatically into the board's folder on disk — pasted images too.</p>`,
  });
}

// ---------------------------------------------------------------- misc

on('theme', () => requestRender());

export function initChrome() {
  hydrateIcons(document.getElementById('board'));
  syncButtons();
}

