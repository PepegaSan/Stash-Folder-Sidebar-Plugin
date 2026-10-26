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
import array
import base64
import hashlib
import hmac
import json
import math
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

try:
    import warnings

    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        import audioop  # C-speed peaks; gone from Python 3.13 -> the array path in _peaks_of
except ImportError:  # pragma: no cover
    audioop = None  # type: ignore[assignment]

VERSION = "0.9.10"
PLUGIN_ID = "pmv-creator"
PLAN_VERSION = 1
# Bump when piece_command() changes, invalidates cached pieces.
PIECE_VERSION = 3
# Bump when the effects' filters change – only pieces with effects are rendered again.
FX_VERSION = 4
# Bump when the blurred copy behind fitted clips changes – only pieces that show one are rendered again.
BLUR_VERSION = 2
# Intermediate container: MOV keeps an exact per-frame timescale (MKV rounds to 1 ms -> VFR jitter).
PIECE_EXT = ".mov"
# A filtergraph longer than this goes into a file – effects make long expressions. FFmpeg >= 7 reads it with
# "-/filter_complex <file>" (the generic option-from-file syntax); before that only "-filter_complex_script"
# existed, which FFmpeg 7 deprecated and FFmpeg 8 builds drop ("Unrecognized option 'filter_complex_script'").
GRAPH_INLINE = 16000
CMD_GRAPH_INLINE = 6000  # the same for a Windows script (cmd.exe: 8191 characters per line)
PLUGIN_DIR = Path(__file__).resolve().parent.parent
MEDIA_URL = f"/plugin/{PLUGIN_ID}/assets/media/"

ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
# Filled in by the editor when this file is downloaded as render helper ("stash", "apiKey"); empty inside Stash.
HELPER_DEFAULTS: Dict[str, str] = {}
# URL scheme the downloaded helper registers for its Windows user, so “Start helper” in the editor can start it.
HELPER_PROTOCOL = "pmvhelper"
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


def libavutil_major(version_text: str) -> Optional[int]:
    """The libavutil major from `ffmpeg -version` output (58 = FFmpeg 6, 59 = FFmpeg 7, 60 = FFmpeg 8); None if absent."""
    m = re.search(r"^libavutil\s+(\d+)\.", version_text, re.M)
    return int(m.group(1)) if m else None


_GRAPH_OPTION: Dict[str, str] = {}


def graph_file_option(ff: str) -> str:
    """How this FFmpeg takes a filtergraph from a file: "-/filter_complex" from FFmpeg 7 on (libavutil 59),
    "-filter_complex_script" for older ones. Asked once per binary."""
    opt = _GRAPH_OPTION.get(ff)
    if opt is None:
        major = None
        try:
            flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0  # type: ignore[attr-defined]
            r = subprocess.run([ff, "-version"], capture_output=True, text=True, errors="replace", timeout=60, creationflags=flags)
            major = libavutil_major(r.stdout)
        except Exception:
            pass
        opt = _GRAPH_OPTION[ff] = "-/filter_complex" if major is not None and major >= 59 else "-filter_complex_script"
    return opt


def graph_option_rejected(error: str) -> bool:
    """FFmpeg knew neither way to read the graph from a file (an exotic build) – the graph has to go on the command line."""
    return "Unrecognized option" in error and "filter_complex" in error


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
            line = " ".join(shlex.quote(c) for c in cmd)
            raise RuntimeError(f"FFmpeg failed ({p.returncode}): {tail}\n$ {line if len(line) <= 4000 else line[:4000] + ' …'}")


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
    return fit_size(out.w, out.h, fit, tag)


