// Tests for sector runs: aliases, prompts, splitting multi-industry answers back into single-industry shapes.
const assert = require("assert");
const Sx = require("./sector.js"), Team = require("./team.js"), Trade = require("./trade.js"), RegBook = require("./regbook.js");
const mkDoc = (name, syms) => ({ name, summary: { n_constituents: syms.length, total_market_cap: 1e12 }, constituents: syms.map((s, i) => ({ symbol: s, name: s + " Inc", weight: 1 / syms.length, market_cap: 1e11, rev_ttm: 1e10, ret_1Y: 0.1 })) });
const semis = { doc: mkDoc("Semiconductors", ["NVDA", "AMD", "MU"]), pack: { items: [{ id: "N1", kind: "N", date: "2026-10-01", title: "NVDA export license news", source: "x", symbol: "NVDA" }, { id: "N2", kind: "N", title: "MU memory pricing" }] }, tx: { items: [{ id: "T1" }] }, kpiDigest: "AI demand strong [N1]." };
const soft = { doc: mkDoc("Software - Application", ["CRM", "ADBE"]), pack: { items: [{ id: "N1", kind: "N", title: "CRM export license and AI agents", source: "y", symbol: "CRM" }] }, tx: { items: [] }, kpiDigest: "Seat growth slowing [N1]." };
const inds = [semis, soft];
// aliases
const a0 = Sx.aliasFor(0, semis), a1 = Sx.aliasFor(1, soft);
assert.strictEqual(a0.to.get("N1"), "QA1"); assert.strictEqual(a1.to.get("N1"), "QB1"); assert.strictEqual(a0.map("demand [N1, T1]"), "demand [QA1, QA3]");
assert.deepStrictEqual(Sx.unalias({ x: "see [QA1]", y: ["QB1", { z: "QA3" }] }, a0), { x: "see [N1]", y: ["QB1", { z: "T1" }] });
// briefs strip per-industry IDs unless aliased
assert(!Sx.brief(semis).includes("[N1]") && Sx.brief(semis, { al: a0 }).includes("[QA1]"));
// macro
const cat = { items: [{ key: "treasury:year10", kind: "treasury" }, { key: "commodity:CLUSD" }, { key: "fx:USDTWD" }, { key: "index:^SOX" }] };
const pp = Sx.planPrompt("Technology", inds, { catalogText: "treasury:year10 ..." });
assert(pp.includes("INDUSTRY: Semiconductors") && pp.includes('"industries"') && !pp.includes("undefined"));
const plan = Sx.cleanPlan({ series: [{ key: "fx:USDTWD", group: "Taiwan", industries: ["semiconductors"] }, { key: "commodity:CLUSD", group: "Input costs", industries: ["Semiconductors", "Software - Application", "Nope"] }, { key: "treasury:year10", group: "Financing & valuation", industries: [] }, { key: "bad:key" }] }, cat, inds);
assert.deepStrictEqual(plan.series.map((x) => x.key), ["fx:USDTWD", "commodity:CLUSD", "treasury:year10"]);
assert.deepStrictEqual(plan.series[0].industries, ["Semiconductors"]);
assert(plan.series[2].industries.includes("Software - Application"), "a thin industry gets the rates and market series");
const macro = { rows: [{ id: "I1", key: "fx:USDTWD", label: "USD/TWD", group: "Taiwan" }, { id: "I2", key: "commodity:CLUSD", label: "Oil", group: "Input costs" }, { id: "I3", key: "treasury:year10", label: "10Y", group: "Rates" }] };
assert.deepStrictEqual(Sx.macroFor(macro, plan, "Software - Application").rows.map((r) => r.id), ["I2", "I3"]);
const ip = Sx.indicatorPrompt("Technology", inds, macro.rows, { tagOf: { "fx:USDTWD": ["Semiconductors"] } });
assert(ip.includes("Matters to: Semiconductors") && ip.includes('"by_industry"') && !ip.includes("undefined"));
const rawInd = { indicators: [{ id: "I1", driver: "TWD fell [G1].", sources: [{ id: "G1", quote: "q" }], by_industry: [{ name: "Semiconductors", relevance: "high", effect: "headwind", why_it_matters: "TSMC costs" }] }, { id: "I2", driver: "Oil", by_industry: [{ name: "software - application", relevance: "low", effect: "neutral" }] }] };
const fi = Sx.indicatorsFor(rawInd, "Semiconductors"); assert.strictEqual(fi.indicators.length, 1); assert.strictEqual(fi.indicators[0].relevance, "high");
const ci = Team.cleanIndicators(Sx.indicatorsFor(rawInd, "Software - Application"), { G1: { id: "G1", title: "Oil" } }, soft.doc, macro.rows.slice(1), () => true);
assert(ci.indicators.I2 && ci.indicators.I2.relevance === "low" && ci.indicators.I2.driver === "Oil");
// world
const sp = Sx.scoutPrompt("Technology", inds, { wire: { items: [{ id: "G1", date: "2026-10-20", source: "r", title: "Chip export curbs" }] } });
assert(sp.includes("INDUSTRY: Software - Application") && !sp.includes("undefined") && !sp.includes("[N1]"));
const idx = { G1: { id: "G1", title: "a" }, G2: { id: "G2", title: "b" }, N1: { id: "N1", title: "n" } };
const scout = Sx.cleanScout({ situations: [{ title: "US-China export controls", category: "trade", status: "escalating", evidence: ["G1", "G2"], industries: [{ name: "Semiconductors", relevance: "high", stance: "adverse", why: "China revenue" }, { name: "software - application", relevance: "medium", stance: "Mixed", why: "AI chips" }, { name: "Banks", why: "x" }] }, { title: "No industries", evidence: ["G1", "G2"], industries: [] }] }, idx, inds);
assert.strictEqual(scout.situations.length, 1); assert.deepStrictEqual(scout.situations[0].industries.map((x) => x.name), ["Semiconductors", "Software - Application"]);
const s1 = Sx.scoutFor(scout, "Software - Application");
assert.strictEqual(s1.situations[0].stance, "mixed"); assert.strictEqual(s1.situations[0].why, "AI chips"); assert(!("industries" in s1.situations[0]));
const sit = { ...scout.situations[0], coverage: [{ id: "G1", date: "2026-10-20", source: "r", title: "Curbs", summary: "s" }] };
const batch = [{ ind: semis, me: sit.industries[0], al: a0 }, { ind: soft, me: sit.industries[1], al: a1 }];
const dp = Sx.situationPrompt(sit, batch, { macro });
assert(dp.includes('"facts"') && dp.includes("One entry in \"industries\" for each of: Semiconductors, Software - Application") && dp.includes("[QA1]") && dp.includes("[QB1]") && !dp.includes("undefined"));
const dp2 = Sx.situationPrompt(sit, batch.slice(1), { macro }, { now: "x" });
assert(dp2.includes("ESTABLISHED FACTS") && !dp2.includes('"facts":'));
const facts = { title: "US-China export controls", status: "escalating", now: "Curbs widened [G1].", developments: [{ date: "2026-10-20", text: "Rule", evidence: ["G1"] }], scenarios: [{ name: "Base case", probability: 60, outcome: "o" }, { name: "Escalation", probability: 30 }, { name: "De-escalation", probability: 10 }] };
const imp = Sx.unalias({ name: "Semiconductors", stance: "adverse", summary: "China sales at risk [QA1].", scenario_earnings: [{ name: "base case", earnings: "-3% to -5%" }], winners: [{ symbol: "MU", why: "x" }, { symbol: "CRM", why: "not ours" }], losers: [{ symbol: "NVDA", why: "y" }] }, a0);
const dive = Team.cleanDive(Sx.mergeDive(facts, imp), idx, semis.doc, s1.situations[0]);
assert(dive.summary.includes("[N1]") && dive.scenarios[0].earnings === "-3% to -5%" && dive.now.includes("[G1]"));
assert.deepStrictEqual(dive.winners.map((w) => w.symbol), ["MU"], "other industries' tickers dropped");
// trade
const maps = { Semiconductors: Trade.cleanMap({ countries: [{ country: "Taiwan", importance: "existential", stance: "allied", trajectory: "volatile", roles: ["manufacturing hub"], threat: "high" }, { country: "China", importance: "high", stance: "adversarial" }] }, idx, semis.doc, Team),
  "Software - Application": Trade.cleanMap({ countries: [{ country: "India", importance: "high", roles: ["R&D & IP"] }, { country: "China", importance: "medium" }] }, idx, soft.doc, Team) };
