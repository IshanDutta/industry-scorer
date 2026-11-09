// Industry Scorer: the run queue and the status file.
//
// Runs in GitHub Actions ("Queue and status" workflow) every hour, whenever a sector run or daily update finishes,
// and on demand. It:
//   1. reads every sector's latest results in the exports branch and works out each industry's status;
//   2. checks that the Anthropic API key still has credit (a one-token request), and, with an Admin key, reads
//      Anthropic's own cost report;
//   3. moves the queue along: up to QUEUE_PARALLEL sectors at once (default 3), started in order, so later ones reuse what the earlier ones
//      researched (the shared library) and nothing runs twice at once. A sector that stops for lack of credit waits
//      and resumes by itself once there is credit again; one that reaches its share of the spending cap is skipped;
//      one that fails for another reason is retried twice. When the queue is done, it can start a daily update of
//      every sector (which also adds "Times like this" to industries that don't have it yet).
//   4. writes status.json (and queue.json, spend-log.json) to the "status" branch.
//
// Usage: node queue.mjs --exports <dir with runs/*.json.gz> --status <dir of the status branch>
// Env: QUEUE_ACTION status | start | stop | resume; QUEUE_ITEMS "Utilities:9, Energy:20" (start); QUEUE_CAP total $;
//      QUEUE_PARALLEL sectors at once (default 3); QUEUE_MODEL auto (Opus strategist, Sonnet analysts) | opus | sonnet; QUEUE_SPEED cheap | quick; QUEUE_THEN_DAILY true | false; GH_TOKEN, GITHUB_REPOSITORY,
//      QUEUE_REF (branch to dispatch on); ANTHROPIC_API_KEY (credit check); ANTHROPIC_ADMIN_KEY (optional cost report);
//      CREDIT_BALANCE_USD + CREDIT_BALANCE_AT (optional: your balance on a date, to estimate what's left).
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const env = process.env;
const exportsDir = args.exports || "exports", statusDir = args.status || "status";
mkdirSync(statusDir, { recursive: true });
const now = new Date().toISOString();
const SECTORS = ["Basic Materials", "Communication Services", "Consumer Cyclical", "Consumer Defensive", "Energy", "Financial Services", "Healthcare", "Industrials", "Real Estate", "Technology", "Utilities"];
const slug = (s) => String(s).toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const readJson = (p, d = null) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return d; } };
const P = (x) => (typeof x === "string" ? JSON.parse(x) : x);
const r2 = (x) => Math.round(x * 100) / 100;
const gh = (a, { quiet = false } = {}) => { try { return execFileSync("gh", a, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", quiet ? "ignore" : "inherit"] }); } catch (e) { if (!quiet) console.error(`gh ${a.slice(0, 3).join(" ")} failed: ${e.message}`); return null; } };

// ------------------------------------------------------------------ every sector's results
const CALL_LEVELS = ["strongly bearish", "slightly bearish", "neutral", "slightly bullish", "strongly bullish"];
function sectorStatus(file) {
  const j = JSON.parse(gunzipSync(readFileSync(file)).toString());
  const k = Object.keys(j.records || {}).find((x) => /^sector:[^:]+$/.test(x)), rec = k ? P(j.records[k]) : null;
  if (!rec) return null;
  const H = new Set(rec.done?.H || []), round = rec.round?.names ? new Set(rec.round.names) : null;
  const industries = (rec.names || []).map((n) => {
    const run = j.records["run:" + slug(n)] ? P(j.records["run:" + slug(n)]) : null, ag = run?.agent, res = ag?.result || {};
    const status = rec.skip?.[n] ? "left out" : H.has(n) ? "done" : "waiting";
    return { name: n, status, why: rec.skip?.[n] || "", companies: run?.industry?.universe?.companies ?? run?.industry?.constituents?.length ?? null,
      analyzed_at: ag?.run_at || null, data_as_of: run?.industry?.as_of || null, daily: res.daily?.date || null, revised: !!res.daily?.revised,
      call_12m: res.horizons?.["12M"]?.call || null, opportunity: rec.rows?.[n]?.opportunity || res.opportunity?.verdict || null,
      times: !!run?.industry?.history?.times?.episodes?.length,
      // The 1M-12M calls (the outlook): "made" (its own, from every component), "provisional" (read off the older calls) or "none".
      calls: res.outlook?.v === 3 && res.outlook.calls && !res.outlook.provisional ? "made" : res.outlook?.calls || res.horizons ? "provisional" : "none",
      calls_date: res.outlook?.v === 3 && !res.outlook.provisional ? res.outlook.date || null : null,
      calls_12m: res.outlook?.v === 3 && !res.outlook.provisional ? res.outlook.calls?.["12M"]?.call || null : null,
      new_scale: Object.values(res.horizons || {}).length > 0 && Object.values(res.horizons).every((x) => CALL_LEVELS.includes(x?.call) && Number.isFinite(x?.conviction)), historian: !!run?.reports?.[slug(n) + "--history"]?.result?.read,
      in_round: round ? round.has(n) : false, updates_since_full: Number(res.rewrites_since_full) || 0, rewrite_due: res.rethink?.same === false || (Number(res.rewrites_since_full) || 0) >= 6 };
  });
  const u = j.sampler?.usage || {};
  return { sector: j.sector, finished: !!j.finished, exported_at: j.exported_at, round: rec.round ? { n: rec.round.n, adding: rec.round.names.length } : null,
    daily: rec.daily?.date || null, usd: r2(u.usd || 0), calls_run: rec.lean_run ? { date: rec.lean_run.date, at: rec.lean_run.at || null, made: (rec.lean_run.made || []).length, failed: (rec.lean_run.failed || []).length, failed_names: (rec.lean_run.failed || []).slice(0, 5), missing_only: !!rec.lean_run.missing_only } : null,
    daily_last: rec.daily ? { usd: rec.daily.spent ?? null, money: rec.daily.day_money ?? null, updated: rec.daily.analyses_updated || 0, quiet: rec.daily.quiet_day ?? null, held: (rec.daily.held_updates || []).length } : null,
    daily_month: rec.daily_spend?.month === now.slice(0, 7) ? { usd: rec.daily_spend.usd || 0, budget: rec.daily_spend.budget || null } : { usd: 0, budget: rec.daily_spend?.budget || null },
    daily_held: (rec.daily?.held || []).length, daily_updated: rec.daily?.analyses_updated || 0, big_day: rec.daily?.date === now.slice(0, 10) ? rec.daily?.big_day || "" : "", requests: u.requests || 0, cache_saved: r2(u.saved || 0), failed_steps: (rec.failed_steps || []).slice(-5), industries };
}
const sectors = {};
const runsDir = join(exportsDir, "runs");
if (existsSync(runsDir)) for (const f of readdirSync(runsDir).filter((x) => /^[a-z-]+\.json\.gz$/.test(x))) {
  try { const s = sectorStatus(join(runsDir, f)); if (s?.sector) sectors[s.sector] = s; } catch (e) { console.error(`${f}: ${e.message}`); }
}

// ------------------------------------------------------------------ GitHub runs
const REPO = env.GITHUB_REPOSITORY;
const listRuns = (wf, n = 40) => JSON.parse(gh(["run", "list", "--repo", REPO, "--workflow", wf, "--limit", String(n), "--json", "databaseId,displayTitle,status,conclusion,createdAt,updatedAt,url,event"], { quiet: true }) || "[]");
const sectorOf = (title) => { const m = String(title || "").match(/^(?:Sector run · |Run )(.+)$/); return m && SECTORS.includes(m[1].trim()) ? m[1].trim() : null; };
const sectorRuns = REPO ? [...listRuns("sector-run.yml"), ...SECTORS.flatMap((s) => listRuns(`run-${slug(s)}.yml`, 5))].map((r) => ({ ...r, sector: sectorOf(r.displayTitle) })) : [];
const dailyRuns = REPO ? listRuns("daily-update.yml", 10) : [];
const active = sectorRuns.filter((r) => r.status !== "completed");
const lastRunOf = (s, since = "") => sectorRuns.filter((r) => r.sector === s && r.createdAt >= since).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0] || null;
/** Why a run stopped: "credits", "budget", "time" or "error" (from its log). */
function reasonOf(run) {
  if (!run || run.conclusion === "success") return run ? "ok" : null;
  const log = gh(["run", "view", String(run.databaseId), "--repo", REPO, "--log"], { quiet: true }) || "";
  if (/credit balance is too low/i.test(log)) return "credits";
  if (/Spending cap reached/i.test(log)) return "budget";
  if (/out of time|code=75/i.test(log)) return "time";
  return run.conclusion === "cancelled" ? "cancelled" : "error";
}

// ------------------------------------------------------------------ Anthropic: credit and cost
async function credit() {
  if (!env.ANTHROPIC_API_KEY) return { ok: null, message: "No API key available to this workflow." };
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 1, messages: [{ role: "user", content: "ok" }] }) });
    if (r.ok) return { ok: true, message: "The API key works and has credit.", checked_at: now };
    const t = await r.text();
    if (/credit balance/i.test(t)) return { ok: false, reason: "credits", message: "Your Anthropic credit balance is too low. Add credits at console.anthropic.com → Plans & Billing.", checked_at: now };
    if (r.status === 401) return { ok: false, reason: "key", message: "The ANTHROPIC_API_KEY secret was refused (401). Check it in the repository's secrets.", checked_at: now };
    if (r.status === 429 || r.status === 529) return { ok: true, message: `The API is busy (${r.status}); the key works.`, checked_at: now };
    return { ok: null, message: `Credit check: HTTP ${r.status}.`, checked_at: now };
  } catch (e) { return { ok: null, message: `Credit check failed: ${e.message}`, checked_at: now }; }
}
/** Anthropic's own cost report (needs an Admin key): this month and the last 30 days, in dollars. */
async function costReport() {
  if (!env.ANTHROPIC_ADMIN_KEY) return null;
  const sum = async (from) => { let total = 0, page = null;
    for (let k = 0; k < 10; k++) {
      const u = new URL("https://api.anthropic.com/v1/organizations/cost_report"); u.searchParams.set("starting_at", from); u.searchParams.set("limit", "31"); if (page) u.searchParams.set("page", page);
      const r = await fetch(u, { headers: { "x-api-key": env.ANTHROPIC_ADMIN_KEY, "anthropic-version": "2023-06-01" } });
      if (!r.ok) throw new Error(`cost report HTTP ${r.status}`);
      const j = await r.json();
      for (const b of j.data || []) for (const x of b.results || []) total += Number(x.amount) || 0; // amounts are in cents
      if (!j.has_more) break; page = j.next_page;
    }
    return r2(total / 100); };
  try {
    const d = new Date(), month = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(), d30 = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10) + "T00:00:00Z";
    const out = { month_to_date: await sum(month), last_30_days: await sum(d30), checked_at: now };
    if (env.CREDIT_BALANCE_AT) out.since_balance = await sum(new Date(env.CREDIT_BALANCE_AT).toISOString());
    return out;
  } catch (e) { return { error: e.message, checked_at: now }; }
}

