// Waveform window for trimming a song: drag the edges to cut the start / end,
// drag the middle to slide the window, press play to hear just the kept part.
import { S } from './state.js';
import { assetUrl } from './api.js';
import { icon } from './doodle.js';
import { clamp } from './geom.js';
import { getMaster, setPreviewing } from './music.js';

const MIN_LEN = 1; // seconds
const peaksCache = new Map(); // url -> { peaks, duration }

export const fmtShort = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const fmtLong = s => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
const round1 = s => Math.round(s * 10) / 10;

/** "0:12–2:45" for a trimmed track, '' for a whole one. */
export function trimLabel(t) {
  if (!t.start && !t.end) return '';
  return `${fmtShort(t.start || 0)}–${t.end ? fmtShort(t.end) : 'end'}`;
}

async function loadPeaks(url) {
  if (peaksCache.has(url)) return peaksCache.get(url);
  const buf = await (await fetch(url)).arrayBuffer();
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const audio = await ac.decodeAudioData(buf);
    const data = audio.getChannelData(0);
    const n = 1200;
    const block = Math.max(1, Math.floor(data.length / n));
    const stride = Math.max(1, Math.floor(block / 64)); // sampling is plenty for a picture
    const peaks = new Float32Array(n);
    let top = 0;
    for (let i = 0; i < n; i++) {
      let mx = 0;
      for (let j = i * block, e = j + block; j < e; j += stride) {
        const v = Math.abs(data[j] || 0);
        if (v > mx) mx = v;
      }
      peaks[i] = mx;
      if (mx > top) top = mx;
    }
    if (top > 0) for (let i = 0; i < n; i++) peaks[i] /= top;
    const res = { peaks, duration: audio.duration };
    peaksCache.set(url, res);
    return res;
  } finally {
    ac.close();
  }
}

/**
 * Mount the editor in `host` for `track` ({src, start, end}).
 * onChange({start, end}) fires while dragging. Returns a cleanup function.
 */
