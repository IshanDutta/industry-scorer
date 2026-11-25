// RbFix on a synthetic rule book: a removed claim checked again goes back in place; a replacement and an addition stand
// only with a verbatim quote from the source they name.
const assert = require("assert");
const RbFix = require("./rbfix.js");
const book = { rules: [{ name: "Rule A", citation: "40 CFR Part 63", what_this_is: "It is a rule. It sets limits by 2027.", industry_impact: "It hits margins.", today: "Today it binds.", last_12_months: [], next_12_months: { analysis: "More is coming.", events: [] }, examples: [], bottom_line: "Watch it." }] };
const raw = JSON.parse(JSON.stringify(book)); raw.rules[0].what_this_is = "It is a rule. EPA finalized it on 2024-05-01. It sets limits by 2027.";
const doc = { body: "EPA — US Environmental Protection Agency", raw, book, sources: [], checks: [{ id: "C1", text: "EPA finalized it on 2024-05-01.", label: "unsupported", quote: "", source: "", fix: "" }, { id: "C2", text: "It sets limits by 2027.", label: "background" }] };
const items = [{ id: "FR1", kind: "F", source: "Federal Register", title: "Final rule", summary: "EPA finalized the standards on 2024-05-01 for chemical plants." }];
(async () => {
  const out = await RbFix.enrich(doc, items, {
    check: async (p) => ({ results: [...p.matchAll(/^([UR]\d+) \[/gm)].map(([, id]) => ({ id, label: "verified", quote: id === "U1" ? "EPA finalized the standards on 2024-05-01" : "for chemical plants", source: "FR1" })) }),
    enrich: async () => ({ replacements: [], additions: [{ rule: 1, section: "what_this_is", text: "It covers chemical plants.", evidence: ["FR1"] }, { rule: 1, section: "today", text: "Made-up fact.", evidence: ["XX9"] }] }),
  }, { subject: "test", body: doc.body });
  assert.ok(out.doc.book.rules[0].what_this_is.startsWith("It is a rule. EPA finalized it on 2024-05-01. It sets limits by 2027."), out.doc.book.rules[0].what_this_is);
  assert.strictEqual(out.restored, 1);
  assert.ok(out.doc.book.rules[0].what_this_is.includes("It covers chemical plants [FR1]."));
  assert.strictEqual(out.doc.checks.find((c) => c.id === "C1").label, "verified");
  assert.strictEqual(out.doc.fact_check.removed, 0);
  assert.ok(out.doc.sources.some((x) => x.id === "FR1"));
  assert.strictEqual(doc.book.rules[0].what_this_is, "It is a rule. It sets limits by 2027.", "the saved book isn't changed in place");
  assert.ok(RbFix.isUS(doc.body) && !RbFix.isUS("CDI — California Department of Insurance") && !RbFix.isUS("SAMR (China)"));
  assert.deepStrictEqual(RbFix.cfrRefs("21 C.F.R. § 314.50"), [{ title: 21, part: 314 }]);
  console.log("rbfix ok");
})();
