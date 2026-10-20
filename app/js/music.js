// Spatial music: anything can carry a playlist that fades in when you're
// zoomed in close to it. Only the nearest one plays.
import { S, getItem, mutate, addItem, uid, select, removeItems } from './state.js';
import { viewCenter, viewBox, flyCam, camFor } from './canvas.js';
import { box, center, clamp, contains } from './geom.js';
import { api, assetUrl } from './api.js';
import { modal, toast } from './ui.js';
import { icon, hydrateIcons } from './doodle.js';
import { esc } from './markdown.js';
import { needTools } from './media.js';
import { elFor, requestRender } from './render.js';
import { trimEditor, trimLabel } from './trim.js';

const ZOOM_IN = 0.45;  // need at least this much zoom before music kicks in
const players = new Map(); // item id -> { id, audio, idx, url, vol, seek }

const load = k => { try { return localStorage.getItem(k); } catch { return null; } };
const store = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

let soundOn = load('doodle-sound') !== 'off';
let master = (() => { const v = parseFloat(load('doodle-volume')); return isFinite(v) ? clamp(v, 0, 1) : 0.8; })();
let blocked = false;     // browser wants a click before audio may play
let previewing = false;  // the trim editor is playing a preview
const np = document.getElementById('nowplaying');
const volpop = document.getElementById('volpop');

export const isSoundOn = () => soundOn;
export const getMaster = () => master;
export const setPreviewing = v => { previewing = v; };

// ---------------------------------------------------------------- playlist data

/** The songs on an item, whichever format it was saved in. */
export function tracksOf(m) {
  if (!m) return [];
  if (Array.isArray(m.tracks)) return m.tracks.filter(t => t && t.src);
  return m.src ? [{ src: m.src, title: m.title }] : [];
}

/** Upgrade old single-song music ({src, title}) to a playlist ({tracks: [...]}). */
export function normalizeMusic(items) {
  for (const it of items) {
    if (!it.music || Array.isArray(it.music.tracks)) continue;
    const { src, title, ...rest } = it.music;
    it.music = { ...rest, tracks: tracksOf({ src, title }) };
  }
}

export function musicLabel(m) {
  const t = tracksOf(m);
  if (!t.length) return '';
  return t.length > 1 ? `${t[0].title}  +${t.length - 1}` : t[0].title;
}

// ---------------------------------------------------------------- volume

export function toggleSound() {
  soundOn = !soundOn;
  store('doodle-sound', soundOn ? 'on' : 'off');
  toast(soundOn ? 'music on' : 'music muted', 'quiet');
  syncSoundUI();
  tick();
}

export function setMaster(v) {
  master = clamp(v, 0, 1);
  store('doodle-volume', String(master));
  if (!soundOn && master > 0) { soundOn = true; store('doodle-sound', 'on'); }
  document.querySelectorAll('.item.video video').forEach(vid => (vid.volume = master));
  syncSoundUI();
}

export function syncSoundUI() {
  const muted = !soundOn || master === 0;
  document.querySelectorAll('[data-cmd="volume"], [data-vol="mute"]').forEach(b => {
    b.innerHTML = icon(muted ? 'mute' : 'sound');
    b.classList.toggle('off', muted);
  });
  const range = volpop.querySelector('input');
  range.value = master;
  range.style.setProperty('--fill', `${master * 100}%`);
  volpop.classList.toggle('muted', !soundOn);
  volpop.querySelector('.pct').textContent = soundOn ? `${Math.round(master * 100)}%` : 'muted';
}

export function toggleVolumePopover(anchor) {
  if (!volpop.hidden || !anchor) { volpop.hidden = true; return; }
  volpop.hidden = false;
  syncSoundUI();
  const r = anchor.getBoundingClientRect();
  const w = volpop.offsetWidth, h = volpop.offsetHeight;
  let y = r.bottom + 10;
  if (y + h > innerHeight - 8) y = r.top - h - 10;
  volpop.style.left = clamp(r.left + r.width / 2 - w / 2, 8, innerWidth - w - 8) + 'px';
  volpop.style.top = y + 'px';
}

