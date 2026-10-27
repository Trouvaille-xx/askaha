'use strict';

/**
 * 内部工具清单 —— 「配置 > 内部工具」页的唯一数据源。
 *
 * ## 为什么不把这份清单写在界面上
 *
 * 36 个工具的 schema 分散在三个文件里:
 *   - lib/actions.js        分析 Agent 的 9 个 (BUILTIN_TOOLS)
 *   - lib/engine-ai.js      搭建 Agent 的 19 个 (TOOLS)
 *   - lib/engine-tester.js  测试 Agent 的 8 个 (TOOLS)
 *
 * 每个工具的 description **就是模型读到的提示词**。在页面上另抄一份, 等于埋了
 * 一个必然漂移的副本 —— 改了工具忘了改页面, 用户看到的说明就是错的, 而且错得
 * 毫无提示。所以这里**只做聚合, 不存任何工具信息**: 名字、说明、参数、只读标记
 * 全部从真实定义里现取。工具改了, 页面自动跟着变。
 *
 * 这也是"只读/串行"那两个标记必须从源码导出的原因 —— 见 agent.js 的
 * ANALYSIS_READ_ONLY 与 engine-ai.js 的 READ_ONLY。
 *
 * ## 它是只读的
 *
 * 不注册工具、不改配置、不连数据库。纯粹是给界面看的一份投影。
 * 工具**真正**怎么被注册、怎么被判并发, 仍然由各自 Agent 的 _registry() 决定;
 * 这个模块只是把同一份事实读出来给人看。
 */

const { BUILTIN_TOOLS } = require('./actions');
const { TOOLS: BUILDER_TOOLS, READ_ONLY: BUILDER_READ_ONLY } = require('./engine-ai');
const { TOOLS: TESTER_TOOLS } = require('./engine-tester');
const { ANALYSIS_READ_ONLY } = require('./agent');

/**
 * 三个 Agent 各自的元信息。
 *
 * readOnlySet 为 null 表示"这个 Agent 的工具全是只读的" —— 测试 Agent 就是这种,
 * 它在 engine-tester.js:965 用 `{ readOnly: true }` 一次性注册了全部 8 个, 因为
 * "不能改数据"是它的硬约束。
 */
const GROUPS = [
  {
    id: 'analysis',
    label: '分析 Agent',
    desc: '对话里提问时跑的那个。模型每步临场决定查什么，产出是结论（对话回答 / 报告 / Excel）。',
    where: 'lib/actions.js',
    readOnlySet: ANALYSIS_READ_ONLY,
    tools: BUILTIN_TOOLS,
    groupOf: (name) => (/workflow/.test(name) ? 'flow' : 'data')
  },
  {
    id: 'builder',
    label: '搭建 Agent',
    desc: '流程卡 AI 面板里那个。工具集是「作者在画板上能做的动作」的投影，产出是一张可复用的卡。',
    where: 'lib/engine-ai.js',
    readOnlySet: BUILDER_READ_ONLY,
    tools: BUILDER_TOOLS,
    groupOf: () => 'build'
  },
  {
    id: 'tester',
    label: '测试 Agent',
    desc: '流程卡「自动测试并修复」里那个。硬约束：不能改数据，所以工具全是只读的。',
    where: 'lib/engine-tester.js',
    readOnlySet: null,          // 全只读
    tools: TESTER_TOOLS,
    groupOf: () => 'diagnose'
  }
];

/** 工具名 -> 中文标签。界面上的分组标题用。 */
const GROUP_LABELS = {
  data: '取数',
  flow: '流程卡',
  build: '改图',
  diagnose: '诊断'
};

/**
 * 从 JSON Schema 里把参数摊平成界面能直接渲染的数组。
 *
 * 保留 enum 是有原因的: add_node 的 nodeType 是个枚举, 界面上直接把
 * input/query/condition/output 摆出来, 比让用户去翻源码有用得多。
 */
function describeParams(schema) {
  const props = (schema && schema.properties) || {};
  const required = (schema && schema.required) || [];
  return Object.keys(props).map((name) => {
    const p = props[name] || {};
    const out = {
      name,
      type: p.type || 'any',
      required: required.indexOf(name) >= 0,
      desc: String(p.description || '')
    };
    if (Array.isArray(p.enum) && p.enum.length) out.enum = p.enum.map(String);
    if (Array.isArray(p.items) && p.items.enum) out.enum = p.items.enum.map(String);
    if (p.type === 'array' && p.items && p.items.type) out.itemType = p.items.type;
    return out;
  });
}

/** 一个工具定义 (OpenAI function-calling 形状) -> 界面用的扁平对象 */
function describeTool(def, opts) {
  const fn = (def && def.function) || def || {};
  const readOnly = opts.readOnlySet ? opts.readOnlySet.has(fn.name) : true;
  return {
    name: String(fn.name || ''),
    description: String(fn.description || ''),
    readOnly,
    // 注册表的语义: 只读的才能并发, 其余一律串行。见 lib/tools.js 的 canParallel
    serial: !readOnly,
    group: opts.groupOf(fn.name),
    groupLabel: GROUP_LABELS[opts.groupOf(fn.name)] || opts.groupOf(fn.name),
    params: describeParams(fn.parameters),
    // 原始 JSON Schema —— 「工具」页要像参考页那样把 Input Schema 原样展示
    schema: fn.parameters || null
  };
}

/**
 * 构建完整清单。
 *
 * @returns {{ generatedAt, total, shared: string[], groups: Array }}
 */
function buildCatalog() {
  // 先统计重名 —— 6 个工具同时被多个 Agent 使用 (ask_user / reply / finish /
  // list_available_tables / describe_tables / check_index)。界面上标出来,
  // 用户才知道"改了这一个会同时影响两个 Agent"。
  const counts = {};
  for (const g of GROUPS) {
    for (const t of g.tools) {
      const n = ((t && t.function) || t || {}).name;
      if (n) counts[n] = (counts[n] || 0) + 1;
    }
  }

  const groups = GROUPS.map((g) => {
    const tools = g.tools.map((t) => {
      const d = describeTool(t, { readOnlySet: g.readOnlySet, groupOf: g.groupOf });
      d.shared = counts[d.name] > 1;
      d.sharedWith = GROUPS
        .filter((o) => o.id !== g.id && o.tools.some((x) => (((x && x.function) || x || {}).name) === d.name))
        .map((o) => o.label);
      return d;
    });
    return {
      id: g.id,
      label: g.label,
      desc: g.desc,
      where: g.where,
      count: tools.length,
      readOnlyCount: tools.filter((t) => t.readOnly).length,
      tools
    };
  });

  const total = groups.reduce((n, g) => n + g.count, 0);
  return {
    generatedAt: new Date().toISOString(),
    total,
    shared: Object.keys(counts).filter((n) => counts[n] > 1).sort(),
    groups
  };
}

module.exports = { buildCatalog, GROUPS, GROUP_LABELS, describeParams };
