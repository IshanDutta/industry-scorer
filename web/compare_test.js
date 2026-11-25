// node web/compare_test.js
const assert = require("assert");
const C = require("./compare.js");

const days = (n0, f) => { const dates = [], closes = []; let d = Date.UTC(2023, 0, 2), v = 100;
  for (let i = 0; i < n0; i++) { const dt = new Date(d + i * 864e5); if (dt.getUTCDay() % 6 === 0) continue; v *= 1 + f(i); dates.push(dt.toISOString().slice(0, 10)); closes.push(v); }
  return { dates, closes }; };
const noise = (seed) => { let s = seed; return () => { s = (s * 9301 + 49297) % 233280; return s / 233280 - 0.5; }; };
const na = noise(1), nb = noise(7);
const common = Array.from({ length: 1200 }, () => na());
const A = { sym: "AAA", kind: "stock", name: "Alpha", sub: "Software", m: { pe: 35, fwd_pe: 30, rev_growth: 0.25, ntm_growth: 0.2, op_margin: 0.3, div_yield: 0, vol_1y: 0.35, beta: 1.3, ret_1Y: 0.3, sharpe_1y: 1.1, de: 0.3 },
  pillars: { momentum: 80, cycle: 60, macro: 55 }, profiles: { growth: { total: 75 }, income: { total: 30 } }, outlook: { source: "written analysis", calls: { "1M": { call: "slightly bullish" }, "3M": { call: "bullish" }, "6M": { call: "bullish" }, "12M": { call: "strongly bullish" } } },
  saved: { at: "2026-11-18", fit: { growth: { fit: "strong" }, income: { fit: "poor" } }, headline: "Fast grower", scenarios: [{ k: "bull", probability: 30, target: 150, move: 0.3 }] },
  ind: { name: "Software", headline: "Demand strong", outlook: { calls: { "12M": { call: "bullish" } } } }, ser: days(1500, (i) => 0.0008 + 0.02 * common[i % 1200]) };
const B = { sym: "BBB", kind: "stock", name: "Beta", sub: "Utilities", m: { pe: 15, fwd_pe: 14, rev_growth: 0.03, ntm_growth: 0.04, op_margin: 0.2, div_yield: 0.045, payout: 0.6, vol_1y: 0.16, beta: 0.5, ret_1Y: 0.08, sharpe_1y: 0.6, de: 1.4 },
  pillars: { momentum: 40 }, profiles: { income: { total: 80 }, growth: { total: 35 } }, outlook: { source: "industry", calls: { "12M": { call: "slightly bearish" } } }, ser: days(1500, (i) => 0.0002 + 0.008 * (0.3 * common[i % 1200] + nb())) };
const F = { sym: "FFF", kind: "fund", name: "Fund", m: { expense: 0.001, top10: 0.3, eff_n: 60, vol_1y: 0.18, div_yield: 0.015, ret_1Y: 0.15 }, pillars: { valuation: 55, growth: 60 }, profiles: {},
  holdings: [{ ticker: "AAA", weight: 0.08 }, { ticker: "ZZZ", weight: 0.05 }], ser: days(1500, (i) => 0.0005 + 0.01 * common[i % 1200]) };

const subs = [A, B, F], sc = C.scoreAll(subs);
assert(sc.AAA.groups.growth.score > sc.BBB.groups.growth.score, "growth: AAA ahead");
assert(sc.BBB.groups.income.score > sc.AAA.groups.income.score, "income: BBB ahead");
assert(sc.BBB.groups.risk.score > sc.AAA.groups.risk.score, "risk: BBB safer");
assert.equal(sc.FFF.groups.valuation.from, "its industries", "fund valuation falls back to its look-through pillar");
assert(sc.FFF.groups.cost, "funds get a cost dimension");
assert(!sc.AAA.groups.cost, "stocks don't");
assert(sc.AAA.groups.outlook.score > 70 && sc.BBB.groups.outlook.score < 50);

const fit = C.fits(subs, sc);
assert.equal(fit.growth.ranked[0], "AAA", "growth investor: AAA");
assert.equal(fit.income.ranked[0], "BBB", "income investor: BBB");
assert(fit.growth.AAA.fit === "strong" && fit.income.AAA.total < fit.income.BBB.total);