export function trimEditor(host, track, onChange) {
  host.innerHTML =
    '<div class="trim"><canvas></canvas><div class="trim-row">' +
    `<button class="btn icon mini" data-t="play" title="play the kept part">${icon('play')}</button>` +
    '<span class="tlabel">reading the song…</span><span class="grow"></span>' +
    '<button class="btn txt mini" data-t="reset">keep whole song</button></div>' +
    '<p class="hint">drag the edges to cut the start or end · drag the middle to slide the window</p></div>';
  const cv = host.querySelector('canvas');
  const ctx = cv.getContext('2d');
  const label = host.querySelector('.tlabel');
  const playBtn = host.querySelector('[data-t=play]');
  const url = assetUrl(S.name, track.src);
  const preview = new Audio(url);
  const dpr = window.devicePixelRatio || 1;
  let data = null;
  let start = track.start || 0;
  let end = track.end || null;
  let drag = null;
  let raf = 0;
  let alive = true;

  const dur = () => data.duration;
  const endT = () => end ?? dur();

  function draw() {
    if (!data) return;
    const W = (cv.width = Math.round(cv.clientWidth * dpr));
    const H = (cv.height = Math.round(72 * dpr));
    const css = getComputedStyle(document.documentElement);
    const ink = css.getPropertyValue('--ink').trim();
    const accent = css.getPropertyValue('--accent').trim();
    const muted = css.getPropertyValue('--muted').trim();
    const sx = (start / dur()) * W, ex = (endT() / dur()) * W;
    ctx.clearRect(0, 0, W, H);
    // waveform: kept part in accent, cut parts faded
    const step = 3 * dpr;
    for (let x = 0; x < W; x += step) {
      const p = data.peaks[Math.min(data.peaks.length - 1, Math.floor((x / W) * data.peaks.length))];
      const h = Math.max(1.5 * dpr, p * H * 0.78);
      const inside = x >= sx && x <= ex;
      ctx.globalAlpha = inside ? 1 : 0.35;
      ctx.fillStyle = inside ? accent : muted;
      ctx.fillRect(x, (H - h) / 2, 1.6 * dpr, h);
    }
    ctx.globalAlpha = 1;
    // the window
    ctx.strokeStyle = ink;
    ctx.lineWidth = 2 * dpr;
    ctx.strokeRect(sx, dpr, ex - sx, H - 2 * dpr);
    ctx.fillStyle = ink;
    for (const x of [sx, ex]) ctx.fillRect(x - 3 * dpr, H / 2 - 13 * dpr, 6 * dpr, 26 * dpr);
    // playhead
    if (!preview.paused) {
      const px = (preview.currentTime / dur()) * W;
      ctx.fillRect(px - dpr, 0, 2 * dpr, H);
    }
  }

  function update(emit = true) {
    if (!data) return;
    label.textContent = `${fmtLong(start)} → ${fmtLong(endT())}  ·  plays ${fmtShort(endT() - start)} of ${fmtShort(dur())}`;
    draw();
    if (emit) onChange({ start: start > 0.05 ? round1(start) : 0, end: end == null ? null : round1(end) });
  }

  function timeAt(e) {
    const r = cv.getBoundingClientRect();
    return clamp(((e.clientX - r.left) / r.width) * dur(), 0, dur());
  }

  cv.addEventListener('pointerdown', e => {
    if (!data) return;
    const r = cv.getBoundingClientRect();
    const px = e.clientX - r.left;
    const sx = (start / dur()) * r.width, ex = (endT() / dur()) * r.width;
    const t = timeAt(e);
    if (Math.abs(px - sx) < 10) drag = { k: 's' };
    else if (Math.abs(px - ex) < 10) drag = { k: 'e' };
    else if (px > sx && px < ex) drag = { k: 'm', off: t - start, len: endT() - start };
    else drag = { k: px < sx ? 's' : 'e' };
    cv.setPointerCapture(e.pointerId);
    move(e);
  });

  function move(e) {
    if (!drag) {
      if (data) {
        const r = cv.getBoundingClientRect();
        const px = e.clientX - r.left;
        const near = [start, endT()].some(t => Math.abs((t / dur()) * r.width - px) < 10);
        cv.style.cursor = near ? 'ew-resize' : 'grab';
      }
      return;
    }
    const t = timeAt(e);
    if (drag.k === 's') start = clamp(t, 0, endT() - MIN_LEN);
    else if (drag.k === 'e') end = clamp(t, start + MIN_LEN, dur());
    else {
      start = clamp(t - drag.off, 0, dur() - drag.len);
      end = start + drag.len;
    }
    if (end != null && end >= dur() - 0.05) end = null;
    update();
  }
  cv.addEventListener('pointermove', move);
  cv.addEventListener('pointerup', () => {
    drag = null;
    if (!preview.paused) preview.currentTime = start;
  });

  function stop() {
    preview.pause();
    cancelAnimationFrame(raf);
    setPreviewing(false);
    playBtn.innerHTML = icon('play');
    draw();
  }

  function frame() {
    if (preview.currentTime >= endT() - 0.03) { stop(); return; }
    draw();
    raf = requestAnimationFrame(frame);
  }

  playBtn.onclick = () => {
    if (!data) return;
    if (!preview.paused) return stop();
    preview.currentTime = start;
    preview.volume = getMaster();
    setPreviewing(true); // board music steps aside while you listen
    preview.play().then(() => {
      playBtn.innerHTML = icon('pause');
      frame();
    }).catch(() => stop());
  };

  host.querySelector('[data-t=reset]').onclick = () => {
    start = 0;
    end = null;
    update();
  };

  loadPeaks(url).then(res => {
    if (!alive) return;
    data = res;
    update(false);
  }).catch(() => {
    label.textContent = "couldn't read this song";
  });

  const ro = new ResizeObserver(draw);
  ro.observe(cv);

  return () => {
    alive = false;
    ro.disconnect();
    stop();
    preview.removeAttribute('src');
  };
}