// ------------------------------------------------------------------ the queue
const qPath = join(statusDir, "queue.json");
let queue = readJson(qPath);
const action = (env.QUEUE_ACTION || "status").toLowerCase();
const totalUsd = () => r2(Object.values(sectors).reduce((a, s) => a + (s.usd || 0), 0));
const log = [];
if (action === "start") {
  const items = String(env.QUEUE_ITEMS || "").split(",").map((x) => x.trim()).filter(Boolean).map((x) => { const [s, b] = x.split(":").map((y) => y.trim()); return { sector: s, budget: Number(b) || 25, state: "waiting", attempts: 0 }; })
    .filter((x) => SECTORS.includes(x.sector));
  if (!items.length) { console.error("QUEUE_ITEMS lists no known sector."); process.exit(2); }
  queue = { id: now, created_at: now, cap: Number(env.QUEUE_CAP) || 200, parallel: Number(env.QUEUE_PARALLEL) || 3, model: env.QUEUE_MODEL || "auto", speed: env.QUEUE_SPEED || "cheap", then_daily: env.QUEUE_THEN_DAILY !== "false",
    start_usd: Object.fromEntries(SECTORS.map((s) => [s, sectors[s]?.usd || 0])), items, daily_dispatched: false, stopped: false, note: "Starting." };
  log.push(`Queue started: ${items.map((i) => `${i.sector} ($${i.budget})`).join(", ")}; cap $${queue.cap}.`);
}
// Daily updates on or off (control.json in the status branch; the daily update and the market alarm read it).
const cPath = join(statusDir, "control.json");
const control = readJson(cPath, {}) || {};
if (action === "daily_off") { control.daily_paused = true; control.daily_changed_at = now; log.push("Daily updates turned off."); }
if (action === "daily_on") { control.daily_paused = false; control.daily_changed_at = now; log.push("Daily updates turned on."); }
// The calls pass: the 1M-12M calls for every finished industry that lacks them (the "Make the calls" button, on GitHub).
const lackingCalls = () => Object.values(sectors).flatMap((x) => x.industries.filter((i) => i.status === "done" && i.calls !== "made").map((i) => ({ sector: x.sector, name: i.name })));
const callsRuns = () => dailyRuns.filter((r) => /calls pass/i.test(r.displayTitle || ""));
function dispatchCalls(why) {
  if (!REPO) return false;
  if (callsRuns().some((r) => r.status !== "completed")) { log.push("The calls pass is already running."); return true; }
  const n = lackingCalls().length; if (!n) { log.push("Every finished industry already has its 1M-12M calls."); control.calls_pass = { ...(control.calls_pass || {}), checked_at: now, nothing_to_do: true }; return true; }
  if (gh(["workflow", "run", "daily-update.yml", "--repo", REPO, "--ref", env.QUEUE_REF || "main", "-f", "lean_missing=true"]) === null) { log.push("Couldn't start the calls pass; trying again at the next check."); return false; }
  control.calls_pass = { dispatched_at: now, why, lacking: n, nothing_to_do: false }; log.push(`Started the calls pass: ${n} industr${n === 1 ? "y" : "ies"} without their 1M-12M calls (${why}).`); return true;
}
writeFileSync(cPath, JSON.stringify(control, null, 2));
// Finish everything: every sector with industries still waiting, smallest first (in-flight ones kept as they are),
// then the history pass (Times like this for every industry that lacks it). No daily update afterwards.
if (action === "finish") {
  // cap 0 (or "none"): no spending cap at all; sectors run until everything is done or the credit runs out.
  const unlimited = ["0", "none", ""].includes(String(env.QUEUE_CAP ?? "").trim().toLowerCase()), cap = unlimited ? 0 : Number(env.QUEUE_CAP) || 0;
  const waitingOf = (sec) => (sectors[sec]?.industries || []).filter((x) => x.status === "waiting").length || (sectors[sec] ? 0 : 10);
  const need = SECTORS.filter((sec) => waitingOf(sec) > 0).sort((a, b) => waitingOf(a) - waitingOf(b));
  if (queue && !queue.finished_at) {
    queue.stopped = false; queue.then_daily = false; queue.then_history = true; queue.then_calls = true; queue.calls_dispatched = null; queue.unlimited = unlimited; if (unlimited) queue.cap = null; else if (cap) queue.cap = cap; queue.parallel = Number(env.QUEUE_PARALLEL) || queue.parallel || 3;
    for (const sec of need) { const it = queue.items.find((i) => i.sector === sec);
      if (!it) queue.items.push({ sector: sec, budget: r2(2 + 3.5 * waitingOf(sec)), state: "waiting", attempts: 0 });
      else if (["budget", "failed", "done", "skipped", "credits"].includes(it.state)) { it.state = "waiting"; it.attempts = 0; it.second_pass = false; } }
    log.push(`Finish everything: ${need.length} sectors with industries still waiting; then Times like this, then the 1M-12M calls, for the rest.`);
  } else {
    queue = { id: now, created_at: now, unlimited, cap: unlimited ? null : cap || r2(need.reduce((a, sec) => a + 2 + 3.5 * waitingOf(sec), 0) + 10), parallel: Number(env.QUEUE_PARALLEL) || 3, model: env.QUEUE_MODEL || "auto", speed: env.QUEUE_SPEED || "cheap",
      then_daily: false, then_history: true, then_calls: true, start_usd: Object.fromEntries(SECTORS.map((sec) => [sec, sectors[sec]?.usd || 0])),
      items: need.map((sec) => ({ sector: sec, budget: r2(2 + 3.5 * waitingOf(sec)), state: "waiting", attempts: 0 })), daily_dispatched: false, stopped: false, note: "Starting." };
    log.push(`Finish everything: ${need.map((sec) => `${sec} (${waitingOf(sec)})`).join(", ") || "no industry is waiting"}; then Times like this, then the 1M-12M calls; cap $${queue.cap}.`);
  }
}
if (action === "calls") dispatchCalls("started by hand");
if (queue && action === "stop") { queue.stopped = true; queue.note = "Stopped. Nothing runs until you press Start the runs."; }
if (queue && action === "resume") { queue.stopped = false; for (const i of queue.items) if (["failed", "credits"].includes(i.state)) { i.state = "waiting"; i.attempts = 0; } }