const un = Sx.countryUnion(maps);
assert.deepStrictEqual(un.map((c) => c.country), ["Taiwan", "India", "China"]); assert.strictEqual(un.find((c) => c.country === "China").industries.length, 2);
const cf = Sx.countryFactsPrompt("Technology", un.slice(0, 3).map((c) => ({ ...c, news: [] })), { macro });
assert(cf.includes("=== Taiwan") && cf.includes("Matters to: Semiconductors (existential") && !cf.includes("undefined"));
const ti = Sx.tradeImpactPrompt(semis, maps.Semiconductors.countries, { Taiwan: { relationship: { alliance: "partner" } } }, { today: "2026-10-25" }, a0);
assert(ti.includes("ESTABLISHED FACTS") && ti.includes("rank 1 for this industry") && !ti.includes("undefined"));
const merged = Sx.mergeCountry({ country: "Taiwan", relationship: { alliance: "partner", summary: "Close [G1]." }, security: { threat_level: "high", threat: "PLA" }, policy: [{ instrument: "CHIPS", evidence: ["G1"] }] },
  { country: "Taiwan", headline: "Foundry chokepoint", industry_impact: "Supply halts", dependencies: [{ input: "Foundry", criticality: "critical" }], exposed: [{ symbol: "NVDA", channel: "supply" }, { symbol: "CRM" }], risks: [{ risk: "Blockade", type: "military conflict", tickers: ["NVDA"] }] });
