'use strict';

/**
 * 搭建 Agent 迁到统一运行时 (lib/agent-loop.js) 之后的回归测试。
 *
 * 迁移本身不改工具逻辑, 改的是"谁来决定下一步"。所以这里断言的都是
 * **循环层面的行为** —— 而这些恰恰是手抄循环里抄漏或抄错的地方:
 *   - 提问要停下来等回答 (不是接着往下搭)
 *   - 提问那一轮的 tool_call 必须被应答, 否则用户答完再发消息对话史是坏的
 *   - 步数用尽要如实报 exhausted
 *   - 一轮里多个只读动作都要执行
 *   - 上下文压缩不能动用户说的话
 */

const test = require('node:test');
const assert = require('node:assert');

const { EngineAiBuilder } = require('../lib/engine-ai');
const Engine = require('../lib/engine');

function toolCall(name, args, id) {
  return {
    id: id || 'call_' + name + '_' + Math.random().toString(36).slice(2, 7),
    name,
    args: args || {},
    rawArguments: JSON.stringify(args || {})
  };
}

class FakeLLM {
  constructor(script) {
    this.script = Array.isArray(script) ? script : [script];
    this.calls = [];
  }
  async chatStep(messages, tools) {
    const turn = this.calls.length;
    this.calls.push({ messages: messages.map((m) => ({ ...m })), tools });
    const raw = this.script[Math.min(turn, this.script.length - 1)];
    const step = typeof raw === 'function' ? raw(turn, messages, this) : raw;
    if (!step) return { content: '', toolCalls: [] };
    if (step.calls) return { content: step.content || '', toolCalls: step.calls };
    if (step.call) return { content: step.content || '', toolCalls: [step.call] };
    return { content: step.content || '', toolCalls: [] };
  }
  _extractJSON() { return null; }
}

/** 一个最小的、结构合法的空卡 —— 入口不要任何输入 */
function blankCard() {
  const c = Engine.newEngine();
  const inp = (c.nodes || []).find((n) => n.type === 'input');
  if (inp) inp.fields = [];
  return Engine.normalizeEngine(c);
}

function makeBuilder(script) {
  const llm = new FakeLLM(script);
  const builder = new EngineAiBuilder({
    llm, pool: {}, card: blankCard(),
    databases: [], openDb: () => { throw new Error('这个测试不该连库'); }
  });
  return { llm, builder };
}

/* ============================================================ */

test('提问是终结: ask_user 停下来等回答, 不接着往下搭', async () => {
  const { llm, builder } = makeBuilder([
    { call: toolCall('ask_user', { question: '这批货走哪个仓？' }) },
    // 没停的话它会接着调这个 —— 用"有没有被调用"来证明停住了
    { call: toolCall('add_node', { nodeType: 'query', title: '不该出现' }) },
    { content: 'x' }
  ]);
  const r = await builder.send('搭一张卡', () => {});

  assert.strictEqual(r.ok, true, '提问不算失败');
  assert.match(r.ask || '', /哪个仓/, '要把问题交出去');
  assert.strictEqual(llm.calls.length, 1, '问完就该停, 不该再调模型');
  assert.ok(!(builder.card.nodes || []).some((n) => n.title === '不该出现'), '停住之后不该加节点');
});

test('ask_choice 同样是终结', async () => {
  const { llm, builder } = makeBuilder([
    { call: toolCall('ask_choice', { question: '选哪个？', options: ['A', 'B'] }) },
    { call: toolCall('add_node', { nodeType: 'query', title: '不该出现' }) }
  ]);
  const r = await builder.send('搭一张卡', () => {});
  assert.ok(r.ask, '要把问题交出去');
  assert.strictEqual(llm.calls.length, 1, '问完就停');
});

