'use strict';

/**
 * 上下文占用 + 自动选表的回归测试。
 *
 * ## 这一组锁的是什么
 *
 * 两件事都容易"看起来对但实际错", 而且错了都不报错:
 *
 *   1. **上下文占用**。它的分子必须是"最近一次调用的输入 token", 不是累计值。
 *      混了的话一个跑 10 轮的任务会显示成几百百分比 —— 而每一轮其实很空。
 *      用户会因此过早放弃一个还能继续的会话。
 *
 *   2. **自动选表**。它最坏的失败不是报错, 是"选错表但不说", 查出来的数字
 *      看着正常但是错的。所以"挑不出来时必须退回去问"这条要钉死。
 */

const test = require('node:test');
const assert = require('node:assert');

const { AgentLoop } = require('../lib/agent-loop.js');
const { normalizeModel, DEFAULT_CONTEXT_LIMIT } = require('../lib/models.js');

/* ============================================================
 * 一、上下文占用: 记的是"最近一次", 不是累计
 * ============================================================ */

/** 假 LLM: 按脚本依次返回, 每次带上不同的 usage */
function scriptedLLM(script) {
  let i = 0;
  return {
    config: { apiKey: 'x', model: 'm' },
    async chatStep() {
      const step = script[Math.min(i, script.length - 1)];
      i += 1;
      return {
        content: step.content || '',
        toolCalls: step.toolCalls || [],
        usage: step.usage === undefined ? null : step.usage
      };
    }
  };
}

function oneTool() {
  return {
    schemas: () => [{
      type: 'function',
      function: { name: 'noop', description: 'noop', parameters: { type: 'object', properties: {} } }
    }],
    has: (n) => n === 'noop',
    run: async () => 'ok'
  };
}

async function runLoop(script) {
  const events = [];
  const loop = new AgentLoop({
    llm: scriptedLLM(script),
    tools: oneTool(),
    system: 's',
    emit: (e) => events.push(e),
    maxSteps: 10
  });
  const res = await loop.run('任务');
  return { res, events };
}

test('上下文: 取最近一次调用的输入, 不是累计', async () => {
  // 三次调用输入 100 / 200 / 300。累计是 600, 占用应该是 **300**。
  // 拿 600 去比 128k 上限会显示成 0.5%, 但真正要回答的问题是
  // "提示词现在多大" —— 那是 300。
  const { res } = await runLoop([
    { toolCalls: [{ id: '1', name: 'noop', args: {} }], usage: { input: 100, output: 10 } },
    { toolCalls: [{ id: '2', name: 'noop', args: {} }], usage: { input: 200, output: 10 } },
    { content: 'done', usage: { input: 300, output: 10 } }
  ]);
  assert.strictEqual(res.usage.input, 600, '累计值照旧累加 (算钱用)');
  assert.strictEqual(res.ctx, 300, '占用取最近一次 (判断余量用)');
});

test('上下文: usage 在但没报 input 时不把占用抹成 0', async () => {
  // 关键在"usage 存在、但里面没有 input 字段" —— 有些网关只回 output_tokens。
  // 只判 `if (out.usage)` 是不够的: 那时会走进赋值, 拿到 undefined, 写成 0,
  // 进度条突然归零 —— 用户看来是"上下文被清空了", 比不更新更糟。
  //
  // (用 usage:null 测不到这一点: 那种情况压根进不了 if (out.usage) 块。)
  const { res } = await runLoop([
    { toolCalls: [{ id: '1', name: 'noop', args: {} }], usage: { input: 500, output: 10 } },
    { toolCalls: [{ id: '2', name: 'noop', args: {} }], usage: { output: 10 } },
    { content: 'done', usage: { output: 10 } }
  ]);
  assert.strictEqual(res.ctx, 500, '应保留上一次的真实值, 不能被 undefined 覆盖成 0');
});

