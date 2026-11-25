/**
 * Compare: two to four tickers (stocks, ETFs or mutual funds) side by side, built on what the page already has: each
 * company's own numbers, its industry report, and any company or fund analysis already written (here or on GitHub).
 * Code does the measuring (every metric, a 0-100 score per dimension on fixed scales, a fit score per investor type,
 * correlations and holdings overlap); one Claude call reads the result and makes the calls. Pure functions; the page
 * builds the subjects.
 *
 * Subject: {sym, kind: "stock"|"fund", name, sub, sector, m: {metric: value}, pillars: {pillar: 0-100}, profiles:
 * {type: {total, fit}}, outlook: {calls: {h: {call, why}}, source}, saved, ind, ser: {dates, closes}, holdings}.
 */
(function (root) {
  "use strict";
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const n = (x) => (x === null || x === undefined || x === "" ? NaN : Number(x));
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const r1 = (v) => Math.round(v * 10) / 10;
  const HZ = ["1M", "3M", "6M", "12M"];
  const TYPES = ["income", "conservative", "growth", "aggressive"];
  const TYPE_LABEL = { income: "Income", conservative: "Conservative", growth: "Growth", aggressive: "Aggressive" };
  const SIGN = { "strongly bullish": 3, bullish: 2, "slightly bullish": 1, "slightly bearish": -1, bearish: -2, "strongly bearish": -3 };

  /** The dimensions code scores, and the industry/fund pillar each falls back to when the raw numbers aren't there. */
  const GROUPS = {
    momentum: { label: "Momentum", pillar: "momentum", icon: "↗" },
    risk: { label: "Risk", pillar: "risk", icon: "◎" },
    risk_reward: { label: "Risk-adjusted return", pillar: "risk_reward", icon: "⚖" },
    valuation: { label: "Valuation", pillar: "valuation", icon: "$" },
    growth: { label: "Growth", pillar: "growth", icon: "▲" },
    profitability: { label: "Profitability & quality", pillar: "profitability", icon: "◆" },
    health: { label: "Balance sheet", pillar: "health", icon: "▣" },
    income: { label: "Income", pillar: "income", icon: "%" },
    analyst: { label: "Wall Street", pillar: "consensus", icon: "★" },
    sentiment: { label: "Sentiment & positioning", pillar: "sentiment", icon: "☁" },
    outlook: { label: "Outlook (1M-12M)", pillar: "outlook", icon: "→" },
    backdrop: { label: "Industry backdrop", pillar: null, icon: "◐" },
    cost: { label: "Cost & structure", pillar: null, icon: "¢", fundOnly: true },
  };
  const GROUP_KEYS = Object.keys(GROUPS);

  /**
   * Every metric: [key, label, group, kind, lo, hi, up]. lo/hi are the fixed scale (0 at lo, 100 at hi; reversed when
   * up is false), so a score means the same thing for every ticker and every pairing. kind: pct (a fraction shown as
   * %), chg (signed fraction), x (multiple), n (plain number), usd.
   */
  const M = [
    ["ret_1M", "Return 1M", "momentum", "chg", -0.1, 0.1, true], ["ret_3M", "Return 3M", "momentum", "chg", -0.15, 0.15, true],
    ["ret_6M", "Return 6M", "momentum", "chg", -0.2, 0.25, true], ["ret_1Y", "Return 1Y", "momentum", "chg", -0.25, 0.4, true],
    ["ret_3Y", "Return 3Y, a year", "momentum", "chg", -0.1, 0.25, true], ["ret_5Y", "Return 5Y, a year", "momentum", "chg", -0.05, 0.22, true],
    ["vs_ma200", "vs its 200-day average", "momentum", "chg", -0.15, 0.15, true], ["off_high", "From its 52-week high", "momentum", "chg", -0.35, 0, true],
    ["vol_1y", "Volatility 1Y", "risk", "pct", 0.12, 0.5, false], ["max_dd_1y", "Worst drop 1Y", "risk", "chg", -0.45, -0.08, true],
    ["beta", "Beta to the S&P 500", "risk", "x", 0.5, 1.6, false], ["down_capture", "Down capture", "risk", "pct", 0.5, 1.3, false],
    ["sharpe_1y", "Sharpe 1Y", "risk_reward", "x", -0.5, 2, true], ["sortino_1y", "Sortino 1Y", "risk_reward", "x", -0.5, 3, true],
    ["alpha_1y", "Alpha 1Y", "risk_reward", "chg", -0.2, 0.2, true], ["sharpe_3y", "Sharpe 3Y", "risk_reward", "x", -0.3, 1.5, true],
    ["pe", "P/E", "valuation", "x", 8, 45, false], ["fwd_pe", "Forward P/E", "valuation", "x", 8, 40, false],
    ["ps", "Price / sales", "valuation", "x", 0.8, 12, false], ["ev_ebitda", "EV / EBITDA", "valuation", "x", 6, 30, false],
    ["fcf_yield", "FCF yield", "valuation", "pct", 0, 0.08, true], ["pe_vs_hist", "P/E vs its 5-year median", "valuation", "chg", -0.3, 0.4, false],
    ["upside_dcf", "DCF value vs price", "valuation", "chg", -0.4, 0.4, true],
    ["rev_growth", "Revenue growth (TTM)", "growth", "chg", -0.05, 0.3, true], ["ntm_growth", "EPS growth next 12M", "growth", "chg", -0.05, 0.3, true],
    ["rev_fwd", "Revenue growth next year (est.)", "growth", "chg", -0.03, 0.25, true], ["implied_g", "Growth the price implies", "growth", "pct", 0, 0.2, false],
    ["gross_margin", "Gross margin", "profitability", "pct", 0.15, 0.7, true], ["op_margin", "Operating margin", "profitability", "pct", 0, 0.35, true],
    ["net_margin", "Net margin", "profitability", "pct", 0, 0.25, true], ["fcf_margin", "FCF margin", "profitability", "pct", 0, 0.3, true],
    ["roic", "ROIC", "profitability", "pct", 0, 0.25, true], ["roe", "ROE", "profitability", "pct", 0, 0.3, true],
    ["piotroski", "Piotroski F-score", "profitability", "n", 2, 8, true], ["beat_rate", "Earnings beats (last 8)", "profitability", "pct", 0.4, 1, true],
    ["de", "Debt / equity", "health", "x", 0.1, 2.5, false], ["nd_ebitda", "Net debt / EBITDA", "health", "x", -0.5, 4, false],
    ["int_cover", "Interest cover", "health", "x", 2, 20, true], ["altman", "Altman Z", "health", "x", 1.8, 4, true],
    ["div_yield", "Dividend yield", "income", "pct", 0, 0.05, true], ["payout", "Payout ratio", "income", "pct", 0.3, 1, false],
    ["div_growth", "Dividend growth (5Y, a year)", "income", "chg", -0.02, 0.12, true],
    ["upside_target", "Upside to the analysts' target", "analyst", "chg", -0.1, 0.3, true], ["buy_share", "Analysts at buy", "analyst", "pct", 0.2, 0.9, true],
    ["rev30", "EPS estimate revisions, 30 days", "analyst", "chg", -0.05, 0.05, true], ["target_trend", "Analysts' target, last month vs last year", "analyst", "chg", -0.1, 0.15, true],
    ["rating_net", "Upgrades minus downgrades (4 months)", "analyst", "n", -3, 3, true],
    ["news_sent", "News sentiment, 30 days (-1 to +1)", "sentiment", "x", -0.1, 0.4, true], ["short_pct", "Short interest", "sentiment", "pct", 0.01, 0.12, false],
    ["expense", "Expense ratio", "cost", "pct", 0.0003, 0.01, false], ["top10", "Top 10 holdings", "cost", "pct", 0.15, 0.7, false],
    ["eff_n", "Effective number of holdings", "cost", "n", 8, 120, true], ["tracking", "Tracking error vs its benchmark", "cost", "pct", 0.01, 0.12, false],
  ].map(([key, label, group, kind, lo, hi, up]) => ({ key, label, group, kind, lo, hi, up }));
  const MBY = Object.fromEntries(M.map((x) => [x.key, x]));
  /** Shown but not scored (sizes and context). */
  const INFO = [["mcap", "Market cap / assets", "usd"], ["px", "Price", "usd"], ["holdings_n", "Holdings", "n"], ["coverage", "Covered by your industry analysis", "pct"]];

  /** A metric on its fixed scale: 10 at lo, 90 at hi (reversed when lower is better), easing toward 0 and 100 beyond, so two values past the same end still rank. */
  const score1 = (def, v) => { if (!isNum(v)) return NaN; let t = (v - def.lo) / (def.hi - def.lo); if (!def.up) t = 1 - t; return 100 / (1 + Math.exp(-4.4 * (t - 0.5))); };
  /** The outlook's calls as one number: the mean of -3..+3 over the windows, on 0-100. */
  function outlookScore(o) { const v = HZ.map((h) => SIGN[o?.calls?.[h]?.call]).filter(isNum); return v.length ? clamp(50 + (mean(v) / 3) * 50, 0, 100) : NaN; }

  /**
   * Scores every subject: each metric on its fixed scale, each dimension as the mean of its metrics (or, with none of
   * its numbers, the industry/fund pillar, marked "via its industries"), the outlook from its calls, and the backdrop
   * from its industries' outlook and section pillars. Returns {SYM: {metrics: {k: {v, s}}, groups: {g: {score, from, n}}}}.
   */
  function scoreAll(subjects) {
    const out = {};
    for (const s of subjects) {
      const metrics = {}, groups = {};
      for (const def of M) { const v = n(s.m?.[def.key]); if (isNum(v)) metrics[def.key] = { v, s: score1(def, v) }; }
      for (const g of GROUP_KEYS) {
        if (GROUPS[g].fundOnly && s.kind !== "fund") continue;
        const ms = M.filter((d) => d.group === g && isNum(metrics[d.key]?.s)).map((d) => metrics[d.key].s);
        if (g === "outlook") { const v = outlookScore(s.outlook); if (isNum(v)) groups[g] = { score: v, from: s.outlook?.source || "calls", n: 4 }; continue; }
        if (g === "backdrop") { const v = mean(["cycle", "macro", "world", "supply", "regulation", "sentiment"].map((p) => n(s.pillars?.[p])).filter(isNum)); const io = outlookScore(s.ind?.outlook);
          const parts = [v, io].filter(isNum); if (parts.length) groups[g] = { score: mean(parts), from: "industries", n: parts.length }; continue; }
        if (ms.length >= (s.kind === "fund" && !["momentum", "risk", "risk_reward", "income", "cost"].includes(g) ? 2 : 1)) { groups[g] = { score: mean(ms), from: "numbers", n: ms.length }; continue; }
        const pv = GROUPS[g].pillar ? n(s.pillars?.[GROUPS[g].pillar]) : NaN;
        if (isNum(pv)) groups[g] = { score: pv, from: s.kind === "fund" ? "its industries" : "vs its industry", n: 0 };
        else if (ms.length) groups[g] = { score: mean(ms), from: "numbers", n: ms.length };
      }
      for (const g of Object.values(groups)) g.score = r1(g.score);
      out[s.sym] = { metrics, groups };
    }
    return out;
  }

  /** What each investor type weighs, over the compare dimensions (missing ones drop out and the rest re-weigh). */
  const WEIGHTS = {
    income: { income: 34, health: 16, risk: 16, valuation: 12, profitability: 10, backdrop: 6, outlook: 6 },
    conservative: { risk: 28, health: 18, profitability: 14, valuation: 12, risk_reward: 12, income: 8, backdrop: 8 },
    growth: { growth: 26, outlook: 16, profitability: 14, momentum: 12, analyst: 10, valuation: 10, backdrop: 8, sentiment: 5, risk_reward: 4 },
    aggressive: { momentum: 20, growth: 18, outlook: 20, risk_reward: 12, analyst: 10, backdrop: 10, sentiment: 8, valuation: 6 },
  };
  const OVL = { strong: 6, good: 2, weak: -3, poor: -7 };
  const grade = (s) => (!isNum(s) ? "—" : s >= 80 ? "A" : s >= 65 ? "B" : s >= 50 ? "C" : s >= 35 ? "D" : "F");

  /**
   * Fit per investor type: the compare dimensions weighed for that investor (65%), blended with the page's own score for
   * that investor (35%: the company against its industry, or the fund's look-through scorecard) when there is one,
   * then nudged by a written analysis's fit (strong +6, good +2, weak -3, poor -7). Returns {type: {SYM: {...}, ranked}}.
   */
  function fits(subjects, sc) {
    const out = {};
    for (const t of TYPES) {
      const row = {};
      for (const s of subjects) {
        const G = sc[s.sym]?.groups || {}; let w = 0, a = 0; const pulls = [];
        for (const [g, wt] of Object.entries(WEIGHTS[t])) { const v = G[g]?.score; if (!isNum(v)) continue; w += wt; a += wt * v; pulls.push({ g, wt, v }); }
        const cmp = w ? a / w : NaN, own = n(s.profiles?.[t]?.total), fit = s.saved?.fit?.[t]?.fit || s.profiles?.[t]?.fit || null;
        // Thin evidence is pulled toward the middle: with under 70% of this investor's weights scored, the score shrinks toward 50.
        const shrink = clamp(w / 70, 0.5, 1), cmpS = isNum(cmp) ? 50 + (cmp - 50) * shrink : NaN;
        let total = isNum(cmpS) && isNum(own) ? 0.65 * cmpS + 0.35 * own : isNum(cmpS) ? cmpS : own;
        if (isNum(total)) total = clamp(total + (OVL[fit] || 0), 0, 100);
        const lift = pulls.map((p) => ({ ...p, pull: (p.wt * (p.v - 50)) / (w || 1) })).sort((x, y) => y.pull - x.pull);
        row[s.sym] = { total: isNum(total) ? r1(total) : NaN, grade: grade(total), cmp: isNum(cmp) ? r1(cmp) : NaN, own: isNum(own) ? r1(own) : NaN, fit, coverage: w / 100,
          lifts: lift.filter((p) => p.pull > 0.5).slice(0, 3).map((p) => p.g), holds: lift.filter((p) => p.pull < -0.5).reverse().slice(0, 3).map((p) => p.g) };
      }
      const ranked = subjects.map((s) => s.sym).filter((k) => isNum(row[k].total)).sort((x, y) => row[y].total - row[x].total);
      out[t] = { ...row, ranked };
    }
    return out;
  }

  /** Head to head on every metric two or more of them have: values, scores and the leader. */
  function headToHead(subjects, sc) {
    const rows = [];
    for (const def of M) {
      const vals = subjects.map((s) => ({ sym: s.sym, v: sc[s.sym]?.metrics?.[def.key]?.v, s: sc[s.sym]?.metrics?.[def.key]?.s }));
      const have = vals.filter((x) => isNum(x.v)); if (have.length < 2) continue;
      const better = (a, b) => (def.up ? a.v > b.v : a.v < b.v), best = have.reduce((a, x) => (better(x, a) ? x : a)), tie = have.filter((x) => Math.abs(x.v - best.v) <= Math.abs(best.v) * 1e-9).length > 1;
      rows.push({ ...def, vals, leader: tie ? null : best.sym });
    }
    const tally = Object.fromEntries(subjects.map((s) => [s.sym, 0])); for (const r of rows) if (r.leader) tally[r.leader]++;
    const groups = {};
    for (const g of GROUP_KEYS) {
      const vals = subjects.map((s) => ({ sym: s.sym, score: sc[s.sym]?.groups?.[g]?.score, from: sc[s.sym]?.groups?.[g]?.from }));
      const have = vals.filter((x) => isNum(x.score)); if (have.length < 2) continue;
      const sorted = [...have].sort((a, b) => b.score - a.score), margin = sorted[0].score - sorted[1].score;
      groups[g] = { vals, leader: margin >= 3 ? sorted[0].sym : null, margin: r1(margin) };
    }
    return { rows, tally, groups };
  }

  // ----------------------------------------------------------------- prices: rebasing, correlation, drawdowns
  /** Daily returns keyed by date. */
  function rets(ser) { const m = new Map(); const d = ser?.dates || [], c = ser?.closes || []; for (let i = 1; i < d.length; i++) if (c[i - 1] > 0 && c[i] > 0) m.set(d[i], c[i] / c[i - 1] - 1); return m; }
  /** Correlation of daily returns over the last `days` common trading days, and what an equal mix does to volatility. */
  function correlation(subjects, days = 252) {
    const R = subjects.map((s) => rets(s.ser)), syms = subjects.map((s) => s.sym);
    let common = [...(R[0]?.keys() || [])].filter((d) => R.every((m) => m.has(d))).sort(); common = common.slice(-days);
    const k = syms.length, mat = Array.from({ length: k }, () => Array(k).fill(NaN));
    if (common.length < 60) return { syms, corr: mat, n: common.length, vols: [], mixVol: NaN, avgVol: NaN };
    const X = R.map((m) => common.map((d) => m.get(d))), mu = X.map(mean);
    const sd = X.map((x, i) => Math.sqrt(mean(x.map((v) => (v - mu[i]) ** 2))));
    for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) { const c = mean(X[i].map((v, t) => (v - mu[i]) * (X[j][t] - mu[j]))); mat[i][j] = sd[i] && sd[j] ? Math.round((c / (sd[i] * sd[j])) * 100) / 100 : NaN; }
    const mix = common.map((_, t) => mean(X.map((x) => x[t]))), mm = mean(mix), mixVol = Math.sqrt(mean(mix.map((v) => (v - mm) ** 2))) * Math.sqrt(252);
    const vols = sd.map((v) => v * Math.sqrt(252));
    return { syms, corr: mat, n: common.length, vols, mixVol, avgVol: mean(vols) };
  }
  /** Each series rebased to 100 at the first date on or after `from`, on the dates all of them share. */
  function rebase(subjects, from) {
    const maps = subjects.map((s) => new Map((s.ser?.dates || []).map((d, i) => [d, s.ser.closes[i]])));
    const dates = (subjects[0]?.ser?.dates || []).filter((d) => d >= from && maps.every((m) => m.get(d) > 0));
    return subjects.map((s, i) => { const b = maps[i].get(dates[0]); return { sym: s.sym, dates, values: dates.map((d) => (100 * maps[i].get(d)) / b) }; });
  }
  /** Drawdown from the running peak, over the series (fractions, 0 or below). */
  function drawdown(dates, values) { let pk = -Infinity; return { dates, values: values.map((v) => { pk = Math.max(pk, v); return v / pk - 1; }) }; }
  /** Calendar-year returns for each, where the year has data for all of them. */
  function years(subjects) {
    const ys = {};
    for (const s of subjects) { const d = s.ser?.dates || [], c = s.ser?.closes || []; const last = {}; d.forEach((x, i) => { last[x.slice(0, 4)] = c[i]; }); ys[s.sym] = last; }
    const all = [...new Set(Object.values(ys).flatMap((y) => Object.keys(y)))].sort();
    const out = [];
    for (let i = 1; i < all.length; i++) { const y = all[i], p = all[i - 1]; const row = { year: y };
      for (const s of subjects) { const a = ys[s.sym][p], b = ys[s.sym][y]; row[s.sym] = a > 0 && b > 0 ? b / a - 1 : NaN; }
      if (subjects.every((s) => isNum(row[s.sym]))) out.push(row); }
    return out.slice(-6);
  }

  /** Holdings overlap: for two funds, the weight they share (sum of the smaller weight of each common holding); for a stock and a fund, the stock's weight in the fund. */
  function overlap(subjects) {
    const out = [];
    for (let i = 0; i < subjects.length; i++) for (let j = i + 1; j < subjects.length; j++) {
      const a = subjects[i], b = subjects[j];
      if (a.kind === "fund" && b.kind === "fund") { const wb = new Map((b.holdings || []).map((h) => [h.ticker, h.weight])); let s = 0, k = 0; const top = [];
        for (const h of a.holdings || []) { const w = wb.get(h.ticker); if (isNum(w) && isNum(h.weight)) { const m = Math.min(w, h.weight); s += m; k++; top.push({ ticker: h.ticker, w: m }); } }
        out.push({ a: a.sym, b: b.sym, kind: "funds", shared: s, n: k, top: top.sort((x, y) => y.w - x.w).slice(0, 5) }); }
      else if (a.kind !== b.kind) { const f = a.kind === "fund" ? a : b, st = a.kind === "fund" ? b : a; const h = (f.holdings || []).find((x) => x.ticker === st.sym);
        out.push({ a: st.sym, b: f.sym, kind: "stock-in-fund", shared: h ? h.weight : 0, n: h ? 1 : 0, top: [] }); }
    }
    return out;
  }

  // ----------------------------------------------------------------- the dossier and the one Claude call
  const fmtV = (kind, v) => !isNum(v) ? "n/a" : kind === "pct" ? (v * 100).toFixed(1) + "%" : kind === "chg" ? (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%" : kind === "x" ? v.toFixed(2) + "x" : kind === "usd" ? (Math.abs(v) >= 1e12 ? "$" + (v / 1e12).toFixed(2) + "T" : Math.abs(v) >= 1e9 ? "$" + (v / 1e9).toFixed(1) + "B" : Math.abs(v) >= 1e6 ? "$" + (v / 1e6).toFixed(0) + "M" : "$" + v.toFixed(2)) : String(Math.round(v * 100) / 100);
  const cut = (s, k) => { s = String(s ?? "").replace(/\[[A-Z]{1,3}\d+\]/g, "").replace(/\s+/g, " ").trim(); return s.length > k ? s.slice(0, k - 1) + "…" : s; };

  /** Everything the call reads, as compact text: per ticker (its numbers, written analysis, industry report), then code's comparison. */
  function dossier({ subjects, sc, fit, h2h, corr, ovl, today }) {
    const L = [`TODAY: ${today}`, `TICKERS: ${subjects.map((s) => `${s.sym} (${s.kind}${s.sub ? `, ${s.sub}` : ""})`).join("; ")}`, ""];
    for (const s of subjects) {
      L.push(`=== ${s.sym}: ${s.name || ""} (${s.kind === "fund" ? "fund/ETF" : "stock"}${s.sub ? `, ${s.sub}` : ""}${s.sector ? `, ${s.sector}` : ""}) ===`);
      const nums = M.filter((d) => isNum(n(s.m?.[d.key]))).map((d) => `${d.label} ${fmtV(d.kind, n(s.m[d.key]))}`);
      const info = INFO.filter(([k]) => isNum(n(s.m?.[k]))).map(([k, l, kd]) => `${l} ${fmtV(kd, n(s.m[k]))}`);
      if (info.length) L.push("Size: " + info.join("; "));
      if (nums.length) L.push("Numbers: " + nums.join("; "));
      const G = sc[s.sym]?.groups || {};
      L.push("Code's dimension scores (0-100, fixed scales): " + GROUP_KEYS.filter((g) => isNum(G[g]?.score)).map((g) => `${GROUPS[g].label} ${Math.round(G[g].score)}${G[g].from !== "numbers" ? ` (${G[g].from})` : ""}`).join("; "));
      L.push("Code's fit by investor: " + TYPES.map((t) => `${TYPE_LABEL[t]} ${isNum(fit[t][s.sym].total) ? Math.round(fit[t][s.sym].total) : "n/a"}${fit[t][s.sym].fit ? ` (written fit ${fit[t][s.sym].fit})` : ""}`).join("; "));
      const o = s.outlook; if (o?.calls) L.push(`1M-12M calls (${o.source}${o.date ? `, ${o.date}` : ""}): ` + HZ.map((h) => `${h} ${o.calls[h]?.call || "n/a"}${o.calls[h]?.why ? ` (${cut(o.calls[h].why, 160)})` : ""}`).join("; "));
      const v = s.saved;
      if (v) {
        L.push(`WRITTEN ANALYSIS (${v.via === "github" ? "made on GitHub" : "made here"}, ${String(v.at || "").slice(0, 10)}):`);
        if (v.headline) L.push(`- Headline: ${cut(v.headline, 300)}`);
        if (v.verdict) L.push(`- Verdict: ${v.verdict.call || ""}${v.verdict.summary ? ` — ${cut(v.verdict.summary, 400)}` : ""}`);
        if (v.vs_benchmark) L.push(`- Against its benchmark: ${v.vs_benchmark}`);
        if (v.thesis) L.push(`- Thesis: ${cut(v.thesis, 900)}`);
        if (v.scenarios?.length) L.push(`- 12-month scenarios: ${v.scenarios.map((x) => `${x.k} ${x.probability ?? "?"}%${isNum(x.target) ? ` target ${x.target.toFixed(2)}` : ""}${isNum(x.move) ? ` (${fmtV("chg", x.move)})` : ""}`).join("; ")}${isNum(v.expected) ? `; probability-weighted ${fmtV("chg", v.expected)}` : ""}`);
        for (const t of TYPES) if (v.fit?.[t]) L.push(`- For ${TYPE_LABEL[t]}: ${v.fit[t].fit || ""}${v.fit[t].why ? ` — ${cut(v.fit[t].why, 260)}` : ""}`);
        if (v.risks?.length) L.push(`- Risks: ${v.risks.slice(0, 5).map((x) => cut(x, 140)).join(" | ")}`);
        if (v.catalysts?.length) L.push(`- Catalysts: ${v.catalysts.slice(0, 5).map((x) => cut(x, 140)).join(" | ")}`);
      } else L.push("WRITTEN ANALYSIS: none yet (judge from the numbers and the industry report).");
      const ind = s.ind;
      if (ind) {
        L.push(`INDUSTRY REPORT${ind.name ? ` (${ind.name}${ind.saved_at ? `, ${String(ind.saved_at).slice(0, 10)}` : ""})` : ""}:`);
        if (ind.headline) L.push(`- Lead: ${cut(ind.headline, 300)}`);
        if (ind.opportunity) L.push(`- Opportunity: ${ind.opportunity.verdict || ""}${ind.opportunity.why ? ` — ${cut(ind.opportunity.why, 300)}` : ""}`);
        if (ind.outlook?.calls) L.push(`- Industry calls: ${HZ.map((h) => `${h} ${ind.outlook.calls[h]?.call || "n/a"}`).join("; ")}`);
        if (ind.scenarios) L.push(`- Industry scenarios: ${["bull", "base", "bear"].filter((k) => ind.scenarios[k]).map((k) => `${k} ${ind.scenarios[k].probability ?? "?"}%: ${cut(ind.scenarios[k].narrative, 140)}`).join(" | ")}`);
        if (ind.drivers?.length) L.push(`- Drivers: ${ind.drivers.slice(0, 4).map((x) => cut(x, 140)).join(" | ")}`);
        if (ind.risks?.length) L.push(`- Risks: ${ind.risks.slice(0, 4).map((x) => cut(x, 140)).join(" | ")}`);
        if (ind.catalysts?.length) L.push(`- Catalysts: ${ind.catalysts.slice(0, 4).map((x) => cut(x, 140)).join(" | ")}`);
        if (ind.mix?.length) L.push(`- What it holds, by industry: ${ind.mix.slice(0, 8).map((x) => `${x.industry} ${(x.weight * 100).toFixed(1)}%${x.call ? ` (12M ${x.call})` : ""}`).join("; ")}`);
      }
      L.push("");
    }
    L.push("=== CODE'S COMPARISON ===");
    L.push("Dimension leaders: " + Object.entries(h2h.groups).map(([g, x]) => `${GROUPS[g].label}: ${x.leader || "tie"} (${x.vals.filter((y) => isNum(y.score)).map((y) => `${y.sym} ${Math.round(y.score)}`).join(", ")})`).join("; "));
    L.push("Metric wins: " + Object.entries(h2h.tally).map(([k, v]) => `${k} ${v}`).join(", ") + ` of ${h2h.rows.length} metrics`);
    for (const t of TYPES) L.push(`${TYPE_LABEL[t]} ranking by code: ${fit[t].ranked.map((k) => `${k} ${Math.round(fit[t][k].total)}`).join(" > ")}`);
    if (corr?.n >= 60) L.push(`Correlation of daily returns (${corr.n} days): ${corr.syms.flatMap((a, i) => corr.syms.slice(i + 1).map((b, j) => `${a}/${b} ${corr.corr[i][i + 1 + j]}`)).join("; ")}; an equal mix's volatility ${fmtV("pct", corr.mixVol)} vs ${fmtV("pct", corr.avgVol)} on average alone`);
    for (const o of ovl || []) L.push(o.kind === "funds" ? `Holdings overlap ${o.a}/${o.b}: ${fmtV("pct", o.shared)} shared across ${o.n} names` : `${o.a} is ${fmtV("pct", o.shared)} of ${o.b}`);
    return L.join("\n");
  }

  function prompt(text, syms, today, desks = "") {
    const S = syms.join(" | ");
    return `You are the head of research at an investment firm, writing the comparison desk's verdict on ${syms.join(", ")} for ${today}. Your colleagues have already done the work: the numbers, each name's industry report and, where they exist, full written analyses of the company or fund. Code has scored every dimension on fixed scales and ranked them for four investor types.${desks ? " Four desks have each read the full dossiers on their own question: the events desk (the next 12 months event by event, with outcomes and odds), the macro and foreign affairs desk (the full macro indicator tables, world situations, trade and regulation), the street and sentiment desk (Wall Street, news sentiment, positioning) and the fundamentals desk (business, valuation, balance sheet). Their findings are at the end." : ""} Read all of it and decide. Weigh the future most: a cheap stock walking into a bad year is not the better buy; say which dated events and macro scenarios decide the call.

Rules:
- Decide. Every "pick" is exactly one of: ${S}. No ties, no "it depends" without saying on what.
- Be specific and analytical: every "why" cites the numbers that decide it (e.g. "forward P/E 18x vs 31x", "volatility 22% vs 35%", "the industry's 12M call is bullish vs bearish"). Use the written analyses and industry reports where they exist; say so when a name has no written analysis.
- Compare like with like: a fund against a stock is a choice between owning a basket and owning one company; say what that trade means (diversification, concentration, cost).
- You may depart from code's scores and rankings, but when you do, say why in that field.
- Investor types: income (dependable cash income, capital preservation second), conservative (low drawdowns, steady compounding), growth (above-market growth over 1-3 years, accepts swings), aggressive (maximum upside, accepts big drawdowns).
- "Overall" means the best single choice for a balanced investor who weighs all four types equally. It must be consistent with your investor picks: the overall pick must also be your pick for at least one investor type, and normally the one that wins the most types or is first or second for all of them. If the name you'd call best overall wins none of the four, either it should win one of them (change that pick and say why) or it isn't the best overall. "ranking" starts with the overall pick.
- Plain English, no hedging boilerplate, no invented facts: use only what is in the dossier.

${text}
${desks ? `
${desks}
` : ""}
Return ONLY a JSON object:
{"headline": "one sentence, at most 30 words: which is better overall and the single biggest reason",
 "overall": {"pick": "${syms[0]}", "confidence": "high | medium | low", "why": "4-6 sentences on why it wins overall: the numbers, what's ahead (dated events, macro), what Wall Street and sentiment say, and what would flip it"},
 "ranking": [${syms.map((s) => `"${s}"`).join(", ")}] (best to worst overall),
 "investors": {"income": {"pick": "...", "runner_up": "...", "why": "2-3 sentences with numbers", "avoid": "which to avoid for this investor and why, one sentence"}, "conservative": {...}, "growth": {...}, "aggressive": {...}},
 "horizons": {"1M": {"pick": "...", "why": "one or two sentences"}, "3M": {...}, "6M": {...}, "12M": {...}},
 "dimensions": [{"key": "one of ${GROUP_KEYS.join(", ")}, plus \"events\" (what's ahead) and \"macro\" (the macro backdrop)", "pick": "...", "why": "two sentences with the numbers"}] (every dimension where at least two of them have data),
 "names": {"${syms[0]}": {"verdict": "buy | accumulate | hold | trim | avoid", "entry": "when or at what price to buy, tied to the price levels or a dated event", "role": "the job it does in a portfolio, one sentence", "edge": "its single biggest advantage over the others, with a number", "strengths": ["3-5 short points with numbers"], "weaknesses": ["3-5 short points with numbers"], "bull": "the bull case in 1-2 sentences", "bear": "the bear case in 1-2 sentences", "watch": ["2-4 things or dates to watch"], "changes_mind": "what would change the verdict"}, ...one entry per ticker},
 "together": {"pairing": "2-3 sentences: do they belong together (correlation, overlap, what each adds)?", "mix": {"${syms[0]}": 50, ...} (a suggested split for a balanced investor who wants to own some of these; whole percents summing to 100; 0 to leave one out)},
 "risks": ["3-5 risks that cut across the comparison"],
 "bottom_line": "3-4 sentences: what to do, for whom, and when to revisit"}`;
  }



  // ----------------------------------------------------------------- the macro table and foreign affairs, side by side
  const EFF_RANK = { tailwind: 1, neutral: 0, headwind: -1 }, REL_RANK = { high: 3, medium: 2, low: 1 };
  const topKey = (t) => Object.entries(t || {}).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  const tkey = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim().slice(0, 48);
  /**
   * Every ticker's affairs (FundMore.affairs: its industries' full macro tables, world situations, trade maps and
   * regulation, at its weights) merged into one row per indicator, situation, country and rule, with each ticker's read.
   */
  // ---- a bond fund has no industries: code reads each macro indicator through its duration and what it holds
  const BOND_RULES = [
    // [test on the label, category, what a rise does to Treasuries, to credit, relevance by duration (short, long)]
    [/fed funds|policy rate|interest rate decision|fomc|\b2[- ]?y(ear)?\b|\b3[- ]?m(onth)?\b|t-?bill/i, "the Fed and the short end", "headwind", "headwind", ["high", "high"]],
    [/10[- ]?y|30[- ]?y|treasury|yield|mortgage rate|term premium/i, "long yields", "headwind", "headwind", ["low", "high"]],
    [/cpi|pce|ppi|inflation|price index|wage|earnings growth|hourly earnings|import prices|breakeven/i, "inflation", "headwind", "headwind", ["medium", "high"]],
    [/unemployment|jobless|claims|layoff|challenger/i, "labor slack", "tailwind", "headwind", ["medium", "medium"]],
    [/vix|volatility|move index|credit spread|hy spread|ig spread|oas/i, "risk aversion", "tailwind", "headwind", ["low", "medium"]],
    [/brent|wti|oil|gasoline|rbob|energy/i, "energy prices (inflation)", "headwind", "neutral", ["low", "medium"]],
    [/gdp|payroll|nonfarm|jobs|retail|spending|pmi|ism|industrial production|durable|housing starts|sentiment|confidence|income|consumer|capex|orders/i, "growth", "headwind", "tailwind", ["low", "medium"]],
  ];
  const nn = (v) => (typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/[,%$]/g, "")));
  /** How one macro indicator moves a bond fund: its direction (from the 1M change or the prior), what that does to the fund, how much its duration makes it matter. */
  function bondRead(bond, x) {
    const lab = `${x.label || ""} ${x.key || ""}`, rule = BOND_RULES.find((r) => r[0].test(lab)); if (!rule) return null;
    const dur = nn(bond.duration), long = isNum(dur) && dur >= 5, credit = !!bond.credit, tips = /tips|inflation/i.test(bond.kind || "");
    const ch = isNum(nn(x.chg_1m)) ? nn(x.chg_1m) : isNum(nn(x.value)) && isNum(nn(x.prior)) ? nn(x.value) - nn(x.prior) : NaN;
    let up = credit && !/treasur/i.test(bond.kind || "") ? rule[3] : rule[2];
    if (tips && /inflation|energy/.test(rule[1])) up = "tailwind";
    const flip = (e) => (e === "headwind" ? "tailwind" : e === "tailwind" ? "headwind" : "neutral");
    const effect = !isNum(ch) || Math.abs(ch) < 1e-9 ? "neutral" : ch > 0 ? up : flip(up);
    const relevance = rule[4][long ? 1 : 0];
    const why = `${isNum(dur) ? `${dur.toFixed(1)}-year duration` : "a bond fund"}: ${rule[1]} ${isNum(ch) ? (ch > 0 ? "rising" : ch < 0 ? "falling" : "flat") : "unchanged"} is a ${effect === "neutral" ? "wash" : effect} for ${credit ? "credit" : "Treasuries"}${rule[1] === "long yields" && !long ? " (it holds little of the long end)" : ""}.`;
    return { effect, relevance, why, read_by: 0, rule: rule[1] };
  }
  /** A bond fund's row in "each industry's macro call": its stance from the high- and medium-relevance reads, and its carry and breakeven. */
  function bondRegime(s, reads) {
    const b = s.bond || {}, sc = reads.reduce((a, r) => a + (EFF_RANK[r.effect] || 0) * (r.relevance === "high" ? 2 : r.relevance === "medium" ? 1 : 0.3), 0);
    const regime = sc >= 1.5 ? "supportive" : sc <= -1.5 ? "restrictive" : "mixed", pc = (v) => (isNum(nn(v)) ? nn(v).toFixed(2) + "%" : "n/a");
    const sh = (b.shocks || []).find((x) => x.bp === 100), shd = (b.shocks || []).find((x) => x.bp === -100);
    const headline = s.bondHeadline || `Yield to maturity ${pc(b.ytm)}, carry after costs ${pc(b.carry)} a year${isNum(nn(b.breakeven)) ? `; yields can rise about ${Math.round(nn(b.breakeven))}bp over 12 months before the price loss eats a year's carry` : ""}${sh && isNum(nn(sh.ret12)) ? `; +100bp → ${nn(sh.ret12) > 0 ? "+" : ""}${nn(sh.ret12).toFixed(1)}% over 12 months` : ""}${shd && isNum(nn(shd.ret12)) ? `, -100bp → ${nn(shd.ret12) > 0 ? "+" : ""}${nn(shd.ret12).toFixed(1)}%` : ""}.`;
    return { sym: s.sym, industry: `${b.kind ? b.kind[0].toUpperCase() + b.kind.slice(1) : "Bonds"}${isNum(nn(b.duration)) ? ` · ${nn(b.duration).toFixed(1)}y duration` : ""}`, weight: 1, regime, headline, summary: "", bond: true };
  }
  function mergeAffairs(subjects) {
    const I = new Map(), W = new Map(), T = new Map(), R = new Map(), P = new Map(), regimes = [], moves = [], flips = [];
    for (const s of subjects) {
      const A = s.aff; if (!A) continue;
      for (const r of A.regimes || []) regimes.push({ sym: s.sym, industry: r.industry, weight: r.weight, regime: r.regime || "", headline: r.headline || "", summary: r.summary || "" });
      for (const m of (A.moves || []).slice(0, 6)) moves.push({ sym: s.sym, label: m.label, move: m.move, driver: m.driver, so_what: m.so_whats?.[0]?.so_what || m.so_what || "" });
      for (const f of (A.flips || []).slice(0, 4)) flips.push({ sym: s.sym, industry: f.industry, trigger: f.trigger, mechanism: f.mechanism, watch: f.watch || "" });
      for (const x of A.indicators || []) {
        const k = x.key || tkey(x.label), e = I.get(k) || { key: k, label: x.label, group: x.group || "", value: x.value, unit: x.unit || "", prior: x.prior, prior_label: x.prior_label || "", estimate: x.estimate,
          chg_1m: x.chg_1m, chg_3m: x.chg_3m, chg_1y: x.chg_1y, period: x.period || "", date: x.date || "", driver: x.driver || "", next: x.next || "", per: {} };
        const reads = [...(x.reads || [])].sort((a, b) => (REL_RANK[b.relevance] || 0) - (REL_RANK[a.relevance] || 0) || b.weight - a.weight), r0 = reads[0];
        e.per[s.sym] = { effect: topKey(x.effects) || r0?.effect || "", relevance: r0?.relevance || "", why: r0?.why || "", read_by: x.read_by || 0 };
        if (!e.driver && x.driver) e.driver = x.driver; if (!e.next && x.next) e.next = x.next; I.set(k, e);
      }
      for (const x of A.world || []) {
        const k = tkey(x.title), e = W.get(k) || { title: x.title, category: x.category || "", region: x.region || "", status: x.status || "", deep: !!x.deep, summary: x.summary || "", now: x.now || "", near_term: x.near_term || "",
          trigger: x.trigger || "", first_order: x.first_order || "", scenarios: x.scenarios || [], watch: x.watch || [], developments: x.developments || [], per: {} };
        if (!e.deep && x.deep) Object.assign(e, { deep: true, summary: x.summary || e.summary, now: x.now || e.now, near_term: x.near_term || e.near_term, scenarios: x.scenarios || e.scenarios, watch: x.watch || e.watch, developments: x.developments || e.developments });
        e.per[s.sym] = { stance: topKey(x.stances) || x.stance || "", named: s.kind === "fund" ? [...(x.winners_held || []).map((y) => "+" + y.symbol), ...(x.losers_held || []).map((y) => "-" + y.symbol)].slice(0, 4) : [] };
        W.set(k, e);
      }
      for (const x of A.trade || []) {
        const k = tkey(x.country), e = T.get(k) || { country: x.country, importance: x.importance || "", threat: x.threat || "", trajectory: x.trajectory || "", alliance: x.alliance || "", headline: x.headline || "", outlook: x.outlook || "", risks: x.risks || [], per: {} };
        e.per[s.sym] = { rev: isNum(n(x.rev)) ? n(x.rev) : null, est: !!x.rev_est, stance: topKey(x.stances) || x.stance || "", threat: x.threat || "" }; T.set(k, e);
      }
      for (const x of A.rules || []) { const k = tkey(x.name), e = R.get(k) || { body: x.body || "", name: x.name, status: x.status || "", effective: x.effective || "", severity: x.severity || "", bottom_line: x.bottom_line || "", next12: x.next12 || "", per: {} };
        e.per[s.sym] = { severity: x.severity || "" }; R.set(k, e); }
      for (const x of A.items || []) { const k = tkey(x.title), e = P.get(k) || { kind: x.kind || "", title: x.title, status: x.status || "", date: x.date || "", text: x.text || "", next: x.next || "", per: {} };
        e.per[s.sym] = { direction: x.direction || "" }; P.set(k, e); }
    }
    // Bond funds: their industries' tables don't exist, so read every indicator (and the runs' rate and inflation rows) through the fund's duration.
    for (const s of subjects) {
      if (!s.bond || (s.aff?.indicators || []).length) continue;
      for (const x of s.bondInd || []) { const k = x.key || tkey(x.label); if (!I.has(k) && ![...I.values()].some((e) => tkey(e.label) === tkey(x.label)))
        I.set(k, { key: k, label: x.label, group: x.group || "Rates & inflation (from your industry runs)", value: x.value, unit: x.unit || "", prior: x.prior, prior_label: x.prior_label || "", estimate: x.estimate, chg_1m: x.chg_1m, chg_3m: x.chg_3m, chg_1y: x.chg_1y, period: x.period || "", date: x.date || "", driver: x.driver || "", next: x.next || "", per: {} }); }
      const reads = [];
      for (const e of I.values()) { const r = bondRead(s.bond, e); if (r) { e.per[s.sym] = r; reads.push(r); } }
      regimes.push(bondRegime(s, reads));
    }
    const n0 = (e) => Object.keys(e.per).length;
    const GORD = {}; [...I.values()].forEach((e) => { GORD[e.group] = Math.max(GORD[e.group] || 0, n0(e)); });
    const sev = { critical: 0, high: 1, medium: 2, low: 3 };
    return {
      regimes, moves: moves.slice(0, 16), flips: flips.slice(0, 10),
      indicators: [...I.values()].sort((a, b) => (GORD[b.group] || 0) - (GORD[a.group] || 0) || String(a.group).localeCompare(String(b.group)) || n0(b) - n0(a)),
      world: [...W.values()].sort((a, b) => (b.deep - a.deep) || n0(b) - n0(a)).slice(0, 18),
      trade: [...T.values()].sort((a, b) => Math.max(0, ...Object.values(b.per).map((x) => x.rev || 0)) - Math.max(0, ...Object.values(a.per).map((x) => x.rev || 0)) || n0(b) - n0(a)).slice(0, 16),
      rules: [...R.values()].sort((a, b) => (sev[a.severity] ?? 4) - (sev[b.severity] ?? 4) || n0(b) - n0(a)).slice(0, 14),
      items: [...P.values()].sort((a, b) => n0(b) - n0(a) || String(b.date).localeCompare(String(a.date))).slice(0, 12),
    };
  }

  // ----------------------------------------------------------------- the four desks and the head of research
  /**
   * The verdict is made the way the industry runs are: specialists first, then one head of research. Four desks read
   * the full dossiers in parallel, each on its own question; the head of research reads code's comparison and the
   * desks' findings and decides.
   *   events: what's ahead, event by event (the dated 12-month calendar, the macro releases the industries watch, the
   *           industries' 1M-12M cards and windows, earnings and their history, factor sensitivities, times like this)
   *   macro: the full macro indicator tables and each industry's read of every indicator, the macro calls, and foreign
   *          affairs (world situations and threats, the trade map country by country, regulation and policy)
   *   street: Wall Street (ratings, targets, revisions, rating changes), news sentiment and headlines, positioning
   *          (short interest, insiders, institutions), technicals and earnings reactions
   *   fundamentals: the business, growth, quality, valuation, balance sheet, income and what the price assumes
   */
  const DESKS = {
    events: { label: "Events desk", stock: ["calls", "watch", "windows", "facts", "times"], fund: ["bond", "cal", "watch", "hold", "cyc", "deb", "tech"], shared: [] },
    macro: { label: "Macro & foreign affairs desk", stock: ["aff_macro", "aff_world", "aff_trade", "aff_reg", "context", "facts"], fund: ["bond", "aff_macro", "aff_world", "aff_trade", "aff_reg", "ind", "hold"], shared: ["aff_macro", "aff_world", "aff_trade", "aff_reg", "context"] },
    street: { label: "Street & sentiment desk", stock: ["street", "numbers", "news"], fund: ["base", "tech", "hold", "perf"], shared: [] },
    fundamentals: { label: "Fundamentals desk", stock: ["numbers", "written"], fund: ["bond", "base", "hold", "ind", "val", "score", "perf"], shared: [] },
  };
  const DESK_KEYS = Object.keys(DESKS);
  const SHARED_LABEL = { aff_macro: "Macro indicators and the macro call", aff_world: "World situations", aff_trade: "The trade map", aff_reg: "Regulation", context: "The industry report's macro, world, scenario and debate rows" };
  const capT = (s, k) => { s = String(s || ""); return s.length > k ? s.slice(0, k) + "\n(…cut to fit)" : s; };
  function writtenText(v) {
    if (!v) return "";
    const L = [`WRITTEN ANALYSIS (${v.via === "github" ? "made on GitHub" : "made here"}, ${String(v.at || "").slice(0, 10)})`];
    if (v.headline) L.push(`Headline: ${cut(v.headline, 300)}`);
    if (v.verdict) L.push(`Verdict: ${v.verdict.call || ""}${v.verdict.summary ? ` — ${cut(v.verdict.summary, 500)}` : ""}`);
    if (v.vs_benchmark) L.push(`Against its benchmark: ${v.vs_benchmark}`);
    if (v.thesis) L.push(`Thesis: ${cut(v.thesis, 2500)}`);
    if (v.scenarios?.length) L.push(`12-month scenarios: ${v.scenarios.map((x) => `${x.k} ${x.probability ?? "?"}%${isNum(x.target) ? ` target ${x.target.toFixed(2)}` : ""}${isNum(x.move) ? ` (${fmtV("chg", x.move)})` : ""}`).join("; ")}${isNum(v.expected) ? `; probability-weighted ${fmtV("chg", v.expected)}` : ""}`);
    for (const t of TYPES) if (v.fit?.[t]) L.push(`For ${TYPE_LABEL[t]}: ${v.fit[t].fit || ""}${v.fit[t].why ? ` — ${cut(v.fit[t].why, 300)}` : ""}`);
    if (v.risks?.length) L.push(`Risks: ${v.risks.slice(0, 6).map((x) => cut(x, 160)).join(" | ")}`);
    if (v.catalysts?.length) L.push(`Catalysts: ${v.catalysts.slice(0, 6).map((x) => cut(x, 160)).join(" | ")}`);
    return L.join("\n");
  }
  /** One desk's dossier: each ticker's blocks for that desk; an industry's shared blocks once for all the tickers in it. */
  const AFF_KEYS = ["aff_macro", "aff_world", "aff_trade", "aff_reg"];
  /**
   * One desk's dossier. combined: the macro table, world situations, trade map and regulation of every industry behind
   * every ticker as one text (each indicator, situation, country and rule once, with every industry's read of it); when
   * given, the macro desk reads it instead of each ticker's own copy, so a shared indicator or situation isn't sent twice.
   */
  function deskDossier(desk, subjects, { total = 300000, extra = "", combined = "" } = {}) {
    if (extra) total -= Math.min(extra.length, 30000);
    const useComb = !!combined && desk === "macro"; if (useComb) total -= Math.min(combined.length, 200000);
    // A ticker with no industries in the combined text (a bond fund, a stock no run covers) keeps its own copy.
    const D = DESKS[desk], inComb = (s) => useComb && !!s.affIn?.industries?.length, keysOf = (s) => (s.kind === "fund" ? D.fund : D.stock).filter((k) => !(inComb(s) && AFF_KEYS.includes(k)));
    const out = [...(extra ? [capT(extra, 30000)] : []), ...(useComb ? [capT(combined, 200000)] : [])], sharedDone = {}, CAP = { bond: 20000, hold: 14000, ind: 20000, calls: 45000, context: 22000, aff_macro: 40000, aff_world: 40000, aff_trade: 22000, aff_reg: 16000, exposures: 22000, facts: 12000, times: 8000, windows: 5000, watch: 6000, news: 15000 };
    // Each ticker gets an even share of the room; a ticker whose industry blocks were already given (a shared industry) leaves its unused room to the rest.
    const need = subjects.map((s) => keysOf(s).reduce((a, k) => a + Math.min(String(s.dz?.[k] || "").length, CAP[k] || 1e9), 0));
    let room = total; const budgets = need.map(() => 0); const order = need.map((x, i) => i).sort((a, b) => need[a] - need[b]);
    order.forEach((i, j) => { const share = Math.floor(room / (order.length - j)); budgets[i] = Math.max(15000, Math.min(need[i] + 4000, share)); room -= budgets[i]; });
    for (const s of subjects) {
      const z = { ...(s.dz || {}), written: writtenText(s.saved) }, keys = keysOf(s), parts = [];
      const o = s.outlook; if (o?.calls) parts.push(`ITS 1M-12M CALLS (${o.source}${o.date ? `, ${o.date}` : ""}): ${HZ.map((h) => `${h} ${o.calls[h]?.call || "n/a"}${o.calls[h]?.why ? ` (${cut(o.calls[h].why, 200)})` : ""}`).join("; ")}`);
      if (desk === "street" && s.saved) parts.push(writtenText(s.saved));
      if (desk === "events" && s.saved?.catalysts?.length) parts.push(`ITS WRITTEN ANALYSIS'S CATALYSTS: ${s.saved.catalysts.slice(0, 8).map((x) => cut(x, 200)).join(" | ")}`);
      for (const k of keys) { if (!z[k]) continue;
        if (s.kind === "stock" && D.shared.includes(k) && s.ind?.name) { const key = s.ind.name + "|" + k; if (sharedDone[key]) { parts.push(`(${SHARED_LABEL[k] || k}: the same ${s.ind.name} industry report as ${sharedDone[key]}, above.)`); continue; } sharedDone[key] = s.sym; }
        parts.push(capT(z[k], CAP[k] || 1e9)); }
      out.push(`=== ${s.sym}: ${s.name || ""} (${s.kind === "fund" ? "fund/ETF" : "stock"}${s.sub ? `, ${s.sub}` : ""}) ===\n` + capT(parts.join("\n\n"), budgets[subjects.indexOf(s)]));
    }
    return out.join("\n\n");
  }
  const IMPACT = ["strong positive", "positive", "neutral", "negative", "strong negative"];
  function deskPrompt(desk, text, syms, today) {
    const S = syms.join(" | "), per = (o) => `{${syms.map((x) => `"${x}": ${o}`).join(", ")}}`;
    const common = `Rules: be specific and analytical; every claim names its numbers, dates and the source rows it rests on (the bracketed IDs in the dossier, e.g. [E3], [Q2], [MI4], [WS2], [N4], are welcome). Use only what is in the dossier; never invent a fact, date or figure. Compare the tickers with each other, not in isolation. Every "pick" is exactly one of: ${S}.`;
    if (desk === "events") return `You are the event strategist on a comparison desk, today ${today}. Below is each ticker's dated 12-month calendar (its industry's events, its own reports and ex-dividend dates, its peers' reports, the macro releases), the releases its industries are watching, its industry's 1M-12M cards (decisions, conflicts and what to do in each window), its windows, its earnings history and price reactions, its measured factor sensitivities and what it did in past setups like today. Your job: walk the next 12 months event by event and say, for each, what could happen, how likely each outcome is, and what each outcome does to ${syms.join(", ")}, with sizes. Then say what that means month by month and for each ticker's path.
${common}

${text}

Return ONLY a JSON object:
{"events": [{"date": "YYYY-MM-DD", "event": "what happens", "kind": "macro | fed | earnings | policy | trade | world | industry | dividend", "importance": "high | medium",
   "watch": "the number or threshold that decides it (consensus, prior, the line in the sand)",
   "impact": ${per(`"${IMPACT.join(" | ")}"`)},
   "outcomes": [{"if": "one outcome, e.g. a hot print at or above 0.4%", "odds": 30, "moves": ${per(`"-2% to -4%"`)}}] (2-3 outcomes whose odds sum to 100),
   "why": "2-3 sentences: the mechanism for each ticker and its rough size, with the numbers",
   "play": "one sentence: what to do before or after it (add, trim, wait, hedge) and in which ticker"}] (14-20 events over the next 12 months, soonest first; every event that could move any of them by 2% or more, plus each one's earnings),
 "months": [{"month": "YYYY-MM", "theme": "what this month is about", "risk": "high | medium | low", "read": "1-2 sentences: who it favors and why"}] (the next 12 months),
 "paths": ${per(`{"path": "3-4 sentences: its catalyst path over the year, the biggest single event and what has to go right", "biggest": "its biggest single event and date", "skew": "upside | balanced | downside"}`)},
 "horizons": {"1M": {"pick": "...", "why": "the events in this window that decide it"}, "3M": {...}, "6M": {...}, "12M": {...}},
 "pick": "the best positioned for what's coming", "why": "2-3 sentences"}`;
    if (desk === "macro") return `You are the macro and foreign-affairs strategist on a comparison desk, today ${today}. Below, for each ticker's industries: the full macro indicator table (latest, prior, 1M/3M/1Y changes, what drives each and what's next, and each industry's read: relevance, headwind or tailwind, and why), each industry's macro call and how macro reaches it, the world situations and threats (deep dives with scenarios and what to watch), the trade map country by country (revenue there, stance, threats, risks, dependencies), and regulation and policy. Your job: read the macro backdrop and the world, and say what each piece does to ${syms.join(", ")}, with numbers.
${common}

${text}

Return ONLY a JSON object:
{"regime": "4-5 sentences: the macro backdrop today, which way it is moving, and what that means for these tickers, with the indicators' numbers",
 "indicators": [{"label": "the indicator as named in the table", "now": "its latest value and trend", "read": "1-2 sentences: what it says and where it is heading", "impact": ${per(`"${IMPACT.join(" | ")}"`)}}] (the 10-16 indicators that matter most for this comparison),
 "world": [{"situation": "as named in the dossier", "status": "where it stands now", "outlook": "2 sentences: what happens next over 3-12 months, with odds where the dossier gives them", "impact": ${per(`{"direction": "${IMPACT.join(" | ")}", "why": "one sentence with the channel (revenue, costs, supply, demand, rates)"}`)}}] (6-10 situations, the most material first),
 "trade": [{"country": "...", "read": "1-2 sentences: the relationship, tariffs, threats and where it is heading", "impact": ${per(`{"direction": "${IMPACT.join(" | ")}", "why": "one sentence: its exposure there"}`)}}] (4-8 countries),
 "regulation": [{"item": "a rule, policy, case or deal", "status": "...", "impact": ${per(`{"direction": "${IMPACT.join(" | ")}", "why": "one sentence"}`)}}] (3-6 items),
 "scenarios": [{"name": "a macro or world scenario", "probability": 30, "what": "1-2 sentences: what happens, with triggers", "impact": ${per(`{"move": "-8% to -12%", "why": "one sentence"}`)}}] (4 scenarios whose probabilities sum to 100: a base case, a bull, a bear, and the biggest tail risk),
 "sensitivities": ${per(`"which macro factors move it most and which way (rates, oil, the dollar, credit, growth, consumer), with numbers"`)},
 "names": ${per(`{"read": "3-4 sentences: its macro and foreign-affairs case", "tailwinds": ["2-4 specific tailwinds"], "headwinds": ["2-4 specific headwinds"]}`)},
 "pick": "best positioned for the macro and the world", "why": "2-3 sentences"}`;
    if (desk === "street") return `You are the Wall Street and sentiment analyst on a comparison desk, today ${today}. Below is each ticker's analyst consensus, price targets and their trend, rating changes, estimate revisions, earnings history and reactions, news sentiment and headlines, ownership, short interest, insiders and technicals. Your job: what the street and the crowd think of ${syms.join(", ")}, which way that is moving, where it is already priced in, and where they are likely wrong.
${common}

${text}

Return ONLY a JSON object:
{"names": ${per(`{"street": "2-3 sentences: ratings mix, target and upside, how the target and estimates have moved, recent upgrades and downgrades", "sentiment": "2-3 sentences: news sentiment level and trend, and what the headlines are about (cite N-IDs)", "positioning": "1-2 sentences: short interest, insiders, institutions, and the technical picture", "crowding": "low | medium | high", "signal": "positive | neutral | negative", "surprise_risk": "one sentence: the next report and how the stock has reacted to reports"}`)},
 "pick": "the one the street and sentiment favor most, adjusted for crowding", "why": "2-3 sentences",
 "contrarian": "2 sentences: where the street or the crowd is most likely wrong across these tickers"}`;
    return `You are the fundamentals analyst on a comparison desk, today ${today}. Below is each ticker's business, segments, quarters, margins, quality, valuation against its own history and its industry, cash flow, balance sheet, dividends, what the price assumes, and any written analysis. Your job: which is the better business at the better price, and what each is worth.
${common}

${text}

Return ONLY a JSON object:
{"names": ${per(`{"quality": "2 sentences: moat, margins, returns on capital, earnings quality", "growth": "2 sentences: revenue and EPS growth, drivers, estimates", "valuation": "cheap | fair | rich: 2 sentences with multiples vs history and peers, and what the price assumes", "balance_sheet": "1-2 sentences", "income": "1-2 sentences: yield, growth, coverage", "expected_12m": {"bull": "+x%", "base": "+y%", "bear": "-z%"}, "read": "3 sentences: the fundamental case"}`)},
 "pick": "the better business at the better price", "why": "2-3 sentences"}`;
  }
  const IMPV = (x) => (IMPACT.includes(x) ? x : "neutral");
  const dirOf = (syms, o, k = 300) => Object.fromEntries(syms.map((x) => [x, { direction: IMPV(o?.[x]?.direction), why: str(o?.[x]?.why, k) }]));
  /** A desk's answer, checked: picks are tickers, every ticker has an entry, text trimmed. */
  function cleanDesk(desk, raw, syms) {
    if (!raw || typeof raw !== "object") return null;
    const up = (x) => String(x || "").toUpperCase().trim(), pick = (x) => (syms.includes(up(x)) ? up(x) : null), N = raw.names || {};
    const o = { pick: pick(raw.pick), why: str(raw.why, 700), names: {} };
    const hz = () => { const h0 = {}; for (const h of HZ) { const x = raw.horizons?.[h]; if (x && pick(x.pick)) h0[h] = { pick: pick(x.pick), why: str(x.why, 400) }; } return h0; };
    const events = () => (Array.isArray(raw.events) ? raw.events : []).filter((e) => e && /^\d{4}-\d{2}(-\d{2})?$/.test(String(e.date || ""))).map((e) => ({ date: String(e.date), event: str(e.event, 200), kind: str(e.kind, 20),
      importance: e.importance === "high" ? "high" : "medium", watch: str(e.watch, 240), why: str(e.why, 700), play: str(e.play, 300),
      impact: Object.fromEntries(syms.map((x) => [x, IMPV(e.impact?.[x])])),
      outcomes: (Array.isArray(e.outcomes) ? e.outcomes : []).map((y) => ({ if: str(y?.if, 200), odds: isNum(n(y?.odds)) ? Math.round(n(y.odds)) : null, moves: Object.fromEntries(syms.map((x) => [x, str(y?.moves?.[x], 24)])) })).filter((y) => y.if).slice(0, 3) }))
      .sort((a, b) => (a.date < b.date ? -1 : 1)).slice(0, 22);
    const scen = () => (Array.isArray(raw.scenarios) ? raw.scenarios : []).map((x) => ({ name: str(x?.name, 120), probability: isNum(n(x?.probability)) ? Math.round(n(x.probability)) : null, what: str(x?.what, 400),
      impact: Object.fromEntries(syms.map((k) => [k, { move: str(x?.impact?.[k]?.move, 40), why: str(x?.impact?.[k]?.why, 300) }])) })).filter((x) => x.name).slice(0, 5);
    if (desk === "events") {
      o.events = events();
      o.months = (Array.isArray(raw.months) ? raw.months : []).filter((m) => /^\d{4}-\d{2}/.test(String(m?.month || ""))).map((m) => ({ month: String(m.month).slice(0, 7), theme: str(m.theme, 160), risk: ["high", "medium", "low"].includes(m.risk) ? m.risk : "medium", read: str(m.read, 400) })).slice(0, 13);
      o.paths = Object.fromEntries(syms.map((k) => { const x = raw.paths?.[k] || {}; return [k, { path: str(x.path, 700), biggest: str(x.biggest, 200), skew: ["upside", "balanced", "downside"].includes(x.skew) ? x.skew : null }]; }));
      o.horizons = hz();
    } else if (desk === "macro") {
      o.regime = str(raw.regime, 1100);
      o.indicators = (Array.isArray(raw.indicators) ? raw.indicators : []).map((x) => ({ label: str(x?.label, 100), now: str(x?.now, 160), read: str(x?.read, 400), impact: Object.fromEntries(syms.map((k) => [k, IMPV(x?.impact?.[k])])) })).filter((x) => x.label).slice(0, 18);
      o.world = (Array.isArray(raw.world) ? raw.world : []).map((x) => ({ situation: str(x?.situation, 160), status: str(x?.status, 240), outlook: str(x?.outlook, 500), impact: dirOf(syms, x?.impact) })).filter((x) => x.situation).slice(0, 12);
      o.trade = (Array.isArray(raw.trade) ? raw.trade : []).map((x) => ({ country: str(x?.country, 60), read: str(x?.read, 400), impact: dirOf(syms, x?.impact) })).filter((x) => x.country).slice(0, 10);
      o.regulation = (Array.isArray(raw.regulation) ? raw.regulation : []).map((x) => ({ item: str(x?.item, 160), status: str(x?.status, 160), impact: dirOf(syms, x?.impact) })).filter((x) => x.item).slice(0, 8);
      o.scenarios = scen();
      o.sensitivities = Object.fromEntries(syms.map((k) => [k, str(raw.sensitivities?.[k], 400)]));
      // A verdict made before the events desk existed kept its dated events here.
      if (Array.isArray(raw.events)) { o.events = events(); o.horizons = hz(); }
      for (const k of syms) { const x = N[k] || {}; o.names[k] = { read: str(x.read, 700), tailwinds: arr(x.tailwinds, 4, 200), headwinds: arr(x.headwinds, 4, 200) }; }
    } else if (desk === "street") {
      o.contrarian = str(raw.contrarian, 500);
      for (const k of syms) { const x = N[k] || {}; o.names[k] = { street: str(x.street, 500), sentiment: str(x.sentiment, 500), positioning: str(x.positioning, 400), crowding: ["low", "medium", "high"].includes(x.crowding) ? x.crowding : null,
        signal: ["positive", "neutral", "negative"].includes(x.signal) ? x.signal : null, surprise_risk: str(x.surprise_risk, 300) }; }
    } else {
      for (const k of syms) { const x = N[k] || {}, e = x.expected_12m || {}; o.names[k] = { quality: str(x.quality, 400), growth: str(x.growth, 400), valuation: str(x.valuation, 400), balance_sheet: str(x.balance_sheet, 300), income: str(x.income, 300),
        expected_12m: { bull: str(e.bull, 12), base: str(e.base, 12), bear: str(e.bear, 12) }, read: str(x.read, 600) }; }
    }
    return o;
  }
  /** The desks' findings as text for the head of research. */
  function desksText(desks, syms) {
    const L = [], ev = desks.events, m = desks.macro, st = desks.street, f = desks.fundamentals;
    const imp = (o) => syms.map((k) => `${k} ${o?.[k] || "n/a"}`).join(", "), dir = (o) => syms.map((k) => `${k} ${o?.[k]?.direction || "n/a"}`).join(", ");
    if (ev) { L.push("=== EVENTS DESK ===", `Pick: ${ev.pick || "n/a"} — ${ev.why}`);
      L.push("What's ahead: " + (ev.events || []).map((e) => `${e.date} ${e.event} (${e.importance}; watch: ${e.watch}) [${imp(e.impact)}]: ${e.why} Outcomes: ${e.outcomes.map((y) => `${y.if} ${y.odds ?? "?"}% → ${imp(y.moves)}`).join("; ")}. Play: ${e.play}`).join(" | "));
      L.push("Month by month: " + (ev.months || []).map((x) => `${x.month} (${x.risk}) ${x.theme}: ${x.read}`).join(" | "));
      for (const k of syms) { const x = ev.paths?.[k] || {}; L.push(`${k} path (${x.skew || "n/a"}): ${x.path || ""} Biggest: ${x.biggest || ""}`); }
      L.push("Windows: " + HZ.filter((h) => ev.horizons?.[h]).map((h) => `${h} ${ev.horizons[h].pick}: ${ev.horizons[h].why}`).join(" | ")); }
    if (m) { L.push("", "=== MACRO & FOREIGN AFFAIRS DESK ===", `Backdrop: ${m.regime}`, `Pick: ${m.pick || "n/a"} — ${m.why}`);
      if (m.indicators?.length) L.push("Indicators: " + m.indicators.map((x) => `${x.label} (${x.now}): ${x.read} [${imp(x.impact)}]`).join(" | "));
      if (m.world?.length) L.push("World: " + m.world.map((x) => `${x.situation} (${x.status}): ${x.outlook} [${dir(x.impact)}]`).join(" | "));
      if (m.trade?.length) L.push("Trade: " + m.trade.map((x) => `${x.country}: ${x.read} [${dir(x.impact)}]`).join(" | "));
      if (m.regulation?.length) L.push("Regulation: " + m.regulation.map((x) => `${x.item} (${x.status}) [${dir(x.impact)}]`).join(" | "));
      if (!ev && m.events?.length) L.push("What's ahead: " + m.events.map((e) => `${e.date} ${e.event} [${imp(e.impact)}]: ${e.why}`).join(" | "));
      L.push("Scenarios: " + (m.scenarios || []).map((x) => `${x.name} (${x.probability ?? "?"}%): ${x.what} → ${syms.map((k) => `${k} ${x.impact[k]?.move || "n/a"}`).join(", ")}`).join(" | "));
      for (const k of syms) { const x = m.names?.[k] || { tailwinds: [], headwinds: [] }; L.push(`${k}: ${x.read || ""} Tailwinds: ${x.tailwinds.join("; ")}. Headwinds: ${x.headwinds.join("; ")}. Sensitivities: ${m.sensitivities?.[k] || ""}`); } }
    if (st) { L.push("", "=== STREET & SENTIMENT DESK ===", `Pick: ${st.pick || "n/a"} — ${st.why}`, `Contrarian: ${st.contrarian}`);
      for (const k of syms) { const x = st.names[k] || {}; L.push(`${k} (signal ${x.signal || "n/a"}, crowding ${x.crowding || "n/a"}): ${x.street} ${x.sentiment} ${x.positioning} ${x.surprise_risk}`); } }
    if (f) { L.push("", "=== FUNDAMENTALS DESK ===", `Pick: ${f.pick || "n/a"} — ${f.why}`);
      for (const k of syms) { const x = f.names[k] || { expected_12m: {} }; L.push(`${k}: ${x.read} Quality: ${x.quality} Growth: ${x.growth} Valuation: ${x.valuation} Balance sheet: ${x.balance_sheet} Income: ${x.income} 12M: bull ${x.expected_12m.bull}, base ${x.expected_12m.base}, bear ${x.expected_12m.bear}.`); } }
    return L.join("\n");
  }
  const LV = ["buy", "accumulate", "hold", "trim", "avoid"], CONF = ["high", "medium", "low"];
  const str = (x, k = 900) => (typeof x === "string" ? cut(x, k) : "");
  const arr = (x, k = 6, m = 220) => (Array.isArray(x) ? x.map((y) => str(y, m)).filter(Boolean).slice(0, k) : []);
  /** The call's answer, checked: picks must be one of the tickers; everything trimmed; missing names filled. */
  function clean(raw, syms) {
    if (!raw || typeof raw !== "object") return null;
    const up = (x) => String(x || "").toUpperCase().trim(), pick = (x) => (syms.includes(up(x)) ? up(x) : null);
    const o = { headline: str(raw.headline, 300), overall: { pick: pick(raw.overall?.pick), confidence: CONF.includes(raw.overall?.confidence) ? raw.overall.confidence : "medium", why: str(raw.overall?.why, 1400) } };
    o.ranking = [...new Set((Array.isArray(raw.ranking) ? raw.ranking : []).map(pick).filter(Boolean))]; for (const s of syms) if (!o.ranking.includes(s)) o.ranking.push(s);
    if (!o.overall.pick) o.overall.pick = o.ranking[0];
    o.investors = {}; for (const t of TYPES) { const x = raw.investors?.[t]; if (x && pick(x.pick)) o.investors[t] = { pick: pick(x.pick), runner_up: pick(x.runner_up), why: str(x.why, 900), avoid: str(x.avoid, 400) }; }
    reconcile(o, syms);
    o.horizons = {}; for (const h of HZ) { const x = raw.horizons?.[h]; if (x && pick(x.pick)) o.horizons[h] = { pick: pick(x.pick), why: str(x.why, 500) }; }
    o.dimensions = (Array.isArray(raw.dimensions) ? raw.dimensions : []).filter((d) => (GROUPS[d?.key] || d?.key === "events" || d?.key === "macro") && pick(d.pick)).map((d) => ({ key: d.key, pick: pick(d.pick), why: str(d.why, 600) }));
    o.names = {};
    for (const s of syms) { const x = raw.names?.[s] || raw.names?.[s.toLowerCase()] || {};
      o.names[s] = { verdict: LV.includes(x.verdict) ? x.verdict : null, entry: str(x.entry, 300), role: str(x.role, 300), edge: str(x.edge, 300), strengths: arr(x.strengths), weaknesses: arr(x.weaknesses), bull: str(x.bull, 500), bear: str(x.bear, 500), watch: arr(x.watch, 4, 200), changes_mind: str(x.changes_mind, 400) }; }
    const mix = {}; let tot = 0; for (const s of syms) { const v = Math.max(0, Math.round(n(raw.together?.mix?.[s]) || 0)); mix[s] = v; tot += v; }
    if (tot > 0) for (const s of syms) mix[s] = Math.round((mix[s] * 100) / tot);
    o.together = { pairing: str(raw.together?.pairing, 700), mix: tot > 0 ? mix : null };
    o.risks = arr(raw.risks, 5, 300); o.bottom_line = str(raw.bottom_line, 900);
    return o.headline || o.overall.why ? o : null;
  }

  /**
   * The overall pick has to win something: a name picked for no investor type can't be the best overall. If the answer
   * does that anyway, code moves "overall" to the name that wins the most types (ties: the answer's own ranking) and says
   * so. Also used on verdicts saved before this check existed. Mutates and returns v.
   */
  function reconcile(o, syms) {
    if (!o?.overall) return o;
    const wins = Object.fromEntries(syms.map((k) => [k, TYPES.filter((t) => o.investors?.[t]?.pick === k)]));
    o.ranking = (o.ranking || []).filter((k) => syms.includes(k)); for (const k of syms) if (!o.ranking.includes(k)) o.ranking.push(k);
    if (Object.keys(o.investors || {}).length && !o.overall.adjusted && !(wins[o.overall.pick] || []).length) {
      const was = o.overall.pick, best = [...syms].sort((a, b) => wins[b].length - wins[a].length || o.ranking.indexOf(a) - o.ranking.indexOf(b))[0];
      o.overall = { ...o.overall, pick: best, adjusted: `The verdict named ${was} best overall without picking it for any investor type, so the overall pick is ${best}, which wins ${wins[best].length} of 4 (${wins[best].map((t) => TYPE_LABEL[t]).join(", ")}). The reasoning below is the verdict's case for ${was}.` };
    }
    if (o.ranking[0] !== o.overall.pick) o.ranking = [o.overall.pick, ...o.ranking.filter((k) => k !== o.overall.pick)];
    o.wins = wins; return o;
  }
  /** Where the verdict and code disagree by a wide margin: shown next to the verdict, not hidden. */
  function checks(v, h2h, fit) {
    const out = [];
    if (!v) return out;
    if (v.overall?.adjusted) out.push({ where: "overall", text: v.overall.adjusted });
    for (const d of v.dimensions) { const g = h2h.groups[d.key]; if (!g?.leader || g.leader === d.pick || g.margin < 15) continue;
      const a = g.vals.find((x) => x.sym === g.leader)?.score, b = g.vals.find((x) => x.sym === d.pick)?.score;
      out.push({ where: d.key, text: `${GROUPS[d.key].label}: the verdict picks ${d.pick}, but code's numbers favor ${g.leader} (${Math.round(a)} vs ${Math.round(b)})` }); }
    for (const t of TYPES) { const x = v.investors[t], r = fit[t]; if (!x || !r.ranked.length || r.ranked[0] === x.pick) continue;
      const a = r[r.ranked[0]].total, b = r[x.pick]?.total; if (isNum(a) && isNum(b) && a - b >= 10) out.push({ where: t, text: `${TYPE_LABEL[t]}: the verdict picks ${x.pick}, code's fit scores favor ${r.ranked[0]} (${Math.round(a)} vs ${Math.round(b)})` }); }
    return out;
  }

  /** What the verdict rests on: if any of this changes, the comparison is made again (once a day at most otherwise). */
  function fingerprint(subjects, day) {
    return [day, ...subjects.map((s) => `${s.sym}:${s.saved?.at || "-"}:${s.ind?.saved_at || "-"}:${s.outlook?.date || "-"}`)].join("|");
  }

  const api = { mergeAffairs, bondRead, bondRegime, reconcile, DESKS, DESK_KEYS, IMPACT, deskDossier, deskPrompt, cleanDesk, desksText, writtenText, GROUPS, GROUP_KEYS, METRICS: M, MBY, INFO, TYPES, TYPE_LABEL, WEIGHTS, HZ, SIGN, score1, outlookScore, scoreAll, fits, headToHead, correlation, rebase, drawdown, years, overlap, dossier, prompt, clean, checks, fingerprint, fmtV, grade };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Compare = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
