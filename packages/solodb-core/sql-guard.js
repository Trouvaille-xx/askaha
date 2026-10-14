'use strict';

/**
 * 只读 SQL 策略 —— "这条语句能不能拿去执行"的唯一判据。
 *
 * 为什么它属于核心包而不是宿主: 读数是这个产品的安全承诺, 而宿主会有不止一个
 * (现在的 Electron 应用, 以及将来 DSH 插件那种形态)。每个宿主各写一份闸门,
 * 迟早有一份松掉 —— 而且松掉的那份不会有任何症状。
 *
 * 这里只做**纯文本层面**的判断 (不需要连库), 因此零依赖; 真正的连接与驱动
 * 留在宿主, 由 createReadOnlyDb 在边界上把它包起来。
 *
 * 下面每一条规则的注释都对应一次真实的绕过尝试, 不要因为"看着多余"删掉。
 */

/**
 * 把 SQL 中的注释 / 字符串字面量 / 带引号标识符替换为空白, 得到一份"骨架"。
 * 骨架不用于执行, 只用于静态校验 —— 这样注释里的关键字、字符串里的分号
 * 都不会干扰判断。
 *
 * 反斜杠**只有 MySQL 默认模式下**才是转义符。PostgreSQL / SQL Server / SQLite
 * 里它是普通字符, 把它们当 MySQL 读会多吃一个字符:
 *
 *   SELECT 'a\' ; DROP TABLE t ; -- '
 *
 * 按"反斜杠转义"读, 字面量会一路吞到最后一个引号, 骨架只剩 `SELECT` ——
 * 开头检查、分号检查、写关键字检查全部落空; 而 pg 的简单查询协议和 mssql 的
 * 批处理**会真的执行**第二条语句。所以这里按方言决定怎么读字面量:
 * 宁可把字面量读短 (多报一次错), 也不能读长 (漏掉真实代码)。
 */
