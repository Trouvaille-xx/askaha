'use strict';

/**
 * 结论模板的**多行输出**。
 *
 * 起因: 要搭一张「采购订单入库对账排查」的卡, 结论里必须列出三份清单
 * (采购明细的 PO+SKU+入库状态 / 待对账明细的 PO+SKU / 对账单明细的 PO+SKU+AB 对账单号)。
 * 而引擎当时只能取**首行**:
 *
 *   resolveRef('n1.rows') 走到「默认: 首行 + 列名」那一支 -> rows[0]['rows'] -> undefined
 *
 * 于是 {{节点.rows}} 渲染出来永远是空的 —— 偏偏 refStatus 还认这个名字 (第 326 行
 * 把 rows 列进了"合法后缀"), 校验一路放行, 用户看到的是结论里凭空少一段。
 *
 * 这个文件钉住三件事:
 *   1. {{节点.rows}} 铺成 markdown 表格, 空结果集给「（无数据）」而不是一片空白;
 *   2. {{#each 节点.rows}}...{{/each}} 逐行渲染, 循环体里的裸名 = 当前行的列;
 *   3. 体检 (paramsOf / validateEngine) 认得循环 —— 不把循环体里的裸名当成
 *      "找不到来源"的假硬错, 同时把真结构错 (没配对 / 嵌套 / 遍历非 rows) 拦下来。
 */

const test = require('node:test');
const assert = require('node:assert');

const Engine = require('../lib/engine.js');

/** 造一个跑过一次的上下文: 一个取数节点, 两行结果, 带列元数据 */
function ctxWith(rows, columns, inputs) {
  return {
    inputs: inputs || { poNo: 'PO20250328008262' },
    nodes: {
      n_q1: { rows, columns, rowCount: rows.length, ok: true }
    }
  };
}

const ROWS = [
  { sku_code: 'MAF281', received_status: 2 },
  { sku_code: 'MAF525', received_status: 2 }
];

test('模板: {{节点.rows}} 把整个结果集铺成 markdown 表格, 不再是空的', () => {
  const ctx = ctxWith(ROWS, ['sku_code', 'received_status']);
  const r = Engine.renderTemplate('明细:\n{{n_q1.rows}}', ctx, () => '查明细');
  assert.strictEqual(
    r.text,
    '明细:\n| sku_code | received_status |\n| --- | --- |\n| MAF281 | 2 |\n| MAF525 | 2 |'
  );
  assert.deepStrictEqual(r.missing, [], '整表引用不该被算成缺引用');
});

test('模板: 空结果集给「（无数据）」, 不是一片空白', () => {
  const ctx = ctxWith([], ['sku_code', 'received_status']);
  const r = Engine.renderTemplate('明细: {{n_q1.rows}}', ctx, () => '查明细');
  assert.strictEqual(r.text, '明细: （无数据）');
  assert.deepStrictEqual(r.missing, []);
});

test('模板: 表格里的竖线和换行要转义, 否则表格会被撑破', () => {
  const ctx = ctxWith([{ note: 'a|b', big: 'x\ny' }], ['note', 'big']);
  const r = Engine.renderTemplate('{{n_q1.rows}}', ctx, () => 't');
  assert.match(r.text, /\| a\\\|b \| x y \|/);
});

test('模板: {{#each}} 逐行渲染, 裸名取当前行的列, @index 从 1 开始', () => {
  const ctx = ctxWith(ROWS, ['sku_code', 'received_status']);
  const tpl = '{{#each n_q1.rows}}{{@index}}. {{sku_code}} / {{received_status}}\n{{/each}}';
  const r = Engine.renderTemplate(tpl, ctx, () => '查明细');
  assert.strictEqual(r.text, '1. MAF281 / 2\n2. MAF525 / 2\n');
  assert.deepStrictEqual(r.missing, []);
});