const cred = await credit(), cost = await costReport();
const spentInQueue = () => (queue ? r2(SECTORS.reduce((a, s) => a + Math.max(0, (sectors[s]?.usd || 0) - (queue.start_usd?.[s] || 0)), 0)) : 0);

function dispatch(item, budget) {
  const f = ["workflow", "run", "sector-run.yml", "--repo", REPO, "--ref", env.QUEUE_REF || "main", "-f", `sector=${item.sector}`, "-f", "add_new=true", "-f", `model=${queue.model}`, "-f", `speed=${queue.speed}`, "-f", `budget=${budget}`];
  return gh(f) !== null;
}
if (queue && !queue.stopped && REPO) {
  // Each sector's limit is a first pass: once every sector has had its turn, a sector that reached its limit with
  // industries still waiting gets one more run from what's left of the queue's total cap (the cap you set is the
  // real limit), sized at about $4 per waiting industry.
  if (!active.length && !queue.items.some((i) => ["waiting", "credits", "dispatched", "running"].includes(i.state))) {
    for (const i of queue.items) { const w = (sectors[i.sector]?.industries || []).filter((x) => x.status === "waiting").length;
      if (i.state === "budget" && !i.second_pass && w > 0) { i.second_pass = true; i.state = "waiting"; i.budget = r2(i.budget + 2 + 4 * w); log.push(`${i.sector}: ${w} industr${w === 1 ? "y" : "ies"} still waiting after its limit; one more run with up to $${r2(2 + 4 * w)} more from the queue's cap.`); } }
  }
  // Several sectors at once (queue.parallel, default 3): each that ends is settled, and free slots are filled in order.
  const par = Math.max(1, Math.min(6, Number(queue.parallel) || Number(env.QUEUE_PARALLEL) || 3)); queue.parallel = par;
  const runningNow = new Set(active.map((r) => r.sector).filter(Boolean));
  for (const it of queue.items) {
    if (runningNow.has(it.sector)) { const r = active.find((x) => x.sector === it.sector); if (it.state !== "running") { it.state = "running"; it.run_url = r?.url; } continue; }
    if (!["running", "dispatched"].includes(it.state)) continue;
    // A sector this queue started that is no longer running: what happened to it?
    const last = lastRunOf(it.sector, it.dispatched_at || "");
    const s = sectors[it.sector];
    if (s?.finished && s.industries.every((x) => x.status !== "waiting")) { it.state = "done"; it.finished_at = now; log.push(`${it.sector} finished.`); }
    else if (last && last.status === "completed") {
      const why = reasonOf(last); it.last_reason = why;
      if (why === "credits") { it.state = "credits"; log.push(`${it.sector} stopped: out of credit.`); }
      else if (why === "budget" && queue.unlimited) { it.attempts = (it.attempts || 0) + 1; it.state = it.attempts >= 5 ? "failed" : "waiting"; log.push(`${it.sector} stopped at the limit it started with; starting it again with no limit.`); }
      else if (why === "budget") { it.state = "budget"; log.push(`${it.sector} reached its spending limit; moving on.`); }
      else if (why === "ok") {
        // A run that ran out of GitHub time continues in a new run by itself: wait for it rather than call the sector done.
        if (s?.industries.some((x) => x.status === "waiting") && Date.now() - Date.parse(last.updatedAt || 0) < 30 * 60000) { /* its continuation is on its way */ }
        else if (s?.industries.some((x) => x.status === "waiting")) { it.attempts = (it.attempts || 0) + 1; it.state = it.attempts >= 3 ? "failed" : "waiting"; log.push(`${it.sector} ended with industries still waiting; ${it.state === "failed" ? "giving up after 3 tries" : "starting it again"}.`); }
        else { it.state = "done"; it.finished_at = now; log.push(`${it.sector} finished.`); }
      }
      else { it.attempts = (it.attempts || 0) + 1; it.state = it.attempts >= 3 ? "failed" : "waiting"; log.push(`${it.sector} stopped (${why}); ${it.state === "failed" ? "giving up after 3 tries" : "retrying"}.`); }
    } else if (!last && Date.now() - Date.parse(it.dispatched_at || 0) > 30 * 60000) { it.state = "waiting"; log.push(`${it.sector}: no run appeared; starting it again.`); }
  }
  // Money already promised to sectors in flight (their limit minus what they've spent), so parallel runs can't overshoot the cap.
  const inFlight = queue.items.filter((i) => ["running", "dispatched"].includes(i.state));
  const promised = inFlight.reduce((a, i) => a + Math.max(0, (i.dispatched_budget || 0) - Math.max(0, (sectors[i.sector]?.usd || 0) - (i.usd_at_dispatch ?? sectors[i.sector]?.usd ?? 0))), 0);
  let left = queue.unlimited ? Infinity : r2(queue.cap - spentInQueue() - promised), slots = par - inFlight.length;
  const started = [];
  while (slots > 0) {
    const next = queue.items.find((i) => ["waiting", "credits"].includes(i.state) && !runningNow.has(i.sector) && !started.includes(i));
    if (!next) break;
    if (cred.ok === false) { next.state = "credits"; queue.note = `${cred.message} The queue carries on by itself within the hour of credit arriving.`; break; }
    if (left < 1) { if (!inFlight.length) { queue.stopped = true; queue.note = `The queue's $${queue.cap} cap is used up ($${spentInQueue()} spent). Raise it and resume to continue.`; } break; }
    if (next.usd_at_first_dispatch === undefined) next.usd_at_first_dispatch = sectors[next.sector]?.usd || 0;
    // Its limit: what was set, raised to what its waiting industries need (about $3.50 each, plus $2 for the sector's
    // shared research), so a sector isn't stopped part-way and run twice; the queue's total cap still bounds it.
    const waitingN = (sectors[next.sector]?.industries || []).filter((x) => x.status === "waiting").length || (sectors[next.sector] ? 0 : 10);
    const want = Math.max(next.budget, r2(2 + 3.5 * waitingN));
    // At least what its waiting industries need now, even if earlier runs of this sector already spent its first limit.
    const budget = queue.unlimited ? "none" : r2(Math.max(1, Math.min(Math.max(want - Math.max(0, (sectors[next.sector]?.usd || 0) - next.usd_at_first_dispatch), waitingN ? 2 + 3.5 * waitingN : 0), left)));
    if (!dispatch(next, budget)) { queue.note = `Couldn't start ${next.sector}; trying again at the next check.`; break; }
    next.state = "dispatched"; next.dispatched_at = now; next.dispatched_budget = budget; next.usd_at_dispatch = sectors[next.sector]?.usd || 0;
    log.push(`Started ${next.sector}${budget === "none" ? " (no spending limit)" : ` (up to $${budget})`}.`); started.push(next); if (budget !== "none") left = r2(left - budget); slots--;
  }
  const busyNow = queue.items.filter((i) => ["running", "dispatched"].includes(i.state)).map((i) => i.sector);
  if (busyNow.length) queue.note = `Running ${busyNow.join(", ")} (${busyNow.length} at once, up to ${par}).`;
  if (queue.items.every((i) => ["done", "skipped", "budget", "failed"].includes(i.state)) && !active.length) {
    // The history pass: Times like this (and the historian's read, and the calls checked against it) for every
    // finished industry that doesn't have it yet. Cheap: about $0.10 an industry.
    if (queue.then_history && !queue.history_dispatched) {
      if (gh(["workflow", "run", "daily-update.yml", "--repo", REPO, "--ref", env.QUEUE_REF || "main", "-f", "backfill=true"]) !== null) { queue.history_dispatched = now; log.push("Every sector is done: started the history pass (Times like this for every industry that lacks it)."); }
    }
    if (queue.then_daily && !queue.daily_dispatched) {
      if (gh(["workflow", "run", "daily-update.yml", "--repo", REPO, "--ref", env.QUEUE_REF || "main"]) !== null) { queue.daily_dispatched = now; log.push("Queue done: started a daily update of every sector."); }
    }
    // Then the calls pass: once the history pass has finished (the calls read Times like this), the 1M-12M calls for
    // every industry still without them. If the history pass couldn't start, the calls go ahead anyway.
    if (queue.then_calls && !queue.calls_dispatched) {
      const hist = dailyRuns.filter((r) => /history pass/i.test(r.displayTitle || "") && (!queue.history_dispatched || r.createdAt >= queue.history_dispatched)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
      const histDone = !queue.then_history || (hist ? hist.status === "completed" : queue.history_dispatched && Date.now() - Date.parse(queue.history_dispatched) > 30 * 60000);
      const busyDaily = dailyRuns.some((r) => r.status !== "completed");
      if (histDone && !busyDaily && dispatchCalls("Finish everything")) queue.calls_dispatched = now;
    }
    queue.finished_at ||= now; queue.note = `Queue finished${queue.history_dispatched ? "; the history pass (Times like this) was started" : ""}${queue.calls_dispatched ? "; the calls pass was started" : queue.then_calls ? "; the calls pass starts when the history pass ends" : ""}${queue.daily_dispatched ? "; a daily update of every sector was started" : ""}.`;
  }
}
writeFileSync(cPath, JSON.stringify(control, null, 2));
if (queue) { queue.updated_at = now; queue.spent = spentInQueue(); queue.log = [...(queue.log || []), ...log.map((t) => ({ at: now, text: t }))].slice(-60); writeFileSync(qPath, JSON.stringify(queue, null, 2)); }

// ------------------------------------------------------------------ spend log and balance
const slPath = join(statusDir, "spend-log.json");
const sl = readJson(slPath, []);
const tot = totalUsd();
if (!sl.length || sl[sl.length - 1].total !== tot) sl.push({ at: now, total: tot });
writeFileSync(slPath, JSON.stringify(sl.slice(-3000)));
let balance = null;
if (env.CREDIT_BALANCE_USD && env.CREDIT_BALANCE_AT) {
  const at = new Date(env.CREDIT_BALANCE_AT).toISOString();
  const base = [...sl].reverse().find((x) => x.at <= at) || sl.find((x) => x.at >= at) || { total: tot };
  const spent = cost?.since_balance ?? r2(tot - base.total);
  balance = { start: Number(env.CREDIT_BALANCE_USD), at, spent_since: spent, estimate: r2(Number(env.CREDIT_BALANCE_USD) - spent), source: cost?.since_balance !== undefined ? "Anthropic cost report" : "tracked by the runs" };
}
const day = (n) => { const t = new Date(Date.now() - n * 864e5).toISOString(); const b = [...sl].reverse().find((x) => x.at <= t) || sl[0]; return r2(tot - (b?.total ?? tot)); };

// ------------------------------------------------------------------ is the daily update working? (the page's indicator)
/** The next scheduled daily update (21:37 UTC every day), and the midday alarm's checks (15:47 and 18:17 UTC, weekdays). */
const nextAt = (h, m, days = [0, 1, 2, 3, 4, 5, 6]) => { const t = new Date(now); for (let k = 0; k < 8; k++) { const c = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + k, h, m));
  if (c > t && days.includes(c.getUTCDay())) return c.toISOString(); } return null; };
