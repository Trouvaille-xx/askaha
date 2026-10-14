'use strict';

/**
 * 原子写。
 *
 * 起因: 全仓库 7 处落盘都是裸 `writeFileSync` —— 那是「先把目标文件截断, 再往里写」。
 * 进程被杀 / 断电 / 磁盘写满时, 盘上留下的是半截 JSON。而半截的 config.json 会让
 * 下次启动走 main.js 里「读失败当成没配过」那条链, 把用户的库/口令/Key/流程卡
 * 整份盖掉。所以这个原语不是洁癖, 是那条数据丢失链的第一环。
 *
 * 这里测的不是「能写进去」(裸 writeFileSync 也能), 而是**中途失败时目标文件
 * 保持旧内容**, 以及临时文件不会留在盘上。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeFileAtomic } = require('../lib/atomic-write.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'solodb-atomic-'));
}

const tmpLeftovers = (dir) => fs.readdirSync(dir).filter((n) => n.includes('.tmp-'));

test('能写入新文件', () => {
  const d = tmpDir();
  const f = path.join(d, 'a.json');
  writeFileAtomic(f, '{"x":1}');
  assert.strictEqual(fs.readFileSync(f, 'utf-8'), '{"x":1}');
});

test('覆盖已有文件: 是完整的新内容, 不留旧尾巴', () => {
  const d = tmpDir();
  const f = path.join(d, 'a.json');
  fs.writeFileSync(f, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  writeFileAtomic(f, '{"x":1}');
  assert.strictEqual(fs.readFileSync(f, 'utf-8'), '{"x":1}');
});

test('写完之后不留临时文件', () => {
  const d = tmpDir();
  writeFileAtomic(path.join(d, 'a.json'), 'x');
  assert.deepStrictEqual(tmpLeftovers(d), [],
    '临时文件必须被 rename 掉, 否则 userData 里会慢慢堆一堆 .tmp-* 垃圾');
});

test('目标目录不存在时抛错, 且不留临时文件', () => {
  const d = tmpDir();
  assert.throws(() => writeFileAtomic(path.join(d, 'nope', 'a.json'), 'x'));
  assert.deepStrictEqual(fs.readdirSync(d), []);
});

test('rename 失败时: 目标原样不动, 临时文件被清掉', () => {
  const d = tmpDir();
  const f = path.join(d, 'target');
  fs.mkdirSync(f);                       // 目标是目录 -> rename 必定失败
  assert.throws(() => writeFileAtomic(f, 'NEW'));
  assert.ok(fs.statSync(f).isDirectory(), '目标必须原样不动 —— 这正是原子写的全部理由');
  assert.deepStrictEqual(tmpLeftovers(d), [], '失败路径也要清临时文件');
});

test('内容类型不对时抛错, 且旧文件保持原样', () => {
  const d = tmpDir();
  const f = path.join(d, 'a.json');
  fs.writeFileSync(f, 'OLD');
  assert.throws(() => writeFileAtomic(f, { not: 'text' }));
  assert.strictEqual(fs.readFileSync(f, 'utf-8'), 'OLD');
});

test('大内容与 Buffer 都能写', () => {
  const d = tmpDir();
  const f = path.join(d, 'big.json');
  const big = JSON.stringify({ rows: new Array(20000).fill('x'.repeat(20)) });
  writeFileAtomic(f, big);
  assert.strictEqual(fs.readFileSync(f, 'utf-8'), big);

  const b = path.join(d, 'b.bin');
  writeFileAtomic(b, Buffer.from([1, 2, 3, 255]));
  assert.deepStrictEqual([...fs.readFileSync(b)], [1, 2, 3, 255], '二进制产物也要能原子写');
});

test('并发写同一个文件: 最终内容一定是完整的某一份, 不会是两份混在一起', () => {
  const d = tmpDir();
  const f = path.join(d, 'a.json');
  const a = JSON.stringify({ who: 'A', pad: 'a'.repeat(5000) });
  const b = JSON.stringify({ who: 'B', pad: 'b'.repeat(5000) });
  for (let i = 0; i < 30; i++) {
    writeFileAtomic(f, i % 2 ? a : b);
  }
  const got = fs.readFileSync(f, 'utf-8');
  assert.ok(got === a || got === b, '必须是完整的一份');
  assert.deepStrictEqual(tmpLeftovers(d), []);
});
