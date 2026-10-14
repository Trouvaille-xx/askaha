'use strict';

/**
 * 每步的耗时与 token —— 让"慢"变成可定位的数字。
 *
 * 起因 (2026-09-21): 用户看着搭建面板说"它一直在想", 而事后翻日志
 * **一个耗时数字都没有**, 想复盘只能靠猜。追下去才发现真相是:
 * 17 次模型往返里有 13 次 look_at_data, 每次都在千万行的表上做全表统计,
 * 光工具就吃掉大半时间 —— 而界面上那段时间和"模型卡住了"长得一模一样。
 *
 * 所以这套账必须分得开: 模型往返多少 (llmMs) / 工具执行多少 (toolMs) /
 * 哪个工具最贵 (byTool)。混成一个总数就只能继续猜。
 */

const test = require('node:test');
const assert = require('node:assert');

const { EngineAiBuilder } = require('../lib/engine-ai');
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

/** 会报 usage 和耗时的假模型 —— 真网关就是这么回的 */
class FakeLLM {
  constructor(script, opts = {}) {
    this.script = Array.isArray(script) ? script : [script];
    this.calls = [];
    this.usage = opts.usage || { input: 4321, output: 210 };
    this.elapsedMs = opts.elapsedMs == null ? 7 : opts.elapsedMs;
  }
  async chatStep() {
    const turn = this.calls.length;
    this.calls.push(turn);
    const raw = this.script[Math.min(turn, this.script.length - 1)];
    const step = typeof raw === 'function' ? raw(turn) : raw;
    const calls = step && step.call ? [step.call] : (step && step.calls) || [];
    return {
      content: (step && step.content) || '',
      toolCalls: calls,
      usage: this.usage,
      elapsedMs: this.elapsedMs
    };
  }
}

function blankCard() {
  const c = Engine.newEngine();
  const inp = (c.nodes || []).find((n) => n.type === 'input');
  if (inp) inp.fields = [];
  return Engine.normalizeEngine(c);
}

/** 假库: 每条查询睡 sleepMs, 用来制造"工具很慢" */
function fakeDb(sleepMs) {
  return {
    async query(sql) {
      if (sleepMs) await new Promise((r) => setTimeout(r, sleepMs));
      if (/information_schema\.TABLES/i.test(sql)) return { rows: [{ n: 100 }] };
      if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ total: 100, nonnull: 98, uniq: 4 }] };
      return { rows: [{ v: 'A' }, { v: 'B' }] };
    },
    async describeTable() { return [{ field: 'no', type: 'varchar' }]; },
    async close() {}
  };
}

function makeBuilder(script, opts = {}) {
  const llm = new FakeLLM(script, opts);
  const builder = new EngineAiBuilder({
    llm,
    pool: { db1: ['invoice_red_apply'] },
    card: blankCard(),
    databases: [{ id: 'db1', name: 'SRM', type: 'mysql', host: 'h', port: 3306, database: 'd', user: 'u' }],
    openDb: () => fakeDb(opts.sleepMs)
  });
  return { llm, builder };
}

/* ============================================================
 * 1. 运行时: 每一步都记账
 * ============================================================ */

test('AgentLoop: 工具耗时记在事件上, 也记进总账', async () => {
  const events = [];
  const tools = new ToolRegistry();
  tools.add('slow', 'x', { type: 'object', properties: {} }, async () => {
    await new Promise((r) => setTimeout(r, 40));
    return 'ok';
  }, { readOnly: true, group: 'build' });
  const llm = new FakeLLM([{ call: toolCall('slow', {}) }, { content: '完了' }], { elapsedMs: 5 });
  const loop = new AgentLoop({
    llm, tools, system: 's', messages: [], budget: { maxSteps: 3 }, emit: (e) => events.push(e), ctx: {}
  });
  const res = await loop.run();

  const tr = events.find((e) => e.type === 'tool_result' && e.name === 'slow');
  assert.ok(tr, '要有 tool_result 事件');
  assert.ok(tr.elapsedMs >= 35, '工具耗时要在事件上, 实际 ' + tr.elapsedMs);
  const us = events.find((e) => e.type === 'usage');
  assert.ok(us && Number.isFinite(us.elapsedMs), 'usage 事件要带上这一步的模型往返耗时');
  assert.strictEqual(us.elapsedMs, 5, '模型自己报了耗时就用它 (它含重试)');

  assert.ok(res.timing.toolMs >= 35, '总账里有工具耗时');
  assert.ok(res.timing.byTool.slow >= 35, '按工具名分开记: ' + JSON.stringify(res.timing.byTool));
  assert.strictEqual(res.timing.byToolCalls.slow, 1, '次数也要记 —— 判断"是不是在反复查"靠它');
  assert.strictEqual(res.timing.llmMs, 10, '两次模型调用各 5ms');
});

