'use strict';

/**
 * 「入口任选其一」的回归测试。
 *
 * 场景来自真实需求: 一张「红字发票没同步到 Odoo」的卡有三个入口 ——
 * 送货单号 / 采购订单号 / 发票号, 用户手里有哪个就给哪个。
 *
 * 改之前的行为是: 三个字段默认都必填, 少给一个就直接报「缺少必要输入」,
 * 对话里也会先反问「还差 A、B、C」。也就是"三个入口"这个设计意图根本表达不出来。
 *
 * 这里断言的是语义, 不是实现: 给一个就算齐、给零个才叫缺、组内某一个为空不算缺。
 */

const test = require('node:test');
const assert = require('node:assert');

const Engine = require('../lib/engine.js');
const Gate = require('../lib/gate.js');

/* ---- 造一张三入口任选其一的卡 ---- */
function anyOfCard() {
  const card = Engine.newEngine({ name: '红字发票没同步到 Odoo' });
  const input = card.nodes.find((n) => n.type === 'input');
  input.fields = [
    { key: 'deliveryNo', label: '送货单号', desc: 'SRM 送货单号, 形如 DN2024xxxx', group: '单号' },
    { key: 'poNo', label: '采购订单号', desc: 'SRM 采购订单号, 形如 PO2024xxxx', group: '单号' },
    { key: 'invoiceNo', label: '发票号', desc: 'Odoo 红字发票号, 纯数字', group: '单号' }
  ];
  return Engine.normalizeEngine(card);
}

test('任选其一: 三个里给一个就算齐', () => {
  const card = anyOfCard();
  const fields = card.nodes.find((n) => n.type === 'input').fields;

  for (const k of ['deliveryNo', 'poNo', 'invoiceNo']) {
    const r = Engine.checkInputs(fields, { [k]: 'X123' });
    assert.strictEqual(r.ok, true, `只给 ${k} 应该算齐`);
    assert.deepStrictEqual(r.missingGroups, []);
  }
});

test('任选其一: 一个都不给才算缺, 而且提示语用「或」连', () => {
  const card = anyOfCard();
  const fields = card.nodes.find((n) => n.type === 'input').fields;

  const r = Engine.checkInputs(fields, {});
  assert.strictEqual(r.ok, false, '一个都不给必须算缺');
  assert.deepStrictEqual(r.missingGroups, ['单号']);
  // 「请提供 A、B、C」会被读成三个都要, 必须是「A 或 B 或 C」
  assert.match(r.missingLabels, /或/, '任选组的提示语必须用「或」连');
  assert.ok(!r.missingLabels.includes('、'), '任选组不该用顿号连 (会被读成三个都要)');
});

test('任选其一: 组内某一项为空不算缺 (只要组里有一个有值)', () => {
  const card = anyOfCard();
  const fields = card.nodes.find((n) => n.type === 'input').fields;
  const r = Engine.checkInputs(fields, { poNo: 'PO20240001', deliveryNo: '   ' });
  assert.strictEqual(r.ok, true, '另一个是空白字符串也算"没给", 但组里已有有值的');
});

test('没分组的字段仍然各自必填, 不受任选组影响', () => {
  const card = Engine.newEngine();
  const input = card.nodes.find((n) => n.type === 'input');
  input.fields = [
    { key: 'orderNo', label: '订单号', required: true },
    { key: 'deliveryNo', label: '送货单号', group: '单号' },
    { key: 'poNo', label: '采购订单号', group: '单号' }
  ];
  const fields = Engine.normalizeEngine(card).nodes.find((n) => n.type === 'input').fields;

  // 任选组给了一个, 但独立必填项没给 -> 仍然缺
  const r1 = Engine.checkInputs(fields, { deliveryNo: 'DN1' });
  assert.strictEqual(r1.ok, false);
  assert.deepStrictEqual(r1.missing, ['orderNo']);

  // 两个都给齐 -> 通过
  const r2 = Engine.checkInputs(fields, { deliveryNo: 'DN1', orderNo: 'SO1' });
  assert.strictEqual(r2.ok, true);
});

