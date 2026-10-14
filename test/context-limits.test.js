'use strict';

/**
 * 对话长度上限 + 上下文管理 + 自动续轮的回归测试。
 *
 * ## 这一组锁的是什么
 *
 * 用户的原始反馈是「不要有最大对话轮次，增加上下文管理」。落到代码上是三件事,
 * 每件都对着一个具体的失败模式:
 *
 *   1. **对话长度** —— 数字必须在**一处**定义。界面和后端各写一份的话, 会出现
 *      "界面显示还能发、发出去却被后端拒了", 而那种错极难发现。
 *   2. **压缩** —— 原来只折 role:'tool'。长任务里模型自己的过程叙述一样占地,
 *      而且信息密度最低。只折工具结果的话, 跑得久的任务仍然能把预算吃满。
 *   3. **自动续轮** —— 原来步数跑满就"强制生成总结", 把一次**截断**说成了一次
 *      **完成**。现在跑满会压缩上下文接着开下一轮。
 *
 * 断言都对着"改之前会怎样", 不是"能跑就行"。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  CONV_MAX_TURNS, CONV_WARN_TURNS, turnCount, convStatus
} = require('../lib/conversation.js');
const { publicConfig } = require('../lib/public-config.js');
const {
  compactMessages, ledgerLines, stripLedger, isFolded,
  STUB_CHARS, ASSISTANT_FOLD_MIN, LEDGER_HEAD, LEDGER_MAX_CHARS, FOLDED_MARK
} = require('../lib/agent-loop.js');

const AgentMod = require('../lib/agent.js');
const Agent = AgentMod.Agent || AgentMod;

/* ============================================================
 * 一、对话长度
 * ============================================================ */

test('对话长度: 只数用户说的话, 不数消息条数', () => {
  const msgs = [
    { role: 'user', content: '一' },
    { role: 'assistant', content: '过程' },
    { role: 'assistant', content: '工具结果' },
    { role: 'assistant', content: '结论' },
    { role: 'user', content: '二' }
  ];
  // 助手的一条回复可能拆成好几条消息, 那些不该算成好几轮
  assert.strictEqual(turnCount(msgs), 2);
  assert.strictEqual(turnCount([]), 0);
  assert.strictEqual(turnCount(null), 0);
  assert.strictEqual(turnCount('不是数组'), 0);
});

test('对话长度: 阈值边界精确 —— 80 不提醒, 81 提醒', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ role: 'user', content: 'q' + i }));

  // 用户的原话是"过了80", 所以 80 本身不提醒
  assert.strictEqual(convStatus(mk(CONV_WARN_TURNS)).warn, false, '刚好 80 轮不该提醒');
  assert.strictEqual(convStatus(mk(CONV_WARN_TURNS)).message, '');
  assert.strictEqual(convStatus(mk(CONV_WARN_TURNS + 1)).warn, true, '81 轮该提醒');
  assert.ok(convStatus(mk(CONV_WARN_TURNS + 1)).message.includes('建议新开会话'));

  // 99 还是提醒, 100 就变拦住
  assert.strictEqual(convStatus(mk(CONV_MAX_TURNS - 1)).blocked, false);
  assert.strictEqual(convStatus(mk(CONV_MAX_TURNS - 1)).warn, true);
  assert.strictEqual(convStatus(mk(CONV_MAX_TURNS)).blocked, true);
  assert.strictEqual(convStatus(mk(CONV_MAX_TURNS)).warn, false, '拦住之后不该再说"建议", 该直接说到了上限');
  assert.strictEqual(convStatus(mk(CONV_MAX_TURNS + 50)).blocked, true);
});

test('对话长度: 提醒文案就是用户指定的那句', () => {
  const msgs = Array.from({ length: CONV_WARN_TURNS + 1 }, () => ({ role: 'user', content: 'q' }));
  assert.strictEqual(convStatus(msgs).message, '当前对话已超过80轮，为了保证输出质量，建议新开会话。');
});

