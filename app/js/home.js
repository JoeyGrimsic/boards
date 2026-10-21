// The board picker.
import { api, assetUrl } from './api.js';
import { icon, hydrateIcons, scribble, rng } from './doodle.js';
import { esc } from './markdown.js';
import { toast, promptText, confirmBox, cycleTheme } from './ui.js';
import { welcomeBoard } from './welcome.js';
import { isAnimated } from './anim.js';

const home = document.getElementById('home');

function ago(t) {
  const s = Date.now() / 1000 - t;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} days ago`;
  return new Date(t * 1000).toLocaleDateString();
}

function card(b) {
  const r = rng(b.name);
  const tilt = ((r() - 0.5) * 2.4).toFixed(2);
  const previews = b.previews.map((src, i) =>
    `<img src="${assetUrl(b.name, src)}" style="--r:${((r() - 0.5) * 14).toFixed(1)}deg;--i:${i}" loading="lazy" alt="">`).join('');
  const snippets = !b.previews.length && b.snippets?.length
    ? `<div class="snips">${b.snippets.map(s => `<p>${esc(s.replace(/\*\*|__|~~|`|^#{1,3} /g, ''))}</p>`).join('')}</div>` : '';
  return `<div class="card sketch" style="--tilt:${tilt}deg" data-name="${esc(b.name)}">
    <a href="#/b/${encodeURIComponent(b.name)}" class="cover">${previews || snippets || `<span class="emptyc">${icon('sparkle')}</span>`}</a>
    <div class="meta"><a href="#/b/${encodeURIComponent(b.name)}" class="nm">${esc(b.name)}</a>
      <small>${b.items} thing${b.items === 1 ? '' : 's'} · ${ago(b.modified)}</small></div>
    <div class="acts"><button class="btn icon mini" data-act="rename" title="rename">${icon('pencil')}</button>
      <button class="btn icon mini" data-act="delete" title="move to trash">${icon('trash')}</button></div>
  </div>`;
}

export async function showHome() {
  document.getElementById('board').hidden = true;
  home.hidden = false;
  document.title = 'doodleboard';
  let data;
  try {
    data = await api.listBoards();
  } catch (e) {
    home.innerHTML = `<div class="home-wrap"><h1>doodleboard</h1><p class="err">${esc(e.message)}</p></div>`;
    return;
  }
  let welcomed = false;
  try { welcomed = localStorage.getItem('doodle-welcomed') === '1'; } catch { /* ignore */ }
  if (!data.boards.length && !welcomed) {
    try { localStorage.setItem('doodle-welcomed', '1'); } catch { /* ignore */ }
    const res = await api.createBoard('my first board', welcomeBoard());
    location.hash = `#/b/${encodeURIComponent(res.name)}`;
    return;
  }
  home.innerHTML = `<div class="home-wrap">
    <header class="home-head">
      <div><h1>doodleboard ${icon('sparkle', 'spark')}</h1>${scribble(330, 7)}<p class="sub">pick a board, or start a fresh one</p></div>
      <div class="bar"><button class="btn icon" data-act="theme" title="theme" data-icon="theme"></button></div>
    </header>
    <div class="cards">
      <button class="card sketch new" data-act="new" style="--tilt:-1deg">${icon('plus')}<span>new board</span></button>
      ${data.boards.map(card).join('')}
    </div>
    <footer class="home-foot">${icon('folder')} boards live in <code>${esc(data.boardsDir)}</code>
      <button class="link" data-act="folder">use a different folder…</button></footer>
  </div>`;
  hydrateIcons(home);
  // GIF previews on the board cards: show a still frame instead of animating
  home.querySelectorAll('.cover img').forEach(img => {
    if (!isAnimated(img.src)) return;
    img.addEventListener('load', () => {
      const cv = document.createElement('canvas');
      const s = Math.min(1, 360 / Math.max(img.naturalWidth, img.naturalHeight));
      cv.width = Math.max(1, Math.round(img.naturalWidth * s));
      cv.height = Math.max(1, Math.round(img.naturalHeight * s));
      try {
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        img.src = cv.toDataURL('image/webp', 0.9);
      } catch { /* keep it as is */ }
    }, { once: true });
  });
}

home.addEventListener('click', async e => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  const name = e.target.closest('.card')?.dataset.name;
  if (act === 'theme') cycleTheme();
  if (act === 'new') {
    const n = await promptText('new board', '', 'what are we brainstorming?', 'create');
    if (!n) return;
    try {
      const res = await api.createBoard(n);
      location.hash = `#/b/${encodeURIComponent(res.name)}`;
    } catch (err) { toast(err.message, 'error'); }
  }
  if (act === 'rename') {
    const n = await promptText('rename board', name, 'board name', 'rename');
    if (!n || n === name) return;
    try { await api.renameBoard(name, n); showHome(); } catch (err) { toast(err.message, 'error'); }
  }
  if (act === 'delete') {
    if (!(await confirmBox('move to trash?', `“${esc(name)}” goes into the <code>.trash</code> folder inside your boards folder, so you can still dig it out later.`, 'trash it'))) return;
    try { await api.deleteBoard(name); showHome(); } catch (err) { toast(err.message, 'error'); }
  }
  if (act === 'folder') {
    const info = await api.info().catch(() => ({}));
    const dir = await promptText('boards folder', info.boardsDir || '', 'C:\\Users\\you\\Documents\\boards', 'use this folder');
    if (!dir) return;
    try { await api.setBoardsDir(dir); showHome(); toast('switched folders'); } catch (err) { toast(err.message, 'error'); }
  }
});
