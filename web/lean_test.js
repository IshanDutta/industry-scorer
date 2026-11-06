// node lean_test.js: the lean (six-level calls vs the S&P 500 for each timeframe, with the reasons, from every input).
const L = require("./lean.js");
let fails = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails++; };
const res = { headline: "AI capex keeps the cycle up", thesis: "t", opportunity: { verdict: "conditional", headline: "h", why: "w" }, math: { expected_return: 9, prob_loss: 30, reward_risk: 1.4 },
  scenarios: { bull: { probability: 30, price_move: 35 }, base: { probability: 50, price_move: 8 }, bear: { probability: 20, price_move: -25 } },
  horizons: { "1M": { call: "slightly bearish", probability_up: 45 }, "3M": { call: "neutral", probability_up: 58 }, "6M": { call: "strongly bullish" },
    "12M": { call: "slightly bullish", conviction: 6, expected_move: [-6, 22], probability_up: 64, vs_spy: { call: "neutral", expected_excess: [-8, 12], probability_beat: 57 }, drivers: "d" } },
  redteam: { stance: "short", thesis: "x", arguments: [{ severity: "high", claim: "c" }], premortem: [] }, daily: { date: "2026-11-06", headline: "Midterms landed", summary: "s", changes: [] } };
ok(["strongly bearish", "bearish", "slightly bearish", "slightly bullish", "bullish", "strongly bullish"].every((l) => L.level(l) === l) && L.level("Outperform") === "bullish" && L.level("mildly underperform") === "slightly bearish" && L.level("neutral") === null, "six levels, read from any spelling; no neutral");
const p = L.leanPrompt("Semiconductors", { today: "2026-11-06", dossier: "=== QUANT ===\nstuff", res, facts: [], wire: [{ id: "W1", title: "Fed holds" }] });
ok(/RELATIVE TO THE S&P 500/.test(p) && /no neutral/i.test(p) && /\[W1\] Fed holds/.test(p) && L.KEYS.every((k) => p.includes(k)) && /OPPORTUNITY VERDICT.*CONDITIONAL/.test(p), "the prompt: vs the S&P 500, six levels, every input, the lead's verdict");
const ev = (pts) => L.KEYS.map((k, i) => ({ input: L.LABEL[k], points: pts(i), weight: (i % 3) + 1, why: "because [A1] and [ZZ9]" }));
const C = (call, why = "the index is held back by rates [A1]") => ({ call, why, for: ["a [A1]"], against: ["b"], flips_it: "c" });
const a = L.cleanLean({ headline: "Leaning bullish [A1]", evidence: ev((i) => (i < 10 ? "bullish" : "bearish")), calls: { "1M": C("slightly bearish", "near-term the selling continues"), "3M": C("slightly bullish", "then the Q4 prints turn it"), "6M": C("bullish"), "12M": C("Bullish") }, verdict: { agrees: false, why: "the evidence outweighs the conditional verdict" } }, { res, today: "2026-11-06", known: ["A1"] });
ok(a.v === 2 && a.calls["12M"].call === "bullish" && a.calls["1M"].call === "slightly bearish" && a.evidence.length === 15 && !a.missing.length, "cleaned: four calls on the scale, every input matched by its label");
ok(/\[A1\]/.test(a.evidence[0].why) && !/ZZ9/.test(a.evidence[0].why), "unknown citations dropped");
ok(a.consistent && !a.checks.length, "a flip with its reason, on evidence that agrees: no issues " + JSON.stringify(a.checks));
ok(a.verdict.agrees === false, "disagreeing with the lead verdict is kept");
const b = L.cleanLean({ headline: "x", evidence: ev((i) => (i % 2 ? "bullish" : "mixed")), calls: { "1M": C("bullish"), "3M": C("bearish"), "6M": C("strongly bearish"), "12M": C("bearish") } }, { res });
ok(b.checks.some((c) => /tips the other way/.test(c)), "bearish long calls on bullish evidence are flagged");
ok(b.checks.some((c) => /neither says what changes/.test(c)), "a flip with no reason is flagged");
const c = L.cleanLean({ headline: "x", evidence: L.KEYS.map((k, i) => ({ input: k, points: i % 2 ? "bearish" : "bullish", weight: 2 })), calls: { "1M": C("bullish"), "3M": C("bullish"), "6M": C("bullish"), "12M": C("strongly bullish") } });
ok(c.checks.some((t) => /only \d+% one-sided/.test(t)), "\"strongly\" on evenly split evidence is flagged");
ok(L.cleanLean({ calls: { "12M": { call: "neutral" } } }) === null, "no side, no lean");
ok(/problems/.test(L.repairPrompt("Banks", "2026-11-06", b, b.checks)), "repair prompt");
const pv = L.provisional(res, "2026-11-06");
ok(pv.provisional && pv.calls["1M"].call === "slightly bearish" && pv.calls["3M"].call === "slightly bullish" && pv.calls["6M"].call === "strongly bullish" && pv.calls["12M"].call === "slightly bullish", "provisional: earlier calls mapped onto the scale (neutral by the odds): " + L.leanLine(pv));
ok(L.leanOf({ ...res, lean: a }) === a && L.leanOf({ ...res, lean: { lean: "bullish", probability: 60 } }).provisional, "leanOf: this format, else provisional (an older lean is ignored)");

