// The daily update against the fake servers: a whole fake sector first, then a daily update on its results.
// Usage: node test/daily.mjs path/to/mock_brain.js
import { spawn } from "node:child_process";
import { readFileSync, rmSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBrain, fakeAnthropic, fakeMcp } from "./fakes.mjs";
const here = dirname(fileURLToPath(import.meta.url));
const brain = loadBrain(process.argv[2]);
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"} ${m}`); if (!c) process.exitCode = 1; };
const read = (p) => JSON.parse(gunzipSync(readFileSync(p)).toString());
const run = (port, out, extra = [], env = {}) => new Promise((resolve) => {
  const p = spawn(process.execPath, [join(here, "../run.mjs"), "--sector", "Technology", "--out", out, ...extra], { env: { ...process.env, ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    FMP_MCP_URL: "http://127.0.0.1:7811/fmp", EODHD_MCP_URL: "http://127.0.0.1:7811/eodhd", CLAUDE_FLUSH_MS: "600", CLAUDE_POLL_MS: "1500", GITHUB_OUTPUT: "", GITHUB_STEP_SUMMARY: join(out, "summary.md"), ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; p.stdout.on("data", (d) => { log += d; process.stdout.write("    " + String(d).trimEnd().replace(/\n/g, "\n    ") + "\n"); }); p.stderr.on("data", (d) => { log += d; process.stderr.write(d); });
  p.on("exit", (code) => resolve({ code, log }));
});
await fakeMcp(brain, { port: 7811 });
const tmp = join(here, ".tmp-daily"); rmSync(tmp, { recursive: true, force: true });
const fa = await fakeAnthropic(brain, { port: 7812 });
const full = await run(7812, join(tmp, "full"));
ok(full.code === 0, `full sector run finished (exit ${full.code})`);
const fullReq = fa.stats.requests;
ok(fa.stats.marked > 0 && fa.stats.cacheHits > 0, `the lead's dossier went first, marked for caching: ${fa.stats.marked} marked requests, ${fa.stats.cacheHits} cache reads`);
{ const ck = read(join(tmp, "full", "checkpoint.json.gz")); ok(ck.sampler?.usage?.cacheRead > 0 && ck.sampler.usage.saved > 0, `the sampler counted cache reads (${ck.sampler?.usage?.cacheRead} tokens, $${(ck.sampler?.usage?.saved || 0).toFixed(4)} saved)`); }
const r = await run(7812, join(tmp, "daily"), ["--daily", "--resume", join(tmp, "full", "checkpoint.json.gz")], { CLAUDE_MODEL_QUICK: "claude-haiku-4-5-20251001" });
ok(r.code === 0, `daily update finished (exit ${r.code})`);
const f = readdirSync(join(tmp, "daily")).find((x) => x.startsWith("results-"));
ok(!!f, "daily results file written");
const recs = f ? read(join(tmp, "daily", f)).records : {};
const runs = Object.entries(recs).filter(([k]) => k.startsWith("run:")).map(([, v]) => v);
ok(runs.length >= 3 && runs.every((x) => x.agent?.result?.daily?.date), `every industry carries today's daily stamp (${runs.length})`);
const rev = runs.filter((x) => x.agent.result.daily.revised && x.agent.result.daily.via !== "rewrite");
ok(rev.length >= 1 && rev.every((x) => x.agent.result.horizons["1M"].daily?.from?.call), `revised industries keep where each call came from (${rev.length} revised)`);
ok(runs.some((x) => !x.agent.result.daily.revised && x.agent.result.daily.via === "triage"), "a quiet industry was stamped after triage, its calls untouched");
const dailyReq = fa.stats.requests - fullReq;
ok(dailyReq > 0 && dailyReq < fullReq / 2, `the daily update used ${dailyReq} Claude requests (the full run used ${fullReq})`);
// Sections the news made stale: the mock's triage names regulation, world events and a rule book for Semiconductors.
const semi = runs.find((v) => v.name === "Semiconductors"), secs = semi?.agent?.result?.daily?.sections || [];
console.log("    sections:", JSON.stringify(secs.map((x) => [x.key, x.ok, x.error || ""])));
ok(secs.some((x) => x.key === "reg" && x.ok) && semi.reports["semiconductors--reg"]?.daily?.date, "a regulation headline rewrote Semiconductors' regulation section, stamped with why");
ok(secs.some((x) => x.key === "world" && x.ok) && semi.reports["semiconductors--world"]?.daily?.date, "a world headline rewrote its world-event deep dives");
ok(secs.some((x) => x.key === "rulebook" && x.ok) && semi.reports["semiconductors--regverdict"]?.daily?.date, "a regulator's rule in the news rebuilt that rule book and the regulatory verdict");
ok(semi.agent.result.sections_rewritten?.reg, "the rewrite dates are recorded");
const bio = runs.find((v) => v.name === "Biotechnology"), fullCk = read(join(tmp, "full", "checkpoint.json.gz")), bio0 = fullCk.records["run:biotechnology"];
const bsec = bio?.agent?.result?.daily?.sections || [];
console.log("    biotech:", JSON.stringify(bsec.map((x) => [x.key, x.ok, x.error || ""])), bio?.agent?.result?.daily?.via);
ok(bsec.some((x) => x.key === "thesis" && x.ok) && bio.agent.run_at !== (typeof bio0 === "string" ? JSON.parse(bio0) : bio0).agent.run_at && bio.agent.result.daily.via === "rewrite", "a changed story rewrote the whole analysis (new thesis, scenarios and calls), stamped as a daily rewrite");
ok(bsec.some((x) => x.key === "macro" && x.ok) && bio.reports["biotechnology--macro"]?.daily?.date, "the macro section was rewritten too");
const sec = recs["sector:technology"]; ok(!!sec?.daily?.date && !!sec.finished_at, "the sector record notes the daily update and stays finished");
const quick = fa.stats.prompts?.filter?.((p) => /^You watch the /.test(p.prompt || p)).length; void quick;
console.log(process.exitCode ? "DAILY TEST FAILED" : "DAILY TEST PASSED"); process.exit(process.exitCode || 0);
