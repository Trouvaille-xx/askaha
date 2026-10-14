'use strict';

/**
 * 分析 Agent 补上的三个"标配"只读工具, 以及 contextBlock 里的当前时间。
 *
 * 为什么这三个要专门测:
 *   1. 它们都是**免确认**的 (在 ANALYSIS_READ_ONLY 里)。免确认的前提是"只读 + 范围受限",
 *      所以越界拦截必须真的有效 —— 拦不住就等于开了一个绕过白名单的后门。
 *   2. look_at_data / check_index 要自己拼标识符, 方言写错不是"查不到"而是整条 SQL
 *      语法错误。这个错在 MySQL 上必挂, 而用户 4 个库里 3 个是 MySQL。
 *   3. check_index 在没实现的方言上必须**明说没做**, 不能返回空 ——
 *      返回空会被上游翻译成"一个索引都没有", 那是假话。
 */

const test = require('node:test');
const assert = require('node:assert');

const AgentMod = require('../lib/agent.js');
const { BUILTIN_TOOLS } = require('../lib/actions.js');

const NEW_TOOLS = ['look_at_data', 'check_index', 'read_result'];

/* ============================================================
 * 桩
 * ============================================================ */

const toolOf = (name) => BUILTIN_TOOLS.find((t) => t.function.name === name);

/**
 * 假库 + 假路由器。
 *
 * look_at_data / check_index 走 targetFor() 而不是 query(): 它们拼出来的表名带引号,
 * 交给 query() 那条"用正则从 SQL 里认表名"的路由不可靠。
 */
function fakeDb(opts = {}) {
  const queried = [];
  return {
    type: 'mysql',
    queried,
    async query(sql) {
      queried.push(sql);
      if (opts.answer) {
        const r = opts.answer(sql);
        if (r) return r;
      }
      return { columns: ['v'], rows: [], rowCount: 0, elapsedMs: 1 };
    },
    async listTables() { return ['orders']; },
    async describeTable() { return [{ field: 'id', type: 'int' }]; },
    targetFor(table) {
      if (opts.unknownTable && table === opts.unknownTable) {
        throw new Error(`表 ${table} 不在已勾选的清单里, 无法确定它在哪个库。`);
      }
      return { db: this, dialect: opts.dialect || 'mysql', dbName: 'testdb' };
    }
  };
}

function makeAgent(db, llm) {
  return new AgentMod({
    llm: llm || {
      config: { apiKey: 'x' },
      chat: async () => '',
      chatStep: async () => ({ content: '', toolCalls: [] })
    },
    database: db,
    skills: null,
    tableInventory: [{ name: 'orders' }],
    engines: [],
    databases: [],
    openDb: null,
    mcp: null,
    prompt: null,
    general: {}
  });
}

/** 已确认 orders(id, name, ack_state) 的作用域 */
function envFor(agent, opts = {}) {
  const events = [];
  const reg = agent._analysisTools({
    ask: async () => ({}),
    emit: (e) => events.push(e),
    scope: {
      tables: ['orders'],
      schemaMap: {
        orders: [
          { field: 'id', type: 'int' },
          { field: 'name', type: 'varchar' },
          { field: 'ack_state', type: 'int' }
        ]
      },
      fieldsSelected: { orders: opts.selected || ['id', 'name', 'ack_state'] }
    },
    candidates: ['orders'],
    task: 't',
    steps: opts.steps || [],
    carry: {},
    st: {},
    contextBlock: () => ''
  });
  return { reg, events };
}

/* ============================================================
 * 1. 工具确实挂上去了
 * ============================================================ */

test('三个新工具都在工具表里, 且说明里点明了"不要凭猜"', () => {
  const names = BUILTIN_TOOLS.map((t) => t.function.name);
  for (const n of NEW_TOOLS) {
    assert.ok(names.includes(n), n + ' 应该在 BUILTIN_TOOLS 里');
    assert.ok(toolOf(n).function.description.length > 30, n + ' 的说明不能太短, 模型靠它决定用不用');
  }
  // 说明必须把"为什么"讲出来 —— 只写"看某列的值"模型不会在写 CASE WHEN 前想起它
  assert.match(toolOf('look_at_data').function.description, /不要凭|猜/);
  assert.match(toolOf('check_index').function.description, /全表扫/);
  assert.match(toolOf('read_result').function.description, /重跑/);
});