test('上下文: usage 里 input 为 0 时也不覆盖', async () => {
  // input: 0 在语义上就是"没报", 不是"这次提示词是空的"(不可能)。
  const { res } = await runLoop([
    { toolCalls: [{ id: '1', name: 'noop', args: {} }], usage: { input: 700, output: 10 } },
    { content: 'done', usage: { input: 0, output: 10 } }
  ]);
  assert.strictEqual(res.ctx, 700);
});

test('上下文: 某次调用没报 usage 时也保留 (usage 为 null)', async () => {
  const { res } = await runLoop([
    { toolCalls: [{ id: '1', name: 'noop', args: {} }], usage: { input: 500, output: 10 } },
    { toolCalls: [{ id: '2', name: 'noop', args: {} }], usage: null },
    { content: 'done', usage: null }
  ]);
  assert.strictEqual(res.ctx, 500);
});

test('上下文: 全程没报 usage 时为 0 (不编数)', async () => {
  const { res } = await runLoop([{ content: 'hi', usage: null }]);
  assert.strictEqual(res.ctx, 0);
  assert.strictEqual(res.usage.calls, 0);
});

test('上下文: usage 事件里带上 ctx, 且是副本', async () => {
  const { events } = await runLoop([
    { toolCalls: [{ id: '1', name: 'noop', args: {} }], usage: { input: 111, output: 1 } },
    { content: 'done', usage: { input: 222, output: 1 } }
  ]);
  const usageEvents = events.filter((e) => e.type === 'usage');
  assert.strictEqual(usageEvents.length, 2);
  assert.strictEqual(usageEvents[0].ctx, 111);
  assert.strictEqual(usageEvents[1].ctx, 222, '第二次事件是新的占用值');
  // 副本: 事件发出去之后对象不能再被就地改掉
  assert.notStrictEqual(usageEvents[0].task, usageEvents[1].task);
});

/* ============================================================
 * 二、上下文上限是模型上的一个可配字段
 * ============================================================ */

test('上限: 有默认值, 且下发', () => {
  const m = normalizeModel({ model: 'x' });
  assert.strictEqual(m.contextLimit, DEFAULT_CONTEXT_LIMIT);
});

test('上限: 下限夹在 1000 (0 会让百分比除零)', () => {
  assert.strictEqual(normalizeModel({ contextLimit: 0 }).contextLimit, 1000);
  assert.strictEqual(normalizeModel({ contextLimit: -5 }).contextLimit, 1000);
  assert.strictEqual(normalizeModel({ contextLimit: 500 }).contextLimit, 1000);
});

test('上限: null / 空串按"没填"走默认, 不变成 1000', () => {
  // Number(null) === 0, 不特判就会被夹到 1000 —— 用户看到的上限会
  // 莫名其妙变成 1k, 而进度条会一直显示 100%。
  assert.strictEqual(normalizeModel({ contextLimit: null }).contextLimit, DEFAULT_CONTEXT_LIMIT);
  assert.strictEqual(normalizeModel({ contextLimit: '' }).contextLimit, DEFAULT_CONTEXT_LIMIT);
});

test('上限: 大值不设上限 (有的模型真到 1M)', () => {
  assert.strictEqual(normalizeModel({ contextLimit: 1000000 }).contextLimit, 1000000);
});

/* ============================================================
 * 三、自动选表: 挑不出来必须退回去问
 * ============================================================ */

/** 造一个能跑 run() 到"选表"那一步的最小 Agent */
function makeAgent(opts) {
  const Agent = require('../lib/agent.js');
  const emitted = [];
  const agent = new Agent({
    llm: opts.llm,
    database: {
      type: 'mysql',
      config: { database: 'd' },
      async listTables() { return opts.tables || ['t_a', 't_b']; },
      async describeTable(t) { return [{ field: 'id', type: 'int' }]; },
      async query() { return { rows: [], fields: [] }; }
    },
    skills: null,
    mcp: null,
    prompt: null,
    general: null,
    engines: [],
    databases: [],
    openDb: null,
    tableInventory: (opts.tables || ['t_a', 't_b']).map((n) => ({ name: n, note: opts.notes ? opts.notes[n] : '' }))
  });
  return { agent, emitted };
}

