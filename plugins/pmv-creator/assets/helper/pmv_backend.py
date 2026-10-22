#!/usr/bin/env python3
"""PMV Creator backend.

Runs in two ways:
  * as Stash plugin (interface: raw) – JSON on stdin, {"output": ...} / {"error": ...} on stdout,
    log lines + progress on stderr using Stash's \\x01<level>\\x02 protocol;
  * as CLI for renders outside Stash:
        python pmv_backend.py render plan.json -o out.mp4 [--ffmpeg PATH] [--jobs 2]
        python pmv_backend.py script plan.json [--shell sh|cmd]
  * as render helper on a PC – renders started in the editor with "On my PC" run there:
        python pmv_backend.py helper --stash http://nas:9999 [--api-key KEY] [--name PC]
    (the editor offers this file for download with the Stash address filled in; then a double-click is enough)

Render pipeline (all timing decisions were made by the frontend's render plan):
  1. every piece (clip / black / xfade) -> one FFmpeg call with its own filtergraph
     (seek, speed, fps, scale+crop/pad, xfade, audio) into a uniform intermediate (H.264 + PCM, MKV);
     pieces are content-addressed, so unchanged pieces are reused on re-render;
  2. concat demuxer (stream copy) + music mix -> final MP4.

No third-party dependencies; Python >= 3.8 and FFmpeg >= 4.4.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import shlex
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import FIRST_EXCEPTION, ThreadPoolExecutor, wait
from fractions import Fraction
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

VERSION = "0.7.2"
PLUGIN_ID = "pmv-creator"
PLAN_VERSION = 1
# Bump when piece_command() changes, invalidates cached pieces.
PIECE_VERSION = 3
# Intermediate container: MOV keeps an exact per-frame timescale (MKV rounds to 1 ms -> VFR jitter).
PIECE_EXT = ".mov"
PLUGIN_DIR = Path(__file__).resolve().parent.parent
MEDIA_URL = f"/plugin/{PLUGIN_ID}/assets/media/"

ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
# Filled in by the editor when this file is downloaded as render helper ("stash", "apiKey"); empty inside Stash.
HELPER_DEFAULTS: Dict[str, str] = {}
XFADE = {
    "fade", "fadeblack", "fadewhite", "dissolve", "wipeleft", "wiperight", "slideleft",
    "slideright", "circleopen", "pixelize", "zoomin", "hblur", "radial",
}
X264_PRESETS = {"ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"}
NVENC_PRESET = {"ultrafast": "p1", "superfast": "p2", "veryfast": "p3", "faster": "p4", "fast": "p4", "medium": "p5", "slow": "p6", "slower": "p7", "veryslow": "p7"}

# --------------------------------------------------------------------------------------- logging

PLAIN_LOG = False  # CLI mode prints readable lines instead of Stash's protocol
LOG_HOOK: Optional[Callable[[str, str], None]] = None  # render helper: progress/messages go back to Stash


def _log(level: str, msg: str) -> None:
    if LOG_HOOK:
        LOG_HOOK(level, str(msg))
    if PLAIN_LOG:
        if level != "p":
            print(f"[{level}] {msg}", file=sys.stderr, flush=True)
        return
    for line in str(msg).splitlines() or [""]:
        sys.stderr.write(f"\x01{level}\x02{line}\n")
    sys.stderr.flush()


def log_debug(m: str) -> None:
    _log("d", m)


def log_info(m: str) -> None:
    _log("i", m)


def log_warn(m: str) -> None:
    _log("w", m)


def log_error(m: str) -> None:
    _log("e", m)


def log_progress(p: float) -> None:
    _log("p", f"{max(0.0, min(1.0, p)):.4f}")


# --------------------------------------------------------------------------------------- stash

class Stash:
    """Minimal GraphQL client using the session cookie Stash hands to the plugin."""

    def __init__(self, conn: Dict[str, Any]):
        get = lambda k, d=None: conn.get(k, conn.get(k.lower(), d))  # noqa: E731
        scheme = get("Scheme", "http")
        host = get("Host") or "localhost"
        if host in ("0.0.0.0", "::", "[::]"):
            host = "localhost"
        self.base = f"{scheme}://{host}:{get('Port', 9999)}/"
        self.url = self.base + "graphql"
        cookie = get("SessionCookie") or {}
        self.cookie = f"{cookie.get('Name')}={cookie.get('Value')}" if cookie.get("Name") else None
        self.dir = get("Dir")
        self.ctx = ssl._create_unverified_context() if scheme == "https" else None  # self-signed local certs

    def call(self, query: str, variables: Optional[dict] = None, timeout: float = 5.0) -> dict:
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if self.cookie:
            headers["Cookie"] = self.cookie
        body = json.dumps({"query": query, "variables": variables or {}}).encode()
        req = urllib.request.Request(self.url, data=body, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout, context=self.ctx) as r:
            data = json.load(r)
        if data.get("errors"):
            raise RuntimeError("; ".join(e.get("message", "") for e in data["errors"]))
        return data["data"]


class Context:
    def __init__(self, stash: Optional[Stash], settings: Dict[str, Any]):
        self.stash = stash
        self.settings = settings
        # PMV_DATA_DIR is for tests/development; in Stash the media folder must be the one ui.assets serves
        data_env = os.environ.get("PMV_DATA_DIR")
        base = Path(data_env) if data_env else PLUGIN_DIR / "data"
        self.base = base
        self.projects = Path(settings.get("projectDir") or base / "projects")
        self.media = (base / "media") if data_env else PLUGIN_DIR / "assets" / "media"  # /plugin/<id>/assets/media/
        self.renders = Path(settings.get("outputDir") or base / "renders")
        self.work = base / "work"
        self.cache = base / "cache"
        self._tools: Dict[str, str] = {}

    def tool(self, name: str) -> str:
        if name not in self._tools:
            self._tools[name] = resolve_tool(name, self.settings.get(f"{name}Path"), self.stash)
        return self._tools[name]

    def try_tool(self, name: str) -> Optional[str]:
        try:
            return self.tool(name)
        except RuntimeError:
            return None


def load_settings(stash: Optional[Stash]) -> Dict[str, Any]:
    if not stash:
        return {}
    try:
        plugins = stash.call("query PmvSettings { configuration { plugins } }")["configuration"]["plugins"] or {}
        return plugins.get(PLUGIN_ID) or {}
    except Exception as e:  # settings are optional
        log_debug(f"plugin settings unavailable: {e}")
        return {}


def resolve_tool(name: str, configured: Optional[str], stash: Optional[Stash]) -> str:
    if configured:
        return configured
    if stash:
        try:
            general = stash.call("query PmvTools { configuration { general { ffmpegPath ffprobePath } } }")["configuration"]["general"]
            if general.get(f"{name}Path"):
                return general[f"{name}Path"]
        except Exception:
            pass  # older Stash versions do not expose these fields
        if stash.dir:
            cand = Path(stash.dir) / (name + (".exe" if os.name == "nt" else ""))
            if cand.is_file():
                return str(cand)
    found = shutil.which(name)
    if found:
        return found
    raise RuntimeError(f"{name} not found – set its path in the plugin settings")


# --------------------------------------------------------------------------------------- helpers

def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def safe_filename(name: str, fallback: str = "file") -> str:
    stem = re.sub(r"[^\w\-. ]+", "_", name).strip(" .")
    return stem[:120] or fallback


def unique_path(directory: Path, filename: str) -> Path:
    p = directory / filename
    stem, suffix = p.stem, p.suffix
    n = 2
    while p.exists():
        p = directory / f"{stem} ({n}){suffix}"
        n += 1
    return p


def require_id(value: Any, what: str = "id") -> str:
    if not isinstance(value, str) or not ID_RE.match(value):
        raise ValueError(f"invalid {what}: {value!r}")
    return value


def as_json(value: Any) -> Any:
    return json.loads(value) if isinstance(value, str) else value


# --------------------------------------------------------------------------------------- process control

_PROCS: set = set()
_PROCS_LOCK = threading.Lock()
_CANCELLED = threading.Event()


class Cancelled(Exception):
    pass


def _terminate_all(*_: Any) -> None:
    _CANCELLED.set()
    with _PROCS_LOCK:
        for p in list(_PROCS):
            try:
                p.kill()
            except Exception:
                pass


def run_ffmpeg(cmd: List[str], on_progress: Optional[Callable[[float], None]] = None) -> None:
    """Runs FFmpeg; `on_progress` receives seconds of output written (needs -progress pipe:1)."""
    if _CANCELLED.is_set():
        raise Cancelled()
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0  # type: ignore[attr-defined]
    with tempfile.TemporaryFile() as err:
        p = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE if on_progress else subprocess.DEVNULL, stderr=err, creationflags=flags)
        with _PROCS_LOCK:
            _PROCS.add(p)
        try:
            if on_progress and p.stdout:
                for raw in p.stdout:
                    line = raw.decode(errors="replace").strip()
                    if line.startswith("out_time_us=") or line.startswith("out_time_ms="):
                        try:
                            on_progress(int(line.split("=", 1)[1]) / 1e6)
                        except ValueError:
                            pass
            p.wait()
        finally:
            with _PROCS_LOCK:
                _PROCS.discard(p)
        if _CANCELLED.is_set():
            raise Cancelled()
        if p.returncode != 0:
            err.seek(0)
            tail = err.read().decode(errors="replace").strip()[-2000:]
            raise RuntimeError(f"FFmpeg failed ({p.returncode}): {tail}\n$ {' '.join(shlex.quote(c) for c in cmd)}")


# --------------------------------------------------------------------------------------- render plan -> ffmpeg

class Out:
    def __init__(self, o: Dict[str, Any]):
        self.w = int(o["width"]) // 2 * 2
        self.h = int(o["height"]) // 2 * 2
        self.fps = float(o["fps"])
        self.rate = fps_expr(self.fps)
        self.fit = norm_fit(o.get("fit"))
        self.codec = o.get("videoCodec") or "libx264"
        if self.codec not in ("libx264", "libx265", "h264_nvenc", "hevc_nvenc"):
            raise ValueError(f"unsupported codec: {self.codec}")
        self.crf = int(o.get("crf", 18))
        preset = str(o.get("preset") or "medium")
        self.preset = preset if preset in X264_PRESETS else "medium"
        self.audio_bitrate = str(o.get("audioBitrate") or "320k") if re.match(r"^\d+k$", str(o.get("audioBitrate") or "")) else "320k"

    def seconds(self, frames: int) -> float:
        return frames / self.fps

    @property
    def timescale(self) -> int:
        """Track timescale in which every frame lasts a whole number of ticks."""
        r = rate_fraction(self.fps)
        if 90000 % r.numerator == 0:
            return 90000
        return r.numerator * max(1, -(-10000 // r.numerator))


def rate_fraction(fps: float) -> Fraction:
    for num, den in ((24000, 1001), (30000, 1001), (60000, 1001)):
        if abs(fps - num / den) < 0.01:
            return Fraction(num, den)
    return Fraction(fps).limit_denominator(1000)


def fps_expr(fps: float) -> str:
    r = rate_fraction(fps)
    return str(r.numerator) if r.denominator == 1 else f"{r.numerator}/{r.denominator}"


def f6(x: float) -> str:
    return f"{x:.6f}"


FITS = ("cover", "contain", "blur")


def norm_fit(value: Any) -> str:
    return value if value in FITS else "cover"


def fit_filter(out: Out, fit: str, tag: str = "f") -> str:
    """Filter text that continues a chain. `blur` branches (split) and needs labels unique per chain -> tag."""
    if fit == "contain":
        return f"scale={out.w}:{out.h}:force_original_aspect_ratio=decrease:flags=bicubic,pad={out.w}:{out.h}:(ow-iw)/2:(oh-ih)/2:color=black"
    if fit == "blur":
        # whole picture centred over a blurred, slightly darkened copy that fills the frame (like the PMV Generator)
        r = max(2, min(out.w, out.h) // 24)
        return (
            f"split[{tag}bg][{tag}fg];"
            f"[{tag}bg]scale={out.w}:{out.h}:force_original_aspect_ratio=increase:flags=bilinear,crop={out.w}:{out.h},boxblur={r}:2,eq=brightness=-0.08[{tag}bb];"
            f"[{tag}fg]scale={out.w}:{out.h}:force_original_aspect_ratio=decrease:flags=bicubic[{tag}ff];"
            f"[{tag}bb][{tag}ff]overlay=(W-w)/2:(H-h)/2:format=auto"
        )
    return f"scale={out.w}:{out.h}:force_original_aspect_ratio=increase:flags=bicubic,crop={out.w}:{out.h}"


def is_url(path: Any) -> bool:
    return isinstance(path, str) and path.startswith(("http://", "https://"))


def input_args(src: Dict[str, Any]) -> List[str]:
    """Options in front of an input: only the render helper sets them (HTTP header + timeout for Stash streams)."""
    return [str(a) for a in src.get("inputArgs") or []] if is_url(src.get("path")) else []


def atempo_chain(speed: float) -> List[str]:
    factors: List[float] = []
    s = speed
    while s > 2.0:
        factors.append(2.0)
        s /= 2.0
    while s < 0.5:
        factors.append(0.5)
        s /= 0.5
    factors.append(s)
    return [f"atempo={f:.6f}" for f in factors if abs(f - 1.0) > 1e-6]


def video_codec_args(out: Out) -> List[str]:
    gop = str(max(1, round(out.fps * 2)))
    if out.codec in ("libx264", "libx265"):
        args = ["-c:v", out.codec, "-preset", out.preset, "-crf", str(out.crf)]
    else:
        args = ["-c:v", out.codec, "-preset", NVENC_PRESET.get(out.preset, "p5"), "-rc", "vbr", "-cq", str(out.crf), "-b:v", "0"]
    return args + ["-pix_fmt", "yuv420p", "-g", gop]


def piece_command(ff: str, piece: Dict[str, Any], out: Out, clip_audio: bool, dest: str) -> List[str]:
    frames = int(piece["frames"])
    if frames <= 0:
        raise ValueError("segment without frames")
    dur = out.seconds(frames)
    inputs: List[str] = []
    graph: List[str] = []
    n_inputs = 0

    def source(src: Optional[Dict[str, Any]], vlabel: str, alabel: str) -> None:
        nonlocal n_inputs
        if src is None:
            graph.append(f"color=c=black:s={out.w}x{out.h}:r={out.rate}:d={f6(dur + 1 / out.fps)},format=yuv420p,setsar=1,trim=end_frame={frames}[{vlabel}]")
            if clip_audio:
                graph.append(f"anullsrc=r=48000:cl=stereo,atrim=0:{f6(dur)}[{alabel}]")
            return
        speed = float(src.get("speed", 1.0))
        if not 0.05 <= speed <= 20:
            raise ValueError(f"speed out of range: {speed}")
        idx = n_inputs
        n_inputs += 1
        # input seeking (fast) + re-encode = frame accurate; -t limits decoding to what we need
        inputs.extend([*input_args(src), "-ss", f6(max(0.0, float(src["in"]))), "-t", f6(dur * speed + 1.0), "-i", str(src["path"])])
        fit = norm_fit(src.get("fit"))
        graph.append(
            f"[{idx}:v:0]setpts=(PTS-STARTPTS)/{speed:.6f},fps={out.rate},{fit_filter(out, fit, vlabel)},setsar=1,format=yuv420p,"
            f"tpad=stop_mode=clone:stop_duration={f6(dur)},trim=end_frame={frames},setpts=PTS-STARTPTS[{vlabel}]"
        )
        if not clip_audio:
            return
        volume = float(src.get("volume", 0))
        if src.get("hasAudio") and volume > 0:
            chain = ["asetpts=PTS-STARTPTS", *atempo_chain(speed), "aresample=48000", "aformat=sample_fmts=fltp:channel_layouts=stereo",
                     f"volume={volume:.4f}", "apad", f"atrim=0:{f6(dur)}", "asetpts=PTS-STARTPTS"]
            graph.append(f"[{idx}:a:0]{','.join(chain)}[{alabel}]")
        else:
            graph.append(f"anullsrc=r=48000:cl=stereo,atrim=0:{f6(dur)}[{alabel}]")

    kind = piece.get("kind")
    if kind == "black":
        source(None, "v", "a")
    elif kind == "clip":
        source(piece["src"], "v", "a")
    elif kind == "xfade":
        transition = piece.get("transition")
        if transition not in XFADE:
            raise ValueError(f"unsupported transition: {transition!r}")
        source(piece.get("a"), "va", "aa")
        source(piece.get("b"), "vb", "ab")
        graph.append(f"[va][vb]xfade=transition={transition}:duration={f6(dur)}:offset=0,trim=end_frame={frames}[v]")
        if clip_audio:
            graph.append(f"[aa]afade=t=out:st=0:d={f6(dur)}[aa2]")
            graph.append(f"[ab]afade=t=in:st=0:d={f6(dur)}[ab2]")
            graph.append(f"[aa2][ab2]amix=inputs=2:duration=longest:normalize=0,atrim=0:{f6(dur)}[a]")
    else:
        raise ValueError(f"unknown segment type: {kind!r}")

    cmd = [ff, "-hide_banner", "-nostdin", "-y", "-loglevel", "error", *inputs, "-filter_complex", ";".join(graph), "-map", "[v]"]
    if clip_audio:
        cmd += ["-map", "[a]", "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2"]
    cmd += video_codec_args(out) + ["-r", out.rate, "-frames:v", str(frames), "-video_track_timescale", str(out.timescale), "-f", "mov", dest]
    return cmd


def final_command(ff: str, plan: Dict[str, Any], out: Out, list_path: str, dest: str, progress: bool = True) -> List[str]:
    total = out.seconds(int(plan["totalFrames"]))
    clip_audio = bool(plan.get("clipAudio"))
    cmd = [ff, "-hide_banner", "-nostdin", "-y", "-loglevel", "error"]
    if progress:
        cmd += ["-progress", "pipe:1", "-nostats"]
    cmd += ["-f", "concat", "-safe", "0", "-i", list_path]
    graph: List[str] = []
    audio_map: Optional[str] = None
    music = plan.get("audio")
    if music and music.get("path"):
        cmd += [*input_args(music), "-ss", f6(float(music.get("sourceIn", 0))), "-i", str(music["path"])]
        chain = ["asetpts=PTS-STARTPTS", "aresample=48000", "aformat=sample_fmts=fltp:channel_layouts=stereo", f"volume={float(music.get('gainDb', 0)):.2f}dB"]
        fade_in, fade_out = float(music.get("fadeIn", 0)), float(music.get("fadeOut", 0))
        if fade_in > 0:
            chain.append(f"afade=t=in:st=0:d={f6(fade_in)}")
        delay_ms = int(round(float(music.get("start", 0)) * 1000))
        if delay_ms > 0:
            chain.append(f"adelay={delay_ms}:all=1")
        chain += ["apad", f"atrim=0:{f6(total)}"]
        if fade_out > 0:
            chain.append(f"afade=t=out:st={f6(max(0.0, total - fade_out))}:d={f6(fade_out)}")
        graph.append(f"[1:a:0]{','.join(chain)}[music]")
        if clip_audio:
            graph.append(f"[0:a:0]aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:{f6(total)}[clips]")
            graph.append("[clips][music]amix=inputs=2:duration=first:normalize=0[aout]")
            audio_map = "[aout]"
        else:
            audio_map = "[music]"
    elif clip_audio:
        audio_map = "0:a:0"
    if graph:
        cmd += ["-filter_complex", ";".join(graph)]
    cmd += ["-map", "0:v:0"]
    if audio_map:
        cmd += ["-map", audio_map, "-c:a", "aac", "-b:a", out.audio_bitrate, "-ar", "48000"]
    # The concat demuxer accumulates file offsets in microseconds; with hundreds of pieces that drifts
    # by a few ticks. Snap every timestamp back onto the exact frame grid -> strictly constant frame rate.
    # PTS and DTS are rounded separately: "ts=" would give B-frame packets pts == dts and scramble the order.
    ticks = out.timescale * rate_fraction(out.fps).denominator // rate_fraction(out.fps).numerator
    setts = f"setts=pts=round(PTS/{ticks})*{ticks}:dts=round(DTS/{ticks})*{ticks}"
    cmd += ["-c:v", "copy", "-bsf:v", setts, "-video_track_timescale", str(out.timescale)]
    if out.codec in ("libx265", "hevc_nvenc"):
        cmd += ["-tag:v", "hvc1"]
    cmd += ["-movflags", "+faststart", "-t", f6(total), dest]
    return cmd


def validate_plan(plan: Dict[str, Any]) -> Out:
    if int(plan.get("version", 0)) != PLAN_VERSION:
        raise ValueError(f"render plan v{plan.get('version')} is not supported (expected v{PLAN_VERSION})")
    out = Out(plan["output"])
    pieces = plan.get("pieces") or []
    if not pieces:
        raise ValueError("render plan without segments")
    total = sum(int(p["frames"]) for p in pieces)
    if total != int(plan["totalFrames"]):
        raise ValueError(f"the segments add up to {total} frames, the plan says {plan['totalFrames']}")
    missing = set()
    for p in pieces:
        for s in (p.get("src"), p.get("a"), p.get("b")):
            if s and not is_url(s["path"]) and not os.path.isfile(s["path"]):
                missing.add(s["path"])
    music = plan.get("audio")
    if music and music.get("path") and not is_url(music["path"]) and not os.path.isfile(music["path"]):
        missing.add(music["path"])
    if missing:
        raise FileNotFoundError("files not found:\n" + "\n".join(sorted(missing)))
    return out


def piece_key(piece: Dict[str, Any], plan: Dict[str, Any]) -> str:
    o = plan["output"]
    relevant = {k: o.get(k) for k in ("width", "height", "fps", "fit", "videoCodec", "crf", "preset")}
    blob = json.dumps({"v": PIECE_VERSION, "piece": piece, "out": relevant, "clipAudio": bool(plan.get("clipAudio"))}, sort_keys=True)
    return hashlib.sha1(blob.encode()).hexdigest()


def concat_entry(path: str, frames: int, out: Out) -> str:
    # explicit durations keep the timestamps frame-exact instead of trusting container durations
    return "file '" + path.replace("'", "'\\''") + "'\nduration " + f6(out.seconds(frames))


def render_plan(plan: Dict[str, Any], ff: str, dest: Path, cache_dir: Path, work_dir: Path, jobs: int = 2) -> Dict[str, Any]:
    started = time.time()
    out = validate_plan(plan)
    clip_audio = bool(plan.get("clipAudio"))
    pieces = plan["pieces"]
    cache_dir.mkdir(parents=True, exist_ok=True)
    work_dir.mkdir(parents=True, exist_ok=True)
    dest.parent.mkdir(parents=True, exist_ok=True)

    paths = [cache_dir / f"{piece_key(p, plan)}{PIECE_EXT}" for p in pieces]
    todo: Dict[Path, Dict[str, Any]] = {}
    for p, path in zip(pieces, paths):
        if not path.exists():
            todo.setdefault(path, p)
    cached = len(pieces) - sum(1 for path in paths if path in todo)
    log_info(f"{len(pieces)} segments, {len(todo)} to render, {cached} from the cache")

    done = 0
    lock = threading.Lock()

    def render_one(path: Path, piece: Dict[str, Any]) -> None:
        nonlocal done
        tmp = path.with_name(path.stem + ".part" + PIECE_EXT)
        run_ffmpeg(piece_command(ff, piece, out, clip_audio, str(tmp)))
        os.replace(tmp, path)
        with lock:
            done += 1
            log_progress(0.9 * done / max(1, len(todo)))

    if todo:
        with ThreadPoolExecutor(max_workers=max(1, jobs)) as pool:
            futures = [pool.submit(render_one, path, piece) for path, piece in todo.items()]
            finished, _ = wait(futures, return_when=FIRST_EXCEPTION)
            for f in finished:
                if f.exception():
                    _terminate_all()
                    raise f.exception()  # type: ignore[misc]

    list_path = work_dir / "pieces.ffconcat"
    entries = [concat_entry(path.resolve().as_posix(), int(p["frames"]), out) for p, path in zip(pieces, paths)]
    list_path.write_text("ffconcat version 1.0\n" + "\n".join(entries) + "\n", encoding="utf-8")
    total = out.seconds(int(plan["totalFrames"]))
    tmp_dest = dest.with_name(dest.stem + ".part" + dest.suffix)
    log_info("Joining the segments and mixing the music …")
    run_ffmpeg(final_command(ff, plan, out, str(list_path), str(tmp_dest)), on_progress=lambda t: log_progress(0.9 + 0.1 * min(1.0, t / max(total, 1e-6))))
    os.replace(tmp_dest, dest)
    log_progress(1.0)
    return {"file": str(dest), "pieces": len(pieces), "cached": cached, "seconds": round(time.time() - started, 2)}


def ffmpeg_script(plan: Dict[str, Any], shell: str = "sh", ff: str = "ffmpeg") -> str:
    """Self-contained script with the same commands the renderer runs (pieces/ + output.mp4)."""
    out = validate_plan_light(plan)
    clip_audio = bool(plan.get("clipAudio"))
    pieces = plan["pieces"]
    names = [f"pieces/{i:04d}{PIECE_EXT}" for i in range(len(pieces))]
    cmds = [piece_command(ff, p, out, clip_audio, n) for p, n in zip(pieces, names)]
    final = final_command(ff, plan, out, "pieces.ffconcat", f"{safe_filename(plan.get('projectName', 'pmv'), 'pmv')}.mp4", progress=False)
    # entries are relative to the list file, which lives next to pieces/
    listing = ["ffconcat version 1.0", *[line for p, n in zip(pieces, names) for line in concat_entry(n, int(p["frames"]), out).split("\n")]]
    if shell == "cmd":
        q = lambda a: '"' + a.replace('"', '""').replace("%", "%%") + '"' if re.search(r'[\s;&|<>^()"%,=\[\]]', a) else a.replace("%", "%%")  # noqa: E731
        lines = ["@echo off", "setlocal", "cd /d \"%~dp0\"", "if not exist pieces mkdir pieces", "(", *[f"echo {line}" for line in listing], ") > pieces.ffconcat"]
        lines += [" ".join(q(a) for a in c) + " || exit /b 1" for c in cmds]
        lines.append(" ".join(q(a) for a in final))
        return "\r\n".join(lines) + "\r\n"
    lines = ["#!/usr/bin/env bash", "# generated by PMV Creator", "set -euo pipefail", 'cd "$(dirname "$0")"', "mkdir -p pieces", "cat > pieces.ffconcat <<'EOF'", *listing, "EOF"]
    lines += [" ".join(shlex.quote(a) for a in c) for c in cmds]
    lines.append(" ".join(shlex.quote(a) for a in final))
    return "\n".join(lines) + "\n"


def validate_plan_light(plan: Dict[str, Any]) -> Out:
    """Like validate_plan but without checking that files exist (scripts may run elsewhere)."""
    if int(plan.get("version", 0)) != PLAN_VERSION:
        raise ValueError(f"render plan v{plan.get('version')} is not supported")
    return Out(plan["output"])


def probe_duration(ffprobe: str, path: str) -> Optional[float]:
    try:
        r = subprocess.run([ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path], capture_output=True, text=True, timeout=30)
        return float(r.stdout.strip())
    except Exception:
        return None


# --------------------------------------------------------------------------------------- operations

def op_ping(ctx: Context, args: dict) -> dict:
    return {"version": VERSION, "ffmpeg": ctx.try_tool("ffmpeg"), "ffprobe": ctx.try_tool("ffprobe"), "python": sys.version.split()[0]}


def op_save_project(ctx: Context, args: dict) -> dict:
    project = as_json(args.get("project"))
    if not isinstance(project, dict):
        raise ValueError("project fehlt")
    pid = require_id(project.get("id"), "project id")
    path = ctx.projects / f"{pid}.pmv.json"
    atomic_write(path, json.dumps(project, ensure_ascii=False, indent=1).encode("utf-8"))
    return {"path": str(path)}


def op_load_project(ctx: Context, args: dict) -> Any:
    """The project, or null when there is none (a stale ?project= link is normal, not an error to log)."""
    path = ctx.projects / f"{require_id(args.get('id'), 'project id')}.pmv.json"
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def op_list_projects(ctx: Context, args: dict) -> list:
    items = []
    if ctx.projects.is_dir():
        for f in ctx.projects.glob("*.pmv.json"):
            try:
                p = json.loads(f.read_text(encoding="utf-8"))
                items.append({"id": p.get("id"), "name": p.get("name", f.stem), "updatedAt": p.get("updatedAt", "")})
            except Exception as e:
                log_warn(f"{f.name}: {e}")
    return sorted(items, key=lambda x: x["updatedAt"], reverse=True)


def op_delete_project(ctx: Context, args: dict) -> None:
    path = ctx.projects / f"{require_id(args.get('id'), 'project id')}.pmv.json"
    if path.is_file():
        path.unlink()
    return None


def op_upload_chunk(ctx: Context, args: dict) -> dict:
    upload_id = require_id(args.get("uploadId"), "Upload-ID")
    index, total = int(args.get("index", 0)), int(args.get("total", 1))
    ctx.media.mkdir(parents=True, exist_ok=True)
    part = ctx.media / f".upload-{upload_id}.part"
    with open(part, "wb" if index == 0 else "ab") as f:
        f.write(base64.b64decode(args.get("data") or ""))
    if index < total - 1:
        return {"done": False}
    final = unique_path(ctx.media, safe_filename(str(args.get("name") or "audio"), "audio"))
    os.replace(part, final)
    out = {"done": True, "path": str(final), "url": MEDIA_URL + urllib.parse.quote(final.name), "name": final.name, "size": final.stat().st_size}
    # the server's view of the length – the browser's decoder may stop early on odd files
    ffprobe = ctx.try_tool("ffprobe")
    if ffprobe and not final.suffix.lower() == ".webm":
        out["duration"] = probe_duration(ffprobe, str(final))
    return out


def op_import_audio(ctx: Context, args: dict) -> dict:
    src = Path(str(args.get("path") or "")).expanduser()
    if not src.is_file():
        raise FileNotFoundError(f"file not found: {src}")
    ctx.media.mkdir(parents=True, exist_ok=True)
    preview = unique_path(ctx.media, safe_filename(src.name, "audio"))
    shutil.copy2(src, preview)  # copy only for the browser preview; the render uses the original
    ffprobe = ctx.try_tool("ffprobe")
    return {"path": str(src), "url": MEDIA_URL + urllib.parse.quote(preview.name), "name": src.name, "duration": probe_duration(ffprobe, str(src)) if ffprobe else None}


def op_save_recording(ctx: Context, args: dict) -> dict:
    """A browser recording (WebM from MediaRecorder) uploaded via upload_chunk: into the output folder, scanned like a render.
    MediaRecorder files carry no duration/cues; a copy remux through FFmpeg fixes that when FFmpeg is around."""
    src = Path(str(args.get("path") or ""))
    if not src.is_file() or src.parent.resolve() != ctx.media.resolve():
        raise FileNotFoundError(f"upload not found: {src}")
    name = safe_filename(str(args.get("name") or "pmv"), "pmv")
    ctx.renders.mkdir(parents=True, exist_ok=True)
    dest = unique_path(ctx.renders, f"{name}_{time.strftime('%Y%m%d-%H%M%S')}.webm")
    ffmpeg = ctx.try_tool("ffmpeg")
    done = False
    if ffmpeg:
        tmp = dest.with_name(dest.name + ".tmp.webm")
        r = subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-fflags", "+genpts", "-i", str(src), "-c", "copy", str(tmp)], capture_output=True, text=True, timeout=1800)
        if r.returncode == 0 and tmp.is_file() and tmp.stat().st_size > 0:
            os.replace(tmp, dest)
            src.unlink(missing_ok=True)
            done = True
        else:
            log_warn(f"remux failed, keeping the recording as uploaded: {r.stderr.strip()[-300:]}")
            tmp.unlink(missing_ok=True)
    if not done:
        shutil.move(str(src), str(dest))
    result: dict = {"file": str(dest)}
    ffprobe = ctx.try_tool("ffprobe")
    if ffprobe:
        result["seconds"] = probe_duration(ffprobe, str(dest))
    if ctx.settings.get("scanAfterRender") and ctx.stash:
        warning = scan_output(ctx, dest.parent)
        if warning:
            result["warning"] = warning
    log_info(f"Recording saved: {dest}")
    return result


def op_keyframes(ctx: Context, args: dict) -> list:
    path = str(args.get("path") or "")
    if not os.path.isfile(path):
        raise FileNotFoundError(path)
    # packet flags are enough (no decoding) -> fast even for long files
    r = subprocess.run([ctx.tool("ffprobe"), "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", path], capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip()[-500:])
    times = []
    for line in r.stdout.splitlines():
        parts = line.split(",")
        if len(parts) >= 2 and "K" in parts[1]:
            try:
                times.append(round(float(parts[0]), 3))
            except ValueError:
                pass
    return sorted(set(times))


GRAY_LONG_SIDE = 64  # the measuring picture of the motion analysis (Pepega's "tiny": 64 px on the long side)


def _probe_size(ffprobe: str, src: str, in_args: List[str]) -> tuple:
    r = subprocess.run([ffprobe, "-v", "error", *in_args, "-select_streams", "v:0", "-show_entries", "stream=width,height:stream_side_data=rotation", "-of", "json", src],
                       capture_output=True, text=True, timeout=60)
    streams = json.loads(r.stdout or "{}").get("streams") or []
    if not streams:
        raise RuntimeError((r.stderr or "no video stream").strip()[-300:])
    w, h = int(streams[0]["width"]), int(streams[0]["height"])
    rot = next((abs(int(sd.get("rotation", 0))) for sd in streams[0].get("side_data_list") or [] if "rotation" in sd), 0)
    return (h, w) if rot % 180 == 90 else (w, h)


def op_gray_frames(ctx: Context, args: dict) -> dict:
    """Small grayscale frames for the generator's motion analysis -> {key: {w, h, fps, t0, data(base64)} | {error}}.

    item: {key, fps, preview: true, sceneId}  -> Stash's scene preview (fetched over HTTP with the session)
          {key, fps, path, start, duration}   -> a stretch of a source file
    """
    items = as_json(args.get("items")) or []
    if len(items) > 32:
        raise ValueError("at most 32 items per call")
    ff, fp = ctx.tool("ffmpeg"), ctx.tool("ffprobe")

    def one(it: dict) -> tuple:
        key = str(it.get("key"))
        try:
            fps = max(1.0, min(60.0, float(it.get("fps") or 30)))
            in_args: List[str] = []
            seek: List[str] = []
            t0 = 0.0
            if it.get("preview"):
                sid = str(it.get("sceneId") or "")
                if not sid.isdigit() or not ctx.stash:
                    raise ValueError("a preview needs a scene id and the Stash connection")
                src = f"{ctx.stash.base}scene/{sid}/preview"
                if ctx.stash.cookie:
                    in_args = ["-headers", f"Cookie: {ctx.stash.cookie}\r\n"]
            else:
                src = str(it.get("path") or "")
                if not os.path.isfile(src):
                    raise FileNotFoundError(src)
                t0 = max(0.0, float(it.get("start") or 0))
                seek = ["-ss", f6(t0), "-t", f6(max(0.1, min(30.0, float(it.get("duration") or 2))))]
            w, h = _probe_size(fp, src, in_args)
            ow, oh = (GRAY_LONG_SIDE, max(8, round(GRAY_LONG_SIDE * h / w))) if w >= h else (max(8, round(GRAY_LONG_SIDE * w / h)), GRAY_LONG_SIDE)
            cmd = [ff, "-v", "error", "-nostdin", *in_args, *seek, "-i", src, "-an", "-vf", f"fps={fps:g},scale={ow}:{oh}:flags=area,format=gray", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"]
            r = subprocess.run(cmd, capture_output=True, timeout=180)
            if r.returncode != 0:
                raise RuntimeError(r.stderr.decode(errors="replace").strip()[-300:])
            data = r.stdout[: len(r.stdout) // (ow * oh) * (ow * oh)]
            return key, {"w": ow, "h": oh, "fps": fps, "t0": t0, "data": base64.b64encode(data).decode()}
        except Exception as e:  # one bad item must not sink the batch
            return key, {"error": str(e)}

    with ThreadPoolExecutor(max_workers=4) as pool:
        return dict(pool.map(one, items))


def op_ffmpeg_script(ctx: Context, args: dict) -> str:
    return ffmpeg_script(as_json(args.get("plan")), "cmd" if args.get("shell") == "cmd" else "sh", "ffmpeg")


def result_path(ctx: Context, render_id: str) -> Path:
    return ctx.work / "results" / f"{require_id(render_id, 'Render-ID')}.json"


def op_render_result(ctx: Context, args: dict) -> Optional[dict]:
    path = result_path(ctx, args.get("renderId"))
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None


def op_clear_cache(ctx: Context, args: dict) -> dict:
    n = 0
    if ctx.cache.is_dir():
        for f in ctx.cache.iterdir():
            if f.suffix in (".mov", ".mkv"):
                f.unlink()
                n += 1
    return {"removed": n}


def task_render(ctx: Context, args: dict) -> dict:
    if not args.get("plan"):
        raise ValueError("No render plan – renders are started from the PMV Creator page")
    plan = as_json(args["plan"])
    render_id = require_id(args.get("renderId") or f"render_{int(time.time())}", "Render-ID")
    status_file = result_path(ctx, render_id)
    atomic_write(status_file, json.dumps({"status": "running"}).encode())
    name = safe_filename(str(plan.get("projectName") or "pmv"), "pmv")
    dest = unique_path(ctx.renders, f"{name}_{time.strftime('%Y%m%d-%H%M%S')}.mp4")
    try:
        result = render_plan(plan, ctx.tool("ffmpeg"), dest, ctx.cache, ctx.work / render_id, int(ctx.settings.get("parallelJobs") or 2))
    except BaseException as e:
        msg = "Cancelled" if isinstance(e, Cancelled) else str(e)
        atomic_write(status_file, json.dumps({"status": "error", "error": msg}).encode())
        raise
    finally:
        shutil.rmtree(ctx.work / render_id, ignore_errors=True)
    if ctx.settings.get("clearCache"):
        op_clear_cache(ctx, {})
    if ctx.settings.get("scanAfterRender") and ctx.stash:
        warning = scan_output(ctx, dest.parent)
        if warning:
            result["warning"] = warning
    atomic_write(status_file, json.dumps({"status": "done", **result}).encode())
    log_info(f"Done: {result['file']}")
    return result


def scan_output(ctx: Context, folder: Path) -> Optional[str]:
    """Asks Stash to scan the output folder. Returns a warning when Stash would ignore it (outside every library)."""
    try:
        stashes = ctx.stash.call("query PmvLibraries { configuration { general { stashes { path } } } }")["configuration"]["general"]["stashes"]
        roots = [Path(s["path"]).resolve() for s in stashes if s.get("path")]
        target = folder.resolve()
        if roots and not any(target == r or r in target.parents for r in roots):
            msg = f"Output folder {folder} is not inside any Stash library – Stash will not scan it. Add a library or choose a folder inside one."
            log_warn(msg)
            return msg
        ctx.stash.call("mutation PmvScan($input: ScanMetadataInput!) { metadataScan(input: $input) }", {"input": {"paths": [str(folder)]}})
        log_info(f"Scan started: {folder}")
        return None
    except Exception as e:
        log_warn(f"The scan could not be started: {e}")
        return f"The scan could not be started: {e}"


# --------------------------------------------------------------------------------------- render on a PC
#
# A render helper runs on a user's PC (this file in "helper" mode). "On my PC" in the editor starts the usual
# Stash task, but with mode "pc" it only brokers: it writes a job file, waits until the helper has claimed it
# and mirrors the helper's progress into Stash's task list. The helper renders with the PC's FFmpeg and writes
# the file on the PC. Sources: the Stash path if the PC sees it, a path mapping ("/data/" -> "Y:\"), otherwise
# the scene's stream over HTTP – so nothing has to be set up besides the output folder.

HELPER_ONLINE = 90  # s since the last hello -> offline
CLAIM_TIMEOUT = 45  # s a queued job waits for its helper
STALL_TIMEOUT = 120  # s without progress from a running helper
BROKER_STALE = 8  # s without a heartbeat of the broker task -> the job is gone (task killed)


def helper_key(name: Any) -> str:
    key = re.sub(r"[^A-Za-z0-9_-]+", "_", str(name or "")).strip("_")[:64]
    if not key:
        raise ValueError("render helper name missing")
    return key


def _read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _helpers_dir(ctx: Context) -> Path:
    return ctx.base / "helpers"


def _jobs_dir(ctx: Context) -> Path:
    return ctx.base / "pc-jobs"


def _broker_alive(job: Path) -> bool:
    beat = job.with_suffix(".alive")
    try:
        return time.time() - beat.stat().st_mtime < BROKER_STALE
    except OSError:
        return False


def _drop_job(job: Path) -> None:
    for f in (job, job.with_suffix(".alive")):
        try:
            f.unlink()
        except OSError:
            pass


def op_helper_hello(ctx: Context, args: dict) -> dict:
    """The helper says hello every 30 s; gets its settings (output folder, path mappings) back."""
    info = as_json(args.get("info")) or {}
    path = _helpers_dir(ctx) / f"{helper_key(info.get('name'))}.json"
    cur = _read_json(path, {}) or {}
    for k in ("name", "version", "ffmpeg", "defaultOutput", "platform"):
        if info.get(k) is not None:
            cur[k] = str(info[k])[:300]
    serve = info.get("serve")
    if isinstance(serve, dict) and serve.get("url") and serve.get("token"):
        cur["serve"] = {"url": str(serve["url"])[:200], "token": str(serve["token"])[:100]}
    else:
        cur.pop("serve", None)  # an older helper or one started with --no-preview
    cur["lastSeen"] = time.time()
    cur.setdefault("config", {"outputDir": "", "mappings": []})
    atomic_write(path, json.dumps(cur).encode())
    return {"config": cur["config"]}


def op_helper_list(ctx: Context, args: dict) -> list:
    out = []
    d = _helpers_dir(ctx)
    if d.is_dir():
        for f in sorted(d.glob("*.json")):
            h = _read_json(f)
            if not isinstance(h, dict):
                continue
            h["id"] = f.stem
            h["online"] = time.time() - float(h.get("lastSeen") or 0) < HELPER_ONLINE
            h.setdefault("config", {"outputDir": "", "mappings": []})
            out.append(h)
    return out


def op_helper_config(ctx: Context, args: dict) -> dict:
    path = _helpers_dir(ctx) / f"{helper_key(args.get('name'))}.json"
    cur = _read_json(path)
    if not isinstance(cur, dict):
        raise FileNotFoundError("this render helper has never connected")
    cfg = as_json(args.get("config")) or {}
    maps = [{"from": str(m.get("from") or "").strip(), "to": str(m.get("to") or "").strip()} for m in (cfg.get("mappings") or []) if isinstance(m, dict)]
    cur["config"] = {"outputDir": str(cfg.get("outputDir") or "").strip()[:500], "mappings": [m for m in maps if m["from"] and m["to"]][:20]}
    atomic_write(path, json.dumps(cur).encode())
    return cur["config"]


def op_helper_claim(ctx: Context, args: dict) -> Optional[dict]:
    """The helper asks for work: the oldest queued job for it, now marked as running."""
    key = helper_key(args.get("name"))
    d = _jobs_dir(ctx)
    if not d.is_dir():
        return None
    for f in sorted(d.glob("*.json"), key=lambda p: p.stat().st_mtime):
        if not _broker_alive(f):
            _drop_job(f)  # its Stash task is gone
            continue
        job = _read_json(f)
        if not isinstance(job, dict) or job.get("status") != "queued" or job.get("helper") != key:
            continue
        job.update(status="running", claimed=time.time(), updated=time.time(), progress=0.0)
        atomic_write(f, json.dumps(job).encode())
        cfg = (_read_json(_helpers_dir(ctx) / f"{key}.json", {}) or {}).get("config") or {}
        return {"jobId": f.stem, "plan": job["plan"], "config": cfg}
    return None


def op_helper_progress(ctx: Context, args: dict) -> dict:
    """Progress/result from the helper. Answers cancel=True when the Stash task was stopped or is gone."""
    path = _jobs_dir(ctx) / f"{require_id(args.get('jobId'), 'job id')}.json"
    job = _read_json(path)
    if not isinstance(job, dict) or not _broker_alive(path):
        return {"cancel": True}
    job["updated"] = time.time()
    if args.get("progress") is not None:
        job["progress"] = max(0.0, min(1.0, float(args["progress"])))
    if args.get("message"):
        job["message"] = str(args["message"])[:300]
    status = args.get("status")
    if status == "done":
        job.update(status="done", result=as_json(args.get("result")) or {})
    elif status == "error":
        job.update(status="error", error=str(args.get("error") or "render failed on the PC")[:2000])
    atomic_write(path, json.dumps(job).encode())
    return {"cancel": bool(job.get("cancel"))}


def task_pc_render(ctx: Context, args: dict) -> dict:
    """Stash task for a render on a PC: queue the job, wait for the helper, mirror its progress."""
    plan = as_json(args.get("plan"))
    if not plan:
        raise ValueError("No render plan – renders are started from the PMV Creator page")
    validate_plan_light(plan)
    render_id = require_id(args.get("renderId") or f"render_{int(time.time())}", "Render-ID")
    helper = helper_key(args.get("helper"))
    status_file = result_path(ctx, render_id)
    atomic_write(status_file, json.dumps({"status": "running", "helper": helper}).encode())
    job_path = _jobs_dir(ctx) / f"{render_id}.json"
    beat = job_path.with_suffix(".alive")
    created = time.time()
    atomic_write(beat, b"1")
    atomic_write(job_path, json.dumps({"status": "queued", "helper": helper, "plan": plan, "created": created, "updated": created}).encode())
    log_info(f"Waiting for the render helper on {helper} …")
    last_msg = None
    try:
        while True:
            if _CANCELLED.is_set():
                raise Cancelled()
            os.utime(beat, None)
            time.sleep(1)
            job = _read_json(job_path) or {}
            status = job.get("status")
            if status == "queued" and time.time() - created > CLAIM_TIMEOUT:
                raise RuntimeError(f"The render helper on {helper} did not pick up the render – is it running on that PC?")
            if status == "running":
                if job.get("message") and job["message"] != last_msg:
                    last_msg = job["message"]
                    log_info(f"{helper}: {last_msg}")
                log_progress(float(job.get("progress") or 0))
                if time.time() - float(job.get("updated") or 0) > STALL_TIMEOUT:
                    raise RuntimeError(f"The render helper on {helper} stopped responding")
            elif status == "done":
                result = {**(job.get("result") or {}), "helper": helper}
                atomic_write(status_file, json.dumps({"status": "done", **result}).encode())
                log_info(f"Done on {helper}: {result.get('file')}")
                return result
            elif status == "error":
                raise RuntimeError(job.get("error") or "render failed on the PC")
    except BaseException as e:
        msg = "Cancelled" if isinstance(e, Cancelled) else str(e)
        atomic_write(status_file, json.dumps({"status": "error", "error": msg, "helper": helper}).encode())
        raise
    finally:
        _drop_job(job_path)  # the helper's next progress call answers "cancel" if it is still busy


# ---- the helper itself (runs on the PC)

_STOP = threading.Event()


class HelperClient:
    """GraphQL client of the helper: Stash address + optional API key (Stash with a login)."""

    def __init__(self, base: str, api_key: str = ""):
        self.base = base.rstrip("/")
        self.api_key = api_key
        self.ctx = ssl._create_unverified_context() if self.base.startswith("https") else None

    def gql(self, query: str, variables: Optional[dict] = None, timeout: float = 60.0) -> dict:
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if self.api_key:
            headers["ApiKey"] = self.api_key
        req = urllib.request.Request(self.base + "/graphql", data=json.dumps({"query": query, "variables": variables or {}}).encode(), headers=headers)
        with urllib.request.urlopen(req, timeout=timeout, context=self.ctx) as r:
            data = json.load(r)
        if data.get("errors"):
            raise RuntimeError("; ".join(e.get("message", "") for e in data["errors"]))
        return data["data"]

    def op(self, args: dict, timeout: float = 120.0) -> Any:
        q = "mutation PmvHelper($a: Map) { runPluginOperation(plugin_id: \"" + PLUGIN_ID + "\", args: $a) }"
        return self.gql(q, {"a": args}, timeout)["runPluginOperation"]


def best_mapping(path: str, mappings: List[Dict[str, str]]) -> Optional[tuple]:
    """(from, to) of the longest mapping prefix that matches the path."""
    best = None
    for m in mappings or []:
        src, dst = str(m.get("from") or ""), str(m.get("to") or "")
        if src and dst and path.startswith(src) and (best is None or len(src) > len(best[0])):
            best = (src, dst)
    return best


def map_path(path: str, mappings: List[Dict[str, str]]) -> Optional[str]:
    """Longest matching prefix wins; the rest of the path gets the separators of the target (Y:\\ -> backslashes)."""
    best = best_mapping(path, mappings)
    if not best:
        return None
    rest = path[len(best[0]):].lstrip("/\\")
    sep = "\\" if ("\\" in best[1] or re.match(r"^[A-Za-z]:", best[1])) else "/"
    return best[1].rstrip("/\\") + sep + rest.replace("/", sep).replace("\\", sep)


def find_ffmpeg() -> Optional[str]:
    found = shutil.which("ffmpeg")
    if found:
        return found
    exe = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
    home = Path.home()
    for cand in (home / ".stash" / exe, Path("C:/ffmpeg/bin") / exe, Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "WinGet" / "Links" / exe):
        if cand.is_file():
            return str(cand)
    return None


# ---- the helper's media server: the editor's preview plays the videos from the PC's own drive
#
# Stash's Content-Security-Policy lets <video> load only from Stash itself or from blob: URLs, while a plugin may
# add hosts to connect-src (pmv-creator.yml: http://*:9978-9981). So the editor fetch()es a fragmented MP4 from
# here and plays it through Media Source Extensions. The MP4 muxer always starts a stream at 0, so every stream
# begins exactly at ?start= (encoded here, frame-exact) and the player shifts it there (timestampOffset).

MEDIA_EXT = {".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi", ".wmv", ".flv", ".mpg", ".mpeg", ".ts", ".m2ts", ".3gp"}
SERVE_PORTS = (9978, 9979, 9980, 9981)  # must match the csp in pmv-creator.yml
LIVE_STREAMS = 6  # FFmpeg processes at the same time (two preview players, the scene player, seeks in flight)
_GONE = (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)


def lan_address(stash: str) -> str:
    """This PC's address on the way to Stash. A page from Stash reaches it without a "local network" prompt
    (same address space); with Stash on this PC it is 127.0.0.1."""
    host = urllib.parse.urlparse(stash).hostname or "127.0.0.1"
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect((host, 9))  # UDP: nothing is sent, only the route is looked up
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


def stream_command(ff: str, f: Path, start: float, audio: bool) -> List[str]:
    """Fragmented MP4 of the file from `start` on: H.264 with the long side at most 1280 px, a keyframe every
    30 frames and half-second fragments (quick to start), AAC stereo unless audio is off."""
    scale = "scale='if(gte(iw,ih),min(1280,iw),-2)':'if(gte(iw,ih),-2,min(1280,ih))'"
    cmd = [ff, "-hide_banner", "-loglevel", "error", "-ss", f"{max(0.0, start):.3f}", "-i", str(f), "-map", "0:v:0"]
    cmd += ["-map", "0:a:0?", "-c:a", "aac", "-b:a", "128k", "-ac", "2"] if audio else ["-an"]
    cmd += ["-vf", scale, "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-crf", "23", "-pix_fmt", "yuv420p", "-profile:v", "high", "-level:v", "4.1", "-g", "30"]
    return cmd + ["-sn", "-dn", "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-frag_duration", "500000", "pipe:1"]


class MediaServer:
    """Streams the videos of the mapped folders to the editor (see above). Every request needs the token."""

    def __init__(self, address: str, ff: str, token: str, ports: tuple = SERVE_PORTS):
        self.ff = ff
        self.token = token
        self.mappings: List[Dict[str, str]] = []
        self.live = threading.BoundedSemaphore(LIVE_STREAMS)
        handler = self._handler()
        httpd = None
        err: Optional[OSError] = None
        for port in ports:
            try:
                httpd = ThreadingHTTPServer((address, port), handler)
                break
            except OSError as e:
                err = e
        if httpd is None:
            raise OSError(f"ports {ports[0]}-{ports[-1]} are taken ({err})")
        self.httpd = httpd
        self.httpd.daemon_threads = True
        self.url = f"http://{address}:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def local_file(self, path: str) -> Optional[Path]:
        """The PC file of a Stash path – only inside a mapped folder, only media files that exist."""
        best = best_mapping(path, self.mappings)
        mapped = map_path(path, self.mappings)
        if not best or not mapped:
            return None
        try:
            root = Path(best[1]).resolve()
            f = Path(mapped).resolve()
        except (OSError, RuntimeError, ValueError):
            return None
        if f != root and root not in f.parents:  # ".." must not leave the folder
            return None
        return f if f.suffix.lower() in MEDIA_EXT and f.is_file() else None

    def _handler(self) -> type:
        server = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_: Any) -> None:  # the console belongs to the renders
                pass

            def _cors(self) -> None:
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Private-Network", "true")

            def _reply(self, code: int, body: bytes = b"", ctype: str = "text/plain; charset=utf-8") -> None:
                self.send_response(code)
                self._cors()
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if body:
                    self.wfile.write(body)

            def do_OPTIONS(self) -> None:
                self.send_response(204)
                self._cors()
                self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
                self.send_header("Content-Length", "0")
                self.end_headers()

            def do_GET(self) -> None:
                url = urllib.parse.urlparse(self.path)
                q = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
                if not hmac.compare_digest(q.get("k", "").encode(), server.token.encode()):
                    return self._reply(403, b"forbidden")
                if url.path == "/v1/ping":
                    info = {"ok": True, "version": VERSION, "folders": [m.get("from") for m in server.mappings]}
                    return self._reply(200, json.dumps(info).encode(), "application/json")
                if url.path != "/v1/stream":
                    return self._reply(404, b"unknown path")
                f = server.local_file(q.get("path", ""))
                if not f:
                    return self._reply(404, b"not on this PC")
                try:
                    self._stream(f, float(q.get("start") or 0), q.get("a") != "0")
                except _GONE:
                    pass  # the browser seeked elsewhere or closed the player – FFmpeg was stopped in _stream

            def _stream(self, f: Path, start: float, audio: bool) -> None:
                if not server.ff:
                    return self._reply(503, b"no FFmpeg")
                if not server.live.acquire(timeout=5):
                    return self._reply(503, b"busy")
                proc = None
                try:
                    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0  # type: ignore[attr-defined]
                    proc = subprocess.Popen(stream_command(server.ff, f, start, audio), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, creationflags=flags)
                    self.send_response(200)
                    self._cors()
                    self.send_header("Content-Type", "video/mp4")
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    while True:
                        chunk = proc.stdout.read1(1 << 16)  # type: ignore[union-attr]
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                finally:
                    if proc:
                        if proc.poll() is None:
                            proc.kill()
                        proc.wait()
                        proc.stdout.close()  # type: ignore[union-attr]
                    server.live.release()

        return Handler


def helper_dirs() -> Dict[str, Path]:
    root = Path(os.environ.get("LOCALAPPDATA") or (Path.home() / ".local" / "share")) / "PMV Creator"
    videos = Path.home() / "Videos"
    return {"cache": root / "cache", "work": root / "work", "output": (videos if videos.is_dir() else Path.home()) / "PMV Creator"}


def trim_cache(cache: Path, days: float = 14) -> None:
    if not cache.is_dir():
        return
    limit = time.time() - days * 86400
    for f in cache.glob("*" + PIECE_EXT):
        try:
            if f.stat().st_mtime < limit:
                f.unlink()
        except OSError:
            pass


def prepare_pc_plan(plan: Dict[str, Any], cfg: Dict[str, Any], base: str, api_key: str, stream_only: bool = False) -> Dict[str, Any]:
    """Sources the PC can read: the Stash path itself, a mapped path, or Stash's stream of the scene."""
    plan = json.loads(json.dumps(plan))
    mappings = cfg.get("mappings") or []
    http_args = ["-rw_timeout", "60000000"] + (["-headers", f"ApiKey: {api_key}\r\n"] if api_key else [])

    def resolve(src: Dict[str, Any], url: Optional[str]) -> None:
        path = str(src.get("path") or "")
        if not (stream_only and url):
            for cand in (path, map_path(path, mappings)):
                if cand and os.path.isfile(cand):
                    src["path"] = cand
                    return
        if not url:
            raise FileNotFoundError(f"{path} is not reachable from this PC – add a path mapping")
        src["path"] = url
        src["inputArgs"] = http_args

    for piece in plan.get("pieces") or []:
        for k in ("src", "a", "b"):
            s = piece.get(k)
            if s:
                resolve(s, f"{base}/scene/{s.get('sceneId')}/stream")
    music = plan.get("audio")
    if music and music.get("path"):
        resolve(music, base + music["url"] if str(music.get("url") or "").startswith("/") else None)
    return plan