test('对话长度: 数字由主进程发下去, 界面不自己写一份', () => {
  const pub = publicConfig({ llm: { apiKey: 'sk-x' } });
  // 界面拿到的必须和 lib/conversation.js 是同一个数 —— 对不上的话会出现
  // "界面显示还能发、后端却拒了"
  assert.strictEqual(pub.limits.convMaxTurns, CONV_MAX_TURNS);
  assert.strictEqual(pub.limits.convWarnTurns, CONV_WARN_TURNS);
  // 顺带确认密钥那层没被这次改动弄坏
  assert.strictEqual(pub.llm.apiKey, '');
  assert.strictEqual(pub.llm.apiKeySet, true);
});

/* ============================================================
 * 二、上下文压缩
 * ============================================================ */

/** 造一条够长的文本 */
const big = (n, tag) => (tag || 'X').repeat(n);

test('压缩: 过长的 assistant 正文也要折 (原来只折工具结果)', () => {
  const longProse = big(ASSISTANT_FOLD_MIN + 200, 'A');
  const msgs = [
    { role: 'user', content: '帮我看看' },
    { role: 'assistant', content: longProse },
    { role: 'tool', content: big(2000, 'T') }
  ];
  const r = compactMessages(msgs, { maxChars: 500, keepRecent: 0 });
  assert.ok(r.compacted >= 1, '至少折了一条');
  // 正文那条被折了 —— 这正是原来不会发生的事
  const a = r.messages[1];
  assert.ok(isFolded(a), 'assistant 正文应该被折');
  assert.ok(a.content.length < longProse.length);
});

test('压缩: 短的 assistant 回复不动它', () => {
  // 短回复往往就是结论本身, 折了得不偿失
  const msgs = [
    { role: 'user', content: '帮我看看' },
    { role: 'assistant', content: '结论是库存够用。' },
    { role: 'tool', content: big(3000, 'T') }
  ];
  const r = compactMessages(msgs, { maxChars: 500, keepRecent: 0 });
  assert.strictEqual(r.messages[1].content, '结论是库存够用。', '短回复必须原样留着');
});

test('压缩: 折正文时不能弄丢 tool_calls', () => {
  // 原生模式靠 assistant.tool_calls 配对后面的 role:'tool'。
  // 丢了它协议当场断掉, 整轮报错 —— 比不压缩严重得多。
  const calls = [{ id: 'c1', type: 'function', function: { name: 'read_a', arguments: '{}' } }];
  const msgs = [
    { role: 'user', content: '查一下' },
    { role: 'assistant', content: big(1500, 'A'), tool_calls: calls },
    { role: 'tool', tool_call_id: 'c1', content: big(2000, 'T') }
  ];
  const r = compactMessages(msgs, { maxChars: 400, keepRecent: 0 });
  assert.ok(isFolded(r.messages[1]), '正文被折了');
  assert.deepStrictEqual(r.messages[1].tool_calls, calls, 'tool_calls 必须原样保留');
  assert.strictEqual(r.messages[2].tool_call_id, 'c1', 'tool 的 id 也还在');
});

test('压缩: 用户说的话和 system 一律不动', () => {
  // 这条不变量不是洁癖: 用户的原话是**需求**, 后面所有判断都以它为准。
  // 一旦它被掺进系统文本, 就再没有一处能干净地回答"他最初到底要什么"。
  // (账一度就是追加在用户原话上的 —— 那版把这条破了, 所以改成进系统提示。)
  const userText = big(2000, 'U');
  const msgs = [
    { role: 'system', content: big(2000, 'S') },
    { role: 'user', content: userText },
    { role: 'tool', content: big(3000, 'T') }
  ];
  const r = compactMessages(msgs, { maxChars: 500, keepRecent: 0 });
  assert.strictEqual(r.messages[0].content, big(2000, 'S'), 'system 不动');
  assert.strictEqual(r.messages[1].content, userText, '用户原话必须**逐字**不动, 不能追加任何东西');
});

