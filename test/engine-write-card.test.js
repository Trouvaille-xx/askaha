'use strict';

/**
 * 搭建 Agent 的**一次性产出整卡** (write_card) 与**嵌套条件**。
 *
 * 起因: 逐个 add_node / connect 一趟趟画图, 搭一张多分支卡要几十次模型往返。
 * write_card 让模型一次交完整的 nodes+edges; 条件嵌套则是把引擎**本来就支持**的
 * 能力从搭建工具里放出来 (引擎的 normalizeExpr/evalExpr 一直是递归的)。
 *
 * 这里断言的是两条底线:
 *   1. 整张卡一次写入, 且有硬错时**不写入**(不能悄悄落一张坏卡)
 *   2. 嵌套条件真的进了 expr, 且深度有上限
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

// 一张结构合法、带一个条件节点的小卡 (供 write_card 与 configure_condition 用)
function validCard() {
  return {
    name: '订单入库核对',
    description: '判断订单是否已入库',
    nodes: [
      { id: 'n_in', type: 'input', title: '入口', fields: [{ key: 'orderNo', label: '订单号', desc: '形如 PO2024xxxx' }] },
      { id: 'n_q', type: 'query', title: '查状态', databaseId: 'db1', table: 't',
        sql: 'SELECT status, a, b FROM t WHERE no = {{orderNo}}',
        outputs: [{ key: 'status', label: '状态' }, { key: 'a', label: '甲' }, { key: 'b', label: '乙' }] },
      { id: 'n_c', type: 'condition', title: '是否未入库',
        expr: { type: 'group', logic: 'and', items: [{ type: 'cmp', left: 'n_q.status', op: '==', right: '未入库' }] } },
      { id: 'n_o1', type: 'output', title: '未入库', template: '订单 {{orderNo}} 尚未入库' },
      { id: 'n_o2', type: 'output', title: '已入库', template: '订单 {{orderNo}} 已入库' }
    ],
    edges: [
      { from: 'n_in', to: 'n_q', port: 'out' },
      { from: 'n_q', to: 'n_c', port: 'out' },
      { from: 'n_c', to: 'n_o1', port: 'true' },
      { from: 'n_c', to: 'n_o2', port: 'false' }
    ]
  };
}

const PLAN = { steps: [{ title: '查状态' }, { title: '给结论' }], branches: ['未入库', '已入库'] };

/* ============================================================ */

test('write_card: 一次写出整张卡, 落图', async () => {
  const { builder } = makeBuilder([
    { call: toolCall('plan_task', PLAN) },
    { call: toolCall('write_card', { card: validCard() }) },
    { content: '写好了' }
  ]);
  const r = await builder.send('搭一张订单核对卡', () => {});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(builder.card.nodes.length, 5, '整张卡一次写入 (5 个节点)');
  assert.strictEqual(builder.card.edges.length, 4);
  assert.ok(builder.card.nodes.some((n) => n.id === 'n_q' && n.sql.includes('{{orderNo}}')), 'SQL 落进去了');
  assert.strictEqual(builder.card.name, '订单入库核对', '卡名落进去了');
  // 写完还没试跑, finish 闸门应仍拦着
  assert.strictEqual(builder.tested.ran, false, '写完不该被当成"已试跑"');
});

test('write_card: 有硬错就拒写, 原卡不动', async () => {
  const { builder } = makeBuilder([
    { call: toolCall('plan_task', PLAN) },
    // 缺出口 —— validateEngine 会报硬错
    { call: toolCall('write_card', { card: { name: '坏卡', nodes: [{ id: 'n_in', type: 'input', fields: [] }], edges: [] } }) },
    { content: '改' }
  ]);
  await builder.send('搭卡', () => {});
  assert.strictEqual(builder.card.nodes.length, 2, '拒写: 还是原来那张空卡 (入口+出口)');
  assert.notStrictEqual(builder.card.name, '坏卡', '拒写时名字也不该被改');
});

