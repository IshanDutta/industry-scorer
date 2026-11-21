// End-to-end test of the Compare tab's verdict on GitHub, against fake Anthropic and FMP servers:
//   node test/compare.mjs <exports dir with runs/consumer-defensive.json.gz> [SYM,SYM,...]
// Plumbing only: the request reaches the page, the page reads each ticker the way the Compare tab does (picking up a
// company analysis saved in the exports branch), writes the verdict with the fake desk's fixed JSON, and
// out/portfolio.json.gz is { kind: "compare", sym, at, rec } with the verdict record the tab keeps.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBrain, fakeAnthropic, fakeMcp } from "./fakes.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const EXP = resolve(process.argv[2] || "exports"), KIND = "compare", SYMS = String(process.argv[3] || "KO,PEP,MDLZ").toUpperCase().split(","), SYM = [...SYMS].sort().join(",");
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"} ${m}`); if (!c) process.exitCode = 1; };
const tmp = join(here, ".tmp-compare"); rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true });
const runs = [];
for (const f of ["consumer-defensive.json.gz"]) { const p = join(EXP, "runs", f); if (existsSync(p)) runs.push(JSON.parse(gunzipSync(readFileSync(p)).toString())); }
const cos = {}; for (const j of runs) for (const [k, r] of Object.entries(j.records || {})) if (k.startsWith("run:")) for (const c of r.industry?.constituents || []) cos[c.symbol] = { name: c.name || c.symbol, industry: r.industry?.name, sector: j.sector, w: c.weight || 0.01 };

