// Fit the statistical anchor (web/anchor.js) on every industry's history since 2008, test it walking forward, and
// write the model the page uses: web/anchor-model.js. No Claude; FMP only (a few thousand calls, ~15-30 minutes).
//
// Usage: node fit-anchor.mjs <dir with runs/*.json.gz (the exports branch)> [--out ../web/anchor-model.js] [--only "Semiconductors,Banks - Regional"]
//        node fit-anchor.mjs <exports dir> --collect "<Sector>" --rows <file>   (one sector's monthly rows, for a matrix job)
//        node fit-anchor.mjs --fit <dir of rows files> [--out file]              (fit on rows collected by sector)
// Env: FMP_MCP_URL, FMP_MCP_HEADERS (optional), ANCHOR_CONCURRENCY (default 4)
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { McpBridge } from "./lib/mcp.mjs";

const require = createRequire(import.meta.url);
const Anchor = require("../web/anchor.js");
const History = require("../web/history.js");
const env = process.env;
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const fitDir = opt("--fit", ""), collect = opt("--collect", ""), rowsOut = opt("--rows", "");
const dir = fitDir ? "" : args[0];
const outFile = opt("--out", path.join(path.dirname(new URL(import.meta.url).pathname), "../web/anchor-model.js"));
const only = (opt("--only", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
if (!dir && !fitDir) { console.error("usage: node fit-anchor.mjs <exports dir> [--out file] | --fit <rows dir>"); process.exit(2); }
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a), log0 = log;
const end0 = new Date().toISOString().slice(0, 10);
if (fitDir) {
  // Fit on every sector's rows.
  const data = [];
  for (const f of fs.readdirSync(fitDir, { recursive: true }).map(String).filter((f) => /anchor-rows-.*\.json$/.test(f))) data.push(...JSON.parse(fs.readFileSync(path.join(fitDir, f), "utf8")));
  log0(`${data.length} industries with rows`);
  await finish(data, data.length, 0, end0);
  process.exit(0);
}

// The industries, each with its exchange weights (share of its top companies' market cap on each exchange).
const inds = [];
for (const f of fs.readdirSync(path.join(dir, "runs")).filter((f) => /^[a-z-]+\.json\.gz$/.test(f))) {
  const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, "runs", f))));
  for (const [k, v0] of Object.entries(j.records || {})) {
    if (!k.startsWith("run:")) continue;
    const v = typeof v0 === "string" ? JSON.parse(v0) : v0, d = v?.industry; if (!d?.name) continue;
    if (only.length && !only.includes(d.name)) continue;
    if (collect && j.sector !== collect) continue;
    const w = {}; let t = 0; for (const c of d.constituents || []) { const e = String(c.exchange || "").toUpperCase(); if (!["NASDAQ", "NYSE", "AMEX"].includes(e)) continue; w[e] = (w[e] || 0) + (c.market_cap || 0); t += c.market_cap || 0; }
    for (const e of Object.keys(w)) w[e] = t ? w[e] / t : 0;
    inds.push({ name: d.name, sector: j.sector, weights: w, primary: d.history?.primary || Object.entries(w).sort((a, b) => b[1] - a[1])[0]?.[0] || "NASDAQ" });
  }
}
log(`${inds.length} industries`);

let headers = {}; try { headers = env.FMP_MCP_HEADERS ? JSON.parse(env.FMP_MCP_HEADERS) : {}; } catch {}
const mcp = new McpBridge({ FMP: { url: env.FMP_MCP_URL, headers } }, { log: () => {} });
await mcp.connect("FMP");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
// An empty answer or an error is retried (the data provider limits calls per minute); a real gap stays empty.
const fmp = async (tool, input, { tries = 2 } = {}) => {
  for (let t = 1; t <= tries; t++) {
    try { const r = await mcp.callTool("FMP", tool, input); const p = r.payload; const rows = Array.isArray(p) ? p : Array.isArray(p?.data) ? p.data : []; if (rows.length || t === tries) return rows; }
    catch (e) { if (t === tries) { failed++; return []; } }
    await sleep(2000 * t);
  }
  return [];
};

const end = new Date().toISOString().slice(0, 10), Y1 = Number(end.slice(0, 4));
const spyRows = await fmp("chart", { endpoint: "historical-price-eod-dividend-adjusted", symbol: "SPY", from_date: "2007-06-01", to_date: end });
const sp = spyRows.map((r) => [String(r.date).slice(0, 10), Number(r.adjClose ?? r.close ?? r.price)]).filter(([d, v]) => d && v > 0).sort((a, b) => (a[0] < b[0] ? -1 : 1));
const spy = { dates: sp.map((x) => x[0]), closes: sp.map((x) => x[1]) };
if (spy.dates.length < 3000) { console.error(`SPY history too short (${spy.dates.length} days)`); process.exit(1); }
log(`SPY ${spy.dates[0]} to ${spy.dates[spy.dates.length - 1]}`);

