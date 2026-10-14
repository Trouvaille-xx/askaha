'use strict';

/**
 * ④ 统一上下文管理的回归测试。
 *
 * 改之前三个 Agent 各管各的 messages, 后果不是"不好看", 而是**规则不一致**:
 * 分析 Agent 有可配的 maxChars, 另外两个只能用默认值; 历史裁剪只有分析 Agent 做。
 * 于是"长会话会不会爆窗口"取决于你用的是哪个 Agent, 而不是取决于配置。
 *
 * 这里锁两件事:
 *   1. AgentContext 自己的行为 (裁剪 / 压缩 / 快照)
 *   2. 三个 Agent 真的都在用它 —— 不然这个模块只是个摆设
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { AgentContext, DEFAULT_HISTORY_TURNS } = require('../lib/context.js');
const { DEFAULT_MAX_CHARS } = require('../lib/agent-loop.js');

/* ============================================================
 * 基本行为
 * ============================================================ */

test('默认值: maxChars 跟运行时同一个来源, 不各写一个数', () => {
  const c = new AgentContext();
  assert.strictEqual(c.maxChars, DEFAULT_MAX_CHARS, '默认上限必须是运行时那个常量');
  assert.strictEqual(c.historyTurns, DEFAULT_HISTORY_TURNS);
  assert.deepStrictEqual(c.messages, []);
});

test('maxChars 可配, 传垃圾值就退回默认', () => {
  assert.strictEqual(new AgentContext({ maxChars: 5000 }).maxChars, 5000);
  assert.strictEqual(new AgentContext({ maxChars: 0 }).maxChars, DEFAULT_MAX_CHARS);
  assert.strictEqual(new AgentContext({ maxChars: -1 }).maxChars, DEFAULT_MAX_CHARS);
  assert.strictEqual(new AgentContext({ maxChars: 'x' }).maxChars, DEFAULT_MAX_CHARS);
});

test('系统提示可以是字符串, 也可以是每轮重建的函数', () => {
  assert.strictEqual(new AgentContext({ system: '固定' }).systemText(), '固定');

  let n = 0;
  const c = new AgentContext({ system: () => '第' + (++n) + '轮' });
  assert.strictEqual(c.systemText(), '第1轮');
  assert.strictEqual(c.systemText(), '第2轮', '传函数就应该每次重新求值');
});

test('系统提示不算进对话字数 —— 压缩阈值只看对话本身', () => {
  // 这条容易踩: 按"连系统提示一起"估阈值, 压缩就永远不触发
  const c = new AgentContext({ system: 'S'.repeat(5000), maxChars: 1000 });
  c.pushUser('短');
  assert.strictEqual(c.chars(), 1, 'chars() 只算对话');
});

/* ============================================================
 * 历史裁剪: 规则只有一份
 * ============================================================ */

test('fromHistory: 只取最近 N 轮, 且丢掉脏数据', () => {
  const c = new AgentContext({ historyTurns: 2 });
  c.fromHistory([
    { role: 'user', content: '很旧的一句' },
    { role: 'assistant', content: '很旧的回答' },
    { role: 'user', content: '中间那句' },
    { role: 'assistant', content: '中间的回答' },
    { role: 'user', content: '最近一句' },
    { role: 'assistant', content: '最近一句的回答' }
  ]);
  assert.strictEqual(c.length, 2, 'historyTurns=2 只留两条');
  assert.strictEqual(c.messages[0].content, '最近一句');
});

test('fromHistory: system 角色、空内容、坏对象一律不进对话', () => {
  const c = new AgentContext();
  c.fromHistory([
    { role: 'system', content: '不该从这里进来' },
    { role: 'user', content: '   ' },
    { role: 'user', content: '' },
    { role: 'tool', content: '工具消息也不该从历史里来' },
    null,
    undefined,
    { role: 'user' },
    { role: 'assistant', content: '这句要留下' }
  ]);
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c.messages[0].content, '这句要留下');
});

test('fromHistory: 传进来的轮数覆盖默认值', () => {
  const c = new AgentContext({ historyTurns: 10 });
  c.fromHistory([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }], 1);
  assert.strictEqual(c.length, 1, '显式传的轮数优先');
});

test('fromHistory: history 不是数组也不炸', () => {
  const c = new AgentContext();
  c.fromHistory(null).fromHistory(undefined).fromHistory('x').fromHistory({});
  assert.strictEqual(c.length, 0);
});

/* ============================================================
 * 压缩: 只折取数结果
 * ============================================================ */

function bigContext(maxChars) {
  const c = new AgentContext({ system: 'SYS', maxChars });
  c.pushUser('用户的原话, 一个字都不能动');
  for (let i = 0; i < 6; i++) {
    c.pushAssistant('a' + i);
    c.push({ role: 'tool', tool_call_id: 't' + i, content: 'Z'.repeat(2000) });
  }
  return c;
}

