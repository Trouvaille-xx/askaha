'use strict';

/**
 * 「配置 > 内部工具」页的数据源回归测试。
 *
 * 这个页面有一个特殊的风险: 它的全部价值建立在"展示的就是真实工具"上。
 * 一旦有人图省事在页面上写死一份清单, 或者把某个工具的说明改了却忘了同步,
 * 页面就会开始骗人 —— 而且骗得毫无提示。
 *
 * 所以这组测试不测"页面长什么样", 只测一件事:
 *   **catalog 的每一个字节都必须能追溯到三个 Agent 的真实定义。**
 *
 * 跑法: npm test
 */

const test = require('node:test');
const assert = require('node:assert');

const { buildCatalog, describeParams } = require('../lib/tool-catalog');
const { BUILTIN_TOOLS } = require('../lib/actions');
const { TOOLS: BUILDER_TOOLS, READ_ONLY: BUILDER_READ_ONLY } = require('../lib/engine-ai');
const { TOOLS: TESTER_TOOLS } = require('../lib/engine-tester');
const { ANALYSIS_READ_ONLY } = require('../lib/agent');

const nm = (t) => ((t && t.function) || t || {}).name;

/* ============================================================
 * 1. 总数与来源一致 —— 页面上的数字必须等于代码里的工具数
 * ============================================================ */

test('catalog: 总数等于三个 Agent 工具数之和', () => {
  const c = buildCatalog();
  const expect = BUILTIN_TOOLS.length + BUILDER_TOOLS.length + TESTER_TOOLS.length;
  assert.strictEqual(c.total, expect, `页面显示 ${c.total}, 实际 ${expect}`);
  assert.strictEqual(c.groups.length, 3);
});

test('catalog: 每个 Agent 的数量都对得上', () => {
  const c = buildCatalog();
  const byId = Object.fromEntries(c.groups.map((g) => [g.id, g]));
  assert.strictEqual(byId.analysis.count, BUILTIN_TOOLS.length);
  assert.strictEqual(byId.builder.count, BUILDER_TOOLS.length);
  assert.strictEqual(byId.tester.count, TESTER_TOOLS.length);
});

/* ============================================================
 * 2. 双向核对 —— 不多、不少、不改写
 * ============================================================ */

test('catalog: 分析 Agent 的工具名与 actions.js 完全一致 (顺序也一致)', () => {
  const c = buildCatalog();
  const got = c.groups.find((g) => g.id === 'analysis').tools.map((t) => t.name);
  assert.deepStrictEqual(got, BUILTIN_TOOLS.map(nm));
});

test('catalog: 搭建 Agent 的工具名与 engine-ai.js 完全一致', () => {
  const c = buildCatalog();
  const got = c.groups.find((g) => g.id === 'builder').tools.map((t) => t.name);
  assert.deepStrictEqual(got, BUILDER_TOOLS.map(nm));
});

test('catalog: 测试 Agent 的工具名与 engine-tester.js 完全一致', () => {
  const c = buildCatalog();
  const got = c.groups.find((g) => g.id === 'tester').tools.map((t) => t.name);
  assert.deepStrictEqual(got, TESTER_TOOLS.map(nm));
});

test('catalog: 说明文字是原文照抄, 不是摘要', () => {
  const c = buildCatalog();
  // 注意: 必须按"分组 -> 对应的源数组"来核对, 不能全局按名字 find ——
  // 有 6 个工具跨 Agent 重名 (reply / finish / ask_user 等), 全局 find 会命中
  // 另一个 Agent 的同名定义, 那是这个测试自己的 bug, 不是 catalog 的。
  const SOURCE = {
    analysis: BUILTIN_TOOLS,
    builder: BUILDER_TOOLS,
    tester: TESTER_TOOLS
  };
  for (const g of c.groups) {
    const src = SOURCE[g.id];
    assert.ok(src, `分组 ${g.id} 没有对应的源数组`);
    for (const t of g.tools) {
      const def = src.find((x) => nm(x) === t.name);
      assert.ok(def, `源里找不到 ${t.name}`);
      const expect = ((def.function) || def).description || '';
      assert.strictEqual(t.description, expect, `${g.label} 的工具 ${t.name} 的说明被改写过了`);
    }
  }
});

