// Unit tests for the sampler's JSON reading, message shaping and API error mapping.
import assert from "node:assert";
import { parseJsonReply, Sampler } from "../lib/sampler.mjs";
assert.deepStrictEqual(parseJsonReply('{"a":1}').value, { a: 1 });
assert.deepStrictEqual(parseJsonReply('Here you go:\n```json\n{"a":2}\n```').value, { a: 2 });
assert.deepStrictEqual(parseJsonReply('Sure. {"a":[1,2]} Done.').value, { a: [1, 2] });
assert.strictEqual(parseJsonReply("no json here").ok, false);
const s = new Sampler({ apiKey: "k", execTool: async () => ({ ok: "x" }), log: () => {} });
assert.strictEqual(s.apiError(401, { error: { message: "bad key" } }).code, "not_granted");
assert.strictEqual(s.apiError(400, { error: { message: "Your credit balance is too low" } }).code, "rate_limited");
assert.strictEqual(s.apiError(400, { error: { message: "prompt is too long: 1200000 tokens" } }).code, "prompt_too_large");
assert.strictEqual(s.apiError(529, null).retry, true);
// a tool loop: tool_use, then the answer; tool results go back with a cache breakpoint on the last user turn
const sent = [];
s.send = async (params) => { sent.push(params); return sent.length === 1
  ? { stop_reason: "tool_use", content: [{ type: "thinking", thinking: "", signature: "s" }, { type: "tool_use", id: "t1", name: "look", input: { q: 1 } }], usage: {} }
  : { stop_reason: "end_turn", content: [{ type: "text", text: '{"done":true}' }], usage: {} }; };
const r = await s.ask("c1", { verb: "json", input: "Find it", modelTier: "complex", tools: [{ name: "look", description: "d", inputSchema: { type: "object", properties: {} } }] });
assert.deepStrictEqual(r.value, { done: true });
assert.strictEqual(sent[0].output_config.effort, "high");
const last = sent[1].messages[sent[1].messages.length - 1];
assert.strictEqual(last.role, "user"); assert.strictEqual(last.content[0].type, "tool_result"); assert.ok(last.content[last.content.length - 1].cache_control);
assert.strictEqual(sent[1].messages[1].content[0].type, "thinking", "thinking blocks go back unchanged");
// cut short -> invalid_json with the text kept
s.send = async () => ({ stop_reason: "max_tokens", content: [{ type: "text", text: '{"a": [1, 2' }], usage: {} });
const r2 = await s.ask("c2", { verb: "json", input: "x" });
assert.strictEqual(r2.error.code, "invalid_json"); assert.ok(r2.error.text.startsWith('{"a"'));
console.log("sampler tests passed");
// an unreadable final answer gets one repair call; the last tool round says it is the last
{
  const s2 = new Sampler({ apiKey: "k", maxRounds: 2, execTool: async () => ({ ok: "x" }), log: () => {} });
  const seen = [];
  s2.send = async (params) => { seen.push(params);
    if (seen.length === 1) return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "look", input: {} }], usage: {} };
    if (seen.length === 2) return { stop_reason: "end_turn", content: [{ type: "text", text: "I would like to search more before answering." }], usage: {} };
    return { stop_reason: "end_turn", content: [{ type: "text", text: '{"ok":1}' }], usage: {} }; };
  const r3 = await s2.ask("c3", { verb: "json", input: "Find", tools: [{ name: "look", description: "d" }] });
  assert.deepStrictEqual(r3.value, { ok: 1 });
  assert.strictEqual(seen[1].tool_choice.type, "none");
  const lastUser = seen[1].messages[seen[1].messages.length - 1].content;
  assert.ok(lastUser.some((b) => b.type === "text" && /last tool round/.test(b.text)), "the last round says it is the last");
  assert.ok(/couldn't be read as one JSON value/.test(JSON.stringify(seen[2].messages[seen[2].messages.length - 1])), "repair call asks again");
  console.log("repair tests passed");
}
