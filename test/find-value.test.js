'use strict';

/**
 * `find_value` 的回归测试 —— "这个值到底存在哪一列"。
 *
 * 起因 (2026-09-23 真实会话): 模型为了找"SRM 侧哪一列装着 PO 号",
 * 自己写了 4 条探针 SQL —— `WHERE a LIKE 'PO%' OR b LIKE 'PO%' OR ...`
 * 十几列拼起来, 在 946 万行的表上全表扫, 单条最贵 **129.8 秒**,
 * 四条加起来约 250 秒。而它想回答的问题本来是一条等值探测就能答的。
 *
 * 这个工具直接复用 lib/table-match.js 里那套值探测 (runProbes) ——
 * 它已经把这件做对了: 大表只试有索引的列、有硬预算、超预算当"没试过"。
 *
 * 要钉住的三件事:
 *   1. 找到的列要明说"真的装着这个值" —— 这是模型的证据
 *   2. **没试到的列必须单独列出来** —— 绝不能把"我没查"说成"没有",
 *      那会让模型得出"这列是空的、不能当关联键"这种它会据此建错卡的结论
 *   3. 大表上没索引的候选列: 不试, 但要如实说"没试"而不是静默跳过
 */

const test = require('node:test');
const assert = require('node:assert');

const { EngineAiBuilder } = require('../lib/engine-ai.js');
const Engine = require('../lib/engine.js');
const { ToolRegistry } = require('../lib/tools.js');
const { AgentLoop } = require('../lib/agent-loop.js');

const DB = { id: 'db1', name: 'OMS', type: 'mysql' };

/** 假的连接: 记录发出去的 SQL, 按 pattern 决定返回什么 */
function makeDb({ hits = [], rows = [], cols = [], big = false } = {}) {
  const seen = [];
  return {
    seen,
    async describeTable() { return cols; },
    async schemaDigest() {
      return new Map([['t', { table: 't', rows: big ? 9460000 : 100, cols }]]);
    },
    async query(sql) {
      seen.push(sql);
      for (const h of hits) if (sql.includes(h)) return { rows: [{ hit: 1 }] };
      return { rows: [] };
    },
    async close() {}
  };
}

function makeBuilder(db, { pool } = {}) {
  const llm = {
    config: { apiKey: 'x' },
    async chatStep() { return { content: '', toolCalls: [] }; },
    async chat() { return '{}'; },
    _extractJSON: (r) => JSON.parse(r)
  };
  const reg = new ToolRegistry();
  const ctx = {
    toLoop(o) { return new AgentLoop(o); },
    llm,
    tools: reg
  };
  const builder = new EngineAiBuilder({
    llm, ctx,
    card: { id: 'c1', nodes: [] },
    databases: [DB],
    pool: pool || { db1: ['t'] },
    openDb: () => db,
    emit: () => {}
  });
  return builder;
}

/** 直接调工具 —— 走 builder 真实的 _registry(), 和模型调用同一条路径 */
async function callTool(builder, name, args) {
  const reg = builder._registry();
  return reg.call(name, args);
}

const ID_COLS = [
  { field: 'ORDER_NO', type: 'varchar(32)', comment: '', indexed: false },
  { field: 'REFERENCE_DOC_NO', type: 'varchar(32)', comment: '', indexed: false }
];

test('find_value: 找到的列要明说"真的装着这个值"', async () => {
  const db = makeDb({
    hits: ['ORDER_NO'],
    cols: [
      { field: 'ORDER_NO', type: 'varchar(32)', comment: '', indexed: true },
      { field: 'OTHER_NO', type: 'varchar(32)', comment: '', indexed: true }
    ]
  });
  const out = await callTool(makeBuilder(db), 'find_value', {
    dbId: 'db1', table: 't', value: 'PO20260921000003'
  });
  assert.match(out, /真的装着/, '要给出"确实找到了"的明确结论');
  assert.match(out, /ORDER_NO/, '命中的列名要在');
  assert.match(out, /PO20260921000003/, '找的值要回显');
});

