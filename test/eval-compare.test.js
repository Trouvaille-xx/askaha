'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { compareBatches } = require('../lib/eval/compare');

const base = (over) => Object.assign({
  caseIds: ['a', 'b'], scorerVersion: 's1', provider: 'p', model: 'm',
  passed: 1, failed: 1, review: 0, errors: 0,
  caseResults: [
    { caseId: 'a', status: 'FAIL', finalReply: 'x' },
    { caseId: 'b', status: 'PASS', finalReply: 'y' }
  ]
}, over || {});

test('同 caseIds / 评分器 / provider / 模型 -> 可比', () => {
  const r = compareBatches(base(), base());
  assert.strictEqual(r.comparable, true);
});

test('caseIds 不同 -> 不可比', () => {
  const r = compareBatches(base(), base({ caseIds: ['a', 'c'] }));
  assert.strictEqual(r.comparable, false);
  assert.match(r.reason, /用例集合不同/);
});

test('评分器不同 -> 不可比', () => {
  const r = compareBatches(base(), base({ scorerVersion: 's2' }));
  assert.strictEqual(r.comparable, false);
});

test('已修复 / 新增失败 / 回复改变', () => {
  const a = base();
  const b = base({
    caseResults: [
      { caseId: 'a', status: 'PASS', finalReply: 'x' },          // fixed
      { caseId: 'b', status: 'FAIL', finalReply: 'y' },          // newlyFailed
      { caseId: 'c', status: 'PASS', finalReply: 'z' }
    ]
  });
  // caseIds 仍是 a,b; c 不在比较范围
  const r = compareBatches(a, b);
  assert.strictEqual(r.comparable, true);
  assert.ok(r.fixed.some((x) => x.caseId === 'a'));
  assert.ok(r.newlyFailed.some((x) => x.caseId === 'b'));
});

test('状态不变但回复改变', () => {
  const a = base({ caseResults: [{ caseId: 'a', status: 'PASS', finalReply: 'old' }, { caseId: 'b', status: 'PASS', finalReply: 'y' }] });
  const b = base({ caseResults: [{ caseId: 'a', status: 'PASS', finalReply: 'new' }, { caseId: 'b', status: 'PASS', finalReply: 'y' }] });
  const r = compareBatches(a, b);
  assert.ok(r.replyChanged.some((x) => x.caseId === 'a'));
});
