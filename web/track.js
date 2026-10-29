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
 * made. Alpha is measured three ways over the same dates: vs SPY, vs the sector ETF, and beta-adjusted
 * (Jensen: industry minus [risk-free + beta x (SPY minus risk-free)], beta as of the call). "Call alpha" is
 * what following the call earned: the beta-adjusted alpha, signed by the call (bullish +1, bearish -1,
 * neutral 0). Open calls are marked to market ("so far"). Pure functions, no I/O.
 */
(function (root) {
  "use strict";
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const DAYS = { "1M": 30, "3M": 91, "6M": 182, "12M": 365 };
  const ORDER = ["1M", "3M", "6M", "12M"];
  const addDays = (iso, n) => { const t = new Date(String(iso).slice(0, 10) + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  const mid = (r) => (Array.isArray(r) && r.length ? r.reduce((a, x) => a + x, 0) / r.length : NaN);

  /** What gets logged from a finished lead verdict. doc: the industry doc (constituents carry weight and px). */
  function snapshot(result, doc, run_at, extra = {}) {
    if (!result || !doc?.as_of) return null;
    const hz = Object.fromEntries(ORDER.filter((h) => result.horizons?.[h]).map((h) => { const x = result.horizons[h]; return [h, { call: x.call, expected_move: x.expected_move, probability_up: x.probability_up, conviction: x.conviction || null }]; }));
    const scn = Object.fromEntries(["bull", "base", "bear"].filter((k) => result.scenarios?.[k]).map((k) => [k, { probability: result.scenarios[k].probability, price_move: result.scenarios[k].price_move }]));
    const cons = (doc.constituents || []).filter((c) => isNum(c.px) && c.px > 0 && isNum(c.weight)).map((c) => ({ symbol: c.symbol, weight: Math.round(c.weight * 1e5) / 1e5, px: c.px }));
    if (!cons.length || (!Object.keys(hz).length && !Object.keys(scn).length)) return null;
    return { id: `${doc.as_of}|${run_at}`, run_at, as_of: doc.as_of, headline: String(result.headline || "").slice(0, 200), horizons: hz, scenarios: scn,
      expected_return: result.math?.expected_return ?? null, opportunity: result.opportunity?.verdict || null, constituents: cons,
      beta: isNum(doc.summary?.beta) ? Math.round(doc.summary.beta * 100) / 100 : null, etf: extra.etf || null, rf: isNum(extra.rf) ? extra.rf : null, sector: doc.sector || null, eval: null };
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
   * Score one logged entry. getSeries(symbol) -> {dates, closes} or null; bench: {spy, etf, rf, beta} (series; rf as a
   * yearly decimal; beta used when the entry has none); lastDate: latest price date.
   * Returns {at, horizons: {h: {end, matured, upto, realized, spy, etf, excess, excess_etf, alpha, call_alpha, coverage,
   * hit, rel_hit, inside, brier, error}}, scenario}. A matured horizon that was already scored is kept as it was.
   */
  function evaluate(entry, getSeries, bench, lastDate) {
    if (bench && Array.isArray(bench.dates)) bench = { spy: bench }; // older callers passed SPY alone
    const spySer = bench?.spy || null, etfSer = bench?.etf || null;
    const beta = isNum(entry.beta) ? entry.beta : isNum(bench?.beta) ? bench.beta : 1;
    const rfYear = isNum(entry.rf) ? entry.rf : isNum(bench?.rf) ? bench.rf : 0;
    const prev = entry.eval?.horizons || {};
    const out = { at: lastDate, horizons: {}, scenario: entry.eval?.scenario || null };
    const ret = (end) => {
      let w = 0, acc = 0;
      for (const c of entry.constituents) { const s = getSeries(c.symbol); const p = priceAt(s, end); if (!(p > 0)) continue; w += c.weight; acc += c.weight * (p / c.px - 1); }
      const W = entry.constituents.reduce((a, c) => a + c.weight, 0);
      return { r: w > 0 ? acc / w : NaN, coverage: W > 0 ? w / W : 0 };
    };
    const serRet = (ser, end) => { const a = priceAt(ser, entry.as_of), b = priceAt(ser, end); return a > 0 && b > 0 ? b / a - 1 : NaN; };
    const r1 = (x) => (isNum(x) ? Math.round(x * 1000) / 10 : null);
    const sign = (call) => (call === "bullish" ? 1 : call === "bearish" ? -1 : 0);
    for (const h of ORDER) {
      const x = entry.horizons?.[h]; if (!x) continue;
      if (prev[h]?.matured && prev[h].scored) { out.horizons[h] = prev[h]; continue; }
      const end = addDays(entry.as_of, DAYS[h]), matured = end <= lastDate, upto = matured ? end : lastDate;
      if (upto <= entry.as_of) { out.horizons[h] = { end, matured: false, realized: null, coverage: 0 }; continue; }
      const { r, coverage } = ret(upto), spy = serRet(spySer, upto), etf = serRet(etfSer, upto);
      // Prices that didn't come back this time never wipe out the last good mark.
      if ((!isNum(r) || coverage < 0.6) && prev[h] && isNum(prev[h].realized) && !matured) { out.horizons[h] = prev[h]; continue; }
      const days = (Date.parse(upto) - Date.parse(entry.as_of)) / 864e5, rfp = rfYear * days / 365;
      const alpha = isNum(r) && isNum(spy) ? r - (rfp + beta * (spy - rfp)) : NaN;
      const e = { end, matured, upto, days: Math.round(days), realized: r1(r), spy: r1(spy), etf: r1(etf), excess: r1(r - spy), excess_etf: r1(r - etf), alpha: r1(alpha),
        call_alpha: isNum(alpha) ? r1(sign(x.call) * alpha) : null, beta, coverage: Math.round(coverage * 100) / 100 };
      const pct = r * 100;
      if (isNum(pct) && coverage >= 0.6) {
        e.rel_hit = x.call === "neutral" || !isNum(alpha) ? null : sign(x.call) * alpha > 0; // beat (or lagged) the market as called
        if (matured) {
          const [lo, hi] = x.expected_move?.length === 2 ? x.expected_move : [mid(x.expected_move), mid(x.expected_move)];
          e.inside = isNum(lo) && isNum(hi) ? pct >= lo && pct <= hi : null;
          e.hit = x.call === "bullish" ? pct > 0 : x.call === "bearish" ? pct < 0 : e.inside;
          e.brier = isNum(x.probability_up) ? Math.round(((x.probability_up / 100 - (pct > 0 ? 1 : 0)) ** 2) * 1000) / 1000 : null;
          e.error = isNum(mid(x.expected_move)) ? Math.round((pct - mid(x.expected_move)) * 10) / 10 : null;
          e.scored = !entry.etf || !!etfSer; // kept for good once the sector ETF's move is in too
        } else {
          // So far: on the called side of zero, and inside the range scaled to the time elapsed.
          e.tracking = x.call === "bullish" ? pct > 0 : x.call === "bearish" ? pct < 0 : null;
        }
      }
      out.horizons[h] = e;
    }
    // Scenarios, once 12 months have passed
    const end12 = addDays(entry.as_of, 365);
    if (!out.scenario && end12 <= lastDate && Object.keys(entry.scenarios || {}).length) {
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
  /** Whether an entry still needs prices: any horizon not yet scored at maturity. */
  const needsPrices = (entry) => ORDER.some((h) => entry.horizons?.[h] && !(entry.eval?.horizons?.[h]?.matured && entry.eval.horizons[h].scored));

  /** Aggregate. Matured calls are scored; open calls are marked to market ("so far"). entries may span industries. */
  function summarize(entries) {
    const done = [], open = [];
    for (const e of entries || []) for (const [h, v] of Object.entries(e.eval?.horizons || {})) {
      const row = { h, ...v, call: e.horizons[h]?.call, p: e.horizons[h]?.probability_up, industry: e.industry || null, as_of: e.as_of };
      if (v.matured && v.hit !== undefined) done.push(row); else if (isNum(v.realized)) open.push(row);
    }
    const avg = (xs) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : NaN);
    const sd = (xs) => { if (xs.length < 2) return NaN; const m = avg(xs); return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)); };
    const agg = (list) => {
      const b = list.filter((x) => isNum(x.brier)), er = list.filter((x) => isNum(x.error)), ins = list.filter((x) => x.inside !== null && x.inside !== undefined);
      const rel = list.filter((x) => typeof x.rel_hit === "boolean"), ca = list.map((x) => x.call_alpha).filter(isNum), al = list.map((x) => x.alpha).filter(isNum);
      const ex = list.map((x) => x.excess).filter(isNum), dir = list.filter((x) => typeof x.hit === "boolean"), trk = list.filter((x) => typeof x.tracking === "boolean");
      return { n: list.length, hit_rate: dir.length ? dir.filter((x) => x.hit).length / dir.length : NaN, inside_rate: ins.length ? ins.filter((x) => x.inside).length / ins.length : NaN,
        brier: b.length ? avg(b.map((x) => x.brier)) : NaN, mean_error: er.length ? avg(er.map((x) => x.error)) : NaN, mean_abs_error: er.length ? avg(er.map((x) => Math.abs(x.error))) : NaN,
        rel_hit_rate: rel.length ? rel.filter((x) => x.rel_hit).length / rel.length : NaN, rel_n: rel.length,
        call_alpha: avg(ca), call_alpha_total: ca.reduce((a, x) => a + x, 0), ir: isNum(sd(ca)) && sd(ca) > 0 ? avg(ca) / sd(ca) : NaN,
        alpha: avg(al), excess: avg(ex), tracking_rate: trk.length ? trk.filter((x) => x.tracking).length / trk.length : NaN };
    };
    // Calibration: when the call said X% chance of a gain, how often was there one?
    const bins = [[0, 40, "under 40%"], [40, 60, "40-60%"], [60, 101, "60% or more"]].map(([lo, hi, label]) => {
      const xs = done.filter((x) => isNum(x.p) && x.p >= lo && x.p < hi && isNum(x.realized));
      return { label, n: xs.length, said: xs.length ? avg(xs.map((x) => x.p)) : NaN, happened: xs.length ? (100 * xs.filter((x) => x.realized > 0).length) / xs.length : NaN };
    });
    return { all: agg(done), by: Object.fromEntries(ORDER.map((h) => [h, agg(done.filter((x) => x.h === h))])), open: agg(open), open_by: Object.fromEntries(ORDER.map((h) => [h, agg(open.filter((x) => x.h === h))])),
      calibration: bins, pending: open.length, calls: (entries || []).length, rows: done, open_rows: open };
  }

  /** Feedback for the lead strategist. */
  function digest(entries) {
    const s = summarize(entries);
    if (!entries?.length) return "";
    const p = (x) => (isNum(x) ? `${Math.round(x * 100)}%` : "n/a");
    const L = [`YOUR TRACK RECORD ON THIS INDUSTRY (code, from ${s.calls} earlier verdict${s.calls === 1 ? "" : "s"} in this browser): ${s.all.n} matured horizon calls, ${s.pending} still open.`];
    if (!s.all.n && s.open.n) L.push(`Open calls so far: on the called side ${p(s.open.tracking_rate)}; call alpha so far ${isNum(s.open.call_alpha) ? (s.open.call_alpha >= 0 ? "+" : "") + s.open.call_alpha.toFixed(1) + "pp" : "n/a"} per call (early; not yet a record).`);
    if (s.all.n) {
      L.push(`Direction right ${p(s.all.hit_rate)}; move inside the stated range ${p(s.all.inside_rate)}; Brier score ${isNum(s.all.brier) ? s.all.brier.toFixed(3) : "n/a"} (0.25 = coin flip); average miss vs the range midpoint ${isNum(s.all.mean_error) ? (s.all.mean_error >= 0 ? "+" : "") + s.all.mean_error.toFixed(1) + "pp" : "n/a"} (positive = the industry did better than you said).`);
      for (const h of ORDER) { const b = s.by[h]; if (b.n) L.push(`  ${h}: ${b.n} calls, direction ${p(b.hit_rate)}, inside range ${p(b.inside_rate)}, Brier ${isNum(b.brier) ? b.brier.toFixed(3) : "n/a"}.`); }
      if (isNum(s.all.call_alpha)) L.push(`Alpha: following your calls earned ${(s.all.call_alpha >= 0 ? "+" : "") + s.all.call_alpha.toFixed(1)}pp of beta-adjusted alpha per call vs SPY (information ratio ${isNum(s.all.ir) ? s.all.ir.toFixed(2) : "n/a"}); the industry beat or lagged the market as you called it ${p(s.all.rel_hit_rate)} of the time.`);
      L.push("Calibrate: if moves often landed outside your ranges, widen them; if your misses lean one way, correct that bias; if your Brier score is near or above 0.25, keep probabilities closer to 50%; if your call alpha is negative, question what you rely on most.");
    }
    const recent = [...entries].sort((a, b) => (a.run_at < b.run_at ? 1 : -1)).slice(0, 4);
    for (const e of recent) {
      const parts = ORDER.filter((h) => e.horizons[h] && e.eval?.horizons?.[h]).map((h) => { const x = e.horizons[h], v = e.eval.horizons[h];
        return `${h} ${x.call} [${(x.expected_move || []).join(", ")}]% → ${v.realized ?? "n/a"}%${v.matured ? "" : " so far"}`; });
      if (parts.length) L.push(`  ${e.as_of}: ${parts.join("; ")}`);
    }
    return L.join("\n");
  }

  const Track = { DAYS, ORDER, snapshot, priceAt, evaluate, needsPrices, summarize, digest };
  if (typeof module !== "undefined" && module.exports) module.exports = Track;
  else root.Track = Track;
})(typeof window !== "undefined" ? window : globalThis);
