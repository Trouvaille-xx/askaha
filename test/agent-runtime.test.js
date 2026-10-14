'use strict';

/**
 * 统一 Agent 运行时的回归测试。
 *
 * 这个运行时是"把编排交给模型"的地基, 所以每一条断言都对着一个具体的
 * 失败模式, 而不是"能跑就行":
 *   - 预算用尽必须如实报 budget, 不能当正常收尾 (以前报过"改完了")
 *   - 快用完时必须告诉模型该收尾, 否则"让模型决定何时停"是空话
 *   - 一轮多个只读动作要真的都执行 (以前只执行第一个)
 *   - 有副作用的动作不能并发
 *   - 工具失败要回灌给模型, 不能炸整轮
 *   - 取消要能掐掉在飞的请求
 *   - 上下文超限要压缩旧工具结果, 但不能动用户说的话
 */

const test = require('node:test');
const assert = require('node:assert');

const { ToolRegistry, ToolError } = require('../lib/tools.js');
const { AgentLoop, compactMessages, STUB_CHARS, MAX_CONSECUTIVE_RETRIES } = require('../lib/agent-loop.js');

/* ============================================================
 * 假 LLM
 * ============================================================ */

/** 造一个原生 tool_call */
function call(name, args, id) {
  return { id: id || 'c_' + name + '_' + Math.random().toString(36).slice(2, 6), name, args: args || {}, rawArguments: JSON.stringify(args || {}) };
}

class FakeLLM {
  constructor(script) {
    this.script = Array.isArray(script) ? script : [script];
    this.calls = [];
  }
  async chatStep(messages, tools, opts) {
    const turn = this.calls.length;
    this.calls.push({ messages: messages.map((m) => ({ ...m })), tools, opts });
    const raw = this.script[Math.min(turn, this.script.length - 1)];
    const step = typeof raw === 'function' ? raw(turn, messages, this) : raw;
    if (!step) return { content: '', toolCalls: [] };
    if (step.call) return { content: step.content || '', toolCalls: [step.call] };
    if (step.calls) return { content: step.content || '', toolCalls: step.calls };
    return { content: step.content || '', toolCalls: [] };
  }
  _extractJSON(text) {
    if (!text) return null;
    const a = text.indexOf('{'); const b = text.lastIndexOf('}');
    if (a === -1 || b <= a) return null;
    try { return JSON.parse(text.slice(a, b + 1)); } catch (e) { return null; }
  }
  /** 第 n 轮看到的最后一条消息 */
  lastMessageAt(n) {
    const m = this.calls[n] && this.calls[n].messages;
    return m && m.length ? m[m.length - 1].content : null;
  }
}

function makeTools() {
  const r = new ToolRegistry();
  const log = [];
  r.add('read_a', '读 A', { type: 'object', properties: {} }, async () => { log.push('read_a'); return 'A 的结果'; }, { readOnly: true, group: 'data' });
  r.add('read_b', '读 B', { type: 'object', properties: {} }, async () => { log.push('read_b'); return 'B 的结果'; }, { readOnly: true, group: 'data' });
  r.add('write_x', '写 X', { type: 'object', properties: {} }, async () => { log.push('write_x'); return '写好了'; }, { readOnly: false, group: 'flow' });
  r.add('boom', '总是失败', { type: 'object', properties: {} }, async () => { throw new ToolError('故意失败'); }, { readOnly: true });
  r.log = log;
  return r;
}

function loopWith(script, opts = {}) {
  const llm = new FakeLLM(script);
  const tools = opts.tools || makeTools();
  const events = [];
  const cancel = opts.cancel || null;
  const loop = new AgentLoop({
    llm, tools,
    system: opts.system || '你是测试用的 agent',
    messages: opts.messages || [{ role: 'user', content: '干活' }],
    budget: opts.budget || { maxSteps: 8 },
    emit: (ev) => events.push(ev),
    cancel
  });
  return { llm, tools, events, loop };
}

/* ============================================================
 * 基本控制流: 模型决定下一步
 * ============================================================ */

test('模型连着调工具, 循环跟着走, 不收尾就不停', async () => {
  const { llm, loop } = loopWith([
    { call: call('read_a') },
    { call: call('read_b') },
    { content: '都看完了' }
  ]);
  const r = await loop.run();
  assert.strictEqual(r.steps, 2, '应该执行了两步');
  assert.strictEqual(r.stopReason, 'done');
  assert.strictEqual(r.finalText, '都看完了');
  assert.strictEqual(llm.calls.length, 3, '两次动作 + 一次收尾');
});

