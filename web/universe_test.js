// Tests for the sector universe: normalization, hygiene, share-class dedupe, pruning, grouping.
const assert = require("assert");
const U = require("./universe.js");

for (const [i, o] of [["XLK", "Technology"], ["Information Technology", "Technology"], ["Financials", "Financial Services"], ["consumer discretionary", "Consumer Cyclical"],
  ["Consumer Staples", "Consumer Defensive"], ["Materials", "Basic Materials"], ["Communication Services", "Communication Services"], ["Health Care", "Healthcare"], ["xlre", "Real Estate"], ["Energy", "Energy"]])
  assert.strictEqual(U.normalizeSector(i), o, i);
assert.strictEqual(U.normalizeSector("Semiconductors"), null);
const q = U.sectorQuery("Technology");
assert.deepStrictEqual(q, { endpoint: "search-company-screener", sector: "Technology", exchange: "NASDAQ,NYSE,AMEX", isEtf: false, isFund: false, isActivelyTrading: true, limit: 5000 });

const row = (symbol, companyName, industry, marketCap, country = "US") => ({ symbol, companyName, industry, marketCap, country, exchangeShortName: "NYSE", sector: "Financial Services" });
const rows = [
  row("BRK-A", "Berkshire Hathaway Inc.", "Insurance - Diversified", 1.16e12), row("BRK-B", "Berkshire Hathaway Inc. Class B", "Insurance - Diversified", 1.0e12),
  row("NTRS", "Northern Trust Corporation", "Asset Management", 3.07e10), row("BN", "Brookfield Corporation", "Asset Management", 84762384860, "CA"),
  row("BNJ", "Brookfield Finance Inc. 4.50% P", "Asset Management", 84762384474, "CA"), row("BNH", "Brookfield Finance Inc.", "Asset Management", 84762384474, "CA"),
  row("APO", "Apollo Global Management, Inc.", "Asset Management", 66630984630), row("APOS", "Apollo Global Management, Inc.", "Asset Management", 66630984614),
  row("PBT", "Permian Basin Royalty Trust", "Asset Management", 5e8), row("GBTC", "Grayscale Bitcoin Trust (BTC)", "Asset Management", 2e10),
  row("XYZ", "Something Fund", "Asset Management", 1e9), row("JPM-PC", "JPMorgan Chase & Co. Preferred", "Banks - Diversified", 1e9),
  row("ABC.WS", "ABC Warrant", "Asset Management", 1e8), row("NOIND", "No Industry Inc.", "", 1e9), row("ZERO", "Zero Cap Inc.", "Asset Management", 0),
  row("BADNOTE", "Bad Note", "Asset Management", 1e9), row("NOTE", "Acme Corp 5.25% Notes due 2030", "Asset Management", 1e9),
];
for (let i = 0; i < 16; i++) rows.push(row("AM" + String.fromCharCode(65 + i), `Manager ${String.fromCharCode(65 + i)} Inc.`, "Asset Management", 1e9 * (i + 1)));
for (let i = 0; i < 14; i++) rows.push(row("INS" + String.fromCharCode(65 + i), `Insurer ${String.fromCharCode(65 + i)} Inc.`, "Insurance - Diversified", 1e9 + i * 1e7));
const out = U.organize(rows, { topN: 5, sector: "Financial Services" });
const am = out.industries.find((x) => x.industry === "Asset Management");
const syms = am.all.map((x) => x.symbol);
assert(syms.includes("NTRS"), "operating company named Trust is kept");
assert(!syms.includes("PBT") && !syms.includes("GBTC"), "royalty/grantor trusts dropped");
assert(!syms.includes("BNJ") && !syms.includes("BNH") && syms.includes("BN"), "parent's listed notes/preferreds dropped");
assert(syms.includes("APO") && !syms.includes("APOS"), "share classes deduped, larger kept");
assert(!syms.includes("XYZ") && !syms.includes("BADNOTE") && !syms.includes("NOTE") && !syms.includes("ZERO"));
assert.deepStrictEqual(am.top.map((x) => x.symbol), ["BN", "APO", "NTRS", "AMP", "AMO"], "top N largest first");
assert.strictEqual(am.count, 3 + 16);
assert.strictEqual(Math.round(am.total_market_cap), Math.round(am.all.reduce((s, x) => s + x.marketCap, 0)));
// Insurance: Berkshire (one class) + 14 insurers = 15 -> kept
const ins = out.industries.find((x) => x.industry === "Insurance - Diversified");
assert(ins && ins.count === 15 && ins.top[0].symbol === "BRK-A", JSON.stringify(out.pruned));
assert.strictEqual(out.industries[0].industry, "Insurance - Diversified", "ranked by total cap");
assert.strictEqual(out.industries[0].rank, 1);
// Pruning: drop one insurer -> 14 -> pruned
const out2 = U.organize(rows.filter((r) => r.symbol !== "INSA"), { topN: 5 });
assert(!out2.industries.find((x) => x.industry === "Insurance - Diversified"));
assert.deepStrictEqual(out2.pruned.find((x) => x.industry === "Insurance - Diversified"), { industry: "Insurance - Diversified", count: 14 });
assert(out.dropped.symbol >= 2 && out.dropped["no industry"] === 1 && out.dropped["duplicate share class"] >= 3);
// US-only option
const out3 = U.organize(rows, { topN: 50, usOnly: true });
assert(!out3.industries.find((x) => x.industry === "Asset Management").all.some((x) => x.country !== "US"));
console.log("universe tests passed");
