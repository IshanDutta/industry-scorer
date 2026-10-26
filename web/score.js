/* Industry Scorer: 0-100 scores for Income, Conservative, Growth and Aggressive
 * investors. Pure functions.
 *
 * Each metric maps to 0-100 on a fixed reference range (lo -> 0, hi -> 100,
 * flipped where lower is better). Once 8+ industries have a value, the metric
 * score is the average of that anchored score and the industry's percentile
 * rank, so scores are both absolute ("is 25% gross margin good?") and relative
 * ("vs every other industry you track"). Metrics are averaged into pillars;
 * pillars are weighted per investor profile; the analyst agent's view adds a
 * capped +/-10 overlay.
 */
(function (root) {
  "use strict";
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const S = (k) => (d) => d.summary?.[k];
  const F = (k) => (d) => d.fund?.[k];
  const W = (k) => (d) => d.forward?.[k];

  // [key, label, getter, lo, hi, higherIsBetter]
  const METRICS = {
    momentum: [
      ["ex1m", "1M vs SPY", S("excess_cw_1M"), -0.08, 0.08, true, 0.1],
      ["ex3m", "3M vs SPY", S("excess_cw_3M"), -0.15, 0.15, true, 0.2],
      ["ex6m", "6M vs SPY", S("excess_cw_6M"), -0.25, 0.25, true, 0.3],
      ["ex1y", "1Y vs SPY", S("excess_cw_1Y"), -0.35, 0.35, true, 0.3],
      ["br1m", "Breadth 1M", S("breadth_1M"), 0.2, 0.8, true, 0.05],
      ["br3m", "Breadth 3M", S("breadth_3M"), 0.2, 0.8, true, 0.05],
      ["br6m", "Breadth 6M", S("breadth_6M"), 0.2, 0.8, true, 0.1],
      ["br1y", "Breadth 1Y", S("breadth_1Y"), 0.2, 0.8, true, 0.1],
      ["exm1y", "Median stock 1Y vs SPY", S("excess_median_1Y"), -0.35, 0.35, true, 0.15],
    ],
    growth: [
      ["revg", "Revenue growth", F("rev_growth"), -0.1, 0.3, true, 0.6],
      ["nig", "Earnings growth", F("ni_growth"), -0.3, 0.5, true, 0.4],
      ["ntmg", "Expected EPS growth, next 12 months (consensus)", W("ntm_eps_growth"), -0.1, 0.4, true, 0.6],
      ["fy1rg", "Expected revenue growth, next fiscal year", W("fy1_rev_growth"), -0.05, 0.3, true, 0.4],
    ],
    profitability: [
      ["gm", "Gross margin", F("gross_margin"), 0.1, 0.7, true, 1],
      ["om", "Operating margin", F("op_margin"), 0, 0.35, true, 1],
      ["nm", "Net margin", F("net_margin"), -0.05, 0.25, true, 1],
      ["roe", "ROE", F("roe"), 0, 0.3, true, 1],
    ],
    valuation: [
      ["pe", "P/E", (d) => (d.fund?.pe_negative ? Infinity : d.fund?.pe), 8, 45, false, 1],
      ["pevh", "P/E vs 5Y median", F("pe_vs_hist"), -0.3, 0.3, false, 1],
      ["ps", "P/S", F("ps"), 0.5, 10, false, 0.6],
      ["pb", "P/B", F("pb"), 0.8, 8, false, 0.6],
      ["eve", "EV/EBITDA", F("ev_ebitda"), 5, 30, false, 0.8],
      ["pepct", "P/E percentile vs own 5Y history", F("pe_hist_pct"), 0.1, 0.9, false, 0.6],
      ["fpe", "Forward P/E (consensus)", W("fwd_pe"), 8, 40, false, 1],
      ["peg", "PEG (forward P/E / expected growth)", W("peg"), 0.5, 3, false, 0.5],
      ["pin", "Growth priced in vs growth sustained", (d) => d.priced_in?.gap, -0.1, 0.1, false, 0.8],
    ],
    revisions: [
      ["rev30", "EPS estimate change, 30 days", W("rev30"), -0.05, 0.05, true, 1],
      ["rev90", "EPS estimate change, 90 days", W("rev90"), -0.1, 0.1, true, 1],
      ["rbr", "Revision breadth (up minus down)", W("breadth"), -0.5, 0.5, true, 0.8],
      ["rshr", "Share of companies with rising estimates", W("share_rising"), 0.2, 0.8, true, 0.6],
    ],
    quality: [
      ["fcfc", "FCF conversion (FCF / net income)", F("fcf_conv"), 0.5, 1.2, true, 1],
      ["sbc", "Stock-based pay % of revenue", F("sbc_rev"), 0, 0.15, false, 0.7],
      ["dil", "Share count change y/y", F("share_change"), -0.03, 0.04, false, 0.7],
      ["invy", "Inventory days vs a year ago", F("inv_days_yoy"), -0.2, 0.25, false, 0.8],
      ["dsoy", "Days sales outstanding vs a year ago", F("dso_yoy"), -0.15, 0.25, false, 0.8],
      ["ndeb", "Net debt / EBITDA", F("nd_ebitda"), -0.5, 4, false, 0.6],
    ],
    history: [
      ["an12", "Median 12M return after similar setups (since 2008)", (d) => d.history?.analogs?.horizons?.["12M"]?.median, -0.15, 0.2, true, 1],
      ["anup", "Share of similar setups up 12 months later", (d) => d.history?.analogs?.horizons?.["12M"]?.pos, 0.3, 0.85, true, 0.8],
      ["pe15", "P/E percentile in its own history (since 2010)", (d) => d.history?.valuation?.percentile, 0.1, 0.9, false, 1],
      ["peer", "P/E vs the sector's median industry", (d) => (d.peers?.median_pe > 0 && d.peers.rows?.find((r) => r.self)?.pe > 0 ? d.peers.rows.find((r) => r.self).pe / d.peers.median_pe - 1 : NaN), -0.4, 0.4, false, 0.6],
    ],
    positioning: [
      ["pos", "Positioning (crowded = low, washed out = high)", (d) => d.positioning?.score, 4, -4, true, 1],
    ],
    earnings: [
      ["beat", "Beat rate", F("beat_rate"), 0.4, 0.9, true, 1],
      ["epss", "Median EPS surprise", F("eps_surprise_median"), -0.05, 0.15, true, 1],
      ["revs", "Median revenue surprise", F("rev_surprise_median"), -0.03, 0.05, true, 0.7],
    ],
    health: [
      ["de", "Debt/equity", F("de"), 0, 2.5, false, 1],
      ["cr", "Current ratio", F("current_ratio"), 0.8, 3, true, 0.7],
      ["ic", "Interest cover", F("int_cover"), 1, 20, true, 1],
      ["fcfm", "FCF margin", F("fcf_margin"), -0.05, 0.25, true, 1],
      ["roic", "ROIC", F("roic"), 0, 0.25, true, 1],
      ["wkc", "Share of the industry with stretched credit", (d) => d.credit?.weak_weight, 0, 0.4, false, 0.6],
    ],
    risk: [
      ["beta", "Beta", S("beta"), 0.5, 1.8, false, 1],
      ["vol", "Volatility", S("vol_1y"), 0.12, 0.45, false, 1],
      ["dvol", "Downside vol", S("downside_vol_1y"), 0.08, 0.32, false, 1],
      ["mdd", "Max drawdown", S("max_dd_1y"), -0.45, -0.05, true, 1],
      ["shp", "Sharpe", S("sharpe_1y"), -1, 2, true, 1],
      ["top5", "Concentration (top five weight)", S("top5_weight"), 0.3, 0.9, false, 0.4],
    ],
    risk_reward: [
      ["shp", "Sharpe", S("sharpe_1y"), -1, 2, true, 1],
    ],
    income: [
      ["dy", "Dividend yield", F("div_yield"), 0, 0.05, true, 1],
      ["fdc", "FCF / dividends", F("fcf_div_cover"), 0.8, 3, true, 0.6],
    ],
  };
  const PILLAR_LABELS = { momentum: "Momentum vs SPY", growth: "Growth", profitability: "Profitability", valuation: "Valuation",
    earnings: "Earnings", health: "Financial health", revisions: "Estimates & revisions", quality: "Earnings quality & working capital", positioning: "Positioning (contrarian)", history: "Base rates & valuation history", risk: "Low risk", risk_reward: "Risk-adjusted return", income: "Income",
    // Pillars from the report sections (sections.js)
    cycle: "Industry cycle & KPIs", macro: "Macro backdrop", world: "World events", supply: "Supply chain & trade",
    regulation: "Regulation & legal", sentiment: "Sentiment & perception", consensus: "Sell-side consensus", outlook: "Strategist outlook" };
  const QUANT = ["momentum", "growth", "profitability", "valuation", "earnings", "health", "risk", "risk_reward", "income", "revisions", "quality", "positioning", "history"];
  const SECTION = ["cycle", "macro", "world", "supply", "regulation", "sentiment", "consensus", "outlook"];

  // Weights sum to 100 per investor type: about 2/3 computed metrics, 1/3 the report sections.
  const PROFILES = {
    income:       { label: "Income",       weights: { momentum: 3, growth: 3, profitability: 9, valuation: 9, earnings: 3, health: 12, risk: 7, income: 16, revisions: 3, quality: 3, positioning: 2, history: 2,
                                                      cycle: 4, macro: 6, world: 3, supply: 4, regulation: 5, sentiment: 1, consensus: 2, outlook: 3 } },
    conservative: { label: "Conservative", weights: { momentum: 3, growth: 3, profitability: 8, valuation: 10, earnings: 4, health: 12, risk: 12, income: 3, revisions: 3, quality: 4, positioning: 2, history: 3,
                                                      cycle: 5, macro: 6, world: 5, supply: 6, regulation: 5, sentiment: 1, consensus: 2, outlook: 3 } },
    growth:       { label: "Growth",       weights: { momentum: 9, growth: 16, profitability: 7, valuation: 4, earnings: 7, health: 3, risk: 2, revisions: 7, quality: 3, positioning: 2, history: 2,
                                                      cycle: 12, macro: 5, world: 3, supply: 4, regulation: 3, sentiment: 2, consensus: 4, outlook: 5 } },
    aggressive:   { label: "Aggressive",   weights: { momentum: 14, growth: 12, profitability: 3, valuation: 3, earnings: 8, health: 2, risk_reward: 6, revisions: 8, quality: 2, positioning: 4, history: 2,
                                                      cycle: 8, macro: 5, world: 3, supply: 3, regulation: 2, sentiment: 5, consensus: 4, outlook: 6 } },
  };
  // The lead strategist's own judgment, on top of every pillar: small, because everything it read is already scored.
  const OVERLAY_CAP = 5;
  const OVERLAY_MAX_AGE_DAYS = 21;
  const PERCENTILE_MIN = 8;

  function anchored(v, lo, hi, up) {
    if (v === Infinity) return up ? 100 : 0;
    if (v === -Infinity) return up ? 0 : 100;
    const t = Math.min(Math.max((v - lo) / (hi - lo), 0), 1);
    return 100 * (up ? t : 1 - t);
  }
  function percentile(v, all, up) {
    const less = all.filter((x) => x < v).length, eq = all.filter((x) => x === v).length;
    const p = (less + (eq - 1) / 2) / Math.max(all.length - 1, 1);
    return 100 * (up ? p : 1 - p);
  }
  function grade(s) { return !isNum(s) ? "—" : s >= 80 ? "A" : s >= 65 ? "B" : s >= 50 ? "C" : s >= 35 ? "D" : "F"; }

  /**
   * @param docs   industry docs [{name, summary, fund}]
   * @param agents {name: {overlay:{income,...}, as_of}} optional
   * @param today  "YYYY-MM-DD"
   * @returns {name: {profiles: {income: {total, grade, base, overlay, pillars:{p: score}}}, metrics: {key: score}}}
   */
  function scoreIndustries(docs, agents = {}, today = null, { relative = true, sections = {} } = {}) {
    const all = {};
    for (const pillar of Object.values(METRICS)) for (const [k, , get, , , up] of pillar) {
      if (all[k]) continue;
      all[k] = { up, vals: docs.map((d) => get(d)).filter((v) => isNum(v) || v === Infinity) };
    }
    const out = {};
    for (const d of docs) {
      const metricScores = {}, pillarScores = {};
      for (const [p, list] of Object.entries(METRICS)) {
        let ws = 0, acc = 0;
        for (const [k, , get, lo, hi, up, w] of list) {
          const v = get(d);
          if (!(isNum(v) || v === Infinity)) continue;
          let s = anchored(v, lo, hi, up);
          const pool = all[k].vals;
          if (relative && pool.length >= PERCENTILE_MIN) s = 0.5 * s + 0.5 * percentile(v, pool, up);
          metricScores[k] = s; acc += w * s; ws += w;
        }
        pillarScores[p] = ws ? acc / ws : NaN;
      }
      // Section pillars (computed by sections.js from the reports)
      const sec = sections[d.name] || {};
      for (const p of SECTION) pillarScores[p] = isNum(sec[p]?.score) ? sec[p].score : NaN;
      const ag = agents[d.name];
      const fresh = ag && ag.overlay && (!today || !ag.as_of || (Date.parse(today) - Date.parse(ag.as_of)) / 864e5 <= OVERLAY_MAX_AGE_DAYS);
      const profiles = {};
      for (const [pk, prof] of Object.entries(PROFILES)) {
        let ws = 0, acc = 0;
        for (const [p, w] of Object.entries(prof.weights)) if (isNum(pillarScores[p])) { acc += w * pillarScores[p]; ws += w; }
        const base = ws ? acc / ws : NaN;
        const ov = fresh && isNum(Number(ag.overlay[pk])) ? Math.max(-OVERLAY_CAP, Math.min(OVERLAY_CAP, Number(ag.overlay[pk]))) : 0;
        const total = isNum(base) ? Math.max(0, Math.min(100, base + ov)) : NaN;
        let qa = 0, qw = 0; for (const [p, w] of Object.entries(prof.weights)) if (QUANT.includes(p) && isNum(pillarScores[p])) { qa += w * pillarScores[p]; qw += w; }
        profiles[pk] = { total, grade: grade(total), base, quant: qw ? qa / qw : NaN, overlay: ov, coverage: ws / 100,
          pillars: Object.fromEntries(Object.keys(prof.weights).map((p) => [p, pillarScores[p]])) };
      }
      out[d.name] = { profiles, metrics: metricScores, pillars: pillarScores };
    }
    return out;
  }

  const Score = { METRICS, PILLAR_LABELS, QUANT, SECTION, PROFILES, OVERLAY_CAP, PERCENTILE_MIN, anchored, percentile, grade, scoreIndustries };
  if (typeof module !== "undefined" && module.exports) module.exports = Score;
  else root.Score = Score;
})(typeof window !== "undefined" ? window : globalThis);