def run_helper_job(job: Dict[str, Any], client: Any, ff: str, dirs: Dict[str, Path], jobs: int = 4, stream_only: bool = False, out_default: Optional[Path] = None) -> Dict[str, Any]:
    """One render on the PC with progress reports to Stash; returns the result (or raises)."""
    global LOG_HOOK
    job_id = job["jobId"]
    cfg = job.get("config") or {}
    plan = prepare_pc_plan(job["plan"], cfg, getattr(client, "base", ""), getattr(client, "api_key", ""), stream_only)
    out_dir = Path(os.path.expandvars(os.path.expanduser(cfg.get("outputDir") or ""))) if cfg.get("outputDir") else (out_default or dirs["output"])
    name = safe_filename(str(plan.get("projectName") or "pmv"), "pmv")
    dest = unique_path(out_dir, f"{name}_{time.strftime('%Y%m%d-%H%M%S')}.mp4")
    state: Dict[str, Any] = {"p": 0.0, "msg": None, "done": False}
    lock = threading.Lock()

    def hook(level: str, msg: str) -> None:
        with lock:
            if level == "p":
                try:
                    state["p"] = float(msg)
                except ValueError:
                    pass
            elif level in ("i", "w", "e"):
                state["msg"] = msg

    def report() -> None:
        while not state["done"]:
            time.sleep(2)
            if state["done"]:
                return
            with lock:
                p, msg = state["p"], state["msg"]
                state["msg"] = None
            try:
                r = client.op({"op": "helper_progress", "jobId": job_id, "progress": p, "message": msg})
                if r and r.get("cancel"):
                    print("  cancelled in Stash", flush=True)
                    _terminate_all()
                    return
            except Exception as e:  # a hiccup of the network must not stop the render
                print(f"  (progress not delivered: {e})", flush=True)

    print(f"Render {job_id}: {plan.get('projectName')} -> {dest}", flush=True)
    LOG_HOOK = hook
    reporter = threading.Thread(target=report, daemon=True)
    reporter.start()
    try:
        dirs["work"].mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="pmv-", dir=str(dirs["work"])) as work:
            result = render_plan(plan, ff, dest, dirs["cache"], Path(work), jobs)
    except BaseException as e:
        state["done"] = True
        LOG_HOOK = None
        msg = "Cancelled" if isinstance(e, Cancelled) else str(e)
        try:
            client.op({"op": "helper_progress", "jobId": job_id, "status": "error", "error": msg})
        except Exception:
            pass
        raise
    state["done"] = True
    LOG_HOOK = None
    client.op({"op": "helper_progress", "jobId": job_id, "status": "done", "progress": 1.0, "result": json.dumps(result)})
    print(f"Done: {result['file']} ({result['seconds']} s)", flush=True)
    return result


