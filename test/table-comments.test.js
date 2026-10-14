'use strict';

/**
 * 探测数据表时, 把**数据库里维护的表注释**一起带出来。
 *
 * 起因: 选表那一步 (scoreTables) 刻意不读表结构, 判据只有**表名 + 说明**。
 * 而表名通常看不出业务含义 (`t_ord_hdr`、`f_st` 这种), 真正起作用的就是说明。
 * 以前那份说明只能靠用户手工在备注框里抄一遍 —— 而 DBA 早就把中文注释维护在
 * 库里了, 系统完全没用上。抄漏一张, AI 就选错一张, 而且表现出来是
 * "数字看着正常但是错的", 比报错危险得多。
 *
 * 这个文件钉住三件事:
 *   1) 四种方言各自去对的地方取注释 (而且**表集合不能因为加注释而变**)
 *   2) 用户自己写的备注优先, 库注释只做兜底 —— 探测绝不覆盖用户输入
 *   3) 注释真的进到了给模型看的清单里, 也真的算进了"没说明的表"那个风险计数
 */

const test = require('node:test');
const assert = require('node:assert');

const Database = require('../lib/database.js');
const DbRouter = require('../lib/db-router.js');

/** 造一个"已经连上"的 Database, 底层驱动换成假的 */
function fakeDb(conf, driver) {
  const db = new Database(conf);
  db._connected = true;      // 跳过真正的建连
  Object.assign(db, driver);
  return db;
}

/* ============================================================
 * 1. 四种方言各去对的地方取注释
 * ============================================================ */

test('mysql: 从 information_schema.TABLES 取 TABLE_COMMENT, 库名走参数', async () => {
  let seen = null;
  const db = fakeDb({ type: 'mysql', database: 'oms' }, {
    pool: {
      async query(sqlText, params) {
        seen = { sqlText, params };
        return [[
          { name: 'delivery_order', comment: '送货单主表' },
          { name: 'no_comment_tbl', comment: '' }
        ], []];
      }
    }
  });

  const list = await db.listTablesDetailed();
  assert.deepStrictEqual(list, [
    { name: 'delivery_order', comment: '送货单主表' },
    { name: 'no_comment_tbl', comment: '' }
  ], '没注释的表也要在 —— 加注释不能改变表集合');
  assert.match(seen.sqlText, /TABLE_COMMENT/, '必须去取 TABLE_COMMENT');
  assert.deepStrictEqual(seen.params, ['oms'], '库名走占位符参数, 不要拼进 SQL 文本');
});

test('postgres: 用 obj_description 取注释, 且仍然从 information_schema 出发', async () => {
  let sqlText = null;
  const db = fakeDb({ type: 'postgres', database: 'erp' }, {
    conn: {
      async query(t) {
        sqlText = t;
        return { rows: [{ name: 'res_partner', comment: '业务伙伴' }, { name: 'x', comment: null }] };
      }
    }
  });

  const list = await db.listTablesDetailed();
  assert.deepStrictEqual(list, [
    { name: 'res_partner', comment: '业务伙伴' },
    { name: 'x', comment: '' }
  ], 'null 注释要归一成空串, 不能变成 "null" 这四个字母');
  assert.match(sqlText, /obj_description/, 'postgres 的表注释在 pg_description 里');
  assert.match(sqlText, /information_schema\.tables/,
    '必须仍然从 information_schema 出发 —— 直接查 pg_class 会把分区子表/索引一起带进来, 表集合就变了');
});

test('mssql: 从 sys.extended_properties 取 MS_Description, 且是 LEFT JOIN', async () => {
  let sqlText = null;
  const db = fakeDb({ type: 'mssql', database: 'd' }, {
    pool: {
      request() {
        return {
          async query(t) {
            sqlText = t;
            return { recordset: [{ name: 'Orders', comment: '订单' }, { name: 'T2', comment: '' }] };
          }
        };
      }
    }
  });

  const list = await db.listTablesDetailed();
  assert.strictEqual(list.length, 2);
  assert.match(sqlText, /MS_Description/, 'SQL Server 的表注释存在这个扩展属性里');
  assert.match(sqlText, /LEFT JOIN/i,
    '必须是 LEFT JOIN —— 用 INNER JOIN 的话, 没写注释的表会整张消失, 用户会以为库里没有它');
});