function dailyIndicator() {
  const live = dailyRuns.find((r) => r.status !== "completed"), last = dailyRuns.find((r) => r.status === "completed");
  const doneSectors = Object.values(sectors).filter((x) => x.industries.some((i) => i.status === "done"));
  const newest = doneSectors.map((x) => x.daily).filter(Boolean).sort().pop() || null;
  const out = { daily_next_at: nextAt(21, 37), daily_newest: newest, daily_sectors_with_analysis: doneSectors.length,
    daily_sectors_current: newest ? doneSectors.filter((x) => x.daily === newest).length : 0,
    daily_sectors_behind: newest ? doneSectors.filter((x) => x.daily !== newest).map((x) => x.sector).join(", ") || null : null };
  const how = (r) => (r.event === "schedule" ? "on schedule" : r.event === "workflow_dispatch" ? "started early (the market alarm, the queue or by hand)" : r.event);
  if (live) {
    // Which sectors are done and which are working right now (the workflow's matrix jobs).
    const v = JSON.parse(gh(["run", "view", String(live.databaseId), "--repo", REPO, "--json", "jobs"], { quiet: true }) || "{}");
    const jobs = (v.jobs || []).filter((j) => /^update\b/.test(j.name)), nameOf = (j) => (String(j.name).match(/\(([^,)]+)/) || [])[1] || j.name;
    const fin = jobs.filter((j) => j.status === "completed"), wk = jobs.filter((j) => j.status === "in_progress");
    // The history pass (Times like this, calls re-graded): named so, or any run that does work while daily updates are paused.
    const kind = /calls pass/i.test(live.displayTitle || "") ? "calls" : /history pass/i.test(live.displayTitle || "") || (control.daily_paused && jobs.length) ? "history" : "daily";
    const sectorJobs = Object.fromEntries(jobs.map((j) => [nameOf(j), j.status === "completed" ? (j.conclusion === "success" ? "done" : "failed") : j.status === "in_progress" ? "running" : "queued"]));
    return { ...out, daily_state: "running", daily_kind: kind, daily_jobs: sectorJobs, daily_started_at: live.createdAt, daily_how: how(live), daily_url: live.url,
      daily_progress: jobs.length ? `${fin.length} of ${jobs.length} sectors done` : "planning which sectors to update", daily_working: wk.map(nameOf).join(", ") || null,
      daily_failed_sectors: fin.filter((j) => j.conclusion && j.conclusion !== "success").map(nameOf).join(", ") || null };
  }
  if (control.daily_paused) return { ...out, daily_next_at: null, daily_state: "paused", daily_started_at: last?.createdAt || null, daily_finished_at: last?.updatedAt || null, daily_url: last?.url || null, daily_result: last?.conclusion || null,
    daily_note: "Daily updates are off until you turn them back on. The history pass still runs when every sector is done." };
  if (!last) return { ...out, daily_state: doneSectors.length ? "never" : "nothing to update", daily_note: doneSectors.length ? "No daily update has run yet." : "No sector has a finished analysis yet." };
  const ok = last.conclusion === "success", why = ok ? "ok" : reasonOf(last);
  // Overdue: nothing finished in the last 26 hours though something should have.
  const overdue = Date.parse(now) - Date.parse(last.updatedAt) > 26 * 3600e3;
  return { ...out, daily_state: overdue ? "overdue" : ok ? "ok" : why === "credits" ? "credits" : "failed", daily_started_at: last.createdAt, daily_finished_at: last.updatedAt, daily_how: how(last),
    daily_url: last.url, daily_result: last.conclusion, daily_note: overdue ? "The last daily update finished over 26 hours ago." : ok ? null : why === "credits" ? "The last daily update stopped: your Anthropic credit is too low." : `The last daily update ended: ${last.conclusion}.` };
}
const daily = REPO ? dailyIndicator() : {};
const alarmRuns = REPO ? listRuns("market-alarm.yml", 3) : [];
const alarm = { alarm_checked_at: alarmRuns[0]?.createdAt || null, alarm_result: alarmRuns[0] ? alarmRuns[0].conclusion || alarmRuns[0].status : null, alarm_next_at: [nextAt(15, 47, [1, 2, 3, 4, 5]), nextAt(18, 17, [1, 2, 3, 4, 5])].filter(Boolean).sort()[0] };