test('自动选表: 打分成功时自己定下范围, 并报出没备注的表', async () => {
  // 这个假 LLM 会先被闸门调用, 再被 scoreTables 调用。
  // 闸门要回 "analysis" 才会走到选表那一步。
  const calls = [];
  const llm = {
    config: { apiKey: 'x', model: 'm' },
    async chatStep(messages, tools) {
      calls.push('chatStep');
      // 闸门带 system 消息; 选表只有 user 消息 —— 跟真实链路一致 (见 matchTables)
      if ((messages || []).some((m) => m.role === 'system')) {
        return { content: JSON.stringify({ kind: 'analysis' }), toolCalls: [], usage: { input: 50, output: 5 } };
      }
      return { content: await llm.chat(messages), toolCalls: [], usage: { input: 50, output: 5 } };
    },
    async chat(messages) {
      calls.push('chat');
      return '{"scored":[{"name":"t_a","score":0.9,"reason":"相关"}]}';
    },
    _extractJSON(raw) { try { return JSON.parse(raw); } catch (e) { return null; } }
  };
  const { agent, emitted } = makeAgent({ llm, tables: ['t_a', 't_b'], notes: { t_a: '订单表' } });
  const auto = await agent.autoScope('查订单', ['t_a', 't_b'], (e) => emitted.push(e));

  assert.ok(auto, '应该挑出结果');
  assert.deepStrictEqual(auto.tables, ['t_a']);
  assert.deepStrictEqual(auto.noNote, ['t_b'].filter((t) => auto.tables.includes(t)), '没备注的应被标出 (t_a 有备注, 所以为空)');
});

test('自动选表: 打分返回空 -> 返回 null (退回去问用户)', async () => {
  // 这是最关键的一条。硬挑一个 (比如"白名单前 5 张") 会把不确定性藏进结果里,
  // 用户拿到的是看着正常但是错的数字 —— 比多问一句危险得多。
  const llm = {
    config: { apiKey: 'x', model: 'm' },
    // 闸门调用带 system 消息 (见 lib/agent.js _classifyIntent); 选表调用只有一条
    // user 消息 (见 lib/table-match.js matchTables)。按这个分流, 假 LLM 才跟真实链路一致。
    async chatStep(messages) {
      if ((messages || []).some((m) => m.role === 'system')) return { content: 'x', toolCalls: [], usage: null };
      return { content: await llm.chat(messages), toolCalls: [], usage: null };
    },
    async chat() { return '这不是 JSON'; },
    _extractJSON() { return null; }
  };
  const { agent } = makeAgent({ llm });
  const auto = await agent.autoScope('查订单', ['t_a', 't_b'], () => {});
  assert.strictEqual(auto, null, '挑不出来必须返回 null, 让调用方走弹窗');
});

test('自动选表: 打分抛异常 -> 也是 null, 不冒泡炸掉整个任务', async () => {
  const llm = {
    config: { apiKey: 'x', model: 'm' },
    // 闸门调用带 system 消息 (见 lib/agent.js _classifyIntent); 选表调用只有一条
    // user 消息 (见 lib/table-match.js matchTables)。按这个分流, 假 LLM 才跟真实链路一致。
    async chatStep(messages) {
      if ((messages || []).some((m) => m.role === 'system')) return { content: 'x', toolCalls: [], usage: null };
      return { content: await llm.chat(messages), toolCalls: [], usage: null };
    },
    async chat() { throw new Error('网关 500'); },
    _extractJSON() { return null; }
  };
  const { agent } = makeAgent({ llm });
  const auto = await agent.autoScope('查订单', ['t_a', 't_b'], () => {});
  assert.strictEqual(auto, null);
});

