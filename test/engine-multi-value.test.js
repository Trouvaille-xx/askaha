'use strict';

/**
 * AI 走流程卡时"一个输入项里塞了多个单号"的回归测试。
 *
 * 实测踩出来的 (比亚迪送货单卡):
 *   用户一次给 3 个 SO, 抽取那一步把它们拼成 'a,b,c' 塞进 orderNo,
 *   引擎只拦"空值"不拦"一个值里塞了多个", 渲染成 WHERE ORDER_ID = 'a,b,c',
 *   查不到任何行, 结论却是"查无数据"。用户连纠正两次还是被拼成一个值。
 *
 * 这里守的是: 抽取**之后**代码要把多个同形单号拆开, 逐个各跑一遍卡 ——
 * 不靠提示词赌模型自觉。每张卡都不用改。
 */

const test = require('node:test');
const assert = require('node:assert');

const AgentMod = require('../lib/agent.js');
const Engine = require('../lib/engine.js');

/* ---------- 桩 ---------- */

const BYD_CARD = {
  id: 'card_byd', name: '比亚迪送货单签收状态查询', enabled: true,
  nodes: [
    { id: 'n_in', type: 'input', title: '入口', fields: [{ key: 'orderNo', label: 'SO 单号', required: true, desc: 'OPC 销售订单号，形如 SO178937315868747377' }] },
    { id: 'n_q', type: 'query', title: '按SO查签收', databaseId: 'd1', table: 'purchase_order_send_record', sql: "SELECT * FROM purchase_order_send_record WHERE ORDER_ID = '{{orderNo}}'" },
    { id: 'n_out', type: 'output', title: '结论', template: '单号 {{orderNo}} 查到了' }
  ],
  edges: [
    { from: 'n_in', to: 'n_q', port: 'out' },
    { from: 'n_q', to: 'n_out', port: 'out' }
  ]
};

const DB_CONF = [{ id: 'd1', name: 'DB1', type: 'mysql', database: 'd' }];

/** 假库: 记下每条 SQL, 按 ORDER_ID 回一行 */
function makeOpenDb(log) {
  return (conf) => ({
    type: conf.type,
    config: conf,
    async query(sql) {
      log.push(sql);
      const m = /ORDER_ID = '([^']*)'/.exec(sql);
      return { columns: ['ORDER_ID'], rows: [{ ORDER_ID: m ? m[1] : '' }], rowCount: 1, elapsedMs: 1 };
    },
    async close() {}
  });
}

/** 假 LLM: 抽取那一步返回固定的 {inputs, matched}。别的不需要 (卡不写库)。 */
function makeLlm(extractReply) {
  return {
    config: { apiKey: 'fake', model: 'fake' },
    async chatStep() {
      return { content: JSON.stringify(extractReply), toolCalls: [], usage: { input: 1, output: 1 } };
    },
    _extractJSON(raw) { return raw; }
  };
}

function makeAgent(llm, openDb) {
  return new AgentMod({
    llm,
    database: null,
    skills: null,
    tableInventory: [],
    engines: [BYD_CARD],
    databases: DB_CONF,
    openDb
  });
}

const THREE_SO = ['SO176407374468369160', 'SO176794826790537183', 'SO177215413850010929'];

/* ============================================================
 * 核心: 拼成一个值 -> 拆成三个, 各跑一遍
 * ============================================================ */

test('抽取把 3 个 SO 拼成逗号串 -> 拆开, 逐单各跑一遍, 每单一句 SQL', async () => {
  const sqlLog = [];
  // 关键: 抽取那一步**复现 bug** —— 返回的就是拼起来的逗号串
  const llm = makeLlm({
    inputs: { orderNo: THREE_SO.join(',') },
    matched: [{ key: 'orderNo', why: '用户给了3个SO' }]
  });
  const agent = makeAgent(llm, makeOpenDb(sqlLog));

  const events = [];
  const res = await agent._runEngine('card_byd', '这三个帮我看下', (ev) => events.push(ev), {});

  assert.strictEqual(sqlLog.length, 3, '必须逐单各跑一条 SQL, 而不是把 3 个拼成一条: ' + JSON.stringify(sqlLog));
  for (let i = 0; i < 3; i++) {
    assert.ok(sqlLog[i].includes(`ORDER_ID = '${THREE_SO[i]}'`),
      `第 ${i + 1} 单要用它自己的单号查, 实际: ${sqlLog[i]}`);
  }
  // 任何一条 SQL 都不许再把三个单号拼在一起
  assert.ok(!sqlLog.some((s) => s.includes(',')), 'SQL 里不该出现被拼起来的逗号串');

  assert.strictEqual(res.engine.batch, true);
  assert.strictEqual(res.engine.runs.length, 3);
  assert.ok(res.reply.includes(THREE_SO[0]) && res.reply.includes(THREE_SO[2]), '结论里要能看到每个单号的结果');
});

test('空格分隔的 3 个 SO 一样拆开', async () => {
  const sqlLog = [];
  const llm = makeLlm({
    inputs: { orderNo: THREE_SO.join(' ') },
    matched: []
  });
  const agent = makeAgent(llm, makeOpenDb(sqlLog));
  await agent._runEngine('card_byd', '三个SO', () => {}, {});
  assert.strictEqual(sqlLog.length, 3);
});

test('单个 SO 不拆, 走原来的单跑路径', async () => {
  const sqlLog = [];
  const llm = makeLlm({ inputs: { orderNo: THREE_SO[0] }, matched: [] });
  const agent = makeAgent(llm, makeOpenDb(sqlLog));
  const res = await agent._runEngine('card_byd', '查这一个', () => {}, {});
  assert.strictEqual(sqlLog.length, 1, '单值就该只跑一遍');
  assert.ok(!res.engine.batch, '单值不该走批量');
});

test('拿不准的值不拆 (保守): 一个单号 + 一句中文说明, 仍按单值处理', async () => {
  const sqlLog = [];
  const llm = makeLlm({ inputs: { orderNo: THREE_SO[0] + '，查不到的话告诉我' }, matched: [] });
  const agent = makeAgent(llm, makeOpenDb(sqlLog));
  await agent._runEngine('card_byd', '查一下', () => {}, {});
  // 'SO...' 像单号, 但 '查不到的话告诉我' 是中文说明, 不该被当成第二个单号 → 只有 1 段是单号 → 不拆
  assert.strictEqual(sqlLog.length, 1, '只有一个像单号就不该拆: ' + JSON.stringify(sqlLog));
});

test('一轮失败不拖死整批: 第 2 单查不到, 1、3 单照样出结果', async () => {
  const openDb = (conf) => ({
    type: conf.type, config: conf,
    async query(sql) {
      if (sql.includes(THREE_SO[1])) throw new Error('这一单超时');
      const m = /ORDER_ID = '([^']*)'/.exec(sql);
      return { columns: ['ORDER_ID'], rows: [{ ORDER_ID: m ? m[1] : '' }], rowCount: 1, elapsedMs: 1 };
    },
    async close() {}
  });
  const llm = makeLlm({ inputs: { orderNo: THREE_SO.join(',') }, matched: [] });
  const agent = makeAgent(llm, openDb);
  const res = await agent._runEngine('card_byd', '三个', () => {}, {});
  assert.strictEqual(res.engine.runs.length, 3, '三单都要有各自的结果行');
  assert.ok(res.reply.includes('没跑成'), '失败的那一单要如实说出来, 而不是悄悄漏掉');
});
