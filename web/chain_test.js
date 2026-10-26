// Tests for the value chain (prompt, cleaning, partner stats, aggregate, digest) and call-to-call (prompt, quote checks).
const assert = require("assert");
const C = require("./chain.js");
const doc = { name: "Semiconductors", constituents: [{ symbol: "NVDA", name: "NVIDIA" }, { symbol: "AMD", name: "AMD" }] };
const p = C.chainPrompt(doc, { today: "2026-10-25", kpiDigest: "AI demand" });
assert(p.includes("NVDA NVIDIA") && p.includes('"partners"') && !p.includes("undefined"));
const ch = C.cleanChain({ partners: [{ symbol: "msft", name: "Microsoft", role: "Customer (hyperscaler)", metric: "Capex", depends: ["NVDA", "ZZZ"], why: "Buys GPUs", evidence: ["N1", "Q9"] }, { symbol: "NVDA" }, { symbol: "MSFT" }, { symbol: "TOO-LONG1" }, { symbol: "ASML", role: "supplier" }] }, doc, { N1: {} });
assert.deepStrictEqual(ch.map((x) => x.symbol), ["MSFT", "ASML"]); assert.strictEqual(ch[0].role, "customer"); assert.strictEqual(ch[0].metric, "capex");
assert.deepStrictEqual(ch[0].depends, ["NVDA"]); assert.deepStrictEqual(ch[0].evidence, ["N1"]); assert.strictEqual(ch[1].metric, "revenue");
const q = (k, rev) => ({ date: `2026-${String(9 - k).padStart(2, "0")}-30`, revenue: rev, reportedCurrency: "USD" });
const income = Array.from({ length: 9 }, (_, k) => ({ ...q(k), date: new Date(Date.UTC(2026, 8 - 3 * k, 30)).toISOString().slice(0, 10), revenue: 100 / Math.pow(1.05, k) }));
const cash = Array.from({ length: 9 }, (_, k) => ({ date: income[k].date, capitalExpenditure: -(20 / Math.pow(1.1, k)) * (k === 0 ? 1.2 : 1), reportedCurrency: "USD" }));
const st = C.partnerStats(income, cash, { closes: Array.from({ length: 260 }, (_, i) => 100 + i) });
assert(Math.abs(st.rev_yoy_q - (Math.pow(1.05, 4) - 1)) < 1e-9 && st.capex_yoy_ttm > 0.4 && st.capex_yoy_q > st.capex_yoy_q_prev && st.r1y > 0 && st.capex_rev > 0);
const parts = [{ ...ch[0], stats: st }, { ...ch[1], stats: { ...st, rev_yoy_ttm: 0.1 } }];
const ag = C.chainAggregate(parts);
assert.strictEqual(ag.customers, 1); assert(Math.abs(ag.customer_capex_growth - st.capex_yoy_ttm) < 1e-9); assert.deepStrictEqual(ag.accelerating, ["MSFT"]); assert.strictEqual(ag.supplier_rev_growth, 0.1);
const dg = C.chainDigest({ partners: parts, aggregate: ag });
assert(dg.includes("Customers' combined capital spending") && dg.includes("MSFT Microsoft (customer") && dg.includes("[N1]") && !dg.includes("undefined") && !/NaN/.test(dg), dg);
// call to call
const tx = [{ id: "T1", symbol: "NVDA", name: "NVIDIA", period: "Q3 FY2027", date: "2026-08-27", excerpt: "Jensen: Demand for Blackwell continues to exceed our supply through the end of the fiscal year and beyond.", prev: { period: "Q2 FY2027", date: "2026-05-28", excerpt: "Jensen: We expect supply constraints to ease gradually over the coming two quarters as capacity comes online." } }, { id: "T2", symbol: "AMD", excerpt: "x" }];
const cp = C.callsPrompt(doc, tx, { today: "2026-10-25" });
assert(cp.includes("LATEST CALL Q3 FY2027") && cp.includes("PREVIOUS CALL Q2 FY2027") && !cp.includes("=== AMD"));
const cc = C.cleanCalls({ summary: { direction: "Improving", text: "Demand firmer [T1]." }, companies: [{ symbol: "nvda", tone: "More confident", guidance: "Raised", quote_now: "Demand for Blackwell continues to exceed our supply through the end of the fiscal year", quote_then: "supply constraints will vanish next week entirely for everyone involved here", new_topics: ["Rubin"] }, { symbol: "AMD", tone: "more cautious" }] }, tx);
assert.strictEqual(cc.companies.length, 1); assert.strictEqual(cc.companies[0].tone, "more confident"); assert.strictEqual(cc.companies[0].guidance, "raised");
assert(cc.companies[0].quote_now.startsWith("Demand for Blackwell") && cc.companies[0].quote_then === "" && cc.quotes_dropped === 1, JSON.stringify(cc));
assert.strictEqual(cc.summary.direction, "improving"); assert.strictEqual(cc.score, 2);
assert(C.callsDigest(cc).includes("NVDA Q2 FY2027 → Q3 FY2027 [T1]: tone more confident"));
console.log("chain tests passed");
