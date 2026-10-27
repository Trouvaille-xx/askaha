'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const RunsStore = require('../lib/runs-store');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-'));
  return { store: new RunsStore({ rootDir: dir }), dir };
}

test('create / get / list', () => {
  const { store, dir } = tmpStore();
  const r = store.create({ id: 'r_1', question: 'q1', source: 'chat', status: 'ok', finalReply: 'a' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(store.get('r_1').finalReply, 'a');
  store.create({ id: 'r_2', question: 'q2', source: 'eval', status: 'error', error: 'x' });
  assert.strictEqual(store.list().length, 2);
  assert.strictEqual(store.list({ source: 'eval' }).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('patch: 人工接管 / 标注', () => {
  const { store, dir } = tmpStore();
  store.create({ id: 'r_1', question: 'q' });
  assert.strictEqual(store.patch('r_1', { status: 'handoff', handoff: true }).ok, true);
  assert.strictEqual(store.get('r_1').status, 'handoff');
  store.patch('r_1', { annotation: { note: '好' } });
  assert.strictEqual(store.get('r_1').annotation.note, '好');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('remove', () => {
  const { store, dir } = tmpStore();
  store.create({ id: 'r_1', question: 'q' });
  store.remove('r_1');
  assert.strictEqual(store.get('r_1'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('路径穿越 id 被拒绝', () => {
  const { store, dir } = tmpStore();
  assert.strictEqual(store.get('../../etc/passwd'), null);
  assert.throws(() => store.create({ id: '../evil', question: 'q' }), /非法的/);
  fs.rmSync(dir, { recursive: true, force: true });
});
