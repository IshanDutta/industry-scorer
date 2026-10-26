/* Industry Scorer: Customers and suppliers (value chain), and what changed between earnings calls.
 *
 * Value chain: an analyst names the 4-8 listed companies outside the industry whose decisions most drive its
 * demand (customers) or supply (suppliers, inputs, channels). Code checks each ticker is real, actively traded
 * and not in the industry, then pulls their own filings: revenue growth, capital spending (latest quarter and
 * trailing year vs a year earlier, and whether it is accelerating), capex as a share of revenue, and their share
 * prices. Customers' combined capex is the hard demand signal (e.g. hyperscalers for semiconductors).
 *
 * Call to call: for the largest companies, the latest earnings call against the one before: tone, guidance,
 * new and dropped topics, new risks, with quotes checked word for word against both transcripts.
 * Pure functions, no I/O.
 */
(function (root) {
  "use strict";
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const trim = (s, n) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  const n = (x) => (x === null || x === undefined || x === "" ? NaN : Number(x));
  const ROLES = ["customer", "supplier", "channel", "competitor"];

  // ---------------------------------------------------------------- value chain
  function chainPrompt(doc, ctx) {
    const cons = (doc.constituents || []).slice(0, 20).map((c) => `${c.symbol} ${c.name}`).join("; ");
    return `You are the value-chain analyst on a buy-side research team covering the US-listed "${doc.name}" industry. Today is ${ctx.today}.
Name the 4-8 publicly listed companies OUTSIDE this industry whose own decisions most drive this industry's revenue (customers, distribution channels) or its costs and supply (suppliers of key inputs, equipment, materials). Prefer the ones whose filings give a measurable demand or supply signal: for example customers' capital spending, revenue, inventory, or orders. Include a substitute or competitor from another industry only if it materially moves this industry's pricing.

THE INDUSTRY'S LARGEST COMPANIES (do not name these): ${cons}
${ctx.kpiDigest ? `\nINDUSTRY KPI ANALYST'S FINDINGS\n${ctx.kpiDigest}\n` : ""}${ctx.segments ? `\nREVENUE SEGMENTS\n${ctx.segments}\n` : ""}${ctx.evidence ? `\nRECENT NEWS AND FILINGS (cite by ID)\n${ctx.evidence}\n` : ""}
RULES
- Only US-listed tickers (NYSE, NASDAQ, AMEX; ADRs are fine) that you are certain exist today. No private companies, no tickers from this industry's list.
- "metric" is what to watch in their filings: capex | revenue | inventory | orders.
- "depends" lists which of this industry's companies depend on them most.
- Cite IDs from the news where they support the relationship; never invent IDs.

Reply with ONLY this JSON:
{"partners": [{"symbol": "TICKER", "name": "...", "role": "customer | supplier | channel | competitor", "metric": "capex | revenue | inventory | orders", "share": "how much of the industry's revenue or supply runs through them, if known (e.g. '~40% of data-center GPU demand'), else ''", "depends": ["TICKER"], "why": "1-2 sentences on how their decisions reach this industry's revenue or costs", "evidence": []}]}`;
  }
  function cleanChain(raw, doc, idx = {}) {
    const inInd = new Set((doc.constituents || []).map((c) => String(c.symbol).toUpperCase()));
    const ours = (a) => (Array.isArray(a) ? a : []).map((x) => String(x).toUpperCase().trim()).filter((x) => inInd.has(x)).slice(0, 6);
    const seen = new Set();
    return (Array.isArray(raw?.partners) ? raw.partners : []).map((p) => {
      const sym = String(p?.symbol || "").toUpperCase().replace(/\./g, "-").trim();
      if (!/^[A-Z]{1,5}(-[A-Z])?$/.test(sym) || inInd.has(sym) || seen.has(sym)) return null; seen.add(sym);
      const role = ROLES.find((r) => String(p.role || "").toLowerCase().startsWith(r)) || "customer";
      return { symbol: sym, name: trim(p.name, 80), role, metric: ["capex", "revenue", "inventory", "orders"].find((m) => String(p.metric || "").toLowerCase().includes(m)) || (role === "customer" ? "capex" : "revenue"),
        share: trim(p.share, 120), depends: ours(p.depends), why: trim(p.why, 400), evidence: (Array.isArray(p.evidence) ? p.evidence : []).map((x) => String(x).toUpperCase()).filter((x) => idx[x]).slice(0, 4) };
    }).filter(Boolean).slice(0, 8);
  }
  /** One partner's numbers from FMP quarterly income and cash-flow rows and a price series. */
  function partnerStats(income, cashflow, series) {
    const q = (income || []).filter((r) => r?.date).sort((a, b) => (a.date < b.date ? 1 : -1));
    const cf = (cashflow || []).filter((r) => r?.date).sort((a, b) => (a.date < b.date ? 1 : -1));
    const sum = (rows, k, f, t) => { if (rows.length < t) return NaN; const v = rows.slice(f, t).map((r) => Math.abs(n(r[k]))); return v.every(isNum) ? v.reduce((a, x) => a + x, 0) : NaN; };
    const yoy = (rows, k, i) => (rows.length > i + 4 && Math.abs(n(rows[i + 4][k])) > 0 ? Math.abs(n(rows[i][k])) / Math.abs(n(rows[i + 4][k])) - 1 : NaN);
    const cap = (r) => r.capitalExpenditure ?? r.investmentsInPropertyPlantAndEquipment;
    const cfx = cf.map((r) => ({ date: r.date, capex: cap(r) }));
    const capTTM = sum(cfx, "capex", 0, 4), capPrev = sum(cfx, "capex", 4, 8);
    const revTTM = sum(q, "revenue", 0, 4), revPrev = sum(q, "revenue", 4, 8);
    const c = series?.closes || [];
    const r = (k) => (c.length > k ? c[c.length - 1] / c[c.length - 1 - k] - 1 : NaN);
    return { quarter: q[0]?.date || cf[0]?.date || null, currency: String(q[0]?.reportedCurrency || cf[0]?.reportedCurrency || "USD"),
      rev_yoy_q: yoy(q, "revenue", 0), rev_yoy_ttm: revPrev > 0 ? revTTM / revPrev - 1 : NaN,
      capex_yoy_q: yoy(cfx, "capex", 0), capex_yoy_q_prev: yoy(cfx, "capex", 1), capex_yoy_ttm: capPrev > 0 ? capTTM / capPrev - 1 : NaN,
      capex_ttm: capTTM, capex_prev: capPrev, capex_rev: revTTM > 0 ? capTTM / revTTM : NaN, r3m: r(63), r1y: r(252) };
  }
  /** Aggregates: customers' combined capex (USD filers), suppliers' revenue growth. partners: cleanChain rows with .stats */
  function chainAggregate(partners) {
    const cust = partners.filter((p) => p.role === "customer" && p.stats && p.stats.currency === "USD");
    const both = cust.filter((p) => isNum(p.stats.capex_ttm) && isNum(p.stats.capex_prev));
    const capNow = both.reduce((a, p) => a + p.stats.capex_ttm, 0), capPrev = both.reduce((a, p) => a + p.stats.capex_prev, 0);
    const med = (a) => { const s = a.filter(isNum).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
    const acc = cust.filter((p) => isNum(p.stats.capex_yoy_q) && isNum(p.stats.capex_yoy_q_prev));
    const sup = partners.filter((p) => p.role === "supplier" && p.stats);
    return { customers: cust.length, customers_with_capex: both.length, customer_capex_ttm: both.length ? capNow : NaN, customer_capex_growth: capPrev > 0 ? capNow / capPrev - 1 : NaN,
      customer_capex_q_median: med(cust.map((p) => p.stats.capex_yoy_q)), accelerating: acc.filter((p) => p.stats.capex_yoy_q > p.stats.capex_yoy_q_prev).map((p) => p.symbol),
      decelerating: acc.filter((p) => p.stats.capex_yoy_q < p.stats.capex_yoy_q_prev).map((p) => p.symbol),
      customer_rev_growth: med(cust.map((p) => p.stats.rev_yoy_ttm)), suppliers: sup.length, supplier_rev_growth: med(sup.map((p) => p.stats.rev_yoy_ttm)) };
  }
  function chainDigest(ch) {
    if (!ch?.partners?.length) return "";
    const p = (x) => (isNum(x) ? `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%` : "n/a");
    const a = ch.aggregate || {};
    return `CUSTOMERS AND SUPPLIERS (named by the value-chain analyst; numbers from their own filings, by code)\n` +
      (a.customers_with_capex ? `Customers' combined capital spending: $${(a.customer_capex_ttm / 1e9).toFixed(1)}B over the last 12 months, ${p(a.customer_capex_growth)} vs a year earlier; median latest-quarter capex ${p(a.customer_capex_q_median)} y/y${a.accelerating.length ? `; accelerating: ${a.accelerating.join(", ")}` : ""}${a.decelerating.length ? `; decelerating: ${a.decelerating.join(", ")}` : ""}. Customers' median revenue growth ${p(a.customer_rev_growth)}.\n` : "") +
      (a.suppliers ? `Suppliers' median revenue growth ${p(a.supplier_rev_growth)}.\n` : "") +
      ch.partners.map((x) => `- ${x.symbol} ${x.name} (${x.role}${x.share ? `; ${x.share}` : ""}; matters to ${x.depends.join(", ") || "the industry"}): ${x.why}${x.stats ? ` Revenue ${p(x.stats.rev_yoy_ttm)} TTM; capex ${p(x.stats.capex_yoy_ttm)} TTM, ${p(x.stats.capex_yoy_q)} latest quarter (${p(x.stats.capex_yoy_q_prev)} the quarter before); capex ${isNum(x.stats.capex_rev) ? (x.stats.capex_rev * 100).toFixed(0) + "%" : "n/a"} of revenue; shares ${p(x.stats.r3m)} 3M, ${p(x.stats.r1y)} 1Y.` : " (no filings data)"}${x.evidence.length ? ` [${x.evidence.join(", ")}]` : ""}`).join("\n");
  }

  // ---------------------------------------------------------------- call to call
  const TONES = ["more confident", "unchanged", "more cautious"];
  const GUIDE = ["raised", "maintained", "lowered", "introduced", "withdrawn", "not given"];
  function callsPrompt(doc, transcripts, ctx) {
    const pairs = (transcripts || []).filter((t) => t.prev?.excerpt);
    const blocks = pairs.map((t) => `=== ${t.symbol} ${t.name || ""} ===\nLATEST CALL ${t.period} (${t.date}) [${t.id}]\n${String(t.excerpt).slice(0, 6500)}\n\nPREVIOUS CALL ${t.prev.period} (${t.prev.date})\n${String(t.prev.excerpt).slice(0, 6000)}`).join("\n\n");
    return `You are the earnings-call analyst on a buy-side research team covering the US-listed "${doc.name}" industry. Today is ${ctx.today}. For each company below you have condensed passages from its latest earnings call and the call before. Say what CHANGED between the two calls: tone, guidance, what management now emphasizes or stopped mentioning, and new risks. Then say what the changes add up to for the industry.

${blocks}

RULES
- Compare the two calls; don't summarize either one alone. "unchanged" is a fine answer.
- "quote_now" must be copied word for word from the LATEST passages and "quote_then" word for word from the PREVIOUS ones (a full sentence or a clause of at least 8 words); code checks both and drops any that don't match.
- Guidance: raised | maintained | lowered | introduced | withdrawn | not given, with the specific numbers if stated.

Reply with ONLY this JSON:
{"summary": {"direction": "improving | steady | deteriorating", "text": "3-4 sentences on what the changes across these companies add up to for the industry, citing [T#]"},
 "companies": [{"symbol": "TICKER", "tone": "more confident | unchanged | more cautious", "tone_why": "one sentence", "guidance": "raised | maintained | lowered | introduced | withdrawn | not given", "guidance_detail": "the numbers, if any", "new_topics": ["..."], "dropped_topics": ["..."], "new_risks": ["..."], "quote_now": "...", "quote_then": "..."}]}`;
  }
  const norm = (s) => String(s || "").toLowerCase().replace(/[“”"'’‘]/g, "").replace(/[^a-z0-9%$. ]+/g, " ").replace(/\s+/g, " ").trim();
  function cleanCalls(raw, transcripts) {
    const by = Object.fromEntries((transcripts || []).filter((t) => t.prev?.excerpt).map((t) => [String(t.symbol).toUpperCase(), t]));
    const strs = (a, k, m) => (Array.isArray(a) ? a : []).map((x) => trim(x, m)).filter(Boolean).slice(0, k);
    const verified = (q, text) => { const a = norm(q); return a.split(" ").length >= 8 && norm(text).includes(a) ? trim(q, 400) : ""; };
    let dropped = 0;
    const companies = (Array.isArray(raw?.companies) ? raw.companies : []).map((c) => {
      const t = by[String(c?.symbol || "").toUpperCase()]; if (!t) return null;
      const qn = verified(c.quote_now, t.excerpt), qt = verified(c.quote_then, t.prev.excerpt);
      if (c.quote_now && !qn) dropped++; if (c.quote_then && !qt) dropped++;
      return { symbol: t.symbol, id: t.id, period: t.period, prev_period: t.prev.period, tone: TONES.find((x) => String(c.tone || "").toLowerCase().startsWith(x.split(" ")[0]) && String(c.tone || "").toLowerCase().includes(x.split(" ").pop())) || "unchanged",
        tone_why: trim(c.tone_why, 300), guidance: GUIDE.find((g) => String(c.guidance || "").toLowerCase().startsWith(g.split(" ")[0])) || "not given", guidance_detail: trim(c.guidance_detail, 300),
        new_topics: strs(c.new_topics, 5, 120), dropped_topics: strs(c.dropped_topics, 5, 120), new_risks: strs(c.new_risks, 5, 160), quote_now: qn, quote_then: qt };
    }).filter(Boolean);
    const d = String(raw?.summary?.direction || "").toLowerCase();
    const score = companies.reduce((a, c) => a + (c.tone === "more confident" ? 1 : c.tone === "more cautious" ? -1 : 0) + (c.guidance === "raised" ? 1 : c.guidance === "lowered" || c.guidance === "withdrawn" ? -1 : 0), 0);
    return { summary: { direction: ["improving", "steady", "deteriorating"].find((x) => d.startsWith(x.slice(0, 5))) || "steady", text: trim(raw?.summary?.text, 900) }, companies, score, n: companies.length, quotes_dropped: dropped };
  }
  function callsDigest(c) {
    if (!c?.companies?.length) return "";
    return `EARNINGS CALLS, WHAT CHANGED SINCE THE PREVIOUS CALL (earnings-call analyst; quotes checked word for word): ${c.summary.direction}. ${c.summary.text}\n` +
      c.companies.map((x) => `- ${x.symbol} ${x.prev_period} → ${x.period} [${x.id}]: tone ${x.tone} (${x.tone_why}); guidance ${x.guidance}${x.guidance_detail ? ` (${x.guidance_detail})` : ""}${x.new_topics.length ? `; new: ${x.new_topics.join("; ")}` : ""}${x.dropped_topics.length ? `; dropped: ${x.dropped_topics.join("; ")}` : ""}${x.new_risks.length ? `; new risks: ${x.new_risks.join("; ")}` : ""}${x.quote_now ? `. Now: "${x.quote_now}"` : ""}${x.quote_then ? ` Then: "${x.quote_then}"` : ""}`).join("\n");
  }

  const Chain = { ROLES, chainPrompt, cleanChain, partnerStats, chainAggregate, chainDigest, TONES, GUIDE, callsPrompt, cleanCalls, callsDigest };
  if (typeof module !== "undefined" && module.exports) module.exports = Chain;
  else root.Chain = Chain;
})(typeof window !== "undefined" ? window : globalThis);
