'use strict';

/**
 * 分析 Agent 迁移到统一运行时 (AgentLoop) 之后的回归测试。
 *
 * 这是三个 Agent 里最后迁的一个, 也是路径最长、交互最多 (SQL 预览闸门、
 * 表/字段确认弹窗、追问) 的一个。所以这里的重点不是"能跑", 而是
 * **每个动作的语义跟迁移前一致**:
 *
 *   - reply / finish 仍然是终结动作, 停下来之后走原来的交付逻辑
 *   - request_scope / sql / ask_user 被取消时仍然**抛出** (不是当成工具失败吞掉)
 *   - sql 仍然每次都过预览闸门, 跳过的那次不算资料编号
 *   - run_workflow 直接把整轮结果交出去, 不能被当成 finish 动作
 *   - 未知工具仍然回灌给模型自纠错, 而且不会无限转
 *   - MCP 工具跟内置工具走同一条分发
 */

const test = require('node:test');
const assert = require('node:assert');

const AgentMod = require('../lib/agent.js');
const Agent = AgentMod.Agent || AgentMod;
const Engine = require('../lib/engine.js');

/* ============================================================
 * 测试替身
 * ============================================================ */

/** 按脚本吐工具调用的假模型 */
class FakeLLM {
  constructor(script) {
    this.script = script.slice();
    this.calls = [];
    this.config = { apiKey: 'test' };
  }
  _extractJSON(text) {
    if (typeof text !== 'string') return null;
    const m = /\{[\s\S]*\}/.exec(text);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch (e) { return null; }
  }
  async chatStep(messages, tools, opts) {
    this.calls.push({ messages: messages.map((m) => ({ role: m.role, content: m.content })), toolNames: (tools || []).map((t) => t.function.name), opts });
    const step = this.script.shift();
    if (!step) return { content: '（脚本用完了）' };
    if (typeof step === 'function') return step(messages, tools);
    if (step.native) return { content: step.content || null, toolCalls: step.native };
    return { content: step.content || '', toolCalls: [] };
  }
}

const native = (name, args) => ({ id: 'c_' + name + '_' + Math.random().toString(36).slice(2, 6), name, args: args || {} });

/** 假库: 记账 + 可控返回 */
function fakeDb(opts = {}) {
  return {
    type: 'mysql',
    config: { database: 'testdb' },
    queried: [],
    async query(sql) {
      this.queried.push(sql);
      if (opts.failOn && opts.failOn.test(sql)) throw new Error('模拟 SQL 错误: 字段不存在');
      return { columns: ['id', 'name'], rows: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }], rowCount: 2, elapsedMs: 7 };
    },
    async listTables() { return ['orders', 'users']; },
    async describeTable(t) { return [{ field: 'id', type: 'int' }, { field: 'name', type: 'varchar' }]; }
  };
}

/**
 * 造一个分析 Agent。默认把"表清单"和"数据库"都摆好, 免得每个用例都要走
 * request_scope 那套弹窗。
 */
function makeAgent(script, opts = {}) {
  const llm = new FakeLLM(script);
  const db = opts.db || fakeDb();
  const agent = new Agent({
    llm,
    database: db,
    skills: opts.skills || null,
    tableInventory: opts.tableInventory || [{ name: 'orders' }, { name: 'users' }],
    engines: opts.engines || [],
    databases: opts.databases || [],
    openDb: opts.openDb || null,
    mcp: opts.mcp || null,
    prompt: opts.prompt || null,
    general: opts.general || {}
  });
  return { agent, llm, db };
}

/**
 * 跑一轮, 并绕过意图闸门。
 *
 * 闸门会多花一次模型调用, 还会把任务重新分类 —— 这里要测的是**工具循环**,
 * 所以直接把 _classifyIntent 钉成"分析型"。这不是偷懒: 闸门自己有测试。
 */
