/**
 * PfDeep: the whole-portfolio analysis of a recommended ETF mix (code computes every number; a strategist writes the memo).
 *
 * 1. Track record: the mix held at today's weights (rebalanced daily) through up to seven years of dividend-adjusted
 *    prices, measured like a fund against the S&P 500 (EtfDeep.stats: periods, calendar years, risk, drawdowns,
 *    rolling windows), next to today's portfolio measured the same way.
 * 2. Where the risk comes from: each ETF's share of the portfolio's variance, the diversification ratio, and the
 *    correlations between the ETFs.
 * 3. Forward projection: 5,000 simulated paths per horizon (1, 3, 5, 10 years), resampling six-month blocks of the
 *    mix's and the S&P 500's real monthly returns together (so crashes, rebounds and the way they move together are
 *    kept), shifted to the expected returns the recommender uses. Percentiles of the dollar value, the chance of a
 *    loss, of beating the S&P 500 and of a 20% fall along the way. Then the industry runs' bull, base and bear
 *    scenarios rolled up through the mix's industries.
 * 4. What you really own: the mix's industries against the market's on valuation, growth, revisions, margins,
 *    returns on equity, yield, beta and the runs' calls; the 25 largest companies underneath with their numbers and
 *    the run's score for this investor; the earnings reports and dated catalysts coming up.
 * Pure functions; the page fetches and asks.
 */
