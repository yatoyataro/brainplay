import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";

const DIST = new URL("../dist", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const ASSETS = join(DIST, "assets");
const MAX_SHELL_GZIP_BYTES = 250 * 1024; // REQ-NFR-001: < 250 KB gzipped initial shell
const MAX_PAGES_FILE_BYTES = 25 * 1024 * 1024; // Cloudflare Pages 25 MiB per-file hard limit

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const indexHtml = readFileSync(join(DIST, "index.html"), "utf8");
const entryMatches = Array.from(indexHtml.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g));
let initialShellGzipBytes = 0;
for (const m of entryMatches) {
  const rel = m[1].replace(/^\//, "");
  initialShellGzipBytes += gzipSync(readFileSync(join(DIST, rel))).byteLength;
}

let allAssetsGzipBytes = 0;
for (const file of walk(ASSETS)) {
  if (file.endsWith(".js") || file.endsWith(".css")) {
    allAssetsGzipBytes += gzipSync(readFileSync(file)).byteLength;
  }
}

let maxFileBytes = 0;
let maxFileRel = "";
for (const file of walk(DIST)) {
  const size = statSync(file).size;
  if (size > maxFileBytes) {
    maxFileBytes = size;
    maxFileRel = relative(DIST, file);
  }
  if (size > MAX_PAGES_FILE_BYTES) {
    console.error(`FAIL: ${relative(DIST, file)} is ${size} bytes (> 25 MiB Pages limit)`);
    process.exit(1);
  }
}

console.log(
  `Initial JS+CSS shell gzipped: ${(initialShellGzipBytes / 1024).toFixed(2)} KB (all lazy chunks combined: ${(allAssetsGzipBytes / 1024).toFixed(2)} KB; limit: 250.00 KB)`
);
console.log(
  `Largest Pages file: ${maxFileRel} (${(maxFileBytes / 1024).toFixed(2)} KB, limit: 25600.00 KB)`
);

if (initialShellGzipBytes >= MAX_SHELL_GZIP_BYTES || allAssetsGzipBytes >= MAX_SHELL_GZIP_BYTES) {
  console.error(`FAIL: JS+CSS gzipped size exceeds 250 KB budget`);
  process.exit(1);
}

console.log("BUNDLE BUDGET CHECK PASSED.");
