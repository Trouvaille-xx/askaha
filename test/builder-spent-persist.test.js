'use strict';

/**
 * 搭建会话的账要**落盘** —— 让"跑了很久还没搭完"这件事事后可复盘。
 *
 * ## 这一组锁的是什么
 *
 * 起因 (2026-09-21): 一个搭建会话跑了 25 分钟没收敛, 事后翻会话日志,
 * `elapsedMs` 和 `usage` **一个数字都没有** —— 想判断"是模型慢还是数据库慢"
 * 只能靠猜, 而这两者实测差一个数量级 (模型 3~8 秒/步, 一次全表
 * COUNT(DISTINCT) 十几秒), 优化方向完全相反。
 *
 * 根因有两处, 各自独立, 所以下面分两组测:
 *
 *   1. 每步的耗时/token 只活在 AgentLoop 实例的计数器里, 跑完随实例消失。
 *      `_emitSpent` 把它推给了界面, 而界面是易失的 —— 关掉面板就没了。
 *      → 现在挂到 assistant 消息上 (它本来就会随对话史落盘)。
 *   2. 整轮的 `spent` 总账只在 send 的局部变量里, 从来不进 snapshot。
 *      → 现在挂到 builder 实例上, 随 snapshot/restore 进出。
 *
 * 分析 Agent 那边**早就有**这条链路了 (渲染层送 usage/elapsedMs 给
 * store.saveMessages)。这一组补的是搭建 Agent 缺的那一半。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { EngineAiBuilder } = require('../lib/engine-ai');
const Engine = require('../lib/engine');
const { AgentLoop } = require('../lib/agent-loop');
const { ToolRegistry } = require('../lib/tools');
const AiChatStore = require('../lib/ai-chat-store');
const { wireMessages } = require('../lib/llm');

function toolCall(name, args, id) {
  return {
    id: id || 'call_' + name + '_' + Math.random().toString(36).slice(2, 7),
    name,
    args: args || {},
    rawArguments: JSON.stringify(args || {})
  };
}

/** 会报 usage 和耗时的假模型 —— 真网关就是这么回的 */
class FakeLLM {
  constructor(script, opts = {}) {
    this.script = Array.isArray(script) ? script : [script];
    this.calls = [];
    this.usage = opts.usage || { input: 4321, output: 210, calls: 1 };
    this.elapsedMs = opts.elapsedMs == null ? 7 : opts.elapsedMs;
  }
  async chatStep() {
    const turn = this.calls.length;
    this.calls.push(turn);
    const raw = this.script[Math.min(turn, this.script.length - 1)];
    const step = typeof raw === 'function' ? raw(turn) : raw;
    const calls = step && step.call ? [step.call] : (step && step.calls) || [];
    return {
      content: (step && step.content) || '',
      toolCalls: calls,
      usage: this.usage,
      elapsedMs: this.elapsedMs
    };
  }
}

function blankCard() {
  const c = Engine.newEngine();
  const inp = (c.nodes || []).find((n) => n.type === 'input');
  if (inp) inp.fields = [];
  return Engine.normalizeEngine(c);
}

function makeBuilder(script, opts = {}) {
  const llm = new FakeLLM(script, opts);
  const builder = new EngineAiBuilder({
    llm,
    pool: { db1: ['t1'] },
    card: blankCard(),
    databases: [{ id: 'db1', name: 'SRM', type: 'mysql', host: 'h', port: 3306, database: 'd', user: 'u' }],
    openDb: () => ({ async query() { return { rows: [] }; }, async describeTable() { return []; }, async close() {} })
  });
  return { llm, builder };
}

/* ============================================================
 * 一、每步的耗时与 token 挂到消息上
 * ============================================================ */

test('每步的 elapsedMs / usage 挂在 assistant 消息上 (它随对话史落盘)', async () => {
  const tools = new ToolRegistry();
  tools.add('noop', 'x', { type: 'object', properties: {} }, async () => 'ok',
    { readOnly: true, group: 'build' });
  const llm = new FakeLLM([{ call: toolCall('noop', {}) }, { content: '完了' }],
    { elapsedMs: 1234, usage: { input: 500, output: 40, calls: 1 } });
  const loop = new AgentLoop({
    llm, tools, system: 's', messages: [], budget: { maxSteps: 3 }, emit: () => {}, ctx: {}
  });
  await loop.run();

  const a = loop.messages.find((m) => m.role === 'assistant' && m.tool_calls);
  assert.ok(a, '前提: 有一轮带 tool_calls 的 assistant 消息');
  assert.strictEqual(a.elapsedMs, 1234, '模型往返耗时要在消息上');
  assert.deepStrictEqual(a.usage, { input: 500, output: 40, calls: 1 }, 'token 用量也要在消息上');
});