// ------------------------------------------------------------------ status.json
const status = {
  daily, alarm,
  updated_at: now, repo: REPO || null,
  credit: cred, cost_report: cost, balance,
  spend: { tracked_total: tot, last_24h: day(1), last_7d: day(7), cache_saved: r2(Object.values(sectors).reduce((a, s) => a + (s.cache_saved || 0), 0)),
    by_sector: Object.fromEntries(Object.values(sectors).map((s) => [s.sector, s.usd])), history: sl.slice(-400) },
  queue: queue ? { ...queue, log: (queue.log || []).slice(-20) } : null,
  running: active.map((r) => ({ sector: r.sector, title: r.displayTitle, status: r.status, started: r.createdAt, url: r.url })),
  recent_runs: [...sectorRuns.filter((r) => r.status === "completed"), ...dailyRuns.map((r) => ({ ...r, sector: "every sector (daily update)" }))].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 15)
    .map((r) => ({ sector: r.sector, title: r.displayTitle, conclusion: r.conclusion, started: r.createdAt, ended: r.updatedAt, url: r.url })),
  sectors: SECTORS.map((s) => sectors[s] ? (() => { const x = sectors[s], run = active.find((r) => r.sector === s);
    const ind = x.industries.map((i) => ({ ...i, status: i.status === "waiting" && run ? "working" : i.status }));
    return { ...x, running: !!run, industries: ind, counts: ind.reduce((a, i) => ({ ...a, [i.status]: (a[i.status] || 0) + 1 }), {}) }; })()
    : { sector: s, finished: false, industries: [], counts: {}, usd: 0, running: !!active.find((r) => r.sector === s), never_run: true }),
};
const allInd = status.sectors.flatMap((s) => s.industries);
status.totals = { sectors: SECTORS.length, industries: allInd.length, done: allInd.filter((i) => i.status === "done").length, working: allInd.filter((i) => i.status === "working").length,
  waiting: allInd.filter((i) => i.status === "waiting").length, left_out: allInd.filter((i) => i.status === "left out").length,
  with_times: allInd.filter((i) => i.times).length, with_historian: allInd.filter((i) => i.historian).length,
  with_calls: allInd.filter((i) => i.status === "done" && i.calls === "made").length, lacking_calls: allInd.filter((i) => i.status === "done" && i.calls !== "made").length };
