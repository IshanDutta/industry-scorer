/* Industry Scorer: Portfolio mode, the quantitative engine (code only, no I/O, no Claude).
 *
 * A portfolio is a list of holdings (stocks, ETFs, mutual funds) with target weights and an investment amount. From
 * each holding's daily dividend-adjusted closes this builds the synthetic NAV (buy-and-hold from the start of the
 * period, re-weighted to the new targets at each rebalance), and computes the institutional risk and return
 * measures: annualized volatility, max drawdown, geometric Sharpe, Sortino, Calmar, monthly beta and correlation to
 * SPY, alpha, up and down capture, 1-day VaR 95%, effective number of holdings, sector HHI, linear attribution
 * (weight x return = contribution, summing exactly to the portfolio's return), a 0-100 health score, the rebalance
 * order sheet and the look-through to the single stocks inside its funds.
 */
(function (root) {
  "use strict";
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const n = (x) => (x === null || x === undefined || x === "" ? NaN : Number(x));
  const RF = 0.04;
  const r1 = (x, d = 1) => (isNum(x) ? Math.round(x * 10 ** d) / 10 ** d : null);

  // ------------------------------------------------------------------ portfolios and weights
  const SEED = () => ({ id: "portfolio_seed_1", name: "Growth & Value Core", description: "A starter portfolio: edit it or make your own.", totalInvestment: 100000,
    holdings: [{ ticker: "QQQ", name: "Invesco QQQ Trust", weight: 30, asset_type: "etf" }, { ticker: "SPY", name: "SPDR S&P 500 ETF", weight: 30, asset_type: "etf" },
      { ticker: "AAPL", name: "Apple Inc.", weight: 15, asset_type: "stock", sector: "Technology" }, { ticker: "MSFT", name: "Microsoft Corp.", weight: 15, asset_type: "stock", sector: "Technology" },
      { ticker: "SCHD", name: "Schwab US Dividend Equity", weight: 10, asset_type: "etf" }],
    rebalanceEvents: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  /** Weights scaled to add to 100 (one decimal). */
  function normalizeWeights(holdings) {
    const total = holdings.reduce((s, h) => s + (n(h.weight) || 0), 0); if (total <= 0) return holdings;
    return holdings.map((h) => ({ ...h, weight: Math.round(((n(h.weight) || 0) / total) * 1000) / 10 }));
  }
  /** Dollar amounts to weights (of the investment amount, else of their sum). */
  function weightsFromDollars(items, totalInvestment) {
    const total = totalInvestment > 0 ? totalInvestment : items.reduce((s, i) => s + (n(i.dollar) || 0), 0);
    return items.map((i) => ({ ticker: String(i.ticker || "").toUpperCase(), marketValue: n(i.dollar) || 0, weight: total > 0 ? Math.round(((n(i.dollar) || 0) / total) * 1000) / 10 : 0 }));
  }
  /** Each holding's market value: shares x price when both are known, else its weight of the investment amount. */
  function marketValues(p) {
    const hs = p.holdings || [], byShares = hs.every((h) => n(h.shares) > 0 && n(h.price) > 0);
    return hs.map((h) => ({ ...h, marketValue: byShares ? h.shares * h.price : (p.totalInvestment || 0) * ((n(h.weight) || 0) / 100) }));
  }

  // ------------------------------------------------------------------ the NAV
  /** A daily close series as a date map. ser: {dates, closes|values}. */
  const mapOf = (ser) => { const m = new Map(), v = ser?.closes || ser?.values || []; (ser?.dates || []).forEach((d, i) => { if (n(v[i]) > 0) m.set(d, n(v[i])); }); return m; };
  /**
   * The synthetic NAV from `from` (or the first day every holding trades): NAV_t = sum w_i P_i,t / P_i,0, rebased to
   * `start` dollars; at each rebalance event the weights reset to its targets (applied to that day's NAV).
   * series: {TICKER: {dates, closes}}; holdings: [{ticker, weight}]; events: [{date, trades: [{ticker, newWeight}]}].
   * Returns {dates, values, from, missing: [tickers with no prices], late: [{ticker, first}]}.
   */
  function nav(series, holdings, { from = null, start = 10000, events = [], calendar = null } = {}) {
    const hs = holdings.filter((h) => n(h.weight) > 0), maps = {}, missing = [];
    for (const h of hs) { const m = mapOf(series[h.ticker]); if (m.size) maps[h.ticker] = m; else missing.push(h.ticker); }
    const live = hs.filter((h) => maps[h.ticker]); if (!live.length) return { dates: [], values: [], from: null, missing, late: [] };
    const firsts = live.map((h) => ({ ticker: h.ticker, first: [...maps[h.ticker].keys()].sort()[0] }));
    const common = firsts.reduce((a, x) => (x.first > a ? x.first : a), "0000");
    const days = (calendar || [...new Set(live.flatMap((h) => [...maps[h.ticker].keys()]))]).filter((d) => d >= common && (!from || d >= from)).sort();
    if (!days.length) return { dates: [], values: [], from: null, missing, late: [] };
    const last = {}; const px = (t, d) => { const v = maps[t].get(d); if (v > 0) last[t] = v; return last[t]; };
    // Prime each holding's last known price at or before the first day.
    for (const h of live) { const ks = [...maps[h.ticker].keys()].filter((d) => d <= days[0]).sort(); if (ks.length) last[h.ticker] = maps[h.ticker].get(ks[ks.length - 1]); }
    const evs = (events || []).filter((e) => e?.date && e.date > days[0]).sort((a, b) => (a.date < b.date ? -1 : 1));
    let w = Object.fromEntries(live.map((h) => [h.ticker, n(h.weight) / 100])), tw = Object.values(w).reduce((a, x) => a + x, 0);
    for (const k of Object.keys(w)) w[k] /= tw;
    // Units held of each holding per dollar of NAV.
    let value = start, units = {}; for (const t of Object.keys(w)) units[t] = (value * w[t]) / px(t, days[0]);
    const dates = [], values = []; let ei = 0;
    for (const d of days) {
      let v = 0; for (const t of Object.keys(units)) v += units[t] * (px(t, d) || 0);
      if (ei < evs.length && d >= evs[ei].date) {
        const tgt = {}; for (const tr of evs[ei].trades || []) if (maps[tr.ticker] && n(tr.newWeight) > 0) tgt[tr.ticker] = n(tr.newWeight) / 100;
        const s0 = Object.values(tgt).reduce((a, x) => a + x, 0); if (s0 > 0) { units = {}; for (const t of Object.keys(tgt)) { const p = px(t, d); if (p > 0) units[t] = (v * tgt[t] / s0) / p; } }
        ei++;
      }
      dates.push(d); values.push(v);
    }
    return { dates, values, from: days[0], missing, late: firsts.filter((x) => x.first > (from || "0000")).map((x) => x) };
  }
  /** The start date of a period ending at `end`: 1M, 3M, 6M, YTD, 1Y, 3Y, 5Y. */
  function periodStart(end, p) {
    const t = new Date(end + "T00:00:00Z");
    if (p === "YTD") return `${end.slice(0, 4)}-01-01`;
    const m = { "1M": 1, "3M": 3, "6M": 6, "1Y": 12, "3Y": 36, "5Y": 60 }[p] || 12; t.setUTCMonth(t.getUTCMonth() - m); return t.toISOString().slice(0, 10);
  }

  // ------------------------------------------------------------------ the measures
  const rets = (v) => { const out = []; for (let i = 1; i < v.length; i++) if (v[i - 1] > 0) out.push(v[i] / v[i - 1] - 1); return out; };
  const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
  const sdev = (a) => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
  function maxDrawdown(v) { let peak = v[0], mdd = 0; for (const x of v) { if (x > peak) peak = x; const dd = (peak - x) / peak; if (dd > mdd) mdd = dd; } return mdd * 100; }
  function var95(r) { if (!r.length) return NaN; const s = [...r].sort((a, b) => a - b); return Math.abs(s[Math.floor(s.length * 0.05)]) * 100; }
  /** Calendar-month returns from a daily series aligned on dates. */
  function monthly(dates, values) { const out = new Map(); let prevEnd = null; for (let i = 0; i < dates.length; i++) { const m = dates[i].slice(0, 7), next = dates[i + 1]?.slice(0, 7); if (next !== m) { if (prevEnd !== null && prevEnd > 0) out.set(m, values[i] / prevEnd - 1); prevEnd = values[i]; } } return out; }
  /**
   * Every measure for a NAV against SPY over the same days. nv: {dates, values}; spy: {dates, closes|values}.
   * Returns the QuantitativeMetrics fields (volatility, VaR and drawdown in %; returns as fractions).
   */
  function metrics(nv, spy, { rf = RF } = {}) {
    const v = nv.values, N = v.length - 1; if (N < 5) return null;
    const r = rets(v), vol = sdev(r) * Math.sqrt(252) * 100;
    const total = v[v.length - 1] / v[0] - 1, ann = Math.pow(1 + total, 252 / N) - 1;
    const sharpe = vol > 0 ? (ann - rf) / (vol / 100) : NaN;
    const semi = Math.sqrt(r.reduce((s, x) => s + Math.min(0, x) ** 2, 0) / (r.length || 1)) * Math.sqrt(252), sortino = semi > 0 ? (ann - rf) / semi : NaN;
    const mdd = maxDrawdown(v), calmar = mdd > 0 ? ann / (mdd / 100) : NaN;
    // Monthly against SPY.
    const sm = mapOf(spy), sv = nv.dates.map((d) => sm.get(d)), sOk = sv.filter((x) => x > 0).length > N * 0.8;
    let beta = NaN, corr = NaN, up = NaN, down = NaN, alpha = NaN, spyAnn = NaN, spyTotal = NaN;
    if (sOk) {
      let lastS = null; const sFill = sv.map((x) => (x > 0 ? (lastS = x) : lastS));
      const pm = monthly(nv.dates, v), smm = monthly(nv.dates, sFill), ks = [...pm.keys()].filter((k) => smm.has(k));
      const a = ks.map((k) => pm.get(k)), b = ks.map((k) => smm.get(k));
      if (ks.length >= 6) { const ma = mean(a), mb = mean(b); let cv = 0, va = 0, vb = 0; for (let i = 0; i < a.length; i++) { cv += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; }
        cv /= a.length - 1; va /= a.length - 1; vb /= a.length - 1; beta = vb > 0 ? cv / vb : NaN; corr = va > 0 && vb > 0 ? cv / Math.sqrt(va * vb) : NaN;
        const upI = b.map((x, i) => (x > 0 ? i : -1)).filter((i) => i >= 0), dnI = b.map((x, i) => (x < 0 ? i : -1)).filter((i) => i >= 0);
        if (upI.length) up = (mean(upI.map((i) => a[i])) / mean(upI.map((i) => b[i]))) * 100; if (dnI.length) down = (mean(dnI.map((i) => a[i])) / mean(dnI.map((i) => b[i]))) * 100; }
      const s0 = sFill.find((x) => x > 0), s1 = sFill[sFill.length - 1]; spyTotal = s0 > 0 ? s1 / s0 - 1 : NaN; spyAnn = isNum(spyTotal) ? Math.pow(1 + spyTotal, 252 / N) - 1 : NaN;
      if (isNum(beta) && isNum(spyAnn)) alpha = ann - (rf + beta * (spyAnn - rf));
    }
    return { days: N, totalReturn: total, annReturn: ann, volatility: vol, maxDrawdown: mdd, sharpeRatio: sharpe, sortinoRatio: sortino, calmarRatio: calmar, beta, correlationToSPY: corr,
      upsideCapture: up, downsideCapture: down, alpha, var95: var95(r), spyReturn: spyTotal, spyAnnReturn: spyAnn };
  }
  /** Inverse Herfindahl: the effective number of holdings (weights in %). */
  const effectiveHoldings = (ws) => { const s = ws.reduce((a, w) => a + (w / 100) ** 2, 0); return s > 0 ? 1 / s : 0; };
  /** Sector HHI on weights in % (0-10,000): under 1,500 diversified, 1,500-2,500 moderate, above highly concentrated. */
  function sectorHHI(holdings) { const by = {}; for (const h of holdings) { const k = h.sector || "Other"; by[k] = (by[k] || 0) + (n(h.weight) || 0); } const tot = Object.values(by).reduce((a, x) => a + x, 0) || 1;
    return { hhi: Object.values(by).reduce((a, w) => a + ((100 * w) / tot) ** 2, 0), sectors: Object.fromEntries(Object.entries(by).map(([k, w]) => [k, (100 * w) / tot]).sort((a, b) => b[1] - a[1])) }; }
  const hhiLabel = (h) => (h < 1500 ? "Diversified" : h <= 2500 ? "Moderate" : "Highly concentrated");
  /**
   * Linear attribution over the NAV's period: each holding's contribution = its weight at the start x its return, so
   * the contributions add to the buy-and-hold return exactly. Between rebalances the weights reset, so with events
   * each segment's contributions are compounded into the total by the portfolio's value at the segment start.
   */
  function contributions(series, holdings, nv, events = []) {
    if (!nv.dates.length) return { rows: [], total: 0 };
    const from = nv.dates[0], to = nv.dates[nv.dates.length - 1], cut = [from, ...(events || []).map((e) => e.date).filter((d) => d > from && d < to).sort(), to];
    const pxAt = (t, d) => { const m = mapOf(series[t]); let best = null; for (const [k, v] of m) if (k <= d && (!best || k > best[0])) best = [k, v]; return best ? best[1] : NaN; };
    const navAt = (d) => { let best = 0; for (let i = 0; i < nv.dates.length; i++) if (nv.dates[i] <= d) best = i; return nv.values[best]; };
    const acc = {}; let wts = Object.fromEntries(holdings.filter((h) => n(h.weight) > 0).map((h) => [h.ticker, n(h.weight)]));
    for (let s = 0; s < cut.length - 1; s++) {
      if (s > 0) { const e = events.find((x) => x.date === cut[s]); if (e) wts = Object.fromEntries((e.trades || []).filter((t) => n(t.newWeight) > 0).map((t) => [t.ticker, n(t.newWeight)])); }
      const tw = Object.values(wts).reduce((a, x) => a + x, 0) || 1, scale = navAt(cut[s]) / nv.values[0];
      for (const [t, w] of Object.entries(wts)) { const p0 = pxAt(t, cut[s]), p1 = pxAt(t, cut[s + 1]); if (!(p0 > 0 && p1 > 0)) continue; const ret = p1 / p0 - 1; (acc[t] ||= { contribution: 0, ret: 1 }); acc[t].contribution += (w / tw) * ret * scale; acc[t].ret *= 1 + ret; }
    }
    const meta = Object.fromEntries(holdings.map((h) => [h.ticker, h]));
    const rows = Object.entries(acc).map(([t, x]) => ({ ticker: t, weight: n(meta[t]?.weight) || 0, return: x.ret - 1, contribution: x.contribution, sector: meta[t]?.sector || null })).sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
    return { rows, total: rows.reduce((a, r) => a + r.contribution, 0) };
  }
  /** A 0-100 health score from the measures (risk-adjusted return, drawdown, diversification, capture asymmetry). */
  function healthScore(m, effN, count, hhi) {
    if (!m) return null; const c = (x) => Math.max(0, Math.min(1, x));
    const parts = [["Risk-adjusted return (Sharpe)", 25, isNum(m.sharpeRatio) ? c(m.sharpeRatio / 1.5) : 0.5], ["Drawdown control", 20, isNum(m.maxDrawdown) ? c(1 - m.maxDrawdown / 40) : 0.5],
      ["Holdings diversification", 20, count > 0 ? c(effN / Math.min(10, count)) : 0], ["Sector diversification", 20, isNum(hhi) ? c((4000 - hhi) / 2500) : 0.5],
      ["Up vs down capture", 15, isNum(m.upsideCapture) && isNum(m.downsideCapture) ? c(0.5 + (m.upsideCapture - m.downsideCapture) / 40) : 0.5]];
    return { score: Math.round(parts.reduce((a, [, w, x]) => a + w * x, 0)), parts: parts.map(([l, w, x]) => ({ label: l, weight: w, score: Math.round(100 * x) })) };
  }
  /** Where a measure stands against its target: "good" | "ok" | "bad". */
  function stance(key, v, ctx = {}) {
    if (!isNum(v)) return null;
    switch (key) {
      case "volatility": return v < 16 ? "good" : v < 22 ? "ok" : "bad";
      case "var95": return v < 1.8 ? "good" : v < 2.5 ? "ok" : "bad";
      case "sharpeRatio": return v > 1 ? "good" : v > 0.5 ? "ok" : "bad";
      case "sortinoRatio": return v > 1.5 ? "good" : v > 0.8 ? "ok" : "bad";
      case "calmarRatio": return v > 1 ? "good" : v > 0.5 ? "ok" : "bad";
      case "beta": return v >= 0.8 && v <= 1.0 ? "good" : v >= 0.6 && v <= 1.2 ? "ok" : "bad";
      case "correlationToSPY": return v < 0.85 ? "good" : v < 0.95 ? "ok" : "bad";
      case "capture": return ctx.up > ctx.down ? "good" : ctx.up > ctx.down - 5 ? "ok" : "bad";
      case "effectiveHoldings": return ctx.count ? (v > 0.6 * ctx.count ? "good" : v > 0.4 * ctx.count ? "ok" : "bad") : null;
      case "hhi": return v < 1500 ? "good" : v <= 2500 ? "ok" : "bad";
      default: return null;
    }
  }
  /** The order sheet to move from current weights to targets: [{ticker, current, target, deltaUsd, action, shares}]. */
  function rebalanceTrades(holdings, targets, totalValue) {
    const cur = Object.fromEntries(holdings.map((h) => [h.ticker, n(h.weight) || 0])), all = [...new Set([...Object.keys(cur), ...Object.keys(targets)])];
    return all.map((t) => { const c = cur[t] || 0, tg = n(targets[t]) || 0, d = totalValue * ((tg - c) / 100), px = n(holdings.find((h) => h.ticker === t)?.price);
      return { ticker: t, current: c, target: tg, deltaUsd: d, action: Math.abs(d) < 0.5 ? "HOLD" : d > 0 ? "BUY" : "SELL", shares: px > 0 ? d / px : null }; }).sort((a, b) => Math.abs(b.deltaUsd) - Math.abs(a.deltaUsd));
  }
  /**
   * Look-through: the single stocks behind the portfolio. direct holdings count at their weight; each fund's holdings
   * at the fund's weight x their weight in it. funds: {TICKER: [{ticker, name, weight (0-1)}]}.
   */
  function lookThrough(holdings, funds) {
    const agg = new Map();
    const add = (t, name, w, via) => { if (!t || !(w > 0)) return; const e = agg.get(t) || { ticker: t, name: name || "", direct: 0, viaFunds: 0, via: [] }; if (via) { e.viaFunds += w; e.via.push({ fund: via, weight: w }); } else e.direct += w; if (!e.name && name) e.name = name; agg.set(t, e); };
    let covered = 0;
    for (const h of holdings) { const w = (n(h.weight) || 0) / 100, fx = funds[h.ticker];
      if (fx?.length) { for (const x of fx) add(String(x.ticker || "").toUpperCase(), x.name, w * (n(x.weight) || 0), h.ticker); covered += w * fx.reduce((a, x) => a + (n(x.weight) || 0), 0); }
      else add(h.ticker, h.name, w, null); }
    const rows = [...agg.values()].map((e) => ({ ...e, total: e.direct + e.viaFunds })).sort((a, b) => b.total - a.total);
    return { rows, overlap: rows.filter((r) => r.direct > 0 && r.viaFunds > 0), covered };
  }
  /** Weighted average of a per-holding figure over the holdings that have it (P/E: harmonic, as earnings yield). */
  function weighted(holdings, key, { harmonic = false } = {}) {
    let w = 0, s = 0; for (const h of holdings) { const v = n(h[key]), ww = n(h.weight) || 0; if (!isNum(v) || ww <= 0 || (harmonic && v <= 0)) continue; w += ww; s += harmonic ? ww / v : ww * v; }
    return w > 0 ? (harmonic ? w / s : s / w) : NaN;
  }
  /** Holdings as CSV (for export). */
  function toCsv(p) { const head = "ticker,name,asset_type,sector,weight,shares,avg_cost,price,market_value"; return [head, ...marketValues(p).map((h) => [h.ticker, `"${String(h.name || "").replace(/"/g, "'")}"`, h.asset_type || "", `"${h.sector || ""}"`, h.weight ?? "", h.shares ?? "", h.avg_cost ?? "", h.price ?? "", r1(h.marketValue, 2) ?? ""].join(","))].join("\n"); }

  const PMode = { RF, SEED, normalizeWeights, weightsFromDollars, marketValues, nav, periodStart, rets, maxDrawdown, var95, monthly, metrics, effectiveHoldings, sectorHHI, hhiLabel, contributions, healthScore, stance, rebalanceTrades, lookThrough, weighted, toCsv };
  if (typeof module !== "undefined" && module.exports) module.exports = PMode;
  else root.PMode = PMode;
})(typeof window !== "undefined" ? window : globalThis);
