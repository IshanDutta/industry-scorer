/* Industry Scorer: plain-English takeaways written by code from the metrics.
 * Deterministic, so the report always has written analysis even when the
 * analyst agent hasn't run. Each takeaway: {tone: "pos"|"neg"|"neu", text}.
 */
(function (root) {
  "use strict";
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const v = (x) => (x === null || x === undefined ? NaN : Number(x));
  const p = (x, d = 0) => `${(Math.abs(x) * 100).toFixed(d)}%`;
  const sp = (x, d = 1) => `${x >= 0 ? "+" : "−"}${(Math.abs(x) * 100).toFixed(d)}%`;
  function addDays(d, k) { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + k); return t.toISOString().slice(0, 10); }

  function takeaways(doc, pack, today) {
    const s = doc?.summary || {}, f = doc?.fund || {};
    const out = [];
    const add = (tone, text) => out.push({ tone, text });

    // Performance and momentum
    const e1y = v(s.excess_cw_1Y), e3m = v(s.excess_cw_3M), e1m = v(s.excess_cw_1M), m1y = v(s.excess_median_1Y), br = v(s.breadth_1Y);
    if (isNum(e1y)) add(e1y >= 0 ? "pos" : "neg", `${e1y >= 0 ? "Beat" : "Trailed"} SPY by ${p(e1y, 1)} over the past year (cap-weighted)${isNum(br) ? `; ${p(br)} of the companies beat SPY` : ""}.`);
    if (isNum(e1y) && isNum(m1y) && Math.abs(e1y - m1y) > 0.15)
      add("neu", `The largest companies drive the result: the median company ${m1y >= 0 ? "beat" : "trailed"} SPY by ${p(m1y, 1)} over the year, versus ${sp(e1y)} for the cap-weighted industry.`);
    if (isNum(e3m) && isNum(e1y) && Math.sign(e3m) !== Math.sign(e1y) && Math.abs(e3m) > 0.03)
      add(e3m >= 0 ? "pos" : "neg", `Momentum has turned: ${sp(e3m)} vs SPY over 3 months after ${sp(e1y)} over the year${isNum(e1m) ? ` (${sp(e1m)} over the last month)` : ""}.`);
    const t1 = v(s.top1_weight);
    if (isNum(t1) && t1 > 0.3) add("neu", `Concentrated: ${s.largest_company} is ${p(t1)} of the industry's market value, so it dominates cap-weighted figures.`);

    // Risk
    const beta = v(s.beta), dd = v(s.max_dd_1y), shp = v(s.sharpe_1y);
    if (isNum(beta)) add(beta > 1.3 ? "neg" : beta < 0.8 ? "pos" : "neu", `${beta > 1.3 ? "High-risk" : beta < 0.8 ? "Defensive" : "Market-like"} profile: beta ${beta.toFixed(2)}, worst drawdown ${p(dd)} in the past year${isNum(shp) ? `, Sharpe ${shp.toFixed(2)}` : ""}.`);

    // Fundamentals
    const rg = v(f.rev_growth), om = v(f.op_margin), roe = v(f.roe);
    if (isNum(rg)) add(rg > 0.1 ? "pos" : rg < 0 ? "neg" : "neu", `Revenue ${rg >= 0 ? "grew" : "fell"} ${p(rg)} over the last twelve months${isNum(v(f.ni_growth)) ? `, net income ${f.ni_growth >= 0 ? "rose" : "fell"} ${p(f.ni_growth)}` : ""}.`);
    if (isNum(om)) add(om > 0.2 ? "pos" : om < 0.05 ? "neg" : "neu", `${om > 0.2 ? "Highly profitable" : om < 0.05 ? "Thin margins" : "Moderate margins"}: ${p(om, 1)} operating margin${isNum(roe) ? `, ${p(roe)} return on equity` : ""}.`);

    // Valuation
    if (f.pe_negative) add("neg", "The 50 companies lost money in aggregate over the last twelve months, so there is no meaningful P/E.");
    else if (isNum(v(f.pe))) {
      const vs = v(f.pe_vs_hist);
      add(isNum(vs) ? (vs > 0.15 ? "neg" : vs < -0.15 ? "pos" : "neu") : "neu",
        `Trades at ${f.pe.toFixed(1)}× earnings${isNum(vs) ? `, ${p(vs)} ${vs >= 0 ? "above" : "below"} its ${Math.round(v(f.pe_hist_years)) || 5}-year median of ${f.pe_hist_median.toFixed(1)}×` : ""}.`);
    }
    const dy = v(f.div_yield);
    if (isNum(dy) && dy >= 0.025) add("pos", `Pays a ${p(dy, 1)} dividend yield${isNum(v(f.fcf_div_cover)) ? `, covered ${f.fcf_div_cover.toFixed(1)}× by free cash flow` : ""}.`);

    // Earnings
    const beat = v(f.beat_rate);
    if (isNum(beat)) add(beat >= 0.75 ? "pos" : beat < 0.5 ? "neg" : "neu", `Beat EPS estimates in ${p(beat)} of the last ${f.beat_reports} quarterly reports${isNum(v(f.eps_surprise_median)) ? `, by a median ${sp(f.eps_surprise_median)}` : ""}.`);
    const soon = (f.next_reports || []).filter((r) => today && r.date <= addDays(today, 14));
    if (soon.length) add("neu", `${soon.length} of the companies report in the next two weeks, starting with ${soon[0].symbol} on ${soon[0].date}.`);

    // Health
    const de = v(f.de), ic = v(f.int_cover);
    if (!f.financial && isNum(de)) add(de > 1.5 ? "neg" : de < 0.5 ? "pos" : "neu", `${de > 1.5 ? "Heavily indebted" : de < 0.5 ? "Low leverage" : "Moderate leverage"}: debt is ${de.toFixed(2)}× equity${isNum(ic) ? `, operating income covers interest ${ic.toFixed(1)}×` : ""}.`);

    // Sentiment (EODHD)
    const sen = pack?.sentiment;
    if (sen && isNum(v(sen.last_7d)) && isNum(v(sen.prior_30d))) {
      const d = sen.last_7d - sen.prior_30d;
      add(Math.abs(d) < 0.05 ? "neu" : d > 0 ? "pos" : "neg", `News sentiment (EODHD) is ${sen.last_7d.toFixed(2)} this week versus ${sen.prior_30d.toFixed(2)} the prior month${Math.abs(d) >= 0.05 ? (d > 0 ? ", improving" : ", deteriorating") : ", steady"}.`);
    }
    // Landscape counts
    if (pack?.items) {
      const legal = (pack.legal_ids || []).length, reg = (pack.regulatory_ids || []).length, deals = pack.counts?.M || 0;
      if (deals) add("neu", `${deals} recent SEC M&A filing${deals === 1 ? "" : "s"} involve these companies.`);
      if (legal || reg) add("neu", `Recent coverage includes ${legal} legal and ${reg} regulatory headline${reg === 1 ? "" : "s"} about these companies (see below).`);
    }
    return out;
  }

  const Insights = { takeaways };
  if (typeof module !== "undefined" && module.exports) module.exports = Insights;
  else root.Insights = Insights;
})(typeof window !== "undefined" ? window : globalThis);
