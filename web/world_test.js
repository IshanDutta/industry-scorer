// Tests for the world wire: CNBC desk discovery, topics, relevance-checked searches, expansion.
const assert = require("assert");
const W = require("./world.js");
const today = "2026-10-19";

(async () => {
  assert.deepStrictEqual(W.goodTags(["CNBC US SOURCE", "BREAKING NEWS E", "BREAKING NEWS ECONOMY", "RARE-EARTHS", "EU-CHINA-RELATI", "EU-CHINA-RELATIONS", "CHINA", "NA", "CHINA INDICATES RARE EARTHS WILL KEEP FLOWING"], "China indicates rare earths will keep flowing to EU"),
    ["RARE-EARTHS", "EU-CHINA-RELATIONS", "CHINA"]);

  const art = (i, tags, title, d = "2026-10-1" + (i % 9)) => ({ date: d + "T10:00:00+00:00", title, content: "Body " + title, link: `https://www.cnbc.com/${i}`, tags, sentiment: { polarity: 0.1 } });
  const feeds = {
    "cnbc us source": [
      art(1, ["CNBC US SOURCE", "PERSONAL FINANCE"], "How to save for retirement"),
      art(2, ["CNBC US SOURCE", "FOREIGN POLICY", "RARE-EARTHS", "CHINA", "BREAKING NEWS ASIA"], "China keeps rare earths flowing"),
      art(3, ["CNBC US SOURCE", "TRADE", "RARE-EARTHS", "TARIFFS"], "Rare earth curbs and tariffs"),
      art(4, ["CNBC US SOURCE", "ENERGY", "OPEC", "OIL", "CNBC ASIA SOURCE"], "OPEC+ holds output"),
    ],
    "cnbc asia source": [art(6, ["CNBC ASIA SOURCE", "RARE-EARTHS", "JAPAN"], "Japan stockpiles rare earths"), art(7, ["CNBC ASIA SOURCE", "OPEC", "OIL"], "Gulf output steady"), art(8, ["OPEC", "IRAN"], "Iran and OPEC")],
    "breaking news asia": [art(9, ["BREAKING NEWS ASIA", "OPEC"], "OPEC meets in Asia")],
  };
  const calls = [];
  const eod = async (tool, input) => { calls.push(input.tag); if (input.tag in feeds) return feeds[input.tag];
    if (input.tag === "rare-earths") return [art(20, ["RARE-EARTHS"], "Older rare earths story", "2026-09-25"), art(21, ["RARE-EARTHS"], "Alvotech receives FDA approval", "2026-09-26")];
    return { error: "" }; };
  const fmp = async (tool, input) => (input.page === 0 ? [{ publishedDate: "2026-10-18 09:00:00", title: "Ukraine strikes Russian refinery", text: "x", url: "https://f.com/1", site: "reuters.com" }] : []);
  const wire = await W.gatherWire(eod, fmp, { today });
  assert.strictEqual(calls[0], "cnbc us source", "starts from CNBC's US desk");
  assert(calls.includes("cnbc asia source") && calls.includes("breaking news asia"), "follows the desks tagged on CNBC's own articles: " + calls.join(","));
  assert.deepStrictEqual(wire.feeds.slice().sort(), ["breaking news asia", "cnbc asia source", "cnbc us source"]);
  const titles = wire.items.map((i) => i.title);
  assert(titles.includes("How to save for retirement") && titles.includes("Ukraine strikes Russian refinery"), "no keyword filter: the scout decides what matters");
  assert(wire.items.every((i, k) => i.id === "G" + (k + 1)));
  const top = wire.topics.map((t) => t.tag);
  assert(top.includes("RARE-EARTHS") || top.includes("OPEC"), JSON.stringify(wire.topics));
  assert(!top.some((t) => /SOURCE$|^BREAKING NEWS/.test(t)));

  // scout tools: only articles about the topic come back
  const store = W.makeStore();
  const tools = W.scoutTools(eod, { today }, wire, store);
  const found = await tools.find((t) => t.name === "search_news_by_topic").execute({ topic: "Rare-Earths" });
  assert.deepStrictEqual(found.map((f) => f.title), ["Older rare earths story"], "the unrelated FDA press release is dropped");
  const none = await tools.find((t) => t.name === "search_news_by_topic").execute({ topic: "strait of hormuz" });
  assert(none.note && /No articles/.test(none.note));
  const rd = await tools.find((t) => t.name === "read_article").execute({ id: "g1" });
  assert(rd.text.startsWith("Body"));

  // expansion: scout evidence + wire matches + relevant topic search, newest first, no dupes
  const sit = { title: "Rare earth export curbs", search_terms: ["rare earths", "rare-earths"], actors: ["China"], evidence: [wire.items[0].id] };
  const cov = await W.expand(eod, { today }, sit, wire, store);
  const ct = cov.map((i) => i.title);
  assert(ct.includes("China keeps rare earths flowing") && ct.includes("Older rare earths story") && !ct.includes("Alvotech receives FDA approval"));
  assert.strictEqual(new Set(cov.map((i) => i.url)).size, cov.length);

  // without EODHD: FMP-only wire still works
  const w2 = await W.gatherWire(null, fmp, { today });
  assert.strictEqual(w2.items.length, 1); assert.deepStrictEqual(w2.feeds, []);
  console.log("world tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
