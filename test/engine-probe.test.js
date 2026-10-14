'use strict';

/**
 * 探针跑 (probeRows): 给每条取数 SQL 套一层行数上限, 快速验"链路通不通"。
 *
 * 起因: 真跑一次 100~400 秒, 大半花在"看一眼跑得通吗"。探针把结果集卡住,
 * 秒级回答"SQL 跑得通 / 字段对 / 走哪条分支"。但它是**真跑** (只是截断), 不是模拟。
 */

const test = require('node:test');
const assert = require('node:assert');

const Engine = require('../lib/engine');

test('wrapProbe: 按方言套行数上限, 且剥掉结尾分号', () => {
  assert.match(Engine.wrapProbe('SELECT 1 FROM t', 'mysql', 10), /_solodb_probe LIMIT 10$/);
  assert.match(Engine.wrapProbe('SELECT 1 FROM t', 'postgres', 10), /LIMIT 10$/);
  assert.match(Engine.wrapProbe('SELECT 1 FROM t', 'sqlite', 10), /LIMIT 10$/);
  assert.match(Engine.wrapProbe('SELECT 1 FROM t', 'mssql', 10), /^SELECT TOP 10 \*/);
  // 结尾分号要剥掉, 否则套进子查询语法错
  assert.strictEqual(Engine.wrapProbe('SELECT 1 FROM t;', 'mysql', 5).includes('t;'), false);
});

function card() {
  return Engine.normalizeEngine({
    id: 'e', name: '卡', description: 'd',
    nodes: [
      { id: 'n_in', type: 'input', title: '入口', fields: [] },
      { id: 'n_q', type: 'query', title: '查', databaseId: 'db1', table: 't', sql: 'SELECT a FROM t', outputs: [{ key: 'a', label: '甲' }] },
      { id: 'n_o', type: 'output', title: '结论', template: '{{n_q.a}}' }
    ],
    edges: [{ from: 'n_in', to: 'n_q', port: 'out' }, { from: 'n_q', to: 'n_o', port: 'out' }]
  });
}

const DBS = [{ id: 'db1', name: 'x', type: 'mysql' }];
function openFake(seen) {
  return () => ({
    type: 'mysql',
    query: async (sql) => { seen.push(sql); return { rows: [{ a: 1 }], columns: ['a'], rowCount: 1, elapsedMs: 1 }; },
    close: async () => {}
  });
}

test('probeRows: 发给库的是套了行数上限的 SQL, 且 step 标了 probe', async () => {
  const seen = [];
  const r = await Engine.testEngine(card(), {}, DBS, openFake(seen), { probeRows: 5 });
  assert.strictEqual(seen.length, 1, '只跑了一条取数');
  assert.match(seen[0], /_solodb_probe LIMIT 5/, '发给库的应是套壳后的 SQL');
  assert.ok(r.steps.some((s) => s.probe === true), 'step 上标了 probe');
});

test('probeRows: 不传时 SQL 原样发给库', async () => {
  const seen = [];
  await Engine.testEngine(card(), {}, DBS, openFake(seen), {});
  assert.strictEqual(seen[0], 'SELECT a FROM t');
});

test('probeRows: 探针的截断结果不会被全量跑当成"同一句"复用', async () => {
  const seen = [];
  const probe = await Engine.testEngine(card(), {}, DBS, openFake(seen), { probeRows: 5 });
  // 把探针的 queryCache 当 reuse 传给一次全量跑 —— SQL 不同 (套壳 vs 原句), 不该命中
  const full = await Engine.testEngine(card(), {}, DBS, openFake(seen), { reuse: probe.queryCache });
  assert.strictEqual(full.reused.length, 0, '探针的截断结果不该被全量跑复用');
  assert.strictEqual(seen[seen.length - 1], 'SELECT a FROM t', '全量跑发的是原句 (未套壳)');
});