test('模型不给动作 = 它自己决定收尾', async () => {
  const { loop } = loopWith([{ content: '不用查了, 直接答' }]);
  const r = await loop.run();
  assert.strictEqual(r.steps, 0);
  assert.strictEqual(r.stopReason, 'done');
  assert.strictEqual(r.finalText, '不用查了, 直接答');
});

test('文本模式的 JSON 动作也能认 (网关不吃 tools 时)', async () => {
  const { loop } = loopWith([
    { content: '{"action": "read_a"}' },
    { content: '好了' }
  ]);
  const r = await loop.run();
  assert.strictEqual(r.steps, 1, '文本动作应该被执行');
  assert.strictEqual(r.stopReason, 'done');
});

/* ============================================================
 * 预算: 这是"让模型决定"能成立的前提
 * ============================================================ */

test('步数用尽如实报 budget, 不伪装成正常收尾', async () => {
  // 模型永远在调工具, 永远不收尾
  const { loop } = loopWith([{ call: call('read_a') }], { budget: { maxSteps: 3 } });
  const r = await loop.run();
  assert.strictEqual(r.steps, 3, '应该正好用满 3 步');
  assert.strictEqual(r.stopReason, 'budget', '必须如实报 budget');
  assert.strictEqual(r.finalText, '', '没有收尾文本就是没有, 不该编一个');
});

test('预算快用完时明确告诉模型该收尾', async () => {
  const { llm, loop } = loopWith([{ call: call('read_a') }], { budget: { maxSteps: 4 } });
  await loop.run();
  // 第 3 步之后 remaining.stepsLeft = 2 -> 应该出现提示
  const sawNudge = llm.calls.some((c) => c.messages.some((m) => /步数快用完了/.test(String(m.content || ''))));
  assert.ok(sawNudge, '快用完时必须告诉模型, 否则它会一路做到底然后被硬截断');
});

test('墙钟预算也能停住 (maxMs)', async () => {
  const tools = new ToolRegistry();
  tools.add('slow', '慢工具', { type: 'object', properties: {} }, async () => {
    await new Promise((r) => setTimeout(r, 30));
    return '慢';
  }, { readOnly: true });
  const { loop } = loopWith([{ call: call('slow') }], { tools, budget: { maxSteps: 100, maxMs: 80 } });
  const r = await loop.run();
  assert.strictEqual(r.stopReason, 'budget', '墙钟到点也该停');
  assert.ok(r.steps < 100, '不该跑满步数');
});

/* ============================================================
 * 并发: 一轮多个只读动作
 * ============================================================ */

test('一轮多个只读动作全部执行 (不再只执行第一个)', async () => {
  const { tools, loop } = loopWith([
    { calls: [call('read_a', {}, 'c1'), call('read_b', {}, 'c2')] },
    { content: '好了' }
  ]);
  const r = await loop.run();
  assert.strictEqual(r.steps, 1, '算一步');
  assert.deepStrictEqual(tools.log.sort(), ['read_a', 'read_b'], '两个都该真的执行');
  // 回灌时两条 tool 消息都在
  const toolMsgs = r.messages.filter((m) => m.role === 'tool');
  assert.strictEqual(toolMsgs.length, 2, '每个 tool_call_id 都要有一条结果');
});

test('只读工具真的并发跑 (不是排队)', async () => {
  const tools = new ToolRegistry();
  let running = 0; let peak = 0;
  const mk = (n) => async () => {
    running += 1; peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 25));
    running -= 1;
    return n;
  };
  tools.add('p1', '', { type: 'object', properties: {} }, mk('1'), { readOnly: true });
  tools.add('p2', '', { type: 'object', properties: {} }, mk('2'), { readOnly: true });
  const { loop } = loopWith([{ calls: [call('p1', {}, 'a'), call('p2', {}, 'b')] }, { content: 'x' }], { tools });
  await loop.run();
  assert.strictEqual(peak, 2, '两个只读工具应该同时在跑');
});

