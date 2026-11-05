const assert = require("assert");
const C = require("./company.js");
// percentiles and peers
assert.strictEqual(Math.round(C.pctRank(5, [1, 2, 3, 4, 6, 7, 8, 9]) * 100), 50);
const cons = [{ symbol: "A", market_cap: 100e9, pe: 20, op_margin: 0.3 }, { symbol: "B", market_cap: 90e9, pe: 15, op_margin: 0.1 }, { symbol: "C", market_cap: 5e9, pe: 30, op_margin: 0.2 }, { symbol: "D", market_cap: 1e9, pe: 10, op_margin: 0.05 }];
const pt = C.peerTable({ symbol: "A", market_cap: 100e9, pe: 20, op_margin: 0.3 }, cons);
const opm = pt.find((r) => r.key === "op_margin"), pe = pt.find((r) => r.key === "pe");
assert(opm.pct === 100 && opm.good === 100, "highest margin is best"); assert(pe.good < 50 || pe.good === 33, "a higher P/E is worse");
assert.deepStrictEqual(C.closestPeers({ symbol: "A", market_cap: 100e9 }, cons, [{ symbol: "D" }], 2).map((x) => x.symbol), ["B", "C"].includes("B") ? ["B", "C"] : []);
// names
assert.strictEqual(C.nameCore("The Coca-Cola Company"), "Coca-Cola"); assert.strictEqual(C.nameCore("PepsiCo, Inc."), "PepsiCo");
// mentions: ticker fields, ticker lists, text; another company's longer name isn't a match
const run = { reports: { world: { dives: [{ title: "Tariffs", winners: [{ symbol: "KO", why: "pricing power" }], exposure: [{ segment: "Bottlers", names: ["KOF"], why: "Coca-Cola FEMSA pays the tariff" }] }] },
  kpi: { summary: "KO grew volume 5% [T1]." } }, books: [], lead: { opportunity: { best: ["KO"], why: "Best way to play volume" } } };
const m = C.mentions("KO", "The Coca-Cola Company", run, 70, ["Coca-Cola FEMSA, S.A.B. de C.V."]);
assert(m.some((x) => x.role === "winner" && /pricing power/.test(x.text)), "winner found");
assert(m.some((x) => /KO grew volume 5%\.$/.test(x.text)), "text mention, with the industry's citation removed");
assert(!m.some((x) => /FEMSA pays/.test(x.text)), "Coca-Cola FEMSA isn't Coca-Cola");
// implied growth
const ig = C.impliedGrowth({ fcf: 14.3e9, mcap: 399e9, rf: 0.042, beta: 0.3, erp: 0.045 });
assert(Math.abs(ig.r - 0.0645) < 1e-9 && ig.g > 0.02 && ig.g < 0.04, "implied growth " + ig.g);
// thesis cleaning and checks
const idx = { A1: {}, N1: {} };
const t = C.cleanThesis({ headline: "Strong [A1, Z9] .", thesis: "One [N7].\n\nTwo.", drivers: [{ driver: "Volume", effect: "STRONGER", evidence: ["A1", "Q3"] }],
  scenarios: { bull: { probability: 30, eps_change: [10, 14], pe: [26, 28], price_target: [110, 116] }, base: { probability: 50, eps_change: [6, 8], pe: [24, 26], price_target: [97, 103] }, bear: { probability: 20, eps_change: [0, 2], pe: [20, 22], price_target: [80, 86] } },
  horizons: { "12M": { call: "bearish", expected_move: [2, 10], probability_up: 60 } } }, idx);
assert.strictEqual(t.headline, "Strong [A1]."); assert.strictEqual(t.thesis, "One.\n\nTwo."); assert.deepStrictEqual(t.drivers[0].evidence, ["A1"]); assert.strictEqual(t.drivers[0].effect, "stronger");
const ck = C.checks(t, 92, 25);
assert(Math.abs(ck.expected_return - (0.3 * (113 / 92 - 1) + 0.5 * (100 / 92 - 1) + 0.2 * (83 / 92 - 1))) < 1e-9, "expected return");
assert(ck.issues.some((x) => /12M is slightly bearish/.test(x)), "a bearish call centered above zero is flagged");
console.log("company tests passed");
