// Builds a seed for test/compare-browser.mjs: real saved industry runs (and any written company or fund analyses),
// read from a checkout of the exports branch, in the shape the page keeps in its browser storage.
//   node test/make-seed.mjs <exports dir> "Beverages - Non-Alcoholic,Food Confectioners" [KO,VAW] > /tmp/seed.json
// <exports dir> holds runs/*.json.gz (and portfolios/*.json.gz for the analyses). Get one with:
//   git fetch --depth=1 --filter=blob:none origin exports && git worktree add --no-checkout /tmp/exp origin/exports \
//     && (cd /tmp/exp && git sparse-checkout set --no-cone /runs/ /portfolios/ && git checkout)
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";

const [dir, names = "", syms = ""] = process.argv.slice(2);
if (!dir || !names) { console.error('Usage: node test/make-seed.mjs <exports dir> "Industry A,Industry B" [SYM,SYM]'); process.exit(2); }
const want = new Set(names.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean)), seed = {}, index = [];
const gz = (f) => JSON.parse(gunzipSync(readFileSync(f)).toString());
for (const f of readdirSync(join(dir, "runs")).filter((f) => /\.json\.gz$/.test(f) && !/-\d{6,}\.json\.gz$/.test(f))) {
  const j = gz(join(dir, "runs", f));
  for (const [k, v] of Object.entries(j.records || {})) if (k.startsWith("run:") && want.has(String(v?.name || "").toLowerCase())) {
    seed[k] = v; index.push({ slug: k.slice(4), name: v.name, saved_at: v.saved_at, missing: [], running: false }); }
}
seed.index = index;
for (const sym of syms.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean)) for (const [pre, key] of [["co-", "co:"], ["fd-", "fundFull:"]]) {
  const f = join(dir, "portfolios", `${pre}${sym.replace(/[^A-Z0-9]/g, "_")}.json.gz`); if (!existsSync(f)) continue;
  const j = gz(f); if (j?.rec) seed[(j.rec.bond ? "bondFull:" : key) + sym] = j.rec; }
console.error(`${index.length} industry runs, ${Object.keys(seed).length - 1 - index.length} written analyses`);
process.stdout.write(JSON.stringify(seed));
