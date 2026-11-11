const assert = require("assert");
const M = require("./pmode.js");
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;

// weights
assert(near(M.normalizeWeights(Array(6).fill(0).map((_, i) => ({ ticker: "T" + i, weight: 1 }))).reduce((a, h) => a + h.weight, 0), 100, 1e-9), "normalized weights add to exactly 100");
assert.deepStrictEqual(M.normalizeWeights([{ ticker: "A", weight: 30 }, { ticker: "B", weight: 10 }]).map((h) => h.weight), [75, 25]);
assert.deepStrictEqual(M.weightsFromDollars([{ ticker: "a", dollar: 2500 }, { ticker: "b", dollar: 7500 }], 10000).map((h) => [h.ticker, h.weight]), [["A", 25], ["B", 75]]);
assert.strictEqual(M.marketValues({ totalInvestment: 1000, holdings: [{ ticker: "A", weight: 40 }] })[0].marketValue, 400);

// series: business days, two holdings and SPY
const dates = []; for (let t = Date.UTC(2023, 0, 2); dates.length < 800; t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) dates.push(d.toISOString().slice(0, 10)); }
const mk = (f) => ({ dates, closes: dates.map((_, i) => f(i)) });
const A = mk((i) => 100 * Math.exp(0.0006 * i + 0.02 * Math.sin(i / 9))), B = mk((i) => 50 * Math.exp(0.0002 * i + 0.01 * Math.sin(i / 13))), SPY = mk((i) => 400 * Math.exp(0.0004 * i + 0.015 * Math.sin(i / 9)));
const series = { A, B, SPY };
const hold = [{ ticker: "A", weight: 60, sector: "Tech" }, { ticker: "B", weight: 40, sector: "Health" }];

// NAV: buy and hold, rebased
const nv = M.nav(series, hold, { start: 10000 });
assert.strictEqual(nv.values[0], 10000); assert.strictEqual(nv.dates.length, 800);
const k = 799, expect = 10000 * (0.6 * A.closes[k] / A.closes[0] + 0.4 * B.closes[k] / B.closes[0]);
assert(near(nv.values[k], expect, 1e-6), "NAV_t = sum w_i P_i,t / P_i,0");
// a holding that starts later moves the start to the day every holding trades
const late = { dates: dates.slice(100), closes: B.closes.slice(100) };
assert.strictEqual(M.nav({ A, B: late }, hold).dates[0], dates[100]);
assert.deepStrictEqual(M.nav({ A }, hold).missing, ["B"]);

// measures
const m = M.metrics(nv, SPY);
assert(m.volatility > 0 && m.maxDrawdown > 0 && isFinite(m.sharpeRatio) && isFinite(m.sortinoRatio) && isFinite(m.calmarRatio));
assert(near(m.totalReturn, nv.values[k] / 10000 - 1));
assert(near(m.annReturn, Math.pow(1 + m.totalReturn, 252 / 799) - 1), "geometric annualized return");
assert(near(m.sharpeRatio, (m.annReturn - 0.04) / (m.volatility / 100)));
assert(m.beta > 0 && m.correlationToSPY > 0 && m.correlationToSPY <= 1 && isFinite(m.upsideCapture) && isFinite(m.alpha));
assert.strictEqual(M.maxDrawdown([100, 120, 90, 130, 65]), 50);
assert.strictEqual(M.var95([...Array(100).keys()].map((i) => (i - 50) / 1000)), 4.5);
const self = M.metrics({ dates, values: SPY.closes }, SPY); assert(near(self.beta, 1, 1e-9) && near(self.correlationToSPY, 1, 1e-9) && near(self.upsideCapture, 100) && near(self.alpha, 0, 1e-12), "SPY against itself");

const short = M.metrics({ dates: dates.slice(0, 60), values: nv.values.slice(0, 60) }, SPY); assert(isFinite(short.beta) && short.betaBasis === "daily", "short periods get a daily beta");
assert.strictEqual(m.betaBasis, "monthly");
// concentration
assert(near(M.effectiveHoldings(Array(10).fill(10)), 10)); assert(near(M.effectiveHoldings([91, ...Array(9).fill(1)]), 1 / (0.91 ** 2 + 9 * 0.0001)));
const sh = M.sectorHHI([{ sector: "Tech", weight: 70 }, { sector: "Health", weight: 30 }]); assert(near(sh.hhi, 70 ** 2 + 30 ** 2)); assert.strictEqual(M.hhiLabel(sh.hhi), "Highly concentrated");

