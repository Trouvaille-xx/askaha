'use strict';

/**
 * 模型给的表名要先归一化, 再和清单比。
 *
 * 修复前的行为:
 *   `scoreTables` 里是 `.filter((s) => s && s.name && candidates.includes(s.name))`。
 *   模型把表名写成 `opc销售订单库.order_info` 或 `` `order_info` `` 时,
 *   `candidates.includes(...)` 是 false —— 这条结果被**静默丢掉**。
 *
 *   为什么这个 bug 特别难发现:
 *     - 不报错, 不打日志
 *     - 表现只是"AI 挑了 3 张表, 界面上只出现 1 张"
 *     - 模型在提示词里看到的清单**只有表名**, 但它知道库名 (清单行里写着"库: X"),
 *       所以它写 `库名.表名` 是很自然的行为 —— 越聪明的模型越容易踩
 *
 * 同一个洞在 `request_scope` 工具里也有一份 (`args.tables` 也是模型给的):
 *   模型申请 `库名.表名` → 被丢掉 → 它收到"这些表不在清单里",
 *   而它明明在清单里看得见那张表。模型接下来只会反复重试或放弃。
 *
 * 反向约束: 归一化**不能**变成"什么都放行"。清单外的表、臆造的表名, 照样要丢掉,
 * 而且返回的名字必须是**清单里的原样写法** —— 下游到处都在用这个名字查表。
 */

const test = require('node:test');
const assert = require('node:assert');

const AgentMod = require('../lib/agent.js');

const CANDIDATES = ['order_info', 'delivery_order', 'purchase_order'];

/* ---------- 桩 ---------- */

function fakeDb() {
  return {
    type: 'mysql',
    async query() { return { columns: [], rows: [], rowCount: 0, elapsedMs: 1 }; },
    async listTables() { return CANDIDATES; },
    async describeTable() { return [{ field: 'id', type: 'int' }]; },
    targetFor() { return { db: this, dialect: 'mysql', dbName: 'testdb' }; }
  };
}

/** 让 scoreTables 拿到一份固定的模型回答 */
function makeAgent(modelAnswer) {
  return new AgentMod({
    llm: fakeLlm(JSON.stringify(modelAnswer)),
    database: fakeDb(),
    skills: null,
    tableInventory: CANDIDATES.map((n) => ({ name: n, comment: n + ' 的业务说明' })),
    engines: [],
    databases: []
  });
}

/**
 * 假 LLM。**必须两种入口都接**: 选表走 chatStep (它带回 usage/截断标记),
 * 而闸门也是 chatStep —— 区别是闸门带 system 消息、选表只有一条 user 消息。
 * 只实现其中一个, 测的就不是真实链路了。
 */
function fakeLlm(scoredJson) {
  const llm = {
    config: { apiKey: 'x' },
    chat: async () => scoredJson,
    async chatStep(messages) {
      if ((messages || []).some((m) => m.role === 'system')) return { content: '', toolCalls: [] };
      return { content: await llm.chat(messages), toolCalls: [], usage: { input: 1, output: 1 } };
    },
    _extractJSON: (raw) => JSON.parse(raw)
  };
  return llm;
}

const scored = (agent) => agent.scoreTables('随便一个任务', CANDIDATES);

/* ============================================================
 * 1. 核心: 模型写成 库名.表名 也要认出来
 * ============================================================ */

test('库名.表名: 模型写 opc销售订单库.order_info, 不能静默丢掉', async () => {
  const a = makeAgent({ scored: [{ name: 'opc销售订单库.order_info', score: 0.9, reason: '订单表' }] });
  const out = await scored(a);
  assert.strictEqual(out.length, 1, '带库名前缀的表名被丢掉了 —— 表现是"AI 挑了却没出现"');
  assert.strictEqual(out[0].name, 'order_info', '返回的必须是清单里的原样写法, 不能带库名前缀');
});

test('反引号: 模型写 `order_info`, 不能丢掉', async () => {
  const a = makeAgent({ scored: [{ name: '`order_info`', score: 0.9 }] });
  const out = await scored(a);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].name, 'order_info');
});

test('双引号 / 方括号也认 (模型见过多种方言)', async () => {
  for (const raw of ['"order_info"', '[order_info]', '`order_info`']) {
    const a = makeAgent({ scored: [{ name: raw, score: 0.9 }] });
    const out = await scored(a);
    assert.strictEqual(out.length, 1, `${raw} 没被认出来`);
    assert.strictEqual(out[0].name, 'order_info');
  }
});