writeFileSync(join(statusDir, "status.json"), JSON.stringify(status, null, 1));

// ------------------------------------------------------------------ the status page's tables (rows, one file each)
const dashDir = join(statusDir, "dash"); mkdirSync(dashDir, { recursive: true });
const W = (name, rows) => writeFileSync(join(dashDir, name + ".json"), JSON.stringify(rows));
const ORDER = { working: 0, waiting: 1, done: 2, "left out": 3 };
// Times like this for one industry: "yes" (it has it, and its calls are on the five-level scale), "running" (the history
// pass is on its sector right now), "queued" (the pass will get to its sector), "failed" (the pass stopped on its sector),
// "old calls" (it has Times like this but its calls still need re-grading) or "no".
const HP = daily.daily_state === "running" && daily.daily_kind === "history" ? daily.daily_jobs || {} : null;
// The 1M-12M calls for one industry: "yes" (its own calls), "running" / "queued" (the calls pass is on its sector now),
// "failed" (the pass stopped on its sector), "provisional" (read off the older calls) or "no".
const CP = daily.daily_state === "running" && daily.daily_kind === "calls" ? daily.daily_jobs || {} : null;
function callsState(sector, i) {
  if (i.status !== "done") return null; if (i.calls === "made") return "yes";
  const j = CP?.[sector]; if (j === "running" || j === "queued") return j; if (j === "failed") return "failed";
  return i.calls === "provisional" ? "provisional" : "no";
}
function timesState(sector, i) {
  const done = i.times && i.new_scale;
  if (i.status !== "done" || done) return done ? "yes" : "no";
  const j = HP?.[sector];
  if (j === "running" || j === "queued") return j; if (j === "failed") return "failed";
  return i.times ? "old calls" : "no";
}
W("industries", status.sectors.flatMap((x) => x.industries.map((i) => ({ sector: x.sector, industry: i.name, status: i.status, order: ORDER[i.status] ?? 9, companies: i.companies,
  analyzed: i.analyzed_at ? i.analyzed_at.slice(0, 10) : null, daily: i.daily,
  since_full: i.status === "done" ? `${i.updates_since_full}${i.rewrite_due ? " · full rewrite due" : ""}` : null, times_like_this: timesState(x.sector, i), calls_scale: i.status !== "done" ? null : i.new_scale ? "new" : "old", historian: i.historian ? "yes" : "no", calls: callsState(x.sector, i), calls_made: i.calls_date, outlook_12m: i.calls_12m, call_12m: i.call_12m, opportunity: i.opportunity }))));
