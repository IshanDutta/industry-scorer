// Tests for the analyst team: prompt building and the critics.
const assert = require("assert");
const Team = require("./team.js");
const Research = require("./research.js");

const doc = {
  name: "Semiconductors",
  summary: { n_constituents: 3, total_market_cap: 9e12, excess_cw_1Y: 0.2, beta: 1.4, top1_weight: 0.5 },
  fund: { rev_growth: 0.4, gross_margin: 0.6, op_margin: 0.35, pe: 35, pe_hist_median: 28 },
  constituents: [
    { symbol: "NVDA", name: "NVIDIA", weight: 0.5, rev_ttm: 2e11, rev_growth: 0.6, gross_margin: 0.75, op_margin: 0.6, net_margin: 0.5, pe: 45, ret_1Y: 0.4, next: "2026-11-19" },
    { symbol: "MU", name: "Micron", weight: 0.3, rev_ttm: 6e10, rev_growth: 1.2, gross_margin: 0.6, op_margin: 0.4, net_margin: 0.3, pe: 12, ret_1Y: 1.1, next: "2026-12-17" },
    { symbol: "TXN", name: "Texas Instruments", weight: 0.2, rev_ttm: 2e10, rev_growth: 0.2, gross_margin: 0.6, op_margin: 0.4, net_margin: 0.35, pe: 30, ret_1Y: 0.1, next: "2026-10-21" },
  ],
};
const pack = {
  items: [
    { id: "N1", kind: "N", date: "2026-10-10", symbol: "MU", source: "reuters.com", title: "Micron raises prices", summary: "DRAM contract prices up", url: "https://x.com/n1" },
    { id: "W1", kind: "W", date: "2026-10-12", source: "cnbc.com", topic: "trade", title: "China rare earths will keep flowing to EU", summary: "Trade truce extended to January", url: "https://x.com/w1" },
    { id: "W2", kind: "W", date: "2026-10-13", source: "cnbc.com", topic: "tariffs", title: "US and China roll back tariffs on $30 billion of goods", summary: "trade truce", url: "https://x.com/w2" },
    { id: "M1", kind: "M", date: "2026-09-01", source: "SEC filing", title: "TXN → Silicon Labs", url: "https://x.com/m1" },
  ],
  segments: [
    { symbol: "MU", product: { label: "Q4 FY2026", items: [{ name: "CMBU", share: 0.3, yoy: 2.5 }, { name: "CDBU", share: 0.33, yoy: 10 }] }, geo: { label: "FY FY2026", items: [{ name: "UNITED STATES", share: 0.68, yoy: 2.8 }, { name: "CHINA", share: 0.06 }, { name: "HONG KONG", share: 0.05 }, { name: "TAIWAN, PROVINCE OF CHINA", share: 0.13 }, { name: "Europe", share: 0.08 }] } },
    { symbol: "TXN", geo: { label: "FY 2025", items: [{ name: "China", share: 0.2 }, { name: "United States", share: 0.5 }, { name: "Rest of World", share: 0.3 }] } },
  ],
  analyst: [{ symbol: "MU", consensus: "Buy", buy: 58, hold: 10, sell: 2, target: 1588, price: 1200, upside: 0.32 }],
  calendar: [{ date: "2026-10-28 08:30", event: "GDP", impact: "High", estimate: 2.1, previous: 2.0 }],
  sentiment: { last_7d: 0.4, prior_30d: 0.3, last_90d: 0.35, articles_30d: 300, by_company: [{ symbol: "MU", score_30d: 0.5, articles_30d: 100 }] },
};
const tx = { items: [{ id: "T1", symbol: "TXN", name: "Texas Instruments", period: "Q2 FY2026", date: "2026-07-22", excerpt: "Haviv Ilan: Data center doubled year-on-year. We have started executing price increases." }] };
const macro = { rows: [
  { id: "I1", group: "Rates & credit", label: "10-year Treasury", value: 4.6, unit: "%", date: "2026-10-14", prior: 4.4, prior_label: "1 month ago", source: "FMP" },
  { id: "I2", group: "Commodities", label: "WTI crude", value: 88.2, unit: "$", date: "2026-10-15", chg_1m: 5.1, chg_1y: 20, source: "FMP" },
  { id: "I3", group: "Global activity", label: "Taiwan manufacturing PMI", value: 54.1, unit: "", date: "2026-10-01", prior: 53, prior_label: "previous", source: "EODHD" },
] };
const ctx = { today: "2026-10-15" };

