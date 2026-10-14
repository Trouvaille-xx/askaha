/**
 * 统一数据库访问层
 * 支持: mysql, postgresql, sqlite, mssql
 */

const mysql = require('mysql2/promise');
const { Pool } = require('pg');
const sql = require('mssql');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

// 只读闸门 (SQL 策略) 住在 packages/solodb-core: 它与驱动无关, 是纯函数,
// 而且别的宿主 (将来的 DSH 插件) 要用**同一份**。这里只是取来用。
const {
  sqlSkeleton,
  usesBackslashEscapes,
  assertReadOnlySingleStatement
} = require('../packages/solodb-core/sql-guard.js');

/**
 * 把库里取出来的表注释洗一下。
 *
 * 两件事:
 *   1) 把换行/连续空白压成单个空格 —— 备注框是单行 textarea, 库里带换行的注释
 *      会把卡片撑成两行, 看着像界面坏了。
 *   2) null / undefined / 纯空白统一成空串。有的库没注释时回的是几个空格,
 *      原样带上来在界面上看着"有注释", 其实是空的。
 */
function cleanComment(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/\s+/g, ' ').trim();
}

/**
 * 全库字段目录的缓存。
 *
 * 为什么放模块级而不是实例级: 每个任务都会新建一个 DbRouter -> 新的 Database 实例
 * (见 main.js 的 agent:run), 实例级缓存等于没有缓存 —— 每次都重新拉一遍 135 张表
 * 的列注释。放模块级才真的省下这次往返。TTL 10 分钟: 表结构不会秒变, 而万一是
 * 刚加的列, 十分钟后也能自己好。
 *
 * 键是连接身份 (类型/主机/端口/库名), 不含口令 —— 缓存里本来也没有敏感内容。
 */
const DIGEST_CACHE = new Map();
const DIGEST_TTL_MS = 10 * 60 * 1000;
// 失败结果只记很短一会儿。两个极端都要躲开:
//   - 记太久 (以前是 10 分钟): 一次网络抖动就让整条链路静默退回旧行为, 用户只看到"时好时坏"
//   - 完全不记: 库挂着的时候, 用户每问一句都要先干等 10 秒连接超时
// 1 分钟是折中: 连续追问不会反复等, 网络恢复后最多 1 分钟自己好起来。
const DIGEST_FAIL_TTL_MS = 60 * 1000;

/** 测试用: 清掉摘要缓存, 免得用例之间互相污染 */
function clearDigestCache() {
  DIGEST_CACHE.clear();
}

class Database {
  constructor(config) {
    this.config = config;
    this.type = config.type;
    this.pool = null;
    this.conn = null;
    this.db = null; // sqlite (sql.js)
    this._sqlJs = null;
    this._connected = false; // 连接是否已建立
    this._connecting = null; // 进行中的建连 Promise, 用于并发去重
  }

  /**
   * 建立连接。同一个实例只建一次。
   *
   * 读表结构 / 执行查询都走这里, 若每次都重建:
   *   - SQLite 会反复读盘 + 重新解析整个库文件
   *   - MySQL / MSSQL 会每次新建连接, 而旧连接失去引用、永不回收
   */
  async _connect() {
    if (this._connected) return;
    if (this._connecting) return this._connecting;
    this._connecting = this._openConnection();
    try {
      await this._connecting;
      this._connected = true;
    } finally {
      this._connecting = null;
    }
  }

  async _openConnection() {
    if (this.type === 'mysql') {
      this.pool = await mysql.createConnection({
        host: this.config.host,
        port: this.config.port || 3306,
        user: this.config.user,
        password: this.config.password,
        database: this.config.database,
        connectTimeout: 10000
      });
    } else if (this.type === 'postgres') {
      this.pool = new Pool({
        host: this.config.host,
        port: this.config.port || 5432,
        user: this.config.user,
        password: this.config.password,
        database: this.config.database,
        connectionTimeoutMillis: 10000
      });
      this.conn = await this.pool.connect();
    } else if (this.type === 'sqlite') {
      this._sqlJs = await initSqlJs();
      if (this.config.database && fs.existsSync(this.config.database)) {
        const buf = fs.readFileSync(this.config.database);
        this.db = new this._sqlJs.Database(buf);
      } else {
        this.db = new this._sqlJs.Database();
      }
    } else if (this.type === 'mssql') {
      this.pool = await sql.connect({
        server: this.config.host,
        port: this.config.port || 1433,
        user: this.config.user,
        password: this.config.password,
        database: this.config.database,
        options: { encrypt: false, trustServerCertificate: true },
        connectionTimeout: 10000,
        requestTimeout: 15000
      });
    } else {
      throw new Error('不支持的数据库类型: ' + this.type);
    }
    await this._enforceReadOnlySession();
  }

