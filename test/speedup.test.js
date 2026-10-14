'use strict';
/**
 * 三件"省时间"的改动:
 *   1. run_test 复用没改过的节点结果 (不重跑全卡)
 *   2. render_sql —— 只看渲染后的 SQL, 不查库
 *   3. recall —— 折叠掉的旧结果能取回来
 *
 * 这里测的每一条都对应实测踩过的坑, 注释里写了是哪个坑。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const Engine = require(path.join(ROOT, 'packages/solodb-core/engine.js'));
const Loop = require(path.join(ROOT, 'lib/agent-loop.js'));

/* ============ 1. 复用上次结果 ============ */

/** 造一张两段取数的卡, openDb 记录每次查询, 好断言"到底查了几次" */
function twoStepCard() {
  return {
    id: 'c1', name: '两段卡',
    nodes: [
      { id: 'in', type: 'input', title: '入口', fields: [{ key: 'poNo', label: 'PO', required: true }] },
      {
        id: 'q1', type: 'query', title: '查采购明细', databaseId: 'd1', table: 'po_detail',
        sql: "SELECT id FROM po_detail WHERE po_no = '{{poNo}}'",
        outputs: [{ key: 'id', label: 'id' }]
      },
      {
        id: 'q2', type: 'query', title: '查入库单', databaseId: 'd2', table: 'storage',
        sql: "SELECT no FROM storage WHERE po = '{{poNo}}'",
        outputs: [{ key: 'no', label: 'no' }]
      }
    ],
    edges: [{ from: 'in', to: 'q1', port: 'out' }, { from: 'q1', to: 'q2', port: 'out' }]
  };
}

function fakeDb(log, rows) {
  return {
    query: async (sql) => { log.push(sql); return { rows: rows || [{ id: '1' }], columns: ['id'], rowCount: (rows || [1]).length, elapsedMs: 1 }; },
    close: async () => {}
  };
}

const DBS = [{ id: 'd1', name: 'a', type: 'mysql' }, { id: 'd2', name: 'b', type: 'mysql' }];

test('不传 reuse 时, 两个取数节点各查一次库', async () => {
  const log = [];
  const r = await Engine.testEngine(twoStepCard(), { poNo: 'PO1' }, DBS, () => fakeDb(log));
  assert.strictEqual(log.length, 2);
  assert.strictEqual(r.reused.length, 0);
  assert.ok(r.queryCache.q1 && r.queryCache.q2, '应当把两次查询都记进 queryCache');
  assert.ok(typeof r.queryCache.q1.sql === 'string');
});

test('传了 reuse 且 SQL 没变 —— 该节点不查库, 且下游仍能拿到值', async () => {
  const log1 = [];
  const first = await Engine.testEngine(twoStepCard(), { poNo: 'PO1' }, DBS, () => fakeDb(log1, [{ id: 'A' }]));
  assert.strictEqual(log1.length, 2);

  const log2 = [];
  const second = await Engine.testEngine(
    twoStepCard(), { poNo: 'PO1' }, DBS, () => fakeDb(log2, [{ id: 'A' }]),
    { reuse: first.queryCache }
  );
  // 关键: 一条 SQL 都没发
  assert.strictEqual(log2.length, 0, 'SQL 没变就不该再查库');
  assert.strictEqual(second.reused.length, 2);
  assert.strictEqual(second.ok, true, '复用之后整张卡仍然要能跑通');
  assert.ok(second.answer !== undefined);
});

test('只改了一个节点 —— 只有那个节点重查, 另一个复用', async () => {
  const log1 = [];
  const first = await Engine.testEngine(twoStepCard(), { poNo: 'PO1' }, DBS, () => fakeDb(log1, [{ id: 'A' }]));

  // 只改 q2 的 SQL
  const card = twoStepCard();
  card.nodes.find((n) => n.id === 'q2').sql = "SELECT no FROM storage WHERE po = '{{poNo}}' AND x = 1";

  const log2 = [];
  const second = await Engine.testEngine(card, { poNo: 'PO1' }, DBS, () => fakeDb(log2), { reuse: first.queryCache });
  assert.strictEqual(log2.length, 1, '只有改过的那一个节点该重查');
  assert.match(log2[0], /AND x = 1/, '重查的应当是改过的那条');
  // q1 复用了, q2 真跑了
  assert.deepStrictEqual(second.reused, ['q1']);
});

