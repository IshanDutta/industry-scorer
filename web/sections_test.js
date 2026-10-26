// Tests for the section pillars and their effect on the scores.
const assert = require("assert");
const Sec = require("./sections.js");
const Score = require("./score.js");

const doc = { name: "Semis", summary: { excess_cw_1Y: 0.1, beta: 1.4, vol_1y: 0.35, top5_weight: 0.7 }, fund: { rev_growth: 0.3, op_margin: 0.3, pe: 30 },
  constituents: [{ symbol: "A", weight: 0.7 }, { symbol: "B", weight: 0.3 }] };
const good = {
  doc, pack: { sentiment: { last_7d: 0.3, prior_30d: 0.2 }, analyst: [{ symbol: "A", buy: 9, hold: 1, sell: 0, upside: 0.2 }, { symbol: "B", buy: 5, hold: 5, sell: 0, upside: 0.05 }] },
  kpi: { cycle_position: "expansion", pricing_power: { level: "strong" }, unit_economics: { operating_leverage: "high" }, demand_drivers: [{ direction: "accelerating" }, { direction: "rising" }], supply_drivers: [{ direction: "tight" }],
    management_signals: [{ tone: "positive" }, { tone: "positive" }, { tone: "neutral" }], hot_segments: [{}, {}], cool_segments: [{}] },
  macro: { regime: "SUPPORTIVE", confidence: "high", horizons: { "1M": { call: "MIXED" }, "12M": { call: "SUPPORTIVE" } }, indicators: { I1: { relevance: "high", effect: "tailwind" }, I2: { relevance: "low", effect: "headwind" } } },
  world: { scout: { situations: [{ title: "Truce", relevance: "high" }] }, dives: [{ title: "Truce", stance: "supportive", status: "de-escalating", scenarios: [{ probability: 60, earnings: "+5%" }, { probability: 40, earnings: "-2%" }] }] },
  trade: { verdict: { rating: "manageable", health: { score: 70 }, investment_read: { pass_through: "full", derate_risk: "low" }, bottlenecks: [] }, map: { countries: [{ importance: "high", stance: "allied", trajectory: "improving" }] } },
  reg: { policy: [{ direction: "tailwind" }], litigation: [], perception: { trend: "improving" } }, regVerdict: { stance: "tailwind", intensity: "medium" }, books: [{ rules: [{ status: "in_force", severity: "low" }] }],
  lead: { scenarios: { bull: { probability: 40 }, base: { probability: 45 }, bear: { probability: 15 } }, dimensions: { macro: { score: 1 }, news: { score: 2 } }, drivers: [{ direction: "tailwind", magnitude: "high" }] },
};
const bad = {
  doc, pack: { sentiment: { last_7d: -0.3, prior_30d: -0.1 }, analyst: [{ symbol: "A", buy: 2, hold: 6, sell: 2, upside: -0.08 }] },
  kpi: { cycle_position: "contraction", pricing_power: { level: "weak" }, demand_drivers: [{ direction: "decelerating" }], management_signals: [{ tone: "negative" }], hot_segments: [], cool_segments: [{}, {}] },
  macro: { regime: "HOSTILE", horizons: { "3M": { call: "RESTRICTIVE" } }, indicators: { I1: { relevance: "high", effect: "headwind" } } },
  world: { scout: { situations: [{ title: "War", relevance: "high" }] }, dives: [{ title: "War", stance: "adverse", status: "escalating" }] },
  trade: { verdict: { rating: "critical", health: { score: 20 }, investment_read: { pass_through: "none", derate_risk: "high" }, bottlenecks: [{ severity: "critical" }, { severity: "critical" }] }, map: { countries: [{ importance: "existential", stance: "adversarial", trajectory: "escalating" }] } },
  reg: { policy: [{ direction: "headwind" }, { direction: "headwind" }], litigation: [{}, {}, {}], perception: { trend: "deteriorating" } }, regVerdict: { stance: "headwind", intensity: "high" }, books: [{ rules: [{ status: "in_force", severity: "high" }, { status: "in_force", severity: "high" }, { status: "pending", severity: "high" }] }],
  lead: { scenarios: { bull: { probability: 10 }, base: { probability: 40 }, bear: { probability: 50 } }, dimensions: { regulatory: { score: -2 } }, drivers: [{ direction: "headwind", magnitude: "high" }] },
};
const G = Sec.pillars(good), B = Sec.pillars(bad);
for (const k of ["cycle", "macro", "world", "supply", "regulation", "sentiment", "consensus", "outlook"]) {
  assert(G[k] && B[k], "pillar missing: " + k);
  assert(G[k].score > 60 && B[k].score < 40, `${k}: good ${G[k].score}, bad ${B[k].score}`);
  assert(G[k].items.length && G[k].items.every((i) => i.label && Number.isFinite(i.score) && i.share > 0), k);
  assert(Math.abs(G[k].items.reduce((a, i) => a + i.share, 0) - 100) <= 2, k + " shares sum to ~100");
}
assert.deepStrictEqual(Object.keys(Sec.pillars({ doc })), [], "no reports, no section pillars");

// Scores: sections move the totals; missing sections redistribute weight; overlay capped at 5
const base = Score.scoreIndustries([doc], {}, "2026-10-24", { relative: false }).Semis.profiles;
const up = Score.scoreIndustries([doc], { Semis: { overlay: { growth: 20 }, as_of: "2026-10-24" } }, "2026-10-24", { relative: false, sections: { Semis: G } }).Semis.profiles;
const down = Score.scoreIndustries([doc], {}, "2026-10-24", { relative: false, sections: { Semis: B } }).Semis.profiles;
for (const p of ["income", "conservative", "growth", "aggressive"]) {
  assert(up[p].base > down[p].base + 10 && down[p].base < base[p].base, `${p}: bad ${down[p].base}, none ${base[p].base}, good ${up[p].base}`);
  assert(Math.abs(up[p].quant - base[p].quant) < 1e-9, "metrics-only part unchanged");
}
assert.strictEqual(up.growth.overlay, 5);
for (const [k, prof] of Object.entries(Score.PROFILES)) assert.strictEqual(Object.values(prof.weights).reduce((a, x) => a + x, 0), 100, k);
console.log("sections tests passed", { growth: [Math.round(down.growth.base), Math.round(base.growth.base), Math.round(up.growth.base)] });
