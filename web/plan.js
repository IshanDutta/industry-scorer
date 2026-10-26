/* Industry Scorer: Companies, concentration, trade plans and credit.
 *
 *   - Ranking: every company scored 0-100 within the industry on value, quality, growth, momentum, estimate
 *     revisions and risk (percentile ranks), with a composite per investor type, so "best ways to express it"
 *     come from data.
 *   - Concentration: the top three's weight, the effective number of companies, and the industry without its
 *     top three (cap-weighted and equal-weighted returns, P/E), so one giant can't hide what the rest do.
 *   - Levels: 50/200-day averages, 52-week range, recent swing high and low, and a 1-month 1.5-sigma stop.
 *   - Earnings moves: the average absolute two-day move around each company's last four reports (the options
 *     market's expected move isn't available, so this is the historical stand-in).
 *   - Liquidity: average daily dollar volume; thin names are flagged.
 *   - Position plans per investor type: size from a volatility budget scaled by fit and conviction, how to
 *     enter given positioning, the beta hedge, a rate hedge when rates measurably matter, and where the view
 *     is wrong.
 *   - Credit: the NY Fed's corporate bond market distress index (investment grade and high yield), high-yield
 *     bonds vs Treasuries, and the companies whose own balance sheets are stretched.
 * Pure functions, no I/O.
 */
