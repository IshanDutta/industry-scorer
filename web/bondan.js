/* Industry Scorer: the analysis of a bond fund (an ETF or mutual fund that holds bonds, not stocks).
 *
 * Code only (no I/O). A stock fund is read through the industries it holds; a bond fund is read through what moves
 * bond prices: its yield and how long its money is tied up (duration), the Treasury curve, credit spreads, inflation,
 * and the Fed. The page hands in the fund's facts (FMP and EODHD), the Treasury curve now and over the past year,
 * the HQM corporate curve (an investment-grade spread proxy), the industry runs' rate and inflation indicators and
 * their macro analysts' reads, the runs' 12-month calls on the sectors a corporate fund lends to, and the fund's own
 * price history and measured sensitivities. Code does the arithmetic (carry, spread, breakeven, rate and spread
 * shocks, the scenario returns); one strategist writes the case and the 1M-12M calls on an ID'd dossier, and code
 * cleans what comes back and prices the strategist's scenarios itself.
 */
(function (root) {
  "use strict";
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const n = (x) => (x === null || x === undefined || x === "" ? NaN : Number(x));
  const lc = (s) => String(s || "").toLowerCase();
  const trim = (s, k) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > k ? s.slice(0, k - 1) + "…" : s; };
  const f1 = (v, d = 1) => (isNum(v) ? Number(v).toFixed(d) : "n/a");
  const pp = (v, d = 2) => (isNum(v) ? Number(v).toFixed(d) + "%" : "n/a");
  const sgn = (v, d = 1) => (isNum(v) ? (v > 0 ? "+" : "") + Number(v).toFixed(d) + "%" : "n/a");
  const bp = (v) => (isNum(v) ? (v > 0 ? "+" : "") + Math.round(v) + "bp" : "n/a");

  const HZ = ["1M", "3M", "6M", "12M"], MONTHS = { "1M": 1, "3M": 3, "6M": 6, "12M": 12 };
  const LEVELS = ["strongly bearish", "bearish", "slightly bearish", "slightly bullish", "bullish", "strongly bullish"];
  const SIGN = { "strongly bearish": -3, bearish: -2, "slightly bearish": -1, "slightly bullish": 1, bullish: 2, "strongly bullish": 3 };
  const VERDICTS = ["attractive", "fair", "unattractive"];

  // ============================================================= what it is
  /** A bond fund: FMP says Fixed Income, or EODHD puts 70%+ of its assets in bonds, or its category says bonds. */
  function isBond(raw) {
    const info = (raw?.info || [])[0] || {}, etf = raw?.eod?.ETF_Data || {}, aa = etf.Asset_Allocation || raw?.eod?.Asset_Allocation || {};
    const bondPct = n(aa?.Bond?.["Net_Assets_%"]), stockPct = n(aa?.["Stock US"]?.["Net_Assets_%"]) + (n(aa?.["Stock non-US"]?.["Net_Assets_%"]) || 0);
    if (isNum(bondPct) && bondPct >= 70) return true;
    if (isNum(stockPct) && stockPct >= 30) return false;
    if (/fixed income/i.test(info.assetClass || "")) return true;
    return /\b(bond|treasur|fixed income|municipal|tips|mortgage-backed|high yield)\b/i.test(`${raw?.eod?.General?.Category || ""}`);
  }
  const KINDS = {
    treasury_short: "short-term Treasuries", treasury_mid: "intermediate Treasuries", treasury_long: "long-term Treasuries", tips: "inflation-protected Treasuries (TIPS)",
    corp_ig: "investment-grade corporate bonds", high_yield: "high-yield (junk) corporate bonds", mbs: "mortgage-backed securities", muni: "municipal bonds",
    aggregate: "the broad US bond market", em: "emerging-market bonds", intl: "international bonds", floating: "floating-rate notes and loans", other: "bonds",
  };
  /** Its kind, from the name, the category and the duration. */
  function kindOf(name, category, duration) {
    const s = lc(`${name} ${category}`), d = n(duration);
    if (/high yield|junk|high-yield/.test(s)) return "high_yield";
    if (/tips|inflation[- ]protected|inflation[- ]linked/.test(s)) return "tips";
    if (/muni|municipal|tax[- ]exempt/.test(s)) return "muni";
    if (/emerging/.test(s)) return "em";
    if (/floating|float rate|senior loan|bank loan|leveraged loan/.test(s)) return "floating";
    if (/mortgage|mbs|securitized/.test(s)) return "mbs";
    if (/international|global|world|ex[- ]us/.test(s)) return "intl";
    if (/corporate|credit/.test(s)) return "corp_ig";
    if (/aggregate|total bond|core bond|universal|core plus|broad/.test(s)) return "aggregate";
    if (/treasur|government|govt|t-bill|bill/.test(s)) return !isNum(d) ? "treasury_mid" : d < 3 ? "treasury_short" : d >= 10 ? "treasury_long" : "treasury_mid";
    return "other";
  }
  const isCredit = (k) => ["corp_ig", "high_yield", "em", "floating", "aggregate", "mbs", "muni", "other"].includes(k);
  /** Issuer sectors (FMP's bond sector names) mapped to the industry runs' sectors. */
  const SECTOR_MAP = [[/consumer cyclical|automotive|retail|gaming|lodging|leisure|home ?build/i, "Consumer Cyclical"], [/consumer non-cyclical|food|beverage|tobacco|supermarket|consumer products/i, "Consumer Defensive"],
    [/communication|media|cable|telecom|wireless|wireline/i, "Communication Services"], [/technology|software|semiconductor/i, "Technology"], [/energy|oil|gas|midstream|pipeline/i, "Energy"],
    [/capital goods|aerospace|defen[cs]e|building materials|diversified manufacturing|industrial|transportation|airline|railroad|construction machinery|packaging/i, "Industrials"],
    [/health|pharma|biotech|hospital/i, "Healthcare"], [/basic industry|chemical|metal|mining|paper|steel/i, "Basic Materials"],
    [/electric|utilit|natural gas distribution|water/i, "Utilities"], [/reit|real estate/i, "Real Estate"],
    [/bank|insurance|finance|financial|brokerage|asset manager|exchange|life|p&c/i, "Financial Services"]];
  const sectorOf = (name) => { for (const [re, s] of SECTOR_MAP) if (re.test(name || "")) return s; return null; };

  /** The fund's facts: what it holds, its yield, duration, maturity, coupon, cost, size and issuer sectors. */
  function profile(raw) {
    const info = (raw?.info || [])[0] || {}, eod = raw?.eod || {}, etf = eod.ETF_Data || {}, fi = etf.Fixed_Income || {}, aa = etf.Asset_Allocation || eod.Asset_Allocation || {};
    const v = (k) => { const x = n(fi?.[k]?.["Fund_%"]); return isNum(x) && x !== 0 ? x : NaN; };
    const name = info.name || eod.General?.Name || raw?.sym || "", category = eod.General?.Category || info.assetClass || "";
    const duration = isNum(v("EffectiveDuration")) ? v("EffectiveDuration") : v("ModifiedDuration");
    const expense = isNum(n(info.expenseRatio)) ? n(info.expenseRatio) / 100 : n(etf.NetExpenseRatio);
    const sectors = (info.sectorsList || []).map((x) => ({ name: String(x.industry || ""), w: n(x.exposure) / 100 })).filter((x) => x.name && x.w > 0).sort((a, b) => b.w - a.w);
    const holds = (raw?.holdings || []).slice().sort((a, b) => (n(b.weight) || 0) - (n(a.weight) || 0));
    const issuers = []; const seen = new Map();
    for (const h of holds) { const nm = String(h.name || h.asset || "").replace(/\s+\d+(\.\d+)?\s?%.*$/, "").replace(/\s+(\d{1,2}\/\d{1,2}\/\d{2,4}|due .*)$/i, "").trim(); if (!nm) continue;
      const k = lc(nm); seen.set(k, (seen.get(k) || 0) + (n(h.weight) || 0)); if (!issuers.some((x) => lc(x.name) === k)) issuers.push({ name: nm }); }
    const top = issuers.map((x) => ({ name: x.name, w: seen.get(lc(x.name)) * 100 })) // holdings come as fractions (Portfolio.fromFmp); kept here in %.filter((x) => x.w > 0).sort((a, b) => b.w - a.w).slice(0, 12);
    const perf = etf.Performance || {};
    return { sym: raw?.sym, name, category, kind: kindOf(name, category, duration), duration, modDuration: v("ModifiedDuration"), maturity: v("EffectiveMaturity"), ytm: v("YieldToMaturity"),
      coupon: v("Coupon"), avgPrice: v("Price"), distYield: n(etf.Yield ?? eod.Yield), expense: isNum(expense) ? expense : NaN, aum: n(info.assetsUnderManagement ?? etf.TotalAssets),
      inception: info.inceptionDate || etf.Inception_Date || null, count: n(info.holdingsCount) || holds.length || null, turnover: n(etf.AnnualHoldingsTurnover),
      bondPct: n(aa?.Bond?.["Net_Assets_%"]), cashPct: n(aa?.Cash?.["Net_Assets_%"]), sectors, top, description: trim(eod.General?.Description || info.description || "", 600),
      perf: { vol1: n(perf["1y_Volatility"]), vol3: n(perf["3y_Volatility"]), r1: n(perf.Returns_1Y), r3: n(perf.Returns_3Y), r5: n(perf.Returns_5Y), r10: n(perf.Returns_10Y), ytd: n(perf.Returns_YTD) } };
  }

  // ============================================================= the curve
  const TENORS = [["month1", 1 / 12], ["month2", 2 / 12], ["month3", 0.25], ["month6", 0.5], ["year1", 1], ["year2", 2], ["year3", 3], ["year5", 5], ["year7", 7], ["year10", 10], ["year20", 20], ["year30", 30]];
  /** The Treasury yield (%) at a maturity in years, interpolated on one FMP treasury-rates row. */
  function curveAt(row, years) {
    if (!row || !isNum(n(years))) return NaN;
    const pts = TENORS.map(([k, t]) => [t, n(row[k])]).filter(([, y]) => isNum(y)); if (!pts.length) return NaN;
    if (years <= pts[0][0]) return pts[0][1]; if (years >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
    for (let i = 1; i < pts.length; i++) if (years <= pts[i][0]) { const [t0, y0] = pts[i - 1], [t1, y1] = pts[i]; return y0 + ((y1 - y0) * (years - t0)) / (t1 - t0); }
    return NaN;
  }
  /** The curve row on or just before a date. rows: newest first or any order. */
  function rowOn(rows, date) { let best = null; for (const r of rows || []) if (r?.date && r.date <= date && (!best || r.date > best.date)) best = r; return best; }
  const daysBack = (d, k) => new Date(Date.parse(d + "T00:00:00Z") - k * 864e5).toISOString().slice(0, 10);

  // ============================================================= the arithmetic
  /** Convexity, approximated from duration and yield (a bullet bond's; enough for sizing shocks). */
  const convexity = (D, y) => (isNum(D) ? (D * D + D) / Math.pow(1 + (isNum(y) ? y : 4) / 100, 2) : NaN);
  /** Price change (%) for a yield change (bp): -D·Δy + ½·C·Δy², with Δy in percentage points (so the convexity term is divided by 100). */
  const priceMove = (D, C, dyBp) => (isNum(D) ? -D * (dyBp / 100) + (0.5 * (isNum(C) ? C : 0) * Math.pow(dyBp / 100, 2)) / 100 : NaN);
  /** Total return (%) over `months`: the carry for the period plus the price change from a rate and a spread move. */
  function horizonReturn(m, months, rateBp = 0, spreadBp = 0) {
    const carry = (isNum(m.carry) ? m.carry : 0) * (months / 12), D = m.duration, C = m.convexity;
    const sD = m.credit ? (isNum(m.spreadDuration) ? m.spreadDuration : D) : 0;
    return carry + priceMove(D, C, rateBp) + (sD ? -sD * (spreadBp / 100) : 0);
  }
  /**
   * Everything code works out. ctx: {curve: [rows], hqm: [{date, y}] (10Y par, monthly), real: {y10, date}, sens (Sensitivity.measure),
   * ser: {dates, closes}, sectorCalls: {sector: {score, call, n}}, today}.
   */
  function math(p, ctx = {}) {
    const rows = (ctx.curve || []).slice().sort((a, b) => (a.date < b.date ? 1 : -1)), now = rows[0] || null, d0 = now?.date || ctx.today;
    const D = isNum(p.duration) ? p.duration : NaN, credit = isCredit(p.kind) && !/^treasury|^tips/.test(p.kind);
    const ytm = isNum(p.ytm) ? p.ytm : isNum(p.distYield) ? p.distYield : NaN;
    const tsy = curveAt(now, isNum(D) ? Math.max(0.1, D) : 5), spread = credit && isNum(ytm) && isNum(tsy) ? (ytm - tsy) * 100 : NaN;
    const exp = isNum(p.expense) ? p.expense * 100 : 0, carry = isNum(ytm) ? ytm - exp : NaN, C = convexity(D, ytm);
    const ago = (k) => rowOn(rows, daysBack(d0, k));
    const curveNow = now ? { date: now.date, y3m: n(now.month3), y2: n(now.year2), y5: n(now.year5), y10: n(now.year10), y30: n(now.year30) } : null;
    const moves = [["1M", 30], ["3M", 91], ["12M", 365]].map(([k, days]) => { const r = ago(days); return r ? { k, date: r.date, y2: n(r.year2), y10: n(r.year10), atDur: curveAt(r, isNum(D) ? Math.max(0.1, D) : 5),
      d2: (n(now?.year2) - n(r.year2)) * 100, d10: (n(now?.year10) - n(r.year10)) * 100, dDur: (tsy - curveAt(r, isNum(D) ? Math.max(0.1, D) : 5)) * 100 } : null; }).filter(Boolean);
    const slope = curveNow ? (curveNow.y10 - curveNow.y2) * 100 : NaN, slope3m10 = curveNow ? (curveNow.y10 - curveNow.y3m) * 100 : NaN;
    // The investment-grade spread proxy: the HQM 10-year par corporate yield over the 10-year Treasury, monthly.
    const hq = (ctx.hqm || []).slice().sort((a, b) => (a.date < b.date ? 1 : -1)).map((x) => { const r = rowOn(rows, x.date) || rowOn(rows, daysBack(x.date, -5)); return r ? { date: x.date, spread: (x.y - n(r.year10)) * 100 } : null; }).filter((x) => x && isNum(x.spread));
    const igSpread = hq[0] || null, igSpread12 = hq.find((x) => x.date <= daysBack(hq[0]?.date || d0, 330)) || null;
    const breakevenInfl = isNum(n(ctx.real?.y10)) && curveNow ? curveNow.y10 - n(ctx.real.y10) : NaN;
    // Rate and spread shocks, and the breakeven: how far yields can rise in a year before the price loss eats the carry.
    const shocks = [-100, -50, 50, 100, 200].map((b) => ({ bp: b, ret: priceMove(D, C, b), ret12: horizonReturn({ carry, duration: D, convexity: C, credit }, 12, b, 0) }));
    const spreadShocks = credit ? [-50, 100, 300].map((b) => ({ bp: b, ret: -D * (b / 100), ret12: horizonReturn({ carry, duration: D, convexity: C, credit }, 12, 0, b) })) : [];
    const breakeven = isNum(carry) && D > 0 ? (carry / D) * 100 : NaN;
    // Measured: its daily sensitivity to the 10-year yield (an empirical duration) and to stocks and high yield.
    const fac = Object.fromEntries((ctx.sens?.factors || []).map((f) => [f.key, f]));
    const rb = n(fac.rates?.total?.beta), empDur = isNum(rb) && rb < 0 ? -rb * 100 : NaN; // a fund that rose with yields has no meaningful measured duration
    const eqBeta = n(fac.market?.total?.beta), creditBeta = n(fac.credit?.total?.beta);
    // History: returns, volatility, the worst drawdown and when, and the last 12 months' drawdown.
    const ser = ctx.ser, hist = ser?.closes?.length > 30 ? (() => { const c = ser.closes, d = ser.dates, L = c.length - 1, back = (days) => { const t = daysBack(d[L], days); let i = L; while (i > 0 && d[i] > t) i--; return c[L] / c[i] - 1; };
      let peak = c[0], pd = d[0], mdd = 0, at = null; for (let i = 0; i < c.length; i++) { if (c[i] > peak) { peak = c[i]; pd = d[i]; } const x = c[i] / peak - 1; if (x < mdd) { mdd = x; at = { peak: pd, trough: d[i] }; } }
      const rs = []; for (let i = Math.max(1, L - 252); i <= L; i++) rs.push(Math.log(c[i] / c[i - 1])); const m = rs.reduce((a, b) => a + b, 0) / rs.length, vol = Math.sqrt(rs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, rs.length - 1) * 252);
      const hi = Math.max(...c.slice(Math.max(0, L - 252))); return { r1m: back(30) * 100, r3m: back(91) * 100, r1y: back(365) * 100, r3y: (Math.pow(c[L] / c[Math.max(0, L - 756)], 1 / 3) - 1) * 100, vol: vol * 100, mdd: mdd * 100, mddAt: at, offHigh: (c[L] / hi - 1) * 100, last: d[L] }; })() : null;
    // A corporate fund's issuers, through the runs' 12-month calls on their sectors.
    let lend = null;
    if (credit && p.sectors?.length && ctx.sectorCalls) { const rowsL = []; let W = 0, S = 0, up = 0, dn = 0;
      for (const s of p.sectors) { const sec = sectorOf(s.name), c = sec ? ctx.sectorCalls[sec] : null; rowsL.push({ name: s.name, w: s.w, sector: sec, call: c?.call || null, score: c?.score ?? null, n: c?.n || 0 });
        if (c && isNum(c.score)) { W += s.w; S += s.w * c.score; if (c.score > 0.25) up += s.w; else if (c.score < -0.25) dn += s.w; } }
      lend = { rows: rowsL, covered: W, score: W ? S / W : NaN, up: W ? up / W : NaN, down: W ? dn / W : NaN }; }
    return { asOf: d0, kind: p.kind, credit, ytm, tsy, spread, carry, expense: exp, duration: D, convexity: C, spreadDuration: D, curve: curveNow, moves, slope, slope3m10,
      igSpread, igSpread12, igTrend: igSpread && igSpread12 ? igSpread.spread - igSpread12.spread : NaN, realY10: n(ctx.real?.y10), breakevenInfl, shocks, spreadShocks, breakeven,
      empDur, eqBeta, creditBeta, rateEffect: n(fac.rates?.total?.effect), hist, lend };
  }

  /** A scenario priced by code: the strategist's rate and spread moves over 12 months, and the probability. */
  function priceScenarios(sc, m) {
    const out = {}; let P = 0, E = 0;
    for (const k of ["bull", "base", "bear"]) { const s = sc?.[k]; if (!s) continue; const prob = Math.max(0, Math.min(100, n(s.probability))), r = n(s.rate_change_bp), sp = m.credit ? n(s.spread_change_bp) : 0;
      if (!isNum(prob) || !isNum(r)) continue; const ret = horizonReturn(m, 12, r, isNum(sp) ? sp : 0);
      out[k] = { probability: prob, rate_change_bp: Math.round(r), spread_change_bp: m.credit && isNum(sp) ? Math.round(sp) : null, ret, narrative: s.narrative || "" }; P += prob; E += prob * ret; }
    return { scenarios: out, expected12: P > 0 ? E / P : NaN, probSum: P };
  }

  // ============================================================= the dossier
  /**
   * The strategist's inputs, each line with an ID for citations: B (the fund), R (rates and the curve), C (credit),
   * I (the runs' indicators), M (the runs' macro reads), H (history and sensitivities), S (sectors it lends to).
   * extra: {indicators: [{label, value, unit, prior, prior_label, date, reason}], reads: [{industry, regime, headline, summary}]}
   */
  function dossier(p, m, extra = {}, today = "") {
    const idx = {}, L = [], put = (id, text) => { idx[id] = text; L.push(`[${id}] ${text}`); }; let b = 0, r = 0, c = 0, i = 0, mm = 0, h = 0, s = 0;
    put(`B${++b}`, `${p.name} (${p.sym}): ${KINDS[p.kind] || "bonds"}${p.category ? `, category "${p.category}"` : ""}. ${p.count ? `${p.count} holdings, ` : ""}${isNum(p.bondPct) ? `${f1(p.bondPct, 0)}% bonds, ${f1(p.cashPct || 0, 1)}% cash` : ""}${isNum(p.aum) ? `, $${f1(p.aum / 1e9, 1)}B in assets` : ""}${p.inception ? `, since ${String(p.inception).slice(0, 4)}` : ""}.`);
    put(`B${++b}`, `Yield to maturity ${pp(p.ytm)}, distribution yield ${pp(p.distYield)}, average coupon ${pp(p.coupon)}, average bond price ${f1(p.avgPrice)} (par 100), expense ratio ${pp((p.expense || 0) * 100)}. Carry after costs (yield to maturity minus expenses): ${pp(m.carry)} a year.`);
    put(`B${++b}`, `Effective duration ${f1(p.duration)} years (a 1-point rise in its yields costs about ${f1(p.duration)}% in price), effective maturity ${f1(p.maturity)} years${isNum(m.convexity) ? `, convexity about ${f1(m.convexity, 0)} (code's estimate)` : ""}.`);
    if (p.description) put(`B${++b}`, `What it tracks: ${p.description}`);
    if (m.curve) put(`R${++r}`, `Treasury curve on ${m.curve.date}: 3-month ${pp(m.curve.y3m)}, 2-year ${pp(m.curve.y2)}, 5-year ${pp(m.curve.y5)}, 10-year ${pp(m.curve.y10)}, 30-year ${pp(m.curve.y30)}. 2s10s slope ${bp(m.slope)}, 3-month to 10-year ${bp(m.slope3m10)}.`);
    for (const x of m.moves) put(`R${++r}`, `Since ${x.date} (${x.k} ago): 2-year ${bp(x.d2)}, 10-year ${bp(x.d10)}, the Treasury yield at this fund's duration ${bp(x.dDur)}.`);
    put(`R${++r}`, `The Treasury yield at this fund's duration (${f1(p.duration)} years) is ${pp(m.tsy)}.${isNum(m.breakeven) ? ` Breakeven: its yields can rise about ${Math.round(m.breakeven)}bp over 12 months before the price loss wipes out a year's carry.` : ""}`);
    put(`R${++r}`, `Rate shocks, price change now (and 12-month total return with carry): ${m.shocks.map((x) => `${bp(x.bp)} ${sgn(x.ret)} (${sgn(x.ret12)})`).join(", ")}.`);
    if (isNum(m.realY10)) put(`R${++r}`, `10-year real (TIPS) yield ${pp(m.realY10)}; breakeven inflation (10-year nominal minus real) ${pp(m.breakevenInfl)}.`);
    if (m.credit) { if (isNum(m.spread)) put(`C${++c}`, `Its spread over Treasuries of the same duration: ${Math.round(m.spread)}bp (yield to maturity ${pp(m.ytm)} minus ${pp(m.tsy)}).`);
      if (m.igSpread) put(`C${++c}`, `Investment-grade spread proxy (HQM 10-year corporate par yield minus the 10-year Treasury): ${Math.round(m.igSpread.spread)}bp in ${m.igSpread.date.slice(0, 7)}${m.igSpread12 ? `, ${Math.round(m.igSpread12.spread)}bp a year earlier (${bp(m.igTrend)})` : ""}.`);
      if (m.spreadShocks.length) put(`C${++c}`, `Spread shocks, price change now (and 12-month total return with carry): ${m.spreadShocks.map((x) => `${bp(x.bp)} ${sgn(x.ret)} (${sgn(x.ret12)})`).join(", ")}.`); }
    if (m.lend?.rows?.length) { put(`S${++s}`, `Sectors it lends to, through the industry runs' 12-month calls (${Math.round(m.lend.covered * 100)}% of the fund mapped): ${Math.round((m.lend.up || 0) * 100)}% to sectors the runs call up, ${Math.round((m.lend.down || 0) * 100)}% to sectors they call down.`);
      for (const x of m.lend.rows.slice(0, 10)) put(`S${++s}`, `${x.name} ${f1(x.w * 100, 1)}% of the fund${x.sector ? ` (runs' sector: ${x.sector}${x.call ? `, 12-month call ${x.call} across ${x.n} industr${x.n === 1 ? "y" : "ies"}` : ", no run"})` : ""}.`); }
    if (p.top?.length) put(`B${++b}`, `Largest issuers: ${p.top.slice(0, 10).map((x) => `${x.name} ${f1(x.w, 2)}%`).join("; ")}.`);
    if (m.hist) put(`H${++h}`, `Its price record to ${m.hist.last}: 1 month ${sgn(m.hist.r1m)}, 3 months ${sgn(m.hist.r3m)}, 12 months ${sgn(m.hist.r1y)}, 3 years ${sgn(m.hist.r3y)} a year (dividends reinvested). Volatility over the last year ${pp(m.hist.vol, 1)}. ${pp(m.hist.offHigh, 1)} from its 12-month high. Worst fall since 2007 ${pp(m.hist.mdd, 1)}${m.hist.mddAt ? ` (${m.hist.mddAt.peak} to ${m.hist.mddAt.trough})` : ""}.`);
    if (isNum(m.empDur) || isNum(m.eqBeta)) put(`H${++h}`, `Measured over the last year (code, daily): ${isNum(m.empDur) ? `it moved like a ${f1(m.empDur)}-year duration against the 10-year yield (a +25bp move cost it ${sgn((m.rateEffect || 0) * 100, 2)})` : ""}${isNum(m.eqBeta) ? `; beta to the S&P 500 ${f1(m.eqBeta, 2)}` : ""}${isNum(m.creditBeta) ? `; beta to high-yield bonds (HYG) ${f1(m.creditBeta, 2)}` : ""}.`);
    if (isNum(p.perf?.r10)) put(`H${++h}`, `EODHD's returns: YTD ${sgn(p.perf.ytd)}, 1 year ${sgn(p.perf.r1)}, 3 years ${sgn(p.perf.r3)}, 5 years ${sgn(p.perf.r5)}, 10 years ${sgn(p.perf.r10)}; volatility ${pp(p.perf.vol1, 1)} (1 year), ${pp(p.perf.vol3, 1)} (3 years).`);
    for (const x of (extra.indicators || []).slice(0, 18)) put(`I${++i}`, `${x.label}: ${x.value}${x.unit && x.unit !== "$" ? x.unit : ""}${x.prior !== undefined && x.prior !== null ? ` (${x.prior_label || "before"}: ${x.prior}${x.unit && x.unit !== "$" ? x.unit : ""})` : ""}${x.date ? `, ${x.date}` : ""}.`);
    for (const x of (extra.reads || []).slice(0, 4)) put(`M${++mm}`, `The ${x.industry} run's macro analyst (${x.date || "latest"}): ${x.regime ? `${x.regime}. ` : ""}${trim(x.headline || "", 400)} ${trim(x.summary || "", 700)}`);
    return { text: L.join("\n"), idx, today };
  }

  // ============================================================= the strategist
  function prompt(p, dz, today) {
    const credit = isCredit(p.kind) && !/^treasury|^tips/.test(p.kind);
    return `You are a fixed-income strategist writing the analysis of one bond fund, ${p.name} (${p.sym}), for an investor deciding whether to own it. Today is ${today}.

What moves this fund: its yields (rates${credit ? " and credit spreads" : ""}), how far they can move before the carry is lost, ${p.kind === "tips" ? "real yields and inflation, " : ""}the Fed and inflation, and the economy. Code has done the arithmetic below; reason from it, never redo it differently, and never invent a number. Every factual claim cites the ids it rests on in brackets, like [R2] or [B3][I4]; use only ids below.

DOSSIER
${dz.text}

Reply with JSON only:
{
 "headline": "one sentence: the verdict and the one number that matters most",
 "verdict": "attractive" | "fair" | "unattractive",
 "conviction": 1-10,
 "thesis": "3 short paragraphs (separated by \\n): what you earn (carry, yield vs cash and vs its own history), what can take it away (rates${credit ? ", spreads" : ""}), and the call",
 "rates": "1 paragraph: where the Fed and the curve are heading and what that does to this fund's price, sized with the shocks [R#]",
 ${credit ? `"credit": "1 paragraph: are spreads paying for the risk, and the issuers' sectors through the runs' calls [C#][S#]",` : `"credit": null,`}
 "inflation": "1-2 sentences: what inflation does to it",
 "role": "1-2 sentences: what it does in a portfolio (ballast, income, inflation hedge...) and how it behaves when stocks fall [H#]",
 "fits": "who should own it", "avoid_if": "who shouldn't",
 "scenarios": {"bull": {"probability": %, "rate_change_bp": 12-month change in the Treasury yield at its duration (negative = falls)${credit ? `, "spread_change_bp": 12-month change in its spread` : ""}, "narrative": "what happens"}, "base": {...}, "bear": {...}},
 "calls": {"1M": {"call": one of ${JSON.stringify(LEVELS)}, "why": "1-2 sentences with ids"}, "3M": {...}, "6M": {...}, "12M": {...}},
 "risks": [{"risk": "short", "why": "1 sentence with ids", "size": "low" | "medium" | "high"}],
 "watch": [{"what": "a release or level to watch", "why": "what it would change"}]
}
The calls are about this fund's total return (price plus income) against holding cash over each window: bullish means it should beat cash. Probabilities sum to 100. Code prices your scenarios with the fund's duration${credit ? ", spread duration" : ""} and carry, and checks your 12-month call against them.`;
  }

  /** The strategist's answer, cleaned: only ids the dossier has, known enums, scenarios priced by code, the 12M call checked. */
  function clean(raw, dz, m) {
    const idx = dz.idx || {}; let dropped = 0; raw = raw || {};
    const known = (id) => Object.prototype.hasOwnProperty.call(idx, id);
    const t = (s, k = 1200) => trim(String(s ?? "").replace(/\[([A-Z]{1,2}\d{1,3})\]/g, (x, id) => (known(id) ? x : (dropped++, ""))).replace(/\s+([.,;:])/g, "$1"), k);
    const para = (s, k = 3000) => String(s ?? "").split(/\n+/).map((x) => t(x, k)).filter(Boolean).join("\n");
    const en = (v, list) => { const x = lc(v).trim(); return list.includes(x) ? x : null; };
    const calls = {}; for (const h of HZ) { const c = raw.calls?.[h]; const call = en(c?.call, LEVELS); if (call) calls[h] = { call, why: t(c?.why, 500) }; }
    const pr = priceScenarios(raw.scenarios || {}, m);
    const checks = [];
    if (isNum(pr.expected12) && calls["12M"]) { const ex = pr.expected12 - (isNum(m.curve?.y3m) ? m.curve.y3m : 0), sg = SIGN[calls["12M"].call];
      if (sg > 0 && ex < -1) checks.push(`the 12-month call is ${calls["12M"].call} but the scenarios, priced by code, return ${sgn(pr.expected12)}, ${f1(-ex)} points below cash`);
      if (sg < 0 && ex > 1) checks.push(`the 12-month call is ${calls["12M"].call} but the scenarios, priced by code, return ${sgn(pr.expected12)}, ${f1(ex)} points above cash`); }
    if (pr.probSum && Math.abs(pr.probSum - 100) > 2) checks.push(`the scenario probabilities add to ${Math.round(pr.probSum)}%, not 100%`);
    const out = { headline: t(raw.headline, 400), verdict: en(raw.verdict, VERDICTS), conviction: Math.max(1, Math.min(10, Math.round(n(raw.conviction)) || 0)) || null,
      thesis: para(raw.thesis), rates: t(raw.rates, 1500), credit: m.credit ? t(raw.credit, 1500) || null : null, inflation: t(raw.inflation, 600), role: t(raw.role, 600), fits: t(raw.fits, 400), avoid_if: t(raw.avoid_if, 400),
      scenarios: pr.scenarios, expected12: pr.expected12, calls, checks,
      risks: (Array.isArray(raw.risks) ? raw.risks : []).map((x) => ({ risk: t(x?.risk, 120), why: t(x?.why, 400), size: en(x?.size, ["low", "medium", "high"]) || "medium" })).filter((x) => x.risk).slice(0, 6),
      watch: (Array.isArray(raw.watch) ? raw.watch : []).map((x) => ({ what: t(x?.what, 160), why: t(x?.why, 300) })).filter((x) => x.what).slice(0, 6) };
    out.dropped = dropped;
    return out.headline || out.thesis ? out : null;
  }

  const BondAn = { HZ, MONTHS, LEVELS, SIGN, KINDS, isBond, kindOf, isCredit, sectorOf, profile, curveAt, rowOn, convexity, priceMove, horizonReturn, math, priceScenarios, dossier, prompt, clean };
  if (typeof module !== "undefined" && module.exports) module.exports = BondAn;
  else root.BondAn = BondAn;
})(typeof window !== "undefined" ? window : globalThis);