test('read_result 的参数里有分页, 免得一次把上下文撑爆', () => {
  const p = toolOf('read_result').function.parameters.properties;
  assert.ok(p.offset && p.limit, '要有 offset / limit');
  assert.ok(p.index, '要能按编号指定读哪一份资料');
});

/* ============================================================
 * 2. look_at_data
 * ============================================================ */

test('look_at_data: 给出取值、空值占比、去重数, 取值少时全列出来', async () => {
  const db = fakeDb({
    answer(sql) {
      if (/LIMIT 20/.test(sql)) return { columns: ['v'], rows: [{ v: '已确认' }, { v: '待确认' }, { v: null }], rowCount: 3 };
      if (/COUNT\(\*\) AS total/.test(sql)) return { columns: ['total'], rows: [{ total: 100, nonnull: 90, uniq: 2 }] };
      if (/SELECT DISTINCT/.test(sql)) return { columns: ['v'], rows: [{ v: '已确认' }, { v: '待确认' }] };
      return null;
    }
  });
  const { reg, events } = envFor(makeAgent(db));
  const out = await reg.call('look_at_data', { table: 'orders', column: 'ack_state' });

  assert.strictEqual(typeof out, 'string', '成功时返回给模型看的文本');
  assert.match(out, /已确认/, '要能看到真实取值');
  assert.match(out, /空值占比 10%/, '空值占比要算出来 (100 行里 90 行有值)');
  assert.match(out, /去重后 2 个不同值/);
  assert.match(out, /全部取值/, '取值 <=50 个时应该全列出来');
  assert.ok(events.some((e) => e.type === 'phase' && e.phase === 'peek'), '要发一个进度事件给界面');
});

test('look_at_data: 空值率过高时明确警告 —— 这是"看着像关联键其实查不到东西"的坑', async () => {
  const db = fakeDb({
    answer(sql) {
      if (/LIMIT 20/.test(sql)) return { columns: ['v'], rows: [{ v: null }], rowCount: 1 };
      if (/COUNT\(\*\) AS total/.test(sql)) return { columns: ['total'], rows: [{ total: 100, nonnull: 3, uniq: 3 }] };
      if (/SELECT DISTINCT/.test(sql)) return { columns: ['v'], rows: [{ v: 'a' }] };
      return null;
    }
  });
  const { reg } = envFor(makeAgent(db));
  const out = await reg.call('look_at_data', { table: 'orders', column: 'ack_state' });
  assert.match(out, /⚠/, '要警告');
  assert.match(out, /97%/, '要把空值占比写出来');
});

test('look_at_data: 取值很多时给最常见的 15 个, 不把全表铺开', async () => {
  const db = fakeDb({
    answer(sql) {
      if (/LIMIT 20/.test(sql)) return { columns: ['v'], rows: [{ v: 'x' }], rowCount: 1 };
      if (/COUNT\(\*\) AS total/.test(sql)) return { columns: ['total'], rows: [{ total: 999, nonnull: 999, uniq: 800 }] };
      if (/GROUP BY/.test(sql)) return { columns: ['v', 'n'], rows: [{ v: 'x', n: 12 }, { v: 'y', n: 7 }] };
      return null;
    }
  });
  const { reg } = envFor(makeAgent(db));
  const out = await reg.call('look_at_data', { table: 'orders', column: 'name' });
  assert.match(out, /最常见取值/);
  assert.match(out, /x\(12\)/);
  assert.strictEqual(/全部取值/.test(out), false, '取值太多时不该全列');
});

test('look_at_data: 表不在范围内 -> 拒绝 (免确认工具必须自己守住白名单)', async () => {
  const { reg } = envFor(makeAgent(fakeDb()));
  const out = await reg.call('look_at_data', { table: 'secrets', column: 'x' });
  assert.match(out, /不在本会话已确认的范围/, '越界的表必须被拦');
});

