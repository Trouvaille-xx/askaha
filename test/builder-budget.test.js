'use strict';

/**
 * 搭建 Agent 的**预算与取消**。
 *
 * 起因: 用户搭卡搭到一半, 界面上出现
 *   「这一轮的动作步数用满了 (40 步), 这张卡可能还没搭完 ——
 *     再说一句"继续"可以接着改步数大一点」
 *
 * 追上去是三个系统缺陷, 全都不是模型做错了:
 *
 *   1. **搭建停不下来**。engine-ai.js 从不给 toLoop 传 cancel, 所以它那条
 *      `stopReason === 'cancelled'` 是死代码; 界面的「停止」只停自测。
 *   2. **系统把自己的活推给用户**。它明明知道卡没搭完 (this.finished 才是凭据),
 *      却让用户来说"继续"。而且这句话还会绕一圈: 系统的 nudge 告诉**模型**
 *      "步数快用完了, 请收敛", 模型没法给自己加预算, 只好回头告诉**用户**
 *      "再说一句继续" —— 系统 -> 模型 -> 用户, 两跳推诿。
 *   3. **40 是硬编码常量, 而且探索和搭建共用同一个预算池**。
 *      实测一个会话里 9 次 look_at_data 看同一张表的 9 个列, 卡还没开始搭
 *      就花掉 9 步。
 *
 * 这个文件锁住这三条。
 */

const test = require('node:test');
const assert = require('node:assert');

const { EngineAiBuilder, normalizeBuilderLimits, MAX_TURNS, MAX_ROUNDS, BUILDER_LIMITS } = require('../lib/engine-ai');
const Engine = require('../lib/engine');
const { AgentLoop } = require('../lib/agent-loop');
const { ToolRegistry } = require('../lib/tools');

function toolCall(name, args, id) {
  return {
    id: id || 'call_' + name + '_' + Math.random().toString(36).slice(2, 7),
    name,
    args: args || {},
    rawArguments: JSON.stringify(args || {})
  };
}

class FakeLLM {
  constructor(script) {
    this.script = Array.isArray(script) ? script : [script];
    this.calls = [];
  }
  async chatStep(messages) {
    const turn = this.calls.length;
    this.calls.push({ messages });
    const raw = this.script[Math.min(turn, this.script.length - 1)];
    const step = typeof raw === 'function' ? raw(turn, messages) : raw;
    if (!step) return { content: '', toolCalls: [] };
    if (step.calls) return { content: step.content || '', toolCalls: step.calls };
    if (step.call) return { content: step.content || '', toolCalls: [step.call] };
    return { content: step.content || '', toolCalls: [] };
  }
}

function blankCard() {
  const c = Engine.newEngine();
  const inp = (c.nodes || []).find((n) => n.type === 'input');
  if (inp) inp.fields = [];
  return Engine.normalizeEngine(c);
}

function makeBuilder(script, extra) {
  const llm = new FakeLLM(script);
  const builder = new EngineAiBuilder(Object.assign({
    llm,
    pool: { db1: ['invoice_red_apply'] },
    card: blankCard(),
    databases: [{ id: 'db1', name: 'SRM', type: 'mysql', host: 'h', port: 3306, database: 'd', user: 'u' }],
    openDb: () => fakeDb()
  }, extra || {}));
  return { llm, builder };
}

function fakeDb() {
  return {
    async query(sql) {
      if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ total: 100, nonnull: 98, uniq: 4 }] };
      return { rows: [{ v: 'A' }, { v: 'B' }] };
    },
    async describeTable() { return [{ field: 'no', type: 'varchar' }]; },
    async close() {}
  };
}

/** 永远在调一个无害的只读工具, 永远不收尾 —— 必然跑满预算 */
const NEVER_STOPS = [{ call: toolCall('list_available_tables', {}) }];

/* ============================================================
 * B: 自动续跑 —— 不用用户来说"继续"
 * ============================================================ */

