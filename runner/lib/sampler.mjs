// Claude for the headless page, on your own Anthropic API key.
//
// Every call the page makes (`sample.json` with a prompt, a model tier and sometimes page tools) becomes a
// Messages API request. In "batch" mode requests are collected for a few seconds and sent together through the
// Message Batches API (half price); tool rounds re-send the conversation with a prompt-cache breakpoint so each
// later round re-reads it at the cache price. Results are kept by request hash, so a job that continues in a
// new session picks up answers (and batches still running) instead of paying for them twice.
import { createHash } from "node:crypto";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (o) => createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 40);

// USD per million tokens for Claude Opus 5.5 (platform.claude.com pricing). Batch halves input and output.
export const PRICES = {
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
};

const FRAMING_JSON = "Your reply will be read by a program as one JSON value. Reply with only the JSON value the instructions ask for, with no text, Markdown fence or commentary before or after it.";
const FRAMING_TOOLS = " You may call the tools provided to gather what you need; your final message, after any tool use, is the one that is parsed.";
const LAST_ROUND = "That was your last tool round: no more tool calls are available. Write your final answer now.";
const LAST_ROUND_JSON = "That was your last tool round: no more tool calls are available. Write your final answer now, as only the JSON value the instructions ask for, complete, with nothing before or after it.";
const REPAIR_JSON = "Your reply above couldn't be read as one JSON value. Reply again with only the JSON value the original instructions ask for, complete, with nothing before or after it.";
/** Add a text turn after the last user message's content (tool results), so it sits in the same user turn. */
const withNote = (messages, note) => { const m = messages.slice(); const last = m[m.length - 1];
  if (last?.role === "user") m[m.length - 1] = { ...last, content: [...(typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content), { type: "text", text: note }] };
  else m.push({ role: "user", content: note });
  return m; };

/** The platform's tolerant JSON read: the whole reply; else one fenced block; else first { or [ to last } or ]. */
export function parseJsonReply(text) {
  const t = String(text || "").trim();
  try { return { ok: true, value: JSON.parse(t) }; } catch {}
  const fence = t.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  if (fence) { try { return { ok: true, value: JSON.parse(fence[1].trim()) }; } catch {} }
  const a = t.search(/[[{]/), b = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if (a >= 0 && b > a) { try { return { ok: true, value: JSON.parse(t.slice(a, b + 1)) }; } catch {} }
  return { ok: false };
}

function toMessages(input) {
  if (typeof input === "string") return [{ role: "user", content: input }];
  const out = [];
  for (const m of Array.isArray(input) ? input : []) {
    const role = m.role === "assistant" ? "assistant" : "user";
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].content += "\n\n" + m.content;
    else out.push({ role, content: String(m.content || "") });
  }
  return out;
}

/** Put one cache breakpoint on the last block of the last user message (for multi-round tool calls). */
function withCacheBreakpoint(messages) {
  const msgs = messages.map((m) => ({ ...m, content: typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content.map((b) => { const { cache_control, ...x } = b; return x; }) }));
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "user") { const c = msgs[i].content; c[c.length - 1] = { ...c[c.length - 1], cache_control: { type: "ephemeral" } }; break; }
  return msgs;
}

/** The report's step names, from the page's step labels (or its phase when a call has no label). */
export function stepCategory(step) {
  const s = String(step || "");
  const rules = [[/^Rule book/i, "Regulator rule books"], [/^Situation analyst/i, "World events (facts and impacts)"], [/^Trade-relations analyst/i, "Country facts"],
    [/^Indicator analyst|^Finding the news behind/i, "Macro indicators"], [/^Macro planner/i, "Macro planner"], [/^World-events scout/i, "World-events scout"],
    [/^Trade relations:/i, "Trade write-ups (each industry)"], [/^Supply-chain verdict/i, "Supply-chain verdicts"], [/^World events:/i, "World write-ups (each industry)"],
    [/^kpi$/, "KPI and earnings-call analysts"], [/^team$/, "Trade map, customers & suppliers, regulation analysts"], [/^write$/, "Macro strategist, regulatory verdict, lead strategist"],
    [/^shared$/, "Shared research (other)"], [/^macro$/, "Macro planner"], [/^scout$/, "World-events scout"]];
  for (const [re, name] of rules) if (re.test(s)) return name;
  return s ? s.replace(/:.*$/, "").slice(0, 60) : "Other";
}

