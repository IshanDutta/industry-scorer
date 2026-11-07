/* Industry Scorer: the outlook. Where the industry (or one company) is going over the next month, 3, 6 and 12 months,
 * on one six-level scale (strongly bearish, bearish, slightly bearish, slightly bullish, bullish, strongly bullish: no
 * neutral), and why. Its own direction only: higher or lower at the end of the window.
 *
 * Cheap by design: ONE call on a compact digest of every component (the lead's verdict, thesis, scenarios and red
 * team, the latest daily update, macro, world events, trade, regulation, the cycle and KPIs, estimates and revisions,
 * management guidance, valuation and what's priced in, positioning, credit, momentum and levels, past setups and the
 * statistical model, dated catalysts) rather than the whole dossier. The model argues against itself inside the same
 * answer; code checks the calls against the evidence and each other, and only a contradiction costs a second (small)
 * call. Pure functions, no I/O.
 */
(function (root) {
  "use strict";
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const trim = (s, k) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > k ? s.slice(0, k - 1) + "…" : s; };
  const lc = (s) => String(s ?? "").toLowerCase().trim();
  const pc = (x, d = 1) => (isNum(x) ? `${x > 0 ? "+" : ""}${(x * 100).toFixed(d)}%` : "n/a");
  const p0 = (x, d = 0) => (isNum(x) ? `${(x * 100).toFixed(d)}%` : "n/a");
  const txt = (x, k) => trim(typeof x === "string" ? x : Array.isArray(x) ? x.map((y) => (typeof y === "string" ? y : [y?.date, y?.event || y?.title || y?.trigger || y?.condition || y?.text, y?.level, y?.why ? `(${y.why})` : ""].filter(Boolean).join(" "))).join("; ") : x && typeof x === "object" ? [x.date, x.event || x.title || x.text || x.condition, x.why].filter(Boolean).join(" ") : "", k);
  const fx = (x, d = 1) => (isNum(x) ? Number(x).toFixed(d) : "n/a");
  const J = (x, k) => trim(typeof x === "string" ? x : JSON.stringify(x ?? ""), k);
  const HZ = ["1M", "3M", "6M", "12M"];
  const HZ_LABEL = { "1M": "Next month", "3M": "Next 3 months", "6M": "Next 6 months", "12M": "Next 12 months" };
  const DAYS = { "1M": 21, "3M": 63, "6M": 126, "12M": 252 };

  /** The six levels, most bearish first. No neutral. */
  const LEVELS = ["strongly bearish", "bearish", "slightly bearish", "slightly bullish", "bullish", "strongly bullish"];
  const SIGN = { "strongly bearish": -3, bearish: -2, "slightly bearish": -1, "slightly bullish": 1, bullish: 2, "strongly bullish": 3 };
  function level(s) {
    const t = lc(s).replace(/[_-]/g, " ").replace(/\s+/g, " ");
    const side = /bear|down|lower|fall|negative/.test(t) ? "bearish" : /bull|up\b|higher|rise|positive/.test(t) ? "bullish" : null;
    if (!side) return null;
    if (/strong|very|sharp/.test(t)) return "strongly " + side;
    if (/slight|mild|modest|lean|weak|small/.test(t)) return "slightly " + side;
    return side;
  }
  const cls = (l) => (SIGN[l] > 0 ? "pos" : SIGN[l] < 0 ? "neg" : "neu");
  const label = (l) => (l ? l[0].toUpperCase() + l.slice(1) : "");

  /** Every component the industry's outlook weighs. */
  const INPUTS = [
    ["verdict", "The lead's verdict & thesis"], ["scenarios", "Scenarios & their math"], ["redteam", "Red team & risks"], ["update", "The latest daily update"],
    ["macro", "Macro & rates"], ["world", "World events"], ["trade", "Trade & supply chain"], ["regulation", "Regulation & policy"],
    ["cycle", "The cycle, pricing power & KPIs"], ["earnings", "Estimates & revisions"], ["guidance", "Management guidance"], ["valuation", "Valuation & what's priced in"],
    ["positioning", "Positioning, insiders & shorts"], ["credit", "Credit"], ["momentum", "Momentum & price levels"], ["history", "Past setups & the statistical model"], ["catalysts", "Dated catalysts ahead"],
  ];
  /** A company's: its industry's outlook first, then the company itself. */
  const CO_INPUTS = [
    ["industry", "The industry's outlook"], ["lead", "The industry lead's verdict"], ["business", "Business mix & segments"], ["earnings", "Earnings, estimates & revisions"],
    ["guidance", "The latest earnings call & guidance"], ["valuation", "Valuation vs peers & its history"], ["quality", "Balance sheet & quality"], ["street", "Wall Street"],
    ["momentum", "Momentum & price action"], ["history", "Past setups like today"], ["catalysts", "Dated catalysts ahead"], ["macro", "Macro & rates"],
    ["world", "World events & trade"], ["regulation", "Regulation & legal"], ["competition", "Competitive position"], ["risks", "Risks & red flags"],
  ];
  const ALIAS = { thesis: "verdict", opportunity: "verdict", scenario: "scenarios", "red team": "redteam", risks: "redteam", daily: "update", rates: "macro", geopolitics: "world",
    tariffs: "trade", supply: "trade", policy: "regulation", legal: "regulation", kpi: "cycle", "pricing power": "cycle", estimates: "earnings", revisions: "earnings", "earnings call": "guidance",
    priced: "valuation", insiders: "positioning", shorts: "positioning", flows: "positioning", "price action": "momentum", levels: "momentum", "past setups": "history", "statistical": "history",
    "times like this": "history", calendar: "catalysts", events: "catalysts", industry: "industry", segments: "business", "balance sheet": "quality", consensus: "street", analysts: "street", moat: "competition", peers: "competition", "red flags": "risks" };
  function keyOf(s, inputs) {
    const t = lc(s), keys = inputs.map(([k]) => k);
    if (keys.includes(t)) return t;
    const hit = inputs.find(([, l]) => lc(l) === t); if (hit) return hit[0];
    for (const k of keys) if (t.startsWith(k)) return k;
    for (const [a, k] of Object.entries(ALIAS)) if (t.includes(a) && keys.includes(k)) return k;
    return null;
  }

  // ------------------------------------------------------------------ the digest: every component, compactly
  /**
   * Every component of the industry's analysis, cut to its conclusions (~8-10k tokens). res: the lead's result; d: the
   * industry doc; R: {kpi, macro, world, trade, trademap, reg, regverdict, chain, calls, history}; cal: the calendar;
   * facts: Horizon.horizonFacts; today.
   */
  function digest({ res = {}, d = {}, R = {}, cal = null, facts = [], today = "" }) {
    const o = [], S = d.summary || {}, F = d.forward || {}, P = d.priced_in || {}, PO = d.positioning || {}, C = d.credit || {}, L = d.plan?.index_levels || {}, CN = d.concentration || {};
    const sec = (t, body) => { if (body && String(body).trim()) o.push(`## ${t}\n${body}`); };
    // The lead strategist
    const op = res.opportunity || {}, sc = res.scenarios || {}, m = res.math || {};
    sec("THE LEAD STRATEGIST'S VERDICT AND THESIS", [`Headline: ${trim(res.headline, 300)}`, op.verdict ? `Opportunity verdict: ${op.verdict.toUpperCase()}: ${trim(op.headline, 200)} ${trim(op.why, 700)}${(op.entry_triggers || []).length ? ` Triggers: ${op.entry_triggers.slice(0, 3).map((t) => trim(t, 140)).join("; ")}` : ""}` : "",
      res.thesis ? `Thesis: ${trim(res.thesis, 1500)}` : "", res.priced_in ? `Priced in: ${trim(res.priced_in, 500)}` : "",
      (res.drivers || []).length ? `Drivers: ${res.drivers.slice(0, 7).map((x) => `${trim(x.title, 80)} (${x.direction || "?"}, ${x.magnitude || "?"})`).join("; ")}` : "",
      (res.debates || []).length ? `Debates: ${res.debates.slice(0, 5).map((x) => `${trim(x.question, 120)} -> ${x.lean || "?"}`).join("; ")}` : ""].filter(Boolean).join("\n"));
    const sk = ["bull", "base", "bear"].filter((k) => sc[k]);
    sec("SCENARIOS (12 months)", sk.length ? `${sk.map((k) => `${k} ${sc[k].probability ?? "?"}%: price ${sc[k].price_move ?? "?"}%, EPS ${sc[k].eps_change ?? "?"}%: ${trim(sc[k].narrative, 220)}`).join("\n")}${isNum(m.expected_return) ? `\nProbability-weighted 12M return ${m.expected_return}%, chance of a loss ${m.prob_loss ?? "?"}%.` : ""}` : "");
    sec("THE EARLIER 1M-12M CALLS", HZ.filter((h) => res.horizons?.[h]).map((h) => { const x = res.horizons[h]; return `${h}: ${x.call}, ${(x.expected_move || []).join(" to ")}%, ${x.probability_up ?? "?"}% up. ${trim(x.drivers, 260)}`; }).join("\n"));
    const rt = res.redteam;
    sec("RED TEAM", rt ? `${rt.stance || ""}: ${trim(rt.thesis, 500)}\n${(rt.arguments || []).slice(0, 5).map((a) => `[${a.severity}] ${trim(a.claim, 180)}`).join("\n")}${(rt.premortem || []).length ? `\nPre-mortem: ${rt.premortem.slice(0, 2).map((p) => `${p.probability}% ${trim(p.what_happened, 160)}`).join("; ")}` : ""}` : "");
    if ((res.change_mind || []).length) sec("WHAT WOULD CHANGE THE LEAD'S MIND", res.change_mind.slice(0, 4).map((t) => trim(typeof t === "string" ? t : t?.text || JSON.stringify(t), 180)).join("\n"));
    const dy = res.daily;
    sec("THE LATEST DAILY UPDATE", dy?.date ? `${dy.date}: ${trim(dy.headline, 240)} ${trim(dy.summary, 600)}${(dy.changes || []).length ? `\nChanges: ${dy.changes.slice(0, 5).map((c) => `${c.effect}: ${trim(c.text, 160)}`).join("; ")}` : ""}${(res.daily_history || []).length > 1 ? `\nEarlier: ${res.daily_history.slice(1, 4).map((h) => `${h.date} ${trim(h.headline, 120)}`).join("; ")}` : ""}` : "");
    // The analysts
    const MA = R.macro;
    sec("MACRO", MA ? `${MA.regime || ""}: ${trim(MA.headline, 240)} ${trim(MA.summary, 500)}\n${HZ.filter((h) => MA.horizons?.[h]).map((h) => `${h}: ${MA.horizons[h].call}: ${trim(MA.horizons[h].text, 220)}`).join("\n")}${MA.flip ? `\nFlips if: ${txt(MA.flip, 300)}` : ""}` : "");
    const W = R.world;
    sec("WORLD EVENTS", (W?.dives || []).slice(0, 6).map((x) => `${trim(x.title, 120)} (${x.stance || "?"}, ${x.status || "?"}): ${trim(x.summary, 260)}`).join("\n"));
    const T = R.trade;
    sec("TRADE AND SUPPLY CHAIN", [T?.verdict ? `${T.verdict.rating || ""} (health ${T.verdict.health?.score ?? "?"}): ${trim(T.verdict.headline, 260)} ${trim(T.verdict.summary, 400)}` : "", R.trademap?.summary ? `Trade map: ${J(R.trademap.summary, 300)}` : ""].filter(Boolean).join("\n"));
    const RV = R.regverdict;
    sec("REGULATION AND POLICY", [RV ? `${RV.stance || ""}, ${RV.intensity || ""}: ${trim(RV.headline, 220)} ${trim(RV.summary, 400)}${(RV.timeline || []).length ? `\nNext: ${RV.timeline.filter((t) => !t.date || String(t.date) >= today.slice(0, 7)).slice(0, 4).map((t) => txt([t], 120)).join("; ")}` : ""}` : "", R.reg?.summary ? `Policy, litigation, deals: ${J(R.reg.summary, 300)}` : ""].filter(Boolean).join("\n"));
    const K = R.kpi;
    sec("THE CYCLE, PRICING POWER AND KPIS", K ? `${trim(K.summary, 450)}\nCycle: ${K.cycle_position || "?"}${K.cycle_text ? ` (${trim(K.cycle_text, 200)})` : ""}. Pricing power: ${K.pricing_power?.level || "?"}: ${trim(K.pricing_power?.text, 240)}\nHot: ${(K.hot_segments || []).slice(0, 3).map((x) => trim(x.name, 60)).join("; ")}. Cool: ${(K.cool_segments || []).slice(0, 3).map((x) => trim(x.name, 60)).join("; ")}.${(K.next_triggers || []).length ? `\nNext triggers: ${K.next_triggers.slice(0, 4).map((x) => txt([x], 160)).join("; ")}` : ""}` : "");
    sec("ESTIMATES AND REVISIONS (code)", F.n ? `Forward P/E ${fx(F.fwd_pe)}; next-12-month EPS growth ${pc(F.ntm_eps_growth, 0)}; FY1 revenue growth ${pc(F.fy1_rev_growth, 0)}; EPS revisions last 30 days ${pc(F.rev30)}, 90 days ${pc(F.rev90)} (${F.up30 ?? "?"} up vs ${F.down30 ?? "?"} down; breadth ${fx(F.breadth, 2)}).` : "");
    sec("MANAGEMENT GUIDANCE (the latest earnings calls)", R.calls?.summary ? `${R.calls.summary.direction || ""}: ${trim(R.calls.summary.text, 700)}` : "");
    sec("VALUATION AND WHAT'S PRICED IN (code)", P.verdict ? `The price implies ${pc(P.implied_eps_growth, 0)} EPS growth a year (consensus ${pc(P.consensus_ntm_growth, 0)}; 5-year revenue growth ${pc(P.hist_rev_cagr_5y, 0)}): ${P.verdict}. Cost of equity ${p0(P.r, 1)}, beta ${fx(P.beta, 2)}.${isNum(CN.fwd_pe_all) ? ` Forward P/E ${fx(CN.fwd_pe_all)} (${fx(CN.fwd_pe_ex3)} without the top three; the top three are ${p0(CN.top3_weight)} of the industry).` : ""}` : "");
    sec("POSITIONING (code)", PO.n ? `Insiders: ${PO.insiders?.purchases ?? "?"} buys vs ${PO.insiders?.sales ?? "?"} sales (${fx(PO.insiders?.sales_vs_norm, 2)}x normal selling). Institutions: ownership ${isNum(PO.institutions?.own_change_pp) ? `${PO.institutions.own_change_pp > 0 ? "+" : ""}${PO.institutions.own_change_pp.toFixed(1)}` : "n/a"} pp last quarter, adding ${(PO.institutions?.adding || []).slice(0, 4).join(", ") || "none"}, cutting ${(PO.institutions?.cutting || []).slice(0, 4).join(", ") || "none"}. Short interest ${p0(PO.short?.capw, 1)} of float.${PO.label ? ` Read: ${PO.label}.` : ""}` : "");
    sec("CREDIT (code)", C.cmdi ? `Corporate credit stress (CMDI) ${C.cmdi.market} (${Math.round((C.cmdi.market_pctl || 0) * 100)}th percentile since ${C.cmdi.from}); high yield vs Treasuries over 3 months ${pc(C.hy_vs_treasuries_3m)}. Weakest balance sheets: ${(C.weak || []).slice(0, 4).map((w) => `${w.symbol} (interest cover ${fx(w.int_cover)})`).join(", ") || "none"}.` : "");
    sec("MOMENTUM AND PRICE LEVELS (code)", [`Returns (cap-weighted): 1M ${pc(S.ret_cw_1M)}, 3M ${pc(S.ret_cw_3M)}, 6M ${pc(S.ret_cw_6M)}, 1Y ${pc(S.ret_cw_1Y)}; share of companies up over 3M ${p0(S.breadth_3M)}. Volatility ${p0(S.vol_1y)} a year, beta ${fx(S.beta, 2)}, worst drawdown in a year ${pc(S.max_dd_1y, 0)}.`,
      isNum(L.last) ? `Index ${fx(L.last)} vs 50-day ${fx(L.sma50)} and 200-day ${fx(L.sma200)} averages; 52-week range ${fx(L.low52)}-${fx(L.high52)}.` : ""].filter(Boolean).join("\n"));
    const HI = R.history;
    sec("PAST SETUPS LIKE TODAY AND THE STATISTICAL MODEL", [HI?.read ? `Historian: ${trim(HI.read, 600)}` : "", ...(facts || []).map((f) => `${f.h}: ${f.like ? `after the closest past setups it was higher ${f.like.pos}% of the time (median ${f.like.median}%, n=${f.like.n}); ` : ""}${isNum(f.base_up) ? `over any ${f.h} in its history higher ${f.base_up}% of the time; ` : ""}${f.anchor?.abs ? `statistical model (momentum, trend, valuation): median ${f.anchor.abs.median}%, ${f.anchor.abs.prob_up}% chance higher (tested out of sample: right ${f.anchor.test?.hit_rate ?? "?"}% vs ${f.anchor.test?.base_hit_rate ?? "?"}% for the average alone, so weak); ` : ""}one-sigma move ±${f.sigma ?? "?"}%.`)].filter(Boolean).join("\n"));
    const ev = [];
    for (const e of cal?.events || []) { const dd = (e.dates || [])[0]; if (!dd || dd < today || e.importance === "low") continue; ev.push({ dd, hi: e.importance === "high", t: `${dd} ${trim(e.title, 110)}${e.importance === "high" ? " (high)" : ""}` }); }
    ev.sort((a, b) => (a.hi === b.hi ? (a.dd < b.dd ? -1 : 1) : a.hi ? -1 : 1));
    sec("DATED CATALYSTS AHEAD", ev.slice(0, 14).sort((a, b) => (a.dd < b.dd ? -1 : 1)).map((e) => e.t).join("\n"));
    return o.join("\n\n");
  }

  const CALL = `{"call": "${LEVELS.join(" | ")}", "why": "3-4 sentences: where it goes over this window and the two or three things that decide it, with the specific numbers", "for": ["2-3 short reasons on the call's side"], "against": ["the case against: 1-2 short reasons, and why they lose"], "flips_it": "one measurable, dated condition that would flip this call"}`;
  const schemaFor = (inputs) => `{"headline": "one sentence: where it's going and why",
 "evidence": [{"input": "${inputs.map(([k]) => k).join(" | ")}", "points": "up | down | mixed", "weight": 1, "why": "one sentence with the number that matters"}],
 "calls": {"1M": ${CALL}, "3M": {...}, "6M": {...}, "12M": {...}},
 "verdict": {"agrees": true, "why": "one sentence: do you agree with the lead's verdict, and if not, why"}}`;
  const SCHEMA = schemaFor(INPUTS);
  const RULES = (who, inputs) => `HOW TO MAKE THE CALLS
- Each call is ${who}'S OWN DIRECTION: will it be higher or lower at the end of the window? Nothing else.
- Six levels, no neutral. "slightly": a close call that tips one way. Plain "bullish" / "bearish": the evidence clearly points that way. "strongly": most components point the same way, decisively; rare. If it's close, pick the side it tips toward and say "slightly".
- First weigh EVERY component, one entry each, in this order: ${inputs.map(([k]) => k).join(", ")}. For each: does it push ${who} up or down over the next year ("up" / "down" / "mixed"), how much it matters (weight 1 = minor, 2 = material, 3 = decisive), and why in one sentence with the number. Nothing to go on: "mixed", weight 1.
- Then the four calls, from that evidence. Near-term windows lean on momentum, positioning, macro and dated events; longer ones on earnings, the cycle, valuation and the scenarios. A call that flips direction from one window to the next must say what changes in between.
- For each call, put the strongest case against it in "against" and say why it loses. Square the calls with the history and the statistical model; where you go against them, say why.
- Plain words, specific numbers, no hedging filler.`;

  /** The industry's prompt: the digest, one call. */
  function prompt(name, today, dig) {
    return `You are the head of research for the US-listed "${name}" industry. Today is ${today}. Your team's work, every component cut to its conclusions, is below. Use ALL of it to say WHERE THE INDUSTRY IS GOING over the next month, 3 months, 6 months and 12 months, and why.

${dig}

${RULES("THE INDUSTRY", INPUTS)}

Reply with ONLY this JSON (all four windows):
${SCHEMA}`;
  }

  /** A company's prompt: its finished write-up, its industry's outlook, its numbers. One call. */
  function coPrompt(c) {
    const t = c.write || {}, sc = t.scenarios || {}, ind = c.ind;
    const w = [`Headline: ${trim(t.headline, 260)}`, t.verdict ? `Verdict: ${t.verdict.call}: ${trim(t.verdict.summary, 500)}` : "", t.thesis ? `Thesis: ${trim(t.thesis, 1500)}` : "",
      t.vs_industry ? `Vs its industry: ${t.vs_industry.call}: ${trim(t.vs_industry.why, 300)}` : "", t.valuation?.read ? `Valuation: ${trim(t.valuation.read, 400)}` : "", t.street?.summary ? `Vs Wall Street: ${t.street.stance || ""}: ${trim(t.street.summary, 360)}` : "",
      t.moat ? `Moat: ${t.moat.rating || "?"}` : "", t.quality ? `Quality: ${trim(t.quality, 260)}` : "", t.management ? `Management: ${trim(t.management, 260)}` : "",
      ["bull", "base", "bear"].some((k) => sc[k]) ? `Scenarios (12M): ${["bull", "base", "bear"].filter((k) => sc[k]).map((k) => `${k} ${sc[k].probability ?? "?"}% target ${(sc[k].price_target || []).join("-")}`).join("; ")}` : "",
      ...HZ.filter((h) => t.horizons?.[h]).map((h) => `Earlier ${h} call: ${t.horizons[h].call}, ${(t.horizons[h].expected_move || []).join(" to ")}%. ${trim(t.horizons[h].drivers, 220)}`),
      (t.risks || []).length ? `Risks: ${t.risks.slice(0, 5).map((r) => trim(r.risk, 120)).join("; ")}` : "", (t.catalysts || []).length ? `Catalysts: ${t.catalysts.slice(0, 5).map((x) => `${x.date} ${trim(x.event, 100)}`).join("; ")}` : "",
      t.lens?.macro?.headline ? `Macro for it: ${t.lens.macro.regime || ""}: ${trim(t.lens.macro.headline, 240)}` : "", t.lens?.trade_overall?.summary ? `Trade for it: ${trim(t.lens.trade_overall.summary, 300)}` : "", t.lens?.reg_overall?.summary ? `Regulation for it: ${trim(t.lens.reg_overall.summary, 300)}` : ""].filter(Boolean).join("\n");
    return `You are the analyst covering ${c.name} (${c.sym}) in the US-listed "${c.industry}" industry. Today is ${c.today}. Use ALL of the work below to say WHERE ${c.sym} IS GOING over the next month, 3 months, 6 months and 12 months, and why.

## THE ${c.industry.toUpperCase()} INDUSTRY'S OUTLOOK
${ind?.calls ? `${ind.provisional ? "(provisional, read off the industry's earlier calls; weigh lightly) " : ""}${trim(ind.headline, 240)}\n${HZ.filter((h) => ind.calls[h]).map((h) => `${h}: ${ind.calls[h].call}${ind.calls[h].why ? `: ${trim(ind.calls[h].why, 300)}` : ""}`).join("\n")}` : "(none yet)"}${c.indLatest ? `\nThe industry's latest update: ${trim(c.indLatest, 500)}` : ""}

${c.indLead ? `## THE INDUSTRY LEAD'S VERDICT\n${trim(c.indLead, 900)}\n` : ""}
${c.write ? `## THE COMPANY WRITE-UP\n${w}\n` : ""}${c.company ? `## ${c.sym}: THE COMPANY\n${trim(c.company, 9000)}\n` : ""}${(c.mentions || []).length ? `## WHAT THE INDUSTRY ANALYSIS SAYS ABOUT ${c.sym}\n${c.mentions.slice(0, 14).map((m) => `${m.section}: ${trim(m.text, 200)}`).join("\n")}\n` : ""}
## ${c.sym}'S NUMBERS (code)
${trim(c.facts, 3500)}
${(c.windows || []).map((x) => `${x.h}: one-sigma move ±${x.sigma ?? "?"}%; trailing ${x.h} ${x.trailing ?? "?"}%; in its own history higher ${x.base_up ?? "?"}% of the time over this span; ${x.own ? `reports ${x.own}` : "doesn't report in the window"}${x.peers?.length ? `; peers reporting ${x.peers.map((p) => `${p.symbol} ${p.date}`).join(", ")}` : ""}.`).join("\n")}
${c.times ? `\n## ${c.sym} IN TIMES LIKE THIS\n${trim(c.times, 1200)}` : ""}
${(c.news || []).length ? `\n## RECENT NEWS\n${c.news.slice(0, 12).map((x) => `${x.date ? x.date + " " : ""}${trim(x.title, 150)}`).join("\n")}` : ""}

${RULES(c.sym, CO_INPUTS)}
- Start from the industry's outlook, then say where ${c.sym} departs from it and why.

Reply with ONLY this JSON (all four windows):
${schemaFor(CO_INPUTS).replace("the lead's verdict", "the industry lead's verdict")}`;
  }

  /** Tally the evidence: +1 up, -1 down, 0 mixed, times its weight. score in [-1, 1]. */
  function tally(evidence) {
    let s = 0, w = 0; const up = [], down = [], mixed = [];
    for (const e of evidence || []) { const wt = e.weight || 1; w += wt; if (e.points === "up") { s += wt; up.push(e.input); } else if (e.points === "down") { s -= wt; down.push(e.input); } else mixed.push(e.input); }
    return { score: w ? Math.round((s / w) * 100) / 100 : 0, up, down, mixed, weight: w };
  }
  const TURN = /\b(then|after|once|until|before|near[- ]term|short[- ]term|longer[- ]term|later|by (?:the )?(?:spring|summer|mid|end|q[1-4])|bounce|rebound|recover|reverses?|fades?|turns?|over (?:a|the) (?:year|longer))\b/i;
  function checks(out) {
    const iss = [], t = out.tally;
    const long = (SIGN[out.calls["12M"]?.call] || 0) + (SIGN[out.calls["6M"]?.call] || 0);
    if (out.evidence.length >= 8 && long && Math.sign(long) * t.score < -0.15) iss.push(`The 6M and 12M calls are ${long > 0 ? "bullish" : "bearish"}, but the evidence listed points the other way (score ${t.score > 0 ? "+" : ""}${t.score}).`);
    for (let i = 1; i < HZ.length; i++) { const a = out.calls[HZ[i - 1]], b = out.calls[HZ[i]];
      if (a && b && Math.sign(SIGN[a.call]) !== Math.sign(SIGN[b.call]) && !TURN.test(b.why) && !TURN.test(a.why)) iss.push(`${HZ[i - 1]} is ${a.call} but ${HZ[i]} is ${b.call}, and neither says what changes in between.`); }
    const strong = HZ.filter((h) => /strongly/.test(out.calls[h]?.call || "") && Math.sign(SIGN[out.calls[h].call]) * t.score < 0.35);
    if (strong.length && out.evidence.length >= 8) iss.push(`"Strongly" (${strong.join(", ")}) from evidence that is only ${Math.round(Math.max(0, Math.sign(SIGN[out.calls[strong[0]].call]) * t.score) * 100)}% one-sided that way.`);
    if (HZ.some((h) => !out.calls[h])) iss.push(`No call for ${HZ.filter((h) => !out.calls[h]).join(", ")}.`);
    return iss;
  }

  /** Clean the answer; add the tally and code's checks. */
  function clean(raw, { today = "", inputs = INPUTS } = {}) {
    if (!raw || typeof raw !== "object") return null;
    const IL = Object.fromEntries(inputs), IK = inputs.map(([k]) => k);
    const list = (a, n, k) => (Array.isArray(a) ? a : a ? [a] : []).slice(0, n).map((x) => trim(x, k)).filter(Boolean);
    const calls = {};
    for (const h of HZ) { const c = raw.calls?.[h] || raw.calls?.[h.toLowerCase()]; const l = level(c?.call); if (!l) continue;
      calls[h] = { call: l, why: trim(c.why, 1000), for: list(c.for, 3, 240), against: list(c.against, 2, 280), flips_it: trim(c.flips_it, 260) }; }
    if (!Object.keys(calls).length) return null;
    const seen = new Set(), evidence = [];
    for (const e of Array.isArray(raw.evidence) ? raw.evidence : []) {
      const k = keyOf(e?.input, inputs); if (!k || seen.has(k)) continue; seen.add(k);
      const p = lc(e?.points); const points = /up|bull|positive|higher/.test(p) ? "up" : /down|bear|negative|lower/.test(p) ? "down" : "mixed";
      evidence.push({ input: k, label: IL[k], points, weight: Math.max(1, Math.min(3, Math.round(Number(e?.weight) || 1))), why: trim(e?.why, 360) });
    }
    evidence.sort((a, b) => IK.indexOf(a.input) - IK.indexOf(b.input));
    const out = { v: 3, date: today, headline: trim(raw.headline, 300), calls, evidence, tally: tally(evidence), missing: IK.filter((k) => !seen.has(k)),
      verdict: { agrees: raw.verdict?.agrees !== false && lc(raw.verdict?.agrees) !== "false", why: trim(raw.verdict?.why, 400) } };
    out.checks = checks(out);
    if (out.missing.length > 4) out.checks.push(`${out.missing.length} components weren't weighed: ${out.missing.map((k) => IL[k]).join(", ")}.`);
    out.consistent = !out.checks.length;
    return out;
  }

  /** Only when code finds a contradiction: one small fix (the answer and the findings; no digest). */
  function repairPrompt(who, today, o, issues, inputs = INPUTS) {
    return `You made the calls below on where ${who} is going (its own direction over each window). Today is ${today}. Code found problems:
${issues.map((i) => "- " + i).join("\n")}

YOUR ANSWER
${JSON.stringify({ headline: o.headline, evidence: o.evidence.map(({ input, points, weight, why }) => ({ input, points, weight, why })), calls: o.calls, verdict: o.verdict })}

Fix them: correct the evidence if it's wrong, or the calls (and their "why") if they are. A call that flips direction between windows must say what changes in between. Reply with ONLY the complete corrected answer in the same JSON shape:
${schemaFor(inputs)}`;
  }

  /** Until it has been made: provisional, read off the earlier calls (no Claude). */
  function provisional(res, today = "") {
    if (!res?.horizons) return null;
    const calls = {};
    for (const h of HZ) { const x = res.horizons[h]; if (!x) continue;
      const s = lc(x.call); let l = level(x.call);
      if (!l) l = isNum(Number(x.probability_up)) && Number(x.probability_up) >= 50 ? "slightly bullish" : "slightly bearish";
      else if (!/slight|strong/.test(s)) l = level("slightly " + l);
      calls[h] = { call: l, basis: "the earlier call" }; }
    if (!Object.keys(calls).length) return null;
    return { v: 3, date: today, provisional: true, headline: "Provisional: read off the earlier calls. Press the button to make the calls from every component, with the reasons.", calls, evidence: [], checks: [] };
  }
  const outlookOf = (res, today = "") => (res?.outlook?.v === 3 && res.outlook.calls ? res.outlook : provisional(res, today));
  const flipped = (a, b) => !!(a && b && !a.provisional && a.calls?.["12M"] && b.calls?.["12M"] && Math.sign(SIGN[a.calls["12M"].call]) !== Math.sign(SIGN[b.calls["12M"].call]));
  const line = (o) => (o ? HZ.filter((h) => o.calls?.[h]).map((h) => `${h} ${o.calls[h].call}`).join(", ") + (o.provisional ? " (provisional)" : "") : "");
  /** History entry for an outlook. */
  const histOf = (o) => (o?.calls && !o.provisional ? { date: o.date, calls: Object.fromEntries(Object.entries(o.calls).map(([h, x]) => [h, x.call])) } : null);
  /** Dated events inside a window (the calendar's, plus the largest companies reporting). */
  function windowEvents(cal, f, today) {
    if (!f) return [];
    const out = [];
    for (const e of (cal?.events || [])) { const d = (e.dates || [])[0]; if (!d || d < today || d > f.end || e.importance === "low") continue; out.push({ date: d, title: e.title, importance: e.importance }); }
    for (const r of (f.reporting || []).filter((r) => r.weight >= 5)) { if (out.some((e) => e.date === r.date && new RegExp(`\\b${r.symbol}\\b`).test(e.title))) continue; out.push({ date: r.date, title: `${r.symbol} reports (${r.weight}% of the industry)`, importance: "high" }); }
    return out.sort((a, b) => (a.importance === "high") === (b.importance === "high") ? (a.date < b.date ? -1 : 1) : a.importance === "high" ? -1 : 1).slice(0, 6).sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  const Outlook = { HZ, HZ_LABEL, DAYS, LEVELS, SIGN, level, cls, label, INPUTS, CO_INPUTS, keyOf, digest, prompt, coPrompt, schemaFor, SCHEMA, tally, checks, clean, repairPrompt, provisional, outlookOf, flipped, line, histOf, windowEvents };
  if (typeof module !== "undefined" && module.exports) module.exports = Outlook;
  else root.Outlook = Outlook;
})(typeof window !== "undefined" ? window : globalThis);