function sqlSkeleton(text, opts = {}) {
  const backslashEscapes = opts.backslashEscapes === true;
  const s = String(text == null ? '' : text);
  const n = s.length;
  let out = '';
  let i = 0;
  while (i < n) {
    const ch = s[i];
    const next = s[i + 1];
    if (ch === '-' && next === '-') {
      const nl = s.indexOf('\n', i);
      i = nl === -1 ? n : nl;
      out += ' ';
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = s.indexOf('*/', i + 2);
      const close = end === -1 ? n : end + 2;
      // MySQL 的 /*! ... */ 和 /*!50000 ... */ 是**可执行**的版本注释 ——
      // 里面的内容会被真正执行, 不是注释。
      //
      // 以前这里一律当注释删掉, 于是 `SELECT 1 /*! ; DROP TABLE t */` 的骨架
      // 只剩 `SELECT 1`, 校验全过, 然后数据库真的执行了 DROP。
      // 等价地把整条语句藏进注释里也能绕过开头检查。
      //
      // 修法: 保留里面的内容 (含版本号), 只丢掉 /*! 和 */ 这两个记号,
      // 让内层代码照常接受后续所有检查。
      //
      // 对 postgres / sqlite 来说 /*! 确实是普通注释, 保留内容会让校验偏严。
      // 这是刻意的: 跟 sqlSkeleton 一贯的原则一致 —— 宁可误报一次,
      // 也不能漏掉真实可执行的代码。
      if (s[i + 2] === '!') {
        out += ' ' + s.slice(i + 3, end === -1 ? n : end) + ' ';
      } else {
        out += ' ';
      }
      i = close;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < n) {
        if (backslashEscapes && s[j] === '\\') { j += 2; continue; }
        if (s[j] === ch) {
          if (s[j + 1] === ch) { j += 2; continue; } // 转义写法 ('' / "" / ``)
          break;
        }
        j += 1;
      }
      i = j + 1 > n ? n : j + 1;
      out += ' ';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** 这个方言里反斜杠是不是转义符 */
function usesBackslashEscapes(type) {
  return String(type || '').toLowerCase() === 'mysql';
}

// 允许作为语句开头的只读动词
const READONLY_LEAD = /^\s*(select|with|pragma|explain)\b/i;

// PRAGMA 的赋值写法会改库 (journal_mode / writable_schema 等), 只放行查询写法
const PRAGMA_ASSIGN = /^\s*pragma\b[\s\S]*=/i;

// 写操作 / 会话控制关键字。用 \b 限定, 因此 created_at / updated_at / settings
// 这类列名不会被误伤; 字符串与注释已在骨架阶段被剥离。
const WRITE_KEYWORDS = /\b(insert|update|delete|drop|alter|create|truncate|merge|grant|revoke|rename|attach|detach|vacuum|reindex|analyze|kill|shutdown|lock|unlock|call|exec|execute|do|copy|load|import|into|begin|commit|rollback|savepoint|set)\b/i;

/**
 * 危险函数调用 —— 语法上是 SELECT, 但读的是服务器文件 / 拖死连接。
 *
 * 只在**骨架**上匹配 (字符串与普通注释已剥离), 所以 'SLEEP(' 这种字面量不会误报。
 * 全部要求跟一个左括号, 于是叫 sleep 的列 (`SELECT sleep FROM t`) 也不会误伤。
 *
 * 刻意**不封** information_schema / pg_catalog / sqlite_master:
 * describe_table 和 check_index 自己就在查它们, 封了等于把功能砍掉。
 * "只能碰白名单里的表"是另一层的事 (要拿到用户勾选的清单才能判), 不在这里做。
 */
const DANGEROUS_CALL = new RegExp(
  '\\b(' + [
    // 读数据库服务器上的文件
    'load_file', 'pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'pg_stat_file',
    'lo_import', 'lo_export', 'openrowset', 'opendatasource', 'openquery',
    'pg_execute_server_program',
    // 拖死连接 / 烧 CPU
    'sleep', 'pg_sleep', 'pg_sleep_for', 'pg_sleep_until', 'benchmark',
    // 外连 / 执行系统命令
    'dblink', 'sys_eval', 'sys_exec'
  ].join('|') + ')\\s*\\(',
  'i'
);

/**
 * 危险过程 —— 这几个不带括号也能用 (EXEC xp_cmdshell '...'), 所以按裸词匹配。
 *
 * 裸词会误伤同名标识符, 但这些都是 SQL Server 的扩展存储过程名, 拿来当列名
 * 基本不可能; 按 sqlSkeleton 一贯的取舍, 宁可误报。
 */
const DANGEROUS_NAME = /\b(xp_cmdshell|sp_executesql|sp_oacreate|sp_oamethod|xp_regread|xp_regwrite)\b/i;

/**
 * 校验一条 SQL 是否属于"单条只读语句"。
 * 不通过时抛出带原因的错误, 通过时无返回。
 *
 * type 是方言 (mysql / postgres / sqlite / mssql): 它决定字面量里的反斜杠算不算
 * 转义符。传错方向只会让校验更严 (误报), 不会更松 —— 见 sqlSkeleton 的说明。
 */
function assertReadOnlySingleStatement(rawSql, type) {
  const original = String(rawSql == null ? '' : rawSql);
  if (!original.trim()) throw new Error('SQL 为空');

  const skeleton = sqlSkeleton(original, { backslashEscapes: usesBackslashEscapes(type) });
  const lead = skeleton.trim();
  if (!lead) throw new Error('SQL 为空');

  if (!READONLY_LEAD.test(lead)) {
    throw new Error('只读模式只允许 SELECT / WITH / EXPLAIN / PRAGMA 开头的语句');
  }

  if (PRAGMA_ASSIGN.test(lead)) {
    throw new Error('只读模式不允许 PRAGMA 赋值写法 (会修改连接或数据库配置)');
  }

  // 分号后若还有内容, 说明是多条语句。sql.js / pg 会一并交给数据库,
  // 只校验开头就等于放行后面的写操作。
  const semi = skeleton.indexOf(';');
  if (semi !== -1 && skeleton.slice(semi + 1).trim()) {
    throw new Error('一次只允许执行一条语句, 检测到分号后还有内容, 请拆开后再执行');
  }

  // WITH ... DELETE / EXPLAIN 之外的写操作: 开头看着是只读, 实际会改数据
  const hit = skeleton.match(WRITE_KEYWORDS);
  if (hit) {
    throw new Error(`只读模式禁止写操作关键字: ${hit[0].toUpperCase()}`);
  }

  // 危险函数。这些**语法上确实是 SELECT**, 所以动词和写关键字两道检查都拦不住,
  // 但它们读的不是业务数据:
  //   - LOAD_FILE / pg_read_file / OPENROWSET: 读数据库**服务器上**的任意文件
  //     (含配置文件、凭据), 绕过了"只读"这个承诺本身
  //   - SLEEP / BENCHMARK: 拖死连接、烧 CPU —— 在生产的库上是事故
  // 只读模式下没有一个有正当用途。
  //
  // 在**骨架**上匹配, 所以写在字符串里的 'SLEEP(' 不会误报;
  // 而 /*! SLEEP(30) */ 因为上面的可执行注释处理已经进了骨架, 会被拦到。
  const danger = skeleton.match(DANGEROUS_CALL);
  if (danger) {
    throw new Error(`只读模式禁止调用危险函数: ${danger[1].toUpperCase()}`);
  }
  const dangerName = skeleton.match(DANGEROUS_NAME);
  if (dangerName) {
    throw new Error(`只读模式禁止使用危险过程: ${dangerName[1].toUpperCase()}`);
  }
}

/**
 * 把一个宿主自己的连接包装成"只能只读查询"的连接。
 *
 * 宿主各自管自己的驱动和连接池, 但**都要**经过这道闸门。包装之后闸门就在边界上,
 * 而不是散落在每个调用点 —— 少写一次 assert 就少一个洞, 而那种洞测不出来。
 *
 * @param {object} inner   宿主的连接对象, 只要有 query(sql, params)
 * @param {string} dialect mysql | postgres | sqlite | mssql
 * @returns {{dialect: string, query: Function, close: Function}} 可直接交给 engine / data-peek
 */
function createReadOnlyDb(inner, dialect) {
  if (!inner || typeof inner.query !== 'function') {
    throw new TypeError('createReadOnlyDb: inner 必须有 query(sql, params)');
  }
  return {
    dialect,
    async query(sqlText, params) {
      assertReadOnlySingleStatement(sqlText, dialect);
      return inner.query(sqlText, params);
    },
    async close() {
      if (typeof inner.close === 'function') return inner.close();
      return undefined;
    }
  };
}

module.exports = {
  sqlSkeleton,
  usesBackslashEscapes,
  assertReadOnlySingleStatement,
  createReadOnlyDb
};