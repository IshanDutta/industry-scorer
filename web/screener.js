/**
 * The Screener tab: find stocks, ETFs and mutual funds by criteria, the way Kwanti's screener works. Pick asset types,
 * add criteria on the left, and the results table refreshes as you go. You choose the columns, sort by several at
 * once, compare up to four, export, save a search, or search for one asset to see the ones most like it.
 *
 * Code only, no Claude. The same module runs in the page and in the GitHub job (runner/screener.mjs) that builds the
 * whole universe once a month:
 *   row(fmpScreenerRow, kind)              the base row from FMP's company screener
 *   withInfo(row, info, countries)         a fund's expense ratio, asset class, provider, sectors and regions (FMP)
 *   withRatios(row, ratios)                a stock's P/E, P/B, P/S, EPS, quick ratio, margin, debt (FMP ratios TTM)
 *   withReturns(row, change)               trailing returns from FMP's quote-change (1M to 10Y)
 *   metrics(series, spy, rf)               volatility, Sharpe and beta (3Y, monthly), max drawdown (5Y, daily)
 *   derive(rows)                           size, style, category and region for every row (needs the whole set)
 *   run(rows, spec)                        the screen: { types, filters, sorts } → matching rows, sorted
 *   similar(row, rows, n)                  the rows most like one asset, with a similarity score
 *   csv(rows, cols)                        the export
 * Rows keep numbers as decimals (0.012 = 1.2%); the criteria and columns carry how to show and type them.
 */
