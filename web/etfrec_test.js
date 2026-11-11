const assert = require("assert");
const R = require("./etfrec.js");
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;

// universe and goals
assert(R.UNIVERSE.length > 140 && R.UNIVERSE.length < 200 && new Set(R.UNIVERSE.map((e) => e.symbol)).size === R.UNIVERSE.length && R.BY.get("IGV").industries.length === 2 && R.BY.get("FDN").industries[0] === "Internet Content & Information" && R.BY.get("SMH").industries[0] === "Semiconductors" && R.BY.get("TLT").duration === 16 && R.BY.get("VXUS").intl);
const g = R.goalOf({ type: "income", horizon: "12M" }); assert(g.cap === 15 && g.minN >= 7 && g.bonds[0] === 0.3);
assert.strictEqual(R.goalOf({ type: "x" }).type, "growth");

// screening: leverage, size, age, cost, international, user exclusions
const info = { name: "Fund", assetsUnderManagement: 5e9, avgVolume: 1e6, inceptionDate: "2010-01-01", expenseRatio: 0.09 };
assert(R.screen(R.BY.get("VOO"), info, g, { today: "2026-11-11" }).ok);
assert(!R.screen(R.BY.get("VOO"), { ...info, name: "ProShares Ultra 2x" }, g).ok);
assert(!R.screen(R.BY.get("VOO"), { ...info, assetsUnderManagement: 1e8 }, g).ok);
assert(/three years/.test(R.screen(R.BY.get("VOO"), { ...info, inceptionDate: "2025-01-01" }, g, { today: "2026-11-11" }).why));
assert(!R.screen(R.BY.get("VXUS"), info, g).ok && R.screen(R.BY.get("VXUS"), info, R.goalOf({ intl: true })).ok);
assert(!R.screen(R.BY.get("XLE"), info, R.goalOf({ exclude: ["energy"] })).ok);

// curve and bond view
const curve = { month1: 4.05, month3: 4.3, month6: 4.38, year1: 4.56, year2: 4.73, year3: 4.74, year5: 4.81, year7: 4.89, year10: 4.98, year20: 5.39, year30: 5.35 };
assert(near(R.curveAt(curve, 10), 0.0498) && near(R.curveAt(curve, 6), (4.81 + 4.89) / 200));
const bt = R.bondView(R.BY.get("TLT"), { curve }), hy = R.bondView(R.BY.get("HYG"), { curve, ttmYield: 0.065 });
assert(near(bt.rates_up_1pp, -0.16) && bt.credit_stress === 0 && bt.expected > 0.05 && hy.expected < hy.yield && hy.credit_stress < 0);

// equity view from a look-through
const look = { on: 0.8, full_on: 0.8, exp12: { v: 12 }, calls: { "12M": { expected: 12, score: 1, lean: "slightly bullish" } }, scores: { growth: { v: 70 } }, val: { pe: { v: 25 } }, risk: {}, contrib: [{ industry: "Semiconductors", weight: 0.5, expected: 18, call12: "bullish" }] };
const ev = R.equityView(look, { industries: [{ industry: "Semiconductors", weight: 0.5 }], sectors: { Technology: 0.9 } }, R.goalOf({ type: "growth" }));
assert(near(ev.expected, 0.12) && ev.conf > 0.5 && ev.conf <= 0.85 && ev.score === 70);
assert.strictEqual(R.equityView(null, null, g).conf, 0);

// matrices: inverse, projection, covariance shrinkage, Black-Litterman
const I = R.inv([[4, 1], [2, 3]]); assert(near(I[0][0], 0.3) && near(I[1][1], 0.4));
const p = R.project([0.9, 0.5, -0.2], [0, 0, 0], [0.5, 0.5, 0.5]); assert(near(p.reduce((a, x) => a + x, 0), 1, 1e-9) && p.every((x) => x >= -1e-12 && x <= 0.5 + 1e-12));
let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
const T = 600, f = Array.from({ length: T }, rnd), Rr = [0, 1, 2, 3].map((k) => f.map((x) => 0.01 * x * (k < 3 ? 1 : 0.2) + 0.004 * rnd()));
const C = R.covariance(Rr); assert(C.shrink >= 0 && C.shrink <= 1 && C.cov[0][1] > 0 && C.cov[0][0] > C.cov[3][3]);
const pri = [0.08, 0.08, 0.08, 0.05], post = R.blackLitterman(pri, [0.2, NaN, NaN, NaN], [0.5, 0, 0, 0], C.cov);
assert(post[0] > 0.08 && post[0] < 0.2 && post[1] > 0.08 && Math.abs(post[3] - 0.05) < Math.abs(post[1] - 0.08), "a view moves its asset and, through correlation, its neighbours");
assert.deepStrictEqual(R.blackLitterman(pri, [NaN, NaN, NaN, NaN], [0, 0, 0, 0], C.cov), pri);

