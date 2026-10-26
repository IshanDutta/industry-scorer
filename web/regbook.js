/* Industry Scorer: "Regulatory bodies that matter" rule books.
 *
 * Three layers, built in order for one industry:
 *   1. Bodies list: 4-8 agencies that move earnings, pricing or volumes
 *      (written by the regulation analyst in team.js; name, jurisdiction,
 *      why, levers, what it is doing now).
 *   2. Per-body rule book: the 5 binding instruments ranked by 12-month
 *      financial materiality, each with seven sections (what this is,
 *      industry impact, last 12 months, today, next 12 months, company
 *      examples, bottom line). One Claude call per body, fed by a code
 *      pre-search of the past year's news for that body, plus search tools
 *      the agent can call for more.
 *   3. Overall regulatory verdict across all bodies and rules.
 *
 * Hallucination controls (code, after every call):
 *   - citations must resolve to a retrieved item; dated events and company
 *     examples without one are dropped, and an example is dropped unless the
 *     company appears in the cited article;
 *   - a fact-check call labels every sentence carrying a number or citation
 *     verified / corrected / background / unsupported against the retrieved
 *     text; corrected sentences are rewritten, unsupported ones removed. If
 *     the fact-check can't run, numeric claims are held back, never shown as
 *     verified;
 *   - when a rule book can't be built, a clearly labelled notice is shown
 *     instead; nothing hand-written stands in for it.
 */
