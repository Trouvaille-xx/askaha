'use strict';

/**
 * 「看一眼某列存的是什么」的护栏 —— lib/data-peek.js。
 *
 * 起因 (2026-09-21 实测): 三个 Agent 各写了一份同样的实现, 都在跑
 *
 *   SELECT COUNT(*), COUNT(col), COUNT(DISTINCT col) FROM 表
 *
 * 没有 WHERE, 没有 LIMIT。在 OMS 的 purchase_order_detail (1055 万行) 上,
 * 那一列**有索引**、走的是 index-only scan, 单列仍要 11.6 秒;
 * 搭建 Agent 一次最多看 12 列, 于是一次工具调用能在同一张表上花两分钟。
 * 真实会话里它连看了 13 次, 25 分钟没收敛 —— 用户只看到"它一直在想"。
 *
 * 这里锁住三件事:
 *   1. 大表不再做全表统计 (超过 100 万行就改抽样, 只扫前 5 万行)
 *   2. 抽样必须**标明是抽样**, 否则模型会把前 5 万行的空值率当成全表的
 *   3. 估不出行数时不许静默变哑 —— 宁可贵一点, 也要给统计
 */

const test = require('node:test');
const assert = require('node:assert');

const Peek = require('../lib/data-peek.js');

/** 假连接: 记下每一条 SQL, 按模式回答 */
function fakeDb(opts = {}) {
  const queried = [];
  return {
    queried,
    async query(sql) {
      queried.push(sql);
      if (opts.throwOn && opts.throwOn.test(sql)) throw new Error('boom');
      if (opts.answer) {
        const r = opts.answer(sql);
        if (r) return r;
      }
      return { rows: [] };
    }
  };
}

const BIG = 10556391;   // 实测那张表的真实行数
const statsOf = (total, nonnull, uniq) => ({ rows: [{ total, nonnull, uniq }] });

/* ============================================================
 * 1. 行数估算
 * ============================================================ */

