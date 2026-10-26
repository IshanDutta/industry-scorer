// Tests for the lead strategist: dossier from every report, prompts, review merge, critic.
const assert = require("assert");
const B = require("./brain.js");

const doc = { name: "Semiconductors", summary: { n_constituents: 3, total_market_cap: 5e12, top1_weight: 0.6, top5_weight: 1, excess_cw_1Y: 0.2, beta: 1.4 },
  fund: { rev_growth: 0.3, pe: 38, pe_hist_median: 25, pe_vs_hist: 0.52, op_margin: 0.35 },
  constituents: [{ symbol: "NVDA", name: "NVIDIA", weight: 0.6 }, { symbol: "AMD", name: "AMD", weight: 0.3 }, { symbol: "MU", name: "Micron", weight: 0.1 }] };
const idx = { N1: { id: "N1", title: "NVDA beats", url: "u1", date: "2026-10-01" }, G4: { id: "G4", title: "Oil jumps on Iran strike", url: "u2" }, RA2: { id: "RA2", title: "BIS tightens 3A090", url: "u3" }, I3: { id: "I3", title: "10Y 4.6%" } };
const ctx = {
  today: "2026-10-21", pack: { items: [{ id: "N1", kind: "N", date: "2026-10-01", source: "x", symbol: "NVDA", title: "NVDA beats" }], analyst: [{ symbol: "NVDA", consensus: "Buy", buy: 40, hold: 5, sell: 1, target: 210, upside: 0.15 }] },
  scores: { profiles: { growth: { base: 72 } }, pillars: { growth: 80 } }, idx, macroRows: [{ id: "I3", label: "10-year Treasury", value: 4.6, unit: "%", chg_1m: 6 }],
  books: [{ body: "BIS", book: { rules: [{ severity: "high", name: "3A090 controls", status: "in_force", industry_impact: "Caps China sales [RA2].", bottom_line: "Licensing sets the ceiling.", next_12_months: { events: [{ date: "2027-01", event: "Annual review" }] } }] } }, { body: "MOFCOM", book: null }],
  regVerdict: { stance: "headwind", intensity: "high", headline: "Export controls dominate", summary: "s", most_material: [{ rule: "3A090", body: "BIS" }], winners: [], losers: [{ symbol: "NVDA" }] },
  reports: {
    kpi: { cycle_position: "expansion", cycle_text: "Orders rising", summary: "AI demand", demand_metrics: [{ name: "DC revenue", value: "+100%", evidence: ["N1"] }], profitability_metrics: [], demand_drivers: [], supply_drivers: [], hot_segments: [], cool_segments: [], management_signals: [], next_triggers: [] },
    macro: { regime: "RESTRICTIVE", confidence: "medium", headline: "Yields up on oil", summary: "x", horizons: { "1M": { call: "RESTRICTIVE", text: "t" } }, channels: { capital: { text: "c" } }, flip: [], indicators: { I3: { relevance: "high", effect: "headwind", driver: "Oil-driven inflation fears lifted yields [G4].", why_it_matters: "Discount rate" } } },
    world: { dives: [{ title: "Iran conflict", stance: "adverse", status: "escalating", summary: "Oil up", now: "n", trigger: "t", channels: { cost: [{ name: "Energy", direction: "up", magnitude: "+5%" }] }, fs_impact: [], scenarios: [{ name: "Escalation", probability: 30, outcome: "o", earnings: "-5%" }], winners: [], losers: [{ symbol: "MU" }], developments: [{ evidence: ["G4"] }] }] },
    trade: { verdict: { rating: "strained", health: { score: 41 }, headline: "Taiwan chokepoint", summary: "s", bottlenecks: [{ chokepoint: "Advanced foundry", countries: ["Taiwan"], severity: "critical" }], investment_read: { pass_through: "partial", derate_risk: "medium", text: "t" }, most_exposed: [{ symbol: "AMD", why: "TSMC" }], most_resilient: [] }, map: { countries: [{ rank: 1, country: "Taiwan", importance: "existential", stance: "allied", trajectory: "volatile", roles: ["manufacturing hub"] }] } },
    reg: { summary: "Export controls", policy: [], litigation: [], deals: [], perception: { summary: "bullish", trend: "improving" } },
  },
};

