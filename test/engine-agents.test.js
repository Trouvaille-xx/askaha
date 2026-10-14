'use strict';

/**
 * 流程引擎那三个 Agent 的回归测试。
 *
 * 这三个 bug 的共同点是"看不出来": 循环照跑、界面照显示、日志里没有错误,
 * 只是结果在撒谎 —— 取消没取消、用尽当成功、模型看着过期的草稿。
 * 所以每条都要断言"行为", 不能只断言"没抛异常"。
 *
 * 跑法: npm test
 */

const test = require('node:test');
const assert = require('node:assert');

const { EngineAiBuilder } = require('../lib/engine-ai');
const { EngineTester } = require('../lib/engine-tester');
const { runTestLoop } = require('../lib/test-loop');
const Engine = require('../lib/engine');
const LLMClient = require('../lib/llm'); // 这个模块是直接导出类的

/* ============================================================
 * 假 LLM: 按脚本回放工具调用, 并记录每一轮收到的消息
 * ============================================================ */

/** 造一个原生 tool_call (走 _resolve 的第一条路) */
function toolCall(name, args, id) {
  return {
    id: id || 'call_' + name + '_' + Math.random().toString(36).slice(2, 7),
    name,
    args: args || {},
    rawArguments: JSON.stringify(args || {})
  };
}

class FakeLLM {
  /**
   * @param script 每轮的返回值。元素可以是:
   *   { call: toolCall }        -> 这一轮调一个工具
   *   { content: '...' }        -> 这一轮只是说话 (没有动作, 循环会 break)
   *   (turn, messages, llm) => 任意返回值, 想在中途动手脚就用函数
   *   数组用完后重复最后一个。
   */
  constructor(script) {
    this.script = Array.isArray(script) ? script : [script];
    this.calls = [];              // 每一轮的 { messages, tools }
    this.config = { apiKey: 'fake', model: 'fake' };
    this.toolsUnsupported = false;
  }

  async chatStep(messages, tools, opts) {
    const turn = this.calls.length;
    this.calls.push({ messages: messages.map((m) => ({ ...m })), tools, opts });
    const raw = this.script[Math.min(turn, this.script.length - 1)];
    const step = typeof raw === 'function' ? raw(turn, messages, this) : raw;
    if (!step) return { content: '', toolCalls: [] };
    if (step.call) return { content: step.content || '', toolCalls: [step.call] };
    return { content: step.content || '', toolCalls: [] };
  }

  // 让 _resolve 只走原生 tool_calls 那条路, 免得正文被当成动作
  _extractJSON() { return null; }

  /** 第 turn 轮收到的 system 提示词 */
  systemAt(turn) {
    const m = this.calls[turn] && this.calls[turn].messages.find((x) => x.role === 'system');
    return m ? m.content : null;
  }
}

/** 一个最小的、结构合法的空卡 —— 入口不要任何输入 */
function blankCard() {
  const c = Engine.newEngine();
  // 清掉默认输入项。留着的话, 测试 Agent 会先花几轮去"找一个真实的测试数据"
  // (见 EngineTester._inventInputs), 那会把假 LLM 的脚本错位 ——
  // 这个文件测的是编排和步数用尽的逻辑, 不是找数据。
  const inp = (c.nodes || []).find((n) => n.type === 'input');
  if (inp) inp.fields = [];
  return Engine.normalizeEngine(c);
}

/* ============================================================
 * Bug 3: 系统提示词必须每轮重建, 不能一轮冻结
 * ============================================================ */

/**
 * 从零搭卡现在要求先出规划 (见 lib/engine-ai.js 里的规划闸门)。
 *
 * 这个文件测的是编排和提示词刷新, 不是规划 —— 所以直接把规划塞进去当既成事实,
 * 让脚本能照原样跑。**这不是绕过闸门**: 闸门本身的行为在 test/plan-gate.test.js 里测,
 * 这里只是不让它挡住不相干的断言。
 */
function seedPlan(builder) {
  builder.plan = {
    steps: [
      { id: 's1', title: '按脚本建卡', status: 'done' },
      { id: 's2', title: '收尾', status: 'done' }
    ],
    branches: ['结论'],
    unknowns: [],
    revision: 1,
    at: Date.now()
  };
  return builder;
}

