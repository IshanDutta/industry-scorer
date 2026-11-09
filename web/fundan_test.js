const assert = require("assert");
const P = require("./portfolio.js"), A = require("./fundan.js");
const FX = require("./fixtures/funds.json");
const m = P.mapHoldings(P.fromFmp(FX.fcntx_holdings), [], FX.cos), cov = P.coverage(m, FX.runs, { now: "2026-11-09" });
const sm = P.mapHoldings(P.fromFmp(FX.spy_holdings), [], FX.cos), scov = P.coverage(sm, FX.runs, { now: "2026-11-09" });
const D = FX.digests;
// holdings and concentration
const hold = A.holdings(m, D);
assert.strictEqual(hold[0].ticker, "NVDA"); assert(hold[0].inTop50 && hold[0].rank >= 1, "NVDA is in its industry's top 50");
assert(hold.find((h) => h.ticker === "GOOGL")?.inTop50, "GOOGL finds its row through GOOG");
const conc = A.concentration(m);
assert(conc.top10 > 0.3 && conc.top10 < 0.7 && conc.effective_n > 10, JSON.stringify(conc));
// extras and calendar
const ext = A.extras(cov, D);
assert(ext.F.op_margin.v > 0 && ext.F.op_margin.v < 1 && ext.base["12M"].v > 0.3 && ext.base["12M"].v < 0.95);
const cal = A.calendar(hold, cov, D, "2026-11-09");
assert(cal.every((x, i) => i === 0 || x.date >= cal[i - 1].date), "the calendar is in date order");
// the dossier and prompts
const fd = { sym: "FCNTX", facts: P.facts("FCNTX", [{ name: "Fidelity Contrafund", expenseRatio: 0.63, avgVolume: 0 }], null), cov, look: P.lookThrough(cov, D), act: P.active(cov, scov, D), bench: { symbol: "SPY" }, digests: D, flags: [], mapped: m, hold, conc, ext, cal,
  retRows: [{ label: "1Y", value: 11, bench: 13, spy: 13 }], g1: { beta: 1.1, corr: 0.95, alpha: -0.01, vol: 0.2, tracking_error: 0.05, up_capture: 1.05, down_capture: 1.1, max_dd: -0.18 }, ep: [{ label: "2020 Covid crash", kind: "stress", from: "2020-02-19", to: "2020-03-23", ret: -0.3, spy: -0.34, dd: -0.31, capture: 0.88 }],
  sens: { factors: [{ label: "Oil", shock_label: "+10% oil", total: { effect: -0.004, t: -2 }, partial: { effect: -0.002 } }] } };
const dz = A.dossier(fd, "2026-11-09");
for (const id of ["F1", "I1", "H1", "P1", "P2", "S1", "MF1", "V1", "V6"]) assert(dz.idx[id], `dossier has ${id}`);
for (const part of A.PARTS) { const pr = A.partPrompt(fd, dz, part, "2026-11-09"); assert(pr.length < 70000, `${part} prompt ${pr.length}`); assert(pr.includes("Reply with ONLY this JSON")); }
// cleaning
const core = A.cleanPart("core", { headline: "Chips [I1] and [ZZ9]", verdict: { call: "Attractive" }, fit: { growth: { fit: "Strong", adjust: 12 } }, risks: [{ risk: "Taiwan [C1]", likelihood: "High", ids: ["C1", "Q1"] }], reads: { holdings: "Top 10 [H1]" } }, dz.idx);
assert.strictEqual(core.w.headline, "Chips [I1] and"); assert.strictEqual(core.w.verdict.call, "attractive"); assert.strictEqual(core.w.fit.growth.fit, "strong"); assert(!("adjust" in core.w.fit.growth), "the fit's points come from the fit word"); assert.deepStrictEqual(core.w.risks[0].ids, ["C1"]); assert.strictEqual(core.dropped, 2);
const calls = A.cleanPart("calls", { scenarios: { bull: { probability: 30, narrative: "x", triggers: ["a"], move: [20, 10] }, base: { probability: 50 }, bear: { probability: 30 } },
  horizons: { "1M": { call: "Slightly Bullish", expected_move: [-2, 4], probability_up: 56, drivers: "d [F4]" } } }, dz.idx);