const dz = B.dossier(doc, ctx);
for (const needle of ["QUANT", "P/E 38.0 vs 5Y median 25.0", "NVDA: Buy", "INDUSTRY KPI ANALYST", "Regime RESTRICTIVE", "[I3] 10-year Treasury 4.6% (1M 6.0%): high relevance, headwind. Oil-driven inflation fears lifted yields [G4].",
  "Iran conflict — adverse", "Scenarios: Escalation 30%", "Supply chain strained (health 41/100)", "Advanced foundry (Taiwan, critical)", "REGULATORY RULE BOOKS", "[high] 3A090 controls", "MOFCOM: rule book could not be built", "Regulatory verdict: headwind (high)", "SOURCE INDEX", "[G4]  ·  — Oil jumps on Iran strike", "[RA2]"])
  assert(dz.includes(needle), "dossier missing: " + needle + "\n" + dz);
assert(!dz.includes("undefined") && !dz.includes("[object Object]"), dz);

const p1 = B.synthesisPrompt(doc, { ...ctx, dossier: dz }), p2 = B.verdictsPrompt(doc, { ...ctx, dossier: dz }, { headline: "h" }), p3 = B.reviewPrompt(doc, { ...ctx, dossier: dz }, { headline: "h" });
for (const p of [p1, p2, p3]) { assert(p.includes("REGULATORY RULE BOOKS") && p.includes("Reply with ONLY")); assert(!p.includes("undefined")); }
assert(p1.includes("scenarios") && p1.includes("debates") && p2.includes("overlay") && p3.includes("revisions"));

// review merge: only allowed fields, partial objects merged
const draft = { headline: "Old", thesis: "t", profiles: { growth: { verdict: "g" }, income: { verdict: "i" } }, scenarios: { bull: { probability: 30 } } };
const { merged, applied, issues } = B.applyReview(draft, { issues: [{ field: "headline", problem: "Ignores the high-severity BIS rule", severity: "high" }], revisions: { headline: "New", profiles: { growth: { verdict: "g2" } }, evil: "x" } });
assert.strictEqual(merged.headline, "New"); assert.strictEqual(merged.profiles.growth.verdict, "g2"); assert.strictEqual(merged.profiles.income.verdict, "i"); assert(!("evil" in merged));
assert.deepStrictEqual(applied, ["headline", "profiles"]); assert.strictEqual(issues[0].severity, "high");

// critic
const raw = { headline: "Strong demand vs export controls [N1] [Z9]", thesis: "AI demand [N1] meets BIS limits [RA2] and oil [G4] [FAKE1].", confidence: "high",
  drivers: [{ title: "AI capex", direction: "Tailwind", magnitude: "high", horizon: "3-12M", text: "DC revenue doubled [N1].", sections: ["kpi", "bogus"] }, { title: "", text: "x" }],
  debates: [{ question: "Is AI demand durable?", bull: "Orders [N1]", bear: "Rules [RA2]", lean: "Bull" }],
  scenarios: { bull: { probability: 30, narrative: "n" }, base: { probability: 30, narrative: "n" }, bear: { probability: 20, narrative: "n" } },
  profiles: { growth: { verdict: "Good fit [N1]", overlay: 8, fit: "Strong", conviction: "medium" }, income: { verdict: "Poor", overlay: -20 } },
  dimensions: { macro: { score: -2, summary: "s", evidence: ["G4"] }, regulatory: { score: -2, summary: "s", evidence: ["RA2"], bodies: ["BIS"] }, news: { score: 2, evidence: ["Z1"] } },
  catalysts: ["Earnings Nov 19 [N1]"], risks: ["Rules [RA2] [QQ1]"] };
