// Fake Anthropic (Messages + Message Batches) and fake FMP/EODHD MCP servers for testing the runner offline.
// Both answer from a "mock brain": the same scripted answers and market data the page's browser tests use.
import http from "node:http";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export function loadBrain(path) {
  const ctx = vm.createContext({ setTimeout, clearTimeout, console, URL });
  ctx.window = ctx;
  vm.runInContext(readFileSync(path, "utf8"), ctx);
  return { sample: () => ctx.claude.use("sample"), mcp: () => ctx.claude.use("mcp") };
}

const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b ? JSON.parse(b) : null)); });
const send = (res, code, obj, type = "application/json") => { res.writeHead(code, { "content-type": type }); res.end(typeof obj === "string" ? obj : JSON.stringify(obj)); };
const textOf = (c) => (typeof c === "string" ? c : (c || []).filter((b) => b.type === "text").map((b) => b.text).join(""));

/** Fake Anthropic API. opts.failAfter: after that many requests, batch creation fails with "credit balance too low". */
export function fakeAnthropic(brain, { port, failAfter = Infinity, batchDelayMs = 800 } = {}) {
  const stats = { requests: 0, batches: 0, toolRounds: 0, direct: 0, cancels: 0, prompts: [] };
  /** The same answer as server-sent events, the way the API streams it. */
  const sse = (res, m) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const ev = (e, d) => res.write(`event: ${e}\ndata: ${JSON.stringify({ type: e, ...d })}\n\n`);
    ev("message_start", { message: { ...m, content: [], stop_reason: null, usage: { ...m.usage, output_tokens: 1 } } });
    m.content.forEach((b, index) => {
      if (b.type === "text") { ev("content_block_start", { index, content_block: { type: "text", text: "" } }); for (let k = 0; k < b.text.length; k += 400) ev("content_block_delta", { index, delta: { type: "text_delta", text: b.text.slice(k, k + 400) } }); }
      else if (b.type === "thinking") { ev("content_block_start", { index, content_block: { type: "thinking", thinking: "" } }); ev("content_block_delta", { index, delta: { type: "signature_delta", signature: b.signature } }); }
      else if (b.type === "tool_use") { ev("content_block_start", { index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } }); ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } }); }
      ev("content_block_stop", { index });
    });
    ev("message_delta", { delta: { stop_reason: m.stop_reason }, usage: { output_tokens: m.usage.output_tokens } });
    ev("message_stop", {}); res.end();
  };
  const batches = new Map(), cached = new Set();
  async function answer(params) {
    stats.requests++;
    const msgs = params.messages;
    // Cached prefix blocks (a dossier sent first): the mock answers by the instructions, so read them first.
    const c0 = msgs[0].content, marked = Array.isArray(c0) && c0.some((b) => b.cache_control) && c0.length > 1;
    const prompt = marked ? textOf(c0.filter((b) => !b.cache_control)) + "\n\n" + textOf(c0.filter((b) => b.cache_control)) : textOf(c0);
    if (marked) stats.marked = (stats.marked || 0) + 1;
    stats.prompts.push(prompt.slice(0, 70));
    const hadTools = msgs.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"));
    const usage = { input_tokens: Math.round(JSON.stringify(msgs).length / 4), output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    if (params.tools?.length && !hadTools && params.tool_choice?.type !== "none") {
      stats.toolRounds++;
      const t = params.tools[0];
      usage.cache_creation_input_tokens = usage.input_tokens; usage.input_tokens = 0; usage.output_tokens = 50;
      return { id: "msg_t", type: "message", role: "assistant", model: params.model, stop_reason: "tool_use", usage,
        content: [{ type: "thinking", thinking: "", signature: "x" }, { type: "tool_use", id: "tu_" + stats.requests, name: t.name, input: { topic: "tariffs", query: "tariffs", keyword: "tariffs", symbols: [], id: "G1", tag: "tariffs" } }] };
    }
    if (hadTools) { usage.cache_read_input_tokens = Math.round(usage.input_tokens * 0.9); usage.input_tokens -= usage.cache_read_input_tokens; }
    else if (marked) for (const b of c0.filter((x) => x.cache_control)) { const n = Math.round(b.text.length / 4); if (cached.has(b.text)) { usage.cache_read_input_tokens += n; stats.cacheHits = (stats.cacheHits || 0) + 1; } else { usage.cache_creation_input_tokens += n; cached.add(b.text); } usage.input_tokens = Math.max(0, usage.input_tokens - n); }
    const sample = await brain.sample();
    let text, stop = "end_turn";
    try { text = JSON.stringify(await sample.json(prompt, { modelTier: "default", tools: [] })); }
    catch (e) { if (e?.code === "invalid_json" && e.text) { text = e.text; stop = "max_tokens"; } else text = "not json"; }
    usage.output_tokens = Math.round(text.length / 4);
    return { id: "msg_" + stats.requests, type: "message", role: "assistant", model: params.model, stop_reason: stop, usage, content: [{ type: "thinking", thinking: "", signature: "x" }, { type: "text", text }] };
  }
  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers["x-api-key"] !== "test-key") return send(res, 401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
      const u = new URL(req.url, "http://x");
      if (req.method === "POST" && u.pathname === "/v1/messages") { stats.direct++; const body = await readBody(req); const m = await answer(body); return body.stream ? sse(res, m) : send(res, 200, m); }
      const cm = u.pathname.match(/^\/v1\/messages\/batches\/([^/]+)\/cancel$/);
      if (req.method === "POST" && cm) { stats.cancels++; const b = batches.get(cm[1]); if (b) { b.status = "ended"; b.results = b.results.length ? b.results : []; } return send(res, 200, { id: cm[1], processing_status: "canceling" }); }
      if (req.method === "POST" && u.pathname === "/v1/messages/batches") {
        const body = await readBody(req);
        if (stats.requests + body.requests.length > failAfter) return send(res, 400, { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } });
        const id = "msgbatch_" + (++stats.batches);
        const b = { id, status: "in_progress", results: [], t: Date.now(), n: body.requests.length };
        batches.set(id, b);
        Promise.all(body.requests.map(async (r) => ({ custom_id: r.custom_id, result: { type: "succeeded", message: await answer(r.params) } })))
          .then((rs) => { b.results = rs; setTimeout(() => (b.status = "ended"), batchDelayMs); });
        return send(res, 200, { id, type: "message_batch", processing_status: "in_progress" });
      }
      const m = u.pathname.match(/^\/v1\/messages\/batches\/([^/]+)(\/results)?$/);
      if (req.method === "GET" && m) {
        const b = batches.get(m[1]); if (!b) return send(res, 404, { error: { type: "not_found_error", message: "no batch" } });
        if (m[2]) return send(res, 200, b.results.map((r) => JSON.stringify(r)).join("\n"), "application/x-jsonl");
        return send(res, 200, { id: b.id, processing_status: b.status, results_url: b.status === "ended" ? `http://127.0.0.1:${port}/v1/messages/batches/${b.id}/results` : null });
      }
      send(res, 404, { error: { type: "not_found_error", message: req.url } });
    } catch (e) { send(res, 500, { error: { type: "api_error", message: String(e?.stack || e) } }); }
  });
  return new Promise((r) => server.listen(port, "127.0.0.1", () => r({ server, stats })));
}