(function (root) {
  "use strict";
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const trim = (s, n) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  const day = (s) => String(s ?? "").slice(0, 10);
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
  function addDays(d, k) { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + k); return t.toISOString().slice(0, 10); }
  const eodSym = (s) => String(s).replace(/\./g, "-").toUpperCase() + ".US";

  const CATEGORIES = ["law", "rule", "rate", "tariff", "mandate", "quota", "threshold", "fine", "subsidy", "approval"];
  const STATUSES = ["in_force", "proposed", "rescinded", "pending"];
  const SEVERITY = ["high", "medium", "low"];
  const SECTIONS = [["what_this_is", "What this is"], ["industry_impact", "Industry impact"], ["last_12_months", "Last 12 months"], ["today", "Today"],
    ["next_12_months", "Next 12 months"], ["examples", "Company examples"], ["bottom_line", "Bottom line"]];
  const MAX_SOURCES = 25;

  const bodyKey = (name) => String(name || "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "body";
  /** Two-letter ID prefix for a body's own sources: RA, RB, ... (citable as RA1, RB12). */
  const prefixFor = (i) => "R" + String.fromCharCode(65 + (i % 26));

  // ------------------------------------------------------------------ matching a body in text
  const STOP = new Set(["US", "U", "S", "THE", "AND", "OF", "FOR", "EU", "UK", "NA", "AI", "CEO", "IPO", "Q", "FY"]);
  function bodyMatcher(body) {
    const name = String(body?.name || "");
    const acr = [...new Set((name.match(/\b[A-Z][A-Z&]{1,7}\b/g) || []).filter((a) => !STOP.has(a)))];
    if (/\bEU\b|European Commission/i.test(name)) acr.push("European Commission", "EU Commission", "Brussels");
    const full = name.split(/\s+[—–-]\s+|\(|\)/).map((x) => x.trim()).filter((x) => x.length > 8 && !/^[A-Z&]+$/.test(x));
    const lever = (body?.levers || []).map((l) => String(l).trim().toLowerCase().split(/\s+/).slice(0, 3).map((w, i, a) => (i === a.length - 1 && w.length > 6 ? w.slice(0, w.length - 2) + "\\w*" : w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("\\s+")).filter((x) => x.length > 4);
    const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const reAcr = acr.length ? new RegExp(`\\b(?:${acr.map(esc).join("|")})\\b`) : null;
    const reTxt = full.length || lever.length ? new RegExp(`(?:${[...full.map(esc), ...lever].join("|")})`, "i") : null;
    return (text) => { const t = String(text || ""); return !!((reAcr && reAcr.test(t)) || (reTxt && reTxt.test(t))); };
  }

  // ------------------------------------------------------------------ pre-search (code, deterministic)
  /**
   * The past year's coverage of one body, for the industry's largest companies:
   * existing research items that mention it, FMP company news and press
   * releases, and EODHD regulation news. Deduped by URL, at most 25 sources.
   */
  async function preSearch(fmp, eod, ctx, body, bi) {
    const test = bodyMatcher(body);
    const pre = prefixFor(bi);
    const out = { reused: [], items: [], prefix: pre };
    const seen = new Set();
    const add = (it) => {
      if (!it.url || seen.has(it.url) || out.reused.length + out.items.length >= MAX_SOURCES) return;
      seen.add(it.url); out.items.push({ id: pre + (out.items.length + 1), kind: "R", ...it });
    };
    for (const i of ctx.pack?.items || []) if (test(`${i.title} ${i.summary || ""}`) && !seen.has(i.url) && out.reused.length < 12) { seen.add(i.url); out.reused.push(i.id); }
    const safe = async (label, fn) => { ctx.onStep?.(label); try { return await fn(); } catch (e) { if (ctx.isFatal?.(e)) throw e; return null; } };
    const syms = (ctx.constituents || []).slice(0, 10).map((c) => c.symbol);
    const nameOf = Object.fromEntries((ctx.constituents || []).map((c) => [c.symbol, c.name]));
    const from = addDays(ctx.today, -365);
    const news = await safe(`Searching a year of news for ${trim(body.name, 40)}`, () => fmp("news", { endpoint: "search-stock-news", symbols: syms, from_date: from, to_date: ctx.today, limit: 250 }));
    for (const r of news || []) if (test(`${r.title} ${r.text}`)) add({ date: day(r.publishedDate), symbol: r.symbol, company: nameOf[r.symbol], source: r.site || host(r.url), title: trim(r.title, 200), summary: trim(r.text, 600), url: r.url });
    const pr = await safe(`Searching press releases for ${trim(body.name, 40)}`, () => fmp("news", { endpoint: "search-press-releases", symbols: syms.slice(0, 8), from_date: from, to_date: ctx.today, limit: 100 }));
    for (const r of pr || []) if (test(`${r.title} ${r.text}`)) add({ date: day(r.publishedDate ?? r.date), symbol: r.symbol, company: nameOf[r.symbol], source: "press release", title: trim(r.title, 200), summary: trim(r.text, 600), url: r.url });
    if (eod) {
      const tags = ["regulation", ...(/\bEU\b|europe/i.test(`${body.name} ${body.jurisdiction}`) ? ["european regulatory news"] : []), ...(/tariff|trade|export|customs|commerce/i.test(`${body.name} ${(body.levers || []).join(" ")}`) ? ["tariffs", "trade"] : [])];
      for (const tag of tags) {
        const rows = await safe(`Searching ${tag} news`, () => eod("get_company_news", { tag, start_date: from, end_date: ctx.today, limit: 60 }));
        for (const r of Array.isArray(rows) ? rows : []) if (test(`${r.title} ${r.content}`)) add({ date: day(r.date), source: host(r.link) || "EODHD", title: trim(r.title, 200), summary: trim(r.content, 600), url: r.link });
      }
      for (const s of syms.slice(0, 4)) {
        const rows = await safe(`Searching ${s} news`, () => eod("get_company_news", { ticker: eodSym(s), start_date: from, end_date: ctx.today, limit: 60 }));
        for (const r of Array.isArray(rows) ? rows : []) if (test(`${r.title} ${r.content}`)) add({ date: day(r.date), symbol: s, company: nameOf[s], source: host(r.link) || "EODHD", title: trim(r.title, 200), summary: trim(r.content, 600), url: r.link });
      }
    }
    out.items.sort((a, b) => (a.date < b.date ? 1 : -1));
    out.items.forEach((it, k) => { it.id = pre + (k + 1); });
    return out;
  }

  /** Extra search tools for the rule-book agent; results join that body's sources with new IDs. */
  function buildTools(fmp, eod, ctx, store) {
    const register = (it) => {
      const hit = store.items.find((x) => x.url === it.url); if (hit) return hit;
      const x = { id: store.prefix + (store.items.length + 1), kind: "R", ...it }; store.items.push(x); return x;
    };
    const view = (x) => ({ id: x.id, date: x.date, symbol: x.symbol, source: x.source, title: x.title, summary: trim(x.summary, 400) });
    const kw = (k) => { if (!k) return () => true; const re = new RegExp(String(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 60), "i"); return (t) => re.test(t); };
    const tools = [{
      name: "search_company_news",
      description: "Search up to a year of news for up to 10 tickers, optionally filtered by a keyword (e.g. an agency acronym, a rule name, 'export license'). Returns items with citable IDs: [{id, date, symbol, source, title, summary}].",
      inputSchema: { type: "object", properties: { symbols: { type: "array", items: { type: "string" } }, keyword: { type: "string" }, days: { type: "number", description: "1-365, default 365" } }, required: ["symbols"] },
      async execute(input) {
        const syms = (Array.isArray(input.symbols) ? input.symbols : []).map((s) => String(s).toUpperCase().trim()).filter(Boolean).slice(0, 10);
        if (!syms.length) throw new Error("Pass at least one ticker.");
        ctx.onStep?.(`Searching news: ${syms.slice(0, 3).join(", ")}${input.keyword ? ` for "${trim(input.keyword, 30)}"` : ""}`);
        const d = Math.min(Math.max(Number(input.days) || 365, 1), 365); const f = kw(input.keyword);
        const rows = await fmp("news", { endpoint: "search-stock-news", symbols: syms, from_date: addDays(ctx.today, -d), to_date: ctx.today, limit: 250 });
        return rows.filter((r) => f(`${r.title} ${r.text}`)).slice(0, 20).map((r) => view(register({ date: day(r.publishedDate), symbol: r.symbol, source: r.site || host(r.url), title: trim(r.title, 200), summary: trim(r.text, 600), url: r.url })));
      } }];
    if (eod) tools.push({
      name: "search_topic_news",
      description: "Search up to a year of EODHD news by topic tag (one tag per call, e.g. 'regulation', 'tariffs', 'trade', 'class action', 'mergers and acquisitions', 'european regulatory news'), optionally filtered by keyword. Returns items with citable IDs.",
      inputSchema: { type: "object", properties: { tag: { type: "string" }, keyword: { type: "string" }, days: { type: "number" } }, required: ["tag"] },
      async execute(input) {
        ctx.onStep?.(`Searching "${trim(input.tag, 30)}" news${input.keyword ? ` for "${trim(input.keyword, 30)}"` : ""}`);
        const d = Math.min(Math.max(Number(input.days) || 365, 1), 365); const f = kw(input.keyword);
        const rows = await eod("get_company_news", { tag: String(input.tag).toLowerCase().slice(0, 40), start_date: addDays(ctx.today, -d), end_date: ctx.today, limit: 60 });
        return (Array.isArray(rows) ? rows : []).filter((r) => f(`${r.title} ${r.content}`)).slice(0, 15).map((r) => view(register({ date: day(r.date), source: host(r.link) || "EODHD", title: trim(r.title, 200), summary: trim(r.content, 600), url: r.link })));
      } });
    return tools;
  }

  // ------------------------------------------------------------------ prompts
  const evLine = (i) => `[${i.id}] ${i.date} · ${i.source || ""}${i.symbol ? " · " + i.symbol : ""} — ${i.title}${i.summary ? ". " + trim(i.summary, 500) : ""}`;

  function bookPrompt(doc, body, sources, ctx, T) {
    return `You are a regulatory analyst on a buy-side research team. Build the rule book for ONE regulatory body as it applies to this industry: the 5 specific, binding instruments (laws, rules, rates, tariffs, mandates, quotas, thresholds, fines, subsidies, approvals) that matter most for these companies' earnings over the next 12 months.

${T.header(doc, ctx)}

${T.companiesBlock(doc, 20)}

REGULATORY BODY: ${body.name} (${body.jurisdiction || "jurisdiction n/a"})
Why it matters (from the team's bodies list): ${body.why}
Levers: ${(body.levers || []).join("; ") || "n/a"}
What it is doing now: ${body.current || "n/a"}

RETRIEVED SOURCES ON THIS BODY (past 12 months; cite by ID)
${sources.map(evLine).join("\n") || "(none retrieved)"}
${ctx.tools ? "\nYou can call search_company_news and search_topic_news to find more dated evidence (enforcement actions, licenses, fines, approvals, rule changes) before writing. Cite what they return by ID." : ""}

RULES
- Rank the 5 instruments by 12-month forward financial materiality for these companies, largest first. No duplicates.
- Currently binding law only. If you include a proposed, pending or rescinded framework (e.g. a rule that was withdrawn), set "status" accordingly; never present a rescinded rule as in force.
- "citation": the precise statute, CFR section, docket or Federal Register / Official Journal reference. "numeric_value": hard numbers only (thresholds, %, $, nm, layers, fees), separated by " · ", no prose; empty string if none.
- Zero tolerance for invention: every named company action, dollar fine, court case, deal, executive quote, earnings disclosure or exact date must be supported by a retrieved source ID, otherwise omit it or restate it qualitatively. Never invent deals, fines, settlements, quotes or analyst calls. Qualitative ranges ("mid-single-digit margin compression") are fine without a citation; specific numbers are not, except the instrument's own legal parameters (its citation, thresholds and effective date), which you may state from knowledge of the law.
- "last_12_months": 4-9 dated events in chronological order, each <= 160 characters, each tied to a source ID; omit any you can't tie to one.
- "next_12_months.events": 3-7 dated forward catalysts (scheduled rulemaking, sunset, deadline, hearing, earnings date) each with its trigger and a source ID.
- "examples": 2-4 real company examples; the company, the date and the event must all appear in the cited source. Use tickers from the company table where possible.
- No forecasts presented as fact, no opinions, no partisan commentary.
- Reply with ONLY the JSON.

JSON shape:
{"rules": [{"name": "short specific instrument name", "citation": "...", "category": "law | rule | rate | tariff | mandate | quota | threshold | fine | subsidy | approval", "status": "in_force | proposed | rescinded | pending", "effective": "effective date / cite tail", "numeric_value": "e.g. TPP ≥ 4,800 · 16/14 nm logic", "severity": "high | medium | low",
  "what_this_is": "3-4 plain-English sentences: the statute/CFR/notice and the agency's authority, who it binds, how it is enforced",
  "industry_impact": "4-5 investor-grade sentences: the main transmission channel (revenue, price/margin, capex, market access), which kinds of companies win or lose (name tickers), the second-order effect",
  "last_12_months": [{"date": "YYYY-MM-DD", "event": "<= 160 chars", "evidence": ["${prefixFor(ctx.bi)}1"]}],
  "today": "2-3 sentences on how the rule partitions the market right now",
  "next_12_months": {"analysis": "6-9 sentences of forward read", "events": [{"date": "YYYY-MM-DD or YYYY-MM", "event": "...", "trigger": "what would set it off or what to look for", "evidence": []}]},
  "examples": [{"company": "TICKER or company name", "date": "YYYY-MM-DD", "what": "what happened", "impact": "the financial impact", "evidence": []}],
  "bottom_line": "one sentence, <= 35 words, the structural investment conclusion"}]}
Exactly 5 rules when the body has 5 relevant instruments; fewer only if it genuinely doesn't.`;
  }

  /**
   * Step 1 of a rule book (with search tools): pick the body's 5 most material
   * instruments. Small JSON, so it never runs into the answer-length limit.
   */
  function listPrompt(doc, body, sources, ctx, T) {
    return `You are a regulatory analyst on a buy-side research team. Identify the 5 specific, binding instruments (laws, rules, rates, tariffs, mandates, quotas, thresholds, fines, subsidies, approvals) of ONE regulatory body that matter most for this industry's earnings over the next 12 months. A colleague will write each one up in full from your list, so be precise.

${T.header(doc, ctx)}

${T.companiesBlock(doc, 20)}

REGULATORY BODY: ${body.name} (${body.jurisdiction || "jurisdiction n/a"})
Why it matters (from the team's bodies list): ${body.why}
Levers: ${(body.levers || []).join("; ") || "n/a"}
What it is doing now: ${body.current || "n/a"}

RETRIEVED SOURCES ON THIS BODY (past 12 months; cite by ID)
${sources.map(evLine).join("\n") || "(none retrieved)"}
${ctx.tools ? "\nCall search_company_news and search_topic_news to find more dated evidence (enforcement actions, licenses, fines, approvals, rule changes) before you answer. Cite what they return by ID." : ""}

RULES
- Rank by 12-month forward financial materiality for these companies, largest first. No duplicates.
- Currently binding law first. A proposed, pending or rescinded framework gets that status; never present a rescinded rule as in force.
- "citation": the precise statute, CFR section, docket or Federal Register / Official Journal reference. "numeric_value": hard numbers only (thresholds, %, $, nm, fees), separated by " · ", no prose; empty string if none.
- "evidence": the source IDs that are about this instrument (the colleague writes from these).
- Reply with ONLY the JSON, no commentary.

JSON shape:
{"rules": [{"name": "short specific instrument name", "citation": "...", "category": "law | rule | rate | tariff | mandate | quota | threshold | fine | subsidy | approval", "status": "in_force | proposed | rescinded | pending", "effective": "effective date / cite tail", "numeric_value": "e.g. TPP ≥ 4,800 · 16/14 nm logic", "severity": "high | medium | low", "why": "one sentence: why it is material for these companies", "evidence": ["${prefixFor(ctx.bi)}1"]}]}
Exactly 5 rules when the body has 5 relevant instruments; fewer only if it genuinely doesn't.`;
  }

  /** Step 2 (one call per instrument): the seven sections for ONE rule. */
  function rulePrompt(doc, body, rule, sources, ctx, T) {
    const mine = new Set(rule.evidence || []);
    const ordered = [...sources.filter((x) => mine.has(x.id)), ...sources.filter((x) => !mine.has(x.id))];
    return `You are a regulatory analyst on a buy-side research team. Write the rule-book entry for ONE binding instrument as it applies to this industry.

${T.header(doc, ctx)}

${T.companiesBlock(doc, 20)}

REGULATORY BODY: ${body.name} (${body.jurisdiction || "jurisdiction n/a"}). ${body.why || ""}
INSTRUMENT: ${rule.name} — ${rule.citation || "citation n/a"}; ${rule.category || ""}; status ${rule.status || "n/a"}; effective ${rule.effective || "n/a"}${rule.numeric_value ? `; ${rule.numeric_value}` : ""}. Severity ${rule.severity || "n/a"}. ${rule.why || ""}

RETRIEVED SOURCES (past 12 months; the ones about this instrument first; cite by ID)
${ordered.map(evLine).join("\n") || "(none retrieved)"}

RULES
- Zero tolerance for invention: every named company action, dollar fine, court case, deal, executive quote, earnings disclosure or exact date must be supported by a source ID above, otherwise omit it or restate it qualitatively. Qualitative ranges ("mid-single-digit margin compression") are fine without a citation; specific numbers are not, except the instrument's own legal parameters (citation, thresholds, effective date), which you may state from knowledge of the law.
- "last_12_months": 3-8 dated events in chronological order, each <= 160 characters, each tied to a source ID; omit any you can't tie to one.
- "next_12_months.events": 2-6 dated forward catalysts (rulemaking, sunset, deadline, hearing, earnings date), each with its trigger and a source ID where one exists.
- "examples": 1-4 real company examples; the company, the date and the event must all appear in the cited source. Use tickers from the company table where possible.
- No forecasts presented as fact, no opinions. Reply with ONLY the JSON object, no commentary.

JSON shape:
{"name": "${String(rule.name || "").replace(/"/g, "'")}", "citation": "...", "category": "...", "status": "...", "effective": "...", "numeric_value": "...", "severity": "...",
 "what_this_is": "3-4 plain-English sentences: the statute/CFR/notice and the agency's authority, who it binds, how it is enforced",
 "industry_impact": "4-5 investor-grade sentences: the main transmission channel (revenue, price/margin, capex, market access), which kinds of companies win or lose (name tickers), the second-order effect",
 "last_12_months": [{"date": "YYYY-MM-DD", "event": "<= 160 chars", "evidence": ["${prefixFor(ctx.bi)}1"]}],
 "today": "2-3 sentences on how the rule partitions the market right now",
 "next_12_months": {"analysis": "5-8 sentences of forward read", "events": [{"date": "YYYY-MM-DD or YYYY-MM", "event": "...", "trigger": "what would set it off or what to look for", "evidence": []}]},
 "examples": [{"company": "TICKER or company name", "date": "YYYY-MM-DD", "what": "what happened", "impact": "the financial impact", "evidence": []}],
 "bottom_line": "one sentence, <= 35 words, the structural investment conclusion"}`;
  }

  /**
   * Recover a JSON value from an answer that was cut short (or had stray text):
   * keep everything up to the last complete element and close the open brackets.
   * Returns the parsed value or null.
   */
  function repairJson(text) {
    const s = String(text || ""); const start = s.search(/[\[{]/); if (start < 0) return null;
    const body = s.slice(start);
    try { return JSON.parse(body); } catch {}
    const stack = []; let inStr = false, esc = false, lastSafe = -1, safeStack = null;
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') { inStr = true; continue; }
      if (c === "{" || c === "[") stack.push(c);
      else if (c === "}" || c === "]") { stack.pop(); if (!stack.length) { try { return JSON.parse(body.slice(0, i + 1)); } catch { return null; } } lastSafe = i; safeStack = [...stack]; }
      else if (c === ",") { lastSafe = i - 1; safeStack = [...stack]; }
    }
    if (lastSafe < 0 || !safeStack) return null;
    const close = safeStack.slice().reverse().map((c) => (c === "{" ? "}" : "]")).join("");
    try { return JSON.parse(body.slice(0, lastSafe + 1).replace(/,\s*$/, "") + close); } catch { return null; }
  }

  function verdictPrompt(doc, bodies, books, ctx, T) {
    const cut = (x, n) => { const t = String(x || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
    const ev = (a) => (a?.length ? ` [${a.join(", ")}]` : "");
    const lines = bodies.map((b, i) => {
      const bk = books[i];
      const rules = bk?.rules?.length ? bk.rules.map((r) => [
        `  - [${r.severity}] ${r.name} (${r.citation}; ${r.status}${r.effective ? "; effective " + r.effective : ""}${r.numeric_value ? "; " + r.numeric_value : ""})`,
        r.what_this_is ? `    What it is: ${cut(r.what_this_is, 400)}` : "",
        r.industry_impact ? `    Industry impact: ${cut(r.industry_impact, 600)}` : "",
        (r.last_12_months || []).length ? `    Last 12 months: ${r.last_12_months.map((e) => `${e.date} ${cut(e.event, 160)}${ev(e.evidence)}`).join("; ")}` : "",
        r.today ? `    Today: ${cut(r.today, 400)}` : "",
        r.next_12_months?.analysis || (r.next_12_months?.events || []).length ? `    Next 12 months: ${cut(r.next_12_months?.analysis, 400)} ${(r.next_12_months?.events || []).map((e) => `${e.date} ${cut(e.event, 140)}${ev(e.evidence)}`).join("; ")}` : "",
        (r.examples || []).length ? `    Company examples: ${r.examples.map((x) => `${x.company} ${x.date}: ${cut(x.what, 140)}${x.impact ? " (" + cut(x.impact, 100) + ")" : ""}${ev(x.evidence)}`).join("; ")}` : "",
        r.bottom_line ? `    Bottom line: ${cut(r.bottom_line, 300)}` : "",
      ].filter(Boolean).join("\n")).join("\n") : "  (no rule book: it couldn't be built from live sources)";
      return `${i + 1}. ${b.name} — ${b.jurisdiction}. ${b.why}${b.levers?.length ? ` Levers: ${b.levers.join(", ")}.` : ""} Now: ${b.current}\n${rules}`;
    }).join("\n\n");
    return `You are the head of regulatory research on a buy-side team. Synthesize ONE overall regulatory verdict for this industry from ALL the bodies and their complete, fact-checked rule books below (every rule's impact, history, current state, outlook and company examples). Weigh every body, not just the first.

${T.header(doc, ctx)}

BODIES AND RULE BOOKS
${lines}

RULES
- Weigh by 12-month financial materiality. Cite source IDs that appear above when you name a dated event. Never invent events, numbers or IDs. Tickers only from the industry's companies.
- Reply with ONLY the JSON.

JSON shape:
{"stance": "headwind | tailwind | mixed | neutral", "intensity": "high | medium | low",
 "headline": "one sentence verdict",
 "summary": "5-7 sentences: which rules dominate, how they hit revenue, margin and capex, who is advantaged, what changes in the next 12 months",
 "most_material": [{"body": "...", "rule": "...", "why": "1-2 sentences", "evidence": []}],
 "timeline": [{"date": "YYYY-MM-DD or YYYY-MM", "event": "...", "body": "...", "evidence": []}],
 "winners": [{"symbol": "TICKER", "why": "..."}], "losers": [{"symbol": "TICKER", "why": "..."}],
 "watch": ["specific things to watch"]}
Sizes: 3-5 most_material, up to 10 timeline events (chronological), 2-5 winners and losers, 3-5 watch items.`;
  }

  // ------------------------------------------------------------------ critics
  const EN = (x, list, d) => { const s = String(x ?? "").toLowerCase().trim().replace(/[\s-]+/g, "_"); return list.find((l) => l === s) || list.find((l) => s.startsWith(l.split("_")[0])) || d; };
  const words = (s, n) => { const w = String(s || "").split(/\s+/).filter(Boolean); return w.length > n ? w.slice(0, n).join(" ") + "…" : w.join(" "); };

  /** Normalize a rule book. idx: citable items by ID (pack + this body's sources). */
  function cleanBook(raw, idx, doc, ctx, T) {
    const { S, Ev, Tk, A } = T.makeCritic(idx, T.tickersOf(doc));
    const names = new Set();
    const nameOf = Object.fromEntries((doc?.constituents || []).map((c) => [c.symbol, c.name]));
    const mentions = (ev, company) => {
      const c = String(company || "").trim(); if (!c) return false;
      const sym = c.toUpperCase().replace(/[^A-Z.\-]/g, "");
      const nm = (nameOf[sym] || c).replace(/,?\s+(Inc|Corporation|Corp|Co|Ltd|Limited|plc|Holdings|Group|N\.V|S\.A|Technologies|Technology)\.?$/i, "").split(/\s+/)[0];
      return ev.some((id) => { const it = idx[id]; const t = `${it?.title || ""} ${it?.summary || ""} ${it?.symbol || ""}`; return (sym && new RegExp(`\\b${sym.replace(/\./g, "\\.")}\\b`).test(t)) || (nm && nm.length > 2 && new RegExp(`\\b${nm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(t)); });
    };
    const near = (ev, date) => { if (!/^\d{4}-\d{2}/.test(date)) return true; return ev.some((id) => { const d = idx[id]?.date; if (!d) return true; return Math.abs(Date.parse(d) - Date.parse(date.length === 7 ? date + "-15" : date)) <= 75 * 864e5; }); };
    const rules = A(raw?.rules, 6, (r) => {
      const name = S(r.name, 120); const k = name.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!name || names.has(k)) return null; names.add(k);
      const nv = String(r.numeric_value ?? r.numericValue ?? "").split(/\s*[·;|]\s*/).map((x) => trim(x, 50)).filter((x) => /\d/.test(x)).slice(0, 6).join(" · ");
      const last = A(r.last_12_months ?? r.last12Months, 9, (e) => { const ev = Ev(e.evidence, 3); const t = S(e.event ?? e.text, 160); return t && ev.length && S(e.date, 10) <= ctx.today ? { date: S(e.date, 10), event: t, evidence: ev } : null; })
        .sort((a, b) => (a.date < b.date ? -1 : 1));
      const n12 = r.next_12_months ?? r.nextTwelveMonths ?? {};
      const next = A(n12.events, 7, (e) => { const ev = Ev(e.evidence, 3); const t = S(e.event, 200); return t && ev.length ? { date: S(e.date, 10), event: t, trigger: S(e.trigger, 240), evidence: ev } : null; })
        .sort((a, b) => (a.date < b.date ? -1 : 1));
      const examples = A(r.examples, 4, (e) => { const ev = Ev(e.evidence, 3); const co = S(e.company, 60); const date = S(e.date, 10);
        return co && ev.length && mentions(ev, co) && near(ev, date) ? { company: co, symbol: Tk([co])[0] || "", date, what: S(e.what, 300), impact: S(e.impact, 300), evidence: ev } : null; });
      return { name, citation: S(r.citation, 200), category: EN(r.category, CATEGORIES, "rule"), status: EN(r.status, STATUSES, "in_force"), effective: S(r.effective, 120), numeric_value: nv, severity: EN(r.severity, SEVERITY, "medium"),
        what_this_is: S(r.what_this_is ?? r.whatThisIs, 900), industry_impact: S(r.industry_impact ?? r.industryImpact, 1200), last_12_months: last, today: S(r.today, 700),
        next_12_months: { analysis: S(n12.analysis, 1800), events: next }, examples, bottom_line: words(S(r.bottom_line ?? r.bottomLine, 400), 35) };
    }).slice(0, 5);
    return { rules };
  }

  function cleanVerdict(raw, idx, doc, T) {
    const { S, Ev, Tk, A } = T.makeCritic(idx, T.tickersOf(doc));
    return {
      stance: EN(raw?.stance, ["headwind", "tailwind", "mixed", "neutral"], "mixed"), intensity: EN(raw?.intensity, SEVERITY, "medium"),
      headline: S(raw?.headline, 300), summary: S(raw?.summary, 1800),
      most_material: A(raw?.most_material, 5, (m) => (S(m.rule, 2) ? { body: S(m.body, 100), rule: S(m.rule, 140), why: S(m.why, 400), evidence: Ev(m.evidence, 4) } : null)),
      timeline: A(raw?.timeline, 10, (t) => (S(t.event, 3) && Ev(t.evidence, 3).length ? { date: S(t.date, 10), event: S(t.event, 200), body: S(t.body, 80), evidence: Ev(t.evidence, 3) } : null)).sort((a, b) => (a.date < b.date ? -1 : 1)),
      winners: A(raw?.winners, 5, (w) => { const s = Tk([w.symbol])[0]; return s ? { symbol: s, why: S(w.why, 260) } : null; }),
      losers: A(raw?.losers, 5, (w) => { const s = Tk([w.symbol])[0]; return s ? { symbol: s, why: S(w.why, 260) } : null; }),
      watch: (Array.isArray(raw?.watch) ? raw.watch : []).slice(0, 5).map((x) => S(x, 240)).filter(Boolean),
    };
  }

  // ------------------------------------------------------------------ fact-check
  const ABBR = /\b(U\.S|U\.K|E\.U|e\.g|i\.e|Inc|Corp|Co|Ltd|No|vs|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|Dept|Gov|St|Jr|Sr|approx|est|Fig|Sec|para|U\.S\.C|C\.F\.R|Pub|L)\./g;
  function sentences(text) {
    const prot = String(text || "").replace(ABBR, (m) => m.replace(/\./g, "§"));
    return prot.split(/(?<=[.!?])\s+(?=[A-Z0-9"“$(\[])/).map((s) => s.replace(/§/g, ".").trim()).filter(Boolean);
  }
  const isClaim = (s) => /\d|\[[A-Z]{1,2}\d/.test(s);
  const idsIn = (s) => [...String(s).matchAll(/\[([A-Z]{1,2}\d{1,4}(?:,\s*[A-Z]{1,2}\d{1,4})*)\]/g)].flatMap((m) => m[1].split(/,\s*/));

  /**
   * Turn a structure into checkable claims. Each claim: {id, text, ids, kind}
   * plus an apply(status, corrected) closure that edits the working copy.
   * kind "law" marks the rule's own legal text (citation, thresholds,
   * what-it-is), the only place background knowledge may stand in for a source.
   */
  function claimsFor(obj, spec) {
    const claims = []; const finals = [];
    const prose = (holder, key, kind, extraIds = []) => {
      const parts = sentences(holder[key]);
      parts.forEach((t, i) => { if (!isClaim(t)) return;
        claims.push({ text: t, ids: [...new Set([...idsIn(t), ...extraIds])], kind, apply: (st, fix) => { if (st === "unsupported") parts[i] = ""; else if (st === "corrected" && fix) parts[i] = fix; } }); });
      finals.push(() => { holder[key] = parts.filter(Boolean).join(" "); });
    };
    const item = (arr, i, key, kind) => { const it = arr[i]; const t = it[key]; if (!t || !isClaim(t) && !(it.evidence || []).length) return;
      claims.push({ text: t + (it.date ? ` (${it.date})` : ""), ids: [...new Set([...idsIn(t), ...(it.evidence || [])])], kind, apply: (st, fix) => { if (st === "unsupported") it.__drop = true; else if (st === "corrected" && fix) it[key] = fix; } }); };
    spec(prose, item);
    claims.forEach((c, i) => { c.id = "C" + (i + 1); });
    return { claims, finalize: () => { finals.forEach((f) => f()); dropMarked(obj); } };
  }
  function dropMarked(o) {
    if (Array.isArray(o)) { for (let i = o.length - 1; i >= 0; i--) { if (o[i] && o[i].__drop) o.splice(i, 1); else dropMarked(o[i]); } }
    else if (o && typeof o === "object") for (const v of Object.values(o)) dropMarked(v);
  }
  const bookSpec = (book) => (prose, item) => {
    for (const r of book.rules) {
      prose(r, "what_this_is", "law"); prose(r, "industry_impact", "analysis"); prose(r, "today", "analysis"); prose(r.next_12_months, "analysis", "analysis"); prose(r, "bottom_line", "analysis");
      r.last_12_months.forEach((_, i) => item(r.last_12_months, i, "event", "event"));
      r.next_12_months.events.forEach((_, i) => { item(r.next_12_months.events, i, "event", "event"); });
      r.examples.forEach((_, i) => { item(r.examples, i, "what", "event"); });
    }
  };
  const verdictSpec = (v) => (prose, item) => {
    prose(v, "summary", "analysis"); prose(v, "headline", "analysis");
    v.most_material.forEach((m) => prose(m, "why", "analysis", m.evidence));
    v.timeline.forEach((_, i) => item(v.timeline, i, "event", "event"));
  };

  function snippetOf(it) { return it ? `${it.title || ""}. ${it.summary || it.excerpt || ""}`.slice(0, 1600) : ""; }
  function factcheckPrompt(claims, idx, subject) {
    const used = [...new Set(claims.flatMap((c) => c.ids))].filter((id) => idx[id]);
    return `You are a fact-checker. Check each claim about ${subject} against the retrieved source text below. You have no other sources.

SOURCES
${used.map((id) => `[${id}] ${idx[id].date || ""} · ${idx[id].source || ""}: ${snippetOf(idx[id])}`).join("\n\n") || "(none)"}

CLAIMS (each lists the sources it cites)
${claims.map((c) => `${c.id} [${c.kind}] cites ${c.ids.join(", ") || "nothing"}: ${c.text}`).join("\n")}

For each claim return one label:
- "verified": a cited source states it. Give "quote": a verbatim passage (<= 25 words) copied exactly from that source, and "source": its ID.
- "corrected": a cited source supports a different figure, date or name. Give "fix": the corrected sentence (same style, keep its [ID] citations) and the supporting "quote" and "source".
- "background": ONLY for claims of kind "law" that state the instrument's own legal parameters (its statute or CFR section, the agency's authority, thresholds written in the rule, its effective date) which you are highly confident are accurate legal fact even though no retrieved source states them.
- "unsupported": anything else, including every company action, fine, deal, quote, earnings figure or date that the cited text does not state.
Reply with ONLY JSON: {"results": [{"id": "C1", "label": "verified", "quote": "...", "source": "RA3", "fix": ""}]}`;
  }
  const norm = (s) => String(s || "").toLowerCase().replace(/[“”"']/g, "").replace(/\s+/g, " ").trim();
  /** Apply fact-check results to a working copy. Unknown or unlabeled claims count as unsupported. */
  function applyFactcheck(work, claimSet, raw, idx) {
    const byId = Object.fromEntries((Array.isArray(raw?.results) ? raw.results : []).map((r) => [String(r?.id || "").toUpperCase(), r]));
    const sum = { checked: claimSet.claims.length, verified: 0, corrected: 0, background: 0, removed: 0, pending: 0 };
    const checks = [];
    for (const c of claimSet.claims) {
      const r = byId[c.id] || {};
      let label = ["verified", "corrected", "background", "unsupported"].includes(r.label) ? r.label : "unsupported";
      const src = String(r.source || "").toUpperCase(); const quote = trim(r.quote, 240);
      // A quote must really appear in the source it names; otherwise the label can't stand.
      if ((label === "verified" || label === "corrected") && !(idx[src] && quote && norm(snippetOf(idx[src])).includes(norm(quote).slice(0, 80)))) label = "unsupported";
      if (label === "background" && c.kind !== "law") label = "unsupported";
      if (label === "corrected" && !String(r.fix || "").trim()) label = "unsupported";
      c.apply(label, label === "corrected" ? trim(r.fix, 400) : null);
      sum[label === "unsupported" ? "removed" : label]++;
      checks.push({ id: c.id, text: trim(c.text, 300), label, quote: label === "verified" || label === "corrected" ? quote : "", source: label === "verified" || label === "corrected" ? src : "", fix: label === "corrected" ? trim(r.fix, 400) : "" });
    }
    claimSet.finalize();
    return { summary: sum, checks };
  }
  /** When the fact-check can't run: hold back every numeric claim (never shown as verified). */
  function holdBack(work, claimSet) {
    let pending = 0;
    for (const c of claimSet.claims) if (/\d/.test(c.text.replace(/\s\(\d{4}-\d{2}(-\d{2})?\)$/, "")) || c.kind === "event") { c.apply("unsupported"); pending++; }
    claimSet.finalize();
    return { summary: { checked: 0, verified: 0, corrected: 0, background: 0, removed: 0, pending }, checks: [] };
  }

  // When a rule book can't be built, nothing hand-written stands in: a clearly labelled notice does, and it is never kept.
  function genericFallback(body, reason) {
    const lv = (body.levers || []).join(", ") || "its rules and approvals";
    return { fallback: true, reason, rules: [{ name: `Live retrieval failed for ${body.name}`, citation: "", category: "rule", status: "in_force", effective: "", numeric_value: "", severity: "medium",
      what_this_is: `The rule book for ${body.name} could not be built from retrieved sources this time, so nothing here is verified.`,
      industry_impact: `The likely transmission channels are the body's levers (${lv}): through them it can change revenue (market access, volumes), pricing and margin (rates, fees, compliance cost) or capex (approvals, mandates).`,
      today: body.current || "", last_12_months: [], next_12_months: { analysis: "", events: [] }, examples: [], bottom_line: "Rebuild this rule book to get the specific, cited instruments." }], sources: [] };
  }

  const RegBook = { CATEGORIES, STATUSES, SEVERITY, SECTIONS, MAX_SOURCES, bodyKey, prefixFor, bodyMatcher, preSearch, buildTools, bookPrompt, listPrompt, rulePrompt, repairJson, verdictPrompt, cleanBook, cleanVerdict,
    sentences, claimsFor, bookSpec, verdictSpec, factcheckPrompt, applyFactcheck, holdBack, genericFallback };
  if (typeof module !== "undefined" && module.exports) module.exports = RegBook;
  else root.RegBook = RegBook;
})(typeof window !== "undefined" ? window : globalThis);
