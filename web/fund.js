/* Industry Scorer: fundamentals, valuation, earnings and financial-health
 * aggregation for an industry's top 50. Pure functions, no I/O.
 *
 * Aggregation rule: never average ratios. Industry ratios are sum/sum over the
 * companies that have both parts (e.g. P/E = total market cap / total TTM net
 * income), so one outlier can't dominate. Company-level medians are kept
 * alongside as a second view.
 */
(function (root) {
  "use strict";
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const n = (x) => (x === null || x === undefined || x === "" ? NaN : Number(x));
  const byDateDesc = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);
  function median(a) { const s = a.filter(isNum).sort((x, y) => x - y); if (!s.length) return NaN; const k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; }
  const sum = (rows, f) => rows.reduce((s, r) => s + f(r), 0);

  // Industries whose statements don't fit industrial ratios (gross margin,
  // current ratio, EV/EBITDA, interest cover, D/E, ROIC are misleading there).
  function isFinancialIndustry(name) {
    return /^(Banks|Insurance|Financial - |Asset Management|Investment - |REIT - Mortgage)/.test(String(name));
  }

  // ------------------------------------------------------------ company
  /** Raw FMP rows -> compact per-company record (what gets cached). */
  function compactCompany({ income = [], balance = [], cashflow = [], keyMetrics = [], earnings = [] }) {
    const q = income.filter((r) => r && r.date).map((r) => ({
      date: String(r.date).slice(0, 10), rev: n(r.revenue), gp: n(r.grossProfit), oi: n(r.operatingIncome),
      ni: n(r.netIncome), ibt: n(r.incomeBeforeTax), tax: n(r.incomeTaxExpense), int: Math.abs(n(r.interestExpense)),
      cogs: n(r.costOfRevenue), sh: n(r.weightedAverageShsOutDil ?? r.weightedAverageShsOut),
    })).sort(byDateDesc);
    const bsRow = (b) => ({ date: String(b.date).slice(0, 10), equity: n(b.totalStockholdersEquity ?? b.totalEquity), debt: n(b.totalDebt),
      cash: n(b.cashAndShortTermInvestments ?? b.cashAndCashEquivalents), ca: n(b.totalCurrentAssets), cl: n(b.totalCurrentLiabilities),
      inv: n(b.inventory), ar: n(b.netReceivables ?? b.accountsReceivables) });
    const bsAll = [...balance].filter((r) => r && r.date).sort(byDateDesc).slice(0, 12).map(bsRow);
    const bs = bsAll[0] || null;
    const bsh = bsAll.slice(1);
    const cf = cashflow.filter((r) => r && r.date).map((r) => ({
      date: String(r.date).slice(0, 10), fcf: n(r.freeCashFlow), da: n(r.depreciationAndAmortization),
      div: Math.abs(n(r.commonDividendsPaid ?? r.netDividendsPaid ?? 0)) || 0,
      capex: Math.abs(n(r.capitalExpenditure ?? r.investmentsInPropertyPlantAndEquipment)), sbc: n(r.stockBasedCompensation),
      buyback: Math.abs(n(r.commonStockRepurchased ?? 0)) || 0, cfo: n(r.operatingCashFlow ?? r.netCashProvidedByOperatingActivities),
    })).sort(byDateDesc);
    const km = keyMetrics.filter((r) => r && r.date && isNum(n(r.marketCap))).map((r) => ({ date: String(r.date).slice(0, 10), mcap: n(r.marketCap) })).sort(byDateDesc);
    const earn = earnings.filter((r) => r && r.date).map((r) => ({
      date: String(r.date).slice(0, 10), ea: n(r.epsActual), ee: n(r.epsEstimated), ra: n(r.revenueActual), re: n(r.revenueEstimated),
    })).sort(byDateDesc);
    // Currency each block is reported in (FMP: foreign filers report in local
    // currency, e.g. TSMC in TWD, Mizuho in JPY). Converted with toUSD().
    const cur = (rows) => String(rows.find((r) => r && r.reportedCurrency)?.reportedCurrency || "USD").toUpperCase();
    const ccy = { q: cur(income), bs: cur(balance), cf: cur(cashflow), km: cur(keyMetrics) };
    return { q, bs, bsh, cf, km, earn, ccy };
  }

  /** Currencies (other than USD) a compact company record needs converted. */
  function currenciesOf(c) {
    return [...new Set(Object.values(c?.ccy || {}).filter((x) => x && x !== "USD"))];
  }

  /**
   * Convert every statement block to USD. `perUSD` maps currency -> units per
   * 1 USD (e.g. {TWD: 32.1}). Uses today's rate for all history, an
   * approximation for P/E history but exact for current ratios. Returns null
   * when a needed rate is missing, so the company is left out rather than mixed.
   */
  function toUSD(c, perUSD) {
    if (!c) return c;
    const ccy = c.ccy || { q: "USD", bs: "USD", cf: "USD", km: "USD" };
    const f = {};
    for (const [blk, code] of Object.entries(ccy)) {
      if (!code || code === "USD") { f[blk] = 1; continue; }
      const r = Number(perUSD?.[code]);
      if (!(r > 0)) return null;
      f[blk] = 1 / r;
    }
    const scale = (o, k, keys) => { if (!o) return o; const x = { ...o }; for (const kk of keys) if (x[kk] !== null && x[kk] !== undefined) x[kk] = n(x[kk]) * f[k]; return x; };
    return {
      ...c,
      q: (c.q || []).map((r) => scale(r, "q", ["rev", "gp", "oi", "ni", "ibt", "tax", "int", "cogs"])),
      bs: scale(c.bs, "bs", ["equity", "debt", "cash", "ca", "cl", "inv", "ar"]),
      bsh: (c.bsh || []).map((r) => scale(r, "bs", ["equity", "debt", "cash", "ca", "cl", "inv", "ar"])),
      cf: (c.cf || []).map((r) => scale(r, "cf", ["fcf", "da", "div", "capex", "sbc", "buyback", "cfo"])),
      km: (c.km || []).map((r) => scale(r, "km", ["mcap"])),
      ccy: { q: "USD", bs: "USD", cf: "USD", km: "USD" },
      converted_from: currenciesOf(c),
    };
  }

  /** Derived TTM figures for one company. Missing pieces stay NaN. */
  function companyTTM(c) {
    const q = c?.q || [], cf = c?.cf || [];
    const ttm = (rows, k, from) => (rows.length >= from + 4 ? sum(rows.slice(from, from + 4), (r) => n(r[k])) : NaN);
    const t = {
      rev: ttm(q, "rev", 0), revPrev: ttm(q, "rev", 4), gp: ttm(q, "gp", 0), oi: ttm(q, "oi", 0),
      ni: ttm(q, "ni", 0), niPrev: ttm(q, "ni", 4), ibt: ttm(q, "ibt", 0), tax: ttm(q, "tax", 0), int: ttm(q, "int", 0),
      fcf: ttm(cf, "fcf", 0), da: ttm(cf, "da", 0), div: ttm(cf, "div", 0),
      capex: ttm(cf, "capex", 0), sbc: ttm(cf, "sbc", 0), buyback: ttm(cf, "buyback", 0), cfo: ttm(cf, "cfo", 0),
      equity: n(c?.bs?.equity), debt: n(c?.bs?.debt), cash: n(c?.bs?.cash), ca: n(c?.bs?.ca), cl: n(c?.bs?.cl),
    };
    t.ebitda = t.oi + (isNum(t.da) ? t.da : 0);
    const rate = t.ibt > 0 && isNum(t.tax) ? Math.min(Math.max(t.tax / t.ibt, 0), 0.35) : 0.21;
    t.nopat = t.oi * (1 - rate);
    t.ic = t.debt + t.equity - (isNum(t.cash) ? t.cash : 0);
    return t;
  }

  /** Earnings history: last 4 reported quarters + next scheduled report. */
  function companyEarnings(c, today) {
    const rows = c?.earn || [];
    const rows2 = rows.map((r) => ({ ...r, ea: n(r.ea), ee: n(r.ee), ra: n(r.ra), re: n(r.re) }));
    const past = rows2.filter((r) => r.date < today && isNum(r.ea) && isNum(r.ee)).slice(0, 4);
    const fut = rows2.filter((r) => r.date >= today && !isNum(r.ea)).sort((a, b) => (a.date < b.date ? -1 : 1))[0] || null;
    return {
      reports: past.length,
      beats: past.filter((r) => r.ea > r.ee).length,
      epsSurprises: past.filter((r) => r.ee !== 0).map((r) => (r.ea - r.ee) / Math.abs(r.ee)),
      revSurprises: past.filter((r) => isNum(r.ra) && r.re > 0).map((r) => (r.ra - r.re) / r.re),
      next: fut ? { date: fut.date, eps_est: isNum(fut.ee) ? fut.ee : null, rev_est: isNum(fut.re) ? fut.re : null } : null,
    };
  }

  /** Calendar-quarter key for a period-end date: 2026-07-27 -> "2026-Q3". */
  function qKey(date) { const [y, m] = date.split("-").map(Number); return `${y}-Q${Math.ceil(m / 3)}`; }

  /**
   * Industry cycle series by calendar quarter (oldest first): inventory days, DSO, capex/sales, net debt/EBITDA,
   * revenue growth y/y. Each quarter sums the companies that report both parts, and keeps only quarters where
   * at least 60% of the companies report, so a changing mix doesn't fake a trend.
   */
  function cycleHistory(rows, fin) {
    const Q = {};
    for (const r of rows) {
      const bsAll = [r.c.bs, ...(r.c.bsh || [])].filter(Boolean);
      for (let i = 0; i < r.c.q.length; i++) {
        const q = r.c.q[i], key = qKey(q.date);
        const b = bsAll.find((x) => Math.abs(Date.parse(x.date) - Date.parse(q.date)) <= 20 * 864e5);
        const cf = (r.c.cf || []).find((x) => Math.abs(Date.parse(x.date) - Date.parse(q.date)) <= 20 * 864e5);
        const yago = r.c.q[i + 4];
        const t = (Q[key] ||= { q: key, n: 0, inv: 0, cogs: 0, ar: 0, rev: 0, capex: 0, rev_cf: 0, rev_now: 0, rev_yago: 0, nd: 0, ebitda: 0, n_inv: 0, n_ar: 0, n_capex: 0, n_g: 0, n_nd: 0 });
        t.n++;
        if (b && isNum(b.inv) && b.inv > 0 && q.cogs > 0) { t.inv += b.inv; t.cogs += q.cogs; t.n_inv++; }
        if (b && isNum(b.ar) && q.rev > 0) { t.ar += b.ar; t.rev += q.rev; t.n_ar++; }
        if (cf && isNum(cf.capex) && q.rev > 0) { t.capex += cf.capex; t.rev_cf += q.rev; t.n_capex++; }
        if (yago && q.rev > 0 && yago.rev > 0) { t.rev_now += q.rev; t.rev_yago += yago.rev; t.n_g++; }
        if (!fin && b && isNum(b.debt) && cf && isNum(cf.da) && isNum(q.oi)) { t.nd += b.debt - (isNum(b.cash) ? b.cash : 0); t.ebitda += (q.oi + cf.da) * 4; t.n_nd++; }
      }
    }
    const need = Math.max(2, Math.ceil(rows.length * 0.6));
    return Object.values(Q).filter((t) => t.n >= need).sort((a, b) => (a.q < b.q ? -1 : 1)).slice(-12).map((t) => ({
      q: t.q, n: t.n,
      inv_days: t.n_inv >= need * 0.5 && t.cogs > 0 ? t.inv / t.cogs * 91 : NaN,
      dso: t.n_ar >= need * 0.5 && t.rev > 0 ? t.ar / t.rev * 91 : NaN,
      capex_rev: t.n_capex >= need * 0.5 && t.rev_cf > 0 ? t.capex / t.rev_cf : NaN,
      rev_yoy: t.n_g >= need * 0.5 && t.rev_yago > 0 ? t.rev_now / t.rev_yago - 1 : NaN,
      nd_ebitda: t.n_nd >= need * 0.5 && t.ebitda > 0 ? t.nd / t.ebitda : NaN,
    }));
  }
  /** Latest vs a year earlier vs the series median, for one cycle metric. */
  function cycleTrend(series, k) {
    const v = series.filter((x) => isNum(x[k]));
    if (v.length < 2) return null;
    const last = v[v.length - 1], yago = v.length >= 5 ? v[v.length - 5] : v[0];
    return { last: last[k], q: last.q, yago: yago[k], yago_q: yago.q, median: median(v.map((x) => x[k])), change: last[k] - yago[k], n: v.length };
  }

  // ------------------------------------------------------------ industry
  /**
   * @param members [{symbol, name, market_cap, c}] where c is compactCompany output
   * @param opts {industry, today}
   */
  function aggregateIndustry(members, { industry, today }) {
    const fin = isFinancialIndustry(industry);
    const rows = members.filter((m) => m.c && m.c.q && m.c.q.length >= 4).map((m) => ({ ...m, t: companyTTM(m.c), e: companyEarnings(m.c, today) }));
    const ratio = (num, den, ok = () => true) => {
      const use = rows.filter((r) => ok(r) && isNum(num(r)) && isNum(den(r)));
      const d = sum(use, den);
      return { v: use.length && d !== 0 ? sum(use, num) / d : NaN, n: use.length };
    };
    const mc = (r) => r.market_cap;
    const posEq = (r) => r.t.equity > 0;

    const f = {};
    const set = (k, res) => { f[k] = res.v; f[k + "_n"] = res.n; };
    set("rev_growth", ratio((r) => r.t.rev - r.t.revPrev, (r) => r.t.revPrev, (r) => r.t.revPrev > 0));
    { const use = rows.filter((r) => isNum(r.t.ni) && isNum(r.t.niPrev)); const p = sum(use, (r) => r.t.niPrev);
      f.ni_growth = use.length && p !== 0 ? (sum(use, (r) => r.t.ni) - p) / Math.abs(p) : NaN; f.ni_growth_n = use.length; }
    set("gross_margin", fin ? { v: NaN, n: 0 } : ratio((r) => r.t.gp, (r) => r.t.rev, (r) => r.t.rev > 0));
    set("op_margin", ratio((r) => r.t.oi, (r) => r.t.rev, (r) => r.t.rev > 0));
    set("net_margin", ratio((r) => r.t.ni, (r) => r.t.rev, (r) => r.t.rev > 0));
    set("roe", ratio((r) => r.t.ni, (r) => r.t.equity, posEq));
    // Valuation: price ratios as cap / fundamental. P/E null when aggregate earnings <= 0.
    { const e = ratio((r) => r.t.ni, mc); f.earnings_yield = e.v; f.pe = e.v > 0 ? 1 / e.v : NaN; f.pe_n = e.n; f.pe_negative = e.v <= 0; }
    { const s = ratio((r) => r.t.rev, mc, (r) => r.t.rev > 0); f.ps = s.v > 0 ? 1 / s.v : NaN; f.ps_n = s.n; }
    { const b = ratio((r) => r.t.equity, mc, posEq); f.pb = b.v > 0 ? 1 / b.v : NaN; f.pb_n = b.n; }
    if (fin) { f.ev_ebitda = NaN; f.ev_ebitda_n = 0; }
    else { const use = rows.filter((r) => isNum(r.t.ebitda) && isNum(r.t.debt));
      const ev = sum(use, (r) => r.market_cap + r.t.debt - (isNum(r.t.cash) ? r.t.cash : 0)), eb = sum(use, (r) => r.t.ebitda);
      f.ev_ebitda = eb > 0 ? ev / eb : NaN; f.ev_ebitda_n = use.length; }
    set("div_yield", ratio((r) => r.t.div, mc, (r) => isNum(r.t.div)));
    // Health
    set("de", fin ? { v: NaN, n: 0 } : ratio((r) => r.t.debt, (r) => r.t.equity, posEq));
    set("current_ratio", fin ? { v: NaN, n: 0 } : ratio((r) => r.t.ca, (r) => r.t.cl, (r) => r.t.cl > 0));
    set("int_cover", fin ? { v: NaN, n: 0 } : ratio((r) => r.t.oi, (r) => r.t.int, (r) => r.t.int > 0));
    set("fcf_margin", ratio((r) => r.t.fcf, (r) => r.t.rev, (r) => r.t.rev > 0));
    set("roic", fin ? { v: NaN, n: 0 } : ratio((r) => r.t.nopat, (r) => r.t.ic, (r) => r.t.ic > 0));
    set("fcf_div_cover", ratio((r) => r.t.fcf, (r) => r.t.div, (r) => r.t.div > 0));
    f.n_fund = rows.length;
    f.financial = fin;

    // Company-level medians (second view)
    f.med = {
      rev_growth: median(rows.map((r) => (r.t.revPrev > 0 ? r.t.rev / r.t.revPrev - 1 : NaN))),
      gross_margin: fin ? NaN : median(rows.map((r) => (r.t.rev > 0 ? r.t.gp / r.t.rev : NaN))),
      op_margin: median(rows.map((r) => (r.t.rev > 0 ? r.t.oi / r.t.rev : NaN))),
      net_margin: median(rows.map((r) => (r.t.rev > 0 ? r.t.ni / r.t.rev : NaN))),
      pe: median(rows.map((r) => (r.t.ni > 0 ? r.market_cap / r.t.ni : NaN))),
      roe: median(rows.map((r) => (r.t.equity > 0 ? r.t.ni / r.t.equity : NaN))),
    };

    // P/E history: aggregate cap / aggregate TTM net income at each quarter-end.
    const hist = {};
    for (const r of rows) {
      const q = r.c.q;
      for (const k of r.c.km || []) {
        const i = q.findIndex((x) => Math.abs(Date.parse(x.date) - Date.parse(k.date)) <= 12 * 864e5);
        if (i < 0 || q.length < i + 4) continue;
        const ni = sum(q.slice(i, i + 4), (x) => n(x.ni));
        const cap = n(k.mcap);
        if (!isNum(ni) || !isNum(cap)) continue;
        const key = qKey(k.date);
        (hist[key] ||= { mcap: 0, ni: 0, n: 0 });
        hist[key].mcap += cap; hist[key].ni += ni; hist[key].n += 1;
      }
    }
    const minN = Math.min(rows.length, Math.max(3, Math.ceil(rows.length * 0.6)));
    f.pe_hist = Object.entries(hist).filter(([, h]) => h.n >= minN && h.ni > 0)
      .map(([q, h]) => ({ q, pe: h.mcap / h.ni, n: h.n })).sort((a, b) => (a.q < b.q ? -1 : 1));
    const ph = f.pe_hist.map((h) => h.pe);
    f.pe_hist_median = median(ph);
    f.pe_vs_hist = isNum(f.pe) && isNum(f.pe_hist_median) ? f.pe / f.pe_hist_median - 1 : NaN;
    f.pe_hist_pct = isNum(f.pe) && ph.length ? ph.filter((v) => v <= f.pe).length / ph.length : NaN;
    f.pe_hist_years = ph.length / 4;

    // Balance-sheet and cash-flow cycle: per calendar quarter, sum over companies reporting both parts.
    f.cycle = cycleHistory(rows, fin);
    { const rel = (k) => { const t = cycleTrend(f.cycle, k); return t && t.yago > 0 ? t.last / t.yago - 1 : NaN; };
      f.inv_days_yoy = rel("inv_days"); f.dso_yoy = rel("dso"); f.capex_rev_yoy = rel("capex_rev");
      const nd = cycleTrend(f.cycle, "nd_ebitda"); f.nd_ebitda = nd ? nd.last : NaN; }
    // Earnings quality and capital return (TTM)
    set("sbc_rev", ratio((r) => r.t.sbc, (r) => r.t.rev, (r) => r.t.rev > 0 && isNum(r.t.sbc)));
    set("fcf_conv", ratio((r) => r.t.fcf, (r) => r.t.ni, (r) => isNum(r.t.fcf) && r.t.ni > 0));
    set("capex_rev", ratio((r) => r.t.capex, (r) => r.t.rev, (r) => r.t.rev > 0 && isNum(r.t.capex)));
    set("buyback_yield", ratio((r) => r.t.buyback, mc, (r) => isNum(r.t.buyback)));
    { const use = rows.filter((r) => isNum(r.t.fcf) && isNum(r.t.sbc) && r.t.rev > 0); f.fcf_margin_ex_sbc = use.length ? (sum(use, (r) => r.t.fcf - r.t.sbc)) / sum(use, (r) => r.t.rev) : NaN;
      f.op_margin_ex_sbc = use.length ? sum(use.filter((r) => isNum(r.t.oi)), (r) => r.t.oi - r.t.sbc) / sum(use.filter((r) => isNum(r.t.oi)), (r) => r.t.rev) : NaN; }
    // Share count change: diluted shares, latest quarter vs 4 quarters earlier (cap-weighted)
    { const use = rows.filter((r) => r.c.q.length >= 5 && n(r.c.q[0].sh) > 0 && n(r.c.q[4].sh) > 0);
      const cap = sum(use, mc); f.share_change = cap ? sum(use, (r) => r.market_cap * (n(r.c.q[0].sh) / n(r.c.q[4].sh) - 1)) / cap : NaN; f.share_change_n = use.length; }

    // Earnings
    const reps = sum(rows, (r) => r.e.reports), beats = sum(rows, (r) => r.e.beats);
    f.beat_rate = reps ? beats / reps : NaN;
    f.beat_reports = reps;
    f.eps_surprise_median = median(rows.flatMap((r) => r.e.epsSurprises));
    f.rev_surprise_median = median(rows.flatMap((r) => r.e.revSurprises));
    f.next_reports = rows.filter((r) => r.e.next).map((r) => ({ symbol: r.symbol, name: r.name, ...r.e.next }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)).slice(0, 10);

    // Per-company rows for the constituents table
    f.companies = Object.fromEntries(rows.map((r) => [r.symbol, {
      pe: r.t.ni > 0 ? r.market_cap / r.t.ni : NaN, ps: r.t.rev > 0 ? r.market_cap / r.t.rev : NaN,
      rev_growth: r.t.revPrev > 0 ? r.t.rev / r.t.revPrev - 1 : NaN, op_margin: r.t.rev > 0 ? r.t.oi / r.t.rev : NaN,
      div_yield: isNum(r.t.div) ? r.t.div / r.market_cap : NaN, de: r.t.equity > 0 ? r.t.debt / r.t.equity : NaN,
      beats: r.e.reports ? `${r.e.beats}/${r.e.reports}` : null, next: r.e.next?.date ?? null,
      rev_ttm: r.t.rev, ni_ttm: r.t.ni, gross_margin: r.t.rev > 0 && isNum(r.t.gp) ? r.t.gp / r.t.rev : NaN,
      net_margin: r.t.rev > 0 ? r.t.ni / r.t.rev : NaN, ni_growth: r.t.niPrev > 0 ? r.t.ni / r.t.niPrev - 1 : NaN,
      fcf_margin: r.t.rev > 0 && isNum(r.t.fcf) ? r.t.fcf / r.t.rev : NaN,
      inv_days: isNum(r.c.bs?.inv) && r.c.q[0]?.cogs > 0 ? r.c.bs.inv / r.c.q[0].cogs * 91 : NaN,
      dso: isNum(r.c.bs?.ar) && r.c.q[0]?.rev > 0 ? r.c.bs.ar / r.c.q[0].rev * 91 : NaN,
      sbc_rev: r.t.rev > 0 && isNum(r.t.sbc) ? r.t.sbc / r.t.rev : NaN,
      share_change: r.c.q.length >= 5 && n(r.c.q[4].sh) > 0 ? n(r.c.q[0].sh) / n(r.c.q[4].sh) - 1 : NaN,
      int_cover: !fin && r.t.int > 0 ? r.t.oi / r.t.int : NaN,
      nd_ebitda: !fin && r.t.ebitda > 0 && isNum(r.t.debt) ? (r.t.debt - (isNum(r.t.cash) ? r.t.cash : 0)) / r.t.ebitda : NaN,
    }]));
    return f;
  }

  const Fund = { cycleHistory, cycleTrend, isFinancialIndustry, compactCompany, currenciesOf, toUSD, companyTTM, companyEarnings, aggregateIndustry, qKey, median };
  if (typeof module !== "undefined" && module.exports) module.exports = Fund;
  else root.Fund = Fund;
})(typeof window !== "undefined" ? window : globalThis);
