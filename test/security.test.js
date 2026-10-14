'use strict';

/**
 * 安全回归测试 —— 覆盖这次修掉的几个洞。
 *
 * 这些都是"改一行就可能悄悄退回去"的地方: 转义、闸门、路径拼接。
 * 跑法: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const Database = require('../lib/database');
const Report = require('../lib/report');
const { isSafeId, assertSafeId } = require('../lib/safe-id');
const { publicConfig } = require('../lib/public-config');
const Store = require('../lib/store');

const { assertReadOnlySingleStatement, sqlSkeleton } = Database;

/* ============================================================
 * 0. 配置下发脱敏 (密钥不出主进程)
 * ============================================================ */

test('publicConfig: 下发给渲染层的副本里没有任何明文密钥', () => {
  const secretKey = 'sk-live-DO-NOT-LEAK-0123456789';
  const dbPass = 'prod-db-password-xyz';
  const cfg = {
    llm: { baseURL: 'https://gw.example/v1', apiKey: secretKey, model: 'm' },
    databases: [
      { id: 'd1', name: 'OMS', password: dbPass, host: 'h', tables: [{ name: 't', checked: true }] },
      { id: 'd2', name: 'SRM', password: '', host: 'h2' }
    ],
    engines: [{ id: 'e1' }],
    general: { maxSteps: 16 }
  };

  const out = publicConfig(cfg);
  const json = JSON.stringify(out);

  // 最关键的一条: 整个下发对象里不得出现明文
  assert.ok(!json.includes(secretKey), 'API Key 泄漏到渲染层');
  assert.ok(!json.includes(dbPass), '数据库口令泄漏到渲染层');

  // 但界面要能知道"配没配"
  assert.strictEqual(out.llm.apiKey, '');
  assert.strictEqual(out.llm.apiKeySet, true);
  assert.strictEqual(out.databases[0].password, '');
  assert.strictEqual(out.databases[0].passwordSet, true);
  assert.strictEqual(out.databases[1].passwordSet, false);

  // 非敏感字段必须原样保留, 否则界面就瞎了
  assert.strictEqual(out.llm.baseURL, 'https://gw.example/v1');
  assert.strictEqual(out.llm.model, 'm');
  assert.strictEqual(out.databases[0].host, 'h');
  assert.deepStrictEqual(out.databases[0].tables, [{ name: 't', checked: true }]);
  assert.deepStrictEqual(out.engines, [{ id: 'e1' }]);
  assert.deepStrictEqual(out.general, { maxSteps: 16 });
});

test('publicConfig: 不改动主进程持有的原对象', () => {
  const cfg = { llm: { apiKey: 'secret' }, databases: [{ id: 'd', password: 'pw' }] };
  publicConfig(cfg);
  // 主进程还要用真密钥去调用模型, 原对象必须完好
  assert.strictEqual(cfg.llm.apiKey, 'secret');
  assert.strictEqual(cfg.databases[0].password, 'pw');
});

test('publicConfig: 缺字段 / 畸形输入不炸', () => {
  for (const bad of [{}, null, undefined, { llm: null, databases: null }, { databases: 'x' }]) {
    const out = publicConfig(bad);
    assert.strictEqual(out.llm.apiKey, '');
    assert.strictEqual(out.llm.apiKeySet, false);
    assert.ok(Array.isArray(out.databases));
  }
});

/* ============================================================
 * 1. SQL 只读闸门
 * ============================================================ */

test('只读闸门: 反斜杠绕过在 PG / MSSQL / SQLite 上被封堵', () => {
  // 这是原来的洞: 骨架把 \ 当转义符, 于是 'a\' 之后的代码被整体吞掉,
  // 开头检查 / 分号检查 / 写关键字检查全部落空 —— 而 pg 会真的执行第二条语句。
  const bypass = "SELECT 'a\\' ; DROP TABLE t ; -- '";

  for (const type of ['postgres', 'mssql', 'sqlite']) {
    assert.throws(
      () => assertReadOnlySingleStatement(bypass, type),
      /写操作关键字|分号后还有内容/,
      `${type} 上这条语句必须被拒`
    );
  }
});

