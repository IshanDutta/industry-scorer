// Tests for the track record: snapshot, price lookup, scoring of matured and open calls, summary, digest.
const assert = require("assert");
const T = require("./track.js");
const doc = { as_of: "2026-01-02", constituents: [{ symbol: "A", weight: 0.75, px: 100 }, { symbol: "B", weight: 0.25, px: 50 }, { symbol: "C", weight: 0.01 }] };
const result = { headline: "h", horizons: { "1M": { call: "bullish", expected_move: [2, 8], probability_up: 70 }, "3M": { call: "bearish", expected_move: [-10, -2], probability_up: 30 }, "12M": { call: "neutral", expected_move: [-5, 5], probability_up: 50 } },
  scenarios: { bull: { probability: 30, price_move: [20, 30] }, base: { probability: 50, price_move: [0, 10] }, bear: { probability: 20, price_move: [-30, -20] } }, math: { expected_return: 6 }, opportunity: { verdict: "conditional" } };
const e = T.snapshot(result, doc, "2026-01-02T10:00:00Z");
assert.strictEqual(e.constituents.length, 2, "companies without a price are left out");
assert.deepStrictEqual(Object.keys(e.horizons), ["1M", "3M", "12M"]);
const days = []; for (let t = Date.parse("2026-01-02"); t <= Date.parse("2027-02-01"); t += 864e5) days.push(new Date(t).toISOString().slice(0, 10));
const path = (f) => ({ dates: days, closes: days.map((d, i) => f(i)) });
const series = { A: path((i) => 100 * (1 + 0.0005 * i)), B: path((i) => 50) };
const spy = path((i) => 400 * (1 + 0.0003 * i));
assert.strictEqual(T.priceAt(series.A, "2025-12-01"), NaN);
assert.strictEqual(T.priceAt(series.A, "2026-01-05"), series.A.closes[3]);
// 2 months later: 1M matured, 3M and 12M open
const ev = T.evaluate(e, (s) => series[s], spy, "2026-03-04");
const r1 = (0.75 * (100 * (1 + 0.0005 * 30) / 100 - 1)) * 100;
assert(Math.abs(ev.horizons["1M"].realized - Math.round(r1 * 10) / 10) < 1e-9 && ev.horizons["1M"].matured);
assert.strictEqual(ev.horizons["1M"].hit, true); assert.strictEqual(ev.horizons["1M"].inside, false, "1.1% is below the 2-8% range");
assert(Math.abs(ev.horizons["1M"].brier - 0.09) < 1e-9);
assert.strictEqual(ev.horizons["3M"].matured, false); assert(ev.horizons["3M"].realized > 0 && ev.horizons["3M"].hit === undefined);
assert.strictEqual(ev.scenario, null);
// 13 months later: everything matured, scenario scored
const ev2 = T.evaluate(e, (s) => series[s], spy, "2027-02-01");
assert.strictEqual(ev2.horizons["3M"].hit, false, "bearish but it rose");
assert(ev2.horizons["12M"].matured && ev2.scenario && ev2.scenario.landed === null && ev2.scenario.nearest === "base", JSON.stringify(ev2.scenario));
// low coverage -> not scored
const ev3 = T.evaluate(e, (s) => (s === "B" ? series.B : null), spy, "2027-02-01");
assert.strictEqual(ev3.horizons["12M"].hit, undefined);
const s = T.summarize([{ ...e, eval: ev2 }, { ...e, eval: ev }]);
assert.strictEqual(s.all.n, 4); assert.strictEqual(s.by["3M"].hit_rate, 0); assert(s.pending === 2);
const d = T.digest([{ ...e, eval: ev2 }]);
assert(d.includes("YOUR TRACK RECORD") && d.includes("3 matured horizon calls") && d.includes("Brier") && d.includes("2026-01-02: 1M bullish [2, 8]%") && !d.includes("undefined"), d);
assert.strictEqual(T.digest([]), "");
console.log("track tests passed");
