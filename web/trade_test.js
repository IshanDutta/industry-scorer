// Tests for Trade Relations: exposure from filings, health score, country news, critics, prompts.
const assert = require("assert");
const Tr = require("./trade.js");
const Team = require("./team.js");

const doc = { name: "Semiconductors", summary: { n_constituents: 3, total_market_cap: 5e12 },
  constituents: [{ symbol: "MU", name: "Micron", weight: 0.4, rev_ttm: 1.3e11, country: "US" }, { symbol: "TSM", name: "TSMC", weight: 0.4, rev_ttm: 1e11, country: "TW" }, { symbol: "ASML", name: "ASML", weight: 0.2, rev_ttm: 3e10, country: "NL" }] };
const pack = { items: [{ id: "N1", kind: "N", title: "MU flags China curbs", url: "https://n/1", date: "2026-10-01" }], segments: [
  { symbol: "MU", geo: { label: "FY FY2026", items: [{ name: "UNITED STATES", share: 0.68 }, { name: "TAIWAN, PROVINCE OF CHINA", share: 0.13 }, { name: "CHINA", share: 0.06 }, { name: "HONG KONG", share: 0.05 }, { name: "Europe", share: 0.08 }] } },
  { symbol: "TSM", geo: { label: "FY 2025", items: [{ name: "United States", share: 0.75 }, { name: "China", share: 0.1 }, { name: "Taiwan", share: 0.1 }, { name: "Japan", share: 0.05 }] } },
] };

