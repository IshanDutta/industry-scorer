#!/usr/bin/env node
/*
 * The Screener tab's data, built once a month on GitHub (the "Screener data" workflow): every US-listed stock, ETF and
 * mutual fund above a size floor, with the numbers the screener filters on. No Claude; FMP only, on your key.
 *
 *   node runner/screener.mjs --out <dir> [--deadline-min 300] [--only etf,fund,stock] [--max 50]
 *
 * For each asset: FMP's company screener (name, size, price, beta, dividend), its dividend-adjusted prices (10 years:
 * total returns 1M-10Y, volatility, Sharpe and beta over 3 years, max drawdown over 5), and for funds the fund facts
 * (expense ratio, asset class, provider, sectors) and country weights, for stocks the financial ratios (P/E, P/B, ...).
 * The page's own module (web/screener.js) turns them into rows, so the page and the job read the same numbers.
 * Writes <out>/screener.json.gz: { v, at, as_of, rf, counts, rows }.
 *
 * Environment: FMP_MCP_URL (and FMP_MCP_HEADERS if needed); SCR_CONC (calls at once, default 8);
 * SCR_MIN_STOCK, SCR_MIN_ETF, SCR_MIN_FUND (smallest market cap or net assets, defaults $300M, $25M, $100M).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { McpBridge } from "./lib/mcp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const Screener = createRequire(import.meta.url)(join(here, "../web/screener.js"));
const arg = (k, d = null) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg("out", "out"), DEADLINE = Date.now() + Number(arg("deadline-min", 300)) * 60000;
const ONLY = (arg("only") || "etf,fund,stock").split(","), MAX = Number(arg("max", 0)) || 0;
const CONC = Number(process.env.SCR_CONC || 8);
const MIN = { stock: Number(process.env.SCR_MIN_STOCK || 3e8), etf: Number(process.env.SCR_MIN_ETF || 2.5e7), fund: Number(process.env.SCR_MIN_FUND || 1e8) };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const late = () => Date.now() > DEADLINE;
const iso = (d) => d.toISOString().slice(0, 10);

const headers = (() => { try { return process.env.FMP_MCP_HEADERS ? JSON.parse(process.env.FMP_MCP_HEADERS) : {}; } catch { return {}; } })();
const mcp = new McpBridge({ FMP: { url: process.env.FMP_MCP_URL, headers } }, { log });
// A test can stand in for FMP: SCR_FAKE=<module exporting fmp(tool, input)> (see test/screener-job.mjs).
const fake = process.env.SCR_FAKE ? await import(process.env.SCR_FAKE) : null;
async function fmp(tool, input) {
  if (fake) return fake.fmp(tool, input);
  const r = await mcp.callTool("FMP", tool, input), p = r?.payload;
  if (Array.isArray(p)) return p; if (p && Array.isArray(p.data)) return p.data; return [];
}
const opt = async (fn, d = null) => { try { return await fn(); } catch { return d; } };
async function pool(items, n, fn) {
  let i = 0, done = 0; const t0 = Date.now();
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length && !late()) { const k = i++; await fn(items[k], k); done++;
      if (done % 250 === 0) log(`  ${done} of ${items.length} (${Math.round((Date.now() - t0) / 1000)}s)`); } }));
  return done;
}
function toSeries(rows) {
  const pts = rows.filter((r) => r?.date && +r.adjClose > 0).map((r) => [String(r.date).slice(0, 10), +r.adjClose]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const dates = [], closes = []; for (const [d, c] of pts) { if (dates[dates.length - 1] === d) continue; dates.push(d); closes.push(c); }
  return { dates, closes };
}

(async () => {
  if (!process.env.FMP_MCP_URL && !fake) { console.error("FMP_MCP_URL isn't set."); process.exit(2); }
  if (!fake) await mcp.connectAll();
  const to = iso(new Date()), from10 = iso(new Date(Date.now() - (10 * 365.25 + 20) * 864e5));

  // 1. The universe.
  const base = { endpoint: "search-company-screener", isActivelyTrading: true, limit: 10000 };
  const Q = {
    stock: { ...base, exchange: "NYSE,NASDAQ,AMEX", isEtf: false, isFund: false, marketCapMoreThan: MIN.stock },
    etf: { ...base, exchange: "NYSE,NASDAQ,AMEX", isEtf: true, marketCapMoreThan: MIN.etf },
    fund: { ...base, isFund: true, country: "US", marketCapMoreThan: MIN.fund },
  };
  const rows = [], seen = new Set();
  for (const t of ONLY) {
    let got = await fmp("search", Q[t]);
    got = got.filter((r) => r?.symbol && !seen.has(r.symbol) && (t !== "stock" || (!r.isEtf && !r.isFund)) && (t !== "etf" || r.isEtf) && (t !== "fund" || (r.isFund && !r.isEtf)));
    if (t === "fund") got = got.filter((r) => /^[A-Z]{4}X$/.test(r.symbol)); // US mutual fund tickers
    if (t !== "fund") got = got.filter((r) => /^[A-Z]{1,5}(\.[A-Z])?$/.test(r.symbol));
    got.sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0)); if (MAX) got = got.slice(0, MAX);
    for (const r of got) { seen.add(r.symbol); rows.push(Screener.row(r, t)); }
    log(`${t}: ${got.length}`);
  }
  const by = Object.fromEntries(rows.map((o) => [o.s, o]));

  // 2. The S&P 500 and cash, for beta and Sharpe.
  const spy = toSeries(await fmp("chart", { endpoint: "historical-price-eod-dividend-adjusted", symbol: "SPY", from_date: from10, to_date: to }));
  const asOf = spy.dates[spy.dates.length - 1];
  const rf3 = []; for (let k = 0; k < 13; k++) { const a = new Date(Date.now() - (k + 1) * 90 * 864e5), b = new Date(Date.now() - k * 90 * 864e5);
    for (const r of await opt(() => fmp("economics", { endpoint: "treasury-rates", from_date: iso(a), to_date: iso(b) }), [])) if (+r?.month3 > 0) rf3.push(+r.month3 / 100); }
  const rf = rf3.length ? rf3.reduce((s, x) => s + x, 0) / rf3.length : 0.04;
  log(`SPY to ${asOf}; cash over 3 years ${(rf * 100).toFixed(2)}%`);

  // 3. Prices: total returns and risk.
  log(`prices for ${rows.length}`);
  await pool(rows, CONC, async (o) => {
    const ser = toSeries(await opt(() => fmp("chart", { endpoint: "historical-price-eod-dividend-adjusted", symbol: o.s, from_date: from10, to_date: to }), []));
    if (ser.dates.length < 15) return;
    Screener.returnsFromSeries(o, ser); Object.assign(o, Screener.metrics(ser, spy, rf));
  });
  // Anything the prices didn't cover: FMP's price changes, 100 at a time.
  const noR = rows.filter((o) => !o.r).map((o) => o.s);
  for (let i = 0; i < noR.length && !late(); i += 100) for (const ch of await opt(() => fmp("quote", { endpoint: "quote-change", symbol: noR.slice(i, i + 100).join(",") }), [])) if (by[ch?.symbol]) Screener.withReturns(by[ch.symbol], ch);

  // 4. Funds: facts and country weights. Stocks: ratios.
  const funds = rows.filter((o) => o.t !== "stock"), stocks = rows.filter((o) => o.t === "stock");
  log(`fund facts for ${funds.length}`);
  await pool(funds, CONC, async (o) => {
    const [info, ctry] = await Promise.all([opt(() => fmp("etfAndMutualFunds", { endpoint: "information", symbol: o.s }), []), opt(() => fmp("etfAndMutualFunds", { endpoint: "country-weighting", symbol: o.s }), [])]);
    Screener.withInfo(o, info, ctry);
  });
  log(`ratios for ${stocks.length}`);
  await pool(stocks, CONC, async (o) => { Screener.withRatios(o, await opt(() => fmp("statements", { endpoint: "metrics-ratios-ttm", symbol: o.s }), [])); });

  // 5. Size, style, category and region; write.
  Screener.derive(rows);
  const clean = rows.map((o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== "")));
  const counts = Object.fromEntries(ONLY.map((t) => [t, rows.filter((o) => o.t === t).length]));
  const doc = { v: 1, at: new Date().toISOString(), as_of: asOf, rf: Math.round(rf * 1e4) / 1e4, counts, partial: late() || undefined, rows: clean };
  mkdirSync(OUT, { recursive: true });
  const gz = gzipSync(Buffer.from(JSON.stringify(doc)), { level: 9 });
  writeFileSync(join(OUT, "screener.json.gz"), gz);
  const have = (k) => rows.filter((o) => o[k] !== undefined && o[k] !== null).length;
  log(`wrote ${rows.length} rows (${(gz.length / 1e6).toFixed(1)} MB): returns ${have("r")}, volatility ${have("v3")}, expense ratio ${have("er")}, P/E ${have("pe")}; ${mcp.calls} FMP calls, ${mcp.errors} errors, ${mcp.throttled} slowed down${late() ? "; stopped at the deadline" : ""}`);
  await mcp.close();
})().catch((e) => { console.error(e?.message || e); process.exit(1); });
