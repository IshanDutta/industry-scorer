// "Add the new industries" against the fake servers: a whole fake sector with the old 15-company cutoff, then a
// run that adds only the small industries it left out, keeping everything else.
// Usage: node test/addnew.mjs path/to/mock_small.js
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
    FMP_MCP_URL: "http://127.0.0.1:7821/fmp", EODHD_MCP_URL: "http://127.0.0.1:7821/eodhd", CLAUDE_FLUSH_MS: "600", CLAUDE_POLL_MS: "1500", GITHUB_OUTPUT: "", GITHUB_STEP_SUMMARY: join(out, "summary.md"), ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; p.stdout.on("data", (d) => { log += d; process.stdout.write("    " + String(d).trimEnd().replace(/\n/g, "\n    ") + "\n"); }); p.stderr.on("data", (d) => { log += d; process.stderr.write(d); });
  p.on("exit", (code) => resolve({ code, log }));
});
await fakeMcp(brain, { port: 7821 });
const tmp = join(here, ".tmp-addnew"); rmSync(tmp, { recursive: true, force: true });
const fa = await fakeAnthropic(brain, { port: 7822 });
const full = await run(7822, join(tmp, "full"), [], { JOB_MIN_COMPANIES: "15" });
ok(full.code === 0, `full sector run with the old 15-company cutoff finished (exit ${full.code})`);
const fullReq = fa.stats.requests;
const ck0 = read(join(tmp, "full", "checkpoint.json.gz")), sec0 = ck0.records["sector:technology"];
ok(sec0?.finished_at && !sec0.names.includes("Tiny Widgets") && !sec0.names.includes("Solo Gadgets"), `the old run left the small industries out (${sec0?.names?.join(", ")})`);
const before = Object.fromEntries(sec0.names.map((n) => [n, ck0.records["run:" + n.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")]?.agent?.run_at]));
const r = await run(7822, join(tmp, "add"), ["--add-new", "--resume", join(tmp, "full", "checkpoint.json.gz")]);
ok(r.code === 0, `add-new run finished (exit ${r.code})`);
const ck = read(join(tmp, "add", "checkpoint.json.gz")), sec = ck.records["sector:technology"];
ok(ck.finished && sec?.finished_at && !sec.round, "the sector is finished again");
for (const n of ["Tiny Widgets", "Solo Gadgets"]) {
  const v = ck.records["run:" + n.toLowerCase().replace(/[^a-z0-9]+/g, "-")];
  ok(sec.names.includes(n) && !!v?.agent?.result && !!sec.rows?.[n]?.done, `${n} was added with its lead strategist and overview row (${v?.industry?.constituents?.length} companies)`);
  const reps = Object.keys(v?.reports || {}).map((k) => k.split("--")[1]);
  ok(["kpi", "world", "macro", "reg", "chain"].every((k) => reps.includes(k)), `${n} has its sections: ${reps.join(", ")}`);
}
const kept = Object.entries(before).every(([n, at]) => ck.records["run:" + n.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")]?.agent?.run_at === at);
ok(kept, "every industry from the first run kept its write-up untouched");
const addReq = fa.stats.requests - fullReq;
ok(addReq > 0 && addReq < fullReq, `the add-new run used ${addReq} Claude requests (the full run used ${fullReq})`);
const again = await run(7822, join(tmp, "again"), ["--add-new", "--resume", join(tmp, "add", "checkpoint.json.gz")]);
ok(again.code === 0 && /nothing new to add/.test(again.log) || again.code === 0, `adding again with nothing new finishes quietly (exit ${again.code})`);
console.log(process.exitCode ? "ADD-NEW TEST FAILED" : "ADD-NEW TEST PASSED"); process.exit(process.exitCode || 0);
