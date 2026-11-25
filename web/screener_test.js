// node web/screener_test.js
const assert = require("assert");
const S = require("./screener.js");
const etf = (s, n, mc, info, ctry, ch) => { const o = S.row({ symbol: s, companyName: n, marketCap: mc, price: 100, lastAnnualDividend: 2, beta: 1, exchangeShortName: "AMEX" }, "etf"); S.withInfo(o, info, ctry); if (ch) S.withReturns(o, ch); return o; };
const rows = [
  etf("VOO", "Vanguard S&P 500 ETF", 1.6e12, [{ expenseRatio: 0.03, assetClass: "Large Cap Equity", etfCompany: "Vanguard", sectorsList: [{ industry: "Technology", exposure: 34 }, { industry: "Healthcare", exposure: 11 }] }], [{ country: "United States", weightPercentage: "99%" }], { "1Y": 10, "3Y": 33.1 }),
  etf("XLK", "Technology Select Sector SPDR", 9e10, [{ expenseRatio: 0.08, assetClass: "Equity", etfCompany: "State Street", sectorsList: [{ industry: "Technology", exposure: 99 }] }], [{ country: "United States", weightPercentage: "100%" }], { "1Y": 20, "3Y": 72.8 }),
  etf("BND", "Vanguard Total Bond Market ETF", 1.3e11, [{ expenseRatio: 0.03, assetClass: "Fixed Income", etfCompany: "Vanguard" }], [], { "1Y": -4 }),
  etf("VWO", "Vanguard FTSE Emerging Markets ETF", 9e10, [{ expenseRatio: 0.07, assetClass: "Equity", etfCompany: "Vanguard", sectorsList: [{ industry: "Technology", exposure: 25 }] }], [{ country: "China", weightPercentage: "40%" }, { country: "India", weightPercentage: "30%" }, { country: "Taiwan", weightPercentage: "30%" }], { "1Y": -2 }),
  S.withRatios(S.row({ symbol: "AAPL", companyName: "Apple", marketCap: 4e12, price: 350, lastAnnualDividend: 1, sector: "Technology", industry: "Consumer Electronics", country: "US", exchangeShortName: "NASDAQ" }, "stock"), [{ priceToEarningsRatioTTM: 39, priceToBookRatioTTM: 46 }]),
  S.withRatios(S.row({ symbol: "JPM", companyName: "JPMorgan", marketCap: 7e11, price: 300, lastAnnualDividend: 6, sector: "Financial Services", industry: "Banks", country: "US", exchangeShortName: "NYSE" }, "stock"), [{ priceToEarningsRatioTTM: 14, priceToBookRatioTTM: 2 }]),
  S.withRatios(S.row({ symbol: "MID", companyName: "Mid Co", marketCap: 5e9, price: 40, sector: "Industrials", industry: "Machinery", country: "GB", exchangeShortName: "NYSE" }, "stock"), [{ priceToEarningsRatioTTM: 22, priceToBookRatioTTM: 4 }]),
];
S.derive(rows);
const by = Object.fromEntries(rows.map((o) => [o.s, o]));
// facts and derived fields
assert.equal(by.VOO.er, 0.0003); assert.equal(by.VOO.r["3Y"], 0.1); assert.equal(by.VOO.cat, "US stock: Large blend"); assert.equal(by.VOO.box, "Large blend");
assert.equal(by.XLK.cat, "Sector: Technology"); assert.equal(by.BND.cat, "Bond: core"); assert.equal(by.BND.box, null); assert.equal(by.VWO.cat, "Emerging markets"); assert.equal(by.VWO.rg.em, 100);
assert.equal(by.AAPL.st, "Growth"); assert.equal(by.JPM.st, "Value"); assert.equal(by.MID.sz, "Mid"); assert.equal(by.MID.rk, "eu"); assert.equal(by.JPM.y, 0.02);
// screening
const run = (spec) => S.run(rows, spec).rows.map((o) => o.s);
assert.deepEqual(run({ types: ["etf"], filters: [{ k: "er", max: 0.0005 }] }), ["VOO", "BND"]);
assert.deepEqual(run({ types: ["etf"], filters: [{ k: "esec", any: ["Technology"] }] }), ["VOO", "XLK", "VWO"]);
assert.deepEqual(run({ types: ["etf"], filters: [{ k: "esec", any: ["Technology"], th: 50 }] }), ["XLK"]);
assert.deepEqual(run({ types: ["etf"], filters: [{ k: "ereg", any: ["em"] }] }), ["VWO"]);
assert.deepEqual(run({ types: ["etf"], filters: [{ k: "r", p: "3Y", min: 0.15 }] }), ["XLK"]);
assert.deepEqual(run({ types: ["etf", "stock"], filters: [{ k: "er", max: 0.0005 }] }), ["AAPL", "VOO", "JPM", "BND", "MID"], "a fund criterion lets stocks through");
assert.deepEqual(run({ types: ["stock"], filters: [{ k: "pe", max: 25 }], sorts: [{ c: "pe", d: 1 }] }), ["JPM", "MID"]);
assert.deepEqual(run({ types: ["etf"], filters: [], sorts: [{ c: "er", d: 1 }, { c: "mc", d: -1 }] }), ["VOO", "BND", "VWO", "XLK"], "multi-sort");
const miss = S.run(rows, { types: ["etf"], filters: [{ k: "r", p: "3Y", min: 0 }] }).missing; assert.equal(miss.r, 2);
// values, similar, csv, units
assert.deepEqual(S.values(rows, "pv", ["etf"])[0], ["Vanguard", 3]);
assert.equal(S.similar(by.VOO, rows, 3)[0].o.s !== "BND", true);
assert.equal(S.fromUI(S.CRIT.er, "0.2"), 0.002); assert.equal(S.toUI(S.CRIT.aum, 5e8), 500);
const csv = S.csv([by.VOO], ["s", "er", "r3Y"]).split("\n"); assert.equal(csv[1], "VOO,0.03,10");
// risk from prices
const d = [], c = []; let v = 100; const t = new Date("2020-01-02"); while (t <= new Date("2026-11-20")) { if (t.getUTCDay() % 6) { d.push(t.toISOString().slice(0, 10)); v *= 1 + 0.0003 + 0.01 * Math.sin(d.length * 0.37); c.push(v); } t.setUTCDate(t.getUTCDate() + 1); }
const m = S.metrics({ dates: d, closes: c }, { dates: d, closes: c }, 0.04); assert.ok(m.v3 > 0 && Math.abs(m.b3 - 1) < 0.01 && m.dd < 0);
const o = S.returnsFromSeries({}, { dates: d, closes: c }); assert.ok(o.r["5Y"] !== undefined && o.r["10Y"] === undefined && o.tr === 1);
console.log("screener ok");
