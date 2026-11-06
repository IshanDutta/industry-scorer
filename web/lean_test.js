// node lean_test.js: the lean (one decisive call per industry from every input).
const L = require("./lean.js");
let fails = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails++; };
const res = { headline: "AI capex keeps the cycle up", thesis: "t", opportunity: { verdict: "conditional", headline: "h", why: "w" }, math: { expected_return: 9, prob_loss: 30, reward_risk: 1.4 },
  scenarios: { bull: { probability: 30, price_move: 35 }, base: { probability: 50, price_move: 8 }, bear: { probability: 20, price_move: -25 } },
  horizons: { "12M": { call: "slightly bullish", conviction: 6, expected_move: [-6, 22], probability_up: 64, vs_spy: { call: "slightly bullish", expected_excess: [-8, 12], probability_beat: 57 }, drivers: "d" } },
  redteam: { stance: "short", thesis: "x", arguments: [{ severity: "high", claim: "c" }], premortem: [] }, daily: { date: "2026-11-06", headline: "Midterms landed", summary: "s", changes: [] } };
const txt = L.analysisText(res);
ok(/OPPORTUNITY VERDICT.*CONDITIONAL/.test(txt) && /vs the S&P 500: slightly bullish/.test(txt) && /RED TEAM/.test(txt) && /LATEST UPDATE \(2026-11-06\)/.test(txt), "the prompt shows the lead's verdict, the calls vs the S&P 500, the red team and the latest update");
const p = L.leanPrompt("Semiconductors", { today: "2026-11-06", dossier: "=== QUANT ===\nstuff", res, facts: [], wire: [{ id: "W1", title: "Fed holds" }] });
ok(/WHICH WAY DOES IT LEAN/.test(p) && /No "neutral"/.test(p) && /\[W1\] Fed holds/.test(p) && L.KEYS.every((k) => p.includes(k)), "the prompt asks for a side and names every input");
const ev = (pts) => L.KEYS.map((k, i) => ({ input: L.LABEL[k], points: pts(i), weight: (i % 3) + 1, why: `because [A1] and [ZZ9]` }));
const a = L.cleanLean({ lean: "Bullish", absolute: "up", probability: 66, horizon: "12m", headline: "Leaning bullish [A1]", summary: "s", evidence: ev((i) => (i < 10 ? "bullish" : "bearish")), verdict: { agrees: false, why: "the evidence outweighs the conditional verdict" }, decides_it: "Q4 capex guides", flips_it: ["a", "b"] }, { res, today: "2026-11-06", known: ["A1"] });
ok(a.lean === "bullish" && a.horizon === "12M" && a.strength === "clear" && a.evidence.length === 15 && !a.missing.length, "cleaned: side, horizon, strength, every input matched by its label");
ok(a.evidence[0].why === "because [A1] and" || /\[A1\]/.test(a.evidence[0].why) && !/ZZ9/.test(a.evidence[0].why), "unknown citations are dropped: " + a.evidence[0].why);
ok(a.tally.score > 0 && a.consistent && !a.checks.length, "evidence tally agrees with the lean: score " + a.tally.score);
ok(a.verdict.agrees === false && /outweighs/.test(a.verdict.why), "disagreeing with the lead verdict is kept");
const b = L.cleanLean({ lean: "bearish", probability: 80, horizon: "12M", headline: "x", evidence: ev((i) => (i % 2 ? "bullish" : "mixed")) }, { res });
ok(b.checks.some((c) => /tips the other way/.test(c)) && !b.consistent, "a bearish lean on bullish evidence is flagged");
ok(b.checks.some((c) => /57% chance of beating/.test(c)), "a lean against its own 12M call vs the S&P 500 is flagged");
const c = L.cleanLean({ lean: "bullish", probability: 80, horizon: "12M", headline: "x", evidence: L.KEYS.map((k, i) => ({ input: k, points: i % 2 ? "bearish" : "bullish", weight: 2 })) }, { res });
ok(c.checks.some((t) => /only \d+% one-sided/.test(t)), "an 80% lean on evenly split evidence is flagged");
ok(L.cleanLean({ lean: "bullish", probability: 30, headline: "h" }).probability === 51 && L.cleanLean({ lean: "bullish", probability: 99, evidence: [{ input: "macro", points: "bullish" }] }).probability === 85, "probabilities held to 51-85");
ok(L.cleanLean({ lean: "neutral", evidence: [] }) === null, "no side, no lean");
ok(/contradictions/.test(L.repairPrompt("Banks", "2026-11-06", b, b.checks)), "repair prompt");
const pv = L.provisional(res, "2026-11-06");
ok(pv.provisional && pv.lean === "bullish" && pv.probability === 57 && pv.horizon === "12M", "provisional lean read off the 12M call vs the S&P 500");
const pv2 = L.provisional({ opportunity: { verdict: "no" }, horizons: { "12M": { call: "neutral", probability_up: 70 } } });
const pv3 = L.provisional({ opportunity: { verdict: "conditional" }, horizons: { "12M": { call: "slightly bullish", probability_up: 52 } } });
ok(pv2.lean === "bearish" && pv2.probability === 51 && pv3.lean === "bullish" && pv3.probability === 53, "without a view vs the S&P 500: the 12M call's direction, a neutral one by the verdict");
ok(L.leanOf({ ...res, lean: a }) === a && /Bullish vs the S&P 500 \(66%, 12M\)/.test(L.leanLine(a)), "leanOf prefers the strategist's lean; one-line text");
console.log(fails ? fails + " FAILED" : "lean tests passed"); process.exit(fails ? 1 : 0);
