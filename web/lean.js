/* Industry Scorer: the lean. For each timeframe (1M, 3M, 6M, 12M), one call vs the S&P 500 on a six-level scale
 * (strongly bearish, bearish, slightly bearish, slightly bullish, bullish, strongly bullish: no neutral) and why.
 *
 * The lead strategist (Opus) reads EVERYTHING: the full dossier (every analyst's report: world, macro, trade,
 * regulation, earnings and KPIs, customers and suppliers, valuation, positioning, momentum, history) plus its own
 * finished analysis (scenarios, the earlier calls, the statistical anchor, the red team, the opportunity verdict and
 * today's update). It scores every input for which way it points vs the S&P 500, then makes the four calls.
 * Code checks the calls against that evidence and against each other (a direction that flips between timeframes
 * needs its reason); a contradiction goes back once. Pure functions, no I/O.
 */
(function (root) {
  "use strict";
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const trim = (s, k) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > k ? s.slice(0, k - 1) + "…" : s; };
  const lc = (s) => String(s ?? "").toLowerCase().trim();
  const HZ = ["1M", "3M", "6M", "12M"];
  const HZ_LABEL = { "1M": "Next month", "3M": "Next 3 months", "6M": "Next 6 months", "12M": "Next 12 months" };
  const req = (f, g) => (typeof module !== "undefined" && module.exports ? require(f) : root[g]);
  const Horizon = req("./horizon.js", "Horizon");

  /** The six levels, most bearish first. No neutral: every call picks a side. */
  const LEVELS = ["strongly bearish", "bearish", "slightly bearish", "slightly bullish", "bullish", "strongly bullish"];
  const SIGN = { "strongly bearish": -3, bearish: -2, "slightly bearish": -1, "slightly bullish": 1, bullish: 2, "strongly bullish": 3 };
  /** Any spelling -> one of LEVELS, or null. */
  function level(s) {
    const t = lc(s).replace(/[_-]/g, " ").replace(/\s+/g, " ");
    const side = /bear|under|negative|short/.test(t) ? "bearish" : /bull|outperf|over|positive|long/.test(t) ? "bullish" : null;
    if (!side) return null;
    if (/strong|very|high conviction/.test(t)) return "strongly " + side;
    if (/slight|mild|modest|lean|weak|small/.test(t)) return "slightly " + side;
    return side;
  }
  const ORD = Object.fromEntries(LEVELS.map((l, i) => [l, i]));
  const cls = (l) => (SIGN[l] > 0 ? "pos" : SIGN[l] < 0 ? "neg" : "neu");
  const label = (l) => (l ? l[0].toUpperCase() + l.slice(1) : "");

  /** Every input the lean must weigh, in the order shown. */
  const INPUTS = [
    ["world", "World & geopolitics"], ["macro", "Macro & rates"], ["trade", "Trade & tariffs"], ["regulation", "Regulation & policy"],
    ["earnings", "Earnings, estimates & KPIs"], ["chain", "Customers & suppliers"], ["valuation", "Valuation"], ["positioning", "Positioning & flows"],
    ["momentum", "Momentum & the statistical anchor"], ["history", "History: times like this"], ["catalysts", "Dated catalysts ahead"],
    ["scenarios", "Bull / base / bear scenarios"], ["calls", "The earlier 1M-12M calls"], ["redteam", "Red team & risks"], ["verdict", "The lead's opportunity verdict"],
  ];
  const LABEL = Object.fromEntries(INPUTS);
  const KEYS = INPUTS.map(([k]) => k);
  const ALIAS = { geopolitics: "world", rates: "macro", tariffs: "trade", policy: "regulation", kpis: "earnings", kpi: "earnings", estimates: "earnings", supply: "chain", suppliers: "chain", customers: "chain",
    flows: "positioning", anchor: "momentum", "times like this": "history", calendar: "catalysts", events: "catalysts", horizons: "calls", "red team": "redteam", risks: "redteam", opportunity: "verdict" };
  const keyOf = (s, inputs = INPUTS, alias = ALIAS) => { const t = lc(s), keys = inputs.map(([k]) => k); if (keys.includes(t)) return t; const hit = inputs.find(([, l]) => lc(l) === t); if (hit) return hit[0];
    for (const k of keys) if (t.startsWith(k)) return k; for (const [a, k] of Object.entries(alias)) if (t.includes(a) && keys.includes(k)) return k; return null; };

  /** The lead's own finished analysis, as the prompt shows it. */
  function analysisText(res) {
    if (!res) return "(no analysis)";
    const o = [], sc = res.scenarios || {}, m = res.math || {}, op = res.opportunity || {};
    o.push(`HEADLINE: ${trim(res.headline, 400)}`);
    if (res.thesis) o.push(`THESIS: ${trim(res.thesis, 2500)}`);
    if (res.priced_in) o.push(`PRICED IN: ${trim(res.priced_in, 800)}`);
    if ((res.drivers || []).length) o.push(`DRIVERS: ${(res.drivers || []).slice(0, 8).map((d) => `${d.title} (${d.direction || "?"}, ${d.magnitude || "?"}${d.horizon ? ", " + d.horizon : ""}): ${trim(d.text, 300)}`).join(" | ")}`);
    if ((res.debates || []).length) o.push(`DEBATES: ${(res.debates || []).slice(0, 6).map((d) => `${trim(d.question, 160)} -> leans ${d.lean || "?"}: ${trim(d.why, 220)}`).join(" | ")}`);
    const sk = ["bull", "base", "bear"].filter((k) => sc[k]);
    if (sk.length) o.push(`SCENARIOS (12M): ${sk.map((k) => `${k} ${sc[k].probability ?? "?"}%: price ${sc[k].price_move ?? "?"}%, EPS ${sc[k].eps_change ?? "?"}%, P/E ${sc[k].pe ?? "?"}. ${trim(sc[k].narrative, 350)}`).join(" | ")}`);
    if (isNum(m.expected_return)) o.push(`CODE-COMPUTED SCENARIO MATH: expected 12M return ${m.expected_return}%, probability of a loss ${m.prob_loss ?? "?"}%, reward-to-risk ${m.reward_risk ?? "n/a"}.`);
    for (const h of HZ) { const x = res.horizons?.[h]; if (!x) continue;
      const v = x.vs_spy, a = x.anchor;
      o.push(`EARLIER CALL ${h}: ${x.call}, conviction ${x.conviction ?? "?"}/10, ${(x.expected_move || []).join(" to ")}% absolute, ${x.probability_up ?? "?"}% chance higher${v ? `; vs the S&P 500: ${v.call || "?"}, ${(v.expected_excess || []).join(" to ")}% excess, ${v.probability_beat ?? "?"}% chance of beating it` : ""}${a?.rel ? `; statistical anchor vs S&P median ${a.rel.median}%` : ""}. Why: ${trim(x.drivers, 600)}`); }
    if (op.verdict) o.push(`OPPORTUNITY VERDICT (the lead's): ${op.verdict.toUpperCase()}${op.consistent === false ? " (code flags it as inconsistent with the scenario math)" : ""}: ${trim(op.headline, 300)} ${trim(op.why, 1000)}${(op.entry_triggers || []).length ? ` Entry triggers: ${op.entry_triggers.slice(0, 4).map((t) => trim(t, 160)).join("; ")}` : ""}`);
    const rt = res.redteam;
    if (rt) o.push(`RED TEAM (${rt.stance || "?"}): ${trim(rt.thesis, 900)} Arguments: ${(rt.arguments || []).slice(0, 6).map((a) => `[${a.severity}] ${trim(a.claim, 200)}`).join(" | ")}. Pre-mortem: ${(rt.premortem || []).slice(0, 3).map((p) => `${p.probability}%: ${trim(p.what_happened, 220)}`).join(" | ")}`);
    if ((res.change_mind || []).length) o.push(`WHAT WOULD CHANGE ITS MIND: ${(res.change_mind || []).slice(0, 5).map((t) => trim(typeof t === "string" ? t : t?.text || JSON.stringify(t), 200)).join("; ")}`);
    if (res.profiles) o.push(`INVESTOR VERDICTS: ${Object.entries(res.profiles).map(([k, p]) => `${k}: ${p?.fit || "?"} (${trim(p?.verdict, 140)})`).join(" | ")}`);
    const d = res.daily;
    if (d?.date) o.push(`LATEST UPDATE (${d.date}): ${trim(d.headline, 300)} ${trim(d.summary, 900)}${(d.changes || []).length ? ` Changes: ${d.changes.map((c) => `${c.effect}: ${trim(c.text, 200)}`).join(" | ")}` : ""}${d.rethink ? ` Rethink: ${d.rethink.same ? "same story" : "would write it differently"} (${trim(d.rethink.why, 200)})` : ""}`);
    for (const h of (res.daily_history || []).slice(1, 6)) o.push(`  earlier update ${h.date}: ${trim(h.headline, 200)}${isNum(h.move) ? ` (industry ${h.move > 0 ? "+" : ""}${h.move}%)` : ""}`);
    return o.join("\n");
  }

  const CALL = `{"call": "${LEVELS.join(" | ")} (vs the S&P 500)", "sp500": "${LEVELS.join(" | ")} (the S&P 500 itself: higher or lower at the end of the window)", "absolute": "${LEVELS.join(" | ")} (the industry itself: higher or lower at the end of the window)", "absolute_why": "1-2 sentences: the S&P 500's own direction plus the industry's edge (or drag) vs it, and so where the industry itself ends up, with numbers", "why": "3-5 sentences: what the S&P 500 is likely to do over this window and what drives it, and why this industry does better or worse than it, with the specific numbers and [IDs]", "for": ["1-3 short reasons on the call's side, cited"], "against": ["1-2 short reasons against it, cited"], "flips_it": "one measurable, dated condition that would flip this call"}`;
  const SCHEMA = `{"headline": "one sentence: the overall lean vs the S&P 500 and the two or three things that decide it",
 "evidence": [{"input": "world | macro | trade | regulation | earnings | chain | valuation | positioning | momentum | history | catalysts | scenarios | calls | redteam | verdict", "points": "bullish | bearish | mixed", "weight": 1, "why": "one or two sentences vs the S&P 500, with the numbers and [IDs]"}],
 "calls": {"1M": ${CALL}, "3M": {...}, "6M": {...}, "12M": {...}},
 "verdict": {"agrees": true, "why": "one or two sentences: do you agree with the lead's opportunity verdict and the earlier calls, and if not, why the rest of the evidence points the other way"}}`;

  /**
   * The prompt. ctx: {today, dossier (Brain.dossier text), res (the lead's result), facts (Horizon.horizonFacts),
   * scorecard text, wire: [{id, title, date}]}.
   */
  function leanPrompt(name, ctx) {
    const facts = (ctx.facts || []).filter((f) => f.anchor);
    return `You are the head of research for the US-listed "${name}" industry. Today is ${ctx.today}. Your team has finished its work: the dossier below holds every analyst's report, and below it is your own finished analysis. An investor asks one thing: FOR EACH TIMEFRAME, DOES THIS INDUSTRY BEAT OR LAG THE S&P 500, HOW STRONGLY, AND WHY?

${ctx.dossier || "(dossier unavailable: use the analysis)"}

=== YOUR FINISHED ANALYSIS (the lead strategist's, kept up to date daily) ===
${analysisText(ctx.res)}
${ctx.board ? `\n=== THE SCOREBOARD (code-computed hard numbers for each window: the S&P 500 itself, the industry vs it, the statistical anchor and its tested record, past setups like today, dated events) ===\n${ctx.board}` : facts.length ? `\n=== THE STATISTICAL ANCHOR (momentum, the trend and valuation, tested out of sample) ===\n${facts.map((f) => `${f.h}: ${Horizon.anchorText(f.anchor)}`).join("\n")}` : ""}
${ctx.scorecard ? `\n${ctx.scorecard}` : ""}
${(ctx.wire || []).length ? `\n=== TODAY'S WIRE (latest headlines touching this industry) ===\n${ctx.wire.slice(0, 15).map((w) => `[${w.id}] ${w.date ? w.date + " " : ""}${trim(w.title, 200)}`).join("\n")}` : ""}

HOW TO MAKE THE CALLS
- "call" is RELATIVE TO THE S&P 500: "bullish" means the industry beats the S&P 500 over that window, "bearish" means it lags it; an industry that falls 5% while the S&P 500 falls 12% is bullish there.
- For EACH window make three calls on the same six-level scale: "sp500", the S&P 500's own direction (will the index be higher or lower at the end of the window); "call", the industry vs the S&P 500; and "absolute", the industry's own direction (will it be higher or lower). They must add up: beating a rising market means it rises too, and lagging a falling market means it falls too; only when the two point opposite ways can the absolute call go either way, and then "absolute_why" says which force wins and by how much (the market drifts up about 7% a year, so over 12 months "slightly bullish" for the S&P 500 is the default without a reason). Code checks this.
- Six levels, no neutral. "slightly": a close call that tips one way. Plain "bullish" / "bearish": the evidence clearly points that way. "strongly": most inputs point the same way and decisively; use it rarely. If it's close, pick the side the evidence tips toward and say "slightly".
- First weigh EVERY input, one entry each, in this order: world, macro, trade, regulation, earnings, chain, valuation, positioning, momentum, history, catalysts, scenarios, calls, redteam, verdict. For each: which way it points vs the S&P 500 ("bullish" / "bearish" / "mixed"), how much it matters for THIS industry (weight 1 = minor, 2 = material, 3 = decisive), and why, with the numbers and the dossier's [IDs]. An input with nothing in the dossier is "mixed", weight 1, and says so.
- Then make the four calls from that evidence. Different windows can differ (near-term momentum, a dated catalyst, valuation that only matters over a year), but a call that flips direction from one window to the next must say in its "why" what changes in between.
- Square every call with the scoreboard: where you go against the statistical anchor or the past setups, say why; where a big dated event falls in the window, say how it cuts.
- Each "why" compares with the S&P 500 explicitly: what the index is likely to do over the window and what drives it (rates, the Fed, earnings, the mega-caps), and why this industry does better or worse. Plain words, specific numbers, no hedging filler. No price targets or expected returns.
- The lead's opportunity verdict and the earlier calls are inputs, not the answer: if the rest of the evidence points the other way, say so and call it the other way.
- Code checks your calls against the evidence you list and against each other, and sends back contradictions.
- Cite only IDs in the dossier or today's wire.

Reply with ONLY this JSON (all four windows):
${SCHEMA}`;
  }

  /** Tally the evidence: +1 bullish, -1 bearish, 0 mixed, times its weight. score in [-1, 1]. */
  function tally(evidence) {
    let s = 0, w = 0; const bull = [], bear = [], mixed = [];
    for (const e of evidence || []) { const wt = e.weight || 1; w += wt; if (e.points === "bullish") { s += wt; bull.push(e.input); } else if (e.points === "bearish") { s -= wt; bear.push(e.input); } else mixed.push(e.input); }
    return { score: w ? Math.round((s / w) * 100) / 100 : 0, bull, bear, mixed, weight: w };
  }

  const TURN = /\b(then|after|once|until|before|near[- ]term|short[- ]term|longer[- ]term|later|by (?:the )?(?:spring|summer|mid|end|q[1-4])|bounce|rebound|catch[- ]up|reverses?|fades?|turns?|over (?:a|the) (?:year|longer))\b/i;
  /** Code's checks on a cleaned lean: issues as plain sentences. */
  function checks(out) {
    const iss = [], t = out.tally;
    for (const h of HZ) { const x = out.calls[h]; if (!x?.absolute || !x.sp500) continue;
      const m = Math.sign(SIGN[x.sp500]), r = Math.sign(SIGN[x.call]), a = Math.sign(SIGN[x.absolute]);
      if (m === r && a !== m) iss.push(`${h}: the S&P 500 is ${x.sp500} and this ${r > 0 ? "beats" : "lags"} it, so it should be ${m > 0 ? "higher" : "lower"} too, but its own direction is ${x.absolute}.`); }
    const s12 = SIGN[out.calls["12M"]?.call] || 0, s6 = SIGN[out.calls["6M"]?.call] || 0;
    const long = s12 + s6;
    if (out.evidence.length >= 8 && long && Math.sign(long) * t.score < -0.15) iss.push(`The 6M and 12M calls are ${long > 0 ? "bullish" : "bearish"}, but the evidence listed tips the other way (score ${t.score > 0 ? "+" : ""}${t.score}).`);
    for (let i = 1; i < HZ.length; i++) { const a = out.calls[HZ[i - 1]], b = out.calls[HZ[i]];
      if (a && b && Math.sign(SIGN[a.call]) !== Math.sign(SIGN[b.call]) && !TURN.test(b.why) && !TURN.test(a.why)) iss.push(`${HZ[i - 1]} is ${a.call} but ${HZ[i]} is ${b.call}, and neither says what changes in between.`); }
    const strong = HZ.filter((h) => /strongly/.test(out.calls[h]?.call || ""));
    if (strong.length && Math.abs(t.score) < 0.35 && out.evidence.length >= 8) iss.push(`"Strongly" (${strong.join(", ")}) from evidence that is only ${Math.round(Math.abs(t.score) * 100)}% one-sided.`);
    return iss;
  }

  /** Clean the model's answer; add code's tally and checks. */
  function cleanLean(raw, { res = null, today = "", known = null, inputs = INPUTS, alias = ALIAS, ind = null } = {}) {
    const IK = inputs.map(([k]) => k), IL = Object.fromEntries(inputs);
    if (!raw || typeof raw !== "object") return null;
    const r = raw.lean && typeof raw.lean === "object" && raw.lean.calls ? raw.lean : raw;
    const ids = known ? new Set(known) : null;
    const cite = (t, k) => trim(String(t || "").replace(/\[([A-Z]{1,6}\d{1,5}(?:\s*,\s*[A-Z]{1,6}\d{1,5})*)\]/g, (m, g) => { if (!ids) return m; const keep = g.split(/\s*,\s*/).filter((i) => ids.has(i)); return keep.length ? `[${keep.join(", ")}]` : ""; }).replace(/\s+([.,;:])/g, "$1"), k);
    const list = (a, n, k) => (Array.isArray(a) ? a : a ? [a] : []).slice(0, n).map((x) => cite(x, k)).filter(Boolean);
    const calls = {};
    for (const h of HZ) { const c = r.calls?.[h] || r.calls?.[h.toLowerCase()]; const l = level(c?.call); if (!l) continue;
      calls[h] = { call: l, why: cite(c.why, 1400), for: list(c.for, 3, 300), against: list(c.against, 2, 300), flips_it: cite(c.flips_it, 300) };
      const ab = level(c.absolute), sp = level(c.sp500); if (ab) { calls[h].absolute = ab; calls[h].absolute_why = cite(c.absolute_why, 600); } if (sp) calls[h].sp500 = sp;
      const vi = lc(c.vs_industry); if (vi) calls[h].vs_industry = /beat|out|better|ahead/.test(vi) ? "beats" : /lag|under|worse|behind/.test(vi) ? "lags" : "matches"; }
    if (!Object.keys(calls).length) return null;
    const seen = new Set(), evidence = [];
    for (const e of Array.isArray(r.evidence) ? r.evidence : []) {
      const k = keyOf(e?.input, inputs, alias); if (!k || seen.has(k)) continue; seen.add(k);
      const p = lc(e?.points); const points = /bull|positive|beat|outperf/.test(p) ? "bullish" : /bear|negative|lag|underperf/.test(p) ? "bearish" : "mixed";
      evidence.push({ input: k, label: IL[k], points, weight: Math.max(1, Math.min(3, Math.round(Number(e?.weight) || 1))), why: cite(e?.why, 500) });
    }
    evidence.sort((a, b) => IK.indexOf(a.input) - IK.indexOf(b.input));
    const out = { v: 2, date: today, headline: cite(r.headline, 400), calls, evidence, tally: tally(evidence), missing: IK.filter((k) => !seen.has(k)),
      verdict: { agrees: r.verdict?.agrees !== false && lc(r.verdict?.agrees) !== "false", why: cite(r.verdict?.why, 600) } };
    out.checks = checks(out);
    // A company's call must square with its industry's call and its own "vs the industry" (beats: at least the industry's level; lags: at most).
    if (ind) for (const h of HZ) { const c = calls[h], ic = ind.calls?.[h]?.call; if (!c?.vs_industry || !ic) continue;
      const a = ORD[c.call], b = ORD[ic];
      if ((c.vs_industry === "beats" && a < b) || (c.vs_industry === "lags" && a > b) || (c.vs_industry === "matches" && Math.abs(a - b) > 1))
        out.checks.push(`${h}: the industry is ${ic} vs the S&P 500 and this says the company ${c.vs_industry} the industry, but calls it ${c.call}.`); }
    if (HZ.some((h) => !calls[h])) out.checks.push(`No call for ${HZ.filter((h) => !calls[h]).join(", ")}.`);
    if (HZ.some((h) => calls[h] && !calls[h].absolute)) out.checks.push(`No up-or-down call for ${HZ.filter((h) => calls[h] && !calls[h].absolute).join(", ")}.`);
    if (out.missing.length > 3) out.checks.push(`${out.missing.length} inputs weren't weighed: ${out.missing.map((k) => IL[k]).join(", ")}.`);
    out.consistent = !out.checks.length;
    return out;
  }

  /** One focused fix when the calls contradict their evidence or each other (small prompt: no dossier). */
  function repairPrompt(name, today, lean, issues, about = `the US-listed "${name}" industry`, schema = SCHEMA) {
    return `You are the analyst responsible for ${about}. Today is ${today}. Code checked your calls vs the S&P 500 and found problems:
${issues.map((i) => "- " + i).join("\n")}

YOUR CALLS AND EVIDENCE
${JSON.stringify({ headline: lean.headline, evidence: lean.evidence.map(({ input, points, weight, why }) => ({ input, points, weight, why })), calls: lean.calls, verdict: lean.verdict })}

Resolve them: fix the evidence weights if they're wrong, or change the calls (and their "why") if those are. A call that flips direction between timeframes must say what changes in between. Keep the citations. Reply with ONLY the complete corrected answer, in the same JSON shape (all four windows, every input):
${schema}`;
  }


  // ------------------------------------------------------------------ the hard numbers every call is checked against
  const DAYS = { "1M": 21, "3M": 63, "6M": 126, "12M": 252 };
  /** The S&P 500 itself (SPY closes): trailing returns, volatility, distance from its high. Code only. */
  function marketFacts(dates, closes) {
    const n = (closes || []).length; if (n < 30) return null;
    const last = closes[n - 1], ret = (d) => (n > d ? Math.round((last / closes[n - 1 - d] - 1) * 1000) / 10 : null);
    const lr = []; for (let i = Math.max(1, n - 21); i < n; i++) lr.push(Math.log(closes[i] / closes[i - 1]));
    const mu = lr.reduce((a, x) => a + x, 0) / (lr.length || 1), vol = Math.sqrt(lr.reduce((a, x) => a + (x - mu) ** 2, 0) / Math.max(1, lr.length - 1)) * Math.sqrt(252);
    const hi = Math.max(...closes.slice(-252));
    return { date: dates[n - 1], ret: Object.fromEntries(HZ.map((h) => [h, ret(DAYS[h])])), vol20: Math.round(vol * 1000) / 10, from_high: Math.round((last / hi - 1) * 1000) / 10 };
  }
  /** The statistical anchor's own call on the six-level scale (from its chance of beating the S&P 500). */
  function statCall(a) {
    const pb = Number(a?.rel?.prob_beat); if (!isNum(pb)) return null;
    const d = pb - 50, side = d > 0 || (d === 0 && (a.rel.median || 0) >= 0) ? "bullish" : "bearish";
    return Math.abs(d) < 4 ? "slightly " + side : Math.abs(d) < 10 ? side : "strongly " + side;
  }
  /** Dated events inside a window (the calendar's, plus the largest companies reporting). */
  function windowEvents(cal, f, today) {
    if (!f) return [];
    const out = [];
    for (const e of (cal?.events || [])) { const d = (e.dates || [])[0]; if (!d || d < today || d > f.end || e.importance === "low") continue; out.push({ date: d, title: e.title, id: e.id, importance: e.importance }); }
    for (const r of (f.reporting || []).filter((r) => r.weight >= 5)) { if (out.some((e) => e.date === r.date && new RegExp(`\\b${r.symbol}\\b`).test(e.title))) continue; out.push({ date: r.date, title: `${r.symbol} reports (${r.weight}% of the industry)`, importance: "high" }); }
    const seen = new Set();
    return out.filter((e) => { const k = e.date + e.title; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => (a.importance === "high") === (b.importance === "high") ? (a.date < b.date ? -1 : 1) : a.importance === "high" ? -1 : 1).slice(0, 6).sort((a, b) => (a.date < b.date ? -1 : 1));
  }
  /** The scoreboard: per window, the hard numbers (code, not opinion) the calls must square with. */
  function scoreboard(facts, mkt, cal, today) {
    const L = [];
    if (mkt) L.push(`THE S&P 500 ITSELF (SPY, to ${mkt.date}): last month ${mkt.ret["1M"]}%, 3 months ${mkt.ret["3M"]}%, 6 months ${mkt.ret["6M"]}%, 12 months ${mkt.ret["12M"]}%; 20-day volatility ${mkt.vol20}% a year; ${mkt.from_high}% from its 12-month high.`);
    for (const f of facts || []) {
      const sc = statCall(f.anchor), ev = windowEvents(cal, f, today);
      L.push(`${f.h} (to ${f.end}): the industry's trailing ${f.h} ${f.trailing ?? "n/a"}% (${f.vs_spy ?? "n/a"}% vs the S&P 500, ${f.breadth ?? "n/a"}% of its companies beat it); one-sigma move ±${f.sigma ?? "n/a"}%.`
        + (f.anchor ? ` Statistical anchor: ${sc} (vs the S&P 500 median ${f.anchor.rel.median}%, ${f.anchor.rel.prob_beat}% chance of beating it${f.anchor.abs ? `; on its own: median ${f.anchor.abs.median}%, ${f.anchor.abs.prob_up}% chance of being higher` : ""}; out of sample it was right ${f.anchor.test?.hit_rate ?? "?"}% of the time vs ${f.anchor.test?.base_hit_rate ?? "?"}% for the average alone, so ${(f.anchor.test?.hit_rate || 0) - (f.anchor.test?.base_hit_rate || 0) >= 2 ? "it carries some signal" : "treat it as weak"}; pushed by ${(f.anchor.drivers || []).map((d) => `${d.label} ${d.push > 0 ? "+" : ""}${d.push}`).join(", ")}).` : "")
        + (f.like ? ` Past setups most like today: ${f.like.pos}% were higher ${f.h} later (median ${f.like.median}%, n=${f.like.n}).` : "")
        + (ev.length ? ` Dated in this window: ${ev.map((e) => `${e.date} ${e.title}${e.id ? ` [${e.id}]` : ""}`).join("; ")}.` : ""));
    }
    return L.join("\n");
  }

  // ------------------------------------------------------------------ the challenge and the final call
  /** An independent PM, benchmarked to the S&P 500, attacks each call (small prompt: the calls, the evidence, the numbers). */
  function challengePrompt(name, today, lean, board, about = `the US-listed "${name}" industry`) {
    return `You are an independent portfolio manager benchmarked to the S&P 500. You did NOT make the calls below on ${about}, and you are paid to find where they are wrong. Today is ${today}.

THE CALLS (vs the S&P 500) AND THE EVIDENCE BEHIND THEM
${JSON.stringify({ headline: lean.headline, calls: lean.calls, evidence: lean.evidence.map(({ input, points, weight, why }) => ({ input, points, weight, why })) })}
${lean.checks?.length ? `\nCODE'S CHECKS FOUND: ${lean.checks.join(" ")}\n` : ""}
THE HARD NUMBERS (code-computed; the calls must square with them)
${board}

For EACH window:
- Make the strongest case for a different call: the other side, or a different strength. Use the numbers above and the evidence's own citations.
- Name concrete errors: a number misread or contradicted by the scoreboard, a driver that matters to the S&P 500 just as much (so it is not an edge vs the index), double counting, an input ignored, a dated event in the window the call skips, a "strongly" the evidence doesn't support, a call that ignores what the past setups and the statistical anchor say without a reason.
- Check the up-or-down calls too ("sp500" and "absolute"): is the S&P 500 view defensible, and does the absolute call follow from it and the relative call?
- Recommend: "hold" (the call survives), "soften" (same side, weaker), "strengthen", or "flip". Recommend a change only for a real error or a clearly stronger case; don't change calls for the sake of it.

Reply with ONLY this JSON:
{"windows": {"1M": {"recommend": "hold | soften | strengthen | flip", "case": "2-4 sentences: the strongest case against the call", "errors": ["specific errors, if any"]}, "3M": {...}, "6M": {...}, "12M": {...}},
 "overall": "one or two sentences: the biggest weakness across the calls"}`;
  }
  function cleanChallenge(raw) {
    if (!raw || typeof raw !== "object") return null;
    const w = {};
    for (const h of HZ) { const x = raw.windows?.[h]; if (!x) continue; const r = lc(x.recommend);
      w[h] = { recommend: /flip/.test(r) ? "flip" : /soft|weak/.test(r) ? "soften" : /strong/.test(r) ? "strengthen" : "hold", case: trim(x.case, 900), errors: (Array.isArray(x.errors) ? x.errors : []).slice(0, 4).map((e) => trim(e, 300)).filter(Boolean) }; }
    return Object.keys(w).length ? { windows: w, overall: trim(raw.overall, 400) } : null;
  }
  /** The lead answers the challenge and makes the final calls. */
  function finalPrompt(name, today, lean, ch, board, about = `the US-listed "${name}" industry`, extra = "") {
    return `You are the analyst responsible for ${about}. Today is ${today}. You made the calls below vs the S&P 500; an independent portfolio manager challenged them. Make your FINAL calls.

YOUR CALLS AND EVIDENCE
${JSON.stringify({ headline: lean.headline, calls: lean.calls, evidence: lean.evidence.map(({ input, points, weight, why }) => ({ input, points, weight, why })), verdict: lean.verdict })}

THE CHALLENGE
${JSON.stringify(ch)}

THE HARD NUMBERS (code-computed)
${board}

${extra}For each window keep the three calls (the S&P 500's direction, vs the S&P 500, its own direction) adding up: beating a rising market means rising too; lagging a falling market means falling too.
For each window: if the challenge found a real error or made the stronger case, change the call (side or strength) and rewrite its "why"; otherwise hold it and say in one sentence why the challenge doesn't change it. Six levels (${LEVELS.join(", ")}), no neutral, all relative to the S&P 500. Keep the citations; add none that aren't already in your calls or evidence. Fix any evidence entry the challenge showed was wrong.

Reply with ONLY this JSON:
{"headline": "one sentence", "calls": {"1M": {"sp500": "...", "call": "... (vs the S&P 500)", "absolute": "... (its own direction)", "absolute_why": "...", ${extra ? `"vs_industry": "beats | matches | lags", ` : ""}"why": "3-5 sentences vs the S&P 500, cited", "for": ["..."], "against": ["..."], "flips_it": "...", "challenge": "one sentence: what the challenge changed, or why the call holds"}, "3M": {...}, "6M": {...}, "12M": {...}},
 "evidence_fixes": [{"input": "...", "points": "bullish | bearish | mixed", "weight": 1, "why": "..."}],
 "verdict": {"agrees": true, "why": "..."}}`;
  }
  /** The final calls on top of the first ones: what changed is recorded per window. */
  function mergeFinal(lean, raw, ch, opts = {}) {
    if (!raw || typeof raw !== "object" || !raw.calls) return lean;
    const ev = new Map(lean.evidence.map((e) => [e.input, e]));
    for (const e of Array.isArray(raw.evidence_fixes) ? raw.evidence_fixes : []) { const k = keyOf(e?.input, opts.inputs || INPUTS, opts.alias || ALIAS); if (k) ev.set(k, { input: k, points: e.points, weight: e.weight, why: e.why }); }
    const next = cleanLean({ headline: raw.headline || lean.headline, calls: Object.fromEntries(HZ.map((h) => [h, { ...(lean.calls[h] || {}), ...(raw.calls[h] || {}) }])), evidence: [...ev.values()], verdict: raw.verdict || lean.verdict }, opts);
    if (!next) return lean;
    for (const h of HZ) { const a = lean.calls[h], b = next.calls[h]; if (!b) continue;
      b.challenge = { recommend: ch?.windows?.[h]?.recommend || "hold", case: ch?.windows?.[h]?.case || "", errors: ch?.windows?.[h]?.errors || [], answer: trim(String(raw.calls[h]?.challenge || "").replace(/\[[A-Z]{1,6}\d{1,5}[^\]]*\]/g, (m) => m), 400), before: a && a.call !== b.call ? a.call : null }; }
    next.challenge = { overall: ch?.overall || "" };
    return next;
  }


  // ------------------------------------------------------------------ one company: its calls vs the S&P 500
  /** What a company's calls weigh: its industry's calls first, then everything about the company itself. */
  const CO_INPUTS = [
    ["industry", "The industry's calls vs the S&P 500"], ["business", "Business mix & segments"], ["earnings", "Earnings, estimates & revisions"], ["call", "The latest earnings call"],
    ["valuation", "Valuation vs peers & its own history"], ["quality", "Balance sheet & earnings quality"], ["street", "Wall Street consensus"], ["momentum", "Momentum & price action"],
    ["history", "Past setups like today"], ["catalysts", "Dated catalysts ahead"], ["macro", "Macro & rates"], ["world", "World events & trade"], ["regulation", "Regulation & legal"],
    ["competition", "Competitive position & peers"], ["risks", "Risks & red flags"], ["verdict", "The company write-up's verdict"],
  ];
  const CO_ALIAS = { "industry's": "industry", segments: "business", "business mix": "business", estimates: "earnings", revisions: "earnings", transcript: "call", "earnings call": "call",
    "balance sheet": "quality", consensus: "street", analysts: "street", "price action": "momentum", "times like this": "history", "past setups": "history", calendar: "catalysts", events: "catalysts",
    rates: "macro", trade: "world", geopolitics: "world", legal: "regulation", moat: "competition", peers: "competition", "red flags": "risks", "write-up": "verdict" };
  const CO_KEYS = CO_INPUTS.map(([k]) => k);
  const CO_CALL = `{"call": "${LEVELS.join(" | ")} (vs the S&P 500)", "sp500": "${LEVELS.join(" | ")} (the S&P 500 itself: higher or lower at the end of the window)", "absolute": "${LEVELS.join(" | ")} (the company itself: higher or lower at the end of the window)", "absolute_why": "1-2 sentences: the S&P 500's own direction plus the company's edge (or drag) vs it, and so where the company itself ends up, with numbers", "vs_industry": "beats | matches | lags (this company vs its own industry over the window)", "why": "3-5 sentences: start from the industry's call vs the S&P 500 for this window, then what makes this company better or worse than its industry (its own numbers, dated events, beta) and so where it lands vs the S&P 500, with the specific numbers and [IDs]", "for": ["1-3 short reasons on the call's side, cited"], "against": ["1-2 short reasons against it, cited"], "flips_it": "one measurable, dated condition that would flip this call (a price, an estimate, a date)"}`;
  const CO_SCHEMA = `{"headline": "one sentence: the lean vs the S&P 500 and the two or three things that decide it",
 "evidence": [{"input": "${CO_KEYS.join(" | ")}", "points": "bullish | bearish | mixed", "weight": 1, "why": "one or two sentences vs the S&P 500, with the numbers and [IDs]"}],
 "calls": {"1M": ${CO_CALL}, "3M": {...}, "6M": {...}, "12M": {...}},
 "verdict": {"agrees": true, "why": "one or two sentences: do you agree with the company write-up's own verdict and calls, and if not, why"}}`;

  /** The company write-up (already finished), as the calls prompt shows it: compact, no dossier. */
  function coAnalysisText(t) {
    if (!t) return "(no company write-up yet)";
    const o = [], sc = t.scenarios || {};
    o.push(`HEADLINE: ${trim(t.headline, 300)}`);
    if (t.verdict) o.push(`VERDICT: ${t.verdict.call || "?"}: ${trim(t.verdict.summary, 600)}`);
    if (t.thesis) o.push(`THESIS: ${trim(t.thesis, 2200)}`);
    if (t.vs_industry) o.push(`VS ITS INDUSTRY: ${t.vs_industry.call || "?"}: ${trim(t.vs_industry.why, 500)}`);
    if (t.valuation) o.push(`VALUATION: ${trim(t.valuation.read, 600)}${t.valuation.fair_value?.length ? ` Fair value ${t.valuation.fair_value.join("-")}.` : ""}`);
    if (t.street) o.push(`VS THE STREET: ${t.street.stance || "?"}: ${trim(t.street.summary, 500)}`);
    if (t.moat) o.push(`MOAT: ${t.moat.rating || "?"}; sources ${(t.moat.sources || []).slice(0, 4).map((x) => trim(x, 100)).join("; ")}; threats ${(t.moat.threats || []).slice(0, 3).map((x) => trim(x, 100)).join("; ")}`);
    if (t.quality) o.push(`QUALITY: ${trim(t.quality, 400)}`);
    if (t.management) o.push(`MANAGEMENT: ${trim(t.management, 400)}`);
    const sk = ["bull", "base", "bear"].filter((k) => sc[k]);
    if (sk.length) o.push(`SCENARIOS (12M): ${sk.map((k) => `${k} ${sc[k].probability ?? "?"}%: EPS ${(sc[k].eps_change || []).join(" to ")}%, P/E ${(sc[k].pe || []).join("-")}, target ${(sc[k].price_target || []).join("-")}. ${trim(sc[k].narrative, 250)}`).join(" | ")}`);
    for (const h of HZ) { const x = t.horizons?.[h]; if (x) o.push(`EARLIER CALL ${h} (absolute): ${x.call}, ${(x.expected_move || []).join(" to ")}%, ${x.probability_up ?? "?"}% up, ${x.vs_industry || "?"} vs its industry. ${trim(x.drivers, 500)}`); }
    if ((t.drivers || []).length) o.push(`INDUSTRY DRIVERS FOR THIS COMPANY: ${t.drivers.slice(0, 6).map((d) => `${trim(d.driver, 80)}: ${d.effect || "?"} (${trim(d.why, 200)})`).join(" | ")}`);
    if ((t.risks || []).length) o.push(`RISKS: ${t.risks.slice(0, 6).map((r) => `${trim(r.risk, 160)} (${r.likelihood}/${r.impact})`).join("; ")}`);
    if ((t.catalysts || []).length) o.push(`CATALYSTS: ${t.catalysts.slice(0, 6).map((c) => `${c.date} ${trim(c.event, 120)}`).join("; ")}`);
    if (t.lens?.macro?.headline) o.push(`MACRO FOR THIS COMPANY: ${t.lens.macro.regime || "?"}: ${trim(t.lens.macro.headline, 300)}`);
    if (t.lens?.trade_overall?.summary) o.push(`TRADE FOR THIS COMPANY: ${t.lens.trade_overall.risk || "?"} risk: ${trim(t.lens.trade_overall.summary, 400)}`);
    if (t.lens?.reg_overall?.summary) o.push(`REGULATION FOR THIS COMPANY: ${t.lens.reg_overall.stance || "?"}: ${trim(t.lens.reg_overall.summary, 400)}`);
    if ((t.change_mind || t.lens?.change_mind || []).length) o.push(`WHAT WOULD CHANGE THE CALL: ${(t.change_mind || t.lens.change_mind).slice(0, 4).map((x) => trim(x, 160)).join("; ")}`);
    return o.join("\n");
  }
  /** The industry's own calls vs the S&P 500 (made, or provisional), for the company prompt. */
  function indCallsText(ind, name) {
    if (!ind?.calls) return `(the ${name} industry has no calls vs the S&P 500 yet)`;
    return `${ind.provisional ? `PROVISIONAL (read off the industry's earlier calls; weigh lightly): ` : ""}${trim(ind.headline, 300)}\n${HZ.filter((h) => ind.calls[h]).map((h) => `${h}: ${ind.calls[h].call}${ind.calls[h].why ? `: ${trim(ind.calls[h].why, 600)}` : ""}${ind.calls[h].flips_it ? ` (flips if: ${trim(ind.calls[h].flips_it, 200)})` : ""}`).join("\n")}`;
  }
  /**
   * The company's scoreboard (code): per window, the stock vs the S&P 500 and vs its industry, its normal move, its
   * own base rate, the industry's call, and who reports inside the window. w: coWindows rows (+ vs_ind).
   */
  function coScoreboard({ sym, windows, ind, mkt, beta, times, events }) {
    const L = [];
    if (mkt) L.push(`THE S&P 500 ITSELF (SPY, to ${mkt.date}): last month ${mkt.ret["1M"]}%, 3 months ${mkt.ret["3M"]}%, 6 months ${mkt.ret["6M"]}%, 12 months ${mkt.ret["12M"]}%; 20-day volatility ${mkt.vol20}% a year; ${mkt.from_high}% from its 12-month high.`);
    if (isNum(beta)) L.push(`${sym}'s beta to the S&P 500 is ${beta.toFixed(2)}: ${beta > 1.15 ? "it amplifies the market's moves, so in a falling market it tends to lag even when its story is fine" : beta < 0.85 ? "it dampens the market's moves, so it tends to beat the S&P 500 in a falling market and lag in a strong one" : "it moves about with the market"}.`);
    for (const w of windows || []) {
      const ic = ind?.calls?.[w.h]?.call, ev = (events || []).filter((e) => e.date >= (w.from || "") && e.date <= w.end).slice(0, 5);
      L.push(`${w.h} (to ${w.end}): ${sym}'s trailing ${w.h} ${w.trailing ?? "n/a"}% (${w.vs_spy ?? "n/a"}% vs the S&P 500${isNum(w.vs_ind) ? `, ${w.vs_ind}% vs its industry` : ""}); one-sigma move ±${w.sigma ?? "n/a"}%; in its own history higher ${w.base_up ?? "n/a"}% of the time over this span.`
        + (ic ? ` The industry's call vs the S&P 500: ${ic}${ind.provisional ? " (provisional)" : ""}.` : "")
        + (w.own ? ` ${sym} reports ${w.own}.` : ` ${sym} does not report in this window.`)
        + (w.peers?.length ? ` Peers reporting: ${w.peers.map((p) => `${p.symbol} ${p.date}`).join(", ")}.` : "")
        + (ev.length ? ` Also dated: ${ev.map((e) => `${e.date} ${trim(e.title, 90)}${e.id ? ` [${e.id}]` : ""}`).join("; ")}.` : ""));
    }
    if (times) L.push(`IN TIMES LIKE THIS (what ${sym} did after the industry's closest past months):\n${trim(times, 1800)}`);
    return L.join("\n");
  }
  /** The calls prompt for one company (compact: the finished write-up, the industry's calls, the scoreboard, the facts). */
  function coLeanPrompt(c) {
    return `You are the analyst covering ${c.name} (${c.sym}) in the US-listed "${c.industry}" industry. Today is ${c.today}. The full write-up on the company and the industry's own calls are done. An investor asks: FOR EACH TIMEFRAME, DOES ${c.sym} BEAT OR LAG THE S&P 500, HOW STRONGLY, AND WHY?

=== THE INDUSTRY'S CALLS VS THE S&P 500 (the strategist's, from the whole industry dossier) ===
${indCallsText(c.ind, c.industry)}
${c.indLatest ? `The industry's latest update: ${trim(c.indLatest, 700)}` : ""}

=== THE COMPANY WRITE-UP (finished) ===
${coAnalysisText(c.write)}

=== THE COMPANY'S NUMBERS (code-computed) ===
${trim(c.facts, 5000)}

=== THE SCOREBOARD (code-computed, per window) ===
${c.board}
${(c.news || []).length ? `\n=== RECENT NEWS AND RELEASES (cite by ID) ===\n${c.news.slice(0, 20).map((x) => `[${x.id}] ${x.date ? x.date + " " : ""}${trim(x.title, 180)}`).join("\n")}` : ""}
${(c.mentions || []).length ? `\n=== WHAT THE INDUSTRY ANALYSIS SAYS ABOUT ${c.sym} (cite by ID) ===\n${c.mentions.slice(0, 25).map((m) => `[${m.id}] ${m.section}: ${trim(m.text, 220)}`).join("\n")}` : ""}

HOW TO MAKE THE CALLS
- "call" is RELATIVE TO THE S&P 500: "bullish" means ${c.sym} beats the S&P 500 over that window, "bearish" means it lags it.
- For EACH window make three calls on the same six-level scale: "sp500", the S&P 500's own direction (will the index be higher or lower at the end of the window); "call", ${c.sym} vs the S&P 500; and "absolute", ${c.sym}'s own direction (will it be higher or lower). They must add up: beating a rising market means it rises too, and lagging a falling market means it falls too; only when the two point opposite ways can the absolute call go either way, and then "absolute_why" says which force wins and by how much (the market drifts up about 7% a year, so over 12 months "slightly bullish" for the S&P 500 is the default without a reason). Code checks this.
- Build each call in two steps: (1) the industry's call vs the S&P 500 for the window (above); (2) does ${c.sym} beat, match or lag its own industry over the window ("vs_industry"), from its own numbers, dated events (its own report first), valuation, the street, momentum and beta. The call follows: beats the industry -> at least the industry's level; lags it -> at most; matches -> within one step. Code checks this.
- Six levels, no neutral. "slightly": a close call. Plain "bullish" / "bearish": the evidence clearly points that way. "strongly": most inputs point the same way and decisively; rare.
- First weigh EVERY input, one entry each, in this order: ${CO_KEYS.join(", ")}. For each: which way it points vs the S&P 500 ("bullish" / "bearish" / "mixed"), how much it matters for ${c.sym} (weight 1 = minor, 2 = material, 3 = decisive), and why, with numbers and [IDs]. An input with nothing to go on is "mixed", weight 1.
- Square every call with the scoreboard: where you go against the stock's own trailing trend, its base rate or what it did in times like this, say why; where it reports inside the window, say how the print cuts.
- Different windows can differ, but a call that flips direction from one window to the next must say what changes in between.
- No price targets or expected returns. Cite only IDs given above. Plain words.

Reply with ONLY this JSON (all four windows):
${CO_SCHEMA}`;
  }
  const coAbout = (name, sym, industry) => `${name} (${sym}), a company in the US-listed "${industry}" industry`;
  const CO_FINAL_EXTRA = `Keep each window's "vs_industry" (beats, matches or lags its industry) consistent with the call: beats the industry -> at least the industry's level vs the S&P 500; lags -> at most; matches -> within one step.\n`;

  /** Until the strategist has made one: provisional calls read off the earlier calls (no Claude). */
  function provisional(res, today = "") {
    if (!res?.horizons) return null;
    const calls = {};
    for (const h of HZ) { const x = res.horizons[h]; if (!x) continue;
      const v = x.vs_spy, base = v?.call || x.call, s = lc(base);
      let l = level(base);
      if (!l || s === "neutral") { const pb = Number(v?.probability_beat), pu = Number(x.probability_up), op = res.opportunity?.verdict;
        l = isNum(pb) ? (pb >= 50 ? "slightly bullish" : "slightly bearish") : op === "yes" ? "slightly bullish" : op === "no" ? "slightly bearish" : isNum(pu) && pu >= 55 ? "slightly bullish" : "slightly bearish"; }
      else if (!/slight|strong/.test(s)) l = level("slightly " + l);
      let ab = level(x.call); const sa = lc(x.call);
      if (!ab) ab = isNum(Number(x.probability_up)) && Number(x.probability_up) >= 50 ? "slightly bullish" : "slightly bearish"; else if (!/slight|strong/.test(sa)) ab = level("slightly " + ab);
      calls[h] = { call: l, absolute: ab, basis: v ? "the earlier call vs the S&P 500" : "the earlier absolute call" }; }
    if (!Object.keys(calls).length) return null;
    return { v: 2, date: today, provisional: true, headline: "Provisional: read off the earlier calls. Press the button for the strategist's calls, up or down and vs the S&P 500, with the reasons.", calls, evidence: [], checks: [] };
  }

  /** The lean to show: the strategist's (this format), or a provisional one. */
  const leanOf = (res, today = "") => (res?.lean?.v === 2 && res.lean.calls ? res.lean : provisional(res, today));

  /** Did the 12M call change side (a made lean to a new one)? */
  const flipped = (a, b) => !!(a && b && !a.provisional && a.v === 2 && a.calls?.["12M"] && b.calls?.["12M"] && Math.sign(SIGN[a.calls["12M"].call]) !== Math.sign(SIGN[b.calls["12M"].call]));
  /** One line for a table or a progress note. */
  const leanLine = (l) => (l ? HZ.filter((h) => l.calls?.[h]).map((h) => `${h} ${l.calls[h].call} vs the S&P 500${l.calls[h].absolute ? `, ${l.calls[h].absolute} itself` : ""}`).join("; ") + (l.provisional ? " (provisional)" : "") : "");

  const Lean = { HZ, HZ_LABEL, LEVELS, SIGN, level, cls, label, INPUTS, LABEL, KEYS, keyOf, analysisText, leanPrompt, cleanLean, tally, checks, repairPrompt, provisional, leanOf, leanLine, flipped, SCHEMA, DAYS, marketFacts, statCall, windowEvents, scoreboard, challengePrompt, cleanChallenge, finalPrompt, mergeFinal, CO_INPUTS, CO_ALIAS, CO_KEYS, CO_SCHEMA, coAnalysisText, indCallsText, coScoreboard, coLeanPrompt, coAbout, CO_FINAL_EXTRA, ORD };
  if (typeof module !== "undefined" && module.exports) module.exports = Lean;
  else root.Lean = Lean;
})(typeof window !== "undefined" ? window : globalThis);
