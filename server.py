#!/usr/bin/env python3
"""
doodleboard - a local server for an infinite brainstorming canvas.

Boards live on disk as plain folders:

    boards/
      My Board/
        board.json          <- everything on the canvas
        board.json.bak      <- rolling backup
        assets/
          images/           <- pasted / dropped images
          video/            <- video snippets
          music/            <- mp3s (YouTube downloads are named by video title)

Run:  python server.py            (opens your browser)
      python server.py --app      (opens a chromeless app window if Edge/Chrome is found)
      python server.py --boards "D:/somewhere/else"
"""

import argparse
import hashlib
import json
import math
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
APP_DIR = ROOT / "app"
TOOLS_DIR = ROOT / "tools"          # optional: drop yt-dlp(.exe) / ffmpeg(.exe) here
CONFIG_FILE = ROOT / "config.json"

# don't flash a console window for ffmpeg / yt-dlp when running without one (pythonw)
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
LAST_SEEN = [time.time()]  # last request from an open app window (see --background)

MAX_UPLOAD = 2 * 1024 ** 3          # 2 GB
MAX_FETCH = 200 * 1024 ** 2         # 200 MB for images fetched from the web

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("image/avif", ".avif")
mimetypes.add_type("video/mp4", ".mp4")
mimetypes.add_type("video/webm", ".webm")
mimetypes.add_type("video/quicktime", ".mov")
mimetypes.add_type("audio/mpeg", ".mp3")
mimetypes.add_type("audio/mp4", ".m4a")
mimetypes.add_type("audio/ogg", ".ogg")
mimetypes.add_type("audio/opus", ".opus")
mimetypes.add_type("audio/wav", ".wav")

EXT_FOR_TYPE = {
    "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp",
    "image/svg+xml": ".svg", "image/avif": ".avif", "image/bmp": ".bmp",
    "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov", "video/ogg": ".ogv",
    "audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/mp4": ".m4a", "audio/ogg": ".ogg",
    "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/webm": ".weba", "audio/flac": ".flac",
}

WINDOWS_RESERVED = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}


# --------------------------------------------------------------------------- config

class Config:
    def __init__(self):
        self.boards_dir = ROOT / "boards"
        self.lock = threading.Lock()

    def load(self):
        try:
            data = json.loads(CONFIG_FILE.read_text("utf-8"))
            if data.get("boardsDir"):
                self.boards_dir = Path(data["boardsDir"]).expanduser()
        except (OSError, ValueError):
            pass

    def save(self):
        try:
            CONFIG_FILE.write_text(json.dumps({"boardsDir": str(self.boards_dir)}, indent=2), "utf-8")
        except OSError:
            pass


CONFIG = Config()


# --------------------------------------------------------------------------- helpers

def clean_name(name, fallback="untitled", max_len=80):
    """Make a string safe to use as a file / folder name on every OS."""
    name = str(name or "").strip()
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "-", name)
    name = re.sub(r"\s+", " ", name).strip(" .")
    if not name or name.lower() in WINDOWS_RESERVED:
        name = fallback
    return name[:max_len].strip(" .") or fallback


def within(base: Path, target: Path) -> bool:
    try:
        target.resolve().relative_to(base.resolve())
        return True
    except ValueError:
        return False


def board_path(name: str) -> Path:
    if (not name or name.startswith(".") or re.search(r'[<>:"/\\|?*\x00-\x1f]', name)):
        raise ApiError(400, "bad board name")
    p = CONFIG.boards_dir / name
    if not within(CONFIG.boards_dir, p):
        raise ApiError(400, "bad board name")
    return p