test('估行数: MySQL 走 information_schema, 不跑 COUNT(*)', async () => {
  const db = fakeDb({ answer: (sql) => (/information_schema\.TABLES/.test(sql) ? { rows: [{ n: BIG }] } : null) });
  const n = await Peek.estimateRows(db, 'mysql', 'purchase_order_detail');
  assert.strictEqual(n, BIG);
  assert.strictEqual(/COUNT\(/.test(db.queried[0]), false, '估算本身绝不能是 COUNT(*)');
  assert.match(db.queried[0], /TABLE_SCHEMA = DATABASE\(\)/, '要限定在当前库里');
});

test('估行数: postgres / mssql 各查各的元数据', async () => {
  const pg = fakeDb({ answer: () => ({ rows: [{ n: 500 }] }) });
  assert.strictEqual(await Peek.estimateRows(pg, 'postgres', 't'), 500);
  assert.match(pg.queried[0], /pg_class/);

  const ms = fakeDb({ answer: () => ({ rows: [{ n: 700 }] }) });
  assert.strictEqual(await Peek.estimateRows(ms, 'mssql', 't'), 700);
  assert.match(ms.queried[0], /dm_db_partition_stats/);
});

test('估行数: 查不到 / 抛错 / 值不是数字 -> 一律 null (不能是 NaN)', async () => {
  assert.strictEqual(await Peek.estimateRows(fakeDb(), 'mysql', 't'), null, '查不到 -> null');
  assert.strictEqual(await Peek.estimateRows(fakeDb({ throwOn: /./ }), 'mysql', 't'), null, '抛错 -> null');
  // NaN 会让 `est > 阈值` 恒为 false, 护栏静默失效 —— 这条就是钉这个
  const weird = fakeDb({ answer: () => ({ rows: [{ n: 'abc' }] }) });
  assert.strictEqual(await Peek.estimateRows(weird, 'mysql', 't'), null);
  const noRow = fakeDb({ answer: () => ({ rows: [] }) });
  assert.strictEqual(await Peek.estimateRows(noRow, 'mysql', 't'), null);
});

/* ============================================================
 * 2. 大表: 不做全表统计
 * ============================================================ */

test('大表: 统计语句里再也不会出现"对整张表 COUNT(DISTINCT)"', async () => {
  const db = fakeDb({
    answer(sql) {
      if (/information_schema\.TABLES/.test(sql)) return { rows: [{ n: BIG }] };
      if (/COUNT\(\*\) AS total/.test(sql)) return statsOf(50000, 50000, 15234);
      if (/GROUP BY/.test(sql)) return { rows: [{ v: 'PO2025', n: 120 }] };
      return null;
    }
  });
  const s = await Peek.peekColumnStats({
    db, dialect: 'mysql', table: 'purchase_order_detail', tb: '`purchase_order_detail`', col: '`erp_no`'
  });

  assert.strictEqual(s.sampled, true, '一千多万行的表必须走抽样');
  assert.strictEqual(s.est, BIG);
  // 每一条统计 SQL 都必须挂在"只扫前 5 万行"的派生表上。
  // 判据: 出现的每一个表名后面都必须紧跟 LIMIT —— 也就是没有"直接打整张表"的引用。
  const statsSql = db.queried.filter((q) => /COUNT\(/.test(q));
  assert.ok(statsSql.length >= 1);
  for (const q of statsSql) {
    assert.match(q, /LIMIT 50000/, '必须只扫前 5 万行: ' + q);
    assert.strictEqual(/`purchase_order_detail`(?! LIMIT \d+)/.test(q), false,
      '表名后面没跟 LIMIT 就是在扫全表: ' + q);
  }
  // 后面那两条 (取值分布) 也不能漏出去
  for (const q of db.queried.filter((x) => /GROUP BY|DISTINCT/.test(x))) {
    assert.strictEqual(/`purchase_order_detail`(?! LIMIT \d+)/.test(q), false,
      '取值分布也要走抽样: ' + q);
  }
});

test('抽样结果里必须写清"抽样", 并给出换个办法的指引', async () => {
  const db = fakeDb({
    answer(sql) {
      if (/information_schema\.TABLES/.test(sql)) return { rows: [{ n: BIG }] };
      if (/COUNT\(\*\) AS total/.test(sql)) return statsOf(50000, 50000, 800);
      if (/GROUP BY/.test(sql)) return { rows: [{ v: 'PO1', n: 12 }] };
      return null;
    }
  });
  const s = await Peek.peekColumnStats({
    db, dialect: 'mysql', table: 't', tb: '`t`', col: '`c`'
  });
  const lines = Peek.formatStats(s).join('\n');
  assert.match(lines, /抽样/, '必须标明是抽样 —— 不标的话模型会把抽样当成全表结论');
  assert.match(lines, new RegExp(String(BIG)), '要说出这张表多大');
  assert.match(lines, /前 50000 行抽样: 有值 50000\/50000/);
  assert.match(lines, /抽样内最常见取值/, '取值分布也要标抽样');
  assert.match(lines, /JOIN/, '要告诉它: 关联问题得靠一条 JOIN 试, 不是靠列统计');
});

test('小表: 照旧走全表统计, 一个"抽样"字样都不该有', async () => {
  const db = fakeDb({
    answer(sql) {
      if (/information_schema\.TABLES/.test(sql)) return { rows: [{ n: 100 }] };
      if (/COUNT\(\*\) AS total/.test(sql)) return statsOf(100, 98, 2);
      if (/SELECT DISTINCT/.test(sql)) return { rows: [{ v: 'A' }, { v: 'B' }] };
      return null;
    }
  });
  const s = await Peek.peekColumnStats({ db, dialect: 'mysql', table: 't', tb: '`t`', col: '`c`' });
  assert.strictEqual(s.sampled, false, '十万行以下没必要抽样');
  assert.deepStrictEqual(s.distinct, ['A', 'B']);
  const lines = Peek.formatStats(s).join('\n');
  assert.strictEqual(/抽样/.test(lines), false, '小表不该出现抽样字样: ' + lines);
  assert.match(lines, /共 100 行, 有值 98 行, 空值占比 2%, 去重后 2 个不同值/);
});

test('估不出行数: 不许静默变哑 —— 宁可贵也要给统计', async () => {
  const db = fakeDb({
    answer(sql) {
      if (/COUNT\(\*\) AS total/.test(sql)) return statsOf(100, 100, 2);
      return null;   // 元数据查不到
    }
  });
  const s = await Peek.peekColumnStats({ db, dialect: 'sqlite', table: 't', tb: '"t"', col: '"c"' });
  assert.strictEqual(s.est, null);
  assert.strictEqual(s.sampled, false, '估不出来就按老办法全表统计');
  assert.strictEqual(s.total, 100);
});

test('调用方给了 where: 不抽样 (那是它自己限定的口径, 报抽样会打架)', async () => {
  const db = fakeDb({
    answer(sql) {
      if (/information_schema\.TABLES/.test(sql)) return { rows: [{ n: BIG }] };
      if (/COUNT\(\*\) AS total/.test(sql)) return statsOf(12, 12, 3);
      if (/SELECT DISTINCT/.test(sql)) return { rows: [{ v: 'x' }] };
      return null;
    }
  });
  const s = await Peek.peekColumnStats({
    db, dialect: 'mysql', table: 't', tb: '`t`', col: '`c`', where: "no = 'X'"
  });
  assert.strictEqual(s.sampled, false);
  const q = db.queried.find((x) => /COUNT\(\*\) AS total/.test(x));
  assert.match(q, /WHERE no = 'X'/, 'where 要原样带上: ' + q);
});

/* ============================================================
 * 3. 方言 与 结果措辞
 * ============================================================ */

test('SQL Server 没有 LIMIT: 抽样用派生表 TOP, 取前 N 组也用 TOP', async () => {
  const db = fakeDb({
    answer(sql) {
      if (/dm_db_partition_stats/.test(sql)) return { rows: [{ n: BIG }] };
      if (/COUNT\(\*\) AS total/.test(sql)) return statsOf(50000, 40000, 900);
      if (/GROUP BY/.test(sql)) return { rows: [{ v: 'a', n: 1 }] };
      return null;
    }
  });
  const s = await Peek.peekColumnStats({ db, dialect: 'mssql', table: 't', tb: '[t]', col: '[c]' });
  assert.strictEqual(s.sampled, true);
  const statsQ = db.queried.find((x) => /COUNT\(\*\) AS total/.test(x));
  assert.match(statsQ, /\(SELECT TOP 50000 \[c\] AS v FROM \[t\]\) s/, 'mssql 用 TOP: ' + statsQ);
  const groupQ = db.queried.find((x) => /GROUP BY/.test(x));
  assert.match(groupQ, /SELECT TOP 15 /, 'mssql 取前 15 组要用 TOP: ' + groupQ);
  assert.strictEqual(/LIMIT/.test(groupQ), false, 'mssql 上没有 LIMIT: ' + groupQ);
});

test('空值率过高照旧警告, 但抽样时要说清"是抽样范围内"', async () => {
  const db = fakeDb({
    answer(sql) {
      if (/information_schema\.TABLES/.test(sql)) return { rows: [{ n: BIG }] };
      if (/COUNT\(\*\) AS total/.test(sql)) return statsOf(50000, 500, 3);
      if (/SELECT DISTINCT/.test(sql)) return { rows: [{ v: 'a' }] };
      return null;
    }
  });
  const s = await Peek.peekColumnStats({ db, dialect: 'mysql', table: 't', tb: '`t`', col: '`c`' });
  const lines = Peek.formatStats(s).join('\n');
  assert.match(lines, /99% 是空的/);
  assert.match(lines, /抽样范围内 99% 是空的/, '抽样值不能说成"这一列": ' + lines);
  assert.match(lines, /抽样内全部取值/, '值少时列全部取值, 但也要标抽样');
});
