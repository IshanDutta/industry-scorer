/* Industry Scorer: an ETF or mutual fund, seen through the industries it holds.
 *
 * Code only (no I/O). Step 1 of the fund analysis: read a fund from both sources (FMP: every holding with its
 * ticker and weight, refreshed daily; EODHD: the fund's facts, its asset mix, and for ETFs each holding's own
 * sector and industry), sort every holding into what it is (a US stock, a foreign listing, a private company,
 * cash, a derivative), match each US stock to an industry (the saved industry runs first, then EODHD's label,
 * then an FMP profile), and report how much of the fund the saved industry analysis covers.
 */
(function (root) {
  "use strict";
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const n = (x) => { if (x === null || x === undefined || x === "") return NaN; const v = Number(String(x).replace(/[%,\s]/g, "")); return v; };
  const lc = (s) => String(s || "").toLowerCase();
  const SECTORS = ["Technology", "Financial Services", "Consumer Cyclical", "Consumer Defensive", "Basic Materials", "Communication Services", "Healthcare", "Industrials", "Energy", "Utilities", "Real Estate"];
  const SECTOR_ALIAS = { "consumer cyclicals": "Consumer Cyclical", "consumer staples": "Consumer Defensive", "health care": "Healthcare", "materials": "Basic Materials", "information technology": "Technology", "financials": "Financial Services", "consumer discretionary": "Consumer Cyclical", "telecommunication services": "Communication Services" };
  const sectorName = (s) => { const k = lc(s).trim(); return SECTOR_ALIAS[k] || SECTORS.find((x) => lc(x) === k) || null; };
  const SPDR = { Technology: "XLK", "Financial Services": "XLF", "Consumer Cyclical": "XLY", "Consumer Defensive": "XLP", "Basic Materials": "XLB",
    "Communication Services": "XLC", Healthcare: "XLV", Industrials: "XLI", Energy: "XLE", Utilities: "XLU", "Real Estate": "XLRE" };

  /** "Alphabet Inc. Class A", "ALPHABET INC CL A" -> "alphabet": what's left of a name once legal forms and share classes go. */
  function nameKey(s) {
    return lc(s).replace(/[&+]/g, " ").replace(/\band\b/g, " ").replace(/\((?:the)\)|\(.*?\)/g, " ").replace(/[.,/'’]/g, " ")
      .replace(/\b(class|cl|series|ser)\s+[a-z0-9-]{1,3}\b/g, " ").replace(/\b(non\s*vtg|non\s*voting|vtg|shs|shares|ordinary|common|stock|ads|adr|sponsored|new|old)\b/g, " ")
      .replace(/\b(the|inc|incorporated|corp|corporation|co|company|companies|plc|ltd|limited|sa|nv|ag|se|holdings?|group|llc|lp)\b/g, " ")
      .replace(/[^a-z0-9]+/g, " ").trim();
  }
  /** "BRK-B", "BRK.B", "BRK/B" -> "BRK-B"; the root ("BRK") for matching another share class. */
  const tick = (t) => String(t || "").trim().toUpperCase().replace(/[/ ]/g, "-");
  const tickRoot = (t) => tick(t).replace(/-[A-Z]{1,2}$/, "");
  // An exchange suffix (SHOP.TO, 000660.KS, BATS.L): a listing outside the US. A US share class is "-" plus a letter (FMP) or
  // "." plus a letter (BRK.B), so a one-letter suffix only counts as foreign when it's an exchange's (London, Tokyo, ...).
  const EXCH = new Set(["L", "T", "F", "V", "TO", "CN", "NE", "KS", "KQ", "HE", "AS", "BR", "PA", "DE", "SW", "MI", "MC", "ST", "CO", "OL", "IR", "LS", "VI", "WA", "HK", "SS", "SZ", "TW", "TWO",
    "AX", "NZ", "SA", "MX", "JO", "BO", "NS", "SI", "TA", "KL", "BK", "JK", "IS", "AT", "PR", "BD", "XC", "SN", "LIM", "BA", "SG", "DU", "MU", "BE", "HM", "XETRA", "TSE", "LSE"]);
  const isForeign = (t) => { const s = String(t || "").trim().toUpperCase(), m = s.match(/\.([A-Z]{1,5})$/); return /^\d/.test(s) || (!!m && EXCH.has(m[1])); };
  const CASH_RE = /\b(us dollars?|u\.?s\.? dollar|cash|money market|cash central fund|treasury bills?|t-bills?|repo|repurchase|sweep|government (?:money|portfolio)|liquidity fund)\b/i;
  const DERIV_RE = /\b(futures?|e-?mini|index contracts?|swaps?|options?|forwards?|cvr|contra)\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\d{2}\b/i;
  const FUT_TICK_RE = /^[A-Z]{1,4}[FGHJKMNQUVXZ]\d$/; // IXRZ6: an exchange futures code
  const BOND_RE = /\d(?:\.\d+)?\s?%\s+\d{1,2}\/\d{1,2}\/\d{2,4}|\bnotes? due\b|\bbonds?\b|\bdebentures?\b/i;
  const PRIVATE_RE = /\bseries [a-z0-9-]+\b|\bunits?\b|\bpbc\b|\block ?up\b|\bllc\b/i;

  /** What one holding is: stock (US listing), foreign (listed abroad), private (no listing), cash, derivative, bond, other. */
  function kindOf(h) {
    const t = tick(h.ticker), name = h.name || "";
    if (CASH_RE.test(name) && !t) return "cash";
    // Company names can contain these words (Option Care Health), so they only count for a line with no ticker.
    if ((!t && DERIV_RE.test(name)) || (t && FUT_TICK_RE.test(t))) return "derivative";
    if (!t && BOND_RE.test(name)) return "bond";
    if (t && isForeign(t)) return "foreign";
    if (t) return CASH_RE.test(name) && /\bfund\b/i.test(name) ? "cash" : "stock";
    if (CASH_RE.test(name)) return "cash";
    return PRIVATE_RE.test(name) || h.name ? "private" : "other";
  }

  /** FMP etfAndMutualFunds "holdings" rows -> [{ticker, name, isin, weight (0-1), value, shares, date}]. */
  function fromFmp(rows) {
    return (rows || []).filter((r) => r && (r.asset || r.name)).map((r) => ({ ticker: tick(r.asset), name: String(r.name || "").trim(), isin: r.isin || "", cusip: r.securityCusip || "",
      weight: isNum(n(r.weightPercentage)) ? n(r.weightPercentage) / 100 : NaN, value: n(r.marketValue), shares: n(r.sharesNumber), date: String(r.updatedAt || "").slice(0, 10) }));
  }
  /** EODHD ETF_Data.Holdings (all of an ETF's holdings, each with its sector and industry) -> the same shape plus sector/industry. */
  function fromEodEtf(f) {
    const H = f?.ETF_Data?.Holdings || {};
    return Object.values(H).filter(Boolean).map((r) => ({ ticker: tick(r.Code), name: String(r.Name || "").trim(), weight: isNum(n(r["Assets_%"])) ? n(r["Assets_%"]) / 100 : NaN,
      sector: sectorName(r.Sector), industry: r.Industry || "", country: r.Country || "", exchange: r.Exchange || "" }));
  }
  /** EODHD's top holdings for a mutual fund (names and weights only, from the last filing). */
  function eodTop(f) {
    if (f?.ETF_Data) return Object.values(f.ETF_Data.Top_10_Holdings || {}).map((r) => ({ name: r.Name, ticker: tick(r.Code), weight: n(r["Assets_%"]) / 100 }));
    return Object.values(f?.Top_Holdings || {}).map((r) => ({ name: r.Name, ticker: "", weight: n(r.Weight) / 100 })).filter((r) => isNum(r.weight));
  }

  const pct01 = (v) => (isNum(n(v)) ? n(v) / 100 : null);
  /** The fund's facts from both sources, EODHD first where it has them, FMP filling the rest. */
  function facts(sym, fmpInfo, eod) {
    const I = Array.isArray(fmpInfo) ? fmpInfo[0] || {} : fmpInfo || {}, G = eod?.General || {}, E = eod?.ETF_Data || null, M = eod && !E ? eod : null;
    const type = G.Type === "ETF" || E ? "ETF" : G.Type === "FUND" || M ? "Mutual fund" : I.avgVolume === 0 ? "Mutual fund" : "ETF";
    // Asset mix: ETFs file it as an object keyed by type, mutual funds as a numbered list.
    const mix = {}; const add = (k, v) => { if (!isNum(n(v))) return; const key = /non.?us/i.test(k) ? "stock_nonus" : /stock/i.test(k) ? "stock_us" : /cash/i.test(k) ? "cash" : /bond/i.test(k) ? "bond" : "other"; mix[key] = (mix[key] || 0) + n(v) / 100; };
    if (E?.Asset_Allocation) for (const [k, v] of Object.entries(E.Asset_Allocation)) add(k, v?.["Net_Assets_%"]);
    if (M?.Asset_Allocation) for (const v of Object.values(M.Asset_Allocation)) add(v?.Type || "", v?.["Net_%"]);
    const sectors = {};
    if (E?.Sector_Weights) for (const [k, v] of Object.entries(E.Sector_Weights)) { const s = sectorName(k); if (s && isNum(n(v?.["Equity_%"]))) sectors[s] = n(v["Equity_%"]) / 100; }
    if (M?.Sector_Weights) for (const grp of ["Cyclical", "Defensive", "Sensitive"]) for (const v of Object.values(M.Sector_Weights[grp] || {})) { const s = sectorName(v?.Name); if (s && isNum(n(v["Amount_%"]))) sectors[s] = n(v["Amount_%"]) / 100; }
    if (!Object.keys(sectors).length) for (const x of I.sectorsList || []) { const s = sectorName(x.industry); if (s && isNum(n(x.exposure))) sectors[s] = n(x.exposure) / 100; }
    const P = E ? eod?.ETF_Data?.Performance || {} : {};
    return {
      symbol: sym, type, name: G.Name || I.name || sym, family: E?.Company_Name || G.Fund_Family || I.etfCompany || "", category: (G.Category || G.Fund_Category || "").replace(/^Unclassified$/i, "") || I.assetClass || "",
      description: G.Description || G.Fund_Summary || I.description || "", inception: E?.Inception_Date || M?.Inception_Date || I.inceptionDate || "",
      expense: isNum(n(E?.NetExpenseRatio)) && n(E.NetExpenseRatio) > 0 ? n(E.NetExpenseRatio) : pct01(M?.Expense_Ratio) ?? pct01(I.expenseRatio),
      aum: n(E?.TotalAssets) > 0 ? n(E.TotalAssets) : n(M?.Portfolio_Net_Assets) > 0 ? n(M.Portfolio_Net_Assets) : n(I.assetsUnderManagement) || null,
      turnover: isNum(n(E?.AnnualHoldingsTurnover)) ? n(E.AnnualHoldingsTurnover) : null, yield: pct01(E?.Yield ?? M?.Yield),
      holdings_count: n(E?.Holdings_Count) || n(I.holdingsCount) || null, nav: n(M?.Nav ?? I.nav) || null,
      mix: Object.keys(mix).length ? mix : null, sectors, eod_date: G.UpdatedAt || M?.Update_Date || "", fmp_date: String(I.updatedAt || "").slice(0, 10),
      perf: E ? { vol_1y: pct01(P["1y_Volatility"]), vol_3y: pct01(P["3y_Volatility"]), sharpe_3y: n(P["3y_SharpRatio"]), ret_ytd: pct01(P.Returns_YTD), ret_1y: pct01(P.Returns_1Y), ret_3y: pct01(P.Returns_3Y), ret_5y: pct01(P.Returns_5Y), ret_10y: pct01(P.Returns_10Y), beta: n(eod?.Technicals?.Beta) }
        : M ? { ret_ytd: pct01(M.Yield_YTD), ret_1y: pct01(M.Yield_1Year_YTD), ret_3y: pct01(M.Yield_3Year_YTD), ret_5y: pct01(M.Yield_5Year_YTD) } : {},
    };
  }

  /**
   * The ticker -> industry lookup: every company in the saved runs (coIndex.cos: {symbol: {industry, slug, sector, name, rank}}),
   * by ticker, by the root of another share class (GOOGL -> GOOG kept by the run, BRK-B -> BRK-A), and by name.
   */
  function lookup(cos) {
    const byT = new Map(), byRoot = new Map(), byName = new Map();
    for (const [sym, c] of Object.entries(cos || {})) { const t = tick(sym); byT.set(t, c); if (!byRoot.has(tickRoot(t))) byRoot.set(tickRoot(t), c); const k = nameKey(c.name); if (k && !byName.has(k)) byName.set(k, c); }
    return (h) => {
      const t = tick(h.ticker);
      if (t && byT.has(t)) return { c: byT.get(t), via: "saved runs" };
      const k = nameKey(h.name);
      if (k && byName.has(k)) return { c: byName.get(k), via: "saved runs (another share class)" };
      if (t && byRoot.has(tickRoot(t)) && tickRoot(t) !== t && k && nameKey(byRoot.get(tickRoot(t)).name).split(" ")[0] === k.split(" ")[0]) return { c: byRoot.get(tickRoot(t)), via: "saved runs (another share class)" };
      return null;
    };
  }

  /**
   * Every holding with what it is and its industry. fmpH/eodH: holdings from each source (FMP is the main list;
   * EODHD's own list fills in for an ETF FMP has nothing for). cos: the saved runs' companies. profiles: {TICKER:
   * {industry, sector}} already looked up from FMP. Returns [{ticker, name, weight, kind, industry, sector, slug, via, top50}].
   */
  function mapHoldings(fmpH, eodH, cos, profiles = {}) {
    const base = fmpH?.length ? fmpH : eodH || [];
    const eodBy = new Map((eodH || []).map((h) => [tick(h.ticker), h]));
    const find = lookup(cos);
    return base.filter((h) => isNum(h.weight) && h.weight > 0).map((h) => {
      const kind = kindOf(h), out = { ticker: h.ticker, name: h.name, weight: h.weight, kind, industry: null, sector: null, slug: null, via: null, top50: false, rank: null };
      if (kind !== "stock") return out;
      const r = find(h);
      if (r) return { ...out, industry: r.c.industry, sector: r.c.sector || null, slug: r.c.slug, via: r.via, top50: true, rank: r.c.rank ?? null, run_symbol: r.c.symbol };
      const e = eodBy.get(tick(h.ticker)) || (h.industry ? h : null);
      if (e?.industry) return { ...out, industry: e.industry, sector: e.sector || null, via: "EODHD" };
      const p = profiles[tick(h.ticker)];
      if (p?.industry) return { ...out, industry: p.industry, sector: sectorName(p.sector) || p.sector || null, via: "FMP profile" };
      return out;
    });
  }
  /** The US stocks still without an industry, biggest first: the FMP profile lookups worth making (at most `max`). */
  function needProfiles(mapped, max = 25, minWeight = 0.0005) {
    return mapped.filter((h) => h.kind === "stock" && !h.industry && h.ticker && h.weight >= minWeight).sort((a, b) => b.weight - a.weight).slice(0, max).map((h) => h.ticker);
  }

  /**
   * How much of the fund the saved analysis covers. runs: {slug: {name, saved_at}} (coIndex.runs); runBySlugName
   * maps an industry name to its saved run. staleDays: a run older than this counts as stale. Every share is of
   * the fund's total weight in the holdings list.
   */
  function coverage(mapped, runs, { now = new Date().toISOString().slice(0, 10), staleDays = 14, quant = {} } = {}) {
    const runByName = new Map(Object.entries(runs || {}).map(([sl, r]) => [lc(r.name), { slug: sl, ...r }]));
    // Industries with only the code-only fill (data and scores, no analyst team): {slug: {name, sector, saved_at}}.
    const quantByName = new Map(Object.entries(quant || {}).map(([sl, r]) => [lc(r.name), { slug: sl, ...r }]));
    const ageOf = (iso) => (iso ? Math.round((Date.parse(now) - Date.parse(String(iso).slice(0, 10))) / 864e5) : null);
    const total = mapped.reduce((a, h) => a + h.weight, 0) || 1;
    const B = { analyzed: 0, stale: 0, quant: 0, not_analyzed: 0, unmapped: 0, foreign: 0, private: 0, cash: 0, derivative: 0, bond: 0, other: 0 };
    const inds = new Map();
    for (const h of mapped) {
      if (h.kind !== "stock") { B[h.kind] = (B[h.kind] || 0) + h.weight; continue; }
      if (!h.industry) { B.unmapped += h.weight; continue; }
      const full = runByName.get(lc(h.industry)), q = full ? null : quantByName.get(lc(h.industry)), run = full || q, age = run ? ageOf(run.saved_at) : null;
      const status = full ? (age !== null && age > staleDays ? "stale" : "analyzed") : q && (age === null || age <= staleDays) ? "quant" : "not_analyzed";
      B[status] += h.weight;
      const key = lc(h.industry);
      if (!inds.has(key)) inds.set(key, { industry: run?.name || h.industry, sector: h.sector || run?.sector || null, slug: run?.slug || null, status, saved_at: run?.saved_at || null, age, weight: 0, holdings: 0, in_top50: 0, top: [] });
      const g = inds.get(key); g.weight += h.weight; g.holdings++; if (h.top50) g.in_top50 += h.weight; g.top.push(h);
    }
    for (const k of Object.keys(B)) B[k] /= total;
    const industries = [...inds.values()].map((g) => ({ ...g, weight: g.weight / total, in_top50: g.in_top50 / total, top: g.top.sort((a, b) => b.weight - a.weight).slice(0, 5).map((h) => ({ ticker: h.ticker, name: h.name, weight: h.weight / total, top50: h.top50 })) }))
      .sort((a, b) => b.weight - a.weight);
    const sectors = {}; for (const g of industries) if (g.sector) sectors[g.sector] = (sectors[g.sector] || 0) + g.weight;
    const outside = mapped.filter((h) => h.kind !== "stock" || !h.industry).sort((a, b) => b.weight - a.weight).slice(0, 25).map((h) => ({ ticker: h.ticker, name: h.name, weight: h.weight / total, kind: h.kind === "stock" ? "unmapped" : h.kind }));
    const viaW = {}; for (const h of mapped) if (h.via) viaW[h.via] = (viaW[h.via] || 0) + h.weight / total;
    return { buckets: B, covered: B.analyzed + B.stale + B.quant, covered_full: B.analyzed + B.stale, us_stock: B.analyzed + B.stale + B.quant + B.not_analyzed + B.unmapped, industries, sectors, outside, via: viaW, holdings: mapped.length, total_weight: total };
  }

  /**
   * Where the two sources disagree enough to matter: a position in EODHD's top holdings that FMP lists without a
   * ticker or at a much smaller weight (e.g. a private company under lock-up), or one FMP doesn't have at all.
   */
  function crossCheck(mapped, top) {
    const flags = [];
    for (const t of top || []) {
      if (!isNum(t.weight) || t.weight < 0.01) continue;
      const k = nameKey(t.name), hit = mapped.find((h) => (t.ticker && tick(h.ticker) === tick(t.ticker)) || (k && nameKey(h.name) === k) || (k && nameKey(h.name).startsWith(k.split(" ").slice(0, 2).join(" "))));
      if (!hit) flags.push({ name: t.name, eod: t.weight, fmp: null, note: "in EODHD's top holdings, not in FMP's list" });
      else if (hit.weight < t.weight * 0.6 || hit.weight > t.weight * 1.6) flags.push({ name: t.name, eod: t.weight, fmp: hit.weight, kind: hit.kind, note: "weights differ (the sources' dates differ)" });
      else if (hit.kind !== "stock") flags.push({ name: t.name, eod: t.weight, fmp: hit.weight, kind: hit.kind, note: `a top holding the analysis can't cover (${hit.kind})` });
    }
    return flags;
  }

  /**
   * The benchmark, by category: a fund with 60%+ in one sector -> that sector's SPDR; a Nasdaq or Nasdaq-100 fund -> QQQ;
   * anything else -> SPY. sectors: {sector: 0-1}, from the fund's facts or the holdings.
   */
  function benchmark(f, sectors) {
    const s = Object.entries(sectors || {}).sort((a, b) => b[1] - a[1])[0];
    const txt = `${f?.name || ""} ${f?.category || ""} ${f?.description || ""}`;
    if (s && s[1] >= 0.6 && SPDR[s[0]] && SPDR[s[0]] !== f?.symbol) return { symbol: SPDR[s[0]], why: `${Math.round(s[1] * 100)}% in ${s[0]}: that sector's SPDR` };
    if (/nasdaq/i.test(txt) && f?.symbol !== "QQQ") return { symbol: "QQQ", why: "A Nasdaq fund: the Nasdaq-100 (QQQ)" };
    return { symbol: f?.symbol === "SPY" ? "VOO" : "SPY", why: "A broad US stock fund: the S&P 500" };
  }


  // ============================================================= Step 2: the look-through
  const HZ = ["1M", "3M", "6M", "12M"];
  /** "slightly bullish" -> 1, "bearish" -> -2, "neutral"/"mixed" -> 0; unknown -> NaN. */
  function callNum(c) {
    const t = lc(c); if (!t) return NaN;
    const sgn = /bull|positive|up|overweight|buy/.test(t) ? 1 : /bear|negative|down|underweight|sell/.test(t) ? -1 : /neutral|mixed|flat|balanced|hold/.test(t) ? 0 : NaN;
    if (!isNum(sgn) || sgn === 0) return sgn;
    return /slight|mild|modest|lean/.test(t) ? sgn : /strong|very/.test(t) ? 2 * sgn : 2 * sgn;
  }
  function callLabel(x) { if (!isNum(x)) return ""; return x >= 1.5 ? "bullish" : x >= 0.5 ? "slightly bullish" : x > -0.5 ? "neutral" : x > -1.5 ? "slightly bearish" : "bearish"; }
  const titleKey = (t) => lc(t).replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim().split(" ").slice(0, 7).join(" ");
  const mid = (r) => (Array.isArray(r) && r.length === 2 && isNum(n(r[0])) && isNum(n(r[1])) ? (n(r[0]) + n(r[1])) / 2 : NaN);
  const SEV = { critical: 0, high: 1, medium: 2, low: 3 };

  /**
   * One industry's digest for the look-through: everything a fund needs from a saved run, small enough to keep for every
   * industry. rec: the saved run ({name, saved_at, industry, agent, reports: {"<slug>--kpi": {result}}, regbooks}) or a
   * code-only fill ({name, saved_at, industry}); row: the sector overview row (scores with every section) when there is one;
   * scores: the page's own scores when there isn't.
   */
  function digest(rec, { row = null, scores = null, slug = "" } = {}) {
    const d = rec?.industry || {}, a = rec?.agent?.result || {}, S0 = d.summary || {}, F = d.fund || {}, W = d.forward || {};
    const rep = (k) => { for (const [key, v] of Object.entries(rec?.reports || {})) if (key.endsWith("--" + k)) return v?.result || null; return null; };
    const world = rep("world"), trade = rep("trade"), tmap = rep("trademap"), rv = rep("regverdict"), macro = rep("macro");
    const H = a.horizons || {}, lean = a.outlook?.calls || row?.outlook?.calls || {};
    const calls = {}; for (const h of HZ) { const x = H[h]; if (x?.call) calls[h] = { call: x.call, mid: mid(x.expected_move), lo: n(x.expected_move?.[0]), hi: n(x.expected_move?.[1]), p_up: n(x.probability_up) }; else if (row?.horizons?.[h]) calls[h] = { call: row.horizons[h] }; }
    const leanC = {}; for (const h of HZ) { const c = lean[h]; const v = typeof c === "string" ? c : c?.call; if (v) leanC[h] = v; }
    const implied = Object.fromEntries((a.math?.checks || []).map((c) => [c.scenario, n(c.stated ?? c.implied)]));
    const scen = {}; for (const k of ["bull", "base", "bear"]) { const s = a.scenarios?.[k]; if (s) scen[k] = { p: n(s.probability), move: isNum(implied[k]) ? implied[k] : n(s.price_move) }; }
    const rules = Object.values(rec?.regbooks || {}).flatMap((b) => (b?.book?.rules || []).map((r) => ({ name: String(r.name || "").slice(0, 140), body: String(b.body || "").slice(0, 80), severity: r.severity || "", status: r.status || "", bottom_line: String(r.bottom_line || "").slice(0, 220) })))
      .filter((r) => r.name && (r.severity === "critical" || r.severity === "high")).sort((x, y) => (SEV[x.severity] ?? 4) - (SEV[y.severity] ?? 4)).slice(0, 3);
    return {
      v: 1, name: rec?.name || d.name, slug, sector: d.sector || null, saved_at: rec?.saved_at || d.updated_at || null, as_of: d.as_of || null, kind: rec?.agent?.result ? "full" : "quant",
      scores: row?.scores || scores || null, best: row?.best || null, opportunity: a.opportunity?.verdict || a.opportunity?.call || row?.opportunity || null, headline: String(a.headline || row?.headline || "").slice(0, 300),
      expected12: isNum(n(a.math?.expected_return)) ? n(a.math.expected_return) : isNum(n(row?.expected)) ? n(row.expected) : null,
      calls, lean: leanC, lean_date: a.outlook?.date || row?.outlook?.date || null, scen,
      val: { pe: n(F.pe), fwd_pe: n(W.fwd_pe ?? row?.fwd_pe), ps: n(F.ps), ev_ebitda: n(F.ev_ebitda), div_yield: n(F.div_yield), eps_growth: n(W.ntm_eps_growth), rev_growth: n(W.fy1_rev_growth ?? F.rev_growth),
        rev30: n(W.rev30 ?? row?.rev30), pe_hist_pct: n(F.pe_hist_pct), cap: n(S0.total_market_cap ?? d.universe?.total_market_cap) },
      risk: { beta: n(S0.beta), vol: n(S0.vol_1y), max_dd: n(S0.max_dd_1y), sharpe: n(S0.sharpe_1y), r1y: n(S0.ret_cw_1Y) },
      sens: (d.sensitivity?.factors || []).map((f) => ({ key: f.key, label: f.label, shock: f.shock_label || "", effect: n(f.total?.effect), t: n(f.total?.t) })).filter((f) => f.key && isNum(f.effect)),
      positioning: d.positioning?.label || row?.positioning || null,
      macro: macro ? { regime: macro.regime || null } : null,
      world: (world?.dives || []).filter((x) => x?.title).slice(0, 10).map((x) => ({ title: String(x.title).slice(0, 160), stance: x.stance || "", status: x.status || "", category: x.category || "" })),
      trade: trade || tmap ? { rating: trade?.verdict?.rating || null, health: n(trade?.verdict?.health?.score),
        countries: (tmap?.countries || []).slice(0, 14).map((c) => ({ country: c.country, stance: c.stance || "", threat: c.threat || "", importance: c.importance || "", est: isNum(n(c.revenue_share_estimate)) ? n(c.revenue_share_estimate) : null })) } : null,
      reg: rv ? { stance: rv.stance || null, intensity: rv.intensity || null, headline: String(rv.headline || "").slice(0, 240), rules } : rules.length ? { rules } : null,
    };
  }

  const THREAT = { none: 0, low: 1, moderate: 2, medium: 2, elevated: 3, high: 3, severe: 4, critical: 4 };
  const STANCE = { adverse: -1, negative: -1, headwind: -1, favorable: 1, favourable: 1, positive: 1, tailwind: 1, mixed: 0, neutral: 0 };
  /**
   * The fund through its industries. cov: Portfolio.coverage(); digests: {industry name (lower case): digest}.
   * Every figure is weighted by the fund's weight in each covered industry, renormalized over the industries it
   * applies to, and says how much of the fund it rests on ("on": 0-1 of the fund).
   */
  function lookThrough(cov, digests) {
    const D = (g) => digests[lc(g.industry)] || null;
    const inds = cov.industries.map((g) => ({ g, d: D(g) })).filter((x) => x.d);
    const wsum = (f) => { let w = 0, s = 0; for (const { g, d } of inds) { const v = f(d, g); if (isNum(v)) { w += g.weight; s += g.weight * v; } } return w > 0 ? { v: s / w, on: w } : { v: NaN, on: 0 }; };
    const on = inds.reduce((a, x) => a + x.g.weight, 0);
    // Scores per investor type, with only the code-only fill where that's all an industry has.
    const scores = {}; for (const t of ["income", "conservative", "growth", "aggressive"]) scores[t] = wsum((d) => n(d.scores?.[t]));
    const best = Object.entries(scores).filter(([, x]) => isNum(x.v)).sort((a, b) => b[1].v - a[1].v)[0]?.[0] || null;
    // The 1M-12M calls: the lead strategist's (with its expected range), and the newer outlook where there is one.
    const calls = {}; for (const h of HZ) {
      const c = wsum((d) => callNum(d.calls?.[h]?.call)), m = wsum((d) => d.calls?.[h]?.mid), p = wsum((d) => d.calls?.[h]?.p_up), l = wsum((d) => callNum(d.lean?.[h]));
      const dist = { up: 0, flat: 0, down: 0 }; for (const { g, d } of inds) { const v = callNum(d.lean?.[h] || d.calls?.[h]?.call); if (isNum(v)) dist[v > 0 ? "up" : v < 0 ? "down" : "flat"] += g.weight; }
      calls[h] = { score: c.v, call: callLabel(c.v), on: c.on, expected: m.v, p_up: p.v, lean_score: l.v, lean: callLabel(l.v), lean_on: l.on, dist };
    }
    const exp12 = wsum((d) => d.expected12);
    const scen = {}; for (const k of ["bull", "base", "bear"]) { const p = wsum((d) => d.scen?.[k]?.p), mv = wsum((d) => d.scen?.[k]?.move); scen[k] = { p: p.v, move: mv.v, on: mv.on }; }
    // Valuation: P/E as the fund's share of earnings (harmonic), the rest as weighted averages.
    const harm = (f) => { let w = 0, s = 0; for (const { g, d } of inds) { const v = f(d); if (isNum(v) && v > 0) { w += g.weight; s += g.weight / v; } } return w > 0 ? { v: w / s, on: w } : { v: NaN, on: 0 }; };
    const val = { pe: harm((d) => d.val.pe), fwd_pe: harm((d) => d.val.fwd_pe), ev_ebitda: harm((d) => d.val.ev_ebitda), ps: harm((d) => d.val.ps), div_yield: wsum((d) => d.val.div_yield),
      eps_growth: wsum((d) => d.val.eps_growth), rev_growth: wsum((d) => d.val.rev_growth), rev30: wsum((d) => d.val.rev30), pe_hist_pct: wsum((d) => d.val.pe_hist_pct) };
    const risk = { beta: wsum((d) => d.risk.beta), vol: wsum((d) => d.risk.vol), max_dd: wsum((d) => d.risk.max_dd), r1y: wsum((d) => d.risk.r1y) };
    // Macro: each measured sensitivity (the effect of the factor's shock on the industry), weighted.
    const sensK = new Map(); for (const { g, d } of inds) for (const f of d.sens || []) { const x = sensK.get(f.key) || { key: f.key, label: f.label, shock: f.shock, w: 0, s: 0 }; x.w += g.weight; x.s += g.weight * f.effect; sensK.set(f.key, x); }
    const sens = [...sensK.values()].map((x) => ({ key: x.key, label: x.label, shock: x.shock, effect: x.s / x.w, on: x.w })).sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect));
    const regimes = {}; for (const { g, d } of inds) if (d.macro?.regime) regimes[d.macro.regime] = (regimes[d.macro.regime] || 0) + g.weight;
    // World events: the same situation across industries (by its title), with the weight it reaches and which way.
    const wk = new Map();
    for (const { g, d } of inds) for (const x of d.world || []) {
      const k = titleKey(x.title); const e = wk.get(k) || { title: x.title, category: x.category, w: 0, adverse: 0, favorable: 0, industries: [] };
      e.w += g.weight; const s = STANCE[lc(x.stance)] ?? 0; if (s < 0) e.adverse += g.weight; if (s > 0) e.favorable += g.weight; e.industries.push(g.industry); wk.set(k, e);
    }
    const world = [...wk.values()].map((e) => ({ ...e, net: e.favorable - e.adverse, industries: [...new Set(e.industries)] })).sort((a, b) => b.w - a.w).slice(0, 12);
    // Trade: each country the industries' trade maps name, with the fund weight behind it and the revenue at stake.
    const ck = new Map();
    for (const { g, d } of inds) for (const c of d.trade?.countries || []) {
      const e = ck.get(lc(c.country)) || { country: c.country, w: 0, rev: 0, threat: 0, threatW: 0, stances: {}, industries: [] };
      e.w += g.weight; if (isNum(c.est)) e.rev += g.weight * c.est; const t = THREAT[lc(c.threat)] ?? 0; e.threat = Math.max(e.threat, t); if (t >= 3) e.threatW += g.weight;
      e.stances[c.stance || "?"] = (e.stances[c.stance || "?"] || 0) + g.weight; e.industries.push(g.industry); ck.set(lc(c.country), e);
    }
    const THR = ["none", "low", "moderate", "high", "severe"];
    const trade = [...ck.values()].map((e) => ({ country: e.country, w: e.w, rev: e.rev, threat: THR[e.threat], threat_w: e.threatW, stance: Object.entries(e.stances).sort((a, b) => b[1] - a[1])[0]?.[0] || "", industries: e.industries.length }))
      .sort((a, b) => b.rev - a.rev || b.w - a.w).slice(0, 14);
    const tradeRating = {}; for (const { g, d } of inds) if (d.trade?.rating) tradeRating[d.trade.rating] = (tradeRating[d.trade.rating] || 0) + g.weight;
    // Regulation: the verdicts by stance, and the binding rules that reach the most of the fund.
    const regStance = {}; for (const { g, d } of inds) if (d.reg?.stance) regStance[`${d.reg.stance}${d.reg.intensity ? ", " + d.reg.intensity : ""}`] = (regStance[`${d.reg.stance}${d.reg.intensity ? ", " + d.reg.intensity : ""}`] || 0) + g.weight;
    const rk = new Map(); for (const { g, d } of inds) for (const r of d.reg?.rules || []) { const k = titleKey(r.name); const e = rk.get(k) || { ...r, w: 0, industries: [] }; e.w += g.weight; e.industries.push(g.industry); rk.set(k, e); }
    const rules = [...rk.values()].sort((a, b) => (SEV[a.severity] ?? 4) - (SEV[b.severity] ?? 4) || b.w - a.w).slice(0, 8);
    // Which industries move the fund's expected 12-month return most, each way.
    const contrib = inds.filter(({ d }) => isNum(d.expected12)).map(({ g, d }) => ({ industry: g.industry, weight: g.weight, expected: d.expected12, pts: g.weight * d.expected12, call12: d.lean?.["12M"] || d.calls?.["12M"]?.call || "", kind: d.kind }))
      .sort((a, b) => b.pts - a.pts);
    return { on, n: inds.length, full_on: inds.filter((x) => x.d.kind === "full").reduce((a, x) => a + x.g.weight, 0), scores, best, calls, exp12, scen, val, risk, sens, regimes, world, trade, tradeRating, regStance, rules, contrib };
  }

  /**
   * The fund against its benchmark, industry by industry: the active weight (fund minus benchmark, each as a share of
   * its own total) next to the analysis' 12-month view. tilt: the expected-return points the active weights add (or
   * cost) where both sides are analyzed; aligned: the share of active weight leaning the way the analysis does.
   */
  function active(cov, bcov, digests) {
    const by = new Map(); const put = (g, side) => { const k = lc(g.industry); const e = by.get(k) || { industry: g.industry, sector: g.sector, fund: 0, bench: 0 }; e[side] += g.weight; by.set(k, e); };
    for (const g of cov.industries) put(g, "fund"); for (const g of bcov?.industries || []) put(g, "bench");
    const rows = [...by.values()].map((e) => { const d = digests[lc(e.industry)]; const c = d ? callNum(d.lean?.["12M"] || d.calls?.["12M"]?.call) : NaN;
      return { ...e, active: e.fund - e.bench, expected: d?.expected12 ?? null, call12: d ? d.lean?.["12M"] || d.calls?.["12M"]?.call || "" : "", callNum: c, analyzed: !!d }; })
      .sort((a, b) => Math.abs(b.active) - Math.abs(a.active));
    let tilt = 0, tiltOn = 0, al = 0, alOn = 0;
    for (const r of rows) { if (isNum(n(r.expected))) { tilt += r.active * r.expected; tiltOn += Math.abs(r.active); } if (isNum(r.callNum) && r.callNum !== 0) { alOn += Math.abs(r.active); if (Math.sign(r.callNum) === Math.sign(r.active)) al += Math.abs(r.active); } }
    const share = rows.reduce((a, r) => a + Math.min(r.fund, r.bench), 0);
    return { rows, tilt, tilt_on: tiltOn, aligned: alOn > 0 ? al / alOn : NaN, overlap: share, active_share: 1 - share };
  }

  const Portfolio = { digest, lookThrough, active, callNum, callLabel, titleKey, HZ, nameKey, tick, tickRoot, isForeign, kindOf, fromFmp, fromEodEtf, eodTop, facts, lookup, mapHoldings, needProfiles, coverage, crossCheck, benchmark, sectorName, SPDR };
  if (typeof module !== "undefined" && module.exports) module.exports = Portfolio;
  else root.Portfolio = Portfolio;
})(typeof window !== "undefined" ? window : globalThis);