// optimizer: caps, sum, a linear row
const mu = [0.12, 0.1, 0.08, 0.05, 0.04, 0.09, 0.07, 0.06], k = mu.length, cov = mu.map((_, i) => mu.map((__, j) => (i === j ? 0.04 : 0.01)));
const w = R.solve(mu, cov, { lam: 2, hi: new Array(k).fill(0.15), rows: [{ a: [1, 1, 0, 0, 0, 0, 0, 0], b: 0.2 }] });
assert(near(w.reduce((a, x) => a + x, 0), 1, 1e-6) && w.every((x) => x <= 0.15 + 1e-6) && w[0] + w[1] <= 0.2 + 2e-3, JSON.stringify(w));

// the whole recommendation on synthetic prices
const dates = []; for (let t = Date.UTC(2019, 11, 2); dates.length < 1700; t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) dates.push(d.toISOString().slice(0, 10)); }
const mk = (drift, beta, idio, s) => { let v = 100, m = 0; seed = s; const mkt = []; const out = dates.map((_, i) => { const r = drift / 252 + beta * MK[i] + idio * rnd(); v *= 1 + r; return v; }); return { dates, closes: out }; };
seed = 99; const MK = dates.map(() => 0.012 * rnd() + 0.0003);
const syms = { SPY: [0.0, 1, 0.001, 1], VOO: [0.0, 1, 0.0015, 2], QQQ: [0.03, 1.2, 0.006, 3], SMH: [0.06, 1.6, 0.015, 4], XLV: [0.0, 0.7, 0.008, 5], XLU: [0.01, 0.5, 0.009, 6], SCHD: [0.0, 0.8, 0.006, 7], VUG: [0.02, 1.1, 0.005, 8],
  IGV: [0.03, 1.3, 0.012, 9], ITA: [0.04, 0.9, 0.01, 10], TLT: [0.0, -0.2, 0.009, 11], IEF: [0.0, -0.1, 0.004, 12], SGOV: [0.04, 0, 0.0001, 13], LQD: [0.0, 0.1, 0.005, 14], HYG: [0.01, 0.35, 0.003, 15], GLD: [0.03, 0.1, 0.009, 16], XLE: [0.02, 0.9, 0.014, 17] };
const series = Object.fromEntries(Object.entries(syms).map(([s, a]) => [s, mk(...a)]));
const goal = R.goalOf({ type: "growth" });
const cands = Object.keys(syms).filter((s) => s !== "SPY").map((s) => { const e = R.BY.get(s), q = R.quantFacts(series[s], series.SPY), bond = R.isBond(e);
  const v = bond ? R.bondView(e, { curve, ttmYield: 0.045 }) : R.equityView({ ...look, exp12: { v: s === "SMH" ? 22 : s === "XLE" ? -6 : 9 } }, { industries: [{ industry: e.industries?.[0] || e.sector || "Mixed " + s, weight: 0.6 }], sectors: { [e.sector || "Technology"]: s === "SMH" || s === "IGV" || s === "QQQ" ? 0.9 : 0.3 } }, goal);
  const c = { symbol: s, e, info: { name: s, expenseRatio: 0.1, assetsUnderManagement: 1e10 }, q, v, yld: bond ? 0.045 : 0.012, sectors: bond ? {} : { [e.sector || "Technology"]: s === "SMH" || s === "IGV" || s === "QQQ" ? 0.9 : 0.3 }, stocks: s === "SMH" ? { NVDA: 0.2 } : s === "QQQ" ? { NVDA: 0.09 } : {} };
  c.pill = R.pillars(c, goal); return c; });
