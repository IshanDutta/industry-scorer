const D = require("./daily.js"); const zlib = require("zlib"), fs = require("fs");
let fails = 0; const ok = (c, m) => { console.log(c ? "ok  " : "FAIL", m); if (!c) fails++; };
const file = process.argv[2] || "/tmp/claude-0/-home-claude/e2f2e0a5-0e53-566e-aafe-723d47ac4ff7/scratchpad/latest/consumer-defensive.slim.json.gz";
const recs = JSON.parse(zlib.gunzipSync(fs.readFileSync(file))).records, rec = Object.entries(recs).find(([k]) => k.startsWith("run:"))[1];
const prev = D.prevState(rec);
ok(prev.as_of && Object.keys(prev.cons).length > 5 && prev.items.length > 10, `prev state (as of ${prev.as_of})`);
// Tomorrow: the index up 3%, the top company up 9%, two new headlines, a macro move.
const doc = JSON.parse(JSON.stringify(rec.industry)); const last = doc.index.dates[doc.index.dates.length - 1];
const nd = "2026-10-28"; doc.index.dates.push(nd); doc.index.levels.push(doc.index.levels[doc.index.levels.length - 1] * 1.03);
doc.constituents[0].px = doc.constituents[0].px * 1.09;
const pack = { ...rec.research, items: [{ id: "N999", kind: "N", date: nd, source: "wsj.com", title: "Big beverage merger announced", url: "https://x" }, ...rec.research.items] };
const rows = rec.macro.rows.map((r, i) => (i === 0 ? { ...r, value: r.value + 0.2 } : r));
const x = D.deltas(prev, { doc, pack, world: rec.world, macroRows: rows, calendar: rec.agent.calendar, relevance: { [rows[0].id]: "high" } }, nd);
ok(x.since === last && x.days === 1 && Math.abs(x.move - 0.03) < 1e-9, `move since ${x.since}: ${(x.move * 100).toFixed(1)}% over ${x.days} day`);
ok(x.news.length === 1 && x.news[0].id === "D1", "only the new headline is listed, as D1");
ok(x.macro.length === 1 && x.macro[0].id === rows[0].id, "the macro move is caught " + JSON.stringify(x.macro.map((m) => [m.id, m.change])));
ok(x.triggers.some((t) => /times its normal move/.test(t)) && x.triggers.some((t) => /moved \+9/.test(t)), "triggers: big industry move and a top company's jump");
const txt = D.deltaText(x); ok(/\[D1\]/.test(txt) && /Biggest contributors/.test(txt), "delta text");
const res = rec.agent.result;
ok(D.triagePrompt("Beverages", res, x, nd).length < 20000, "triage prompt is short (" + D.triagePrompt("Beverages", res, x, nd).length + " chars)");
const up = D.updatePrompt("Beverages", res, x, nd, res.horizon_facts); ok(up.includes("WHAT CHANGED") && up.includes("YOUR WHOLE ANALYSIS NOW") && up.length < 60000, "update prompt (" + up.length + " chars)");
const upd = { material: true, headline: "A merger lifts the group [D1].", summary: "Bigger than expected [D1][Z9].", changes: [{ text: "Deal premium [D1]", effect: "positive" }],
  horizons: { "1M": { status: "revised", call: "bullish", conviction: "medium", expected_move: [0, 6], probability_up: 60, why: "Merger [D1]" }, "3M": { status: "unchanged", why: "Holds" } }, scenario_probabilities: { bull: 35, base: 45, bear: 20 }, watch: ["Deal terms"] };
