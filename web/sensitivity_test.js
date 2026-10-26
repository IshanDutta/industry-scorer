// Tests for measured macro sensitivities: OLS recovers known betas; scaling; stability; digest.
const assert = require("assert");
const S = require("./sensitivity.js");
let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
const N = 300, dates = Array.from({ length: N }, (_, i) => `d${String(i).padStart(4, "0")}`);
const lv = (r) => { const v = [100]; for (let i = 1; i < N; i++) v.push(v[i - 1] * (1 + r[i])); return v; };
const mkt = dates.map(() => rnd() * 0.02), oil = dates.map(() => rnd() * 0.04), usd = dates.map(() => rnd() * 0.01), hy = dates.map(() => rnd() * 0.006);
const dy = dates.map(() => rnd() * 0.1); // daily change in 10Y, pp
const ind = dates.map((_, i) => 1.5 * mkt[i] - 0.04 * dy[i] + 0.1 * oil[i] - 0.5 * usd[i] + 1.0 * hy[i] + rnd() * 0.004);
const y10 = [4.5]; for (let i = 1; i < N; i++) y10.push(y10[i - 1] + dy[i]);
const f = { market: { dates, values: lv(mkt) }, rates: { dates, values: y10 }, oil: { dates, values: lv(oil) }, dollar: { dates, values: lv(usd) }, credit: { dates, values: lv(hy) } };
const m = S.measure({ dates, levels: lv(ind) }, f);
const by = Object.fromEntries(m.factors.map((x) => [x.key, x]));
assert(Math.abs(by.market.partial.beta - 1.5) < 0.05, by.market.partial.beta);
assert(Math.abs(by.rates.partial.beta + 0.04) < 0.01, by.rates.partial.beta);
assert(Math.abs(by.rates.partial.effect - (-0.04 * 0.25)) < 0.003, "per +25bp");
assert(Math.abs(by.oil.partial.beta - 0.1) < 0.03 && Math.abs(by.dollar.partial.beta + 0.5) < 0.15 && Math.abs(by.credit.partial.beta - 1.0) < 0.3);
assert(by.credit.partial.effect < 0, "a fall in high yield hurts a credit-sensitive industry");
assert(m.r2 > 0.9 && m.n === 252 && by.market.stable === true && Math.abs(by.market.partial.t) > 10);
assert.strictEqual(S.strength(3.4), "strong"); assert.strictEqual(S.strength(0.5), "not significant");
const d = S.digest(m);
assert(d.includes("+0.25pp 10-year yield: industry -1.3% in total (clear), -1.0% beyond") && d.includes("MEASURED SENSITIVITIES") && !d.includes("undefined"), d);
// missing factor series are skipped; too little data -> null
const m2 = S.measure({ dates, levels: lv(ind) }, { market: f.market });
assert.strictEqual(m2.factors.length, 1);
assert.strictEqual(S.measure({ dates: dates.slice(0, 30), levels: lv(ind).slice(0, 30) }, f), null);
const flat = S.measure({ dates, levels: lv(ind) }, { ...f, rates: { dates, values: dates.map(() => 4.6) } });
assert(!flat.factors.some((x) => x.key === "rates") && flat.factors.length === 4, "a flat series is left out");
console.log("sensitivity tests passed");