test('sqlite: 没有表注释这个概念, 一律空串但表要照常列出来', async () => {
  const db = fakeDb({ type: 'sqlite' }, {
    db: {
      exec() {
        return [{ columns: ['name'], values: [['t1'], ['t2']] }];
      }
    }
  });
  assert.deepStrictEqual(await db.listTablesDetailed(), [
    { name: 't1', comment: '' },
    { name: 't2', comment: '' }
  ]);
});

test('sqlite 空库: 返回空数组, 不炸', async () => {
  const db = fakeDb({ type: 'sqlite' }, { db: { exec() { return []; } } });
  assert.deepStrictEqual(await db.listTablesDetailed(), []);
});

test('注释里的换行与多余空白被压平 (备注框是单行的)', async () => {
  const db = fakeDb({ type: 'mysql', database: 'd' }, {
    pool: {
      async query() {
        return [[{ name: 't', comment: '  第一行\n第二行\t带制表符   ' }], []];
      }
    }
  });
  const list = await db.listTablesDetailed();
  assert.strictEqual(list[0].comment, '第一行 第二行 带制表符');
});

test('纯空白的注释归一成空串 (有的库没注释时回的是几个空格)', async () => {
  const db = fakeDb({ type: 'mysql', database: 'd' }, {
    pool: { async query() { return [[{ name: 't', comment: '   ' }], []]; } }
  });
  const list = await db.listTablesDetailed();
  assert.strictEqual(list[0].comment, '');
});

test('listTables() 老接口仍然只回表名 (调用方不用改)', async () => {
  const db = fakeDb({ type: 'mysql', database: 'd' }, {
    pool: { async query() { return [[{ name: 'a', comment: '甲' }, { name: 'b', comment: '' }], []]; } }
  });
  assert.deepStrictEqual(await db.listTables(), ['a', 'b']);
});

/* ============================================================
 * 2. 多库: 注释带出来, 并标明来自哪个库
 * ============================================================ */

function routerWith(dbs) {
  return new DbRouter({
    databases: dbs,
    openDb: (conf) => fakeDb(conf, {
      pool: {
        async query() {
          return [[{ name: conf.tbl, comment: conf.cmt }], []];
        }
      }
    })
  });
}

test('多库: 每个库的注释都带回来, 并标明 dbId / dbName', async () => {
  const r = routerWith([
    { id: 'd1', name: 'OMS_POS', type: 'mysql', tbl: 'delivery_order', cmt: '送货单主表', tables: [{ name: 'delivery_order', checked: true }] },
    { id: 'd2', name: 'SRM', type: 'mysql', tbl: 'invoice_red_apply', cmt: '红字发票申请', tables: [{ name: 'invoice_red_apply', checked: true }] }
  ]);
  const list = await r.listTablesDetailed();
  assert.deepStrictEqual(list, [
    { name: 'delivery_order', comment: '送货单主表', dbId: 'd1', dbName: 'OMS_POS' },
    { name: 'invoice_red_apply', comment: '红字发票申请', dbId: 'd2', dbName: 'SRM' }
  ]);
});

test('多库: 同名表两边都保留 (探测是给用户勾选的, 悄悄丢一张会让人以为库里没有)', async () => {
  const r = routerWith([
    { id: 'd1', name: 'A库', type: 'mysql', tbl: 'orders', cmt: 'A 的订单', tables: [{ name: 'orders', checked: true }] },
    { id: 'd2', name: 'B库', type: 'mysql', tbl: 'orders', cmt: 'B 的订单', tables: [{ name: 'orders', checked: true }] }
  ]);
  const list = await r.listTablesDetailed();
  assert.strictEqual(list.length, 2, '两张同名表都要在');
  assert.deepStrictEqual(list.map((t) => t.dbName), ['A库', 'B库']);
});

test('多库: listTables() 老接口回表名并集, 去重', async () => {
  const r = routerWith([
    { id: 'd1', name: 'A库', type: 'mysql', tbl: 'orders', cmt: '', tables: [{ name: 'orders', checked: true }] },
    { id: 'd2', name: 'B库', type: 'mysql', tbl: 'orders', cmt: '', tables: [{ name: 'orders', checked: true }] }
  ]);
  assert.deepStrictEqual(await r.listTables(), ['orders']);
});

