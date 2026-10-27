'use strict';

/**
 * 从一次真实运行的结果里推导"这次用到了哪些能力"。
 *
 * 能力语义用 Askaha 的元能力, 不用电商域的 query_products 那类:
 *   sql         跑过 SQL 查询
 *   describe    看过表结构
 *   knowledge   用了知识库检索
 *   engine      命中了流程卡 (另记 engine:<id>)
 *   plan        产出了显式规划
 *   handoff     判为需要人工接管
 *   reply       给出了回复 (恒有)
 *
 * Eval 用例用 requiredCapabilities / forbiddenCapabilities 对这份集合做校验;
 * 输入是 RunRecord 的 { steps, trace, ragHits, plan } —— 全是纯数据, 不碰 Electron。
 */

const { CAPABILITIES: TOOL_IDS } = require('../planner');

function deriveCapabilities(run) {
  const caps = new Set();
  const steps = Array.isArray(run && run.steps) ? run.steps : [];
  const trace = Array.isArray(run && run.trace) ? run.trace : [];

  // 步骤/轨迹里的 kind 直接就是工具名时, 记为对应能力
  for (const s of steps) {
    if (s && TOOL_IDS.includes(s.kind)) caps.add(s.kind);
  }
  for (const t of trace) {
    if (!t) continue;
    if (t.kind === 'sql') caps.add('sql');
    else if (t.kind === 'describe') caps.add('describe_table');
    else if (t.kind === 'rag') caps.add('search_knowledge');
    else if (t.kind === 'engine') caps.add('run_workflow');
    else if (TOOL_IDS.includes(t.kind)) caps.add(t.kind);
  }
  if (((run && run.ragHits) || []).length > 0) caps.add('search_knowledge');
  if (run && run.plan) caps.add('plan');
  if (run && run.plan && run.plan.handoff && run.plan.handoff.needed) caps.add('handoff');
  caps.add('reply');
  return Array.from(caps);
}

module.exports = { deriveCapabilities };