// ---- geo mix: revenue-weighted, buckets merged
const gm = Team.geoMix(doc, pack);
assert(gm && gm.companies.length === 2);
const china = gm.rows.find((r) => r.region === "China & Hong Kong");
// MU 6e10 * 0.11 + TXN 2e10 * 0.2 over 8e10
assert(Math.abs(china.share - (6e10 * 0.11 + 2e10 * 0.2) / 8e10) < 1e-9, china.share);
assert(gm.rows.find((r) => r.region === "Taiwan"));

// ---- prompts build, cite IDs, stay well under the 256 KiB cap
const idx = Team.index(pack, tx, macro);
assert(idx.T1 && idx.I2 && idx.W1 && idx.M1);
const prompts = {
  kpi: Team.kpiPrompt(doc, pack, tx, macro, ctx), macro: Team.macroPrompt(doc, pack, tx, macro, { ...ctx, kpiDigest: "Cycle: expansion" }),
  scout: Team.scoutPrompt(doc, pack, tx, macro, ctx), reg: Team.regPrompt(doc, pack, tx, macro, ctx),
  dive: Team.divePrompt(doc, pack, tx, macro, { ...ctx, wire: { items: [{ id: "G1", date: "2026-10-14", source: "cnbc.com", title: "Rare earths keep flowing", summary: "x", tags: ["RARE-EARTHS"] }], topics: [{ tag: "RARE-EARTHS", count: 4, last: "2026-10-14" }] } }, { title: "US-China trade truce", category: "trade", stance: "mixed", why: "x", evidence: ["W1", "W2"], coverage: [pack.items[2]] }),
};
for (const [k, p] of Object.entries(prompts)) { assert(p.length < 200000, k); assert(!p.includes("undefined"), k + " has undefined"); assert(!p.includes("[object Object]"), k + " has [object Object]"); }
assert(prompts.kpi.includes("[T1] TXN") && prompts.kpi.includes("CMBU 30%"));
assert(prompts.macro.includes("[I2] Commodities · WTI crude: $88.20"));
assert(prompts.dive.includes("[W2]"), "dive includes situation evidence");

// ---- KPI critic
const kpi = Team.cleanKpi({
  summary: "Memory pricing is surging [N1] and TXN data center doubled [T1] [Z9].",
  cycle_position: "expansion",
  demand_metrics: [
    { name: "TXN data center revenue", value: "+100% y/y", period: "Q2 2026", change: "+20% q/q", vs_cycle: "record", explanation: "Doubled [T1]", evidence: ["T1", "X5"] },
    { name: "Made-up metric", value: "42", period: "Q3", explanation: "no source", evidence: [] },
    { name: "", value: "drop me" },
  ],
  profitability_metrics: "not an array",
  unit_economics: { operating_leverage: "High", incremental_margin: "70-85% [T1]", text: { text: "object text" } },
  pricing_power: { level: "strong", who_has_it: "memory", text: "price increases [T1]", evidence: ["T1"] },
  hot_segments: [{ name: "HBM", names: ["MU", "SKHYNIX", "nvda"], text: "hot", evidence: ["N1"] }],
  segment_map: [{ segment: "Memory", names: ["MU"], note: "cyclical" }],
  management_signals: [{ symbol: "TXN", signal: "Price increases started", tone: "positive", evidence: ["T1"] }, { symbol: "MU", signal: "uncited", evidence: [] }],
  next_triggers: [{ date: "2026-12-17", event: "MU earnings", why: "pricing", names: ["MU"] }, { date: "2026-10-21", event: "TXN earnings", why: "industrial", names: ["TXN"] }],
}, idx, doc);
assert.strictEqual(kpi.summary, "Memory pricing is surging [N1] and TXN data center doubled [T1].");
assert.strictEqual(kpi.demand_metrics.length, 2);
assert.deepStrictEqual(kpi.demand_metrics[0].evidence, ["T1"]);
assert.strictEqual(kpi.demand_metrics[0].estimate, false);
assert.strictEqual(kpi.demand_metrics[1].estimate, true);
assert.deepStrictEqual(kpi.profitability_metrics, []);
assert.strictEqual(kpi.unit_economics.operating_leverage, "high");
assert.strictEqual(kpi.unit_economics.text, "object text");
assert.deepStrictEqual(kpi.hot_segments[0].names, ["MU", "NVDA"], "unknown tickers dropped");
assert.strictEqual(kpi.management_signals.length, 1, "uncited management signal dropped");
assert.strictEqual(kpi.next_triggers[0].event, "TXN earnings", "triggers sorted by date");
assert(kpi.stats.dropped >= 2);
const dig = Team.digest("kpi", kpi);
assert(dig.includes("TXN data center revenue: +100% y/y"));

