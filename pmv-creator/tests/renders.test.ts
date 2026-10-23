// @vitest-environment jsdom
/** The render watch (src/ui/renders.ts) against a scripted Stash: states, labels, restarts, persistence. */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

const jobs = new Map<string, Array<Record<string, unknown> | null>>();
const results = new Map<string, unknown>();
const labels: unknown[] = [];
const scenes = new Map<string, { id: string }>();

vi.mock("../src/stash/backend", () => ({
  RENDER_TASK: "Render PMV",
  findJob: async (id: string) => {
    const seq = jobs.get(id) ?? [null];
    return seq.length > 1 ? seq.shift()! : seq[0];
  },
  renderResult: async (id: string) => {
    const r = results.get(id);
    return (typeof r === "function" ? r() : r) ?? null;
  },
}));
vi.mock("../src/ui/labels", () => ({
  queueLabel: (job: unknown) => labels.push(job),
  watchLabel: () => () => undefined,
  waitForScene: async (path: string) => scenes.get(path) ?? null,
}));

const job = (status: string, progress: number | null = null, addTime = "2026-10-23T06:00:00Z", description = "Running plugin task: Render PMV") => ({ id: "x", status, progress, description, error: null, addTime });
const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
};

describe("render watch", () => {
  let w: typeof import("../src/ui/renders");
  beforeEach(async () => {
    vi.resetModules();
    localStorage.clear();
    jobs.clear();
    results.clear();
    labels.length = 0;
    scenes.clear();
    w = await import("../src/ui/renders");
    w.setPollInterval(5);
  });
  afterEach(() => vi.restoreAllMocks());

  const start = (renderId: string, jobId: string, extra: Record<string, unknown> = {}) =>
    w.watchRender({ jobId, renderId, name: `PMV ${renderId}`, projectId: "p1", pc: null, label: { title: "T", details: "D", sceneIds: ["1"] }, ...extra });

  it("follows a render from the queue to done and labels the scanned video", async () => {
    jobs.set("1", [job("READY"), job("RUNNING", 0.4), job("FINISHED", 1)]);
    results.set("r1", { status: "done", file: "/renders/a.mp4", scanned: true });
    const seen: string[] = [];
    const off = w.subscribeRenders(() => seen.push(`${w.getRender("r1")?.state}:${w.getRender("r1")?.progress}`));
    onTestFinished(() => void off());
    start("r1", "1");
    await until(() => w.getRender("r1")!.state === "done");
    expect(seen).toContain("running:0.4");
    expect(w.getRender("r1")).toMatchObject({ file: "/renders/a.mp4", seen: false });
    expect(labels).toEqual([expect.objectContaining({ path: "/renders/a.mp4", title: "T", sceneIds: ["1"] })]);
    // kept per browser
    expect(JSON.parse(localStorage.getItem("pmv-creator:renders")!)[0]).toMatchObject({ renderId: "r1", state: "done" });
    w.markSeen();
    expect(w.getRender("r1")!.seen).toBe(true);
  });

  it("labels a PC render under the path Stash sees, and not at all without a scan", async () => {
    jobs.set("2", [job("FINISHED", 1)]);
    results.set("r2", { status: "done", file: "I:\\PMVs\\b.mp4", stashFile: "/data/PMVs/b.mp4", scanned: true, helper: "PC" });
    jobs.set("3", [job("FINISHED", 1)]);
    results.set("r3", { status: "done", file: "C:\\out\\c.mp4" });
    start("r2", "2", { pc: "PC" });
    start("r3", "3");
    await until(() => w.listRenders().every((r) => r.state === "done"));
    expect(w.getRender("r2")!.file).toBe("/data/PMVs/b.mp4");
    expect(labels).toEqual([expect.objectContaining({ path: "/data/PMVs/b.mp4" })]);
  });

  it("tells a cancelled render, a failed one and one that Stash lost apart", async () => {
    jobs.set("4", [job("CANCELLED")]);
    results.set("r4", { status: "error", error: "Cancelled" });
    jobs.set("5", [job("FAILED")]);
    results.set("r5", { status: "error", error: "ffmpeg exploded" });
    // Stash restarted: job 6 is now somebody else's scan, the result file still says running
    jobs.set("6", [job("RUNNING", 0.1), job("RUNNING", 0.1, "2026-10-23T09:00:00Z", "Scanning…")]);
    results.set("r6", { status: "running" });
    for (const [r, j] of [["r4", "4"], ["r5", "5"], ["r6", "6"]]) start(r, j);
    await until(() => !w.listRenders().some(w.isActive));
    expect(w.getRender("r4")!.state).toBe("cancelled");
    expect(w.getRender("r5")).toMatchObject({ state: "error", error: "ffmpeg exploded" });
    expect(w.getRender("r6")!.state).toBe("error");
    expect(w.getRender("r6")!.error).toMatch(/restarted/);
    expect(labels).toEqual([]);
    w.forgetFinished("r5");
    expect(w.listRenders().map((r) => r.renderId).sort()).toEqual(["r4", "r6"]);
    w.forgetFinished();
    expect(w.listRenders()).toEqual([]);
  });

  it("ends a render that Stash killed before it could write its result", async () => {
    // stopped: Stash kills the task on Windows – the result file still says "running"
    jobs.set("10", [job("RUNNING", 0.9), job("CANCELLED", 0.92)]);
    results.set("r10", { status: "running" });
    // crashed: FAILED, nothing written either
    jobs.set("11", [job("RUNNING", 0.2), job("FAILED", 0.2)]);
    results.set("r11", { status: "running" });
    // finished, but the result came a moment late
    jobs.set("12", [job("FINISHED", 1)]);
    let looks = 0;
    results.set("r12", { status: "running" });
    start("r10", "10");
    start("r11", "11");
    start("r12", "12");
    await until(() => w.getRender("r10")!.state !== "running" && w.getRender("r11")!.state !== "running" && ++looks > 0);
    results.set("r12", { status: "done", file: "/renders/late.mp4" });
    await until(() => !w.listRenders().some(w.isActive));
    expect(w.getRender("r10")).toMatchObject({ state: "cancelled" });
    expect(w.getRender("r11")!.state).toBe("error");
    expect(w.getRender("r11")!.error).toMatch(/failed/);
    expect(w.getRender("r12")).toMatchObject({ state: "done", file: "/renders/late.mp4" });
  });

  it("does not finish a render twice when another tab got there first", async () => {
    jobs.set("13", [job("FINISHED", 1)]);
    // while this tab asks for the result, the other tab finishes the render (and labels it)
    results.set("r13", () => {
      const list = JSON.parse(localStorage.getItem("pmv-creator:renders")!);
      localStorage.setItem("pmv-creator:renders", JSON.stringify(list.map((r: { renderId: string }) => (r.renderId === "r13" ? { ...r, state: "done", file: "/x.mp4", seen: true } : r))));
      return { status: "done", file: "/x.mp4", scanned: true };
    });
    start("r13", "13");
    await until(() => w.getRender("r13")!.state === "done");
    await new Promise((r) => setTimeout(r, 30));
    expect(labels).toEqual([]);
    expect(w.getRender("r13")!.seen).toBe(true);
  });

  it("keeps renders that are still on their way when the list is long", async () => {
    for (let i = 0; i < 45; i++) jobs.set(`q${i}`, [job("READY")]);
    for (let i = 0; i < 45; i++) start(`rq${i}`, `q${i}`);
    expect(w.listRenders().filter(w.isActive)).toHaveLength(45);
  });

  it("finds the scene of a render that was scanned while the editor was closed", async () => {
    localStorage.setItem("pmv-creator:renders", JSON.stringify([{ jobId: "20", renderId: "r20", name: "Night", projectId: "p", pc: null, label: null, started: Date.now(), state: "done", progress: 1, file: "/renders/n.mp4", result: { status: "done", scanned: true } }]));
    scenes.set("/renders/n.mp4", { id: "55" });
    vi.resetModules();
    w = await import("../src/ui/renders");
    w.resumeRenders();
    await until(() => w.getRender("r20")!.sceneId === "55");
  });

  it("shares the list with another tab instead of overwriting it", async () => {
    jobs.set("8", [job("RUNNING", 0.3)]);
    start("r8", "8");
    // the other tab (Stash UI next to classic Stash) adds its render
    const other = JSON.parse(localStorage.getItem("pmv-creator:renders")!);
    localStorage.setItem("pmv-creator:renders", JSON.stringify([{ jobId: "9", renderId: "r9", name: "Other", projectId: "p2", pc: null, label: null, started: Date.now(), state: "done", progress: 1 }, ...other]));
    window.dispatchEvent(new StorageEvent("storage", { key: "pmv-creator:renders" }));
    await until(() => w.getRender("r8")!.progress === 0.3);
    expect(w.listRenders().map((r) => r.renderId).sort()).toEqual(["r8", "r9"]);
  });

  it("picks up renders that were on their way when the editor was closed", async () => {
    localStorage.setItem("pmv-creator:renders", JSON.stringify([{ jobId: "7", renderId: "r7", name: "Night", projectId: "p", pc: "PC", label: null, started: Date.now(), state: "running", progress: 0.2 }]));
    jobs.set("7", [job("RUNNING", 0.9), null]);
    results.set("r7", { status: "done", file: "/renders/n.mp4" });
    vi.resetModules();
    w = await import("../src/ui/renders");
    w.setPollInterval(5);
    w.resumeRenders();
    await until(() => w.getRender("r7")!.state === "done");
  });
});
