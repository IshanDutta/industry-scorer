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
  /** For the write-up itself: generous room (2.5x), and when something is still too long, end at a sentence, never mid-word. */
  const keepT = (s, k) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); const K = Math.round(k * 2.5); if (s.length <= K) return s;
    const cut = s.slice(0, K), m = [...cut.matchAll(/[.!?](?=\s|$)/g)].pop(); if (m && m.index > K * 0.4) return cut.slice(0, m.index + 1);
    const w = cut.lastIndexOf(" "); return (w > K * 0.6 ? cut.slice(0, w) : cut).replace(/[,;:\s]+$/, "") + "…"; };
  const median = (a) => { const v = a.filter(isNum).sort((x, y) => x - y); if (!v.length) return NaN; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
  const lc = (s) => String(s || "").toLowerCase();
  const Calls = typeof module !== "undefined" && module.exports ? require("./calls.js") : root.Calls;

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
  // Countries by region, so a reported region ("Asia Pacific", "EMEA", "Other countries") or a country the trade map
  // leaves out can still be tied to the trade-map countries that drive it.
  const TAGS = {};
  const tag = (list, tags) => list.forEach((c) => (TAGS[c] = tags));
  tag(["united states"], ["americas", "na"]); tag(["canada"], ["americas", "na"]); tag(["mexico"], ["americas", "na", "latam"]);
  tag(["brazil", "argentina", "chile", "colombia", "peru", "panama", "ecuador", "venezuela", "dominican republic", "guatemala", "costa rica", "uruguay", "bolivia", "suriname", "guyana"], ["americas", "latam"]);
  tag(["united kingdom", "ireland", "germany", "france", "italy", "spain", "netherlands", "belgium", "switzerland", "sweden", "norway", "denmark", "finland", "poland", "austria", "portugal", "greece", "czech republic", "hungary", "romania", "russia", "ukraine", "luxembourg", "serbia", "bulgaria", "slovakia"], ["europe", "emea"]);
  tag(["turkey"], ["europe", "emea", "me"]);
  tag(["saudi arabia", "united arab emirates", "israel", "qatar", "iran", "iraq", "kuwait", "oman", "bahrain", "jordan", "lebanon", "yemen"], ["me", "emea"]);
  tag(["egypt"], ["me", "africa", "emea"]);
  tag(["south africa", "nigeria", "ghana", "mali", "kenya", "morocco", "democratic republic of the congo", "dr congo", "zambia", "burkina faso", "tanzania", "ethiopia", "cote d'ivoire", "guinea", "senegal", "algeria", "angola", "botswana", "namibia"], ["africa", "emea"]);
  tag(["china", "hong kong", "taiwan", "japan", "south korea", "north korea", "india", "singapore", "vietnam", "thailand", "malaysia", "indonesia", "philippines", "bangladesh", "pakistan", "sri lanka", "kazakhstan", "mongolia"], ["asia", "apac"]);
  tag(["australia", "new zealand", "papua new guinea", "fiji"], ["oceania", "apac"]);
  const ALIAS = { usa: "united states", "u.s.": "united states", "u.s.a.": "united states", us: "united states", "united states of america": "united states", uk: "united kingdom", "u.k.": "united kingdom", "great britain": "united kingdom", britain: "united kingdom",
    korea: "south korea", "republic of korea": "south korea", "korea, republic of": "south korea", uae: "united arab emirates", prc: "china", "mainland china": "china", "russian federation": "russia", "viet nam": "vietnam", "taiwan, province of china": "taiwan", "hong kong sar": "hong kong", holland: "netherlands" };
  const REGION_RE = [[/north america|u\.?s\.? (and|&) canada/, ["na"]], [/latin america|latam|south america|central america|caribbean/, ["latam"]], [/americas/, ["americas"]], [/emea|europe,? (the )?middle east|middle east (and|&) africa/, ["emea"]],
    [/europe|eurozone|\beu\b|nordic|scandinavia|benelux|dach/, ["europe"]], [/middle east|gulf|mena/, ["me"]], [/africa|sub-saharan/, ["africa"]], [/asia|apac|pacific|far east|greater china|asean|oceania|australasia/, ["apac"]]];
  const WORLD_RE = /international|rest of (the )?world|other (countries|regions|international|foreign|geograph)|foreign|outside (the )?u\.?s|non-u\.?s|global|worldwide|\brow\b|overseas|export/;
  const HOME_RE = /^(the )?(united states|u\.?s\.?a?\.?|us|domestic|usa)( segment)?$|united states|domestic/;
  const BIZ_RE = /segment|upstream|downstream|midstream|division|business|products?\b|services?\b|retail|wholesale|consumer|commercial|industrial|corporate|unallocated|elimination|other operations|refining|chemicals|mining|licens|royalt|software|hardware|devices|platform|subscription|advertising|financ|insurance|banking|manufactur/;
  /** The country a label names (after aliases), if any. */
  const countryIn = (name) => { const n = lc(name).replace(/[.,]/g, (m) => (m === "." ? "." : "")).trim();
    for (const [a, c] of Object.entries(ALIAS)) if (n === a || new RegExp(`(^|[^a-z])${a.replace(/[.]/g, "\\.")}([^a-z]|$)`).test(n)) return c;
    return Object.keys(TAGS).sort((x, y) => y.length - x.length).find((c) => n.includes(c)) || null; };
  /**
   * Each revenue region, with the trade-map countries that drive it and how they were matched:
   * kind = country (named on the map) | region (a continent or bloc) | offmap (a country the map leaves out: its neighbours on the map) |
   * world (international, other countries: the biggest non-US exposures) | home (the US) | business (a business line FMP files as a region).
   */
  function geoMap(geo, tradeMap) {
    const countries = tradeMap?.countries || [], IMP = { existential: 0, critical: 0, high: 1, medium: 2, low: 3 };
    const row = (c, via) => ({ country: c.country, stance: c.stance, trajectory: c.trajectory, threat: c.threat, importance: c.importance, via, exact: via === "exact" });
    const byImp = (list) => list.slice().sort((a, b) => (IMP[a.importance] ?? 4) - (IMP[b.importance] ?? 4));
    const mapKey = (c) => ALIAS[lc(c.country)] || lc(c.country);
    const out = (geo?.items || []).map((g) => {
      const name = lc(g.name), named = countryIn(g.name);
      let kind = "", hits = [], note = "";
      const exact = countries.filter((c) => named && mapKey(c) === named);
      if (exact.length) { kind = named === "united states" ? "home" : "country"; hits = exact.map((c) => row(c, "exact")); }
      else if (named && named !== "united states") {
        // A country the industry's trade map doesn't cover: tie it to the map's countries in the same part of the world.
        const tg = TAGS[named] || [];
        const shared = (c) => (TAGS[mapKey(c)] || []).filter((t) => tg.includes(t)).length;
        hits = byImp(countries.filter((c) => shared(c) > 0)).sort((a, b) => shared(b) - shared(a)).slice(0, 3).map((c) => row(c, "nearby"));
        kind = "offmap"; note = hits.length ? `${g.name} isn't on the industry's trade map; the closest countries on it` : `${g.name} isn't on the industry's trade map, and nothing near it is`;
      } else if (named === "united states" || HOME_RE.test(name)) { kind = "home"; hits = countries.filter((c) => mapKey(c) === "united states").map((c) => row(c, "exact")); note = hits.length ? "" : "Home market (US): the trade map covers the US's partners, not the US itself"; }
      else {
        const tg = REGION_RE.filter(([re]) => re.test(name)).flatMap(([, t]) => t);
        if (tg.length) { kind = "region"; hits = byImp(countries.filter((c) => (TAGS[mapKey(c)] || []).some((t) => tg.includes(t)))).slice(0, 4).map((c) => row(c, "region"));
          if (!hits.length) note = "None of the trade map's countries are in this region"; }
        else if (WORLD_RE.test(name) || !BIZ_RE.test(name)) { kind = "world"; hits = byImp(countries.filter((c) => mapKey(c) !== "united states")).slice(0, 4).map((c) => row(c, "world")); note = "Spread across other countries: the trade map's biggest exposures outside the US"; }
        else { kind = "business"; note = "A business line FMP files under geography; its sales follow the company's own footprint"; }
      }
      return { region: g.name, share: g.share, yoy: g.yoy, kind, note, countries: hits };
    });
    // A business line filed as a region sells where the company sells: the countries its real regions map to, else the map's biggest exposures.
    const foot = [...new Map(out.filter((r) => r.kind !== "business" && r.kind !== "world").flatMap((r) => r.countries).map((c) => [c.country, c])).values()];
    for (const r of out) if (r.kind === "business") r.countries = (foot.length ? byImp(foot) : byImp(countries.filter((c) => mapKey(c) !== "united states"))).slice(0, 4).map((c) => ({ ...c, via: "footprint", exact: false }));
    return out;
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
  function lensInputs(run, geo = [], seg = [], now = null) {
    const R = run?.reports || {}, mi = R.macro?.indicators || {};
    const indicators = (run?.macro?.rows || []).filter((r) => r?.id && (!mi[r.id] || mi[r.id].relevance !== "low")).slice(0, 30).map((r) => { const x = mi[r.id] || {};
      return { id: r.id, label: r.label, group: r.group, value: r.value, unit: r.unit, prior: r.prior, prior_label: r.prior_label, date: r.date,
        ind: x.relevance ? { relevance: x.relevance, effect: x.effect, why: trim(x.why_it_matters || x.why || x.relevance_why, 260) } : null }; });
    // World events: every deep dive in full, then the scout's other situations (lighter), then the world headlines behind them (H#).
    const nc = (t, k) => trim(String(t || "").replace(/\s*\[[A-Z]{1,2}\d{1,5}(?:,\s*[A-Z]{1,2}\d{1,5})*\]/g, "").replace(/\s+([.,;:])/g, "$1"), k);
    const chan = (c) => Object.entries(c || {}).flatMap(([k, v]) => (Array.isArray(v) ? v : []).slice(0, 3).map((x) => `${k}: ${x.name || ""} (${x.direction || ""}${x.magnitude ? ", " + x.magnitude : ""}${x.timing ? ", " + x.timing : ""})`)).slice(0, 6);
    const dives = (R.world?.dives || []).slice(0, 12);
    const deep = dives.map((x) => ({ title: x.title, stance: x.stance, status: x.status, region: x.region, category: x.category || "", actors: (x.actors || []).slice(0, 5), since: x.since || "", deep: true,
      summary: nc(x.summary, 400), now: nc(x.now, 360), why_now: nc(x.why_now, 240), trigger: nc(x.trigger, 240), first_order: nc(x.first_order, 240), near_term: nc(x.near_term, 260), structural: nc(x.structural, 220),
      developments: (x.developments || []).slice(-4).map((d) => ({ date: d.date || "", text: nc(d.text, 200) })), channels: chan(x.channels), offsets: (x.offsets || []).slice(0, 3).map((o) => nc(o, 160)),
      watch: (x.watch || []).slice(0, 3).map((w) => ({ indicator: trim(w.indicator, 80), signal: nc(w.signal, 140) })),
      exposure: (x.exposure || []).slice(0, 5).map((e) => `${e.segment} (${e.level}${e.names?.length ? ": " + e.names.slice(0, 6).join(", ") : ""})`).join("; "),
      winners: (x.winners || []).map((w) => w.symbol).filter(Boolean).slice(0, 8), losers: (x.losers || []).map((w) => w.symbol).filter(Boolean).slice(0, 8),
      scenarios: (x.scenarios || []).slice(0, 4).map((c) => ({ name: trim(c.name, 80), probability: c.probability, trigger: nc(c.trigger, 180), outcome: nc(c.outcome, 220) })), refs: [...(x.scout_evidence || [])] }));
    const seenT = new Set(dives.map((x) => lc(x.title).slice(0, 40)));
    const light = (R.world?.scout?.situations || []).filter((x) => x?.title && !seenT.has(lc(x.title).slice(0, 40)) && x.relevance !== "low").slice(0, Math.max(0, 16 - deep.length))
      .map((x) => ({ title: x.title, stance: x.stance, status: x.status, region: x.region, category: x.category || "", actors: (x.actors || []).slice(0, 4), since: x.since || "", deep: false, relevance: x.relevance || "",
        summary: nc(x.why, 320), first_order: "", exposure: "", winners: [], losers: [], scenarios: [], developments: [], channels: [], offsets: [], watch: [], refs: [...(x.evidence || x.scout_evidence || [])] }));
    const situations = [...deep, ...light].map((x, i) => ({ id: "W" + (i + 1), ...x }));
    // Headlines: the world news the situations rest on, newest first, those the dives cite ahead of the rest.
    const srcs = (R.world?.sources || []).filter((x) => x?.id && x.title), cited = new Set(situations.flatMap((x) => x.refs));
    const headlines = [...srcs].sort((a, b) => (cited.has(b.id) - cited.has(a.id)) || String(b.date || "").localeCompare(String(a.date || ""))).slice(0, 30)
      .map((x, i) => ({ id: "H" + (i + 1), src: x.id, date: String(x.date || "").slice(0, 10), source: x.source || "", title: trim(x.title, 180), summary: trim(x.summary, 220), url: x.url || "",
        situations: situations.filter((s) => s.refs.includes(x.id)).map((s) => s.id) }));
    for (const s of situations) { s.headlines = headlines.filter((h) => h.situations.includes(s.id)).map((h) => h.id); delete s.refs; }
    const tradeBy = Object.fromEntries((R.trade?.countries || []).map((c) => [lc(c.country), c]));
    const nc0 = (t, k) => trim(String(t || "").replace(/\s*\[[A-Z]{1,2}\d{1,5}(?:,\s*[A-Z]{1,2}\d{1,5})*\]/g, "").replace(/\s+([.,;:])/g, "$1"), k);
    const expBy = Object.fromEntries((R.trade?.exposure || []).map((e) => [lc(e.country), e]));
    // Everything the trade report says about one country, kept short enough for the prompt.
    const tradeDossier = (d, country) => { const e = expBy[lc(country)]; if (!d && !e) return {};
      return { alliance: d?.relationship?.alliance || "", relationship: nc0(d?.relationship?.summary, 220), outlook: nc0(d?.outlook, 240), freeze: nc0(d?.freeze, 320),
        risks: (d?.risks || []).slice(0, 3).map((r) => ({ risk: nc0(r.risk, 140), type: r.type || "", likelihood: r.likelihood || "", impact: r.impact || "", timing: r.timing || "", mechanism: nc0(r.mechanism, 200) })),
        security: d?.security ? { level: d.security.threat_level || "", threat: nc0(d.security.threat, 160), status: nc0(d.security.status, 160) } : null,
        deps: (d?.dependencies || []).slice(0, 3).map((x) => ({ input: nc0(x.input, 100), criticality: x.criticality || "", share: nc0(x.share, 120), substitutability: nc0(x.substitutability, 60) })),
        developments: (d?.developments || []).slice(0, 3).map((x) => ({ date: x.date || "", text: nc0(x.text, 180) })), watch: (d?.watch || []).slice(0, 4).map((w) => nc0(w, 140)),
        exposed: (d?.exposed || []).slice(0, 8).map((x) => ({ symbol: x.symbol, channel: x.channel || "", severity: x.severity || "", mechanism: nc0(x.mechanism, 200) })),
        ind_share: isNum(Number(e?.revenue_share)) ? Number(e.revenue_share) : null, hq: (e?.hq || []).slice(0, 8) }; };
    // The company's reported revenue that covers a country: the country's own line (exact), or the whole region it sits in.
    const shareOf = (country) => { let hit = null; const g = (geo || []).find((r) => (r.countries || []).some((c) => { const ok = lc(c.country) === lc(country) && (c.via === "exact" || c.via === "region" || c.via === undefined); if (ok) hit = c; return ok; }));
      return g ? { region: g.region, share: g.share, exact: hit?.via === "exact" || (hit?.via === undefined && lc(g.region) === lc(country)) } : null; };
    const countries = (R.trademap?.countries || []).slice(0, 12).map((c, i) => ({ id: "C" + (i + 1), country: c.country, importance: c.importance, stance: c.stance, trajectory: c.trajectory, threat: c.threat, roles: (c.roles || []).join(", "),
      why: trim(c.why, 260), headline: trim(tradeBy[lc(c.country)]?.headline, 300), revenue: shareOf(c.country), ...tradeDossier(tradeBy[lc(c.country)], c.country),
      // The trade analyst's estimate of the industry's revenue there, for when no filing names the country.
      ind_est: isNum(c.revenue_share_estimate) ? c.revenue_share_estimate : null, ind_basis: trim(c.revenue_basis, 200) }));
    const rules = (run?.books || []).flatMap((b) => (b.book?.rules || []).map((r) => ({ body: b.body, ...r })))
      .sort((a, b) => (SEV[a.severity] ?? 3) - (SEV[b.severity] ?? 3) || (a.status === "in_force" ? -1 : 1)).slice(0, 10)
      .map((r, i) => ({ id: "R" + (i + 1), body: trim(r.body, 90), name: trim(r.name, 160), status: r.status, effective: trim(r.effective, 100), severity: r.severity, bottom_line: trim(r.bottom_line || r.industry_impact, 300),
        category: r.category || "", citation: trim(r.citation, 140), numeric: trim(r.numeric_value, 180), what: nc0(r.what_this_is, 300), impact: nc0(r.industry_impact, 340), last12: nc0(r.last_12_months, 200), today: nc0(r.today, 220), next12: nc0(r.next_12_months, 240) }));
    const k = R.kpi || {};
    const kpi = k.summary || k.cycle_position ? { cycle: k.cycle_position, cycle_text: trim(k.cycle_text, 300), pricing_power: k.pricing_power?.level, pricing_text: trim(k.pricing_power?.text, 300), who_has_it: trim(k.pricing_power?.who_has_it, 200),
      hot: (k.hot_segments || []).map((x) => x.name).slice(0, 6), cool: (k.cool_segments || []).map((x) => x.name).slice(0, 6) } : null;
    // KPIs (K#), customers and suppliers (P#), the dated calendar (E#), policy/litigation/deals (L#).
    const kpis = [...(k.demand_metrics || []).map((x) => ({ ...x, kind: "demand" })), ...(k.profitability_metrics || []).map((x) => ({ ...x, kind: "profitability" }))].slice(0, 10)
      .map((x, i) => ({ id: "K" + (i + 1), kind: x.kind, name: trim(x.name, 120), value: trim(x.value, 220), period: trim(x.period, 60), change: trim(x.change, 200), vs_cycle: trim(x.vs_cycle, 200) }));
    const chain = (R.chain?.partners || []).slice(0, 8).map((x, i) => ({ id: "P" + (i + 1), symbol: x.symbol, name: x.name, role: x.role, share: trim(x.share, 200), depends: x.depends || [], why: trim(x.why, 260) }));
    const today = now || run?.industry?.as_of || "";
    const evs = [...((run?.agent?.calendar?.events) || []).map((e) => ({ date: (e.dates || [])[0], title: e.title, detail: e.detail, importance: e.importance, kind: e.kind, tickers: e.tickers || [] })),
      ...(k.next_triggers || []).map((e) => ({ date: e.date, title: e.event, detail: e.why, kind: "industry", tickers: e.names || [] })),
      ...(R.macro?.watch_next || []).map((e) => ({ date: e.date, title: e.event, detail: e.why, kind: "macro", tickers: [] }))]
      .filter((e) => e.date && e.title).sort((a, b) => (a.date < b.date ? -1 : 1));
    const seenE = new Set(), calendar = [];
    for (const e of evs) { const d = e.date.slice(0, 10), key = d + "|" + lc(e.title).replace(/[^a-z0-9]/g, "").slice(0, 18);
      // The same company's report, listed twice (as an earnings date and as a trigger), counts once.
      if (seenE.has(key) || calendar.some((c) => c.date.slice(0, 10) === d && c.tickers.length && e.tickers.length && c.tickers[0] === e.tickers[0])) continue; seenE.add(key); calendar.push(e); }
    const cal = calendar.filter((e) => !today || e.date >= today.slice(0, 10)).slice(0, 60).map((e, i) => ({ id: "E" + (i + 1), date: String(e.date).slice(0, 10), title: trim(e.title, 160), detail: trim(e.detail, 240), importance: e.importance || "", kind: e.kind || "", tickers: e.tickers.slice(0, 8), source: "industry" }));
    const g = R.reg || {};
    const regItems = [...(g.policy || []).map((x) => ({ kind: "policy", title: x.title, status: x.status, date: x.date, direction: x.direction, text: x.impact, names: x.names })),
      ...(g.litigation || []).map((x) => ({ kind: "litigation", title: x.case, status: x.status, date: x.date || x.next_date, text: x.stakes || x.exposure || x.impact || x.summary, parties: x.parties, next: x.next, names: x.names })),
      ...(g.deals || []).map((x) => ({ kind: "deal", title: x.title, status: x.status, date: x.date, text: x.rationale || x.impact, value: x.value, names: x.names }))].filter((x) => x.title).slice(0, 16)
      .map((x, i) => ({ id: "L" + (i + 1), kind: x.kind, title: trim(x.title, 180), status: trim(x.status, 80), date: x.date ? String(x.date).slice(0, 10) : "", direction: x.direction || "", text: nc0(x.text, 360),
        parties: nc0(x.parties, 160), next: nc0(x.next, 160), value: trim(x.value, 40), names: (x.names || []).slice(0, 8) }));
    const RV = R.regverdict || {};
    const regv = RV.stance || RV.headline ? { stance: RV.stance || "", intensity: RV.intensity || "", headline: nc0(RV.headline, 300), summary: nc0(RV.summary, 500),
      most_material: (RV.most_material || []).slice(0, 5).map((x) => ({ body: x.body || "", rule: trim(x.rule, 140), why: nc0(x.why, 220) })),
      timeline: (RV.timeline || []).slice(0, 10).map((x) => ({ date: String(x.date || "").slice(0, 10), event: nc0(x.event, 180), body: x.body || "" })),
      winners: (RV.winners || []).slice(0, 6).map((x) => ({ symbol: x.symbol, why: nc0(x.why, 200) })), losers: (RV.losers || []).slice(0, 6).map((x) => ({ symbol: x.symbol, why: nc0(x.why, 200) })),
      watch: (RV.watch || []).slice(0, 5).map((w) => nc0(w, 200)), regulators: (g.regulators || []).slice(0, 8).map((x) => ({ name: trim(x.name, 90), jurisdiction: x.jurisdiction || "", why: nc0(x.why, 220) })),
      legal_summary: nc0(g.summary, 400), consolidation: nc0(g.consolidation, 260), perception: nc0(g.perception?.summary || g.perception, 260) } : null;
    const TV = R.trade?.verdict || {};
    const tradev = TV.rating || TV.headline ? { rating: TV.rating || "", health: TV.health?.score ?? null, band: TV.health?.band || "", headline: nc0(TV.headline, 320), map: nc0(R.trademap?.summary || R.trade?.map?.summary, 400) } : null;
    // The company's own product lines and regions (S#, G#), with what code could match to the industry's segments and trade map.
    const segments = (seg || []).map((x, i) => ({ id: "S" + (i + 1), segment: x.segment, share: x.share, yoy: x.yoy, match: x.match ? `${x.match.temp} segment "${x.match.name}"` : null }));
    const regions = (geo || []).map((g, i) => ({ id: "G" + (i + 1), region: g.region, share: g.share, yoy: g.yoy, kind: g.kind || "", note: g.note || "", countries: (g.countries || []).map((c) => c.country) }));
    const Ld = run?.lead || {};
    const iscen = Object.fromEntries(["bull", "base", "bear"].filter((k) => Ld.scenarios?.[k]).map((k) => { const x = Ld.scenarios[k]; return [k, { probability: x.probability, narrative: trim(x.narrative, 420), price_move: x.price_move || [], eps_change: x.eps_change || [], triggers: (x.triggers || []).slice(0, 3).map((t) => trim(t, 160)) }]; }));
    const debates = (Ld.debates || []).slice(0, 6).map((x, i) => ({ id: "D" + (i + 1), question: trim(x.question, 200), bull: trim(x.bull, 360), bear: trim(x.bear, 360), lean: x.lean || "", why: trim(x.why, 260), resolves_with: trim(x.resolves_with, 200) }));
    const dims = Object.fromEntries(Object.entries(Ld.dimensions || {}).map(([k, v]) => [k, { score: v?.score, summary: trim(v?.summary, 260) }]));
    const changeMind = (Ld.change_mind || []).slice(0, 5).map((x) => trim(x, 240));
    const plans = Object.fromEntries(Object.entries(Ld.plans || {}).map(([k, v]) => [k, { size: v?.size, entry: trim(v?.entry, 200), stop_pct: v?.stop_pct, review: trim(v?.review, 120) }]));
    const redteam = Ld.redteam ? { stance: Ld.redteam.stance, thesis: trim(Ld.redteam.thesis, 500), kill: (Ld.redteam.kill_criteria || []).slice(0, 4).map((x) => trim(typeof x === "string" ? x : x?.text || "", 200)), blind: (Ld.redteam.blind_spots || []).slice(0, 3).map((x) => trim(typeof x === "string" ? x : x?.text || "", 200)) } : null;
    const noIds = (t, k) => trim(String(t || "").replace(/\s*\[[A-Z]{1,2}\d{1,5}(?:,\s*[A-Z]{1,2}\d{1,5})*\]/g, "").replace(/\s+([.,;:])/g, "$1"), k);
    const threats = ((run?.agent?.calendar?.standing) || []).slice(0, 14).map((x, i) => ({ id: "Q" + (i + 1), section: x.section || "", kind: x.kind || "", title: trim(x.title, 180), status: noIds(x.status, 160), detail: noIds(x.detail, 360), importance: x.importance || "" }));
    const ihz = Object.fromEntries(["1M", "3M", "6M", "12M"].filter((h) => Ld.horizons?.[h]).map((h) => { const x = Ld.horizons[h], f = (Ld.horizon_facts || []).find((y) => y.h === h) || {};
      return [h, { call: x.call, conviction: x.conviction || "", expected_move: x.expected_move || [], probability_up: x.probability_up, drivers: noIds(x.drivers, 900), positioning: noIds(x.positioning, 300), risk: noIds(x.risk, 300), end: f.end || "", sigma: f.sigma ?? null, base_up: f.base_up ?? null,
        reporting: (f.reporting || []).slice(0, 8).map((r) => `${r.symbol} ${r.date}`), decisions: (x.decisions || []).slice(0, 8).map((d) => ({ date: d.date || "", event: noIds(d.event, 160), lean: d.lean || "", outcomes: noIds(d.outcomes, 320) })),
        conflicts: (x.conflicts || []).slice(0, 8).map((c) => ({ situation: noIds(c.situation, 160), in_window: noIds(c.in_window, 240), impact: noIds(c.impact, 280) })) }]; }));
    const M0 = R.macro || {}, ncm = (t, k) => trim(String(t || "").replace(/\s*\[[A-Z]{1,2}\d{1,5}(?:,\s*[A-Z]{1,2}\d{1,5})*\]/g, "").replace(/\s+([.,;:])/g, "$1"), k);
    const macroInd = M0.regime ? { regime: M0.regime, headline: ncm(M0.headline, 300), summary: ncm(M0.summary, 500),
      channels: Object.fromEntries(["demand", "cost", "capital", "regulatory"].filter((k) => M0.channels?.[k]?.text).map((k) => [k, ncm(M0.channels[k].text, 360)])),
      moves: (M0.moves || []).slice(0, 6).map((x) => ({ id: x.id, move: ncm(x.move, 200), driver: ncm(x.driver, 200), so_what: ncm(x.so_what, 200) })),
      flip: (M0.flip || []).slice(0, 4).map((f) => ({ trigger: ncm(f.trigger, 160), mechanism: ncm(f.mechanism, 200) })) } : null;
    return { macroInd, regv, tradev, indicators, situations, headlines, countries, rules, kpi, segments, regions, kpis, chain, calendar: cal, regItems, iscen, debates, dims, changeMind, plans, redteam, threats, ihz };
  }
  function lensBlock(L, sym, part = "context") {
    if (part === "calls") return `${lensBlock(L, sym, "core")}
Standing situations: wars, conflicts and threats (from every section of the industry analysis; cite by Q-ID):
${(L.threats || []).map((x) => `[${x.id}] ${x.title} (${x.section}${x.kind ? ", " + x.kind : ""}${x.importance ? ", " + x.importance + " importance" : ""}): ${x.status ? x.status + ". " : ""}${x.detail}`).join("\n") || "(none)"}
World situations (cite by W-ID): ${(L.situations || []).map((x) => `[${x.id}] ${x.title} (${x.stance}, ${x.status || ""})`).join("; ") || "(none)"}

THE INDUSTRY'S OWN 1M-12M CALLS (the lead strategist's cards; make each of ${sym}'s calls just as complete, about ${sym})
${Object.entries(L.ihz || {}).map(([h, x]) => `${h} (to ${x.end || "n/a"}; one sigma ±${x.sigma ?? "n/a"}%; base rate of a gain ${x.base_up ?? "n/a"}%): ${x.call}, ${x.conviction} conviction, ${(x.expected_move || []).join(" to ")}%, ${x.probability_up ?? "n/a"}% chance higher. ${x.drivers}
  Decisions and events: ${x.decisions.map((d) => `${d.date} ${d.event} (${d.lean}): ${d.outcomes}`).join(" | ") || "none"}
  Wars, conflicts and threats: ${x.conflicts.map((c) => `${c.situation}: ${c.in_window} -> ${c.impact}`).join(" | ") || "none"}
  What to do: ${x.positioning || "n/a"} Wrong if: ${x.risk || "n/a"}${x.reporting.length ? `\n  Reporting in the window: ${x.reporting.join(", ")}` : ""}`).join("\n") || "(none)"}`;
    if (part === "core") return `THE INDUSTRY REPORT'S ROWS FOR YOUR HALF (answer each for ${sym} by its ID)
Industry KPIs (the industry's figures; give ${sym}'s own):
${(L.kpis || []).map((x) => `[${x.id}] ${x.name} (${x.kind}; ${x.period || ""}): ${x.value}${x.change ? `; change: ${x.change}` : ""}${x.vs_cycle ? `; vs cycle: ${x.vs_cycle}` : ""}`).join("\n") || "(none)"}
Customers, channels and suppliers the industry depends on:
${(L.chain || []).map((x) => `[${x.id}] ${x.symbol || ""} ${x.name || ""} (${x.role || ""}): ${x.share || ""}. Depends on it: ${(x.depends || []).join(", ") || "n/a"}. ${x.why || ""}`).join("\n") || "(none)"}
Dated calendar for the next 12 months (the industry's events, ${sym}'s own reports and ex-dividend dates, its biggest peers' reports, macro releases; "est." = a projected date):
${(L.calendar || []).map((e) => `[${e.id}] ${e.date}${e.estimated ? " (est.)" : ""} [${e.source || "industry"}] ${e.title}${e.tickers.length ? ` (${e.tickers.join(", ")})` : ""}${e.detail ? `: ${e.detail}` : ""}`).join("\n") || "(none)"}
${L.kpi ? `KPIs and cycle: ${L.kpi.cycle || ""} — ${L.kpi.cycle_text || ""} Pricing power ${L.kpi.pricing_power || ""}: ${L.kpi.pricing_text || ""} (who has it: ${L.kpi.who_has_it || "n/a"}).` : ""}
The industry's dimension scores (-2 to +2): ${Object.entries(L.dims || {}).map(([k, v]) => `${k} ${v.score}: ${v.summary}`).join(" | ") || "n/a"}
The industry's trade plans (for the industry as a whole): ${Object.entries(L.plans || {}).map(([k, v]) => `${k}: size ${v.size}% of a portfolio, entry ${v.entry}, stop ${isNum(Number(v.stop_pct)) ? (v.stop_pct * 100).toFixed(1) + "%" : "n/a"}, review ${v.review}`).join(" | ") || "n/a"}
What would change the industry view: ${(L.changeMind || []).join(" | ") || "n/a"}
${L.redteam ? `The industry's red team (${L.redteam.stance}): ${L.redteam.thesis} Kill criteria: ${L.redteam.kill.join("; ")}` : ""}`;
    if (part === "exposures") return `THE INDUSTRY'S TRADE AND REGULATION REPORTS, ROW BY ROW (answer each for ${sym} by its ID)
${L.tradev ? `Trade verdict for the industry: ${L.tradev.rating} (health ${L.tradev.health ?? "n/a"}, ${L.tradev.band}). ${L.tradev.headline} Map: ${L.tradev.map}` : ""}
Trade countries (the industry's trade map and its country dossiers):
${L.countries.map((c) => `[${c.id}] ${c.country}: ${c.importance} importance, ${c.stance}${c.alliance ? ` (${c.alliance})` : ""}, ${c.trajectory}${c.threat && c.threat !== "none" ? `, ${c.threat} threat` : ""}; roles ${c.roles}.${isNum(c.ind_share) ? ` ${(c.ind_share * 100).toFixed(0)}% of industry revenue.` : ""} ${c.headline || c.why}${c.revenue ? ` ${sym}'s revenue in ${c.revenue.region}: ${(c.revenue.share * 100).toFixed(0)}%.` : ""}${c.relationship ? ` Relationship: ${c.relationship}` : ""}${c.risks?.length ? ` Risks: ${c.risks.map((r) => `${r.risk} (${r.type}; ${r.likelihood} likelihood, ${r.impact} impact, ${r.timing}): ${r.mechanism}`).join(" | ")}.` : ""}${c.security?.threat ? ` Security (${c.security.level}): ${c.security.threat}` : ""}${c.deps?.length ? ` Dependencies: ${c.deps.map((d) => `${d.input} (${d.criticality}; ${d.share}; replace in ${d.substitutability})`).join("; ")}.` : ""}${c.developments?.length ? ` Latest: ${c.developments.map((d) => `${d.date} ${d.text}`).join(" | ")}.` : ""}${c.freeze ? ` If trade froze: ${c.freeze}` : ""}${c.outlook ? ` Outlook: ${c.outlook}` : ""}${c.exposed?.length ? ` Most exposed: ${c.exposed.map((x) => `${x.symbol} (${x.channel}, ${x.severity}${x.symbol === sym ? `: ${x.mechanism}` : ""})`).join(", ")}.` : ""}${c.watch?.length ? ` Watch: ${c.watch.join("; ")}.` : ""}`).join("\n") || "(none)"}
${sym}'s regions (what the trade map, its risks and its countries mean for each):
${(L.regions || []).map((g) => `[${g.id}] ${g.region}: ${isNum(g.share) ? (g.share * 100).toFixed(0) + "% of revenue" : "share n/a"}${isNum(g.yoy) ? `, ${g.yoy >= 0 ? "+" : ""}${(g.yoy * 100).toFixed(0)}% y/y` : ""}${g.kind === "business" ? " (a business line FMP files as a region: say which segment it is and read it with the product lines)" : g.countries.length ? ` (${g.kind === "offmap" ? "not on the trade map; nearest countries on it" : g.kind === "world" ? "spread across other countries; the map's biggest non-US exposures" : g.kind === "region" ? "trade-map countries in this region" : "trade-map country"}: ${g.countries.join(", ")})` : ` (${g.note || "no trade-map country"}: use world events, macro and FX for it)`}`).join("\n") || "(not reported)"}
${L.regv ? `Regulatory verdict for the industry: ${L.regv.stance} (${L.regv.intensity} intensity). ${L.regv.headline} ${L.regv.summary}
Most material for the industry: ${L.regv.most_material.map((x) => `${x.body} ${x.rule}: ${x.why}`).join(" | ") || "n/a"}
Regulatory winners: ${L.regv.winners.map((x) => `${x.symbol} (${x.why})`).join("; ") || "n/a"}. Losers: ${L.regv.losers.map((x) => `${x.symbol} (${x.why})`).join("; ") || "n/a"}.
Regulatory timeline: ${L.regv.timeline.map((x) => `${x.date} ${x.body}: ${x.event}`).join(" | ") || "n/a"}
Regulators: ${L.regv.regulators.map((x) => `${x.name} (${x.jurisdiction}): ${x.why}`).join(" | ") || "n/a"}
Legal climate: ${L.regv.legal_summary} Consolidation: ${L.regv.consolidation} Perception: ${L.regv.perception}
Regulatory watch list: ${L.regv.watch.join("; ") || "n/a"}` : ""}
Rules (the regulatory rule books, in full):
${L.rules.map((r) => `[${r.id}] ${r.body} — ${r.name} (${r.category ? r.category + ", " : ""}${r.status}${r.effective ? ", " + r.effective : ""}; ${r.severity} severity${r.citation ? `; ${r.citation}` : ""}): ${r.what || ""}${r.numeric ? ` Numbers: ${r.numeric}.` : ""} For the industry: ${r.impact || r.bottom_line}${r.last12 ? ` Last 12 months: ${r.last12}` : ""}${r.today ? ` Today: ${r.today}` : ""}${r.next12 ? ` Next 12 months: ${r.next12}` : ""} Bottom line: ${r.bottom_line}`).join("\n") || "(none)"}
Policy, litigation and deals (the industry's regulation and legal report):
${(L.regItems || []).map((x) => `[${x.id}] ${x.kind}: ${x.title} (${x.status || ""}${x.date ? ", " + x.date : ""}${x.direction ? ", " + x.direction : ""}${x.value ? ", " + x.value : ""})${x.parties ? ` Parties: ${x.parties}.` : ""} ${x.text || ""}${x.next ? ` Next: ${x.next}` : ""}${x.names?.length ? ` Names: ${x.names.join(", ")}.` : ""}`).join("\n") || "(none)"}`;
    const v = (r) => (r.value === null || r.value === undefined ? "n/a" : `${r.value}${r.unit && r.unit !== "index" ? r.unit : ""}`);
    return `THE INDUSTRY REPORT'S ROWS (answer each for ${sym} by its ID)
${L.macroInd ? `The industry's macro call: ${L.macroInd.regime}. ${L.macroInd.headline} ${L.macroInd.summary}
How macro reaches the industry: ${Object.entries(L.macroInd.channels).map(([k, v]) => `${k}: ${v}`).join(" | ") || "n/a"}
What's moving and why: ${L.macroInd.moves.map((m) => `[${m.id}] ${m.move} Driver: ${m.driver} So what: ${m.so_what}`).join(" | ") || "n/a"}
What would flip the industry's call: ${L.macroInd.flip.map((f) => `${f.trigger} (${f.mechanism})`).join(" | ") || "n/a"}
` : ""}Macro indicators (latest; prior; the industry's read):
${L.indicators.map((r) => `[${r.id}] ${r.label} (${r.group || ""}): ${v(r)}${r.prior !== undefined && r.prior !== null ? `, ${r.prior_label || "prior"} ${r.prior}` : ""} · industry: ${r.ind ? `${r.ind.relevance} relevance, ${r.ind.effect} — ${r.ind.why}` : "no read"}`).join("\n") || "(none)"}
World situations (the industry's world-events report: deep dives in full, then the other situations it is tracking):
${L.situations.map((x) => `[${x.id}] ${x.title} (${x.deep ? "deep dive" : "tracked"}; ${x.category}; ${x.stance} for the industry; ${x.status || ""}; ${x.region || ""}${x.since ? `; since ${x.since}` : ""}${x.actors?.length ? `; actors ${x.actors.join(", ")}` : ""}): ${x.summary}${x.now ? ` Now: ${x.now}` : ""}${x.why_now ? ` Why now: ${x.why_now}` : ""}${x.trigger ? ` Trigger: ${x.trigger}` : ""}${x.first_order ? ` First-order: ${x.first_order}` : ""}${x.channels?.length ? ` Channels: ${x.channels.join("; ")}.` : ""}${x.developments?.length ? ` Latest: ${x.developments.map((d) => `${d.date} ${d.text}`).join(" | ")}.` : ""}${x.scenarios?.length ? ` Scenarios: ${x.scenarios.map((c) => `${c.name} ${c.probability}% (${c.trigger}) -> ${c.outcome}`).join(" | ")}.` : ""}${x.near_term ? ` Near term: ${x.near_term}` : ""}${x.offsets?.length ? ` Offsets: ${x.offsets.join("; ")}.` : ""}${x.watch?.length ? ` Watch: ${x.watch.map((w) => `${w.indicator} (${w.signal})`).join("; ")}.` : ""}${x.exposure ? ` Exposure: ${x.exposure}.` : ""}${x.winners.length ? ` Winners: ${x.winners.join(", ")}.` : ""}${x.losers.length ? ` Losers: ${x.losers.join(", ")}.` : ""}${x.headlines?.length ? ` Headlines: ${x.headlines.join(", ")}.` : ""}`).join("\n") || "(none)"}
World headlines behind them (cite by H-ID):
${(L.headlines || []).map((h) => `[${h.id}] ${h.date} ${h.source}: ${h.title}${h.summary ? `. ${h.summary}` : ""}`).join("\n") || "(none)"}
${sym}'s product lines (say which of the industry's segments each belongs to, hot or cool, or what its own trend is if none fits):
${(L.segments || []).map((x) => `[${x.id}] ${x.segment}: ${isNum(x.share) ? (x.share * 100).toFixed(0) + "% of revenue" : "share n/a"}${isNum(x.yoy) ? `, ${x.yoy >= 0 ? "+" : ""}${(x.yoy * 100).toFixed(0)}% y/y` : ""}${x.match ? ` (code matched it to the ${x.match})` : " (no matching industry segment)"}`).join("\n") || "(not reported)"}
${L.kpi ? `Hot segments: ${L.kpi.hot.join(", ") || "n/a"}. Cool: ${L.kpi.cool.join(", ") || "n/a"}.` : ""}
The industry's scenarios (12 months; its probability and the industry's price move):
${Object.entries(L.iscen || {}).map(([k, x]) => `${k} (${x.probability}%, industry ${(x.price_move || []).join(" to ")}%): ${x.narrative}${x.triggers?.length ? ` Triggers: ${x.triggers.join("; ")}` : ""}`).join("\n") || "(none)"}
The industry's key debates (answer each by its ID: which side this company falls on):
${(L.debates || []).map((d) => `[${d.id}] ${d.question} BULL: ${d.bull} BEAR: ${d.bear} The industry leans ${d.lean || "n/a"}: ${d.why}${d.resolves_with ? ` Resolves with: ${d.resolves_with}` : ""}`).join("\n") || "(none)"}`;
  }
  /**
   * The calendar for the next 12 months: the industry's dated events, plus the company's own (projected earnings and
   * ex-dividend dates), its biggest peers' reports through the year, and the macro releases ahead. Everything in the
   * next 45 days stays; after that, the most important few each month. IDs E1... in date order.
   * extra: [{date, title, detail, importance, kind, tickers, source: company|peer|macro|industry, estimated}].
   */
  function calendarYear(industryCal, extra, today, { horizonDays = 366, nearDays = 45, perMonth = 7 } = {}) {
    const day = String(today).slice(0, 10), end = addD(day, horizonDays), near = addD(day, nearDays), RANK = { high: 0, medium: 1, low: 2 };
    const SRC = { company: 0, peer: 1, industry: 2, macro: 3 };
    const all = [...(industryCal || []), ...(extra || [])].filter((e) => e?.date && e.title && e.date.slice(0, 10) >= day && e.date.slice(0, 10) <= end).map((e) => ({ ...e, date: String(e.date).slice(0, 10) }));
    const seen = new Set(), dedup = [];
    for (const e of all.sort((a, b) => (SRC[a.source] ?? 2) - (SRC[b.source] ?? 2))) {
      const k = e.date.slice(0, 7) + "|" + (e.tickers?.[0] && /earnings|reports?|results/i.test(e.title) ? "earn:" + e.tickers[0] : lc(e.title).replace(/[^a-z0-9]/g, "").slice(0, 24));
      if (seen.has(k)) continue; seen.add(k); dedup.push(e); }
    const score = (e) => (SRC[e.source] ?? 2) * 10 + (RANK[e.importance] ?? 2) * 3 + (e.estimated ? 1 : 0);
    const keep = dedup.filter((e) => e.date <= near);
    const byMonth = {}; for (const e of dedup.filter((e) => e.date > near)) (byMonth[e.date.slice(0, 7)] ||= []).push(e);
    for (const list of Object.values(byMonth)) keep.push(...list.sort((a, b) => score(a) - score(b)).slice(0, perMonth));
    return keep.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (SRC[a.source] ?? 2) - (SRC[b.source] ?? 2))).slice(0, 90)
      .map((e, i) => ({ id: "E" + (i + 1), date: e.date, title: trim(e.title, 160), detail: trim(e.detail, 240), importance: e.importance || "", kind: e.kind || "", tickers: (e.tickers || []).slice(0, 8), source: e.source || "industry", estimated: !!e.estimated }));
  }
  function addD(d, k) { const t = new Date(String(d).slice(0, 10) + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + k); return t.toISOString().slice(0, 10); }

  const LINKS = ["direct", "partner", "customer", "supplier", "competitor", "precedent", "read-across", "macro", "sentiment"];
  /** The company's row-by-row answers, kept only for rows that exist. */
  function cleanLens(raw, L, idx) {
    if (!raw || typeof raw !== "object" || !L) return null;
    const ok = (id) => !!idx?.[id];
    const txt = (s, k = 500) => keepT(String(s ?? "").replace(/\[([A-Z]{1,2}\d{1,4}(?:,\s*[A-Z]{1,2}\d{1,4})*)\]/g, (m, g) => { const keep = g.split(/,\s*/).filter(ok); return keep.length ? `[${keep.join(", ")}]` : ""; }).replace(/\s+([.,;:])/g, "$1"), k);
    const ev = (a) => (Array.isArray(a) ? a.map(String).filter(ok).slice(0, 6) : []);
    const en = (v, list, d) => (list.includes(lc(v)) ? lc(v) : d);
    const rows = (arr, ids, f) => { const m = {}; for (const x of Array.isArray(arr) ? arr : []) { const id = String(x?.id || "").toUpperCase(); if (ids.has(id) && !m[id]) m[id] = f(x); } return m; };
    const VS = ["more", "less", "same", "opposite"];
    const M = raw.macro || {};
    return {
      macro: { regime: en(M.regime, ["supportive", "mixed", "headwind"], ""), headline: txt(M.headline, 400), flip: txt(M.flip, 400),
        channels: Object.fromEntries(["demand", "cost", "capital", "regulatory"].filter((k) => M.channels?.[k]).map((k) => [k, txt(M.channels[k], 500)])),
        horizons: Object.fromEntries(HZ.filter((h) => M.horizons?.[h]).map((h) => [h, { call: en(M.horizons[h].call, ["supportive", "mixed", "headwind"], "mixed"), why: txt(M.horizons[h].why, 400) }])),
        indicators: rows(M.indicators, new Set(L.indicators.map((r) => r.id)), (x) => ({ relevance: en(x.relevance, ["high", "medium", "low"], ""), effect: en(x.effect, ["tailwind", "headwind", "neutral"], "neutral"), vs_industry: en(x.vs_industry, VS, ""), why: txt(x.why, 360) })) },
      world: rows(raw.world, new Set(L.situations.map((r) => r.id)), (x) => ({ effect: en(x.effect, ["helps", "hurts", "mixed", "none"], "mixed"), magnitude: en(x.magnitude, ["high", "medium", "low"], ""), vs_industry: en(x.vs_industry, VS, ""), channel: txt(x.channel, 300), scenario: txt(x.scenario, 400), watch: txt(x.watch, 200), why: txt(x.why, 500), evidence: ev(x.evidence) })),
      trade: rows(raw.trade, new Set(L.countries.map((r) => r.id)), (x) => ({ exposure: en(x.exposure, ["high", "medium", "low", "none"], ""), effect: en(x.effect, ["helps", "hurts", "mixed", "none"], "mixed"), channel: txt(x.channel, 300), risk: txt(x.risk, 300), freeze: txt(x.freeze, 360), why: txt(x.why, 500), evidence: ev(x.evidence) })),
      regulation: rows(raw.regulation, new Set(L.rules.map((r) => r.id)), (x) => ({ effect: en(x.effect, ["helps", "hurts", "mixed", "none"], "mixed"), materiality: en(x.materiality, ["high", "medium", "low"], ""), link: en(x.link, LINKS, ""), cost: txt(x.cost, 240), timing: txt(x.timing, 120), why: txt(x.why, 500), evidence: ev(x.evidence) })),
      reg_items: rows(raw.reg_items, new Set((L.regItems || []).map((r) => r.id)), (x) => ({ effect: en(x.effect, ["helps", "hurts", "mixed", "none"], "mixed"), materiality: en(x.materiality, ["high", "medium", "low"], ""), link: en(x.link, LINKS, ""), cost: txt(x.cost, 240), next: txt(x.next, 160), why: txt(x.why, 400) })),
      trade_overall: raw.trade_overall && typeof raw.trade_overall === "object" ? { risk: en(raw.trade_overall.risk, ["low", "moderate", "high"], ""), summary: txt(raw.trade_overall.summary, 900), biggest: txt(raw.trade_overall.biggest, 400), watch: (Array.isArray(raw.trade_overall.watch) ? raw.trade_overall.watch : []).slice(0, 5).map((w) => txt(w, 200)).filter(Boolean) } : null,
      reg_overall: raw.reg_overall && typeof raw.reg_overall === "object" ? { stance: en(raw.reg_overall.stance, ["tailwind", "headwind", "mixed"], ""), vs_peers: en(raw.reg_overall.vs_peers, ["winner", "loser", "neutral"], ""), summary: txt(raw.reg_overall.summary, 900), biggest: txt(raw.reg_overall.biggest, 400),
        timeline: (Array.isArray(raw.reg_overall.timeline) ? raw.reg_overall.timeline : []).slice(0, 8).map((x) => ({ date: String(x?.date || "").slice(0, 10), event: txt(x?.event, 240), why: txt(x?.why, 300) })).filter((x) => x.event), watch: (Array.isArray(raw.reg_overall.watch) ? raw.reg_overall.watch : []).slice(0, 5).map((w) => txt(w, 200)).filter(Boolean) } : null,
      kpis: rows(raw.kpis, new Set((L.kpis || []).map((r) => r.id)), (x) => ({ value: txt(x.value, 200), vs: en(x.vs, ["better", "in line", "worse"], ""), why: txt(x.why, 400) })),
      chain: rows(raw.chain, new Set((L.chain || []).map((r) => r.id)), (x) => ({ dependence: en(x.dependence, ["high", "medium", "low", "none"], ""), why: txt(x.why, 400) })),
      calendar: rows(raw.calendar, new Set((L.calendar || []).map((r) => r.id)), (x) => ({ impact: en(x.impact, ["high", "medium", "low", "none"], ""), direction: en(x.direction, ["upside", "downside", "two-way"], ""), link: en(x.link, LINKS, ""), why: txt(x.why, 400) })),
      segments: rows(raw.segments, new Set((L.segments || []).map((r) => r.id)), (x) => ({ temp: en(x.temp, ["hot", "cool", "neutral"], "neutral"), industry_segment: txt(x.industry_segment, 120), why: txt(x.why, 500) })),
      regions: rows(raw.regions, new Set((L.regions || []).map((r) => r.id)), (x) => ({ outlook: en(x.outlook, ["tailwind", "headwind", "neutral"], "neutral"), drivers: txt(x.drivers, 400), risks: txt(x.risks, 300), watch: txt(x.watch, 200), why: txt(x.why, 500) })),
      ind_scenarios: Object.fromEntries(["bull", "base", "bear"].filter((k) => raw.ind_scenarios?.[k] && L.iscen?.[k]).map((k) => { const x = raw.ind_scenarios[k]; const mv = Array.isArray(x.move) ? x.move.map(Number).filter(isNum).slice(0, 2).sort((a, b) => a - b) : []; return [k, { move: mv, why: txt(x.why, 500) }]; })),
      debates: rows(raw.debates, new Set((L.debates || []).map((r) => r.id)), (x) => ({ side: en(x.side, ["bull", "bear", "split"], "split"), why: txt(x.why, 500), evidence: ev(x.evidence) })),
      dimensions: Object.fromEntries(Object.keys(L.dims || {}).filter((k) => raw.dimensions?.[k]).map((k) => { const sc = Number(raw.dimensions[k].score); return [k, { score: isNum(sc) ? Math.max(-2, Math.min(2, Math.round(sc))) : null, why: txt(raw.dimensions[k].why, 400) }]; })),
      plans: Object.fromEntries(["income", "conservative", "growth", "aggressive"].filter((k) => raw.plans?.[k]).map((k) => { const x = raw.plans[k]; return [k, { size_pct: isNum(Number(x.size_pct)) ? Number(x.size_pct) : null, entry: txt(x.entry, 300), stop: isNum(Number(x.stop)) && Number(x.stop) > 0 ? Number(x.stop) : null, hedge: txt(x.hedge, 300), review: txt(x.review, 200) }]; })),
      change_mind: (Array.isArray(raw.change_mind) ? raw.change_mind : []).slice(0, 6).map((x) => txt(x, 300)).filter(Boolean),
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
  /** What a company call can be driven by (labels for the "Driven by" line). */
  const SECS = [["kpi", "KPIs & cycle"], ["macro", "Macro backdrop"], ["world", "World events"], ["trade", "Trade & supply chain"], ["regulation", "Regulation & legal"], ["fundamentals", "Earnings, margins & balance sheet"],
    ["valuation", "Valuation & multiple"], ["performance", "Price action, momentum & risk"], ["sentiment", "Sentiment & news"], ["consensus", "Sell-side consensus"], ["company", "Company-specific events"], ["industry", "The industry's own call"]];
  const SEC_KEYS = SECS.map(([k]) => k);
  /**
   * Every panel on the company page gets a written read: what its numbers say about the company, set against the
   * industry report's own read of the same thing. The two halves of the write-up each take a share.
   */
  const READS = {
    calls: { plan: "the trade plans, against the industry's plans", kpi: "the company's KPIs against the industry's", chain: "its customers and suppliers against the industry's chain", cal: "the dated events ahead", scen: "the industry's scenarios and debates as they apply here" },
    core: { scores: "the scorecard and pillar scores, against the industry's ranking", street: "Wall Street's view (ratings, targets, revisions) against the industry's", val: "valuation (P/E band, DCF, what's priced in) against the industry's valuation read", fund: "growth, margins and returns (statements, DuPont) against the industry's fundamentals read", health: "balance sheet and cash (debt, cover, Altman, Piotroski) against the industry's health read and its weak balance sheets", earn: "earnings record, surprises, revisions and price reactions against the industry's earnings read", div: "the dividend (yield, growth, streak, safety) against what the industry's income investors get" },
    context: { perf: "returns vs SPY, the sector ETF and the industry against the industry's performance read", risk: "beta, alpha, volatility, drawdowns, capture and factor sensitivities against the industry's risk read", stress: "how it held up in past crises against the industry's drawdown history", tech: "trend, momentum and levels (moving averages, RSI, MACD, pattern match) against the industry index", own: "who owns it, institutions, insiders and short interest against the industry's positioning", news: "news flow and sentiment against the industry's", track: "the record of earlier calls on this company", calls: "the latest earnings call against the industry's calls report", land: "where it sits in the industry (ranking, concentration, closest rivals)", peers: "its numbers against the industry's top 50", macro: "the macro backdrop for this company", world: "world events for this company", trade: "trade relations for this company", reg: "rules, policy, litigation and deals for this company", biz: "the business: segments, regions, moat and management", drivers: "the industry's drivers and the company's risks and catalysts" },
  };
  const READ_KEY = { core: "reads", context: "reads_more", calls: "reads_calls" };
  const readsField = (part) => `"${READ_KEY[part]}": {${Object.entries(READS[part]).map(([k, v]) => `"${k}": "2-3 sentences on ${v}: what the numbers say about this company, more or less than the industry and why, and what it means for the call (cite; use the figures)"`).join(", ")}}`;
  /** The JSON the thesis asks for: the whole of it, or one of its two halves (written in parallel). */
  const FIELDS = {
    headline: `"headline": "one short sentence, at most 30 words"`, verdict: `"verdict": {"call": "yes | conditional | no", "summary": "2-3 sentences: is this a real opportunity now, and in what form"}`,
    thesis: `"thesis": "3 paragraphs: the case, what makes it different from its peers, what the price already assumes"`,
    vs_industry: `"vs_industry": {"call": "outperform | in line | underperform", "why": "2-3 sentences"}`,
    drivers: `"drivers": [{"driver": "the industry driver", "industry_view": "one sentence", "effect": "stronger | weaker | same | opposite", "why": "2 sentences on this company", "evidence": []}]`,
    exposures: `"exposures": {"world": [{"situation": "...", "effect": "helps | hurts | mixed", "magnitude": "...", "why": "...", "evidence": []}], "trade": [{"country": "...", "dependence": "...", "risk": "...", "evidence": []}], "regulation": [{"rule": "...", "effect": "helps | hurts | mixed", "why": "...", "evidence": []}], "macro": [{"factor": "...", "sensitivity": "high | medium | low", "why": "..."}]}`,
    moat: `"moat": {"rating": "wide | narrow | none", "sources": ["..."], "threats": ["..."]}`,
    management: `"management": "2-3 sentences: execution, guidance record, capital allocation (cite)"`,
    quality: `"quality": "2 sentences on earnings quality and the balance sheet"`,
    valuation: `"valuation": {"read": "2-3 sentences vs history, peers and what is priced in", "fair_value": [low, high]}`,
    scenarios: `"scenarios": {"bull": {"probability": 25, "narrative": "...", "eps_change": [8, 14], "pe": [24, 27], "price_target": [100, 110]}, "base": {...}, "bear": {...}}`,
    horizons: `"horizons": {${["1M", "3M", "6M", "12M"].map((h) => `"${h}": {${Calls.schema}, "expected_move": [-3, 5], "probability_up": 58, "vs_industry": "outperform | in line | underperform", "drivers": "5-8 sentences, cited, with numbers: what drives the stock in this window, which dated prints and decisions land in it and what each is worth to the stock, the macro channel that measurably moves it (its own factor sensitivities), positioning and technicals, and how the pieces net out against its one-sigma move", "decisions": [{"refs": ["E1"], "date": "YYYY-MM-DD", "event": "the decision or event", "lean": "positive | negative | binary | neutral", "outcomes": "if X, the stock moves about +a% (why); if Y, about -b%"}], "conflicts": [{"refs": ["Q1"], "situation": "the war, conflict or threat", "in_window": "what is likely inside this window, with probabilities", "impact": "what it does to this company: revenue, costs, the multiple, with sizes"}], "positioning": "what to do with the stock in this window: buy, add, hold, trim or avoid, with price levels and sizing", "risk": "wrong if: the combination of outcomes that breaks this call and where the stock would go", "sections": ["the 2-5 drivers of this call, from: ${SEC_KEYS.join(", ")}"]}`).join(", ")}}`,
    risks: `"risks": [{"risk": "...", "likelihood": "high | medium | low", "impact": "high | medium | low", "evidence": []}]`,
    catalysts: `"catalysts": [{"date": "YYYY-MM-DD or YYYY-MM", "event": "...", "why": "..."}]`,
    watch: `"watch": ["..."]`, fit: `"fit": {"income": {"fit": "strong | good | weak | poor", "conviction": "high | medium | low", "why": "2-3 sentences for this investor, cited: what they get and what they give up", "watch": "the one or two numbers this investor should track", "what_changes": "what would raise or lower the fit"}, "conservative": {...}, "growth": {...}, "aggressive": {...}}`,
    street: `"street": {"stance": "agree | more bullish | more bearish", "summary": "2-3 sentences: where you land versus the Wall Street consensus (rating, target, estimates) and why, cited", "our_target": 0, "eps_view": {"fy1": "above | in line | below", "fy2": "above | in line | below", "why": "one or two sentences"}, "differences": [{"topic": "e.g. FY2027 EPS, margins, the multiple, a catalyst, a risk", "street": "what the consensus assumes", "ours": "what you assume", "why": "one or two sentences, cited"}]}`,
    confidence: `"confidence": "high | medium | low"`,
    reads: readsField("core"), reads_more: readsField("context"), reads_calls: readsField("calls"),
    lens: `"macro": {"regime": "supportive | mixed | headwind (for this company)", "headline": "one sentence on the macro for this company", "horizons": {"1M": {"call": "supportive | mixed | headwind", "why": "1-2 sentences"}, "3M": {...}, "6M": {...}, "12M": {...}},
   "channels": {"demand": "1-2 sentences: how the macro reaches this company's demand, against the industry's channel", "cost": "...", "capital": "financing, rates and the multiple", "regulatory": "..."}, "flip": "what would flip the macro call for this company, with levels",
   "indicators": [{"id": "I1", "relevance": "high | medium | low", "effect": "tailwind | headwind | neutral", "vs_industry": "more | less | same | opposite", "why": "one sentence on this company"}]},
 "world": [{"id": "W1", "effect": "helps | hurts | mixed | none", "magnitude": "high | medium | low", "vs_industry": "more | less | same | opposite", "channel": "how it reaches this company: demand, costs, supply, FX, financing or the multiple, with a size", "scenario": "which of the situation's scenarios matters most for this company and what it would do to it (estimate)", "watch": "the one indicator or date to watch for this company", "why": "1-2 sentences on this company, citing W- and H-IDs", "evidence": []}],
 "segments": [{"id": "S1", "temp": "hot | cool | neutral", "industry_segment": "the industry segment it belongs to, or a short name for its own", "why": "one or two sentences: its trend and what drives it, cited"}],
 "ind_scenarios": {"bull": {"move": [-5, 5], "why": "one or two sentences: this company's 12-month price move if the industry's bull case plays out, and why it moves more or less than the industry"}, "base": {...}, "bear": {...}},
 "debates": [{"id": "D1", "side": "bull | bear | split", "why": "one or two sentences: which side of the industry's debate this company falls on, and why, cited"}]`,
    lens_exp: `"trade_overall": {"risk": "low | moderate | high", "summary": "3-4 sentences: what the industry's trade map means for this company overall, where its revenue, supply and costs sit on it, more or less than the industry and why, cited", "biggest": "the single country or risk that matters most for this company and why", "watch": ["2-4 things to watch, with levels or dates"]},
 "trade": [{"id": "C1", "exposure": "high | medium | low | none", "effect": "helps | hurts | mixed | none", "channel": "how it reaches this company: revenue, supply, costs, FX or financing, with a size", "risk": "the risk there that matters most for this company, with likelihood and timing", "freeze": "what a 90-day freeze in trade with this country would do to this company (estimate)", "why": "1-2 sentences, cited", "evidence": []}],
 "regions": [{"id": "G1", "outlook": "tailwind | headwind | neutral", "drivers": "what moves this region for the company: the trade-map countries, their risks, FX, demand and prices, with numbers", "risks": "the main risk to this region's revenue, with likelihood", "watch": "the one thing to watch", "why": "one or two sentences: the bottom line for this region, cited"}],
 "reg_overall": {"stance": "tailwind | headwind | mixed", "vs_peers": "winner | loser | neutral", "summary": "3-4 sentences: the net regulatory and legal picture for this company against the industry's verdict and its named winners and losers, cited", "biggest": "the single most material rule or case for this company, with a size", "timeline": [{"date": "YYYY-MM-DD or YYYY-MM", "event": "a dated regulatory or legal step that matters for this company", "why": "one sentence"}], "watch": ["2-4 things to watch"]},
 "regulation": [{"id": "R1", "effect": "helps | hurts | mixed", "materiality": "high | medium | low", "link": "direct | partner | customer | supplier | competitor | precedent | read-across | sentiment", "cost": "the size of the effect on this company (estimate: $, % of revenue or EPS, or capital)", "timing": "when it bites", "why": "1-2 sentences, cited", "evidence": []}],
 "reg_items": [{"id": "L1", "effect": "helps | hurts | mixed", "materiality": "high | medium | low", "link": "direct | partner | customer | supplier | competitor | precedent | read-across | sentiment", "cost": "the size for this company, if any (estimate)", "next": "the next date or step that matters", "why": "one or two sentences"}]`,
    lens_core: `"kpis": [{"id": "K1", "value": "this company's own figure or read for that KPI (say if not disclosed)", "vs": "better | in line | worse", "why": "one sentence, cited"}],
 "chain": [{"id": "P1", "dependence": "high | medium | low | none", "why": "one sentence: how much this company relies on it and what that means"}],
 "calendar": [{"id": "E1", "impact": "high | medium | low", "direction": "upside | downside | two-way", "link": "direct | partner | competitor | read-across | macro", "why": "one sentence: how it reaches this company and what it means (never 'no read-across': if the link is weak, say what it is and mark it low)"}],
 "cycle": {"position": "where this company is in the industry's cycle", "pricing_power": "stronger | weaker | same (vs the industry)", "why": "2 sentences"},
 "dimensions": {"macro": {"score": 0, "why": "one sentence: this company's score from -2 to +2 on the same dimension as the industry's, and why it differs"}, "news": {...}, "world_events": {...}, "regulatory": {...}, "perception": {...}, "mna": {...}, "legal": {...}},
 "plans": {"income": {"size_pct": 0, "entry": "price or condition to buy", "stop": 0, "hedge": "how to hedge, if at all", "review": "when to revisit"}, "conservative": {...}, "growth": {...}, "aggressive": {...}},
 "change_mind": ["what would change this company's call, with a level or a date"]`,
  };
  const PART = {
    core: ["headline", "verdict", "thesis", "vs_industry", "valuation", "street", "moat", "management", "quality", "risks", "catalysts", "watch", "fit", "reads", "confidence"],
    calls: ["scenarios", "lens_core", "reads_calls"],
    context: ["drivers", "lens", "reads_more"],
    exposures: ["lens_exp"],
  };
  /**
   * Each part gets only the industry material it writes from (the same material as before, minus what it doesn't use):
   * the industry's panel reads for its own panels, and the parts of the industry digest its fields draw on.
   */
  const PANELS_FOR = {
    core: ["scores", "street", "val", "fund", "health", "earn", "div", "land", "plan", "peers"],
    calls: ["plan", "val", "earn", "risk", "street"],
    context: ["perf", "risk", "stress", "tech", "own", "news", "track", "calls", "land", "peers"],
    exposures: [],
  };
  const DIG_FOR = {
    core: [["lead", "Lead strategist", 600, 8], ["kpi", "KPIs and cycle", 300, 6], ["macro", "Macro", 300, 6], ["world", "World events", 220, 5], ["trade", "Trade and supply chain", 200, 5], ["regverdict", "Regulation", 300, 6]],
    calls: [["lead", "Lead strategist", 600, 8], ["kpi", "KPIs and cycle", 300, 6]],
    context: [["lead", "Lead strategist", 600, 8], ["kpi", "KPIs and cycle", 300, 6], ["macro", "Macro", 300, 6], ["world", "World events", 300, 6]],
    exposures: [],
  };
  const LEAD_FOR = {
    core: null,
    calls: ["headline", "thesis", "debates", "priced_in", "opportunity", "scenarios", "catalysts", "outlook", "latest_update"],
    context: ["headline", "thesis", "drivers", "debates", "risks", "watch", "outlook", "latest_update"],
  };
  const leadFor = (L, part) => (!L || !LEAD_FOR[part] ? L : Object.fromEntries(LEAD_FOR[part].filter((k) => L[k] !== undefined && L[k] !== null).map((k) => [k, L[k]])));
  function panelsFor(text, part) {
    const keep = new Set(PANELS_FOR[part] || []);
    let on = false; // a panel's text can run over several lines: continuation lines follow their panel
    return String(text || "").split("\n").filter((ln) => { const m = /^\[([a-z]+)\] /.exec(ln); if (m) on = keep.has(m[1]); return on; }).join("\n");
  }
  function schemaFor(part) {
    const keys = PART[part] || Object.keys(FIELDS).filter((k) => !["lens", "lens_core", "lens_exp", "reads", "reads_more", "reads_calls"].includes(k));
    const intro = part === "core" ? "This is part one of a four-part write-up; colleagues write the scenarios and the 1M-12M calls, and go through the industry report row by row, at the same time. Write ONLY the fields below: the verdict, the thesis, the street view, fit and the panel reads.\n"
      : part === "calls" ? "This is part two of a four-part write-up: the 12-month scenarios, plus the KPI, chain, calendar, plan and dimension rows for your half of THE INDUSTRY REPORT'S ROWS (a colleague makes the 1M-12M calls at the same time). Write ONLY the fields below.\n"
      : part === "exposures" ? "This is part four of a four-part write-up: trade and regulation. Colleagues write the verdict, thesis, calls and the rest of the rows at the same time. Write ONLY the fields below: take the industry's trade and regulation reports row by row (THE INDUSTRY'S TRADE AND REGULATION REPORTS) and say what each means for this company specifically, with sizes, more or less than for the industry and why, using its regions, segments, plants, customers, filings and numbers.\n"
      : part === "context" ? "This is part three of a four-part write-up; colleagues write the verdict, thesis, scenarios, 1M-12M calls, risks and catalysts at the same time. Write ONLY the fields below: take the industry report's rows (THE INDUSTRY REPORT'S ROWS) one by one and say what each means for this company specifically, more or less than for the industry and why, using its business mix, regions and numbers.\n" : "";
    const sizes = part === "exposures" ? "\nSizes: one entry for EVERY trade country, region, rule and policy/litigation/deal ID listed; 2-6 timeline steps; keep each why to one or two sentences and give sizes where the data allows (say estimate)." : part === "core" ? "\nSizes: 4-7 risks, 3-6 catalysts, 3-5 watch items, 3-5 street differences; our_target is your probability-weighted 12-month price; a read for EVERY panel in reads, each set against THE INDUSTRY'S READ, PANEL BY PANEL."
      : part === "calls" ? "\nSizes: one entry for EVERY KPI, chain partner and calendar ID listed (one sentence each); plans use the price levels given (stops are prices); 3-5 change_mind triggers; a read for EVERY panel in reads_calls." : part === "context" ? "\nSizes: 5-8 drivers; one entry for EVERY macro indicator, world situation (deep dives and tracked ones) and product line ID listed (keep each why to one or two sentences); a read for EVERY panel in reads_more, each set against THE INDUSTRY'S READ, PANEL BY PANEL." : "\nSizes: 5-8 drivers, 2-6 entries in each exposure list (empty if none), 4-7 risks, 3-6 catalysts, 3-5 watch items.";
    return `${intro}Reply with ONLY this JSON:\n{${keys.map((k) => FIELDS[k]).join(",\n ")}}${sizes}`;
  }
  /** The company's own data, as the write-up and the outlook show it. */
  function companyBlock(ctx) {
    const pc = (x, d = 1) => (isNum(x) ? `${(x * 100).toFixed(d)}%` : "n/a"), fx = (x, d = 1) => (isNum(x) ? x.toFixed(d) : "n/a");
    return `COMPANY
Price ${fx(ctx.px, 2)} · market cap ${isNum(n(ctx.row?.market_cap)) ? (n(ctx.row.market_cap) / 1e9).toFixed(1) + "B" : "n/a"} · ${ctx.profile?.exchange || ""} · CEO ${ctx.profile?.ceo || "n/a"} · employees ${ctx.profile?.fullTimeEmployees || "n/a"}
Business: ${trim(ctx.profile?.description, 1600)}
Revenue by product (${ctx.segments?.product?.label || "n/a"}): ${(ctx.segments?.product?.items || []).map((x) => `${x.name} ${pc(x.share, 0)}${isNum(x.yoy) ? ` (${x.yoy >= 0 ? "+" : ""}${pc(x.yoy, 0)} y/y)` : ""}`).join("; ") || "n/a"}
Revenue by geography (${ctx.segments?.geo?.label || "n/a"}): ${(ctx.segments?.geo?.items || []).map((x) => `${x.name} ${pc(x.share, 0)}${isNum(x.yoy) ? ` (${x.yoy >= 0 ? "+" : ""}${pc(x.yoy, 0)} y/y)` : ""}`).join("; ") || "n/a"}
Last quarters (newest first; revenue $M, gross / operating margin, net income $M): ${(ctx.quarters || []).slice(0, 8).map((q) => `${q.date} ${isNum(q.rev) ? (q.rev / 1e6).toFixed(0) : "n/a"}, ${q.rev ? pc(q.gp / q.rev, 0) : "n/a"}/${q.rev ? pc(q.oi / q.rev, 0) : "n/a"}, ${isNum(q.ni) ? (q.ni / 1e6).toFixed(0) : "n/a"}`).join(" | ") || "n/a"}
Quality: Piotroski ${ctx.quality?.piotroski ?? "n/a"}/9, Altman Z ${ctx.quality?.altman ?? "n/a"} (${ctx.quality?.altman_zone || "n/a"}), ROIC ${pc(ctx.quality?.roic)}, cash conversion ${fx(ctx.quality?.cash_conversion, 2)}x, accruals ${pc(ctx.quality?.accruals)}, payout ${pc(ctx.quality?.payout, 0)}, buyback yield ${pc(ctx.quality?.buyback_yield)}, FCF yield ${pc(ctx.quality?.fcf_yield)}, net debt/EBITDA ${fx(ctx.quality?.nd_ebitda)}, interest cover ${fx(ctx.quality?.int_cover)}, stock comp/revenue ${pc(ctx.quality?.sbc_rev)}.
What the price assumes: steady FCF growth of ${pc(ctx.implied?.g)} a year at a ${pc(ctx.implied?.r)} cost of equity.
Risk (1Y): beta ${fx(ctx.risk?.beta, 2)}, alpha ${pc(ctx.risk?.alpha)} a year vs SPY, volatility ${pc(ctx.risk?.vol, 0)}.${ctx.facts ? "\n" + ctx.facts : ""}
${ctx.ptrend ? `Average analyst target: last month ${fx(ctx.ptrend.m, 2)} (${ctx.ptrend.m_n} targets), last quarter ${fx(ctx.ptrend.q, 2)} (${ctx.ptrend.q_n}), last year ${fx(ctx.ptrend.y, 2)} (${ctx.ptrend.y_n}).\n` : ""}Estimates: ${(ctx.estimates || []).map((e) => `FY${e.year}: revenue ${isNum(e.rev) ? (e.rev / 1e9).toFixed(2) + "B" : "n/a"}, EPS ${fx(e.eps, 2)}`).join("; ") || "n/a"}. Sell side: ${ctx.consensus ? `${ctx.consensus.consensus || "n/a"} (${ctx.consensus.buy} buy / ${ctx.consensus.hold} hold / ${ctx.consensus.sell} sell), target ${fx(ctx.consensus.target, 2)} (${fx(ctx.consensus.low, 0)}-${fx(ctx.consensus.high, 0)})` : "n/a"}. Insiders (last 2 quarters): ${ctx.insider ? `${ctx.insider.purchases} buys, sales ${fx(ctx.insider.sales_vs_norm, 2)}x normal` : "n/a"}.

VERSUS THE INDUSTRY'S TOP 50 (value · industry median · percentile, 100 = highest)
${(ctx.peers || []).map((r) => `${r.label}: ${r.kind === "pct" || r.kind === "chg" ? pc(r.value) : r.kind === "cap" ? (r.value / 1e9).toFixed(1) + "B" : fx(r.value, 2)} · ${r.kind === "pct" || r.kind === "chg" ? pc(r.median) : r.kind === "cap" ? (r.median / 1e9).toFixed(1) + "B" : fx(r.median, 2)} · p${r.pct ?? "n/a"}`).join("\n")}
Closest peers in the industry: ${(ctx.closest || []).map((c) => `${c.symbol} (${trim(c.name, 40)}; cap ${(n(c.market_cap) / 1e9).toFixed(1)}B, P/E ${fx(n(c.pe))}, growth ${pc(n(c.rev_growth), 0)}, op margin ${pc(n(c.op_margin), 0)}, 1Y ${pc(n(c.ret_1Y), 0)})`).join("; ") || "n/a"}`;
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

${companyBlock(ctx)}

ITS REVENUE ON THE INDUSTRY'S TRADE MAP
${(ctx.geo || []).map((g) => `${g.region} ${pc(g.share, 0)} → ${g.countries.map((c) => `${c.country} (${c.stance || "n/a"}, ${c.trajectory || ""}, ${c.importance || ""} importance${c.threat && c.threat !== "none" ? `, threat ${c.threat}` : ""})`).join("; ") || "no trade-map country"}`).join("\n") || "n/a"}
ITS PRODUCT LINES VS THE INDUSTRY'S HOT AND COOL SEGMENTS
${(ctx.seg || []).map((s) => `${s.segment} ${pc(s.share, 0)} → ${s.match ? `${s.match.temp} segment "${s.match.name}": ${s.match.text}` : "no match"}`).join("\n") || "n/a"}

INDUSTRY ANALYSIS ON THIS COMPANY (cite by A-ID)
${(ctx.mentions || []).map((m) => `[${m.id}] ${m.section}${m.where ? ` › ${m.where}` : ""}${m.role ? ` (${m.role})` : ""}: ${m.text}`).join("\n") || "(not named in the industry analysis)"}

COMPANY NEWS AND PRESS RELEASES (last 60 days; cite by ID)
${(ctx.news || []).map((x) => `[${x.id}] ${x.date} · ${x.source || ""} — ${x.title}${x.summary ? `. ${trim(x.summary, 240)}` : ""}`).join("\n") || "(none)"}
${ctx.transcript ? `\nLATEST EARNINGS CALL [${ctx.transcript.id}] (${ctx.transcript.period || ""}, ${ctx.transcript.date || ""}; cite by ID)\n${trim(ctx.transcript.text, 7000)}\n` : ""}
${ctx.lens && (part === "context" || part === "calls" || part === "exposures") ? lensBlock(ctx.lens, ctx.sym, part) + "\n\n" : ""}${part === "calls" && ctx.windows ? `${ctx.sym}'S WINDOWS (code)\n${ctx.windows}\n\n` : ""}${(part === "calls" || part === "core") && ctx.times ? `${ctx.times}\n\n` : ""}${panelsFor(ctx.indPanels, part) ? `THE INDUSTRY'S READ, PANEL BY PANEL (the industry report's own analysis and numbers for each panel; set ${ctx.sym}'s against it)\n${panelsFor(ctx.indPanels, part)}\n\n` : ""}${part === "exposures" ? "" : `THE INDUSTRY ANALYSIS (your team's; the industry-level view)
${DIG_FOR[part].map(([k, label, a, b]) => (D[k] ? `${label}: ${J(lean(k === "lead" ? leadFor(D.lead, part) : D[k], a, b))}` : "")).filter(Boolean).join("\n")}

`}RULES
- Cite every factual claim with IDs in square brackets: [A#] for the industry analysis, [N#]/[P#] for news and releases, [T#] for the call. Numbers given above (statements, ratios, percentiles) need no citation. Never invent a fact, date, figure or quote; say "(estimate)" for your own estimates.
- Be specific to this company: name its brands, segments, regions, customers and competitors where the data supports it. Compare with peers by ticker.
- Connect EVERY row you answer to this company. Never write "no link", "unrelated", "no read-across" or "none": find the channel (direct; through a customer, supplier, bottler or partner; through a competitor it gains or loses against; a precedent that could later apply to it; a read-across for its multiple, demand or costs; or the sector's sentiment), say how big it is, and mark it low if it is small.
- Each driver: the industry's view, then whether it hits ${ctx.sym} more, less, the same or the opposite way, and why.
- Scenarios: "eps_change" is the change in next-twelve-month EPS from today's (a [low, high] range in %), "pe" the [low, high] P/E in 12 months, "price_target" the [low, high] price in 12 months; they must agree (price ≈ today's price x (1 + EPS change) x P/E / today's P/E ${isNum(n(ctx.row?.fwd_pe)) ? fx(n(ctx.row.fwd_pe)) : isNum(n(ctx.row?.pe)) ? fx(n(ctx.row.pe)) : "n/a"}); probabilities sum to 100.
- Horizons: each call is your own judgment for that window; "vs_industry" says whether ${ctx.sym} should beat, match or lag the industry, given its beta ${fx(ctx.risk?.beta, 2)} and the industry calls.
- The industry's outlook (Lead strategist: outlook, where the industry is going over 1M-12M) and its latest update (latest_update) are the freshest read on the industry: start from them, and say where ${ctx.sym} departs from them and why.
- Start every call from history: ${ctx.times ? `${ctx.sym} IN TIMES LIKE THIS gives what ${ctx.sym} did after the industry's closest past months, next to the industry. "probability_up" starts from ${ctx.sym}'s own hit rate there, "expected_move" from its middle half, and "vs_industry" from how often it beat the industry in those months; move away only for a stated reason this time is different, citing the episodes [HE#] that agree or disagree.` : `use ${ctx.sym}'s own history over each span (in ${ctx.sym}'S WINDOWS) and the industry's calls.`}
${Calls.rules(ctx.sym)}
- Street: compare your view with the sell-side consensus given above (ratings, average target and range, how targets moved, FY estimates, recent rating changes). Agree only if your scenarios land near the consensus target and your EPS view matches; otherwise say where you differ (estimates, margins, the multiple, catalysts, risks) and why.
- "expected_move" is the LIKELY range: the middle half of outcomes, centered on your expected return for the window. Its half-width should be about two-thirds of the stock's one-sigma move for that window, never more${ctx.sigmas ? ` (one-sigma moves from ${ctx.sym}'s own volatility: ${Object.entries(ctx.sigmas).map(([h, v]) => `${h} ±${v}%`).join(", ")})` : ""}. A narrow, well-reasoned range is the point; don't widen it to cover every outcome.

${schemaFor(part)}`;
  }

  /** Keep only citations that exist; cut lengths; normalize enums. */
  function cleanThesis(raw, idx) {
    if (!raw || typeof raw !== "object") return null;
    const ok = (id) => !!idx[id];
    const txtP = (s, k) => String(s ?? "").split(/\n{2,}/).map((x) => txt(x, k)).filter(Boolean).join("\n\n").slice(0, k * 3);
    const txt = (s, k = 1400) => keepT(String(s ?? "").replace(/\[([A-Z]{1,2}\d{1,4}(?:,\s*[A-Z]{1,2}\d{1,4})*)\]/g, (m, g) => { const keep = g.split(/,\s*/).filter(ok); return keep.length ? `[${keep.join(", ")}]` : ""; }).replace(/\s+([.,;:])/g, "$1"), k);
    const ev = (a) => (Array.isArray(a) ? a.map(String).filter(ok).slice(0, 6) : []);
    const en = (v, list, d) => (list.includes(lc(v)) ? lc(v) : d);
    const rng = (r) => (Array.isArray(r) ? r.map(Number).filter(isNum).slice(0, 2).sort((a, b) => a - b) : isNum(Number(r)) ? [Number(r)] : []);
    const arr = (x, k) => (Array.isArray(x) ? x.slice(0, k) : []);
    const sc = (s) => (s && typeof s === "object" ? { probability: isNum(Number(s.probability)) ? Number(s.probability) : null, narrative: txt(s.narrative, 900), eps_change: rng(s.eps_change), pe: rng(s.pe), price_target: rng(s.price_target) } : null);
    const fit = (f) => (f && typeof f === "object" ? { fit: en(f.fit, ["strong", "good", "weak", "poor"], ""), conviction: en(f.conviction, ["high", "medium", "low"], ""), why: txt(f.why, 500), how_to_own: txt(f.how_to_own, 400), watch: txt(f.watch, 300), what_changes: txt(f.what_changes, 400) } : null);
    const ST = raw.street && typeof raw.street === "object" ? raw.street : null, IV = ["above", "in line", "below"];
    const street = ST ? { stance: en(ST.stance, ["agree", "more bullish", "more bearish"], ""), summary: txt(ST.summary, 700), our_target: isNum(Number(ST.our_target)) && Number(ST.our_target) > 0 ? Number(ST.our_target) : null,
      eps_view: ST.eps_view ? { fy1: en(ST.eps_view.fy1, IV, ""), fy2: en(ST.eps_view.fy2, IV, ""), why: txt(ST.eps_view.why, 400) } : null,
      differences: arr(ST.differences, 6).map((d) => ({ topic: txt(d?.topic, 120), street: txt(d?.street, 300), ours: txt(d?.ours, 300), why: txt(d?.why, 500) })).filter((d) => d.topic) } : null;
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
        return [h, { call: Calls.norm(x.call, "neutral"), conviction: Calls.conviction(x.conviction), conviction_why: txt(x.conviction_why, 400), expected_move: rng(x.expected_move), probability_up: isNum(pu) ? Math.max(0, Math.min(100, Math.round(pu))) : null, vs_industry: en(x.vs_industry, ["outperform", "in line", "underperform"], ""), drivers: txt(x.drivers, 2400),
          decisions: arr(x.decisions, 8).map((d) => ({ refs: ev(d?.refs), date: String(d?.date || "").slice(0, 10), event: txt(d?.event, 240), lean: en(d?.lean, ["positive", "negative", "binary", "neutral"], "neutral"), outcomes: txt(d?.outcomes, 700) })).filter((d) => d.event),
          conflicts: arr(x.conflicts, 8).map((c) => ({ refs: ev(c?.refs), situation: txt(c?.situation, 240), in_window: txt(c?.in_window, 500), impact: txt(c?.impact, 500) })).filter((c) => c.situation),
          positioning: txt(x.positioning, 700), risk: txt(x.risk, 600), sections: arr(x.sections, 6).map((k) => lc(k)).filter((k) => SEC_KEYS.includes(k)) }]; })),
      risks: arr(raw.risks, 8).map((x) => ({ risk: txt(x?.risk, 300), likelihood: en(x?.likelihood, ["high", "medium", "low"], ""), impact: en(x?.impact, ["high", "medium", "low"], ""), evidence: ev(x?.evidence) })).filter((x) => x.risk),
      catalysts: arr(raw.catalysts, 8).map((x) => ({ date: String(x?.date || "").slice(0, 10), event: txt(x?.event, 200), why: txt(x?.why, 300) })).filter((x) => x.event),
      watch: arr(raw.watch, 6).map((x) => txt(x, 200)).filter(Boolean),
      fit: Object.fromEntries(["income", "conservative", "growth", "aggressive"].map((k) => [k, fit(raw.fit?.[k])]).filter(([, v]) => v?.fit)), street,
      confidence: en(raw.confidence, ["high", "medium", "low"], ""),
      reads: Object.fromEntries([...Object.keys(READS.core), ...Object.keys(READS.calls), ...Object.keys(READS.context)].map((k) => [k, txt((raw.reads || {})[k] ?? (raw.reads_calls || {})[k] ?? (raw.reads_more || {})[k], 900)]).filter(([, v]) => v)),
    };
  }
  /**
   * Hold each 1M-12M range to the likely range, the middle half of outcomes: half-width at most 0.7 sigma for that window,
   * around the call's own midpoint. sig: {"1M": sigma%, ...}. Changes t in place; returns notes on what was tightened.
   */
  function fitRanges(t, sig) {
    const notes = [];
    for (const h of HZ) { const x = t?.horizons?.[h], sg = Number(sig?.[h]); if (!x?.expected_move?.length || !isNum(sg) || sg <= 0) continue;
      const r = x.expected_move, lo = r[0], hi = r[r.length - 1], mid = (lo + hi) / 2, half = (hi - lo) / 2, cap = 0.7 * sg;
      if (half > cap + 0.5) { const nl = Math.round(mid - cap), nh = Math.round(mid + cap); notes.push(`${h} range ${lo}% to ${hi}% tightened to the likely range ${nl}% to ${nh}%`); x.expected_move = [nl, nh]; x.widened_from = [lo, hi]; }
      x.sigma = Math.round(sg * 10) / 10; }
    return notes;
  }
  /**
   * Hold each call to its own numbers and its conviction to history, as for the industry: sig = {"1M": sigma%, ...};
   * times = the company's Times like this (Regimes.company). Changes t in place; returns notes on what changed.
   */
  function holdCalls(t, sig, times = null) {
    const notes = [];
    for (const h of HZ) { const x = t?.horizons?.[h]; if (!x) continue;
      x.call = Calls.norm(x.call, "neutral"); x.conviction = Calls.conviction(x.conviction);
      const r = Calls.reconcile(x, Number(sig?.[h]) || null);
      if (r.fixed) { x.model_call = x.model_call || x.call; x.call = r.call; x.call_fixed = r.fixed; notes.push(`${h} ${r.fixed}`); }
      const b = times?.base?.[h], hp = b && b.n >= 8 ? b.pos : null, hl = isNum(hp) ? Calls.implied({ p: hp }) : null;
      if (hl && Calls.dir(hl) && Calls.dir(x.call) && Calls.dir(hl) !== Calls.dir(x.call) && isNum(x.conviction) && x.conviction > 6) {
        x.conviction_fixed = `conviction ${x.conviction} cut to 6: the call goes against history (up ${hp}% of the time in the industry's closest past months)`; notes.push(`${h} ${x.conviction_fixed}`); x.conviction = 6; } }
    return notes;
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
      if (Calls.dir(x.call) > 0 && isNum(m) && m <= 0) issues.push(`${h} is ${x.call} but its range is centered below zero`);
      if (Calls.dir(x.call) < 0 && isNum(m) && m >= 0) issues.push(`${h} is ${x.call} but its range is centered above zero`);
      if (h === "12M" && isNum(exp) && isNum(m) && Math.abs(m - exp * 100) > 8) issues.push(`the 12M range (${m.toFixed(0)}%) and the scenarios' expected return (${(exp * 100).toFixed(0)}%) disagree`); }
    return { issues, scenarios: rows, expected_return: exp, upside: up, downside: down };
  }

  const Company = { METRICS, pctRank, peerTable, closestPeers, nameCore, mentions, geoMap, segMap, quality, impliedGrowth, lean, thesisPrompt, companyBlock, cleanThesis, checks, fitRanges, holdCalls, SECTION, PART, PANELS_FOR, DIG_FOR, panelsFor, lensInputs, cleanLens, READS, SECS, calendarYear };
  if (typeof module !== "undefined" && module.exports) module.exports = Company;
  else root.Company = Company;
})(typeof window !== "undefined" ? window : globalThis);
