const assert = require("assert");
const P = require("./portfolio.js");
const FX = require("./fixtures/funds.json");

// names and tickers
assert.strictEqual(P.nameKey("Alphabet Inc. Class A"), "alphabet");
assert.strictEqual(P.nameKey("ALPHABET INC CL C"), "alphabet");
assert.strictEqual(P.nameKey("BERKSHIRE HATHAWAY INC CL B"), "berkshire hathaway");
assert.strictEqual(P.nameKey("PROCTER + GAMBLE CO/THE"), P.nameKey("The Procter & Gamble Company"));
assert.strictEqual(P.tick("brk/b"), "BRK-B"); assert.strictEqual(P.tickRoot("BRK-B"), "BRK");
for (const t of ["SHOP.TO", "000660.KS", "BATS.L", "NOKIA.HE", "2454.TW"]) assert(P.isForeign(t), t);
for (const t of ["BRK.B", "BRK-B", "KO", "BF-B"]) assert(!P.isForeign(t), t);

// what each holding is
const k = (ticker, name) => P.kindOf({ ticker, name });
assert.strictEqual(k("", "US DOLLAR"), "cash");
assert.strictEqual(k("", "Fidelity Cash Central Fund"), "cash");
assert.strictEqual(k("IXRZ6", "XAP CONS STAPLES  DEC26"), "derivative");
assert.strictEqual(k("", "CME E-Mini S&P 500 Index Contracts (United States)"), "derivative");
assert.strictEqual(k("", "CONTRA WALGREENS BOOTS"), "derivative");
assert.strictEqual(k("", "Space Exploration Technologies Corp"), "private");
assert.strictEqual(k("", "Anthropic PBC Series F"), "private");
assert.strictEqual(k("", "JUUL Labs Inc 5% 9/28/2029"), "bond");
assert.strictEqual(k("SHOP.TO", "Shopify Inc"), "foreign");
assert.strictEqual(k("OPCH", "Option Care Health Inc"), "stock", "a company name with 'option' in it is still a stock");

// Contrafund: FMP's full holdings mapped onto the saved runs
const h = P.fromFmp(FX.fcntx_holdings);
assert(Math.abs(h.reduce((a, x) => a + x.weight, 0) - 1) < 1e-6);
const m = P.mapHoldings(h, [], FX.cos);
const by = (t) => m.find((x) => x.ticker === t);
assert.strictEqual(by("NVDA").via, "saved runs");
assert.strictEqual(by("GOOGL").industry, "Internet Content & Information", "GOOGL maps through GOOG, the class the run kept");
assert(/share class/.test(by("GOOGL").via));
assert.strictEqual(by("BRK-B")?.industry, "Insurance - Diversified", "BRK-B maps through BRK-A");
assert.strictEqual(by("SHOP.TO").kind, "foreign");
const cov = P.coverage(m, FX.runs, { now: "2026-11-09" });
const B = cov.buckets;
assert(Math.abs(Object.values(B).reduce((a, x) => a + x, 0) - 1) < 1e-9, "the buckets add up to the fund");
assert(cov.covered > 0.85, `most of Contrafund is covered: ${cov.covered}`);
assert(B.private > 0.05 && B.foreign > 0.04 && B.cash > 0.005, JSON.stringify(B));
assert.strictEqual(cov.outside[0].name, "Space Exploration Technologies Corp");
assert(cov.industries[0].weight > 0.1 && cov.industries[0].status === "analyzed");
// what's left for an FMP profile: US stocks no run has
assert(P.needProfiles(m).every((t) => !P.isForeign(t) && m.find((x) => x.ticker === t).kind === "stock"));
// a run older than two weeks is stale
const old = Object.fromEntries(Object.entries(FX.runs).map(([s, r]) => [s, { ...r, saved_at: "2026-10-01T00:00:00Z" }]));
assert(P.coverage(m, old, { now: "2026-11-09" }).buckets.stale > 0.8);

// EODHD: an ETF's own holdings carry their industry; a mutual fund's top 10 has names only
const eodXlp = { General: { Type: "ETF", Name: "Consumer Staples Select Sector SPDR Fund", Category: "Consumer Equity" }, Technicals: { Beta: 0.39 },
  ETF_Data: { NetExpenseRatio: 0.0009, TotalAssets: 14.5e9, AnnualHoldingsTurnover: 0.172, Yield: 2.5, Holdings_Count: 33,
    Asset_Allocation: { Cash: { "Net_Assets_%": 0.08 }, "Stock US": { "Net_Assets_%": 97.49 }, "Stock non-US": { "Net_Assets_%": 0 }, Bond: { "Net_Assets_%": 0 } },
    Sector_Weights: { "Consumer Defensive": { "Equity_%": 101.69 }, "Consumer Cyclicals": { "Equity_%": 1.47 } },
    Holdings: { "WMT.US": { Code: "WMT", Name: "Walmart Inc.", Sector: "Consumer Defensive", Industry: "Discount Stores", "Assets_%": 11.66 },
      "ZZZQ.US": { Code: "ZZZQ", Name: "A Company No Run Has", Sector: "Consumer Defensive", Industry: "Packaged Foods", "Assets_%": 1.0 } },
    Top_10_Holdings: { "WMT.US": { Code: "WMT", Name: "Walmart Inc.", "Assets_%": 11.66 } }, Performance: { Returns_1Y: 23.4, "1y_Volatility": 19.5 } } };
