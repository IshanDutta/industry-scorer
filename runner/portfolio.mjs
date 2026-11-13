#!/usr/bin/env node
// Industry Scorer: analyze one portfolio on GitHub (the page's "Analyze" button, run on your own API keys).
//
//   node portfolio.mjs --request request.json --exports <checkout of the exports branch> [--out out] [--deadline-min 60]
//
// It opens the real page in headless Chromium, loads every sector's saved industry runs from the exports branch,
// and runs the same portfolio analysis the page runs in the browser: the report card for today's holdings against
// what the industry runs say a portfolio for the goal should own, the target industry distribution, the best
// companies, every ETF holding them (FMP's reverse lookup), the ETF mixes, stress tests and the strategists' write-up.
// out/portfolio.json.gz is the result the page loads.
//
// request.json: { id, name, total, holdings: [{ ticker, weight (%), name?, price? }], goal: { type, horizon, ... } }
// Environment: ANTHROPIC_API_KEY, FMP_MCP_URL, EODHD_MCP_URL (optional), *_MCP_HEADERS (optional),
//   CLAUDE_MODEL_COMPLEX (default claude-opus-5-5), CLAUDE_MODEL_DEFAULT (claude-sonnet-5-5), CLAUDE_MODE (direct by
//   default here: a handful of calls, wanted quickly), CLAUDE_BUDGET_USD (default 15), JOB_FMP_GAP_MS.
// Exit codes: 0 done · 1 failed.
import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Sampler, setCacheTtl } from "./lib/sampler.mjs";
import { McpBridge } from "./lib/mcp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true"]] : a), []));
const env = process.env, t0 = Date.now();
const log = (...m) => console.log(`[${new Date().toISOString().slice(11, 19)} +${Math.round((Date.now() - t0) / 60000)}m]`, ...m);
const need = (k) => { if (!env[k]) { console.error(`Missing ${k}. Add it as a GitHub Actions secret.`); process.exit(2); } return env[k]; };
const json = (s) => { if (!s) return {}; try { return JSON.parse(s); } catch { console.error("Couldn't read a *_HEADERS secret as JSON."); process.exit(2); } };
const readMaybeGz = (p) => { const b = readFileSync(p); return JSON.parse((b[0] === 0x1f && b[1] === 0x8b ? gunzipSync(b) : b).toString("utf8")); };
const summary = (md) => { if (env.GITHUB_STEP_SUMMARY) writeFileSync(env.GITHUB_STEP_SUMMARY, md + "\n", { flag: "a" }); };

/** The request, checked: an id, holdings with tickers and weights, a goal. Anything else in it is dropped. */
export function cleanRequest(r) {
  if (!r || typeof r !== "object") throw new Error("the request isn't JSON");
  const id = String(r.id || ""); if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error("the request has no valid id");
  const holdings = (Array.isArray(r.holdings) ? r.holdings : []).slice(0, 200).map((h) => ({ ticker: String(h?.ticker || "").toUpperCase().slice(0, 12), weight: Number(h?.weight), name: String(h?.name || "").slice(0, 120), price: Number(h?.price) || null }))
    .filter((h) => /^[A-Z0-9.\-^]{1,12}$/.test(h.ticker) && h.weight > 0);
  const G = r.goal && typeof r.goal === "object" ? r.goal : {}, pick = (k, ok) => (ok(G[k]) ? G[k] : undefined);
  const goal = Object.fromEntries(Object.entries({ type: pick("type", (x) => ["income", "conservative", "growth", "aggressive"].includes(x)), horizon: pick("horizon", (x) => ["1M", "3M", "6M", "12M", "long"].includes(x)),
    maxVol: pick("maxVol", (x) => x === "" || (Number(x) > 0 && Number(x) < 60)), minN: pick("minN", (x) => Number(x) >= 7 && Number(x) <= 15), maxN: pick("maxN", (x) => Number(x) >= 7 && Number(x) <= 15),
    maxCost: pick("maxCost", (x) => Number(x) > 0 && Number(x) <= 2), intl: pick("intl", (x) => typeof x === "boolean"), bonds: pick("bonds", (x) => typeof x === "boolean"),
    exclude: pick("exclude", (x) => typeof x === "string" && x.length < 300), amount: pick("amount", (x) => Number(x) > 0) }).filter(([, v]) => v !== undefined));
  return { id, name: String(r.name || "").slice(0, 120), total: Number(r.total) > 0 ? Number(r.total) : 10000, holdings, goal };
}

