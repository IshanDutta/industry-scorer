// node web/pfdeep_test.js
const P = require("./pfdeep.js"), assert = require("assert");
const days = []; const d = new Date("2019-01-02"); while (days.length < 1500) { if (d.getUTCDay() % 6) days.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
const ser = (drift, amp, ph) => { let v = 100; return { dates: days, closes: days.map((_, i) => (v *= 1 + drift + amp * Math.sin(i * 0.37 + ph))) }; };
const series = { SPY: ser(0.0003, 0.01, 0), A: ser(0.0005, 0.015, 1), B: ser(0.0001, 0.004, 2) };
const nav = P.nav(series, [{ symbol: "A", w: 0.6 }, { symbol: "B", w: 0.4 }], series.SPY);
assert(nav && nav.dates.length > 1000, "nav built");
const pr = P.project(P.monthlyPair(nav, series.SPY), { mu: 0.08, muS: 0.07, amount: 10000 });
assert(pr.horizons[1].p5 < pr.horizons[1].p50 && pr.horizons[1].p50 < pr.horizons[1].p95, "ordered percentiles");
assert(Math.abs(pr.horizons[10].median_annual - 0.08) < 0.03, "median near the expected return: " + pr.horizons[10].median_annual);
const rs = P.riskSplit([0.6, 0.4], [0, 1], [[0.04, 0.005], [0.005, 0.01]], ["A", "B"]);
assert(Math.abs(rs.rows.reduce((s, r) => s + r.contrib, 0) - 1) < 1e-9, "risk shares add to 1");
const byRow = new Map([["X", { bull: { p: 25, move: 20 }, base: { p: 50, move: 5 }, bear: { p: 25, move: -20 } }]]);
const sc = P.scenarios({ industries: [{ name: "X", got: 0.9 }], stockShare: 0.9 }, byRow, { bonds: 0.1, bondMu: 0.04 });
assert(Math.abs(sc.bull.portfolio - (0.9 * 0.2 + 0.004)) < 1e-9 && Math.abs(sc.expected - 0.9 * 0.025 - 0.004) < 1e-9, "scenario roll-up");
console.log("pfdeep tests passed", JSON.stringify({ p50_1y: Math.round(pr.horizons[1].p50), loss_1y: pr.horizons[1].p_loss, med10: pr.horizons[10].median_annual.toFixed(3) }));