const fx = P.facts("XLP", [{ name: "XLP", expenseRatio: 0.08, avgVolume: 1 }], eodXlp);
assert.strictEqual(fx.type, "ETF"); assert.strictEqual(fx.expense, 0.0009); assert(Math.abs(fx.mix.stock_us - 0.9749) < 1e-9);
assert(Math.abs(fx.sectors["Consumer Defensive"] - 1.0169) < 1e-9 && fx.sectors["Consumer Cyclical"] > 0);
assert.strictEqual(P.benchmark(fx, fx.sectors).symbol, "SPY", "XLP is its own sector's SPDR, so it is measured against the S&P 500");
const eodH = P.fromEodEtf(eodXlp);
const m2 = P.mapHoldings([{ ticker: "WMT", name: "WALMART INC", weight: 0.5 }, { ticker: "ZZZQ", name: "A COMPANY", weight: 0.5 }], eodH, FX.cos);
assert.strictEqual(m2[0].via, "saved runs"); assert.strictEqual(m2[1].via, "EODHD"); assert.strictEqual(m2[1].industry, "Packaged Foods");
assert.strictEqual(P.mapHoldings([{ ticker: "ZZZQ", name: "A COMPANY", weight: 1 }], [], {}, { ZZZQ: { industry: "Tobacco", sector: "Consumer Defensive" } })[0].via, "FMP profile");
const eodFund = { General: { Type: "FUND", Name: "Fidelity Contrafund", Fund_Category: "Unclassified" }, Expense_Ratio: 0.7254,
  Asset_Allocation: { 0: { Type: "Cash", "Net_%": 0.55 }, 2: { Type: "Non US Stock", "Net_%": 9.25 }, 4: { Type: "US Stock", "Net_%": 84.46 } },
  Top_Holdings: { 0: { Name: "NVIDIA CORP", Weight: "9.34%" }, 2: { Name: "SPACE EXPLORATION TECHNOLOGIES CORP A (180 DAY LOCK UP)", Weight: "6.95%" } } };
const ff = P.facts("FCNTX", [{ assetClass: "Equity", expenseRatio: 0.63, avgVolume: 0, sectorsList: [{ industry: "Information Technology", exposure: 35.1 }] }], eodFund);
assert.strictEqual(ff.type, "Mutual fund"); assert.strictEqual(ff.category, "Equity", "EODHD's Unclassified falls back to FMP's asset class");
assert(Math.abs(ff.expense - 0.007254) < 1e-9); assert(Math.abs(ff.mix.stock_nonus - 0.0925) < 1e-9);
assert.strictEqual(P.benchmark(ff, cov.sectors).symbol, "SPY");
const flags = P.crossCheck(m, P.eodTop(eodFund));
const sx = flags.find((f) => /SPACE/.test(f.name));
assert(sx && sx.kind === "private", "SpaceX: a top holding the analysis can't cover");
// sector funds get their SPDR; Nasdaq funds QQQ
assert.strictEqual(P.benchmark({ symbol: "VDC", name: "Vanguard Consumer Staples" }, { "Consumer Defensive": 0.98 }).symbol, "XLP");
assert.strictEqual(P.benchmark({ symbol: "ONEQ", name: "Fidelity Nasdaq Composite Index ETF" }, { Technology: 0.5 }).symbol, "QQQ");

