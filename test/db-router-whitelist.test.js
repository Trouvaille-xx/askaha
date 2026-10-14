'use strict';

/**
 * 「勾选即白名单」是不是真的在拦。
 *
 * 为什么这个要单独测:
 *   用户只勾 5 张表, 然后在 SQL 里写别的表 —— 修复前**照样能查出来**。
 *   根因有两处, 形状一样:
 *     1. `_tablesInSql` 用 `known.includes(name)` 过滤, 只返回勾过的表名。
 *        于是清单外的表根本不进结果, 白名单校验成了"永远通过"。
 *     2. `_route` / `targetFor` 在"认不出表"时兜底返回"只有一个活跃库"。
 *        这个兜底是为**召回**写的 (我认不出这些表, 但只有你一个库, 那大概是你的),
 *        但它和**边界**挤在同一个函数里, 结果边界给召回让了路。
 *
 *   修复 = 把召回和边界拆开: 召回保留宽容兜底, 边界不允许任何回退。
 *
 * 同时必须守住的反向约束 (改错了会把正常功能搞坏):
 *   - CTE 名 (WITH x AS ...) 不是数据库里的表, 不能按白名单拦
 *   - 表名大小写不该导致误拦 (清单存 delivery_order, SQL 写 Delivery_Order)
 *   - `SELECT 1` 这种不引用表的 SQL 仍然要能路由
 */

const test = require('node:test');
const assert = require('node:assert');

const DbRouter = require('../lib/db-router.js');

/* ---------- 桩 ---------- */

/** 假库: query 返回自己属于哪个库, 用来断言路由到了哪里 */
function fakeDb(conf) {
  return {
    type: conf.type,
    async listTables() {
      return (conf.tables || []).filter((t) => t && t.checked).map((t) => t.name);
    },
    async query() {
      return { columns: ['db'], rows: [{ db: conf.name }], rowCount: 1, elapsedMs: 1 };
    },
    async close() {}
  };
}

function makeRouter(dbs) {
  return new DbRouter({ databases: dbs, openDb: (conf) => fakeDb(conf) });
}

const dbConf = (id, name, tables) => ({
  id, name, type: 'mysql', host: 'h', port: 3306, database: 'd', user: 'u', password: 'p',
  tables: tables.map((n) => ({ name: n, checked: true }))
});

/** 一个库, 只勾了 delivery_order / purchase_order */
const ONE_DB = () => [dbConf('d1', 'OMS_POS', ['delivery_order', 'purchase_order'])];

/** 两个库, 各自的表不重名 */
const TWO_DBS = () => [
  dbConf('d1', 'OMS_POS', ['delivery_order', 'purchase_order']),
  dbConf('d2', 'SRM', ['invoice_red_apply'])
];

/** 路由到哪里; 抛错就把错误原文返回, 便于断言 */
async function where(r, sql) {
  try {
    const res = await r.query(sql);
    return res.rows[0].db;
  } catch (e) {
    return 'ERR:' + e.message;
  }
}

/* ============================================================
 * 1. 核心: 清单外的表必须被拦住
 * ============================================================ */

test('单库: 清单外的表必须拒绝, 不能因为"只有一个库"就放行', async () => {
  const out = await where(makeRouter(ONE_DB()), 'SELECT * FROM secret_payroll');
  assert.ok(out.startsWith('ERR:'), `清单外的表被放行了 (路由到 ${out}) —— 白名单没在拦`);
  assert.match(out, /secret_payroll/, '错误里要指出是哪张表');
  assert.match(out, /没勾选/, '错误要说清是"没勾选"');
});

test('多库: 清单外的表同样拒绝', async () => {
  const out = await where(makeRouter(TWO_DBS()), 'SELECT * FROM secret_payroll');
  assert.ok(out.startsWith('ERR:'), `清单外的表被放行了 (路由到 ${out})`);
});

test('清单内的表照常路由 (不能误拦)', async () => {
  const out = await where(makeRouter(ONE_DB()), 'SELECT * FROM delivery_order');
  assert.strictEqual(out, 'OMS_POS');
});

