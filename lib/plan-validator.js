'use strict';

/**
 * 规划校验器 (纯函数)。
 *
 * 区分两级:
 *   errors   硬问题 —— 未知工具、工具不在允许范围、缺少必选能力、危险输入未标记转人工。
 *             agent 会据此降级/转人工, 不伪装成功。
 *   warnings 建议 —— 引用了未确认的表、用了未允许的 Skill、价格类问题却没选 sql、规划解析失败。
 *
 * 判定故意保守: 价格缺 sql 是"计划不完整"而非"不安全", 只警告不阻断。
 */

const { CAPABILITIES: KNOWN_CAPABILITIES } = require('./planner');

// 明确的危险输入 (命令式写操作 / 注入 / 要凭据)。只认这些, 不做宽泛关键词。
const HARD_RISK = /忽略.{0,6}指令|密码|口令|验证码|中奖|drop\s+table|delete\s+from|update\s+[\s\S]*?\bset\b|insert\s+into|truncate|information_schema|系统表/i;
const PRICE = /价格|金额|费用|成本|售价|多少钱|总价|gmv|客单价|销售额|营收|流水/i;

function validatePlan(plan, ctx) {
  const errors = [];
  const warnings = [];
  const p = plan || {};

  if (!plan || p.parseError) {
    warnings.push('规划无法解析, 本轮按"无显式规划"降级执行');
    return { ok: true, errors, warnings };
  }

  const tools = Array.isArray(p.selectedTools)
    ? p.selectedTools
    : (Array.isArray(p.requiredCapabilities) ? p.requiredCapabilities : []);

  const allowed = ctx && Array.isArray(ctx.allowedCaps) ? ctx.allowedCaps : null;
  for (const t of tools) {
    if (!KNOWN_CAPABILITIES.includes(t)) errors.push('未知工具: ' + t);
    else if (allowed && !allowed.includes(t)) errors.push('工具不在允许范围: ' + t);
  }

  const mandatory = ctx && Array.isArray(ctx.mandatory) ? ctx.mandatory : [];
  for (const m of mandatory) {
    if (!tools.includes(m)) errors.push('缺少必选能力: ' + m);
  }

  const allowedSkills = ctx && Array.isArray(ctx.allowedSkills) ? ctx.allowedSkills : null;
  for (const s of (p.selectedSkills || [])) {
    if (allowedSkills && !allowedSkills.includes(s)) warnings.push('使用了未允许的 Skill: ' + s);
  }

  const available = ctx && Array.isArray(ctx.availableTables) ? ctx.availableTables : [];
  if (available.length) {
    for (const t of (p.requiredTables || [])) {
      if (!available.includes(t)) warnings.push('规划引用了未确认的表: ' + t);
    }
  }

  const q = String((ctx && ctx.question) || '');
  if (PRICE.test(q) && !tools.includes('sql')) {
    warnings.push('价格/金额类问题, 但规划里没有 sql 能力');
  }

  const riskHandled = !!(p.riskJudgment && p.riskJudgment.handoff) ||
    (p.handoff && p.handoff.needed) ||
    (p.riskFlags || []).length > 0;
  if (HARD_RISK.test(q) && !riskHandled) {
    errors.push('危险输入未标记转人工或风险 (需要 riskJudgment.handoff 或 handoff.needed)');
  }

  return { ok: errors.length === 0, errors, warnings };
}

module.exports = { validatePlan, KNOWN_CAPABILITIES };
