"""End-to-end test of the Python backend with real FFmpeg renders (no Stash needed).

    python tests/backend_e2e.py

Generates synthetic sources (different sizes, frame rates, with/without audio), renders a plan
that covers every piece type, and checks frame count, format, audio, the segment cache, the
generated FFmpeg script and the raw plugin interface (stdin/stdout JSON).
"""
import base64
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "plugin" / "backend" / "pmv_backend.py"
FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")
FPS = 30


def sh(cmd, **kw):
    # UTF-8, not the Windows code page: the frontend bundle carries characters like ⏮ that cp1252 can't decode
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", **kw)
    if r.returncode != 0:
        raise AssertionError(f"command failed ({r.returncode}): {cmd}\n{r.stdout}\n{r.stderr}")
    return r


def gen(path, video, seconds, audio=True):
    cmd = [FFMPEG, "-y", "-loglevel", "error", "-f", "lavfi", "-i", f"{video}:duration={seconds}"]
    if audio:
        cmd += ["-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}"]
    cmd += ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"]
    cmd += ["-c:a", "aac", "-shortest"] if audio else []
    sh(cmd + [str(path)])


def probe(path):
    r = sh([FFPROBE, "-v", "error", "-count_frames", "-show_entries",
            "stream=codec_type,width,height,r_frame_rate,nb_read_frames:format=duration", "-of", "json", str(path)])
    return json.loads(r.stdout)


def src(path, t, speed=1.0, volume=0.0, has_audio=True, fit="cover"):
    return {"sceneId": "1", "path": str(path), "in": t, "speed": speed, "volume": volume, "hasAudio": has_audio, "fit": fit, "label": path.name}