test('write_card: 一个出口接两条线 (菱形) 直接拦下', async () => {
  const bad = validCard();
  bad.edges = [
    { from: 'n_in', to: 'n_q', port: 'out' },
    { from: 'n_q', to: 'n_c', port: 'out' },
    { from: 'n_c', to: 'n_o1', port: 'true' },
    { from: 'n_c', to: 'n_o2', port: 'true' }   // 同一个 true 口接了两条
  ];
  const { builder } = makeBuilder([
    { call: toolCall('plan_task', PLAN) },
    { call: toolCall('write_card', { card: bad }) },
    { content: '改' }
  ]);
  await builder.send('搭卡', () => {});
  assert.strictEqual(builder.card.nodes.length, 2, '菱形被拦, 没写入');
});

test('configure_condition: 接受嵌套子组, 进 expr 并被 describeExpr 认出来', async () => {
  const { builder } = makeBuilder([
    { call: toolCall('plan_task', PLAN) },
    { call: toolCall('write_card', { card: validCard() }) },
    { call: toolCall('configure_condition', {
      nodeId: 'n_c', logic: 'and', items: [
        { left: 'n_q.status', op: '==', right: '未入库' },
        { logic: 'or', items: [{ left: 'n_q.a', op: '==', right: '1' }, { left: 'n_q.b', op: 'notEmpty' }] }
      ]
    }) },
    { content: '好了' }
  ]);
  await builder.send('改条件', () => {});
  const c = builder.card.nodes.find((n) => n.id === 'n_c');
  assert.strictEqual(c.expr.items.length, 2, '顶层两条');
  assert.strictEqual(c.expr.items[1].type, 'group', '第二条是子组');
  assert.strictEqual(c.expr.items[1].logic, 'or', '子组是 or');
  assert.strictEqual(c.expr.items[1].items.length, 2, '子组里两条');
  // 引擎的 describeExpr 递归, 能把它翻成人话 (含子组)
  const text = Engine.describeExpr(c.expr, builder._byId());
  assert.match(text, /或/, '翻译里应出现子组的「或」');
});

test('normalizeExpr: 子组漏写 type:"group" 也不会被丢掉 (模型常忘)', () => {
  // 按"有 items 数组"判分组 —— 漏写 type 的话旧逻辑会当成空 cmp 静默丢掉, 条件少一半
  const expr = Engine.normalizeNode({ type: 'condition', expr: { type: 'group', logic: 'and', items: [
    { left: 'n_q.status', op: '==', right: '未入库' },
    { logic: 'or', items: [{ left: 'n_q.a', op: '==', right: '1' }, { left: 'n_q.b', op: 'notEmpty' }] }
  ] } }).expr;
  assert.strictEqual(expr.items.length, 2, '子组没被丢掉');
  assert.strictEqual(expr.items[1].type, 'group');
  assert.strictEqual(expr.items[1].items.length, 2);
});

test('configure_condition: 嵌套太深直接拦下', async () => {
  // 造 6 层嵌套 (上限 5)
  let item = { left: 'n_q.status', op: '==', right: 'x' };
  for (let i = 0; i < 6; i++) item = { logic: 'and', items: [item] };
  const { builder } = makeBuilder([
    { call: toolCall('plan_task', PLAN) },
    { call: toolCall('write_card', { card: validCard() }) },
    { call: toolCall('configure_condition', { nodeId: 'n_c', logic: 'and', items: [item] }) },
    { content: '好了' }
  ]);
  await builder.send('改条件', () => {});
  const c = builder.card.nodes.find((n) => n.id === 'n_c');
  // 被拦下 -> expr 还是 write_card 里那条平的 (只有 1 条 cmp)
  assert.strictEqual(c.expr.items.length, 1);
  assert.strictEqual(c.expr.items[0].type, 'cmp');
});
