// node horizon_anchor_test.js: calls blended with the statistical anchor, the view vs the S&P 500, consistency checks,
// the repair merge and the scorecard.
const H = require("./horizon.js"), T = require("./track.js");
let fails = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails++; };
const A12 = { rel: { median: 2, p25: -8, p75: 12, prob_beat: 56 }, abs: { median: 8, p25: -6, p75: 22, prob_up: 66 }, rel_sigma: 15, test: { hit_rate: 55, base_hit_rate: 50, in_likely_range: 50, from: 2013 } };
// A wild strategist call: -10 to +30, 75% up, no view vs the market.
const x = { call: "strongly bullish", expected_move: [-10, 30], probability_up: 75, conviction: 7 };
H.blendWithAnchor(x, A12, 0.5);
console.log("   blended", JSON.stringify({ em: x.expected_move, p: x.probability_up, vs: x.vs_spy, a: { m: x.anchor.moved_abs, r: x.anchor.moved_rel } }));
ok(x.model.expected_move.join() === "-10,30" && x.model.probability_up === 75, "the strategist's own numbers are kept");
ok(x.expected_move[0] === -5 && x.expected_move[1] === 23, "center halfway to the anchor (+8 and +10 -> +9), width the anchor's tested width (±14, not the strategist's ±20): " + x.expected_move.join(" to "));
ok(x.probability_up === 71, "probability blended halfway (66 -> 75): " + x.probability_up);
ok(x.vs_spy && x.vs_spy.expected_excess.length === 2 && x.vs_spy.probability_beat > 50 && x.vs_spy.call !== "neutral", "a view vs the S&P 500 is filled in from the absolute view and the anchor: " + JSON.stringify(x.vs_spy));
const far = { call: "strongly bullish", expected_move: [40, 80], probability_up: 95 }; H.blendWithAnchor(far, A12, 0.5);
ok(far.expected_move[0] + far.expected_move[1] <= 2 * (8 + 14) + 0.2 && far.probability_up <= 81, "never further than the anchor's likely range from it, probability within 15 pts: " + far.expected_move.join(" to ") + ", " + far.probability_up + "%");
const w8 = { call: "slightly bullish", expected_move: [10, 20], probability_up: 70 }; H.blendWithAnchor(w8, A12, 0.8);
ok((w8.expected_move[0] + w8.expected_move[1]) / 2 > (x.expected_move[0] + x.expected_move[1]) / 2, "a strategist with a better record gets more weight");
// holdCalls with facts
const hz = { "1M": { call: "slightly bullish", expected_move: [-2, 6], probability_up: 58, conviction: 5, drivers: "a" }, "3M": { call: "slightly bearish", expected_move: [-9, 3], probability_up: 42, conviction: 5, drivers: "b" } };
const A1 = { rel: { median: 0.5, p25: -3, p75: 4, prob_beat: 52 }, abs: { median: 1, p25: -4, p75: 6, prob_up: 56 }, rel_sigma: 5 }, A3 = { rel: { median: 1, p25: -5, p75: 7, prob_beat: 54 }, abs: { median: 2.5, p25: -6, p75: 11, prob_up: 59 }, rel_sigma: 9 };
const facts = [{ h: "1M", sigma: 8, anchor: A1, blend: 0.5 }, { h: "3M", sigma: 14, anchor: A3, blend: 0.5 }];
H.holdCalls(hz, facts);
ok(hz["1M"].anchor && hz["3M"].anchor && hz["1M"].vs_spy, "holdCalls blends every window that has an anchor");
const ck = H.horizonChecks(hz, facts, null);
console.log("   3M after blend", JSON.stringify({ c: hz["3M"].call, em: hz["3M"].expected_move, p: hz["3M"].probability_up }), "issues", JSON.stringify(H.issuesOf(ck)));
const flip = { "1M": { call: "slightly bullish", expected_move: [1, 6], probability_up: 60, conviction: 6, drivers: "x" }, "3M": { call: "slightly bearish", expected_move: [-8, -1], probability_up: 38, conviction: 6, drivers: "y" } };
ok(H.issuesOf(H.horizonChecks(flip, [{ h: "1M", sigma: 8 }, { h: "3M", sigma: 14 }], null)).some((t) => /flips/.test(t)), "a direction that flips between windows with no reason is flagged");
flip["3M"].drivers = "a near-term bounce, then the decline resumes";
ok(!H.issuesOf(H.horizonChecks(flip, [{ h: "1M", sigma: 8 }, { h: "3M", sigma: 14 }], null)).some((t) => /flips/.test(t)), "with its reason it isn't");
const bad = { "12M": { call: "slightly bullish", expected_move: [0, 20], probability_up: 60, vs_spy: { expected_excess: [-30, -20], probability_beat: 20, call: "strongly bearish" } } };
ok(H.issuesOf(H.horizonChecks(bad, [{ h: "12M", sigma: 30, anchor: A12 }], null)).some((t) => /imply the S&P 500 moves/.test(t)), "absolute and vs-S&P views that imply an absurd market move are flagged");
// Repair merge
const rep = H.mergeRepair(flip, { "3M": { call: "slightly bullish", expected_move: [-2, 7], probability_up: 57, vs_spy: { expected_excess: [-3, 4], probability_beat: 53, call: "slightly bullish" }, drivers: "aligned" } });
ok(rep["3M"].call === "slightly bullish" && rep["3M"].expected_move.join() === "-2,7" && rep["3M"].vs_spy.probability_beat === 53 && rep["3M"].model === null && rep["1M"] === flip["1M"], "the repair replaces only the windows it returns, and they're blended again");
ok(/contradictions/.test(H.repairPrompt("Banks", "2026-11-06", flip, ["3M: x"], facts)), "repair prompt");
// Facts carry the anchor and the scorecard
const doc = { summary: {}, index: { levels: Array.from({ length: 260 }, (_, i) => 100 + Math.sin(i / 5) * 3) }, history: { anchor: { horizons: { "12M": { ...A12, drivers: [{ label: "momentum", push: 2 }] } } } }, scorecard: { by: { "12M": { n: 40, hit: 55, beat_hit: 58, anchor_hit: 54, in_range: 49 } }, blend: { "12M": 0.58 } } };
const f12 = H.horizonFacts(doc, "2026-11-06").find((f) => f.h === "12M");
ok(f12.anchor?.rel?.median === 2 && f12.blend === 0.58 && f12.score?.n === 40 && /STATISTICAL ANCHOR/.test(H.factsLine(f12)), "facts carry the anchor, the blend weight and the scorecard");
// Scorecard
const ent = (beat, anc) => ({ eval: { horizons: { "12M": { matured: true, hit: beat, inside: beat, beat_hit: beat, anchor_hit: anc } } } });
const few = T.scorecard([ent(true, false)]);
ok(few.by["12M"].n === 1 && few.blend["12M"] === 0.5, "under 30 matured calls the blend stays half and half");
const many = T.scorecard([...Array(24).fill(0).map(() => ent(true, false)), ...Array(16).fill(0).map(() => ent(false, true))]);
ok(many.by["12M"].beat_hit === 60 && many.by["12M"].anchor_hit === 40 && Math.abs(many.blend["12M"] - 0.8) < 1e-9, "a strategist who beats the anchor earns weight (60% vs 40% -> 0.8)");
console.log(fails ? fails + " FAILED" : "horizon anchor tests passed"); process.exit(fails ? 1 : 0);
