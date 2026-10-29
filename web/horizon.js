/* Industry Scorer: Calls by horizon (1M, 3M, 6M, 12M).
 *
 * The lead strategist's horizon calls must rest on everything the run found, so code first builds:
 *   - a CALENDAR of every dated thing ahead (central-bank decisions, elections and major data from the
 *     economic calendar, the largest companies' earnings, rule-book deadlines, pending policy, court
 *     dates, KPI triggers, the macro team's watch list), each with an ID (C1, C2 ...) and the window it
 *     falls in; recurring events (every FOMC meeting) share one ID with all their dates;
 *   - the STANDING situations that hang over every window (wars and conflicts, invasion and blockade
 *     threats, critical supply bottlenecks, high-severity rules in force, the regulatory verdict, pending
 *     litigation and deals, the macro regime), each with an ID (S1, S2 ...);
 *   - HORIZON FACTS: a one-sigma move per window from the index's own volatility, the trailing return over
 *     the same length, and which of the largest companies report inside the window.
 * The strategist then writes each horizon with a read for every section, every important decision in the
 * window and every war, conflict and threat, and code checks the coverage and the numbers.
 */
(function (root) {
  "use strict";
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const trim = (s, n) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

  const HORIZONS = [["1M", 1], ["3M", 3], ["6M", 6], ["12M", 12]];
  const DAYS = { "1M": 30, "3M": 91, "6M": 182, "12M": 365 };
  const ORDER = ["1M", "3M", "6M", "12M"];
  const addDays = (iso, n) => { const t = new Date(String(iso).slice(0, 10) + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  /** "2026-11-18", "2026-11-18 14:00" -> "2026-11-18"; "2027-01" -> "2027-01-15" for windowing; anything else -> null. */
  function normDate(d) {
    const s = String(d || "").trim();
    let m = /^(\d{4}-\d{2}-\d{2})/.exec(s); if (m) return m[1];
    m = /^(\d{4}-\d{2})$/.exec(s); if (m) return m[1] + "-15";
    return null;
  }
  /** The first window a date falls in, or "later" / null (past or undated). */
  function windowOf(date, today) {
    const d = normDate(date); if (!d || d < today) return null;
    for (const h of ORDER) if (d <= addDays(today, DAYS[h])) return h;
    return "later";
  }
  const inWindow = (w, h) => w && w !== "later" && ORDER.indexOf(w) <= ORDER.indexOf(h);

  // ---------------------------------------------------------------- horizon facts
  function indexVol(doc) {
    const lv = (doc.index?.levels || []).filter(isNum).slice(-253);
    const r = []; for (let i = 1; i < lv.length; i++) if (lv[i - 1] > 0 && lv[i] > 0) r.push(Math.log(lv[i] / lv[i - 1]));
    if (r.length < 60) return null;
    const m = r.reduce((a, x) => a + x, 0) / r.length;
    return Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / (r.length - 1)) * Math.sqrt(252);
  }
  function horizonFacts(doc, today) {
    const s = doc.summary || {}, vol = indexVol(doc);
    const cons = (doc.constituents || []).filter((c) => c.next && String(c.next) >= today).sort((a, b) => (b.weight || 0) - (a.weight || 0));
    return HORIZONS.map(([h, m]) => {
      const end = addDays(today, DAYS[h]), w = m === 12 ? "1Y" : h;
      const rep = cons.filter((c) => String(c.next) <= end);
      return { h, months: m, end, sigma: isNum(vol) ? Math.round(vol * Math.sqrt(m / 12) * 1000) / 10 : null,
        trailing: isNum(s[`ret_cw_${w}`]) ? Math.round(s[`ret_cw_${w}`] * 1000) / 10 : null, vs_spy: isNum(s[`excess_cw_${w}`]) ? Math.round(s[`excess_cw_${w}`] * 1000) / 10 : null,
        breadth: isNum(s[`breadth_${w}`]) ? Math.round(s[`breadth_${w}`] * 100) : null,
        reporting: rep.slice(0, 8).map((c) => ({ symbol: c.symbol, date: String(c.next).slice(0, 10), weight: Math.round((c.weight || 0) * 1000) / 10 })),
        reporting_weight: Math.round(rep.reduce((a, c) => a + (c.weight || 0), 0) * 100),
        base_up: isNum(doc.history?.base_prob_up?.[h]) ? Math.round(doc.history.base_prob_up[h] * 100) : null };
    });
  }
  const factsLine = (f) => `${f.h} (to ${f.end}): one-sigma move ±${f.sigma ?? "n/a"}% from the index's own volatility; trailing ${f.h} return ${f.trailing ?? "n/a"}% (${f.vs_spy ?? "n/a"}% vs SPY, ${f.breadth ?? "n/a"}% of companies beat SPY); ${f.base_up !== null && f.base_up !== undefined ? `base-rate chance the industry is higher at the end of this window, from the most similar past setups: ${f.base_up}%; ` : ""}reporting earnings in the window: ${f.reporting.length ? f.reporting.map((r) => `${r.symbol} ${r.date} (${r.weight}% weight)`).join(", ") + ` = ${f.reporting_weight}% of the industry` : "none of the largest"}.`;

  // ---------------------------------------------------------------- economic calendar
  // Countries pulled from the forward economic calendar: the US, the big blocs, and the industry's top trade partners.
  const CAL_CODES = { "United States": "US", "Euro Area": "EU", "European Union": "EU", China: "CN", Japan: "JP", "United Kingdom": "GB", Taiwan: "TW", "South Korea": "KR", Korea: "KR",
    Germany: "DE", France: "FR", Netherlands: "NL", Mexico: "MX", Canada: "CA", India: "IN", Brazil: "BR", Australia: "AU", Switzerland: "CH", Israel: "IL", Russia: "RU", "Saudi Arabia": "SA", Singapore: "SG", Vietnam: "VN", Malaysia: "MY", Ireland: "IE", Italy: "IT", Spain: "ES" };
  function calendarCountries(tradeMap) {
    const base = ["US", "EU", "CN", "JP", "GB"];
    const extra = (tradeMap?.countries || []).slice(0, 8).map((c) => CAL_CODES[c.country]).filter(Boolean);
    return [...new Set([...base, ...extra])].slice(0, 9);
  }
  const DECISION_RE = /interest rate decision|rate decision|monetary policy (decision|statement)|election|referendum|budget (release|statement|speech)|opec|g7|g20|summit|debt ceiling|government shutdown|tariff/i;
  const US_KEY_RE = /^(fed interest rate decision|cpi|core cpi|inflation rate|non farm payrolls|nonfarm payrolls|core pce|pce price index|gdp growth rate|unemployment rate|retail sales|ism manufacturing pmi|ism services pmi|ppi)\b/i;
  /** Raw FMP calendar rows (any countries) -> grouped series [{key, country, event, dates[], kind, importance}]. */
  function econEvents(rows, today, { tradeCountries = [] } = {}) {
    const series = new Map();
    for (const r of rows || []) {
      const d = normDate(r?.date); if (!d || d < today || d > addDays(today, 366)) continue;
      const ev = String(r.event || "").replace(/\s*\((?:[A-Z][a-z]{2}|Q\d)[^)]*\)\s*$/, "").replace(/\s+(MoM|YoY|QoQ)$/i, " $1").trim();
      const cc = String(r.country || "");
      const decision = DECISION_RE.test(ev) && !/projection|minutes|speech|testimony/i.test(ev);
      const high = String(r.impact) === "High";
      if (!decision && !(cc === "US" && high)) continue;
      if (/projection|press conference|economic projections/i.test(ev) && !decision) continue;
      const usKey = cc === "US" && US_KEY_RE.test(ev);
      const importance = (cc === "US" && /rate decision/i.test(ev)) || /election|referendum|debt ceiling|shutdown/i.test(ev) ? "high"
        : decision && (["EU", "CN", "JP"].includes(cc) || tradeCountries.includes(cc)) ? "medium" : usKey ? "medium" : "low";
      const key = `${cc}|${ev.replace(/\s+(MoM|YoY|QoQ)$/i, "")}`;
      const s = series.get(key) || { key, country: cc, event: ev.replace(/\s+(MoM|YoY|QoQ)$/i, ""), dates: [], kind: decision ? "decision" : "data", importance };
      if (!s.dates.includes(d)) s.dates.push(d);
      series.set(key, s);
    }
    const rank = { high: 0, medium: 1, low: 2 };
    return [...series.values()].map((s) => ({ ...s, dates: s.dates.sort() }))
      .filter((s) => s.importance !== "low" || s.kind === "decision")
      .sort((a, b) => rank[a.importance] - rank[b.importance] || (a.dates[0] < b.dates[0] ? -1 : 1)).slice(0, 40);
  }

  // ---------------------------------------------------------------- the calendar and the standing situations
  /**
   * ctx: { today, econ (econEvents output), pack, reports: {kpi, macro, world, trade, reg}, books: [{body, book}], regVerdict }
   * Returns { events: [{id, dates[], window, section, kind, title, detail, importance, refs}], standing: [{id, section, kind, title, status, detail, importance, refs}] }
   */
  function buildCalendar(doc, ctx) {
    const today = ctx.today, R = ctx.reports || {};
    const events = [], standing = [];
    const ev = (o) => {
      const dates = [...new Set((o.dates || []).map(normDate).filter((d) => d && d >= today))].sort();
      if (!dates.length) return;
      const w = windowOf(dates[0], today); if (!w) return;
      events.push({ ...o, dates, raw_dates: o.raw_dates || o.dates, window: w, title: trim(o.title, 160), detail: trim(o.detail, 260), refs: (o.refs || []).slice(0, 4) });
    };
    const st = (o) => standing.push({ ...o, title: trim(o.title, 160), detail: trim(o.detail, 420), refs: (o.refs || []).slice(0, 4) });
    // Economic calendar: central-bank decisions, elections, major data
    for (const s of ctx.econ || []) ev({ section: "macro", kind: s.kind, title: `${s.country} ${s.event}`, detail: s.dates.length > 1 ? `${s.dates.length} dates in the next 12 months` : "", importance: s.importance, dates: s.dates });
    // The largest companies' earnings
    const wt = Object.fromEntries((doc.constituents || []).map((c) => [c.symbol, c.weight || 0]));
    const cons = [...(doc.constituents || [])].filter((c) => c.next).sort((a, b) => (b.weight || 0) - (a.weight || 0)).slice(0, 15);
    for (const c of cons) if ((c.weight || 0) >= 0.01) ev({ section: "fundamentals", kind: "earnings", title: `${c.symbol} earnings (${((c.weight || 0) * 100).toFixed(1)}% of the industry)`, importance: c.weight >= 0.1 ? "high" : c.weight >= 0.03 ? "medium" : "low", dates: [c.next], tickers: [c.symbol] });
    // KPI analyst's next triggers
    for (const t of R.kpi?.next_triggers || []) { const big = (t.names || []).some((s) => (wt[s] || 0) >= 0.1);
      // A trigger that is one of the largest companies' earnings joins that event rather than repeating it.
      const d = normDate(t.date), same = d && events.find((e) => e.kind === "earnings" && (t.names || []).some((n) => e.tickers?.includes(n)) && Math.abs(Date.parse(e.dates[0]) - Date.parse(d)) <= 3 * 864e5);
      if (same) { same.detail = trim(`${same.detail ? same.detail + " " : ""}${t.event}: ${t.why || ""}`, 260); continue; }
      ev({ section: "kpi", kind: "trigger", title: t.event, detail: t.why, importance: big ? "high" : "medium", dates: [t.date], tickers: t.names }); }
    // Macro team's watch list
    for (const t of R.macro?.watch_next || []) ev({ section: "macro", kind: "data", title: t.event, detail: t.why, importance: "medium", dates: [t.date] });
    // Rule books: dated deadlines, rulemakings, hearings
    for (const b of ctx.books || []) for (const r of b.book?.rules || []) for (const e of r.next_12_months?.events || [])
      ev({ section: "regulation", kind: "rule", title: `${b.body}: ${e.event}`, detail: `${r.name} (${r.severity} severity). ${e.trigger || ""}`, importance: r.severity === "high" ? "high" : r.severity === "medium" ? "medium" : "low", dates: [e.date], refs: e.evidence || [] });
    // Policy items with a date ahead, litigation with a next step
    for (const p of R.reg?.policy || []) {
      if (p.date && windowOf(p.date, today)) ev({ section: "regulation", kind: "decision", title: p.title, detail: `${p.status}, ${p.direction}. ${p.impact || ""}`, importance: p.direction === "mixed" ? "medium" : "high", dates: [p.date], refs: p.evidence });
      else if (/propos|pending|draft|consult|review|expected|under/i.test(p.status || "")) st({ section: "regulation", kind: "policy", title: p.title, status: p.status, detail: `${p.direction}. ${p.impact || ""}`, importance: p.direction === "headwind" ? "high" : "medium", refs: p.evidence });
    }
    for (const l of R.reg?.litigation || []) if (!/settled|dismissed|closed|resolved/i.test(l.status || "")) st({ section: "regulation", kind: "legal", title: l.case, status: l.status, detail: `${l.stakes || ""}${l.next ? ` Next: ${l.next}` : ""}`, importance: "medium", refs: l.evidence });
    for (const x of R.reg?.deals || []) if (/pend|announc|review|expected|propos/i.test(x.status || "")) st({ section: "regulation", kind: "deal", title: `${x.title}${x.value ? ` (${x.value})` : ""}`, status: x.status, detail: x.rationale, importance: "medium", refs: x.evidence });
    // World: wars, conflicts and every live situation
    for (const d of R.world?.dives || []) {
      const war = /war|conflict|military|invasion|blockade|strike|missile|attack|ceasefire|troops/i.test(`${d.title} ${d.category} ${d.status}`) || ["active conflict", "escalating"].includes(d.status);
      st({ section: "world", kind: war ? "conflict" : "situation", title: d.title, status: `${d.status}; ${d.stance} for the industry${d.region ? `; ${d.region}` : ""}`,
        detail: `${d.near_term || d.now || d.summary || ""}${(d.scenarios || []).length ? ` Scenarios: ${d.scenarios.map((s) => `${s.name} ${s.probability}%`).join(", ")}.` : ""}`,
        importance: war || d.stance === "adverse" ? "high" : "medium", refs: [...(d.developments || []).flatMap((x) => x.evidence || []), ...(d.scout_evidence || [])] });
    }
    // Trade: invasion and war threats, critical bottlenecks, the biggest country risks
    const dives = Object.fromEntries((R.trade?.countries || []).map((c) => [c.country, c]));
    for (const c of R.trade?.map?.countries || []) {
      const dv = dives[c.country], lvl = dv?.security?.threat_level && dv.security.threat_level !== "none" ? dv.security.threat_level : c.threat;
      if (lvl && !["none", "low"].includes(lvl)) st({ section: "trade", kind: "threat", title: `${c.country}: ${dv?.security?.threat || c.threat_note || "security threat"}`, status: `${lvl} threat; ${dv?.security?.status || ""}`,
        detail: `${c.importance} importance (${(c.roles || []).join(", ")}). If it happens: ${dv?.security?.industry_impact || "n/a"}`, importance: ["high", "critical"].includes(lvl) || c.importance === "existential" ? "high" : "medium", refs: dv?.security?.evidence });
    }
    for (const b of R.trade?.verdict?.bottlenecks || []) if (["critical", "high"].includes(b.severity)) st({ section: "trade", kind: "bottleneck", title: b.chokepoint, status: `${b.severity}; ${(b.countries || []).join("/")}`, detail: b.delivery_impact || "", importance: b.severity === "critical" ? "high" : "medium", refs: b.evidence });
    for (const d of R.trade?.countries || []) for (const r of (d.risks || []).filter((x) => x.impact === "high" && x.likelihood !== "low").slice(0, 2))
      st({ section: "trade", kind: /military/.test(r.type) ? "conflict" : "trade risk", title: `${d.country}: ${r.risk}`, status: `${r.likelihood} likelihood, ${r.impact} impact, ${r.timing || "timing n/a"}`, detail: `${r.mechanism || ""}${r.tickers?.length ? ` (${r.tickers.join(", ")})` : ""}`, importance: r.likelihood === "high" || /military/.test(r.type) ? "high" : "medium", refs: r.evidence });
    // Rules in force or pending with high severity; the regulatory verdict
    for (const b of ctx.books || []) for (const r of b.book?.rules || []) if (r.severity === "high")
      st({ section: "regulation", kind: "rule", title: `${b.body}: ${r.name}`, status: r.status, detail: r.bottom_line || r.industry_impact, importance: "high", refs: r.evidence });
    if (ctx.regVerdict?.stance) st({ section: "regulation", kind: "regulation", title: `Regulatory verdict: ${ctx.regVerdict.headline || ctx.regVerdict.stance}`, status: `${ctx.regVerdict.stance}, ${ctx.regVerdict.intensity}`, detail: ctx.regVerdict.summary, importance: ctx.regVerdict.stance === "headwind" && ctx.regVerdict.intensity === "high" ? "high" : "medium" });
    // Macro regime and the macro strategist's own horizons
    const m = R.macro;
    if (m?.regime) st({ section: "macro", kind: "regime", title: `Macro regime ${m.regime}: ${m.headline || ""}`, status: Object.entries(m.horizons || {}).map(([h, x]) => `${h} ${x.call}`).join(", "), detail: (m.flip || []).map((x) => x.trigger).join("; "), importance: ["RESTRICTIVE", "HOSTILE"].includes(m.regime) ? "high" : "medium" });
    // IDs: earliest first for events, importance first for standing
    const rank = { high: 0, medium: 1, low: 2 };
    events.sort((a, b) => (a.dates[0] < b.dates[0] ? -1 : a.dates[0] > b.dates[0] ? 1 : rank[a.importance] - rank[b.importance]));
    const kept = events.filter((e) => e.window !== "later").slice(0, 70);
    kept.forEach((e, i) => { e.id = "C" + (i + 1); });
    standing.sort((a, b) => rank[a.importance] - rank[b.importance]);
    const st2 = standing.slice(0, 30); st2.forEach((s, i) => { s.id = "S" + (i + 1); });
    return { today, events: kept, standing: st2 };
  }
  /** Items a horizon call must address: important dated events inside its window, every high-importance standing situation. */
  function required(cal, h) {
    return { events: (cal?.events || []).filter((e) => e.importance === "high" && inWindow(e.window, h)).map((e) => e.id),
      standing: (cal?.standing || []).filter((s) => s.importance === "high").map((s) => s.id) };
  }
  function calendarText(cal) {
    const W = { "1M": "Within 1 month", "3M": "1 to 3 months", "6M": "3 to 6 months", "12M": "6 to 12 months" };
    const ev = ORDER.map((h) => { const xs = (cal.events || []).filter((e) => e.window === h);
      return xs.length ? `${W[h]}:\n${xs.map((e) => `[${e.id}] ${e.dates.slice(0, 8).join(", ")}${e.dates.length > 8 ? ` (+${e.dates.length - 8} more)` : ""} · ${e.section} · ${e.kind} · ${e.importance} — ${e.title}${e.detail ? `. ${e.detail}` : ""}${e.refs?.length ? ` [${e.refs.join(", ")}]` : ""}`).join("\n")}` : ""; }).filter(Boolean).join("\n");
    const sd = (cal.standing || []).map((s) => `[${s.id}] ${s.section} · ${s.kind} · ${s.importance} — ${s.title} (${s.status}). ${s.detail}${s.refs?.length ? ` [${s.refs.join(", ")}]` : ""}`).join("\n");
    return `DATED CALENDAR (built by code from every section; cite by C-ID)\n${ev || "nothing dated found"}\n\nSTANDING SITUATIONS (wars, conflicts, threats, rules, policy, legal, regime; cite by S-ID)\n${sd || "none"}`;
  }

  // ---------------------------------------------------------------- the prompt
  function horizonPrompt(doc, ctx, draft, keys, labels, rules) {
    const facts = horizonFacts(doc, ctx.today);
    const cal = ctx.calendar || { events: [], standing: [] };
    const m = ctx.math;
    const req = Object.fromEntries(ORDER.map((h) => [h, required(cal, h)]));
    return `You are the head of research for the US-listed "${doc.name}" industry. Today is ${ctx.today}. Make the industry's call over the next 1 month, 3 months, 6 months and 12 months. Each call must rest on EVERY fact your team found: every section of the dossier, every important decision coming up (central banks, elections, governments, regulators, courts, companies), and every war, conflict and invasion or blockade threat.

YOUR SYNTHESIS AND SCENARIOS (already written)
${JSON.stringify({ headline: draft?.headline, thesis: draft?.thesis, drivers: draft?.drivers, debates: draft?.debates, priced_in: draft?.priced_in, scenarios: draft?.scenarios, opportunity: draft?.opportunity })}
${m ? `CODE-COMPUTED SCENARIO MATH: expected 12-month return ${m.expected_return}%, upside ${m.upside}%, downside ${m.downside}%, probability of loss ${m.prob_loss}%.` : ""}

HORIZON FACTS (computed by code)
${facts.map(factsLine).join("\n")}

${calendarText(cal)}

${ctx.dossier}

${rules}
- Each horizon is its own judgment, not the 12-month view scaled down. What dominates differs by window: 1M = dated decisions and events inside it, momentum, breadth, positioning and sentiment; 3M = the earnings season's results and guidance, central-bank and policy decisions, near-term regulatory and trade actions, how the conflicts develop; 6M = estimate revisions, the policy path, rule books coming into force, the trajectory of wars and trade disputes; 12M = earnings power and valuation, which must agree with the scenarios' probability-weighted return (code checks).
- "section_reads": one specific sentence per section for THAT window: ${keys.map((k) => `"${k}" (${labels[k]})`).join(", ")}. Say what that section's findings mean over this window, citing them; never "no change" without saying why.
- "decisions": every important decision or dated event in the window, from the DATED CALENDAR (cite its C-IDs in "refs"; several dates of one series can share one entry). For each: what the plausible outcomes are and what each does to this industry, and which way you lean. Cover at least these C-IDs, which code checks: ${ORDER.map((h) => `${h}: ${req[h].events.join(", ") || "none"}`).join("; ")}. Add other decisions the dossier mentions even if they are not in the calendar (an election, a summit, a court ruling, a tariff deadline), citing their sources.
- "conflicts": every war, armed conflict, invasion or blockade threat, sanctions fight and other live geopolitical situation, AND every high-importance rule, policy, export control or other standing situation in the list below, from STANDING SITUATIONS and the world, trade and regulation reports (cite S-IDs in "refs"; several S-IDs about the same regulator or situation can share one entry, citing all of them). For each: what is likely to happen within THIS window (escalation, ceasefire, status quo, enforcement, a ruling or a change of the rule, with a probability), and what that does to the industry's prices and earnings in the window, by ticker where it differs. Cover at least these S-IDs in EVERY horizon, which code checks: ${req["12M"].standing.join(", ") || "none"}.
- Size every decision and shock with the MEASURED MACRO SENSITIVITIES (e.g. a Fed outcome that moves the 10-year yield 25bp, a war that lifts oil 10%), and weigh POSITIONING (crowded or washed out), the direction of estimate REVISIONS and the BALANCE-SHEET CYCLE in every window. If there is a TRACK RECORD, use it to calibrate your ranges and probabilities.
- Also weigh the other standing situations (rules in force, pending policy, litigation, deals, bottlenecks, the macro regime) inside "section_reads" and "drivers".
- "expected_move" = the industry's price change over the window in %, as [low, high], judged against the one-sigma move; "probability_up" = chance it is higher at the end of the window (0-100); "call" must agree with both (code checks). Cite IDs for every factual claim.

Reply with ONLY this JSON:
{"horizons": {${ORDER.map((h) => `"${h}": {"call": "bullish | neutral | bearish", "expected_move": [-3, 4], "probability_up": 55, "conviction": "high | medium | low", "drivers": "3-4 sentences: what dominates this window, weighing the decisions, the conflicts and the sections, cited", "section_reads": {${keys.map((k) => `"${k}": "..."`).join(", ")}}, "decisions": [{"refs": ["C1"], "date": "YYYY-MM-DD", "event": "...", "outcomes": "what each plausible outcome does to the industry", "lean": "positive | negative | binary | neutral"}], "conflicts": [{"refs": ["S1"], "situation": "...", "in_window": "what likely happens in this window, with a probability", "impact": "what it does to prices and earnings in this window"}], "risk": "the main thing that would make this call wrong", "positioning": "what to do over this window, naming tickers", "sections": ["the 1-4 section keys that dominate"]}`).join(",\n ")}}}`;
  }

  // ---------------------------------------------------------------- cleaning and checks
  /** clean(text, n) and en(x, list, default) come from the critic, so citations are verified the same way. */
  function cleanHorizons(raw, { clean, en, keys, cal }) {
    const arr = (x, n) => (Array.isArray(x) ? x : []).slice(0, n);
    const rng = (r) => (Array.isArray(r) ? r.map(Number).filter((x) => isNum(x)).slice(0, 2) : isNum(Number(r)) ? [Number(r)] : []).sort((a, b) => a - b);
    const cids = new Set((cal?.events || []).map((e) => e.id)), sids = new Set((cal?.standing || []).map((s) => s.id));
    const refs = (x, ok) => [...new Set(arr(x, 12).map((y) => String(y).toUpperCase().replace(/[\[\]\s]/g, "")).filter((y) => ok.has(y)))];
    const hz = {};
    for (const [h] of HORIZONS) {
      const x = raw?.[h]; if (!x || typeof x !== "object") continue;
      const pu = Number(x.probability_up);
      hz[h] = { call: en(x.call, ["bullish", "neutral", "bearish"], "neutral"), expected_move: rng(x.expected_move), probability_up: isNum(pu) ? Math.max(0, Math.min(100, Math.round(pu))) : null,
        conviction: en(x.conviction, ["high", "medium", "low"], ""), drivers: clean(x.drivers, 1100), risk: clean(x.risk, 400), positioning: clean(x.positioning, 500),
        section_reads: Object.fromEntries(keys.map((k) => [k, clean(x.section_reads?.[k], 360)]).filter(([, t]) => t)),
        decisions: arr(x.decisions, 30).map((d) => ({ refs: refs(d?.refs, cids), date: normDate(d?.date) ? String(d.date).slice(0, 10) : "", event: clean(d?.event, 200), outcomes: clean(d?.outcomes, 500), lean: en(d?.lean, ["positive", "negative", "binary", "neutral"], "neutral") })).filter((d) => d.event),
        conflicts: arr(x.conflicts, 30).map((c) => ({ refs: refs(c?.refs, sids), situation: clean(c?.situation, 200), in_window: clean(c?.in_window, 500), impact: clean(c?.impact, 500) })).filter((c) => c.situation),
        catalysts: arr(x.catalysts, 4).map((c) => ({ date: /^\d{4}-\d{2}(-\d{2})?$/.test(String(c?.date || "")) ? String(c.date) : "", event: clean(c?.event, 200), why: clean(c?.why, 260) })).filter((c) => c.event),
        sections: arr(x.sections, 4).map((y) => String(y).toLowerCase()).filter((y) => keys.includes(y)) };
    }
    return hz;
  }
  /** Numbers and coverage. Returns one entry per horizon: {h, mid, sigma, z, ok, issues, missing_events, missing_standing, missing_sections}. */
  function horizonChecks(hz, facts, math, cal = null, keys = []) {
    const mid = (r) => (r?.length ? r.reduce((a, x) => a + x, 0) / r.length : NaN);
    return HORIZONS.map(([h]) => {
      const x = hz?.[h], f = (facts || []).find((y) => y.h === h) || {};
      if (!x) return { h, missing: true, ok: false, issues: ["no call"] };
      const m = mid(x.expected_move), issues = [];
      if (isNum(m)) {
        if (x.call === "bullish" && m <= 0) issues.push(`bullish but the range's midpoint is ${m.toFixed(1)}%`);
        if (x.call === "bearish" && m >= 0) issues.push(`bearish but the range's midpoint is +${m.toFixed(1)}%`);
        if (isNum(f.sigma) && Math.abs(m) > 2 * f.sigma) issues.push(`the ${m.toFixed(1)}% midpoint is more than two sigma (±${f.sigma}%) for this window`);
        if (h === "12M" && isNum(math?.expected_return) && Math.abs(m - math.expected_return) > 6) issues.push(`the scenarios imply ${math.expected_return}% over 12 months, not ${m.toFixed(1)}%`);
      }
      if (isNum(x.probability_up)) {
        if (x.call === "bullish" && x.probability_up < 50) issues.push(`bullish with only a ${x.probability_up}% chance of a gain`);
        if (x.call === "bearish" && x.probability_up > 50) issues.push(`bearish with a ${x.probability_up}% chance of a gain`);
      }
      const out = { h, mid: isNum(m) ? Math.round(m * 10) / 10 : null, sigma: f.sigma ?? null, z: isNum(m) && f.sigma ? Math.round((m / f.sigma) * 100) / 100 : null, issues };
      if (cal) {
        const req = required(cal, h);
        // An item counts as covered wherever the call cites it: an entry's refs, or [C#]/[S#] in its text.
        const cited = new Set([...(x.decisions || []).flatMap((d) => d.refs || []), ...(x.conflicts || []).flatMap((c) => c.refs || [])]);
        const texts = [x.drivers, x.risk, x.positioning, ...Object.values(x.section_reads || {}), ...(x.decisions || []).flatMap((d) => [d.event, d.outcomes]), ...(x.conflicts || []).flatMap((c) => [c.situation, c.in_window, c.impact])];
        for (const t of texts) for (const m of String(t || "").matchAll(/\[([^\]]+)\]/g)) for (const id of m[1].split(/,\s*/)) if (/^[CS]\d+$/.test(id.trim())) cited.add(id.trim());
        const hasE = cited, hasS = cited;
        out.missing_events = req.events.filter((id) => !hasE.has(id));
        out.missing_standing = req.standing.filter((id) => !hasS.has(id));
        out.missing_sections = keys.length && x.section_reads ? keys.filter((k) => !x.section_reads[k]) : [];
      }
      out.ok = !issues.length;
      out.covered = cal ? !out.missing_events.length && !out.missing_standing.length && !out.missing_sections.length : null;
      return out;
    });
  }

  // ---------------------------------------------------------------- filling what a call left out
  /** From horizonChecks: what each horizon still has to address, or null when nothing is missing. */
  function missingOf(checks) {
    const out = {};
    for (const c of checks || []) {
      if (c.missing) continue; // no call at all: the review handles that
      const e = c.missing_events || [], s = c.missing_standing || [], k = c.missing_sections || [];
      if (e.length || s.length || k.length) out[c.h] = { events: e, standing: s, sections: k };
    }
    return Object.keys(out).length ? out : null;
  }
  /** A focused follow-up: write ONLY the pieces each horizon left out, consistent with the call already made. */
  function fixPrompt(doc, ctx, hz, miss, keys, labels, rules) {
    const cal = ctx.calendar || { events: [], standing: [] };
    const ids = new Set(Object.values(miss).flatMap((m) => [...m.events, ...m.standing]));
    const items = [...(cal.events || []).filter((e) => ids.has(e.id)).map((e) => `[${e.id}] ${e.dates.slice(0, 4).join(", ")} · ${e.section} · ${e.kind} · ${e.importance} — ${e.title}${e.detail ? `. ${e.detail}` : ""}${e.refs?.length ? ` [${e.refs.join(", ")}]` : ""}`),
      ...(cal.standing || []).filter((x) => ids.has(x.id)).map((x) => `[${x.id}] ${x.section} · ${x.kind} · ${x.importance} — ${x.title} (${x.status}). ${x.detail}${x.refs?.length ? ` [${x.refs.join(", ")}]` : ""}`)];
    const calls = Object.fromEntries(Object.keys(miss).map((h) => { const x = hz?.[h] || {}; return [h, { call: x.call, expected_move: x.expected_move, probability_up: x.probability_up, drivers: x.drivers }]; }));
    return `You are the head of research for the US-listed "${doc.name}" industry. Today is ${ctx.today}. Your 1M, 3M, 6M and 12M calls are written, but code found items some of them leave out. Write ONLY the missing pieces, consistent with each call as it stands (don't change the calls).

THE CALLS AS THEY STAND
${JSON.stringify(calls)}

WHAT EACH CALL LEAVES OUT (code checks every ID)
${Object.entries(miss).map(([h, m]) => `${h}: ${[m.standing.length ? `standing situations ${m.standing.join(", ")}` : "", m.events.length ? `decisions/events ${m.events.join(", ")}` : "", m.sections.length ? `section reads for ${m.sections.map((k) => `"${k}" (${labels[k] || k})`).join(", ")}` : ""].filter(Boolean).join("; ")}`).join("\n")}

THE ITEMS (from the calendar and standing situations code built from every section)
${items.join("\n") || "(none)"}

${ctx.dossier || ""}

${rules}
- Every standing situation listed goes into "conflicts" for that horizon, citing its S-ID in "refs"; several S-IDs about the same regulator or situation can share one entry, citing all of them. Say what is likely to happen within THAT window (status quo, enforcement, escalation, a ruling or a change, with a probability) and what it does to the industry's prices and earnings in that window, by ticker where it differs.
- Every decision/event listed goes into "decisions" for that horizon, citing its C-ID in "refs", with the plausible outcomes and which way you lean.
- Every section listed gets one specific sentence in "section_reads" for that window, citing its findings.

Reply with ONLY this JSON, with an entry for each horizon above:
{"horizons": {${Object.keys(miss).map((h) => `"${h}": {"conflicts": [{"refs": ["S1"], "situation": "...", "in_window": "...", "impact": "..."}], "decisions": [{"refs": ["C1"], "date": "YYYY-MM-DD", "event": "...", "outcomes": "...", "lean": "positive | negative | binary | neutral"}], "section_reads": {"key": "..."}}`).join(", ")}}}`;
  }
  /** Add the follow-up's pieces to the raw calls (new entries appended; missing section reads filled). */
  function mergeFix(hz, fix) {
    const out = { ...(hz || {}) };
    for (const [h, f] of Object.entries(fix || {})) {
      if (!out[h] || !f || typeof f !== "object") continue;
      const x = { ...out[h] };
      if (Array.isArray(f.conflicts)) x.conflicts = [...(Array.isArray(x.conflicts) ? x.conflicts : []), ...f.conflicts];
      if (Array.isArray(f.decisions)) x.decisions = [...(Array.isArray(x.decisions) ? x.decisions : []), ...f.decisions];
      if (f.section_reads && typeof f.section_reads === "object") x.section_reads = { ...f.section_reads, ...Object.fromEntries(Object.entries(x.section_reads || {}).filter(([, v]) => v)) };
      out[h] = x;
    }
    return out;
  }

  const Horizon = { HORIZONS, ORDER, DAYS, addDays, normDate, windowOf, inWindow, indexVol, horizonFacts, factsLine, CAL_CODES, calendarCountries, econEvents, buildCalendar, required, calendarText, horizonPrompt, cleanHorizons, horizonChecks, missingOf, fixPrompt, mergeFix };
  if (typeof module !== "undefined" && module.exports) module.exports = Horizon;
  else root.Horizon = Horizon;
})(typeof window !== "undefined" ? window : globalThis);