test('模板: 循环体的裸名优先当当前行的列, 行里没有才当入口字段', () => {
  const ctx = ctxWith(ROWS, ['sku_code', 'received_status']);
  const tpl = '{{#each n_q1.rows}}{{poNo}} -> {{sku_code}}\n{{/each}}';
  const r = Engine.renderTemplate(tpl, ctx, () => '查明细');
  assert.strictEqual(r.text, 'PO20250328008262 -> MAF281\nPO20250328008262 -> MAF525\n');
  assert.deepStrictEqual(r.missing, [], '入口字段在循环里照样能取到, 不该报缺');
});

test('模板: 循环里引用别的节点照旧按 节点.列名 取', () => {
  const ctx = ctxWith(ROWS, ['sku_code', 'received_status']);
  ctx.nodes.n_q2 = { rows: [{ ab_no: 'AB2025051300051' }], columns: ['ab_no'], rowCount: 1, ok: true };
  const tpl = '{{#each n_q1.rows}}{{sku_code}} {{n_q2.ab_no}}\n{{/each}}';
  const r = Engine.renderTemplate(tpl, ctx, () => 'x');
  assert.strictEqual(r.text, 'MAF281 AB2025051300051\nMAF525 AB2025051300051\n');
});

test('模板: 循环体里引用了查不出来的列 -> 记成 节点.列名, 进 missing 而不是静默为空', () => {
  const ctx = ctxWith(ROWS, ['sku_code', 'received_status']);
  const tpl = '{{#each n_q1.rows}}{{sku_code}}/{{no_such_col}}\n{{/each}}';
  const r = Engine.renderTemplate(tpl, ctx, () => 'x');
  assert.ok(r.missing.includes('n_q1.no_such_col'), '要报出是这一列没查出来: ' + JSON.stringify(r.missing));
});

test('模板: 循环没配对 -> 渲染成空, 但 problems 里说清原因', () => {
  const ctx = ctxWith(ROWS, ['sku_code', 'received_status']);
  const r = Engine.renderTemplate('{{#each n_q1.rows}}{{sku_code}}', ctx, () => 'x');
  assert.ok(r.problems.some((p) => /没配对/.test(p)), JSON.stringify(r.problems));
});

test('模板: 嵌套循环不静默 —— problems 里点名', () => {
  const ctx = ctxWith(ROWS, ['sku_code', 'received_status']);
  const r = Engine.renderTemplate(
    '{{#each n_q1.rows}}{{#each n_q1.rows}}{{sku_code}}{{/each}}{{/each}}',
    ctx,
    () => 'x'
  );
  assert.ok(r.problems.some((p) => /嵌套/.test(p)), JSON.stringify(r.problems));
});

test('paramsOf: 循环源算引用, 循环体裸名记成 节点.列名, @index 不算引用', () => {
  const tpl = '{{#each n_q1.rows}}{{@index}} {{sku_code}} {{poNo}} {{n_q2.ab_no}}\n{{/each}}共 {{n_q1.rowCount}} 行';
  assert.deepStrictEqual(Engine.paramsOf(tpl), [
    'n_q1.rows',
    'n_q1.sku_code',
    'n_q1.poNo',
    'n_q2.ab_no',
    'n_q1.rowCount'
  ]);
});

test('paramsOf: 没配对的循环标记也要把源报出来, 后面那段仍算循环体', () => {
  // 后面那段按"在循环体里"记 -> 裸名列被限定成 节点.列名, 体检才不会额外报一堆假硬错
  assert.deepStrictEqual(Engine.paramsOf('{{#each n_q1.rows}}{{sku_code}}'), ['n_q1.rows', 'n_q1.sku_code']);
});

/** 一张最小的、结构正确的卡: 入口 -> 取数 -> 出口 */
function cardWith(template) {
  return {
    name: 'PO 入库对账排查',
    description: '查 PO 的明细入库与对账情况',
    examples: ['查一下 PO20250328008262 的入库和对账情况'],
    nodes: [
      {
        id: 'n_in', type: 'input', title: '入口',
        fields: [{ key: 'poNo', label: '采购订单号', required: true, desc: '', group: '' }]
      },
      {
        id: 'n_q1', type: 'query', title: '查明细', databaseId: 'db1', table: 'purchase_order_detail',
        sql: "SELECT sku_code, received_status FROM purchase_order_detail WHERE po_no = '{{poNo}}'",
        fields: [{ key: 'poNo', label: '采购订单号', required: true, desc: '', group: '' }],
        outputs: [
          { key: 'sku_code', label: 'SKU' },
          { key: 'received_status', label: '入库状态' }
        ]
      },
      { id: 'n_out', type: 'output', title: '出口', template }
    ],
    edges: [
      { from: 'n_in', to: 'n_q1', port: 'out' },
      { from: 'n_q1', to: 'n_out', port: 'out' }
    ]
  };
}