test('多库: inventory() 把 comment 也传给上层', async () => {
  const r = routerWith([
    // comment 是**探测时存进配置**的那一份 —— inventory() 读的是它, 不是现场查库。
    // 现场那次 listTables() 只用来核对"这张表还在不在" (resolved)。
    { id: 'd1', name: 'OMS_POS', type: 'mysql', tbl: 'delivery_order', cmt: '送货单主表',
      tables: [{ name: 'delivery_order', checked: true, note: '我看的口径', comment: '送货单主表' }] }
  ]);
  const inv = await r.inventory();
  assert.strictEqual(inv.checked.length, 1);
  assert.strictEqual(inv.checked[0].note, '我看的口径', '用户备注照旧传');
  assert.strictEqual(inv.checked[0].comment, '送货单主表', '库注释也要传下去');
});

/* ============================================================
 * 3. 注释真的进到了给模型看的清单里
 * ============================================================ */

function makeAgent(tableInventory) {
  const Agent = require('../lib/agent.js');
  return new Agent({
    llm: { config: { apiKey: 'x', model: 'm' } },
    database: {
      type: 'mysql',
      config: { database: 'd' },
      async listTables() { return tableInventory.map((t) => t.name); },
      async describeTable() { return []; },
      async query() { return { rows: [], fields: [] }; }
    },
    skills: null, mcp: null, prompt: null, general: null,
    engines: [], databases: [], openDb: null,
    tableInventory
  });
}

test('没有备注时, 用库注释当说明', () => {
  const a = makeAgent([{ name: 'delivery_order', note: '', comment: '送货单主表' }]);
  const lines = a._inventoryLines(['delivery_order']);
  assert.match(lines[0], /送货单主表/,
    '库里明明有中文注释, 选表那一步却看不到 —— 这就是以前的问题: ' + lines[0]);
});

test('有备注时, 备注优先 (用户对着业务口径写的更准)', () => {
  const a = makeAgent([{ name: 'delivery_order', note: '只算已签收的', comment: '送货单主表' }]);
  const lines = a._inventoryLines(['delivery_order']);
  assert.match(lines[0], /只算已签收的/);
  assert.strictEqual(/送货单主表/.test(lines[0]), false, '备注在的时候不要两个都塞进去, 会把提示词撑长');
});

test('两者都没有才写"无说明"', () => {
  const a = makeAgent([{ name: 't_x', note: '', comment: '' }]);
  assert.match(a._inventoryLines(['t_x'])[0], /无说明/);
});

test('只有空白的备注不算备注, 要退回到库注释', () => {
  const a = makeAgent([{ name: 't', note: '   ', comment: '库里的说明' }]);
  assert.match(a._inventoryLines(['t'])[0], /库里的说明/);
});

test('scoreTables 真的把库注释写进了发给模型的提示词', async () => {
  const Agent = require('../lib/agent.js');
  let sent = null;
  const a = new Agent({
    llm: {
      config: { apiKey: 'x', model: 'm' },
      async chat(messages) { sent = messages; return '{"scored":[]}'; },
      _extractJSON(raw) { try { return JSON.parse(raw); } catch (e) { return null; } }
    },
    database: {
      type: 'mysql', config: { database: 'd' },
      async listTables() { return ['delivery_order']; },
      async describeTable() { return []; },
      async query() { return { rows: [], fields: [] }; }
    },
    skills: null, mcp: null, prompt: null, general: null,
    engines: [], databases: [], openDb: null,
    tableInventory: [{ name: 'delivery_order', note: '', comment: '送货单主表' }]
  });

  await a.scoreTables('查送货单', ['delivery_order']);
  assert.ok(sent, '应该真的调了一次模型');
  const text = sent[0].content;
  assert.match(text, /送货单主表/, '提示词里必须出现库里的注释: ' + text.slice(0, 400));
  assert.match(text, /来自人工备注或数据库注释/, '也要说清这份说明是哪来的');
});

