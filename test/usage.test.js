'use strict';

/**
 * token 用量采集与累计的回归测试。
 *
 * ## 这一组锁的是什么
 *
 * 用户要看到三样东西: 执行中的计时、任务结束后的耗时与 token、以及本会话的累计。
 * 前两样是纯界面的事, 但**第三样依赖一条以前根本不存在的链路**:
 * 模型响应里的 usage 以前是被整个丢掉的 (lib/llm.js 的返回值里没有这个字段)。
 * 所以这一组从最底层的字段归一一路测到落盘的累加语义。
 *
 * 每一条都对着一个具体的、会让界面数字**看起来对但其实错**的失败模式:
 *
 *   - 各家网关字段名不一样 → 归一
 *   - "没报用量"和"用了 0 个"是两回事 → 取不到时给 null, 不编 0
 *   - 截断重试是两次真调用 → 要累加, 不能只记后一次
 *   - 一次任务里有很多次调用 → 要全累, 不能只记最后一次
 *   - 闸门本身也是调用 → 判成闲聊那次也得算
 *   - 落盘是累加的 → 送的必须是**增量**, 送总量会越加越多
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LLMClient = require('../lib/llm.js');
const { usageOf, addUsage } = LLMClient;
const { AgentLoop } = require('../lib/agent-loop.js');
const { ToolRegistry } = require('../lib/tools.js');
const Store = require('../lib/store.js');

/* ============================================================
 * 一、字段归一
 * ============================================================ */

test('用量: 认得 OpenAI 系的字段名', () => {
  const u = usageOf({ usage: { prompt_tokens: 1200, completion_tokens: 340 } });
  assert.deepStrictEqual(u, { input: 1200, output: 340 });
});

test('用量: 也认得 Anthropic 系 / 部分网关的字段名', () => {
  // 同一个产品换一个网关就换一套拼法。上层只想知道"进多少出多少",
  // 不该让它认识四五种写法 —— 那种分支散开之后必然有漏的。
  const u = usageOf({ usage: { input_tokens: 900, output_tokens: 88 } });
  assert.deepStrictEqual(u, { input: 900, output: 88 });
});

test('用量: 取不到时给 null, 不编 0', () => {
  // "这次没报用量"和"这次用了 0 个 token"是两件不同的事。
  // 混在一起之后, 累计数会安静地偏小 —— 而偏小最难发现。
  assert.strictEqual(usageOf({}), null);
  assert.strictEqual(usageOf({ usage: null }), null);
  assert.strictEqual(usageOf({ usage: 'nope' }), null);
  assert.strictEqual(usageOf(null), null);
  assert.strictEqual(usageOf({ usage: {} }), null);
  assert.strictEqual(usageOf({ usage: { something_else: 5 } }), null);
});

test('用量: 只有一半字段时, 缺的那个按 0 算 (但整份不是 null)', () => {
  // 报了 output 没报 input: 这是"报了一部分", 不是"没报"。整份丢掉会让
  // 已知的那一半也一起没了。
  assert.deepStrictEqual(usageOf({ usage: { completion_tokens: 50 } }), { input: 0, output: 50 });
  assert.deepStrictEqual(usageOf({ usage: { prompt_tokens: 70 } }), { input: 70, output: 0 });
});

test('用量: 负数/非数字当没报 (网关偶尔吐 null 或字符串)', () => {
  assert.strictEqual(usageOf({ usage: { prompt_tokens: -5, completion_tokens: null } }), null);
  assert.strictEqual(usageOf({ usage: { prompt_tokens: '120' } }), null, '字符串不算数 —— 宁可漏也别把 NaN 带进累计');
});