test('自动选表: 模型编出来的表名会被丢掉', async () => {
  // scoreTables 的 prompt 里明确要求"只能从上面列出的表里选", 但模型不一定听。
  // 不过滤的话 scope 里会出现一张不存在的表, 后面写 SQL 时才发现 ——
  // 而那时候用户已经在看一条报错的 SQL 了。
  const llm = {
    config: { apiKey: 'x', model: 'm' },
    // 闸门调用带 system 消息 (见 lib/agent.js _classifyIntent); 选表调用只有一条
    // user 消息 (见 lib/table-match.js matchTables)。按这个分流, 假 LLM 才跟真实链路一致。
    async chatStep(messages) {
      if ((messages || []).some((m) => m.role === 'system')) return { content: 'x', toolCalls: [], usage: null };
      return { content: await llm.chat(messages), toolCalls: [], usage: null };
    },
    async chat() { return '{"scored":[{"name":"不存在的表","score":0.99},{"name":"t_a","score":0.5}]}'; },
    _extractJSON(raw) { try { return JSON.parse(raw); } catch (e) { return null; } }
  };
  const { agent } = makeAgent({ llm });
  const auto = await agent.autoScope('查订单', ['t_a', 't_b'], () => {});
  assert.deepStrictEqual(auto.tables, ['t_a'], '只保留白名单里真实存在的表');
});

test('自动选表: prompt 不能退化成"全都要", 也不能退化成"只挑一张"', async () => {
  // 这条钉住的是**提示词的语义**, 不是模型的输出 —— 模型输出会飘, prompt 不会。
  //
  // 两个极端都踩过:
  //   1. 旧措辞「挑出与任务最相关的 min(5, 候选数) 张」—— 候选正好 5 张时这句话
  //      等价于"把 5 张全挑出来", 于是 scope 里永远躺着全部的表。
  //   2. 后来补的「宁少勿多 / 只挑出 1 张是正常结果」—— 又倒向另一头: 在一个必须
  //      JOIN 三张表才拼得出答案的需求上, 它真的只挑 1 张, 结果结构性地查不到数据。
  //      (DSC 那次: 挑中注释逐字重合的回调表, 打分 1.0, 而付款单号根本不在那张表。)
  //
  // 现在的措辞把两件事**分开说**: 候选要列全 (宁多勿漏), 真正要用的要最少 (含 JOIN 链路)。
  // 这两句必须同时在场 —— 少一句就会退回上面某个极端。
  let prompt = '';
  const llm = {
    config: { apiKey: 'x', model: 'm' },
    async chat(messages) {
      prompt = messages.map((m) => m.content).join('\n');
      return '{"scored":[]}';
    },
    _extractJSON(raw) { try { return JSON.parse(raw); } catch (e) { return null; } }
  };
  const five = ['t_a', 't_b', 't_c', 't_d', 't_e'];
  const { agent } = makeAgent({ llm, tables: five });
  await agent.autoScope('查订单', five, () => {});

  assert.ok(prompt, 'prompt 应该被发出去');
  assert.ok(
    !/挑出与任务最相关的\s*5\s*张/.test(prompt),
    '不能再要求"最相关的 5 张" —— 候选只有 5 张时那就是"全都要"'
  );
  assert.ok(/最少需要哪几张/.test(prompt), '选择阶段要它给最小集 —— 否则又变成"多带几张保险"');
  assert.ok(/上限 \d+ 张/.test(prompt), '上限还是要说清楚');
  for (const t of five) assert.ok(prompt.includes(t), `候选 ${t} 必须出现在 prompt 里 (召回不能靠模型自己想起来)`);
});

