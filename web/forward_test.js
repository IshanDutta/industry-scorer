// Tests for the forward view: estimate parsing, NTM blend, sanity checks, revisions, aggregation, reverse DCF.
const assert = require("assert");
const Fw = require("./forward.js");
const T = "2026-10-25";
const eodRows = [
  { period: "+1y", date: "2027-12-31", earningsEstimateAvg: "15.7629", epsTrendCurrent: "15.7629", epsTrend30daysAgo: "15.5707", epsTrend90daysAgo: "13.4921", earningsEstimateLow: "9.6", earningsEstimateHigh: "20.25", earningsEstimateNumberOfAnalysts: "50", earningsEstimateGrowth: "1.0772", revenueEstimateGrowth: "0.7494", epsRevisionsUpLast30days: "7", epsRevisionsDownLast30days: "1" },
  { period: "0y", date: "2026-12-31", earningsEstimateAvg: "7.5884", epsTrend30daysAgo: "7.5758", epsTrend90daysAgo: "7.4195", earningsEstimateNumberOfAnalysts: "49", earningsEstimateGrowth: "0.8198", revenueEstimateGrowth: "0.4715", epsRevisionsUpLast30days: "5", epsRevisionsDownLast30days: "1" },
  { period: "0y", date: "2025-12-31", earningsEstimateAvg: "4.17" }, { period: "+1q", date: "2026-12-31", earningsEstimateAvg: "2.1" }];
const est = Fw.fromEodTrends(eodRows, T);
assert.strictEqual(est.fy0.date, "2026-12-31"); assert.strictEqual(est.fy1.date, "2027-12-31"); assert.strictEqual(est.fy1.up30, 7);
const cf = Fw.companyForward(est, { price: 250, market_cap: 250 * 1.63e9, ni_ttm: 6e9, today: T });
const w0 = (Date.parse("2026-12-31") - Date.parse(T)) / 864e5 / 365;
assert(Math.abs(cf.ntm_eps - (w0 * 7.5884 + (1 - w0) * 15.7629)) < 1e-9, "NTM blends FY0 and FY1 by time left");
assert(cf.ok && Math.abs(cf.fwd_pe - 250 / cf.ntm_eps) < 1e-9);
assert(cf.ntm_growth > 0.9 && cf.ntm_growth < 1.2, "growth vs adjusted LTM, not GAAP: " + cf.ntm_growth);
assert(cf.rev30 > 0 && cf.rev90 > cf.rev30 && cf.up30 === 12 && cf.down30 === 2);
// ADR / currency mismatch: estimate 30x trailing EPS -> excluded
const bad = Fw.companyForward({ fy0: { ...est.fy0, eps: 120 }, fy1: { ...est.fy1, eps: 130 } }, { price: 250, market_cap: 250 * 1.63e9, ni_ttm: 6e9, today: T });
assert(!bad.ok && /currency/.test(bad.why));
assert.strictEqual(Fw.companyForward({ fy0: { ...est.fy0, eps: -1 }, fy1: { ...est.fy1, eps: -0.5 } }, { price: 10, market_cap: 1e9, ni_ttm: -1e8, today: T }).ok, false);
// FMP fallback
const fm = Fw.fromFmpEstimates([{ date: "2027-12-27", epsAvg: 16.14, revenueAvg: 90.4e9 }, { date: "2026-12-27", epsAvg: 7.6, revenueAvg: 51.7e9 }, { date: "2025-12-27", epsAvg: 4, revenueAvg: 34e9 }, { date: "2030-12-27", epsAvg: 43 }], T);
assert.strictEqual(fm.fy0.date, "2026-12-27"); assert.strictEqual(fm.fy1.date, "2027-12-27"); assert(Math.abs(fm.fy0.growth - 0.9) < 1e-9);
const cf2 = Fw.companyForward(fm, { price: 250, market_cap: 250 * 1.63e9, ni_ttm: 6e9, today: T });
assert(cf2.ok && !Number.isFinite(cf2.rev30), "FMP has no revision history");
// Aggregation: sum/sum forward P/E, breadth, coverage
const a = Fw.aggregateForward([{ symbol: "A", market_cap: 300, fwd: { ...cf, fwd_pe: 30, ntm_growth: 0.2, rev30: 0.02 } }, { symbol: "B", market_cap: 100, fwd: { ...cf, fwd_pe: 10, ntm_growth: 0.1, rev30: -0.01 } }, { symbol: "C", market_cap: 100, fwd: bad }, { symbol: "D", market_cap: 100 }]);
assert(Math.abs(a.fwd_pe - 400 / (300 / 30 + 100 / 10)) < 1e-9, "harmonic forward P/E");
assert(Math.abs(a.coverage - 400 / 600) < 1e-9); assert.deepStrictEqual(a.excluded.map((x) => x.symbol), ["C"]);
assert(Math.abs(a.ntm_eps_growth - (20 / (10 / 1.2 + 10 / 1.1) - 1)) < 1e-9);
assert(Math.abs(a.rev30 - (300 * 0.02 - 100 * 0.01) / 400) < 1e-9); assert.strictEqual(a.share_rising, 0.5); assert.deepStrictEqual(a.top_down.map((x) => x.symbol), ["B"]);
// Reverse DCF: solveGrowth inverts pv
const r = 0.09, g = 0.12; const y = 1 / Fw.pv(g, r, 0.03, 10);
assert(Math.abs(Fw.solveGrowth(y, r) - g) < 1e-6);
assert(Number.isNaN(Fw.solveGrowth(-0.01, r)));
const p = Fw.pricedIn({ y10: 0.045, erp: 0.05, beta: 1.4, fund: { fcf_margin: 0.25, ps: 15 }, fwd: a, hist: { cagr: 0.2 } });
assert(Math.abs(p.r - 0.115) < 1e-9 && p.implied_fcf_growth > 0.2 && p.ref_basis === "5-year revenue growth" && p.verdict === "demanding" === (p.gap > 0.05));
const mem = [{ c: { q: Array.from({ length: 24 }, (_, k) => ({ rev: 100 / Math.pow(1.1, k / 4) })) } }];
assert(Math.abs(Fw.histRevCagr(mem).cagr - 0.1) < 0.01);
console.log("forward tests passed");