const data = [];
async function one(ind) {
  const exs = Object.entries(ind.weights).filter(([, w]) => w >= 0.1).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([e]) => e);
  const perf = [], pe = [];
  for (let y = 2008; y <= Y1; y += 3) {
    const from = `${y}-01-01`, to = y + 2 >= Y1 ? end : `${y + 2}-12-31`;
    for (const ex of exs.length ? exs : [ind.primary]) perf.push(...(await fmp("marketPerformance", { endpoint: "historical-industry-performance", industry: ind.name, exchange: ex, from_date: from, to_date: to })).map((x) => ({ ...x, exchange: x.exchange || ex })));
    pe.push(...(await fmp("marketPerformance", { endpoint: "historical-industry-pe", industry: ind.name, exchange: ind.primary, from_date: from, to_date: to })).map((x) => ({ ...x, exchange: x.exchange || ind.primary })));
  }
  const ls = History.levelSeries(perf, ind.weights), ps = History.peSeries(pe, ind.primary);
  if (ls.dates.length < 1500) { log(`  ${ind.name}: too little history (${ls.dates.length} days; ${perf.length} rows from ${exs.join("/") || ind.primary})`); return; }
  const A = Anchor.align({ dates: ls.dates, levels: ls.levels }, spy, ps.dates.length ? ps : null);
  const rows = Anchor.rows(A);
  data.push({ industry: ind.name, sector: ind.sector, rows });
  log(`  ${ind.name}: ${rows.length} months`);
}
const queue = [...inds], N = Math.max(1, Number(env.ANCHOR_CONCURRENCY) || 2);
await Promise.all(Array.from({ length: N }, async () => { while (queue.length) await one(queue.shift()); }));
await mcp.close?.();
if (collect) { fs.writeFileSync(rowsOut || `anchor-rows-${collect.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.json`, JSON.stringify(data)); log(`${data.length} of ${inds.length} ${collect} industries collected (${failed} calls failed).`); process.exit(0); }
await finish(data, inds.length, failed, end);

async function finish(data, of, failed, end) {
if (data.length < 20) { console.error(`Only ${data.length} industries had enough history; not writing a model.`); process.exit(1); }

const model = Anchor.fit(data, { asOf: end });
// Keep only what predicting needs.
for (const h of Object.keys(model.horizons)) for (const k of ["rel"]) { const m = model.horizons[h][k]; model.horizons[h][k] = { w: m.w.map((v) => +v.toFixed(5)), mu: m.mu.map((v) => +v.toFixed(5)), sdv: m.sdv.map((v) => +v.toFixed(5)), b0: +m.b0.toFixed(5), resid: +m.resid.toFixed(5) }; }
model.industries = data.length;
fs.writeFileSync(outFile, `/* Industry Scorer: the fitted statistical anchor (written by runner/fit-anchor.mjs; don't edit by hand). */\n(function (root) { root.ANCHOR_MODEL = ${JSON.stringify(model)}; if (typeof module !== "undefined" && module.exports) module.exports = root.ANCHOR_MODEL; })(typeof window !== "undefined" ? window : globalThis);\n`);
log(`Model written to ${outFile} from ${data.length} of ${of} industries (${failed} calls failed after retries).`);
for (const [h, m] of Object.entries(model.horizons)) log(`${h}: weights ${m.rel.w.join(", ")}; out of sample: right side of the average industry ${m.test.hit_rate}% (coin flip 50%; intercept alone ${m.test.base_hit_rate}%), in likely range ${m.test.in_likely_range}%, rank IC ${m.test.rank_ic}, top-minus-bottom fifth ${m.test.top_minus_bottom} sigma, ${m.test.months} months`);
if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `## Statistical anchor\n\nFitted on ${data.length} industries, ${end}.\n\n| Horizon | Right side of the average industry (out of sample) | Intercept alone | In likely range | Rank IC | Top − bottom fifth (σ) |\n|---|---|---|---|---|---|\n${Object.entries(model.horizons).map(([h, m]) => `| ${h} | ${m.test.hit_rate}% | ${m.test.base_hit_rate}% | ${m.test.in_likely_range}% | ${m.test.rank_ic} | ${m.test.top_minus_bottom} |`).join("\n")}\n`);
}
