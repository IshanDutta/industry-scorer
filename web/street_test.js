const assert = require("assert");
const S = require("./street.js");
const today = "2026-11-25";
const rhist = Array.from({ length: 13 }, (_, i) => { const d = new Date(Date.UTC(2025, 10 + i, 1)).toISOString().slice(0, 10); return { date: d, sb: 5, b: 10 + i, h: 12 - Math.floor(i / 2), s: 2, ss: i < 6 ? 1 : 0 }; });
const actions = [
  { date: "2026-11-10", firm: "Jefferies", from: "Hold", to: "Buy", action: "upgrade" },
  { date: "2026-10-02", firm: "UBS", from: "Buy", to: "Buy", action: "maintain" },
  { date: "2026-09-01", firm: "Citi", from: "Buy", to: "Neutral", action: "downgrade" },
  { date: "2026-06-01", firm: "BofA", from: "", to: "Buy", action: "init" },
  { date: "2025-06-01", firm: "Old", from: "", to: "Buy", action: "upgrade" },
];
const T = S.one({ sym: "KO", rhist, actions, ptrend: { m: 80, m_n: 6, y: 72, y_n: 30 }, px: 70, today });
assert.strictEqual(T.months.length, 13);
assert(T.now.buy > T.ago.buy, "buy share rose");
assert.deepStrictEqual([T.a90.up, T.a90.down], [1, 1]);
assert.deepStrictEqual([T.a365.up, T.a365.down, T.a365.init, T.a365.n], [1, 1, 1, 4], "older than a year left out");
assert(Math.abs(T.pt.chg - (80 / 72 - 1)) < 1e-9);
assert.strictEqual(T.label, "improving");
const tx = S.text(T);
assert(tx.length >= 4 && /\*\*/.test(tx[0]) && /Jefferies upgraded it at \*Buy\* on Nov 10/.test(tx.join(" ")), tx.join("\n"));
assert(/The trend: improving/.test(tx[tx.length - 1]));
assert(!/…/.test(tx.join(" ")));

const T2 = S.one({ sym: "PEP", rhist: rhist.map((m, i) => ({ ...m, b: 22 - i, sb: 5, h: 6 + i })), actions: [{ date: "2026-11-01", firm: "MS", to: "Equal-weight", action: "downgrade" }], ptrend: { m: 150, y: 170 }, px: 140, today });
assert.strictEqual(T2.label, "cooling");
const M = S.many([{ sym: "KO", w: 0.6, T }, { sym: "PEP", w: 0.4, T: T2 }, { sym: "X", w: 0.1, T: S.one({ sym: "X", rhist: [], today }) }]);
assert.strictEqual(M.n, 2); assert.strictEqual(M.months.length, 13);
assert(Math.abs(M.now.buy - (0.6 * T.now.buy + 0.4 * T2.now.buy)) < 1e-9);
assert.strictEqual(M.up[0].sym, "KO"); assert.strictEqual(M.down[0].sym, "PEP");
const tm = S.text(M, { what: "companies", coverage: 0.9 });
assert(/Across the 2 biggest companies/.test(tm[0]) && /Most improved: \*\*KO\*\*/.test(tm[1]), tm.join("\n"));
assert.deepStrictEqual(S.text(S.one({ sym: "Z", rhist: [], today })), []);
console.log("street ok");