test('只读闸门: MySQL 上正常终止的字面量后跟第二条语句会被拦下', () => {
  // 注: MySQL 里 \ 确实是转义符, 所以 "SELECT '\' ; DROP ..." 在 MySQL 语义下
  // 是一个**未终止**的字面量 (单条语法错误的语句), 不该按多语句处理。
  // MySQL 那条路径真正的护栏是驱动层 (mysql2 默认 multipleStatements: false)。
  // 这里测的是: 字面量正常闭合时, 后面的第二条语句必须被看见并拦下。
  assert.throws(
    () => assertReadOnlySingleStatement("SELECT 'a' ; DROP TABLE t", 'mysql'),
    /分号后还有内容/
  );
  assert.throws(
    () => assertReadOnlySingleStatement("SELECT 'a' , 'b\\'c' ; DELETE FROM t", 'mysql'),
    /分号后还有内容/
  );
});

test('只读闸门: 多语句一律拒绝', () => {
  assert.throws(() => assertReadOnlySingleStatement('SELECT 1; SELECT 2', 'mysql'), /分号后还有内容/);
  assert.throws(() => assertReadOnlySingleStatement('SELECT 1;DROP TABLE t', 'postgres'), /分号后还有内容/);
});

test('只读闸门: WITH ... DELETE 这类伪装被拦下', () => {
  assert.throws(
    () => assertReadOnlySingleStatement('WITH x AS (SELECT 1) DELETE FROM t', 'postgres'),
    /写操作关键字/
  );
});

test('只读闸门: 非只读动词开头一律拒绝', () => {
  for (const sql of ['DROP TABLE t', 'UPDATE t SET a=1', 'INSERT INTO t VALUES (1)', 'SHOW INDEX FROM t']) {
    assert.throws(() => assertReadOnlySingleStatement(sql, 'mysql'), /只读模式只允许/);
  }
});

test('只读闸门: PRAGMA 赋值写法被拒绝, 查询写法放行', () => {
  assert.throws(() => assertReadOnlySingleStatement('PRAGMA journal_mode = WAL', 'sqlite'), /PRAGMA 赋值/);
  assert.doesNotThrow(() => assertReadOnlySingleStatement('PRAGMA table_info(orders)', 'sqlite'));
});

test('只读闸门: 正常的只读查询不受影响', () => {
  const ok = [
    ['SELECT * FROM orders WHERE status = \'paid\'', 'mysql'],
    ["SELECT * FROM orders WHERE note = 'has a \\ backslash'", 'postgres'],
    ['SELECT a FROM t WHERE b IN (\'x;y\', \'z\')', 'mysql'],
    ['SELECT "col" FROM "table" WHERE x = 1', 'postgres'],
    ['WITH c AS (SELECT 1 AS n) SELECT n FROM c', 'postgres'],
    ['SELECT 1 -- 注释里有 DROP TABLE', 'mysql'],
    ['SELECT /* DELETE */ 1', 'mysql'],
    ['SELECT * FROM `orders`', 'mysql']
  ];
  for (const [sql, type] of ok) {
    assert.doesNotThrow(() => assertReadOnlySingleStatement(sql, type), `应放行: ${sql} (${type})`);
  }
});

test('只读闸门: 空语句被拒绝', () => {
  assert.throws(() => assertReadOnlySingleStatement('', 'mysql'), /SQL 为空/);
  assert.throws(() => assertReadOnlySingleStatement('   ', 'mysql'), /SQL 为空/);
});

test('骨架: 字符串里的分号不会干扰判断', () => {
  const sk = sqlSkeleton("SELECT 'a;b' FROM t", { backslashEscapes: false });
  assert.strictEqual(sk.indexOf(';'), -1, '字符串内的分号应被抹掉');
});

