/* Industry Scorer: the company analysis, applied from the industry's.
 *
 * The industry analysis is the deep work. A company inherits every part of it, code measures how hard each part hits
 * THIS company against its industry (its own sensitivities, revenue by region and segment, valuation, revisions,
 * positioning, credit, momentum, calendar, the places the industry analysis names it), and two quick calls run at
 * once: (A) for every industry component, does it apply more, the same, less or not at all here, which way, and why,
 * plus the six-level 1M-12M calls; (B) only what the industry can't know: the thesis, verdict, valuation, the
 * street, quality, the company's own risks and what to watch. Pure functions, no I/O.
 */
(function (root) {
  "use strict";
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const num = (x) => (x === null || x === undefined || x === "" ? NaN : Number(x));
  const trim = (s, k) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > k ? s.slice(0, k - 1) + "…" : s; };
  const lc = (s) => String(s ?? "").toLowerCase().trim();
  const p0 = (x, d = 0) => (isNum(x) ? `${(x * 100).toFixed(d)}%` : "n/a");
  const pc = (x, d = 1) => (isNum(x) ? `${x > 0 ? "+" : ""}${(x * 100).toFixed(d)}%` : "n/a");
  const fx = (x, d = 1) => (isNum(x) ? Number(x).toFixed(d) : "n/a");
  const noIds = (t, k) => trim(String(t || "").replace(/\s*\[[A-Z]{1,3}\d{1,5}(?:,\s*[A-Z]{1,3}\d{1,5})*\]/g, "").replace(/\s+([.,;:])/g, "$1"), k);
  const req = (f, g) => (typeof module !== "undefined" && module.exports ? require(f) : root[g]);
  const Outlook = req("./outlook.js", "Outlook");

  /** Every component of the industry analysis a company inherits, in the order shown. */
  const COMPONENTS = [
    ["outlook", "The industry's outlook"], ["verdict", "The lead's verdict & thesis"], ["scenarios", "Scenarios"], ["redteam", "Red team"], ["update", "The latest daily update"],
    ["macro", "Macro & rates"], ["world", "World events"], ["trade", "Trade"], ["regulation", "Regulation, litigation & deals"], ["cycle", "The cycle & KPIs"],
    ["chain", "Customers & suppliers"], ["earnings", "Estimates & revisions"], ["guidance", "Earnings calls & guidance"], ["valuation", "Valuation"], ["positioning", "Positioning"],
    ["credit", "Credit"], ["momentum", "Momentum"], ["history", "Times like this"], ["catalysts", "Dated catalysts"],
  ];
  const KEYS = COMPONENTS.map(([k]) => k), LABEL = Object.fromEntries(COMPONENTS);
  const APPLIES = ["more", "same", "less", "none"];

  /** The industry's conclusion for each component, one or two lines (code: no Claude). */
  function inherit({ res = {}, d = {}, R = {}, lens = {}, ind = null, today = "" }) {
    const o = {}, op = res.opportunity || {}, sc = res.scenarios || {}, m = res.math || {}, F = d.forward || {}, P = d.priced_in || {}, PO = d.positioning || {}, C = d.credit || {}, S = d.summary || {};
    if (ind?.calls) o.outlook = `${ind.provisional ? "Provisional: " : ""}${["1M", "3M", "6M", "12M"].filter((h) => ind.calls[h]).map((h) => `${h} ${ind.calls[h].call}`).join(", ")}. ${noIds(ind.headline, 200)}`;
    o.verdict = `${op.verdict ? `${op.verdict.toUpperCase()}: ` : ""}${noIds(op.headline || res.headline, 240)}`;
    const sk = ["bull", "base", "bear"].filter((k) => sc[k]);
    if (sk.length) o.scenarios = `${sk.map((k) => `${k} ${sc[k].probability ?? "?"}% (${sc[k].price_move ?? "?"}%)`).join(", ")}${isNum(m.expected_return) ? `; weighted ${m.expected_return}%` : ""}.`;
    if (res.redteam) o.redteam = `${res.redteam.stance || ""}: ${noIds(res.redteam.thesis, 220)}`;
    if (res.daily?.date) o.update = `${res.daily.date}: ${noIds(res.daily.headline, 220)}`;
    if (R.macro) o.macro = `${R.macro.regime || ""}: ${noIds(R.macro.headline, 220)}`;
    const W = (R.world?.dives || []).slice(0, 3);
    if (W.length) o.world = W.map((x) => `${trim(x.title, 70)} (${x.stance || "?"})`).join("; ");
    if (R.trade?.verdict) o.trade = `${R.trade.verdict.rating || ""}${isNum(num(R.trade.verdict.health?.score)) ? ` (health ${R.trade.verdict.health.score})` : ""}: ${noIds(R.trade.verdict.headline, 200)}`;
    if (R.regverdict) o.regulation = `${R.regverdict.stance || ""}, ${R.regverdict.intensity || ""}: ${noIds(R.regverdict.headline, 200)}`;
    if (R.kpi) o.cycle = `${R.kpi.cycle_position || "?"} cycle, ${R.kpi.pricing_power?.level || "?"} pricing power. ${noIds(R.kpi.summary, 180)}`;
    if ((R.chain?.partners || []).length) o.chain = `Depends most on ${(R.chain.partners || []).slice(0, 4).map((x) => x.symbol || x.name).join(", ")}.${R.chain.summary ? ` ${noIds(typeof R.chain.summary === "string" ? R.chain.summary : R.chain.summary?.text, 140)}` : ""}`;
    if (F.n) o.earnings = `Next-12-month EPS growth ${pc(F.ntm_eps_growth, 0)}; revisions 30 days ${pc(F.rev30)} (${F.up30 ?? "?"} up, ${F.down30 ?? "?"} down).`;
    if (R.calls?.summary) o.guidance = `${R.calls.summary.direction || ""}: ${noIds(R.calls.summary.text, 220)}`;
    if (P.verdict || isNum(num(F.fwd_pe))) o.valuation = `Forward P/E ${fx(F.fwd_pe)}; the price implies ${pc(P.implied_eps_growth, 0)} EPS growth a year vs consensus ${pc(P.consensus_ntm_growth, 0)}${P.verdict ? ` (${P.verdict})` : ""}.`;
    if (PO.n) o.positioning = `${PO.label ? PO.label + ": " : ""}insiders ${PO.insiders?.purchases ?? "?"} buys vs ${PO.insiders?.sales ?? "?"} sales; short interest ${p0(PO.short?.capw, 1)}.`;
    if (C.cmdi) o.credit = `Credit stress at the ${Math.round((C.cmdi.market_pctl || 0) * 100)}th percentile; weakest: ${(C.weak || []).slice(0, 3).map((w) => w.symbol).join(", ") || "none named"}.`;
    o.momentum = `Industry 1M ${pc(S.ret_cw_1M)}, 3M ${pc(S.ret_cw_3M)}, 1Y ${pc(S.ret_cw_1Y)}; ${p0(S.breadth_3M)} of its companies up over 3M.`;
    if (R.history?.read) o.history = noIds(R.history.read, 240);
    const ev = (lens.calendar || []).filter((e) => !today || e.date >= today).map((e, i) => ({ e, r: (e.importance === "high" ? 0 : e.importance === "medium" ? 1 : 2) * 1000 + i })).sort((a, b) => a.r - b.r).slice(0, 4).map((x) => x.e).sort((a, b) => (a.date < b.date ? -1 : 1));
    if (ev.length) o.catalysts = ev.map((e) => `${e.date} ${trim(e.title, 70)}`).join("; ");
    return o;
  }

  /**
   * How hard each component hits THIS company, against its industry (code). c: {sym, peers (Company.peerTable),
   * lens (Company.lensInputs), sens (the company's Sensitivity.measure), indSens (the industry's), insider, quality,
   * mentions, calls (the industry's calls report), credit (the industry's), times (Regimes.company), own (its next
   * report date), ind (the industry's outlook)}. Returns {key: {text, tone}}: tone more | less | same | null.
   */
  function measure(c) {
    const o = {}, P = Object.fromEntries((c.peers || []).map((r) => [r.key, r])), L = c.lens || {}, sym = c.sym;
    const vsMed = (k, fmt = p0, label = null) => { const r = P[k]; if (!r) return null; return `${label || r.label} ${fmt(r.value)} vs industry median ${fmt(r.median)} (percentile ${r.pct ?? "n/a"})`; };
    const mentionsIn = (re) => (c.mentions || []).filter((m) => re.test(lc(m.section))).length;
    const put = (k, parts, tone = null) => { const t = parts.filter(Boolean).join("; "); if (t) o[k] = { text: t, tone }; };
    // The industry-level parts: how often the analysis names the company there.
    const named = (k, re, what) => { const n = mentionsIn(re); put(k, [n ? `${sym} is named ${n} time${n === 1 ? "" : "s"} in ${what}` : `${sym} isn't named in ${what}`], n ? "more" : null); };
    named("verdict", /lead|thesis|opportunit|strateg|driver|debate/, "the lead's thesis");
    named("scenarios", /scenario/, "the scenarios");
    named("redteam", /red ?team|risk/, "the red team and risks");
    named("update", /daily|update/, "the daily updates");
    named("world", /world|geopolit/, "the world-events report");
    // Macro: its own sensitivities next to the industry's.
    const facs = (c.sens?.factors || []).filter((f) => f.key !== "market"), ifacs = Object.fromEntries((c.indSens?.factors || []).map((f) => [f.key, f]));
    const fm = facs.slice(0, 4).map((f) => { const a = f.partial?.effect ?? f.total?.effect, b = ifacs[f.key]?.partial?.effect ?? ifacs[f.key]?.total?.effect; return isNum(a) ? `${f.shock_label || f.label}: ${pc(a, 2)}${isNum(b) ? ` vs industry ${pc(b, 2)}` : ""}` : null; }).filter(Boolean);
    const mk = (c.sens?.factors || []).find((f) => f.key === "market"), imk = ifacs.market;
    const mb = mk?.total?.beta, ib = imk?.total?.beta;
    const sumA = facs.reduce((a, f) => a + Math.abs(f.partial?.effect ?? 0), 0), sumB = facs.reduce((a, f) => a + Math.abs(ifacs[f.key]?.partial?.effect ?? 0), 0);
    put("macro", [isNum(mb) ? `market beta ${fx(mb, 2)}${isNum(ib) ? ` vs industry ${fx(ib, 2)}` : ""}` : null, ...fm], sumB > 0 ? (sumA > 1.25 * sumB ? "more" : sumA < 0.75 * sumB ? "less" : "same") : null);
    // Trade: its revenue in the industry's riskiest countries.
    const risky = (L.countries || []).filter((x) => /adverse|hostile|negative|deteriorat/.test(lc(x.stance + " " + x.trajectory)) || /high|severe/.test(lc(x.threat)));
    const regs = (L.regions || []).filter((g) => isNum(g.share));
    const exposed = regs.filter((g) => (g.countries || []).some((cn) => risky.some((r) => lc(r.country) === lc(cn))));
    const shareRisk = exposed.reduce((a, g) => a + g.share, 0);
    put("trade", [regs.length ? `revenue by region: ${regs.slice(0, 4).map((g) => `${g.region} ${p0(g.share)}`).join(", ")}` : `${sym} reports no revenue by region`,
      risky.length ? `${p0(shareRisk)} of revenue in regions tied to the industry's riskiest trade partners (${risky.slice(0, 3).map((x) => x.country).join(", ")})` : null],
      regs.length && risky.length ? (shareRisk > 0.3 ? "more" : shareRisk < 0.1 ? "less" : "same") : null);
    // Regulation, litigation and deals that name it; winners and losers.
    const hits = (L.regItems || []).filter((x) => (x.names || []).includes(sym) || new RegExp(`\\b${sym}\\b`).test(x.title + " " + x.text + " " + (x.parties || "")));
    const win = (L.regv?.winners || []).some((x) => x.symbol === sym), lose = (L.regv?.losers || []).some((x) => x.symbol === sym);
    put("regulation", [hits.length ? `named in ${hits.length} policy, litigation or deal item${hits.length === 1 ? "" : "s"}: ${hits.slice(0, 2).map((x) => `${x.kind} "${trim(x.title, 60)}"`).join("; ")}` : "not named in any policy, litigation or deal item",
      win ? "on the industry's list of regulatory winners" : lose ? "on the industry's list of regulatory losers" : null], hits.length || win || lose ? "more" : "less");
    // The cycle: its revenue in hot or cool segments, its growth and margins vs the industry.
    const hot = (L.segments || []).filter((x) => /^hot/.test(lc(x.match))), cool = (L.segments || []).filter((x) => /^cool/.test(lc(x.match)));
    put("cycle", [hot.length || cool.length ? `${p0(hot.reduce((a, x) => a + (x.share || 0), 0))} of revenue in the industry's hot segments, ${p0(cool.reduce((a, x) => a + (x.share || 0), 0))} in cool ones` : null, vsMed("rev_growth"), vsMed("op_margin")],
      P.rev_growth?.pct >= 70 ? "more" : P.rev_growth?.pct <= 30 ? "less" : "same");
    // Customers and suppliers: is it one of the partners the industry depends on, or does it depend on them?
    const isP = (L.chain || []).filter((x) => x.symbol === sym), dep = (L.chain || []).filter((x) => (x.depends || []).includes(sym));
    put("chain", [isP.length ? `${sym} is itself one of the partners the industry depends on (${isP[0].role || ""})` : null, dep.length ? `listed as depending on ${dep.slice(0, 3).map((x) => x.symbol || x.name).join(", ")}` : null,
      !isP.length && !dep.length ? `not on the industry's list of key customers and suppliers` : null], isP.length || dep.length ? "more" : null);
    put("earnings", [vsMed("ntm_growth", pc, "Next-12-month EPS growth"), vsMed("rev30", pc, "EPS revisions 30 days")], P.rev30?.pct >= 70 ? "more" : P.rev30?.pct <= 30 ? "less" : "same");
    // Its own earnings call, from the industry's calls report.
    const own = (c.calls?.companies || []).find((x) => x.symbol === sym);
    put("guidance", [own ? `its own call (${own.period || "latest"}): ${own.tone || "?"}${own.guidance ? `, guidance ${own.guidance}` : ""}. ${noIds(own.tone_why, 160)}` : `its call wasn't among the ones the industry team read`], own ? (/more confident|raised/.test(lc(own.tone + " " + own.guidance)) ? "more" : /less confident|cautious|lowered|withdrawn/.test(lc(own.tone + " " + own.guidance)) ? "less" : "same") : null);
    put("valuation", [vsMed("fwd_pe", (x) => fx(x), "Forward P/E"), vsMed("pe", (x) => fx(x), "P/E"), c.implied ? `the price implies ${p0(c.implied.g, 1)} FCF growth a year` : null], P.fwd_pe?.pct >= 70 ? "more" : P.fwd_pe?.pct <= 30 ? "less" : "same");
    put("positioning", [vsMed("short_pct", (x) => p0(x, 1), "Short interest"), c.insider ? `insiders ${c.insider.purchases ?? "?"} buys, sales ${fx(c.insider.sales_vs_norm, 2)}x normal` : null], P.short_pct?.pct >= 75 ? "more" : null);
    const weak = (c.credit?.weak || []).some((w) => w.symbol === sym);
    put("credit", [vsMed("int_cover", (x) => fx(x) + "x", "Interest cover"), vsMed("nd_ebitda", (x) => fx(x) + "x", "Net debt / EBITDA"), weak ? `on the industry's list of weakest balance sheets` : null], weak || P.int_cover?.pct <= 25 ? "more" : P.int_cover?.pct >= 75 ? "less" : "same");
    put("momentum", [vsMed("ret_1M", pc, "1M"), vsMed("ret_3M", pc, "3M"), vsMed("ret_1Y", pc, "1Y")], null);
    const T = c.times; const hh = T?.base?.["12M"] || T?.base?.["6M"];
    put("history", [T?.episodes?.length ? `${T.episodes.filter((e) => e.traded).length} of the industry's ${T.episodes.length} closest past setups had ${sym} trading` : null,
      hh?.n ? `after them it ${isNum(hh.vs_ind_median) ? `beat its industry by a median ${pc(hh.vs_ind_median)}` : isNum(hh.median) ? `moved a median ${pc(hh.median)}` : "moved"} (n=${hh.n})` : null], null);
    const evs = (L.calendar || []).filter((e) => (e.tickers || []).includes(sym));
    put("catalysts", [c.ownReport ? `${sym} reports ${c.ownReport}` : null, evs.length ? `${evs.length} of the industry's dated events name ${sym}: ${evs.slice(0, 2).map((e) => `${e.date} ${trim(e.title, 60)}`).join("; ")}` : null], evs.length ? "more" : null);
    if (c.ind?.calls) put("outlook", [`the industry: ${["1M", "3M", "6M", "12M"].filter((h) => c.ind.calls[h]).map((h) => `${h} ${c.ind.calls[h].call}`).join(", ")}`, isNum(mb) ? `${sym}'s market beta ${fx(mb, 2)}${isNum(ib) ? ` vs the industry's ${fx(ib, 2)}` : ""}` : null], null);
    return o;
  }
  const measureText = (M) => KEYS.filter((k) => M[k]).map((k) => `${LABEL[k]}: ${M[k].text}${M[k].tone ? ` [code's read: hits it ${M[k].tone}]` : ""}`).join("\n");

  const CALL = `{"call": "${Outlook.LEVELS.join(" | ")}", "why": "3-4 sentences: where it goes over this window and the two or three things that decide it, with numbers", "for": ["2-3 short reasons"], "against": ["the case against, 1-2 short reasons, and why it loses"], "flips_it": "one measurable, dated condition that would flip it"}`;
  const A_SCHEMA = `{"headline": "one sentence: where ${"${SYM}"} is going and why, against what the industry analysis says",
 "components": [{"key": "${KEYS.join(" | ")}", "applies": "more | same | less | none", "effect": "up | down | mixed", "why": "one or two sentences: what the industry finding means for this company specifically, with its own numbers"}],
 "calls": {"1M": ${CALL}, "3M": {...}, "6M": {...}, "12M": {...}},
 "verdict": {"agrees": true, "why": "one sentence: does the industry lead's verdict hold for this company, and if not why"}}`;

  /** Call A: every industry component applied to the company, and the 1M-12M calls. */
  function applyPrompt(c) {
    return `You are the analyst covering ${c.name} (${c.sym}) in the US-listed "${c.industry}" industry. Today is ${c.today}. Your team has already analyzed the whole industry in depth: its work is below, every component cut to its conclusions. Your job is to APPLY it to ${c.sym}: for each component, does it hit ${c.sym} more, the same, less, or not at all, which way does it push the stock, and why, using ${c.sym}'s own numbers. Then say where ${c.sym} is going.

=== THE INDUSTRY ANALYSIS ===
${c.digest}

=== ${c.sym}: THE COMPANY ===
${trim(c.company, 7000)}

=== HOW HARD EACH COMPONENT HITS ${c.sym} (code-measured, against its industry) ===
${c.measured || "(none)"}
${(c.mentions || []).length ? `\n=== WHERE THE INDUSTRY ANALYSIS NAMES ${c.sym} ===\n${c.mentions.slice(0, 20).map((m) => `${m.section}: ${trim(m.text, 200)}`).join("\n")}` : ""}
${(c.windows || []).length ? `\n=== ${c.sym}'S WINDOWS (code) ===\n${c.windows.map((x) => `${x.h}: trailing ${x.trailing ?? "?"}%, a normal move ±${x.sigma ?? "?"}%, higher ${x.base_up ?? "?"}% of the time in its history; ${x.own ? `reports ${x.own}` : "no report in the window"}${(x.peers || []).length ? `; peers reporting ${x.peers.map((p) => `${p.symbol} ${p.date}`).join(", ")}` : ""}.`).join("\n")}` : ""}
${(c.news || []).length ? `\n=== ${c.sym}'S RECENT NEWS ===\n${c.news.slice(0, 10).map((x) => `${x.date ? x.date + " " : ""}${trim(x.title, 150)}`).join("\n")}` : ""}

HOW TO ANSWER
- One entry in "components" for EVERY component, in this order: ${KEYS.join(", ")}. "applies": how hard the industry's finding hits ${c.sym} compared with the industry as a whole (start from code's read and correct it where you know better); "effect": which way it pushes ${c.sym} over the next year; "why": one or two sentences with ${c.sym}'s numbers. Short.
- Then the four calls on ${c.sym}'s OWN direction (higher or lower at the end of the window), six levels, no neutral ("slightly" = close, plain = clear, "strongly" = most components agree decisively, rare). Start from the industry's outlook and move it by what applies more or less to ${c.sym}. A flip between windows must say what changes in between.
- Plain words, specific numbers, no hedging filler.

Reply with ONLY this JSON:
${A_SCHEMA.replace("${SYM}", c.sym)}`;
  }

  /** Clean call A: the applied components, and an outlook (the components are its evidence). */
  function cleanApply(raw, { today = "" } = {}) {
    if (!raw || typeof raw !== "object") return null;
    const components = {};
    for (const e of Array.isArray(raw.components) ? raw.components : []) {
      const k = KEYS.includes(lc(e?.key)) ? lc(e.key) : (COMPONENTS.find(([, l]) => lc(l) === lc(e?.key)) || [])[0]; if (!k || components[k]) continue;
      const a = lc(e.applies), f = lc(e.effect);
      components[k] = { applies: APPLIES.find((x) => a.startsWith(x)) || (/not|n\/a/.test(a) ? "none" : "same"), effect: /up|bull|positive/.test(f) ? "up" : /down|bear|negative/.test(f) ? "down" : "mixed", why: trim(e.why, 400) };
    }
    const W = { more: 3, same: 2, less: 1, none: 1 };
    const evidence = Object.entries(components).map(([k, x]) => ({ input: k, points: x.applies === "none" ? "mixed" : x.effect, weight: W[x.applies], why: x.why }));
    const outlook = raw.calls ? Outlook.clean({ headline: raw.headline, evidence, calls: raw.calls, verdict: raw.verdict }, { today, inputs: COMPONENTS }) : null;
    return { components, outlook, headline: trim(raw.headline, 300), missing: KEYS.filter((k) => !components[k]) };
  }

  /** Call B: only what the industry analysis can't know (Company's own field shapes, so the page renders them as before). */
  function ownPrompt(c, fields) {
    return `You are a senior equity analyst on ${c.name} (${c.sym}), in the US-listed "${c.industry}" industry. Today is ${c.today}. Your team's industry analysis is done and a colleague is applying it to ${c.sym} at the same time; you write ONLY what the industry analysis can't know: the company's own thesis and verdict, its valuation against its peers, where it differs from Wall Street, its quality and management, its own risks and what to watch. Must be done in under a minute: keep it tight.

THE INDUSTRY IN BRIEF
Lead's verdict: ${trim(c.indVerdict, 600)}
Industry outlook: ${trim(c.indOutlook, 400)}

${trim(c.company, 9000)}
${c.transcript ? `\nITS LATEST EARNINGS CALL (excerpt)\n${trim(c.transcript, 5000)}` : ""}
${(c.news || []).length ? `\nRECENT NEWS\n${c.news.slice(0, 12).map((x) => `${x.date ? x.date + " " : ""}${trim(x.title, 150)}`).join("\n")}` : ""}

Reply with ONLY this JSON:
{${fields}}
Sizes: the thesis is ONE paragraph on what is specific to ${c.sym} (not the industry story); valuation, street, quality and management 1-2 sentences each; 2-3 street differences; 3 company-specific risks; 3 watch items; 2-3 catalysts. Plain words, specific numbers.`;
  }
  const OWN_KEYS = ["headline", "verdict", "thesis", "vs_industry", "valuation", "street", "quality", "management", "risks", "watch", "catalysts"];

  const Apply = { COMPONENTS, KEYS, LABEL, APPLIES, inherit, measure, measureText, applyPrompt, cleanApply, ownPrompt, OWN_KEYS };
  if (typeof module !== "undefined" && module.exports) module.exports = Apply;
  else root.Apply = Apply;
})(typeof window !== "undefined" ? window : globalThis);