const h = C.headToHead(subs, sc);
assert(h.rows.find((r) => r.key === "pe").leader === "BBB", "lower P/E leads");
assert(h.rows.find((r) => r.key === "rev_growth").leader === "AAA");
assert(h.groups.growth.leader === "AAA");

const corr = C.correlation(subs);
assert(corr.n >= 200 && corr.corr[0][0] === 1);
assert(corr.corr[0][2] > 0.9, "the fund moves with AAA: " + corr.corr[0][2]);
assert(corr.corr[0][1] < corr.corr[0][2]);
assert(corr.mixVol < corr.avgVol, "mixing lowers volatility");

const rb = C.rebase(subs, "2025-01-01"); assert(rb.length === 3 && Math.abs(rb[0].values[0] - 100) < 1e-9 && rb[0].dates.length === rb[1].dates.length);
const dd = C.drawdown(rb[0].dates, rb[0].values); assert(Math.max(...dd.values) <= 1e-12);
assert(C.years(subs).length >= 2);
const ov = C.overlap(subs); assert(ov.find((o) => o.kind === "stock-in-fund" && o.a === "AAA").shared === 0.08);

const text = C.dossier({ subjects: subs, sc, fit, h2h: h, corr, ovl: ov, today: "2026-11-21" });
assert(/=== AAA/.test(text) && /WRITTEN ANALYSIS \(made here/.test(text) && /CODE'S COMPARISON/.test(text) && /Holdings overlap|is 8\.0% of FFF/.test(text));
const p = C.prompt(text, ["AAA", "BBB", "FFF"], "2026-11-21"); assert(p.length < 60000 && /Return ONLY a JSON object/.test(p));

const v = C.clean({ headline: "AAA wins", overall: { pick: "aaa", why: "x" }, ranking: ["AAA", "XXX"], investors: { income: { pick: "AAA", why: "bad pick" }, growth: { pick: "AAA" } },
  dimensions: [{ key: "income", pick: "AAA", why: "y" }, { key: "nope", pick: "AAA" }], names: { AAA: { verdict: "buy", strengths: ["a"] } }, together: { mix: { AAA: 3, BBB: 1 } } }, ["AAA", "BBB", "FFF"]);
assert.equal(v.overall.pick, "AAA"); assert.deepEqual(v.ranking, ["AAA", "BBB", "FFF"]); assert.equal(v.dimensions.length, 1);
assert(v.names.FFF && v.names.BBB.verdict === null); assert.equal(v.together.mix.AAA + v.together.mix.BBB + v.together.mix.FFF, 100);
const ck = C.checks(v, h, fit); assert(ck.some((x) => x.where === "income"), "flags the income pick against code's numbers");
assert(C.fingerprint(subs, "2026-11-21").includes("AAA:2026-11-18"));
// The desks: each ticker's blocks for the desk, shared industry blocks once, every ticker covered in the answer.
A.dz = { calls: "CAL-A", watch: "WATCH-A", aff_macro: "MI-SOFTWARE", aff_world: "WS-SOFTWARE", aff_trade: "TC-SOFTWARE", facts: "SENS-A", numbers: "NUM-A", street: "ST-A", news: "[N1] news" };
B.dz = { calls: "CAL-B", aff_macro: "MI-UTIL", numbers: "NUM-B", street: "ST-B" }; B.ind = { name: "Software" };
F.dz = { cal: "FCAL", aff_macro: "FMACRO", aff_world: "FWORLD", base: "FBASE", tech: "FTECH" };
const ed = C.deskDossier("events", subs);
assert(/CAL-A/.test(ed) && /WATCH-A/.test(ed) && /SENS-A/.test(ed) && /FCAL/.test(ed) && !/NUM-A/.test(ed) && !/MI-SOFTWARE/.test(ed), "the events desk gets calendars, watched releases and sensitivities");
const md = C.deskDossier("macro", subs);
assert(/MI-SOFTWARE/.test(md) && /WS-SOFTWARE/.test(md) && /TC-SOFTWARE/.test(md) && /FMACRO/.test(md) && /FWORLD/.test(md) && !/CAL-A/.test(md), "the macro desk gets the macro tables and foreign affairs");
assert(/same Software industry report as AAA/.test(md) && !/MI-UTIL/.test(md), "a shared industry's tables are given once");
const sd = C.deskDossier("street", subs); assert(/ST-A/.test(sd) && /\[N1\]/.test(sd) && /FTECH/.test(sd) && !/CAL-A/.test(sd));
assert(/WRITTEN ANALYSIS/.test(C.deskDossier("fundamentals", subs)));
assert(/event strategist/.test(C.deskPrompt("events", ed, ["AAA", "BBB", "FFF"], "2026-11-23")) && /foreign-affairs strategist/.test(C.deskPrompt("macro", md, ["AAA", "BBB", "FFF"], "2026-11-23")));
const de = C.cleanDesk("events", { pick: "aaa", events: [{ date: "2026-12-09", event: "FOMC", importance: "high", watch: "a hike", impact: { AAA: "negative", BBB: "bogus" }, outcomes: [{ if: "hike", odds: 70, moves: { AAA: "-3%" } }, { if: "" }] }, { date: "soon", event: "x" }],
  months: [{ month: "2026-12", theme: "Fed", risk: "huge" }], paths: { AAA: { path: "p", skew: "upside" } } }, ["AAA", "BBB", "FFF"]);
assert(de.pick === "AAA" && de.events.length === 1 && de.events[0].impact.BBB === "neutral" && de.events[0].outcomes.length === 1 && de.events[0].outcomes[0].moves.FFF === "" && de.months[0].risk === "medium" && de.paths.FFF && de.paths.AAA.skew === "upside");
const dm = C.cleanDesk("macro", { regime: "r", indicators: [{ label: "CPI", impact: { AAA: "negative" } }], world: [{ situation: "Iran", impact: { AAA: { direction: "positive", why: "oil" } } }], trade: [{ country: "China", impact: {} }],
  scenarios: [{ name: "Base", probability: 60, impact: { AAA: { move: "+3%" } } }], names: { AAA: { read: "m" } } }, ["AAA", "BBB", "FFF"]);
assert(dm.indicators[0].impact.BBB === "neutral" && dm.world[0].impact.AAA.direction === "positive" && dm.trade[0].impact.FFF.direction === "neutral" && dm.scenarios[0].impact.BBB.move === "" && dm.names.FFF);
const dOld = C.cleanDesk("macro", { regime: "r", events: [{ date: "2026-12-09", event: "FOMC" }] }, ["AAA", "BBB"]); assert(dOld.events.length === 1, "older verdicts kept their events on the macro desk");
const ds = C.cleanDesk("street", { names: { AAA: { crowding: "huge", signal: "positive" } } }, ["AAA", "BBB"]); assert(ds.names.AAA.crowding === null && ds.names.AAA.signal === "positive" && ds.names.BBB);
const dt = C.desksText({ events: de, macro: dm, street: ds }, ["AAA", "BBB", "FFF"]); assert(/EVENTS DESK/.test(dt) && /MACRO & FOREIGN AFFAIRS DESK/.test(dt) && /Outcomes: hike 70%/.test(dt));
assert(/Four desks/.test(C.prompt("x", ["AAA", "BBB"], "2026-11-23", "DESKS")) && !/Four desks/.test(C.prompt("x", ["AAA", "BBB"], "2026-11-23")));
// The macro table and foreign affairs merge row by row, each ticker with its own read.
A.aff = { regimes: [{ industry: "Software", regime: "late cycle", headline: "h" }], indicators: [{ key: "cpi", label: "CPI", group: "Inflation", value: 3.7, unit: "%", chg_1m: 0.2, effects: { headwind: 1 }, reads: [{ relevance: "high", effect: "headwind", why: "costs", weight: 1 }] }],
  world: [{ title: "Iran conflict", deep: true, stances: { adverse: 1 }, summary: "s", scenarios: [{ name: "ceasefire", probability: 30 }] }], trade: [{ country: "China", rev: 0.2, stances: { strained: 1 } }], rules: [{ name: "Rule X", severity: "high" }], items: [] };
F.aff = { indicators: [{ key: "cpi", label: "CPI", group: "Inflation", effects: { tailwind: 0.6, headwind: 0.2 }, reads: [{ relevance: "medium", effect: "tailwind", weight: 0.6 }] }, { key: "oil", label: "Brent", group: "Energy", effects: {}, reads: [] }],
  world: [{ title: "Iran Conflict!", stances: { supportive: 0.4 }, winners_held: [{ symbol: "AAA" }] }], trade: [{ country: "china", rev: 0.05, rev_est: true }], rules: [], items: [] };
const MA = C.mergeAffairs(subs);
assert(MA.indicators[0].key === "cpi" && MA.indicators[0].per.AAA.effect === "headwind" && MA.indicators[0].per.FFF.effect === "tailwind" && MA.indicators.length === 2);
assert(MA.world.length === 1 && MA.world[0].per.AAA.stance === "adverse" && MA.world[0].per.FFF.stance === "supportive" && MA.world[0].per.FFF.named[0] === "+AAA" && MA.world[0].scenarios.length === 1);
assert(MA.trade.length === 1 && MA.trade[0].per.AAA.rev === 0.2 && MA.trade[0].per.FFF.est === true && MA.regimes.length === 1 && MA.rules[0].per.AAA.severity === "high");
// Overall must win at least one investor type.
const vx = C.clean({ headline: "h", overall: { pick: "BBB", why: "w" }, ranking: ["BBB", "AAA", "FFF"], investors: { income: { pick: "AAA" }, conservative: { pick: "AAA" }, growth: { pick: "FFF" }, aggressive: { pick: "FFF" } } }, ["AAA", "BBB", "FFF"]);
assert.equal(vx.overall.pick, "AAA", "ties broken by the answer's ranking"); assert(/without picking it/.test(vx.overall.adjusted) && vx.ranking[0] === "AAA");
assert(C.checks(vx, h, fit).some((x) => x.where === "overall"));
const vy = C.clean({ headline: "h", overall: { pick: "FFF", why: "w" }, ranking: ["AAA", "FFF"], investors: { growth: { pick: "FFF" } } }, ["AAA", "FFF"]);
assert(vy.overall.pick === "FFF" && !vy.overall.adjusted && vy.ranking[0] === "FFF");
console.log("compare ok");

// A bond fund with no industries gets a code read of every indicator through its duration, and a row in the macro calls.
{
  const C2 = require("./compare.js");
  const stock = { sym: "PEP", kind: "stock", aff: { regimes: [{ industry: "Beverages", weight: 1, regime: "mixed", headline: "h" }], indicators: [
    { key: "cpi", label: "US CPI y/y", group: "Inflation", value: 3.7, prior: 3.4, effects: { headwind: 1 }, reads: [{ effect: "headwind", relevance: "high", weight: 1 }] },
    { key: "unemp", label: "Unemployment rate", group: "Labor", value: 4.1, prior: 4.3, effects: { neutral: 1 }, reads: [] },
    { key: "dxy", label: "Dollar index", group: "FX", value: 99, prior: 98, effects: {}, reads: [] }] } };
  const shy = { sym: "SHY", kind: "fund", bond: { kind: "short-term Treasuries", duration: 1.9, ytm: 3.9, carry: 3.75, credit: false, breakeven: 190, shocks: [{ bp: 100, ret: -1.9, ret12: 1.9 }] }, aff: null,
    bondInd: [{ label: "Fed funds rate", value: 4.5, prior: 4.25, unit: "%" }, { label: "US CPI y/y", value: 3.7, prior: 3.4 }] };
  const M2 = C2.mergeAffairs([stock, shy]);
  const row = (k) => M2.indicators.find((e) => e.key === k || e.label === k);
  assert.equal(row("cpi").per.SHY.effect, "headwind");
  assert.equal(row("cpi").per.SHY.relevance, "medium");
  assert.equal(row("unemp").per.SHY.effect, "headwind", "falling unemployment hurts Treasuries");
  assert.ok(!row("dxy").per.SHY, "no rule for the dollar");
  assert.equal(row("Fed funds rate").per.SHY.relevance, "high");
  assert.ok(!M2.indicators.some((e) => e.label === "US CPI y/y" && e.key !== "cpi"), "no duplicate CPI row");
  const rg = M2.regimes.find((r) => r.sym === "SHY"); assert.ok(rg && rg.bond && /1\.9y duration/.test(rg.industry) && rg.regime === "restrictive", JSON.stringify(rg));
  const hyg = C2.bondRead({ kind: "high-yield (junk) corporate bonds", duration: 3, credit: true }, { label: "Unemployment rate", value: 4.4, prior: 4.1 });
  assert.equal(hyg.effect, "headwind");
  console.log("bond macro ok");
}
// The macro desk reads one combined affairs text; a ticker outside it (no industries) keeps its own.
{
  const C3 = require("./compare.js");
  const subs = [{ sym: "KO", kind: "stock", affIn: { industries: [{ industry: "Bev", weight: 1 }] }, dz: { aff_macro: "KO-MACRO", context: "KO-CTX" } },
    { sym: "SHY", kind: "fund", affIn: null, dz: { aff_macro: "SHY-BOND-READ", bond: "SHY-BOND" } }];
  const t = C3.deskDossier("macro", subs, { combined: "COMBINED-TEXT" });
  assert.ok(t.includes("COMBINED-TEXT") && !t.includes("KO-MACRO") && t.includes("KO-CTX") && t.includes("SHY-BOND-READ"), t);
  const t2 = C3.deskDossier("macro", subs, {}); assert.ok(t2.includes("KO-MACRO") && !t2.includes("COMBINED-TEXT"));
  const t3 = C3.deskDossier("events", subs, { combined: "COMBINED-TEXT" }); assert.ok(!t3.includes("COMBINED-TEXT"));
  console.log("combined affairs ok");
}

// The two slow desks run as two halves on the same dossier; their answers merge back into one desk.
{
  const C4 = require("./compare.js"), syms = ["AAA", "BBB"];
  for (const [d, parts] of Object.entries(C4.DESK_PARTS)) for (const p of parts) {
    const t = C4.deskPrompt(d, "DOSSIER-X", syms, "2026-11-25", { part: p, mark: "<<M>>" });
    assert.ok(t.indexOf("DOSSIER-X") < t.indexOf("<<M>>") && t.indexOf("<<M>>") < t.indexOf("Return ONLY"), d + p);
    const pre = (q) => C4.deskPrompt(d, "DOSSIER-X", syms, "2026-11-25", { part: q, mark: "<<M>>" }).split("<<M>>")[0];
    assert.equal(pre(parts[0]), pre(parts[1]), "both halves share the cached prefix");
  }
  const ev = C4.mergeParts("events", [{ events: [{ date: "2027-01-10", event: "a" }], horizons: { "1M": { pick: "AAA" } } }, { events: [{ date: "2026-12-01", event: "b" }], months: [{ month: "2026-12" }], horizons: { "12M": { pick: "BBB" } }, pick: "BBB", why: "w" }]);
  const ce = C4.cleanDesk("events", ev, syms);
  assert.deepEqual(ce.events.map((e) => e.event), ["b", "a"]); assert.equal(ce.horizons["1M"].pick, "AAA"); assert.equal(ce.horizons["12M"].pick, "BBB"); assert.equal(ce.pick, "BBB");
  const mc = C4.cleanDesk("macro", C4.mergeParts("macro", [{ regime: "r", pick: "AAA", why: "y", indicators: [{ label: "CPI" }] }, { world: [{ situation: "Iran" }], trade: [{ country: "China" }] }]), syms);
  assert.ok(mc.regime === "r" && mc.pick === "AAA" && mc.world.length === 1 && mc.trade.length === 1 && mc.indicators.length === 1);
  assert.equal(C4.mergeParts("macro", [null, { world: [] }]).world.length, 0, "one half failing still gives the other");
  console.log("desk halves ok");
}
