/* Industry Scorer: Forward view.
 *
 * What analysts expect, how that is changing, and what today's price already assumes.
 *   - Consensus estimates per company (EODHD earnings trends, which also carry the revision history;
 *     FMP financial estimates when EODHD isn't available): next-twelve-month (NTM) EPS blended from
 *     this fiscal year and next, forward P/E, expected growth, analyst count and dispersion.
 *   - Revisions: how NTM EPS estimates moved over 30 and 90 days, and the count of analysts revising up
 *     vs down (breadth). Revisions are among the most reliable drivers of industry returns.
 *   - What's priced in: a reverse DCF. Given the cost of equity (10-year yield + beta x equity risk
 *     premium) and a 3% terminal growth, the 10-year cash-flow growth today's market cap implies,
 *     next to what analysts expect and what the industry actually delivered over five years.
 * Pure functions, no I/O. Aggregates are sum/sum so one company can't dominate through a ratio.
 */
(function (root) {
  "use strict";
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const n = (x) => (x === null || x === undefined || x === "" ? NaN : Number(x));
  const median = (a) => { const s = a.filter(isNum).sort((x, y) => x - y); if (!s.length) return NaN; const k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
  const days = (a, b) => (Date.parse(a) - Date.parse(b)) / 864e5;

  // ---------------------------------------------------------------- parsing
  /** EODHD earnings-trend rows for one symbol -> {fy0, fy1, source} (this fiscal year and next). */
  function fromEodTrends(rows, today) {
    const yr = (rows || []).filter((r) => r && /^(0y|\+1y)$/.test(String(r.period)) && r.date);
    const pick = (p, after) => yr.filter((r) => r.period === p && String(r.date) >= after).sort((a, b) => (a.date < b.date ? -1 : 1))[0];
    const r0 = pick("0y", new Date(Date.parse(today) - 120 * 864e5).toISOString().slice(0, 10));
    if (!r0) return null;
    const r1 = pick("+1y", String(r0.date).slice(0, 10) + "~") || yr.filter((r) => String(r.date) > String(r0.date)).sort((a, b) => (a.date < b.date ? -1 : 1))[0];
    const one = (r) => r ? { date: String(r.date).slice(0, 10), eps: n(r.earningsEstimateAvg ?? r.epsTrendCurrent), eps7: n(r.epsTrend7daysAgo), eps30: n(r.epsTrend30daysAgo), eps60: n(r.epsTrend60daysAgo), eps90: n(r.epsTrend90daysAgo),
      low: n(r.earningsEstimateLow), high: n(r.earningsEstimateHigh), analysts: n(r.earningsEstimateNumberOfAnalysts), growth: n(r.earningsEstimateGrowth),
      rev: n(r.revenueEstimateAvg), rev_growth: n(r.revenueEstimateGrowth), up30: n(r.epsRevisionsUpLast30days) || 0, down30: n(r.epsRevisionsDownLast30days) || 0 } : null;
    return { fy0: one(r0), fy1: one(r1), source: "EODHD" };
  }
  /** FMP annual financial estimates -> {fy0, fy1, source}; no revision history. */
  function fromFmpEstimates(rows, today) {
    const yr = (rows || []).filter((r) => r && r.date && isNum(n(r.epsAvg))).sort((a, b) => (a.date < b.date ? -1 : 1));
    const cut = new Date(Date.parse(today) - 60 * 864e5).toISOString().slice(0, 10);
    const i = yr.findIndex((r) => String(r.date) >= cut);
    if (i < 0) return null;
    const one = (r, prev) => r ? { date: String(r.date).slice(0, 10), eps: n(r.epsAvg), low: n(r.epsLow), high: n(r.epsHigh), analysts: n(r.numAnalystsEps), rev: n(r.revenueAvg),
      growth: prev && n(prev.epsAvg) > 0 ? n(r.epsAvg) / n(prev.epsAvg) - 1 : NaN, rev_growth: prev && n(prev.revenueAvg) > 0 ? n(r.revenueAvg) / n(prev.revenueAvg) - 1 : NaN,
      eps30: NaN, eps90: NaN, up30: 0, down30: 0 } : null;
    return { fy0: one(yr[i], yr[i - 1]), fy1: one(yr[i + 1], yr[i]), source: "FMP" };
  }

  // ---------------------------------------------------------------- one company
  /**
   * est: {fy0, fy1}; ctx: {price, market_cap, ni_ttm (USD), today}.
   * NTM EPS = share of this fiscal year still ahead x FY0 + the rest x FY1. Checked against trailing EPS so an
   * estimate in another currency or per-share basis (ADRs) doesn't slip in: ratio to TTM EPS must be 0.25-4x.
   */
  function companyForward(est, { price, market_cap, ni_ttm, today }) {
    if (!est?.fy0 || !isNum(est.fy0.eps) || !(price > 0)) return null;
    const f0 = est.fy0, f1 = est.fy1;
    const w0 = Math.max(0, Math.min(1, days(f0.date, today) / 365));
    const blend = (a, b) => (isNum(a) && (w0 >= 0.999 || isNum(b)) ? w0 * a + (1 - w0) * (isNum(b) ? b : a) : NaN);
    const ntm = f1 && isNum(f1.eps) ? blend(f0.eps, f1.eps) : f0.eps;
    const ntm30 = blend(f0.eps30, f1?.eps30), ntm90 = blend(f0.eps90, f1?.eps90);
    const shares = market_cap > 0 ? market_cap / price : NaN;
    const ttmEps = isNum(ni_ttm) && shares > 0 ? ni_ttm / shares : NaN;
    // Analysts' EPS is usually adjusted (non-GAAP), so growth is measured against the same basis: last-twelve-month
    // EPS blended from last fiscal year's actual (FY0 / (1 + FY0 growth)) and FY0.
    const fyPrev = isNum(f0.growth) && f0.growth > -1 ? f0.eps / (1 + f0.growth) : NaN;
    const ltm = isNum(fyPrev) ? w0 * fyPrev + (1 - w0) * f0.eps : NaN;
    let ok = ntm > 0, why = ntm > 0 ? "" : "estimates show a loss";
    // A currency or share-basis mismatch (an ADR quoted per local share) shows up as a wild ratio to trailing GAAP EPS.
    if (ok && ttmEps > 0) { const r = ntm / ttmEps; if (r < 0.2 || r > 8) { ok = false; why = `estimate is ${r.toFixed(1)}x trailing EPS (likely another currency or share basis)`; } }
    const pe = ok ? price / ntm : NaN;
    if (ok && (pe < 1 || pe > 400)) { ok = false; why = "forward P/E out of range"; }
    const up = (f0.up30 || 0) + (f1?.up30 || 0), down = (f0.down30 || 0) + (f1?.down30 || 0);
    const spread = (x) => (x && x.eps > 0 && isNum(x.high) && isNum(x.low) ? (x.high - x.low) / x.eps : NaN);
    return { ok, why, source: est.source, fy0_date: f0.date, fy1_date: f1?.date || null, ntm_eps: ntm, ttm_eps: ttmEps, fwd_pe: pe,
      ltm_eps: ltm, ntm_growth: ok && ltm > 0 ? ntm / ltm - 1 : NaN, fy1_growth: isNum(f1?.growth) ? f1.growth : NaN, fy1_rev_growth: isNum(f1?.rev_growth) ? f1.rev_growth : isNum(f0.rev_growth) ? f0.rev_growth : NaN,
      rev30: ntm30 > 0 && isNum(ntm) ? ntm / ntm30 - 1 : NaN, rev90: ntm90 > 0 && isNum(ntm) ? ntm / ntm90 - 1 : NaN,
      up30: up, down30: down, analysts: Math.max(n(f0.analysts) || 0, n(f1?.analysts) || 0), dispersion: spread(f1 && isNum(f1.eps) ? f1 : f0) };
  }

  // ---------------------------------------------------------------- the industry
  /** members: [{symbol, market_cap, fwd (companyForward output)}] */
  function aggregateForward(members) {
    const all = members.filter((m) => m.fwd);
    const ok = all.filter((m) => m.fwd.ok);
    const capAll = members.reduce((a, m) => a + (m.market_cap || 0), 0);
    const capOk = ok.reduce((a, m) => a + m.market_cap, 0);
    const earn = (m) => m.market_cap / m.fwd.fwd_pe; // NTM earnings in dollars
    const out = { n: ok.length, n_any: all.length, coverage: capAll ? capOk / capAll : 0, sources: [...new Set(all.map((m) => m.fwd.source))] };
    const E = ok.reduce((a, m) => a + earn(m), 0);
    out.fwd_pe = E > 0 ? capOk / E : NaN;
    const withT = ok.filter((m) => isNum(m.fwd.ntm_growth));
    const Et = withT.reduce((a, m) => a + earn(m), 0), Tt = withT.reduce((a, m) => a + earn(m) / (1 + m.fwd.ntm_growth), 0);
    out.ntm_eps_growth = Tt > 0 ? Et / Tt - 1 : NaN;
    const cw = (k, list = ok) => { const use = list.filter((m) => isNum(m.fwd[k])); const c = use.reduce((a, m) => a + m.market_cap, 0); return c ? use.reduce((a, m) => a + m.market_cap * m.fwd[k], 0) / c : NaN; };
    out.fy1_rev_growth = cw("fy1_rev_growth", all);
    out.fy1_eps_growth = cw("fy1_growth", all);
    out.rev30 = cw("rev30"); out.rev90 = cw("rev90");
    out.rev30_median = median(ok.map((m) => m.fwd.rev30)); out.rev90_median = median(ok.map((m) => m.fwd.rev90));
    const up = all.reduce((a, m) => a + (m.fwd.up30 || 0), 0), down = all.reduce((a, m) => a + (m.fwd.down30 || 0), 0);
    out.up30 = up; out.down30 = down; out.breadth = up + down ? (up - down) / (up + down) : NaN;
    const r30 = ok.filter((m) => isNum(m.fwd.rev30));
    out.share_rising = r30.length ? r30.filter((m) => m.fwd.rev30 > 0.001).length / r30.length : NaN;
    out.has_revisions = r30.length > 0;
    out.dispersion = median(all.map((m) => m.fwd.dispersion));
    out.analysts_median = median(all.map((m) => m.fwd.analysts));
    out.peg = out.fwd_pe > 0 && out.ntm_eps_growth > 0 ? out.fwd_pe / (out.ntm_eps_growth * 100) : NaN;
    out.excluded = all.filter((m) => !m.fwd.ok).map((m) => ({ symbol: m.symbol, why: m.fwd.why }));
    // Biggest movers in estimates (30 days)
    const mv = ok.filter((m) => isNum(m.fwd.rev30)).sort((a, b) => b.fwd.rev30 - a.fwd.rev30);
    out.top_up = mv.filter((m) => m.fwd.rev30 > 0).slice(0, 5).map((m) => ({ symbol: m.symbol, rev30: m.fwd.rev30 }));
    out.top_down = mv.filter((m) => m.fwd.rev30 < 0).slice(-5).reverse().map((m) => ({ symbol: m.symbol, rev30: m.fwd.rev30 }));
    return out;
  }

  // ---------------------------------------------------------------- what's priced in
  /** PV of a two-stage cash flow per $1 of starting cash flow: `years` at g, then perpetuity at gT. */
  function pv(g, r, gT, years) {
    let v = 0, cf = 1;
    for (let t = 1; t <= years; t++) { cf *= 1 + g; v += cf / (1 + r) ** t; }
    return v + (cf * (1 + gT)) / (r - gT) / (1 + r) ** years;
  }
  /** The growth g (10 years, then gT) at which the cash flow's PV equals price: yield = cash flow / price. */
  function solveGrowth(yld, r, gT = 0.03, years = 10) {
    if (!(yld > 0) || !(r > gT)) return NaN;
    const target = 1 / yld;
    let lo = -0.5, hi = 1.5;
    if (pv(lo, r, gT, years) > target) return lo;
    if (pv(hi, r, gT, years) < target) return hi;
    for (let k = 0; k < 80; k++) { const mid = (lo + hi) / 2; if (pv(mid, r, gT, years) < target) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  }
  /** 5-year revenue CAGR from quarterly income rows of the members (sum of TTM now vs TTM 5 years ago). */
  function histRevCagr(members) {
    let now = 0, then = 0, k = 0;
    for (const m of members) { const q = m.c?.q || []; if (q.length < 24) continue;
      const a = q.slice(0, 4).reduce((s, x) => s + n(x.rev), 0), b = q.slice(20, 24).reduce((s, x) => s + n(x.rev), 0);
      if (a > 0 && b > 0) { now += a; then += b; k++; } }
    return { cagr: then > 0 ? (now / then) ** (1 / 5) - 1 : NaN, n: k };
  }
  /**
   * ctx: {y10, erp, beta, fund (aggregate), fwd (aggregateForward), hist: {cagr}}
   * Returns the cost of equity, implied growth on free cash flow (TTM) and on NTM earnings, and the comparison.
   */
  function pricedIn({ y10, erp, beta, fund, fwd, hist, gT = 0.03, years = 10 }) {
    const b = isNum(beta) ? Math.max(0.5, Math.min(2.5, beta)) : 1;
    const rf = isNum(y10) ? y10 : 0.045, e = isNum(erp) ? erp : 0.05;
    const r = Math.max(rf + b * e, rf + 0.02);
    const fcfYield = isNum(fund?.fcf_margin) && fund?.ps > 0 ? fund.fcf_margin / fund.ps : NaN; // FCF / market cap
    const earnYield = fwd?.fwd_pe > 0 ? 1 / fwd.fwd_pe : fund?.pe > 0 ? 1 / fund.pe : NaN;
    const gF = solveGrowth(fcfYield, r, gT, years), gE = solveGrowth(earnYield, r, gT, years);
    const expect = isNum(fwd?.ntm_eps_growth) ? fwd.ntm_eps_growth : NaN;
    const past = hist?.cagr;
    // A 10-year growth rate is judged against what the industry actually sustained (5-year revenue growth), or
    // analysts' next-year revenue growth when there's no history; next year's EPS growth is shown alongside.
    const ref = isNum(past) ? past : fwd?.fy1_rev_growth;
    const gap = isNum(gF) && isNum(ref) ? gF - ref : NaN;
    const verdict = !isNum(gF) ? "n/a" : !isNum(ref) ? "no comparison" : gap > 0.05 ? "demanding" : gap < -0.05 ? "undemanding" : "in line";
    return { r, rf, erp: e, beta: b, gT, years, fcf_yield: fcfYield, earn_yield: earnYield, earn_basis: fwd?.fwd_pe > 0 ? "NTM" : "TTM",
      implied_fcf_growth: gF, implied_eps_growth: gE, consensus_ntm_growth: expect, consensus_fy1_rev_growth: fwd?.fy1_rev_growth ?? NaN, hist_rev_cagr_5y: past, ref_basis: isNum(past) ? "5-year revenue growth" : "next-year revenue growth", verdict, gap };
  }

  const Forward = { fromEodTrends, fromFmpEstimates, companyForward, aggregateForward, pv, solveGrowth, histRevCagr, pricedIn };
  if (typeof module !== "undefined" && module.exports) module.exports = Forward;
  else root.Forward = Forward;
})(typeof window !== "undefined" ? window : globalThis);
