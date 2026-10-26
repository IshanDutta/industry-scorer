// Hand-checked tests for fund.js and score.js. Usage: node web/fund_test.js
const assert = require("assert");
const F = require("./fund.js");
const S = require("./score.js");
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: got ${a}, want ${b}`);

// Quarter-end dates, newest first.
const QD = ["2026-06-30", "2026-03-31", "2025-12-31", "2025-09-30", "2025-06-30", "2025-03-31", "2024-12-31", "2024-09-30"];
function company({ rev, gp, oi, ni, niPrev, revPrev, int, fcf, da, div, equity, debt, cash, ca, cl, mcaps, earn }) {
  return F.compactCompany({
    income: QD.map((date, i) => ({ date, revenue: i < 4 ? rev / 4 : revPrev / 4, grossProfit: gp / 4, operatingIncome: oi / 4,
      netIncome: i < 4 ? ni / 4 : niPrev / 4, incomeBeforeTax: oi / 4, incomeTaxExpense: oi / 16, interestExpense: int / 4 })),
    balance: [{ date: QD[0], totalStockholdersEquity: equity, totalDebt: debt, cashAndShortTermInvestments: cash, totalCurrentAssets: ca, totalCurrentLiabilities: cl }],
    cashflow: QD.slice(0, 4).map((date) => ({ date, freeCashFlow: fcf / 4, depreciationAndAmortization: da / 4, commonDividendsPaid: -div / 4 })),
    keyMetrics: QD.slice(0, 5).map((date, i) => ({ date, marketCap: mcaps[i] })),
    earnings: earn,
  });
}
const today = "2026-10-07";
const A = company({ rev: 400, revPrev: 320, gp: 200, oi: 100, ni: 80, niPrev: 60, int: 10, fcf: 60, da: 20, div: 20,
  equity: 400, debt: 200, cash: 50, ca: 300, cl: 100, mcaps: [1600, 1500, 1400, 1300, 1200],
  earn: [{ date: "2026-10-20", epsActual: null, epsEstimated: 1.1 }, { date: "2026-07-20", epsActual: 1.1, epsEstimated: 1.0, revenueActual: 102, revenueEstimated: 100 },
    { date: "2026-04-20", epsActual: 0.9, epsEstimated: 1.0, revenueActual: 99, revenueEstimated: 100 }] });
const B = company({ rev: 100, revPrev: 100, gp: 30, oi: 10, ni: 20, niPrev: 20, int: 5, fcf: 0, da: 10, div: 0,
  equity: 100, debt: 100, cash: 0, ca: 50, cl: 50, mcaps: [400, 400, 400, 400, 400],
  earn: [{ date: "2026-10-09", epsActual: null, epsEstimated: 0.5 }, { date: "2026-07-10", epsActual: 0.6, epsEstimated: 0.5 }] });

const f = F.aggregateIndustry([
  { symbol: "AAA", name: "A Co", market_cap: 2000, c: A },
  { symbol: "BBB", name: "B Co", market_cap: 500, c: B },
], { industry: "Semiconductors", today });

close(f.rev_growth, (500 - 420) / 420, "revenue growth sum/sum");
close(f.ni_growth, (100 - 80) / 80, "earnings growth");
close(f.gross_margin, 230 / 500, "gross margin");
close(f.op_margin, 110 / 500, "op margin");
close(f.net_margin, 100 / 500, "net margin");
close(f.roe, 100 / 500, "ROE");
close(f.pe, 2500 / 100, "P/E = total cap / total TTM NI");
close(f.ps, 2500 / 500, "P/S");
close(f.pb, 2500 / 500, "P/B");
close(f.ev_ebitda, (2000 + 200 - 50 + 500 + 100 - 0) / ((100 + 20) + (10 + 10)), "EV/EBITDA");
close(f.div_yield, 20 / 2500, "dividend yield");
close(f.de, 300 / 500, "D/E");
close(f.current_ratio, 350 / 150, "current ratio");
close(f.int_cover, 110 / 15, "interest cover");
close(f.fcf_margin, 60 / 500, "FCF margin");
close(f.beat_rate, 2 / 3, "beat rate: A 1/2, B 1/1");
close(f.eps_surprise_median, 0.1, "median EPS surprise of [0.1, -0.1, 0.2]");
close(f.rev_surprise_median, 0.005, "median revenue surprise of [0.02, -0.01]");
assert.deepStrictEqual(f.next_reports.map((r) => r.symbol), ["BBB", "AAA"], "next reports sorted by date");
// P/E history: at 2026-06-30 TTM NI = 80 + 20 = 100, cap = 1600 + 400 = 2000 -> 20
const q2 = f.pe_hist.find((h) => h.q === "2026-Q2");
close(q2.pe, 20, "P/E at 2026-Q2");
assert.ok(f.pe_hist.length >= 2, "has P/E history");
close(f.pe_vs_hist, f.pe / f.pe_hist_median - 1, "P/E vs history");

// Financial industries skip industrial ratios
const fb = F.aggregateIndustry([{ symbol: "AAA", name: "A", market_cap: 2000, c: A }], { industry: "Banks - Regional", today });
assert.ok(Number.isNaN(fb.gross_margin) && Number.isNaN(fb.ev_ebitda) && Number.isNaN(fb.de), "bank ratios skipped");
assert.ok(Number.isFinite(fb.roe) && Number.isFinite(fb.pe), "bank ROE and P/E kept");

// Negative aggregate earnings -> no P/E, and valuation P/E scores 0
const L = company({ rev: 100, revPrev: 100, gp: 10, oi: -50, ni: -60, niPrev: -40, int: 1, fcf: -10, da: 1, div: 0,
  equity: 100, debt: 10, cash: 5, ca: 10, cl: 5, mcaps: [100, 100, 100, 100, 100], earn: [] });
const fl = F.aggregateIndustry([{ symbol: "LLL", name: "L", market_cap: 100, c: L }], { industry: "Biotechnology", today });
assert.ok(fl.pe_negative && Number.isNaN(fl.pe), "loss-making industry has no P/E");

// ---------------- scoring
close(S.anchored(0.3, 0.1, 0.7, true), 100 / 3, "anchored midpoint");
close(S.anchored(5, 8, 45, false), 100, "cheap P/E clamps to 100");
close(S.anchored(Infinity, 8, 45, false), 0, "negative-earnings P/E scores 0");
for (const [k, p] of Object.entries(S.PROFILES)) close(Object.values(p.weights).reduce((a, b) => a + b, 0), 100, `${k} weights sum to 100`);

const doc = (name, ex, dy, beta) => ({ name, summary: { excess_cw_1M: ex, excess_cw_3M: ex, excess_cw_6M: ex, excess_cw_1Y: ex, breadth_6M: 0.5,
  beta, vol_1y: 0.2, downside_vol_1y: 0.15, max_dd_1y: -0.2, sharpe_1y: 1 }, fund: { ...f, div_yield: dy } });
const res = S.scoreIndustries([doc("Hot", 0.3, 0, 1.6), doc("Steady", -0.1, 0.04, 0.6)],
  { Hot: { overlay: { growth: 50, income: -3 }, as_of: today } }, today);
assert.ok(res.Hot.profiles.aggressive.total > res.Steady.profiles.aggressive.total, "momentum industry wins Aggressive");
assert.ok(res.Steady.profiles.income.total > res.Hot.profiles.income.total, "dividend payer wins Income");
close(res.Hot.profiles.growth.overlay, S.OVERLAY_CAP, "agent overlay capped at +10");
close(res.Hot.profiles.income.overlay, -3, "overlay passes through within cap");
const stale = S.scoreIndustries([doc("Hot", 0.3, 0, 1.6)], { Hot: { overlay: { growth: 5 }, as_of: "2026-08-01" } }, today);
close(stale.Hot.profiles.growth.overlay, 0, "stale agent view ignored");
for (const p of Object.values(res.Hot.profiles)) assert.ok(p.total >= 0 && p.total <= 100, "score within 0-100");
console.log("fund + score tests passed");
// Cached round-trip: NaN stored as null must not turn into zeros.
const roundTrip = JSON.parse(JSON.stringify(A, (k, v) => (typeof v === "number" && !Number.isFinite(v) ? null : v)));
const f2 = F.aggregateIndustry([{ symbol: "AAA", name: "A Co", market_cap: 2000, c: roundTrip }, { symbol: "BBB", name: "B Co", market_cap: 500, c: B }], { industry: "Semiconductors", today });
close(f2.pe, f.pe, "P/E survives JSON round trip");
close(f2.beat_rate, f.beat_rate, "beat rate survives JSON round trip");
console.log("round-trip test passed");
// Absolute mode: an industry's score must not depend on which others are scored with it.
{
  const base = [doc("Hot", 0.3, 0, 1.6)];
  const crowd = [doc("Hot", 0.3, 0, 1.6), ...Array.from({ length: 9 }, (_, i) => doc("X" + i, 0.5 + i * 0.01, 0.05, 0.5))];
  const a = S.scoreIndustries(base, {}, today, { relative: false }).Hot.profiles.growth.total;
  const b = S.scoreIndustries(crowd, {}, today, { relative: false }).Hot.profiles.growth.total;
  close(a, b, "absolute score independent of other industries");
  const c = S.scoreIndustries(crowd, {}, today).Hot.profiles.growth.total;
  assert.ok(Math.abs(c - a) > 1e-6, "relative mode does change with peers");
  console.log("absolute-mode test passed");
}
// Currency: a TWD filer converted to USD must aggregate like the same company reported in USD.
{
  const rate = 32;
  const twd = F.compactCompany({
    income: QD.map((date, i) => ({ date, reportedCurrency: "TWD", revenue: 400 * rate / 4, grossProfit: 200 * rate / 4, operatingIncome: 100 * rate / 4,
      netIncome: (i < 4 ? 80 : 60) * rate / 4, incomeBeforeTax: 100 * rate / 4, incomeTaxExpense: 100 * rate / 16, interestExpense: 10 * rate / 4 })),
    balance: [{ date: QD[0], reportedCurrency: "TWD", totalStockholdersEquity: 400 * rate, totalDebt: 200 * rate, cashAndShortTermInvestments: 50 * rate, totalCurrentAssets: 300 * rate, totalCurrentLiabilities: 100 * rate }],
    cashflow: QD.slice(0, 4).map((date) => ({ date, reportedCurrency: "TWD", freeCashFlow: 60 * rate / 4, depreciationAndAmortization: 20 * rate / 4, commonDividendsPaid: -20 * rate / 4 })),
    keyMetrics: QD.slice(0, 5).map((date, i) => ({ date, reportedCurrency: "TWD", marketCap: [1600, 1500, 1400, 1300, 1200][i] * rate })),
    earnings: [],
  });
  assert.deepStrictEqual(F.currenciesOf(twd), ["TWD"]);
  assert.strictEqual(F.toUSD(twd, {}), null, "missing rate -> excluded, never mixed");
  const usd = F.toUSD(twd, { TWD: rate });
  const g = F.aggregateIndustry([{ symbol: "TSM", name: "T", market_cap: 2000, c: usd }], { industry: "Semiconductors", today });
  const h = F.aggregateIndustry([{ symbol: "AAA", name: "A", market_cap: 2000, c: A }], { industry: "Semiconductors", today });
  for (const k of ["pe", "ps", "pb", "gross_margin", "op_margin", "roe", "de", "div_yield", "fcf_margin", "ev_ebitda", "pe_hist_median"]) close(g[k], h[k], "converted " + k);
  console.log("currency conversion test passed");
}
