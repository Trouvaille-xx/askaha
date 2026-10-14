'use strict';

/**
 * 端到端验证: 拿**用户那张真实的卡** + 一个**真实的库**, 跑出「三个入口任选其一」
 * 那个静默 bug, 再验证修好之后是对的。
 *
 * 为什么用本地 SQLite 而不是生产库:
 *   生产库是 VPC 内网地址 (srm-01.example.com -> 10.0.0.10),
 *   这台机器不在公司网络里, 连不上。而且这个验证要能**反复重放**才靠得住 ——
 *   生产库的数据每天都在变, 靠它当回归测试是不成立的。
 *   所以这里用 SQLite 复刻出同样的表结构和**同样的触发条件**:
 *   表里存在 bill_no / no 为空串的行。
 *
 * 跑法: node test/e2e-anyof-realcard.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const Engine = require('../lib/engine.js');
const Database = require('../lib/database.js');

/* ============================================================
 * 复刻用户那张卡
 * ============================================================ */

/** 从 .appdata/config.json 里读用户真实搭的那张卡; 读不到就现场复刻一张结构一样的 */
function realCard() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.appdata', 'config.json'), 'utf8'));
    const card = (cfg.engines || []).find((e) => /红字发票/.test(e.name || ''));
    if (card) return Engine.normalizeEngine(JSON.parse(JSON.stringify(card)));
  } catch (e) { /* 读不到就下面复刻 */ }

  const card = Engine.normalizeEngine(Object.assign(Engine.newEngine({ name: '红字发票没有同步到Odoo' }), {
    id: 'eng_fixture_red',
    description: '查询红字发票相关信息，判断红字发票没有同步到Odoo的具体原因'
  }));
  card.nodes.find((n) => n.type === 'input').fields = [
    { key: 'docNo', label: '红字确认单编号', required: false },
    { key: 'redNo', label: '红字单号', required: false },
    { key: 'invoiceNo', label: '发票号', required: false }
  ];
  return card;
}

/**
 * 把入口字段摆成"三个入口任选其一"那个形状。
 *
 * 必须由测试自己声明, **不能从真实卡继承** —— 真实那张卡会被搭建 Agent 改
 * (后来就被合并成单字段 required 了), 一改, 依赖它形状的测试就跟着坏。
 * 下面几个测试验的是"任选其一 + notEmpty 分流"这个**结构**本身,
 * 所以结构该由测试摆出来, 跟用户那张卡当前长什么样无关。
 */
function setAnyOfFields(card) {
  card.nodes.find((n) => n.type === 'input').fields = [
    { key: 'docNo', label: '红字确认单编号', required: false },
    { key: 'redNo', label: '红字单号', required: false },
    { key: 'invoiceNo', label: '发票号', required: false }
  ];
  return card;
}

/** 卡里那条 SQL —— 用户的写法: 四个列 OR 起来, 都拿三个入口去套 */
const OR_SQL = (q) =>
  `SELECT id, bill_no, no, invoice_no, red_invoice_no, red_apply_status_show, fail_reason
   FROM invoice_red_apply
   WHERE bill_no = '${q.docNo || ''}' OR no = '${q.redNo || ''}'
      OR invoice_no = '${q.invoiceNo || ''}' OR red_invoice_no = '${q.invoiceNo || ''}'
   LIMIT 1`;

/* ============================================================
 * 建一个本地库, 里面**故意**有空串行 —— 这就是生产库里真实存在的情况
 * ============================================================ */

