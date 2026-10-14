'use strict';

/**
 * 输出列类型 + 静态核对 (validateEngine 接 schema)。
 *
 * 起因: 试跑太贵。能在**跑之前**静态发现的错 (声明的列根本不存在、数字列跟文本比较)
 * 就该在跑之前报掉。schema 由调用方注入 —— core 包不碰数据库。
 */

const test = require('node:test');
const assert = require('node:assert');

const Engine = require('../lib/engine');

// 造一张单取数节点 + 一个条件的卡; 输出列 / SQL / 条件都可覆盖
function card(opts = {}) {
  const outputs = opts.outputs || [{ key: 'status', label: '状态' }];
  const first = outputs[0] ? outputs[0].key : 'status';
  return {
    id: 'e', name: '测试卡', description: '说明',
    nodes: [
      { id: 'n_in', type: 'input', title: '入口', fields: [{ key: 'orderNo', label: '单号' }] },
      { id: 'n_q', type: 'query', title: '查', databaseId: 'db1', table: opts.table || 't',
        sql: opts.sql || 'SELECT status FROM t WHERE no = {{orderNo}}', outputs },
      { id: 'n_c', type: 'condition', title: '判断',
        expr: opts.expr || { type: 'group', logic: 'and', items: [{ type: 'cmp', left: 'n_q.' + first, op: '==', right: '未入库' }] } },
      { id: 'n_o', type: 'output', title: '结论', template: '{{n_q.' + first + '}}' }
    ],
    edges: [
      { from: 'n_in', to: 'n_q', port: 'out' },
      { from: 'n_q', to: 'n_c', port: 'out' },
      { from: 'n_c', to: 'n_o', port: 'true' },
      { from: 'n_c', to: 'n_o', port: 'false' }
    ]
  };
}

/* ============================================================ */

test('normalizeOutputCol: type 只认白名单, 其它一律清空', () => {
  assert.strictEqual(Engine.normalizeOutputCol({ key: 'a', type: 'number' }).type, 'number');
  assert.strictEqual(Engine.normalizeOutputCol({ key: 'a', type: 'NUMBER' }).type, 'number');
  assert.strictEqual(Engine.normalizeOutputCol({ key: 'a', type: 'weird' }).type, '');
  assert.strictEqual(Engine.normalizeOutputCol({ key: 'a' }).type, '');
});

test('validateEngine(schema): 声明的输出列在表里和 SQL 里都找不到 -> 警告', () => {
  const c = card({ outputs: [{ key: 'ack_state', label: '状态' }] });   // SQL 里是 status, 没有 ack_state
  const r = Engine.validateEngine(c, { schema: { t: { status: { type: 'varchar' } } } });
  assert.ok(r.warnings.some((w) => /ack_state/.test(w) && /不存在/.test(w)), '应报 ack_state 不存在');
});

test('validateEngine(schema): 列确实在表里 -> 不报', () => {
  const c = card({ outputs: [{ key: 'status', label: '状态' }] });
  const r = Engine.validateEngine(c, { schema: { t: { status: { type: 'varchar' } } } });
  assert.ok(!r.warnings.some((w) => /status/.test(w) && /不存在/.test(w)));
});

test('validateEngine(schema): 别名/表达式列 (名字出现在 SQL 里) 不误报', () => {
  const c = card({ sql: 'SELECT COUNT(*) AS total FROM t WHERE no = {{orderNo}}', outputs: [{ key: 'total', label: '总数' }] });
  const r = Engine.validateEngine(c, { schema: { t: { status: { type: 'varchar' } } } });
  assert.ok(!r.warnings.some((w) => /total/.test(w) && /不存在/.test(w)), 'total 是别名, 不该报');
});

test('validateEngine(schema): JOIN 时不做列存在性核对', () => {
  const c = card({ sql: 'SELECT a.x AS ack_state FROM t a JOIN u b ON a.id = b.id WHERE a.no = {{orderNo}}', outputs: [{ key: 'ack_state', label: '状态' }] });
  const r = Engine.validateEngine(c, { schema: { t: { status: { type: 'varchar' } } } });
  assert.ok(!r.warnings.some((w) => /ack_state/.test(w) && /不存在/.test(w)));
});

test('validateEngine(schema): 数字列跟文本比较 -> 警告; 跟数字比 -> 不报', () => {
  const mk = (right) => card({
    outputs: [{ key: 'status', label: '状态' }, { key: 'qty', label: '数量', type: 'number' }],
    expr: { type: 'group', logic: 'and', items: [{ type: 'cmp', left: 'n_q.qty', op: '==', right }] }
  });
  const schema = { t: { status: { type: 'varchar' }, qty: { type: 'int' } } };
  assert.ok(Engine.validateEngine(mk('未入库'), { schema }).warnings.some((w) => /数字列/.test(w)), '文本比较应报');
  assert.ok(!Engine.validateEngine(mk('0'), { schema }).warnings.some((w) => /数字列/.test(w)), '数字比较不该报');
  assert.ok(!Engine.validateEngine(mk('12.5'), { schema }).warnings.some((w) => /数字列/.test(w)), '小数比较不该报');
});

test('validateEngine(schema): 数字列用在 empty/notEmpty 上不报 (那不是在比大小)', () => {
  const c = card({
    outputs: [{ key: 'qty', label: '数量', type: 'number' }],
    expr: { type: 'group', logic: 'and', items: [{ type: 'cmp', left: 'n_q.qty', op: 'notEmpty', right: '' }] }
  });
  const r = Engine.validateEngine(c, { schema: { t: { qty: { type: 'int' } } } });
  assert.ok(!r.warnings.some((w) => /数字列/.test(w)));
});

test('validateEngine(): 不传 schema 时行为不变 (向后兼容)', () => {
  const c = card({ outputs: [{ key: 'ack_state', label: '状态' }] });
  const r = Engine.validateEngine(c);
  assert.ok(!r.warnings.some((w) => /ack_state/.test(w) && /不存在/.test(w)));
});
