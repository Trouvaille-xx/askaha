'use strict';

/**
 * 检索: 向量召回 + (可选) LLM rerank。
 *
 * 两段式 (见决策记录 D7):
 *   1) 向量召回 candidateN 条 (默认 20) —— 便宜、快, 只求"别漏"。
 *   2) LLM rerank 取最终 topK (默认 5) —— 模型按语义相关性重排/剔除。
 *      纯口语化的提问 (向量分数未必准) 靠这一步拉回来。
 *
 * 只在**单个知识库内**检索 (需求: 不支持跨知识库)。
 *
 * 性能取舍: 暴力余弦。单库几千~几万块时是毫秒级; 真到十万级再换 ANN,
 * 那时只需要改这一个文件的 search 实现 (决策记录 D3)。
 */

const { dot, normalizeInPlace } = require('./math');

/**
 * 把知识库里所有"就绪"文档的向量+分块摊平成一个可检索的列表。
 * @returns {{ rows: object[], dim: number }}
 */
function collectRows(store, kbId) {
  const docs = store.listDocs(kbId).filter((d) => d.status === 'ready' && (d.dim || 0) > 0);
  const rows = [];
  let dim = 0;
  for (const d of docs) {
    const chunks = store.readChunks(kbId, d.id);
    const { dim: vdim, data } = store.readVectors(kbId, d.id);
    if (!vdim || !data.length) continue;
    dim = vdim;
    const n = Math.min(chunks.length, Math.floor(data.length / vdim));
    for (let i = 0; i < n; i++) {
      const vec = data.subarray(i * vdim, (i + 1) * vdim);
      rows.push({
        docId: d.id, docName: d.name, folderId: d.folderId || null,
        ord: i, chunkId: chunks[i] && chunks[i].id,
        text: (chunks[i] && chunks[i].text) || '',
        section: (chunks[i] && chunks[i].section) || '',
        vec
      });
    }
  }
  return { rows, dim };
}

/**
 * 向量召回 topN。qvec 归一化后与(已归一化的)块向量做点积 = 余弦。
 */
function topCandidates(rows, qvec, n) {
  const q = Float32Array.from(qvec);
  normalizeInPlace(q);
  const scored = [];
  for (const r of rows) {
    // 维度对不上直接跳过 (换了 embedding 模型但没重建索引时会这样)
    if (r.vec.length !== q.length) continue;
    scored.push({ row: r, score: dot(r.vec, q) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, n)).map((s) => ({
    docId: s.row.docId, docName: s.row.docName, folderId: s.row.folderId,
    chunkId: s.row.chunkId, ord: s.row.ord,
    text: s.row.text, section: s.row.section,
    score: Number(s.score.toFixed(4))
  }));
}

/**
 * LLM rerank: 让模型按"对回答这个问题有多有用"重排候选, 顺便剔除不相关的。
 * 失败 (模型没配 / 吐不出 JSON) 时原样返回按向量分排的前 topK —— 降级不报错。
 */
async function llmRerank(candidates, query, llm, topK) {
  if (!llm || !candidates.length) return candidates.slice(0, topK);
  const brief = candidates.map((c, i) => {
    const snippet = String(c.text || '').replace(/\s+/g, ' ').slice(0, 220);
    return `[${i}] (${c.docName}${c.section ? ' · ' + c.section : ''}) ${snippet}`;
  }).join('\n');
  const prompt = [
    '你在给一次检索做重排。下面是候选片段, 请按"对回答这个问题有多有用"排序,',
    '剔除明显不相关的。只输出 JSON, 不要解释。',
    '',
    `问题: ${String(query).slice(0, 400)}`,
    '',
    '候选:',
    brief,
    '',
    `输出格式: {"order":[{"i":候选编号,"score":0到1}]} —— 最多 ${topK} 条, 按 score 从高到低。`
  ].join('\n');
  try {
    const raw = await llm.chat([
      { role: 'system', content: '你是一个检索结果重排器, 只输出 JSON。' },
      { role: 'user', content: prompt }
    ], { maxTokens: 800, temperature: 0 });
    const parsed = llm._extractJSON ? llm._extractJSON(raw) : null;
    if (parsed && Array.isArray(parsed.order) && parsed.order.length) {
      const picked = [];
      const seen = new Set();
      for (const o of parsed.order) {
        const i = Number(o && o.i);
        if (!Number.isInteger(i) || i < 0 || i >= candidates.length || seen.has(i)) continue;
        seen.add(i);
        const c = Object.assign({}, candidates[i]);
        if (Number.isFinite(o.score)) c.score = Number(o.score);
        c.reranked = true;
        picked.push(c);
        if (picked.length >= topK) break;
      }
      if (picked.length) return picked;
    }
  } catch (e) {
    // 降级: 用向量分数
  }
  return candidates.slice(0, topK);
}

module.exports = { collectRows, topCandidates, llmRerank };