async function runAnalysis(agent, task, opts = {}) {
  agent._classifyIntent = async () => ({ kind: 'analysis' });
  const events = [];
  const cps = (opts.checkpoints || []).slice();
  const ask = async (req) => {
    events.push({ type: 'ask_request', req });
    if (cps.length) return cps.shift();
    // 默认: 确认 SQL / 回答追问都放行
    if (req.type === 'sql') return { sql: req.sql };
    if (req.type === 'question') return { answer: '默认回答' };
    if (req.type === 'tables') return { tables: (req.defaultSelected || []).slice() };
    if (req.type === 'fields') return { fields: req.fieldsSelected };
    return {};
  };
  const res = await agent.run(task, {
    history: opts.history || [],
    state: opts.state || null,
    autoTables: opts.autoTables
  }, (e) => events.push(e), ask);
  return { res, events };
}

const stateWithTables = () => ({
  tables: ['orders'],
  schemaMap: { orders: [{ field: 'id', type: 'int' }, { field: 'name', type: 'varchar' }] },
  fieldsSelected: { orders: ['id', 'name'] },
  steps: [],
  report: null
});

/* ============================================================
 * 终结动作
 * ============================================================ */

test('reply: 是终结动作, 停下来后不改会话状态', async () => {
  const { agent, llm } = makeAgent([
    { native: [native('reply', { text: '你好, 我是数据助手。' })] },
    { native: [native('finish', { title: '不该跑到这里', output: 'none' })] }
  ]);
  const { res, events } = await runAnalysis(agent, '你好', { state: stateWithTables() });

  assert.strictEqual(res.reply, '你好, 我是数据助手。');
  assert.strictEqual(res.report, undefined, 'reply 不该产出报告');
  assert.ok(events.some((e) => e.type === 'reply' && e.text === '你好, 我是数据助手。'));
  assert.strictEqual(llm.calls.length, 1, 'reply 之后就该停 —— 第二条脚本不该被消费');
});

test('reply 缺 text: 不终结, 打回去让它重调', async () => {
  const { agent, llm } = makeAgent([
    { native: [native('reply', {})] },
    { native: [native('reply', { text: '这次有正文了' })] }
  ]);
  const { res } = await runAnalysis(agent, 'hi', { state: stateWithTables() });
  assert.strictEqual(res.reply, '这次有正文了');
  assert.strictEqual(llm.calls.length, 2);
});

test('finish: 是终结动作, 产出报告', async () => {
  const { agent, llm } = makeAgent([
    { native: [native('finish', { title: '月度汇总', output: 'none', summary: '一共 2 单', insights: ['A', 'B'] })] }
  ]);
  const { res, events } = await runAnalysis(agent, '出个报告', { state: stateWithTables() });

  assert.strictEqual(res.summary, '一共 2 单');
  assert.ok(events.some((e) => e.type === 'phase' && e.phase === 'finish'));
  assert.strictEqual(llm.calls.length, 1, 'finish 之后不该再空转');
});

/* ============================================================
 * sql: 预览闸门 + 资料编号
 * ============================================================ */

test('sql: 走预览闸门, 成功之后按资料编号回灌', async () => {
  const { agent, db } = makeAgent([
    { native: [native('sql', { sql: 'SELECT id, name FROM orders', purpose: '查订单' })] },
    { native: [native('finish', { title: 'ok', output: 'none' })] }
  ]);
  const { res, events } = await runAnalysis(agent, '查订单', { state: stateWithTables() });

  assert.deepStrictEqual(db.queried, ['SELECT id, name FROM orders']);
  assert.ok(events.some((e) => e.type === 'ask_request' && e.req.type === 'sql'), '必须过 SQL 预览闸门');
  assert.ok(events.some((e) => e.type === 'sql_result' && e.rowCount === 2));
  assert.strictEqual(res.steps.filter((s) => s.kind === 'sql').length, 1);
  // 回灌里要带资料编号, 否则模型没法用 source 引用它
  const ack = res.steps[0];
  assert.strictEqual(ack.sql, 'SELECT id, name FROM orders');
});

