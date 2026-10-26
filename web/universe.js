/* Industry Scorer: Sector universe.
 *
 * How the companies in each industry are fetched and organized:
 *   1. Sector normalization: a sector name or SPDR sector ETF ticker (XLK, XLF, ...)
 *      maps to FMP's sector taxonomy ("Financials" -> "Financial Services").
 *   2. One live screener pull for the whole sector (NASDAQ, NYSE, AMEX; no ETFs or
 *      funds; actively trading; limit 5000). The page makes the call; this module
 *      builds its query.
 *   3. Hygiene: drop bad symbols, blank industries, funds/trusts/notes/preferreds/
 *      warrants, and rows with no market cap.
 *   4. Share-class dedupe: one row per company, keeping the larger market cap.
 *   5. Industries with fewer than 15 companies in the sector are left out.
 *   6. Group by industry, largest first; top N per industry, the industry's total
 *      market cap from every company in it, and industries ranked by total cap.
 */
(function (root) {
  "use strict";
  const E = typeof module !== "undefined" && module.exports ? require("./engine.js") : root.Engine;

  const SECTORS = ["Basic Materials", "Communication Services", "Consumer Cyclical", "Consumer Defensive", "Energy", "Financial Services", "Healthcare", "Industrials", "Real Estate", "Technology", "Utilities"];
  const ALIASES = {
    "technology": "Technology", "information technology": "Technology", "tech": "Technology", "it": "Technology", "xlk": "Technology",
    "financials": "Financial Services", "financial": "Financial Services", "financial services": "Financial Services", "xlf": "Financial Services",
    "consumer discretionary": "Consumer Cyclical", "consumer cyclical": "Consumer Cyclical", "xly": "Consumer Cyclical",
    "consumer staples": "Consumer Defensive", "consumer defensive": "Consumer Defensive", "xlp": "Consumer Defensive",
    "materials": "Basic Materials", "basic materials": "Basic Materials", "xlb": "Basic Materials",
    "communication services": "Communication Services", "communications": "Communication Services", "telecom": "Communication Services", "xlc": "Communication Services",
    "health care": "Healthcare", "healthcare": "Healthcare", "xlv": "Healthcare",
    "industrials": "Industrials", "xli": "Industrials",
    "energy": "Energy", "xle": "Energy",
    "utilities": "Utilities", "xlu": "Utilities",
    "real estate": "Real Estate", "xlre": "Real Estate",
  };
  const ETF = { Technology: "XLK", "Financial Services": "XLF", "Consumer Cyclical": "XLY", "Consumer Defensive": "XLP", "Basic Materials": "XLB",
    "Communication Services": "XLC", Healthcare: "XLV", Industrials: "XLI", Energy: "XLE", Utilities: "XLU", "Real Estate": "XLRE" };

  /** Step 1. "XLK" / "Information Technology" -> "Technology". Unknown input -> null. */
  function normalizeSector(input, known = SECTORS) {
    const k = String(input || "").trim().toLowerCase().replace(/\s+/g, " ").replace(/^\$/, "");
    if (!k) return null;
    if (ALIASES[k]) return ALIASES[k];
    return known.find((s) => s.toLowerCase() === k) || null;
  }

  /** Step 2. The screener query for one sector. */
  function sectorQuery(sector) {
    return { endpoint: "search-company-screener", sector, exchange: "NASDAQ,NYSE,AMEX", isEtf: false, isFund: false, isActivelyTrading: true, limit: 5000 };
  }

  // Step 3 rules.
  // A ticker of 1-5 capitals, plus one share-class letter (BRK-B, BRK.A), so that
  // multi-class companies reach step 4 instead of vanishing here.
  const SYMBOL_RE = /^[A-Z]{1,5}([.-][A-Z])?$/;
  const NON_OPERATING_RE = /\b(etf|fund|trust|notes? due|preferred|warrant)\b/i;
  // An operating company whose name happens to contain "Trust" (Northern Trust
  // Corporation, Digital Realty Trust, Inc., Camden Property Trust) is kept;
  // royalty and grantor trusts (Permian Basin Royalty Trust) are not.
  const OPERATING_TRUST_RE = /\b(inc|incorporated|corp|corporation|company|bank|bancorp|bancshares|financial|realty|property|properties|reit)\b/i;
  const COUPON_RE = /\d(\.\d+)?\s?%/; // "Brookfield Finance Inc. 4.50% P": a note or preferred listed with its coupon

  function reasonDropped(r) {
    const sym = String(r?.symbol || "");
    const name = String(r?.companyName || "");
    if (!SYMBOL_RE.test(sym)) return "symbol";
    if (!String(r?.industry || "").trim()) return "no industry";
    const m = name.match(NON_OPERATING_RE);
    if (m && !(m[1].toLowerCase() === "trust" && OPERATING_TRUST_RE.test(name))) return "non-operating";
    if (COUPON_RE.test(name)) return "non-operating";
    if (!(Number(r?.marketCap) > 0)) return "no market cap";
    return null;
  }

  /**
   * Steps 3-6. rows: raw screener rows for one sector.
   * opts: { minCompanies = 15, topN = 50, usOnly = false }
   * Returns { sector, industries: [{industry, rank, count, total_market_cap, top: [...] }],
   *           pruned: [{industry, count}], dropped: {reason: n}, total }
   */
  function organize(rows, { minCompanies = 15, topN = 50, usOnly = false, sector = null } = {}) {
    const dropped = {};
    const drop = (why) => { dropped[why] = (dropped[why] || 0) + 1; };
    const clean = [];
    for (const r of rows || []) {
      const why = reasonDropped(r);
      if (why) { drop(why); continue; }
      if (usOnly && r.country !== "US") { drop("not US-headquartered"); continue; }
      clean.push({ symbol: r.symbol, companyName: String(r.companyName || r.symbol), industry: String(r.industry).trim(), sector: r.sector || sector,
        marketCap: Number(r.marketCap), exchangeShortName: r.exchangeShortName || r.exchange, country: r.country || "",
        avgVolume: Number(r.avgVolume), price: Number(r.price) });
    }
    clean.sort((a, b) => b.marketCap - a.marketCap);
    // Step 4: one row per company. Another class of the same company has the same
    // normalized name (GOOGL/GOOG, FOXA/FOX); a security that carries its parent's
    // exact market cap with a name starting the same way (a listed note or
    // preferred, whose ticker starts like the parent's: BN -> BNJ, BNH) is the same issuer too. The larger market cap comes first, so it's kept.
    const seen = new Set(), kept = [];
    const firsts = [];
    for (const r of clean) {
      const key = E.normalizeCompanyName(r.companyName);
      const first = key.split(" ")[0];
      const twin = kept.some((k, i) => firsts[i] === first && k.symbol.slice(0, 2) === r.symbol.slice(0, 2) && Math.abs(k.marketCap - r.marketCap) <= k.marketCap * 1e-6);
      if (seen.has(key) || twin) { drop("duplicate share class"); continue; }
      seen.add(key); kept.push(r); firsts.push(first);
    }
    // Step 6 grouping (kept is already largest first).
    const byInd = new Map();
    for (const s of kept) { const list = byInd.get(s.industry) || []; list.push(s); byInd.set(s.industry, list); }
    // Step 5: prune micro-industries.
    const industries = [], pruned = [];
    for (const [industry, list] of byInd) {
      if (list.length < minCompanies) { pruned.push({ industry, count: list.length }); continue; }
      industries.push({ industry, count: list.length, total_market_cap: list.reduce((s, x) => s + x.marketCap, 0), top: list.slice(0, topN), all: list });
    }
    industries.sort((a, b) => b.total_market_cap - a.total_market_cap);
    industries.forEach((x, i) => { x.rank = i + 1; });
    pruned.sort((a, b) => b.count - a.count || a.industry.localeCompare(b.industry));
    return { sector, industries, pruned, dropped, total: kept.length, raw: (rows || []).length };
  }

  const Universe = { SECTORS, ALIASES, ETF, SYMBOL_RE, NON_OPERATING_RE, normalizeSector, sectorQuery, reasonDropped, organize };
  if (typeof module !== "undefined" && module.exports) module.exports = Universe;
  else root.Universe = Universe;
})(typeof window !== "undefined" ? window : globalThis);
