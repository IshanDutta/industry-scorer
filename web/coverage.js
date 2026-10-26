/* Industry Scorer: news coverage behind each macro indicator's move.
 *
 * For every indicator the macro planner chose, code gathers the articles that
 * could explain its move, from everything this run has already read plus
 * targeted searches:
 *   - the world news wire (G) and every article the world-events and trade
 *     teams pulled (X), the market and company news in the research pack
 *     (W, N, P, E), and the earnings-call excerpts (T);
 *   - news linked to the instrument itself (FMP forex news by currency pair);
 *   - EODHD topic tags the planner named for the series ("inflation",
 *     "interest-rates", "oil").
 * Each article is scored against the series: the planner's news phrases and
 * the label's distinctive words in the headline count most, the lede less,
 * a matching topic tag a little, and an instrument link a lot. Only articles
 * above a threshold become candidates. The world team's own links (a
 * situation that names the indicator) add that situation's evidence.
 *
 * The indicator analysts then cite from the candidates (or their own
 * searches) and must quote the sentence that explains the move; code checks
 * the quote is verbatim in the article (verifyCitation).
 */
(function (root) {
  "use strict";
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const day = (s) => String(s ?? "").slice(0, 10);
  function addDays(d, k) { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + k); return t.toISOString().slice(0, 10); }
  const trim = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
  const norm = (s) => ` ${String(s || "").toLowerCase().replace(/&amp;/g, "&").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/(\d)\.(\d)/g, "$1\u0000$2").replace(/[^a-z0-9%$&/\u0000]+/g, " ").replace(/\u0000/g, ".").replace(/\s+/g, " ").trim()} `;
  // Generic words that never identify a series on their own.
  const PLAIN = new Set("new the and for with from that this rate rates index price prices total change year years month months monthly yearly annual data level levels final flash prelim preliminary actual consensus previous prior united states us u.s. yoy mom qoq sa nsa per percent of in on to a an vs pmi market markets economy economic report".split(" "));
  const words = (s) => norm(s).trim().split(" ").filter(Boolean);

  /** The phrases an article about this series would contain. */
  function phrasesFor(row) {
    const out = new Set();
    const add = (p) => { const w = words(p).filter((x) => !/^\d+$/.test(x)); const t = w.join(" "); if (!t) return;
      if (w.length === 1 ? (!PLAIN.has(t) && t.length >= 3) : w.some((x) => !PLAIN.has(x))) out.add(t); };
    for (const p of row.phrases || []) add(p);
    for (const k of row.keywords || []) add(k);
    // The label and the release name, and their adjacent distinctive word pairs
    for (const part of [row.label, row.event].filter(Boolean).flatMap((x) => String(x).split(/[|(),;:]/))) {
      const w = words(part).filter((x) => !/^\d+$/.test(x));
      for (let i = 0; i + 1 < w.length; i++) if (!PLAIN.has(w[i]) && !PLAIN.has(w[i + 1])) out.add(w[i] + " " + w[i + 1]);
      const acr = (String(part).match(/\b[A-Z]{3,5}\b/g) || []).map((a) => a.toLowerCase()).filter((a) => !PLAIN.has(a));
      acr.forEach((a) => out.add(a));
      const solo = w.filter((x) => !PLAIN.has(x) && x.length >= 4);
      if (solo.length === 1) out.add(solo[0]);
    }
    // Instruments: "usd/jpy", "usdjpy"; commodity and index names
    if (row.symbol && /^[A-Z]{6}$/.test(row.symbol)) { out.add(`${row.symbol.slice(0, 3)}/${row.symbol.slice(3)}`.toLowerCase()); out.add(row.symbol.toLowerCase()); }
    return [...out].slice(0, 16);
  }
  // Country names come from the runtime (Intl), not a list.
  let _dn = null, _names = null;
  const regionName = (code) => { try { _dn ||= new Intl.DisplayNames(["en"], { type: "region" }); const n = _dn.of(String(code).toUpperCase()); return n && n !== String(code).toUpperCase() ? n : null; } catch { return null; } };
  function countryNames() {
    if (_names) return _names;
    const out = new Map();
    for (let i = 0; i < 26; i++) for (let j = 0; j < 26; j++) { const c = String.fromCharCode(65 + i, 65 + j); const n = regionName(c); if (n && !/unknown|world|outlying|pseudo/i.test(n)) out.set(c, n); }
    return (_names = out);
  }
  /** Countries named in a headline: full names ("Japan", "United Kingdom") and two-letter codes written in capitals ("UK", "US", "EU"). */
  function countriesIn(title) {
    const t = String(title || "").replace(/U\.S\.?/g, "US").replace(/U\.K\.?/g, "UK");
    const low = ` ${t.toLowerCase()} `;
    const out = new Set();
    for (const [c, n] of countryNames()) {
      const nm = n.toLowerCase().replace(/\s*\(.*\)\s*/g, "").replace(/[^a-z ]/g, " ").trim();
      if (nm.length >= 4 && new RegExp(`\\b${nm.replace(/\s+/g, "\\s+")}`).test(low)) out.add(c);
      if (new RegExp(`(^|[^A-Za-z])${c}([^A-Za-z]|$)`).test(t) && !["AI", "IT", "TV", "IN", "ON", "AT", "TO", "BY", "AN", "OR", "AS", "IS", "IF", "DO", "GO", "NO", "ME", "MY", "SO", "UP", "WE", "AM", "PM", "OK", "ID", "PE", "CA", "CO", "AL", "MA", "PA", "VA", "GA", "LA", "MO", "MS", "MN", "NE", "NC", "SC", "TN", "WA", "WI", "WV", "IL", "OH", "FL", "KY", "KS", "MT", "NV", "NM", "NY", "OR", "RI", "SD", "ND", "UT", "VT", "WY", "AZ", "AR", "CT", "DE", "HI", "IA", "MD", "ME", "MI", "NH", "NJ", "OK", "TX", "AK"].includes(c)) out.add(c);
    }
    if (out.has("GB")) out.add("UK"); if (out.has("UK")) out.add("GB");
    return out;
  }
  /** Does the headline put this release in another country? (UK CPI is not US CPI.) */
  function otherCountry(title, code) {
    if (!code) return false;
    const c = String(code).toUpperCase(); const alias = new Set([c, c === "UK" ? "GB" : c === "GB" ? "UK" : c, c === "EU" ? "EA" : c]);
    const found = countriesIn(title);
    if (!found.size) return false;
    return ![...found].some((x) => alias.has(x));
  }
  const has = (text, p) => text.includes(` ${p} `) || text.includes(` ${p}s `) || (p.includes("/") && text.includes(p));

  /** Score one article for one series. */
  function score(it, row, ph, tags) {
    // Earnings calls have no headline: management's own words count like one.
    const isT = it.kind === "T" || /^T\d+$/.test(it.id || "");
    const title = isT ? norm(it.text || it.excerpt) : norm(it.title), lede = isT ? " " : norm(String(it.text || it.summary || it.excerpt || "").slice(0, 900));
    let s = 0; const why = [];
    for (const p of ph) { if (has(title, p)) { s += p.includes(" ") || p.length >= 5 ? 3 : 2; why.push(p); } else if (has(lede, p)) { s += p.includes(" ") ? 1.5 : 1; why.push(p); } }
    if (it.instrument && row.symbol && it.instrument === row.symbol) { s += 4; why.push("instrument"); }
    const itags = (it.tags || []).map((t) => String(t).toLowerCase());
    if (tags.some((t) => itags.includes(t))) s += 1;
    // The world team tied this situation to the series: a bonus, but the article must still touch the series itself.
    if (it.linked?.includes(row.id) && s > 0) { s += 2; why.push("world team"); }
    // A release in another country (the headline names only other countries) is not coverage of this one.
    if (row.country && !isT && otherCountry(it.title, row.country)) s -= 6;
    // Timing: coverage near a release date, or recent for market series
    const d = day(it.date);
    if (row.date && d && d >= addDays(row.date, -2) && d <= addDays(row.date, 6)) s += 0.5;
    return { s, why: [...new Set(why)] };
  }

  /** Tags the planner gave, cleaned to EODHD's tag style. */
  const tagsFor = (row) => [...new Set((row.tags || []).map((t) => String(t).toLowerCase().trim().replace(/\s+/g, "-")).filter((t) => /^[a-z0-9-]{2,30}$/.test(t)))].slice(0, 4);

  /**
   * Gather candidates for every row.
   * @param ctx {today, isFatal, onStep, fmp, eod}
   * @param pool existing items [{id, kind, date, source, title, summary, url, tags}] (wire, store, pack, transcripts)
   * @param store World store (new items get X-IDs)
   * @param links {I#: [{title, why, evidence:[ids]}]} from the world team's deep dives
   * Returns {byRow: {I#: [{id, score, why}]}, items: Map id -> item (with text)}
   */
  async function gather(rows, ctx, pool, store, links = {}) {
    const items = new Map();
    const put = (it) => { if (it?.id && !items.has(it.id)) items.set(it.id, it); return it; };
    for (const it of pool) put(it);
    for (const [iid, ls] of Object.entries(links)) for (const l of ls) for (const id of l.evidence || []) { const it = items.get(id); if (it) (it.linked ||= []).push(iid); }
    const safe = async (label, fn) => { ctx.onStep?.(label); try { return await fn(); } catch (e) { if (ctx.isFatal?.(e)) throw e; return null; } };
    const fromEod = (r) => ({ date: day(r.date), source: host(r.link) || "EODHD", title: trim(r.title, 220), summary: trim(r.content, 900), text: String(r.content || "").slice(0, 4000), url: r.link, tags: (r.tags || []).slice(0, 10) });
    // Instrument-linked news: currency pairs and metals quoted against USD
    const pairs = [...new Set(rows.map((r) => r.symbol).filter((s) => /^[A-Z]{6}$/.test(s || "")))];
    if (ctx.fmp && pairs.length) {
      for (let k = 0; k < pairs.length; k += 5) {
        const got = await safe("Currency news", () => ctx.fmp("news", { endpoint: "search-forex-news", symbols: pairs.slice(k, k + 5), from_date: addDays(ctx.today, -21), to_date: ctx.today, limit: 60 }));
        for (const n of got || []) if (n?.url) { const x = store.add({ date: day(n.publishedDate), source: n.site || host(n.url), title: trim(n.title, 220), summary: trim(n.text, 900), text: String(n.text || ""), url: n.url, tags: [] }); x.instrument = n.symbol; put(x); }
      }
    }
    // Releases: the market news from the day of each release and the day after (that's when the move is explained).
    const relDays = [...new Set(rows.filter((r) => r.event && r.date).map((r) => day(r.date)))].sort().reverse().slice(0, 10);
    if (ctx.fmp) for (const d of relDays) for (const page of [0, 1]) {
      const got = await safe(`Market news from ${d}`, () => ctx.fmp("news", { endpoint: "general-news", from_date: d, to_date: addDays(d, 1), limit: 100, page }));
      for (const n of got || []) if (n?.url) put(store.add({ date: day(n.publishedDate), source: n.site || n.publisher || host(n.url), title: trim(n.title, 220), summary: trim(n.text, 900), text: String(n.text || ""), url: n.url, tags: [] }));
      if (!got || got.length < 100) break;
    }
    // Topic tags named by the planner: around each release date, and the last week for market series
    const tagWin = new Map();
    for (const r of rows) for (const t of tagsFor(r)) {
      const from = r.event && r.date ? day(r.date) : addDays(ctx.today, -7), to = r.event && r.date ? addDays(day(r.date), 2) : ctx.today;
      const k = `${t}|${from}|${to}`; if (!tagWin.has(k)) tagWin.set(k, { t, from, to });
    }
    if (ctx.eod) for (const { t, from, to } of [...tagWin.values()].slice(0, 30)) {
      const got = await safe(`News tagged "${t}"`, () => ctx.eod("get_company_news", { tag: t, start_date: from, end_date: to > ctx.today ? ctx.today : to, limit: 50 }));
      for (const r of Array.isArray(got) ? got : []) if (r?.link) put(store.add(fromEod(r)));
    }
    // Score
    const byRow = {};
    for (const row of rows) {
      const ph = phrasesFor(row), tags = tagsFor(row);
      const scored = [];
      for (const it of items.values()) {
        if (!it.title || (it.date && day(it.date) < addDays(ctx.today, -35))) continue;
        const { s, why } = score(it, row, ph, tags);
        if (s >= 3) scored.push({ id: it.id, score: Math.round(s * 10) / 10, why, date: day(it.date) });
      }
      scored.sort((a, b) => b.score - a.score || (a.date < b.date ? 1 : -1));
      byRow[row.id] = scored.slice(0, 6);
    }
    return { byRow, items };
  }

  /** Tools for the indicator analysts: search everything gathered (plus EODHD tags), read an article. */
  function tools(ctx, cov, store) {
    const out = [{
      name: "read_article",
      description: "Read an article's text by its ID (G12, X3, W4, N2, T1). Use it to find the sentence that explains a move, then quote it exactly.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      async execute(input) { const it = cov.items.get(String(input.id || "").toUpperCase()); if (!it) throw new Error("Unknown ID."); return { id: it.id, date: it.date, source: it.source, title: it.title, text: String(it.text || it.summary || it.excerpt || "").slice(0, 3500) }; },
    }, {
      name: "search_coverage",
      description: "Search this run's news (CNBC wire, world and trade coverage, market news, company news, earnings calls) and EODHD's news for a phrase an article explaining the move would contain, e.g. 'empire state', 'treasury yields', 'brent crude', 'yen', 'consumer prices'. Returns the best matches with citable IDs.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, tag: { type: "string", description: "optional EODHD topic tag to also search, e.g. 'inflation', 'interest-rates', 'oil'" } }, required: ["query"] },
      async execute(input) {
        const q = String(input.query || "").trim().slice(0, 60); if (!q) throw new Error("Pass a query.");
        const tag = String(input.tag || "").toLowerCase().trim().replace(/\s+/g, "-");
        if (ctx.eod && /^[a-z0-9-]{2,30}$/.test(tag)) {
          ctx.onStep?.(`Searching news tagged "${tag}"`);
          let got = null; try { got = await ctx.eod("get_company_news", { tag, start_date: addDays(ctx.today, -21), end_date: ctx.today, limit: 50 }); } catch (e) { if (ctx.isFatal?.(e)) throw e; }
          for (const r of Array.isArray(got) ? got : []) if (r?.link) { const x = store.add({ date: day(r.date), source: host(r.link) || "EODHD", title: trim(r.title, 220), summary: trim(r.content, 900), text: String(r.content || "").slice(0, 4000), url: r.link, tags: (r.tags || []).slice(0, 10) }); if (!cov.items.has(x.id)) cov.items.set(x.id, x); }
        }
        const ph = phrasesFor({ label: q, phrases: [q] });
        const hits = [];
        for (const it of cov.items.values()) { if (!it.title) continue; const { s } = score(it, { label: q }, ph, tag ? [tag] : []); if (s >= 1.5) hits.push([s, it]); }
        hits.sort((a, b) => b[0] - a[0] || (a[1].date < b[1].date ? 1 : -1));
        if (!hits.length) return { note: `Nothing found for "${q}". Try the words a headline would use, or a topic tag.` };
        return hits.slice(0, 10).map(([, it]) => ({ id: it.id, date: it.date, source: it.source, title: it.title, lede: trim(it.text || it.summary || it.excerpt, 400) }));
      },
    }];
    return out;
  }

  /**
   * Is this citation good? The quote must appear verbatim (ignoring case and
   * punctuation) in the article. Without a quote, only a strong candidate for
   * this row counts. Returns true/false.
   */
  function verifyCitation(id, quote, row, cov) {
    if (/^I\d+$/.test(id)) return true;
    const it = cov.items.get(id); if (!it) return false;
    const cand = (cov.byRow[row.id] || []).find((c) => c.id === id);
    const q = norm(quote).trim();
    if (q.split(" ").length >= 5) {
      const text = norm(`${it.title} ${it.text || ""} ${it.summary || ""} ${it.excerpt || ""}`);
      if (!text.includes(` ${q} `)) return false;
      if (cand) return true;
      // Found by the analyst's own search: the quote or headline must name the series.
      const ph = phrasesFor(row); const t = norm(`${it.title} ${quote}`);
      return ph.some((p) => has(t, p));
    }
    return !!cand && cand.score >= 4;
  }

  const Coverage = { phrasesFor, score, gather, tools, verifyCitation, norm, countriesIn, otherCountry };
  if (typeof module !== "undefined" && module.exports) module.exports = Coverage;
  else root.Coverage = Coverage;
})(typeof window !== "undefined" ? window : globalThis);