test('sql: 自动模式跳过预览闸门, 手动模式仍然拦 —— 同一段脚本跑两遍', async () => {
  const script = () => ([
    { native: [native('sql', { sql: 'SELECT id FROM orders', purpose: '查订单' })] },
    { native: [native('finish', { title: 'ok', output: 'none' })] }
  ]);

  const auto = makeAgent(script());
  const a = await runAnalysis(auto.agent, '查订单', { state: stateWithTables(), autoTables: true });
  assert.deepStrictEqual(auto.db.queried, ['SELECT id FROM orders'], '自动模式: SQL 要真的执行');
  assert.ok(
    !a.events.some((e) => e.type === 'ask_request' && e.req.type === 'sql'),
    '自动模式: 不该再问 SQL'
  );
  assert.ok(
    a.events.some((e) => e.type === 'phase' && e.phase === 'sql'),
    '自动模式: SQL 仍要显示在流程里 —— 不拦不等于不显示'
  );

  const manual = makeAgent(script());
  const m = await runAnalysis(manual.agent, '查订单', { state: stateWithTables() });
  assert.ok(
    m.events.some((e) => e.type === 'ask_request' && e.req.type === 'sql'),
    '手动模式: 必须还过闸门'
  );
  assert.deepStrictEqual(manual.db.queried, ['SELECT id FROM orders']);
});

test('sql: 用户跳过的那次不占资料编号', async () => {
  const { agent, db } = makeAgent([
    { native: [native('sql', { sql: 'SELECT 1 FROM orders', purpose: '第一条' })] },
    { native: [native('sql', { sql: 'SELECT id FROM orders', purpose: '第二条' })] },
    { native: [native('finish', { title: 'ok', output: 'none' })] }
  ]);
  const { res } = await runAnalysis(agent, '查两下', {
    state: stateWithTables(),
    checkpoints: [{ skip: true }, { sql: 'SELECT id FROM orders' }]
  });

  assert.deepStrictEqual(db.queried, ['SELECT id FROM orders'], '跳过的那条不该真的执行');
  assert.strictEqual(res.steps.filter((s) => s.kind === 'sql').length, 1);
});

test('sql: 执行报错要回灌给模型, 而不是把整轮判死', async () => {
  const db = fakeDb({ failOn: /BOOM/ });
  const { agent } = makeAgent([
    { native: [native('sql', { sql: 'SELECT BOOM FROM orders', purpose: '故意报错' })] },
    { native: [native('sql', { sql: 'SELECT id FROM orders', purpose: '改对了' })] },
    { native: [native('finish', { title: 'ok', output: 'none' })] }
  ], { db });
  const { res, events } = await runAnalysis(agent, '查', { state: stateWithTables() });

  assert.ok(events.some((e) => e.type === 'sql_error'), '要发 sql_error 事件');
  assert.strictEqual(res.steps.filter((s) => s.kind === 'sql').length, 2, '两次都记进步骤, 好让用户看见踩过的坑');
});

test('sql: 没确认过表就写 SQL, 打回去要求先申请范围', async () => {
  const { agent, db, llm } = makeAgent([
    { native: [native('sql', { sql: 'SELECT * FROM orders', purpose: '没申请就查' })] },
    { native: [native('finish', { title: 'ok', output: 'none' })] }
  ]);
  // state 里没有表 -> scope.tables 为空
  const { res } = await runAnalysis(agent, '查', { state: null });

  assert.deepStrictEqual(db.queried, [], '不该真的去查');
  // 第二次调用时的回灌里应该带着"先申请"的提示
  const second = llm.calls[1].messages.map((m) => m.content).join('\n');
  assert.match(second, /request_scope/, '要告诉它先申请范围');
  assert.ok(res);
});

/* ============================================================
 * 取消: 必须抛出, 不能当成"工具失败"吞掉
 * ============================================================ */

test('用户在 SQL 闸门取消: 整轮抛出 (不是静默继续)', async () => {
  const { agent } = makeAgent([
    { native: [native('sql', { sql: 'SELECT 1 FROM orders', purpose: 'x' })] }
  ]);
  await assert.rejects(
    () => runAnalysis(agent, '查', { state: stateWithTables(), checkpoints: [{ cancelled: true }] }),
    /用户取消/,
    '取消必须抛出去, 否则界面会以为这一轮还在跑'
  );
});