(function (root) {
  "use strict";
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const mean = (a) => { const b = a.filter(isNum); return b.length ? b.reduce((s, x) => s + x, 0) / b.length : NaN; };
  const quant = (a, q) => { const s = a.filter(isNum).sort((x, y) => x - y); if (!s.length) return NaN; const p = (s.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p); return s[lo] + (s[hi] - s[lo]) * (p - lo); };

  // ---------------------------------------------------------------- ranking
  // [factor, [[field, higherIsBetter]]]
  const FACTORS = {
    value: [["fwd_pe", false], ["pe", false], ["ps", false]],
    quality: [["op_margin", true], ["fcf_margin", true], ["net_margin", true]],
    growth: [["ntm_growth", true], ["rev_growth", true]],
    momentum: [["excess_6M", true], ["excess_1Y", true]],
    revisions: [["rev30", true], ["rev90", true]],
    risk: [["vol_1y", false], ["max_dd_1y", true]],
    income: [["div_yield", true]],
  };
  const PROFILE_MIX = { income: { income: 2, quality: 1, risk: 1, value: 1 }, conservative: { quality: 2, value: 1.5, risk: 2, revisions: 0.5 },
    growth: { growth: 2, revisions: 1.5, momentum: 1, quality: 1 }, aggressive: { momentum: 2, revisions: 1.5, growth: 1.5 } };
  function rankCompanies(cons) {
    const pctile = (field, up) => {
      const v = cons.map((c) => (field === "pe" || field === "fwd_pe" ? (c[field] > 0 ? c[field] : NaN) : c[field])).map(Number);
      const ok = v.filter(isNum).sort((a, b) => a - b);
      return v.map((x) => { if (!isNum(x) || ok.length < 3) return NaN; const below = ok.filter((y) => y < x).length, eq = ok.filter((y) => y === x).length; const p = (below + (eq - 1) / 2) / (ok.length - 1); return 100 * (up ? p : 1 - p); });
    };
    const fp = Object.fromEntries(Object.entries(FACTORS).map(([f, list]) => { const cols = list.map(([k, up]) => pctile(k, up)); return [f, cons.map((_, i) => mean(cols.map((c) => c[i])))]; }));
    const rows = cons.map((c, i) => {
      const factors = Object.fromEntries(Object.keys(FACTORS).map((f) => [f, isNum(fp[f][i]) ? Math.round(fp[f][i]) : null]));
      const mix = (w) => { let a = 0, W = 0; for (const [f, x] of Object.entries(w)) if (isNum(factors[f])) { a += x * factors[f]; W += x; } return W ? Math.round(a / W) : null; };
      return { symbol: c.symbol, name: c.name, weight: c.weight, factors, composite: mix({ value: 1, quality: 1, growth: 1, momentum: 1, revisions: 1, risk: 1 }), by_profile: Object.fromEntries(Object.entries(PROFILE_MIX).map(([p, w]) => [p, mix(w)])) };
    });
    const top = (k) => [...rows].filter((r) => isNum(k === "composite" ? r.composite : r.by_profile[k])).sort((a, b) => (k === "composite" ? b.composite - a.composite : b.by_profile[k] - a.by_profile[k]));
    return { rows: [...rows].sort((a, b) => (b.composite ?? -1) - (a.composite ?? -1)), best: Object.fromEntries(["composite", ...Object.keys(PROFILE_MIX)].map((k) => [k, top(k).slice(0, 5).map((r) => r.symbol)])),
      worst: top("composite").slice(-5).reverse().map((r) => r.symbol) };
  }

  // ---------------------------------------------------------------- concentration
  function concentration(cons) {
    const c = [...cons].filter((x) => x.market_cap > 0).sort((a, b) => b.market_cap - a.market_cap);
    const W = c.reduce((a, x) => a + x.market_cap, 0);
    if (!W) return null;
    const w = c.map((x) => x.market_cap / W);
    const rest = c.slice(3), Wr = rest.reduce((a, x) => a + x.market_cap, 0);
    const cw = (list, k) => { const u = list.filter((x) => isNum(x[k])); const t = u.reduce((a, x) => a + x.market_cap, 0); return t ? u.reduce((a, x) => a + x.market_cap * x[k], 0) / t : NaN; };
    const pe = (list) => { const u = list.filter((x) => x.pe > 0); const E = u.reduce((a, x) => a + x.market_cap / x.pe, 0); return E > 0 ? u.reduce((a, x) => a + x.market_cap, 0) / E : NaN; };
    const fpe = (list) => { const u = list.filter((x) => x.fwd_pe > 0); const E = u.reduce((a, x) => a + x.market_cap / x.fwd_pe, 0); return E > 0 ? u.reduce((a, x) => a + x.market_cap, 0) / E : NaN; };
    return { top3: c.slice(0, 3).map((x) => x.symbol), top3_weight: w.slice(0, 3).reduce((a, x) => a + x, 0), effective_n: 1 / w.reduce((a, x) => a + x * x, 0),
      r1y_all: cw(c, "ret_1Y"), r1y_ex3: cw(rest, "ret_1Y"), r1y_equal: mean(c.map((x) => x.ret_1Y)), r1y_median: quant(c.map((x) => x.ret_1Y), 0.5),
      r3m_all: cw(c, "ret_3M"), r3m_ex3: cw(rest, "ret_3M"), r3m_equal: mean(c.map((x) => x.ret_3M)),
      pe_all: pe(c), pe_ex3: pe(rest), fwd_pe_all: fpe(c), fwd_pe_ex3: fpe(rest),
      dispersion_1y: quant(c.map((x) => x.ret_1Y), 0.75) - quant(c.map((x) => x.ret_1Y), 0.25), n: c.length, ex3_weight: Wr / W };
  }

  // ---------------------------------------------------------------- levels, earnings moves, liquidity
  function levels(series) {
    const v = series?.closes || series?.levels || [];
    if (v.length < 60) return null;
    const last = v[v.length - 1];
    const sma = (k) => (v.length >= k ? v.slice(-k).reduce((a, x) => a + x, 0) / k : NaN);
    const r = v.slice(-61).slice(1).map((x, i) => Math.log(x / v[v.length - 61 + i]));
    const dvol = Math.sqrt(r.reduce((a, x) => a + x * x, 0) / Math.max(1, r.length - 1));
    const y = v.slice(-252);
    return { last, sma50: sma(50), sma200: sma(200), high52: Math.max(...y), low52: Math.min(...y), swing_high: Math.max(...v.slice(-63)), swing_low: Math.min(...v.slice(-63)),
      daily_vol: dvol, stop_1m: last * (1 - 1.5 * dvol * Math.sqrt(21)) };
  }
  /** Average absolute move from the close before each report to the close the day after it (covers before- and after-market reports). */
  function earningsMoves(reportDates, series, today) {
    const d = series?.dates || [], c = series?.closes || [];
    const moves = [];
    for (const rd of [...(reportDates || [])].filter((x) => x && x < today).sort().reverse()) {
      const i = d.findIndex((x) => x >= rd);
      if (i < 1 || i + 1 >= d.length) continue;
      moves.push({ date: rd, move: c[i + 1] / c[i - 1] - 1 });
      if (moves.length >= 4) break;
    }
    return moves.length ? { avg_abs: mean(moves.map((m) => Math.abs(m.move))), moves } : null;
  }
  function liquidity(rows) {
    const out = rows.map((r) => ({ symbol: r.symbol, adv: isNum(r.avgVolume) && isNum(r.price) ? r.avgVolume * r.price : NaN })).filter((r) => isNum(r.adv));
    return { thin: out.filter((r) => r.adv < 10e6).map((r) => r.symbol), median_adv: quant(out.map((r) => r.adv), 0.5), by: Object.fromEntries(out.map((r) => [r.symbol, r.adv])) };
  }

  // ---------------------------------------------------------------- position plans
  // Volatility budget: the most a full-conviction, strong-fit position should add to a portfolio's yearly volatility (% points).
  const BUDGET = { income: 1.5, conservative: 1.2, growth: 3, aggressive: 5 };
  const FIT = { strong: 1, moderate: 0.6, weak: 0.25 }, CONV = { high: 1.2, medium: 1, low: 0.7 };
  /**
   * profiles: {p: {fit, conviction}}; doc: industry doc (summary.vol_1y, beta, positioning, sensitivity, plan).
   * Returns {p: {size, entry, hedge, rate_hedge, stop_level, stop_pct, review}}.
   */
  function positions(profiles, doc, { nextEvent = null } = {}) {
    const vol = doc.summary?.vol_1y, beta = doc.summary?.beta, lv = doc.plan?.index_levels, pos = doc.positioning;
    const rates = doc.sensitivity?.factors?.find((f) => f.key === "rates");
    const strongRates = rates && Math.abs(rates.total?.t || 0) >= 2;
    const out = {};
    for (const [p, x] of Object.entries(profiles || {})) {
      if (!x || !BUDGET[p]) continue;
      const fit = FIT[x.fit] ?? 0.4, conv = CONV[x.conviction] ?? 1;
      const size = isNum(vol) && vol > 0 ? Math.min(20, (BUDGET[p] / (vol * 100)) * 100 * fit * conv) : NaN;
      const entry = pos?.label === "crowded" ? `Scale in: a third now, the rest on a pullback toward the 50-day average${lv ? ` (index ${((lv.sma50 / lv.last - 1) * 100).toFixed(1)}% from here)` : ""}.`
        : pos?.label === "washed out" ? "Positioning is washed out: building the position now is reasonable if the thesis holds."
        : `Half now, half after ${nextEvent || "the next major catalyst"}.`;
      out[p] = { size: isNum(size) ? Math.round(size * 10) / 10 : null, entry,
        hedge: isNum(beta) ? `To keep only the industry bet, short about $${beta.toFixed(2)} of SPY for each $1 held (beta ${beta.toFixed(2)}).` : "",
        rate_hedge: strongRates ? `Rates measurably matter (${((rates.total.effect || 0) * 100).toFixed(1)}% per +0.25pp in the 10-year): consider pairing with Treasury duration.` : "",
        stop_pct: lv ? lv.stop_1m / lv.last - 1 : NaN, review: "after each earnings season or a 1-sigma move, whichever comes first" };
    }
    return out;
  }

  // ---------------------------------------------------------------- credit
  /** cmdi: EODHD rows {as_of_date, market_cmdi, ig_cmdi, hy_cmdi}; hyg, ief: {dates, closes}; companies: [{symbol, weight, int_cover, nd_ebitda}] */
  function credit({ cmdi, hyg, ief, companies }) {
    const out = {};
    const rows = (cmdi || []).filter((r) => r && r.as_of_date).map((r) => ({ date: String(r.as_of_date).slice(0, 10), m: Number(r.market_cmdi), ig: Number(r.ig_cmdi), hy: Number(r.hy_cmdi) })).sort((a, b) => (a.date < b.date ? -1 : 1));
    if (rows.length) {
      const last = rows[rows.length - 1], ago = rows.filter((r) => r.date <= new Date(Date.parse(last.date) - 91 * 864e5).toISOString().slice(0, 10)).pop() || rows[0];
      const pctl = (k) => rows.filter((r) => isNum(r[k]) && r[k] <= last[k]).length / rows.filter((r) => isNum(r[k])).length;
      out.cmdi = { date: last.date, market: last.m, ig: last.ig, hy: last.hy, market_3m: last.m - ago.m, hy_3m: last.hy - ago.hy, market_pctl: pctl("m"), from: rows[0].date, n: rows.length };
    }
    const r3 = (s) => { const c = s?.closes || []; return c.length > 63 ? c[c.length - 1] / c[c.length - 64] - 1 : NaN; };
    if (hyg && ief) out.hy_vs_treasuries_3m = r3(hyg) - r3(ief);
    const weak = (companies || []).filter((c) => (isNum(c.int_cover) && c.int_cover < 3) || (isNum(c.nd_ebitda) && c.nd_ebitda > 3));
    out.weak = weak.map((c) => ({ symbol: c.symbol, int_cover: c.int_cover, nd_ebitda: c.nd_ebitda }));
    out.weak_weight = weak.reduce((a, c) => a + (c.weight || 0), 0);
    return out;
  }

  function digest({ ranking, conc, earn, liq, credit: cr, lv }) {
    const p = (x, d = 1) => (isNum(x) ? `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%` : "n/a");
    const L = [];
    if (ranking?.rows?.length) {
      L.push(`COMPANY RANKING (code: 0-100 percentile scores within the industry on value, quality, growth, momentum, estimate revisions, risk)`);
      L.push(`Best overall: ${ranking.best.composite.join(", ")}; weakest: ${ranking.worst.join(", ")}. Best by investor type: ${Object.entries(ranking.best).filter(([k]) => k !== "composite").map(([k, v]) => `${k} ${v.join("/")}`).join("; ")}.`);
      L.push(ranking.rows.slice(0, 12).map((r) => `${r.symbol} ${r.composite ?? "n/a"} (value ${r.factors.value ?? "-"}, quality ${r.factors.quality ?? "-"}, growth ${r.factors.growth ?? "-"}, momentum ${r.factors.momentum ?? "-"}, revisions ${r.factors.revisions ?? "-"}, risk ${r.factors.risk ?? "-"})`).join("; "));
      L.push("Pick \"best ways to express it\" and what to avoid with this ranking in mind; say why when you depart from it.");
    }
    if (conc) L.push(`CONCENTRATION: top three ${conc.top3.join(", ")} = ${p(conc.top3_weight, 0)} of the industry; effectively ${conc.effective_n.toFixed(1)} equal-sized companies. 1-year return: cap-weighted ${p(conc.r1y_all)}, without the top three ${p(conc.r1y_ex3)}, equal-weighted ${p(conc.r1y_equal)}, median company ${p(conc.r1y_median)}; spread between the 75th and 25th percentile company ${p(conc.dispersion_1y, 0)}. P/E ${isNum(conc.pe_all) ? conc.pe_all.toFixed(1) : "n/a"} overall vs ${isNum(conc.pe_ex3) ? conc.pe_ex3.toFixed(1) : "n/a"} without the top three${isNum(conc.fwd_pe_ex3) ? `; forward ${conc.fwd_pe_all.toFixed(1)} vs ${conc.fwd_pe_ex3.toFixed(1)}` : ""}.`);
    if (earn?.length) L.push(`EARNINGS MOVES (historical stand-in for options-implied moves; average absolute two-day move over the last four reports): ${earn.slice(0, 10).map((e) => `${e.symbol} ±${(e.avg_abs * 100).toFixed(1)}%${e.next ? ` (next ${e.next})` : ""}`).join(", ")}.`);
    if (lv) L.push(`INDEX LEVELS: ${p(lv.last / lv.sma50 - 1)} vs 50-day, ${p(lv.last / lv.sma200 - 1)} vs 200-day; 52-week range ${p(lv.low52 / lv.last - 1)} to ${p(lv.high52 / lv.last - 1)} from here; 1-month 1.5-sigma downside ${p(lv.stop_1m / lv.last - 1)}.`);
    if (liq?.thin?.length) L.push(`LIQUIDITY: under $10M average daily dollar volume: ${liq.thin.join(", ")}; don't recommend these as primary expressions.`);
    if (cr) {
      const c = cr.cmdi;
      L.push(`CREDIT: ${c ? `NY Fed corporate bond distress index ${c.market.toFixed(2)} (investment grade ${c.ig.toFixed(2)}, high yield ${c.hy.toFixed(2)}; ${c.market_3m >= 0 ? "+" : ""}${c.market_3m.toFixed(2)} over 3 months; ${Math.round(c.market_pctl * 100)}th percentile since ${c.from}). ` : ""}High-yield bonds vs Treasuries over 3 months: ${p(cr.hy_vs_treasuries_3m)} (negative = spreads widening). Stretched balance sheets (interest cover under 3x or net debt over 3x EBITDA): ${cr.weak.length ? cr.weak.map((w) => w.symbol).join(", ") + ` = ${p(cr.weak_weight, 0)} of the industry` : "none"}.`);
    }
    return L.join("\n");
  }

  const Plan = { FACTORS, PROFILE_MIX, BUDGET, rankCompanies, concentration, levels, earningsMoves, liquidity, positions, credit, digest };
  if (typeof module !== "undefined" && module.exports) module.exports = Plan;
  else root.Plan = Plan;
})(typeof window !== "undefined" ? window : globalThis);
