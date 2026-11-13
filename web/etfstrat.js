/**
 * EtfStrat: the top-down ETF strategist (code). Recommend ETFs works the way a portfolio manager would:
 *
 * 1. Industry distribution first. Every industry the runs cover (full runs and code-only fills) gets a conviction
 *    for the goal: the runs' score for the investor type, the call for the horizon and the 12-month expectation, the
 *    scenario skew, valuation against its own history and what is priced in, quality, estimate revisions, risk
 *    against the goal, income, and the macro, world, trade and regulation reads. Target weights tilt the market's
 *    own industry weights by conviction, drop what the goal should avoid, and cap any industry and sector.
 * 2. Bonds as a sleeve: the goal's band, split across Treasuries by maturity, TIPS, corporates, high yield, MBS and
 *    cash by the goal and the shape of the Treasury curve.
 * 3. Companies inside each industry: the run's own ranking for the investor type (value, quality, growth, momentum,
 *    revisions, risk, income percentiles), the lead strategist's best expressions (and avoids), sized by conviction
 *    and size. That gives a target for every company.
 * 4. ETFs that hold them: FMP's reverse lookup (every fund that holds each target company) finds candidates far
 *    beyond any fixed list; US-listed ETFs only, sized from their position values, no leverage, no single-stock funds.
 * 5. The ETF mix: a quadratic program that matches the target industry distribution and company targets, penalizes
 *    overlap between the ETFs (the same stocks bought twice) and off-target exposure, keeps risk under the goal's
 *    ceiling and costs down, with every ETF between 3% and 15%.
 * 6. Opportunities: industries and companies with the strongest case the market weights don't reflect, dated
 *    catalysts, and the purest ETF to express each.
 * Pure functions; the page fetches.
 */