assert(!("move" in calls.w.scenarios.bull) && !("expected_move" in calls.w.horizons["1M"]) && !("call" in calls.w.horizons["1M"]), "no ranges and no calls in the write-up's calls part");
assert.deepStrictEqual(A.checks(calls.w).issues, ["the scenario probabilities add to 110%, not 100%"]);
const ctx = A.cleanPart("context", { industries: [{ id: "I1", effect: "helps", why: "x" }, { id: "I999", effect: "hurts" }], macro: { regime: "Headwind", factors: [{ id: "MF1", effect: "headwind" }] } }, dz.idx);
assert.strictEqual(ctx.w.industries.length, 1); assert.strictEqual(ctx.w.macro.regime, "headwind"); assert.strictEqual(ctx.w.macro.factors[0].id, "MF1");
assert(!A.leanPrompt, "the old outlook prompt is gone");

// Wall Street and sentiment
const hh = [{ ticker: "AAA", weight: 0.6, px: 100 }, { ticker: "BBB", weight: 0.4, px: 50 }];
const stl = A.streetLook(hh, { AAA: { buy: 8, hold: 2, sell: 0, target: 120, consensus: "Buy" }, BBB: { buy: 1, hold: 3, sell: 0, target: 45 } });
assert(Math.abs(stl.buy_share - (0.6 * 0.8 + 0.4 * 0.25)) < 1e-9 && Math.abs(stl.upside - (0.6 * 0.2 + 0.4 * -0.1)) < 1e-9);
const sl = A.sentimentLook(hh, { AAA: [{ date: "2026-11-01", count: 10, normalized: 0.5 }, { date: "2026-08-20", count: 10, normalized: -0.5 }] }, "2026-11-09");
assert(Math.abs(sl.s30 - 0.5) < 1e-9 && Math.abs(sl.s90 - 0) < 1e-9);
// the outlook, like the company page's: six levels, the fund's sixteen components, code's starting point
const pr = A.prior(fd);
assert(pr && pr["12M"] && /^(slightly |strongly )?(bullish|bearish)$/.test(pr["12M"].call), JSON.stringify(pr && pr["12M"]));
assert(pr["12M"].parts[0].label.includes("industries' outlooks"));
const op = A.outlookPrompt({ ...fd, ser: { dates: ["2026-01-02", "2026-11-06"], closes: [100, 110] } }, dz, "2026-11-09", { core: { headline: "h", verdict: { call: "neutral", summary: "s" } } });
assert(op.includes("Six levels, no neutral") && op.includes("CODE'S STARTING POINT") && op.includes('"industries | verdict | holdings'), "the company page's rules and the fund's components");
const raw = { headline: "Up", evidence: A.FUND_INPUTS.map(([k], i) => ({ input: k, points: i % 3 ? "up" : "down", weight: 2, why: "w" })),
  calls: { "1M": { call: "slightly bearish", why: "then it rebounds" }, "3M": { call: "bullish", why: "after earnings" }, "6M": { call: "bullish", why: "y" }, "12M": { call: "Strongly Bullish", why: "z" } }, verdict: { agrees: true, why: "v" } };