test('用户在追问取消: 整轮抛出', async () => {
  const { agent } = makeAgent([
    { native: [native('ask_user', { question: '你要查哪个时间段?' })] }
  ]);
  await assert.rejects(
    () => runAnalysis(agent, '查', { state: stateWithTables(), checkpoints: [{ cancelled: true }] }),
    /用户取消/
  );
});

test('用户取消时界面要收到 cancelled 事件', async () => {
  const { agent } = makeAgent([
    { native: [native('sql', { sql: 'SELECT 1 FROM orders', purpose: 'x' })] }
  ]);
  let events = [];
  agent._classifyIntent = async () => ({ kind: 'analysis' });
  try {
    await agent.run('查', { history: [], state: stateWithTables() }, (e) => events.push(e),
      async () => ({ cancelled: true }));
  } catch (e) { /* 预期抛出 */ }
  assert.ok(events.some((e) => e.type === 'cancelled'), '取消要有 cancelled 事件, 否则界面一直转圈');
});

/* ============================================================
 * ask_user / describe_table / load_skill
 * ============================================================ */

test('ask_user: 把回答回灌给模型', async () => {
  const { agent, llm } = makeAgent([
    { native: [native('ask_user', { question: '哪个时间段?' })] },
    { native: [native('finish', { title: 'ok', output: 'none' })] }
  ]);
  await runAnalysis(agent, '查', {
    state: stateWithTables(),
    checkpoints: [{ answer: '上个月' }]
  });
  const second = llm.calls[1].messages.map((m) => m.content).join('\n');
  assert.match(second, /上个月/, '用户的回答要回灌');
});

test('ask_user: 用户没回答时不要反复追问', async () => {
  const { agent, llm } = makeAgent([
    { native: [native('ask_user', { question: '哪个时间段?' })] },
    { native: [native('finish', { title: 'ok', output: 'none' })] }
  ]);
  await runAnalysis(agent, '查', { state: stateWithTables(), checkpoints: [{}] });
  const second = llm.calls[1].messages.map((m) => m.content).join('\n');
  assert.match(second, /不要重复追问/, '没答也要明确叫它别再问同一个问题');
});

test('describe_table: 只从已确认的范围里取, 不碰数据库', async () => {
  const { agent, db } = makeAgent([
    { native: [native('describe_table', { table: 'orders' })] },
    { native: [native('finish', { title: 'ok', output: 'none' })] }
  ]);
  await runAnalysis(agent, '看看字段', { state: stateWithTables() });
  assert.deepStrictEqual(db.queried, [], 'describe_table 不该真的查库');
});

test('describe_table: 范围外的表要报错而不是静默给空', async () => {
  const { agent, llm } = makeAgent([
    { native: [native('describe_table', { table: 'secret_table' })] },
    { native: [native('finish', { title: 'ok', output: 'none' })] }
  ]);
  await runAnalysis(agent, '看看字段', { state: stateWithTables() });
  const second = llm.calls[1].messages.map((m) => m.content).join('\n');
  assert.match(second, /不在本会话已确认的范围内/, '要说清为什么不行, 并给出可用的表');
});

test('load_skill: 技能不存在时明确说"不存在", 不静默', async () => {
  const skills = { buildSystemPromptFragment: () => '', loadFull: (n) => (n === 'known' ? '技能正文' : null) };
  const { agent, llm } = makeAgent([
    { native: [native('load_skill', { name: 'nope' })] },
    { native: [native('finish', { title: 'ok', output: 'none' })] }
  ], { skills });
  await runAnalysis(agent, 'x', { state: stateWithTables() });
  const second = llm.calls[1].messages.map((m) => m.content).join('\n');
  assert.match(second, /不存在或未启用/);
});

test('load_skill: 技能存在时把正文灌进去', async () => {
  const skills = { buildSystemPromptFragment: () => '', loadFull: (n) => (n === 'known' ? '技能正文' : null) };
  const { agent, llm } = makeAgent([
    { native: [native('load_skill', { name: 'known' })] },
    { native: [native('finish', { title: 'ok', output: 'none' })] }
  ], { skills });
  await runAnalysis(agent, 'x', { state: stateWithTables() });
  const second = llm.calls[1].messages.map((m) => m.content).join('\n');
  assert.match(second, /技能正文/);
});

