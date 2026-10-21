// Music downloads that keep going in the background. The server does the work
// (so closing the music window, leaving the board or closing the app doesn't
// stop it); this module shows progress and adds finished songs to the board.
import { S, emit, getItem, mutate, select, saveNow, removeItems } from './state.js';
import { api } from './api.js';
import { toast } from './ui.js';
import { normalizeMusic, prefetchGain, openMusicDialog } from './music.js';
import { requestRender } from './render.js';
import { flyTo } from './canvas.js';
import { box } from './geom.js';
import { esc } from './markdown.js';

const ACTIVE = new Set(['queued', 'listing', 'downloading']);
const pill = document.getElementById('jobs-pill');
let jobs = [];        // downloads for the open board
let timer = null;
let polling = false;
const shown = new Set(); // finished jobs we've already told you about

export const isActive = j => ACTIVE.has(j.state);
export const jobsFor = id => jobs.filter(j => j.target === id);
export const activeJobFor = id => jobs.find(j => j.target === id && isActive(j));

/** Short progress text, e.g. "Road Trip Mix · 3 of 12". */
export function progressText(j) {
  const total = j.entries?.length || 0;
  if (j.state === 'queued') return 'waiting to start…';
  if (j.state === 'listing') return 'reading the playlist…';
  if (j.kind === 'playlist') return `${j.title ? `“${j.title}” · ` : ''}song ${Math.min(j.next + 1, total)} of ${total}${j.current ? `: ${j.current}` : ''}`;
  return 'downloading audio…';
}

export function summaryText(j) {
  const n = j.tracks.length;
  const from = j.title ? ` from “${j.title}”` : '';
  if (j.state === 'error') return `couldn't download${from}: ${j.error || 'something went wrong'}`;
  return `${j.state === 'stopped' ? 'stopped · ' : ''}added ${n} song${n === 1 ? '' : 's'}${from}` +
    (j.failed ? ` · ${j.failed} couldn't be downloaded` : '') + (j.truncated ? ` · only the first ${j.entries.length} were taken` : '');
}

export async function startJob({ url, kind, targetId, radius, volume }) {
  const job = await api.startMusicJob(S.name, { url, kind, target: targetId, music: { radius, volume } });
  jobs.push(job);
  changed();
  schedule(400);
  return job;
}

export async function stopJob(id) {
  await api.updateMusicJob(S.name, id, { stop: true }).catch(() => {});
  schedule(100);
}

/** Called when a board opens (or closes): forget the old board's jobs, look for this one's. */
export function resetJobs() {
  clearTimeout(timer);
  timer = null;
  jobs = [];
  changed();
  if (S.name) schedule(50);
}

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(poll, ms);
}

async function poll() {
  timer = null;
  if (!S.name || polling) return;
  polling = true;
  const name = S.name;
  try {
    const list = (await api.musicJobs(name)).jobs;
    if (S.name !== name) return; // switched boards meanwhile
    jobs = list;
    for (const j of list) await take(j, name);
    changed();
  } catch {
    /* server busy or restarting: try again soon */
  } finally {
    polling = false;
    if (S.name && jobs.some(isActive)) schedule(1500);
  }
}

/** Put a job's newly downloaded songs into its item's playlist. */
async function take(j, name) {
  const fresh = j.tracks.slice(j.applied || 0);
  const it = j.target && getItem(j.target);
  if (fresh.length) {
    if (!it) {
      // the thing these songs were for was deleted: stop and forget the download
      await api.deleteMusicJob(name, j.id).catch(() => {});
      j.state = 'gone';
      return;
    }
    mutate(() => {
      it.music ||= { tracks: [], radius: j.music?.radius ?? 900, volume: j.music?.volume ?? 0.8 };
      normalizeMusic([it]);
      const have = new Set(it.music.tracks.map(t => t.src));
      for (const t of fresh) if (!have.has(t.src)) it.music.tracks.push({ ...t });
    });
    fresh.forEach(t => prefetchGain(t.src));
    emit('job-tracks', { itemId: it.id, tracks: fresh });
    await saveNow(); // on disk before telling the server they're in
    await api.updateMusicJob(name, j.id, { applied: j.tracks.length }).catch(() => {});
    j.applied = j.tracks.length;
  }
  if (!isActive(j) && !shown.has(j.id)) {
    shown.add(j.id);
    toast(`♪ ${summaryText(j)}`, j.state === 'error' ? 'error' : '');
    // an empty music spot made just for a download that got nothing: tidy it away
    if (!j.tracks.length && it?.type === 'music' && !it.music?.tracks?.length) mutate(() => removeItems([it.id]));
    // keep the finished line visible for a bit, then clear it
    setTimeout(() => {
      api.deleteMusicJob(name, j.id).catch(() => {});
      jobs = jobs.filter(x => x.id !== j.id);
      changed();
    }, 10000);
  }
}

function changed() {
  emit('jobs');
  requestRender();
  drawPill();
}

// ---------------------------------------------------------------- the pill at the top

function drawPill() {
  const running = jobs.filter(isActive);
  pill.hidden = !running.length;
  if (!running.length) return;
  const label = running.length === 1 ? progressText(running[0]) : `${running.length} music downloads running…`;
  pill.innerHTML = `<span class="spin"></span><span class="pl">${esc(label)}</span>`;
  pill.title = 'downloading in the background — click to see it';
}

pill.addEventListener('click', () => {
  const j = jobs.find(isActive);
  const it = j && getItem(j.target);
  if (!it) return;
  select([it.id]);
  flyTo(box(it), { maxZ: 1, pad: 200 });
  openMusicDialog({ targetId: it.id });
});

