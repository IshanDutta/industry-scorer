const assert = require("assert");
const P = require("./portfolio.js"), M = require("./fundmore.js"), A = require("./fundan.js");
const FX = require("./fixtures/funds.json");
const m = P.mapHoldings(P.fromFmp(FX.fcntx_holdings), [], FX.cos), cov = P.coverage(m, FX.runs, { now: "2026-11-09" }), D = FX.digests;

// ---- phase 3: the scorecard
assert(Object.values(D).every((d) => d.v === 7 && d.pillars), "the fixture's digests are v7, with pillars");
const own = M.ownFrom({ retRows: [{ label: "1M", value: 2, spy: 1 }, { label: "1Y", value: 11, spy: 15 }], g1: { beta: 1.1, vol: 0.2, downside_vol: 0.14, max_dd: -0.18, sharpe: 0.6 }, bench: { symbol: "SPY" },
  hold: [0.08, 0.07, 0.06, 0.05, 0.04, 0.03].map((weight) => ({ weight })), facts: { yield: 0.003, expense: 0.0063 } });
assert(Math.abs(own.ex1m - 0.01) < 1e-9 && Math.abs(own.ex1y + 0.04) < 1e-9 && Math.abs(own.top5 - 0.3) < 1e-9 && own.yield === 0.003);
const sc0 = M.scorecard({ cov, digests: D, own });
assert(sc0.pillars.momentum.from === "fund" && sc0.pillars.risk.from === "fund" && sc0.pillars.growth.from === "industries" && sc0.pillars.cycle.from === "industries", "own numbers where it has them, its industries' elsewhere");
assert(sc0.pillars.momentum.ind && sc0.pillars.momentum.ind.score > 0, "the industries' momentum is kept alongside");
assert(sc0.pillars.income.items.some((i) => i.key === "exp" && i.score > 40 && i.score < 60), "the expense ratio is scored inside income");
for (const t of M.TYPES) { const x = sc0.profiles[t]; assert(x.base > 20 && x.base < 85 && x.overlay === 0 && x.total === x.base, `${t} ${x.base}`); assert(x.coverage > 0.9, `${t} coverage ${x.coverage}`); }
// The industries' pillars are their weighted averages.
const g0 = cov.industries.filter((g) => D[g.industry.toLowerCase()]?.pillars?.growth != null), wsum = g0.reduce((a, g) => a + g.weight, 0);
assert(Math.abs(sc0.pillars.growth.score - g0.reduce((a, g) => a + g.weight * D[g.industry.toLowerCase()].pillars.growth, 0) / wsum) < 1e-9);
// The analysis's fit moves the score by its points, and best fit skips a type it calls weak or poor.
const top = sc0.ranked[0], other = sc0.ranked[1];
const sc1 = M.scorecard({ cov, digests: D, own, fit: { [top]: { fit: "poor" }, [other]: { fit: "strong" } } });
assert.strictEqual(sc1.profiles[top].overlay, -5); assert.strictEqual(sc1.profiles[other].overlay, 5);
assert.strictEqual(sc1.best, other, "best fit never goes to a poor fit when another fits");
const sc2 = M.scorecard({ cov, digests: D, own, fit: Object.fromEntries(M.TYPES.map((t) => [t, { fit: "weak" }])) });
assert.strictEqual(sc2.best, sc2.ranked[0], "when every type is weak, the highest score still wins");
assert(sc0.profiles.growth.lifts.length + sc0.profiles.growth.holds.length > 0, "what lifts and holds back each score");
assert(M.scoreText(sc0).includes("Pillars from the fund's own numbers: Momentum vs SPY"));

