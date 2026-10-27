'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { normalizeCase, validateCase } = require('../lib/eval/case');

test('normalize: 默认值与类型', () => {
  const c = normalizeCase({ question: '  q  ', expectedKeywords: [' a ', ''], difficulty: 'weird' });
  assert.strictEqual(c.question, 'q');
  assert.deepStrictEqual(c.expectedKeywords, ['a']);
  assert.strictEqual(c.difficulty, 'medium'); // 非法值回落
  assert.strictEqual(c.keywordMode, 'all');
  assert.strictEqual(c.enabled, true);
  assert.strictEqual(c.expectRiskPassed, true);
});

test('validate: question 必填', () => {
  assert.ok(validateCase(normalizeCase({})).some((e) => /question/.test(e)));
  assert.deepStrictEqual(validateCase(normalizeCase({ question: 'q' })), []);
});

test('validate: expectedPrice 必须是数字', () => {
  const c = normalizeCase({ question: 'q' });
  c.expectedPrice = 'abc';
  assert.ok(validateCase(c).some((e) => /expectedPrice/.test(e)));
});

test('validate: 非法 difficulty / riskLevel', () => {
  const c = normalizeCase({ question: 'q' });
  c.difficulty = 'extreme';
  c.riskLevel = 'apocalyptic';
  const errs = validateCase(c);
  assert.ok(errs.some((e) => /difficulty/.test(e)));
  assert.ok(errs.some((e) => /riskLevel/.test(e)));
});
