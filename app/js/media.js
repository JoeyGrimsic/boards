// Getting stuff onto the board: paste, drag & drop, file picker, YouTube clips.
import { S, uid, addItem, mutate, select, getItem } from './state.js';
import { api, assetUrl } from './api.js';
import { spot, pasteItems } from './actions.js';
import { toast, modal } from './ui.js';
import { openMusicDialog } from './music.js';
import { endEdit, editor } from './text.js';
import { esc } from './markdown.js';
import { prepareThumb } from './anim.js';

export const YT_RE = /^(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com\/(watch\?|shorts\/|live\/|embed\/|playlist\?)|youtu\.be\/)\S+$/i;
const IMG_URL_RE = /^https?:\/\/\S+\.(png|jpe?g|gif|webp|avif|svg|bmp)(\?\S*)?$/i;
const R = Math.round;

function fit(w, h, max = 520) {
  const s = Math.min(1, max / w, max / h);
  return { w: R(w * s), h: R(h * s) };
}

function measureImage(url) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 400, h: img.naturalHeight || 300 });
    img.onerror = () => resolve({ w: 400, h: 300 });
    img.src = url;
  });
}

function measureVideo(url) {
  return new Promise(resolve => {
    const v = document.createElement('video');
    const done = d => { clearTimeout(t); v.removeAttribute('src'); v.load(); resolve(d); };
    const t = setTimeout(() => done({ w: 640, h: 360 }), 6000);
    v.preload = 'metadata';
    v.muted = true;
    v.onloadedmetadata = () => done({ w: v.videoWidth || 640, h: v.videoHeight || 360 });
    v.onerror = () => done({ w: 640, h: 360 });
    v.src = url;
  });
}

async function measure(fileOrUrl, kind) {
  const url = typeof fileOrUrl === 'string' ? fileOrUrl : URL.createObjectURL(fileOrUrl);
  try {
    return kind === 'video' ? await measureVideo(url) : await measureImage(url);
  } finally {
    if (typeof fileOrUrl !== 'string') URL.revokeObjectURL(url);
  }
}

function placeMedia(kind, src, dims, at, extra = {}) {
  const { w, h } = fit(dims.w, dims.h, kind === 'video' ? 560 : 520);
  return mutate(() => addItem({ id: uid(), type: kind, src, x: R(at.x - w / 2), y: R(at.y - h / 2), w, h, tags: [], ...extra }));
}

function placeAudio(src, title, at) {
  return mutate(() => addItem({
    id: uid(), type: 'music', x: R(at.x - 36), y: R(at.y - 36),
    music: { tracks: [{ src, title }], radius: 900, volume: 0.8 }, tags: [],
  }));
}

export async function addFiles(files, p = spot()) {
  const ids = [];
  let off = 0;
  for (const file of files) {
    const kind = (file.type || '').split('/')[0];
    if (!['image', 'video', 'audio'].includes(kind)) {
      toast(`can't put ${file.name || 'that'} on a board (yet)`, 'error');
      continue;
    }
    const busy = toast(`saving ${kind}…`, 'busy');
    try {
      const dims = kind === 'audio' ? null : await measure(file, kind);
      const res = await api.upload(S.name, file, file.name);
      if (kind === 'image') await prepareThumb(S.name, res.src, file, dims.h > dims.w); // preview ready before it's shown
      const at = { x: p.x + off, y: p.y + off };
      off += 40;
      const it = kind === 'audio'
        ? placeAudio(res.src, (file.name || 'audio').replace(/\.[^.]+$/, ''), at)
        : placeMedia(kind, res.src, dims, at);
      ids.push(it.id);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      busy.close();
    }
  }
  if (ids.length) select(ids);
}

/** Add media from a URL (downloaded by the server). Returns true on success. */
export async function addFromSrc(src, p = spot(), { quiet = false } = {}) {
  if (src.startsWith('data:') || src.startsWith('blob:')) {
    const blob = await (await fetch(src)).blob();
    await addFiles([new File([blob], 'paste', { type: blob.type })], p);
    return true;
  }
  const busy = toast('grabbing that image…', 'busy');
  try {
    const res = await api.fetchUrl(S.name, src);
    const url = assetUrl(S.name, res.src);
    const dims = await measure(url, res.kind);
    const it = res.kind === 'audio' ? placeAudio(res.src, res.name, p) : placeMedia(res.kind, res.src, dims, p);
    select([it.id]);
    return true;
  } catch (e) {
    if (!quiet) toast(e.message, 'error');
    return false;
  } finally {
    busy.close();
  }
}

function addTextItem(text, p) {
  const longest = Math.max(...text.split('\n').map(l => l.length));
  const w = Math.min(560, Math.max(200, longest * 11));
  const it = mutate(() => addItem({
    id: uid(), type: 'text', x: R(p.x - w / 2), y: R(p.y - 20), w, h: 0,
    text, font: 'round', size: 24, color: 'ink', bg: null,
  }));
  select([it.id]);
}

// Google's search-grid thumbnails: the clipboard snapshot is as good as these get
const THUMB_RE = /^https?:\/\/(encrypted-tbn\d*\.gstatic\.com|[^/]*\.googleusercontent\.com\/proxy)/i;

