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
  const keyOf = (s) => { const t = lc(s); if (KEYS.includes(t)) return t; const hit = INPUTS.find(([, l]) => lc(l) === t); if (hit) return hit[0];
    for (const k of KEYS) if (t.startsWith(k)) return k; for (const [a, k] of Object.entries(ALIAS)) if (t.includes(a)) return k; return null; };

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

  const CALL = `{"call": "${LEVELS.join(" | ")}", "why": "3-5 sentences: what the S&P 500 is likely to do over this window and what drives it, and why this industry does better or worse than it, with the specific numbers and [IDs]", "for": ["1-3 short reasons on the call's side, cited"], "against": ["1-2 short reasons against it, cited"], "flips_it": "one measurable, dated condition that would flip this call"}`;
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
${facts.length ? `\n=== THE STATISTICAL ANCHOR (momentum, the trend and valuation, tested out of sample) ===\n${facts.map((f) => `${f.h}: ${Horizon.anchorText(f.anchor)}`).join("\n")}` : ""}
${ctx.scorecard ? `\n${ctx.scorecard}` : ""}
${(ctx.wire || []).length ? `\n=== TODAY'S WIRE (latest headlines touching this industry) ===\n${ctx.wire.slice(0, 15).map((w) => `[${w.id}] ${w.date ? w.date + " " : ""}${trim(w.title, 200)}`).join("\n")}` : ""}