test('check_index 的 MySQL 查询能过只读闸门 (不能再用 SHOW INDEX)', () => {
  // 这个工具原来发的是 SHOW INDEX FROM ... —— 只读闸门只放行
  // SELECT / WITH / PRAGMA / EXPLAIN, SHOW 一律被拒, 所以它在 MySQL 上必挂。
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'engine-ai.js'), 'utf-8');
  // 去掉注释再检查 —— 源码注释里正当地提到了 SHOW INDEX (说明为什么不能用它)
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  assert.ok(!/SHOW\s+INDEX/i.test(code), 'engine-ai.js 的代码里不该再有 SHOW INDEX (会被只读闸门拒掉)');
  assert.ok(/information_schema\.STATISTICS/i.test(code), 'MySQL 索引查询应改走 information_schema');

  // 把源码里那条 SELECT 抠出来, 确认它真的能过闸门
  const m = code.match(/SELECT INDEX_NAME[\s\S]*?SEQ_IN_INDEX`/);
  assert.ok(m, '应能在源码里找到索引查询');
  const sql = m[0].replace(/\$\{[^}]*\}/g, 'orders').replace(/`/g, '');
  assert.doesNotThrow(
    () => assertReadOnlySingleStatement(sql, 'mysql'),
    'MySQL 索引查询必须能过只读闸门'
  );
});

/* ============================================================
 * 2. 报告 HTML 的脚本转义
 * ============================================================ */

// 大小写不敏感的 </script 才是关键: HTML 标签名匹配不区分大小写,
// 只挡小写等于没挡。
test('safeScript: 大小写不敏感的 </script 都被转义', () => {
  for (const probe of ['</script>', '</SCRIPT>', '</ScRiPt >', '</script foo']) {
    const out = Report.safeScript(probe);
    assert.ok(!/<\/script/i.test(out), `必须转义: ${probe} → ${out}`);
  }
  assert.ok(!/<!--/.test(Report.safeScript('<!-- x -->')));
});

test('safeJsonForScript: 数据里的 < 一律变成 \\u003c', () => {
  const out = Report.safeJsonForScript([{ name: '</SCRIPT><script>alert(1)</script>' }]);
  assert.ok(!out.includes('<'), '不得残留任何 <');
  assert.ok(out.includes('\\u003c'), '应转成 \\u003c');
  // 语义必须等价: 转义后仍是合法 JSON, 解回来还是原文
  assert.deepStrictEqual(JSON.parse(out), [{ name: '</SCRIPT><script>alert(1)</script>' }]);
});

test('safeJsonForScript: U+2028 / U+2029 被转义', () => {
  const out = Report.safeJsonForScript(['a\u2028b\u2029c']);
  assert.ok(!out.includes('\u2028') && !out.includes('\u2029'));
  assert.strictEqual(JSON.parse(out)[0], 'a\u2028b\u2029c');
});

test('端到端: 数据库单元格里的 payload 无法逃出报告的 <script> 块', () => {
  // 攻击面: 被画成图表的维度列。值来自数据库, 属于不可信输入。
  const payloads = [
    '</SCRIPT><script src=//evil.example/x.js></script>',
    '</SCRIPT><script>alert(document.domain)</script>',
    '</SCRIPT><script>parent.bridge.config.get()</script>',
    '</script><img src=x onerror=alert(1)>'
  ];

  for (const payload of payloads) {
    const html = Report.build({
      title: 'T', task: 't', summary: 's', insights: ['i'], kpis: [],
      charts: [{ title: 'C', type: 'pie', source: 1, nameField: 's', series: [{ field: 'n' }] }],
      steps: [{
        kind: 'sql', sql: 'SELECT s, n FROM t',
        result: { columns: ['s', 'n'], rows: [{ s: payload, n: 1 }] }
      }]
    }).html;

    // 1) 原文不得出现 —— 数据里的 < 已经变成 \u003c
    assert.ok(!html.includes(payload), `payload 原样出现在报告里: ${payload}`);

    // 2) 脚本块的开闭标签必须配平 (报告自己那两个 </script> 是合法的,
    //    多出来的那个才是被 payload 造出来的)
    const opens = (html.match(/<script[\s>]/gi) || []).length;
    const closes = (html.match(/<\/script[\s>]/gi) || []).length;
    assert.strictEqual(opens, closes, `脚本标签不配平 (${opens} 开 / ${closes} 闭)`);

    // 3) var OPTS 那一段**数据区**里不得出现任何裸 <
    //    (只查数据区: draw() 里还有 report.js 自己写的 '<div ...>' 字面量, 那是可信代码)
    const marker = 'var OPTS = ';
    const i = html.indexOf(marker);
    assert.ok(i !== -1, 'OPTS 应存在');
    const dataRegion = html.slice(i + marker.length, html.indexOf(';', i));
    assert.ok(
      !dataRegion.includes('<'),
      `数据区出现裸 <: ${dataRegion.slice(0, 200)}`
    );
  }
});