const a = D.apply(res, upd, x, { today: nd, via: "update", sources: x.news });
ok(a.changed && a.result.horizons["1M"].call === "bullish" && a.result.horizons["1M"].daily.from.call === res.horizons["1M"].call, "1M revised, with where it came from");
ok(a.result.horizons["3M"].call === res.horizons["3M"].call && !a.result.horizons["3M"].daily, "3M left exactly as it was");
ok(a.result.daily.summary.includes("[D1]") && !a.result.daily.summary.includes("Z9"), "unknown citations dropped");
ok(a.result.scenarios.bull.probability === 35 && a.result.daily.horizons._scenarios, "scenario probabilities updated and recorded");
ok(a.result.daily.sources.length === 1 && a.result.daily_history.length === 1, "sources and history");
const b = D.apply(a.result, null, x, { today: "2026-10-29", via: "triage", tri: { why: "Routine day." } });
ok(!b.changed && b.result.daily.headline === "Routine day." && b.result.daily_history.length === 2 && b.result.horizons["1M"].call === "bullish", "a quiet day stamps the calls and keeps them");
// Sections: the brief, the quick model's picks (cited, cooled down), and code's earnings pick.
const rr = (k) => Object.entries(recs).find(([kk]) => kk.startsWith("run:"))[1].reports?.[Object.keys(rec.reports || {}).find((z) => z.endsWith("--" + k))]?.result;
const brief = D.sectionBrief({ kpi: rr("kpi"), world: rr("world"), trade: rr("trade"), reg: rr("reg"), chain: rr("chain"), bodies: ["FDA", "FTC"] });
ok(/KPIs:/.test(brief) && /Regulators with rule books: FDA; FTC/.test(brief) && brief.length < 6000, `section brief (${brief.length} chars)`);
const tp = D.triagePrompt("Beverages", res, x, nd, brief); ok(/"sections"/.test(tp) && /rulebook/.test(tp) && tp.length < 26000, `triage prompt asks for sections (${tp.length} chars)`);
const tri2 = { material: true, sections: [{ key: "reg", why: "The FTC sued to block the merger [D1]." }, { key: "world", why: "Generic commentary." }, { key: "rulebook", why: "FDA finalized the rule [D1]", regulators: ["FDA"] }, { key: "rulebook", why: "no regulator [D1]" }, { key: "bogus", why: "[D1]" }] };
const xn = { ...x, passed: [] }, picks = D.pickSections(tri2, xn, {}, nd);
const K = picks.map((p) => p.key);
ok(["reg", "world", "rulebook"].every((k) => K.includes(k)) && !K.includes("bogus") && picks.find((p) => p.key === "rulebook").regulators[0] === "FDA", "every section the day touches is picked, commentary included: " + K.join(","));
ok(K.includes("macro") && picks.find((p) => p.key === "macro").by === "code", "a big move in a high-relevance macro row rewrites the macro section by itself");
ok(D.pickSections(tri2, xn, { reg: nd, world: nd }, nd).map((p) => p.key).includes("reg"), "no cool-down: a section rewritten today can be rewritten again");
const xe = { ...x, passed: [{ date: "2026-10-28", kind: "earnings", tickers: ["KO"], title: "KO earnings" }], triggers: ["KO reported (2026-10-28)"] };
ok(D.pickSections(null, xe, { kpi: "2026-10-27" }, nd).map((p) => p.key).includes("kpi"), "a top company's earnings rewrites KPIs, whatever the quick model says");
ok(D.pickSections(null, { ...xn, z: 3, move: 0.08 }, {}, nd).some((p) => p.key === "thesis"), "a move of 3 times normal rewrites the whole analysis");
const c = D.apply(res, upd, x, { today: nd, via: "update", sources: x.news, sections: [{ ...picks.find((p) => p.key === "reg"), ok: true }, { ...picks.find((p) => p.key === "rulebook"), ok: false, error: "no rules came back" }] });
ok(c.result.daily.sections.length === 2 && c.result.sections_rewritten.reg === nd && !c.result.sections_rewritten.rulebook, "sections recorded; only the ones that worked start a cool-down");
ok(D.updatePrompt("Beverages", res, x, nd, res.horizon_facts, "Regulation: the FTC sued [R3].").includes("SECTIONS YOUR TEAM REWROTE TODAY"), "update prompt carries what the rewritten sections say");
// The budget plan: today's share of what's left, the most valuable work first, what doesn't fit waits (and ages).
ok(D.dayBudget(470, 100, "2026-11-04") === Math.round((370 / 27) * 100) / 100 && D.dayBudget(470, 470, "2026-11-30") === 0, "today's share of the month: what's left over the days left");
const cands = [{ industry: "A", key: "thesis", importance: "low", by: "rotation" }, { industry: "B", key: "kpi", importance: "high", by: "code" }, { industry: "C", key: "world", importance: "medium" }, { industry: "D", key: "chain", importance: "low" }, { industry: "E", key: "rulebook", importance: "high", regulators: ["FDA", "FTC", "EPA"] }];
const pl = D.plan(cands, 1.2);
ok(pl.run[0].industry === "B" && pl.run.some((c) => c.industry === "C") && pl.held.some((c) => c.industry === "A") && pl.planned <= 1.2, "earnings first, then what matters most; what doesn't fit waits: ran " + pl.run.map((c) => c.industry + ":" + c.key).join(",") + "; held " + pl.held.map((c) => c.industry + ":" + c.key).join(","));
ok(D.plan(cands, 100).held.length === 0, "a big enough budget runs everything");
const aged = D.pickSections(null, { ...xn, macro: [] }, { pending: [{ key: "chain", why: "a supplier's contract", importance: "low", waited: 2 }] }, nd).find((c) => c.key === "chain");
ok(aged && aged.waited === 3 && D.scoreOf(aged) > D.scoreOf({ ...aged, waited: 0 }), "held work comes back the next day, more urgent each day it waits");
// ---- The whole-analysis update
const xf = D.deltas(prev, { doc, pack, world: rec.world, macroRows: rows, calendar: rec.agent.calendar, relevance: {}, shock: "Midday alarm: SPY -3.1%",
  filings: [{ symbol: doc.constituents[0].symbol, filingDate: nd + " 00:00:00", acceptedDate: nd + " 16:10:00", hasFinancials: true, finalLink: "https://sec.gov/ex99" }, { symbol: "ZZZZ", filingDate: nd, hasFinancials: true, finalLink: "https://sec.gov/other" }] }, nd);
