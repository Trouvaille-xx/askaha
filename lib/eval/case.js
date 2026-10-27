'use strict';

/**
 * EvalCase 的数据模型与字段校验 (纯函数, 不碰文件系统)。
 *
 * 一条用例描述"给 agent 一个问题, 期望它在哪些方面表现正确"。
 * 字段刻意对齐 SnackOps 的评测模型, 但能力语义换成 Askaha 的元能力
 * (sql / describe / knowledge / engine / plan / handoff)。
 */

const DIFFICULTY = ['easy', 'medium', 'hard'];
const RISK_LEVEL = ['none', 'low', 'medium', 'high'];
const DIMENSIONS = ['correctness', 'safety', 'capability', 'tone', 'completeness'];

function str(v) {
  return typeof v === 'string' ? v : (v == null ? '' : String(v));
}
function arr(v) {
  return Array.isArray(v) ? v.map(str).map((s) => s.trim()).filter(Boolean) : [];
}

/** 补齐默认值, 规整类型。不校验, 只保证形状。 */
function normalizeCase(input) {
  const src = input && typeof input === 'object' ? input : {};
  return {
    id: str(src.id) || null,
    name: str(src.name).trim().slice(0, 120),
    question: str(src.question).trim(),
    category: str(src.category).trim() || 'general',
    difficulty: DIFFICULTY.includes(src.difficulty) ? src.difficulty : 'medium',
    riskLevel: RISK_LEVEL.includes(src.riskLevel) ? src.riskLevel : 'none',
    expectedBehavior: str(src.expectedBehavior).trim(),
    expectedKeywords: arr(src.expectedKeywords),
    keywordMode: src.keywordMode === 'any' ? 'any' : 'all',
    forbiddenWords: arr(src.forbiddenWords),
    expectedPrice: src.expectedPrice === '' || src.expectedPrice == null ? null : Number(src.expectedPrice),
    // 是否要求最终回复本身安全 (危险回复才拦; 输入风险高不等于回复要判失败)
    expectRiskPassed: src.expectRiskPassed !== false,
    requiredCapabilities: arr(src.requiredCapabilities),
    forbiddenCapabilities: arr(src.forbiddenCapabilities),
    evalDimension: DIMENSIONS.includes(src.evalDimension) ? src.evalDimension : 'correctness',
    tags: arr(src.tags),
    sourceRunId: str(src.sourceRunId) || null,
    createdAt: str(src.createdAt) || new Date().toISOString(),
    enabled: src.enabled !== false
  };
}

/** 字段校验。返回错误信息数组, 空数组 = 合法。 */
function validateCase(c) {
  const errors = [];
  if (!c || typeof c !== 'object') return ['用例为空'];
  if (!str(c.question).trim()) errors.push('question 必填');
  if (c.expectedPrice != null && !Number.isFinite(c.expectedPrice)) errors.push('expectedPrice 必须是数字');
  if (c.difficulty && !DIFFICULTY.includes(c.difficulty)) errors.push('difficulty 非法');
  if (c.riskLevel && !RISK_LEVEL.includes(c.riskLevel)) errors.push('riskLevel 非法');
  if (c.evalDimension && !DIMENSIONS.includes(c.evalDimension)) errors.push('evalDimension 非法');
  if (c.keywordMode && !['all', 'any'].includes(c.keywordMode)) errors.push('keywordMode 只能是 all / any');
  return errors;
}

module.exports = { normalizeCase, validateCase, DIFFICULTY, RISK_LEVEL, DIMENSIONS };
