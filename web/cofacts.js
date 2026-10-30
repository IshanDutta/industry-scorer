/* Industry Scorer: the numbers on a company page, computed in code (no I/O).
 *
 * Performance over every window against SPY, the sector ETF and its industry; the risk "Greeks" (alpha, beta,
 * correlation, R², volatility, Sharpe, Sortino, Treynor, information ratio, capture, VaR, skew) over 1 and 3 years
 * with a rolling beta; theoretical option Greeks (Black-Scholes at the stock's own volatility); per-investor scores
 * against the industry's top 50; P/E and fundamentals history from the quarterly statements; earnings surprises.
 */
(function (root) {
  "use strict";
  const TD = 252;
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const n = (x) => (x === null || x === undefined || x === "" ? NaN : Number(x));
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
  const std = (a) => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
  const quant = (a, q) => { const v = a.filter(isNum).sort((x, y) => x - y); if (!v.length) return NaN; const p = (v.length - 1) * q, i = Math.floor(p); return v[i] + (v[Math.min(i + 1, v.length - 1)] - v[i]) * (p - i); };
  const median = (a) => quant(a, 0.5);
  const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
  const addMonths = (d, m) => { const t = new Date(d + "T00:00:00Z"); t.setUTCMonth(t.getUTCMonth() + m); return t.toISOString().slice(0, 10); };
  const addDays = (d, k) => { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + k); return t.toISOString().slice(0, 10); };
  const vals = (s) => s?.closes || s?.levels || [];

  /** Last index with date <= d (or -1). */
  function idxOn(dates, d) { let lo = 0, hi = dates.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (dates[m] <= d) { k = m; lo = m + 1; } else hi = m - 1; } return k; }
  /** Return from the close on/before `start` to the close on/before `end`; NaN if the series starts more than 10 days after `start`. */
  function retBetween(ser, start, end) {
    const d = ser?.dates || [], v = vals(ser); if (!d.length) return NaN;
    let i = idxOn(d, start); if (i < 0) { if ((Date.parse(d[0]) - Date.parse(start)) / 864e5 > 10) return NaN; i = 0; }
    const j = idxOn(d, end ?? d[d.length - 1]); if (j < 0 || j <= i) return NaN;
    return v[i] > 0 && v[j] > 0 ? v[j] / v[i] - 1 : NaN;
  }
  const WINDOWS = [["1D", null], ["1W", null], ["1M", 1], ["3M", 3], ["6M", 6], ["YTD", null], ["1Y", 12], ["3Y", 36], ["5Y", 60]];
  /** {window: {ret, ann (3Y/5Y a year), spy, etf, ind, vs_spy, vs_etf, vs_ind}} ending at the stock's last date. */
  function performance(ser, { spy, etf, ind } = {}) {
    const d = ser?.dates || []; if (d.length < 2) return {};
    const end = d[d.length - 1], out = {};
    const startOf = (w, m) => (w === "1D" ? d[d.length - 2] : w === "1W" ? addDays(end, -7) : w === "YTD" ? addDays(end.slice(0, 4) + "-01-01", -1) : addMonths(end, -m));
    for (const [w, m] of WINDOWS) {
      const s = startOf(w, m), r = retBetween(ser, s, end); if (!isNum(r)) continue;
      const o = { ret: r };
      if (m >= 36) o.ann = (1 + r) ** (12 / m) - 1;
      for (const [k, b] of [["spy", spy], ["etf", etf], ["ind", ind]]) { const x = b?.dates?.length ? retBetween(b, s, end) : NaN; if (isNum(x)) { o[k] = x; o["vs_" + k] = r - x; } }
      out[w] = o;
    }
    return out;
  }
  /** Daily returns keyed by date, inside [from, to]. */
  function retMap(ser, from, to) {
    const d = ser?.dates || [], v = vals(ser), m = new Map();
    for (let i = 1; i < d.length; i++) { if (d[i] < from || (to && d[i] > to)) continue; if (v[i - 1] > 0 && v[i] > 0) m.set(d[i], v[i] / v[i - 1] - 1); }
    return m;
  }
  /** Paired daily returns of the stock and a benchmark (common dates), with the daily risk-free rate. */
  function pairs(sm, bm, rfDaily) {
    const x = [], y = [], rf = [], dates = [];
    for (const [dt, a] of sm) { const b = bm.get(dt); if (!isNum(b) || !isNum(a)) continue; x.push(a); y.push(b); rf.push(rfDaily?.get?.(dt) ?? (1.04 ** (1 / TD) - 1)); dates.push(dt); }
    return { x, y, rf, dates };
  }
  function regress(x, y) { // x on y: beta, correlation
    const mx = mean(x), my = mean(y); let c = 0, vx = 0, vy = 0;
    for (let i = 0; i < x.length; i++) { c += (x[i] - mx) * (y[i] - my); vx += (x[i] - mx) ** 2; vy += (y[i] - my) ** 2; }
    return { beta: vy > 0 ? c / vy : NaN, corr: vx > 0 && vy > 0 ? c / Math.sqrt(vx * vy) : NaN };
  }
  /**
   * The risk Greeks over the last `months`: alpha (Jensen, a year), beta, correlation and R² against SPY (and beta and
   * correlation against the sector ETF), volatility, downside volatility, Sharpe, Sortino, Treynor, tracking error,
   * information ratio, up/down capture, max drawdown, 1-day 95% VaR and CVaR, skew and excess kurtosis.
   */
  function riskGreeks(ser, { spy, etf, rfDaily, months = 12 } = {}) {
    const d = ser?.dates || []; if (d.length < 30 || !spy?.dates?.length) return null;
    const end = d[d.length - 1], from = addMonths(end, -months);
    if ((Date.parse(d[0]) - Date.parse(from)) / 864e5 > 20) return null; // not enough history for this window
    const sm = retMap(ser, from), p = pairs(sm, retMap(spy, from), rfDaily);
    if (p.x.length < 40) return null;
    const ex = p.x.map((a, i) => a - p.rf[i]), mx = p.y.map((b, i) => b - p.rf[i]);
    const { beta, corr } = regress(p.x, p.y);
    const alpha = isNum(beta) ? (mean(ex) - beta * mean(mx)) * TD : NaN;
    const vol = std(p.x) * Math.sqrt(TD);
    const dn = Math.sqrt(mean(ex.map((v) => Math.min(v, 0) ** 2))) * Math.sqrt(TD);
    const sharpe = std(ex) > 0 ? (mean(ex) / std(ex)) * Math.sqrt(TD) : NaN;
    const sortino = dn > 0 ? (mean(ex) * TD) / dn : NaN;
    const treynor = isNum(beta) && Math.abs(beta) > 0.05 ? (mean(ex) * TD) / beta : NaN;
    const act = p.x.map((a, i) => a - p.y[i]), te = std(act) * Math.sqrt(TD), ir = te > 0 ? (mean(act) * TD) / te : NaN;
    const up = p.y.map((b, i) => [p.x[i], b]).filter(([, b]) => b > 0), down = p.y.map((b, i) => [p.x[i], b]).filter(([, b]) => b < 0);
    const cap = (s) => (s.length > 10 ? mean(s.map(([a]) => a)) / mean(s.map(([, b]) => b)) : NaN);
    const q05 = quant(p.x, 0.05), tail = p.x.filter((a) => a <= q05);
    const m = mean(p.x), sd = std(p.x);
    const skew = sd > 0 ? mean(p.x.map((a) => ((a - m) / sd) ** 3)) : NaN, kurt = sd > 0 ? mean(p.x.map((a) => ((a - m) / sd) ** 4)) - 3 : NaN;
    const i0 = Math.max(0, d.findIndex((x) => x >= from)), lv = vals(ser).slice(i0);
    let pk = -Infinity, mdd = 0; for (const v of lv) { if (!(v > 0)) continue; pk = Math.max(pk, v); mdd = Math.min(mdd, v / pk - 1); }
    const ann = lv.length > 1 && lv[0] > 0 ? (lv[lv.length - 1] / lv[0]) ** (12 / months) - 1 : NaN;
    let etfBeta = NaN, etfCorr = NaN;
    if (etf?.dates?.length) { const q = pairs(sm, retMap(etf, from), rfDaily); if (q.x.length >= 40) { const g = regress(q.x, q.y); etfBeta = g.beta; etfCorr = g.corr; } }
    return { months, days: p.x.length, alpha, beta, corr, r2: isNum(corr) ? corr * corr : NaN, vol, downside_vol: dn, sharpe, sortino, treynor, tracking_error: te, info_ratio: ir,
      up_capture: cap(up), down_capture: cap(down), max_dd: mdd, var95: isNum(q05) ? -q05 : NaN, cvar95: tail.length ? -mean(tail) : NaN, skew, kurtosis: kurt, ann_return: ann,
      etf_beta: etfBeta, etf_corr: etfCorr, rf: mean(p.rf) * TD };
  }
  /** Beta and correlation to SPY over a rolling `win` trading days, every `step` days: {dates, beta, corr}. */
  function rollingBeta(ser, spy, { win = 63, step = 5, months = 36 } = {}) {
    const d = ser?.dates || []; if (d.length < win + 5 || !spy?.dates?.length) return { dates: [], beta: [], corr: [] };
    const from = addMonths(d[d.length - 1], -months), p = pairs(retMap(ser, from), retMap(spy, from), null);
    const out = { dates: [], beta: [], corr: [] };
    for (let e = win; e <= p.x.length; e += step) { const g = regress(p.x.slice(e - win, e), p.y.slice(e - win, e)); out.dates.push(p.dates[e - 1]); out.beta.push(g.beta); out.corr.push(g.corr); }
    if (out.dates[out.dates.length - 1] !== p.dates[p.dates.length - 1] && p.x.length >= win) { const g = regress(p.x.slice(-win), p.y.slice(-win)); out.dates.push(p.dates[p.dates.length - 1]); out.beta.push(g.beta); out.corr.push(g.corr); }
    return out;
  }
  /** Annualized volatility of the last `days` daily returns. */
  function realizedVol(ser, days = 63) {
    const v = vals(ser), r = []; for (let i = Math.max(1, v.length - days); i < v.length; i++) if (v[i - 1] > 0 && v[i] > 0) r.push(Math.log(v[i] / v[i - 1]));
    return r.length > 10 ? std(r) * Math.sqrt(TD) : NaN;
  }

  // ------------------------------------------------------------------ option Greeks (Black-Scholes-Merton)
  const ncdf = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)), y = 0.3989422804014327 * Math.exp(-x * x / 2) * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))); return x >= 0 ? 1 - y : y; };
  const npdf = (x) => 0.3989422804014327 * Math.exp(-x * x / 2);
  /** One European option: price and the Greeks. theta per calendar day, vega and rho per 1 point (1%). */
  function bsm(S, K, T, r, q, sig, type = "call") {
    if (!(S > 0 && K > 0 && T > 0 && sig > 0)) return null;
    const sq = Math.sqrt(T), d1 = (Math.log(S / K) + (r - q + sig * sig / 2) * T) / (sig * sq), d2 = d1 - sig * sq;
    const dq = Math.exp(-q * T), dr = Math.exp(-r * T), c = type === "call";
    const price = c ? S * dq * ncdf(d1) - K * dr * ncdf(d2) : K * dr * ncdf(-d2) - S * dq * ncdf(-d1);
    const delta = c ? dq * ncdf(d1) : -dq * ncdf(-d1);
    const gamma = (dq * npdf(d1)) / (S * sig * sq);
    const vega = (S * dq * npdf(d1) * sq) / 100;
    const theta = (c ? -(S * dq * npdf(d1) * sig) / (2 * sq) - r * K * dr * ncdf(d2) + q * S * dq * ncdf(d1)
      : -(S * dq * npdf(d1) * sig) / (2 * sq) + r * K * dr * ncdf(-d2) - q * S * dq * ncdf(-d1)) / 365;
    const rho = (c ? K * T * dr * ncdf(d2) : -K * T * dr * ncdf(-d2)) / 100;
    return { price, delta, gamma, theta, vega, rho, d1, d2 };
  }
  /** At-the-money calls and puts at 1, 3, 6 and 12 months, at volatility `sig`, plus the 1-sigma expected move. */
  function optionGreeks(px, sig, r = 0.04, q = 0) {
    if (!(px > 0 && sig > 0)) return [];
    return [[30, "1M"], [91, "3M"], [182, "6M"], [365, "12M"]].map(([days, label]) => {
      const T = days / 365, call = bsm(px, px, T, r, q, sig, "call"), put = bsm(px, px, T, r, q, sig, "put"), mv = px * sig * Math.sqrt(T);
      return { label, days, call, put, move: mv, move_pct: sig * Math.sqrt(T), lo: px - mv, hi: px + mv };
    });
  }

  // ------------------------------------------------------------------ scores against the industry's top 50
  /** 0-100 on a fixed scale. */
  const anch = (v, lo, hi, up = true) => (isNum(v) ? 100 * clamp((v - lo) / (hi - lo), 0, 1) * (up ? 1 : 1) : NaN);
  const anchored = (v, lo, hi, up = true) => { const s = anch(v, lo, hi); return isNum(s) ? (up ? s : 100 - s) : NaN; };
  /**
   * The company's pillar scores, the same pillars the industry is scored on. Metrics are ranked against the industry's
   * top 50 (percentile), the rest on fixed scales; the report-section pillars are the industry's own (they describe the
   * industry the company lives in). Returns {pillars: {key: {score, items}}, profiles: {key: {total, quant, sections}}}.
   * x: {row, cons, quality, greeks (1Y), earn ({beat_rate, surprise_median}), pe_vs_hist, insider, sections (industry pillars), profiles (Score.PROFILES), quantKeys, sectionKeys}
   */
  function scores(x) {
    const row = x.row || {}, peers = (x.cons || []).filter((c) => c.symbol !== row.symbol);
    const P = (k, up, v0) => { const v = isNum(v0) ? v0 : n(row[k]); const a = peers.map((c) => n(c[k])).filter(isNum); if (!isNum(v) || a.length < 8) return NaN;
      const p = (a.filter((y) => y < v).length + a.filter((y) => y === v).length / 2) / a.length; return 100 * (up ? p : 1 - p); };
    const peP = (k) => { const v = n(row[k]); if (isNum(v) && v <= 0) return 0; return P(k, false); };
    const g = x.greeks || {}, q = x.quality || {}, e = x.earn || {};
    const item = (label, value, kind, score) => ({ label, value, kind, score: isNum(score) ? Math.round(score) : null });
    const def = {
      momentum: [item("Return 3M (vs industry)", n(row.ret_3M), "chg", P("ret_3M", true)), item("Return 6M (vs industry)", n(row.ret_6M), "chg", P("ret_6M", true)), item("Return 1Y (vs industry)", n(row.ret_1Y), "chg", P("ret_1Y", true)), item("1Y vs SPY", n(row.excess_1Y), "chg", anchored(n(row.excess_1Y), -0.3, 0.3))],
      growth: [item("Revenue growth (vs industry)", n(row.rev_growth), "chg", P("rev_growth", true)), item("Next-12-month EPS growth (vs industry)", n(row.ntm_growth), "chg", P("ntm_growth", true))],
      profitability: [item("Gross margin", n(row.gross_margin), "pct", P("gross_margin", true)), item("Operating margin", n(row.op_margin), "pct", P("op_margin", true)), item("Net margin", n(row.net_margin), "pct", P("net_margin", true)), item("FCF margin", n(row.fcf_margin), "pct", P("fcf_margin", true)), item("ROIC", n(q.roic), "pct", anchored(n(q.roic), 0, 0.25))],
      valuation: [item("P/E (cheaper = higher)", n(row.pe), "x", peP("pe")), item("Forward P/E", n(row.fwd_pe), "x", peP("fwd_pe")), item("P/S", n(row.ps), "x", P("ps", false)), item("FCF yield", n(q.fcf_yield), "pct", anchored(n(q.fcf_yield), 0, 0.08))],
      earnings: [item("Beat rate (last 8)", n(e.beat_rate), "pct", anchored(n(e.beat_rate), 0.4, 1)), item("Median EPS surprise", n(e.surprise_median), "chg", anchored(n(e.surprise_median), -0.05, 0.1))],
      health: [item("Debt / equity", n(row.de), "x", P("de", false)), item("Net debt / EBITDA", n(row.nd_ebitda ?? q.nd_ebitda), "x", P("nd_ebitda", false, n(q.nd_ebitda))), item("Interest cover", n(row.int_cover ?? q.int_cover), "x", P("int_cover", true, n(q.int_cover))), item("Altman Z", n(q.altman), "x", anchored(n(q.altman), 1.8, 3.5))],
      risk: [item("Volatility 1Y (lower = higher)", n(g.vol ?? row.vol_1y), "pct", P("vol_1y", false, n(g.vol))), item("Max drawdown 1Y", n(g.max_dd ?? row.max_dd_1y), "chg", P("max_dd_1y", true, n(g.max_dd))), item("Beta", n(g.beta ?? row.beta), "x", anchored(n(g.beta ?? row.beta), 0.4, 1.6, false))],
      risk_reward: [item("Sharpe 1Y", n(g.sharpe), "x", anchored(n(g.sharpe), -0.5, 2)), item("Sortino 1Y", n(g.sortino), "x", anchored(n(g.sortino), -0.5, 3)), item("Alpha 1Y", n(g.alpha), "chg", anchored(n(g.alpha), -0.2, 0.2))],
      income: [item("Dividend yield", n(row.div_yield), "pct", anchored(n(row.div_yield), 0, 0.05)), item("Payout ratio (lower = safer)", n(q.payout), "pct", isNum(n(q.payout)) ? (n(q.payout) <= 0 ? null : anchored(n(q.payout), 0.4, 1.0, false)) : NaN)],
      revisions: [item("EPS estimate revisions 30d", n(row.rev30), "chg", P("rev30", true))],
      quality: [item("Piotroski F-score", n(q.piotroski), "n", anchored(n(q.piotroski), 2, 8)), item("Cash conversion", n(q.cash_conversion), "x", anchored(n(q.cash_conversion), 0.6, 1.3)), item("Accruals (lower = cleaner)", n(q.accruals), "chg", anchored(n(q.accruals), -0.05, 0.1, false)), item("Stock comp / revenue", n(q.sbc_rev), "pct", anchored(n(q.sbc_rev), 0, 0.1, false))],
      positioning: [item("Short interest (lower = higher)", n(row.short_pct), "pct", P("short_pct", false)), item("Insider buying", n(x.insider?.purchases), "n", isNum(n(x.insider?.purchases)) ? anchored(n(x.insider.purchases), 0, 4) : NaN), item("13F ownership change", n(row.own_change_pp), "pp", anchored(n(row.own_change_pp), -2, 2))],
      history: [item("P/E vs its own 5-year median", n(x.pe_vs_hist), "chg", anchored(n(x.pe_vs_hist), -0.3, 0.4, false))],
    };
    const pillars = {};
    for (const [k, items] of Object.entries(def)) { const ok = items.filter((i) => isNum(i.score)); if (ok.length) pillars[k] = { score: Math.round(mean(ok.map((i) => i.score)) * 10) / 10, items, from: "company" }; }
    for (const [k, v] of Object.entries(x.sections || {})) if (isNum(v?.score)) pillars[k] = { score: v.score, items: v.items || [], from: "industry" };
    const profiles = {};
    for (const [p, def2] of Object.entries(x.profiles || {})) {
      let w = 0, s = 0, wq = 0, sq = 0, ws = 0, ss = 0;
      for (const [k, wt] of Object.entries(def2.weights)) { const v = pillars[k]?.score; if (!isNum(v)) continue; w += wt; s += wt * v; if ((x.sectionKeys || []).includes(k)) { ws += wt; ss += wt * v; } else { wq += wt; sq += wt * v; } }
      profiles[p] = { total: w ? s / w : NaN, quant: wq ? sq / wq : NaN, sections: ws ? ss / ws : NaN, coverage: w / 100 };
    }
    return { pillars, profiles };
  }

  // ------------------------------------------------------------------ history from the statements
  /** Quarter by quarter (oldest first): revenue, TTM revenue and margins, TTM FCF, EPS (diluted, TTM), shares. */
  function fundHistory(c) {
    const q = [...(c?.q || [])].reverse(), cf = [...(c?.cf || [])].reverse();
    const cfBy = new Map(cf.map((r) => [r.date.slice(0, 7), r]));
    const out = [];
    for (let i = 0; i < q.length; i++) {
      const r = q[i], w = i >= 3 ? q.slice(i - 3, i + 1) : null, sum = (k) => (w ? w.reduce((a, x) => a + n(x[k]), 0) : NaN);
      const rev = sum("rev"), gp = sum("gp"), oi = sum("oi"), ni = sum("ni");
      const fw = w ? w.map((x) => cfBy.get(x.date.slice(0, 7))) : null, fcf = fw && fw.every(Boolean) ? fw.reduce((a, x) => a + n(x.fcf), 0) : NaN;
      out.push({ date: r.date, rev: n(r.rev), rev_ttm: rev, gm: rev > 0 ? gp / rev : NaN, om: rev > 0 ? oi / rev : NaN, nm: rev > 0 ? ni / rev : NaN, fcf_ttm: fcf, ni_ttm: ni, sh: n(r.sh), eps_ttm: n(r.sh) > 0 ? ni / n(r.sh) : NaN,
        yoy: i >= 4 && n(q[i - 4].rev) > 0 ? n(r.rev) / n(q[i - 4].rev) - 1 : NaN });
    }
    return out;
  }
  /** Trailing P/E at each quarter end (market cap ÷ TTM net income), oldest first, with today's; median and where today sits. */
  function peHistory(c, nowPE) {
    const fh = fundHistory(c), byM = new Map(fh.map((r) => [r.date.slice(0, 7), r]));
    const pts = [...(c?.km || [])].reverse().map((k) => { const f = byM.get(k.date.slice(0, 7)); return f && f.ni_ttm > 0 && k.mcap > 0 ? { date: k.date, pe: k.mcap / f.ni_ttm } : null; }).filter((x) => x && x.pe < 400);
    const med = median(pts.map((p) => p.pe)), now = n(nowPE);
    const pctl = isNum(now) && pts.length >= 4 ? pts.filter((p) => p.pe < now).length / pts.length : NaN;
    return { pts, median: med, now, vs_median: isNum(now) && med > 0 && now > 0 ? now / med - 1 : NaN, percentile: pctl };
  }
  /** Reported quarters (newest first) with surprises; the next scheduled report; beat rate and median surprise over the last 8. */
  function earningsHistory(c, today) {
    const rows = (c?.earn || []).map((r) => ({ ...r, ea: n(r.ea), ee: n(r.ee), ra: n(r.ra), re: n(r.re) }));
    const past = rows.filter((r) => r.date <= today && isNum(r.ea)).slice(0, 12).map((r) => ({ ...r, eps_surprise: isNum(r.ee) && r.ee !== 0 ? (r.ea - r.ee) / Math.abs(r.ee) : NaN, rev_surprise: isNum(r.re) && r.re > 0 && isNum(r.ra) ? r.ra / r.re - 1 : NaN, beat: isNum(r.ee) ? r.ea >= r.ee : null }));
    const next = rows.filter((r) => r.date > today).sort((a, b) => (a.date < b.date ? -1 : 1))[0] || null;
    const last8 = past.slice(0, 8).filter((r) => r.beat !== null);
    return { past, next, beat_rate: last8.length ? last8.filter((r) => r.beat).length / last8.length : NaN, surprise_median: median(past.slice(0, 8).map((r) => r.eps_surprise)), rev_surprise_median: median(past.slice(0, 8).map((r) => r.rev_surprise)) };
  }
  /** Price levels: 50/200-day averages, 52-week range and where the price sits in it, distance from the high. */
  function levels(ser) {
    const v = vals(ser), d = ser?.dates || []; if (v.length < 20) return null;
    const px = v[v.length - 1], avg = (k) => (v.length >= k ? mean(v.slice(-k)) : NaN);
    const from = addMonths(d[d.length - 1], -12), yr = v.slice(Math.max(0, d.findIndex((x) => x >= from)));
    const hi = Math.max(...yr), lo = Math.min(...yr);
    return { px, ma50: avg(50), ma200: avg(200), hi52: hi, lo52: lo, in_range: hi > lo ? (px - lo) / (hi - lo) : NaN, off_high: px / hi - 1, vs_ma50: px / avg(50) - 1, vs_ma200: px / avg(200) - 1 };
  }

  const CoFacts = { performance, riskGreeks, rollingBeta, realizedVol, bsm, optionGreeks, scores, fundHistory, peHistory, earningsHistory, levels, retBetween, WINDOWS };
  if (typeof module !== "undefined" && module.exports) module.exports = CoFacts;
  else root.CoFacts = CoFacts;
})(typeof window !== "undefined" ? window : globalThis);
