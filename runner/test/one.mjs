// End-to-end test of a company's (or fund's) analysis on GitHub, against fake Anthropic and FMP servers:
//   node test/one.mjs <exports dir with runs/*.json.gz> [company|fund] [SYMBOL]
// Plumbing only: the request reaches the page, the page opens the company or fund, writes its analysis with the
// fake strategists' fixed JSON, and out/portfolio.json.gz is { kind, sym, at, rec } with the record the page saves.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBrain, fakeAnthropic, fakeMcp } from "./fakes.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const EXP = resolve(process.argv[2] || "exports"), KIND = process.argv[3] || "company", SYM = (process.argv[4] || (KIND === "fund" ? "XLC" : "GOOG")).toUpperCase();
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"} ${m}`); if (!c) process.exitCode = 1; };
const tmp = join(here, ".tmp-one"); rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true });
const runs = [];
for (const f of ["communication-services.json.gz"]) { const p = join(EXP, "runs", f); if (existsSync(p)) runs.push(JSON.parse(gunzipSync(readFileSync(p)).toString())); }
const cos = {}; for (const j of runs) for (const [k, r] of Object.entries(j.records || {})) if (k.startsWith("run:")) for (const c of r.industry?.constituents || []) cos[c.symbol] = { name: c.name || c.symbol, industry: r.industry?.name, sector: j.sector, w: c.weight || 0.01 };