// ---- macro critic: unique, non-boilerplate whys, known IDs only
const mac = Team.cleanMacro({
  regime: "hostile", confidence: "Medium", headline: "10Y at 4.6% [I1]", summary: "s",
  horizons: { "1M": { call: "MIXED", drivers: ["I1", "I9"], text: "t" }, "3m": { call: "supportive" } },
  channels: { demand: { text: "PMI 54 [I3]", drivers: ["I3"] }, cost: "Oil up [I2]" },
  indicators: [
    { id: "I1", relevance: "high", effect: "headwind", why: "Higher discount rate compresses the 35x P/E." },
    { id: "I2", relevance: "low", effect: "neutral", why: "Macro reference relevant to Semiconductors financing and demand." },
    { id: "I3", relevance: "high", effect: "tailwind", why: "Higher discount rate compresses the 35x P/E." },
    { id: "I7", why: "unknown" },
  ],
}, idx, doc, macro);
assert.strictEqual(mac.regime, "HOSTILE");
assert.strictEqual(mac.horizons["1M"].drivers.join(), "I1");
assert.strictEqual(mac.horizons["3M"].call, "SUPPORTIVE");
assert.strictEqual(mac.horizons["12M"].call, "MIXED");
assert.strictEqual(mac.channels.cost.text, "Oil up [I2]");
assert.strictEqual(mac.indicators.I2.why, "", "boilerplate blanked");
assert.strictEqual(mac.indicators.I3.why, "", "duplicate blanked");
assert(!mac.indicators.I7);
assert.strictEqual(mac.coverage, 1);

// ---- scout + dive critics
const sc = Team.cleanScout({ situations: [{ title: "US-China trade truce", stance: "Mixed", evidence: ["W1", "W2"], why: "Tariffs" }, { title: "Invented war", evidence: ["W99"] }] }, idx, doc);
assert.strictEqual(sc.situations.length, 1);
const dv = Team.cleanDive({
  title: "US-China trade truce", stance: "adverse", summary: "s [W2]",
  developments: [{ date: "2026-10-12", text: "a", evidence: ["W1"] }, { date: "2026-10-13", text: "b", evidence: ["W2"] }],
  indicators: [{ id: "I2", why: "oil" }, { id: "I99", why: "x" }],
  chain: [{ step: "Tariff relief", timing: "0-3 months", text: "t", evidence: ["W2"] }],
  channels: { revenue: [{ name: "China sales", direction: "Up", magnitude: "+1-3% (estimate)", exposed: ["MU", "INTC"], evidence: [] }], cost: [{ name: "Rare earths", direction: "down", evidence: ["W1"] }] },
  scenarios: [{ name: "Base case", probability: 50 }, { name: "Escalation", probability: 30 }, { name: "De-escalation", probability: 30 }],
  winners: [{ symbol: "MU", why: "China" }, { symbol: "ZZZ", why: "x" }],
}, idx, doc, sc.situations[0]);
assert.strictEqual(dv.developments[0].date, "2026-10-13", "newest first");
assert.deepStrictEqual(dv.indicators.map((x) => x.id), ["I2"]);
assert.deepStrictEqual(dv.channels.revenue[0].exposed, ["MU"]);
assert.strictEqual(dv.channels.revenue[0].direction, "up");
assert.strictEqual(dv.channels.revenue[0].estimate, true);
assert.strictEqual(dv.channels.cost[0].estimate, false);
assert.deepStrictEqual(dv.channels.demand, []);
assert.strictEqual(dv.scenarios.reduce((a, s) => a + s.probability, 0), 100);
assert.strictEqual(dv.winners.length, 1);