const FMP_TOOLS = ["analyst", "calendar", "chart", "commodity", "company", "directory", "earningsTranscript", "economics", "etfAndMutualFunds", "forex", "form13F", "indexes", "insiderTrades", "marketPerformance", "news", "quote", "search", "statements"];
const EOD_TOOLS = ["get_company_news", "get_sentiment_data", "get_credit_corporate_hqm_yields", "get_credit_corporate_cmdi", "get_rates_reference_rates", "get_ust_real_yield_rates", "get_earnings_trends", "get_fundamentals_data"];

/** Fake FMP (/fmp) and EODHD (/eodhd) MCP servers over streamable HTTP, answering from the mock data. */
export function fakeMcp(brain, { port } = {}) {
  const stats = { calls: 0 };
  const make = (name, tools) => {
    const s = new Server({ name, version: "1.0.0" }, { capabilities: { tools: {} } });
    s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map((t) => ({ name: t, description: `${name} ${t}`, inputSchema: { type: "object", properties: {}, additionalProperties: true } })) }));
    s.setRequestHandler(CallToolRequestSchema, async (req) => {
      stats.calls++;
      const mcp = await brain.mcp();
      const r = await mcp.callTool(name, req.params.name, req.params.arguments || {});
      return { content: [{ type: "text", text: JSON.stringify(r.payload) }] };
    });
    return s;
  };
  const server = http.createServer(async (req, res) => {
    const name = req.url.startsWith("/fmp") ? "FMP" : req.url.startsWith("/eodhd") ? "EODHD" : null;
    if (!name) { res.writeHead(404); return res.end(); }
    const body = req.method === "POST" ? await readBody(req) : undefined;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const s = make(name, name === "FMP" ? FMP_TOOLS : EOD_TOOLS);
    res.on("close", () => { transport.close(); s.close(); });
    await s.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  return new Promise((r) => server.listen(port, "127.0.0.1", () => r({ server, stats })));
}
