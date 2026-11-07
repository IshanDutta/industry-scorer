/* Industry Scorer: "times like this" for one company. For each of the industry's closest past setups: the period,
 * what was going on (the industry historian's words), a chart of the company against its industry and the S&P 500
 * (each rebased to 100 at the setup, from 3 months before to 12 months after), what each did next, and the gap.
 * Pure functions, no I/O.
 */
(function (root) {
  "use strict";
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const HZ = { "1M": 21, "3M": 63, "6M": 126, "12M": 252 };
  const BEFORE = 63, AFTER = 252;
  const r1 = (x) => (isNum(x) ? Math.round(x * 10) / 10 : null);
  /** First index with a date on or after d (binary search; -1 if none). */
  function at(dates, d) { let lo = 0, hi = dates.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (dates[m] >= d) { k = m; hi = m - 1; } else lo = m + 1; } return k; }
  /** Value on a date, carried forward from the last earlier trading day (null before the series starts). */
  function valueOn(s, d) { const k = at(s.dates, d); if (k === 0 && s.dates[0] > d) return null; const i = k < 0 ? s.dates.length - 1 : s.dates[k] === d ? k : k - 1; return i >= 0 ? s.values[i] : null; }
  const addMonths = (d, n) => { const t = new Date(d + "T00:00:00Z"); t.setUTCMonth(t.getUTCMonth() + n); return t.toISOString().slice(0, 10); };
  const label = (d) => new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

  /** % change over n trading days from index i (null if the series doesn't reach). */
  const ret = (s, i, n) => (i >= 0 && i + n < s.values.length && s.values[i] > 0 ? r1((s.values[i + n] / s.values[i] - 1) * 100) : null);
  function maxDD(s, i, n) {
    if (i < 0 || i >= s.values.length) return null;
    let pk = s.values[i], dd = 0; for (let k = i; k <= Math.min(s.values.length - 1, i + n); k++) { pk = Math.max(pk, s.values[k]); dd = Math.min(dd, s.values[k] / pk - 1); }
    return r1(dd * 100);
  }

  /**
   * One card per episode. episodes: the industry's (history.times.episodes: {date, month, similarity, alike, unlike,
   * industry, spy}); hist: the historian's episodes ({month, then, after, different}); co/ind/spy: {dates, values}
   * daily (the company, the industry's long history, SPY); today.
   */
  function build({ episodes = [], hist = [], co, ind, spy, today = "" }) {
    const H = Object.fromEntries((hist || []).map((e) => [e.month, e]));
    const out = [];
    for (const e of episodes || []) {
      const d = e.date || (e.month ? e.month + "-28" : null); if (!d || !spy?.dates?.length) continue;
      const iS = at(spy.dates, d); if (iS < 0) continue;
      // The chart's days: SPY's trading days from 3 months before to 12 months after (or today).
      const a = Math.max(0, iS - BEFORE), b = Math.min(spy.dates.length - 1, iS + AFTER);
      const days = spy.dates.slice(a, b + 1), k0 = iS - a;
      const line = (s) => { if (!s?.dates?.length) return null; const v0 = valueOn(s, spy.dates[iS]); if (!(v0 > 0)) return null;
        const vals = days.map((x) => { const v = valueOn(s, x); return v > 0 ? Math.round((v / v0) * 10000) / 100 : null; });
        return vals.filter(isNum).length > 10 ? vals : null; };
      const lc = line(co), li = line(ind), ls = line(spy);
      // Next 1M-12M for each, from the setup day.
      const iC = co?.dates?.length ? at(co.dates, spy.dates[iS]) : -1, iI = ind?.dates?.length && ind.dates[0] <= spy.dates[iS] ? at(ind.dates, spy.dates[iS]) : -1;
      const traded = iC >= 0 && co.dates[0] <= spy.dates[iS];
      const R = {};
      for (const [h, n] of Object.entries(HZ)) {
        const c = traded ? ret(co, iC, n) : null, i = iI >= 0 ? ret(ind, iI, n) ?? (isNum(e.industry?.[h]) ? e.industry[h] : null) : isNum(e.industry?.[h]) ? e.industry[h] : null, s = ret(spy, iS, n) ?? (isNum(e.spy?.[h]) ? e.spy[h] : null);
        R[h] = { co: c, ind: i, spy: s, gap: isNum(c) && isNum(i) ? r1(c - i) : null };
      }
      const t = H[e.month] || {};
      out.push({ id: e.id || null, month: e.month, date: spy.dates[iS], similarity: e.similarity ?? null, alike: e.alike || [], unlike: e.unlike || [],
        period: `${label(spy.dates[iS])} – ${label(addMonths(spy.dates[iS], 12) > (today || "9999") ? today : addMonths(spy.dates[iS], 12))}`, ongoing: addMonths(spy.dates[iS], 12) > (today || "9999"),
        then: t.then || "", after: t.after || "", different: t.different || "", lesson: t.lesson || "",
        traded, chart: { dates: days, k0, co: lc, ind: li, spy: ls }, R,
        dd6: { co: traded ? maxDD(co, iC, 126) : null, ind: iI >= 0 ? maxDD(ind, iI, 126) : isNum(e.maxdd6) ? e.maxdd6 : null } });
    }
    return out;
  }

  /** How the company did against its industry across the episodes, per window. */
  function summary(cards) {
    const o = {};
    for (const h of Object.keys(HZ)) {
      const g = cards.map((c) => c.R[h]).filter((r) => isNum(r.gap));
      const s = [...g.map((r) => r.gap)].sort((a, b) => a - b), med = s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
      o[h] = { n: g.length, beat: g.filter((r) => r.gap > 0).length, up: g.filter((r) => r.co > 0).length, median_gap: r1(med), ind_up: cards.filter((c) => isNum(c.R[h].ind) && c.R[h].ind > 0).length, ind_n: cards.filter((c) => isNum(c.R[h].ind)).length };
    }
    return o;
  }

  const Episodes = { HZ, BEFORE, AFTER, at, valueOn, build, summary, ret, maxDD };
  if (typeof module !== "undefined" && module.exports) module.exports = Episodes;
  else root.Episodes = Episodes;
})(typeof window !== "undefined" ? window : globalThis);
