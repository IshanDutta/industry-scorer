// Tests for ranking, concentration, levels, earnings moves, liquidity, position plans, credit, digest.
const assert = require("assert");
const P = require("./plan.js");
const cons = Array.from({ length: 10 }, (_, i) => ({ symbol: "S" + i, name: "Co " + i, market_cap: (10 - i) * 100, weight: (10 - i) / 55, pe: 10 + i * 3, fwd_pe: 8 + i * 2, ps: 2 + i, op_margin: 0.3 - i * 0.02, fcf_margin: 0.2 - i * 0.01, net_margin: 0.15 - i * 0.01,
  ntm_growth: 0.1 + i * 0.02, rev_growth: 0.05 + i * 0.01, excess_6M: i * 0.01, excess_1Y: i * 0.02, rev30: 0.01 * (5 - i), rev90: 0.02 * (5 - i), vol_1y: 0.2 + i * 0.02, max_dd_1y: -0.1 - i * 0.02, div_yield: 0.03 - i * 0.003, ret_1Y: i * 0.05, ret_3M: i * 0.01 }));
const rk = P.rankCompanies(cons);
const s0 = rk.rows.find((r) => r.symbol === "S0");
assert.strictEqual(s0.factors.value, 100); assert.strictEqual(s0.factors.quality, 100); assert.strictEqual(s0.factors.growth, 0); assert.strictEqual(s0.factors.risk, 100);
assert.deepStrictEqual(rk.best.income.slice(0, 1), ["S0"]); assert.strictEqual(rk.best.aggressive.length, 5);
assert(rk.rows[0].composite >= rk.rows[rk.rows.length - 1].composite);
const c = P.concentration(cons);
assert.deepStrictEqual(c.top3, ["S0", "S1", "S2"]); assert(Math.abs(c.top3_weight - 27 / 55) < 1e-12);
assert(c.r1y_ex3 > c.r1y_all && c.effective_n > 5 && c.effective_n < 10 && c.pe_ex3 > c.pe_all);
const closes = Array.from({ length: 260 }, (_, i) => 100 + i * 0.1 + (i % 7));
const lv = P.levels({ closes });
assert(lv.sma50 < lv.last + 10 && lv.high52 >= lv.last && lv.stop_1m < lv.last);
const dates = Array.from({ length: 260 }, (_, i) => new Date(Date.UTC(2025, 9, 1) + i * 864e5).toISOString().slice(0, 10));
const ser = { dates, closes: dates.map((_, i) => (i === 101 ? 110 : i === 99 ? 100 : 100 + (i > 101 ? 10 : 0))) };
const em = P.earningsMoves([dates[100], "2027-01-01"], ser, "2026-06-01");
assert(Math.abs(em.moves[0].move - 0.1) < 1e-12 && em.avg_abs > 0);
const lq = P.liquidity([{ symbol: "A", avgVolume: 1e5, price: 20 }, { symbol: "B", avgVolume: 1e7, price: 50 }]);
assert.deepStrictEqual(lq.thin, ["A"]);
const doc = { summary: { vol_1y: 0.4, beta: 1.5 }, positioning: { label: "crowded" }, plan: { index_levels: lv }, sensitivity: { factors: [{ key: "rates", total: { t: -2.5, effect: -0.015 } }] } };
const pl = P.positions({ growth: { fit: "strong", conviction: "high" }, conservative: { fit: "weak", conviction: "low" } }, doc, { nextEvent: "NVDA earnings on Nov 18" });
assert(Math.abs(pl.growth.size - Math.min(20, 3 / 40 * 100 * 1.2)) < 0.1, JSON.stringify(pl.growth)); assert(pl.conservative.size < 1);
assert(/Scale in/.test(pl.growth.entry) && /\$1\.50 of SPY/.test(pl.growth.hedge) && /Treasury duration/.test(pl.growth.rate_hedge) && pl.growth.stop_pct < 0);
const pl2 = P.positions({ income: { fit: "moderate", conviction: "medium" } }, { ...doc, positioning: { label: "neutral" } }, { nextEvent: "the Fed on Oct 28" });
assert(/after the Fed on Oct 28/.test(pl2.income.entry));
const cr = P.credit({ cmdi: [{ as_of_date: "2026-06-01T00:00:00", market_cmdi: 0.1, ig_cmdi: 0.15, hy_cmdi: 0.05 }, { as_of_date: "2026-09-25T00:00:00", market_cmdi: 0.2, ig_cmdi: 0.25, hy_cmdi: 0.11 }],
  hyg: { closes: Array.from({ length: 100 }, (_, i) => 100 - i * 0.05) }, ief: { closes: Array.from({ length: 100 }, () => 100) },
  companies: [{ symbol: "A", weight: 0.1, int_cover: 2, nd_ebitda: 1 }, { symbol: "B", weight: 0.2, int_cover: 10, nd_ebitda: 4 }, { symbol: "C", weight: 0.7, int_cover: 50, nd_ebitda: 0 }] });
assert(Math.abs(cr.cmdi.market_3m - 0.1) < 1e-12 && cr.hy_vs_treasuries_3m < 0 && Math.abs(cr.weak_weight - 0.3) < 1e-12);
const d = P.digest({ ranking: rk, conc: c, earn: [{ symbol: "S0", avg_abs: 0.06, next: "2026-11-18" }], liq: lq, credit: cr, lv });
assert(d.includes("COMPANY RANKING") && d.includes("CONCENTRATION") && d.includes("EARNINGS MOVES") && d.includes("S0 ±6.0%") && d.includes("LIQUIDITY") && d.includes("CREDIT") && d.includes("A, B = +30%") && !d.includes("undefined") && !/NaN/.test(d), d);
console.log("plan tests passed");