export class Sampler {
  // Models per tier, as the claude.ai page asks for them: "complex" = the most capable model, "default" = the
  // balanced everyday model, "quick" = the fast one. Each at its own default thinking effort (effort = {} leaves the
  // model's default; pass e.g. {complex: "high"} to override).
  constructor({ apiKey, baseUrl = "https://api.anthropic.com", models = { complex: "claude-opus-5-5", default: "claude-sonnet-5-5", quick: "claude-sonnet-5-5" }, mode = "batch", effort = {}, budgetUsd = 0,
    maxTokens = 64000, maxRounds = 8, flushMs = 4000, pollMs = 20000, directConcurrency = 6, stragglerMin = 20, directAfterMin = 0, execTool, log = console.log }) {
    Object.assign(this, { apiKey, baseUrl: baseUrl.replace(/\/$/, ""), models, model: models.complex, mode, effort, maxTokens, maxRounds, flushMs, pollMs, directConcurrency, execTool, log });
    // A batch still running after this long has its requests re-sent at the standard price (0 = never).
    this.stragglerMs = Math.max(0, Number(stragglerMin) || 0) * 60000;
    this.batchAt = new Map();   // batch id -> when it was sent (Infinity once its requests were re-sent)
    // Time budget: after this long, everything still to do goes at the standard price (0 = never).
    this.directAfterMs = Math.max(0, Number(directAfterMin) || 0) * 60000; this.t0 = Date.now(); this.switched = false;
    this.done = new Map();      // request hash -> API message (successful results, kept for continuation)
    this.pending = new Map();   // request hash -> {batch, custom_id} submitted but not yet collected
    this.waiters = new Map();   // request hash -> [{resolve, reject}]
    this.queue = [];            // [{key, params}] waiting to be sent
    this.batches = new Map();   // batch id -> Set(custom_id)
    this.cancelled = new Set();
    this.params = new Map();    // request hash -> params, while sent and not settled (to resend once)
    this.byStep = {}; this.stepOf = new Map();
    this.usage = { requests: 0, cached_results: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, usd: 0, batches: 0, resent: 0, direct_requests: 0 };
    this.fatal = null;
    this.budgetUsd = Math.max(0, Number(budgetUsd) || 0); this.usdAtStart = 0; this.requestsAtStart = 0;
    this.inflight = 0;
    this.timer = null; this.poller = null;
  }

  // ------------------------------------------------------------------ state for continuing in a new session
  state() { return { v: 1, settings: { models: this.models, effort: this.effort }, done: Object.fromEntries(this.done), pending: Object.fromEntries(this.pending), usage: this.usage }; }
  /**
   * Continue from a saved state. A continued run keeps the models and effort it started with (unless keepSettings
   * is false), so every industry in a sector is analyzed the same way and answers already paid for are reused.
   */
  load(st, { keepSettings = true } = {}) {
    if (!st || st.v !== 1) return;
    if (keepSettings) {
      // Runs saved before settings were recorded used Opus 5.5 everywhere, effort high/medium/low by tier.
      const prev = st.settings || { models: { complex: "claude-opus-5-5", default: "claude-opus-5-5", quick: "claude-opus-5-5" }, effort: { complex: "high", default: "medium", quick: "low" } };
      this.models = { ...prev.models }; this.model = this.models.complex; this.effort = { ...(prev.effort || {}) };
    }
    for (const [k, v] of Object.entries(st.done || {})) this.done.set(k, v);
    for (const [k, v] of Object.entries(st.pending || {})) { this.pending.set(k, v); if (!this.batches.has(v.batch)) { this.batches.set(v.batch, new Set()); this.batchAt.set(v.batch, Date.now()); } this.batches.get(v.batch).add(v.custom_id); }
    if (st.usage) this.usage = { ...this.usage, ...st.usage };
    // The spending cap counts only what this session spends.
    this.usdAtStart = this.usage.usd; this.requestsAtStart = this.usage.requests;
    if (this.batches.size) this.startPolling();
  }

