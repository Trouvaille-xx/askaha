'use strict';

/**
 * 知识库服务: 把 store / embedder / 检索 / 导入 拼成一个 Agent 和 IPC 都能用的门面。
 *
 * 配置来源 (config.knowledge, 见「配置 · 知识库配置」):
 *   embedding  { baseURL, apiKey, model }        —— 新建知识库时的默认向量模型
 *   retrieval  { topK, candidateN, rerank }      —— 检索参数 (topk / 召回数 / 是否 rerank)
 *   defaultKbId                                   —— 对话页没选库时用哪个
 *
 * 每个知识库**自己**存一份 embedding (创建时锁定) —— 检索必须用和入库同一个模型,
 * 否则维度/语义空间不一致, 结果会静默地错 (见决策记录 D4)。
 */

const { Embedder } = require('./embed');
const { ingestDocument } = require('./ingest');
const { collectRows, topCandidates, llmRerank } = require('./vector');

const DEFAULT_RETRIEVAL = { topK: 5, candidateN: 20, rerank: true };
const DEFAULT_CHUNK = { strategy: 'fixed', size: 800, overlap: 120, semanticThreshold: 0.72 };

class KnowledgeService {
  constructor({ store, qa, getConfig }) {
    this.store = store;
    this.qa = qa;
    this.getConfig = typeof getConfig === 'function' ? getConfig : () => ({});
  }

  config() {
    const c = this.getConfig() || {};
    return {
      embedding: c.embedding || {},
      // 向量模型与分块策略统一在「配置 · 知识库」里配 —— 不再按知识库锁一份。
      chunkConfig: Object.assign({}, DEFAULT_CHUNK, c.chunkConfig || {}),
      retrieval: Object.assign({}, DEFAULT_RETRIEVAL, c.retrieval || {}),
      defaultKbId: c.defaultKbId || null
    };
  }

  /** 新建知识库时该用哪套向量模型: 库里没定就用全局配置 */
  defaultEmbeddingConfig() {
    return Object.assign({}, this.config().embedding);
  }

  /**
   * 向量化用的 embedder。统一取「配置 · 知识库」里的那套 ——
   * 这样"在配置里配"就立刻对导入与检索同时生效 (用户的心智模型)。
   * 换模型后旧文档维度若不同, 检索时会被 topCandidates 跳过, 不报错。
   */
  embedderForKb() {
    return new Embedder(this.config().embedding);
  }

  /**
   * 单库检索。返回 { ok, kbId, kbName, hits:[...], reranked, candidateCount, dim }
   * queryVec 可选 —— 多库检索时上层只算一次查询向量, 这里复用。
   */
  async search({ kbId, query, queryVec, llm, topK, candidateN, rerank } = {}) {
    const cfg = this.config();
    const id = kbId || cfg.defaultKbId;
    if (!id) return { ok: false, error: '未选择知识库' };
    const kb = this.store.getKb(id);
    if (!kb) return { ok: false, error: '知识库不存在' };
    if (!query || !String(query).trim()) return { ok: false, error: '检索词为空' };

    const { rows } = collectRows(this.store, id);
    if (!rows.length) return { ok: true, kbId: id, kbName: kb.name, hits: [], candidateCount: 0, dim: 0, reranked: false };

    let qvec = queryVec;
    if (!qvec) {
      const embedder = this.embedderForKb();
      if (!embedder.ready()) {
        return { ok: false, error: '未配置可用的向量模型, 无法检索。请到「配置 · 知识库」填好 baseURL / 模型 / Key。' };
      }
      try {
        qvec = await embedder.embedOne(String(query).slice(0, 2000));
      } catch (e) {
        return { ok: false, error: '把问题向量化失败: ' + e.message };
      }
    }

    const n = Math.max(1, Number(candidateN) || cfg.retrieval.candidateN);
    const k = Math.max(1, Number(topK) || cfg.retrieval.topK);
    const candidates = topCandidates(rows, qvec, n);
    const useRerank = rerank === undefined ? cfg.retrieval.rerank : !!rerank;
    const hits = useRerank ? await llmRerank(candidates, query, llm, k) : candidates.slice(0, k);

    // 补上文件夹名 (界面展示"来自哪个文件夹") 和所属库名 (多库合并时要用)
    const folders = new Map((kb.folders || []).map((f) => [f.id, f.name]));
    for (const h of hits) {
      h.folderName = h.folderId ? (folders.get(h.folderId) || '') : '';
      h.kbName = kb.name;
    }

    return {
      ok: true, kbId: id, kbName: kb.name, hits,
      candidateCount: candidates.length,
      dim: rows[0] ? rows[0].vec.length : 0,
      reranked: useRerank
    };
  }

  /**
   * 多库检索: 每个库各搜一遍, 合并候选后**统一 rerank 取 topK**。
   *
   * 这仍然是"每个库单独索引、单独召回" —— 不是把多个库的向量混进一个索引
   * (需求明确: 不支持跨库索引)。只是把各库结果汇总后一起排序。
   */
  async searchMany({ kbIds, query, llm, topK, candidateN, rerank } = {}) {
    const cfg = this.config();
    let ids = (Array.isArray(kbIds) ? kbIds : []).filter(Boolean);
    if (!ids.length) {
      ids = cfg.defaultKbId ? [cfg.defaultKbId] : this.store.listKbs().map((k) => k.id);
    }
    if (!ids.length) return { ok: false, error: '还没有任何知识库' };
    if (!query || !String(query).trim()) return { ok: false, error: '检索词为空' };

    // 只算一次查询向量: 同一个问题, 各库复用
    const embedder = this.embedderForKb();
    if (!embedder.ready()) {
      return { ok: false, error: '未配置可用的向量模型, 无法检索。请到「配置 · 知识库」填好 baseURL / 模型 / Key。' };
    }
    let qvec;
    try { qvec = await embedder.embedOne(String(query).slice(0, 2000)); }
    catch (e) { return { ok: false, error: '把问题向量化失败: ' + e.message }; }

    const per = Math.max(1, Number(candidateN) || cfg.retrieval.candidateN);
    const k = Math.max(1, Number(topK) || cfg.retrieval.topK);
    const all = [];
    const names = [];
    for (const id of ids) {
      const r = await this.search({ kbId: id, query, queryVec: qvec, topK: per, candidateN: per, rerank: false });
      if (r && r.ok) { names.push(r.kbName); all.push(...r.hits); }
    }
    if (!all.length) return { ok: true, kbIds: ids, kbNames: names, hits: [], reranked: false };

    all.sort((a, b) => b.score - a.score);
    const cands = all.slice(0, Math.max(per, k * 2));
    const useRerank = rerank === undefined ? cfg.retrieval.rerank : !!rerank;
    const hits = useRerank ? await llmRerank(cands, query, llm, k) : cands.slice(0, k);
    return { ok: true, kbIds: ids, kbNames: names, hits, reranked: useRerank };
  }

  /** 导入一篇文档。向量模型与分块策略都用「配置 · 知识库」里的当前值。 */
  async ingest({ kbId, docId, type, content, onProgress }) {
    const kb = this.store.getKb(kbId);
    if (!kb) return { ok: false, error: '知识库不存在' };
    const embedder = this.embedderForKb();
    return ingestDocument({
      store: this.store, kbId, docId, type, content,
      chunkConfig: this.config().chunkConfig, embedder, onProgress
    });
  }
}

module.exports = { KnowledgeService, DEFAULT_RETRIEVAL };