test('自动选表: 有库注释的表不算"没说明" (风险计数要看这个)', async () => {
  const Agent = require('../lib/agent.js');
  const llm = {
    config: { apiKey: 'x', model: 'm' },
    async chatStep(messages) {
      // 闸门带 system 消息; 选表只有 user 消息 —— 按这个分流才跟真实链路一致
      if ((messages || []).some((m) => m.role === 'system')) {
        return { content: JSON.stringify({ kind: 'analysis' }), toolCalls: [], usage: { input: 10, output: 2 } };
      }
      return { content: await llm.chat(messages), toolCalls: [], usage: { input: 10, output: 2 } };
    },
    async chat() {
      return '{"scored":[{"name":"t_a","score":0.9,"reason":"相关"},{"name":"t_b","score":0.8,"reason":"也相关"}]}';
    },
    _extractJSON(raw) { try { return JSON.parse(raw); } catch (e) { return null; } }
  };
  const a = new Agent({
    llm,
    database: {
      type: 'mysql', config: { database: 'd' },
      async listTables() { return ['t_a', 't_b']; },
      async describeTable() { return [{ field: 'id', type: 'int' }]; },
      async query() { return { rows: [], fields: [] }; }
    },
    skills: null, mcp: null, prompt: null, general: null,
    engines: [], databases: [], openDb: null,
    // t_a 只有库注释 (用户没写备注), t_b 什么都没有
    tableInventory: [
      { name: 't_a', note: '', comment: '订单主表' },
      { name: 't_b', note: '', comment: '' }
    ]
  });

  const auto = await a.autoScope('查订单', ['t_a', 't_b'], () => {});
  assert.ok(auto, '应该挑出结果');
  assert.deepStrictEqual(auto.noNote, ['t_b'],
    't_a 有库注释就不该被算成"没说明" —— 否则界面会一直催用户去补一个已经有的东西');
});

/* ============================================================
 * 4. 字段目录的缓存: 失败的结果绝不许钉在缓存里
 * ============================================================ */

test('schemaDigest: 失败结果只短暂缓存, 到点必须重试 (一次网络抖动不能钉住 10 分钟)', async () => {
  // 这是实测踩出来的: 内网 VPN 断一下, information_schema 查询 ETIMEDOUT,
  // 而旧代码不看成功与否, 一律把 (空的) 结果写进 10 分钟缓存。
  // 后果不是"注释少了一点" —— 是整条新链路 (值探测 + 列注释) 全部失效,
  // 静默退回"只看表名 + 备注"的旧行为, 也就是用户最初投诉的那个行为。
  // 表现成"AI 选表时好时坏", 最难排查。
  //
  // 但也不能完全不缓存: 库挂着的时候用户每问一句都要先干等 10 秒连接超时。
  // 所以失败只记 DIGEST_FAIL_TTL_MS (1 分钟)。
  Database.clearDigestCache();
  let calls = 0;
  const db = fakeDb({ type: 'mysql', database: 'cache_fail_db', host: 'h', port: 3306 }, {
    pool: {
      async query() {
        calls += 1;
        throw Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
      }
    }
  });

  const d1 = await db.schemaDigest();
  assert.strictEqual(d1.size, 0, '拿不到就是空的, 上层据此降级');
  assert.match(db.lastDigestError, /ETIMEDOUT/, '原因要留下来, 否则用户只看到"降级"不知道为什么');
  assert.strictEqual(calls, 1);

  // 紧接着再问一次: 走失败缓存, 不再干等一次连接超时
  const d2 = await db.schemaDigest();
  assert.strictEqual(d2.size, 0);
  assert.strictEqual(calls, 1, '一分钟内的连续追问不该反复等连接超时');

  // 时间快进到失败缓存过期之后: 必须重新去连 —— 网络恢复了要能自己好起来
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 61 * 1000;
    const d3 = await db.schemaDigest();
    assert.strictEqual(d3.size, 0);
    assert.strictEqual(calls, 2, '过了失败缓存期必须重试');
  } finally {
    Date.now = realNow;
  }
});

test('schemaDigest: 成功的结果照旧缓存 (10 分钟内不重复打库)', async () => {
  Database.clearDigestCache();
  let calls = 0;
  const db = fakeDb({ type: 'mysql', database: 'cache_ok_db', host: 'h', port: 3306 }, {
    pool: {
      async query(sqlText) {
        calls += 1;
        if (/TABLE_COMMENT/.test(sqlText)) {
          return [[{ name: 'delivery_order', comment: '送货单主表', rows_est: 12 }], []];
        }
        return [[{ t: 'delivery_order', c: 'id', ty: 'bigint', cm: '主键', k: 'PRI' }], []];
      }
    }
  });

  const d1 = await db.schemaDigest();
  assert.strictEqual(d1.size, 1);
  assert.strictEqual(d1.get('delivery_order').comment, '送货单主表');
  assert.deepStrictEqual(d1.get('delivery_order').cols.map((c) => c.field), ['id']);
  const before = calls;
  const d2 = await db.schemaDigest();
  assert.strictEqual(calls, before, '第二次应该直接命中缓存, 不再打库');
  assert.strictEqual(d2.size, 1);
});
