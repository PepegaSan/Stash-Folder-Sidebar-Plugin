#!/usr/bin/env node
/**
 * Compares the t("…") keys used in src/ with the locale dictionaries in src/locales/.
 * Exit code 1 when a locale misses a key. `--list` prints every key found in the sources.
 *
 *   node tools/i18n-check.mjs [--list] [--unused]
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const args = new Set(process.argv.slice(2));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** t("text"), t('text'), t(`text`) – the key is always a plain literal (no interpolation inside the key). */
const CALL = /(?<![\w.])t\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\$]|\\.)*)`)/g;
/** tn(n, "{n} clips", "1 clip") – two literal keys. */
const PLURAL = /(?<![\w.])tn\([^,()]+,\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"/g;
/** MOODS labels (src/generator/generate.ts) are keys resolved at render time. */
const MOOD_LABEL = /label:\s*"((?:[^"\\]|\\.)*)"/g;

const unescape = (s) => s.replace(/\\(.)/g, "$1");
const used = new Map(); // key -> first file
for (const file of walk(srcDir)) {
  if (file.includes(`${join("src", "locales")}`)) continue;
  const text = readFileSync(file, "utf8");
  const rel = file.slice(root.length + 1);
  for (const m of text.matchAll(CALL)) {
    const key = unescape(m[1] ?? m[2] ?? m[3] ?? "");
    if (key && !used.has(key)) used.set(key, rel);
  }
  for (const m of text.matchAll(PLURAL)) for (const key of [unescape(m[1]), unescape(m[2])]) if (!used.has(key)) used.set(key, rel);
  if (rel.endsWith(join("generator", "generate.ts"))) {
    for (const m of text.matchAll(MOOD_LABEL)) if (!used.has(m[1])) used.set(unescape(m[1]), rel);
  }
}

if (args.has("--list")) {
  for (const [key, file] of [...used].sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]))) console.log(`${file}\t${JSON.stringify(key)}`);
  console.log(`\n${used.size} keys`);
}

// the dictionaries are TypeScript – strip the type annotation and the export so Node can evaluate them
async function loadLocale(file) {
  const ts = readFileSync(file, "utf8");
  const js = ts.replace(/^\s*const\s+(\w+)\s*:\s*[^=]+=\s*/m, "const $1 = ").replace(/\s+satisfies\s+[\w<>, ]+/g, "");
  const mod = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
  return mod.default;
}

let failed = false;
const localeDir = join(srcDir, "locales");
const locales = existsSync(localeDir) ? readdirSync(localeDir).filter((n) => /^[a-z]{2}\.ts$/.test(n)).sort() : [];
for (const name of locales) {
  const dict = await loadLocale(join(localeDir, name));
  const keys = new Set(Object.keys(dict));
  const missing = [...used.keys()].filter((k) => !keys.has(k));
  const unused = [...keys].filter((k) => !used.has(k));
  const empty = [...keys].filter((k) => !String(dict[k]).trim());
  console.log(`${name}: ${keys.size} entries, ${missing.length} missing, ${unused.length} unused, ${empty.length} empty`);
  for (const k of missing) console.log(`  missing  ${JSON.stringify(k)}  (${used.get(k)})`);
  for (const k of empty) console.log(`  empty    ${JSON.stringify(k)}`);
  if (args.has("--unused")) for (const k of unused) console.log(`  unused   ${JSON.stringify(k)}`);
  // every {var} of the key has to survive the translation
  for (const k of keys) {
    if (!used.has(k)) continue;
    const vars = [...k.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    const lost = vars.filter((v) => !String(dict[k]).includes(`{${v}}`));
    if (lost.length) {
      console.log(`  vars     ${JSON.stringify(k)} loses {${lost.join("}, {")}}`);
      failed = true;
    }
  }
  if (missing.length || empty.length) failed = true;
}
process.exit(failed ? 1 : 0);