test('步数跑满会自动接着跑下一轮 (不再要求用户说"继续")', async () => {
  const { llm, builder } = makeBuilder(NEVER_STOPS);
  const evs = [];
  const r = await builder.send('一直查表, 不收尾', (ev) => evs.push(ev), { maxSteps: 2, maxRounds: 3 });

  assert.strictEqual(r.exhausted, true, '三轮都跑满了, 仍然是 exhausted');
  assert.strictEqual(r.rounds, 3, '应该自动跑了 3 轮');
  assert.strictEqual(r.steps, 6, '2 步 x 3 轮 = 6 步');
  assert.ok(llm.calls.length >= 6, '真的调了 6 次以上模型, 实际 ' + llm.calls.length);

  // 续跑之间要说一声, 否则界面上会莫名其妙多出一堆动作
  const notices = evs.filter((e) => e.type === 'ai_act' && /自动接着往下搭/.test(String(e.text || '')));
  assert.strictEqual(notices.length, 2, '3 轮之间有 2 次续跑提示, 实际 ' + notices.length);
});

test('maxRounds 就是上限: 设成 1 就只跑一轮 (和修复前一样)', async () => {
  const { llm, builder } = makeBuilder(NEVER_STOPS);
  const r = await builder.send('一直查表', () => {}, { maxSteps: 2, maxRounds: 1 });

  assert.strictEqual(r.rounds, 1);
  assert.strictEqual(r.steps, 2);
  assert.strictEqual(r.exhausted, true);
  assert.ok(llm.calls.length <= 3, '只该跑一轮, 实际调了 ' + llm.calls.length + ' 次');
});

test('模型自己收尾了就不续跑', async () => {
  const { llm, builder } = makeBuilder([{ content: '好了, 不用查了' }]);
  const r = await builder.send('看看', () => {}, { maxSteps: 2, maxRounds: 3 });

  assert.strictEqual(llm.calls.length, 1, '模型不收尾才续跑, 收尾了就停');
  assert.ok(!r.exhausted, '正常收尾不该报 exhausted');
});

test('用尽之后的消息不再把活推给用户, 而是说清跑了多少步', async () => {
  const { builder } = makeBuilder(NEVER_STOPS);
  const r = await builder.send('一直查表', () => {}, { maxSteps: 2, maxRounds: 2 });

  assert.match(r.error, /步数/, '要提到步数');
  assert.match(r.error, /2 轮/, '要说清跑了几轮');
  assert.match(r.error, /4 步/, '要说清一共多少步');
  // 单轮时告诉用户去哪调大 —— 这是真的可调了 (以前是硬编码常量)
  assert.strictEqual(/配置 · 引擎/.test(r.error), false, '菜单位置不能写错');
});

test('单轮就用尽时, 提示里去哪里调步数', async () => {
  const { builder } = makeBuilder(NEVER_STOPS);
  const r = await builder.send('一直查表', () => {}, { maxSteps: 2, maxRounds: 1 });
  assert.match(r.error, /设置 · 通用 · 搭建流程卡/, '要指对地方: ' + r.error);
});

test('要问用户时立刻停下, 不续跑 (续跑会在没答案的情况下自己往下搭)', async () => {
  const { llm, builder } = makeBuilder([
    { call: toolCall('ask_user', { question: '哪个仓？' }) },
    { call: toolCall('list_available_tables', {}) }
  ]);
  const r = await builder.send('搭卡', () => {}, { maxSteps: 2, maxRounds: 3 });

  assert.ok(r.ask, '要把问题交出去');
  assert.strictEqual(llm.calls.length, 1, '问完就该停, 不该再调模型');
});

/* ============================================================
 * B2: nudge 要轮次感知
 *
 * 有下一轮的时候叫模型"收敛"是有害的: 它会提前交一份半成品,
 * 而本来只要接着干就行。
 * ============================================================ */

function loopWith(script, budget) {
  const llm = new FakeLLM(script);
  const tools = new ToolRegistry();
  tools.add('read_a', '读 A', { type: 'object', properties: {} }, async () => 'A', { readOnly: true, group: 'data' });
  const loop = new AgentLoop({
    llm, tools,
    system: '测试',
    messages: [{ role: 'user', content: '干活' }],
    budget,
    emit: () => {}
  });
  return { llm, loop };
}

test('nudge: 没有下一轮 -> 叫模型收敛', async () => {
  const { llm, loop } = loopWith([{ call: toolCall('read_a') }], { maxSteps: 4 });
  await loop.run();
  const saw = llm.calls.some((c) => c.messages.some((m) => /请立刻收敛/.test(String(m.content || ''))));
  assert.ok(saw, '最后一轮该催它收尾');
});