// The scoreboard, the challenge and the final calls
const days = [], closes = []; for (let i = 0; i < 300; i++) { days.push("d" + i); closes.push(100 * Math.exp(0.0004 * i)); }
const mk = L.marketFacts(days, closes);
ok(mk.ret["12M"] > 9 && mk.ret["12M"] < 11 && mk.from_high === 0, "S&P 500 facts: trailing returns, distance from the high: " + JSON.stringify(mk.ret));
ok(L.statCall({ rel: { prob_beat: 47, median: -1 } }) === "slightly bearish" && L.statCall({ rel: { prob_beat: 58 } }) === "bullish" && L.statCall({ rel: { prob_beat: 63 } }) === "strongly bullish", "the anchor's own call on the six levels");
const f3 = { h: "3M", end: "2027-02-05", sigma: 20.8, trailing: -21.9, vs_spy: -17.3, breadth: 16, reporting: [{ symbol: "NVDA", date: "2026-11-17", weight: 33.9 }, { symbol: "INTC", date: "2027-01-28", weight: 2.1 }],
  like: { pos: 60, median: 6.1, n: 20 }, anchor: { rel: { median: -1.1, prob_beat: 47 }, drivers: [{ label: "last month vs the S&P 500", push: -1.8 }], test: { hit_rate: 54.8, base_hit_rate: 55 } } };
const cal = { events: [{ title: "FOMC decision", dates: ["2026-12-09"], importance: "high", id: "C9" }, { title: "Minor data", dates: ["2026-12-01"], importance: "low", id: "C10" }, { title: "Too late", dates: ["2027-03-01"], importance: "high", id: "C11" }] };
const we = L.windowEvents(cal, f3, "2026-11-06");
ok(we.length === 2 && we[0].title.startsWith("NVDA") && we[1].id === "C9", "events in the window: high and medium only, big reporters, in date order");
const board = L.scoreboard([f3], mk, cal, "2026-11-06");
ok(/THE S&P 500 ITSELF/.test(board) && /Statistical anchor: slightly bearish/.test(board) && /treat it as weak/.test(board) && /2026-12-09 FOMC decision \[C9\]/.test(board), "scoreboard text");
ok(/SCOREBOARD/.test(L.leanPrompt("X", { today: "2026-11-06", res, board })), "the scoreboard goes in the prompt");
ok(/paid to find where they are wrong/.test(L.challengePrompt("X", "2026-11-06", a, board)), "challenge prompt");
const ch = L.cleanChallenge({ windows: { "12M": { recommend: "Soften", case: "too strong", errors: ["10Y misread"] }, "1M": { recommend: "hold", case: "fine" } }, overall: "o" });
ok(ch.windows["12M"].recommend === "soften" && ch.windows["1M"].recommend === "hold", "challenge cleaned");
ok(/FINAL calls/.test(L.finalPrompt("X", "2026-11-06", a, ch, board)), "final prompt");
const fin = L.mergeFinal(a, { headline: "h2", calls: { "12M": { call: "slightly bullish", why: "softened: the 10Y was misread [A1]", for: ["x"], against: ["y"], flips_it: "z", challenge: "the 10Y point stands" } }, evidence_fixes: [{ input: "macro", points: "bearish", weight: 2, why: "corrected" }] }, ch, { res, known: ["A1"] });
ok(fin.calls["12M"].call === "slightly bullish" && fin.calls["12M"].challenge.before === "bullish" && fin.calls["12M"].challenge.recommend === "soften" && fin.calls["1M"].call === "slightly bearish" && fin.calls["1M"].challenge.before === null, "final: changed windows record what they were, the rest held");
ok(fin.evidence.find((e) => e.input === "macro").points === "bearish" && fin.evidence.length === 15, "evidence fixes applied");
ok(L.mergeFinal(a, null, ch) === a, "no final answer: the first calls stand");

