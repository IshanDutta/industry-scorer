/* Industry Scorer: Sector runs.
 *
 * One button analyzes every industry in a sector. The rule: share the fact-finding, never the judgment.
 *   - Shared once per sector: data pulls; which macro series to track (tagged per industry) and what is driving
 *     each one; the world situations and their facts; each country's relationship with the US, risks, threats,
 *     policy and developments; each regulator's binding instruments and their facts, fact-checked once.
 *   - Per industry, as before: KPI analyst, earnings calls, customers & suppliers, regulation analyst, trade map;
 *     why each indicator matters and the macro regime; every situation's channels, P&L impact, exposure and
 *     winners/losers; dependencies, exposed tickers and the supply-chain verdict; each instrument's impact and
 *     company examples, and the regulatory verdict; and the whole lead strategist.
 * Each multi-industry answer is split back into exactly the per-industry shapes the single-industry pipeline
 * produces (Team.cleanDive, Trade.cleanDives, RegBook.cleanBook, Team.cleanIndicators), so every report, score
 * and the lead strategist read the same thing they read today.
 *
 * Company-news IDs (N, P, E, W, M, T) are numbered per industry, so in a multi-industry prompt each industry's
 * are shown under an alias (QA12 for the first industry's N12, QB.. for the second) and mapped back after.
 * Pure functions, no I/O.
 */