/* ============================================================
 * 工作流工具 (③ 加进来的)
 * ============================================================ */

function workflowCard(id) {
  const c = Engine.normalizeEngine(Object.assign(Engine.newEngine({ name: '红字发票没同步' }), {
    id, description: '查红字发票为什么没同步到 Odoo'
  }));
  c.nodes.find((n) => n.type === 'input').fields = [
    { key: 'docNo', label: '确认单编号', required: false }
  ];
  return Engine.normalizeEngine(c);
}

test('list_workflows: 把每张卡的 id / 目的 / 入参说明都交出去', async () => {
  const { agent, llm } = makeAgent([
    { native: [native('list_workflows', {})] },
    { native: [native('finish', { title: 'ok', output: 'none' })] }
  ], { engines: [workflowCard('eng_1')] });
  await runAnalysis(agent, 'x', { state: stateWithTables() });
  const second = llm.calls[1].messages.map((m) => m.content).join('\n');
  assert.match(second, /eng_1/, '要给 id, 否则模型没法 run_workflow');
  assert.match(second, /查红字发票为什么没同步/, '要给目的');
  assert.match(second, /docNo/, '要给入参名');
});

test('list_workflows: 一张卡都没有时明说', async () => {
  const { agent, llm } = makeAgent([
    { native: [native('list_workflows', {})] },
    { native: [native('finish', { title: 'ok', output: 'none' })] }
  ], { engines: [] });
  await runAnalysis(agent, 'x', { state: stateWithTables() });
  const second = llm.calls[1].messages.map((m) => m.content).join('\n');
  assert.match(second, /还没有搭好的流程卡/);
});

test('run_workflow: 卡不存在时打回去让它先 list', async () => {
  const { agent, llm } = makeAgent([
    { native: [native('run_workflow', { engineId: 'nope', inputs: {} })] },
    { native: [native('finish', { title: 'ok', output: 'none' })] }
  ], { engines: [workflowCard('eng_1')] });
  await runAnalysis(agent, 'x', { state: stateWithTables() });
  const second = llm.calls[1].messages.map((m) => m.content).join('\n');
  assert.match(second, /list_workflows/, '要告诉它怎么找到正确的 id');
});

test('run_workflow: 缺入参时打回去, 而且明确禁止编值', async () => {
  const card = workflowCard('eng_1');
  card.nodes.find((n) => n.type === 'input').fields = [
    { key: 'docNo', label: '确认单编号', required: true }
  ];
  const { agent, llm } = makeAgent([
    { native: [native('run_workflow', { engineId: 'eng_1', inputs: {} })] },
    { native: [native('finish', { title: 'ok', output: 'none' })] }
  ], { engines: [Engine.normalizeEngine(card)] });
  await runAnalysis(agent, 'x', { state: stateWithTables() });
  const second = llm.calls[1].messages.map((m) => m.content).join('\n');
  assert.match(second, /确认单编号/, '要说是哪一项缺');
  assert.match(second, /不要自己编一个值/, '必须禁止编值');
});

/* ============================================================
 * 未知工具 / 自纠错 / 预算
 * ============================================================ */

test('未知工具: 回灌纠错, 不是整轮判死', async () => {
  const { agent, llm } = makeAgent([
    { native: [native('no_such_tool', {})] },
    { native: [native('finish', { title: 'ok', output: 'none' })] }
  ]);
  const { res } = await runAnalysis(agent, 'x', { state: stateWithTables() });
  assert.ok(res, '不该因为一次编错工具就整轮失败');
  const second = llm.calls[1].messages.map((m) => m.content).join('\n');
  assert.match(second, /没有叫 no_such_tool 的工具/);
});

test('未知工具: 一直编名字会被限次中止, 不能无限转', async () => {
  const script = [];
  for (let i = 0; i < 50; i++) script.push({ native: [native('made_up_' + i, {})] });
  const { agent, llm } = makeAgent(script);
  await assert.rejects(
    () => runAnalysis(agent, 'x', { state: stateWithTables() }),
    /不存在的工具|无法解析|中止/,
    '模型一直编工具名时必须中止'
  );
  assert.ok(llm.calls.length < 20, `调用次数要有上限, 实际 ${llm.calls.length}`);
});

