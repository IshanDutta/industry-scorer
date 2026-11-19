// node bondan_test.js — the bond fund analysis' code: detection, profile, curve, the arithmetic, the dossier, cleaning.
const B = require("./bondan.js");
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log("FAIL", m); } };
const near = (a, b, e = 0.05) => Math.abs(a - b) <= e;
// HYG and TLT as FMP and EODHD describe them (trimmed from real answers, Nov 2026).
const HYG = { sym: "HYG", info: [{ symbol: "HYG", name: "iShares iBoxx $ High Yield Corporate Bond ETF", assetClass: "Fixed Income", expenseRatio: 0.49, assetsUnderManagement: 16972656124, inceptionDate: "2007-04-04", holdingsCount: 1331,
  sectorsList: [{ industry: "Consumer Cyclical", exposure: 17.28 }, { industry: "Communications", exposure: 14.97 }, { industry: "Energy", exposure: 11.35 }, { industry: "Other", exposure: 10.41 }, { industry: "Capital Goods", exposure: 10.08 }, { industry: "Banking", exposure: 0.15 }] }],
  holdings: [{ asset: "", name: "CCO HOLDINGS LLC 4.75% 03/01/2030", weight: 0.006 }, { asset: "", name: "CCO HOLDINGS LLC 5.125% 05/01/2027", weight: 0.004 }, { asset: "", name: "TRANSDIGM INC 6.375% 03/01/2029", weight: 0.005 }],
  eod: { General: { Name: "iShares iBoxx $ High Yield Corporate Bond ETF", Category: "High Yield Bonds" }, ETF_Data: { Yield: 6.09, NetExpenseRatio: 0.0049, Asset_Allocation: { Bond: { "Net_Assets_%": 98.516 }, Cash: { "Net_Assets_%": 0.5864 }, "Stock US": { "Net_Assets_%": 0 } },
    Fixed_Income: { EffectiveDuration: { "Fund_%": 3.0673 }, ModifiedDuration: { "Fund_%": 3.7574 }, EffectiveMaturity: { "Fund_%": 5.5473 }, CreditQuality: { "Fund_%": 0 }, Coupon: { "Fund_%": 6.755 }, Price: { "Fund_%": 96.4983 }, YieldToMaturity: { "Fund_%": 7.6584 } },
    Performance: { "1y_Volatility": 3.82, Returns_1Y: 1.56, Returns_3Y: 7.09, Returns_5Y: 3.34, Returns_10Y: 4.56, Returns_YTD: -0.11 } } } };
const TLT = { sym: "TLT", info: [{ symbol: "TLT", name: "iShares 20+ Year Treasury Bond ETF", assetClass: "Fixed Income", expenseRatio: 0.15 }], holdings: [],
  eod: { General: { Name: "iShares 20+ Year Treasury Bond ETF", Category: "US Government Bonds" }, ETF_Data: { Yield: 4.76, Asset_Allocation: { Bond: { "Net_Assets_%": 99.16 } }, Fixed_Income: { EffectiveDuration: { "Fund_%": 14.1294 }, EffectiveMaturity: { "Fund_%": 25.84 }, YieldToMaturity: { "Fund_%": 5.0899 }, Coupon: { "Fund_%": 3.48 } } } } };