// attribution adds up exactly to the portfolio's return, with and without a rebalance
const c = M.contributions(series, hold, nv); assert(near(c.total, m.totalReturn, 1e-9), "sum of contributions = portfolio return");
assert(near(c.rows.find((r) => r.ticker === "A").contribution, 0.6 * (A.closes[k] / A.closes[0] - 1)));
const ev = [{ id: "e1", date: dates[400], label: "Rebalance", trades: [{ ticker: "A", newWeight: 20 }, { ticker: "B", newWeight: 80 }] }];
const nv2 = M.nav(series, hold, { start: 10000, events: ev }), c2 = M.contributions(series, hold, nv2, ev);
assert(Math.abs(nv2.values[k] - nv.values[k]) > 1, "the rebalance changes the path");
assert(near(c2.total, nv2.values[k] / 10000 - 1, 1e-9), "attribution still adds up across a rebalance");

// positions: bought on day 0, today's value, cost and gain; with a rebalance the cost basis follows average cost
const ps = M.positions(series, hold, { from: dates[0], start: 10000 }), pa = ps.rows.find((r) => r.ticker === "A");
assert(near(pa.value, 6000 * A.closes[k] / A.closes[0], 1e-6) && near(pa.cost, 6000) && near(pa.gain, pa.value - 6000) && near(ps.total, nv.values[k], 1e-6));
assert(near(pa.shares, pa.value / A.closes[k]) && near(ps.rows.reduce((a, r) => a + r.weightNow, 0), 100, 1e-9));
const ps2 = M.positions(series, hold, { from: dates[0], start: 10000, events: ev }); assert(near(ps2.total, nv2.values[k], 1e-6));
const ev2 = [...ev, { id: "e2", date: dates[400], label: "Edit", trades: [{ ticker: "A", newWeight: 50 }, { ticker: "B", newWeight: 50 }] }];
const pe2 = M.positions(series, hold, { from: dates[0], start: 10000, events: ev2 }), wa = pe2.rows[0].value / pe2.total, xa = 0.5 * A.closes[k] / A.closes[400], xb = 0.5 * B.closes[k] / B.closes[400];
assert(near(wa, xa / (xa + xb), 1e-9), "two events on one day: the later one wins");
const C = mk((i) => 20 + i * 0.01), ev3 = [{ id: "e3", date: dates[500], trades: [{ ticker: "A", newWeight: 50 }, { ticker: "C", newWeight: 50 }] }], pc = M.positions({ ...series, C }, [{ ticker: "A", weight: 50 }, { ticker: "C", weight: 50 }], { from: dates[0], start: 10000, events: ev3, base: hold });
assert(near(pc.rows.find((r) => r.ticker === "C").value / pc.total, 0.5 * (C.closes[k] / C.closes[500]) / (0.5 * C.closes[k] / C.closes[500] + 0.5 * A.closes[k] / A.closes[500]), 1e-9), "a ticker a rebalance brings in is bought then");
const own = M.positions(series, [{ ticker: "A", weight: 100, shares: 10, avg_cost: 90 }], { from: dates[0], start: 10000, prices: { A: 120 } }).rows[0]; assert(own.value === 1200 && own.cost === 900 && own.gain === 300 && !own.implied);
// rebalance sheet, look-through, health
const tr = M.rebalanceTrades([{ ticker: "A", weight: 60, price: 100 }, { ticker: "B", weight: 40 }], { A: 50, B: 40, C: 10 }, 100000);
assert.deepStrictEqual(tr.map((t) => [t.ticker, t.action, Math.round(t.deltaUsd)]), [["A", "SELL", -10000], ["C", "BUY", 10000], ["B", "HOLD", 0]]); assert.strictEqual(tr[0].shares, -100);
const lt = M.lookThrough([{ ticker: "AAPL", weight: 20 }, { ticker: "QQQ", weight: 50 }], { QQQ: [{ ticker: "AAPL", weight: 0.08 }, { ticker: "MSFT", weight: 0.09 }] });
assert(near(lt.rows.find((r) => r.ticker === "AAPL").total, 0.2 + 0.5 * 0.08) && lt.overlap.length === 1 && near(lt.covered, 0.5 * 0.17));
const hs = M.healthScore(m, M.effectiveHoldings([60, 40]), 2, sh.hhi); assert(hs.score >= 0 && hs.score <= 100 && hs.parts.length === 5);
assert.strictEqual(M.stance("beta", 0.9), "good"); assert.strictEqual(M.stance("hhi", 3000), "bad"); assert.strictEqual(M.stance("capture", 0, { up: 105, down: 90 }), "good");
assert(near(M.weighted([{ weight: 50, pe: 10 }, { weight: 50, pe: 40 }], "pe", { harmonic: true }), 16));
assert.strictEqual(M.periodStart("2026-11-09", "YTD"), "2026-01-01"); assert.strictEqual(M.periodStart("2026-11-09", "3Y"), "2023-11-09");
assert(M.toCsv({ totalInvestment: 1000, holdings: hold }).split("\n").length === 3);
console.log("pmode tests passed", JSON.stringify({ ret: +m.totalReturn.toFixed(3), vol: +m.volatility.toFixed(1), sharpe: +m.sharpeRatio.toFixed(2), beta: +m.beta.toFixed(2), health: hs.score }));
