// node web/pfx_test.js
const assert = require("assert");
const X = require("./pfx.js");
const mk = (seed, drift, amp, from = "2007-01-02") => { const dates = [], closes = []; let v = 100; const t = new Date(from + "T00:00:00Z"); let k = 0;
  while (t <= new Date("2026-11-20T00:00:00Z")) { if (t.getUTCDay() % 6) { k++; v *= 1 + drift + amp * Math.sin(k * 0.37 + seed) + 0.3 * amp * Math.sin(k * 0.05 * seed); dates.push(t.toISOString().slice(0, 10)); closes.push(v); } t.setUTCDate(t.getUTCDate() + 1); }
  return { dates, closes }; };
const S = { SPY: mk(1, 0.0003, 0.01), A: mk(1, 0.0004, 0.012), B: mk(2.5, 0.0002, 0.006), C: mk(4, 0.0005, 0.02, "2021-01-04") };
const A = X.align(S, ["A", "B", "C", "Z"], { from: "2025-11-20" });
assert.deepEqual(A.missing, ["Z"]); assert.ok(A.dates.length > 240);
const co = X.correlations(A); assert.equal(co.m[0][0], 1); assert.ok(co.m[0][1] <= 1 && co.m[0][1] >= -1);
const rc = X.riskContrib(A, { A: 50, B: 30, C: 20 }); assert.ok(Math.abs(rc.rows.reduce((s, r) => s + r.share, 0) - 1) < 0.01, "shares add to 1"); assert.ok(rc.divRatio >= 1);
const nav = { dates: S.A.dates.slice(-1300), values: S.A.closes.slice(-1300) }, spyNav = { dates: S.SPY.dates.slice(-1300), values: S.SPY.closes.slice(-1300) };
const dd = X.drawdowns(nav, 3); assert.ok(dd.length && dd[0].depth < 0 && dd[0].depth <= dd[dd.length - 1].depth);
const cal = X.calendar(nav, spyNav); assert.ok(cal.years.length >= 5 && cal.years[1].months.filter((x) => x !== null).length === 12 && cal.best.r >= cal.worst.r);
const ds = X.dayStats(nav); assert.ok(ds.var95 < 0 && ds.cvar95 <= ds.var95 && ds.up > 0 && ds.up < 1);
const rl = X.rolling(nav, spyNav, 126); assert.equal(rl.dates.length, nav.dates.length - 126); assert.ok(rl.beta.some((b) => b !== null));
const ep = X.episodes(S, { A: 50, B: 30, C: 20 }, S.SPY, { C: 1.5 }); const covid = ep.find((e) => /COVID/.test(e.label));
assert.ok(covid && covid.covered === 0.8 && covid.rows.find((r) => r.ticker === "C").est, "C didn't trade in 2020: estimated");
const pr = X.projection(0.08, 0.16, 100000); assert.ok(pr.rows[0].p10 < pr.rows[0].p50 && pr.rows[0].p50 < pr.rows[0].p90 && pr.rows[3].loss < pr.rows[0].loss && pr.path.length === 121);
assert.ok(Math.abs(X.phi(0) - 0.5) < 1e-6 && Math.abs(X.phi(1.96) - 0.975) < 1e-3);
const ov = X.overlap({ SPY: [{ ticker: "AAPL", weight: 0.07 }, { ticker: "MSFT", weight: 0.06 }], QQQ: [{ ticker: "AAPL", weight: 0.09 }, { ticker: "NVDA", weight: 0.08 }] }); assert.equal(ov[0].overlap, 0.07); assert.equal(ov[0].shared, 1);
const ind = X.industries([{ ticker: "AAPL", total: 0.2 }, { ticker: "MSFT", total: 0.1 }, { ticker: "ZZZ", total: 0.05 }], { AAPL: { industry: "Consumer Electronics", sector: "Technology" }, MSFT: { industry: "Software", sector: "Technology" } });
assert.equal(ind.rows[0].industry, "Consumer Electronics"); assert.equal(ind.placed, 0.3);
const mix = X.callMix(ind.rows, { "consumer electronics": { lean: { "12M": "up" }, expected12: 0.1 }, software: { calls: { "12M": { call: "down", mid: -0.05 } } } }); assert.ok(Math.abs(mix.up - 2 / 3) < 0.001 && Math.abs(mix.expected - 0.05) < 0.001);
const tl = X.tilt({ Technology: 0.6, Energy: 0.1 }, { Technology: 0.3, Healthcare: 0.1 }); assert.equal(tl[0].diff, 0.3);
const rd = X.read({ name: "Core", m: { totalReturn: 0.19, volatility: 12, maxDrawdown: 8, sharpeRatio: 1.2 }, ms: { totalReturn: 0.13, volatility: 15, sharpeRatio: 0.8 }, rc, tiltRows: tl, mix, income: { total: 900, yield: 0.009 }, fees: { total: 120, ratio: 0.0012 } });
assert.ok(rd.length >= 5 && /6\.0 points ahead/.test(rd[0]));
console.log("pfx ok");
