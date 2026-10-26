// The page's connectors, from the job: the same FMP and EODHD MCP servers your claude.ai connectors use,
// reached at their URLs (with your keys, from the job's secrets). Calls and results have the shapes the
// claude.ai viewer gives the page, so the page's data code runs unchanged.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The viewer's `payload`: structuredContent, else the first text block parsed as JSON, else that text. */
export function payloadOf(result) {
  if (result?.structuredContent !== undefined && result?.structuredContent !== null) return result.structuredContent;
  const t = (result?.content || []).find((b) => b.type === "text")?.text;
  if (t === undefined) return undefined;
  try { return JSON.parse(t); } catch { return t; }
}

export class McpBridge {
  /** servers: { "FMP": {url, headers}, "EODHD": {url, headers} } (display names the page uses). */
  constructor(servers, { log = console.log, timeoutMs = 120000 } = {}) {
    this.servers = servers; this.log = log; this.timeoutMs = timeoutMs;
    this.clients = new Map(); this.tools = new Map(); this.calls = 0; this.errors = 0;
  }
  async connect(name) {
    const cfg = this.servers[name]; if (!cfg?.url) return null;
    const url = new URL(cfg.url), opts = { requestInit: { headers: cfg.headers || {} } };
    let client = new Client({ name: "industry-scorer-runner", version: "1.0.0" });
    try { await client.connect(new StreamableHTTPClientTransport(url, opts)); }
    catch (e) {
      // Older servers speak SSE only.
      client = new Client({ name: "industry-scorer-runner", version: "1.0.0" });
      try { await client.connect(new SSEClientTransport(url, opts)); }
      catch (e2) { throw new Error(`Couldn't connect to the ${name} MCP server (${String(e?.message || e).slice(0, 160)} / ${String(e2?.message || e2).slice(0, 160)})`); }
    }
    const list = []; let cursor;
    do { const r = await client.listTools(cursor ? { cursor } : {}); list.push(...(r.tools || [])); cursor = r.nextCursor; } while (cursor);
    this.clients.set(name, client); this.tools.set(name, list);
    this.log(`[mcp] ${name}: ${list.length} tools`);
    return client;
  }
  async connectAll() { for (const n of Object.keys(this.servers)) if (this.servers[n]?.url) await this.connect(n); }

  async listTools(server) {
    const names = server ? [server] : [...this.clients.keys()];
    return { servers: names.filter((n) => this.clients.has(n)).map((n) => ({ server: n, kind: "connector", authStatus: "connected", tools: (this.tools.get(n) || []).map((t) => ({ name: t.name, description: t.description || "", annotations: t.annotations })) })) };
  }

  async callTool(server, tool, input) {
    if (!this.clients.has(server)) throw { code: "server_not_connected", server, message: `${server} isn't configured for this job.` };
    this.calls++;
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await this.clients.get(server).callTool({ name: tool, arguments: input || {} }, undefined, { timeout: this.timeoutMs });
        if (result?.isError) {
          const msg = (result.content || []).filter((b) => b.type === "text").map((b) => b.text).join(" ").slice(0, 500) || "The tool reported an error.";
          throw { code: "tool_error", server, message: msg, result };
        }
        return { content: result?.content || [], structuredContent: result?.structuredContent, payload: payloadOf(result) };
      } catch (e) {
        if (e?.code === "tool_error") { this.errors++; throw e; }
        // A protocol-level refusal (bad arguments, unknown tool) is the tool's answer, not a connection problem.
        if (typeof e?.code === "number" && e.code !== -32000 && e.code !== -32001) { this.errors++; throw { code: "tool_error", server, message: String(e.message || e).slice(0, 500), result: null }; }
        // Transport trouble: reconnect and try again a couple of times, then report it the way the viewer would.
        if (attempt < 3) { await sleep(1500 * attempt); try { await this.connect(server); } catch {} continue; }
        this.errors++;
        throw { code: "server_unavailable", server, retryable: true, retryAfterMs: 2000, message: String(e?.message || e).slice(0, 300) };
      }
    }
  }
  async close() { for (const c of this.clients.values()) { try { await c.close(); } catch {} } }
}
