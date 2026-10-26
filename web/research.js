/* Industry Scorer: research pack for one industry.
 *
 * Code (not a model) gathers the evidence the analyst team reads:
 *   FMP   company news, press releases, market news (3 pages), SEC M&A filings,
 *         the US economic calendar, analyst ratings and price targets, revenue
 *         segments by product and geography, and the latest earnings-call
 *         transcript for the 8 largest companies (condensed to its most
 *         specific sentences)
 *   EODHD (when connected) measured news sentiment per company, company news
 *         with sentiment polarity (world news comes from the shared wire in world.js)
 * Every item gets a short ID (N, P, W, M, E; transcripts T) that agents cite.
 * Keyword tagging flags legal and regulatory headlines.
 */
(function (root) {
  "use strict";
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const trim = (s, n) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  const day = (s) => String(s ?? "").slice(0, 10);
  function addDays(d, k) { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + k); return t.toISOString().slice(0, 10); }
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

  /** Read a connector result: FMP puts JSON in `payload`; EODHD wraps it in an embedded resource. */
  function readPayload(res) {
    // EODHD answers {"result": "<JSON text>"} (structured content); unwrap it first.
    const unwrap = (v) => {
      if (v && typeof v === "object" && !Array.isArray(v) && typeof v.result === "string" && Object.keys(v).length <= 2) {
        try { return JSON.parse(v.result); } catch { return v.result; }
      }
      return v;
    };
    let p = unwrap(res?.payload);
    if (typeof p === "string") { try { p = unwrap(JSON.parse(p)); } catch { /* keep looking */ } }
    if (p && typeof p === "object") return p;
    for (const b of res?.content || []) {
      const text = b?.type === "resource" ? b.resource?.text : b?.type === "text" ? b.text : null;
      if (!text || String(b?.resource?.uri || "").includes("quota")) continue;
      try { return unwrap(JSON.parse(text)); } catch { /* not JSON, keep looking */ }
    }
    return null;
  }

  /** Pick the most specific sentences of an earnings call (numbers + business keywords), kept in order and labeled by speaker. */
  function excerpt(content, maxChars = 10000) {
    const turns = String(content || "").split(/\n+/).map((x) => x.trim()).filter(Boolean);
    const sents = [];
    turns.forEach((turn, ti) => {
      const m = turn.match(/^([A-Z][\w.'’-]*(?: [A-Z][\w.'’-]*){0,3})\s?:\s+([\s\S]*)$/);
      const who = m ? m[1] : "", body = m ? m[2] : turn;
      if (/^operator$/i.test(who)) return;
      body.split(/(?<=[.!?])\s+(?=[A-Z"$0-9])/).forEach((t, si) => {
        t = t.trim(); if (t.length < 40) return;
        const nums = (t.match(/\d[\d,.]*\s?(%|percent|billion|million|basis points|bps|weeks|days|x\b)|\$\s?\d|\b\d{1,3}(?:\.\d)?\s?%|\b(?:double|triple)[ds]?\b|\b(?:mid|high|low)[- ](?:single|double)[- ]digits?\b|\bteens\b/gi) || []).length;
        sents.push({ ti, si, who, t, s: (2.5 * nums + Math.min(t.length, 300) / 150) * (t.endsWith("?") ? 0.3 : 1) });
      });
    });
    const ranked = sents.filter((x) => x.s >= 2.5).sort((a, b) => b.s - a.s);
    const pick = []; let len = 0;
    for (const x of ranked) { const t = trim(x.t, 420); if (len + t.length + 2 > maxChars) continue; pick.push({ ...x, t }); len += t.length + 2; if (len > maxChars - 120) break; }
    pick.sort((a, b) => a.ti - b.ti || a.si - b.si);
    const out = []; let prev = null;
    for (const x of pick) {
      if (prev && prev.ti === x.ti) out[out.length - 1] += (x.si === prev.si + 1 ? " " : " … ") + x.t;
      else out.push(`${x.who ? x.who + ": " : ""}${x.t}`);
      prev = x;
    }
    return out.join("\n");
  }
  /** Segment table: latest period vs the same period a year earlier. */
  function segTable(rows, lagIdx) {
    const r = (rows || []).filter((x) => x && x.data && typeof x.data === "object").sort((a, b) => (a.date < b.date ? 1 : -1));
    if (!r.length) return null;
    const cur = r[0], prev = r[lagIdx] || null;
    const tot = Object.values(cur.data).reduce((a, v) => a + (Number(v) > 0 ? Number(v) : 0), 0);
    if (!(tot > 0)) return null;
    const items = Object.entries(cur.data).filter(([, v]) => Number(v) > 0).map(([name, v]) => {
      const pv = prev ? Number(prev.data[name]) : NaN;
      return { name, value: Number(v), share: Number(v) / tot, yoy: pv > 0 ? Number(v) / pv - 1 : null };
    }).sort((a, b) => b.value - a.value).slice(0, 10);
    return { label: `${cur.period || ""} FY${cur.fiscalYear || ""}`.trim(), date: day(cur.date), ccy: cur.reportedCurrency || "USD", total: tot, items, vs: prev ? `${prev.period || ""} FY${prev.fiscalYear || ""}`.trim() : null };
  }

  const eodSym = (s) => String(s).replace(/\./g, "-").toUpperCase() + ".US";

  /**
   * @param fmp   async (tool, input) => array      (rate-limited FMP call)
   * @param eod   async (tool, input) => any | null  (EODHD call, or null when not connected)
   * @param ctx   {today, industry, constituents:[{symbol,name,weight}], onStep(label)}
   */
  async function gather(fmp, eod, ctx) {
    const { today } = ctx;
    const byW = [...ctx.constituents].sort((a, b) => (b.weight || 0) - (a.weight || 0));
    const top = (n) => byW.slice(0, n).map((c) => c.symbol);
    const nameOf = Object.fromEntries(byW.map((c) => [c.symbol, c.name]));
    // A company that relisted under a new ticker keeps its history under the old one (e.g. PSKY -> SKYD).
    const former = Object.fromEntries(byW.filter((c) => c.formerly).map((c) => [c.symbol, c.formerly]));
    const current = Object.fromEntries(Object.entries(former).map(([a, b]) => [b, a]));
    const cur = (sym) => current[sym] || sym;
    const withFormer = async (sym, fn) => { const r = await fn(sym); if ((r === null || (Array.isArray(r) && !r.length)) && former[sym]) return fn(former[sym]); return r; };
    const items = []; const counters = {};
    const add = (prefix, it) => {
      if (!it.url || items.some((x) => x.url === it.url)) return;
      counters[prefix] = (counters[prefix] || 0) + 1;
      items.push({ id: prefix + counters[prefix], kind: prefix, ...it });
    };
    const safe = async (label, fn) => { ctx.onStep?.(label); try { return await fn(); } catch (e) { if (ctx.isFatal?.(e)) throw e; return null; } };
    const out = { as_of: today, sources: ["FMP"], errors: [] };

    // Company news (top 20 by weight, two batches of 10)
    for (const batch of [top(10), byW.slice(10, 20).map((c) => c.symbol)]) {
      if (!batch.length) continue;
      const syms = [...batch, ...batch.map((x) => former[x]).filter(Boolean)];
      const rows = await safe("Company news", () => fmp("news", { endpoint: "search-stock-news", symbols: syms, from_date: addDays(today, -30), to_date: today, limit: 60 }));
      for (const r of rows || []) add("N", { date: day(r.publishedDate), symbol: cur(r.symbol), company: nameOf[cur(r.symbol)], source: r.site || host(r.url), title: trim(r.title, 200), summary: trim(r.text, 260), url: r.url });
    }
    // Press releases (top 8)
    {
      const rows = await safe("Press releases", () => fmp("news", { endpoint: "search-press-releases", symbols: top(8), from_date: addDays(today, -60), to_date: today, limit: 40 }));
      for (const r of rows || []) add("P", { date: day(r.publishedDate ?? r.date), symbol: r.symbol, company: nameOf[r.symbol], source: "press release", title: trim(r.title, 200), summary: trim(r.text, 220), url: r.url });
    }
    // World / market news
    {
      for (const page of [0, 1, 2]) {
        const rows = await safe("World and market news", () => fmp("news", { endpoint: "general-news", from_date: addDays(today, -10), to_date: today, limit: 50, page }));
        for (const r of rows || []) add("W", { date: day(r.publishedDate), source: r.site || r.publisher || host(r.url), title: trim(r.title, 200), summary: trim(r.text, 400), url: r.url });
        if (!rows?.length) break;
      }
    }
    // M&A filings involving the industry's companies
    {
      const set = new Set(byW.map((c) => c.symbol.toUpperCase()));
      const rows = (await safe("M&A filings", () => fmp("company", { endpoint: "latest-mergers-acquisitions", limit: 300 }))) || [];
      const hits = rows.filter((r) => set.has(String(r.symbol).toUpperCase()) || set.has(String(r.targetedSymbol).toUpperCase()));
      for (const c of byW.slice(0, 3)) {
        const q = String(c.name).replace(/,? (Inc|Corporation|Corp|Co|Ltd|Limited|plc|Holdings|Group|N\.V|S\.A)\.?$/i, "").split(" ").slice(0, 2).join(" ");
        const more = await safe("M&A filings", () => fmp("company", { endpoint: "search-mergers-acquisitions", name: q }));
        for (const r of (more || []).slice(0, 15)) hits.push(r);
      }
      const seenDeal = new Set();
      for (const r of hits.sort((a, b) => (String(a.transactionDate) < String(b.transactionDate) ? 1 : -1))) {
        const k = `${r.companyName}|${r.targetedCompanyName}`; if (seenDeal.has(k)) continue; seenDeal.add(k);
        add("M", { date: day(r.transactionDate), source: "SEC filing", title: `${trim(r.companyName, 80)} ${r.targetedCompanyName ? "→ " + trim(r.targetedCompanyName, 80) : ""}`.trim(),
          summary: `Acquirer ${r.symbol || "?"}${r.targetedSymbol ? ", target " + r.targetedSymbol : ""}`, acquirer: r.symbol, target: r.targetedSymbol, url: r.link });
        if (seenDeal.size >= 15) break;
      }
    }
    // US economic calendar, next 14 days
    {
      const rows = await safe("Economic calendar", () => fmp("economics", { endpoint: "economics-calendar", from_date: today, to_date: addDays(today, 14) }));
      out.calendar = (rows || []).filter((r) => r.country === "US" && (r.impact === "High" || r.impact === "Medium"))
        .map((r) => ({ date: String(r.date).slice(0, 16), event: r.event, impact: r.impact, previous: r.previous, estimate: r.estimate, unit: r.unit }))
        .sort((a, b) => (a.date < b.date ? -1 : 1)).slice(0, 25);
    }

    // Analyst consensus for the largest 15 (ratings + price targets vs current price)
    {
      const syms = top(15);
      const px = (await safe("Analyst consensus", () => fmp("quote", { endpoint: "batch-quote-short", symbols: syms }))) || [];
      const price = Object.fromEntries(px.map((r) => [r.symbol, Number(r.price)]));
      out.analyst = [];
      for (const s of syms) {
        const g = ((await safe("Analyst consensus", () => fmp("analyst", { endpoint: "grades-summary", symbol: s }))) || [])[0] || {};
        const t = ((await safe("Analyst consensus", () => fmp("analyst", { endpoint: "price-target-consensus", symbol: s }))) || [])[0] || {};
        const tgt = Number(t.targetConsensus), p = price[s];
        if (!g.consensus && !isNum(tgt)) continue;
        out.analyst.push({ symbol: s, name: nameOf[s], consensus: g.consensus || null, buy: (Number(g.strongBuy) || 0) + (Number(g.buy) || 0), hold: Number(g.hold) || 0,
          sell: (Number(g.sell) || 0) + (Number(g.strongSell) || 0), target: isNum(tgt) ? tgt : null, high: Number(t.targetHigh) || null, low: Number(t.targetLow) || null,
          price: isNum(p) ? p : null, upside: isNum(tgt) && p > 0 ? tgt / p - 1 : null });
      }
    }
    // Revenue segments (product, latest quarter vs a year ago; geography, latest fiscal year vs prior) for the largest 12
    out.segments = [];
    for (const s of top(12)) {
      const prod = await safe("Revenue segments", () => withFormer(s, (x) => fmp("statements", { endpoint: "revenue-product-segmentation", symbol: x, period: "quarter", limit: 6 })));
      const geo = await safe("Revenue segments", () => withFormer(s, (x) => fmp("statements", { endpoint: "revenue-geographic-segments", symbol: x, period: "annual", limit: 2 })));
      const p = segTable(prod, 4), g = segTable(geo, 1);
      if (p || g) out.segments.push({ symbol: s, name: nameOf[s], product: p, geo: g });
    }
    // Earnings-call transcripts: latest call for the 8 largest, condensed to the most specific passages
    out.transcripts = [];
    for (const s of top(8)) {
      let src = s;
      const recent = (ds) => (ds || []).filter((d) => d?.date && d.date <= today && d.date >= addDays(today, -200)).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
      let dates = await safe("Earnings-call transcripts", () => fmp("earningsTranscript", { endpoint: "transcripts-dates-by-symbol", symbol: s }));
      let last = recent(dates);
      if (!last && former[s]) { src = former[s]; dates = await safe("Earnings-call transcripts", () => fmp("earningsTranscript", { endpoint: "transcripts-dates-by-symbol", symbol: src })); last = recent(dates); }
      if (!last) continue;
      const tx = await safe("Earnings-call transcripts", () => fmp("earningsTranscript", { endpoint: "search-transcripts", symbol: src, year: last.fiscalYear, quarter: last.quarter }));
      const content = (tx || [])[0]?.content;
      if (!content) continue;
      // The call before, for the six largest, so the team can see what changed from one call to the next.
      let prev = null;
      if (out.transcripts.length < 6) {
        const p = (dates || []).filter((d) => d?.date && d.date < last.date).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
        if (p) { const pt = await safe("Earnings-call transcripts", () => fmp("earningsTranscript", { endpoint: "search-transcripts", symbol: src, year: p.fiscalYear, quarter: p.quarter }));
          const pc = (pt || [])[0]?.content; if (pc) prev = { date: day(p.date), period: `Q${p.quarter} FY${p.fiscalYear}`, excerpt: excerpt(pc, 6000) }; }
      }
      out.transcripts.push({ id: "T" + (out.transcripts.length + 1), symbol: s, name: nameOf[s], date: day(last.date), period: `Q${last.quarter} FY${last.fiscalYear}`, excerpt: excerpt(content), prev });
    }

    // EODHD: measured sentiment + news with polarity
    out.sentiment = null;
    if (eod) {
      out.sources.push("EODHD");
      const syms = top(15);
      const raw = await safe("EODHD news sentiment", () => eod("get_sentiment_data", { symbols: syms.map(eodSym).join(","), start_date: addDays(today, -90), end_date: today }));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const byDate = {}; const perCo = [];
        for (const s of syms) {
          const rows = raw[eodSym(s)] || raw[eodSym(s).replace(".US", "")] || [];
          let wsum = 0, cnt = 0, wsum30 = 0, cnt30 = 0;
          for (const r of Array.isArray(rows) ? rows : []) {
            const d = day(r.date), sc = Number(r.normalized), c = Number(r.count) || 0;
            if (!isNum(sc) || !c) continue;
            (byDate[d] ||= { w: 0, c: 0 }); byDate[d].w += sc * c; byDate[d].c += c;
            wsum += sc * c; cnt += c;
            if (d >= addDays(today, -30)) { wsum30 += sc * c; cnt30 += c; }
          }
          if (cnt) perCo.push({ symbol: s, name: nameOf[s], score_30d: cnt30 ? wsum30 / cnt30 : null, score_90d: wsum / cnt, articles_30d: cnt30, articles_90d: cnt });
        }
        const series = Object.entries(byDate).map(([date, v]) => ({ date, score: v.w / v.c, count: v.c })).sort((a, b) => (a.date < b.date ? -1 : 1));
        const avg = (from, to) => { const r = series.filter((p) => p.date >= from && p.date <= to); const c = r.reduce((s, p) => s + p.count, 0); return c ? r.reduce((s, p) => s + p.score * p.count, 0) / c : null; };
        if (series.length) out.sentiment = {
          series, by_company: perCo.sort((a, b) => (b.articles_30d || 0) - (a.articles_30d || 0)),
          last_7d: avg(addDays(today, -7), today), prior_30d: avg(addDays(today, -37), addDays(today, -8)), last_90d: avg(addDays(today, -90), today),
          articles_30d: series.filter((p) => p.date >= addDays(today, -30)).reduce((s, p) => s + p.count, 0),
        };
      } else out.errors.push("EODHD sentiment unavailable");
      for (const s of top(6)) {
        const rows = await safe("EODHD news", () => eod("get_company_news", { ticker: eodSym(s), start_date: addDays(today, -30), end_date: today, limit: 15 }));
        for (const r of Array.isArray(rows) ? rows : []) {
          const sen = r.sentiment || {};
          const pol = Number(sen.polarity ?? sen.content?.polarity ?? sen.title?.polarity);
          add("E", { date: day(r.date), symbol: s, company: nameOf[s], source: host(r.link) || "EODHD", title: trim(r.title, 200), summary: trim(r.content, 220), url: r.link, polarity: isNum(pol) ? pol : null });
        }
      }

    }
    items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    out.items = items;
    out.counts = Object.fromEntries(["N", "P", "W", "M", "E"].map((k) => [k, items.filter((i) => i.kind === k).length]));
    return out;
  }

  const Research = { gather, readPayload, eodSym, excerpt, segTable };
  if (typeof module !== "undefined" && module.exports) module.exports = Research;
  else root.Research = Research;
})(typeof window !== "undefined" ? window : globalThis);
