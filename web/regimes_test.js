const R = require("./regimes.js");
let fails = 0; const ok = (c, m) => { console.log(c ? "ok  " : "FAIL", m); if (!c) fails++; };
// Synthetic daily series 2008-01-02 .. 2026-10-30 (weekdays).
const days = []; for (let t = Date.parse("2008-01-02"); t <= Date.parse("2026-10-30"); t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) days.push(d.toISOString().slice(0, 10)); }
const wave = (p, a, ph = 0) => days.map((d, i) => 100 * Math.exp(a * Math.sin(i / p + ph) + 0.0002 * i));
const ser = (v) => ({ dates: days, values: v });
const ind = ser(wave(180, 0.25)), spy = ser(wave(260, 0.15, 1));
const mon = (f) => { const out = []; for (let y = 2007; y <= 2026; y++) for (let m = 1; m <= 12; m++) { const d = `${y}-${String(m).padStart(2, "0")}-01`; if (d <= "2026-10-01") out.push({ date: d, value: f(y + m / 12) }); } return R.monthly(out); };
const mk = { spy, ief: ser(wave(400, 0.05)), hyg: ser(wave(300, 0.06)), uso: ser(wave(150, 0.3)), uup: ser(wave(500, 0.05)), vix: ser(days.map((d, i) => 18 + 8 * Math.sin(i / 90))),
  ff: mon((t) => Math.max(0.1, 2.5 + 2.4 * Math.sin(t / 2.2))), cpi: mon((t) => 210 * Math.exp(0.025 * (t - 2007))), un: mon((t) => 5.5 + 2 * Math.cos(t / 3)) };
const pe = { dates: days.filter((d) => d >= "2010-01-01"), pe: days.filter((d) => d >= "2010-01-01").map((d, i) => 20 + 6 * Math.sin(i / 300)) };
const out = R.episodes({ ind, pe, mk, today: "2026-10-30" });
ok(out && out.episodes.length === 5, `five episodes (${out?.episodes?.length}) from ${out?.months} months, ${out?.features?.length} features`);
ok(out.features.length === R.FEATURES.length, "every feature is available: " + out.features.join(","));
const ms = out.episodes.map((e) => Date.parse(e.date)).sort((a, b) => a - b);
ok(ms.every((t, i) => !i || (t - ms[i - 1]) / (30.44 * 864e5) >= 8.9), "episodes are at least 9 months apart: " + out.episodes.map((e) => e.month).join(", "));
ok(out.episodes.every((e) => e.date <= "2025-10-31"), "none from the last 12 months");
ok(out.episodes.every((e, i) => !i || e.similarity <= out.episodes[i - 1].similarity), "ordered from the most similar");
const e = out.episodes[0], i0 = days.indexOf(e.date);
ok(Math.abs(e.industry["3M"] - Math.round((ind.values[i0 + 63] / ind.values[i0] - 1) * 1000) / 10) < 0.06, `3M forward return measured from the index (${e.industry["3M"]}%)`);
ok(e.path.length === 13 && e.path[0] === 0 && e.spy_path.length === 13, "12-month path, monthly, from 0");
ok(isFinite(e.maxdd6) && e.maxdd6 <= 0, `worst drop in 6 months ${e.maxdd6}%`);
ok(e.alike.length === 4 && e.unlike.length === 3, "what's most and least alike");
const b = out.base["12M"]; ok(b.n >= 15 && b.pos >= 0 && b.pos <= 100 && b.top_n === 5 && isFinite(b.all_pos), `12M base rate: up ${b.pos}% (all months ${b.all_pos}%), 5 episodes up ${b.top_up} of 5`);
const txt = R.text(out); ok(/\[HE1\]/.test(txt) && /\[HE5\]/.test(txt) && /Base rates from the 20 closest/.test(txt) && txt.length < 9000, `prompt text (${txt.length} chars)`);
// Missing macro: still works on the industry's own setup and whatever macro exists.
const thin = R.episodes({ ind, mk: { spy }, today: "2026-10-30" });
ok(thin && thin.episodes.length === 5 && !thin.features.includes("ff"), "with only the S&P 500, it matches on what it has: " + thin.features.join(","));
ok(R.episodes({ ind: { dates: days.slice(0, 300), values: ind.values.slice(0, 300) }, mk }) === null, "too little history: none");
const hp = R.historianPrompt("Gold", out, { today: "2026-10-30" }); ok(/"then"/.test(hp) && /Never invent a number/.test(hp), "historian prompt");
const h = R.cleanHistorian({ episodes: [{ id: "E2", then: "b" }, { id: "E1", then: "a", after: "x" }], read: "r", closest: "E1" }, out);
ok(h.episodes.length === 5 && h.episodes[0].then === "a" && h.episodes[1].then === "b" && h.months[0] === out.episodes[0].month && h.closest === "HE1", "historian answer matched to episodes by ID");
console.log(fails ? fails + " FAILED" : "regimes tests passed"); process.exit(fails ? 1 : 0);
