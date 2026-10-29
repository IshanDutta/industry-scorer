// Tests for long history and base rates: series from exchange rows, drawdowns, analogs, valuation, seasonality, regime, peers, digest.
const assert = require("assert");
const Hs = require("./history.js");
let seed = 11; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
const days = []; for (let t = Date.parse("2008-01-02"); t <= Date.parse("2026-10-23"); t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) days.push(d.toISOString().slice(0, 10)); }
// A cycle: rise, 40% crash in 2008, recovery, steady drift
const r = days.map((d, i) => (d < "2009-03-01" ? -0.002 : d < "2010-06-01" ? 0.003 : 0.0004) + rnd() * 0.02);
const perf = days.flatMap((d, i) => [{ date: d, exchange: "NASDAQ", averageChange: (r[i] + 0.001) * 100 }, { date: d, exchange: "NYSE", averageChange: (r[i] - 0.001) * 100 }]);
perf.push({ date: days[5], exchange: "NYSE", averageChange: 900 }); // a bad tick gets clamped
const s = Hs.levelSeries(perf);
const sw = Hs.levelSeries(perf, { NASDAQ: 3, NYSE: 1 }); assert(Math.abs(sw.rets[100] - (r[100] + 0.0005)) < 1e-12, "cap-weighted mix of exchanges");
assert.strictEqual(s.dates.length, days.length); assert(Math.abs(s.rets[100] - r[100]) < 1e-12, "mean across exchanges");
assert(s.rets[5] < 0.25 + 1e-9);
const dd = Hs.drawdowns(s);
assert(dd.episodes.length >= 1 && dd.episodes[0].peak < "2009-01-01" && dd.episodes[0].depth <= -0.2 && dd.episodes[0].recovered, JSON.stringify(dd.episodes[0]));
const an = Hs.analogs(s);
assert(an.n >= 30 && an.n <= 40 && an.horizons["12M"].n > 10 && an.all["1M"].n > 500);
for (let i = 1; i < an.dates.length; i++) assert(an.dates[i] > an.dates[i - 1]);
const pes = { dates: days.filter((d) => d >= "2010-01-01"), pe: [] }; pes.pe = pes.dates.map((_, i) => 15 + 10 * Math.sin(i / 400));
const v = Hs.valuation(s, pes);
assert(v.percentile >= 0 && v.percentile <= 1 && v.fwd12_similar.n > 20 && v.quintiles.length === 4);
const se = Hs.seasonality(s); assert.strictEqual(se.length, 12); assert(se.every((m) => m.n >= 17));
const ief = { dates: days, closes: days.map((_, i) => 100 + 10 * Math.sin(i / 300)) };
const rr = Hs.rateRegime(s, ief); assert(rr.now && rr.by["yields rising"].n > 10 && rr.by["yields falling"].n > 10);
const idx = { dates: days.slice(-260), levels: s.levels.slice(-260).map((x) => x * 3) };
assert(Math.abs(Hs.tracking(s, idx).corr - 1) < 1e-9, "same returns correlate perfectly");
const b = Hs.build({ perfRows: perf, peRows: pes.dates.map((d, i) => ({ date: d, exchange: "NASDAQ", pe: pes.pe[i] })).concat([{ date: "2020-01-02", exchange: "NYSE", pe: 99 }]), primary: "NASDAQ", ief, index: idx });
assert(b.valuation.high < 26 && b.base_prob_up["12M"] > 0 && b.base_prob_up["12M"] < 1);
assert.deepStrictEqual(Hs.peSeries([{ date: "2020-01-01", exchange: "NASDAQ", pe: 0 }, { date: "2020-01-02", exchange: "NASDAQ", pe: 20 }], "NASDAQ").pe, [20]);
// peers
const yr = (k) => days.slice(-260).map((d) => ({ date: d, exchange: "NASDAQ", averageChange: k }));
const pt = Hs.peerTable([{ industry: "Semis", rows: yr(0.1), pe: { NASDAQ: 40, NYSE: 30 }, total_market_cap: 9 }, { industry: "Software", rows: yr(0.05), pe: { NASDAQ: 50 }, total_market_cap: 10 }, { industry: "Hardware", rows: yr(-0.02), pe: { NYSE: 20 }, total_market_cap: 3 }], "Semis");
assert.strictEqual(pt.rows[0].industry, "Software"); assert.deepStrictEqual(pt.rank_r1y, { rank: 1, of: 3 }); assert.deepStrictEqual(pt.rank_pe_cheapest, { rank: 2, of: 3 });
assert(Math.abs(pt.rows.find((x) => x.self).pe - 35) < 1e-9);
const d = Hs.digest(b, pt, { symbol: "XLK", r3m: 0.05, r1y: 0.2, vs_r3m: 0.01, vs_r1y: 0.03 });
assert(d.includes("LONG HISTORY AND BASE RATES") && d.includes("Drawdowns of 20%+") && d.includes("Setups most like today") && d.includes("percentile of its history") && d.includes("SECTOR PEERS") && d.includes("**Semis**") && d.includes("Sector ETF XLK") && d.includes("Base-rate chance") && !d.includes("undefined") && !/NaN/.test(d), d);
assert.strictEqual(Hs.build({ perfRows: perf.slice(0, 100) }), null);
// Calendar-date trailing returns survive missing days, and 6M is there
{
  const dates = [], closes = []; let v = 100; const t = new Date("2025-10-01T00:00:00Z");
  for (let k = 0; k < 400; k++) { const d = t.toISOString().slice(0, 10); if (k % 7 !== 5 && k % 7 !== 6 && k % 11 !== 3) { dates.push(d); closes.push(v); } v *= 1.001; t.setUTCDate(t.getUTCDate() + 1); }
  const ser = { dates, closes };
  const r6 = Hs.trailingByDate(ser, null, 6), r12 = Hs.trailingByDate(ser, null, 12), r1 = Hs.trailingByDate(ser, null, 1);
  assert(isFinite(r1) && isFinite(r6) && isFinite(r12) && r12 > r6 && r6 > r1, "1M < 6M < 1Y on a rising series with gaps");
  assert(Number.isNaN(Hs.trailingByDate({ dates: dates.slice(-100), closes: closes.slice(-100) }, null, 12)), "NaN when the series doesn't reach back");
  const rows = [{ industry: "A & B", rows: dates.map((d, k) => ({ date: d, exchange: "NYSE", averageChange: 0.1 })), weights: { NYSE: 1 }, companies: 20 }];
  const pt = Hs.peerTable(rows, "A & B"); assert(isFinite(pt.rows[0].r6m) && isFinite(pt.rows[0].r1y), "peer table has 6M and 1Y");
}
console.log("history tests passed");