test('有副作用的工具不并发 (串行跑)', async () => {
  const tools = new ToolRegistry();
  let running = 0; let peak = 0;
  const mk = () => async () => {
    running += 1; peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 20));
    running -= 1;
    return 'ok';
  };
  tools.add('w1', '', { type: 'object', properties: {} }, mk(), { readOnly: false });
  tools.add('w2', '', { type: 'object', properties: {} }, mk(), { readOnly: false });
  const { loop } = loopWith([{ calls: [call('w1', {}, 'a'), call('w2', {}, 'b')] }, { content: 'x' }], { tools });
  await loop.run();
  assert.strictEqual(peak, 1, '有副作用的工具必须串行, 免得互相踩');
});

/* ============================================================
 * 失败是信息, 不是终止
 * ============================================================ */

test('工具失败回灌给模型, 整轮不炸', async () => {
  const { llm, loop } = loopWith([
    { call: call('boom') },
    { content: '那我换个办法' }
  ]);
  const r = await loop.run();
  assert.strictEqual(r.ok, true, '工具失败不该让整轮失败');
  assert.strictEqual(r.stopReason, 'done');
  const fed = llm.calls[1].messages.some((m) => /故意失败/.test(String(m.content || '')));
  assert.ok(fed, '失败原因要回灌给模型, 它才知道换个方式');
});

test('模型编了一个不存在的工具名 -> 回灌纠正, 不当成收尾', async () => {
  const { llm, loop } = loopWith([
    { call: call('not_a_tool') },
    { content: '抱歉, 我重新来' }
  ]);
  const r = await loop.run();
  assert.strictEqual(r.steps, 0, '没执行任何真实动作');
  const fed = llm.calls[1].messages.some((m) => /没有叫 not_a_tool 的工具/.test(String(m.content || '')));
  assert.ok(fed, '要告诉它这个工具不存在');
  assert.strictEqual(r.stopReason, 'done');
});

test('一直编工具名不会无限转下去 (实测踩到过 OOM)', async () => {
  // 纠正路径不消耗步数 —— 不设上限的话, 一个持续编造工具名的模型会让
  // 循环永远转下去, 内存一路涨到把整个应用拖死。这里锁住那个上限。
  const { llm, loop } = loopWith([
    (t) => ({ call: call('fake_tool_' + t) })
  ], { budget: { maxSteps: 50 } });
  const r = await loop.run();

  assert.strictEqual(r.ok, false, '应该如实失败');
  assert.strictEqual(r.stopReason, 'error');
  assert.ok(llm.calls.length <= MAX_CONSECUTIVE_RETRIES + 1, `调用次数必须有限, 实际 ${llm.calls.length}`);
  assert.match(r.error || '', /不存在的工具/, '要说清为什么中止');
});

test('自纠错成功之后重试计数归零 (别把偶发一次当成惯犯)', async () => {
  const { llm, loop } = loopWith([
    (t) => ({ call: call('fake_' + t) }),   // 第 0 轮: 编一个
    { call: call('read_a') },               // 第 1 轮: 改对了
    (t) => ({ call: call('fake2_' + t) }),  // 第 2 轮: 又编一个
    { call: call('read_b') },               // 第 3 轮: 又改对
    { content: '好了' }
  ], { budget: { maxSteps: 50 } });
  const r = await loop.run();

  assert.strictEqual(r.stopReason, 'done', '两轮之间隔着重试不该累计到上限');
  assert.strictEqual(r.steps, 2, '只算两次真实动作');
});

/* ============================================================
 * 取消
 * ============================================================ */

test('开跑前就取消 -> 一步都不跑', async () => {
  const cancel = { v: true };
  const { llm, loop } = loopWith([{ call: call('read_a') }], { cancel });
  const r = await loop.run();
  assert.strictEqual(r.stopReason, 'cancelled');
  assert.strictEqual(r.steps, 0);
  assert.strictEqual(llm.calls.length, 0, '取消后不该调模型');
});

test('跑到一半取消 -> 立刻停, 且如实报 cancelled', async () => {
  const cancel = { v: false };
  const { loop } = loopWith([
    (turn, messages, self) => { cancel.v = true; return { call: call('read_a') }; },
    { call: call('read_b') }
  ], { cancel });
  const r = await loop.run();
  assert.strictEqual(r.stopReason, 'cancelled', '中途取消必须报 cancelled');
  assert.ok(r.steps <= 1, '不该继续跑');
});