HOW TO MAKE THE CALLS
- Every call is RELATIVE TO THE S&P 500: "bullish" means the industry beats the S&P 500 over that window, "bearish" means it lags it. Its absolute direction doesn't matter: an industry that falls 5% while the S&P 500 falls 12% is bullish.
- Six levels, no neutral. "slightly": a close call that tips one way. Plain "bullish" / "bearish": the evidence clearly points that way. "strongly": most inputs point the same way and decisively; use it rarely. If it's close, pick the side the evidence tips toward and say "slightly".
- First weigh EVERY input, one entry each, in this order: world, macro, trade, regulation, earnings, chain, valuation, positioning, momentum, history, catalysts, scenarios, calls, redteam, verdict. For each: which way it points vs the S&P 500 ("bullish" / "bearish" / "mixed"), how much it matters for THIS industry (weight 1 = minor, 2 = material, 3 = decisive), and why, with the numbers and the dossier's [IDs]. An input with nothing in the dossier is "mixed", weight 1, and says so.
- Then make the four calls from that evidence. Different windows can differ (near-term momentum, a dated catalyst, valuation that only matters over a year), but a call that flips direction from one window to the next must say in its "why" what changes in between.
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
  function cleanLean(raw, { res = null, today = "", known = null } = {}) {
    if (!raw || typeof raw !== "object") return null;
    const r = raw.lean && typeof raw.lean === "object" && raw.lean.calls ? raw.lean : raw;
    const ids = known ? new Set(known) : null;
    const cite = (t, k) => trim(String(t || "").replace(/\[([A-Z]{1,6}\d{1,5}(?:\s*,\s*[A-Z]{1,6}\d{1,5})*)\]/g, (m, g) => { if (!ids) return m; const keep = g.split(/\s*,\s*/).filter((i) => ids.has(i)); return keep.length ? `[${keep.join(", ")}]` : ""; }).replace(/\s+([.,;:])/g, "$1"), k);
    const list = (a, n, k) => (Array.isArray(a) ? a : a ? [a] : []).slice(0, n).map((x) => cite(x, k)).filter(Boolean);
    const calls = {};
    for (const h of HZ) { const c = r.calls?.[h] || r.calls?.[h.toLowerCase()]; const l = level(c?.call); if (!l) continue;
      calls[h] = { call: l, why: cite(c.why, 1400), for: list(c.for, 3, 300), against: list(c.against, 2, 300), flips_it: cite(c.flips_it, 300) }; }
    if (!Object.keys(calls).length) return null;
    const seen = new Set(), evidence = [];
    for (const e of Array.isArray(r.evidence) ? r.evidence : []) {
      const k = keyOf(e?.input); if (!k || seen.has(k)) continue; seen.add(k);
      const p = lc(e?.points); const points = /bull|positive|beat|outperf/.test(p) ? "bullish" : /bear|negative|lag|underperf/.test(p) ? "bearish" : "mixed";
      evidence.push({ input: k, label: LABEL[k], points, weight: Math.max(1, Math.min(3, Math.round(Number(e?.weight) || 1))), why: cite(e?.why, 500) });
    }
    evidence.sort((a, b) => KEYS.indexOf(a.input) - KEYS.indexOf(b.input));
    const out = { v: 2, date: today, headline: cite(r.headline, 400), calls, evidence, tally: tally(evidence), missing: KEYS.filter((k) => !seen.has(k)),
      verdict: { agrees: r.verdict?.agrees !== false && lc(r.verdict?.agrees) !== "false", why: cite(r.verdict?.why, 600) } };
    out.checks = checks(out);
    if (HZ.some((h) => !calls[h])) out.checks.push(`No call for ${HZ.filter((h) => !calls[h]).join(", ")}.`);
    if (out.missing.length > 3) out.checks.push(`${out.missing.length} inputs weren't weighed: ${out.missing.map((k) => LABEL[k]).join(", ")}.`);
    out.consistent = !out.checks.length;
    return out;
  }

  /** One focused fix when the calls contradict their evidence or each other (small prompt: no dossier). */
  function repairPrompt(name, today, lean, issues) {
    return `You are the head of research for the US-listed "${name}" industry. Today is ${today}. Code checked your calls vs the S&P 500 and found problems:
${issues.map((i) => "- " + i).join("\n")}

YOUR CALLS AND EVIDENCE
${JSON.stringify({ headline: lean.headline, evidence: lean.evidence.map(({ input, points, weight, why }) => ({ input, points, weight, why })), calls: lean.calls, verdict: lean.verdict })}

Resolve them: fix the evidence weights if they're wrong, or change the calls (and their "why") if those are. A call that flips direction between timeframes must say what changes in between. Keep the citations. Reply with ONLY the complete corrected answer, in the same JSON shape (all four windows, all fifteen inputs):
${SCHEMA}`;
  }

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
      calls[h] = { call: l, basis: v ? "the earlier call vs the S&P 500" : "the earlier absolute call" }; }
    if (!Object.keys(calls).length) return null;
    return { v: 2, date: today, provisional: true, headline: "Provisional: read off the earlier calls. Press the button for the strategist's calls vs the S&P 500, with the reasons.", calls, evidence: [], checks: [] };
  }

  /** The lean to show: the strategist's (this format), or a provisional one. */
  const leanOf = (res, today = "") => (res?.lean?.v === 2 && res.lean.calls ? res.lean : provisional(res, today));

  /** Did the 12M call change side (a made lean to a new one)? */
  const flipped = (a, b) => !!(a && b && !a.provisional && a.v === 2 && a.calls?.["12M"] && b.calls?.["12M"] && Math.sign(SIGN[a.calls["12M"].call]) !== Math.sign(SIGN[b.calls["12M"].call]));
  /** One line for a table or a progress note. */
  const leanLine = (l) => (l ? HZ.filter((h) => l.calls?.[h]).map((h) => `${h} ${l.calls[h].call}`).join(", ") + (l.provisional ? " (provisional)" : "") : "");

  const Lean = { HZ, HZ_LABEL, LEVELS, SIGN, level, cls, label, INPUTS, LABEL, KEYS, keyOf, analysisText, leanPrompt, cleanLean, tally, checks, repairPrompt, provisional, leanOf, leanLine, flipped, SCHEMA };
  if (typeof module !== "undefined" && module.exports) module.exports = Lean;
  else root.Lean = Lean;
})(typeof window !== "undefined" ? window : globalThis);
