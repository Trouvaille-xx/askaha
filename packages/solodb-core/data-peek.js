'use strict';

/**
 * 「看一眼某列真实存的是什么」这件事的公共底座。
 *
 * 为什么单独抽一个模块: 三个 Agent (搭建 / 分析 / 测试) 各写了一份一模一样的
 * 实现, 而且**三份都跑同一条贵得离谱的 SQL**:
 *
 *   SELECT COUNT(*), COUNT(col), COUNT(DISTINCT col) FROM 表
 *
 * 没有 WHERE, 没有 LIMIT。2026-09-21 在生产库上实测: OMS 的
 * purchase_order_detail 有 1055 万行, 就算那一列有索引、走的是 index-only
 * scan, **单列也要 11.6 秒**; 搭建 Agent 一次最多看 12 列, 于是一次工具调用
 * 能在同一张表上花掉两分钟 —— 真实会话里它连看了 13 次, 25 分钟没收敛,
 * 用户只看到"它一直在想"。
 *
 * 而它想回答的问题 ("哪一列能挂到 PO 上") 列统计**原理上答不出来**,
 * 那是个关联问题, 得靠一条 JOIN 试。所以这里的护栏不只是"快一点":
 * 它同时把结果改写成"这是抽样 / 猜不出关联键就换个办法", 让模型别再一列一列试。
 *
 * 规则只有一条: **表超过 MAX_FULL_SCAN_ROWS 行就不做全表统计, 改抽样**,
 * 并且抽样值必须在结果里标清楚 —— 让模型把前 5 万行的空值率当成全表的,
 * 比不给数字危险得多 (它会据此断定"这列是空的, 不能当关联键")。
 */

/** 超过这个行数就不做全表统计 (元数据估行数, 不是 COUNT(*)) */
const MAX_FULL_SCAN_ROWS = 1000000;
/** 抽样扫多少行。5 万行在 MySQL 上是几十毫秒的量级。 */
const SAMPLE_ROWS = 50000;

