'use strict';

/**
 * 索引坏掉时不能把用户的列表写没。
 *
 * 起因 (实测复现过): 把 conversations/index.json 写坏一个字符, 再走一次正常的
 * 存消息, `listConversations()` 就从 3 个变成 1 个。因为:
 *   - readIndex() 把所有异常吞成 []  (分不清"没配过"和"读坏了")
 *   - _writeConversation() 是拿 readIndex() 的结果**重建整个索引**的
 * 对话正文文件其实都还在盘上, 只是界面上永远看不到了, 而且没有任何提示 ——
 * 用户以为对话丢了。
 *
 * 索引本来就只是一份缓存 (真数据在每个 <id>.json 里), 所以坏掉时正确做法是
 * 把它重建出来。这个文件把"重建"和"不再清空"两件事都钉住。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Store = require('../lib/store.js');
const AiChatStore = require('../lib/ai-chat-store.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'solodb-store-'));
}

/* ============================================================
 * 1. 分析对话 (lib/store.js)
 * ============================================================ */

function seedStore() {
  const store = new Store({ rootDir: tmpDir() });
  for (const id of ['c1', 'c2', 'c3']) {
    store.createConversation({ id, title: '对话 ' + id });
    store.saveMessages(id, [{ role: 'user', content: 'hi' }], null, null);
  }
  return store;
}

test('前提: 正常情况下列表有 3 个对话', () => {
  const store = seedStore();
  assert.strictEqual(store.listConversations().length, 3);
});

test('索引坏掉之后: 列表不能变少 (这是那个 bug 的核心)', () => {
  const store = seedStore();
  fs.writeFileSync(store._indexPath(), '{"这不是数组"', 'utf-8');

  const after = store.listConversations();
  assert.strictEqual(after.length, 3,
    '索引坏了也要能看到 3 个对话 —— 以前这里会变成 0, 然后下一次存消息就把索引永久写没');
});

test('索引坏掉之后存一条新消息: 另外两个对话不能被挤掉', () => {
  const store = seedStore();
  fs.writeFileSync(store._indexPath(), '不是 JSON', 'utf-8');

  store.saveMessages('c2', [{ role: 'user', content: 'again' }], null, null);

  const ids = store.listConversations().map((c) => c.id).sort();
  assert.deepStrictEqual(ids, ['c1', 'c2', 'c3'],
    '以前这里只剩 c2 —— 另外两个的索引条目被"重建"没了 (实测 3 -> 1)');
});

test('重建出来的索引条目字段齐全 (界面列表要用)', () => {
  const store = seedStore();
  fs.writeFileSync(store._indexPath(), '', 'utf-8');
  const one = store.listConversations().find((c) => c.id === 'c1');
  assert.ok(one, 'c1 应该被重建出来');
  assert.strictEqual(one.title, '对话 c1');
  assert.strictEqual(typeof one.updatedAt, 'string');
  assert.strictEqual(one.messageCount, 1);
});

test('索引文件不存在 (全新安装) 仍然返回空数组, 不报错', () => {
  const store = new Store({ rootDir: tmpDir() });
  assert.deepStrictEqual(store.listConversations(), []);
});

test('单个对话正文也坏掉时, 跳过它而不是整份列表作废', () => {
  const store = seedStore();
  fs.writeFileSync(path.join(store.convDir, 'c2.json'), '{坏了', 'utf-8');
  fs.writeFileSync(store._indexPath(), '坏了', 'utf-8');
  const ids = store.listConversations().map((c) => c.id).sort();
  assert.deepStrictEqual(ids, ['c1', 'c3'], '好的那两个必须留下');
});

test('重建之后索引会被正常写回, 下次启动不用再重建', () => {
  const store = seedStore();
  fs.writeFileSync(store._indexPath(), '坏了', 'utf-8');
  store.listConversations();                       // 触发重建
  store.saveMessages('c1', [{ role: 'user', content: 'x' }], null, null);
  const raw = JSON.parse(fs.readFileSync(store._indexPath(), 'utf-8'));
  assert.ok(Array.isArray(raw), '索引必须被写回成合法 JSON');
  assert.strictEqual(raw.length, 3);
});

/* ============================================================
 * 2. AI 搭建对话 (lib/ai-chat-store.js) —— 同一个 bug 的第二份
 * ============================================================ */

function seedChats() {
  const s = new AiChatStore({ rootDir: tmpDir() });
  for (const id of ['a1', 'a2', 'a3']) {
    s.create({ id, cardId: 'card_1', title: '对话 ' + id });
    s.save(id, { log: [{ role: 'user', text: 'hi' }] });
  }
  return s;
}

test('AI 对话: 索引坏掉之后列表不能变少', () => {
  const s = seedChats();
  assert.strictEqual(s.list('card_1').length, 3, '前提');
  fs.writeFileSync(s._indexPath(), '坏了', 'utf-8');
  assert.strictEqual(s.list('card_1').length, 3);
});

test('AI 对话: 索引坏掉之后存一条, 另外两条不能被挤掉', () => {
  const s = seedChats();
  fs.writeFileSync(s._indexPath(), '坏了', 'utf-8');
  s.save('a2', { log: [{ role: 'user', text: 'again' }] });
  assert.deepStrictEqual(s.list('card_1').map((c) => c.id).sort(), ['a1', 'a2', 'a3']);
});

test('AI 对话: 重建出来的条目带 cardId (历史列表按卡过滤)', () => {
  const s = seedChats();
  fs.writeFileSync(s._indexPath(), '坏了', 'utf-8');
  const one = s.list('card_1').find((c) => c.id === 'a1');
  assert.ok(one);
  assert.strictEqual(one.cardId, 'card_1');
});