volpop.querySelector('input').addEventListener('input', e => setMaster(+e.target.value));
volpop.querySelector('[data-vol="mute"]').addEventListener('click', toggleSound);
volpop.addEventListener('keydown', e => e.stopPropagation());
addEventListener('pointerdown', e => {
  if (!volpop.hidden && !volpop.contains(e.target) && !e.target.closest?.('[data-cmd="volume"]')) volpop.hidden = true;
}, true);

// ---------------------------------------------------------------- playback

function reach(it, c) {
  const m = it.music;
  const b = box(it);
  const r = m.radius ?? 900;
  const cc = center(b);
  const d = Math.hypot(c.x - cc.x, c.y - cc.y);
  const inner = r * 0.55;
  return { f: d <= inner ? 1 : Math.max(0, 1 - (d - inner) / (r - inner)), area: Math.PI * r * r };
}

function newPlayer(id) {
  const audio = new Audio();
  audio.preload = 'auto';
  const p = { id, audio, idx: 0, url: null, vol: 0, seek: false };
  audio.addEventListener('loadedmetadata', () => {
    if (!p.seek) return;
    p.seek = false;
    audio.currentTime = tracksOf(getItem(id)?.music)[p.idx]?.start || 0;
  });
  audio.addEventListener('ended', () => next(p));
  return p;
}

function load_(p, track) {
  const url = assetUrl(S.name, track.src);
  if (url === p.url) {
    p.audio.currentTime = track.start || 0;
  } else {
    p.url = url;
    p.seek = true;
    p.audio.src = url;
  }
}

/** Move a player on to its next song (or loop the only one). */
function next(p) {
  const it = getItem(p.id);
  const tracks = tracksOf(it?.music);
  if (!tracks.length) return;
  if (tracks.length > 1) {
    if (it.music.shuffle) {
      let i;
      do i = Math.floor(Math.random() * tracks.length); while (i === p.idx);
      p.idx = i;
    } else p.idx = (p.idx + 1) % tracks.length;
  }
  load_(p, tracks[p.idx]);
  if (p.vol > 0.002) p.audio.play().catch(() => {});
}

export function skipTrack() {
  let loudest = null;
  for (const p of players.values()) if (!loudest || p.vol > loudest.vol) loudest = p;
  if (loudest && loudest.vol > 0.01) next(loudest);
}

function tick() {
  let best = null, bestF = 0, bestArea = Infinity;
  if (S.name) {
    const c = viewCenter();
    const zf = clamp((S.cam.z - ZOOM_IN * 0.6) / (ZOOM_IN * 0.4), 0, 1);
    for (const it of S.items) {
      if (!tracksOf(it.music).length) continue;
      const { f, area } = reach(it, c);
      const score = f * zf;
      if (score > bestF + 0.001 || (score > 0 && Math.abs(score - bestF) <= 0.001 && area < bestArea)) {
        best = it; bestF = score; bestArea = area;
      }
    }
  }
  const targetId = best && soundOn && !previewing ? best.id : null;
  if (targetId && !players.has(targetId)) players.set(targetId, newPlayer(targetId));

  let loudest = null;
  for (const [id, p] of players) {
    const it = getItem(id);
    const tracks = tracksOf(it?.music);
    if (!tracks.length) {
      p.audio.pause();
      p.audio.removeAttribute('src');
      players.delete(id);
      elFor(id)?.classList.remove('playing');
      continue;
    }
    if (p.idx >= tracks.length) p.idx = 0;
    const track = tracks[p.idx];
    const url = assetUrl(S.name, track.src);
    if (p.url !== url) load_(p, track);
    else if (!p.seek && p.audio.readyState >= 1) {
      // the song may have been trimmed while playing
      if (track.start && p.audio.currentTime < track.start - 0.3) p.audio.currentTime = track.start;
      if (track.end && p.audio.currentTime >= track.end) next(p);
    }
    const t = id === targetId ? bestF * (it.music.volume ?? 0.8) : 0;
    p.vol += (t - p.vol) * (t > p.vol ? 0.08 : 0.18);
    if (Math.abs(t - p.vol) < 0.003) p.vol = t;
    p.audio.volume = clamp(p.vol * master, 0, 1);
    if (t > 0 && p.audio.paused && !blocked) {
      p.audio.play().catch(err => { if (err.name === 'NotAllowedError') blocked = true; });
    }
    if (p.vol <= 0.002 && t === 0 && !p.audio.paused) p.audio.pause();
    p.title = track.title;
    p.count = tracks.length;
    if (!loudest || p.vol > loudest.vol) loudest = p;
    elFor(id)?.classList.toggle('playing', p.vol > 0.02 && !p.audio.paused);
  }
  showNowPlaying(loudest && loudest.vol > 0.01 ? loudest : null, best);
}

