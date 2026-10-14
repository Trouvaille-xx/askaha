'use strict';
/**
 * 规划闸门 —— 用户提的那条企业开发流程:
 *   1. 先出规划 (plan_task)
 *   2. 按规划填充入口/出口/节点逻辑
 *   3. 全部做完之后才测试
 *
 * 为什么要这两个闸门 (不是流程洁癖, 是实测):
 *   一个 90 分钟的搭建会话里 run_test 被叫了 16 次、花了 33.1 分钟 (占全部工具时间的
 *   99.7%), 其中 8 次是在对同一个节点的引号问题反复试。根因是它从来没先把整条链路
 *   想清楚 —— 试跑成了探索需求的手段。这两道闸门把顺序钉死。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const AI = require(path.join(ROOT, 'lib/engine-ai.js'));

/** 造一个最小可用的 builder (不建连、不调模型) */
function mkBuilder() {
  const b = new AI.EngineAiBuilder({
    card: { id: 'c1', name: '测试卡', nodes: [], edges: [] },
    databases: [],
    openDb: async () => { throw new Error('不该连库'); },
    llm: null
  });
  return b;
}

const call = (b, name, args) => b._runTool(null, { name, args: args || {} });

/* ============ 闸门一: 没规划不许改图 ============ */

test('没出规划时, 建节点的工具被拦下来, 并说清该先干什么', async () => {
  const b = mkBuilder();
  const r = await call(b, 'add_node', { nodeType: 'input', title: '入口' });
  assert.ok(r && r.error, '应当返回 error');
  assert.match(r.error, /plan_task/, '要明确告诉它用 plan_task');
  assert.strictEqual(b.card.nodes.length, 0, '卡一个字都不能动');
});

test('没出规划时, 连线/写 SQL/配条件 也全都被拦', async () => {
  const b = mkBuilder();
  for (const [name, args] of [
    ['connect', { from: 'a', to: 'b' }],
    ['configure_query', { nodeId: 'n1', sql: 'SELECT 1' }],
    ['configure_input', { nodeId: 'n1', fields: [] }],
    ['configure_condition', { nodeId: 'n1', items: [{ left: 'x', op: '==', right: '1' }] }],
    ['configure_output', { nodeId: 'n1', template: 'hi' }],
    ['delete_node', { nodeId: 'n1' }],
    ['set_node_title', { nodeId: 'n1', title: 'x' }],
    ['disconnect', { from: 'a' }]
  ]) {
    const r = await call(b, name, args);
    assert.ok(r && r.error && /plan_task/.test(r.error), name + ' 应当被闸门拦下');
  }
});

test('查资料的工具不受闸门影响 (规划本来就要靠它们才写得出来)', async () => {
  const b = mkBuilder();
  // list_available_tables 在空范围下也会返回内容而不是闸门错误
  const r = await call(b, 'list_available_tables', {});
  const text = typeof r === 'string' ? r : (r && r.error) || '';
  assert.doesNotMatch(text, /plan_task/, '查资料不该被规划闸门拦');
});

test('ask_choice 不受闸门影响 —— 需求不清楚时本来就该先问', async () => {
  const b = mkBuilder();
  const r = await call(b, 'ask_choice', {
    question: '结论分几种?',
    options: [{ label: '两种' }, { label: '三种' }]
  });
  assert.ok(r && r.__ask, '应当正常提出问题, 而不是被闸门拦下');
});

/* ============ 闸门只拦"从零搭", 不拦"改已有的卡" ============ */

test('已经搭过的卡 (有取数节点) 直接放行 —— 改个标题不该逼人写规划', async () => {
  const b = mkBuilder();
  b.card.nodes.push({ id: 'q1', type: 'query', title: '查明细', databaseId: 'd', table: 't', sql: 'SELECT 1', outputs: [] });
  const r = await call(b, 'set_node_title', { nodeId: 'q1', title: '查采购明细' });
  assert.ok(!r.error, '改已有的卡不该被规划闸门拦: ' + JSON.stringify(r));
  assert.strictEqual(b.card.nodes.find((n) => n.id === 'q1').title, '查采购明细');
});

test('有条件节点也算搭过 —— 同样放行', async () => {
  const b = mkBuilder();
  b.card.nodes.push({ id: 'c1', type: 'condition', title: '判断', expr: { type: 'group', logic: 'and', items: [] } });
  const r = await call(b, 'add_node', { nodeType: 'output', title: '结论' });
  assert.ok(!r.error, '应当放行: ' + JSON.stringify(r));
});

