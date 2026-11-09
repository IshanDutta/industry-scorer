/* Industry Scorer: the full analysis of one ETF or mutual fund, as deep as a company's.
 *
 * Code only (no I/O). Builds on portfolio.js (holdings matched to industries, the look-through): the fund's own
 * holdings joined to their industries' company rows, concentration, the fundamentals and what's priced in seen through
 * the industries, base rates, the dated calendar (holdings' earnings and the industries' events), and the fund's
 * own price-based facts handed in by the page (returns, risk against its benchmark and SPY, crises, measured macro
 * sensitivities). Then the write-up: four analysts at once (core, calls, context, exposures) plus the outlook, each
 * on its own slice of one ID'd dossier, and the code that cleans and checks what they write.
 */
(function (root) {
  "use strict";
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const n = (x) => (x === null || x === undefined || x === "" ? NaN : Number(x));
  const lc = (s) => String(s || "").toLowerCase();
  const P = typeof module !== "undefined" && module.exports ? require("./portfolio.js") : root.Portfolio;
  const HZ = ["1M", "3M", "6M", "12M"];
  const f1 = (v, d = 1) => (isNum(v) ? Number(v).toFixed(d) : "n/a");
  const pc = (v, d = 1) => (isNum(v) ? (v * 100).toFixed(d) + "%" : "n/a");
  const sp = (v, d = 1) => (isNum(v) ? (v > 0 ? "+" : "") + Number(v).toFixed(d) + "%" : "n/a");
  const spf = (v, d = 1) => (isNum(v) ? (v > 0 ? "+" : "") + (v * 100).toFixed(d) + "%" : "n/a");
  const trim = (s, k) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > k ? s.slice(0, k - 1) + "…" : s; };

  /**
   * The fund's holdings joined to their industries' company rows (rank in the industry, P/E, returns, yield, margin,
   * growth, next report), biggest first. mapped: Portfolio.mapHoldings(); digests: {industry (lower case): digest}.
   */
  function holdings(mapped, digests, k = 30) {
    const tot = mapped.reduce((a, h) => a + h.weight, 0) || 1;
    return mapped.filter((h) => h.kind === "stock").sort((a, b) => b.weight - a.weight).slice(0, k).map((h) => {
      const d = h.industry ? digests[lc(h.industry)] : null, sym = P.tick(h.run_symbol || h.ticker);
      const c = d?.cos?.find((x) => P.tick(x.symbol) === sym) || null;
      return { ticker: h.ticker, name: h.name, weight: h.weight / tot, px: h.px, industry: h.industry, sector: h.sector, kind: d?.kind || null, inTop50: !!c, rank: c?.rank ?? null, ind_n: d?.cos?.length || null,
        pe: c?.pe ?? NaN, r1y: c?.r1y ?? NaN, r3m: c?.r3m ?? NaN, div: c?.div ?? NaN, opm: c?.opm ?? NaN, g: c?.g ?? NaN, beta: c?.beta ?? NaN, next: c?.next || null, beats: c?.beats || null,
        call12: d ? d.lean?.["12M"] || d.calls?.["12M"]?.call || "" : "", exp12: d?.expected12 ?? null };
    });
  }
  /** Concentration of the stock holdings: top 10 and top 25 weight, the effective number of holdings, the largest. */
  function concentration(mapped) {
    const w = mapped.filter((h) => h.kind === "stock").map((h) => h.weight).sort((a, b) => b - a), tot = mapped.reduce((a, h) => a + h.weight, 0) || 1;
    const s = w.map((x) => x / tot), hhi = s.reduce((a, x) => a + x * x, 0);
    return { n: s.length, top1: s[0] || 0, top10: s.slice(0, 10).reduce((a, x) => a + x, 0), top25: s.slice(0, 25).reduce((a, x) => a + x, 0), effective_n: hhi > 0 ? 1 / hhi : NaN };
  }
  /**
   * The fundamentals, what's priced in, positioning and base rates, seen through the industries (weighted by the
   * fund's weight in each and renormalized over the industries each applies to). cov: Portfolio.coverage().
   */
  function extras(cov, digests) {
    const inds = cov.industries.map((g) => ({ g, d: digests[lc(g.industry)] })).filter((x) => x.d);
    const ws = (f) => { let w = 0, s = 0; for (const { g, d } of inds) { const v = f(d); if (isNum(v)) { w += g.weight; s += g.weight * v; } } return { v: w > 0 ? s / w : NaN, on: w }; };
    const F = {}; for (const k of ["gross_margin", "op_margin", "net_margin", "roe", "roic", "de", "fcf_margin", "nd_ebitda", "beat_rate", "eps_surprise", "pe_vs_hist", "buyback_yield", "ni_growth"]) F[k] = ws((d) => d.fund?.[k]);
    const priced = { implied: ws((d) => d.priced?.implied_eps_growth), consensus: ws((d) => d.priced?.consensus_growth) };
    const verdicts = {}; for (const { g, d } of inds) if (d.priced?.verdict) verdicts[d.priced.verdict] = (verdicts[d.priced.verdict] || 0) + g.weight;
    const pos = {}; for (const { g, d } of inds) if (d.positioning) pos[d.positioning] = (pos[d.positioning] || 0) + g.weight;
    const base = Object.fromEntries(HZ.map((h) => [h, ws((d) => d.base_up?.[h])]));
    const opp = {}; for (const { g, d } of inds) if (d.opportunity) opp[d.opportunity] = (opp[d.opportunity] || 0) + g.weight;
    return { F, priced, verdicts, pos, base, opp };
  }
  /**
   * The dated calendar: the holdings' next earnings (from their industries' company rows) and the industries' own
   * dated events, each with the fund weight it touches; from today, soonest first.
   */
  function calendar(hold, cov, digests, today, { days = 120 } = {}) {
    const end = new Date(Date.parse(today) + days * 864e5).toISOString().slice(0, 10), out = [];
    for (const h of hold) if (h.next && h.next >= today && h.next <= end && h.weight >= 0.004) out.push({ date: h.next, kind: "earnings", title: `${h.ticker} reports`, w: h.weight, detail: h.beats ? `beat ${h.beats} of the last reports` : "", industries: [h.industry] });
    const ev = new Map();
    for (const g of cov.industries) { const d = digests[lc(g.industry)]; for (const e of d?.events || []) { if (!(e.date >= today && e.date <= end)) continue;
      const k = e.date + "|" + P.titleKey(e.title); const x = ev.get(k) || { date: e.date, kind: e.section || "event", title: e.title, importance: e.importance, detail: e.detail, w: 0, industries: [] }; x.w += g.weight; x.industries.push(g.industry); ev.set(k, x); } }
    out.push(...[...ev.values()].filter((x) => x.w >= 0.01 || x.importance === "high"));
    return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.w - a.w)).slice(0, 40);
  }
  // ============================================================= Wall Street, news, technicals, history and the track record
  /**
   * Wall Street's view of the fund through its biggest holdings, weighted: the share of analysts at buy, and the upside
   * to the consensus target from the price in the holdings file. street: {TICKER: {buy, hold, sell, consensus, target}}.
   */
  function streetLook(hold, street) {
    let w = 0, buy = 0, wt = 0, up = 0, n0 = 0; const rows = [];
    for (const h of hold) { const s = street[P.tick(h.ticker)]; if (!s) continue;
      const tot = (s.buy || 0) + (s.hold || 0) + (s.sell || 0), b = tot > 0 ? s.buy / tot : NaN, u = isNum(n(s.target)) && h.px > 0 ? n(s.target) / h.px - 1 : NaN;
      if (isNum(b)) { w += h.weight; buy += h.weight * b; n0++; } if (isNum(u)) { wt += h.weight; up += h.weight * u; }
      rows.push({ ticker: h.ticker, name: h.name, weight: h.weight, consensus: s.consensus || "", buy: s.buy || 0, hold: s.hold || 0, sell: s.sell || 0, buy_share: b, target: n(s.target), px: h.px, upside: u }); }
    return { n: n0, on: w, buy_share: w > 0 ? buy / w : NaN, upside: wt > 0 ? up / wt : NaN, upside_on: wt, rows };
  }
  /** News sentiment of the biggest holdings, weighted (EODHD's daily scores, -1 to +1). sent: {TICKER: [{date, count, normalized}]}. */
  function sentimentLook(hold, sent, today) {
    const day = (k) => new Date(Date.parse(today) - k * 864e5).toISOString().slice(0, 10);
    const avg = (rows, from) => { const xs = (rows || []).filter((r) => r.date >= from && r.count > 0); const c = xs.reduce((a, r) => a + r.count, 0); return c ? { v: xs.reduce((a, r) => a + r.count * n(r.normalized), 0) / c, count: c } : null; };
    const rows = []; let w30 = 0, s30 = 0, w90 = 0, s90 = 0;
    for (const h of hold) { const r = sent[P.tick(h.ticker)]; if (!r?.length) continue; const a = avg(r, day(30)), b = avg(r, day(90));
      if (a) { w30 += h.weight; s30 += h.weight * a.v; } if (b) { w90 += h.weight; s90 += h.weight * b.v; }
      rows.push({ ticker: h.ticker, weight: h.weight, s30: a?.v ?? NaN, n30: a?.count || 0, s90: b?.v ?? NaN }); }
    return { s30: w30 > 0 ? s30 / w30 : NaN, s90: w90 > 0 ? s90 / w90 : NaN, on: w30, rows: rows.sort((x, y) => y.weight - x.weight) };
  }
  /**
   * The fund's 1M-12M calls, logged each time the analysis is written ({date, h, call, lo, hi, px}), scored once each
   * window has passed: the direction (a neutral call is right when the move stays within ±2%) and whether the move
   * landed in the range. Open calls are marked to market.
   */
  const HD = { "1M": 30, "3M": 91, "6M": 182, "12M": 365 };
  function trackLog(log, calls, date, px) {
    const out = [...(log || [])];
    for (const h of HZ) { const x = calls?.[h]; if (!x?.call || !isNum(px)) continue; if (out.some((e) => e.date === date && e.h === h)) continue;
      out.push({ date, h, call: x.call, lo: x.expected_move?.[0] ?? null, hi: x.expected_move?.[1] ?? null, p_up: x.probability_up ?? null, px }); }
    return out.slice(-200);
  }
  function trackEval(log, ser, today) {
    const d = ser?.dates || [], c = ser?.closes || []; if (!d.length) return { rows: [], done: 0, hit: NaN, in_range: NaN };
    const at = (date) => { let i = -1; for (let k = 0; k < d.length && d[k] <= date; k++) i = k; return i >= 0 ? c[i] : NaN; };
    const rows = (log || []).map((e) => { const end = new Date(Date.parse(e.date) + HD[e.h] * 864e5).toISOString().slice(0, 10), done = end <= today;
      const p1 = done ? at(end) : c[c.length - 1], ret = e.px > 0 && p1 > 0 ? (p1 / e.px - 1) * 100 : NaN, cn = P.callNum(e.call);
      const hit = !isNum(ret) || !isNum(cn) ? null : cn === 0 ? Math.abs(ret) <= 2 : Math.sign(ret) === Math.sign(cn);
      const inR = isNum(ret) && isNum(n(e.lo)) && isNum(n(e.hi)) ? ret >= e.lo && ret <= e.hi : null;
      return { ...e, end, done, ret, hit, in_range: inR }; }).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : HZ.indexOf(a.h) - HZ.indexOf(b.h)));
    const dn = rows.filter((r) => r.done && r.hit !== null), rg = dn.filter((r) => r.in_range !== null);
    return { rows, done: dn.length, hit: dn.length ? dn.filter((r) => r.hit).length / dn.length : NaN, in_range: rg.length ? rg.filter((r) => r.in_range).length / rg.length : NaN };
  }

  // ============================================================= the dossier the four analysts and the outlook write from
  /**
   * fd: the page's fund state ({sym, facts, cov, look, act, bench, digests, flags, mapped, hold, conc, ext, cal, perf
   * (CoFacts.performance), g1/g3/g5 (risk against the benchmark), gS (against SPY), ep (crises), sens (measured)}).
   * Returns {blocks: {name: text}, idx: {ID: label}}: each analyst gets the blocks its fields draw on.
   */
  function dossier(fd, today) {
    const base = P.dossier(fd), idx = { ...base.idx }, B = {};
    const put = (lines, id, label, line) => { idx[id] = label; lines.push(`[${id}] ${line}`); };
    B.base = base.text;
    // H: the holdings
    const h = [`## THE BIGGEST HOLDINGS (rank and figures from their industry's top 50)`];
    (fd.hold || []).slice(0, 25).forEach((x, i) => put(h, "H" + (i + 1), `${x.ticker} ${x.name}`, `${x.ticker} ${trim(x.name, 40)}: ${pc(x.weight, 2)} of the fund; ${x.industry || "no industry"}${x.inTop50 ? `, #${x.rank} of ${x.ind_n} by size` : x.industry ? ", outside its industry's top 50" : ""}${x.kind === "quant" ? " (code-only industry)" : ""}. P/E ${f1(x.pe)}, 1Y ${spf(x.r1y)}, 3M ${spf(x.r3m)}, yield ${pc(x.div, 2)}, op margin ${pc(x.opm)}, revenue growth ${spf(x.g)}, beta ${f1(x.beta, 2)}${x.next ? `, next report ${x.next}` : ""}${x.beats ? `, beat ${x.beats}` : ""}. Its industry's 12-month call: ${x.call12 || "n/a"} (expected ${sp(x.exp12)}).${x.co ? ` Its own analysis: ${x.co}` : ""}`));
    const c = fd.conc; if (c) h.push(`Concentration: ${c.n} stock holdings; top 1 ${pc(c.top1)}, top 10 ${pc(c.top10)}, top 25 ${pc(c.top25)}; effective number of holdings ${f1(c.effective_n, 0)}.`);
    B.hold = h.join("\n");
    // P: price-based facts (the fund's own)
    const p = [`## THE FUND'S OWN PRICE HISTORY (dividend-adjusted)`], pf = fd.perf || {}, bs = fd.bench?.symbol || "the benchmark";
    if (fd.retRows?.length) put(p, "P1", "Returns", `Returns: ${fd.retRows.map((r) => `${r.label} ${sp(r.value)}${r.ann ? " a year" : ""}${isNum(r.bench) ? ` (${bs} ${sp(r.bench)}, SPY ${sp(r.spy)})` : ""}`).join("; ")}.`);
    const g = (x, lab) => (x ? `${lab}: beta to ${bs} ${f1(x.beta, 2)}, correlation ${f1(x.corr, 2)}, alpha ${pc(x.alpha)} a year, volatility ${pc(x.vol)}, downside volatility ${pc(x.downside_vol)}, Sharpe ${f1(x.sharpe, 2)}, tracking error ${pc(x.tracking_error)}, information ratio ${f1(x.info_ratio, 2)}, up capture ${pc(x.up_capture, 0)}, down capture ${pc(x.down_capture, 0)}, max drawdown ${pc(x.max_dd)}, 1-day 95% VaR ${pc(x.var95, 2)}` : "");
    for (const [id, x, lab] of [["P2", fd.g1, "1 year"], ["P3", fd.g3, "3 years"], ["P4", fd.g5, "5 years"]]) if (x) put(p, id, `Risk over ${lab}`, g(x, `Over ${lab}`) + ".");
    if (fd.gS && fd.bench?.symbol !== "SPY") put(p, "P5", "Against SPY", `Against SPY over 1 year: beta ${f1(fd.gS.beta, 2)}, correlation ${f1(fd.gS.corr, 2)}, alpha ${pc(fd.gS.alpha)}, up capture ${pc(fd.gS.up_capture, 0)}, down capture ${pc(fd.gS.down_capture, 0)}.`);
    if (fd.tech) put(p, "P6", "Trend", `Trend: ${fd.tech}.`);
    (fd.ep || []).slice(0, 10).forEach((e, i) => put(p, "S" + (i + 1), e.label, `${e.label} (${e.kind}, ${e.from} to ${e.to}): fund ${spf(e.ret)}${e.estimated ? " (estimated from beta: it didn't trade then)" : ""}, SPY ${spf(e.spy)}, max drawdown ${pc(e.dd)}, capture ${isNum(n(e.capture)) ? (e.capture * 100).toFixed(0) + "%" : "n/a"}.`));
    (fd.sens?.factors || []).forEach((x, i) => put(p, "MF" + (i + 1), `Fund: ${x.label}`, `Measured on the fund's own daily returns (last year): ${x.shock_label} moves the fund ${pc(x.total?.effect, 2)} in total (t ${f1(x.total?.t, 1)}), ${pc(x.partial?.effect, 2)} beyond the other factors${x.stable === false ? "; not stable across the two half-years" : ""}.`));
    B.perf = p.join("\n");
    // V: fundamentals, priced in, income, positioning, base rates (through the industries)
    const v = [`## FUNDAMENTALS, VALUATION AND INCOME THROUGH THE INDUSTRIES`], X = fd.ext, L = fd.look;
    if (X && L?.n) {
      put(v, "V1", "Profitability", `Margins and returns: gross ${pc(X.F.gross_margin.v)}, operating ${pc(X.F.op_margin.v)}, net ${pc(X.F.net_margin.v)}, FCF ${pc(X.F.fcf_margin.v)}, ROE ${pc(X.F.roe.v)}, ROIC ${pc(X.F.roic.v)}; net income growth ${spf(X.F.ni_growth.v)}.`);
      put(v, "V2", "Balance sheet", `Debt/equity ${f1(X.F.de.v, 2)}, net debt/EBITDA ${f1(X.F.nd_ebitda.v, 2)}, buyback yield ${pc(X.F.buyback_yield.v, 2)}.`);
      put(v, "V3", "Valuation", `Forward P/E ${f1(L.val.fwd_pe.v)} (trailing ${f1(L.val.pe.v)}, EV/EBITDA ${f1(L.val.ev_ebitda.v)}, P/S ${f1(L.val.ps.v, 2)}); P/E vs the industries' own 5-year history ${spf(X.F.pe_vs_hist.v)}, at the ${pc(L.val.pe_hist_pct.v, 0)} percentile. Priced in: ${pc(X.priced.implied.v)} a year of EPS growth vs consensus ${pc(X.priced.consensus.v)}; verdicts by weight: ${Object.entries(X.verdicts).map(([k, w]) => `${k} ${pc(w, 0)}`).join(", ") || "n/a"}.`);
      put(v, "V4", "Earnings", `NTM EPS growth ${pc(L.val.eps_growth.v)}, revenue growth ${pc(L.val.rev_growth.v)}, 30-day revisions ${pc(L.val.rev30.v)}; beat rate ${pc(X.F.beat_rate.v, 0)}, median EPS surprise ${pc(X.F.eps_surprise.v)}.`);
      put(v, "V5", "Income", `Dividend yield through the industries ${pc(L.val.div_yield.v, 2)}; the fund's own yield ${pc(fd.facts?.yield, 2)}; expense ratio ${pc(fd.facts?.expense, 2)}.`);
      put(v, "V6", "Positioning and base rates", `Positioning by weight: ${Object.entries(X.pos).map(([k, w]) => `${k} ${pc(w, 0)}`).join(", ") || "n/a"}. Base rates (share of past days like today, by industry history, that were up after): ${HZ.map((h) => `${h} ${pc(X.base[h].v, 0)}`).join(", ")}. Opportunity verdicts by weight: ${Object.entries(X.opp).map(([k, w]) => `${k} ${pc(w, 0)}`).join(", ") || "n/a"}.`);
    }
    B.val = v.join("\n");
    // E: the dated calendar
    const e = [`## THE CALENDAR (next ~4 months)`];
    (fd.cal || []).slice(0, 25).forEach((x, i) => put(e, "E" + (i + 1), `${x.date} ${x.title}`, `${x.date} · ${x.title} (${x.kind}${x.importance ? ", " + x.importance : ""}): ${pc(x.w, 1)} of the fund${x.industries?.length ? ` (${[...new Set(x.industries)].slice(0, 4).join(", ")})` : ""}${x.detail ? `. ${trim(x.detail, 160)}` : ""}.`));
    B.cal = e.join("\n");
    // T: technicals, the pattern match, past setups like today; N: Wall Street and news; D: distributions; K: the track record
    const tl = [`## TECHNICALS, HISTORY, WALL STREET AND NEWS`];
    const T = fd.tech3?.D?.last; if (T) put(tl, "T1", "Technicals", `Daily: close ${f1(T.close, 2)}, SMA 20/50/200 ${f1(T.sma20)}/${f1(T.sma50)}/${f1(T.sma200)}, RSI ${f1(T.rsi, 0)}, MACD ${f1(T.macd, 2)} vs signal ${f1(T.signal, 2)}. Signals: ${(fd.tech3.D.signals || []).map((x) => x.t).join("; ") || "none"}.`);
    const Wk = fd.tech3?.W?.last; if (Wk) put(tl, "T2", "Weekly trend", `Weekly: RSI ${f1(Wk.rsi, 0)}; signals: ${(fd.tech3.W.signals || []).map((x) => x.t).join("; ") || "none"}.`);
    if (fd.pm) put(tl, "T3", "Pattern match", `Pattern match (last ${fd.pm.win} days against its own and SPY's history): ${pc(fd.pm.win_rate, 0)} of the ${fd.pm.n} closest past paths were up ${fd.pm.fwd} days later (base rate ${pc(fd.pm.base_win_rate, 0)}), median ${spf(fd.pm.median)}.`);
    const an = fd.analogs; if (an) put(tl, "T4", "Times like this", `The ${an.n} past days most like today (1M ${spf(an.now.r1m)}, 3M ${spf(an.now.r3m)}, 12M ${spf(an.now.r12m)}, ${spf(an.now.vs200)} vs the 200-day): ${HZ.map((h) => `${h} later median ${spf(an.horizons[h]?.median)}, ${pc(an.horizons[h]?.pos, 0)} up (all days: ${spf(an.all[h]?.median)}, ${pc(an.all[h]?.pos, 0)} up)`).join("; ")}.`);
    if (fd.levels) put(tl, "T5", "Price levels", `Levels: 52-week high ${f1(fd.levels.high52, 2)}, low ${f1(fd.levels.low52, 2)}, 3-month swing high ${f1(fd.levels.swing_high, 2)}, swing low ${f1(fd.levels.swing_low, 2)}, 50-day ${f1(fd.levels.sma50, 2)}, 200-day ${f1(fd.levels.sma200, 2)}.`);
    const st = fd.street; if (st?.n) put(tl, "N1", "Wall Street on its holdings", `Wall Street on the ${st.n} biggest holdings (${pc(st.on, 0)} of the fund): ${pc(st.buy_share, 0)} of ratings are buy, weighted; consensus targets ${spf(st.upside)} above the holdings' prices. Biggest: ${st.rows.slice(0, 6).map((r) => `${r.ticker} ${r.consensus || "n/a"} (${pc(r.buy_share, 0)} buy, target ${spf(r.upside)})`).join("; ")}.`);
    const se = fd.sent; if (se?.rows?.length) put(tl, "N2", "News sentiment", `News sentiment of the biggest holdings (EODHD, -1 to +1, weighted): 30 days ${f1(se.s30, 2)}, 90 days ${f1(se.s90, 2)}. ${se.rows.slice(0, 6).map((r) => `${r.ticker} ${f1(r.s30, 2)} (${r.n30} articles)`).join(", ")}.`);
    (fd.news || []).slice(0, 8).forEach((x, i) => put(tl, "NW" + (i + 1), trim(x.title, 80), `${x.date} · ${x.symbol || ""} · ${trim(x.title, 160)}${x.source ? ` (${x.source})` : ""}.`));
    const dv = fd.dist; if (dv?.paying) put(tl, "D1", "Distributions", `Distributions: ${pc(dv.yield, 2)} trailing yield (${f1(dv.annual, 2)} a share a year, ${String(dv.freq || "").toLowerCase()}); 5-year growth ${spf(dv.cagr5)} a year${dv.cut5 ? "; cut in the last five years" : ""}${dv.next ? `; next ex-date ${dv.next.ex}` : ""}.`);
    const tr = fd.track; if (tr?.done) put(tl, "K1", "Track record", `This page's past calls on the fund: ${tr.done} scored, direction right ${pc(tr.hit, 0)}, inside the range ${pc(tr.in_range, 0)}.`);
    B.tech = tl.join("\n");
    // D: the industries' own drivers and risks (for the context analyst)
    const dl = [`## WHAT EACH BIG INDUSTRY'S STRATEGIST SAYS DRIVES IT`];
    fd.cov.industries.slice(0, 12).forEach((g) => { const d = fd.digests?.[lc(g.industry)]; if (d?.drivers?.length || d?.risks?.length) dl.push(`${g.industry} (${pc(g.weight)}): drivers: ${d.drivers.join("; ") || "n/a"}. Risks: ${d.risks.join("; ") || "n/a"}.`); });
    B.ind = dl.join("\n");
    return { blocks: B, idx };
  }

  // ============================================================= the four parts and the outlook
  const CALLS = "bullish | slightly bullish | neutral | slightly bearish | bearish";
  const READ = (panels) => `"reads": {${Object.entries(panels).map(([k, v]) => `"${k}": "2-3 sentences on ${v}: what the numbers say about this fund and what it means for an owner (cite IDs, use the figures)"`).join(", ")}}`;
  const PANELS = {
    core: { holdings: "the holdings and their concentration", industries: "the industry mix and how the industries are rated", valuation: "valuation and what's priced in", fundamentals: "profitability, earnings and the balance sheet seen through the industries", income: "income: yield, fees and dividend coverage", coverage: "how much of the fund the analysis covers and what that means" },
    calls: { perf: "the fund's returns against its benchmark and SPY", risk: "risk: beta, volatility, drawdowns, capture, tracking error", calendar: "the dated events ahead", plan: "the price levels and when to buy", times: "past setups like today and what came next", track: "how this page's past calls on the fund have done" },
    context: { stress: "how the fund held up in past crises and booms", sens: "the fund's measured macro sensitivities against its industries'", look: "the look-through calls and scores", tech: "trend, momentum and the pattern match", street: "Wall Street's view of the biggest holdings", news: "news and sentiment on the biggest holdings", dist: "the distributions" },
    exposures: { trade: "trade and supply chains", regulation: "regulation", outside: "the holdings the analysis can't see" },
  };
  const SCHEMA = {
    core: `{"headline": "one sentence: what owning this fund means now",
 "verdict": {"call": "attractive | neutral | unattractive", "summary": "2-3 sentences: is it worth owning now, and for whom"},
 "thesis": "3 short paragraphs: what the fund really is (its industries and bets), what its industries' analysis says, and what the price already assumes",
 "vs_benchmark": {"call": "outperform | in line | underperform", "why": "2-3 sentences on the tilt against the benchmark"},
 "strategy": "2-3 sentences: how the fund is run (index or active, concentration, turnover, fees) and whether that's worth paying for",
 "valuation": {"read": "2-3 sentences: valuation against history and what's priced in"},
 "quality": "2 sentences on the quality of what it holds (margins, returns, balance sheets)",
 "street": {"stance": "agree | more bullish | more bearish", "summary": "2-3 sentences: where you land against Wall Street's view of the biggest holdings (N1) and why"},
 "risks": [{"risk": "...", "likelihood": "high | medium | low", "impact": "high | medium | low", "ids": ["W1"]}],
 "catalysts": [{"date": "YYYY-MM-DD or YYYY-MM", "event": "...", "why": "...", "ids": ["E1"]}],
 "watch": ["what to watch, with IDs"],
 "fit": {"income": {"fit": "strong | good | weak | poor", "conviction": "high | medium | low", "adjust": 0, "why": "2 sentences for this investor: what they get and what they give up", "watch": "the number to track", "what_changes": "what would raise or lower the fit"}, "conservative": {...}, "growth": {...}, "aggressive": {...}},
 ${READ(PANELS.core)},
 "confidence": "high | medium | low"}
Sizes: 4-7 risks, 3-6 catalysts, 3-5 watch items. Fit adjust moves the weighted score by at most 5 points either way.`,
    calls: `{"scenarios": {"bull": {"probability": 25, "narrative": "2-3 sentences: what happens to the fund's main industries", "move": [8, 14]}, "base": {...}, "bear": {...}},
 "horizons": {${HZ.map((h) => `"${h}": {"call": "${CALLS}", "expected_move": [-3, 5], "probability_up": 58, "vs_benchmark": "outperform | in line | underperform", "drivers": "4-6 sentences, cited, with numbers: what moves the fund in this window, which dated events land in it, and how the industries' calls add up for this fund", "decisions": [{"date": "YYYY-MM-DD", "event": "..."}]}`).join(", ")}},
 "plans": {"income": {"size_pct": 0, "entry": "when or at what to buy", "hedge": "how to hedge, if at all", "review": "when to revisit"}, "conservative": {...}, "growth": {...}, "aggressive": {...}},
 "change_mind": ["what would change the call, with a level or a date"],
 ${READ(PANELS.calls)}}
Probabilities add to 100. Moves are % price moves over 12 months for the scenarios and over each window for the horizons, ranges low to high. The 12M call must agree with the scenarios.`,
    context: `{"drivers": [{"driver": "what drives the fund over 12 months", "effect": "helps | hurts | mixed", "why": "2 sentences, cited", "ids": ["I1"]}],
 "industries": [{"id": "I1", "effect": "helps | hurts | mixed", "why": "one sentence: what this industry's analysis means for the fund at its weight"}],
 "macro": {"regime": "supportive | mixed | headwind", "headline": "one sentence on the macro for this fund", "horizons": {${HZ.map((h) => `"${h}": {"call": "supportive | mixed | headwind", "why": "1-2 sentences"}`).join(", ")}}, "flip": "what would flip it, with levels",
   "factors": [{"id": "MF1", "effect": "tailwind | headwind | neutral", "why": "one sentence: what this sensitivity means for the fund now"}]},
 "world": [{"id": "W1", "effect": "helps | hurts | mixed | none", "magnitude": "high | medium | low", "why": "one sentence: how it reaches the fund and how much of it"}],
 ${READ(PANELS.context)}}
Sizes: 4-7 drivers; one entry for EVERY industry I, every factor MF and every world event W listed.`,
    exposures: `{"trade_overall": {"risk": "low | moderate | high", "summary": "3 sentences: what the industries' trade maps mean for this fund", "biggest": "the single country or risk that matters most, and why"},
 "trade": [{"id": "C1", "exposure": "high | medium | low", "effect": "helps | hurts | mixed | none", "why": "one sentence with a size"}],
 "reg_overall": {"stance": "tailwind | headwind | mixed", "summary": "3 sentences: the net regulatory picture for the fund", "biggest": "the single most material rule, with how much of the fund it reaches"},
 "regulation": [{"id": "R1", "effect": "helps | hurts | mixed", "materiality": "high | medium | low", "why": "one sentence"}],
 "outside": [{"id": "O1", "matters": "high | medium | low", "why": "one sentence: what this holding means for the fund and what the analysis misses by not covering it"}],
 ${READ(PANELS.exposures)}}
Sizes: one entry for EVERY country C, rule R and outside holding O listed.`,
  };
  const BLOCKS = { core: ["base", "hold", "val", "tech"], calls: ["base", "perf", "val", "cal", "tech"], context: ["base", "perf", "ind", "tech"], exposures: ["base", "hold"] };
  const INTRO = {
    core: "You write part one of a four-part analysis of this fund; colleagues write the calls, the context and the exposures at the same time. Write ONLY: the verdict, the thesis, the benchmark view, strategy, valuation, quality, risks, catalysts, watch, fit and your panel reads.",
    calls: "You write part two of a four-part analysis: the 12-month scenarios, the fund's 1M-12M calls, the plans per investor type and your panel reads. Colleagues write the rest at the same time.",
    context: "You write part three of a four-part analysis: what drives the fund, each industry row, the macro (with the fund's own measured sensitivities), each world event, and your panel reads. Colleagues write the rest at the same time.",
    exposures: "You write part four of a four-part analysis: trade, regulation and the holdings the analysis can't see, row by row, and your panel reads. Colleagues write the rest at the same time.",
  };
  /** The prompt for one part ("core" | "calls" | "context" | "exposures"). dz: dossier(). */
  function partPrompt(fd, dz, part, today) {
    return `You are a fund analyst on an investment research team. Today is ${today}. The team has analyzed US industries one at a time (each with a lead strategist's 1M-12M calls, scenarios, macro, world-events, trade and regulation reports), and code has mapped this fund's holdings onto those industries and weighted every figure by the fund's weights. ${INTRO[part]}

Rules:
- Use only the facts and numbers below. Don't invent figures, holdings, events or dates; every number you use must appear below.
- Cite the lines you rely on with their IDs in square brackets, e.g. [I1][H3][P2]. Every claim needs at least one ID.
- Plain, direct sentences. Say what the fund is betting on and what that means for an owner.
- Be honest about coverage: private companies, foreign listings and code-only industries limit how sure you can be.

${BLOCKS[part].map((b) => dz.blocks[b]).filter(Boolean).join("\n\n")}

Reply with ONLY this JSON:
${SCHEMA[part]}`;
  }
  /** The outlook: where the fund is likely to go over each window and why, for and against (one call, like the industry's). */
  function leanPrompt(fd, dz, today) {
    return `You are the fund strategist. Today is ${today}. Give your outlook for this fund over the next 1, 3, 6 and 12 months: which way it's likely to go and why, with the best arguments for and against. Start from the industries' calls weighted by the fund (F4), the base rates (V6), the scenarios (F3), the fund's own trend and risk (P lines) and the dated events (E lines), and say where you differ from the weighted calls.
Use only the facts below; cite IDs in square brackets.

${["base", "perf", "val", "cal", "tech"].map((b) => dz.blocks[b]).filter(Boolean).join("\n\n")}

Reply with ONLY this JSON:
{"headline": "one sentence: where the fund is likely to go and the main reason",
 "calls": {${HZ.map((h) => `"${h}": {"call": "${CALLS}", "why": "2-3 sentences, cited", "for": ["the 2-3 strongest reasons it goes up"], "against": ["the 2-3 strongest reasons it goes down"]}`).join(", ")}}}`;
  }

  // ============================================================= cleaning and checks
  const ENUM = { verdict: ["attractive", "neutral", "unattractive"], vs: ["outperform", "in line", "underperform"], lvl: ["high", "medium", "low"], fit: ["strong", "good", "weak", "poor"],
    eff: ["helps", "hurts", "mixed", "none"], macro: ["supportive", "mixed", "headwind"], fac: ["tailwind", "headwind", "neutral"], risk: ["low", "moderate", "high"], stance: ["tailwind", "headwind", "mixed"] };
  const CALLV = ["bullish", "slightly bullish", "neutral", "slightly bearish", "bearish"];
  function cleaner(idx) {
    let dropped = 0;
    const known = (id) => Object.prototype.hasOwnProperty.call(idx, id);
    const t = (s, k = 900) => trim(String(s ?? "").replace(/\[([A-Z]{1,2}\d{1,3})\]/g, (m, id) => (known(id) ? m : (dropped++, ""))).replace(/\s+([.,;:])/g, "$1"), k);
    const ids = (a) => (Array.isArray(a) ? a : []).filter((id) => known(id) || (dropped++, false));
    const en = (v, list) => { const x = lc(v).trim(); return list.includes(x) ? x : null; };
    const rng = (r) => (Array.isArray(r) && r.length === 2 && isNum(n(r[0])) && isNum(n(r[1])) ? [Math.min(n(r[0]), n(r[1])), Math.max(n(r[0]), n(r[1]))] : null);
    const rows = (a, f, need) => (Array.isArray(a) ? a : []).map(f).filter((x) => x && (!need || x[need]));
    const rowId = (x) => (known(x?.id) ? x.id : (x?.id && dropped++, null));
    const reads = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, t(v, 600)]).filter(([, v]) => v));
    return { t, ids, en, rng, rows, rowId, reads, dropped: () => dropped };
  }
  /** One part's answer, cleaned: only IDs the dossier has, known enums, ranges low to high, fit adjust within ±5. */
  function cleanPart(part, o, idx) {
    const C = cleaner(idx), { t, ids, en, rng, rows, rowId, reads } = C; o = o || {};
    let w = {};
    if (part === "core") {
      const fit = {}; for (const k of ["income", "conservative", "growth", "aggressive"]) { const x = o.fit?.[k] || {};
        fit[k] = { fit: en(x.fit, ENUM.fit), conviction: en(x.conviction, ENUM.lvl), adjust: Math.max(-5, Math.min(5, Math.round(n(x.adjust) || 0))), why: t(x.why, 400), watch: t(x.watch, 200), what_changes: t(x.what_changes, 240) }; }
      w = { headline: t(o.headline, 300), verdict: { call: en(o.verdict?.call, ENUM.verdict), summary: t(o.verdict?.summary, 600) }, thesis: t(o.thesis, 3000),
        vs_benchmark: { call: en(o.vs_benchmark?.call, ENUM.vs), why: t(o.vs_benchmark?.why, 600) }, strategy: t(o.strategy, 600), valuation: { read: t(o.valuation?.read, 600) }, quality: t(o.quality, 400), street: o.street ? { stance: en(o.street.stance, ["agree", "more bullish", "more bearish"]), summary: t(o.street.summary, 600) } : null,
        risks: rows(o.risks, (x) => ({ risk: t(x?.risk, 300), likelihood: en(x?.likelihood, ENUM.lvl), impact: en(x?.impact, ENUM.lvl), ids: ids(x?.ids) }), "risk").slice(0, 8),
        catalysts: rows(o.catalysts, (x) => ({ date: String(x?.date || "").slice(0, 10), event: t(x?.event, 200), why: t(x?.why, 300), ids: ids(x?.ids) }), "event").slice(0, 8),
        watch: (Array.isArray(o.watch) ? o.watch : []).map((x) => t(typeof x === "string" ? x : x?.text, 300)).filter(Boolean).slice(0, 6), fit, reads: reads(o.reads), confidence: en(o.confidence, ENUM.lvl) };
    } else if (part === "calls") {
      const scen = {}; for (const k of ["bull", "base", "bear"]) { const x = o.scenarios?.[k]; if (x) scen[k] = { probability: n(x.probability), narrative: t(x.narrative, 600), move: rng(x.move) }; }
      const hz = {}; for (const h of HZ) { const x = o.horizons?.[h]; if (!x) continue; hz[h] = { call: en(x.call, CALLV), expected_move: rng(x.expected_move), probability_up: Math.max(0, Math.min(100, n(x.probability_up))),
        vs_benchmark: en(x.vs_benchmark, ENUM.vs), drivers: t(x.drivers, 1400), decisions: rows(x.decisions, (d) => ({ date: String(d?.date || "").slice(0, 10), event: t(d?.event, 200) }), "event").slice(0, 6) }; }
      const plans = {}; for (const k of ["income", "conservative", "growth", "aggressive"]) { const x = o.plans?.[k]; if (x) plans[k] = { size_pct: n(x.size_pct), entry: t(x.entry, 240), hedge: t(x.hedge, 240), review: t(x.review, 200) }; }
      w = { scenarios: scen, horizons: hz, plans, change_mind: (Array.isArray(o.change_mind) ? o.change_mind : []).map((x) => t(x, 300)).filter(Boolean).slice(0, 6), reads: reads(o.reads) };
    } else if (part === "context") {
      w = { drivers: rows(o.drivers, (x) => ({ driver: t(x?.driver, 200), effect: en(x?.effect, ENUM.eff), why: t(x?.why, 500), ids: ids(x?.ids) }), "driver").slice(0, 8),
        industries: rows(o.industries, (x) => ({ id: rowId(x), effect: en(x?.effect, ENUM.eff), why: t(x?.why, 400) }), "id"),
        macro: o.macro ? { regime: en(o.macro.regime, ENUM.macro), headline: t(o.macro.headline, 300), flip: t(o.macro.flip, 300),
          horizons: Object.fromEntries(HZ.map((h) => [h, o.macro.horizons?.[h] ? { call: en(o.macro.horizons[h].call, ENUM.macro), why: t(o.macro.horizons[h].why, 300) } : null]).filter(([, v]) => v)),
          factors: rows(o.macro.factors, (x) => ({ id: rowId(x), effect: en(x?.effect, ENUM.fac), why: t(x?.why, 300) }), "id") } : null,
        world: rows(o.world, (x) => ({ id: rowId(x), effect: en(x?.effect, ENUM.eff), magnitude: en(x?.magnitude, ENUM.lvl), why: t(x?.why, 400) }), "id"), reads: reads(o.reads) };
    } else if (part === "exposures") {
      w = { trade_overall: o.trade_overall ? { risk: en(o.trade_overall.risk, ENUM.risk), summary: t(o.trade_overall.summary, 700), biggest: t(o.trade_overall.biggest, 300) } : null,
        trade: rows(o.trade, (x) => ({ id: rowId(x), exposure: en(x?.exposure, ENUM.lvl), effect: en(x?.effect, ENUM.eff), why: t(x?.why, 400) }), "id"),
        reg_overall: o.reg_overall ? { stance: en(o.reg_overall.stance, ENUM.stance), summary: t(o.reg_overall.summary, 700), biggest: t(o.reg_overall.biggest, 300) } : null,
        regulation: rows(o.regulation, (x) => ({ id: rowId(x), effect: en(x?.effect, ENUM.eff), materiality: en(x?.materiality, ENUM.lvl), why: t(x?.why, 400) }), "id"),
        outside: rows(o.outside, (x) => ({ id: rowId(x), matters: en(x?.matters, ENUM.lvl), why: t(x?.why, 400) }), "id"), reads: reads(o.reads) };
    } else if (part === "lean") {
      w = { headline: t(o.headline, 300), calls: Object.fromEntries(HZ.map((h) => { const x = o.calls?.[h]; return [h, x ? { call: en(x.call, CALLV), why: t(x.why, 600), for: (x.for || []).map((y) => t(y, 240)).filter(Boolean).slice(0, 4), against: (x.against || []).map((y) => t(y, 240)).filter(Boolean).slice(0, 4) } : null]; }).filter(([, v]) => v)) };
    }
    return { w, dropped: C.dropped() };
  }
  /**
   * Checks across the parts: scenario probabilities add to 100, the 12M call agrees with the scenario-weighted move,
   * each window's range holds its call's direction, ranges widen with time. Returns {expected, issues: [text]}.
   */
  function checks(a) {
    const issues = [], S = a.scenarios || {}, H = a.horizons || {};
    const ps = ["bull", "base", "bear"].map((k) => n(S[k]?.probability)), sum = ps.reduce((x, y) => x + (isNum(y) ? y : 0), 0);
    if (ps.every(isNum) && Math.abs(sum - 100) > 2) issues.push(`the scenario probabilities add to ${sum}%, not 100%`);
    const mid = (r) => (r ? (r[0] + r[1]) / 2 : NaN);
    const exp = ps.every(isNum) && sum > 0 ? ["bull", "base", "bear"].reduce((x, k, i) => x + (ps[i] / sum) * mid(S[k]?.move), 0) : NaN;
    const c12 = P.callNum(H["12M"]?.call);
    if (isNum(exp) && isNum(c12) && ((c12 > 0 && exp < -1) || (c12 < 0 && exp > 1))) issues.push(`the 12M call (${H["12M"].call}) disagrees with the scenarios' expected ${sp(exp)}`);
    for (const h of HZ) { const x = H[h]; if (!x?.expected_move) continue; const c = P.callNum(x.call), m = mid(x.expected_move);
      if (isNum(c) && c > 0 && x.expected_move[1] <= 0) issues.push(`${h}: a bullish call with a range entirely below zero`);
      if (isNum(c) && c < 0 && x.expected_move[0] >= 0) issues.push(`${h}: a bearish call with a range entirely above zero`);
      if (isNum(x.probability_up) && isNum(c) && ((c > 0 && x.probability_up < 45) || (c < 0 && x.probability_up > 55))) issues.push(`${h}: ${x.probability_up}% chance up doesn't match a ${x.call} call`);
      void m; }
    const width = HZ.map((h) => (H[h]?.expected_move ? H[h].expected_move[1] - H[h].expected_move[0] : NaN)).filter(isNum);
    for (let i = 1; i < width.length; i++) if (width[i] < width[i - 1] * 0.8) { issues.push("the ranges narrow as the window gets longer"); break; }
    return { expected: exp, issues };
  }
  /** Why the saved analysis is out of date: the step-3 rules, on the step-3 fingerprint. */
  const changes = (a, b) => P.changes(a, b);

  const FundAn = { streetLook, sentimentLook, trackLog, trackEval, holdings, concentration, extras, calendar, dossier, partPrompt, leanPrompt, cleanPart, checks, changes, PANELS, PARTS: ["core", "calls", "context", "exposures"], CALLV };
  if (typeof module !== "undefined" && module.exports) module.exports = FundAn;
  else root.FundAn = FundAn;
})(typeof window !== "undefined" ? window : globalThis);