test('look_at_data: 千万行的表只抽样, 不再对整张表 COUNT(DISTINCT)', async () => {
  // 实测: 1055 万行、列上有索引, 全表 COUNT(DISTINCT) 单列仍要 11.6 秒
  const db = fakeDb({
    answer(sql) {
      if (/information_schema\.TABLES/.test(sql)) return { columns: ['n'], rows: [{ n: 10556391 }], rowCount: 1 };
      if (/LIMIT 20/.test(sql)) return { columns: ['v'], rows: [{ v: 'PO1' }], rowCount: 1 };
      if (/COUNT\(\*\) AS total/.test(sql)) return { columns: ['total'], rows: [{ total: 50000, nonnull: 50000, uniq: 800 }] };
      if (/GROUP BY/.test(sql)) return { columns: ['v'], rows: [{ v: 'PO1', n: 3 }] };
      return null;
    }
  });
  const { reg } = envFor(makeAgent(db));
  const out = await reg.call('look_at_data', { table: 'orders', column: 'ack_state' });

  assert.match(out, /抽样/, '大表必须标明是抽样 —— 不标的话模型会把抽样当成全表结论');
  assert.match(out, /10556391/, '要说清这张表多大');
  assert.strictEqual(
    db.queried.filter((q) => /COUNT\(DISTINCT `ack_state`\)/.test(q)).length, 0,
    '不能再对整张表做 COUNT(DISTINCT)'
  );
  assert.strictEqual(
    db.queried.filter((q) => /`orders`(?! LIMIT \d+)/.test(q)).length, 0,
    '任何一条 SQL 都不该直接打整张表'
  );
});

test('look_at_data: 列没被勾选 -> 拒绝 (只校验表会漏掉取消勾选的字段)', async () => {
  // 表在范围内, 但用户只勾了 id/name, 没勾 ack_state
  const { reg } = envFor(makeAgent(fakeDb()), { selected: ['id', 'name'] });
  const out = await reg.call('look_at_data', { table: 'orders', column: 'ack_state' });
  assert.match(out, /不在.*已确认的字段里/);
  assert.match(out, /id, name/, '要把可用字段列出来, 让模型换一个');
});

