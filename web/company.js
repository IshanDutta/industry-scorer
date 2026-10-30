/* Industry Scorer: one company, built on its industry's analysis.
 *
 * Code only (no I/O): ranks a company against its industry's top 50, finds everything the industry analysis
 * says about it (by ticker or name, in every section), maps its own revenue by country and by product onto the
 * industry's trade map and KPI segments, scores quality and valuation, builds the thesis prompt, and checks
 * the thesis that comes back (citations, scenario math, the 1M-12M calls).
 */
(function (root) {
  "use strict";
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const n = (x) => (x === null || x === undefined || x === "" ? NaN : Number(x));
  const trim = (s, k) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > k ? s.slice(0, k - 1) + "…" : s; };
  const median = (a) => { const v = a.filter(isNum).sort((x, y) => x - y); if (!v.length) return NaN; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
  const lc = (s) => String(s || "").toLowerCase();

  // ------------------------------------------------------------------ versus the industry's top 50
  /** [key, label, higher is better (true/false/null = neither), kind] */
  const METRICS = [
    ["market_cap", "Market cap", null, "cap"], ["ret_1M", "Return 1M", true, "chg"], ["ret_3M", "Return 3M", true, "chg"], ["ret_6M", "Return 6M", true, "chg"], ["ret_1Y", "Return 1Y", true, "chg"],
    ["pe", "P/E", false, "x"], ["fwd_pe", "Forward P/E", false, "x"], ["ps", "P/S", false, "x"], ["rev_growth", "Revenue growth", true, "chg"], ["ntm_growth", "Next-12-month EPS growth", true, "chg"],
    ["gross_margin", "Gross margin", true, "pct"], ["op_margin", "Operating margin", true, "pct"], ["net_margin", "Net margin", true, "pct"], ["fcf_margin", "FCF margin", true, "pct"],
    ["div_yield", "Dividend yield", true, "pct"], ["de", "Debt / equity", false, "x"], ["nd_ebitda", "Net debt / EBITDA", false, "x"], ["int_cover", "Interest cover", true, "x"],
    ["beta", "Beta", null, "x"], ["vol_1y", "Volatility 1Y", false, "pct"], ["max_dd_1y", "Max drawdown 1Y", true, "pct"], ["rev30", "EPS revisions 30d", true, "chg"],
    ["short_pct", "Short interest", false, "pct"], ["share_change", "Share count change", false, "chg"], ["sbc_rev", "Stock comp / revenue", false, "pct"],
  ];
  /** Share of the industry's companies below v (0-1). */
  function pctRank(v, vals) { const a = vals.filter(isNum); if (!isNum(v) || a.length < 3) return NaN; return a.filter((x) => x < v).length / a.length + a.filter((x) => x === v).length / (2 * a.length); }
  /** One row per metric: the company's value, the industry median, its percentile and whether that's good. */
  function peerTable(row, constituents) {
    return METRICS.map(([k, label, up, kind]) => {
      const v = n(row?.[k]), vals = (constituents || []).filter((c) => c.symbol !== row?.symbol).map((c) => n(c[k]));
      const p = pctRank(v, vals), good = up === null || !isNum(p) ? null : up ? p : 1 - p;
      return { key: k, label, kind, value: isNum(v) ? v : null, median: isNum(median(vals)) ? median(vals) : null, pct: isNum(p) ? Math.round(p * 100) : null, good: isNum(good) ? Math.round(good * 100) : null };
    }).filter((r) => r.value !== null);
  }
  /** The industry's companies most like this one: size first, plus FMP's own peer list. */
  function closestPeers(row, constituents, fmpPeers = [], k = 6) {
    const mc = n(row?.market_cap), fp = new Set((fmpPeers || []).map((p) => p.symbol));
    return (constituents || []).filter((c) => c.symbol !== row?.symbol && isNum(n(c.market_cap)))
      .map((c) => ({ c, d: (isNum(mc) && mc > 0 ? Math.abs(Math.log(n(c.market_cap) / mc)) : 5) - (fp.has(c.symbol) ? 1.5 : 0) }))
      .sort((a, b) => a.d - b.d).slice(0, k).map(({ c }) => ({ ...c, fmp_peer: fp.has(c.symbol) }));
  }

  // ------------------------------------------------------------------ everything the industry analysis says about it
  const SECTION = { kpi: "KPIs and cycle", calls: "Earnings calls", chain: "Customers and suppliers", reg: "Regulation, legal and deals", trademap: "Trade map", world: "World events",
    trade: "Trade relations", macro: "Macro", regverdict: "Regulatory verdict", books: "Rule books", lead: "Lead strategist", research: "Research" };
  const ROLE = [[/winners?/, "winner"], [/losers?/, "loser"], [/exposed|exposure/, "exposed"], [/examples?/, "example"], [/best|express|picks?|longs?/, "pick"], [/avoid|shorts?/, "avoid"],
    [/hot_segments/, "hot segment"], [/cool_segments/, "cool segment"], [/dependenc/, "dependency"], [/customers?/, "customer"], [/suppliers?/, "supplier"], [/compet/, "competitor"]];
  /** Name variants worth matching in text: "Coca-Cola" from "The Coca-Cola Company". */
  function nameCore(name) {
    const c = String(name || "").split(",")[0].replace(/^the\s+/i, "").replace(/[,.]?\s+(incorporated|inc|corporation|corp|company|co|holdings?|group|plc|ltd|limited|s\.?a\.?|n\.?v\.?|ag|se|class [a-c])\.?$/gi, "").replace(/[,.]?\s+(incorporated|inc|corporation|corp|company|co|holdings?|group|plc|ltd|limited)\.?$/gi, "").trim();
    return c.length >= 4 ? c : "";
  }
  /**
   * Walk an industry run's reports and collect every place the company appears: a ticker field that is the
   * company (with its sibling fields as the text), or a sentence naming the ticker or the company.
   * run: {reports: {kind: result}, books: [{body, book}], lead, research, tx}. Returns [{section, where, role, text}].
   */
  function mentions(sym, name, run, max = 70, others = []) {
    const out = [], seen = new Set(), S = String(sym || "").toUpperCase(); if (!S) return out;
    const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const tre = S.length >= 2 ? new RegExp(`(^|[^A-Za-z0-9.])${esc(S)}([^A-Za-z0-9]|$)`) : null;
    const core = nameCore(name);
    // Other companies whose names contain this one's ("Coca-Cola FEMSA" for "Coca-Cola") are removed before matching the name.
    // ...matched by this name plus their next word ("Coca-Cola Europacific", "Coca-Cola FEMSA"), however the text shortens them.
    const longer = [...new Set((others || []).map(nameCore).filter((o) => o && core && o.length > core.length && lc(o).startsWith(lc(core)))
      .map((o) => o.slice(core.length).trim().split(/\s+/)[0]).filter(Boolean))].map((w) => new RegExp(esc(core).replace(/\s+/g, "\\s+") + "\\s+" + esc(w), "gi"));
    const nre0 = core ? new RegExp(esc(core).replace(/\s+/g, "\\s+"), "i") : null;
    const nre = nre0 ? { test: (t) => nre0.test(longer.reduce((a, re) => a.replace(re, " "), String(t))) } : null;
    const title = (o) => o && typeof o === "object" ? (o.title || o.situation || o.country || o.name || o.rule || o.driver || o.segment || o.event || o.chokepoint || o.body || "") : "";
    const textOf = (o) => Object.entries(o).filter(([k, v]) => typeof v === "string" && !/^(symbol|ticker|id|date|evidence)$/i.test(k) && v.length > 2).map(([, v]) => v).join(" — ");
    const add = (section, crumbs, path, text) => {
      // The industry's own citation tags ([N6], [T1]) point at the industry's sources, not this page's: drop them.
      const t = trim(String(text || "").replace(/\s*\[[A-Z]{1,2}\d{1,4}(?:,\s*[A-Z]{1,2}\d{1,4})*\]/g, "").replace(/\s+([.,;:])/g, "$1"), 520); if (!t || seen.has(t) || out.length >= 400) return; seen.add(t);
      const p = lc(path.join(".")); const role = (ROLE.find(([re]) => re.test(p)) || [])[1] || null;
      out.push({ section, where: crumbs.filter(Boolean).map((c) => trim(c, 90)).join(" › "), role, text: t });
    };
    const walk = (section, o, crumbs, path, depth) => {
      if (out.length >= 400 || depth > 9 || o === null || o === undefined) return;
      if (Array.isArray(o)) {
        // A list of tickers that includes this one: the parent object is about it.
        if (o.some((x) => typeof x === "string" && x.toUpperCase() === S)) { add(section, crumbs, path, textOf(crumbs.__parent || {}) || crumbs.join(" ")); }
        o.forEach((x, i) => walk(section, x, crumbs, [...path, i], depth + 1));
        return;
      }
      if (typeof o === "object") {
        const t = title(o), cr = t ? [...crumbs, t] : [...crumbs]; cr.__parent = o;
        if (["symbol", "ticker", "company"].some((k) => typeof o[k] === "string" && (o[k].toUpperCase() === S || (core && nre.test(o[k]))))) { add(section, crumbs, path, textOf(o)); return; }
        for (const [k, v] of Object.entries(o)) {
          if (/^(evidence|sources|refs|tools_used|items)$/.test(k)) continue;
          if (typeof v === "string") { if ((tre && tre.test(v)) || (nre && nre.test(v))) add(section, cr, [...path, k], v); }
          else walk(section, v, cr, [...path, k], depth + 1);
        }
      }
    };
    for (const [kind, res] of Object.entries(run?.reports || {})) walk(SECTION[kind] || kind, res, [], [kind], 0);
    for (const b of run?.books || []) walk(SECTION.books, b.book, [b.body], ["books"], 0);
    if (run?.lead) walk(SECTION.lead, run.lead, [], ["lead"], 0);
    // Keep the most telling: where it is named in a role (winner, loser, pick, exposed...), then the ones that are
    // about it rather than a list of names, spread across sections.
    const score = (m) => (m.role ? 3 : 0) + (tre && tre.test(m.text.slice(0, 120)) ? 1 : 0) + (m.text.length < 400 ? 0.5 : 0) + (m.section === SECTION.lead ? 1 : 0);
    // A mention that is only part of a longer one ("X" and "X — Y") is dropped.
    const uniq = out.filter((m, i) => !out.some((o, j) => j !== i && o.text.length > m.text.length && o.text.includes(m.text.replace(/…$/, ""))));
    const per = {}, kept = [];
    for (const m of [...uniq].sort((a, b) => score(b) - score(a))) { if (kept.length >= max) break; per[m.section] = (per[m.section] || 0) + 1; if (per[m.section] <= Math.max(8, Math.ceil(max / 5))) kept.push(m); }
    const order = Object.values(SECTION);
    return kept.sort((a, b) => order.indexOf(a.section) - order.indexOf(b.section) || (b.role ? 1 : 0) - (a.role ? 1 : 0));
  }

  // ------------------------------------------------------------------ its business onto the industry's trade map and segments
  const REGION = { "united states": ["us", "u.s.", "usa", "united states", "north america", "americas"], china: ["china", "greater china", "prc", "asia pacific", "apac", "asia"], mexico: ["mexico", "latin america", "latam", "americas"],
    canada: ["canada", "north america"], japan: ["japan", "asia"], "united kingdom": ["united kingdom", "uk", "u.k.", "great britain", "europe", "emea"], germany: ["germany", "europe", "emea"], france: ["france", "europe", "emea"],
    india: ["india", "asia"], brazil: ["brazil", "latin america", "latam", "south america"], taiwan: ["taiwan", "asia"], "south korea": ["korea", "south korea", "asia"], vietnam: ["vietnam", "asia"] };
  /** Each revenue region, with the trade-map countries it covers (exact or regional). */
  function geoMap(geo, tradeMap) {
    const countries = tradeMap?.countries || [];
    return (geo?.items || []).map((g) => {
      const name = lc(g.name);
      const hits = countries.filter((c) => { const k = lc(c.country); const al = REGION[k] || [k]; return name.includes(k) || al.some((a) => name === a || name.includes(a)); })
        .map((c) => ({ country: c.country, stance: c.stance, trajectory: c.trajectory, threat: c.threat, importance: c.importance, exact: name.includes(lc(c.country)) }));
      return { region: g.name, share: g.share, yoy: g.yoy, countries: hits.sort((a, b) => (b.exact ? 1 : 0) - (a.exact ? 1 : 0)).slice(0, 4) };
    });
  }
  /** Each product line, with the industry's hot or cool segment it matches (word overlap). */
  function segMap(prod, kpi) {
    const words = (s) => lc(s).split(/[^a-z0-9]+/).filter((w) => w.length > 3);
    const segs = [...(kpi?.hot_segments || []).map((s) => ({ ...s, temp: "hot" })), ...(kpi?.cool_segments || []).map((s) => ({ ...s, temp: "cool" }))];
    return (prod?.items || []).map((p) => {
      const w = new Set(words(p.name));
      const best = segs.map((s) => ({ s, k: words(`${s.name} ${s.text || ""}`).filter((x) => w.has(x)).length })).filter((x) => x.k > 0).sort((a, b) => b.k - a.k)[0];
      return { segment: p.name, share: p.share, yoy: p.yoy, match: best ? { name: best.s.name, temp: best.s.temp, text: trim(best.s.text, 200) } : null };
    });
  }

  // ------------------------------------------------------------------ quality, capital allocation, valuation
  /** From FMP financial-scores, ratios TTM, key metrics TTM, and the compact statements' TTM (Fund.companyTTM). */
  function quality({ scores, ratios, metrics, ttm }) {
    const s = scores || {}, r = ratios || {}, m = metrics || {}, t = ttm || {};
    const z = n(s.altmanZScore), f = n(s.piotroskiScore);
    const accruals = isNum(t.ni) && isNum(t.cfo) && isNum(n(s.totalAssets)) && n(s.totalAssets) > 0 ? (t.ni - t.cfo) / n(s.totalAssets) : NaN;
    return {
      piotroski: isNum(f) ? f : null, piotroski_read: !isNum(f) ? null : f >= 7 ? "strong" : f >= 4 ? "average" : "weak",
      altman: isNum(z) ? Math.round(z * 100) / 100 : null, altman_zone: !isNum(z) ? null : z >= 3 ? "safe" : z >= 1.8 ? "grey" : "distress",
      accruals: isNum(accruals) ? accruals : null, cash_conversion: isNum(t.cfo) && t.ni > 0 ? t.cfo / t.ni : null,
      roic: isNum(n(m.returnOnInvestedCapitalTTM)) ? n(m.returnOnInvestedCapitalTTM) : null, roe: isNum(n(m.returnOnEquityTTM)) ? n(m.returnOnEquityTTM) : null,
      payout: isNum(n(r.dividendPayoutRatioTTM)) ? n(r.dividendPayoutRatioTTM) : null, buyback_yield: isNum(t.buyback) && isNum(n(m.marketCap)) && n(m.marketCap) > 0 ? t.buyback / n(m.marketCap) : null,
      fcf_yield: isNum(n(m.freeCashFlowYieldTTM)) ? n(m.freeCashFlowYieldTTM) : null, nd_ebitda: isNum(n(m.netDebtToEBITDATTM)) ? n(m.netDebtToEBITDATTM) : null,
      int_cover: isNum(n(r.interestCoverageRatioTTM)) ? n(r.interestCoverageRatioTTM) : null, capex_rev: isNum(n(m.capexToRevenueTTM)) ? n(m.capexToRevenueTTM) : null,
      sbc_rev: isNum(n(m.stockBasedCompensationToRevenueTTM)) ? n(m.stockBasedCompensationToRevenueTTM) : null, ccc: isNum(n(m.cashConversionCycleTTM)) ? n(m.cashConversionCycleTTM) : null,
    };
  }
  /**
   * What the price assumes: the steady free-cash-flow growth at which today's market cap is fair, at a cost of
   * equity of rf + beta x ERP (P = FCF x (1+g) / (r-g) -> g = (rP - FCF) / (P + FCF)).
   */
  function impliedGrowth({ fcf, mcap, rf, beta, erp }) {
    const b = isNum(beta) ? Math.min(Math.max(beta, 0.5), 2) : 1, e = isNum(erp) ? erp : 0.045, r0 = isNum(rf) ? rf : 0.042, r = r0 + b * e;
    if (!(fcf > 0) || !(mcap > 0)) return { r, g: null };
    return { r, g: (r * mcap - fcf) / (mcap + fcf) };
  }

  // ------------------------------------------------------------------ the industry's sections, row by row, for the company
  const SEV = { high: 0, medium: 1, low: 2 };
  /**
   * The industry report's own rows, each with an ID the company write-up answers row by row:
   * macro indicators (I#, the industry's IDs), world situations (W#), trade countries (C#), rules (R#), plus the KPI read.
   * run: {macro: {rows}, reports: {macro, world, trade, trademap, kpi}, books: [{body, book}]}; geo: geoMap rows (the company's revenue by region).
   */
  function lensInputs(run, geo = []) {
    const R = run?.reports || {}, mi = R.macro?.indicators || {};
    const indicators = (run?.macro?.rows || []).filter((r) => r?.id).map((r) => { const x = mi[r.id] || {};
      return { id: r.id, label: r.label, group: r.group, value: r.value, unit: r.unit, prior: r.prior, prior_label: r.prior_label, date: r.date,
        ind: x.relevance ? { relevance: x.relevance, effect: x.effect, why: trim(x.why_it_matters || x.why || x.relevance_why, 260) } : null }; });
    const situations = (R.world?.dives || []).slice(0, 10).map((x, i) => ({ id: "W" + (i + 1), title: x.title, stance: x.stance, status: x.status, region: x.region,
      summary: trim(x.summary, 360), first_order: trim(x.first_order, 220), exposure: (x.exposure || []).slice(0, 5).map((e) => `${e.segment} (${e.level}${e.names?.length ? ": " + e.names.slice(0, 6).join(", ") : ""})`).join("; "),
      winners: (x.winners || []).map((w) => w.symbol).filter(Boolean).slice(0, 8), losers: (x.losers || []).map((w) => w.symbol).filter(Boolean).slice(0, 8) }));
    const tradeBy = Object.fromEntries((R.trade?.countries || []).map((c) => [lc(c.country), c]));
    const shareOf = (country) => { const g = (geo || []).find((r) => (r.countries || []).some((c) => lc(c.country) === lc(country))); return g ? { region: g.region, share: g.share } : null; };
    const countries = (R.trademap?.countries || []).slice(0, 12).map((c, i) => ({ id: "C" + (i + 1), country: c.country, importance: c.importance, stance: c.stance, trajectory: c.trajectory, threat: c.threat, roles: (c.roles || []).join(", "),
      why: trim(c.why, 260), headline: trim(tradeBy[lc(c.country)]?.headline, 300), revenue: shareOf(c.country) }));
    const rules = (run?.books || []).flatMap((b) => (b.book?.rules || []).map((r) => ({ body: b.body, ...r })))
      .sort((a, b) => (SEV[a.severity] ?? 3) - (SEV[b.severity] ?? 3) || (a.status === "in_force" ? -1 : 1)).slice(0, 14)
      .map((r, i) => ({ id: "R" + (i + 1), body: trim(r.body, 90), name: trim(r.name, 160), status: r.status, effective: trim(r.effective, 100), severity: r.severity, bottom_line: trim(r.bottom_line || r.industry_impact, 300) }));
    const k = R.kpi || {};
    const kpi = k.summary || k.cycle_position ? { cycle: k.cycle_position, cycle_text: trim(k.cycle_text, 300), pricing_power: k.pricing_power?.level, pricing_text: trim(k.pricing_power?.text, 300), who_has_it: trim(k.pricing_power?.who_has_it, 200),
      hot: (k.hot_segments || []).map((x) => x.name).slice(0, 6), cool: (k.cool_segments || []).map((x) => x.name).slice(0, 6) } : null;
    return { indicators, situations, countries, rules, kpi };
  }
  function lensBlock(L, sym) {
    const v = (r) => (r.value === null || r.value === undefined ? "n/a" : `${r.value}${r.unit && r.unit !== "index" ? r.unit : ""}`);
    return `THE INDUSTRY REPORT'S ROWS (answer each for ${sym} by its ID)
Macro indicators (latest; prior; the industry's read):
${L.indicators.map((r) => `[${r.id}] ${r.label} (${r.group || ""}): ${v(r)}${r.prior !== undefined && r.prior !== null ? `, ${r.prior_label || "prior"} ${r.prior}` : ""} · industry: ${r.ind ? `${r.ind.relevance} relevance, ${r.ind.effect} — ${r.ind.why}` : "no read"}`).join("\n") || "(none)"}
World situations:
${L.situations.map((x) => `[${x.id}] ${x.title} (${x.stance}, ${x.status || ""}, ${x.region || ""}): ${x.summary} First-order: ${x.first_order}${x.exposure ? ` Exposure: ${x.exposure}.` : ""}${x.winners.length ? ` Winners: ${x.winners.join(", ")}.` : ""}${x.losers.length ? ` Losers: ${x.losers.join(", ")}.` : ""}`).join("\n") || "(none)"}
Trade countries (the industry's trade map):
${L.countries.map((c) => `[${c.id}] ${c.country}: ${c.importance} importance, ${c.stance}, ${c.trajectory}${c.threat && c.threat !== "none" ? `, ${c.threat} threat` : ""}; roles ${c.roles}. ${c.headline || c.why}${c.revenue ? ` ${sym}'s revenue in ${c.revenue.region}: ${(c.revenue.share * 100).toFixed(0)}%.` : ""}`).join("\n") || "(none)"}
Rules (from the regulatory rule books):
${L.rules.map((r) => `[${r.id}] ${r.body} — ${r.name} (${r.status}${r.effective ? ", " + r.effective : ""}; ${r.severity} severity): ${r.bottom_line}`).join("\n") || "(none)"}
${L.kpi ? `KPIs and cycle: ${L.kpi.cycle || ""} — ${L.kpi.cycle_text || ""} Pricing power ${L.kpi.pricing_power || ""}: ${L.kpi.pricing_text || ""} (who has it: ${L.kpi.who_has_it || "n/a"}). Hot segments: ${L.kpi.hot.join(", ") || "n/a"}. Cool: ${L.kpi.cool.join(", ") || "n/a"}.` : ""}`;
  }
  /** The company's row-by-row answers, kept only for rows that exist. */
  function cleanLens(raw, L, idx) {
    if (!raw || typeof raw !== "object" || !L) return null;
    const ok = (id) => !!idx?.[id];
    const txt = (s, k = 500) => trim(String(s ?? "").replace(/\[([A-Z]{1,2}\d{1,4}(?:,\s*[A-Z]{1,2}\d{1,4})*)\]/g, (m, g) => { const keep = g.split(/,\s*/).filter(ok); return keep.length ? `[${keep.join(", ")}]` : ""; }).replace(/\s+([.,;:])/g, "$1"), k);
    const ev = (a) => (Array.isArray(a) ? a.map(String).filter(ok).slice(0, 6) : []);
    const en = (v, list, d) => (list.includes(lc(v)) ? lc(v) : d);
    const rows = (arr, ids, f) => { const m = {}; for (const x of Array.isArray(arr) ? arr : []) { const id = String(x?.id || "").toUpperCase(); if (ids.has(id) && !m[id]) m[id] = f(x); } return m; };
    const VS = ["more", "less", "same", "opposite"];
    const M = raw.macro || {};
    return {
      macro: { regime: en(M.regime, ["supportive", "mixed", "headwind"], ""), headline: txt(M.headline, 400),
        horizons: Object.fromEntries(HZ.filter((h) => M.horizons?.[h]).map((h) => [h, { call: en(M.horizons[h].call, ["supportive", "mixed", "headwind"], "mixed"), why: txt(M.horizons[h].why, 400) }])),
        indicators: rows(M.indicators, new Set(L.indicators.map((r) => r.id)), (x) => ({ relevance: en(x.relevance, ["high", "medium", "low"], ""), effect: en(x.effect, ["tailwind", "headwind", "neutral"], "neutral"), vs_industry: en(x.vs_industry, VS, ""), why: txt(x.why, 360) })) },
      world: rows(raw.world, new Set(L.situations.map((r) => r.id)), (x) => ({ effect: en(x.effect, ["helps", "hurts", "mixed", "none"], "mixed"), magnitude: en(x.magnitude, ["high", "medium", "low"], ""), vs_industry: en(x.vs_industry, VS, ""), why: txt(x.why, 500), evidence: ev(x.evidence) })),
      trade: rows(raw.trade, new Set(L.countries.map((r) => r.id)), (x) => ({ exposure: en(x.exposure, ["high", "medium", "low", "none"], ""), effect: en(x.effect, ["helps", "hurts", "mixed", "none"], "mixed"), why: txt(x.why, 500), evidence: ev(x.evidence) })),
      regulation: rows(raw.regulation, new Set(L.rules.map((r) => r.id)), (x) => ({ effect: en(x.effect, ["helps", "hurts", "mixed", "none"], "mixed"), materiality: en(x.materiality, ["high", "medium", "low"], ""), why: txt(x.why, 500), evidence: ev(x.evidence) })),
      cycle: raw.cycle ? { position: txt(raw.cycle.position, 200), pricing_power: en(raw.cycle.pricing_power, ["stronger", "weaker", "same"], ""), why: txt(raw.cycle.why, 600) } : null,
    };
  }

  // ------------------------------------------------------------------ the thesis
  /** Keep a report small for the prompt: no evidence lists, strings and arrays cut short. */
  function lean(o, s = 420, a = 8, depth = 0) {
    if (o === null || o === undefined || depth > 6) return undefined;
    if (typeof o === "string") return trim(o, s);
    if (typeof o !== "object") return o;
    if (Array.isArray(o)) return o.slice(0, a).map((x) => lean(x, s, a, depth + 1)).filter((x) => x !== undefined);
    const out = {};
    for (const [k, v] of Object.entries(o)) { if (/^(evidence|sources|refs|checks|fact_check|tools_used|quotes|raw|dropped|kept|gaps|horizon_facts|horizon_checks|supported_share|tickers_ok|plans|overlay)$/.test(k)) continue; const x = lean(v, s, a, depth + 1); if (x !== undefined && x !== "") out[k] = x; }
    return out;
  }
  const HZ = ["1M", "3M", "6M", "12M"];
  /** The JSON the thesis asks for: the whole of it, or one of its two halves (written in parallel). */
  const FIELDS = {
    headline: `"headline": "one sentence"`, verdict: `"verdict": {"call": "yes | conditional | no", "summary": "2-3 sentences: is this a real opportunity now, and in what form"}`,
    thesis: `"thesis": "3 paragraphs: the case, what makes it different from its peers, what the price already assumes"`,
    vs_industry: `"vs_industry": {"call": "outperform | in line | underperform", "why": "2-3 sentences"}`,
    drivers: `"drivers": [{"driver": "the industry driver", "industry_view": "one sentence", "effect": "stronger | weaker | same | opposite", "why": "2 sentences on this company", "evidence": []}]`,
    exposures: `"exposures": {"world": [{"situation": "...", "effect": "helps | hurts | mixed", "magnitude": "...", "why": "...", "evidence": []}], "trade": [{"country": "...", "dependence": "...", "risk": "...", "evidence": []}], "regulation": [{"rule": "...", "effect": "helps | hurts | mixed", "why": "...", "evidence": []}], "macro": [{"factor": "...", "sensitivity": "high | medium | low", "why": "..."}]}`,
    moat: `"moat": {"rating": "wide | narrow | none", "sources": ["..."], "threats": ["..."]}`,
    management: `"management": "2-3 sentences: execution, guidance record, capital allocation (cite)"`,
    quality: `"quality": "2 sentences on earnings quality and the balance sheet"`,
    valuation: `"valuation": {"read": "2-3 sentences vs history, peers and what is priced in", "fair_value": [low, high]}`,
    scenarios: `"scenarios": {"bull": {"probability": 25, "narrative": "...", "eps_change": [8, 14], "pe": [24, 27], "price_target": [100, 110]}, "base": {...}, "bear": {...}}`,
    horizons: `"horizons": {${["1M", "3M", "6M", "12M"].map((h) => `"${h}": {"call": "bullish | neutral | bearish", "expected_move": [-3, 5], "probability_up": 55, "vs_industry": "outperform | in line | underperform", "drivers": "2 sentences, cited"}`).join(", ")}}`,
    risks: `"risks": [{"risk": "...", "likelihood": "high | medium | low", "impact": "high | medium | low", "evidence": []}]`,
    catalysts: `"catalysts": [{"date": "YYYY-MM-DD or YYYY-MM", "event": "...", "why": "..."}]`,
    watch: `"watch": ["..."]`, fit: `"fit": {"income": {"fit": "strong | good | weak | poor", "why": "..."}, "conservative": {...}, "growth": {...}, "aggressive": {...}}`,
    confidence: `"confidence": "high | medium | low"`,
    lens: `"macro": {"regime": "supportive | mixed | headwind (for this company)", "headline": "one sentence on the macro for this company", "horizons": {"1M": {"call": "supportive | mixed | headwind", "why": "1-2 sentences"}, "3M": {...}, "6M": {...}, "12M": {...}},
   "indicators": [{"id": "I1", "relevance": "high | medium | low", "effect": "tailwind | headwind | neutral", "vs_industry": "more | less | same | opposite", "why": "one sentence on this company"}]},
 "world": [{"id": "W1", "effect": "helps | hurts | mixed | none", "magnitude": "high | medium | low", "vs_industry": "more | less | same | opposite", "why": "1-2 sentences on this company", "evidence": []}],
 "trade": [{"id": "C1", "exposure": "high | medium | low | none", "effect": "helps | hurts | mixed | none", "why": "1-2 sentences", "evidence": []}],
 "regulation": [{"id": "R1", "effect": "helps | hurts | mixed | none", "materiality": "high | medium | low", "why": "1-2 sentences", "evidence": []}],
 "cycle": {"position": "where this company is in the industry's cycle", "pricing_power": "stronger | weaker | same (vs the industry)", "why": "2 sentences"}`,
  };
  const PART = {
    core: ["headline", "verdict", "thesis", "vs_industry", "valuation", "scenarios", "horizons", "moat", "management", "quality", "risks", "catalysts", "watch", "fit", "confidence"],
    context: ["drivers", "lens"],
  };
  function schemaFor(part) {
    const keys = PART[part] || Object.keys(FIELDS).filter((k) => k !== "lens");
    const intro = part === "core" ? "This is the first half of a two-part write-up; a colleague goes through the industry report row by row (drivers, macro indicators, world situations, trade countries, rules) at the same time. Write ONLY the fields below.\n"
      : part === "context" ? "This is the second half of a two-part write-up; a colleague writes the verdict, thesis, scenarios, 1M-12M calls, risks and catalysts at the same time. Write ONLY the fields below: take the industry report's rows (THE INDUSTRY REPORT'S ROWS) one by one and say what each means for this company specifically, more or less than for the industry and why, using its business mix, regions and numbers.\n" : "";
    const sizes = part === "core" ? "\nSizes: 4-7 risks, 3-6 catalysts, 3-5 watch items." : part === "context" ? "\nSizes: 5-8 drivers; one entry for EVERY macro indicator, world situation, trade country and rule ID listed (keep each why to one or two sentences)." : "\nSizes: 5-8 drivers, 2-6 entries in each exposure list (empty if none), 4-7 risks, 3-6 catalysts, 3-5 watch items.";
    return `${intro}Reply with ONLY this JSON:\n{${keys.map((k) => FIELDS[k]).join(",\n ")}}${sizes}`;
  }
  /**
   * ctx: {today, sym, name, industry, inTop50, rank, px, profile, row, peers (peerTable), closest, quality, implied, estimates, consensus, insider,
   *       geo (geoMap), seg (segMap), segments: {product, geo}, quarters, mentions (with A-IDs), news (with N/P-IDs), transcript ({id, text}),
   *       risk: {beta, alpha, vol}, industryDigest: {lead, kpi, macro, world, trade, regverdict, books}}
   */
  function thesisPrompt(ctx, part = null) {
    const J = (x) => JSON.stringify(x);
    const pc = (x, d = 1) => (isNum(x) ? `${(x * 100).toFixed(d)}%` : "n/a"), fx = (x, d = 1) => (isNum(x) ? x.toFixed(d) : "n/a");
    const D = ctx.industryDigest || {};
    return `You are a senior equity analyst. Write the investment analysis of ${ctx.name} (${ctx.sym}), a company in the US-listed "${ctx.industry}" industry, today ${ctx.today}. Your team has already analyzed the whole industry in depth (below); build on that work: say how each industry finding applies to THIS company, more or less than to its peers, and why, using the company's own business, numbers and news. ${ctx.inTop50 ? `It is #${ctx.rank} of the industry's top 50 by market cap, so the industry analysis names it in places (INDUSTRY ANALYSIS ON THIS COMPANY).` : `It is NOT among the 50 companies the industry analysis covered by name: connect it to the industry findings through its own business mix, geography and numbers.`}

COMPANY
Price ${fx(ctx.px, 2)} · market cap ${isNum(n(ctx.row?.market_cap)) ? (n(ctx.row.market_cap) / 1e9).toFixed(1) + "B" : "n/a"} · ${ctx.profile?.exchange || ""} · CEO ${ctx.profile?.ceo || "n/a"} · employees ${ctx.profile?.fullTimeEmployees || "n/a"}
Business: ${trim(ctx.profile?.description, 1600)}
Revenue by product (${ctx.segments?.product?.label || "n/a"}): ${(ctx.segments?.product?.items || []).map((x) => `${x.name} ${pc(x.share, 0)}${isNum(x.yoy) ? ` (${x.yoy >= 0 ? "+" : ""}${pc(x.yoy, 0)} y/y)` : ""}`).join("; ") || "n/a"}
Revenue by geography (${ctx.segments?.geo?.label || "n/a"}): ${(ctx.segments?.geo?.items || []).map((x) => `${x.name} ${pc(x.share, 0)}${isNum(x.yoy) ? ` (${x.yoy >= 0 ? "+" : ""}${pc(x.yoy, 0)} y/y)` : ""}`).join("; ") || "n/a"}
Last quarters (newest first; revenue $M, gross / operating margin, net income $M): ${(ctx.quarters || []).slice(0, 8).map((q) => `${q.date} ${isNum(q.rev) ? (q.rev / 1e6).toFixed(0) : "n/a"}, ${q.rev ? pc(q.gp / q.rev, 0) : "n/a"}/${q.rev ? pc(q.oi / q.rev, 0) : "n/a"}, ${isNum(q.ni) ? (q.ni / 1e6).toFixed(0) : "n/a"}`).join(" | ") || "n/a"}
Quality: Piotroski ${ctx.quality?.piotroski ?? "n/a"}/9, Altman Z ${ctx.quality?.altman ?? "n/a"} (${ctx.quality?.altman_zone || "n/a"}), ROIC ${pc(ctx.quality?.roic)}, cash conversion ${fx(ctx.quality?.cash_conversion, 2)}x, accruals ${pc(ctx.quality?.accruals)}, payout ${pc(ctx.quality?.payout, 0)}, buyback yield ${pc(ctx.quality?.buyback_yield)}, FCF yield ${pc(ctx.quality?.fcf_yield)}, net debt/EBITDA ${fx(ctx.quality?.nd_ebitda)}, interest cover ${fx(ctx.quality?.int_cover)}, stock comp/revenue ${pc(ctx.quality?.sbc_rev)}.
What the price assumes: steady FCF growth of ${pc(ctx.implied?.g)} a year at a ${pc(ctx.implied?.r)} cost of equity.
Risk (1Y): beta ${fx(ctx.risk?.beta, 2)}, alpha ${pc(ctx.risk?.alpha)} a year vs SPY, volatility ${pc(ctx.risk?.vol, 0)}.${ctx.facts ? "\n" + ctx.facts : ""}
Estimates: ${(ctx.estimates || []).map((e) => `FY${e.year}: revenue ${isNum(e.rev) ? (e.rev / 1e9).toFixed(2) + "B" : "n/a"}, EPS ${fx(e.eps, 2)}`).join("; ") || "n/a"}. Sell side: ${ctx.consensus ? `${ctx.consensus.consensus || "n/a"} (${ctx.consensus.buy} buy / ${ctx.consensus.hold} hold / ${ctx.consensus.sell} sell), target ${fx(ctx.consensus.target, 2)} (${fx(ctx.consensus.low, 0)}-${fx(ctx.consensus.high, 0)})` : "n/a"}. Insiders (last 2 quarters): ${ctx.insider ? `${ctx.insider.purchases} buys, sales ${fx(ctx.insider.sales_vs_norm, 2)}x normal` : "n/a"}.

VERSUS THE INDUSTRY'S TOP 50 (value · industry median · percentile, 100 = highest)
${(ctx.peers || []).map((r) => `${r.label}: ${r.kind === "pct" || r.kind === "chg" ? pc(r.value) : r.kind === "cap" ? (r.value / 1e9).toFixed(1) + "B" : fx(r.value, 2)} · ${r.kind === "pct" || r.kind === "chg" ? pc(r.median) : r.kind === "cap" ? (r.median / 1e9).toFixed(1) + "B" : fx(r.median, 2)} · p${r.pct ?? "n/a"}`).join("\n")}
Closest peers in the industry: ${(ctx.closest || []).map((c) => `${c.symbol} (${trim(c.name, 40)}; cap ${(n(c.market_cap) / 1e9).toFixed(1)}B, P/E ${fx(n(c.pe))}, growth ${pc(n(c.rev_growth), 0)}, op margin ${pc(n(c.op_margin), 0)}, 1Y ${pc(n(c.ret_1Y), 0)})`).join("; ") || "n/a"}

ITS REVENUE ON THE INDUSTRY'S TRADE MAP
${(ctx.geo || []).map((g) => `${g.region} ${pc(g.share, 0)} → ${g.countries.map((c) => `${c.country} (${c.stance || "n/a"}, ${c.trajectory || ""}, ${c.importance || ""} importance${c.threat && c.threat !== "none" ? `, threat ${c.threat}` : ""})`).join("; ") || "no trade-map country"}`).join("\n") || "n/a"}
ITS PRODUCT LINES VS THE INDUSTRY'S HOT AND COOL SEGMENTS
${(ctx.seg || []).map((s) => `${s.segment} ${pc(s.share, 0)} → ${s.match ? `${s.match.temp} segment "${s.match.name}": ${s.match.text}` : "no match"}`).join("\n") || "n/a"}

INDUSTRY ANALYSIS ON THIS COMPANY (cite by A-ID)
${(ctx.mentions || []).map((m) => `[${m.id}] ${m.section}${m.where ? ` › ${m.where}` : ""}${m.role ? ` (${m.role})` : ""}: ${m.text}`).join("\n") || "(not named in the industry analysis)"}

COMPANY NEWS AND PRESS RELEASES (last 60 days; cite by ID)
${(ctx.news || []).map((x) => `[${x.id}] ${x.date} · ${x.source || ""} — ${x.title}${x.summary ? `. ${trim(x.summary, 240)}` : ""}`).join("\n") || "(none)"}
${ctx.transcript ? `\nLATEST EARNINGS CALL [${ctx.transcript.id}] (${ctx.transcript.period || ""}, ${ctx.transcript.date || ""}; cite by ID)\n${trim(ctx.transcript.text, 7000)}\n` : ""}
${part === "context" && ctx.lens ? lensBlock(ctx.lens, ctx.sym) + "\n\n" : ""}THE INDUSTRY ANALYSIS (your team's; the industry-level view)
Lead strategist: ${J(lean(D.lead, 600, 8))}
KPIs and cycle: ${J(lean(D.kpi, 300, 6))}
Macro: ${J(lean(D.macro, 300, 6))}
World events: ${J(lean(D.world, 300, 6))}
Trade and supply chain: ${J(lean(D.trade, 260, 8))}
Regulation: ${J(lean(D.regverdict, 300, 6))}
Rule books (top rules): ${J(lean(D.books, 220, 6))}

RULES
- Cite every factual claim with IDs in square brackets: [A#] for the industry analysis, [N#]/[P#] for news and releases, [T#] for the call. Numbers given above (statements, ratios, percentiles) need no citation. Never invent a fact, date, figure or quote; say "(estimate)" for your own estimates.
- Be specific to this company: name its brands, segments, regions, customers and competitors where the data supports it. Compare with peers by ticker.
- Each driver: the industry's view, then whether it hits ${ctx.sym} more, less, the same or the opposite way, and why.
- Scenarios: "eps_change" is the change in next-twelve-month EPS from today's (a [low, high] range in %), "pe" the [low, high] P/E in 12 months, "price_target" the [low, high] price in 12 months; they must agree (price ≈ today's price x (1 + EPS change) x P/E / today's P/E ${isNum(n(ctx.row?.fwd_pe)) ? fx(n(ctx.row.fwd_pe)) : isNum(n(ctx.row?.pe)) ? fx(n(ctx.row.pe)) : "n/a"}); probabilities sum to 100.
- Horizons: each call is your own judgment for that window; "vs_industry" says whether ${ctx.sym} should beat, match or lag the industry, given its beta ${fx(ctx.risk?.beta, 2)} and the industry calls.

${schemaFor(part)}`;
  }

  /** Keep only citations that exist; cut lengths; normalize enums. */
  function cleanThesis(raw, idx) {
    if (!raw || typeof raw !== "object") return null;
    const ok = (id) => !!idx[id];
    const txtP = (s, k) => String(s ?? "").split(/\n{2,}/).map((x) => txt(x, k)).filter(Boolean).join("\n\n").slice(0, k);
    const txt = (s, k = 1400) => trim(String(s ?? "").replace(/\[([A-Z]{1,2}\d{1,4}(?:,\s*[A-Z]{1,2}\d{1,4})*)\]/g, (m, g) => { const keep = g.split(/,\s*/).filter(ok); return keep.length ? `[${keep.join(", ")}]` : ""; }).replace(/\s+([.,;:])/g, "$1"), k);
    const ev = (a) => (Array.isArray(a) ? a.map(String).filter(ok).slice(0, 6) : []);
    const en = (v, list, d) => (list.includes(lc(v)) ? lc(v) : d);
    const rng = (r) => (Array.isArray(r) ? r.map(Number).filter(isNum).slice(0, 2).sort((a, b) => a - b) : isNum(Number(r)) ? [Number(r)] : []);
    const arr = (x, k) => (Array.isArray(x) ? x.slice(0, k) : []);
    const sc = (s) => (s && typeof s === "object" ? { probability: isNum(Number(s.probability)) ? Number(s.probability) : null, narrative: txt(s.narrative, 900), eps_change: rng(s.eps_change), pe: rng(s.pe), price_target: rng(s.price_target) } : null);
    const fit = (f) => (f && typeof f === "object" ? { fit: en(f.fit, ["strong", "good", "weak", "poor"], ""), why: txt(f.why, 300) } : null);
    return {
      headline: txt(raw.headline, 300), verdict: { call: en(raw.verdict?.call, ["yes", "conditional", "no"], ""), summary: txt(raw.verdict?.summary, 600) },
      thesis: txtP(raw.thesis, 4000), vs_industry: { call: en(raw.vs_industry?.call, ["outperform", "in line", "underperform"], ""), why: txt(raw.vs_industry?.why, 600) },
      drivers: arr(raw.drivers, 10).map((d) => ({ driver: txt(d?.driver, 200), industry_view: txt(d?.industry_view, 400), effect: en(d?.effect, ["stronger", "weaker", "same", "opposite"], "same"), why: txt(d?.why, 600), evidence: ev(d?.evidence) })).filter((d) => d.driver),
      exposures: {
        world: arr(raw.exposures?.world, 8).map((x) => ({ situation: txt(x?.situation, 200), effect: en(x?.effect, ["helps", "hurts", "mixed"], "mixed"), magnitude: txt(x?.magnitude, 160), why: txt(x?.why, 500), evidence: ev(x?.evidence) })).filter((x) => x.situation),
        trade: arr(raw.exposures?.trade, 8).map((x) => ({ country: txt(x?.country, 80), dependence: txt(x?.dependence, 300), risk: txt(x?.risk, 400), evidence: ev(x?.evidence) })).filter((x) => x.country),
        regulation: arr(raw.exposures?.regulation, 8).map((x) => ({ rule: txt(x?.rule, 200), effect: en(x?.effect, ["helps", "hurts", "mixed"], "mixed"), why: txt(x?.why, 500), evidence: ev(x?.evidence) })).filter((x) => x.rule),
        macro: arr(raw.exposures?.macro, 6).map((x) => ({ factor: txt(x?.factor, 120), sensitivity: en(x?.sensitivity, ["high", "medium", "low"], ""), why: txt(x?.why, 400) })).filter((x) => x.factor),
      },
      moat: { rating: en(raw.moat?.rating, ["wide", "narrow", "none"], ""), sources: arr(raw.moat?.sources, 5).map((x) => txt(x, 200)), threats: arr(raw.moat?.threats, 5).map((x) => txt(x, 200)) },
      management: txt(raw.management, 800), quality: txt(raw.quality, 600), valuation: { read: txt(raw.valuation?.read, 900), fair_value: rng(raw.valuation?.fair_value) },
      scenarios: { bull: sc(raw.scenarios?.bull), base: sc(raw.scenarios?.base), bear: sc(raw.scenarios?.bear) },
      horizons: Object.fromEntries(HZ.filter((h) => raw.horizons?.[h]).map((h) => { const x = raw.horizons[h]; const pu = Number(x.probability_up);
        return [h, { call: en(x.call, ["bullish", "neutral", "bearish"], "neutral"), expected_move: rng(x.expected_move), probability_up: isNum(pu) ? Math.max(0, Math.min(100, Math.round(pu))) : null, vs_industry: en(x.vs_industry, ["outperform", "in line", "underperform"], ""), drivers: txt(x.drivers, 700) }]; })),
      risks: arr(raw.risks, 8).map((x) => ({ risk: txt(x?.risk, 300), likelihood: en(x?.likelihood, ["high", "medium", "low"], ""), impact: en(x?.impact, ["high", "medium", "low"], ""), evidence: ev(x?.evidence) })).filter((x) => x.risk),
      catalysts: arr(raw.catalysts, 8).map((x) => ({ date: String(x?.date || "").slice(0, 10), event: txt(x?.event, 200), why: txt(x?.why, 300) })).filter((x) => x.event),
      watch: arr(raw.watch, 6).map((x) => txt(x, 200)).filter(Boolean),
      fit: Object.fromEntries(["income", "conservative", "growth", "aggressive"].map((k) => [k, fit(raw.fit?.[k])]).filter(([, v]) => v?.fit)),
      confidence: en(raw.confidence, ["high", "medium", "low"], ""),
    };
  }
  /** Code checks: scenario probabilities and math, expected return, the 1M-12M calls against their own numbers. */
  function checks(t, px, pe) {
    const issues = [], mid = (r) => (r?.length ? r.reduce((a, x) => a + x, 0) / r.length : NaN);
    const sc = ["bull", "base", "bear"].map((k) => [k, t?.scenarios?.[k]]).filter(([, s]) => s);
    const psum = sc.reduce((a, [, s]) => a + (isNum(s.probability) ? s.probability : 0), 0);
    if (sc.length && Math.abs(psum - 100) > 2) issues.push(`scenario probabilities add up to ${psum}%, not 100%`);
    const rows = sc.map(([k, s]) => {
      const tgt = mid(s.price_target), implied = isNum(px) && isNum(pe) && pe > 0 && s.eps_change.length && s.pe.length ? px * (1 + mid(s.eps_change) / 100) * (mid(s.pe) / pe) : NaN;
      const move = isNum(tgt) && px > 0 ? tgt / px - 1 : NaN;
      if (isNum(tgt) && isNum(implied) && Math.abs(tgt / implied - 1) > 0.15) issues.push(`${k} target ${tgt.toFixed(0)} doesn't follow from its EPS and P/E (about ${implied.toFixed(0)})`);
      return { k, probability: s.probability, target: isNum(tgt) ? tgt : null, implied: isNum(implied) ? implied : null, move: isNum(move) ? move : null };
    });
    const exp = rows.length && rows.every((r) => isNum(r.move) && isNum(r.probability)) ? rows.reduce((a, r) => a + r.move * r.probability / 100, 0) : null;
    const up = rows.find((r) => r.k === "bull")?.move ?? null, down = rows.find((r) => r.k === "bear")?.move ?? null;
    for (const h of HZ) { const x = t?.horizons?.[h]; if (!x) continue; const m = mid(x.expected_move);
      if (x.call === "bullish" && isNum(m) && m <= 0) issues.push(`${h} is bullish but its range is centered below zero`);
      if (x.call === "bearish" && isNum(m) && m >= 0) issues.push(`${h} is bearish but its range is centered above zero`);
      if (h === "12M" && isNum(exp) && isNum(m) && Math.abs(m - exp * 100) > 8) issues.push(`the 12M range (${m.toFixed(0)}%) and the scenarios' expected return (${(exp * 100).toFixed(0)}%) disagree`); }
    return { issues, scenarios: rows, expected_return: exp, upside: up, downside: down };
  }

  const Company = { METRICS, pctRank, peerTable, closestPeers, nameCore, mentions, geoMap, segMap, quality, impliedGrowth, lean, thesisPrompt, cleanThesis, checks, SECTION, PART, lensInputs, cleanLens };
  if (typeof module !== "undefined" && module.exports) module.exports = Company;
  else root.Company = Company;
})(typeof window !== "undefined" ? window : globalThis);