ok(xf.filings.length === 1 && xf.filings[0].id === "D" + (xf.news.length + xf.world.length + 1) && xf.filings[0].fin, "8-Ks: only the industry's own companies, numbered after the headlines");
ok(xf.triggers[0].startsWith("Midday alarm") && xf.triggers.some((t) => t.includes("filed an 8-K")), "the shock and a top company's 8-K are code triggers");
ok(/MARKET SHOCK TODAY/.test(D.deltaText(xf)) && /SEC 8-K/.test(D.deltaText(xf)), "both reach the prompts");
ok(D.pickSections(null, xf, {}, nd).some((c) => c.key === "kpi" && c.by === "code" && c.why.includes("8-K")), "an 8-K with financials from a top company rewrites the KPIs");
const prevF = D.prevState({ ...rec, agent: { ...rec.agent, result: { ...res, daily: { filings: ["https://sec.gov/ex99"] } } } });
ok(D.deltas(prevF, { doc, pack, world: rec.world, macroRows: rows, calendar: rec.agent.calendar, filings: [{ symbol: doc.constituents[0].symbol, filingDate: nd, hasFinancials: true, finalLink: "https://sec.gov/ex99" }] }, nd).filings.length === 0, "a filing already seen isn't news again");
const wp = D.updatePrompt("Beverages", res, xf, nd, res.horizon_facts, "", { pe: 21.4, drift: { move: 0.12, z: 1.4, since: "2026-10-01", updates: 2 } });
ok(wp.includes(JSON.stringify(D.analysisOf(res)).slice(0, 200)) && /SINCE YOUR LAST FULL REWRITE/.test(wp) && /P\/E FOR THE SCENARIO MATH: 21.4/.test(wp) && /"rethink"/.test(wp), "the update reads the whole analysis, the P/E and the drift (" + wp.length + " chars)");
const keepId = (JSON.stringify(D.analysisOf(res)).match(/\[([A-Z]{1,2}\d{1,4})/) || [])[1];
const sk = Object.keys(res.scenarios);
const updW = { material: true, headline: "8-K shows a beat [D" + (xf.news.length + xf.world.length + 1) + "].", summary: "x", changes: [], horizons: { "1M": { status: "unchanged", why: "holds" } },
  analysis: { thesis: "New thesis: the beat changes the earnings path [D" + (xf.news.length + xf.world.length + 1) + "]" + (keepId ? ` and the old point stands [${keepId}]` : "") + " [Q77].",
    drivers: [{ title: "Earnings beat", direction: "tailwind", magnitude: "high", horizon: "0-3M", text: "Results beat [D1]." }, { title: res.drivers[0].title, direction: res.drivers[0].direction, magnitude: "low", horizon: res.drivers[0].horizon, text: res.drivers[0].text }],
    scenarios: Object.fromEntries(sk.map((k, i) => [k, { probability: [40, 40, 30][i] }])).constructor === Object ? { ...Object.fromEntries(sk.map((k, i) => [k, { probability: [40, 40, 30][i] }])), base: { probability: 40, price_move: [2, 9], narrative: "Base: the beat holds [D1]." } } : {},
    opportunity: { verdict: "yes", why: "Better asymmetry now [D1]." }, profiles: { growth: { fit: "strong" } }, bogus: "ignored" },
  rethink: { from_scratch: "different", why: "the beat changes the core story [D1]" } };
const aw = D.apply(res, updW, xf, { today: nd, via: "update", sources: [...xf.news, ...xf.world, ...xf.filings] });
const r3 = aw.result;
ok(r3.thesis.startsWith("New thesis") && /\[DU\d+\]/.test(r3.thesis) && !/\[D\d+\]/.test(r3.thesis) && !r3.thesis.includes("Q77") && (!keepId || r3.thesis.includes(keepId)), "thesis rewritten; today's D-IDs become lasting DU-IDs, its own IDs kept, unknown dropped: " + r3.thesis.slice(0, 160));
ok(aw.refs.length >= 1 && aw.refs.every((r) => /^DU\d+$/.test(r.id) && r.title) && r3.daily_refs.length === aw.refs.length && r3.ref_n === aw.refs.length, "the new IDs come with their sources");
ok(r3.drivers.length === 2 && r3.drivers[0].rank === 1 && r3.drivers[1].sections === res.drivers[0].sections || JSON.stringify(r3.drivers[1].sections) === JSON.stringify(res.drivers[0].sections), "drivers replaced as a list, re-ranked, a kept driver keeps its sections");
const pr = sk.map((k) => r3.scenarios[k].probability);
ok(pr.reduce((a, b) => a + b, 0) === 100 && r3.scenarios.base.price_move.join() === "2,9" && r3.scenarios.base.narrative.startsWith("Base:") && r3.scenarios.base.sections && Object.keys(r3.scenarios.base.sections).length === Object.keys(res.scenarios.base.sections || {}).length, "scenario odds normalized to 100 (" + pr + "), the base case's numbers and story updated, its section reads kept");
ok(r3.opportunity.verdict === "yes" && r3.opportunity.headline === res.opportunity.headline && r3.profiles.growth.fit === "strong" && r3.profiles.growth.verdict === res.profiles.growth.verdict && !("bogus" in r3), "the opportunity and a profile: only what changed");
ok(r3.headline === res.headline && r3.summary === res.summary && JSON.stringify(r3.debates) === JSON.stringify(res.debates), "what the update left out is exactly as it was");
ok(aw.changed && aw.parts.includes("thesis") && aw.parts.includes("drivers") && aw.parts.includes("scenario odds") && r3.daily.analysis.length === aw.parts.length && r3.daily.horizons._scenarios, "the parts that changed are recorded: " + aw.parts.join(", "));
ok(r3.rewrites_since_full === 1 && r3.rethink.same === false && r3.daily.rethink.same === false, "an update is counted, and the rethink kept");
ok(r3.daily.filings.includes("https://sec.gov/ex99"), "filings shown today are remembered");
const aq = D.apply(res, { material: false, headline: "Quiet.", horizons: {}, analysis: {}, rethink: { from_scratch: "same", why: "holds" } }, xf, { today: nd, via: "update", sources: xf.news });
ok(!aq.changed && !aq.parts.length && !aq.result.rewrites_since_full && aq.result.rethink.same === true, "a quiet day changes nothing and isn't counted");
// ---- The drift guard
const dg = D.drift(doc, doc.index.dates[doc.index.dates.length - 30]);
ok(dg && dg.days === 29 && Number.isFinite(dg.z), "drift since the last full rewrite: " + (dg.move * 100).toFixed(1) + "%, " + dg.z.toFixed(2) + " normal moves");
const xq = { ...x, z: 0.2, triggers: [], passed: [], macro: [], filings: [] };
const th = (last) => D.pickSections(null, xq, last, nd).find((c) => c.key === "thesis");
ok(!th({ drift: { z: 1.2, updates: 2, rethink: { same: true } } }), "no drift, no full rewrite");
ok(th({ drift: { z: -2.3, move: -0.15, since: "2026-09-01" } })?.importance === "high", "a 2-sigma move since the last full rewrite orders one");
ok(!th({ drift: { updates: 5 } }) && th({ drift: { updates: 6, since: "2026-09-01" } })?.importance === "low" && th({ drift: { updates: 6 } }).by === "code", "six core-story updates since the last full rewrite order one (low: it waits for room, aging)");
ok(th({ drift: { rethink: { same: false, why: "story changed" } } })?.why.includes("differently"), "the strategist saying 'different' orders one");
// ---- Borrowing
const small = [{ industry: "S", key: "thesis", importance: "high", by: "code" }, { industry: "S", key: "chain", importance: "low" }];
const p0 = D.plan(small, 0.3), p1 = D.plan(small, 0.3, { stretch: 2 });
ok(p0.held.some((c) => c.key === "thesis") && p1.run.some((c) => c.key === "thesis" && c.borrowed) && p1.borrowed > 0, "a drift-guard rewrite bigger than a small sector's day borrows from the month (borrowed $" + p1.borrowed + ")");
ok(D.plan([{ industry: "S", key: "world", importance: "low" }], 0.1, { stretch: 5 }).held.length === 1, "routine work never borrows");
ok(D.borrowCap(470, 100, "2026-11-04") === Math.round(Math.min(3 * D.dayBudget(470, 100, "2026-11-04"), 0.25 * 370) * 100) / 100 && D.borrowCap(470, 460, "2026-11-29") <= 2.5, "borrowing: three days' share, at most a quarter of what's left");
ok(D.bigDay({ spy1d: -2.6 }).big && D.bigDay({ vix1d: 22 }).big && D.bigDay({ highShare: 0.5 }).big && D.bigDay({ shock: "alarm" }).big && !D.bigDay({ spy1d: 0.8, vix1d: 4, highShare: 0.1 }).big, "big days: a 2% market move, a VIX jump, news across the sector, or the midday alarm");
console.log(fails ? fails + " FAILED" : "daily tests passed"); process.exit(fails ? 1 : 0);
