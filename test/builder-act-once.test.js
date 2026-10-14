'use strict';

/**
 * 对话流里"同一个动作报两遍"的回归测试。
 *
 * 用户报的现象: 搭建 Agent 每看一列真实数据, 面板里就出现两行一模一样的话。
 * 真实会话日志里 9 次 look_at_data, 9 次都是成对出现。
 *
 * 根因是**两个地方都在说同一件事**:
 *   - lib/agent-loop 统一运行时通过 describeAct() 报一次 "看了真实数据：表.列"
 *   - 工具自己 (engine-ai.js 里) 又 emit 一次 "看了真实数据：表.列"
 * 字面完全相同, 所以必然成对。
 *
 * 规则改成: "发生了什么"只由 describeAct 说一次; 库名/字段数这类
 * 执行期才知道的结果走工具返回值给模型, 不再往对话流里另发一条。
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
  async chatStep(messages) {
    const turn = this.calls.length;
    this.calls.push({ messages });
    const raw = this.script[Math.min(turn, this.script.length - 1)];
    const step = typeof raw === 'function' ? raw(turn) : raw;
    if (!step) return { content: '', toolCalls: [] };
    if (step.calls) return { content: step.content || '', toolCalls: step.calls };
    if (step.call) return { content: step.content || '', toolCalls: [step.call] };
    return { content: step.content || '', toolCalls: [] };
  }
}

function blankCard() {
  const c = Engine.newEngine();
  const inp = (c.nodes || []).find((n) => n.type === 'input');
  if (inp) inp.fields = [];
  return Engine.normalizeEngine(c);
}

/** 一个够用的假库: 任何查询都回一组能算得下去的行 */
function fakeDb() {
  return {
    queries: [],
    async query(sql) {
      this.queries.push(sql);
      if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ total: 100, nonnull: 98, uniq: 4 }] };
      if (/NON_UNIQUE/i.test(sql)) {
        return { rows: [{ index_name: 'idx_no', column_name: 'no', non_unique: 0, seq: 1 }] };
      }
      if (/pg_indexes/i.test(sql)) return { rows: [{ indexname: 'idx_no', indexdef: 'CREATE INDEX ...' }] };
      return { rows: [{ v: 'A' }, { v: 'B' }] };
    },
    async describeTable() {
      return [{ field: 'no', type: 'varchar' }, { field: 'bill_no', type: 'varchar' }];
    },
    async close() {}
  };
}

function makeBuilder(script) {
  const llm = new FakeLLM(script);
  const builder = new EngineAiBuilder({
    llm,
    pool: { db1: ['invoice_red_apply'] },
    card: blankCard(),
    databases: [{ id: 'db1', name: 'SRM', type: 'mysql', host: 'h', port: 3306, database: 'd', user: 'u' }],
    openDb: () => fakeDb()
  });
  // 从零搭卡现在要先出规划 (见 lib/engine-ai.js 的规划闸门)。这个文件测的是
  // "同一个动作别在对话流里报两遍", 不是规划 —— 所以把规划塞成既成事实。
  // 闸门本身的行为在 test/plan-gate.test.js 里单独测。
  builder.plan = {
    steps: [{ id: 's1', title: '做这个动作', status: 'done' }],
    branches: ['结论'], unknowns: [], revision: 1, at: Date.now()
  };
  return { llm, builder };
}

/** 跑一轮, 收集所有 ai_act */
async function actsFor(call) {
  const { builder } = makeBuilder([{ call }, { content: '好了' }]);
  const evs = [];
  await builder.send('搭卡', (ev) => evs.push(ev));
  return evs.filter((e) => e.type === 'ai_act').map((e) => String(e.text || ''));
}

/* ============================================================ */

test('look_at_data: 只报一次 (以前工具自己发一遍 + describeAct 又发一遍)', async () => {
  const acts = await actsFor(toolCall('look_at_data', {
    dbId: 'db1', table: 'invoice_red_apply', column: 'bill_no'
  }));
  const hit = acts.filter((t) => /看了真实数据/.test(t));
  assert.strictEqual(hit.length, 1,
    '同一个动作在对话流里只能出现一次, 实际 ' + hit.length + ' 次: ' + JSON.stringify(hit));
  assert.match(hit[0], /invoice_red_apply\.bill_no/, '要带上表和列, 否则用户不知道看了什么');
});

test('check_index: 只报一次', async () => {
  const acts = await actsFor(toolCall('check_index', {
    dbId: 'db1', table: 'invoice_red_apply', column: 'no'
  }));
  const hit = acts.filter((t) => /索引/.test(t));
  assert.strictEqual(hit.length, 1,
    '实际 ' + hit.length + ' 次: ' + JSON.stringify(hit));
  assert.match(hit[0], /invoice_red_apply/);
});

test('describe_tables: 只报一次', async () => {
  const acts = await actsFor(toolCall('describe_tables', { tables: ['invoice_red_apply'] }));
  const hit = acts.filter((t) => /表结构/.test(t));
  assert.strictEqual(hit.length, 1,
    '实际 ' + hit.length + ' 次: ' + JSON.stringify(hit));
});

test('连看几列也不会累积重复 (每次调用恰好一行)', async () => {
  const cols = ['bill_no', 'no', 'invoice_no'];
  const { builder } = makeBuilder([
    { calls: cols.map((c, i) => toolCall('look_at_data',
      { dbId: 'db1', table: 'invoice_red_apply', column: c }, 'c' + i)) },
    { content: '好了' }
  ]);
  const evs = [];
  await builder.send('看看这几列', (ev) => evs.push(ev));

  const hit = evs.filter((e) => e.type === 'ai_act' && /看了真实数据/.test(String(e.text || '')));
  assert.strictEqual(hit.length, cols.length,
    '3 列应该正好 3 行, 实际 ' + hit.length + ' 行: ' + JSON.stringify(hit.map((e) => e.text)));
});

test('其它工具照旧只报一次 (没被这次改动误伤)', async () => {
  const acts = await actsFor(toolCall('add_node', { nodeType: 'query', title: '查红字申请' }));
  const hit = acts.filter((t) => /加了一个节点/.test(t));
  assert.strictEqual(hit.length, 1, '实际 ' + hit.length + ' 次: ' + JSON.stringify(hit));
});

test('动作失败了就不该报成"做过了"', async () => {
  // 越界的表: 工具会返回 error, 不该在对话流里留下"看了真实数据"的痕迹
  const acts = await actsFor(toolCall('look_at_data', {
    dbId: 'db1', table: 'secret_table', column: 'x'
  }));
  assert.strictEqual(acts.filter((t) => /看了真实数据/.test(t)).length, 0,
    '失败的动作不能写成做过了: ' + JSON.stringify(acts));
});