  // ------------------------------------------------------------------ one page call (prompt -> JSON or text)
  cancel(id) { this.cancelled.add(id); }
  async ask(id, { verb, input, modelTier = "default", tools = [], step = null }) {
    if (this.fatal) return { error: this.fatal };
    const system = verb === "json" ? FRAMING_JSON + (tools.length ? FRAMING_TOOLS : "") : (tools.length ? FRAMING_TOOLS.trim() : undefined);
    let messages = toMessages(input);
    const apiTools = tools.map((t) => ({ name: t.name, description: String(t.description || "").slice(0, 1024), input_schema: t.inputSchema || { type: "object", properties: {} } }));
    const texts = [];
    for (let round = 1; round <= this.maxRounds; round++) {
      if (this.cancelled.has(id)) return { error: { code: "cancelled", message: "cancelled" } };
      const last = round === this.maxRounds;
      // The last round must be an answer: say so, and allow no more tool calls.
      const msgsNow = last && apiTools.length ? withNote(messages, verb === "json" ? LAST_ROUND_JSON : LAST_ROUND) : messages;
      const eff = this.effort[modelTier];
      const params = { model: this.models[modelTier] || this.models.default, max_tokens: this.maxTokens, ...(eff ? { output_config: { effort: eff } } : {}),
        ...(system ? { system } : {}), messages: apiTools.length ? withCacheBreakpoint(msgsNow) : msgsNow,
        ...(apiTools.length ? { tools: apiTools, ...(last ? { tool_choice: { type: "none" } } : {}) } : {}) };
      let msg;
      try { msg = await this.send(params, step); }
      catch (e) { return { error: e?.code ? e : { code: "upstream_error", message: String(e?.message || e) } }; }
      const text = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      if (msg.stop_reason === "refusal") return { error: { code: "refused", message: "Claude declined this request." } };
      const uses = (msg.content || []).filter((b) => b.type === "tool_use");
      if (msg.stop_reason === "tool_use" && uses.length && !last) {
        if (text.trim()) texts.push(text);
        const results = await Promise.all(uses.map(async (u) => {
          let r; try { r = await this.execTool(id, u.name, u.input); } catch (e) { r = { error: String(e?.message || e) }; }
          const content = r?.error ? "Error: " + r.error : String(r?.ok ?? "").slice(0, 32768);
          return { type: "tool_result", tool_use_id: u.id, content: content || "(empty)", ...(r?.error ? { is_error: true } : {}) };
        }));
        messages = [...messages, { role: "assistant", content: msg.content }, { role: "user", content: results }];
        continue;
      }
      const truncated = msg.stop_reason === "max_tokens";
      const all = [...texts, text].filter((x) => x.trim()).join("\n\n");
      if (verb === "json") {
        let p = parseJsonReply(text);
        if (!p.ok && !truncated) {
          // One more call to re-send the answer in the right format (the analysis is already in the conversation).
          const repairMsgs = [...msgsNow, { role: "assistant", content: msg.content }, { role: "user", content: REPAIR_JSON }];
          try {
            const m2 = await this.send({ ...params, messages: apiTools.length ? withCacheBreakpoint(repairMsgs) : repairMsgs, ...(apiTools.length ? { tool_choice: { type: "none" } } : {}) }, step);
            const t2 = (m2.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
            const p2 = parseJsonReply(t2);
            if (p2.ok && m2.stop_reason !== "max_tokens") return { value: p2.value, text: [all, t2].filter((x) => x.trim()).join("\n\n") };
          } catch (e) { if (this.fatal) return { error: this.fatal }; }
        }
        if (!p.ok || truncated) return { error: { code: "invalid_json", message: truncated ? "The answer was cut short." : "No JSON value in the reply.", text: tools.length ? all : text } };
        return { value: p.value, text: all };
      }
      if (!all.trim()) return { error: { code: "empty_completion", message: "No text." } };
      return { text: all, truncated };
    }
    return { error: { code: "empty_completion", message: "No final answer after the tool rounds." } };
  }

  // ------------------------------------------------------------------ transport
  /** Past the time budget: stop batching, and re-send whatever is still waiting in batches. */
  switchToDirect() {
    if (this.switched) return; this.switched = true;
    this.log(`[claude] ${Math.round(this.directAfterMs / 60000)} minutes in: sending everything that's left at the standard price to finish on time`);
    for (const id of [...this.batches.keys()]) this.rescue(id);
    if (this.queue.length) this.flush();
  }
  /** This session's spend so far, plus a reserve for requests already sent and not yet billed. */
  committed() {
    const spent = this.usage.usd - this.usdAtStart, n = Math.max(1, this.usage.requests - this.requestsAtStart);
    const avg = this.usage.requests > this.requestsAtStart ? spent / n : 0.2;
    return spent + avg * (this.waiters.size + this.inflight + 1); // requests being waited on now, plus the one about to start
  }
  async send(params, step = null) {
    const key = hash(params);
    const cat = stepCategory(step);
    if (this.done.has(key)) { this.usage.cached_results++; (this.byStep[cat] ||= { usd: 0, requests: 0, reused: 0 }).reused++; return this.done.get(key); }
    if (!this.stepOf.has(key)) this.stepOf.set(key, cat);
    // Spending cap for this session: stop before it, never after (the run saves a checkpoint to continue later).
    if (this.budgetUsd && this.committed() >= this.budgetUsd) {
      if (!this.fatal) { this.fatal = { code: "rate_limited", message: `Spending cap reached: this run has used about $${(this.usage.usd - this.usdAtStart).toFixed(2)} of its $${this.budgetUsd} limit`, budget: true }; this.log("[claude] " + this.fatal.message); }
      throw this.fatal;
    }
    if (this.directAfterMs && !this.switched && Date.now() - this.t0 > this.directAfterMs) this.switchToDirect();
    if (this.mode === "direct" || this.switched) return this.direct(key, params);
    return new Promise((resolve, reject) => {
      if (!this.waiters.has(key)) this.waiters.set(key, []);
      this.waiters.get(key).push({ resolve, reject });
      if (this.pending.has(key) || this.queue.some((q) => q.key === key)) return; // already on its way
      this.queue.push({ key, params });
      if (this.queue.length >= 200) this.flush();
      else if (!this.timer) this.timer = setTimeout(() => this.flush(), this.flushMs);
    });
  }
  settle(key, fn) { const ws = this.waiters.get(key) || []; this.waiters.delete(key); for (const w of ws) fn(w); }
  record(key, msg, direct = this.mode !== "batch") {
    this.done.set(key, msg); this.pending.delete(key); this.params.delete(key);
    const u = msg.usage || {}, p = PRICES[msg.model] || PRICES[String(msg.model || "").replace(/-\d{8}$/, "")] || PRICES[this.model] || PRICES["claude-opus-5-5"], f = direct ? 1 : 0.5;
    this.usage.requests++; if (direct) this.usage.direct_requests++;
    this.usage.input += u.input_tokens || 0; this.usage.output += u.output_tokens || 0;
    this.usage.cacheWrite += u.cache_creation_input_tokens || 0; this.usage.cacheRead += u.cache_read_input_tokens || 0;
    const usd = f * ((u.input_tokens || 0) * p.input + (u.output_tokens || 0) * p.output + (u.cache_creation_input_tokens || 0) * p.cacheWrite + (u.cache_read_input_tokens || 0) * p.cacheRead) / 1e6;
    this.usage.usd += usd;
    const s = (this.byStep[this.stepOf.get(key) || "Other"] ||= { usd: 0, requests: 0, reused: 0 }); s.usd += usd; s.requests++; this.stepOf.delete(key);
  }
  headers() { return { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" }; }

  /** An API failure as the page's error codes: credits/auth stop the run; overload and 5xx are retried here. */
  apiError(status, body) {
    const msg = body?.error?.message || `HTTP ${status}`;
    if (status === 401 || status === 403) return { code: "not_granted", message: "Anthropic rejected the API key: " + msg, fatal: true };
    if (status === 400 && /credit balance|billing|spend limit|usage limit/i.test(msg)) return { code: "rate_limited", message: "Anthropic API: " + msg, fatal: true };
    if (status === 413 || /too long|prompt is too long/i.test(msg)) return { code: "prompt_too_large", message: msg };
    if (status === 400) return { code: "invalid_request", message: msg };
    return { code: "upstream_error", message: msg, retry: true };
  }
  async http(path, { method = "GET", body = null, raw = false } = {}) {
    for (let attempt = 1; ; attempt++) {
      let res;
      try { res = await fetch(path.startsWith("http") ? path : this.baseUrl + path, { method, headers: this.headers(), body: body ? JSON.stringify(body) : undefined }); }
      catch (e) { if (attempt >= 8) throw { code: "upstream_error", message: "Network: " + (e?.message || e) }; await sleep(Math.min(60000, 2000 * attempt)); continue; }
      if (res.ok) return raw ? res.text() : res.json();
      const j = await res.json().catch(() => null);
      if ((res.status === 429 || res.status >= 500) && attempt < 10) { const ra = Number(res.headers.get("retry-after")); await sleep(ra > 0 ? ra * 1000 : Math.min(120000, 3000 * 2 ** Math.min(attempt, 5))); continue; }
      const err = this.apiError(res.status, j);
      if (err.fatal) this.fatal = err;
      throw err;
    }
  }
  async direct(key, params) {
    while (this.inflight >= this.directConcurrency) await sleep(200);
    this.inflight++;
    try { const msg = await this.stream(params); this.record(key, msg, true); return msg; }
    finally { this.inflight--; }
  }
  /** One request at the standard price, streamed (so a long answer never hits an idle-connection timeout). */
  async stream(params) {
    for (let attempt = 1; ; attempt++) {
      let res;
      try { res = await fetch(this.baseUrl + "/v1/messages", { method: "POST", headers: this.headers(), body: JSON.stringify({ ...params, stream: true }) }); }
      catch (e) { if (attempt >= 8) throw { code: "upstream_error", message: "Network: " + (e?.message || e) }; await sleep(Math.min(60000, 2000 * attempt)); continue; }
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        if ((res.status === 429 || res.status >= 500) && attempt < 10) { const ra = Number(res.headers.get("retry-after")); await sleep(ra > 0 ? ra * 1000 : Math.min(120000, 3000 * 2 ** Math.min(attempt, 5))); continue; }
        const err = this.apiError(res.status, j); if (err.fatal) this.fatal = err; throw err;
      }
      try { return await readStream(res.body); }
      catch (e) { if (e?.retry && attempt < 8) { await sleep(Math.min(60000, 3000 * attempt)); continue; } throw e?.code ? e : { code: "upstream_error", message: String(e?.message || e) }; }
    }
  }
  /** A batch that's taking too long: cancel it and send what's still needed at the standard price. */
  async rescue(id) {
    this.batchAt.set(id, Infinity);
    const mine = [...this.pending].filter(([key, p]) => p.batch === id && this.waiters.get(key)?.length && this.params.has(key));
    if (!mine.length) return;
    this.log(`[claude] batch ${id} ${this.switched ? "is still running" : `is still running after ${Math.round(this.stragglerMs / 60000)} min`}: re-sending its ${mine.length} request${mine.length === 1 ? "" : "s"} at the standard price`);
    try { await this.http(`/v1/messages/batches/${id}/cancel`, { method: "POST" }); } catch {}
    for (const [key] of mine) {
      const params = this.params.get(key);
      this.pending.delete(key); this.usage.resent++;
      this.direct(key, params).then((msg) => this.settle(key, (w) => w.resolve(msg)), (err) => this.settle(key, (w) => w.reject(err)));
    }
  }
  async flush() {
    clearTimeout(this.timer); this.timer = null;
    const items = this.queue.splice(0, 10000);
    if (!items.length) return;
    if (this.switched) { for (const q of items) this.direct(q.key, q.params).then((m) => this.settle(q.key, (w) => w.resolve(m)), (e) => this.settle(q.key, (w) => w.reject(e))); return; }
    try {
      const requests = items.map((q, i) => ({ custom_id: `r${Date.now().toString(36)}${i}`, params: q.params }));
      const b = await this.http("/v1/messages/batches", { method: "POST", body: { requests } });
      this.usage.batches++;
      const ids = new Set();
      requests.forEach((r, i) => { this.pending.set(items[i].key, { batch: b.id, custom_id: r.custom_id }); this.params.set(items[i].key, items[i].params); ids.add(r.custom_id); });
      this.batches.set(b.id, ids); this.batchAt.set(b.id, Date.now());
      this.log(`[claude] batch ${b.id}: ${items.length} request${items.length === 1 ? "" : "s"}`);
      this.startPolling();
    } catch (e) {
      for (const q of items) this.settle(q.key, (w) => w.reject(e));
    }
  }
  startPolling() {
    if (this.poller) return;
    const tick = async () => {
      try { await this.poll(); } catch (e) { this.log("[claude] poll error: " + (e?.message || JSON.stringify(e))); }
      this.poller = this.batches.size ? setTimeout(tick, this.pollMs) : null;
    };
    this.poller = setTimeout(tick, Math.min(this.pollMs, 10000));
  }
  async poll() {
    for (const [id] of [...this.batches]) {
      if (this.directAfterMs && !this.switched && Date.now() - this.t0 > this.directAfterMs) { this.switchToDirect(); }
      if (this.batchAt.get(id) === Infinity && ![...this.pending.values()].some((p) => p.batch === id)) { this.batches.delete(id); this.batchAt.delete(id); continue; }
      const b = await this.http(`/v1/messages/batches/${id}`);
      if (b.processing_status !== "ended") { if (this.stragglerMs && Date.now() - (this.batchAt.get(id) ?? Date.now()) > this.stragglerMs) await this.rescue(id); continue; }
      const text = await this.http(b.results_url, { raw: true });
      const byCustom = new Map();
      for (const line of text.split("\n")) { if (!line.trim()) continue; try { const r = JSON.parse(line); byCustom.set(r.custom_id, r.result); } catch {} }
      for (const [key, p] of [...this.pending]) {
        if (p.batch !== id) continue;
        const r = byCustom.get(p.custom_id);
        this.pending.delete(key);
        if (r?.type === "succeeded") { this.record(key, r.message); this.settle(key, (w) => w.resolve(r.message)); continue; }
        const err = r?.type === "errored" ? this.apiError(r.error?.error?.type === "invalid_request_error" ? 400 : 500, r.error) : { code: "upstream_error", message: `Request ${r?.type || "missing"}`, retry: true };
        // Expired, canceled or a transient error: send it again once in the next batch; otherwise fail the call.
        const ws = this.waiters.get(key);
        if (err.retry && ws?.length && !ws.retried) { ws.retried = true; const params = this.params.get(key); if (params) { this.queue.push({ key, params }); if (!this.timer) this.timer = setTimeout(() => this.flush(), this.flushMs); continue; } }
        this.params.delete(key); this.settle(key, (w) => w.reject(err));
      }
      this.batches.delete(id); this.batchAt.delete(id);
    }
  }
}

/** Rebuild a Messages API response from its server-sent events. */
export async function readStream(body) {
  const dec = new TextDecoder(); let buf = "", msg = null, ended = false; const partial = new Map();
  const handle = (ev, data) => {
    if (ev === "error") { const t = data?.error?.type; throw { code: "upstream_error", message: data?.error?.message || "stream error", retry: t === "overloaded_error" || t === "api_error" }; }
    if (ev === "message_start") { msg = { ...data.message, content: [] }; return; }
    if (ev === "message_stop") { ended = true; return; }
    if (!msg) return;
    if (ev === "content_block_start") { msg.content[data.index] = { ...data.content_block }; if (data.content_block.type === "tool_use") partial.set(data.index, ""); return; }
    if (ev === "content_block_delta") { const b = msg.content[data.index], d = data.delta; if (!b) return;
      if (d.type === "text_delta") b.text = (b.text || "") + d.text;
      else if (d.type === "thinking_delta") b.thinking = (b.thinking || "") + d.thinking;
      else if (d.type === "signature_delta") b.signature = d.signature;
      else if (d.type === "input_json_delta") partial.set(data.index, (partial.get(data.index) || "") + d.partial_json);
      return; }
    if (ev === "content_block_stop") { const b = msg.content[data.index]; if (b?.type === "tool_use") { try { b.input = JSON.parse(partial.get(data.index) || "{}"); } catch { b.input = {}; } } return; }
    if (ev === "message_delta") { if (data.delta?.stop_reason) msg.stop_reason = data.delta.stop_reason; if (data.usage) msg.usage = { ...msg.usage, ...data.usage }; }
  };
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, i); buf = buf.slice(i + 2);
      let ev = "message", data = "";
      for (const line of raw.split("\n")) { if (line.startsWith("event:")) ev = line.slice(6).trim(); else if (line.startsWith("data:")) data += line.slice(5).trim(); }
      if (data) handle(ev, JSON.parse(data));
    }
  }
  if (!msg || !ended) throw { code: "upstream_error", message: "The answer stream ended early.", retry: true };
  msg.content = msg.content.filter(Boolean);
  return msg;
}