function makeFixtureDb() {
  const file = path.join(os.tmpdir(), 'solodb-e2e-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) + '.sqlite');
  // sqlite 的配置里, 库文件路径放在 database 这个字段 (见 lib/database.js 的 sqlite 分支)
  const conf = { id: 'local', name: '本地验证库', type: 'sqlite', database: file };

  // sql.js 是内存副本, 先用原始 sql.js 建好文件
  const initSqlJs = require('sql.js');
  return initSqlJs().then((SQL) => {
    const db = new SQL.Database();
    db.run(`
      CREATE TABLE invoice_red_apply (
        id INTEGER PRIMARY KEY,
        bill_no TEXT,
        no TEXT,
        invoice_no TEXT,
        red_invoice_no TEXT,
        red_apply_status_show TEXT,
        fail_reason TEXT
      );
    `);
    // 三行数据, 复刻真实世界的坑:
    //   1. 一个"什么都没填"的垃圾行 —— bill_no 和 no 都是空串
    //   2. 目标行 —— 用户真正要查的那张发票
    //   3. 另一张不相干的发票
    db.run(`INSERT INTO invoice_red_apply VALUES
      (1, '', '', '', '', '待开票', ''),
      (2, 'HRZ2024001', 'RED2024001', '9100001', '9200001', '已开票', ''),
      (3, 'HRZ2024002', 'RED2024002', '9100002', '9200002', '待开票', '同步失败：接口超时')
    `);
    fs.writeFileSync(file, Buffer.from(db.export()));
    db.close();
    return { file, conf };
  });
}

/* ============================================================
 * 1. 复现 bug: 只填一个入口, OR 型 SQL 命中了错误的行
 * ============================================================ */

test('复现: 只填一个入口时, OR 型 SQL 会命中"空串垃圾行"', async () => {
  const { file, conf } = await makeFixtureDb();
  const db = new Database(conf);
  try {
    // 用户手里只有发票号, 另外两个入口是空的
    const rows = (await db.query(OR_SQL({ invoiceNo: '9100001' }))).rows;

    assert.strictEqual(rows.length, 1, 'LIMIT 1, 总归返回一行');
    // 这就是那个 bug: 用户问的是 9100001, 拿回来的却是 id=1 那行空数据
    assert.strictEqual(rows[0].id, 1, '确实命中了 id=1 的空串行 —— bug 复现');
    assert.strictEqual(rows[0].invoice_no, '', '返回的这行 invoice_no 是空的, 跟用户给的值毫无关系');

    // 用户会看到什么: 结论是"待开票 -> 等待同步", 而真正那张票其实是"已开票"
    assert.strictEqual(rows[0].red_apply_status_show, '待开票');
    assert.notStrictEqual(rows[0].invoice_no, '9100001', '拿到的根本不是他要查的那张');
  } finally {
    await db.close();
    try { fs.unlinkSync(file); } catch (e) {}
  }
});

test('对照: 只按真正给了值的那一项查, 结果是对的', async () => {
  const { file, conf } = await makeFixtureDb();
  const db = new Database(conf);
  try {
    const rows = (await db.query(
      `SELECT * FROM invoice_red_apply WHERE invoice_no = '9100001' OR red_invoice_no = '9100001' LIMIT 1`
    )).rows;
    assert.strictEqual(rows[0].id, 2, '应该是真正那张票');
    assert.strictEqual(rows[0].red_apply_status_show, '已开票', '这才是正确答案');
  } finally {
    await db.close();
    try { fs.unlinkSync(file); } catch (e) {}
  }
});

/* ============================================================
 * 2. 用引擎的 notEmpty 分流: 只渲染真正给了值的那一支
 * ============================================================ */

test('修法: 用 notEmpty 分流, 每个入口只查自己那一列', async () => {
  const { file, conf } = await makeFixtureDb();
  const card = setAnyOfFields(realCard());

  // 把卡改成"按谁有值走哪条"的结构 —— 这正是我教给搭建 Agent 的那个分叉模式
  const inputId = card.nodes.find((n) => n.type === 'input').id;
  const outId = card.nodes.find((n) => n.type === 'output').id;
  const mkQuery = (id, title, sql, x) => ({
    id, type: 'query', title, x, y: 100, databaseId: 'local',
    sql,
    outputs: [
      { key: 'bill_no', label: '红字确认单编号' },
      { key: 'invoice_no', label: '发票号' },
      { key: 'red_apply_status_show', label: '红字申请状态' },
      { key: 'fail_reason', label: '失败原因' }
    ]
  });
  const qDoc = mkQuery('q_doc', '按确认单编号查', `SELECT * FROM invoice_red_apply WHERE bill_no = '{{docNo}}' LIMIT 1`, 200);
  const qRed = mkQuery('q_red', '按红字单号查', `SELECT * FROM invoice_red_apply WHERE no = '{{redNo}}' LIMIT 1`, 400);
  const qInv = mkQuery('q_inv', '按发票号查', `SELECT * FROM invoice_red_apply WHERE invoice_no = '{{invoiceNo}}' OR red_invoice_no = '{{invoiceNo}}' LIMIT 1`, 600);
  const condDoc = { id: 'c_doc', type: 'condition', title: '给了确认单编号？', x: 200, y: 100, expr: { type: 'cmp', left: '{{docNo}}', op: 'notEmpty', right: '' } };
  const condRed = { id: 'c_red', type: 'condition', title: '给了红字单号？', x: 400, y: 100, expr: { type: 'cmp', left: '{{redNo}}', op: 'notEmpty', right: '' } };

  card.nodes = card.nodes.filter((n) => n.type === 'input' || n.type === 'output');
  card.nodes.push(condDoc, condRed, qDoc, qRed, qInv);
  card.edges = [
    { from: inputId, to: condDoc.id, port: 'out' },
    { from: condDoc.id, to: qDoc.id, port: 'true' },
    { from: condDoc.id, to: condRed.id, port: 'false' },
    { from: condRed.id, to: qRed.id, port: 'true' },
    { from: condRed.id, to: qInv.id, port: 'false' },
    { from: qDoc.id, to: outId, port: 'out' },
    { from: qRed.id, to: outId, port: 'out' },
    { from: qInv.id, to: outId, port: 'out' }
  ];
  const built = Engine.normalizeEngine(card);

  const db = new Database(conf);
  try {
    // 只给发票号 -> 应该走到"按发票号查"那一支, 拿到正确的那一行
    const res = await Engine.testEngine(built, { invoiceNo: '9100001' }, [conf], () => new Database(conf), { sampleRows: 5 });
    assert.strictEqual(res.ok, true, '应该跑通: ' + (res.error || ''));

    const hit = (res.steps || []).filter((s) => s.id === 'q_inv');
    assert.ok(hit.length, '应该走的是"按发票号查"那一支');
    const rows = (hit[0].sample) || [];
    assert.strictEqual(rows.length, 1, '查到一行');
    assert.strictEqual(rows[0].id, 2, '是真正那张票, 不是空串垃圾行');
    assert.strictEqual(rows[0].red_apply_status_show, '已开票', '结论正确');

    // 没给值的那些分支不该被执行
    assert.ok(!(res.steps || []).some((s) => s.id === 'q_doc'), '没给确认单编号就不该查那一列');
    assert.ok(!(res.steps || []).some((s) => s.id === 'q_red'), '没给红字单号就不该查那一列');
  } finally {
    await db.close();
    try { fs.unlinkSync(file); } catch (e) {}
  }
});

/* ============================================================
 * 3. 三个入口任选一个, 走哪条分支都对
 * ============================================================ */

test('修法: 三个入口换着给, 每次都对', async () => {
  const { file, conf } = await makeFixtureDb();
  const card = setAnyOfFields(realCard());
  const inputId = card.nodes.find((n) => n.type === 'input').id;
  const outId = card.nodes.find((n) => n.type === 'output').id;

  const mkQuery = (id, sql, x) => ({
    id, type: 'query', title: id, x, y: 100, databaseId: 'local', sql,
    outputs: [{ key: 'bill_no', label: '确认单编号' }, { key: 'invoice_no', label: '发票号' }]
  });
  const qDoc = mkQuery('q_doc', `SELECT * FROM invoice_red_apply WHERE bill_no = '{{docNo}}' LIMIT 1`, 200);
  const qRed = mkQuery('q_red', `SELECT * FROM invoice_red_apply WHERE no = '{{redNo}}' LIMIT 1`, 400);
  const qInv = mkQuery('q_inv', `SELECT * FROM invoice_red_apply WHERE invoice_no = '{{invoiceNo}}' LIMIT 1`, 600);
  const cDoc = { id: 'c_doc', type: 'condition', title: 'c1', x: 200, y: 100, expr: { type: 'cmp', left: '{{docNo}}', op: 'notEmpty', right: '' } };
  const cRed = { id: 'c_red', type: 'condition', title: 'c2', x: 400, y: 100, expr: { type: 'cmp', left: '{{redNo}}', op: 'notEmpty', right: '' } };

  card.nodes = card.nodes.filter((n) => n.type === 'input' || n.type === 'output');
  card.nodes.push(cDoc, cRed, qDoc, qRed, qInv);
  card.edges = [
    { from: inputId, to: 'c_doc', port: 'out' },
    { from: 'c_doc', to: 'q_doc', port: 'true' },
    { from: 'c_doc', to: 'c_red', port: 'false' },
    { from: 'c_red', to: 'q_red', port: 'true' },
    { from: 'c_red', to: 'q_inv', port: 'false' },
    { from: 'q_doc', to: outId, port: 'out' },
    { from: 'q_red', to: outId, port: 'out' },
    { from: 'q_inv', to: outId, port: 'out' }
  ];
  const built = Engine.normalizeEngine(card);

  const cases = [
    { inputs: { docNo: 'HRZ2024002' }, node: 'q_doc', wantId: 3 },
    { inputs: { redNo: 'RED2024001' }, node: 'q_red', wantId: 2 },
    { inputs: { invoiceNo: '9100002' }, node: 'q_inv', wantId: 3 }
  ];

  try {
    for (const c of cases) {
      const res = await Engine.testEngine(built, c.inputs, [conf], () => new Database(conf), { sampleRows: 5 });
      assert.strictEqual(res.ok, true, `${JSON.stringify(c.inputs)} 应该跑通: ${res.error || ''}`);
      const step = (res.steps || []).find((s) => s.id === c.node);
      assert.ok(step, `${JSON.stringify(c.inputs)} 应该走 ${c.node}`);
      const rows = (step.sample) || [];
      assert.strictEqual(rows.length, 1, `${JSON.stringify(c.inputs)} 应该查到一行`);
      assert.strictEqual(rows[0].id, c.wantId, `${JSON.stringify(c.inputs)} 查到的行不对`);
    }
  } finally {
    try { fs.unlinkSync(file); } catch (e) {}
  }
});

/* ============================================================
 * 5. 条件里的引用两种写法都要认 (这条是端到端跑出来的真 bug)
 * ============================================================ */

test('条件里的引用: 带花括号和不带花括号必须等价', async () => {
  // 踩过的坑: evalExpr 直接拿 expr.left 去 resolveRef, 而 resolveRef 只认裸引用。
  // 作者在条件里写成 {{docNo}} 时, 它被当成一个字面字段名 -> undefined ->
  // notEmpty 恒为 false -> 分支永远走"假"那条, 而且不报错。
  // 后果是"三个入口任选其一"整个不生效, 每次都落到最后一条兜底分支。
  const Engine2 = require('../lib/engine.js');
  const mk = (leftForm, label) => {
    const c = Engine2.normalizeEngine(Object.assign(Engine2.newEngine({ name: label }), { id: 'e_' + label }));
    const inputId = c.nodes.find((n) => n.type === 'input').id;
    const outId = c.nodes.find((n) => n.type === 'output').id;
    c.nodes.find((n) => n.type === 'input').fields = [
      { key: 'a', label: 'A', required: false },
      { key: 'b', label: 'B', required: false }
    ];
    c.nodes.push(
      { id: 'c1', type: 'condition', title: 'c1', x: 200, y: 100, expr: { type: 'cmp', left: leftForm('a'), op: 'notEmpty', right: '' } },
      { id: 'q1', type: 'query', title: 'q1', x: 200, y: 200, databaseId: 'local', sql: 'SELECT 1 AS v', outputs: [{ key: 'v', label: 'v' }] },
      { id: 'q2', type: 'query', title: 'q2', x: 400, y: 200, databaseId: 'local', sql: 'SELECT 2 AS v', outputs: [{ key: 'v', label: 'v' }] }
    );
    c.edges = [
      { from: inputId, to: 'c1', port: 'out' },
      { from: 'c1', to: 'q1', port: 'true' },
      { from: 'c1', to: 'q2', port: 'false' },
      { from: 'q1', to: outId, port: 'out' },
      { from: 'q2', to: outId, port: 'out' }
    ];
    return Engine2.normalizeEngine(c);
  };

  const { file, conf } = await makeFixtureDb();
  try {
    for (const [form, label] of [[(k) => k, '裸引用'], [(k) => `{{${k}}}`, '花括号']]) {
      const card = mk(form, label === '裸引用' ? 'bare' : 'braced');
      const res = await Engine2.testEngine(card, { a: '有值' }, [conf], () => new Database(conf), { sampleRows: 3 });
      const cond = (res.steps || []).find((s) => s.type === 'condition');
      assert.ok(cond, `${label}: 条件节点应该被执行`);
      assert.strictEqual(cond.result, true, `${label}: a 有值时 notEmpty 必须为 true`);
      assert.ok((res.steps || []).some((s) => s.id === 'q1'), `${label}: 应该走 true 那条分支`);
      assert.ok(!(res.steps || []).some((s) => s.id === 'q2'), `${label}: 不该走 false 那条`);
    }
  } finally {
    try { fs.unlinkSync(file); } catch (e) {}
  }
});

test('条件里的引用: 没给值时为 false, 两种写法一致', async () => {
  const Engine2 = require('../lib/engine.js');
  const c = Engine2.normalizeEngine(Object.assign(Engine2.newEngine({ name: 'x' }), { id: 'e_x' }));
  const inputId = c.nodes.find((n) => n.type === 'input').id;
  const outId = c.nodes.find((n) => n.type === 'output').id;
  c.nodes.find((n) => n.type === 'input').fields = [{ key: 'a', label: 'A', required: false }];
  c.nodes.push(
    { id: 'c1', type: 'condition', title: 'c1', x: 200, y: 100, expr: { type: 'cmp', left: '{{a}}', op: 'notEmpty', right: '' } },
    { id: 'q1', type: 'query', title: 'q1', x: 200, y: 200, databaseId: 'local', sql: 'SELECT 1 AS v', outputs: [{ key: 'v', label: 'v' }] },
    { id: 'q2', type: 'query', title: 'q2', x: 400, y: 200, databaseId: 'local', sql: 'SELECT 2 AS v', outputs: [{ key: 'v', label: 'v' }] }
  );
  c.edges = [
    { from: inputId, to: 'c1', port: 'out' },
    { from: 'c1', to: 'q1', port: 'true' },
    { from: 'c1', to: 'q2', port: 'false' },
    { from: 'q1', to: outId, port: 'out' },
    { from: 'q2', to: outId, port: 'out' }
  ];
  const { file, conf } = await makeFixtureDb();
  try {
    const res = await Engine2.testEngine(Engine2.normalizeEngine(c), {}, [conf], () => new Database(conf), { sampleRows: 3 });
    const cond = (res.steps || []).find((s) => s.type === 'condition');
    assert.strictEqual(cond.result, false, '没给值就该是 false');
    assert.ok((res.steps || []).some((s) => s.id === 'q2'), '应该走 false 那条');
  } finally {
    try { fs.unlinkSync(file); } catch (e) {}
  }
});

/* ============================================================
 * 6. 校验器与运行期必须"同一套引用解析"
 * ============================================================ */

test('不变式: 校验说"能解析"的引用, 运行期就必须真的解析得出值', async () => {
  // 这个 bug 之所以藏得住, 是因为**校验器和运行期各写了一套引用解析**:
  //   - validateEngine -> refStatus  (认花括号, 说"没问题")
  //   - 运行期求值     -> resolveRef (只认裸引用, 拿不到值 -> 恒为假)
  // 两边不一致时, 界面上是一片绿色, 而分支每次都走错。
  //
  // 所以这里锁一个不变式: 对同一批引用, 两边的判断必须一致。
  // 光靠"这次修了 resolveRef"是不够的 —— 下次谁再动其中一边, 这条会立刻红。
  const Engine2 = require('../lib/engine.js');

  const forms = ['docNo', '{{docNo}}', '{{ docNo }}', 'nope', '{{nope}}', 'q1.v', '{{q1.v}}', 'q1.rowCount'];

  for (const form of forms) {
    const c = Engine2.normalizeEngine(Object.assign(Engine2.newEngine({ name: 'x' }), { id: 'e_x' }));
    const inputId = c.nodes.find((n) => n.type === 'input').id;
    const outId = c.nodes.find((n) => n.type === 'output').id;
    c.nodes.find((n) => n.type === 'input').fields = [{ key: 'docNo', label: '确认单编号', required: false }];
    c.nodes.push(
      { id: 'c1', type: 'condition', title: 'c1', x: 200, y: 100, expr: { type: 'cmp', left: form, op: 'notEmpty', right: '' } },
      { id: 'q1', type: 'query', title: 'q1', x: 200, y: 200, databaseId: 'local', sql: 'SELECT 1 AS v', outputs: [{ key: 'v', label: 'v' }] }
    );
    c.edges = [
      { from: inputId, to: 'c1', port: 'out' },
      { from: 'c1', to: 'q1', port: 'true' },
      { from: 'q1', to: outId, port: 'out' }
    ];
    const built = Engine2.normalizeEngine(c);

    // 校验器怎么看这个引用
    const v = Engine2.validateEngine(built);
    const saidBad = v.errors.concat(v.warnings)
      .some((m) => /条件节点/.test(m) && /找不到来源|没有声明这一列/.test(m));

    // 运行期怎么看: 给 docNo 一个真值, 看条件判成什么
    const r = await Engine2.testEngine(built, { docNo: 'X1' }, [], () => { throw new Error('不该连库'); }, { sampleRows: 1 });
    const cond = (r.steps || []).find((s) => s.type === 'condition');
    const runtimeTrue = cond ? cond.result === true : null;

    if (form === 'docNo' || form === '{{docNo}}' || form === '{{ docNo }}') {
      assert.strictEqual(saidBad, false, `「${form}」校验不该报错`);
      assert.strictEqual(runtimeTrue, true, `「${form}」运行期必须解析出值 (docNo 给了 X1)`);
    } else if (form === 'q1.v' || form === '{{q1.v}}' || form === 'q1.rowCount') {
      // 指向的节点这一轮还没跑: 校验认这个名字存在, 运行期取不到值 -> false。
      // 只要求两边**不矛盾** (校验别说"找不到来源"), 不要求运行期为 true。
      assert.strictEqual(saidBad, false, `「${form}」这个名字是存在的, 校验不该说找不到来源`);
    } else {
      assert.strictEqual(saidBad, true, `「${form}」指向不存在的东西, 校验必须报出来`);
      assert.strictEqual(runtimeTrue, false, `「${form}」运行期解析不到, 条件只能是假`);
    }
  }
});

/* ============================================================
 * 7. 一个都不给的时候, 必须报错而不是静默查空
 * ============================================================ */

test('一个入口都不给: 要么调用前拦住, 要么运行时拦住, 不能静默查空', async () => {
  const card = realCard();
  const fields = card.nodes.find((n) => n.type === 'input').fields;

  // 这道校验只管"够不够跑", 所以卡写成两种形状都是合法的:
  //   A) 单个 required 字段 / 一组 required 的任选其一 -> checkInputs 当场拦住
  //   B) 几个 required:false 的散字段                   -> checkInputs 放行,
  //                                                        由运行时 bindParams 拦住
  // 不管哪种, 都不允许"一声不吭地拿 = '' 去查库"。
  //
  // 早先这版测试写死了"卡是 B 形状"这个现状 (assert chk.ok === true)。后来搭建 Agent
  // 把这张卡改成了 A 形状, 那条断言就跟着坏了 —— 测试不该绑在"卡当前长什么样"上,
  // 该绑在"不管卡长什么样, 都不能静默查空"这个不变量上。卡还会被继续改, 不变量不会。
  const chk = Engine.checkInputs(fields, {});

  if (chk.ok) {
    // 调用前没拦住 -> 运行时必须拦住, 而且理由要指到具体的占位符
    const q = card.nodes.find((n) => n.type === 'query');
    if (q) {
      const bound = Engine.bindParams(q.sql, {});
      assert.ok(bound.missing.length > 0,
        '调用前没拦住, 运行时就必须拦住 —— 否则会拿 = \'\' 静默查空');
    }
  } else {
    // 已经拦住了: 提示必须说清缺什么, 不能只给一个空提示
    assert.ok(chk.missingLabels && chk.missingLabels.length,
      '拦住了就要说清缺什么, 不能只给一个空提示');
  }

  // 声明成任选其一组之后, 一个都不给必须被 checkInputs 拦住
  const grouped = fields.map((f) => Object.assign({}, f, { required: true, group: '单号' }));
  const chk2 = Engine.checkInputs(grouped, {});
  assert.strictEqual(chk2.ok, false, '声明成任选其一组之后, 一个都不给必须拦住');
  // 组里多于一项时提示要用「或」连 —— 「请提供 A、B、C」会被读成三个都要。
  // 组里只有一项时 join(' 或 ') 本来就退化成光一个 label, 不该硬要求「或」。
  // (卡被合并成单字段之后就落到这一支了)
  if (grouped.length > 1) {
    assert.match(chk2.missingLabels, /或/, '提示要用「或」连');
  } else {
    assert.ok(chk2.missingLabels && chk2.missingLabels.length, '拦住了就要说清缺哪一项');
  }
});
