/**
 * Rule books, made fuller without rebuilding them (GitHub, Daily update with repair=true and refresh=true).
 *
 * The fact-check removed about 38% of rule-book claims, mostly because the checker only saw the financial news the
 * book was built from: not the industry's own company table, not the earnings calendar, not the rules themselves.
 * For each rule book:
 *   1. Every removed claim is checked again against a wider pack: the book's sources, the industry's company table and
 *      earnings/economic calendar, the industry's news and call quotes that match it, and for US federal agencies the
 *      Federal Register and the eCFR (the official text of the rules). Claims it now supports go back where they were.
 *   2. What still can't be supported is rewritten on the same point from what the sources do say (or left out), and each
 *      rule gets up to 3 new sourced facts (legal parameters, recent agency actions, dates, company exposure).
 *   3. Every replacement and addition is fact-checked the same way (a verbatim quote must be in the source it names).
 * Code only here; the page fetches and makes the calls.
 */
(function (root) {
  "use strict";
  const RB = typeof RegBook !== "undefined" ? RegBook : typeof require === "function" ? require("./regbook.js") : null;
  const norm = (s) => String(s ?? "").toLowerCase().replace(/[“”"'’‘]/g, "").replace(/\s+/g, " ").trim();
  const ckey = (s) => norm(s).replace(/…$/, "").slice(0, 290);
  const one = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const snippetOf = (it) => (it ? `${it.title || ""}. ${it.summary || it.excerpt || ""}`.slice(0, 1600) : "");
  const LABELS = ["verified", "corrected", "background", "analysis", "unsupported"];

  // US federal agencies (the Federal Register and the eCFR cover them); state and foreign bodies are left out.
  const US_RE = /\b(SEC|FDA|EPA|FTC|DOE|CMS|USTR|BIS|FERC|FCC|DOJ|OSHA|NHTSA|FAA|CFPB|OCC|FDIC|Federal Reserve|Fed|Treasury|IRS|Commerce|CBP|USDA|DOT|NRC|HHS|PHMSA|DEA|FRA|FMCSA|MSHA|BOEM|BSEE|BLM|FinCEN|OFAC|NCUA|FHFA|CFTC|FINRA|USPTO|USITC|ITC|DOL|NLRB|EEOC|HUD|FEMA|TSA|FMC|STB|ATF|TTB|FSIS|APHIS|CPSC|NIST|DOI|EIA|NOAA|FWS|Army Corps|U\.S\.|United States)\b/;
  const NOT_US = /\b(EU|European|China|Chinese|PRC|UK|British|Japan|Canada|Canadian|Mexico|India|Korea|Australia|Brazil|Peru|Chile|Germany|France|Netherlands|Taiwan|State AGs?|state attorneys|California|Texas|New York State|NAIC|provincial|Ontario|Quebec)\b/i;
  const isUS = (body) => US_RE.test(String(body || "")) && !NOT_US.test(String(body || ""));
  /** "40 CFR Part 63" / "21 C.F.R. § 314.50" -> [{title: 40, part: 63}] */
  function cfrRefs(text) {
    const out = [], seen = new Set();
    for (const m of String(text || "").matchAll(/\b(\d{1,2})\s*C\.?\s?F\.?\s?R\.?\s*(?:Parts?|§+|Sec(?:tion|s)?\.?)?\s*(\d{1,4})/gi)) { const k = `${m[1]}/${m[2]}`; if (!seen.has(k)) { seen.add(k); out.push({ title: +m[1], part: +m[2] }); } }
    return out.slice(0, 3);
  }
  const keywords = (s) => one(String(s || "").replace(/\([^)]*\)/g, " ").replace(/[^\w\s&-]/g, " ")).split(" ").filter((w) => w.length > 2 && !/^(the|and|for|with|from|under|rule|rules|act|of|on|in|to|its|this|that|final|proposed)$/i.test(w)).slice(0, 7).join(" ");

  /** Federal Register search URL for one rule (most relevant documents, the fields a fact-check needs). */
  function frUrl(rule, body) {
    const term = keywords(`${rule.name} ${String(body || "").split(/[—–-]/)[0]}`);
    const f = ["title", "abstract", "publication_date", "effective_on", "comments_close_on", "html_url", "type", "cfr_references", "agencies", "document_number"].map((x) => `fields[]=${x}`).join("&");
    return `https://www.federalregister.gov/api/v1/documents.json?per_page=4&order=relevance&conditions[term]=${encodeURIComponent(term)}&${f}`;
  }
  function frItems(json, idOf) {
    return (json?.results || []).filter((r) => r?.html_url).map((r) => ({ id: idOf(), kind: "F", date: String(r.publication_date || "").slice(0, 10), source: "Federal Register", url: r.html_url,
      title: one(`${r.type || "Document"} ${r.document_number || ""}: ${r.title || ""}`),
      summary: one(`${(r.agencies || []).map((a) => a.name || a.raw_name).filter(Boolean).join(", ")}. Published ${r.publication_date || "n/a"}${r.effective_on ? `; effective ${r.effective_on}` : ""}${r.comments_close_on ? `; comments close ${r.comments_close_on}` : ""}${(r.cfr_references || []).length ? `; CFR: ${(r.cfr_references || []).map((c) => `${c.title} CFR ${c.part || ""}`).join(", ")}` : ""}. ${r.abstract || ""}`).slice(0, 1500) }));
  }
  function ecfrUrl(ref, rule) {
    return `https://www.ecfr.gov/api/search/v1/results?query=${encodeURIComponent(keywords(rule.name) || rule.name)}&hierarchy[title]=${ref.title}&hierarchy[part]=${ref.part}&per_page=3`;
  }
  function ecfrItems(json, ref, idOf) {
    const strip = (s) => one(String(s || "").replace(/<[^>]+>/g, ""));
    return (json?.results || []).map((r) => { const h = r.hierarchy || {}, hh = r.headings || r.hierarchy_headings || {};
      const sec = h.section ? `§ ${h.section}` : `Part ${h.part || ref.part}`;
      return { id: idOf(), kind: "F", date: String(r.starts_on || "").slice(0, 10), source: "eCFR (official text of the rule)", url: `https://www.ecfr.gov/current/title-${h.title || ref.title}${h.section ? `/section-${h.section}` : `/part-${h.part || ref.part}`}`,
        title: one(`${h.title || ref.title} CFR ${sec}: ${strip(hh.section || hh.part || "")}`), summary: strip(r.full_text_excerpt).slice(0, 1500) }; }).filter((x) => x.summary);
  }

  /** The industry's own data as citable sources: the company table and the dated calendar (earnings, economic data). */
  function dataItems(companiesText, calendar, idOf) {
    const out = [], lines = String(companiesText || "").split("\n");
    const head = lines.shift() || "";
    for (let i = 0; i < lines.length; i += 12) out.push({ id: idOf(), kind: "D", date: "", source: "the industry's company data (FMP)", title: `Company table${lines.length > 12 ? ` (part ${i / 12 + 1})` : ""}`, summary: [head, ...lines.slice(i, i + 12)].join("\n").slice(0, 1500) });
    const ev = (calendar?.events || []).filter((e) => e && (e.kind === "earnings" || e.section === "macro")).map((e) => `${(e.dates || [])[0] || ""}: ${one(e.title)}${e.detail ? ` (${one(e.detail)})` : ""}`);
    for (let i = 0; i < ev.length; i += 20) out.push({ id: idOf(), kind: "D", date: "", source: "the industry's calendar (FMP)", title: "Earnings dates and economic calendar", summary: ev.slice(i, i + 20).join("\n").slice(0, 1500) });
    return out;
  }
  /** News and call quotes from the industry that share the most words with the removed claims (code retrieval). */
  function related(items, claims, max = 20) {
    const toks = (s) => new Set(norm(s).replace(/[^a-z0-9 ]/g, " ").split(" ").filter((w) => w.length > 3));
    const scored = new Map();
    for (const c of claims) { const ct = toks(c.text); if (ct.size < 3) continue;
      for (const it of items) { const it2 = toks(`${it.title || ""} ${it.summary || it.excerpt || ""}`); let n = 0; for (const w of ct) if (it2.has(w)) n++; if (n >= 3) scored.set(it, Math.max(scored.get(it) || 0, n / ct.size)); } }
    return [...scored.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([it]) => it);
  }

  // ------------------------------------------------------------------ where each removed claim lived
  function locate(raw) {
    const out = new Map();
    for (const [ri, r] of (raw?.rules || []).entries()) {
      const prose = (holder, key, kind, field) => { const parts = RB.sentences(holder?.[key]); parts.forEach((t, i) => { out.set(ckey(t), { type: "prose", rule: r.name, ri, field, kind, prev: parts.slice(0, i).reverse() }); }); };
      prose(r, "what_this_is", "law", "what_this_is"); prose(r, "industry_impact", "analysis", "industry_impact"); prose(r, "today", "analysis", "today");
      prose(r.next_12_months || {}, "analysis", "analysis", "next_12_months.analysis"); prose(r, "bottom_line", "analysis", "bottom_line");
      const items = (arr, key, list) => (arr || []).forEach((it) => { if (!it?.[key]) return; out.set(ckey(it[key] + (it.date ? ` (${it.date})` : "")), { type: "item", rule: r.name, ri, list, key, kind: "event", item: it }); });
      items(r.last_12_months, "event", "last_12_months"); items(r.next_12_months?.events, "event", "next_12_months.events"); items(r.examples, "what", "examples");
    }
    return out;
  }
  // The saved book's rule names can be shortened copies of the original's: match whole, then by their start, then by place.
  function ruleOf(book, name, at = -1) {
    const rs = book?.rules || [], n = norm(String(name || "").replace(/…$/, ""));
    return rs.find((r) => norm(r.name) === n) || rs.find((r) => { const m = norm(String(r.name || "").replace(/…$/, "")); return m.length >= 20 && n.length >= 20 && (m.startsWith(n.slice(0, 30)) || n.startsWith(m.slice(0, 30))); }) || (at >= 0 ? rs[at] : null) || null;
  }
  function field(rule, f) { if (f === "next_12_months.analysis") { rule.next_12_months ||= { analysis: "", events: [] }; return [rule.next_12_months, "analysis"]; } return [rule, f]; }
  /** A sentence back into its field, right after the sentence that came before it (or first). */
  function putSentence(rule, f, text, prev = []) {
    const [h, k] = field(rule, f), parts = RB.sentences(h[k] || "");
    if (parts.some((p) => norm(p) === norm(text))) return false;
    let at = prev.length ? 0 : parts.length;
    for (const p of prev) { const i = parts.findIndex((x) => norm(x) === norm(p)); if (i >= 0) { at = i + 1; break; } }
    parts.splice(at, 0, one(text)); h[k] = parts.join(" "); return true;
  }
  function listOf(rule, list) { if (list === "next_12_months.events") { rule.next_12_months ||= { analysis: "", events: [] }; return (rule.next_12_months.events ||= []); } return (rule[list] ||= []); }
  function putItem(rule, list, item) {
    const arr = listOf(rule, list), k = list === "examples" ? "what" : "event";
    if (arr.some((x) => norm(x?.[k]) === norm(item[k]))) return false;
    const { __drop, ...clean } = item; arr.push(clean); arr.sort((a, b) => String(a.date || "").localeCompare(String(b.date || ""))); return true;
  }

  // ------------------------------------------------------------------ prompts
  const srcLine = (it) => `[${it.id}] ${it.date || ""} · ${it.source || ""}: ${snippetOf(it).slice(0, 600)}`;
  function checkPrompt(claims, items, subject) {
    return `You are a fact-checker. Check each claim about ${subject} against the source text below: the regulator's documents (Federal Register, eCFR), the industry's company data and calendar, and news. Any source may support any claim. You have no other sources.

SOURCES
${items.map(srcLine).join("\n\n") || "(none)"}

CLAIMS
${claims.map((c) => `${c.id} [${c.kind}]: ${c.text}`).join("\n")}

For each claim return one label:
- "verified": a source states it. Give "quote": a verbatim passage (<= 25 words) copied exactly from that source, and "source": its ID.
- "corrected": a source supports a different figure, date or name. Give "fix": the corrected sentence (same style), the supporting "quote" and "source".
- "background": ONLY for claims of kind "law" that state the instrument's own legal parameters (statute or CFR section, the agency's authority, thresholds written in the rule, its effective date) that you are highly confident are accurate legal fact.
- "analysis": ONLY for claims of kind "analysis" that are reasoning (what it means, why it matters, what could happen) and assert no specific figure, date, quote, ruling, deal or company action as fact.
- "unsupported": anything else.
Reply with ONLY JSON: {"results": [{"id": "U1", "label": "verified", "quote": "...", "source": "FR3", "fix": ""}]}`;
  }
  function enrichPrompt({ subject, body, book, failed, items }) {
    const rules = (book?.rules || []).map((r, i) => `RULE ${i + 1}: ${r.name} (${r.citation || "no citation"}; ${r.status || ""}${r.effective ? `; effective ${r.effective}` : ""})
  what it is: ${one(r.what_this_is)}
  industry impact: ${one(r.industry_impact)}
  today: ${one(r.today)}
  last 12 months: ${(r.last_12_months || []).map((e) => `${e.date} ${one(e.event)}`).join(" | ") || "none"}
  next 12 months: ${one(r.next_12_months?.analysis)} Events: ${(r.next_12_months?.events || []).map((e) => `${e.date} ${one(e.event)}`).join(" | ") || "none"}`).join("\n\n");
    return `You are the regulatory analyst who wrote this rule book for ${body}, as it applies to ${subject}. Some sentences were taken out because no source supported them, and some entries are thin. Use ONLY the sources below.

THE RULE BOOK NOW
${rules}

SENTENCES TAKEN OUT (rewrite each on the same point)
${failed.map((c) => `${c.id} (rule ${c.rule}, ${c.where}): ${c.text}`).join("\n") || "(none)"}

SOURCES
${items.map(srcLine).join("\n\n") || "(none)"}

Do two things:
1. REPLACE: for each sentence taken out, write one sentence on the same point that the sources do support, citing them as [ID]. If the sources show it was wrong, write the correct version. If nothing in the sources speaks to that point, return "" for it.
2. ADD: for each rule, up to 3 facts the entry doesn't already state, taken from the sources: its legal parameters (CFR section, effective or compliance date, comment deadline, threshold, penalty), recent agency actions with their dates, or which companies in the company table it hits and how much they weigh. One plain-English sentence each, citing [ID]. A dated agency action or deadline goes in "last_12_months" (past) or "next_events" (ahead) with its date.
Rules: every figure, date, name and action must be in a source you cite; no opinions as fact; plain English; full sentences.
Reply with ONLY JSON: {"replacements": [{"id": "U1", "text": "..."}], "additions": [{"rule": 1, "section": "what_this_is | industry_impact | today | next_12_months | last_12_months | next_events", "text": "...", "date": "YYYY-MM-DD or empty", "evidence": ["FR2"]}]}`;
  }

  /** One check answer, held to the same rules as the rule book's own fact-check. */
  function judge(r, kind, idx, allow = ["verified", "corrected", "background", "analysis"]) {
    let label = LABELS.includes(r?.label) ? r.label : "unsupported";
    const src = String(r?.source || "").toUpperCase(), quote = one(r?.quote).slice(0, 240), fix = one(r?.fix);
    if ((label === "verified" || label === "corrected") && !(idx[src] && quote && norm(snippetOf(idx[src])).includes(norm(quote).slice(0, 80)))) label = "unsupported";
    if (label === "background" && kind !== "law") label = "unsupported";
    if (label === "analysis" && kind !== "analysis") label = "unsupported";
    if (label === "corrected" && !fix) label = "unsupported";
    if (!allow.includes(label)) label = "unsupported";
    const sourced = label === "verified" || label === "corrected";
    return { label, quote: sourced ? quote : "", source: sourced ? src : "", fix: label === "corrected" ? fix : "" };
  }
  const SECTION = { what_this_is: ["what_this_is", "law"], industry_impact: ["industry_impact", "analysis"], today: ["today", "analysis"], next_12_months: ["next_12_months.analysis", "analysis"] };

  /**
   * One rule book, fuller. doc: the saved rule book doc; items: the extra sources; calls: { check(prompt), enrich(prompt) }
   * (each returns parsed JSON). Returns { doc, restored, replaced, added, checked } or null when there was nothing to do.
   */
  async function enrich(doc, items, calls, { subject, body, max = 80 } = {}) {
    if (!doc?.book?.rules?.length || !Array.isArray(doc.checks)) return null;
    const removed = doc.checks.filter((c) => c.label === "unsupported");
    if (!removed.length && !items.length) return null;
    const book = JSON.parse(JSON.stringify(doc.book)), where = locate(doc.raw || doc.book);
    const pool = [...(doc.sources || []), ...items], idx = Object.fromEntries(pool.map((x) => [String(x.id).toUpperCase(), x]));
    const todo = removed.slice(0, max).map((c, i) => ({ id: "U" + (i + 1), text: c.text, check: c, at: where.get(ckey(c.text)) || null })).filter((x) => x.at);
    const checks = doc.checks.map((c) => ({ ...c }));
    const byText = new Map(checks.map((c) => [ckey(c.text), c]));
    let restored = 0, replaced = 0, added = 0, asked = 0;
    const put = (x, text, extra = {}) => { const r = ruleOf(book, x.at.rule, (doc.raw?.rules || []).length === book.rules.length ? x.at.ri : -1); if (!r) return false;
      if (x.at.type === "prose") return putSentence(r, x.at.field, text, x.at.prev);
      const it = { ...x.at.item, [x.at.key]: text.replace(/\s\(\d{4}-\d{2}(-\d{2})?\)$/, ""), ...extra }; return putItem(r, x.at.list, it); };
    // 1. Check again against the wider pack.
    if (todo.length) {
      const res = await calls.check(checkPrompt(todo.map((x) => ({ id: x.id, kind: x.at.kind, text: x.text })), pool, subject)); asked++;
      const got = Object.fromEntries((res?.results || []).map((r) => [String(r?.id || "").toUpperCase(), r]));
      for (const x of todo) {
        const j = judge(got[x.id], x.at.kind, idx); x.j = j; if (j.label === "unsupported") continue;
        const text = j.label === "corrected" ? j.fix : x.text;
        if (put(x, text)) { restored++; Object.assign(byText.get(ckey(x.text)) || {}, j); }
        else x.j = { label: "unsupported" };
      }
    }
    // 2. What's still out is rewritten from the sources; each rule gets up to 3 new sourced facts.
    const failed = todo.filter((x) => x.j?.label === "unsupported").map((x) => ({ ...x, where: x.at.type === "prose" ? x.at.field.replace("next_12_months.analysis", "next 12 months") : x.at.list.replace(/_/g, " ") }));
    failed.forEach((x) => { x.rule = (book.rules || []).indexOf(ruleOf(book, x.at.rule, (doc.raw?.rules || []).length === book.rules.length ? x.at.ri : -1)) + 1; });
    const en = await calls.enrich(enrichPrompt({ subject, body, book, failed, items: pool })); asked++;
    const reps = Object.fromEntries((en?.replacements || []).map((r) => [String(r?.id || "").toUpperCase(), one(r?.text)]));
    const cand = [];
    for (const x of failed) if (reps[x.id]) cand.push({ id: "R" + (cand.length + 1), kind: x.at.kind, text: reps[x.id], x });
    for (const a of (en?.additions || []).slice(0, 18)) {
      const r = book.rules?.[Number(a?.rule) - 1]; const text = one(a?.text); if (!r || !text) continue;
      const sec = String(a.section || "").trim(), dated = sec === "last_12_months" || sec === "next_events";
      if (!dated && !SECTION[sec]) continue;
      cand.push({ id: "R" + (cand.length + 1), kind: dated ? "event" : SECTION[sec][1], text: dated && a.date ? `${text} (${a.date})` : text, add: { rule: r, sec, dated, date: String(a.date || "").slice(0, 10), text, evidence: (a.evidence || []).map((e) => String(e).toUpperCase()).filter((e) => idx[e]) } });
    }
    // 3. Every new sentence is fact-checked the same way; only sourced ones stand (additions must be verified or corrected).
    if (cand.length) {
      // Only the sources the new sentences cite (and the company data), so this check stays small.
      const want = new Set(cand.flatMap((c) => [...String(c.text).matchAll(/[A-Z]{1,2}\d{1,4}/g)].map((m) => m[0]).concat(c.add?.evidence || [])));
      const few = pool.filter((x) => want.has(String(x.id).toUpperCase()) || x.kind === "D");
      const res = await calls.check(checkPrompt(cand.map((c) => ({ id: c.id, kind: c.kind, text: c.text })), few.length ? few : pool, subject)); asked++;
      const got = Object.fromEntries((res?.results || []).map((r) => [String(r?.id || "").toUpperCase(), r]));
      for (const c of cand) {
        const j = judge(got[c.id], c.kind, idx, c.add ? ["verified", "corrected"] : undefined); if (j.label === "unsupported") continue;
        const text = j.label === "corrected" ? j.fix : c.text;
        if (c.x) { // a replacement: shown where the old sentence was; the log keeps the old one with what replaced it
          if (put(c.x, text)) { replaced++; Object.assign(byText.get(ckey(c.x.text)) || {}, { label: "corrected", fix: text, quote: j.quote, source: j.source }); }
        } else {
          const a = c.add, body = text.replace(/\s\(\d{4}-\d{2}(-\d{2})?\)$/, "");
          const ok = a.dated ? putItem(a.rule, a.sec === "last_12_months" ? "last_12_months" : "next_12_months.events", { date: a.date, event: body, evidence: [...new Set([j.source, ...a.evidence])].filter(Boolean), ...(a.sec === "next_events" ? { trigger: "" } : {}) })
            : putSentence(a.rule, SECTION[a.sec][0], body.includes("[") ? body : body.replace(/([.!?])?$/, ` [${j.source}]$1`).replace(/ \[([A-Z]{1,2}\d+)\]$/, " [$1]."));
          if (ok) { added++; checks.push({ id: "C" + (checks.length + 1), text: body, label: j.label, quote: j.quote, source: j.source, fix: j.fix, added: true }); }
        }
      }
    }
    const sum = { checked: checks.length, verified: 0, corrected: 0, background: 0, analysis: 0, removed: 0, pending: 0 };
    for (const c of checks) sum[c.label === "unsupported" ? "removed" : c.label] = (sum[c.label === "unsupported" ? "removed" : c.label] || 0) + 1;
    // Keep the new sources a check or the text now cites.
    const cited = new Set(checks.map((c) => c.source).filter(Boolean)); JSON.stringify(book).replace(/\[([A-Z]{1,2}\d{1,4}(?:,\s*[A-Z]{1,2}\d{1,4})*)\]/g, (m, g) => { g.split(/,\s*/).forEach((x) => cited.add(x)); return m; });
    for (const r of book.rules || []) for (const e of [...(r.last_12_months || []), ...(r.next_12_months?.events || [])]) for (const x of e.evidence || []) cited.add(String(x).toUpperCase());
    const keepNew = items.filter((x) => cited.has(String(x.id).toUpperCase()));
    return { doc: { ...doc, book, checks, fact_check: sum, sources: [...(doc.sources || []), ...keepNew], enriched: { date: new Date().toISOString().slice(0, 10), restored, replaced, added } }, restored, replaced, added, asked };
  }

  const RbFix = { isUS, cfrRefs, frUrl, frItems, ecfrUrl, ecfrItems, dataItems, related, locate, putSentence, putItem, checkPrompt, enrichPrompt, judge, enrich, ckey };
  if (typeof module !== "undefined" && module.exports) module.exports = RbFix;
  else root.RbFix = RbFix;
})(typeof window !== "undefined" ? window : globalThis);