test('体检: 循环体里的裸名列不再被误报成"找不到来源"的硬错', () => {
  const v = Engine.validateEngine(cardWith('## 明细\n{{#each n_q1.rows}}- {{sku_code}} / {{received_status}}\n{{/each}}'));
  assert.deepStrictEqual(v.errors, [], '循环体里的裸名就是当前行的列, 不该报错');
});

test('体检: 循环体里用入口字段也不报警 (paramsOf 会记成 节点.字段名)', () => {
  const v = Engine.validateEngine(cardWith('{{#each n_q1.rows}}{{poNo}} {{sku_code}}\n{{/each}}'));
  assert.deepStrictEqual(v.errors, []);
  assert.deepStrictEqual(v.warnings.filter((w) => /n_q1\.poNo/.test(w)), [], '入口字段不该报"那一列没声明"');
});

test('体检: {{节点.rows}} 整表引用是合法的', () => {
  const v = Engine.validateEngine(cardWith('明细:\n{{n_q1.rows}}'));
  assert.deepStrictEqual(v.errors, []);
  assert.deepStrictEqual(v.warnings, []);
});

test('体检: 循环没配对 -> 硬错 (存盘前就拦下)', () => {
  const v = Engine.validateEngine(cardWith('{{#each n_q1.rows}}{{sku_code}}'));
  assert.ok(v.errors.some((e) => /没配上对/.test(e)), JSON.stringify(v.errors));
});

test('体检: 嵌套循环 -> 硬错', () => {
  const v = Engine.validateEngine(cardWith('{{#each n_q1.rows}}{{#each n_q1.rows}}{{sku_code}}{{/each}}{{/each}}'));
  assert.ok(v.errors.some((e) => /嵌套/.test(e)), JSON.stringify(v.errors));
});

test('体检: 遍历单个格子 (节点.rowCount) -> 硬错, 要点明只能遍历 .rows', () => {
  const v = Engine.validateEngine(cardWith('{{#each n_q1.rowCount}}{{sku_code}}{{/each}}'));
  assert.ok(v.errors.some((e) => /只能遍历/.test(e)), JSON.stringify(v.errors));
});

test('体检: 遍历一个不存在的节点 -> 硬错', () => {
  const v = Engine.validateEngine(cardWith('{{#each n_q9.rows}}{{sku_code}}{{/each}}'));
  assert.ok(v.errors.some((e) => /遍历的不是取数节点/.test(e)), JSON.stringify(v.errors));
});

test('搭建 Agent 的引用体检: 循环体里的入口字段 (被记成 节点.字段名) 要认, 不能报假错', () => {
  const EngineAiBuilder = require('../lib/engine-ai.js').EngineAiBuilder;
  const b = new EngineAiBuilder({
    llm: null,
    pool: {},
    card: cardWith('{{#each n_q1.rows}}{{poNo}} {{sku_code}}\n{{/each}}'),
    openDb: null,
    databases: []
  });
  assert.strictEqual(b._refExists('n_q1.sku_code'), true, '声明的输出列要认');
  assert.strictEqual(b._refExists('n_q1.poNo'), true, '循环体里的裸名 poNo 其实是入口字段, 要认');
  assert.strictEqual(b._refExists('poNo'), true, '入口字段裸名要认');
  assert.strictEqual(b._refExists('n_q1.no_such_col'), false, '真拼错的列还是要报出来');
  assert.strictEqual(b._refExists('n_q1.rows'), true, '整表引用要认');
});