const brainSrc = `window.COS = ${JSON.stringify(cos)};
(function () {
  const series = (sym) => { const out = []; let seed = 0; for (const c of sym) seed += c.charCodeAt(0); let v = 50 + (seed % 50); const d = new Date("2019-12-02"); let k = 0;
    while (d.toISOString().slice(0, 10) <= "2026-11-18") { if (d.getUTCDay() % 6) { k++; v *= 1 + 0.011 * Math.sin(k * 0.31) * Math.cos(k * 0.017) + 0.0003 + 0.006 * Math.sin(k * 0.7 + seed); out.push({ date: d.toISOString().slice(0, 10), adjClose: v, close: v, open: v, high: v * 1.01, low: v * 0.99, volume: 1e6 }); } d.setUTCDate(d.getUTCDate() + 1); }
    return out.reverse(); };
  const fundHold = Object.entries(COS).slice(0, 40).map(([s, c]) => ({ asset: s, name: c.name, weightPercentage: 2.5 }));
  const BONDS = { HYG: { name: "iShares iBoxx $ High Yield Corporate Bond ETF", cat: "High Yield Bonds", dur: 3.07, ytm: 7.66, cpn: 6.76 }, TLT: { name: "iShares 20+ Year Treasury Bond ETF", cat: "US Government Bonds", dur: 14.13, ytm: 5.09, cpn: 3.48 } };
  const curveRow = (date, k) => ({ date, month1: 3.95, month2: 3.97, month3: 4.0, month6: 4.2, year1: 4.3, year2: 4.4 + 0.1 * Math.sin(k / 20), year3: 4.5, year5: 4.6, year7: 4.75, year10: 4.98 + 0.2 * Math.sin(k / 30), year20: 5.35, year30: 5.3 });
  const mcp = { async listTools() { return { servers: [{ server: "EODHD", tools: ["get_fundamentals_data"] }] }; }, async callTool(server, tool, input) {
    const sym = input.symbol, c = COS[sym], B = BONDS[sym] || BONDS[String(input.ticker || "").replace(/\.US$/, "")];
    if (server === "EODHD") {
      if (tool === "get_fundamentals_data") return { payload: B ? { General: { Code: input.ticker, Type: "ETF", Name: B.name, Category: B.cat }, ETF_Data: { Yield: B.ytm - 1, NetExpenseRatio: 0.002, Asset_Allocation: { Bond: { "Net_Assets_%": 98.5 }, Cash: { "Net_Assets_%": 1.5 } },
        Fixed_Income: { EffectiveDuration: { "Fund_%": B.dur }, EffectiveMaturity: { "Fund_%": B.dur * 1.6 }, YieldToMaturity: { "Fund_%": B.ytm }, Coupon: { "Fund_%": B.cpn }, Price: { "Fund_%": 95 } }, Performance: { Returns_1Y: 1.5, Returns_10Y: 3 } } } : null };
      if (tool === "get_credit_corporate_hqm_yields") return { payload: { data: [{ as_of_date: "2026-10-01T00:00:00+00:00", yield_value: 5.92 }, { as_of_date: "2025-10-01T00:00:00+00:00", yield_value: 5.4 }] } };
      if (tool === "get_ust_real_yield_rates") return { payload: { meta: { total: 40 }, data: [{ date: "2026-11-17", tenor: "10Y", rate: 2.66 }] } };
      return { payload: null }; }
    if (tool === "economics" && input.endpoint === "treasury-rates") { const out = []; const d = new Date(input.from_date + "T00:00:00Z"), e = input.to_date; let k = 0; while (d.toISOString().slice(0, 10) <= e && d.toISOString().slice(0, 10) <= "2026-11-18") { if (d.getUTCDay() % 6) out.push(curveRow(d.toISOString().slice(0, 10), k++)); d.setUTCDate(d.getUTCDate() + 1); } return { payload: out.reverse() }; }
    if (B && tool === "etfAndMutualFunds" && input.endpoint === "information") return { payload: [{ symbol: sym, name: B.name, assetClass: "Fixed Income", expenseRatio: 0.2, assetsUnderManagement: 2e10, inceptionDate: "2007-04-04", holdingsCount: 1200, sectorsList: sym === "HYG" ? [{ industry: "Communications", exposure: 15 }, { industry: "Energy", exposure: 11 }, { industry: "Consumer Cyclical", exposure: 17 }] : [] }] };
    if (B && tool === "etfAndMutualFunds" && input.endpoint === "holdings") return { payload: [{ symbol: sym, asset: "", name: "CCO HOLDINGS LLC 4.75% 03/01/2030", weightPercentage: 0.6 }, { symbol: sym, asset: "", name: "TRANSDIGM INC 6.375% 03/01/2029", weightPercentage: 0.5 }] };
    if (B && tool === "company") return { payload: [{ symbol: sym, companyName: B.name, price: 80, isEtf: true }] };
    if (tool === "chart") return { payload: series(sym || "X") };
    if (tool === "company") return { payload: [{ symbol: sym, companyName: c ? c.name : sym + " Fund", price: 100, mktCap: 1e11, marketCap: 1e11, beta: 1.1, lastDividend: 0.8, isEtf: !c, isFund: false, sector: c ? c.sector : "", industry: c ? c.industry : "", exchange: "NASDAQ", description: "x" }] };
    if (tool === "etfAndMutualFunds" && input.endpoint === "holdings") return { payload: fundHold.map((x) => ({ ...x, symbol: sym })) };
    if (tool === "etfAndMutualFunds" && input.endpoint === "information") return { payload: [{ symbol: sym, name: sym + " Fund", assetClass: "Equity", expenseRatio: 0.09, assetsUnderManagement: 2e10, avgVolume: 1e6, inceptionDate: "2018-06-19", holdingsCount: 40, sectorsList: [{ industry: "Communication Services", exposure: 99 }] }] };
    if (tool === "quote") return { payload: [].concat(input.symbols || sym || []).join(",").split(",").filter(Boolean).map((s) => ({ symbol: s, price: 100, changePercentage: 0.5, marketCap: 1e11, pe: 25 })) };
    if (tool === "economics") return { payload: [{ date: "2026-11-17", month1: 4.05, month3: 4.3, month6: 4.38, year1: 4.56, year2: 4.73, year3: 4.74, year5: 4.81, year7: 4.89, year10: 4.98, year20: 5.39, year30: 5.35 }] };
    return { payload: [] }; } };
  const json = async (p) => {
    if (/comparison desk/.test(p)) { const syms = [...p.matchAll(/^=== ([A-Z.]+):/gm)].map((m) => m[1]);
      return { headline: syms[0] + " wins.", overall: { pick: syms[0], confidence: "medium", why: "Numbers." }, ranking: syms,
        investors: { income: { pick: syms[1], why: "Yield." }, conservative: { pick: syms[1], why: "Vol." }, growth: { pick: syms[0], why: "Growth." }, aggressive: { pick: syms[0], why: "Momentum." } },
        horizons: { "12M": { pick: syms[0], why: "z" } }, dimensions: [{ key: "valuation", pick: syms[1], why: "Cheaper." }],
        names: Object.fromEntries(syms.map((s) => [s, { verdict: "hold", role: "core", strengths: ["a"], weaknesses: ["b"], bull: "up", bear: "down" }])), together: { pairing: "ok", mix: Object.fromEntries(syms.map((s) => [s, 1])) }, risks: ["rates"], bottom_line: "Fine." }; }
    if (/fixed-income strategist/.test(p)) return { headline: "Paid to wait [B2].", verdict: "fair", conviction: 6, thesis: "Carry [B2].\\nRates [R1].\\nThe call [R3].", rates: "Flat [R1].", credit: /spread_change_bp/.test(p) ? "Tight [C1]." : null, inflation: "Sticky.", role: "Ballast.",
      scenarios: { bull: { probability: 25, rate_change_bp: -60, spread_change_bp: -40, narrative: "soft landing" }, base: { probability: 50, rate_change_bp: 0, spread_change_bp: 10, narrative: "more of the same" }, bear: { probability: 25, rate_change_bp: 50, spread_change_bp: 200, narrative: "recession" } },
      calls: { "1M": { call: "slightly bullish", why: "carry [B2]" }, "3M": { call: "slightly bullish", why: "x" }, "6M": { call: "slightly bullish", why: "y" }, "12M": { call: "slightly bullish", why: "z [R1]" } }, risks: [{ risk: "Defaults", why: "spreads [C1]", size: "medium" }], watch: [{ what: "CPI", why: "rates" }] };
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
const id = "cmp-" + [...SYMS].sort().map((s) => s.replace(/[^A-Z0-9]/g, "_")).join("-");
writeFileSync(join(tmp, "request.json"), JSON.stringify({ id, kind: KIND, symbols: SYMS, holdings: [], requested_at: new Date().toISOString() }));
const out = join(tmp, "out");
const code = await new Promise((done) => { const p = spawn(process.execPath, [join(here, "../portfolio.mjs"), "--request", join(tmp, "request.json"), "--exports", EXP, "--out", out, "--deadline-min", "15"], {
  env: { ...process.env, ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: "http://127.0.0.1:7822", FMP_MCP_URL: "http://127.0.0.1:7821/fmp", EODHD_MCP_URL: "http://127.0.0.1:7821/eodhd", JOB_FMP_GAP_MS: "5", GITHUB_STEP_SUMMARY: join(tmp, "summary.md") }, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout.on("data", (d) => process.stdout.write("    " + String(d).trimEnd().replace(/\n/g, "\n    ") + "\n")); p.stderr.on("data", (d) => process.stderr.write("    " + d)); p.on("exit", done); });
ok(code === 0, `the job exits 0 (got ${code})`);
const f = join(out, "portfolio.json.gz");
if (existsSync(f)) { const r = JSON.parse(gunzipSync(readFileSync(f)).toString());
  ok(r.kind === "compare" && r.sym === SYM && !!r.at, `the result says what it is (${r.kind} ${r.sym} at ${r.at})`);
  ok(r.rec?.v?.overall?.pick && SYMS.includes(r.rec.v.overall.pick), "the verdict picks one of them: " + r.rec?.v?.overall?.pick);
  ok([...(r.rec?.syms || [])].sort().join(",") === SYM && !!r.rec?.fp, "the record is for this set, with its fingerprint");
  ok(Object.keys(r.rec?.v?.investors || {}).length === 4 && Object.keys(r.rec?.v?.names || {}).length === SYMS.length, "every investor type and every name is covered");
  ok(r.job?.id === id, "the job's facts are attached");
  console.log(readFileSync(join(tmp, "summary.md"), "utf8")); }
else ok(false, "no result file");
console.log(`Claude requests: ${fa.stats.requests}`);
process.exit(process.exitCode || 0);
