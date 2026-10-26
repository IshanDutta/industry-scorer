/* Industry Scorer: score pillars from every report section.
 *
 * The quant pillars (score.js) cover the computed metrics. These pillars turn
 * the specialist reports into 0-100 scores by code, from their structured
 * fields only (labels, ratings, probabilities, counts), never from free text,
 * so every point is traceable. 50 is neutral. Each pillar returns the data
 * points it used, with the points each one contributed.
 *
 *   cycle       industry KPIs: cycle position, pricing power, demand drivers,
 *               supply drivers, management tone, hot vs cool segments
 *   macro       the regime call overall and by horizon, and every indicator
 *               read (tailwind/headwind weighted by relevance)
 *   world       every live situation: stance x relevance x status
 *   supply      trade relations: system health (code), rating, cost
 *               pass-through, de-rating risk, country stances
 *   regulation  regulatory verdict (stance x intensity), rule-book severity,
 *               policy items, litigation
 *   sentiment   measured news sentiment and its trend, investor perception
 *   consensus   sell-side buy share and upside to price targets (cap-weighted)
 *   outlook     the lead strategist's scenarios (bull vs bear probability) and
 *               landscape scorecard (evidence-checked)
 */
(function (root) {
  "use strict";
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const clamp = (x) => Math.max(0, Math.min(100, x));
  const lc = (x) => String(x ?? "").toLowerCase();
  const LABELS = { cycle: "Industry cycle & KPIs", macro: "Macro backdrop", world: "World events", supply: "Supply chain & trade", regulation: "Regulation & legal", sentiment: "Sentiment & perception", consensus: "Sell-side consensus", outlook: "Strategist outlook" };

  /** Average of components {label, score (0-100), weight, value}; returns {score, items}. */
  function combine(items) {
    const ok = items.filter((x) => isNum(x.score) && (x.weight ?? 1) > 0);
    if (!ok.length) return null;
    const ws = ok.reduce((a, x) => a + (x.weight ?? 1), 0);
    const score = ok.reduce((a, x) => a + (x.weight ?? 1) * x.score, 0) / ws;
    return { score: Math.round(score * 10) / 10, items: ok.map((x) => ({ label: x.label, value: x.value, score: Math.round(x.score), share: Math.round(((x.weight ?? 1) / ws) * 100) })) };
  }
  // Direction words used by the agents' structured fields
  const dirOf = (t) => { const s = lc(t);
    if (/accelerat|rising|strengthen|improv|expand|up\b|tight|positive|surg|strong|tailwind|support|loosen|eas/.test(s)) return 1;
    if (/decelerat|slow|fall|weak|declin|contract|down\b|negative|loose|glut|headwind|adverse|deteriorat|cut/.test(s)) return -1;
    return 0; };

  function cycle(k, chain, calls) {
    if (!k && !chain && !calls) return null;
    k = k || {};
    const pos = lc(k.cycle_position);
    const posScore = /trough|bottom/.test(pos) ? 45 : /recover|early/.test(pos) ? 70 : /expan|growth|up/.test(pos) ? 75 : /late|peak/.test(pos) ? 45 : /contract|down|declin|recess/.test(pos) ? 25 : null;
    const pp = { strong: 80, moderate: 55, weak: 25 }[lc(k.pricing_power?.level)];
    const net = (arr, f) => { const v = (arr || []).map(f); return v.length ? { n: v.length, s: v.reduce((a, x) => a + x, 0) / v.length } : null; };
    const dd = net(k.demand_drivers, (d) => dirOf(d.direction));
    // Supply: tight supply is good for pricing (+), loosening/glut is bad
    const sd = net(k.supply_drivers, (d) => dirOf(d.direction));
    const mg = net(k.management_signals, (m) => ({ positive: 1, negative: -1 }[m.tone] || 0));
    const hot = (k.hot_segments || []).length, cool = (k.cool_segments || []).length;
    const ol = lc(k.unit_economics?.operating_leverage);
    return combine([
      { label: "Cycle position", value: k.cycle_position || "n/a", score: posScore, weight: 3 },
      { label: "Pricing power", value: k.pricing_power?.level || "n/a", score: pp, weight: 2 },
      dd && { label: "Demand drivers", value: `${(k.demand_drivers || []).length} drivers, net ${dd.s >= 0 ? "+" : ""}${dd.s.toFixed(2)}`, score: 50 + 40 * dd.s, weight: 2 },
      sd && { label: "Supply drivers", value: `${(k.supply_drivers || []).length} drivers, net ${sd.s >= 0 ? "+" : ""}${sd.s.toFixed(2)}`, score: 50 + 25 * sd.s, weight: 1 },
      mg && { label: "Management tone", value: `${mg.n} signals, net ${mg.s >= 0 ? "+" : ""}${mg.s.toFixed(2)}`, score: 50 + 45 * mg.s, weight: 2 },
      (hot || cool) && { label: "Hot vs cool segments", value: `${hot} hot, ${cool} cool`, score: 50 + 40 * ((hot - cool) / Math.max(hot + cool, 1)), weight: 1 },
      ol && posScore !== null && { label: "Operating leverage (amplifies the cycle)", value: ol, score: ol === "high" ? 50 + 1.3 * (posScore - 50) : ol === "low" ? 50 + 0.7 * (posScore - 50) : posScore, weight: 1 },
      // Customers' own filings (value chain) and what changed between earnings calls
      isNum(chain?.aggregate?.customer_capex_growth) && { label: "Customers' capital spending, 12 months y/y", value: `${(chain.aggregate.customer_capex_growth * 100).toFixed(1)}%`, score: clamp(50 + 150 * chain.aggregate.customer_capex_growth), weight: 2 },
      chain?.aggregate && (chain.aggregate.accelerating.length + chain.aggregate.decelerating.length) > 0 && { label: "Customers' capex accelerating vs decelerating", value: `${chain.aggregate.accelerating.length} vs ${chain.aggregate.decelerating.length}`, score: 50 + 40 * (chain.aggregate.accelerating.length - chain.aggregate.decelerating.length) / (chain.aggregate.accelerating.length + chain.aggregate.decelerating.length), weight: 1 },
      calls?.n > 0 && { label: "Earnings calls vs the previous call (tone + guidance)", value: `net ${calls.score >= 0 ? "+" : ""}${calls.score} across ${calls.n} companies`, score: clamp(50 + 22 * calls.score / calls.n), weight: 2 },
    ].filter(Boolean));
  }

  const REG = { SUPPORTIVE: 82, MIXED: 50, RESTRICTIVE: 28, HOSTILE: 12 };
  function macro(m) {
    if (!m) return null;
    const items = [];
    if (m.regime) items.push({ label: "Regime call", value: `${m.regime} (${m.confidence || "n/a"} confidence)`, score: REG[m.regime], weight: 3 });
    const hw = { "1M": 0.2, "3M": 0.3, "6M": 0.25, "12M": 0.25 };
    const hs = Object.entries(m.horizons || {}).filter(([h, x]) => REG[x?.call] !== undefined && hw[h]);
    if (hs.length) { const w = hs.reduce((a, [h]) => a + hw[h], 0); items.push({ label: "Regime by horizon", value: hs.map(([h, x]) => `${h} ${x.call}`).join(", "), score: hs.reduce((a, [h, x]) => a + hw[h] * REG[x.call], 0) / w, weight: 2 }); }
    const reads = Object.values(m.indicators || {});
    const RW = { high: 3, medium: 2, low: 1 }, EF = { tailwind: 1, headwind: -1, neutral: 0 };
    const rr = reads.filter((x) => RW[x.relevance] && EF[x.effect] !== undefined);
    if (rr.length) {
      const w = rr.reduce((a, x) => a + RW[x.relevance], 0), net = rr.reduce((a, x) => a + RW[x.relevance] * EF[x.effect], 0) / w;
      const tw = rr.filter((x) => x.effect === "tailwind").length, hw2 = rr.filter((x) => x.effect === "headwind").length;
      items.push({ label: "Indicator reads (relevance-weighted)", value: `${rr.length} indicators: ${tw} tailwinds, ${hw2} headwinds`, score: 50 + 45 * net, weight: 3 });
    }
    return combine(items);
  }

  function world(w) {
    const dives = w?.dives || []; if (!dives.length) return null;
    const rel = Object.fromEntries((w.scout?.situations || []).map((s) => [s.title, s.relevance]));
    const ST = { adverse: -1, supportive: 1, mixed: 0 };
    const SM = { escalating: 1.4, "active conflict": 1.4, "ongoing tension": 1, negotiating: 0.8, "de-escalating": 0.6, resolved: 0.3 };
    let acc = 0, ws = 0; const parts = [];
    for (const d of dives) {
      const s = ST[d.stance]; if (s === undefined) continue;
      const w0 = (rel[d.title] === "high" ? 2 : 1) * (SM[d.status] ?? 1);
      acc += w0 * s; ws += w0; parts.push(`${d.title}: ${d.stance}${d.status ? ", " + d.status : ""}`);
    }
    if (!ws) return null;
    const net = acc / ws;
    // Scenario-weighted earnings direction where the dives give probabilities
    const sc = dives.flatMap((d) => (d.scenarios || []).map((x) => ({ p: Number(x.probability) || 0, dir: dirOf(x.earnings) || (/-\s?\d/.test(String(x.earnings)) ? -1 : /\+\s?\d/.test(String(x.earnings)) ? 1 : 0) })));
    const sp = sc.reduce((a, x) => a + x.p, 0);
    return combine([
      { label: "Live situations (stance x relevance x status)", value: `${dives.length} situations, net ${net >= 0 ? "+" : ""}${net.toFixed(2)}`, score: 50 + 45 * net, weight: 3, detail: parts },
      sp > 0 && { label: "Situation scenarios (earnings direction, probability-weighted)", value: `${sc.length} scenarios`, score: 50 + 40 * (sc.reduce((a, x) => a + x.p * x.dir, 0) / sp), weight: 1 },
    ].filter(Boolean));
  }

  function supply(t) {
    if (!t) return null;
    const v = t.verdict || {};
    const RT = { healthy: 85, manageable: 65, strained: 38, critical: 15 };
    const PT = { strong: 80, partial: 55, weak: 25 }, DR = { low: 80, medium: 50, high: 20 };
    const cs = t.map?.countries || [];
    const STC = { allied: 1, competitive: 0, adversarial: -1, sanctioned: -1 }, TRC = { improving: 1, volatile: -0.3, deteriorating: -1, escalating: -1 };
    const IMP = { existential: 3, high: 2, medium: 1, low: 0.5 };
    const cw = cs.reduce((a, c) => a + (IMP[c.importance] || 1), 0);
    const cnet = cw ? cs.reduce((a, c) => a + (IMP[c.importance] || 1) * (0.6 * (STC[c.stance] ?? 0) + 0.4 * (TRC[c.trajectory] ?? 0)), 0) / cw : null;
    return combine([
      isNum(v.health?.score) && { label: "System health (code: importance x stance x trajectory)", value: `${v.health.score}/100`, score: v.health.score, weight: 3 },
      RT[v.rating] !== undefined && { label: "Supply-chain rating", value: v.rating, score: RT[v.rating], weight: 2 },
      PT[v.investment_read?.pass_through] !== undefined && { label: "Can cost increases be passed through", value: v.investment_read.pass_through, score: PT[v.investment_read.pass_through], weight: 1 },
      DR[v.investment_read?.derate_risk] !== undefined && { label: "Valuation de-rating risk", value: v.investment_read.derate_risk, score: DR[v.investment_read.derate_risk], weight: 1 },
      cnet !== null && { label: "Country stances (importance-weighted)", value: `${cs.length} countries, net ${cnet >= 0 ? "+" : ""}${cnet.toFixed(2)}`, score: 50 + 40 * cnet, weight: 1 },
      cs.some((c) => c.threat) && (() => { const TH = { none: 0, low: 0.2, elevated: 0.5, high: 0.8, critical: 1 }; const thr = cs.filter((c) => (TH[c.threat] || 0) >= 0.5);
        const w = cs.reduce((a, c) => a + (IMP[c.importance] || 1) * (TH[c.threat] || 0), 0) / (cw || 1);
        return { label: "Invasion and war threats (importance-weighted)", value: thr.length ? thr.map((c) => `${c.country} ${c.threat}`).join(", ") : "none elevated", score: 85 - 75 * w, weight: 2 }; })(),
      (v.bottlenecks || []).length && { label: "Bottlenecks", value: `${v.bottlenecks.length} (${v.bottlenecks.filter((b) => b.severity === "critical").length} critical)`, score: Math.max(10, 70 - 12 * v.bottlenecks.filter((b) => b.severity === "critical").length - 6 * v.bottlenecks.filter((b) => b.severity !== "critical").length), weight: 1 },
    ].filter(Boolean));
  }

  function regulation(g, verdict, books) {
    const items = [];
    if (verdict?.stance) {
      const base = { tailwind: 78, neutral: 55, mixed: 45, headwind: 25 }[verdict.stance] ?? 50;
      const amp = { high: 1.3, medium: 1, low: 0.6 }[verdict.intensity] ?? 1;
      items.push({ label: "Regulatory verdict", value: `${verdict.stance}, ${verdict.intensity || "n/a"} intensity`, score: 50 + amp * (base - 50), weight: 4 });
    }
    const rules = (books || []).flatMap((b) => b?.rules || []).filter((r) => r.status === "in_force" || r.status === "pending" || r.status === "proposed");
    if (rules.length) {
      const sev = rules.reduce((a, r) => a + ({ high: 3, medium: 2, low: 1 }[r.severity] || 1), 0);
      items.push({ label: "Binding rules in force or coming (rule books)", value: `${rules.length} rules, ${rules.filter((r) => r.severity === "high").length} high-severity`, score: Math.max(15, 75 - 2.2 * sev), weight: 2 });
    }
    const pol = g?.policy || [];
    if (pol.length) { const net = pol.reduce((a, p) => a + ({ tailwind: 1, headwind: -1 }[p.direction] || 0), 0) / pol.length; items.push({ label: "Policy items", value: `${pol.length} items, net ${net >= 0 ? "+" : ""}${net.toFixed(2)}`, score: 50 + 40 * net, weight: 2 }); }
    if (g) { const n = (g.litigation || []).length; items.push({ label: "Litigation docket", value: `${n} active matter${n === 1 ? "" : "s"}`, score: Math.max(20, 65 - 7 * n), weight: 1 }); }
    return combine(items);
  }

  function sentiment(pack, g) {
    const s = pack?.sentiment; const items = [];
    if (s && isNum(s.last_7d ?? s.prior_30d)) {
      const lvl = isNum(s.prior_30d) ? s.prior_30d : s.last_7d;
      items.push({ label: "News sentiment, 30 days (EODHD)", value: lvl.toFixed(2), score: clamp(50 + 120 * lvl), weight: 2 });
      if (isNum(s.last_7d) && isNum(s.prior_30d)) items.push({ label: "Sentiment trend (7d vs prior 30d)", value: `${(s.last_7d - s.prior_30d >= 0 ? "+" : "")}${(s.last_7d - s.prior_30d).toFixed(2)}`, score: clamp(50 + 200 * (s.last_7d - s.prior_30d)), weight: 1 });
    }
    const tr = g?.perception?.trend;
    if (tr) items.push({ label: "Investor and public perception", value: tr, score: { improving: 72, stable: 50, deteriorating: 28 }[tr] ?? 50, weight: 1 });
    return combine(items);
  }

  function consensus(pack, doc) {
    const a = (pack?.analyst || []).filter((x) => (x.buy + x.hold + (x.sell || 0)) > 0 || isNum(x.upside));
    if (!a.length) return null;
    const wOf = Object.fromEntries((doc?.constituents || []).map((c) => [c.symbol, c.weight || 0]));
    const wsum = (f) => { let ws = 0, acc = 0; for (const x of a) { const v = f(x); if (!isNum(v)) continue; const w = wOf[x.symbol] || 0.001; acc += w * v; ws += w; } return ws ? acc / ws : NaN; };
    const buy = wsum((x) => { const n = x.buy + x.hold + (x.sell || 0); return n ? x.buy / n : NaN; });
    const up = wsum((x) => x.upside);
    return combine([
      isNum(buy) && { label: "Buy ratings share (cap-weighted)", value: `${(buy * 100).toFixed(0)}%`, score: clamp(((buy - 0.3) / 0.6) * 100), weight: 1 },
      isNum(up) && { label: "Upside to consensus price target (cap-weighted)", value: `${up >= 0 ? "+" : ""}${(up * 100).toFixed(1)}%`, score: clamp(((up + 0.1) / 0.4) * 100), weight: 1.5 },
    ].filter(Boolean));
  }

  function outlook(lead) {
    if (!lead) return null;
    const sc = lead.scenarios || {}; const items = [];
    const m = lead.math;
    if (m && isNum(m.expected_return)) items.push({ label: "Probability-weighted 12M return (scenario math)", value: `${m.expected_return >= 0 ? "+" : ""}${m.expected_return}%, reward:risk ${m.reward_risk ?? "n/a"}`, score: clamp(50 + 2.5 * m.expected_return), weight: 2.5 });
    if (sc.bull || sc.bear) { const skew = (sc.bull?.probability || 0) - (sc.bear?.probability || 0); items.push({ label: "Scenario skew (bull minus bear probability)", value: `${sc.bull?.probability ?? 0}% bull / ${sc.base?.probability ?? 0}% base / ${sc.bear?.probability ?? 0}% bear`, score: clamp(50 + 1.2 * skew), weight: 2 }); }
    const dims = Object.entries(lead.dimensions || {}).filter(([, d]) => isNum(d?.score));
    if (dims.length) { const avg = dims.reduce((a, [, d]) => a + d.score, 0) / dims.length; items.push({ label: "Landscape scorecard (evidence-checked)", value: dims.map(([k, d]) => `${k} ${d.score >= 0 ? "+" : ""}${d.score}`).join(", "), score: 50 + 22 * avg, weight: 1 }); }
    const dr = (lead.drivers || []).map((d) => ({ w: { high: 3, medium: 2, low: 1 }[d.magnitude] || 1, s: { tailwind: 1, headwind: -1, mixed: 0 }[d.direction] ?? 0 }));
    if (dr.length) { const w = dr.reduce((a, x) => a + x.w, 0), net = dr.reduce((a, x) => a + x.w * x.s, 0) / w; items.push({ label: "Ranked drivers (magnitude-weighted)", value: `${dr.length} drivers, net ${net >= 0 ? "+" : ""}${net.toFixed(2)}`, score: 50 + 40 * net, weight: 1.5 }); }
    return combine(items);
  }

  /** All section pillars for one industry. Missing sections are simply absent (their weight is redistributed). */
  function pillars(ctx) {
    const out = {
      cycle: cycle(ctx.kpi, ctx.chain, ctx.calls), macro: macro(ctx.macro), world: world(ctx.world), supply: supply(ctx.trade),
      regulation: regulation(ctx.reg, ctx.regVerdict, ctx.books), sentiment: sentiment(ctx.pack, ctx.reg), consensus: consensus(ctx.pack, ctx.doc), outlook: outlook(ctx.lead),
    };
    for (const k of Object.keys(out)) if (!out[k]) delete out[k];
    return out;
  }

  const Sections = { LABELS, pillars, combine, cycle, macro, world, supply, regulation, sentiment, consensus, outlook };
  if (typeof module !== "undefined" && module.exports) module.exports = Sections;
  else root.Sections = Sections;
})(typeof window !== "undefined" ? window : globalThis);
