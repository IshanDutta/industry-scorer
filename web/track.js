/* Industry Scorer: Track record.
 *
 * Every finished lead verdict is logged (in this browser) with what it said and the prices it was made at:
 * the 1M/3M/6M/12M calls (call, expected range, chance of a gain), the bull/base/bear price ranges and
 * probabilities, the code's expected return, the opportunity verdict, and the companies with their weights
 * and prices. Later runs score those calls against what the industry actually did:
 *   - direction: bullish and it rose, bearish and it fell, neutral and it stayed inside its range;
 *   - range: did the move land inside the stated range;
 *   - Brier score of "chance it's higher" (0 is perfect, 0.25 is a coin flip);
 *   - error vs the range's midpoint; and, after 12 months, which scenario it landed in.
 * The industry's move is the cap-weighted return of the companies as they were weighted when the call was
 * made, with SPY over the same dates for context. Pure functions, no I/O.
 */
(function (root) {
  "use strict";
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const DAYS = { "1M": 30, "3M": 91, "6M": 182, "12M": 365 };
  const ORDER = ["1M", "3M", "6M", "12M"];
  const addDays = (iso, n) => { const t = new Date(String(iso).slice(0, 10) + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  const mid = (r) => (Array.isArray(r) && r.length ? r.reduce((a, x) => a + x, 0) / r.length : NaN);

  /** What gets logged from a finished lead verdict. doc: the industry doc (constituents carry weight and px). */
  function snapshot(result, doc, run_at) {
    if (!result || !doc?.as_of) return null;
    const hz = Object.fromEntries(ORDER.filter((h) => result.horizons?.[h]).map((h) => { const x = result.horizons[h]; return [h, { call: x.call, expected_move: x.expected_move, probability_up: x.probability_up }]; }));
    const scn = Object.fromEntries(["bull", "base", "bear"].filter((k) => result.scenarios?.[k]).map((k) => [k, { probability: result.scenarios[k].probability, price_move: result.scenarios[k].price_move }]));
    const cons = (doc.constituents || []).filter((c) => isNum(c.px) && c.px > 0 && isNum(c.weight)).map((c) => ({ symbol: c.symbol, weight: Math.round(c.weight * 1e5) / 1e5, px: c.px }));
    if (!cons.length || (!Object.keys(hz).length && !Object.keys(scn).length)) return null;
    return { id: `${doc.as_of}|${run_at}`, run_at, as_of: doc.as_of, headline: String(result.headline || "").slice(0, 200), horizons: hz, scenarios: scn,
      expected_return: result.math?.expected_return ?? null, opportunity: result.opportunity?.verdict || null, constituents: cons, eval: null };
  }

  /**
   * Price at or before a date from {dates, closes}. Returns NaN when the series doesn't reach back to the date.
   */
  function priceAt(series, date) {
    const d = series?.dates || [], c = series?.closes || [];
    if (!d.length || d[0] > date) return NaN;
    let lo = 0, hi = d.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (d[m] <= date) lo = m; else hi = m - 1; }
    return d[lo] <= date ? c[lo] : NaN;
  }

  /**
   * Score one logged entry. getSeries(symbol) -> {dates, closes} or null; spy: {dates, closes}; lastDate: latest price date.
   * Returns {at, horizons: {h: {end, matured, realized, spy, coverage, hit, inside, brier, error}}, scenario}.
   */
  function evaluate(entry, getSeries, spy, lastDate) {
    const out = { at: lastDate, horizons: {}, scenario: null };
    const ret = (end) => {
      let w = 0, acc = 0;
      for (const c of entry.constituents) { const s = getSeries(c.symbol); const p = priceAt(s, end); if (!(p > 0)) continue; w += c.weight; acc += c.weight * (p / c.px - 1); }
      const W = entry.constituents.reduce((a, c) => a + c.weight, 0);
      return { r: w > 0 ? acc / w : NaN, coverage: W > 0 ? w / W : 0 };
    };
    const spyRet = (end) => { const a = priceAt(spy, entry.as_of), b = priceAt(spy, end); return a > 0 && b > 0 ? b / a - 1 : NaN; };
    for (const h of ORDER) {
      const x = entry.horizons?.[h]; if (!x) continue;
      const end = addDays(entry.as_of, DAYS[h]), matured = end <= lastDate, upto = matured ? end : lastDate;
      if (upto <= entry.as_of) { out.horizons[h] = { end, matured: false, realized: NaN, coverage: 0 }; continue; }
      const { r, coverage } = ret(upto), pct = r * 100;
      const e = { end, matured, upto, realized: isNum(r) ? Math.round(pct * 10) / 10 : null, spy: isNum(spyRet(upto)) ? Math.round(spyRet(upto) * 1000) / 10 : null, coverage: Math.round(coverage * 100) / 100 };
      if (matured && isNum(pct) && coverage >= 0.6) {
        const [lo, hi] = x.expected_move?.length === 2 ? x.expected_move : [mid(x.expected_move), mid(x.expected_move)];
        e.inside = isNum(lo) && isNum(hi) ? pct >= lo && pct <= hi : null;
        e.hit = x.call === "bullish" ? pct > 0 : x.call === "bearish" ? pct < 0 : e.inside;
        e.brier = isNum(x.probability_up) ? Math.round(((x.probability_up / 100 - (pct > 0 ? 1 : 0)) ** 2) * 1000) / 1000 : null;
        e.error = isNum(mid(x.expected_move)) ? Math.round((pct - mid(x.expected_move)) * 10) / 10 : null;
      }
      out.horizons[h] = e;
    }
    // Scenarios, once 12 months have passed
    const end12 = addDays(entry.as_of, 365);
    if (end12 <= lastDate && Object.keys(entry.scenarios || {}).length) {
      const { r, coverage } = ret(end12), pct = r * 100;
      if (isNum(pct) && coverage >= 0.6) {
        const sc = Object.entries(entry.scenarios).filter(([, s]) => s.price_move?.length);
        const dist = ([, s]) => { const lo = Math.min(...s.price_move), hi = Math.max(...s.price_move); return pct < lo ? lo - pct : pct > hi ? pct - hi : 0; };
        const landed = sc.find((x) => dist(x) === 0)?.[0] || null;
        const nearest = sc.length ? sc.reduce((a, x) => (dist(x) < dist(a) ? x : a))[0] : null;
        out.scenario = { realized: Math.round(pct * 10) / 10, landed, nearest, expected: entry.expected_return };
      }
    }
    return out;
  }

  /** Aggregate over every matured call: per horizon and overall. */
  function summarize(entries) {
    const rows = [];
    for (const e of entries || []) for (const [h, v] of Object.entries(e.eval?.horizons || {})) if (v.matured && v.hit !== undefined) rows.push({ h, ...v, call: e.horizons[h]?.call });
    const agg = (list) => {
      const b = list.filter((x) => isNum(x.brier)), er = list.filter((x) => isNum(x.error)), ins = list.filter((x) => x.inside !== null && x.inside !== undefined);
      return { n: list.length, hit_rate: list.length ? list.filter((x) => x.hit).length / list.length : NaN, inside_rate: ins.length ? ins.filter((x) => x.inside).length / ins.length : NaN,
        brier: b.length ? b.reduce((a, x) => a + x.brier, 0) / b.length : NaN, mean_error: er.length ? er.reduce((a, x) => a + x.error, 0) / er.length : NaN,
        mean_abs_error: er.length ? er.reduce((a, x) => a + Math.abs(x.error), 0) / er.length : NaN };
    };
    const pending = (entries || []).reduce((a, e) => a + Object.values(e.eval?.horizons || {}).filter((v) => !v.matured).length, 0);
    return { all: agg(rows), by: Object.fromEntries(ORDER.map((h) => [h, agg(rows.filter((x) => x.h === h))])), pending, calls: (entries || []).length };
  }

  /** Feedback for the lead strategist. */
  function digest(entries) {
    const s = summarize(entries);
    if (!entries?.length) return "";
    const p = (x) => (isNum(x) ? `${Math.round(x * 100)}%` : "n/a");
    const L = [`YOUR TRACK RECORD ON THIS INDUSTRY (code, from ${s.calls} earlier verdict${s.calls === 1 ? "" : "s"} in this browser): ${s.all.n} matured horizon calls, ${s.pending} still open.`];
    if (s.all.n) {
      L.push(`Direction right ${p(s.all.hit_rate)}; move inside the stated range ${p(s.all.inside_rate)}; Brier score ${isNum(s.all.brier) ? s.all.brier.toFixed(3) : "n/a"} (0.25 = coin flip); average miss vs the range midpoint ${isNum(s.all.mean_error) ? (s.all.mean_error >= 0 ? "+" : "") + s.all.mean_error.toFixed(1) + "pp" : "n/a"} (positive = the industry did better than you said).`);
      for (const h of ORDER) { const b = s.by[h]; if (b.n) L.push(`  ${h}: ${b.n} calls, direction ${p(b.hit_rate)}, inside range ${p(b.inside_rate)}, Brier ${isNum(b.brier) ? b.brier.toFixed(3) : "n/a"}.`); }
      L.push("Calibrate: if moves often landed outside your ranges, widen them; if your misses lean one way, correct that bias; if your Brier score is near or above 0.25, keep probabilities closer to 50%.");
    }
    const recent = [...entries].sort((a, b) => (a.run_at < b.run_at ? 1 : -1)).slice(0, 4);
    for (const e of recent) {
      const parts = ORDER.filter((h) => e.horizons[h] && e.eval?.horizons?.[h]).map((h) => { const x = e.horizons[h], v = e.eval.horizons[h];
        return `${h} ${x.call} [${(x.expected_move || []).join(", ")}]% → ${v.realized ?? "n/a"}%${v.matured ? "" : " so far"}`; });
      if (parts.length) L.push(`  ${e.as_of}: ${parts.join("; ")}`);
    }
    return L.join("\n");
  }

  const Track = { DAYS, ORDER, snapshot, priceAt, evaluate, summarize, digest };
  if (typeof module !== "undefined" && module.exports) module.exports = Track;
  else root.Track = Track;
})(typeof window !== "undefined" ? window : globalThis);