(function (root) {
  "use strict";
  const n = (x) => (x === null || x === undefined || x === "" ? NaN : Number(x));
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const quant = (a, q) => { const s = a.filter(isNum).sort((x, y) => x - y); if (!s.length) return NaN; const p = (s.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p); return s[lo] + (s[hi] - s[lo]) * (p - lo); };
  const mean = (a) => { const b = a.filter(isNum); return b.length ? b.reduce((s, x) => s + x, 0) / b.length : NaN; };
  const Deep = typeof module !== "undefined" && module.exports ? require("./etfdeep.js") : root.EtfDeep;
  const RF = 0.04, ERP = 0.05;

  // ------------------------------------------------------------------ 1. the mix as one fund
  /**
   * Daily NAV of fixed weights, rebalanced daily, on SPY's calendar. A fund without a price that day is left out and the
   * rest renormalized; the series starts once funds holding 85% of the weight trade. holdings: [{symbol, w}].
   */
  function nav(series, holdings, spy) {
    const H = (holdings || []).filter((h) => h.w > 0 && series[h.symbol]?.dates?.length), W = H.reduce((s, h) => s + h.w, 0);
    if (!H.length || !spy?.dates?.length) return null;
    const maps = H.map((h) => new Map(series[h.symbol].dates.map((d, i) => [d, series[h.symbol].closes[i]])));
    const dates = [], closes = []; let v = 100, started = false;
    for (let t = 1; t < spy.dates.length; t++) {
      const d0 = spy.dates[t - 1], d1 = spy.dates[t]; let r = 0, w = 0;
      H.forEach((h, k) => { const a = maps[k].get(d0), b = maps[k].get(d1); if (a > 0 && b > 0) { r += h.w * (b / a - 1); w += h.w; } });
      if (!started) { if (w < 0.85 * W) continue; started = true; dates.push(d0); closes.push(v); }
      if (w > 0) v *= 1 + r / w; dates.push(d1); closes.push(v);
    }
    return dates.length > 250 ? { dates, closes } : null;
  }
  /** Each ETF's share of the portfolio's variance, the diversification ratio and the correlations. idx: held indices. */
  function riskSplit(w, idx, cov, syms) {
    const A = (i, j) => n(cov?.[i]?.[j]); // the recommender's covariance is already yearly
    let v = 0; for (const i of idx) for (const j of idx) v += w[i] * w[j] * A(i, j);
    const vol = Math.sqrt(Math.max(v, 0));
    const rows = idx.map((i) => { let m = 0; for (const j of idx) m += w[j] * A(i, j); const s = Math.sqrt(Math.max(A(i, i), 0)); return { symbol: syms[i], weight: w[i], vol: s, contrib: v > 0 ? (w[i] * m) / v : NaN, corr_mix: vol > 0 && s > 0 ? m / (vol * s) : NaN }; }).sort((a, b) => b.contrib - a.contrib);
    const dr = vol > 0 ? rows.reduce((s, r) => s + r.weight * r.vol, 0) / vol : NaN;
    const corr = idx.map((i) => idx.map((j) => { const d = Math.sqrt(A(i, i) * A(j, j)); return d > 0 ? A(i, j) / d : NaN; }));
    return { vol, rows, diversification: dr, corr, syms: idx.map((i) => syms[i]) };
  }

  // ------------------------------------------------------------------ 3. projection
  function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  /** Monthly returns of two daily series on the months both have. */
  function monthlyPair(a, b) {
    const ma = Deep.monthly(a), mb = new Map(Deep.monthly(b).map((x) => [x.month, x.close])), out = [];
    for (let i = 1; i < ma.length; i++) { const p = mb.get(ma[i - 1].month), q = mb.get(ma[i].month); if (p > 0 && q > 0) out.push([ma[i].close / ma[i - 1].close - 1, q / p - 1]); }
    return out;
  }
  /**
   * Simulated outcomes. pairs: [[mix, spy] monthly returns]; mu, muS: expected yearly returns; amount: dollars.
   * Six-month blocks keep momentum and crashes; each series is shifted so its average matches its expected return.
   */
  function project(pairs, { mu, muS, amount = 10000, years = [1, 3, 5, 10], paths = 5000, block = 6, seed = 7 } = {}) {
    if (!pairs || pairs.length < 24 || !isNum(mu)) return null;
    const lg = (x) => Math.log(1 + x), m0 = mean(pairs.map((p) => lg(p[0]))), s0 = mean(pairs.map((p) => lg(p[1])));
    const tm = Math.log(1 + mu) / 12, ts = Math.log(1 + (isNum(muS) ? muS : RF + ERP)) / 12;
    const P = pairs.map(([a, b]) => [lg(a) - m0 + tm, lg(b) - s0 + ts]), R = rng(seed), N = P.length, T = 12 * Math.max(...years);
    const ends = Object.fromEntries(years.map((y) => [y, { v: [], s: [], dd: [] }]));
    for (let k = 0; k < paths; k++) {
      let a = 0, b = 0, peak = 0, worst = 0, t = 0;
      while (t < T) { const st = Math.floor(R() * N); for (let j = 0; j < block && t < T; j++, t++) { const [x, y] = P[(st + j) % N]; a += x; b += y; peak = Math.max(peak, a); worst = Math.min(worst, a - peak);
        if (ends[(t + 1) / 12]) { const e = ends[(t + 1) / 12]; e.v.push(Math.exp(a)); e.s.push(Math.exp(b)); e.dd.push(Math.exp(worst) - 1); } } }
    }
    const out = {};
    for (const y of years) { const e = ends[y], v = e.v;
      out[y] = { years: y, p5: amount * quant(v, 0.05), p25: amount * quant(v, 0.25), p50: amount * quant(v, 0.5), p75: amount * quant(v, 0.75), p95: amount * quant(v, 0.95), mean: amount * mean(v),
        spy50: amount * quant(e.s, 0.5), p_loss: v.filter((x) => x < 1).length / v.length, p_beat: v.filter((x, i) => x > e.s[i]).length / v.length,
        p_fall20: e.dd.filter((x) => x <= -0.2).length / e.dd.length, median_annual: quant(v, 0.5) ** (1 / y) - 1, bad_annual: quant(v, 0.05) ** (1 / y) - 1 }; }
    return { amount, mu, muS, months: N, paths, horizons: out };
  }
  /** The industry runs' bull, base and bear scenarios rolled up through the mix (stocks by industry, bonds at their carry). */
  function scenarios(ach, byRow, { bonds = 0, bondMu = RF } = {}) {
    const inds = (ach?.industries || []).filter((x) => x.got > 0 && byRow.get(x.name)), tot = inds.reduce((s, x) => s + x.got, 0), share = ach?.stockShare || 0;
    if (!tot) return null;
    const out = {};
    for (const k of ["bull", "base", "bear"]) { let r = 0, p = 0, w = 0;
      for (const x of inds) { const s = byRow.get(x.name)[k] || {}; if (isNum(n(s.move)) && isNum(n(s.p))) { r += x.got * n(s.move); p += x.got * n(s.p); w += x.got; } }
      out[k] = w ? { stocks: r / w / 100, probability: p / w, portfolio: share * (r / w / 100) + bonds * bondMu } : null; }
    const ps = ["bull", "base", "bear"].map((k) => out[k]?.probability || 0), S = ps.reduce((a, b) => a + b, 0);
    out.expected = S ? ["bull", "base", "bear"].reduce((a, k, i) => a + (ps[i] / S) * (out[k]?.portfolio || 0), 0) : NaN;
    out.covered = tot / Math.max(1e-9, (ach.industries || []).reduce((s, x) => s + (x.got || 0), 0));
    return out;
  }

  // ------------------------------------------------------------------ 4. what you really own
  const METRICS = [["pe", "P/E", "h"], ["fwd_pe", "Forward P/E", "h"], ["eps_growth", "EPS growth", "a"], ["rev30", "Estimate revisions (30 days)", "a"], ["opm", "Operating margin", "a"], ["roe", "Return on equity", "a"], ["fcf", "Free cash flow margin", "a"], ["div", "Dividend yield", "a"], ["beta", "Beta", "a"], ["exp12", "Runs' expected 12M return (%)", "a"], ["pe_pct", "P/E vs its own history (percentile)", "a"]];
  /** Valuations aggregate as earnings yields (P/Es between 3 and 200 only); everything else as a weighted median, so one odd industry can't swing it. */
  function agg(pairs, kind) {
    const u = pairs.filter(([w, v]) => w > 0 && isNum(v) && (kind !== "h" || (v >= 3 && v <= 200))); const W = u.reduce((s, [w]) => s + w, 0); if (!W) return NaN;
    if (kind === "h") return W / u.reduce((s, [w, v]) => s + w / v, 0);
    const s = u.slice().sort((a, b) => a[1] - b[1]); let c = 0; for (const [w, v] of s) { c += w; if (c >= W / 2) return v; } return s[s.length - 1][1]; }
  /** The mix's industries against the whole market's, metric by metric, and the runs' calls. */
  function fundamentals(ach, rows) {
    const got = new Map((ach?.industries || []).map((x) => [x.name, x.got || 0])), port = {}, mkt = {};
    for (const [k, , kind] of METRICS) { port[k] = agg(rows.map((r) => [got.get(r.name) || 0, n(r[k])]), kind); mkt[k] = agg(rows.map((r) => [r.mkt, n(r[k])]), kind); }
    const callMix = (wOf) => { let up = 0, dn = 0, W = 0; for (const r of rows) { const w = wOf(r); if (!(w > 0) || !isNum(r.callN12)) continue; W += w; if (r.callN12 > 0) up += w; else if (r.callN12 < 0) dn += w; } return W ? { up: up / W, down: dn / W } : null; };
    return { port, mkt, calls: { port: callMix((r) => got.get(r.name) || 0), mkt: callMix((r) => r.mkt) }, metrics: METRICS.map(([k, label]) => ({ key: k, label })) };
  }
  /**
   * Share classes of one company: funds hold GOOGL and GOOG, BRK.B or BRK-B, while an industry run keeps one of them.
   * classKey maps every class to one key, so a fund's holding finds the run's row and the classes count as one company.
   */
  const CLASS_PAIRS = [["GOOGL", "GOOG"], ["FOXA", "FOX"], ["NWSA", "NWS"], ["UAA", "UA"], ["LBRDA", "LBRDK"], ["FWONA", "FWONK"], ["LSXMA", "LSXMK"], ["BATRA", "BATRK"], ["LEN", "LEN.B"], ["HEI", "HEI.A"], ["ZG", "Z"], ["BF.A", "BF.B"], ["MOG.A", "MOG.B"], ["CWEN", "CWEN.A"], ["DISCA", "DISCK"], ["VIAC", "VIACA"], ["LILA", "LILAK"], ["QRTEA", "QRTEB"]];
  const CLASS_OF = new Map(CLASS_PAIRS.flatMap(([a, b]) => [[a.replace(/[.\-/]/g, ""), a.replace(/[.\-/]/g, "")], [b.replace(/[.\-/]/g, ""), a.replace(/[.\-/]/g, "")]]));
  const classKey = (sym) => { const t = String(sym || "").toUpperCase().replace(/[.\-/ ]/g, ""); return CLASS_OF.get(t) || t.replace(/^(BRK|BF|MOG|HEI|LEN|CWEN)[AB]$/, "$1"); };
  /** The largest companies underneath, with the run's numbers and the investor-type score. */
  function companies(ach, rows, coScore = {}, k = 25) {
    const info = new Map(); for (const r of rows) for (const c of r.cos || []) { const key = classKey(c.symbol); if (!info.has(key)) info.set(key, { ...c, industry: r.name, call12: r.call12 }); }
    // One row per company: share classes held through the funds add up.
    const merged = new Map(); for (const s of ach?.allStocks || []) { const key = classKey(s.symbol), m = merged.get(key); if (m) { m.weight += s.weight; m.syms.push(s.symbol); } else merged.set(key, { key, symbol: s.symbol, weight: s.weight, syms: [s.symbol] }); }
    return [...merged.values()].sort((a, b) => b.weight - a.weight).slice(0, k).map((s) => { const c = info.get(s.key) || {}, sym = c.symbol && s.syms.includes(c.symbol) ? c.symbol : s.syms[0];
      const sc = s.syms.map((x) => n(coScore[x])).concat(c.symbol ? [n(coScore[c.symbol])] : []).find(isNum);
      return { symbol: sym, classes: s.syms.length > 1 ? s.syms : undefined, weight: s.weight, name: c.name || "", industry: c.industry || "", pe: n(c.pe), growth: n(c.g), opm: n(c.opm), div: n(c.div), r1y: n(c.r1y), beta: n(c.beta), next: c.next || null, beats: c.beats || null, score: isNum(sc) ? sc : NaN, call12: c.call12 || null }; });
  }
  /** Earnings reports of the companies underneath and the runs' dated catalysts, inside the window. */
  function calendar(ach, rows, { today, days = 90 } = {}) {
    const until = new Date(Date.parse(today) + days * 864e5).toISOString().slice(0, 10), w = new Map(); for (const s of ach?.allStocks || []) w.set(classKey(s.symbol), (w.get(classKey(s.symbol)) || 0) + s.weight), got = new Map((ach?.industries || []).map((x) => [x.name, x.got || 0]));
    const out = [], seen = new Set();
    for (const r of rows) for (const c of r.cos || []) if (c.next && c.next >= today && c.next <= until && (w.get(classKey(c.symbol)) || 0) >= 0.003 && !seen.has(classKey(c.symbol))) { seen.add(classKey(c.symbol)); out.push({ date: c.next, kind: "earnings", title: `${c.symbol} earnings`, weight: w.get(classKey(c.symbol)), industry: r.name, beats: c.beats || null }); }
    for (const r of rows) if ((got.get(r.name) || 0) >= 0.01) for (const e of r.events || []) if (e.date >= today && e.date <= until && /high|critical/i.test(String(e.importance || "")) && !/earnings/i.test(e.title || "")) out.push({ date: e.date, kind: "catalyst", title: e.title, weight: got.get(r.name), industry: r.name, detail: e.detail || "" });
    return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.weight - a.weight)).slice(0, 30);
  }

  // ------------------------------------------------------------------ everything for one version
  /**
   * ctx: {series, spy, cands, cov, w, view (vw), rows, byRow, coScore, amount, today, muS}. Returns the version's analysis.
   */
  function build(ctx) {
    const { series, spy, cands, cov, w, view, rows, byRow, coScore, amount, today, muS } = ctx;
    const idx = w.map((x, i) => (x > 0 ? i : -1)).filter((i) => i >= 0), H = idx.map((i) => ({ symbol: cands[i].symbol, w: w[i] }));
    const NAV = nav(series, H, spy), st = NAV ? Deep.stats(NAV, spy) : null;
    const risk = riskSplit(w, idx, cov, cands.map((c) => c.symbol));
    const proj = NAV ? project(monthlyPair(NAV, spy), { mu: n(view?.mu), muS, amount }) : null;
    const bondMu = view?.bonds > 0 ? idx.filter((i) => cands[i].isBond).reduce((s, i) => s + w[i] * (n(cands[i].mu) || 0), 0) / view.bonds : RF;
    return { holdings: H, track: st, nav_from: NAV?.dates?.[0] || null, risk, projection: proj, scenarios: scenarios(view?.ach, byRow, { bonds: view?.bonds || 0, bondMu }),
      fundamentals: fundamentals(view?.ach, rows), companies: companies(view?.ach, rows, coScore), calendar: calendar(view?.ach, rows, { today }) };
  }
  /** Today's portfolio measured the same way (track record and projection only). */
  function buildCurrent({ series, spy, holdings, mu, muS, amount }) {
    const H = holdings.map((h) => ({ symbol: h.ticker, w: h.weight / 100 })), NAV = nav(series, H, spy);
    return NAV ? { holdings: H, track: Deep.stats(NAV, spy), nav_from: NAV.dates[0], projection: isNum(mu) ? project(monthlyPair(NAV, spy), { mu, muS, amount }) : null } : null;
  }

  // ------------------------------------------------------------------ the memo
  const pc = (x, d = 1) => (isNum(x) ? `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%` : "n/a");
  const pp = (x, d = 1) => (isNum(x) ? `${(x * 100).toFixed(d)}%` : "n/a");
  const usd = (x) => (isNum(x) ? "$" + Math.round(x).toLocaleString("en-US") : "n/a");
  const f1 = (x, d = 1) => (isNum(x) ? x.toFixed(d) : "n/a");
  /** [P#] fact lines for the memo. A: build(); cur: buildCurrent(); deep: res.deep; extra: {label, grade, curGrade, cost, yield, amount}. */
  function text(A, cur, deep, extra = {}) {
    const L = [], add = (t) => L.push(`[P${L.length + 1}] ${t}`), s = A.track;
    add(`The mix: ${A.holdings.map((h) => `${h.symbol} ${pp(h.w)}`).join(", ")}. Grade ${extra.grade || "n/a"}${extra.curGrade ? ` (today's portfolio ${extra.curGrade})` : ""}; cost ${pp(extra.cost, 2)} a year; yield ${pp(extra.yield, 2)}; amount ${usd(extra.amount)}.`);
    const tr = (x, who) => { if (!x) return; add(`${who}, held at these weights since ${x.first} (dividends reinvested; S&P 500 in brackets): ${x.periods.map((p) => `${p.k} ${pc(p.ret)} [${pc(p.spy)}]`).join(", ")}. By year: ${x.years.map((y) => `${y.year}${y.partial ? " so far" : ""} ${pc(y.ret)} [${pc(y.spy)}]`).join(", ")}.`);
      add(`${who} risk over 3 years: volatility ${pp(x.risk.vol)}, Sharpe ${f1(x.risk.sharpe, 2)}, beta ${f1(x.risk.beta, 2)}, up/down capture ${pp(x.risk.up_capture, 0)}/${pp(x.risk.down_capture, 0)}, beat the S&P 500 in ${pp(x.risk.months_beat, 0)} of months. Worst drawdown in 5 years ${pc(x.drawdown.depth)} (${x.drawdown.peak} to ${x.drawdown.trough}${x.drawdown.recovered ? `, recovered ${x.drawdown.recovered}` : ", not yet recovered"}). Rolling 12 months: worst ${pc(x.rolling?.worst)}, median ${pc(x.rolling?.median)}, best ${pc(x.rolling?.best)}, ahead of the S&P 500 in ${pp(x.rolling?.beat, 0)}.`); };
    tr(s, "The recommended mix"); tr(cur?.track, "Today's portfolio");
    if (A.risk?.rows?.length) add(`Where the risk comes from (share of the mix's variance; volatility ${pp(A.risk.vol)}, diversification ratio ${f1(A.risk.diversification, 2)}): ${A.risk.rows.map((r) => `${r.symbol} ${pp(r.contrib, 0)} (weight ${pp(r.weight, 0)}, vol ${pp(r.vol, 0)}, correlation to the mix ${f1(r.corr_mix, 2)})`).join("; ")}.`);
    const pr = A.projection;
    if (pr) for (const h of Object.values(pr.horizons)) add(`Projection ${h.years} year${h.years > 1 ? "s" : ""} (${pr.paths} simulated paths from ${pr.months} real months, expected ${pp(pr.mu)} a year vs the S&P 500's ${pp(pr.muS)}): ${usd(pr.amount)} becomes ${usd(h.p50)} in the middle case (${pc(h.median_annual)} a year), ${usd(h.p25)} to ${usd(h.p75)} half the time, ${usd(h.p5)} in the worst 5% and ${usd(h.p95)} in the best 5%. Chance of a loss ${pp(h.p_loss, 0)}, of beating the S&P 500 ${pp(h.p_beat, 0)}, of a 20% fall along the way ${pp(h.p_fall20, 0)}.`);
    if (cur?.projection) { const h = cur.projection.horizons[5] || Object.values(cur.projection.horizons)[0]; add(`Today's portfolio projected the same way over ${h.years} years: middle ${usd(h.p50)}, worst 5% ${usd(h.p5)}, chance of a loss ${pp(h.p_loss, 0)}, of a 20% fall ${pp(h.p_fall20, 0)}.`); }
    const sc = A.scenarios; if (sc) add(`The industry runs' 12-month scenarios rolled up through the mix: bull ${pc(sc.bull?.portfolio)} (${f1(sc.bull?.probability, 0)}%), base ${pc(sc.base?.portfolio)} (${f1(sc.base?.probability, 0)}%), bear ${pc(sc.bear?.portfolio)} (${f1(sc.bear?.probability, 0)}%); probability-weighted ${pc(sc.expected)}.`);
    const F = A.fundamentals; if (F) add(`What the mix owns vs the whole market: ${F.metrics.map((m) => `${m.label} ${m.key === "pe" || m.key === "fwd_pe" || m.key === "beta" || m.key === "exp12" ? f1(F.port[m.key]) : pp(F.port[m.key])} vs ${m.key === "pe" || m.key === "fwd_pe" || m.key === "beta" || m.key === "exp12" ? f1(F.mkt[m.key]) : pp(F.mkt[m.key])}`).join("; ")}. Runs' 12M calls: ${pp(F.calls.port?.up, 0)} of the mix bullish, ${pp(F.calls.port?.down, 0)} bearish (market ${pp(F.calls.mkt?.up, 0)} / ${pp(F.calls.mkt?.down, 0)}).`);
    if (A.companies?.length) add(`Largest companies underneath: ${A.companies.slice(0, 15).map((c) => `${c.symbol} ${pp(c.weight)} (${c.industry || "?"}; P/E ${f1(c.pe)}, growth ${pp(c.growth, 0)}, score ${f1(c.score, 0)})`).join("; ")}.`);
    if (A.calendar?.length) add(`Coming up (90 days): ${A.calendar.slice(0, 12).map((e) => `${e.date} ${e.title} (${pp(e.weight, 1)} of the mix)`).join("; ")}.`);
    for (const h of A.holdings) { const d = deep?.[h.symbol], x = d?.stats; if (!x) continue; const p = (k) => x.periods.find((q) => q.k === k);
      add(`${h.symbol} (${pp(h.w)}): ${d.name}; 1Y ${pc(p("1Y")?.ret)} [${pc(p("1Y")?.spy)}], 3Y ${pc(p("3Y")?.ret)}/yr [${pc(p("3Y")?.spy)}], vol ${pp(x.risk.vol)}, worst drawdown ${pc(x.drawdown.depth)}, cost ${pp(d.expense, 2)}, expected ${pp(d.mu)}; biggest industries ${d.industries.slice(0, 3).map((g) => `${g.name} ${pp(g.weight, 0)} (${g.call12 || g.call || "n/a"})`).join(", ")}.`); }
    return L.join("\n");
  }
  function memoPrompt(goal, facts, { improving = false, label = "the recommended mix" } = {}) {
    const sec = (title, what) => `  {"title": "${title}", "headline": "one sentence: the point of this section", "points": ["3-5 bullets, each one specific fact with its number and id"], "body": "${what}", "stats": [{"label": "short", "value": "a number from the facts, e.g. +18.2% or $142,000"}]}`;
    return `You are the chief investment strategist writing the full investment memo for ${label}, an ETF-only ${goal.label.toLowerCase()} portfolio (horizon ${goal.horizonLabel || goal.horizon})${improving ? " that replaces the client's current holdings" : ""}. A quantitative process built it from full research reports on every industry; the weights are final. Your job is the complete argument: why this portfolio, why now, what each piece does, what to expect in numbers, what can go wrong, and exactly what to do.

Write for a sharp investor who wants depth: specific, quantitative, plain English, no filler. Every claim cites fact ids in brackets like [P3], [I2] or [E1]; use only ids that appear below, and never invent a number. Past returns don't guarantee future ones: weigh the record against the forward view and say where they disagree. Never recommend broad-market or size index funds (S&P 500, total market, Russell, mid- or small-cap index funds such as SPY, VOO, IVV, VTI or IWM); the S&P 500 is only the benchmark.

Facts:
${facts}

Each section has a one-sentence headline, 3-5 bullet points (one fact each, with its number), a body of full paragraphs separated by \\n, and 1-3 stats (label and value taken from the facts).
Return JSON only:
{"title": "a sharp one-line title",
 "subtitle": "one sentence: who it's for and what it's built to do",
 "summary": "6-8 sentences: the recommendation, the case, the numbers that matter (expected return, risk, projection), the biggest risk, and what to do",
 "bull": {"case": "2 sentences: what goes right", "points": ["3 bullets with numbers"]},
 "bear": {"case": "2 sentences: what goes wrong", "points": ["3 bullets with numbers"]},
 "sections": [
${sec("The thesis", "3-4 paragraphs")},
${sec("The market and macro backdrop", "2-3 paragraphs")},
${sec("How the money is allocated and why", "3-4 paragraphs: industries, bonds, what is avoided")},
${sec("Every ETF and the job it does", "one paragraph per ETF, in weight order")},
${sec("The record: how this mix would have done", "2-3 paragraphs against the S&P 500 and today's portfolio: periods, years, drawdowns, consistency")},
${sec("What to expect: projections and scenarios", "2-3 paragraphs: the simulated ranges in dollars, the chance of a loss and of beating the S&P 500, and the runs' bull/base/bear")},
${sec("What you really own", "2 paragraphs: the companies underneath, valuation, growth and quality against the market")},
${sec(improving ? "What changes from today's portfolio and why" : "Who this portfolio is for", "2-3 paragraphs")},
${sec("Risks and how the portfolio handles them", "3 paragraphs")},
${sec("What would change the view", "1-2 paragraphs")}],
 "action_plan": [{"step": "short", "detail": "1-2 sentences: what to buy or sell, in what order, how much, when", "when": "now | this week | this month | on a dip | ongoing"}],
 "watch": [{"date": "YYYY-MM-DD or 'monthly'", "what": "the event or number to check", "why": "what it would change"}],
 "conviction": 1-10,
 "conviction_why": "one sentence"}
4-7 action steps, 5-8 watch items.`;
  }
  function memoClean(x, ids) {
    if (!x || typeof x !== "object") return null;
    const ok = new Set(ids), fix = (s) => String(s || "").replace(/\[([A-Z]{1,2}\d{1,3}[a-z]?)\]/g, (m, id) => (ok.has(id) ? m : "")).replace(/\s+([.,;])/g, "$1").trim();
    const arr = (a, k) => (Array.isArray(a) ? a.slice(0, k) : []), cv = Math.round(n(x.conviction));
    const side = (s) => (s && typeof s === "object" ? { case: fix(s.case), points: arr(s.points, 5).map(fix).filter(Boolean) } : null);
    return { title: fix(x.title).slice(0, 200), subtitle: fix(x.subtitle).slice(0, 300), summary: fix(x.summary), bull: side(x.bull), bear: side(x.bear),
      sections: arr(x.sections, 12).map((s) => ({ title: String(s?.title || "").slice(0, 100), headline: fix(s?.headline), points: arr(s?.points, 6).map(fix).filter(Boolean), body: fix(s?.body),
        stats: arr(s?.stats, 3).map((q) => ({ label: String(q?.label || "").slice(0, 40), value: String(q?.value || "").slice(0, 24) })).filter((q) => q.label && q.value) })).filter((s) => s.title && (s.body || s.points.length)),
      action_plan: arr(x.action_plan, 8).map((a) => ({ step: String(a?.step || "").slice(0, 120), detail: fix(a?.detail), when: String(a?.when || "").slice(0, 20) })).filter((a) => a.step),
      watch: arr(x.watch, 10).map((w) => ({ date: String(w?.date || "").slice(0, 10), what: fix(w?.what), why: fix(w?.why) })).filter((w) => w.what),
      conviction: isNum(cv) ? Math.max(1, Math.min(10, cv)) : null, conviction_why: fix(x.conviction_why) };
  }

  // ------------------------------------------------------------------ 5. today's portfolio, holding by holding and grade by grade
  /**
   * Every holding of today's portfolio, measured and given a code verdict (replace / trim / keep). ctx: {held (held0),
   * series, spy, byRow, info: {sym: fund info}, vecs: {sym: {ind, cos}}, muOf(h), isBroad(sym, info), goal, alt(h)}.
   */
  function holdings(ctx) {
    const { held, series, spy, byRow, info = {}, vecs = {}, muOf, isBroad, goal, alt = () => null } = ctx;
    return held.map((h) => {
      const st = Deep.stats(series[h.ticker], spy), v = vecs[h.ticker] || (h.industry ? { ind: { [h.industry]: 1 } } : { ind: {} }), i = info[h.ticker] || {};
      const inds = Object.entries(v.ind || {}).filter(([k]) => !k.startsWith("(")).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, w]) => { const r = byRow.get(name) || {}; return { name, weight: w, z: isNum(r.z) ? r.z : null, call12: r.call12 || null, exp12: isNum(r.exp12) ? r.exp12 : null, pe_pct: isNum(r.pe_pct) ? r.pe_pct : null }; });
      let zs = 0, zw = 0, es = 0, ew = 0; for (const [name, w] of Object.entries(v.ind || {})) { const r = byRow.get(name); if (r && isNum(r.z)) { zs += w * r.z; zw += w; } if (r && isNum(r.exp12)) { es += w * r.exp12 / 100; ew += w; } }
      const conv = zw ? zs / zw : NaN, exp = ew ? es / ew : NaN, broad = !!isBroad?.(h.ticker, i), stock = h.asset_type === "stock";
      const why = [];
      let action = "keep";
      if (broad) { action = "replace"; why.push("a broad-market index fund: never part of the recommendation"); }
      else if (stock && h.weight / 100 > Math.max(0.08, (goal?.stockCap || 0.08) * 1.5)) { action = "trim"; why.push(`one stock is ${(h.weight).toFixed(1)}% of the portfolio`); }
      if (isNum(conv) && conv < -0.25 && action === "keep") { action = "trim"; why.push(`the runs lean against its industries (conviction ${conv.toFixed(2)})`); }
      if (isNum(conv) && conv > 0.3 && action === "keep") why.push(`the runs favor its industries (conviction +${conv.toFixed(2)})`);
      const yld = n(i.lastDiv) > 0 && n(i.price) > 0 ? i.lastDiv / i.price : n(h.lastDiv) > 0 && h.price > 0 ? h.lastDiv / h.price : NaN;
      return { ticker: h.ticker, name: h.name || i.name || "", weight: h.weight / 100, type: stock ? "stock" : "fund", broad, expense: n(i.expenseRatio) / 100, yield: yld, mu: muOf ? muOf(h) : NaN,
        conviction: conv, expected: exp, industries: inds, stats: st, action, why, alternative: action !== "keep" ? alt(h, v) : null };
    });
  }
  /** The numbers behind each grade of today's portfolio. cur: res.current; rows; coScore; fundVecs: {sym: vec}. */
  function gradeDetail(cur, rows, { coScore = {}, fundVecs = {}, tgt = null, picks = new Set() } = {}) {
    if (!cur?.ach) return null;
    const byRow = new Map(rows.map((r) => [r.name, r])), a = cur.ach, inds = (a.industries || []).filter((x) => x.got > 0.003);
    const conviction = inds.map((x) => { const r = byRow.get(x.name) || {}; return { name: x.name, got: x.got, z: isNum(r.z) ? r.z : null, contrib: isNum(r.z) ? x.got * r.z : null, call12: r.call12 || null, exp12: isNum(r.exp12) ? r.exp12 : null }; }).sort((p, q) => Math.abs(q.contrib || 0) - Math.abs(p.contrib || 0)).slice(0, 15);
    const gaps = (a.industries || []).filter((x) => x.target > 0 || x.got > 0.005).map((x) => ({ name: x.name, target: x.target, got: x.got, gap: x.got - x.target, z: byRow.get(x.name)?.z ?? null })).sort((p, q) => Math.abs(q.gap) - Math.abs(p.gap)).slice(0, 14);
    const quality = (a.allStocks || []).slice(0, 30).map((s) => ({ symbol: s.symbol, weight: s.weight, score: isNum(coScore[s.symbol]) ? coScore[s.symbol] : null, pick: picks.has(s.symbol) })).filter((x) => x.weight >= 0.002);
    const fv = Object.keys(fundVecs), pairs = []; for (let i = 0; i < fv.length; i++) for (let j = i + 1; j < fv.length; j++) { let s = 0; for (const [t, v] of Object.entries(fundVecs[fv[i]].cos || {})) s += Math.min(v, n(fundVecs[fv[j]].cos?.[t]) || 0); pairs.push({ a: fv[i], b: fv[j], overlap: s }); }
    const sectors = {}; for (const x of inds) { const s = byRow.get(x.name)?.sector || "Other"; sectors[x.name.startsWith("(") ? "Bonds and other" : s] = (sectors[x.name.startsWith("(") ? "Bonds and other" : s] || 0) + x.got; }
    const expected = inds.filter((x) => isNum(byRow.get(x.name)?.exp12)).map((x) => ({ name: x.name, got: x.got, exp12: byRow.get(x.name).exp12, contrib: x.got * byRow.get(x.name).exp12 / 100 })).sort((p, q) => q.contrib - p.contrib);
    return { conviction, gaps, quality, stocks: (a.stocks || []).slice(0, 12), pairs: pairs.sort((p, q) => q.overlap - p.overlap).slice(0, 6), sectors: Object.entries(sectors).map(([name, w]) => ({ name, weight: w })).sort((p, q) => q.weight - p.weight),
      expected: [...expected.slice(0, 6), ...expected.slice(-4).filter((x) => !expected.slice(0, 6).includes(x))], effN: (() => { const s = (a.allStocks || []).reduce((t, v) => t + (v.weight / (a.stockShare || 1)) ** 2, 0); return s > 0 ? 1 / s : NaN; })() };
  }

  // ------------------------------------------------------------------ 6. the opportunities desk
  /**
   * The best cases across every industry run, with the evidence and the ways to play them. rows (with z, reasons);
   * picksFor(name) -> [{symbol, name, profile, factors, c}]; etfsFor(name) -> [{symbol, purity, stats, expense, name}];
   * have(name) -> share of today's portfolio; target(name) -> the target weight. Up to `k`, strongest first.
   */
  function opportunities(rows, { goal, today, picksFor = () => [], etfsFor = () => [], have = () => 0, target = () => 0, k = 12 } = {}) {
    const until = new Date(Date.parse(today) + 183 * 864e5).toISOString().slice(0, 10), seen = new Set(), out = [];
    const push = (r, kind, why) => { if (seen.has(r.name)) return; seen.add(r.name);
      out.push({ industry: r.name, sector: r.sector, kind, why, z: r.z, call: r.call, call12: r.call12, exp12: r.exp12, p_up: r.p_up, bull: r.bull, base: r.base, bear: r.bear, skew: r.skew, pe: r.pe, fwd_pe: r.fwd_pe, pe_pct: r.pe_pct, priced: r.priced,
        eps_growth: r.eps_growth, rev30: r.rev30, div: r.div, r1y: r.r1y, vol: r.vol, verdict: r.verdict, headline: String(r.headline || "").slice(0, 300), reads: r.reads || {},
        reasons: (r.reasons || []).map((x) => ({ label: x.label, x: x.x })), have: have(r.name), target: target(r.name), mkt: r.mkt,
        events: (r.events || []).filter((e) => e.date >= today && e.date <= until && /high|critical/i.test(String(e.importance || ""))).slice(0, 4).map((e) => ({ date: e.date, title: e.title, detail: String(e.detail || "").slice(0, 200) })),
        picks: picksFor(r.name).slice(0, 5), etfs: etfsFor(r.name).slice(0, 3) }); };
    const ok = (r) => r.verdict !== "no" && !(isNum(r.callN12) && r.callN12 < 0);
    for (const r of rows.filter((r) => isNum(r.z) && r.z > 0.35 && ok(r)).sort((a, b) => b.z - a.z).slice(0, Math.ceil(k * (goal?.focus ? 0.8 : 0.6)))) push(r, "conviction", "the strongest case for this goal across every input");
    for (const r of rows.filter((r) => isNum(r.pe_pct) && r.pe_pct < 0.3 && (r.callN12 > 0 || r.rev30 > 0.005) && ok(r)).sort((a, b) => a.pe_pct - b.pe_pct).slice(0, 4)) push(r, "value", "cheap against its own history while the outlook or estimates improve");
    for (const r of rows.filter((r) => isNum(r.rev30) && r.rev30 > 0.02 && r.callN12 > 0 && ok(r)).sort((a, b) => b.rev30 - a.rev30).slice(0, 3)) push(r, "momentum", "analysts are raising estimates fast and the call is bullish");
    for (const r of rows.filter((r) => isNum(r.skew) && r.skew > 3 && ok(r)).sort((a, b) => b.skew - a.skew).slice(0, 3)) push(r, "asymmetry", "the bull case outweighs the bear case by probability times size");
    for (const r of rows.filter((r) => (r.events || []).some((e) => e.date >= today && e.date <= until && /high|critical/i.test(String(e.importance || ""))) && isNum(r.z) && r.z > 0.15 && ok(r)).sort((a, b) => b.z - a.z).slice(0, 3)) push(r, "catalyst", "a dated catalyst inside six months on a favored industry");
    // The investor's focus decides which of these lead.
    const f = goal?.focus, base = (o, i) => -i * 0.02, gap = (o) => Math.max(0, (o.target || 0) - (o.have || 0));
    const score = (o, i) => base(o, i) + (f === "gems" ? ((o.kind === "value" || o.kind === "momentum" || o.kind === "asymmetry") ? 0.5 : 0) + (isNum(o.pe_pct) ? 0.4 * (0.5 - o.pe_pct) : 0)
      : f === "gaps" ? 8 * gap(o) + (o.have > 0.01 ? -0.3 : 0.2)
      : f === "income" ? 20 * (n(o.div) || 0)
      : f === "risk" ? (isNum(o.vol) ? -1.5 * o.vol : 0) + (isNum(n(o.bear?.move)) ? 0.01 * n(o.bear.move) : 0) : 0);
    return f ? out.map((o, i) => [o, score(o, i)]).sort((a, b) => b[1] - a[1]).map((x) => x[0]).slice(0, k) : out.slice(0, k);
  }
  function oppText(opps, goal) {
    const L = []; const f = (x, d = 1) => (isNum(x) ? x.toFixed(d) : "n/a");
    opps.forEach((o, i) => { const id = `Q${i + 1}`;
      L.push(`[${id}] ${o.industry} (${o.sector}; ${o.kind}: ${o.why}). Conviction for a ${goal.label.toLowerCase()} investor ${o.z > 0 ? "+" : ""}${f(o.z, 2)} (${o.reasons.slice(0, 5).map((x) => `${x.label} ${x.x > 0 ? "+" : ""}${x.x.toFixed(2)}`).join(", ")}). ${goal.horizon} call ${o.call || "n/a"}, 12M ${o.call12 || "n/a"}, expected 12M ${f(o.exp12)}%, chance it rises ${f(o.p_up, 0)}%. Scenarios: bull ${f(n(o.bull?.p), 0)}% / ${f(n(o.bull?.move), 0)}%, base ${f(n(o.base?.p), 0)}% / ${f(n(o.base?.move), 0)}%, bear ${f(n(o.bear?.p), 0)}% / ${f(n(o.bear?.move), 0)}%. P/E ${f(o.pe)} (forward ${f(o.fwd_pe)}, ${isNum(o.pe_pct) ? Math.round(o.pe_pct * 100) + "th percentile of its history" : "history n/a"}${o.priced ? `, priced in: ${o.priced}` : ""}); EPS growth ${pp(o.eps_growth)}; estimates ${pc(o.rev30)} in 30 days; 1Y ${pc(o.r1y)}; vol ${pp(o.vol, 0)}. Today's portfolio holds ${pp(o.have)}; the target is ${pp(o.target)}; market weight ${pp(o.mkt)}. Strategist: ${o.verdict || "n/a"}. ${o.headline}`);
      if (o.events.length) L.push(`[${id}c] Catalysts: ${o.events.map((e) => `${e.date} ${e.title}${e.detail ? ` (${e.detail})` : ""}`).join("; ")}.`);
      if (o.picks.length) L.push(`[${id}p] Best companies: ${o.picks.map((p) => `${p.symbol}${p.name ? ` ${String(p.name).slice(0, 30)}` : ""} (score ${f(n(p.profile), 0)}; P/E ${f(n(p.c?.pe))}, growth ${pp(n(p.c?.ntm_growth ?? p.c?.rev_growth), 0)}, 1Y ${pc(n(p.c?.ret_1Y ?? p.c?.excess_1Y))}${p.strategist ? ", the lead strategist's pick" : ""})`).join("; ")}.`);
      if (o.etfs.length) L.push(`[${id}e] ETFs that hold it: ${o.etfs.map((e) => { const s = e.stats, P = (k) => s?.periods?.find((q) => q.k === k); return `${e.symbol} (${e.sector_fund ? "its sector's fund" : isNum(e.purity) ? pp(e.purity, 0) + " in the industry" : "an industry fund"}; cost ${pp(e.expense, 2)}; 1Y ${pc(P("1Y")?.ret)} vs S&P 500 ${pc(P("1Y")?.spy)}, 3Y ${pc(P("3Y")?.ret)}/yr vs ${pc(P("3Y")?.spy)}, vol ${pp(s?.risk?.vol, 0)}, worst drawdown ${pc(s?.drawdown?.depth)})`; }).join("; ")}.`);
    });
    return L.join("\n");
  }
  function oppPrompt(goal, facts, { holdings = "" } = {}) {
    return `You run the opportunities desk for a ${goal.label.toLowerCase()} investor (horizon ${goal.horizonLabel || goal.horizon}). Below are the strongest cases code found across every industry research run (Q#), each with its evidence, best companies and the ETFs that hold it${holdings ? `, and the client's portfolio today (H#)` : ""}. Write a brief for each that a sharp investor could act on: the thesis, why now, exactly how to play it, how big, when to get in, what would kill it.

Plain English, specific, quantitative. Every claim cites ids in brackets like [Q2], [Q2p], [Q2e] or [H1]; use only ids below and never invent a number. Be honest: if the record or the valuation argues against an idea, say so and lower its conviction. Never suggest broad-market or size index funds (S&P 500, total market, Russell, mid- or small-cap index funds such as SPY, VOO, IVV, VTI or IWM): express each idea through the industry ETFs or companies named in the facts.

Facts:
${facts}${holdings ? `\n${holdings}` : ""}

Return JSON only:
{"headline": "one sentence: where the best opportunities are right now",
 "top": ["the 3 ids (Q#) to act on first, best first"],
 "opportunities": [{"id": "Q#", "title": "short, punchy", "conviction": 1-10, "thesis": "3-4 sentences with numbers", "why_now": "1-2 sentences: the catalyst, the valuation or the estimate trend that makes it timely", "how": "the ETF(s) and/or companies to use and why those", "size": "a suggested position as a % of the portfolio, and what to fund it from", "entry": "all at once or staged, and at what levels or dates", "risk": "the main risk, with numbers", "kill": "the specific thing that would end the idea", "horizon": "1M | 3M | 6M | 12M"}]}
Cover every Q#.`;
  }
  function oppClean(x, ids) {
    if (!x || typeof x !== "object") return null;
    const ok = new Set(ids), fix = (s) => String(s || "").replace(/\[([A-Z]{1,2}\d{1,3}[a-z]?)\]/g, (m, id) => (ok.has(id) ? m : "")).replace(/\s+([.,;])/g, "$1").trim();
    return { headline: fix(x.headline), top: (Array.isArray(x.top) ? x.top : []).map(String).filter((i) => ok.has(i)).slice(0, 3),
      opportunities: (Array.isArray(x.opportunities) ? x.opportunities : []).slice(0, 16).map((o) => ({ id: String(o?.id || ""), title: String(o?.title || "").slice(0, 120), conviction: isNum(Math.round(n(o?.conviction))) ? Math.max(1, Math.min(10, Math.round(n(o.conviction)))) : null,
        thesis: fix(o?.thesis), why_now: fix(o?.why_now), how: fix(o?.how), size: fix(o?.size), entry: fix(o?.entry), risk: fix(o?.risk), kill: fix(o?.kill), horizon: String(o?.horizon || "").slice(0, 4) })).filter((o) => ok.has(o.id)) };
  }
  /** The client's holdings as [H#] facts (for the opportunities desk and the holdings review). */
  function holdText(hs) {
    return hs.map((h, i) => { const s = h.stats, P = (k) => s?.periods?.find((q) => q.k === k);
      return `[H${i + 1}] ${h.ticker} ${h.name} (${h.type}, ${pp(h.weight)} of the portfolio${h.broad ? ", a broad-market index fund" : ""}): 1Y ${pc(P("1Y")?.ret)} vs S&P 500 ${pc(P("1Y")?.spy)}, 3Y ${pc(P("3Y")?.ret)}/yr vs ${pc(P("3Y")?.spy)}, 5Y ${pc(P("5Y")?.ret)}/yr vs ${pc(P("5Y")?.spy)}; vol ${pp(s?.risk?.vol, 0)}, beta ${isNum(s?.risk?.beta) ? s.risk.beta.toFixed(2) : "n/a"}, worst drawdown ${pc(s?.drawdown?.depth)}, ${pc(s?.drawdown?.from_high)} from its high; cost ${pp(h.expense, 2)}, yield ${pp(h.yield, 2)}; expected ${pp(h.mu)} a year; the runs' conviction on its industries ${isNum(h.conviction) ? (h.conviction > 0 ? "+" : "") + h.conviction.toFixed(2) : "n/a"} (${h.industries.slice(0, 3).map((g) => `${g.name} ${pp(g.weight, 0)}, 12M ${g.call12 || "n/a"}, expected ${isNum(g.exp12) ? g.exp12.toFixed(1) + "%" : "n/a"}`).join("; ")}). Code's verdict: ${h.action}${h.why.length ? ` (${h.why.join("; ")})` : ""}${h.alternative ? `; the closest recommended replacement ${h.alternative.symbol} (${h.alternative.why})` : ""}.`; }).join("\n");
  }
  function holdPrompt(goal, facts) {
    return `You are the portfolio manager reviewing a client's current holdings, one by one, for a ${goal.label.toLowerCase()} goal (horizon ${goal.horizonLabel || goal.horizon}). For each holding (H#), decide keep, add, trim, replace or sell, and say why with the numbers. Code has already flagged some; you may disagree only with evidence, except that broad-market index funds (SPY, VOO, IVV, VTI, IWM and the like) are always replaced by the recommended industry ETFs.

Every claim cites ids like [H2] or [E3]; use only ids below; never invent numbers.

Facts:
${facts}

Return JSON only:
{"holdings": [{"id": "H#", "action": "keep | add | trim | replace | sell", "headline": "one sentence", "why": "2-3 sentences with numbers: its record, its industries' outlook, its role, its risk", "instead": "for trim, replace or sell: what to buy with the money (ETFs from the facts), else ''"}]}`;
  }
  function holdClean(x, ids) {
    if (!x || typeof x !== "object") return null;
    const ok = new Set(ids), fix = (s) => String(s || "").replace(/\[([A-Z]{1,2}\d{1,3}[a-z]?)\]/g, (m, id) => (ok.has(id) ? m : "")).replace(/\s+([.,;])/g, "$1").trim(), A = ["keep", "add", "trim", "replace", "sell"];
    return (Array.isArray(x.holdings) ? x.holdings : []).map((h) => ({ id: String(h?.id || ""), action: A.includes(String(h?.action).toLowerCase()) ? String(h.action).toLowerCase() : "keep", headline: fix(h?.headline), why: fix(h?.why), instead: fix(h?.instead) })).filter((h) => ok.has(h.id));
  }
  const idsOf = (t) => [...new Set([...String(t).matchAll(/^\[([A-Z]{1,2}\d{1,3}[a-z]?)\]/gm)].map((m) => m[1]))];

  const PfDeep = { classKey, holdings, gradeDetail, opportunities, oppText, oppPrompt, oppClean, holdText, holdPrompt, holdClean, idsOf, RF, ERP, nav, riskSplit, project, monthlyPair, scenarios, fundamentals, companies, calendar, build, buildCurrent, text, memoPrompt, memoClean, METRICS };
  if (typeof module !== "undefined" && module.exports) module.exports = PfDeep;
  else root.PfDeep = PfDeep;
})(typeof globalThis !== "undefined" ? globalThis : this);
