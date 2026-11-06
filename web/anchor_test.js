// node anchor_test.js: the statistical anchor on made-up industries with a planted momentum effect.
const A = require("./anchor.js");
let fails = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails++; };
let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
// Daily series, 2008-2026; each industry's monthly drift vs the market follows its own last 12 months (momentum).
const days = []; for (let t = Date.UTC(2008, 0, 2); t <= Date.UTC(2026, 10, 5); t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) days.push(d.toISOString().slice(0, 10)); }
const spy = { dates: days, closes: [] }; let s = 100; for (const _ of days) { s *= Math.exp(0.0003 + 0.011 * gauss()); spy.closes.push(s); }
const data = [], series = [];
for (let k = 0; k < 60; k++) {
  const lv = []; let L = 100, drift = 0; const vol = 0.006 + 0.01 * rnd();
  const pe = { dates: days, pe: [] }; let P = 20;
  for (let i = 0; i < days.length; i++) {
    if (i % 21 === 0 && i >= 252) { const m12 = Math.log(lv[i - 21] / lv[i - 252]) - Math.log(spy.closes[i - 21] / spy.closes[i - 252]); drift = 1.0 * m12 / 252; }
    L *= Math.exp(Math.log(spy.closes[i] / (spy.closes[i - 1] || spy.closes[i])) + drift + vol * gauss()); lv.push(L);
    P *= Math.exp(0.003 * gauss()); pe.pe.push(P);
  }
  const ind = { dates: days, levels: lv }, al = A.align(ind, spy, pe);
  series.push(al); data.push({ industry: "I" + k, rows: A.rows(al) });
}
ok(data[0].rows.length > 150 && Object.keys(data[0].rows[20].fwd).length === 4, `monthly rows with features and 4 forward windows (${data[0].rows.length} months)`);
const M = A.fit(data, { asOf: "2026-11-05" });
const h12 = M.horizons["12M"], h1 = M.horizons["1M"];
console.log("   12M weights", h12.rel.w.map((v) => v.toFixed(3)).join(" "), "test", JSON.stringify(h12.test));
console.log("   1M  weights", h1.rel.w.map((v) => v.toFixed(3)).join(" "), "test", JSON.stringify(h1.test));
ok(h12.rel.w[0] > 0 && h12.rel.w[0] >= Math.max(...h12.rel.w.slice(1).map(Math.abs)), "the planted momentum effect is found (positive, the largest weight)");
ok(h12.test.hit_rate > 55 && h12.test.rank_ic > 0.05, `walk-forward test: direction right ${h12.test.hit_rate}% (12M), rank IC ${h12.test.rank_ic}`);
ok(h12.test.in_likely_range > 35 && h12.test.in_likely_range < 65, `the likely range holds about half the outcomes out of sample (${h12.test.in_likely_range}%)`);
const p = A.predict(M, series[3]);
const a = p.horizons["12M"];
console.log("   predict 12M", JSON.stringify({ rel: a.rel, abs: a.abs, sig: a.rel_sigma }));
ok(a.rel.p25 < a.rel.median && a.rel.median < a.rel.p75 && a.rel.prob_beat >= 1 && a.rel.prob_beat <= 99, "a prediction: median inside its likely range, a probability");
ok(p.horizons["1M"].rel.p75 - p.horizons["1M"].rel.p25 < a.rel.p75 - a.rel.p25, "longer windows have wider ranges");
ok(Math.sign(a.rel.median) === Math.sign(p.features.m12) || Math.abs(a.rel.median) < 1, "the anchor leans with momentum here");
ok(/vs the S&P 500 median/.test(A.text(p)) && /tested out of sample/.test(A.text(p)), "prompt text");
ok(A.predict(M, { months: ["2026-10"], ind: [1], spy: [1], pe: [NaN] }) === null, "too little history: no anchor");
console.log(fails ? fails + " FAILED" : "anchor tests passed"); process.exit(fails ? 1 : 0);