test('大小写不同: 模型写 Order_Info, 归一化回清单里的 order_info', async () => {
  const a = makeAgent({ scored: [{ name: 'Order_Info', score: 0.9 }] });
  const out = await scored(a);
  assert.strictEqual(out.length, 1, '只是大小写不同, 不该被当成清单外的表');
  assert.strictEqual(out[0].name, 'order_info',
    '必须返回清单里的原样写法 —— 下游到处都在用这个名字查表');
});

test('库名.表名 + 反引号 一起出现', async () => {
  const a = makeAgent({ scored: [{ name: '`opc销售订单库`.`order_info`', score: 0.9 }] });
  const out = await scored(a);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].name, 'order_info');
});

/* ============================================================
 * 2. 反向约束: 归一化不是"什么都放行"
 * ============================================================ */

test('清单外的表照样丢掉 (归一化不能变成放行)', async () => {
  const a = makeAgent({ scored: [{ name: 'secret_payroll', score: 0.99 }] });
  assert.deepStrictEqual(await scored(a), []);
});

test('清单外的表带库名前缀也照样丢掉', async () => {
  const a = makeAgent({ scored: [{ name: '别的库.secret_payroll', score: 0.99 }] });
  assert.deepStrictEqual(await scored(a), []);
});

test('模型臆造的表名丢掉, 不许凭库名前缀"猜"到一张真表', async () => {
  const a = makeAgent({ scored: [{ name: 'opc销售订单库.不存在的表', score: 0.99 }] });
  assert.deepStrictEqual(await scored(a), []);
});

test('空名字 / 只有点 / 只有引号 一律丢掉, 不抛异常', async () => {
  const a = makeAgent({ scored: [
    { name: '', score: 0.9 },
    { name: '.', score: 0.9 },
    { name: '``', score: 0.9 },
    { name: null, score: 0.9 },
    { score: 0.9 }
  ] });
  assert.deepStrictEqual(await scored(a), []);
});

/* ============================================================
 * 3. 正常情形不能被改坏
 * ============================================================ */

test('普通表名原样通过', async () => {
  const a = makeAgent({ scored: [{ name: 'delivery_order', score: 0.8, reason: '送货单' }] });
  const out = await scored(a);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].name, 'delivery_order');
  assert.strictEqual(out[0].score, 0.8);
  assert.strictEqual(out[0].reason, '送货单');
});

test('混合: 有效的留下, 无效的丢掉, 顺序不变', async () => {
  const a = makeAgent({ scored: [
    { name: '库A.order_info', score: 0.9 },
    { name: '不存在的表', score: 0.9 },
    { name: '`delivery_order`', score: 0.7 },
    { name: 'purchase_order', score: 0.5 }
  ] });
  const out = await scored(a);
  assert.deepStrictEqual(out.map((s) => s.name), ['order_info', 'delivery_order', 'purchase_order']);
  assert.deepStrictEqual(out.map((s) => s.score), [0.9, 0.7, 0.5], '顺序和分数都要保持');
});

test('推荐列表封顶仍然生效', async () => {
  // 上限的含义变了, 所以数字也变了 —— 这一条要跟着一起说清楚:
  //   以前 5 是"进 scope 的表数上限" (选表 = 直接用它), 所以卡得很紧。
  //   现在"要查哪几张"由提示词里的「最少需要哪几张 (含 JOIN 链路)」决定, 这一层
  //   只是弹窗里那份**推荐清单**的长度, 另外 autoScope 自己还有一道 8 张的硬上限。
  // 卡不住的话, 弹窗顶部会变成一屏表名, 用户反而看不出哪张是被推荐的。
  const many = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10', 't11'];
  const llm = fakeLlm(JSON.stringify({ scored: many.map((n) => ({ name: n, score: 0.5 })) }));
  const a = new AgentMod({
    llm, database: fakeDb(), skills: null,
    tableInventory: many.map((n) => ({ name: n })), engines: [], databases: []
  });
  const out = await a.scoreTables('任务', many);
  assert.strictEqual(out.length, 8, '推荐清单上限 8 张');
});

test('分数越界仍然被夹到 0-1, 缺失分数按 0.5', async () => {
  const a = makeAgent({ scored: [
    { name: 'order_info', score: 5 },
    { name: 'delivery_order', score: -3 },
    { name: 'purchase_order' }
  ] });
  const out = await scored(a);
  assert.deepStrictEqual(out.map((s) => s.score), [1, 0, 0.5]);
});

test('模型返回非数组 scored 时安全退化, 不抛异常', async () => {
  for (const bad of [{ scored: 'nope' }, { scored: null }, {}, null]) {
    const a = makeAgent(bad);
    assert.deepStrictEqual(await scored(a), []);
  }
});
