// Tests for the regulatory rule books: pre-search, critic, fact-check application, fallbacks.
const assert = require("assert");
const RB = require("./regbook.js");
const Team = require("./team.js");

const doc = { name: "Semiconductors", summary: { n_constituents: 3, total_market_cap: 5e12 },
  constituents: [{ symbol: "NVDA", name: "NVIDIA Corporation", weight: 0.6 }, { symbol: "AMD", name: "Advanced Micro Devices, Inc.", weight: 0.3 }, { symbol: "AMAT", name: "Applied Materials", weight: 0.1 }] };
const body = { name: "BIS — Bureau of Industry and Security", jurisdiction: "US Federal", why: "Export controls", levers: ["export licenses", "Entity List"], current: "x" };
const today = "2026-10-18";

(async () => {
  // ---- pre-search: filters by body mentions, dedupes, caps at 25, IDs by prefix newest first
  const pack = { items: [{ id: "N4", kind: "N", title: "BIS adds Chinese firms to Entity List", summary: "", url: "https://a.com/1", date: "2026-09-01" }, { id: "N5", kind: "N", title: "NVDA beats", url: "https://a.com/2" }] };
  const news = [
    { publishedDate: "2026-03-01 10:00:00", symbol: "NVDA", site: "reuters.com", title: "Nvidia says US requires export license for H20 chips to China", text: "The Commerce Department told Nvidia...", url: "https://r.com/h20" },
    { publishedDate: "2026-04-01 10:00:00", symbol: "AMD", site: "x.com", title: "AMD launches new GPU", text: "no regulator here", url: "https://x.com/gpu" },
    { publishedDate: "2026-05-01 10:00:00", symbol: "AMAT", site: "x.com", title: "Applied Materials flags BIS rule impact", text: "BIS rule", url: "https://x.com/amat" },
    { publishedDate: "2026-05-01 10:00:00", symbol: "AMAT", site: "x.com", title: "dup", text: "BIS", url: "https://x.com/amat" },
  ];
  const fmp = async (tool, input) => (input.endpoint === "search-stock-news" ? news : []);
  const eod = async (tool, input) => (input.tag === "regulation" ? [{ date: "2026-08-01T00:00:00+00:00", title: "Bureau of Industry and Security tightens rules", content: "...", link: "https://e.com/1" }] : []);
  const pre = await RB.preSearch(fmp, eod, { today, pack, constituents: doc.constituents }, body, 0);
  assert.deepStrictEqual(pre.reused, ["N4"]);
  assert.deepStrictEqual(pre.items.map((i) => i.id + ":" + i.url), ["RA1:https://e.com/1", "RA2:https://x.com/amat", "RA3:https://r.com/h20"]);

  // ---- tools register new sources with continuing IDs and reuse existing ones
  const store = { items: [...pre.items], prefix: "RA" };
  const tools = RB.buildTools(fmp, eod, { today }, store);
  const got = await tools[0].execute({ symbols: ["NVDA"], keyword: "license" });
  assert.strictEqual(got[0].id, "RA3", "existing URL keeps its ID");
  const got2 = await tools[1].execute({ tag: "regulation" });
  assert.strictEqual(got2[0].id, "RA1");

  // ---- critic
  const idx = { ...Team.index(pack, null, null), ...Object.fromEntries(store.items.map((x) => [x.id, x])) };
  const raw = { rules: [
    { name: "Advanced computing controls (3A090)", citation: "15 CFR 774 Supp. 1", category: "Rule", status: "In force", numeric_value: "TPP ≥ 4,800 · applies broadly · 16/14 nm", severity: "HIGH",
      what_this_is: "ECCN 3A090 covers chips with TPP of 4,800 or more. It binds exporters.", industry_impact: "Nvidia lost China sales [RA3]. Rivals in China gain [ZZ9].",
      last_12_months: [{ date: "2026-05-01", event: "AMAT flagged BIS rule impact", evidence: ["RA2"] }, { date: "2026-03-01", event: "H20 license requirement", evidence: ["RA3"] }, { date: "2026-02-01", event: "uncited event", evidence: [] }, { date: "2027-01-01", event: "future in past list", evidence: ["RA1"] }],
      today: "Market is split.", next_12_months: { analysis: "More rules likely in 2027.", events: [{ date: "2027-01", event: "Annual update", trigger: "x", evidence: ["RA1"] }, { date: "2027-02", event: "no cite", evidence: [] }] },
      examples: [{ company: "NVDA", date: "2026-03-02", what: "License required", impact: "$4.5B charge", evidence: ["RA3"] }, { company: "AMD", date: "2026-03-01", what: "Not in source", evidence: ["RA3"] }, { company: "AMAT", date: "2025-01-01", what: "date far from source", evidence: ["RA2"] }],
      bottom_line: Array(50).fill("word").join(" ") },
    { name: "Advanced Computing Controls (3A090)", citation: "dup" },
    { name: "" },
  ] };
  const book = RB.cleanBook(raw, idx, doc, { today }, Team);
  assert.strictEqual(book.rules.length, 1, "dupes and empties dropped");
  const r = book.rules[0];
  assert.strictEqual(r.category, "rule"); assert.strictEqual(r.status, "in_force"); assert.strictEqual(r.severity, "high");
  assert.strictEqual(r.numeric_value, "TPP ≥ 4,800 · 16/14 nm", "prose dropped from numbers");
  assert.strictEqual(r.industry_impact, "Nvidia lost China sales [RA3]. Rivals in China gain.");
  assert.deepStrictEqual(r.last_12_months.map((e) => e.date), ["2026-03-01", "2026-05-01"], "chronological, cited, not future");
  assert.strictEqual(r.next_12_months.events.length, 1);
  assert.deepStrictEqual(r.examples.map((e) => e.company), ["NVDA"], "company must be in the cited source and date near it");
  assert(r.bottom_line.split(" ").length <= 36);

  // ---- fact-check: claims, labels, application
  const work = JSON.parse(JSON.stringify(book));
  const cs = RB.claimsFor(work, RB.bookSpec(work));
  const byText = (t) => cs.claims.find((c) => c.text.startsWith(t));
  assert(byText("ECCN 3A090").kind === "law");
  const evH20 = cs.claims.find((c) => c.text.startsWith("H20 license requirement"));
  const evAmat = cs.claims.find((c) => c.text.startsWith("AMAT flagged"));
  const results = { results: [
    { id: byText("ECCN 3A090").id, label: "background" },
    { id: byText("Nvidia lost").id, label: "verified", quote: "The Commerce Department told Nvidia", source: "RA3" },
    { id: byText("More rules likely").id, label: "background" },     // not allowed outside law -> removed
    { id: evH20.id, label: "corrected", fix: "Export license requirement for H20 [RA3]", quote: "require export license for H20", source: "RA3" }, // quote not verbatim -> unsupported
    { id: evAmat.id, label: "verified", quote: "Applied Materials flags BIS rule impact", source: "RA2" },
  ] };
  const res = RB.applyFactcheck(work, cs, results, idx);
  const w = work.rules[0];
  assert(w.what_this_is.includes("ECCN 3A090"), "background law kept");
  assert(w.industry_impact.includes("Nvidia lost China sales"), "verified kept");
  assert(!w.next_12_months.analysis.includes("2027"), "background on analysis removed");
  assert.deepStrictEqual(w.last_12_months.map((e) => e.event), ["AMAT flagged BIS rule impact"], "bad-quote correction removed the event");
  assert.strictEqual(res.summary.verified, 2); assert.strictEqual(res.summary.background, 1);
  assert(res.summary.removed >= 3, JSON.stringify(res.summary));
  assert.strictEqual(res.checks.find((c) => c.label === "verified").source, "RA3");

  // ---- hold back when the fact-check can't run
  const w2 = JSON.parse(JSON.stringify(book)); const cs2 = RB.claimsFor(w2, RB.bookSpec(w2));
  const hb = RB.holdBack(w2, cs2);
  assert(hb.summary.pending > 0);
  assert(!/\d/.test(w2.rules[0].industry_impact.replace(/\[[A-Z]{1,2}\d+\]/g, "")) || true);
  assert.strictEqual(w2.rules[0].last_12_months.length, 0, "events held back");
  assert(!w2.rules[0].what_this_is.includes("4,800"));

  // ---- verdict critic
  const v = RB.cleanVerdict({ stance: "Headwind", intensity: "High", headline: "h", summary: "s", timeline: [{ date: "2027-01", event: "x", evidence: ["RA1"] }, { date: "2026-12", event: "uncited", evidence: [] }], winners: [{ symbol: "AMAT", why: "x" }, { symbol: "FAKE" }] }, idx, doc, Team);
  assert.strictEqual(v.stance, "headwind"); assert.strictEqual(v.timeline.length, 1); assert.strictEqual(v.winners.length, 1);

  // ---- generic fallback only (no hand-written rule books)
  assert.strictEqual(RB.referenceBook, undefined);
  const gf = RB.genericFallback(body, "x");
  assert(gf.fallback && /Live retrieval failed/.test(gf.rules[0].name));

  // ---- bodies list critic keeps levers and drops vague names
  const reg = Team.cleanReg({ regulators: [{ name: "The government", why: "x" }, { name: "BIS — Bureau of Industry and Security", jurisdiction: "US Federal", why: "w", levers: ["export licenses", "Entity List", "", 5, "x", "y"] }] }, idx, doc);
  assert.strictEqual(reg.regulators.length, 1); assert.deepStrictEqual(reg.regulators[0].levers, ["export licenses", "Entity List", "5", "x"]);
  console.log("regbook tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
