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
assert.strictEqual(res.ok, 1); assert.strictEqual(res.of, 2); assert.strictEqual(res.done.length, 1);
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
// fact-checking finished rule-book passages: supported ones stay, unsupported ones go back to the last full sentence
const bk = { rules: [{ industry_impact: "Vendors lost sales [RA1]. The rule also hits distrib…", what_this_is: "Export rule under 15 CFR…" }] };
const cbk = P.plan([{ key: "book:x", label: "rule book", obj: bk }]);
const rbk = cbk[0].apply({ fills: [{ id: "F1", text: "Vendors lost sales [RA1]. The rule also hits distributors, who cut 20% of staff [RA1]." }, { id: "F2", text: "Export rule under 15 CFR 744 [RA1]." }] });
assert.strictEqual(rbk.done.length, 2);
const fcl = P.fillClaims(rbk.done);
assert.strictEqual(fcl[0].kind, "analysis"); assert.strictEqual(fcl[1].kind, "law");
const idx2 = { RA1: { id: "RA1", title: "Export rule", summary: "Vendors lost sales under 15 CFR 744." } };
const out2 = RB.applyFactcheck(bk, { claims: fcl, finalize() {} }, { results: [{ id: "C1", label: "unsupported" }, { id: "C2", label: "verified", quote: "Vendors lost sales under 15 CFR 744", source: "RA1" }] }, idx2);
assert.strictEqual(bk.rules[0].industry_impact, "Vendors lost sales [RA1].", "unsupported fill cut back to the last full sentence");
assert.strictEqual(bk.rules[0].what_this_is, "Export rule under 15 CFR 744 [RA1].", "verified fill stays");
assert.strictEqual(out2.summary.removed, 1);
assert.strictEqual(P.fallback("Short cut…"), "Short cut…", "nothing to cut back to: left as it was");
// unchecked: only text the log has never seen is checked; unsupported new sentences are removed, the rest stays
const bk3 = { rules: [{ name: "R", citation: "", category: "rule", status: "in_force", effective: "", numeric_value: "", severity: "high", what_this_is: "A 2025 rule [RA1].", industry_impact: "Vendors lost 10% of sales [RA1]. Distributors cut 20% of staff [RA1].", today: "", bottom_line: "", next_12_months: { analysis: "", events: [] }, last_12_months: [], examples: [] }] };
const doc3 = { book: bk3, checks: [{ text: "A 2025 rule [RA1].", label: "background" }, { text: "Vendors lost 10% of sales [RA1].", label: "verified" }] };
const u = P.unchecked(doc3, RB.bookSpec, RB);
assert.strictEqual(u.claims.length, 1); assert(u.claims[0].text.startsWith("Distributors"));
const part3 = u.claims.map((c, i) => Object.assign(c, { id: "C" + (i + 1) }));
const r3 = RB.applyFactcheck(null, { claims: part3, finalize: u.cs.finalize }, { results: [{ id: "C1", label: "unsupported" }] }, idx2);
assert.strictEqual(bk3.rules[0].industry_impact, "Vendors lost 10% of sales [RA1].", "unsupported new sentence removed, checked text kept");
assert.strictEqual(r3.summary.removed, 1);
assert.strictEqual(P.unchecked({ book: bk3, checks: [...doc3.checks] }, RB.bookSpec, RB), null, "nothing new: nothing to check");
console.log("patch tests passed");
