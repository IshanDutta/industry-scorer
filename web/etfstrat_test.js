const assert = require("assert");
const S = require("./etfstrat.js"), R = require("./etfrec.js");
const FX = JSON.parse(require("fs").readFileSync(__dirname + "/fixtures/funds.json"));
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;

// 1. industries from real digests: market weights, conviction, target distribution
for (const type of ["growth", "income", "conservative", "aggressive"]) {
  const goal = R.goalOf({ type, horizon: "12M" }), eq = 1 - (type === "income" ? 0.45 : type === "conservative" ? 0.55 : type === "growth" ? 0.1 : 0.05);
  const rows = S.conviction(S.industryRows(FX.digests, goal), goal, { now: "2026-11-10" });
  assert(rows.length > 10 && near(rows.reduce((a, r) => a + r.mkt, 0), 1, 1e-9));
  assert(rows.every((r) => Number.isFinite(r.z)) && rows.some((r) => r.reasons.length));
  const t = S.targetIndustries(rows, goal, eq);
  const sum = t.held.reduce((a, x) => a + x.target, 0); assert(near(sum, eq, 1e-6), type + " targets sum to the stock sleeve: " + sum);
  assert(t.held.every((x) => x.target <= goal.industryCap + 1e-6), type + " industry cap");
  const sec = {}; for (const x of t.held) sec[x.sector] = (sec[x.sector] || 0) + x.target; assert(Object.values(sec).every((v) => v <= goal.sectorCap + 1e-6), type + " sector cap " + JSON.stringify(sec));
  assert(t.held.every((x) => x.target >= 0.01 - 1e-9) && t.held.length >= 5, type + " breadth " + t.held.length);
  if (type === "growth") console.log("growth targets", t.held.slice(0, 6).map((x) => `${x.name} ${(x.target * 100).toFixed(1)} (mkt ${(x.market * 100).toFixed(1)}, z ${x.z.toFixed(2)})`).join("; "), "| avoided", t.avoided.slice(0, 3).map((x) => x.name).join(", "));
}
// tilts follow conviction: the highest-conviction industry gains on its market weight
{ const goal = R.goalOf({ type: "growth" }), rows = S.conviction(S.industryRows(FX.digests, goal), goal), t = S.targetIndustries(rows, goal, 1);
  const hi = rows.slice().sort((a, b) => b.z - a.z)[0], lo = rows.slice().sort((a, b) => a.z - b.z)[0];
  const th = t.rows.find((x) => x.name === hi.name), tl = t.rows.find((x) => x.name === lo.name); assert(th.target / Math.max(th.market, 1e-9) > tl.target / Math.max(tl.market, 1e-9)); }

// 2. bonds: band and curve
const curve = { month3: 4.3, year2: 4.73, year5: 4.81, year10: 4.98, year30: 5.35 };
const sl = S.bondSleeve(R.goalOf({ type: "conservative" }), curve, 0.5); assert(near(Object.values(sl.buckets).reduce((a, x) => a + x, 0), 0.5, 1e-9));
const thin = S.bondSleeve(R.goalOf({ type: "growth" }), curve, 0.1); assert(Object.values(thin.buckets).every((v) => v >= 0.03 - 1e-9) && near(Object.values(thin.buckets).reduce((a, x) => a + x, 0), 0.1), "small buckets fold");
const inv = S.bondSleeve(R.goalOf({ type: "conservative" }), { month3: 5, year10: 4, year2: 4.5, year30: 4.2 }, 0.5); assert(inv.buckets.inter < sl.buckets.inter && /inverted/.test(inv.notes.join(" ")));
assert.strictEqual(S.bucketOf(R.BY.get("TLT")), "long"); assert.strictEqual(S.bucketOf(R.BY.get("SHY")), "short"); assert.strictEqual(S.bucketOf(R.BY.get("LQD")), "ig");

