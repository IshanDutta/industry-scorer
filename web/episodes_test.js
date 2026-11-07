// node episodes_test.js: times like this for one company (period, chart vs its industry and the S&P 500, next 1M-12M).
const E = require("./episodes.js");
let fails = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails++; };
const days = []; for (let t = Date.UTC(2015, 0, 2); t <= Date.UTC(2026, 10, 6); t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) days.push(d.toISOString().slice(0, 10)); }
const mk = (f) => ({ dates: days, values: days.map((_, i) => 100 * Math.exp(f * i)) });
const spy = mk(0.0003), ind = mk(0.0006), co = { dates: days.slice(1500), values: days.slice(1500).map((_, i) => 50 * Math.exp(0.0002 * i)) };
const eps = [{ id: "HE1", date: "2022-06-30", month: "2022-06", similarity: 90, industry: { "12M": 9 } }, { id: "HE2", date: "2016-03-31", month: "2016-03", similarity: 80, industry: { "12M": 7 } }, { id: "HE3", date: "2026-08-31", month: "2026-08" }];
const cards = E.build({ episodes: eps, hist: [{ month: "2022-06", then: "Bear market", after: "Rebound", different: "Rates" }], co, ind, spy, today: "2026-11-06" });
const a = cards[0], b = cards[1], c = cards[2];
ok(cards.length === 3 && a.period === "Jun 2022 – Jun 2023" && a.then === "Bear market" && a.chart.k0 === 63, "period, the historian's words, and the setup day 3 months into the chart: " + a.period);
ok(a.chart.co[a.chart.k0] === 100 && a.chart.ind[a.chart.k0] === 100 && a.chart.spy[a.chart.k0] === 100 && a.chart.dates.length === 63 + 253, "all three lines rebased to 100 on the setup day, 3 months before to 12 after");
ok(a.traded && a.R["12M"].ind > a.R["12M"].co && a.R["12M"].gap < 0 && a.R["12M"].spy > 0, "next 12M for each, and the company's gap to its industry: " + JSON.stringify(a.R["12M"]));
ok(!b.traded && b.chart.co === null && b.R["12M"].co === null && b.R["12M"].ind !== null, "before the company listed: no company line, the industry and S&P 500 still shown");
ok(c.ongoing && c.R["12M"].ind === null && /Nov 2026/.test(c.period), "a setup less than a year ago runs to today");
const S = E.summary(cards);
ok(S["12M"].n === 1 && S["12M"].beat === 0 && S["1M"].n === 2, "summary: beat its industry in x of n, per window: " + JSON.stringify(S["12M"]));
console.log(fails ? fails + " FAILED" : "episodes tests passed"); process.exit(fails ? 1 : 0);
