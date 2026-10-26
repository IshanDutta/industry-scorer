/* Industry Scorer: the lead strategist (the "brain").
 *
 * Runs last, after every specialist report AND every regulatory rule book and
 * the regulatory verdict are in. Code assembles one dossier from all of them
 * (quant metrics and scores, industry KPIs, the macro regime with every
 * indicator analyst's read, the world-event deep dives with their scenarios,
 * trade relations and the supply-chain verdict, regulation/legal/deals, every
 * rule book and the regulatory verdict, analyst consensus, sentiment, segment
 * mix, and the news), with a source index for every ID the dossier cites.
 *
 * Three calls:
 *   1. synthesis — the thesis: what matters most (ranked, cross-section),
 *      the key debates, bull/base/bear scenarios with probabilities, what is
 *      priced in, where the specialist reports disagree, what would change the
 *      view. May search for more news.
 *   2. verdicts — per investor type (fit, conviction, score adjustment), the
 *      section notes, the seven landscape dimensions, catalysts, risks, dates.
 *   3. review — a skeptical reviewer checks both against the dossier (missed
 *      factors, numbers that contradict the data, unsupported claims, internal
 *      contradictions, probabilities that don't add up) and returns
 *      replacement values for the fields that need fixing.
 * Then the critic: citations must resolve to a retrieved source, tickers must
 * be in the industry, scenario probabilities are normalized to 100, and the
 * judgment adjustment is capped at +/-5 (every section is already scored by code) and scaled by how well supported it is.
 */