// ---- reg critic: uncited policy/litigation/deals dropped
const rg = Team.cleanReg({ summary: "s", regulators: [{ name: "BIS", why: "export controls", current: "nothing new in the retrieved coverage" }],
  policy: [{ title: "Tariff rollback", evidence: ["W2"], direction: "Tailwind" }, { title: "Invented rule", evidence: [] }],
  deals: [{ title: "TXN → Silicon Labs", evidence: ["M1"], names: ["TXN"] }], perception: { summary: "positive", trend: "Improving" } }, idx, doc);
assert.strictEqual(rg.policy.length, 1);
assert.strictEqual(rg.policy[0].direction, "tailwind");
assert.strictEqual(rg.deals.length, 1);
assert.strictEqual(rg.perception.trend, "improving");
assert.deepStrictEqual(rg.litigation, []);

// ---- fmtVal
assert.strictEqual(Team.fmtVal({ value: 4.6, unit: "%" }), "4.60%");
assert.strictEqual(Team.fmtVal({ value: 44.4, unit: "bp" }), "44 bp");
assert.strictEqual(Team.fmtVal({ value: 6600, unit: "" }), "6,600");

// ---- research helpers
assert(Research.excerpt("Operator : hello there and welcome to the call everyone today.\n\nJane Doe : Revenue was $5.5 billion, up 23% year-over-year, and we expect pricing to rise in the fourth quarter.").startsWith("Jane Doe: Revenue"));
console.log("team tests passed");