(function (root) {
  "use strict";
  const n = (x) => (x === null || x === undefined || x === "" ? NaN : Number(x));
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const lc = (s) => String(s || "").toLowerCase().trim();
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const mean = (a) => { const b = a.filter(isNum); return b.length ? b.reduce((s, x) => s + x, 0) / b.length : NaN; };
  const sd = (a) => { const b = a.filter(isNum); if (b.length < 2) return NaN; const m = mean(b); return Math.sqrt(b.reduce((s, x) => s + (x - m) ** 2, 0) / (b.length - 1)); };
  const CALLN = (c) => { const t = lc(typeof c === "string" ? c : c?.call); if (!t) return NaN; const s = /bull|positive|up|overweight|buy/.test(t) ? 1 : /bear|negative|down|underweight|sell/.test(t) ? -1 : /neutral|mixed|flat|hold|balanced/.test(t) ? 0 : NaN; return isNum(s) && s && !/slight|mild|modest|lean/.test(t) ? 2 * s : s; };
  const HZ_M = { "1M": 1, "3M": 3, "6M": 6, "12M": 12, long: 12 };

  // ------------------------------------------------------------------ goal settings for the top-down steps
  /** How each goal weighs the conviction inputs, how hard it tilts, and its breadth. */
  const STYLE = {
    income: { w: { fit: 1.2, call: 0.6, expected: 0.5, skew: 0.4, value: 0.8, quality: 0.8, revisions: 0.3, risk: 0.9, income: 1.4, lens: 0.6, verdict: 0.4 }, tilt: 0.8, avoidZ: -0.55, minInd: 10, maxInd: 18, perInd: 4 },
    conservative: { w: { fit: 1.2, call: 0.6, expected: 0.5, skew: 0.7, value: 0.8, quality: 1.0, revisions: 0.3, risk: 1.4, income: 0.4, lens: 0.8, verdict: 0.4 }, tilt: 0.7, avoidZ: -0.5, minInd: 12, maxInd: 20, perInd: 4 },
    growth: { w: { fit: 1.2, call: 1.0, expected: 1.0, skew: 0.6, value: 0.5, quality: 0.6, revisions: 0.8, risk: 0.3, income: 0, lens: 0.5, verdict: 0.6 }, tilt: 1.0, avoidZ: -0.6, minInd: 9, maxInd: 16, perInd: 5 },
    aggressive: { w: { fit: 1.0, call: 1.3, expected: 1.3, skew: 0.8, value: 0.3, quality: 0.3, revisions: 1.0, risk: -0.2, income: 0, lens: 0.4, verdict: 0.8 }, tilt: 1.35, avoidZ: -0.5, minInd: 7, maxInd: 14, perInd: 5 },
  };
  const LABEL = { fit: "fit for the investor type", call: "the call for the horizon", expected: "expected 12-month return", skew: "bull vs bear scenarios", value: "valuation vs its history", quality: "quality (margins, returns)", revisions: "estimate revisions", risk: "risk vs the goal", income: "dividend yield", lens: "macro, world, trade and regulation", verdict: "the strategist's verdict" };

  // ------------------------------------------------------------------ 1. industries
  /**
   * One row per industry from the digests (Portfolio.digest), with the market's own weight (its share of the total
   * market cap the runs cover) and every input of the conviction. horizon: 1M..12M or long.
   */
  function industryRows(digests, goal) {
    const h = goal.horizon === "long" ? "12M" : goal.horizon || "12M";
    const rows = Object.values(digests || {}).filter((d) => d?.name && n(d.val?.cap) > 0).map((d) => {
      const c = d.lean?.[h] || d.calls?.[h]?.call || "", c12 = d.lean?.["12M"] || d.calls?.["12M"]?.call || "";
      const bull = d.scen?.bull || {}, bear = d.scen?.bear || {}, base = d.scen?.base || {};
      const skew = isNum(n(bull.p)) && isNum(n(bear.p)) && isNum(n(bull.move)) && isNum(n(bear.move)) ? (n(bull.p) * n(bull.move) + n(bear.p) * n(bear.move)) / Math.max(1, n(bull.p) + n(bear.p)) : NaN;
      const pctH = n(d.val?.pe_hist_pct), pe_pct = isNum(pctH) ? (pctH > 1 ? pctH / 100 : pctH) : NaN;
      const regTxt = lc(`${d.reg?.stance || ""} ${d.reg?.intensity || ""} ${d.reads?.reg || ""}`), tradeTxt = lc(`${d.trade?.rating || ""} ${d.reads?.trade || ""}`);
      const worldAdverse = (d.world || []).filter((x) => /adverse|negative|headwind|hurt/.test(lc(x.stance))).length, worldFav = (d.world || []).filter((x) => /favorable|positive|tailwind|help/.test(lc(x.stance))).length;
      return { name: d.name, slug: d.slug, sector: d.sector || "Other", kind: d.kind, saved_at: d.saved_at, cap: n(d.val.cap), headline: d.headline || "",
        score: n(d.scores?.[goal.type]), scores: d.scores || {}, call: c, callN: CALLN(c), call12: c12, callN12: CALLN(c12), exp12: n(d.expected12), expH: n(d.calls?.[h]?.mid), p_up: n(d.calls?.[h]?.p_up),
        bull, base, bear, skew, pe: n(d.val?.pe), fwd_pe: n(d.val?.fwd_pe), pe_pct, priced: d.priced?.verdict || "", eps_growth: n(d.val?.eps_growth), rev30: n(d.val?.rev30), div: n(d.val?.div_yield),
        roe: n(d.fund?.roe), opm: n(d.fund?.op_margin), fcf: n(d.fund?.fcf_margin), de: n(d.fund?.de), beta: n(d.risk?.beta), vol: n(d.risk?.vol), mdd: n(d.risk?.max_dd), r1y: n(d.risk?.r1y),
        verdict: lc(d.opportunity || ""), regime: d.macro?.regime || "", reg: regTxt, trade: tradeTxt, worldAdverse, worldFav, reads: d.reads || {}, events: d.events || [], cos: d.cos || [] };
    });
    const tot = rows.reduce((s, r) => s + r.cap, 0) || 1; for (const r of rows) r.mkt = r.cap / tot;
    return rows;
  }
  /** Percentile (0-1) of each row's value among the rows (NaN stays NaN). */
  function pctiles(rows, f) { const v = rows.map(f), ok = v.filter(isNum).sort((a, b) => a - b); return v.map((x) => (isNum(x) && ok.length > 2 ? ok.filter((y) => y < x).length / (ok.length - 1) : NaN)); }
  /**
   * Conviction per industry for the goal: each input scaled to about -1..+1, weighted by the goal's style, and the
   * reasons (the inputs that moved it most, each with its value). Code-only fills count 60%, stale runs 85%.
   */
  function conviction(rows, goal, { now = new Date().toISOString().slice(0, 10) } = {}) {
    const st = STYLE[goal.type] || STYLE.growth, W = st.w;
    const qual = pctiles(rows, (r) => mean([r.roe, r.opm, r.fcf])), mktExp = mean(rows.map((r) => r.exp12)), volMed = mean(rows.map((r) => r.vol)), divP = pctiles(rows, (r) => r.div), revP = pctiles(rows, (r) => r.rev30);
    rows.forEach((r, i) => {
      const x = {};
      x.fit = isNum(r.score) ? clamp((r.score - 50) / 20, -1.5, 1.5) : NaN;
      x.call = isNum(r.callN) ? r.callN / 2 : NaN; if (goal.horizon !== "12M" && isNum(r.callN12)) x.call = isNum(x.call) ? 0.7 * x.call + 0.3 * (r.callN12 / 2) : r.callN12 / 2;
      x.expected = isNum(r.exp12) ? clamp((r.exp12 - (isNum(mktExp) ? mktExp : 6)) / 8, -1.5, 1.5) : NaN;
      x.skew = isNum(r.skew) ? clamp(r.skew / 12, -1, 1) : NaN;
      x.value = isNum(r.pe_pct) ? (0.5 - r.pe_pct) * 2 : NaN; if (/cheap|undervalu|discount|below/.test(lc(r.priced))) x.value = (isNum(x.value) ? x.value : 0) + 0.4; if (/rich|expensive|demanding|above|stretched/.test(lc(r.priced))) x.value = (isNum(x.value) ? x.value : 0) - 0.4;
      x.quality = isNum(qual[i]) ? (qual[i] - 0.5) * 2 : NaN;
      x.revisions = isNum(revP[i]) ? (revP[i] - 0.5) * 2 : NaN;
      x.risk = isNum(r.vol) && isNum(volMed) ? clamp((volMed - r.vol) / (volMed || 0.25) * 2, -1.5, 1.5) * (goal.type === "aggressive" ? 1 : 1) : NaN;
      x.income = isNum(divP[i]) ? (divP[i] - 0.5) * 2 : NaN;
      let lens = 0; if (/headwind|adverse|tighten|hostile/.test(r.reg)) lens -= /high|severe|heavy/.test(r.reg) ? 0.8 : 0.4; if (/tailwind|supportive|easing|deregul/.test(r.reg)) lens += 0.4;
      if (/high|severe/.test(r.trade)) lens -= 0.6; else if (/moderate/.test(r.trade)) lens -= 0.2; else if (/low|minimal/.test(r.trade)) lens += 0.1;
      lens += 0.25 * clamp(r.worldFav - r.worldAdverse, -3, 3) / 3; if (/restrict|headwind|tight/.test(lc(r.regime))) lens -= 0.15; if (/support|easing|tailwind/.test(lc(r.regime))) lens += 0.15; x.lens = clamp(lens, -1.5, 1);
      x.verdict = /^yes/.test(r.verdict) ? 0.8 : /^cond/.test(r.verdict) ? 0.2 : /^no/.test(r.verdict) ? -0.6 : NaN;
      let s = 0, wsum = 0; const parts = [];
      for (const [k, wt] of Object.entries(W)) if (isNum(x[k]) && wt) { s += wt * x[k]; wsum += Math.abs(wt); parts.push({ k, label: LABEL[k], x: x[k], pts: wt * x[k] }); }
      const age = r.saved_at ? (Date.parse(now) - Date.parse(String(r.saved_at).slice(0, 10))) / 864e5 : 0, trust = (r.kind === "full" ? 1 : 0.6) * (age > 21 ? 0.85 : 1);
      r.parts = x; r.trust = trust; r.z = wsum ? (s / wsum) * 2 * trust : 0;
      r.reasons = parts.sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts)).slice(0, 4);
    });
    return rows;
  }
  /** Clip weights at their caps and hand the excess to the rest in proportion (water-filling). */
  function waterfill(w, cap) {
    const out = { ...w }; for (let it = 0; it < 50; it++) {
      const over = Object.keys(out).filter((k) => out[k] > (cap[k] ?? 1) + 1e-12); if (!over.length) break;
      let ex = 0; for (const k of over) { ex += out[k] - cap[k]; out[k] = cap[k]; }
      const free = Object.keys(out).filter((k) => out[k] < (cap[k] ?? 1) - 1e-12), fs = free.reduce((s, k) => s + out[k], 0); if (!fs) break;
      for (const k of free) out[k] += (ex * out[k]) / fs;
    }
    return out;
  }
  /**
   * The target industry distribution for the stock sleeve (fractions of the whole portfolio): market weight x
   * exp(tilt x conviction), what the goal should avoid dropped, the strongest kept within the goal's breadth,
   * each industry and sector capped, nothing under 1%.
   */
  function targetIndustries(rows, goal, equityShare) {
    const st = STYLE[goal.type] || STYLE.growth;
    const live = rows.filter((r) => r.z > st.avoidZ && !(r.callN <= -2 && goal.type !== "aggressive"));
    let w = {}; for (const r of live) w[r.name] = r.mkt * Math.exp(st.tilt * r.z);
    // Breadth: the largest tilted weights, at least minInd and at most maxInd.
    const keep = Object.entries(w).sort((a, b) => b[1] - a[1]).slice(0, st.maxInd).map(([k]) => k); w = Object.fromEntries(keep.map((k) => [k, w[k]]));
    const norm = (o) => { const s = Object.values(o).reduce((a, x) => a + x, 0) || 1; return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v / s])); };
    w = norm(w);
    const indCap = Math.min(1, (goal.industryCap || 0.25) / Math.max(equityShare, 1e-9)), secCap = Math.min(1, (goal.sectorCap || 0.4) / Math.max(equityShare, 1e-9));
    for (let round = 0; round < 6; round++) {
      w = waterfill(w, Object.fromEntries(Object.keys(w).map((k) => [k, indCap])));
      const sec = {}; for (const [k, v] of Object.entries(w)) { const s = rows.find((r) => r.name === k)?.sector || "Other"; sec[s] = (sec[s] || 0) + v; }
      let changed = false; for (const [s, v] of Object.entries(sec)) if (v > secCap + 1e-9) { changed = true; const f = secCap / v; let ex = 0; for (const k of Object.keys(w)) if ((rows.find((r) => r.name === k)?.sector || "Other") === s) { ex += w[k] * (1 - f); w[k] *= f; }
        const others = Object.keys(w).filter((k) => (rows.find((r) => r.name === k)?.sector || "Other") !== s && (sec[rows.find((r) => r.name === k)?.sector || "Other"] || 0) < secCap), os = others.reduce((a, k) => a + w[k], 0); for (const k of others) w[k] += os ? (ex * w[k]) / os : 0; }
      // Nothing under 1% of the portfolio: drop the smallest while breadth allows, then lift the rest to 1%.
      const small = Object.keys(w).filter((k) => w[k] * equityShare < 0.01).sort((a, b) => w[a] - w[b]), room = Math.max(0, Object.keys(w).length - st.minInd);
      if (small.length && room > 0) { for (const k of small.slice(0, room)) delete w[k]; w = norm(w); changed = true; }
      else if (small.length) { const fl = 0.01 / Math.max(equityShare, 1e-9), lift = small.reduce((a, k) => a + (fl - w[k]), 0), rest = Object.keys(w).filter((k) => !small.includes(k)), rs = rest.reduce((a, k) => a + w[k], 0); for (const k of small) w[k] = fl; for (const k of rest) w[k] -= rs ? (lift * w[k]) / rs : 0; }
      if (!changed) break;
    }
    const by = new Map(rows.map((r) => [r.name, r]));
    const mktSleeve = norm(Object.fromEntries(rows.map((r) => [r.name, r.mkt])));
    const out = rows.map((r) => ({ name: r.name, sector: r.sector, target: (w[r.name] || 0) * equityShare, market: (mktSleeve[r.name] || 0) * equityShare, z: r.z, reasons: r.reasons, avoided: !live.includes(r) }))
      .map((x) => ({ ...x, active: x.target - x.market })).sort((a, b) => b.target - a.target || b.market - a.market);
    return { rows: out, held: out.filter((x) => x.target > 0), avoided: out.filter((x) => x.avoided && x.market > 0.002).sort((a, b) => b.market - a.market), by };
  }

  // ------------------------------------------------------------------ 2. bonds
  /** Bond buckets and the ETFs that express each (the curated list's types). */
  const BUCKETS = { cash: "T-bills and cash", short: "Short Treasuries (1-3y)", inter: "Intermediate Treasuries (3-10y)", long: "Long Treasuries (10y+)", tips: "TIPS", ig: "Investment-grade corporates", hy: "High yield", mbs: "Mortgage-backed", loans: "Bank loans", muni: "Municipal bonds", agg: "Core aggregate" };
  function bucketOf(e) { if (!e?.bond) return null; if (e.bond === "treasury") return e.duration < 3 ? "short" : e.duration < 10 ? "inter" : "long"; if (e.bond === "float") return "cash"; return e.bond in BUCKETS ? e.bond : "agg"; }
  /** The bond sleeve's split by goal, moved by the curve: inverted (10y under 3m) leans short, a steep long end adds duration. */
  function bondSleeve(goal, curve, share) {
    const T = { income: { ig: 0.28, hy: 0.18, mbs: 0.14, inter: 0.14, loans: 0.1, tips: 0.08, short: 0.08 }, conservative: { short: 0.24, inter: 0.24, tips: 0.14, ig: 0.18, mbs: 0.1, cash: 0.1 },
      growth: { inter: 0.45, tips: 0.25, ig: 0.2, short: 0.1 }, aggressive: { inter: 0.5, tips: 0.3, short: 0.2 } }[goal.type] || { inter: 0.5, short: 0.5 };
    const t3 = n(curve?.month3), t10 = n(curve?.year10), t2 = n(curve?.year2), t30 = n(curve?.year30), notes = [];
    const s = { ...T };
    if (isNum(t3) && isNum(t10) && t10 < t3) { const m = (s.inter || 0) * 0.4; s.inter = (s.inter || 0) - m; s.short = (s.short || 0) + m * 0.6; s.cash = (s.cash || 0) + m * 0.4; notes.push(`The curve is inverted (10-year ${t10}% under 3-month ${t3}%): shorter maturities pay as much for less rate risk.`); }
    if (isNum(t2) && isNum(t30) && t30 - t2 > 0.6 && goal.type !== "aggressive") { const m = (s.short || 0) * 0.3; s.short = (s.short || 0) - m; s.long = (s.long || 0) + m; notes.push(`The long end pays ${(t30 - t2).toFixed(2)}pp over 2-year Treasuries: a little long duration is paid for.`); }
    if (isNum(t3) && t3 >= 4) notes.push(`T-bills still yield ${t3}%: cash-like holdings earn real money while waiting.`);
    // A bucket too small to hold a 3% position folds into the largest one.
    const tot0 = Object.values(s).reduce((a, x) => a + x, 0) || 1; let big = Object.entries(s).sort((a, b) => b[1] - a[1])[0]?.[0];
    for (const [k, v] of Object.entries(s)) if (k !== big && (v / tot0) * share < 0.03) { s[big] += v; delete s[k]; }
    const tot = Object.values(s).reduce((a, x) => a + x, 0) || 1;
    return { share, buckets: Object.fromEntries(Object.entries(s).filter(([, v]) => v > 0.001).map(([k, v]) => [k, (v / tot) * share])), notes };
  }

  // ------------------------------------------------------------------ 3. companies
  /**
   * The best companies in one industry for the goal: the run's ranking (by_profile for the investor type), the lead
   * strategist's best expressions (+15) and avoids (dropped), thin names dropped; within-industry weights by score and
   * size. rank: [{symbol, name, weight (cap share), composite, by_profile, factors}]; cons: {symbol: constituent}.
   */
  function pickCompanies(rank, goal, { k = 5, best = [], avoid = [], thin = [], cons = {} } = {}) {
    const bestS = new Map(best.map((b) => [b.symbol, b.why || ""])), avoidS = new Set(avoid.map((a) => a.symbol)), thinS = new Set(thin);
    const rows = (rank || []).filter((r) => r?.symbol && !avoidS.has(r.symbol) && !thinS.has(r.symbol)).map((r) => {
      const s = n(r.by_profile?.[goal.type]), c = n(r.composite); const score = (isNum(s) ? s : isNum(c) ? c : 50) + (bestS.has(r.symbol) ? 15 : 0);
      return { symbol: r.symbol, name: r.name || cons[r.symbol]?.name || "", score, composite: c, profile: s, factors: r.factors || {}, capw: n(r.weight) || n(cons[r.symbol]?.weight) || 0, strategist: bestS.get(r.symbol) || "", c: cons[r.symbol] || null }; })
      .sort((a, b) => b.score - a.score).slice(0, k);
    const raw = rows.map((r) => Math.sqrt(Math.max(r.capw, 1e-4)) * Math.pow(Math.max(r.score, 10) / 50, 2)), s = raw.reduce((a, x) => a + x, 0) || 1;
    rows.forEach((r, i) => (r.within = raw[i] / s));
    return { picks: rows, avoided: [...avoidS].map((sym) => ({ symbol: sym, why: avoid.find((a) => a.symbol === sym)?.why || "" })) };
  }
  /** Company targets across the held industries: industry target x within-industry weight. */
  function companyTargets(held, picksBy) {
    const T = {}; for (const h of held) for (const p of picksBy[h.name]?.picks || []) T[p.symbol] = (T[p.symbol] || 0) + h.target * p.within;
    return T;
  }

  // ------------------------------------------------------------------ 4. ETFs that hold them
  const MUTUAL = /^[A-Z]{4}X$/;
  /**
   * Candidate ETFs from FMP's reverse lookup (etf-asset-exposure for each target company): US-listed tickers only, no
   * mutual funds, no single-stock or leveraged products (a position above 25% of the fund), fund size from the position's
   * value over its weight. exposures: {companySymbol: [{symbol (fund), weightPercentage, marketValue}]}.
   */
  function discover(exposures, T, { minAum = 2e8, exclude = [] } = {}) {
    const C = new Map(), ex = new Set(exclude);
    for (const [co, list] of Object.entries(exposures || {})) for (const x of list || []) {
      const s = String(x.symbol || x.etfSymbol || "").toUpperCase(), w = n(x.weightPercentage) / 100, mv = n(x.marketValue);
      if (!/^[A-Z]{2,5}$/.test(s) || MUTUAL.test(s) || ex.has(s) || !(w > 0) || w > 0.25) continue;
      const aum = mv > 0 ? mv / w : NaN; const e = C.get(s) || { symbol: s, hits: {}, aum: 0 }; e.hits[co] = Math.max(e.hits[co] || 0, w); if (isNum(aum)) e.aum = Math.max(e.aum, aum); C.set(s, e);
    }
    const tot = Object.values(T).reduce((a, x) => a + x, 0) || 1;
    return [...C.values()].filter((e) => e.aum >= minAum).map((e) => {
      const purity = Object.values(e.hits).reduce((a, x) => a + x, 0); // share of the fund in target companies
      const align = Object.entries(e.hits).reduce((a, [co, w]) => a + (T[co] || 0) * w, 0) / tot; // the target it captures per dollar
      const breadth = Object.keys(e.hits).length;
      return { ...e, purity, align, breadth, score: purity * 0.6 + Math.sqrt(align) * 2 + Math.log10(e.aum) * 0.05 };
    }).sort((a, b) => b.score - a.score);
  }
  /** Per ETF: industry exposure, company exposure and the full look-through for overlap (weights 0-1). mapped: Portfolio.mapHoldings rows. */
  function vectors(mapped) {
    const tot = (mapped || []).reduce((a, h) => a + (n(h.weight) || 0), 0) || 1, ind = {}, cos = {};
    for (const h of mapped || []) { const w = (n(h.weight) || 0) / tot; if (h.industry) ind[h.industry] = (ind[h.industry] || 0) + w; else ind[h.kind === "stock" ? "(unmapped stocks)" : `(${h.kind || "other"})`] = (ind[h.kind === "stock" ? "(unmapped stocks)" : `(${h.kind || "other"})`] || 0) + w; if (h.ticker) cos[h.ticker] = (cos[h.ticker] || 0) + w; }
    const effN = 1 / Object.values(cos).reduce((a, x) => a + x * x, 0);
    return { ind, cos, effN, n: (mapped || []).length };
  }
  /** Overlap between two funds: the share of each that is the same stocks (sum of the smaller weight). */
  function overlap(a, b) { let s = 0; const [x, y] = Object.keys(a || {}).length < Object.keys(b || {}).length ? [a, b] : [b, a]; for (const [t, v] of Object.entries(x || {})) s += Math.min(v, n(y?.[t]) || 0); return s; }

  // ------------------------------------------------------------------ 5. the ETF mix
  const matvec = (A, x) => A.map((r) => r.reduce((s, a, j) => s + a * x[j], 0));
  function project(y, lo, hi) {
    let a = Math.min(...y.map((v, i) => v - hi[i])) - 1, b = Math.max(...y.map((v, i) => v - lo[i])) + 1; const f = (t) => y.reduce((s, v, i) => s + clamp(v - t, lo[i], hi[i]), 0) - 1;
    for (let it = 0; it < 70; it++) { const m = (a + b) / 2; if (f(m) > 0) a = m; else b = m; } const t = (a + b) / 2; return y.map((v, i) => clamp(v - t, lo[i], hi[i]));
  }
  /** min 1/2 w'Qw - c'w over 0 <= w <= hi, sum w = 1, A w <= b; projected gradient, augmented Lagrangian, optional L1 pull to w0. */
  function qp(Q, c, { hi, rows = [], w0 = null, kappa = 0, start = null, iters = 3000 }) {
    const k = c.length; let L = 0; for (let i = 0; i < k; i++) L = Math.max(L, Q[i].reduce((s, v) => s + Math.abs(v), 0)); const rho = 30; L += rho * rows.reduce((s, r) => s + r.a.reduce((t, v) => t + v * v, 0), 0) + 1e-9;
    const step = 1 / L, nu = rows.map(() => 0), lo = new Array(k).fill(0); let w = project(start || w0 || new Array(k).fill(1 / k), lo, hi);
    for (let it = 0; it < iters; it++) {
      const g = matvec(Q, w).map((v, i) => c[i] - v);
      rows.forEach((r, j) => { const v = r.a.reduce((s, a, i) => s + a * w[i], 0) - r.b + nu[j] / rho; if (v > 0) for (let i = 0; i < k; i++) g[i] -= rho * v * r.a[i]; });
      let y = w.map((v, i) => v + step * g[i]); if (w0 && kappa > 0) y = y.map((v, i) => { const d = v - w0[i], t = step * kappa; return w0[i] + Math.sign(d) * Math.max(0, Math.abs(d) - t); });
      const nw = project(y, lo, hi), mv = nw.reduce((s, v, i) => Math.max(s, Math.abs(v - w[i])), 0); w = nw;
      if (it % 40 === 39) rows.forEach((r, j) => { nu[j] = Math.max(0, nu[j] + rho * (r.a.reduce((s, a, i) => s + a * w[i], 0) - r.b)); });
      if (mv < 1e-9 && it > 60) break;
    }
    return w;
  }
  /**
   * The ETF weights. cands: [{symbol, vec: {ind, cos}, bucket (bonds), cov row index, mu, expense, isBond}]; target:
   * {industries: {name: w}, buckets: {bucket: w}, companies: {sym: w}}; cov: annualized covariance over cands.
   * Objective: industry tracking (alpha), company targets (beta), overlap (gamma), off-target (in the tracking: the
   * target of an industry not held is zero), risk (lambda, raised until volatility is under the ceiling), costs, and a
   * small pull toward the higher expected returns (delta).
   */
  function mix(cands, target, cov, goal, { alpha = 6, beta = 4, gamma = 0.8, delta = 0.1, w0 = null, kappa = 0, maxN = goal.maxN, volCap = goal.vol, keep = [] } = {}) {
    let live = cands.map((_, i) => i); const cap = (goal.cap || 15) / 100, minW = (goal.minW || 3) / 100;
    const keys = [...new Set([...Object.keys(target.industries), ...Object.keys(target.buckets).map((b) => "B:" + b), ...cands.flatMap((c) => (c.isBond ? ["B:" + c.bucket] : Object.keys(c.vec?.ind || {})))])];
    const tv = keys.map((k) => (k.startsWith("B:") ? target.buckets[k.slice(2)] || 0 : target.industries[k] || 0));
    const coKeys = Object.keys(target.companies), Tv = coKeys.map((s) => target.companies[s]);
    const X = keys.map((k) => cands.map((c) => (c.isBond ? (k === "B:" + c.bucket ? 1 : 0) : n(c.vec?.ind?.[k]) || 0)));
    const C = coKeys.map((s) => cands.map((c) => n(c.vec?.cos?.[s]) || 0));
    const O = cands.map((a, i) => cands.map((b, j) => (i === j || a.isBond || b.isBond ? 0 : overlap(a.vec?.cos, b.vec?.cos))));
    const solveOn = (idx, lam) => {
      const m = idx.length, Q = Array.from({ length: m }, () => new Array(m).fill(0)), c = new Array(m).fill(0);
      for (let a = 0; a < m; a++) { const i = idx[a];
        for (let b = 0; b < m; b++) { const j = idx[b]; let q = 0; for (let r = 0; r < keys.length; r++) q += X[r][i] * X[r][j]; let qc = 0; for (let r = 0; r < coKeys.length; r++) qc += C[r][i] * C[r][j];
          Q[a][b] = 2 * alpha * q + 2 * beta * qc + gamma * (O[i][j] + O[j][i]) + lam * cov[i][j]; }
        let l = 0; for (let r = 0; r < keys.length; r++) l += X[r][i] * tv[r]; let lc2 = 0; for (let r = 0; r < coKeys.length; r++) lc2 += C[r][i] * Tv[r];
        c[a] = 2 * alpha * l + 2 * beta * lc2 + delta * (n(cands[i].mu) || 0) - (n(cands[i].expense) || 0); }
      // Bonds held to the sleeve the allocation chose (within 2pp, inside the goal's band).
      const bt = Object.values(target.buckets).reduce((a2, x) => a2 + x, 0), bHi = Math.min(goal.bonds[1], bt + 0.02) + 0.005, bLo = Math.max(goal.bonds[0], bt - 0.02) - 0.005;
      const rows = [], bondA = idx.map((i) => (cands[i].isBond ? 1 : 0)); if (bondA.some(Boolean)) { rows.push({ a: bondA, b: bHi }); if (bLo > 0) rows.push({ a: bondA.map((x) => -x), b: -bLo }); }
      for (let r = 0; r < coKeys.length; r++) { const a = idx.map((i) => C[r][i]); if (a.some((v) => v * cap > (goal.stockCap || 0.08) * 0.8)) rows.push({ a, b: goal.stockCap || 0.08 }); }
      const hard = idx.map((i) => (cands[i].hard ? 1 : 0)); if (hard.some(Boolean)) rows.push({ a: hard, b: 0.1 });
      const vol = (w) => Math.sqrt(Math.max(0, w.reduce((s, x, a) => s + x * w.reduce((t, y, b) => t + y * cov[idx[a]][idx[b]], 0), 0)));
      const go = (L2) => qp(Q.map((r, a) => r.map((v, b) => v + (L2 - lam) * cov[idx[a]][idx[b]])), c, { hi: idx.map(() => cap), rows, w0: w0 ? idx.map((i) => w0[i]) : null, kappa, iters: 2000 });
      let w = go(lam), L2 = lam; for (let it = 0; it < 10 && vol(w) > volCap; it++) { L2 = L2 * 2.5 + 0.5; w = go(L2); }
      return { w, vol: vol(w), lam: L2 };
    };
    let best = null;
    // Prune gradually: drop the weaker half of the positions under the minimum (or over the count) and solve again,
    // so weight spread thin across similar funds consolidates into the best of them instead of vanishing.
    for (let round = 0; round < 16; round++) {
      if (live.length * cap < 1 - 1e-9) break;
      const r = solveOn(live, 0.05); best = { idx: live.slice(), ...r };
      const nz = live.map((i, a) => [i, r.w[a]]).sort((a, b) => a[1] - b[1]), small = nz.filter(([i, x]) => x < minW - 1e-9 && !keep.includes(i)), over = Math.max(0, live.length - maxN);
      if (!small.length && !over) break;
      const cut = Math.max(1, small.length ? Math.ceil(small.length / 2) : Math.ceil(over / 2)), drop = new Set((small.length ? small : nz.filter(([i]) => !keep.includes(i))).slice(0, cut).map(([i]) => i));
      const next = live.filter((i) => !drop.has(i)); if (next.length * cap < 1 - 1e-9 || next.length === live.length) break; live = next;
    }
    if (!best) return null;
    const W = new Array(cands.length).fill(0); best.idx.forEach((i, a) => (W[i] = best.w[a]));
    const r5 = W.map((x) => (x >= minW * 0.5 ? Math.round(x * 200) / 200 : 0)); let gap = Math.round((1 - r5.reduce((s, x) => s + x, 0)) * 200) / 200;
    for (const i of r5.map((_, i) => i).filter((i) => r5[i] > 0).sort((a, b) => r5[b] - r5[a])) { if (Math.abs(gap) < 1e-9) break; const room = gap > 0 ? cap - r5[i] : r5[i] - minW; const d = Math.sign(gap) * Math.min(Math.abs(gap), Math.max(0, room)); r5[i] = Math.round((r5[i] + d) * 200) / 200; gap = Math.round((gap - d) * 200) / 200; }
    return { w: r5, vol: Math.sqrt(Math.max(0, r5.reduce((s, x, i) => s + x * r5.reduce((t, y, j) => t + y * cov[i][j], 0), 0))), lam: best.lam };
  }
  /**
   * What the mix actually holds: industry distribution against the target (and the tracking gap), company capture,
   * every pair's overlap, the single-stock look-through, expected return from the industries' and bonds' views.
   */
  function achieved(w, cands, target, rows) {
    const ind = {}, cos = {}, bk = {};
    cands.forEach((c, i) => { const x = w[i] || 0; if (!x) return; if (c.isBond) { bk[c.bucket] = (bk[c.bucket] || 0) + x; return; }
      for (const [k, v] of Object.entries(c.vec?.ind || {})) ind[k] = (ind[k] || 0) + x * v; for (const [t, v] of Object.entries(c.vec?.cos || {})) cos[t] = (cos[t] || 0) + x * v; });
    const names = [...new Set([...Object.keys(ind), ...Object.keys(target.industries)])];
    const table = names.map((k) => ({ name: k, target: target.industries[k] || 0, got: ind[k] || 0 })).map((x) => ({ ...x, gap: x.got - x.target })).sort((a, b) => b.target - a.target || b.got - a.got);
    const bonds = [...new Set([...Object.keys(bk), ...Object.keys(target.buckets)])].map((k) => ({ name: k, label: BUCKETS[k] || k, target: target.buckets[k] || 0, got: bk[k] || 0 }));
    const tracking = (table.reduce((s, x) => s + Math.abs(x.gap), 0) + bonds.reduce((s, x) => s + Math.abs(x.got - x.target), 0)) / 2;
    const Tt = Object.values(target.companies).reduce((a, x) => a + x, 0) || 1, capture = Object.entries(target.companies).reduce((a, [t, v]) => a + Math.min(v, cos[t] || 0), 0) / Tt;
    const picked = cands.map((c, i) => ({ c, i, w: w[i] })).filter((x) => x.w > 0 && !x.c.isBond), pairs = [];
    for (let a = 0; a < picked.length; a++) for (let b = a + 1; b < picked.length; b++) pairs.push({ a: picked[a].c.symbol, b: picked[b].c.symbol, overlap: overlap(picked[a].c.vec?.cos, picked[b].c.vec?.cos) });
    const dup = Object.values(cos).reduce((s, v) => s, 0); // kept for symmetry
    const byRow = new Map((rows || []).map((r) => [r.name, r]));
    let expS = 0, expW = 0; for (const [k, v] of Object.entries(ind)) { const r = byRow.get(k); if (r && isNum(r.exp12)) { expS += v * r.exp12 / 100; expW += v; } }
    const stockW = Object.values(ind).reduce((a, x) => a + x, 0), covered = stockW ? expW / stockW : 0;
    const allStocks = Object.entries(cos).sort((a, b) => b[1] - a[1]).map(([t, v]) => ({ symbol: t, weight: v })), stocks = allStocks.slice(0, 25).map((x) => ({ ...x, target: target.companies[x.symbol] || 0 }));
    return { industries: table, bonds, tracking, capture, pairs: pairs.sort((x, y) => y.overlap - x.overlap), stocks, allStocks: allStocks.slice(0, 400), stockShare: stockW, industryExp: expW ? expS / expW : NaN, covered, dup };
  }

  // ------------------------------------------------------------------ 6. opportunities
  /**
   * The strongest cases, with the purest way to play each: industries with high conviction that the market weight
   * doesn't reflect, cheap and upgraded industries, dated catalysts inside the horizon, and the best-scored companies.
   * etfFor: (industryName) => [{symbol, purity}] from the candidates.
   */
  function opportunities(rows, tgt, picksBy, goal, { today = new Date().toISOString().slice(0, 10), etfFor = () => [] } = {}) {
    const out = [], months = HZ_M[goal.horizon] || 12, until = new Date(Date.parse(today) + months * 31 * 864e5).toISOString().slice(0, 10);
    const top = rows.filter((r) => r.z > 0.4).sort((a, b) => b.z - a.z).slice(0, 8);
    for (const r of top) { const t = tgt.rows.find((x) => x.name === r.name); out.push({ kind: "conviction", industry: r.name, sector: r.sector, z: r.z, active: t?.active || 0, call: r.call, exp12: r.exp12, pe_pct: r.pe_pct, verdict: r.verdict, why: r.reasons.map((x) => `${x.label} ${x.x > 0 ? "+" : ""}${x.x.toFixed(2)}`).join("; "), companies: (picksBy[r.name]?.picks || []).slice(0, 3).map((p) => p.symbol), etfs: etfFor(r.name).slice(0, 3) }); }
    const cheap = rows.filter((r) => isNum(r.pe_pct) && r.pe_pct < 0.3 && (r.callN > 0 || r.rev30 > 0) && !top.includes(r)).sort((a, b) => a.pe_pct - b.pe_pct).slice(0, 4);
    for (const r of cheap) out.push({ kind: "value", industry: r.name, sector: r.sector, z: r.z, call: r.call, exp12: r.exp12, pe_pct: r.pe_pct, why: `P/E in the ${Math.round(r.pe_pct * 100)}th percentile of its history while the call is ${r.call || "n/a"}${isNum(r.rev30) ? ` and estimates moved ${(r.rev30 * 100).toFixed(1)}% in 30 days` : ""}`, companies: (picksBy[r.name]?.picks || []).slice(0, 3).map((p) => p.symbol), etfs: etfFor(r.name).slice(0, 3) });
    const cat = []; for (const r of rows.filter((x) => tgt.held.some((h) => h.name === x.name) || x.z > 0.3)) for (const e of r.events || []) if (e.date >= today && e.date <= until && /high|critical/.test(lc(e.importance))) cat.push({ kind: "catalyst", industry: r.name, date: e.date, title: e.title, detail: e.detail, z: r.z });
    out.push(...cat.sort((a, b) => (a.date < b.date ? -1 : 1)).slice(0, 8));
    return out;
  }

  // ------------------------------------------------------------------ the report card
  const GRADE_W = {
    growth: { alignment: 0.18, conviction: 0.2, quality: 0.15, diversification: 0.14, risk: 0.1, cost: 0.08, expected: 0.1, fit: 0.05 },
    aggressive: { conviction: 0.24, expected: 0.18, alignment: 0.14, quality: 0.14, diversification: 0.1, risk: 0.05, cost: 0.08, fit: 0.07 },
    income: { income: 0.24, risk: 0.14, quality: 0.14, alignment: 0.12, diversification: 0.1, cost: 0.1, conviction: 0.08, fit: 0.08 },
    conservative: { risk: 0.24, diversification: 0.15, quality: 0.14, alignment: 0.12, cost: 0.1, income: 0.08, conviction: 0.08, fit: 0.09 },
  };
  const LETTERS = [[90, "A"], [85, "A-"], [80, "B+"], [75, "B"], [70, "B-"], [65, "C+"], [60, "C"], [55, "C-"], [45, "D"], [0, "F"]];
  const letterOf = (s) => (isNum(s) ? LETTERS.find(([t]) => s >= t)[1] : "—");
  const lin = (x, a, b) => (isNum(x) ? clamp(((x - a) / (b - a)) * 100, 0, 100) : NaN);
  /**
   * Grade a portfolio for the goal, 0-100 with a letter, from eight parts: alignment with the target industry mix,
   * the industry runs' conviction behind what it holds, the quality of its companies by the runs' rankings,
   * diversification (effective stocks, the largest single stock, overlap), risk against the ceiling, cost, income, the
   * industry-implied return against the market's, and fit with the goal's bond band.
   * x: {ach (EtfStrat.achieved), conv (weighted conviction of its stock industries), quality (0-100), vol, cost, yield, bonds, mktExp, maxOverlap}
   */
  function grade(x, goal) {
    const W = GRADE_W[goal.type] || GRADE_W.growth, P = {}, a = x.ach || {};
    const effN = (() => { const s = (a.allStocks || a.stocks || []).reduce((t, v) => t + (v.weight / (a.stockShare || 1)) ** 2, 0); return s > 0 ? 1 / s : NaN; })(), maxS = n(a.stocks?.[0]?.weight);
    P.alignment = { score: isNum(a.tracking) ? 100 * (1 - clamp(a.tracking / 0.7, 0, 1)) : NaN, value: a.tracking, label: "Industry mix vs the target", note: isNum(a.tracking) ? `${Math.round(a.tracking * 100)}% of it sits in other industries than the runs' target` : "" };
    P.conviction = { score: isNum(x.conv) ? 50 + 48 * Math.tanh(x.conv / 0.45) : NaN, value: x.conv, label: "Conviction behind its industries", note: isNum(x.conv) ? `weighted conviction ${x.conv > 0 ? "+" : ""}${x.conv.toFixed(2)} (0 = the market)` : "" };
    P.quality = { score: isNum(x.quality) ? clamp((x.quality - 30) * 1.6, 0, 100) : NaN, value: x.quality, label: "Quality of its companies", note: isNum(x.quality) ? `average rank score ${Math.round(x.quality)} for this investor type` : "" };
    const dv = [lin(Math.log(effN), Math.log(8), Math.log(120)), isNum(maxS) ? clamp(100 - Math.max(0, maxS - 0.05) * 800, 0, 100) : NaN, isNum(x.maxOverlap) ? clamp(100 - Math.max(0, x.maxOverlap - 0.25) * 200, 0, 100) : NaN].filter(isNum);
    P.diversification = { score: dv.length ? dv.reduce((s2, v) => s2 + v, 0) / dv.length : NaN, value: effN, label: "Diversification", note: `${isNum(effN) ? `about ${Math.round(effN)} effective stocks` : ""}${isNum(maxS) ? `, largest single stock ${(maxS * 100).toFixed(1)}%` : ""}${isNum(x.maxOverlap) && x.maxOverlap > 0.25 ? `, funds overlap up to ${Math.round(x.maxOverlap * 100)}%` : ""}` };
    P.risk = { score: isNum(x.vol) ? clamp(100 - Math.max(0, x.vol / goal.vol - 0.8) * 125, 0, 100) : NaN, value: x.vol, label: "Risk vs the goal", note: isNum(x.vol) ? `volatility ${(x.vol * 100).toFixed(1)}% against a ${(goal.vol * 100).toFixed(0)}% ceiling` : "" };
    P.cost = { score: lin(-x.cost, -0.0075, -0.0005), value: x.cost, label: "Cost", note: isNum(x.cost) ? `${(x.cost * 100).toFixed(2)}% a year` : "" };
    P.income = { score: lin(x.yield, 0.005, goal.type === "income" ? 0.05 : 0.035), value: x.yield, label: "Income", note: isNum(x.yield) ? `yield ${(x.yield * 100).toFixed(2)}%` : "" };
    P.expected = { score: isNum(a.industryExp) ? clamp(50 + (a.industryExp - (isNum(x.mktExp) ? x.mktExp : 0.05)) * 600, 0, 100) : NaN, value: a.industryExp, label: "What the runs expect", note: isNum(a.industryExp) ? `industries imply ${(a.industryExp * 100).toFixed(1)}% over 12 months${isNum(x.mktExp) ? ` (market ${(x.mktExp * 100).toFixed(1)}%)` : ""}` : "" };
    const lo = goal.bonds[0], hi = goal.bonds[1], b = n(x.bonds) || 0, off = b < lo ? lo - b : b > hi ? b - hi : 0;
    P.fit = { score: clamp(100 - off * 300, 0, 100), value: b, label: "Fit with the goal", note: `bonds ${(b * 100).toFixed(0)}% (the goal's band ${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}%)` };
    let s = 0, w = 0; for (const [k, wt] of Object.entries(W)) if (isNum(P[k]?.score)) { s += wt * P[k].score; w += wt; }
    const score = w ? s / w : NaN;
    for (const k of Object.keys(P)) { P[k].weight = W[k] || 0; P[k].letter = letterOf(P[k].score); }
    return { score, letter: letterOf(score), parts: P };
  }

  // ------------------------------------------------------------------ the analysts' dossier and prompts
  const pc = (x, d = 1) => (isNum(x) ? `${(x * 100).toFixed(d)}%` : "n/a");
  const f1 = (x, d = 1) => (isNum(x) ? Number(x).toFixed(d) : "n/a");
  /**
   * Every fact the analysts may cite, by id: G goal, R curve, B bond sleeve, I# industries (held, then avoided), C#
   * companies, E# ETFs, A achieved mix, O# opportunities, S# stress, W# world/trade/regulation across the mix.
   */
  function dossier(ctx) {
    const { goal, curve, rows, tgt, sleeve, picksBy, sel, ach, cands, opps = [], stressRes = null, lens = null, improve = null } = ctx, L = [], ids = { I: {}, C: {}, E: {} };
    L.push(`[G1] Goal: ${goal.label} investor, horizon ${goal.horizon}, volatility ceiling ${pc(goal.vol, 0)}, bonds ${pc(goal.bonds[0], 0)}-${pc(goal.bonds[1], 0)}, any industry at most ${pc(goal.industryCap, 0)}, any sector at most ${pc(goal.sectorCap, 0)}, every ETF 3-15%, ${goal.minN}-${goal.maxN} ETFs.`);
    if (curve) L.push(`[R1] Treasury curve ${curve.date || ""}: 3M ${curve.month3}%, 2Y ${curve.year2}%, 5Y ${curve.year5}%, 10Y ${curve.year10}%, 30Y ${curve.year30}%.`);
    if (sleeve?.share > 0) L.push(`[B1] Bond sleeve ${pc(sleeve.share, 0)}: ${Object.entries(sleeve.buckets).map(([k, v]) => `${BUCKETS[k]} ${pc(v)}`).join(", ")}. ${sleeve.notes.join(" ")}`);
    const regimes = {}; for (const r of rows) if (r.regime) regimes[r.regime] = (regimes[r.regime] || 0) + r.mkt; L.push(`[M1] How the industry runs read the macro, by market weight: ${Object.entries(regimes).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ${pc(v, 0)}`).join(", ") || "n/a"}.`);
    let i = 0;
    for (const t of [...tgt.held, ...tgt.avoided.slice(0, 6)]) { const r = tgt.by.get(t.name); if (!r) continue; const id = "I" + ++i; ids.I[t.name] = id;
      L.push(`[${id}] ${r.name} (${r.sector}, ${r.kind === "full" ? "full run" : "code-only"}): target ${pc(t.target)} vs market ${pc(t.market)}${t.avoided ? " AVOIDED" : ""}; conviction ${f1(r.z, 2)} (${r.reasons.map((x) => `${x.label} ${x.x > 0 ? "+" : ""}${x.x.toFixed(2)}`).join("; ")}); ${goal.type} score ${f1(r.score, 0)}; ${goal.horizon} call ${r.call || "n/a"}, 12M ${r.call12 || "n/a"}; expected 12M ${f1(r.exp12)}%; scenarios bull ${f1(r.bull.p, 0)}%/${f1(r.bull.move, 0)}%, bear ${f1(r.bear.p, 0)}%/${f1(r.bear.move, 0)}%; P/E ${f1(r.pe)} (fwd ${f1(r.fwd_pe)}, ${isNum(r.pe_pct) ? Math.round(r.pe_pct * 100) + "th pct of history" : "history n/a"}${r.priced ? ", priced in: " + r.priced : ""}); EPS growth ${f1(r.eps_growth)}%; revisions 30d ${pc(r.rev30)}; div ${pc(r.div, 2)}; vol ${pc(r.vol, 0)}, max DD ${pc(r.mdd, 0)}; strategist: ${r.verdict || "n/a"}. Headline: ${String(r.headline).slice(0, 200)}${r.reads.macro ? ` Macro: ${r.reads.macro}` : ""}${r.reads.world ? ` World: ${r.reads.world}` : ""}${r.reads.trade ? ` Trade: ${r.reads.trade}` : ""}${r.reads.reg ? ` Regulation: ${r.reads.reg}` : ""}`); }
    let c = 0;
    for (const t of tgt.held) for (const p of (picksBy[t.name]?.picks || []).slice(0, 3)) { const id = "C" + ++c; ids.C[p.symbol] = id; const x = p.c || {};
      L.push(`[${id}] ${p.symbol} ${p.name} in ${t.name}: target ${pc(t.target * p.within, 2)}; ${goal.type} rank score ${f1(p.profile, 0)}, composite ${f1(p.composite, 0)}; factors ${Object.entries(p.factors).filter(([, v]) => isNum(v)).map(([k, v]) => `${k} ${v}`).join(", ")}; P/E ${f1(x.pe)}, fwd ${f1(x.fwd_pe)}, NTM growth ${pc(x.ntm_growth)}, op margin ${pc(x.op_margin)}, div ${pc(x.div_yield, 2)}, 1Y ${pc(x.ret_1Y)}${p.strategist ? `; lead strategist: ${p.strategist}` : ""}.`); }
    let e = 0;
    cands.forEach((cd, j) => { if (!(sel.w[j] > 0)) return; const id = "E" + ++e; ids.E[cd.symbol] = id; const v = cd.vec || {};
      const tgtShare = Object.entries(v.cos || {}).reduce((a, [t, x]) => a + (ctx.target.companies[t] ? x : 0), 0), heldInd = Object.entries(v.ind || {}).reduce((a, [k, x]) => a + (ctx.target.industries[k] ? x : 0), 0);
      L.push(`[${id}] ${cd.symbol} ${cd.info?.name || ""}: weight ${pc(sel.w[j])}; ${cd.isBond ? `${BUCKETS[cd.bucket]}, yield ${pc(cd.yield, 2)}, duration ~${f1(cd.e?.duration)}y` : `${pc(tgtShare)} in target companies, ${pc(heldInd)} in target industries, ${v.n || "?"} holdings (effective ${f1(v.effN, 0)}), top: ${Object.entries(v.cos || {}).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t, x]) => `${t} ${pc(x)}`).join(", ")}; biggest industries ${Object.entries(v.ind || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, x]) => `${k} ${pc(x, 0)}`).join(", ")}`}; cost ${pc(cd.expense, 2)}; assets $${f1(n(cd.info?.assetsUnderManagement) / 1e9)}B; vol ${pc(cd.q?.vol, 0)}, beta ${f1(cd.q?.beta, 2)}, 1Y ${pc(cd.q?.r1y)}, 3Y/yr ${pc(cd.q?.r3y)}; found via ${cd.via || "the curated list"}.`); });
    L.push(`[A1] The mix: ${sel.w.filter((x) => x > 0).length} ETFs; tracks the target industry distribution within ${pc(ach.tracking)} (half the sum of gaps); captures ${pc(ach.capture, 0)} of the company targets; industry-implied expected 12M return of the stock sleeve ${pc(ach.industryExp)} (on ${pc(ach.covered, 0)} covered); volatility ${pc(sel.vol)}; biggest overlaps ${ach.pairs.slice(0, 3).map((p) => `${p.a}/${p.b} ${pc(p.overlap, 0)}`).join(", ") || "none"}; biggest look-through stocks ${ach.stocks.slice(0, 6).map((s) => `${s.symbol} ${pc(s.weight)}`).join(", ")}.`);
    opps.forEach((o, k) => L.push(`[O${k + 1}] ${o.kind === "catalyst" ? `Catalyst ${o.date}: ${o.title} (${o.industry})${o.detail ? " - " + o.detail : ""}` : `${o.kind === "value" ? "Value" : "Conviction"}: ${o.industry} (conviction ${f1(o.z, 2)}, call ${o.call || "n/a"}, expected ${f1(o.exp12)}%${isNum(o.active) ? `, active ${pc(o.active)}` : ""}): ${o.why}; best companies ${o.companies.join(", ") || "n/a"}; purest ETFs ${(o.etfs || []).map((x) => `${x.symbol} (${pc(x.purity, 0)} in the industry)`).join(", ") || "n/a"}`}.`));
    (stressRes?.episodes || []).forEach((s, k) => L.push(`[S${k + 1}] ${s.label} (${s.from} to ${s.to}): the mix ${pc(s.ret)}, SPY ${pc(s.spy)}.`));
    (stressRes?.hypo || []).forEach((s, k) => L.push(`[S${k + 6}] ${s.label}: about ${pc(s.ret)}.`));
    if (lens) { (lens.world || []).slice(0, 5).forEach((x, k) => L.push(`[W${k + 1}] World: ${x.title} reaches ${pc(x.w, 0)} of the stock sleeve's covered industries (${pc(x.adverse, 0)} adverse, ${pc(x.favorable, 0)} favorable).`));
      (lens.trade || []).slice(0, 4).forEach((x, k) => L.push(`[W${k + 6}] Trade: ${x.country}, threat ${x.threat}, ${pc(x.w, 0)} of covered weight, revenue at stake ${pc(x.rev)}.`));
      (lens.rules || []).slice(0, 4).forEach((x, k) => L.push(`[W${k + 11}] Regulation: ${x.name} (${x.severity}, ${x.status || ""}) reaches ${pc(x.w, 0)}; ${x.bottom_line || ""}`)); }
    if (improve) L.push(`[M2] Today's portfolio: ${improve.lines}`);
    return { text: L.join("\n"), ids };
  }
  const PARTS = {
    allocation: { role: "the chief investment strategist setting the industry allocation", ask: `{"headline": "one sentence: what this portfolio is betting on",
 "thesis": "3 short paragraphs (separate with \\n): the regime and why this shape of portfolio; the biggest overweights and what has to go right; what it deliberately avoids and why",
 "industries": [{"id": "I#", "stance": "overweight | neutral | underweight | avoid", "why": "2 sentences tied to that industry's run (its call, valuation, scenarios, macro/world/trade/regulation)", "risk": "what would make it wrong"}],
 "bonds": "2-3 sentences on the bond sleeve and the curve (cite B1, R1), or why there is none",
 "horizons": {"1M": {"call": "bearish | slightly bearish | neutral | slightly bullish | bullish", "why": "1 sentence"}, "3M": {...}, "6M": {...}, "12M": {...}},
 "scenarios": {"bull": {"probability": 0-100, "return": "e.g. +18%", "narrative": "2 sentences"}, "base": {...}, "bear": {...}}}`, rule: "Cover every held industry (I#) and the avoided ones listed. Probabilities sum to 100." },
    selection: { role: "the portfolio manager choosing companies and ETFs", ask: `{"companies": [{"id": "C#", "why": "1-2 sentences: why this company is the way to own its industry for this goal"}],
 "etfs": [{"symbol": "ETF", "role": "core | industry tilt | company capture | income | ballast | diversifier", "why": "2-3 sentences: which target companies and industries it captures, why it beats the alternatives, what it costs", "watch": "what would make it a sell"}],
 "overlap": "2 sentences on overlap and gaps (cite A1)",
 "implementation": ["3 practical steps: order of buys, staging, rebalancing triggers"],
 "left_out": "2 sentences on strong candidates left out and why"}`, rule: "Cover every E# and the most important C# (at least one per held industry)." },
    risks: { role: "the head of risk and opportunities", ask: `{"opportunities": [{"title": "short", "ids": ["O#", "I#"], "why": "2 sentences", "how": "the ETF or company to express it", "horizon": "1M | 3M | 6M | 12M"}],
 "risks": [{"risk": "short", "likelihood": "low | medium | high", "impact": "low | medium | high", "why": "2 sentences tied to S#, W# or I# facts", "hedge": "what in the portfolio or what to add offsets it"}],
 "macro": "3 sentences: how the mix sits against the macro (M1, R1) and which industries carry the macro risk",
 "world": "2-3 sentences on world events, trade and regulation across the mix (W#)",
 "watch": [{"date": "YYYY-MM-DD or 'ongoing'", "what": "the catalyst or data", "why": "what it would change"}],
 "change_mind": ["3 things that would change the allocation"]}`, rule: "5-7 opportunities, 5-6 risks, 5-8 watch items." },
  };
  function prompt(part, goal, text, { improving = false } = {}) {
    const P = PARTS[part];
    return `You are ${P.role} for an ETF-only ${goal.label.toLowerCase()} portfolio${improving ? " (an improvement of the client's current holdings, M2)" : ""}. The weights were set by a quantitative process from the facts below: explain and judge them, do not change them, and do not invent numbers.

Write for a sharp investor, plainly. Every claim cites fact ids in brackets, like [I3] or [E2][S1]; use only ids that appear below. The industry facts summarize full research reports: lean on their calls, scenarios and reads.

Facts:
${text}

${P.rule}
Return JSON only:
${P.ask}`;
  }
  /** The report card's written verdict on today's portfolio (M2 carries its grades). */
  function gradePrompt(goal, text) {
    return `You are the chief investment officer grading a client's current portfolio for a ${goal.label.toLowerCase()} goal. Its grades were computed by code (M2); the target allocation and the recommended ETFs follow from the industry research below. Judge it plainly: what it does well, what is wrong, and what to change. Do not invent numbers.

Every claim cites fact ids in brackets, like [M2], [I3] or [E2]; use only ids that appear below.

Facts:
${text}

Return JSON only:
{"verdict": "3 sentences: the overall grade and the main reasons",
 "strengths": ["2-3 things it does well, with ids"],
 "weaknesses": ["3-5 problems: concentration, industries the runs are bearish on, missing industries they favor, overlap, cost, risk vs the goal; with ids"],
 "fixes": ["3-5 concrete changes, naming the ETFs (E#) and industries (I#) to add, trim or replace"]}`;
  }
  function clean(part, x, idList) {
    const ok = new Set(idList), fix = (s) => String(s || "").replace(/\[([A-Z]{1,2}\d{1,3})\]/g, (m, id) => (ok.has(id) ? m : "")).replace(/\s+([.,;])/g, "$1").trim(), arr = (a, k) => (Array.isArray(a) ? a.slice(0, k) : []);
    if (!x || typeof x !== "object") return null;
    if (part === "grade") return { verdict: fix(x.verdict), strengths: arr(x.strengths, 4).map(fix), weaknesses: arr(x.weaknesses, 6).map(fix), fixes: arr(x.fixes, 6).map(fix) };
    if (part === "allocation") return { headline: fix(x.headline), thesis: fix(x.thesis), bonds: fix(x.bonds),
      industries: arr(x.industries, 40).map((r) => ({ id: String(r?.id || ""), stance: lc(r?.stance), why: fix(r?.why), risk: fix(r?.risk) })).filter((r) => ok.has(r.id)),
      horizons: Object.fromEntries(["1M", "3M", "6M", "12M"].map((h) => [h, { call: lc(x.horizons?.[h]?.call), why: fix(x.horizons?.[h]?.why) }])),
      scenarios: Object.fromEntries(["bull", "base", "bear"].map((k) => [k, { probability: n(x.scenarios?.[k]?.probability), ret: String(x.scenarios?.[k]?.return || "").slice(0, 20), narrative: fix(x.scenarios?.[k]?.narrative) }])) };
    if (part === "selection") return { companies: arr(x.companies, 80).map((r) => ({ id: String(r?.id || ""), why: fix(r?.why) })).filter((r) => ok.has(r.id)),
      etfs: arr(x.etfs, 20).map((r) => ({ symbol: String(r?.symbol || "").toUpperCase(), role: lc(r?.role).slice(0, 30), why: fix(r?.why), watch: fix(r?.watch) })).filter((r) => r.symbol),
      overlap: fix(x.overlap), implementation: arr(x.implementation, 5).map(fix), left_out: fix(x.left_out) };
    return { opportunities: arr(x.opportunities, 8).map((o) => ({ title: String(o?.title || "").slice(0, 120), ids: arr(o?.ids, 6).filter((i) => ok.has(i)), why: fix(o?.why), how: fix(o?.how), horizon: String(o?.horizon || "").slice(0, 6) })),
      risks: arr(x.risks, 7).map((r) => ({ risk: String(r?.risk || "").slice(0, 140), likelihood: lc(r?.likelihood), impact: lc(r?.impact), why: fix(r?.why), hedge: fix(r?.hedge) })),
      macro: fix(x.macro), world: fix(x.world), watch: arr(x.watch, 10).map((w) => ({ date: String(w?.date || "").slice(0, 10), what: fix(w?.what), why: fix(w?.why) })), change_mind: arr(x.change_mind, 4).map(fix) };
  }
  const idsOf = (text) => [...new Set([...String(text).matchAll(/^\[([A-Z]{1,2}\d{1,3})\]/gm)].map((m) => m[1]))];

  const EtfStrat = { gradePrompt, grade, letterOf, GRADE_W, STYLE, BUCKETS, CALLN, industryRows, conviction, waterfill, targetIndustries, bucketOf, bondSleeve, pickCompanies, companyTargets, discover, vectors, overlap, qp, mix, achieved, opportunities, dossier, prompt, clean, idsOf, PARTS };
  if (typeof module !== "undefined" && module.exports) module.exports = EtfStrat;
  else root.EtfStrat = EtfStrat;
})(typeof globalThis !== "undefined" ? globalThis : this);