def fit_size(w: int, h: int, fit: str, tag: str) -> str:
    """The picture fitted into w×h (the frame, or a field of a split screen)."""
    if fit == "contain":
        return f"scale={w}:{h}:force_original_aspect_ratio=decrease:flags=bicubic,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black"
    if fit == "blur":
        # whole picture centred over a blurred, slightly darkened copy that fills the frame (like the PMV Generator);
        # darkened by 15 % like the editor's preview (brightness(0.85)): in YUV, luma and chroma around their middle
        r = max(2, min(w, h) // 24)
        dim = "lutyuv=y='(val-16)*0.85+16':u='(val-128)*0.85+128':v='(val-128)*0.85+128'"
        return (
            f"split[{tag}bg][{tag}fg];"
            f"[{tag}bg]scale={w}:{h}:force_original_aspect_ratio=increase:flags=bilinear,crop={w}:{h},boxblur={r}:2,{dim}[{tag}bb];"
            f"[{tag}fg]scale={w}:{h}:force_original_aspect_ratio=decrease:flags=bicubic[{tag}ff];"
            f"[{tag}bb][{tag}ff]overlay=(W-w)/2:(H-h)/2:format=auto"
        )
    return f"scale={w}:{h}:force_original_aspect_ratio=increase:flags=bicubic,crop={w}:{h}"


def validate_layout(piece: Dict[str, Any], out: Out) -> tuple:
    """The groups, fields and dividers of a split screen piece – checked, as they end up in filtergraphs."""
    groups = piece.get("groups")
    fields, dividers = piece.get("fields"), piece.get("dividers") or []
    if not (isinstance(groups, list) and 1 <= len(groups) <= 4 and isinstance(fields, list) and 1 <= len(fields) <= 8 and isinstance(dividers, list) and len(dividers) <= 16):
        raise ValueError("split screen: malformed")

    def rect(r: Any, min_size: int) -> tuple:
        x, y, w, h = (int(v) for v in r)
        if not (0 <= x and 0 <= y and min_size <= w and min_size <= h and x + w <= out.w and y + h <= out.h):
            raise ValueError("split screen: rectangle out of the picture")
        return x, y, w, h

    checked = []
    for f in fields:
        x, y, w, h = rect(f.get("rect") or [], 2)
        if w % 2 or h % 2 or not 0 <= int(f.get("group", -1)) < len(groups):
            raise ValueError("split screen: malformed field")
        checked.append({"rect": (x, y, w, h), "group": int(f["group"]), "fx": bool(f.get("fx")), "fy": bool(f.get("fy")), "fit": norm_fit(f.get("fit"))})
    return groups, checked, [rect(d, 1) for d in dividers]


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


MIX_KEYS = ("rr", "rg", "rb", "gr", "gg", "gb", "br", "bg", "bb")


def validate_grade(grade: Any) -> Optional[Dict[str, Any]]:
    """The colour look of a plan (numbers worked out by the editor) – checked, as it ends up in a filtergraph."""
    if not grade:
        return None

    def nums(v: Any, n: int, lo: float, hi: float) -> List[float]:
        if not isinstance(v, list) or len(v) != n:
            raise ValueError("colour look: malformed")
        out = [float(x) for x in v]
        if not all(lo <= x <= hi for x in out):
            raise ValueError("colour look: value out of range")
        return out

    layers = grade.get("layers") or []
    if not isinstance(layers, list) or len(layers) > 4:
        raise ValueError("colour look: malformed")
    return {
        "matrix": nums(grade.get("matrix"), 9, -4.0, 4.0),
        "offset": nums(grade.get("offset"), 3, -2.0, 2.0),
        "layers": [nums(layer, 4, 0.0, 255.0) for layer in layers],
        "vignette": nums([grade.get("vignette") or 0], 1, 0.0, 1.0)[0],
    }


def grade_graph(grade: Dict[str, Any], out: Out, src: str, dst: str) -> str:
    """[src] → colour look → [dst]: one colour matrix (its offset rides on the alpha column), soft-light layers
    (tint, brightness), dark corners – the same chain the editor draws with CSS filters on its canvas."""
    mix = ":".join(f"{k}={v:.4f}" for k, v in zip(MIX_KEYS, grade["matrix"]))
    mix += ":" + ":".join(f"{c}a={v:.4f}" for c, v in zip("rgb", grade["offset"]))
    parts = [f"[{src}]format=gbrap,colorchannelmixer={mix}[{dst}0]"]
    cur = f"{dst}0"
    for i, (r, g, b, a) in enumerate(grade["layers"]):
        parts.append(f"color=c=0x{int(r):02x}{int(g):02x}{int(b):02x}:s={out.w}x{out.h}:r={out.rate},format=gbrap[{dst}t{i}]")
        parts.append(f"[{cur}][{dst}t{i}]blend=all_mode=softlight:all_opacity={min(1.0, a):.4f}:shortest=1[{dst}{i + 1}]")
        cur = f"{dst}{i + 1}"
    tail = ""
    if grade["vignette"] > 0:
        # cos⁴ fall-off of FFmpeg's vignette, matched to the editor's radial gradient (35 % … 75 % of the picture)
        angle = math.acos(max(0.0, 1 - 0.68 * grade["vignette"]) ** 0.25)
        tail = f",vignette=angle={angle:.4f}"
    parts.append(f"[{cur}]format=yuv420p{tail},setsar=1[{dst}]")
    return ";".join(parts)


# --------------------------------------------------------------------------------------- beat and drop effects
#
# The editor works out what the effects do in every frame (src/fx/timeline.ts) and sends it per piece: per-frame
# values where they change all the time (zoom, hue, echo, RGB split), frame windows where they are on or off, the
# tunnel and the words as events. Here they become filters; the constants must match the editor's.

FX_FONT_FILE = "Anton-Regular.ttf"  # assets/fonts/ – the editor draws its words with the same font
FONT_MAGIC = (b"\x00\x01\x00\x00", b"OTTO", b"true", b"ttcf")  # how a TrueType/OpenType file begins
REF_W = 1280  # the PMV Generator's sizes are pixels of a picture this wide
GLITCH_STRIPES = (0.02, 0.05, 0.035, 0.08, 0.012, 0.06)
GLITCH_SHIFT = 0.14
ECHO_ZOOM = 1.04
TUNNEL_SIZES = (0.74, 0.52, 0.34)
TEXT_SECONDS = 0.42
TEXT_FADE_AT = 0.3
FX_PINK = "0xff3e8a"


def hash_salt(i: int, k: int) -> float:
    return i * 78.233 + k * 37.719


def fx_hash(var: str, at: int, i: int, k: int) -> str:
    """The editor's fxHash(frame, i, k) as an FFmpeg expression of the frame variable (frame = var + at)."""
    return f"mod(sin(({var}+{at})*12.9898+{hash_salt(i, k)!r})*43758.5453,1)"


def fnum(x: float, digits: int = 6) -> str:
    """A number for an FFmpeg expression: short, never with an exponent."""
    s = f"{x:.{digits}f}".rstrip("0").rstrip(".")
    return "0" if s in ("", "-0") else s


def linear_runs(values: List[float], tol: float) -> List[tuple]:
    """Per-frame values as straight pieces (first frame, value there, slope) – each within `tol` of every value it covers."""
    out = []
    i, n = 0, len(values)
    while i < n:
        end, slope = i + 1, 0.0
        for j in range(i + 1, min(n, i + 257)):  # (a piece is at most 256 frames long: the search stays linear)
            s = (values[j] - values[i]) / (j - i)
            if any(abs(values[i] + s * (k - i) - values[k]) > tol for k in range(i + 1, j)):
                break
            end, slope = j + 1, s
        out.append((i, values[i], slope))
        i = end
    return out


def frame_expr(values: List[float], var: str, tol: float) -> str:
    """Per-frame values as an expression of the frame number: straight pieces in a binary if-tree."""
    runs = linear_runs(values, tol)

    def leaf(r: tuple) -> str:
        start, v, slope = r
        return fnum(v) if abs(slope) < 1e-12 else f"{fnum(v)}+{fnum(slope, 9)}*({var}-{start})"

    def tree(lo: int, hi: int) -> str:
        if hi - lo == 1:
            return leaf(runs[lo])
        mid = (lo + hi) // 2
        return f"if(lt({var},{runs[mid][0]}),{tree(lo, mid)},{tree(mid, hi)})"

    return tree(0, len(runs))


def windows_expr(windows: List[tuple]) -> str:
    """Frame windows [from, to) as a timeline `enable` expression."""
    return "+".join(f"between(n,{a},{b - 1})" for a, b in windows)


def value_windows(values: List[float]) -> List[tuple]:
    """Where per-frame values are not 0, as windows [from, to)."""
    out: List[list] = []
    for i, v in enumerate(values):
        if v > 0:
            if out and out[-1][1] == i:
                out[-1][1] = i + 1
            else:
                out.append([i, i + 1])
    return [tuple(w) for w in out]


def clean_word(word: Any) -> str:
    """A word for drawtext: letters, digits, spaces and ! ? . & # + - only (no quotes, colons or backslashes)."""
    w = re.sub(r"[^\w !?.&#+\-]|_", "", str(word or "")).strip()[:40]
    return w


def validate_fx(fx: Any, frames: int) -> Optional[Dict[str, Any]]:
    """The effects of a piece (numbers the editor worked out) – checked, as they end up in filtergraphs."""
    if not fx:
        return None
    if not isinstance(fx, dict):
        raise ValueError("effects: malformed")

    def per_frame(key: str, lo: float, hi: float) -> Optional[List[float]]:
        v = fx.get(key)
        if v is None:
            return None
        if not isinstance(v, list) or len(v) != frames:
            raise ValueError(f"effects: {key} malformed")
        out = [float(x) for x in v]
        if not all(lo <= x <= hi for x in out):
            raise ValueError(f"effects: {key} out of range")
        return out

    def windows(key: str) -> List[tuple]:
        v = fx.get(key) or []
        if not isinstance(v, list) or len(v) > frames:
            raise ValueError(f"effects: {key} malformed")
        out = []
        for w in v:
            a, b = int(w[0]), int(w[1])
            if not 0 <= a < b <= frames:
                raise ValueError(f"effects: {key} out of range")
            out.append((a, b) + tuple(float(x) for x in w[2:3]))
        return out

    shake = windows("shake")
    if any(not (len(w) == 3 and 0 < w[2] <= 0.2) for w in shake):
        raise ValueError("effects: shake out of range")
    def events(key: str, limit: int = 200) -> list:
        v = fx.get(key) or []
        if not isinstance(v, list) or len(v) > limit:
            raise ValueError(f"effects: {key} malformed")
        return v

    tunnel = []
    for x in events("tunnel"):
        start, n, dur = int(x[0]), int(x[1]), float(x[2])
        if not (-100000 < start < frames and 0 < n <= 10000 and 0 < dur <= 60):
            raise ValueError("effects: tunnel out of range")
        tunnel.append((start, n, dur))
    text = []
    for x in events("text"):
        word, start, size, n = clean_word(x.get("word")), int(x.get("from", 0)), float(x.get("size", 0)), int(x.get("frames", 0))
        if not (-100000 < start < frames and 0 < size <= 1 and 0 <= n <= 10000):
            raise ValueError("effects: text out of range")
        if word:
            text.append({"word": word, "from": start, "size": size, "frames": n})
    flash = []
    for x in events("flash", frames):
        k, a, rgb = int(x[0]), float(x[1]), [float(c) for c in x[2:5]]
        if not (0 <= k < frames and 0 <= a <= 1 and len(rgb) == 3 and all(0 <= c <= 255 for c in rgb)):
            raise ValueError("effects: flash out of range")
        flash.append((k, a, rgb))
    glow = [float(b) for b in events("glow", 100000)]
    if not all(-3600 <= b <= 36000 for b in glow):
        raise ValueError("effects: glow out of range")
    at = int(fx.get("at", 0))
    if not 0 <= at < 10 ** 8:
        raise ValueError("effects: at out of range")
    return {
        "at": at,
        "zoom": per_frame("zoom", 1.0, 4.0),
        "shake": shake,
        "hue": per_frame("hue", -1e8, 1e8),
        "echo": per_frame("echo", 0.0, 1.0),
        "tunnel": tunnel,
        "glitch": windows("glitch"),
        "rgb": per_frame("rgb", 0.0, 0.25),
        "invert": windows("invert"),
        "strobe": windows("strobe"),
        "text": text,
        "flash": sorted(flash),
        "glow": sorted(glow),
    }


def css_hue(deg: float) -> List[float]:
    """The CSS hue-rotate matrix (Filter Effects spec) – the editor's canvas turns the colours with it."""
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return [0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
            0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283,
            0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072]


def css_saturate(v: float) -> List[float]:
    return [0.213 + 0.787 * v, 0.715 - 0.715 * v, 0.072 - 0.072 * v, 0.213 - 0.213 * v, 0.715 + 0.285 * v,
            0.072 - 0.072 * v, 0.213 - 0.213 * v, 0.715 - 0.715 * v, 0.072 + 0.928 * v]


def mixer(m: List[float]) -> str:
    return ":".join(f"{k}={fnum(v, 4)}" for k, v in zip(MIX_KEYS, m))


def hue_chain(angles: List[float], out: Out, name: str) -> str:
    """Colour rush like the editor's CSS hue-rotate(θ) saturate(1.3), in RGB: the turn set every frame by sendcmd,
    then the saturation – each step clipped, like the canvas's filter chain (FFmpeg's own hue filter turns in YUV,
    which looks different)."""
    cmds = []
    for k in range(1, len(angles)):
        if angles[k] != angles[k - 1]:
            cmds.append(f"{fnum((k - 0.5) / out.fps)} " + ", ".join(f"colorchannelmixer@{name} {key} {fnum(v, 4)}" for key, v in zip(MIX_KEYS, css_hue(angles[k]))))
    send = f"sendcmd=c={ff_quote(';'.join(cmds))}," if cmds else ""
    return f"scale=flags=accurate_rnd,format=gbrp,{send}colorchannelmixer@{name}={mixer(css_hue(angles[0]))},colorchannelmixer={mixer(css_saturate(1.3))}"


def zoom_filter(fx: Dict[str, Any], out: Out, w: int, h: int) -> Optional[str]:
    """Zoom pulse and shaking of a picture w×h – the whole frame, or a field of a split screen – by zoompan per frame.
    The shift is a share of the frame's width (the same in every field); the crop window moves the other way and never
    leaves the picture."""
    if not (fx["zoom"] or fx["shake"]):
        return None
    z = frame_expr(fx["zoom"], "in", 2e-5) if fx["zoom"] else "1"
    x, y = "iw/2-iw/zoom/2", "ih/2-ih/zoom/2"
    if fx["shake"]:
        amp = "+".join(f"between(in,{a},{b - 1})*{fnum(s, 7)}" for a, b, s in fx["shake"])
        x += f"-({amp})*({fx_hash('in', fx['at'], 0, 1)}-0.5)*{out.w}/zoom"
        y += f"-({amp})*({fx_hash('in', fx['at'], 0, 2)}-0.5)*{out.w}/zoom"
    return f"zoompan=z='{z}':x='{x}':y='{y}':d=1:s={w}x{h}:fps={out.rate}"


def fx_pre_graph(fx: Dict[str, Any], out: Out, src: str, dst: str, zoom: bool = True) -> Optional[str]:
    """[src] → colour rush, zoom pulse and shaking → [dst] (before the colour look, like the editor's clip filters).
    `zoom`: False for a split screen – its fields zoom each on their own."""
    chain = [hue_chain(fx["hue"], out, f"{dst}h")] if fx["hue"] else []
    z = zoom_filter(fx, out, out.w, out.h) if zoom else None
    if z:
        chain.append(z)
    if fx["hue"]:
        chain.append("format=yuv420p")
    return f"[{src}]{','.join(chain)}[{dst}]" if chain else None


def ff_quote(value: str) -> str:
    """A value in single quotes for a filtergraph (a quote inside is closed, escaped and reopened)."""
    return "'" + value.replace("'", "'\\''") + "'"


def ff_path(path: str) -> str:
    """A file path as a filter option (drawtext's fontfile): forward slashes; colon and quote escaped for the option
    parser, then quoted for the filtergraph – FFmpeg reads it through both."""
    return ff_quote(path.replace("\\", "/").replace("'", "\\'").replace(":", "\\:"))


def glow_expr(beats: List[float]) -> str:
    """The dividers' glow at time T (geq): 0.9 · e^(−7 s) for s seconds since the last beat, nothing below 0.05 – as glowAt().
    The last beat comes from a balanced if-tree: FFmpeg's expressions nest only about 100 deep (a minute of beats)."""

    def last(lo: int, hi: int) -> str:
        # the last of beats[lo:hi] at or before T (the first one when T is earlier – then nothing glows)
        if hi - lo == 1:
            return fnum(beats[lo])
        mid = (lo + hi) // 2
        return f"if(lt(T,{fnum(beats[mid])}),{last(lo, mid)},{last(mid, hi)})"

    return f"st(0,T-({last(0, len(beats))}));st(1,0.9*exp(-7*ld(0)));ld(1)*gte(ld(0),0)*gt(ld(1),0.05)"


def fx_post_graph(fx: Dict[str, Any], out: Out, src: str, dst: str, font: Optional[str], dividers: Optional[List[tuple]] = None) -> Optional[str]:
    """[src] → split screen dividers (glowing on the beat), echo, tunnel, glitch, RGB split, negative, flash, strobe,
    words → [dst] – after the colour look, in this order like the editor's canvas, and like it in RGB."""
    words = fx["text"] if font else []
    if not (dividers or any(fx["echo"] or []) or fx["tunnel"] or fx["glitch"] or any(fx["rgb"] or []) or fx["invert"] or fx["flash"] or fx["strobe"] or words):
        return None
    W, H, fps = out.w, out.h, out.fps
    # into planar RGB with exact rounding (the fast default loses ~1.5 of 255 levels, a piece would come out darker)
    parts = [f"[{src}]scale=flags=accurate_rnd,format=gbrp[{dst}0]"]
    count = 0
    cur = f"{dst}0"

    def label() -> str:
        nonlocal count
        count += 1
        return f"{dst}{count}"

    for i, (x, y, w, h) in enumerate(dividers or []):
        # a dark line along the field edge, glowing pink on every beat where the dividers glow
        layers = [f"color=c=0x0a0309:s={w}x{h}:r={out.rate},format=gbrp"]
        if fx["glow"]:
            layers.append(f"color=c=0xff3e8a:s={w}x{h}:r={out.rate},format=rgba,geq=r=255:g=62:b=138:a='255*({glow_expr(fx['glow'])})'")
        for k, layer in enumerate(layers):
            parts.append(f"{layer}[{dst}d{i}l{k}]")
            nxt = label()
            parts.append(f"[{cur}][{dst}d{i}l{k}]overlay={x}:{y}:format=gbrp:shortest=1[{nxt}]")
            cur = nxt

    def at_frame(k: int) -> str:
        """sendcmd time of local frame k: half a frame early, so the value is set when the frame arrives."""
        return fnum((k - 0.5) / fps)

    echo = fx["echo"] or []
    if any(v > 0 for v in echo):
        # the frames before as ghosts, enlarged; per frame α the weights (1-α), α(1-α), α² (they add up to 1)
        weights = lambda v: "|".join(fnum(w, 4) for w in (1 - v, v * (1 - v), v * v))  # noqa: E731
        e = label()
        parts.append(f"[{cur}]split=3[{e}a][{e}b][{e}c]")
        for i, s in ((1, "b"), (2, "c")):
            z = ECHO_ZOOM ** i
            parts.append(f"[{e}{s}]tpad=start={i}:start_mode=clone,scale={round(W * z)}:{round(H * z)},crop={W}:{H}[{e}g{i}]")
        main = f"{e}a"
        cmds = [f"{at_frame(k)} mix@{e} weights {weights(echo[k])}" for k in range(1, len(echo)) if echo[k] != echo[k - 1] and echo[k] > 0]
        if cmds:
            parts.append(f"[{main}]sendcmd=c={ff_quote(';'.join(cmds))}[{e}s]")
            main = f"{e}s"
        first = next(v for v in echo if v > 0)
        cur = label()
        parts.append(f"[{main}][{e}g1][{e}g2]mix@{e}=inputs=3:weights='{weights(first)}':duration=first:enable='{windows_expr(value_windows(echo))}'[{cur}]")

    for start, n, dur in fx["tunnel"]:
        # three copies of the picture inside it, each with a pink frame, fading from 1 to 0.1 over the tunnel
        win = windows_expr([(max(0, start), start + n)])
        a0 = 1 - 0.9 * max(0, -start) / (fps * dur)  # began in an earlier piece: as far faded as it is there
        fade = (f"colorchannelmixer=aa={fnum(a0, 5)}," if start < 0 else "") + f"fade=t=out:st={fnum(max(0, start) / fps)}:d={fnum(a0 * dur / 0.9)}:alpha=1"
        b = max(1, round(3 * W / REF_W))
        t = label()
        parts.append(f"[{cur}]split=4[{t}m]" + "".join(f"[{t}c{i}]" for i in range(len(TUNNEL_SIZES))))
        cur = f"{t}m"
        for i, f in enumerate(TUNNEL_SIZES):
            w, h = round(W * f), round(H * f)
            parts.append(f"[{t}c{i}]scale={w}:{h},pad={w + 2 * b}:{h + 2 * b}:{b}:{b}:color={FX_PINK},format=gbrap,{fade}[{t}k{i}]")
            nxt = label()
            parts.append(f"[{cur}][{t}k{i}]overlay=(W-w)/2:(H-h)/2:format=gbrp:enable='{win}'[{nxt}]")
            cur = nxt

    if fx["glitch"]:
        # stripes of the picture slip sideways, another pattern every frame; then a pink shimmer
        win = windows_expr(fx["glitch"])
        g = label()
        parts.append(f"[{cur}]split={len(GLITCH_STRIPES) + 1}[{g}m]" + "".join(f"[{g}s{i}]" for i in range(len(GLITCH_STRIPES))))
        cur = f"{g}m"
        for i, share in enumerate(GLITCH_STRIPES):
            sh = max(2, round(share * H))
            # the frame from its time: overlay counts its "n" from 1, crop from 0 – both must take the same stripe
            frame = f"round(t*{out.rate})"
            y = f"floor({H - sh}*{fx_hash(frame, fx['at'], i + 1, 1)})"
            x = f"({fx_hash(frame, fx['at'], i + 1, 2)}-0.5)*{fnum(GLITCH_SHIFT * W)}"
            parts.append(f"[{g}s{i}]crop={W}:{sh}:0:'{y}'[{g}c{i}]")
            nxt = label()
            parts.append(f"[{cur}][{g}c{i}]overlay=x='{x}':y='{y}':format=gbrp:enable='{win}'[{nxt}]")
            cur = nxt
        parts.append(f"color=c={FX_PINK}:s={W}x{H}:r={out.rate},format=gbrp[{g}p]")
        nxt = label()
        parts.append(f"[{cur}][{g}p]blend=all_mode=screen:all_opacity=0.16:shortest=1:enable='{win}'[{nxt}]")
        cur = nxt

    chain: List[str] = []
    px = [round(v * W) for v in fx["rgb"] or []]
    if any(v > 0 for v in px):
        # red one way, cyan the other: rgbashift in whole pixels, set per frame by sendcmd
        name = f"rgbashift@{dst}r"
        shift = lambda v: f"{name} rh {-v}, {name} gh {v}, {name} bh {v}"  # noqa: E731
        cmds = [f"{at_frame(k)} {shift(px[k])}" for k in range(1, len(px)) if px[k] != px[k - 1] and px[k] > 0]
        if cmds:
            chain.append(f"sendcmd=c={ff_quote(';'.join(cmds))}")
        first = next(v for v in px if v > 0)
        chain.append(f"{name}=rh={-first}:gh={first}:bh={first}:enable='{windows_expr(value_windows(px))}'")
    if fx["invert"]:
        chain.append(f"negate=enable='{windows_expr(fx['invert'])}'")
    if fx["flash"]:
        # a flash fading out: (1 − a)·picture + a·colour per frame, the colour through the alpha column (alpha = 1)
        name = f"colorchannelmixer@{dst}f"
        mix = lambda a, c: [("rr", 1 - a), ("gg", 1 - a), ("bb", 1 - a), ("ra", a * c[0] / 255), ("ga", a * c[1] / 255), ("ba", a * c[2] / 255)]  # noqa: E731
        k0, a0, c0 = fx["flash"][0]
        cmds = [f"{at_frame(k)} " + ", ".join(f"{name} {key} {fnum(v, 4)}" for key, v in mix(a, c)) for k, a, c in fx["flash"][1:]]
        chain += ["format=gbrap", *([f"sendcmd=c={ff_quote(';'.join(cmds))}"] if cmds else [])]
        on = [0] * (fx["flash"][-1][0] + 1)
        for k, _, _ in fx["flash"]:
            on[k] = 1
        chain.append(f"{name}=" + ":".join(f"{key}={fnum(v, 4)}" for key, v in mix(a0, c0)) + f":enable='{windows_expr(value_windows(on))}'")
        chain.append("format=gbrp")
    if fx["strobe"]:
        flash = "val*0.08+234.6"  # white at 92 %
        chain.append(f"lutrgb=r='{flash}':g='{flash}':b='{flash}':enable='{windows_expr(fx['strobe'])}'")
    if chain:
        nxt = label()
        parts.append(f"[{cur}]{','.join(chain)}[{nxt}]")
        cur = nxt

    for ev in words:
        # the word on a transparent layer of its own: punched in, slanted, tilted, fading out at the end
        size = max(8, round(ev["size"] * H))
        b = max(1, round(0.05 * size))
        sk = 0.18 * H / 2  # slanted like a sound effect: the top edge moves right, the bottom edge left
        # the layer's clock counts frames (time base 1/rate): it starts this many frames into the piece or the word
        skip, shift = max(0, -ev["from"]), max(0, ev["from"])
        # a word ends when the next one comes in (the editor shows the newest)
        until = ev["frames"] or math.ceil(TEXT_SECONDS * fps - 1e-6)
        w = label()
        parts.append(
            f"color=c=black@0:s={W}x{H}:r={out.rate}:d={fnum(TEXT_SECONDS)},format=rgba,"
            # a pink copy of the letters a little down right, then the letters with their dark edge over it (drawtext's
            # own shadow would include the edge – thicker than the editor's)
            f"drawtext=fontfile={ff_path(font or '')}:text={ff_quote(ev['word'])}:expansion=none:fontsize={size}:fontcolor={FX_PINK}:x=(w-text_w)/2+{b}:y=(h-text_h)/2+{b},"
            f"drawtext=fontfile={ff_path(font or '')}:text={ff_quote(ev['word'])}:expansion=none:fontsize={size}:fontcolor=0xfbeff4:"
            f"borderw={b}:bordercolor=0x230f1f:x=(w-text_w)/2:y=(h-text_h)/2,"
            f"zoompan=z='1+0.35*exp(-18*in/{fnum(fps)})':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s={W}x{H}:fps={out.rate},"
            f"perspective=x0={fnum(sk, 2)}:y0=0:x1={fnum(W + sk, 2)}:y1=0:x2={fnum(-sk, 2)}:y2={H}:x3={fnum(W - sk, 2)}:y3={H}:sense=destination:eval=init,"
            f"rotate=-0.1:c=none,fade=t=out:st={fnum(TEXT_FADE_AT)}:d={fnum(TEXT_SECONDS - TEXT_FADE_AT)}:alpha=1,"
            f"trim=start_frame={skip}:end_frame={until},setpts=PTS-STARTPTS+{shift}[{w}t]"
        )
        nxt = label()
        parts.append(f"[{cur}][{w}t]overlay=eof_action=pass:format=gbrp[{nxt}]")
        cur = nxt

    parts.append(f"[{cur}]format=yuv420p,setsar=1[{dst}]")
    return ";".join(parts)


def piece_command(ff: str, piece: Dict[str, Any], out: Out, clip_audio: bool, dest: str, grade: Optional[Dict[str, Any]] = None,
                  font: Optional[str] = None, graph_file: Optional[str] = None) -> List[str]:
    """One piece -> one FFmpeg call. `font`: the words' font file; `graph_file`: where a long filtergraph goes (Windows
    allows 32 767 characters per command line) – without it the graph stays inline."""
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

    def split_screen() -> None:
        """Every group's clip once, fitted into each of its fields (mirrored, zoomed there), the fields stacked; the
        groups' sound mixed."""
        nonlocal n_inputs
        groups, fields, _ = validate_layout(piece, out)
        sounds: List[str] = []
        for g, src in enumerate(groups):
            mine = [k for k, f in enumerate(fields) if f["group"] == g]
            if not mine:
                continue
            if src is None:
                for k in mine:
                    _, _, w, h = fields[k]["rect"]
                    graph.append(f"color=c=black:s={w}x{h}:r={out.rate}:d={f6(dur + 1 / out.fps)},format=yuv420p,setsar=1,trim=end_frame={frames}[f{k}]")
                continue
            speed = float(src.get("speed", 1.0))
            if not 0.05 <= speed <= 20:
                raise ValueError(f"speed out of range: {speed}")
            idx = n_inputs
            n_inputs += 1
            inputs.extend([*input_args(src), "-ss", f6(max(0.0, float(src["in"]))), "-t", f6(dur * speed + 1.0), "-i", str(src["path"])])
            copies = "".join(f"[g{g}c{k}]" for k in mine)
            graph.append(
                f"[{idx}:v:0]setpts=(PTS-STARTPTS)/{speed:.6f},fps={out.rate},tpad=stop_mode=clone:stop_duration={f6(dur)},trim=end_frame={frames},setpts=PTS-STARTPTS"
                + (f",split={len(mine)}{copies}" if len(mine) > 1 else copies)
            )
            for k in mine:
                f = fields[k]
                _, _, w, h = f["rect"]
                chain = [fit_size(w, h, f["fit"], f"f{k}"), "setsar=1", "format=yuv420p"] + (["hflip"] if f["fx"] else []) + (["vflip"] if f["fy"] else [])
                zoom = zoom_filter(fx, out, w, h) if fx else None
                graph.append(f"[g{g}c{k}]{','.join(chain + ([zoom] if zoom else []))}[f{k}]")
            if clip_audio:
                volume = float(src.get("volume", 0))
                if src.get("hasAudio") and volume > 0:
                    chain = ["asetpts=PTS-STARTPTS", *atempo_chain(speed), "aresample=48000", "aformat=sample_fmts=fltp:channel_layouts=stereo",
                             f"volume={volume:.4f}", "apad", f"atrim=0:{f6(dur)}", "asetpts=PTS-STARTPTS"]
                    graph.append(f"[{idx}:a:0]{','.join(chain)}[ag{g}]")
                    sounds.append(f"[ag{g}]")
        layout = "|".join(f"{f['rect'][0]}_{f['rect'][1]}" for f in fields)
        graph.append("".join(f"[f{k}]" for k in range(len(fields))) + f"xstack=inputs={len(fields)}:layout={layout}:fill=black,setsar=1[v]")
        if clip_audio:
            if not sounds:
                graph.append(f"anullsrc=r=48000:cl=stereo,atrim=0:{f6(dur)}[a]")
            elif len(sounds) == 1:
                graph.append(f"{sounds[0]}anull[a]")
            else:
                graph.append(f"{''.join(sounds)}amix=inputs={len(sounds)}:duration=longest:normalize=0,atrim=0:{f6(dur)}[a]")

    kind = piece.get("kind")
    fx = validate_fx(piece.get("fx"), frames)
    if kind == "layout" and not fx:
        fx = validate_fx({"at": 0}, frames)  # (the dividers are drawn in the effects' chain)
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
    elif kind == "layout":
        split_screen()
    else:
        raise ValueError(f"unknown segment type: {kind!r}")
    vout = "v"
    pre = fx_pre_graph(fx, out, vout, "vz", zoom=kind != "layout") if fx else None
    if pre:
        graph.append(pre)
        vout = "vz"
    if grade and kind != "black":  # black stays black
        graph.append(grade_graph(grade, out, vout, "vg"))
        vout = "vg"
    post = fx_post_graph(fx, out, vout, "vf", font, validate_layout(piece, out)[2] if kind == "layout" else None) if fx else None
    if post:
        graph.append(post)
        vout = "vf"

    text = ";".join(graph)
    if graph_file and len(text) > GRAPH_INLINE:
        Path(graph_file).write_text(text, encoding="utf-8")
        filters = [graph_file_option(ff), graph_file]
    else:
        filters = ["-filter_complex", text]
    cmd = [ff, "-hide_banner", "-nostdin", "-y", "-loglevel", "error", *inputs, *filters, "-map", f"[{vout}]"]
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


def piece_sources(piece: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The sources a piece reads: its clip, both sides of a transition, or every field group of a split screen."""
    found = [piece.get(k) for k in ("src", "a", "b")] + list(piece.get("groups") or [])
    return [s for s in found if isinstance(s, dict)]


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
        validate_fx(p.get("fx"), int(p["frames"]))
        for s in piece_sources(p):
            if not is_url(s["path"]) and not os.path.isfile(s["path"]):
                missing.add(s["path"])
    music = plan.get("audio")
    if music and music.get("path") and not is_url(music["path"]) and not os.path.isfile(music["path"]):
        missing.add(music["path"])
    if missing:
        raise FileNotFoundError("files not found:\n" + "\n".join(sorted(missing)))
    return out


def piece_key(piece: Dict[str, Any], plan: Dict[str, Any], font_id: str = "") -> str:
    o = plan["output"]
    relevant = {k: o.get(k) for k in ("width", "height", "fps", "fit", "videoCodec", "crf", "preset")}
    key: Dict[str, Any] = {"v": PIECE_VERSION, "piece": piece, "out": relevant, "clipAudio": bool(plan.get("clipAudio"))}
    if plan.get("grade") and piece.get("kind") != "black":
        key["grade"] = plan["grade"]  # absent without a look: caches from before stay valid
    if piece.get("fx"):
        key["fx"] = FX_VERSION  # (the effects themselves are part of the piece)
        if piece["fx"].get("text"):
            key["font"] = font_id  # rendered without the font, words are missing – not to be reused once it is there
    fits = [s.get("fit") for s in piece_sources(piece)] + [f.get("fit") for f in piece.get("fields") or [] if isinstance(f, dict)]
    if "blur" in fits:
        key["blur"] = BLUR_VERSION
    blob = json.dumps(key, sort_keys=True)
    return hashlib.sha1(blob.encode()).hexdigest()


def concat_entry(path: str, frames: int, out: Out) -> str:
    # explicit durations keep the timestamps frame-exact instead of trusting container durations
    return "file '" + path.replace("'", "'\\''") + "'\nduration " + f6(out.seconds(frames))


def plan_has_words(plan: Dict[str, Any]) -> bool:
    return any((p.get("fx") or {}).get("text") for p in plan.get("pieces") or [])


def render_plan(plan: Dict[str, Any], ff: str, dest: Path, cache_dir: Path, work_dir: Path, jobs: int = 2, font: Optional[str] = None) -> Dict[str, Any]:
    """`font`: the words' font file (default: the plugin's assets/fonts/)."""
    started = time.time()
    out = validate_plan(plan)
    clip_audio = bool(plan.get("clipAudio"))
    grade = validate_grade(plan.get("grade"))
    pieces = plan["pieces"]
    font = font or str(PLUGIN_DIR / "assets" / "fonts" / FX_FONT_FILE)
    warning = None
    if not os.path.isfile(font):
        if plan_has_words(plan):
            warning = f"The font for the words ({FX_FONT_FILE}) is missing – rendered without them"
            log_warn(warning)
        font = None
    font_id = hashlib.sha1(Path(font).read_bytes()).hexdigest()[:12] if font else "none"
    cache_dir.mkdir(parents=True, exist_ok=True)
    work_dir.mkdir(parents=True, exist_ok=True)
    dest.parent.mkdir(parents=True, exist_ok=True)

    paths = [cache_dir / f"{piece_key(p, plan, font_id)}{PIECE_EXT}" for p in pieces]
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
        graph_file = str(work_dir / f"{path.stem}.graph")
        try:
            run_ffmpeg(piece_command(ff, piece, out, clip_audio, str(tmp), grade, font, graph_file))
        except RuntimeError as e:
            if not graph_option_rejected(str(e)) or not os.path.isfile(graph_file):
                raise
            log_warn(f"FFmpeg does not take the filtergraph from a file ({graph_file_option(ff)}) – passing it on the command line")
            run_ffmpeg(piece_command(ff, piece, out, clip_audio, str(tmp), grade, font))
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
    return {"file": str(dest), "pieces": len(pieces), "cached": cached, "seconds": round(time.time() - started, 2), **({"warning": warning} if warning else {})}


def ffmpeg_script(plan: Dict[str, Any], shell: str = "sh", ff: str = "ffmpeg") -> str:
    """Self-contained script with the same commands the renderer runs (pieces/ + output.mp4)."""
    out = validate_plan_light(plan)
    clip_audio = bool(plan.get("clipAudio"))
    pieces = plan["pieces"]
    names = [f"pieces/{i:04d}{PIECE_EXT}" for i in range(len(pieces))]
    grade = validate_grade(plan.get("grade"))
    words = plan_has_words(plan)
    font = f"fonts/{FX_FONT_FILE}" if words else None
    cmds = [piece_command(ff, p, out, clip_audio, n, grade, font) for p, n in zip(pieces, names)]
    note = f"the words need fonts/{FX_FONT_FILE} next to this script (the plugin has it in assets/fonts/)"
    final = final_command(ff, plan, out, "pieces.ffconcat", f"{safe_filename(plan.get('projectName', 'pmv'), 'pmv')}.mp4", progress=False)
    # entries are relative to the list file, which lives next to pieces/
    listing = ["ffconcat version 1.0", *[line for p, n in zip(pieces, names) for line in concat_entry(n, int(p["frames"]), out).split("\n")]]
    if shell == "cmd":
        q = lambda a: '"' + a.replace('"', '""').replace("%", "%%") + '"' if re.search(r'[\s;&|<>^()"%,=\[\]]', a) else a.replace("%", "%%")  # noqa: E731
        lines = ["@echo off", *([f"rem {note}"] if words else []), "setlocal", "cd /d \"%~dp0\"", "if not exist pieces mkdir pieces", "(", *[f"echo {line}" for line in listing], ") > pieces.ffconcat"]
        if any(len(c[c.index("-filter_complex") + 1]) > CMD_GRAPH_INLINE for c in cmds):
            # long filtergraphs come from files: FFmpeg >= 7 (libavutil 59+) reads them with -/filter_complex, older ones
            # only with -filter_complex_script – the script asks the FFmpeg it runs with
            lines += ['set "FCS=-filter_complex_script"', f"{q(ff)} -version > pieces\\ffversion.txt 2>nul",
                      'findstr /r /c:"^libavutil *59\\." /c:"^libavutil *[6-9][0-9]\\." pieces\\ffversion.txt >nul && set "FCS=-/filter_complex"']
        fcs = "\x00FCS"  # stands in for %FCS% while the arguments are quoted (q would double the percent signs)
        for i, c in enumerate(cmds):
            k = c.index("-filter_complex")
            if len(c[k + 1]) > CMD_GRAPH_INLINE:
                # cmd.exe reads at most 8191 characters per line: a long filtergraph goes into a file, written as base64
                # lines (nothing in them that cmd would interpret) and decoded by certutil, which every Windows has
                b64 = base64.b64encode(c[k + 1].encode("utf-8")).decode()
                stem = f"pieces\\{i:04d}"
                lines += ["(", *[f"echo({b64[j:j + 76]}" for j in range(0, len(b64), 76)], f") > {stem}.b64", f"certutil -f -decode {stem}.b64 {stem}.graph >nul || exit /b 1"]
                c = [*c[:k], fcs, f"{stem}.graph", *c[k + 2:]]
            lines.append(" ".join(q(a) for a in c).replace(fcs, "%FCS%") + " || exit /b 1")
        lines.append(" ".join(q(a) for a in final))
        return "\r\n".join(lines) + "\r\n"
    lines = ["#!/usr/bin/env bash", "# generated by PMV Creator", *([f"# {note}"] if words else []), "set -euo pipefail", 'cd "$(dirname "$0")"', "mkdir -p pieces", "cat > pieces.ffconcat <<'EOF'", *listing, "EOF"]
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
        raise ValueError("project missing")
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


SONG_EXT = {".mp3", ".m4a", ".aac", ".wav", ".flac", ".ogg", ".oga", ".opus", ".wma", ".aif", ".aiff"}


def op_list_media(ctx: Context, args: dict) -> list:
    """The song library: songs uploaded (or extracted) before, in the media folder – newest first."""
    out = []
    if ctx.media.is_dir():
        for f in ctx.media.iterdir():
            if f.is_file() and f.suffix.lower() in SONG_EXT and not f.name.startswith("."):
                st = f.stat()
                out.append({"name": f.name, "path": str(f), "url": MEDIA_URL + urllib.parse.quote(f.name), "size": st.st_size, "mtime": st.st_mtime})
    return sorted(out, key=lambda x: x["mtime"], reverse=True)


def op_extract_audio(ctx: Context, args: dict) -> dict:
    """The sound of a video (another PMV whose cuts are taken over) as a song in the media folder (AAC, .m4a).
    The same name again reuses the file that is already there."""
    src = Path(str(args.get("path") or ""))
    if not src.is_file():
        raise FileNotFoundError(f"file not found: {src}")
    ctx.media.mkdir(parents=True, exist_ok=True)
    dest = ctx.media / f"{safe_filename(str(args.get('name') or src.stem), 'audio')}.m4a"
    if not (dest.is_file() and dest.stat().st_size > 0):
        tmp = dest.with_name(f".{dest.name}.tmp.m4a")
        r = subprocess.run([ctx.tool("ffmpeg"), "-v", "error", "-nostdin", "-y", "-i", str(src), "-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", "256k", str(tmp)],
                           capture_output=True, text=True, timeout=900)
        if r.returncode != 0 or not tmp.is_file():
            tmp.unlink(missing_ok=True)
            raise RuntimeError(f"the video has no usable sound track: {r.stderr.strip()[-300:]}")
        os.replace(tmp, dest)
    ffprobe = ctx.try_tool("ffprobe")
    return {"path": str(dest), "url": MEDIA_URL + urllib.parse.quote(dest.name), "name": dest.name, "duration": probe_duration(ffprobe, str(dest)) if ffprobe else None}


def _presets_file(ctx: Context) -> Path:
    return ctx.base / "presets.json"


def op_list_presets(ctx: Context, args: dict) -> list:
    """Saved generator settings (shared by every browser of this Stash)."""
    items = _read_json(_presets_file(ctx), [])
    return [p for p in items if isinstance(p, dict) and p.get("name")] if isinstance(items, list) else []


def op_save_preset(ctx: Context, args: dict) -> list:
    name = str(args.get("name") or "").strip()[:80]
    settings = as_json(args.get("settings"))
    if not name or not isinstance(settings, dict):
        raise ValueError("a preset needs a name and settings")
    items = [p for p in op_list_presets(ctx, {}) if p["name"] != name] + [{"name": name, "settings": settings}]
    items.sort(key=lambda p: p["name"].lower())
    atomic_write(_presets_file(ctx), json.dumps(items, ensure_ascii=False, indent=1).encode("utf-8"))
    return items


def op_delete_preset(ctx: Context, args: dict) -> list:
    items = [p for p in op_list_presets(ctx, {}) if p["name"] != str(args.get("name") or "")]
    atomic_write(_presets_file(ctx), json.dumps(items, ensure_ascii=False, indent=1).encode("utf-8"))
    return items


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
    scan_into(ctx, dest.parent, result)
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


# Waveforms of the clips' sound: peaks per second of a scene file, and the rate its sound is decoded at for them
# (transients survive 8 kHz; an hour of sound is 57 MB through the pipe and 180 KB of peaks).
PEAKS_PER_SECOND = 50
PEAKS_RATE = 8000


def _peaks_of(data: bytes, step: int) -> bytes:
    """One byte per `step` bytes of s16le mono: the largest |sample|, scaled to 0-255."""
    n = len(data) // step
    res = bytearray(n)
    if audioop is not None:
        for i in range(n):
            res[i] = min(255, audioop.max(data[i * step:(i + 1) * step], 2) * 255 // 32767)
        return bytes(res)
    samples = array.array("h")
    samples.frombytes(data[: n * step])
    if sys.byteorder != "little":
        samples.byteswap()
    per = step // 2
    for i in range(n):
        seg = samples[i * per:(i + 1) * per]
        res[i] = min(255, max(max(seg), -min(seg)) * 255 // 32767)
    return bytes(res)


def audio_peaks(ff: str, path: str, pps: int = PEAKS_PER_SECOND, timeout: float = 1800) -> Optional[bytes]:
    """Max |sample| per 1/pps s of the file's first sound track as bytes (0-255); None when it has no sound.
    FFmpeg has to read the whole file (the sound is interleaved with the picture) – over a NAS that takes a while."""
    step = (PEAKS_RATE // pps) * 2  # bytes per bucket (s16)
    cmd = [ff, "-v", "error", "-nostdin", "-i", path, "-map", "0:a:0", "-vn", "-sn", "-dn", "-ac", "1", "-ar", str(PEAKS_RATE), "-f", "s16le", "pipe:1"]
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0  # type: ignore[attr-defined]
    p = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=flags)
    out = bytearray()
    rest = b""
    started = time.time()
    err = ""
    try:
        assert p.stdout is not None and p.stderr is not None
        while True:
            chunk = p.stdout.read(step * 512)
            if not chunk:
                break
            if time.time() - started > timeout:
                p.kill()
                raise RuntimeError("decoding the sound of the file took too long")
            data = rest + chunk
            whole = len(data) - len(data) % step
            out.extend(_peaks_of(data[:whole], step))
            rest = data[whole:]
        rest = rest[: len(rest) - len(rest) % 2]
        if rest:
            out.extend(_peaks_of(rest, len(rest)))
        err = p.stderr.read().decode(errors="replace")
        p.wait()
    finally:
        if p.poll() is None:
            p.kill()
    if p.returncode != 0:
        if "matches no streams" in err or "does not contain any stream" in err:
            return None
        raise RuntimeError(f"FFmpeg failed ({p.returncode}): {err.strip()[-300:]}")
    return bytes(out)


def op_audio_peaks(ctx: Context, args: dict) -> dict:
    """The sound of a scene file as peaks (50/s, one byte each, base64) for the waveforms in the editor – worked
    out once with FFmpeg and kept in the cache (keyed by path, size and mtime)."""
    path = str(args.get("path") or "")
    if not os.path.isfile(path):
        raise FileNotFoundError(f"file not found: {path}")
    st = os.stat(path)
    key = hashlib.sha1(f"{path}|{st.st_size}|{int(st.st_mtime)}".encode("utf-8", "surrogateescape")).hexdigest()[:24]
    cache = ctx.cache / "peaks" / f"{key}.json"
    if cache.is_file():
        try:
            return json.loads(cache.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass
    peaks = audio_peaks(ctx.tool("ffmpeg"), path)
    result = {"pps": PEAKS_PER_SECOND, "peaks": base64.b64encode(peaks).decode() if peaks else "", "duration": len(peaks) / PEAKS_PER_SECOND if peaks else 0, "hasAudio": peaks is not None}
    cache.parent.mkdir(parents=True, exist_ok=True)
    atomic_write(cache, json.dumps(result).encode("utf-8"))
    return result


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
    scan_into(ctx, dest.parent, result)
    atomic_write(status_file, json.dumps({"status": "done", **result}).encode())
    log_info(f"Done: {result['file']}")
    return result


def scan_into(ctx: Context, folder: Path, result: Dict[str, Any]) -> None:
    """Scan after rendering (plugin setting): result["scanned"] = True once Stash got the scan, otherwise a warning."""
    if not (ctx.settings.get("scanAfterRender") and ctx.stash):
        return
    warning = scan_output(ctx, folder)
    if warning:
        result["warning"] = f"{result['warning']} · {warning}" if result.get("warning") else warning
    else:
        result["scanned"] = True


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
    return {"config": cur["config"], **({"quit": True} if _take_quit(ctx, helper_key(info.get("name"))) else {})}


def _take_quit(ctx: Context, key: str) -> bool:
    """A quit asked for in the editor within the last two minutes – taken once; the helper then shows as offline."""
    f = _helpers_dir(ctx) / f"{key}.quit"
    try:
        fresh = time.time() - float(f.read_text()) < 120
        f.unlink()
    except (OSError, ValueError):
        return False
    if fresh:
        path = _helpers_dir(ctx) / f"{key}.json"
        cur = _read_json(path, {}) or {}
        cur["lastSeen"] = 0
        atomic_write(path, json.dumps(cur).encode())
    return fresh


def op_helper_quit(ctx: Context, args: dict) -> dict:
    """The editor asks a connected helper to quit – a flag it takes along with its next hello or claim (~20 s)."""
    key = helper_key(args.get("name"))
    cur = _read_json(_helpers_dir(ctx) / f"{key}.json", {}) or {}
    if time.time() - float(cur.get("lastSeen") or 0) >= HELPER_ONLINE:
        return {"ok": False}
    (_helpers_dir(ctx) / f"{key}.quit").write_text(str(time.time()))
    return {"ok": True}


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
    if _take_quit(ctx, key):
        return {"quit": True}
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
                # saved in a folder Stash sees too (a mapped one, e.g. Y:\PMVs = /data/PMVs): scan it there
                cfg = (_read_json(_helpers_dir(ctx) / f"{helper}.json", {}) or {}).get("config") or {}
                stash_file = unmap_path(str(result.get("file") or ""), cfg.get("mappings") or [])
                if stash_file:
                    result["stashFile"] = stash_file
                    scan_into(ctx, Path(stash_file).parent, result)
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


def unmap_path(path: str, mappings: List[Dict[str, str]]) -> Optional[str]:
    """The other way round: a path on the PC ("Y:\\PMVs\\a.mp4") as Stash sees it ("/data/PMVs/a.mp4"), None outside every mapping.
    Drive letters and separators are compared loosely (Windows)."""
    norm = path.replace("\\", "/")
    best = None
    for m in mappings or []:
        src, dst = str(m.get("from") or ""), str(m.get("to") or "").replace("\\", "/").rstrip("/")
        if not src or not dst:
            continue
        loose = bool(re.match(r"^[A-Za-z]:", dst)) or "\\" in str(m.get("to"))
        head = norm[: len(dst)]
        if (head.lower() == dst.lower() if loose else head == dst) and norm[len(dst):][:1] in ("/", "") and (best is None or len(dst) > len(best[1])):
            best = (src, dst)
    if not best:
        return None
    rest = norm[len(best[1]):].lstrip("/")
    sep = "\\" if ("\\" in best[0] or re.match(r"^[A-Za-z]:", best[0])) else "/"
    return best[0].rstrip("/\\") + sep + rest.replace("/", sep)


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
LIVE_STREAMS = 8  # FFmpeg processes at the same time: the preview's players on their way to the screen (the editor cuts the others off), the scene player, seeks in flight
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


def stream_command(ff: str, f: Path, start: float, audio: bool, end: Optional[float] = None) -> List[str]:
    """Fragmented MP4 of the file from `start` on (to `end`, when the editor says how far its clip needs it – it used
    to run on to the end of the file): H.264 with the long side at most 1280 px, a keyframe every 30 frames and
    half-second fragments (quick to start), AAC stereo unless audio is off."""
    scale = "scale='if(gte(iw,ih),min(1280,iw),-2)':'if(gte(iw,ih),-2,min(1280,ih))'"
    start = max(0.0, start)
    cmd = [ff, "-hide_banner", "-loglevel", "error", "-ss", f"{start:.3f}", "-i", str(f), "-map", "0:v:0"]
    if end is not None and end > start:
        cmd += ["-t", f"{end - start:.3f}"]
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
                    end = float(q["end"]) if q.get("end") else None
                except ValueError:
                    end = None
                try:
                    self._stream(f, float(q.get("start") or 0), q.get("a") != "0", end)
                except _GONE:
                    pass  # the browser seeked elsewhere or closed the player – FFmpeg was stopped in _stream

            def _stream(self, f: Path, start: float, audio: bool, end: Optional[float] = None) -> None:
                if not server.ff:
                    return self._reply(503, b"no FFmpeg")
                if not server.live.acquire(timeout=5):
                    return self._reply(503, b"busy")
                proc = None
                try:
                    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0  # type: ignore[attr-defined]
                    proc = subprocess.Popen(stream_command(server.ff, f, start, audio, end), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, creationflags=flags)
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


def windowless() -> bool:
    """Started without a console: pythonw (the .pyw file), the editor's Start button or the startup folder.
    (Handles may exist even then – a launcher's NUL device counts as a tty on Windows – so ask for the console window.)"""
    if sys.stdin is None or sys.stdout is None:
        return True
    if os.name == "nt":
        try:
            import ctypes

            return ctypes.windll.kernel32.GetConsoleWindow() == 0  # type: ignore[attr-defined]
        except Exception:
            return False
    return False


def helper_log_quietly() -> None:
    """Without a console the helper writes what it would print into a log next to itself (kept under 1 MB)."""
    try:
        log = Path(sys.argv[0]).resolve().with_suffix(".log") if sys.argv and sys.argv[0] else helper_dirs()["cache"].parent / "helper.log"
        if log.exists() and log.stat().st_size > 1_000_000:
            log.unlink()
        f = open(log, "a", encoding="utf-8", errors="replace", buffering=1)
        sys.stdout = sys.stderr = f
        print(f"--- {time.strftime('%Y-%m-%d %H:%M:%S')} started without a window ---")
    except OSError:
        pass


_INSTANCE_LOCK: Any = None  # held for the helper's lifetime


def helper_single_instance() -> bool:
    """True when no other helper runs on this PC (a named mutex on Windows, a locked file elsewhere)."""
    global _INSTANCE_LOCK
    if _INSTANCE_LOCK is not None:
        return True
    if os.name == "nt":
        import ctypes

        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.CreateMutexW.restype = ctypes.c_void_p
        k32.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]
        handle = k32.CreateMutexW(None, False, "Local\\PMVCreatorRenderHelper")
        if not handle:
            return True
        if ctypes.get_last_error() == 183:  # ERROR_ALREADY_EXISTS
            k32.CloseHandle(ctypes.c_void_p(handle))
            return False
        _INSTANCE_LOCK = handle
        return True
    try:
        import fcntl

        root = helper_dirs()["cache"].parent
        root.mkdir(parents=True, exist_ok=True)
        f = open(root / "helper.lock", "w")
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        _INSTANCE_LOCK = f
        return True
    except ImportError:
        return True
    except OSError:
        return False


def helper_launch_command(script: Optional[Path] = None) -> str:
    """What the URL scheme runs: pythonw (no window) when it is there, this helper file, the URL as its argument."""
    exe = Path(sys.executable)
    pyw = exe.with_name("pythonw.exe")
    return f'"{pyw if pyw.is_file() else exe}" "{(script or Path(sys.argv[0])).resolve()}" "%1"'


def register_helper_protocol(scheme: str = HELPER_PROTOCOL) -> bool:
    """Registers <scheme>:// for this user (Windows, no admin rights), so the editor's Start button can start this
    helper. Done at every start, so a moved file is found again. Best effort."""
    if os.name != "nt":
        return False
    try:
        import winreg

        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, rf"Software\Classes\{scheme}") as base:
            winreg.SetValue(base, "", winreg.REG_SZ, "URL:PMV Creator render helper")
            winreg.SetValueEx(base, "URL Protocol", 0, winreg.REG_SZ, "")
            winreg.SetValue(base, r"shell\open\command", winreg.REG_SZ, helper_launch_command())
        return True
    except OSError:
        return False