  /**
   * 让数据库自己再拦一道写操作。
   *
   * 静态校验 (assertReadOnlySingleStatement) 是**文本**层面的判断, 只要字面量解析
   * 有一处读错, 就可能漏掉一条真会执行的写语句。这里在会话级把事务设成只读,
   * 让数据库在**执行**层面直接拒绝写 —— 两道闸门互相独立, 一起失效的概率低得多。
   *
   * 失败只记一条警告, 不阻断建连: 有些网关 / 只读代理不认这条 SET, 而静态校验
   * 仍然生效, 不该因为加固措施本身导致连不上库。
   */
  async _enforceReadOnlySession() {
    const stmt = {
      mysql: 'SET SESSION TRANSACTION READ ONLY',
      postgres: 'SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY'
    }[this.type];
    if (!stmt) return; // sqlite 是内存副本不回写; mssql 没有等价的会话级开关
    try {
      if (this.type === 'mysql') await this.pool.query(stmt);
      else await this.conn.query(stmt);
      this.readOnlySession = true;
    } catch (e) {
      this.readOnlySession = false;
      console.warn(`[db] ${this.type} 会话只读设置未生效 (静态校验仍然生效): ${e.message}`);
    }
  }

  async test() {
    await this._connect();
    const result = { type: this.type, version: '', database: this.config.database };
    if (this.type === 'mysql') {
      const [rows] = await this.pool.query('SELECT VERSION() AS v');
      result.version = rows[0].v;
    } else if (this.type === 'postgres') {
      const r = await this.conn.query('SELECT version()');
      result.version = r.rows[0].version;
    } else if (this.type === 'sqlite') {
      const r = this.db.exec('SELECT sqlite_version() AS v');
      result.version = r[0]?.values?.[0]?.[0] || '';
    } else if (this.type === 'mssql') {
      const r = await this.pool.request().query('SELECT @@VERSION AS v');
      result.version = r.recordset[0].v;
    }
    return result;
  }

  /**
   * 探测表清单, **连库里维护的表注释一起取出来**。
   *
   * 为什么要带注释: 选表那一步 (scoreTables) 只拿到表名和备注, 刻意不读表结构
   * (见 lib/agent.js 里的说明)。而表名通常看不出业务含义 —— `t_ord_hdr`、`f_st`
   * 这种, 真正起作用的就是注释。DBA 在库里维护的那份注释是最权威的, 以前完全
   * 没用上, 用户得手工再抄一遍到备注里, 抄漏一张 AI 就选错一张。
   *
   * 四种方言取注释的位置各不相同:
   *   mysql    information_schema.TABLES.TABLE_COMMENT
   *   postgres obj_description(oid, 'pg_class')
   *   mssql    sys.extended_properties 里 name='MS_Description' 的扩展属性
   *   sqlite   没有表注释这个概念, 一律空串
   *
   * 返回 [{ name, comment }]。**表集合与以前完全一致** —— 注释都是 LEFT JOIN /
   * 可选列取出来的, 不会因为某张表没注释就少一张表。
   */
  async listTablesDetailed() {
    await this._connect();
    if (this.type === 'mysql') {
      const [rows] = await this.pool.query(
        `SELECT TABLE_NAME AS name, COALESCE(TABLE_COMMENT, '') AS comment
           FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = ?
          ORDER BY TABLE_NAME`,
        [this.config.database]
      );
      return rows.map((r) => ({ name: r.name, comment: cleanComment(r.comment) }));
    }
    if (this.type === 'postgres') {
      // 从 information_schema 出发再挂 pg_class, 而不是直接查 pg_class ——
      // 直接查会把分区子表、索引、序列一起带进来, 表集合就跟以前不一样了。
      const r = await this.conn.query(
        `SELECT t.table_name AS name,
                COALESCE(obj_description(c.oid, 'pg_class'), '') AS comment
           FROM information_schema.tables t
           JOIN pg_namespace n ON n.nspname = t.table_schema
           JOIN pg_class c ON c.relname = t.table_name AND c.relnamespace = n.oid
          WHERE t.table_schema = 'public'
          ORDER BY t.table_name`
      );
      return r.rows.map((row) => ({ name: row.name, comment: cleanComment(row.comment) }));
    }
    if (this.type === 'sqlite') {
      const r = this.db.exec(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      );
      if (!r.length) return [];
      const idx = r[0].columns.indexOf('name');
      // sqlite 没有表注释: 一律空串, 界面上让用户自己写
      return r[0].values.map((row) => ({ name: row[idx], comment: '' }));
    }
    if (this.type === 'mssql') {
      const r = await this.pool.request().query(
        `SELECT t.TABLE_NAME AS name,
                COALESCE(CAST(ep.value AS NVARCHAR(MAX)), '') AS comment
           FROM INFORMATION_SCHEMA.TABLES t
           LEFT JOIN sys.extended_properties ep
                  ON ep.class = 1
                 AND ep.major_id = OBJECT_ID(t.TABLE_SCHEMA + '.' + t.TABLE_NAME)
                 AND ep.minor_id = 0
                 AND ep.name = 'MS_Description'
          WHERE t.TABLE_TYPE = 'BASE TABLE'
          ORDER BY t.TABLE_NAME`
      );
      return r.recordset.map((row) => ({ name: row.name, comment: cleanComment(row.comment) }));
    }
    return [];
  }

