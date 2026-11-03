// Claude on the firm's Anthropic API key, with the call shapes the page's `sample` capability has:
// a prompt (or messages) in, text or one JSON value out, streamed so the page can fill in as it arrives.
// A long shared start of the prompt can be cached (prompt caching), so the company write-up's four
// analysts pay full price for the shared company and industry material only once.
const FRAMING_JSON = "Your reply will be read by a program as one JSON value. Reply with only the JSON value the instructions ask for, with no text, Markdown fence or commentary before or after it.";
export const PRICES = {
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** Messages for the API; the first user turn split at cachePrefix (characters) with a cache breakpoint on the shared part. */
function toMessages(input, cachePrefix) {
  const msgs = [];
  if (typeof input === "string") msgs.push({ role: "user", content: input });
  else for (const m of Array.isArray(input) ? input : []) {
    const role = m.role === "assistant" ? "assistant" : "user";
    if (msgs.length && msgs[msgs.length - 1].role === role) msgs[msgs.length - 1].content += "\n\n" + m.content;
    else msgs.push({ role, content: String(m.content || "") });
  }
  const first = msgs[0], n = Number(cachePrefix) || 0;
  // Only worth it for a long shared start (the API caches 1,024+ tokens; ~4 characters a token).
  if (first?.role === "user" && n >= 8000 && n < first.content.length) {
    first.content = [{ type: "text", text: first.content.slice(0, n), cache_control: { type: "ephemeral" } }, { type: "text", text: first.content.slice(n) }];
  }
  return msgs;
}

/** Cost in dollars of one answer's usage. */
export function costOf(model, u = {}) {
  const p = PRICES[model] || PRICES["claude-opus-5-5"];
  return ((u.input_tokens || 0) * p.input + (u.output_tokens || 0) * p.output + (u.cache_creation_input_tokens || 0) * p.cacheWrite + (u.cache_read_input_tokens || 0) * p.cacheRead) / 1e6;
}

export class Claude {
  constructor({ apiKey, baseUrl = "https://api.anthropic.com", models = {}, maxTokens = 32000 }) {
    this.apiKey = apiKey; this.baseUrl = baseUrl.replace(/\/$/, ""); this.maxTokens = maxTokens;
    this.models = { complex: "claude-opus-5-5", default: "claude-sonnet-5-5", quick: "claude-sonnet-5-5", ...models };
  }
  /**
   * One page call. onDelta(text, delta) as the answer streams. Returns {text, value?, truncated, usage, usd, model}.
   * Errors are thrown with the viewer's codes (rate_limited, upstream_error, refused, invalid_json, cancelled).
   */
  async ask({ verb = "text", input, modelTier = "default", cachePrefix = 0, signal, onDelta }) {
    const model = this.models[modelTier] || this.models.default;
    const body = { model, max_tokens: this.maxTokens, stream: true, messages: toMessages(input, cachePrefix), ...(verb === "json" ? { system: FRAMING_JSON } : {}) };
    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        res = await fetch(this.baseUrl + "/v1/messages", { method: "POST", signal,
          headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" }, body: JSON.stringify(body) });
      } catch (e) {
        if (signal?.aborted) throw { code: "cancelled", message: "cancelled" };
        if (attempt < 3) { await sleep(2000 * attempt); continue; }
        throw { code: "upstream_error", message: String(e?.message || e).slice(0, 200), retryable: true };
      }
      if (res.status === 429 || res.status === 529 || res.status >= 500) {
        if (attempt < 4) { await sleep(Number(res.headers.get("retry-after")) * 1000 || 4000 * attempt); continue; }
        throw { code: res.status === 429 ? "rate_limited" : "upstream_error", message: `Claude is busy (${res.status}); try again shortly.`, retryable: true };
      }
      if (!res.ok) { const t = await res.text().catch(() => ""); throw { code: "upstream_error", message: `Claude API ${res.status}: ${t.slice(0, 300)}` }; }
      let text = "", usage = {}, stop = null;
      try {
        const dec = new TextDecoder(); let buf = "";
        for await (const chunk of res.body) {
          buf += dec.decode(chunk, { stream: true }); let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const raw = buf.slice(0, i); buf = buf.slice(i + 2); let ev = "", data = "";
            for (const line of raw.split("\n")) { if (line.startsWith("event:")) ev = line.slice(6).trim(); else if (line.startsWith("data:")) data += line.slice(5).trim(); }
            if (!data) continue; const d = JSON.parse(data);
            if (ev === "error") throw { code: "upstream_error", message: d?.error?.message || "stream error", retryable: true };
            if (ev === "message_start") usage = { ...(d.message?.usage || {}) };
            else if (ev === "content_block_delta" && d.delta?.type === "text_delta") { text += d.delta.text; try { onDelta?.(text, d.delta.text); } catch {} }
            else if (ev === "message_delta") { if (d.delta?.stop_reason) stop = d.delta.stop_reason; if (d.usage) usage = { ...usage, ...d.usage }; }
          }
        }
      } catch (e) {
        if (signal?.aborted) throw { code: "cancelled", message: "cancelled" };
        if (e?.code) throw e; throw { code: "upstream_error", message: String(e?.message || e).slice(0, 200), retryable: true };
      }
      if (stop === "refusal") throw { code: "refused", message: "Claude declined this request." };
      const out = { text, truncated: stop === "max_tokens", usage, model, usd: costOf(model, usage) };
      if (verb === "json") { const p = parseJsonReply(text); if (!p.ok) throw { code: "invalid_json", message: "The answer wasn't valid JSON.", text, usd: out.usd }; out.value = p.value; }
      return out;
    }
  }
}
