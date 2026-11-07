// node apply_test.js: the company analysis applied from the industry's (inherit, measure, apply).
const fs = require("fs"), zlib = require("zlib"), A = require("./apply.js"), C = require("./company.js"), O = require("./outlook.js");
let fails = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails++; };
const FIX = process.env.FIX || "/tmp/claude-0/-home-claude/e2f2e0a5-0e53-566e-aafe-723d47ac4ff7/scratchpad/latest5/runs/technology.json.gz";
let run = null;
if (fs.existsSync(FIX)) {
  const J = JSON.parse(zlib.gunzipSync(fs.readFileSync(FIX))); let v = J.records["run:semiconductors"]; if (typeof v === "string") v = JSON.parse(v);
  const reports = Object.fromEntries(Object.entries(v.reports || {}).map(([k, x]) => [k.replace("semiconductors--", ""), x?.result]).filter(([, x]) => x));
  run = { name: v.name, industry: v.industry, agent: v.agent, reports, books: Object.values(v.regbooks || {}).filter((b) => b?.book).map((b) => ({ body: b.body, book: b.book })), lead: v.agent.result };
}
if (run) {
  const sym = "INTC", row = run.industry.constituents.find((c) => c.symbol === sym) || run.industry.constituents[3];
  const lens = C.lensInputs(run, [{ region: "China", share: 0.29, countries: [{ country: "China", via: "exact" }] }, { region: "United States", share: 0.25, countries: [{ country: "United States", via: "exact" }] }], [], "2026-11-06");
  const inh = A.inherit({ res: run.lead, d: run.industry, R: run.reports, lens, ind: O.provisional(run.lead), today: "2026-11-06" });
  console.log("   inherited", Object.keys(inh).length, "of", A.KEYS.length, JSON.stringify(inh.trade).slice(0, 160));
  ok(Object.keys(inh).length >= 15, "the industry's conclusion for most components (code, instant)");
  const M = A.measure({ sym: row.symbol, peers: C.peerTable(row, run.industry.constituents), lens, sens: run.industry.sensitivity, indSens: run.industry.sensitivity, mentions: [{ section: "lead", text: "x" }], calls: run.reports.calls, credit: run.industry.credit, ownReport: "2027-01-29", ind: O.provisional(run.lead) });
  console.log("   measured", Object.keys(M).length, JSON.stringify(M.trade), JSON.stringify(M.valuation));
  ok(Object.keys(M).length >= 14 && M.valuation?.text && M.macro?.text && M.trade?.text, "measured against the industry for most components");
  const txt = A.measureText(M);
  const p = A.applyPrompt({ today: "2026-11-06", sym: row.symbol, name: row.name || row.symbol, industry: run.name, digest: O.digest({ res: run.lead, d: run.industry, R: run.reports, cal: run.agent.calendar, facts: run.lead.horizon_facts, today: "2026-11-06" }), company: "COMPANY\nPrice 20", measured: txt, mentions: [], windows: [] });
  console.log("   call A prompt", p.length, "chars ~", Math.round(p.length / 4), "tokens");
  ok(p.length < 45000 && A.KEYS.every((k) => p.includes(k)), "call A is small and names every component");
}
const raw = { headline: "h", components: A.KEYS.map((k, i) => ({ key: i % 2 ? A.LABEL[k] : k, applies: ["more", "same", "less", "not at all"][i % 4], effect: i % 3 ? "up" : "down", why: "w" })),
  calls: { "1M": { call: "slightly bearish", why: "near-term" }, "3M": { call: "slightly bullish", why: "then the print" }, "6M": { call: "bullish", why: "x" }, "12M": { call: "bullish", why: "y" } }, verdict: { agrees: true, why: "v" } };
const ap = A.cleanApply(raw, { today: "2026-11-06" });
ok(Object.keys(ap.components).length === A.KEYS.length && ap.components[A.KEYS[3]].applies === "none" && !ap.missing.length, "every component cleaned (by key or label; 'not at all' is none)");
ok(ap.outlook?.v === 3 && ap.outlook.calls["12M"].call === "bullish" && ap.outlook.evidence.length === A.KEYS.length, "the calls come out as an outlook, the components as its evidence");
const own = A.ownPrompt({ today: "2026-11-06", sym: "X", name: "X", industry: "I", indVerdict: "v", indOutlook: "o", company: "c" }, A.OWN_KEYS.map((k) => C.FIELDS[k]).join(",\n "));
ok(/ONLY what the industry analysis can't know/.test(own) && /"thesis"/.test(own) && /"risks"/.test(own) && own.length < 20000, "call B: only the company-specific parts, small");
console.log(fails ? fails + " FAILED" : "apply tests passed"); process.exit(fails ? 1 : 0);