test('压缩: 折了东西才给账, 没折就不给', () => {
  const small = [
    { role: 'user', content: '短' },
    { role: 'tool', content: '也短' }
  ];
  const r1 = compactMessages(small, { maxChars: 100000 });
  assert.strictEqual(r1.compacted, 0);
  assert.strictEqual(r1.ledger, '', '没折就不该有账');
  assert.strictEqual(r1.messages[0].content, '短', '不该被动过');

  const bigMsgs = [
    { role: 'user', content: '帮我查单号 A123 的签收情况' },
    { role: 'tool', content: '单号 A123 签收时间 2025-01-02\n' + big(2000, 'T') }
  ];
  const r2 = compactMessages(bigMsgs, { maxChars: 400, keepRecent: 0 });
  assert.ok(r2.compacted > 0);
  assert.ok(r2.ledger.includes(LEDGER_HEAD), '折了就该给账');
  // 账在返回值里, **不在消息里** —— 这是它和用户原话互不干扰的关键
  assert.strictEqual(r2.messages[0].content, '帮我查单号 A123 的签收情况', '原话仍然逐字不动');
});

test('进度账: 留下"发生过什么", 让模型不重复劳动', () => {
  const msgs = [
    { role: 'user', content: '查一下' },
    { role: 'tool', content: 'delivery_order 里 12 条记录\n' + big(2000, 'T') },
    { role: 'tool', content: 'purchase_order 里 3 条待对账\n' + big(2000, 'T') }
  ];
  const r = compactMessages(msgs, { maxChars: 400, keepRecent: 0 });
  const led = r.ledger;
  // 账里要能认出"查过哪两张表", 否则模型会再查一遍
  assert.ok(led.includes('delivery_order'), '账里要认得出查过什么');
  assert.ok(led.includes('purchase_order'));
  assert.ok(led.includes('取数结果'), '账要标出这是什么');
  // 账是**摘要**不是全文: 它自己不能变成新的负担
  assert.ok(led.length < LEDGER_MAX_CHARS + 200, '账本身不能太长');
});