const brainSrc = `window.COS = ${JSON.stringify(cos)};
(function () {
  const series = (sym) => { const out = []; let seed = 0; for (const c of sym) seed += c.charCodeAt(0); let v = 50 + (seed % 50); const d = new Date("2019-12-02"); let k = 0;
    while (d.toISOString().slice(0, 10) <= "2026-11-18") { if (d.getUTCDay() % 6) { k++; v *= 1 + 0.011 * Math.sin(k * 0.31) * Math.cos(k * 0.017) + 0.0003 + 0.006 * Math.sin(k * 0.7 + seed); out.push({ date: d.toISOString().slice(0, 10), adjClose: v, close: v, open: v, high: v * 1.01, low: v * 0.99, volume: 1e6 }); } d.setUTCDate(d.getUTCDate() + 1); }
    return out.reverse(); };
  const fundHold = Object.entries(COS).slice(0, 40).map(([s, c]) => ({ asset: s, name: c.name, weightPercentage: 2.5 }));
  const mcp = { async listTools() { return { servers: [] }; }, async callTool(server, tool, input) {
    const sym = input.symbol, c = COS[sym];
    if (tool === "chart") return { payload: series(sym || "X") };
    if (tool === "company") return { payload: [{ symbol: sym, companyName: c ? c.name : sym + " Fund", price: 100, mktCap: 1e11, marketCap: 1e11, beta: 1.1, lastDividend: 0.8, isEtf: !c, isFund: false, sector: c ? c.sector : "", industry: c ? c.industry : "", exchange: "NASDAQ", description: "x" }] };
    if (tool === "etfAndMutualFunds" && input.endpoint === "holdings") return { payload: fundHold.map((x) => ({ ...x, symbol: sym })) };
    if (tool === "etfAndMutualFunds" && input.endpoint === "information") return { payload: [{ symbol: sym, name: sym + " Fund", assetClass: "Equity", expenseRatio: 0.09, assetsUnderManagement: 2e10, avgVolume: 1e6, inceptionDate: "2018-06-19", holdingsCount: 40, sectorsList: [{ industry: "Communication Services", exposure: 99 }] }] };
    if (tool === "quote") return { payload: [].concat(input.symbols || sym || []).join(",").split(",").filter(Boolean).map((s) => ({ symbol: s, price: 100, changePercentage: 0.5, marketCap: 1e11, pe: 25 })) };
    if (tool === "economics") return { payload: [{ date: "2026-11-17", month1: 4.05, month3: 4.3, month6: 4.38, year1: 4.56, year2: 4.73, year3: 4.74, year5: 4.81, year7: 4.89, year10: 4.98, year20: 5.39, year30: 5.35 }] };
    return { payload: [] }; } };
  const json = async (p) => {
    const ids = [...new Set([...String(p).matchAll(/\\[([A-Z]{1,2}\\d{1,3})\\]/g)].map((m) => m[1]))].slice(0, 3), c = ids.length ? " [" + ids[0] + "]" : "";
    return { headline: "A durable leader at a fair price" + c + ".", thesis: "The case" + c + ".", verdict: "outperform", confidence: "medium", summary: "Summary" + c + ".",
      horizons: { "1M": { call: "neutral", why: "x" + c }, "3M": { call: "slightly bullish", why: "y" + c }, "6M": { call: "slightly bullish", why: "y" + c }, "12M": { call: "bullish", why: "z" + c } },
      calls: { "1M": { call: "neutral", why: "x" + c }, "3M": { call: "slightly bullish", why: "y" + c }, "6M": { call: "slightly bullish", why: "y" + c }, "12M": { call: "bullish", why: "z" + c } },
      scenarios: { bull: { probability: 30, price_target: [130, 140], narrative: "b" + c }, base: { probability: 50, price_target: [105, 115], narrative: "c" + c }, bear: { probability: 20, price_target: [75, 85], narrative: "d" + c } } };
  };
  const sample = Object.assign(async () => ({ text: "" }), { json });
  window.claude = { use: async (n) => (n === "mcp" ? mcp : sample) };
})();`;
writeFileSync(join(tmp, "brain.js"), brainSrc);
const brain = loadBrain(join(tmp, "brain.js"));
await fakeMcp(brain, { port: 7821 }); const fa = await fakeAnthropic(brain, { port: 7822 });
const id = (KIND === "company" ? "co-" : "fd-") + SYM.replace(/[^A-Z0-9]/g, "_");
writeFileSync(join(tmp, "request.json"), JSON.stringify({ id, kind: KIND, symbol: SYM, holdings: [], requested_at: new Date().toISOString() }));
const out = join(tmp, "out");
const code = await new Promise((done) => { const p = spawn(process.execPath, [join(here, "../portfolio.mjs"), "--request", join(tmp, "request.json"), "--exports", EXP, "--out", out, "--deadline-min", "15"], {
  env: { ...process.env, ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: "http://127.0.0.1:7822", FMP_MCP_URL: "http://127.0.0.1:7821/fmp", EODHD_MCP_URL: "", JOB_FMP_GAP_MS: "5", GITHUB_STEP_SUMMARY: join(tmp, "summary.md") }, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout.on("data", (d) => process.stdout.write("    " + String(d).trimEnd().replace(/\n/g, "\n    ") + "\n")); p.stderr.on("data", (d) => process.stderr.write("    " + d)); p.on("exit", done); });
ok(code === 0, `the job exits 0 (got ${code})`);
const f = join(out, "portfolio.json.gz");
if (existsSync(f)) { const r = JSON.parse(gunzipSync(readFileSync(f)).toString());
  if (process.env.KEEP) writeFileSync(process.env.KEEP, readFileSync(f));
  ok(r.kind === KIND && r.sym === SYM && !!r.at, `the result says what it is (${r.kind} ${r.sym} at ${r.at})`);
  if (KIND === "company") { ok(!!r.rec?.thesis?.headline, "the company's analysis is there: " + (r.rec?.thesis?.headline || "").slice(0, 60)); ok(r.rec?.industry === cos[SYM]?.industry, `built on its industry run (${r.rec?.industry})`); }
  else ok(!!r.rec?.parts && Object.values(r.rec.parts).some(Boolean), `the fund's analysis is there (${Object.keys(r.rec?.parts || {}).join(", ")})`);
  ok(!!r.job?.id && r.job.id === id, "the job's facts are attached");
  console.log("warn:", r.warn || "none"); console.log(readFileSync(join(tmp, "summary.md"), "utf8")); }
else ok(false, "no result file");
console.log(`Claude requests: ${fa.stats.requests}`);
process.exit(process.exitCode || 0);
