/* Industry Scorer metrics engine (JavaScript port of industry_scorer/metrics.py,
 * universe.py and pipeline.analyze_industry). Pure functions, no I/O.
 * Verified against the Python engine by web/parity_test.js.
 *
 * Conventions
 *  - Dates are "YYYY-MM-DD" strings (sort lexicographically = chronologically).
 *  - A price series is {dates: string[], closes: number[]} ascending, no gaps
 *    represented as NaN (a missing day is simply absent).
 *  - Returns are decimals (0.12 = 12%).
 */
(function (root) {
  "use strict";
  const TRADING_DAYS = 252;

  // ---------------------------------------------------------------- dates
  function parseYmd(s) { const [y, m, d] = s.split("-").map(Number); return { y, m, d }; }
  function ymd(y, m, d) { return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`; }
  function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
  /** pandas DateOffset(months=n) semantics: shift month, clamp day to month end. */
  function addMonths(dateStr, n) {
    const { y, m, d } = parseYmd(dateStr);
    let mm = m - 1 + n;
    const yy = y + Math.floor(mm / 12);
    mm = ((mm % 12) + 12) % 12 + 1;
    return ymd(yy, mm, Math.min(d, daysInMonth(yy, mm)));
  }
  function windowStart(asOf, months) { return addMonths(asOf, -months); }
  function addDays(dateStr, n) {
    const { y, m, d } = parseYmd(dateStr);
    const t = new Date(Date.UTC(y, m - 1, d + n));
    return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  }

  // ---------------------------------------------------------------- stats helpers
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN; }
  function median(a) {
    if (!a.length) return NaN;
    const s = [...a].sort((x, y) => x - y), k = s.length >> 1;
    return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
  }
  function std(a) { // ddof=1
    if (a.length < 2) return NaN;
    const mu = mean(a);
    return Math.sqrt(a.reduce((s, x) => s + (x - mu) ** 2, 0) / (a.length - 1));
  }
  /** Last index i with arr[i] <= x, or -1. */
  function bisectRight(arr, x) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= x) lo = mid + 1; else hi = mid; }
    return lo - 1;
  }

  // ---------------------------------------------------------------- returns
  function priceOnOrBefore(series, when) {
    const i = bisectRight(series.dates, when);
    return i >= 0 ? series.closes[i] : NaN;
  }
  function singleReturn(series, asOf, months) {
    const p0 = priceOnOrBefore(series, windowStart(asOf, months));
    const p1 = priceOnOrBefore(series, asOf);
    return p0 > 0 ? p1 / p0 - 1 : NaN;
  }
  /** Per-symbol window return; NaN when the symbol has prices on fewer than
   * minCoverage of the calendar's trading days in the window. */
  function trailingReturns(pricesBySym, calendar, asOf, months, minCoverage = 0.9) {
    const start = windowStart(asOf, months);
    const win = calendar.filter((d) => d > start && d <= asOf);
    const out = {};
    for (const [sym, s] of Object.entries(pricesBySym)) {
      const have = new Set(s.dates);
      const cov = win.length ? win.filter((d) => have.has(d)).length / win.length : 0;
      const p0 = priceOnOrBefore(s, start), p1 = priceOnOrBefore(s, asOf);
      out[sym] = cov >= minCoverage && p0 > 0 ? p1 / p0 - 1 : NaN;
    }
    return out;
  }
  /** Buy-and-hold cap-weighted basket return; start caps backed out as cap_now/(1+r). */
  function capWeightedReturn(returns, capsNow) {
    let now = 0, start = 0, n = 0;
    for (const [sym, r] of Object.entries(returns)) {
      const mc = capsNow[sym];
      if (!isNum(r) || !isNum(mc) || !(1 + r > 0)) continue;
      now += mc; start += mc / (1 + r); n++;
    }
    return n ? now / start - 1 : NaN;
  }

  // ---------------------------------------------------------------- index
  /** Reindex a series onto a calendar with forward fill limited to `limit` rows. */
  function reindexFfill(series, calendar, limit = 3) {
    const map = new Map(series.dates.map((d, i) => [d, series.closes[i]]));
    const out = new Array(calendar.length).fill(NaN);
    // pandas ffill(limit): fill at most `limit` consecutive missing rows after a value.
    let last = NaN, gap = 0;
    for (let i = 0; i < calendar.length; i++) {
      const v = map.get(calendar[i]);
      if (v !== undefined && isNum(v)) { out[i] = v; last = v; gap = 0; continue; }
      gap++;
      if (isNum(last) && gap <= limit) out[i] = last;
    }
    return out;
  }
  /** Daily cap-weighted industry index; weight = implied cap the previous day. */
  function industryIndex(pricesBySym, capsNow, calendar, base = 100) {
    const syms = Object.keys(pricesBySym).filter((s) => isNum(capsNow[s]));
    if (!syms.length || !calendar.length) return { dates: [], levels: [] };
    const px = syms.map((s) => reindexFfill(pricesBySym[s], calendar));
    const lastValid = px.map((col) => { for (let i = col.length - 1; i >= 0; i--) if (isNum(col[i])) return col[i]; return NaN; });
    const levels = [base];
    let level = base;
    for (let t = 1; t < calendar.length; t++) {
      let num = 0, den = 0;
      for (let k = 0; k < syms.length; k++) {
        const p0 = px[k][t - 1], p1 = px[k][t];
        if (!isNum(p0) || !isNum(p1) || !isNum(lastValid[k])) continue;
        const w = (p0 / lastValid[k]) * capsNow[syms[k]];
        num += w * (p1 / p0 - 1); den += w;
      }
      const daily = den > 0 ? num / den : 0;
      level *= 1 + daily;
      levels.push(level);
    }
    return { dates: calendar.slice(), levels };
  }

  // ---------------------------------------------------------------- risk
  function pctChange(dates, values) { // consecutive, skipping nothing
    const d = [], r = [];
    for (let i = 1; i < values.length; i++) {
      const a = values[i - 1], b = values[i];
      if (isNum(a) && isNum(b) && a !== 0) { d.push(dates[i]); r.push(b / a - 1); }
    }
    return { dates: d, rets: r };
  }
  function beta(r, bench) { // r, bench: {dates, rets}
    const bm = new Map(bench.dates.map((d, i) => [d, bench.rets[i]]));
    const x = [], y = [];
    r.dates.forEach((d, i) => { const b = bm.get(d); if (isNum(b) && isNum(r.rets[i])) { x.push(r.rets[i]); y.push(b); } });
    if (x.length < 20) return NaN;
    const mx = mean(x), my = mean(y);
    let cov = 0, v = 0;
    for (let i = 0; i < x.length; i++) { cov += (x[i] - mx) * (y[i] - my); v += (y[i] - my) ** 2; }
    return v > 0 ? cov / v : NaN;
  }
  /**
   * Jensen's alpha, annualized: the average daily return above what beta and the market explain, both net of the
   * risk-free rate (r - rf = alpha + beta x (rm - rf)), times 252. Same days as beta.
   */
  function alpha(r, bench, rfDaily, b = NaN) {
    const bm = new Map(bench.dates.map((d, i) => [d, bench.rets[i]]));
    const x = [], y = [];
    r.dates.forEach((d, i) => { const m = bm.get(d), rf = rfDaily?.get?.(d) ?? 0; if (isNum(m) && isNum(r.rets[i])) { x.push(r.rets[i] - rf); y.push(m - rf); } });
    if (x.length < 20) return NaN;
    const be = isNum(b) ? b : beta(r, bench);
    return isNum(be) ? (mean(x) - be * mean(y)) * TRADING_DAYS : NaN;
  }
  function annualVol(rets) { const a = rets.filter(isNum); return a.length > 1 ? std(a) * Math.sqrt(TRADING_DAYS) : NaN; }
  function downsideVol(rets, target = 0) {
    const a = rets.filter(isNum);
    if (a.length < 2) return NaN;
    return Math.sqrt(mean(a.map((x) => Math.min(x - target, 0) ** 2))) * Math.sqrt(TRADING_DAYS);
  }
  function maxDrawdown(levels) {
    let peak = -Infinity, worst = NaN;
    for (const v of levels) { if (!isNum(v)) continue; peak = Math.max(peak, v); const dd = v / peak - 1; worst = isNum(worst) ? Math.min(worst, dd) : dd; }
    return worst;
  }
  /** Annual yields [{date, y}] -> per-day rate on each calendar date (ffill, then bfill). */
  function toDailyRf(yields, calendar, fallback) {
    const pts = (yields || []).filter((p) => isNum(p.y)).sort((a, b) => (a.date < b.date ? -1 : 1));
    const out = new Map();
    if (!pts.length) { calendar.forEach((d) => out.set(d, (1 + fallback) ** (1 / TRADING_DAYS) - 1)); return out; }
    const ds = pts.map((p) => p.date);
    calendar.forEach((d) => { const i = bisectRight(ds, d); const y = pts[Math.max(i, 0)].y; out.set(d, (1 + y) ** (1 / TRADING_DAYS) - 1); });
    return out;
  }
  function sharpe(r, rfDaily) {
    if (r.rets.length < 20) return NaN;
    const ex = r.rets.map((x, i) => x - (rfDaily.get(r.dates[i]) ?? 0));
    const sd = std(ex);
    return sd > 0 ? (mean(ex) / sd) * Math.sqrt(TRADING_DAYS) : NaN;
  }
  function riskProfile(r, benchR, rfDaily) {
    const level = [1]; let l = 1;
    for (const x of r.rets) { l *= 1 + (isNum(x) ? x : 0); level.push(l); }
    return {
      beta: beta(r, benchR), alpha_1y: alpha(r, benchR, rfDaily), vol_1y: annualVol(r.rets), downside_vol_1y: downsideVol(r.rets),
      max_dd_1y: maxDrawdown(level), sharpe_1y: sharpe(r, rfDaily),
    };
  }

  // ---------------------------------------------------------------- universe
  const SUFFIXES = /\b(class [a-z]|cl [a-z]|series [a-z]|inc|incorporated|corp|corporation|co|company|ltd|limited|plc|holdings?|group|n\.?v|s\.?a|ag|the)\b/g;
  function normalizeCompanyName(name) {
    return String(name).toLowerCase().replace(/[.,'()&/-]/g, " ").replace(SUFFIXES, " ").replace(/\s+/g, " ").trim();
  }
  /** Raw screener rows -> top-N [{rank, symbol, name, market_cap, exchange, country}]. */
  function buildUniverse(rows, { topN = 50, exchanges = ["NYSE", "NASDAQ", "AMEX"], includeAdrs = false } = {}) {
    const allowed = new Set(exchanges.map((e) => e.toUpperCase()));
    const seen = new Set();
    const out = [];
    const clean = (rows || [])
      .map((r) => ({
        symbol: r.symbol, name: String(r.companyName ?? r.symbol),
        market_cap: Number(r.marketCap), exchange: String(r.exchangeShortName ?? r.exchange ?? "").toUpperCase(),
        country: r.country ?? "",
      }))
      .filter((r) => r.symbol && allowed.has(r.exchange) && r.market_cap > 0 && (includeAdrs || r.country === "US"))
      .sort((a, b) => b.market_cap - a.market_cap);
    for (const r of clean) {
      const key = normalizeCompanyName(r.name);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...r, rank: out.length + 1 });
      if (out.length >= topN) break;
    }
    return out;
  }

  // ---------------------------------------------------------------- industry
  /**
   * Mirror of pipeline.analyze_industry.
   * @param universe   output of buildUniverse
   * @param pricesBySym {sym: {dates, closes}} (only symbols with data)
   * @param bench      SPY {dates, closes}; its dates are the trading calendar
   * @param rfDaily    Map date -> daily risk-free rate
   * @param asOf       last benchmark date
   * @param cfg        {windows:{"1M":1,...}, minCoverage, riskMonths, topN}
   */
  function analyzeIndustry(industry, universe, pricesBySym, bench, rfDaily, asOf, cfg) {
    const warnings = [];
    if (universe.length < cfg.topN) warnings.push(`Only ${universe.length} companies qualify (target ${cfg.topN}).`);
    const missing = universe.filter((u) => !pricesBySym[u.symbol]).map((u) => u.symbol);
    if (missing.length) warnings.push(`No price data for: ${missing.join(", ")}.`);
    const uni = universe.filter((u) => pricesBySym[u.symbol]).map((u) => ({ ...u }));
    if (!uni.length) return null;

    const calendar = bench.dates;
    const caps = Object.fromEntries(uni.map((u) => [u.symbol, u.market_cap]));
    const capSum = uni.reduce((s, u) => s + u.market_cap, 0);
    uni.forEach((u) => { u.weight = u.market_cap / capSum; });
    const prices = Object.fromEntries(uni.map((u) => [u.symbol, pricesBySym[u.symbol]]));

    const summary = { industry, as_of: asOf };
    for (const [label, months] of Object.entries(cfg.windows)) {
      const r = trailingReturns(prices, calendar, asOf, months, cfg.minCoverage);
      const spy = singleReturn(bench, asOf, months);
      uni.forEach((u) => { u[`ret_${label}`] = r[u.symbol]; u[`excess_${label}`] = r[u.symbol] - spy; });
      const valid = Object.fromEntries(Object.entries(r).filter(([, v]) => isNum(v)));
      const vals = Object.values(valid);
      const cw = capWeightedReturn(valid, caps);
      Object.assign(summary, {
        [`spy_${label}`]: spy,
        [`ret_cw_${label}`]: cw,
        [`ret_median_${label}`]: median(vals),
        [`ret_ew_${label}`]: mean(vals),
        [`excess_cw_${label}`]: cw - spy,
        [`excess_median_${label}`]: median(vals) - spy,
        [`breadth_${label}`]: vals.length ? vals.filter((v) => v > spy).length / vals.length : NaN,
        [`n_valid_${label}`]: vals.length,
      });
    }

    // Risk on the cap-weighted index over the lookback.
    const riskStart = windowStart(asOf, cfg.riskMonths);
    const riskCal = calendar.filter((d) => d >= riskStart);
    const pricesRisk = Object.fromEntries(Object.entries(prices).map(([s, ser]) => {
      const i0 = ser.dates.findIndex((d) => d >= riskStart);
      return [s, i0 < 0 ? { dates: [], closes: [] } : { dates: ser.dates.slice(i0), closes: ser.closes.slice(i0) }];
    }));
    const idx = industryIndex(pricesRisk, caps, riskCal);
    const idxR = pctChange(idx.dates, idx.levels);
    const bi = bench.dates.findIndex((d) => d >= riskStart);
    const benchR = pctChange(bench.dates.slice(bi), bench.closes.slice(bi));
    Object.assign(summary, riskProfile(idxR, benchR, rfDaily));

    // Constituent risk, on each stock's own trading days (union calendar of the basket).
    const unionDates = [...new Set(Object.values(pricesRisk).flatMap((s) => s.dates))].sort();
    uni.forEach((u) => {
      const s = pricesRisk[u.symbol];
      const m = new Map(s.dates.map((d, i) => [d, s.closes[i]]));
      const col = unionDates.map((d) => (m.has(d) ? m.get(d) : NaN));
      const r = pctChange(unionDates, col);
      u.beta = beta(r, benchR);
      u.alpha = alpha(r, benchR, rfDaily, u.beta);
      u.vol_1y = annualVol(r.rets);
      u.max_dd_1y = maxDrawdown(s.closes);
    });
    Object.assign(summary, {
      beta_median: median(uni.map((u) => u.beta).filter(isNum)),
      alpha_median: median(uni.map((u) => u.alpha).filter(isNum)),
      vol_1y_median: median(uni.map((u) => u.vol_1y).filter(isNum)),
      max_dd_1y_median: median(uni.map((u) => u.max_dd_1y).filter(isNum)),
    });

    const byW = [...uni].sort((a, b) => b.weight - a.weight);
    Object.assign(summary, {
      n_constituents: uni.length, total_market_cap: capSum,
      top1_weight: byW[0].weight, top5_weight: byW.slice(0, 5).reduce((s, u) => s + u.weight, 0),
      largest_company: byW[0].name,
    });
    if (summary.top1_weight > 0.4) {
      warnings.push(`${summary.largest_company} is ${Math.round(summary.top1_weight * 100)}% of the industry; ` +
        "cap-weighted figures mostly reflect that one stock. Compare with the median.");
    }
    summary.warnings = warnings.join(" | ");
    return { summary, constituents: uni, index: idx, warnings };
  }

  const Engine = {
    TRADING_DAYS, addMonths, addDays, windowStart, mean, median, std,
    priceOnOrBefore, singleReturn, trailingReturns, capWeightedReturn,
    reindexFfill, industryIndex, pctChange, beta, alpha, annualVol, downsideVol, maxDrawdown,
    toDailyRf, sharpe, riskProfile, normalizeCompanyName, buildUniverse, analyzeIndustry,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = Engine;
  else root.Engine = Engine;
})(typeof window !== "undefined" ? window : globalThis);