/* ============================================================
 * 3. 只读 / 串行标记 —— 必须读源码那一份, 不能自己判断
 * ============================================================ */

test('catalog: 分析 Agent 的只读标记来自 agent.js 的 ANALYSIS_READ_ONLY', () => {
  const c = buildCatalog();
  const g = c.groups.find((x) => x.id === 'analysis');
  for (const t of g.tools) {
    assert.strictEqual(
      t.readOnly, ANALYSIS_READ_ONLY.has(t.name),
      `工具 ${t.name} 的只读标记与 ANALYSIS_READ_ONLY 不符`
    );
    assert.strictEqual(t.serial, !t.readOnly, '串行必须恒等于"非只读"');
  }
});

test('catalog: 搭建 Agent 的只读标记来自 engine-ai.js 的 READ_ONLY', () => {
  const c = buildCatalog();
  const g = c.groups.find((x) => x.id === 'builder');
  for (const t of g.tools) {
    assert.strictEqual(
      t.readOnly, BUILDER_READ_ONLY.has(t.name),
      `工具 ${t.name} 的只读标记与 READ_ONLY 不符`
    );
  }
});

test('catalog: 测试 Agent 的工具全是只读的 (它的硬约束是不能改数据)', () => {
  const c = buildCatalog();
  const g = c.groups.find((x) => x.id === 'tester');
  assert.strictEqual(g.readOnlyCount, g.count, '测试 Agent 出现了非只读工具 —— 这违反它的硬约束');
});

test('catalog: 改图的工具一律串行 (并发两个 add_node 会踩连线)', () => {
  const c = buildCatalog();
  const g = c.groups.find((x) => x.id === 'builder');
  const mutating = ['add_node', 'delete_node', 'set_node_title', 'connect', 'disconnect',
    'configure_input', 'configure_query', 'configure_condition', 'configure_output'];
  for (const name of mutating) {
    const t = g.tools.find((x) => x.name === name);
    assert.ok(t, `搭建 Agent 少了改图工具 ${name}`);
    assert.strictEqual(t.readOnly, false, `改图工具 ${name} 被标成了只读 —— 危险`);
    assert.strictEqual(t.serial, true, `改图工具 ${name} 必须串行`);
  }
});

/* ============================================================
 * 4. 共用检测 —— 界面上那个「共用」徽标要说实话
 * ============================================================ */

test('catalog: 共用工具集合与实际重名情况一致', () => {
  const c = buildCatalog();
  const all = [...BUILTIN_TOOLS, ...BUILDER_TOOLS, ...TESTER_TOOLS].map(nm);
  const counts = {};
  for (const n of all) counts[n] = (counts[n] || 0) + 1;
  const expect = Object.keys(counts).filter((n) => counts[n] > 1).sort();
  assert.deepStrictEqual(c.shared, expect);
  assert.ok(c.shared.length > 0, '应该存在跨 Agent 共用的工具');
});

test('catalog: 每个工具的 sharedWith 指向真正包含它的 Agent', () => {
  const c = buildCatalog();
  for (const g of c.groups) {
    for (const t of g.tools) {
      for (const label of t.sharedWith) {
        const other = c.groups.find((x) => x.label === label);
        assert.ok(other, `sharedWith 指向了不存在的 Agent: ${label}`);
        assert.ok(other.tools.some((x) => x.name === t.name),
          `${t.name} 并不在 ${label} 里, sharedWith 写错了`);
      }
      assert.strictEqual(t.shared, t.sharedWith.length > 0, `${t.name} 的 shared 与 sharedWith 不一致`);
    }
  }
});