const rec = R.recommend(cands, series, goal);
for (const [key, P] of Object.entries(rec.portfolios)) {
  assert(P, key); const s = P.w.reduce((a, x) => a + x, 0);
  assert(near(s, 1, 1e-6), key + " sums to 100%"); assert(P.w.every((x) => x <= 0.15 + 1e-9), key + " every ETF at most 15%");
  assert(P.w.filter((x) => x > 0).every((x) => x >= 0.03 - 1e-9), key + " no position under 3%"); assert(P.n >= 7, key + " at least 7 ETFs");
}
const P = rec.portfolios.recommended; assert(P.vol <= goal.vol + 0.01, "volatility under the ceiling: " + P.vol);
assert(P.bonds <= 0.2 + 0.01, "bonds within the band");
assert(!rec.assets.some((a) => a.symbol === "VOO") || !rec.assets.some((a) => a.symbol === "SPY"), "near-duplicates collapse");
const twin = R.recommend([...cands, { ...cands.find((c) => c.symbol === "SMH"), symbol: "SOXX", e: R.BY.get("SOXX") }], { ...series, SOXX: mk(0.05, 1.5, 0.02, 44) }, goal);
assert(!(twin.assets.some((a) => a.symbol === "SMH") && twin.assets.some((a) => a.symbol === "SOXX")), "two funds on the same industry collapse into one");
const iSMH = rec.assets.findIndex((a) => a.symbol === "SMH"), iXLE = rec.assets.findIndex((a) => a.symbol === "XLE");
assert(iSMH < 0 || iXLE < 0 || rec.mu[iSMH] > rec.mu[iXLE], "the industry views move expected returns");
const semis = rec.assets.reduce((s, a, i) => s + P.w[i] * ((a.v?.industries || []).find((g) => g.industry === "Semiconductors")?.weight || 0), 0); assert(semis <= 0.25 + 0.005, "no industry above its cap: " + semis);
const nv = rec.assets.reduce((s, a, i) => s + P.w[i] * (a.stocks?.NVDA || 0), 0); assert(nv <= 0.08 + 0.005, "look-through cap on one stock: " + nv);
// income: bonds within its band, yield counts
const gi = R.goalOf({ type: "income" }), ri = R.recommend(cands.map((c) => ({ ...c, pill: R.pillars(c, gi) })), series, gi), Pi = ri.portfolios.recommended;
assert(Pi.bonds >= 0.3 - 0.01 && Pi.bonds <= 0.65 + 0.01, "income bonds band: " + Pi.bonds);

// improver: a stock and a fund outside the universe are mapped; fewer trades with a turnover penalty
const hold = [{ ticker: "NVDA", weight: 40, asset_type: "stock", industry: "Semiconductors", sector: "Technology" }, { ticker: "FCNTX", weight: 40, asset_type: "fund", sector: "Technology", sectors: { Technology: 0.6 } }, { ticker: rec.assets[0].symbol, weight: 20, asset_type: "etf" }];
const im = R.improve(rec, hold, goal);
assert(im.map.length === 3 && im.map[0].to && near(im.before.w.reduce((a, x) => a + x, 0), 1, 1e-9) && im.after && near(im.after.w.reduce((a, x) => a + x, 0), 1, 1e-6));
assert(im.after.w.every((x) => x <= 0.15 + 1e-9) && im.turnover > 0 && im.turnover < 1);
const loose = R.improve(rec, hold, goal, { kappa: 0 }); assert(im.turnover <= loose.turnover + 1e-6, "the turnover penalty trades less");

// stress, exposure, the write-up
const st = R.stress(P.w, rec.assets, { ...series }); assert(st.episodes.length >= 3 && st.hypo.length === 3 && st.hypo[0].ret < 0);
const ex = R.exposure(P.w, rec.assets); assert(ex.sectors.length && Array.isArray(ex.stocks));
const ds = R.dossier(goal, rec, "recommended", { exposureRes: ex, stressRes: st, curve }), ids = R.idsOf(ds);
assert(ids.includes("G1") && ids.includes("P1") && ids.some((x) => /^E\d/.test(x)) && ids.includes("S1"));
assert(/at most 15%/.test(R.writePrompt(goal, ds)));
const cw = R.cleanWrite({ headline: "Chips [E1] and [Q9]", etfs: [{ symbol: "smh", why: "x [E1]" }], risks: ["r [S1]"] }, ids);
assert(cw.headline === "Chips [E1] and" && cw.etfs[0].symbol === "SMH");
console.log("etfrec tests passed", JSON.stringify({ n: P.n, vol: +P.vol.toFixed(3), exp: +P.expected.toFixed(3), bonds: +P.bonds.toFixed(2), incomeBonds: +Pi.bonds.toFixed(2), turnover: +im.turnover.toFixed(2), syms: rec.assets.filter((a, i) => P.w[i] > 0).map((a, i) => a.symbol).join(",") }));
