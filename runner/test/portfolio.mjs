// End-to-end test of the portfolio job against fake Anthropic and FMP servers:
//   node test/portfolio.mjs <exports dir with runs/*.json.gz> [funds fixture]
// The fakes answer the FMP calls the analysis makes (ETF lists, holdings, reverse lookups, prices, the curve) from the
// page's fund fixture, and Claude's four write-ups with fixed JSON. Passes when the job exits 0 with a graded result.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { loadBrain, fakeAnthropic, fakeMcp } from "./fakes.mjs";

const here = dirname(fileURLToPath(import.meta.url)), require = createRequire(import.meta.url);
const EXP = resolve(process.argv[2] || "exports"), FXP = process.argv[3] || join(here, "../../web/fixtures/funds.json");
const FX = JSON.parse(readFileSync(FXP, "utf8")), R = require("../../web/etfrec.js");
const UNI = Object.fromEntries(R.UNIVERSE.map((e) => [e.symbol, { kind: e.kind, sector: e.sector, industries: e.industries }]));
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"} ${m}`); if (!c) process.exitCode = 1; };
const tmp = join(here, ".tmp-portfolio"); rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true });

// The brain: FMP answers and the strategists' write-ups.
const brainSrc = `window.FX = ${JSON.stringify({ cos: FX.cos, spy: FX.spy_holdings })}; window.UNI = ${JSON.stringify(UNI)};
(function () {
  const cosArr = Object.entries(FX.cos).map(([s, c]) => ({ s, ...c }));
  const holdOf = (sym) => { if (/^DSC\\d$/.test(sym)) return cosArr.filter((_, i) => i % 6 === +sym[3]).slice(0, 35).map((c) => ({ asset: c.s, name: c.name || c.s, weightPercentage: 100 / 35 }));
    const e = UNI[sym]; if (!e || ["core", "size", "style", "div"].includes(e.kind)) return FX.spy;
    const pick = cosArr.filter((c) => (e.industries && e.industries.length ? e.industries.map((x) => x.toLowerCase()).includes(String(c.industry).toLowerCase()) : c.sector === e.sector)).slice(0, 40);
    return pick.map((c) => ({ asset: c.s, name: c.name || c.s, weightPercentage: 100 / Math.max(1, pick.length) })); };
  const series = (sym) => { const out = []; let seed = 0; for (const c of sym) seed += c.charCodeAt(0); const e = UNI[sym] || {}, bond = e.kind === "bond", beta = bond ? -0.1 : e.kind === "ind" ? 1.4 : 1;
    let v = 50 + (seed % 50); const d = new Date("2019-12-02"); let k = 0;
    while (d.toISOString().slice(0, 10) <= "2026-11-12") { if (d.getUTCDay() % 6) { k++; v *= 1 + beta * (0.011 * Math.sin(k * 0.31) * Math.cos(k * 0.017) + 0.0003) + (bond ? 0.00012 : 0.0002) + (bond ? 0.002 : 0.006) * Math.sin(k * 0.7 + seed); out.push({ date: d.toISOString().slice(0, 10), adjClose: v, close: v }); } d.setUTCDate(d.getUTCDate() + 1); }
    return out.reverse(); };
  const mcp = { async listTools() { return { servers: [] }; }, async callTool(server, tool, input) {
    const sym = input.symbol, e = UNI[sym];
    if (tool === "chart") return { payload: series(sym) };
    if (tool === "etfAndMutualFunds" && input.endpoint === "etf-asset-exposure") { const out = [];
      for (let i = 0; i < 6; i++) { const h = holdOf("DSC" + i).find((x) => x.asset === sym); if (h) out.push({ symbol: "DSC" + i, asset: sym, weightPercentage: h.weightPercentage, marketValue: h.weightPercentage * 3e7 }); }
      for (const u of Object.keys(UNI)) { if (UNI[u].kind === "bond") continue; const h = holdOf(u).find((x) => x.asset === sym); if (h) out.push({ symbol: u, asset: sym, weightPercentage: h.weightPercentage, marketValue: h.weightPercentage * 5e7 }); }
      return { payload: out }; }
    if (tool === "etfAndMutualFunds" && input.endpoint === "information") { if (!e && !/^DSC/.test(sym)) return { payload: [] };
      return { payload: [{ symbol: sym, name: sym + " ETF", assetClass: e && e.kind === "bond" ? "Fixed Income" : "Equity", expenseRatio: 0.1, assetsUnderManagement: 5e9, avgVolume: 1e6, inceptionDate: "2012-01-01", sectorsList: e && e.sector ? [{ industry: e.sector, exposure: 98 }] : [] }] }; }
    if (tool === "etfAndMutualFunds" && input.endpoint === "holdings") return { payload: holdOf(sym).map((x) => ({ ...x, symbol: sym })) };
    if (tool === "etfAndMutualFunds") return { payload: [] };
    if (tool === "company") return { payload: [{ symbol: sym, companyName: sym + " name", price: 100, lastDividend: e && e.kind === "bond" ? 4.4 : 1.2, isEtf: !!e, sector: "Technology", industry: "Semiconductors" }] };
    if (tool === "economics") return { payload: [{ date: "2026-11-12", month1: 4.05, month3: 4.3, month6: 4.38, year1: 4.56, year2: 4.73, year3: 4.74, year5: 4.81, year7: 4.89, year10: 4.98, year20: 5.39, year30: 5.35 }] };
    if (tool === "quote") return { payload: [].concat(input.symbols || []).join(",").split(",").filter(Boolean).map((s) => ({ symbol: s, price: 100, changePercentage: 0.5 })) };
    if (tool === "statements") return { payload: [{ priceToEarningsRatioTTM: 30, dividendYieldTTM: 0.004 }] };
    return { payload: [] }; } };
  const json = async (p) => {
    const ids = (re) => [...String(p).matchAll(re)].map((m) => m[1]);
    if (/grading a client/.test(p)) return { verdict: "A concentrated mega-cap portfolio [M2].", strengths: ["Low cost [M2]"], weaknesses: ["Too much in one stock [M2]"], fixes: ["Add the semiconductor ETF [E1]"] };
    if (/chief investment strategist/.test(p)) return { headline: "Chips and platforms, with a bond ballast [A1].", thesis: "One [I1].\\nTwo [I2].\\nThree [A1].", industries: ids(/^\\[(I\\d+)\\]/gm).map((id) => ({ id, stance: "overweight", why: "Its run is bullish [" + id + "].", risk: "A miss [" + id + "]" })), bonds: "Intermediate Treasuries [B1].", horizons: { "1M": { call: "neutral", why: "x [A1]" }, "12M": { call: "slightly bullish", why: "y [A1]" } }, scenarios: { bull: { probability: 30, return: "+18%", narrative: "b [A1]" }, base: { probability: 50, return: "+7%", narrative: "c" }, bear: { probability: 20, return: "-15%", narrative: "d [S1]" } } };
    if (/portfolio manager choosing/.test(p)) return { companies: ids(/^\\[(C\\d+)\\]/gm).slice(0, 10).map((id) => ({ id, why: "Best in its industry [" + id + "]." })), etfs: [...String(p).matchAll(/^\\[E\\d+\\] ([A-Z]+)/gm)].map((m, i) => ({ symbol: m[1], role: i ? "industry tilt" : "core", why: "Captures the targets [E" + (i + 1) + "].", watch: "If the call turns [E" + (i + 1) + "]" })), overlap: "Low overlap [A1].", implementation: ["Buy the core first [E1]"], left_out: "Gold [O1]." };
    if (/head of risk/.test(p)) return { opportunities: [{ title: "Chips", ids: ["O1"], why: "The strongest case [O1].", how: "SMH", horizon: "12M" }], risks: [{ risk: "Rates", likelihood: "medium", impact: "high", why: "2022 [S2]", hedge: "Bonds [B1]" }], macro: "Mixed [M1].", world: "Tariffs [W1].", watch: [{ date: "2026-12-10", what: "FOMC", why: "rates" }], change_mind: ["A recession [S6]"] };
    return {};
  };
  const sample = Object.assign(async () => ({ text: "" }), { json });
  window.claude = { use: async (n) => (n === "mcp" ? mcp : sample) };
})();`;
writeFileSync(join(tmp, "brain.js"), brainSrc);
const brain = loadBrain(join(tmp, "brain.js"));
await fakeMcp(brain, { port: 7811 }); const fa = await fakeAnthropic(brain, { port: 7812 });
const req = { id: "pf_test1", name: "Growth & Value Core", total: 100000, holdings: [{ ticker: "QQQ", weight: 30 }, { ticker: "SPY", weight: 30 }, { ticker: "AAPL", weight: 15 }, { ticker: "MSFT", weight: 15 }, { ticker: "SCHD", weight: 10 }], goal: { type: "growth", horizon: "12M" } };
writeFileSync(join(tmp, "request.json"), JSON.stringify(req));
const out = join(tmp, "out");
const code = await new Promise((done) => { const p = spawn(process.execPath, [join(here, "../portfolio.mjs"), "--request", join(tmp, "request.json"), "--exports", EXP, "--out", out, "--deadline-min", "25"], {
  env: { ...process.env, ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: "http://127.0.0.1:7812", FMP_MCP_URL: "http://127.0.0.1:7811/fmp", EODHD_MCP_URL: "", JOB_FMP_GAP_MS: "5", GITHUB_STEP_SUMMARY: join(tmp, "summary.md") }, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout.on("data", (d) => process.stdout.write("    " + String(d).trimEnd().replace(/\n/g, "\n    ") + "\n")); p.stderr.on("data", (d) => process.stderr.write("    " + d)); p.on("exit", done); });
ok(code === 0, `the job exits 0 (got ${code})`);
const f = join(out, "portfolio.json.gz");
if (existsSync(f)) { const r = JSON.parse(gunzipSync(readFileSync(f)).toString());
  ok(!!r.grades?.current?.letter, `today's portfolio graded ${r.grades?.current?.letter} (${Math.round(r.grades?.current?.score)})`);
  ok(!!r.sels?.improved && !!r.sels?.recommended, "the fix-what-you-have and from-scratch mixes are there");
  ok(r.sels.recommended.w.every((x) => x <= 0.15 + 1e-9), "every ETF at most 15%");
  ok(!!r.write?.improved?.verdict?.verdict && !!r.write?.improved?.allocation?.headline, "the strategists' write-up (verdict, allocation) is there");
  ok(r.job?.industries >= 8, `${r.job?.industries} industry runs loaded`);
  console.log(readFileSync(join(tmp, "summary.md"), "utf8")); }
else ok(false, "no result file");
console.log(`Claude requests: ${fa.stats.requests}`);
process.exit(process.exitCode || 0);
