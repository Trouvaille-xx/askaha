'use strict';

/**
 * 取数节点的"输入项"是 SQL 里 {{占位符}} 的**镜像**。
 *
 * 起因: write_card 一次写出来的卡, query 节点可以不带 fields, 但运行时引擎照样扫
 * SQL 里的 {{}} 从入口/上游取值 —— 于是界面上"输入"空着, 看着像"没参数怎么查到的"。
 * 这里锁两件事: 空着就按 SQL 补上; 已经声明过的不动。
 */

const test = require('node:test');
const assert = require('node:assert');

const Engine = require('../lib/engine');

function cardWith(sql, fields) {
  return {
    id: 'e', name: 'x', description: 'y',
    nodes: [
      { id: 'n_in', type: 'input', title: '入口', fields: [{ key: 'poNo', label: '单号' }] },
      { id: 'n_q', type: 'query', title: '查', databaseId: 'db', table: 't', sql, outputs: [{ key: 'a' }], ...(fields ? { fields } : {}) },
      { id: 'n_o', type: 'output', title: '结论', template: '{{n_q.a}}' }
    ],
    edges: [{ from: 'n_in', to: 'n_q', port: 'out' }, { from: 'n_q', to: 'n_o', port: 'out' }]
  };
}

test('query 的输入项按 SQL 占位符自动补上 (write_card 出的卡也能显示引用)', () => {
  const e = Engine.normalizeEngine(cardWith('SELECT a FROM t WHERE no={{poNo}} AND x={{n_up.col}}'));
  const q = e.nodes.find((n) => n.id === 'n_q');
  assert.deepStrictEqual(q.fields.map((f) => f.key).sort(), ['n_up.col', 'poNo']);
  assert.ok(q.fields.every((f) => f.key && f.label), '每项都有 key 和 label (界面要显示)');
});

test('已经声明过输入项的不动它 (保留作者写的中文名)', () => {
  const e = Engine.normalizeEngine(cardWith('SELECT a FROM t WHERE no={{poNo}}', [{ key: 'poNo', label: '采购单号', required: true }]));
  const q = e.nodes.find((n) => n.id === 'n_q');
  assert.strictEqual(q.fields.length, 1);
  assert.strictEqual(q.fields[0].label, '采购单号');
});

test('SQL 里没有占位符就不补 (fields 仍为空)', () => {
  const e = Engine.normalizeEngine(cardWith('SELECT 1 AS a'));
  const q = e.nodes.find((n) => n.id === 'n_q');
  assert.deepStrictEqual(q.fields, []);
});

test('幂等: 补过的卡再过一遍不变', () => {
  const once = Engine.normalizeEngine(cardWith('SELECT a FROM t WHERE no={{poNo}}'));
  const twice = Engine.normalizeEngine(once);
  const q = twice.nodes.find((n) => n.id === 'n_q');
  assert.deepStrictEqual(q.fields.map((f) => f.key), ['poNo']);
});
