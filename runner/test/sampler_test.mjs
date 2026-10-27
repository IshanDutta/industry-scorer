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
assert.strictEqual(sent[0].model, "claude-opus-5-5", "complex steps on the most capable model");
assert.strictEqual(sent[0].output_config, undefined, "each model's own default effort, as in claude.ai");
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
// routine ("default") steps go to the balanced model; the spending cap stops before going over
{
  const s3 = new Sampler({ apiKey: "k", budgetUsd: 1, mode: "direct", execTool: async () => ({ ok: "x" }), log: () => {} });
  const models = [];
  s3.stream = async (params) => { models.push(params.model); return { model: params.model, stop_reason: "end_turn", content: [{ type: "text", text: '{"a":1}' }], usage: { input_tokens: 100000, output_tokens: 10000 } }; };
  const a = await s3.ask("d1", { verb: "json", input: "x", modelTier: "default" });
  assert.deepStrictEqual(a.value, { a: 1 }); assert.strictEqual(models[0], "claude-sonnet-5-5");
  // $0.30 per call at Sonnet prices: three calls reach $0.90; a fourth would pass $1, so it is refused
  await s3.ask("d2", { verb: "json", input: "y", modelTier: "default" });
  await s3.ask("d3", { verb: "json", input: "w", modelTier: "default" });
  const c = await s3.ask("d4", { verb: "json", input: "z", modelTier: "default" });
  assert.strictEqual(c.error?.code, "rate_limited"); assert.ok(c.error.budget && /Spending cap/.test(c.error.message));
  assert.ok(s3.usage.usd <= 1.0001, `spent $${s3.usage.usd} of a $1 cap`);
  console.log("tier and cap tests passed");
}
// a continued run keeps the settings it started with (old checkpoints: Opus everywhere, high effort for complex)
{
  const s4 = new Sampler({ apiKey: "k", execTool: async () => ({}), log: () => {} });
  s4.load({ v: 1, done: {}, pending: {}, usage: { usd: 95 } });
  assert.strictEqual(s4.models.default, "claude-opus-5-5"); assert.strictEqual(s4.effort.complex, "high");
  assert.strictEqual(s4.usdAtStart, 95, "the cap counts only this session");
  const s5 = new Sampler({ apiKey: "k", execTool: async () => ({}), log: () => {} });
  s5.load({ v: 1, settings: { models: { complex: "claude-opus-5-5", default: "claude-sonnet-5-5" }, effort: {} }, done: {}, pending: {} });
  assert.strictEqual(s5.models.default, "claude-sonnet-5-5"); assert.strictEqual(s5.effort.complex, undefined);
  const s6 = new Sampler({ apiKey: "k", execTool: async () => ({}), log: () => {} });
  s6.load({ v: 1, done: {}, pending: {} }, { keepSettings: false });
  assert.strictEqual(s6.models.default, "claude-sonnet-5-5", "an explicit setting wins");
  console.log("settings tests passed");
}