// 3. companies: ranking for the profile, strategist picks and avoids
const rank = [{ symbol: "A", weight: 0.4, composite: 60, by_profile: { growth: 55 } }, { symbol: "B", weight: 0.3, composite: 70, by_profile: { growth: 80 } }, { symbol: "C", weight: 0.2, composite: 50, by_profile: { growth: 45 } }, { symbol: "D", weight: 0.1, composite: 40, by_profile: { growth: 90 } }];
const pk = S.pickCompanies(rank, { type: "growth" }, { k: 3, best: [{ symbol: "C", why: "best expression" }], avoid: [{ symbol: "D", why: "bad" }] });
assert.deepStrictEqual(pk.picks.map((p) => p.symbol), ["B", "C", "A"]); assert(near(pk.picks.reduce((a, p) => a + p.within, 0), 1) && pk.avoided[0].symbol === "D" && pk.picks[1].strategist === "best expression");
const T = S.companyTargets([{ name: "X", target: 0.2 }], { X: pk }); assert(near(Object.values(T).reduce((a, x) => a + x, 0), 0.2));

// 4. discovery: US ETFs only, no mutual funds, no single-stock funds, sized from position values
const exps = { B: [{ symbol: "AAA", weightPercentage: 5, marketValue: 5e7 }, { symbol: "BBBBX", weightPercentage: 5, marketValue: 5e8 }, { symbol: "LEV", weightPercentage: 150, marketValue: 1e9 }, { symbol: "ZZ.TO", weightPercentage: 5, marketValue: 1e9 }, { symbol: "TINY", weightPercentage: 5, marketValue: 1e6 }],
  C: [{ symbol: "AAA", weightPercentage: 3, marketValue: 3e7 }, { symbol: "CCC", weightPercentage: 1, marketValue: 1e8 }] };
const d = S.discover(exps, T); assert.deepStrictEqual(d.map((x) => x.symbol).sort(), ["AAA", "CCC"]); assert(near(d.find((x) => x.symbol === "AAA").aum, 1e9) && near(d[0].purity, 0.08));

// 5. vectors, overlap, the mix
const v1 = S.vectors([{ ticker: "A", weight: 50, industry: "X", kind: "stock" }, { ticker: "B", weight: 50, industry: "Y", kind: "stock" }]), v2 = S.vectors([{ ticker: "B", weight: 30, industry: "Y", kind: "stock" }, { ticker: "C", weight: 70, industry: "Z", kind: "stock" }]);
assert(near(v1.ind.X, 0.5) && near(S.overlap(v1.cos, v2.cos), 0.3) && near(v1.effN, 2));
// eight stock ETFs on distinct industries plus two bond ETFs; target wants X, Y, Z, W and a bond sleeve
const inds = ["X", "Y", "Z", "W", "V", "U", "Q", "P"], cands = inds.map((k, i) => ({ symbol: "E" + k, vec: { ind: { [k]: 0.8, Other: 0.2 }, cos: { [k + "1"]: 0.3, [k + "2"]: 0.2, SHARED: i < 3 ? 0.3 : 0 } }, mu: 0.08, expense: 0.002 }))
  .concat([{ symbol: "BND1", isBond: true, bucket: "inter", mu: 0.045, expense: 0.0005 }, { symbol: "BND2", isBond: true, bucket: "ig", mu: 0.05, expense: 0.001 }, { symbol: "BND3", isBond: true, bucket: "inter", mu: 0.044, expense: 0.0004 }, { symbol: "BND4", isBond: true, bucket: "short", mu: 0.042, expense: 0.0004 }]);
