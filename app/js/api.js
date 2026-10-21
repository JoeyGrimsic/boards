// Thin wrapper around the local server.

async function call(method, url, body, headers = {}) {
  const opts = { method, headers: { ...headers } };
  if (body instanceof Blob) opts.body = body;
  else if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers['Content-Type'] = 'application/json';
  }
  let r;
  try {
    r = await fetch(url, opts);
  } catch {
    throw new Error("can't reach the doodleboard server — is it still running?");
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `${r.status} ${r.statusText}`);
  return data;
}

const b = name => `/api/boards/${encodeURIComponent(name)}`;

export const api = {
  info: () => call('GET', '/api/info'),
  setBoardsDir: dir => call('POST', '/api/config', { boardsDir: dir }),
  listBoards: () => call('GET', '/api/boards'),
  createBoard: (name, board) => call('POST', '/api/boards', { name, board }),
  loadBoard: name => call('GET', b(name)),
  saveBoard: (name, data) => call('PUT', b(name), data),
  deleteBoard: name => call('DELETE', b(name)),
  renameBoard: (name, newName) => call('POST', `${b(name)}/rename`, { name: newName }),
  upload: (name, blob, filename = '') =>
    call('POST', `${b(name)}/assets`, blob, {
      'X-Filename': encodeURIComponent(filename || blob.name || ''),
      'Content-Type': blob.type || 'application/octet-stream',
    }),
  fetchUrl: (name, url) => call('POST', `${b(name)}/fetch`, { url }),
  importAsset: (name, fromBoard, src) => call('POST', `${b(name)}/import`, { fromBoard, src }),
  youtube: (name, opts) => call('POST', `${b(name)}/youtube`, opts),
  youtubeList: url => call('POST', '/api/youtube-list', { url }),
  loudness: (name, src) => call('POST', `${b(name)}/loudness`, { src }),
  files: (name, dir) => call('GET', `${b(name)}/files?dir=${encodeURIComponent(dir)}`),
  beaconSave: (name, data) => {
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    return blob.size < 60000 && navigator.sendBeacon(`${b(name)}/save`, blob);
  },
};

export const assetUrl = (board, src) =>
  /^(blob:|data:|https?:)/.test(src)
    ? src
    : `/boards/${encodeURIComponent(board)}/${src.split('/').map(encodeURIComponent).join('/')}`;