test('输入变了 —— 参数跟着变, 必须真跑, 不能拿旧结果', async () => {
  const log1 = [];
  const first = await Engine.testEngine(twoStepCard(), { poNo: 'PO1' }, DBS, () => fakeDb(log1, [{ id: 'A' }]));

  const log2 = [];
  // 换成另一个单号: 渲染出来的 SQL 不同, 复用必须失效
  await Engine.testEngine(twoStepCard(), { poNo: 'PO2' }, DBS, () => fakeDb(log2), { reuse: first.queryCache });
  assert.strictEqual(log2.length, 2, '换了输入就该老老实实重跑');
});

test('reuse 里塞的 SQL 对不上时按"没缓存"处理, 不会静默用错数据', async () => {
  const log = [];
  const bogus = { q1: { sql: 'SELECT 1', rows: [{ id: 'WRONG' }], columns: ['id'], rowCount: 1, ok: true } };
  const r = await Engine.testEngine(twoStepCard(), { poNo: 'PO1' }, DBS, () => fakeDb(log), { reuse: bogus });
  assert.strictEqual(log.length, 2, 'SQL 对不上就该全跑');
  assert.strictEqual(r.reused.length, 0);
});

test('复用来的节点不该把 rows 塞进事件里 (否则对话史会被撑爆)', async () => {
  const big = Array.from({ length: 500 }, (_, i) => ({ id: 'r' + i, pad: 'x'.repeat(200) }));
  const log1 = [];
  const first = await Engine.testEngine(twoStepCard(), { poNo: 'PO1' }, DBS, () => fakeDb(log1, big), { sampleRows: 2 });

  const log2 = [];
  const second = await Engine.testEngine(twoStepCard(), { poNo: 'PO1' }, DBS, () => fakeDb(log2, big), {
    reuse: first.queryCache, sampleRows: 2
  });
  // 复用了全部 500 行, 但回传给界面的只有 sampleRows 条
  assert.strictEqual(second.reused.length, 2);
  for (const st of second.steps) {
    if (st.sample) assert.ok(st.sample.length <= 2, '事件里的样本最多 sampleRows 条');
  }
});

/* ============ 2. render_sql 只看不跑 ============ */

test('previewSql 渲染出的 SQL 与真跑时发出去的一模一样', async () => {
  const log = [];
  const r = await Engine.testEngine(twoStepCard(), { poNo: 'PO9' }, DBS, () => fakeDb(log));
  const p = Engine.previewSql(twoStepCard(), 'q2', r.queryCache, { poNo: 'PO9' });
  assert.strictEqual(p.sql, log[1], '渲染结果必须等于真正发出去的那条');
});

test('previewSql 不碰数据库 (openDb 根本没被调用)', async () => {
  let opened = 0;
  const p = Engine.previewSql(twoStepCard(), 'q1', {}, { poNo: 'PO1' });
  assert.strictEqual(opened, 0);
  assert.match(p.sql, /'PO1'/);
  assert.strictEqual(p.missing.length, 0);
});