(async () => {
  const cn = Tr.countryExposure(doc, pack, "China");
  assert(Math.abs(cn.revenue_share - (1.3e11 * 0.06 + 1e11 * 0.1) / 2.3e11) < 1e-9, "China excludes Taiwan and Hong Kong");
  const tw = Tr.countryExposure(doc, pack, "Taiwan");
  assert.deepStrictEqual(tw.hq, ["TSM"]); assert(Math.abs(tw.hq_weight - 0.4) < 1e-9);
  const table = Tr.exposureTable(doc, pack);
  const names = table.map((x) => x.country);
  assert(!names.includes("United States") && names.includes("Taiwan") && names.includes("China") && names.includes("Netherlands") && !names.includes("Europe"), "the US is never a trade partner row: " + names.join(","));
  const rm = Tr.regionMix(doc, pack);
  assert.deepStrictEqual(rm.map((r) => r.region), ["Europe"], "revenue reported only by region"); assert(Math.abs(rm[0].share - (0.08 * 1.3e11) / 2.3e11) < 1e-9);

  // health score: allied/improving healthy, adversarial/escalating critical
  assert.strictEqual(Tr.healthScore([{ importance: "existential", stance: "allied", trajectory: "improving" }]).band, "healthy");
  assert.strictEqual(Tr.healthScore([{ importance: "existential", stance: "adversarial", trajectory: "escalating" }, { importance: "high", stance: "sanctioned", trajectory: "deteriorating" }]).band, "critical");
  assert.strictEqual(Tr.healthScore([]), null);

  // country news: trade-relevant only, wire + topic search
  const wire = { items: [{ id: "G1", title: "China tightens gallium export controls", tags: ["CHINA"], summary: "", url: "https://c/1", date: "2026-10-10" }, { id: "G2", title: "China consumer spending slows", tags: ["CHINA"], summary: "retail", url: "https://c/2", date: "2026-10-11" }] };
  const { makeStore } = require("./world.js");
  const store = makeStore();
  const eod = async (tool, input) => (input.tag === "china" ? [{ date: "2026-10-12T00:00:00Z", title: "US adds Chinese chip firms to entity list", content: "export", link: "https://c/3" }, { date: "2026-10-12", title: "Chinese stocks rally", content: "rally", link: "https://c/4" }] : []);
  const news = await Tr.countryNews(eod, { today: "2026-10-19" }, "China", [], wire, store);
  assert.deepStrictEqual(news.map((n) => n.url).sort(), ["https://c/1", "https://c/2", "https://c/3", "https://c/4"], "every article naming China (or Chinese), no keyword filter");
  assert.strictEqual(Tr.bestCountry("KOREA", ["South Korea exports jump", "Seoul and South Korea"]), "South Korea");
  assert.strictEqual(Tr.bestCountry("CHINA"), "China"); assert.strictEqual(Tr.bestCountry("TAIWAN, PROVINCE OF CHINA"), "Taiwan"); assert.strictEqual(Tr.bestCountry("U.S."), "United States"); assert.strictEqual(Tr.bestCountry("Europe"), null);

  // critics
  const idx = Team.index(pack, null, null, wire.items, store.items);
  const map = Tr.cleanMap({ summary: "s", countries: [{ country: "United States", importance: "existential" }, { country: "Taiwan", roles: ["Manufacturing hub", "junk"], importance: "Existential", stance: "Allied", trajectory: "Volatile", why: "TSMC fabs", evidence: ["N1", "Z9"], threat: "High", threat_note: "PLA blockade drills", revenue_share_estimate: "12%" }, { country: "taiwan" }, { country: "China", stance: "adversary", trajectory: "escalating", importance: "high", roles: ["end market", "chokepoint input"] }] }, idx, doc, Team);
  assert.deepStrictEqual(map.countries.map((c) => `${c.rank}:${c.country}:${c.stance}:${c.trajectory}`), ["1:Taiwan:allied:volatile", "2:China:adversarial:escalating"]);
  assert.deepStrictEqual(map.countries[0].roles, ["manufacturing hub"]); assert.deepStrictEqual(map.countries[0].evidence, ["N1"]);
  assert.strictEqual(map.countries[0].threat, "high"); assert.strictEqual(map.countries[0].revenue_share_estimate, 0.12); assert.strictEqual(map.countries[1].threat, "none");
  assert(Tr.healthScore([{ importance: "existential", stance: "allied", trajectory: "volatile", threat: "critical" }]).score < Tr.healthScore([{ importance: "existential", stance: "allied", trajectory: "volatile", threat: "none" }]).score, "invasion threat lowers health");
  const batch = [{ ...map.countries[1], news }];
  const dv = Tr.cleanDives({ countries: [{ country: "CHINA", headline: "h",
    relationship: { alliance: "Rival", summary: "Strained [G1]", tension_points: ["Export controls"], cooperation: ["Truce"], evidence: ["G1"] },
    risks: [{ risk: "Tariffs rise", type: "Tariffs", likelihood: "low", impact: "low", tickers: ["MU", "FAKE"] }, { risk: "Taiwan blockade", type: "military conflict", likelihood: "medium", impact: "high", tickers: ["TSM"] }],
    security: { threat_level: "Elevated", threat: "PLA pressure on Taiwan", evidence: ["G1"] }, dependencies: [{ input: "Gallium", criticality: "Critical", substitutability: "3-5 years and $2B", evidence: ["G1"] }, { input: "End demand", substitutability: "under 6 months" }],
    policy: [{ instrument: "Gallium export ban", evidence: ["G1"] }, { instrument: "uncited rule" }], developments: [{ date: "2026-10-12", text: "Entity list", evidence: ["X1"] }, { date: "2026-10-01", text: "no cite" }],
    exposed: [{ symbol: "MU", channel: "Revenue", mechanism: "China sales capped" }, { symbol: "FAKE", channel: "revenue" }], freeze: "f", outlook: "o", watch: ["w"] }] }, idx, doc, batch, Team);
  assert.strictEqual(dv.length, 1);
  const c = dv[0];
  assert.strictEqual(c.relationship.alliance, "rival"); assert.deepStrictEqual(c.risks.map((x) => x.type), ["military conflict", "tariffs"], "worst risks first"); assert.deepStrictEqual(c.risks[1].tickers, ["MU"]);
  assert.strictEqual(c.security.threat_level, "elevated");
  assert.deepStrictEqual(c.dependencies.map((x) => `${x.criticality}|${x.substitutability}|${x.basis}`), ["critical|3-5+ years|cited", "medium|<6 months|background"]);
  assert.strictEqual(c.policy.length, 1); assert.strictEqual(c.developments.length, 1); assert.deepStrictEqual(c.exposed.map((x) => x.symbol + ":" + x.channel), ["MU:revenue"]);
  assert.deepStrictEqual(c.news.slice().sort(), ["G1", "G2", "X1", "X2"]);
  const vd = Tr.cleanVerdict({ rating: "Strained", bottlenecks: [{ chokepoint: "Gallium", countries: ["China"], severity: "critical", evidence: ["G1"] }], investment_read: { pass_through: "Partial", derate_risk: "High", text: "t" }, most_exposed: [{ symbol: "MU", why: "x" }, { symbol: "ZZ" }] }, idx, doc, Team, Tr.healthScore(map.countries));
  assert.strictEqual(vd.rating, "strained"); assert.strictEqual(vd.investment_read.derate_risk, "high"); assert.strictEqual(vd.most_exposed.length, 1); assert(vd.health && isFinite(vd.health.score));

  // prompts
  const ctx = { today: "2026-10-19", wire, exposure: table, worldDigest: "- War", kpiDigest: "Cycle: expansion" };
  const p1 = Tr.mapPrompt(doc, pack, { items: [{ id: "T1", symbol: "MU", excerpt: "China was 12% of revenue.\nOther line." }] }, { rows: [{ id: "I3", group: "Global activity", label: "Taiwan manufacturing PMI", value: 54, unit: "" }] }, ctx, Team);
  assert(p1.includes("Taiwan: revenue") && p1.includes("[G1]") && p1.includes("[T1] MU: China was 12%") && p1.includes("[I3] Taiwan manufacturing PMI"));
  const p2 = Tr.divePrompt(doc, pack, { rows: [{ id: "I4", group: "Global activity", label: "China exports, year over year", value: 8.5, unit: "%" }] }, ctx, batch.map((b) => ({ ...b, exposure: cn })), Team);
  assert(p2.includes("=== China") && p2.includes("[I4] China exports") && p2.includes("[X1]"));
  const p3 = Tr.verdictPrompt(doc, ctx, map, dv, Tr.healthScore(map.countries), Team);
  for (const p of [p1, p2, p3]) { const i = p.indexOf("undefined"); assert(i < 0, p.slice(Math.max(0, i - 200), i + 20)); assert(!p.includes("[object Object]")); }
  console.log("trade tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
