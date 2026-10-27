'use strict';

/**
 * 分析类任务的规划器 (纯逻辑: 构造提示词 + 解析结果)。
 *
 * Plan 结构借鉴 SnackOps 的 Planner: 不只是"最后怎么做", 而是先交代
 *   选哪些工具 (selectedTools) / 选哪些技能 (selectedSkills) / 为什么 (reasoning) /
 *   必选能力 (mandatoryCapabilities) / 风险判断 (riskJudgment),
 * 再给出步骤与要访问的表。
 *
 * LLM 调用由调用方 (agent.js / main.js) 发起 —— 这里不碰网络, 便于单测。
 */

// 规划器可选的"工具" —— 对齐分析 Agent 的真实内置工具 (lib/actions.js BUILTIN_TOOLS)。
// 去掉 reply/finish/ask_user 这类通用控制项, 留下真正代表"这一步做了什么"的能力。
const CAPABILITIES = [
  'sql',
  'request_scope',
  'describe_table',
  'search_knowledge',
  'load_skill',
  'list_workflows',
  'run_workflow',
  'look_at_data',
  'check_index',
  'read_result'
];

// 中文简称 —— 界面上给运营看, 不用英文 id 裸奔。
const TOOL_LABELS = {
  sql: '执行只读 SQL',
  request_scope: '申请新的数据表',
  describe_table: '查看表结构',
  search_knowledge: '检索知识库文档',
  load_skill: '加载技能',
  list_workflows: '列出流程卡',
  run_workflow: '运行流程卡',
  look_at_data: '抽样看某列的真实值',
  check_index: '查看索引',
  read_result: '读回早先的查询结果'
};

const SYSTEM = [
  '你是一个数据库分析任务的规划器。',
  '先想清楚"这一步要干什么、需要哪些能力", 再输出一版结构化计划 (相当于先写 PRD 再动手)。',
  '严格只输出一个 JSON 对象, 不要解释文字。'
].join('\n');

function strArr(v) {
  return Array.isArray(v) ? v.map((x) => String(x == null ? '' : x).trim()).filter(Boolean) : [];
}

function buildPlannerPrompt(ctx) {
  const c = ctx || {};
  const tables = Array.isArray(c.availableTables) ? c.availableTables.slice(0, 120) : [];
  const engines = Array.isArray(c.engines) ? c.engines.slice(0, 30) : [];
  const skills = Array.isArray(c.skills) ? c.skills.slice(0, 30) : [];
  const caps = Array.isArray(c.capabilities) && c.capabilities.length
    ? c.capabilities.filter((x) => CAPABILITIES.includes(x))
    : CAPABILITIES.slice();
  const mandatory = Array.isArray(c.mandatory) ? c.mandatory.filter((x) => caps.includes(x)) : [];

  const toolLines = caps.map((id) => `- ${id}: ${TOOL_LABELS[id] || ''}`).join('\n');
  return [
    '请输出一个 JSON 对象, 字段:',
    '- selectedTools: 本次要用的工具 id 数组, **只能从下面"允许的工具"里选**',
    '- selectedSkills: 本次要用的技能名数组, 只能从"允许的 Skill"里选 (没有就空数组)',
    '- mandatoryCapabilities: 本次必须用到的工具, 必须是 selectedTools 的子集' + (mandatory.length ? `; 本次强制必选: ${mandatory.join(', ')}` : ''),
    '- reasoning: 为什么这样选 (一句话说清判断依据, 给运营看)',
    '- riskJudgment: { level: none|low|medium|high, handoff: 是否应转人工, reason }',
    '- steps: [{ id, title, detail }], 2-6 步',
    '- requiredTables: 计划访问的表名数组, 只能用"可用表"里的',
    '- approach: 一句话思路; confidence: 0-1',
    '',
    '## 允许的工具 (selectedTools 只能从这里选)',
    toolLines || '(无)',
    '',
    '## 允许的 Skill (selectedSkills 只能从这里选)',
    skills.length ? skills.map((s) => `- ${s}`).join('\n') : '(无)',
    '',
    '## 可用表 (requiredTables 只能用这里的)',
    tables.length ? tables.join(', ') : '(未读取到, 可留空)',
    '',
    '## 可用流程卡',
    engines.length ? engines.map((e) => `- ${e.id || ''}: ${e.name || ''}`).join('\n') : '(无)',
    '',
    '## 用户问题',
    String(c.userInput || '').slice(0, 2000),
    '',
    '请输出 JSON。'
  ].join('\n');
}

function emptyPlan(extra) {
  return Object.assign({
    reasoning: '',
    selectedTools: [],
    selectedSkills: [],
    mandatoryCapabilities: [],
    riskJudgment: { level: 'none', handoff: false, reason: '' },
    approach: '',
    steps: [],
    requiredTables: [],
    riskFlags: [],
    handoff: { needed: false, reason: '' },
    confidence: 0,
    parseError: true,
    raw: ''
  }, extra || {});
}

/** 从模型输出里抽 JSON。解析失败 -> 安全 fallback, 绝不抛。 */
function parsePlan(text) {
  if (!text || typeof text !== 'string') return emptyPlan({ raw: '' });
  const candidates = [text.trim()];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1].trim());
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));

  let obj = null;
  for (const cand of candidates) {
    try { obj = JSON.parse(cand); if (obj && typeof obj === 'object') break; } catch (e) {}
  }
  if (!obj || typeof obj !== 'object') return emptyPlan({ raw: text.slice(0, 500) });

  const rj = (obj.riskJudgment && typeof obj.riskJudgment === 'object') ? obj.riskJudgment : {};
  const handoff = (obj.handoff && typeof obj.handoff === 'object') ? obj.handoff : {};
  // 兼容老形状: 没有 selectedTools 就用 requiredCapabilities
  const selectedTools = strArr(obj.selectedTools || obj.requiredCapabilities);

  return {
    reasoning: String(obj.reasoning || '').slice(0, 800),
    selectedTools,
    selectedSkills: strArr(obj.selectedSkills),
    mandatoryCapabilities: strArr(obj.mandatoryCapabilities),
    riskJudgment: {
      level: ['none', 'low', 'medium', 'high'].includes(rj.level) ? rj.level : 'none',
      handoff: !!(rj.handoff || handoff.needed),
      reason: String(rj.reason || handoff.reason || '').slice(0, 300)
    },
    approach: String(obj.approach || '').trim().slice(0, 500),
    steps: (Array.isArray(obj.steps) ? obj.steps : []).slice(0, 12).map((s, i) => ({
      id: String((s && s.id) || 's' + (i + 1)),
      title: String((s && s.title) || '').trim().slice(0, 120),
      detail: String((s && s.detail) || '').trim().slice(0, 400)
    })).filter((s) => s.title),
    requiredTables: strArr(obj.requiredTables),
    riskFlags: strArr(obj.riskFlags),
    handoff: {
      needed: !!(rj.handoff || handoff.needed),
      reason: String(handoff.reason || rj.reason || '').slice(0, 300)
    },
    confidence: typeof obj.confidence === 'number' ? Math.max(0, Math.min(1, obj.confidence)) : 0.5,
    parseError: false,
    raw: ''
  };
}

module.exports = { buildPlannerPrompt, parsePlan, CAPABILITIES, TOOL_LABELS, SYSTEM };
