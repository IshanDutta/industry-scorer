// Which sectors the daily update runs today, and each one's share of the monthly Claude budget.
// Usage: node daily-plan.mjs <dir with runs/*.json.gz>   Env: MONTH_BUDGET (total $ a month, all sectors), ONLY (comma list)
// Prints a JSON array [{sector, budget, safety}] for the workflow's matrix. Shares follow each sector's number of
// industries; `safety` is a hard stop for one day (three times its daily share), in case something runs away.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
const dir = process.argv[2] || "exp", env = process.env;
const total = Number(env.MONTH_BUDGET) || 0, only = String(env.ONLY || "").split(",").map((x) => x.trim()).filter(Boolean);
const rows = [];
const runs = join(dir, "runs");
if (existsSync(runs)) for (const f of readdirSync(runs).filter((x) => /^[a-z-]+\.json\.gz$/.test(x))) {
  try {
    const j = JSON.parse(gunzipSync(readFileSync(join(runs, f))).toString());
    const k = Object.keys(j.records || {}).find((x) => /^sector:[^:]+$/.test(x)); let r = k ? j.records[k] : null; if (typeof r === "string") r = JSON.parse(r);
    if (!j.sector || !(j.finished || r?.done?.H?.length)) continue;
    rows.push({ sector: j.sector, n: (r?.names || []).length || 1 });
  } catch (e) { console.error(`${f}: ${e.message}`); }
}
const all = rows.reduce((a, x) => a + x.n, 0) || 1;
const days = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 0)).getUTCDate();
const out = rows.filter((x) => !only.length || only.includes(x.sector)).map((x) => { const b = total ? Math.round((total * x.n / all) * 100) / 100 : 0;
  return { sector: x.sector, budget: b ? String(b) : "", safety: b ? String(Math.round((3 * b / days) * 100) / 100) : "" }; });
process.stdout.write(JSON.stringify(out));
