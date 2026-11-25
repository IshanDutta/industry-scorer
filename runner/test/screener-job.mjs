// The Screener data job end to end against a fake FMP (no keys, no network):
//   node test/screener-job.mjs            (from runner/)
// Runs runner/screener.mjs with SCR_FAKE pointing here, then checks the rows it wrote.
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const U = {
  stock: [["AAPL", "Apple Inc.", 4e12, "Technology", "Consumer Electronics"], ["JPM", "JPMorgan Chase", 7e11, "Financial Services", "Banks - Diversified"], ["KO", "Coca-Cola", 3e11, "Consumer Defensive", "Beverages - Non-Alcoholic"], ["SMOL", "Small Co", 5e8, "Industrials", "Machinery"]],
  etf: [["VOO", "Vanguard S&P 500 ETF", 1.6e12], ["XLK", "Technology Select Sector SPDR", 9e10], ["BND", "Vanguard Total Bond Market ETF", 1.3e11], ["VWO", "Vanguard FTSE Emerging Markets ETF", 9e10], ["TQQQ", "ProShares UltraPro QQQ", 2e10]],
  fund: [["VTSAX", "Vanguard Total Stock Market Index Fund Admiral Shares", 1.9e12], ["FXAIX", "Fidelity 500 Index Fund", 6e11]],
};
const ser = (s) => { let seed = 0; for (const c of s) seed += c.charCodeAt(0); const out = []; let v = 50; const d = new Date(Date.now() - 11 * 365 * 864e5); let k = 0;
  while (d < new Date()) { if (d.getUTCDay() % 6) { k++; v *= 1 + 0.0004 + 0.012 * Math.sin(k * 0.29 + seed) * (1 + (seed % 3) / 3); out.push({ date: d.toISOString().slice(0, 10), adjClose: v }); } d.setUTCDate(d.getUTCDate() + 1); }
  return out.reverse(); };
export async function fmp(tool, x) {
  if (tool === "search") { const t = x.isFund ? "fund" : x.isEtf ? "etf" : "stock";
    return U[t].map(([symbol, companyName, marketCap, sector, industry]) => ({ symbol, companyName, marketCap, sector: sector || "Financial Services", industry: industry || "Asset Management", price: 100, lastAnnualDividend: 2, beta: 1, avgVolume: 1e6, exchangeShortName: t === "fund" ? "NASDAQ" : "NYSE", country: "US", isEtf: t === "etf", isFund: t === "fund" })); }
  if (tool === "chart") return x.symbol === "SMOL" ? [] : ser(x.symbol);
  if (tool === "economics") return [{ date: x.to_date, month3: 4.2 }];
  if (tool === "quote") return x.symbol.split(",").map((s) => ({ symbol: s, "1M": 1, "1Y": 10, "3Y": 30 }));
  if (tool === "etfAndMutualFunds" && x.endpoint === "information") {
    const m = { VOO: ["Large Cap Equity", 0.03, { Technology: 34, "Financial Services": 13 }], XLK: ["Equity", 0.08, { Technology: 99 }], BND: ["Fixed Income", 0.03, {}], VWO: ["Equity", 0.07, { Technology: 25, "Financial Services": 22 }], TQQQ: ["Equity", 0.84, { Technology: 60 }], VTSAX: ["Large Cap Equity", 0.04, { Technology: 36 }], FXAIX: ["Large Cap Equity", 0.015, { Technology: 34 }] }[x.symbol];
    return [{ symbol: x.symbol, assetClass: m[0], expenseRatio: m[1], etfCompany: /^F/.test(x.symbol) ? "Fidelity" : /XLK/.test(x.symbol) ? "State Street" : /TQQQ/.test(x.symbol) ? "ProShares" : "Vanguard", assetsUnderManagement: 1e10, holdingsCount: 500, inceptionDate: "2010-01-01", sectorsList: Object.entries(m[2]).map(([industry, exposure]) => ({ industry, exposure })) }]; }
  if (tool === "etfAndMutualFunds") return x.symbol === "VWO" ? [{ country: "China", weightPercentage: "30%" }, { country: "India", weightPercentage: "25%" }, { country: "Taiwan", weightPercentage: "20%" }, { country: "Brazil", weightPercentage: "25%" }] : x.symbol === "BND" ? [] : [{ country: "United States", weightPercentage: "99%" }, { country: "Other", weightPercentage: "1%" }];
  if (tool === "statements") return [{ priceToEarningsRatioTTM: { AAPL: 39, JPM: 14, KO: 24 }[x.symbol] || 18, priceToBookRatioTTM: { AAPL: 46, JPM: 2, KO: 10 }[x.symbol] || 3, netIncomePerShareTTM: 5, quickRatioTTM: 1, netProfitMarginTTM: 0.2, debtToEquityRatioTTM: 1 }];
  return [];
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = mkdtempSync(join(tmpdir(), "scr-"));
  execFileSync("node", [join(here, "../screener.mjs"), "--out", out], { stdio: "inherit", env: { ...process.env, SCR_FAKE: fileURLToPath(import.meta.url) } });
  const d = JSON.parse(gunzipSync(readFileSync(join(out, "screener.json.gz"))));
  const by = Object.fromEntries(d.rows.map((o) => [o.s, o]));
  assert.equal(d.rows.length, 11); assert.deepEqual(d.counts, { etf: 5, fund: 2, stock: 4 });
  assert.equal(by.VOO.er, 0.0003); assert.equal(by.VOO.cat, "US stock: Large blend"); assert.equal(by.XLK.cat, "Sector: Technology");
  assert.equal(by.BND.cat, "Bond: core"); assert.equal(by.VWO.cat, "Emerging markets"); assert.equal(by.TQQQ.cat, "Trading: leveraged or inverse");
  assert.ok(by.VOO.r["10Y"] !== undefined && by.VOO.tr === 1, "total returns from prices");
  assert.ok(by.VOO.v3 > 0 && by.VOO.sh3 !== undefined && by.VOO.b3 !== undefined && by.VOO.dd <= 0, "risk from prices");
  assert.equal(by.SMOL.r["1Y"], 0.1, "no prices: FMP's price change");
  assert.equal(by.AAPL.st, "Growth"); assert.equal(by.JPM.st, "Value"); assert.equal(by.AAPL.sz, "Large");
  assert.equal(by.VWO.rg.em, 100);
  console.log("screener job ok:", d.rows.length, "rows,", JSON.stringify(by.VOO).length, "bytes for VOO");
}