W("sectors", status.sectors.map((x) => ({ sector: x.sector, total: x.industries.length, done: x.counts.done || 0, working: x.counts.working || 0, waiting: x.counts.waiting || 0, left_out: x.counts["left out"] || 0,
  spend_usd: x.usd || 0, state: x.running ? "running" : x.never_run ? "never run" : x.finished ? "finished" : x.round ? "adding industries" : (x.counts.waiting ? "unfinished" : "finished"),
  queue: queue?.items?.find((i) => i.sector === x.sector)?.state || null, last_daily: x.daily || null, daily_updated: x.daily_updated || 0, daily_last_usd: x.daily_last?.usd ?? null, daily_day_money: x.daily_last?.money ?? null, daily_month_usd: r2(x.daily_month?.usd || 0), daily_month_budget: x.daily_month?.budget ?? null,
  daily_quiet: x.daily_last?.quiet ?? null, daily_held: x.daily_last?.held ?? null, big_day: x.big_day || null,
  updating_now: daily.daily_state === "running" && (daily.daily_working || "").split(", ").includes(x.sector), history_now: HP?.[x.sector] || null,
  with_calls: x.industries.filter((i) => i.status === "done" && i.calls === "made").length, lacking_calls: x.industries.filter((i) => i.status === "done" && i.calls !== "made").length,
  calls_now: CP?.[x.sector] || null, calls_last: x.calls_run ? `${x.calls_run.date}: ${x.calls_run.made} made${x.calls_run.failed ? `, ${x.calls_run.failed} failed` : ""}` : null })));
