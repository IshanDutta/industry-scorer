const assert = require("assert");
const C = require("./calls.js");
const ok = (c, m) => assert(c, m);

// Spellings, old calls and the five levels
ok(C.norm("bullish") === "slightly bullish" && C.norm("bearish") === "slightly bearish" && C.norm("neutral") === "neutral", "old calls read as slightly");
ok(C.norm("Strongly Bullish") === "strongly bullish" && C.norm("strongly_bearish") === "strongly bearish" && C.norm("very bearish") === "strongly bearish", "spellings");
ok(C.norm("slightly bullish") === "slightly bullish" && C.norm("", "x") === "x" && C.norm("banana", "neutral") === "neutral", "fallback");
ok(C.score("strongly bullish") === 2 && C.score("slightly bearish") === -1 && C.dir("bullish") === 1 && C.dir("neutral") === 0, "scores");
ok(C.cls("strongly bearish") === "neg2" && C.cls("bullish") === "pos" && C.label("slightly bullish") === "Slightly bullish", "display");
// Conviction
ok(C.conviction("high") === 8 && C.conviction("medium") === 5 && C.conviction("low") === 3 && C.conviction(7.4) === 7 && C.conviction("9/10") === 9 && C.conviction(14) === 10 && C.conviction("") === null, "conviction");
// The numbers' call
ok(C.implied({ p: 50, mid: 0.3, sigma: 6 }) === "neutral", "coin flip is neutral");
ok(C.implied({ p: 60, mid: 1, sigma: 6 }) === "slightly bullish", "60% leans bullish");
ok(C.implied({ p: 70, mid: 4, sigma: 6 }) === "strongly bullish", "70% and 0.67 sigma is strong");
ok(C.implied({ p: 70, mid: 0.5, sigma: 6 }) === "slightly bullish", "70% but a range near zero is only slight");
ok(C.implied({ p: 30, mid: -5, sigma: 6 }) === "strongly bearish", "strongly bearish");
ok(C.implied({ p: 52, mid: -3, sigma: 6 }) === "slightly bearish", "flat probability, range off zero leans by the range");
// Reconcile: neutral with a 60% chance of a gain leans; a contradiction flips; an unsupported strong is cut
let r = C.reconcile({ call: "neutral", probability_up: 60, expected_move: [-4, 8] }, 7);
ok(r.call === "slightly bullish" && /neutral/.test(r.fixed), "hidden lean surfaced");
r = C.reconcile({ call: "bullish", probability_up: 35, expected_move: [-8, 1] }, 7);
ok(r.call === "slightly bearish" || r.call === "strongly bearish", "contradiction flips");
r = C.reconcile({ call: "strongly bullish", probability_up: 58, expected_move: [-2, 6] }, 7);
ok(r.call === "slightly bullish" && r.fixed, "unsupported strong cut to slight");
r = C.reconcile({ call: "slightly bullish", probability_up: 62, expected_move: [-2, 6] }, 7);
ok(r.call === "slightly bullish" && !r.fixed, "a consistent call is kept");
r = C.reconcile({ call: "slightly bullish", probability_up: 75, expected_move: [2, 10] }, 6);
ok(r.call === "slightly bullish" && !r.fixed, "a cautious slight call on strong numbers is kept (conviction carries it)");
ok(/strongly bearish/.test(C.rules()) && /1-10/.test(C.rules()) && /"conviction": 6/.test(C.schema), "prompt pieces");

// Horizon.holdCalls: numbers, and conviction 7+ needs history on its side
const H = require("./horizon.js");
const hz = { "1M": { call: "neutral", probability_up: 61, expected_move: [-2, 5], conviction: "medium" }, "3M": { call: "slightly bullish", probability_up: 60, expected_move: [-1, 7], conviction: 8 } };
H.holdCalls(hz, [{ h: "1M", sigma: 5 }, { h: "3M", sigma: 8, like: { pos: 30 } }]);
ok(hz["1M"].call === "slightly bullish" && hz["1M"].model_call === "neutral" && hz["1M"].conviction === 5, "industry neutral leans");
ok(hz["3M"].conviction === 6 && /against history/.test(hz["3M"].conviction_fixed), "conviction capped against history");

// Regimes.company: the company in the industry's episodes
const R = require("./regimes.js");
const dates = [], values = [], sv = [];
for (let i = 0; i < 4000; i++) { const t = new Date(Date.UTC(2010, 0, 4) + i * 864e5); if (t.getUTCDay() % 6 === 0) continue; dates.push(t.toISOString().slice(0, 10)); values.push(100 * Math.exp(i / 3000)); sv.push(100 * Math.exp(i / 4000)); }
const ep = (m) => { const d = dates.filter((x) => x.slice(0, 7) === m).pop(); return { date: d, month: m, industry: { "1M": 1, "3M": 2, "6M": 3, "12M": 5 }, spy: { "1M": 0.5, "3M": 1, "6M": 2, "12M": 4 } }; };
const T = { as_of: "2020-12-31", episodes: [ep("2012-03"), ep("2014-06"), ep("2016-09"), ep("2009-05")], pool_dates: ["2012-03", "2013-01", "2014-06", "2015-02", "2016-09", "2017-04", "2018-01", "2018-08"], base: { "12M": { pos: 70, median: 6 } } };
const co = R.company(T, { dates, closes: values }, { dates, closes: sv });
ok(co && co.episodes.length === 4 && co.episodes[3].traded === false && co.episodes[0].traded === true, "episodes before the stock traded are marked");
ok(co.episodes[0].company["12M"] > 0 && co.base["12M"].n === 8 && co.base["12M"].pos === 100 && co.base["12M"].beat_spy === 100 && co.base["12M"].ind_pos === 70, "company base rates");
ok(co.base["12M"].beat_ind_n === 3 && /\[HE1\]/.test(R.companyText("XYZ", co)) && /wasn't trading yet/.test(R.companyText("XYZ", co)), "company text");
ok(R.company(null, { dates, closes: values }) === null, "no industry episodes, nothing");

// Company.holdCalls
const Co = require("./company.js");
const t = { horizons: { "6M": { call: "bearish", probability_up: 66, expected_move: [1, 9], conviction: "high" } } };
const notes = Co.holdCalls(t, { "6M": 9 }, { base: { "6M": { n: 12, pos: 75 } } });
ok(t.horizons["6M"].call !== "slightly bearish" && Calls_dir(t.horizons["6M"].call) === 1 && notes.length >= 1, "company contradiction fixed");
function Calls_dir(c) { return C.dir(c); }
console.log("calls tests passed");
