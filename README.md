# doodleboard ✶

An infinite, doodle-style brainstorming canvas that keeps everything in plain folders on your computer.

- Pan and zoom forever on a quiet dot grid.
- Paste screenshots and images straight from the clipboard. They're saved into the board's own folder.
- Drop in video files, or grab a clip from YouTube, and trim it to a looping snippet.
- Make text boxes, headings and sticky notes fast, with a handful of single-key shortcuts.
- **#tags**: type `#` and existing tags are suggested (Tab accepts, keep typing to ignore). Things that share a tag get tied together by faint threads. Hover a tag to light them up, or click it to focus.
- **Center pieces**: mark the main things on a board (P) and give them titles. ← / → hop between them left to right and loop around. A bar at the top shows the one you're on and what's to its left and right.
- **Arrows** between things.
- **Spatial music**: give any item a playlist from YouTube links (single songs or whole YouTube playlists), or from your own audio files. Downloads run in the background: close the music window, switch boards or even close the app, and they keep going. A badge on the item and a pill at the top show progress. YouTube songs are saved as mp3s named after the video. A playlist loops while you're zoomed in nearby, and moving to another music spot crossfades. You can trim each song's start and end on a waveform. Songs are normalized, so they all play at about the same loudness (the files themselves aren't changed). The speaker button has a global volume slider and the normalization switch.
- Themes: cream with hot pink, blue or red (shift+T).

## Start it

You need **Python 3.9+**. Nothing else is required for the basic app.

| | |
|---|---|
| Windows | double-click **`start.bat`** |
| Mac / Linux | `./start.sh` |
| anything | `python server.py` |

It opens in its own window if Edge or Chrome is installed (`--app` mode), otherwise in your browser at `http://localhost:7777`. Leave the console window open while you work, and close it to stop.

### Open it from the Start menu (Windows)

Double-click **`install-shortcut.bat`** once. It adds a **Boards** shortcut to your Start menu (and, if you want, your desktop), so you can press the Windows key, type `boards`, and press Enter.

Opened this way, it runs quietly in the background with no console window. Opening it again while it's running just opens another window. It stops by itself a couple of minutes after you close the last window, and its messages go to `doodleboard.log`. To remove the shortcuts, run `install-shortcut.bat remove`.

If you move the doodleboard folder, run `install-shortcut.bat` again so the shortcut points to the new place.

### For YouTube → mp3 / clips (optional)

```
pip install yt-dlp
winget install ffmpeg        # or: brew install ffmpeg / apt install ffmpeg
```

Then restart. Or drop `yt-dlp.exe` and `ffmpeg.exe` into the `tools/` folder instead.

## Updating

If you got doodleboard with git, double-click **`update.bat`** (or run `git pull` in the folder), then restart it. Updates never touch your boards, because the `boards/` folder isn't part of the repo.

To switch from a zip download to git (one time only):

1. Install Git: `winget install Git.Git` (or download it from https://git-scm.com). Then open a new terminal.
2. In the folder where you want the app, run:
   ```
   git clone https://github.com/JoeyGrimsic/boards.git doodleboard
   ```
   If the repo is private, Git asks you to sign in to GitHub the first time.
3. Move your old `boards` folder into the new `doodleboard` folder. Or leave it where it is and point the app at it with **"use a different folder…"** on the home screen.
4. From then on, use `update.bat` whenever you want the latest version.

## Where your stuff lives

```
boards/
  my board/
    board.json        everything on the canvas (human-readable JSON)
    board.json.bak    rolling backup, refreshed every ~5 minutes
    .loudness.json    measured song loudness, so each song is only measured once
    .music-jobs.json  music downloads in progress (resumed if the app restarts)
    assets/
      images/         pasted & dropped images
      video/          video files and YouTube clips
      music/          mp3s, e.g. "Some Song (Official Video).mp3"
```

A board is just a folder, so you can copy it, zip it, sync it with Dropbox or OneDrive, or put it in git. Deleted boards go to `boards/.trash/`. To keep boards somewhere else, use **"use a different folder…"** on the home screen, or run `python server.py --boards "D:\Brainstorms"`. The choice is remembered.

## Shortcuts

Press **`?`** in the app for the full list. The essentials:

| make | | organize | | move |
|---|---|---|---|---|
| double-click | text here | `#` | tag selection | drag empty space · pan |
| `T` | text | `P` | center piece | wheel · zoom |
| `H` | heading | `A` / alt+drag | arrow | `0` · fit all / selection |
| `N` | sticky note | `G` | map of center pieces & tags | `1` · 100% |
| `M` | music / playlist | `L` | tag threads on/off | `←` `→` · previous / next center piece |
| `I` | image / video file | `alt+F` | next font | shift+drag · box select |
| `V` | YouTube clip | `[` `]` | smaller / bigger | space+drag · pan anywhere |
| ctrl+V | paste anything | type | write in the selected note | `/` · search |
| | | | | ctrl+arrows · nudge selection |

While typing: `Esc` finishes, `Tab` accepts a tag suggestion (otherwise `Tab` / `shift+Tab`, or `ctrl+]` / `ctrl+[`, indent and outdent the paragraph, like Google Docs), `ctrl+B` / `ctrl+I` for bold / italic, alt+F changes font, `ctrl+shift+>` / `<` resizes. Lines starting with `- `, `[ ] ` or `# ` become bullets, checkboxes and headings. Indented bullets change shape by level (● ○ ■). Drag a text box's corner to change its width, or shift+drag the corner to scale the font.

## Lots of GIFs

Add as many GIFs as you like. Only the ones on screen and big enough to see actually animate, up to 16 at once with the biggest first. The rest show a still frame until you get close, so the board stays smooth however many it holds.

## Web app or desktop app?

It's a **local web app**: a tiny Python server (`server.py`, standard library only) plus a plain HTML/JS front end (`app/`, no build step).

- The server is what lets the browser write real files on disk, which is how pasted images land in the board folder. It also runs yt-dlp and ffmpeg. It only listens on `localhost`, so nothing is reachable from your network.
- The `--app` window makes it feel like a desktop program. To make it a "real" `.exe` later, the same `app/` folder can be wrapped with Tauri, Electron or pywebview without rewriting anything.
- To host it as a website someday, the server's job (storing boards and files) would move to a real backend with accounts and storage. The front end would mostly stay the same, because it only talks to the small API in `app/js/api.js`.

## Project layout

```
server.py            local server: boards API, uploads, YouTube downloads, static files
app/index.html       the shell
app/style.css        doodle styling + the three themes
app/js/
  main.js            routing between home and a board
  state.js           board state, undo/redo, autosave
  canvas.js          camera: pan, zoom, fly-to, grid
  render.js          items -> DOM / SVG
  interact.js        mouse, keyboard, clipboard, drag & drop
  text.js  ac.js     text editing + #tag autocomplete
  tags.js            tag parsing, colors, thread layout
  music.js           spatial music, playlists, volume, music dialog
  trim.js            waveform trim editor
  centers.js         center pieces + arrow-key navigation
  media.js           paste / drop / upload / YouTube clips
  chrome.js          toolbars, selection bar, search, map, context menu, help
  home.js            board picker
```
