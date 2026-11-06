/* Industry Scorer: the statistical anchor for every 1M-12M call.
 *
 * A plain, tested forecast of how an industry will do against the S&P 500 (and in absolute terms) over 1, 3, 6 and
 * 12 months, from what has predicted industry returns across every US industry since 2008:
 *   - m12: the industry's return vs the S&P 500 over the last 12 months, skipping the latest month (momentum);
 *   - m1:  the latest month vs the S&P 500 (short-term reversal);
 *   - m3:  the last 3 months vs the S&P 500;
 *   - pe:  its P/E against its own 5-year median (log ratio; cheap vs expensive).
 * The model is fitted once on all industries pooled (runner/fit-anchor.mjs, a GitHub job, refitted monthly) with
 * every forward return measured against the average industry that month (FMP's long industry series are equal-weighted
 * and rebalanced daily, which drifts away from the S&P 500 for reasons that have nothing to do with the industry, so
 * only the difference between industries is learned) and in units of the industry's own volatility vs the market, so
 * one set of weights fits quiet and wild industries alike. The industry's expected return vs the S&P 500 is that
 * difference; its absolute expected return adds the market's expected return (the risk-free rate plus the equity
 * risk premium, passed in at prediction time) and its range comes from its own volatility. It is tested out of sample (fitted on the years before, tested on the next
 * year, walking forward), and those test results travel with the model: how often it got the direction vs the
 * S&P 500 right, and how well the predicted order of industries matched what happened.
 *
 * The strategist starts every call from this anchor and may move away from it only with stated evidence; code keeps
 * the ranges honest (the anchor's likely range is what the test years actually saw).
 * Pure functions, no I/O.
 */
