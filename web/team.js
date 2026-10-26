/* Industry Scorer: the analyst team.
 *
 * Code gathers all the data (research.js, macro.js, the quant engine); each
 * specialist agent is one Claude call (the `sample` capability, on the
 * viewer's own account) that reads a slice of that data and writes one part of
 * the report as JSON:
 *
 *   kpi     Industry KPI analyst: demand and profitability metrics, unit
 *           economics, pricing power, demand/supply drivers, hot and cool
 *           segments, management signals from earnings calls, dated triggers
 *   macro   Macro strategist: a regime call by horizon and an industry-specific
 *           reading of every indicator in the macro table
 *   scout   World-events scout: picks the situations that matter most
 *   dive    Situation analyst (one per situation): transmission chain,
 *           revenue/cost/demand/regulation channels, statement impact,
 *           exposure map, scenarios with probabilities, winners and losers
 *   reg     Regulation, litigation, deals and perception
 *
 * Every evidence item has an ID (N/P/W/M/E news and filings, T transcripts,
 * I macro indicators). After each call a code critic normalizes the JSON to a
 * fixed shape, keeps only citations that resolve to retrieved items, marks
 * figures without a citation as estimates, restricts tickers to the
 * industry's companies, and drops boilerplate. No number in the quant engine
 * comes from a model.
 */