const k = cands.length, cov = cands.map((a, i) => cands.map((b, j) => (i === j ? (a.isBond ? 0.004 : 0.04) : a.isBond || b.isBond ? 0.0005 : 0.015)));
const goal = { ...R.goalOf({ type: "conservative" }), maxN: 10 };
const target = { industries: { X: 0.12, Y: 0.12, Z: 0.1, W: 0.08, V: 0.04, U: 0.04 }, buckets: { inter: 0.3, ig: 0.2 }, companies: { X1: 0.05, Y1: 0.05, Z1: 0.04 } };
const sel = S.mix(cands, target, cov, goal);
assert(near(sel.w.reduce((a, x) => a + x, 0), 1, 1e-6) && sel.w.every((x) => x <= 0.15 + 1e-9), JSON.stringify(sel.w));
assert(sel.w.filter((x) => x > 0).every((x) => x >= 0.03 - 1e-9) && sel.w.filter((x) => x > 0).length >= 7);
const bonds = sel.w[8] + sel.w[9] + sel.w[10] + sel.w[11]; assert(bonds >= goal.bonds[0] - 0.01 && bonds <= goal.bonds[1] + 0.01, "bond band " + bonds);
assert(sel.w[6] + sel.w[7] <= sel.w[0] + sel.w[1], "untargeted industries get less than targeted ones");
const ach = S.achieved(sel.w, cands, target, []); assert(ach.tracking >= 0 && ach.tracking < 0.5 && ach.capture > 0 && ach.pairs.length);
// overlap penalty: two ETFs sharing most stocks are not both bought heavily when one would do
const dupC = [{ symbol: "A1", vec: { ind: { X: 1 }, cos: { a: 0.5, b: 0.5 } }, mu: 0.08 }, { symbol: "A2", vec: { ind: { X: 1 }, cos: { a: 0.5, b: 0.5 } }, mu: 0.08 }, ...inds.slice(1).map((k2) => ({ symbol: "E" + k2, vec: { ind: { [k2]: 1 }, cos: { [k2]: 1 } }, mu: 0.08 }))];
const dc = dupC.map((a, i) => dupC.map((b, j) => (i === j ? 0.04 : 0.01))); const sd = S.mix(dupC, { industries: Object.fromEntries(["X", ...inds.slice(1)].map((k2) => [k2, 1 / 8])), buckets: {}, companies: {} }, dc, { ...R.goalOf({ type: "growth" }), vol: 1 }, { gamma: 2 });
assert(sd.w[0] + sd.w[1] <= 0.15 + 0.03, "duplicates share the industry's weight instead of doubling it: " + (sd.w[0] + sd.w[1]));

// 6. opportunities and the dossier
const g2 = R.goalOf({ type: "growth" }), rows2 = S.conviction(S.industryRows(FX.digests, g2), g2), t2 = S.targetIndustries(rows2, g2, 0.9);
const opps = S.opportunities(rows2, t2, {}, g2, { today: "2026-11-10", etfFor: () => [{ symbol: "SMH", purity: 0.8 }] }); assert(opps.length >= 3 && opps[0].kind === "conviction");
const ds = S.dossier({ goal: g2, curve, rows: rows2, tgt: t2, sleeve: S.bondSleeve(g2, curve, 0.1), picksBy: {}, sel, ach, cands, target, opps });
const ids = S.idsOf(ds.text); assert(ids.includes("G1") && ids.includes("I1") && ids.includes("A1") && ids.includes("O1") && ids.includes("E1"));
for (const p of Object.keys(S.PARTS)) assert(/Return JSON only/.test(S.prompt(p, g2, ds.text)));
const al = S.clean("allocation", { headline: "x [I1] [Z9]", industries: [{ id: "I1", stance: "Overweight", why: "y [I1]" }, { id: "Q1" }], horizons: { "1M": { call: "Bullish" } }, scenarios: { bull: { probability: 30 } } }, ids);
assert(al.headline === "x [I1]" && al.industries.length === 1 && al.industries[0].stance === "overweight" && al.horizons["1M"].call === "bullish");
console.log("etfstrat tests passed", JSON.stringify({ n: sel.w.filter((x) => x > 0).length, bonds: +bonds.toFixed(2), tracking: +ach.tracking.toFixed(3), capture: +ach.capture.toFixed(2), opps: opps.length }));
