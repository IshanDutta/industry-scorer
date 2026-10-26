/* Industry Scorer: analyst agent.
 *
 * Input: the industry's computed metrics plus the research pack gathered by
 * code (research.js), every item tagged with an ID such as N3 or M1. Claude
 * (the `sample` capability, on the viewer's own account) writes the analysis:
 * an executive summary, a verdict for each investor type, commentary for each
 * section, and a judgment on seven landscape dimensions citing evidence IDs.
 * When the view supports tools, Claude can also dig further with FMP tools.
 *
 * A code-level critic then keeps only citations that resolve to retrieved
 * items, sets dimensions without evidence to neutral, and caps the score
 * overlay at +/-10, scaled down when evidence is thin. No number in the quant
 * engine comes from the model.
 */
(function (root) {
  "use strict";
  const DIMENSIONS = [
    ["macro", "Macro environment"], ["news", "Industry news"], ["world_events", "World events"],
    ["regulatory", "Regulators & policy"], ["perception", "Public perception"], ["mna", "M&A"], ["legal", "Court cases & legal"],
  ];
  const SECTIONS = [["performance", "Performance vs SPY"], ["risk", "Risk"], ["fundamentals", "Fundamentals"], ["valuation", "Valuation"], ["earnings", "Earnings"], ["health", "Financial health"]];
  const PROFILES = ["income", "conservative", "growth", "aggressive"];
  const OVERLAY_CAP = 5;

  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const trim = (s, n) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  const day = (s) => String(s ?? "").slice(0, 10);
  function normUrl(u) {
    try { const x = new URL(String(u)); return (x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/+$/, "") + x.search).toLowerCase(); }
    catch { return null; }
  }
  function addDays(d, k) { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + k); return t.toISOString().slice(0, 10); }
  const pct = (x, d = 1) => (isNum(x) ? (x * 100).toFixed(d) + "%" : "n/a");
  const num = (x, d = 1) => (isNum(x) ? x.toFixed(d) : "n/a");

  /** Optional extra-research tools (used only when the view supports tools). */
  function buildTools(fmp, ctx) {
    const seen = new Set(); const log = [];
    const remember = (rows) => { for (const r of rows) { const k = normUrl(r.url); if (k) seen.add(k); } return rows; };
    const syms = (a) => (Array.isArray(a) ? a : []).map((s) => String(s).toUpperCase().trim()).filter(Boolean).slice(0, 10);
    const step = (l) => { log.push(l); ctx.onStep?.(l); };
    const tools = [
      { name: "search_company_news",
        description: "More news for specific tickers (up to 10) over a look-back window. Returns [{date, symbol, site, title, summary, url}]. Use only if the provided evidence is thin for a question you need to answer.",
        inputSchema: { type: "object", properties: { symbols: { type: "array", items: { type: "string" } }, days: { type: "number", description: "1-90, default 60" } }, required: ["symbols"] },
        async execute(input) {
          const s = syms(input.symbols); if (!s.length) throw new Error("Pass at least one ticker.");
          step(`Extra news search: ${s.slice(0, 4).join(", ")}${s.length > 4 ? "…" : ""}`);
          const d = Math.min(Math.max(Number(input.days) || 60, 1), 90);
          const rows = await fmp("news", { endpoint: "search-stock-news", symbols: s, from_date: addDays(ctx.today, -d), to_date: ctx.today, limit: 50 });
          return remember(rows.slice(0, 50).map((r) => ({ date: day(r.publishedDate), symbol: r.symbol, site: r.site, title: trim(r.title, 180), summary: trim(r.text, 220), url: r.url })));
        } },
      { name: "search_mna",
        description: "Search SEC M&A filings by company name. Returns [{date, acquirer, target, url}].",
        inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        async execute(input) {
          step(`M&A search: ${trim(input.name, 40)}`);
          const rows = await fmp("company", { endpoint: "search-mergers-acquisitions", name: String(input.name || "").slice(0, 60) });
          return remember(rows.slice(0, 20).map((r) => ({ date: day(r.transactionDate), acquirer: r.companyName, target: r.targetedCompanyName, url: r.link })));
        } },
    ];
    return { tools, seen, log };
  }

  function evidenceLines(pack, max = 140) {
    const pri = { M: 0, P: 1, N: 2, E: 3, W: 4 };
    const items = [...(pack?.items || [])].sort((a, b) => (pri[a.kind] - pri[b.kind]) || (a.date < b.date ? 1 : -1)).slice(0, max);
    return items.map((i) => `[${i.id}] ${i.date} · ${i.source || ""}${i.symbol ? " · " + i.symbol : ""}${i.polarity !== null && i.polarity !== undefined ? ` · sentiment ${num(i.polarity, 2)}` : ""}${i.legal ? " · legal" : ""}${i.regulatory ? " · regulatory" : ""} — ${i.title}${i.summary ? ". " + trim(i.summary, 180) : ""}`).join("\n");
  }

  function buildPrompt(doc, pack, scores, ctx) {
    const s = doc.summary || {}, f = doc.fund || {};
    const top = [...(doc.constituents || [])].sort((a, b) => b.weight - a.weight).slice(0, 12).map((c) => `${c.symbol} ${c.name} ${(c.weight * 100).toFixed(1)}%`).join("; ");
    const ind = (ctx.macroRows || []).map((r) => `${r.label}: ${r.value}${r.unit === "%" ? "%" : r.unit ? " " + r.unit : ""} (${r.date})`).join("; ")
      || (pack?.indicators || []).map((i) => `${i.label}: ${i.latest.value}${i.unit} (${i.latest.date})`).join("; ");
    const team = ctx.team ? Object.entries(ctx.team).filter(([, t]) => t).map(([k, t]) => `${k.toUpperCase()}:\n${t}`).join("\n\n") : "";
    const cal = (pack?.calendar || []).slice(0, 12).map((c) => `${c.date} ${c.event} [${c.impact}] est ${c.estimate ?? "n/a"} prev ${c.previous ?? "n/a"}`).join("; ");
    const sen = pack?.sentiment ? `EODHD measured news sentiment (scale -1 to +1): last 7 days ${num(pack.sentiment.last_7d, 3)}, prior 30 days ${num(pack.sentiment.prior_30d, 3)}, 90 days ${num(pack.sentiment.last_90d, 3)}, ${pack.sentiment.articles_30d} articles in 30 days. By company (30d score, articles): ${pack.sentiment.by_company.slice(0, 10).map((c) => `${c.symbol} ${num(c.score_30d, 2)} (${c.articles_30d})`).join(", ")}` : "No measured sentiment data (EODHD not connected); judge perception from coverage tone.";
    const sc = PROFILES.map((p) => `${p} ${isNum(scores?.profiles?.[p]?.base) ? Math.round(scores.profiles[p].base) : "n/a"}`).join(", ");
    const pil = Object.entries(scores?.pillars || {}).map(([k, v]) => `${k} ${isNum(v) ? Math.round(v) : "n/a"}`).join(", ");
    return `You are the lead analyst on a buy-side team writing the summary of the industry report for the US-listed "${doc.name}" industry (its 50 largest companies). Today is ${ctx.today}. Write for an investor deciding whether this industry fits their style.

LARGEST COMPANIES (share of industry market cap): ${top}
Concentration: largest company ${pct(s.top1_weight, 0)}, top five ${pct(s.top5_weight, 0)}.

COMPUTED METRICS (do not recompute; interpret them)
Performance, cap-weighted vs SPY: 1M ${pct(s.excess_cw_1M)}, 3M ${pct(s.excess_cw_3M)}, 6M ${pct(s.excess_cw_6M)}, 1Y ${pct(s.excess_cw_1Y)}. Median stock vs SPY 1Y ${pct(s.excess_median_1Y)}. Breadth (share beating SPY) 1M ${pct(s.breadth_1M, 0)}, 3M ${pct(s.breadth_3M, 0)}, 6M ${pct(s.breadth_6M, 0)}, 1Y ${pct(s.breadth_1Y, 0)}.
Risk (1Y, industry index): beta ${num(s.beta, 2)}, volatility ${pct(s.vol_1y)}, downside volatility ${pct(s.downside_vol_1y)}, max drawdown ${pct(s.max_dd_1y)}, Sharpe ${num(s.sharpe_1y, 2)}.
Fundamentals (TTM, aggregated): revenue growth ${pct(f.rev_growth)}, earnings growth ${pct(f.ni_growth)}, gross margin ${pct(f.gross_margin)}, operating margin ${pct(f.op_margin)}, net margin ${pct(f.net_margin)}, ROE ${pct(f.roe)}.
Valuation: P/E ${f.pe_negative ? "negative earnings" : num(f.pe)} vs 5-year median ${num(f.pe_hist_median)} (${pct(f.pe_vs_hist)} vs median, ${pct(f.pe_hist_pct, 0)} percentile), P/S ${num(f.ps)}, P/B ${num(f.pb)}, EV/EBITDA ${num(f.ev_ebitda)}, dividend yield ${pct(f.div_yield, 2)}.
Earnings (last 4 quarters): beat rate ${pct(f.beat_rate, 0)} of ${f.beat_reports ?? 0} reports, median EPS surprise ${pct(f.eps_surprise_median)}, median revenue surprise ${pct(f.rev_surprise_median)}. Next to report: ${(f.next_reports || []).slice(0, 10).map((r) => `${r.symbol} ${r.date}`).join(", ") || "none scheduled"}.
Financial health: debt/equity ${num(f.de, 2)}, current ratio ${num(f.current_ratio, 2)}, interest cover ${num(f.int_cover)}x, FCF margin ${pct(f.fcf_margin)}, ROIC ${pct(f.roic)}.${f.financial ? " (Financial-sector industry: industrial ratios like gross margin and D/E don't apply.)" : ""}
Quant scores (0-100, before your adjustment): ${sc}. Pillars: ${pil}.

MACRO DATA
US indicators: ${ind || "n/a"}. 3M T-bill ${pct(ctx.rf, 2)}, 10Y Treasury ${pct(ctx.y10, 2)}.
Upcoming US releases: ${cal || "none listed"}.
${sen}

${team ? `SPECIALIST TEAM REPORTS (already written by your team; build on them, stay consistent, don't repeat them at length)\n${team}\n\n` : ""}EVIDENCE (retrieved today; cite by ID. N = company news, P = press release, W = world/market news, M = SEC M&A filing, E = EODHD news with sentiment)
${evidenceLines(pack) || "(no items retrieved)"}

TASK
1. Read the evidence. Identify what matters for this industry over the next 3-12 months.
2. Judge seven landscape dimensions: macro (rates, inflation, growth, and how sensitive this industry is to them), news (company and industry developments), world_events (geopolitics, trade, tariffs, conflicts, elections, central banks abroad), regulatory (which regulators matter and what they are doing), perception (how investors, customers and the public see the industry), mna (deal activity and consolidation), legal (lawsuits, court rulings, settlements, investigations, antitrust).
3. Write the report.

RULES
- Every factual claim about a current event must cite evidence IDs from the list above (or URLs returned by your tools). Never invent events, IDs or links. If there is nothing relevant for a dimension, score it 0 and say so plainly.
- regulatory.bodies: the 3-8 regulators/agencies that matter most for this industry and why, in a few words each (background knowledge is fine here; claims about current actions still need citations).
- Scores: -2 strong headwind, -1 headwind, 0 neutral/unclear, +1 tailwind, +2 strong tailwind.
- overlay: integer -10..+10 per investor type, only for what the metrics can't see (pending regulation, litigation, deals, macro shifts, sentiment). Income = dividends and stability; Conservative = capital preservation; Growth = revenue/earnings growth; Aggressive = momentum and high risk tolerance.
- Be specific and quantitative: refer to the metrics by value. Plain English, no hype.
- Whenever you mention a macro move (rates, oil, the dollar, inflation, PMIs), name the real-world event behind it as the team reports describe it (a conflict, a central-bank decision, a data release, a trade action), not just the number.

Reply with ONLY this JSON:
{"headline": "one sentence verdict on the industry",
 "summary": "executive summary, 4-6 sentences: what is happening, why, and what it means for investors",
 "profiles": {"income": {"verdict": "2-3 sentences on fit for this investor and why", "overlay": 0}, "conservative": {...}, "growth": {...}, "aggressive": {...}},
 "sections": {"performance": "2-3 sentences interpreting the numbers", "risk": "...", "fundamentals": "...", "valuation": "...", "earnings": "...", "health": "..."},
 "dimensions": {
   "macro": {"score": 0, "summary": "2-4 sentences", "evidence": ["W3", "N5"]},
   "news": {...}, "world_events": {...}, "regulatory": {"score": 0, "summary": "...", "evidence": [], "bodies": [{"name": "FTC", "why": "merger review"}]},
   "perception": {...}, "mna": {...}, "legal": {...}
 },
 "catalysts": ["up to 5, each citing IDs in brackets"], "risks": ["up to 5, each citing IDs in brackets"],
 "watch": ["up to 5 upcoming dates or events to watch, e.g. earnings or data releases"],
 "confidence": "low | medium | high"}
At most 5 evidence IDs per dimension.`;
  }

  /** Critic: resolve citations, drop anything not retrieved, neutralize unsupported dimensions, cap overlay. */
  function critic(raw, pack, seenUrls) {
    const byId = Object.fromEntries((pack?.items || []).map((i) => [String(i.id).toUpperCase(), i]));
    const seen = new Set(seenUrls || []);
    const resolve = (e) => {
      if (typeof e === "string") { const it = byId[e.replace(/[\[\]\s]/g, "").toUpperCase()]; return it ? { id: it.id, claim: it.title, url: it.url, date: it.date, source: it.source } : null; }
      if (e && typeof e === "object") {
        if (e.id && byId[String(e.id).toUpperCase()]) { const it = byId[String(e.id).toUpperCase()]; return { id: it.id, claim: trim(e.claim || it.title, 280), url: it.url, date: it.date, source: it.source }; }
        const k = normUrl(e.url); if (k && seen.has(k)) return { claim: trim(e.claim, 280), url: String(e.url), date: day(e.date), source: trim(e.source, 60) };
      }
      return null;
    };
    const out = { headline: trim(raw?.headline, 300), summary: trim(raw?.summary, 1400), profiles: {}, sections: {}, dimensions: {}, catalysts: [], risks: [], watch: [], overlay: {}, dropped: 0, kept: 0 };
    let supported = 0;
    for (const [key] of DIMENSIONS) {
      const d = raw?.dimensions?.[key] || {};
      const ev = (Array.isArray(d.evidence) ? d.evidence : []).slice(0, 5);
      const good = []; const ids = new Set();
      for (const e of ev) { const r = resolve(e); if (r && !ids.has(r.url)) { ids.add(r.url); good.push(r); } }
      out.dropped += ev.length - good.length; out.kept += good.length;
      let score = Math.max(-2, Math.min(2, Math.round(Number(d.score) || 0)));
      if (!good.length) score = 0; else supported++;
      const bodies = key === "regulatory" ? (Array.isArray(d.bodies) ? d.bodies : []).slice(0, 8).map((b) => (typeof b === "string" ? { name: trim(b, 60), why: "" } : { name: trim(b?.name, 60), why: trim(b?.why, 120) })).filter((b) => b.name) : undefined;
      out.dimensions[key] = { score, summary: trim(d.summary, 700), evidence: good, unsupported: !good.length && ev.length > 0, ...(bodies ? { bodies } : {}) };
    }
    const share = supported / DIMENSIONS.length;
    for (const p of PROFILES) {
      const src = raw?.profiles?.[p] || {};
      const v = Math.round(Number(src.overlay ?? raw?.overlay?.[p]) || 0);
      out.overlay[p] = Math.max(-OVERLAY_CAP, Math.min(OVERLAY_CAP, Math.round(v * share)));
      out.profiles[p] = { verdict: trim(src.verdict, 600) };
    }
    for (const [k] of SECTIONS) out.sections[k] = trim(raw?.sections?.[k], 600);
    // Lists may cite IDs in brackets; strip IDs that don't exist, keep the text.
    const cleanList = (arr, n) => (Array.isArray(arr) ? arr : []).slice(0, n).map((x) => {
      const t = trim(x, 240);
      const refs = [...t.matchAll(/\[([A-Z]\d+)\]/gi)].map((m) => m[1].toUpperCase());
      const valid = refs.filter((r) => byId[r]);
      return { text: t.replace(/\s*\[([A-Z]\d+)\]/gi, (m, r) => (byId[r.toUpperCase()] ? m : "")).trim(), refs: valid.map((r) => ({ id: r, url: byId[r].url })) };
    }).filter((x) => x.text);
    out.catalysts = cleanList(raw?.catalysts, 5);
    out.risks = cleanList(raw?.risks, 5);
    out.watch = (Array.isArray(raw?.watch) ? raw.watch : []).slice(0, 5).map((x) => trim(x, 200)).filter(Boolean);
    out.confidence = ["low", "medium", "high"].includes(raw?.confidence) ? raw.confidence : "low";
    if (supported <= 2) out.confidence = "low";
    out.supported_share = share;
    return out;
  }

  const Agent = { DIMENSIONS, SECTIONS, PROFILES, OVERLAY_CAP, buildTools, buildPrompt, critic, normUrl, evidenceLines };
  if (typeof module !== "undefined" && module.exports) module.exports = Agent;
  else root.Agent = Agent;
})(typeof window !== "undefined" ? window : globalThis);