const cd = Trade.cleanDives({ countries: [merged] }, idx, semis.doc, [maps.Semiconductors.countries[0]], Team);
assert(cd[0].relationship.alliance === "partner" && cd[0].security.industry_impact === "Supply halts" && cd[0].security.threat_level === "high" && cd[0].exposed.length === 1 && cd[0].dependencies.length === 1);
// rule books
const bu = Sx.bodyUnion({ Semiconductors: [{ name: "BIS — Bureau of Industry and Security", levers: ["licenses"], why: "w" }, { name: "SEC — Securities and Exchange Commission" }], "Software - Application": [{ name: "SEC - Securities & Exchange Commission", levers: ["disclosure"] }, { name: "FTC — Federal Trade Commission" }] });
assert.strictEqual(bu[0].industries.length, 2); assert.strictEqual(bu.length, 3); assert(bu[0].keys["Software - Application"]);
const lp = Sx.listPrompt(bu[0], inds, [{ id: "RA1", title: "SEC rule", source: "s" }], { sector: "Technology", bi: 0 });
assert(lp.includes("For EACH industry") && lp.includes("[RA1]") && !lp.includes("undefined") && !lp.includes("[N1]"));
const rp = Sx.rulePrompt(bu[0], { name: "Reg S-K climate", evidence: ["RA1"] }, [{ ind: semis, me: { why: "w", severity: "high" } }], [{ id: "RA1", title: "t" }], { bi: 0 });
assert(rp.includes('"facts"') && rp.includes("One entry in \"industries\" for each of: Semiconductors"));
const list = [{ name: "Rule A", citation: "17 CFR 229", industries: [{ name: "Semiconductors", rank: 2, severity: "high" }, { name: "Software - Application", rank: 1, severity: "medium" }] }, { name: "Rule B", industries: [{ name: "Semiconductors", rank: 1, severity: "low" }] }];
const writes = [{ facts: { what_this_is: "Rule A binds filers [RA1].", last_12_months: [{ date: "2026-01-02", event: "Adopted", evidence: ["RA1"] }], next_12_months: { analysis: "a", events: [] } }, impacts: [{ name: "Semiconductors", industry_impact: "Costs rise 1% [RA1].", examples: [], bottom_line: "b" }, { name: "Software - Application", industry_impact: "Disclosure burden", bottom_line: "c" }] }, { facts: { what_this_is: "Rule B." }, impacts: [{ name: "Semiconductors", industry_impact: "Minor" }] }];
const bf = Sx.bookFor(list, writes, "Semiconductors");
assert.deepStrictEqual(bf.rules.map((r) => r.name), ["Rule B", "Rule A"]); assert.strictEqual(bf.rules[1].industry_impact, "Costs rise 1% [RA1].");
const ridx = { RA1: { id: "RA1", title: "SEC adopts rule", date: "2026-01-02" } };
const books = [RegBook.cleanBook(bf, ridx, semis.doc, { today: "2026-10-25" }, Team), RegBook.cleanBook(Sx.bookFor(list, writes, "Software - Application"), ridx, soft.doc, { today: "2026-10-25" }, Team)];
assert.strictEqual(books[1].rules.length, 1);
const work = { books };
const cs = RegBook.claimsFor(work, Sx.manySpec(work.books));
const dd = Sx.dedupeClaims(cs);
assert(dd.claims.length < cs.claims.length, "the shared what-this-is claim is checked once");
const shared = dd.claims.find((c) => c.text.startsWith("Rule A binds"));
shared.apply("unsupported"); for (const c of dd.claims) if (c !== shared) c.apply("verified"); dd.finalize();
assert(!books[0].rules[1].what_this_is.includes("Rule A binds") && !books[1].rules[0].what_this_is.includes("Rule A binds"), "the verdict applies to every copy");
assert.deepStrictEqual(Sx.batches([1, 2, 3, 4, 5, 6, 7]).map((b) => b.length), [3, 3, 1]);
const row = Sx.overviewRow("Semiconductors", { ...semis.doc, as_of: "2026-10-23", forward: { fwd_pe: 25, rev30: 0.02 }, positioning: { label: "crowded" } }, { result: { opportunity: { verdict: "conditional" }, math: { expected_return: 4 }, headline: "h", horizons: { "1M": { call: "bearish" } } } }, { profiles: { growth: { total: 71.4 }, income: { total: 40 } } });
assert.strictEqual(row.best, "growth"); assert.strictEqual(row.scores.growth, 71); assert.strictEqual(row.horizons["1M"], "bearish");
console.log("sector tests passed");
