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


  // ------------------------------------------------------------------ stress and boom tests
  const EPISODES = [
    { key: "gfc", label: "2008 Global Financial Crisis", kind: "stress", from: "2008-09-01", to: "2009-03-09" },
    { key: "trade", label: "2018 Trade War Escalation", kind: "stress", from: "2018-10-03", to: "2018-12-24" },
    { key: "covid", label: "2020 COVID Crash", kind: "stress", from: "2020-02-19", to: "2020-03-23" },
    { key: "infl", label: "2022 Tech / Inflation Selloff", kind: "stress", from: "2022-01-03", to: "2022-10-12" },
    { key: "stim", label: "2020–2021 Stimulus Rally", kind: "boom", from: "2020-03-23", to: "2021-12-31" },
    { key: "ai", label: "2023–2024 Generative AI Expansion", kind: "boom", from: "2023-01-03", to: "2024-12-31" },
  ];
  /** Worst peak-to-trough fall inside [from, to]. */
  function ddIn(ser, from, to) { const d = ser?.dates || [], v = vals(ser); let pk = -Infinity, m = 0, any = false; for (let i = 0; i < d.length; i++) { if (d[i] < from || d[i] > to || !(v[i] > 0)) continue; any = true; pk = Math.max(pk, v[i]); m = Math.min(m, v[i] / pk - 1); } return any ? m : NaN; }
  /** How the stock did in each historical crisis and boom; before it traded, beta × SPY's move (marked estimated). */
  function episodes(ser, spy, beta) {
    const d0 = ser?.dates?.[0];
    return EPISODES.map((e) => {
      const sp = retBetween(spy, e.from, e.to), spDD = ddIn(spy, e.from, e.to);
      const covered = d0 && (Date.parse(d0) - Date.parse(e.from)) / 864e5 <= 7;
      const st = covered ? retBetween(ser, e.from, e.to) : NaN, stDD = covered ? ddIn(ser, e.from, e.to) : NaN;
      const est = !covered && isNum(beta) && isNum(sp) ? beta * sp : NaN;
      const r = isNum(st) ? st : est;
      return { ...e, spy: sp, spy_dd: spDD, ret: isNum(r) ? r : null, dd: isNum(stDD) ? stDD : isNum(est) && isNum(spDD) ? beta * spDD : null, estimated: !isNum(st) && isNum(est), vs_spy: isNum(r) && isNum(sp) ? r - sp : null, capture: isNum(r) && isNum(sp) && sp !== 0 ? r / sp : null };
    });
  }
  /** Beta from monthly returns over the last `months` (the usual "5Y monthly" beta). */
  function monthlyBeta(ser, spy, months = 60) {
    const me = (s) => { const d = s?.dates || [], v = vals(s), m = new Map(); for (let i = 0; i < d.length; i++) if (v[i] > 0) m.set(d[i].slice(0, 7), v[i]); return m; };
    const a = me(ser), b = me(spy), keys = [...a.keys()].filter((k) => b.has(k)).sort().slice(-(months + 1));
    const x = [], y = []; for (let i = 1; i < keys.length; i++) { x.push(a.get(keys[i]) / a.get(keys[i - 1]) - 1); y.push(b.get(keys[i]) / b.get(keys[i - 1]) - 1); }
    return x.length >= 24 ? regress(x, y).beta : NaN;
  }

  // ------------------------------------------------------------------ technicals
  /** Daily closes resampled to weekly (last close of each week) or monthly. */
  function resample(ser, tf) {
    if (tf === "D") return { dates: [...(ser?.dates || [])], closes: [...vals(ser)] };
    const d = ser?.dates || [], v = vals(ser), out = { dates: [], closes: [] };
    const key = (s) => { if (tf === "M") return s.slice(0, 7); const t = new Date(s + "T00:00:00Z"), wd = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - wd); return t.toISOString().slice(0, 10); };
    for (let i = 0; i < d.length; i++) { const k = key(d[i]); if (out.dates.length && key(out.dates[out.dates.length - 1]) === k) { out.dates[out.dates.length - 1] = d[i]; out.closes[out.closes.length - 1] = v[i]; } else { out.dates.push(d[i]); out.closes.push(v[i]); } }
    return out;
  }
  const sma = (v, n) => v.map((_, i) => (i + 1 >= n ? v.slice(i + 1 - n, i + 1).reduce((a, x) => a + x, 0) / n : NaN));
  const ema = (v, n) => { const k = 2 / (n + 1), o = []; let e = NaN; v.forEach((x, i) => { e = i === 0 ? x : x * k + e * (1 - k); o.push(i + 1 >= n ? e : NaN); }); return o; };
  function rsi(v, n = 14) { const o = v.map(() => NaN); let g = 0, l = 0; for (let i = 1; i < v.length; i++) { const ch = v[i] - v[i - 1], up = Math.max(ch, 0), dn = Math.max(-ch, 0);
      if (i <= n) { g += up / n; l += dn / n; if (i === n) o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } } return o; }
  /** SMA 20/50/200, RSI 14, MACD (12, 26, 9) and Bollinger Bands (20, 2σ) on daily, weekly or monthly bars; the last `show` bars, plus the latest readings and what they say. */
  function technicals(ser, tf = "D", show = null) {
    const r = resample(ser, tf), c = r.closes; if (c.length < 30) return null;
    const s20 = sma(c, 20), s50 = sma(c, 50), s200 = sma(c, 200), R = rsi(c, 14), e12 = ema(c, 12), e26 = ema(c, 26);
    const macd = c.map((_, i) => e12[i] - e26[i]), sigRaw = ema(macd.map((x) => (isNum(x) ? x : 0)), 9), signal = macd.map((x, i) => (isNum(x) && i >= 33 ? sigRaw[i] : NaN)), hist = macd.map((x, i) => x - signal[i]);
    const sd20 = c.map((_, i) => (i + 1 >= 20 ? std(c.slice(i + 1 - 20, i + 1)) : NaN)), bbU = s20.map((m, i) => m + 2 * sd20[i]), bbL = s20.map((m, i) => m - 2 * sd20[i]);
    const n = show || { D: 260, W: 156, M: 120 }[tf] || 260, k = Math.max(0, c.length - n), cut = (a) => a.slice(k);
    const L = c.length - 1, last = { close: c[L], sma20: s20[L], sma50: s50[L], sma200: s200[L], rsi: R[L], macd: macd[L], signal: signal[L], hist: hist[L], bbU: bbU[L], bbL: bbL[L], pctB: bbU[L] > bbL[L] ? (c[L] - bbL[L]) / (bbU[L] - bbL[L]) : NaN };
    const sig = [];
    if (isNum(last.sma200)) sig.push(c[L] > last.sma200 ? { t: "above the 200-period average", s: 1 } : { t: "below the 200-period average", s: -1 });
    if (isNum(last.sma50) && isNum(last.sma200)) { const prev = s50[L - 5] - s200[L - 5], now = last.sma50 - last.sma200; sig.push(now > 0 ? { t: prev <= 0 ? "golden cross (50 crossed above 200)" : "50 above 200 (uptrend)", s: 1 } : { t: prev >= 0 ? "death cross (50 crossed below 200)" : "50 below 200 (downtrend)", s: -1 }); }
    if (isNum(last.rsi)) sig.push(last.rsi >= 70 ? { t: `RSI ${last.rsi.toFixed(0)}: overbought`, s: -1 } : last.rsi <= 30 ? { t: `RSI ${last.rsi.toFixed(0)}: oversold`, s: 1 } : { t: `RSI ${last.rsi.toFixed(0)}: neutral`, s: 0 });
    if (isNum(last.hist)) sig.push(last.hist > 0 ? { t: "MACD above its signal (momentum up)", s: 1 } : { t: "MACD below its signal (momentum down)", s: -1 });
    if (isNum(last.pctB)) sig.push(last.pctB > 1 ? { t: "above the upper Bollinger band (stretched)", s: -1 } : last.pctB < 0 ? { t: "below the lower Bollinger band (washed out)", s: 1 } : { t: `inside the Bollinger bands (${(last.pctB * 100).toFixed(0)}% of the way up)`, s: 0 });
    return { tf, dates: cut(r.dates), close: cut(c), sma20: cut(s20), sma50: cut(s50), sma200: cut(s200), rsi: cut(R), macd: cut(macd), signal: cut(signal), hist: cut(hist), bbU: cut(bbU), bbL: cut(bbL), last, signals: sig, score: sig.reduce((a, x) => a + x.s, 0) };
  }
  /**
   * Today's 30-day price path against every 30-day path in the reference histories (the stock's own and SPY's):
   * z-normalized Euclidean distance, the closest K non-overlapping matches, and what happened over the next 30 days.
   */
  function patternMatch(refs, { win = 30, fwd = 30, k = 25 } = {}) {
    const self = refs[0]?.ser; const v0 = vals(self); if (v0.length < win + fwd + 60) return null;
    const z = (a) => { const m = mean(a), s = std(a) || 1; return a.map((x) => (x - m) / s); };
    const path = (v, i) => { const b = v[i - win]; return b > 0 ? v.slice(i - win, i + 1).map((x) => x / b - 1) : null; };
    const q = z(path(v0, v0.length - 1));
    const cands = [];
    for (const { name, ser } of refs) { const v = vals(ser), d = ser.dates, lim = name === refs[0].name ? v.length - 1 - win - fwd : v.length - 1 - fwd;
      for (let i = win; i <= lim; i += 2) { const p = path(v, i); if (!p || p.some((x) => !isNum(x))) continue; const zp = z(p); let dist = 0; for (let j = 0; j < zp.length; j++) dist += (zp[j] - q[j]) ** 2;
        const f = v[i + fwd] / v[i] - 1; if (isNum(f)) cands.push({ name, i, date: d[i], dist: Math.sqrt(dist / zp.length), fwd: f }); } }
    cands.sort((a, b) => a.dist - b.dist);
    const picked = [];
    for (const c of cands) { if (picked.length >= k) break; if (picked.some((p) => p.name === c.name && Math.abs(p.i - c.i) < win)) continue; picked.push(c); }
    if (!picked.length) return null;
    const f = picked.map((p) => p.fwd), base = []; for (let i = 0; i + fwd < v0.length; i += 5) base.push(v0[i + fwd] / v0[i] - 1);
    return { win, fwd, n: picked.length, win_rate: f.filter((x) => x > 0).length / f.length, median: median(f), mean: mean(f), best: Math.max(...f), worst: Math.min(...f),
      base_win_rate: base.length ? base.filter((x) => x > 0).length / base.length : NaN, base_median: median(base), matches: picked.slice(0, 10).map(({ name, date, dist, fwd: x }) => ({ name, date, dist, fwd: x })), query: path(v0, v0.length - 1) };
  }

  // ------------------------------------------------------------------ dividends, DCF, DuPont, valuation bands, earnings reactions
  /**
   * divs: FMP dividend rows (date = ex-date, recordDate, paymentDate, declarationDate, dividend/adjDividend, frequency).
   * x: {px, payout (earnings payout ratio), fcf_payout (dividends ÷ FCF), today}. Returns yield, 5Y CAGR, growth streak, a 0-100 safety score and the calendar.
   */
  function dividends(divs, x = {}) {
    const rows = (divs || []).map((r) => ({ ex: String(r.date || "").slice(0, 10), record: r.recordDate || "", pay: r.paymentDate || "", declared: r.declarationDate || "", amt: n(r.adjDividend ?? r.dividend), freq: r.frequency || "" })).filter((r) => r.ex && isNum(r.amt) && r.amt > 0).sort((a, b) => (a.ex < b.ex ? 1 : -1));
    if (!rows.length) return { paying: false };
    const today = x.today || new Date().toISOString().slice(0, 10), past = rows.filter((r) => r.ex <= today);
    const per = { Quarterly: 4, Monthly: 12, "Semi-Annual": 2, Annual: 1, Semiannual: 2 }[rows[0].freq] || 4;
    const annual = past.slice(0, per).reduce((a, r) => a + r.amt, 0) || rows.slice(0, per).reduce((a, r) => a + r.amt, 0);
    const byY = {}; for (const r of past) byY[r.ex.slice(0, 4)] = (byY[r.ex.slice(0, 4)] || 0) + r.amt;
    const cy = Number(today.slice(0, 4)), full = Object.keys(byY).map(Number).filter((y) => y < cy).sort((a, b) => b - a);
    let streak = 0; for (let i = 0; i + 1 < full.length; i++) { if (byY[full[i]] > byY[full[i + 1]] * 1.0001) streak++; else break; }
    const y0 = full[0], cagr5 = y0 && byY[y0 - 5] > 0 ? (byY[y0] / byY[y0 - 5]) ** (1 / 5) - 1 : NaN;
    const cut5 = full.slice(0, 6).some((y, i, a) => i + 1 < a.length && byY[y] < byY[a[i + 1]] * 0.97);
    const items = []; let s = 70; const add = (pts, t) => { s += pts; items.push({ pts, t }); };
    const pr = n(x.payout), fp = n(x.fcf_payout);
    if (isNum(pr) && pr > 0) { if (pr < 0.5) add(15, `payout ${(pr * 100).toFixed(0)}% of earnings, comfortably covered`); else if (pr <= 0.75) add(5, `payout ${(pr * 100).toFixed(0)}% of earnings`); else if (pr <= 1) add(-15, `payout ${(pr * 100).toFixed(0)}% of earnings, above 75%`); else add(-35, `payout ${(pr * 100).toFixed(0)}% of earnings, more than it earns`); }
    if (isNum(fp) && fp > 0) { if (fp > 1) add(-20, `dividends are ${(fp * 100).toFixed(0)}% of free cash flow`); else if (fp < 0.7) add(5, `free cash flow covers the dividend ${(1 / fp).toFixed(1)}×`); }
    if (streak >= 25) add(15, `${streak} straight years of increases`); else if (streak >= 10) add(10, `${streak} straight years of increases`); else if (streak >= 5) add(5, `${streak} straight years of increases`);
    if (cut5) add(-20, "cut in the last five years");
    const px = n(x.px);
    return { paying: true, annual, yield: px > 0 ? annual / px : NaN, freq: rows[0].freq, cagr5, streak, cut5, safety: Math.max(0, Math.min(100, Math.round(s))), safety_items: items,
      next: rows.filter((r) => r.ex > today).pop() || null, recent: rows.slice(0, 10), by_year: full.slice(0, 10).reverse().map((y) => ({ year: y, total: byY[y] })) };
  }
  /** A simple DCF: revenue grows at g for 5 years at a steady FCF margin, then a Gordon terminal value; equity value per share. */
  function dcf({ rev, margin, g, tg = 0.025, wacc = 0.09, shares, netDebt = 0 }) {
    if (!(rev > 0) || !isNum(margin) || !(shares > 0) || !(wacc > tg)) return null;
    let pv = 0, r = rev, f = 0; const years = [];
    for (let t = 1; t <= 5; t++) { r *= 1 + g; f = r * margin; const d = f / (1 + wacc) ** t; pv += d; years.push({ t, rev: r, fcf: f, pv: d }); }
    const tv = (f * (1 + tg)) / (wacc - tg), pvTv = tv / (1 + wacc) ** 5, ev = pv + pvTv, eq = ev - (isNum(netDebt) ? netDebt : 0);
    return { ev, equity: eq, per_share: eq / shares, pv_fcf: pv, pv_tv: pvTv, tv_share: pvTv / ev, years };
  }
  /** DuPont: ROE = net margin × asset turnover × leverage, per fiscal year (average assets and equity where two years exist). */
  function dupont(inc, bs) {
    const B = new Map((bs || []).map((b) => [String(b.date).slice(0, 4), b]));
    return (inc || []).map((r) => { const y = String(r.date).slice(0, 4), b = B.get(y), bp = B.get(String(Number(y) - 1));
      const ta = b ? (bp ? (n(b.totalAssets) + n(bp.totalAssets)) / 2 : n(b.totalAssets)) : NaN, eq = b ? (bp ? (n(b.totalStockholdersEquity) + n(bp.totalStockholdersEquity)) / 2 : n(b.totalStockholdersEquity)) : NaN;
      const nm = n(r.revenue) > 0 ? n(r.netIncome) / n(r.revenue) : NaN, at = ta > 0 ? n(r.revenue) / ta : NaN, lev = eq > 0 ? ta / eq : NaN;
      return { year: y, net_margin: nm, asset_turnover: at, leverage: lev, roe: nm * at * lev }; }).filter((x) => isNum(x.roe)).sort((a, b) => (a.year < b.year ? -1 : 1));
  }
  /** The P/E history as a band: mean ± 1 standard deviation, where today sits, and rich / fair / cheap (above the 80th percentile / below the 30th). */
  function valuationBand(pts, now) {
    const v = (pts || []).map((p) => p.pe).filter(isNum); if (v.length < 6) return null;
    const m = mean(v), s = std(v), pc = isNum(now) ? v.filter((x) => x < now).length / v.length : NaN;
    return { mean: m, sd: s, hi: m + s, lo: m - s, percentile: pc, z: isNum(now) && s > 0 ? (now - m) / s : NaN, verdict: !isNum(pc) ? "" : pc > 0.8 ? "rich" : pc < 0.3 ? "cheap" : "fair" };
  }
  /** The stock's move around each report: the close before the report date to the close the day after (and SPY over the same days). */
  function earningsReactions(past, ser, spy) {
    const d = ser?.dates || [], v = vals(ser);
    return (past || []).map((r) => { const i = idxOn(d, addDays(r.date, -1)); let j = d.findIndex((x) => x > r.date); if (i < 0 || j < 0) return { ...r, move: null };
      const mv = v[j] / v[i] - 1, sp = spy ? retBetween(spy, d[i], d[j]) : NaN; return { ...r, move: mv, vs_spy: isNum(sp) ? mv - sp : null }; });
  }

  const CoFacts = { EPISODES, episodes, monthlyBeta, resample, technicals, patternMatch, dividends, dcf, dupont, valuationBand, earningsReactions, performance, riskGreeks, rollingBeta, realizedVol, bsm, optionGreeks, scores, fundHistory, peHistory, earningsHistory, levels, retBetween, WINDOWS };
  if (typeof module !== "undefined" && module.exports) module.exports = CoFacts;
  else root.CoFacts = CoFacts;
})(typeof window !== "undefined" ? window : globalThis);
