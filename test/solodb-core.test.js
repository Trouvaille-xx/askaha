'use strict';

/**
 * 核心包的**边界**测试 —— packages/solodb-core。
 *
 * 抽这个包的动因: 确定性内核 (引擎 + 只读策略 + 取数护栏 + 规则文本) 以后会有
 * 不止一个宿主 (现在的 Electron 应用, 以及计划中的 DSH 插件)。边界一旦靠
 * "大家自觉", 就会慢慢烂掉: 有人顺手 require 一个驱动进来, 有人把 Electron 的
 * 东西拖进去, 于是那个包再也装不进别的宿主 —— 而且没有任何症状。
 *
 * 所以这里锁四件事:
 *   1. 零依赖: 核心包里不许 require 外部模块 (只允许相对路径与 Node 内建)
 *   2. 单一实现: lib/ 里那几个转发文件拿到的**就是**核心包里的同一个对象
 *   3. 宿主无关: 给它一个假的连接就能跑完一张卡
 *   4. 闸门在边界上: 包成只读之后, 写操作连卡里都过不去
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..');
const CORE_DIR = path.join(ROOT, 'packages', 'solodb-core');
const Core = require('../packages/solodb-core/index.js');
const Engine = require('../lib/engine.js');

/** 核心包里的所有 js 文件 */
function coreFiles() {
  return fs.readdirSync(CORE_DIR)
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join(CORE_DIR, f));
}

/** 抓出一段代码里所有 require 的目标 */
function requireTargets(text) {
  const out = [];
  const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m = re.exec(text);
  while (m !== null) {
    out.push(m[1]);
    m = re.exec(text);
  }
  return out;
}

function isBuiltin(name) {
  const bare = String(name).replace(/^node:/, '');
  return Module.builtinModules.includes(bare);
}

/* ============================================================
 * 1. 零依赖
 * ============================================================ */

test('核心包零外部依赖: 只允许相对路径与 Node 内建', () => {
  const files = coreFiles();
  assert.ok(files.length >= 5, '核心包应该有 5 个以上文件, 实际 ' + files.length);
  const bad = [];
  for (const f of files) {
    for (const t of requireTargets(fs.readFileSync(f, 'utf8'))) {
      if (t.startsWith('./') || t.startsWith('../') || isBuiltin(t)) continue;
      bad.push(path.basename(f) + ' -> ' + t);
    }
  }
  assert.deepStrictEqual(bad, [],
    '核心包不许依赖外部模块, 否则它装不进第二个宿主:\n  ' + bad.join('\n  '));
});

