#!/usr/bin/env node
// Industry Scorer overnight job: analyze every industry in a sector on your own API keys.
//
//   node run.mjs --sector "Consumer Defensive" [--resume checkpoint.json.gz] [--library library.json.gz] [--out out] [--deadline-min 330] [--fresh]
//
// --library: the shared facts earlier sectors researched (news wire, world situations, countries, regulator
// instruments). The page reuses whatever applies and adds what it researches; out/library.json.gz is the result.
//
// It opens the real Industry Scorer page (web/industry-scorer.html) in headless Chromium and presses
// "Analyze all", exactly as you would. The page's code is unchanged; only its connections are swapped:
//   - Claude: your Anthropic API key, through the Message Batches API (half price) with prompt caching.
//   - Data: your FMP and EODHD MCP servers (the same ones your claude.ai connectors point at).
// Several industries and regulators run at once, so batches are large and the run finishes in hours.
//
// Environment (GitHub Actions secrets):
//   ANTHROPIC_API_KEY           required
//   FMP_MCP_URL                 required  the FMP MCP server URL (including your key if it goes in the URL)
//   EODHD_MCP_URL               optional  the EODHD MCP server URL
//   FMP_MCP_HEADERS / EODHD_MCP_HEADERS   optional JSON of extra headers, e.g. {"Authorization":"Bearer ..."}
//   CLAUDE_MODEL_COMPLEX        model for the page's "complex" steps (default claude-opus-5-5)
//   CLAUDE_MODEL_DEFAULT        model for its "default" steps (default claude-sonnet-5-5); CLAUDE_MODEL sets both
//   CLAUDE_EFFORT_COMPLEX/_DEFAULT   thinking effort (default: each model's own default, as in claude.ai)
//   CLAUDE_BUDGET_USD           most this session may spend on Claude; it stops and saves before going over
//   CLAUDE_MODE                 batch (default) or direct (full price, faster)
//   CLAUDE_STRAGGLER_MIN        a batch still running after this many minutes is re-sent at the standard price (default 20 here, 0 = never in the workflow)
//   CLAUDE_DIRECT_AFTER_MIN     after this many minutes, send everything left at the standard price (default never)
//   JOB_FMP_GAP_MS              pause between FMP calls in ms (default 230); raise it if several sectors share a small FMP plan
//   JOB_INDUSTRIES, JOB_POOL, JOB_BODIES   how much runs at once (defaults 10, 8, 12)
//   JOB_MONTH_BUDGET            daily update: this sector's monthly Claude budget in $; each day spends its share of what's left
//   JOB_DAILY_ONLY              daily update: only these industries (comma list), e.g. the ones a run left unfinished
//   JOB_BACKFILL=1              daily update: the history pass only (Times like this for industries that lack it; no triage, no sections)
//   JOB_SHOCK                   daily update: a midday alarm's note ("SPY -3.1%, VIX +28% at 17:30 UTC"); makes today a big day
//   CLAUDE_MODEL_LEAD           the lead strategist (synthesis, scenarios, calls, red team, investor verdicts) in every run,
//                               and the daily update's whole-analysis update (default: the complex model)
//   JOB_MIN_COMPANIES           leave out industries with fewer companies than this (default 1: every industry is analyzed)
//   ADD_NEW=true (or --add-new)  with --resume of a finished sector: analyze only the industries it doesn't have yet
//   ANTHROPIC_BASE_URL          for testing only
//
// Exit codes: 0 finished (results written) · 75 out of time, checkpoint written (continue in a new session)
//             1 stopped by an error (results so far and a checkpoint are written).
import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Sampler, setCacheTtl } from "./lib/sampler.mjs";
import { McpBridge } from "./lib/mcp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true"]] : a), []));
const sector = args.sector;
if (!sector) { console.error("Usage: node run.mjs --sector \"Consumer Defensive\" [--resume file] [--out dir] [--deadline-min 330] [--fresh]"); process.exit(2); }
const outDir = resolve(args.out || "out"); mkdirSync(outDir, { recursive: true });
const deadline = Date.now() + Number(args["deadline-min"] || 330) * 60000;
const slug = (n) => n.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 120);
const t0 = Date.now();
const log = (...m) => console.log(`[${new Date().toISOString().slice(11, 19)} +${Math.round((Date.now() - t0) / 60000)}m]`, ...m);
const env = process.env;
const need = (k) => { if (!env[k]) { console.error(`Missing ${k}. Add it as a GitHub Actions secret (Settings → Secrets and variables → Actions).`); process.exit(2); } return env[k]; };
const json = (s) => { if (!s) return {}; try { return JSON.parse(s); } catch { console.error("Couldn't read a *_HEADERS secret as JSON."); process.exit(2); } };