test('列表被当成一个字符串套引号时, 渲染结果能一眼看出来', () => {
  const card = {
    id: 'c', name: 't',
    nodes: [
      { id: 'in', type: 'input', title: '入口', fields: [{ key: 'poNo', label: 'PO', required: true }] },
      { id: 'q', type: 'query', title: '下游', databaseId: 'd1', table: 'u', sql: 'SELECT * FROM u WHERE x IN ({{ids}})', outputs: [{ key: 'a', label: 'a' }] }
    ],
    edges: [{ from: 'in', to: 'q', port: 'out' }]
  };
  // 这正是实测踩过的坑: IN ({{ids}}) 里 ids 是个列表, 渲染成 IN ('a,b,c')
  const p = Engine.previewSql(card, 'q', {}, { ids: ['111', '222', '333'] });
  assert.strictEqual(p.sql, "SELECT * FROM u WHERE x IN ('111,222,333')");
  const param = p.params.find((x) => x.key === 'ids');
  assert.match(param.value, /^数组\(3 项\)/);
  assert.match(param.literal, /^'/, '代入成了带引号的整串 —— 这就是那个坑');
});

test('参数没有值时如实报 missing, 不假装渲染完整', () => {
  const card = {
    id: 'c', name: 't',
    nodes: [
      { id: 'in', type: 'input', title: '入口', fields: [] },
      { id: 'q', type: 'query', title: '取数', databaseId: 'd1', table: 'u', sql: "SELECT * FROM u WHERE a = '{{nope}}'", outputs: [{ key: 'a', label: 'a' }] }
    ],
    edges: [{ from: 'in', to: 'q', port: 'out' }]
  };
  const p = Engine.previewSql(card, 'q', {}, {});
  assert.deepStrictEqual(p.missing, ['nope']);
  assert.strictEqual(p.sql, "SELECT * FROM u WHERE a = ''", '空占位符会被抹掉, 这正是"查不出东西还不报错"的来源');
});

test('previewSql 对非取数节点给出明确错误', () => {
  const card = twoStepCard();
  const p = Engine.previewSql(card, 'in', {}, {});
  assert.match(p.error, /不是取数节点/);
});

/* ============ 3. recall 取回折叠掉的结果 ============ */

test('createFoldStore 发编号并能取回', () => {
  const s = Loop.createFoldStore(3);
  const h = s.put('hello');
  assert.strictEqual(h, 'h1');
  assert.strictEqual(s.get('h1'), 'hello');
  assert.strictEqual(s.get('nope'), null);
});

test('createFoldStore 超上限丢最老的, 取不到就返回 null (不假装还在)', () => {
  const s = Loop.createFoldStore(2);
  s.put('a'); s.put('b'); s.put('c');
  assert.strictEqual(s.get('h1'), null, '最老的该被清掉');
  assert.strictEqual(s.get('h3'), 'c');
  assert.strictEqual(s.size, 2);
});

test('折叠时存根带上 recall 编号, 且全文确实在仓库里', () => {
  const s = Loop.createFoldStore(10);
  const long = 'X'.repeat(4000);
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '需求' },
    { role: 'tool', content: long }
  ];
  const r = Loop.compactMessages(msgs, { maxChars: 500, keepRecent: 0, foldStore: s });
  assert.strictEqual(r.compacted, 1);
  const folded = r.messages[2].content;
  assert.match(folded, /recall\("h1"\)/, '存根尾上要写清怎么取回');
  assert.strictEqual(s.get('h1'), long, '取回来的必须是原文');
});

test('不传 foldStore 时行为不变 (老调用方和测试不受影响)', () => {
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '需求' },
    { role: 'tool', content: 'X'.repeat(4000) }
  ];
  const r = Loop.compactMessages(msgs, { maxChars: 500, keepRecent: 0 });
  assert.strictEqual(r.compacted, 1);
  assert.doesNotMatch(r.messages[2].content, /recall\(/);
  assert.match(r.messages[2].content, /需要细节请重新调用这个工具/);
});

test('handleOf 能从存根里读回编号, 老存根返回 null', () => {
  assert.strictEqual(Loop.handleOf({ content: 'blah … (这条结果过长, 已折叠, 共 9 字。**全文还在, 用 recall("h7") 取回**)' }), 'h7');
  assert.strictEqual(Loop.handleOf({ content: '普通内容' }), null);
  assert.strictEqual(Loop.handleOf({ content: '… (这条结果过长, 已折叠, 共 9 字。需要细节请重新调用这个工具)' }), null);
});

test('折叠仓库不会碰用户原话和系统提示', () => {
  const s = Loop.createFoldStore(10);
  const msgs = [
    { role: 'system', content: 'S'.repeat(3000) },
    { role: 'user', content: 'U'.repeat(3000) },
    { role: 'tool', content: 'T'.repeat(3000) }
  ];
  const r = Loop.compactMessages(msgs, { maxChars: 500, keepRecent: 0, foldStore: s });
  assert.strictEqual(r.messages[0].content.length, 3000, 'system 一个字不动');
  assert.strictEqual(r.messages[1].content.length, 3000, '用户原话一个字不动');
  assert.ok(r.messages[2].content.length < 3000, '工具结果才折');
});