test('用量: addUsage 对 null 的处理是"返回另一份", 不是当成 0', () => {
  const a = { input: 10, output: 2 };
  assert.deepStrictEqual(addUsage(a, null), a);
  assert.deepStrictEqual(addUsage(null, a), a);
  assert.strictEqual(addUsage(null, null), null);
  assert.deepStrictEqual(addUsage(a, { input: 5, output: 3 }), { input: 15, output: 5 });
  // 传进来的对象不能被改 (它可能是别处正在用的累计值)
  const b = { input: 1, output: 1 };
  addUsage(a, b);
  assert.deepStrictEqual(b, { input: 1, output: 1 }, 'addUsage 不能就地改参数');
});

/* ============================================================
 * 二、AgentLoop 的累计
 * ============================================================ */

class UsageLLM {
  constructor(script) {
    this.script = Array.isArray(script) ? script : [script];
    this.calls = [];
    this.config = { apiKey: 'test' };
  }
  async chatStep(messages, tools) {
    const turn = this.calls.length;
    this.calls.push({ messages: messages.map((m) => ({ ...m })) });
    const raw = this.script[Math.min(turn, this.script.length - 1)];
    const step = typeof raw === 'function' ? raw(turn, messages, this) : raw;
    if (!step) return { content: '', toolCalls: [] };
    const out = { content: step.content || '', toolCalls: step.call ? [step.call] : [] };
    if (step.usage !== undefined) out.usage = step.usage;
    return out;
  }
  _extractJSON() { return null; }
}

function oneTool() {
  const r = new ToolRegistry();
  r.add('peek', '看一眼', { type: 'object', properties: {} }, async () => '结果', { readOnly: true, group: 'data' });
  return r;
}

test('累计: 一次任务里多次调用要全累, 不能只记最后一次', async () => {
  // 只记最后一次的话, 界面上的数字会比真实账单少一大截 —— 而那种偏差
  // 恰好是在"跑了很多轮、花了不少钱"的时候才暴露出来。
  const llm = new UsageLLM([
    { call: { id: 'c1', name: 'peek', args: {} }, usage: { input: 100, output: 10 } },
    { call: { id: 'c2', name: 'peek', args: {} }, usage: { input: 200, output: 20 } },
    { content: '好了', usage: { input: 300, output: 30 } }
  ]);
  const loop = new AgentLoop({
    llm, tools: oneTool(), system: 'S',
    messages: [{ role: 'user', content: '查' }],
    budget: { maxSteps: 9 }, emit: () => {}
  });
  const res = await loop.run();

  assert.deepStrictEqual(res.usage, { input: 600, output: 60, calls: 3 });
  assert.strictEqual(res.usage.calls, 3, 'calls 要数清楚调用了几次');
});

test('累计: 有一次没报用量, 其他几次照常累加 (不是整份作废)', async () => {
  const llm = new UsageLLM([
    { call: { id: 'c1', name: 'peek', args: {} }, usage: { input: 100, output: 10 } },
    { call: { id: 'c2', name: 'peek', args: {} } },              // 这次网关没报
    { content: '好了', usage: { input: 300, output: 30 } }
  ]);
  const loop = new AgentLoop({
    llm, tools: oneTool(), system: 'S',
    messages: [{ role: 'user', content: '查' }],
    budget: { maxSteps: 9 }, emit: () => {}
  });
  const res = await loop.run();
  assert.deepStrictEqual(res.usage, { input: 400, output: 40, calls: 2 });
});

test('累计: 每次调用都发一个 usage 事件 (界面要实时更新)', async () => {
  const llm = new UsageLLM([
    { call: { id: 'c1', name: 'peek', args: {} }, usage: { input: 100, output: 10 } },
    { content: '好了', usage: { input: 300, output: 30 } }
  ]);
  const events = [];
  const loop = new AgentLoop({
    llm, tools: oneTool(), system: 'S',
    messages: [{ role: 'user', content: '查' }],
    budget: { maxSteps: 9 }, emit: (e) => events.push(e)
  });
  await loop.run();
  const us = events.filter((e) => e.type === 'usage');
  assert.strictEqual(us.length, 2, '每次调用一个事件');
  assert.deepStrictEqual(us[0].task, { input: 100, output: 10, calls: 1 }, '事件里是累计值, 不是单次值');
  assert.deepStrictEqual(us[1].task, { input: 400, output: 40, calls: 2 });
});

