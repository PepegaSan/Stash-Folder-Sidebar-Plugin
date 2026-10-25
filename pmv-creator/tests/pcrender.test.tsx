// @vitest-environment jsdom
/** Starting the render helper from the editor: pmvhelper://start opens in a hidden frame, the page stays. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { HELPER_SCHEME, launchHelper } from "../src/ui/PcRender";

afterEach(() => vi.useRealTimers());

describe("start helper from the editor", () => {
  it("opens pmvhelper://start in a hidden frame and takes the frame away again", () => {
    vi.useFakeTimers();
    launchHelper();
    const f = document.querySelector("iframe")!;
    expect(f).toBeTruthy();
    expect(f.getAttribute("src")).toBe(`${HELPER_SCHEME}://start`);
    expect(f.style.display).toBe("none");
    vi.advanceTimersByTime(6000);
    expect(document.querySelector("iframe")).toBeNull();
  });
});