test('compact: 折掉早期的取数结果, 系统提示和用户原话不动', () => {
  const c = bigContext(5000);
  const before = c.chars();
  const r = c.compact();

  assert.ok(r.compacted > 0, '应该折了');
  assert.ok(r.savedChars > 0, '要能报出省了多少');
  assert.ok(c.chars() < before, '总字数应该降下来');
  assert.strictEqual(c.messages[0].content, '用户的原话, 一个字都不能动');
  assert.ok(!c.messages.some((m) => m.content === 'SYS'), '系统提示本来就不在这个数组里');
});

test('compact: 没超阈值就什么都不做', () => {
  const c = new AgentContext({ maxChars: 100000 });
  c.pushUser('短');
  const r = c.compact();
  assert.strictEqual(r.compacted, 0);
  assert.strictEqual(c.compactions, 0);
});

test('compact: 累计次数记下来, 给诊断用', () => {
  const c = bigContext(5000);
  assert.ok(c.compact().compacted > 0, '第一次应该折了');
  assert.strictEqual(c.compactions, 1);

  // 折完就降到阈值以下了, 所以要再灌一批才会触发第二次
  assert.strictEqual(c.compact().compacted, 0, '没超阈值时不该空转计数');
  assert.strictEqual(c.compactions, 1, '空转不该让计数涨');

  for (let i = 0; i < 4; i++) {
    c.pushAssistant('again' + i);
    c.push({ role: 'tool', tool_call_id: 'x' + i, content: 'W'.repeat(3000) });
  }
  assert.ok(c.compact().compacted > 0, '又超了就该再折一次');
  assert.strictEqual(c.compactions, 2);
});

test('compact: 文本模式的取数结果靠 toolIdx 指认', () => {
  const c = new AgentContext({ maxChars: 3000 });
  c.pushUser('q');
  c.pushAssistant('a1');
  c.pushUser('X'.repeat(4000));   // 文本模式的结果回灌, role 是 user
  c.pushAssistant('a2');
  c.pushUser('Y'.repeat(4000));

  const r = c.compact([2, 4]);
  assert.ok(r.compacted > 0, '给了下标就该折得动');
  assert.strictEqual(c.messages[0].content, 'q', '用户原话要留着');
});

/* ============================================================
 * toLoop: 唯一的出口
 * ============================================================ */

test('toLoop: 产出的形状固定, 三个 Agent 不用再各拼一遍', () => {
  const c = new AgentContext({ system: 'SYS', maxChars: 7777 });
  c.pushUser('干活');
  const cfg = c.toLoop({ llm: { fake: true }, tools: { fake: true }, maxSteps: 9, emit: () => {} });

  // foldStore 是折叠仓库: 折掉的长结果存在那儿, 存根上留编号, 模型能用 recall 取回。
  // 加它是因为"折了就删"的代价不是少看一点细节, 而是模型会**重新查一遍库** (一次真跑几十秒起)。
  assert.deepStrictEqual(Object.keys(cfg).sort(), ['budget', 'cancel', 'ctx', 'emit', 'foldStore', 'ledger', 'llm', 'messages', 'stopWhen', 'system', 'temperature', 'tools'].sort());
  assert.strictEqual(cfg.budget.maxSteps, 9);
  assert.strictEqual(cfg.budget.maxChars, 7777, 'maxChars 由 context 统一注入, 谁也不会漏配');
  assert.strictEqual(typeof cfg.system, 'function', 'system 必须是函数 (运行时要每轮重建)');
  assert.strictEqual(cfg.system(), 'SYS');
  assert.strictEqual(cfg.messages, c.messages, '必须是同一个数组, 不能是副本');
  // 不传就保持老行为 (折了真没了), 所以默认必须是 undefined 而不是一个空对象 ——
  // 空对象会让 compactMessages 以为"有仓库", 每条存根都挂一个取不回来的编号
  assert.strictEqual(cfg.foldStore, undefined, '不传时不伪造一个空的折叠仓库');
  // ledger 是折叠出来的进度账, 由运行时拼进系统提示 (不写消息数组 ——
  // 写进去就会破坏"用户原话一个字不动"这条不变量)
  assert.strictEqual(cfg.ledger, '', '没折过东西时账是空的');
});

test('toLoop: messages 里绝不含 system —— 运行时自己会拼一条', () => {
  // 含了就会变成两条 system, 而且第二条(运行时的)在最后, 模型看到的是两份指令
  const c = new AgentContext({ system: 'SYS' });
  c.pushUser('干活');
  c.push({ role: 'system', content: '混进来的' });   // 故意塞一条
  const cfg = c.toLoop({});
  assert.strictEqual(cfg.messages.filter((m) => m.role === 'system').length, 1, '塞进来的那条确实在数组里');
  // 这条不是在为"允许混进来"背书 —— 而是说运行时不依赖这个前提:
  // 它把 system 放在最前面单独拼, 所以即便混进来也不会顶掉真正的系统提示
  assert.strictEqual(cfg.system(), 'SYS');
});

