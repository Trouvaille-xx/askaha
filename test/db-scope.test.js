'use strict';

/**
 * 对话抬头里"这次只分析哪几个库"这条约束。
 *
 * 背景: 通用分析原来只有一个范围概念 —— config 里所有"勾过表"的库合成一份
 * 白名单。用户现在可以在新对话的输入框上方 (对话开始后是抬头) 多选具体的库,
 * 于是多出第二层范围。这里测的就是这一层:
 *
 *   1. 选了就只在选中的库里找表, 没选的库**连都不连** (不是查完再过滤);
 *   2. 不选 = 不限制, 老调用方的行为一点不变;
 *   3. 选中的库连不上时仍然降级, 不把整轮任务拖死 (跟 db-router-offline 一个口径)。
 *
 * 还有一条**结构约定**单独放在最后: 流程卡不走这条路。它由 EngineRunner 执行,
 * 拿的是全量 databases 配置, 根本不经过 DbRouter —— 所以"流程卡不受抬头里选的库
 * 影响"不是靠某个 if 绕开的, 是结构上就成立的。那条测试就是钉住这个结构,
 * 谁哪天把 EngineRunner 接到路由器上, 它会红。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DbRouter = require('../lib/db-router.js');

/* ---------- 桩 ---------- */

function fakeDb(conf, failing) {
  return {
    type: conf.type,
    async listTables() {
      if (failing) throw failing;
      return (conf.tables || []).filter((t) => t && t.checked).map((t) => t.name);
    },
    async query() { return { columns: [], rows: [], rowCount: 0, elapsedMs: 1 }; },
    async close() {}
  };
}

const dbConf = (id, name, tables) => ({
  id, name, type: 'mysql', host: id + '.internal', port: 3306, database: 'd', user: 'u', password: 'p',
  tables: tables.map((n) => ({ name: n, checked: true }))
});

const THREE_DBS = () => [
  dbConf('d1', 'OMS_POS', ['delivery_order', 'purchase_order']),
  dbConf('d2', 'SRM', ['invoice_red_apply']),
  dbConf('d3', 'OPC销售订单库', ['order_info', 'sub_order_info'])
];

const dnsErr = () => Object.assign(new Error('getaddrinfo ENOTFOUND d1.internal'), { code: 'ENOTFOUND' });

/** 建一个路由器, 并记下到底开过哪些连接 —— "连都没连"这件事只能从这里看出来 */
function makeRouter(dbIds, failFor) {
  const opened = [];
  const r = new DbRouter({
    databases: THREE_DBS(),
    openDb: (c) => { opened.push(c.id); return fakeDb(c, failFor && failFor[c.id]); },
    dbIds
  });
  return { r, opened };
}

/* ============================================================
 * 1. 选了库: 只在选中的库里找表
 * ============================================================ */

test('dbIds 只留选中的库: 其它库的表不进白名单', async () => {
  const { r } = makeRouter(['d2']);
  const inv = await r.inventory();
  assert.deepStrictEqual(inv.resolved.map((t) => t.name), ['invoice_red_apply']);
  assert.deepStrictEqual(inv.checked.map((t) => t.name), ['invoice_red_apply']);
});

test('dbIds 选多个: 取并集', async () => {
  const { r } = makeRouter(['d1', 'd3']);
  const inv = await r.inventory();
  assert.deepStrictEqual(inv.resolved.map((t) => t.name).sort(),
    ['delivery_order', 'order_info', 'purchase_order', 'sub_order_info']);
});

test('没被选中的库连都不连 —— 不是查完再过滤', async () => {
  const { r, opened } = makeRouter(['d1']);
  await r.inventory();
  assert.deepStrictEqual(opened, ['d1'], '没选的库不该建立连接');
});

test('dbIds 里混进不存在的 id: 忽略它, 不报错', async () => {
  const { r } = makeRouter(['d2', 'gone']);
  const inv = await r.inventory();
  assert.deepStrictEqual(inv.resolved.map((t) => t.name), ['invoice_red_apply']);
});

test('选中的库一个表都没勾: 白名单为空, 不抛', async () => {
  const dbs = THREE_DBS();
  dbs[0].tables = dbs[0].tables.map((t) => ({ ...t, checked: false }));
  const r = new DbRouter({ databases: dbs, openDb: (c) => fakeDb(c, null), dbIds: ['d1'] });
  const inv = await r.inventory();
  assert.strictEqual(inv.resolved.length, 0);
  assert.deepStrictEqual(inv.offline, []);
});

/* ============================================================
 * 2. 不选: 行为跟以前完全一样 (老调用方不受影响)
 * ============================================================ */

test('不传 dbIds / null / 空数组: 都表示不限制', async () => {
  for (const dbIds of [undefined, null, []]) {
    const { r, opened } = makeRouter(dbIds);
    const inv = await r.inventory();
    assert.strictEqual(inv.resolved.length, 5, 'dbIds=' + JSON.stringify(dbIds) + ' 不该限制范围');
    assert.deepStrictEqual(opened.sort(), ['d1', 'd2', 'd3'], '三个库都该连');
  }
});

/* ============================================================
 * 3. 选中范围里出错仍然降级
 * ============================================================ */

test('选中的库连不上: 仍然降级成 offline, 不抛', async () => {
  const { r } = makeRouter(['d1'], { d1: dnsErr() });
  const inv = await r.inventory();
  assert.strictEqual(inv.offline.length, 1);
  assert.strictEqual(inv.resolved.length, 0);
  assert.strictEqual(inv.checked.length, 2, '勾选清单不受连接失败影响');
});

test('选了两个库、其中一个连不上: 另一个照常可用', async () => {
  const { r } = makeRouter(['d1', 'd3'], { d1: dnsErr() });
  const inv = await r.inventory();
  assert.strictEqual(inv.offline.length, 1);
  assert.deepStrictEqual(inv.resolved.map((t) => t.name).sort(), ['order_info', 'sub_order_info']);
});

/* ============================================================
 * 4. 界面要拿这个来显示"这次的范围是哪些库"
 * ============================================================ */

test('scopeLabel 只报选中的库', async () => {
  const { r } = makeRouter(['d1', 'd2']);
  assert.strictEqual(r.scopeLabel(), 'OMS_POS、SRM');
});

test('scopeLabel 在不限制时报全部', async () => {
  const { r } = makeRouter([]);
  assert.strictEqual(r.scopeLabel(), 'OMS_POS、SRM、OPC销售订单库');
});

/* ============================================================
 * 5. 结构约定: 流程卡不走这条路
 * ============================================================ */

test('结构约定: 流程卡执行器拿全量库配置, 不经过 DbRouter', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agent.js'), 'utf8');
  const at = src.indexOf('async _execEngine(');
  assert.ok(at > 0, '找不到 _execEngine, 测试本身要跟着改');
  const block = src.slice(at);
  const head = block.slice(0, block.indexOf('let res;'));
  assert.ok(head.length > 0, '找不到 EngineRunner 构造那一段');

  assert.match(head, /databases:\s*this\.databases/,
    '流程卡必须拿全量 databases —— 换成 this.database 就会被抬头选的库限制住');
  // this.databases 也以 "this.database" 开头, 所以这里靠 \b 把复数形式排除掉
  assert.strictEqual(/this\.database\b/.test(head), false,
    '流程卡不该用路由器: 用了就会受"这次只分析哪几个库"约束, 而流程卡有自己的表范围');
});
