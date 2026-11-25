// Tests for web/patch.js: finding cut passages, accepting fills, and re-checking rule books from their originals.
const assert = require("assert");
const P = require("./patch.js"), RB = require("./regbook.js");
const ok = (c, m) => { assert(c, m); };

// cuts: strings ending in "…", not in sources or the daily history
const rep = { headline: "Margins expand as AI orders lift the cycle…", drivers: [{ text: "Full sentence." }, { text: "Capex rises 30% y/y at hyperscal…" }], sources: [{ title: "A title…" }], daily_history: [{ headline: "x…" }] };
const c = P.cuts(rep);
assert.deepStrictEqual(c.map((x) => x.path.join(".")), ["headline", "drivers.1.text"]);

// acceptFill keeps the saved start and adds to it; a rewrite or another cut is refused
assert.strictEqual(P.acceptFill("Capex rises 30% y/y at hyperscal…", "Capex rises 30% y/y at hyperscalers, led by MSFT [N3]."), "Capex rises 30% y/y at hyperscalers, led by MSFT [N3].");
assert.strictEqual(P.acceptFill("Capex rises 30% y/y at hyperscal…", "Spending grows fast."), null, "a rewrite is refused");
assert.strictEqual(P.acceptFill("Capex rises 30% y/y at hyperscal…", "Capex rises 30% y/y at hyperscalers and…"), null, "still cut is refused");
assert.strictEqual(P.acceptFill("Capex rises…", "Capex rises"), null, "nothing added is refused");

// plan + apply writes accepted fills in place
const r2 = JSON.parse(JSON.stringify(rep));
const ch = P.plan([{ key: "lead", label: "Lead analysis", obj: r2 }]);
assert.strictEqual(ch.length, 1); assert.strictEqual(ch[0].items.length, 2);
const res = ch[0].apply({ fills: [{ id: "F1", text: "Margins expand as AI orders lift the cycle into 2027." }, { id: "F2", text: "nope" }] });
assert.deepStrictEqual(res, { ok: 1, of: 2 });
assert.strictEqual(r2.headline, "Margins expand as AI orders lift the cycle into 2027.");
assert(r2.drivers[1].text.endsWith("…"), "refused fill leaves the passage as it was");
assert(P.fillPrompt(ch[0].items, { subject: "x", sources: { N3: { title: "t", summary: "s" } } }).includes("PASSAGES TO FINISH"));

// recheck/rebuild on a rule book: the old results reproduce the book; claims checked again as analysis come back
const book = { rules: [{ name: "Rule", citation: "15 CFR 744", category: "rule", status: "in_force", effective: "2025-01", numeric_value: "", severity: "high",
  what_this_is: "A 2025 export rule [RA1].", industry_impact: "Vendors lost 10% of sales [RA1]. The 2027 truce expiry is the key binary for the group [RA1].", today: "", bottom_line: "",
  next_12_months: { analysis: "", events: [] }, last_12_months: [], examples: [] }] };
const idx = { RA1: { id: "RA1", title: "Export rule", summary: "The 2025 export rule cut vendors' sales by 10%." } };
const w0 = JSON.parse(JSON.stringify(book)), cs0 = RB.claimsFor(w0, RB.bookSpec(w0));
const by = (t) => cs0.claims.find((x) => x.text.startsWith(t));
const fc0 = RB.applyFactcheck(w0, cs0, { results: [{ id: by("A 2025").id, label: "background" }, { id: by("Vendors").id, label: "verified", quote: "cut vendors' sales by 10%", source: "RA1" }, { id: by("The 2027").id, label: "unsupported" }] }, idx);
const doc = { raw: book, book: w0, checks: fc0.checks, fact_check: fc0.summary };
assert(!doc.book.rules[0].industry_impact.includes("2027"), "old check removed the reasoning");
const again = P.recheck(doc, RB.bookSpec, RB);
assert.strictEqual(again.claims.length, 1); assert(again.claims[0].text.startsWith("The 2027"));
const same = P.rebuild(doc, RB.bookSpec, { results: [] }, { claims: [], prev: again.prev }, idx, RB);
assert.deepStrictEqual(same.work, doc.book, "old results reproduce the saved book");
const back = P.rebuild(doc, RB.bookSpec, { results: [{ id: "C1", label: "analysis" }] }, again, idx, RB);
assert(back.work.rules[0].industry_impact.includes("The 2027 truce expiry"), "reasoning restored");
assert(back.work.rules[0].industry_impact.includes("Vendors lost 10%"), "kept facts stay");
assert.strictEqual(back.summary.analysis, 1); assert.strictEqual(back.summary.verified, 1);
console.log("patch tests passed");
