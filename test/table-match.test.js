'use strict';

/**
 * 选表匹配漏斗 (lib/table-match.js)。
 *
 * 这个文件钉住的是"准确率从哪来、速度靠什么守住"这两件事:
 *
 *   准确率:
 *     1) 需求里的单号要被认出来, 并且**真的**被拿去表里试 (值探测)
 *     2) 探测只试"像单号的列", 大表只试带索引的列 —— 否则一列全表扫就把任务卡死
 *     3) 超时/没试成的表要进 untried, **不许**被算成"没命中"
 *        (把"我没查完"说成"没有", 是这个产品最不能犯的错)
 *     4) 提示词要带上列注释, 并且不再写"宁少勿多 / 只挑 1 张是正常结果"
 *
 *   速度:
 *     5) 详细候选封顶 + 其余只给表名 —— 提示词规模与旧版同量级
 *     6) 探测并发且有硬预算, 条数有上限
 *     7) 拿不到字段目录时**降级**而不是失败 (退回旧行为, 不是报错)
 */

const test = require('node:test');
const assert = require('node:assert');

const TM = require('../lib/table-match.js');

/* ============================================================
 * 1. 值提取
 * ============================================================ */

test('值提取: 认得出 D3 开头的付款单号、PO 单号、纯长数字与引号里的值', () => {
  const task = '"D32026092200853340", "D32026092200853360" 帮我查一下付款单选票的付款单表，有没有这些数据，全字段导出。';
  assert.deepStrictEqual(TM.extractValues(task), ['D32026092200853340', 'D32026092200853360']);

  const more = TM.extractValues('查 DN2023012900006 和 PO202508121092555，流水号 17893731586874737');
  assert.ok(more.includes('DN2023012900006'));
  assert.ok(more.includes('PO202508121092555'));
  assert.ok(more.includes('17893731586874737'));
});

test('值提取: 纯中文、没有数字的词一律不当成值 (免得白扫一遍表)', () => {
  assert.deepStrictEqual(TM.extractValues('查一下付款单选票的付款单表'), []);
  assert.deepStrictEqual(TM.extractValues('统计近 30 天每天的订单数量'), [], '短数字不是单号');
  assert.deepStrictEqual(TM.extractValues(''), []);
  assert.deepStrictEqual(TM.extractValues(null), []);
});

test('值提取: 去重且封顶, 顺序稳定', () => {
  const v = TM.extractValues('A12345678 A12345678 B12345678 C12345678 D12345678 E12345678 F12345678 G12345678 H12345678 I12345678 J12345678');
  assert.strictEqual(new Set(v).size, v.length, '不许有重复');
  assert.ok(v.length <= 8, '封顶 8 个 —— 探测条数是拿速度换来的');
  assert.strictEqual(v[0], 'A12345678');
});

/* ============================================================
 * 2. 词法预筛: 压小清单, 但不许把沾边的表压没
 * ============================================================ */

const DIGEST = new Map(Object.entries({
  payment_select_bill_payment: {
    table: 'payment_select_bill_payment', dbName: 'DSC请款库', rows: 1838,
    comment: '选票-付款单关联表',
    cols: [
      { field: 'id', type: 'bigint', comment: '主键 ID', indexed: true },
      { field: 'select_id', type: 'bigint', comment: '选票批次 ID,外键 → payment_select_bill.id', indexed: true },
      { field: 'doc_num', type: 'varchar', comment: '单据编号 付款单号', indexed: false },
      { field: 'po_order_no', type: 'varchar', comment: 'PO 订单号', indexed: false }
    ]
  },
  finance_payment_order_bill_callback: {
    table: 'finance_payment_order_bill_callback', dbName: 'DSC请款库', rows: 48422,
    comment: '付款单数据和票据信息回调-付款单选票表',
    cols: [
      { field: 'batch_no', type: 'varchar', comment: '批次号', indexed: false },
      { field: 'doc_num', type: 'varchar', comment: '付款单单据编号', indexed: false },
      { field: 'bill_no', type: 'varchar', comment: '票据号', indexed: false }
    ]
  },
  // 这张表的说明跟"付款单"一点关系都没有 —— 它只可能靠**实测命中**被选进来
  bip_pass_log: {
    table: 'bip_pass_log', dbName: 'DSC请款库', rows: 7600000,
    comment: '业务日志表',
    cols: [
      { field: 'doc_no', type: 'varchar', comment: '单据编号', indexed: true },
      { field: 'payload', type: 'text', comment: '报文', indexed: false }
    ]
  }
}));
// 一堆跟需求毫不相干的表: 用来把"详细候选"的封顶真正撑满,
// 好验证"没进详细段的表仍然以表名形式出现"(召回不塌)。
for (let i = 0; i < 40; i++) {
  const name = `zz_noise_${String(i).padStart(2, '0')}`;
  DIGEST.set(name, {
    table: name, dbName: 'DSC请款库', rows: 10, comment: '无关表',
    cols: [{ field: 'company', type: 'varchar', comment: '公司', indexed: false }]
  });
}
const NOTE_OF = {};
const ALL = Array.from(DIGEST.keys());