test('自动选表: 即便匹配层本身没过滤, autoScope 也要过滤', async () => {
  // 上面那条走的是真实的匹配漏斗, 而它**内部已经过滤过一次** —— 所以那条
  // 测的是漏斗的过滤, 不是 autoScope 的。这里直接把漏斗打桩成"返回一个不存在的
  // 表名", 才能真正验证 autoScope 这一层的兜底。
  //
  // 两层都留着是刻意的: 漏斗里的过滤是"按 prompt 约定办事", autoScope 的是
  // "不管上游给什么, 进 scope 的必须真实存在"。少一层就多一条能把幽灵表
  // 送进 SQL 的路。
  const llm = {
    config: { apiKey: 'x', model: 'm' },
    // 闸门调用带 system 消息 (见 lib/agent.js _classifyIntent); 选表调用只有一条
    // user 消息 (见 lib/table-match.js matchTables)。按这个分流, 假 LLM 才跟真实链路一致。
    async chatStep(messages) {
      if ((messages || []).some((m) => m.role === 'system')) return { content: 'x', toolCalls: [], usage: null };
      return { content: await llm.chat(messages), toolCalls: [], usage: null };
    },
    async chat() { return '{}'; },
    _extractJSON() { return null; }
  };
  const { agent } = makeAgent({ llm });
  agent._matchTables = async () => ({
    scored: [{ name: '幽灵表', score: 0.99 }, { name: 't_b', score: 0.5 }],
    picked: ['幽灵表', 't_b'], probes: null, uncertain: '', note: '', degraded: [], timing: {}
  });
  const auto = await agent.autoScope('查订单', ['t_a', 't_b'], () => {});
  assert.deepStrictEqual(auto.tables, ['t_b'], '幽灵表必须被挡在 scope 之外');
});

test('自动选表: 实测证据与"没验过的列"要一路传到界面 (自动模式不弹窗, 这是用户唯一的判断依据)', async () => {
  // 自动模式不弹窗、也不问用户 —— 用户事后只能看 checkpoint 里这几样东西。
  // 链路断了不会报错, 只会静默少一块证据: 界面看起来正常, 但"这些号在哪张表试过"
  // 和"哪一列根本没验过"都没了, 用户就没法判断这次选表靠不靠得住。
  const llm = {
    config: { apiKey: 'x', model: 'm' },
    // 闸门调用带 system 消息 (见 lib/agent.js _classifyIntent); 选表调用只有一条
    // user 消息 (见 lib/table-match.js matchTables)。按这个分流, 假 LLM 才跟真实链路一致。
    async chatStep(messages) {
      if ((messages || []).some((m) => m.role === 'system')) return { content: 'x', toolCalls: [], usage: null };
      return { content: await llm.chat(messages), toolCalls: [], usage: null };
    },
    async chat() { return '{}'; },
    _extractJSON() { return null; }
  };
  const { agent } = makeAgent({ llm });
  const probes = {
    values: ['D32026092200853340'], hits: [{ table: 't_a', column: 'doc_num', value: 'D32026092200853340' }],
    misses: [], missedCols: [{ table: 't_b', column: 'no' }],
    untried: [{ table: 't_b', column: 'invoice', why: '表太大且该列没索引, 没试' }],
    errors: [], tried: 2, elapsedMs: 12, degraded: ''
  };
  agent._matchTables = async () => ({
    scored: [{ name: 't_a', score: 0.9 }], picked: ['t_a'],
    probes, uncertain: '不确定哪个列装的是这个号',
    untriedCols: [{ table: 't_b', column: 'invoice', comment: '请款单', why: '表太大且该列没索引, 没试' }],
    note: '', degraded: [], timing: { digest: 1, probe: 282, llm: 42000, total: 42301 }
  });
  const auto = await agent.autoScope('查 D32026092200853340', ['t_a', 't_b'], () => {});
  assert.strictEqual(auto.probes, probes, '实测结果要原样带出去');
  assert.deepStrictEqual(auto.untriedCols, [{ table: 't_b', column: 'invoice', comment: '请款单', why: '表太大且该列没索引, 没试' }]);
  assert.strictEqual(auto.uncertain, '不确定哪个列装的是这个号');
  // 耗时也要带出去: 用户说"慢"时, 界面要能拆出"模型思考 vs 探测"这两段
  assert.strictEqual(auto.timing.llm, 42000);
});

