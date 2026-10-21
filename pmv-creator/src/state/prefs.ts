/** Per-browser preferences that are not part of a project. */
const KEY_ADVANCED = "pmv-creator:advanced";

/** Simple mode is the default: the editor shows what a PMV needs, the rest sits behind "Advanced". */
export function readAdvanced(): boolean {
  try {
    return localStorage.getItem(KEY_ADVANCED) === "1";
  } catch {
    return false;
  }
}

export function rememberAdvanced(on: boolean): void {
  try {
    localStorage.setItem(KEY_ADVANCED, on ? "1" : "0");
  } catch {
    /* private mode */
  }
}