test('词法预筛: 沾边的进详细段, 不沾边的退成"只有表名" (召回还在, 但提示词不膨胀)', () => {
  const terms = TM.tokenize('帮我查一下付款单选票的付款单表，有没有这些数据');
  const pre = TM.splitCandidates({ candidates: ALL, digest: DIGEST, noteOf: NOTE_OF, terms, detailLimit: 5 });
  const detailNames = pre.detail.map((r) => r.name);
  assert.ok(pre.detail.length <= 5, '详细段是上限, 不许被无关表填满');
  assert.ok(detailNames.includes('payment_select_bill_payment'), '名字+注释都沾边的必须进详细段');
  assert.ok(detailNames.includes('finance_payment_order_bill_callback'), '注释里"付款单选票"逐字命中的也要进');
  assert.strictEqual(detailNames.includes('bip_pass_log'), false,
    '零分表不该占详细段 —— 那只是白占上下文');
  assert.strictEqual(pre.rest.length, ALL.length - pre.detail.length, '其余的表退成名字, 但**没有被丢掉**');
  assert.ok(pre.rest.includes('bip_pass_log'), '跟需求不沾边的表也要留在名字清单里');
  assert.ok(pre.rest.includes('zz_noise_00'), '40 张无关表一张都不能少');
});

test('词法预筛: 详细段封顶, 且封顶时按相关度留下最像的', () => {
  const terms = TM.tokenize('付款单');
  const pre = TM.splitCandidates({ candidates: ALL, digest: DIGEST, noteOf: NOTE_OF, terms, detailLimit: 2 });
  assert.strictEqual(pre.detail.length, 2);
  assert.ok(pre.detail.every((r) => /payment|bill/.test(r.name)), '留下来的应该是真沾边的: ' + pre.detail.map((r) => r.name));
});

test('词法预筛: 探测命中的表一定进详细段 (哪怕它跟需求字面上不沾边)', () => {
  const terms = TM.tokenize('查这两个号');
  const pre = TM.splitCandidates({
    candidates: ALL, digest: DIGEST, noteOf: NOTE_OF, terms,
    hitTables: ['bip_pass_log'], detailLimit: 5
  });
  assert.ok(pre.detail.some((r) => r.name === 'bip_pass_log'),
    '实测命中是硬证据, 不能因为"描述对不上"就被排除在外');
});

/* ============================================================
 * 3. 探测: 挑列与写 SQL
 * ============================================================ */

test('探测选列: 只挑像单号的**字符串**列, 带索引的排在前面', () => {
  const cols = TM.probeColumns(DIGEST.get('payment_select_bill_payment'));
  assert.ok(cols.includes('doc_num'), 'doc_num (注释写着"付款单号") 必须入选');
  assert.ok(cols.includes('po_order_no'), 'PO 订单号也是单号列');
  assert.strictEqual(cols.includes('select_id'), false,
    'bigint 列不试: 拿字符串单号去比数字 ID 只会得到假的"没命中"');
  assert.strictEqual(cols[0], 'doc_num', '注释 + 名字都命中, 排第一');
});

test('探测选列: 大表只试带索引的列 —— 没索引的列在全表扫, 那不是慢, 是卡死', () => {
  const bigEntry = {
    table: 'huge', rows: 7600000,
    cols: [
      { field: 'doc_num', type: 'varchar', comment: '付款单号', indexed: false },
      { field: 'serial_num', type: 'varchar', comment: '序号', indexed: true }
    ]
  };
  assert.deepStrictEqual(TM.probeColumns(bigEntry, { onlyIndexed: true }), ['serial_num']);
  const all = TM.probeColumns(bigEntry, { onlyIndexed: false });
  assert.ok(all.includes('doc_num'), '小表/不设限时两种都试');
});