// One company
const ind = { calls: { "1M": { call: "slightly bearish", why: "w1" }, "3M": { call: "slightly bullish" }, "6M": { call: "bullish" }, "12M": { call: "bullish", why: "w12" } }, headline: "ind" };
const win = [{ h: "1M", end: "2026-12-06", trailing: -5, vs_spy: -6, vs_ind: 2, sigma: 9, base_up: 55, own: null, peers: [{ symbol: "AMD", date: "2026-11-20" }] }, { h: "3M", end: "2027-02-06", trailing: 3, vs_spy: 1, sigma: 16, base_up: 58, own: "2027-01-28", peers: [] }];
const cb = L.coScoreboard({ sym: "INTC", windows: win, ind, mkt: mk, beta: 1.4, times: "times text", events: [{ date: "2026-12-09", title: "FOMC", id: "C9" }] });
ok(/beta to the S&P 500 is 1.40: it amplifies/.test(cb) && /industry's call vs the S&P 500: slightly bearish/.test(cb) && /INTC reports 2027-01-28/.test(cb) && /2026-12-09 FOMC \[C9\]/.test(cb) && /IN TIMES LIKE THIS/.test(cb), "company scoreboard: beta, the industry's call, its own report, dated events, times like this");
const cp = L.coLeanPrompt({ today: "2026-11-06", sym: "INTC", name: "Intel", industry: "Semiconductors", ind, write: { headline: "h", verdict: { call: "no", summary: "s" }, horizons: { "12M": { call: "slightly bearish", expected_move: [-10, 5] } } }, facts: "facts", board: cb, news: [{ id: "N1", title: "Intel news" }] });
ok(/DOES INTC BEAT OR LAG THE S&P 500/.test(cp) && /12M: bullish: w12/.test(cp) && /\[N1\] Intel news/.test(cp) && L.CO_KEYS.every((k) => cp.includes(k)), "company prompt: the industry's calls, the write-up, every input");
const CC = (call, vs) => ({ call, vs_industry: vs, why: "then it turns [N1]", for: ["a"], against: ["b"], flips_it: "c" });
const co = L.cleanLean({ headline: "x", evidence: L.CO_KEYS.map((k) => ({ input: L.CO_INPUTS.find(([kk]) => kk === k)[1], points: "bullish", weight: 2, why: "y [N1]" })), calls: { "1M": CC("slightly bullish", "beats"), "3M": CC("bullish", "beats"), "6M": CC("slightly bearish", "lags"), "12M": CC("bearish", "matches") } }, { inputs: L.CO_INPUTS, alias: L.CO_ALIAS, ind, known: ["N1"] });
ok(co.evidence.length === 16 && !co.missing.length && co.calls["1M"].vs_industry === "beats", "company inputs matched by label");
ok(co.checks.some((c) => /12M: the industry is bullish .* matches the industry, but calls it bearish/.test(c)) && !co.checks.some((c) => /^1M:|^3M:|^6M:/.test(c)), "a call that contradicts the industry's call and its own vs-industry is flagged; consistent ones aren't: " + JSON.stringify(co.checks));
ok(/analyst responsible for Intel \(INTC\)/.test(L.finalPrompt("Intel", "2026-11-06", co, ch, cb, L.coAbout("Intel", "INTC", "Semiconductors"), L.CO_FINAL_EXTRA)) && /"vs_industry"/.test(L.finalPrompt("Intel", "2026-11-06", co, ch, cb, "x", L.CO_FINAL_EXTRA)), "final prompt for a company keeps vs_industry");
console.log(fails ? fails + " FAILED" : "lean tests passed"); process.exit(fails ? 1 : 0);
