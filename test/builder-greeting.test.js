'use strict';

/**
 * 搭建 Agent 的"用户其实没在搭卡"回归测试。
 *
 * ## 修的是什么
 *
 * 实测: 用户在搭建面板里只说了一句「你好」, 它就回"我来帮你搭这张流程卡。先看一下
 * 这次能用的表有哪些", 然后开始读生产库的表结构, 撞上连不上的库就报超时。
 *
 * 根因是**能力面的缺失**, 不是模型笨:
 *   1. 搭建 Agent 的 18 个工具里, 没有一个能"只是说句话" —— 全是搭卡动作
 *   2. 提示词第一句是"不是回答问题, 而是把一张可复用的卡画出来"
 *   所以"你好"在它的世界里无路可走, 只能开始搭卡。
 *
 * ## 顺带挖出来的第二个 bug
 *
 * `send()` 在循环正常结束时**写死** `done: true`。而 main.js 见到 done 会把
 * 诊断 Agent + 自动修复循环整套拉起来。于是模型哪怕只是在正文里回一句话
 * (连工具都没调), 也会触发一次完整自测 —— 用户付了这个钱却什么都没要。
 * 现在 done 的唯一凭据是 finish 真的被放行过 (this.finished)。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const Engine = require('../lib/engine.js');
const { EngineAiBuilder, buildSystemPrompt } = require('../lib/engine-ai.js');

/* ============================================================
 * 替身
 * ============================================================ */

class FakeLLM {
  constructor(script) {
    this.script = script.slice();
    this.calls = [];
    this.config = { apiKey: 't' };
  }
  _extractJSON() { return null; }
  async chatStep(messages, tools) {
    this.calls.push({ messages: messages.map((m) => ({ role: m.role, content: m.content })), toolNames: (tools || []).map((t) => t.function.name) });
    const step = this.script.shift();
    if (!step) return { content: '', toolCalls: [] };
    if (step.native) return { content: step.content || null, toolCalls: step.native };
    return { content: step.content || '', toolCalls: [] };
  }
}

const native = (name, args) => ({ id: 'c_' + name, name, args: args || {} });

const stubDb = {
  type: 'mysql',
  config: { database: 'stub' },
  async listTables() { return ['invoice_red_apply', 'delivery_order']; },
  async describeTable() { return [{ field: 'id', type: 'int' }]; },
  async query() { return { columns: ['id'], rows: [{ id: 1 }], rowCount: 1, elapsedMs: 1 }; }
};

function makeBuilder(script, opts = {}) {
  const llm = new FakeLLM(script);
  const card = opts.card || Engine.normalizeEngine(Engine.newEngine({ name: '测试卡' }));
  const b = new EngineAiBuilder({
    llm,
    pool: opts.pool || { db1: ['invoice_red_apply', 'delivery_order'] },
    card,
    openDb: () => stubDb,
    databases: opts.databases || [{ id: 'db1', name: '库1', type: 'mysql' }],
    mcp: null
  });
  // finish 有硬闸门 (没跑通过就不许收尾), 想测 done 就得先把这个标志立起来
  if (opts.tested) b.tested = { validated: true, ran: true };
  return { b, llm, card };
}

/* ============================================================
 * 工具表: 得先有"只是说话"这个选项
 * ============================================================ */

test('搭建 Agent 有 reply 工具 —— 没有它, "你好"就无路可走', () => {
  const { b } = makeBuilder([]);
  const r = b._registry();
  assert.ok(r.has('reply'), '必须有 reply, 否则模型只能开始搭卡');
  assert.strictEqual(r.get('reply').readOnly, true, 'reply 不碰卡, 是只读的');
});

test('reply 的说明明确写了"用户没在让你搭卡时用它"', () => {
  const { b } = makeBuilder([]);
  const desc = b._registry().get('reply').description;
  assert.match(desc, /打招呼/);
  assert.match(desc, /不要去做搭卡的动作/);
});

test('reply 是终结动作 —— 说完就停, 不能接着去读表', async () => {
  const { b, llm } = makeBuilder([
    { native: [native('reply', { text: '你好呀' })] },
    { native: [native('list_available_tables', {})] }   // 不该被消费
  ]);
  const r = await b.send('你好', () => {});
  assert.strictEqual(r.reply, '你好呀');
  assert.strictEqual(r.done, false, '闲聊不是"搭完了"');
  assert.strictEqual(r.chatOnly, true);
  assert.strictEqual(llm.calls.length, 1, 'reply 之后就该停 —— 第二条脚本不该被消费');
});

/* ============================================================
 * done 的语义: 唯一凭据是 finish 被放行过
 * ============================================================ */

test('reply 之后 done=false —— 不能把自测 Agent 拉起来', async () => {
  const { b } = makeBuilder([{ native: [native('reply', { text: '你好' })] }]);
  const r = await b.send('你好', () => {});
  assert.strictEqual(r.done, false);
  assert.strictEqual(r.chatOnly, true);
  assert.strictEqual(b.finished, false, 'reply 绝不能置 finished');
});

