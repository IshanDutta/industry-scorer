// node outlook_test.js: the outlook (where the industry or a company is going, six levels per window, from every component; one cheap call).
const O = require("./outlook.js");
let fails = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails++; };
ok(O.LEVELS.every((l) => O.level(l) === l) && O.level("Up strongly") === "strongly bullish" && O.level("modestly lower") === "slightly bearish" && O.level("neutral") === null, "six levels from any spelling; no neutral");
const res = { headline: "H", thesis: "T", opportunity: { verdict: "conditional", headline: "oh", why: "ow", entry_triggers: ["t1"] }, scenarios: { bull: { probability: 30, price_move: 40 }, base: { probability: 45, price_move: 8 }, bear: { probability: 25, price_move: -30 } }, math: { expected_return: 9, prob_loss: 25 },
  horizons: { "1M": { call: "slightly bearish", probability_up: 45 }, "3M": { call: "neutral", probability_up: 58 }, "6M": { call: "strongly bullish" }, "12M": { call: "bullish" } },
  redteam: { stance: "short", thesis: "rt", arguments: [{ severity: "high", claim: "c" }] }, daily: { date: "2026-11-06", headline: "dh", summary: "ds", changes: [{ effect: "worse", text: "x" }] }, change_mind: ["cm"] };
const d = { summary: { ret_cw_1M: -0.3, ret_cw_3M: -0.2, ret_cw_6M: -0.1, ret_cw_1Y: 0.09, breadth_3M: 0.16, vol_1y: 0.41, beta: 2.3, max_dd_1y: -0.3 }, forward: { n: 40, fwd_pe: 10.4, ntm_eps_growth: 0.77, rev30: 0.04, rev90: 0.13, up30: 476, down30: 61, breadth: 0.77 },
  priced_in: { verdict: "in line", implied_eps_growth: 0.065, consensus_ntm_growth: 0.77, r: 0.15, beta: 2.35 }, positioning: { n: 25, label: "washed out", insiders: { purchases: 1, sales: 2 }, institutions: { own_change_pp: 2.4 }, short: { capw: 0.016 } }, credit: { cmdi: { market: 0.25, market_pctl: 0.99, from: "2024-11-08" } }, plan: { index_levels: { last: 108, sma50: 139, sma200: 128, low52: 90, high52: 154 } } };
const R = { macro: { regime: "RESTRICTIVE", headline: "mh", horizons: { "1M": { call: "HOSTILE", text: "vix" } }, flip: [{ condition: "10Y below 4.5%" }] }, world: { dives: [{ title: "Midterms", stance: "adverse", status: "escalating", summary: "ws" }] }, trade: { verdict: { rating: "manageable", headline: "th" } }, regverdict: { stance: "headwind", headline: "rh", timeline: [{ date: "2026-01", event: "old" }, { date: "2027-01", event: "truce lapses" }] },
  kpi: { summary: "ks", cycle_position: "expansion", pricing_power: { level: "strong" }, next_triggers: [{ date: "2026-11-17", event: "NVDA" }] }, calls: { summary: { direction: "improving", text: "guides up" } }, history: { read: "hr" } };