def check_output(path, total_frames, expect_audio=True, rate=f"{FPS}/1"):
    info = probe(path)
    video = next(s for s in info["streams"] if s["codec_type"] == "video")
    audio = [s for s in info["streams"] if s["codec_type"] == "audio"]
    num, den = map(int, rate.split("/"))
    fps = num / den
    assert (video["width"], video["height"]) == (640, 360), video
    assert video["r_frame_rate"] == rate, video
    assert int(video["nb_read_frames"]) == total_frames, f"{video['nb_read_frames']} != {total_frames}"
    assert bool(audio) == expect_audio, audio
    assert abs(float(info["format"]["duration"]) - total_frames / fps) < 0.06, info["format"]
    # constant frame rate: every timestamp sits exactly on the frame grid (no 1 ms rounding jitter)
    r = sh([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts", "-show_entries", "stream=time_base", "-of", "json", str(path)])
    pk = json.loads(r.stdout)
    tb_num, tb_den = map(int, pk["streams"][0]["time_base"].split("/"))
    worst = max(abs(p["pts"] * tb_num / tb_den * fps - round(p["pts"] * tb_num / tb_den * fps)) for p in pk["packets"])
    assert worst < 1e-6, f"timestamps off the frame grid by {worst:.4f} frames"
    # decoded frames come out in display order, one per grid step (B-frame streams break this when pts == dts)
    r = sh([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts", "-of", "csv=p=0", str(path)])
    pts = [int(x.split(",")[0]) for x in r.stdout.split() if x.split(",")[0].lstrip("-").isdigit()]
    assert len(pts) == total_frames, f"{len(pts)} decoded frames != {total_frames}"
    steps = {round((b - a) * tb_num / tb_den * fps, 3) for a, b in zip(pts, pts[1:])}
    assert steps == {1.0}, f"decoded frame order/step broken: steps {sorted(steps)[:5]}"


def color_stats(path):
    """Average saturation and chroma (U/V) of a video, from FFmpeg's signalstats."""
    r = subprocess.run([FFMPEG, "-hide_banner", "-i", str(path), "-vf", "signalstats,metadata=print", "-f", "null", "-"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    vals = {}
    for line in r.stderr.splitlines():
        m = re.search(r"lavfi\.signalstats\.(SATAVG|UAVG|VAVG)=([\d.]+)", line)
        if m:
            vals.setdefault(m.group(1), []).append(float(m.group(2)))
    return {k: sum(v) / len(v) for k, v in vals.items()}


def frame_rgb(path, n, fps=FPS):
    """Average R, G, B of frame n of a video – sought by its time: "select=eq(n,…)" counts anew wherever FFmpeg rebuilds
    its filter graph (at pieces with other colour tags)."""
    r = subprocess.run([FFMPEG, "-v", "error", "-ss", f"{(n - 0.25) / fps:.6f}", "-i", str(path), "-vf", "scale=32:18", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True)
    d = r.stdout
    assert len(d) == 32 * 18 * 3, f"frame {n} not decoded"
    return [sum(d[i::3]) / (32 * 18) for i in range(3)]


def run_preview_server(video, tmp):
    """Stand-in for Stash's /scene/{id}/preview route (range requests, records the cookies it sees)."""
    import http.server
    import threading

    data = Path(video).read_bytes()

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            server.cookies.append(self.headers.get("Cookie"))
            if self.path != "/scene/7/preview":
                self.send_error(404)
                return
            start, end, code = 0, len(data) - 1, 200
            rng = self.headers.get("Range", "")
            if rng.startswith("bytes="):
                a_, b_ = rng[6:].split("-")
                start, end, code = int(a_ or 0), int(b_) if b_ else len(data) - 1, 206
            self.send_response(code)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(end - start + 1))
            if code == 206:
                self.send_header("Content-Range", f"bytes {start}-{end}/{len(data)}")
            self.end_headers()
            self.wfile.write(data[start:end + 1])

        def do_POST(self):  # GraphQL (plugin settings) -> not available here
            self.send_error(501)

        def log_message(self, *a):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    server.cookies = []
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def run_stream_server(video):
    """Stand-in for Stash's /scene/{id}/stream (range requests); records paths and the ApiKey header."""
    import http.server
    import threading

    data = Path(video).read_bytes()

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            server.requests.append(self.path)
            server.keys.append(self.headers.get("ApiKey"))
            if not (self.path.startswith("/scene/") and self.path.endswith("/stream")):
                self.send_error(404)
                return
            start, end, code = 0, len(data) - 1, 200
            rng = self.headers.get("Range", "")
            if rng.startswith("bytes="):
                a_, b_ = rng[6:].split("-")
                start, end, code = int(a_ or 0), min(int(b_) if b_ else len(data) - 1, len(data) - 1), 206
            self.send_response(code)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(end - start + 1))
            if code == 206:
                self.send_header("Content-Range", f"bytes {start}-{end}/{len(data)}")
            self.end_headers()
            try:
                self.wfile.write(data[start:end + 1])
            except (BrokenPipeError, ConnectionResetError):
                pass  # FFmpeg closes early after a seek

        def log_message(self, *a):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    server.requests = []
    server.keys = []
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def run_plugin(payload, env):
    r = subprocess.run([sys.executable, str(BACKEND)], input=json.dumps(payload), capture_output=True, text=True, env=env, timeout=600)
    out = json.loads(r.stdout.strip().splitlines()[-1])
    if "error" in out:
        raise AssertionError(f"plugin error: {out['error']}\n{r.stderr}")
    return out["output"]


def main():
    if not FFMPEG or not FFPROBE:
        print("SKIP: ffmpeg/ffprobe not on PATH")
        return 0
    with tempfile.TemporaryDirectory(prefix="pmv-e2e-") as tmp:
        tmp = Path(tmp)
        a = tmp / "a 25fps's.mp4"  # space + quote: exercises concat/script escaping
        b = tmp / "b60.mp4"
        c = tmp / "portrait.mp4"
        music = tmp / "music.wav"
        gen(a, "testsrc2=size=640x360:rate=25", 12)
        gen(b, "testsrc=size=1280x720:rate=60", 10, audio=False)
        gen(c, "smptebars=size=360x640:rate=30", 6)
        sh([FFMPEG, "-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=20", str(music)])

        pieces = [
            {"kind": "xfade", "frames": 10, "transition": "fadeblack", "a": None, "b": src(a, 1.0, volume=1.0)},
            {"kind": "clip", "frames": 35, "src": src(a, 1.333, volume=1.0)},
            {"kind": "xfade", "frames": 12, "transition": "fade", "a": src(a, 2.5, volume=1.0), "b": src(b, 1.8, has_audio=False, fit="blur")},
            {"kind": "clip", "frames": 40, "src": src(b, 2.0, speed=2.0, has_audio=False)},
            {"kind": "black", "frames": 15},
            {"kind": "clip", "frames": 30, "src": src(c, 0.5, speed=0.5, fit="contain")},
            {"kind": "xfade", "frames": 8, "transition": "wipeleft", "a": src(c, 1.5), "b": src(a, 9.0)},
            {"kind": "clip", "frames": 30, "src": src(a, 9.5, speed=1.5, fit="blur")},
            # only 0.5 s of material left -> the renderer must pad to the exact frame count
            {"kind": "clip", "frames": 30, "src": src(b, 9.5, has_audio=False)},
        ]
        total = sum(p["frames"] for p in pieces)
        plan = {
            "version": 1, "projectId": "pmv_test", "projectName": "E2E Test", "totalFrames": total, "clipAudio": True,
            "output": {"width": 640, "height": 360, "fps": FPS, "fit": "cover", "videoCodec": "libx264", "crf": 30, "preset": "ultrafast", "audioBitrate": "192k"},
            "audio": {"path": str(music), "sourceIn": 1.0, "start": 0.2, "gainDb": -3, "fadeIn": 0.5, "fadeOut": 1.0},
            "pieces": pieces,
        }
        plan_path = tmp / "plan.json"
        plan_path.write_text(json.dumps(plan), encoding="utf-8")

        # 1) CLI render
        out = tmp / "out.mp4"
        cache = tmp / "cache"
        r = sh([sys.executable, str(BACKEND), "render", str(plan_path), "-o", str(out), "--ffmpeg", FFMPEG, "--jobs", "3", "--cache", str(cache)])
        first = json.loads(r.stdout)
        check_output(out, total)
        assert first["cached"] == 0, first
        print(f"ok  CLI render: {total} frames, {first['seconds']} s")

        # 2) re-render hits the cache for every piece
        r = sh([sys.executable, str(BACKEND), "render", str(plan_path), "-o", str(out), "--ffmpeg", FFMPEG, "--cache", str(cache)])
        second = json.loads(r.stdout)
        assert second["cached"] == len(pieces), second
        print(f"ok  cache: {second['cached']}/{len(pieces)} reused, {second['seconds']} s")

        # 2a) B-frames: the default preset "medium" reorders frames (pts != dts) – concat + setts must keep the order
        bplan = dict(plan, output=dict(plan["output"], preset="medium", crf=28))
        bplan_path = tmp / "plan-bframes.json"
        bplan_path.write_text(json.dumps(bplan), encoding="utf-8")
        sh([sys.executable, str(BACKEND), "render", str(bplan_path), "-o", str(tmp / "bframes.mp4"), "--ffmpeg", FFMPEG, "--cache", str(cache)])
        has_b = sh([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=has_b_frames", "-of", "csv=p=0", str(tmp / "bframes.mp4")]).stdout.strip()
        assert has_b not in ("", "0"), f"expected a B-frame stream, has_b_frames={has_b!r}"
        check_output(tmp / "bframes.mp4", total)
        print("ok  B-frame render (preset medium): frame order intact")

        # 2b) NTSC rate (29.97 = 30000/1001), no music, clip audio only
        ntsc = dict(plan, output=dict(plan["output"], fps=29.97), audio=None)
        ntsc_path = tmp / "plan-ntsc.json"
        ntsc_path.write_text(json.dumps(ntsc), encoding="utf-8")
        sh([sys.executable, str(BACKEND), "render", str(ntsc_path), "-o", str(tmp / "ntsc.mp4"), "--ffmpeg", FFMPEG, "--cache", str(cache)])
        check_output(tmp / "ntsc.mp4", total, rate="30000/1001")
        print("ok  29.97 fps render (CFR, clip audio only)")

        # 2c) colour look, in the numbers the editor sends: black & white takes the colour out (black pieces keep
        # their cache), a warm tint warms grey up
        grey = tmp / "grey.mp4"
        gen(grey, "color=c=0x808080:size=320x180:rate=30", 3, audio=False)

        def graded(name, source, grade):
            ps = [{"kind": "clip", "frames": 30, "src": src(source, 1.0, has_audio=False)}, {"kind": "black", "frames": 10}]
            gp = dict(plan, totalFrames=40, clipAudio=False, audio=None, pieces=ps, **({"grade": grade} if grade else {}))
            gp_path = tmp / f"plan-{name}.json"
            gp_path.write_text(json.dumps(gp), encoding="utf-8")
            res = json.loads(sh([sys.executable, str(BACKEND), "render", str(gp_path), "-o", str(tmp / f"{name}.mp4"), "--ffmpeg", FFMPEG, "--cache", str(cache)]).stdout)
            check_output(tmp / f"{name}.mp4", 40, expect_audio=False)
            return color_stats(tmp / f"{name}.mp4"), res

        plain, _ = graded("plain", a, None)
        bw = {"matrix": [0.2445, 0.8225, 0.083] * 3, "offset": [-0.075] * 3, "layers": [], "vignette": 0.6}
        mono, res = graded("bw", a, bw)
        assert plain["SATAVG"] > 10 and mono["SATAVG"] < 2, (plain, mono)
        assert res["cached"] == 1, res  # the black piece: no look, same key as without one
        warm, _ = graded("warm", grey, {"matrix": [1, 0, 0, 0, 1, 0, 0, 0, 1], "offset": [0, 0, 0], "layers": [[255, 140, 60, 0.5]], "vignette": 0})
        assert warm["VAVG"] > 132 and warm["UAVG"] < 124, warm
        print(f"ok  colour look: saturation {plain['SATAVG']:.0f} -> {mono['SATAVG']:.1f} (b&w), grey -> V {warm['VAVG']:.0f} / U {warm['UAVG']:.0f} (warm)")

        # 3) generated script renders the same thing
        shell = "cmd" if os.name == "nt" else "sh"
        script_dir = tmp / "script"
        script_dir.mkdir()
        script = script_dir / ("render.cmd" if shell == "cmd" else "render.sh")
        text = sh([sys.executable, str(BACKEND), "script", str(plan_path), "--shell", shell]).stdout
        script.write_text(text, encoding="utf-8", newline="")
        env = dict(os.environ, PATH=str(Path(FFMPEG).parent) + os.pathsep + os.environ.get("PATH", ""))
        sh(["cmd", "/c", str(script)] if shell == "cmd" else ["bash", str(script)], env=env, cwd=script_dir)
        check_output(script_dir / "E2E Test.mp4", total)
        print(f"ok  {shell} script render")

        # 4) raw plugin interface (Stash unreachable on port 1 -> defaults)
        data = tmp / "data"
        env = dict(os.environ, PMV_DATA_DIR=str(data))
        conn = {"Scheme": "http", "Port": 1, "Dir": str(tmp)}
        call = lambda args: run_plugin({"server_connection": conn, "args": args}, env)  # noqa: E731
        assert call({"op": "ping"})["ffmpeg"], "ffmpeg not resolved"
        project = {"id": "pmv_e2e", "name": "E2E", "updatedAt": "2026-01-01T00:00:00Z", "tracks": []}
        call({"op": "save_project", "project": project})
        assert call({"op": "list_projects"})[0]["id"] == "pmv_e2e"
        assert call({"op": "load_project", "id": "pmv_e2e"})["name"] == "E2E"
        call({"op": "delete_project", "id": "pmv_e2e"})
        assert call({"op": "list_projects"}) == []
        blob = music.read_bytes()
        half = len(blob) // 2
        call({"op": "upload_chunk", "uploadId": "up_1", "index": 0, "total": 2, "name": "my track.wav", "data": base64.b64encode(blob[:half]).decode()})
        up = call({"op": "upload_chunk", "uploadId": "up_1", "index": 1, "total": 2, "name": "my track.wav", "data": base64.b64encode(blob[half:]).decode()})
        assert up["done"] and Path(up["path"]).read_bytes() == blob and up["url"].endswith("my%20track.wav"), up
        # browser recording: uploaded WebM -> output folder, remuxed (duration present), scan skipped without Stash
        webm = tmp / "rec.webm"
        sh([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=64x64:rate=10", "-c:v", "libvpx", str(webm)])
        rec_up = call({"op": "upload_chunk", "uploadId": "up_2", "index": 0, "total": 1, "name": "rec.webm", "data": base64.b64encode(webm.read_bytes()).decode()})
        rec = call({"op": "save_recording", "path": rec_up["path"], "name": "My PMV"})
        assert rec["file"].endswith(".webm") and Path(rec["file"]).is_file() and Path(rec["file"]).name.startswith("My PMV_"), rec
        assert not Path(rec_up["path"]).exists(), "upload not moved"
        assert rec.get("seconds") and abs(rec["seconds"] - 1.0) < 0.2, rec
        kf = call({"op": "keyframes", "path": str(a)})
        assert kf and kf[0] == 0.0, kf[:5]
        # waveform peaks of a scene: 50 per second, a steady sine stays loud, the answer is kept; no sound -> none
        pk = call({"op": "audio_peaks", "path": str(a)})
        peaks = base64.b64decode(pk["peaks"])
        assert pk["hasAudio"] and pk["pps"] == 50 and abs(len(peaks) - 12 * 50) <= 3, (pk["hasAudio"], pk["pps"], len(peaks))
        mid = sorted(peaks[5:-5])
        assert 25 <= max(peaks) <= 90 and mid[len(mid) // 2] > 20, (max(peaks), mid[len(mid) // 2])  # FFmpeg's sine is about -14 dBFS
        assert (data / "cache" / "peaks").is_dir() and call({"op": "audio_peaks", "path": str(a)}) == pk
        silent = call({"op": "audio_peaks", "path": str(b)})
        assert silent["hasAudio"] is False and silent["peaks"] == "", silent
        try:
            call({"op": "load_project", "id": "../../etc/passwd"})
            raise AssertionError("path traversal not rejected")
        except AssertionError as e:
            assert "invalid" in str(e), e
        # another PMV's sound becomes a song (reused when asked again); the song library lists songs, not recordings
        song = call({"op": "extract_audio", "path": str(a), "name": "Other PMV"})
        assert song["name"] == "Other PMV.m4a" and song.get("duration") and abs(song["duration"] - 12) < 0.3, song
        assert call({"op": "extract_audio", "path": str(a), "name": "Other PMV"})["path"] == song["path"]
        assert [x["name"] for x in call({"op": "list_media"})] == ["Other PMV.m4a", "my track.wav"]
        # generator presets: saved on the server, the same name overwrites, sorted by name
        call({"op": "save_preset", "name": "b fast", "settings": {"mood": "maximal"}})
        call({"op": "save_preset", "name": "A slow", "settings": {"mood": "hypno"}})
        assert call({"op": "save_preset", "name": "b fast", "settings": {"mood": "clean"}}) == [{"name": "A slow", "settings": {"mood": "hypno"}}, {"name": "b fast", "settings": {"mood": "clean"}}]
        assert call({"op": "delete_preset", "name": "A slow"}) == [{"name": "b fast", "settings": {"mood": "clean"}}]
        print(f"ok  plugin ops (projects, chunked upload, recording saved, {len(kf)} keyframes, id validation, sound of a video, song library, presets)")

        # 4b) gray frames for the generator's motion analysis: a file stretch and a scene preview over HTTP
        gf = call({"op": "gray_frames", "items": [{"key": "a", "path": str(a), "start": 2.0, "duration": 1.0, "fps": 30}, {"key": "c", "path": str(c), "start": 0, "duration": 0.5, "fps": 10}, {"key": "x", "path": str(tmp / "nope.mp4"), "fps": 30}]})
        assert (gf["a"]["w"], gf["a"]["h"], gf["a"]["t0"]) == (64, 36, 2.0), gf["a"]
        assert len(base64.b64decode(gf["a"]["data"])) == 64 * 36 * 30, len(gf["a"]["data"])
        assert (gf["c"]["w"], gf["c"]["h"]) == (36, 64), gf["c"]  # portrait: long side 64
        assert "error" in gf["x"]
        preview = run_preview_server(b, tmp)
        try:
            pconn = {"Scheme": "http", "Port": preview.server_port, "SessionCookie": {"Name": "session", "Value": "s3cret"}}
            pv = run_plugin({"server_connection": pconn, "args": {"op": "gray_frames", "items": [{"key": "p", "preview": True, "sceneId": "7", "fps": 15}]}}, env)
            assert "error" not in pv["p"], pv["p"]
            assert len(base64.b64decode(pv["p"]["data"])) == 64 * 36 * 15 * 10, "10 s preview at 15 fps"
            assert preview.cookies and all(ck == "session=s3cret" for ck in preview.cookies), preview.cookies
        finally:
            preview.shutdown()
        print("ok  gray frames (file stretch, portrait, missing file, preview over HTTP with session cookie)")

        # 5) render task through the plugin interface
        res = call({"mode": "render", "renderId": "render_e2e", "plan": json.dumps(plan)})
        status = call({"op": "render_result", "renderId": "render_e2e"})
        assert status["status"] == "done" and status["file"] == res["file"], status
        check_output(Path(res["file"]), total)
        print(f"ok  plugin render task -> {Path(res['file']).name} ({res['cached']} cached)")

        # 5b) render on a PC: the Stash task only brokers, the helper claims the job and renders "remotely"
        #      (here in-process, with the scenes read over HTTP from a fake Stash that checks the API key)
        mod_spec = importlib.util.spec_from_file_location("pmv_backend_helper", BACKEND)
        hb = importlib.util.module_from_spec(mod_spec)
        mod_spec.loader.exec_module(hb)
        hb.PLAIN_LOG = True
        assert hb.map_path("/data/clips/a b.mp4", [{"from": "/data/", "to": "Y:\\"}, {"from": "/data/clips/", "to": "Z:\\c"}]) == "Z:\\c\\a b.mp4"
        assert hb.map_path("/other/x.mp4", [{"from": "/data/", "to": "Y:\\"}]) is None
        # the way back (a PC render saved in a folder Stash sees): drive letters loosely, the longest mapping wins
        assert hb.unmap_path("y:\\PMVs\\a b.mp4", [{"from": "/data/", "to": "Y:\\"}, {"from": "/data/clips/", "to": "Z:\\c"}]) == "/data/PMVs/a b.mp4"
        assert hb.unmap_path("Z:\\c\\x.mp4", [{"from": "/data/", "to": "Y:\\"}, {"from": "/data/clips/", "to": "Z:\\c"}]) == "/data/clips/x.mp4"
        assert hb.unmap_path("Z:\\cc\\x.mp4", [{"from": "/data/clips/", "to": "Z:\\c"}]) is None
        assert hb.unmap_path("I:\\PMVs\\x.mp4", [{"from": "/data/", "to": "Y:\\"}]) is None
        # split screens: every field group's source is found like a clip's (the path itself, a mapped one, or Stash's stream)
        lay = {"pieces": [{"kind": "layout", "frames": 10, "groups": [src(a, 1.0), None, {**src(a, 2.0), "path": "/data/nowhere.mp4", "sceneId": "7"}], "fields": [], "dividers": []}]}
        g = hb.prepare_pc_plan(lay, {"mappings": [{"from": "/nope/", "to": "Q:\\"}]}, "http://nas:9999", "k3y")["pieces"][0]["groups"]
        assert g[0]["path"] == str(a) and g[1] is None and g[2]["path"] == "http://nas:9999/scene/7/stream" and g[2]["inputArgs"], g
        assert call({"op": "helper_progress", "jobId": "nope"}) == {"cancel": True}
        call({"op": "helper_hello", "info": {"name": "TEST PC", "version": "t", "ffmpeg": FFMPEG, "defaultOutput": str(tmp / "pc-default")}})
        helpers = call({"op": "helper_list"})
        assert [h["id"] for h in helpers] == ["TEST_PC"] and helpers[0]["online"], helpers
        # the output folder is mapped too (as if Stash saw it as /stash/pmvs/): the result names the file as Stash sees it
        call({"op": "helper_config", "name": "TEST_PC", "config": {"outputDir": str(tmp / "pc-out"), "mappings": [{"from": "/data/", "to": "Y:\\"}, {"from": "/stash/pmvs/", "to": str(tmp / "pc-out")}, {"from": "", "to": "x"}]}})
        assert call({"op": "helper_list"})[0]["config"] == {"outputDir": str(tmp / "pc-out"), "mappings": [{"from": "/data/", "to": "Y:\\"}, {"from": "/stash/pmvs/", "to": str(tmp / "pc-out")}]}
        # quit from the editor: the next hello (or claim) takes the flag along once and the helper shows as offline;
        # a helper that is not connected gets no flag
        assert call({"op": "helper_quit", "name": "TEST PC"}) == {"ok": True}
        hello = call({"op": "helper_hello", "info": {"name": "TEST PC"}})
        assert hello.get("quit") is True and not call({"op": "helper_list"})[0]["online"], hello
        assert "quit" not in call({"op": "helper_hello", "info": {"name": "TEST PC"}})
        assert call({"op": "helper_quit", "name": "Nobody"}) == {"ok": False}
        assert call({"op": "helper_claim", "name": "TEST PC"}) is None
        stream = run_stream_server(a)
        broker = subprocess.Popen([sys.executable, str(BACKEND)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        broker.stdin.write(json.dumps({"args": {"mode": "pc", "renderId": "render_pc", "helper": "TEST_PC", "plan": json.dumps(plan)}}))
        broker.stdin.close()
        try:
            job = None
            for _ in range(40):
                job = call({"op": "helper_claim", "name": "TEST PC"})
                if job:
                    break
                time.sleep(0.25)
            assert job and job["jobId"] == "render_pc" and job["config"]["outputDir"] == str(tmp / "pc-out"), job
            assert call({"op": "helper_claim", "name": "TEST PC"}) is None, "a job is claimed once"

            class FakeClient:
                base = f"http://127.0.0.1:{stream.server_port}"
                api_key = "k3y"

                def op(self, args):
                    return call(args)

            dirs = {"cache": tmp / "pc-cache", "work": tmp / "pc-work", "output": tmp / "pc-default"}
            pc = hb.run_helper_job(job, FakeClient(), FFMPEG, dirs, jobs=3, stream_only=True)
            out_text = broker.stdout.read()
            broker.wait(timeout=60)
        finally:
            stream.shutdown()
            if broker.poll() is None:
                broker.kill()
        assert broker.returncode == 0 and json.loads(out_text.strip().splitlines()[-1])["output"]["file"] == pc["file"], out_text
        assert Path(pc["file"]).parent == tmp / "pc-out", pc
        check_output(Path(pc["file"]), total)
        status = call({"op": "render_result", "renderId": "render_pc"})
        assert status["status"] == "done" and status["helper"] == "TEST_PC" and status["file"] == pc["file"], status
        assert status["stashFile"] == "/stash/pmvs/" + Path(pc["file"]).name, status
        assert stream.requests and all(k == "k3y" for k in stream.keys), (stream.requests[:3], stream.keys[:3])
        assert not list((data / "pc-jobs").glob("*")), "job files cleaned up"
        print(f"ok  render on a PC: broker task + helper, {len(stream.requests)} stream requests with API key -> {Path(pc['file']).name}")

        # 5c) the helper's media server: the editor's preview streams mapped files from the PC as fragmented MP4
        #     that starts exactly at ?start= (token, nothing outside the mapped folder)
        call({"op": "helper_hello", "info": {"name": "TEST PC", "serve": {"url": "http://10.0.0.5:9978", "token": "t0k"}}})
        assert call({"op": "helper_list"})[0]["serve"] == {"url": "http://10.0.0.5:9978", "token": "t0k"}
        call({"op": "helper_hello", "info": {"name": "TEST PC"}})
        assert "serve" not in call({"op": "helper_list"})[0], "an older helper has no media server"
        lib = tmp / "lib" / "sub dir"
        lib.mkdir(parents=True)
        shutil.copy(a, lib / "a.mp4")
        shutil.copy(a, tmp / "secret.mp4")
        (lib / "notes.txt").write_text("x")
        media = hb.MediaServer("127.0.0.1", FFMPEG, "s3cret", ports=(0,))
        media.mappings = [{"from": "/data/", "to": str(tmp / "lib")}]

        def get(path):
            try:
                with urllib.request.urlopen(media.url + path, timeout=30) as r:
                    return r.status, dict(r.headers), r.read()
            except urllib.error.HTTPError as e:
                return e.code, dict(e.headers), e.read()

        q = lambda p: urllib.parse.quote(p)  # noqa: E731
        a_path = q("/data/sub dir/a.mp4")
        try:
            assert get("/v1/ping?k=wrong")[0] == 403
            st, hd, body = get("/v1/ping?k=s3cret")
            assert st == 200 and json.loads(body)["folders"] == ["/data/"] and hd["Access-Control-Allow-Origin"] == "*", (st, hd, body)
            for bad in ("/data/../secret.mp4", "/data/sub dir/../../secret.mp4", "/other/a.mp4", "/data/sub dir/notes.txt", "/data/sub dir/missing.mp4"):
                assert get(f"/v1/stream?k=s3cret&path={q(bad)}")[0] == 404, bad
            src_dur = float(probe(lib / "a.mp4")["format"]["duration"])
            st, hd, body = get(f"/v1/stream?k=s3cret&start=1.5&path={a_path}")
            assert st == 200 and hd["Content-Type"] == "video/mp4" and body[4:8] == b"ftyp" and b"moof" in body, (st, hd, body[:16])
            live = tmp / "stream.mp4"
            live.write_bytes(body)
            info = probe(live)
            vs = next(s for s in info["streams"] if s["codec_type"] == "video")
            assert [s for s in info["streams"] if s["codec_type"] == "audio"], "audio as AAC"
            # the stream starts exactly at 1.5 s of the source (the player shifts it there) and runs to the end
            assert abs(float(info["format"]["duration"]) - (src_dur - 1.5)) < 0.3, (info["format"], src_dur)
            sh([FFMPEG, "-v", "error", "-y", "-ss", "1.5", "-i", str(lib / "a.mp4"), "-frames:v", "1", str(tmp / "want.png")])
            sh([FFMPEG, "-v", "error", "-y", "-i", str(live), "-frames:v", "1", str(tmp / "got.png")])
            psnr = sh([FFMPEG, "-v", "info", "-i", str(tmp / "got.png"), "-i", str(tmp / "want.png"), "-lavfi", "psnr", "-f", "null", "-"]).stderr
            db = float(psnr.split("average:")[1].split()[0])
            assert db > 30, f"first frame is not the one at 1.5 s (PSNR {db} dB)"
            st, _, body = get(f"/v1/stream?k=s3cret&a=0&start=0&path={a_path}")
            (tmp / "stream-mute.mp4").write_bytes(body)
            assert not [s for s in probe(tmp / "stream-mute.mp4")["streams"] if s["codec_type"] == "audio"], "a=0 has no audio track"
        finally:
            media.httpd.shutdown()
        print(f"ok  helper media server: token, folder guard, fMP4 from exactly 1.5 s ({vs['width']}x{vs['height']}, first frame {db:.0f} dB)")

        # 6) a plan produced by the TypeScript frontend (multi-track, overlay, gap, transitions, speed)
        npx = shutil.which("npx")
        if not npx:
            print("skip TS plan (npx not found)")
        else:
            bundle = sh([npx, "esbuild", str(ROOT / "tests" / "samplePlan.ts"), "--bundle", "--platform=node", "--log-level=warning"], cwd=ROOT).stdout
            built = json.loads(sh(["node", "-"], input=bundle).stdout)
            assert built["warnings"] == [], built["warnings"]
            text = json.dumps(built["plan"])
            for key, path in {"{A}": a, "{B}": b, "{C}": c, "{M}": music}.items():
                text = text.replace(json.dumps(key)[1:-1], json.dumps(str(path))[1:-1])
            ts_plan = json.loads(text)
            kinds = [p["kind"] for p in ts_plan["pieces"]]
            assert {"clip", "xfade", "black"} <= set(kinds), kinds
            ts_path = tmp / "plan-ts.json"
            ts_path.write_text(json.dumps(ts_plan), encoding="utf-8")
            sh([sys.executable, str(BACKEND), "render", str(ts_path), "-o", str(tmp / "ts.mp4"), "--ffmpeg", FFMPEG, "--cache", str(cache)])
            check_output(tmp / "ts.mp4", ts_plan["totalFrames"])
            print(f"ok  TS-generated plan: {len(kinds)} pieces ({', '.join(kinds)}), {ts_plan['totalFrames']} frames")

            # 7) every beat and drop effect, worked out by the frontend, rendered for real (and again from the cache)
            bundle = sh([npx, "esbuild", str(ROOT / "tests" / "samplePlanFx.ts"), "--bundle", "--platform=node", "--log-level=warning"], cwd=ROOT).stdout
            text = json.dumps(json.loads(sh(["node", "-"], input=bundle).stdout)["plan"])
            for key, path in {"{A}": a, "{B}": b, "{M}": music}.items():
                text = text.replace(json.dumps(key)[1:-1], json.dumps(str(path))[1:-1])
            fx_plan = json.loads(text)
            used = {k for p in fx_plan["pieces"] for k in (p.get("fx") or {})}
            assert {"zoom", "shake", "hue", "echo", "tunnel", "glitch", "rgb", "invert", "strobe", "text"} <= used, used
            fx_path = tmp / "plan-fx.json"
            fx_path.write_text(json.dumps(fx_plan), encoding="utf-8")
            t0 = time.time()
            res = json.loads(sh([sys.executable, str(BACKEND), "render", str(fx_path), "-o", str(tmp / "fx.mp4"), "--ffmpeg", FFMPEG, "--jobs", "3", "--cache", str(cache)]).stdout)
            check_output(tmp / "fx.mp4", fx_plan["totalFrames"], expect_audio=True)
            again = json.loads(sh([sys.executable, str(BACKEND), "render", str(fx_path), "-o", str(tmp / "fx2.mp4"), "--ffmpeg", FFMPEG, "--cache", str(cache)]).stdout)
            assert again["cached"] == len(fx_plan["pieces"]), again
            # a strobe frame is white; outside the windows the picture is not
            starts, at = [], 0
            for p in fx_plan["pieces"]:
                starts.append(at)
                at += p["frames"]
            strobe = [s + w[0] for s, p in zip(starts, fx_plan["pieces"]) for w in (p.get("fx") or {}).get("strobe", [])]
            bright = frame_rgb(tmp / "fx.mp4", strobe[0])
            calm = frame_rgb(tmp / "fx.mp4", 30)
            assert min(bright) > 215 and min(calm) < 200, (strobe[0], bright, calm)
            print(f"ok  effects: {len(fx_plan['pieces'])} pieces with {', '.join(sorted(used))} – {res['seconds']} s, strobe frame {strobe[0]} white")

            # 7b) the same as a script (the words' font next to it)
            sdir = tmp / "script-fx"
            (sdir / "fonts").mkdir(parents=True)
            shutil.copy(ROOT / "plugin" / "assets" / "fonts" / "Anton-Regular.ttf", sdir / "fonts")
            script = sdir / ("render.cmd" if shell == "cmd" else "render.sh")
            body = sh([sys.executable, str(BACKEND), "script", str(fx_path), "--shell", shell]).stdout
            longest = max(len(line) for line in body.splitlines())
            assert longest < 8191, f"a line of the {shell} script is {longest} characters long"
            script.write_text(body, encoding="utf-8", newline="")
            sh(["cmd", "/c", str(script)] if shell == "cmd" else ["bash", str(script)], env=env, cwd=sdir)
            check_output(next(sdir.glob("*.mp4")), fx_plan["totalFrames"])
            print(f"ok  {shell} script with effects (longest line {longest} characters)")

            # 8) split screens: every layout, a black field, glowing dividers – rendered, cached, and as a script
            bundle = sh([npx, "esbuild", str(ROOT / "tests" / "samplePlanSplit.ts"), "--bundle", "--platform=node", "--log-level=warning"], cwd=ROOT).stdout
            built = json.loads(sh(["node", "-"], input=bundle).stdout)
            assert built["warnings"] == [], built["warnings"]
            text = json.dumps(built["plan"])
            for key, path in {"{A}": a, "{B}": b, "{C}": c, "{M}": music}.items():
                text = text.replace(json.dumps(key)[1:-1], json.dumps(str(path))[1:-1])
            sp_plan = json.loads(text)
            kinds = [p["kind"] for p in sp_plan["pieces"]]
            assert kinds.count("layout") == 5, kinds
            assert sp_plan["clipAudio"], "V3's sound in the fields"
            sp_path = tmp / "plan-split.json"
            sp_path.write_text(json.dumps(sp_plan), encoding="utf-8")
            res = json.loads(sh([sys.executable, str(BACKEND), "render", str(sp_path), "-o", str(tmp / "split.mp4"), "--ffmpeg", FFMPEG, "--jobs", "3", "--cache", str(cache)]).stdout)
            check_output(tmp / "split.mp4", sp_plan["totalFrames"])
            again = json.loads(sh([sys.executable, str(BACKEND), "render", str(sp_path), "-o", str(tmp / "split2.mp4"), "--ffmpeg", FFMPEG, "--cache", str(cache)]).stdout)
            assert again["cached"] == len(sp_plan["pieces"]), again

            def full_frame(path, n):
                r = subprocess.run([FFMPEG, "-v", "error", "-ss", f"{(n - 0.25) / FPS:.6f}", "-i", str(path), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True)
                assert len(r.stdout) == 640 * 360 * 3, f"frame {n} not decoded"
                return r.stdout

            def luma(d, x0, y0, x1, y1):
                vals = [0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] for y in range(y0, y1) for x in range(x0, x1) for i in [(y * 640 + x) * 3]]
                return sum(vals) / len(vals)

            # the 4-way (3 … 4.5 s): V4 has no clip – its field (bottom right) is black, the one of V1 (top left) is not
            quad = full_frame(tmp / "split.mp4", 112)
            assert luma(quad, 340, 200, 630, 350) < 12 and luma(quad, 10, 10, 300, 170) > 40, (luma(quad, 340, 200, 630, 350), luma(quad, 10, 10, 300, 170))
            # the 3-way's divider at x = 214 glows pink on the beat (2 s) and is dark again before the next one
            on, off = luma(full_frame(tmp / "split.mp4", 60), 214, 20, 215, 340), luma(full_frame(tmp / "split.mp4", 73), 214, 20, 215, 340)
            assert on > 60 and off < 40, (on, off)
            print(f"ok  split screens: {kinds.count('layout')} layout pieces, black field, dividers {off:.0f} -> {on:.0f} on the beat – {res['seconds']} s")

            sdir = tmp / "script-split"
            sdir.mkdir()
            script = sdir / ("render.cmd" if shell == "cmd" else "render.sh")
            body = sh([sys.executable, str(BACKEND), "script", str(sp_path), "--shell", shell]).stdout
            longest = max(len(line) for line in body.splitlines())
            assert longest < 8191, f"a line of the {shell} script is {longest} characters long"
            script.write_text(body, encoding="utf-8", newline="")
            sh(["cmd", "/c", str(script)] if shell == "cmd" else ["bash", str(script)], env=env, cwd=sdir)
            check_output(next(sdir.glob("*.mp4")), sp_plan["totalFrames"])
            print(f"ok  {shell} script with split screens (longest line {longest} characters)")
    print("all backend checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