/** Handle anything from a clipboard / drop DataTransfer. */
export async function ingest(dt, p = spot()) {
  // read everything synchronously: the DataTransfer goes stale after an await
  const files = [...(dt.files || [])].filter(f => /^(image|video|audio)\//.test(f.type));
  const text = (dt.getData('text/plain') || '').trim();
  const html = dt.getData('text/html') || '';
  const uri = (dt.getData('text/uri-list') || '').split('\n').find(l => l && !l.startsWith('#'))?.trim();
  const imgSrc = html.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1]?.replace(/&amp;/g, '&');

  if (files.length) {
    // "Copy image" in a browser puts a flat PNG snapshot on the clipboard (one
    // frame of a GIF, re-encoded). If it came with a link to the original file,
    // fetch that instead so GIFs stay animated, and keep the snapshot as backup.
    const web = files.length === 1 && files[0].type.startsWith('image/') && imgSrc &&
      /^https?:/i.test(imgSrc) && !THUMB_RE.test(imgSrc);
    if (web && await addFromSrc(imgSrc, p, { quiet: true })) return;
    return addFiles(files, p);
  }
  if (text.startsWith('doodleboard:')) {
    try { return await pasteItems(JSON.parse(text.slice('doodleboard:'.length)), p); } catch { /* fall through */ }
  }
  if (imgSrc && !text) return addFromSrc(imgSrc, p);
  const link = text || uri || '';
  if (YT_RE.test(link)) return youtubeChooser(link, p);
  if (IMG_URL_RE.test(link) || /^data:image\//.test(link)) return addFromSrc(link, p);
  if (imgSrc) return addFromSrc(imgSrc, p);
  if (link) return addTextItem(text || uri, p);
}

export function handlePaste(e) {
  if (!S.name || document.querySelector('.modal-back')) return;
  const dt = e.clipboardData;
  if (!dt) return;
  const hasMedia = [...dt.files].some(f => /^(image|video|audio)\//.test(f.type));
  const target = e.target;
  // normal text paste into the editor / inputs
  if (!hasMedia && (editor() || target.closest?.('input,textarea'))) return;
  e.preventDefault();
  endEdit();
  ingest(dt);
}

export function pickFiles(p = spot()) {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = 'image/*,video/*,audio/*';
  input.onchange = () => addFiles([...input.files], p);
  input.click();
}

// ---------------------------------------------------------------- YouTube

function youtubeChooser(url, p) {
  const playlist = /[?&]list=/.test(url) && !/[?&]v=|youtu\.be\//.test(url);
  const sel = S.sel.size === 1 ? getItem([...S.sel][0]) : null;
  const target = sel && sel.type !== 'arrow' ? sel : null;
  const what = playlist ? 'the whole playlist' : 'saved as an mp3';
  const m = modal({
    title: playlist ? 'a YouTube playlist!' : 'a YouTube link!',
    body: `<p class="sub">${esc(url)}</p><div class="choices">` +
      (target ? `<button class="btn choice" data-act="music-sel"><span data-icon="music"></span>add to the selected thing's music<small>${what}, appended to its playlist</small></button>` : '') +
      `<button class="btn choice" data-act="music"><span data-icon="music"></span>${playlist ? 'a music playlist for this spot' : 'music for this spot'}<small>${what}, loops when you're nearby</small></button>` +
      (playlist ? '' : `<button class="btn choice" data-act="clip"><span data-icon="video"></span>video clip<small>download a snippet onto the board</small></button>`) +
      `<button class="btn choice" data-act="link"><span data-icon="link"></span>just the link<small>as a text box</small></button></div>`,
  });
  m.el.addEventListener('click', e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act || act === 'x') return;
    m.close();
    if (act === 'music') openMusicDialog({ at: p, url });
    if (act === 'music-sel') openMusicDialog({ targetId: target.id, url });
    if (act === 'clip') openClipDialog(url, p);
    if (act === 'link') addTextItem(url, p);
  });
}

export async function openClipDialog(url = '', p = spot()) {
  const info = await api.info().catch(() => ({}));
  const m = modal({
    title: 'video clip from YouTube',
    body: (!info.ytdlp || !info.ffmpeg ? needTools(info) : '') +
      `<label class="field">link<input class="input" name="url" placeholder="https://youtube.com/watch?v=…" value="${esc(url)}"></label>` +
      `<div class="row"><label class="field">start <input class="input" name="start" placeholder="0:00"></label>` +
      `<label class="field">end <input class="input" name="end" placeholder="0:30"></label></div>` +
      `<p class="sub">leave start/end empty to grab the whole video (720p max).</p><div class="status"></div>` +
      `<div class="actions"><span class="grow"></span><button class="btn txt" data-act="cancel">cancel</button>` +
      `<button class="btn txt primary" data-act="ok">grab clip</button></div>`,
  });
  m.$('[data-act="cancel"]').onclick = () => m.close();
  const go = async () => {
    const u = m.$('[name=url]').value.trim();
    if (!u) return m.$('[name=url]').focus();
    const btn = m.$('[data-act="ok"]');
    btn.disabled = true;
    m.$('.status').innerHTML = '<span class="spin"></span> downloading… (you can close this, it keeps going)';
    try {
      const res = await api.youtube(S.name, { url: u, mode: 'video', start: m.$('[name=start]').value, end: m.$('[name=end]').value });
      const dims = await measure(assetUrl(S.name, res.src), 'video');
      const it = placeMedia('video', res.src, dims, p, { title: res.title });
      select([it.id]);
      toast(`added “${res.title}”`);
      m.close();
    } catch (e) {
      if (m.closed) toast(e.message, 'error');
      else m.$('.status').innerHTML = `<span class="err">${esc(e.message)}</span>`;
      btn.disabled = false;
    }
  };
  m.$('[data-act="ok"]').onclick = go;
  m.el.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
}

export function needTools(info) {
  const miss = [!info.ytdlp && '<code>pip install yt-dlp</code>', !info.ffmpeg && '<code>winget install ffmpeg</code>'].filter(Boolean);
  return `<div class="warn">YouTube downloads need a couple of free tools: ${miss.join(' and ')} — then restart the server. ` +
    `(or drop <code>yt-dlp.exe</code> / <code>ffmpeg.exe</code> into the <code>tools</code> folder)</div>`;
}
