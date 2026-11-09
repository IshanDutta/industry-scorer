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
  function coverage(mapped, runs, { now = new Date().toISOString().slice(0, 10), staleDays = 14 } = {}) {
    const runByName = new Map(Object.entries(runs || {}).map(([sl, r]) => [lc(r.name), { slug: sl, ...r }]));
    const ageOf = (iso) => (iso ? Math.round((Date.parse(now) - Date.parse(String(iso).slice(0, 10))) / 864e5) : null);
    const total = mapped.reduce((a, h) => a + h.weight, 0) || 1;
    const B = { analyzed: 0, stale: 0, not_analyzed: 0, unmapped: 0, foreign: 0, private: 0, cash: 0, derivative: 0, bond: 0, other: 0 };
    const inds = new Map();
    for (const h of mapped) {
      if (h.kind !== "stock") { B[h.kind] = (B[h.kind] || 0) + h.weight; continue; }
      if (!h.industry) { B.unmapped += h.weight; continue; }
      const run = runByName.get(lc(h.industry)), age = run ? ageOf(run.saved_at) : null;
      const status = !run ? "not_analyzed" : age !== null && age > staleDays ? "stale" : "analyzed";
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
    return { buckets: B, covered: B.analyzed + B.stale, us_stock: B.analyzed + B.stale + B.not_analyzed + B.unmapped, industries, sectors, outside, via: viaW, holdings: mapped.length, total_weight: total };
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

  const Portfolio = { nameKey, tick, tickRoot, isForeign, kindOf, fromFmp, fromEodEtf, eodTop, facts, lookup, mapHoldings, needProfiles, coverage, crossCheck, benchmark, sectorName, SPDR };
  if (typeof module !== "undefined" && module.exports) module.exports = Portfolio;
  else root.Portfolio = Portfolio;
})(typeof window !== "undefined" ? window : globalThis);
