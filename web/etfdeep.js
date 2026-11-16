/**
 * EtfDeep: the full case for every ETF a recommendation holds (code computes every number; a strategist writes the case).
 *
 * For each fund, from its own dividend-adjusted daily prices against SPY:
 *   - returns over 1M, 3M, 6M, YTD, 1Y, 3Y, 5Y and the longest window available (annualized past a year), each
 *     next to the S&P 500's; every calendar year; what $10,000 became over five years;
 *   - risk over three years: volatility, downside volatility, Sharpe and Sortino (4% cash), beta and correlation to
 *     the S&P 500, up and down capture and the share of months it beat the S&P 500 (monthly), best and worst month;
 *   - the worst drawdown over five years (peak, trough, recovery) and how far it sits below its high today;
 *   - every rolling 12-month window over the history: worst, median and best, how often it was up and how often it
 *     beat the S&P 500.
 * Plus what it is (cost, size, age, holdings), what it owns (largest holdings, industries and what the industry runs
 * say about each), the expected return the recommender uses, and its role in the mix (weight, target companies it
 * is the main source of, overlap with the others).
 * Pure functions; the page fetches and asks.
 */
(function (root) {
  "use strict";
  const n = (x) => (x === null || x === undefined || x === "" ? NaN : Number(x));
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const mean = (a) => { const b = a.filter(isNum); return b.length ? b.reduce((s, x) => s + x, 0) / b.length : NaN; };
  const sd = (a) => { const b = a.filter(isNum); if (b.length < 2) return NaN; const m = mean(b); return Math.sqrt(b.reduce((s, x) => s + (x - m) ** 2, 0) / (b.length - 1)); };
  const quant = (a, q) => { const s = a.filter(isNum).sort((x, y) => x - y); if (!s.length) return NaN; const p = (s.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p); return s[lo] + (s[hi] - s[lo]) * (p - lo); };
  const RF = 0.04, TD = 252;
  const addMonths = (d, k) => { const t = new Date(d + "T00:00:00Z"); t.setUTCMonth(t.getUTCMonth() + k); return t.toISOString().slice(0, 10); };
  /** Index of the last date <= d, or -1. */
  function at(dates, d) { let lo = 0, hi = dates.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (dates[m] <= d) { a = m; lo = m + 1; } else hi = m - 1; } return a; }

  /** Total return between two dates (the closes on or before each); NaN when the fund wasn't trading at the start. */
  function between(s, a, b) { const i = at(s.dates, a), j = at(s.dates, b); if (i < 0 || j < 0 || j <= i) return NaN; if ((Date.parse(a) - Date.parse(s.dates[i])) / 864e5 > 7 && i === 0) return NaN; return s.closes[j] / s.closes[i] - 1; }
  const annual = (r, years) => (isNum(r) && r > -1 ? (1 + r) ** (1 / years) - 1 : NaN);
  /** Month-end closes {month, close} from daily. */
  function monthly(s) { const out = []; for (let i = 0; i < s.dates.length; i++) if (i === s.dates.length - 1 || s.dates[i + 1].slice(0, 7) !== s.dates[i].slice(0, 7)) out.push({ month: s.dates[i].slice(0, 7), close: s.closes[i] }); return out; }

  /**
   * Every number for one fund. ser, spy: {dates, closes} (dividend-adjusted). Returns null without a year of prices.
   */
  function stats(ser, spy, { rf = RF } = {}) {
    if (!ser?.dates?.length || ser.dates.length < 250 || !spy?.dates?.length) return null;
    const end = ser.dates[ser.dates.length - 1], first = ser.dates[0], yrsAvail = (Date.parse(end) - Date.parse(first)) / (365.25 * 864e5);
    const P = [["1M", 1], ["3M", 3], ["6M", 6], ["1Y", 12], ["3Y", 36], ["5Y", 60]];
    const periods = P.map(([k, m]) => { const a = addMonths(end, -m), r = between(ser, a, end), s = between(spy, a, end), ann = m > 12;
      return { k, ret: ann ? annual(r, m / 12) : r, spy: ann ? annual(s, m / 12) : s, annualized: ann }; });
    const ytdA = `${Number(end.slice(0, 4)) - 1}-12-31`, ytd = { k: "YTD", ret: between(ser, ytdA, end), spy: between(spy, ytdA, end), annualized: false };
    periods.splice(3, 0, ytd);
    const maxR = ser.closes[ser.closes.length - 1] / ser.closes[0] - 1, maxS = between(spy, first, end);
    periods.push({ k: "Since " + first.slice(0, 4), ret: annual(maxR, yrsAvail), spy: annual(maxS, yrsAvail), annualized: true, years: Math.round(yrsAvail * 10) / 10 });
    for (const p of periods) p.excess = isNum(p.ret) && isNum(p.spy) ? p.ret - p.spy : NaN;
    // Calendar years (the last five full ones, then this year so far).
    const y1 = Number(end.slice(0, 4));
    const years = []; for (let y = y1 - 5; y <= y1; y++) { const a = `${y - 1}-12-31`, b = y === y1 ? end : `${y}-12-31`, r = between(ser, a, b), s = between(spy, a, b); if (isNum(r)) years.push({ year: y, ret: r, spy: s, excess: isNum(s) ? r - s : NaN, partial: y === y1 }); }
    // Daily risk over three years, on dates both traded.
    const sm = new Map(spy.dates.map((d, i) => [d, spy.closes[i]])), from3 = addMonths(end, -36), dr = [], ds = [];
    for (let i = Math.max(1, at(ser.dates, from3)); i < ser.dates.length; i++) { const a = sm.get(ser.dates[i - 1]), b = sm.get(ser.dates[i]); if (!(a > 0 && b > 0)) continue; dr.push(ser.closes[i] / ser.closes[i - 1] - 1); ds.push(b / a - 1); }
    const rfd = (1 + rf) ** (1 / TD) - 1, ex = dr.map((x) => x - rfd), vol = sd(dr) * Math.sqrt(TD), down = Math.sqrt(mean(dr.map((x) => Math.min(0, x - rfd) ** 2))) * Math.sqrt(TD);
    const ann3 = periods.find((p) => p.k === "3Y")?.ret;
    let cov = 0, vs = 0, vx = 0; const mx = mean(dr), my = mean(ds); for (let i = 0; i < dr.length; i++) { cov += (dr[i] - mx) * (ds[i] - my); vs += (ds[i] - my) ** 2; vx += (dr[i] - mx) ** 2; }
    const beta = vs > 0 ? cov / vs : NaN, corr = vs > 0 && vx > 0 ? cov / Math.sqrt(vs * vx) : NaN;
    // Monthly: capture, months beaten, best and worst.
    const me = monthly(ser), ms = new Map(monthly(spy).map((x) => [x.month, x.close])), mr = [];
    for (let i = 1; i < me.length; i++) { const a = ms.get(me[i - 1].month), b = ms.get(me[i].month); if (a > 0 && b > 0) mr.push({ month: me[i].month, r: me[i].close / me[i - 1].close - 1, s: b / a - 1 }); }
    const m36 = mr.slice(-36), up = m36.filter((x) => x.s > 0), dn = m36.filter((x) => x.s < 0);
    const geo = (xs) => (xs.length ? xs.reduce((p, x) => p * (1 + x), 1) ** (1 / xs.length) - 1 : NaN);
    const upCap = up.length ? geo(up.map((x) => x.r)) / geo(up.map((x) => x.s)) : NaN, dnCap = dn.length ? geo(dn.map((x) => x.r)) / geo(dn.map((x) => x.s)) : NaN;
    const best = m36.reduce((a, x) => (!a || x.r > a.r ? x : a), null), worst = m36.reduce((a, x) => (!a || x.r < a.r ? x : a), null);
    // Drawdown over five years.
    const i5 = Math.max(0, at(ser.dates, addMonths(end, -60))); let pk = i5, dd = { depth: 0 }, curPk = i5;
    for (let i = i5; i < ser.closes.length; i++) { if (ser.closes[i] > ser.closes[curPk]) curPk = i; const d = ser.closes[i] / ser.closes[curPk] - 1; if (d < dd.depth) { dd = { depth: d, peak: ser.dates[curPk], trough: ser.dates[i], ti: i, pi: curPk }; pk = curPk; } }
    if (dd.ti) { const lvl = ser.closes[dd.pi]; const k = ser.closes.findIndex((x, i) => i > dd.ti && x >= lvl); dd.recovered = k > 0 ? ser.dates[k] : null; dd.days_down = dd.ti - dd.pi; dd.days_back = k > 0 ? k - dd.ti : null; delete dd.ti; delete dd.pi; }
    const hi = Math.max(...ser.closes.slice(-TD)), fromHigh = ser.closes[ser.closes.length - 1] / hi - 1;
    // Rolling 12 months.
    const roll = [], rollEx = []; for (let i = TD; i < ser.dates.length; i += 5) { const r = ser.closes[i] / ser.closes[i - TD] - 1, s = between(spy, ser.dates[i - TD], ser.dates[i]); roll.push(r); if (isNum(s)) rollEx.push(r - s); }
    // $10,000 over five years (or since it started).
    const g0 = at(ser.dates, addMonths(end, -60)), gFrom = g0 >= 0 ? ser.dates[g0] : first;
    const growth = { from: gFrom, value: 10000 * (1 + between(ser, gFrom, end)), spy: 10000 * (1 + between(spy, gFrom, end)) };
    return { as_of: end, first, periods, years, growth,
      risk: { vol, downside: down, sharpe: isNum(ann3) && vol > 0 ? (ann3 - rf) / vol : (mean(ex) / sd(ex)) * Math.sqrt(TD), sortino: isNum(ann3) && down > 0 ? (ann3 - rf) / down : NaN, beta, corr,
        up_capture: upCap, down_capture: dnCap, months: m36.length, months_beat: m36.length ? m36.filter((x) => x.r > x.s).length / m36.length : NaN, best_month: best, worst_month: worst },
      drawdown: { ...dd, from_high: fromHigh },
      rolling: roll.length ? { n: roll.length, worst: quant(roll, 0), median: quant(roll, 0.5), best: quant(roll, 1), up: roll.filter((x) => x > 0).length / roll.length, beat: rollEx.length ? rollEx.filter((x) => x > 0).length / rollEx.length : NaN, median_excess: quant(rollEx, 0.5) } : null };
  }

  /**
   * Everything about one candidate for the write-up and the card. c: a recommendation candidate (info, q, vec, mu,
   * prior, view, conf, yield, expense, isBond, e, via, twins); st: stats(); rows: the industry rows (by name).
   */
  function profile(c, st, byRow) {
    const i = c.info || {}, v = c.vec || {};
    const top = Object.entries(v.cos || {}).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([symbol, w]) => ({ symbol, weight: w }));
    const inds = Object.entries(v.ind || {}).filter(([k]) => !k.startsWith("(")).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, w]) => { const r = byRow?.get?.(name) || {};
      return { name, weight: w, call: r.call || null, call12: r.call12 || null, exp12: isNum(r.exp12) ? r.exp12 : null, z: isNum(r.z) ? r.z : null, pe_pct: isNum(r.pe_pct) ? r.pe_pct : null, verdict: r.verdict || null, headline: String(r.headline || "").slice(0, 220) }; });
    return { symbol: c.symbol, name: i.name || "", issuer: i.issuer || "", inception: i.inceptionDate || null, aum: n(i.assetsUnderManagement), expense: c.expense, yield: n(c.yield), holdings: n(i.holdingsCount) || v.n || null,
      effN: v.effN || null, isBond: !!c.isBond, bond: c.isBond ? { bucket: c.bucket, duration: c.e?.duration, rates_up_1pp: c.v?.rates_up_1pp, credit_stress: c.v?.credit_stress } : null,
      top, industries: inds, mu: n(c.mu), prior: n(c.prior), view: n(c.view), conf: n(c.conf), via: c.via, twins: c.twins || [], stats: st };
  }

  /** Its role in one mix: weight, the target companies it is the main source of, its largest overlap. */
  function role(sym, sel, cands, T) {
    const k = cands.findIndex((c) => c.symbol === sym); if (k < 0 || !(sel?.w?.[k] > 0)) return null;
    const w = sel.w[k], c = cands[k], unique = [];
    if (!c.isBond) for (const t of Object.keys(T || {})) { const mine = w * (n(c.vec?.cos?.[t]) || 0); if (!mine) continue; const tot = cands.reduce((s, x, i) => s + sel.w[i] * (n(x.vec?.cos?.[t]) || 0), 0); if (tot > 0 && mine / tot >= 0.5) unique.push({ symbol: t, share: mine / tot, weight: mine }); }
    unique.sort((a, b) => b.weight - a.weight);
    let ov = null; if (!c.isBond) cands.forEach((x, i) => { if (i === k || !(sel.w[i] > 0) || x.isBond) return; let s = 0; for (const [t, a] of Object.entries(c.vec?.cos || {})) s += Math.min(a, n(x.vec?.cos?.[t]) || 0); if (!ov || s > ov.overlap) ov = { symbol: x.symbol, overlap: s }; });
    return { weight: w, unique: unique.slice(0, 8), overlap: ov };
  }

  const pc = (x, d = 1) => (isNum(x) ? `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%` : "n/a");
  const pp = (x, d = 1) => (isNum(x) ? `${(x * 100).toFixed(d)}%` : "n/a");
  const f2 = (x, d = 2) => (isNum(x) ? x.toFixed(d) : "n/a");
  /** The fact sheet a strategist writes from: [D#] lines. goal: the goal; rl: role(); mixes: {key: role()}. */
  function text(p, goal, rl, { mixLabel = "this mix", others = [] } = {}) {
    const L = [], s = p.stats, add = (t) => L.push(`[D${L.length + 1}] ${t}`);
    add(`${p.symbol} ${p.name}${p.issuer ? ` (${p.issuer})` : ""}: cost ${pp(p.expense, 2)} a year, $${isNum(p.aum) ? (p.aum / 1e9).toFixed(1) : "n/a"}B in assets, started ${p.inception || "n/a"}, ${p.holdings || "n/a"} holdings${p.effN ? ` (effectively ${Math.round(p.effN)} equal positions)` : ""}, yield ${pp(p.yield, 2)}. Found via ${p.via}.${p.twins.length ? ` Near-identical funds collapsed into it: ${p.twins.slice(0, 4).join(", ")}.` : ""}`);
    if (rl) add(`Role in ${mixLabel} (a ${goal.label.toLowerCase()} portfolio, ${goal.horizon}): ${pp(rl.weight, 1)} of the portfolio.${rl.unique.length ? ` Main source of the target companies ${rl.unique.map((u) => `${u.symbol} (${pp(u.share, 0)} of the mix's ${u.symbol})`).join(", ")}.` : ""}${rl.overlap ? ` Largest overlap: ${rl.overlap.symbol}, ${pp(rl.overlap.overlap, 0)} the same stocks.` : ""}${others.length ? ` The other ETFs in the mix: ${others.join(", ")}.` : ""}`);
    if (s) {
      add(`Returns with dividends reinvested, to ${s.as_of} (S&P 500 in brackets; 3Y, 5Y and the longest window are a year): ${s.periods.map((x) => `${x.k} ${pc(x.ret)} [${pc(x.spy)}]`).join(", ")}.`);
      add(`By calendar year (S&P 500 in brackets): ${s.years.map((y) => `${y.year}${y.partial ? " so far" : ""} ${pc(y.ret)} [${pc(y.spy)}]`).join(", ")}. $10,000 from ${s.growth.from} is $${Math.round(s.growth.value).toLocaleString("en-US")} (S&P 500 $${Math.round(s.growth.spy).toLocaleString("en-US")}).`);
      const r = s.risk; add(`Risk over 3 years: volatility ${pp(r.vol)}, downside volatility ${pp(r.downside)}, Sharpe ${f2(r.sharpe)}, Sortino ${f2(r.sortino)}, beta ${f2(r.beta)}, correlation to the S&P 500 ${f2(r.corr)}. Monthly: up capture ${pp(r.up_capture, 0)}, down capture ${pp(r.down_capture, 0)}, beat the S&P 500 in ${pp(r.months_beat, 0)} of ${r.months} months; best month ${r.best_month ? `${r.best_month.month} ${pc(r.best_month.r)}` : "n/a"}, worst ${r.worst_month ? `${r.worst_month.month} ${pc(r.worst_month.r)}` : "n/a"}.`);
      const d = s.drawdown; add(`Worst drawdown in 5 years: ${pc(d.depth)} from ${d.peak || "n/a"} to ${d.trough || "n/a"} (${d.days_down ?? "n/a"} trading days down; ${d.recovered ? `back to the high on ${d.recovered}, ${d.days_back} trading days later` : "not yet back to that high"}). Today ${pc(d.from_high)} from its 12-month high.`);
      if (s.rolling) add(`Every rolling 12-month window since ${s.first} (${s.rolling.n} windows): worst ${pc(s.rolling.worst)}, median ${pc(s.rolling.median)}, best ${pc(s.rolling.best)}; up in ${pp(s.rolling.up, 0)} of them and ahead of the S&P 500 in ${pp(s.rolling.beat, 0)} (median lead ${pc(s.rolling.median_excess)}).`);
    }
    if (p.isBond) add(`Bonds: ${p.bond.bucket || "n/a"}, duration about ${p.bond.duration ?? "n/a"} years; a 1-point rise in rates ${pc(p.bond.rates_up_1pp)}${isNum(p.bond.credit_stress) ? `, a credit stress ${pc(p.bond.credit_stress)}` : ""}.`);
    if (p.top.length) add(`Largest holdings: ${p.top.map((t) => `${t.symbol} ${pp(t.weight, 1)}`).join(", ")}.`);
    for (const g of p.industries) add(`Industry ${g.name}: ${pp(g.weight, 0)} of the fund. The industry run: ${goal.horizon} call ${g.call || "n/a"}${goal.horizon !== "12M" ? `, 12M call ${g.call12 || "n/a"}` : ""}, expected 12-month return ${isNum(g.exp12) ? g.exp12.toFixed(1) + "%" : "n/a"}, conviction for this goal ${isNum(g.z) ? (g.z > 0 ? "+" : "") + g.z.toFixed(2) : "n/a"}, P/E ${isNum(g.pe_pct) ? Math.round(g.pe_pct * 100) + "th percentile of its history" : "n/a"}, strategist verdict ${g.verdict || "n/a"}.${g.headline ? ` Headline: ${g.headline}` : ""}`);
    if (isNum(p.quality)) add(`Fund quality ${p.quality}/100 among the candidates (its 3-year record against the S&P 500, Sharpe, drawdown, cost, size and how often it led over 12 months).`);
    for (const r of p.rivals || []) add(`The shortlist for ${r.industry} (score out of 100: share of the fund in the industry, how much of the industry's chosen companies it holds, fund quality): ${r.funds.map((f) => `${f.symbol} ${f.score} (in the industry ${pp(f.purity, 0)}, holds the chosen companies ${pp(Math.min(1, f.capture), 0)}, quality ${f.quality ?? "n/a"})`).join(", ")}.`);
    add(`Expected return the recommender uses: ${pp(p.mu)} a year (market prior ${pp(p.prior)}${isNum(p.view) ? `, the industry runs' view ${pp(p.view)}, weighted ${pp(p.conf, 0)} toward the view` : ""}).`);
    return L.join("\n");
  }

  function prompt(sym, goal, facts, { improving = false } = {}) {
    return `You are the ETF analyst writing the full case for ${sym}, one fund in an ETF-only ${goal.label.toLowerCase()} portfolio${improving ? " that improves the client's current holdings" : ""} (horizon ${goal.horizon}). A quantitative process chose it and its weight from the industry research; your job is to tell the client, with the evidence, why they should own it, what it adds, what can go wrong and when to sell. Do not change the weight and do not invent numbers: every figure comes from the facts.

Write for a sharp investor, plainly and specifically. Every claim cites fact ids in brackets like [D3]; use only ids that appear below. Past returns don't guarantee future ones: lean on the industry runs' forward view as much as on the record, and say plainly where the record is weak.
Never recommend, suggest or compare against buying broad-market or size index funds (S&P 500, total market, Russell 1000/2000, mid-cap or small-cap index funds such as SPY, VOO, IVV, VTI or IWM): the S&P 500 is only the benchmark.

Facts:
${facts}

Return JSON only:
{"verdict": "one sentence: why the client needs this fund",
 "conviction": 1-10,
 "case": "3-4 short paragraphs separated by \\n: what it owns and why that wins for this goal now, with numbers",
 "returns": "3-4 sentences on its record against the S&P 500: which periods it led or lagged and why, how consistent (rolling windows, months beaten), and what a bad stretch looked like",
 "edge": "2 sentences: what it adds that the other ETFs in the mix don't (companies, industries, overlap)",
 "outlook": "2-3 sentences: what the industry runs expect for its industries over the horizon, and the valuation",
 "risks": [{"risk": "short", "why": "1-2 sentences with numbers", "size": "low | medium | high"}],
 "entry": "1-2 sentences: buy all at once or in stages, given where it sits against its high and its volatility",
 "sell_if": ["2-3 specific, checkable triggers"],
 "alternatives": "1-2 sentences: why this fund over the near-identical ones and other ways to own the same thing named in the facts (or say none were close)"}
2-4 risks.`;
  }
  function clean(x, ids) {
    if (!x || typeof x !== "object") return null;
    const ok = new Set(ids), fix = (s) => String(s || "").replace(/\[([A-Z]{1,2}\d{1,3})\]/g, (m, id) => (ok.has(id) ? m : "")).replace(/\s+([.,;])/g, "$1").trim();
    const lvl = (s) => (["low", "medium", "high"].includes(String(s || "").toLowerCase()) ? String(s).toLowerCase() : "medium");
    const cv = Math.round(n(x.conviction));
    return { verdict: fix(x.verdict), conviction: isNum(cv) ? Math.max(1, Math.min(10, cv)) : null, case: fix(x.case), returns: fix(x.returns), edge: fix(x.edge), outlook: fix(x.outlook),
      risks: (Array.isArray(x.risks) ? x.risks.slice(0, 4) : []).map((r) => ({ risk: String(r?.risk || "").slice(0, 120), why: fix(r?.why), size: lvl(r?.size) })).filter((r) => r.risk),
      entry: fix(x.entry), sell_if: (Array.isArray(x.sell_if) ? x.sell_if.slice(0, 4) : []).map(fix).filter(Boolean), alternatives: fix(x.alternatives) };
  }
  const idsOf = (t) => [...new Set([...String(t).matchAll(/^\[([A-Z]{1,2}\d{1,3})\]/gm)].map((m) => m[1]))];

  const EtfDeep = { stats, profile, role, text, prompt, clean, idsOf, between, monthly };
  if (typeof module !== "undefined" && module.exports) module.exports = EtfDeep;
  else root.EtfDeep = EtfDeep;
})(typeof globalThis !== "undefined" ? globalThis : this);
