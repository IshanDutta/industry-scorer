/**
 * EtfRec: the ETF recommender and portfolio improver (code; the analyst only writes the explanation).
 *
 * 1. A curated universe of liquid US-listed ETFs (stocks by sector, industry, style and income; Treasuries, TIPS,
 *    corporates, high yield, munis and MBS; gold and commodities; international only when asked), screened live on
 *    assets, volume, age, cost and leverage.
 * 2. Every stock ETF is looked through to the industries it holds and scored on the industry runs (Portfolio.lookThrough:
 *    their scores for the investor type, 1M-12M calls, expected returns, valuation, risk). Bond ETFs get a rates and
 *    credit view (the Treasury curve, their duration, carry, defaults). Pillars per goal pick the candidates.
 * 3. Expected returns: Black-Litterman, a CAPM prior (Rf + beta x the equity premium) moved toward the industry and bond
 *    views by their confidence. Risk: three years of daily returns, shrunk toward constant correlation (Ledoit-Wolf).
 * 4. The portfolio: mean-variance under the goal's volatility ceiling with every position capped at 15%, bond and
 *    sector bands, a look-through cap on any single stock, a minimum position and a holding count; three versions.
 * 5. The improver: today's holdings mapped to ETFs, then the same optimizer with a turnover penalty, so it proposes the
 *    fewest trades that close most of the gap.
 */
