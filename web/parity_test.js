// Compare the JS engine with the Python engine on identical demo data.
// Usage: node web/parity_test.js <fixture.json>
const fs = require("fs");
const E = require("./engine.js");

const fx = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const cfg = { windows: { "1M": 1, "3M": 3, "6M": 6, "1Y": 12 }, minCoverage: 0.9, riskMonths: 12, topN: 50 };
const rfDaily = E.toDailyRf(fx.rf, fx.bench.dates, 0.04);

let checked = 0, failures = 0, worst = 0;
function cmp(where, a, b) {
  checked++;
  const bothMissing = (a === null || Number.isNaN(a) || a === undefined) && (b === null || Number.isNaN(b) || b === undefined);
  if (bothMissing) return;
  if (typeof b === "string" || typeof a === "string") {
    if (a !== b) { failures++; console.log("MISMATCH", where, a, b); }
    return;
  }
  const diff = Math.abs(a - b) / Math.max(1, Math.abs(b));
  worst = Math.max(worst, diff);
  if (!(diff < 1e-9)) { failures++; if (failures < 25) console.log("MISMATCH", where, "js", a, "py", b); }
}

for (const ind of fx.industries) {
  const uni = E.buildUniverse(ind.screener, { topN: 50, includeAdrs: true });
  const res = E.analyzeIndustry(ind.industry, uni, ind.prices, fx.bench, rfDaily, fx.as_of, cfg);
  for (const [k, v] of Object.entries(ind.py_summary)) cmp(`${ind.industry}.summary.${k}`, res.summary[k], v);
  const jsBySym = Object.fromEntries(res.constituents.map((c) => [c.symbol, c]));
  for (const pc of ind.py_constituents) {
    const jc = jsBySym[pc.symbol];
    if (!jc) { failures++; console.log("MISSING constituent", ind.industry, pc.symbol); continue; }
    for (const k of ["rank", "market_cap", "weight", "ret_1M", "ret_3M", "ret_6M", "ret_1Y", "excess_1Y", "beta", "vol_1y", "max_dd_1y"]) {
      cmp(`${ind.industry}.${pc.symbol}.${k}`, jc[k], pc[k]);
    }
  }
  if (res.constituents.length !== ind.py_constituents.length) { failures++; console.log("COUNT", ind.industry); }
  ind.py_index.forEach((v, i) => cmp(`${ind.industry}.index[${i}]`, res.index.levels[i], v));
}
console.log(`checked ${checked} values, ${failures} mismatches, worst relative diff ${worst.toExponential(2)}`);
process.exit(failures ? 1 : 0);