(function (root) {
  "use strict";
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const trim = (s, n) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  const pct = (x, d = 1) => (isNum(x) ? (x * 100).toFixed(d) + "%" : "n/a");
  const num = (x, d = 1) => (isNum(x) ? x.toFixed(d) : "n/a");
  const PROFILES = ["income", "conservative", "growth", "aggressive"];
  const DIMENSIONS = [["macro", "Macro environment"], ["news", "Industry news"], ["world_events", "World events"], ["regulatory", "Regulators & policy"], ["perception", "Public perception"], ["mna", "M&A"], ["legal", "Court cases & legal"]];
  const SECTIONS = ["performance", "risk", "fundamentals", "valuation", "earnings", "health"];
  const req = (f, g) => (typeof module !== "undefined" && module.exports ? require(f) : root[g]);
  const Horizon = req("./horizon.js", "Horizon"), Sensitivity = req("./sensitivity.js", "Sensitivity"), Positioning = req("./positioning.js", "Positioning"), Fund = req("./fund.js", "Fund");
  const History = req("./history.js", "History"), Plan = req("./plan.js", "Plan"), Chain = req("./chain.js", "Chain");
  /** The multiple the scenario math starts from: forward P/E when consensus covers at least half the industry, else trailing. */
  function basePE(doc) {
    const fw = doc.forward;
    if (fw && fw.fwd_pe > 0 && fw.coverage >= 0.5) return { pe: fw.fwd_pe, basis: "forward" };
    return { pe: doc.fund?.pe_negative ? NaN : doc.fund?.pe, basis: "trailing" };
  }
  const SOURCES = ["quant", "kpi", "macro", "world", "trade", "regulation", "rulebooks", "valuation", "news", "consensus"];
  const OVERLAY_CAP = 5;
  /** Every section of the report: each scenario and each investor verdict must say what happens in all of them. */
  const SCN_SECTIONS = [["kpi", "Industry KPIs & cycle"], ["macro", "Macro backdrop"], ["world", "World events"], ["trade", "Trade & supply chain"], ["regulation", "Regulation, rule books & legal"],
    ["fundamentals", "Earnings, margins & balance sheet"], ["valuation", "Valuation & multiple"], ["performance", "Price action, momentum & risk"], ["sentiment", "Sentiment & news"], ["consensus", "Sell-side consensus"]];
  const SCN_KEYS = SCN_SECTIONS.map(([k]) => k);
  const ev = (a) => (Array.isArray(a) && a.length ? ` [${a.join(", ")}]` : "");

  /** Every section of the run, compacted into one text the strategist reads. */
  function dossier(doc, ctx) {
    const s = doc.summary || {}, f = doc.fund || {}, sc = ctx.scores || {};
    const R = ctx.reports || {};
    const out = [];
    const H = (t) => out.push(`\n=== ${t} ===`);
    // Quant
    H("QUANT: COMPUTED METRICS AND SCORES (code, not opinion; interpret, don't recompute)");
    const top = [...(doc.constituents || [])].sort((a, b) => b.weight - a.weight).slice(0, 15).map((c) => `${c.symbol} ${trim(c.name, 30)} ${(c.weight * 100).toFixed(1)}%${isNum(c.ret_1Y) ? ` 1Y ${pct(c.ret_1Y, 0)}` : ""}${isNum(c.pe) ? ` P/E ${num(c.pe)}` : ""}${isNum(c.fwd_pe) ? ` fwd P/E ${num(c.fwd_pe)}` : ""}${isNum(c.rev_growth) ? ` rev ${pct(c.rev_growth, 0)}` : ""}${isNum(c.ntm_growth) ? ` NTM EPS ${pct(c.ntm_growth, 0)}` : ""}${isNum(c.rev30) ? ` est 30d ${pct(c.rev30)}` : ""}${isNum(c.short_pct) ? ` short ${pct(c.short_pct)}` : ""}`).join("; ");
    out.push(`Companies (${s.n_constituents}, ${isNum(s.total_market_cap) ? "$" + (s.total_market_cap / 1e12).toFixed(2) + "T" : "n/a"}): ${top}. Largest ${pct(s.top1_weight, 0)}, top five ${pct(s.top5_weight, 0)}.`);
    out.push(`Performance vs SPY (cap-weighted): 1M ${pct(s.excess_cw_1M)}, 3M ${pct(s.excess_cw_3M)}, 6M ${pct(s.excess_cw_6M)}, 1Y ${pct(s.excess_cw_1Y)}; median stock 1Y ${pct(s.excess_median_1Y)}; breadth 1M ${pct(s.breadth_1M, 0)}, 3M ${pct(s.breadth_3M, 0)}, 1Y ${pct(s.breadth_1Y, 0)}.`);
    out.push(`Risk (1Y): beta ${num(s.beta, 2)}, vol ${pct(s.vol_1y)}, downside vol ${pct(s.downside_vol_1y)}, max drawdown ${pct(s.max_dd_1y)}, Sharpe ${num(s.sharpe_1y, 2)}.`);
    out.push(`Fundamentals (TTM): revenue growth ${pct(f.rev_growth)}, earnings growth ${pct(f.ni_growth)}, gross margin ${pct(f.gross_margin)}, operating margin ${pct(f.op_margin)}, net margin ${pct(f.net_margin)}, ROE ${pct(f.roe)}, ROIC ${pct(f.roic)}, FCF margin ${pct(f.fcf_margin)}.`);
    out.push(`Valuation: P/E ${f.pe_negative ? "negative" : num(f.pe)} vs 5Y median ${num(f.pe_hist_median)} (${pct(f.pe_vs_hist)}, ${pct(f.pe_hist_pct, 0)} percentile); P/S ${num(f.ps)}; P/B ${num(f.pb)}; EV/EBITDA ${num(f.ev_ebitda)}; dividend yield ${pct(f.div_yield, 2)}; FCF covers dividends ${num(f.fcf_div_cover)}x.`);
    out.push(`Earnings: beat rate ${pct(f.beat_rate, 0)} of ${f.beat_reports ?? 0}, median EPS surprise ${pct(f.eps_surprise_median)}, revenue surprise ${pct(f.rev_surprise_median)}. Next: ${(f.next_reports || []).slice(0, 10).map((r) => `${r.symbol} ${r.date}`).join(", ") || "none"}.`);
    out.push(`Health: D/E ${num(f.de, 2)}, current ratio ${num(f.current_ratio, 2)}, interest cover ${num(f.int_cover)}x.${f.financial ? " Financial-sector industry: industrial ratios don't apply." : ""}`);
    out.push(`Rates: 3M T-bill ${pct(ctx.rf, 2)}, 10Y ${pct(ctx.y10, 2)}.`);
    // Forward estimates and revisions
    const fw = doc.forward;
    if (fw?.n) {
      H("FORWARD ESTIMATES AND REVISIONS (consensus, aggregated by code)");
      out.push(`Forward P/E ${num(fw.fwd_pe)} on next-twelve-month consensus EPS (covers ${pct(fw.coverage, 0)} of market cap; ${fw.sources.join(" + ")}) vs trailing P/E ${f.pe_negative ? "negative" : num(f.pe)}. Consensus EPS is usually adjusted (non-GAAP); trailing P/E is on reported earnings. Expected EPS growth, next 12 months: ${pct(fw.ntm_eps_growth)}; next fiscal year revenue growth ${pct(fw.fy1_rev_growth)}, EPS growth ${pct(fw.fy1_eps_growth)}. PEG ${num(fw.peg, 2)}. Estimate spread (high minus low, over the mean): median ${pct(fw.dispersion, 0)}; median ${isNum(fw.analysts_median) ? fw.analysts_median : "n/a"} analysts per company.`);
      if (fw.has_revisions) out.push(`Revisions: next-twelve-month EPS estimates ${pct(fw.rev30)} over 30 days and ${pct(fw.rev90)} over 90 days (cap-weighted; median company ${pct(fw.rev30_median)} and ${pct(fw.rev90_median)}); ${fw.up30} analyst revisions up vs ${fw.down30} down in 30 days (breadth ${num(fw.breadth, 2)}); ${pct(fw.share_rising, 0)} of companies have rising estimates. Biggest upgrades: ${fw.top_up.map((x) => `${x.symbol} ${pct(x.rev30)}`).join(", ") || "none"}; downgrades: ${fw.top_down.map((x) => `${x.symbol} ${pct(x.rev30)}`).join(", ") || "none"}.`);
      else out.push("Revisions: no revision history (EODHD earnings trends not available); estimates from FMP.");
      if (fw.excluded?.length) out.push(`Left out of forward figures: ${fw.excluded.slice(0, 8).map((x) => `${x.symbol} (${x.why})`).join("; ")}.`);
    }
    const pi = doc.priced_in;
    if (pi && (isNum(pi.implied_fcf_growth) || isNum(pi.implied_eps_growth))) {
      H("WHAT'S PRICED IN (reverse DCF by code)");
      out.push(`Cost of equity ${pct(pi.r)} = 10-year yield ${pct(pi.rf)} + beta ${num(pi.beta, 2)} x equity risk premium ${pct(pi.erp)}. Free-cash-flow yield ${pct(pi.fcf_yield, 2)}: today's market cap implies free cash flow growing ${pct(pi.implied_fcf_growth)} a year for 10 years, then 3% forever. On ${pi.earn_basis} earnings (yield ${pct(pi.earn_yield, 2)}) it implies ${pct(pi.implied_eps_growth)} a year. Against: ${pi.ref_basis} ${pct(pi.ref_basis === "5-year revenue growth" ? pi.hist_rev_cagr_5y : pi.consensus_fy1_rev_growth)}; consensus next-12-month EPS growth ${pct(pi.consensus_ntm_growth)}. Code's reading: ${pi.verdict}${isNum(pi.gap) ? ` (implied minus sustained growth ${pct(pi.gap)})` : ""}.`);
    }
    // Balance-sheet cycle and earnings quality
    const cyc = f.cycle || [];
    if (cyc.length) {
      H("BALANCE-SHEET CYCLE AND EARNINGS QUALITY (code, by calendar quarter)");
      out.push(cyc.slice(-8).map((x) => `${x.q}: inventory ${isNum(x.inv_days) ? Math.round(x.inv_days) + "d" : "n/a"}, DSO ${isNum(x.dso) ? Math.round(x.dso) + "d" : "n/a"}, capex/sales ${pct(x.capex_rev)}, revenue y/y ${pct(x.rev_yoy)}, net debt/EBITDA ${num(x.nd_ebitda, 2)}`).join("\n"));
      out.push(`Year-on-year: inventory days ${pct(f.inv_days_yoy)}, DSO ${pct(f.dso_yoy)}, capex/sales ${pct(f.capex_rev_yoy)}. Quality (TTM): FCF conversion ${pct(f.fcf_conv, 0)} of net income; stock-based pay ${pct(f.sbc_rev)} of revenue (operating margin after it ${pct(f.op_margin_ex_sbc)}, FCF margin after it ${pct(f.fcf_margin_ex_sbc)}); buybacks ${pct(f.buyback_yield, 2)} of market cap; diluted share count ${pct(f.share_change)} y/y (cap-weighted). Rising inventory or receivables days faster than sales are classic signs of a cycle turning.`);
    }
    if (doc.sensitivity) { H("MEASURED MACRO SENSITIVITIES"); out.push(Sensitivity.digest(doc.sensitivity)); }
    if (doc.positioning) { H("POSITIONING"); out.push(Positioning.digest(doc.positioning)); }
    if (ctx.track) { H("TRACK RECORD"); out.push(ctx.track); }
    if (doc.history || doc.peers) { H("LONG HISTORY, BASE RATES AND SECTOR PEERS"); out.push(History.digest(doc.history, doc.peers, doc.etf)); }
    if (doc.ranking || doc.concentration || doc.credit) { H("COMPANIES, CONCENTRATION, LEVELS, LIQUIDITY AND CREDIT"); out.push(Plan.digest({ ranking: doc.ranking, conc: doc.concentration, earn: doc.plan?.earnings, liq: doc.plan?.liquidity, credit: doc.credit, lv: doc.plan?.index_levels })); }
    if (R.chain?.partners?.length) { H("VALUE CHAIN"); out.push(Chain.chainDigest(R.chain)); }
    if (R.calls?.companies?.length) { H("EARNINGS CALLS: WHAT CHANGED"); out.push(Chain.callsDigest(R.calls)); }
    out.push(`Scores 0-100 before your judgment adjustment (computed metrics plus every report section, scored by code): ${PROFILES.map((p) => `${p} ${isNum(sc.profiles?.[p]?.base) ? Math.round(sc.profiles[p].base) : "n/a"} (metrics only ${isNum(sc.profiles?.[p]?.quant) ? Math.round(sc.profiles[p].quant) : "n/a"})`).join(", ")}. Pillars: ${Object.entries(sc.pillars || {}).filter(([, v]) => isNum(v)).map(([k, v]) => `${k} ${Math.round(v)}`).join(", ")}.`);
    // Consensus and segments
    const pack = ctx.pack || {};
    if ((pack.analyst || []).length) { H("SELL-SIDE CONSENSUS (largest companies)"); out.push(pack.analyst.slice(0, 15).map((a) => `${a.symbol}: ${a.consensus || "n/a"} (buy ${a.buy}, hold ${a.hold}, sell ${a.sell ?? 0})${isNum(a.target) ? `, target $${num(a.target, 0)}` : ""}${isNum(a.upside) ? ` (${pct(a.upside, 0)} vs price)` : ""}`).join("; ")); }
    if (pack.sentiment) out.push(`News sentiment (EODHD, -1..+1): 7d ${num(pack.sentiment.last_7d, 2)}, prior 30d ${num(pack.sentiment.prior_30d, 2)}, 90d ${num(pack.sentiment.last_90d, 2)}; ${pack.sentiment.articles_30d} articles in 30 days.`);
    // KPI
    const k = R.kpi;
    if (k) {
      H("INDUSTRY KPI ANALYST");
      out.push(`Cycle: ${k.cycle_position}. ${k.cycle_text} ${k.summary}`);
      out.push("Demand metrics: " + (k.demand_metrics || []).map((m) => `${m.name} ${m.value}${m.change ? ` (${m.change})` : ""}${m.estimate ? " [estimate]" : ev(m.evidence)}`).join("; "));
      out.push("Profitability: " + (k.profitability_metrics || []).map((m) => `${m.name} ${m.value}${m.change ? ` (${m.change})` : ""}${ev(m.evidence)}`).join("; "));
      if (k.pricing_power?.level) out.push(`Pricing power ${k.pricing_power.level} (${k.pricing_power.who_has_it || ""}): ${trim(k.pricing_power.text, 400)}`);
      if (k.unit_economics?.operating_leverage) out.push(`Operating leverage ${k.unit_economics.operating_leverage}; incremental margin ${k.unit_economics.incremental_margin || "n/a"}.`);
      out.push("Demand drivers: " + (k.demand_drivers || []).map((d) => `${d.name} (${d.direction}): ${trim(d.text, 200)}${ev(d.evidence)}`).join(" | "));
      out.push("Supply drivers: " + (k.supply_drivers || []).map((d) => `${d.name} (${d.direction}): ${trim(d.text, 160)}`).join(" | "));
      out.push("Hot: " + (k.hot_segments || []).map((x) => `${x.name} ${(x.names || []).join("/")}`).join("; ") + ". Cool: " + (k.cool_segments || []).map((x) => `${x.name} ${(x.names || []).join("/")}`).join("; "));
      out.push("Management: " + (k.management_signals || []).map((m) => `${m.symbol} (${m.tone}): ${trim(m.signal, 200)}${ev(m.evidence)}`).join(" | "));
      out.push("Next triggers: " + (k.next_triggers || []).map((t) => `${t.date} ${t.event}`).join("; "));
    }
    // Macro
    const m = R.macro;
    if (m) {
      H("MACRO STRATEGIST AND INDICATOR ANALYSTS");
      if (m.regime) {
        out.push(`Regime ${m.regime} (${m.confidence}). ${m.headline} ${m.summary}`);
        if (m.state_of_world) out.push(`World + macro: ${m.state_of_world}`);
        out.push("Horizons: " + Object.entries(m.horizons || {}).map(([h, x]) => `${h} ${x.call}: ${trim(x.text, 200)}`).join(" | "));
        out.push("Channels: " + Object.entries(m.channels || {}).map(([c, x]) => `${c}: ${trim(x.text, 260)}`).join(" | "));
        out.push("Flip triggers: " + (m.flip || []).map((x) => `${x.trigger} → ${trim(x.mechanism, 140)}`).join(" | "));
      }
      const rows = ctx.macroRows || [];
      const RANK = { high: 0, medium: 1, low: 2 };
      const reads = Object.entries(m.indicators || {}).sort((a, b) => (RANK[a[1].relevance] ?? 3) - (RANK[b[1].relevance] ?? 3)).slice(0, 30);
      out.push("Indicator reads (most relevant first):");
      for (const [id, x] of reads) { const r = rows.find((y) => y.id === id); out.push(`[${id}] ${r ? `${r.label} ${r.value}${r.unit === "%" ? "%" : r.unit ? " " + r.unit : ""}${isNum(r.chg_1m) ? ` (1M ${num(r.chg_1m)}%)` : ""}` : id}: ${x.relevance} relevance, ${x.effect}. ${trim(x.driver, 320)}${x.evidence?.length && !/\[/.test(x.driver || "") ? ev(x.evidence) : ""} Why: ${trim(x.why_it_matters || x.why, 200)}`); }
    }
    // World
    const w = R.world;
    if (w?.dives?.length) {
      H("WORLD-EVENTS TEAM: LIVE SITUATIONS (deep dives)");
      for (const d of w.dives) {
        out.push(`* ${d.title} — ${d.stance} for the industry; ${d.status || ""}; ${d.region || ""}. ${trim(d.summary, 400)} Now: ${trim(d.now, 300)} Trigger: ${trim(d.trigger, 200)}`);
        const ch = Object.entries(d.channels || {}).flatMap(([c, a]) => (a || []).map((x) => `${c}/${x.name} ${x.direction}${x.magnitude ? " " + x.magnitude : ""}${x.exposed?.length ? ` (${x.exposed.join("/")})` : ""}`));
        if (ch.length) out.push(`  Channels: ${ch.join("; ")}`);
        if ((d.fs_impact || []).length) out.push(`  P&L: ${d.fs_impact.map((x) => `${x.lever} ${x.direction}${x.magnitude ? " " + x.magnitude : ""} (${x.timing})`).join("; ")}`);
        if ((d.scenarios || []).length) out.push(`  Scenarios: ${d.scenarios.map((x) => `${x.name} ${x.probability}%: ${trim(x.outcome, 100)}; earnings ${trim(x.earnings, 60)}`).join(" | ")}`);
        if ((d.winners || []).length || (d.losers || []).length) out.push(`  Winners: ${(d.winners || []).map((x) => x.symbol).join(", ")}; losers: ${(d.losers || []).map((x) => x.symbol).join(", ")}`);
        const cites = [...new Set([...(d.developments || []).flatMap((x) => x.evidence || []), ...(d.scout_evidence || [])])].slice(0, 6);
        if (cites.length) out.push(`  Sources: ${cites.join(", ")}`);
      }
    }
    // Trade
    const t = R.trade;
    if (t) {
      H("TRADE-RELATIONS TEAM");
      if (t.verdict) out.push(`Supply chain ${t.verdict.rating} (health ${t.verdict.health?.score ?? "n/a"}/100): ${t.verdict.headline} ${trim(t.verdict.summary, 500)} Pass-through ${t.verdict.investment_read?.pass_through || "n/a"}, de-rating risk ${t.verdict.investment_read?.derate_risk || "n/a"}: ${trim(t.verdict.investment_read?.text, 300)}`);
      if ((t.verdict?.bottlenecks || []).length) out.push("Bottlenecks: " + t.verdict.bottlenecks.map((b) => `${b.chokepoint} (${(b.countries || []).join("/")}, ${b.severity})`).join("; "));
      out.push("Countries (relationship with the US): " + (t.map?.countries || []).map((c) => `${c.rank}. ${c.country} ${c.importance} ${c.stance}/${c.trajectory}${c.threat && c.threat !== "none" ? `, ${c.threat} security threat (${c.threat_note || ""})` : ""} (${(c.roles || []).join(", ")})`).join("; "));
      for (const d of t.countries || []) { const top = (d.risks || []).filter((x) => x.likelihood !== "low" || x.impact === "high").slice(0, 3);
        if (top.length || d.security?.threat_level && d.security.threat_level !== "none") out.push(`  ${d.country}: ${d.relationship?.alliance || ""} ${top.map((x) => `${x.risk} (${x.likelihood}/${x.impact}${x.tickers?.length ? "; " + x.tickers.join("/") : ""})`).join("; ")}${d.security?.threat_level && d.security.threat_level !== "none" ? ` Security ${d.security.threat_level}: ${trim(d.security.threat, 140)}; if it happens: ${trim(d.security.industry_impact, 200)}` : ""}`); }
      out.push("Most exposed: " + (t.verdict?.most_exposed || []).map((x) => `${x.symbol} ${trim(x.why, 80)}`).join("; ") + ". Most resilient: " + (t.verdict?.most_resilient || []).map((x) => x.symbol).join(", "));
    }
    // Regulation
    const g = R.reg;
    if (g) {
      H("REGULATION, LEGAL AND DEALS ANALYST");
      out.push(trim(g.summary, 700));
      if ((g.policy || []).length) out.push("Policy: " + g.policy.map((p) => `${p.title} (${p.status}, ${p.direction}): ${trim(p.impact, 160)}${ev(p.evidence)}`).join(" | "));
      if ((g.litigation || []).length) out.push("Litigation: " + g.litigation.map((l) => `${l.case} (${l.status}): ${trim(l.stakes, 120)}${ev(l.evidence)}`).join(" | "));
      if ((g.deals || []).length) out.push("Deals: " + g.deals.map((x) => `${x.title} ${x.value || ""} (${x.status})${ev(x.evidence)}`).join(" | "));
      if (g.consolidation) out.push(`Consolidation: ${trim(g.consolidation, 300)}`);
      if (g.perception?.summary) out.push(`Perception (${g.perception.trend}): ${trim(g.perception.summary, 300)}`);
    }
    // Rule books and the regulatory verdict
    const books = ctx.books || [];
    if (books.length) {
      H("REGULATORY RULE BOOKS (fact-checked)");
      for (const b of books) {
        out.push(`* ${b.body}${b.book ? "" : ": rule book could not be built"}`);
        for (const r of b.book?.rules || []) out.push(`  - [${r.severity}] ${r.name} (${r.status}${r.numeric_value ? "; " + r.numeric_value : ""}): ${trim(r.industry_impact, 300)} Next: ${(r.next_12_months?.events || []).map((e) => `${e.date} ${trim(e.event, 80)}`).join("; ") || "n/a"}. Bottom line: ${trim(r.bottom_line, 200)}`);
      }
    }
    const v = ctx.regVerdict;
    if (v) { out.push(`Regulatory verdict: ${v.stance} (${v.intensity}). ${v.headline} ${trim(v.summary, 600)} Most material: ${(v.most_material || []).map((x) => `${x.rule} (${x.body})`).join("; ")}. Winners ${(v.winners || []).map((x) => x.symbol).join(", ")}; losers ${(v.losers || []).map((x) => x.symbol).join(", ")}.`); }
    // News
    const items = [...(pack.items || [])].sort((a, b) => (a.date < b.date ? 1 : -1));
    const pri = (i) => ({ M: 0, P: 1, N: 2, E: 3, W: 4 }[i.kind] ?? 5);
    const news = items.sort((a, b) => pri(a) - pri(b) || (a.date < b.date ? 1 : -1)).slice(0, 70);
    if (news.length) { H("COMPANY AND MARKET NEWS (cite by ID)"); out.push(news.map((i) => `[${i.id}] ${i.date} · ${i.source || ""}${i.symbol ? " · " + i.symbol : ""} — ${trim(i.title, 160)}`).join("\n")); }
    // Source index for every other ID the dossier cites
    const text = out.join("\n");
    const ids = [...new Set([...text.matchAll(/\[([^\]]+)\]/g)].flatMap((x) => x[1].split(/,\s*/)).concat([...text.matchAll(/Sources: ([A-Z0-9, ]+)/g)].flatMap((x) => x[1].split(/,\s*/))).map((x) => x.trim()).filter((x) => /^[A-Z]{1,2}\d+$/.test(x) && !/^I\d+$/.test(x)))];
    const idx = ctx.idx || {};
    const listed = new Set(news.map((i) => i.id));
    const srcLines = ids.filter((id) => idx[id] && !listed.has(id)).slice(0, 160).map((id) => `[${id}] ${idx[id].date || ""} · ${idx[id].source || ""} — ${trim(idx[id].title, 150)}`);
    return text + (srcLines.length ? `\n\n=== SOURCE INDEX (what the IDs above are) ===\n${srcLines.join("\n")}` : "");
  }

  const RULES = `RULES
- You are the head of research. The specialist reports are your team's work: weigh them, connect them, and resolve their disagreements; don't just restate them.
- Reason like a portfolio manager: second-order effects, what the market already prices, asymmetry of outcomes, timing. Quantify wherever the dossier gives numbers (cite the metric values).
- Every factual claim about a current event cites source IDs in brackets ([G12], [N4], [RA3], [X7]) that appear in the dossier; indicator IDs ([I5]) are fine too. Never invent events, numbers, IDs, quotes or dates. Tickers only from the industry's companies.
- Name real-world causes (the conflict, the rule, the release, the decision), not just "macro" or "headwinds".
- Plain, precise English. No hype, no hedging boilerplate.`;

  function synthesisPrompt(doc, ctx) {
    return `You are the head of research (the lead strategist) for the US-listed "${doc.name}" industry (its 50 largest companies). Today is ${ctx.today}. Every specialist report and every regulatory rule book is finished; the full dossier is below. Write the investment synthesis that ties all of it together.

${ctx.dossier}

${RULES}
${ctx.tools ? "- You may call search_company_news or search_mna if one specific question can't be answered from the dossier; cite what they return by URL in the evidence lists." : ""}

TASK
1. Decide what actually drives this industry's returns over the next 12 months, across every section (quant, KPIs, macro, world, trade, regulation, rule books, valuation, news, consensus). Rank by impact.
2. Identify the 2-4 debates the market is having about it, with the strongest bull and bear argument for each and what will resolve it.
3. Judge what the current valuation already prices in, against growth, margins, risks and history.
4. Find where the specialist reports pull in different directions and resolve it.
(The bull/base/bear scenarios are built next, in a separate step.)

Reply with ONLY this JSON:
{"headline": "one sentence verdict that a PM could act on",
 "thesis": "6-9 sentences: the core argument, connecting the drivers, what is priced in, and the asymmetry; cite IDs",
 "summary": "4-6 sentences for a general reader: what is happening, why, what it means",
 "drivers": [{"rank": 1, "title": "short", "direction": "tailwind | headwind | mixed", "magnitude": "high | medium | low", "horizon": "0-3M | 3-12M | 12M+", "text": "2-4 sentences with the mechanism into revenue, margins, capex or multiples, quantified where possible, cited", "sections": ["kpi", "macro", "world", "trade", "regulation", "rulebooks", "valuation", "quant", "news", "consensus"]}],
 "debates": [{"question": "the debate", "bull": "best bull argument, cited", "bear": "best bear argument, cited", "resolves_with": "the data, event or date that settles it", "lean": "bull | bear | balanced", "why": "one sentence on your lean"}],
 "priced_in": "3-4 sentences: what the P/E vs history, growth, margins and consensus imply the market expects, and whether that is too high or too low",
 "tensions": [{"between": "e.g. macro vs KPI", "text": "where they disagree", "resolution": "which is right and why"}],
 "change_mind": ["specific, measurable things that would change this view"],
 "confidence": "low | medium | high"}
Sizes: 4-6 drivers, 2-4 debates, 0-4 tensions, 3-5 change_mind.`;
  }

  /** Step 2: scenarios built section by section, with numbers code can check, and the opportunity call. */
  function scenarioPrompt(doc, ctx, syn) {
    const f = doc.fund || {};
    const bp = basePE(doc), fw = doc.forward || {};
    const facts = `The scenario math starts from the ${bp.basis} P/E of ${num(bp.pe)}${bp.basis === "forward" ? ` (next-twelve-month consensus EPS; expected EPS growth ${pct(fw.ntm_eps_growth)}; estimates ${pct(fw.rev30)} over 30 days)` : ""}. Trailing aggregate P/E ${f.pe_negative ? "negative" : num(f.pe)} (5-year median ${num(f.pe_hist_median)}, ${pct(f.pe_hist_pct, 0)} percentile); TTM revenue growth ${pct(f.rev_growth)}, earnings growth ${pct(f.ni_growth)}, operating margin ${pct(f.op_margin)}; dividend yield ${pct(f.div_yield, 2)}; 1Y vs SPY ${pct(doc.summary?.excess_cw_1Y)}; beta ${num(doc.summary?.beta, 2)}; max drawdown 1Y ${pct(doc.summary?.max_dd_1y)}.`;
    return `You are the head of research for the US-listed "${doc.name}" industry. Today is ${ctx.today}. Build the bull, base and bear scenarios for the next 12 months from EVERY section of the dossier, then decide whether this is a real investment opportunity.

YOUR SYNTHESIS (already written)
${JSON.stringify({ headline: syn?.headline, thesis: syn?.thesis, drivers: syn?.drivers, debates: syn?.debates, priced_in: syn?.priced_in, tensions: syn?.tensions })}

CODE FACTS: ${facts}

${ctx.dossier}

${RULES}
- Each scenario must say what happens in EVERY one of these sections, consistent with what that section's report found (cite its sources): ${SCN_SECTIONS.map(([k, l]) => `"${k}" (${l})`).join(", ")}. One or two specific sentences each, never "no change" without saying why.
- Numbers: ${bp.basis === "forward" ? `"eps_change" = how the industry's next-twelve-month earnings come in vs today's consensus, in %, as [low, high] (0 = exactly consensus); "pe" = the forward P/E at the end, as [low, high]` : `"eps_change" = change in industry earnings over 12 months vs the current trajectory, in %, as [low, high]; "pe" = the multiple at the end, as [low, high]`}; "price_move" = the industry's 12-month price change in %, as [low, high]. They must be consistent: price change ≈ (1 + EPS change) × (end P/E ÷ ${num(bp.pe)}) − 1. Code checks this.
- Anchor the scenarios on the hard data: consensus estimates and their revisions, what's priced in (reverse DCF), the balance-sheet cycle (inventory and receivables days), positioning, and the measured sensitivities to rates, oil, the dollar and credit. Use your track record, if any, to calibrate the ranges and probabilities.
- Probabilities sum to 100 and reflect the evidence, not symmetry. Code computes the expected return, reward-to-risk and probability of loss from your numbers.
- "opportunity": is this a real opportunity for a 12-month investor right now? "yes" only if the probability-weighted return is clearly positive and the upside outweighs the downside; "conditional" if it becomes one on specific, dated triggers; "no" otherwise. Name the best ways to express it (tickers) and what to avoid, from the industry's companies only.

Reply with ONLY this JSON:
{"scenarios": {"bull": {"probability": 25, "narrative": "2-3 sentences", "triggers": ["dated, measurable"], "sections": {${SCN_KEYS.map((k) => `"${k}": "..."`).join(", ")}}, "eps_change": [0, 5], "pe": [28, 32], "price_move": [20, 30], "earnings": "one sentence", "valuation": "one sentence"}, "base": {...}, "bear": {...}},
 "opportunity": {"verdict": "yes | conditional | no", "headline": "one sentence", "why": "3-5 sentences weighing the scenarios, what is priced in and the asymmetry", "entry_triggers": ["dated, measurable conditions that would make it a buy"], "best_expressions": [{"symbol": "TICKER", "why": "..."}], "avoid": [{"symbol": "TICKER", "why": "..."}], "horizon": "e.g. 6-12 months"}}`;
  }

  /**
   * Scenario math, by code: expected 12-month return, upside and downside, reward-to-risk, probability of loss,
   * expected EPS change, and whether each scenario's price move matches its EPS and P/E (vs today's P/E).
   */
  function scenarioMath(scn, currentPE) {
    const mid = (r) => (Array.isArray(r) && r.length && r.every((x) => isNum(Number(x))) ? r.reduce((a, x) => a + Number(x), 0) / r.length : NaN);
    const ks = ["bull", "base", "bear"].filter((k) => scn?.[k]);
    const P = Object.fromEntries(ks.map((k) => [k, (Number(scn[k].probability) || 0) / 100]));
    const pm = Object.fromEntries(ks.map((k) => [k, mid(scn[k].price_move)]));
    if (!ks.length || ks.some((k) => !isNum(pm[k]))) return null;
    const ev = ks.reduce((a, k) => a + P[k] * pm[k], 0);
    const gain = ks.reduce((a, k) => a + P[k] * Math.max(pm[k], 0), 0), loss = ks.reduce((a, k) => a + P[k] * Math.max(-pm[k], 0), 0);
    const eps = ks.every((k) => isNum(mid(scn[k].eps_change))) ? ks.reduce((a, k) => a + P[k] * mid(scn[k].eps_change), 0) : NaN;
    const checks = ks.map((k) => {
      const e = mid(scn[k].eps_change), pe = mid(scn[k].pe);
      if (!isNum(e) || !isNum(pe) || !isNum(currentPE) || currentPE <= 0) return { scenario: k, implied: null, stated: pm[k], ok: null };
      const implied = ((1 + e / 100) * (pe / currentPE) - 1) * 100;
      return { scenario: k, implied: Math.round(implied * 10) / 10, stated: pm[k], ok: Math.abs(implied - pm[k]) <= 10 };
    });
    const r1 = (x) => Math.round(x * 10) / 10;
    const verdict = ev >= 10 && (loss ? gain / loss : 9) >= 1.5 ? "attractive" : ev >= 4 ? "modest" : ev > -4 ? "no clear edge" : "unattractive";
    return { expected_return: r1(ev), upside: r1(pm.bull ?? NaN), downside: r1(pm.bear ?? NaN), reward_risk: loss ? r1(gain / loss) : null, prob_loss: Math.round(100 * ks.reduce((a, k) => a + (pm[k] < 0 ? P[k] : 0), 0)),
      expected_eps: isNum(eps) ? r1(eps) : null, checks, code_verdict: verdict };
  }

  const { HORIZONS, indexVol, horizonFacts, horizonChecks } = Horizon;
  /** Step 3: the 1M, 3M, 6M and 12M calls, from every section, the dated calendar and the standing situations. */
  function horizonPrompt(doc, ctx, draft) { return Horizon.horizonPrompt(doc, ctx, draft, SCN_KEYS, Object.fromEntries(SCN_SECTIONS), RULES); }

  /** The red team: an independent investor whose job is to prove the draft wrong, with a pre-mortem. */
  function draftStance(draft) {
    const o = draft?.opportunity?.verdict, sc = draft?.scenarios || {};
    const bull = Number(sc.bull?.probability) || 0, bear = Number(sc.bear?.probability) || 0;
    return o === "no" || (o !== "yes" && bear > bull) ? "negative" : "constructive";
  }
  function redTeamPrompt(doc, ctx, draft) {
    const neg = draftStance(draft) === "negative";
    const role = neg ? "an independent long-only investor who thinks the market is too pessimistic" : "an independent short seller";
    return `You are ${role}. You did not write the draft below and you are paid to find where it is wrong about the US-listed "${doc.name}" industry. Today is ${ctx.today}.

THE DRAFT (by the head of research)
${JSON.stringify({ headline: draft?.headline, thesis: draft?.thesis, drivers: draft?.drivers, scenarios: draft?.scenarios, horizons: draft?.horizons, opportunity: draft?.opportunity, priced_in: draft?.priced_in, profiles: Object.fromEntries(Object.entries(draft?.profiles || {}).map(([k, v]) => [k, { fit: v?.fit, verdict: v?.verdict }])) })}
${ctx.math ? `CODE-COMPUTED SCENARIO MATH: expected 12-month return ${ctx.math.expected_return}%, probability of loss ${ctx.math.prob_loss}%.` : ""}

${ctx.dossier}

${RULES}
- Build the strongest ${neg ? "bull" : "bear"} case the evidence supports. Attack the draft's weakest assumptions with specific numbers and sources from the dossier: estimates and revisions, what's priced in, the balance-sheet cycle, positioning, base rates from the long history, customers' and suppliers' numbers, changes in the earnings calls, credit, decisions and conflicts ahead.
- Pre-mortem: assume it is 12 months from now and the draft turned out badly wrong. Write what most plausibly happened, how likely it is, and the earliest observable warning sign, dated where possible.
- Be fair: don't invent problems; severity "high" only for something that would change the call.

Reply with ONLY this JSON:
{"stance": "${neg ? "long" : "short"}", "thesis": "4-6 sentences: your case, cited",
 "arguments": [{"claim": "one sentence", "evidence": "the specific numbers and IDs from the dossier", "draft_says": "the draft's assumption you are attacking", "severity": "high | medium | low"}],
 "premortem": [{"what_happened": "2-3 sentences", "probability": 20, "early_warning": "dated, observable signal"}],
 "blind_spots": ["things the draft didn't weigh"],
 "kill_criteria": ["measurable facts that would prove the draft's call wrong"]}
Sizes: 3-6 arguments, 2-4 pre-mortem paths, 0-4 blind spots, 2-4 kill criteria.`;
  }
  function cleanRedTeam(raw, clean, en) {
    if (!raw || typeof raw !== "object") return null;
    const arr = (x, k) => (Array.isArray(x) ? x : []).slice(0, k);
    const r = { stance: en(raw.stance, ["short", "long"], "short"), thesis: clean(raw.thesis, 1400),
      arguments: arr(raw.arguments, 6).map((a, i) => ({ n: i + 1, claim: clean(a?.claim, 300), evidence: clean(a?.evidence, 600), draft_says: clean(a?.draft_says, 300), severity: en(a?.severity, ["high", "medium", "low"], "medium") })).filter((a) => a.claim),
      premortem: arr(raw.premortem, 4).map((p) => ({ what_happened: clean(p?.what_happened, 600), probability: Math.max(0, Math.min(100, Math.round(Number(p?.probability) || 0))), early_warning: clean(p?.early_warning, 300) })).filter((p) => p.what_happened),
      blind_spots: arr(raw.blind_spots, 4).map((x) => clean(x, 300)).filter(Boolean), kill_criteria: arr(raw.kill_criteria, 4).map((x) => clean(x, 300)).filter(Boolean) };
    return r.thesis || r.arguments.length ? r : null;
  }

  function verdictsPrompt(doc, ctx, syn) {
    return `You are the head of research for the US-listed "${doc.name}" industry. Today is ${ctx.today}. You have written the synthesis below from the full dossier. Now write the verdict for each investor type, the section notes and the landscape scorecard, consistent with the synthesis.

YOUR SYNTHESIS, SCENARIOS AND OPPORTUNITY CALL
${JSON.stringify(syn)}
${ctx.math ? `\nCODE-COMPUTED SCENARIO MATH: expected 12-month return ${ctx.math.expected_return}%, upside ${ctx.math.upside}%, downside ${ctx.math.downside}%, reward-to-risk ${ctx.math.reward_risk ?? "n/a"}, probability of loss ${ctx.math.prob_loss}%, expected EPS change ${ctx.math.expected_eps ?? "n/a"}%.` : ""}
${ctx.calendar ? `\n${Horizon.calendarText(ctx.calendar)}\n` : ""}
${ctx.dossier}

${RULES}
- Every investor verdict must weigh EVERY section, not just the metrics: in "section_reads" give one specific sentence per section on what it means for THAT investor type (${SCN_SECTIONS.map(([k, l]) => `"${k}" = ${l}`).join(", ")}), and let the verdict and fit follow from all of them and from the scenario math. Refer to the pillar scores in the dossier where useful.
- Weigh the important decisions ahead and the wars, conflicts and threats (DATED CALENDAR and STANDING SITUATIONS, cite C- and S-IDs) in each investor verdict and in catalysts, risks and watch, and keep the verdicts consistent with your 1M, 3M, 6M and 12M calls.
- Investor types: Income = dividends and stability; Conservative = capital preservation, low drawdowns; Growth = revenue and earnings growth; Aggressive = momentum and high risk tolerance.
- "overlay": integer -5..+5 per investor type: your judgment on top of the scores, which already include every report section (KPIs, macro, world, trade, regulation, sentiment, consensus). Use it only for what those pillars miss or mis-weigh (interactions between sections, timing, asymmetry), and justify it in "adjustment_why". 0 is a fine answer.
- Dimension scores: -2 strong headwind, -1 headwind, 0 neutral/unclear, +1 tailwind, +2 strong tailwind; each needs cited evidence or it is 0.

Reply with ONLY this JSON:
{"profiles": {"income": {"fit": "strong | moderate | weak", "conviction": "high | medium | low", "verdict": "3-4 sentences: fit for this investor and why, with numbers, drawing on all sections and the scenario math", "section_reads": {${SCN_KEYS.map((k) => `"${k}": "one sentence"`).join(", ")}}, "overlay": 0, "adjustment_why": "one sentence", "what_changes": "what would change this verdict"}, "conservative": {...}, "growth": {...}, "aggressive": {...}},
 "sections": {"performance": "2-3 sentences interpreting the numbers and WHY they look like this", "risk": "...", "fundamentals": "...", "valuation": "...", "earnings": "...", "health": "..."},
 "dimensions": {"macro": {"score": 0, "summary": "2-4 sentences", "evidence": ["G3"]}, "news": {...}, "world_events": {...}, "regulatory": {"score": 0, "summary": "...", "evidence": [], "bodies": [{"name": "BIS", "why": "export licenses"}]}, "perception": {...}, "mna": {...}, "legal": {...}},
 "catalysts": ["up to 6, dated where possible, each citing IDs in brackets"], "risks": ["up to 6, each citing IDs in brackets"],
 "watch": ["up to 6 dated events or data releases, with what outcome would matter"]}
At most 5 evidence IDs per dimension.`;
  }

  function reviewPrompt(doc, ctx, draft) {
    return `You are a skeptical senior reviewer on the investment committee. Check the head of research's draft on the "${doc.name}" industry against the full dossier. Today is ${ctx.today}.

DRAFT
${JSON.stringify(draft)}
${ctx.math ? `\nCODE-COMPUTED SCENARIO MATH (from the draft's own numbers): expected 12-month return ${ctx.math.expected_return}%, reward-to-risk ${ctx.math.reward_risk ?? "n/a"}, probability of loss ${ctx.math.prob_loss}%, code's reading: ${ctx.math.code_verdict}. Consistency of price move with EPS and P/E: ${ctx.math.checks.map((c) => `${c.scenario} stated ${c.stated}% vs implied ${c.implied ?? "n/a"}%${c.ok === false ? " (INCONSISTENT)" : ""}`).join("; ")}.` : ""}
${ctx.hchecks?.length ? `\nHORIZON CHECKS BY CODE: ${ctx.hchecks.map((c) => c.missing ? `${c.h}: MISSING` : `${c.h}: midpoint ${c.mid ?? "n/a"}% (one sigma ±${c.sigma ?? "n/a"}%)${c.issues.length ? ` INCONSISTENT: ${c.issues.join("; ")}` : ""}${c.missing_events?.length ? `; skips decisions/events ${c.missing_events.join(", ")}` : ""}${c.missing_standing?.length ? `; skips wars/conflicts/situations ${c.missing_standing.join(", ")}` : ""}${c.missing_sections?.length ? `; no read for ${c.missing_sections.join(", ")}` : ""}`).join(" | ")}.` : ""}
${ctx.calendar ? `\n${Horizon.calendarText(ctx.calendar)}` : ""}
${ctx.redteam ? `\nRED TEAM (an independent ${ctx.redteam.stance === "short" ? "short seller" : "contrarian long"} argued against the draft)\nThesis: ${ctx.redteam.thesis}\n${ctx.redteam.arguments.map((a) => `Argument ${a.n} [${a.severity}]: ${a.claim} Evidence: ${a.evidence} Attacks: ${a.draft_says}`).join("\n")}\nPre-mortem: ${ctx.redteam.premortem.map((p) => `${p.probability}%: ${p.what_happened} Warning: ${p.early_warning}`).join(" | ")}\nBlind spots: ${ctx.redteam.blind_spots.join("; ") || "none"}` : ""}
${ctx.gaps?.length ? `\nCOVERAGE GAPS FOUND BY CODE: ${ctx.gaps.join("; ")}.` : ""}

${ctx.dossier}

CHECK FOR
- Every scenario must cover every section (${SCN_KEYS.join(", ")}) consistently with that section's report; every investor verdict must have a read for every section. Fill any gap listed above.
- Scenario numbers that are inconsistent (price move vs EPS and P/E), probabilities that ignore the evidence, and an opportunity verdict that contradicts the code-computed expected return or reward-to-risk.
- The 1M, 3M, 6M and 12M calls: each must exist, read every section for that window, cover every important decision in the window and every war, conflict and threat (by C- and S-ID), agree with its own range and probability, and the 12M call must agree with the scenarios. Fix every horizon check listed above; when revising "horizons", give the complete corrected object for each horizon you change.
- A major factor in the dossier that the draft misses or underweights (a high-severity rule, an adverse world situation, a supply-chain bottleneck, a restrictive macro call, a valuation extreme, weak breadth).
- Numbers that contradict the dossier, or claims with no support in it; citations that don't fit the claim.
- Internal contradictions (headline vs scenarios vs investor verdicts vs overlays), scenario probabilities that don't sum to 100, drivers ranked wrongly.
- Generic statements that could apply to any industry; replace them with specifics from the dossier.
- Every red-team argument (if any): weigh it on the evidence. Where it is right, revise the affected fields; where it is wrong, say why. Answer each one in "redteam_responses".

${RULES}

Reply with ONLY this JSON:
{"issues": [{"field": "which field", "problem": "one sentence", "severity": "high | medium | low"}],
 "revisions": {"<field name>": <complete corrected value>},
 "redteam_responses": [{"n": 1, "verdict": "accepted | partly | rejected", "why": "one or two sentences", "change": "what you revised, or 'none'"}]}
Allowed revision fields: headline, thesis, summary, drivers, debates, scenarios, horizons, opportunity, priced_in, tensions, change_mind, confidence, profiles, sections, dimensions, catalysts, risks, watch. Give the COMPLETE corrected value for each field you revise (e.g. the whole "drivers" array). Revise only what needs fixing; return {"issues": [], "revisions": {}} if the draft is sound.`;
  }

  /** Merge the review's revisions into the draft (only allowed top-level fields). */
  function applyReview(draft, review) {
    const allowed = new Set(["headline", "thesis", "summary", "drivers", "debates", "scenarios", "horizons", "opportunity", "priced_in", "tensions", "change_mind", "confidence", "profiles", "sections", "dimensions", "catalysts", "risks", "watch"]);
    const out = { ...draft };
    const rev = review?.revisions && typeof review.revisions === "object" ? review.revisions : {};
    const applied = [];
    for (const [k, v] of Object.entries(rev)) {
      if (!allowed.has(k) || v === null || v === undefined) continue;
      if ((k === "profiles" || k === "scenarios" || k === "horizons") && typeof v === "object" && !Array.isArray(v)) { out[k] = { ...(draft[k] || {}) }; for (const [kk, vv] of Object.entries(v)) out[k][kk] = vv && typeof vv === "object" && !Array.isArray(vv) ? { ...(draft[k]?.[kk] || {}), ...vv } : vv; }
      else if ((k === "dimensions" || k === "sections" || k === "opportunity") && typeof v === "object" && !Array.isArray(v)) out[k] = { ...(draft[k] || {}), ...v };
      else out[k] = v;
      applied.push(k);
    }
    if (Array.isArray(review?.redteam_responses)) out.redteam_responses = review.redteam_responses.slice(0, 8);
    const issues = (Array.isArray(review?.issues) ? review.issues : []).slice(0, 12).map((i) => ({ field: trim(i?.field, 40), problem: trim(i?.problem, 240), severity: ["high", "medium", "low"].includes(i?.severity) ? i.severity : "medium" })).filter((i) => i.problem);
    return { merged: out, applied, issues };
  }

  /**
   * Critic. idx: every retrievable source by ID (news, wire, world/trade/macro
   * sources, rule-book sources, indicators). seenUrls: URLs the tools returned.
   */
  function critic(raw, idx, doc, seenUrls, today = null, cal = null) {
    const tickers = new Set((doc.constituents || []).map((c) => String(c.symbol).toUpperCase()));
    const seen = new Set(seenUrls || []);
    const stats = { kept: 0, dropped: 0 };
    const clean = (x, n = 1200) => trim(x, n * 2).replace(/\[([A-Z]{1,6}\d{1,4}(?:\s*,\s*[A-Z]{1,6}\d{1,4})*)\]/gi, (m, g) => {
      const ids = g.split(/\s*,\s*/).map((s) => s.toUpperCase()); const ok = ids.filter((i) => idx[i]);
      stats.kept += ok.length; stats.dropped += ids.length - ok.length; return ok.length ? `[${ok.join(", ")}]` : "";
    }).replace(/\s+([.,;])/g, "$1").replace(/\s{2,}/g, " ").trim().slice(0, n);
    const en = (x, list, d) => { const s = String(x ?? "").toLowerCase().trim(); return list.find((l) => l === s) || list.find((l) => s.startsWith(l)) || d; };
    const arr = (x, n) => (Array.isArray(x) ? x : []).slice(0, n);
    const refsOf = (t) => [...String(t).matchAll(/\[([^\]]+)\]/g)].flatMap((m) => m[1].split(/,\s*/)).filter((id) => idx[id]).map((id) => ({ id, url: idx[id].url || null }));
    const resolve = (e) => {
      if (typeof e === "string") { const id = e.replace(/[\[\]\s]/g, "").toUpperCase(); const it = idx[id]; return it ? { id, claim: it.title, url: it.url || null, date: it.date, source: it.source } : null; }
      if (e && typeof e === "object") {
        if (e.id && idx[String(e.id).toUpperCase()]) { const id = String(e.id).toUpperCase(); const it = idx[id]; return { id, claim: trim(e.claim || it.title, 280), url: it.url || null, date: it.date, source: it.source }; }
        let k = null; try { const u = new URL(String(e.url)); k = (u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/+$/, "") + u.search).toLowerCase(); } catch {}
        if (k && seen.has(k)) return { claim: trim(e.claim, 280), url: String(e.url), date: String(e.date || "").slice(0, 10), source: trim(e.source, 60) };
      }
      return null;
    };
    const out = { headline: clean(raw?.headline, 300), thesis: clean(raw?.thesis, 2400), summary: clean(raw?.summary, 1400), priced_in: clean(raw?.priced_in, 900),
      confidence: en(raw?.confidence, ["low", "medium", "high"], "low") };
    out.drivers = arr(raw?.drivers, 6).map((d, i) => ({ rank: i + 1, title: clean(d?.title, 90), direction: en(d?.direction, ["tailwind", "headwind", "mixed"], "mixed"), magnitude: en(d?.magnitude, ["high", "medium", "low"], "medium"),
      horizon: trim(d?.horizon, 12), text: clean(d?.text, 900), sections: arr(d?.sections, 6).map((x) => String(x).toLowerCase()).filter((x) => SOURCES.includes(x)) })).filter((d) => d.title && d.text);
    out.debates = arr(raw?.debates, 4).map((d) => ({ question: clean(d?.question, 200), bull: clean(d?.bull, 600), bear: clean(d?.bear, 600), resolves_with: clean(d?.resolves_with, 240), lean: en(d?.lean, ["bull", "bear", "balanced"], "balanced"), why: clean(d?.why, 300) })).filter((d) => d.question && (d.bull || d.bear));
    // Scenarios: probabilities normalized to 100
    const scn = {};
    const rng = (r) => (Array.isArray(r) ? r.map(Number).filter((x) => isNum(x)).slice(0, 2) : isNum(Number(r)) ? [Number(r)] : []).sort((a, b) => a - b);
    for (const k of ["bull", "base", "bear"]) { const x = raw?.scenarios?.[k]; if (!x) continue;
      scn[k] = { probability: Math.max(0, Number(x.probability) || 0), narrative: clean(x.narrative, 700), triggers: arr(x.triggers, 5).map((t) => clean(t, 220)).filter(Boolean), earnings: clean(x.earnings, 300), valuation: clean(x.valuation, 300),
        sections: Object.fromEntries(SCN_KEYS.map((s) => [s, clean(x.sections?.[s], 420)]).filter(([, t]) => t)), eps_change: rng(x.eps_change), pe: rng(x.pe), price_move: rng(x.price_move) }; }
    const tot = Object.values(scn).reduce((a, x) => a + x.probability, 0);
    if (tot > 0) { for (const x of Object.values(scn)) x.probability = Math.round((x.probability / tot) * 100); const diff = 100 - Object.values(scn).reduce((a, x) => a + x.probability, 0); if (scn.base) scn.base.probability += diff; }
    out.scenarios = scn;
    const bp = basePE(doc);
    out.math = scenarioMath(scn, Number(bp.pe));
    if (out.math) out.math.pe_basis = bp.basis;
    // Calls by horizon: every section, every important decision, every war and threat; checked against their own numbers,
    // the index's volatility, the scenario math and the calendar.
    const hz = Horizon.cleanHorizons(raw?.horizons, { clean, en, keys: SCN_KEYS, cal });
    out.horizons = hz;
    const facts = horizonFacts(doc, String(today || doc.as_of || new Date().toISOString().slice(0, 10)));
    out.horizon_facts = facts;
    out.horizon_checks = Object.keys(hz).length ? horizonChecks(hz, facts, out.math, cal, SCN_KEYS) : [];
    const o = raw?.opportunity || {};
    const tk = (x) => { const s = String(x?.symbol || x || "").toUpperCase().replace(/[^A-Z0-9.\-]/g, ""); return tickers.has(s) ? s : ""; };
    out.opportunity = o.verdict ? { verdict: en(o.verdict, ["yes", "conditional", "no"], "conditional"), headline: clean(o.headline, 300), why: clean(o.why, 1200), horizon: trim(o.horizon, 40),
      entry_triggers: arr(o.entry_triggers, 5).map((x) => clean(x, 240)).filter(Boolean),
      best_expressions: arr(o.best_expressions, 5).map((x) => ({ symbol: tk(x), why: clean(x?.why, 260) })).filter((x) => x.symbol),
      avoid: arr(o.avoid, 5).map((x) => ({ symbol: tk(x), why: clean(x?.why, 260) })).filter((x) => x.symbol) } : null;
    // Where the strategist's call disagrees with its own numbers, say so plainly.
    if (out.opportunity && out.math) {
      const m = out.math, v = out.opportunity.verdict;
      out.opportunity.consistent = !((v === "yes" && (m.expected_return < 4 || (m.reward_risk !== null && m.reward_risk < 1.2))) || (v === "no" && m.expected_return >= 10));
    }
    // Coverage: every scenario and every investor read should address every section.
    out.gaps = [];
    for (const [k, x] of Object.entries(scn)) { const miss = SCN_KEYS.filter((s) => !x.sections[s]); if (miss.length) out.gaps.push(`${k} scenario lacks ${miss.join(", ")}`); }
    if (raw?.horizons) { const miss = HORIZONS.map(([h]) => h).filter((h) => !hz[h]); if (miss.length) out.gaps.push(`no ${miss.join(", ")} call`);
      for (const c of out.horizon_checks) { if (c.missing) continue;
        if (c.missing_events?.length) out.gaps.push(`${c.h} call skips decisions/events ${c.missing_events.join(", ")}`);
        if (c.missing_standing?.length) out.gaps.push(`${c.h} call skips wars/conflicts/situations ${c.missing_standing.join(", ")}`);
        if (c.missing_sections?.length) out.gaps.push(`${c.h} call lacks ${c.missing_sections.join(", ")}`); } }
    out.redteam = cleanRedTeam(raw?.redteam, clean, en);
    out.redteam_responses = arr(raw?.redteam_responses, 8).map((x) => ({ n: Math.round(Number(x?.n) || 0), verdict: en(x?.verdict, ["accepted", "partly", "rejected"], "partly"), why: clean(x?.why, 400), change: clean(x?.change, 300) })).filter((x) => x.n > 0 && x.why);
    out.tensions = arr(raw?.tensions, 4).map((t) => ({ between: clean(t?.between, 80), text: clean(t?.text, 400), resolution: clean(t?.resolution, 400) })).filter((t) => t.text);
    out.change_mind = arr(raw?.change_mind, 5).map((x) => clean(x, 240)).filter(Boolean);
    // Dimensions (support level scales the score adjustment)
    out.dimensions = {}; let supported = 0;
    for (const [key] of DIMENSIONS) {
      const d = raw?.dimensions?.[key] || {};
      const evs = arr(d.evidence, 5); const good = []; const urls = new Set();
      for (const e of evs) { const r = resolve(e); if (r && !urls.has(r.url || r.id)) { urls.add(r.url || r.id); good.push(r); } }
      stats.kept += good.length; stats.dropped += evs.length - good.length;
      let score = Math.max(-2, Math.min(2, Math.round(Number(d.score) || 0)));
      if (!good.length) score = 0; else supported++;
      const bodies = key === "regulatory" ? arr(d.bodies, 8).map((b) => (typeof b === "string" ? { name: trim(b, 60), why: "" } : { name: trim(b?.name, 60), why: trim(b?.why, 120) })).filter((b) => b.name) : undefined;
      out.dimensions[key] = { score, summary: clean(d.summary, 700), evidence: good, unsupported: !good.length && evs.length > 0, ...(bodies ? { bodies } : {}) };
    }
    const share = supported / DIMENSIONS.length;
    out.profiles = {}; out.overlay = {};
    for (const p of PROFILES) {
      const x = raw?.profiles?.[p] || {};
      const v = Math.round(Number(x.overlay) || 0);
      out.overlay[p] = Math.max(-OVERLAY_CAP, Math.min(OVERLAY_CAP, Math.round(v * share)));
      out.profiles[p] = { verdict: clean(x.verdict, 900), fit: en(x.fit, ["strong", "moderate", "weak"], ""), conviction: en(x.conviction, ["high", "medium", "low"], ""), adjustment_why: clean(x.adjustment_why, 300), what_changes: clean(x.what_changes, 300),
        section_reads: Object.fromEntries(SCN_KEYS.map((s) => [s, clean(x.section_reads?.[s], 300)]).filter(([, t]) => t)) };
      const miss = raw?.profiles ? SCN_KEYS.filter((s) => !out.profiles[p].section_reads[s]) : [];
      if (miss.length && raw?.profiles?.[p]) out.gaps.push(`${p} verdict lacks ${miss.join(", ")}`);
    }
    out.sections = {}; for (const k of SECTIONS) out.sections[k] = clean(raw?.sections?.[k], 700);
    // Position plans from code: size from a volatility budget x fit x conviction, entry from positioning, hedges, stop.
    const nxt = (cal?.events || []).filter((e) => e.importance === "high" && e.window === "1M")[0];
    out.plans = Plan.positions(Object.fromEntries(Object.entries(out.profiles).filter(([, v]) => v.fit).map(([k, v]) => [k, { fit: v.fit, conviction: v.conviction }])), doc, { nextEvent: nxt ? `${nxt.title} on ${nxt.dates[0]}` : null });
    const list = (a, n) => arr(a, n).map((x) => { const t = clean(typeof x === "string" ? x : x?.text, 300); return t ? { text: t.replace(/\s*\[[^\]]+\]/g, "").trim(), refs: refsOf(t) } : null; }).filter(Boolean);
    out.catalysts = list(raw?.catalysts, 6); out.risks = list(raw?.risks, 6);
    out.watch = arr(raw?.watch, 6).map((x) => clean(x, 240)).filter(Boolean);
    // Tickers mentioned must be in the industry (drop stray ones from winner-style lists is not needed here; flag count)
    out.kept = stats.kept; out.dropped = stats.dropped; out.supported_share = share;
    if (supported <= 2 && out.confidence === "high") out.confidence = "medium";
    if (supported <= 1) out.confidence = "low";
    out.tickers_ok = [...new Set([...JSON.stringify(out).matchAll(/\b[A-Z]{2,5}\b/g)].map((m) => m[0]))].filter((t) => tickers.has(t)).length;
    return out;
  }

  const Brain = { draftStance, redTeamPrompt, cleanRedTeam, basePE, HORIZONS, indexVol, horizonFacts, horizonChecks, horizonPrompt, PROFILES, DIMENSIONS, SECTIONS, SOURCES, OVERLAY_CAP, SCN_SECTIONS, SCN_KEYS, scenarioMath, scenarioPrompt, dossier, synthesisPrompt, verdictsPrompt, reviewPrompt, applyReview, critic };
  if (typeof module !== "undefined" && module.exports) module.exports = Brain;
  else root.Brain = Brain;
})(typeof window !== "undefined" ? window : globalThis);