// ---- phase 4: cycle, debates, scenarios, season, peers
const cy = M.cycleLook(cov, D);
assert(cy.on > 0.5 && Math.abs(Object.values(cy.phase).reduce((a, x) => a + x, 0) - 1) < 1e-9, "cycle positions add to 100% of the covered weight");
assert(cy.rows[0].weight >= cy.rows[cy.rows.length - 1].weight && cy.next.every((x, i) => i === 0 || x.date >= cy.next[i - 1].date));
const db = M.debates(cov, D);
assert(db.length === 6 && db[0].id === "DB1" && db[0].q && db[0].bull && db[0].bear);
assert(new Set(db.map((x) => x.industry)).size >= 3, "at most two debates per industry");
const sl = M.scenLook(cov, D);
assert(sl.rows.length > 5 && sl.fund.bull.move > sl.fund.bear.move && Number.isFinite(sl.ev));
const hold = A.holdings(m, D);
const earn = { NVDA: { last: { date: "2026-08-27", act: 1.05, est: 1.0 }, next: { date: "2026-11-19" } }, MSFT: { last: { date: "2026-10-29", act: 3.6, est: 3.7 }, next: { date: "2027-01-28" } }, AAPL: { last: { date: "2026-05-01", act: 1.6, est: 1.5 } } };
const se = M.season(hold, earn, "2026-11-09");
assert.strictEqual(se.n, 3); assert(se.recent.map((r) => r.ticker).join() === "MSFT,NVDA", "only the last 75 days count as this season, newest first");
const wN = hold.find((h) => h.ticker === "NVDA").weight, wM = hold.find((h) => h.ticker === "MSFT").weight;
assert(Math.abs(se.beat_share - wN / (wN + wM)) < 1e-9, "beat share by weight");
assert(Math.abs(se.next30 - wN) < 1e-9 && se.weeks[0].names.includes("NVDA"));
assert(M.seasonText(se).includes("NVDA 2026-08-27 +5.0%"));
assert.deepStrictEqual(M.peersFor({ symbol: "FCNTX", name: "Fidelity Contrafund", category: "Large Growth" }, { Technology: 0.4 }, "SPY"), ["SPY", "VUG", "IWF", "SCHG", "SPYG"]);
assert.deepStrictEqual(M.peersFor({ symbol: "XLK", name: "Technology Select Sector SPDR" }, { Technology: 0.98 }, "QQQ").slice(0, 3), ["QQQ", "VGT", "IYW"], "a sector fund's peers are other funds on that sector");
const mk = (k, drift) => { const dates = [], closes = []; let p = 100; for (let i = 0; i < 1300; i++) { const t = new Date(Date.UTC(2021, 10, 1) + i * 864e5 * 1.4); dates.push(t.toISOString().slice(0, 10)); p *= 1 + drift + 0.01 * Math.sin(i / k); closes.push(p); } return { dates, closes }; };
const spy = mk(3, 0.0004), ps = M.peerStats(mk(5, 0.0006), spy);
assert(ps.r1y > 0 && ps.r3y > 0 && ps.vol > 0 && ps.max_dd <= 0 && Number.isFinite(ps.beta));
const pt = M.peerTable([{ sym: "A", self: true, r1y: 0.1, expense: 0.006 }, { sym: "B", r1y: 0.2, expense: 0.0004 }, { sym: "C", r1y: 0.05, expense: 0.001 }]);
assert.deepStrictEqual(pt.map((r) => [r.rank.r1y, r.rank.expense]), [[2, 3], [1, 1], [3, 2]]);
assert(M.peerText("A", pt).includes("A ranks 2 of 3 on 1-year return"));

