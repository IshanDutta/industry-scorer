#!/usr/bin/env node
/*
 * Pack the newest GitHub exports for the Industry Scorer page (the "Update everything from GitHub" button).
 *
 *   node runner/pack-page.mjs --exports <checkout of the exports branch> --out <dir> [--current <the page's runs/index.json>]
 *
 * Every sector's run (exports branch, runs/<sector>.json.gz) becomes base64 text the page can carry as a file
 * (pages can't carry .gz files), split in two when it would pass the 16 MB file limit. With --current, only the
 * sectors GitHub has a newer copy of than the page are written. It writes:
 *   <out>/<sector>.b64.txt   the changed sectors' files
 *   <out>/index.json         the page's full new index (what the page reads to know what it carries)
 *   <out>/plan.json          { changed, unchanged, batches: [[file, ...], ...] (each under 55 MB, to publish in
 *                              turn), remove: [old files no longer listed], index: "index.json", commit }
 * No dependencies beyond Node.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";

const arg = (k) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : null; };
const EXP = arg("exports"), OUT = arg("out"), CUR = arg("current");
if (!EXP || !OUT) { console.error("usage: --exports <dir> --out <dir> [--current <index.json>]"); process.exit(2); }
mkdirSync(OUT, { recursive: true });
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const LIMIT = 15.5e6, HARD = 15.9e6, BATCH = 55e6;

const cur = CUR && existsSync(CUR) ? JSON.parse(readFileSync(CUR, "utf8")) : { files: [] };
const curAt = {}; for (const f of cur.files || []) if (f.sector) curAt[f.sector] = f.exported_at || "";
let commit = null; try { commit = execFileSync("git", ["-C", EXP, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(); } catch {}

const runsDir = join(EXP, "runs");
// The sector files only (dated backups like technology-20261101.json.gz are skipped).
const names = readdirSync(runsDir).filter((f) => /\.json\.gz$/.test(f) && !/-\d{6,}\.json\.gz$/.test(f)).sort();
const files = [], changed = [], unchanged = [], written = [];
for (const f of names) {
  let j; try { j = JSON.parse(gunzipSync(readFileSync(join(runsDir, f)))); } catch (e) { console.error(`${f}: unreadable (${e.message}); skipped`); continue; }
  if (!j?.sector || !j.records) { console.error(`${f}: not a sector export; skipped`); continue; }
  const keep = curAt[j.sector] && j.exported_at && j.exported_at <= curAt[j.sector];
  if (keep) { unchanged.push(j.sector); files.push(...cur.files.filter((x) => x.sector === j.sector)); continue; }
  const base = { format: j.format, v: j.v, sector: j.sector, exported_at: j.exported_at, finished: j.finished };
  const keys = Object.keys(j.records), runs = keys.filter((k) => k.startsWith("run:")), other = keys.filter((k) => !k.startsWith("run:"));
  const enc = (recs) => gzipSync(Buffer.from(JSON.stringify({ ...base, records: recs })), { level: 9 }).toString("base64");
  const pick = (ks) => Object.fromEntries(ks.map((k) => [k, j.records[k]]));
  // Split into as many parts as it takes to keep each file under the limit (the shared records go in part 1).
  let n = 1, parts, encoded;
  for (;;) {
    const per = Math.ceil(runs.length / n);
    parts = Array.from({ length: n }, (_, i) => pick([...(i === 0 ? other : []), ...runs.slice(i * per, (i + 1) * per)]));
    encoded = parts.map(enc);
    if (encoded.every((b) => b.length <= LIMIT) || n >= Math.max(1, runs.length)) break;
    n++;
  }
  encoded.forEach((b, i) => {
    const path = slug(j.sector) + (n > 1 ? "-" + (i + 1) : "") + ".b64.txt";
    if (b.length > HARD) throw new Error(`${path} is ${(b.length / 1e6).toFixed(1)} MB, over the page's file limit`);
    writeFileSync(join(OUT, path), b); written.push({ path, bytes: b.length });
    files.push({ sector: j.sector, path, exported_at: j.exported_at, finished: j.finished, industries: Object.keys(parts[i]).filter((k) => k.startsWith("run:")).length, ...(n > 1 ? { part: i + 1, parts: n } : {}) });
  });
  changed.push(j.sector);
  console.log(`${j.sector}: ${n} file${n > 1 ? "s" : ""}, exported ${j.exported_at}`);
}
// Sectors the page has that GitHub no longer exports stay as they are.
for (const x of cur.files || []) if (x.sector && !files.some((y) => y.sector === x.sector)) { files.push(x); if (!unchanged.includes(x.sector)) unchanged.push(x.sector); }

const batches = []; let b = [], size = 0;
for (const w of written) { if (b.length && size + w.bytes > BATCH) { batches.push(b); b = []; size = 0; } b.push(w.path); size += w.bytes; }
if (b.length) batches.push(b);
const listed = new Set(files.map((x) => x.path)), remove = (cur.files || []).map((x) => x.path).filter((p) => !listed.has(p));
writeFileSync(join(OUT, "index.json"), JSON.stringify({ files, copied_at: new Date().toISOString(), commit }));
writeFileSync(join(OUT, "plan.json"), JSON.stringify({ changed, unchanged, batches, remove, index: "index.json", commit }, null, 2));
console.log(changed.length ? `Changed: ${changed.join(", ")} (${written.length} files in ${batches.length} publish${batches.length === 1 ? "" : "es"})` : "Nothing newer on GitHub.");
