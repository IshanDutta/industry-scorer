/* Industry Scorer: Long history, base rates and sector peers.
 *
 * FMP keeps a daily average price change for every industry (2008 on) and a daily industry P/E (2010 on),
 * per exchange, across ALL listed companies in the industry, including ones that later failed or were
 * acquired. From those, code builds an equal-weighted long-run industry index and asks:
 *   - drawdowns: every fall of 20% or more, how deep, how long to the bottom, how long to recover;
 *   - analogs: the past days whose setup looked most like today (1M, 3M and 12M momentum, distance from the
 *     200-day average) and what the industry did over the next 1, 3, 6 and 12 months, next to all days;
 *   - valuation: today's P/E percentile in its own 15-year history, and 12-month returns from similar P/Es;
 *   - seasonality: average return by calendar month;
 *   - rates: 6-month returns when 7-10 year Treasuries (IEF) were falling (yields rising) vs rising;
 *   - how well this long-run index tracks the run's own top-50 index (daily correlation over the last year).
 * Peers: the other industries in the same sector, with their returns and P/E, and the sector ETF.
 * Pure functions, no I/O.
 */
(function (root) {
  "use strict";
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const H = { "1M": 21, "3M": 63, "6M": 126, "12M": 252 };
  const quant = (a, q) => { const s = a.filter(isNum).sort((x, y) => x - y); if (!s.length) return NaN; const p = (s.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p); return s[lo] + (s[hi] - s[lo]) * (p - lo); };
  const mean = (a) => { const b = a.filter(isNum); return b.length ? b.reduce((s, x) => s + x, 0) / b.length : NaN; };
  const sd = (a) => { const b = a.filter(isNum); if (b.length < 2) return NaN; const m = mean(b); return Math.sqrt(b.reduce((s, x) => s + (x - m) ** 2, 0) / (b.length - 1)); };

  /**
   * FMP historical-industry-performance rows (one or more exchanges) -> {dates, rets, levels}. Exchanges are mixed by
   * `weights` (e.g. the share of the top 50's market cap listed on each), renormalized over those reporting that day.
   */
  function levelSeries(rows, weights = null) {
    const by = new Map();
    for (const r of rows || []) {
      const d = String(r?.date || "").slice(0, 10), v = Number(r?.averageChange);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !isNum(v)) continue;
      (by.get(d) || by.set(d, []).get(d)).push([String(r.exchange || ""), Math.max(-25, Math.min(25, v)) / 100]);
    }
    const dates = [...by.keys()].sort();
    const rets = dates.map((d) => { const xs = by.get(d); const w = xs.map(([e]) => (weights && isNum(weights[e]) ? weights[e] : 1)); const W = w.reduce((a, x) => a + x, 0);
      return W > 0 ? xs.reduce((a, [, v], i) => a + w[i] * v, 0) / W : mean(xs.map(([, v]) => v)); });
    const levels = []; let L = 100; for (const r of rets) { L *= 1 + r; levels.push(L); }
    return { dates, rets, levels };
  }
  /** FMP historical-industry-pe rows -> {dates, pe} for one exchange (positive, sane values only). */
  function peSeries(rows, exchange) {
    const pts = (rows || []).filter((r) => (!exchange || r.exchange === exchange) && Number(r.pe) > 0 && Number(r.pe) < 500).map((r) => [String(r.date).slice(0, 10), Number(r.pe)]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const dates = [], pe = []; for (const [d, v] of pts) { if (dates[dates.length - 1] === d) continue; dates.push(d); pe.push(v); }
    return { dates, pe };
  }

  function drawdowns(s, thr = 0.2) {
    const out = []; let peak = 0, troughI = 0, inDD = false;
    for (let i = 0; i < s.levels.length; i++) {
      if (s.levels[i] >= s.levels[peak]) {
        if (inDD) { out[out.length - 1].recovered = s.dates[i]; out[out.length - 1].days_to_recover = i - troughI; inDD = false; }
        peak = i; continue;
      }
      const dd = s.levels[i] / s.levels[peak] - 1;
      if (!inDD && dd <= -thr) { inDD = true; troughI = i; out.push({ peak: s.dates[peak], trough: s.dates[i], depth: dd, days_to_trough: i - peak, recovered: null, days_to_recover: null }); }
      else if (inDD && s.levels[i] < s.levels[troughI]) { troughI = i; const e = out[out.length - 1]; e.trough = s.dates[i]; e.depth = dd; e.days_to_trough = i - peak; }
    }
    const last = s.levels.length - 1;
    const peakAll = s.levels.reduce((m, v, i) => (v > s.levels[m] ? i : m), 0);
    return { episodes: out, current: s.levels[last] / Math.max(...s.levels.slice(Math.max(0, last - 252))) - 1, from_all_time_high: s.levels[last] / s.levels[peakAll] - 1 };
  }

  function feat(lv, i) {
    if (i < 252) return null;
    const sma = lv.slice(i - 199, i + 1).reduce((a, x) => a + x, 0) / 200;
    return [lv[i] / lv[i - 21] - 1, lv[i] / lv[i - 63] - 1, lv[i] / lv[i - 252] - 1, lv[i] / sma - 1];
  }
  const fwd = (lv, i, n) => (i + n < lv.length ? lv[i + n] / lv[i] - 1 : NaN);
  const stats = (a) => ({ n: a.filter(isNum).length, median: quant(a, 0.5), p25: quant(a, 0.25), p75: quant(a, 0.75), pos: a.filter(isNum).length ? a.filter((x) => x > 0).length / a.filter(isNum).length : NaN, mean: mean(a) });

  /**
   * Nearest past setups to today in (1M, 3M, 12M momentum, distance from the 200-day), standardized; spaced at
   * least 15 trading days apart so one episode doesn't count many times. Forward returns per horizon vs all days.
   */
  function analogs(s, { k = 40, spacing = 15 } = {}) {
    const lv = s.levels, last = lv.length - 1;
    const now = feat(lv, last); if (!now) return null;
    const F = []; for (let i = 252; i < last - 21; i++) { const f = feat(lv, i); if (f) F.push([i, f]); }
    if (F.length < 200) return null;
    const sds = [0, 1, 2, 3].map((j) => sd(F.map(([, f]) => f[j])) || 1);
    const dist = F.map(([i, f]) => [i, Math.sqrt(f.reduce((a, x, j) => a + ((x - now[j]) / sds[j]) ** 2, 0))]).sort((a, b) => a[1] - b[1]);
    const picked = [];
    for (const [i] of dist) { if (picked.every((p) => Math.abs(p - i) >= spacing)) picked.push(i); if (picked.length >= k) break; }
    const out = { now: { r1m: now[0], r3m: now[1], r12m: now[2], vs200: now[3] }, n: picked.length, dates: picked.map((i) => s.dates[i]).sort(), horizons: {}, all: {} };
    for (const [h, n] of Object.entries(H)) {
      out.horizons[h] = stats(picked.map((i) => fwd(lv, i, n)));
      const allIdx = []; for (let i = 252; i + n < lv.length; i += 5) allIdx.push(i);
      out.all[h] = stats(allIdx.map((i) => fwd(lv, i, n)));
    }
    return out;
  }

  /** Today's P/E percentile in its own history, and 12-month returns from days with a similar percentile. */
  function valuation(s, pes) {
    if (!pes?.dates?.length || pes.dates.length < 500) return null;
    const cur = pes.pe[pes.pe.length - 1];
    const sorted = [...pes.pe].sort((a, b) => a - b);
    const pctOf = (v) => sorted.filter((x) => x <= v).length / sorted.length;
    const p = pctOf(cur);
    const idx = new Map(s.dates.map((d, i) => [d, i]));
    const near = [];
    for (let j = 0; j < pes.dates.length; j += 5) { const i = idx.get(pes.dates[j]); if (i === undefined) continue; if (Math.abs(pctOf(pes.pe[j]) - p) <= 0.1) near.push(fwd(s.levels, i, 252)); }
    const q = [0.2, 0.4, 0.6, 0.8].map((x) => quant(pes.pe, x));
    return { pe: cur, percentile: p, from: pes.dates[0], median: quant(pes.pe, 0.5), quintiles: q, low: sorted[0], high: sorted[sorted.length - 1], fwd12_similar: stats(near) };
  }
  /** Average and share-positive return by calendar month (month-end to month-end). */
  function seasonality(s) {
    const ends = []; for (let i = 0; i < s.dates.length; i++) if (i === s.dates.length - 1 || s.dates[i + 1].slice(0, 7) !== s.dates[i].slice(0, 7)) ends.push(i);
    const by = Array.from({ length: 12 }, () => []);
    for (let k = 1; k < ends.length; k++) { const m = Number(s.dates[ends[k]].slice(5, 7)) - 1; by[m].push(s.levels[ends[k]] / s.levels[ends[k - 1]] - 1); }
    return by.map((a, m) => ({ month: m + 1, mean: mean(a), median: quant(a, 0.5), pos: a.length ? a.filter((x) => x > 0).length / a.length : NaN, n: a.length }));
  }
  /** 6-month industry returns by rate regime (IEF 6-month return: <= -3% yields rising, >= +3% falling). */
  function rateRegime(s, ief) {
    if (!ief?.dates?.length) return null;
    const im = new Map(ief.dates.map((d, i) => [d, i]));
    const reg = (j) => { if (j < 126) return null; const r = ief.closes[j] / ief.closes[j - 126] - 1; return r <= -0.03 ? "yields rising" : r >= 0.03 ? "yields falling" : "stable"; };
    const B = { "yields rising": [], "yields falling": [], stable: [] };
    for (let i = 0; i < s.dates.length; i += 5) { const j = im.get(s.dates[i]); if (j === undefined) continue; const g = reg(j); if (g) B[g].push(fwd(s.levels, i, 126)); }
    const lastJ = ief.dates.length - 1;
    return { now: reg(lastJ), ief_6m: lastJ >= 126 ? ief.closes[lastJ] / ief.closes[lastJ - 126] - 1 : NaN, by: Object.fromEntries(Object.entries(B).map(([k, v]) => [k, stats(v)])) };
  }
  /** Daily-return correlation between the long-run index and the run's own index over their overlap. */
  function tracking(s, index) {
    if (!index?.dates?.length) return null;
    const m = new Map(s.dates.map((d, i) => [d, s.rets[i]]));
    const a = [], b = [];
    for (let i = 1; i < index.dates.length; i++) { const r = m.get(index.dates[i]); if (!isNum(r)) continue; a.push(r); b.push(index.levels[i] / index.levels[i - 1] - 1); }
    if (a.length < 60) return null;
    const ma = mean(a), mb = mean(b); let c = 0, va = 0, vb = 0;
    for (let i = 0; i < a.length; i++) { c += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; }
    return { corr: c / Math.sqrt(va * vb), n: a.length };
  }

  /** Everything at once. perfRows, peRows: FMP rows; primary: exchange holding most of the top-50's market cap. */
  function build({ perfRows, peRows, primary, weights, ief, index }) {
    const s = levelSeries(perfRows, weights);
    if (s.dates.length < 600) return null;
    const pes = peSeries(peRows, primary);
    const an = analogs(s);
    const base = Object.fromEntries(Object.keys(H).map((h) => [h, an?.horizons?.[h]?.n >= 10 ? an.horizons[h].pos : an?.all?.[h]?.pos]));
    return { from: s.dates[0], to: s.dates[s.dates.length - 1], days: s.dates.length, primary, drawdowns: drawdowns(s), analogs: an, valuation: valuation(s, pes),
      seasonality: seasonality(s), rates: rateRegime(s, ief), tracking: tracking(s, index), base_prob_up: base,
      returns: { "1Y": s.levels.length > 252 ? s.levels[s.levels.length - 1] / s.levels[s.levels.length - 253] - 1 : NaN } };
  }

  // ---------------------------------------------------------------- peers
  /** Compound an industry's daily average change over the last n trading days. */
  function trailing(rows, n, weights = null) { const s = levelSeries(rows, weights); const L = s.levels.length; return L > n ? s.levels[L - 1] / s.levels[L - 1 - n] - 1 : NaN; }
  /**
   * peers: [{industry, rows (1 year of FMP performance), pe: {NASDAQ, NYSE}, companies, total_market_cap}]; self: the industry name.
   * Returns rows sorted by total market cap, with this industry's rank on 3M and 1Y return and P/E.
   */
  function peerTable(peers, self) {
    const rows = peers.map((p) => { const pe = isNum(p.pe_value) ? [p.pe_value] : [p.pe?.NASDAQ, p.pe?.NYSE].filter((x) => x > 0 && x < 500);
      return { industry: p.industry, self: p.industry === self, companies: p.companies, total_market_cap: p.total_market_cap,
        r1m: trailing(p.rows, 21, p.weights), r3m: trailing(p.rows, 63, p.weights), r1y: trailing(p.rows, 252, p.weights), pe: pe.length ? mean(pe) : NaN }; });
    const rank = (k, up) => { const v = rows.filter((r) => isNum(r[k])).sort((a, b) => (up ? b[k] - a[k] : a[k] - b[k])); const i = v.findIndex((r) => r.self); return i < 0 ? null : { rank: i + 1, of: v.length }; };
    return { rows: rows.sort((a, b) => (b.total_market_cap || 0) - (a.total_market_cap || 0)), rank_r3m: rank("r3m", true), rank_r1y: rank("r1y", true), rank_pe_cheapest: rank("pe", false),
      median_pe: quant(rows.map((r) => r.pe), 0.5), median_r1y: quant(rows.map((r) => r.r1y), 0.5) };
  }

  function digest(h, peers, etf) {
    const p = (x, d = 1) => (isNum(x) ? `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%` : "n/a");
    const L = [];
    if (h) {
      L.push(`LONG HISTORY AND BASE RATES (code; FMP equal-weighted industry index ${h.from} to ${h.to}, every listed company including ones that later failed or were bought${h.tracking ? `; tracks this run's top-50 index with daily correlation ${h.tracking.corr.toFixed(2)}` : ""})`);
      const dd = h.drawdowns;
      if (dd) L.push(`Drawdowns of 20%+: ${dd.episodes.length}. ${dd.episodes.slice(-5).map((e) => `${e.peak}→${e.trough} ${p(e.depth, 0)} (${e.days_to_trough} days down${e.recovered ? `, ${e.days_to_recover} days to recover` : ", not recovered"})`).join("; ")}. Now ${p(dd.current)} from the 1-year high, ${p(dd.from_all_time_high)} from the all-time high.`);
      const a = h.analogs;
      if (a) L.push(`Setups most like today (1M ${p(a.now.r1m)}, 3M ${p(a.now.r3m)}, 12M ${p(a.now.r12m)}, ${p(a.now.vs200)} vs 200-day; ${a.n} analogs, e.g. ${a.dates.slice(-4).join(", ")}): ` + Object.keys(H).map((k) => `${k} median ${p(a.horizons[k].median)} (middle half ${p(a.horizons[k].p25)} to ${p(a.horizons[k].p75)}), up ${isNum(a.horizons[k].pos) ? Math.round(a.horizons[k].pos * 100) : "n/a"}% of the time vs ${isNum(a.all[k].pos) ? Math.round(a.all[k].pos * 100) : "n/a"}% for all days`).join("; ") + ".");
      const v = h.valuation;
      if (v) L.push(`P/E ${v.pe.toFixed(1)} is at the ${Math.round(v.percentile * 100)}th percentile of its history since ${v.from} (median ${v.median.toFixed(1)}, range ${v.low.toFixed(1)}-${v.high.toFixed(1)}); 12 months after similar P/E percentiles the industry's median return was ${p(v.fwd12_similar.median)}, up ${isNum(v.fwd12_similar.pos) ? Math.round(v.fwd12_similar.pos * 100) : "n/a"}% of the time (${v.fwd12_similar.n} samples).`);
      if (h.rates?.now) { const r = h.rates; L.push(`Rate regime now: ${r.now} (IEF ${p(r.ief_6m)} over 6 months). Industry's next-6-month median return by regime: ${Object.entries(r.by).map(([k, x]) => `${k} ${p(x.median)} (up ${isNum(x.pos) ? Math.round(x.pos * 100) : "n/a"}%, n=${x.n})`).join("; ")}.`); }
      if (h.seasonality) { const m = new Date().getUTCMonth(); const nx = [h.seasonality[m], h.seasonality[(m + 1) % 12]]; L.push(`Seasonality: ${nx.map((x) => `month ${x.month} average ${p(x.mean)}, up ${isNum(x.pos) ? Math.round(x.pos * 100) : "n/a"}% of years`).join("; ")}.`); }
      L.push(`Base-rate chance the industry is higher: ${Object.entries(h.base_prob_up).map(([k, v]) => `${k} ${isNum(v) ? Math.round(v * 100) + "%" : "n/a"}`).join(", ")}. Start your probabilities from these and move them only for specific evidence.`);
    }
    if (peers?.rows?.length) {
      L.push(`SECTOR PEERS (FMP industry data): ${peers.rows.slice(0, 14).map((r) => `${r.self ? "**" : ""}${r.industry}${r.self ? "**" : ""} P/E ${isNum(r.pe) ? r.pe.toFixed(1) : "n/a"}, 3M ${p(r.r3m)}, 1Y ${p(r.r1y)}`).join("; ")}. This industry ranks ${peers.rank_r1y ? `#${peers.rank_r1y.rank} of ${peers.rank_r1y.of} on 1-year return` : "n/a"}, ${peers.rank_r3m ? `#${peers.rank_r3m.rank} of ${peers.rank_r3m.of} on 3-month` : ""}, ${peers.rank_pe_cheapest ? `#${peers.rank_pe_cheapest.rank} cheapest of ${peers.rank_pe_cheapest.of} on P/E` : ""} (sector median P/E ${isNum(peers.median_pe) ? peers.median_pe.toFixed(1) : "n/a"}).`);
    }
    if (etf) L.push(`Sector ETF ${etf.symbol}: 3M ${p(etf.r3m)}, 1Y ${p(etf.r1y)}; the industry vs the ETF: 3M ${p(etf.vs_r3m)}, 1Y ${p(etf.vs_r1y)}.`);
    return L.join("\n");
  }

  const History = { H, levelSeries, peSeries, drawdowns, analogs, valuation, seasonality, rateRegime, tracking, build, trailing, peerTable, digest, quant };
  if (typeof module !== "undefined" && module.exports) module.exports = History;
  else root.History = History;
})(typeof window !== "undefined" ? window : globalThis);
