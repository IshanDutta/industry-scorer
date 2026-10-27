#!/usr/bin/env node
// Industry Scorer overnight job: analyze every industry in a sector on your own API keys.
//
//   node run.mjs --sector "Consumer Defensive" [--resume checkpoint.json.gz] [--out out] [--deadline-min 330] [--fresh]
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
//   CLAUDE_MODEL                default claude-opus-5-5
//   CLAUDE_MODE                 batch (default) or direct (full price, faster)
//   CLAUDE_STRAGGLER_MIN        a batch still running after this many minutes is re-sent at the standard price (default 20; 0 = never)
//   JOB_FMP_GAP_MS              pause between FMP calls in ms (default 230); raise it if several sectors share a small FMP plan
//   JOB_INDUSTRIES, JOB_POOL, JOB_BODIES   how much runs at once (defaults 4, 4, 4)
//   ANTHROPIC_BASE_URL          for testing only
//
// Exit codes: 0 finished (results written) · 75 out of time, checkpoint written (continue in a new session)
//             1 stopped by an error (results so far and a checkpoint are written).
import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Sampler } from "./lib/sampler.mjs";
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
  const sampler = new Sampler({
    apiKey: need("ANTHROPIC_API_KEY"), baseUrl: env.ANTHROPIC_BASE_URL || undefined, model: env.CLAUDE_MODEL || "claude-opus-5-5",
    mode: env.CLAUDE_MODE === "direct" ? "direct" : "batch", log,
    flushMs: Number(env.CLAUDE_FLUSH_MS || 4000), pollMs: Number(env.CLAUDE_POLL_MS || 20000), stragglerMin: env.CLAUDE_STRAGGLER_MIN ?? 20,
    execTool: (id, name, input) => page.evaluate(([a, b, c]) => window.__job_tool(a, b, c), [id, name, input]),
  });
  let checkpoint = null;
  if (args.resume && existsSync(args.resume)) {
    checkpoint = readMaybeGz(args.resume);
    sampler.load(checkpoint.sampler);
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
  await page.exposeFunction("__job_mcp_list", async (server) => { try { return { value: await mcp.listTools(server) }; } catch (e) { return { error: e }; } });
  await page.exposeFunction("__job_mcp_call", async (server, tool, input) => { try { return { value: await mcp.callTool(server, tool, input) }; } catch (e) { return { error: e }; } });
  const job = { industries: Number(env.JOB_INDUSTRIES || 4), pool: Number(env.JOB_POOL || 4), bodies: Number(env.JOB_BODIES || 4), fmpGapMs: Number(env.JOB_FMP_GAP_MS || 230) };
  await page.addInitScript(`window.__JOB_CFG__ = ${JSON.stringify({ job })};\n` + readFileSync(join(here, "lib/shim.js"), "utf8"));
  // The page is served from a file so its saved runs (IndexedDB) persist for the whole session.
  const html = readFileSync(resolve(here, "../web/industry-scorer.html"), "utf8");
  const pagePath = join(outDir, "industry-scorer-job.html");
  writeFileSync(pagePath, "<!doctype html><html><head><meta charset=utf8><meta name=viewport content='width=device-width,initial-scale=1'></head><body>" + html + "</body></html>");
  await page.goto("file://" + pagePath);
  await page.waitForFunction(() => window.__industryScorer?.ready(), null, { timeout: 120000 });

  if (checkpoint) {
    const n = await page.evaluate((f) => window.__industryScorer.importRecords(f), checkpoint);
    log(`Restored ${n} industries' saved progress`);
  }
  const fresh = args.fresh === "true" && !checkpoint;
  log(`Starting the ${sector} sector run (${job.industries} industries, ${job.pool} agents and ${job.bodies} regulators at once; Claude ${sampler.model}, ${sampler.mode} mode)`);
  await page.evaluate(([s, f]) => window.__industryScorer.start(s, { fresh: f }), [sector, fresh]);

  // Save a checkpoint every 20 minutes while it runs, and again if GitHub stops the job (Cancel, or the session
  // limit), so there is always one to continue from.
  const saveCheckpoint = async (why) => {
    try {
      const full = await page.evaluate((s) => window.__industryScorer.exportSector(s, { full: true }), sector);
      if (!full) return;
      const tmp = join(outDir, "checkpoint.json.gz.part");
      writeGz(tmp, { ...full, sampler: sampler.state() }); renameSync(tmp, join(outDir, "checkpoint.json.gz"));
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
  if (sampler.fatal) { log("[claude] " + sampler.fatal.message); status.notices.push(sampler.fatal.message + " Add credit or raise the spend limit at console.anthropic.com, then run the workflow again for this sector with continue_from set to this run's ID."); }

  // Results (what the page imports) and a checkpoint (results plus the shared working parts and Claude answers).
  const results = await page.evaluate((s) => window.__industryScorer.exportSector(s), sector);
  const full = await page.evaluate((s) => window.__industryScorer.exportSector(s, { full: true }), sector);
  const rec = results?.records?.[`sector:${slug(sector)}`] || {};
  const cost = { ...sampler.usage, usd: Math.round(sampler.usage.usd * 100) / 100, model: sampler.model, mode: sampler.mode, mcp_calls: mcp.calls, mcp_errors: mcp.errors, mcp_throttled: mcp.throttled, minutes: Math.round((Date.now() - t0) / 60000) };
  const stamp = new Date().toISOString().slice(0, 10);
  if (results) { results.job = { cost, finished: !!rec.finished_at }; writeGz(join(outDir, `results-${slug(sector)}-${stamp}.json.gz`), results); }
  if (full) writeGz(join(outDir, "checkpoint.json.gz"), { ...full, sampler: sampler.state() });
  writeFileSync(join(outDir, "cost.json"), JSON.stringify(cost, null, 2));

  const done = rec.done?.H?.length || 0, total = (rec.names || []).filter((n) => !rec.skip?.[n]).length;
  const finished = !!rec.finished_at;
  log(`${finished ? "Finished" : outOfTime ? "Paused (out of time)" : "Stopped"}: ${done} of ${total} industries · ${cost.requests} Claude requests (${cost.cached_results} reused) in ${cost.batches} batches · $${cost.usd} · ${cost.minutes} min`);
  summary([`### ${sector}: ${finished ? "finished" : outOfTime ? "continuing in a new session" : "stopped"}`, "",
    `- Industries finished: **${done} of ${total}**${Object.keys(rec.skip || {}).length ? ` (left out: ${Object.entries(rec.skip).map(([n, w]) => `${n}: ${w}`).join("; ")})` : ""}`,
    `- Claude (${cost.model}, ${cost.mode}): ${cost.requests} requests in ${cost.batches} batches, ${cost.cached_results} reused, ${cost.resent || 0} slow ones re-sent at the standard price · input ${(cost.input / 1e6).toFixed(2)}M tokens, output ${(cost.output / 1e6).toFixed(2)}M, cache reads ${(cost.cacheRead / 1e6).toFixed(2)}M`,
    `- **Estimated Claude cost this session: $${cost.usd}**`, `- Data calls: ${cost.mcp_calls} (${cost.mcp_errors} failed, ${cost.mcp_throttled} waits for the provider's rate limit) · ${cost.minutes} minutes`,
    ...(status.notices.length ? ["", ...status.notices.map((n) => `> ${n}`)] : []),
    ...((rec.failed_steps || []).length ? ["", "<details><summary>Steps that didn't finish</summary>", "", ...rec.failed_steps.map((x) => `- ${x}`), "</details>"] : []),
    "", finished ? "Download the **results** artifact below and import the .json.gz file in Industry Scorer (picker → Import its results file)." : ""].join("\n"));
  setOutput("finished", finished); setOutput("continue", outOfTime && !finished);

  await browser.close(); await mcp.close();
  process.exit(finished ? 0 : outOfTime ? 75 : 1);
}
main().catch((e) => { console.error(e?.stack || e?.message || JSON.stringify(e)); process.exit(1); });