const readMaybeGz = (p) => { const b = readFileSync(p); return JSON.parse((b[0] === 0x1f && b[1] === 0x8b ? gunzipSync(b) : b).toString("utf8")); };
const writeGz = (p, obj) => { writeFileSync(p, gzipSync(Buffer.from(JSON.stringify(obj)))); return p; };
const setOutput = (k, v) => { if (env.GITHUB_OUTPUT) writeFileSync(env.GITHUB_OUTPUT, `${k}=${v}\n`, { flag: "a" }); };
const summary = (md) => { if (env.GITHUB_STEP_SUMMARY) writeFileSync(env.GITHUB_STEP_SUMMARY, md + "\n", { flag: "a" }); };

async function main() {
  const mcp = new McpBridge({
    FMP: { url: need("FMP_MCP_URL"), headers: json(env.FMP_MCP_HEADERS) },
    ...(env.EODHD_MCP_URL ? { EODHD: { url: env.EODHD_MCP_URL, headers: json(env.EODHD_MCP_HEADERS) } } : {}),
  }, { log });
  await mcp.connectAll();

  let page = null;
  setCacheTtl(env.CLAUDE_CACHE_TTL || "1h");
  const sampler = new Sampler({
    apiKey: need("ANTHROPIC_API_KEY"), baseUrl: env.ANTHROPIC_BASE_URL || undefined,
    // As the page asks in claude.ai: the most capable model for "complex" steps, the balanced model for the rest.
    models: { complex: env.CLAUDE_MODEL_COMPLEX || env.CLAUDE_MODEL || "claude-opus-5-5", default: env.CLAUDE_MODEL_DEFAULT || env.CLAUDE_MODEL || "claude-sonnet-5-5", quick: env.CLAUDE_MODEL_QUICK || env.CLAUDE_MODEL_DEFAULT || env.CLAUDE_MODEL || "claude-sonnet-5-5", lead: env.CLAUDE_MODEL_LEAD || env.CLAUDE_MODEL_COMPLEX || env.CLAUDE_MODEL || "claude-opus-5-5" },
    effort: { ...(env.CLAUDE_EFFORT_COMPLEX ? { complex: env.CLAUDE_EFFORT_COMPLEX } : {}), ...(env.CLAUDE_EFFORT_DEFAULT ? { default: env.CLAUDE_EFFORT_DEFAULT } : {}) },
    budgetUsd: env.CLAUDE_BUDGET_USD || 0, directConcurrency: Number(env.CLAUDE_DIRECT_CONCURRENCY || 12),
    mode: env.CLAUDE_MODE === "direct" ? "direct" : "batch", log,
    flushMs: Number(env.CLAUDE_FLUSH_MS || 4000), pollMs: Number(env.CLAUDE_POLL_MS || 20000), stragglerMin: env.CLAUDE_STRAGGLER_MIN ?? 20, directAfterMin: env.CLAUDE_DIRECT_AFTER_MIN || 0,
    execTool: (id, name, input) => page.evaluate(([a, b, c]) => window.__job_tool(a, b, c), [id, name, input]),
  });
  let checkpoint = null;
  if (args.resume && existsSync(args.resume)) {
    checkpoint = readMaybeGz(args.resume);
    // Keep the settings the run started with, unless this run sets a model or effort explicitly.
    // A daily update always uses its own (cheaper) models, not the ones the full run started with.
    sampler.load(checkpoint.sampler, { keepSettings: args.daily !== "true" && !["CLAUDE_MODEL", "CLAUDE_MODEL_COMPLEX", "CLAUDE_MODEL_DEFAULT", "CLAUDE_MODEL_QUICK", "CLAUDE_MODEL_LEAD", "CLAUDE_EFFORT_COMPLEX", "CLAUDE_EFFORT_DEFAULT"].some((k) => env[k]) });
    log(`Continuing from a checkpoint saved ${checkpoint.exported_at} (${Object.keys(checkpoint.records || {}).length} saved records, ${sampler.done.size} Claude answers kept, ${sampler.pending.size} still in batches)`);
  }

  // The job (not Playwright) handles stop signals, so the page is still there to save a checkpoint from.
  const browser = await chromium.launch({ handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await ctx.newPage();
  page.on("pageerror", (e) => log("[page error]", String(e).slice(0, 300)));
  page.on("dialog", (d) => d.accept());
  await page.exposeFunction("__job_sample", (id, payload) => sampler.ask(id, payload));
  await page.exposeFunction("__job_cancel", (id) => sampler.cancel(id));
  // What this session has spent so far, for the daily update's budget plan.
  await page.exposeFunction("__job_spent", () => Math.round((sampler.usage.usd - sampler.usdAtStart) * 10000) / 10000);
  await page.exposeFunction("__job_mcp_list", async (server) => { try { return { value: await mcp.listTools(server) }; } catch (e) { return { error: e }; } });
  await page.exposeFunction("__job_mcp_call", async (server, tool, input) => { try { return { value: await mcp.callTool(server, tool, input) }; } catch (e) { return { error: e }; } });
  const job = { industries: Number(env.JOB_INDUSTRIES || 10), pool: Number(env.JOB_POOL || 8), bodies: Number(env.JOB_BODIES || 12), fmpGapMs: Number(env.JOB_FMP_GAP_MS || 230), ...(Number(env.JOB_MIN_COMPANIES) > 0 ? { minCompanies: Number(env.JOB_MIN_COMPANIES) } : {}), ...(Number(env.JOB_MONTH_BUDGET) > 0 ? { monthBudget: Number(env.JOB_MONTH_BUDGET) } : {}), ...(env.JOB_SHOCK ? { shock: String(env.JOB_SHOCK).slice(0, 300) } : {}) };
  await page.addInitScript(`window.__JOB_CFG__ = ${JSON.stringify({ job })};\n` + readFileSync(join(here, "lib/shim.js"), "utf8"));
  // The page is served from a file so its saved runs (IndexedDB) persist for the whole session.
  const html = readFileSync(resolve(here, "../web/industry-scorer.html"), "utf8");
  const pagePath = join(outDir, "industry-scorer-job.html");
  writeFileSync(pagePath, "<!doctype html><html><head><meta charset=utf8><meta name=viewport content='width=device-width,initial-scale=1'></head><body>" + html + "</body></html>");
  await page.goto("file://" + pagePath);
  await page.waitForFunction(() => window.__industryScorer?.ready(), null, { timeout: 120000 });

  if (checkpoint) {
    // In pieces of about 8 MB: a big sector's checkpoint (Industrials is ~100 MB) in one call closes the browser.
    const { records, sampler: _s, library: _l, ...head } = checkpoint, rk = Object.keys(records || {}).find((k) => /^sector:/.test(k));
    let n = 0, chunk = {}, size = 0;
    const flush = async () => { if (!Object.keys(chunk).length) return; n += await page.evaluate((f) => window.__industryScorer.importRecords(f), { ...head, sector: rk && chunk[rk] ? head.sector : undefined, records: chunk }); chunk = {}; size = 0; };
    for (const [k, v] of Object.entries(records || {})) { const z = JSON.stringify(v).length; if (size && size + z > 8e6) await flush(); chunk[k] = v; size += z; }
    await flush();
    log(`Restored ${n} industries' saved progress`);
  }
  // The shared library: facts earlier sectors researched. A checkpoint carries its own copy too.
  for (const lib of [checkpoint?.library, args.library && existsSync(args.library) ? readMaybeGz(args.library) : null].filter(Boolean)) {
    const n = await page.evaluate((l) => window.__industryScorer.importLibrary(l), lib);
    log(`Shared library: ${n.situations} world situations, ${n.countries} countries, ${n.instruments} regulator instruments${n.wire ? ", a news wire" : ""} available to reuse`);
  }
  const fresh = args.fresh === "true" && !checkpoint;
  log(`Starting the ${sector} sector run (${job.industries} industries, ${job.pool} agents and ${job.bodies} regulators at once; Claude ${sampler.models.complex} for complex steps and ${sampler.models.default} for the rest, ${sampler.mode} mode${sampler.budgetUsd ? `, spending cap $${sampler.budgetUsd}` : ""})`);
  const redoGaps = env.REDO_GAPS === "true";
  if (redoGaps) log("Redo gaps: only the lead strategists whose 1M-12M calls left items out are rewritten");
  // --add-new (or ADD_NEW=true): a finished sector keeps everything and analyzes only the industries it doesn't have yet.
  const addNew = args["add-new"] === "true" || env.ADD_NEW === "true";
  if (addNew) log(checkpoint ? "Add new industries: only the industries the last run doesn't have are analyzed; the rest are kept" : `Add new industries: ${sector} has no earlier run, so every industry is analyzed`);
  // --daily: the cheap daily update of a finished sector (data refreshed by code; Claude only where something changed).
  const daily = args.daily === "true";
  if (daily) {
    if (!checkpoint) { console.error(`The daily update needs the sector's last full run: pass it with --resume (the exports branch keeps it as runs/${slug(sector)}.json.gz).`); process.exit(2); }
    log(`Daily update of ${sector} (quick model ${sampler.models.quick} for triage, ${sampler.models.default} for revisions, ${sampler.mode} mode)`);
    const onlyNames = String(env.JOB_DAILY_ONLY || "").split(",").map((x) => x.trim()).filter(Boolean);
    await page.evaluate(([s, c, b, n]) => window.__industryScorer.daily(s, { concurrency: c, backfill: b, ...(n.length ? { names: n } : {}) }), [sector, Number(env.JOB_DAILY_INDUSTRIES || 4), env.JOB_BACKFILL === "1", onlyNames]);
  } else await page.evaluate(([s, f, g, a]) => window.__industryScorer.start(s, { fresh: f, redoGaps: g, addNew: a }), [sector, fresh, redoGaps, addNew]);

  // Save a checkpoint every 20 minutes while it runs, and again if GitHub stops the job (Cancel, or the session
  // limit), so there is always one to continue from.
  const saveCheckpoint = async (why) => {
    try {
      const full = await page.evaluate((s) => window.__industryScorer.exportSector(s, { full: true }), sector);
      if (!full) return;
      const tmp = join(outDir, "checkpoint.json.gz.part");
      const library = await page.evaluate(() => window.__industryScorer.exportLibrary());
      writeGz(tmp, { ...full, sampler: sampler.state(), library }); renameSync(tmp, join(outDir, "checkpoint.json.gz"));
      writeGz(join(outDir, "library.json.gz"), library);
      log(`Checkpoint saved (${why})`);
    } catch (e) { log("Couldn't save a checkpoint: " + String(e?.message || e).slice(0, 200)); }
  };
  let lastSave = Date.now();
  for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, async () => { log(`Stopping (${sig})`); await saveCheckpoint("the job was stopped"); process.exit(1); });

  // Watch it, and stop cleanly before the session runs out of time.
  let last = "", stopped = false, outOfTime = false;
  await page.waitForFunction(() => window.__industryScorer.status().busy, null, { timeout: 60000 }).catch(() => {});
  for (;;) {
    await new Promise((r) => setTimeout(r, 15000));
    const st = await page.evaluate(() => window.__industryScorer.status());
    const line = `${st.phase || "-"} · ${st.label || ""}${st.working.length ? ` · working on: ${st.working.join(", ")}` : ""} · ${st.calls ?? 0} Claude calls · $${sampler.usage.usd.toFixed(2)}`;
    if (line !== last) { log(line); last = line; }
    if (!st.busy) break;
    if (Date.now() - lastSave > 20 * 60000) { lastSave = Date.now(); await saveCheckpoint("every 20 minutes"); }
    if (!stopped && Date.now() > deadline) {
      log("Out of time for this session: stopping cleanly and saving a checkpoint to continue in the next one.");
      stopped = outOfTime = true;
      await page.evaluate(() => window.__industryScorer.stop());
    }
  }
  const status = await page.evaluate(() => window.__industryScorer.status());
  for (const n of status.notices) log("[page]", n);
  if (sampler.fatal) { log("[claude] " + sampler.fatal.message); status.notices.push(sampler.fatal.message + (sampler.fatal.budget ? ". To finish, run the workflow again for this sector with continue_from set to this run's ID (and a new spending cap)." : " Add credit or raise the spend limit at console.anthropic.com, then run the workflow again for this sector with continue_from set to this run's ID.")); }

  // Results (what the page imports) and a checkpoint (results plus the shared working parts and Claude answers).
  const results = await page.evaluate((s) => window.__industryScorer.exportSector(s), sector);
  const full = await page.evaluate((s) => window.__industryScorer.exportSector(s, { full: true }), sector);
  const rec = results?.records?.[`sector:${slug(sector)}`] || {};
  const cost = { ...sampler.usage, usd: Math.round(sampler.usage.usd * 100) / 100, session_usd: Math.round((sampler.usage.usd - sampler.usdAtStart) * 100) / 100, model: `${sampler.models.complex} + ${sampler.models.default}`, mode: sampler.mode, mcp_calls: mcp.calls, mcp_errors: mcp.errors, mcp_throttled: mcp.throttled, minutes: Math.round((Date.now() - t0) / 60000) };
  const stamp = new Date().toISOString().slice(0, 10);
  if (results) { results.job = { cost, finished: !!rec.finished_at }; writeGz(join(outDir, `results-${slug(sector)}-${stamp}.json.gz`), results); }
  const library = await page.evaluate(() => window.__industryScorer.exportLibrary());
  writeGz(join(outDir, "library.json.gz"), library);
  if (full) writeGz(join(outDir, "checkpoint.json.gz"), { ...full, sampler: sampler.state(), library });
  cost.by_step = Object.fromEntries(Object.entries(sampler.byStep).sort((a, b) => b[1].usd - a[1].usd).map(([k, v]) => [k, { ...v, usd: Math.round(v.usd * 100) / 100 }]));
  cost.reuse = status.reuse || null;
  writeFileSync(join(outDir, "cost.json"), JSON.stringify(cost, null, 2));

  const done = rec.done?.H?.length || 0, total = (rec.names || []).filter((n) => !rec.skip?.[n]).length;
  const finished = !!rec.finished_at;
  if (daily) {
    const dd = rec.daily || {};
    log(`Daily update: ${(dd.revised || []).length} industries revised, ${(dd.quiet || []).length} unchanged, ${(dd.failed || []).length} failed · ${cost.requests} Claude requests · $${cost.usd}`);
    summary([`### ${sector}: daily update ${dd.date || ""}`, "", `- Revised calls: **${(dd.revised || []).join(", ") || "none"}**`, `- Unchanged: ${(dd.quiet || []).join(", ") || "none"}`,
      ...((dd.failed || []).length ? [`- Failed: ${dd.failed.join("; ")}`] : []), `- Claude: ${cost.requests} requests, **$${cost.session_usd}** (${cost.mode}) · data calls ${cost.mcp_calls}`, ...status.notices.map((n) => `> ${n}`)].join("\n"));
    await browser.close(); await mcp.close();
    // Reaching the day's spending cap is the budget working, not a failure: what finished is saved.
    process.exit((sampler.fatal && !sampler.fatal.budget) || (env.JOB_BACKFILL !== "1" && !(dd.revised || []).length && !(dd.quiet || []).length) ? 1 : 0);
  }
  for (const [k, v] of Object.entries(cost.by_step)) log(`  ${k}: $${v.usd.toFixed(2)} (${v.requests} requests${v.reused ? `, ${v.reused} reused` : ""})`);
  if (cost.reuse) log(`Reused from earlier sectors: ${cost.reuse.situations} situations, ${cost.reuse.countries} countries, ${cost.reuse.instruments} instruments${cost.reuse.wire ? ", the news wire" : ""}; added ${cost.reuse.added.situations} / ${cost.reuse.added.countries} / ${cost.reuse.added.instruments}`);
  log(`${finished ? "Finished" : outOfTime ? "Paused (out of time)" : "Stopped"}: ${done} of ${total} industries · ${cost.requests} Claude requests (${cost.cached_results} reused) in ${cost.batches} batches · $${cost.usd}${cost.saved ? ` (prompt caching saved $${cost.saved.toFixed(2)})` : ""} · ${cost.minutes} min`);
  summary([`### ${sector}: ${finished ? "finished" : outOfTime ? "continuing in a new session" : "stopped"}`, "",
    `- Industries finished: **${done} of ${total}**${Object.keys(rec.skip || {}).length ? ` (left out: ${Object.entries(rec.skip).map(([n, w]) => `${n}: ${w}`).join("; ")})` : ""}`,
    `- Claude (${cost.model}, ${cost.mode}): ${cost.requests} requests in ${cost.batches} batches, ${cost.cached_results} reused, ${cost.resent || 0} slow ones re-sent at the standard price · input ${(cost.input / 1e6).toFixed(2)}M tokens, output ${(cost.output / 1e6).toFixed(2)}M, cache reads ${(cost.cacheRead / 1e6).toFixed(2)}M`,
    `- **Estimated Claude cost this session: $${cost.session_usd}**${cost.usd !== cost.session_usd ? ` (whole run including earlier sessions: $${cost.usd})` : ""}`, `- Data calls: ${cost.mcp_calls} (${cost.mcp_errors} failed, ${cost.mcp_throttled} waits for the provider's rate limit) · ${cost.minutes} minutes`,
    ...(Object.keys(cost.by_step).length ? ["", "**Claude cost by step (this session)**", "", "| Step | Cost | Requests | Answers reused |", "|---|---:|---:|---:|",
      ...Object.entries(cost.by_step).map(([k, v]) => `| ${k} | $${v.usd.toFixed(2)} | ${v.requests} | ${v.reused || 0} |`)] : []),
    ...(cost.reuse ? ["", `**Taken from earlier sectors:** ${cost.reuse.situations} world situations, ${cost.reuse.countries} countries, ${cost.reuse.instruments} regulator instruments${cost.reuse.wire ? ", the news wire" : ""}. Added to the library for later sectors: ${cost.reuse.added.situations} situations, ${cost.reuse.added.countries} countries, ${cost.reuse.added.instruments} instruments.`] : []),
    ...(status.notices.length ? ["", ...status.notices.map((n) => `> ${n}`)] : []),
    ...((rec.failed_steps || []).length ? ["", "<details><summary>Steps that didn't finish</summary>", "", ...rec.failed_steps.map((x) => `- ${x}`), "</details>"] : []),
    "", finished ? "Download the **results** artifact below and import the .json.gz file in Industry Scorer (picker → Import its results file)." : ""].join("\n"));
  setOutput("finished", finished); setOutput("continue", outOfTime && !finished);
  if (sampler.budgetUsd) setOutput("budget_left", Math.max(0, sampler.budgetUsd - cost.session_usd).toFixed(2));

  await browser.close(); await mcp.close();
  process.exit(finished ? 0 : outOfTime ? 75 : 1);
}
main().catch((e) => { console.error(e?.stack || e?.message || JSON.stringify(e)); process.exit(1); });