test('大小写不同不该误拦: 清单是 delivery_order, SQL 写 Delivery_Order', async () => {
  const out = await where(makeRouter(ONE_DB()), 'SELECT * FROM Delivery_Order');
  assert.strictEqual(out, 'OMS_POS', '同一张表只是大小写不同, 不该被当成清单外的表');
});

test('库名前缀不该误拦: FROM oms_pos.delivery_order', async () => {
  const out = await where(makeRouter(ONE_DB()), 'SELECT * FROM oms_pos.delivery_order');
  assert.strictEqual(out, 'OMS_POS');
});

/* ============================================================
 * 2. 逗号列表 / 子查询 / JOIN 里的表都要看得见
 * ============================================================ */

test('逗号列表: 第二张表在清单外也要拦', async () => {
  const out = await where(makeRouter(ONE_DB()), 'SELECT * FROM delivery_order, secret_payroll WHERE 1=1');
  assert.ok(out.startsWith('ERR:'), `FROM a, b 里的 b 漏掉了 (路由到 ${out})`);
  assert.match(out, /secret_payroll/);
});

test('逗号列表带别名: FROM delivery_order a, secret_payroll b', async () => {
  const out = await where(makeRouter(ONE_DB()), 'SELECT * FROM delivery_order a, secret_payroll b WHERE a.id = b.id');
  assert.ok(out.startsWith('ERR:'), `带别名的逗号列表漏掉了 (路由到 ${out})`);
  assert.match(out, /secret_payroll/);
});

test('逗号列表全在清单内: 正常路由', async () => {
  const out = await where(makeRouter(ONE_DB()), 'SELECT * FROM delivery_order, purchase_order WHERE 1=1');
  assert.strictEqual(out, 'OMS_POS');
});

test('JOIN 右边的表在清单外也要拦', async () => {
  const out = await where(makeRouter(ONE_DB()), 'SELECT * FROM delivery_order d JOIN secret_payroll p ON d.id = p.id');
  assert.ok(out.startsWith('ERR:'), `JOIN 右边的表漏掉了 (路由到 ${out})`);
  assert.match(out, /secret_payroll/);
});

test('子查询里的清单外表也要拦', async () => {
  const sql = 'SELECT * FROM delivery_order WHERE id IN (SELECT order_id FROM secret_payroll)';
  const out = await where(makeRouter(ONE_DB()), sql);
  assert.ok(out.startsWith('ERR:'), `子查询里的表漏掉了 (路由到 ${out})`);
  assert.match(out, /secret_payroll/);
});

/* ============================================================
 * 3. 反向约束: 别把正常功能改坏
 * ============================================================ */

test('CTE 名不是数据库里的表, 不能按白名单拦', async () => {
  const sql = [
    'WITH monthly AS (SELECT id FROM delivery_order WHERE 1=1),',
    '     ranked AS (SELECT id FROM monthly)',
    'SELECT * FROM ranked'
  ].join(' ');
  const out = await where(makeRouter(ONE_DB()), sql);
  assert.strictEqual(out, 'OMS_POS', `CTE 被误拦了 —— 用户现有带 CTE 的卡片会全部失效 (${out})`);
});

test('CTE 名带列清单: WITH x (a, b) AS (...)', async () => {
  const sql = 'WITH t (order_id, cnt) AS (SELECT id, 1 FROM delivery_order) SELECT * FROM t';
  const out = await where(makeRouter(ONE_DB()), sql);
  assert.strictEqual(out, 'OMS_POS', `带列清单的 CTE 被误拦了 (${out})`);
});

test('没引用任何表 + 单库: 仍然能路由 (这不是白名单的兜底)', async () => {
  const out = await where(makeRouter(ONE_DB()), 'SELECT 1');
  assert.strictEqual(out, 'OMS_POS', 'SELECT 1 这种没有表的查询本来就该能跑');
});

test('没引用任何表 + 多库: 抛错, 不猜', async () => {
  const out = await where(makeRouter(TWO_DBS()), 'SELECT 1');
  assert.ok(out.startsWith('ERR:'), `多库时不该猜 (路由到 ${out})`);
  assert.match(out, /没引用任何表/);
});