const r = B.critic(raw, idx, doc, []);
assert.strictEqual(r.headline, "Strong demand vs export controls [N1]");
assert.strictEqual(r.thesis, "AI demand [N1] meets BIS limits [RA2] and oil [G4].");
assert.strictEqual(r.drivers.length, 1); assert.deepStrictEqual(r.drivers[0].sections, ["kpi"]); assert.strictEqual(r.drivers[0].direction, "tailwind");
assert.strictEqual(r.debates[0].lean, "bull");
assert.strictEqual(r.scenarios.bull.probability + r.scenarios.base.probability + r.scenarios.bear.probability, 100);
assert.strictEqual(r.dimensions.news.score, 0, "unsupported dimension neutral");
assert.strictEqual(r.dimensions.regulatory.score, -2); assert.deepStrictEqual(r.dimensions.regulatory.bodies, [{ name: "BIS", why: "" }]);
assert(Math.abs(r.overlay.income) <= 10 && r.overlay.growth > 0 && r.overlay.growth < 8, JSON.stringify(r.overlay));
assert.strictEqual(r.profiles.growth.fit, "strong");
assert.deepStrictEqual(r.risks[0].refs.map((x) => x.id), ["RA2"]);
assert(r.dropped >= 3);
console.log("brain tests passed");

// ---- scenarios across every section, scenario math, opportunity call, investor section reads
{
  const ps = B.scenarioPrompt(doc, { ...ctx, dossier: dz }, { headline: "h", thesis: "t" });
  for (const k of B.SCN_KEYS) assert(ps.includes(`"${k}"`), "scenario prompt names section " + k);
  assert(ps.includes("CODE FACTS: The scenario math starts from the trailing P/E of 38.0") && ps.includes('"opportunity"') && !ps.includes("undefined"));
  const sec = Object.fromEntries(B.SCN_KEYS.map((k) => [k, `${k} read [N1]`]));
  const raw2 = { headline: "h", scenarios: { bull: { probability: 20, narrative: "n", sections: sec, eps_change: [5, 0], pe: [40, 44], price_move: [20, 30] }, base: { probability: 50, narrative: "n", sections: { kpi: "x" }, eps_change: [-3, -8], pe: [36, 40], price_move: [0, 10] }, bear: { probability: 30, narrative: "n", sections: sec, eps_change: [-30, -15], pe: [25, 28], price_move: [-35, -25] } },
    opportunity: { verdict: "Yes", headline: "Buy the dip", why: "w", entry_triggers: ["NVDA Nov 18"], best_expressions: [{ symbol: "NVDA", why: "x" }, { symbol: "ZZZZ", why: "y" }], avoid: [{ symbol: "MU", why: "memory" }] },
    profiles: { growth: { verdict: "v", section_reads: { kpi: "k" } } } };
  const c = B.critic(raw2, idx, doc, []);
  assert.deepStrictEqual(c.scenarios.bull.eps_change, [0, 5], "ranges sorted");
  assert.strictEqual(c.math.expected_return, -1.5); assert.strictEqual(c.math.prob_loss, 30); assert.strictEqual(c.math.code_verdict, "no clear edge");
  assert(c.math.checks.find((x) => x.scenario === "bull").implied !== null);
  assert.strictEqual(c.opportunity.verdict, "yes"); assert.strictEqual(c.opportunity.consistent, false, "a 'yes' with a negative expected return is flagged");
  assert.deepStrictEqual(c.opportunity.best_expressions.map((x) => x.symbol), ["NVDA"], "tickers only from the industry");
  assert(c.gaps.some((g) => g.startsWith("base scenario lacks macro")) && c.gaps.some((g) => g.startsWith("growth verdict lacks macro")), JSON.stringify(c.gaps));
  assert.strictEqual(c.scenarios.bull.sections.kpi, "kpi read [N1]");
  const r3 = B.applyReview(raw2, { revisions: { scenarios: { base: { sections: sec } }, opportunity: { verdict: "no" } } }).merged;
  assert.strictEqual(r3.scenarios.base.probability, 50, "partial scenario revision keeps the rest"); assert.strictEqual(r3.opportunity.headline, "Buy the dip"); assert.strictEqual(r3.opportunity.verdict, "no");
  const rv = B.reviewPrompt(doc, { ...ctx, dossier: dz, math: c.math, gaps: c.gaps }, raw2);
  assert(rv.includes("CODE-COMPUTED SCENARIO MATH") && rv.includes("COVERAGE GAPS FOUND BY CODE") && rv.includes("INCONSISTENT") === c.math.checks.some((x) => x.ok === false));
  console.log("brain scenario tests passed");
}