def strip_protocol_args(argv: List[str]) -> tuple:
    """Takes the <scheme>:// argument of a start from the editor out of argv -> (rest, started_from_editor)."""
    rest = [a for a in argv if not a.lower().startswith(HELPER_PROTOCOL + ":")]
    return rest, len(rest) != len(argv)


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
        for s in piece_sources(piece):
            resolve(s, f"{base}/scene/{s.get('sceneId')}/stream")
    music = plan.get("audio")
    if music and music.get("path"):
        resolve(music, base + music["url"] if str(music.get("url") or "").startswith("/") else None)
    return plan


def helper_font(client: Any, plan: Dict[str, Any], cache: Path) -> Optional[str]:
    """The words' font for a render on the PC: fetched once from the plugin in Stash (the helper is a single file)."""
    url = str(plan.get("fontUrl") or "")
    if not plan_has_words(plan) or not url.startswith("/"):
        return None
    path = cache / "fonts" / FX_FONT_FILE
    if path.is_file() and path.read_bytes()[:4] in FONT_MAGIC:
        return str(path)
    try:
        req = urllib.request.Request(client.base + url, headers={"ApiKey": client.api_key} if getattr(client, "api_key", "") else {})
        with urllib.request.urlopen(req, timeout=60, context=getattr(client, "ctx", None)) as r:
            data = r.read()
        if data[:4] not in FONT_MAGIC:
            raise ValueError("the answer is not a font (a login page?)")
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write(path, data)
        return str(path)
    except Exception as e:
        log_warn(f"The font for the words could not be loaded from Stash ({e}) – rendering without them")
        return None


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
        font = helper_font(client, plan, dirs["cache"])
        with tempfile.TemporaryDirectory(prefix="pmv-", dir=str(dirs["work"])) as work:
            result = render_plan(plan, ff, dest, dirs["cache"], Path(work), jobs, font)
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
    if not helper_single_instance():
        print("The render helper is already running on this PC – nothing to do.")
        if pause:
            input("Press Enter to close …")
        return 0
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
    if HELPER_DEFAULTS.get("stash") and register_helper_protocol():
        print(f"{HELPER_PROTOCOL}:// registered – “Start helper” in the editor starts this file from now on.")
    if windowless():
        print("Waiting for renders – no window: “Quit helper” in the editor (Render → My PC) stops it.", flush=True)
    else:
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
                if isinstance(hello, dict) and hello.get("quit"):
                    print("Quit requested in the editor.", flush=True)
                    _STOP.set()
                    break
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
                if isinstance(job, dict) and job.get("quit"):
                    print("Quit requested in the editor.", flush=True)
                    _STOP.set()
                    break
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
    "list_media": op_list_media,
    "extract_audio": op_extract_audio,
    "list_presets": op_list_presets,
    "save_preset": op_save_preset,
    "delete_preset": op_delete_preset,
    "save_recording": op_save_recording,
    "keyframes": op_keyframes,
    "audio_peaks": op_audio_peaks,
    "gray_frames": op_gray_frames,
    "ffmpeg_script": op_ffmpeg_script,
    "render_result": op_render_result,
    "clear_cache": op_clear_cache,
    "helper_hello": op_helper_hello,
    "helper_list": op_helper_list,
    "helper_config": op_helper_config,
    "helper_quit": op_helper_quit,
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
    argv, launched = strip_protocol_args(sys.argv[1:])
    if argv:
        return cli_main(argv)
    tty = not windowless() and sys.stdin is not None and sys.stdin.isatty()
    if HELPER_DEFAULTS.get("stash") and (launched or windowless() or tty):
        # the downloaded helper: double-clicked, from the startup folder or the editor's Start button
        if windowless():
            helper_log_quietly()
        return helper_main(HELPER_DEFAULTS["stash"], HELPER_DEFAULTS.get("apiKey", ""), pause=tty)
    return plugin_main()


if __name__ == "__main__":
    sys.exit(main())