const SPYlike = { sym: "AOR", info: [{ assetClass: "Asset Allocation" }], eod: { General: { Category: "Allocation" }, ETF_Data: { Asset_Allocation: { Bond: { "Net_Assets_%": 40 }, "Stock US": { "Net_Assets_%": 45 }, "Stock non-US": { "Net_Assets_%": 15 } } } } };
ok(B.isBond(HYG) && B.isBond(TLT) && !B.isBond(SPYlike), "bond funds detected, a 60/40 fund isn't one");
const p = B.profile(HYG), q = B.profile(TLT);
ok(p.kind === "high_yield" && q.kind === "treasury_long", `kinds: ${p.kind}, ${q.kind}`);
ok(near(p.duration, 3.07, 0.01) && near(p.ytm, 7.66, 0.01) && near(p.expense, 0.0049, 1e-6), "HYG's duration, yield and cost");
ok(p.top[0].name === "CCO HOLDINGS LLC" && near(p.top[0].w, 1.0, 1e-9) && near(p.top[1].w, 0.5, 1e-9), `issuers merged across their bonds: ${JSON.stringify(p.top[0])}`);
ok(B.kindOf("Vanguard Total Bond Market", "Intermediate Core Bond", 6) === "aggregate" && B.kindOf("iShares TIPS Bond", "", 7) === "tips" && B.kindOf("SPDR Bloomberg 1-3 Month T-Bill", "", 0.1) === "treasury_short", "other kinds");
ok(B.sectorOf("Communications") === "Communication Services" && B.sectorOf("Capital Goods") === "Industrials" && B.sectorOf("Banking") === "Financial Services" && B.sectorOf("Other") === null, "issuer sectors mapped to the runs' sectors");
// The curve: today, a month, three months and a year ago.
const row = (date, s) => ({ date, month3: 4.0 + s, year2: 4.4 + s, year5: 4.6 + s, year7: 4.75 + s, year10: 4.98 + s, year20: 5.35 + s, year30: 5.3 + s, month1: 3.95 + s, month6: 4.2 + s, year1: 4.3 + s, year3: 4.5 + s });
const curve = [row("2026-11-17", 0), row("2026-10-17", 0.2), row("2026-08-18", 0.1), row("2025-11-17", -0.5)];
ok(near(B.curveAt(curve[0], 3.07), 4.5 + 0.07 * (0.1 / 2), 0.01) && near(B.curveAt(curve[0], 25), 5.325, 0.001) && near(B.curveAt(curve[0], 50), 5.3), "the curve interpolates and holds its ends");
ok(near(B.priceMove(10, 0, 100), -10) && near(B.priceMove(10, 100, 100), -9.5) && near(B.priceMove(10, 100, -100), 10.5), "price moves with convexity");
const sens = { factors: [{ key: "rates", total: { beta: -0.031, effect: -0.031 * 0.25 } }, { key: "market", total: { beta: 0.28 } }, { key: "credit", total: { beta: 0.9 } }] };
const ser = { dates: [], closes: [] }; { const d = new Date("2023-01-03"); let v = 70; for (let k = 0; d.toISOString().slice(0, 10) <= "2026-11-17"; k++) { if (d.getUTCDay() % 6) { v *= 1 + 0.0002 + 0.004 * Math.sin(k / 9); ser.dates.push(d.toISOString().slice(0, 10)); ser.closes.push(v); } d.setUTCDate(d.getUTCDate() + 1); } }
const m = B.math(p, { curve, hqm: [{ date: "2026-10-01", y: 5.92 }, { date: "2025-10-01", y: 5.3 }], real: { y10: 2.66 }, sens, ser, sectorCalls: { "Consumer Cyclical": { call: "slightly bullish", score: 1, n: 5 }, "Communication Services": { call: "bearish", score: -2, n: 6 }, Energy: { call: "slightly bearish", score: -1, n: 4 }, Industrials: { call: "bullish", score: 2, n: 8 } }, today: "2026-11-19" });
ok(m.credit && near(m.carry, 7.6584 - 0.49, 1e-6), `carry after costs ${m.carry}`);
ok(near(m.spread, (7.6584 - B.curveAt(curve[0], 3.0673)) * 100, 0.01) && m.spread > 300, `HYG's spread ${Math.round(m.spread)}bp`);
ok(m.moves.length === 3 && near(m.moves[2].d10, 50, 0.01) && near(m.moves[0].d10, -20, 0.01), "curve moves over 1M, 3M, 12M");
ok(near(m.breakeven, (m.carry / 3.0673) * 100, 0.01), `breakeven ${Math.round(m.breakeven)}bp`);
ok(m.shocks.find((x) => x.bp === 100).ret < 0 && m.shocks.find((x) => x.bp === -100).ret > 0 && m.spreadShocks.length === 3, "rate and spread shocks");
ok(near(m.empDur, 3.1, 0.01) && near(m.eqBeta, 0.28), "measured duration from the 10-year beta");
ok(m.igSpread && near(m.igSpread.spread, (5.92 - 5.08) * 100, 0.5) && near(m.breakevenInfl, 4.98 - 2.66, 1e-9), `IG spread proxy ${m.igSpread?.spread} and breakeven inflation`);
ok(m.hist && isFinite(m.hist.r1y) && m.hist.mdd <= 0, "price record");
ok(m.lend && near(m.lend.covered, 0.1728 + 0.1497 + 0.1135 + 0.1008, 1e-6) && m.lend.down > 0 && m.lend.up > 0, `issuer sectors through the runs: ${JSON.stringify({ up: m.lend.up, down: m.lend.down })}`);
const mt = B.math(q, { curve, today: "2026-11-19" });
ok(!mt.credit && !isFinite(mt.spread) && mt.spreadShocks.length === 0 && mt.shocks.find((x) => x.bp === 100).ret < -12, "a Treasury fund: no spread, big rate shocks");
// The dossier and the cleaner.
const dz = B.dossier(p, m, { indicators: [{ label: "US 10Y Treasury yield", value: 4.98, unit: "%", prior: 5.21, prior_label: "1 month ago" }], reads: [{ industry: "Internet Content & Information", regime: "RESTRICTIVE", headline: "A December hike is priced", summary: "CPI 3.7%" }] }, "2026-11-19");
ok(/\[B2\] Yield to maturity 7\.66%/.test(dz.text) && dz.idx.R1 && dz.idx.C1 && dz.idx.S1 && dz.idx.I1 && dz.idx.M1 && dz.idx.H1, "the dossier has every block");
const pr = B.prompt(p, dz, "2026-11-19");
ok(/spread_change_bp/.test(pr) && !/spread_change_bp/.test(B.prompt(q, B.dossier(q, mt, {}, "2026-11-19"), "2026-11-19")), "spreads asked only of a credit fund");
const raw = { headline: "Paid to wait [B2][Z9].", verdict: "Fair", conviction: 6.4, thesis: "Carry [B2].\nRisk [C1].\nCall [R1].", rates: "Flat [R2].", credit: "Tight [C2].",
  scenarios: { bull: { probability: 25, rate_change_bp: -60, spread_change_bp: -40, narrative: "soft landing" }, base: { probability: 50, rate_change_bp: 0, spread_change_bp: 20 }, bear: { probability: 25, rate_change_bp: 40, spread_change_bp: 250, narrative: "recession" } },
  calls: { "1M": { call: "slightly bullish", why: "carry [B2]" }, "3M": { call: "neutral" }, "12M": { call: "strongly bullish", why: "x" } }, risks: [{ risk: "Defaults", why: "spreads [C1]", size: "huge" }] };