test('nudge: 还有下一轮 -> 叫它别急 (否则会提前交半成品)', async () => {
  const { llm, loop } = loopWith([{ call: toolCall('read_a') }], { maxSteps: 4, continues: true });
  await loop.run();

  const all = llm.calls.flatMap((c) => c.messages.map((m) => String(m.content || ''))).join('\n');
  assert.ok(/不用急着收尾/.test(all), '有下一轮时该告诉它别急: ' + all.slice(-400));
  assert.strictEqual(/请立刻收敛/.test(all), false, '有下一轮时不能叫它收敛');
});

/* ============================================================
 * A: 取消通道
 *
 * 以前这条是死代码 —— send 从来没拿到过 cancel。
 * 没有停止按钮的自动续跑 = 失控烧 token, 所以这两件事必须一起做。
 * ============================================================ */

test('取消: 令牌置上就以 cancelled 收场, 不报成 exhausted', async () => {
  const { builder } = makeBuilder(NEVER_STOPS);
  const cancel = { v: false };
  // 第二步之后就取消
  const llm = builder.llm;
  const orig = llm.chatStep.bind(llm);
  let n = 0;
  llm.chatStep = async (...args) => { n += 1; if (n >= 2) cancel.v = true; return orig(...args); };

  const r = await builder.send('一直查表', () => {}, { cancel, maxSteps: 2, maxRounds: 3 });

  assert.strictEqual(r.cancelled, true, '要报成"取消"而不是"步数用尽"');
  assert.ok(!r.exhausted, '取消不是 exhausted');
  assert.match(r.error, /已停止/, '要跟用户说清是停下来了');
});

test('取消: 不会续跑下一轮', async () => {
  const { builder } = makeBuilder(NEVER_STOPS);
  const cancel = { v: true };   // 一开始就是取消状态
  const r = await builder.send('一直查表', () => {}, { cancel, maxSteps: 2, maxRounds: 3 });
  assert.strictEqual(r.cancelled, true, '该报成取消');
  assert.strictEqual(r.rounds, 1, '取消之后不该续跑, 只该走完第一轮就停');
});

test('不传 cancel 时行为不变 (老调用方不受影响)', async () => {
  const { builder } = makeBuilder(NEVER_STOPS);
  const r = await builder.send('一直查表', () => {}, { maxSteps: 2, maxRounds: 1 });
  assert.strictEqual(r.exhausted, true);
  assert.ok(!r.cancelled);
});

/* ============================================================
 * C: 预算可配
 * ============================================================ */

test('取值范围: 默认值就是那三个常量, 不会对不上', () => {
  const d = normalizeBuilderLimits(undefined);
  assert.strictEqual(d.maxSteps, MAX_TURNS, '默认步数必须等于 MAX_TURNS');
  assert.strictEqual(d.maxRounds, MAX_ROUNDS, '默认轮数必须等于 MAX_ROUNDS');
});

test('取值范围: 越界夹到边界 (不是悄悄换成默认值)', () => {
  assert.deepStrictEqual(normalizeBuilderLimits({ maxSteps: 9999, maxRounds: 99 }),
    { maxSteps: BUILDER_LIMITS.maxSteps.max, maxRounds: BUILDER_LIMITS.maxRounds.max });
  assert.deepStrictEqual(normalizeBuilderLimits({ maxSteps: -5, maxRounds: 0 }),
    { maxSteps: BUILDER_LIMITS.maxSteps.min, maxRounds: BUILDER_LIMITS.maxRounds.min });
});

test('取值范围: 垃圾输入退回默认值', () => {
  const d = normalizeBuilderLimits({ maxSteps: 'abc', maxRounds: null });
  assert.strictEqual(d.maxSteps, MAX_TURNS);
  assert.strictEqual(d.maxRounds, MAX_ROUNDS);
});

test('取值范围: 上限不是无限的 (否则一次对话能烧掉一整天的额度)', () => {
  assert.ok(BUILDER_LIMITS.maxSteps.max <= 200, '步数上限要有节制');
  assert.ok(BUILDER_LIMITS.maxRounds.max <= 10, '轮数上限要有节制');
});

/* ============================================================
 * D: look_at_data 一次看多列
 *
 * 每次工具调用吃一步预算。实测一个会话里 9 次 look_at_data 看的是
 * 同一张表的 9 个列 —— 卡还没开始搭就花掉 9 步。
 * ============================================================ */