test('在飞请求被 abort 掐掉 -> 报 cancelled 而不是 error', async () => {
  const http = require('node:http');
  const server = http.createServer(() => { /* 永不响应 */ });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  const sockets = [];
  server.on('connection', (s) => sockets.push(s));

  try {
    const LLMClient = require('../lib/llm.js');
    const client = new LLMClient({ baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'x', model: 'x', timeoutMs: 30000 });
    const cancel = { v: false, abort: () => client.abort('取消') };
    const tools = makeTools();
    const loop = new AgentLoop({
      llm: client, tools, system: 's',
      messages: [{ role: 'user', content: 'x' }],
      budget: { maxSteps: 5 }, emit: () => {}, cancel
    });
    const p = loop.run();
    await new Promise((r) => setTimeout(r, 150));
    cancel.v = true;
    cancel.abort();
    const r = await Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('没停住')), 5000))]);
    assert.strictEqual(r.stopReason, 'cancelled', 'abort 造成的失败要认成取消, 不是故障');
  } finally {
    for (const s of sockets) s.destroy();
    server.close();
  }
});

/* ============================================================
 * 上下文压缩
 * ============================================================ */

test('压缩: 不动 system, 不动用户说的话', () => {
  const msgs = [
    { role: 'system', content: 'S'.repeat(5000) },
    { role: 'user', content: '用户的需求'.repeat(100) },
    ...Array.from({ length: 10 }, (_, i) => ({ role: 'tool', tool_call_id: 't' + i, content: 'X'.repeat(3000) })),
    { role: 'assistant', content: 'ok' }
  ];
  const r = compactMessages(msgs, { maxChars: 10000, keepRecent: 2 });
  assert.ok(r.compacted > 0, '应该压缩了一些');
  assert.strictEqual(r.messages[0].content.length, 5000, 'system 不能动');
  assert.strictEqual(r.messages[1].content.length, msgs[1].content.length, '用户说的话不能动');
  assert.ok(r.chars <= 10000 + 4000, '压缩后应该显著变小');
});

test('压缩: 最近几条工具结果原样保留 (正在用的细节不能丢)', () => {
  const msgs = [
    { role: 'user', content: 'q' },
    ...Array.from({ length: 8 }, (_, i) => ({ role: 'tool', tool_call_id: 't' + i, content: `结果${i}:` + 'Y'.repeat(3000) }))
  ];
  const r = compactMessages(msgs, { maxChars: 9000, keepRecent: 3 });
  const tools = r.messages.filter((m) => m.role === 'tool');
  const kept = tools.slice(-3);
  assert.ok(kept.every((m) => m.content.length > STUB_CHARS), '最近 3 条必须原样保留');
  assert.ok(tools[0].content.length <= STUB_CHARS + 200, '最早那条应该被折叠');
});

test('压缩: 没超阈值时一个字都不动', () => {
  const msgs = [{ role: 'user', content: '短' }, { role: 'tool', tool_call_id: 't', content: '短' }];
  const r = compactMessages(msgs, { maxChars: 100000 });
  assert.strictEqual(r.compacted, 0);
  assert.strictEqual(r.messages, msgs, '没超限就该原样返回 (同一个数组)');
});

test('压缩: 存根里说清"这里发生过什么"和怎么拿回细节', () => {
  const msgs = [
    { role: 'user', content: 'q' },
    ...Array.from({ length: 6 }, (_, i) => ({ role: 'tool', tool_call_id: 't' + i, content: 'Z'.repeat(2000) }))
  ];
  const r = compactMessages(msgs, { maxChars: 5000, keepRecent: 1 });
  const stubbed = r.messages.filter((m) => m.role === 'tool' && /已折叠/.test(m.content));
  assert.ok(stubbed.length, '应该有折叠过的');
  assert.match(stubbed[0].content, /重新调用这个工具/, '要告诉模型怎么拿回细节');
});

/* ---- 文本模式下的结果回灌: role 是 'user', 只能靠调用方给下标认出来 ---- */

