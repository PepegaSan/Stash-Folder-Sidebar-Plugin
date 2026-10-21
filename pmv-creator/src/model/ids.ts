export function uid(prefix: string): string {
  const c = globalThis.crypto;
  const raw =
    c && typeof c.randomUUID === "function"
      ? c.randomUUID().replace(/-/g, "")
      : Math.random().toString(16).slice(2) + Date.now().toString(16);
  return `${prefix}_${raw.slice(0, 12)}`;
}