(function (root) {
  "use strict";
  const isNum = (x) => typeof x === "number" && isFinite(x);
  const nz = (x) => { const v = typeof x === "string" ? parseFloat(String(x).replace(/[%,$]/g, "")) : x; return isNum(v) ? v : null; };
  const r4 = (x) => (isNum(x) ? Math.round(x * 1e4) / 1e4 : null);
  const r2 = (x) => (isNum(x) ? Math.round(x * 100) / 100 : null);

  const TYPES = [["etf", "ETF"], ["fund", "Mutual fund"], ["stock", "Stock"]];
  const PERIODS = ["1M", "3M", "6M", "YTD", "1Y", "3Y", "5Y", "10Y"];
  const SECTORS = ["Technology", "Financial Services", "Healthcare", "Consumer Cyclical", "Industrials", "Communication Services", "Consumer Defensive", "Energy", "Real Estate", "Utilities", "Basic Materials"];
  const REGIONS = [["us", "United States"], ["ca", "Canada"], ["eu", "Europe"], ["jp", "Japan"], ["ap", "Asia Pacific (developed)"], ["em", "Emerging markets"]];
  const EM = new Set(["China", "Taiwan", "India", "South Korea", "Korea", "Brazil", "South Africa", "Saudi Arabia", "Mexico", "Malaysia", "Thailand", "United Arab Emirates", "Poland", "Indonesia", "Turkey", "Chile", "Qatar", "Kuwait", "Philippines", "Hungary", "Colombia", "Peru", "Greece", "Czech Republic", "Egypt", "Vietnam", "Argentina", "Romania", "Pakistan", "Nigeria", "Kenya", "Morocco", "Russia", "Bangladesh", "Sri Lanka", "Oman", "Bahrain", "Jordan", "Kazakhstan", "Ukraine", "Iceland"]);
  const EU = new Set(["United Kingdom", "Switzerland", "France", "Germany", "Netherlands", "Spain", "Sweden", "Italy", "Denmark", "Belgium", "Finland", "Norway", "Austria", "Ireland", "Portugal", "Luxembourg", "Jersey", "Guernsey", "Isle of Man", "Monaco", "Malta", "Cyprus", "Liechtenstein", "Gibraltar", "Faroe Islands"]);
  const AP = new Set(["Australia", "Hong Kong", "Singapore", "New Zealand", "Israel", "Macau"]);
  const CODE = { US: "United States", CA: "Canada", GB: "United Kingdom", UK: "United Kingdom", IE: "Ireland", NL: "Netherlands", CH: "Switzerland", DE: "Germany", FR: "France", JP: "Japan", CN: "China", HK: "Hong Kong", TW: "Taiwan", IN: "India", KR: "South Korea", BR: "Brazil", MX: "Mexico", IL: "Israel", AU: "Australia", SG: "Singapore", BM: "Bermuda", KY: "Cayman Islands", LU: "Luxembourg", SE: "Sweden", DK: "Denmark", NO: "Norway", FI: "Finland", ES: "Spain", IT: "Italy", BE: "Belgium", AR: "Argentina", CL: "Chile", ZA: "South Africa", JE: "Jersey", GG: "Guernsey", PR: "United States", VG: "British Virgin Islands", PA: "Panama", GR: "Greece", CO: "Colombia", PE: "Peru", UY: "Uruguay", MC: "Monaco", CY: "Cyprus", TR: "Turkey", ID: "Indonesia", PH: "Philippines", TH: "Thailand", MY: "Malaysia", VN: "Vietnam", AT: "Austria", PT: "Portugal", NZ: "New Zealand", KZ: "Kazakhstan", MT: "Malta" };
  function regionOf(country) {
    const c = CODE[String(country || "").toUpperCase()] || String(country || "");
    if (!c) return null;
    if (c === "United States") return "us"; if (c === "Canada") return "ca"; if (c === "Japan") return "jp";
    if (EU.has(c)) return "eu"; if (AP.has(c)) return "ap"; if (EM.has(c)) return "em";
    return null;
  }

  // ---------------------------------------------------------------- building rows
  /** The base row from one FMP company-screener row. kind: "stock" | "etf" | "fund". */
  function row(r, kind) {
    const px = nz(r.price), div = nz(r.lastAnnualDividend);
    const o = { s: String(r.symbol || "").toUpperCase(), n: r.companyName || r.name || "", t: kind || (r.isEtf ? "etf" : r.isFund ? "fund" : "stock"),
      ex: r.exchangeShortName || r.exchange || "", px: r2(px), mc: nz(r.marketCap), b: r2(nz(r.beta)), av: nz(r.avgVolume),
      y: px > 0 && div >= 0 ? r4(div / px) : null };
    if (o.t === "stock") { o.sec = r.sector || ""; o.ind = r.industry || ""; o.ctry = CODE[String(r.country || "").toUpperCase()] || r.country || ""; }
    return o;
  }
  /** A fund's facts from FMP's ETF and mutual fund information (and country weighting when there is one). */
  function withInfo(o, info, countries) {
    const f = Array.isArray(info) ? info[0] : info;
    if (f) {
      const er = nz(f.expenseRatio); if (er !== null) o.er = r4(er / 100); // FMP gives 0.04 for 0.04%
      if (f.assetClass) o.ac = String(f.assetClass);
      if (f.etfCompany) o.pv = String(f.etfCompany);
      const aum = nz(f.assetsUnderManagement); if (aum > 0) o.mc = aum;
      const hc = nz(f.holdingsCount); if (hc > 0) o.hc = hc;
      if (f.inceptionDate) o.inc = String(f.inceptionDate).slice(0, 10);
      if (f.domicile) o.dom = String(f.domicile);
      const sw = {}; for (const x of f.sectorsList || []) { const k = x?.industry, v = nz(x?.exposure); if (k && v > 0 && SECTORS.includes(k)) sw[k] = r2(v); }
      if (Object.keys(sw).length) o.sw = sw;
      if (!o.n && f.name) o.n = f.name;
    }
    if (Array.isArray(countries) && countries.length) {
      const g = {}; let tot = 0;
      for (const x of countries) { const w = nz(x?.weightPercentage); if (!(w > 0)) continue; tot += w; const k = regionOf(x.country); if (k) g[k] = (g[k] || 0) + w; }
      if (tot > 0) { o.rg = {}; for (const [k, v] of Object.entries(g)) o.rg[k] = r2((v / tot) * 100); }
    }
    return o;
  }
  /** A stock's valuation and balance-sheet numbers from FMP's financial ratios TTM. */
  function withRatios(o, ratios) {
    const q = Array.isArray(ratios) ? ratios[0] : ratios; if (!q) return o;
    const pos = (x) => { const v = nz(x); return v > 0 ? r2(v) : null; };
    o.pe = pos(q.priceToEarningsRatioTTM); o.pb = pos(q.priceToBookRatioTTM); o.ps = pos(q.priceToSalesRatioTTM);
    o.eps = r2(nz(q.netIncomePerShareTTM)); o.qr = r2(nz(q.quickRatioTTM)); o.npm = r4(nz(q.netProfitMarginTTM)); o.de = r2(nz(q.debtToEquityRatioTTM));
    const dy = nz(q.dividendYieldTTM); if (dy !== null && o.y === null) o.y = r4(dy);
    for (const k of ["pe", "pb", "ps", "eps", "qr", "npm", "de"]) if (o[k] === null) delete o[k];
    return o;
  }
  /** Trailing returns from FMP's quote-change (percent, cumulative). 3Y and longer are annualized, as Kwanti shows them. */
  function withReturns(o, ch) {
    if (!ch) return o;
    const yrs = { "3Y": 3, "5Y": 5, "10Y": 10 }, map = { "1M": "1M", "3M": "3M", "6M": "6M", YTD: "ytd", "1Y": "1Y", "3Y": "3Y", "5Y": "5Y", "10Y": "10Y" };
    const r = {};
    for (const p of PERIODS) { const v = nz(ch[map[p]]); if (v === null) continue; const c = v / 100; r[p] = r4(yrs[p] ? (c > -1 ? Math.pow(1 + c, 1 / yrs[p]) - 1 : null) : c); }
    if (Object.keys(r).length) o.r = r;
    return o;
  }

  /**
   * Total returns (dividends reinvested) from daily dividend-adjusted closes, to the last close: 1M to 1Y as they are,
   * 3Y, 5Y and 10Y as yearly averages. A period the history doesn't cover is left out. Sets o.r and o.tr (total).
   */
  function returnsFromSeries(o, ser) {
    const d = ser?.dates || [], c = ser?.closes || []; if (d.length < 15) return o;
    const last = d[d.length - 1], lc = c[c.length - 1];
    const at = (iso) => { let lo = 0, hi = d.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (d[m] <= iso) { k = m; lo = m + 1; } else hi = m - 1; } return k; };
    const back = (months) => { const [y, m, day] = last.split("-").map(Number), t = new Date(Date.UTC(y, m - 1 - months, 1)), dim = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
      return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(Math.min(day, dim)).padStart(2, "0")}`; };
    const yrs = { "3Y": 3, "5Y": 5, "10Y": 10 }, mos = { "1M": 1, "3M": 3, "6M": 6, "1Y": 12, "3Y": 36, "5Y": 60, "10Y": 120 }, r = {};
    for (const p of PERIODS) {
      const base = p === "YTD" ? `${+last.slice(0, 4) - 1}-12-31` : back(mos[p]);
      if (d[0] > addDays(base, 6)) continue;
      const k = at(base); if (k < 0 || !(c[k] > 0)) continue;
      const cum = lc / c[k] - 1; r[p] = r4(yrs[p] ? Math.pow(1 + cum, 1 / yrs[p]) - 1 : cum);
    }
    if (Object.keys(r).length) { o.r = r; o.tr = 1; }
    return o;
  }
  function addDays(iso, n) { const t = new Date(iso + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }

  // ---------------------------------------------------------------- risk from prices
  /** Month-end closes from a daily series { dates, closes } (dates ascending, YYYY-MM-DD). */
  function monthEnds(ser) {
    const out = []; const d = ser?.dates || [], c = ser?.closes || [];
    for (let i = 0; i < d.length; i++) { const m = d[i].slice(0, 7); if (!out.length || out[out.length - 1][0] !== m) out.push([m, c[i]]); else out[out.length - 1][1] = c[i]; }
    return out;
  }
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / Math.max(1, a.length - 1)); };
  /**
   * Risk numbers from daily dividend-adjusted closes: volatility and Sharpe over the last 3 years of monthly returns
   * (annualized), beta to the S&P 500 (SPY) over the same months, and the deepest fall from a high in the last 5 years.
   * The current month counts only once it's over (as month-end data does). rf: the yearly risk-free rate.
   */
  function metrics(ser, spy, rf = 0.04) {
    const out = {}; if (!ser?.dates?.length) return out;
    const me = monthEnds(ser), cur = ser.dates[ser.dates.length - 1].slice(0, 7);
    const full = me.length && me[me.length - 1][0] === cur && !isMonthEnd(ser.dates[ser.dates.length - 1]) ? me.slice(0, -1) : me;
    const rets = []; for (let i = 1; i < full.length; i++) if (full[i - 1][1] > 0) rets.push([full[i][0], full[i][1] / full[i - 1][1] - 1]);
    const last36 = rets.slice(-36);
    if (last36.length >= 30) {
      const xs = last36.map((x) => x[1]), v = sd(xs) * Math.sqrt(12);
      out.v3 = r4(v);
      const ann = Math.pow(xs.reduce((p, x) => p * (1 + x), 1), 12 / xs.length) - 1;
      if (v > 0) out.sh3 = r2((ann - rf) / v);
      if (spy?.dates?.length) {
        const sm = monthEnds(spy), sr = {}; for (let i = 1; i < sm.length; i++) if (sm[i - 1][1] > 0) sr[sm[i][0]] = sm[i][1] / sm[i - 1][1] - 1;
        const pairs = last36.filter((x) => isNum(sr[x[0]])).map((x) => [x[1], sr[x[0]]]);
        if (pairs.length >= 30) {
          const ma = mean(pairs.map((p) => p[0])), mb = mean(pairs.map((p) => p[1]));
          let cv = 0, vb = 0; for (const [a, b] of pairs) { cv += (a - ma) * (b - mb); vb += (b - mb) * (b - mb); }
          if (vb > 0) out.b3 = r2(cv / vb);
        }
      }
    }
    const lastD = ser.dates[ser.dates.length - 1], from = addYears(lastD, -5);
    if (ser.dates[0] <= addYears(lastD, -1)) {
      let hi = 0, dd = 0;
      for (let i = 0; i < ser.dates.length; i++) { if (ser.dates[i] < from) continue; const c = ser.closes[i]; if (c > hi) hi = c; else if (hi > 0) dd = Math.min(dd, c / hi - 1); }
      out.dd = r4(dd);
    }
    return out;
  }
  /** True when no weekday is left in the month after this date (so the month's last close is in). */
  function isMonthEnd(d) {
    const [y, m, day] = d.split("-").map(Number), last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    for (let x = day + 1; x <= last; x++) { const w = new Date(Date.UTC(y, m - 1, x)).getUTCDay(); if (w !== 0 && w !== 6) return false; }
    return true;
  }
  function addYears(d, n) { const [y, m, day] = d.split("-"); return `${+y + n}-${m}-${day}`; }

  // ---------------------------------------------------------------- derived fields (need the whole set)
  const SIZE_RE = [[/large|mega|s&p 500|\b500\b|dow|nasdaq[- ]100|blue chip|total (stock )?market|top \d+/i, "Large"], [/mid[- ]?cap|midcap|\b400\b/i, "Mid"], [/small|micro|russell 2000|\b600\b|\b2000\b/i, "Small"]];
  const STYLE_RE = [[/growth/i, "Growth"], [/value|dividend|income|yield/i, "Value"]];
  const BOND_RE = /bond|treasur|fixed income|income fund|municipal|\bmuni|aggregate|credit|debt|t-bill|\bbill|duration|high yield|tips|inflation[- ]protected|mortgage|floating|loan|govt|government|corporate|core plus|ultra[- ]short/i;
  /** A fund's category (our grouping; Kwanti uses Morningstar's), from its asset class, name, sectors and regions. */
  function fundCategory(o) {
    const nm = `${o.n || ""} ${o.ac || ""}`;
    if (/\b(2x|3x|-1x|-2x|-3x|ultra(?!\s*short)|ultrapro|inverse|bear\b|short\b(?!-term| term| duration| maturity)|leveraged|daily .*bull)/i.test(o.n || "")) return "Trading: leveraged or inverse";
    if (/target|retirement|20[2-7]\d\b|allocation|balanced|lifestyle|conservative|moderate|aggressive growth|multi[- ]asset|wellington|wellesley|asset manager/i.test(nm) && !/^(?=.*equity)(?!.*balanced)/i.test(o.ac || "")) return "Allocation";
    if (/commodit|gold|silver|precious|oil|natural gas|bitcoin|ether|crypto|metals|agricultur/i.test(nm) && !/miners|equity/i.test(o.ac || "")) return "Commodities and crypto";
    if (BOND_RE.test(nm) && !/equity|stock/i.test(o.ac || "")) {
      if (/muni|tax[- ]exempt|tax[- ]free/i.test(nm)) return "Bond: municipal";
      if (/high yield|junk|high income|floating|loan/i.test(nm)) return "Bond: high yield and loans";
      if (/tips|inflation/i.test(nm)) return "Bond: inflation-protected";
      if (/emerging|international|global|world|ex-us/i.test(nm)) return "Bond: international";
      if (/treasur|govt|government|t-bill|\bbill/i.test(nm)) return "Bond: government";
      if (/corporate|credit|investment grade/i.test(nm)) return "Bond: corporate";
      if (/short|ultra|money|cash/i.test(nm)) return "Bond: short-term";
      return "Bond: core";
    }
    const sw = o.sw || {}, top = Object.entries(sw).sort((a, b) => b[1] - a[1])[0];
    if (top && top[0] === "Real Estate" && top[1] >= 60 || /reit|real estate/i.test(nm)) return "Real estate";
    const rg = o.rg;
    if (rg && (rg.us || 0) < 40) {
      if ((rg.em || 0) >= 60 || /emerging/i.test(nm)) return "Emerging markets";
      return (rg.us || 0) >= 20 || /global|world|all[- ]country|acwi/i.test(nm) ? "Global stock" : "International stock";
    }
    if (!rg && /emerging/i.test(nm)) return "Emerging markets";
    if (!rg && /international|developed|ex-us|eafe|europe|japan|pacific|foreign/i.test(nm)) return "International stock";
    if (top && top[1] >= 50) return "Sector: " + top[0];
    return "US stock: " + (o.sz || "Large") + " " + (o.st || "Blend").toLowerCase();
  }
  /**
   * Size, style, category and region for every row. Stocks: size from market cap (large $10B+, mid $2-10B, small under
   * $2B); style from where P/E and P/B sit among all stocks (cheapest third value, dearest third growth). Funds: from
   * the asset class and name. Regions: a fund's weights; a stock's country.
   */
  function derive(rows) {
    const stocks = rows.filter((o) => o.t === "stock");
    const rank = (k) => { const v = stocks.map((o) => o[k]).filter((x) => x > 0).sort((a, b) => a - b); return (x) => { if (!(x > 0) || !v.length) return null; let lo = 0, hi = v.length; while (lo < hi) { const m = (lo + hi) >> 1; if (v[m] < x) lo = m + 1; else hi = m; } return (lo + 0.5) / v.length; }; };
    const rPe = rank("pe"), rPb = rank("pb");
    for (const o of rows) {
      if (o.t === "stock") {
        o.sz = o.mc >= 1e10 ? "Large" : o.mc >= 2e9 ? "Mid" : o.mc > 0 ? "Small" : null;
        const a = rPe(o.pe), b = rPb(o.pb), q = [a, b].filter(isNum);
        o.st = q.length ? (mean(q) < 1 / 3 ? "Value" : mean(q) > 2 / 3 ? "Growth" : "Blend") : null;
        const rg = regionOf(o.ctry); if (rg) o.rk = rg;
        o.cat = o.sec || null;
      } else {
        const nm = `${o.ac || ""} ${o.n || ""}`;
        o.sz = (SIZE_RE.find(([re]) => re.test(nm)) || [])[1] || null;
        o.st = (STYLE_RE.find(([re]) => re.test(nm)) || [])[1] || (o.sz ? "Blend" : null);
        const eq = !BOND_RE.test(nm) || /equity|stock/i.test(o.ac || "");
        if (!eq) { o.sz = null; o.st = null; }
        o.cat = fundCategory(o);
        if (o.rg) { const top = Object.entries(o.rg).sort((a, b) => b[1] - a[1])[0]; if (top) o.rk = top[0]; }
      }
      o.box = o.sz && o.st ? `${o.sz} ${o.st.toLowerCase()}` : null;
      if (o.inc) { const y = (Date.now() - Date.parse(o.inc)) / (365.25 * 864e5); if (y >= 0) o.age = Math.round(y * 10) / 10; }
    }
    return rows;
  }

  // ---------------------------------------------------------------- criteria and columns
  const F = ["etf", "fund"], S = ["stock"], A = ["etf", "fund", "stock"];
  const BOXES = ["Large value", "Large blend", "Large growth", "Mid value", "Mid blend", "Mid growth", "Small value", "Small blend", "Small growth"];
  /**
   * Every criterion, in the order the left panel shows them. kind: "multi" (pick values), "th" (pick values, each with
   * a minimum weight), "range" (min and max). unit: "%" (typed as percent), "$M", "$B", "x" (a plain number).
   * get(row, f) reads the row's value; for returns f.p is the period.
   */
  const CRITERIA = [
    { k: "ac", label: "Asset class", for: F, kind: "multi", group: "Profile", get: (o) => o.ac },
    { k: "box", label: "Equity style", for: F, kind: "multi", group: "Profile", values: BOXES, get: (o) => o.box, help: "Size and style, read from the fund's asset class and name." },
    { k: "esec", label: "Equity sector", for: F, kind: "th", th: 25, group: "Profile", values: SECTORS, get: (o, v) => (o.sw || {})[v] || 0, help: "Funds with at least the minimum in the sector (25% unless you change it)." },
    { k: "ereg", label: "Equity region", for: F, kind: "th", th: 75, group: "Profile", values: REGIONS.map((x) => x[0]), names: Object.fromEntries(REGIONS), get: (o, v) => (o.rg || {})[v] || 0, help: "Funds with at least the minimum in the region (75% unless you change it)." },
    { k: "cat", label: "Fund category", for: F, kind: "multi", group: "Profile", get: (o) => o.cat, help: "Our grouping from each fund's asset class, name, sectors and regions." },
    { k: "pv", label: "Fund provider", for: F, kind: "multi", group: "Profile", get: (o) => o.pv },
    { k: "sec", label: "Sector", for: S, kind: "multi", group: "Profile", values: SECTORS, get: (o) => o.sec },
    { k: "ind", label: "Industry", for: S, kind: "multi", group: "Profile", get: (o) => o.ind },
    { k: "sbox", label: "Stock style", for: S, kind: "multi", group: "Profile", values: BOXES, get: (o) => o.box, help: "Size from market cap; value or growth from where P/E and P/B sit among all stocks." },
    { k: "sreg", label: "Stock region", for: S, kind: "multi", group: "Profile", values: REGIONS.map((x) => x[0]), names: Object.fromEntries(REGIONS), get: (o) => o.rk, help: "Where the company is based." },
    { k: "ex", label: "Stock exchange", for: S, kind: "multi", group: "Profile", values: ["NYSE", "NASDAQ", "AMEX"], names: { AMEX: "NYSE American" }, get: (o) => o.ex },
    { k: "r", label: "Return (annualized)", for: A, kind: "range", unit: "%", group: "Performance", period: true, get: (o, f) => o.r?.[f?.p || "1Y"], help: "Total return with dividends reinvested. 3 years and longer are yearly averages." },
    { k: "y", label: "Yield", for: A, kind: "range", unit: "%", group: "Performance", get: (o) => o.y, help: "The last 12 months of dividends over today's price." },
    { k: "v3", label: "Volatility", for: A, kind: "range", unit: "%", group: "Risk", get: (o) => o.v3, help: "How much monthly returns swung over the last 3 years, as a yearly figure." },
    { k: "sh3", label: "Sharpe", for: A, kind: "range", unit: "x", group: "Risk", get: (o) => o.sh3, help: "Return above cash per unit of volatility, last 3 years. Above 1 is strong." },
    { k: "dd", label: "Max drawdown", for: A, kind: "range", unit: "%", group: "Risk", get: (o) => o.dd, help: "The deepest fall from a high in the last 5 years (a negative number: −20% means it fell a fifth)." },
    { k: "b3", label: "Beta", for: A, kind: "range", unit: "x", group: "Risk", get: (o) => o.b3 ?? o.b, help: "How much it moves with the S&P 500 (1 = the same), last 3 years of months." },
    { k: "er", label: "Expense ratio", for: F, kind: "range", unit: "%", group: "Cost and size", get: (o) => o.er, help: "The yearly fee from the prospectus." },
    { k: "aum", label: "Net assets", for: F, kind: "range", unit: "$M", group: "Cost and size", get: (o) => o.mc },
    { k: "hc", label: "Number of holdings", for: F, kind: "range", unit: "x", group: "Cost and size", get: (o) => o.hc },
    { k: "age", label: "Years since launch", for: F, kind: "range", unit: "x", group: "Cost and size", get: (o) => o.age },
    { k: "mc", label: "Market cap", for: S, kind: "range", unit: "$B", group: "Cost and size", get: (o) => o.mc },
    { k: "pe", label: "Price to earnings (P/E)", for: S, kind: "range", unit: "x", group: "Valuation and fundamentals", get: (o) => o.pe },
    { k: "pb", label: "Price to book (P/B)", for: S, kind: "range", unit: "x", group: "Valuation and fundamentals", get: (o) => o.pb },
    { k: "ps", label: "Price to sales (P/S)", for: S, kind: "range", unit: "x", group: "Valuation and fundamentals", get: (o) => o.ps },
    { k: "eps", label: "Earnings per share (EPS)", for: S, kind: "range", unit: "x", group: "Valuation and fundamentals", get: (o) => o.eps },
    { k: "npm", label: "Net margin", for: S, kind: "range", unit: "%", group: "Valuation and fundamentals", get: (o) => o.npm },
    { k: "qr", label: "Quick ratio", for: S, kind: "range", unit: "x", group: "Valuation and fundamentals", get: (o) => o.qr },
    { k: "de", label: "Debt to equity", for: S, kind: "range", unit: "x", group: "Valuation and fundamentals", get: (o) => o.de },
  ];
  const CRIT = Object.fromEntries(CRITERIA.map((c) => [c.k, c]));
  const SCALE = { "%": 100, $M: 1e-6, $B: 1e-9, x: 1 };
  /** A typed value (what the person sees) to the row's number, and back. */
  const fromUI = (c, v) => { const x = nz(v); return x === null ? null : x / (SCALE[c.unit] || 1); };
  const toUI = (c, v) => (isNum(v) ? Math.round(v * (SCALE[c.unit] || 1) * 100) / 100 : null);

  /**
   * Columns, in groups like Kwanti's column picker. fmt: "pct", "pct+" (signed), "money", "num", "x" (times), "text".
   */
  const COLUMNS = [
    { id: "s", label: "Symbol", group: "Identifier", fmt: "text", get: (o) => o.s, fixed: true },
    { id: "n", label: "Name", group: "Identifier", fmt: "text", get: (o) => o.n },
    { id: "t", label: "Type", group: "Identifier", fmt: "text", get: (o) => ({ etf: "ETF", fund: "Mutual fund", stock: "Stock" })[o.t] },
    { id: "cat", label: "Category / sector", group: "Profile", fmt: "text", get: (o) => o.cat },
    { id: "ac", label: "Asset class", group: "Profile", fmt: "text", get: (o) => o.ac },
    { id: "box", label: "Style", group: "Profile", fmt: "text", get: (o) => o.box },
    { id: "pv", label: "Provider", group: "Profile", fmt: "text", get: (o) => o.pv },
    { id: "ind", label: "Industry", group: "Profile", fmt: "text", get: (o) => o.ind },
    { id: "rk", label: "Region", group: "Profile", fmt: "text", get: (o) => (o.rk ? Object.fromEntries(REGIONS)[o.rk] : null) },
    { id: "ex", label: "Exchange", group: "Profile", fmt: "text", get: (o) => o.ex },
    ...PERIODS.map((p) => ({ id: "r" + p, label: p === "YTD" ? "YTD" : p + (["3Y", "5Y", "10Y"].includes(p) ? " ann." : ""), long: `Return ${p}${["3Y", "5Y", "10Y"].includes(p) ? " (annualized)" : ""}`, group: "Performance", fmt: "pct+", get: (o) => o.r?.[p] })),
    { id: "y", label: "Yield", group: "Performance", fmt: "pct", get: (o) => o.y },
    { id: "v3", label: "Volatility", long: "Volatility (3Y)", group: "Risk", fmt: "pct", get: (o) => o.v3 },
    { id: "sh3", label: "Sharpe", long: "Sharpe (3Y)", group: "Risk", fmt: "num", get: (o) => o.sh3 },
    { id: "dd", label: "Max drawdown", long: "Max drawdown (5Y)", group: "Risk", fmt: "pct", get: (o) => o.dd },
    { id: "b3", label: "Beta", long: "Beta (3Y)", group: "Risk", fmt: "num", get: (o) => o.b3 ?? o.b },
    { id: "er", label: "Expense ratio", group: "Cost and size", fmt: "pct2", get: (o) => o.er },
    { id: "mc", label: "Net assets / market cap", group: "Cost and size", fmt: "money", get: (o) => o.mc },
    { id: "hc", label: "Holdings", group: "Cost and size", fmt: "int", get: (o) => o.hc },
    { id: "age", label: "Years since launch", group: "Cost and size", fmt: "num1", get: (o) => o.age },
    { id: "px", label: "Price", group: "Price and volume", fmt: "price", get: (o) => o.px },
    { id: "av", label: "Avg volume", group: "Price and volume", fmt: "int", get: (o) => o.av },
    { id: "pe", label: "P/E", group: "Valuation and fundamentals", fmt: "x", get: (o) => o.pe },
    { id: "pb", label: "P/B", group: "Valuation and fundamentals", fmt: "x", get: (o) => o.pb },
    { id: "ps", label: "P/S", group: "Valuation and fundamentals", fmt: "x", get: (o) => o.ps },
    { id: "eps", label: "EPS", group: "Valuation and fundamentals", fmt: "price", get: (o) => o.eps },
    { id: "npm", label: "Net margin", group: "Valuation and fundamentals", fmt: "pct", get: (o) => o.npm },
    { id: "qr", label: "Quick ratio", group: "Valuation and fundamentals", fmt: "num", get: (o) => o.qr },
    { id: "de", label: "Debt to equity", group: "Valuation and fundamentals", fmt: "num", get: (o) => o.de },
  ];
  const COL = Object.fromEntries(COLUMNS.map((c) => [c.id, c]));
  /** The starting columns for the asset types picked. */
  function defaultCols(types) {
    const f = types.some((t) => t !== "stock"), s = types.includes("stock");
    return ["s", "n", ...(types.length > 1 ? ["t"] : []), "cat", "mc", ...(f ? ["er"] : []), "y", "r1Y", "r3Y", "r5Y", "v3", "sh3", ...(s ? ["pe"] : [])];
  }
  function fmt(col, v) {
    if (v === null || v === undefined || v === "" || (typeof v === "number" && !isFinite(v))) return "—";
    switch (col.fmt) {
      case "pct": return (v * 100).toFixed(1) + "%";
      case "pct2": return (v * 100).toFixed(2) + "%";
      case "pct+": return (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v * 100).toFixed(1) + "%";
      case "money": return v >= 1e12 ? "$" + (v / 1e12).toFixed(2) + "T" : v >= 1e9 ? "$" + (v / 1e9).toFixed(1) + "B" : v >= 1e6 ? "$" + Math.round(v / 1e6) + "M" : "$" + Math.round(v).toLocaleString("en-US");
      case "num": return v.toFixed(2);
      case "num1": return v.toFixed(1);
      case "int": return Math.round(v).toLocaleString("en-US");
      case "x": return v.toFixed(1) + "×";
      case "price": return (v < 0 ? "−$" : "$") + Math.abs(v).toFixed(2);
      default: return String(v);
    }
  }

  // ---------------------------------------------------------------- the screen
  /** True when the row passes one filter. A criterion only screens the asset types it's for; the rest pass. */
  function pass(o, f) {
    const c = CRIT[f.k]; if (!c || !c.for.includes(o.t)) return true;
    if (c.kind === "multi") { if (!f.any?.length) return true; const v = c.get(o, f); return v !== null && v !== undefined && f.any.includes(v); }
    if (c.kind === "th") { if (!f.any?.length) return true; const th = isNum(f.th) ? f.th : c.th; return f.any.some((v) => c.get(o, v) >= th); }
    const v = c.get(o, f), lo = isNum(f.min) ? f.min : null, hi = isNum(f.max) ? f.max : null;
    if (lo === null && hi === null) return true;
    if (!isNum(v)) return false;
    return (lo === null || v >= lo - 1e-9) && (hi === null || v <= hi + 1e-9);
  }
  /** Sort by several columns in turn: sorts = [{ c: column id, d: 1 | -1 }]. Blanks always go last. */
  function sortRows(rows, sorts) {
    const ss = (sorts || []).map((x) => ({ col: COL[x.c], d: x.d === 1 ? 1 : -1 })).filter((x) => x.col);
    if (!ss.length) return rows;
    return rows.slice().sort((a, b) => {
      for (const { col, d } of ss) {
        const x = col.get(a), y = col.get(b), xb = x === null || x === undefined || x === "", yb = y === null || y === undefined || y === "";
        if (xb && yb) continue; if (xb) return 1; if (yb) return -1;
        const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
        if (c) return c * d;
      }
      return 0;
    });
  }
  /** The screen: { types, filters, sorts, q } → { rows, total, missing: { criterion key: rows without that number } }. */
  function run(rows, spec) {
    const types = spec?.types?.length ? spec.types : ["etf"], filters = spec?.filters || [];
    const q = String(spec?.q || "").trim().toLowerCase();
    let base = rows.filter((o) => types.includes(o.t));
    if (q) base = base.filter((o) => o.s.toLowerCase().startsWith(q) || String(o.n).toLowerCase().includes(q));
    const missing = {};
    for (const f of filters) { const c = CRIT[f.k]; if (c?.kind === "range" && (isNum(f.min) || isNum(f.max))) missing[f.k] = base.filter((o) => c.for.includes(o.t) && !isNum(c.get(o, f))).length; }
    const out = base.filter((o) => filters.every((f) => pass(o, f)));
    return { rows: sortRows(out, spec?.sorts?.length ? spec.sorts : [{ c: "mc", d: -1 }]), total: base.length, missing };
  }
  /** The values a "multi" criterion can take among the rows of the types picked (most common first), with counts. */
  function values(rows, k, types) {
    const c = CRIT[k]; if (!c) return [];
    if (c.values) return c.values.map((v) => [v, rows.filter((o) => types.includes(o.t) && c.for.includes(o.t) && (c.kind === "th" ? c.get(o, v) >= c.th : c.get(o) === v)).length]);
    const n = {}; for (const o of rows) if (types.includes(o.t) && c.for.includes(o.t)) { const v = c.get(o); if (v) n[v] = (n[v] || 0) + 1; }
    return Object.entries(n).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  // ---------------------------------------------------------------- similar assets
  /**
   * The rows most like one asset (the same asset type): for funds, what they hold (sectors, regions, category,
   * style), their risk and return, and cost; for stocks, industry, size, style, risk and valuation.
   * Returns [{ o, sim }] with sim from 0 to 100.
   */
  function similar(x, rows, n = 25) {
    if (!x) return [];
    const pool = rows.filter((o) => o.s !== x.s && (o.t === x.t || (x.t !== "stock" && o.t !== "stock")));
    const cos = (a, b) => { const ks = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]); let d = 0, na = 0, nb = 0; for (const k of ks) { const p = (a || {})[k] || 0, q = (b || {})[k] || 0; d += p * q; na += p * p; nb += q * q; } return na && nb ? d / Math.sqrt(na * nb) : null; };
    const near = (a, b, scale) => (isNum(a) && isNum(b) ? Math.max(0, 1 - Math.abs(a - b) / scale) : null);
    const lg = (v) => (v > 0 ? Math.log10(v) : null);
    const out = [];
    for (const o of pool) {
      const parts = [];
      const add = (v, w) => { if (v !== null && v !== undefined) parts.push([v, w]); };
      if (x.t === "stock") {
        add(o.ind && x.ind ? (o.ind === x.ind ? 1 : o.sec === x.sec ? 0.45 : 0) : o.sec && x.sec ? (o.sec === x.sec ? 0.7 : 0) : null, 4);
        add(near(lg(o.mc), lg(x.mc), 1.5), 1.5); add(o.st && x.st ? (o.st === x.st ? 1 : 0.4) : null, 1);
        add(near(o.v3, x.v3, 0.25), 1.2); add(near(o.b3 ?? o.b, x.b3 ?? x.b, 1), 1); add(near(lg(o.pe), lg(x.pe), 0.6), 0.8);
        add(near(o.r?.["1Y"], x.r?.["1Y"], 0.5), 0.8); add(near(o.y, x.y, 0.04), 0.5);
      } else {
        add(o.cat && x.cat ? (o.cat === x.cat ? 1 : o.cat.split(":")[0] === x.cat.split(":")[0] ? 0.5 : 0) : null, 3);
        add(cos(o.sw, x.sw), 2.5); add(cos(o.rg, x.rg), 2); add(o.box && x.box ? (o.box === x.box ? 1 : o.box.split(" ")[0] === x.box.split(" ")[0] || o.box.split(" ")[1] === x.box.split(" ")[1] ? 0.5 : 0) : null, 1);
        add(near(o.v3, x.v3, 0.2), 1.5); add(near(o.r?.["3Y"], x.r?.["3Y"], 0.15), 1); add(near(o.r?.["1Y"], x.r?.["1Y"], 0.3), 0.8);
        add(near(o.b3 ?? o.b, x.b3 ?? x.b, 0.8), 1); add(near(o.y, x.y, 0.03), 0.6); add(near(o.er, x.er, 0.01), 0.5);
      }
      const w = parts.reduce((s, p) => s + p[1], 0); if (w < 4) continue;
      out.push({ o, sim: Math.round((parts.reduce((s, p) => s + p[0] * p[1], 0) / w) * 100) });
    }
    return out.sort((a, b) => b.sim - a.sim || (b.o.mc || 0) - (a.o.mc || 0)).slice(0, n);
  }

  // ---------------------------------------------------------------- export
  function csv(rows, cols) {
    const cs = cols.map((id) => COL[id]).filter(Boolean);
    const cell = (v) => { const s = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const raw = (c, o) => { const v = c.get(o); if (!isNum(v)) return v ?? ""; return /^pct/.test(c.fmt) ? Math.round(v * 1e4) / 100 : v; };
    const head = cs.map((c) => cell((c.long || c.label) + (/^pct/.test(c.fmt) ? " (%)" : ""))).join(",");
    return [head, ...rows.map((o) => cs.map((c) => cell(raw(c, o))).join(","))].join("\n");
  }

  /** Starting points shown before any criteria are added. */
  const PRESETS = [
    { id: "core", label: "Low-cost core index funds", spec: { types: ["etf", "fund"], filters: [{ k: "er", max: 0.001 }, { k: "aum", min: 1e9 }, { k: "box", any: ["Large blend"] }], sorts: [{ c: "er", d: 1 }, { c: "mc", d: -1 }] } },
    { id: "income", label: "Dividend stocks with steady prices", spec: { types: ["stock"], filters: [{ k: "y", min: 0.03 }, { k: "v3", max: 0.22 }, { k: "mc", min: 1e10 }], sorts: [{ c: "y", d: -1 }] } },
    { id: "sharpe", label: "Best risk-adjusted ETFs (3Y Sharpe)", spec: { types: ["etf"], filters: [{ k: "sh3", min: 0.8 }, { k: "aum", min: 5e8 }], sorts: [{ c: "sh3", d: -1 }] } },
    { id: "bonds", label: "Bond funds yielding 4%+", spec: { types: ["etf", "fund"], filters: [{ k: "cat", any: ["Bond: core", "Bond: government", "Bond: corporate", "Bond: short-term", "Bond: municipal", "Bond: inflation-protected"] }, { k: "y", min: 0.04 }, { k: "er", max: 0.005 }], sorts: [{ c: "y", d: -1 }] } },
    { id: "value", label: "Cheap large companies", spec: { types: ["stock"], filters: [{ k: "pe", min: 0.1, max: 15 }, { k: "mc", min: 1e10 }, { k: "de", max: 1.5 }], sorts: [{ c: "pe", d: 1 }] } },
  ];

  const Screener = { TYPES, PERIODS, SECTORS, REGIONS, CRITERIA, CRIT, COLUMNS, COL, PRESETS, row, withInfo, withRatios, withReturns, returnsFromSeries, monthEnds, metrics, derive, fundCategory, regionOf,
    fromUI, toUI, fmt, pass, sortRows, run, values, similar, csv, defaultCols };
  if (typeof module !== "undefined" && module.exports) module.exports = Screener;
  else root.Screener = Screener;
})(typeof window !== "undefined" ? window : globalThis);