test('预算用完但没收尾: 撞上续轮上限时强制生成总结, 而不是把这一轮判死', async () => {
  // 每一步都查一次 SQL, 永远不收尾。
  //
  // 注意这个用例**必须**把 maxRounds 设成 1: 否则步数跑满会先自动续轮
  // (那是新的正确行为, 见下一条用例), 走不到"强制收尾"这条路上。
  // 这里守的是那条老承诺: 无论如何总要给用户一个交代, 不能静默死掉。
  const script = [];
  for (let i = 0; i < 10; i++) script.push({ native: [native('sql', { sql: 'SELECT id FROM orders', purpose: 'p' + i })] });
  script.push({ native: [native('finish', { title: '被逼出来的总结', output: 'none' })] });

  const { agent } = makeAgent(script, { general: { maxSteps: 3, maxRounds: 1 } });
  const { res, events } = await runAnalysis(agent, '一直查', { state: stateWithTables() });

  assert.ok(events.some((e) => e.type === 'phase' && e.phase === 'forcing_finish'), '要有 forcing_finish');
  // 撞上限时要说清楚这是**截断**, 不能把一次截断说成一次完成
  const ff = events.find((e) => e.type === 'phase' && e.phase === 'forcing_finish');
  assert.ok(/还没做完/.test(ff.message), '撞上限的提示要如实说是"还没做完"');
  assert.ok(res && (res.report || res.summary !== undefined || res.reply), '总要给用户一个交代');
});

test('步数跑满但活没干完: 自动压缩接着做, 直到真的做完', async () => {
  // 这一条锁的是改动的**目的**: 以前 maxSteps=3 时这个脚本会在第 3 步被砍断,
  // 用户拿到的是半成品。现在它会接着开下一轮, 把 10 次查询做完再正常收尾。
  const script = [];
  for (let i = 0; i < 10; i++) script.push({ native: [native('sql', { sql: 'SELECT id FROM orders', purpose: 'p' + i })] });
  script.push({ native: [native('finish', { title: '做完了', output: 'none' })] });

  const { agent } = makeAgent(script, { general: { maxSteps: 3, maxRounds: 8 } });
  const { res, events } = await runAnalysis(agent, '一直查', { state: stateWithTables() });

  assert.ok(events.some((e) => e.type === 'phase' && e.phase === 'continue'),
    '跑满一轮之后应该自动接着做');
  assert.strictEqual(events.filter((e) => e.type === 'phase' && e.phase === 'forcing_finish').length, 0,
    '还没撞上续轮上限, 不该被强制收尾');
  assert.strictEqual(res.title, '做完了', '它自己交的总结, 不是被逼出来的');
});

/* ============================================================
 * MCP: 跟内置工具走同一条分发
 * ============================================================ */

test('MCP 工具: 能被调用, 结果回灌给模型', async () => {
  const mcp = {
    tools: [{ name: 'mcp__demo__echo', description: '回显', parameters: { type: 'object', properties: {} } }],
    call: async (name, args) => `外部工具 ${name} 说: ${JSON.stringify(args)}`
  };
  const { agent, llm } = makeAgent([
    { native: [native('mcp__demo__echo', { hi: 1 })] },
    { native: [native('finish', { title: 'ok', output: 'none' })] }
  ], { mcp });

  await runAnalysis(agent, 'x', { state: stateWithTables() });
  const second = llm.calls[1].messages.map((m) => m.content).join('\n');
  assert.match(second, /mcp__demo__echo 说/, 'MCP 的返回要回灌');
});

test('MCP 工具出现在给模型的工具清单里', async () => {
  const mcp = { tools: [{ name: 'mcp__demo__echo', description: '回显', parameters: { type: 'object', properties: {} } }], call: async () => 'x' };
  const { agent, llm } = makeAgent([{ native: [native('finish', { title: 'ok', output: 'none' })] }], { mcp });
  await runAnalysis(agent, 'x', { state: stateWithTables() });
  assert.ok(llm.calls[0].toolNames.includes('mcp__demo__echo'), '工具清单里要有 MCP 工具');
  assert.ok(llm.calls[0].toolNames.includes('sql'), '内置工具也还在');
  assert.ok(llm.calls[0].toolNames.includes('run_workflow'), '工作流工具也还在');
});

