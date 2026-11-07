/* Industry Scorer: the daily update.
 *
 * The full analysis (a dozen analysts and the lead strategist) runs weekly. In between, each day:
 *   1. code refreshes every number (prices, returns, estimates, positioning, macro values, news) - no Claude;
 *   2. code compares today with the last update and lists what moved (deltas) and any hard triggers;
 *   3. with no trigger, a quick model reads the deltas and says whether anything is material (triage);
 *   4. the lead strategist brings the WHOLE analysis up to date against what changed: thesis, drivers, debates,
 *      scenarios, the opportunity, the investor verdicts and the calls; what nothing touched stays exactly as it was;
 *   5. a drift guard orders a full rewrite from scratch when the updates have piled up, the industry has moved far
 *      since the last one, or the strategist says it would now write the story differently.
 * Pure functions, no I/O.
 */
(function (root) {
  "use strict";
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const num = (x) => (x === null || x === undefined || x === "" ? NaN : Number(x));
  const lc = (s) => String(s || "").toLowerCase().trim();
  const trim = (s, k) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > k ? s.slice(0, k - 1) + "…" : s; };
  const noIds = (t, k) => trim(String(t || "").replace(/\s*\[[A-Z]{1,6}\d{1,5}(?:\s*,\s*[A-Z]{1,6}\d{1,5})*\]/g, "").replace(/\s+([.,;:])/g, "$1"), k);
  const pc = (x, d = 1) => (isNum(x) ? `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%` : "n/a");
  const HZ = ["1M", "3M", "6M", "12M"];
  const Calls = typeof module !== "undefined" && module.exports ? require("./calls.js") : root.Calls;
  const Horizon = typeof module !== "undefined" && module.exports ? require("./horizon.js") : root.Horizon;
  /** Calls still on the old three-level scale (bullish / neutral / bearish; high / medium / low): every one gets re-graded. */
  const legacyCalls = (res) => HZ.some((h) => { const x = res?.horizons?.[h]; return x && (!Calls.LEVELS.includes(x.call) || !isNum(x.conviction)); });

  /** What we keep from the last update to compare against. rec: the saved industry run. */
  function prevState(rec) {
    const d = rec?.industry || {}, ag = rec?.agent || {}, res = ag.result || {};
    const idx = d.index || {}, n = (idx.dates || []).length;
    return {
      as_of: res.daily?.as_of || (n ? idx.dates[n - 1] : d.as_of) || ag.as_of || null,
      updated: res.daily?.date || ag.as_of || null,
      cons: Object.fromEntries((d.constituents || []).filter((c) => isNum(num(c.px))).map((c) => [c.symbol, num(c.px)])),
      items: (rec?.research?.items || []).map((i) => lc(i.title).slice(0, 90)),
      filings: res.daily?.filings || [],
      landed: res.landed || {},
      world: (rec?.world?.items || []).map((i) => lc(i.title).slice(0, 90)),
      macro: Object.fromEntries((rec?.macro?.rows || []).filter((r) => r.id || r.key).map((r) => [r.id || r.key, { value: num(r.value), id: r.id }])),
      rev30: num(d.forward?.rev30), breadth: num(d.forward?.breadth), sent7: num(rec?.research?.sentiment?.last_7d), rsi: num(d.positioning?.price?.rsi14),
    };
  }

  const levelAt = (ser, date) => { const ds = ser?.dates || [], v = ser?.levels || ser?.closes || []; let k = -1; for (let i = 0; i < ds.length; i++) { if (ds[i] <= date) k = i; else break; } return k >= 0 ? num(v[k]) : NaN; };
  const lastOf = (ser) => { const v = ser?.levels || ser?.closes || []; return num(v[v.length - 1]); };

  /**
   * Today against the last update. cur: {doc (refreshed industry), pack (refreshed research), world (wire), macroRows, calendar (the lead's), spy (series), relevance ({I#: high|medium|low})}.
   * Returns {since, to, days, move, spy, z, sigma, movers, news, world, macro, passed, ahead, revisions, sentiment, rsi, triggers}.
   */
  function deltas(prev, cur, today) {
    const d = cur.doc || {}, idx = d.index || {}, dates = idx.dates || [];
    const to = dates[dates.length - 1] || today, since = prev.as_of || to;
    const days = dates.filter((x) => x > since && x <= to).length;
    const l0 = levelAt(idx, since), l1 = lastOf(idx), move = l0 > 0 && l1 > 0 ? l1 / l0 - 1 : NaN;
    const s0 = levelAt(cur.spy, since), s1 = cur.spy ? levelAt(cur.spy, to) : NaN, spy = s0 > 0 && s1 > 0 ? s1 / s0 - 1 : NaN;
    const vol = num(d.summary?.vol_1y), sigma = isNum(vol) && days > 0 ? vol * Math.sqrt(days / 252) : NaN, z = isNum(move) && sigma > 0 ? move / sigma : NaN;
    const movers = (d.constituents || []).map((c) => { const p0 = prev.cons[c.symbol], p1 = num(c.px), r = p0 > 0 && p1 > 0 ? p1 / p0 - 1 : NaN; return { symbol: c.symbol, name: c.name, weight: num(c.weight), ret: r, contrib: r * num(c.weight) }; })
      .filter((m) => isNum(m.ret)).sort((a, b) => Math.abs(b.contrib) - Math.abs(a.contrib)).slice(0, 8);
    const seen = new Set(prev.items), seenW = new Set(prev.world);
    let k = 0;
    const fresh = (cur.pack?.items || []).filter((i) => i.title && ["N", "P", "E", "M"].includes(i.kind) && !seen.has(lc(i.title).slice(0, 90)) && (!i.date || i.date >= since))
      .sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""))).slice(0, 25)
      .map((i) => ({ id: "D" + ++k, kind: i.kind, date: i.date || "", source: i.source || "", title: trim(i.title, 200), summary: trim(i.summary, 260), symbol: i.symbol || "", url: i.url || "" }));
    const world = (cur.world?.items || []).filter((i) => i.title && !seenW.has(lc(i.title).slice(0, 90)) && (!i.date || i.date >= since))
      .sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""))).slice(0, 12)
      .map((i) => ({ id: "D" + ++k, kind: "W", date: i.date || "", source: i.source || "", title: trim(i.title, 200), summary: trim(i.summary, 200), url: i.url || "" }));
    // 8-K filings by the industry's 25 largest companies (one shared SEC list a day); with financial statements it is usually results.
    const top25 = new Set((d.constituents || []).slice().sort((a, b) => num(b.weight) - num(a.weight)).slice(0, 25).map((c) => c.symbol));
    const seenF = new Set(prev.filings || []), nameOf = Object.fromEntries((d.constituents || []).map((c) => [c.symbol, c.name]));
    const filings = (cur.filings || []).filter((f) => top25.has(f.symbol) && String(f.filingDate || "").slice(0, 10) >= since && !seenF.has(f.finalLink || f.link))
      .sort((a, b) => String(b.acceptedDate || b.filingDate).localeCompare(String(a.acceptedDate || a.filingDate))).slice(0, 10)
      .map((f) => ({ id: "D" + ++k, kind: "F", date: String(f.filingDate || "").slice(0, 10), source: "SEC 8-K", symbol: f.symbol, fin: !!f.hasFinancials,
        title: `${f.symbol}${nameOf[f.symbol] ? ` (${trim(nameOf[f.symbol], 60)})` : ""} filed an 8-K${f.hasFinancials ? " with financial statements (usually results)" : ""}`, summary: "", url: f.finalLink || f.link || "" }));
    const macro = (cur.macroRows || []).map((r) => { const p = prev.macro[r.id || r.key]; const v = num(r.value), pv = p ? p.value : NaN;
      const ch = isNum(v) && isNum(pv) ? v - pv : NaN, rel = isNum(ch) && pv ? ch / Math.abs(pv) : NaN, pctUnit = r.unit === "%";
      const big = isNum(ch) && (pctUnit ? Math.abs(ch) >= 0.1 : Math.abs(rel) >= 0.02);
      return { id: r.id, key: r.key, label: r.label, value: v, unit: r.unit || "", prev: pv, change: ch, rel, big, relevance: cur.relevance?.[r.id] || "" }; })
      .filter((m) => m.big).sort((a, b) => Math.abs(b.rel || 0) - Math.abs(a.rel || 0)).slice(0, 12);
    const evs = (cur.calendar?.events || []).map((e) => ({ id: e.id, date: (e.dates || [])[0] || "", title: trim(e.title, 160), importance: e.importance || "", kind: e.kind || "", section: e.section || "", tickers: e.tickers || [], detail: noIds(e.detail, 220) })).filter((e) => e.date);
    // Passed events: anything dated since the last update, and any important one from the last three weeks whose
    // outcome hasn't been recorded yet (an election, a rate decision, a ruling): it stays on the table until it has.
    const landed = prev.landed || {};
    const passed = evs.filter((e) => e.date <= today && (e.date > since || (e.importance === "high" && e.kind !== "earnings" && !landed[e.id]?.text && e.date >= addDays(today, -21)))), ahead = evs.filter((e) => e.date > today && e.date <= addDays(today, 7));
    // How each passed event landed: the headlines that name it (from the whole wire and the industry's news, not just
    // the newest), so the outcome reaches the strategist even on a day other news crowds the feed.
    const STOP = new Set(["united", "states", "federal", "meeting", "decision", "release", "report", "annual", "quarter", "update", "results", "policy", "deadline", "expected", "first", "global", "national", "final"]);
    const pool = [...(cur.world?.items || []).map((i) => ({ ...i, kind: "W" })), ...(cur.pack?.items || []).filter((i) => ["N", "P", "M"].includes(i.kind))];
    const used = new Map([...fresh, ...world].map((i) => [lc(i.title).slice(0, 90), i.id])), outcome = [];
    for (const e of passed) {
      if (e.kind === "earnings") continue;
      const words = lc(e.title).split(/[^a-z0-9-]+/).filter((w) => w.length >= 5 && !STOP.has(w));
      if (/midterm|election/.test(lc(e.title))) words.push("midterm", "election", "sweep", "house", "senate");
      if (!words.length) continue;
      const hits = pool.filter((i) => i.title && (!i.date || i.date >= addDays(e.date, -1)) && words.some((w) => lc(i.title).includes(w)))
        .sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""))).slice(0, 4);
      e.outcome_ids = [];
      for (const i of hits) { const key = lc(i.title).slice(0, 90); let id = used.get(key);
        if (!id) { id = "D" + ++k; used.set(key, id); outcome.push({ id, kind: i.kind || "W", date: i.date || "", source: i.source || "", title: trim(i.title, 200), summary: trim(i.summary, 200), symbol: i.symbol || "", url: i.url || "", event: e.id }); }
        e.outcome_ids.push(id); }
    }
    const revisions = { rev30: num(d.forward?.rev30), was: prev.rev30, breadth: num(d.forward?.breadth), breadth_was: prev.breadth };
    const sentiment = { now: num(cur.pack?.sentiment?.last_7d), was: prev.sent7 };
    const rsi = { now: num(d.positioning?.price?.rsi14), was: prev.rsi };
    // Hard triggers: any of these sends the calls straight to review, without asking the quick model.
    const wOf = Object.fromEntries((d.constituents || []).map((c) => [c.symbol, num(c.weight)]));
    const top10 = new Set((d.constituents || []).slice().sort((a, b) => num(b.weight) - num(a.weight)).slice(0, 10).map((c) => c.symbol));
    const triggers = [];
    if (isNum(z) && Math.abs(z) >= 1.5) triggers.push(`the industry moved ${pc(move)} since ${since}, ${Math.abs(z).toFixed(1)} times its normal move`);
    for (const e of passed) { const big = e.tickers.some((t) => top10.has(t)); if (e.kind === "earnings" && big) triggers.push(`${e.tickers.filter((t) => top10.has(t)).join(", ")} reported (${e.date})`); else if (e.importance === "high") triggers.push(`${e.title} (${e.date}) has passed`); }
    for (const m of movers) if (Math.abs(m.ret) >= 0.08 && (m.weight || 0) >= 0.03) triggers.push(`${m.symbol} moved ${pc(m.ret)} (${(m.weight * 100).toFixed(0)}% of the industry)`);
    for (const m of macro) if (m.relevance === "high" && (m.unit === "%" ? Math.abs(m.change) >= 0.15 : Math.abs(m.rel) >= 0.05)) triggers.push(`${m.label} moved to ${m.value}${m.unit} from ${m.prev}${m.unit}`);
    if (isNum(revisions.rev30) && isNum(revisions.was) && Math.abs(revisions.rev30 - revisions.was) >= 0.01) triggers.push(`EPS revisions moved from ${pc(revisions.was)} to ${pc(revisions.rev30)} over 30 days`);
    if (fresh.length >= 18) triggers.push(`${fresh.length} new company headlines`);
    for (const f of filings) if (f.fin && top10.has(f.symbol)) triggers.push(`${f.symbol} filed an 8-K with financial statements (${f.date})`);
    if (cur.shock) triggers.unshift(String(cur.shock));
    void wOf;
    return { since, to, days, move, spy, z, sigma, movers, news: fresh, world, outcome, filings, shock: cur.shock || "", macro, passed, ahead, revisions, sentiment, rsi, triggers: [...new Set(triggers)].slice(0, 10) };
  }
  function addDays(d, k) { const t = new Date(String(d).slice(0, 10) + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + k); return t.toISOString().slice(0, 10); }

  /** The deltas as prompt text (D-IDs for new headlines, I-IDs for macro rows). */
  function deltaText(x) {
    const L = [];
    L.push(`Since ${x.since} (${x.days} trading day${x.days === 1 ? "" : "s"}): industry ${pc(x.move)} vs SPY ${pc(x.spy)}${isNum(x.z) ? `; that is ${x.z.toFixed(1)} times a normal move of ±${(x.sigma * 100).toFixed(1)}%` : ""}.`);
    if (x.movers.length) L.push(`Biggest contributors: ${x.movers.map((m) => `${m.symbol} ${pc(m.ret)} (${isNum(m.weight) ? (m.weight * 100).toFixed(1) : "?"}% weight)`).join(", ")}.`);
    if (x.passed.length) L.push(`Events that have now passed (say how each landed):\n${x.passed.map((e) => `[${e.id}] ${e.date} ${e.title}${e.tickers.length ? ` (${e.tickers.join(", ")})` : ""}${e.kind === "earnings" ? "" : (e.outcome_ids || []).length ? `; headlines on how it landed: ${e.outcome_ids.map((i) => `[${i}]`).join(" ")}` : "; no headline on how it landed yet"}`).join("\n")}`);
    if ((x.outcome || []).length) L.push(`Headlines on how those events landed:\n${x.outcome.map((n) => `[${n.id}] ${n.date} ${n.source}: ${n.title}${n.summary ? ". " + n.summary : ""}`).join("\n")}`);
    if (x.ahead.length) L.push(`Coming in the next 7 days: ${x.ahead.map((e) => `${e.date} ${e.title}`).join("; ")}.`);
    if (x.macro.length) L.push(`Macro moves: ${x.macro.map((m) => `[${m.id}] ${m.label} ${m.prev}${m.unit} -> ${m.value}${m.unit}${m.relevance ? ` (${m.relevance} relevance)` : ""}`).join("; ")}.`);
    if (isNum(x.revisions.rev30)) L.push(`EPS revisions over 30 days: ${pc(x.revisions.rev30)} (was ${pc(x.revisions.was)}); breadth ${isNum(x.revisions.breadth) ? x.revisions.breadth.toFixed(2) : "n/a"} (was ${isNum(x.revisions.breadth_was) ? x.revisions.breadth_was.toFixed(2) : "n/a"}).`);
    if (isNum(x.sentiment.now)) L.push(`News sentiment, last 7 days: ${x.sentiment.now.toFixed(2)} (was ${isNum(x.sentiment.was) ? x.sentiment.was.toFixed(2) : "n/a"}).`);
    if (isNum(x.rsi.now)) L.push(`Industry RSI: ${x.rsi.now.toFixed(0)} (was ${isNum(x.rsi.was) ? x.rsi.was.toFixed(0) : "n/a"}).`);
    L.push(`New company headlines:\n${x.news.map((n) => `[${n.id}] ${n.date} ${n.symbol ? n.symbol + " · " : ""}${n.source}: ${n.title}${n.summary ? ". " + n.summary : ""}`).join("\n") || "(none)"}`);
    if (x.shock) L.push(`MARKET SHOCK TODAY: ${x.shock}.`);
    if ((x.filings || []).length) L.push(`New SEC 8-K filings by the industry's largest companies:\n${x.filings.map((f) => `[${f.id}] ${f.date} ${f.title}`).join("\n")}`);
    L.push(`New world headlines:\n${x.world.map((n) => `[${n.id}] ${n.date} ${n.source}: ${n.title}`).join("\n") || "(none)"}`);
    return L.join("\n");
  }
  /** The strategist's record on matured calls (from the scorecard), one line, for the prompts. */
  function scorecardText(facts) {
    const sc = (facts || []).map((f) => f.score && f.score.n ? `${f.h}: ${f.score.n} matured calls, direction right ${f.score.hit}% (the anchor ${f.score.anchor_hit ?? "n/a"}%), ${f.score.in_range}% inside their likely range (50% is calibrated)` : "").filter(Boolean);
    return sc.length ? `YOUR SCORECARD (calls that have run their course, across every industry): ${sc.join("; ")}. Code weighs your view against the anchor by this record.` : "";
  }
  const callsText = (res) => HZ.filter((h) => res?.horizons?.[h]).map((h) => { const x = res.horizons[h];
    return `${h}: ${x.call}, conviction ${isNum(x.conviction) ? x.conviction + "/10" : x.conviction || "?"}, ${(x.expected_move || []).join(" to ")}%, ${x.probability_up ?? "?"}% chance higher. Why: ${noIds(x.drivers, 500)}${(x.decisions || []).length ? ` Decisions in the window: ${x.decisions.slice(0, 6).map((c) => `${c.date || ""} ${noIds(c.event, 90)}`).join("; ")}.` : ""}`; }).join("\n");

  /** Step 3: is anything material? A short prompt for the quick model. */
  function triagePrompt(name, res, x, today, brief = "") {
    return `You watch the "${name}" industry for an investment team. Today is ${today}. The team's current calls (from ${res?.daily?.date || "its last full analysis"}):
${callsText(res)}
${brief ? `
WHAT THE TEAM'S DEEPER SECTIONS SAY NOW (written ${res?.daily?.date ? "earlier" : "in the last full analysis"})
${brief}
` : ""}
WHAT CHANGED SINCE THE LAST UPDATE (computed from market data and news)
${deltaText(x)}

1. Is any of this material enough that the 1M, 3M, 6M or 12M call could change (direction, range or the chance of a gain)? Routine moves inside the normal range, expected events landing as expected and generic headlines are not material.
2. Which parts of the team's work should be rewritten today so everything stays current? Name EVERY section that anything since the last update changes or adds to: a fact, a headline, commentary or an analyst's view, a preview, a price, estimate or macro move, an event that passed. Rewriting is cheap compared with a stale report, so when in doubt, name it; leave a section out only when nothing since the last update touches it. Cite what prompts each one ([D#] headlines, [I#] macro rows, or the event or move in words):
${Object.entries(SECTIONS).map(([k, v]) => `   - "${k}": ${v.when}`).join("\n")}
Reply with ONLY this JSON: {"material": true or false, "horizons": ["the horizons worth revisiting, e.g. 1M"], "why": "one sentence",
 "sections": [{"key": "${Object.keys(SECTIONS).join(" | ")}", "importance": "high (it changes what the section concludes or an investor would act on) | medium (new facts that update it) | low (nuance or commentary)", "why": "one sentence: what changed for it, cited", "regulators": ["for rulebook: the regulators' names as listed above, or [] for all of them"]}]}`;
  }

  /**
   * Everything the daily update can rewrite, each by the same analyst as the full run, for this industry only. There
   * is no cool-down and no daily limit: whatever the day's data touches is rewritten, every day if need be.
   */
  const SECTIONS = {
    kpi: { label: "KPIs and earnings calls", when: "a company reported, pre-announced or changed guidance; an industry statistic (shipments, prices, orders, volumes) came out; or commentary or estimates moved on demand, pricing or margins" },
    macro: { label: "Macro regime and indicators", when: "a macro indicator the industry tracks moved or was released; a central bank, inflation, jobs, growth, rates, currency or commodity headline; or commentary on the macro outlook" },
    world: { label: "World-event deep dives", when: "anything new on a war, conflict, sanction, election, disaster or other world situation that reaches this industry, including commentary and escalation risk" },
    trade: { label: "Trade map and country relations", when: "anything new on tariffs, export controls, trade deals, quotas, or relations with one of the industry's countries, including talks, threats and commentary" },
    reg: { label: "Regulation, litigation and deals", when: "anything new on a law, rule, court case, enforcement action, investigation, settlement, merger or deal touching the industry, including proposals, filings and commentary" },
    rulebook: { label: "Regulator rule books", when: "anything new from or about one of the regulators listed above: a rule finalized, proposed, changed, delayed, challenged or struck down, guidance or speeches" },
    chain: { label: "Customers and suppliers", when: "anything new from a key customer or supplier: results, guidance, capex, orders, deals, contract wins or losses, troubles" },
    thesis: { label: "The whole analysis rewritten from scratch", when: "the day's changes add up to a different story, one you would build differently from scratch (the strategist updates the thesis, scenarios and calls every day anyway; this is for a story that no longer holds)" },
  };
  /** A short brief of what each deeper section says now, so the quick model can tell whether a headline is new to it. */
  function sectionBrief({ kpi, world, trade, reg, chain, bodies = [] } = {}) {
    const L = [], cut = (t, n) => trim(noIds(t), n);
    if (kpi) L.push(`KPIs: ${cut(kpi.summary, 300)}`);
    if (world?.dives?.length || world?.scout?.situations?.length) L.push(`World situations covered: ${(world.dives?.length ? world.dives : world.scout.situations).slice(0, 10).map((d) => d.title).join("; ")}`);
    if (trade?.map?.countries?.length) L.push(`Trade map countries: ${trade.map.countries.slice(0, 12).map((c) => c.country).join(", ")}`);
    if (reg) { const it = [...(reg.policy || []).map((p) => p.title), ...(reg.litigation || []).map((l) => l.case), ...(reg.deals || []).map((d) => d.title)].slice(0, 14);
      if (it.length) L.push(`Regulation, litigation and deals covered: ${it.join("; ")}`); }
    if (bodies.length) L.push(`Regulators with rule books: ${bodies.slice(0, 10).join("; ")}`);
    if (chain?.partners?.length) L.push(`Key customers and suppliers: ${chain.partners.slice(0, 12).map((p) => `${p.symbol || p.name} (${p.role})`).join(", ")}`);
    return L.join("\n");
  }
  /**
   * How far the industry has moved since the last full rewrite (`since`, its date): the move and how many normal moves
   * that is. doc: the refreshed industry.
   */
  function drift(doc, since) {
    const idx = doc?.index || {}, dates = idx.dates || [], s = String(since || "").slice(0, 10);
    if (!s || !dates.length) return null;
    const l0 = levelAt(idx, s), l1 = lastOf(idx), days = dates.filter((x) => x > s).length, vol = num(doc?.summary?.vol_1y);
    const move = l0 > 0 && l1 > 0 ? l1 / l0 - 1 : NaN, sigma = isNum(vol) && days > 0 ? vol * Math.sqrt(days / 252) : NaN;
    return { since: s, days, move, z: isNum(move) && sigma > 0 ? move / sigma : NaN };
  }
  /**
   * The drift guard's limits: a full rewrite once the industry has moved this many normal moves since the last one, or
   * after this many updates that changed the core story (thesis, drivers, scenarios, the opportunity).
   */
  const DRIFT = { z: 2, updates: 6 };
  const CORE = /^(thesis|drivers|scenario odds|the opportunity|bull scenario|base scenario|bear scenario)$/;

  /**
   * Which sections to rewrite today: everything the quick model names (with its reason), plus what code knows on its
   * own: a top company reported or filed results (KPIs), a large move in a macro indicator the industry tracks (macro),
   * and the drift guard (the whole analysis from scratch: a big move today, a big move since the last full rewrite,
   * too many updates since it, or yesterday's update saying it would write the story differently now). No cool-down,
   * no daily limit. last: {pending (held yesterday), drift: {z, move, since, updates, rethink}}.
   */
  function pickSections(tri, x, last = {}, today) {
    const out = [];
    const IMP = { high: 3, medium: 2, low: 1 };
    const add = (key, why, { code = false, regulators = [], importance } = {}) => {
      if (!SECTIONS[key] || !String(why || "").trim()) return;
      const imp = IMP[lc(importance)] ? lc(importance) : code ? "high" : "medium";
      const have = out.find((o) => o.key === key);
      if (have) { if (!have.why.includes(trim(why, 60))) have.why = trim(`${have.why}; ${why}`, 300); if (code && have.by !== "code") have.by = "code"; if (regulators.length) have.regulators = [...new Set([...(have.regulators || []), ...regulators])]; if (IMP[imp] > IMP[have.importance]) have.importance = imp; return; }
      out.push({ key, label: SECTIONS[key].label, why: trim(why, 300), by: code ? "code" : "news", importance: imp, ...(regulators.length ? { regulators } : {}) });
    };
    // An important event (an election, a rate decision, a ruling) has happened: the section it belongs to is rewritten.
    for (const e of x.passed || []) if (e.importance === "high" && e.kind !== "earnings") add(SECTIONS[e.section] ? e.section : "macro", `${e.title} happened on ${e.date}${(e.outcome_ids || []).length ? ` [${e.outcome_ids.join(", ")}]` : ""}`, { code: true });
    for (const e of x.passed || []) if (e.kind === "earnings" && (x.triggers || []).some((t) => t.includes(`(${e.date})`) && e.tickers.some((tk) => t.includes(tk)))) add("kpi", `${e.tickers.join(", ")} reported on ${e.date}`, { code: true });
    const bigMacro = (x.macro || []).filter((m) => m.relevance === "high");
    if (bigMacro.length) add("macro", `${bigMacro.slice(0, 3).map((m) => `${m.label} ${m.prev}${m.unit} → ${m.value}${m.unit} [${m.id}]`).join("; ")}`, { code: true });
    for (const f of x.filings || []) if (f.fin && (x.triggers || []).some((t) => t.startsWith(`${f.symbol} filed an 8-K`))) add("kpi", `${f.symbol} filed an 8-K with financial statements on ${f.date} [${f.id}]`, { code: true });
    if (isNum(x.z) && Math.abs(x.z) >= 2.5) add("thesis", `the industry moved ${pc(x.move)} since ${x.since}, ${Math.abs(x.z).toFixed(1)} times its normal move`, { code: true });
    const dg = last?.drift || {};
    if (isNum(dg.z) && Math.abs(dg.z) >= DRIFT.z) add("thesis", `drift guard: the industry has moved ${pc(dg.move)} since the last full rewrite (${dg.since}), ${Math.abs(dg.z).toFixed(1)} times a normal move for that time`, { code: true });
    if (dg.rethink && dg.rethink.same === false) add("thesis", `drift guard: the last update said it would write the story differently from scratch: ${trim(dg.rethink.why, 200)}`, { code: true });
    if ((dg.updates || 0) >= DRIFT.updates) add("thesis", `drift guard: ${dg.updates} updates to the core story since the last full rewrite${dg.since ? ` (${dg.since})` : ""}; a fresh one rereads every section in full and clears what the patches may have missed`, { code: true, importance: "low" });
    for (const s of Array.isArray(tri?.sections) ? tri.sections : []) {
      const key = lc(s?.key);
      const regulators = key === "rulebook" ? (Array.isArray(s.regulators) ? s.regulators : []).map((r) => trim(r, 120)).filter(Boolean).slice(0, 8) : [];
      add(key, String(s?.why || ""), { regulators, importance: s?.importance });
    }
    // What a budget held back yesterday comes back today, a little more urgent each day it waits.
    for (const p of Array.isArray(last?.pending) ? last.pending : []) if (!out.some((o) => o.key === p.key)) { add(p.key, p.why, { regulators: p.regulators || [], importance: p.importance }); const o = out.find((y) => y.key === p.key); if (o) { o.waited = (p.waited || 0) + 1; o.by = p.by || "news"; } }
    void today;
    return out;
  }

  /**
   * About what one rewrite costs at batch prices (Sonnet for the analysts, the lead tier for the whole analysis), to
   * plan a day's spending; the job's own meter is the real figure. A rule book costs this per regulator.
   */
  const COST = { kpi: 0.25, macro: 0.4, world: 0.7, trade: 0.8, reg: 0.35, rulebook: 0.5, chain: 0.15, thesis: 1.6, calls: 0.12, lean: 0.04, triage: 0.002, second: 0.01 };
  const IMPV = { high: 3, medium: 2, low: 1 };
  const WEIGHT = { thesis: 1.3, kpi: 1.2, reg: 1.1, trade: 1.1, world: 1.0, macro: 1.0, rulebook: 0.9, chain: 0.9 };
  /** How much a rewrite is worth today: importance, then what code saw for itself, then how long it has waited. */
  const scoreOf = (c) => (IMPV[c.importance] || 2) * 10 * (WEIGHT[c.key] || 1) + (c.by === "code" ? 8 : 0) + Math.min(15, 3 * (c.waited || 0));
  /**
   * Plan a day within a budget. cands: [{industry, key, importance, by, waited, regulators?, bodies?}]; budget in $.
   * Returns {run: [...], held: [...], planned} in order of worth; the cheapest worthwhile work is never starved by an
   * expensive item that doesn't fit (it is skipped and the next one tried). `stretch`: extra money (borrowed from the
   * rest of the month) that only urgent items may use, so a rewrite bigger than a small sector's daily share (a drift
   * guard's full rewrite, or anything code flagged high, or that has waited two days) still happens.
   */
  function plan(cands, budget, { stretch = 0 } = {}) {
    const est = (c) => (c.key === "rulebook" ? COST.rulebook * Math.max(1, (c.regulators?.length || c.bodies || 2)) : COST[c.key] || 0.5);
    const ranked = cands.map((c) => ({ ...c, score: scoreOf(c), est: est(c) })).sort((a, b) => b.score - a.score || a.est - b.est);
    const run = [], held = []; let left = Math.max(0, budget), extra = Math.max(0, stretch), borrowed = 0;
    const urgent = (c) => (c.by === "code" && c.importance === "high") || (c.waited || 0) >= 2;
    for (const c of ranked) {
      if (c.est <= left) { run.push(c); left -= c.est; }
      else if (urgent(c) && c.est <= left + extra) { const b = c.est - left; extra -= b; borrowed += b; left = 0; run.push({ ...c, borrowed: true }); }
      else held.push(c);
    }
    return { run, held, planned: Math.round((budget - left + borrowed) * 100) / 100, borrowed: Math.round(borrowed * 100) / 100 };
  }
  /** Today's share of a monthly budget: what is left this month, spread over the days left (today included). */
  function dayBudget(monthBudget, spentThisMonth, today) {
    const d = new Date(String(today).slice(0, 10) + "T00:00:00Z"), last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    const daysLeft = last - d.getUTCDate() + 1;
    return Math.max(0, Math.round(((monthBudget - (spentThisMonth || 0)) / daysLeft) * 100) / 100);
  }
  /**
   * The most a day may borrow from the rest of the month: three days' share, and never more than a quarter of what is
   * left. Used on a big day (a market shock, or news hitting much of the sector at once) and for urgent rewrites.
   */
  function borrowCap(monthBudget, spentThisMonth, today) {
    const left = Math.max(0, monthBudget - (spentThisMonth || 0));
    return Math.round(Math.min(3 * dayBudget(monthBudget, spentThisMonth, today), 0.25 * left) * 100) / 100;
  }
  /**
   * Is today a big day? Only the market says so: spy1d / vix1d (today's % changes) or a midday alarm's note (shock).
   * (The quick model's "high importance" is not a signal: it calls most days high for most industries, which made
   * every day a big day and spent three days' share daily.) highShare is accepted and ignored. Returns {big, why}.
   */
  function bigDay({ spy1d = NaN, vix1d = NaN, highShare = 0, shock = "" } = {}) {
    const why = [];
    if (shock) why.push(String(shock));
    if (isNum(spy1d) && Math.abs(spy1d) >= 2) why.push(`the S&P 500 moved ${spy1d > 0 ? "+" : ""}${spy1d.toFixed(1)}% in a day`);
    if (isNum(vix1d) && vix1d >= 15) why.push(`the VIX jumped ${vix1d.toFixed(0)}%`);
    void highShare;
    return { big: why.length > 0, why: why.join("; ") };
  }

  /** The parts of the lead's analysis the daily update may rewrite, as it reads them (citations kept: a kept passage keeps its sources). */
  function analysisOf(res) {
    const sc = res?.scenarios || {}, op = res?.opportunity || {};
    const out = { headline: res?.headline || "", thesis: res?.thesis || "", summary: res?.summary || "", priced_in: res?.priced_in || "", confidence: res?.confidence || "",
      drivers: (res?.drivers || []).map(({ title, direction, magnitude, horizon, text }) => ({ title, direction, magnitude, horizon, text })),
      debates: (res?.debates || []).map(({ question, bull, bear, resolves_with, lean, why }) => ({ question, bull, bear, resolves_with, lean, why })),
      change_mind: res?.change_mind || [],
      scenarios: Object.fromEntries(SCN.filter((k) => sc[k]).map((k) => [k, { probability: sc[k].probability, narrative: sc[k].narrative, triggers: sc[k].triggers || [], eps_change: sc[k].eps_change, pe: sc[k].pe, price_move: sc[k].price_move, earnings: sc[k].earnings, valuation: sc[k].valuation, sections: sc[k].sections || {} }])) };
    if (op.verdict) out.opportunity = { verdict: op.verdict, headline: op.headline, why: op.why, entry_triggers: op.entry_triggers || [] };
    if (res?.profiles && Object.keys(res.profiles).length) out.profiles = Object.fromEntries(Object.entries(res.profiles).map(([k, p]) => [k, { fit: p.fit, conviction: p.conviction, verdict: p.verdict }]));
    return out;
  }
  const SCN = ["bull", "base", "bear"];

  /**
   * Step 4: the whole analysis brought up to date. The lead strategist reads its entire current analysis and what
   * changed, rewrites every part the evidence changes (and only those), revisits the calls, and says whether it would
   * now write the story differently from scratch (which orders a full rewrite). opts: {pe: today's P/E basis for the
   * scenario math, drift: {move, z, since, updates}}.
   */
  function updatePrompt(name, res, x, today, facts, rewritten = "", { pe = null, drift: dg = null } = {}) {
    return `You are the lead strategist for the "${name}" industry. Today is ${today}. Below is your WHOLE current analysis, then everything that changed since it was last updated, and the sections your team rewrote today because of it. Bring the whole analysis up to date so it reads exactly as you would write it today: every sentence, number, probability and call that today's evidence makes wrong, stale or incomplete, you rewrite; everything it doesn't touch, you leave exactly as it is.

YOUR WHOLE ANALYSIS NOW (JSON, last updated ${res?.daily?.date || "at the full analysis"}; the IDs in [brackets] are your sources)
${JSON.stringify(analysisOf(res))}

YOUR CURRENT 1M, 3M, 6M AND 12M CALLS
${callsText(res)}

NORMAL MOVES NOW (one sigma): ${(facts || []).map((f) => `${f.h} ±${f.sigma}%`).join(", ") || "n/a"}
${(facts || []).some((f) => f.anchor) ? `STATISTICAL ANCHOR, TODAY (refreshed with today's prices; your calls start here):
${facts.filter((f) => f.anchor).map((f) => `${f.h}: ${Horizon.anchorText(f.anchor)}`).join("\n")}` : ""}
${scorecardText(facts)}
${(facts || []).some((f) => f.like) ? `TIMES LIKE THIS (the past months most like today, macro and industry setup; start from these and move away only for a stated reason): ${(facts || []).filter((f) => f.like).map((f) => `${f.h} up ${f.like.pos}% of the time, median ${f.like.median}% (middle half ${f.like.p25}% to ${f.like.p75}%), 5 closest episodes up ${f.like.top_up} of ${f.like.top_n}`).join("; ")}` : ""}
${isNum(num(pe)) ? `TODAY'S P/E FOR THE SCENARIO MATH: ${num(pe)}` : ""}
${dg && isNum(dg.move) ? `SINCE YOUR LAST FULL REWRITE (${dg.since}): the industry moved ${pc(dg.move)}${isNum(dg.z) ? `, ${Math.abs(dg.z).toFixed(1)} times a normal move for that time` : ""}; ${dg.updates || 0} daily update${dg.updates === 1 ? "" : "s"} since.` : ""}

WHAT CHANGED SINCE THE LAST UPDATE
${deltaText(x)}
${x.triggers.length ? `\nFLAGGED BY CODE: ${x.triggers.join("; ")}` : ""}
${rewritten ? `\nSECTIONS YOUR TEAM REWROTE TODAY BECAUSE OF THIS NEWS (their new conclusions; weigh them everywhere they bear)\n${noIds(rewritten)}\n` : ""}
HOW TO UPDATE
1. Go through every part in turn: headline, thesis, summary, priced_in, confidence, each driver, each debate (has one been settled? is a new one live?), change_mind, each scenario (probability, numbers, narrative, triggers, earnings, valuation, each section read), the opportunity, each investor profile, then each call. For each, ask: does anything above make this wrong, stale or incomplete? If yes, rewrite it in full, as you would from scratch, weaving the new facts in with their citations. If no, leave it out of your reply (it stays as it is).
2. Lists (drivers, debates, change_mind, a scenario's triggers, entry_triggers): if any item changes, return the whole new list, re-ranked: drop what no longer matters, add what now does.
3. Scenario numbers stay consistent: price_move ≈ (1 + eps_change/100) × (end P/E ÷ today's P/E) − 1, and probabilities sum to 100; if you change one probability, give all three. A scenario's "sections" object: only the section reads that change.
4. A call: ${legacyCalls(res) ? `your calls above are on the OLD three-level scale (bullish / neutral / bearish, conviction high / medium / low). Re-grade EVERY call on the new scale below: give each one status "revised", with its call, a 1-10 conviction, its range and its chance of a gain, starting from TIMES LIKE THIS; keep the range and probability where they still hold.` : `keep one that still holds exactly as it is (status "unchanged"); revise it only for a real change in what drives it.`} A revised range is the LIKELY range (the middle half of outcomes): its half-width about two-thirds of the one-sigma move for that window, never more. Events that have passed: say how they landed.
${Calls.rules("the industry")}
${Horizon.ANCHOR_RULES}
4b. For each event that has passed (listed above with its ID): say how it landed, from its headlines, and rewrite every part of the analysis that assumed an outcome: a scenario that hinged on it (the outcome may make one scenario the base case), a debate it settles, a driver, a call it was the catalyst for, the opportunity. If no headline says how it landed, say "unknown" (it stays on the list until one does).
5. Keep it all consistent: the headline, thesis, scenarios, opportunity, profiles and calls must tell one story after your changes.
6. Then answer honestly: if you threw this analysis away and wrote it from scratch today, with everything above, would you reach the same core thesis, the same scenario set and the same opportunity verdict? "different" if the story itself would be built differently, not merely updated. A "different" orders a full rewrite.
- Cite what you rely on: [D#] for today's headlines and filings, [I#] for macro rows, and the IDs already in your analysis. Never invent a fact, figure or ID.

Reply with ONLY this JSON:
{"material": true or false, "headline": "one sentence: what changed today for this industry", "summary": "2-4 sentences, cited", "changes": [{"text": "one change and what it means, cited", "effect": "positive | negative | mixed"}],
 "horizons": {${HZ.map((h) => `"${h}": {"status": "unchanged | revised", ${Calls.schema}, "expected_move": [-3, 4], "probability_up": 58, ${Horizon.VS_SCHEMA}, "why": "1-2 sentences: why it stands or what changed, cited"}`).join(", ")}},
 "analysis": {only the parts that change, in the same shape as YOUR WHOLE ANALYSIS above; {} if nothing changes},
 "rethink": {"from_scratch": "same | different", "why": "one sentence"},
 "events": [{"id": "C7", "landed": "one or two sentences: what happened and what it means for this industry, cited | unknown"}],
 "watch": ["1-3 things to watch tomorrow"]}`;
  }

  /**
   * Merge the update's "analysis" into the result (in place). cite: the citation cleaner for analysis text. Returns the
   * labels of the parts that changed. A part the update left out, or gave in a shape code can't trust, stays as it was.
   */
  function mergeAnalysis(out, an, cite) {
    const changed = [];
    if (!an || typeof an !== "object") return changed;
    const en = (v, list) => (list.includes(lc(v)) ? lc(v) : "");
    const rng = (r) => { const v = Array.isArray(r) ? r.map(Number).filter(isNum).slice(0, 2).sort((a, b) => a - b) : []; return v.length === 2 ? v : null; };
    const str = (v, k) => (typeof v === "string" && v.trim() ? cite(v, k) : "");
    const set = (obj, key, val, label) => { if (val === "" || val === null || val === undefined) return; if (JSON.stringify(obj[key]) === JSON.stringify(val)) return; obj[key] = val; if (label && !changed.includes(label)) changed.push(label); };
    const strs = (a, n, k) => (Array.isArray(a) ? a.map((t) => str(t, k)).filter(Boolean).slice(0, n) : []);
    for (const [k, n, l] of [["headline", 400, "headline"], ["thesis", 4000, "thesis"], ["summary", 2000, "summary"], ["priced_in", 1500, "what's priced in"]]) set(out, k, str(an[k], n), l);
    set(out, "confidence", en(an.confidence, ["low", "medium", "high"]), "confidence");
    if (Array.isArray(an.drivers)) {
      const old = Object.fromEntries((out.drivers || []).map((d) => [lc(d.title), d]));
      const dv = an.drivers.filter((d) => d && str(d.title, 120) && str(d.text, 1200)).slice(0, 7).map((d, i) => ({ rank: i + 1, title: str(d.title, 120), direction: en(d.direction, ["tailwind", "headwind", "mixed"]) || "mixed",
        magnitude: en(d.magnitude, ["high", "medium", "low"]) || "medium", horizon: trim(d.horizon, 20), text: str(d.text, 1200), sections: old[lc(d.title)]?.sections || (Array.isArray(d.sections) ? d.sections.slice(0, 10) : []) }));
      if (dv.length >= 2) set(out, "drivers", dv, "drivers");
    }
    if (Array.isArray(an.debates)) {
      const db = an.debates.filter((d) => d && str(d.question, 300) && (str(d.bull, 900) || str(d.bear, 900))).slice(0, 5).map((d) => ({ question: str(d.question, 300), bull: str(d.bull, 900), bear: str(d.bear, 900),
        resolves_with: str(d.resolves_with, 300), lean: en(d.lean, ["bull", "bear", "balanced"]) || "balanced", why: str(d.why, 400) }));
      if (db.length) set(out, "debates", db, "debates");
    }
    const cm = strs(an.change_mind, 6, 300); if (cm.length) set(out, "change_mind", cm, "what would change the view");
    if (an.scenarios && typeof an.scenarios === "object" && out.scenarios) {
      const ks = SCN.filter((k) => out.scenarios[k]);
      for (const k of ks) { const y = an.scenarios[k], o = out.scenarios[k]; if (!y || typeof y !== "object") continue; const lab = `${k} scenario`;
        for (const [f, n] of [["narrative", 1200], ["earnings", 400], ["valuation", 400]]) set(o, f, str(y[f], n), lab);
        const tg = strs(y.triggers, 5, 240); if (tg.length) set(o, "triggers", tg, lab);
        for (const f of ["eps_change", "pe", "price_move"]) set(o, f, rng(y[f]), lab);
        if (y.sections && typeof y.sections === "object") { o.sections = { ...(o.sections || {}) }; for (const [s2, t] of Object.entries(y.sections)) if (s2 in o.sections || Object.keys(o.sections).length === 0) set(o.sections, s2, str(t, 600), lab); }
      }
      // Probabilities only as a full set, normalized to 100.
      const ps = ks.map((k) => num(an.scenarios[k]?.probability));
      if (ps.every((p) => isNum(p) && p >= 0) && ps.reduce((a, b) => a + b, 0) > 0) {
        const tot = ps.reduce((a, b) => a + b, 0), np = ps.map((p) => Math.round((p / tot) * 100)); const bi = ks.indexOf("base"); np[bi >= 0 ? bi : 0] += 100 - np.reduce((a, b) => a + b, 0);
        if (ks.some((k, i) => out.scenarios[k].probability !== np[i])) { ks.forEach((k, i) => (out.scenarios[k].probability = np[i])); changed.push("scenario odds"); }
      }
    }
    if (an.opportunity && typeof an.opportunity === "object" && out.opportunity) { const o = out.opportunity, y = an.opportunity;
      set(o, "verdict", en(y.verdict, ["yes", "conditional", "no"]), "the opportunity"); set(o, "headline", str(y.headline, 300), "the opportunity"); set(o, "why", str(y.why, 1500), "the opportunity");
      const et = strs(y.entry_triggers, 5, 240); if (et.length) set(o, "entry_triggers", et, "the opportunity"); }
    if (an.profiles && typeof an.profiles === "object" && out.profiles) for (const [k, y] of Object.entries(an.profiles)) { const o = out.profiles[k]; if (!o || !y || typeof y !== "object") continue;
      set(o, "fit", en(y.fit, ["strong", "moderate", "weak"]), "investor verdicts"); set(o, "conviction", en(y.conviction, ["high", "medium", "low"]), "investor verdicts"); set(o, "verdict", str(y.verdict, 1200), "investor verdicts"); }
    return changed;
  }

  /**
   * Apply an update to the lead's result (returns a new result). upd: the update JSON (or null for "nothing material"); via: "code" | "triage" | "update".
   * Each revised horizon keeps where it came from; a daily history of the last 20 updates is kept.
   */
  function apply(res, upd, x, { today, via, tri = null, sources = [], sections = [], known = [] }) {
    const out = JSON.parse(JSON.stringify(res || {}));
    // The analysis keeps citing after today, so today's [D#] become lasting IDs (DU1, DU2, ...) with their source kept
    // in `refs` (the page adds them to the lead's sources); IDs already in the analysis, or known to the page, stay.
    const bracket = /\[([A-Z]{1,2}\d{1,4}(?:,\s*[A-Z]{1,2}\d{1,4})*)\]/g;
    const had = new Set(known); for (const m of JSON.stringify([analysisOf(res), res?.horizons || {}]).matchAll(bracket)) for (const id of m[1].split(/,\s*/)) if (!/^D\d+$/.test(id)) had.add(id);
    const byD = Object.fromEntries(sources.map((s) => [s.id, s])), mapD = {}, refs = [];
    let refN = num(out.ref_n) || 0;
    const citeA = (t, k) => trim(String(t || "").replace(bracket, (m, g) => { const keep = [...new Set(g.split(/,\s*/).map((id) => {
      if (byD[id]) { if (!mapD[id]) { mapD[id] = "DU" + ++refN; const s = byD[id]; refs.push({ id: mapD[id], kind: "N", date: s.date, source: s.source, title: s.title, url: s.url || "", symbol: s.symbol || "" }); } return mapD[id]; }
      return had.has(id) || /^I\d+$/.test(id) && (x.macro || []).some((r) => r.id === id) ? id : ""; }).filter(Boolean))]; return keep.length ? `[${keep.join(", ")}]` : ""; }).replace(/\s+([.,;:])/g, "$1"), k);
    const ids = new Set(sources.map((s) => s.id).concat((x.macro || []).map((m) => m.id)));
    const cite = (t, k = 600) => trim(String(t || "").replace(/\[([A-Z]{1,2}\d{1,4}(?:,\s*[A-Z]{1,2}\d{1,4})*)\]/g, (m, g) => { const keep = g.split(/,\s*/).filter((i) => ids.has(i)); return keep.length ? `[${keep.join(", ")}]` : ""; }), k);
    const en = (v, list, dflt) => (list.includes(lc(v)) ? lc(v) : dflt);
    const rng = (r) => (Array.isArray(r) ? r.map(Number).filter(isNum).slice(0, 2).sort((a, b) => a - b) : []);
    const hz = {};
    if (upd?.horizons) for (const h of HZ) { const y = upd.horizons[h], old = out.horizons?.[h]; if (!y || !old) continue;
      const revised = lc(y.status) === "revised";
      hz[h] = { status: revised ? "revised" : "unchanged", why: cite(y.why, 500) };
      if (revised) { const to = { call: Calls.norm(y.call, Calls.norm(old.call)), conviction: Calls.conviction(y.conviction) ?? Calls.conviction(old.conviction), conviction_why: cite(y.conviction_why, 300) || old.conviction_why || "", expected_move: rng(y.expected_move).length ? rng(y.expected_move) : old.expected_move, probability_up: isNum(num(y.probability_up)) ? Math.max(0, Math.min(100, Math.round(num(y.probability_up)))) : old.probability_up };
        to.vs_spy = Horizon.cleanVs(y.vs_spy) || null; to.away_from_anchor = cite(y.away_from_anchor, 400) || "";
        const from = { call: old.call, conviction: old.conviction ?? "", conviction_why: old.conviction_why || "", expected_move: old.expected_move, probability_up: old.probability_up };
        const same = ["call", "conviction", "expected_move", "probability_up"].every((k) => JSON.stringify(from[k]) === JSON.stringify(to[k])) && !to.vs_spy;
        // A revised call is the strategist's new view: code blends it with the anchor again (holdCalls), so drop the old blend's input.
        if (same) hz[h].status = "unchanged";
        else { Object.assign(old, to, { model: null, daily: { date: today, why: hz[h].why, from } }); hz[h].from = from; hz[h].to = to; } } }
    const sp = upd?.scenario_probabilities;
    if (sp && typeof sp === "object" && out.scenarios) { const ks = ["bull", "base", "bear"].filter((k) => out.scenarios[k] && isNum(num(sp[k])));
      const tot = ks.reduce((a, k) => a + num(sp[k]), 0);
      if (ks.length === Object.keys(out.scenarios).length && tot > 0) { const was = Object.fromEntries(ks.map((k) => [k, out.scenarios[k].probability]));
        ks.forEach((k) => (out.scenarios[k].probability = Math.round((num(sp[k]) / tot) * 100)));
        const diff = 100 - ks.reduce((a, k) => a + out.scenarios[k].probability, 0); if (out.scenarios.base) out.scenarios.base.probability += diff;
        if (ks.some((k) => was[k] !== out.scenarios[k].probability)) hz._scenarios = { from: was, to: Object.fromEntries(ks.map((k) => [k, out.scenarios[k].probability])) }; } }
    // The rest of the analysis, part by part.
    const scnWas = out.scenarios ? Object.fromEntries(SCN.filter((k) => out.scenarios[k]).map((k) => [k, out.scenarios[k].probability])) : null;
    const parts = upd?.analysis ? mergeAnalysis(out, upd.analysis, citeA) : [];
    if (parts.includes("scenario odds") && scnWas && !hz._scenarios) hz._scenarios = { from: scnWas, to: Object.fromEntries(Object.keys(scnWas).map((k) => [k, out.scenarios[k].probability])) };
    const rt = upd?.rethink && typeof upd.rethink === "object" ? { date: today, same: lc(upd.rethink.from_scratch) !== "different", why: cite(upd.rethink.why, 300) } : null;
    if (rt) out.rethink = rt;
    if (parts.length) out.ref_n = refN;
    if (parts.some((p) => CORE.test(p))) out.rewrites_since_full = (num(out.rewrites_since_full) || 0) + 1;
    if (refs.length) out.daily_refs = [...(out.daily_refs || []), ...refs].slice(-200);
    // How each passed event landed, kept with the analysis (the calendar shows it; the event leaves the open list).
    const evIds = new Set((x.passed || []).map((e) => e.id)), landedNow = [];
    // A full rewrite read everything again, outcomes included: its passed events count as taken in.
    if (via === "rewrite") for (const e of x.passed || []) if (e.kind !== "earnings" && !out.landed?.[e.id]?.text) {
      const t = `Taken into today's full rewrite of the analysis: see the thesis and scenarios${(e.outcome_ids || []).length ? ` [${e.outcome_ids.join(", ")}]` : ""}.`;
      out.landed = { ...(out.landed || {}), [e.id]: { date: today, text: t, sources: sources.filter((s) => (e.outcome_ids || []).includes(s.id)).map(({ id: i, title, url, source, date }) => ({ id: i, title, url, source, date })) } }; landedNow.push({ id: e.id, text: t }); }
    for (const ev of Array.isArray(upd?.events) ? upd.events : []) { const id = String(ev?.id || ""); const t = cite(ev?.landed, 400);
      if (!evIds.has(id) || !t) continue; landedNow.push({ id, text: /^unknown\.?$/i.test(t.trim()) ? "" : t });
      if (!/^unknown\.?$/i.test(t.trim())) out.landed = { ...(out.landed || {}), [id]: { date: today, text: t, sources: sources.filter((s) => t.includes(`[${s.id}]`)).map(({ id: i, title, url, source, date }) => ({ id: i, title, url, source, date })) } }; }
    const changed = Object.values(hz).some((v) => v.status === "revised") || !!hz._scenarios || parts.length > 0;
    const entry = { date: today, as_of: x.to, since: x.since, via, material: !!(upd ? upd.material !== false && (changed || (upd.changes || []).length) : false),
      headline: upd ? cite(upd.headline, 300) : trim(tri?.why || "Nothing material since the last update; the calls stand.", 300), summary: upd ? cite(upd.summary, 900) : "",
      changes: upd ? (Array.isArray(upd.changes) ? upd.changes : []).slice(0, 6).map((c) => ({ text: cite(c?.text, 400), effect: en(c?.effect, ["positive", "negative", "mixed"], "mixed") })).filter((c) => c.text) : [],
      horizons: hz, revised: changed, analysis: parts, events: landedNow, ...(rt ? { rethink: rt } : {}), filings: [...(prev_filings(res)), ...(x.filings || []).map((f) => f.url).filter(Boolean)].slice(-60), watch: upd ? (Array.isArray(upd.watch) ? upd.watch : []).slice(0, 3).map((w) => cite(w, 200)).filter(Boolean) : [], triggers: x.triggers || [],
      move: isNum(x.move) ? Math.round(x.move * 1000) / 10 : null, spy: isNum(x.spy) ? Math.round(x.spy * 1000) / 10 : null, z: isNum(x.z) ? Math.round(x.z * 10) / 10 : null,
      movers: (x.movers || []).slice(0, 5).map((m) => ({ symbol: m.symbol, ret: Math.round(m.ret * 1000) / 10 })),
      sections: sections.map((s) => ({ key: s.key, label: s.label, why: cite(s.why, 300), by: s.by, ok: s.ok !== false, ...(s.regulators ? { regulators: s.regulators } : {}), ...(s.error ? { error: trim(s.error, 200) } : {}) })),
      sources: sources.filter((s) => JSON.stringify(upd || {}).includes(s.id)).map(({ id, date, source, title, url }) => ({ id, date, source, title, url })) };
    const hist = [entry, ...((out.daily_history || []).filter((h) => h.date !== today))].slice(0, 20).map((h, i) => (i === 0 ? h : { date: h.date, via: h.via, material: h.material, revised: h.revised, headline: h.headline, move: h.move, ...(h.sections?.length ? { sections: h.sections.map((x) => ({ key: x.key, label: x.label, why: x.why, ok: x.ok })) } : {}) }));
    out.daily = entry; out.daily_history = hist;
    // When each section was last rewritten (the cool-down for the next day's picks).
    for (const sct of sections) if (sct.ok !== false) out.sections_rewritten = { ...(out.sections_rewritten || {}), [sct.key]: today };
    return { result: out, changed, parts, refs };
  }
  const prev_filings = (res) => res?.daily?.filings || [];

  const Daily = { prevState, deltas, deltaText, triagePrompt, updatePrompt, apply, HZ, SECTIONS, sectionBrief, pickSections, plan, dayBudget, borrowCap, bigDay, COST, scoreOf, drift, DRIFT, analysisOf, mergeAnalysis, scorecardText };
  if (typeof module !== "undefined" && module.exports) module.exports = Daily;
  else root.Daily = Daily;
})(typeof window !== "undefined" ? window : globalThis);