test('整组都是选填时, 一个不给也能跑', () => {
  const card = Engine.newEngine();
  const input = card.nodes.find((n) => n.type === 'input');
  input.fields = [
    { key: 'a', label: 'A', required: false, group: 'g' },
    { key: 'b', label: 'B', required: false, group: 'g' }
  ];
  const fields = Engine.normalizeEngine(card).nodes.find((n) => n.type === 'input').fields;
  assert.strictEqual(Engine.checkInputs(fields, {}).ok, true, '全选填的组不该拦人');
});

test('desc / group 能存下来 (以前 configure_input 会把它们丢掉)', () => {
  const card = anyOfCard();
  const f = card.nodes.find((n) => n.type === 'input').fields[0];
  assert.strictEqual(f.desc, 'SRM 送货单号, 形如 DN2024xxxx', 'desc 必须活着');
  assert.strictEqual(f.group, '单号', 'group 必须活着');
});

/* ---- 运行时: 真的会按"谁有值"走对分支 ---- */

test('运行时: 只给一个入口, 引擎不会报缺输入', async () => {
  const card = anyOfCard();
  const runner = new Engine.EngineRunner({ engine: card, databases: [], openDb: () => { throw new Error('不该连库'); } });
  let err = null;
  try {
    await runner.run({ invoiceNo: '12345' }, () => {});
  } catch (e) {
    err = e;
  }
  // 卡里没有取数节点会走到别的问题上, 但绝不该是"缺少必要输入"
  assert.ok(!err || !/缺少必要输入/.test(err.message), `不该报缺输入, 实际: ${err && err.message}`);
});

test('运行时: 一个都不给, 引擎报的错里用「或」列任选组', async () => {
  const card = anyOfCard();
  const runner = new Engine.EngineRunner({ engine: card, databases: [], openDb: () => { throw new Error('不该连库'); } });
  let err = null;
  try {
    await runner.run({}, () => {});
  } catch (e) {
    err = e;
  }
  assert.ok(err, '一个都不给应该报错');
  assert.match(err.message, /缺少必要输入/);
  assert.match(err.missingLabels || '', /或/, '缺的提示要用「或」');
});

/* ---- 校验: 声明了任选组却没分流, 必须出声 ---- */

test('校验: 声明了任选组但卡里没有分流 -> 给警告', () => {
  const card = anyOfCard();       // 只有入口和出口, 没有条件节点
  const v = Engine.validateEngine(card);
  const hit = v.warnings.some((w) => /任选其一/.test(w) && /分流/.test(w));
  assert.ok(hit, `应该警告"声明了任选组却没分流", 实际警告: ${JSON.stringify(v.warnings)}`);
});

test('校验: 加了 notEmpty 分流之后警告消失', () => {
  const card = anyOfCard();
  const c1 = { id: 'c1', type: 'condition', title: '按送货单号', x: 200, y: 100, expr: { type: 'cmp', left: '{{deliveryNo}}', op: 'notEmpty', right: '' } };
  const c2 = { id: 'c2', type: 'condition', title: '按采购订单号', x: 400, y: 100, expr: { type: 'cmp', left: '{{poNo}}', op: 'notEmpty', right: '' } };
  card.nodes.push(c1, c2);
  const inputId = card.nodes.find((n) => n.type === 'input').id;
  const outId = card.nodes.find((n) => n.type === 'output').id;
  card.edges = [
    { from: inputId, to: c1.id, port: 'out' },
    { from: c1.id, to: outId, port: 'true' },
    { from: c1.id, to: c2.id, port: 'false' },
    { from: c2.id, to: outId, port: 'true' },
    { from: c2.id, to: outId, port: 'false' }
  ];
  const v = Engine.validateEngine(Engine.normalizeEngine(card));
  const hit = v.warnings.some((w) => /任选其一/.test(w) && /分流/.test(w));
  assert.ok(!hit, '加了分流就不该再警告');
});

/* ---- 路由: 字段说明要传到模型眼前 ---- */