test('look_at_data: 标识符按方言加引号 (MySQL 反引号)', async () => {
  const db = fakeDb({ dialect: 'mysql' });
  const { reg } = envFor(makeAgent(db));
  await reg.call('look_at_data', { table: 'orders', column: 'ack_state' });
  assert.ok(db.queried.length, '应该真的查了');
  // 只看**取数**语句: 先去看表多大那一条是元数据查询, 表名在那里是**值**
  // (information_schema 的 TABLE_NAME = 'orders'), 加反引号反而是语法错误。
  const dataSql = db.queried.filter((sql) => !/information_schema\.TABLES/.test(sql));
  assert.ok(dataSql.length, '要有真正的取数语句');
  for (const sql of dataSql) {
    assert.match(sql, /`orders`/, 'MySQL 的表名要用反引号: ' + sql);
    assert.match(sql, /`ack_state`/, 'MySQL 的列名要用反引号: ' + sql);
    assert.strictEqual(/"/.test(sql), false, 'MySQL 上用双引号是语法错误: ' + sql);
  }
});

test('look_at_data: 换到 postgres 就换成双引号', async () => {
  const db = fakeDb({ dialect: 'postgres' });
  const { reg } = envFor(makeAgent(db));
  await reg.call('look_at_data', { table: 'orders', column: 'ack_state' });
  const dataSql = db.queried.filter((sql) => !/pg_class/.test(sql));
  assert.match(dataSql[0], /"orders"/);
  assert.strictEqual(/`/.test(dataSql[0]), false, 'postgres 不认反引号');
});

/* ============================================================
 * 3. check_index
 * ============================================================ */

test('check_index: MySQL 查 information_schema (SHOW INDEX 会被只读闸门拒掉)', async () => {
  const db = fakeDb({
    answer: (sql) => (/information_schema/.test(sql)
      ? { columns: ['index_name'], rows: [{ index_name: 'PRIMARY', column_name: 'id', non_unique: 0, seq: 1 }], rowCount: 1 }
      : null)
  });
  const { reg } = envFor(makeAgent(db));
  const out = await reg.call('check_index', { table: 'orders', column: 'id' });
  assert.match(db.queried[0], /information_schema\.STATISTICS/, '要走 information_schema');
  assert.strictEqual(/^\s*SHOW/i.test(db.queried[0]), false, 'SHOW 开头的语句过不了只读闸门');
  assert.match(out, /✓ id 有索引/);
});

test('check_index: 列没索引时明说会全表扫', async () => {
  const db = fakeDb({
    answer: (sql) => (/information_schema/.test(sql)
      ? { columns: ['index_name'], rows: [{ index_name: 'PRIMARY', column_name: 'id' }], rowCount: 1 }
      : null)
  });
  const { reg } = envFor(makeAgent(db));
  const out = await reg.call('check_index', { table: 'orders', column: 'name' });
  assert.match(out, /✗ name 没有索引/);
  assert.match(out, /全表扫/);
});

test('check_index: 没实现的方言要明说"还没做", 不能返回空', async () => {
  const { reg } = envFor(makeAgent(fakeDb({ dialect: 'sqlite' })));
  const out = await reg.call('check_index', { table: 'orders' });
  // 返回空会被上游翻译成"一个索引都没有" —— 那是假话, 只是没实现
  assert.match(out, /还没做|只支持/);
  assert.strictEqual(/一个索引都没有/.test(out), false, '不能把"没实现"说成"没有索引"');
});

test('check_index: 列名判断只看值, 不看键名 (回归: 叫 name 的列曾被永远判成"有索引")', async () => {
  // MySQL 的返回行键名就叫 column_name —— 它自带 "name" 子串。
  // 以前用 JSON.stringify(整行).includes(column) 判断, 于是任何叫 name 的列
  // 都会命中 "column_name" 这个键名, 被报成"有索引"。那是句假话。
  const db = fakeDb({
    answer: (sql) => (/information_schema/.test(sql)
      ? { columns: [], rows: [{ index_name: 'PRIMARY', column_name: 'id', non_unique: 0, seq: 1 }], rowCount: 1 }
      : null)
  });
  const { reg } = envFor(makeAgent(db));
  const out = await reg.call('check_index', { table: 'orders', column: 'name' });
  assert.match(out, /✗ name 没有索引/, '索引在 id 上, name 必须报"没有"');

  // 反向也要成立: id 确实有索引, 不能因为修 bug 修成永远说"没有"
  const out2 = await reg.call('check_index', { table: 'orders', column: 'id' });
  assert.match(out2, /✓ id 有索引/);
});

test('check_index: 键名里的 unique / seq 也不能造成误判', async () => {
  const db = fakeDb({
    answer: (sql) => (/information_schema/.test(sql)
      ? { columns: [], rows: [{ index_name: 'PRIMARY', column_name: 'id', non_unique: 0, seq: 1 }], rowCount: 1 }
      : null)
  });
  const { reg } = envFor(makeAgent(db));
  for (const col of ['unique', 'seq', 'index_name', 'column_name']) {
    const out = await reg.call('check_index', { table: 'orders', column: col });
    assert.match(out, new RegExp('✗ ' + col + ' 没有索引'), col + ' 不该被键名误判成有索引');
  }
});

/* ============================================================
 * 4. read_result
 * ============================================================ */

const stepsFixture = () => ([
  {
    kind: 'sql', purpose: '按供应商汇总', sql: 'SELECT 1',
    result: {
      columns: ['supplier', 'amount'],
      rows: Array.from({ length: 120 }, (_, i) => ({ supplier: 'S' + i, amount: i * 10 })),
      rowCount: 120
    }
  }
]);

test('read_result: 按编号把行读回来, 默认 50 行', async () => {
  const { reg } = envFor(makeAgent(fakeDb()), { steps: stepsFixture() });
  const out = await reg.call('read_result', { index: 1 });
  assert.match(out, /资料 \[1\]「按供应商汇总」共 120 行/);
  assert.match(out, /S0/);
  assert.match(out, /S49/, '默认 50 行应该含第 50 行');
  assert.strictEqual(/S50/.test(out), false, '默认不该超过 50 行');
});

test('read_result: offset/limit 能翻页', async () => {
  const { reg } = envFor(makeAgent(fakeDb()), { steps: stepsFixture() });
  const out = await reg.call('read_result', { index: 1, offset: 100, limit: 5 });
  assert.match(out, /第 100~104 行/);
  assert.match(out, /S100/);
  assert.match(out, /S104/);
  assert.strictEqual(/S99/.test(out), false);
});

test('read_result: limit 有上限, 不能一次把上下文撑爆', async () => {
  const { reg } = envFor(makeAgent(fakeDb()), { steps: stepsFixture() });
  const out = await reg.call('read_result', { index: 1, limit: 99999 });
  const dataRows = out.split('\n').length;
  assert.ok(dataRows <= 210, '最多 200 行数据 + 表头, 实际 ' + dataRows);
});

test('read_result: 编号不存在时告诉它现在有几份, 而不是干说一句错', async () => {
  const { reg } = envFor(makeAgent(fakeDb()), { steps: stepsFixture() });
  const out = await reg.call('read_result', { index: 7 });
  assert.match(out, /没有第 \[7\] 份资料/);
  assert.match(out, /\[1\] 按供应商汇总/, '要把现有的列出来, 让它知道该指哪个');
});

test('read_result: 编号从 1 开始, 0 和负数都要拦住', async () => {
  const { reg } = envFor(makeAgent(fakeDb()), { steps: stepsFixture() });
  assert.match(await reg.call('read_result', { index: 0 }), /从 1 开始/);
  assert.match(await reg.call('read_result', { index: -3 }), /从 1 开始/);
});

/* ============================================================
 * 5. 当前时间进了上下文
 * ============================================================ */

test('contextBlock 里有当前时间 —— 模型自己没有时钟', async () => {
  // contextBlock 是 run() 内部的闭包, 这里从它实际发给模型的系统提示里验
  const seen = [];
  const llm = {
    config: { apiKey: 'x' },
    _extractJSON: (t) => { try { return JSON.parse(t); } catch (e) { return null; } },
    async chat() { return 'analysis'; },
    async chatStep(messages) {
      seen.push(messages.map((m) => m.content).join('\n'));
      return { content: '（停）', toolCalls: [] };
    }
  };
  const agent = makeAgent(fakeDb(), llm);
  agent._classifyIntent = async () => ({ kind: 'analysis' });

  await agent.run('随便问问', { history: [], state: {
    tables: ['orders'],
    schemaMap: { orders: [{ field: 'id', type: 'int' }] },
    fieldsSelected: { orders: ['id'] }
  } }, () => {}, async () => ({ sql: '' }));

  const all = seen.join('\n');
  assert.match(all, /## 现在的时间/, '要有"现在的时间"这一节');

  const d = new Date();
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  assert.ok(all.includes(ymd), '要含今天的日期 ' + ymd + ' —— 不是训练期里的某个日期');

  // 光给日期还不够: 必须同时说"别把日期写死进 SQL", 否则明天的报表就错了
  assert.match(all, /CURDATE|NOW\(\)/, '要告诉它落 SQL 时用数据库函数');
});

/* ============================================================
 * 闸门提示词里也必须有时间
 *
 * 这一条来自一个真实故障: 用户问"现在是几点", 结果收到的是一条
 * `getaddrinfo ENOTFOUND oms-01.example.com`。
 *
 * 链路是: 闸门提示词里没有时间 -> 模型判不出这是能直接答的问题 ->
 * 归到"取数" -> 取数路径先去连库 -> 库连不上 -> 整轮失败。
 *
 * 闸门是**唯一一次**能回答这类问题的模型调用 (闲聊路径不碰数据库, 答完就结束),
 * 所以时间必须在这里就给到。
 * ============================================================ */

const Gate = require('../lib/gate.js');

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

test('闸门提示词里有当前时间 —— 否则"现在是几点"会被判成取数', () => {
  const p = Gate.buildGatePrompt(null, []);
  assert.match(p, /## 现在的时间/, '要有"现在的时间"这一节');
  assert.ok(p.includes(todayStr()), '要含今天的日期 ' + todayStr());
});

test('闸门提示词明确说"问时间的问题归闲聊, 不要为了查时间去连库"', () => {
  const p = Gate.buildGatePrompt(null, []);
  assert.match(p, /不要为了查时间去连数据库|不要为了查时间/, '要直接点明这个反模式');
  // 闲聊那一类里要举出"问时间"这个例子, 否则模型不一定想到
  assert.match(p, /现在几点|今天几号/, 'chat 那一类里要举时间的例子');
});

test('闸门提示词点明了"多走一遍取数只是慢一点"的前提', () => {
  const p = Gate.buildGatePrompt(null, []);
  // 原来那句偏置的理由是"多走一遍取数流程只是慢一点" ——
  // 但库连不上时它不是慢一点, 是直接失败。必须把这个前提写出来。
  assert.match(p, /连得上|连不上/, '要说明这个偏置依赖"数据库连得上"');
});

test('有流程卡时闸门提示词仍然带时间', () => {
  const p = Gate.buildGatePrompt(null, [{ id: 'e1', name: '卡一', nodes: [], inputs: [] }]);
  assert.ok(p.includes(todayStr()), '带流程卡的路径也要有时间');
});
