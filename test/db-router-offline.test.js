'use strict';

/**
 * 多库路由的**容错**: 一个库连不上, 不能把整轮任务拖死。
 *
 * 为什么这个要单独测:
 *   用户配了 4 个库, 其中几个走内网域名。没连 VPN 时它们的 DNS 就解析不了。
 *   修复前, inventory() 让连接错误直接抛出去 —— 于是"查另外 2 个库"这种完全
 *   正当的请求也会失败, 而用户看到的是 `getaddrinfo ENOTFOUND xxx` 这种原文。
 *   一个库连不上不该让整个产品不可用。
 *
 * 同时测错误翻译: `getaddrinfo ENOTFOUND` 对业务用户等于没说话,
 * 他不知道这是 DNS、也不知道该怎么办。
 */

const test = require('node:test');
const assert = require('node:assert');

const DbRouter = require('../lib/db-router.js');

/* ---------- 桩 ---------- */

/** 一个假库: 要么正常返回表清单, 要么按 scripted 的错误抛 */
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

function makeRouter(dbs, failFor) {
  return new DbRouter({
    databases: dbs,
    openDb: (conf) => fakeDb(conf, failFor && failFor[conf.id])
  });
}

const dbConf = (id, name, host, tables) => ({
  id, name, type: 'mysql', host, port: 3306, database: 'd', user: 'u', password: 'p',
  tables: tables.map((n) => ({ name: n, checked: true }))
});

const THREE_DBS = () => [
  dbConf('d1', 'OMS_POS', 'oms-01.example.com', ['delivery_order', 'purchase_order']),
  dbConf('d2', 'SRM', 'srm-01.example.com', ['invoice_red_apply']),
  dbConf('d3', 'OPC销售订单库', 'opc.internal', ['order_info', 'sub_order_info'])
];

const dnsErr = () => Object.assign(new Error('getaddrinfo ENOTFOUND oms-01.example.com'), { code: 'ENOTFOUND' });

/* ============================================================
 * 1. 一个库连不上, 其余的照常可用
 * ============================================================ */

test('一个库连不上: 不抛异常, 其余库的表照常核对出来', async () => {
  const r = makeRouter(THREE_DBS(), { d1: dnsErr() });
  const inv = await r.inventory();

  assert.strictEqual(inv.offline.length, 1, '应该记下 1 个离线库');
  assert.strictEqual(inv.offline[0].dbName, 'OMS_POS');

  // 关键: 另外两个库的表必须仍然可用
  const names = inv.resolved.map((t) => t.name).sort();
  assert.deepStrictEqual(names, ['invoice_red_apply', 'order_info', 'sub_order_info']);
});

test('离线库的表仍算"勾过", 但不算"核对过存在"', async () => {
  const r = makeRouter(THREE_DBS(), { d1: dnsErr() });
  const inv = await r.inventory();

  // 用户确实勾了它们 —— 不能因为连不上就说"没勾"
  const checked = inv.checked.map((t) => t.name);
  assert.ok(checked.includes('delivery_order'), '勾过的表要留在 checked 里');

  // 但没核对过存在性, 所以不能进 resolved
  const resolved = inv.resolved.map((t) => t.name);
  assert.strictEqual(resolved.includes('delivery_order'), false,
    '连不上的库没法核对存在性, 不该假装它存在');
});

test('两个库连不上, 第三个仍然可用 (用户的真实情形)', async () => {
  const r = makeRouter(THREE_DBS(), { d1: dnsErr(), d2: new Error('connect ETIMEDOUT') });
  const inv = await r.inventory();
  assert.strictEqual(inv.offline.length, 2);
  assert.deepStrictEqual(inv.resolved.map((t) => t.name).sort(), ['order_info', 'sub_order_info']);
});

test('全部库连不上: 仍然不抛, offline 里全都有', async () => {
  const r = makeRouter(THREE_DBS(), { d1: dnsErr(), d2: dnsErr(), d3: dnsErr() });
  const inv = await r.inventory();
  assert.strictEqual(inv.offline.length, 3);
  assert.strictEqual(inv.resolved.length, 0);
  assert.strictEqual(inv.checked.length, 5, '勾选清单不受连接失败影响');
});

/* ============================================================
 * 2. 错误翻译成人话
 * ============================================================ */

test('DNS 失败 -> 提示可能是没连 VPN, 并带上主机名', async () => {
  const r = makeRouter(THREE_DBS(), { d1: dnsErr() });
  const inv = await r.inventory();
  const reason = inv.offline[0].reason;
  assert.match(reason, /OMS_POS/, '要说清是哪个库');
  assert.match(reason, /oms-01\.example\.com/, '要带上主机名, 用户才知道去查什么');
  assert.match(reason, /VPN|内网/, '要给出可执行的下一步');
  assert.strictEqual(/getaddrinfo/.test(reason), false, '不该把驱动的原文丢给用户');
});

test('各种连接错误都有对应的中文解释', async () => {
  const cases = [
    [Object.assign(new Error('connect ETIMEDOUT 1.2.3.4:3306'), {}), /超时/],
    [Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:3306'), {}), /拒绝连接/],
    [Object.assign(new Error('ER_ACCESS_DENIED_ERROR: Access denied for user'), {}), /账号或密码/],
    [Object.assign(new Error('password authentication failed for user "x"'), {}), /账号或密码/],
    [Object.assign(new Error('ER_BAD_DB_ERROR: Unknown database'), {}), /库名不存在/]
  ];
  for (const [err, re] of cases) {
    const r = makeRouter(THREE_DBS(), { d1: err });
    const inv = await r.inventory();
    assert.match(inv.offline[0].reason, re, `应认得出: ${err.message}`);
  }
});

test('认不出的错误原样返回, 不编一个解释', async () => {
  const weird = new Error('something nobody has seen before');
  const r = makeRouter(THREE_DBS(), { d1: weird });
  const inv = await r.inventory();
  // 编错了比不解释更耽误事
  assert.match(inv.offline[0].reason, /something nobody has seen before/);
});

/* ============================================================
 * 3. 没有离线库时形状不变 (不能为了容错把老行为改了)
 * ============================================================ */

test('全部库正常时: offline 为空数组, 行为跟以前一样', async () => {
  const r = makeRouter(THREE_DBS(), null);
  const inv = await r.inventory();
  assert.deepStrictEqual(inv.offline, []);
  assert.strictEqual(inv.checked.length, 5);
  assert.strictEqual(inv.resolved.length, 5);
});

test('没勾任何表时: 一个库都不连 (免得为了校验白连一次)', async () => {
  const dbs = THREE_DBS();
  for (const d of dbs) d.tables = d.tables.map((t) => ({ ...t, checked: false }));
  let opened = 0;
  const r = new DbRouter({ databases: dbs, openDb: (c) => { opened += 1; return fakeDb(c, null); } });
  const inv = await r.inventory();
  assert.strictEqual(opened, 0, '没勾表就不该建连');
  assert.deepStrictEqual(inv.offline, []);
});