// ---- 1M / 3M / 6M / 12M calls: calendar of decisions, wars and threats from every section
{
  const H = require("./horizon.js");
  const levels = Array.from({ length: 260 }, (_, i) => 100 * Math.exp(0.02 * Math.sin(i) + 0.001 * i));
  const d2 = { ...doc, as_of: "2026-10-23", index: { dates: levels.map((_, i) => "d" + i), levels },
    summary: { ...doc.summary, ret_cw_1M: -0.137, excess_cw_1M: -0.116, breadth_1M: 0.1, ret_cw_3M: 0.05, ret_cw_6M: 0.12, ret_cw_1Y: 0.4, excess_cw_1Y: 0.2 },
    constituents: [{ symbol: "NVDA", weight: 0.6, next: "2026-11-18" }, { symbol: "AMD", weight: 0.3, next: "2027-02-03" }, { symbol: "MU", weight: 0.1, next: "2026-12-17" }] };
  const today = "2026-10-25";
  const f = H.horizonFacts(d2, today);
  assert.strictEqual(f[0].trailing, -13.7); assert.deepStrictEqual(f[0].reporting.map((x) => x.symbol), ["NVDA"]); assert.strictEqual(f[0].reporting_weight, 60);
  assert(f[0].sigma > 0 && Math.abs(f[3].sigma / f[0].sigma - Math.sqrt(12)) < 0.05, "sigma scales with sqrt(time)");
  assert.strictEqual(H.windowOf("2026-11-10", today), "1M"); assert.strictEqual(H.windowOf("2027-01", today), "3M"); assert.strictEqual(H.windowOf("2027-12-01", today), "later"); assert.strictEqual(H.windowOf("2026-10-01", today), null);
  // economic calendar: series grouped, central-bank decisions and elections kept, noise dropped
  const econ = H.econEvents([
    { date: "2026-10-28 18:00:00", country: "US", event: "Fed Interest Rate Decision", impact: "High" }, { date: "2026-12-09 19:00:00", country: "US", event: "Fed Interest Rate Decision", impact: "High" },
    { date: "2026-10-28 18:00:00", country: "US", event: "Interest Rate Projection - 1st Yr", impact: "Low" }, { date: "2026-10-28 18:30:00", country: "US", event: "Press Conference", impact: "High" },
    { date: "2026-11-12 13:30:00", country: "US", event: "CPI (Oct)", impact: "High" }, { date: "2026-11-04 03:00:00", country: "JP", event: "BoJ Interest Rate Decision", impact: "High" },
    { date: "2026-11-20", country: "TW", event: "Taiwan Local Elections", impact: "Medium" }, { date: "2026-11-05", country: "DE", event: "Factory Orders MoM", impact: "Medium" }], today, { tradeCountries: ["TW"] });
  const fed = econ.find((e) => /Fed Interest Rate Decision/.test(e.event));
  assert.deepStrictEqual(fed.dates, ["2026-10-28", "2026-12-09"]); assert.strictEqual(fed.importance, "high"); assert.strictEqual(fed.kind, "decision");
  assert(econ.some((e) => /Elections/.test(e.event) && e.importance === "high")); assert(econ.some((e) => e.event === "CPI" && e.importance === "medium"));
  assert(!econ.some((e) => /Projection|Press Conference|Factory/.test(e.event)), JSON.stringify(econ));
  assert.deepStrictEqual(H.calendarCountries({ countries: [{ country: "Taiwan" }, { country: "China" }, { country: "Netherlands" }] }), ["US", "EU", "CN", "JP", "GB", "TW", "NL"]);
  const reports = { ...ctx.reports,
    kpi: { ...ctx.reports.kpi, next_triggers: [{ date: "2026-11-18", event: "NVDA Q3 results", why: "DSO", names: ["NVDA"] }] },
    macro: { ...ctx.reports.macro, watch_next: [{ date: "2026-11-07", event: "Jobs report", why: "Rates" }] },
    world: { dives: [{ ...ctx.reports.world.dives[0], title: "Iran conflict", category: "conflict", status: "escalating", stance: "adverse", near_term: "Strikes likely continue", developments: [{ evidence: ["G4"] }] }, { title: "EU AI Act", category: "policy", status: "negotiating", stance: "mixed", scenarios: [], developments: [] }] },
    trade: { ...ctx.reports.trade, map: { countries: [{ rank: 1, country: "Taiwan", importance: "existential", stance: "allied", trajectory: "volatile", roles: ["manufacturing hub"], threat: "high", threat_note: "PLA drills" }, { rank: 2, country: "Japan", importance: "high", threat: "none", roles: [] }] },
      countries: [{ country: "Taiwan", security: { threat_level: "high", threat: "China threatens to blockade or invade Taiwan", status: "Live-fire drills", industry_impact: "Leading-edge supply halts", evidence: ["G4"] }, risks: [{ risk: "Blockade", type: "military conflict", likelihood: "medium", impact: "high", timing: "12M+", mechanism: "Supply halt", tickers: ["NVDA"] }] }] },
    reg: { ...ctx.reports.reg, policy: [{ title: "Chip tariff decision", status: "pending", date: "2026-12-01", direction: "headwind", impact: "Section 232", evidence: ["RA2"] }], litigation: [{ case: "FTC v. X", status: "trial", stakes: "Breakup", evidence: ["N1"] }], deals: [] } };
  const books = [{ body: "BIS", book: { rules: [{ severity: "high", name: "3A090 controls", status: "in_force", bottom_line: "Licensing caps China", evidence: ["RA2"], next_12_months: { events: [{ date: "2027-01", event: "Annual review", trigger: "Tighter thresholds", evidence: ["RA2"] }] } }] } }];
  const cal = H.buildCalendar(d2, { today, econ, reports, books, regVerdict: ctx.regVerdict });
  const byT = (re) => cal.events.find((e) => re.test(e.title));
  assert.strictEqual(byT(/Fed Interest Rate Decision/).window, "1M"); assert.strictEqual(byT(/NVDA earnings/).importance, "high"); assert(!byT(/NVDA Q3 results/) && byT(/NVDA earnings/).detail.includes("NVDA Q3 results"), "KPI trigger merged into the earnings event"); assert.strictEqual(byT(/BIS: Annual review/).window, "3M");
  assert.strictEqual(byT(/Chip tariff decision/).kind, "decision"); assert(!cal.events.some((e) => /AMD earnings/.test(e.title) && e.window !== "6M"));
  assert(cal.events.every((e, i) => e.id === "C" + (i + 1)) && cal.standing.every((x, i) => x.id === "S" + (i + 1)));
  const sOf = (re) => cal.standing.find((x) => re.test(x.title));
  assert.strictEqual(sOf(/Iran conflict/).kind, "conflict"); assert.strictEqual(sOf(/Iran conflict/).importance, "high");
  assert.strictEqual(sOf(/Taiwan: China threatens/).kind, "threat"); assert.strictEqual(sOf(/Taiwan: China threatens/).importance, "high");
  assert(sOf(/Taiwan: Blockade/) && sOf(/3A090/) && sOf(/FTC v. X/) && sOf(/Macro regime RESTRICTIVE/) && sOf(/EU AI Act/).importance === "medium");
  const req1 = H.required(cal, "1M"), req12 = H.required(cal, "12M");
  assert(req1.events.includes(byT(/Fed Interest/).id) && req1.events.includes(byT(/NVDA earnings/).id) && !req1.events.includes(byT(/BIS: Annual/).id));
  assert(req12.events.includes(byT(/BIS: Annual/).id) && req12.standing.includes(sOf(/Iran conflict/).id) && req12.standing.includes(sOf(/Taiwan: China/).id));
  const ct = H.calendarText(cal);
  assert(ct.includes("Within 1 month") && ct.includes("2026-10-28, 2026-12-09") && ct.includes("STANDING SITUATIONS") && ct.includes("China threatens to blockade") && !ct.includes("undefined"), ct);
  // the prompt names every section, the required IDs and the calendar
  const hp = B.horizonPrompt(d2, { ...ctx, today, dossier: dz, calendar: cal, math: { expected_return: -1.5, upside: 25, downside: -30, prob_loss: 30 } }, { headline: "h", scenarios: {} });
  for (const k of B.SCN_KEYS) assert(hp.includes(`"${k}"`), "horizon prompt names section " + k);
  assert(hp.includes("DATED CALENDAR") && hp.includes(`1M: ${req1.events.join(", ")}`) && hp.includes(req12.standing.join(", ")) && hp.includes("war, armed conflict, invasion") && hp.includes("HORIZON FACTS") && !hp.includes("undefined"));
  // parsing and checks: coverage of decisions, conflicts and sections; numbers
  idx[byT(/Fed Interest/).id] = { id: byT(/Fed Interest/).id, title: "Fed" };
  const fedId = byT(/Fed Interest/).id, nvdaId = byT(/NVDA earnings/).id, iran = sOf(/Iran conflict/).id;
  const reads = Object.fromEntries(B.SCN_KEYS.map((k) => [k, k + " this month [N1]"]));
  const raw = { scenarios: { bull: { probability: 20, price_move: [20, 30] }, base: { probability: 50, price_move: [0, 10] }, bear: { probability: 30, price_move: [-35, -25] } },
    horizons: { "1M": { call: "Bearish", expected_move: [2, -8], probability_up: 35, drivers: `FOMC [${fedId}] and NVDA [N1].`, section_reads: reads,
        decisions: [{ refs: [fedId, "C999"], date: "2026-10-28", event: "FOMC", outcomes: "Hold lifts yields", lean: "Negative" }, { refs: [nvdaId], event: "NVDA earnings", outcomes: "DSO" }, { refs: [byT(/Elections/).id], event: "Taiwan local elections", outcomes: "x" }],
        conflicts: req12.standing.map((id) => ({ refs: [id, "S999"], situation: "x", in_window: "Status quo 70%", impact: "y" })), sections: ["performance", "macro", "bogus"] },
      "3M": { call: "bullish", expected_move: [-10, -2], probability_up: 40, section_reads: { kpi: "k" }, decisions: [], conflicts: [] }, "12M": { call: "bullish", expected_move: [15, 25], probability_up: 60 } } };
  const c = B.critic(raw, idx, d2, [], today, cal);
  const h1 = c.horizons["1M"];
  assert.deepStrictEqual(h1.expected_move, [-8, 2]); assert.strictEqual(h1.call, "bearish"); assert.deepStrictEqual(h1.sections, ["performance", "macro"]);
  assert.deepStrictEqual(h1.decisions[0].refs, [fedId], "unknown C-IDs dropped"); assert.strictEqual(h1.decisions[0].lean, "negative");
  assert(h1.drivers.includes(`[${fedId}]`), "calendar IDs survive citation cleaning when indexed"); assert.strictEqual(Object.keys(h1.section_reads).length, 10);
  const ck = Object.fromEntries(c.horizon_checks.map((x) => [x.h, x]));
  assert.strictEqual(ck["1M"].ok, true, JSON.stringify(ck["1M"])); assert.strictEqual(ck["1M"].covered, true, JSON.stringify(ck["1M"]));
  assert(!ck["3M"].ok && ck["3M"].missing_standing.includes(iran) && ck["3M"].missing_sections.length === 9 && ck["3M"].missing_events.includes(fedId));
  assert(ck["12M"].issues.some((i) => i.includes("scenarios imply -1.5%")), JSON.stringify(ck["12M"]));
  assert(c.gaps.includes("no 6M call") && c.gaps.some((g) => g.startsWith("3M call skips wars/conflicts/situations")) && c.gaps.some((g) => g.startsWith("3M call skips decisions/events")), JSON.stringify(c.gaps));
  const rv = B.reviewPrompt(d2, { ...ctx, dossier: dz, hchecks: c.horizon_checks, calendar: cal }, raw);
  assert(rv.includes("HORIZON CHECKS BY CODE") && rv.includes("6M: MISSING") && rv.includes(`skips wars/conflicts/situations`) && rv.includes("DATED CALENDAR") && rv.includes("horizons, opportunity"));
  const m2 = B.applyReview(raw, { revisions: { horizons: { "6M": { call: "neutral", expected_move: [-5, 5] } } } }).merged;
  assert(m2.horizons["1M"] && m2.horizons["6M"].call === "neutral", "horizon revision merges");
  assert(!B.scenarioPrompt(d2, { ...ctx, today, dossier: dz }, { headline: "h" }).includes('"horizons"'), "scenarios no longer carry the horizons");
  console.log("brain horizon tests passed");
}