(function (root) {
  "use strict";
  const n = (x) => (x === null || x === undefined || x === "" ? NaN : Number(x));
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const lc = (s) => String(s || "").toLowerCase();
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const RF = 0.04, ERP = 0.05, CAP = 15, TAU = 0.05;

  // ------------------------------------------------------------------ the universe
  // SYMBOL|kind|sector or industries (;)|bond type|approx. duration (years)
  // kinds: core, size, style, div, sector, ind, theme, bond, gold, cmdty, intl, intlbond
  const RAW = `VOO|core||| IVV|core||| SPY|core||| VTI|core||| SCHB|core||| ITOT|core||| SPLG|core||| RSP|style|||
IJH|size||| VO|size||| MDY|size||| IJR|size||| VB|size||| IWM|size||| SCHA|size|||
VUG|style||| IWF|style||| SCHG|style||| MGK|style||| QQQ|style||| QQQM|style||| VTV|style||| IWD|style||| SCHV|style||| MTUM|style||| QUAL|style||| USMV|style||| SPLV|style||| VLUE|style||| COWZ|style||| AVUV|size||| SPHQ|style|||
SCHD|div||| VIG|div||| DGRO|div||| VYM|div||| HDV|div||| NOBL|div||| DVY|div||| SPYD|div||| SDY|div||| JEPI|div||| JEPQ|div||| DIVO|div|||
XLK|sector|Technology|| VGT|sector|Technology|| XLF|sector|Financial Services|| VFH|sector|Financial Services|| XLV|sector|Healthcare|| VHT|sector|Healthcare|| XLY|sector|Consumer Cyclical|| VCR|sector|Consumer Cyclical||
XLP|sector|Consumer Defensive|| VDC|sector|Consumer Defensive|| XLE|sector|Energy|| VDE|sector|Energy|| XLI|sector|Industrials|| VIS|sector|Industrials|| XLB|sector|Basic Materials|| VAW|sector|Basic Materials||
XLU|sector|Utilities|| VPU|sector|Utilities|| XLRE|sector|Real Estate|| VNQ|sector|Real Estate|| XLC|sector|Communication Services|| VOX|sector|Communication Services||
SMH|ind|Semiconductors|| SOXX|ind|Semiconductors|| XSD|ind|Semiconductors|| IGV|ind|Software - Application;Software - Infrastructure|| CIBR|ind|Software - Infrastructure;Information Technology Services|| SKYY|ind|Software - Infrastructure;Software - Application||
FDN|ind|Internet Content & Information;Specialty Retail;Software - Application|| XBI|ind|Biotechnology|| IBB|ind|Biotechnology;Drug Manufacturers - General|| IHI|ind|Medical - Devices;Medical - Instruments & Supplies;Medical - Equipment & Services||
XPH|ind|Drug Manufacturers - Specialty & Generic;Drug Manufacturers - General|| IHF|ind|Medical - Healthcare Plans;Medical - Care Facilities;Medical - Distribution|| ITA|ind|Aerospace & Defense|| XAR|ind|Aerospace & Defense||
KRE|ind|Banks - Regional|| KBE|ind|Banks - Regional;Banks - Diversified|| IAI|ind|Financial - Capital Markets;Investment - Banking & Investment Services;Financial - Data & Stock Exchanges|| KIE|ind|Insurance - Property & Casualty;Insurance - Diversified;Insurance - Life;Insurance - Brokers||
ITB|ind|Residential Construction;Home Improvement|| XHB|ind|Residential Construction;Home Improvement;Furnishings, Fixtures & Appliances;Construction Materials|| XRT|ind|Specialty Retail;Apparel - Retail;Discount Stores;Department Stores||
XOP|ind|Oil & Gas Exploration & Production|| OIH|ind|Oil & Gas Equipment & Services|| AMLP|ind|Oil & Gas Midstream|| XME|ind|Steel;Copper;Aluminum;Gold;Coal|| GDX|ind|Gold|| COPX|ind|Copper|| URA|ind|Uranium|| NLR|ind|Uranium;Regulated Electric||
TAN|ind|Solar|| ICLN|ind|Renewable Utilities;Solar|| GRID|ind|Electrical Equipment & Parts;Renewable Utilities|| PAVE|ind|Engineering & Construction;Construction Materials;Industrial - Machinery|| IYT|ind|Trucking;Railroads;Integrated Freight & Logistics;Airlines, Airports & Air Services||
JETS|ind|Airlines, Airports & Air Services|| IYZ|ind|Telecommunications Services|| PBJ|ind|Packaged Foods;Food Distribution;Beverages - Non-Alcoholic|| PEJ|ind|Leisure;Restaurants;Travel Services;Gambling, Resorts & Casinos|| ESPO|ind|Electronic Gaming & Multimedia||
REZ|ind|REIT - Residential|| INDS|ind|REIT - Industrial|| BOTZ|theme|Industrial - Machinery;Semiconductors|| ARKK|theme|||
SGOV|bond||cash|0.1 BIL|bond||cash|0.1 SHV|bond||cash|0.3 JPST|bond||cash|0.5 FLOT|bond||float|0.1 SHY|bond||treasury|1.9 VGSH|bond||treasury|1.9 SCHO|bond||treasury|1.9 IEI|bond||treasury|4.3 VGIT|bond||treasury|5.1
GOVT|bond||treasury|5.8 IEF|bond||treasury|7.1 TLH|bond||treasury|13 VGLT|bond||treasury|14.5 TLT|bond||treasury|16 EDV|bond||treasury|24 AGG|bond||agg|6 BND|bond||agg|5.9 SCHZ|bond||agg|6 IUSB|bond||agg|6
TIP|bond||tips|6.6 SCHP|bond||tips|6.5 VTIP|bond||tips|2.5 STIP|bond||tips|2.5 LQD|bond||ig|8.2 VCIT|bond||ig|6 IGIB|bond||ig|6.1 VCSH|bond||ig|2.6 IGSB|bond||ig|2.6 VCLT|bond||ig|12.8
HYG|bond||hy|3.1 JNK|bond||hy|3 USHY|bond||hy|3 SHYG|bond||hy|2 BKLN|bond||loans|0.3 MUB|bond||muni|6.3 VTEB|bond||muni|6 SUB|bond||muni|2.5 MBB|bond||mbs|5.9 VMBS|bond||mbs|5.8
GLD|gold||| IAU|gold||| GLDM|gold||| SLV|cmdty||| PDBC|cmdty||| DBC|cmdty|||
VXUS|intl||| VEA|intl||| IEFA|intl||| EFA|intl||| SCHF|intl||| VWO|intl||| IEMG|intl||| EEM|intl||| ACWX|intl||| VEU|intl||| INDA|intl||| EWJ|intl||| MCHI|intl||| KWEB|intl||| BNDX|intlbond||agg|7 EMB|intlbond||ig|7`;
  const UNIVERSE = RAW.trim().split(/\s+(?=[A-Z]{2,5}\|)/).filter(Boolean).map((r) => { const [s, k, t, b, d] = r.split("|");
    return { symbol: s, kind: k, sector: k === "sector" ? t : null, industries: k === "ind" || k === "theme" ? (t ? t.split(";") : []) : [], bond: b || null, duration: isNum(n(d)) ? n(d) : null, intl: k === "intl" || k === "intlbond" }; });
  const BY = new Map(UNIVERSE.map((e) => [e.symbol, e]));
  const isBond = (e) => e?.kind === "bond" || e?.kind === "intlbond";
  const isStock = (e) => ["core", "size", "style", "div", "sector", "ind", "theme", "intl"].includes(e?.kind);
  const KIND_LABEL = { core: "US total market", size: "Mid and small caps", style: "Style and factor", div: "Dividend and income", sector: "Sector", ind: "Industry", theme: "Theme", bond: "Bonds", gold: "Gold", cmdty: "Commodities", intl: "International stocks", intlbond: "International bonds" };
  const BOND_LABEL = { cash: "T-bills and cash", float: "Floating-rate notes", treasury: "Treasuries", agg: "Core bonds (aggregate)", tips: "Inflation-protected Treasuries", ig: "Investment-grade corporates", hy: "High yield", loans: "Bank loans", muni: "Municipal bonds", mbs: "Mortgage-backed" };
  // Spread over Treasuries (when no trailing yield is known), expected default losses a year, and the spread move in a credit stress.
  const CREDIT = { cash: [0, 0, 0], float: [0.004, 0, 0.003], treasury: [0, 0, 0], tips: [0, 0, 0], agg: [0.004, 0.0005, 0.006], mbs: [0.006, 0, 0.007], ig: [0.009, 0.001, 0.012], muni: [-0.008, 0.0005, 0.008], hy: [0.03, 0.015, 0.035], loans: [0.035, 0.012, 0.03] };

  // ------------------------------------------------------------------ goals
  /**
   * The four investor types the industry runs score, as portfolio goals: volatility ceiling, bond band, how much yield
   * counts on top of total return, and the pillar weights used to shortlist candidates.
   */
  const GOALS = {
    income: { label: "Income", vol: 0.10, bonds: [0.30, 0.65], yieldBonus: 0.8, sectorCap: 0.30, industryCap: 0.20, pillars: { income: 0.30, fit: 0.15, outlook: 0.15, risk: 0.15, cost: 0.10, value: 0.10, diversification: 0.05 } },
    conservative: { label: "Conservative", vol: 0.08, bonds: [0.40, 0.75], yieldBonus: 0.25, sectorCap: 0.25, industryCap: 0.20, pillars: { risk: 0.30, fit: 0.15, outlook: 0.15, cost: 0.15, value: 0.10, income: 0.10, diversification: 0.05 } },
    growth: { label: "Growth", vol: 0.17, bonds: [0, 0.20], yieldBonus: 0, sectorCap: 0.40, industryCap: 0.25, pillars: { outlook: 0.30, fit: 0.20, momentum: 0.15, value: 0.10, cost: 0.10, risk: 0.10, diversification: 0.05 } },
    aggressive: { label: "Aggressive", vol: 0.24, bonds: [0, 0.10], yieldBonus: 0, sectorCap: 0.45, industryCap: 0.30, pillars: { outlook: 0.35, fit: 0.20, momentum: 0.20, value: 0.05, cost: 0.05, risk: 0.05, diversification: 0.10 } },
  };
  const HZ_MONTHS = { "1M": 1, "3M": 3, "6M": 6, "12M": 12, long: 12 };
  /** A goal with the user's settings applied: horizon, volatility ceiling, counts, exclusions, international. */
  function goalOf(g = {}) {
    const base = GOALS[g.type] || GOALS.growth, vol = isNum(n(g.maxVol)) && n(g.maxVol) > 0 ? n(g.maxVol) / 100 : base.vol;
    return { ...base, type: GOALS[g.type] ? g.type : "growth", horizon: HZ_MONTHS[g.horizon] ? g.horizon : "12M", vol, amount: n(g.amount) > 0 ? n(g.amount) : 10000,
      minN: Math.max(Math.ceil(100 / CAP), n(g.minN) || 8), maxN: Math.max(Math.ceil(100 / CAP), Math.min(15, n(g.maxN) || 12)), cap: CAP, minW: 3, stockCap: 0.08,
      maxCost: isNum(n(g.maxCost)) && n(g.maxCost) > 0 ? n(g.maxCost) / 100 : 0.0075, intl: !!g.intl, bondsOk: g.bonds !== false,
      exclude: (g.exclude || []).map(lc), excludeSyms: (g.excludeSyms || []).map((s) => String(s).toUpperCase()), yieldTarget: n(g.yieldTarget) > 0 ? n(g.yieldTarget) / 100 : NaN };
  }

  // ------------------------------------------------------------------ screening
  const LEVERED = /\b(2x|3x|ultra|ultrapro|inverse|short|bear|leveraged|daily)\b/i;
  /** Is this ETF fit to recommend? info: FMP's ETF information row. Returns {ok, why}. */
  function screen(e, info, goal, { today = new Date().toISOString().slice(0, 10) } = {}) {
    if (!e) return { ok: false, why: "not in the universe" };
    if (goal.excludeSyms.includes(e.symbol)) return { ok: false, why: "excluded by you" };
    if (e.intl && !goal.intl) return { ok: false, why: "international (only when you ask)" };
    if (isBond(e) && !goal.bondsOk) return { ok: false, why: "bonds turned off" };
    if (!info) return { ok: false, why: "FMP has no information on it" };
    if (LEVERED.test(info.name || "")) return { ok: false, why: "leveraged or inverse" };
    const aum = n(info.assetsUnderManagement), vol = n(info.avgVolume), er = n(info.expenseRatio) / 100, age = info.inceptionDate ? (Date.parse(today) - Date.parse(info.inceptionDate)) / (365.25 * 864e5) : NaN;
    if (isNum(aum) && aum < 2.5e8) return { ok: false, why: `assets $${(aum / 1e6).toFixed(0)}M (under $250M)` };
    if (isNum(vol) && vol < 50000) return { ok: false, why: "thinly traded" };
    if (isNum(age) && age < 3) return { ok: false, why: "under three years old" };
    if (isNum(er) && er > goal.maxCost) return { ok: false, why: `costs ${(er * 100).toFixed(2)}%` };
    const words = `${info.name || ""} ${e.sector || ""} ${(e.industries || []).join(" ")} ${KIND_LABEL[e.kind] || ""} ${e.bond ? BOND_LABEL[e.bond] : ""}`.toLowerCase();
    const hit = goal.exclude.find((x) => x && words.includes(x)); if (hit) return { ok: false, why: `excluded: ${hit}` };
    return { ok: true, why: "" };
  }

  // ------------------------------------------------------------------ prices and quant facts
  const mapOf = (s) => { const m = new Map(); if (s?.dates) s.dates.forEach((d, i) => { const v = n(s.closes[i]); if (v > 0) m.set(d, v); }); return m; };
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  const sdev = (a) => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
  /** Daily returns of each symbol on the common days of the last `days` trading days of `calendar` (forward-filled). */
  function aligned(series, syms, calendar, days = 756) {
    const cal = calendar.slice(-days - 1), maps = syms.map((s) => mapOf(series[s])), last = syms.map(() => NaN), R = syms.map(() => []);
    maps.forEach((m, j) => { const ks = [...m.keys()].filter((d) => d <= cal[0]).sort(); if (ks.length) last[j] = m.get(ks[ks.length - 1]); });
    for (let i = 1; i < cal.length; i++) {
      const d = cal[i];
      for (let j = 0; j < syms.length; j++) { const v = maps[j].get(d), prev = last[j]; if (v > 0) { R[j].push(prev > 0 ? v / prev - 1 : NaN); last[j] = v; } else R[j].push(prev > 0 ? 0 : NaN); }
    }
    return R;
  }
  /** Per-ETF facts from its daily series against SPY: volatility, max drawdown and beta (3 years), 12-1 momentum, 1Y and 3Y returns. */
  function quantFacts(ser, spy, { today = null } = {}) {
    if (!ser?.dates?.length) return null;
    const cal = spy?.dates?.length ? spy.dates : ser.dates, [r, s] = aligned({ a: ser, b: spy }, ["a", "b"], cal, 756);
    const ok = r.map((x, i) => [x, s[i]]).filter(([x, y]) => isNum(x) && isNum(y));
    const ra = ok.map((p) => p[0]), sb = ok.map((p) => p[1]), vol = sdev(ra) * Math.sqrt(252);
    const ms = mean(sb), mr = mean(ra); let cv = 0, vs = 0; for (let i = 0; i < ok.length; i++) { cv += (ra[i] - mr) * (sb[i] - ms); vs += (sb[i] - ms) ** 2; }
    const beta = vs > 0 ? cv / vs : NaN;
    const m = mapOf(ser), ds = [...m.keys()].sort(), at = (k) => m.get(ds[Math.max(0, ds.length - 1 - k)]);
    const last = at(0), r1 = ds.length > 252 ? last / at(252) - 1 : NaN, r3 = ds.length > 756 ? Math.pow(last / at(756), 1 / 3) - 1 : NaN, mom = ds.length > 252 ? at(21) / at(252) - 1 : NaN;
    let peak = 0, mdd = 0; for (const d of ds.slice(-756)) { const v = m.get(d); peak = Math.max(peak, v); mdd = Math.min(mdd, v / peak - 1); }
    return { vol, beta, r1y: r1, r3y: r3, mom, mdd, days: ds.length, first: ds[0] };
  }

  // ------------------------------------------------------------------ views
  /** The Treasury yield (a fraction) at `years`, interpolated on FMP's curve row {month1..year30} in percent. */
  function curveAt(curve, years) {
    const P = [[1 / 12, "month1"], [0.25, "month3"], [0.5, "month6"], [1, "year1"], [2, "year2"], [3, "year3"], [5, "year5"], [7, "year7"], [10, "year10"], [20, "year20"], [30, "year30"]].map(([t, k]) => [t, n(curve?.[k])]).filter(([, v]) => isNum(v));
    if (!P.length) return NaN; if (years <= P[0][0]) return P[0][1] / 100; if (years >= P[P.length - 1][0]) return P[P.length - 1][1] / 100;
    for (let i = 1; i < P.length; i++) if (years <= P[i][0]) { const [t0, v0] = P[i - 1], [t1, v1] = P[i]; return (v0 + ((v1 - v0) * (years - t0)) / (t1 - t0)) / 100; }
    return NaN;
  }
  /**
   * A bond ETF's 12-month view: carry (its trailing distribution yield, else the curve at its maturity plus a spread)
   * less expected default losses; what +1pp on rates and a credit stress would do; and its confidence.
   */
  function bondView(e, { curve = null, ttmYield = NaN, expense = NaN } = {}) {
    const dur = n(e.duration) || 0, [spread, loss, shock] = CREDIT[e.bond] || CREDIT.agg, tsy = curveAt(curve, Math.max(0.1, dur * 1.25));
    const curveY = isNum(tsy) ? tsy + spread - (isNum(expense) ? expense : 0) : NaN;
    const y = isNum(ttmYield) && ttmYield > 0.002 && ttmYield < 0.15 ? (isNum(curveY) ? 0.5 * ttmYield + 0.5 * curveY : ttmYield) : curveY;
    const exp = isNum(y) ? y - loss : NaN;
    return { kind: "bond", type: e.bond, label: BOND_LABEL[e.bond] || "Bonds", duration: dur, yield: y, curve: tsy, expected: exp, loss, rates_up_1pp: -dur / 100, credit_stress: e.bond === "tips" || e.bond === "treasury" || e.bond === "cash" ? 0 : -(Math.min(dur, 7) * shock),
      conf: isNum(exp) ? 0.75 : 0, why: isNum(exp) ? `${(y * 100).toFixed(2)}% yield${loss ? ` less ${(loss * 100).toFixed(1)}% expected defaults` : ""}, duration about ${dur} years` : "no yield" };
  }
  /**
   * A stock ETF's view from the industry runs (Portfolio.lookThrough of its holdings): the expected return for the goal's
   * horizon (annualized), the goal's investor-type score, the calls, valuation and risk, and a confidence that falls
   * with coverage. cov: Portfolio.coverage; look: Portfolio.lookThrough.
   */
  function equityView(look, cov, goal) {
    if (!look || !(look.on > 0)) return { kind: "stock", conf: 0, expected: NaN, why: "no industry run covers it" };
    const h = goal.horizon === "long" ? "12M" : goal.horizon, months = HZ_MONTHS[h] || 12, c = look.calls?.[h] || {};
    // 12M: the strategists' expected return (weighted); shorter: that horizon's expected move, annualized but damped.
    const e12 = isNum(look.exp12?.v) ? look.exp12.v / 100 : isNum(look.calls?.["12M"]?.expected) ? look.calls["12M"].expected / 100 : NaN;
    const eh = isNum(c.expected) ? (c.expected / 100) * (12 / months) : NaN;
    let exp = months >= 12 ? e12 : isNum(eh) ? 0.5 * eh + 0.5 * (isNum(e12) ? e12 : eh) : e12;
    if (isNum(exp)) exp = clamp(exp, -0.35, 0.45);
    const on = clamp(look.on, 0, 1), full = clamp((look.full_on || 0) / (look.on || 1), 0, 1);
    const conf = isNum(exp) ? clamp(on * (0.45 + 0.35 * full) * (months >= 12 ? 1 : 0.8), 0, 0.85) : 0;
    const score = n(look.scores?.[goal.type]?.v), callScore = n(c.score ?? c.lean_score);
    return { kind: "stock", expected: exp, conf, on, full, score, call: c.lean || c.call || "", callScore, p_up: n(c.p_up), pe: n(look.val?.pe?.v), fwd_pe: n(look.val?.fwd_pe?.v), pe_hist_pct: n(look.val?.pe_hist_pct?.v),
      eps_growth: n(look.val?.eps_growth?.v), div_yield: n(look.val?.div_yield?.v), ind_vol: n(look.risk?.vol?.v), scen: look.scen, best: look.best, top: (look.contrib || []).slice(0, 4).map((x) => ({ industry: x.industry, weight: x.weight, expected: x.expected, call: x.call12 })),
      bottom: (look.contrib || []).slice(-3).reverse().map((x) => ({ industry: x.industry, weight: x.weight, expected: x.expected, call: x.call12 })),
      industries: (cov?.industries || []).slice(0, 8).map((g) => ({ industry: g.industry, sector: g.sector, weight: g.weight, status: g.status })), sectors: cov?.sectors || {} };
  }
  /** Cheap first pass for stock ETFs before their holdings are read: the tagged sector's or industries' digests. digests: {lc(name): digest}; bySector: {sector: [digest]}. */
  function tagView(e, digests, bySector, goal) {
    const ds = e.industries?.length ? e.industries.map((x) => digests[lc(x)]).filter(Boolean) : e.sector ? bySector[e.sector] || [] : [];
    if (!ds.length) return null;
    const h = goal.horizon === "long" ? "12M" : goal.horizon, avg = (f) => { const v = ds.map(f).filter(isNum); return v.length ? mean(v) : NaN; };
    return { expected: avg((d) => n(d.expected12)) / 100, score: avg((d) => n(d.scores?.[goal.type])), call: avg((d) => { const c = d.lean?.[h] || d.calls?.[h]?.call; return CALLN(c); }), n: ds.length };
  }
  const CALLN = (c) => { const t = lc(c); if (!t) return NaN; const s = /bull|positive|up|overweight|buy/.test(t) ? 1 : /bear|negative|down|underweight|sell/.test(t) ? -1 : /neutral|mixed|flat|hold/.test(t) ? 0 : NaN; return isNum(s) && s && !/slight|mild|modest|lean/.test(t) ? 2 * s : s; };

  // ------------------------------------------------------------------ pillars
  const lin = (x, a, b) => (isNum(x) ? clamp(((x - a) / (b - a)) * 100, 0, 100) : NaN);
  /**
   * 0-100 pillars for one ETF and the goal-weighted total. x: {e, info, q (quantFacts), v (view), yld (trailing yield), effN, top10}.
   * outlook: the industry or bond view; fit: the industry runs' score for this investor type; value: P/E against
   * history; risk: volatility and drawdown against the goal's ceiling; cost; income; momentum; diversification.
   */
  function pillars(x, goal) {
    const { e, info = {}, q = {}, v = {}, yld = NaN } = x, er = n(info.expenseRatio) / 100, P = {};
    P.outlook = v.kind === "bond" ? lin(v.expected, RF - 0.01, RF + 0.025) : isNum(v.expected) ? clamp(50 + (v.expected - 0.07) * 400 * (0.5 + v.conf), 0, 100) : 50;
    P.fit = isNum(v.score) ? v.score : v.kind === "bond" ? (goal.type === "income" || goal.type === "conservative" ? 70 : 45) : 50;
    P.value = isNum(v.pe_hist_pct) ? 100 - clamp(v.pe_hist_pct * (v.pe_hist_pct <= 1 ? 100 : 1), 0, 100) : isNum(v.fwd_pe) ? lin(-v.fwd_pe, -35, -12) : isNum(v.pe) ? lin(-v.pe, -40, -12) : v.kind === "bond" ? lin(v.yield, 0.03, 0.065) : 50;
    P.risk = isNum(q.vol) ? clamp(100 - lin(q.vol, goal.vol * 0.4, goal.vol * 1.8) * 0.7 - lin(-q.mdd, 0.05, 0.45) * 0.3, 0, 100) : 50;
    P.cost = isNum(er) ? lin(-er, -0.0075, -0.0003) : 50;
    P.income = isNum(yld) ? lin(yld, 0.005, goal.type === "income" ? 0.06 : 0.04) : 0;
    P.momentum = isNum(q.mom) ? lin(q.mom, -0.15, 0.30) : 50;
    P.diversification = isNum(x.effN) ? lin(Math.log(x.effN), Math.log(5), Math.log(200)) : e.kind === "core" || e.kind === "bond" ? 85 : e.kind === "ind" || e.kind === "theme" ? 30 : 55;
    let s = 0, w = 0; for (const [k, wt] of Object.entries(goal.pillars)) if (isNum(P[k])) { s += P[k] * wt; w += wt; }
    return { ...P, total: w ? s / w : NaN };
  }

  // ------------------------------------------------------------------ matrices
  const zeros = (r, c) => Array.from({ length: r }, () => new Array(c).fill(0));
  function inv(A) {
    const m = A.length, M = A.map((r, i) => [...r, ...Array.from({ length: m }, (_, j) => (i === j ? 1 : 0))]);
    for (let c = 0; c < m; c++) {
      let p = c; for (let r = c + 1; r < m; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) < 1e-14) return null; [M[c], M[p]] = [M[p], M[c]];
      const d = M[c][c]; for (let k = 0; k < 2 * m; k++) M[c][k] /= d;
      for (let r = 0; r < m; r++) if (r !== c) { const f = M[r][c]; if (f) for (let k = 0; k < 2 * m; k++) M[r][k] -= f * M[c][k]; }
    }
    return M.map((r) => r.slice(m));
  }
  const mv = (A, x) => A.map((r) => r.reduce((s, a, j) => s + a * x[j], 0));
  const quad = (A, x) => x.reduce((s, xi, i) => s + xi * A[i].reduce((t, a, j) => t + a * x[j], 0), 0);
  /**
   * Annualized covariance of daily returns, shrunk toward constant correlation (Ledoit-Wolf 2004, the closed-form
   * intensity). R: one return array per asset (same length; NaN days dropped pairwise by using the common days).
   */
  function covariance(R) {
    const k = R.length, T0 = R[0]?.length || 0, keep = []; for (let t = 0; t < T0; t++) if (R.every((r) => isNum(r[t]))) keep.push(t);
    const X = R.map((r) => keep.map((t) => r[t])), T = keep.length; if (T < 30) return null;
    const mu = X.map(mean), Y = X.map((r, i) => r.map((v) => v - mu[i]));
    const S = zeros(k, k); for (let i = 0; i < k; i++) for (let j = i; j < k; j++) { let s = 0; for (let t = 0; t < T; t++) s += Y[i][t] * Y[j][t]; S[i][j] = S[j][i] = s / T; }
    const sd = S.map((r, i) => Math.sqrt(r[i])); let rb = 0, c = 0; for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) if (sd[i] > 0 && sd[j] > 0) { rb += S[i][j] / (sd[i] * sd[j]); c++; } rb = c ? rb / c : 0;
    const F = zeros(k, k); for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) F[i][j] = i === j ? S[i][i] : rb * sd[i] * sd[j];
    let pi = 0; for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) { let s = 0; for (let t = 0; t < T; t++) s += (Y[i][t] * Y[j][t] - S[i][j]) ** 2; pi += s / T; }
    let g = 0; for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) g += (F[i][j] - S[i][j]) ** 2;
    const delta = g > 0 ? clamp(pi / T / g, 0, 1) : 1;
    return { cov: S.map((r, i) => r.map((v, j) => (delta * F[i][j] + (1 - delta) * v) * 252)), shrink: delta, days: T };
  }
  /**
   * Black-Litterman with absolute views: mu = pi + tau S (tau S + Omega)^-1 (q - pi) over the assets with a view, where
   * Omega_ii = (1 - c_i) / c_i * tau S_ii (c: confidence 0-1). pi: the prior, q: views (NaN = none).
   */
  function blackLitterman(prior, views, conf, cov, tau = TAU) {
    const k = prior.length, idx = views.map((q, i) => (isNum(q) && conf[i] > 0.01 ? i : -1)).filter((i) => i >= 0); if (!idx.length) return prior.slice();
    const A = idx.map((i) => idx.map((j) => tau * cov[i][j] + (i === j ? ((1 - conf[i]) / conf[i]) * tau * cov[i][i] : 0))), Ai = inv(A); if (!Ai) return prior.slice();
    const d = mv(Ai, idx.map((i) => views[i] - prior[i]));
    return prior.map((p, r) => p + idx.reduce((s, i, a) => s + tau * cov[r][i] * d[a], 0));
  }

  // ------------------------------------------------------------------ optimizer
  /** Euclidean projection onto {lo <= w <= hi, sum w = 1} (bisection on the shift). */
  function project(y, lo, hi) {
    let a = Math.min(...y.map((v, i) => v - hi[i])) - 1, b = Math.max(...y.map((v, i) => v - lo[i])) + 1;
    const f = (t) => y.reduce((s, v, i) => s + clamp(v - t, lo[i], hi[i]), 0) - 1;
    for (let it = 0; it < 80; it++) { const m = (a + b) / 2; if (f(m) > 0) a = m; else b = m; }
    const t = (a + b) / 2; return y.map((v, i) => clamp(v - t, lo[i], hi[i]));
  }
  /**
   * max mu.w - lam/2 w'Sw - kappa |w - w0|_1 over lo <= w <= hi, sum w = 1, and A w <= b (rows {a, b}); projected gradient
   * with an augmented Lagrangian for the linear rows and a soft threshold toward w0 for the turnover penalty.
   */
  function solve(mu, cov, { lam = 4, lo, hi, rows = [], w0 = null, kappa = 0, iters = 2500, start = null } = {}) {
    const k = mu.length; lo = lo || new Array(k).fill(0); hi = hi || new Array(k).fill(1);
    let L = 0; for (let i = 0; i < k; i++) L = Math.max(L, cov[i].reduce((s, v) => s + Math.abs(v), 0)); L = lam * L + 1e-6;
    const rho = 20, nu = rows.map(() => 0); L += rho * rows.reduce((s, r) => s + r.a.reduce((t, v) => t + v * v, 0), 0);
    const step = 1 / L; let w = project(start || w0 || new Array(k).fill(1 / k), lo, hi);
    for (let it = 0; it < iters; it++) {
      const Sw = mv(cov, w), g = mu.map((m, i) => m - lam * Sw[i]);
      rows.forEach((r, j) => { const viol = r.a.reduce((s, v, i) => s + v * w[i], 0) - r.b + nu[j] / rho; if (viol > 0) for (let i = 0; i < k; i++) g[i] -= rho * viol * r.a[i]; });
      let y = w.map((v, i) => v + step * g[i]);
      if (w0 && kappa > 0) y = y.map((v, i) => { const d = v - w0[i], t = step * kappa; return w0[i] + Math.sign(d) * Math.max(0, Math.abs(d) - t); });
      const nw = project(y, lo, hi), moved = nw.reduce((s, v, i) => Math.max(s, Math.abs(v - w[i])), 0); w = nw;
      if (moved < 1e-8 && it > 50 && rows.every((r, j) => r.a.reduce((s, v, i) => s + v * w[i], 0) <= r.b + 1e-4)) break;
      if (it % 50 === 49) rows.forEach((r, j) => { nu[j] = Math.max(0, nu[j] + rho * (r.a.reduce((s, v, i) => s + v * w[i], 0) - r.b)); });
    }
    return w;
  }
  /** The linear rows for a goal: the bond band, sector caps, the look-through cap on any one stock. A: per asset {bond 0/1, sectors {name: share}, stocks {ticker: share}}. */
  function rowsFor(assets, goal) {
    const k = assets.length, rows = [], bondA = assets.map((a) => (a.isBond ? 1 : 0));
    if (bondA.some(Boolean)) { rows.push({ a: bondA, b: goal.bonds[1], label: "bonds at most" }); if (goal.bonds[0] > 0) rows.push({ a: bondA.map((x) => -x), b: -goal.bonds[0], label: "bonds at least" }); }
    const secs = new Set(assets.flatMap((a) => Object.keys(a.sectors || {})));
    for (const s of secs) { const a = assets.map((x) => n(x.sectors?.[s]) || 0); if (a.some((v) => v > 0.2)) rows.push({ a, b: goal.sectorCap, label: `${s} at most` }); }
    const inds = new Map(); assets.forEach((x, i) => { for (const g of x.v?.industries || []) { if (!inds.has(g.industry)) inds.set(g.industry, new Array(k).fill(0)); inds.get(g.industry)[i] = n(g.weight) || 0; } });
    for (const [name, a] of inds) if (a.some((v) => v > 0.3)) rows.push({ a, b: goal.industryCap || 0.25, label: `${name} at most` });
    const tick = new Map(); assets.forEach((x, i) => { for (const [t, v] of Object.entries(x.stocks || {})) { if (!tick.has(t)) tick.set(t, new Array(k).fill(0)); tick.get(t)[i] = v; } });
    for (const [t, a] of tick) if (a.reduce((s, v) => s + v * 0.15, 0) > goal.stockCap * 0.9) rows.push({ a, b: goal.stockCap, label: `${t} at most` });
    const hard = assets.map((x) => (x.e?.kind === "gold" || x.e?.kind === "cmdty" ? 1 : 0)); if (hard.some(Boolean)) rows.push({ a: hard, b: 0.10, label: "gold and commodities at most" });
    const intl = assets.map((x) => (x.intl ? 1 : 0)); if (intl.some(Boolean)) rows.push({ a: intl, b: 0.35, label: "international at most" });
    return rows;
  }
  const pstats = (w, mu, cov, assets) => ({ expected: w.reduce((s, x, i) => s + x * mu[i], 0), vol: Math.sqrt(Math.max(0, quad(cov, w))), yield: w.reduce((s, x, i) => s + x * (n(assets[i].yield) || 0), 0),
    cost: w.reduce((s, x, i) => s + x * (n(assets[i].expense) || 0), 0), bonds: w.reduce((s, x, i) => s + (assets[i].isBond ? x : 0), 0) });
  /**
   * The portfolio for a goal: the least risk aversion whose volatility stays under the ceiling, with every position
   * between the minimum and the 15% cap and at most maxN holdings (smallest dropped, then solved again).
   */
  function construct(assets, mu, cov, goal, { maxN = goal.maxN, volCap = goal.vol, w0 = null, kappa = 0, keep = null } = {}) {
    let live = assets.map((_, i) => i);
    const cap = goal.cap / 100, minW = goal.minW / 100, obj = mu.map((m, i) => m + goal.yieldBonus * (n(assets[i].yield) || 0) - (n(assets[i].expense) || 0));
    let best = null;
    for (let round = 0; round < 5; round++) {
      const sub = (v) => live.map((i) => v[i]), C = live.map((i) => live.map((j) => cov[i][j])), A = live.map((i) => assets[i]), m = sub(obj), rows = rowsFor(A, goal);
      if (live.length * cap < 1 - 1e-9) break;
      let warm = null; const run = (lam) => (warm = solve(m, C, { lam, hi: live.map(() => cap), rows, w0: w0 ? sub(w0) : null, kappa, start: warm, iters: 1500 }));
      // Bisection on log(lambda): smallest risk aversion that keeps volatility under the ceiling.
      let a = Math.log(0.3), b = Math.log(400), wB = run(Math.exp(b));
      if (Math.sqrt(quad(C, wB)) <= volCap) { for (let it = 0; it < 12; it++) { const mid = (a + b) / 2, w = run(Math.exp(mid)); if (Math.sqrt(quad(C, w)) <= volCap) { b = mid; wB = w; } else a = mid; } }
      best = { idx: live.slice(), w: wB, lam: Math.exp(b) };
      const small = live.map((i, j) => [i, wB[j]]).filter(([i, x]) => x < minW && !(keep || []).includes(i)), over = live.length - maxN;
      const nonzero = live.filter((_, j) => wB[j] >= minW || (keep || []).includes(live[j])).length;
      if (!small.length && over <= 0) break;
      const drop = new Set(small.sort((x, y) => x[1] - y[1]).map(([i]) => i));
      if (nonzero > maxN) live.map((i, j) => [i, wB[j]]).filter(([i]) => !drop.has(i) && !(keep || []).includes(i)).sort((x, y) => x[1] - y[1]).slice(0, nonzero - maxN).forEach(([i]) => drop.add(i));
      const next = live.filter((i) => !drop.has(i)); if (next.length * cap < 1 - 1e-9 || next.length === live.length) break; live = next;
    }
    if (!best) return null;
    const W = new Array(assets.length).fill(0); best.idx.forEach((i, j) => (W[i] = best.w[j]));
    // Round to 0.5pp, the rest on the largest that still has room under the cap.
    const r = W.map((x) => (x >= minW * 0.5 ? Math.round(x * 200) / 200 : 0)); let gap = Math.round((1 - r.reduce((s, x) => s + x, 0)) * 200) / 200;
    for (const i of r.map((x, i) => i).sort((x, y) => r[y] - r[x])) { if (Math.abs(gap) < 1e-9) break; const room = gap > 0 ? cap - r[i] : r[i] - minW; const d = Math.sign(gap) * Math.min(Math.abs(gap), Math.max(0, room)); r[i] = Math.round((r[i] + d) * 200) / 200; gap = Math.round((gap - d) * 200) / 200; }
    const st = pstats(r, mu, cov, assets), rows = rowsFor(assets, goal);
    return { w: r, lam: best.lam, ...st, n: r.filter((x) => x > 0).length, binding: rows.filter((row) => row.a.reduce((s, v, i) => s + v * r[i], 0) > row.b - 0.005).map((row) => row.label),
      violated: rows.filter((row) => row.a.reduce((s, v, i) => s + v * r[i], 0) > row.b + 0.01).map((row) => `${row.label} ${row.b < 0 ? (-row.b * 100).toFixed(0) : (row.b * 100).toFixed(0)}%`) };
  }

  // ------------------------------------------------------------------ the recommendation
  /**
   * Shortlist, expected returns, risk and the three portfolios. cands: [{symbol, e, info, q, v, yld, pill, sectors, stocks, expense}].
   * series: {sym: {dates, closes}} with SPY. Returns {assets, mu, prior, cov, portfolios: {recommended, simpler, bolder}}.
   */
  function recommend(cands, series, goal, { size = 30, force = [] } = {}) {
    const spy = series.SPY; if (!spy?.dates?.length) throw new Error("no SPY prices");
    const ok = cands.filter((c) => c.ok !== false && series[c.symbol]?.dates?.length > 300);
    // Shortlist: the best by the goal's pillars within each group, so the optimizer sees stocks, bonds and diversifiers.
    const by = (f) => ok.filter(f).sort((a, b) => (n(b.pill?.total) || 0) - (n(a.pill?.total) || 0));
    const bondsN = goal.bonds[1] > 0 ? (goal.bonds[1] >= 0.5 ? 10 : 6) : 0, pick = new Map();
    for (const c of by((c) => isBond(c.e)).slice(0, bondsN)) pick.set(c.symbol, c);
    for (const c of by((c) => ["core", "size", "style", "div", "intl"].includes(c.e.kind)).slice(0, 10)) pick.set(c.symbol, c);
    for (const c of by((c) => ["sector", "ind", "theme"].includes(c.e.kind)).slice(0, 12)) pick.set(c.symbol, c);
    for (const c of by((c) => c.e.kind === "gold" || c.e.kind === "cmdty").slice(0, 2)) pick.set(c.symbol, c);
    for (const c of by(() => true)) { if (pick.size >= size) break; pick.set(c.symbol, c); }
    for (const c of ok.filter((c) => force.includes(c.symbol))) pick.set(c.symbol, c); // today's ETFs, for the improver
    // One fund per exposure: drop near-duplicates (the same index from another issuer), keeping the better score.
    const assets = [...pick.values()].sort((a, b) => (n(b.pill?.total) || 0) - (n(a.pill?.total) || 0));
    const R0 = aligned(series, [...assets.map((a) => a.symbol), "SPY"], spy.dates, 756), keepA = [], keepR = [];
    // The same exposure: near-identical daily returns, the same tagged sector or industries, or mostly the same stocks.
    const tag = (a) => (a.e.kind === "sector" ? "S:" + a.e.sector : a.e.kind === "ind" ? "I:" + [...a.e.industries].sort().join(";") : a.e.bond ? "B:" + a.e.bond + ":" + Math.round((a.e.duration || 0) / 3) : null);
    const overlap = (x, y) => { let s = 0; for (const [t, v] of Object.entries(x.stocks || {})) s += Math.min(v, n(y.stocks?.[t]) || 0); return s; };
    assets.forEach((a, i) => { const r = R0[i], t = tag(a); const dup = keepA.findIndex((b, j) => (force.includes(a.symbol) && force.includes(b.symbol) ? false : corr(r, keepR[j]) > 0.985 || (t && t === tag(b)) || overlap(a, b) > 0.6));
      if (dup < 0 || force.includes(a.symbol) && !force.includes(keepA[dup].symbol)) { keepA.push(a); keepR.push(r); } else (keepA[dup].twins ||= []).push(a.symbol); });
    const C = covariance(keepR); if (!C) throw new Error("not enough common price history");
    const cov = C.cov, A = keepA.map((a) => ({ ...a, isBond: isBond(a.e), intl: a.e.intl, yield: n(a.yld) || 0, expense: n(a.info?.expenseRatio) / 100 || 0 }));
    const prior = A.map((a) => RF + (isNum(a.q?.beta) ? a.q.beta : 1) * ERP), views = A.map((a) => n(a.v?.expected)), conf = A.map((a) => n(a.v?.conf) || 0);
    const mu = blackLitterman(prior, views, conf, cov);
    const rec = construct(A, mu, cov, goal), simpler = construct(A, mu, cov, goal, { maxN: goal.minN }), bolder = construct(A, mu, cov, { ...goal, bonds: [Math.max(0, goal.bonds[0] - 0.15), Math.max(0, goal.bonds[1] - 0.1)], sectorCap: goal.sectorCap + 0.1, industryCap: (goal.industryCap || 0.25) + 0.05, stockCap: goal.stockCap + 0.02, minW: 4 }, { volCap: goal.vol * 1.3, maxN: goal.minN });
    return { assets: A, mu, prior, views, conf, cov, shrink: C.shrink, days: C.days, portfolios: { recommended: rec, simpler, bolder } };
  }
  function corr(a, b) { const p = a.map((x, i) => [x, b[i]]).filter(([x, y]) => isNum(x) && isNum(y)); if (p.length < 30) return 0; const ma = mean(p.map((x) => x[0])), mb = mean(p.map((x) => x[1])); let c = 0, va = 0, vb = 0; for (const [x, y] of p) { c += (x - ma) * (y - mb); va += (x - ma) ** 2; vb += (y - mb) ** 2; } return va > 0 && vb > 0 ? c / Math.sqrt(va * vb) : 0; }

  // ------------------------------------------------------------------ the improver
  /**
   * Today's holdings as ETF weights: ETFs in the universe stay; a stock goes to the ETF holding the most of its industry
   * (else its sector's); a fund or ETF outside the universe to the candidate with the closest sector mix.
   * holdings: [{ticker, weight (%), asset_type, sector, industry, sectors?}]; assets: the recommendation's assets.
   */
  function mapCurrent(holdings, assets) {
    const w0 = new Array(assets.length).fill(0), map = [], idx = new Map(assets.map((a, i) => [a.symbol, i])), tot = holdings.reduce((s, h) => s + (n(h.weight) || 0), 0) || 1;
    const cos = (x, y) => { const ks = new Set([...Object.keys(x || {}), ...Object.keys(y || {})]); let d = 0, a = 0, b = 0; for (const k of ks) { const u = n(x?.[k]) || 0, v = n(y?.[k]) || 0; d += u * v; a += u * u; b += v * v; } return a > 0 && b > 0 ? d / Math.sqrt(a * b) : 0; };
    for (const h of holdings) {
      const w = (n(h.weight) || 0) / tot; let to = idx.get(h.ticker), how = "kept";
      if (to === undefined && h.asset_type === "stock" && h.industry) { let b = -1; assets.forEach((a, i) => { const s = (a.v?.industries || []).find((g) => lc(g.industry) === lc(h.industry))?.weight || (a.e.industries || []).map(lc).includes(lc(h.industry)) * 0.5; if (s > b && !a.isBond) { b = s; to = i; } }); if (b <= 0) to = undefined; else how = `its industry (${h.industry})`; }
      if (to === undefined && h.sector) { const sx = h.sectors || { [h.sector]: 1 }; let b = 0; assets.forEach((a, i) => { const s = cos(sx, a.sectors); if (s > b && !a.isBond) { b = s; to = i; } }); if (to !== undefined) how = "the closest sector mix"; }
      if (to === undefined) { to = assets.findIndex((a) => a.e.kind === "core"); how = "the total market"; }
      if (to >= 0) { w0[to] += w; map.push({ ticker: h.ticker, weight: w, to: assets[to].symbol, how }); }
    }
    return { w0, map };
  }
  /** The improvement: the optimizer from today's mapped weights with a turnover penalty; before and after. */
  function improve(rec, holdings, goal, { kappa = 0.02 } = {}) {
    const { assets, mu, cov } = rec, { w0, map } = mapCurrent(holdings, assets);
    const after = construct(assets, mu, cov, goal, { w0, kappa, keep: w0.map((x, i) => (x > 0.03 ? i : -1)).filter((i) => i >= 0) });
    const before = { w: w0, ...pstats(w0, mu, cov, assets), n: w0.filter((x) => x > 0.001).length };
    const turnover = after ? after.w.reduce((s, x, i) => s + Math.abs(x - w0[i]), 0) / 2 : NaN;
    return { before, after, map, turnover };
  }

  // ------------------------------------------------------------------ stress and look-through
  /** Named episodes (where the prices reach back) and hypothetical shocks, for weights over assets. */
  const EPISODES = [["COVID crash", "2020-02-19", "2020-03-23"], ["2022 rate shock", "2022-01-03", "2022-10-12"], ["2023 regional-bank scare", "2023-03-08", "2023-03-15"], ["Aug 2024 carry unwind", "2024-07-16", "2024-08-05"], ["April 2025 tariff shock", "2025-02-19", "2025-04-08"]];
  function stress(w, assets, series) {
    const px = (s, d) => { const m = mapOf(series[s]); const ks = [...m.keys()].filter((x) => x <= d).sort(); return ks.length ? m.get(ks[ks.length - 1]) : NaN; };
    const out = [];
    for (const [label, a, b] of EPISODES) {
      let s = 0, cov = 0; assets.forEach((x, i) => { if (!(w[i] > 0)) return; const p0 = px(x.symbol, a), p1 = px(x.symbol, b), first = series[x.symbol]?.dates?.[0]; if (p0 > 0 && p1 > 0 && first <= a) { s += w[i] * (p1 / p0 - 1); cov += w[i]; } });
      const spy = px("SPY", b) / px("SPY", a) - 1; if (cov > 0.8) out.push({ label, from: a, to: b, ret: s / cov, spy, covered: cov });
    }
    const beta = assets.reduce((s, x, i) => s + (w[i] || 0) * (n(x.q?.beta) || (x.isBond ? 0 : 1)), 0);
    const rates = assets.reduce((s, x, i) => s + (w[i] || 0) * (x.isBond ? n(x.v?.rates_up_1pp) || 0 : -0.04 * (n(x.q?.beta) || 1)), 0);
    const credit = assets.reduce((s, x, i) => s + (w[i] || 0) * (x.isBond ? n(x.v?.credit_stress) || 0 : -0.15 * (n(x.q?.beta) || 1)), 0);
    return { episodes: out, hypo: [{ label: "Stocks fall 20%", ret: -0.2 * beta }, { label: "Rates up 1pp (10-year)", ret: rates }, { label: "Credit crunch (spreads widen, stocks fall)", ret: credit }] };
  }
  /** The portfolio's look-through: industries and single stocks, summed across its ETFs (weights 0-1). */
  function exposure(w, assets) {
    const ind = {}, sec = {}, st = {};
    assets.forEach((a, i) => { const x = w[i] || 0; if (!x) return;
      for (const g of a.v?.industries || []) ind[g.industry] = (ind[g.industry] || 0) + x * g.weight;
      for (const [s, v] of Object.entries(a.sectors || {})) sec[s] = (sec[s] || 0) + x * v;
      for (const [t, v] of Object.entries(a.stocks || {})) st[t] = (st[t] || 0) + x * v; });
    const top = (o, k) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, k).map(([name, weight]) => ({ name, weight }));
    return { industries: top(ind, 12), sectors: top(sec, 12), stocks: top(st, 15) };
  }

  // ------------------------------------------------------------------ the analyst's write-up
  const pc = (x, d = 1) => (isNum(x) ? `${(x * 100).toFixed(d)}%` : "n/a");
  /** The facts the analyst writes from, each with an id: G (goal), P (portfolio), E# (each ETF), S# (stress), X (exposure), A# (alternatives). */
  function dossier(goal, rec, key, { improveRes = null, exposureRes = null, stressRes = null, curve = null } = {}) {
    const P = rec.portfolios[key], A = rec.assets, L = [];
    L.push(`[G1] Goal: ${goal.label}, horizon ${goal.horizon}, volatility ceiling ${pc(goal.vol, 0)}, bonds ${pc(goal.bonds[0], 0)}-${pc(goal.bonds[1], 0)}, every ETF at most ${goal.cap}%, ${goal.minN}-${goal.maxN} ETFs, US only${goal.intl ? " plus international" : ""}.`);
    L.push(`[P1] This portfolio (${key}): expected ${pc(P.expected)} a year (Black-Litterman: CAPM prior moved toward the industry and bond views), volatility ${pc(P.vol)}, yield ${pc(P.yield, 2)}, cost ${pc(P.cost, 2)}, bonds ${pc(P.bonds, 0)}, ${P.n} ETFs. Binding limits: ${P.binding.join(", ") || "none"}.`);
    if (curve) L.push(`[R1] Treasury curve today: 3M ${curve.month3}%, 2Y ${curve.year2}%, 10Y ${curve.year10}%, 30Y ${curve.year30}%.`);
    A.forEach((a, i) => { if (!(P.w[i] > 0)) return; const v = a.v || {};
      const ind = v.kind === "bond" ? `${v.label}; ${v.why}; +1pp rates ${pc(v.rates_up_1pp)}${v.credit_stress ? `, credit stress ${pc(v.credit_stress)}` : ""}` : `industries covered ${pc(v.on, 0)}; ${goal.type} score ${isNum(v.score) ? v.score.toFixed(0) : "n/a"}; ${goal.horizon} call ${v.call || "n/a"}; expected (industry runs) ${pc(v.expected)}; P/E ${isNum(v.pe) ? v.pe.toFixed(1) : "n/a"}; biggest industries ${(v.industries || []).slice(0, 4).map((g) => `${g.industry} ${pc(g.weight, 0)}`).join(", ")}; pulling up: ${(v.top || []).slice(0, 2).map((x) => `${x.industry} (${x.call || "?"}, ${isNum(x.expected) ? x.expected.toFixed(1) + "%" : "n/a"})`).join(", ") || "n/a"}`;
      L.push(`[E${i + 1}] ${a.symbol} ${a.info?.name || ""} (${KIND_LABEL[a.e.kind]}): weight ${pc(P.w[i], 1)}; cost ${pc(a.expense, 2)}; assets $${(n(a.info?.assetsUnderManagement) / 1e9).toFixed(1)}B; yield ${pc(a.yield, 2)}; vol ${pc(a.q?.vol)}, beta ${isNum(a.q?.beta) ? a.q.beta.toFixed(2) : "n/a"}, 1Y ${pc(a.q?.r1y)}; prior ${pc(rec.prior[i])} -> posterior ${pc(rec.mu[i])}; pillars ${Object.entries(a.pill || {}).filter(([k]) => k !== "total").map(([k, x]) => `${k} ${isNum(x) ? x.toFixed(0) : "n/a"}`).join(", ")}; ${ind}.${a.twins?.length ? ` Same exposure as ${a.twins.join(", ")}.` : ""}`); });
    if (exposureRes) L.push(`[X1] Look-through: industries ${exposureRes.industries.slice(0, 6).map((x) => `${x.name} ${pc(x.weight)}`).join(", ")}; top stocks ${exposureRes.stocks.slice(0, 6).map((x) => `${x.name} ${pc(x.weight)}`).join(", ")}.`);
    (stressRes?.episodes || []).forEach((s, i) => L.push(`[S${i + 1}] ${s.label} (${s.from} to ${s.to}): portfolio ${pc(s.ret)}, SPY ${pc(s.spy)}.`));
    (stressRes?.hypo || []).forEach((s, i) => L.push(`[S${i + 6}] ${s.label}: about ${pc(s.ret)}.`));
    const outs = A.map((a, i) => ({ a, i })).filter(({ i }) => !(P.w[i] > 0)).sort((x, y) => (n(y.a.pill?.total) || 0) - (n(x.a.pill?.total) || 0)).slice(0, 5);
    outs.forEach(({ a, i }, j) => L.push(`[A${j + 1}] Left out: ${a.symbol} (${KIND_LABEL[a.e.kind]}): goal score ${isNum(a.pill?.total) ? a.pill.total.toFixed(0) : "n/a"}, posterior ${pc(rec.mu[i])}, vol ${pc(a.q?.vol)}.`));
    if (improveRes) { L.push(`[M1] Today's portfolio mapped to ETFs: ${improveRes.map.map((m) => `${m.ticker} -> ${m.to}`).join(", ")}. Before: expected ${pc(improveRes.before.expected)}, vol ${pc(improveRes.before.vol)}, yield ${pc(improveRes.before.yield, 2)}, cost ${pc(improveRes.before.cost, 2)}. After: expected ${pc(improveRes.after?.expected)}, vol ${pc(improveRes.after?.vol)}. Turnover ${pc(improveRes.turnover, 0)}.`); }
    return L.join("\n");
  }
  function writePrompt(goal, dossierText, { improving = false, industryReads = "" } = {}) {
    return `You are the lead portfolio strategist explaining an ETF ${improving ? "portfolio improvement" : "portfolio recommendation"} for a ${goal.label.toLowerCase()} investor. The weights were set by an optimizer from the facts below; do not change them or invent numbers.

Write for an investor who is smart but not a professional. Every claim cites the fact ids in brackets, like [E2] or [S1]; use only ids that appear below. Lean on the industry runs' reads, do not repeat the table.

Facts:
${dossierText}
${industryReads ? `\nThe industry runs' own reads for the industries these ETFs hold most:\n${industryReads}\n` : ""}
Return JSON only:
{"headline": "one sentence on what this portfolio is betting on",
 "summary": "3-4 sentences: the shape of the portfolio and why it suits the goal",
 "etfs": [{"symbol": "ETF", "role": "core | growth tilt | income | ballast | diversifier | hedge", "why": "2 sentences: what it adds, tied to the industry or bond view", "watch": "what would make it a sell"}],
 "risks": ["3 risks, each tied to a stress or exposure fact"],
 "changes_mind": ["2-3 things that would change the recommendation"],
 ${improving ? '"diagnosis": ["3-5 problems with the current portfolio, with ids"],\n ' : ""}"left_out": "1-2 sentences on the strongest ETFs left out and why"}`;
  }
  function cleanWrite(x, ids) {
    const ok = new Set(ids), fix = (s) => String(s || "").replace(/\[([A-Z]{1,2}\d{1,3})\]/g, (m, id) => (ok.has(id) ? m : "")).replace(/\s+([.,;])/g, "$1").trim();
    if (!x || typeof x !== "object") return null;
    return { headline: fix(x.headline), summary: fix(x.summary), etfs: (Array.isArray(x.etfs) ? x.etfs : []).map((e) => ({ symbol: String(e?.symbol || "").toUpperCase(), role: String(e?.role || "").slice(0, 30), why: fix(e?.why), watch: fix(e?.watch) })).filter((e) => e.symbol),
      risks: (Array.isArray(x.risks) ? x.risks : []).map(fix).filter(Boolean).slice(0, 5), changes_mind: (Array.isArray(x.changes_mind) ? x.changes_mind : []).map(fix).filter(Boolean).slice(0, 4),
      diagnosis: (Array.isArray(x.diagnosis) ? x.diagnosis : []).map(fix).filter(Boolean).slice(0, 6), left_out: fix(x.left_out) };
  }
  const idsOf = (text) => [...new Set([...String(text).matchAll(/^\[([A-Z]{1,2}\d{1,3})\]/gm)].map((m) => m[1]))];

  const EtfRec = { RF, ERP, CAP, UNIVERSE, BY, KIND_LABEL, BOND_LABEL, GOALS, goalOf, isBond, isStock, screen, aligned, quantFacts, curveAt, bondView, equityView, tagView, pillars, covariance, blackLitterman, inv, project, solve, rowsFor, construct, recommend, mapCurrent, improve, stress, exposure, dossier, writePrompt, cleanWrite, idsOf, corr };
  if (typeof module !== "undefined" && module.exports) module.exports = EtfRec;
  else root.EtfRec = EtfRec;
})(typeof globalThis !== "undefined" ? globalThis : this);