test('累计: 一次都没报用量时是 0/0/0, 而不是 null', async () => {
  // 循环内部永远给一个可用的对象 (界面直接读它, 不用再判空);
  // "这次没人报"这件事体现在 calls 为 0 上。
  const llm = new UsageLLM([{ content: '好了' }]);
  const loop = new AgentLoop({
    llm, tools: oneTool(), system: 'S',
    messages: [{ role: 'user', content: '查' }],
    budget: { maxSteps: 9 }, emit: () => {}
  });
  const res = await loop.run();
  assert.deepStrictEqual(res.usage, { input: 0, output: 0, calls: 0 });
});

/* ============================================================
 * 三、落盘的累加语义
 * ============================================================ */

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solodb-stats-'));
  return new Store({ rootDir: dir });
}

test('落盘: stats 是累加的, 所以每次要送增量', () => {
  const store = tmpStore();
  const conv = store.createConversation({ id: 'c_test_stats', title: 'T' });

  store.saveMessages(conv.id, [{ role: 'user', content: 'a' }], null, { input: 100, output: 10, calls: 1 });
  store.saveMessages(conv.id, [{ role: 'user', content: 'a' }], null, { input: 200, output: 20, calls: 2 });

  const got = store.getConversation(conv.id);
  assert.deepStrictEqual(got.stats, { input: 300, output: 30, calls: 3 },
    '两次增量应该累加成 300/30/3');
});

test('落盘: 不传 stats 时不会把已有累计清零', () => {
  // 只改个标题、或者一次没有用量的落盘 (比如落盘失败后的重试),
  // 不该把"本会话用了多少"抹掉。
  const store = tmpStore();
  const conv = store.createConversation({ id: 'c_test_keep', title: 'T' });
  store.saveMessages(conv.id, [{ role: 'user', content: 'a' }], null, { input: 100, output: 10, calls: 1 });
  store.saveMessages(conv.id, [{ role: 'user', content: 'b' }], null, undefined);
  const got = store.getConversation(conv.id);
  assert.deepStrictEqual(got.stats, { input: 100, output: 10, calls: 1 }, '累计必须留着');
});

test('落盘: 坏 stats 不会把累计弄成 NaN', () => {
  // NaN 一旦进了累计就再也洗不掉 —— 界面上会一直显示 "NaN tokens",
  // 而且后面每次累加都还是 NaN。
  const store = tmpStore();
  const conv = store.createConversation({ id: 'c_test_nan', title: 'T' });
  store.saveMessages(conv.id, [], null, { input: 100, output: 10, calls: 1 });
  store.saveMessages(conv.id, [], null, { input: 'abc', output: null, calls: undefined });
  const got = store.getConversation(conv.id);
  assert.deepStrictEqual(got.stats, { input: 100, output: 10, calls: 1 }, '坏值当 0, 累计不受影响');
});

test('落盘: 消息里的 usage / elapsedMs 能存能取', () => {
  // 任务结束后要显示"本次耗时与用量", 重开这段对话时它还得在。
  const store = tmpStore();
  const conv = store.createConversation({ id: 'c_test_msg', title: 'T' });
  store.saveMessages(conv.id, [
    { role: 'user', content: '查' },
    { role: 'assistant', content: '好了', usage: { input: 500, output: 40, calls: 2 }, elapsedMs: 12345 }
  ], null, { input: 500, output: 40, calls: 2 });

  const got = store.getConversation(conv.id);
  const m = got.messages[1];
  assert.deepStrictEqual(m.usage, { input: 500, output: 40, calls: 2 });
  assert.strictEqual(m.elapsedMs, 12345);
});
