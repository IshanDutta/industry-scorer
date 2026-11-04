// The midday market alarm: one live quote of the S&P 500 (SPY) and the VIX, no Claude. On a crash-sized day it starts
// the daily update right away (with what moved as its note, which makes it a "big day" for the budget) instead of
// waiting for the evening run.
//
// Usage: node shock.mjs            Env: FMP_MCP_URL, FMP_MCP_HEADERS (optional), SHOCK_SPY_PCT (default 2.5),
//                                       SHOCK_VIX_PCT (default 20), SHOCK_FORCE=1 (fire whatever the market did)
// Prints one line; with GITHUB_OUTPUT set, writes fire=true|false and note=... for the workflow.
import { writeFileSync } from "node:fs";
import { McpBridge } from "./lib/mcp.mjs";

const env = process.env;
const out = (k, v) => { if (env.GITHUB_OUTPUT) writeFileSync(env.GITHUB_OUTPUT, `${k}=${String(v).replace(/\n/g, " ")}\n`, { flag: "a" }); };
const spyMax = Number(env.SHOCK_SPY_PCT) || 2.5, vixMax = Number(env.SHOCK_VIX_PCT) || 20;

/** % change today from a short quote ({price, change}); NaN when it can't be read. */
export const pctOf = (q) => { const p = Number(q?.price), c = Number(q?.change); return p > 0 && Number.isFinite(c) && p - c > 0 ? (c / (p - c)) * 100 : NaN; };
/** Is it a shock? Returns {fire, note}. */
export function judge(rows, { spy = spyMax, vix = vixMax } = {}) {
  const by = Object.fromEntries((rows || []).map((r) => [r.symbol, r])), s = pctOf(by.SPY), v = pctOf(by["^VIX"]);
  const f = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`, hit = [];
  if (Number.isFinite(s) && Math.abs(s) >= spy) hit.push(`SPY ${f(s)}`);
  if (Number.isFinite(v) && v >= vix) hit.push(`VIX ${f(v)}`);
  const seen = `SPY ${Number.isFinite(s) ? f(s) : "n/a"}, VIX ${Number.isFinite(v) ? f(v) : "n/a"}`;
  return { fire: hit.length > 0, spy: s, vix: v, note: hit.length ? `Midday market alarm: ${hit.join(", ")} at ${new Date().toISOString().slice(11, 16)} UTC` : `No alarm: ${seen}` };
}

async function main() {
  if (!env.FMP_MCP_URL) { console.error("Missing FMP_MCP_URL (a GitHub Actions secret)."); process.exit(2); }
  let headers = {}; try { headers = env.FMP_MCP_HEADERS ? JSON.parse(env.FMP_MCP_HEADERS) : {}; } catch { console.error("Couldn't read FMP_MCP_HEADERS as JSON."); process.exit(2); }
  const mcp = new McpBridge({ FMP: { url: env.FMP_MCP_URL, headers } }, { log: () => {} });
  await mcp.connect("FMP");
  let rows = [];
  try { const r = await mcp.callTool("FMP", "quote", { endpoint: "batch-quote-short", symbols: ["SPY", "^VIX"] }); rows = readRows(r); }
  finally { await mcp.close?.(); }
  const j = judge(rows);
  if (env.SHOCK_FORCE === "1" && !j.fire) { j.fire = true; j.note = `Manual alarm (${j.note.replace(/^No alarm: /, "")})`; }
  console.log(j.note);
  out("fire", j.fire); out("note", j.note);
}
/** The MCP result as rows: structured content, or JSON in the first text block. */
function readRows(r) {
  const p = r?.payload ?? r?.structuredContent ?? r;
  if (Array.isArray(p)) return p;
  if (Array.isArray(p?.data)) return p.data;
  const t = (r?.content || []).find((b) => b.type === "text")?.text;
  try { const j = JSON.parse(t); return Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : []; } catch { return []; }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error("The alarm couldn't read the market:", e?.message || e); out("fire", false); process.exit(0); });
