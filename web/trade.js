/* Industry Scorer: Trade Relations.
 *
 * Where the industry's supply chain is fragile, who has leverage over it, and
 * how geopolitical friction turns into earnings. Five questions:
 *   1. Who holds existential leverage? The 10-14 countries that matter most by
 *      operational importance (manufacturing hubs and tools, chokepoint
 *      inputs, assembly and packaging, end markets), not by trade dollars.
 *   2. Is the environment improving or escalating? Stance (allied,
 *      competitive, adversarial, sanctioned) and trajectory (improving,
 *      deteriorating, volatile, escalating) per country.
 *   3. What breaks if trade freezes, and can it be replaced? Per-country
 *      dependencies: input criticality, substitutability (time and capex),
 *      loss risk.
 *   4. Which tickers are on the hook, through which P&L line?
 *   5. The supply-chain verdict: rating, system health score, bottlenecks,
 *      and whether pricing power passes friction through or multiples de-rate.
 *
 * Code computes what filings can show: each country's share of the companies'
 * revenue (geographic segments), which companies are headquartered there, the
 * country's own macro rows, and a deterministic system health score from the
 * map. Agents (Claude) rank countries and write the dependencies; code pulls
 * 30 days of news per country for the deep dives and checks every citation.
 */
(function (root) {
  "use strict";
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const v = (x) => (x === null || x === undefined ? NaN : Number(x));
  const trim = (s, n) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  const day = (s) => String(s ?? "").slice(0, 10);
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
  function addDays(d, k) { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + k); return t.toISOString().slice(0, 10); }

  const ROLES = ["manufacturing hub", "tooling & equipment", "chokepoint input", "assembly & packaging", "end market", "R&D & IP", "logistics route"];
  const IMPORTANCE = ["existential", "high", "medium"];
  const STANCES = ["allied", "competitive", "adversarial", "sanctioned"];
  const TRAJ = ["improving", "deteriorating", "volatile", "escalating"];
  const CRIT = ["critical", "high", "medium", "low"];
  const SUBST = ["<6 months", "6-18 months", "1-3 years", "3-5+ years"];
  const CHANNELS = ["revenue", "gross margin", "capex", "compliance", "supply"];
  const RATINGS = ["healthy", "manageable", "strained", "critical"];
  const THREAT = ["none", "low", "elevated", "high", "critical"];
  const ALLIANCE = ["treaty ally", "partner", "neutral", "rival", "adversary"];
  const RISK_TYPES = ["tariffs", "export controls", "sanctions", "military conflict", "political instability", "currency", "regulation", "expropriation", "logistics", "other"];
  /** This page covers the United States' trade relations with other countries, so the US itself is never a country row. */
  const isUS = (name) => samePlace(String(name || ""), "United States") || /^(us|usa|u\.s\.a?\.?|america)$/i.test(String(name || "").trim());

  // Country names come from the browser's own locale data (Intl.DisplayNames), not from a list.
  let _names = null;
  const regionNames = () => { try { return new Intl.DisplayNames(["en"], { type: "region" }); } catch { return null; } };
  function countryName(code) { const dn = regionNames(); try { const n = dn?.of(String(code || "").toUpperCase()); return n && n !== String(code).toUpperCase() ? n : null; } catch { return null; } }
  /** Every country name the runtime knows (generated from all two-letter region codes). */
  function allCountries() {
    if (_names) return _names;
    const out = new Set(); const A = 65;
    for (let i = 0; i < 26; i++) for (let j = 0; j < 26; j++) { const n = countryName(String.fromCharCode(A + i, A + j)); if (n && !/unknown|world|europe|union|nations|latin|outlying|islands? area/i.test(n)) out.add(n); }
    _names = [...out]; return _names;
  }
  const words = (x) => String(x || "").toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter((w) => w && w !== "the" && w !== "of" && w !== "and");
  const initials = (x) => words(x).map((w) => w[0]).join("");
  /** Does a free-text place name (e.g. a segment "TAIWAN, PROVINCE OF CHINA", "KOREA", "U.S.") refer to this country? */
  function samePlace(text, country) {
    const head = String(text || "").split(",")[0].replace(/\./g, "").trim();
    const a = words(head), b = words(country);
    if (!a.length || !b.length) return false;
    if (a.join(" ") === b.join(" ")) return true;
    if (a.length === 1 && b.length > 1 && a[0] === initials(country)) return true;
    return a.every((w) => b.includes(w)) || b.every((w) => a.includes(w));
  }
  /**
   * The one country a place name refers to. Exact name, then initials, then the
   * closest name containing it (fewest extra words); ties go to the country the
   * hints (other segment names, headlines) mention most.
   */
  function bestCountry(text, hints = []) {
    const c = allCountries().filter((n) => samePlace(text, n));
    if (c.length <= 1) return c[0] || null;
    const head = words(String(text || "").split(",")[0].replace(/\./g, "")).join(" ");
    const exact = c.find((n) => words(n).join(" ") === head); if (exact) return exact;
    const extra = (n) => Math.abs(words(n).length - head.split(" ").length);
    const min = Math.min(...c.map(extra)); const top = c.filter((n) => extra(n) === min);
    if (top.length === 1) return top[0];
    const score = (n) => hints.reduce((a, h) => a + (new RegExp(`\\b${words(n).join("\\s+")}\\b`, "i").test(h) ? 1 : 0), 0);
    return top.sort((a, b) => score(b) - score(a))[0];
  }
  /** Regex that finds a country in a headline or article (full name, its initials like U.S., or its adjective like Chinese). */
  const countryRe = (name) => { const w = words(name); const ini = w.length > 1 ? initials(name).toUpperCase().split("").join("\\.?") + "\\.?" : null;
    return new RegExp(`\\b(?:${w.join("\\s+")}${ini ? `|${ini}(?![a-z])` : ""})`, w.length > 1 ? "" : "i"); };
  const reCase = (name) => { const r = countryRe(name); const w = words(name); const stem = w.length === 1 && w[0].length > 4 ? new RegExp(`\\b${w[0].replace(/[aeiouy]$/, "")}\\w{0,4}\\b`, "i") : null;
    return (t) => r.test(t) || new RegExp(`\\b${w.join("\\s+")}`, "i").test(t) || (!!stem && stem.test(t)); };

  /** Revenue exposure to one country: revenue-weighted share across companies that report it, plus each company's share. */
  function countryExposure(doc, pack, country, hints = null) {
    hints = hints || (pack?.segments || []).flatMap((s) => (s.geo?.items || []).map((i) => i.name));
    const rev = Object.fromEntries((doc?.constituents || []).map((c) => [c.symbol, v(c.rev_ttm)]));
    let num = 0, den = 0; const per = [];
    for (const s of pack?.segments || []) {
      if (!s.geo || !(rev[s.symbol] > 0)) continue;
      den += rev[s.symbol];
      const share = s.geo.items.filter((i) => samePlace(i.name, country) && bestCountry(i.name, hints) === country).reduce((a, i) => a + i.share, 0);
      if (share > 0) { num += share * rev[s.symbol]; per.push({ symbol: s.symbol, share, period: s.geo.label }); }
    }
    const hq = (doc?.constituents || []).filter((c) => samePlace(countryName(c.country) || "", country));
    return { revenue_share: den ? num / den : null, reporting: (pack?.segments || []).filter((s) => s.geo).length, companies: per.sort((a, b) => b.share - a.share).slice(0, 8),
      hq: hq.map((c) => c.symbol), hq_weight: hq.reduce((a, c) => a + (v(c.weight) || 0), 0) };
  }
  /** Every country that appears in the companies' geographic segments or headquarters (regions like "Europe" are not countries and drop out). */
  function exposureTable(doc, pack) {
    const names = new Set(); const hints = [...(pack?.segments || []).flatMap((s) => (s.geo?.items || []).map((i) => i.name)), ...(pack?.items || []).map((i) => i.title || "")];
    for (const s of pack?.segments || []) for (const i of s.geo?.items || []) { const hit = bestCountry(i.name, hints); if (hit) names.add(hit); }
    for (const c of doc?.constituents || []) { const n = countryName(c.country); if (n) names.add(n); }
    return [...names].filter((n) => !isUS(n)).map((country) => ({ country, ...countryExposure(doc, pack, country, hints) })).filter((x) => (x.revenue_share || 0) > 0.005 || x.hq.length).sort((a, b) => (b.revenue_share || 0) - (a.revenue_share || 0));
  }
  /**
   * Revenue the companies report only by region (e.g. "Asia Pacific", "Europe", "Other"), not by country: a country
   * inside one of these has no country-level number in the filings. Revenue-weighted like countryExposure.
   */
  function regionMix(doc, pack) {
    const rev = Object.fromEntries((doc?.constituents || []).map((c) => [c.symbol, v(c.rev_ttm)]));
    const hints = (pack?.segments || []).flatMap((s) => (s.geo?.items || []).map((i) => i.name));
    const acc = {}; let den = 0;
    for (const s of pack?.segments || []) {
      if (!s.geo || !(rev[s.symbol] > 0)) continue; den += rev[s.symbol];
      for (const i of s.geo.items) if (!bestCountry(i.name, hints)) { const k = String(i.name).trim(); acc[k] = (acc[k] || 0) + i.share * rev[s.symbol]; }
    }
    return den ? Object.entries(acc).map(([region, x]) => ({ region, share: x / den })).filter((x) => x.share > 0.005).sort((a, b) => b.share - a.share).slice(0, 8) : [];
  }

  /** Last 30 days of news that names this country: wire items plus a topic search on the country (kept only if the country is in the headline or lede). */
  async function countryNews(eod, ctx, country, terms, wire, store, max = 15) {
    const hit = reCase(country);
    const lede = (t, x) => `${t} ${String(x || "").slice(0, 600)}`;
    const out = new Map();
    for (const it of wire?.items || []) if (hit(lede(it.title, it.summary))) out.set(it.url, it);
    if (eod) for (const t of [...new Set([country.toLowerCase(), ...(terms || []).map((x) => String(x).toLowerCase())])].slice(0, 3)) {
      ctx.onStep?.(`News on ${t}`);
      let rows = null;
      try { rows = await eod("get_company_news", { tag: t, start_date: addDays(ctx.today, -30), end_date: ctx.today, limit: 40 }); } catch (e) { if (ctx.isFatal?.(e)) throw e; }
      for (const r of Array.isArray(rows) ? rows : []) {
        if (!r?.link || out.has(r.link) || !hit(lede(r.title, r.content))) continue;
        out.set(r.link, store.add({ date: day(r.date), source: host(r.link) || "EODHD", title: trim(r.title, 220), summary: trim(r.content, 900), url: r.link, tags: (r.tags || []).slice(0, 8) }));
      }
    }
    return [...out.values()].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, max);
  }

  /** Deterministic system health (0-100, higher is healthier) from the country map. */
  function healthScore(countries) {
    const wI = { existential: 3, high: 2, medium: 1 }, wS = { allied: 0.1, competitive: 0.55, adversarial: 0.9, sanctioned: 1 }, wT = { improving: 0.4, volatile: 0.7, deteriorating: 0.85, escalating: 1 };
    let strain = 0, max = 0;
    // A credible threat of invasion or war adds strain on top of the political relationship.
    const wX = { none: 0, low: 0.05, elevated: 0.15, high: 0.3, critical: 0.45 };
    for (const c of countries || []) { const w = wI[c.importance] || 1; max += w; strain += w * Math.min(1, (wS[c.stance] ?? 0.5) * (wT[c.trajectory] ?? 0.7) + (wX[c.threat] ?? 0)); }
    if (!max) return null;
    const score = Math.round(100 * (1 - strain / max));
    return { score, band: score >= 75 ? "healthy" : score >= 55 ? "manageable" : score >= 35 ? "strained" : "critical" };
  }

  // ------------------------------------------------------------------ prompts
  const pctS = (x) => (isNum(v(x)) ? (v(x) * 100).toFixed(0) + "%" : "n/a");
  function exposureBlock(rows) {
    return rows.length ? "COUNTRY EXPOSURE FROM FILINGS (computed: share of revenue across companies reporting a geographic split; companies headquartered there and their share of industry market cap)\n" + rows.slice(0, 25).map((x) =>
      `${x.country}: revenue ${x.revenue_share === null ? "n/a" : pctS(x.revenue_share)}${x.companies.length ? ` (${x.companies.slice(0, 5).map((c) => `${c.symbol} ${pctS(c.share)}`).join(", ")})` : ""}${x.hq.length ? `; HQ: ${x.hq.slice(0, 6).join(", ")} (${pctS(x.hq_weight)} of cap)` : ""}`).join("\n") : "COUNTRY EXPOSURE FROM FILINGS: none reported.";
  }
  const evLine = (i) => `[${i.id}] ${i.date} · ${i.source || ""} — ${i.title}${i.summary ? ". " + trim(i.summary, 500) : ""}`;

  function mapPrompt(doc, pack, tx, macro, ctx, T) {
    const tradeWire = (ctx.wire?.items || []).slice(0, 120);
    const txLines = (tx?.items || []).filter((t) => t.excerpt);
    return `You are the trade-relations analyst on a buy-side research team. Map where this industry's supply chain is fragile and who has leverage over it. Rank countries by OPERATIONAL importance to these companies (where the products are made, where the tools and chokepoint inputs come from, where assembly and packaging happen, which end markets matter), not by total trade dollars.

${T.header(doc, ctx)}

${T.companiesBlock(doc, 25)}

${exposureBlock(ctx.exposure || [])}
${(ctx.regions || []).length ? `REVENUE REPORTED ONLY BY REGION (no country split in the filings): ${ctx.regions.map((r) => `${r.region} ${pctS(r.share)}`).join(", ")}` : ""}
${ctx.kpiDigest ? `\nINDUSTRY KPI ANALYST'S READ (segments and supply drivers)\n${ctx.kpiDigest}` : ""}
${ctx.worldDigest ? `\nLIVE WORLD SITUATIONS (from the world-events team)\n${ctx.worldDigest}` : ""}
${ctx.regDigest ? `\nREGULATION ANALYST'S READ\n${ctx.regDigest}` : ""}

COUNTRY MACRO ROWS
${(macro?.rows || []).map((r) => `[${r.id}] ${r.label}: ${T.fmtVal(r)}${r.period || r.date ? ` (${r.period || r.date})` : ""}`).join("\n") || "n/a"}

WORLD NEWS WIRE (pick out what is about trade, tariffs, export controls and supply chains; cite by ID)
${tradeWire.map((i) => evLine({ ...i, summary: trim(i.summary, 160) })).join("\n") || "(none)"}

EARNINGS-CALL EXCERPTS (look for geography, sourcing and supply; cite by T-ID)
${txLines.map((t) => `[${t.id}] ${t.symbol}: ${String(t.excerpt).slice(0, 2500)}`).join("\n\n") || "(none)"}

${T.RULES}
- This is about the UNITED STATES' trade relations with other countries: never list the United States itself. "stance" and "trajectory" describe the country's relationship with the US.
- Supply-chain structure (who makes what where, e.g. which country dominates a tool or material) may come from general industry knowledge; current events, policy actions and figures need citations. Mark uncited shares or figures "(estimate)".
- "revenue_share_estimate": your estimate of the share of these companies' combined revenue that comes from customers in that country, in %, when the filings above don't give it (many report only regions); null if you can't estimate. Say what it rests on in "revenue_basis".
- "threat": the security threat to that country (invasion, blockade, war, armed conflict on or near its territory, or a threat it poses to a neighbor that would disrupt this supply chain): none | low | elevated | high | critical, with "threat_note" naming who threatens whom and how; cite current events.

JSON shape:
{"summary": "4-5 sentences: where the leverage sits and how it is shifting",
 "countries": [{"country": "name", "rank": 1, "roles": ["manufacturing hub | tooling & equipment | chokepoint input | assembly & packaging | end market | R&D & IP | logistics route"], "importance": "existential | high | medium",
   "stance": "allied | competitive | adversarial | sanctioned", "trajectory": "improving | deteriorating | volatile | escalating",
   "why": "2 sentences naming the specific operations, companies and inputs (e.g. TSMC's advanced-node fabs, ASML's EUV tools, high-purity photoresists, gallium refining, OSAT plants)",
   "revenue_share_estimate": 12, "revenue_basis": "e.g. TSMC and Qualcomm disclose ~10-15% of sales to customers headquartered there (estimate)",
   "threat": "none | low | elevated | high | critical", "threat_note": "one sentence, cited",
   "search_terms": ["1-2 extra topic tags for news, e.g. 'export controls'"], "evidence": []}]}
Sizes: 10-14 countries other than the United States, ranked.`;
  }

  function divePrompt(doc, pack, macro, ctx, batch, T) {
    return `You are the trade-relations analyst on a buy-side research team. Write the bilateral deep dive for each country below: the United States' relationship with that country, every material risk in it, any threat of invasion or war, what this industry depends on there, what breaks if trade freezes, whether it can be replaced, and which tickers are on the hook through which P&L line. "We" and "our" mean the United States.

${T.header(doc, ctx)}

${T.companiesBlock(doc, 25)}

${batch.map((c) => `=== ${c.country} (rank ${c.rank}; ${c.roles.join(", ")}; ${c.importance} importance; relationship with the US ${c.stance}, ${c.trajectory}; security threat ${c.threat || "n/a"}${c.threat_note ? `: ${c.threat_note}` : ""}) ===
Why it matters (map): ${c.why}
Exposure from filings: revenue ${c.exposure?.revenue_share === null || c.exposure?.revenue_share === undefined ? "n/a" : pctS(c.exposure.revenue_share)}${c.exposure?.companies?.length ? ` (${c.exposure.companies.map((x) => `${x.symbol} ${pctS(x.share)}`).join(", ")})` : ""}${c.exposure?.hq?.length ? `; HQ: ${c.exposure.hq.join(", ")}` : ""}
Macro rows: ${(macro?.rows || []).filter((r) => reCase(c.country)(r.label) || samePlace(r.country ? countryName(r.country) || r.country : "", c.country)).map((r) => `[${r.id}] ${r.label} ${T.fmtVal(r)}`).join("; ") || "none"}
News (last 30 days; cite by ID):
${(c.news || []).map(evLine).join("\n") || "(none found)"}`).join("\n\n")}

${T.RULES}
- Supply-chain structure may come from general industry knowledge; set "basis" to "cited" only when an evidence ID supports the dependency, otherwise "background". Current policy actions, dates, fines and figures need citations. Shares of global supply without a citation must say "(estimate)".
- "relationship": the United States' relationship with each country as it stands: alliance or treaty status, trade agreements and tariff levels in BOTH directions, export controls and sanctions either way, diplomatic tone and recent summits or disputes, and where it is heading. Cite current events.
- "risks": every material risk to this industry from this country or from the US–country relationship (tariff escalation, new export controls, sanctions, invasion or war, political instability, currency, regulation, expropriation, logistics), each with likelihood, impact, timing, the mechanism and the tickers hit.
- "security": if the country faces a threat of invasion, blockade or war (or poses one to a neighbor), say who threatens whom, what is happening now, and what an invasion, blockade or war would do to this industry's supply and revenue, by ticker. Use threat_level "none" when there is no credible threat.
- "exposed": tickers from the company table only, each with the exact P&L line: revenue (banned from selling, demand loss), gross margin (tariffs, surcharges, rerouting, air freight), capex (relocating capacity), compliance (fines, licenses), supply (shortages, line stoppages).

JSON shape:
{"countries": [{"country": "exact name as above", "headline": "one line: the bilateral risk in a sentence",
  "relationship": {"alliance": "treaty ally | partner | neutral | rival | adversary", "summary": "3-5 sentences on the US relationship with this country today and its direction, cited", "trade_terms": "tariffs, quotas, agreements and controls in force both ways, cited", "tension_points": ["specific, cited"], "cooperation": ["specific, cited"], "evidence": []},
  "risks": [{"risk": "the specific risk", "type": "tariffs | export controls | sanctions | military conflict | political instability | currency | regulation | expropriation | logistics | other", "likelihood": "high | medium | low", "impact": "high | medium | low", "timing": "0-3M | 3-12M | 12M+", "mechanism": "how it hits revenue, margins, supply or capex", "tickers": ["TICKER"], "evidence": []}],
  "security": {"threat_level": "none | low | elevated | high | critical", "threat": "who threatens whom and how", "status": "what is happening now (exercises, blockades, troop movements, ceasefire), cited", "industry_impact": "what an invasion, blockade or war would do to this industry: supply, revenue, tickers", "evidence": []},
  "dependencies": [{"input": "what is made or sourced there", "category": "raw material | component | tooling | manufacturing capacity | assembly & test | end market | IP & software | logistics", "criticality": "critical | high | medium | low", "share": "e.g. ~90% of leading-edge foundry capacity (estimate)", "substitutability": "<6 months | 6-18 months | 1-3 years | 3-5+ years", "replacement": "what replacing it takes: alternatives, capex, qualification time", "loss_risk": "the immediate consequence if severed", "basis": "cited | background", "evidence": []}],
  "policy": [{"instrument": "tariff, export control, entity listing, subsidy, customs action...", "status": "in force | announced | proposed | suspended | expired", "date": "YYYY-MM-DD or YYYY-MM", "effect": "who and how much", "evidence": []}],
  "developments": [{"date": "YYYY-MM-DD", "text": "dated development", "evidence": []}],
  "exposed": [{"symbol": "TICKER", "channel": "revenue | gross margin | capex | compliance | supply", "mechanism": "exact transmission into the P&L", "severity": "high | medium | low", "evidence": []}],
  "freeze": "what breaks in the first 30, 90 and 365 days if trade with this country froze",
  "outlook": "2-3 sentences on the next 6-12 months, cited where possible",
  "watch": ["specific things to watch"]}]}
Sizes per country: 2-4 tension points and cooperation items, 3-6 risks, 2-5 dependencies, 0-4 policy items, 0-5 developments (cited), 2-6 exposed tickers, 2-4 watch items. Cover every country listed above.`;
  }

  function verdictPrompt(doc, ctx, map, dives, health, T) {
    return `You are the head of supply-chain research on a buy-side team. Aggregate the bilateral picture below into one supply-chain verdict for this industry.

${T.header(doc, ctx)}

COUNTRY MAP (ranked) AND DEEP DIVES
${map.countries.map((c) => { const d = dives.find((x) => x.country === c.country);
  return `${c.rank}. ${c.country} — ${c.roles.join(", ")}; ${c.importance}; ${c.stance}, ${c.trajectory}; security threat ${c.threat || "n/a"}. ${c.why}${d ? `\n   ${d.headline} US relationship: ${d.relationship?.alliance || "n/a"}; ${d.relationship?.summary || ""} Risks: ${(d.risks || []).map((x) => `${x.risk} (${x.type}, ${x.likelihood} likelihood, ${x.impact} impact)`).join("; ") || "none"}. Security: ${d.security?.threat_level || "n/a"}${d.security?.threat ? " — " + d.security.threat : ""}. Dependencies: ${d.dependencies.map((x) => `${x.input} (${x.criticality}, replace ${x.substitutability})`).join("; ")}. Exposed: ${d.exposed.map((x) => `${x.symbol} ${x.channel}`).join(", ")}. Developments: ${d.developments.map((x) => `${x.date} ${x.text} [${x.evidence.join(", ")}]`).join("; ") || "none"}` : ""}`; }).join("\n")}

COMPUTED SYSTEM HEALTH (from importance x stance x trajectory): ${health ? `${health.score}/100 (${health.band})` : "n/a"}
${ctx.kpiDigest ? `\nPRICING POWER AND CYCLE (industry KPI analyst)\n${ctx.kpiDigest}` : ""}

${T.RULES}

JSON shape:
{"rating": "healthy | manageable | strained | critical", "headline": "one sentence verdict",
 "summary": "4-6 sentences: how the bilateral ties add up, what is fragile, what is improving",
 "bottlenecks": [{"chokepoint": "the input or capacity", "countries": ["..."], "delivery_impact": "what happens to lead times and delivery", "severity": "critical | high | medium", "evidence": []}],
 "investment_read": {"pass_through": "strong | partial | weak", "derate_risk": "high | medium | low", "text": "3-4 sentences: can pricing power pass trade-friction costs to customers, or do multiples need a structural geopolitical discount; name tickers"},
 "most_exposed": [{"symbol": "TICKER", "why": "..."}], "most_resilient": [{"symbol": "TICKER", "why": "..."}],
 "watch": ["..."]}
Sizes: 3-5 bottlenecks, 3-6 most exposed, 2-4 most resilient, 3-5 watch items. If your rating differs from the computed band, explain why in the summary.`;
  }

  // ------------------------------------------------------------------ critics
  const EN = (x, list, d) => { const s = String(x ?? "").toLowerCase().trim(); return list.find((l) => l === s) || list.find((l) => s.startsWith(l.split(/[ &<-]/)[0]) && l.split(/[ &<-]/)[0].length > 1) || (s.length >= 5 ? list.find((l) => l.slice(0, 5) === s.slice(0, 5)) : null) || d; };
  /** Normalize free-text replacement time into the four buckets. */
  function subst(x) {
    const t = String(x || "").toLowerCase().replace(/–|—/g, "-");
    if (/<\s*6|under 6|less than 6|weeks|days|1\s*-\s*3 months|3 months|immediate/.test(t)) return "<6 months";
    if (/3\s*-\s*5|5\+|4\s*-\s*5|5\s*-\s*10|decade|3\+\s*years|(?:^|\D)(?:4|5|6|7|8|10)\s*years/.test(t)) return "3-5+ years";
    if (/1\s*-\s*3|1\s*-\s*2|2\s*-\s*3|18\s*-\s*36|(?:^|\D)[123]\s*years?|a year|two years/.test(t)) return "1-3 years";
    if (/6\s*-\s*18|6\s*-\s*12|12\s*-\s*18|9\s*-\s*12|(?:^|\D)(?:6|9|12|18)\s*months/.test(t)) return "6-18 months";
    return "1-3 years";
  }
  function cleanMap(raw, idx, doc, T) {
    const { S, Ev, A } = T.makeCritic(idx, T.tickersOf(doc));
    const seen = new Set();
    const countries = A(raw?.countries, 14, (c) => {
      const name = S(c.country, 40); const k = name.toLowerCase(); if (!name || seen.has(k) || isUS(name)) return null; seen.add(k);
      const est = Number(String(c.revenue_share_estimate ?? "").replace(/[^0-9.]/g, ""));
      return { country: name, rank: 0, roles: [...new Set((Array.isArray(c.roles) ? c.roles : []).map((r) => EN(r, ROLES, null)).filter(Boolean))].slice(0, 4),
        importance: EN(c.importance, IMPORTANCE, "medium"), stance: EN(c.stance, STANCES, "competitive"), trajectory: EN(c.trajectory, TRAJ, "volatile"),
        why: S(c.why, 500), revenue_share_estimate: isNum(est) && est > 0 && est <= 100 && c.revenue_share_estimate !== null ? est / 100 : null, revenue_basis: S(c.revenue_basis, 240),
        threat: EN(c.threat, THREAT, "none"), threat_note: S(c.threat_note, 300), search_terms: (Array.isArray(c.search_terms) ? c.search_terms : []).map((t) => S(t, 40)).filter(Boolean).slice(0, 2), evidence: Ev(c.evidence, 5) };
    });
    countries.forEach((c, i) => { c.rank = i + 1; });
    return { summary: S(raw?.summary, 1200), countries };
  }
  function cleanDives(raw, idx, doc, batch, T) {
    const { S, Ev, Tk, A } = T.makeCritic(idx, T.tickersOf(doc));
    const out = [];
    for (const c of batch) {
      const r = (Array.isArray(raw?.countries) ? raw.countries : []).find((x) => String(x?.country || "").toLowerCase() === c.country.toLowerCase()) || null;
      if (!r) continue;
      const rel = r.relationship || {}, sec = r.security || {};
      out.push({ country: c.country, headline: S(r.headline, 300),
        relationship: { alliance: EN(rel.alliance, ALLIANCE, ""), summary: S(rel.summary, 1200), trade_terms: S(rel.trade_terms, 700),
          tension_points: (Array.isArray(rel.tension_points) ? rel.tension_points : []).slice(0, 5).map((x) => S(x, 300)).filter(Boolean),
          cooperation: (Array.isArray(rel.cooperation) ? rel.cooperation : []).slice(0, 5).map((x) => S(x, 300)).filter(Boolean), evidence: Ev(rel.evidence, 5) },
        risks: A(r.risks, 7, (x) => (S(x.risk, 5) ? { risk: S(x.risk, 240), type: EN(x.type, RISK_TYPES, "other"), likelihood: EN(x.likelihood, ["high", "medium", "low"], "medium"), impact: EN(x.impact, ["high", "medium", "low"], "medium"),
          timing: S(x.timing, 12), mechanism: S(x.mechanism, 400), tickers: Tk(x.tickers, 6), evidence: Ev(x.evidence, 3) } : null))
          .sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.likelihood] + { high: 0, medium: 1, low: 2 }[a.impact]) - ({ high: 0, medium: 1, low: 2 }[b.likelihood] + { high: 0, medium: 1, low: 2 }[b.impact])),
        security: { threat_level: EN(sec.threat_level, THREAT, c.threat || "none"), threat: S(sec.threat, 300), status: S(sec.status, 600), industry_impact: S(sec.industry_impact, 800), evidence: Ev(sec.evidence, 4) },
        dependencies: A(r.dependencies, 5, (x) => { if (!S(x.input, 2)) return null; const ev = Ev(x.evidence, 3);
          return { input: S(x.input, 160), category: S(x.category, 40), criticality: EN(x.criticality, CRIT, "medium"), share: S(x.share, 160), substitutability: subst(x.substitutability),
            replacement: S(x.replacement, 400), loss_risk: S(x.loss_risk, 400), basis: ev.length ? "cited" : "background", evidence: ev }; }),
        policy: A(r.policy, 4, (x) => { const ev = Ev(x.evidence, 3); return S(x.instrument, 3) && ev.length ? { instrument: S(x.instrument, 200), status: S(x.status, 30), date: S(x.date, 10), effect: S(x.effect, 400), evidence: ev } : null; }),
        developments: A(r.developments, 5, (x) => { const ev = Ev(x.evidence, 3); return S(x.text, 5) && ev.length ? { date: S(x.date, 10), text: S(x.text, 300), evidence: ev } : null; }).sort((a, b) => (a.date < b.date ? 1 : -1)),
        exposed: A(r.exposed, 6, (x) => { const s = Tk([x.symbol])[0]; return s ? { symbol: s, channel: EN(x.channel, CHANNELS, "revenue"), mechanism: S(x.mechanism, 400), severity: EN(x.severity, ["high", "medium", "low"], "medium"), evidence: Ev(x.evidence, 3) } : null; }),
        freeze: S(r.freeze, 900), outlook: S(r.outlook, 700), watch: (Array.isArray(r.watch) ? r.watch : []).slice(0, 4).map((w) => S(w, 200)).filter(Boolean),
        news: (c.news || []).map((n) => n.id) });
    }
    return out;
  }
  function cleanVerdict(raw, idx, doc, T, health) {
    const { S, Ev, Tk, A } = T.makeCritic(idx, T.tickersOf(doc));
    return { rating: EN(raw?.rating, RATINGS, health?.band || "manageable"), health, headline: S(raw?.headline, 300), summary: S(raw?.summary, 1500),
      bottlenecks: A(raw?.bottlenecks, 5, (b) => (S(b.chokepoint, 3) ? { chokepoint: S(b.chokepoint, 160), countries: (Array.isArray(b.countries) ? b.countries : []).map((x) => S(x, 40)).filter(Boolean).slice(0, 4), delivery_impact: S(b.delivery_impact, 400), severity: EN(b.severity, ["critical", "high", "medium"], "high"), evidence: Ev(b.evidence, 3) } : null)),
      investment_read: { pass_through: EN(raw?.investment_read?.pass_through, ["strong", "partial", "weak"], "partial"), derate_risk: EN(raw?.investment_read?.derate_risk, ["high", "medium", "low"], "medium"), text: S(raw?.investment_read?.text, 900) },
      most_exposed: A(raw?.most_exposed, 6, (w) => { const s = Tk([w.symbol])[0]; return s ? { symbol: s, why: S(w.why, 260) } : null; }),
      most_resilient: A(raw?.most_resilient, 4, (w) => { const s = Tk([w.symbol])[0]; return s ? { symbol: s, why: S(w.why, 260) } : null; }),
      watch: (Array.isArray(raw?.watch) ? raw.watch : []).slice(0, 5).map((w) => S(w, 220)).filter(Boolean) };
  }
  function digest(t) {
    if (!t) return "";
    return `${t.verdict ? `Supply chain ${t.verdict.rating} (health ${t.verdict.health?.score ?? "n/a"}/100): ${t.verdict.headline} ${t.verdict.summary} Bottlenecks: ${(t.verdict.bottlenecks || []).map((b) => b.chokepoint).join("; ")}.` : ""} Countries: ${(t.map?.countries || []).map((c) => `${c.rank}. ${c.country} (${c.stance}, ${c.trajectory})`).join("; ")}`;
  }

  const Trade = { THREAT, ALLIANCE, RISK_TYPES, isUS, regionMix, subst, countryName, allCountries, samePlace, bestCountry, ROLES, IMPORTANCE, STANCES, TRAJ, CRIT, SUBST, CHANNELS, RATINGS, countryRe, countryExposure, exposureTable, countryNews, healthScore, mapPrompt, divePrompt, verdictPrompt, cleanMap, cleanDives, cleanVerdict, digest };
  if (typeof module !== "undefined" && module.exports) module.exports = Trade;
  else root.Trade = Trade;
})(typeof window !== "undefined" ? window : globalThis);