const oc = A.cleanOutlook(raw, "2026-11-09");
assert.strictEqual(oc.calls["12M"].call, "strongly bullish"); assert.strictEqual(oc.evidence.length, A.FUND_INPUTS.length); assert(oc.tally.score > 0);
assert(A.cleanOutlook({ calls: { "1M": { call: "neutral" } } }, "x") === null, "neutral isn't a level");
assert.strictEqual(A.provisional(pr, "2026-11-09").calls["12M"].call, pr["12M"].call);
// Times like this: the industries' engine on the fund's own prices; the base rates move code's starting point; HE lines in the dossier
{
  const RG = require("./regimes.js"), M = require("./fundmore.js");
  const mkS = (k, drift, n = 4300) => { const dates = [], values = []; let v = 100; const t0 = Date.UTC(2009, 0, 2); for (let i = 0; i < n; i++) { const d = new Date(t0 + i * 864e5 * 1.4); if (d.getUTCDay() % 6 === 0) continue; v *= 1 + drift + 0.012 * Math.sin(i / k) * Math.cos(i / 97); dates.push(d.toISOString().slice(0, 10)); values.push(v); } return { dates, values }; };
  const fser = mkS(13, 0.0004), T = RG.episodes({ ind: fser, mk: { spy: mkS(17, 0.0003), vix: { dates: fser.dates, values: fser.values.map((x, i) => 15 + 5 * Math.sin(i / 50)) } }, today: fser.dates[fser.dates.length - 1] });
  assert(T && T.episodes.length === 5 && T.base["12M"].n >= 15, "five past months like today, and base rates");
  const fd3 = { ...fd, times: T, hist: { episodes: [{ id: "HE1", then: "A rate scare.", after: "It recovered." }], read: "Mostly up after." } };
  const dz3 = A.dossier(fd3, "2026-11-09");
  assert(dz3.idx.HE1 && dz3.idx.HE5 && dz3.blocks.tech.includes("FCNTX, 3 months") && dz3.blocks.tech.includes("[HE1] the historian: A rate scare."), "HE lines, in the fund's words");
  assert(!/\bindustry\b/i.test(M.timesText(T, "FCNTX").replace(/industries/g, "")), "no industry wording left");
  const T2 = JSON.parse(JSON.stringify(T)); for (const h of ["1M", "3M", "6M", "12M"]) { T2.base[h].pos = 90; T2.base[h].all_pos = 60; T2.base[h].n = 20; }
  const p0 = A.prior({ ...fd, times: null }), p2 = A.prior({ ...fd, times: T2 });
  assert(Math.abs(p2["12M"].score - p0["12M"].score - 0.5) < 1e-9 && /past months most like today/.test(p2["12M"].parts[1].label), "times like this moves the starting point half a notch");
  assert(M.historianPrompt("Fidelity Contrafund", "FCNTX", T, { today: "2026-11-09" }).includes("market historian for the fund Fidelity Contrafund (FCNTX)"));
  assert(!("trackLog" in A) && !A.PANELS.calls.track, "no track record");
}
// phase 2: what its biggest industries' reports say, panel by panel
const ir = A.indReads(cov, D, "val", 3);
assert.strictEqual(ir.length, 3); assert.strictEqual(ir[0].industry, cov.industries[0].industry, "biggest first"); assert(ir[0].text.length > 20);
const ib = A.indReadsBlock(fd, "core");
assert(/WHAT ITS BIGGEST INDUSTRIES' OWN REPORTS SAY/.test(ib) && /valuation: Semiconductors/.test(ib), ib.slice(0, 300));
assert(A.partPrompt(fd, dz, "context", "2026-11-09").includes("world events:"), "the context analyst gets the industries' world reads");
console.log("fundan tests passed", JSON.stringify({ top10: +conc.top10.toFixed(3), eff: +conc.effective_n.toFixed(1), cal: cal.length, prompts: A.PARTS.map((p) => A.partPrompt(fd, dz, p, "2026-11-09").length) }));
// phases 3-4: the scorecard, peers, season, debates and cycle go into the dossier, and the analysts' answers are cleaned
{
  const M = require("./fundmore.js");
  const fd2 = { ...fd, card: M.scorecard({ cov, digests: D, own: { ex1y: 0.02, vol: 0.18, yield: 0.004, expense: 0.0063 } }), debates: M.debates(cov, D), cycle: M.cycleLook(cov, D),
    season: { n: 2, on: 0.1, reported: 0.08, beat_share: 1, median_surprise: 0.05, next30: 0.02, recent: [{ ticker: "NVDA", last: "2026-08-27", surprise: 0.05, weight: 0.07 }], upcoming: [], weeks: [] },
    peers: { rows: M.peerTable([{ sym: "FCNTX", self: true, r1y: 0.11, r3y: 0.15, vol: 0.18, max_dd: -0.12, expense: 0.0063 }, { sym: "VUG", r1y: 0.14, r3y: 0.17, vol: 0.2, max_dd: -0.15, expense: 0.0004 }]) } };
  const dz2 = A.dossier(fd2, "2026-11-09");
  for (const id of ["SC1", "PR1", "ES1", "DB1", "CY1"]) assert(dz2.idx[id], `dossier has ${id}`);
  assert(A.partPrompt(fd2, dz2, "core", "2026-11-09").includes("[SC1]") && A.partPrompt(fd2, dz2, "calls", "2026-11-09").includes("[DB1]") && A.partPrompt(fd2, dz2, "context", "2026-11-09").includes("[CY1]"));
  const k2 = A.cleanPart("calls", { debates: [{ id: "DB1", side: "Bull", why: "AI [H1]" }, { id: "DB99", side: "bear" }] }, dz2.idx);
  assert.deepStrictEqual(k2.w.debates.map((x) => x.side), ["bull"]);
  const x2 = A.cleanPart("context", { cycle: { phase: "Late", summary: "late [CY1]", kpis_watch: ["NVDA [KT1]"] } }, dz2.idx);
  assert.strictEqual(x2.w.cycle.phase, "late");
  const c2 = A.cleanPart("core", { peers: { stance: "Lagging", summary: "costs more [PR1]" } }, dz2.idx);
  assert.strictEqual(c2.w.peers.stance, "lagging");
  assert(A.outlookPrompt(fd2, dz2, "2026-11-09", { calls: k2.w, context: x2.w, core: c2.w }).includes("Debates: DB1 bull"));
  assert(A.FUND_INPUTS.some(([k]) => k === "cycle") && A.FUND_INPUTS.some(([k]) => k === "season"));
}
console.log("fundan ok (phases 3-4)");
// fleshed-out reads: a note per panel (text, findings, what it means, what to watch); a fifth analyst on the markets
{
  assert.deepStrictEqual(A.PARTS, ["core", "calls", "markets", "context", "exposures"]);
  const keys = Object.values(A.PANELS).flatMap((x) => Object.keys(x));
  for (const k of ["score", "peers", "holdings", "industries", "valuation", "fundamentals", "income", "coverage", "debates", "calendar", "plan", "times", "perf", "risk", "stress", "tech", "street", "news", "dist", "season", "cycle", "sens", "look", "world", "active", "trade", "regulation", "outside"]) assert(keys.includes(k), "a read for " + k);
  assert.strictEqual(new Set(keys).size, keys.length, "each panel read by one analyst");
  const mk = A.cleanPart("markets", { returns: { summary: "Lagged SPY [P1]." }, risk_profile: { level: "High", summary: "Beta 1.1 [P2].", worst_case: "-31% in 2020 [S1]." },
    reads: { risk: { text: "Riskier than SPY [P2] [ZZ1].", points: ["Beta 1.1 [P2]", { text: "Max drawdown -18% [P2]" }], means: "Size it smaller.", watch: "Beta above 1.2" }, perf: "Old-style string [P1]." } }, dz.idx);
  assert.strictEqual(mk.w.risk_profile.level, "high"); assert.strictEqual(mk.w.reads.risk.points.length, 2); assert.strictEqual(mk.w.reads.risk.text, "Riskier than SPY [P2]."); assert.strictEqual(mk.w.reads.perf.text, "Old-style string [P1].");
  assert(A.partPrompt(fd, dz, "markets", "2026-11-09").includes('"risk": {"text": "5-7 sentences'));
  const hn = A.cleanPart("core", { holdings_notes: [{ id: "H1", bet: "AI chips", view: "18% of the fund [H1].", stance: "Tailwind" }, { id: "H99", view: "x" }] }, dz.idx);
  assert.deepStrictEqual(hn.w.holdings_notes.map((x) => [x.id, x.stance]), [["H1", "tailwind"]]);
  console.log("fundan ok (fleshed-out reads)");
}