// ---- forward basis, new dossier sections (estimates, priced in, cycle, sensitivities, positioning, track record)
{
  const F = require("./forward.js"), Sn = require("./sensitivity.js"), P = require("./positioning.js");
  const d3 = { ...doc, forward: { n: 3, coverage: 0.9, fwd_pe: 25, ntm_eps_growth: 0.3, fy1_rev_growth: 0.2, fy1_eps_growth: 0.25, peg: 0.83, dispersion: 0.3, analysts_median: 40, sources: ["EODHD"],
      has_revisions: true, rev30: 0.02, rev90: 0.08, rev30_median: 0.01, rev90_median: 0.05, up30: 30, down30: 5, breadth: 0.71, share_rising: 0.8, top_up: [{ symbol: "NVDA", rev30: 0.04 }], top_down: [], excluded: [{ symbol: "TSM", why: "currency" }] },
    priced_in: F.pricedIn({ y10: 0.045, erp: 0.05, beta: 1.4, fund: { fcf_margin: 0.25, ps: 15 }, fwd: { fwd_pe: 25, ntm_eps_growth: 0.3 }, hist: { cagr: 0.18 } }),
    fund: { ...doc.fund, cycle: [{ q: "2026-Q2", inv_days: 120, dso: 50, capex_rev: 0.08, rev_yoy: 0.3, nd_ebitda: 0.2 }, { q: "2026-Q3", inv_days: 130, dso: 60, capex_rev: 0.09, rev_yoy: 0.25, nd_ebitda: 0.3 }], inv_days_yoy: 0.12, dso_yoy: 0.2, fcf_conv: 0.8, sbc_rev: 0.05, share_change: 0.01, buyback_yield: 0.01 },
    sensitivity: { n: 250, from: "2025-10-01", to: "2026-10-23", r2: 0.7, factors: [{ key: "rates", shock_label: "+0.25pp 10-year yield", total: { effect: -0.012, t: -3 }, partial: { effect: -0.008, t: -2.1 }, stable: true }] },
    positioning: P.aggregate([], { vs50: 0.05, vs200: 0.2, rsi14: 72, from_high: -0.02, vol20: 0.3, vol252: 0.35 }) };
  const dz3 = B.dossier(d3, { ...ctx, track: "YOUR TRACK RECORD ON THIS INDUSTRY: 2 matured" });
  for (const needle of ["FORWARD ESTIMATES AND REVISIONS", "Forward P/E 25.0", "2.0% over 30 days", "30 analyst revisions up vs 5 down", "WHAT'S PRICED IN", "Cost of equity 11.5%", "BALANCE-SHEET CYCLE", "2026-Q3: inventory 130d, DSO 60d", "inventory days 12.0%", "MEASURED MACRO SENSITIVITIES", "+0.25pp 10-year yield: industry -1.2%", "POSITIONING", "crowded", "TRACK RECORD", "TSM (currency)"])
    assert(dz3.includes(needle), "dossier missing: " + needle);
  assert(!dz3.includes("undefined") && !dz3.includes("[object Object]"));
  assert.deepStrictEqual(B.basePE(d3), { pe: 25, basis: "forward" });
  assert.strictEqual(B.basePE({ ...d3, forward: { ...d3.forward, coverage: 0.3 } }).basis, "trailing");
  const ps3 = B.scenarioPrompt(d3, { ...ctx, dossier: dz3 }, { headline: "h" });
  assert(ps3.includes("starts from the forward P/E of 25.0") && ps3.includes("vs today's consensus") && ps3.includes("÷ 25.0"));
  const c3 = B.critic({ scenarios: { bull: { probability: 30, eps_change: [5, 5], pe: [30, 30], price_move: [26, 26] }, base: { probability: 70, eps_change: [0, 0], pe: [25, 25], price_move: [0, 0] } } }, idx, d3, [], "2026-10-25");
  assert.strictEqual(c3.math.pe_basis, "forward"); assert(Math.abs(c3.math.checks[0].implied - 26) < 0.01, JSON.stringify(c3.math.checks));
  console.log("brain forward-basis tests passed");
}

