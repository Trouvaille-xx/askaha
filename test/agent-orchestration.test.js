'use strict';

/**
 * ③ 把"编排交给模型"这条路的回归测试。
 *
 * 背景: 改之前, "用户这句话该走哪条路"由一个**每轮独立重跑的分类器**决定,
 * 而且多张卡对得上时会开一台多轮状态机 (probe -> choose), 由代码决定
 * "下一句问什么、什么时候停"。那台状态机有两个结构性问题:
 *
 *   1. 它的存在理由是"路由发生在对话之外", 所以状态得序列化进 state 再灌回来。
 *      workflow 工具进了模型的工具表之后, 对话历史本身就是状态, 不需要再养一套。
 *   2. 它正是"接续对话被误判"的来源 —— 用户答一句"采购模块", 状态机只能拿
 *      这一句去匹配卡名, 看不见上一句在问什么。
 *
 * 现在: 模型手里有 list_workflows / run_workflow, 自己决定用卡还是自己查。
 */

const test = require('node:test');
const assert = require('node:assert');

const Gate = require('../lib/gate.js');
const Engine = require('../lib/engine.js');
const { BUILTIN_NAMES } = require('../lib/actions.js');

/* ---- 造一张"三个入口任选其一"的卡 (就是用户那张红字发票卡的结构) ---- */
function anyOfCard(name, id) {
  const card = Engine.normalizeEngine(Object.assign(Engine.newEngine({ name: name || '红字发票没有同步到Odoo' }), {
    // id 必须显式给: 早先按名字长度生成, 两张同长度的卡会撞成同一个 id,
    // 于是"两张卡"的测试其实只测了一张。
    id: id || 'eng_red_1',
    description: '查询红字发票相关信息，判断没有同步到 Odoo 的原因',
    examples: ['红字发票没同步', 'HRZ2024001 为什么没同步']
  }));
  const input = card.nodes.find((n) => n.type === 'input');
  input.fields = [
    { key: 'docNo', label: '红字确认单编号', desc: '形如 HRZ2024xxxx', group: '单号' },
    { key: 'redNo', label: '红字单号', desc: '形如 RED2024xxxx', group: '单号' },
    { key: 'invoiceNo', label: '发票号', desc: 'Odoo 里的纯数字发票号', group: '单号' }
  ];
  return Engine.normalizeEngine(card);
}

/* ============================================================
 * 工具暴露: 入参、入参含义、入参备注、工作流目的、工作流描述
 * ============================================================ */

test('模型能看到工作流工具 (list_workflows / run_workflow)', () => {
  assert.ok(BUILTIN_NAMES.has('list_workflows'), 'list_workflows 要在内置动作里');
  assert.ok(BUILTIN_NAMES.has('run_workflow'), 'run_workflow 要在内置动作里');
});

test('run_workflow 的入参说明里讲清了"任选其一"和"别编值"', () => {
  const { BUILTIN_TOOLS } = require('../lib/actions.js');
  const t = BUILTIN_TOOLS.find((x) => x.function.name === 'run_workflow');
  const d = t.function.description;
  assert.match(d, /任选其一/, '要告诉它任选其一组给一个就够');
  assert.match(d, /别猜|不要.*猜|问清楚|ask_user/, '要告诉它抽不到就问, 不要编');
  assert.ok(t.function.parameters.required.includes('engineId'));
  assert.ok(t.function.parameters.required.includes('inputs'));
});

test('卡说明书: 目的 / 描述 / 入参 / 含义 / 备注 / 任选其一 全都要有', () => {
  const text = Gate.engineBriefText(anyOfCard());
  assert.match(text, /目的: 查询红字发票/, '要有工作流目的');
  assert.match(text, /什么时候用/, '要有使用场景');
  assert.match(text, /id: eng_red_/, '要给 id, 否则模型没法调 run_workflow');
  assert.match(text, /【任选其一】单号/, '要标出任选组');
  assert.match(text, /给一个就够/, '要说清任选组不用凑齐');
  assert.match(text, /docNo \(红字确认单编号\)/, '要有入参名 + 中文名');
  assert.match(text, /形如 HRZ2024xxxx/, '要有入参备注 (从哪来、长什么样)');
});

test('卡说明书: 没写说明的入参要显式点出来', () => {
  const card = anyOfCard();
  card.nodes.find((n) => n.type === 'input').fields[0].desc = '';
  const text = Gate.engineBriefText(Engine.normalizeEngine(card));
  assert.match(text, /没写说明/, '没说明要说"没写说明", 而不是留空 —— 留空模型会自己编一个理解');
});