  async listTables() {
    return (await this.listTablesDetailed()).map((t) => t.name);
  }

  /**
   * 一张表的字段。**带上列注释。**
   *
   * 为什么必须带: 选表与写 SQL 这两步真正分不清的, 往往不是"哪张表", 而是
   * "这一列装的是不是那个单号"。DSC 那种库里 `doc_num` 旁边就写着"付款单号"、
   * `select_id` 写着"选票批次 ID, 外键 → payment_select_bill.id" —— 这是全库
   * 最权威、最省事的一份口径。以前这里走 `DESCRIBE`, 它**不带** Comment 列,
   * 于是模型在上下文里只看到 `doc_num:varchar(32)`, 只能靠名字猜, 猜错不报错。
   *
   * 各方言取注释的位置:
   *   mysql    SHOW FULL COLUMNS 的 Comment (DESCRIBE 没有这一列)
   *   postgres pg_description (按 pg_statio_all_tables 的 relid + 列序号)
   *   mssql    sys.extended_properties 里 name='MS_Description'
   *   sqlite   没有列注释这个概念, 一律空串
   */
  async describeTable(table) {
    await this._connect();
    if (this.type === 'mysql') {
      // SHOW FULL COLUMNS 与 DESCRIBE 是同一份元数据, 只是多回 Comment 一列 —— 不额外多一次往返
      const [rows] = await this.pool.query('SHOW FULL COLUMNS FROM ??', [table]);
      return rows.map((r) => ({
        field: r.Field, type: r.Type, null: r.Null, key: r.Key, default: r.Default,
        comment: cleanComment(r.Comment)
      }));
    } else if (this.type === 'postgres') {
      const r = await this.conn.query(
        `SELECT c.column_name AS field, c.data_type AS type, c.is_nullable AS nullable,
                c.column_default AS "default", COALESCE(d.description, '') AS comment
           FROM information_schema.columns c
           LEFT JOIN pg_catalog.pg_statio_all_tables st
                  ON st.schemaname = c.table_schema AND st.relname = c.table_name
           LEFT JOIN pg_catalog.pg_description d
                  ON d.objoid = st.relid AND d.objsubid = c.ordinal_position
          WHERE c.table_name = $1 ORDER BY c.ordinal_position`,
        [table]
      );
      return r.rows.map((row) => ({
        field: row.field,
        type: row.type,
        nullable: row.nullable,
        default: row.default,
        comment: cleanComment(row.comment)
      }));
    } else if (this.type === 'sqlite') {
      const r = this.db.exec(`PRAGMA table_info("${String(table).replace(/"/g, '""')}")`);
      if (!r.length) return [];
      const rows = r[0].values.map(([cid, name, type, notnull, dflt, pk]) => ({
        field: name,
        type,
        notnull: !!notnull,
        default: dflt,
        pk: !!pk,
        // sqlite 没有列注释, 但字段要照常带 comment 键 —— 形状统一, 上层不用分方言
        comment: ''
      }));
      return rows;
    } else if (this.type === 'mssql') {
      const r = await this.pool
        .request()
        .input('t', sql.NVarChar, table)
        .query(
          `SELECT c.name AS field, ty.name AS type, c.is_nullable AS nullable, c.default_object_id AS def,
                  COALESCE(CAST(ep.value AS NVARCHAR(MAX)), '') AS comment
             FROM sys.columns c
             JOIN sys.types ty ON ty.user_type_id = c.user_type_id
             LEFT JOIN sys.extended_properties ep
                    ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description'
            WHERE c.object_id = OBJECT_ID(@t) ORDER BY c.column_id`
        );
      return r.recordset.map((row) => ({
        field: row.field, type: row.type, nullable: row.nullable, default: row.def,
        comment: cleanComment(row.comment)
      }));
    }
    return [];
  }

