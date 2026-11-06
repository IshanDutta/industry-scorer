// node lean_test.js: the lean (six-level calls vs the S&P 500 for each timeframe, with the reasons, from every input).
const L = require("./lean.js");
let fails = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails++; };
const res = { headline: "AI capex keeps the cycle up", thesis: "t", opportunity: { verdict: "conditional", headline: "h", why: "w" }, math: { expected_return: 9, prob_loss: 30, reward_risk: 1.4 },
  scenarios: { bull: { probability: 30, price_move: 35 }, base: { probability: 50, price_move: 8 }, bear: { probability: 20, price_move: -25 } },
  horizons: { "1M": { call: "slightly bearish", probability_up: 45 }, "3M": { call: "neutral", probability_up: 58 }, "6M": { call: "strongly bullish" },
    "12M": { call: "slightly bullish", conviction: 6, expected_move: [-6, 22], probability_up: 64, vs_spy: { call: "neutral", expected_excess: [-8, 12], probability_beat: 57 }, drivers: "d" } },
  redteam: { stance: "short", thesis: "x", arguments: [{ severity: "high", claim: "c" }], premortem: [] }, daily: { date: "2026-11-06", headline: "Midterms landed", summary: "s", changes: [] } };
ok(["strongly bearish", "bearish", "slightly bearish", "slightly bullish", "bullish", "strongly bullish"].every((l) => L.level(l) === l) && L.level("Outperform") === "bullish" && L.level("mildly underperform") === "slightly bearish" && L.level("neutral") === null, "six levels, read from any spelling; no neutral");
const p = L.leanPrompt("Semiconductors", { today: "2026-11-06", dossier: "=== QUANT ===\nstuff", res, facts: [], wire: [{ id: "W1", title: "Fed holds" }] });
ok(/RELATIVE TO THE S&P 500/.test(p) && /no neutral/i.test(p) && /\[W1\] Fed holds/.test(p) && L.KEYS.every((k) => p.includes(k)) && /OPPORTUNITY VERDICT.*CONDITIONAL/.test(p), "the prompt: vs the S&P 500, six levels, every input, the lead's verdict");
const ev = (pts) => L.KEYS.map((k, i) => ({ input: L.LABEL[k], points: pts(i), weight: (i % 3) + 1, why: "because [A1] and [ZZ9]" }));
const C = (call, why = "the index is held back by rates [A1]") => ({ call, why, for: ["a [A1]"], against: ["b"], flips_it: "c" });
const a = L.cleanLean({ headline: "Leaning bullish [A1]", evidence: ev((i) => (i < 10 ? "bullish" : "bearish")), calls: { "1M": C("slightly bearish", "near-term the selling continues"), "3M": C("slightly bullish", "then the Q4 prints turn it"), "6M": C("bullish"), "12M": C("Bullish") }, verdict: { agrees: false, why: "the evidence outweighs the conditional verdict" } }, { res, today: "2026-11-06", known: ["A1"] });
ok(a.v === 2 && a.calls["12M"].call === "bullish" && a.calls["1M"].call === "slightly bearish" && a.evidence.length === 15 && !a.missing.length, "cleaned: four calls on the scale, every input matched by its label");
ok(/\[A1\]/.test(a.evidence[0].why) && !/ZZ9/.test(a.evidence[0].why), "unknown citations dropped");
ok(a.consistent && !a.checks.length, "a flip with its reason, on evidence that agrees: no issues " + JSON.stringify(a.checks));
ok(a.verdict.agrees === false, "disagreeing with the lead verdict is kept");
const b = L.cleanLean({ headline: "x", evidence: ev((i) => (i % 2 ? "bullish" : "mixed")), calls: { "1M": C("bullish"), "3M": C("bearish"), "6M": C("strongly bearish"), "12M": C("bearish") } }, { res });
ok(b.checks.some((c) => /tips the other way/.test(c)), "bearish long calls on bullish evidence are flagged");
ok(b.checks.some((c) => /neither says what changes/.test(c)), "a flip with no reason is flagged");
const c = L.cleanLean({ headline: "x", evidence: L.KEYS.map((k, i) => ({ input: k, points: i % 2 ? "bearish" : "bullish", weight: 2 })), calls: { "1M": C("bullish"), "3M": C("bullish"), "6M": C("bullish"), "12M": C("strongly bullish") } });
ok(c.checks.some((t) => /only \d+% one-sided/.test(t)), "\"strongly\" on evenly split evidence is flagged");
ok(L.cleanLean({ calls: { "12M": { call: "neutral" } } }) === null, "no side, no lean");
ok(/problems/.test(L.repairPrompt("Banks", "2026-11-06", b, b.checks)), "repair prompt");
const pv = L.provisional(res, "2026-11-06");
ok(pv.provisional && pv.calls["1M"].call === "slightly bearish" && pv.calls["3M"].call === "slightly bullish" && pv.calls["6M"].call === "strongly bullish" && pv.calls["12M"].call === "slightly bullish", "provisional: earlier calls mapped onto the scale (neutral by the odds): " + L.leanLine(pv));
ok(L.leanOf({ ...res, lean: a }) === a && L.leanOf({ ...res, lean: { lean: "bullish", probability: 60 } }).provisional, "leanOf: this format, else provisional (an older lean is ignored)");
console.log(fails ? fails + " FAILED" : "lean tests passed"); process.exit(fails ? 1 : 0);