// ---- times like this, from the industries' runs
{
  const TL = M.timesLook(cov, D, null);
  assert(TL && TL.n > 10 && TL.on > 0.5 && TL.episodes.length === 5, "five episodes from its industries' runs");
  const mi = (m) => +m.slice(0, 4) * 12 + +m.slice(5, 7);
  for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) assert(Math.abs(mi(TL.episodes[i].month) - mi(TL.episodes[j].month)) >= 6, "episodes at least 6 months apart");
  assert(TL.episodes[0].vote >= TL.episodes[4].vote && TL.episodes[0].industries.length > 1 && TL.episodes[0].note?.then, "the most-picked month first, with a historian's note");
  const w12 = TL.base["12M"]; assert(w12.pos > 0 && w12.pos < 100 && w12.all_pos > 0, JSON.stringify(w12));
  assert(Object.keys(TL.now).every((k) => !/^i|^pe$|^v200|^rel6/.test(k)) && "vix" in TL.now, "today's macro backdrop only");
  // With the fund's own prices, each episode also says what the fund did next.
  const dates = [], closes = []; let v = 100; for (let t = Date.UTC(2009, 0, 2); t < Date.UTC(2026, 10, 7); t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6 === 0) continue; v *= 1.0003; dates.push(d.toISOString().slice(0, 10)); closes.push(v); }
  const TF = M.timesLook(cov, D, { dates, closes }), e0 = TF.episodes.find((e) => e.month < "2025-06");
  assert(e0.fund && e0.fund["3M"] > 1 && e0.fund_path.length > 5, "the fund's own path after the month");
  assert(M.timesLookText(TF, "FCNTX").includes("FCNTX itself"));
}
// ---- macro, world, trade and regulation: the industry reports' tables, merged and weighted
{
  const X = M.affairs(cov, D, hold);
  assert(X && X.n >= 5 && X.indicators.length > 10 && X.world.length > 5 && X.trade.length > 5 && X.rules.length > 5, "every table has rows");
  assert(X.indicators[0].id === "MI1" && X.indicators[0].read_by >= X.indicators[X.indicators.length - 1].read_by, "indicators by how much of the fund reads them");
  assert(X.indicators.every((x) => x.reads.every((r) => r.industry && r.effect)), "each industry's read of each indicator");
  const tw = X.trade[0]; assert(tw.rev >= X.trade[1].rev && tw.industries.length >= 1 && tw.exposed_held.every((h) => h.weight > 0), "countries by revenue at stake, holdings named");
  assert(X.rules.every((r, i) => i === 0 || ({ critical: 0, high: 1, medium: 2, low: 3 }[r.severity] ?? 4) >= ({ critical: 0, high: 1, medium: 2, low: 3 }[X.rules[i - 1].severity] ?? 4)), "rules most severe first");
  assert(Object.keys(X.regime_mix).length && X.regimes.every((r) => r.industry), "each industry's macro regime");
  const T = M.affairsText(X); assert(T.macro.includes("[MI1]") && T.world.includes("[WS1]") && T.trade.includes("[TC1]") && T.reg.includes("[RL1]"));
}
// ---- phase 5: the daily check
const ol = { date: "2026-11-01", mark: { px: 100 }, calls: {} }, ser = { dates: ["2026-11-09"], closes: [106] };
let ck = M.dailyCheck({ outlook: ol, ser, sigma1m: 5, today: "2026-11-09" });
assert.strictEqual(ck.redo, "calls"); assert(/moved \+6\.0% since the calls/.test(ck.why[0]));
ck = M.dailyCheck({ outlook: ol, ser: { dates: ["2026-11-09"], closes: [101] }, sigma1m: 5, today: "2026-11-09" });
assert.strictEqual(ck.redo, "calls"); assert(/8 days old/.test(ck.why[0]), "a week-old call is redone even when nothing moved");
ck = M.dailyCheck({ outlook: { ...ol, date: "2026-11-07" }, ser: { dates: ["2026-11-09"], closes: [101] }, sigma1m: 5, today: "2026-11-09" });
assert.strictEqual(ck.redo, null, "nothing material: leave the calls alone");
ck = M.dailyCheck({ outlook: { ...ol, date: "2026-11-07" }, writeWhy: ["Semiconductors was re-analyzed"], today: "2026-11-09", seasonInfo: { recent: [{ ticker: "NVDA", weight: 0.07, last: "2026-11-08" }] } });
assert.strictEqual(ck.redo, "write"); assert(ck.why.some((x) => /NVDA reported since the calls/.test(x)));
assert.strictEqual(M.dailyCheck({ outlook: null, today: "2026-11-09" }).redo, "calls");
const lg = M.logDay(M.logDay([], { date: "2026-11-08", action: "calls" }), { date: "2026-11-09", action: "none" });
assert.deepStrictEqual(lg.map((x) => x.date), ["2026-11-09", "2026-11-08"]);
assert.strictEqual(M.logDay(lg, { date: "2026-11-09", action: "calls" }).length, 2, "one entry per day");
const fr = M.freshness({ cov, raw: { fetched_at: "2026-11-09T10:00:00Z", holdings: [{ date: "2026-09-30" }] }, ser }, { at: "2026-11-01T00:00:00Z", outlook: ol }, "2026-11-09");
assert(fr.find((x) => x.what === "Holdings file").age === 40 && fr.find((x) => x.what === "The 1M-12M calls").age === 8);
console.log("fundmore tests passed", JSON.stringify({ best: sc0.best, growth: Math.round(sc0.profiles.growth.base), cycle: Object.keys(cy.phase).slice(0, 3), ev: Math.round(sl.ev * 10) / 10 }));
// ---- how the fund suffers when the macro turns (the stress test)
{
  const days = [...Array(1500).keys()], dates = days.map((i) => new Date(Date.UTC(2020, 0, 1) + i * 864e5).toISOString().slice(0, 10));
  const sens = { r2: 0.8, from: "2025-11-01", to: "2026-11-01", factors: [{ key: "market", label: "Stock market (SPY)", shock_label: "+1% S&P 500", total: { beta: 1.2, t: 30, effect: 0.012 }, partial: { beta: 1.1, t: 25, effect: 0.011 } },
    { key: "rates", label: "10-year Treasury yield", shock_label: "+0.25pp 10-year yield", total: { beta: -0.03, t: -4, effect: -0.0075 }, partial: { beta: -0.01, t: -2, effect: -0.0025 } }] };
  const X = M.macroStress({ sens, indSens: [{ key: "market", effect: 0.011 }], series: { market: { dates, values: days.map((i) => 100 * Math.exp(0.0003 * i + 0.05 * Math.sin(i / 20))) }, rates: { dates, values: days.map((i) => 4 + Math.sin(i / 40)) } } });
  const mk = X.rows.find((r) => r.key === "market"), rt = X.rows.find((r) => r.key === "rates");
  assert(mk.bad.move < 0 && mk.bad.fund < 0 && mk.severe.fund <= mk.bad.fund, "the market's bad month is a fall, and it hurts");
  assert(rt.bad.move > 0 && rt.bad.fund < 0 && /pp$/.test(rt.bad.label), "rates hurt when they rise, in points");
  assert(X.rows[0].bad.fund <= X.rows[1].bad.fund, "the worst factor first");
  const sel = X.scenarios.find((s) => s.name === "Equity selloff"); assert(sel && Math.abs(sel.fund - 1.1 * sel.legs[0].move) < 1e-12 && !sel.approx, "combined shocks use the partial betas");
  assert(X.scenarios.find((s) => s.name === "Soft landing").fund > 0);
  assert(M.stressText(X, "FCNTX").includes("[ST1]"));
  assert.strictEqual(M.factorOf({ label: "US 10Y Treasury yield" }), "rates"); assert.strictEqual(M.factorOf({ label: "WTI crude" }), "oil"); assert.strictEqual(M.factorOf({ label: "Copper" }), null);
  console.log("fundmore ok (stress test)");
}
// ---- news and sentiment
{
  const sent = { NVDA: [{ date: "2026-11-05", count: 40, normalized: 0.4 }, { date: "2026-09-01", count: 30, normalized: 0.8 }] };
  const N = M.newsLook({ cov, digests: D, hold, sent, news: [{ date: "2026-11-07", symbol: "NVDA", title: "Nvidia guides above", source: "Reuters" }, { date: "2026-11-06", symbol: "NVDA", title: "Nvidia guides above!", source: "CNBC" }], today: "2026-11-09" });
  const nv = N.rows.find((r) => r.ticker === "NVDA"); assert(nv.src === "EODHD" && Math.abs(nv.s30 - 0.4) < 1e-9 && Math.abs(nv.s90 - (40 * 0.4 + 30 * 0.8) / 70) < 1e-9 && nv.spike > 1.5, "a holding's own scores, count-weighted, with its article pace");
  assert(N.rows.some((r) => r.src === "industry run"), "else its industry run's figures");
  assert(N.heads[0].id === "NW1" && N.heads[0].weight > 0 && N.heads.filter((x) => /nvidia guides above/i.test(x.title)).length === 1, "one headline per story, tagged with its weight");
  assert(N.heads.some((x) => x.from === "industry run"), "the industry runs' news on its holdings");
  assert(N.flow.length && N.flow[0].news_dim && isFinite(N.ind.s30) && N.breadth.improving + N.breadth.worsening <= 1.0001);
  assert(M.newsText(N, "FCNTX").includes("[NS1]") && M.newsText(N, "FCNTX").includes("[NW1]"));
  console.log("fundmore ok (news)");
}
// the benchmark on the same scorecard
{
  const bo = M.benchOwnFrom({ retRows: [{ label: "1Y", value: 11, bench: 13, spy: 13 }], gB: { beta: 1, vol: 0.16, downside_vol: 0.11, max_dd: -0.12, sharpe: 0.9 } });
  assert(bo.ex1y === 0 && bo.beta === 1 && !Number.isFinite(bo.yield));
  const bc = M.scorecard({ cov, digests: D, own: bo }); assert(bc.pillars.risk.from === "fund" && Number.isFinite(bc.profiles.growth.base));
  console.log("fundmore ok (benchmark scorecard)");
}