test('三个被搬走的东西不许再在 lib/ 里留实现 (只能转发)', () => {
  // 判据: 转发文件只有 require 一行 + 注释, 所以长度很小。
  // 留这条是为了防"搬完又在这里改一份" —— 那会变成两份实现各自演化。
  for (const f of ['engine.js', 'data-peek.js', 'prompt.js', 'prompt-sets.js']) {
    const text = fs.readFileSync(path.join(ROOT, 'lib', f), 'utf8');
    const lines = text.split('\n').filter((l) => l.trim() && !l.trim().startsWith('*') && !l.trim().startsWith('/*'));
    assert.ok(lines.length <= 3, 'lib/' + f + ' 应该只剩转发, 实际有 ' + lines.length + ' 行代码');
    assert.match(text, /require\('\.\.\/packages\/solodb-core\//, 'lib/' + f + ' 要指向核心包');
  }
});

test('宿主专属的东西不许进核心包 (驱动 / Electron / 界面)', () => {
  const banned = ['mysql2', 'pg', 'mssql', 'sql.js', 'electron', 'xlsx', 'echarts'];
  for (const f of coreFiles()) {
    const text = fs.readFileSync(f, 'utf8');
    for (const t of requireTargets(text)) {
      assert.strictEqual(banned.includes(t), false,
        path.basename(f) + ' 引入了宿主专属的 ' + t + ' —— 那属于宿主, 不属于内核');
    }
  }
});

/* ============================================================
 * 2. 单一实现: 转发拿到的必须是同一个对象
 * ============================================================ */

test('lib/ 的转发文件与核心包是同一个对象 (不是复制了一份)', () => {
  assert.strictEqual(require('../lib/engine.js'), require('../packages/solodb-core/engine.js'));
  assert.strictEqual(require('../lib/data-peek.js'), require('../packages/solodb-core/data-peek.js'));
  assert.strictEqual(require('../lib/prompt.js'), require('../packages/solodb-core/prompt.js'));
  assert.strictEqual(require('../lib/prompt-sets.js'), require('../packages/solodb-core/prompt-sets.js'));
});

test('只读闸门只有一份: database.js 导出的那个就是核心包里的那个', () => {
  const Database = require('../lib/database.js');
  assert.strictEqual(Database.assertReadOnlySingleStatement, Core.SqlGuard.assertReadOnlySingleStatement);
  assert.strictEqual(Database.sqlSkeleton, Core.SqlGuard.sqlSkeleton);
});

test('入口把四样东西都暴露出来', () => {
  assert.ok(Core.Engine && typeof Core.Engine.EngineRunner === 'function', 'Engine');
  assert.ok(Core.Peek && typeof Core.Peek.peekColumnStats === 'function', 'Peek');
  assert.ok(Core.SqlGuard && typeof Core.SqlGuard.assertReadOnlySingleStatement === 'function', 'SqlGuard');
  assert.ok(Core.Prompt && typeof Core.Prompt.buildSetPrompt === 'function', 'Prompt');
});

/* ============================================================
 * 3. 宿主无关: 给个假连接就能跑完一张卡
 * ============================================================ */

function fakeConn(rows) {
  const queried = [];
  return {
    queried,
    closed: false,
    async query(sql) {
      queried.push(sql);
      return { rows, columns: Object.keys(rows[0] || {}), rowCount: rows.length };
    },
    async close() { this.closed = true; }
  };
}

function cardWith(sql) {
  return Engine.normalizeEngine({
    id: 'eng_core_test', name: '核心包测试卡', description: '',
    nodes: [
      { id: 'n_in', type: 'input', x: 0, y: 0, title: '入口', fields: [{ key: 'poNo', label: 'PO 采购订单号' }] },
      {
        id: 'n_q1', type: 'query', x: 0, y: 100, title: '查明细', databaseId: 'db1', sql,
        outputs: [{ key: 'sku_code', label: 'SKU' }, { key: 'received_status', label: '入库状态' }]
      },
      { id: 'n_out', type: 'output', x: 0, y: 200, title: '结论', template: '查到 {{n_q1.rowCount}} 行明细' }
    ],
    edges: [
      { from: 'n_in', to: 'n_q1', port: 'out' },
      { from: 'n_q1', to: 'n_out', port: 'out' }
    ]
  });
}

const DB_CONF = { id: 'db1', name: 'OMS', type: 'mysql', host: 'h', port: 3306, database: 'd', user: 'u' };

test('核心包能独立跑完一张卡 (数据库能力由宿主注入)', async () => {
  const conn = fakeConn([{ sku_code: 'SKU1', received_status: 2 }, { sku_code: 'SKU2', received_status: 2 }]);
  const readonly = Core.createReadOnlyDb(conn, 'mysql');
  const card = cardWith('SELECT sku_code, received_status FROM purchase_order_detail WHERE po_no = \'{{poNo}}\' LIMIT 100');

  const res = await Engine.testEngine(card, { poNo: 'PO20250328008262' }, [DB_CONF], () => readonly, { sampleRows: 5 });
  assert.strictEqual(res.ok, true, '应该跑通: ' + (res.error || ''));
  const hit = (res.steps || []).find((s) => s.id === 'n_q1');
  assert.ok(hit, '取数节点应该被执行');
  assert.strictEqual((hit.sample || []).length, 2, '拿到两行');
  assert.match(conn.queried[0], /PO20250328008262/, '入口字段要真的渲染进 SQL: ' + conn.queried[0]);
});

test('闸门在边界上: 卡里写了写操作, 连库都到不了', async () => {
  const conn = fakeConn([{ sku_code: 'X', received_status: 1 }]);
  const readonly = Core.createReadOnlyDb(conn, 'mysql');
  // 入口照常给值 —— 要验的是"语句被闸门拦下", 不是"输入没填"
  let res = null;
  let err = null;
  try {
    res = await Engine.testEngine(cardWith('DROP TABLE purchase_order_detail'), { poNo: 'PO1' }, [DB_CONF], () => readonly, {});
  } catch (e) {
    err = e;
  }

  const said = err ? String(err.message) : JSON.stringify(res);
  assert.match(said, /只读|禁止/, '要报出是只读闸门拦的, 实际: ' + said.slice(0, 300));
  assert.ok(err !== null || res.ok === false, '写操作的卡不该算跑通');
  assert.strictEqual(conn.queried.length, 0, '被拦下的语句绝不能真的发到库里');
});

test('取数护栏也能直接用宿主注入的连接', async () => {
  const conn = {
    async query(sql) {
      if (/information_schema\.TABLES/.test(sql)) return { rows: [{ n: 10556391 }] };
      if (/COUNT\(\*\) AS total/.test(sql)) return { rows: [{ total: 50000, nonnull: 49959, uniq: 3 }] };
      if (/SELECT DISTINCT/.test(sql)) return { rows: [{ v: '2' }, { v: '0' }, { v: '1' }] };
      return { rows: [] };
    }
  };
  const readonly = Core.createReadOnlyDb(conn, 'mysql');
  const s = await Core.Peek.peekColumnStats({
    db: readonly, dialect: 'mysql', table: 'purchase_order_detail',
    tb: '`purchase_order_detail`', col: '`received_status`'
  });
  assert.strictEqual(s.sampled, true, '千万行的表必须走抽样');
  assert.deepStrictEqual(s.distinct, ['2', '0', '1']);
});

/* ============================================================
 * 4. createReadOnlyDb 本身
 * ============================================================ */

test('createReadOnlyDb: 放行 SELECT, 拦住写操作与多语句', async () => {
  const conn = fakeConn([{ a: 1 }]);
  const db = Core.createReadOnlyDb(conn, 'mysql');
  const ok = await db.query('SELECT a FROM t');
  assert.deepStrictEqual(ok.rows, [{ a: 1 }]);
  await assert.rejects(() => db.query('DELETE FROM t'), /只读/);
  await assert.rejects(() => db.query('SELECT 1; DROP TABLE t'), /一条语句|只读/);
  assert.strictEqual(conn.queried.length, 1, '被拦下的语句不许落到驱动上');
});

test('createReadOnlyDb: 参数透传、close 透传、方言带在身上', async () => {
  const got = [];
  const conn = { async query(sql, params) { got.push(params); return { rows: [] }; }, async close() { this.done = true; } };
  const db = Core.createReadOnlyDb(conn, 'postgres');
  assert.strictEqual(db.dialect, 'postgres');
  await db.query('SELECT $1', ['x']);
  assert.deepStrictEqual(got, [['x']], '参数要原样透传');
  await db.close();
  assert.strictEqual(conn.done, true, 'close 要透传');
});

test('createReadOnlyDb: 连接对象不像连接 -> 立刻报错, 不静默假成功', () => {
  assert.throws(() => Core.createReadOnlyDb(null, 'mysql'), /query/);
  assert.throws(() => Core.createReadOnlyDb({}, 'mysql'), /query/);
});

test('createReadOnlyDb: sqlite 的 PRAGMA 赋值也要拦 (它会改库)', async () => {
  const conn = fakeConn([]);
  const db = Core.createReadOnlyDb(conn, 'sqlite');
  await assert.rejects(() => db.query('PRAGMA journal_mode = WAL'), /PRAGMA/);
  await db.query('PRAGMA table_info(t)');
});