W("queue", (queue?.items || []).map((i, k) => ({ order: k + 1, sector: i.sector, budget_usd: i.budget, state: i.state, started: i.dispatched_at || null, finished: i.finished_at || null, reason: i.last_reason || null })));
W("runs", status.recent_runs.map((r) => ({ when: r.started, what: r.title, sector: r.sector, result: r.conclusion, ended: r.ended, url: r.url })));
W("spend", sl.slice(-400).map((x) => ({ at: x.at, total_usd: x.total })));
W("account", [{ updated_at: now, credit: cred.ok === true ? "OK" : cred.ok === false ? "Out of credit" : "Unknown", credit_message: cred.message,
  tracked_total_usd: tot, last_24h_usd: status.spend.last_24h, last_7d_usd: status.spend.last_7d, cache_saved_usd: status.spend.cache_saved,
  queue_state: !queue ? "none" : queue.stopped ? "stopped" : queue.finished_at ? "finished" : "running",
  queue_cap_usd: queue?.unlimited ? null : queue?.cap ?? null, queue_unlimited: !!queue?.unlimited, queue_model: queue?.model ?? null, queue_spent_usd: queue ? queue.spent : null, queue_left_usd: queue && !queue.unlimited && queue.cap ? r2(queue.cap - queue.spent) : null, queue_note: queue?.note || "No queue",
  balance_estimate_usd: balance?.estimate ?? null, balance_note: balance ? `$${balance.start} on ${balance.at.slice(0, 10)} minus $${balance.spent_since} spent since (${balance.source})` : "Set CREDIT_BALANCE_USD and CREDIT_BALANCE_AT to estimate your balance",
  anthropic_month_usd: cost?.month_to_date ?? null, anthropic_30d_usd: cost?.last_30_days ?? null,
  daily_month_usd: r2(Object.values(sectors).reduce((a, x) => a + (x.daily_month?.usd || 0), 0)),
  daily_month_budget_usd: (() => { const b = Object.values(sectors).map((x) => x.daily_month?.budget).filter((v) => v > 0); return b.length ? r2(b.reduce((a, v) => a + v, 0)) : null; })(),
  daily_held_today: Object.values(sectors).reduce((a, x) => a + (x.daily_held || 0), 0),
  daily_updated_last: Object.values(sectors).reduce((a, x) => a + (x.daily_updated || 0), 0),
  daily_big_day: [...new Set(Object.values(sectors).map((x) => x.big_day).filter(Boolean))].join("; ") || null,
  ...daily, ...alarm, daily_paused: !!control.daily_paused, history_pass: queue?.history_dispatched || null,
  history_running: !!HP, history_url: HP ? daily.daily_url : null, history_started_at: HP ? daily.daily_started_at : null,
  history_sectors_running: HP ? Object.entries(HP).filter(([, v]) => v === "running").map(([k]) => k).join(", ") || null : null,
  history_sectors_done: HP ? Object.values(HP).filter((v) => v === "done").length : null, history_sectors_total: HP ? Object.keys(HP).length : null,
  history_sectors_failed: HP ? Object.entries(HP).filter(([, v]) => v === "failed").map(([k]) => k).join(", ") || null : null,
  with_new_calls: allInd.filter((i) => i.status === "done" && i.new_scale).length,
  with_calls: status.totals.with_calls, lacking_calls: status.totals.lacking_calls,
  calls_running: !!CP, calls_url: CP ? daily.daily_url : callsRuns()[0]?.url || null, calls_started_at: CP ? daily.daily_started_at : control.calls_pass?.dispatched_at || null,
  calls_last_result: callsRuns().find((r) => r.status === "completed")?.conclusion || null, calls_last_finished_at: callsRuns().find((r) => r.status === "completed")?.updatedAt || null,
  calls_sectors_running: CP ? Object.entries(CP).filter(([, v]) => v === "running").map(([k]) => k).join(", ") || null : null,
  calls_sectors_done: CP ? Object.values(CP).filter((v) => v === "done").length : null, calls_sectors_total: CP ? Object.keys(CP).length : null,
  calls_after_finish: queue?.then_calls ? (queue.calls_dispatched ? "started" : "after the history pass") : null,
  industries_done: status.totals.done, industries_total: status.totals.industries, industries_working: status.totals.working, industries_waiting: status.totals.waiting, with_times: status.totals.with_times }]);
console.log(`Status: ${status.totals.done} of ${status.totals.industries} industries done, ${status.totals.working} working, ${status.totals.waiting} waiting · tracked spend $${tot} · credit: ${cred.message}`);
for (const l of log) console.log(l);
if (queue) console.log(`Queue: ${queue.note}`);
