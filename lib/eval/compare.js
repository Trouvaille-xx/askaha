'use strict';

/**
 * 两个评测批次的对比 (纯函数)。
 *
 * ## 可比性守卫 (最重要的一条)
 *
 * 只有当 caseIds 集合、评分器版本、provider、模型**完全一致**时才允许下"变好/变坏"
 * 的结论; 任一不同 → comparable=false, 只给出"不可直接比较"及原因, 不输出差值结论。
 * 否则"总分上涨"可能只是换了模型或换了题。
 */

function setEq(a, b) {
  const A = [...new Set(a || [])].sort();
  const B = [...new Set(b || [])].sort();
  if (A.length !== B.length) return false;
  return A.every((x, i) => x === B[i]);
}

function byCase(batch) {
  const m = new Map();
  for (const r of (batch && batch.caseResults) || []) {
    if (r && r.caseId) m.set(r.caseId, r);
  }
  return m;
}

function rateOf(batch) {
  const pass = (batch && batch.passed) || 0;
  const fail = (batch && batch.failed) || 0;
  const review = (batch && batch.review) || 0;
  const denom = pass + fail + review; // ERROR 不进分母
  return denom > 0 ? pass / denom : null;
}

function avgDuration(batch) {
  const rs = ((batch && batch.caseResults) || []).filter((r) => r && Number.isFinite(r.durationMs));
  if (!rs.length) return null;
  return rs.reduce((s, r) => s + r.durationMs, 0) / rs.length;
}

function compareBatches(a, b) {
  const sameCases = setEq(a && a.caseIds, b && b.caseIds);
  const sameScorer = (a && a.scorerVersion) === (b && b.scorerVersion);
  const sameProvider = (a && a.provider) === (b && b.provider);
  const sameModel = (a && a.model) === (b && b.model);
  const comparable = sameCases && sameScorer && sameProvider && sameModel;

  const reasons = [];
  if (!sameCases) reasons.push('用例集合不同');
  if (!sameScorer) reasons.push('评分器版本不同');
  if (!sameProvider) reasons.push('provider 不同');
  if (!sameModel) reasons.push('模型不同');

  const ma = byCase(a);
  const mb = byCase(b);
  const fixed = [];
  const newlyFailed = [];
  const replyChanged = [];

  for (const caseId of ma.keys()) {
    if (!mb.has(caseId)) continue;
    const ra = ma.get(caseId);
    const rb = mb.get(caseId);
    const prevBad = ra.status !== 'PASS';
    const nowBad = rb.status !== 'PASS';
    if (prevBad && rb.status === 'PASS') fixed.push({ caseId, from: ra.status, to: rb.status, runId: rb.runId });
    else if (!prevBad && nowBad) newlyFailed.push({ caseId, from: ra.status, to: rb.status, runId: rb.runId });
    else if (ra.status === rb.status && (ra.finalReply || '') !== (rb.finalReply || '')) {
      replyChanged.push({ caseId, status: rb.status });
    }
  }

  const rateA = rateOf(a);
  const rateB = rateOf(b);
  const avgA = avgDuration(a);
  const avgB = avgDuration(b);

  return {
    comparable,
    reason: comparable ? '' : ('不可直接比较: ' + reasons.join('、')),
    sameCases, sameScorer, sameProvider, sameModel,
    passRateA: rateA,
    passRateB: rateB,
    passRateDelta: rateA != null && rateB != null ? rateB - rateA : null,
    avgDurationDelta: avgA != null && avgB != null ? avgB - avgA : null,
    fixed,
    newlyFailed,
    replyChanged
  };
}

module.exports = { compareBatches };