test('字符串字面量里的表名不算数 (单引号是值, 不是表)', async () => {
  const sql = "SELECT * FROM delivery_order WHERE note = 'secret_payroll'";
  const out = await where(makeRouter(ONE_DB()), sql);
  assert.strictEqual(out, 'OMS_POS', "单引号里的是值, 不该被当成表名去拦");
});

test('注释里的表名不算数', async () => {
  const sql = 'SELECT * FROM delivery_order -- join secret_payroll 以后再说';
  const out = await where(makeRouter(ONE_DB()), sql);
  assert.strictEqual(out, 'OMS_POS', '注释里提到表名不该被拦');
});

test('反引号包着的表名照常认 (MySQL 习惯写法)', async () => {
  const out = await where(makeRouter(ONE_DB()), 'SELECT * FROM `delivery_order`');
  assert.strictEqual(out, 'OMS_POS');
});

test('反引号包着的清单外表照样拦', async () => {
  const out = await where(makeRouter(ONE_DB()), 'SELECT * FROM `secret_payroll`');
  assert.ok(out.startsWith('ERR:'), `反引号把校验绕过去了 (路由到 ${out})`);
});

/* ============================================================
 * 4. 多库原有行为不能坏
 * ============================================================ */

test('多库: 跨库 JOIN 仍然抛"拆成几条"', async () => {
  const sql = 'SELECT * FROM delivery_order d JOIN invoice_red_apply i ON d.id = i.id';
  const out = await where(makeRouter(TWO_DBS()), sql);
  assert.ok(out.startsWith('ERR:'), `跨库查询应该拒绝 (${out})`);
  assert.match(out, /一次查不完|拆成几条/);
});

test('同名表跨库: 仍然抛"无法确定"', async () => {
  const dbs = [
    dbConf('d1', 'A', ['orders', 'delivery_order']),
    dbConf('d2', 'B', ['orders', 'purchase_order'])
  ];
  const out = await where(makeRouter(dbs), 'SELECT * FROM orders');
  assert.ok(out.startsWith('ERR:'), `同名表应该拒绝 (${out})`);
  assert.match(out, /同名/);
});

/* ============================================================
 * 5. targetFor 的同一个洞
 * ============================================================ */

test('targetFor: 清单外的表必须拒绝 (以前单库会兜底放行)', () => {
  const r = makeRouter(ONE_DB());
  assert.throws(
    () => r.targetFor('secret_payroll'),
    /不在已勾选的清单里/,
    'targetFor 的兜底也是同一个洞: 单库时清单外的表被放行了'
  );
});

test('targetFor: 清单内的表照常返回', () => {
  const r = makeRouter(ONE_DB());
  const t = r.targetFor('delivery_order');
  assert.strictEqual(t.dbName, 'OMS_POS');
  assert.strictEqual(t.dialect, 'mysql');
});

test('targetFor: 大小写不同不该误拦 (表名是模型给的)', () => {
  const r = makeRouter(ONE_DB());
  const t = r.targetFor('Delivery_Order');
  assert.strictEqual(t.dbName, 'OMS_POS');
});

test('targetFor: 同名表跨库要明确报"同名", 不是笼统的"不在清单里"', () => {
  const dbs = [dbConf('d1', 'A', ['orders']), dbConf('d2', 'B', ['orders'])];
  const r = makeRouter(dbs);
  assert.throws(() => r.targetFor('orders'), /同名/);
});

/* ============================================================
 * 6. 错误信息要能指导用户怎么办
 * ============================================================ */

test('拒绝时的错误信息要给出"现在勾了哪些表"和下一步动作', async () => {
  const out = await where(makeRouter(ONE_DB()), 'SELECT * FROM secret_payroll');
  assert.match(out, /delivery_order/, '要列出当前勾了哪些表, 用户才知道该补哪张');
  assert.match(out, /勾上|去勾|「数据库」/, '要告诉用户下一步去哪操作');
});
