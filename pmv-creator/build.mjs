// Bundles the UI into dist/pmv-creator/ and copies manifest + backend next to it.
// dist/pmv-creator/ is the folder that goes into <stash>/plugins/.
// Nothing is deleted here on purpose: an installed copy keeps its data/ and assets/media/ folders.
import * as esbuild from "esbuild";
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

const watch = process.argv.includes("--watch");
// --out <dir>: e.g. ../plugins/pmv-creator in the plugin repository (the folder GitHub Pages zips)
const outArg = process.argv.indexOf("--out");
const outDir = path.resolve(outArg >= 0 && process.argv[outArg + 1] ? process.argv[outArg + 1] : "dist/pmv-creator");

async function copyStatic() {
  await mkdir(outDir, { recursive: true });
  await cp("plugin", outDir, { recursive: true });
  await cp("schema", path.join(outDir, "schema"), { recursive: true });
  // the editor offers the backend as render helper for a PC – ui.assets serves only assets/
  await mkdir(path.join(outDir, "assets", "helper"), { recursive: true });
  await cp("plugin/backend/pmv_backend.py", path.join(outDir, "assets", "helper", "pmv_backend.py"));
}

const shared = {
  bundle: true,
  target: ["es2020"],
  outdir: outDir,
  jsxFactory: "React.createElement",
  jsxFragment: "React.Fragment",
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  legalComments: "none",
  logLevel: "info",
};

/** Classic Stash: Stash provides React; a second copy would break hooks inside Stash's tree. */
const classic = {
  ...shared,
  entryPoints: { "pmv-creator": "src/index.tsx" },
  format: "iife",
  alias: { react: path.resolve("src/shims/react.ts"), "react-dom": path.resolve("src/shims/react-dom.ts") },
};

/** Stash UI extension module: an ES module with its own React, served at /plugin/pmv-creator/assets/stashui.js. */
const stashui = {
  ...shared,
  entryPoints: { "assets/stashui": "src/stashui.tsx" },
  format: "esm",
  define: { "process.env.NODE_ENV": '"production"' },
};

await copyStatic();
if (watch) {
  for (const options of [classic, stashui]) {
    const ctx = await esbuild.context({
      ...options,
      plugins: [{ name: "copy-static", setup: (b) => b.onEnd(() => copyStatic()) }],
    });
    await ctx.watch();
  }
} else {
  await esbuild.build(classic);
  await esbuild.build(stashui);
}