test('模型只回正文、一个工具都不调 -> done=false', async () => {
  // 这是最阴的一条: 循环"正常结束"了, 但卡一个字都没动。
  // 以前这里写死 done: true, 于是 main.js 拉起整套自测。
  const { b } = makeBuilder([{ content: '你好！有什么可以帮你的？' }]);
  const r = await b.send('你好', () => {});
  assert.strictEqual(r.done, false, '循环正常结束 ≠ 卡搭好了');
  assert.strictEqual(r.chatOnly, true);
});

test('只调只读工具然后停下 -> done=false', async () => {
  const { b } = makeBuilder([
    { native: [native('list_available_tables', {})] },
    { content: '就这些表。' }
  ]);
  const r = await b.send('有哪些表', () => {});
  assert.strictEqual(r.done, false, '看了下表不等于卡搭好了');
});

test('finish 被放行 -> done=true (这才是真的搭完了)', async () => {
  const { b } = makeBuilder(
    [{ native: [native('finish', { summary: '搭好了, 这样跑' })] }],
    { tested: true }   // 立起"跑通过"的标志, 否则硬闸门会拦下 finish
  );
  const r = await b.send('搭一张卡', () => {});
  assert.strictEqual(r.done, true);
  assert.strictEqual(r.chatOnly, false);
  assert.strictEqual(b.finished, true);
});

test('finish 被硬闸门拦下 -> done=false (没跑通就不算搭完)', async () => {
  // tested.ran 是 false, 所以 finish 会被拦
  const { b } = makeBuilder([{ native: [native('finish', { summary: '我完事了' })] }]);
  const r = await b.send('搭一张卡', () => {});
  assert.strictEqual(b.finished, false, '闸门应该拦下它');
  assert.strictEqual(r.done, false);
});

/* ============================================================
 * 提问仍然是终结, 不受影响
 * ============================================================ */

test('ask_choice 还是终结动作, done 依然是 undefined (在等用户回答)', async () => {
  const { b } = makeBuilder([{
    native: [native('ask_choice', {
      question: '要查什么?',
      options: [{ label: '查送货单' }, { label: '查发票' }]
    })]
  }]);
  const r = await b.send('搭一张卡', () => {});
  assert.strictEqual(r.ask, '要查什么?');
  assert.notStrictEqual(r.done, true, '提问不是搭完了');
  assert.ok(r.choice, '选项要带给界面, 用户才能点');
});

test('ask_choice 没给选项时报错, 不会假装在等用户', async () => {
  const { b } = makeBuilder([
    { native: [native('ask_choice', { question: '要查什么?' })] },   // 没有 options
    { content: '算了。' }
  ]);
  const r = await b.send('搭一张卡', () => {});
  assert.ok(!r.ask, '没选项就不该当成"在等回答"');
  assert.strictEqual(r.done, false);
});

/* ============================================================
 * 提示词: 决定"走哪条路"的判断写在这里
 * ============================================================ */

test('提示词开头有"先判断用户是不是在让你搭卡"', () => {
  const card = Engine.normalizeEngine(Engine.newEngine({ name: 'x' }));
  const text = buildSystemPrompt(card, { db1: ['t1'] }, new Map(), { db1: '库1' });
  assert.match(text, /先判断: 用户是在让你搭卡吗/, '这个判断必须在最前面');
  assert.match(text, /不是在搭卡/, '要明确列出"不是在搭卡"的情形');
  assert.match(text, /绝对不要.*list_available_tables/s, '要明确禁止这种情况下去读表');
});

test('提示词不再无条件说"不是回答问题"', () => {
  // 修之前第一句是「不是回答问题, 而是把一张可复用的卡画出来」——
  // 一句话就把"用户其实只想聊两句"这条路堵死了
  const card = Engine.normalizeEngine(Engine.newEngine({ name: 'x' }));
  const text = buildSystemPrompt(card, { db1: ['t1'] }, new Map(), { db1: '库1' });
  assert.ok(!/不是回答问题/.test(text), '这句会诱导模型把闲聊也当搭卡任务');
});

test('提示词把"你好"这个真实踩过的坑写进去了', () => {
  const card = Engine.normalizeEngine(Engine.newEngine({ name: 'x' }));
  const text = buildSystemPrompt(card, { db1: ['t1'] }, new Map(), { db1: '库1' });
  assert.match(text, /你好/, '举具体例子比抽象规则有效');
  assert.match(text, /读超时|白烧钱/, '要说清代价');
});

/* ============================================================
 * 每一轮都要重置 —— 否则上一轮的 chatOnly 会串到下一轮
 * ============================================================ */

test('新一轮会清掉上一轮的 repliedOnly', async () => {
  const { b } = makeBuilder([
    { native: [native('reply', { text: '你好' })] },
    { native: [native('finish', { summary: '好了' })] }
  ], { tested: true });

  const r1 = await b.send('你好', () => {});
  assert.strictEqual(r1.chatOnly, true);

  const r2 = await b.send('搭一张卡', () => {});
  assert.strictEqual(r2.done, true, '第二轮真的搭完了, 不该被上一轮的标记影响');
  assert.strictEqual(r2.chatOnly, false);
});

test('新会话的 repliedOnly 是显式初始化的, 不是 undefined', () => {
  const { b } = makeBuilder([]);
  assert.strictEqual(b.repliedOnly, false, '语义要明确, 不能靠 undefined 兜底');
  assert.strictEqual(b.finished, false);
});