test('AgentLoop: 工具抛错也要入账 (又慢又挂的那个最该被看到)', async () => {
  const events = [];
  const tools = new ToolRegistry();
  tools.add('boom', 'x', { type: 'object', properties: {} }, async () => {
    await new Promise((r) => setTimeout(r, 30));
    throw new Error('查库挂了');
  }, { readOnly: true, group: 'build' });
  const llm = new FakeLLM([{ call: toolCall('boom', {}) }, { content: '算了' }]);
  const loop = new AgentLoop({
    llm, tools, system: 's', messages: [], budget: { maxSteps: 3 }, emit: (e) => events.push(e), ctx: {}
  });
  await loop.run().catch(() => {});
  assert.ok(loop.timing !== undefined || loop.toolMs >= 25,
    '抛错路径也要记账, 实际 toolMs=' + loop.toolMs);
  assert.strictEqual(loop.byToolCalls.boom, 1, '挂掉的那次也要计数');
});

/* ============================================================
 * 2. 搭建面板: 每步带耗时, 收尾报总账
 * ============================================================ */

test('每一步的动作后面带上秒数 (1 秒以下不报, 免得全是噪音)', () => {
  const { builder } = makeBuilder([{ content: '好' }]);
  const acts = [];
  const emit = (ev) => acts.push(ev);
  const say = () => {};
  builder._onLoopEvent({
    type: 'tool_result', name: 'look_at_data', args: { table: 't', columns: ['a'] },
    ok: true, elapsedMs: 82400
  }, emit, say);
  assert.match(acts[0].text, /看了真实数据：t\.a · 82\.4s/, '慢的那一步要能一眼看出来: ' + acts[0].text);

  acts.length = 0;
  builder._onLoopEvent({
    type: 'tool_result', name: 'look_at_data', args: { table: 't', columns: ['a'] },
    ok: true, elapsedMs: 300
  }, emit, say);
  assert.strictEqual(/s$/.test(acts[0].text), false, '亚秒级不报数: ' + acts[0].text);
});

test('收尾时报总账: 模型多少 / 工具多少 / 哪个工具最贵 / token', async () => {
  const { builder } = makeBuilder(
    [{ call: toolCall('look_at_data', { dbId: 'db1', table: 'invoice_red_apply', columns: ['bill_no'] }) }, { content: '好了' }],
    { sleepMs: 30, usage: { input: 4321, output: 210 }, elapsedMs: 8 }
  );
  const evs = [];
  await builder.send('看看这张表', (ev) => evs.push(ev), { maxSteps: 5, maxRounds: 1 });

  const spent = evs.find((e) => e.type === 'ai_spent');
  assert.ok(spent, '要发一条结构化的 ai_spent 给界面画图');
  assert.strictEqual(spent.spent.byToolCalls.look_at_data, 1);
  assert.ok(spent.spent.byTool.look_at_data >= 20, '工具耗时:' + spent.spent.byTool.look_at_data);
  // 一次工具调用 = 两次模型往返 (调工具那轮 + 收尾那轮), 每次各报 4321 进
  assert.strictEqual(spent.spent.calls, 2, '模型被调了几次也要如实记账');
  assert.strictEqual(spent.spent.input, 4321 * spent.spent.calls, 'token 要按真实调用次数累加');
  assert.strictEqual(spent.spent.output, 210 * spent.spent.calls, 'token 出');
  assert.ok(spent.spent.llmMs >= 0 && spent.spent.steps >= 1);

  // 人也要能看见: 对话流里得有一句总结
  const line = evs.filter((e) => e.type === 'ai_act').map((e) => e.text).find((t) => /这一轮一共/.test(String(t)));
  assert.ok(line, '对话流里要有总账那一行');
  assert.match(line, /模型 .*秒/);
  assert.match(line, /工具 .*秒/);
  assert.match(line, /look_at_data x1/);
  assert.match(line, new RegExp('token ' + (4321 * 2) + ' 进 / ' + (210 * 2) + ' 出'));
});

test('跑满多轮时报的是总账, 不是最后一轮 (否则会看着很便宜)', async () => {
  // 脚本里**每一轮**都得有动作, 否则模型那一轮就算收尾, 不会续跑 (见 builder-budget)
  const { builder } = makeBuilder(
    [{ call: toolCall('list_available_tables', {}) }],
    { sleepMs: 25, elapsedMs: 4 }
  );
  const evs = [];
  await builder.send('一直查', (ev) => evs.push(ev), { maxSteps: 2, maxRounds: 3 });
  const spent = evs.find((e) => e.type === 'ai_spent');
  assert.strictEqual(spent.spent.rounds, 3, '实际跑了 3 轮');
  assert.ok(spent.spent.byToolCalls.list_available_tables >= 5,
    '三轮的调用都要算进去, 实际 ' + spent.spent.byToolCalls.list_available_tables);
  assert.match(
    evs.filter((e) => e.type === 'ai_act').map((e) => String(e.text)).find((t) => /这一轮一共/.test(t)),
    /\(3 轮\)/,
    '总账里要说清是几轮的合计'
  );
});

test('出错 / 被停止时也要报总账 —— 那正是最需要看时间花在哪的时候', async () => {
  const { builder } = makeBuilder([{ call: toolCall('look_at_data', { dbId: 'db1', table: 'nope', column: 'x' }) }]);
  const evs = [];
  await builder.send('看看', (ev) => evs.push(ev), { maxSteps: 2, maxRounds: 1 });
  assert.ok(evs.some((e) => e.type === 'ai_spent'), '没成功也要报账');
  assert.ok(evs.filter((e) => e.type === 'ai_act').some((e) => /这一轮一共/.test(String(e.text))));
});
