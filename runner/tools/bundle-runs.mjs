// Turn the latest exported runs (runs/<slug>.json.gz from the exports branch) into the
// page's bundled copies: web/runs/<slug>.b64.txt + web/runs/index.json, and check each one.
// Usage: node bundle-runs.mjs <dir with <slug>.json.gz> <web/runs dir>
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const [src, out] = process.argv.slice(2);
if (!src || !out) { console.error("usage: node bundle-runs.mjs <src dir> <web/runs dir>"); process.exit(2); }
fs.mkdirSync(out, { recursive: true });

const files = fs.readdirSync(src).filter((f) => /^[a-z-]+\.json\.gz$/.test(f)).sort();
const index = [];
let bad = 0;
for (const f of files) {
  const slug = f.replace(/\.json\.gz$/, "");
  const full = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(src, f))));
  const records = {};
  for (const [k, v] of Object.entries(full.records || {})) {
    // keep the finished results; drop the sector's working notes (sector:<slug>:...), the sampler and the library
    if (k.startsWith("run:") || k.startsWith("calls:") || !/^sector:[^:]+:/.test(k)) records[k] = v;
  }
  const slim = { format: full.format, v: full.v, sector: full.sector, exported_at: full.exported_at, finished: full.finished, records };

  // checks: every live industry has its lead strategist and no 1M-12M call leaves anything out
  const runs = Object.entries(records).filter(([k]) => k.startsWith("run:"));
  const noLead = [], gaps = [];
  for (const [k, r] of runs) {
    const res = r?.agent?.result;
    if (!res) noLead.push(k.slice(4));
    else if ((res.horizon_checks || []).some((c) => c.covered === false)) gaps.push(k.slice(4));
  }
  const ok = full.finished && !noLead.length && !gaps.length;
  if (!ok) bad++;
  console.log(`${ok ? "OK  " : "WARN"} ${full.sector}: ${runs.length} industries, finished=${!!full.finished}, exported ${full.exported_at}` +
    (noLead.length ? `, no lead strategist: ${noLead.join(", ")}` : "") + (gaps.length ? `, gaps: ${gaps.join(", ")}` : ""));

  const b64 = zlib.gzipSync(Buffer.from(JSON.stringify(slim)), { level: 9 }).toString("base64");
  fs.writeFileSync(path.join(out, `${slug}.b64.txt`), b64);
  index.push({ sector: full.sector, path: `${slug}.b64.txt`, exported_at: full.exported_at, finished: !!full.finished, industries: runs.length });
}
fs.writeFileSync(path.join(out, "index.json"), JSON.stringify({ files: index, copied_at: new Date().toISOString().slice(0, 10) }));
console.log(`${index.length} sectors bundled${bad ? `, ${bad} need attention` : ""}`);