const facts = [{ h: "12M", like: { pos: 70, median: 17.8, n: 20 }, base_up: 86, anchor: { abs: { median: 3, prob_up: 53 }, test: { hit_rate: 56.7, base_hit_rate: 57 } }, sigma: 41.6 }];
const cal = { events: [{ title: "NVDA earnings", dates: ["2026-11-17"], importance: "high" }, { title: "old", dates: ["2026-10-01"], importance: "high" }, { title: "minor", dates: ["2026-11-20"], importance: "low" }] };
const dig = O.digest({ res, d, R, cal, facts, today: "2026-11-06" });
for (const k of ["VERDICT AND THESIS", "CONDITIONAL", "SCENARIOS", "RED TEAM", "LATEST DAILY UPDATE", "MACRO", "WORLD EVENTS", "TRADE", "REGULATION", "CYCLE", "ESTIMATES AND REVISIONS", "MANAGEMENT GUIDANCE", "WHAT'S PRICED IN", "POSITIONING", "CREDIT", "MOMENTUM", "PAST SETUPS", "DATED CATALYSTS"]) ok(dig.includes(k), "digest has " + k);
ok(/Flips if: 10Y below 4.5%/.test(dig) && /2027-01 truce lapses/.test(dig) && !/2026-01 old/.test(dig) && /2026-11-17 NVDA earnings/.test(dig) && !/minor|2026-10-01/.test(dig), "objects read as text; past and low-importance events left out");
ok(!/\[object Object\]/.test(dig), "no [object Object]");
const p = O.prompt("Semis", "2026-11-06", dig);
ok(/WHERE THE INDUSTRY IS GOING/.test(p) && !/S&P/.test(p.replace(dig, "")) && O.INPUTS.every(([k]) => p.includes(k)), "the prompt: its own direction only, every component, no S&P 500");
ok(p.length < 30000, `cheap: ${p.length} characters (~${Math.round(p.length / 4)} tokens)`);
const C = (call, why = "earnings carry it") => ({ call, why, for: ["a"], against: ["b, and it loses"], flips_it: "c" });
const ev = (pts) => O.INPUTS.map(([k, l], i) => ({ input: i % 2 ? l : k, points: pts(i), weight: (i % 3) + 1, why: "w" }));
const a = O.clean({ headline: "Up", evidence: ev((i) => (i < 12 ? "up" : "down")), calls: { "1M": C("slightly bearish", "near-term the selling continues"), "3M": C("slightly bullish", "then NVDA's print turns it"), "6M": C("bullish"), "12M": C("Bullish") }, verdict: { agrees: true, why: "yes" } }, { today: "2026-11-06" });
ok(a.v === 3 && a.calls["12M"].call === "bullish" && a.evidence.length === 17 && !a.missing.length && a.consistent, "cleaned, every component matched by key or label, consistent: " + JSON.stringify(a.checks));
const b = O.clean({ headline: "x", evidence: ev((i) => (i % 2 ? "down" : "mixed")), calls: { "1M": C("bullish"), "3M": C("bearish"), "6M": C("strongly bullish"), "12M": C("bullish") } });
ok(b.checks.some((c) => /points the other way/.test(c)) && b.checks.some((c) => /neither says what changes/.test(c)) && b.checks.some((c) => /only \d+% one-sided/.test(c)) && !b.consistent, "contradictions flagged: against the evidence, an unexplained flip, an unsupported 'strongly'");
ok(/Code found problems/.test(O.repairPrompt("the industry", "2026-11-06", b, b.checks)), "repair prompt (small)");
const pv = O.provisional(res);
ok(pv.provisional && pv.calls["1M"].call === "slightly bearish" && pv.calls["3M"].call === "slightly bullish" && pv.calls["6M"].call === "strongly bullish" && pv.calls["12M"].call === "slightly bullish", "provisional from the earlier calls: " + O.line(pv));
ok(O.outlookOf({ ...res, outlook: a }) === a && O.outlookOf({ ...res, lean: { v: 2, calls: {} } }).provisional, "outlookOf prefers a made outlook");
ok(O.flipped(a, b) === false && O.flipped({ ...a, calls: { "12M": { call: "bearish" } } }, a) === true, "12M flips detected");
const cp = O.coPrompt({ today: "2026-11-06", sym: "INTC", name: "Intel", industry: "Semis", ind: a, indLead: "CONDITIONAL: staged buy", company: "COMPANY\nPrice 20", mentions: [{ section: "lead", text: "INTC weak" }], facts: "f", windows: [{ h: "1M", sigma: 9, trailing: -5, base_up: 55, own: null, peers: [] }], news: [{ title: "n" }] });
ok(/WHERE INTC IS GOING/.test(cp) && /12M: bullish: earnings carry it/.test(cp) && /THE INDUSTRY LEAD'S VERDICT\nCONDITIONAL/.test(cp) && /INTC: THE COMPANY\nCOMPANY/.test(cp) && !/COMPANY WRITE-UP/.test(cp) && O.CO_INPUTS.every(([k]) => cp.includes(k)) && !/S&P/.test(cp), "company prompt: the industry's outlook first, every component, no S&P 500");
console.log(fails ? fails + " FAILED" : "outlook tests passed"); process.exit(fails ? 1 : 0);
