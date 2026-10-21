#!/usr/bin/env node
/**
 * Release packaging: builds, zips dist/pmv-creator (contents at the archive root, as Stash expects) into
 * release/pmv-creator-<version>.zip and writes release/index.yml – the manifest of a Stash plugin source,
 * so the folder can be served (or pushed to a gh-pages branch) and added under Settings → Plugins → Sources.
 *
 *   node tools/release.mjs [--no-build]
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = readFileSync(join(root, "plugin", "pmv-creator.yml"), "utf8");
const ymlVersion = /^version:\s*"?([^"\s]+)"?/m.exec(manifest)?.[1];
if (ymlVersion !== pkg.version) {
  console.error(`version mismatch: package.json ${pkg.version} vs plugin/pmv-creator.yml ${ymlVersion}`);
  process.exit(1);
}
const backendVersion = /^VERSION = "([^"]+)"/m.exec(readFileSync(join(root, "plugin", "backend", "pmv_backend.py"), "utf8"))?.[1];
if (backendVersion !== pkg.version) {
  console.error(`version mismatch: package.json ${pkg.version} vs plugin/backend/pmv_backend.py VERSION ${backendVersion}`);
  process.exit(1);
}
const name = /^name:\s*(.+)$/m.exec(manifest)?.[1]?.trim() ?? "PMV Creator";
const description = /^description:\s*(.+)$/m.exec(manifest)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";

if (!args.has("--no-build")) execSync("node build.mjs", { cwd: root, stdio: "inherit" });

const distDir = join(root, "dist", "pmv-creator");
if (!existsSync(join(distDir, "pmv-creator.yml"))) {
  console.error(`${distDir} has no pmv-creator.yml – build first`);
  process.exit(1);
}

// ---- minimal zip writer (deflate, fixed timestamp -> reproducible archives for identical content)
const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
// DOS time of the release date (2 s resolution) – the same for every entry
const now = new Date();
const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

function listFiles(dir, base = dir, out = []) {
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) listFiles(p, base, out);
    else out.push(relative(base, p).split("\\").join("/"));
  }
  return out;
}

function zip(dir) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const rel of listFiles(dir)) {
    const data = readFileSync(join(dir, rel));
    const nameBuf = Buffer.from(rel, "utf8");
    const packed = deflateRawSync(data, { level: 9 });
    const useDeflate = packed.length < data.length;
    const body = useDeflate ? packed : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // utf-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6); // needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, body);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, end]);
}

const releaseDir = join(root, "release");
mkdirSync(releaseDir, { recursive: true });
const zipName = `pmv-creator-${pkg.version}.zip`;
const archive = zip(distDir);
writeFileSync(join(releaseDir, zipName), archive);
const sha256 = createHash("sha256").update(archive).digest("hex");

// Stash's source index: one entry per package; `version` may carry a build suffix, `date` is "YYYY-MM-DD HH:MM:SS".
let suffix = "";
try {
  suffix = `-${execSync("git rev-parse --short HEAD", { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim()}`;
} catch {
  /* not a git checkout – plain version */
}
const pad = (n) => String(n).padStart(2, "0");
const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
const index = [
  `- id: pmv-creator`,
  `  name: ${name}`,
  `  metadata:`,
  `    description: ${JSON.stringify(description)}`,
  `  version: ${pkg.version}${suffix}`,
  `  date: ${date}`,
  `  path: ${zipName}`,
  `  sha256: ${sha256}`,
  `  requires: []`,
  ``,
].join("\n");
writeFileSync(join(releaseDir, "index.yml"), index);

console.log(`${relative(root, join(releaseDir, zipName))}  ${(archive.length / 1024).toFixed(0)} kB  sha256 ${sha256.slice(0, 12)}…`);
console.log(`${relative(root, join(releaseDir, "index.yml"))}  (version ${pkg.version}${suffix})`);