test('自动选表: 选表结果封顶 8 张 (多带一张就多一次连错表的机会)', async () => {
  const llm = {
    config: { apiKey: 'x', model: 'm' },
    // 闸门调用带 system 消息 (见 lib/agent.js _classifyIntent); 选表调用只有一条
    // user 消息 (见 lib/table-match.js matchTables)。按这个分流, 假 LLM 才跟真实链路一致。
    async chatStep(messages) {
      if ((messages || []).some((m) => m.role === 'system')) return { content: 'x', toolCalls: [], usage: null };
      return { content: await llm.chat(messages), toolCalls: [], usage: null };
    },
    async chat() { return '{}'; },
    _extractJSON() { return null; }
  };
  const names = Array.from({ length: 20 }, (_, i) => `t_${String(i).padStart(2, '0')}`);
  const { agent } = makeAgent({ llm, tables: names });
  agent._matchTables = async () => ({
    scored: names.map((n) => ({ name: n, score: 0.5 })),
    picked: names, probes: null, uncertain: '', note: '', degraded: [], timing: {}
  });
  const auto = await agent.autoScope('查订单', names, () => {});
  assert.strictEqual(auto.tables.length, 8, '硬上限要生效');
  assert.deepStrictEqual(auto.tables, names.slice(0, 8), '按上游给的优先级截断, 不是随机丢');
});

test('自动选表: 上游给的全是幽灵表 -> 返回 null 而不是空 scope', async () => {
  // 返回空 scope 的话 agent 会以为"范围确认过了, 只是没有表", 然后写出
  // 没有表的 SQL; 返回 null 才会退回弹窗让用户挑。
  const llm = {
    config: { apiKey: 'x', model: 'm' },
    // 闸门调用带 system 消息 (见 lib/agent.js _classifyIntent); 选表调用只有一条
    // user 消息 (见 lib/table-match.js matchTables)。按这个分流, 假 LLM 才跟真实链路一致。
    async chatStep(messages) {
      if ((messages || []).some((m) => m.role === 'system')) return { content: 'x', toolCalls: [], usage: null };
      return { content: await llm.chat(messages), toolCalls: [], usage: null };
    },
    async chat() { return '{}'; },
    _extractJSON() { return null; }
  };
  const { agent } = makeAgent({ llm });
  agent.scoreTables = async () => [{ name: '幽灵表', score: 0.99 }];
  const auto = await agent.autoScope('查订单', ['t_a', 't_b'], () => {});
  assert.strictEqual(auto, null);
});

test('自动选表: 挑中的表全都没备注时, noNote 要列全', async () => {
  const llm = {
    config: { apiKey: 'x', model: 'm' },
    // 闸门调用带 system 消息 (见 lib/agent.js _classifyIntent); 选表调用只有一条
    // user 消息 (见 lib/table-match.js matchTables)。按这个分流, 假 LLM 才跟真实链路一致。
    async chatStep(messages) {
      if ((messages || []).some((m) => m.role === 'system')) return { content: 'x', toolCalls: [], usage: null };
      return { content: await llm.chat(messages), toolCalls: [], usage: null };
    },
    async chat() { return '{"scored":[{"name":"t_a","score":0.9},{"name":"t_b","score":0.8}]}'; },
    _extractJSON(raw) { try { return JSON.parse(raw); } catch (e) { return null; } }
  };
  const { agent } = makeAgent({ llm, notes: {} });
  const auto = await agent.autoScope('查订单', ['t_a', 't_b'], () => {});
  assert.deepStrictEqual(auto.noNote.sort(), ['t_a', 't_b'], '两张都没备注, 都要报出来');
});
