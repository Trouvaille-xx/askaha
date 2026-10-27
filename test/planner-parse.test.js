'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parsePlan, buildPlannerPrompt, SYSTEM } = require('../lib/planner');

test('解析合法 JSON (selectedTools / reasoning / riskJudgment)', () => {
  const p = parsePlan(JSON.stringify({
    reasoning: '要取数', selectedTools: ['sql', 'describe_table'], selectedSkills: ['s1'],
    mandatoryCapabilities: ['sql'],
    riskJudgment: { level: 'low', handoff: false, reason: '只读' },
    approach: '先查表', steps: [{ id: 's1', title: '读表' }], requiredTables: ['orders'], confidence: 0.8
  }));
  assert.strictEqual(p.parseError, false);
  assert.strictEqual(p.approach, '先查表');
  assert.deepStrictEqual(p.selectedTools, ['sql', 'describe_table']);
  assert.deepStrictEqual(p.selectedSkills, ['s1']);
  assert.deepStrictEqual(p.mandatoryCapabilities, ['sql']);
  assert.strictEqual(p.riskJudgment.level, 'low');
  assert.deepStrictEqual(p.requiredTables, ['orders']);
  assert.strictEqual(p.confidence, 0.8);
});

test('解析 ```json 围栏', () => {
  const p = parsePlan('说明\n```json\n{"approach":"a","steps":[{"title":"s"}],"handoff":{},"confidence":0.5}\n```');
  assert.strictEqual(p.parseError, false);
  assert.strictEqual(p.approach, 'a');
});

test('垃圾输入 -> 安全 fallback, 不抛', () => {
  const p = parsePlan('完全不是 JSON');
  assert.strictEqual(p.parseError, true);
  assert.deepStrictEqual(p.steps, []);
  assert.strictEqual(p.handoff.needed, false);
});

test('空输入 -> fallback', () => {
  assert.strictEqual(parsePlan('').parseError, true);
  assert.strictEqual(parsePlan(null).parseError, true);
});

test('构造提示词包含问题与可用表', () => {
  const s = buildPlannerPrompt({ userInput: '查订单', availableTables: ['orders', 'users'] });
  assert.match(s, /查订单/);
  assert.match(s, /orders/);
  assert.ok(SYSTEM.length > 0);
});

test('构造提示词按允许能力收窄并带必选能力', () => {
  const s = buildPlannerPrompt({ userInput: 'q', capabilities: ['sql', 'describe_table'], mandatory: ['sql'] });
  assert.match(s, /允许的工具/);
  assert.match(s, /- sql:/);
  assert.match(s, /- describe_table:/);
  assert.match(s, /强制必选: sql/);
  assert.doesNotMatch(s, /- search_knowledge:/);
});
