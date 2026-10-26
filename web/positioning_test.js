// Tests for positioning: 13F quarter choice, insider norms, 13F changes, technicals, crowding rules, digest.
const assert = require("assert");
const P = require("./positioning.js");
assert.deepStrictEqual(P.latest13FQuarter("2026-10-25"), { year: 2026, quarter: 2 });
assert.deepStrictEqual(P.latest13FQuarter("2026-11-20"), { year: 2026, quarter: 3 });
assert.deepStrictEqual(P.latest13FQuarter("2026-02-10"), { year: 2025, quarter: 3 });
const ins = P.insiderSummary([{ year: 2026, quarter: 3, totalPurchases: 0, totalSales: 78 }, { year: 2026, quarter: 4, totalPurchases: 1, totalSales: 10 },
  ...Array.from({ length: 8 }, (_, k) => ({ year: 2024 + Math.floor(k / 4), quarter: (k % 4) + 1, totalPurchases: 0, totalSales: 20 }))]);
assert.deepStrictEqual(ins.quarters, ["2026-Q4", "2026-Q3"]); assert.strictEqual(ins.sales, 88); assert.strictEqual(ins.purchases, 1); assert.strictEqual(ins.sales_vs_norm, 88 / 40);
const inst = P.instSummary({ date: "2026-06-30", investorsHolding: 4227, lastInvestorsHolding: 3389, ownershipPercent: 72.65, ownershipPercentChange: 6.25, newPositions: 1004, closedPositions: 178, totalCalls: 94e6, totalPuts: 118e6, lastTotalCalls: 85e6, lastTotalPuts: 130e6, putCallRatio: 1.25, lastPutCallRatio: 1.54 });
assert(Math.abs(inst.holders_change - (4227 / 3389 - 1)) < 1e-12 && inst.own_change_pp === 6.25);
const up = Array.from({ length: 260 }, (_, i) => 100 * Math.pow(1.002, i));
const t = P.technicals({ closes: up });
assert(t.vs200 > 0.15 && t.rsi14 === 100 && Math.abs(t.from_high) < 1e-12);
const down = Array.from({ length: 260 }, (_, i) => 100 * Math.pow(0.998, i));
const members = Array.from({ length: 10 }, (_, k) => ({ symbol: "S" + k, market_cap: 100 + k, insider: { ...ins, sales_vs_norm: 2.2 }, inst: { ...inst }, short_pct: 0.02, tech: P.technicals({ closes: up }) }));
const a = P.aggregate(members, t);
assert.strictEqual(a.label, "crowded"); assert(a.signals.some((s) => /RSI/.test(s.text)) && a.signals.some((s) => /institutions raised/.test(s.text)) && a.signals.some((s) => /put\/call ratio fell/.test(s.text)));
assert(Math.abs(a.institutions.pcr - 118 / 94) < 1e-9 && a.breadth.above200 === 1);
const m2 = members.map((m) => ({ ...m, insider: { ...ins, purchases: 3, sales_vs_norm: 0.5 }, inst: { ...inst, own_change_pp: -2, pcr: 2, puts: 2e8, last_puts: 1e8, calls: 1e8, last_calls: 1e8 }, short_pct: 0.1, tech: P.technicals({ closes: down }) }));
const b = P.aggregate(m2, P.technicals({ closes: down }));
assert.strictEqual(b.label, "washed out", JSON.stringify(b.signals)); assert.strictEqual(b.insiders.buyers.length, 10);
const d = P.digest(a);
assert(d.includes("POSITIONING") && d.includes("crowded") && d.includes("Institutions (13F") && d.includes("Insiders (2026-Q4, 2026-Q3)") && !d.includes("undefined") && !d.includes("NaN"), d);
assert.strictEqual(P.aggregate([], null).label, "neutral");
console.log("positioning tests passed");