test('路由清单: 带上字段说明与任选组', () => {
  const card = anyOfCard();
  const text = Gate.engineCatalogText([card]);
  assert.match(text, /任选其一/, '路由要看到这是任选其一');
  assert.match(text, /DN2024xxxx/, '路由要看到字段说明, 才能判断用户给的值属于哪一项');
  assert.match(text, /送货单号/, '字段中文名要在');
});

test('engineBrief: 任选组按组给出, 不是拍平成一串', () => {
  const card = anyOfCard();
  const brief = Gate.engineBrief(card);
  assert.strictEqual(brief.inputs.groups.length, 1, '应该有一个任选组');
  assert.strictEqual(brief.inputs.groups[0].name, '单号');
  assert.deepStrictEqual(brief.inputs.groups[0].labels, ['送货单号', '采购订单号', '发票号']);
  assert.strictEqual(brief.inputs.plain.length, 0, '这三项都在组里, 没有独立必填项');
});

/* ---- 闸门: 模型决定何时停, 代码只兜底 ---- */

const CAND = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }];

test('闸门: 模型说 run 就 run (不再被"候选还太多"挡下)', () => {
  const r = Gate.decideNext({ keep: ['a', 'b', 'c', 'd', 'e'], engineId: 'c', keepCount: 5, round: 0, action: 'run' });
  assert.strictEqual(r.action, 'run');
  assert.strictEqual(r.engineId, 'c');
});

test('闸门安全阀: 模型指向候选之外的卡 -> 不跑, 继续问', () => {
  const r = Gate.decideNext({ keep: ['a', 'b'], engineId: 'zzz', keepCount: 2, round: 0, action: 'run' });
  assert.strictEqual(r.action, 'ask', '不能跑一张不在候选里的卡');
});

test('闸门: 只剩一张时不必再花一次模型调用', () => {
  const r = Gate.decideNext({ keep: ['a'], engineId: '', keepCount: 1, round: 0, action: 'ask' });
  assert.strictEqual(r.action, 'run');
  assert.strictEqual(r.engineId, 'a');
});

test('闸门安全阀: 问满轮数就不再问了, 端给人自己挑', () => {
  const r = Gate.decideNext({ keep: ['a', 'b', 'c'], engineId: '', keepCount: 3, round: Gate.MAX_ROUNDS, action: 'ask' });
  assert.strictEqual(r.action, 'choose', '不能无限问下去');
});

test('闸门: 模型说 choose 就交给用户挑', () => {
  const r = Gate.decideNext({ keep: ['a', 'b'], engineId: '', keepCount: 2, round: 0, action: 'choose' });
  assert.strictEqual(r.action, 'choose');
});

test('闸门向后兼容: 老形状 (没有 action) 仍按老规则推', () => {
  // 只剩 2 张 -> 端给人挑 (老规则)
  assert.strictEqual(Gate.decideNext({ keep: ['a', 'b'], engineId: '', keepCount: 2, round: 0 }).action, 'choose');
  // 还有 5 张 -> 继续问
  assert.strictEqual(Gate.decideNext({ keep: ['a', 'b', 'c', 'd', 'e'], engineId: '', keepCount: 5, round: 0 }).action, 'ask');
});

test('解析: 模型的问句选项被收下, 超长的丢掉', () => {
  const out = Gate.parseRouter(JSON.stringify({
    action: 'ask',
    question: '你要看哪一种？',
    options: ['销售出库', '采购入库', 'x'.repeat(80)],
    keep: ['a', 'b']
  }), CAND);
  assert.strictEqual(out.action, 'ask');
  assert.strictEqual(out.question, '你要看哪一种？');
  assert.strictEqual(out.options.length, 2, '超长选项要丢掉');
  assert.deepStrictEqual(out.options, ['销售出库', '采购入库']);
});

/* ============================================================
 * 测试 Agent 自己找测试数据 (编排完自动自测的前提)
 * ============================================================ */

const { EngineTester } = require('../lib/engine-tester');