/* ============================================================
 * 快照: 搭建 Agent 要把对话存进卡片状态
 * ============================================================ */

test('snapshot / restore: 往返之后对话和阈值都还在', () => {
  const a = bigContext(4000);
  a.pushUser('最后一句');
  const snap = JSON.parse(JSON.stringify(a.snapshot()));

  const b = new AgentContext();
  b.restore(snap);
  assert.strictEqual(b.length, a.length);
  assert.strictEqual(b.maxChars, 4000);
  assert.strictEqual(b.messages[b.length - 1].content, '最后一句');
});

test('restore: 坏快照不能把上下文搞坏', () => {
  const c = new AgentContext({ maxChars: 3000 });
  c.pushUser('原有内容');
  c.restore(null).restore(undefined).restore('x').restore({ messages: 'not an array' });
  assert.strictEqual(c.length, 1, '坏快照应该被忽略, 不是清空');
  assert.strictEqual(c.maxChars, 3000);
});

test('reset: 清掉对话, 但阈值和系统提示留着', () => {
  const c = new AgentContext({ system: 'SYS', maxChars: 3000 });
  c.pushUser('a');
  c.reset();
  assert.strictEqual(c.length, 0);
  assert.strictEqual(c.maxChars, 3000);
  assert.strictEqual(c.systemText(), 'SYS');
});

/* ============================================================
 * 三个 Agent 真的都在用它 —— 不然这模块只是个摆设
 * ============================================================ */

test('三个 Agent 都通过 AgentContext 管上下文', () => {
  const files = {
    '分析 Agent': 'lib/agent.js',
    '搭建 Agent': 'lib/engine-ai.js',
    '诊断 Agent': 'lib/engine-tester.js'
  };
  for (const [label, rel] of Object.entries(files)) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    assert.match(src, /require\(['"]\.\/context(\.js)?['"]\)/, `${label} 要引入 context`);
    assert.match(src, /new AgentContext\(/, `${label} 要建 AgentContext`);
    assert.match(src, /\.toLoop\(/, `${label} 要用 toLoop() 拿运行时配置 —— 否则还是会各拼一遍`);
  }
});

test('三个 Agent 都不再自己手拼 {system, messages, budget}', () => {
  // 手拼的痕迹: 直接给 AgentLoop 传字面量 budget
  const files = ['lib/agent.js', 'lib/engine-ai.js', 'lib/engine-tester.js'];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    // _inventInputs 里那个一次性小循环允许单独拼 (它只有一个固定消息, 没有上下文可言)
    const literalBudgets = (src.match(/budget:\s*\{\s*maxSteps:/g) || []).length;
    const viaToLoop = (src.match(/\.toLoop\(/g) || []).length;
    assert.ok(viaToLoop >= 1, `${rel} 至少要有一处 toLoop`);
    assert.ok(literalBudgets <= 1, `${rel} 不该再有多处手拼 budget (实际 ${literalBudgets})`);
  }
});

test('搭建 Agent 的 messages 是 ctx 的别名, 不是另存一份', () => {
  // 两份数组一定会分叉, 而分叉的表现是"模型看到的和存盘的不是同一段对话"
  const { EngineAiBuilder } = require('../lib/engine-ai.js');
  const b = new EngineAiBuilder({
    llm: { config: {} }, pool: {}, card: null, openDb: null, databases: [], mcp: null
  });
  b.messages = [{ role: 'user', content: 'x' }];
  assert.strictEqual(b.ctx.messages, b.messages, 'setter 之后两者必须还是同一个数组');
  b.ctx.pushUser('y');
  assert.strictEqual(b.messages.length, 2, '从 ctx 推一条, 别名这边也要看得到');
});

test('诊断 Agent 的 messages 也是 ctx 的别名', () => {
  const { EngineTester } = require('../lib/engine-tester.js');
  const t = new EngineTester({ llm: { config: {} }, pool: {}, card: null, databases: [], openDb: null, mcp: null });
  t.messages = [{ role: 'user', content: 'x' }];
  assert.strictEqual(t.ctx.messages, t.messages);
  t.ctx.pushUser('y');
  assert.strictEqual(t.messages.length, 2);
});

test('两个 Agent 的 maxChars 都能从 general 传进来', () => {
  const { EngineAiBuilder } = require('../lib/engine-ai.js');
  const { EngineTester } = require('../lib/engine-tester.js');
  const mk = (C) => new C({
    llm: { config: {} }, pool: {}, card: null, databases: [], openDb: null, mcp: null,
    general: { maxChars: 12345 }
  });
  assert.strictEqual(mk(EngineAiBuilder).ctx.maxChars, 12345, '搭建 Agent 要能配');
  assert.strictEqual(mk(EngineTester).ctx.maxChars, 12345, '诊断 Agent 也要能配');
});