// ---- red team, plans, new dossier sections
{
  const draftPos = { headline: "Buy", opportunity: { verdict: "yes" }, scenarios: { bull: { probability: 40 }, bear: { probability: 20 } }, profiles: { growth: { fit: "strong", verdict: "v" } } };
  assert.strictEqual(B.draftStance(draftPos), "constructive"); assert.strictEqual(B.draftStance({ opportunity: { verdict: "no" } }), "negative");
  const rp = B.redTeamPrompt(doc, { ...ctx, dossier: dz, math: { expected_return: 5, prob_loss: 30 } }, draftPos);
  assert(rp.includes("independent short seller") && rp.includes("Pre-mortem") && rp.includes('"stance": "short"') && !rp.includes("undefined"));
  assert(B.redTeamPrompt(doc, { ...ctx, dossier: dz }, { opportunity: { verdict: "no" } }).includes("independent long-only investor"));
  const raw = { ...draftPos, redteam: { stance: "short", thesis: "Capex peaks [G4] [ZZ1].", arguments: [{ claim: "Customers cut capex", evidence: "capex decel [N1]", draft_says: "capex holds", severity: "HIGH" }, { claim: "" }], premortem: [{ what_happened: "Hyperscalers cut", probability: 140, early_warning: "Q4 guides" }], blind_spots: ["inventory"], kill_criteria: ["capex < $1T"] },
    redteam_responses: [{ n: 1, verdict: "Partly", why: "Capex decel is real but small", change: "trimmed bull prob" }, { n: 0, why: "x" }],
    profiles: { growth: { fit: "strong", conviction: "high", verdict: "v" }, income: { fit: "weak", conviction: "low", verdict: "v" } } };
  const d4 = { ...doc, summary: { ...doc.summary, vol_1y: 0.4, beta: 1.4 }, positioning: { label: "crowded" }, plan: { index_levels: { last: 100, sma50: 95, stop_1m: 90 } } };
  const c = B.critic(raw, idx, d4, [], "2026-10-25", { events: [{ id: "C1", importance: "high", window: "1M", title: "US Fed Interest Rate Decision", dates: ["2026-10-28"] }], standing: [] });
  assert.strictEqual(c.redteam.arguments.length, 1); assert.strictEqual(c.redteam.arguments[0].severity, "high"); assert.strictEqual(c.redteam.premortem[0].probability, 100);
  assert(c.redteam.thesis.includes("[G4]") && !c.redteam.thesis.includes("ZZ1"));
  assert.deepStrictEqual(c.redteam_responses.map((x) => [x.n, x.verdict]), [[1, "partly"]]);
  assert(c.plans.growth.size > c.plans.income.size && /Scale in/.test(c.plans.growth.entry) && c.plans.growth.stop_pct < 0);
  const rv = B.reviewPrompt(doc, { ...ctx, dossier: dz, redteam: c.redteam }, raw);
  assert(rv.includes("RED TEAM") && rv.includes("Argument 1 [high]") && rv.includes("redteam_responses"));
  assert.deepStrictEqual(B.applyReview(raw, { redteam_responses: [{ n: 1, verdict: "accepted" }] }).merged.redteam_responses, [{ n: 1, verdict: "accepted" }]);
  const d5 = { ...doc, ranking: { rows: [{ symbol: "NVDA", composite: 80, factors: {} }], best: { composite: ["NVDA"], growth: ["NVDA"] }, worst: ["MU"] }, concentration: { top3: ["NVDA", "AMD", "MU"], top3_weight: 1, effective_n: 2.1, dispersion_1y: 0.3 }, credit: { weak: [], weak_weight: 0 } };
  const dz5 = B.dossier(d5, { ...ctx, reports: { ...ctx.reports, chain: { partners: [{ symbol: "MSFT", name: "Microsoft", role: "customer", depends: ["NVDA"], why: "GPUs", evidence: [] }], aggregate: {} }, calls: { summary: { direction: "improving", text: "t" }, companies: [{ symbol: "NVDA", id: "T1", period: "Q3", prev_period: "Q2", tone: "more confident", tone_why: "w", guidance: "raised", new_topics: [], dropped_topics: [], new_risks: [] }] } } });
  for (const needle of ["COMPANIES, CONCENTRATION", "Best overall: NVDA", "VALUE CHAIN", "MSFT Microsoft", "EARNINGS CALLS: WHAT CHANGED", "NVDA Q2 → Q3"]) assert(dz5.includes(needle), "dossier missing " + needle);
  console.log("brain red-team tests passed");
}