test('卡说明书: 不需要入参的卡要明说"直接跑"', () => {
  const card = Engine.normalizeEngine(Object.assign(Engine.newEngine({ name: '今天有多少单' }), { id: 'e1' }));
  card.nodes.find((n) => n.type === 'input').fields = [];
  const text = Gate.engineBriefText(Engine.normalizeEngine(card));
  assert.match(text, /不需要任何入参/);
});

test('多张卡的说明书互相分得开 (每张都有 id)', () => {
  const a = anyOfCard('红字发票没同步', 'eng_a');
  const b = anyOfCard('送货单签收状态', 'eng_b');
  const text = [a, b].map(Gate.engineBriefText).join('\n\n');
  const ids = text.match(/id: \S+/g) || [];
  assert.strictEqual(ids.length, 2, '两张卡两个 id');
  assert.notStrictEqual(ids[0], ids[1], 'id 不能撞');
});

/* ============================================================
 * 闸门降级: 多张卡对得上时不再进状态机
 * ============================================================ */

test('多张卡对得上 -> kind=route (这个分支现在交给模型, 不再进状态机)', () => {
  const cards = [anyOfCard('红字发票没同步', 'eng_a'), anyOfCard('送货单签收状态', 'eng_b')];
  const route = Gate.parseRoute(JSON.stringify({
    intent: 'engine',
    engineId: '',
    candidates: ['eng_a', 'eng_b']
  }), cards);
  // 多张对得上时闸门给的就是 route —— 而那正是被降级的那个分支:
  // 以前它进 probe/choose 状态机, 现在只是给模型一个候选提示然后继续往下走。
  assert.strictEqual(route.kind, 'route');
  assert.strictEqual(route.candidates.length, 2, '要给出候选让模型参考');
});

test('唯一命中仍是 engine (快路径没被误伤)', () => {
  const cards = [anyOfCard('红字发票没同步', 'eng_a')];
  const route = Gate.parseRoute(JSON.stringify({
    intent: 'engine', engineId: 'eng_a', confidence: 0.95, candidates: ['eng_a']
  }), cards);
  assert.strictEqual(route.kind, 'engine');
  assert.strictEqual(route.low, false, '把握够就不该走"再确认一下"');
});

test('decideNext 仍然拦得住"跑一张不在候选里的卡"', () => {
  const r = Gate.decideNext({ keep: ['a', 'b'], engineId: 'zzz', keepCount: 2, round: 0, action: 'run' });
  assert.strictEqual(r.action, 'ask', '安全阀还在: 不许跑候选之外的卡');
});

test('分析 Agent 的 route 分支不再进状态机 (改成继续往下走)', () => {
  // 这是行为断言: route 分支不该再 return 到 _continueRoute。
  // 用源码断言而不是跑一遍 —— 跑起来要真实模型和数据库, 而这里要锁的是**结构**。
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'agent.js'), 'utf8');
  // 锚在**分支本身** (if (...) {), 而不是裸的 `verdict.kind === 'route'` ——
  // 后者在别处也会出现 (放弃流程卡时的降级判断), indexOf 会命中错的那一处。
  const i = src.indexOf("if (verdict.kind === 'route')");
  assert.ok(i > 0, '要能找到 route 分支');
  const block = src.slice(i, i + 1200);
  assert.ok(!/return await this\._continueRoute/.test(block), 'route 分支不该再进状态机');
  assert.match(block, /_workflowHint/, '应该改成给模型一个候选提示, 继续往下走');
});

test('_continueRoute 只为"上一轮遗留的状态"保留 (向后兼容)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'agent.js'), 'utf8');
  const hits = src.match(/_continueRoute\(/g) || [];
  // 1 处定义 + 1 处调用 (priorRoute 那条路)
  assert.strictEqual(hits.length, 2, `_continueRoute 应该只剩"接上一轮遗留状态"这一个调用点, 实际 ${hits.length} 处`);
});

/* ============================================================
 * 系统提示词要教它用卡
 * ============================================================ */

test('提示词里讲了"先想想有没有现成的流程卡"', () => {
  const { buildSystemPrompt, normalizePromptConfig } = require('../lib/prompt.js');
  const text = buildSystemPrompt(normalizePromptConfig({}));
  assert.match(text, /list_workflows/, '要告诉它有这么个工具');
  assert.match(text, /run_workflow/, '要告诉它怎么跑卡');
  assert.match(text, /不要自己编一个值|不要自己编/, '要明确禁止编入参');
  assert.match(text, /【任选其一】/, '要提任选其一');
});

test('提示词里说了"对不上就自己查" (两条路都能走)', () => {
  const { buildSystemPrompt, normalizePromptConfig } = require('../lib/prompt.js');
  const text = buildSystemPrompt(normalizePromptConfig({}));
  assert.match(text, /自己用 sql 查|照常自己用 sql/, '要说明卡对不上时可以自己查');
});