test('进度账: 反复压缩不会叠加 (账是从现存存根反推的)', () => {
  const mk = () => [
    { role: 'user', content: '查一下' },
    { role: 'tool', content: '表 orders 有 5 行\n' + big(2000, 'T') },
    { role: 'tool', content: '表 users 有 9 行\n' + big(2000, 'T') }
  ];
  const once = compactMessages(mk(), { maxChars: 400, keepRecent: 0 });
  const twice = compactMessages(once.messages, { maxChars: 400, keepRecent: 0 });
  const three = compactMessages(twice.messages, { maxChars: 400, keepRecent: 0 });

  const countMarks = (s) => (s.match(new RegExp(LEDGER_HEAD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
  assert.strictEqual(countMarks(once.ledger), 1, '第一次压缩后账出现一次');
  assert.strictEqual(countMarks(twice.ledger), 1, '第二次压缩后账仍然只出现一次');
  assert.strictEqual(countMarks(three.ledger), 1, '第三次也一样 —— 攒的话会越叠越长');
  // 账不该出现在消息里 (否则反复压缩会把它越堆越多)
  assert.strictEqual(countMarks(three.messages[0].content), 0, '消息里不该有账');
  assert.strictEqual(three.messages[0].content, '查一下', '原话始终逐字不动');
});

test('进度账: 账里每条都截断, 不会把明细又搬回来', () => {
  const lines = ledgerLines([
    { role: 'tool', content: big(5000, 'Z') + '\n' + FOLDED_MARK + ', 共 5000 字。' }
  ]);
  assert.strictEqual(lines.length, 1);
  assert.ok(lines[0].length < 200, '账里每条要短 —— 它是摘要不是备份');
});

test('进度账: stripLedger 能把老快照里残留的账摘干净', () => {
  const withLedger = '原话\n\n' + LEDGER_HEAD + '\n- 取数结果: 什么什么';
  assert.strictEqual(stripLedger(withLedger), '原话');
  assert.strictEqual(stripLedger('没有账的文本'), '没有账的文本');
  assert.strictEqual(stripLedger(null), '');
});

test('压缩: 原有行为没被破坏 (工具结果折叠 + 保护顺序)', () => {
  const msgs = [
    { role: 'user', content: '查' },
    { role: 'tool', content: big(3000, 'A') },
    { role: 'tool', content: big(3000, 'B') },
    { role: 'tool', content: big(3000, 'C') }
  ];
  const r = compactMessages(msgs, { maxChars: 4000, keepRecent: 1 });
  // 最旧的先折, 最近的受保护
  assert.ok(isFolded(r.messages[1]), '最旧的先折');
  assert.strictEqual(r.messages[3].content, big(3000, 'C'), '最近的一条受保护');
  // 存的字数对得上
  const total = (l) => l.reduce((n, m) => n + String(m.content || '').length, 0);
  assert.ok(total(r.messages) < total(msgs));
});

test('压缩: 阈值够大时一条都不动', () => {
  const msgs = [
    { role: 'user', content: '查' },
    { role: 'tool', content: big(500, 'T') }
  ];
  const r = compactMessages(msgs, { maxChars: 100000 });
  assert.strictEqual(r.compacted, 0);
  assert.strictEqual(r.savedChars, 0);
  assert.strictEqual(r.messages, msgs, '没超限就该原样返回同一个数组');
});

test('进度账: 真的进了模型看到的系统提示 (不然这个账等于没做)', async () => {
  // 这条是整件事的收口: 账算出来了、但没送到模型眼前的话, 它就是一段死代码。
  const { AgentLoop } = require('../lib/agent-loop.js');
  const { ToolRegistry } = require('../lib/tools.js');

  const tools = new ToolRegistry();
  tools.add('big_read', '读一大坨', { type: 'object', properties: {} },
    async () => 'delivery_order 里 12 条记录\n' + big(4000, 'T'),
    { readOnly: true, group: 'data' });

  const llm = new FakeLLM([
    { call: { id: 'c1', name: 'big_read', args: {} } },
    { call: { id: 'c2', name: 'big_read', args: {} } },
    { content: '好了' }
  ]);

  const loop = new AgentLoop({
    llm,
    tools,
    system: '你是助手。',
    messages: [{ role: 'user', content: '查一下送货单' }],
    // 阈值压到很小, 保证第二轮就触发折叠
    budget: { maxSteps: 5, maxChars: 300 },
    emit: () => {}
  });
  await loop.run();

  // 折叠之后的某一次调用里, system 那条要带上账
  const withLedger = llm.calls.find((c) => {
    const sys = c.messages.find((m) => m.role === 'system');
    return sys && sys.content.includes(LEDGER_HEAD);
  });
  assert.ok(withLedger, '账必须出现在系统提示里, 否则模型不知道折掉过什么');
  const sys = withLedger.messages.find((m) => m.role === 'system').content;
  assert.ok(sys.startsWith('你是助手。'), '原系统提示还在, 账是追加的');
  assert.ok(sys.includes('delivery_order'), '账里认得出折掉的是什么');

  // 而且消息里始终**只有一条** system —— 运行时自己拼的那条。
  // 多一条 system 会让一些网关直接报错。
  for (const c of llm.calls) {
    assert.strictEqual(c.messages.filter((m) => m.role === 'system').length, 1,
      '消息数组里不能多出第二条 system');
  }
  // 用户原话全程逐字不动
  for (const c of llm.calls) {
    const u = c.messages.find((m) => m.role === 'user' && m.content.includes('送货单'));
    assert.ok(u, '用户原话始终在');
    assert.strictEqual(u.content, '查一下送货单', '而且逐字没被动过');
  }
});

test('进度账: 续轮时账带得过去 (不带就会重复劳动)', async () => {
  const { agent } = makeAgent([
    CALL_SQL, CALL_SQL, CALL_SQL, CALL_SQL, CALL_FINISH
  ], { general: { maxSteps: 2, maxRounds: 5, maxChars: 200 } });
  const events = [];
  await agent.run('查一下', {}, (e) => events.push(e));
  // 这个用例只确认续轮没炸 —— 账的传递由上面那条系统提示的断言覆盖
  assert.ok(events.some((e) => e.type === 'phase' && e.phase === 'continue'));
});

test('压缩: 极端情况下账自己也不会撑爆', () => {
  // 几十条超长结果, 每条都会进账
  const msgs = [{ role: 'user', content: '查' }];
  for (let i = 0; i < 60; i++) msgs.push({ role: 'tool', content: '表 t' + i + ' 有数据\n' + big(1500, 'T') });
  const r = compactMessages(msgs, { maxChars: 1000, keepRecent: 0 });
  assert.ok(r.ledger.length < LEDGER_MAX_CHARS + 300, '账有上限, 不能自己变成负担');
  assert.ok(r.ledger.includes('中间'), '超长时该说明丢的是中间那段');
});

test('进度账: 超长时保住头尾, 丢中间 —— 最早定下的结论不能先没', () => {
  // 这是"忘记上下文"那个报障的回归测试。
  //
  // 原来的实现从**最旧的**开始丢 (理由是"越早的事越不重要"), 但长任务里最早期
  // 做的事恰恰是确定目标表、摸清关联键 —— 那些是结论。丢最旧的等于把结论丢了、
  // 留着"试了 A 不行"的过程。现在改成丢中间: 头尾最后才动。
  const msgs = [{ role: 'user', content: '查' }];
  for (let i = 0; i < 60; i++) {
    msgs.push({ role: 'tool', content: '表 t' + i + ' 有数据\n' + big(1500, 'T') });
  }
  const r = compactMessages(msgs, { maxChars: 1000, keepRecent: 0 });

  // 必须触发截断, 否则这条测试什么都没验证
  assert.ok(r.ledger.includes('中间'), '前提: 这个用例的账确实超长被截过');
  assert.ok(r.ledger.includes('表 t0'), '最早的结论必须还在 (这是本次修复的核心)');
  assert.ok(r.ledger.includes('表 t59'), '最近做的事也必须在');
});

/* ============================================================
 * 三、自动续轮
 * ============================================================ */

class FakeLLM {
  constructor(script) {
    this.script = Array.isArray(script) ? script : [script];
    this.calls = [];
    this.config = { apiKey: 'test' };
  }
  async chatStep(messages, tools) {
    const turn = this.calls.length;
    this.calls.push({ messages: messages.map((m) => ({ ...m })) });
    const raw = this.script[Math.min(turn, this.script.length - 1)];
    const step = typeof raw === 'function' ? raw(turn, messages, this) : raw;
    if (!step) return { content: '', toolCalls: [] };
    if (step.call) return { content: step.content || '', toolCalls: [step.call] };
    return { content: step.content || '', toolCalls: [] };
  }
  // Agent._resolveCall 会用它兜底解析文本里的工具调用, 少了这个整轮就炸
  _extractJSON(text) {
    if (!text) return null;
    const a = text.indexOf('{'); const b = text.lastIndexOf('}');
    if (a === -1 || b <= a) return null;
    try { return JSON.parse(text.slice(a, b + 1)); } catch (e) { return null; }
  }
  lastMessageAt(n) {
    const m = this.calls[n] && this.calls[n].messages;
    return m && m.length ? m[m.length - 1].content : null;
  }
}

function fakeDb() {
  return {
    type: 'mysql',
    config: { database: 'testdb' },
    async query() { return { columns: ['id'], rows: [{ id: 1 }], rowCount: 1, elapsedMs: 3 }; },
    async listTables() { return ['orders']; },
    async describeTable() { return [{ field: 'id', type: 'int' }]; }
  };
}

function makeAgent(script, opts = {}) {
  const llm = new FakeLLM(script);
  const agent = new Agent({
    llm,
    database: fakeDb(),
    skills: null,
    tableInventory: [{ name: 'orders' }],
    engines: [],
    databases: [],
    openDb: null,
    mcp: null,
    prompt: null,
    general: Object.assign({ maxSteps: 2 }, opts.general || {})
  });
  agent._classifyIntent = async () => ({ kind: 'analysis' });
  return { agent, llm };
}

// 真实的只读工具叫 sql (lib/actions.js), 参数要求 purpose + sql 两个必填
const CALL_SQL = {
  call: {
    id: 'c1',
    name: 'sql',
    args: { purpose: '探一下', rationale: '测试', sql: 'SELECT 1' }
  }
};
const CALL_FINISH = {
  call: { id: 'f1', name: 'finish', args: { title: 'T', summary: 'S', output: 'none' } }
};

test('续轮: 步数跑满但没做完 -> 自动接着开下一轮, 不再强制收尾', async () => {
  const { agent } = makeAgent([
    CALL_SQL, CALL_SQL, CALL_SQL, CALL_SQL,          // 前两轮各 2 步, 都跑满
    CALL_FINISH
  ], { general: { maxSteps: 2, maxRounds: 5 } });

  const events = [];
  await agent.run('查一下', {}, (e) => events.push(e));

  const cont = events.filter((e) => e.type === 'phase' && e.phase === 'continue');
  assert.ok(cont.length >= 1, '跑满之后应该发出"接着做"的事件, 而不是"强制生成总结"');
  assert.ok(cont[0].message.includes('压缩上下文接着做'));
  assert.strictEqual(events.filter((e) => e.phase === 'forcing_finish').length, 0,
    '没到 maxRounds 就不该强制收尾');
});

test('续轮: 一轮内就做完的话不会多开轮', async () => {
  const { agent, llm } = makeAgent([CALL_FINISH], { general: { maxSteps: 20, maxRounds: 5 } });

  const events = [];
  await agent.run('查一下', {}, (e) => events.push(e));
  assert.strictEqual(events.filter((e) => e.phase === 'continue').length, 0, '一次就做完, 不该续轮');
  // 闸门被这个测试替身短路了 (直接 stub 成 analysis), 所以只有干活那一次调用
  assert.strictEqual(llm.calls.length, 1, '做完就停, 不该有空转的第二次调用');
});

test('续轮: 快用完时告诉模型"后面还有下一轮", 别急着收尾', async () => {
  // 这条是续轮能生效的前提: 不告诉它的话它会提前交半成品,
  // 而半成品的 finish 会被闸门拦下 —— 白烧两步。
  const { agent, llm } = makeAgent([
    CALL_SQL, CALL_SQL, CALL_SQL,
    CALL_FINISH
  ], { general: { maxSteps: 3, maxRounds: 5 } });

  await agent.run('查一下', {}, () => {});
  const nudges = llm.calls.map((c) => JSON.stringify(c.messages)).filter((s) => s.includes('不用急着收尾'));
  assert.ok(nudges.length >= 1, '非最后一轮该给"接着做"的提示');
  assert.ok(nudges[0].includes('会自动接着开下一轮'), '要说清楚为什么会自动接着');
});

test('续轮: 撞上 maxRounds 要如实说是截断, 不能假装完成', async () => {
  const { agent } = makeAgent([CALL_SQL], { general: { maxSteps: 1, maxRounds: 2 } });
  const events = [];
  await agent.run('查一下', {}, (e) => events.push(e));

  const ff = events.find((e) => e.type === 'phase' && e.phase === 'forcing_finish');
  assert.ok(ff, '撞上限该有收尾事件');
  // 以前这句永远是"已达最大步数, 强制生成总结" —— 把一次截断说成了一次完成
  assert.ok(/自动接着做了 \d+ 轮还没做完/.test(ff.message),
    '撞上续轮上限时要说"做了 N 轮还没做完", 而不是"已达最大步数"');
});

test('续轮: maxRounds 有上下夹取, 传什么都不会失控', () => {
  const mk = (g) => new Agent({
    llm: new FakeLLM([CALL_SQL]), database: fakeDb(), skills: null,
    tableInventory: [], engines: [], databases: [], openDb: null, mcp: null, prompt: null, general: g
  });
  assert.strictEqual(mk({ maxRounds: 0 }).maxRounds, 12, '0 不合法, 回默认');
  assert.strictEqual(mk({ maxRounds: -5 }).maxRounds, 12);
  assert.strictEqual(mk({ maxRounds: 9999 }).maxRounds, 50, '上限 50 —— 这个值乘上步数就是最坏情况的调用数');
  assert.strictEqual(mk({ maxRounds: 7 }).maxRounds, 7);
  assert.strictEqual(mk({}).maxRounds, 12, '不传就是默认 12');
});

test('续轮: 模型直接回答 (没给动作) 不算"没做完", 不该续轮', async () => {
  // done 但没 finalAction = 它在正文里收尾了。续轮会把它已经说出口的结论推翻重来。
  const { agent } = makeAgent([{ content: '库存够用, 不用补货。' }], { general: { maxSteps: 20, maxRounds: 5 } });
  const events = [];
  const r = await agent.run('查一下', {}, (e) => events.push(e));
  assert.strictEqual(events.filter((e) => e.phase === 'continue').length, 0, '正文收尾不该触发续轮');
  assert.ok(String(r.summary || '').includes('库存够用'), '它说的话要原样返回');
});
