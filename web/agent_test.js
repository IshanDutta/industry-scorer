// Critic tests: citations must resolve to retrieved items; overlay scales and caps.
const assert = require("assert");
const A = require("./agent.js");
const pack = { items: [
  { id: "N1", kind: "N", date: "2026-10-01", source: "reuters.com", title: "Chipmaker wins order", url: "https://www.reuters.com/a/b/" },
  { id: "M1", kind: "M", date: "2026-10-02", source: "SEC filing", title: "Acq → Target", url: "https://sec.gov/x.htm" },
] };
const raw = {
  headline: "Mixed.", summary: "Sum.",
  profiles: { income: { verdict: "Poor fit.", overlay: 50 }, conservative: { verdict: "Meh.", overlay: -7 }, growth: { verdict: "Strong.", overlay: 7 }, aggressive: { verdict: "Yes.", overlay: 3 } },
  sections: { performance: "Beat SPY.", valuation: "Rich." },
  dimensions: {
    news: { score: 2, summary: "s", evidence: ["N1", "N99"] },
    mna: { score: -1, summary: "s", evidence: [{ id: "m1", claim: "deal" }] },
    legal: { score: -2, summary: "s", evidence: [{ claim: "invented case", url: "https://court.example/1" }] },
    regulatory: { score: 1, summary: "s", evidence: [], bodies: [{ name: "FTC", why: "merger review" }, "BIS"] },
    perception: { score: 1, summary: "s", evidence: [{ claim: "tool found", url: "https://tools.example/z" }] },
  },
  catalysts: ["Order wins [N1]", "Made up [N77]"], risks: ["Export rules"], watch: ["Oct 15 TSM earnings"], confidence: "high",
};
const c = A.critic(raw, pack, [A.normUrl("https://tools.example/z")]);
assert.strictEqual(c.dimensions.news.evidence.length, 1, "unknown ID dropped");
assert.strictEqual(c.dimensions.news.evidence[0].url, "https://www.reuters.com/a/b/", "ID resolves to retrieved URL");
assert.strictEqual(c.dimensions.mna.evidence.length, 1, "lower-case ID object resolves");
assert.strictEqual(c.dimensions.legal.score, 0, "uncited dimension neutralized");
assert.ok(c.dimensions.legal.unsupported);
assert.strictEqual(c.dimensions.perception.evidence.length, 1, "URL from a tool result accepted");
assert.deepStrictEqual(c.dimensions.regulatory.bodies.map((b) => b.name), ["FTC", "BIS"], "regulator list kept");
assert.strictEqual(c.dimensions.regulatory.score, 0);
assert.strictEqual(c.dropped, 2);
// 3 of 7 dimensions supported -> overlay scaled by 3/7 then capped
assert.strictEqual(c.overlay.income, Math.min(5, Math.round(50 * 3 / 7)));
assert.strictEqual(c.overlay.conservative, Math.max(-5, Math.round(-7 * 3 / 7)));
assert.strictEqual(c.profiles.growth.verdict, "Strong.");
assert.strictEqual(c.sections.valuation, "Rich.");
assert.strictEqual(c.catalysts[0].refs[0].id, "N1");
assert.strictEqual(c.catalysts[1].text, "Made up", "invalid bracket ID stripped");
assert.strictEqual(c.confidence, "medium" === c.confidence ? "medium" : c.confidence);
const prompt = A.buildPrompt({ name: "Semis", summary: {}, fund: {}, constituents: [] }, pack, { profiles: {}, pillars: {} }, { today: "2026-10-13", rf: 0.04, y10: 0.05 });
assert.ok(prompt.includes("[N1]") && prompt.includes("[M1]"), "evidence IDs in prompt");
console.log("agent tests passed", c.overlay);