async function actsFor(call) {
  const { builder } = makeBuilder([{ call }, { content: '好了' }]);
  const evs = [];
  await builder.send('看看', (ev) => evs.push(ev), { maxSteps: 5, maxRounds: 1 });
  return evs.filter((e) => e.type === 'ai_act').map((e) => String(e.text || ''));
}

test('look_at_data: 一次给 columns 数组, 全都看', async () => {
  const acts = await actsFor(toolCall('look_at_data', {
    dbId: 'db1', table: 'invoice_red_apply', columns: ['bill_no', 'no', 'cp_no']
  }));
  const hit = acts.filter((t) => /看了真实数据/.test(t));
  assert.strictEqual(hit.length, 1, '一次调用只报一行');
  for (const c of ['bill_no', 'no', 'cp_no']) {
    assert.match(hit[0], new RegExp(c), '要说出看过的列: ' + c + ' —— 实际 ' + hit[0]);
  }
});

test('look_at_data: 单列的老写法照旧能用', async () => {
  const acts = await actsFor(toolCall('look_at_data', {
    dbId: 'db1', table: 'invoice_red_apply', column: 'bill_no'
  }));
  const hit = acts.filter((t) => /看了真实数据/.test(t));
  assert.strictEqual(hit.length, 1);
  assert.match(hit[0], /bill_no/);
});

test('look_at_data: column 和 columns 一起给会合并去重', async () => {
  const acts = await actsFor(toolCall('look_at_data', {
    dbId: 'db1', table: 'invoice_red_apply', column: 'bill_no', columns: ['bill_no', 'no']
  }));
  const hit = acts.filter((t) => /看了真实数据/.test(t));
  assert.strictEqual(hit.length, 1);
  const m = hit[0].match(/bill_no/g) || [];
  assert.strictEqual(m.length, 1, '重复的列名只报一次: ' + hit[0]);
  assert.match(hit[0], /no/);
});

test('look_at_data: 一次看多列时, 工具结果里每列都有独立结论', async () => {
  const { builder } = makeBuilder([
    { call: toolCall('look_at_data', { dbId: 'db1', table: 'invoice_red_apply', columns: ['bill_no', 'no'] }) },
    { content: '好了' }
  ]);
  await builder.send('看看', () => {}, { maxSteps: 5, maxRounds: 1 });
  const toolMsg = builder.messages.filter((m) => m.role === 'tool').map((m) => String(m.content || '')).join('\n');
  assert.match(toolMsg, /列 bill_no:/, '第一列要有自己的结论');
  assert.match(toolMsg, /列 no:/, '第二列也要有 —— 只给第一列的话模型会以为后面的没看');
});

test('look_at_data: 既不传 column 也不传 columns -> 明确报错, 不静默成功', async () => {
  const acts = await actsFor(toolCall('look_at_data', { dbId: 'db1', table: 'invoice_red_apply' }));
  assert.strictEqual(acts.filter((t) => /看了真实数据/.test(t)).length, 0, '没看成就不该报成看过了');
});

test('look_at_data: 千万行的表降级成抽样, 并在结果里说清是抽样', async () => {
  // 实测那张表 1055 万行, 全表 COUNT(DISTINCT) 单列 11.6 秒 —— 一次看 7 列就是 80 秒
  const db = {
    async query(sql) {
      if (/information_schema\.TABLES/.test(sql)) return { rows: [{ n: 10556391 }] };
      if (/COUNT\(\*\) AS total/.test(sql)) return { rows: [{ total: 50000, nonnull: 50000, uniq: 800 }] };
      if (/GROUP BY/.test(sql)) return { rows: [{ v: 'PO2025', n: 3 }] };
      return { rows: [{ v: 'PO20250328008262' }] };
    },
    async close() {}
  };
  const { builder } = makeBuilder(
    [
      { call: toolCall('look_at_data', { dbId: 'db1', table: 'invoice_red_apply', columns: ['bill_no'] }) },
      { content: '好了' }
    ],
    { openDb: () => db }
  );
  await builder.send('看看这张表', () => {}, { maxSteps: 5, maxRounds: 1 });
  const toolMsg = builder.messages.filter((m) => m.role === 'tool').map((m) => String(m.content || '')).join('\n');
  assert.match(toolMsg, /跳过全表统计/, '大表要跳过全表统计');
  assert.match(toolMsg, /前 50000 行抽样/, '要说清口径是抽样');
  assert.match(toolMsg, /JOIN/, '要给出换个办法的指引 (列统计答不了关联问题)');
});