async function main() {
  if (!args.request || !existsSync(args.request)) { console.error("Usage: node portfolio.mjs --request request.json --exports <dir> [--out out]"); process.exit(2); }
  const req = cleanRequest(JSON.parse(readFileSync(args.request, "utf8")));
  const outDir = resolve(args.out || "out"); mkdirSync(outDir, { recursive: true });
  const deadline = Date.now() + Number(args["deadline-min"] || 60) * 60000;
  log(`Portfolio "${req.name}" (${req.id}): ${req.holdings.length} holdings, goal ${req.goal.type || "growth"} ${req.goal.horizon || "12M"}`);

  const mcp = new McpBridge({ FMP: { url: need("FMP_MCP_URL"), headers: json(env.FMP_MCP_HEADERS) }, ...(env.EODHD_MCP_URL ? { EODHD: { url: env.EODHD_MCP_URL, headers: json(env.EODHD_MCP_HEADERS) } } : {}) }, { log });
  await mcp.connectAll();
  let page = null;
  setCacheTtl(env.CLAUDE_CACHE_TTL || "5m");
  const sampler = new Sampler({ apiKey: need("ANTHROPIC_API_KEY"), baseUrl: env.ANTHROPIC_BASE_URL || undefined,
    models: { complex: env.CLAUDE_MODEL_COMPLEX || "claude-opus-5-5", default: env.CLAUDE_MODEL_DEFAULT || "claude-sonnet-5-5", quick: env.CLAUDE_MODEL_QUICK || "claude-sonnet-5-5", lead: env.CLAUDE_MODEL_COMPLEX || "claude-opus-5-5" },
    effort: {}, budgetUsd: env.CLAUDE_BUDGET_USD || 15, directConcurrency: 8, mode: env.CLAUDE_MODE === "batch" ? "batch" : "direct", log,
    flushMs: 2000, pollMs: 15000, stragglerMin: 10, directAfterMin: 0, execTool: (id, name, input) => page.evaluate(([a, b, c]) => window.__job_tool(a, b, c), [id, name, input]) });

  const browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  page.on("pageerror", (e) => log("[page error]", String(e).slice(0, 300)));
  await page.exposeFunction("__job_sample", (id, payload) => sampler.ask(id, payload));
  await page.exposeFunction("__job_cancel", (id) => sampler.cancel(id));
  await page.exposeFunction("__job_spent", () => Math.round((sampler.usage.usd - sampler.usdAtStart) * 10000) / 10000);
  await page.exposeFunction("__job_mcp_list", async (server) => { try { return { value: await mcp.listTools(server) }; } catch (e) { return { error: e }; } });
  await page.exposeFunction("__job_mcp_call", async (server, tool, input) => { try { return { value: await mcp.callTool(server, tool, input) }; } catch (e) { return { error: e }; } });
  const job = { industries: 4, pool: 4, bodies: 4, fmpGapMs: Number(env.JOB_FMP_GAP_MS || 230) };
  await page.addInitScript(`window.__JOB_CFG__ = ${JSON.stringify({ job })};\n` + readFileSync(join(here, "lib/shim.js"), "utf8"));
  const html = readFileSync(resolve(here, "../web/industry-scorer.html"), "utf8"), pagePath = join(outDir, "industry-scorer-job.html");
  writeFileSync(pagePath, "<!doctype html><html><head><meta charset=utf8><meta name=viewport content='width=device-width,initial-scale=1'></head><body>" + html + "</body></html>");
  await page.goto("file://" + pagePath);
  await page.waitForFunction(() => window.__industryScorer?.ready(), null, { timeout: 120000 });

  // Every sector's saved industry runs, in pieces of about 8 MB.
  const runsDir = join(resolve(args.exports || "exports"), "runs");
  const files = existsSync(runsDir) ? readdirSync(runsDir).filter((f) => /\.json\.gz$/.test(f) && !/-\d{6,}\.json\.gz$/.test(f)).sort() : [];
  let industries = 0;
  for (const f of files) {
    let j; try { j = readMaybeGz(join(runsDir, f)); } catch (e) { log(`${f}: unreadable (${e.message}); skipped`); continue; }
    if (!j?.records) continue;
    const { records, sampler: _s, library: _l, ...head } = j; head.format ||= "industry-scorer/results";
    let chunk = {}, size = 0;
    const flush = async () => { if (!Object.keys(chunk).length) return; industries += await page.evaluate((x) => window.__industryScorer.importRecords(x), { ...head, records: chunk }); chunk = {}; size = 0; };
    for (const [k, v] of Object.entries(records)) { if (!/^(run|sector):/.test(k)) continue; const z = JSON.stringify(v).length; if (size && size + z > 8e6) await flush(); chunk[k] = v; size += z; }
    await flush();
    log(`${j.sector || f}: loaded`);
  }
  log(`${industries} industry runs loaded from ${files.length} sectors`);
  if (industries < 8) { console.error("Too few industry runs in the exports branch to build a target distribution."); process.exit(1); }

  await page.evaluate((r) => window.__industryScorer.portfolio(r), req);
  let last = "";
  for (;;) {
    await new Promise((r) => setTimeout(r, 10000));
    const st = await page.evaluate(() => window.__industryScorer.portfolioStatus());
    const line = `${st.label} · $${sampler.usage.usd.toFixed(2)}`; if (line !== last) { log(line); last = line; }
    if (!st.busy) { if (st.error) { console.error("The analysis failed: " + st.error); summary(`### Portfolio ${req.name}: failed\n\n> ${st.error}`); process.exit(1); } break; }
    if (Date.now() > deadline) { console.error("Out of time."); process.exit(1); }
  }
  const res = await page.evaluate(() => window.__industryScorer.portfolioResult());
  if (!res) { console.error("No result came back."); process.exit(1); }
  res.job = { id: req.id, cost_usd: Math.round(sampler.usage.usd * 100) / 100, requests: sampler.usage.requests, mcp_calls: mcp.calls, minutes: Math.round((Date.now() - t0) / 60000), run: env.GITHUB_RUN_ID || null, industries };
  writeFileSync(join(outDir, "portfolio.json.gz"), gzipSync(Buffer.from(JSON.stringify(res)), { level: 9 }));
  const g = res.grades || {};
  summary([`### Portfolio ${req.name}: graded ${g.current?.letter || "—"}${g.current ? ` (${Math.round(g.current.score)}/100)` : ""}`, "",
    ...Object.entries(res.sels || {}).filter(([, v]) => v).map(([k, v]) => `- **${k}**: grade ${g[k]?.letter || "—"} · ${v.w.filter((x) => x > 0).length} ETFs · volatility ${(v.vol * 100).toFixed(1)}%`),
    `- ${industries} industry runs · ${res.discovered} ETFs found holding the target companies · Claude $${res.job.cost_usd} (${res.job.requests} requests) · ${res.job.minutes} min`].join("\n"));
  log(`Done: grade ${g.current?.letter || "—"}, Claude $${res.job.cost_usd}, ${res.job.minutes} min`);
  await browser.close(); await mcp.close();
  process.exit(0);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e?.stack || e?.message || JSON.stringify(e)); process.exit(1); });