test('提示词不冻结: 第 2 轮能看到第 1 轮刚加的节点', async () => {
  // 第 1 轮加一个取数节点, 第 2 轮只是说话收尾。
  // 提示词里含"当前草稿"快照 —— 冻结的话, 第 2 轮看到的草稿里没有这个新节点。
  const llm = new FakeLLM([
    { call: toolCall('add_node', { nodeType: 'query', title: '查采购订单' }) },
    { content: '搭好了' }
  ]);
  const builder = seedPlan(new EngineAiBuilder({
    llm,
    pool: {},
    card: blankCard(),
    databases: [],
    openDb: () => { throw new Error('这个测试不该连库'); }
  }));

  await builder.send('加一个取数节点', () => {});

  assert.ok(llm.calls.length >= 2, `至少该有两轮, 实际 ${llm.calls.length}`);
  const sys1 = llm.systemAt(0);
  const sys2 = llm.systemAt(1);
  assert.ok(sys1 && sys2, '两轮都该有 system 提示词');

  // 第 1 轮时卡里还没有这个节点
  assert.ok(!sys1.includes('查采购订单'), '第 1 轮不该已经看到还没加的节点');
  // 第 2 轮必须看到 —— 这就是"每轮重建"的证据
  assert.ok(
    sys2.includes('查采购订单'),
    '第 2 轮的提示词里必须包含第 1 轮刚加的节点 (否则模型看的是过期草稿)'
  );
  // 而且两轮的提示词确实不一样
  assert.notStrictEqual(sys1, sys2, '两轮的系统提示词不该完全相同');
});

test('提示词不冻结: 连续两轮改动都在下一轮可见', async () => {
  // 改同一个节点两次, 看每一轮的提示词里是哪一次的名字。
  // 冻结的提示词会让第 2、3 轮都还看到第 1 次的名字。
  const card = blankCard();
  const input = (card.nodes || []).find((n) => n.type === 'input');
  assert.ok(input, '空卡应该自带一个入口节点');

  const llm = new FakeLLM([
    { call: toolCall('set_node_title', { nodeId: input.id, title: '第一轮的名字' }) },
    { call: toolCall('set_node_title', { nodeId: input.id, title: '第二轮的名字' }) },
    { content: '好了' }
  ]);
  const builder = seedPlan(new EngineAiBuilder({
    llm, pool: {}, card, databases: [],
    openDb: () => { throw new Error('这个测试不该连库'); }
  }));

  await builder.send('改两遍标题', () => {});

  const s0 = llm.systemAt(0);
  const s1 = llm.systemAt(1);
  const s2 = llm.systemAt(2);
  assert.ok(s0 && s1 && s2, '三轮都该有提示词');

  // 第 1 轮: 两个名字都还没有
  assert.ok(!s0.includes('第一轮的名字'), '第 1 轮不该提前看到还没改的名字');
  // 第 2 轮: 看得到第 1 轮的改动, 还看不到第 2 轮的
  assert.ok(s1.includes('第一轮的名字'), '第 2 轮必须看到第 1 轮改的名字');
  assert.ok(!s1.includes('第二轮的名字'), '第 2 轮不该提前看到第 2 轮的名字');
  // 第 3 轮: 看到第 2 轮的改动 —— 这一条就是"每轮重建"的决定性证据
  assert.ok(s2.includes('第二轮的名字'), '第 3 轮必须看到第 2 轮改的名字 (否则模型看的是过期草稿)');
  assert.ok(!s2.includes('第一轮的名字'), '第 3 轮不该还显示上一版名字');
});

/* ============================================================
 * Bug 2: 步数用尽必须显式报出来, 不能当成"改完了"
 * ============================================================ */

test('步数用尽: send() 返回 exhausted, 不再谎报 ok:true', async () => {
  // 每一轮都调一个无害的只读工具, 永远不收尾 —— 必然跑满 MAX_TURNS
  const llm = new FakeLLM([{ call: toolCall('list_available_tables', {}) }]);
  const builder = new EngineAiBuilder({
    llm,
    pool: {},
    card: blankCard(),
    databases: [],
    openDb: () => { throw new Error('这个测试不该连库'); }
  });

  const r = await builder.send('一直查表, 永远不收尾', () => {});

  assert.strictEqual(r.exhausted, true, '跑满步数必须标记 exhausted');
  assert.strictEqual(r.ok, false, '用尽不能报 ok:true');
  assert.strictEqual(r.done, false, '用尽不算 done');
  assert.match(r.error, /步数/, '要给一句人话说明');
  assert.ok(r.card, '半成品卡仍要带回来, 方便用户自己看');
});

test('正常收尾: 调 finish 之后不报 exhausted', async () => {
  const llm = new FakeLLM([{ call: toolCall('finish', { summary: '搭完了' }) }]);
  const builder = new EngineAiBuilder({
    llm,
    pool: {},
    card: blankCard(),
    databases: [],
    openDb: () => { throw new Error('这个测试不该连库'); }
  });
  // finish 有个硬闸门: 没真跑通过就不许收尾。这里测的是"收尾之后别报用尽",
  // 不是那个闸门, 所以直接把闸门放行 (真跑需要数据库)。
  builder.tested = { validated: true, ran: true };

  const r = await builder.send('随便搭一下', () => {});
  assert.strictEqual(r.ok, true, 'finish 应该正常收尾');
  assert.strictEqual(r.done, true);
  assert.ok(!r.exhausted, '正常收尾不该带 exhausted');
});

