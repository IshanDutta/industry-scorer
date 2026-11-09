// Which sectors the daily update runs today, and each one's share of the monthly Claude budget.
// Usage: node daily-plan.mjs <dir with runs/*.json.gz>   Env: MONTH_BUDGET (total $ a month, all sectors), ONLY (comma list), BACKFILL=1
// Prints a JSON array [{sector, budget, safety}] for the workflow's matrix. Shares follow each sector's number of
// industries; `safety` is a hard stop for one day (3.2 times its daily share plus $0.03 an industry: the page plans the
// day within its share, and only a big day may spend up to three days' share), in case something runs away.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
const dir = process.argv[2] || "exp", env = process.env;
const total = Number(env.MONTH_BUDGET) || 0, only = String(env.ONLY || "").split(",").map((x) => x.trim()).filter(Boolean);
const rows = [];
const slugOf = (s) => String(s).toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 120);
const runs = join(dir, "runs");
if (existsSync(runs)) for (const f of readdirSync(runs).filter((x) => /^[a-z-]+\.json\.gz$/.test(x))) {
  try {
    const j = JSON.parse(gunzipSync(readFileSync(join(runs, f))).toString());
    const k = Object.keys(j.records || {}).find((x) => /^sector:[^:]+$/.test(x)); let r = k ? j.records[k] : null; if (typeof r === "string") r = JSON.parse(r);
    if (!j.sector || !(j.finished || r?.done?.H?.length)) continue;
    // The calls pass (LEAN_MISSING=1): only the finished industries without calls of their own (none, provisional or the old kind).
    const lacking = (r?.done?.H || []).filter((n) => { if (r?.skip?.[n]) return false; let x = j.records["run:" + slugOf(n)]; if (typeof x === "string") x = JSON.parse(x); const l = x?.agent?.result?.outlook;
      return x?.agent?.result && (!l || l.provisional || l.v !== 3 || !l.calls); }).length;
    if (env.LEAN_MISSING === "1" && !lacking) continue;
    rows.push({ sector: j.sector, n: (r?.names || []).length || 1, lacking });
  } catch (e) { console.error(`${f}: ${e.message}`); }
}
const all = rows.reduce((a, x) => a + x.n, 0) || 1;
const days = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 0)).getUTCDate();
// The history pass (BACKFILL=1): no monthly share; a stop at about $0.20 an industry plus $1. The outlook pass (LEAN=1): $0.15 an industry plus $1.
// A normal day's stop includes $0.02 an industry for the outlooks remade after the calls move.
const backfill = env.BACKFILL === "1", lean = env.LEAN === "1";
const out = rows.filter((x) => !only.length || only.includes(x.sector)).map((x) => { const b = total && !backfill ? Math.round((total * x.n / all) * 100) / 100 : 0;
  return { sector: x.sector, budget: b ? String(b) : "", safety: lean ? String(Math.round((1 + 0.15 * (env.LEAN_MISSING === "1" ? x.lacking : x.n)) * 100) / 100) : backfill ? String(Math.round((1 + 0.2 * x.n) * 100) / 100) : b ? String(Math.round((3.2 * b / days + 0.03 * x.n) * 100) / 100) : "" }; });
process.stdout.write(JSON.stringify(out));