/** 只回一句话的假 LLM: 用来模拟"模型没找到数据"和"模型给出了数据" */
class ScriptedLLM {
  constructor(replies) {
    this.replies = Array.isArray(replies) ? replies : [replies];
    this.calls = 0;
  }
  async chatStep() {
    const r = this.replies[Math.min(this.calls, this.replies.length - 1)];
    this.calls += 1;
    if (typeof r === 'function') return r();
    return { content: r, toolCalls: [] };
  }
  _extractJSON(text) {
    if (!text) return null;
    const a = text.indexOf('{');
    const b = text.lastIndexOf('}');
    if (a === -1 || b <= a) return null;
    try { return JSON.parse(text.slice(a, b + 1)); } catch (e) { return null; }
  }
}

function testerFor(card, llm) {
  return new EngineTester({
    llm,
    pool: {},
    card,
    databases: [],
    openDb: () => { throw new Error('这个测试不该连库'); }
  });
}

test('测试 Agent: 缺输入时能认出"还缺什么" (走任选组语义)', () => {
  const t = testerFor(anyOfCard(), new ScriptedLLM(['{}']));
  assert.strictEqual(t.missingInputs({}).ok, false, '一个都不给算缺');
  assert.strictEqual(t.missingInputs({ poNo: 'PO1' }).ok, true, '任选组给一个就算齐');
});

test('测试 Agent: 找不到真实数据时如实报错, 不拿空输入去"诊断"', async () => {
  // 模型给不出任何值。以前这种情况会直接拿空输入跑, 卡报"缺少必要输入",
  // 测试 Agent 于是对着"输入没给"这个报错做诊断 —— 而卡本身可能没问题。
  const llm = new ScriptedLLM(['我找不到合适的单号。', '我找不到合适的单号。']);
  const t = testerFor(anyOfCard(), llm);
  const evs = [];
  const r = await t.run({}, (ev) => evs.push(ev));

  assert.strictEqual(r.verdict, 'error', '应该报 error');
  assert.match(r.report.summary, /测试数据/, '要说清是缺测试数据');
  assert.match(r.report.rootCause, /测试数据/);
  assert.strictEqual(r.report.fixes.length, 0, '缺数据不该产生"修复建议" (卡没错)');
  assert.ok(
    evs.some((e) => /找一个真实的值/.test(e.message || '')),
    '应该先说明它在找测试数据'
  );
});

test('测试 Agent: 找到数据之后就往下走, 不再卡在缺输入', async () => {
  const llm = new ScriptedLLM(['{"deliveryNo": "DN20240001"}', '没什么可诊断的']);
  const t = testerFor(anyOfCard(), llm);
  const evs = [];
  const r = await t.run({}, (ev) => evs.push(ev));

  // 关键断言: 它拿到了数据, 于是真的去跑卡了 —— 报错不再是"缺少必要输入"
  const ran = evs.some((e) => e.type === 'test_phase' && e.phase === 'run');
  assert.ok(ran, '拿到数据后应该真的去跑这张卡');
  assert.ok(
    !/缺少必要输入/.test((r.run && r.run.error) || ''),
    '不该再因为缺输入而失败'
  );
  assert.ok(
    evs.some((e) => e.type === 'test_phase' && e.phase === 'inputs' && /deliveryNo=DN20240001/.test(e.message || '')),
    '应该说明用哪份数据测'
  );
});

test('测试 Agent: 调用方给的单号优先于它自己找的', async () => {
  // 模型会去找数据, 但调用方已经给了一个明确的单号 —— 那个才是用户想测的
  const llm = new ScriptedLLM(['{"deliveryNo": "找来的号"}', '好']);
  const t = testerFor(anyOfCard(), llm);
  const evs = [];
  await t.run({ poNo: '用户给的号' }, (ev) => evs.push(ev));

  // 已经有值了, 根本不该去"找数据"
  assert.ok(
    !evs.some((e) => /找一个真实的值/.test(e.message || '')),
    '调用方给了输入就不该再去找'
  );
});