(function (root) {
  "use strict";
  const req = (f, g) => (typeof module !== "undefined" && module.exports ? require(f) : root[g]);
  const Team = req("./team.js", "Team"), Trade = req("./trade.js", "Trade"), RegBook = req("./regbook.js", "RegBook");
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const trim = (s, n) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  const SLOTS = "ABCDEFGHJKLMNPRSTUVWXYZ";
  const BATCH = 3; // industries per impact call: enough room for each one's full section

  // ---------------------------------------------------------------- aliases for per-industry evidence IDs
  /** An alias table for one industry in a batch: its pack/tx IDs -> "Q<slot><n>" and back. */
  function aliasFor(slot, ind) {
    const to = new Map(), back = new Map(); let n = 0;
    const ids = [...(ind.pack?.items || []).map((i) => i.id), ...(ind.tx?.items || []).map((t) => t.id)];
    for (const id of ids) { if (to.has(id)) continue; n++; const a = `Q${SLOTS[slot]}${n}`; to.set(id, a); back.set(a, id); }
    return { to, back, map: (s) => String(s).replace(/\b([A-Z]{1,2}\d{1,4})\b/g, (m) => to.get(m) || m) };
  }
  /** Replace an industry's aliases in an answer with its real IDs (deep, on strings). */
  function unalias(obj, al) {
    const fix = (s) => s.replace(/\bQ[A-Z]\d{1,4}\b/g, (m) => al.back.get(m) || m);
    const walk = (x) => (typeof x === "string" ? fix(x) : Array.isArray(x) ? x.map(walk) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, walk(v)])) : x);
    return walk(obj);
  }
  const evLine = (i) => `[${i.id}] ${i.date || ""} · ${i.source || ""}${i.symbol ? " · " + i.symbol : ""} — ${i.title}${i.summary ? ". " + trim(i.summary, 220) : ""}`;

  /** A compact block for one industry: its largest companies, geography, segments, the KPI analyst's read. */
  function brief(ind, { companies = 12, segs = 1400, kpi = 1400, al = null } = {}) {
    const d = ind.doc, s = d.summary || {};
    const top = [...(d.constituents || [])].sort((a, b) => b.weight - a.weight).slice(0, companies).map((c) => `${c.symbol} (${trim(c.name, 30)}, ${(c.weight * 100).toFixed(1)}%)`).join("; ");
    const gm = Team.geoMix(d, ind.pack);
    const sg = trim(Team.segmentsBlock(ind.pack), segs);
    return `--- INDUSTRY: ${d.name} (its ${s.n_constituents || 50} largest US-listed companies${isNum(s.total_market_cap) ? `, $${(s.total_market_cap / 1e9).toFixed(0)}B combined` : ""}) ---
Largest: ${top}
${gm ? `Revenue by region: ${gm.rows.map((r) => `${r.region} ${(r.share * 100).toFixed(0)}%`).join(", ")}\n` : ""}${sg}
${ind.kpiDigest && kpi > 0 ? `KPI analyst: ${trim(al ? al.map(ind.kpiDigest) : String(ind.kpiDigest).replace(/\s*\[[A-Z]{1,2}\d{1,4}(?:,\s*[A-Z]{1,2}\d{1,4})*\]/g, ""), kpi)}` : ""}`;
  }
  const names = (inds) => inds.map((i) => i.doc.name);
  const pick = (name, list) => list.find((x) => String(x?.name || x?.industry || "").toLowerCase().trim() === String(name).toLowerCase().trim());

  // ================================================================= macro
  function planPrompt(sector, inds, ctx) {
    return `You are the macro planner on a buy-side research team covering the ${sector} sector. From the catalog below (everything the data connectors offer today), choose the macro series an expert would track for EACH industry in the sector: its demand drivers, cost and input drivers, financing and valuation drivers, and the countries and currencies it depends on. Many series serve several industries; tag each series with every industry it matters for. Don't tag an industry just because a series is popular.

INDUSTRIES
${inds.map((i) => brief(i, { companies: 8, segs: 700, kpi: 500 })).join("\n\n")}

CATALOG
${ctx.catalogText}

Reply with ONLY JSON:
{"series": [{"key": "exact key from the catalog (or spread:<tenorA>-<tenorB>)", "group": "your group name, e.g. 'Demand: data-center capex', 'Input costs', 'Financing & valuation', 'Taiwan & Korea supply base'", "label": "short display label", "reason": "one line: why it matters and to whom",
  "industries": ["exact industry names it matters for"],
  "phrases": ["2-4 phrases a news headline about THIS series' latest move would contain"], "tags": ["1-3 lowercase hyphenated news topic tags"]}]}
Every industry must get 30-45 series tagged to it. Keep the total at or under 90 distinct series. Keys must match the catalog exactly. Phrases must be specific to the series.`;
  }
  /** Team.cleanPlan plus each series' industries; an industry left with too few series gets the broad market and rates series too. */
  function cleanPlan(raw, cat, inds) {
    const base = Team.cleanPlan({ series: (raw?.series || []).slice(0, 95) }, cat);
    const nm = names(inds);
    const tags = new Map();
    for (const x of Array.isArray(raw?.series) ? raw.series : []) { const k = String(x?.key || "").trim(); if (!tags.has(k)) tags.set(k, (Array.isArray(x.industries) ? x.industries : []).map((n) => nm.find((m) => m.toLowerCase() === String(n).toLowerCase().trim())).filter(Boolean)); }
    const series = base.series.slice(0, 90).map((s) => ({ ...s, industries: [...new Set(tags.get(s.key) || [])] }));
    for (const n of nm) {
      const mine = series.filter((s) => s.industries.includes(n)).length;
      if (mine < 15) for (const s of series) if ((/^(treasury|spread|index):/.test(s.key) || /financ|valuation|rates/i.test(s.group)) && !s.industries.includes(n)) s.industries.push(n);
    }
    return { series };
  }
  /** Macro rows for one industry: the rows whose series were tagged for it. */
  function macroFor(macro, plan, name) {
    const keys = new Set(plan.series.filter((s) => s.industries.includes(name)).map((s) => s.key));
    return { ...macro, rows: (macro.rows || []).filter((r) => keys.has(r.key)) };
  }
  /** Indicator analysts, sector version: the driver once, then why it matters for each industry it's tagged for. */
  function indicatorPrompt(sector, inds, rows, ctx) {
    const cands = ctx.candidates || {}, items = ctx.items || new Map(), links = ctx.links || {};
    const tagOf = ctx.tagOf || {};
    const art = (id) => { const i = items.get ? items.get(id) : items[id]; if (!i) return ""; return `    [${i.id}] ${[i.date, i.source].filter(Boolean).join(" · ")} — ${i.title}\n      ${trim(i.text || i.summary || i.excerpt, 600)}`; };
    const block = (r) => {
      const c = (cands[r.id] || []).map((x) => art(x.id)).filter(Boolean);
      const l = (links[r.id] || []).map((x) => `    World team: "${x.title}" moves it — ${trim(x.why, 240)}${x.evidence?.length ? ` [${x.evidence.join(", ")}]` : ""}`);
      const v = (x) => (x === null || x === undefined || x === "" ? NaN : Number(x));
      return `[${r.id}] ${r.group} · ${r.label}: ${Team.fmtVal(r)}${r.period ? ` (${r.period})` : ""}${r.date ? `, ${r.date}` : ""}${isNum(v(r.prior)) ? `; ${r.prior_label || "prior"} ${Team.fmtVal({ ...r, value: r.prior })}` : ""}${isNum(v(r.estimate)) ? `; consensus ${Team.fmtVal({ ...r, value: r.estimate })}` : ""}${isNum(v(r.chg_1m)) ? `; 1M ${r.chg_1m >= 0 ? "+" : ""}${v(r.chg_1m).toFixed(1)}%` : ""}${isNum(v(r.chg_3m)) ? `; 3M ${r.chg_3m >= 0 ? "+" : ""}${v(r.chg_3m).toFixed(1)}%` : ""}${isNum(v(r.chg_1y)) ? `; 1Y ${r.chg_1y >= 0 ? "+" : ""}${v(r.chg_1y).toFixed(1)}%` : ""}${r.reason ? `. Chosen because: ${r.reason}` : ""}
  Matters to: ${(tagOf[r.key] || []).join(", ") || "the sector"}
${l.join("\n")}${l.length ? "\n" : ""}  Candidate coverage (pre-matched to this series; read and judge it):
${c.join("\n") || "    (none matched; search for it)"}`;
    };
    return `You are a macro indicator analyst on a buy-side research team covering the ${sector} sector. For EACH indicator below, find and explain what is driving it right now, then say how much it matters for EACH industry listed under it. Readers want the real cause ("the Empire State index jumped to 10.7 from -8.7 as new orders surged after the tariff truce [G12]"), not just the value.

INDUSTRIES (for the "why it matters" part)
${inds.map((i) => brief(i, { companies: 6, segs: 400, kpi: 500 })).join("\n\n")}
${ctx.worldDigest ? `\nLIVE WORLD SITUATIONS (from the world-events team)\n${ctx.worldDigest}` : ""}

INDICATORS, EACH WITH CANDIDATE COVERAGE FROM THE WHOLE RUN
${rows.map(block).join("\n\n")}
${ctx.tools ? "\nIf the candidates don't explain a move, use search_coverage with the words a headline would use and an optional topic tag, and read_article to read an article in full. Look for the cause: the release, the central-bank decision, the geopolitical event, the supply shock." : ""}

${Team.RULES}
- For every article you cite, give in "sources" one sentence QUOTED EXACTLY (word for word) from that article that shows the cause of the move. Code checks each quote and removes citations whose quote isn't there.
- Cite only articles about this indicator, its release, or the event moving it.
- If after searching you still find nothing, explain the move from the data and end the driver with "No news coverage of this move was found."
- "by_industry": one entry for EVERY industry listed under "Matters to", judged for that industry specifically (its companies, segments and regions).

JSON shape:
{"indicators": [{"id": "I#",
  "driver": "3-5 sentences: what changed (actual vs consensus vs prior or the 1M move, with numbers), what caused it, and whether the trend is accelerating or fading; cite articles inline",
  "next": "one sentence: the next release, meeting or level to watch",
  "keywords": ["2-4 phrases an article about this indicator contains"],
  "sources": [{"id": "X12", "quote": "exact sentence from the article"}],
  "by_industry": [{"name": "exact industry name", "relevance": "high | medium | low", "relevance_why": "1-2 sentences: why it does or doesn't matter for this industry", "effect": "tailwind | headwind | neutral", "why_it_matters": "2 sentences: the mechanism into this industry's revenue, costs, financing or valuation, naming tickers where it differs"}]}]}
Cover EVERY indicator listed, in the same order.`;
  }
  /** One industry's slice of a sector indicator answer, in Team.cleanIndicators' input shape. */
  function indicatorsFor(raw, name) {
    return { indicators: (Array.isArray(raw?.indicators) ? raw.indicators : []).map((it) => { const b = pick(name, Array.isArray(it?.by_industry) ? it.by_industry : []);
      return b ? { id: it.id, driver: it.driver, next: it.next, keywords: it.keywords, sources: it.sources, evidence: it.evidence, relevance: b.relevance, relevance_why: b.relevance_why, effect: b.effect, why_it_matters: b.why_it_matters } : null; }).filter(Boolean) };
  }

  // ================================================================= world events
  function scoutPrompt(sector, inds, ctx) {
    return `You are the world-events scout on a buy-side research team covering the ${sector} sector. Read this week's world news wire and find the live real-world situations that matter most for the industries below right now. Nothing is pre-selected: discover the situations from what is actually being reported (conflicts, geopolitics, trade and tariffs, sanctions and export controls, energy and commodity shocks, central banks, elections, major policy, technology shifts, disasters, strikes, anything else that moves these industries). For each situation, say which industries it reaches, how strongly, and in which direction for each.

INDUSTRIES
${inds.map((i) => brief(i, { companies: 8, segs: 600, kpi: 600 })).join("\n\n")}

${Team.wireBlock(ctx.wire)}${ctx.known?.length ? `

SITUATIONS ALREADY RESEARCHED FOR OTHER SECTORS (their facts are written; only how they reach these industries is new)
If one of your situations is the same real-world situation as one below, use its title EXACTLY as written here, so its research is reused. Decide relevance, stance and channel for these industries yourself, and include a situation only if it genuinely matters to them.
${ctx.known.map((k) => `- ${k.title} (${k.status || "status n/a"}; since ${k.since || "n/a"}): ${trim(k.now, 260)}`).join("\n")}` : ""}
${ctx.tools ? "\nYou can call read_article to read a wire item in full and search_news_by_topic to pull more coverage on a topic before deciding. Cite what they return by ID." : ""}

${Team.RULES}
- Group related headlines into one situation. A situation must be supported by at least 2 evidence IDs and have a plausible channel into at least one industry's revenue, costs, demand or regulation. Rank by expected impact across the sector. Skip market chatter and single-company stories unless they reflect a wider situation.
- Every industry above should be covered by the situations that genuinely matter to it; include a situation that matters to only one industry if it matters a lot to that one.
- "industries": one entry per industry the situation reaches, with its own relevance, stance and channel.

JSON shape:
{"situations": [{"title": "short name", "category": "geopolitics | conflict | trade | energy | monetary | policy | technology | disaster | labor | other", "region": "...", "status": "escalating | active conflict | ongoing tension | negotiating | de-escalating | resolved", "actors": ["2-5"], "since": "YYYY-MM-DD", "latest_date": "YYYY-MM-DD", "search_terms": ["2-4 tags"], "evidence": ["G3", "G9"],
   "industries": [{"name": "exact industry name", "relevance": "high | medium", "stance": "adverse | supportive | mixed", "why": "2 sentences: the channel into that industry"}]}],
 "also_watching": [{"title": "...", "why": "one sentence", "evidence": []}]}
Sizes: 4-10 situations (fewer when the news is quiet), up to 5 also_watching.`;
  }
  /** Shared situations (each with its industries), cleaned like Team.cleanScout. */
  function cleanScout(raw, idx, inds) {
    const nm = names(inds);
    const all = { name: "sector", constituents: inds.flatMap((i) => i.doc.constituents || []) };
    const sits = Array.isArray(raw?.situations) ? raw.situations : [];
    const base = Team.cleanScout({ situations: sits.map((s) => ({ ...s, stance: "mixed", relevance: "high", why: s.industries?.[0]?.why || s.why || "" })), also_watching: raw?.also_watching }, idx, all);
    const situations = base.situations.map((s) => { const src = sits.find((x) => trim(x.title, 120) === s.title) || {};
      const ind = (Array.isArray(src.industries) ? src.industries : []).map((x) => { const n = nm.find((m) => m.toLowerCase() === String(x?.name || "").toLowerCase().trim()); if (!n) return null;
        return { name: n, relevance: ["high", "medium"].includes(String(x.relevance).toLowerCase()) ? String(x.relevance).toLowerCase() : "medium", stance: ["adverse", "supportive", "mixed"].includes(String(x.stance).toLowerCase()) ? String(x.stance).toLowerCase() : "mixed", why: trim(x.why, 500) }; }).filter(Boolean);
      return { ...s, industries: ind.filter((x, i, a) => a.findIndex((y) => y.name === x.name) === i) }; }).filter((s) => s.industries.length);
    return { situations, also_watching: base.also_watching };
  }
  /** One industry's scout, in Team.cleanScout's shape. */
  function scoutFor(shared, name) {
    return { situations: shared.situations.filter((s) => s.industries.some((x) => x.name === name)).map(({ industries, coverage, ...s }) => { const me = industries.find((x) => x.name === name); return { ...s, stance: me.stance, relevance: me.relevance, why: me.why }; })
      .sort((a, b) => (a.relevance === b.relevance ? 0 : a.relevance === "high" ? -1 : 1)), also_watching: shared.also_watching };
  }
  const IMPACT_SHAPE = `{"name": "exact industry name", "stance": "adverse | supportive | mixed", "summary": "3-4 sentences: net impact on this industry and who is most exposed",
   "first_order": "the first-order shock for this industry, 1-2 sentences",
   "chain": [{"step": "short title", "timing": "immediate | 0-3 months | 3-12 months | 12+ months", "text": "2-3 sentences", "evidence": []}],
   "channels": {"revenue": [{"name": "...", "direction": "up | down | mixed", "magnitude": "...", "timing": "...", "confidence": "low | medium | high", "text": "2-3 sentences", "exposed": ["TICKER"], "evidence": []}], "cost": [...], "demand": [...], "regulation": [...]},
   "fs_impact": [{"lever": "Revenue | Gross margin | Opex | Working capital | Capex | Cash flow | Valuation", "direction": "up | down | mixed", "magnitude": "...", "timing": "...", "why": "1-2 sentences"}],
   "exposure": [{"segment": "sub-segment", "level": "high | medium | low", "why": "1-2 sentences", "names": ["TICKER"]}],
   "scenario_earnings": [{"name": "the scenario's name", "earnings": "this industry's earnings and multiple impact in that scenario, quantified as ranges"}],
   "near_term": "2-3 sentences on the next 1-2 quarters of earnings", "structural": "2-3 sentences on lasting changes",
   "winners": [{"symbol": "TICKER", "why": "one sentence"}], "losers": [{"symbol": "TICKER", "why": "one sentence"}], "offsets": ["what cushions the impact"]}`;
  const IMPACT_SIZES = "Per industry: 3-6 chain steps, 1-3 channels in each group (empty array if none), 4-6 fs_impact rows, 3-5 exposure rows, one scenario_earnings entry per scenario, 2-5 winners and losers (that industry's tickers only), 2-4 offsets.";
  function industryBlockForSituation(ind, sitIndustry, al) {
    const ids = new Set(); const words = String(sitIndustry.title || "").toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    const related = (i) => words.some((w) => `${i.title} ${i.summary || ""}`.toLowerCase().includes(w));
    const news = (ind.pack?.items || []).filter((i) => /^[NEP]$/.test(i.kind) && related(i)).slice(0, 10);
    return `${brief(ind, { companies: 15, segs: 1000, kpi: 900, al })}
Scout's note for this industry: ${sitIndustry.why} (${sitIndustry.relevance} relevance, ${sitIndustry.stance})
${Team.companiesBlock(ind.doc, 20)}
Company news that may be related (cite by the IDs shown):
${news.map((i) => evLine({ ...i, id: al.to.get(i.id) || i.id })).join("\n") || "(none)"}`;
  }
  /** The situation's facts (when `facts` is null) and its impact on up to three industries. */
  function situationPrompt(sit, batch, ctx, facts = null) {
    const cov = sit.coverage || [];
    const blocks = batch.map(({ ind, me, al }) => industryBlockForSituation(ind, { ...me, title: sit.title }, al)).join("\n\n");
    const macroRows = (ctx.macro?.rows || []).filter((r) => /Commodities|FX|Rates|Markets|Global|Inflation|Financ|Input|Energy/i.test(r.group)).slice(0, 40);
    return `You are a situation analyst on a buy-side research team. ${facts ? "The facts of ONE world situation are established below. Write how it transmits into each industry's earnings." : "Write a deep dive on ONE world situation: first its facts, then how it transmits into each industry's earnings."}

SITUATION: ${sit.title} (${sit.category}; region ${sit.region || "n/a"}; status ${sit.status || "n/a"}; actors ${(sit.actors || []).join(", ") || "n/a"})
${facts ? `\nESTABLISHED FACTS (don't restate; build on them)\n${JSON.stringify(facts)}\n` : ""}
${blocks}

MACRO ROWS (cite by I-ID)
${macroRows.map((r) => `[${r.id}] ${r.label}: ${Team.fmtVal(r)}${r.period || r.date ? ` (${r.period || r.date})` : ""}`).join("\n") || "n/a"}

COVERAGE OF THIS SITUATION (last 30 days, newest first; cite by ID)
${cov.map((i) => `[${i.id}] ${i.date} · ${i.source}${i.tags?.length ? " · " + i.tags.slice(0, 4).join(", ").toLowerCase() : ""} — ${i.title}. ${trim(i.summary, 900)}`).join("\n\n") || "(none found beyond the scout's sources)"}

${Team.RULES}
- Channels are concrete: name the revenue line, cost input or demand pool, give a direction, a magnitude (a range, marked "(estimate)" unless from evidence), timing and confidence, and the exposed tickers. Each industry's section uses only that industry's tickers.
- Write each industry's section as fully as if it were the only one: don't shorten later industries, and don't repeat the same sentences across industries.
${facts ? "" : "- Scenario probabilities must sum to 100."}

JSON shape:
{${facts ? "" : `"facts": {"title": "${trim(sit.title, 80).replace(/"/g, "'")}", "region": "...", "status": "escalating | active conflict | ongoing tension | negotiating | de-escalating | resolved", "actors": ["..."], "since": "YYYY-MM-DD",
  "now": "what is happening now, 3-5 sentences with dates and citations", "why_now": "why this is repricing now: the latest concrete step, dated and cited",
  "developments": [{"date": "YYYY-MM-DD", "text": "one dated development", "evidence": ["W4"]}],
  "indicators": [{"id": "I# when a macro row fits, else omit", "name": "what it moves when no row fits", "basis": "market data | article-grounded | qualitative", "why": "how this situation moves it", "evidence": []}],
  "trigger": "the current trigger, one sentence with citation",
  "scenarios": [{"name": "Base case", "probability": 60, "trigger": "...", "outcome": "what happens operationally"}, {"name": "Escalation", ...}, {"name": "De-escalation", ...}],
  "watch": [{"indicator": "what to watch", "signal": "the level or event that would matter", "why": "one sentence"}]},
 `}"industries": [${IMPACT_SHAPE}]}
${facts ? "" : "Facts sizes: 3-6 developments, 2-5 indicators, exactly 3 scenarios, 3-6 watch items. "}${IMPACT_SIZES} One entry in "industries" for each of: ${batch.map((b) => b.ind.doc.name).join(", ")}.`;
  }
  /** Facts + one industry's impact -> the single-industry dive shape Team.cleanDive expects. */
  function mergeDive(facts, imp) {
    const sc = (Array.isArray(facts?.scenarios) ? facts.scenarios : []).map((s) => { const e = (Array.isArray(imp?.scenario_earnings) ? imp.scenario_earnings : []).find((x) => String(x?.name || "").toLowerCase() === String(s?.name || "").toLowerCase()); return { ...s, earnings: e?.earnings || "" }; });
    return { title: facts?.title, region: facts?.region, status: facts?.status, actors: facts?.actors, since: facts?.since, now: facts?.now, why_now: facts?.why_now, developments: facts?.developments, indicators: facts?.indicators, trigger: facts?.trigger, watch: facts?.watch,
      stance: imp?.stance, summary: imp?.summary, first_order: imp?.first_order, chain: imp?.chain, channels: imp?.channels, fs_impact: imp?.fs_impact, exposure: imp?.exposure, scenarios: sc,
      near_term: imp?.near_term, structural: imp?.structural, winners: imp?.winners, losers: imp?.losers, offsets: imp?.offsets };
  }

  // ================================================================= trade relations
  /** Facts for up to three countries: the US relationship, risks, threats, policy, developments; shared by every industry. */
  function countryFactsPrompt(sector, batch, ctx) {
    return `You are the trade-relations analyst on a buy-side research team covering the ${sector} sector. For each country below, establish the facts of the United States' relationship with it, every material risk in it, any threat of invasion or war, the policy in play and recent developments. "We" and "our" mean the United States. A colleague will then write what each industry depends on there and which tickers are exposed, from your facts.

${batch.map((c) => `=== ${c.country} (relationship with the US ${c.stance}, ${c.trajectory}; security threat ${c.threat || "n/a"}${c.threat_note ? `: ${c.threat_note}` : ""}) ===
Matters to: ${c.industries.map((x) => `${x.name} (${x.importance}; ${x.roles.join(", ")})`).join("; ")}
Macro rows: ${(ctx.macro?.rows || []).filter((r) => Trade.samePlace(`${r.label} ${r.country ? Trade.countryName(r.country) || r.country : ""}`, c.country)).map((r) => `[${r.id}] ${r.label} ${Team.fmtVal(r)}`).join("; ") || "none"}
News (last 30 days; cite by ID):
${(c.news || []).map((i) => evLine(i)).join("\n") || "(none found)"}`).join("\n\n")}

${Team.RULES}
- "relationship": alliance or treaty status, trade agreements and tariff levels in BOTH directions, export controls and sanctions either way, diplomatic tone, recent summits or disputes, and the direction. Cite current events.
- "risks": every material risk from this country or the US relationship for the sector's industries listed above (tariff escalation, export controls, sanctions, invasion or war, political instability, currency, regulation, expropriation, logistics), each with likelihood, timing and mechanism, and the industries it reaches.
- "security": who threatens whom and what is happening now. Use threat_level "none" when there is no credible threat.
- Current policy actions, dates, fines and figures need citations.

JSON shape:
{"countries": [{"country": "exact name as above",
  "relationship": {"alliance": "treaty ally | partner | neutral | rival | adversary", "summary": "3-5 sentences, cited", "trade_terms": "tariffs, quotas, agreements and controls in force both ways, cited", "tension_points": ["specific, cited"], "cooperation": ["specific, cited"], "evidence": []},
  "risks": [{"risk": "the specific risk", "type": "tariffs | export controls | sanctions | military conflict | political instability | currency | regulation | expropriation | logistics | other", "likelihood": "high | medium | low", "timing": "0-3M | 3-12M | 12M+", "mechanism": "how it works", "industries": ["exact industry names"], "evidence": []}],
  "security": {"threat_level": "none | low | elevated | high | critical", "threat": "who threatens whom and how", "status": "what is happening now, cited", "evidence": []},
  "policy": [{"instrument": "...", "status": "in force | announced | proposed | suspended | expired", "date": "YYYY-MM-DD or YYYY-MM", "effect": "who and how much", "evidence": []}],
  "developments": [{"date": "YYYY-MM-DD", "text": "dated development", "evidence": []}],
  "outlook": "2-3 sentences on the next 6-12 months, cited where possible",
  "watch": ["specific things to watch"]}]}
Sizes per country: 2-4 tension points and cooperation items, 3-8 risks, 0-4 policy items, 0-5 developments, 2-4 watch items. Cover every country listed above.`;
  }
  /** One industry: what it depends on in each of its countries and who is exposed, from the shared facts. */
  function tradeImpactPrompt(ind, countries, factsBy, ctx, al) {
    return `You are the trade-relations analyst on a buy-side research team. The facts of the United States' relationship with each country below are established. Write, for the ${ind.doc.name} industry, what it depends on there, what breaks if trade freezes, whether it can be replaced, which of the risks hit it and which tickers are on the hook through which P&L line. "We" and "our" mean the United States.

${Team.header(ind.doc, ctx)}

${Team.companiesBlock(ind.doc, 25)}
${ind.kpiDigest ? `\nINDUSTRY KPI ANALYST'S READ\n${trim(al.map(ind.kpiDigest), 1500)}` : ""}

${countries.map((c) => { const f = factsBy[c.country] || {};
  return `=== ${c.country} (rank ${c.rank} for this industry; ${c.roles.join(", ")}; ${c.importance} importance; relationship ${c.stance}, ${c.trajectory}; security threat ${c.threat || "n/a"}) ===
Why it matters (this industry's map): ${c.why}
Exposure from filings: revenue ${c.exposure?.revenue_share === null || c.exposure?.revenue_share === undefined ? "n/a" : `${(c.exposure.revenue_share * 100).toFixed(0)}%`}${c.exposure?.companies?.length ? ` (${c.exposure.companies.map((x) => `${x.symbol} ${(x.share * 100).toFixed(0)}%`).join(", ")})` : ""}${c.exposure?.hq?.length ? `; HQ: ${c.exposure.hq.join(", ")}` : ""}
ESTABLISHED FACTS: ${JSON.stringify({ relationship: f.relationship, risks: f.risks, security: f.security, policy: f.policy, developments: f.developments })}`; }).join("\n\n")}

${Team.RULES}
- Supply-chain structure may come from general industry knowledge; set "basis" to "cited" only when an evidence ID supports the dependency, otherwise "background". Shares of global supply without a citation must say "(estimate)".
- "risks": the established risks that reach THIS industry (plus any industry-specific one the facts miss), each with its impact on this industry, the mechanism here and the tickers hit. Keep the established likelihood and timing.
- "industry_impact" (security): what an invasion, blockade or war would do to this industry's supply and revenue, by ticker; "" when the threat is none.
- "exposed": tickers from the company table only, each with the exact P&L line: revenue, gross margin, capex, compliance, supply.

JSON shape:
{"countries": [{"country": "exact name as above", "headline": "one line: the bilateral risk for this industry in a sentence",
  "risks": [{"risk": "...", "type": "...", "likelihood": "high | medium | low", "impact": "high | medium | low", "timing": "0-3M | 3-12M | 12M+", "mechanism": "how it hits this industry's revenue, margins, supply or capex", "tickers": ["TICKER"], "evidence": []}],
  "industry_impact": "...",
  "dependencies": [{"input": "what is made or sourced there", "category": "raw material | component | tooling | manufacturing capacity | assembly & test | end market | IP & software | logistics", "criticality": "critical | high | medium | low", "share": "e.g. ~90% of leading-edge foundry capacity (estimate)", "substitutability": "<6 months | 6-18 months | 1-3 years | 3-5+ years", "replacement": "what replacing it takes", "loss_risk": "the immediate consequence if severed", "basis": "cited | background", "evidence": []}],
  "exposed": [{"symbol": "TICKER", "channel": "revenue | gross margin | capex | compliance | supply", "mechanism": "exact transmission into the P&L", "severity": "high | medium | low", "evidence": []}],
  "freeze": "what breaks in the first 30, 90 and 365 days if trade with this country froze"}]}
Sizes per country: 3-6 risks, 2-5 dependencies, 2-6 exposed tickers. Cover every country listed above.`;
  }
  /** Shared facts + one industry's impact -> the per-country shape Trade.cleanDives expects. */
  function mergeCountry(f, imp) {
    return { country: imp?.country || f?.country, headline: imp?.headline, relationship: f?.relationship, risks: imp?.risks?.length ? imp.risks : f?.risks,
      security: { ...(f?.security || {}), industry_impact: imp?.industry_impact || "" }, dependencies: imp?.dependencies, policy: f?.policy, developments: f?.developments,
      exposed: imp?.exposed, freeze: imp?.freeze, outlook: f?.outlook, watch: f?.watch };
  }
  /** The union of every industry's trade map: one row per country with who it matters to. */
  function countryUnion(maps) {
    const by = new Map();
    for (const [name, m] of Object.entries(maps)) for (const c of m?.countries || []) {
      const k = c.country.toLowerCase();
      const u = by.get(k) || { country: c.country, stance: c.stance, trajectory: c.trajectory, threat: c.threat, threat_note: c.threat_note, search_terms: [], industries: [], best: 99 };
      u.industries.push({ name, importance: c.importance, roles: c.roles, rank: c.rank });
      u.search_terms = [...new Set([...u.search_terms, ...(c.search_terms || [])])].slice(0, 4);
      if (c.rank < u.best) { u.best = c.rank; }
      by.set(k, u);
    }
    const imp = { existential: 0, high: 1, medium: 2 };
    return [...by.values()].sort((a, b) => a.best - b.best || b.industries.length - a.industries.length || (imp[a.industries[0].importance] ?? 3) - (imp[b.industries[0].importance] ?? 3));
  }

  // ================================================================= rule books
  /** The sector's regulators: every industry's bodies merged by key (or by the acronym before " — "). */
  function bodyUnion(regs) {
    const out = [];
    const acr = (n) => String(n || "").split(/\s+[—-]\s+/)[0].trim().toUpperCase();
    for (const [name, list] of Object.entries(regs)) for (const b of list || []) {
      const k = RegBook.bodyKey(b.name);
      let u = out.find((x) => x.key === k || (acr(x.name) && acr(x.name) === acr(b.name) && acr(b.name).length >= 2));
      if (!u) { u = { key: k, name: b.name, jurisdiction: b.jurisdiction, why: b.why, levers: [...(b.levers || [])], current: b.current, industries: [], keys: {} }; out.push(u); }
      if (!u.industries.includes(name)) u.industries.push(name);
      u.keys[name] = k;
      u.levers = [...new Set([...u.levers, ...(b.levers || [])])].slice(0, 6);
      if (b.current && !String(u.current || "").includes(b.current.slice(0, 40))) u.current = trim(`${u.current || ""} ${b.current}`, 600);
    }
    return out.sort((a, b) => b.industries.length - a.industries.length);
  }
  function listPrompt(body, inds, sources, ctx) {
    const pre = RegBook.prefixFor(ctx.bi);
    return `You are a regulatory analyst on a buy-side research team covering the ${ctx.sector} sector. Identify the specific, binding instruments (laws, rules, rates, tariffs, mandates, quotas, thresholds, fines, subsidies, approvals) of ONE regulatory body that matter most for the earnings of the industries below over the next 12 months, and rank them for each industry. A colleague will write each one up in full from your list, so be precise.

${inds.map((i) => brief(i, { companies: 10, segs: 500, kpi: 500 })).join("\n\n")}

REGULATORY BODY: ${body.name} (${body.jurisdiction || "jurisdiction n/a"})
Why it matters: ${body.why || "n/a"}
Levers: ${(body.levers || []).join("; ") || "n/a"}
What it is doing now: ${body.current || "n/a"}${ctx.known?.length ? `

INSTRUMENTS OF THIS BODY ALREADY WRITTEN UP FOR OTHER SECTORS
When you pick one of these, use its name EXACTLY as written here so its write-up is reused. Still choose and rank for the industries above on their own merits: include one only if it is among their most material, and add others as needed.
${ctx.known.map((k) => `- ${k.name}${k.citation ? ` — ${k.citation}` : ""}`).join("\n")}` : ""}

RETRIEVED SOURCES ON THIS BODY (past 12 months; cite by ID)
${sources.map(evLine).join("\n") || "(none retrieved)"}
${ctx.tools ? "\nCall search_company_news and search_topic_news to find more dated evidence (enforcement actions, licenses, fines, approvals, rule changes) before you answer. Cite what they return by ID." : ""}

RULES
- For EACH industry, its 5 most material instruments of this body (fewer only if it genuinely has fewer), ranked by 12-month forward financial materiality for that industry. One instrument can serve several industries. At most 8 distinct instruments in total.
- Currently binding law first. A proposed, pending or rescinded framework gets that status; never present a rescinded rule as in force.
- "citation": the precise statute, CFR section, docket or Federal Register / Official Journal reference. "numeric_value": hard numbers only, separated by " · ", no prose; empty string if none.
- "evidence": the source IDs about this instrument.
- Reply with ONLY the JSON, no commentary.

JSON shape:
{"rules": [{"name": "short specific instrument name", "citation": "...", "category": "law | rule | rate | tariff | mandate | quota | threshold | fine | subsidy | approval", "status": "in_force | proposed | rescinded | pending", "effective": "effective date / cite tail", "numeric_value": "...", "evidence": ["${pre}1"],
  "industries": [{"name": "exact industry name", "rank": 1, "severity": "high | medium | low", "why": "one sentence: why it is material for that industry"}]}]}`;
  }
  const RULE_IMPACT = `{"name": "exact industry name", "severity": "high | medium | low",
   "industry_impact": "4-5 investor-grade sentences for this industry: the main transmission channel (revenue, price/margin, capex, market access), which companies win or lose (name its tickers), the second-order effect",
   "today": "2-3 sentences on how the rule partitions this industry's market right now",
   "examples": [{"company": "TICKER or company name", "date": "YYYY-MM-DD", "what": "what happened", "impact": "the financial impact", "evidence": []}],
   "bottom_line": "one sentence, <= 35 words, the structural investment conclusion for this industry"}`;
  /** One instrument: its facts (when `facts` is null) and its impact on up to three industries. */
  function rulePrompt(body, rule, batch, sources, ctx, facts = null) {
    const pre = RegBook.prefixFor(ctx.bi);
    const mine = new Set(rule.evidence || []);
    const ordered = [...sources.filter((x) => mine.has(x.id)), ...sources.filter((x) => !mine.has(x.id))];
    return `You are a regulatory analyst on a buy-side research team. ${facts ? "The facts of ONE binding instrument are established below. Write how it applies to each industry." : "Write the rule-book entry for ONE binding instrument: first its facts, then how it applies to each industry."}

REGULATORY BODY: ${body.name} (${body.jurisdiction || "jurisdiction n/a"}). ${body.why || ""}
INSTRUMENT: ${rule.name} — ${rule.citation || "citation n/a"}; ${rule.category || ""}; status ${rule.status || "n/a"}; effective ${rule.effective || "n/a"}${rule.numeric_value ? `; ${rule.numeric_value}` : ""}.
${facts ? `\nESTABLISHED FACTS\n${JSON.stringify(facts)}\n` : ""}
${batch.map(({ ind, me }) => `${brief(ind, { companies: 12, segs: 600, kpi: 500 })}\nWhy it matters here (list): ${me.why} (severity ${me.severity})\n${Team.companiesBlock(ind.doc, 15)}`).join("\n\n")}

RETRIEVED SOURCES (past 12 months; the ones about this instrument first; cite by ID)
${ordered.map(evLine).join("\n") || "(none retrieved)"}

RULES
- Zero tolerance for invention: every named company action, dollar fine, court case, deal, executive quote, earnings disclosure or exact date must be supported by a source ID above, otherwise omit it or restate it qualitatively. Qualitative ranges are fine without a citation; specific numbers are not, except the instrument's own legal parameters, which you may state from knowledge of the law.
${facts ? "" : `- "last_12_months": 3-8 dated events in chronological order, each <= 160 characters, each tied to a source ID.
- "next_12_months.events": 2-6 dated forward catalysts, each with its trigger and a source ID where one exists.
`}- "examples": 1-4 real company examples per industry, from that industry's tickers; the company, the date and the event must all appear in the cited source.
- Write each industry's section as fully as if it were the only one. No forecasts presented as fact. Reply with ONLY the JSON object.

JSON shape:
{${facts ? "" : `"facts": {"name": "${String(rule.name || "").replace(/"/g, "'")}", "citation": "...", "category": "...", "status": "...", "effective": "...", "numeric_value": "...",
  "what_this_is": "3-4 plain-English sentences: the statute/CFR/notice and the agency's authority, who it binds, how it is enforced",
  "last_12_months": [{"date": "YYYY-MM-DD", "event": "<= 160 chars", "evidence": ["${pre}1"]}],
  "next_12_months": {"analysis": "5-8 sentences of forward read across the industries", "events": [{"date": "YYYY-MM-DD or YYYY-MM", "event": "...", "trigger": "...", "evidence": []}]}},
 `}"industries": [${RULE_IMPACT}]}
One entry in "industries" for each of: ${batch.map((b) => b.ind.doc.name).join(", ")}.`;
  }
  /** One industry's rule book, in RegBook.cleanBook's input shape: its top-5 instruments with its own impact. */
  function bookFor(list, writes, name) {
    const mine = list.map((r, k) => ({ r, k, me: pick(name, r.industries || []) })).filter((x) => x.me).sort((a, b) => (Number(a.me.rank) || 9) - (Number(b.me.rank) || 9)).slice(0, 5);
    return { rules: mine.map(({ r, k, me }) => { const w = writes[k] || {}; const imp = pick(name, w.impacts || []) || {};
      return { name: r.name, citation: w.facts?.citation || r.citation, category: w.facts?.category || r.category, status: w.facts?.status || r.status, effective: w.facts?.effective || r.effective,
        numeric_value: w.facts?.numeric_value || r.numeric_value, severity: imp.severity || me.severity, what_this_is: w.facts?.what_this_is, industry_impact: imp.industry_impact,
        last_12_months: w.facts?.last_12_months, today: imp.today, next_12_months: w.facts?.next_12_months, examples: imp.examples, bottom_line: imp.bottom_line }; }) };
  }
  /** Fact-check claims across several books at once: identical claims (shared facts) are checked once. */
  function dedupeClaims(cs) {
    const by = new Map(), out = [];
    for (const c of cs.claims) { const k = `${c.kind}|${c.text}|${[...c.ids].sort().join(",")}`; const hit = by.get(k);
      if (hit) { const prev = hit.apply; hit.apply = (st, fix) => { prev(st, fix); c.apply(st, fix); }; } else { by.set(k, c); out.push(c); } }
    out.forEach((c, i) => { c.id = "C" + (i + 1); });
    return { claims: out, finalize: cs.finalize };
  }
  const manySpec = (books) => (prose, item) => { for (const b of books) RegBook.bookSpec(b)(prose, item); };

  // ================================================================= batching and overview
  /** Split industries into impact batches of up to BATCH, most relevant first. */
  function batches(list, n = BATCH) { const out = []; for (let k = 0; k < list.length; k += n) out.push(list.slice(k, k + n)); return out; }
  /** One row of the sector overview from an industry's finished run. */
  function overviewRow(name, doc, agent, scores) {
    const r = agent?.result || {};
    return { name, n: doc?.summary?.n_constituents, cap: doc?.summary?.total_market_cap, as_of: doc?.as_of,
      scores: Object.fromEntries(Object.entries(scores?.profiles || {}).map(([k, v]) => [k, isNum(v.total) ? Math.round(v.total) : null])),
      best: Object.entries(scores?.profiles || {}).filter(([, v]) => isNum(v.total)).sort((a, b) => b[1].total - a[1].total)[0]?.[0] || null,
      opportunity: r.opportunity?.verdict || null, expected: r.math?.expected_return ?? null, headline: trim(r.headline, 240),
      horizons: Object.fromEntries(["1M", "3M", "6M", "12M"].map((h) => [h, r.horizons?.[h]?.call || null])),
      fwd_pe: doc?.forward?.fwd_pe ?? null, rev30: doc?.forward?.rev30 ?? null, positioning: doc?.positioning?.label || null, r1y: doc?.summary?.ret_cw_1Y ?? null };
  }

  const Sector = { SLOTS, BATCH, aliasFor, unalias, brief, planPrompt, cleanPlan, macroFor, indicatorPrompt, indicatorsFor, scoutPrompt, cleanScout, scoutFor, situationPrompt, mergeDive,
    countryFactsPrompt, tradeImpactPrompt, mergeCountry, countryUnion, bodyUnion, listPrompt, rulePrompt, bookFor, dedupeClaims, manySpec, batches, overviewRow };
  if (typeof module !== "undefined" && module.exports) module.exports = Sector;
  else root.Sector = Sector;
})(typeof window !== "undefined" ? window : globalThis);