test('finish 硬闸门仍然生效: 没跑通过就不许收尾', async () => {
  // 这条是防回归: 我改的是"用尽怎么上报", 不该把 finish 的闸门一起放开。
  const llm = new FakeLLM([{ call: toolCall('finish', { summary: '搭完了' }) }]);
  const builder = new EngineAiBuilder({
    llm, pool: {}, card: blankCard(), databases: [],
    openDb: () => { throw new Error('这个测试不该连库'); }
  });
  // 不放行 tested: 没跑通过
  const r = await builder.send('随便搭一下', () => {});
  assert.ok(!r.done || r.exhausted, '没跑通就 finish 不该被当成正常收尾');
});

test('明确没有下一步: 也不算用尽', async () => {
  // 模型只回一句话、不给动作 —— 这是"我做完了/没什么可做的", 不是被截断
  const llm = new FakeLLM([{ content: '这张卡已经齐了, 不用再改。' }]);
  const builder = new EngineAiBuilder({
    llm,
    pool: {},
    card: blankCard(),
    databases: [],
    openDb: () => { throw new Error('这个测试不该连库'); }
  });

  const r = await builder.send('还要改什么吗', () => {});
  assert.ok(!r.exhausted, '没有动作是正常结束, 不该判成用尽');
  assert.strictEqual(r.ok, true);
});

/* ============================================================
 * Bug 1: 取消必须真的停下来
 * ============================================================ */

/** 造一个 runTestLoop 的运行环境: 不连库, 全用假件 */
function loopEnv(script, overrides) {
  const llm = new FakeLLM(script);
  const events = [];
  const cancelled = Object.assign({ v: false, aborted: 0, abort() { this.aborted += 1; } }, overrides);
  return {
    llm,
    events,
    cancelled,
    args: {
      card: blankCard(),
      inputs: {},
      pool: {},
      emit: (ev) => events.push(ev),
      cancelled,
      llm,
      llmConf: { apiKey: 'fake', model: 'fake' },
      databases: [],
      openDb: () => { throw new Error('这个测试不该连库'); }
    }
  };
}

test('取消: 开跑前就取消 -> 立刻返回 cancelled, 一次 LLM 都不调', async () => {
  const env = loopEnv([{ call: toolCall('report', { verdict: 'pass', summary: 'x' }) }], { v: true });
  const r = await runTestLoop(env.args);

  assert.strictEqual(r.verdict, 'cancelled', '必须报 cancelled');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(env.llm.calls.length, 0, '取消之后一次模型调用都不该发生');
  assert.ok(
    !env.events.some((e) => e.phase === 'fix'),
    '取消之后不该再启动开发 Agent'
  );
});

test('取消: 诊断中途取消 -> 不进开发 Agent, 不跑第二轮', async () => {
  // 诊断循环第一轮就把取消标志立起来。测试 Agent 会返回一份带建议的 fail 报告,
  // 编排层必须在调开发 Agent 之前发现取消并退出。
  const env = loopEnv([
    (turn, messages, self) => {
      env.cancelled.v = true;      // 模拟用户在这一刻点了停止
      return { call: toolCall('report', {
        verdict: 'fail',
        summary: '没跑通',
        rootCause: '字段名错了',
        fixes: [{ action: 'configure_query', nodeId: 'n_q1', detail: '把列名改成 po_no' }]
      }) };
    }
  ]);

  const r = await runTestLoop(env.args);

  assert.strictEqual(r.verdict, 'cancelled');
  assert.ok(!env.events.some((e) => e.phase === 'fix'), '取消后不该启动开发 Agent');
  // 只应该有第 1 轮的 test 事件
  const testRounds = env.events.filter((e) => e.type === 'test_round' && e.phase === 'test');
  assert.strictEqual(testRounds.length, 1, `只该跑 1 轮测试, 实际 ${testRounds.length}`);
});

