// Injected into the Industry Scorer page before it loads (Playwright addInitScript).
// Stands in for the claude.ai viewer: window.claude.use("sample") and use("mcp") with the same call shapes
// the page uses in a viewer, bridged to Node (Anthropic API and your MCP servers). The page's code is unchanged.
(() => {
  const cfg = window.__JOB_CFG__ || {};
  window.__INDUSTRY_SCORER_JOB__ = cfg.job || { industries: 4, pool: 4, bodies: 4 };
  const tools = new Map();
  let seq = 0;
  // Node runs page tools through this while a sample call is in a tool round.
  window.__job_tool = async (callId, name, input) => {
    const t = (tools.get(callId) || []).find((x) => x.name === name);
    if (!t) return { error: "Unknown tool " + name };
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 150000);
    try { const r = await t.execute(input && typeof input === "object" ? input : {}, { signal: ctl.signal }); return { ok: typeof r === "string" ? r : JSON.stringify(r === undefined ? null : r) }; }
    catch (e) { return { error: String((e && e.message) || e) }; }
    finally { clearTimeout(timer); }
  };
  const core = async (verb, input, opts) => {
    opts = opts || {};
    const id = "c" + (++seq);
    if (opts.signal && opts.signal.aborted) throw { code: "cancelled", message: "cancelled" };
    const list = Array.isArray(opts.tools) ? opts.tools : [];
    if (list.length) tools.set(id, list);
    const payload = { verb, input, modelTier: opts.modelTier || "default", step: opts.jobStep ? String(opts.jobStep).slice(0, 120) : null,
      tools: list.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema || { type: "object", properties: {} } })) };
    let onAbort = null;
    const aborted = new Promise((_, rej) => {
      if (!opts.signal) return;
      onAbort = () => { try { window.__job_cancel(id); } catch {} rej({ code: "cancelled", message: "cancelled" }); };
      opts.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const r = await Promise.race([window.__job_sample(id, payload), aborted]);
      if (r.error) throw r.error;
      if (typeof opts.onText === "function" && r.text) { try { opts.onText({ text: r.text, delta: r.text }); } catch {} }
      return verb === "json" ? r.value : { text: r.text, truncated: !!r.truncated, modelTierApplied: payload.modelTier };
    } finally { tools.delete(id); if (onAbort) opts.signal.removeEventListener("abort", onAbort); }
  };
  const sample = (input, opts) => core("text", input, opts);
  sample.json = (input, opts) => core("json", input, opts);
  sample.limits = async () => ({ maxPromptBytes: 262144, tools: { maxCount: 16 } });
  const mcp = {
    listTools: async (server) => { const r = await window.__job_mcp_list(server || null); if (r.error) throw r.error; return r.value; },
    callTool: async (server, tool, input) => { const r = await window.__job_mcp_call(server, tool, input === undefined ? {} : input); if (r.error) throw r.error; return r.value; },
  };
  window.claude = { use: async (name) => ({ mcp, sample })[name] || null };
})();
