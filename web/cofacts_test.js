const C = require("./cofacts.js");
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log("FAIL", m); } else console.log("ok  ", m); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// Synthetic: 5 years of business days; SPY random walk; stock = 1.5 × SPY + noise + small drift
let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const dates = []; for (let t = Date.parse("2021-10-01"); dates.length < 1270; t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) dates.push(d.toISOString().slice(0, 10)); }
const spy = { dates, closes: [100] }, stk = { dates, closes: [50] }, etf = { dates, closes: [80] };
for (let i = 1; i < dates.length; i++) { const m = 0.0004 + 0.01 * gauss(); spy.closes.push(spy.closes[i - 1] * (1 + m)); stk.closes.push(stk.closes[i - 1] * (1 + 0.0002 + 1.5 * m + 0.008 * gauss())); etf.closes.push(etf.closes[i - 1] * (1 + 1.1 * m + 0.003 * gauss())); }

const g1 = C.riskGreeks(stk, { spy, etf, months: 12 }), g3 = C.riskGreeks(stk, { spy, etf, months: 36 });
ok(g1 && near(g1.beta, 1.5, 0.15), `beta 1Y ≈ 1.5 (${g1?.beta?.toFixed(2)})`);
ok(g3 && near(g3.beta, 1.5, 0.08), `beta 3Y ≈ 1.5 (${g3?.beta?.toFixed(2)})`);
ok(g3.r2 > 0.6 && g3.r2 < 0.95, `R² sensible (${g3.r2.toFixed(2)})`);
ok(near(g3.vol, Math.sqrt(1.5 ** 2 * 0.01 ** 2 + 0.008 ** 2) * Math.sqrt(252), 0.03), `vol ≈ theory (${g3.vol.toFixed(3)})`);
ok(g3.var95 > 0 && g3.cvar95 > g3.var95, "CVaR beyond VaR");
ok(g3.max_dd < 0, "max drawdown negative");
ok(g3.up_capture > 1.2 && g3.down_capture > 1.2, `captures ≈ beta (${g3.up_capture.toFixed(2)}, ${g3.down_capture.toFixed(2)})`);
ok(Number.isFinite(g3.etf_beta) && g3.etf_beta > 1, `ETF beta (${g3.etf_beta.toFixed(2)})`);
ok(C.riskGreeks({ dates: dates.slice(-100), closes: stk.closes.slice(-100) }, { spy, months: 36 }) === null, "no 3Y Greeks from 100 days");

const rb = C.rollingBeta(stk, spy);
ok(rb.dates.length > 100 && rb.beta.every(Number.isFinite), `rolling beta points (${rb.dates.length})`);

const p = C.performance(stk, { spy, etf });
const last = dates.length - 1;
ok(near(p["1D"].ret, stk.closes[last] / stk.closes[last - 1] - 1, 1e-12), "1D return");
ok(p["5Y"] === undefined || Number.isFinite(p["5Y"].ret), "5Y window handled");
ok(Number.isFinite(p["3Y"].ann) && Number.isFinite(p["1Y"].vs_spy) && Number.isFinite(p.YTD.ret), "3Y annualized, vs SPY, YTD");

// Black-Scholes: put-call parity and known value (S=K=100, T=1, r=5%, q=0, σ=20% → call 10.45)
const c = C.bsm(100, 100, 1, 0.05, 0, 0.2, "call"), pu = C.bsm(100, 100, 1, 0.05, 0, 0.2, "put");
ok(near(c.price, 10.4506, 0.01), `BS call 10.45 (${c.price.toFixed(4)})`);
ok(near(c.price - pu.price, 100 - 100 * Math.exp(-0.05), 1e-6), "put-call parity");
ok(near(c.delta, 0.6368, 0.002) && near(pu.delta, c.delta - 1, 1e-9), `deltas (${c.delta.toFixed(4)})`);
ok(c.gamma > 0 && c.vega > 0 && c.theta < 0 && c.rho > 0 && pu.rho < 0, "signs of gamma, vega, theta, rho");
const og = C.optionGreeks(100, 0.25, 0.04, 0.02);
ok(og.length === 4 && og[3].move > og[0].move, "option table, wider move further out");

// Scores
const cons = Array.from({ length: 30 }, (_, i) => ({ symbol: "P" + i, ret_3M: i / 100, ret_6M: i / 80, ret_1Y: i / 50, pe: 10 + i, fwd_pe: 9 + i, ps: 1 + i / 10, rev_growth: i / 200, op_margin: i / 100, vol_1y: 0.2 + i / 200 }));
const row = { symbol: "X", ret_3M: 0.25, ret_6M: 0.3, ret_1Y: 0.5, pe: 12, fwd_pe: 11, ps: 1.2, rev_growth: 0.12, op_margin: 0.25, vol_1y: 0.21 };
const PROFILES = { growth: { weights: { momentum: 50, valuation: 20, cycle: 30 } } };
const s = C.scores({ row, cons, sections: { cycle: { score: 40 } }, profiles: PROFILES, sectionKeys: ["cycle"] });
ok(s.pillars.momentum.score > 70 && s.pillars.valuation.score > 70, "strong momentum and cheap → high pillars");
ok(Number.isFinite(s.profiles.growth.total) && s.profiles.growth.sections === 40, "profile total with industry section pillar");