const w = B.clean(raw, dz, m);
ok(w.headline === "Paid to wait [B2]." && w.dropped === 1, `unknown ids dropped: ${w.headline}`);
ok(w.verdict === "fair" && w.conviction === 6 && !w.calls["3M"] && w.calls["1M"].call === "slightly bullish", "enums and levels checked");
ok(near(w.scenarios.bear.ret, B.horizonReturn(m, 12, 40, 250)) && w.scenarios.bear.ret < 0 && w.scenarios.bull.ret > w.scenarios.base.ret, `scenarios priced by code: ${JSON.stringify(Object.fromEntries(Object.entries(w.scenarios).map(([k, v]) => [k, v.ret.toFixed(2)])))}`);
ok(near(w.expected12, (25 * w.scenarios.bull.ret + 50 * w.scenarios.base.ret + 25 * w.scenarios.bear.ret) / 100), "expected 12M return");
ok(w.risks[0].size === "medium", "unknown size falls back");
const w2 = B.clean({ ...raw, calls: { "12M": { call: "strongly bullish" } }, scenarios: { bull: { probability: 10, rate_change_bp: 0, spread_change_bp: 0 }, bear: { probability: 90, rate_change_bp: 150, spread_change_bp: 400 } } }, dz, m);
ok(w2.checks.some((x) => /below cash/.test(x)), `a bullish call against losing scenarios is flagged: ${w2.checks.join("; ")}`);
ok(B.clean({}, dz, m) === null, "an empty answer is no answer");
if (fails) { console.log(`${fails} bondan test(s) failed`); process.exit(1); }
console.log("bondan tests passed", JSON.stringify({ carry: m.carry.toFixed(2), spread: Math.round(m.spread), breakeven: Math.round(m.breakeven), exp12: w.expected12.toFixed(2) }));
