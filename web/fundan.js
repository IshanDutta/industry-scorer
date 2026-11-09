/* Industry Scorer: the full analysis of one ETF or mutual fund, as deep as a company's.
 *
 * Code only (no I/O). Builds on portfolio.js (holdings matched to industries, the look-through): the fund's own
 * holdings joined to their industries' company rows, concentration, the fundamentals and what's priced in seen through
 * the industries, base rates, the dated calendar (holdings' earnings and the industries' events), and the fund's
 * own price-based facts handed in by the page (returns, risk against its benchmark and SPY, crises, measured macro
 * sensitivities). Then the write-up: six analysts at once (core, calls, markets, context, world, exposures) plus the outlook, each
 * on its own slice of one ID'd dossier, and the code that cleans and checks what they write.
 */
(function (root) {
  "use strict";
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const n = (x) => (x === null || x === undefined || x === "" ? NaN : Number(x));
  const lc = (s) => String(s || "").toLowerCase();
  const P = typeof module !== "undefined" && module.exports ? require("./portfolio.js") : root.Portfolio;
  const O = typeof module !== "undefined" && module.exports ? require("./outlook.js") : root.Outlook;
  const M = typeof module !== "undefined" && module.exports ? require("./fundmore.js") : root.FundMore;
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
  // ============================================================= Wall Street, news, technicals and history
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


  // ============================================================= the outlook: the company page's engine, for a fund
  /** The components the outlook weighs, one entry each, in this order (the fund's version of the company's sixteen). */
  const FUND_INPUTS = [
    ["industries", "Its industries' outlooks"], ["verdict", "The fund write-up's verdict"], ["holdings", "Holdings & concentration"], ["earnings", "Earnings & estimate revisions"],
    ["valuation", "Valuation & what's priced in"], ["quality", "Quality of what it holds"], ["street", "Wall Street on its holdings"], ["momentum", "Momentum & price action"],
    ["history", "Past setups like today"], ["catalysts", "Dated catalysts ahead"], ["macro", "Macro & rates"], ["world", "World events & trade"],
    ["regulation", "Regulation & legal"], ["benchmark", "Its tilt against the benchmark"], ["coverage", "Coverage & blind spots"], ["risks", "Risks & red flags"],
    ["cycle", "Its industries' cycle & KPIs"], ["season", "The holdings' earnings season"],
  ];
  /** An industry's outlook calls (six levels): its saved outlook, else read off its strategist's calls. */
  function indCalls(d) {
    const out = {};
    for (const h of HZ) { const l = O.level(d?.lean?.[h]) || (() => { const c = d?.calls?.[h]; if (!c?.call) return null; let l0 = O.level(c.call); if (l0 && !/slight|strong/.test(lc(c.call))) l0 = O.level("slightly " + l0); if (!l0) l0 = isNum(c.p_up) && c.p_up >= 50 ? "slightly bullish" : "slightly bearish"; return l0; })();
      if (l) out[h] = l; }
    return out;
  }
  /**
   * Each window, as the company page has it: when it ends, a normal move (one sigma from the fund's volatility), the
   * trailing move, how often the fund was higher over that span in its own history, and the holdings reporting inside it.
   */
  function windows(fd, today) {
    const ser = fd.ser, c = ser?.closes || [], vol = n(fd.g1?.vol), M = { "1M": 1, "3M": 3, "6M": 6, "12M": 12 }, TR = { "1M": "1M", "3M": "3M", "6M": "6M", "12M": "1Y" };
    return HZ.map((h) => {
      const end = new Date(Date.parse(today) + Math.round(M[h] * 30.44) * 864e5).toISOString().slice(0, 10), step = Math.round(M[h] * 21);
      let up = 0, k = 0; for (let i = 0; i + step < c.length; i += 5) if (c[i] > 0) { k++; if (c[i + step] > c[i]) up++; }
      const tr = (fd.retRows || []).find((r) => r.label === TR[h]);
      const rep = (fd.hold || []).filter((x) => x.next && x.next >= today && x.next <= end && x.weight >= 0.01).slice(0, 8).map((x) => ({ symbol: x.ticker, date: x.next, weight: Math.round(x.weight * 1000) / 10 }));
      return { h, end, sigma: vol > 0 ? Math.round(vol * Math.sqrt(M[h] / 12) * 1000) / 10 : null, trailing: tr ? Math.round(tr.value * 10) / 10 : null, vs_bench: tr && isNum(tr.bench) ? Math.round((tr.value - tr.bench) * 10) / 10 : null,
        base_up: k >= 20 ? Math.round((up / k) * 100) : null, reporting: rep };
    });
  }
  /**
   * Code's starting point for each window, as the company's is built from its industry's call: the fund's industries'
   * outlook calls weighted by the fund (-3..+3), then moved half a notch each by its own setups like today against all
   * days, Wall Street on its holdings (6M and 12M), and an overbought or oversold month (1M only).
   */
  function prior(fd) {
    const inds = (fd.cov?.industries || []).map((g) => ({ g, c: indCalls(fd.digests?.[lc(g.industry)]) })).filter((x) => Object.keys(x.c).length);
    if (!inds.length) return null;
    const out = {}, tb = fd.timesL?.on >= 0.3 ? fd.timesL.base : null, st = fd.street, rsi = n(fd.tech3?.D?.last?.rsi);
    for (const h of HZ) {
      let w = 0, s0 = 0; for (const { g, c } of inds) if (c[h]) { w += g.weight; s0 += g.weight * O.SIGN[c[h]]; }
      if (!w) continue;
      const base = s0 / w, parts = [{ label: `its industries' outlooks, weighted by the fund (${inds.length} industries, ${Math.round(w * 100)}% of the fund)`, adj: Math.round(base * 100) / 100 }];
      let sc = base; const dir = Math.sign(base) || 1;
      const b = tb?.[h];
      if (isNum(n(b?.pos)) && isNum(n(b?.all_pos))) { const d = (b.pos - b.all_pos) / 100, adj = d >= 0.1 ? 0.5 : d <= -0.1 ? -0.5 : 0; if (adj) { parts.push({ label: `times like this: its industries' past months most like today were up ${Math.round(b.pos)}% of the time over ${h} vs ${Math.round(b.all_pos)}% for all months (weighted by the fund)`, adj }); sc += adj; } }
      if ((h === "6M" || h === "12M") && st?.n >= 3 && isNum(st.upside) && isNum(st.buy_share)) { const adj = st.upside >= 0.15 && st.buy_share >= 0.65 ? 0.5 : st.upside <= 0 ? -0.5 : 0; if (adj) { parts.push({ label: `Wall Street sees ${Math.round(st.upside * 100)}% upside on its biggest holdings, ${Math.round(st.buy_share * 100)}% buy`, adj }); sc += adj; } }
      if (h === "1M" && isNum(rsi)) { const adj = rsi >= 70 ? -0.5 : rsi <= 30 ? 0.5 : 0; if (adj) { parts.push({ label: `daily RSI ${Math.round(rsi)} (${rsi >= 70 ? "overbought" : "oversold"})`, adj }); sc += adj; } }
      const sg = Math.sign(sc) || dir, m = Math.abs(sc);
      out[h] = { call: `${m < 1.5 ? "slightly " : m >= 2.5 ? "strongly " : ""}${sg > 0 ? "bullish" : "bearish"}`, score: Math.round(sc * 100) / 100, parts };
    }
    return Object.keys(out).length ? out : null;
  }
  const priorText = (Pr) => Object.entries(Pr || {}).map(([h, x]) => `${h}: ${x.call} (score ${x.score > 0 ? "+" : ""}${x.score}: ${x.parts.map((p, i) => `${p.label}${i ? ` ${p.adj > 0 ? "+" : ""}${p.adj}` : ""}`).join("; ")})`).join("\n");
  /** Until the outlook is made: provisional, read off code's starting point (no Claude). */
  function provisional(pr, today) {
    if (!pr) return null;
    return { v: 3, date: today, provisional: true, headline: "Provisional: code's starting point, from its industries' outlooks. The outlook is made with the analysis.", calls: Object.fromEntries(Object.entries(pr).map(([h, x]) => [h, { call: x.call, basis: "code's starting point" }])), evidence: [], checks: [] };
  }

  // ============================================================= the dossier the five analysts and the outlook write from
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
    // T: technicals and the pattern match; HE: times like this; N: Wall Street and news; D: distributions
    const tl = [`## TECHNICALS, HISTORY, WALL STREET AND NEWS`];
    const T = fd.tech3?.D?.last; if (T) put(tl, "T1", "Technicals", `Daily: close ${f1(T.close, 2)}, SMA 20/50/200 ${f1(T.sma20)}/${f1(T.sma50)}/${f1(T.sma200)}, RSI ${f1(T.rsi, 0)}, MACD ${f1(T.macd, 2)} vs signal ${f1(T.signal, 2)}. Signals: ${(fd.tech3.D.signals || []).map((x) => x.t).join("; ") || "none"}.`);
    const Wk = fd.tech3?.W?.last; if (Wk) put(tl, "T2", "Weekly trend", `Weekly: RSI ${f1(Wk.rsi, 0)}; signals: ${(fd.tech3.W.signals || []).map((x) => x.t).join("; ") || "none"}.`);
    if (fd.pm) put(tl, "T3", "Pattern match", `Pattern match (last ${fd.pm.win} days against its own and SPY's history): ${pc(fd.pm.win_rate, 0)} of the ${fd.pm.n} closest past paths were up ${fd.pm.fwd} days later (base rate ${pc(fd.pm.base_win_rate, 0)}), median ${spf(fd.pm.median)}.`);
    if (fd.timesL?.episodes?.length) { tl.push(M.timesLookText(fd.timesL, fd.sym)); fd.timesL.episodes.forEach((x) => { idx[x.id] = `${x.month}: a past month like today (${x.industries.length} of its industries)`; }); }
    if (fd.levels) put(tl, "T5", "Price levels", `Levels: 52-week high ${f1(fd.levels.high52, 2)}, low ${f1(fd.levels.low52, 2)}, 3-month swing high ${f1(fd.levels.swing_high, 2)}, swing low ${f1(fd.levels.swing_low, 2)}, 50-day ${f1(fd.levels.sma50, 2)}, 200-day ${f1(fd.levels.sma200, 2)}.`);
    const st = fd.street; if (st?.n) put(tl, "N1", "Wall Street on its holdings", `Wall Street on the ${st.n} biggest holdings (${pc(st.on, 0)} of the fund): ${pc(st.buy_share, 0)} of ratings are buy, weighted; consensus targets ${spf(st.upside)} above the holdings' prices. Biggest: ${st.rows.slice(0, 6).map((r) => `${r.ticker} ${r.consensus || "n/a"} (${pc(r.buy_share, 0)} buy, target ${spf(r.upside)})`).join("; ")}.`);
    const se = fd.sent; if (se?.rows?.length) put(tl, "N2", "News sentiment", `News sentiment of the biggest holdings (EODHD, -1 to +1, weighted): 30 days ${f1(se.s30, 2)}, 90 days ${f1(se.s90, 2)}. ${se.rows.slice(0, 6).map((r) => `${r.ticker} ${f1(r.s30, 2)} (${r.n30} articles)`).join(", ")}.`);
    (fd.news || []).slice(0, 8).forEach((x, i) => put(tl, "NW" + (i + 1), trim(x.title, 80), `${x.date} · ${x.symbol || ""} · ${trim(x.title, 160)}${x.source ? ` (${x.source})` : ""}.`));
    const dv = fd.dist; if (dv?.paying) put(tl, "D1", "Distributions", `Distributions: ${pc(dv.yield, 2)} trailing yield (${f1(dv.annual, 2)} a share a year, ${String(dv.freq || "").toLowerCase()}); 5-year growth ${spf(dv.cagr5)} a year${dv.cut5 ? "; cut in the last five years" : ""}${dv.next ? `; next ex-date ${dv.next.ex}` : ""}.`);
    B.tech = tl.join("\n");
    // D: the industries' own drivers and risks (for the context analyst)
    const dl = [`## WHAT EACH BIG INDUSTRY'S STRATEGIST SAYS DRIVES IT`];
    fd.cov.industries.slice(0, 12).forEach((g) => { const d = fd.digests?.[lc(g.industry)]; if (d?.drivers?.length || d?.risks?.length) dl.push(`${g.industry} (${pc(g.weight)}): drivers: ${d.drivers.join("; ") || "n/a"}. Risks: ${d.risks.join("; ") || "n/a"}.`); });
    B.ind = dl.join("\n");
    // SC: the scorecard (code); PR: the peers; ES: the earnings season
    const sc = [`## THE SCORECARD, THE PEERS AND THE EARNINGS SEASON (code)`];
    if (fd.card) put(sc, "SC1", "Scorecard", M.scoreText(fd.card));
    const pt = M.peerText(fd.sym, fd.peers?.rows); if (pt) put(sc, "PR1", "Peer funds", pt);
    const es = M.seasonText(fd.season); if (es) put(sc, "ES1", "Earnings season", es);
    B.score = sc.length > 1 ? sc.join("\n") : "";
    // DB: the industries' debates; CY: their cycle and KPIs
    const db = [`## THE BIGGEST DEBATES IN ITS INDUSTRIES (their lead strategists'; answer each by its ID)`];
    for (const x of fd.debates || []) put(db, x.id, `${x.industry}: ${trim(x.q, 60)}`, `${x.industry} (${pc(x.weight)} of the fund): ${x.q} BULL: ${x.bull} BEAR: ${x.bear} The industry leans ${x.lean || "n/a"}.${x.resolves ? ` Settled by: ${x.resolves}` : ""}`);
    B.deb = db.length > 1 ? db.join("\n") : "";
    const cy = [`## ITS INDUSTRIES' CYCLE AND KPIs (their KPI analysts')`], C = fd.cycle;
    if (C) { const t = (o) => Object.entries(o || {}).map(([k, w]) => `${k} ${pc(w, 0)}`).join(", ") || "n/a";
      cy.push(`Covered: ${pc(C.on, 0)} of the fund. Cycle position by weight: ${t(C.phase)}. Pricing power: ${t(C.pricing)}. Operating leverage: ${t(C.oplev)}.${C.tone ? ` Management tone (weighted share of signals): ${t(C.tone)}.` : ""}`);
      C.rows.slice(0, 10).forEach((r, i) => put(cy, "CY" + (i + 1), `${r.industry}: cycle`, `${r.industry} (${pc(r.weight)}): ${r.position || "n/a"}, pricing power ${r.pricing || "n/a"}, operating leverage ${r.oplev || "n/a"}. ${r.text || ""} KPIs: ${(r.kpis || []).map((k) => `${k.name} ${k.value}${k.vs_cycle ? ` (${k.vs_cycle})` : ""}`).join("; ") || "n/a"}.`));
      C.next.filter((x) => x.date >= today).slice(0, 6).forEach((x, i) => put(cy, "KT" + (i + 1), `${x.date} ${trim(x.event, 60)}`, `${x.date} · ${x.event} (${x.industry}, ${pc(x.weight)} of the fund${x.names?.length ? `; ${x.names.join(", ")}` : ""}).`)); }
    B.cyc = cy.length > 1 ? cy.join("\n") : "";
    // MI, WS, TC, RL, LI: the industry reports' macro, world, trade and regulation tables, merged and weighted (FundMore.affairs).
    if (fd.stress) { B.aff_macro = M.stressText(fd.stress, fd.sym); for (const x of fd.stress.scenarios) idx[x.id] = `Stress: ${x.name}`; }
    if (fd.aff) { const T = M.affairsText(fd.aff); B.aff_macro = [T.macro, B.aff_macro].filter(Boolean).join("\n\n"); B.aff_world = T.world; B.aff_trade = T.trade; B.aff_reg = T.reg;
      for (const x of fd.aff.indicators) idx[x.id] = x.label; for (const x of fd.aff.world) idx[x.id] = x.title; for (const x of fd.aff.trade) idx[x.id] = x.country; for (const x of fd.aff.rules) idx[x.id] = x.name; for (const x of fd.aff.items) idx[x.id] = x.title; }
    return { blocks: B, idx };
  }

  // ============================================================= the five parts and the outlook
  const CALLS = "bullish | slightly bullish | neutral | slightly bearish | bearish";
  // Each panel's read is a short analyst's note, not a caption: what the numbers say, set against its industries' own
  // reports, the specific findings behind it, what it means for an owner, and what would change it.
  const READ = (panels) => `"reads": {${Object.entries(panels).map(([k, v]) => `"${k}": {"text": "5-7 sentences on ${v}: what the numbers say about this fund (the figures, cited), how that compares with its biggest industries' own reports on the same panel and with its benchmark (more or less, and why), and the judgment you draw", "points": ["4-6 specific findings, each one sentence with a number and an ID"], "means": "2 sentences: what it means for someone who owns the fund now, and for someone thinking of buying it", "watch": "the one number or date that would change this read, with the level"}`).join(", ")}}`;
  const PANELS = {
    core: { score: "the scorecard: which pillars lift or hold back each investor's score, the fund's own numbers against its industries'", peers: "how the fund stacks up against its peer funds on return, risk and cost",
      holdings: "the holdings and their concentration: what the biggest positions are betting on and how much rides on them", industries: "the industry mix and how the industries are rated",
      valuation: "valuation and what's priced in", fundamentals: "profitability, earnings and the balance sheet seen through the industries", income: "income: yield, fees and dividend coverage", coverage: "how much of the fund the analysis covers and what that means" },
    calls: { debates: "the industries' debates and which side the fund is on", calendar: "the dated events ahead and which ones matter most at the fund's weights", plan: "the price levels and when to buy", times: "Times like this: the past months its industries' runs found most like today (macro backdrop and their setups), what those industries, the fund and the S&P 500 did next, and what the historians say is different now (cite HE)" },
    markets: { perf: "the fund's returns against its benchmark and SPY, by period, and what drove the gap", risk: "risk: beta, volatility, drawdowns, capture, tracking error, and how they've shifted", stress: "how the fund held up in past crises and booms and what that says about the next one",
      tech: "trend, momentum and the pattern match", street: "Wall Street's view of the biggest holdings", news: "news and sentiment on the biggest holdings", dist: "the distributions", season: "the holdings' earnings season: who reported, how it went and who's next" },
    context: { cycle: "where its industries are in their cycles and what their KPIs say", sens: "the fund's measured macro sensitivities against its industries'", look: "the look-through calls and scores", active: "its bets against the benchmark: the over- and underweights, whether they line up with the industries' calls, and what they add" },
    world: { macro_ind: "the macro indicators its industries' macro reports read, and what they add up to for the fund", world: "the world events that reach the fund through its industries" },
    exposures: { trade: "trade and supply chains across its industries' trade maps", regulation: "regulation and legal across its industries' rule books", outside: "the holdings the analysis can't see" },
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
 "holdings_notes": [{"id": "H1", "bet": "what this position is a bet on, in a few words", "view": "2 sentences at its weight: the case for and against, cited (its industry's call, its own analysis, its valuation, its next report)", "stance": "tailwind | neutral | headwind"}],
 "peers": {"stance": "best in group | competitive | lagging", "summary": "2 sentences: how it compares with its peer funds (PR1) and whether it's the one to own"},
 "fit": {"income": {"fit": "strong | good | weak | poor", "conviction": "high | medium | low", "why": "2 sentences for this investor: what they get and what they give up", "watch": "the number to track", "what_changes": "what would raise or lower the fit"}, "conservative": {...}, "growth": {...}, "aggressive": {...}},
 ${READ(PANELS.core)},
 "confidence": "high | medium | low"}
Sizes: 4-7 risks, 3-6 catalysts, 3-5 watch items, one holdings_notes entry for each of the 10 biggest holdings (H1-H10). Your fit judgment moves code's score for that investor (SC1): strong +5, good +2, weak -2, poor -5; judge each from the pillars and everything else, not from the score alone.`,
    calls: `{"scenarios": {"bull": {"probability": 25, "narrative": "2-3 sentences: what happens to the fund's main industries and holdings", "triggers": ["what would set it off"]}, "base": {...}, "bear": {...}},
 "horizons": {${HZ.map((h) => `"${h}": {"vs_benchmark": "outperform | in line | underperform", "drivers": "4-6 sentences, cited, with numbers: what moves the fund in this window, which dated events land in it, and how its industries' outlooks add up for this fund", "decisions": [{"date": "YYYY-MM-DD", "event": "..."}]}`).join(", ")}},
 "plans": {"income": {"size_pct": 0, "entry": "when or at what level to buy", "hedge": "how to hedge, if at all", "review": "when to revisit"}, "conservative": {...}, "growth": {...}, "aggressive": {...}},
 "change_mind": ["what would change the view, with a level or a date"],
 "debates": [{"id": "DB1", "side": "bull | bear | split", "why": "one or two sentences: which side the fund is on at its weights and holdings, cited"}],
 ${READ(PANELS.calls)}}
Probabilities add to 100. One debates entry for EVERY debate DB listed. No price targets or % ranges: the colleague making the 1M-12M calls gives the direction; you give what drives each window and what lands in it.`,
    markets: `{"returns": {"summary": "3-4 sentences: how the fund has done over every period against its benchmark and SPY, and why (which industries and holdings drove the gap), cited"},
 "risk_profile": {"level": "low | moderate | high", "summary": "3-4 sentences: what kind of ride this fund is (beta, volatility, drawdowns, capture, crises), whether it's changing, and who that suits", "worst_case": "one sentence: a realistic bad stretch, from its own history, with a number"},
 "street": {"summary": "2-3 sentences: what Wall Street's ratings and targets on its biggest holdings say for the fund, and how much to trust them"},
 "season": {"summary": "2-3 sentences: what this earnings season has shown so far for the fund and what the next reports must show"},
 ${READ(PANELS.markets)}}`,
    context: `{"drivers": [{"driver": "what drives the fund over 12 months", "effect": "helps | hurts | mixed", "why": "2 sentences, cited", "ids": ["I1"]}],
 "industries": [{"id": "I1", "effect": "helps | hurts | mixed", "why": "one sentence: what this industry's analysis means for the fund at its weight"}],
 "macro": {"regime": "supportive | mixed | headwind", "headline": "one sentence on the macro for this fund", "horizons": {${HZ.map((h) => `"${h}": {"call": "supportive | mixed | headwind", "why": "1-2 sentences"}`).join(", ")}}, "flip": "what would flip it, with levels",
   "factors": [{"id": "MF1", "effect": "tailwind | headwind | neutral", "why": "one sentence: what this sensitivity means for the fund now"}]},
 "cycle": {"phase": "early | mid | late | downturn | mixed", "summary": "2-3 sentences: where the fund's industries are in their cycles, weighted, and what that means for the next 12 months (cite CY)", "kpis_watch": ["the KPI or dated KPI event to watch, with IDs"]},
 ${READ(PANELS.context)}}
Sizes: 4-7 drivers; one entry for EVERY industry I and every factor MF listed.`,
    world: `{"macro_overall": {"regime": "supportive | mixed | headwind", "summary": "4-5 sentences: what the macro table says for this fund now (which indicators matter most at its weights, which way they point, where its industries disagree)", "most_important": "the one indicator that matters most for the fund now, with its level and why",
   "pain": "4-5 sentences: how the fund suffers if the macro turns: the shock that hurts most (cite ST and the measured sensitivities), how much, which industries and holdings take it, what cushions it, and how likely it looks from the macro table now",
   "channels": {"demand": "how the macro reaches the fund's revenue, 2 sentences", "cost": "...costs and margins", "capital": "...valuation and financing", "regulatory": "...policy"}},
 "indicators": [{"id": "MI1", "effect": "tailwind | headwind | neutral", "relevance": "high | medium | low", "vs_industries": "same | stronger | weaker | opposite", "why": "2 sentences: what this reading means for the fund at its industries' weights, with the number, cited", "hit": "one sentence: what a bad move in it would do to the fund, with the size where the stress test gives one"}],
 "world_overall": {"summary": "4 sentences: the world events that matter most for this fund, how they reach it and how much of it", "biggest": "the single situation that matters most and why", "watch": ["what to watch, with IDs"]},
 "world": [{"id": "WS1", "effect": "helps | hurts | mixed | none", "magnitude": "high | medium | low", "vs_industries": "same | stronger | weaker | opposite", "channel": "how it reaches the fund: which industries and holdings, through which channel", "scenario": "the scenario that matters most for the fund and what it would do to it", "watch": "the signal to watch", "why": "2 sentences with the size, cited"}],
 ${READ(PANELS.world)}}
Sizes: one entry for EVERY indicator MI and every situation WS listed. Size every "hit" and the "pain" from the stress test and the measured sensitivities; never invent a number. "vs_industries": whether the fund feels it the same as its industries' reports say, more, less, or the other way (holdings, weights).`,
    exposures: `{"trade_overall": {"risk": "low | moderate | high", "summary": "4 sentences: what its industries' trade maps and verdicts mean for this fund, where its revenue is and which countries carry the risk", "biggest": "the single country or risk that matters most, and why", "watch": ["what to watch, with IDs"]},
 "trade": [{"id": "TC1", "exposure": "high | medium | low", "effect": "helps | hurts | mixed | none", "channel": "how it reaches the fund: revenue, inputs, manufacturing, which holdings", "risk": "the risk that matters for the fund there", "freeze": "what a trade freeze would do to the fund", "why": "2 sentences with a size, cited"}],
 "reg_overall": {"stance": "tailwind | headwind | mixed", "summary": "4 sentences: the net regulatory and legal picture for the fund across its industries' rule books and verdicts", "biggest": "the single most material rule, with how much of the fund it reaches", "timeline": [{"date": "YYYY-MM-DD or YYYY-MM", "event": "a dated regulatory or legal step ahead", "why": "what it means for the fund"}], "watch": ["what to watch, with IDs"]},
 "regulation": [{"id": "RL1", "effect": "helps | hurts | mixed", "materiality": "high | medium | low", "link": "which of its industries or holdings it runs through", "cost": "how big, with a number where the rule book gives one", "timing": "when it bites", "why": "2 sentences, cited"}],
 "items": [{"id": "LI1", "effect": "helps | hurts | mixed", "materiality": "high | medium | low", "next": "the next step and its date", "why": "1-2 sentences, cited"}],
 "outside": [{"id": "O1", "matters": "high | medium | low", "why": "one sentence: what this holding means for the fund and what the analysis misses by not covering it"}],
 ${READ(PANELS.exposures)}}
Sizes: one entry for EVERY country TC, rule RL, item LI and outside holding O listed.`,
  };
  /** The industry report reads each fund panel sits next to (the keys of each digest's "reads"). */
  const PANEL_IND = { macro_ind: [], active: [], score: ["fit"], cycle: ["cycle"], season: ["calls", "earn"], debates: [], holdings: ["fit"], industries: ["cycle"], valuation: ["val"], fundamentals: ["fund", "health", "earn"], income: ["div"], perf: ["perf"], risk: ["risk"], calendar: ["calls"],
    times: [], stress: ["stress"], sens: [], look: ["fit"], tech: ["tech"], street: ["street"], news: ["news"], dist: ["div"], trade: ["trade"], regulation: ["reg"], world: ["world"] };
  const IND_READ_LABEL = { fit: "fit by investor type", cycle: "the cycle", val: "valuation", fund: "fundamentals", health: "financial health", earn: "earnings", div: "income", perf: "performance", risk: "risk",
    calls: "earnings calls", stress: "drawdowns and base rates", macro: "macro", tech: "trend and positioning", street: "the street", news: "news flow", trade: "trade", reg: "regulation", world: "world events" };
  /** What the fund's biggest industries' reports say on one topic: [{industry, weight, text}], biggest first. */
  function indReads(cov, digests, key, k = 3) {
    const out = [];
    for (const g of cov?.industries || []) { const t = digests?.[lc(g.industry)]?.reads?.[key]; if (t) out.push({ industry: g.industry, weight: g.weight, kind: digests[lc(g.industry)].kind, text: t }); if (out.length >= k) break; }
    return out;
  }
  /** The industries' reads for one analyst's panels, as a prompt block. */
  function indReadsBlock(fd, part) {
    const keys = [...new Set(Object.keys(PANELS[part] || {}).flatMap((p) => PANEL_IND[p] || []))]; if (!keys.length) return "";
    const lines = keys.map((k) => { const r = indReads(fd.cov, fd.digests, k, 2); return r.length ? `${IND_READ_LABEL[k]}: ${r.map((x) => `${x.industry} (${pc(x.weight)} of the fund): ${trim(x.text, 220)}`).join(" | ")}` : ""; }).filter(Boolean);
    return lines.length ? `## WHAT ITS BIGGEST INDUSTRIES' OWN REPORTS SAY, PANEL BY PANEL (set your reads against these)\n${lines.join("\n")}` : "";
  }
  const BLOCKS = { core: ["base", "score", "hold", "val", "tech"], calls: ["base", "score", "perf", "val", "cal", "deb", "tech"], markets: ["base", "score", "hold", "perf", "cal", "tech"], context: ["base", "perf", "ind", "cyc", "tech"], world: ["base", "aff_macro", "aff_world"], exposures: ["base", "hold", "aff_trade", "aff_reg"] };
  const INTRO = {
    core: "You write part one of a six-part analysis of this fund; colleagues write the calls, the context and the exposures at the same time. Write ONLY: the verdict, the thesis, the benchmark view, strategy, valuation, quality, the peer view, risks, catalysts, watch, fit and your panel reads.",
    markets: "You write the markets part of a six-part analysis: the fund's returns, its risk profile and how it behaves in crises, its trend, Wall Street's view of its holdings, the news, the distributions and the earnings season, and your panel reads. Colleagues write the rest at the same time.",
    calls: "You write part two of a six-part analysis: the 12-month scenarios, what drives each window, the plans per investor type, which side of each industry debate the fund is on and your panel reads. Colleagues write the rest at the same time.",
    context: "You write part three of a six-part analysis: what drives the fund, each industry row, the macro (with the fund's own measured sensitivities), each world event, its industries' cycle, and your panel reads. Colleagues write the rest at the same time.",
    world: "You write the macro and world-events part of a six-part analysis, the way the company page reads its industry's report: for this fund, every indicator its industries' macro reports read and every world situation their world-events reports follow, row by row, with the overall read of each, and your panel reads. Colleagues write the rest at the same time.",
    exposures: "You write the trade and regulation part of a six-part analysis, the way the company page reads its industry's report: for this fund, every country on its industries' trade maps, every rule in their rule books and every policy, litigation and deal item, row by row, with the overall read of each, the holdings the analysis can't see, and your panel reads. Colleagues write the rest at the same time.",
  };
  /** The prompt for one part ("core" | "calls" | "context" | "exposures"). dz: dossier(). */
  function partPrompt(fd, dz, part, today) {
    return `You are a fund analyst on an investment research team. Today is ${today}. The team has analyzed US industries one at a time (each with a lead strategist's 1M-12M calls, scenarios, macro, world-events, trade and regulation reports), and code has mapped this fund's holdings onto those industries and weighted every figure by the fund's weights. ${INTRO[part]}

Rules:
- Use only the facts and numbers below. Don't invent figures, holdings, events or dates; every number you use must appear below.
- Cite the lines you rely on with their IDs in square brackets, e.g. [I1][H3][P2]. Every claim needs at least one ID.
- Plain, direct sentences. Say what the fund is betting on and what that means for an owner.
- Write like a senior analyst who has read everything below: specific, numerate and opinionated. Every read makes a judgment and backs it with the figures; no filler, no restating a table without saying what it means.
- Be honest about coverage: private companies, foreign listings and code-only industries limit how sure you can be.

${BLOCKS[part].map((b) => dz.blocks[b]).filter(Boolean).join("\n\n")}

${indReadsBlock(fd, part)}

Reply with ONLY this JSON:
${SCHEMA[part]}`;
  }
  /**
   * The outlook prompt: the company page's (one call on the finished write-up, the industries' outlooks, the fund's
   * numbers, each window's facts and code's starting point), with the fund's sixteen components and the same rules.
   */
  function outlookPrompt(fd, dz, today, write) {
    const t = write || {}, c = t.core || {}, k = t.calls || {}, x = t.context || {}, e = t.exposures || {}, sym = fd.sym, name = fd.facts?.name || sym;
    const w = [c.headline ? `Headline: ${trim(c.headline, 260)}` : "", c.verdict?.call ? `Verdict: ${c.verdict.call}: ${trim(c.verdict.summary, 500)}` : "", c.thesis ? `Thesis: ${trim(c.thesis, 1500)}` : "",
      c.vs_benchmark?.call ? `Vs ${fd.bench?.symbol}: ${c.vs_benchmark.call}: ${trim(c.vs_benchmark.why, 300)}` : "", c.valuation?.read ? `Valuation: ${trim(c.valuation.read, 400)}` : "", c.street?.summary ? `Vs Wall Street: ${c.street.stance || ""}: ${trim(c.street.summary, 360)}` : "",
      c.quality ? `Quality: ${trim(c.quality, 260)}` : "", t.markets?.returns?.summary ? `Returns: ${trim(t.markets.returns.summary, 300)}` : "", t.markets?.risk_profile?.summary ? `Risk profile (${t.markets.risk_profile.level || "?"}): ${trim(t.markets.risk_profile.summary, 300)}` : "", t.markets?.season?.summary ? `Earnings season: ${trim(t.markets.season.summary, 260)}` : "", c.strategy ? `How it's run: ${trim(c.strategy, 260)}` : "",
      ["bull", "base", "bear"].some((q) => k.scenarios?.[q]) ? `Scenarios (12M): ${["bull", "base", "bear"].filter((q) => k.scenarios?.[q]).map((q) => `${q} ${k.scenarios[q].probability ?? "?"}%: ${trim(k.scenarios[q].narrative, 160)}`).join("; ")}` : "",
      ...HZ.filter((h) => k.horizons?.[h]?.drivers).map((h) => `${h} drivers: ${trim(k.horizons[h].drivers, 260)}`),
      (c.risks || []).length ? `Risks: ${c.risks.slice(0, 5).map((r) => trim(r.risk, 120)).join("; ")}` : "", (c.catalysts || []).length ? `Catalysts: ${c.catalysts.slice(0, 5).map((y) => `${y.date} ${trim(y.event, 100)}`).join("; ")}` : "",
      x.macro?.headline ? `Macro for it: ${x.macro.regime || ""}: ${trim(x.macro.headline, 240)}` : "", t.world?.macro_overall?.summary ? `Its industries' macro, weighted: ${t.world.macro_overall.regime || ""}: ${trim(t.world.macro_overall.summary, 360)}` : "", t.world?.world_overall?.summary ? `World events for it: ${trim(t.world.world_overall.summary, 360)}` : "", x.cycle?.summary ? `Its industries' cycle: ${x.cycle.phase || ""}: ${trim(x.cycle.summary, 300)}` : "",
      (k.debates || []).length ? `Debates: ${k.debates.map((d) => `${d.id} ${d.side}`).join(", ")}` : "", c.peers?.summary ? `Against its peers: ${c.peers.stance || ""}: ${trim(c.peers.summary, 260)}` : "", e.trade_overall?.summary ? `Trade for it: ${trim(e.trade_overall.summary, 300)}` : "", e.reg_overall?.summary ? `Regulation for it: ${trim(e.reg_overall.summary, 300)}` : ""].filter(Boolean).join("\n");
    const inds = (fd.cov?.industries || []).slice(0, 14).map((g) => { const ic = indCalls(fd.digests?.[lc(g.industry)]); return Object.keys(ic).length ? `${g.industry} (${pc(g.weight)} of the fund): ${HZ.filter((h) => ic[h]).map((h) => `${h} ${ic[h]}`).join(", ")}` : `${g.industry} (${pc(g.weight)}): no outlook (${g.status === "quant" ? "code-only" : "not covered"})`; }).join("\n");
    const W = windows(fd, today), pr = prior(fd);
    return `You are the analyst covering the fund ${name} (${sym}). Today is ${today}. The fund holds US industries your team has analyzed one by one; each has its own outlook. Use ALL of the work below to say WHERE ${sym} IS GOING over the next month, 3 months, 6 months and 12 months, and why.

## ITS INDUSTRIES' OUTLOOKS (biggest first)
${inds || "(none)"}

${w ? `## THE FUND WRITE-UP\n${w}\n` : ""}
## ${sym}: THE FUND, ITS HOLDINGS AND ITS NUMBERS (code)
${trim([dz.blocks.base, dz.blocks.score, dz.blocks.hold, dz.blocks.perf, dz.blocks.val, dz.blocks.cyc, dz.blocks.tech].filter(Boolean).join("\n\n"), 26000)}

## EACH WINDOW (code)
${W.map((y) => `${y.h}: to ${y.end}; a normal move is ±${y.sigma ?? "?"}%; trailing ${y.h} ${y.trailing ?? "?"}%${y.vs_bench !== null ? ` (${y.vs_bench > 0 ? "+" : ""}${y.vs_bench} vs ${fd.bench?.symbol})` : ""}; in its own history higher ${y.base_up ?? "?"}% of the time over this span; ${y.reporting.length ? `holdings reporting: ${y.reporting.map((r) => `${r.symbol} ${r.date} (${r.weight}%)`).join(", ")}` : "no big holding reports in the window"}`).join("\n")}
${pr ? `\n## CODE'S STARTING POINT FOR EACH WINDOW\nIts industries' outlooks weighted by the fund, moved by its own setups like today, Wall Street on its holdings and an overbought or oversold month:\n${priorText(pr)}` : ""}
${(fd.news || []).length ? `\n## RECENT NEWS ON ITS BIGGEST HOLDINGS\n${fd.news.slice(0, 12).map((y) => `${y.date} ${y.symbol ? y.symbol + ": " : ""}${trim(y.title, 150)}`).join("\n")}` : ""}

HOW TO MAKE THE CALLS
- Each call is ${sym}'S OWN DIRECTION: will it be higher or lower at the end of the window? Nothing else.
- Six levels, no neutral. "slightly": a close call that tips one way. Plain "bullish" / "bearish": the evidence clearly points that way. "strongly": most components point the same way, decisively; rare. If it's close, pick the side it tips toward and say "slightly".
- First weigh EVERY component, one entry each, in this order: ${FUND_INPUTS.map(([q]) => q).join(", ")}. For each: does it push ${sym} up or down over the next year ("up" / "down" / "mixed"), how much it matters (weight 1 = minor, 2 = material, 3 = decisive), and why in one sentence with the number. Nothing to go on: "mixed", weight 1.
- Then the four calls, from that evidence. Near-term windows lean on momentum, positioning, macro and dated events; longer ones on earnings, the cycle, valuation and the scenarios. A call that flips direction from one window to the next must say what changes in between.
- For each call, put the strongest case against it in "against" and say why it loses. Square the calls with Times like this (the past months its industries' runs found most like today [HE#], what followed, and the weighted base rates); where you go against them, say why.
- Start from its industries' outlooks, then say where ${sym} departs from them and why.${pr ? `
- Each window starts at code's starting point above. Keep it unless the evidence gives a concrete reason to move; when your call differs from the starting point, the window's "why" must say in one clause what moves it off (for example "one notch more bearish than the starting point because ...").` : ""}
- Plain words, specific numbers, no hedging filler. No price targets or % ranges.

Reply with ONLY this JSON (all four windows):
${O.schemaFor(FUND_INPUTS).replace("the lead's verdict", "the fund write-up's verdict")}`;
  }
  /** The outlook's answer, cleaned and checked by the company page's code (the same levels, tally and checks). */
  const cleanOutlook = (raw, today) => O.clean(raw, { today, inputs: FUND_INPUTS });

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
    // A read is {text, points, means, watch}; older answers (and a plain string) keep just the text.
    const reads = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => { if (typeof v === "string") return [k, t(v, 900) ? { text: t(v, 900), points: [], means: "", watch: "" } : null];
      const x = { text: t(v?.text ?? v?.read, 1600), points: (Array.isArray(v?.points) ? v.points : []).map((y) => t(typeof y === "string" ? y : y?.text, 300)).filter(Boolean).slice(0, 7), means: t(v?.means, 500), watch: t(v?.watch, 260) };
      return [k, x.text || x.points.length ? x : null]; }).filter(([, v]) => v));
    return { t, ids, en, rng, rows, rowId, reads, dropped: () => dropped };
  }
  /** One part's answer, cleaned: only IDs the dossier has, known enums, ranges low to high (the fit's points come from the fit word). */
  function cleanPart(part, o, idx) {
    const C = cleaner(idx), { t, ids, en, rng, rows, rowId, reads } = C; o = o || {};
    let w = {};
    if (part === "core") {
      const fit = {}; for (const k of ["income", "conservative", "growth", "aggressive"]) { const x = o.fit?.[k] || {};
        fit[k] = { fit: en(x.fit, ENUM.fit), conviction: en(x.conviction, ENUM.lvl), why: t(x.why, 400), watch: t(x.watch, 200), what_changes: t(x.what_changes, 240) }; }
      w = { headline: t(o.headline, 300), verdict: { call: en(o.verdict?.call, ENUM.verdict), summary: t(o.verdict?.summary, 600) }, thesis: t(o.thesis, 3000),
        vs_benchmark: { call: en(o.vs_benchmark?.call, ENUM.vs), why: t(o.vs_benchmark?.why, 600) }, strategy: t(o.strategy, 600), valuation: { read: t(o.valuation?.read, 600) }, quality: t(o.quality, 400), street: o.street ? { stance: en(o.street.stance, ["agree", "more bullish", "more bearish"]), summary: t(o.street.summary, 600) } : null,
        holdings_notes: rows(o.holdings_notes, (x) => ({ id: rowId(x), bet: t(x?.bet, 120), view: t(x?.view, 500), stance: en(x?.stance, ["tailwind", "neutral", "headwind"]) }), "id").slice(0, 12),
        peers: o.peers ? { stance: en(o.peers.stance, ["best in group", "competitive", "lagging"]), summary: t(o.peers.summary, 500) } : null,
        risks: rows(o.risks, (x) => ({ risk: t(x?.risk, 300), likelihood: en(x?.likelihood, ENUM.lvl), impact: en(x?.impact, ENUM.lvl), ids: ids(x?.ids) }), "risk").slice(0, 8),
        catalysts: rows(o.catalysts, (x) => ({ date: String(x?.date || "").slice(0, 10), event: t(x?.event, 200), why: t(x?.why, 300), ids: ids(x?.ids) }), "event").slice(0, 8),
        watch: (Array.isArray(o.watch) ? o.watch : []).map((x) => t(typeof x === "string" ? x : x?.text, 300)).filter(Boolean).slice(0, 6), fit, reads: reads(o.reads), confidence: en(o.confidence, ENUM.lvl) };
    } else if (part === "calls") {
      const scen = {}; for (const k of ["bull", "base", "bear"]) { const x = o.scenarios?.[k]; if (x) scen[k] = { probability: n(x.probability), narrative: t(x.narrative, 600), triggers: (Array.isArray(x.triggers) ? x.triggers : []).map((y) => t(y, 200)).filter(Boolean).slice(0, 4) }; }
      const hz = {}; for (const h of HZ) { const x = o.horizons?.[h]; if (!x) continue; hz[h] = { vs_benchmark: en(x.vs_benchmark, ENUM.vs), drivers: t(x.drivers, 1400), decisions: rows(x.decisions, (d) => ({ date: String(d?.date || "").slice(0, 10), event: t(d?.event, 200) }), "event").slice(0, 6) }; }
      const plans = {}; for (const k of ["income", "conservative", "growth", "aggressive"]) { const x = o.plans?.[k]; if (x) plans[k] = { size_pct: n(x.size_pct), entry: t(x.entry, 240), hedge: t(x.hedge, 240), review: t(x.review, 200) }; }
      const debates = rows(o.debates, (x) => ({ id: rowId(x), side: en(x?.side, ["bull", "bear", "split"]), why: t(x?.why, 500) }), "id");
      w = { scenarios: scen, horizons: hz, plans, debates, change_mind: (Array.isArray(o.change_mind) ? o.change_mind : []).map((x) => t(x, 300)).filter(Boolean).slice(0, 6), reads: reads(o.reads) };
    } else if (part === "markets") {
      const sm = (x, k = 900) => (x?.summary ? { summary: t(x.summary, k) } : null);
      w = { returns: sm(o.returns), risk_profile: o.risk_profile ? { level: en(o.risk_profile.level, ["low", "moderate", "high"]), summary: t(o.risk_profile.summary, 900), worst_case: t(o.risk_profile.worst_case, 300) } : null,
        street: sm(o.street, 700), season: sm(o.season, 700), reads: reads(o.reads) };
    } else if (part === "context") {
      w = { drivers: rows(o.drivers, (x) => ({ driver: t(x?.driver, 200), effect: en(x?.effect, ENUM.eff), why: t(x?.why, 500), ids: ids(x?.ids) }), "driver").slice(0, 8),
        industries: rows(o.industries, (x) => ({ id: rowId(x), effect: en(x?.effect, ENUM.eff), why: t(x?.why, 400) }), "id"),
        macro: o.macro ? { regime: en(o.macro.regime, ENUM.macro), headline: t(o.macro.headline, 300), flip: t(o.macro.flip, 300),
          horizons: Object.fromEntries(HZ.map((h) => [h, o.macro.horizons?.[h] ? { call: en(o.macro.horizons[h].call, ENUM.macro), why: t(o.macro.horizons[h].why, 300) } : null]).filter(([, v]) => v)),
          factors: rows(o.macro.factors, (x) => ({ id: rowId(x), effect: en(x?.effect, ENUM.fac), why: t(x?.why, 300) }), "id") } : null,
        world: rows(o.world, (x) => ({ id: rowId(x), effect: en(x?.effect, ENUM.eff), magnitude: en(x?.magnitude, ENUM.lvl), why: t(x?.why, 400) }), "id"),
        cycle: o.cycle ? { phase: en(o.cycle.phase, ["early", "mid", "late", "downturn", "mixed"]), summary: t(o.cycle.summary, 700), kpis_watch: (Array.isArray(o.cycle.kpis_watch) ? o.cycle.kpis_watch : []).map((y) => t(y, 240)).filter(Boolean).slice(0, 5) } : null, reads: reads(o.reads) };
    } else if (part === "world") {
      const VS = ["same", "stronger", "weaker", "opposite"], wl = (a) => (Array.isArray(a) ? a : []).map((y) => t(y, 240)).filter(Boolean).slice(0, 5);
      const chn = (c) => Object.fromEntries(["demand", "cost", "capital", "regulatory"].map((k) => [k, t(c?.[k], 400)]).filter(([, v]) => v));
      w = { macro_overall: o.macro_overall ? { regime: en(o.macro_overall.regime, ENUM.macro), summary: t(o.macro_overall.summary, 1000), most_important: t(o.macro_overall.most_important, 400), pain: t(o.macro_overall.pain, 1100), channels: chn(o.macro_overall.channels) } : null,
        indicators: rows(o.indicators, (x) => ({ id: rowId(x), effect: en(x?.effect, ENUM.fac), relevance: en(x?.relevance, ENUM.lvl), vs_industries: en(x?.vs_industries, VS), why: t(x?.why, 500), hit: t(x?.hit, 300) }), "id"),
        world_overall: o.world_overall ? { summary: t(o.world_overall.summary, 1000), biggest: t(o.world_overall.biggest, 400), watch: wl(o.world_overall.watch) } : null,
        world: rows(o.world, (x) => ({ id: rowId(x), effect: en(x?.effect, ENUM.eff), magnitude: en(x?.magnitude, ENUM.lvl), vs_industries: en(x?.vs_industries, VS), channel: t(x?.channel, 300), scenario: t(x?.scenario, 300), watch: t(x?.watch, 200), why: t(x?.why, 500) }), "id"), reads: reads(o.reads) };
    } else if (part === "exposures") {
      const wl = (a) => (Array.isArray(a) ? a : []).map((y) => t(y, 240)).filter(Boolean).slice(0, 5);
      w = { trade_overall: o.trade_overall ? { risk: en(o.trade_overall.risk, ENUM.risk), summary: t(o.trade_overall.summary, 900), biggest: t(o.trade_overall.biggest, 300), watch: wl(o.trade_overall.watch) } : null,
        trade: rows(o.trade, (x) => ({ id: rowId(x), exposure: en(x?.exposure, ENUM.lvl), effect: en(x?.effect, ENUM.eff), channel: t(x?.channel, 300), risk: t(x?.risk, 300), freeze: t(x?.freeze, 300), why: t(x?.why, 500) }), "id"),
        reg_overall: o.reg_overall ? { stance: en(o.reg_overall.stance, ENUM.stance), summary: t(o.reg_overall.summary, 900), biggest: t(o.reg_overall.biggest, 300), watch: wl(o.reg_overall.watch),
          timeline: rows(o.reg_overall.timeline, (x) => ({ date: String(x?.date || "").slice(0, 10), event: t(x?.event, 200), why: t(x?.why, 240) }), "event").slice(0, 8) } : null,
        regulation: rows(o.regulation, (x) => ({ id: rowId(x), effect: en(x?.effect, ENUM.eff), materiality: en(x?.materiality, ENUM.lvl), link: t(x?.link, 200), cost: t(x?.cost, 240), timing: t(x?.timing, 160), why: t(x?.why, 500) }), "id"),
        items: rows(o.items, (x) => ({ id: rowId(x), effect: en(x?.effect, ENUM.eff), materiality: en(x?.materiality, ENUM.lvl), next: t(x?.next, 200), why: t(x?.why, 400) }), "id"),
        outside: rows(o.outside, (x) => ({ id: rowId(x), matters: en(x?.matters, ENUM.lvl), why: t(x?.why, 400) }), "id"), reads: reads(o.reads) };
    }
    return { w, dropped: C.dropped() };
  }
  /** Checks on the write-up's calls part: the scenario probabilities add to 100 (the six-level calls have the outlook's own checks). */
  function checks(a) {
    const issues = [], S = a.scenarios || {};
    const ps = ["bull", "base", "bear"].map((k) => n(S[k]?.probability)), sum = ps.reduce((x, y) => x + (isNum(y) ? y : 0), 0);
    if (ps.every(isNum) && Math.abs(sum - 100) > 2) issues.push(`the scenario probabilities add to ${sum}%, not 100%`);
    return { issues };
  }
  /** Why the saved analysis is out of date: the step-3 rules, on the step-3 fingerprint. */
  const changes = (a, b) => P.changes(a, b);

  const FundAn = { PANEL_IND, IND_READ_LABEL, indReads, indReadsBlock, FUND_INPUTS, windows, prior, priorText, indCalls, outlookPrompt, cleanOutlook, provisional, streetLook, sentimentLook, holdings, concentration, extras, calendar, dossier, partPrompt, cleanPart, checks, changes, PANELS, PARTS: ["core", "calls", "markets", "context", "world", "exposures"], CALLV };
  if (typeof module !== "undefined" && module.exports) module.exports = FundAn;
  else root.FundAn = FundAn;
})(typeof window !== "undefined" ? window : globalThis);
