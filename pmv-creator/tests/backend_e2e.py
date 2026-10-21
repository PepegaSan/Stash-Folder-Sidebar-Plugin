"""End-to-end test of the Python backend with real FFmpeg renders (no Stash needed).

    python tests/backend_e2e.py

Generates synthetic sources (different sizes, frame rates, with/without audio), renders a plan
that covers every piece type, and checks frame count, format, audio, the segment cache, the
generated FFmpeg script and the raw plugin interface (stdin/stdout JSON).
"""
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "plugin" / "backend" / "pmv_backend.py"
FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")
FPS = 30


def sh(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
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
        try:
            call({"op": "load_project", "id": "../../etc/passwd"})
            raise AssertionError("path traversal not rejected")
        except AssertionError as e:
            assert "invalid" in str(e), e
        print(f"ok  plugin ops (projects, chunked upload, recording saved, {len(kf)} keyframes, id validation)")

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
    print("all backend checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