test('find_value: 没试到的列必须单独列出来 —— 不能说成"没有"', async () => {
  // 946 万行的表, 两个像单号的列都没索引 -> 一条都不试
  const db = makeDb({ cols: ID_COLS, big: true });
  const out = await callTool(makeBuilder(db), 'find_value', {
    dbId: 'db1', table: 't', value: 'PO20260921000003'
  });
  assert.match(out, /没试到/, '必须说清"这些列没试到"');
  assert.match(out, /ORDER_NO/, '没试到的列名要列出来');
  assert.match(out, /不代表没有|不等于/, '要明确"没找到不等于不存在"');
  assert.strictEqual(db.seen.length, 0, '大表 + 没索引: 一条探测都不该发出去 (那是全表扫)');
});

test('find_value: 小表不限索引, 该试的都试', async () => {
  const db = makeDb({ cols: ID_COLS, big: false });
  const out = await callTool(makeBuilder(db), 'find_value', {
    dbId: 'db1', table: 't', value: 'PO20260921000003'
  });
  assert.ok(db.seen.length >= 2, '小表的两个候选列都该试, 实际发了 ' + db.seen.length + ' 条');
  for (const sql of db.seen) {
    assert.match(sql, /LIMIT 1|TOP 1/, '探测要带上限, 不能把结果全捞回来');
  }
});

test('find_value: 一次找多个值', async () => {
  const db = makeDb({ hits: ['ORDER_NO'], cols: [{ field: 'ORDER_NO', type: 'varchar(32)', comment: '', indexed: true }] });
  const out = await callTool(makeBuilder(db), 'find_value', {
    dbId: 'db1', table: 't', values: ['PO20260921000003', 'PO20230309017454']
  });
  assert.match(out, /PO20260921000003/, '第一个值要在');
  assert.match(out, /PO20230309017454/, '第二个值也要在');
});

test('find_value: 表不在可用范围里 -> 拒绝', async () => {
  const db = makeDb({ cols: ID_COLS });
  const out = await callTool(makeBuilder(db), 'find_value', {
    dbId: 'db1', table: 'secrets', value: 'x'
  });
  assert.match(String(out.error || out), /不在本次可用范围/, '白名单要自己守住');
  assert.strictEqual(db.seen.length, 0, '越界时一条查询都不该发');
});

test('find_value: 不给值 -> 明确报错, 不静默成功', async () => {
  const db = makeDb({ cols: ID_COLS });
  const out = await callTool(makeBuilder(db), 'find_value', { dbId: 'db1', table: 't' });
  assert.match(String(out.error || out), /value/, '要说清缺什么');
});

test('find_value: 找不到库 -> 明确报错', async () => {
  const db = makeDb({ cols: ID_COLS });
  const out = await callTool(makeBuilder(db), 'find_value', {
    dbId: 'nope', table: 't', value: 'x'
  });
  assert.match(String(out.error || out), /找不到库/, '库不存在要说清');
});

test('find_value 是只读工具 —— 它只发 SELECT', async () => {
  const { READ_ONLY } = require('../lib/engine-ai.js');
  assert.ok(READ_ONLY.has('find_value'), 'find_value 必须算只读, 否则不能和其他只读调用并发');
});

test('工具清单里有 find_value, 而且描述里明确劝退自己写探针', async () => {
  const { TOOLS } = require('../lib/engine-ai.js');
  const t = TOOLS.map((x) => x.function).find((f) => f.name === 'find_value');
  assert.ok(t, 'find_value 要注册进工具清单');
  assert.match(t.description, /不要自己写|不要自己/, '描述里要明确劝退自己写探针 SQL');
  assert.match(t.description, /LIKE|全表扫/, '要说清自己写探针为什么慢');
});

test('提示词里也写了这条规矩 —— 光有工具不够, 模型得知道该用它', () => {
  const sets = require('../packages/solodb-core/prompt-sets.js');
  const all = JSON.stringify(sets);
  assert.match(all, /find_value/, '系统提示词要提到 find_value');
  assert.match(all, /不要自己写探针|不要自己写/, '要明确禁止自己写探针 SQL');
});