/* ============================================================
 * 3. 落盘 id 的白名单
 * ============================================================ */

test('safe-id: 我们生成的 id 放行', () => {
  for (const id of ['c_1758000000000_ab12', 'a_1758000000000_x9', 'c_1001_abcd', 'abc', 'A-b_c9']) {
    assert.ok(isSafeId(id), `应放行: ${id}`);
  }
});

test('safe-id: 路径穿越与奇怪字符一律拒绝', () => {
  const bad = [
    '../config', '..\\config', '../../config', 'a/../../b',
    '/etc/passwd', 'C:\\Windows\\System32', 'a/b', 'a\\b',
    '..', '.', '', 'a.json', 'a b', 'a\u0000b', 'x'.repeat(65),
    null, undefined, 42, {}, []
  ];
  for (const id of bad) {
    assert.ok(!isSafeId(id), `应拒绝: ${JSON.stringify(id)}`);
    assert.throws(() => assertSafeId(id), /非法的/, `assertSafeId 应抛错: ${JSON.stringify(id)}`);
  }
});

test('端到端: conv:delete 拿穿越 id 删不掉工作区外的文件', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solodb-safeid-'));
  try {
    // 造一个"工作区外的敏感文件", 名字就是 config.json —— 跟真实布局一致:
    // userData/conversations/../config.json 就是 userData/config.json
    const victim = path.join(root, 'config.json');
    fs.writeFileSync(victim, '{"secret":"db-password"}', 'utf-8');

    const store = new Store({ rootDir: root });

    // 这正是修复前能得手的那一发。store 内部会抛错 (被 getConversation 的
    // catch 吞掉 → 返回 null), 所以这里断言的是**文件必须还在**,
    // 也就是安全属性本身, 而不是某个具体的报错方式。
    for (const evil of ['../config', '..\\config', '../../config']) {
      store.deleteConversation(evil);
      assert.ok(fs.existsSync(victim), `config.json 被 ${evil} 删掉了`);
    }

    // 白名单本身要能挡住 (直接调私有方法, 确认不是靠"文件恰好不存在")
    assert.throws(() => store._convPath('../config'), /非法的/);
    assert.throws(() => store._convPath('..\\config'), /非法的/);

    // 正常 id 仍然能删
    const conv = store.createConversation({ id: 'c_1_abcd', title: '正常对话' });
    assert.deepStrictEqual(store.deleteConversation(conv.id), { ok: true });
    assert.ok(!fs.existsSync(path.join(root, 'conversations', 'c_1_abcd.json')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ============================================================
 * 4. LLM 请求超时与中断
 * ============================================================ */

function hangingServer() {
  // 收下请求但永不响应 —— 复现"网关抽风导致任务无限期卡死"
  const server = http.createServer(() => { /* 故意不响应 */ });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('LLM: 无响应的请求会超时中断, 不会永远挂着', async () => {
  const server = await hangingServer();
  const port = server.address().port;
  const LLMClient = require('../lib/llm');
  const client = new LLMClient({
    baseURL: `http://127.0.0.1:${port}/v1`,
    apiKey: 'x',
    model: 'm',
    timeoutMs: 400
  });

  const t0 = Date.now();
  await assert.rejects(
    () => client.chat([{ role: 'user', content: 'hi' }]),
    (err) => err.code === 'ETIMEDOUT' && /超时/.test(err.message)
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 5000, `应快速中断, 实际 ${elapsed}ms`);
  server.close();
});

test('LLM: abort() 能中断在飞的请求', async () => {
  const server = await hangingServer();
  const port = server.address().port;
  const LLMClient = require('../lib/llm');
  const client = new LLMClient({
    baseURL: `http://127.0.0.1:${port}/v1`,
    apiKey: 'x',
    model: 'm',
    timeoutMs: 30000
  });

  const inflight = client.chat([{ role: 'user', content: 'hi' }]);
  await new Promise((r) => setTimeout(r, 80)); // 等请求真的发出去
  assert.strictEqual(client.abort(), true, 'abort 应命中在飞请求');
  await assert.rejects(() => inflight, (err) => err.code === 'ABORT_ERR');
  assert.strictEqual(client.abort(), false, '没有在飞请求时应返回 false');
  server.close();
});

test('LLM: 正常响应仍然照常返回', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '好的' } }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const LLMClient = require('../lib/llm');
  const client = new LLMClient({ baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'x', model: 'm' });
  assert.strictEqual(await client.chat([{ role: 'user', content: 'hi' }]), '好的');
  server.close();
});

/* ============================================================
 * MySQL 可执行注释: 感叹号版本注释不是注释, 是要执行的代码
 *
 * 这一类以前**整批漏掉**: sqlSkeleton 把它当普通注释删掉,
 * 于是 SELECT 1 后面跟一段感叹号注释里藏 DROP 的语句, 骨架只剩 SELECT 1,
 * 校验全过, 而 MySQL 会真的执行里面的 DROP。
 *
 * 为什么这批要单独测: 逃逸不在"关键字"上, 而在**词法层**——
 * 所有基于关键字/动词的检查都会因为看不见内容而集体失效。
 * ============================================================ */

test('可执行注释: 里面的代码必须进入骨架 (以前被当注释整段删掉)', () => {
  const sk = sqlSkeleton("SELECT 1 /*! ; DROP TABLE t */", { backslashEscapes: false });
  assert.ok(/DROP/i.test(sk), '/*! */ 里的 DROP 必须留在骨架里: ' + sk);
});

test('可执行注释: 普通块注释仍然按注释删掉 (不能把什么都留下)', () => {
  const sk = sqlSkeleton('SELECT /* DELETE */ 1', { backslashEscapes: false });
  assert.ok(!/DELETE/i.test(sk), '普通 /* */ 是注释, 应被抹掉: ' + sk);
  const sk2 = sqlSkeleton('SELECT /*+ MAX_EXECUTION_TIME(1000) */ id FROM t', { backslashEscapes: false });
  assert.ok(!/MAX_EXECUTION_TIME/i.test(sk2), '优化器提示 /*+ */ 也是注释: ' + sk2);
});

test('可执行注释: 各种藏法都被拦下', () => {
  const bad = [
    "SELECT 1 /*! ; DROP TABLE t */",
    "SELECT /*!50000 ; DROP TABLE t */ 1",
    "SELECT /*!80000 ; DELETE FROM t */ 1",
    "SELECT /*!50000 SLEEP(30) */ 1",
    "SELECT 1 /*!50000 INTO OUTFILE '/tmp/x' */",
    "SELECT * FROM t /*! INTO OUTFILE '/tmp/x' */",
    "SELECT /*!50000 /*! ; DROP TABLE t */ */ 1"
  ];
  for (const sql of bad) {
    assert.throws(
      () => assertReadOnlySingleStatement(sql, 'mysql'),
      `必须拦住: ${sql}`
    );
  }
});

test('可执行注释: 正当的 MySQL 提示不能被误杀', () => {
  // /*! STRAIGHT_JOIN */ 是 MySQL 官方提示写法, 没有写操作语义, 必须放行
  assert.doesNotThrow(
    () => assertReadOnlySingleStatement('SELECT /*! STRAIGHT_JOIN */ a.id FROM a JOIN b ON a.id = b.id LIMIT 5', 'mysql'),
    '正当的 /*! 提示不该被拦'
  );
});

/* ============================================================
 * 危险函数: 语法上是 SELECT, 但读的是服务器文件 / 拖死连接
 *
 * 动词检查和写关键字检查都拦不住它们 —— 它们**确实是 SELECT**。
 * ============================================================ */

test('危险函数: 读服务器文件的一律拦下', () => {
  const bad = [
    ["SELECT LOAD_FILE('/etc/passwd')", 'mysql'],
    ["SELECT pg_read_file('/etc/passwd')", 'postgres'],
    ["SELECT pg_read_binary_file('/etc/passwd')", 'postgres'],
    ["SELECT pg_ls_dir('/')", 'postgres'],
    ["SELECT pg_stat_file('/etc/passwd')", 'postgres'],
    ["SELECT lo_import('/etc/passwd')", 'postgres'],
    ["SELECT * FROM OPENROWSET(BULK '/etc/passwd', SINGLE_CLOB) AS x", 'mssql'],
    ["SELECT * FROM OPENDATASOURCE('SQLNCLI', 'x').db.dbo.t", 'mssql'],
    ["SELECT * FROM OPENQUERY(linked, 'SELECT 1')", 'mssql']
  ];
  for (const [sql, type] of bad) {
    assert.throws(() => assertReadOnlySingleStatement(sql, type), `必须拦住: ${sql}`);
  }
});

test('危险函数: 拖死连接 / 烧 CPU 的一律拦下', () => {
  const bad = [
    'SELECT SLEEP(30)',
    'SELECT BENCHMARK(100000000, MD5(1))',
    "SELECT pg_sleep(30)"
  ];
  for (const sql of bad) {
    assert.throws(() => assertReadOnlySingleStatement(sql, 'mysql'), `必须拦住: ${sql}`);
  }
  assert.throws(() => assertReadOnlySingleStatement('SELECT pg_sleep(30)', 'postgres'), /危险函数/);
});

test('危险函数: SQL Server 扩展存储过程拦下 (不带括号也能用)', () => {
  const bad = [
    "EXEC xp_cmdshell 'whoami'",
    "EXEC sp_executesql N'DROP TABLE t'",
    "EXEC sp_OACreate 'WScript.Shell', @o OUT"
  ];
  for (const sql of bad) {
    assert.throws(() => assertReadOnlySingleStatement(sql, 'mssql'), `必须拦住: ${sql}`);
  }
});

test('危险函数: 不能误伤同名的列和字符串', () => {
  const ok = [
    // 列名就叫 sleep —— 要求跟左括号, 所以不该命中
    ['SELECT sleep, backup_size FROM t LIMIT 5', 'mysql'],
    // 字符串字面量里的 SLEEP( —— 骨架阶段已被剥离
    ["SELECT id FROM t WHERE note = 'SLEEP(30)' LIMIT 5", 'mysql'],
    ["SELECT id FROM t WHERE msg = 'LOAD_FILE(x)' LIMIT 5", 'mysql'],
    // 只是名字里含 sleep 的函数
    ['SELECT sleep_duration, sleeps FROM t LIMIT 5', 'mysql']
  ];
  for (const [sql, type] of ok) {
    assert.doesNotThrow(() => assertReadOnlySingleStatement(sql, type), `不该误杀: ${sql}`);
  }
});

test('危险函数: 信息架构表刻意不封 (describe_table / check_index 自己要用)', () => {
  // 封了 information_schema 等于把"看表结构"和"查索引"两个功能砍掉。
  // "只能碰白名单里的表"是另一层的事, 要拿到用户勾选的清单才能判。
  assert.doesNotThrow(
    () => assertReadOnlySingleStatement('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()', 'mysql'),
    'information_schema 必须能查'
  );
  assert.doesNotThrow(
    () => assertReadOnlySingleStatement('SELECT indexname FROM pg_indexes WHERE tablename = \'orders\'', 'postgres'),
    'pg_indexes 必须能查'
  );
});
