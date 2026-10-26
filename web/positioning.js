/* Industry Scorer: Positioning.
 *
 * Who owns the industry, who is buying or selling, and how stretched the price is. For the largest
 * companies:
 *   - insiders (FMP insider statistics from Form 4): open-market purchases and sales over the last two
 *     quarters, against each company's own norm for the eight quarters before;
 *   - institutions (FMP 13F positions summary for the latest complete quarter): change in the share held,
 *     holders added or lost, new vs closed positions, and the put/call ratio of 13F option holdings;
 *   - short interest (EODHD shares statistics): short interest as a share of the float;
 *   - price (from the run's own prices): the industry index vs its 50- and 200-day averages, 14-day RSI,
 *     distance from the 52-week high, recent vs 1-year volatility, and the share of companies above their
 *     200-day average.
 * Each signal is labeled, and a transparent rule set turns them into crowded / neutral / washed out.
 * Pure functions, no I/O.
 */
(function (root) {
  "use strict";
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const n = (x) => (x === null || x === undefined || x === "" ? NaN : Number(x));
  const median = (a) => { const s = a.filter(isNum).sort((x, y) => x - y); if (!s.length) return NaN; const k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };

  /** The latest calendar quarter whose 13F filings are complete (filed within 45 days of quarter end). */
  function latest13FQuarter(today) {
    const t = new Date(today + "T00:00:00Z");
    let y = t.getUTCFullYear(), q = Math.floor(t.getUTCMonth() / 3) + 1;
    for (let k = 0; k < 6; k++) {
      q -= 1; if (q === 0) { q = 4; y -= 1; }
      const end = new Date(Date.UTC(y, q * 3, 0)); end.setUTCDate(end.getUTCDate() + 46);
      if (end <= t) return { year: y, quarter: q };
    }
    return { year: y, quarter: q };
  }

  /** FMP insider-trade-statistics rows -> recent two quarters vs the eight before. */
  function insiderSummary(rows) {
    const qs = (rows || []).filter((r) => isNum(n(r.year)) && isNum(n(r.quarter))).sort((a, b) => (b.year - a.year) || (b.quarter - a.quarter));
    if (!qs.length) return null;
    const recent = qs.slice(0, 2), base = qs.slice(2, 10);
    const s = (list, k) => list.reduce((a, r) => a + (n(r[k]) || 0), 0);
    const normSales = base.length ? (s(base, "totalSales") / base.length) * 2 : NaN;
    return { quarters: recent.map((r) => `${r.year}-Q${r.quarter}`), purchases: s(recent, "totalPurchases"), sales: s(recent, "totalSales"),
      norm_sales: normSales, sales_vs_norm: normSales > 0 ? s(recent, "totalSales") / normSales : NaN, base_purchases: s(base, "totalPurchases") };
  }
  /** FMP 13F positions-summary row -> the changes that matter. */
  function instSummary(r) {
    if (!r) return null;
    const holders = n(r.investorsHolding), last = n(r.lastInvestorsHolding);
    return { date: String(r.date || "").slice(0, 10), own_pct: n(r.ownershipPercent), own_change_pp: n(r.ownershipPercentChange),
      holders_change: last > 0 ? holders / last - 1 : NaN, new_positions: n(r.newPositions), closed_positions: n(r.closedPositions),
      increased: n(r.increasedPositions), reduced: n(r.reducedPositions), calls: n(r.totalCalls), puts: n(r.totalPuts), last_calls: n(r.lastTotalCalls), last_puts: n(r.lastTotalPuts),
      pcr: n(r.putCallRatio), pcr_prev: n(r.lastPutCallRatio) };
  }
  /** Price-based stretch from {dates, closes} (or levels). */
  function technicals(series) {
    const v = (series?.closes || series?.levels || []).filter(isNum);
    if (v.length < 60) return null;
    const last = v[v.length - 1];
    const sma = (k) => (v.length >= k ? v.slice(-k).reduce((a, x) => a + x, 0) / k : NaN);
    const s50 = sma(50), s200 = sma(200);
    let gain = 0, loss = 0; for (let i = v.length - 14; i < v.length; i++) { const d = v[i] - v[i - 1]; if (d > 0) gain += d; else loss -= d; }
    const rsi = gain + loss > 0 ? 100 * gain / (gain + loss) : 50;
    const hi = Math.max(...v.slice(-252));
    const rets = v.slice(1).map((x, i) => Math.log(x / v[i]));
    const sd = (a) => { const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)) * Math.sqrt(252); };
    return { last, vs50: isNum(s50) ? last / s50 - 1 : NaN, vs200: isNum(s200) ? last / s200 - 1 : NaN, rsi14: rsi, from_high: last / hi - 1,
      vol20: rets.length >= 20 ? sd(rets.slice(-20)) : NaN, vol252: rets.length >= 60 ? sd(rets.slice(-252)) : NaN };
  }

  /**
   * members: [{symbol, market_cap, insider (insiderSummary), inst (instSummary), short_pct (0-1 of float), tech (technicals)}]
   * indexTech: technicals of the industry index.
   */
  function aggregate(members, indexTech) {
    const capw = (get, list = members) => { const use = list.filter((m) => isNum(get(m))); const c = use.reduce((a, m) => a + m.market_cap, 0); return c ? use.reduce((a, m) => a + m.market_cap * get(m), 0) / c : NaN; };
    const ins = members.filter((m) => m.insider), inst = members.filter((m) => m.inst), sh = members.filter((m) => isNum(m.short_pct)), tech = members.filter((m) => m.tech);
    const out = { n: members.length };
    out.insiders = ins.length ? {
      n: ins.length, purchases: ins.reduce((a, m) => a + m.insider.purchases, 0), buyers: ins.filter((m) => m.insider.purchases > 0).map((m) => m.symbol),
      sales: ins.reduce((a, m) => a + m.insider.sales, 0), sales_vs_norm: median(ins.map((m) => m.insider.sales_vs_norm)),
      heavy_sellers: ins.filter((m) => m.insider.sales_vs_norm >= 2 && m.insider.sales >= 5).map((m) => m.symbol), quarters: ins[0].insider.quarters } : null;
    if (inst.length) {
      const P = inst.reduce((a, m) => a + (m.inst.puts || 0), 0), C = inst.reduce((a, m) => a + (m.inst.calls || 0), 0);
      const P0 = inst.reduce((a, m) => a + (m.inst.last_puts || 0), 0), C0 = inst.reduce((a, m) => a + (m.inst.last_calls || 0), 0);
      out.institutions = { n: inst.length, date: inst[0].inst.date, own_change_pp: capw((m) => m.inst?.own_change_pp, inst), own_pct: capw((m) => m.inst?.own_pct, inst),
        holders_change: median(inst.map((m) => m.inst.holders_change)), new_vs_closed: inst.reduce((a, m) => a + (m.inst.new_positions || 0), 0) / Math.max(1, inst.reduce((a, m) => a + (m.inst.closed_positions || 0), 0)),
        pcr: C > 0 ? P / C : NaN, pcr_prev: C0 > 0 ? P0 / C0 : NaN,
        adding: inst.filter((m) => m.inst.own_change_pp >= 1).map((m) => m.symbol), cutting: inst.filter((m) => m.inst.own_change_pp <= -1).map((m) => m.symbol) };
    } else out.institutions = null;
    out.short = sh.length ? { n: sh.length, capw: capw((m) => m.short_pct, sh), median: median(sh.map((m) => m.short_pct)),
      highest: [...sh].sort((a, b) => b.short_pct - a.short_pct).slice(0, 5).map((m) => ({ symbol: m.symbol, pct: m.short_pct })) } : null;
    out.price = indexTech || null;
    out.breadth = tech.length ? { n: tech.length, above200: tech.filter((m) => m.tech.vs200 > 0).length / tech.filter((m) => isNum(m.tech.vs200)).length, above50: tech.filter((m) => m.tech.vs50 > 0).length / tech.length } : null;
    // Rules: each signal adds +1 (crowded / extended) or -1 (washed out / under-owned).
    const sig = [];
    const add = (cond, pts, text) => { if (cond) sig.push({ pts, text }); };
    const t = out.price, I = out.institutions, H = out.insiders, Sh = out.short, B = out.breadth;
    if (t) {
      add(t.vs200 > 0.15, 1, `index ${(t.vs200 * 100).toFixed(0)}% above its 200-day average`);
      add(t.vs200 < -0.1, -1, `index ${(t.vs200 * 100).toFixed(0)}% below its 200-day average`);
      add(t.rsi14 > 70, 1, `14-day RSI ${t.rsi14.toFixed(0)} (overbought)`);
      add(t.rsi14 < 30, -1, `14-day RSI ${t.rsi14.toFixed(0)} (oversold)`);
      add(t.from_high < -0.25, -1, `${(t.from_high * 100).toFixed(0)}% below the 52-week high`);
    }
    if (B) { add(B.above200 > 0.85, 1, `${Math.round(B.above200 * 100)}% of companies above their 200-day average`); add(B.above200 < 0.25, -1, `only ${Math.round(B.above200 * 100)}% of companies above their 200-day average`); }
    if (I) {
      add(I.own_change_pp >= 1, 1, `institutions raised their share by ${I.own_change_pp.toFixed(1)}pp last quarter`);
      add(I.own_change_pp <= -1, -1, `institutions cut their share by ${(-I.own_change_pp).toFixed(1)}pp last quarter`);
      if (isNum(I.pcr) && I.pcr_prev > 0) { const ch = I.pcr / I.pcr_prev - 1; add(ch < -0.15, 1, `13F put/call ratio fell ${(-ch * 100).toFixed(0)}% (less hedging)`); add(ch > 0.15, -1, `13F put/call ratio rose ${(ch * 100).toFixed(0)}% (more hedging)`); }
    }
    if (H) { add(H.sales_vs_norm >= 1.5, 1, `insiders selling ${H.sales_vs_norm.toFixed(1)}x their usual pace`); add(H.buyers.length >= 3, -1, `open-market insider buying at ${H.buyers.length} companies`); }
    if (Sh) add(Sh.capw >= 0.08, -1, `short interest ${(Sh.capw * 100).toFixed(1)}% of float (cap-weighted)`);
    const score = sig.reduce((a, s) => a + s.pts, 0);
    out.signals = sig; out.score = score;
    out.label = score >= 2 ? "crowded" : score <= -2 ? "washed out" : "neutral";
    return out;
  }
  /** One block for the strategist's prompts. */
  function digest(p) {
    if (!p) return "";
    const pc = (x, d = 1) => (isNum(x) ? `${(x * 100).toFixed(d)}%` : "n/a");
    const L = [`POSITIONING (code, largest ${p.n} companies): ${p.label} (score ${p.score >= 0 ? "+" : ""}${p.score}). ${p.signals.map((s) => s.text).join("; ") || "no extreme signals"}.`];
    if (p.price) L.push(`Price: index ${pc(p.price.vs50)} vs 50-day, ${pc(p.price.vs200)} vs 200-day average; RSI ${isNum(p.price.rsi14) ? p.price.rsi14.toFixed(0) : "n/a"}; ${pc(p.price.from_high)} from the 52-week high; 20-day volatility ${pc(p.price.vol20, 0)} vs 1-year ${pc(p.price.vol252, 0)}.${p.breadth ? ` ${Math.round(p.breadth.above200 * 100)}% of companies above their 200-day, ${Math.round(p.breadth.above50 * 100)}% above their 50-day.` : ""}`);
    if (p.institutions) { const I = p.institutions; L.push(`Institutions (13F, quarter to ${I.date}): ownership ${isNum(I.own_pct) ? I.own_pct.toFixed(1) + "%" : "n/a"} (${isNum(I.own_change_pp) ? (I.own_change_pp >= 0 ? "+" : "") + I.own_change_pp.toFixed(1) + "pp" : "n/a"} q/q); holders ${pc(I.holders_change)} (median); new vs closed positions ${isNum(I.new_vs_closed) ? I.new_vs_closed.toFixed(1) : "n/a"}x; 13F put/call ${isNum(I.pcr) ? I.pcr.toFixed(2) : "n/a"} vs ${isNum(I.pcr_prev) ? I.pcr_prev.toFixed(2) : "n/a"} the quarter before.${I.adding.length ? ` Adding: ${I.adding.join(", ")}.` : ""}${I.cutting.length ? ` Cutting: ${I.cutting.join(", ")}.` : ""}`); }
    if (p.insiders) { const H = p.insiders; L.push(`Insiders (${H.quarters.join(", ")}): ${H.purchases} open-market purchases${H.buyers.length ? ` (${H.buyers.join(", ")})` : ""}, ${H.sales} sales; median company selling ${isNum(H.sales_vs_norm) ? H.sales_vs_norm.toFixed(1) + "x" : "n/a"} its usual pace.${H.heavy_sellers.length ? ` Heavy sellers: ${H.heavy_sellers.join(", ")}.` : ""}`); }
    if (p.short) L.push(`Short interest: ${pc(p.short.capw)} of float cap-weighted, median ${pc(p.short.median)}; highest ${p.short.highest.map((x) => `${x.symbol} ${pc(x.pct)}`).join(", ")}.`);
    L.push("Options implied volatility isn't available from the connected data; the 13F put/call ratio is the options read.");
    return L.join("\n");
  }

  const Positioning = { latest13FQuarter, insiderSummary, instSummary, technicals, aggregate, digest };
  if (typeof module !== "undefined" && module.exports) module.exports = Positioning;
  else root.Positioning = Positioning;
})(typeof window !== "undefined" ? window : globalThis);
