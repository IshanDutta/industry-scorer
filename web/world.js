/* Industry Scorer: the world-news wire and event discovery, built fresh every run.
 *
 * No fixed watchlist of events, topics or feeds:
 *   1. Wire: CNBC (via EODHD, which carries CNBC's articles in full). The run
 *      starts from CNBC's US desk and follows the other CNBC desks it finds
 *      tagged on those articles, plus FMP's general market news.
 *   2. Discovery: the topics that recur across that wire, ranked by volume and
 *      recency; tags so common they say nothing are dropped by frequency.
 *   3. The world-events scout (team.js) reads the wire, groups it into live
 *      situations, and can search further by topic with a tool. Searches only
 *      return articles that are actually about the topic.
 *   4. Expansion: for each situation, code pulls 30 days of coverage on the
 *      scout's own search terms (again, only articles about those terms).
 * Wire items get IDs G1, G2, ...; items found later get X1, X2, ...
 */
(function (root) {
  "use strict";
  const trim = (s, n) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  const day = (s) => String(s ?? "").slice(0, 10);
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
  function addDays(d, k) { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + k); return t.toISOString().slice(0, 10); }
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);

  // CNBC is the starting point (EODHD carries CNBC's articles in full, each tagged with the CNBC desk that
  // published it). The other desks are discovered at runtime from those tags; no list of feeds or topics.
  const SEED = "cnbc us source";
  const WIRE_DAYS = 10, WIRE_MAX = 250, FEED_LIMIT = 150;
  const isDesk = (t) => /\bSOURCE$/.test(t) || /^BREAKING NEWS [A-Z][A-Z ]+$/.test(t) || /^CNBC\b/.test(t);

  /** Informative tags of one article: no desk tags, no EODHD 15-character truncations, no title-as-tag, nothing too common in this wire. */
  function goodTags(tags, title, common = null) {
    const all = (tags || []).map((t) => String(t).toUpperCase().trim()).filter(Boolean);
    const ttl = String(title || "").toUpperCase().replace(/[^A-Z0-9 ]/g, "");
    return all.filter((t) => !isDesk(t) && t !== "NA" && t.length <= 40 && !(t.length === 15 && all.some((u) => u.length > 15 && u.startsWith(t))) && !(ttl && t.length > 25 && ttl.startsWith(t.slice(0, 25))) && !(common && common.has(t)));
  }

  /**
   * The world wire for this run: CNBC's desks (discovered from the seed feed's
   * own desk tags) plus FMP's general market news, newest first. Topics are
   * the tags that recur across it, minus the ones so common they say nothing.
   */
  async function gatherWire(eod, fmp, ctx) {
    const today = ctx.today, from = addDays(today, -WIRE_DAYS);
    const safe = async (label, fn) => { ctx.onStep?.(label); try { return await fn(); } catch (e) { if (ctx.isFatal?.(e)) throw e; return null; } };
    const seen = new Set(); const pool = []; const feeds = [];
    const take = (rows, feed) => { for (const r of rows) { if (!r?.link || seen.has(r.link)) continue; seen.add(r.link);
      pool.push({ date: day(r.date), source: host(r.link) || "EODHD", title: trim(r.title, 220), text: String(r.content || ""), url: r.link, rawTags: r.tags || [], polarity: isNum(Number(r.sentiment?.polarity)) ? Number(r.sentiment.polarity) : null, feed }); } };
    if (eod) {
      const queue = [SEED]; const tried = new Set();
      while (queue.length && tried.size < 12) {
        const feed = queue.shift(); if (tried.has(feed)) continue; tried.add(feed);
        const rows = await safe(`Reading CNBC: ${feed.replace(/ source$/, "")}`, () => eod("get_company_news", { tag: feed, start_date: from, end_date: today, limit: FEED_LIMIT }));
        if (!Array.isArray(rows) || !rows.length) continue;
        feeds.push(feed); take(rows, feed);
        // Discover the other desks from the tags CNBC puts on its own articles
        const desks = {};
        for (const r of rows) for (const t of r.tags || []) { const u = String(t).toUpperCase().trim(); if (isDesk(u) && u.length > 15 && u !== feed.toUpperCase()) desks[u] = (desks[u] || 0) + 1; }
        for (const [d] of Object.entries(desks).sort((a, b) => b[1] - a[1])) if (!tried.has(d.toLowerCase())) queue.push(d.toLowerCase());
      }
    }
    for (const page of [0, 1, 2, 3]) {
      const rows = await safe("Reading general market news", () => fmp("news", { endpoint: "general-news", from_date: from, to_date: today, limit: 50, page }));
      if (!rows?.length) break;
      for (const r of rows) { if (!r?.url || seen.has(r.url)) continue; seen.add(r.url);
        pool.push({ date: day(r.publishedDate), source: r.site || r.publisher || host(r.url), title: trim(r.title, 220), text: String(r.text || ""), url: r.url, rawTags: [], feed: "fmp general news" }); }
    }
    pool.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    // Topics: tags recurring across the wire, weighted toward the last few days; tags on a quarter or more of all articles are too common to mean anything.
    const df = {};
    for (const a of pool) for (const t of new Set(goodTags(a.rawTags, a.title))) df[t] = (df[t] || 0) + 1;
    const tagged = pool.filter((a) => a.rawTags.length).length || 1;
    const common = new Set(Object.entries(df).filter(([, n]) => n > Math.max(8, tagged * 0.25)).map(([t]) => t));
    const counts = {};
    for (const a of pool) {
      a.tags = goodTags(a.rawTags, a.title, common);
      const w = (Date.parse(today) - Date.parse(a.date)) / 864e5 <= 3 ? 1.5 : 1;
      for (const t of new Set(a.tags)) { const c = (counts[t] ||= { tag: t, count: 0, score: 0, last: a.date }); c.count++; c.score += w; if (a.date > c.last) c.last = a.date; }
    }
    const topics = Object.values(counts).filter((c) => c.count >= 3).sort((a, b) => b.score - a.score).slice(0, 30).map((c) => ({ ...c, score: Math.round(c.score * 10) / 10 }));
    const items = pool.slice(0, WIRE_MAX).map((a, i) => ({ id: "G" + (i + 1), kind: "G", date: a.date, source: a.source, title: a.title, summary: trim(a.text, 700), url: a.url, tags: (a.tags || []).slice(0, 8), polarity: a.polarity, feed: a.feed }));
    return { as_of: today, items, topics, feeds, pool_size: pool.length, sources: [...new Set(items.map((i) => i.source))].slice(0, 20) };
  }

  /** Is an article about this search term? (the term, or each of its words, in the headline or the first paragraph) */
  function about(r, term) {
    const t = `${r.title || ""} ${String(r.content ?? r.summary ?? "").slice(0, 700)}`.toLowerCase();
    const w = String(term || "").toLowerCase().replace(/[-_]+/g, " ").split(/\s+/).filter((x) => x.length >= 3);
    return w.length > 0 && w.every((x) => new RegExp(`\\b${x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/s$/, "")}`).test(t));
  }

  /** Per-run store for sources found after the wire (scout searches, expansion): IDs X1, X2, ... */
  function makeStore(existing = []) {
    const items = [...existing];
    const add = (it) => { const hit = items.find((x) => x.url === it.url); if (hit) return hit; const x = { id: "X" + (items.length + 1), kind: "X", ...it }; items.push(x); return x; };
    return { items, add };
  }
  const fromEod = (r) => ({ date: day(r.date), source: host(r.link) || "EODHD", title: trim(r.title, 220), summary: trim(r.content, 900), url: r.link, tags: goodTags(r.tags, r.title).slice(0, 10), polarity: isNum(Number(r.sentiment?.polarity)) ? Number(r.sentiment.polarity) : null });

  /** Tools for the scout: search the news by topic, read an article in full. */
  function scoutTools(eod, ctx, wire, store) {
    const byId = (id) => wire.items.find((x) => x.id === id) || store.items.find((x) => x.id === id);
    const tools = [{
      name: "read_article",
      description: "Read the text of a wire item or search result by its ID (G12, X3). Returns {id, date, source, title, text, tags}.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      async execute(input) { const it = byId(String(input.id || "").toUpperCase()); if (!it) throw new Error("Unknown ID."); return { id: it.id, date: it.date, source: it.source, title: it.title, text: it.summary, tags: it.tags }; },
    }];
    if (eod) tools.push({
      name: "search_news_by_topic",
      description: "Search the last N days (default 21, max 45) of news (CNBC and other outlets) by one topic: a country, conflict, commodity, policy, organization, company or economic release (e.g. 'rare-earths', 'strait of hormuz', 'opec', 'empire state manufacturing', 'treasury yields'). Only articles that are actually about the topic are returned, with citable X-IDs.",
      inputSchema: { type: "object", properties: { topic: { type: "string" }, days: { type: "number" } }, required: ["topic"] },
      async execute(input) {
        const topic = String(input.topic || "").toLowerCase().trim().slice(0, 50); if (!topic) throw new Error("Pass a topic.");
        ctx.onStep?.(`Searching news on "${trim(topic, 30)}"`);
        const d = Math.min(Math.max(Number(input.days) || 21, 1), 45);
        const rows = await eod("get_company_news", { tag: topic, start_date: addDays(ctx.today, -d), end_date: ctx.today, limit: 40 });
        const kept = (Array.isArray(rows) ? rows : []).filter((r) => r?.link && about(r, topic)).slice(0, 15);
        if (!kept.length) return { note: `No articles about "${topic}" in the last ${d} days. Try a more specific or a different topic.` };
        return kept.map((r) => { const x = store.add(fromEod(r)); return { id: x.id, date: x.date, source: x.source, title: x.title, summary: trim(x.summary, 300), tags: x.tags }; });
      } });
    return tools;
  }

  /**
   * Coverage for one situation: wire items matching its search terms plus the
   * last 30 days of topic search per term. Newest first, at most `max`.
   */
  async function expand(eod, ctx, sit, wire, store, max = 30) {
    const terms = [...new Set([...(sit.search_terms || []), ...(sit.actors || [])].map((t) => String(t).toLowerCase().trim()).filter((t) => t.length > 2))].slice(0, 6);
    const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = terms.length ? new RegExp(`\\b(?:${terms.map((t) => esc(t).replace(/[-\s]+/g, "[-\\s]+")).join("|")})`, "i") : null;
    const out = new Map();
    for (const id of sit.evidence || []) { const it = wire.items.find((x) => x.id === id) || store.items.find((x) => x.id === id); if (it) out.set(it.url, it); }
    if (re) for (const it of [...wire.items, ...store.items]) if (re.test(`${it.title} ${(it.tags || []).join(" ")} ${it.summary}`)) out.set(it.url, it);
    if (eod) for (const t of terms.slice(0, 4)) {
      let rows = null;
      ctx.onStep?.(`Pulling coverage on "${trim(t, 30)}"`);
      try { rows = await eod("get_company_news", { tag: t, start_date: addDays(ctx.today, -30), end_date: ctx.today, limit: 30 }); } catch (e) { if (ctx.isFatal?.(e)) throw e; }
      for (const r of Array.isArray(rows) ? rows : []) { if (!r?.link || out.has(r.link) || !about(r, t)) continue; out.set(r.link, store.add(fromEod(r))); }
    }
    return [...out.values()].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, max);
  }

  const World = { SEED, gatherWire, goodTags, about, makeStore, scoutTools, expand };
  if (typeof module !== "undefined" && module.exports) module.exports = World;
  else root.World = World;
})(typeof window !== "undefined" ? window : globalThis);