test('探测 SQL: 值一律转义, 不拼裸字符串 (值是用户话里来的)', () => {
  const sql = TM.probeSql({ table: 't', column: 'c', value: "a'b", dialect: 'mysql' });
  assert.ok(sql.includes("'a''b'"), '单引号要翻倍: ' + sql);
  assert.ok(sql.startsWith('SELECT 1 AS hit FROM `t` WHERE `c` ='));
  assert.ok(sql.endsWith('LIMIT 1'));

  const ms = TM.probeSql({ table: 't', column: 'c', value: 'x', dialect: 'mssql' });
  assert.ok(ms.startsWith('SELECT TOP 1 1 AS hit FROM [t] WHERE [c] ='));
  assert.ok(!ms.includes('LIMIT'), 'SQL Server 没有 LIMIT');
});

/* ============================================================
 * 4. 探测执行: 并发、预算、以及"没试成 ≠ 没命中"
 * ============================================================ */

/** 假路由器: 记录所有发出去的 SQL, 按表名决定命中与否 */
function fakeRouter({ hits = [], slow = [], dialect = 'mysql', fail = [] } = {}) {
  const seen = [];
  return {
    seen,
    targetFor() { return { dialect }; },
    async query(sql, opts) {
      seen.push({ sql, opts });
      const t = /FROM\s+([A-Za-z0-9_]+)/.exec(sql.replace(/[`\[\]]/g, ''))[1];
      if (fail.includes(t)) throw new Error('boom');
      if (slow.includes(t)) await new Promise((r) => setTimeout(r, 5000));
      return { rows: hits.includes(t) ? [{ hit: 1 }] : [] };
    }
  };
}

test('探测: 命中的表进 hits, 试过没命中的列进 missedCols', async () => {
  const router = fakeRouter({ hits: ['payment_select_bill_payment'] });
  const p = await TM.runProbes({
    router, digest: DIGEST,
    tables: ['payment_select_bill_payment', 'finance_payment_order_bill_callback'],
    values: ['D32026092200853340'], budgetMs: 2000, maxQueries: 8
  });
  assert.deepStrictEqual(Array.from(new Set(p.hits.map((h) => h.table))), ['payment_select_bill_payment']);
  assert.ok(p.hits.every((h) => h.value === 'D32026092200853340'), '命中要带上是哪个值命中的');
  assert.ok(p.missedCols.some((m) => m.table === 'finance_payment_order_bill_callback'),
    '没命中的要落到**列**上: ' + JSON.stringify(p.missedCols));
  assert.ok(router.seen.length >= 2, '两张表都要真的被查过');
  assert.ok(router.seen.every((s) => s.opts && s.opts.timeoutMs === 2000),
    '探测查询必须带超时 —— 这是它敢去碰大表的前提');
});

test('探测: 超预算没回来的表进 untried, **不许**算成"没命中"', async () => {
  const router = fakeRouter({ hits: [], slow: ['finance_payment_order_bill_callback'] });
  const p = await TM.runProbes({
    router, digest: DIGEST,
    tables: ['payment_select_bill_payment', 'finance_payment_order_bill_callback'],
    values: ['D32026092200853340'], budgetMs: 300, maxQueries: 8
  });
  assert.ok(p.degraded.includes('预算'), '超预算要说出来: ' + p.degraded);
  assert.deepStrictEqual(p.hits, []);
  assert.ok(p.untried.some((u) => u.table === 'finance_payment_order_bill_callback'),
    '没查完的表必须在 untried 里, 不能进 misses');
});

test('探测: 单次查询报错不炸掉整轮, 记进 errors', async () => {
  const router = fakeRouter({ fail: ['payment_select_bill_payment'] });
  const p = await TM.runProbes({
    router, digest: DIGEST, tables: ['payment_select_bill_payment'],
    values: ['D32026092200853340'], budgetMs: 2000, maxQueries: 4
  });
  assert.strictEqual(p.hits.length, 0);
  assert.ok(p.errors.length >= 1, '报错要留痕');
  assert.ok(p.errors[0].error.includes('boom'));
});

test('探测: 没有单号 / 没有字段目录 / 数据源不支持, 一律安静退化', async () => {
  const none = await TM.runProbes({ router: fakeRouter(), digest: DIGEST, tables: ALL, values: [], budgetMs: 100 });
  assert.deepStrictEqual(none.hits, []);
  assert.strictEqual(none.tried, 0);

  const noRouter = await TM.runProbes({ router: null, digest: DIGEST, tables: ALL, values: ['D32026092200853340'], budgetMs: 100 });
  assert.ok(noRouter.degraded.includes('不支持'));

  const noCols = await TM.runProbes({
    router: fakeRouter(), digest: new Map(), tables: ALL, values: ['D32026092200853340'], budgetMs: 100
  });
  assert.strictEqual(noCols.tried, 0);
  assert.ok(noCols.untried.length > 0, '没有列信息 = 没试成, 要说清楚');
});

test('探测: 查询条数有硬上限 (并发不等于无限打库)', async () => {
  const router = fakeRouter({});
  const tables = Array.from({ length: 40 }, (_, i) => `t_${i}`);
  const digest = new Map(tables.map((t) => [t, {
    table: t, rows: 10,
    cols: [{ field: 'doc_num', type: 'varchar', comment: '付款单号', indexed: false }]
  }]));
  const p = await TM.runProbes({
    router, digest, tables, values: ['D32026092200853340', 'D32026092200853360'],
    budgetMs: 2000, maxQueries: 6
  });
  assert.strictEqual(router.seen.length, 6, '最多 6 条, 实际发了 ' + router.seen.length);
  assert.strictEqual(p.tried, 6);
});

/* ============================================================
 * 5. 提示词: 列注释进去了, 且不再教它"只挑一张"
 * ============================================================ */

test('提示词: 带列注释 + 实测结果, 并且明确要它说"我不确定什么"', () => {
  const terms = TM.tokenize('查付款单选票的付款单表有没有这些数据');
  const pre = TM.splitCandidates({ candidates: ALL, digest: DIGEST, noteOf: NOTE_OF, terms, detailLimit: 5 });
  const probes = {
    values: ['D32026092200853340'], hits: [{ table: 'payment_select_bill_payment', column: 'doc_num', value: 'D32026092200853340' }],
    misses: ['finance_payment_order_bill_callback'], untried: [], errors: [], tried: 4, elapsedMs: 12, degraded: ''
  };
  const prompt = TM.buildMatchPrompt({ task: '查付款单选票的付款单表有没有这些数据', detail: pre.detail, rest: pre.rest, probes });

  assert.match(prompt, /doc_num -- 单据编号 付款单号/, '列注释必须进去 —— 这是"哪一列装的是那个号"的唯一依据');
  assert.match(prompt, /命中: payment_select_bill_payment\.doc_num/, '实测命中要摆进提示词');
  assert.match(prompt, /uncertain/, '要它说出自己没法确认的地方');
  assert.strictEqual(/宁少勿多/.test(prompt), false, '不许再教它"只挑最少的"');
  assert.strictEqual(/只挑出 1 张是正常结果/.test(prompt), false, '这句话会让它在该 JOIN 三张表的需求上只挑一张');
  assert.match(prompt, /来自人工备注或数据库注释/, '说明来源那句要留着 (界面上也是这么解释的)');
  assert.match(prompt, /其余可访问的表[\s\S]*zz_noise_00/, '没进详细段的表也要给表名, 召回不能塌');
  assert.strictEqual(prompt.includes('未纳入'), false, '这一版不该出现旧提示词里的措辞');
});

test('提示词: 全未命中时明说"不要换张名字像的表硬凑", 且没验过的列不许当"没有"', () => {
  const terms = TM.tokenize('查付款单');
  const pre = TM.splitCandidates({ candidates: ALL, digest: DIGEST, noteOf: NOTE_OF, terms, detailLimit: 3 });
  const probes = {
    values: ['D32026092200853340'], hits: [], misses: ['payment_select_bill_payment'],
    untried: [{ table: 'bip_pass_log', column: 'doc_no', why: '表太大且该列没索引, 没试' }],
    errors: [], tried: 2, elapsedMs: 5, degraded: ''
  };
  const prompt = TM.buildMatchPrompt({
    task: '查付款单', detail: pre.detail, rest: pre.rest, probes,
    untriedCols: [{ table: 'bip_pass_log', column: 'doc_no', comment: '单据编号', why: '表太大且该列没索引, 没试' }]
  });
  assert.match(prompt, /不要换一张名字像的表硬凑/);
  assert.match(prompt, /bip_pass_log\.doc_no \(注释: 单据编号\) \[表太大且该列没索引, 没试\]/,
    '没验过的列要带列名 + 注释说出来 —— 否则"没有数据"这句结论比实际可信');
  assert.match(prompt, /而"没验过的列"是不知道/,
    '必须区分"查过没有"和"没查过": 前者是结论, 后者是不知道');
  assert.match(prompt, /表名不可靠/, '实测: 它会照着英文表名里有没有 payment 挑, 必须明确压住这个偏向');
});

test('探测调度: 广度优先 —— 同样的条数预算要覆盖更多张表', async () => {
  // 深度优先 (一张表试完再下一张) 会让 16 条预算全被前 3~4 张表吃掉。
  // 值探测要回答的是"哪张表装着这个号", 所以广度比单表多试一列重要得多。
  const router = fakeRouter({});
  const tables = Array.from({ length: 10 }, (_, i) => `t_${String(i).padStart(2, '0')}`);
  const digest = new Map(tables.map((t) => [t, {
    table: t, rows: 100, comment: '',
    cols: [
      { field: 'doc_num', type: 'varchar', comment: '付款单号', indexed: false },
      { field: 'bill_no', type: 'varchar', comment: '票据号', indexed: false }
    ]
  }]));
  const p = await TM.runProbes({
    router, digest, tables, values: ['D32026092200853340', 'D32026092200853360'],
    budgetMs: 3000, maxQueries: 12
  });
  const touched = new Set(router.seen.map((s) => s.sql.match(/FROM `([^`]+)`/)[1]));
  assert.strictEqual(p.tried, 12);
  assert.strictEqual(touched.size, 10, '12 条预算先给 10 张表各发一条, 实际覆盖 ' + touched.size);
  // 第一轮: 每张表的第一条 —— 10 张表都该先各来一条
  const first = router.seen.slice(0, 10);
  assert.strictEqual(new Set(first.map((s) => s.sql.match(/FROM `([^`]+)`/)[1])).size, 10);
});

test('探测: 大表上没索引的像单号列 -> 记进 untried 带列名, 且不算"试过没命中"', async () => {
  // DSC 那次的真表就是这样: 763 万行、invoice 列写着"请款单"、没索引。
  // 它必须出现在 untried 里 (带列名), 而**不能**出现在 misses 里 ——
  // 把"我没查"说成"查了没有"是这个产品最不能犯的错。
  const router = fakeRouter({});
  const digest = new Map([['huge', {
    table: 'huge', rows: 7600000, comment: 'bip返回的付款单状态',
    cols: [
      { field: 'payment_document_id', type: 'varchar', comment: '请款明细唯一ID', indexed: true },
      { field: 'invoice', type: 'varchar', comment: '请款单', indexed: false }
    ]
  }]]);
  const p = await TM.runProbes({ router, digest, tables: ['huge'], values: ['D32026092200853340'], budgetMs: 2000, maxQueries: 4 });
  const un = p.untried.find((u) => u.column === 'invoice');
  assert.ok(un, '没验过的列要在 untried 里: ' + JSON.stringify(p.untried));
  assert.match(un.why, /没索引/);
  assert.strictEqual(p.misses.includes('huge'), false, '"我没查"不能说成"查了没有"');
  assert.strictEqual(p.tried, 1, '只试了带索引的那一列');
});

test('提示词: 只让它写一份清单 (同一张表不写两遍) —— 实测这是那 124 秒的主要来源', () => {
  const terms = TM.tokenize('查付款单');
  const pre = TM.splitCandidates({ candidates: ALL, digest: DIGEST, noteOf: NOTE_OF, terms, detailLimit: 3 });
  const prompt = TM.buildMatchPrompt({ task: '查付款单', detail: pre.detail, rest: pre.rest, probes: null });
  assert.match(prompt, /"tables":\[\{"name":"","why":/);
  assert.strictEqual(/"candidates"/.test(prompt), false, '旧的 candidates + need 双份形状要拿掉');
  assert.strictEqual(/"need":\[\{/.test(prompt), false, '同上');
});

/* ============================================================
 * 6. 解析: 三种形状都认 (换回旧提示词也不能整条路失效)
 * ============================================================ */

test('解析: need 与 candidates 合并, need 在前, 但 picked 只取必需的那批', () => {
  const r = TM.parseMatch(JSON.stringify({
    candidates: [{ name: 'a', score: 0.5, why: '字面沾边' }, { name: 'b', score: 0.9 }],
    need: [{ name: 'b', score: 0.9, reason: '必需' }],
    uncertain: '不知道哪个列是单号'
  }));
  assert.deepStrictEqual(r.scored.map((s) => s.name), ['b', 'a']);
  assert.deepStrictEqual(r.picked, ['b'],
    'picked 不取"候选"那批 —— 实测里它正是这么把 scope 撑到 11 张表的');
  assert.strictEqual(r.uncertain, '不知道哪个列是单号');
  assert.strictEqual(r.scored[0].reason, '必需');
});

test('解析: 主形状 tables[] + need 标记', () => {
  const r = TM.parseMatch({
    tables: [
      { name: 'a', why: '名字像', score: 0.9, need: true },
      { name: 'b', why: '顺手带上', score: 0.5, need: false },
      { name: 'c', why: '要用', score: 0.7, need: true }
    ],
    uncertain: '不确定哪个列'
  });
  assert.deepStrictEqual(r.picked, ['a', 'c']);
  assert.deepStrictEqual(r.scored.map((s) => s.name), ['a', 'b', 'c'], 'scored 保留全部, 弹窗还要拿它做推荐');
});

test('解析: 主形状 tables[] 里一张都没标 need -> 一个都不算必需 (堵住"不表态=全选")', () => {
  const r = TM.parseMatch({ tables: [{ name: 'a', score: 0.9 }, { name: 'b', score: 0.5 }] });
  assert.deepStrictEqual(r.picked, [], '没标 need 就不当必需 (以前是"整份算必需", 撑大 scope)');
  assert.deepStrictEqual(r.scored.map((s) => s.name), ['a', 'b'], '但 scored 仍保留全部, 弹窗拿它做推荐');
});

test('解析: 老形状 (candidates) 一张都没标 need -> 仍全算必需 (向后兼容)', () => {
  assert.deepStrictEqual(TM.parseMatch({ candidates: [{ name: 'a' }] }).picked, ['a']);
});

test('解析: 旧的 scored 形状仍然认 (向后兼容)', () => {
  const r = TM.parseMatch('{"scored":[{"name":"t_a","score":0.95,"reason":"直接匹配"}]}');
  assert.deepStrictEqual(r.scored, [{ name: 't_a', score: 0.95, reason: '直接匹配', need: true }]);
  assert.deepStrictEqual(r.picked, ['t_a']);
});

test('解析: 坏 JSON / 空对象一律不炸, 返回空', () => {
  assert.deepStrictEqual(TM.parseMatch('not json').scored, []);
  assert.deepStrictEqual(TM.parseMatch('not json').picked, []);
  assert.deepStrictEqual(TM.parseMatch(null).scored, []);
  assert.deepStrictEqual(TM.parseMatch('{}').scored, []);
  assert.deepStrictEqual(TM.parseMatch('{"need":["a"]}').scored, [{ name: 'a', score: 0.5, reason: '', need: true }],
    '字符串数组也要兜住');
});

test('没能验证的列: 按"有多像一个装单号的列"排序, 噪声列不许挤掉真正的候选', async () => {
  // DSC 实测: 像单号的列有 69 条, 不排序的话前 8 条全是 create_user_code /
  // update_user_code 这种"名字里恰好有个 code"的列, 而真表那一列
  // (注释写着"请款单")反而看不见 —— 那这条提示就等于没给。
  const router = fakeRouter({});
  const digest = new Map([['t', {
    table: 't', rows: 7600000, comment: 'bip返回的付款单状态',
    cols: [
      { field: 'create_user_code', type: 'varchar', comment: '创建人工号', indexed: false },
      { field: 'update_user_code', type: 'varchar', comment: '更新人工号', indexed: false },
      { field: 'invoice', type: 'varchar', comment: '请款单', indexed: false },
      { field: 'payment_document_id', type: 'varchar', comment: '请款明细唯一ID', indexed: true }
    ]
  }]]);
  router.schemaDigest = async () => digest;
  const out = await TM.matchTables({
    llm: { async chat() { return '{"tables":[]}'; }, _extractJSON(raw) { return JSON.parse(raw); } },
    router, task: '查 D32026092200853340 有没有', candidates: ['t'], noteOf: {},
    opts: { probeBudgetMs: 500, detailLimit: 5 }
  });
  assert.strictEqual((out.untriedCols[0] || {}).column, 'invoice',
    '注释写着"请款单"的那一列必须排第一: ' + JSON.stringify(out.untriedCols));
  assert.strictEqual(out.untriedCols[0].comment, '请款单');
  assert.ok(!out.untriedCols.slice(0, 1).some((u) => /user_code/.test(u.column)),
    '工号列不许排在前面');
});

/* ============================================================
 * 7. 端到端: 漏斗把实测命中的表并进结果
 * ============================================================ */

test('matchTables: 模型判断 ∪ 实测命中 —— 说明对不上但实测命中的表也进 picked', async () => {
  const router = fakeRouter({ hits: ['bip_pass_log'] });
  router.schemaDigest = async () => DIGEST;
  const llm = {
    async chat() {
      return JSON.stringify({
        candidates: [{ name: 'finance_payment_order_bill_callback', score: 0.9, why: '注释逐字命中' }],
        need: [{ name: 'finance_payment_order_bill_callback', score: 0.9, reason: '注释逐字命中' }],
        uncertain: '不确定哪个列装的是这个号'
      });
    },
    _extractJSON(raw) { return JSON.parse(raw); }
  };
  const out = await TM.matchTables({
    llm, router, task: '查 D32026092200853340 在不在付款单选票的付款单表里', candidates: ALL, noteOf: NOTE_OF,
    opts: { probeBudgetMs: 2000 }
  });
  assert.ok(out.picked.includes('finance_payment_order_bill_callback'), '模型挑的要在');
  assert.ok(out.picked.includes('bip_pass_log'),
    '实测命中的也要在 —— 它的说明跟"付款单"毫无字面关系, 只有数据能把它捞出来');
  assert.strictEqual(out.uncertain, '不确定哪个列装的是这个号');
  assert.ok(out.probes.hits.length >= 1, '命中记录要带出去给界面看');
  assert.ok(out.timing.total >= 0);
});

test('matchTables: 没有字段目录时降级, 但仍然出结果 (不许把选表整个搞挂)', async () => {
  const router = {
    targetFor() { return { dialect: 'mysql' }; },
    async schemaDigest() { throw new Error('连不上'); },
    async query() { return { rows: [] }; }
  };
  const llm = {
    async chat() { return '{"need":[{"name":"payment_select_bill_payment","score":0.8,"reason":"名字像"}]}'; },
    _extractJSON(raw) { return JSON.parse(raw); }
  };
  const out = await TM.matchTables({
    llm, router, task: '查付款单', candidates: ALL, noteOf: NOTE_OF, opts: { probeBudgetMs: 200 }
  });
  assert.deepStrictEqual(out.picked, ['payment_select_bill_payment']);
  assert.ok(out.degraded.some((d) => d.includes('字段目录')), '降级要说出来: ' + out.degraded.join(' / '));
});

test('matchTables: 降级说明里要带上**原因** (否则用户不知道是网络断了还是库不支持)', async () => {
  // "目录为空" 用户没法处理; "DSC请款库: ETIMEDOUT connect ETIMEDOUT" 他能立刻想到 VPN。
  // 而且这条降级等于整条新链路失效 (不探测、不带列注释), 必须让他看得见、看得懂。
  const router = {
    targetFor() { return { dialect: 'mysql' }; },
    lastDigestErrors: [{ dbName: 'DSC请款库', error: 'ETIMEDOUT connect ETIMEDOUT' }],
    async schemaDigest() { return new Map(); },
    async query() { return { rows: [] }; }
  };
  const llm = {
    async chat() { return '{"tables":[]}'; },
    _extractJSON(raw) { return JSON.parse(raw); }
  };
  const out = await TM.matchTables({
    llm, router, task: '查付款单', candidates: ALL, noteOf: NOTE_OF, opts: { probeBudgetMs: 200 }
  });
  const msg = out.degraded.join(' / ');
  assert.match(msg, /DSC请款库/);
  assert.match(msg, /ETIMEDOUT/);
  assert.strictEqual(out.probes, null, '没有目录就不该假装探测过');
});

test('matchTables: 走 chatStep 时记下真实 token 用量, 被截断要如实说出来', async () => {
  // 为什么必须走 chatStep: chat() 只回一段字符串。
  //   - 拿不到 usage -> "这次为什么慢"永远查不了 (实测这条调用 30~70 秒, 全在模型思考上)
  //   - 拿不到 truncated -> 配额用尽时半截 JSON 会被当成"模型没给推荐", 静默退回手动选表
  const router = fakeRouter({});
  router.schemaDigest = async () => DIGEST;
  const llm = {
    async chat() { throw new Error('不该走到这里'); },
    async chatStep() {
      return {
        content: JSON.stringify({ tables: [{ name: 'payment_select_bill_payment', why: '注释逐字命中', score: 0.9, need: true }] }),
        usage: { input: 4665, output: 3227 }, truncated: false, finishReason: 'stop'
      };
    },
    _extractJSON(raw) { return JSON.parse(raw); }
  };
  const out = await TM.matchTables({
    llm, router, task: '查付款单', candidates: ALL, noteOf: NOTE_OF, opts: { probeBudgetMs: 200 }
  });
  assert.deepStrictEqual(out.timing.tokens, { in: 4665, out: 3227 }, '用量要记下来, 不然"慢"无法归因');
  assert.deepStrictEqual(out.picked, ['payment_select_bill_payment']);
  assert.ok(!out.degraded.some((d) => d.includes('截断')), '没截断就不该报截断');
});

test('matchTables: 被截断时明确降级, 不假装这份清单是完整的', async () => {
  const router = fakeRouter({});
  router.schemaDigest = async () => DIGEST;
  const llm = {
    async chat() { throw new Error('不该走到这里'); },
    async chatStep() {
      // 半截 JSON: 真实场景里正文会在中途断掉
      return { content: '{"tables":[{"name":"payment_select_bill_payment","why":"注', usage: { input: 4665, output: 8192 }, truncated: true, finishReason: 'length' };
    },
    _extractJSON(raw) { try { return JSON.parse(raw); } catch (e) { return null; } }
  };
  const out = await TM.matchTables({
    llm, router, task: '查付款单', candidates: ALL, noteOf: NOTE_OF, opts: { probeBudgetMs: 200 }
  });
  assert.ok(out.degraded.some((d) => d.includes('截断')), '必须说出来: ' + out.degraded.join(' / '));
});

test('详细段砍到 12 张: 证据(探测结果)不依赖详细段长度 —— 砍的是时间, 不是准确率', async () => {
  // 实测依据: 详细段 30 -> 12 张, 提示词 13174 -> 9033 字符, 模型思考中位 8780 -> 5578 tok,
  // 墙上时间中位 58.0s -> 37.4s (省 36%)。而证据来自 probePlan + untried 清单, 与详细段无关。
  // 这条测试钉住这个前提: 砍完之后, 被探测过的表仍然出现在实测段落里。
  const router = fakeRouter({});
  router.schemaDigest = async () => DIGEST;
  let captured = '';
  const llm = {
    async chat(messages) {
      captured = messages[0].content;
      return '{"tables":[]}';
    },
    _extractJSON(raw) { return JSON.parse(raw); }
  };
  const out = await TM.matchTables({
    llm, router, task: '查 D32026092200853340 在不在付款单表里', candidates: ALL, noteOf: NOTE_OF,
    opts: { probeBudgetMs: 300, detailLimit: 12 }
  });
  assert.ok(captured.length > 0);
  // 探测过的表(试过/没验过)必须在实测段落里有名有列
  const probed = new Set([
    ...out.probes.missedCols.map((m) => m.table),
    ...out.probes.untried.filter((u) => u.column).map((u) => u.table)
  ]);
  assert.ok(probed.size > 0, '这一组桩数据里应该有被探测过的表');
  const evidenceBlock = captured.slice(captured.indexOf('## 已经拿这些值试过的结果'));
  for (const t of probed) {
    assert.ok(evidenceBlock.includes(t), `被探测过的表 ${t} 必须出现在实测段落里`);
  }
});

test('matchTables: 模型调用失败也不抛, 退回"没有推荐"让界面走手动', async () => {
  const router = fakeRouter({});
  router.schemaDigest = async () => DIGEST;
  const llm = { async chat() { throw new Error('网关 502'); }, _extractJSON(r) { return JSON.parse(r); } };
  const out = await TM.matchTables({ llm, router, task: '查付款单', candidates: ALL, noteOf: NOTE_OF, opts: { probeBudgetMs: 200 } });
  assert.deepStrictEqual(out.scored, []);
  assert.ok(out.degraded.some((d) => d.includes('模型调用失败')));
});
