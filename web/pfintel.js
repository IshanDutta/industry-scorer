/* Industry Scorer: a portfolio through its industries' reports (code only, no I/O, nothing written by Claude).
 *
 * Everything here is pulled from the industry runs already saved, the way the fund page reads a fund: the macro
 * (each industry's regime, the macro tables, how the macro reaches them, what's moving, what would flip them, the
 * releases ahead), foreign affairs (world events, trade relations country by country, regulation and legal), the cycle
 * and KPIs, the lead strategists' debates and scenarios, times like this, each industry's calls, drivers and risks, and
 * the calendar, all weighted by what the portfolio holds in each industry.
 */
(function (root) {
  "use strict";
  const isNode = typeof module !== "undefined" && module.exports;
  const FM = isNode ? require("./fundmore.js") : root.FundMore;
  const FA = isNode ? require("./fundan.js") : root.FundAn;
  const P = isNode ? require("./portfolio.js") : root.Portfolio;
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const n = (x) => (x === null || x === undefined || x === "" ? NaN : Number(x));
  const lc = (s) => String(s || "").toLowerCase();
  const HZ = ["1M", "3M", "6M", "12M"];
  const safe = (f, dflt = null) => { try { return f(); } catch (e) { return dflt; } };

  /** An industry vector {name: weight} as a coverage object (equities only, renormalized, biggest first). */
  function covOf(ind, { min = 0.002 } = {}) {
    const rows = Object.entries(ind || {}).filter(([k, w]) => k && !k.startsWith("(") && isNum(n(w)) && n(w) > 0);
    const tot = rows.reduce((a, [, w]) => a + n(w), 0) || 1;
    return { industries: rows.map(([industry, w]) => ({ industry, weight: n(w) / tot })).filter((g) => g.weight >= min).sort((a, b) => b.weight - a.weight) };
  }

  /** The foreign-affairs tables without the copies the page doesn't show (each industry's whole macro table rides on its regime). */
  function trimAff(A) {
    if (!A) return A;
    const K = 16;
    return { ...A, tradeVerdicts: (A.tradeVerdicts || []).slice(0, K), regVerdicts: (A.regVerdicts || []).slice(0, K).map((v) => ({ ...v, regulators: undefined, timeline: (v.timeline || []).slice(0, 6), most_material: (v.most_material || []).slice(0, 5) })),
      regimes: A.regimes.slice(0, K).map((r) => ({ ...r, rows: undefined, groups: undefined, moves: (r.moves || []).slice(0, 4) })),
      indicators: A.indicators.map((x) => ({ ...x, reads: (x.reads || []).slice(0, 6) })), trade: A.trade.map((c) => ({ ...c, industries: (c.industries || []).slice(0, 8) })) };
  }
  /** Each industry's own report, briefly: the strategist's headline, calls, scenarios, drivers, risks and every panel's read. */
  function briefs(cov, digests, { k = 14 } = {}) {
    return cov.industries.slice(0, k).map((g) => { const d = digests[lc(g.industry)]; if (!d) return { industry: g.industry, weight: g.weight, missing: true };
      const m = d.lens?.macro || {};
      return { industry: g.industry, weight: g.weight, sector: d.sector || "", kind: d.kind, as_of: d.as_of || null, headline: d.headline || "", opportunity: d.opportunity || null, expected12: d.expected12,
        calls: Object.fromEntries(HZ.map((h) => [h, d.lean?.[h] || d.calls?.[h]?.call || ""])), p_up: d.calls?.["12M"]?.p_up ?? null, scen: d.scen || {}, drivers: d.drivers || [], risks: d.risks || [],
        reads: d.reads || {}, regime: m.regime || d.macro?.regime || null, macro_head: m.headline || "", positioning: d.positioning || null,
        trade: d.trade?.rating || null, reg: d.reg ? [d.reg.stance, d.reg.intensity].filter(Boolean).join(", ") : null, cycle: d.cycle?.position || null, pricing: d.cycle?.pricing || null,
        news: d.news ? { s7: d.news.s7, s90: d.news.s90, n30: d.news.n30, summary: d.news.news_dim?.summary || "", items: (d.news.items || []).slice(0, 4) } : null }; });
  }

  /**
   * The whole read for one portfolio. ind: {industry: weight} (look-through, equities); stocks: [{symbol, weight}] the
   * companies underneath (for "holdings named" and earnings dates); digests: Portfolio.digest per industry (lower case).
   */
  function build({ ind, stocks = [], digests = {}, today = new Date().toISOString().slice(0, 10), cos = {} } = {}) {
    const cov = covOf(ind); if (!cov.industries.length) return null;
    const share = stocks.reduce((a, s) => a + (n(s.weight) || 0), 0) || 1;
    const coInfo = {}; for (const g of cov.industries) for (const c of digests[lc(g.industry)]?.cos || []) coInfo[c.symbol] = { industry: g.industry, next: c.next, beats: c.beats, name: c.name };
    const hold = stocks.filter((s) => s.symbol).slice(0, 200).map((s) => ({ ticker: s.symbol, weight: n(s.weight) / share, industry: coInfo[s.symbol]?.industry || cos[s.symbol]?.industry || "", next: coInfo[s.symbol]?.next || null, beats: coInfo[s.symbol]?.beats || null, name: coInfo[s.symbol]?.name || "" }));
    const covered = cov.industries.filter((g) => digests[lc(g.industry)]), on = covered.reduce((a, g) => a + g.weight, 0);
    return {
      v: 1, as_of: today, on, n: covered.length, industries: cov.industries.slice(0, 40).map((g) => ({ ...g, analyzed: !!digests[lc(g.industry)], kind: digests[lc(g.industry)]?.kind || null, sector: digests[lc(g.industry)]?.sector || "" })),
      look: safe(() => { const L = P.lookThrough(cov, digests); return L && { ...L, world: undefined, trade: undefined, rules: undefined }; }),
      aff: safe(() => trimAff(FM.affairs(cov, digests, hold, { nI: 30, nW: 14, nC: 16, nR: 14, nL: 12 }))),
      cycle: safe(() => { const c = FM.cycleLook(cov, digests); return c && { ...c, rows: c.rows.slice(0, 16), next: c.next.slice(0, 30) }; }), debates: safe(() => FM.debates(cov, digests, 10), []), scen: safe(() => FM.scenLook(cov, digests)),
      times: safe(() => { const T = FM.timesLook(cov, digests, null); return T && { ...T, episodes: T.episodes.map((e) => ({ ...e, path: undefined, spy_path: undefined, fund_path: undefined })) }; }),
      cal: safe(() => FA.calendar(hold, cov, digests, today), []), briefs: briefs(cov, digests),
    };
  }

  const api = { covOf, briefs, build, trimAff };
  if (isNode) module.exports = api; else root.PfIntel = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