function showNowPlaying(p, best) {
  const pending = blocked && best && soundOn;
  const title = p?.title || (pending ? musicLabel(best.music) : '');
  np.hidden = !title;
  if (!title) return;
  np.classList.toggle('blocked', !!pending && !p);
  const label = pending && !p ? 'click anywhere to let the music play' : title;
  if (np._label !== label) {
    np._label = label;
    np.querySelector('.np-title').textContent = label;
  }
  np.querySelector('[data-cmd="skip"]').hidden = !(p && p.count > 1);
}

export function stopAll() {
  for (const p of players.values()) { p.audio.pause(); p.audio.removeAttribute('src'); }
  players.clear();
  np.hidden = true;
}

// browsers block audio until the first click/keypress
const unblock = () => { blocked = false; };
addEventListener('pointerdown', unblock, true);
addEventListener('keydown', unblock, true);
setInterval(tick, 100);
syncSoundUI();

// ---------------------------------------------------------------- dialog

let infoCache = null;

export async function openMusicDialog({ targetId = null, at = null, url = '' } = {}) {
  const target = targetId ? getItem(targetId) : null;
  const cur = target?.music || {};
  const draft = {
    tracks: tracksOf(cur).map(t => ({ ...t })),
    radius: cur.radius ?? 900,
    volume: cur.volume ?? 0.8,
    shuffle: !!cur.shuffle,
  };
  const spot = at || viewCenter();
  let openTrim = -1;
  let closeTrim = null;
  let downloads = 0;
  infoCache ||= await api.info().catch(() => ({}));
  const info = infoCache;

  const m = modal({
    title: target ? '♪ music for this item' : '♪ new music spot',
    cls: 'music-dialog',
    docked: true,
    onClose: () => {
      closeTrim?.();
      S.musicPreview = null;
      requestRender();
    },
    body:
      '<p class="sub">loops while you\'re zoomed in near it. only the closest music plays.</p>' +
      (!info.ytdlp || !info.ffmpeg ? needTools(info) : '') +
      '<div class="plhead"><h4>playlist</h4><label class="tog"><input type="checkbox" name="shuffle"> shuffle</label></div>' +
      '<div class="playlist"></div>' +
      `<div class="row"><input class="input" name="url" placeholder="paste a YouTube link…" value="${esc(url)}">` +
      '<button class="btn txt" data-act="yt">add</button></div>' +
      '<div class="status"></div>' +
      '<div class="row wrap"><select class="input" name="existing"><option value="">add music already in this board…</option></select>' +
      '<button class="btn txt" data-act="upload"><span data-icon="upload"></span> upload</button></div>' +
      `<label class="field">hearing radius <span class="val" data-for="radius"></span>` +
      `<input type="range" name="radius" min="100" max="5000" step="50" value="${draft.radius}"></label>` +
      `<label class="field">volume <span class="val" data-for="volume"></span><input type="range" name="volume" min="0.05" max="1" step="0.05" value="${draft.volume}"></label>` +
      `<div class="actions">${tracksOf(cur).length ? '<button class="btn txt danger" data-act="remove">remove music</button>' : ''}` +
      '<span class="grow"></span><button class="btn txt" data-act="cancel">cancel</button><button class="btn txt primary" data-act="ok">done</button></div>',
  });
  hydrateIcons(m.el);
  const $ = s => m.$(s);
  $('[name=shuffle]').checked = draft.shuffle;

  // ---- live radius preview on the board
  const showRadius = () => {
    S.musicPreview = { id: target?.id || null, at: spot, radius: draft.radius };
    requestRender();
  };
  const previewBox = () => {
    const r = draft.radius;
    const c = target ? center(box(target)) : spot;
    return { x: c.x - r, y: c.y - r, w: 2 * r, h: 2 * r };
  };
  const vals = () => {
    $('[data-for=radius]').textContent = `${draft.radius}px`;
    $('[data-for=volume]').textContent = `${Math.round(draft.volume * 100)}%`;
  };
  $('[name=radius]').addEventListener('input', e => { draft.radius = +e.target.value; vals(); showRadius(); });
  $('[name=volume]').addEventListener('input', e => { draft.volume = +e.target.value; vals(); });
  $('[name=shuffle]').addEventListener('change', e => { draft.shuffle = e.target.checked; });
  vals();
  showRadius();
  // make sure the whole circle fits in the part of the screen the dialog doesn't cover
  requestAnimationFrame(() => {
    const vb = viewBox();
    const dw = (m.el.offsetWidth + 40) / S.cam.z;
    const free = { x: vb.x, y: vb.y, w: vb.w - dw, h: vb.h };
    const pb = previewBox();
    const fits = contains(free, pb) && contains(free, { x: pb.x + pb.w, y: pb.y + pb.h });
    if (fits || free.w <= 0) return;
    const cam = camFor(pb, { pad: 40, maxZ: S.cam.z });
    cam.x -= (m.el.offsetWidth + 40) / 2;
    flyCam(cam);
  });

  // ---- playlist
  const renderPlaylist = () => {
    closeTrim?.();
    closeTrim = null;
    const pl = $('.playlist');
    if (!draft.tracks.length) {
      pl.innerHTML = '<p class="empty">no songs yet — add some below</p>';
      return;
    }
    const n = draft.tracks.length;
    pl.innerHTML = draft.tracks.map((t, i) =>
      `<div class="track${openTrim === i ? ' open' : ''}" data-i="${i}"><div class="trow">` +
      `<span class="num">${i + 1}</span><span class="tt" title="${esc(t.title)}">${esc(t.title)}</span>` +
      `<span class="trange">${trimLabel(t)}</span>` +
      `<button class="btn icon mini${t.start || t.end || openTrim === i ? ' on' : ''}" data-tact="trim" title="trim the start / end">${icon('scissors')}</button>` +
      `<button class="btn icon mini" data-tact="up" title="move up"${i === 0 ? ' disabled' : ''}>${icon('up')}</button>` +
      `<button class="btn icon mini" data-tact="down" title="move down"${i === n - 1 ? ' disabled' : ''}>${icon('down')}</button>` +
      `<button class="btn icon mini" data-tact="del" title="remove from playlist">${icon('close')}</button>` +
      `</div>${openTrim === i ? '<div class="trimhost"></div>' : ''}</div>`).join('');
    if (openTrim >= 0 && draft.tracks[openTrim]) {
      const t = draft.tracks[openTrim];
      const row = pl.querySelector(`.track[data-i="${openTrim}"]`);
      closeTrim = trimEditor(row.querySelector('.trimhost'), t, ({ start, end }) => {
        if (start) t.start = start; else delete t.start;
        if (end) t.end = end; else delete t.end;
        row.querySelector('.trange').textContent = trimLabel(t);
      });
    }
  };
  renderPlaylist();

  $('.playlist').addEventListener('click', e => {
    const b = e.target.closest('[data-tact]');
    if (!b) return;
    const i = +b.closest('.track').dataset.i;
    const tr = draft.tracks;
    const act = b.dataset.tact;
    if (act === 'trim') openTrim = openTrim === i ? -1 : i;
    if (act === 'del') { tr.splice(i, 1); openTrim = -1; }
    if (act === 'up' && i > 0) { [tr[i - 1], tr[i]] = [tr[i], tr[i - 1]]; openTrim = openTrim === i ? i - 1 : openTrim === i - 1 ? i : openTrim; }
    if (act === 'down' && i < tr.length - 1) { [tr[i + 1], tr[i]] = [tr[i], tr[i + 1]]; openTrim = openTrim === i ? i + 1 : openTrim === i + 1 ? i : openTrim; }
    renderPlaylist();
  });

  const addTrack = t => {
    if (m.closed) return appendLive(t);
    draft.tracks.push(t);
    renderPlaylist();
  };

  // songs that finish downloading after the dialog was closed still get added
  const appendLive = t => {
    const live = target && getItem(target.id);
    if (live) {
      mutate(() => {
        live.music ||= { radius: draft.radius, volume: draft.volume, tracks: [] };
        normalizeMusic([live]);
        live.music.tracks.push(t);
      });
    } else if (!target) {
      const it = mutate(() => addItem({
        id: uid(), type: 'music', x: Math.round(spot.x - 36), y: Math.round(spot.y - 36),
        music: { tracks: [t], radius: draft.radius, volume: draft.volume }, tags: [],
      }));
      select([it.id]);
    }
    toast(`♪ added “${t.title}”`);
  };

  const status = () => {
    $('.status').innerHTML = downloads ? `<span class="spin"></span> downloading ${downloads > 1 ? `${downloads} songs` : 'audio'}… (keeps going if you close this)` : '';
  };

  $('[data-act=yt]').onclick = async () => {
    const input = $('[name=url]');
    const u = input.value.trim();
    if (!u) return input.focus();
    input.value = '';
    downloads++;
    status();
    try {
      const res = await api.youtube(S.name, { url: u, mode: 'audio' });
      addTrack({ src: res.src, title: res.title });
    } catch (e) {
      if (m.closed) toast(e.message, 'error');
      else $('.status').innerHTML = `<span class="err">${esc(e.message)}</span>`;
      downloads--;
      return;
    }
    downloads--;
    if (!m.closed) status();
  };
  $('[name=url]').addEventListener('keydown', e => { if (e.key === 'Enter') $('[data-act=yt]').click(); });
  if (url) requestAnimationFrame(() => $('[data-act=yt]').click());

  api.files(S.name, 'music').then(({ files }) => {
    const sel = $('[name=existing]');
    for (const f of files) sel.insertAdjacentHTML('beforeend', `<option value="${esc(f.src)}">${esc(f.name)}</option>`);
    if (!files.length) sel.hidden = true;
  }).catch(() => {});
  $('[name=existing]').onchange = e => {
    const o = e.target.selectedOptions[0];
    if (o.value) addTrack({ src: o.value, title: o.textContent });
    e.target.value = '';
  };

  $('[data-act=upload]').onclick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*';
    input.multiple = true;
    input.onchange = async () => {
      for (const f of input.files) {
        $('.status').innerHTML = `<span class="spin"></span> saving ${esc(f.name)}…`;
        try {
          const res = await api.upload(S.name, f, f.name);
          addTrack({ src: res.src, title: f.name.replace(/\.[^.]+$/, '') });
        } catch (e) {
          $('.status').innerHTML = `<span class="err">${esc(e.message)}</span>`;
          return;
        }
      }
      $('.status').innerHTML = '';
    };
    input.click();
  };

  const apply = () => {
    const music = { tracks: draft.tracks, radius: draft.radius, volume: draft.volume };
    if (draft.shuffle) music.shuffle = true;
    const live = target && getItem(target.id);
    if (live) {
      if (!draft.tracks.length) {
        if (live.music) mutate(() => (live.type === 'music' ? removeItems([live.id]) : delete live.music));
      } else mutate(() => (live.music = music));
    } else if (!target && draft.tracks.length) {
      const it = mutate(() => addItem({ id: uid(), type: 'music', x: Math.round(spot.x - 36), y: Math.round(spot.y - 36), music, tags: [] }));
      select([it.id]);
    }
  };

  $('[data-act=cancel]').onclick = () => m.close();
  $('[data-act=ok]').onclick = () => { apply(); m.close(); };
  m.$('[data-act=remove]')?.addEventListener('click', () => {
    const live = getItem(target.id);
    if (live) mutate(() => (live.type === 'music' ? removeItems([live.id]) : delete live.music));
    m.close();
  });
}
