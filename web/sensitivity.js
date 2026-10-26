/* Industry Scorer: Measured macro sensitivities.
 *
 * How the industry has actually moved with the market, interest rates, oil, the dollar and credit, measured
 * from daily data over the last year rather than asserted:
 *   - market: SPY daily return
 *   - rates:  change in the 10-year Treasury yield (percentage points)
 *   - oil:    USO daily return (crude oil)
 *   - dollar: UUP daily return (US dollar index)
 *   - credit: HYG daily return (high-yield bonds; a fall means credit spreads widening)
 * For each factor: the TOTAL sensitivity (simple regression: everything that moves with the factor, including
 * the market) and the PARTIAL one (multiple regression on all five: the effect beyond the others), with
 * t-statistics, and whether the sign held in both halves of the year. Effects are scaled to a typical shock
 * (+25bp, +10% oil, +5% dollar, -2% high yield, +1% market) so they read as "the industry moves X%".
 * Pure functions, no I/O.
 */
(function (root) {
  "use strict";
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const FACTORS = [
    { key: "market", label: "Stock market (SPY)", kind: "ret", shock: 0.01, shock_label: "+1% S&P 500" },
    { key: "rates", label: "10-year Treasury yield", kind: "diff", shock: 0.25, shock_label: "+0.25pp 10-year yield" },
    { key: "oil", label: "Oil (USO)", kind: "ret", shock: 0.10, shock_label: "+10% oil" },
    { key: "dollar", label: "US dollar (UUP)", kind: "ret", shock: 0.05, shock_label: "+5% dollar" },
    { key: "credit", label: "High-yield bonds (HYG)", kind: "ret", shock: -0.02, shock_label: "-2% high-yield bonds (spreads widen)" },
  ];

  /** Align series on common dates. series: {key: {dates, values}}; returns {dates, cols: {key: values}}. */
  function align(series) {
    const keys = Object.keys(series);
    const maps = Object.fromEntries(keys.map((k) => [k, new Map((series[k].dates || []).map((d, i) => [d, series[k].values[i]]))]));
    const dates = (series[keys[0]].dates || []).filter((d) => keys.every((k) => isNum(maps[k].get(d))));
    return { dates, cols: Object.fromEntries(keys.map((k) => [k, dates.map((d) => maps[k].get(d))])) };
  }
  const changes = (v, kind) => v.slice(1).map((x, i) => (kind === "diff" ? x - v[i] : v[i] > 0 ? x / v[i] - 1 : NaN));

  /** OLS with intercept. X: array of columns. Returns {b (without intercept), se, t, r2, n}. */
  function ols(y, X) {
    const n = y.length, k = X.length + 1;
    if (n < k + 10) return null;
    const row = (i) => [1, ...X.map((c) => c[i])];
    const XtX = Array.from({ length: k }, () => new Array(k).fill(0)), Xty = new Array(k).fill(0);
    for (let i = 0; i < n; i++) { const r = row(i); for (let a = 0; a < k; a++) { Xty[a] += r[a] * y[i]; for (let b = 0; b < k; b++) XtX[a][b] += r[a] * r[b]; } }
    const inv = invert(XtX); if (!inv) return null;
    const beta = inv.map((r) => r.reduce((s, v, j) => s + v * Xty[j], 0));
    let sse = 0, sst = 0; const my = y.reduce((s, v) => s + v, 0) / n;
    for (let i = 0; i < n; i++) { const r = row(i); const f = r.reduce((s, v, j) => s + v * beta[j], 0); sse += (y[i] - f) ** 2; sst += (y[i] - my) ** 2; }
    const s2 = sse / (n - k);
    const se = inv.map((r, j) => Math.sqrt(Math.max(0, s2 * r[j])));
    return { b: beta.slice(1), se: se.slice(1), t: beta.slice(1).map((b, j) => (se[j + 1] > 0 ? b / se[j + 1] : NaN)), r2: sst > 0 ? 1 - sse / sst : NaN, n };
  }
  function invert(M) {
    const k = M.length, A = M.map((r, i) => [...r, ...Array.from({ length: k }, (_, j) => (i === j ? 1 : 0))]);
    for (let c = 0; c < k; c++) {
      let p = c; for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      if (Math.abs(A[p][c]) < 1e-14) return null;
      [A[c], A[p]] = [A[p], A[c]];
      const d = A[c][c]; for (let j = 0; j < 2 * k; j++) A[c][j] /= d;
      for (let r = 0; r < k; r++) if (r !== c) { const f = A[r][c]; if (f) for (let j = 0; j < 2 * k; j++) A[r][j] -= f * A[c][j]; }
    }
    return A.map((r) => r.slice(k));
  }

  /**
   * index: {dates, levels} (the industry); factors: {market:{dates,values}, rates:{...}, oil, dollar, credit}.
   * Returns {n, from, to, r2, factors: [{key, label, shock_label, total:{beta,t,effect}, partial:{beta,t,effect}, stable, corr}]}.
   */
  function measure(index, factors, { days = 252 } = {}) {
    let avail = FACTORS.filter((f) => factors?.[f.key]?.dates?.length);
    if (!index?.dates?.length || !avail.length) return null;
    const al = align({ ind: { dates: index.dates, values: index.levels }, ...Object.fromEntries(avail.map((f) => [f.key, factors[f.key]])) });
    if (al.dates.length < 60) return null;
    const start = Math.max(0, al.dates.length - days - 1);
    const y0 = changes(al.cols.ind.slice(start), "ret");
    const X0 = avail.map((f) => changes(al.cols[f.key].slice(start), f.kind));
    // Drop days where any change is missing
    const keep = y0.map((v, i) => isNum(v) && X0.every((c) => isNum(c[i])));
    const y1 = y0.filter((_, i) => keep[i]), X1 = X0.map((c) => c.filter((_, i) => keep[i]));
    // A factor that never moved (a flat or stale series) can't be measured; leave it out.
    const sd = (a) => { const m = a.reduce((s, v) => s + v, 0) / (a.length || 1); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, a.length - 1)); };
    const live = avail.map((f, j) => sd(X1[j]) > 1e-9);
    const y = y1, X = X1.filter((_, j) => live[j]);
    avail = avail.filter((_, j) => live[j]);
    if (!avail.length) return null;
    const multi = ols(y, X);
    const half = Math.floor(y.length / 2);
    const out = { n: y.length, from: al.dates[start], to: al.dates[al.dates.length - 1], r2: multi?.r2 ?? NaN, factors: [] };
    avail.forEach((f, j) => {
      const s = ols(y, [X[j]]), a = ols(y.slice(0, half), [X[j].slice(0, half)]), b = ols(y.slice(half), [X[j].slice(half)]);
      const corr = s ? Math.sign(s.b[0]) * Math.sqrt(Math.max(0, s.r2)) : NaN;
      const eff = (beta) => (isNum(beta) ? beta * f.shock : NaN);
      out.factors.push({ key: f.key, label: f.label, shock_label: f.shock_label,
        total: s ? { beta: s.b[0], t: s.t[0], effect: eff(s.b[0]) } : null,
        partial: multi ? { beta: multi.b[j], t: multi.t[j], effect: eff(multi.b[j]) } : null,
        halves: a && b ? [eff(a.b[0]), eff(b.b[0])] : null,
        stable: a && b ? Math.sign(a.b[0]) === Math.sign(b.b[0]) : null, corr });
    });
    return out;
  }
  /** Plain-language strength of an estimate from its t-statistic. */
  const strength = (t) => (!isNum(t) ? "n/a" : Math.abs(t) >= 3 ? "strong" : Math.abs(t) >= 2 ? "clear" : Math.abs(t) >= 1.3 ? "weak" : "not significant");
  /** One line per factor for the strategist's prompts. */
  function digest(sens) {
    if (!sens?.factors?.length) return "";
    const p = (x) => (isNum(x) ? `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%` : "n/a");
    return `MEASURED SENSITIVITIES (code: daily data ${sens.from} to ${sens.to}, ${sens.n} days; all five factors explain ${isNum(sens.r2) ? Math.round(sens.r2 * 100) : "n/a"}% of daily moves)\n` +
      sens.factors.map((f) => `- ${f.shock_label}: industry ${p(f.total?.effect)} in total (${strength(f.total?.t)}), ${p(f.partial?.effect)} beyond the other factors (${strength(f.partial?.t)})${f.stable === false ? "; sign flipped between the two halves of the year, so treat as unstable" : ""}.`).join("\n") +
      "\nUse these to size what decisions and shocks do to prices (e.g. a Fed surprise that moves the 10-year 25bp, an oil spike from a war), instead of guessing.";
  }

  const Sensitivity = { FACTORS, align, ols, invert, measure, strength, digest };
  if (typeof module !== "undefined" && module.exports) module.exports = Sensitivity;
  else root.Sensitivity = Sensitivity;
})(typeof window !== "undefined" ? window : globalThis);
