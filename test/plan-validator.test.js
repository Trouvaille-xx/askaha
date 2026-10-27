'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { validatePlan } = require('../lib/plan-validator');

const plan = (over) => Object.assign({
  parseError: false, steps: [], requiredTables: [], requiredCapabilities: [], riskFlags: [],
  handoff: { needed: false, reason: '' }
}, over || {});

test('危险输入未标记转人工 -> error', () => {
  const r = validatePlan(plan(), { question: '帮我 delete from orders' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.length > 0);
});

test('危险输入标记了转人工 -> ok', () => {
  const r = validatePlan(plan({ handoff: { needed: true, reason: '写操作' } }), { question: '帮我 delete from orders' });
  assert.strictEqual(r.ok, true);
});

test('价格类问题缺 sql -> 只警告不阻断', () => {
  const r = validatePlan(plan({ requiredCapabilities: ['describe_table'] }), { question: '总金额是多少' });
  assert.strictEqual(r.ok, true);
  assert.ok(r.warnings.some((w) => /sql/.test(w)));
});

test('价格类问题有 sql -> 无警告', () => {
  const r = validatePlan(plan({ requiredCapabilities: ['sql'] }), { question: '总金额是多少' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.warnings.length, 0);
});

test('未知能力 -> error', () => {
  const r = validatePlan(plan({ requiredCapabilities: ['telepathy'] }), { question: '看看数据' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /未知工具|未知能力/.test(e)));
});

test('规划解析失败 -> 只警告, 不阻断', () => {
  const r = validatePlan({ parseError: true }, { question: 't' });
  assert.strictEqual(r.ok, true);
  assert.ok(r.warnings.length > 0);
});

test('引用未确认的表 -> 警告', () => {
  const r = validatePlan(plan({ requiredTables: ['ghost'] }), { question: 't', availableTables: ['orders'] });
  assert.ok(r.warnings.some((w) => /未确认的表/.test(w)));
});

test('能力不在允许范围 -> error', () => {
  const r = validatePlan(plan({ requiredCapabilities: ['sql'] }), { question: 't', allowedCaps: ['describe_table'] });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /允许范围/.test(e)));
});

test('缺少必选能力 -> error', () => {
  const r = validatePlan(plan({ requiredCapabilities: ['sql'] }), { question: 't', mandatory: ['request_scope'] });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /必选能力/.test(e)));
});