// ---- step 2: the look-through (digests built from the real saved runs)
assert.strictEqual(P.callNum("slightly bullish"), 1); assert.strictEqual(P.callNum("bearish"), -2); assert.strictEqual(P.callNum("neutral"), 0);
assert.strictEqual(P.callLabel(0.7), "slightly bullish"); assert.strictEqual(P.callLabel(-1.6), "bearish");
const lt = P.lookThrough(cov, FX.digests);
assert(lt.on > 0.8 && lt.on <= cov.covered + 1e-9, `the look-through rests on the covered weight: ${lt.on}`);
for (const t of ["income", "conservative", "growth", "aggressive"]) assert(lt.scores[t].v > 0 && lt.scores[t].v < 100, t);
for (const h of P.HZ) { const c = lt.calls[h]; assert(c.call && Math.abs(c.dist.up + c.dist.flat + c.dist.down - c.lean_on) < 0.2, h); }
assert(lt.val.fwd_pe.v > 10 && lt.val.fwd_pe.v < 60, "forward P/E in a sane range");
// harmonic P/E: two equal halves at 10x and 30x make 15x, not 20x
const hc = P.lookThrough({ industries: [{ industry: "A", weight: 0.5 }, { industry: "B", weight: 0.5 }] }, { a: { val: { pe: 10 }, risk: {}, calls: {}, lean: {} }, b: { val: { pe: 30 }, risk: {}, calls: {}, lean: {} } });
assert(Math.abs(hc.val.pe.v - 15) < 1e-9);
assert(lt.world.length && lt.world[0].w > 0.3, "the biggest world situation reaches much of the fund");
assert(lt.trade.length && lt.sens.length && lt.contrib.length);
assert(isFinite(lt.exp12.v));
// against SPY
const sm = P.mapHoldings(P.fromFmp(FX.spy_holdings), [], FX.cos), scov = P.coverage(sm, FX.runs, { now: "2026-11-09" });
assert(scov.covered > 0.97, `SPY is covered: ${scov.covered}`);
const ac = P.active(cov, scov, FX.digests);
assert(ac.overlap > 0.3 && ac.overlap < 0.95, `Contrafund overlaps SPY partly: ${ac.overlap}`);
assert(Math.abs(ac.rows.reduce((a, r) => a + r.active, 0) - (cov.us_stock - scov.us_stock)) < 0.02, "active weights net to the difference in stock weight");
assert(isFinite(ac.tilt));
// the code-only fill counts as covered, separately
const qcov = P.coverage([{ kind: "stock", industry: "Widgets", weight: 1 }], {}, { now: "2026-11-09", quant: { widgets: { name: "Widgets", saved_at: "2026-11-08" } } });
assert.strictEqual(qcov.buckets.quant, 1); assert.strictEqual(qcov.covered, 1); assert.strictEqual(qcov.covered_full, 0);

// ---- step 3: the fund strategist's dossier, prompt, checks and when to rewrite
const fd = { facts: ff, cov, look: lt, act: ac, bench: { symbol: "SPY" }, digests: FX.digests, flags };
const dz = P.dossier(fd);
for (const id of ["F1", "F2", "F3", "F4", "I1", "A1", "W1", "C1", "M1", "O1"]) assert(dz.idx[id], `dossier has ${id}`);
assert(/Semiconductors/.test(dz.text) && /Space Exploration/.test(dz.text));
const pr = P.writePrompt(fd, "2026-11-09");
assert(pr.length < 60000, `prompt stays small: ${pr.length}`);
const raw = { headline: "A growth fund leaning on chips [I1] and [Z9].", verdict: { call: "Attractive", why: "x [I1]" }, summary: "s", bets: [{ text: "chips", ids: ["I1", "Q7"] }, "plain bet [W1]"],
  fit: { growth: { fit: "Strong", adjust: 9, why: "w" }, income: { fit: "meh", adjust: -2 } }, watch: ["CPI [M1]"] };
const cw = P.cleanWriteup(raw, dz.idx);
assert.strictEqual(cw.w.headline, "A growth fund leaning on chips [I1] and."); assert.strictEqual(cw.dropped, 2);
assert.deepStrictEqual(cw.w.bets[0].ids, ["I1"]); assert.strictEqual(cw.w.bets[1].text, "plain bet [W1]");
assert.strictEqual(cw.w.verdict.call, "attractive"); assert.strictEqual(cw.w.fit.growth.adjust, 5); assert.strictEqual(cw.w.fit.growth.fit, "strong"); assert.strictEqual(cw.w.fit.income.fit, null);
const fp = P.fingerprint(fd);
assert.deepStrictEqual(P.changes(fp, fp), []);
assert(P.changes(null, fp).length === 1);
assert(P.changes(fp, { ...fp, calls: { ...fp.calls, "12M": "bearish" } })[0].includes("12M"));
assert(P.changes(fp, { ...fp, exp12: fp.exp12 + 2 }).length === 1 && P.changes(fp, { ...fp, exp12: fp.exp12 + 1 }).length === 0);
console.log("look-through", JSON.stringify({ on: +lt.on.toFixed(3), best: lt.best, fwd_pe: +lt.val.fwd_pe.v.toFixed(1), exp12: +lt.exp12.v.toFixed(1), calls: Object.fromEntries(P.HZ.map((h) => [h, lt.calls[h].lean || lt.calls[h].call])), overlap: +ac.overlap.toFixed(2), tilt: +ac.tilt.toFixed(2) }));
console.log("portfolio tests passed", JSON.stringify({ covered: +cov.covered.toFixed(3), ...Object.fromEntries(Object.entries(B).map(([a, b]) => [a, +b.toFixed(3)])) }));