def atomic_write(path: Path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
        os.chmod(path, 0o644)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def kind_of(content_type: str, filename: str) -> str:
    ct = (content_type or mimetypes.guess_type(filename)[0] or "").lower()
    if ct.startswith("image/"):
        return "image"
    if ct.startswith("video/"):
        return "video"
    if ct.startswith("audio/"):
        return "audio"
    return "file"


SUBDIR = {"image": "images", "video": "video", "audio": "music", "file": "files"}


def store_stream(board: Path, stream, length, filename: str, content_type: str):
    """Write an incoming stream into the board's assets folder; dedupe by content hash."""
    kind = kind_of(content_type, filename)
    folder = board / "assets" / SUBDIR[kind]
    folder.mkdir(parents=True, exist_ok=True)

    stem, ext = os.path.splitext(filename or "")
    ext = ext.lower()
    if not ext or len(ext) > 6:
        ext = EXT_FOR_TYPE.get((content_type or "").split(";")[0].strip().lower(), ".bin")
    stem = clean_name(stem, fallback="")
    if not stem or stem.lower() in {"image", "blob", "clipboard", "untitled", "download"}:
        stem = "paste-" + time.strftime("%Y%m%d-%H%M%S")

    h = hashlib.sha1()
    fd, tmp = tempfile.mkstemp(dir=str(folder), prefix=".up-")
    total = 0
    try:
        with os.fdopen(fd, "wb") as f:
            remaining = length
            while remaining is None or remaining > 0:
                chunk = stream.read(min(1 << 20, remaining) if remaining is not None else 1 << 20)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_UPLOAD:
                    raise ApiError(413, "file too large")
                h.update(chunk)
                f.write(chunk)
                if remaining is not None:
                    remaining -= len(chunk)
        digest = h.hexdigest()[:8]
        # Same content already stored? reuse it.
        for existing in folder.glob(f"*-{digest}{ext}"):
            os.unlink(tmp)
            return existing, kind
        final = folder / f"{stem}-{digest}{ext}"
        os.replace(tmp, final)
        os.chmod(final, 0o644)
        return final, kind
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def rel(board: Path, p: Path) -> str:
    return p.resolve().relative_to(board.resolve()).as_posix()


def find_tool(name):
    """Look for a CLI tool in ./tools, on PATH, then where Windows installers put it."""
    for candidate in (TOOLS_DIR / name, TOOLS_DIR / f"{name}.exe"):
        if candidate.is_file():
            return str(candidate)
    found = shutil.which(name)
    if found or not sys.platform.startswith("win"):
        return found
    # Freshly installed tools aren't on PATH until you sign out and back in,
    # so also look in the usual install spots (winget, scoop, chocolatey).
    local = Path(os.environ.get("LOCALAPPDATA", ""))
    spots = [
        local / "Microsoft/WinGet/Links" / f"{name}.exe",
        Path.home() / "scoop/shims" / f"{name}.exe",
        Path(os.environ.get("ProgramData", "C:/ProgramData")) / "chocolatey/bin" / f"{name}.exe",
        Path("C:/ffmpeg/bin") / f"{name}.exe",
    ]
    for spot in spots:
        if spot.is_file():
            return str(spot)
    for hit in sorted((local / "Microsoft/WinGet/Packages").glob(f"*/**/{name}.exe"), reverse=True):
        return str(hit)
    return None


def ytdlp_cmd():
    try:
        import yt_dlp  # noqa: F401
        return [sys.executable, "-m", "yt_dlp"]
    except ImportError:
        exe = find_tool("yt-dlp")
        return [exe] if exe else None


def ffmpeg_path():
    return find_tool("ffmpeg")


def parse_time(t):
    """'1:23' / '83' / '1:02:03' -> seconds (float) or None."""
    if t is None or str(t).strip() == "":
        return None
    parts = str(t).strip().split(":")
    try:
        secs = 0.0
        for p in parts:
            secs = secs * 60 + float(p)
        return secs
    except ValueError:
        raise ApiError(400, f"can't read time '{t}'")


YT_LOCK = threading.Lock()
MAX_PLAYLIST = 200
GONE_TITLES = {"[private video]", "[deleted video]", "[unavailable video]"}


def youtube_list(url: str):
    """List the songs in a YouTube playlist (titles + links) without downloading."""
    cmd = ytdlp_cmd()
    if not cmd:
        raise ApiError(501, "yt-dlp is not installed. Run:  pip install yt-dlp   (or put yt-dlp.exe in the tools folder)")
    if not re.match(r"^https?://", url or ""):
        raise ApiError(400, "that doesn't look like a link")
    args = cmd + ["--flat-playlist", "--yes-playlist", "-J", "--no-warnings",
                  "--playlist-end", str(MAX_PLAYLIST), url]
    try:
        proc = subprocess.run(args, capture_output=True, text=True, timeout=180, creationflags=NO_WINDOW,
                              encoding="utf-8", errors="replace")
    except subprocess.TimeoutExpired:
        raise ApiError(504, "reading the playlist timed out")
    if proc.returncode != 0:
        err = (proc.stderr or "").strip().splitlines()
        raise ApiError(502, next((l for l in reversed(err) if "ERROR" in l), err[-1] if err else "couldn't read the playlist")[:400])
    try:
        data = json.loads(proc.stdout)
    except ValueError:
        raise ApiError(502, "couldn't understand yt-dlp's answer")
    entries = data.get("entries")
    if entries is None:  # a single video, not a playlist
        entries = [data]
    songs = []
    for e in entries:
        if not e or (e.get("title") or "").strip().lower() in GONE_TITLES:
            continue
        link = e.get("webpage_url") or e.get("url") or ""
        if not link.startswith("http") and e.get("id"):
            link = f"https://www.youtube.com/watch?v={e['id']}"
        if link.startswith("http"):
            songs.append({"url": link, "title": e.get("title") or ""})
    return {"title": data.get("title") or "playlist", "entries": songs, "truncated": len(entries) >= MAX_PLAYLIST}



def youtube_download(board: Path, url: str, mode: str, start=None, end=None):
    cmd = ytdlp_cmd()
    if not cmd:
        raise ApiError(501, "yt-dlp is not installed. Run:  pip install yt-dlp   (or put yt-dlp.exe in the tools folder)")
    ffmpeg = ffmpeg_path()
    if not ffmpeg:
        raise ApiError(501, "ffmpeg is not installed. Install it (winget install ffmpeg) or put ffmpeg.exe in the tools folder")
    if not re.match(r"^https?://", url or ""):
        raise ApiError(400, "that doesn't look like a link")

    sub = "music" if mode == "audio" else "video"
    folder = board / "assets" / sub
    folder.mkdir(parents=True, exist_ok=True)
    args = cmd + [
        "--no-playlist", "--no-progress", "--windows-filenames", "--no-overwrites",
        "--ffmpeg-location", ffmpeg,
        "--print", "after_move:filepath", "--print", "after_move:title",
    ]
    if mode == "audio":
        args += ["-x", "--audio-format", "mp3", "--audio-quality", "2",
                 "-o", str(folder / "%(title)s.%(ext)s")]
    else:
        s, e = parse_time(start), parse_time(end)
        tag = ""
        if s is not None or e is not None:
            s = s or 0
            sec = f"*{s}-{e if e is not None else 'inf'}"
            args += ["--download-sections", sec, "--force-keyframes-at-cuts"]
            tag = f" [{int(s)}-{int(e) if e is not None else 'end'}]"
        args += ["-f", "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/bv*[height<=720]+ba/b",
                 "--merge-output-format", "mp4",
                 "-o", str(folder / f"%(title)s{tag}.%(ext)s")]
    args.append(url)

    with YT_LOCK:
        existing = set(folder.iterdir())
        try:
            proc = subprocess.run(args, capture_output=True, text=True, timeout=900, creationflags=NO_WINDOW,
                                  encoding="utf-8", errors="replace")
        except subprocess.TimeoutExpired:
            proc = None
        lines = [l for l in proc.stdout.splitlines() if l.strip()] if proc else []
        if not proc or proc.returncode != 0 or len(lines) < 2:
            # don't leave half-finished downloads lying around
            for f in set(folder.iterdir()) - existing:
                try:
                    f.unlink()
                except OSError:
                    pass
    if not proc:
        raise ApiError(504, "download timed out")
    if proc.returncode != 0 or len(lines) < 2:
        err = (proc.stderr or proc.stdout or "").strip().splitlines()
        msg = next((l for l in reversed(err) if "ERROR" in l), err[-1] if err else "download failed")
        raise ApiError(502, msg[:400])
    path, title = Path(lines[-2]), lines[-1]
    if not path.is_file() or not within(board, path):
        raise ApiError(502, "download finished but the file wasn't found")
    return {"src": rel(board, path), "title": title, "kind": "audio" if mode == "audio" else "video"}


def sniff_type(head: bytes):
    """Guess a media type from a file's first bytes (for servers that don't say)."""
    if head.startswith(b"GIF8"):
        return "image/gif"
    if head.startswith(b"\x89PNG"):
        return "image/png"
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    if head[4:8] == b"ftyp":
        return "image/avif" if head[8:12] in (b"avif", b"avis") else "video/mp4"
    if head.startswith(b"\x1aE\xdf\xa3"):
        return "video/webm"
    return None


class _Prefixed:
    """A stream with some already-read bytes put back in front."""
    def __init__(self, head, rest):
        self.head, self.rest = head, rest

    def read(self, n=-1):
        if self.head:
            if n is None or n < 0:
                out, self.head = self.head, b""
            else:
                out, self.head = self.head[:n], self.head[n:]
            return out
        return self.rest.read(n)


def fetch_url_to_board(board: Path, url: str):
    if not re.match(r"^https?://", url or ""):
        raise ApiError(400, "only http(s) links can be fetched")
    parts = urllib.parse.urlparse(url)
    # look like a normal browser; some image hosts refuse anything else
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept": "image/gif,image/webp,image/apng,image/*,video/*,*/*;q=0.8",
        "Referer": f"{parts.scheme}://{parts.netloc}/",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            ctype = r.headers.get("Content-Type", "").split(";")[0].strip().lower()
            head = r.read(32)
            sniffed = sniff_type(head)
            if sniffed and (sniffed == "image/gif" or kind_of(ctype, "") not in ("image", "video", "audio")):
                ctype = sniffed  # trust the bytes over a vague / wrong header
            if kind_of(ctype, url) not in ("image", "video", "audio"):
                raise ApiError(415, f"that link isn't an image ({ctype or 'unknown type'})")
            length = r.headers.get("Content-Length")
            if length and int(length) > MAX_FETCH:
                raise ApiError(413, "file too large")
            name = os.path.basename(parts.path) or "download"
            stem, ext = os.path.splitext(name)
            want = EXT_FOR_TYPE.get(ctype)
            if want and ext.lower() != want and not (want == ".jpg" and ext.lower() == ".jpeg"):
                name = stem + want  # e.g. "image" or "photo.php" -> "photo.gif"
            path, kind = store_stream(board, _Prefixed(head, r), int(length) if length else None, name, ctype)
            return {"src": rel(board, path), "kind": kind, "name": path.name}
    except ApiError:
        raise
    except Exception as e:  # network errors etc.
        raise ApiError(502, f"couldn't download: {e}")


LOUD_TARGET = -14.0   # LUFS, roughly what YouTube / Spotify normalize to
LOUD_PEAK = -1.0      # dBTP: never boost a song so far that its peaks clip
LOUD_LOCK = threading.Lock()
LOUD_SLOTS = threading.Semaphore(2)  # measuring is CPU heavy; don't run too many at once


def measure_loudness(board: Path, src: str):
    """How loud a song is, and the gain (dB) that brings it to the target.

    Results are cached in <board>/.loudness.json so each file is only measured once.
    The audio file itself is never changed.
    """
    path = board / src
    if not within(board / "assets", path) or not path.is_file():
        raise ApiError(404, "song not found")
    st = path.stat()
    key = f"{st.st_size}:{int(st.st_mtime)}"
    cache_file = board / ".loudness.json"

    def read_cache():
        try:
            return json.loads(cache_file.read_text("utf-8"))
        except (OSError, ValueError):
            return {}

    with LOUD_LOCK:
        hit = read_cache().get(src)
    if hit and hit.get("key") == key:
        return hit
    ffmpeg = ffmpeg_path()
    if not ffmpeg:
        return {"gain": 0, "unavailable": True}
    with LOUD_SLOTS:
        try:
            proc = subprocess.run(
                [ffmpeg, "-hide_banner", "-nostats", "-i", str(path), "-vn",
                 "-af", f"loudnorm=I={LOUD_TARGET}:TP={LOUD_PEAK}:LRA=11:print_format=json", "-f", "null", "-"],
                capture_output=True, text=True, timeout=300, encoding="utf-8", errors="replace",
                creationflags=NO_WINDOW)
        except subprocess.TimeoutExpired:
            raise ApiError(504, "measuring the song timed out")
    out = proc.stderr or ""
    try:
        data = json.loads(out[out.rindex("{"):out.rindex("}") + 1])
        lufs, peak = float(data["input_i"]), float(data["input_tp"])
    except (ValueError, KeyError):
        raise ApiError(502, "couldn't measure that song")
    if not math.isfinite(lufs) or lufs < -70:
        gain = 0.0  # silence: leave it alone
    else:
        gain = LOUD_TARGET - lufs
        if gain > 0 and math.isfinite(peak):
            gain = min(gain, max(0.0, LOUD_PEAK - peak))
        gain = max(-20.0, min(12.0, gain))
    res = {"key": key, "lufs": round(lufs, 1) if math.isfinite(lufs) else None,
           "peak": round(peak, 1) if math.isfinite(peak) else None, "gain": round(gain, 2)}
    with LOUD_LOCK:
        cache = read_cache()
        cache[src] = res
        atomic_write(cache_file, json.dumps(cache, indent=1).encode("utf-8"))
    return res


# --------------------------------------------------------------------------- background music jobs
# Downloads run here, not in the browser, so they keep going when the music window,
# the board or even the app window is closed. Progress is saved in
# <board>/.music-jobs.json; the open board polls it and adds finished songs.

JOBS_LOCK = threading.RLock()
JOBS = {}       # job id -> job dict
WORKERS = {}    # job id -> running thread
ACTIVE_STATES = {"queued", "listing", "downloading"}


def _jobs_file(board: Path):
    return board / ".music-jobs.json"


def _save_jobs(board: Path):
    with JOBS_LOCK:
        mine = [j for j in JOBS.values() if j["board"] == board.name]
        try:
            atomic_write(_jobs_file(board), json.dumps(mine, indent=1).encode("utf-8"))
        except OSError:
            pass


def _load_jobs(board: Path):
    """Pick up jobs saved in a board folder (e.g. after a restart) and resume unfinished ones."""
    with JOBS_LOCK:
        try:
            saved = json.loads(_jobs_file(board).read_text("utf-8"))
        except (OSError, ValueError):
            saved = []
        for j in saved:
            if j.get("id") and j["id"] not in JOBS:
                j["board"] = board.name
                JOBS[j["id"]] = j
        for j in JOBS.values():
            if j["board"] == board.name and j["state"] in ACTIVE_STATES and j["id"] not in WORKERS:
                _start_worker(board, j["id"])


def _start_worker(board: Path, jid):
    t = threading.Thread(target=_run_job, args=(board, jid), daemon=True)
    WORKERS[jid] = t
    t.start()


def _run_job(board: Path, jid):
    job = JOBS[jid]
    try:
        if job["entries"] is None:
            if job["kind"] == "playlist":
                job["state"] = "listing"
                _save_jobs(board)
                lst = youtube_list(job["url"])
                job.update(title=lst["title"], entries=lst["entries"], truncated=lst["truncated"])
                if not lst["entries"]:
                    raise ApiError(404, "that playlist looks empty (or it's private)")
            else:
                job["entries"] = [{"url": job["url"], "title": ""}]
        job["state"] = "downloading"
        _save_jobs(board)
        while job["next"] < len(job["entries"]) and not job.get("stop"):
            entry = job["entries"][job["next"]]
            job["current"] = entry.get("title") or ""
            _save_jobs(board)
            try:
                res = youtube_download(board, entry["url"], "audio")
                job["tracks"].append({"src": res["src"], "title": res["title"]})
            except ApiError as e:
                job["failed"] += 1
                job["lastError"] = e.message
            job["next"] += 1
        if job.get("stop"):
            job["state"] = "stopped"
        elif not job["tracks"]:
            job["state"] = "error"
            job["error"] = job.get("lastError") or "nothing could be downloaded"
        else:
            job["state"] = "done"
    except ApiError as e:
        job["state"], job["error"] = "error", e.message
    except Exception as e:  # never leave a job stuck "running"
        job["state"], job["error"] = "error", str(e)
    finally:
        job["current"] = ""
        job["updated"] = time.time()
        WORKERS.pop(jid, None)
        _save_jobs(board)


def create_job(board: Path, data):
    url = str(data.get("url", "")).strip()
    if not re.match(r"^https?://", url):
        raise ApiError(400, "that doesn't look like a link")
    if not ytdlp_cmd():
        raise ApiError(501, "yt-dlp is not installed. Run:  pip install yt-dlp   (or put yt-dlp.exe in the tools folder)")
    if not ffmpeg_path():
        raise ApiError(501, "ffmpeg is not installed. Install it (winget install ffmpeg) or put ffmpeg.exe in the tools folder")
    music = data.get("music") if isinstance(data.get("music"), dict) else {}
    job = {
        "id": hashlib.sha1(f"{url}{time.time()}".encode()).hexdigest()[:10],
        "board": board.name, "url": url,
        "kind": "playlist" if data.get("kind") == "playlist" else "song",
        "target": data.get("target"), "music": {"radius": music.get("radius"), "volume": music.get("volume")},
        "state": "queued", "title": "", "entries": None, "next": 0, "current": "",
        "tracks": [], "failed": 0, "applied": 0, "error": None,
        "created": time.time(), "updated": time.time(),
    }
    with JOBS_LOCK:
        _load_jobs(board)
        JOBS[job["id"]] = job
        _start_worker(board, job["id"])
    _save_jobs(board)
    return job


def list_jobs(board: Path):
    _load_jobs(board)
    with JOBS_LOCK:
        return sorted((j for j in JOBS.values() if j["board"] == board.name), key=lambda j: j["created"])


def resume_all_jobs():
    """At startup: carry on with downloads that were interrupted by a restart."""
    try:
        for p in CONFIG.boards_dir.iterdir():
            if p.is_dir() and (p / ".music-jobs.json").is_file():
                _load_jobs(p)
    except OSError:
        pass


def board_summary(p: Path):
    info = {"name": p.name, "items": 0, "modified": p.stat().st_mtime, "previews": []}
    bj = p / "board.json"
    if bj.is_file():
        info["modified"] = bj.stat().st_mtime
        try:
            data = json.loads(bj.read_text("utf-8"))
            items = data.get("items", [])
            info["items"] = sum(1 for i in items if i.get("type") != "arrow")
            info["previews"] = [i["src"] for i in items if i.get("type") == "image" and i.get("src")][:3]
            info["snippets"] = [i.get("text", "")[:60] for i in items if i.get("type") == "text" and i.get("text")][:3]
        except (OSError, ValueError):
            pass
    return info


# --------------------------------------------------------------------------- http

class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


class Handler(BaseHTTPRequestHandler):
    server_version = "doodleboard/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if os.environ.get("DOODLE_VERBOSE"):
            super().log_message(fmt, *args)

    # ---- plumbing
    def _host_ok(self):
        host = (self.headers.get("Host") or "").split(":")[0].strip("[]").lower()
        return host in {"localhost", "127.0.0.1", "::1", self.server.bind_host.lower()}

    def _origin_ok(self):
        origin = self.headers.get("Origin")
        if not origin:
            return True
        o = urllib.parse.urlparse(origin)
        return (o.hostname or "").lower() in {"localhost", "127.0.0.1", "::1", self.server.bind_host.lower()}

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_body(self, limit=50 * 1024 ** 2):
        n = int(self.headers.get("Content-Length") or 0)
        if n > limit:
            raise ApiError(413, "too large")
        return self.rfile.read(n) if n else b""

    def read_json(self):
        try:
            return json.loads(self.read_body() or b"{}")
        except ValueError:
            raise ApiError(400, "bad json")

    def handle_any(self, method):
        if not self._host_ok():
            self.send_error(403, "bad host")
            return
        if method != "GET" and not self._origin_ok():
            self.send_error(403, "bad origin")
            return
        url = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(url.path)
        query = urllib.parse.parse_qs(url.query)
        try:
            if path.startswith("/api/"):
                LAST_SEEN[0] = time.time()
                self.route_api(method, path[5:].strip("/"), query)
            elif path.startswith("/boards/") and method in ("GET", "HEAD"):
                rest = path[len("/boards/"):]
                name, _, sub = rest.partition("/")
                board = board_path(name)
                target = board / sub
                if not sub or not within(board, target):
                    raise ApiError(404, "not found")
                self.send_file(target, cache="no-cache")
            elif method in ("GET", "HEAD"):
                target = APP_DIR / (path.lstrip("/") or "index.html")
                if not within(APP_DIR, target):
                    raise ApiError(404, "not found")
                if target.is_dir():
                    target = target / "index.html"
                self.send_file(target, cache="no-cache")
            else:
                raise ApiError(405, "method not allowed")
        except ApiError as e:
            if path.startswith("/api/"):
                self.send_json({"error": e.message}, e.status)
            else:
                self.send_error(e.status, e.message)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # pragma: no cover
            import traceback
            traceback.print_exc()
            try:
                self.send_json({"error": f"server error: {e}"}, 500)
            except Exception:
                pass

    def do_GET(self):
        self.handle_any("GET")

    def do_HEAD(self):
        self.handle_any("HEAD")

    def do_POST(self):
        self.handle_any("POST")

    def do_PUT(self):
        self.handle_any("PUT")

    def do_DELETE(self):
        self.handle_any("DELETE")

    # ---- static files with Range support (needed for video / audio seeking)
    def send_file(self, target: Path, cache="no-cache"):
        if not target.is_file():
            raise ApiError(404, "not found")
        size = target.stat().st_size
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        start, end = 0, size - 1
        status = 200
        rng = self.headers.get("Range")
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)", rng)
            if m:
                if m.group(1):
                    start = int(m.group(1))
                    end = int(m.group(2)) if m.group(2) else size - 1
                elif m.group(2):
                    start = max(0, size - int(m.group(2)))
                end = min(end, size - 1)
                if start > end or start >= size:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                status = 206
        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", cache)
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(target, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(1 << 16, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    # ---- API
    def route_api(self, method, path, query):
        parts = [p for p in path.split("/") if p]

        if parts == ["ping"]:
            return self.send_json({"ok": True})

        if parts == ["info"] and method == "GET":
            return self.send_json({
                "app": "doodleboard",
                "boardsDir": str(CONFIG.boards_dir.resolve()),
                "ytdlp": bool(ytdlp_cmd()),
                "ffmpeg": bool(ffmpeg_path()),
            })

        if parts == ["youtube-list"] and method == "POST":
            return self.send_json(youtube_list(self.read_json().get("url", "").strip()))

        if parts == ["config"] and method == "POST":
            data = self.read_json()
            new_dir = Path(str(data.get("boardsDir", "")).strip()).expanduser()
            if not str(new_dir).strip():
                raise ApiError(400, "no folder given")
            try:
                new_dir.mkdir(parents=True, exist_ok=True)
            except OSError as e:
                raise ApiError(400, f"can't use that folder: {e}")
            with CONFIG.lock:
                CONFIG.boards_dir = new_dir
                CONFIG.save()
            return self.send_json({"boardsDir": str(new_dir.resolve())})

        if parts == ["boards"]:
            CONFIG.boards_dir.mkdir(parents=True, exist_ok=True)
            if method == "GET":
                boards = [board_summary(p) for p in CONFIG.boards_dir.iterdir()
                          if p.is_dir() and not p.name.startswith(".")]
                boards.sort(key=lambda b: -b["modified"])
                return self.send_json({"boards": boards, "boardsDir": str(CONFIG.boards_dir.resolve())})
            if method == "POST":
                data = self.read_json()
                name = clean_name(data.get("name"), fallback="new board")
                base, n = name, 2
                while (CONFIG.boards_dir / name).exists():
                    name = f"{base} {n}"
                    n += 1
                p = CONFIG.boards_dir / name
                (p / "assets").mkdir(parents=True)
                board = data.get("board") or {"version": 1, "items": []}
                atomic_write(p / "board.json", json.dumps(board, indent=1).encode("utf-8"))
                return self.send_json({"name": name}, 201)

        if len(parts) >= 2 and parts[0] == "boards":
            board = board_path(parts[1])
            action = parts[2] if len(parts) > 2 else ""
            if action != "" or method != "POST":
                if not board.is_dir():
                    raise ApiError(404, "no such board")

            if action == "" and method == "GET":
                bj = board / "board.json"
                data = json.loads(bj.read_text("utf-8")) if bj.is_file() else {"version": 1, "items": []}
                data["name"] = board.name
                return self.send_json(data)

            if (action == "" and method == "PUT") or (action == "save" and method == "POST"):
                raw = self.read_body()
                try:
                    data = json.loads(raw)
                except ValueError:
                    raise ApiError(400, "bad json")
                if not isinstance(data, dict) or not isinstance(data.get("items"), list):
                    raise ApiError(400, "not a board")
                bj = board / "board.json"
                bak = board / "board.json.bak"
                if bj.is_file() and (not bak.exists() or time.time() - bak.stat().st_mtime > 300):
                    shutil.copy2(bj, bak)
                atomic_write(bj, json.dumps(data, indent=1, ensure_ascii=False).encode("utf-8"))
                return self.send_json({"ok": True, "saved": time.time()})

            if action == "" and method == "DELETE":
                trash = CONFIG.boards_dir / ".trash"
                trash.mkdir(exist_ok=True)
                shutil.move(str(board), str(trash / f"{board.name} {time.strftime('%Y%m%d-%H%M%S')}"))
                return self.send_json({"ok": True})

            if action == "rename" and method == "POST":
                new = clean_name(self.read_json().get("name"), fallback="")
                if not new or new.startswith("."):
                    raise ApiError(400, "bad name")
                target = CONFIG.boards_dir / new
                if target.exists() and target.resolve() != board.resolve():
                    raise ApiError(409, "a board with that name already exists")
                board.rename(target)
                return self.send_json({"name": new})

            if action == "assets" and method == "POST":
                filename = urllib.parse.unquote(self.headers.get("X-Filename") or "")
                length = int(self.headers.get("Content-Length") or 0)
                ctype = self.headers.get("Content-Type", "")
                path, kind = store_stream(board, self.rfile, length, filename, ctype)
                return self.send_json({"src": rel(board, path), "kind": kind, "name": path.name}, 201)

            if action == "fetch" and method == "POST":
                return self.send_json(fetch_url_to_board(board, self.read_json().get("url", "")), 201)

            if action == "import" and method == "POST":
                # copy an asset from another board (cross-board copy/paste)
                data = self.read_json()
                src_board = board_path(data.get("fromBoard", ""))
                src = src_board / str(data.get("src", ""))
                if not within(src_board / "assets", src) or not src.is_file():
                    raise ApiError(404, "asset not found")
                dest = board / src.resolve().relative_to(src_board.resolve())
                dest.parent.mkdir(parents=True, exist_ok=True)
                if not dest.exists():
                    shutil.copy2(src, dest)
                return self.send_json({"src": rel(board, dest)})

            if action == "music-jobs":
                jid = parts[3] if len(parts) > 3 else None
                if not jid and method == "GET":
                    return self.send_json({"jobs": list_jobs(board)})
                if not jid and method == "POST":
                    return self.send_json(create_job(board, self.read_json()), 201)
                _load_jobs(board)
                with JOBS_LOCK:
                    job = JOBS.get(jid)
                    if not job or job["board"] != board.name:
                        raise ApiError(404, "no such download")
                    if method == "POST":
                        data = self.read_json()
                        if data.get("stop"):
                            job["stop"] = True
                        if isinstance(data.get("applied"), int):
                            job["applied"] = max(job["applied"], min(data["applied"], len(job["tracks"])))
                    elif method == "DELETE":
                        job["stop"] = True
                        JOBS.pop(jid, None)
                _save_jobs(board)
                return self.send_json(job)

            if action == "youtube" and method == "POST":
                data = self.read_json()
                return self.send_json(youtube_download(board, data.get("url", "").strip(),
                                                       data.get("mode", "audio"),
                                                       data.get("start"), data.get("end")), 201)

            if action == "loudness" and method == "POST":
                return self.send_json(measure_loudness(board, str(self.read_json().get("src", ""))))

            if action == "files" and method == "GET":
                sub = (query.get("dir") or ["music"])[0]
                folder = board / "assets" / sub
                if not within(board / "assets", folder):
                    raise ApiError(400, "bad folder")
                files = []
                if folder.is_dir():
                    for f in sorted(folder.iterdir(), key=lambda f: f.name.lower()):
                        if f.is_file() and not f.name.startswith("."):
                            files.append({"src": rel(board, f), "name": f.stem})
                return self.send_json({"files": files})

        raise ApiError(404, "unknown api route")


# --------------------------------------------------------------------------- launch

def find_app_browser():
    candidates = []
    if sys.platform.startswith("win"):
        for env in ("PROGRAMFILES(X86)", "PROGRAMFILES", "LOCALAPPDATA"):
            base = os.environ.get(env)
            if base:
                candidates += [Path(base) / "Microsoft/Edge/Application/msedge.exe",
                               Path(base) / "Google/Chrome/Application/chrome.exe",
                               Path(base) / "BraveSoftware/Brave-Browser/Application/brave.exe"]
    elif sys.platform == "darwin":
        candidates += [Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
                       Path("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
                       Path("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser")]
    for c in candidates:
        if c.is_file():
            return str(c)
    for name in ("microsoft-edge", "google-chrome", "chromium", "chromium-browser", "brave-browser"):
        p = shutil.which(name)
        if p:
            return p
    return None


class Server(ThreadingHTTPServer):
    # On Windows, SO_REUSEADDR would let a second copy quietly share a port
    # that's already in use, so we couldn't notice the first one is running.
    allow_reuse_address = not sys.platform.startswith("win")


def open_window(url, app_mode):
    exe = find_app_browser() if app_mode else None
    if exe:
        subprocess.Popen([exe, f"--app={url}", "--new-window"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        webbrowser.open(url)


def already_running(port):
    """Is a doodleboard server already answering on this port?"""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # never via a proxy
    try:
        with opener.open(f"http://127.0.0.1:{port}/api/info", timeout=1.5) as r:
            return json.loads(r.read()).get("app") == "doodleboard"
    except Exception:
        return False


def main():
    ap = argparse.ArgumentParser(description="doodleboard local server")
    ap.add_argument("--port", type=int, default=7777)
    ap.add_argument("--host", default="127.0.0.1", help="interface to bind (default: localhost only)")
    ap.add_argument("--boards", help="folder that holds your boards (remembered in config.json)")
    ap.add_argument("--app", action="store_true", help="open in a chromeless Edge/Chrome app window")
    ap.add_argument("--no-browser", action="store_true", help="don't open anything")
    ap.add_argument("--background", action="store_true",
                    help="no console: log to doodleboard.log and quit a few minutes after the last window closes")
    args = ap.parse_args()

    if args.background or sys.stdout is None:  # pythonw has no console to print to
        log = open(ROOT / "doodleboard.log", "a", encoding="utf-8", buffering=1)
        sys.stdout = sys.stderr = log
        print(f"--- {time.strftime('%Y-%m-%d %H:%M:%S')}")

    CONFIG.load()
    if args.boards:
        CONFIG.boards_dir = Path(args.boards).expanduser()
        CONFIG.save()
    CONFIG.boards_dir.mkdir(parents=True, exist_ok=True)

    httpd = None
    for port in range(args.port, args.port + 20):
        try:
            httpd = Server((args.host, port), Handler)
            break
        except OSError:
            if already_running(port):
                # one copy is enough: just open another window onto it
                print(f"  doodleboard is already running on port {port}")
                if not args.no_browser:
                    open_window(f"http://localhost:{port}/", args.app)
                return
    if not httpd:
        sys.exit("couldn't find a free port")
    httpd.bind_host = args.host
    httpd.daemon_threads = True
    url = f"http://localhost:{httpd.server_address[1]}/"

    print(f"\n  doodleboard is running at {url}")
    print(f"  boards folder: {CONFIG.boards_dir.resolve()}")
    print(f"  yt-dlp: {'yes' if ytdlp_cmd() else 'missing (pip install yt-dlp)'}   "
          f"ffmpeg: {'yes' if ffmpeg_path() else 'missing'}")
    print("  press Ctrl+C to stop\n")

    threading.Thread(target=resume_all_jobs, daemon=True).start()

    if not args.no_browser:
        threading.Timer(0.4, open_window, args=(url, args.app)).start()

    if args.background:
        # open windows ping every 30s; once they've all been closed for a while, quit
        def watchdog():
            while True:
                time.sleep(10)
                if WORKERS:
                    continue  # downloads still running: keep going for them
                if time.time() - LAST_SEEN[0] > 150:
                    print("  no open windows for a while, stopping")
                    httpd.shutdown()
                    return
        threading.Thread(target=watchdog, daemon=True).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("bye!")


if __name__ == "__main__":
    main()
