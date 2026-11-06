/* Industry Scorer: the lean. One decisive call per industry: which way it leans vs the S&P 500, how sure, and why.
 *
 * The lead strategist (Opus) reads EVERYTHING: the full dossier (every analyst's report: world, macro, trade,
 * regulation, earnings and KPIs, customers and suppliers, valuation, positioning, momentum, history) plus its own
 * finished analysis (scenarios and their math, the 1M-12M calls vs the S&P 500, the statistical anchor and its tested
 * record, the red team, the opportunity verdict and today's update). It must pick a side (no "neutral"), score every
 * input for which way it points and how hard, and say whether it agrees with its own opportunity verdict.
 * Code then tallies the evidence and flags a lean that goes against its own evidence or its own 12M call.
 * Pure functions, no I/O.
 */
(function (root) {
  "use strict";
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const trim = (s, k) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > k ? s.slice(0, k - 1) + "…" : s; };
  const lc = (s) => String(s ?? "").toLowerCase().trim();
  const HZ = ["1M", "3M", "6M", "12M"];
  const req = (f, g) => (typeof module !== "undefined" && module.exports ? require(f) : root[g]);
  const Horizon = req("./horizon.js", "Horizon");

  /** Every input the lean must weigh, in the order shown. */
  const INPUTS = [
    ["world", "World & geopolitics"], ["macro", "Macro & rates"], ["trade", "Trade & tariffs"], ["regulation", "Regulation & policy"],
    ["earnings", "Earnings, estimates & KPIs"], ["chain", "Customers & suppliers"], ["valuation", "Valuation"], ["positioning", "Positioning & flows"],
    ["momentum", "Momentum & the statistical anchor"], ["history", "History: times like this"], ["catalysts", "Dated catalysts ahead"],
    ["scenarios", "Bull / base / bear scenarios"], ["calls", "The 1M-12M calls"], ["redteam", "Red team & risks"], ["verdict", "The lead's opportunity verdict"],
  ];
  const LABEL = Object.fromEntries(INPUTS);
  const KEYS = INPUTS.map(([k]) => k);
  const ALIAS = { "world & geopolitics": "world", geopolitics: "world", "macro & rates": "macro", rates: "macro", tariffs: "trade", "trade & tariffs": "trade", regulation: "regulation", policy: "regulation", "regulation & policy": "regulation",
    earnings: "earnings", kpis: "earnings", kpi: "earnings", estimates: "earnings", "earnings & kpis": "earnings", "earnings, estimates & kpis": "earnings", "customers & suppliers": "chain", supply: "chain", "supply chain": "chain",
    flows: "positioning", "positioning & flows": "positioning", momentum: "momentum", anchor: "momentum", "momentum & the statistical anchor": "momentum", "statistical anchor": "momentum", "times like this": "history", history: "history",
    catalysts: "catalysts", calendar: "catalysts", events: "catalysts", scenarios: "scenarios", "the calls": "calls", horizons: "calls", "red team": "redteam", risks: "redteam", "red team & risks": "redteam",
    verdict: "verdict", "lead verdict": "verdict", "the lead verdict": "verdict", opportunity: "verdict", "opportunity verdict": "verdict" };
  const keyOf = (s) => { const t = lc(s); if (KEYS.includes(t)) return t; if (ALIAS[t]) return ALIAS[t]; const hit = INPUTS.find(([k, l]) => lc(l) === t); if (hit) return hit[0];
    for (const [a, k] of Object.entries(ALIAS)) if (t.includes(a)) return k; return null; };

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
      o.push(`CALL ${h}: ${x.call}, conviction ${x.conviction ?? "?"}/10, ${(x.expected_move || []).join(" to ")}% absolute, ${x.probability_up ?? "?"}% chance higher${v ? `; vs the S&P 500: ${v.call || "?"}, ${(v.expected_excess || []).join(" to ")}% excess, ${v.probability_beat ?? "?"}% chance of beating it` : ""}${a ? `; statistical anchor vs S&P median ${a.rel?.median ?? a.rel_median ?? "?"}%` : ""}. Why: ${trim(x.drivers, 600)}`); }
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

  const SCHEMA = `{"lean": "bullish | bearish", "absolute": "up | down",
 "probability": 62, "horizon": "1M | 3M | 6M | 12M", "headline": "one sentence: leaning bullish/bearish because ... (the two or three things that decide it)",
 "summary": "4-6 sentences weighing the evidence: what the bull side has, what the bear side has, why one outweighs the other, and what is priced in",
 "evidence": [{"input": "world | macro | trade | regulation | earnings | chain | valuation | positioning | momentum | history | catalysts | scenarios | calls | redteam | verdict", "points": "bullish | bearish | mixed", "weight": 1, "why": "one or two sentences with the specific numbers and [IDs]"}],
 "verdict": {"agrees": true, "why": "one or two sentences: do you agree with the lead's opportunity verdict and the calls, and if not, why the weight of everything else points the other way"},
 "decides_it": "the single dated event or number that settles which side is right, and when",
 "flips_it": ["2-4 measurable, dated conditions that would flip the lean"]}`;

  /**
   * The prompt. ctx: {today, dossier (Brain.dossier text), res (the lead's result), facts (Horizon.horizonFacts),
   * scorecard text, wire: today's headlines [{id, title, date}]}.
   */
  function leanPrompt(name, ctx) {
    const facts = (ctx.facts || []).filter((f) => f.anchor);
    return `You are the head of research for the US-listed "${name}" industry. Today is ${ctx.today}. Your team has finished its work: the dossier below holds every analyst's report, and below it is your own finished analysis. An investor now asks one question: WHICH WAY DOES IT LEAN? Make the call.

${ctx.dossier || "(dossier unavailable: use the analysis)"}

=== YOUR FINISHED ANALYSIS (the lead strategist's, kept up to date daily) ===
${analysisText(ctx.res)}
${facts.length ? `\n=== THE STATISTICAL ANCHOR (momentum, the trend and valuation, tested out of sample) ===\n${facts.map((f) => `${f.h}: ${Horizon.anchorText(f.anchor)}`).join("\n")}` : ""}
${ctx.scorecard ? `\n${ctx.scorecard}` : ""}
${(ctx.wire || []).length ? `\n=== TODAY'S WIRE (latest headlines touching this industry) ===\n${ctx.wire.slice(0, 15).map((w) => `[${w.id}] ${w.date ? w.date + " " : ""}${trim(w.title, 200)}`).join("\n")}` : ""}

HOW TO MAKE THE CALL
- Pick a side: "bullish" means the industry beats the S&P 500 over the horizon; "bearish" means it lags it. No "neutral": if it is close, pick the side the evidence tips toward and give a probability near 50.
- Weigh EVERY input, one entry each, in this order: world, macro, trade, regulation, earnings, chain, valuation, positioning, momentum, history, catalysts, scenarios, calls, redteam, verdict. For each: which way it points ("bullish" / "bearish" / "mixed"), how much it matters for THIS industry over the horizon (weight 1 = minor, 2 = material, 3 = decisive), and why, with the specific numbers and the dossier's [IDs]. An input with nothing in the dossier is "mixed", weight 1, and says so.
- The lead's opportunity verdict and the calls are inputs, not the answer: if the rest of the evidence points the other way, say so and lean the other way. If you agree, say why the evidence supports them.
- "absolute": whether the industry is more likely up or down over the horizon (the market's own drift is about +7% a year).
- "probability": the chance the lean is right, vs the S&P 500 over the horizon, 50-85. Be calibrated: the statistical anchor has called the direction vs the S&P 500 right only about 55% of the time out of sample, so 70+ needs evidence that is lopsided across most inputs, and 80+ is rare.
- "horizon": the window where you have the most conviction (12M unless a nearer window is clearly decisive).
- The lean must follow from the evidence you list: code tallies your weights and flags a lean that goes against them, or against your own call vs the S&P 500 for the same window without an explanation in "verdict".
- Cite only IDs in the dossier or today's wire. Plain words; no hedging filler.

Reply with ONLY this JSON:
${SCHEMA}`;
  }

  /** Tally the evidence: +1 bullish, -1 bearish, 0 mixed, times its weight. score in [-1, 1]. */
  function tally(evidence) {
    let s = 0, w = 0; const bull = [], bear = [], mixed = [];
    for (const e of evidence || []) { const wt = e.weight || 1; w += wt; if (e.points === "bullish") { s += wt; bull.push(e.input); } else if (e.points === "bearish") { s -= wt; bear.push(e.input); } else mixed.push(e.input); }
    return { score: w ? Math.round((s / w) * 100) / 100 : 0, bull, bear, mixed, weight: w };
  }

  /** The call vs the S&P 500 for a window, as a probability of beating it (null if there is none). */
  function callBeat(res, h) {
    const x = res?.horizons?.[h]; if (!x) return null;
    if (isNum(Number(x.vs_spy?.probability_beat)) && x.vs_spy?.probability_beat !== null && x.vs_spy?.probability_beat !== undefined) return Number(x.vs_spy.probability_beat);
    return null;
  }

  /** Clean the model's answer; add code's tally and checks. */
  function cleanLean(raw, { res = null, today = "", known = null } = {}) {
    if (!raw || typeof raw !== "object") return null;
    const r = raw.lean && typeof raw.lean === "object" ? raw.lean : raw;
    const side = /bear|under|short|negative/.test(lc(r.lean || r.call)) ? "bearish" : /bull|over|outperf|long|positive/.test(lc(r.lean || r.call)) ? "bullish" : null;
    if (!side) return null;
    const ids = known ? new Set(known) : null;
    const cite = (t, k) => trim(String(t || "").replace(/\[([A-Z]{1,6}\d{1,5}(?:\s*,\s*[A-Z]{1,6}\d{1,5})*)\]/g, (m, g) => { if (!ids) return m; const keep = g.split(/\s*,\s*/).filter((i) => ids.has(i)); return keep.length ? `[${keep.join(", ")}]` : ""; }).replace(/\s+([.,;:])/g, "$1"), k);
    const seen = new Set(), evidence = [];
    for (const e of Array.isArray(r.evidence) ? r.evidence : []) {
      const k = keyOf(e?.input); if (!k || seen.has(k)) continue; seen.add(k);
      const p = lc(e?.points); const points = /bull|positive|up/.test(p) ? "bullish" : /bear|negative|down/.test(p) ? "bearish" : "mixed";
      evidence.push({ input: k, label: LABEL[k], points, weight: Math.max(1, Math.min(3, Math.round(Number(e?.weight) || 1))), why: cite(e?.why, 500) });
    }
    evidence.sort((a, b) => KEYS.indexOf(a.input) - KEYS.indexOf(b.input));
    const horizon = HZ.includes(String(r.horizon || "").toUpperCase()) ? String(r.horizon).toUpperCase() : "12M";
    let probability = Math.round(Number(r.probability));
    if (!isNum(probability)) probability = 55;
    probability = Math.max(51, Math.min(85, probability)); // a forced side is at least a coin flip's edge
    const t = tally(evidence);
    const out = { date: today, lean: side, absolute: /down|lower|fall/.test(lc(r.absolute)) ? "down" : "up", probability, horizon,
      strength: probability >= 70 ? "strong" : probability >= 60 ? "clear" : "slight",
      headline: cite(r.headline, 400), summary: cite(r.summary, 1600), evidence,
      verdict: { agrees: r.verdict?.agrees !== false && lc(r.verdict?.agrees) !== "false", why: cite(r.verdict?.why, 600) },
      decides_it: cite(r.decides_it, 400), flips_it: (Array.isArray(r.flips_it) ? r.flips_it : []).slice(0, 4).map((x) => cite(x, 300)).filter(Boolean),
      tally: t, missing: KEYS.filter((k) => !seen.has(k)), checks: [] };
    // Code's checks.
    const dir = side === "bullish" ? 1 : -1;
    if (t.score * dir < -0.15) out.checks.push(`The lean is ${side}, but the evidence it lists tips the other way (score ${t.score > 0 ? "+" : ""}${t.score}).`);
    const pb = callBeat(res, horizon);
    if (pb !== null && ((side === "bullish" && pb < 45) || (side === "bearish" && pb > 55)))
      out.checks.push(`The lean is ${side}, but the ${horizon} call gives a ${pb}% chance of beating the S&P 500${out.verdict.why ? "; the lean explains why it differs" : ""}.`);
    if (probability >= 75 && Math.abs(t.score) < 0.4) out.checks.push(`A ${probability}% lean from evidence that is only ${Math.round(Math.abs(t.score) * 100)}% one-sided.`);
    if (out.missing.length > 3) out.checks.push(`${out.missing.length} inputs weren't weighed: ${out.missing.map((k) => LABEL[k]).join(", ")}.`);
    out.consistent = !out.checks.some((c) => /tips the other way/.test(c));
    return out.headline || evidence.length ? out : null;
  }

  /** One focused fix when the lean contradicts its own evidence (small prompt: no dossier). */
  function repairPrompt(name, today, lean, issues) {
    return `You are the head of research for the US-listed "${name}" industry. Today is ${today}. Code checked your lean and found contradictions:
${issues.map((i) => "- " + i).join("\n")}

YOUR LEAN
${JSON.stringify({ lean: lean.lean, absolute: lean.absolute, probability: lean.probability, horizon: lean.horizon, headline: lean.headline, summary: lean.summary, evidence: lean.evidence.map(({ input, points, weight, why }) => ({ input, points, weight, why })), verdict: lean.verdict, decides_it: lean.decides_it, flips_it: lean.flips_it })}

Resolve them: either the evidence weights are wrong (fix them) or the lean is (flip it, and rewrite the headline and summary). Keep the citations. Reply with ONLY the complete corrected lean, in the same JSON shape:
${SCHEMA}`;
  }

  /** Until the strategist has made one: a provisional lean read off the calls (no Claude). */
  function provisional(res, today = "") {
    if (!res) return null;
    for (const h of ["12M", "6M"]) {
      const pb = callBeat(res, h);
      if (pb !== null) { const side = pb >= 50 ? "bullish" : "bearish"; const p = Math.max(51, Math.min(85, Math.round(side === "bullish" ? pb : 100 - pb)));
        return { date: today, provisional: true, lean: side, probability: p, horizon: h, strength: p >= 70 ? "strong" : p >= 60 ? "clear" : "slight", absolute: (res.horizons[h].probability_up ?? 50) >= 50 ? "up" : "down",
          headline: `Read off the ${h} call vs the S&P 500 (${pb}% chance of beating it); the strategist's full lean comes with the next update.`, evidence: [], checks: [] }; }
    }
    // No view vs the S&P 500 yet: the 12M call's own direction (its absolute numbers run below the market's drift
    // for nearly every industry, so they can't rank one against the market); neutral goes the way of the verdict.
    const v = res.opportunity?.verdict, x = res.horizons?.["12M"];
    if (!v && !x) return null;
    const c = lc(x?.call), up = isNum(Number(x?.probability_up)) ? Number(x.probability_up) : 50;
    const side = /bull/.test(c) ? "bullish" : /bear/.test(c) ? "bearish" : v === "yes" ? "bullish" : v === "no" ? "bearish" : up >= 55 ? "bullish" : "bearish";
    const p = /strong/.test(c) ? 58 : /slight/.test(c) ? 53 : 51;
    return { date: today, provisional: true, lean: side, probability: p, horizon: "12M", strength: "slight", absolute: up >= 50 ? "up" : "down",
      headline: `Read off the 12M call (${x?.call || "none"}, ${up}% chance higher) and the opportunity verdict (${v || "none"}); the strategist's full lean, weighing every input vs the S&P 500, comes with the next update.`, evidence: [], checks: [] };
  }

  /** The lean to show: the strategist's, or a provisional one. */
  const leanOf = (res, today = "") => res?.lean || provisional(res, today);

  /** One line for a table or the daily prompt. */
  const leanLine = (l) => (l ? `${l.lean === "bullish" ? "Bullish" : "Bearish"} vs the S&P 500 (${l.probability}%, ${l.horizon})${l.provisional ? " provisional" : ""}: ${trim(l.headline, 240)}` : "");

  const Lean = { INPUTS, LABEL, KEYS, keyOf, analysisText, leanPrompt, cleanLean, tally, repairPrompt, provisional, leanOf, leanLine, SCHEMA };
  if (typeof module !== "undefined" && module.exports) module.exports = Lean;
  else root.Lean = Lean;
})(typeof window !== "undefined" ? window : globalThis);