test('文本模式 (网关不吃 tools) 的消息同样带账', async () => {
  // 走 assistant + user 老形状的那条路 (模型没走 tools 通道, 而是在正文里
  // 漏出 DSML 标记)。这条路不能漏 —— 漏了的话这类网关下日志里照样没有数字,
  // 而"为什么只有某些用户报慢"会变成玄学。
  const tools = new ToolRegistry();
  tools.add('noop', 'x', { type: 'object', properties: {} }, async () => 'ok',
    { readOnly: true, group: 'build' });
  const dsml = '<|DSML|invoke name="noop">\n</|DSML|invoke>';
  const llm = new FakeLLM([{ content: dsml }, { content: '好' }],
    { elapsedMs: 88, usage: { input: 10, output: 5, calls: 1 } });
  const loop = new AgentLoop({
    llm, tools, system: 's', messages: [], budget: { maxSteps: 3 }, emit: () => {}, ctx: {}
  });
  await loop.run().catch(() => {});

  const a = loop.messages.find((m) => m.role === 'assistant' && m.elapsedMs != null);
  assert.ok(a, '文本模式的 assistant 消息也要带 elapsedMs');
  assert.strictEqual(a.elapsedMs, 88);
  assert.ok(!a.tool_calls, '前提: 这条路不该有 tool_calls (它走的是文本解析)');
});

/* ============================================================
 * 二、这些字段绝不能发到网关上
 * ============================================================ */

test('wireMessages: 只放协议认的字段, 复盘字段一律剥掉', () => {
  // 上层的消息数组同时承担"发给模型"和"落盘复盘"两个角色, 所以多出来的
  // 字段原样发出去就是隐患: 部分网关对不认识的字段直接 400, 而报错指向
  // payload 不指向业务, 用户完全无从下手。
  const wire = wireMessages([
    {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'a', type: 'function', function: { name: 'f', arguments: '{}' } }],
      elapsedMs: 1234, usage: { input: 5, output: 2, calls: 1 }
    },
    { role: 'tool', tool_call_id: 'a', content: '结果', elapsedMs: 99 },
    { role: 'user', content: '原话', ctx: 500 }
  ]);

  assert.strictEqual(wire[0].elapsedMs, undefined, 'elapsedMs 不能发出去');
  assert.strictEqual(wire[0].usage, undefined, 'usage 不能发出去');
  assert.strictEqual(wire[1].elapsedMs, undefined, 'tool 消息上的也不能发');
  assert.strictEqual(wire[2].ctx, undefined, '别的内部字段同样不能发');
  // 协议字段必须原样保留
  assert.strictEqual(wire[0].role, 'assistant');
  assert.strictEqual(wire[0].content, '', '空 content 要发 —— 工具调用那轮本来就是空串');
  assert.ok(Array.isArray(wire[0].tool_calls), 'tool_calls 要保留');
  assert.strictEqual(wire[1].tool_call_id, 'a');
  assert.strictEqual(wire[2].content, '原话');
});

test('wireMessages 不改动原数组 (消息史是权威的, 不能被顺手改掉)', () => {
  const src = [{ role: 'assistant', content: 'x', elapsedMs: 5 }];
  wireMessages(src);
  assert.strictEqual(src[0].elapsedMs, 5, '原对象必须原封不动');
});

/* ============================================================
 * 三、整轮总账随 snapshot / restore 进出
 * ============================================================ */

test('builder.snapshot() 带上 spent, restore 能接回来', async () => {
  const { builder } = makeBuilder([{ content: '好' }], { elapsedMs: 250 });
  builder.spent = {
    rounds: 2, steps: 7, calls: 7, input: 9000, output: 400,
    llmMs: 1750, toolMs: 3200, byTool: { look_at_data: 3000 }, byToolCalls: { look_at_data: 2 }
  };
  const snap = builder.snapshot();
  assert.ok(snap.spent, 'snapshot 必须带上 spent');
  assert.strictEqual(snap.spent.llmMs, 1750);

  // 走一遍 JSON —— 落盘就是 JSON.stringify, 不能有 Map/Set 这类东西混进去
  const round = JSON.parse(JSON.stringify(snap));
  const fresh = new EngineAiBuilder({
    llm: new FakeLLM([{ content: 'x' }]), pool: {}, card: blankCard(), openDb: () => null
  });
  fresh.restore(round);
  assert.strictEqual(fresh.spent.llmMs, 1750, 'restore 之后账还在');
  assert.strictEqual(fresh.spent.byTool.look_at_data, 3000, '按工具分的账也要在');
});