def helper_main(stash: str, api_key: str = "", name: str = "", ffmpeg: str = "", jobs: int = 0, stream_only: bool = False, pause: bool = False, preview: bool = True) -> int:
    """Long-running loop on the PC: say hello, watch Stash's task queue, claim and render jobs for this PC."""
    global PLAIN_LOG
    PLAIN_LOG = True
    for stream in (sys.stdout, sys.stderr):
        try:  # Windows consoles/pipes may be cp1252: arrows and dashes must not end the helper
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except Exception:
            pass
    stash = stash.strip().rstrip("/")
    if not re.match(r"^https?://", stash):
        stash = "http://" + stash
    signal.signal(signal.SIGINT, lambda *_: (_STOP.set(), _terminate_all()))
    client = HelperClient(stash, api_key)
    ff = ffmpeg or find_ffmpeg()
    name = name or socket.gethostname()
    dirs = helper_dirs()
    jobs = jobs or max(2, min(8, (os.cpu_count() or 4) // 2))
    print(f"PMV Creator render helper {VERSION} – {name}")
    print(f"Stash: {stash}")
    if not ff:
        print("FFmpeg was not found. Install it (e.g. 'winget install Gyan.FFmpeg') and start this helper again.")
        if pause:
            input("Press Enter to close …")
        return 2
    print(f"FFmpeg: {ff} · {jobs} parallel jobs")
    print(f"Default output folder: {dirs['output']} (change it in PMV Creator → Render → On my PC)")
    print("Waiting for renders – keep this window open (Ctrl+C stops the helper).", flush=True)
    trim_cache(dirs["cache"])
    info: Dict[str, Any] = {"name": name, "version": VERSION, "ffmpeg": ff, "defaultOutput": str(dirs["output"]), "platform": sys.platform}
    serve: Optional[MediaServer] = None
    if preview:
        try:
            serve = MediaServer(lan_address(stash), ff, secrets.token_urlsafe(18))
            info["serve"] = {"url": serve.url, "token": serve.token}
            print(f"Preview: the editor plays the videos of the mapped folders from this PC ({serve.url}).")
            print("  If Windows asks whether Python may use private networks: allow it.", flush=True)
        except OSError as e:
            print(f"Preview server not started ({e}) – the editor plays the videos from Stash.", flush=True)
    last_hello = 0.0
    last_claim = 0.0
    connected = None
    while not _STOP.is_set():
        try:
            if time.time() - last_hello > 30:
                hello = client.op({"op": "helper_hello", "info": info})
                if serve and isinstance(hello, dict):  # the path mappings may have changed in the editor
                    serve.mappings = (hello.get("config") or {}).get("mappings") or []
                last_hello = time.time()
                if connected is not True:
                    print("Connected to Stash.", flush=True)
                connected = True
            queue = client.gql("query PmvHelperQueue { jobQueue { status description } }")["jobQueue"] or []
            # a render task in the queue -> ask for work; otherwise only now and then (other Stash versions name tasks differently)
            if any("Render PMV" in (j.get("description") or "") for j in queue) or time.time() - last_claim > 20:
                last_claim = time.time()
                job = client.op({"op": "helper_claim", "name": name})
                if job:
                    try:
                        run_helper_job(job, client, ff, dirs, jobs, stream_only)
                    except Cancelled:
                        print("Render cancelled.", flush=True)
                    except Exception as e:
                        print(f"Render failed: {e}", flush=True)
                    finally:
                        if not _STOP.is_set():
                            _CANCELLED.clear()
                    last_hello = 0.0
        except Exception as e:
            if connected is not False:
                print(f"Stash not reachable ({e}) – trying again …", flush=True)
            connected = False
            _STOP.wait(8)
        _STOP.wait(2)
    print("Helper stopped.")
    return 0


OPS: Dict[str, Callable[[Context, dict], Any]] = {
    "ping": op_ping,
    "save_project": op_save_project,
    "load_project": op_load_project,
    "list_projects": op_list_projects,
    "delete_project": op_delete_project,
    "upload_chunk": op_upload_chunk,
    "import_audio": op_import_audio,
    "save_recording": op_save_recording,
    "keyframes": op_keyframes,
    "gray_frames": op_gray_frames,
    "ffmpeg_script": op_ffmpeg_script,
    "render_result": op_render_result,
    "clear_cache": op_clear_cache,
    "helper_hello": op_helper_hello,
    "helper_list": op_helper_list,
    "helper_config": op_helper_config,
    "helper_claim": op_helper_claim,
    "helper_progress": op_helper_progress,
}


# --------------------------------------------------------------------------------------- entry points

def plugin_main() -> int:
    raw = sys.stdin.read()
    payload = json.loads(raw) if raw.strip() else {}
    conn = payload.get("server_connection") or {}
    args = payload.get("args") or {}
    stash = Stash(conn) if conn else None
    ctx = Context(stash, load_settings(stash))
    try:
        if args.get("mode") == "render":
            result = task_render(ctx, args)
        elif args.get("mode") == "pc":
            result = task_pc_render(ctx, args)
        else:
            handler = OPS.get(str(args.get("op")))
            if not handler:
                raise ValueError(f"unknown operation: {args.get('op')!r}")
            result = handler(ctx, args)
        print(json.dumps({"output": result}))
        return 0
    except BaseException as e:  # Stash expects a JSON answer in every case
        msg = "Cancelled" if isinstance(e, Cancelled) else str(e)
        log_error(msg)
        print(json.dumps({"error": msg}))
        return 1


def cli_main(argv: List[str]) -> int:
    global PLAIN_LOG
    PLAIN_LOG = True
    ap = argparse.ArgumentParser(prog="pmv_backend.py", description="PMV Creator – render a render plan outside Stash")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("render", help="render a render plan (JSON)")
    r.add_argument("plan")
    r.add_argument("-o", "--output", help="output file (default: <project name>.mp4)")
    r.add_argument("--ffmpeg", default=None)
    r.add_argument("--jobs", type=int, default=2)
    r.add_argument("--cache", default=None, help="segment cache folder (default: ./.pmv-cache)")
    s = sub.add_parser("script", help="print an FFmpeg script for a render plan")
    s.add_argument("plan")
    s.add_argument("--shell", choices=["sh", "cmd"], default="sh")
    h = sub.add_parser("helper", help="render helper on a PC: renders started in the editor with \"On my PC\"")
    h.add_argument("--stash", default=HELPER_DEFAULTS.get("stash"), required=not HELPER_DEFAULTS.get("stash"), help="Stash address, e.g. http://192.168.1.10:9999")
    h.add_argument("--api-key", default=HELPER_DEFAULTS.get("apiKey", ""), help="Stash API key (only for Stash with a login)")
    h.add_argument("--name", default="", help="name of this PC in the editor (default: the computer name)")
    h.add_argument("--ffmpeg", default="")
    h.add_argument("--jobs", type=int, default=0, help="parallel FFmpeg jobs (default: half the CPU cores)")
    h.add_argument("--stream-only", action="store_true", help="always read the videos over Stash, never from a drive")
    h.add_argument("--no-preview", action="store_true", help="don't play the videos of the mapped folders in the editor's preview")
    a = ap.parse_args(argv)
    if a.cmd == "helper":
        return helper_main(a.stash, a.api_key, a.name, a.ffmpeg, a.jobs, a.stream_only, preview=not a.no_preview)
    plan = json.loads(Path(a.plan).read_text(encoding="utf-8"))
    if a.cmd == "script":
        sys.stdout.write(ffmpeg_script(plan, a.shell))
        return 0
    ff = a.ffmpeg or shutil.which("ffmpeg")
    if not ff:
        raise SystemExit("ffmpeg not found (pass --ffmpeg)")
    dest = Path(a.output or f"{safe_filename(plan.get('projectName', 'pmv'), 'pmv')}.mp4").resolve()
    cache = Path(a.cache or ".pmv-cache").resolve()
    with tempfile.TemporaryDirectory(prefix="pmv-") as work:
        result = render_plan(plan, ff, dest, cache, Path(work), a.jobs)
    print(json.dumps(result, indent=2))
    return 0


def main() -> int:
    signal.signal(signal.SIGTERM, _terminate_all)
    signal.signal(signal.SIGINT, _terminate_all)
    if len(sys.argv) > 1:
        return cli_main(sys.argv[1:])
    if HELPER_DEFAULTS.get("stash") and sys.stdin.isatty():
        # the downloaded helper, started with a double-click
        return helper_main(HELPER_DEFAULTS["stash"], HELPER_DEFAULTS.get("apiKey", ""), pause=True)
    return plugin_main()


if __name__ == "__main__":
    sys.exit(main())
