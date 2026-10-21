#!/usr/bin/env python3
"""PMV Creator backend.

Runs in two ways:
  * as Stash plugin (interface: raw) – JSON on stdin, {"output": ...} / {"error": ...} on stdout,
    log lines + progress on stderr using Stash's \\x01<level>\\x02 protocol;
  * as CLI for renders outside Stash:
        python pmv_backend.py render plan.json -o out.mp4 [--ffmpeg PATH] [--jobs 2]
        python pmv_backend.py script plan.json [--shell sh|cmd]

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
import json
import os
import re
import shlex
import shutil
import signal
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
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

VERSION = "0.3.3"
PLUGIN_ID = "pmv-creator"
PLAN_VERSION = 1
# Bump when piece_command() changes, invalidates cached pieces.
PIECE_VERSION = 3
# Intermediate container: MOV keeps an exact per-frame timescale (MKV rounds to 1 ms -> VFR jitter).
PIECE_EXT = ".mov"
PLUGIN_DIR = Path(__file__).resolve().parent.parent
MEDIA_URL = f"/plugin/{PLUGIN_ID}/assets/media/"

ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
XFADE = {
    "fade", "fadeblack", "fadewhite", "dissolve", "wipeleft", "wiperight", "slideleft",
    "slideright", "circleopen", "pixelize", "zoomin", "hblur", "radial",
}
X264_PRESETS = {"ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"}
NVENC_PRESET = {"ultrafast": "p1", "superfast": "p2", "veryfast": "p3", "faster": "p4", "fast": "p4", "medium": "p5", "slow": "p6", "slower": "p7", "veryslow": "p7"}

# --------------------------------------------------------------------------------------- logging

PLAIN_LOG = False  # CLI mode prints readable lines instead of Stash's protocol


def _log(level: str, msg: str) -> None:
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
        inputs.extend(["-ss", f6(max(0.0, float(src["in"]))), "-t", f6(dur * speed + 1.0), "-i", str(src["path"])])
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
        cmd += ["-ss", f6(float(music.get("sourceIn", 0))), "-i", str(music["path"])]
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
            if s and not os.path.isfile(s["path"]):
                missing.add(s["path"])
    music = plan.get("audio")
    if music and music.get("path") and not os.path.isfile(music["path"]):
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
    a = ap.parse_args(argv)
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
    return plugin_main()


if __name__ == "__main__":
    sys.exit(main())