test('压缩: toolIdx 能把"文本模式的结果回灌"也折掉', () => {
  // 文本模式要求 assistant/user 交替, 没法用 role:'tool' 装结果。
  // 于是那些结果在压缩眼里就是普通的 user 消息 —— 不折的话,
  // 长会话在文本模式下等于完全没有压缩, 而它往往正是最占地方的那部分。
  const big = 'X'.repeat(4000);
  const msgs = [
    { role: 'system', content: 'S'.repeat(500) },
    { role: 'user', content: '用户的原话' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: big },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: big },
    { role: 'assistant', content: 'a3' },
    { role: 'user', content: big }
  ];
  // 预算给得"刚好够": 折掉最早两条就达标, 最近那条不必动。
  // (给得太紧的话两遍渐进放宽会把保护的一起折掉 —— 那是设计好的:
  //  keepRecent 是偏好, 字数上限才是硬线。这里要验的是偏好生效的那档。)
  const r = compactMessages(msgs, { maxChars: 9000, toolIdx: [3, 5, 7] });

  assert.ok(r.compacted > 0, '应该折了');
  assert.strictEqual(r.messages[0].content.length, 500, '系统提示一个字都不能动');
  assert.strictEqual(r.messages[1].content, '用户的原话', '用户原话一个字都不能动');
  assert.ok(r.messages[3].content.length < 500, '最早那条结果应该被折了');
  assert.ok(r.messages[7].content.length > 1000, '最近那条要保护住 (keepRecent)');
  assert.ok(r.savedChars > 0, 'savedChars 要能报出来给界面用');
});

test('压缩: 不传 toolIdx 时, role:user 的消息一条都不折', () => {
  // 反向保证: 默认行为不能误伤。老调用方 (builder / tester) 不传这个参数,
  // 它们的结果回灌都是 role:'tool', 不该因为这次改动而开始折用户消息。
  const big = 'X'.repeat(4000);
  const msgs = [
    { role: 'user', content: big },
    { role: 'user', content: big },
    { role: 'user', content: big }
  ];
  const r = compactMessages(msgs, { maxChars: 1000 });
  assert.strictEqual(r.compacted, 0, '没有 role:tool 也没有 toolIdx, 就该什么都不折');
  assert.strictEqual(r.messages[0].content.length, 4000);
});

test('压缩: toolIdx 里越界/非法下标不能把压缩搞崩', () => {
  const big = 'X'.repeat(4000);
  const msgs = [{ role: 'user', content: 'q' }, { role: 'user', content: big }];
  const r = compactMessages(msgs, { maxChars: 1000, toolIdx: [99, -1, null, 'x', 1.5, 1] });
  assert.strictEqual(r.compacted, 1, '只有下标 1 是合法的');
  assert.ok(r.messages[1].content.length < 500);
});

test('循环里会自动压缩, 并发事件出来', async () => {
  const tools = new ToolRegistry();
  tools.add('big', '返回很多字', { type: 'object', properties: {} }, async () => 'Q'.repeat(4000), { readOnly: true });
  const { events, loop } = loopWith(
    [{ call: call('big') }, { call: call('big') }, { content: '好了' }],
    { tools, budget: { maxSteps: 10, maxChars: 6000 } }
  );
  const r = await loop.run();
  assert.ok(r.compactions > 0, '应该触发过压缩');
  assert.ok(events.some((e) => e.type === 'compact'), '要发 compact 事件让界面知道');
});

/* ---- token 触发: 真实占用超预算就折, 不再只看字符数 ---- */

test('tokenBudget: 由 contextLimit 推出, 没配就是 0', () => {
  const mk = (contextLimit) => new AgentLoop({
    llm: { config: { contextLimit, maxTokens: 2048 } },
    tools: new ToolRegistry(), system: 's', messages: [], budget: {}
  });
  assert.strictEqual(mk(0).tokenBudget(), 0, '没配 contextLimit 时退回字符判定, 不硬编一个预算');
  const b = mk(100000).tokenBudget();
  assert.ok(b > 0 && b < 100000, '要有正预算且明显小于窗口 (留输出余量)');
  assert.ok(mk(100000).tokenBudget() < mk(200000).tokenBudget(), '窗口越大预算越大');
});