  /**
   * 全库"字段目录": 表注释 + 行数估算 + 每列的名字/类型/注释/是否带索引。
   *
   * 为什么要有它 (而不是逐张表 describeTable):
   *   选表那一步要在**动模型之前**拿到列信息。逐张表查 = N 次往返 (DSC 是 135 张),
   *   还没开始匹配就先慢下来了。这里两条 SQL 拿全库, 之后全在内存里做 ——
   *   这是"加信息但不加时间"的关键。
   *
   * 行数估算与索引标记是给**值探测**用的: 大表上没索引的列做等值查找 = 全表扫,
   *   几百万行的表能扫几十秒。有了这两个标记, 探测就能只挑"查得动"的列。
   *
   * 结果按连接身份缓存 10 分钟 (表结构不会秒变), 避免同一会话里反复拉。
   * sqlite 返回空 Map —— 它的元数据拿不到索引/注释, 与其编一个, 不如让上层
   * 退化回"只看表名 + 备注"的旧行为 (见 lib/table-match.js 的降级分支)。
   */
  async schemaDigest() {
    const key = `${this.type}|${this.config.host || this.config.file || ''}|${this.config.port || ''}|${this.config.database || ''}`;
    const hit = DIGEST_CACHE.get(key);
    if (hit && Date.now() - hit.at < (hit.ttl || DIGEST_TTL_MS)) return hit.value;

    const out = new Map();
    const put = (table, patch) => {
      if (!table) return;
      const cur = out.get(table) || { table, comment: '', rows: null, cols: [] };
      out.set(table, Object.assign(cur, patch));
    };

    // 这一轮到底成功了没有。**失败结果绝对不能进缓存** —— 见下面 set 那行的说明。
    let ok = false;
    try {
      await this._connect();
      if (this.type === 'mysql') {
        const [tbls] = await this.pool.query(
          `SELECT TABLE_NAME AS name, COALESCE(TABLE_COMMENT,'') AS comment, TABLE_ROWS AS rows_est
             FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`, [this.config.database]);
        for (const t of tbls) put(t.name, { comment: cleanComment(t.comment), rows: Number(t.rows_est) || 0 });
        const [cols] = await this.pool.query(
          `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLUMN_TYPE AS ty, COALESCE(COLUMN_COMMENT,'') AS cm, COLUMN_KEY AS k
             FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?
            ORDER BY TABLE_NAME, ORDINAL_POSITION`, [this.config.database]);
        const byTable = new Map();
        for (const c of cols) {
          if (!byTable.has(c.t)) byTable.set(c.t, []);
          byTable.get(c.t).push({ field: c.c, type: c.ty, comment: cleanComment(c.cm), indexed: !!c.k });
        }
        for (const [t, list] of byTable) put(t, { cols: list });
      } else if (this.type === 'postgres') {
        const t = await this.conn.query(
          `SELECT c.relname AS name, COALESCE(obj_description(c.oid,'pg_class'),'') AS comment,
                  GREATEST(c.reltuples, 0)::bigint AS rows_est
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind = 'r' AND n.nspname = 'public'`);
        for (const r of t.rows) put(r.name, { comment: cleanComment(r.comment), rows: Number(r.rows_est) || 0 });
        const c = await this.conn.query(
          `SELECT c.table_name AS t, c.column_name AS "c", c.data_type AS ty,
                  COALESCE(d.description,'') AS cm,
                  (EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = st.relid AND c.ordinal_position = ANY(i.indkey))) AS indexed
             FROM information_schema.columns c
             LEFT JOIN pg_catalog.pg_statio_all_tables st
                    ON st.schemaname = c.table_schema AND st.relname = c.table_name
             LEFT JOIN pg_catalog.pg_description d
                    ON d.objoid = st.relid AND d.objsubid = c.ordinal_position
            WHERE c.table_schema = 'public' ORDER BY c.table_name, c.ordinal_position`);
        const byTable = new Map();
        for (const r of c.rows) {
          if (!byTable.has(r.t)) byTable.set(r.t, []);
          byTable.get(r.t).push({ field: r.c, type: r.ty, comment: cleanComment(r.cm), indexed: !!r.indexed });
        }
        for (const [name, list] of byTable) put(name, { cols: list });
      } else if (this.type === 'mssql') {
        const t = await this.pool.request().query(
          `SELECT t.name AS name, COALESCE(CAST(ep.value AS NVARCHAR(MAX)),'') AS comment,
                  ISNULL(SUM(p.rows), 0) AS rows_est
             FROM sys.tables t
             LEFT JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0,1)
             LEFT JOIN sys.extended_properties ep ON ep.major_id = t.object_id AND ep.minor_id = 0 AND ep.name='MS_Description'
            GROUP BY t.name, CAST(ep.value AS NVARCHAR(MAX))`);
        for (const r of t.recordset) put(r.name, { comment: cleanComment(r.comment), rows: Number(r.rows_est) || 0 });
        const c = await this.pool.request().query(
          `SELECT o.name AS t, c.name AS c, ty.name AS ty, COALESCE(CAST(ep.value AS NVARCHAR(MAX)),'') AS cm,
                  CASE WHEN ix.index_id IS NULL THEN 0 ELSE 1 END AS indexed
             FROM sys.columns c
             JOIN sys.objects o ON o.object_id = c.object_id AND o.type = 'U'
             JOIN sys.types ty ON ty.user_type_id = c.user_type_id
             LEFT JOIN sys.extended_properties ep ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name='MS_Description'
             LEFT JOIN (SELECT DISTINCT object_id, column_id, index_id FROM sys.index_columns) ix
                    ON ix.object_id = c.object_id AND ix.column_id = c.column_id
            ORDER BY o.name, c.column_id`);
        const byTable = new Map();
        for (const r of c.recordset) {
          if (!byTable.has(r.t)) byTable.set(r.t, []);
          byTable.get(r.t).push({ field: r.c, type: r.ty, comment: cleanComment(r.cm), indexed: !!r.indexed });
        }
        for (const [name, list] of byTable) put(name, { cols: list });
      }
      ok = true;
    } catch (e) {
      // 拿不到就返回已经拿到的部分 —— 选表不能因为"注释查不到"整个失败。
      // 但**原因要留下来**: 上层 (table-match) 会把它写进 degraded 显示给用户,
      // 否则用户只看到"退回只看表名", 不知道是网络断了还是库不支持。
      this.lastDigestError = (e && (e.code ? e.code + ' ' : '') + (e.message || String(e))) || '未知错误';
    }

    // 成功的结果缓存 10 分钟 (表结构不会秒变)。
    //
    // 失败的结果只缓存 DIGEST_FAIL_TTL_MS (1 分钟), 而且要记清原因。
    // 以前这里不看成败一律记 10 分钟 —— 一次瞬时失败 (实测 connect ETIMEDOUT) 就把空目录
    // 钉住 10 分钟, 整条链路静默退回"只看表名 + 备注"的旧行为: 值探测不做、列注释不带、
    // 提示词从 13k 掉到 6k。表现成"AI 选表时好时坏", 正是用户最初投诉的那个行为。
    // 完全不记也不行: 库挂着时用户每问一句都要先干等 10 秒连接超时。
    DIGEST_CACHE.set(key, { at: Date.now(), value: out, ttl: ok ? DIGEST_TTL_MS : DIGEST_FAIL_TTL_MS });
    return out;
  }

