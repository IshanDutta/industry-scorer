// Browser test of the Compare tab, against fake FMP/EODHD/Claude connectors, a fake page database and a fake GitHub
// (fire_trigger ANALYZE marks the request running, then done with a canned verdict). No keys, no network.
//   node test/compare-browser.mjs "KO, PEP, VAW"            (from runner/, after npm install)
//   SEED=path/to/seed.json node test/compare-browser.mjs ... (real industry runs in the browser: see test/make-seed.mjs)
// Screenshots and the tab's text go to test/.tmp-browser/ (cmp-*.png per section, full.png, phone.png, text.txt).
// It prints: errors on the page, the progress bars, the indicator explorer's filter count, and how many indicator cells
// are filled ("dash" must be 0).
import { chromium } from "playwright";
import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const PAGE = resolve(here, "../../web/industry-scorer.html"), OUT = join(here, ".tmp-browser"); fs.mkdirSync(OUT, { recursive: true });
const o = (f) => join(OUT, f);
const brain = `
(function () {
  const COS = { AAPL: { name: "Apple Inc.", industry: "Consumer Electronics", sector: "Technology", pe: 32, rg: 0.06 }, MSFT: { name: "Microsoft Corporation", industry: "Software - Infrastructure", sector: "Technology", pe: 35, rg: 0.15 }, KO: { name: "Coca-Cola", industry: "Beverages - Non-Alcoholic", sector: "Consumer Defensive", pe: 24, rg: 0.03 }, PEP: { name: "PepsiCo", industry: "Beverages - Non-Alcoholic", sector: "Consumer Defensive", pe: 21, rg: 0.02 }, MDLZ: { name: "Mondelez", industry: "Food Confectioners", sector: "Consumer Defensive", pe: 19, rg: 0.04 } };
  const series = (sym) => { const out = []; let seed = 0; for (const c of sym) seed += c.charCodeAt(0); let v = 50 + (seed % 50); const d = new Date("2019-12-02"); let k = 0;
    while (d.toISOString().slice(0, 10) <= "2026-11-20") { if (d.getUTCDay() % 6) { k++; v *= 1 + 0.011 * Math.sin(k * 0.31 + seed) * Math.cos(k * 0.017) + 0.0003 * (seed % 5) + 0.006 * Math.sin(k * 0.7 + seed); out.push({ date: d.toISOString().slice(0, 10), adjClose: v, close: v, open: v, high: v * 1.01, low: v * 0.99, volume: 1e6 }); } d.setUTCDate(d.getUTCDate() + 1); }
    return out.reverse(); };
  const fundHold = Object.keys(COS).map((s) => ({ asset: s, name: COS[s].name, weightPercentage: 6 })).concat([{ asset: "NVDA", name: "NVIDIA", weightPercentage: 7 }]);
  window.__calls = [];
  const mcp = { async listTools() { return { servers: [{ server: "FMP", tools: [] }, { server: "EODHD", tools: ["get_fundamentals_data", "get_economic_events", "get_stocks_from_search"] }] }; }, async callTool(server, tool, input) {
    window.__calls.push(server + ":" + tool + ":" + (input.endpoint || "")); const sym = input.symbol, c = COS[sym];
    if (server === "EODHD") {
      if (tool === "get_fundamentals_data" && /^FXAIX/.test(input.ticker)) return { payload: (input.sections || []).join() === "General" ? { General: { Code: "FXAIX", Type: "FUND", Name: "Fidelity 500 Index Fund" } }
        : { General: { Code: "FXAIX", Type: "FUND", Name: "Fidelity 500 Index Fund", Fund_Category: "US Equity" }, MutualFund_Data: { Yield: 1.2, Expense_Ratio: 0.015 }, Asset_Allocation: { Stock: { "Net_Assets_%": 99 } }, Top_Holdings: { 0: { Name: "APPLE INC", Weight: "7.0%" }, 1: { Name: "MICROSOFT CORP", Weight: "6.5%" }, 2: { Name: "COCA-COLA CO", Weight: "0.6%" }, 3: { Name: "NVIDIA CORP", Weight: "7.2%" } }, Sector_Weights: { Sensitive: { 0: { Name: "Technology", "Amount_%": "33.1" } }, Defensive: { 0: { Name: "Consumer Defensive", "Amount_%": "5.4" } }, Cyclical: { 0: { Name: "Financial Services", "Amount_%": "13" } } } } };
      if (tool === "get_historical_stock_prices" && /^FXAIX/.test(input.ticker)) return { payload: series("FXAIX").map((x) => ({ date: x.date, close: x.close, adjusted_close: x.adjClose })).reverse() };
      if (tool === "get_economic_events") { const d = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
        return { payload: [{ date: d(-20) + " 13:30:00", type: "CPI", comparison: "yoy", period: "Oct", actual: 3.7, estimate: 3.5, previous: 3.4, unit: "%", importance: "high", country: "US" }, { date: d(-20) + " 13:30:00", type: "Core CPI", comparison: "yoy", period: "Oct", actual: 3.3, estimate: 3.2, previous: 3.2, unit: "%", importance: "high" }, { date: d(-17) + " 13:30:00", type: "Non Farm Payrolls", period: "Oct", actual: 182, estimate: 150, previous: 140, scale: "K", importance: "high" }, { date: d(-17) + " 13:30:00", type: "Unemployment Rate", period: "Oct", actual: 4.1, estimate: 4.2, previous: 4.2, unit: "%", importance: "high" }, { date: d(-10) + " 13:30:00", type: "Retail Sales", comparison: "mom", period: "Oct", actual: 0.4, estimate: 0.3, previous: 0.6, unit: "%", importance: "medium" }, { date: d(-5) + " 15:00:00", type: "ISM Manufacturing PMI", period: "Oct", actual: 48.7, estimate: 49.5, previous: 49.1, importance: "high" }, { date: d(-3) + " 13:30:00", type: "Initial Jobless Claims", period: "", actual: 221, estimate: 225, previous: 218, scale: "K", importance: "medium" }, { date: d(15) + " 19:00:00", type: "Fed Interest Rate Decision", period: "", estimate: 4.75, previous: 4.5, unit: "%", importance: "high" }, { date: d(22) + " 13:30:00", type: "CPI", comparison: "yoy", period: "Nov", estimate: 3.6, previous: 3.7, unit: "%", importance: "high" }, { date: d(30) + " 13:30:00", type: "GDP Growth Rate", comparison: "qoq", period: "Q3", estimate: 2.6, previous: 2.8, unit: "%", importance: "high" }, { date: d(40) + " 13:30:00", type: "Core PCE Price Index", comparison: "yoy", period: "Nov", estimate: 3.0, previous: 3.1, unit: "%", importance: "high" }, { date: d(5) + " 13:30:00", type: "6-Month Bill Auction", importance: "medium", category: "auction" }] }; }
      if (tool === "get_stocks_from_search") { const q = String(input.query || "").toLowerCase(); const all = [{ Code: "VFIAX", Name: "Vanguard 500 Index Fund Admiral Shares", Type: "FUND" }, { Code: "VTSAX", Name: "Vanguard Total Stock Market Index Fund Admiral", Type: "FUND" }, { Code: "VAW", Name: "Vanguard Materials Index Fund ETF Shares", Type: "ETF" }, { Code: "FXAIX", Name: "Fidelity 500 Index Fund", Type: "FUND" }]; return { payload: all.filter((x) => (x.Code + " " + x.Name).toLowerCase().includes(q)) }; }
      return { payload: null }; }
    if (tool === "search") { const q = String(input.query || "").toLowerCase(); return { payload: [{ symbol: "VOO", name: "Vanguard S&P 500 ETF", exchangeShortName: "AMEX" }, { symbol: "VGT", name: "Vanguard Information Technology ETF", exchangeShortName: "AMEX" }, { symbol: "NVDA", name: "NVIDIA Corporation", exchangeShortName: "NASDAQ" }, ...Object.entries(COS).map(([k, v]) => ({ symbol: k, name: v.name, exchangeShortName: "NASDAQ" }))].filter((x) => (x.symbol + " " + x.name).toLowerCase().includes(q)) }; }
    if (sym === "FXAIX") return { payload: [] };
    if (tool === "chart") return { payload: series(sym || "X") };
    if (tool === "company" && input.endpoint === "profile-symbol") return { payload: [{ symbol: sym, companyName: c ? c.name : sym + " ETF", price: 100, marketCap: c ? 2e12 : 5e11, beta: 1.1, lastDividend: 0.8, isEtf: !c, isFund: false, sector: c ? c.sector : "", industry: c ? c.industry : "", exchange: "NASDAQ" }] };
    if (tool === "statements" && /ratios-ttm/.test(input.endpoint)) return { payload: c ? [{ priceToEarningsRatioTTM: c.pe, priceToSalesRatioTTM: 8, grossProfitMarginTTM: 0.45, operatingProfitMarginTTM: 0.3, netProfitMarginTTM: 0.24, dividendYieldTTM: sym === "KO" ? 0.03 : 0.006, debtToEquityRatioTTM: 1.2, interestCoverageRatioTTM: 30, dividendPayoutRatioTTM: sym === "KO" ? 0.7 : 0.15 }] : [] };
    if (tool === "statements" && /key-metrics-ttm/.test(input.endpoint)) return { payload: c ? [{ returnOnInvestedCapitalTTM: 0.3, returnOnEquityTTM: 0.5, freeCashFlowYieldTTM: 0.035, netDebtToEBITDATTM: 0.5, evToEBITDATTM: 22, marketCap: 2e12 }] : [] };
    if (tool === "analyst" && /price-target-consensus/.test(input.endpoint)) return { payload: c ? [{ targetConsensus: 115 }] : [] };
    if (tool === "analyst" && /grades-summary|grades-consensus/.test(input.endpoint)) return { payload: c ? [{ strongBuy: 5, buy: 20, hold: 8, sell: 1, strongSell: 0, consensus: "Buy" }] : [] };
    if (tool === "etfAndMutualFunds" && input.endpoint === "holdings") return { payload: c ? [] : fundHold.map((x) => ({ ...x, symbol: sym })) };
    if (tool === "etfAndMutualFunds" && input.endpoint === "information") return { payload: c ? [] : [{ symbol: sym, name: sym + " Tech ETF", assetClass: "Equity", expenseRatio: 0.09, assetsUnderManagement: 2e10, inceptionDate: "2018-06-19", holdingsCount: 4, sectorsList: [{ industry: "Technology", exposure: 99 }] }] };
    if (tool === "quote") return { payload: [].concat(input.symbols || sym || []).join(",").split(",").filter(Boolean).map((s) => ({ symbol: s, price: 100, changePercentage: 0.5, marketCap: 1e11, pe: 25 })) };
    return { payload: [] }; } };
  window.__prompts = [];
  const json = async (p) => { window.__prompts.push(p); await new Promise((r) => setTimeout(r, 300));
    const dsyms = [...p.matchAll(/^=== ([A-Z.]+):/gm)].map((m) => m[1]);
    if (/event strategist/.test(p)) return { pick: dsyms[0], why: "Cleaner catalyst path.",
      events: [{ date: "2026-12-09", event: "FOMC decision and projections", kind: "fed", importance: "high", watch: "a hike with pause guidance vs a series", impact: Object.fromEntries(dsyms.map((k, i) => [k, ["negative", "neutral", "strong negative"][i % 3]])),
        outcomes: [{ if: "Hike with pause guidance", odds: 55, moves: Object.fromEntries(dsyms.map((k) => [k, "+1% to +2%"])) }, { if: "Hike signalling a series", odds: 30, moves: Object.fromEntries(dsyms.map((k) => [k, "-3% to -5%"])) }, { if: "No hike", odds: 15, moves: Object.fromEntries(dsyms.map((k) => [k, "+3%"])) }],
        why: "Bond proxies trade on the 10Y.", play: "Wait to add " + dsyms[0] + " until after the decision." },
        { date: "2027-02-09", event: "KO Q4 results and 2027 guide", kind: "earnings", importance: "medium", watch: "organic growth 5%+", impact: Object.fromEntries(dsyms.map((k, i) => [k, i ? "neutral" : "strong positive"])), outcomes: [], why: "Anchors the group.", play: "" }],
      months: ["2026-12", "2027-01", "2027-02", "2027-03"].map((m, i) => ({ month: m, theme: ["Fed and CPI", "Quiet", "Earnings cluster", "Fed again"][i], risk: ["high", "low", "medium", "medium"][i], read: "Favors " + dsyms[i % dsyms.length] })),
      paths: Object.fromEntries(dsyms.map((k, i) => [k, { path: k + " path through the year.", biggest: "Q4 results", skew: ["upside", "balanced", "downside"][i % 3] }])), horizons: { "1M": { pick: dsyms[0], why: "FOMC" } } };
    if (/foreign-affairs strategist/.test(p)) return { regime: "Growth firm, inflation sticky, a December hike priced.", pick: dsyms[0], why: "Least exposed.",
      indicators: [{ label: "CPI", now: "3.7% rising", read: "Sticky.", impact: Object.fromEntries(dsyms.map((k) => [k, "negative"])) }],
      world: [{ situation: "US-Iran conflict", status: "Escalating", outlook: "Ceasefire odds 30% by Q1.", impact: Object.fromEntries(dsyms.map((k) => [k, { direction: "negative", why: "energy and PET costs" }])) }],
      trade: [{ country: "Mexico", read: "USMCA review in 2026.", impact: Object.fromEntries(dsyms.map((k) => [k, { direction: "neutral", why: "bottlers" }])) }],
      regulation: [{ item: "Section 232 aluminum tariff", status: "in force", impact: Object.fromEntries(dsyms.map((k) => [k, { direction: "negative", why: "can costs" }])) }],
      scenarios: [{ name: "Soft landing", probability: 50, what: "Inflation cools", impact: Object.fromEntries(dsyms.map((k) => [k, { move: "+4% to +8%", why: "multiple holds" }])) }],
      sensitivities: Object.fromEntries(dsyms.map((k) => [k, "Rates: -1.5% per +25bp"])), names: Object.fromEntries(dsyms.map((k) => [k, { read: k + " macro read.", tailwinds: ["Pricing power"], headwinds: ["Aluminum tariff Q1 2027"] }])),
      affairs: Object.fromEntries(dsyms.map((k, i) => [k, { read: k + " earns 21% in Mexico, where the IEPS excise doubled in January; the Section 232 aluminum tariff adds 2-3% to can costs; a US-Iran ceasefire (30% odds by Q1) would ease energy.", net: ["negative", "mixed", "positive"][i % 3], watch: "USMCA joint review, July 2026" }])) };
    if (/macro and events strategist/.test(p)) return { regime: "Rates are rising into a Dec 9 FOMC; staples have had a defensive bid.", pick: dsyms[0], why: "Least rate-sensitive.",
      events: [{ date: "2026-12-09", event: "FOMC decision", kind: "fed", impact: Object.fromEntries(dsyms.map((k, i) => [k, ["negative", "neutral", "strong negative"][i % 3]])), why: "A hike lifts the 10Y; long-duration names hurt most." },
        { date: "2027-02-09", event: "KO Q4 results and 2027 guide", kind: "earnings", impact: Object.fromEntries(dsyms.map((k, i) => [k, i ? "neutral" : "strong positive"])), why: "Organic growth of 5%+ would anchor the group." }],
      scenarios: [{ name: "Soft landing", probability: 50, what: "Inflation cools", impact: Object.fromEntries(dsyms.map((k) => [k, { move: "+4% to +8%", why: "multiple holds" }])) }, { name: "Fed hikes twice", probability: 30, what: "10Y above 5.1%", impact: Object.fromEntries(dsyms.map((k) => [k, { move: "-6% to -10%", why: "bond proxy sells off" }])) }],
      sensitivities: Object.fromEntries(dsyms.map((k) => [k, "Rates: -1.5% per +25bp"])), names: Object.fromEntries(dsyms.map((k) => [k, { read: k + " macro read.", tailwinds: ["Pricing power"], headwinds: ["Aluminum tariff Q1 2027"] }])),
      horizons: { "1M": { pick: dsyms[0], why: "FOMC" } } };
    if (/Wall Street and sentiment analyst/.test(p)) return { pick: dsyms[1], why: "Upgrades.", contrarian: "The street is too bullish on " + dsyms[0] + ".",
      names: Object.fromEntries(dsyms.map((k, i) => [k, { street: "25 buy, 8 hold; target up 6% in a year.", sentiment: "Sentiment +0.21 and rising [N1].", positioning: "Short interest 1%.", crowding: ["high", "low", "medium"][i % 3], signal: ["positive", "neutral", "negative"][i % 3], surprise_risk: "Reports Feb 10." }])) };
    if (/fundamentals analyst/.test(p)) return { pick: dsyms[0], why: "Best ROIC.", names: Object.fromEntries(dsyms.map((k, i) => [k, { quality: "ROIC 30%.", growth: "6%.", valuation: ["rich: 27x forward vs 22x median", "fair: 19x", "cheap: 16x"][i % 3], balance_sheet: "Net debt 2x.", income: "3% yield.", expected_12m: { bull: "+18%", base: "+5%", bear: "-12%" }, read: k + " fundamental read." }])) };
    if (/comparison desk/.test(p)) { const syms = [...p.matchAll(/^=== ([A-Z.]+):/gm)].map((m) => m[1]);
      return { headline: syms[0] + " wins on quality and growth at a fair price; " + syms[1] + " is the steadier hold.", overall: { pick: syms[0], confidence: "medium", why: "Forward P/E and growth favor it. Volatility is higher." },
        ranking: syms, investors: { income: { pick: syms[syms.length - 1], runner_up: syms[0], why: "Higher yield.", avoid: syms[0] + ": tiny yield." }, conservative: { pick: syms[1], why: "Lower vol." }, growth: { pick: syms[0], why: "Faster growth." }, aggressive: { pick: syms[0], why: "Momentum." } },
        horizons: { "1M": { pick: syms[1], why: "x" }, "3M": { pick: syms[0], why: "y" }, "6M": { pick: syms[0], why: "y" }, "12M": { pick: syms[0], why: "z" } },
        dimensions: [{ key: "valuation", pick: syms[1], why: "Cheaper." }, { key: "momentum", pick: syms[0], why: "Stronger." }, { key: "risk", pick: syms[0], why: "deliberate disagreement" }],
        names: Object.fromEntries(syms.map((s, i) => [s, { thesis: s + " wins on margins of 30% if volumes hold; the 12-month case hinges on the February guide.", verdict: ["buy", "hold", "accumulate", "avoid"][i % 4], role: "Core holding", edge: "Margins 30%", strengths: ["A", "B", "C"], weaknesses: ["D", "E"], bull: "Bull.", bear: "Bear.", watch: ["Earnings Jan 28"], changes_mind: "A miss." }])),
        together: { pairing: "Correlated but different jobs.", mix: Object.fromEntries(syms.map((s, i) => [s, 50 - i * 10])) }, risks: ["Rates", "Valuation"], bottom_line: "Own the winner; keep the other for ballast." }; }
    return {}; };
  const sample = Object.assign(async () => ({ text: "" }), { json, limits: () => ({ maxPromptBytes: 262144 }) });
  // An in-memory page database, and a fake "GitHub": fire_trigger ANALYZE <id> marks the request running, then done with the result in pfparts.
  const store = {}, subs = {};
  const snap = (p) => ({ id: p.split("/").pop(), exists: p in store, data: () => store[p] });
  const doc = (p) => ({ get: async () => snap(p), set: async (v) => { store[p] = JSON.parse(JSON.stringify(v)); (subs[p] || []).forEach((f) => f(snap(p))); }, update: async (v) => { store[p] = { ...(store[p] || {}), ...v }; (subs[p] || []).forEach((f) => f(snap(p))); },
    onSnapshot: (f) => { (subs[p] ||= []).push(f); setTimeout(() => f(snap(p)), 0); return () => {}; } });
  const db = { doc, collection: (c) => ({ limit: () => ({ get: async () => ({ docs: Object.keys(store).filter((k) => k.startsWith(c + "/")).map(snap) }) }), doc: (id) => doc(c + "/" + id) }) };
  window.__db = store;
  const gz = async (s) => { const b = await new Response(new Blob([s]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer(); let o = ""; new Uint8Array(b).forEach((x) => (o += String.fromCharCode(x))); return btoa(o); };
  const remote = async (id) => { const p = "pfjobs/" + id, req = JSON.parse(store[p].request);
    await new Promise((r) => setTimeout(r, 1500)); await doc(p).update({ state: "running", started_at: new Date().toISOString(), run_url: "https://github.com/x/y/actions/runs/1" });
    await new Promise((r) => setTimeout(r, 2500)); const syms = req.symbols, v = await json("comparison desk\\n" + syms.map((s) => "=== " + s + ":").join("\\n"));
    const desks = {}; for (const [d, tag] of [["events", "event strategist"], ["macro", "foreign-affairs strategist"], ["street", "Wall Street and sentiment analyst"], ["fundamentals", "fundamentals analyst"]]) desks[d] = window.Compare.cleanDesk(d, await json(tag + "\\n" + syms.map((s) => "=== " + s + ":").join("\\n")), syms);
    const rec = { fp: "x", at: new Date().toISOString(), syms, desks, v: { ...v, headline: "[GitHub] " + v.headline, names: Object.fromEntries(syms.map((s) => [s, { ...v.names[s], strengths: v.names[s].strengths || [], weaknesses: v.names[s].weaknesses || [], watch: v.names[s].watch || [] }])), dimensions: v.dimensions, investors: v.investors, horizons: v.horizons }, checks: [], secs: 300 };
    await doc("pfparts/" + id + ".0").set({ pf: id, i: 0, data: await gz(JSON.stringify({ kind: "compare", sym: [...syms].sort().join(","), at: rec.at, rec })) });
    await doc(p).update({ state: "done", path: "db:pfparts/" + id, parts: 1, done_at: new Date().toISOString(), result: "Analyzed on GitHub" }); };
  const mcp0 = mcp.callTool; mcp.callTool = async (server, tool, input, o) => { if (server === "Claude Code Remote") { window.__calls.push("TRIGGER " + input.text); const [cmd, id] = input.text.split(" "); if (cmd === "ANALYZE" && /^cmp-/.test(id)) remote(id); return { payload: {} }; } return mcp0(server, tool, input, o); };
  window.claude = { use: async (n) => (n === "mcp" ? mcp : n === "sample" ? sample : n === "db" ? db : Promise.reject(new Error("no " + n))) };
})();`;
(async () => {
  const b = await chromium.launch(); const pg = await b.newPage({ viewport: { width: 1400, height: 1000 } });
  const errs = []; pg.on("pageerror", (e) => errs.push(String(e))); pg.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  await pg.addInitScript(brain);
  await pg.goto("file://" + PAGE); await pg.waitForTimeout(1500);
  if (process.env.SEED) { const seed = JSON.parse(fs.readFileSync(process.env.SEED, "utf8"));
    await pg.evaluate((seed) => new Promise((res) => { const r = indexedDB.open("industry-scorer", 1); r.onupgradeneeded = () => r.result.createObjectStore("runs"); r.onsuccess = () => { const db = r.result, tx = db.transaction("runs", "readwrite"); for (const [k, v] of Object.entries(seed)) tx.objectStore("runs").put(v, k); tx.oncomplete = () => res(true); }; }), seed);
    await pg.reload(); await pg.waitForTimeout(1500); }
  await pg.click('button[data-tab="compare"]'); await pg.waitForTimeout(500);
  await pg.screenshot({ path: o("empty.png") });
  await pg.click("#cmp-q"); await pg.keyboard.type("vangu", { delay: 60 }); await pg.waitForTimeout(1500);
  console.log("SUG", await pg.evaluate(() => [...document.querySelectorAll("#cmp-sug [data-csug]")].map((e) => e.textContent)));
  await pg.screenshot({ path: o("sug.png") }); await pg.fill("#cmp-q", "");
  await pg.fill("#cmp-q", process.argv[2] || "AAPL, MSFT, QQQ"); await pg.click('#cmp-form button[type=submit]');
  for (let i = 0; i < 60; i++) { await pg.waitForTimeout(1000); const t = await pg.textContent("#cmp"); if (/Ready to compare/.test(t)) break; }
  await pg.waitForTimeout(500); fs.writeFileSync(o("pre.txt"), await pg.textContent("#cmp")); console.log("PRE errors", errs.filter((e) => !/file:|TUNNEL/.test(e)).slice(0, 8)); await pg.screenshot({ path: o("pre.png"), fullPage: false }); const e0 = await pg.$("#cmp-verdict"); if (e0) await e0.screenshot({ path: o("ready.png") });
  await pg.click("button[data-cmp-run]"); await pg.waitForTimeout(2500); const e1 = await pg.$("#cmp-verdict"); if (e1) await e1.screenshot({ path: o("running.png") });
  await pg.waitForTimeout(2500); const pb = await pg.$(".cx-progs"); if (pb) await pb.screenshot({ path: o("progress.png") }); console.log("PROGRESS", await pg.evaluate(() => [...document.querySelectorAll(".cx-prog")].map((b) => b.textContent.replace(/\s+/g, " ").trim())));
  for (let i = 0; i < 60; i++) { await pg.waitForTimeout(1000); const t = await pg.textContent("#cmp"); if (/Bottom line/.test(t) && !/Comparing on GitHub|Writing the verdict/.test(t)) break; }
  console.log("calls:", (await pg.evaluate(() => window.__calls.filter((x) => /TRIGGER/.test(x)))));
  await pg.evaluate(() => window.AMS?.foldAll(false)); await pg.waitForTimeout(300); // sections start folded; open them all for the checks below
  await pg.waitForTimeout(800);
  const txt = await pg.textContent("#cmp"); fs.writeFileSync(o("text.txt"), txt);
  await pg.screenshot({ path: o("full.png"), fullPage: true });
  for (const id of ["cmp-funds","cmp-macroind","cmp-affairs","cmp-ahead","cmp-macro","cmp-street","cmp-verdict","cmp-lineup","cmp-investors","cmp-dims","cmp-perf","cmp-risk","cmp-h2h","cmp-outlook","cmp-cases","cmp-industry","cmp-together"]) { const e = await pg.$("#"+id); if (e) await e.screenshot({ path: o(id + ".png") }); }
  const bar = await pg.$(".cx-bar"); if (bar) await bar.screenshot({ path: o("bar.png") });
  const mi = await pg.$("#cmp-macroind"); if (mi) { await pg.click('#cx-mi-list .cx-mi-row summary'); await pg.waitForTimeout(300); await mi.screenshot({ path: o("mi-open.png") });
    await pg.click('[data-mi-t="PEP"]'); await pg.click('[data-mi-e="headwind"]'); await pg.waitForTimeout(300); console.log("FILTER", await pg.textContent("#cx-mi-count"));
    const top = await pg.$(".cx-mi-bar"); if (top) await top.screenshot({ path: o("mi-bar.png") }); await pg.click('[data-mi-t=""]'); await pg.click('[data-mi-e=""]');
    console.log("CELLS", await pg.evaluate(() => { const r = [...document.querySelectorAll(".cx-mi-r")]; return { total: r.length, est: r.filter((x) => x.querySelector(".cx-est")).length, ne: r.filter((x) => x.querySelector(".cx-ne")).length, dash: r.filter((x) => /—/.test(x.textContent)).length }; })); }
  if (await pg.$("[data-cmp-write]")) { await pg.click("[data-cmp-write]"); await pg.waitForTimeout(1200); console.log("WRITE", await pg.evaluate(() => window.__calls.filter((x) => /TRIGGER ANALYZE co-|TRIGGER ANALYZE fd-/.test(x))), /Writing its company analysis on GitHub/.test(await pg.textContent("#cmp-lineup")), (await pg.textContent("#cmp")).match(/Writing [A-Z, ]+ on GitHub[^.]*/)?.[0]); }
  await pg.setViewportSize({ width: 390, height: 900 }); await pg.waitForTimeout(400); await pg.screenshot({ path: o("phone.png"), fullPage: false }); for (const id of ["cmp-macroind","cmp-funds"]) { const e = await pg.$("#"+id); if (e) await e.screenshot({ path: o("ph-" + id + ".png") }); }
  const sw = await pg.evaluate(() => document.documentElement.scrollWidth); console.log("phone scrollWidth", sw);
  console.log("errors:", errs.slice(0, 10)); console.log("prompts:", (await pg.evaluate(() => window.__prompts.length)), "prompt bytes", await pg.evaluate(() => (window.__prompts[0] || "").length));
  fs.writeFileSync(o("prompt.txt"), await pg.evaluate(() => window.__prompts[0] || ""));
  await b.close();
})();
