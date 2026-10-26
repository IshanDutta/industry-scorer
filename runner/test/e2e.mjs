// End-to-end test of the runner against the fake servers:
//   1. a whole sector in one session (batch mode)  -> exit 0, results file
//   2. a session that runs out of time              -> exit 75, checkpoint
//      then a continuation from that checkpoint     -> exit 0, nothing paid twice
//   3. the API key running out of credit            -> exit 1, results so far and a checkpoint
// Usage: node test/e2e.mjs path/to/mock_brain.js [which tests: 1,2,3]
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBrain, fakeAnthropic, fakeMcp } from "./fakes.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const brainPath = process.argv[2]; const which = (process.argv[3] || "1,2,3").split(",");
const brain = loadBrain(brainPath);
const SECTOR = "Technology";
const read = (p) => JSON.parse(gunzipSync(readFileSync(p)).toString());
const ok = (c, msg) => { console.log(`${c ? "PASS" : "FAIL"} ${msg}`); if (!c) process.exitCode = 1; };

function run(port, out, extra = [], env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(here, "../run.mjs"), "--sector", SECTOR, "--out", out, ...extra], {
      env: { ...process.env, ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, FMP_MCP_URL: "http://127.0.0.1:7801/fmp", EODHD_MCP_URL: "http://127.0.0.1:7801/eodhd",
        CLAUDE_FLUSH_MS: "600", CLAUDE_POLL_MS: "1500", GITHUB_OUTPUT: "", GITHUB_STEP_SUMMARY: join(out, "summary.md"), ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let log = ""; p.stdout.on("data", (d) => { log += d; process.stdout.write("    " + String(d).trimEnd().replace(/\n/g, "\n    ") + "\n"); }); p.stderr.on("data", (d) => { log += d; process.stderr.write(d); });
    p.on("exit", (code) => resolve({ code, log }));
  });
}
const resultsFile = (out) => readdirSync(out).find((f) => f.startsWith("results-"));

await fakeMcp(brain, { port: 7801 });
const tmp = join(here, ".tmp"); rmSync(tmp, { recursive: true, force: true });

if (which.includes("1")) {
  console.log("\n=== 1. whole sector, one session ===");
  const fa = await fakeAnthropic(brain, { port: 7802 });
  const out = join(tmp, "one");
  const r = await run(7802, out);
  ok(r.code === 0, `exit code 0 (got ${r.code})`);
  const f = resultsFile(out); ok(!!f, "results file written");
  if (f) {
    const res = read(join(out, f));
    const rec = res.records[`sector:${SECTOR.toLowerCase()}`];
    ok(!!rec?.finished_at, "sector run finished");
    ok(rec?.done?.H?.length === 3, `3 industries written (got ${rec?.done?.H?.length})`);
    const runs = Object.keys(res.records).filter((k) => k.startsWith("run:"));
    ok(runs.length === 3 && runs.every((k) => res.records[k].agent?.result), "every industry has its lead strategist");
    ok(res.job?.cost?.usd > 0 && res.job.cost.mode === "batch", `cost recorded ($${res.job?.cost?.usd}, ${res.job?.cost?.mode})`);
    ok(fa.stats.batches < fa.stats.requests / 2, `requests grouped into batches (${fa.stats.requests} requests in ${fa.stats.batches} batches)`);
    ok(fa.stats.toolRounds > 0, `tool rounds went through (${fa.stats.toolRounds})`);
    ok(fa.stats.direct === 0, "nothing sent at full price");
  }
  fa.server.close();
}

if (which.includes("2")) {
  console.log("\n=== 2. out of time, then continue from the checkpoint ===");
  const fa = await fakeAnthropic(brain, { port: 7803 });
  const out1 = join(tmp, "two-a"), out2 = join(tmp, "two-b");
  const r1 = await run(7803, out1, ["--deadline-min", "6"]);
  ok(r1.code === 75, `first session paused for time (exit ${r1.code})`);
  ok(existsSync(join(out1, "checkpoint.json.gz")), "checkpoint written");
  const before = fa.stats.requests;
  const r2 = await run(7803, out2, ["--resume", join(out1, "checkpoint.json.gz")]);
  ok(r2.code === 0, `continuation finished (exit ${r2.code})`);
  const f = resultsFile(out2);
  const rec = f && read(join(out2, f)).records[`sector:${SECTOR.toLowerCase()}`];
  ok(!!rec?.finished_at && rec.done.H.length === 3, "continuation completed every industry");
  console.log(`    requests: first session ${before}, continuation ${fa.stats.requests - before}`);
  ok(fa.stats.requests <= 106, `nothing paid twice: ${fa.stats.requests} requests in total vs 100 in one session`);
  fa.server.close();
}

if (which.includes("3")) {
  console.log("\n=== 3. API credit runs out ===");
  const fa = await fakeAnthropic(brain, { port: 7804, failAfter: 30 });
  const out = join(tmp, "three");
  const r = await run(7804, out);
  ok(r.code === 1, `stopped with an error (exit ${r.code})`);
  ok(/credit balance/i.test(r.log), "the reason is in the log");
  ok(existsSync(join(out, "checkpoint.json.gz")), "checkpoint written to continue once credit is added");
  fa.server.close();
}
process.exit();