// ---- runtime macro pipeline: catalog -> plan -> rows -> indicator analysts -> strategist
(async () => {
  const M = require("./macro.js");
  const today = "2026-10-19";
  const fmp = async (tool, input) => {
    const e = input.endpoint;
    if (e === "treasury-rates") return [{ date: "2026-10-17", month3: 4.1, year2: 3.9, year10: 4.6 }, { date: "2026-09-17", month3: 4.2, year2: 3.8, year10: 4.3 }];
    if (e === "economics-calendar") return input.to_date === today ? [
      { date: "2026-10-15 12:30:00", country: "US", event: "NY Empire State Manufacturing Index (Oct)", actual: 10.7, previous: -8.7, estimate: 1, impact: "High", unit: "" },
      { date: "2026-10-14 01:30:00", country: "CN", event: "Exports YoY (Sep)", actual: 8.3, previous: 4.4, estimate: 6, impact: "High", unit: "%" },
      { date: "2026-10-14 09:00:00", country: "DE", event: "ZEW sentiment", actual: null, impact: "High" },
      { date: "2026-10-13 09:00:00", country: "GB", event: "Claimant count", actual: 20, impact: "Low" }] : [];
    if (e === "commodities-list") return [{ symbol: "CLUSD", name: "Crude Oil" }, { symbol: "HGUSD", name: "Copper" }];
    if (e === "all-commodities-quotes") return [{ symbol: "CLUSD", price: 88, change: 2 }, { symbol: "HGUSD", price: 4.9, change: 0.01 }];
    if (e === "indexes-list") return [{ symbol: "^SOX", name: "PHLX Semiconductor" }];
    if (e === "all-index-quotes") return [{ symbol: "^SOX", price: 5400 }, { symbol: "^NONAME", price: 1 }];
    if (e === "all-forex-quotes") return [{ symbol: "USDJPY", price: 151 }, { symbol: "EURGBP", price: 0.86 }, { symbol: "USDTWD", price: 0 }];
    if (e === "quote-change") return [{ symbol: input.symbol, "1M": 9.5, "3M": 12, "1Y": 20 }];
    return [];
  };
  const cat = await M.catalog(fmp, null, { today, eodTools: [] });
  const keys = cat.items.map((i) => i.key);
  assert(keys.includes("treasury:year10") && keys.includes("release:US|NY Empire State Manufacturing Index") && keys.includes("release:CN|Exports YoY"), keys.join(","));
  assert(!keys.some((k) => /ZEW|Claimant|NONAME|EURGBP|USDTWD|^eod:/.test(k)), "no actual, low impact, unnamed index, non-USD pair, zero price, or EODHD series without the connector");
  assert(keys.includes("commodity:CLUSD") && keys.includes("index:^SOX") && keys.includes("fx:USDJPY"));
  const ct = M.catalogText(cat);
  assert(ct.includes("release:US|NY Empire State Manufacturing Index = 10.7") && ct.includes("commodity:CLUSD Crude Oil"));

  // planner critic: catalog keys and valid spreads only
  const plan = Team.cleanPlan({ series: [{ key: "release:US|NY Empire State Manufacturing Index", group: "US factory demand", label: "Empire State manufacturing", reason: "Regional orders for equipment" },
    { key: "treasury:year10", group: "Financing & valuation", reason: "Discount rate" }, { key: "spread:year10-year2", group: "Financing & valuation" }, { key: "spread:year10-year99" },
    { key: "commodity:CLUSD", group: "Input costs" }, { key: "fx:USDJPY", group: "Currencies" }, { key: "made:up" }, { key: "treasury:year10" }] }, cat);
  assert.deepStrictEqual(plan.series.map((x) => x.key), ["release:US|NY Empire State Manufacturing Index", "treasury:year10", "spread:year10-year2", "commodity:CLUSD", "fx:USDJPY"]);
  const fb = M.fallbackPlan(cat, ["US"]);
  assert(fb.fallback && fb.series.some((x) => x.key === "treasury:year10") && fb.series.some((x) => x.key.startsWith("release:US|")) && !fb.series.some((x) => x.key.startsWith("release:CN|")));

  const m = await M.fetchRows(fmp, null, { today }, cat, plan);
  const byKey = Object.fromEntries(m.rows.map((r) => [r.key, r]));
  assert.deepStrictEqual(m.groups, ["US factory demand", "Financing & valuation", "Input costs", "Currencies"]);
  assert.strictEqual(byKey["release:US|NY Empire State Manufacturing Index"].prior, -8.7);
  assert.strictEqual(byKey["release:US|NY Empire State Manufacturing Index"].reason, "Regional orders for equipment");
  assert.strictEqual(byKey["spread:year10-year2"].value, 70); assert.strictEqual(byKey["spread:year10-year2"].unit, "bp");
  assert.strictEqual(byKey["commodity:CLUSD"].chg_1m, 9.5);
  assert(m.rows.every((r, i) => r.id === "I" + (i + 1)));

  const mv = M.movers(m.rows);
  const emp = byKey["release:US|NY Empire State Manufacturing Index"], t10 = byKey["treasury:year10"], oil = byKey["commodity:CLUSD"];
  assert(mv.some((x) => x.id === t10.id && x.move.includes("+30 bp")) && mv.some((x) => x.id === oil.id) && mv.some((x) => x.id === emp.id), JSON.stringify(mv));

  // indicator analysts: off-topic citations removed (the user's Empire State example)
  const wire = [{ id: "G12", title: "New York factory activity rebounds as Empire State survey jumps", summary: "", url: "https://cnbc.com/ny" },
    { id: "X251", title: "Acme unveils SMT equipment for electronics manufacturing", summary: "New York-based Acme...", url: "https://pr/smt" },
    { id: "X250", title: "Alvotech receives FDA approval", url: "https://pr/alvo" }, { id: "X248", title: "3 growth stocks to buy now", url: "https://x/3" },
    { id: "G4", title: "Oil jumps after strike on Gulf refinery", summary: "Crude oil prices rose", url: "https://cnbc.com/oil" }];
  const idx3 = Team.index(null, null, m, wire);
  const reads = Team.cleanIndicators({ indicators: [
    { id: emp.id, relevance: "High", relevance_why: "Equipment orders.", effect: "Tailwind", driver: "The index jumped to 10.7 from -8.7 [G12]. Orders rose [X251, X250]. Stocks [X248].", why_it_matters: "Orders lead capex.", next: "Philly Fed on Oct 23.", keywords: ["empire state", "new york fed"], evidence: ["G12", "X251", "X248"] },
    { id: oil.id, relevance: "medium", effect: "headwind", driver: "Crude rose 9.5% after a strike on a Gulf refinery [G4] [X250].", keywords: ["crude oil"], evidence: [] },
    { id: t10.id, relevance: "high", effect: "headwind", driver: "Yields rose 30 bp. No news coverage of this move was found.", keywords: [], evidence: ["X248"] },
    { id: "I99", driver: "x" }] }, idx3, doc, m.rows);
  const re = reads.indicators[emp.id];
  assert.strictEqual(re.driver, "The index jumped to 10.7 from -8.7 [G12]. Orders rose. Stocks.");
  assert.deepStrictEqual(re.evidence, ["G12"]); assert(re.covered); assert.strictEqual(re.relevance, "high"); assert.strictEqual(re.effect, "tailwind");
  assert.strictEqual(reads.indicators[oil.id].driver, "Crude rose 9.5% after a strike on a Gulf refinery [G4].");
  assert(!reads.indicators[t10.id].covered && !reads.indicators.I99);
  assert(reads.dropped >= 5, String(reads.dropped));

  // coverage from the whole run: candidates, quotes, verification
  const Cov = require("./coverage.js");
  const store = require("./world.js").makeStore();
  emp.phrases = ["empire state", "new york fed"]; emp.tags = ["manufacturing"]; oil.phrases = ["oil prices", "crude"]; oil.tags = ["oil"]; t10.phrases = ["treasury yields", "10-year yield"]; t10.tags = ["bonds"];
  const yen = { id: "I77", key: "fx:USDJPY", group: "FX", label: "USD/JPY", symbol: "USDJPY", value: 151, date: today };
  const pool = [
    { id: "G12", title: "New York factory activity rebounds as Empire State survey jumps", summary: "The New York Fed's Empire State index jumped to 10.7 in October as new orders surged.", date: "2026-10-15", url: "u1" },
    { id: "X251", title: "Acme unveils SMT equipment for electronics manufacturing", summary: "New York-based Acme said...", date: "2026-10-16", url: "u2", tags: ["MANUFACTURING"] },
    { id: "W3", kind: "W", title: "Stocks fall as 10-year yield tops 5% after hot inflation report", summary: "Treasury yields climbed after September CPI came in at 3.7%.", date: "2026-10-14", url: "u3" },
    { id: "G9", title: "Iran tensions lift crude", summary: "Oil prices rose 4% after attacks on tankers in the Strait of Hormuz.", date: "2026-10-18", url: "u4" },
    { id: "T1", kind: "T", title: "MU Q3 earnings call", text: "We are seeing higher energy costs as oil prices rose this quarter.", date: "2026-09-25" }];
  const eodCalls = []; const fmpCalls = [];
  const covCtx = { today, onStep: () => {}, eod: async (tool, input) => { eodCalls.push(input.tag); return input.tag === "bonds" ? [{ date: "2026-10-17T10:00:00Z", title: "Bond market selloff deepens; treasury yields hit 2007 highs", content: "Treasury yields rose as traders priced another Fed hike.", link: "https://e/bonds", tags: ["BONDS", "RATES"] }] : []; },
    fmp: async (tool, input) => { if (input.endpoint === "general-news") { fmpCalls.push("news:" + input.from_date); return input.page ? [] : [{ publishedDate: input.from_date + " 13:00:00", title: "UK inflation rises to 3.1% as Empire State-style survey...", text: "x", url: "https://f/uk", site: "x.com" }]; } fmpCalls.push(input.symbols.join(",")); return [{ symbol: "USDJPY", publishedDate: "2026-10-20 10:00:00", title: "Dollar steadies against the yen as BoJ holds", text: "USD/JPY held near 151 after the Bank of Japan kept rates unchanged.", url: "https://f/yen", site: "fxstreet.com" }]; } };
  const links = { [oil.id]: [{ title: "Iran conflict", why: "Attacks on tankers lift crude", evidence: ["G9"] }] };
  const cov = await Cov.gather([emp, oil, t10, yen], covCtx, pool, store, links);
  assert.deepStrictEqual(eodCalls.sort(), ["bonds", "manufacturing", "oil"]); assert.deepStrictEqual(fmpCalls.sort(), ["USDJPY", "news:" + emp.date].sort(), "forex news by pair, market news from the release day");
  assert(!cov.byRow[emp.id].some((c) => cov.items.get(c.id).url === "https://f/uk"), "a UK story is not coverage of a US release");
  const cids = (r) => cov.byRow[r.id].map((c) => c.id);
  assert.deepStrictEqual(cids(emp), ["G12"], "Empire State coverage found; the SMT press release is not a candidate");
  assert(cids(oil).includes("G9") && cids(oil).includes("T1"), "world-team link and earnings-call mention: " + JSON.stringify(cov.byRow[oil.id]));
  assert(cids(t10).includes("W3") && cids(t10).some((id) => cov.items.get(id).url === "https://e/bonds"), JSON.stringify(cov.byRow[t10.id]));
  assert(cids(yen).some((id) => cov.items.get(id).url === "https://f/yen"), "instrument-linked forex news");
  // verification
  const vf = (id, q, r) => Cov.verifyCitation(id, q, r, cov);
  assert(vf("G12", "The New York Fed's Empire State index jumped to 10.7 in October", emp));
  assert(!vf("G12", "The index collapsed to minus twenty in October amid layoffs", emp), "invented quote rejected");
  assert(!vf("X251", "New York-based Acme said", emp), "real quote, but not about the indicator and not a candidate");
  assert(vf("G12", "", emp), "strong candidate without a quote is kept");
  const ip = Team.indicatorPrompt(doc, pack, [emp, oil], { today, candidates: cov.byRow, items: cov.items, links, worldDigest: "- Iran conflict", tradeDigest: "Countries: 1. Taiwan", regDigest: "Export controls", tools: true });
  assert(ip.includes(`[${emp.id}] US factory demand · Empire State manufacturing: 10.70 (Oct)`) && ip.includes("[G12] 2026-10-15") && ip.includes(`World team: "Iran conflict" moves it`) && ip.includes("search_coverage") && ip.includes("TRADE RELATIONS") && ip.includes("QUOTED EXACTLY") && !ip.includes("undefined"), ip.slice(0, 3000));
  const r2 = Team.cleanIndicators({ indicators: [{ id: emp.id, driver: "Jumped to 10.7 [G12] as orders rose [X251].", sources: [{ id: "G12", quote: "Empire State index jumped to 10.7 in October as new orders surged" }, { id: "X251", quote: "New York-based Acme said" }] },
    { id: oil.id, driver: "Oil rose on Hormuz attacks [G9].", sources: [{ id: "G9", quote: "Oil prices rose 4% after attacks on tankers in the Strait of Hormuz" }] }] }, { ...idx3, ...Object.fromEntries(cov.items) }, doc, [emp, oil], (id, q, r) => Cov.verifyCitation(id, q, r, cov));
  assert.strictEqual(r2.indicators[emp.id].driver, "Jumped to 10.7 [G12] as orders rose.");
  assert.deepStrictEqual(r2.indicators[emp.id].evidence, ["G12"]); assert(r2.indicators[emp.id].quotes.G12.startsWith("Empire State"));
  assert(r2.indicators[oil.id].covered);

  // strategist: consumes the reads; its move citations are relevance-checked too
  const p = Team.macroPrompt(doc, pack, tx, m, { today, moves: mv, indicatorReads: reads.indicators, worldDigest: "- Middle East escalation" });
  assert(p.includes("high relevance, tailwind. Driver: The index jumped") && p.includes("LIVE WORLD SITUATIONS") && !p.includes("undefined"));
  const r = Team.cleanMacro({ regime: "restrictive", state_of_world: "Oil jumped after the strike [G4] [Z1].", moves: [{ id: oil.id, move: "+9.5%", driver: "Refinery strike [G4] [X248]", so_what: "Costs" }, { id: "I99", driver: "x" }, { id: t10.id, move: "+30 bp" }] }, idx3, doc, m, reads.indicators, {});
  assert.strictEqual(r.state_of_world, "Oil jumped after the strike [G4].");
  assert.deepStrictEqual(r.moves.map((x) => x.id + ":" + x.driver), [`${oil.id}:Refinery strike [G4]`]);
  assert.strictEqual(r.indicators[emp.id].why, "Orders lead capex."); assert.strictEqual(r.indicators[emp.id].relevance_why, "Equipment orders.");
  console.log("macro pipeline tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