test('token 预算: 真实占用超预算就折 (即使字符数远没到字符阈值)', async () => {
  const tools = new ToolRegistry();
  tools.add('big', '', { type: 'object', properties: {} }, async () => 'Z'.repeat(3000), { readOnly: true });
  let n = 0;
  const llm = {
    config: { contextLimit: 100000, maxTokens: 2048 },
    async chatStep() {
      n += 1;
      // 前几轮一直取数制造大上下文; 最后一轮收尾。每次都报"真实"占用 9 万 token。
      if (n <= 8) return { content: '', toolCalls: [call('big')], usage: { input: 90000 + n, output: 5 } };
      return { content: '好了', toolCalls: [], usage: { input: 90000, output: 5 } };
    },
    _extractJSON: () => null
  };
  const events = [];
  const loop = new AgentLoop({
    llm, tools, system: 'sys',
    messages: [{ role: 'user', content: '干活' }],
    // 字符阈值故意放到永不触发 —— 这样"折了"只可能来自 token 判定
    budget: { maxSteps: 20, maxChars: 100000000 },
    emit: (ev) => events.push(ev)
  });
  const r = await loop.run();
  assert.ok(r.compactions > 0, '真实 token 超预算就该折');
  const comp = events.find((e) => e.type === 'compact');
  assert.ok(comp && comp.tokens > 0, 'compact 事件要带上当时的 token 占用, 供界面/复盘用');
});

test('token 预算: 没配 contextLimit 时退回字符判定 (不会因为 usage 大就误触发)', async () => {
  const tools = new ToolRegistry();
  tools.add('big', '', { type: 'object', properties: {} }, async () => 'Z'.repeat(3000), { readOnly: true });
  let n = 0;
  const llm = {
    config: {},   // 没有 contextLimit
    async chatStep() {
      n += 1;
      if (n <= 8) return { content: '', toolCalls: [call('big')], usage: { input: 999999, output: 5 } };
      return { content: '好了', toolCalls: [] };
    },
    _extractJSON: () => null
  };
  const loop = new AgentLoop({
    llm, tools, system: 's', messages: [{ role: 'user', content: 'x' }],
    budget: { maxSteps: 20, maxChars: 100000000 }, emit: () => {}
  });
  const r = await loop.run();
  assert.strictEqual(r.compactions, 0, '没有 contextLimit + 字符远没超 -> 不该折');
});

/* ============================================================
 * 工具注册表
 * ============================================================ */

test('注册表: 内置与外部同处一个命名空间', () => {
  const r = new ToolRegistry();
  r.add('mine', '内置', { type: 'object', properties: {} }, async () => 'x');
  const fakeMcp = {
    tools: [{ name: 'mcp__srv__do', description: '外部', parameters: { type: 'object', properties: {} } }],
    call: async () => '外部结果'
  };
  r.attachMCP(fakeMcp);
  // 'mcp__srv__do' < 'mine' ('mc' < 'mi'), 所以 mcp 在前
  assert.deepStrictEqual(r.names().sort(), ['mcp__srv__do', 'mine']);
  assert.strictEqual(r.schemas().length, 2, '模型看到一份合并的清单');
});

test('注册表: 外部工具一律当有副作用 (不知道它干什么)', () => {
  const r = new ToolRegistry();
  r.attachMCP({ tools: [{ name: 'mcp__s__t', description: '', parameters: {} }], call: async () => '' });
  assert.strictEqual(r.canParallel(['mcp__s__t']), false, '外部工具不能并发');
  assert.strictEqual(r.get('mcp__s__t').readOnly, false);
});

test('注册表: subset 取子集给某个阶段用', () => {
  const r = makeTools();
  const sub = r.subset(['read_a', 'boom']);
  assert.deepStrictEqual(sub.names().sort(), ['boom', 'read_a']);
  assert.strictEqual(sub.has('write_x'), false);
});

test('注册表: 调不存在的工具返回 error 而不是抛', async () => {
  const r = makeTools();
  const out = await r.call('nope', {});
  assert.match(out.error, /没有叫 nope 的工具/);
});

test('注册表: 工具抛非 ToolError 也变成 error, 不炸', async () => {
  const r = new ToolRegistry();
  r.add('crash', '', { type: 'object', properties: {} }, async () => { throw new Error('底层炸了'); });
  const out = await r.call('crash', {});
  assert.match(out.error, /底层炸了/);
});

test('注册表: 描述里带出参数, 给界面显示', () => {
  const r = makeTools();
  const d = r.describe('read_a', { x: 1 });
  assert.match(d, /read_a/);
  assert.match(d, /x=1/);
});
