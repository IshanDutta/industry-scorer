const assert = require("assert");
const P = require("./portfolio.js"), A = require("./fundan.js");
const FX = require("./fixtures/funds.json");
const m = P.mapHoldings(P.fromFmp(FX.fcntx_holdings), [], FX.cos), cov = P.coverage(m, FX.runs, { now: "2026-11-09" });
const sm = P.mapHoldings(P.fromFmp(FX.spy_holdings), [], FX.cos), scov = P.coverage(sm, FX.runs, { now: "2026-11-09" });
const D = FX.digests;
// holdings and concentration
const hold = A.holdings(m, D);
assert.strictEqual(hold[0].ticker, "NVDA"); assert(hold[0].inTop50 && hold[0].rank >= 1, "NVDA is in its industry's top 50");
assert(hold.find((h) => h.ticker === "GOOGL")?.inTop50, "GOOGL finds its row through GOOG");
const conc = A.concentration(m);
assert(conc.top10 > 0.3 && conc.top10 < 0.7 && conc.effective_n > 10, JSON.stringify(conc));
// extras and calendar
const ext = A.extras(cov, D);
assert(ext.F.op_margin.v > 0 && ext.F.op_margin.v < 1 && ext.base["12M"].v > 0.3 && ext.base["12M"].v < 0.95);
const cal = A.calendar(hold, cov, D, "2026-11-09");
assert(cal.every((x, i) => i === 0 || x.date >= cal[i - 1].date), "the calendar is in date order");
// the dossier and prompts
const fd = { sym: "FCNTX", facts: P.facts("FCNTX", [{ name: "Fidelity Contrafund", expenseRatio: 0.63, avgVolume: 0 }], null), cov, look: P.lookThrough(cov, D), act: P.active(cov, scov, D), bench: { symbol: "SPY" }, digests: D, flags: [], mapped: m, hold, conc, ext, cal,
  retRows: [{ label: "1Y", value: 11, bench: 13, spy: 13 }], g1: { beta: 1.1, corr: 0.95, alpha: -0.01, vol: 0.2, tracking_error: 0.05, up_capture: 1.05, down_capture: 1.1, max_dd: -0.18 }, ep: [{ label: "2020 Covid crash", kind: "stress", from: "2020-02-19", to: "2020-03-23", ret: -0.3, spy: -0.34, dd: -0.31, capture: 0.88 }],
  sens: { factors: [{ label: "Oil", shock_label: "+10% oil", total: { effect: -0.004, t: -2 }, partial: { effect: -0.002 } }] } };
const dz = A.dossier(fd, "2026-11-09");
for (const id of ["F1", "I1", "H1", "P1", "P2", "S1", "MF1", "V1", "V6"]) assert(dz.idx[id], `dossier has ${id}`);
for (const part of A.PARTS) { const pr = A.partPrompt(fd, dz, part, "2026-11-09"); assert(pr.length < 70000, `${part} prompt ${pr.length}`); assert(pr.includes("Reply with ONLY this JSON")); }
assert(A.leanPrompt(fd, dz, "2026-11-09").includes('"12M"'));
// cleaning
const core = A.cleanPart("core", { headline: "Chips [I1] and [ZZ9]", verdict: { call: "Attractive" }, fit: { growth: { fit: "Strong", adjust: 12 } }, risks: [{ risk: "Taiwan [C1]", likelihood: "High", ids: ["C1", "Q1"] }], reads: { holdings: "Top 10 [H1]" } }, dz.idx);
assert.strictEqual(core.w.headline, "Chips [I1] and"); assert.strictEqual(core.w.verdict.call, "attractive"); assert.strictEqual(core.w.fit.growth.adjust, 5); assert.deepStrictEqual(core.w.risks[0].ids, ["C1"]); assert.strictEqual(core.dropped, 2);
const calls = A.cleanPart("calls", { scenarios: { bull: { probability: 30, move: [20, 10] }, base: { probability: 50, move: [0, 4] }, bear: { probability: 20, move: [-25, -15] } },
  horizons: { "1M": { call: "Slightly Bullish", expected_move: [-2, 4], probability_up: 56 }, "12M": { call: "bearish", expected_move: [1, 9], probability_up: 70 } } }, dz.idx);
assert.deepStrictEqual(calls.w.scenarios.bull.move, [10, 20], "ranges are ordered low to high");
const ck = A.checks(calls.w);
assert(ck.issues.some((x) => /12M call/.test(x)) && ck.issues.some((x) => /bearish call with a range entirely above zero/.test(x)), ck.issues.join("; "));
const ctx = A.cleanPart("context", { industries: [{ id: "I1", effect: "helps", why: "x" }, { id: "I999", effect: "hurts" }], macro: { regime: "Headwind", factors: [{ id: "MF1", effect: "headwind" }] } }, dz.idx);
assert.strictEqual(ctx.w.industries.length, 1); assert.strictEqual(ctx.w.macro.regime, "headwind"); assert.strictEqual(ctx.w.macro.factors[0].id, "MF1");
const lean = A.cleanPart("lean", { headline: "Up [F4]", calls: { "1M": { call: "neutral", for: ["a [I1]"], against: ["b"] } } }, dz.idx);
assert.strictEqual(lean.w.calls["1M"].call, "neutral");

// Wall Street, sentiment, the track record
const hh = [{ ticker: "AAA", weight: 0.6, px: 100 }, { ticker: "BBB", weight: 0.4, px: 50 }];
const stl = A.streetLook(hh, { AAA: { buy: 8, hold: 2, sell: 0, target: 120, consensus: "Buy" }, BBB: { buy: 1, hold: 3, sell: 0, target: 45 } });
assert(Math.abs(stl.buy_share - (0.6 * 0.8 + 0.4 * 0.25)) < 1e-9 && Math.abs(stl.upside - (0.6 * 0.2 + 0.4 * -0.1)) < 1e-9);
const sl = A.sentimentLook(hh, { AAA: [{ date: "2026-11-01", count: 10, normalized: 0.5 }, { date: "2026-08-20", count: 10, normalized: -0.5 }] }, "2026-11-09");
assert(Math.abs(sl.s30 - 0.5) < 1e-9 && Math.abs(sl.s90 - 0) < 1e-9);
const ser = { dates: ["2026-01-02", "2026-02-01", "2026-04-02", "2026-11-06"], closes: [100, 104, 99, 110] };
const lg = A.trackLog([], { "1M": { call: "slightly bullish", expected_move: [-2, 6] }, "3M": { call: "bearish", expected_move: [-8, -1] }, "12M": { call: "neutral" } }, "2026-01-02", 100);
assert.strictEqual(lg.length, 3); assert.strictEqual(A.trackLog(lg, { "1M": { call: "bearish" } }, "2026-01-02", 100).length, 3, "a day's calls are logged once");
const te = A.trackEval(lg, ser, "2026-11-09");
const r1 = te.rows.find((r) => r.h === "1M"), r3 = te.rows.find((r) => r.h === "3M"), r12 = te.rows.find((r) => r.h === "12M");
assert(r1.done && r1.hit === true && r1.in_range === true, "1M: +4% on a bullish call, inside -2..+6");
assert(r3.done && r3.hit === true, "3M: -1% on a bearish call"); assert(!r12.done, "12M is still open");
assert.strictEqual(te.done, 2); assert.strictEqual(te.hit, 1);
console.log("fundan tests passed", JSON.stringify({ top10: +conc.top10.toFixed(3), eff: +conc.effective_n.toFixed(1), cal: cal.length, prompts: A.PARTS.map((p) => A.partPrompt(fd, dz, p, "2026-11-09").length) }));