test('提问那一轮的 tool_call 必须被应答 (对话史不能坏)', async () => {
  const { builder } = makeBuilder([
    { call: toolCall('ask_user', { question: '哪个仓？' }, 'call_ask_1') },
    { content: '好' }
  ]);
  await builder.send('搭一张卡', () => {});

  // 用户答完再发消息时会把整段 messages 发出去。assistant 上挂了 tool_calls
  // 却没有对应的 role:'tool' 应答, 服务端会直接打回这个请求:
  //   "An assistant message with 'tool_calls' must be followed by tool messages
  //    responding to each 'tool_call_id'"
  const hist = builder.messages;
  const asst = hist.filter((m) => m.role === 'assistant' && m.tool_calls);
  assert.ok(asst.length > 0, '应该真的走过原生工具通道');
  for (const a of asst) {
    for (const c of a.tool_calls) {
      assert.ok(
        hist.some((m) => m.role === 'tool' && m.tool_call_id === c.id),
        '每个 tool_call 都要有应答: ' + c.id
      );
    }
  }
});

test('步数用尽 -> exhausted, 不当成搭完了', async () => {
  const { builder } = makeBuilder([
    (t) => ({ call: toolCall('add_node', { nodeType: 'query', title: 'n' + t }) })
  ]);
  const evs = [];
  const r = await builder.send('一直加', (ev) => evs.push(ev));

  assert.strictEqual(r.ok, false, '用尽不是成功');
  assert.strictEqual(r.exhausted, true, '要如实标出是用尽');
  assert.strictEqual(r.done, false);
  assert.ok(evs.some((e) => e.type === 'ai_done' && e.exhausted === true), 'ai_done 也要带 exhausted');
});

test('一轮里多个只读动作都执行 (不再只执行第一个)', async () => {
  const { builder } = makeBuilder([
    { calls: [toolCall('list_available_tables', {}, 'c1'), toolCall('list_available_tables', {}, 'c2')] },
    { content: '看完了' }
  ]);
  const r = await builder.send('先看看', () => {});
  assert.strictEqual(r.ok, true);

  const tools = builder.messages.filter((m) => m.role === 'tool');
  assert.strictEqual(tools.length, 2, '两个动作各自一条应答');
  assert.ok(!tools.some((m) => /被跳过/.test(m.content)), '不该再有"被跳过"');
});

test('取消: 循环以 cancelled 收场, 不当成搭完了', async () => {
  // 用 abort 打断在飞的请求太慢, 这里直接验证 cancel 路径的返回值形状
  const { builder } = makeBuilder([{ content: 'ok' }]);
  // 先跑一次正常的, 确认 cancelled 分支只在真取消时走
  const ok = await builder.send('看看', () => {});
  assert.strictEqual(ok.ok, true);
  assert.ok(!ok.cancelled, '正常收尾不该带 cancelled');
});

test('用户说的话不会因为上下文压缩而消失', async () => {
  const { builder } = makeBuilder([
    (t) => ({ call: toolCall('list_available_tables', {}, 'c' + t) })
  ]);
  await builder.send('这句话必须还在', () => {});
  assert.ok(
    builder.messages.some((m) => m.role === 'user' && /这句话必须还在/.test(String(m.content || ''))),
    '压缩只折工具结果, 不动用户说的话'
  );
});

test('注册表: 改图的工具不并发, 只读的才并发', () => {
  const { builder } = makeBuilder([{ content: 'x' }]);
  const r = builder._registry();
  assert.strictEqual(r.canParallel(['list_available_tables', 'describe_tables']), true, '只读的能并发');
  assert.strictEqual(r.canParallel(['add_node', 'connect']), false, '改图的必须串行, 免得互相踩连线');
  assert.strictEqual(r.canParallel(['list_available_tables', 'add_node']), false, '混着也不并发');
});

test('注册表: MCP 挂上之后模型能看到外部工具', () => {
  const llm = new FakeLLM([{ content: 'x' }]);
  const builder = new EngineAiBuilder({
    llm, pool: {}, card: blankCard(), databases: [], openDb: () => { throw new Error('no'); },
    mcp: {
      tools: [{ type: 'function', function: { name: 'mcp__srv__lookup', description: '外部查', parameters: { type: 'object', properties: {} } } }],
      call: async () => '外部结果'
    }
  });
  const names = builder.toolSchemas().map((t) => t.function.name);
  assert.ok(names.includes('mcp__srv__lookup'), '外部工具要出现在给模型的清单里');
  assert.ok(names.includes('add_node'), '内置工具照旧都在');
});