test('取消: 在飞请求被 abort() 掐掉, 循环以 cancelled 收场', async () => {
  // 用一个永不响应的假服务器当模型端点, 这样 chatStep 会一直挂着。
  // 然后调 abort() —— 循环必须醒来并报 cancelled, 而不是干等超时。
  const http = require('node:http');
  const server = http.createServer(() => { /* 故意不响应 */ });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  // 无论断言成功与否都要关掉, 否则这个 socket 会把整个测试进程挂住
  const sockets = [];
  server.on('connection', (s) => sockets.push(s));

  try {
    const client = new LLMClient({
      baseURL: `http://127.0.0.1:${port}/v1`,
      apiKey: 'fake',
      model: 'fake',
      timeoutMs: 30000          // 超时故意设很长, 证明是 abort 起的作用
    });

    const cancelled = { v: false, abort: () => client.abort('用户取消了自动测试') };
    const env = loopEnv([{ call: toolCall('report', { verdict: 'pass', summary: 'x' }) }]);
    env.args.llm = client;
    env.args.cancelled = cancelled;

    const p = runTestLoop(env.args);
    // 等请求真的发出去, 再按停止
    await new Promise((r) => setTimeout(r, 200));
    cancelled.v = true;
    cancelled.abort();

    // 计时器要能收掉, 否则它会把整个测试进程多挂 6 秒
    let capTimer;
    const cap = new Promise((_, rej) => {
      capTimer = setTimeout(() => rej(new Error('取消没生效: 循环还挂着')), 6000);
    });
    let r;
    try {
      r = await Promise.race([p, cap]);
    } finally {
      clearTimeout(capTimer);
    }

    assert.strictEqual(
      r.verdict, 'cancelled',
      `取消后必须报 cancelled (实际 ${r.verdict}) —— 注意 abort 会让测试 Agent 以"模型调用失败"收场, 那也要认成取消`
    );
    assert.strictEqual(r.ok, false);
  } finally {
    for (const s of sockets) s.destroy();
    server.close();
  }
});

test('没取消时: 循环照常走到结束 (别把取消做成"总是取消")', async () => {
  const env = loopEnv([{ call: toolCall('report', { verdict: 'pass', summary: '跑通了' }) }]);
  const r = await runTestLoop(env.args);
  // 卡是空卡, 真跑必然不通 -> 走不到 pass。这里只要求它没被误判成 cancelled。
  assert.notStrictEqual(r.verdict, 'cancelled', '没取消就不该报 cancelled');
});

/* ============================================================
 * 编排层: 开发 Agent 用尽 -> verdict 'limit', 不再假装改完
 * ============================================================ */

test('开发 Agent 步数用尽 -> verdict limit, 且不继续下一轮', async () => {
  // 测试 Agent 每轮都给建议; 开发 Agent 永远只查表不收尾 -> 必然用尽。
  // 脚本按调用顺序给: 第 1 个是诊断, 后面全是开发 Agent 的轮次。
  let firstDiagnosis = true;
  const llm = new FakeLLM([
    () => {
      if (firstDiagnosis) {
        firstDiagnosis = false;
        return { call: toolCall('report', {
          verdict: 'fail',
          summary: '没跑通',
          rootCause: '列名错了',
          fixes: [{ action: 'configure_query', nodeId: 'n_q1', detail: '换成 po_no' }]
        }) };
      }
      return { call: toolCall('list_available_tables', {}) };
    }
  ]);
  const env = loopEnv([{ call: toolCall('list_available_tables', {}) }]);
  env.args.llm = llm;

  const r = await runTestLoop(env.args);

  assert.strictEqual(r.verdict, 'limit', `开发 Agent 用尽应报 limit, 实际 ${r.verdict}`);
  assert.strictEqual(r.ok, false, 'limit 不能报 ok:true');
  assert.match(r.error || '', /步数用尽/);
  // 关键: 用尽之后必须停下, 不能再进第 2 轮测试
  const testRounds = env.events.filter((e) => e.type === 'test_round' && e.phase === 'test');
  assert.strictEqual(testRounds.length, 1, `用尽后不该继续下一轮, 实际跑了 ${testRounds.length} 轮`);
  // 也不该再说"改完了"
  assert.ok(
    !env.events.some((e) => /改完了/.test(e.message || '')),
    '用尽之后不该出现"改完了"这种话'
  );
});

test('轮次记录如实反映"有没有改完"', async () => {
  const llm = new FakeLLM([{ call: toolCall('list_available_tables', {}) }]);
  const env = loopEnv([{ call: toolCall('report', {
    verdict: 'fail', summary: '不通', rootCause: 'x',
    fixes: [{ action: 'configure_query', nodeId: 'n_q1', detail: 'y' }]
  }) }]);
  env.args.llm = llm;

  const r = await runTestLoop(env.args);
  assert.strictEqual(r.rounds.length, 1);
  assert.strictEqual(r.rounds[0].fixesApplied, false, '用尽的那一轮 fixesApplied 必须是 false');
  assert.strictEqual(r.rounds[0].exhausted, true);
});
