'use strict';

/**
 * 向量杂项: 余弦相似度 / 归一化。
 *
 * 单独成文件是为了避免循环依赖 —— chunk.js (语义分块) 和 vector.js (检索)
 * 都要用它, 谁也不该 require 谁。
 */

/** 点积 */
function dot(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/** L2 范数 */
function norm(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s);
}

/**
 * 余弦相似度。任一为零向量时返回 0 (而不是 NaN) —— 接口里返回 NaN 会
 * 顺着排序一路污染下去, 最后表现为"检索偶尔返回空"。
 */
function cosine(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (na === 0 || nb === 0) return 0;
  return dot(a, b) / (na * nb);
}

/** 原地归一化成单位向量 (检索时先归一化, 之后点积即余弦, 省一半计算) */
function normalizeInPlace(a) {
  const n = norm(a);
  if (n === 0) return a;
  for (let i = 0; i < a.length; i++) a[i] /= n;
  return a;
}

module.exports = { dot, norm, cosine, normalizeInPlace };
