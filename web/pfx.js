/**
 * The portfolio dashboard's analytics (code only, no Claude). The page's PMode builds the portfolio's value over time
 * (nav); this module reads deeper into it and into each holding's prices:
 *   align(series, tickers, { from, calendar })   daily returns of every holding on the same days
 *   correlations(A, tickers)                     how each pair of holdings moves together
 *   riskContrib(A, weights)                      each holding's share of the portfolio's swings (from the covariances)
 *   drawdowns(nav, k)                            the deepest falls: start, bottom, recovery, depth and length
 *   underwater(nav)                              % below the last high, every day
 *   calendar(nav, spyNav)                        month-by-month returns, each year's total against the S&P 500
 *   dayStats(nav)                                best and worst day and month, share of up days and months, streaks
 *   rolling(nav, spyNav, win)                    rolling return, volatility and beta
 *   episodes(series, weights, spy, betas)        what past crises and rallies did to today's mix
 *   projection(mu, sigma, v0)                    the range of outcomes 1-10 years out (lognormal)
 *   overlap(funds)                               how much each pair of funds holds in common
 *   industries(lookRows, cos)                    the money in each industry, through the funds
 *   read(...)                                    a plain-English summary of all of it
 * Series are { dates, closes } (dates ascending). nav is { dates, values }. Returns are decimals (0.05 = 5%).
 */