test('空白新卡 (只有入口和出口) 仍然要规划 —— 这才是那 33 分钟发生的地方', async () => {
  const b = mkBuilder();
  // 模拟 Engine.newEngine() 出来的默认卡: 一个入口 + 一个出口
  b.card.nodes.push({ id: 'in', type: 'input', title: '入口', fields: [] });
  b.card.nodes.push({ id: 'out', type: 'output', title: '出口', template: '' });
  assert.strictEqual(b._hasSubstance(), false, '只有入口出口不算搭过');
  const r = await call(b, 'add_node', { nodeType: 'query', title: '查数据' });
  assert.ok(r.error && /plan_task/.test(r.error), '从零搭必须先进规划');
});

/* ============ plan_task 本身 ============ */

test('plan_task 至少要两步', async () => {
  const b = mkBuilder();
  const r = await call(b, 'plan_task', { steps: [{ title: '只做一件事' }], branches: ['结论A'] });
  assert.ok(r.error);
  assert.match(r.error, /两步/);
  assert.strictEqual(b.plan, null, '不合格的规划不该被记下');
});

test('plan_task 必须给 branches —— 说不出结论就是还没想清楚', async () => {
  const b = mkBuilder();
  const r = await call(b, 'plan_task', {
    steps: [{ title: '查明细' }, { title: '出结论' }]
  });
  assert.ok(r.error);
  assert.match(r.error, /branches/);
  assert.match(r.error, /结论/, '要解释为什么必须要结论');
  assert.strictEqual(b.plan, null);
});

test('合格的规划被记下, 步骤初始都是未完成', async () => {
  const b = mkBuilder();
  const r = await call(b, 'plan_task', {
    steps: [
      { title: '查采购订单明细及入库状态', kind: 'query' },
      { title: '统计已入库行数', kind: 'query' },
      { title: '判断是否全部入库', kind: 'condition' },
      { title: '输出结论', kind: 'output' }
    ],
    branches: ['未全部入库', '入库无误待对账', '入库异常'],
    unknowns: ['待对账口径']
  });
  assert.ok(!r.error, '应当成功: ' + JSON.stringify(r));
  assert.strictEqual(b.plan.steps.length, 4);
  assert.ok(b.plan.steps.every((s) => s.status === 'todo'));
  assert.strictEqual(b.plan.branches.length, 3);
  assert.strictEqual(b.plan.revision, 1);
  assert.match(r, /规划已记下/);
});

test('有规划之后, 建节点的工具就放行了', async () => {
  const b = mkBuilder();
  await call(b, 'plan_task', {
    steps: [{ title: '建入口' }, { title: '建取数' }],
    branches: ['结论A']
  });
  const r = await call(b, 'add_node', { nodeType: 'input', title: '入口' });
  assert.ok(!r.error, '放行之后应当能建节点: ' + JSON.stringify(r));
  assert.strictEqual(b.card.nodes.length, 1);
});

test('步骤 id 没给时自动编 s1/s2, 也能按标题标完成', async () => {
  const b = mkBuilder();
  await call(b, 'plan_task', {
    steps: [{ title: '甲' }, { title: '乙' }],
    branches: ['X']
  });
  assert.deepStrictEqual(b.plan.steps.map((s) => s.id), ['s1', 's2']);
  const r = await call(b, 'plan_step_done', { stepId: '乙' });
  assert.ok(!r.error, '按标题也该能标完成');
  assert.strictEqual(b.plan.steps[1].status, 'done');
});

test('重复标同一步是幂等的, 不报错', async () => {
  const b = mkBuilder();
  await call(b, 'plan_task', { steps: [{ title: '甲' }, { title: '乙' }], branches: ['X'] });
  await call(b, 'plan_step_done', { stepId: 's1' });
  const r = await call(b, 'plan_step_done', { stepId: 's1' });
  assert.ok(!r.error);
  assert.match(r, /之前就标过/);
});

test('标一个不存在的步骤要如实报错, 并列出当前步骤', async () => {
  const b = mkBuilder();
  await call(b, 'plan_task', { steps: [{ title: '甲' }, { title: '乙' }], branches: ['X'] });
  const r = await call(b, 'plan_step_done', { stepId: 's99' });
  assert.ok(r.error);
  assert.match(r.error, /s1/, '要把现有步骤列出来');
});

/* ============ 闸门二: 规划没做完不许测 ============ */