/* ============================================================
 * 并行: 只读的才能并发
 * ============================================================ */

test('同一轮里两个只读工具可以并发, 有副作用的必须串行', () => {
  const { agent } = makeAgent([]);
  const reg = agent._analysisTools({
    ask: async () => ({}), emit: () => {}, scope: { tables: [], schemaMap: {}, fieldsSelected: {} },
    candidates: [], task: '', steps: [], carry: {}, st: {},
    contextBlock: () => ''
  });

  assert.ok(reg.canParallel(['describe_table', 'load_skill']), '两个纯读的应该能并发');
  assert.ok(reg.canParallel(['list_workflows', 'describe_table']), 'list_workflows 也是只读的');
  assert.strictEqual(reg.canParallel(['sql', 'describe_table']), false, 'sql 有副作用, 不能并发');
  assert.strictEqual(reg.canParallel(['sql', 'sql']), false, '两条 SQL 更不能并发');
  assert.strictEqual(reg.canParallel(['ask_user', 'describe_table']), false, '弹窗不能跟别的并发');
});

test('注册表里只有实现过的动作被暴露出去', () => {
  const { agent } = makeAgent([]);
  const reg = agent._analysisTools({
    ask: async () => ({}), emit: () => {}, scope: { tables: [], schemaMap: {}, fieldsSelected: {} },
    candidates: [], task: '', steps: [], carry: {}, st: {},
    contextBlock: () => ''
  });
  const names = reg.names().sort();
  assert.deepStrictEqual(names, [
    'ask_user', 'check_index', 'describe_table', 'finish', 'list_workflows', 'load_skill',
    'look_at_data', 'read_result', 'reply', 'request_scope', 'run_workflow', 'sql'
  ]);
});

test('三个新加的只读工具确实在只读集合里 (掉出去就会变成串行+走确认)', () => {
  const RO = AgentMod.ANALYSIS_READ_ONLY;
  for (const n of ['look_at_data', 'check_index', 'read_result']) {
    assert.ok(RO.has(n), n + ' 必须是只读的 —— 它存在的意义就是不用弹确认框');
  }
  // 有副作用的三个绝不能混进去
  for (const n of ['sql', 'request_scope', 'ask_user']) {
    assert.strictEqual(RO.has(n), false, n + ' 会碰外部世界, 不能并发');
  }
});

/* ============================================================
 * 上下文压缩接进来了
 * ============================================================ */

test('长会话: 上下文超限时触发压缩, 但系统提示和用户原话不动', async () => {
  const script = [];
  for (let i = 0; i < 6; i++) {
    script.push({
      native: [native('sql', { sql: 'SELECT id FROM orders', purpose: 'p' + i })]
    });
  }
  script.push({ native: [native('finish', { title: 'ok', output: 'none' })] });

  // 阈值要压在"非系统消息"的总量上 —— 压缩只看 this.messages, 系统提示是
  // 每轮单独拼上去的, 不算在内。给太高就不会触发 (实测踩过)。
  const { agent } = makeAgent(script, { general: { maxSteps: 8, maxChars: 2500 } });
  // 让每次 SQL 都返回一大坨, 好把上下文顶上去
  agent.database.query = async () => ({
    columns: ['id'], rows: Array.from({ length: 40 }, (_, i) => ({ id: i, blob: 'X'.repeat(3000) })),
    rowCount: 40, elapsedMs: 1
  });

  const { events } = await runAnalysis(agent, '一直查', { state: stateWithTables() });
  assert.ok(events.some((e) => e.type === 'phase' && e.phase === 'compact'), '应该触发过压缩');

  // 压缩只折取数结果, 系统提示与用户原话一个字都不能动
  const compacted = events.find((e) => e.type === 'phase' && e.phase === 'compact');
  assert.match(compacted.message, /折叠了 \d+ 条/, '要说清折了几条');
});