test('没跑过 send 的会话 spent 是 null, 不是 undefined', () => {
  // 显式初始化过, 否则 snapshot 里是 undefined —— 落盘时那个键会整个消失,
  // 读日志时分不清"没跑过"和"跑了但没记账"。
  const { builder } = makeBuilder([{ content: 'x' }]);
  assert.strictEqual(builder.snapshot().spent, null);
});

/* ============================================================
 * 四、落到 ai-chat-store 的语义
 * ============================================================ */

function tmpChatStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solodb-spent-'));
  return new AiChatStore({ rootDir: dir });
}

test('ai-chat-store: spent 存得进、读得出', () => {
  const store = tmpChatStore();
  store.create({ id: 'aich_test_spent', cardId: 'card_1', title: 'T' });
  store.save('aich_test_spent', {
    spent: { rounds: 3, steps: 40, calls: 40, input: 1, output: 2, llmMs: 100, toolMs: 200, byTool: {}, byToolCalls: {} }
  });
  const got = store.get('aich_test_spent');
  assert.ok(got.spent, 'spent 要落盘');
  assert.strictEqual(got.spent.steps, 40);
  assert.strictEqual(got.spent.toolMs, 200);
});

test('ai-chat-store: spent 是**覆盖**不是累加 (它已经是总量了)', () => {
  // 跟 store.js 的 stats 语义相反, 别照抄: 那边渲染层送的是增量所以要累加;
  // 这边 builder 在 send 里已经跨轮累过了, 再累就是"每存一次翻一倍"。
  const store = tmpChatStore();
  store.create({ id: 'aich_test_over', cardId: 'card_1', title: 'T' });
  store.save('aich_test_over', { spent: { steps: 10, llmMs: 100 } });
  store.save('aich_test_over', { spent: { steps: 25, llmMs: 300 } });
  const got = store.get('aich_test_over');
  assert.strictEqual(got.spent.steps, 25, '必须是最后一次的值, 不是 35');
  assert.strictEqual(got.spent.llmMs, 300, '耗时同理');
});

test('ai-chat-store: 不传 spent 时不会把已有的账抹掉', () => {
  // 只改个标题、或者一次没有账的落盘, 不该让"上次跑了多久"消失。
  const store = tmpChatStore();
  store.create({ id: 'aich_test_keep', cardId: 'card_1', title: 'T' });
  store.save('aich_test_keep', { spent: { steps: 12, llmMs: 999 } });
  store.save('aich_test_keep', { title: '改个名' });
  const got = store.get('aich_test_keep');
  assert.strictEqual(got.title, '改个名');
  assert.strictEqual(got.spent.llmMs, 999, '账必须留着');
});

/* ============================================================
 * 五、读过的表结构要跨对话活着
 * ============================================================ */

test('describedForCard: 把同一张卡的历史表结构并起来', () => {
  // 表结构是纯事实, 跟"在哪条对话里读到的"无关。原来它只存在单条对话里,
  // 于是同一张卡上开新对话就要从头 describe_tables —— 用户的感觉是"它又忘了"。
  const store = tmpChatStore();
  store.create({ id: 'aich_a', cardId: 'card_9', title: 'A' });
  store.save('aich_a', { session: { described: [['db1.orders', [{ field: 'id' }]]] } });
  store.create({ id: 'aich_b', cardId: 'card_9', title: 'B' });
  store.save('aich_b', { session: { described: [['db1.supplier', [{ field: 'name' }]]] } });
  // 别的卡的不能混进来
  store.create({ id: 'aich_c', cardId: 'card_other', title: 'C' });
  store.save('aich_c', { session: { described: [['db1.secret', [{ field: 'x' }]]] } });

  const seen = new Map(store.describedForCard('card_9'));
  assert.ok(seen.has('db1.orders'), '第一对话读过的表要在');
  assert.ok(seen.has('db1.supplier'), '第二对话读过的表也要在');
  assert.ok(!seen.has('db1.secret'), '别的卡的表结构不能串进来');
  assert.strictEqual(seen.size, 2);
});

test('describedForCard: 没读过时给空数组, 坏记录不炸', () => {
  const store = tmpChatStore();
  store.create({ id: 'aich_empty', cardId: 'card_e', title: 'E' });
  assert.deepStrictEqual(store.describedForCard('card_e'), []);
  assert.deepStrictEqual(store.describedForCard(null), [], '没 cardId 就没什么可接的');
  // 形状不对的记录跳过, 不抛
  store.save('aich_empty', { session: { described: 'not-an-array' } });
  assert.deepStrictEqual(store.describedForCard('card_e'), []);
});