  /**
   * 执行 SQL（只允许单条只读语句，避免误操作）
   * 返回: { columns, rows, rowCount, elapsedMs }
   *
   * 注意: 列名一律从驱动元数据里取, **不能靠 rows[0] 反推**。
   * 空结果集 (取数没命中任何行) 时 rows 是空的, 反推就只能得到 [], 界面上
   * 会显示成"这张表一条数据都没有" —— 而实际上只是这一条 SQL 没查出东西。
   * 流程引擎的"同步输出列"更是完全依赖空结果也能拿到列名。
   */
  async query(sqlText, opts = {}) {
    const t0 = Date.now();
    await this._connect();
    const trimmed = (sqlText || '').trim();
    assertReadOnlySingleStatement(trimmed, this.type);
    if (this.type === 'mysql') {
      // timeoutMs 只给"值探测"这类**可以放弃**的查询用 (见 lib/table-match.js):
      // 大表上没索引的列可能扫几十秒, 而选表这一步的预算是秒级。
      // 用户自己确认过的 SQL 一律不带超时 —— 那条必须查完。
      const q = opts.timeoutMs ? { sql: trimmed, timeout: opts.timeoutMs } : trimmed;
      const [rows, fields] = await this.pool.query(q);
      const elapsedMs = Date.now() - t0;
      const columns = fields ? fields.map((f) => f.name) : Object.keys(rows[0] || {});
      return { columns, rows, rowCount: rows.length, elapsedMs };
    } else if (this.type === 'postgres') {
      const r = await this.conn.query(trimmed);
      const elapsedMs = Date.now() - t0;
      const columns = r.fields ? r.fields.map((f) => f.name) : [];
      return { columns, rows: r.rows, rowCount: r.rowCount || r.rows.length, elapsedMs };
    } else if (this.type === 'sqlite') {
      // sql.js 的 exec() 在零行时返回空数组, 拿不到列名; prepare 能从语句本身读出列名
      try {
        const stmt = this.db.prepare(trimmed);
        const columns = stmt.getColumnNames();
        const rows = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        stmt.free();
        return { columns, rows, rowCount: rows.length, elapsedMs: Date.now() - t0 };
      } catch (e) {
        const r = this.db.exec(trimmed);
        const elapsedMs = Date.now() - t0;
        if (!r.length) return { columns: [], rows: [], rowCount: 0, elapsedMs };
        const { columns, values } = r[0];
        const rows = values.map((arr) => {
          const obj = {};
          for (let i = 0; i < columns.length; i++) obj[columns[i]] = arr[i];
          return obj;
        });
        return { columns, rows, rowCount: rows.length, elapsedMs };
      }
    } else if (this.type === 'mssql') {
      const r = await this.pool.request().query(trimmed);
      const elapsedMs = Date.now() - t0;
      const rows = r.recordset || [];
      // mssql 把列元数据挂在 recordset.columns 上, 空结果集也在
      const meta = r.recordset && r.recordset.columns;
      const columns = meta ? Object.keys(meta) : Object.keys(rows[0] || {});
      return { columns, rows, rowCount: rows.length, elapsedMs };
    }
    throw new Error('不支持的数据库类型');
  }

  async close() {
    try {
      if (this.type === 'mysql' && this.pool) await this.pool.end();
      if (this.type === 'postgres') {
        if (this.conn) this.conn.release();
        if (this.pool) await this.pool.end();
      }
      if (this.type === 'sqlite' && this.db) {
        try { this.db.close(); } catch (e) {}
      }
      if (this.type === 'mssql' && this.pool) await this.pool.close();
    } catch (e) {
      // ignore
    } finally {
      // 复位复用标记, 之后若再次调用会重新建连
      this._connected = false;
      this._connecting = null;
    }
  }
}

module.exports = Database;
// 只读闸门是安全边界, 单独导出来给测试用 (它是纯函数, 不需要连库就能测)
module.exports.assertReadOnlySingleStatement = assertReadOnlySingleStatement;
module.exports.sqlSkeleton = sqlSkeleton;
module.exports.usesBackslashEscapes = usesBackslashEscapes;
// 摘要缓存要能在测试里清掉: 用例之间共用同一个模块级缓存会互相污染
module.exports.clearDigestCache = clearDigestCache;
module.exports.cleanComment = cleanComment;