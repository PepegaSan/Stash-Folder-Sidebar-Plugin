// @vitest-environment jsdom
/** Helper setup: native external-protocol start link and repeatable downloads. */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HELPER_SCHEME, PcRender, helperFor } from "../src/ui/PcRender";
import type { RenderHelper } from "../src/stash/backend";

afterEach(() => vi.useRealTimers());

describe("render helper download", () => {
  const BrowserURL = URL;
  const template = 'VERSION = "0.9.16"\nHELPER_DEFAULTS: Dict[str, str] = {}';
  const helper: RenderHelper = { id: "pc", name: "Test PC", online: true, version: "0.9.15", lastSeen: 1, config: { outputDir: "", mappings: [] } };
  let root: ReturnType<typeof createRoot> | null;
  let container: HTMLDivElement;
  let known: RenderHelper[];
  let listError: boolean;
  let templateResponse: () => Promise<Response>;
  let requests: Array<{ url: string; options?: RequestInit }>;
  let downloads: Array<{ url: string; name: string }>;
  let blobs: Blob[];
  const button = (text: string) => Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes(text))!;
  const saveLink = () => container.querySelector<HTMLAnchorElement>("a[download]")!;
  const click = async (element: HTMLElement) => { await act(async () => element.click()); };
  const mount = async () => {
    root = createRoot(container);
    await act(async () => root!.render(<PcRender disabled={false} onHelper={() => {}} needs={helperFor({ split: true, looks: true })} />));
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    known = [];
    listError = false;
    requests = [];
    downloads = [];
    blobs = [];
    root = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    templateResponse = async () => new Response(template);
    vi.stubGlobal("URL", class extends BrowserURL {
      static createObjectURL = vi.fn((blob: Blob) => { blobs.push(blob); return `blob:helper-${blobs.length}`; });
      static revokeObjectURL = vi.fn();
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push({ url: this.href, name: this.download });
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
      requests.push({ url, options });
      if (url.endsWith("/graphql")) {
        if (listError) throw new Error("helper list unavailable");
        return new Response(JSON.stringify({ data: { runPluginOperation: known } }));
      }
      return templateResponse();
    }));
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("starts through a native protocol link without embedding a frame or claiming a connection", async () => {
    await mount();
    const start = container.querySelector<HTMLAnchorElement>(`a[href="${HELPER_SCHEME}://start"]`)!;
    expect(start).not.toBeNull();
    expect(start.target).toBe("_self");
    expect(start.hasAttribute("download")).toBe(false);
    let preventedBeforeTest = true;
    const observe = (event: MouseEvent) => {
      preventedBeforeTest = event.defaultPrevented;
      event.preventDefault(); // The test observes navigation intent without asking the OS to launch an app.
    };
    document.addEventListener("click", observe, { once: true });
    await act(async () => start.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    expect(preventedBeforeTest).toBe(false);
    expect(container.textContent).toContain("Start requested. Confirm the browser's prompt");
    expect(container.textContent).not.toContain("Starting –");
    expect(document.querySelector("iframe")).toBeNull();
    expect(requests.filter((r) => r.url.endsWith(".py"))).toHaveLength(0);
    expect(downloads).toHaveLength(0);
  });

  it("offers another download and a reusable save link without claiming the file was saved", async () => {
    await mount();
    await click(button("Download render helper"));
    expect(downloads).toEqual([{ url: "blob:helper-1", name: "pmv-render-helper.pyw" }]);
    expect(container.textContent).toContain("Download requested.");
    expect(container.textContent).not.toContain("Downloaded –");
    expect(button("Download render helper again").disabled).toBe(false);
    expect(saveLink().href).toBe("blob:helper-1");
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    await click(saveLink());
    expect(downloads).toHaveLength(2);
    expect(requests.filter((r) => r.url.endsWith(".py"))).toHaveLength(1);
    await click(button("Download render helper again"));
    expect(downloads[2]).toEqual({ url: "blob:helper-2", name: "pmv-render-helper.pyw" });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:helper-1");
    expect(requests.filter((r) => r.url.endsWith(".py"))).toHaveLength(2);
    expect(requests.filter((r) => r.url.endsWith(".py")).every((r) => r.options?.cache === "no-store" && r.options?.credentials === "same-origin")).toBe(true);
    await act(async () => root!.unmount());
    root = null;
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:helper-2");
  });

  it.each(["0.9.15", "0.9.4"])("keeps download available with connected helper %s", async (version) => {
    known = [{ ...helper, version }];
    await mount();
    expect(container.textContent).toContain("Test PC");
    expect(container.textContent).toContain("quit the connected helper first");
    expect(container.querySelectorAll(".pmv-helper-download")).toHaveLength(1);
    await click(button("Download render helper again"));
    expect(downloads).toHaveLength(1);
  });

  it("shows download even when known PCs hide the initial setup instructions", async () => {
    known = [{ ...helper, online: false }];
    await mount();
    expect(container.textContent).not.toContain("Needs Python 3");
    await click(button("Download render helper"));
    expect(downloads).toHaveLength(1);
  });

  it("still allows downloading when the helper list fails", async () => {
    listError = true;
    await mount();
    expect(container.textContent).toContain("helper list unavailable");
    await click(button("Download render helper"));
    expect(downloads).toHaveLength(1);
  });

  it("allows retrying a failed request and only disables buttons while it is pending", async () => {
    templateResponse = async () => new Response("failed", { status: 503 });
    await mount();
    await click(button("Download render helper"));
    expect(container.textContent).toContain("HTTP 503");
    expect(button("Download render helper").disabled).toBe(false);
    let resolve!: (r: Response) => void;
    templateResponse = () => new Promise((r) => { resolve = r; });
    await click(button("Download render helper"));
    expect(button("Preparing download").disabled).toBe(true);
    expect(button("with a window").disabled).toBe(true);
    await act(async () => resolve(new Response(template)));
    expect(container.textContent).not.toContain("HTTP 503");
    expect(downloads).toHaveLength(1);
  });

  it("offers the console file and invalidates the old link after an API key change", async () => {
    vi.useRealTimers();
    await mount();
    await click(button("Stash with a login?"));
    const input = container.querySelector<HTMLInputElement>("input[type=password]")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setValue.call(input, "test-key"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await click(button("with a window"));
    expect(saveLink().download).toBe("pmv-render-helper.py");
    // Read the actual Blob built from the backend template, including filled-in connection details.
    const contents = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blobs[0]);
    });
    expect(contents).toContain('"apiKey":"test-key"');
    expect(contents).toContain(`"stash":"${window.location.origin}"`);
    await act(async () => { setValue.call(input, "replacement-key"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(saveLink()).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:helper-1");
  });

  it("keeps the prepared file when polling switches from offline to connected", async () => {
    await mount();
    await click(button("Download render helper"));
    known = [helper];
    await act(async () => { vi.advanceTimersByTime(4000); });
    expect(container.textContent).toContain("Test PC");
    expect(saveLink().href).toBe("blob:helper-1");
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it("does not start a late download after closing the dialog", async () => {
    let resolve!: (r: Response) => void;
    templateResponse = () => new Promise((r) => { resolve = r; });
    await mount();
    await click(button("Download render helper"));
    await act(async () => root!.unmount());
    root = null;
    await act(async () => resolve(new Response(template)));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(downloads).toHaveLength(0);
  });
});