(function (root) {
  "use strict";
  const isNum = (x) => typeof x === "number" && isFinite(x);
  const n = (x) => (x === null || x === undefined || x === "" ? NaN : Number(x));
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
  const sd = (a) => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); };
  const r4 = (x) => (isNum(x) ? Math.round(x * 1e4) / 1e4 : null);
  const mapOf = (s) => { const m = new Map(); (s?.dates || []).forEach((d, i) => { const v = s.closes?.[i] ?? s.values?.[i]; if (v > 0) m.set(d, v); }); return m; };

  /** Daily returns of each holding on the same days (the calendar, or the days every one of them traded). */
  function align(series, tickers, { from = null, calendar = null } = {}) {
    const maps = {}; for (const t of tickers) { const m = mapOf(series[t]); if (m.size > 20) maps[t] = m; }
    const ts = tickers.filter((t) => maps[t]);
    const days = (calendar || [...new Set(ts.flatMap((t) => [...maps[t].keys()]))].sort()).filter((d) => !from || d >= from);
    const R = Object.fromEntries(ts.map((t) => [t, []])), dates = [], prev = {};
    for (const d of days) {
      if (!ts.every((t) => maps[t].has(d))) continue;
      if (ts.every((t) => prev[t] > 0)) { dates.push(d); for (const t of ts) R[t].push(maps[t].get(d) / prev[t] - 1); }
      for (const t of ts) prev[t] = maps[t].get(d);
    }
    return { dates, R, tickers: ts, missing: tickers.filter((t) => !maps[t]) };
  }
  function covOf(a, b) { const ma = mean(a), mb = mean(b); let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - ma) * (b[i] - mb); return s / Math.max(1, a.length - 1); }
  /** Pearson correlation of daily returns for every pair: { tickers, m: [[...]] }. */
  function correlations(A) {
    const ts = A.tickers, sds = ts.map((t) => sd(A.R[t]));
    const m = ts.map((a, i) => ts.map((b, j) => (i === j ? 1 : sds[i] > 0 && sds[j] > 0 ? r4(covOf(A.R[a], A.R[b]) / (sds[i] * sds[j])) : null)));
    let s = 0, k = 0; for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) if (isNum(m[i][j])) { s += m[i][j]; k++; }
    return { tickers: ts, m, avg: k ? r4(s / k) : null, days: A.dates.length };
  }
  /**
   * Each holding's share of the portfolio's day-to-day swings: w_i (Σw)_i / wΣw, from the daily covariances. A holding
   * can carry more risk than its weight (it swings more, or with everything else) or less. Also the portfolio's
   * volatility, and the diversification ratio (the holdings' own volatilities, weighted, over the portfolio's: above 1
   * means owning them together swings less than owning each alone).
   */
  function riskContrib(A, weights) {
    const ts = A.tickers.filter((t) => n(weights[t]) > 0); if (!ts.length || A.dates.length < 20) return null;
    const tot = ts.reduce((s, t) => s + n(weights[t]), 0), w = ts.map((t) => n(weights[t]) / tot);
    const C = ts.map((a) => ts.map((b) => covOf(A.R[a], A.R[b])));
    const Cw = C.map((row) => row.reduce((s, c, j) => s + c * w[j], 0)), varP = w.reduce((s, wi, i) => s + wi * Cw[i], 0);
    if (!(varP > 0)) return null;
    const vols = ts.map((t, i) => Math.sqrt(C[i][i] * 252)), volP = Math.sqrt(varP * 252);
    const rows = ts.map((t, i) => ({ ticker: t, weight: r4(w[i]), vol: r4(vols[i]), share: r4((w[i] * Cw[i]) / varP), beta_p: r4(Cw[i] / varP) }));
    return { vol: r4(volP), divRatio: r4(w.reduce((s, wi, i) => s + wi * vols[i], 0) / volP), rows: rows.sort((a, b) => b.share - a.share), days: A.dates.length };
  }
  /** % below the last high, every day. */
  function underwater(nav) { let hi = -Infinity; return (nav?.values || []).map((v) => { hi = Math.max(hi, v); return hi > 0 ? v / hi - 1 : 0; }); }
  /** The k deepest falls from a high: start (the high), bottom, recovery (back to the high; null if not yet), depth, days. */
  function drawdowns(nav, k = 5) {
    const d = nav?.dates || [], v = nav?.values || [], out = []; if (d.length < 3) return out;
    let hiI = 0, lowI = 0, inDD = false;
    const close = (recI) => { out.push({ start: d[hiI], bottom: d[lowI], end: recI === null ? null : d[recI], depth: r4(v[lowI] / v[hiI] - 1), fall_days: lowI - hiI, recover_days: recI === null ? null : recI - lowI }); };
    for (let i = 1; i < d.length; i++) {
      if (v[i] >= v[hiI]) { if (inDD) close(i); inDD = false; hiI = i; lowI = i; continue; }
      inDD = true; if (v[i] < v[lowI]) lowI = i;
    }
    if (inDD) close(null);
    return out.filter((x) => x.depth < -0.005).sort((a, b) => a.depth - b.depth).slice(0, k);
  }
  /** Month-end values: [[YYYY-MM, value]]. */
  function monthEnds(nav) { const out = []; (nav?.dates || []).forEach((d, i) => { const m = d.slice(0, 7); if (out.length && out[out.length - 1][0] === m) out[out.length - 1][1] = nav.values[i]; else out.push([m, nav.values[i]]); }); return out; }
  /** Returns month by month, a row per year, with the year's total and the S&P 500's. The first month counts from the first day. */
  function calendar(nav, spyNav) {
    const me = monthEnds(nav); if (me.length < 2) return null;
    const first = nav.values[0], rets = {};
    me.forEach(([m, v], i) => { const prev = i ? me[i - 1][1] : first; if (prev > 0) rets[m] = v / prev - 1; });
    const spyMe = spyNav ? monthEnds(spyNav) : [], spyAt = Object.fromEntries(spyMe);
    const years = [...new Set(me.map(([m]) => m.slice(0, 4)))].map((y) => {
      const months = Array.from({ length: 12 }, (_, k) => { const key = `${y}-${String(k + 1).padStart(2, "0")}`; return key in rets ? r4(rets[key]) : null; });
      const tot = months.filter(isNum).reduce((p, r) => p * (1 + r), 1) - 1;
      const sMs = spyMe.filter(([m]) => m.startsWith(y)), sPrev = spyMe.filter(([m]) => m < y + "-01").slice(-1)[0];
      const sStart = sPrev ? sPrev[1] : spyNav?.values?.[0], sEnd = sMs.length ? sMs[sMs.length - 1][1] : null;
      return { year: y, months, total: r4(tot), spy: sStart > 0 && sEnd > 0 ? r4(sEnd / sStart - 1) : null, partial: months.filter(isNum).length < 12 };
    });
    const all = Object.entries(rets).map(([m, r]) => ({ m, r }));
    return { years, best: all.reduce((a, x) => (!a || x.r > a.r ? x : a), null), worst: all.reduce((a, x) => (!a || x.r < a.r ? x : a), null), up: r4(all.filter((x) => x.r > 0).length / all.length), n: all.length };
  }
  /** Best and worst day, share of up days, and the longest run of up and down days. */
  function dayStats(nav) {
    const d = nav?.dates || [], v = nav?.values || []; if (d.length < 3) return null;
    let best = null, worst = null, up = 0, k = 0, run = 0, upRun = 0, dnRun = 0;
    for (let i = 1; i < d.length; i++) { const r = v[i] / v[i - 1] - 1; k++; if (r > 0) up++;
      if (!best || r > best.r) best = { date: d[i], r: r4(r) }; if (!worst || r < worst.r) worst = { date: d[i], r: r4(r) };
      run = r > 0 ? (run > 0 ? run + 1 : 1) : r < 0 ? (run < 0 ? run - 1 : -1) : 0; upRun = Math.max(upRun, run); dnRun = Math.max(dnRun, -run); }
    const daily = []; for (let i = 1; i < v.length; i++) daily.push(v[i] / v[i - 1] - 1);
    const sorted = daily.slice().sort((a, b) => a - b), q = (p) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(p * sorted.length)))];
    const cvar = (p) => { const cut = sorted.slice(0, Math.max(1, Math.floor(p * sorted.length))); return mean(cut); };
    return { best, worst, up: r4(up / k), days: k, upRun, dnRun, var95: r4(q(0.05)), var99: r4(q(0.01)), cvar95: r4(cvar(0.05)), cvar99: r4(cvar(0.01)) };
  }
  /** Rolling return, volatility (annualized) and beta to the S&P 500 over `win` trading days. */
  function rolling(nav, spyNav, win = 126) {
    const d = nav?.dates || [], v = nav?.values || []; if (d.length <= win + 2) return null;
    const sm = mapOf({ dates: spyNav?.dates || [], values: spyNav?.values || [] });
    const r = [], s = []; for (let i = 1; i < d.length; i++) { r.push(v[i] / v[i - 1] - 1); const a = sm.get(d[i]), b = sm.get(d[i - 1]); s.push(a > 0 && b > 0 ? a / b - 1 : NaN); }
    const dates = [], ret = [], vol = [], beta = [], spy = [];
    for (let i = win; i < d.length; i++) {
      const rr = r.slice(i - win, i), ss = s.slice(i - win, i), ok = ss.every(isNum);
      dates.push(d[i]); ret.push(r4(v[i] / v[i - win] - 1)); vol.push(r4(sd(rr) * Math.sqrt(252)));
      const sv = ok ? covOf(ss, ss) : NaN; beta.push(ok && sv > 0 ? r4(covOf(rr, ss) / sv) : null);
      const a = sm.get(d[i]), b = sm.get(d[i - win]); spy.push(a > 0 && b > 0 ? r4(a / b - 1) : null);
    }
    return { dates, ret, vol, beta, spy, win };
  }
  /** Past crises and rallies the S&P 500 went through, for the stress test. */
  const EPISODES = [
    ["The 2008 financial crisis", "2007-10-09", "2009-03-09", "stress"], ["The 2009 rebound", "2009-03-09", "2010-04-23", "boom"], ["The 2011 debt-ceiling scare", "2011-04-29", "2011-10-03", "stress"],
    ["The 2015-16 slowdown", "2015-05-21", "2016-02-11", "stress"], ["The 2018 fourth-quarter sell-off", "2018-09-20", "2018-12-24", "stress"], ["The 2020 COVID crash", "2020-02-19", "2020-03-23", "stress"],
    ["The 2020 recovery", "2020-03-23", "2020-08-31", "boom"], ["The 2022 bear market", "2022-01-03", "2022-10-12", "stress"], ["The 2023 rally", "2022-10-12", "2023-07-31", "boom"],
    ["The 2023 rate scare", "2023-07-31", "2023-10-27", "stress"], ["The 2024 summer wobble", "2024-07-16", "2024-08-05", "stress"], ["The 2025 tariff shock", "2025-02-19", "2025-04-08", "stress"], ["The 2025 rebound", "2025-04-08", "2025-07-31", "boom"],
  ];
  function priceAt(m, d, before = true) { let best = null; for (const [k, v] of m) { if (before ? k <= d : k >= d) { if (!best || (before ? k > best[0] : k < best[0])) best = [k, v]; } } return best; }
  /**
   * What each episode did to today's mix: each holding's own move where it traded through it, else its beta times the
   * S&P 500's move (marked as estimated). covered = the share of the weight that traded.
   */
  function episodes(series, weights, spy, betas = {}, list = EPISODES) {
    const sm = mapOf(spy), tot = Object.values(weights).reduce((s, x) => s + (n(x) || 0), 0) || 1, maps = {};
    for (const t of Object.keys(weights)) maps[t] = mapOf(series[t]);
    const out = [];
    for (const [label, a, b, kind] of list) {
      const s0 = priceAt(sm, a), s1 = priceAt(sm, b); if (!s0 || !s1 || Math.abs(Date.parse(s0[0]) - Date.parse(a)) > 7 * 864e5) continue;
      const spyR = s1[1] / s0[1] - 1; let port = 0, cov = 0; const rows = [];
      for (const [t, w0] of Object.entries(weights)) { const w = (n(w0) || 0) / tot; if (!(w > 0)) continue; const m = maps[t];
        const p0 = m.size ? priceAt(m, a) : null, p1 = m.size ? priceAt(m, b) : null, real = p0 && p1 && Math.abs(Date.parse(p0[0]) - Date.parse(a)) <= 7 * 864e5;
        const r = real ? p1[1] / p0[1] - 1 : (isNum(n(betas[t])) ? n(betas[t]) : 1) * spyR; port += w * r; if (real) cov += w; rows.push({ ticker: t, r: r4(r), est: !real }); }
      out.push({ label, from: a, to: b, kind, port: r4(port), spy: r4(spyR), covered: r4(cov), capture: spyR ? r4(port / spyR) : null, rows: rows.sort((x, y) => x.r - y.r) });
    }
    return out;
  }
  const Z = { 5: -1.6449, 10: -1.2816, 25: -0.6745, 50: 0, 75: 0.6745, 90: 1.2816, 95: 1.6449 };
  function phi(x) { const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989423 * Math.exp(-x * x / 2), p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; }
  /**
   * The range of outcomes if the next years look like its history: yearly return mu and volatility sigma (decimals), a
   * lognormal spread around the median. rows: 1, 3, 5, 10 years with the 10th, 50th and 90th percentile values and the
   * chance of being below where it started; path: month by month for 10 years (for a fan chart).
   */
  function projection(mu, sigma, v0, years = [1, 3, 5, 10]) {
    if (!isNum(mu) || !isNum(sigma) || !(sigma > 0) || !(v0 > 0) || mu <= -1) return null;
    const m = Math.log(1 + mu) - (0 * sigma * sigma) / 2;
    const at = (T, z) => v0 * Math.exp(m * T + z * sigma * Math.sqrt(T));
    const rows = years.map((T) => ({ years: T, p10: Math.round(at(T, Z[10])), p25: Math.round(at(T, Z[25])), p50: Math.round(at(T, 0)), p75: Math.round(at(T, Z[75])), p90: Math.round(at(T, Z[90])), loss: r4(phi(-(m * Math.sqrt(T)) / sigma)) }));
    const path = Array.from({ length: 121 }, (_, k) => { const T = k / 12; return { k, p10: at(T, Z[10]), p25: at(T, Z[25]), p50: at(T, 0), p75: at(T, Z[75]), p90: at(T, Z[90]) }; });
    return { rows, path, mu, sigma };
  }
  /** How much each pair of funds holds in common: the sum, over shared stocks, of the smaller of their two weights. */
  function overlap(funds) {
    const ks = Object.keys(funds).filter((k) => (funds[k] || []).length), w = {};
    for (const k of ks) { const m = new Map(); for (const h of funds[k]) { const t = String(h.ticker || h.name || "").toUpperCase(); const x = n(h.weight); if (t && x > 0) m.set(t, (m.get(t) || 0) + x); } w[k] = m; }
    const pairs = [];
    for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) { let s = 0, c = 0; for (const [t, a] of w[ks[i]]) { const b = w[ks[j]].get(t); if (b) { s += Math.min(a, b); c++; } } pairs.push({ a: ks[i], b: ks[j], overlap: r4(s), shared: c }); }
    return pairs.sort((x, y) => y.overlap - x.overlap);
  }
  /** The money in each industry, through the funds: look-through rows (ticker, total) placed with the company index. */
  function industries(lookRows, cos) {
    const by = {}; let placed = 0, all = 0;
    for (const r of lookRows || []) { const w = n(r.total); if (!(w > 0)) continue; all += w; const c = cos?.[r.ticker]; if (!c?.industry) continue; placed += w;
      const x = by[c.industry] || (by[c.industry] = { industry: c.industry, sector: c.sector || "", weight: 0, names: [] }); x.weight += w; x.names.push({ ticker: r.ticker, w }); }
    const rows = Object.values(by).map((x) => ({ ...x, weight: r4(x.weight), names: x.names.sort((a, b) => b.w - a.w).slice(0, 5) })).sort((a, b) => b.weight - a.weight);
    return { rows, placed: r4(placed), all: r4(all) };
  }
  /** Sector tilt against the S&P 500: [{ sector, port, spy, diff }] (weights as fractions). */
  function tilt(port, spy) {
    const ks = [...new Set([...Object.keys(port || {}), ...Object.keys(spy || {})])];
    return ks.map((k) => ({ sector: k, port: r4(n(port?.[k]) || 0), spy: r4(n(spy?.[k]) || 0) })).map((x) => ({ ...x, diff: r4(x.port - x.spy) })).sort((a, b) => b.port - a.port || b.spy - a.spy);
  }
  /** The industries' 12-month calls, weighted by the money in each: share up / flat / down and the weighted expected move. */
  function callMix(indRows, digests) {
    let up = 0, dn = 0, flat = 0, cov = 0, exp = 0, expW = 0;
    for (const r of indRows) { const dg = digests?.[String(r.industry).toLowerCase()]; const c = dg?.lean?.["12M"] || dg?.calls?.["12M"]?.call; if (!c) continue; const w = r.weight; cov += w;
      if (/up|bull|rise|higher|outperform/i.test(c)) up += w; else if (/down|bear|fall|lower|under/i.test(c)) dn += w; else flat += w;
      const e = n(dg?.expected12 ?? dg?.calls?.["12M"]?.mid); if (isNum(e)) { exp += w * e; expW += w; } }
    return cov ? { up: r4(up / cov), down: r4(dn / cov), flat: r4(flat / cov), covered: r4(cov), expected: expW ? r4(exp / expW) : null } : null;
  }
  const pc = (x, d = 1) => (isNum(x) ? `${(x * 100).toFixed(d)}%` : "n/a");
  const sp = (x, d = 1) => (isNum(x) ? `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x * 100).toFixed(d)}%` : "n/a");
  /** A plain-English read of the dashboard (**bold** marks emphasis). */
  function read({ name = "The portfolio", period = "1Y", m = null, ms = null, rc = null, tiltRows = null, look = null, income = null, fees = null, mix = null, dd = null, corr = null } = {}) {
    const out = [];
    if (m && isNum(m.totalReturn)) {
      const diff = ms && isNum(ms.totalReturn) ? m.totalReturn - ms.totalReturn : null;
      out.push(`Over ${period === "1Y" ? "the last year" : `the last ${period}`} ${name} returned **${sp(m.totalReturn)}**${isNum(diff) ? `, ${Math.abs(diff) < 0.005 ? "level with" : `**${(Math.abs(diff) * 100).toFixed(1)} points ${diff > 0 ? "ahead of" : "behind"}**`} the S&P 500 (${sp(ms.totalReturn)})` : ""}.`);
      if (isNum(m.volatility)) out.push(`It swung about **${m.volatility.toFixed(0)}% a year**${ms && isNum(ms.volatility) ? ` against ${ms.volatility.toFixed(0)}% for the S&P 500` : ""}, with a worst fall of ${isNum(m.maxDrawdown) ? `**−${m.maxDrawdown.toFixed(1)}%**` : "n/a"}${isNum(m.sharpeRatio) ? `; return per unit of risk (Sharpe) was ${m.sharpeRatio.toFixed(2)}${ms && isNum(ms.sharpeRatio) ? ` (S&P ${ms.sharpeRatio.toFixed(2)})` : ""}` : ""}.`);
    }
    if (rc?.rows?.length) { const t = rc.rows[0]; out.push(`**${t.ticker}** drives the most risk: ${pc(t.share, 0)} of the swings for ${pc(t.weight, 0)} of the money${rc.rows.length > 1 && isNum(rc.divRatio) ? `. Owning the holdings together cuts the swings by ${Math.max(0, Math.round((1 - 1 / rc.divRatio) * 100))}% against owning each alone` : ""}.`); }
    if (corr && isNum(corr.avg) && corr.tickers.length > 2) out.push(`The holdings move together ${corr.avg > 0.75 ? "*very closely*" : corr.avg > 0.5 ? "*closely*" : corr.avg > 0.25 ? "*somewhat*" : "*little*"} (average correlation ${corr.avg.toFixed(2)})${corr.avg > 0.75 ? ", so they add less diversification than their number suggests" : ""}.`);
    if (tiltRows?.length) { const over = tiltRows.filter((x) => x.diff > 0.03).sort((a, b) => b.diff - a.diff), under = tiltRows.filter((x) => x.diff < -0.03).sort((a, b) => a.diff - b.diff);
      if (over.length || under.length) out.push(`Against the S&P 500 it leans ${over.length ? `**into ${over.slice(0, 2).map((x) => `${x.sector} (${pc(x.port, 0)} vs ${pc(x.spy, 0)})`).join(" and ")}**` : ""}${over.length && under.length ? " and " : ""}${under.length ? `away from ${under.slice(0, 2).map((x) => `${x.sector} (${pc(x.port, 0)} vs ${pc(x.spy, 0)})`).join(" and ")}` : ""}.`); }
    if (look?.rows?.length) { const t = look.rows[0]; if (t.total > 0.05) out.push(`Its biggest single company, counting what the funds hold, is **${t.ticker} at ${pc(t.total)}**${t.direct > 0 && t.viaFunds > 0 ? " (held directly and through funds)" : ""}.`); }
    if (mix) out.push(`Of the money in industries with a 12-month call, **${pc(mix.up, 0)} is in industries we expect to rise** and ${pc(mix.down, 0)} in ones we expect to fall${isNum(mix.expected) ? `; the weighted expectation is ${sp(mix.expected)}` : ""}.`);
    if (dd?.length && dd[0].end === null) out.push(`It's still ${pc(-dd[0].depth)} below its high of ${dd[0].start}.`);
    if (isNum(income?.total) && income.total > 0) out.push(`It pays about **$${Math.round(income.total).toLocaleString("en-US")} a year** in dividends (${pc(income.yield, 2)})${isNum(fees?.total) && fees.total > 0 ? ` and costs about $${Math.round(fees.total).toLocaleString("en-US")} a year in fund fees (${pc(fees.ratio, 2)} on average)` : ""}.`);
    return out;
  }

  const PfX = { align, correlations, riskContrib, underwater, drawdowns, monthEnds, calendar, dayStats, rolling, EPISODES, episodes, projection, overlap, industries, tilt, callMix, read, phi };
  if (typeof module !== "undefined" && module.exports) module.exports = PfX;
  else root.PfX = PfX;
})(typeof window !== "undefined" ? window : globalThis);