/* ============================================================
 * 5. 说明不能为空 —— description 就是模型读到的提示词
 * ============================================================ */

test('catalog: 每个工具都有非空说明 (说明即提示词, 空的就是模型没指引)', () => {
  const c = buildCatalog();
  for (const g of c.groups) {
    for (const t of g.tools) {
      assert.ok(t.description && t.description.trim().length > 0,
        `${g.label} 的工具 ${t.name} 没有说明 —— 模型看不到它该什么时候用`);
    }
  }
});

/* ============================================================
 * 6. 参数摊平 —— 界面靠它渲染, 尤其是枚举
 * ============================================================ */

test('describeParams: 必填与选填被正确区分', () => {
  const p = describeParams({
    type: 'object',
    properties: { a: { type: 'string' }, b: { type: 'number' } },
    required: ['a']
  });
  assert.strictEqual(p.length, 2);
  assert.strictEqual(p.find((x) => x.name === 'a').required, true);
  assert.strictEqual(p.find((x) => x.name === 'b').required, false);
});

test('describeParams: 枚举被带出来 (界面要直接显示可选值)', () => {
  const p = describeParams({
    type: 'object',
    properties: { nodeType: { type: 'string', enum: ['input', 'query', 'condition', 'output'] } },
    required: ['nodeType']
  });
  assert.deepStrictEqual(p[0].enum, ['input', 'query', 'condition', 'output']);
});

test('describeParams: 空 schema 不炸', () => {
  assert.deepStrictEqual(describeParams(null), []);
  assert.deepStrictEqual(describeParams({}), []);
  assert.deepStrictEqual(describeParams({ type: 'object' }), []);
});

test('catalog: add_node 的 nodeType 枚举真的被带出来了', () => {
  const c = buildCatalog();
  const addNode = c.groups.find((g) => g.id === 'builder').tools.find((t) => t.name === 'add_node');
  const p = addNode.params.find((x) => x.name === 'nodeType');
  assert.ok(p, 'add_node 少了 nodeType 参数');
  assert.deepStrictEqual(p.enum, ['input', 'query', 'condition', 'output']);
});

test('catalog: 无参工具的参数数组是空的, 不是 undefined', () => {
  const c = buildCatalog();
  const noArg = c.groups.find((g) => g.id === 'analysis').tools.find((t) => t.name === 'list_workflows');
  assert.ok(Array.isArray(noArg.params));
  assert.strictEqual(noArg.params.length, 0);
});

/* ============================================================
 * 7. 形状稳定 —— 界面直接吃这个结构
 * ============================================================ */

test('catalog: 返回结构完整且可序列化 (要过 IPC)', () => {
  const c = buildCatalog();
  assert.strictEqual(typeof c.generatedAt, 'string');
  assert.ok(!Number.isNaN(Date.parse(c.generatedAt)));
  assert.strictEqual(typeof c.total, 'number');
  assert.ok(Array.isArray(c.shared));
  for (const g of c.groups) {
    for (const k of ['id', 'label', 'desc', 'where', 'count', 'readOnlyCount']) {
      assert.ok(g[k] !== undefined, `分组 ${g.id} 少了字段 ${k}`);
    }
    assert.ok(Array.isArray(g.tools));
  }
  // 结构化克隆能过 = IPC 能过
  assert.doesNotThrow(() => structuredClone(c));
});

test('catalog: 每次调用都是新对象 (界面缓存它, 不能被共享引用污染)', () => {
  const a = buildCatalog();
  const b = buildCatalog();
  assert.notStrictEqual(a, b);
  assert.notStrictEqual(a.groups[0], b.groups[0]);
  assert.deepStrictEqual(
    a.groups.map((g) => g.tools.map((t) => t.name)),
    b.groups.map((g) => g.tools.map((t) => t.name))
  );
});