// Statements history
const q = Array.from({ length: 12 }, (_, i) => ({ date: `20${24 + Math.floor((11 - i) / 4)}-${String(3 * (4 - (i % 4))).padStart(2, "0")}-30`, rev: 100 + (11 - i) * 5, gp: 50, oi: 20, ni: 10, sh: 10 }));
const km = q.map((r) => ({ date: r.date, mcap: 1000 }));
const fh = C.fundHistory({ q, cf: [] });
ok(fh.length === 12 && Number.isFinite(fh[11].rev_ttm) && !Number.isFinite(fh[0].rev_ttm), "TTM from the 4th quarter on");
const pe = C.peHistory({ q, km }, 30);
ok(pe.pts.length === 9 && near(pe.median, 25, 1e-9) && near(pe.vs_median, 0.2, 1e-9), "P/E history: 1000 ÷ 40 = 25; now 30 = +20%");
const eh = C.earningsHistory({ earn: [{ date: "2026-12-01", ee: 1 }, { date: "2026-07-01", ea: 1.1, ee: 1 }, { date: "2026-04-01", ea: 0.9, ee: 1 }] }, "2026-10-29");
ok(eh.next?.date === "2026-12-01" && eh.beat_rate === 0.5 && near(eh.past[0].eps_surprise, 0.1, 1e-9), "earnings: next, beat rate, surprise");
const lv = C.levels(stk);
ok(lv && lv.in_range >= 0 && lv.in_range <= 1 && Number.isFinite(lv.ma200), "levels");


// Stress tests, technicals, patterns, dividends, DCF, DuPont, bands, reactions
const ep = C.episodes(stk, spy, 1.5);
ok(ep.length === 6 && ep.find((e) => e.key === "infl").ret !== null && !ep.find((e) => e.key === "infl").estimated, "2022 episode measured from real history");
const epS = C.episodes({ dates: dates.slice(-200), closes: stk.closes.slice(-200) }, spy, 1.5), e22 = epS.find((e) => e.key === "infl");
ok(e22.estimated && near(e22.ret, 1.5 * e22.spy, 1e-9), "before the stock traded: beta × SPY, marked estimated");
ok(ep.find((e) => e.key === "gfc").ret === null, "no SPY data either: left blank");
ok(near(C.monthlyBeta(stk, spy), 1.5, 0.35), `monthly beta ≈ 1.5 (${C.monthlyBeta(stk, spy).toFixed(2)})`);
const tD = C.technicals(stk, "D"), tW = C.technicals(stk, "W"), tM = C.technicals(stk, "M");
ok(tD && tD.close.length === 260 && Number.isFinite(tD.last.sma200) && tD.last.rsi > 0 && tD.last.rsi < 100, "daily technicals");
ok(tW && tW.close.length <= 156 && tM && tM.close.length <= 120 && tD.signals.length >= 4, "weekly and monthly bars, signals");
const pm = C.patternMatch([{ name: "X", ser: stk }, { name: "SPY", ser: spy }]);
ok(pm && pm.n === 25 && pm.win_rate >= 0 && pm.win_rate <= 1 && pm.matches.length === 10 && pm.matches[0].dist <= pm.matches[9].dist, "pattern matches sorted, win rate");
const dv = C.dividends([{ date: "2026-12-01", dividend: 0.53, frequency: "Quarterly" }, ...[2026, 2025, 2024, 2023, 2022, 2021, 2020].flatMap((y, k) => [3, 6, 9, 12].map((m) => ({ date: `${y}-${String(m).padStart(2, "0")}-15`, dividend: 0.53 - k * 0.02, frequency: "Quarterly" })))], { px: 70, payout: 0.7, fcf_payout: 0.8, today: "2026-10-30" });
ok(dv.paying && dv.streak === 5 && dv.cagr5 > 0 && dv.safety > 0 && dv.next?.ex === "2026-12-01", `dividends: streak ${dv.streak}, safety ${dv.safety}`);
const v1 = C.dcf({ rev: 100, margin: 0.2, g: 0, tg: 0, wacc: 0.1, shares: 10, netDebt: 0 });
ok(near(v1.per_share, 20, 1e-6), `DCF with no growth = FCF / WACC per share (${v1.per_share.toFixed(2)})`);
const dp = C.dupont([{ date: "2025-12-31", revenue: 100, netIncome: 10 }], [{ date: "2025-12-31", totalAssets: 200, totalStockholdersEquity: 50 }]);
ok(dp.length === 1 && near(dp[0].roe, 0.2, 1e-9), "DuPont ROE = 10% × 0.5 × 4");
const vb = C.valuationBand([20, 22, 24, 26, 28, 30, 25, 23].map((pe) => ({ pe })), 29);
ok(vb && vb.verdict === "rich" && vb.hi > vb.mean, "valuation band: rich above the 80th percentile");
const er = C.earningsReactions([{ date: dates[dates.length - 20] }], stk, spy);
ok(Number.isFinite(er[0].move) && Number.isFinite(er[0].vs_spy), "earnings reaction");
console.log(fails ? `${fails} FAILED` : "all passed"); process.exit(fails ? 1 : 0);