(function (root) {
  "use strict";
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const v = (x) => (x === null || x === undefined ? NaN : Number(x));
  const trim = (s, n) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  const pct = (x, d = 1) => (isNum(v(x)) ? (v(x) * 100).toFixed(d) + "%" : "n/a");
  const spct = (x, d = 0) => (isNum(v(x)) ? (v(x) >= 0 ? "+" : "") + (v(x) * 100).toFixed(d) + "%" : "n/a");
  const num = (x, d = 1) => (isNum(v(x)) ? v(x).toFixed(d) : "n/a");
  const bn = (x) => (isNum(v(x)) ? (Math.abs(x) >= 1e9 ? "$" + (x / 1e9).toFixed(1) + "B" : "$" + (x / 1e6).toFixed(0) + "M") : "n/a");

  const AGENTS = {
    kpi: { label: "Industry KPI analyst", tier: "complex" },
    macro: { label: "Macro strategist", tier: "complex" },
    scout: { label: "World-events scout", tier: "default" },
    dive: { label: "Situation analyst", tier: "complex" },
    reg: { label: "Regulation, legal & deals analyst", tier: "complex" },
    lead: { label: "Lead analyst", tier: "complex" },
  };
  const REGIMES = ["SUPPORTIVE", "MIXED", "RESTRICTIVE", "HOSTILE"];
  const HORIZONS = ["1M", "3M", "6M", "12M"];
  const BOILER = /macro reference relevant|relevant to .{0,40} financing and demand|is a (?:bom|input) cost relevant to/i;

  // ------------------------------------------------------------------ evidence index
  /** Every citable item by ID: news/filings (pack.items), transcripts (T#), macro rows (I#). */
  function index(pack, tx, macro, ...lists) {
    const idx = {};
    for (const list of lists) for (const i of list || []) if (i?.id) idx[String(i.id).toUpperCase()] = { id: i.id, kind: i.kind || String(i.id)[0], title: i.title, url: i.url, date: i.date, source: i.source, symbol: i.symbol, summary: i.summary };
    for (const i of pack?.items || []) idx[String(i.id).toUpperCase()] = { id: i.id, kind: i.kind, title: i.title, url: i.url, date: i.date, source: i.source, symbol: i.symbol };
    for (const t of tx?.items || pack?.transcripts || []) idx[t.id] = { id: t.id, kind: "T", title: `${t.symbol} ${t.period} earnings call`, url: null, date: t.date, source: "earnings call", symbol: t.symbol };
    for (const r of macro?.rows || []) idx[r.id] = { id: r.id, kind: "I", title: `${r.label}: ${fmtVal(r)}`, url: null, date: r.date, source: r.source };
    return idx;
  }
  function fmtVal(r) {
    const x = v(r.value); if (!isNum(x)) return "n/a";
    const u = r.unit || "";
    const s = Math.abs(x) >= 1000 ? x.toLocaleString("en-US", { maximumFractionDigits: 0 }) : Math.abs(x) >= 100 ? x.toFixed(1) : x.toFixed(2);
    return u === "$" ? "$" + s : u === "%" ? s + "%" : u === "bp" ? Math.round(x) + " bp" : u ? `${s} ${u}` : s;
  }

  // ------------------------------------------------------------------ shared prompt blocks
  function header(doc, ctx) {
    const s = doc.summary || {};
    const top = [...(doc.constituents || [])].sort((a, b) => b.weight - a.weight).slice(0, 20).map((c) => `${c.symbol} (${trim(c.name, 34)}, ${(c.weight * 100).toFixed(1)}%)`).join("; ");
    return `INDUSTRY: the US-listed "${doc.name}" industry, measured as its ${s.n_constituents || 50} largest companies (combined market cap ${bn(s.total_market_cap)}). Today is ${ctx.today}.
LARGEST COMPANIES (share of industry market cap): ${top}`;
  }
  function metricsBlock(doc) {
    const s = doc.summary || {}, f = doc.fund || {};
    return `COMPUTED INDUSTRY METRICS (aggregated across the companies; authoritative, do not recompute)
Performance cap-weighted vs SPY: 1M ${pct(s.excess_cw_1M)}, 3M ${pct(s.excess_cw_3M)}, 6M ${pct(s.excess_cw_6M)}, 1Y ${pct(s.excess_cw_1Y)}; breadth 1Y ${pct(s.breadth_1Y, 0)} beat SPY.
Risk 1Y: beta ${num(s.beta, 2)}, vol ${pct(s.vol_1y)}, max drawdown ${pct(s.max_dd_1y)}, Sharpe ${num(s.sharpe_1y, 2)}.
TTM: revenue growth ${pct(f.rev_growth)}, net income growth ${pct(f.ni_growth)}, gross margin ${pct(f.gross_margin)}, operating margin ${pct(f.op_margin)}, net margin ${pct(f.net_margin)}, ROE ${pct(f.roe)}, FCF margin ${pct(f.fcf_margin)}, ROIC ${pct(f.roic)}.
Valuation: P/E ${f.pe_negative ? "negative" : num(f.pe)} vs 5Y median ${num(f.pe_hist_median)} (${pct(f.pe_hist_pct, 0)} percentile), P/S ${num(f.ps)}, EV/EBITDA ${num(f.ev_ebitda)}, dividend yield ${pct(f.div_yield, 2)}. Debt/equity ${num(f.de, 2)}, interest cover ${num(f.int_cover)}x.
Earnings: beat rate ${pct(f.beat_rate, 0)} of ${f.beat_reports ?? 0} reports, median EPS surprise ${pct(f.eps_surprise_median)}, median revenue surprise ${pct(f.rev_surprise_median)}.`;
  }
  function companiesBlock(doc, n = 30) {
    const rows = [...(doc.constituents || [])].sort((a, b) => b.weight - a.weight).slice(0, n);
    return `COMPANY TABLE (ticker | weight | TTM revenue USD | revenue growth | gross margin | op margin | net margin | P/E | 1Y return | next report)
` + rows.map((c) => `${c.symbol}${c.formerly ? ` (formerly ${c.formerly})` : ""} | ${(c.weight * 100).toFixed(1)}% | ${bn(c.rev_ttm)} | ${spct(c.rev_growth)} | ${pct(c.gross_margin, 0)} | ${pct(c.op_margin, 0)} | ${pct(c.net_margin, 0)} | ${isNum(v(c.pe)) ? num(c.pe, 0) : "n/a"} | ${spct(c.ret_1Y)} | ${c.next || "n/a"}`).join("\n");
  }
  function segmentsBlock(pack) {
    const segs = pack?.segments || [];
    if (!segs.length) return "REVENUE SEGMENTS: none reported.";
    const fmt = (t) => t.items.map((i) => `${trim(i.name, 40)} ${(i.share * 100).toFixed(0)}%${isNum(v(i.yoy)) ? ` (${spct(i.yoy)} y/y)` : ""}`).join("; ");
    return "REVENUE SEGMENTS FROM FILINGS (share of company revenue, growth vs same period a year earlier)\n" + segs.map((s) =>
      `${s.symbol}: ${s.product ? `by product ${s.product.label}: ${fmt(s.product)}` : ""}${s.product && s.geo ? " | " : ""}${s.geo ? `by geography ${s.geo.label}: ${fmt(s.geo)}` : ""}`).join("\n");
  }
  function analystBlock(pack) {
    const a = pack?.analyst || [];
    if (!a.length) return "";
    return "SELL-SIDE CONSENSUS (FMP)\n" + a.map((r) => `${r.symbol}: ${r.consensus || "n/a"} (${r.buy} buy / ${r.hold} hold / ${r.sell} sell)${isNum(v(r.target)) ? `, target $${num(r.target, 0)} vs price $${num(r.price, 2)} (${spct(r.upside)})` : ""}`).join("\n");
  }
  function txBlock(tx, maxEach = 7000) {
    const t = tx?.items || [];
    if (!t.length) return "EARNINGS-CALL TRANSCRIPTS: none retrieved.";
    return "EARNINGS-CALL EXCERPTS (most specific passages from each company's latest call; cite by T-ID)\n" + t.map((x) => `[${x.id}] ${x.symbol} ${x.name || ""} — ${x.period} call, ${x.date}\n${String(x.excerpt || "").slice(0, maxEach)}`).join("\n\n");
  }
  function macroBlock(macro) {
    const rows = macro?.rows || [];
    if (!rows.length) return "MACRO TABLE: unavailable.";
    const chg = (r) => [isNum(v(r.prior)) ? `${r.prior_label || "prior"} ${fmtVal({ ...r, value: r.prior })}` : "", isNum(v(r.estimate)) ? `consensus ${fmtVal({ ...r, value: r.estimate })}` : "",
      isNum(v(r.chg_1m)) ? `1M ${r.chg_1m >= 0 ? "+" : ""}${num(r.chg_1m)}%` : "", isNum(v(r.chg_1y)) ? `1Y ${r.chg_1y >= 0 ? "+" : ""}${num(r.chg_1y)}%` : ""].filter(Boolean).join(", ");
    return "MACRO TABLE (cite by I-ID)\n" + rows.map((r) => `[${r.id}] ${r.group} · ${r.label}: ${fmtVal(r)} (${r.period ? r.period + ", " : ""}${r.date})${chg(r) ? " — " + chg(r) : ""}`).join("\n");
  }
  function calendarBlock(pack) {
    const c = pack?.calendar || [];
    return c.length ? "UPCOMING US DATA RELEASES\n" + c.slice(0, 20).map((x) => `${x.date} ${x.event} [${x.impact}] est ${x.estimate ?? "n/a"} prev ${x.previous ?? "n/a"}`).join("\n") : "";
  }
  function evidence(pack, { kinds, max = 120, sum = 220, filter } = {}) {
    const pri = { M: 0, P: 1, N: 2, E: 3, W: 4 };
    let items = (pack?.items || []).filter((i) => (!kinds || kinds.includes(i.kind)) && (!filter || filter(i)));
    items = items.sort((a, b) => (pri[a.kind] - pri[b.kind]) || (a.date < b.date ? 1 : -1)).slice(0, max);
    return items.map((i) => `[${i.id}] ${i.date} · ${i.source || ""}${i.symbol ? " · " + i.symbol : ""}${i.topic ? " · topic " + i.topic : ""}${isNum(v(i.polarity)) ? ` · sentiment ${num(i.polarity, 2)}` : ""}${i.legal ? " · legal" : ""}${i.regulatory ? " · regulatory" : ""} — ${i.title}${i.summary ? ". " + trim(i.summary, sum) : ""}`).join("\n");
  }
  /** Revenue-weighted geographic mix across companies that report it (USD TTM revenue as weights). */
  function geoMix(doc, pack) {
    const B = [["United States & Americas", /united states|^us$|^u\.s|usa|america|north america|canada|mexico|brazil/i], ["Taiwan", /taiwan/i], ["China & Hong Kong", /china|hong kong|prc/i],
      ["Europe, Middle East & Africa", /europe|emea|germany|france|united kingdom|^uk$|netherlands|ireland|switzerland|italy|spain|middle east|africa|israel/i], ["Japan", /japan/i], ["South Korea", /korea/i],
      ["Other Asia-Pacific", /asia|pacific|singapore|india|malaysia|vietnam|thailand|philippines|australia|apac/i]];
    const rev = Object.fromEntries((doc?.constituents || []).map((c) => [c.symbol, v(c.rev_ttm)]));
    const tot = {}; let w = 0; const used = [];
    for (const s of pack?.segments || []) {
      if (!s.geo || !(rev[s.symbol] > 0)) continue;
      used.push(s.symbol); w += rev[s.symbol];
      for (const it of s.geo.items) { const b = (B.find(([, re]) => re.test(it.name)) || ["Other / unallocated"])[0]; tot[b] = (tot[b] || 0) + it.share * rev[s.symbol]; }
    }
    if (!w) return null;
    return { companies: used, rows: Object.entries(tot).map(([region, x]) => ({ region, share: x / w })).sort((a, b) => b.share - a.share) };
  }
  /** The world wire (G items) and the topics discovered in it. */
  function wireBlock(wire, { max = 150, sum = 160 } = {}) {
    if (!wire?.items?.length) return "WORLD NEWS WIRE: unavailable.";
    const top = (wire.topics || []).slice(0, 25).map((t) => `${t.tag.toLowerCase()} (${t.count} articles, latest ${t.last})`).join("; ");
    return `TOPICS RECURRING IN THIS WEEK'S WORLD NEWS (discovered from the wire, not a fixed list): ${top || "n/a"}

WORLD NEWS WIRE (CNBC feeds and other outlets, last ${wire.days || 10} days, newest first; cite by G-ID)
` + wire.items.slice(0, max).map((i) => `[${i.id}] ${i.date} · ${i.source}${i.tags?.length ? " · " + i.tags.slice(0, 5).join(", ").toLowerCase() : ""} — ${i.title}${sum && i.summary ? ". " + trim(i.summary, sum) : ""}`).join("\n");
  }
  const RULES = `RULES
- Use ONLY the data above plus general industry knowledge for mechanisms. Every current figure, event or quote must cite IDs in an "evidence" array (or inline as [N12], [T3], [I5]). Never invent IDs, figures, dates or events.
- If you state a number that is your own inference rather than from the data, label it "(estimate)". Prefer ranges for estimates.
- Name companies by ticker, and only tickers from the company table.
- Be specific: numbers, dates, segment names, company names. No filler, no generic statements that would be true of any industry.
- Reply with ONLY the JSON object described, no prose before or after.`;

  // ------------------------------------------------------------------ prompts
  function kpiPrompt(doc, pack, tx, macro, ctx) {
    const gm = geoMix(doc, pack);
    return `You are the industry KPI analyst on a buy-side research team. Write the operating deep-dive for this industry: the industry-specific metrics an expert would track (not generic financial ratios), where the cycle is, and what moves it next.

${header(doc, ctx)}

${metricsBlock(doc)}

${companiesBlock(doc)}

${segmentsBlock(pack)}
${gm ? `\nREVENUE-WEIGHTED GEOGRAPHIC MIX (${gm.companies.length} companies reporting): ${gm.rows.map((r) => `${r.region} ${(r.share * 100).toFixed(0)}%`).join(", ")}` : ""}

${analystBlock(pack)}

${txBlock(tx)}

COMPANY NEWS AND PRESS RELEASES
${evidence(pack, { kinds: ["P", "N", "E"], max: 110, sum: 200 })}

TASK
Identify the operating KPIs that matter for THIS industry (e.g. for semiconductors: memory pricing, foundry utilization, data-center revenue growth, inventory days, lead times; for banks: net interest margin, loan growth, deposit costs, credit losses; for airlines: capacity, yields, load factor, fuel cost). Pull their current values from the transcripts, segments, news and computed metrics. Where several companies report the same KPI, give the range or a weighted read and name who is high/low. Segment growth figures from the segment table count as evidence: cite them as "segments" in the text and leave evidence empty only if nothing else supports it.

${RULES}

JSON shape:
{"summary": "5-7 sentences with specific figures: what is driving demand, where profitability stands, who is winning, the main risk",
 "cycle_position": "trough | early recovery | expansion | late cycle | downturn",
 "cycle_text": "2 sentences on why, with figures",
 "demand_metrics": [{"name": "KPI name", "value": "e.g. +100% y/y or 196 days", "period": "e.g. Q2 2026", "change": "change vs prior period/year", "vs_cycle": "where this sits vs a normal cycle", "explanation": "2-3 sentences: what drives it, who benefits or is hurt (tickers), what a turn would signal", "evidence": ["T1"]}],
 "profitability_metrics": [same shape],
 "unit_economics": {"operating_leverage": "high | medium | low", "incremental_margin": "e.g. 70-85% fall-through [T3]", "text": "3-4 sentences on cost structure, fixed vs variable costs, what each extra dollar of revenue does to profit"},
 "pricing_power": {"level": "strong | moderate | weak", "who_has_it": "which sub-segments/tickers", "text": "3-4 sentences with evidence of price increases/cuts", "evidence": []},
 "demand_drivers": [{"name": "...", "direction": "accelerating | steady | decelerating", "text": "2-3 sentences with figures", "evidence": []}],
 "supply_drivers": [{"name": "...", "status": "tight | balanced | loose", "text": "2-3 sentences", "evidence": []}],
 "hot_segments": [{"name": "sub-segment", "names": ["TICKER"], "text": "why hot, with figures", "evidence": []}],
 "cool_segments": [same shape],
 "segment_map": [{"segment": "sub-segment of the industry", "names": ["TICKER"], "note": "one line on economics/exposure"}],
 "management_signals": [{"symbol": "TICKER", "signal": "what management said, specific (guidance, pricing, backlog, lead times), paraphrased with numbers", "tone": "positive | neutral | negative", "evidence": ["T2"]}],
 "next_triggers": [{"date": "YYYY-MM-DD or YYYY-MM", "event": "specific event", "why": "what a good/bad outcome would signal", "names": ["TICKER"]}]}
Sizes: 4-8 demand metrics, 4-8 profitability metrics, 3-6 demand drivers, 3-5 supply drivers, 2-4 hot and 2-4 cool segments, 4-8 segment_map rows covering the companies, 5-10 management signals, 4-8 next triggers (use the next-report dates in the company table and dated events in the evidence).`;
  }

  /** Macro planner: picks the series that matter for this industry from what the connectors offer today. */
  function macroPlanPrompt(doc, pack, ctx) {
    const gm = geoMix(doc, pack);
    return `You are the macro planner on a buy-side research team. From the catalog below (everything the data connectors offer today), choose the 30-50 macro series an expert would track for THIS industry: its demand drivers, its cost and input drivers, its financing and valuation drivers, and the countries and currencies it depends on. Don't pick series that don't matter for this industry just because they are popular.

${header(doc, ctx)}
${gm ? `REVENUE-WEIGHTED GEOGRAPHIC MIX: ${gm.rows.map((r) => `${r.region} ${(r.share * 100).toFixed(0)}%`).join(", ")}` : ""}
${ctx.exposureText || ""}

${segmentsBlock(pack)}

CATALOG
${ctx.catalogText}

Reply with ONLY JSON:
{"series": [{"key": "exact key from the catalog (or spread:<tenorA>-<tenorB>)", "group": "your group name, e.g. 'Demand: data-center capex', 'Input costs', 'Financing & valuation', 'Taiwan & Korea supply base'", "label": "short display label", "reason": "one line: why this series matters for this industry",
  "phrases": ["2-4 phrases a news headline or lede about THIS series' latest move would contain, e.g. 'empire state', 'new york fed', 'treasury yields', '10-year yield', 'brent crude', 'yen', 'consumer prices', 'cpi'"],
  "tags": ["1-3 broad news topic tags used to search for coverage, lowercase, hyphenated, e.g. 'inflation', 'interest-rates', 'oil', 'fed', 'bonds', 'manufacturing', 'currencies', 'china'"]}]}
Use 4-8 groups named for what they mean to this industry. 30-50 series. Keys must match the catalog exactly. Phrases must be specific to the series (never a lone generic word like 'manufacturing' or 'rates').`;
  }
  function cleanPlan(raw, cat) {
    const keys = new Set((cat?.items || []).map((i) => i.key));
    const tenors = new Set((cat?.items || []).filter((i) => i.kind === "treasury").map((i) => i.key.slice(9)));
    const out = []; const seen = new Set();
    for (const x of Array.isArray(raw?.series) ? raw.series : []) {
      const key = String(x?.key || "").trim();
      const ok = keys.has(key) || (/^spread:[a-z0-9]+-[a-z0-9]+$/.test(key) && key.slice(7).split("-").every((t) => tenors.has(t)));
      if (!ok || seen.has(key)) continue; seen.add(key);
      const strs = (a, n, m) => (Array.isArray(a) ? a : []).map((y) => trim(String(y ?? ""), m)).filter((y) => y.length >= 2).slice(0, n);
      out.push({ key, group: trim(x.group, 60) || "Other", label: trim(x.label, 80), reason: trim(x.reason, 200), phrases: strs(x.phrases, 5, 40), tags: strs(x.tags, 3, 30) });
      if (out.length >= 55) break;
    }
    return { series: out };
  }

  // Words that never identify an indicator on their own (English function words and generic data words).
  const PLAIN = new Set("new the and for with from that this rate rates index price prices total change year years month months monthly yearly annual change data level levels final flash prelim preliminary actual consensus previous prior united states us u.s. yoy mom qoq sa nsa per percent of in on to a an vs pmi".split(" "));
  /** Distinctive words of a label, for checking that an article is about this indicator. */
  const labelTerms = (label) => [...new Set(String(label || "").toLowerCase().replace(/[^a-z0-9&/ -]/g, " ").split(/[\s/-]+/).filter((w) => w.length >= 3 && !PLAIN.has(w) && !/^\d+$/.test(w)))];
  /** Does a retrieved item talk about one of these terms (title, text or tags)? */
  const mentions = (it, terms) => { if (!it) return false; const t = `${it.title || ""} ${it.summary || ""} ${(it.tags || []).join(" ")}`.toLowerCase(); return terms.some((w) => w.length >= 3 && new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(t)); };

  /**
   * Is this article about this indicator? It must contain a two-word phrase from the
   * indicator's name or the analyst's keyword phrases ("empire state", "crude oil",
   * "treasury yield"), where neither word is a generic word ("new york" and "10 year"
   * don't count). A one-word indicator ("Copper") must be named in the headline.
   * So a press release that merely mentions "manufacturing" in New York is not
   * coverage of the Empire State survey.
   */
  const toks = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9&]+/g, " ").trim().split(" ").filter(Boolean);
  function phrasesOf(label, keywords) {
    const out = new Set();
    for (const part of [...String(label || "").split(/[|(),/;:]/), ...(keywords || [])]) {
      const w = toks(part);
      for (let i = 0; i + 1 < w.length; i++) if (!PLAIN.has(w[i]) && !PLAIN.has(w[i + 1]) && !/^\d+$/.test(w[i]) && !/^\d+$/.test(w[i + 1]) && w[i].length >= 2 && w[i + 1].length >= 2) out.add(w[i] + " " + w[i + 1]);
    }
    return [...out];
  }
  function relevantTo(it, label, keywords = []) {
    if (!it) return false;
    const text = ` ${toks(`${it.title || ""} ${it.summary || ""} ${(it.tags || []).join(" ")}`).join(" ")} `;
    const ph = phrasesOf(label, keywords);
    const plural = (p) => { const [a, b] = p.split(" "); return new RegExp(` ${a} ${b}(?:s|es)? `); };
    if (ph.some((p) => plural(p).test(text))) return true;
    // A distinctive acronym in the name (CPI, ISM, SOFR, GDP) named in the headline also counts.
    const title = ` ${toks(it.title).join(" ")} `;
    const acr = (String(label || "").match(/\b[A-Z]{3,5}\b/g) || []).map((a) => a.toLowerCase()).filter((a) => !PLAIN.has(a));
    if (acr.some((a) => title.includes(` ${a} `))) return true;
    const terms = labelTerms(label);
    if (!ph.length && terms.length === 1) return new RegExp(`\\b${terms[0]}`).test(toks(it.title).join(" "));
    return false;
  }

  /** Indicator analysts: one batch of rows; every row gets relevance, driver, why it matters, with quoted sources. */
  function indicatorPrompt(doc, pack, rows, ctx) {
    const cands = ctx.candidates || {}, items = ctx.items || new Map(), links = ctx.links || {};
    const art = (id) => { const i = items.get ? items.get(id) : items[id]; if (!i) return ""; return `    [${i.id}] ${[i.date, i.source].filter(Boolean).join(" · ")} — ${i.title}\n      ${trim(i.text || i.summary || i.excerpt, 600)}`; };
    const block = (r) => {
      const c = (cands[r.id] || []).map((x) => art(x.id)).filter(Boolean);
      const l = (links[r.id] || []).map((x) => `    World team: "${x.title}" moves it — ${trim(x.why, 240)}${x.evidence?.length ? ` [${x.evidence.join(", ")}]` : ""}`);
      return `[${r.id}] ${r.group} · ${r.label}: ${fmtVal(r)}${r.period ? ` (${r.period})` : ""}, ${r.date}${isNum(v(r.prior)) ? `; ${r.prior_label || "prior"} ${fmtVal({ ...r, value: r.prior })}` : ""}${isNum(v(r.estimate)) ? `; consensus ${fmtVal({ ...r, value: r.estimate })}` : ""}${isNum(v(r.chg_1m)) ? `; 1M ${r.chg_1m >= 0 ? "+" : ""}${num(r.chg_1m)}%` : ""}${isNum(v(r.chg_3m)) ? `; 3M ${r.chg_3m >= 0 ? "+" : ""}${num(r.chg_3m)}%` : ""}${isNum(v(r.chg_1y)) ? `; 1Y ${r.chg_1y >= 0 ? "+" : ""}${num(r.chg_1y)}%` : ""}${r.reason ? `. Chosen because: ${r.reason}` : ""}
${l.join("\n")}${l.length ? "\n" : ""}  Candidate coverage (pre-matched to this series; read and judge it):
${c.join("\n") || "    (none matched; search for it)"}`;
    };
    return `You are a macro indicator analyst on a buy-side research team. For EACH indicator below, find and explain what is driving it right now, and how much it matters for this industry. Readers want the real cause ("the Empire State index jumped to 10.7 from -8.7 as new orders surged after the tariff truce [G12]"), not just the value.

${header(doc, ctx)}
${ctx.kpiDigest ? `\nINDUSTRY KPI ANALYST'S READ\n${ctx.kpiDigest}` : ""}
${ctx.worldDigest ? `\nLIVE WORLD SITUATIONS (from the world-events team, with their deep dives)\n${ctx.worldDigest}` : ""}
${ctx.tradeDigest ? `\nTRADE RELATIONS (from the trade team)\n${ctx.tradeDigest}` : ""}
${ctx.regDigest ? `\nREGULATION AND POLICY (from the regulation team)\n${ctx.regDigest}` : ""}

INDICATORS, EACH WITH CANDIDATE COVERAGE FROM THE WHOLE RUN (wire, world and trade coverage, market news, company news, earnings calls, plus searches on this series)
${rows.map(block).join("\n\n")}
${ctx.tools ? "\nIf the candidates don't explain a move, use search_coverage with the words a headline would use ('treasury yields', 'oil prices', 'yen', 'consumer prices', 'factory activity') and an optional topic tag, and read_article to read an article in full. Look for the cause: the release, the central-bank decision, the geopolitical event, the supply shock. The world situations above are often the cause (an Iran conflict lifting oil; oil lifting inflation and yields)." : ""}

${RULES}
- For every article you cite, give in "sources" one sentence QUOTED EXACTLY (word for word) from that article that shows the cause of the move. Code checks each quote against the article and removes citations whose quote isn't there.
- Cite only articles about this indicator, its release, or the event moving it. An article about something else that merely mentions the same word is not coverage.
- Use the other teams' findings: if a live world situation or a trade or policy development explains the move, say so and cite its evidence.
- If after searching you still find nothing, explain the move from the data (actual vs consensus vs prior, the trend, what usually drives it) and end with "No news coverage of this move was found."

JSON shape:
{"indicators": [{"id": "I#", "relevance": "high | medium | low", "relevance_why": "2 sentences: why this indicator does or doesn't matter for this industry specifically",
  "effect": "tailwind | headwind | neutral",
  "driver": "3-5 sentences: what changed (actual vs consensus vs prior or the 1M move, with numbers), what caused it (the specific release, policy, event or market move), and whether the trend is accelerating or fading; cite articles inline",
  "why_it_matters": "2-3 sentences: the mechanism into this industry's revenue, costs, financing or valuation, naming tickers where it differs by company",
  "next": "one sentence: the next release, meeting or level to watch",
  "keywords": ["2-4 phrases an article about this indicator contains"],
  "sources": [{"id": "X12", "quote": "exact sentence from the article"}]}]}
Cover EVERY indicator listed, in the same order.`;
  }
  /**
   * Keep only verified citations. verify(id, quote, row) decides (Coverage.verifyCitation in the page);
   * without it, an article must be about the indicator (relevantTo).
   */
  function cleanIndicators(raw, idx, doc, rows, verify = null) {
    const { S, Ev, En } = makeCritic(idx, tickersOf(doc));
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    const out = {}; let dropped = 0;
    for (const it of Array.isArray(raw?.indicators) ? raw.indicators : []) {
      const id = String(it?.id || "").toUpperCase(); const r = byId[id]; if (!r || out[id]) continue;
      const kws = [...new Set((Array.isArray(it.keywords) ? it.keywords : []).map((k) => String(k).toLowerCase().trim()).filter((k) => k.length >= 3 && !PLAIN.has(k)))].slice(0, 4);
      const quotes = {}; for (const q of Array.isArray(it.sources) ? it.sources : []) { const qid = String(q?.id || "").toUpperCase(); if (qid && !quotes[qid]) quotes[qid] = String(q?.quote || ""); }
      const row = { ...r, keywords: kws };
      const memo = {};
      const okId = (x) => (x in memo ? memo[x] : (memo[x] = /^[IT]\d+$/.test(x) ? true : verify ? verify(x, quotes[x] || "", row) : relevantTo(idx[x], `${r.label} | ${r.event || ""}`, kws)));
      let driver = S(it.driver, 1600);
      driver = driver.replace(/\[([A-Z]{1,2}\d{1,4}(?:,\s*[A-Z]{1,2}\d{1,4})*)\]/g, (m, g) => { const keep = g.split(/,\s*/).filter((x) => { const ok = okId(x); if (!ok) dropped++; return ok; }); return keep.length ? `[${keep.join(", ")}]` : ""; }).replace(/\s+([.,;])/g, "$1").replace(/\s{2,}/g, " ").trim();
      const ev = [...Ev(it.evidence, 6), ...Ev(Object.keys(quotes), 6)].filter((x, i, a) => a.indexOf(x) === i).filter((x) => { const ok = okId(x); if (!ok && !driver.includes(x)) dropped++; return ok; });
      const inline = [...driver.matchAll(/\[([^\]]+)\]/g)].flatMap((m) => m[1].split(/,\s*/));
      const evidence = [...new Set([...inline.filter((x) => idx[x] && !/^I\d+$/.test(x)), ...ev.filter((x) => !/^I\d+$/.test(x))])].slice(0, 6);
      out[id] = { relevance: En(it.relevance, ["high", "medium", "low"], "low"), relevance_why: S(it.relevance_why, 500), effect: En(it.effect, ["tailwind", "headwind", "neutral"], "neutral"),
        driver, why_it_matters: S(it.why_it_matters, 700), next: S(it.next, 240), keywords: kws, evidence,
        quotes: Object.fromEntries(evidence.filter((x) => quotes[x]).map((x) => [x, trim(quotes[x], 300)])) };
      out[id].covered = evidence.length > 0;
    }
    return { indicators: out, dropped };
  }

  function macroPrompt(doc, pack, tx, macro, ctx) {
    const gm = geoMix(doc, pack);
    const ind = ctx.indicatorReads || {};
    return `You are the macro strategist on a buy-side research team. Your indicator analysts have explained every series below (what is driving it and why it matters). Judge the macro operating environment for this specific industry (not a price forecast) and connect it to the real-world events behind it.

${header(doc, ctx)}

${metricsBlock(doc)}
${ctx.kpiDigest ? `\nINDUSTRY KPI ANALYST'S READ\n${ctx.kpiDigest}` : ""}
${gm ? `\nREVENUE-WEIGHTED GEOGRAPHIC MIX: ${gm.rows.map((r) => `${r.region} ${(r.share * 100).toFixed(0)}%`).join(", ")}` : ""}

MACRO TABLE WITH THE ANALYSTS' READS (cite indicators by I-ID, news by its ID)
${(macro?.rows || []).map((r) => { const x = ind[r.id]; return `[${r.id}] ${r.group} · ${r.label}: ${fmtVal(r)}${isNum(v(r.prior)) ? ` (${r.prior_label || "prior"} ${fmtVal({ ...r, value: r.prior })})` : ""}${isNum(v(r.chg_1m)) ? ` 1M ${num(r.chg_1m)}%` : ""}${x ? ` — ${x.relevance} relevance, ${x.effect}. Driver: ${x.driver}` : ""}`; }).join("\n")}

BIGGEST MOVES (computed)
${(ctx.moves || []).map((m) => `[${m.id}] ${m.label}: ${m.move}`).join("\n") || "(no large moves)"}

${ctx.worldDigest ? `LIVE WORLD SITUATIONS (from the world-events team)\n${ctx.worldDigest}\n` : ""}
${calendarBlock(pack)}

TASK
1. For every one of the biggest moves, say what moved, the real-world event(s) or release behind it (use the analysts' drivers and their citations), which live situation it belongs to, and what it means for this industry. If the analysts found no coverage, say so plainly and cite nothing.
2. Make a regime call: SUPPORTIVE, MIXED, RESTRICTIVE or HOSTILE, overall and per horizon. The headline, summary, horizons and channels must name the real-world events driving the indicators, not just the values.
3. Write "state_of_world": how the live situations and the macro backdrop form one connected system for this industry right now, with citations.

${RULES}

JSON shape:
{"regime": "SUPPORTIVE | MIXED | RESTRICTIVE | HOSTILE", "confidence": "low | medium | high",
 "headline": "one line naming the 2-3 indicators that decide the call and the events driving them, with values",
 "state_of_world": "4-6 sentences connecting the live situations and the macro backdrop into one system for this industry, cited",
 "moves": [{"id": "I#", "move": "what changed, with numbers", "driver": "the real-world event(s) or release behind it, cited", "situation": "title of the related live situation, or ''", "so_what": "what it means for this industry, one sentence", "evidence": []}],
 "summary": "5-7 sentences: demand backdrop, cost backdrop, financing/valuation backdrop, net read",
 "horizons": {"1M": {"call": "MIXED", "drivers": ["I3"], "text": "2-3 sentences"}, "3M": {...}, "6M": {...}, "12M": {...}},
 "channels": {"demand": {"text": "3-4 sentences on what sets volumes and pricing", "drivers": ["I#"]}, "cost": {...}, "capital": {"text": "financing costs, credit, discount rate, multiples", "drivers": []}, "regulatory": {"text": "policy, trade and fiscal backdrop", "drivers": []}},
 "flip": [{"trigger": "specific, measurable", "mechanism": "how it changes the call", "watch": "which release or date"}],
 "supports": [{"text": "...", "evidence": []}], "risks": [{"text": "...", "evidence": []}],
 "watch_next": [{"date": "YYYY-MM-DD", "event": "release or meeting", "why": "what would matter for this industry"}]}
Sizes: one "moves" entry per biggest move; 2-4 flip triggers; 3-5 supports; 3-5 risks; 4-8 watch_next.`;
  }

  function scoutPrompt(doc, pack, tx, macro, ctx) {
    const gm = geoMix(doc, pack);
    return `You are the world-events scout on a buy-side research team. Read this week's world news wire and find the live real-world situations that matter most for this industry right now. Nothing is pre-selected: discover the situations from what is actually being reported (conflicts, geopolitics, trade and tariffs, sanctions and export controls, energy and commodity shocks, central banks, elections, major policy, technology shifts, disasters, strikes, anything else that moves this industry).

${header(doc, ctx)}
${gm ? `REVENUE-WEIGHTED GEOGRAPHIC MIX: ${gm.rows.map((r) => `${r.region} ${(r.share * 100).toFixed(0)}%`).join(", ")}` : ""}

${segmentsBlock(pack)}

${wireBlock(ctx.wire)}

OTHER MARKET NEWS
${evidence(pack, { kinds: ["W"], max: 50, sum: 0 })}

RECENT COMPANY HEADLINES
${evidence(pack, { kinds: ["N", "P", "E"], max: 40, sum: 100 })}
${ctx.tools ? "\nYou can call read_article to read a wire item in full and search_news_by_topic to pull more coverage on a topic before deciding. Cite what they return by ID." : ""}

${RULES}
- Group related headlines into one situation (e.g. several stories about the same conflict, trade negotiation or supply shock). A situation must be supported by at least 2 evidence IDs and must have a plausible channel into this industry's revenue, costs, demand or regulation. Rank by expected impact on this industry, not by headline volume. Skip market chatter and single-company stories unless they reflect a wider situation.
- "search_terms": 2-4 short topic tags or keywords that would find more coverage of this situation (names of countries, organizations, commodities, places, policies as they appear in the wire's tags).

JSON shape:
{"situations": [{"title": "short name of the situation", "category": "geopolitics | conflict | trade | energy | monetary | policy | technology | disaster | labor | other", "region": "e.g. Global energy, Middle East, US-China, Europe", "status": "escalating | active conflict | ongoing tension | negotiating | de-escalating | resolved", "actors": ["2-5 countries, organizations or groups"], "stance": "adverse | supportive | mixed", "relevance": "high | medium", "since": "YYYY-MM-DD when it began or re-ignited, if known", "latest_date": "YYYY-MM-DD", "why": "2 sentences: the channel into this industry", "search_terms": ["..."], "evidence": ["G3", "G9"]}],
 "also_watching": [{"title": "...", "why": "one sentence", "evidence": []}]}
Sizes: 3-8 situations (as many as genuinely matter; fewer when the news is quiet), up to 5 also_watching.`;
  }

  function divePrompt(doc, pack, tx, macro, ctx, sit) {
    const ids = new Set(sit.evidence || []);
    const words = String(sit.title || "").toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    const related = (i) => ids.has(i.id) || words.some((w) => `${i.title} ${i.summary || ""}`.toLowerCase().includes(w));
    const cov = sit.coverage || [];
    const covIds = new Set(cov.map((i) => i.id));
    const gm = geoMix(doc, pack);
    return `You are a situation analyst on a buy-side research team. Write a deep dive on ONE world situation and how it transmits into this industry's earnings.

SITUATION: ${sit.title} (${sit.category}, ${sit.stance}; region ${sit.region || "n/a"}; status ${sit.status || "n/a"}; actors ${(sit.actors || []).join(", ") || "n/a"}). Scout's note: ${sit.why}

${header(doc, ctx)}

${companiesBlock(doc, 30)}

${segmentsBlock(pack)}
${gm ? `\nREVENUE-WEIGHTED GEOGRAPHIC MIX: ${gm.rows.map((r) => `${r.region} ${(r.share * 100).toFixed(0)}%`).join(", ")}` : ""}
${ctx.kpiDigest ? `\nINDUSTRY KPI ANALYST'S READ\n${ctx.kpiDigest}` : ""}

${macroBlock({ rows: (macro?.rows || []).filter((r) => /Commodities|FX|Rates|Markets|Global|Inflation/.test(r.group)) })}

COVERAGE OF THIS SITUATION (last 30 days, newest first, text where available; cite by ID)
${cov.map((i) => `[${i.id}] ${i.date} · ${i.source}${i.tags?.length ? " · " + i.tags.slice(0, 4).join(", ").toLowerCase() : ""} — ${i.title}. ${trim(i.summary, 900)}`).join("\n\n") || "(none found beyond the scout's sources)"}

COMPANY NEWS THAT MAY BE RELATED
${evidence(pack, { kinds: ["N", "E", "P"], max: 20, sum: 300, filter: related })}

OTHER RECENT WORLD HEADLINES (for context)
${(ctx.wire?.items || []).filter((i) => !covIds.has(i.id)).slice(0, 40).map((i) => `[${i.id}] ${i.date} · ${i.source} — ${i.title}`).join("\n")}

${RULES}
- Channels are concrete: name the revenue line, cost input or demand pool, give a direction, a magnitude (a range, marked "(estimate)" unless from evidence), timing and confidence, and the exposed tickers.
- Scenario probabilities must sum to 100.
- Don't repeat the same sentence or boilerplate across sections; every section must add something specific.

JSON shape:
{"title": "${trim(sit.title, 80)}", "stance": "adverse | supportive | mixed", "region": "...", "status": "escalating | active conflict | ongoing tension | negotiating | de-escalating | resolved", "actors": ["..."], "since": "YYYY-MM-DD",
 "summary": "3-4 sentences: net impact on this industry and who is most exposed",
 "now": "what is happening now, 3-5 sentences with dates and citations",
 "why_now": "why this is repricing now: the latest concrete step, dated and cited",
 "developments": [{"date": "YYYY-MM-DD", "text": "one dated development", "evidence": ["W4"]}],
 "indicators": [{"id": "I# when a macro-table row fits, else omit", "name": "what it moves when no row fits (e.g. 'Oil and energy risk premium', 'Freight and war-risk insurance')", "basis": "market data | article-grounded | qualitative", "why": "how this situation moves it and why it matters here", "evidence": []}],
 "trigger": "the current trigger, one sentence with citation",
 "first_order": "the first-order shock, 1-2 sentences",
 "chain": [{"step": "short title", "timing": "immediate | 0-3 months | 3-12 months | 12+ months", "text": "2-3 sentences", "evidence": []}],
 "channels": {"revenue": [{"name": "...", "direction": "up | down | mixed", "magnitude": "...", "timing": "...", "confidence": "low | medium | high", "text": "2-3 sentences", "exposed": ["TICKER"], "evidence": []}], "cost": [...], "demand": [...], "regulation": [...]},
 "fs_impact": [{"lever": "Revenue | Gross margin | Opex | Working capital | Capex | Cash flow | Valuation", "direction": "up | down | mixed", "magnitude": "...", "timing": "...", "why": "1-2 sentences"}],
 "exposure": [{"segment": "sub-segment", "level": "high | medium | low", "why": "1-2 sentences", "names": ["TICKER"]}],
 "scenarios": [{"name": "Base case", "probability": 60, "trigger": "...", "outcome": "what happens operationally", "earnings": "earnings and multiple impact, quantified as ranges"}, {"name": "Escalation", ...}, {"name": "De-escalation", ...}],
 "near_term": "2-3 sentences on the next 1-2 quarters of earnings",
 "structural": "2-3 sentences on lasting changes",
 "winners": [{"symbol": "TICKER", "why": "one sentence"}], "losers": [{"symbol": "TICKER", "why": "one sentence"}],
 "offsets": ["what cushions the impact"],
 "watch": [{"indicator": "what to watch", "signal": "the level or event that would matter", "why": "one sentence"}]}
Sizes: 3-6 developments, 2-5 indicators, 3-6 chain steps, 1-3 channels in each group (empty array if none), 4-6 fs_impact rows, 3-5 exposure rows, exactly 3 scenarios, 2-5 winners and losers, 2-4 offsets, 3-6 watch items.`;
  }

  function regPrompt(doc, pack, tx, macro, ctx) {
    const sen = pack?.sentiment;
    return `You are the regulation, legal and deals analyst on a buy-side research team. Map the regulators, live policy items, litigation and M&A for this industry, and how investors and the public currently see it.

${header(doc, ctx)}

${companiesBlock(doc, 25)}

${analystBlock(pack)}

${sen ? `EODHD MEASURED NEWS SENTIMENT (scale -1 to +1): last 7 days ${num(sen.last_7d, 3)}, prior 30 days ${num(sen.prior_30d, 3)}, 90 days ${num(sen.last_90d, 3)}, ${sen.articles_30d} articles in 30 days. By company (30d score, articles): ${(sen.by_company || []).slice(0, 12).map((c) => `${c.symbol} ${num(c.score_30d, 2)} (${c.articles_30d})`).join(", ")}` : "No measured sentiment data."}

SEC M&A FILINGS, PRESS RELEASES AND COMPANY NEWS
${evidence(pack, { kinds: ["M", "P", "N", "E"], max: 130, sum: 200 })}

WORLD AND POLICY NEWS
${evidence(pack, { kinds: ["W"], max: 60, sum: 140 })}

${txBlock(tx, 2500)}

${RULES}
- Regulators: background knowledge is fine for who they are and why they matter; what they are doing NOW needs a citation, otherwise say "nothing new in the retrieved coverage".
- Regulatory bodies that matter: the 4-8 government agencies, commissions, ministries or self-regulatory organizations that actually move earnings, pricing or volumes in this industry, ordered most-impactful first. Name the actual body with its acronym (e.g. "BIS — Bureau of Industry and Security", "CMS — Centers for Medicare & Medicaid Services", "FERC", "PBOC", "EMA"); never vague terms like "the government" or "regulators". Include the most relevant non-US bodies when the industry is globally exposed (e.g. EU CBAM for steel, China NDRC for EVs, BIS export controls for semiconductors). Include self-regulatory or standard-setting bodies (e.g. NERC, IATA) only when they truly move P&L.
- For each body, "why" is 2-3 sentences naming the specific rule, rate, tariff, license, mandate, formulary, capital ratio or approval process it controls and the mechanism by which that hits revenue, margin or capex. "levers" are 2-4 short noun phrases (e.g. "export licenses", "reimbursement rates"). No forecasts, opinions, partisan commentary or "watch this comment period" speculation: describe only finalized authority.

JSON shape:
{"summary": "4-6 sentences on the regulatory, legal and deal climate for this industry",
 "regulators": [{"name": "ACRONYM — full agency name", "jurisdiction": "US Federal | US State | EU | China | Japan | Global SRO | ...", "why": "2-3 sentences: the specific instrument it controls and how it hits revenue, margin or capex", "levers": ["2-4 noun-phrase chips"], "current": "what it is doing now, cited, or 'nothing new in the retrieved coverage'", "evidence": []}],
 "policy": [{"title": "rule, bill, tariff, export control...", "status": "proposed | pending | enacted | in force | under review", "date": "YYYY-MM-DD or YYYY-MM", "direction": "headwind | tailwind | mixed", "impact": "who and how much", "names": ["TICKER"], "evidence": []}],
 "litigation": [{"case": "short name", "parties": "...", "status": "...", "stakes": "what is at risk, quantified if possible", "next": "next step and date if known", "names": ["TICKER"], "evidence": []}],
 "deals": [{"title": "acquirer → target", "value": "deal value if known", "status": "announced | pending approval | closed | rumored", "rationale": "one sentence", "names": ["TICKER"], "evidence": []}],
 "consolidation": "2-3 sentences on deal appetite and the antitrust climate",
 "perception": {"summary": "3-4 sentences on how investors, customers and the public see the industry, using the sentiment numbers and analyst consensus", "trend": "improving | stable | deteriorating", "evidence": []},
 "regulatory_ids": ["IDs of the headlines above that are about regulation, policy, government action or regulators"], "legal_ids": ["IDs of the headlines above that are about lawsuits, courts, settlements or investigations"]}
Sizes: 4-8 regulators, 0-8 policy items, 0-8 litigation items, 0-8 deals. Empty arrays are fine when the evidence has nothing; never pad.`;
  }

  /** Short text digests of finished agents, fed to later agents and the lead. */
  function digest(key, r) {
    if (!r) return "";
    if (key === "kpi") return [`Cycle: ${r.cycle_position}. ${r.summary}`, ...r.demand_metrics.slice(0, 5).map((m) => `${m.name}: ${m.value} (${m.period}${m.change ? ", " + m.change : ""})`), ...r.profitability_metrics.slice(0, 4).map((m) => `${m.name}: ${m.value} (${m.period})`), `Segments: ${r.segment_map.map((s) => `${s.segment} = ${s.names.join("/")}`).join("; ")}`].join("\n");
    if (key === "macro") return `Macro regime ${r.regime} (${r.confidence}). ${r.headline}. ${r.summary}`;
    if (key === "reg") return `${r.summary} Perception: ${r.perception?.summary || ""}`;
    if (key === "world") return (r.dives || []).map((d) => `- ${d.title} (${d.status || d.stance}, ${d.region || "global"}; ${d.stance} for the industry): ${d.summary} Trigger: ${d.trigger || "n/a"} Moves: ${(d.indicators || []).map((i) => (i.id ? i.id : i.name)).join(", ") || "n/a"}. Sources: ${[...new Set([...(d.scout_evidence || []), ...(d.headlines || []).slice(0, 3)])].join(", ")}`).join("\n");
    return "";
  }

  // ------------------------------------------------------------------ critic
  function makeCritic(idx, tickers) {
    const tk = new Set([...tickers].map((t) => String(t).toUpperCase()));
    const alias = tickers.aliases || {};
    const S = (x, n = 600) => {
      if (x === null || x === undefined) return "";
      if (typeof x === "string" || typeof x === "number") return cleanInline(trim(x, n));
      if (Array.isArray(x)) return cleanInline(trim(x.filter((y) => typeof y === "string" || typeof y === "number").join("; "), n));
      if (typeof x === "object") return S(x.text ?? x.summary ?? x.value ?? "", n);
      return "";
    };
    const stats = { kept: 0, dropped: 0 };
    function cleanInline(t) {
      return t.replace(/\[([A-Z]{1,2}\d{1,4})(?:\s*,\s*([A-Z]{1,2}\d{1,4}))*\]/g, (m) => {
        const ids = m.slice(1, -1).split(/\s*,\s*/).map((s) => s.toUpperCase());
        const ok = ids.filter((i) => idx[i]);
        stats.kept += ok.length; stats.dropped += ids.length - ok.length;
        return ok.length ? `[${ok.join(", ")}]` : "";
      }).replace(/\s*\[(?:undefined|null|NaN|ID)\]/g, "").replace(/\s+([.,;])/g, "$1").trim();
    }
    const Ev = (x, n = 6) => {
      const out = []; const seen = new Set();
      for (const e of (Array.isArray(x) ? x : typeof x === "string" ? x.split(/[\s,]+/) : []).slice(0, n + 4)) {
        const id = String(typeof e === "object" && e ? e.id : e).replace(/[\[\]\s]/g, "").toUpperCase();
        if (idx[id] && !seen.has(id)) { seen.add(id); out.push(id); stats.kept++; } else if (id) stats.dropped++;
        if (out.length >= n) break;
      }
      return out;
    };
    const Tk = (x, n = 8) => [...new Set((Array.isArray(x) ? x : typeof x === "string" ? x.split(/[\s,/]+/) : []).map((t) => String(typeof t === "object" && t ? t.symbol || t.ticker || "" : t).replace(/[^A-Za-z0-9.\-]/g, "").toUpperCase()).map((t) => alias[t] || t).filter((t) => tk.has(t)))].slice(0, n);
    const En = (x, list, d) => { const s = String(x ?? "").toLowerCase().trim(); return list.find((l) => l.toLowerCase() === s) || list.find((l) => s.startsWith(l.toLowerCase().split(" ")[0])) || d; };
    const A = (x, n, fn) => (Array.isArray(x) ? x : []).slice(0, n).map((y) => (y && typeof y === "object" ? fn(y) : null)).filter(Boolean);
    const hasNum = (s) => /\d/.test(s);
    return { S, Ev, Tk, En, A, stats, hasNum };
  }
  /**
   * Tickers the agents may name: the industry's companies, their former tickers (mapped to the current one,
   * e.g. PSKY -> SKYD), and the parties to retrieved M&A filings (doc.related).
   */
  const tickersOf = (doc) => {
    const list = [...(doc?.constituents || []).map((c) => c.symbol), ...(doc?.related || [])];
    list.aliases = Object.fromEntries((doc?.constituents || []).filter((c) => c.formerly).map((c) => [String(c.formerly).toUpperCase(), c.symbol]));
    return list;
  };

  function cleanKpi(raw, idx, doc) {
    const { S, Ev, Tk, En, A, stats } = makeCritic(idx, tickersOf(doc));
    const metric = (m) => { const o = { name: S(m.name, 90), value: S(m.value, 80), period: S(m.period, 40), change: S(m.change, 120), vs_cycle: S(m.vs_cycle, 160), explanation: S(m.explanation, 700), evidence: Ev(m.evidence) };
      if (!o.name || !o.value) return null; o.estimate = !o.evidence.length && !/\[[A-Z]{1,2}\d/.test(o.explanation) && !/segment/i.test(o.explanation); return o; };
    const drv = (d) => (S(d.name, 90) ? { name: S(d.name, 90), direction: S(d.direction || d.status, 30), text: S(d.text, 600), evidence: Ev(d.evidence) } : null);
    const seg = (d) => (S(d.name, 90) ? { name: S(d.name, 90), names: Tk(d.names), text: S(d.text, 500), evidence: Ev(d.evidence) } : null);
    const r = {
      summary: S(raw?.summary, 1800), cycle_position: S(raw?.cycle_position, 40), cycle_text: S(raw?.cycle_text, 500),
      demand_metrics: A(raw?.demand_metrics, 8, metric), profitability_metrics: A(raw?.profitability_metrics, 8, metric),
      unit_economics: { operating_leverage: En(raw?.unit_economics?.operating_leverage, ["high", "medium", "low"], ""), incremental_margin: S(raw?.unit_economics?.incremental_margin, 200), text: S(raw?.unit_economics?.text, 900) },
      pricing_power: { level: En(raw?.pricing_power?.level, ["strong", "moderate", "weak"], ""), who_has_it: S(raw?.pricing_power?.who_has_it, 200), text: S(raw?.pricing_power?.text, 900), evidence: Ev(raw?.pricing_power?.evidence) },
      demand_drivers: A(raw?.demand_drivers, 6, drv), supply_drivers: A(raw?.supply_drivers, 5, drv),
      hot_segments: A(raw?.hot_segments, 4, seg), cool_segments: A(raw?.cool_segments, 4, seg),
      segment_map: A(raw?.segment_map, 10, (s) => (S(s.segment, 80) ? { segment: S(s.segment, 80), names: Tk(s.names, 12), note: S(s.note, 240) } : null)),
      management_signals: A(raw?.management_signals, 10, (m) => { const ev = Ev(m.evidence, 3); const sym = Tk([m.symbol])[0]; return S(m.signal, 10) && ev.length ? { symbol: sym || "", signal: S(m.signal, 500), tone: En(m.tone, ["positive", "neutral", "negative"], "neutral"), evidence: ev } : null; }),
      next_triggers: A(raw?.next_triggers, 8, (t) => (S(t.event, 10) ? { date: S(t.date, 20), event: S(t.event, 160), why: S(t.why, 400), names: Tk(t.names) } : null)).sort((a, b) => (a.date < b.date ? -1 : 1)),
    };
    r.stats = { ...stats };
    return r;
  }

  function cleanMacro(raw, idx, doc, macro, reads = null, cands = null) {
    const { S, Ev, En, A, stats } = makeCritic(idx, tickersOf(doc));
    const reg = (x) => En(x, REGIMES, "MIXED");
    const ids = new Set((macro?.rows || []).map((r) => r.id));
    const whys = new Set();
    const ind = {};
    for (const it of Array.isArray(raw?.indicators) ? raw.indicators : []) {
      const id = String(it?.id || "").toUpperCase(); if (!ids.has(id) || ind[id]) continue;
      let why = S(it.why, 260); const key = why.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 80);
      if (BOILER.test(why) || whys.has(key)) why = ""; else whys.add(key);
      ind[id] = { relevance: En(it.relevance, ["high", "medium", "low"], "low"), effect: En(it.effect, ["tailwind", "headwind", "neutral"], "neutral"), why, driver: S(it.driver, 300) };
    }
    const ch = (c) => ({ text: S(c?.text ?? c, 900), drivers: Ev(c?.drivers, 6) });
    const r = {
      regime: reg(raw?.regime), confidence: En(raw?.confidence, ["low", "medium", "high"], "low"), headline: S(raw?.headline, 300), summary: S(raw?.summary, 1800),
      state_of_world: S(raw?.state_of_world, 1600),
      moves: A(raw?.moves, 10, (m) => { const id = String(m.id || "").toUpperCase(); if (!ids.has(id) || !S(m.driver, 3)) return null;
        const row = (macro?.rows || []).find((r) => r.id === id);
        const allowed = new Set([...(reads?.[id]?.evidence || []), ...((cands?.[id]) || []).map((c) => c.id || c)]);
        const ok = (x) => /^[IT]\d+$/.test(x) || (reads ? allowed.has(x) : relevantTo(idx[x], `${row?.label || ""} | ${row?.event || ""}`, []));
        const driver = S(m.driver, 600).replace(/\[([A-Z]{1,2}\d{1,4}(?:,\s*[A-Z]{1,2}\d{1,4})*)\]/g, (mm, g) => { const k = g.split(/,\s*/).filter(ok); return k.length ? `[${k.join(", ")}]` : ""; }).replace(/\s+([.,;])/g, "$1").replace(/\s{2,}/g, " ").trim();
        return { id, move: S(m.move, 200), driver, situation: S(m.situation, 120), so_what: S(m.so_what, 300), evidence: Ev(m.evidence, 4).filter(ok) }; }),
      horizons: Object.fromEntries(HORIZONS.map((h) => { const x = raw?.horizons?.[h] || raw?.horizons?.[h.toLowerCase()] || {}; return [h, { call: reg(x.call), drivers: Ev(x.drivers, 5), text: S(x.text, 600) }]; })),
      channels: Object.fromEntries(["demand", "cost", "capital", "regulatory"].map((k) => [k, ch(raw?.channels?.[k])])),
      flip: A(raw?.flip, 4, (f) => (S(f.trigger, 10) ? { trigger: S(f.trigger, 240), mechanism: S(f.mechanism, 400), watch: S(f.watch, 200) } : null)),
      supports: A(raw?.supports, 5, (x) => (S(x.text, 10) ? { text: S(x.text, 400), evidence: Ev(x.evidence) } : null)),
      risks: A(raw?.risks, 5, (x) => (S(x.text, 10) ? { text: S(x.text, 400), evidence: Ev(x.evidence) } : null)),
      watch_next: A(raw?.watch_next, 8, (w) => (S(w.event, 5) ? { date: S(w.date, 20), event: S(w.event, 160), why: S(w.why, 300) } : null)).sort((a, b) => (a.date < b.date ? -1 : 1)),
      indicators: reads ? Object.fromEntries(Object.entries(reads).map(([k, x]) => [k, { ...x, why: x.why_it_matters }])) : ind,
    };
    r.coverage = Object.values(r.indicators).filter((x) => x.why || x.driver).length;
    r.stats = { ...stats };
    return r;
  }

  const STATUS_W = ["escalating", "active conflict", "ongoing tension", "negotiating", "de-escalating", "resolved"];
  function cleanScout(raw, idx, doc) {
    const { S, Ev, En, A } = makeCritic(idx, tickersOf(doc));
    const strs = (x, n, m) => (Array.isArray(x) ? x : []).map((y) => S(y, m)).filter(Boolean).slice(0, n);
    const situations = A(raw?.situations, 8, (s) => {
      const ev = Ev(s.evidence, 10);
      return S(s.title, 5) && ev.length >= 1 ? { title: S(s.title, 120), category: S(s.category, 30), region: S(s.region, 60), status: En(s.status, STATUS_W, "ongoing tension"), actors: strs(s.actors, 6, 50),
        stance: En(s.stance, ["adverse", "supportive", "mixed"], "mixed"), relevance: En(s.relevance, ["high", "medium"], "medium"), since: S(s.since, 10), latest_date: S(s.latest_date, 20), why: S(s.why, 500),
        search_terms: strs(s.search_terms, 4, 40), evidence: ev } : null;
    });
    return { situations, also_watching: A(raw?.also_watching, 5, (s) => (S(s.title, 5) ? { title: S(s.title, 120), why: S(s.why, 300), evidence: Ev(s.evidence, 4) } : null)) };
  }

  function cleanDive(raw, idx, doc, sit) {
    const { S, Ev, Tk, En, A, stats } = makeCritic(idx, tickersOf(doc));
    const DIR = ["up", "down", "mixed"];
    const chan = (c) => { if (!S(c.name, 3)) return null; const o = { name: S(c.name, 120), direction: En(c.direction, DIR, "mixed"), magnitude: S(c.magnitude, 160), timing: S(c.timing, 40), confidence: En(c.confidence, ["low", "medium", "high"], "low"), text: S(c.text, 600), exposed: Tk(c.exposed), evidence: Ev(c.evidence) };
      o.estimate = !o.evidence.length; return o; };
    const iids = new Set(Object.keys(idx).filter((k) => k.startsWith("I")));
    let sc = A(raw?.scenarios, 3, (s) => (S(s.name, 2) ? { name: S(s.name, 40), probability: Math.max(0, Math.min(100, Math.round(Number(s.probability) || 0))), trigger: S(s.trigger, 400), outcome: S(s.outcome, 500), earnings: S(s.earnings, 400) } : null));
    const tot = sc.reduce((a, s) => a + s.probability, 0);
    if (tot > 0 && tot !== 100) { sc = sc.map((s) => ({ ...s, probability: Math.round((s.probability / tot) * 100) })); const d = 100 - sc.reduce((a, s) => a + s.probability, 0); if (sc[0]) sc[0].probability += d; }
    const r = {
      title: S(raw?.title, 120) || sit.title, stance: En(raw?.stance, ["adverse", "supportive", "mixed"], sit.stance), category: sit.category, scout_evidence: sit.evidence,
      region: S(raw?.region, 60) || sit.region || "", status: En(raw?.status, STATUS_W, sit.status || "ongoing tension"),
      actors: [...new Set([...(Array.isArray(raw?.actors) ? raw.actors : []), ...(sit.actors || [])].map((x) => S(x, 50)).filter(Boolean))].slice(0, 6),
      headlines: (sit.coverage || []).slice(0, 10).map((i) => i.id),
      summary: S(raw?.summary, 900), now: S(raw?.now, 1200), why_now: S(raw?.why_now, 600),
      developments: A(raw?.developments, 6, (d) => (S(d.text, 5) ? { date: S(d.date, 20), text: S(d.text, 400), evidence: Ev(d.evidence, 3) } : null)).sort((a, b) => (a.date < b.date ? 1 : -1)),
      indicators: A(raw?.indicators, 6, (i) => { const id = String(i.id || "").toUpperCase();
        if (iids.has(id)) return { id, why: S(i.why, 300), basis: "market data", evidence: Ev(i.evidence, 3) };
        const name = S(i.name, 80); return name ? { name, why: S(i.why, 300), basis: En(i.basis, ["market data", "article-grounded", "qualitative"], "qualitative"), evidence: Ev(i.evidence, 3) } : null; }),
      trigger: S(raw?.trigger, 500), first_order: S(raw?.first_order, 500),
      chain: A(raw?.chain, 6, (c) => (S(c.step, 3) ? { step: S(c.step, 120), timing: S(c.timing, 30), text: S(c.text, 600), evidence: Ev(c.evidence, 3) } : null)),
      channels: Object.fromEntries(["revenue", "cost", "demand", "regulation"].map((k) => [k, A(raw?.channels?.[k], 3, chan)])),
      fs_impact: A(raw?.fs_impact, 7, (f) => (S(f.lever, 2) ? { lever: S(f.lever, 40), direction: En(f.direction, DIR, "mixed"), magnitude: S(f.magnitude, 160), timing: S(f.timing, 40), why: S(f.why, 400) } : null)),
      exposure: A(raw?.exposure, 6, (e) => (S(e.segment, 2) ? { segment: S(e.segment, 80), level: En(e.level, ["high", "medium", "low"], "medium"), why: S(e.why, 400), names: Tk(e.names) } : null)),
      scenarios: sc, near_term: S(raw?.near_term, 600), structural: S(raw?.structural, 600),
      winners: A(raw?.winners, 5, (w) => { const s = Tk([w.symbol])[0]; return s ? { symbol: s, why: S(w.why, 260) } : null; }),
      losers: A(raw?.losers, 5, (w) => { const s = Tk([w.symbol])[0]; return s ? { symbol: s, why: S(w.why, 260) } : null; }),
      offsets: (Array.isArray(raw?.offsets) ? raw.offsets : []).slice(0, 4).map((x) => S(x, 300)).filter(Boolean),
      watch: A(raw?.watch, 6, (w) => (S(w.indicator, 2) ? { indicator: S(w.indicator, 120), signal: S(w.signal, 200), why: S(w.why, 260) } : null)),
    };
    const dates = [...new Set([...(r.scout_evidence || []), ...r.headlines, ...r.developments.flatMap((x) => x.evidence)])].map((id) => idx[id]?.date).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x || "")).sort();
    r.last_update = dates[dates.length - 1] || "";
    r.since = (/^\d{4}-\d{2}(-\d{2})?$/.test(S(raw?.since, 10)) ? S(raw?.since, 10) : "") || (/^\d{4}-\d{2}/.test(sit.since || "") ? sit.since : "") || dates[0] || "";
    r.stats = { ...stats };
    return r;
  }

  function cleanReg(raw, idx, doc) {
    const { S, Ev, Tk, En, A, stats } = makeCritic(idx, tickersOf(doc));
    const r = {
      summary: S(raw?.summary, 1400),
      regulators: A(raw?.regulators, 8, (x) => (S(x.name, 2) && !/^(the )?(government|regulators?|authorities)$/i.test(S(x.name, 80)) ? { name: S(x.name, 100), jurisdiction: S(x.jurisdiction, 40), why: S(x.why, 700), levers: (Array.isArray(x.levers) ? x.levers : []).map((l) => S(l, 40)).filter(Boolean).slice(0, 4), current: S(x.current, 400), evidence: Ev(x.evidence, 4) } : null)),
      policy: A(raw?.policy, 8, (x) => { const ev = Ev(x.evidence, 4); return S(x.title, 3) && ev.length ? { title: S(x.title, 160), status: S(x.status, 30), date: S(x.date, 20), direction: En(x.direction, ["headwind", "tailwind", "mixed"], "mixed"), impact: S(x.impact, 400), names: Tk(x.names), evidence: ev } : null; }),
      litigation: A(raw?.litigation, 8, (x) => { const ev = Ev(x.evidence, 4); return S(x.case, 3) && ev.length ? { case: S(x.case, 160), parties: S(x.parties, 200), status: S(x.status, 120), stakes: S(x.stakes, 300), next: S(x.next, 200), names: Tk(x.names), evidence: ev } : null; }),
      deals: A(raw?.deals, 8, (x) => { const ev = Ev(x.evidence, 4); return S(x.title, 3) && ev.length ? { title: S(x.title, 160), value: S(x.value, 60), status: S(x.status, 40), rationale: S(x.rationale, 300), names: Tk(x.names), evidence: ev } : null; }),
      consolidation: S(raw?.consolidation, 600),
      perception: { summary: S(raw?.perception?.summary, 800), trend: En(raw?.perception?.trend, ["improving", "stable", "deteriorating"], "stable"), evidence: Ev(raw?.perception?.evidence, 5) },
      regulatory_ids: Ev(raw?.regulatory_ids, 40), legal_ids: Ev(raw?.legal_ids, 40),
    };
    r.stats = { ...stats };
    return r;
  }

  const Team = { segmentsBlock, evidence, AGENTS, REGIMES, HORIZONS, index, fmtVal, geoMix, digest, header, companiesBlock, RULES, wireBlock, STATUS_W, macroPlanPrompt, cleanPlan, indicatorPrompt, cleanIndicators, labelTerms, mentions, relevantTo, tickersOf, kpiPrompt, macroPrompt, scoutPrompt, divePrompt, regPrompt, cleanKpi, cleanMacro, cleanScout, cleanDive, cleanReg, makeCritic };
  if (typeof module !== "undefined" && module.exports) module.exports = Team;
  else root.Team = Team;
})(typeof window !== "undefined" ? window : globalThis);
