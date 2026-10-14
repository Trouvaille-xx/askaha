'use strict';

/**
 * normalizeEngine 的时间戳语义: 存盘把 updatedAt 刷成"现在", 但**读路径**要保留原值
 * (engine:list 传 keepTimestamps), 否则一列出列表每张卡都变"刚更新"。
 */

const test = require('node:test');
const assert = require('node:assert');

const Engine = require('../lib/engine');

const base = { id: 'e', name: 'x', nodes: [], edges: [] };

test('默认 (存盘): updatedAt 刷成现在', () => {
  const e = Engine.normalizeEngine(Object.assign({}, base, { updatedAt: '2020-01-01T00:00:00.000Z' }));
  assert.notStrictEqual(e.updatedAt, '2020-01-01T00:00:00.000Z');
  assert.ok(!Number.isNaN(Date.parse(e.updatedAt)));
});

test('keepTimestamps: 保留原 createdAt / updatedAt (读路径)', () => {
  const e = Engine.normalizeEngine(
    Object.assign({}, base, { createdAt: '2019-05-05T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' }),
    { keepTimestamps: true }
  );
  assert.strictEqual(e.createdAt, '2019-05-05T00:00:00.000Z');
  assert.strictEqual(e.updatedAt, '2020-01-01T00:00:00.000Z');
});

test('keepTimestamps 但原本没有 updatedAt: 兜底现在', () => {
  const e = Engine.normalizeEngine(base, { keepTimestamps: true });
  assert.ok(e.updatedAt && !Number.isNaN(Date.parse(e.updatedAt)));
});