/** SQL 字符串字面量。只用于元数据查询, 值全部来自我们自己的表名。 */
function sqlStr(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/**
 * 表大约多少行 —— 查元数据, 毫秒级。
 *
 * 估不出来返回 null, 调用方按"老实全表统计"走: 元数据查不到时宁可贵一点,
 * 也不能因为估不出行数就让工具静默变哑。
 *
 * @param {object} db       已经打开的连接 (有 query)
 * @param {string} dialect  mysql | postgres | mssql | sqlite
 * @param {string} table    表名 (未加引号)
 */
async function estimateRows(db, dialect, table) {
  const t = sqlStr(table);
  // 数值化 + 有限性检查放在一处: 拿不到数字就是"估不出来"(null), 不能是 NaN ——
  // NaN 会让 `est > 阈值` 恒为 false, 于是护栏静默失效, 而调用方还以为它在工作。
  const num = (r) => {
    const row = (r && r.rows && r.rows[0]) || null;
    if (!row) return null;
    const n = Number(row.n);
    return Number.isFinite(n) ? n : null;
  };
  try {
    if (dialect === 'mysql') {
      return num(await db.query(
        'SELECT TABLE_ROWS AS n FROM information_schema.TABLES'
        + ' WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ' + t
      ));
    }
    if (dialect === 'postgres') {
      return num(await db.query('SELECT reltuples::bigint AS n FROM pg_class WHERE relname = ' + t));
    }
    if (dialect === 'mssql') {
      return num(await db.query(
        'SELECT SUM(row_count) AS n FROM sys.dm_db_partition_stats'
        + ' WHERE object_id = OBJECT_ID(' + t + ') AND index_id IN (0, 1)'
      ));
    }
  } catch (e) {
    return null;
  }
  // sqlite: 本地文件, 没有便宜的行数估算; 走老路 (本地 COUNT 可以接受)
  return null;
}

/**
 * 只扫前 N 行的派生表。统计全部挂在它上面算 —— 这样无论表多大都只摸 N 行。
 * SQL Server 没有 LIMIT, 用 TOP。
 */
function sampleSub(dialect, tb, col, n) {
  if (dialect === 'mssql') return `(SELECT TOP ${n} ${col} AS v FROM ${tb}) s`;
  return `(SELECT ${col} AS v FROM ${tb} LIMIT ${n}) s`;
}

/** 三条统计语句。from 是数据来源 (真实表 或 抽样派生表), col 是那一列的名字。 */
function statQueries(dialect, from, col, scopeSql) {
  const top = dialect === 'mssql';
  const and = scopeSql ? ' AND' : ' WHERE';
  return {
    stats: `SELECT COUNT(*) AS total, COUNT(${col}) AS nonnull, COUNT(DISTINCT ${col}) AS uniq FROM ${from}${scopeSql}`,
    distinct: `SELECT DISTINCT ${top ? 'TOP 50 ' : ''}${col} AS v FROM ${from}${scopeSql}`
      + `${and} ${col} IS NOT NULL${top ? '' : ' LIMIT 50'}`,
    topValues: `SELECT ${top ? 'TOP 15 ' : ''}${col} AS v, COUNT(*) AS n FROM ${from}${scopeSql}`
      + `${and} ${col} IS NOT NULL GROUP BY ${col} ORDER BY n DESC${top ? '' : ' LIMIT 15'}`
  };
}

/**
 * 一列的统计。三个 Agent 共用这一份。
 *
 * @param {object} o
 * @param {object} o.db        连接
 * @param {string} o.dialect   mysql | postgres | mssql | sqlite
 * @param {string} o.table     表名 (未加引号, 用于查元数据)
 * @param {string} o.tb        表名 (已按方言加引号)
 * @param {string} o.col       列名 (已按方言加引号)
 * @param {string} [o.where]   调用方自己带的过滤条件 (原样拼进 SQL)。
 *                             带了 where 就不抽样: 那是调用方明确限定的范围,
 *                             报"抽样"会和它自己的口径打架。
 * @returns {{est:number|null, sampled:boolean, total:number, nonnull:number,
 *            uniq:number, pct:number, distinct:string[], topValues:string[]}}
 */
async function peekColumnStats(o) {
  const db = o.db;
  const dialect = o.dialect || 'mysql';
  const where = String(o.where || '').trim();
  const scopeSql = where ? ` WHERE ${where}` : '';
  const est = await estimateRows(db, dialect, o.table);
  const sampled = !where && Number.isFinite(est) && est > MAX_FULL_SCAN_ROWS;

  const from = sampled ? sampleSub(dialect, o.tb, o.col, SAMPLE_ROWS) : o.tb;
  const col = sampled ? 'v' : o.col;
  const Q = statQueries(dialect, from, col, scopeSql);

  const r2 = await db.query(Q.stats);
  const row = (r2.rows || [])[0] || {};
  const total = Number(row.total || 0);
  const nonnull = Number(row.nonnull || 0);
  const uniq = Number(row.uniq || 0);
  const out = {
    est: Number.isFinite(est) ? est : null,
    sampled,
    total,
    nonnull,
    uniq,
    pct: total ? Math.round((1 - nonnull / total) * 1000) / 10 : 0,
    distinct: [],
    topValues: []
  };

  if (uniq > 0 && uniq <= 50) {
    const r3 = await db.query(Q.distinct);
    out.distinct = (r3.rows || []).map((x) => String(x.v));
  } else if (uniq > 50) {
    const r3 = await db.query(Q.topValues);
    out.topValues = (r3.rows || []).map((x) => `${x.v}(${x.n})`);
  }
  return out;
}

/**
 * 统计结果 -> 人话 (给模型看的那几行)。
 *
 * 抽样时**必须**写清"抽样", 并顺带把"换个办法"说出来 —— 大表上想判断
 * 关联键, 列统计答不了, 得试一条 JOIN。
 *
 * @param {object} s      peekColumnStats 的返回值
 * @param {object} [opt]  { head: 前缀 (比如 "列 ack_state:"), table: 表名 (提示里用) }
 * @returns {string[]} 若干行
 */
function formatStats(s, opt = {}) {
  const lines = [];
  if (opt.head) lines.push(opt.head);
  if (s.sampled) {
    lines.push(`⚠ 这张表约 ${s.est} 行 —— 跳过全表统计 (COUNT(DISTINCT) 每列要十几秒, 一次看多列就是几分钟)`);
    lines.push(`前 ${SAMPLE_ROWS} 行抽样: 有值 ${s.nonnull}/${s.total}, 空值占比 ${s.pct}%, 去重 ${s.uniq} 个不同值`);
  } else {
    lines.push(`共 ${s.total} 行, 有值 ${s.nonnull} 行, 空值占比 ${s.pct}%, 去重后 ${s.uniq} 个不同值`);
  }
  if (s.pct >= 90) {
    lines.push(`⚠ ${s.sampled ? '抽样范围内' : '这一列'} ${s.pct}% 是空的 —— 拿它当关联键大概率查不到东西。`);
  }
  if (s.distinct.length) {
    lines.push(`${s.sampled ? '抽样内全部取值' : '全部取值'}: ` + s.distinct.join(', '));
  }
  if (s.topValues.length) {
    lines.push(`${s.sampled ? '抽样内最常见取值' : '最常见取值'}: ` + s.topValues.join(', '));
  }
  if (s.sampled) {
    lines.push('要判断它能不能当关联键: 先看样本里值的形态 (前缀/长度对不对得上), '
      + '再用 check_index 看索引, 或在 SQL 节点里试一条 JOIN 真跑一遍。');
  }
  return lines;
}

module.exports = {
  MAX_FULL_SCAN_ROWS,
  SAMPLE_ROWS,
  sqlStr,
  estimateRows,
  sampleSub,
  statQueries,
  peekColumnStats,
  formatStats
};
