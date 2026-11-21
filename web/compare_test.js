// node web/compare_test.js
const assert = require("assert");
const C = require("./compare.js");

const days = (n0, f) => { const dates = [], closes = []; let d = Date.UTC(2023, 0, 2), v = 100;
  for (let i = 0; i < n0; i++) { const dt = new Date(d + i * 864e5); if (dt.getUTCDay() % 6 === 0) continue; v *= 1 + f(i); dates.push(dt.toISOString().slice(0, 10)); closes.push(v); }
  return { dates, closes }; };
const noise = (seed) => { let s = seed; return () => { s = (s * 9301 + 49297) % 233280; return s / 233280 - 0.5; }; };
const na = noise(1), nb = noise(7);
const common = Array.from({ length: 1200 }, () => na());
const A = { sym: "AAA", kind: "stock", name: "Alpha", sub: "Software", m: { pe: 35, fwd_pe: 30, rev_growth: 0.25, ntm_growth: 0.2, op_margin: 0.3, div_yield: 0, vol_1y: 0.35, beta: 1.3, ret_1Y: 0.3, sharpe_1y: 1.1, de: 0.3 },
  pillars: { momentum: 80, cycle: 60, macro: 55 }, profiles: { growth: { total: 75 }, income: { total: 30 } }, outlook: { source: "written analysis", calls: { "1M": { call: "slightly bullish" }, "3M": { call: "bullish" }, "6M": { call: "bullish" }, "12M": { call: "strongly bullish" } } },
  saved: { at: "2026-11-18", fit: { growth: { fit: "strong" }, income: { fit: "poor" } }, headline: "Fast grower", scenarios: [{ k: "bull", probability: 30, target: 150, move: 0.3 }] },
  ind: { name: "Software", headline: "Demand strong", outlook: { calls: { "12M": { call: "bullish" } } } }, ser: days(1500, (i) => 0.0008 + 0.02 * common[i % 1200]) };
const B = { sym: "BBB", kind: "stock", name: "Beta", sub: "Utilities", m: { pe: 15, fwd_pe: 14, rev_growth: 0.03, ntm_growth: 0.04, op_margin: 0.2, div_yield: 0.045, payout: 0.6, vol_1y: 0.16, beta: 0.5, ret_1Y: 0.08, sharpe_1y: 0.6, de: 1.4 },
  pillars: { momentum: 40 }, profiles: { income: { total: 80 }, growth: { total: 35 } }, outlook: { source: "industry", calls: { "12M": { call: "slightly bearish" } } }, ser: days(1500, (i) => 0.0002 + 0.008 * (0.3 * common[i % 1200] + nb())) };
const F = { sym: "FFF", kind: "fund", name: "Fund", m: { expense: 0.001, top10: 0.3, eff_n: 60, vol_1y: 0.18, div_yield: 0.015, ret_1Y: 0.15 }, pillars: { valuation: 55, growth: 60 }, profiles: {},
  holdings: [{ ticker: "AAA", weight: 0.08 }, { ticker: "ZZZ", weight: 0.05 }], ser: days(1500, (i) => 0.0005 + 0.01 * common[i % 1200]) };

const subs = [A, B, F], sc = C.scoreAll(subs);
assert(sc.AAA.groups.growth.score > sc.BBB.groups.growth.score, "growth: AAA ahead");
assert(sc.BBB.groups.income.score > sc.AAA.groups.income.score, "income: BBB ahead");
assert(sc.BBB.groups.risk.score > sc.AAA.groups.risk.score, "risk: BBB safer");
assert.equal(sc.FFF.groups.valuation.from, "its industries", "fund valuation falls back to its look-through pillar");
assert(sc.FFF.groups.cost, "funds get a cost dimension");
assert(!sc.AAA.groups.cost, "stocks don't");
assert(sc.AAA.groups.outlook.score > 70 && sc.BBB.groups.outlook.score < 50);

const fit = C.fits(subs, sc);
assert.equal(fit.growth.ranked[0], "AAA", "growth investor: AAA");
assert.equal(fit.income.ranked[0], "BBB", "income investor: BBB");
assert(fit.growth.AAA.fit === "strong" && fit.income.AAA.total < fit.income.BBB.total);

const h = C.headToHead(subs, sc);
assert(h.rows.find((r) => r.key === "pe").leader === "BBB", "lower P/E leads");
assert(h.rows.find((r) => r.key === "rev_growth").leader === "AAA");
assert(h.groups.growth.leader === "AAA");

const corr = C.correlation(subs);
assert(corr.n >= 200 && corr.corr[0][0] === 1);
assert(corr.corr[0][2] > 0.9, "the fund moves with AAA: " + corr.corr[0][2]);
assert(corr.corr[0][1] < corr.corr[0][2]);
assert(corr.mixVol < corr.avgVol, "mixing lowers volatility");

const rb = C.rebase(subs, "2025-01-01"); assert(rb.length === 3 && Math.abs(rb[0].values[0] - 100) < 1e-9 && rb[0].dates.length === rb[1].dates.length);
const dd = C.drawdown(rb[0].dates, rb[0].values); assert(Math.max(...dd.values) <= 1e-12);
assert(C.years(subs).length >= 2);
const ov = C.overlap(subs); assert(ov.find((o) => o.kind === "stock-in-fund" && o.a === "AAA").shared === 0.08);

const text = C.dossier({ subjects: subs, sc, fit, h2h: h, corr, ovl: ov, today: "2026-11-21" });
assert(/=== AAA/.test(text) && /WRITTEN ANALYSIS \(made here/.test(text) && /CODE'S COMPARISON/.test(text) && /Holdings overlap|is 8\.0% of FFF/.test(text));
const p = C.prompt(text, ["AAA", "BBB", "FFF"], "2026-11-21"); assert(p.length < 60000 && /Return ONLY a JSON object/.test(p));

const v = C.clean({ headline: "AAA wins", overall: { pick: "aaa", why: "x" }, ranking: ["AAA", "XXX"], investors: { income: { pick: "AAA", why: "bad pick" }, growth: { pick: "AAA" } },
  dimensions: [{ key: "income", pick: "AAA", why: "y" }, { key: "nope", pick: "AAA" }], names: { AAA: { verdict: "buy", strengths: ["a"] } }, together: { mix: { AAA: 3, BBB: 1 } } }, ["AAA", "BBB", "FFF"]);
assert.equal(v.overall.pick, "AAA"); assert.deepEqual(v.ranking, ["AAA", "BBB", "FFF"]); assert.equal(v.dimensions.length, 1);
assert(v.names.FFF && v.names.BBB.verdict === null); assert.equal(v.together.mix.AAA + v.together.mix.BBB + v.together.mix.FFF, 100);
const ck = C.checks(v, h, fit); assert(ck.some((x) => x.where === "income"), "flags the income pick against code's numbers");
assert(C.fingerprint(subs, "2026-11-21").includes("AAA:2026-11-18"));
console.log("compare ok");