(function (root) {
  "use strict";
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const H = { "1M": 1, "3M": 3, "6M": 6, "12M": 12 };
  const FEATS = ["m12", "m1", "m3", "pe"];
  const LABEL = { m12: "12-month momentum vs the S&P 500", m1: "last month vs the S&P 500", m3: "3-month trend vs the S&P 500", pe: "P/E vs its 5-year median" };
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const median = (a) => { const s = a.filter(isNum).sort((x, y) => x - y); if (!s.length) return NaN; const m = (s.length - 1) / 2; return (s[Math.floor(m)] + s[Math.ceil(m)]) / 2; };
  const sd = (a) => { const b = a.filter(isNum); if (b.length < 2) return NaN; const m = b.reduce((s, x) => s + x, 0) / b.length; return Math.sqrt(b.reduce((s, x) => s + (x - m) ** 2, 0) / (b.length - 1)); };
  // Normal CDF (Abramowitz-Stegun).
  const Phi = (z) => { const t = 1 / (1 + 0.2316419 * Math.abs(z)); const d = 0.3989423 * Math.exp(-z * z / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; };

  /** Daily {dates, levels|closes} -> month-end {months: ["2008-01", ...], lv: [...]}. */
  function monthly(ser) {
    const ds = ser?.dates || [], v = ser?.levels || ser?.closes || ser?.pe || ser?.values || [];
    const months = [], lv = [];
    for (let i = 0; i < ds.length; i++) {
      if (!isNum(v[i]) || !(v[i] > 0)) continue;
      const m = String(ds[i]).slice(0, 7);
      if (months[months.length - 1] === m) lv[lv.length - 1] = v[i]; else { months.push(m); lv.push(v[i]); }
    }
    return { months, lv };
  }
  /** Align month-end series by month. Returns {months, ind, spy, pe} (pe may hold NaN). */
  function align(ind, spy, pe) {
    const I = monthly(ind), S = monthly(spy), P = pe ? monthly(pe) : { months: [], lv: [] };
    const sm = new Map(S.months.map((m, i) => [m, S.lv[i]])), pm = new Map(P.months.map((m, i) => [m, P.lv[i]]));
    const months = [], a = [], b = [], c = [];
    for (let i = 0; i < I.months.length; i++) { const m = I.months[i]; if (!sm.has(m)) continue; months.push(m); a.push(I.lv[i]); b.push(sm.get(m)); c.push(pm.has(m) ? pm.get(m) : NaN); }
    return { months, ind: a, spy: b, pe: c };
  }
  const lr = (x, i, k) => (i - k >= 0 && x[i] > 0 && x[i - k] > 0 ? Math.log(x[i] / x[i - k]) : NaN);

  /**
   * One row per month: the features known at that month's end, the scale (the industry's volatility vs the market,
   * annualized, from the last 24 months), and the forward returns (log) vs the S&P 500 and absolute per horizon.
   */
  function rows(A) {
    const out = [], n = A.months.length;
    const rel1 = A.ind.map((_, i) => lr(A.ind, i, 1) - lr(A.spy, i, 1));
    for (let i = 13; i < n; i++) {
      const m12 = (lr(A.ind, i - 1, 11) - lr(A.spy, i - 1, 11)), m1 = rel1[i], m3 = lr(A.ind, i, 3) - lr(A.spy, i, 3);
      const peHist = A.pe.slice(Math.max(0, i - 60), i + 1).filter((x) => isNum(x) && x > 0);
      const pe = isNum(A.pe[i]) && A.pe[i] > 0 && peHist.length >= 24 ? clamp(Math.log(A.pe[i] / median(peHist)), -1, 1) : 0;
      const rv = sd(rel1.slice(Math.max(1, i - 23), i + 1)); if (!isNum(rv) || rv <= 0) continue;
      const scale = clamp(rv * Math.sqrt(12), 0.04, 1.2);
      const r = { month: A.months[i], m12, m1, m3, pe, scale, abs_scale: clamp(sd(A.ind.map((_, j) => lr(A.ind, j, 1)).slice(Math.max(1, i - 23), i + 1)) * Math.sqrt(12), 0.05, 1.5), fwd: {}, fwd_abs: {} };
      if (![m12, m1, m3].every(isNum)) continue;
      for (const [h, k] of Object.entries(H)) { if (i + k < n) { r.fwd[h] = (lr(A.ind, i + k, k) - lr(A.spy, i + k, k)); r.fwd_abs[h] = lr(A.ind, i + k, k); } }
      out.push(r);
    }
    return out;
  }
  /** The features as model inputs: each in units of the industry's own volatility vs the market (pe as is). */
  const x = (r) => [r.m12 / r.scale, r.m1 / (r.scale / Math.sqrt(12)), r.m3 / (r.scale / 2), r.pe];

  /** Ridge regression (standardized inputs, intercept unpenalized). Returns {w, mu, sdv, b0, resid}. */
  function ridge(X, y, lambda = 50) {
    const p = X[0].length, n = X.length;
    const mu = Array.from({ length: p }, (_, j) => X.reduce((a, r) => a + r[j], 0) / n);
    const sdv = Array.from({ length: p }, (_, j) => Math.sqrt(X.reduce((a, r) => a + (r[j] - mu[j]) ** 2, 0) / n) || 1);
    const Z = X.map((r) => r.map((v, j) => (v - mu[j]) / sdv[j])), ym = y.reduce((a, v) => a + v, 0) / n;
    const M = Array.from({ length: p }, (_, i) => Array.from({ length: p + 1 }, (_, j) => (j === p ? Z.reduce((a, r, k) => a + r[i] * (y[k] - ym), 0) : Z.reduce((a, r) => a + r[i] * r[j], 0) + (i === j ? lambda : 0))));
    for (let c = 0; c < p; c++) { let piv = c; for (let r = c + 1; r < p; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r; [M[c], M[piv]] = [M[piv], M[c]];
      for (let r = 0; r < p; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= p; k++) M[r][k] -= f * M[c][k]; } }
    const w = M.map((r, i) => r[p] / r[i]);
    const pred = Z.map((r) => ym + r.reduce((a, v, j) => a + v * w[j], 0));
    const resid = sd(y.map((v, k) => v - pred[k]));
    return { w, mu, sdv, b0: ym, resid };
  }
  const apply1 = (m, xi) => m.b0 + xi.reduce((a, v, j) => a + ((v - m.mu[j]) / m.sdv[j]) * m.w[j], 0);


  /**
   * Fit on every industry's rows. data: [{industry, rows}]. Months used for horizon h are spaced h months apart per
   * industry (no overlapping windows). Walk-forward test: for each year from `testFrom`, fit on months that ended
   * before the year began (minus the horizon) and test on that year. Returns the model with its test results.
   */
  function fit(data, { lambda = 50, testFrom = 2013, asOf = null } = {}) {
    const model = { v: 1, demeaned: true, fitted_at: asOf, features: FEATS, horizons: {}, industries: data.length };
    for (const h of Object.keys(H)) {
      const k = H[h], all = [];
      // The average industry's forward return each month (raw log returns vs the S&P 500), taken out of every target.
      const avg = new Map(); for (const d of data) for (const r of d.rows) if (isNum(r.fwd[h])) { const a = avg.get(r.month) || avg.set(r.month, [0, 0]).get(r.month); a[0] += r.fwd[h]; a[1]++; }
      for (const d of data) for (let i = 0; i < d.rows.length; i += Math.min(k, 3)) { const r = d.rows[i], a = avg.get(r.month); if (!a || a[1] < 10) continue;
        const s = r.scale * Math.sqrt(k / 12), y = isNum(r.fwd[h]) && s > 0 ? clamp((r.fwd[h] - a[0] / a[1]) / s, -4, 4) : NaN; if (isNum(y)) all.push({ ind: d.industry, month: r.month, x: x(r), y, r }); }
      if (all.length < 200) continue;
      const m = ridge(all.map((a) => a.x), all.map((a) => a.y), lambda);
      // Walk forward.
      const test = { n: 0, hits: 0, inband: 0, ics: [], base_hits: 0, spread: [] };
      const years = [...new Set(all.map((a) => Number(a.month.slice(0, 4))))].filter((y) => y >= testFrom).sort();
      for (const Y of years) {
        const cut = `${Y - Math.ceil(k / 12)}-${String(((12 - (k % 12)) % 12) + 1).padStart(2, "0")}`;
        const tr = all.filter((a) => a.month < cut), te = all.filter((a) => a.month.startsWith(String(Y)));
        if (tr.length < 200 || !te.length) continue;
        const mm = ridge(tr.map((a) => a.x), tr.map((a) => a.y), lambda);
        const byMonth = new Map();
        for (const a of te) { const p = apply1(mm, a.x); test.n++; if (Math.sign(p) === Math.sign(a.y) && a.y !== 0) test.hits++; if (Math.abs(a.y - p) <= 0.674 * mm.resid) test.inband++;
          if (a.y !== 0 && (a.y > 0) === (mm.b0 > 0)) test.base_hits++; (byMonth.get(a.month) || byMonth.set(a.month, []).get(a.month)).push([p, a.y]); }
        // Cross-section each month: rank correlation, and the top fifth minus the bottom fifth (in vol units).
        for (const xs of byMonth.values()) { if (xs.length < 15) continue;
          const rk = (v) => { const o = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]); const r = Array(v.length); o.forEach(([, i], j) => (r[i] = j)); return r; };
          const a = rk(xs.map((t) => t[0])), b = rk(xs.map((t) => t[1])), N = xs.length; let s = 0; for (let i = 0; i < N; i++) s += (a[i] - b[i]) ** 2;
          test.ics.push(1 - (6 * s) / (N * (N * N - 1)));
          const o = xs.slice().sort((u, v) => v[0] - u[0]), q = Math.max(3, Math.floor(N / 5));
          test.spread.push(o.slice(0, q).reduce((t, u) => t + u[1], 0) / q - o.slice(-q).reduce((t, u) => t + u[1], 0) / q); }
      }
      const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
      model.horizons[h] = { rel: m, n: all.length,
        test: { n: test.n, hit_rate: test.n ? Math.round((test.hits / test.n) * 1000) / 10 : null, base_hit_rate: test.n ? Math.round((test.base_hits / test.n) * 1000) / 10 : null,
          in_likely_range: test.n ? Math.round((test.inband / test.n) * 1000) / 10 : null, rank_ic: Math.round(mean(test.ics) * 1000) / 1000, months: test.ics.length,
          top_minus_bottom: Math.round(mean(test.spread) * 1000) / 1000, from: testFrom } };
    }
    return model;
  }

  /**
   * Today's anchor for one industry. A: align() of its own long series; model: the fitted model. Returns per horizon
   * {rel: {median, p25, p75, prob_beat}, abs: {median, p25, p75, prob_up}, drivers: [{feature, label, value, push}]} in %,
   * or null when there isn't enough history.
   */
  function predict(model, A, { market = 0.07 } = {}) {
    if (!model?.horizons || !A?.months?.length) return null;
    const R = rows({ ...A, months: [...A.months, "9999-99"], ind: [...A.ind, NaN], spy: [...A.spy, NaN], pe: [...A.pe, NaN] }).filter((r) => r.month === A.months[A.months.length - 1]);
    const r = R[0]; if (!r) return null;
    const xi = x(r), out = { as_of: r.month, features: { m12: r.m12, m1: r.m1, m3: r.m3, pe: r.pe }, scale: r.scale, horizons: {} };
    const pct = (v) => Math.round((Math.exp(v) - 1) * 1000) / 10;
    for (const [h, k] of Object.entries(H)) {
      const M = model.horizons[h]; if (!M) continue;
      const s = r.scale * Math.sqrt(k / 12), sa = r.abs_scale * Math.sqrt(k / 12);
      // A model fitted before targets were taken against the average industry: drop its intercept (that drift).
      const zr = apply1(M.rel, xi) - (model.demeaned ? 0 : M.rel.b0), mk = Math.log(1 + market) * (k / 12), za = (zr * s + mk) / sa, residA = Math.sqrt((M.rel.resid * s) ** 2 + (sa ** 2 - s ** 2 > 0 ? sa ** 2 - s ** 2 : 0)) / sa;
      const drivers = FEATS.map((f, j) => ({ feature: f, label: LABEL[f], value: Math.round((f === "pe" ? r.pe : r[f]) * 1000) / 10, push: Math.round(((xi[j] - M.rel.mu[j]) / M.rel.sdv[j]) * M.rel.w[j] * s * 1000) / 10 }))
        .sort((a, b) => Math.abs(b.push) - Math.abs(a.push));
      out.horizons[h] = {
        rel: { median: pct(zr * s), p25: pct((zr - 0.674 * M.rel.resid) * s), p75: pct((zr + 0.674 * M.rel.resid) * s), prob_beat: Math.round(Phi(zr / M.rel.resid) * 100) },
        abs: { median: pct(za * sa), p25: pct((za - 0.674 * residA) * sa), p75: pct((za + 0.674 * residA) * sa), prob_up: Math.round(Phi(za / residA) * 100) }, market: Math.round((Math.exp(mk) - 1) * 1000) / 10,
        rel_sigma: Math.round(s * 1000) / 10, drivers, test: M.test };
    }
    return out;
  }

  /** One line per horizon for the prompts. */
  function text(an) {
    if (!an?.horizons) return "";
    return Object.entries(an.horizons).map(([h, a]) => `${h}: vs the S&P 500 median ${a.rel.median > 0 ? "+" : ""}${a.rel.median}% (likely ${a.rel.p25}% to ${a.rel.p75}%), ${a.rel.prob_beat}% chance of beating it; absolute median ${a.abs.median > 0 ? "+" : ""}${a.abs.median}% (likely ${a.abs.p25}% to ${a.abs.p75}%), ${a.abs.prob_up}% chance of a gain; what moves it: ${a.drivers.slice(0, 3).map((d) => `${d.label} ${d.push > 0 ? "+" : ""}${d.push} pts`).join(", ")}${a.test?.hit_rate ? `; tested out of sample since ${a.test.from}: right on which side of the average industry it lands ${a.test.hit_rate}% of the time (a coin flip is 50%), rank correlation with what happened ${a.test.rank_ic}, ${a.test.in_likely_range}% of outcomes inside its likely range` : ""}`).join("\n");
  }

  const Anchor = { H, FEATS, LABEL, monthly, align, rows, ridge, fit, predict, text, Phi };
  if (typeof module !== "undefined" && module.exports) module.exports = Anchor;
  else root.Anchor = Anchor;
})(typeof window !== "undefined" ? window : globalThis);