test('规划还有步骤没完成时, run_test 被拦下来并列出剩余步骤', async () => {
  const b = mkBuilder();
  await call(b, 'plan_task', {
    steps: [{ title: '查明细' }, { title: '出结论' }],
    branches: ['X']
  });
  await call(b, 'plan_step_done', { stepId: 's1' });
  const r = await call(b, 'run_test', { inputs: {} });
  assert.ok(r.error, '应当被拦');
  assert.match(r.error, /还有 1 步没做完/);
  assert.match(r.error, /出结论/, '要说清是哪一步没做完');
});

test('规划全部完成之后, run_test 不再被规划闸门拦 (会往下走真跑)', async () => {
  const b = mkBuilder();
  await call(b, 'plan_task', {
    steps: [{ title: '甲' }, { title: '乙' }],
    branches: ['X']
  });
  await call(b, 'plan_step_done', { stepId: 's1' });
  await call(b, 'plan_step_done', { stepId: 's2' });
  const r = await call(b, 'run_test', { inputs: {} });
  // 卡是空的, 所以这里应该因为"没有入口节点"之类的别的原因失败 ——
  // 关键是不能是规划闸门的错
  const text = (r && r.error) || '';
  assert.doesNotMatch(text, /规划里还有/, '不该再是规划闸门的拦截');
});

/* ============ 改规划 ============ */

test('改规划时, 已完成的步骤保留状态 (不逼它把做过的事再做一遍)', async () => {
  const b = mkBuilder();
  await call(b, 'plan_task', {
    steps: [{ id: 's1', title: '查明细' }, { id: 's2', title: '出结论' }],
    branches: ['X']
  });
  await call(b, 'plan_step_done', { stepId: 's1' });
  // 出第二版: 保留 s1(已完成) 和 s2, 新增 s3
  const r = await call(b, 'plan_task', {
    steps: [
      { id: 's1', title: '查明细' },
      { id: 's2', title: '出结论' },
      { id: 's3', title: '补一个异常分支' }
    ],
    branches: ['X', '异常']
  });
  assert.ok(!r.error);
  assert.strictEqual(b.plan.revision, 2);
  assert.strictEqual(b.plan.steps.find((s) => s.id === 's1').status, 'done', 's1 的完成状态要保住');
  assert.strictEqual(b.plan.steps.find((s) => s.id === 's3').status, 'todo');
  assert.match(r, /第 2 版规划/);
});

test('同名步骤被改写了标题, 完成状态就作废 (它其实变了)', async () => {
  const b = mkBuilder();
  await call(b, 'plan_task', {
    steps: [{ id: 's1', title: '查明细' }, { id: 's2', title: '出结论' }],
    branches: ['X']
  });
  await call(b, 'plan_step_done', { stepId: 's1' });
  await call(b, 'plan_task', {
    steps: [{ id: 's1', title: '换个完全不同的做法' }, { id: 's2', title: '出结论' }],
    branches: ['X']
  });
  assert.strictEqual(b.plan.steps.find((s) => s.id === 's1').status, 'todo',
    '标题改了就是另一件事, 不能算做完');
});

/* ============ 落盘 ============ */

test('规划会进 snapshot, 也能从 snapshot 恢复', async () => {
  const b = mkBuilder();
  await call(b, 'plan_task', {
    steps: [{ id: 's1', title: '甲' }, { id: 's2', title: '乙' }],
    branches: ['X']
  });
  await call(b, 'plan_step_done', { stepId: 's1' });
  const snap = b.snapshot();
  assert.ok(snap.plan && snap.plan.steps.length === 2, '规划要落盘');

  // 恢复到一个新会话
  const b2 = mkBuilder();
  assert.strictEqual(b2.plan, null);
  b2.restore(snap);
  assert.ok(b2.plan, '规划要能恢复');
  assert.strictEqual(b2.plan.steps.find((s) => s.id === 's1').status, 'done');
  // 恢复之后闸门应当认得"已经有规划了", 而不是逼它重写一遍
  const r = await call(b2, 'add_node', { nodeType: 'output', title: '结论' });
  assert.ok(!r.error, '恢复规划后该放行: ' + JSON.stringify(r));
});

test('恢复一份没有 plan 的老快照不会炸, 闸门照常要求规划', async () => {
  const b = mkBuilder();
  b.restore({ messages: [], card: { id: 'c', nodes: [], edges: [] } });
  assert.strictEqual(b.plan, null);
  const r = await call(b, 'add_node', { nodeType: 'query', title: 'x' });
  assert.ok(r.error && /plan_task/.test(r.error));
});
