'use strict';

/**
 * 知识库持久化: 知识库 / 文件夹 / 文档 / 分块 / 向量。
 *
 * 目录结构 (都在 userData/knowledge 下):
 *   index.json                  知识库索引, 供列表快速加载
 *   <kbId>/kb.json              单个知识库的元数据 (含 folders、docs 清单)
 *   <kbId>/chunks/<docId>.json  该文档的分块数组
 *   <kbId>/vectors/<docId>.f32  该文档的分块向量 (Float32 二进制, 行优先)
 *
 * 设计取舍:
 * - 检索**只在一个知识库内**做 (需求: 不支持跨知识库)。所以按 kbId 分目录,
 *   检索时天然只看得到当前库的向量, 不需要额外的过滤。
 * - 分块与向量各自成文件: 一个文档几万块时, 把它们塞进 kb.json 会让"改个文档名"
 *   也重写几 MB —— 分开存后, 改元数据不碰大文件。
 * - 向量用 Float32 二进制而不是 JSON 数字数组: 同样 1536 维, JSON 大约 15KB,
 *   二进制 6KB, 且读出来直接是 Float32Array, 不用 parse 几千个数字。
 * - 一切落盘走 writeFileAtomic、一切 id 走 assertSafeId —— 前者防半截文件,
 *   后者防 `../config` 这类路径穿越 (知识库 id 也会来自渲染层)。
 */

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('../atomic-write');
const { assertSafeId } = require('../safe-id');

const KB_ID = /^kb_[A-Za-z0-9_-]{1,60}$/;
const FOL_ID = /^fol_[A-Za-z0-9_-]{1,60}$/;
const DOC_ID = /^doc_[A-Za-z0-9_-]{1,60}$/;

function newId(prefix) {
  return prefix + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

class KnowledgeStore {
  constructor({ rootDir }) {
    this.rootDir = rootDir;
    this._ensureDirs();
  }

  _ensureDirs() {
    if (!fs.existsSync(this.rootDir)) fs.mkdirSync(this.rootDir, { recursive: true });
  }

  _indexPath() { return path.join(this.rootDir, 'index.json'); }

  _kbDir(kbId) {
    assertSafeId(kbId, '知识库 id');
    if (!KB_ID.test(kbId)) throw new Error('非法的知识库 id');
    return path.join(this.rootDir, kbId);
  }
  _kbFile(kbId) { return path.join(this._kbDir(kbId), 'kb.json'); }
  _chunkDir(kbId) { return path.join(this._kbDir(kbId), 'chunks'); }
  _vecDir(kbId) { return path.join(this._kbDir(kbId), 'vectors'); }

  _readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) { return fallback; }
  }

  // ==================== 知识库 ====================

  listKbs() {
    const idx = this._readJson(this._indexPath(), null);
    if (Array.isArray(idx)) {
      // 老索引可能没有 folders 字段 (这个字段是后加的)。缺的从 kb.json 补上并回写 ——
      // 否则升级后左侧文件夹树会对已存在的文件夹"视而不见"。
      let dirty = false;
      const out = idx.map((e) => {
        if (Array.isArray(e.folders)) return e;
        const kb = this._readJson(this._kbFile(e.id), null);
        if (kb) { dirty = true; return this._kbSummary(kb); }
        return e;
      });
      if (dirty) { try { this._writeIndex(out); } catch (err) {} }
      return out.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    }
    // 索引坏/缺失: 从各知识库重建, 而不是当成空 (和 lib/store.js 同一套思路)
    const rebuilt = [];
    for (const name of this._dirs()) {
      const kb = this._readJson(this._kbFile(name), null);
      if (kb) rebuilt.push(this._kbSummary(kb));
    }
    if (rebuilt.length) this._writeIndex(rebuilt);
    return rebuilt;
  }

  _dirs() {
    try {
      return fs.readdirSync(this.rootDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && KB_ID.test(e.name))
        .map((e) => e.name);
    } catch (e) { return []; }
  }

  _kbSummary(kb) {
    return {
      id: kb.id,
      name: kb.name,
      desc: kb.desc || '',
      embeddingModel: (kb.embedding && kb.embedding.model) || '',
      chunkStrategy: (kb.chunkConfig && kb.chunkConfig.strategy) || 'fixed',
      createdAt: kb.createdAt,
      updatedAt: kb.updatedAt,
      // folders **要一起带上**: 前端左侧的文件夹树直接读 kb.folders 渲染。
      // 只给 folderCount 的话, 新建完文件夹侧边栏什么都不会变 (数据存了, 界面没得渲染)。
      // 文件夹很小 ({id,name,createdAt}), 放进索引可以接受。
      folders: Array.isArray(kb.folders) ? kb.folders : [],
      folderCount: (kb.folders || []).length,
      docCount: (kb.docs || []).length,
      chunkTotal: (kb.docs || []).reduce((n, d) => n + (d.chunkCount || 0), 0)
    };
  }

  _writeIndex(list) {
    writeFileAtomic(this._indexPath(), JSON.stringify(list, null, 2));
  }

  /** 把某个知识库的最新摘要写回索引 */
  _touchIndex(kb) {
    const list = this.listKbs().filter((x) => x.id !== kb.id);
    list.push(this._kbSummary(kb));
    this._writeIndex(list);
  }

  getKb(kbId) {
    const kb = this._readJson(this._kbFile(kbId), null);
    return kb || null;
  }

  createKb({ name, desc, embedding, chunkConfig }) {
    const id = newId('kb_');
    const now = new Date().toISOString();
    const dir = this._kbDir(id);
    fs.mkdirSync(path.join(dir, 'chunks'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'vectors'), { recursive: true });
    const kb = {
      id,
      name: String(name || '').trim().slice(0, 60) || '未命名知识库',
      desc: String(desc || '').slice(0, 300),
      // embedding 与 chunkConfig 在创建时定下, 之后改需显式确认 (见 updateKb)
      embedding: embedding || { provider: 'custom', baseURL: '', apiKey: '', model: '', dim: 0 },
      chunkConfig: chunkConfig || { strategy: 'fixed', size: 800, overlap: 120, semanticThreshold: 0.72 },
      folders: [],
      docs: [],
      createdAt: now,
      updatedAt: now
    };
    this._writeKb(kb);
    this._touchIndex(kb);
    return kb;
  }

  _writeKb(kb) {
    kb.updatedAt = new Date().toISOString();
    writeFileAtomic(this._kbFile(kb.id), JSON.stringify(kb, null, 2));
  }

  updateKb(kbId, patch) {
    const kb = this.getKb(kbId);
    if (!kb) return { ok: false, error: '知识库不存在' };
    if (typeof patch.name === 'string') kb.name = patch.name.trim().slice(0, 60) || kb.name;
    if (typeof patch.desc === 'string') kb.desc = patch.desc.slice(0, 300);
    if (patch.embedding && typeof patch.embedding === 'object') {
      kb.embedding = Object.assign({}, kb.embedding, patch.embedding);
    }
    if (patch.chunkConfig && typeof patch.chunkConfig === 'object') {
      kb.chunkConfig = Object.assign({}, kb.chunkConfig, patch.chunkConfig);
    }
    this._writeKb(kb);
    this._touchIndex(kb);
    return { ok: true, kb };
  }

  deleteKb(kbId) {
    const kb = this.getKb(kbId);
    if (!kb) return { ok: false, error: '知识库不存在' };
    try { fs.rmSync(this._kbDir(kbId), { recursive: true, force: true }); } catch (e) {}
    this._writeIndex(this.listKbs().filter((x) => x.id !== kbId));
    return { ok: true };
  }

  // ==================== 文件夹 (知识库内) ====================

  listFolders(kbId) {
    const kb = this.getKb(kbId);
    return kb ? (kb.folders || []) : [];
  }

  createFolder(kbId, { name }) {
    const kb = this.getKb(kbId);
    if (!kb) return { ok: false, error: '知识库不存在' };
    const folder = { id: newId('fol_'), name: String(name || '').trim().slice(0, 60) || '新建文件夹', createdAt: new Date().toISOString() };
    kb.folders = kb.folders || [];
    kb.folders.push(folder);
    this._writeKb(kb);
    this._touchIndex(kb);
    return { ok: true, folder, folders: kb.folders };
  }

  renameFolder(kbId, folderId, name) {
    const kb = this.getKb(kbId);
    if (!kb) return { ok: false, error: '知识库不存在' };
    assertSafeId(folderId, '文件夹 id');
    const f = (kb.folders || []).find((x) => x.id === folderId);
    if (!f) return { ok: false, error: '文件夹不存在' };
    f.name = String(name || '').trim().slice(0, 60) || f.name;
    this._writeKb(kb);
    this._touchIndex(kb);
    return { ok: true, folders: kb.folders };
  }

  deleteFolder(kbId, folderId) {
    const kb = this.getKb(kbId);
    if (!kb) return { ok: false, error: '知识库不存在' };
    assertSafeId(folderId, '文件夹 id');
    kb.folders = (kb.folders || []).filter((x) => x.id !== folderId);
    // 文件夹下的文档不删, 上浮到根 (删文件夹不等于删文档 —— 那样太容易误删)
    for (const d of (kb.docs || [])) if (d.folderId === folderId) d.folderId = null;
    this._writeKb(kb);
    this._touchIndex(kb);
    return { ok: true, folders: kb.folders, docs: kb.docs };
  }

  // ==================== 文档 ====================

  /** 文档清单 (不含分块正文/向量) */
  listDocs(kbId, folderId) {
    const kb = this.getKb(kbId);
    if (!kb) return [];
    const docs = kb.docs || [];
    return (folderId === undefined || folderId === null)
      ? docs
      : docs.filter((d) => (d.folderId || null) === folderId);
  }

  getDoc(kbId, docId) {
    const kb = this.getKb(kbId);
    if (!kb) return null;
    return (kb.docs || []).find((d) => d.id === docId) || null;
  }

  /**
   * 落一条文档记录。
   * params 里存"导入时用的全部参数" —— 详情弹窗直接读它, 不需要另外推。
   */
  createDoc(kbId, doc) {
    const kb = this.getKb(kbId);
    if (!kb) return { ok: false, error: '知识库不存在' };
    const now = new Date().toISOString();
    const rec = {
      id: newId('doc_'),
      name: String(doc.name || '').trim().slice(0, 120) || '未命名文档',
      type: doc.type || 'txt',            // md | txt | docx | richtext | qa | pdf
      folderId: doc.folderId || null,
      status: doc.status || 'pending',    // pending | processing | ready | failed
      error: doc.error || '',
      chunkCount: doc.chunkCount || 0,
      bytes: doc.bytes || 0,
      dim: doc.dim || 0,
      params: doc.params || {},           // 导入参数快照 (切块策略/重叠/模型/清洗选项…)
      createdAt: now,
      updatedAt: now
    };
    kb.docs = kb.docs || [];
    kb.docs.push(rec);
    this._writeKb(kb);
    this._touchIndex(kb);
    return { ok: true, doc: rec };
  }

  updateDoc(kbId, docId, patch) {
    const kb = this.getKb(kbId);
    if (!kb) return { ok: false, error: '知识库不存在' };
    assertSafeId(docId, '文档 id');
    const d = (kb.docs || []).find((x) => x.id === docId);
    if (!d) return { ok: false, error: '文档不存在' };
    for (const k of ['name', 'folderId', 'status', 'error', 'chunkCount', 'bytes', 'dim']) {
      if (patch[k] !== undefined) d[k] = patch[k];
    }
    if (patch.params && typeof patch.params === 'object') d.params = Object.assign({}, d.params, patch.params);
    d.updatedAt = new Date().toISOString();
    this._writeKb(kb);
    this._touchIndex(kb);
    return { ok: true, doc: d };
  }

  deleteDoc(kbId, docId) {
    const kb = this.getKb(kbId);
    if (!kb) return { ok: false, error: '知识库不存在' };
    assertSafeId(docId, '文档 id');
    kb.docs = (kb.docs || []).filter((x) => x.id !== docId);
    this._writeKb(kb);
    for (const f of [
      path.join(this._chunkDir(kbId), docId + '.json'),
      path.join(this._vecDir(kbId), docId + '.f32'),
      path.join(this._srcDir(kbId), docId + '.json')
    ]) {
      try { fs.unlinkSync(f); } catch (e) {}
    }
    this._touchIndex(kb);
    return { ok: true };
  }

  // ==================== 分块 + 向量 ====================

  writeChunks(kbId, docId, chunks) {
    assertSafeId(docId, '文档 id');
    const dir = this._chunkDir(kbId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    writeFileAtomic(path.join(dir, docId + '.json'), JSON.stringify(chunks));
  }

  readChunks(kbId, docId) {
    assertSafeId(docId, '文档 id');
    return this._readJson(path.join(this._chunkDir(kbId), docId + '.json'), []);
  }

  /**
   * 向量落盘: Float32 行优先。chunks 与 vectors 行序一一对应 ——
   * 检索返回的索引直接映射回 chunks[i], 不需要额外的主键表。
   */
  writeVectors(kbId, docId, vectors) {
    assertSafeId(docId, '文档 id');
    const dir = this._vecDir(kbId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const flat = new Float32Array(vectors.length * (vectors[0] ? vectors[0].length : 0));
    let o = 0;
    for (const v of vectors) { for (let i = 0; i < v.length; i++) flat[o++] = v[i]; }
    writeFileAtomic(path.join(dir, docId + '.f32'), Buffer.from(flat.buffer));
  }

  /** 读一个文档的向量, 返回 { dim, data: Float32Array } (data 可能为空) */
  readVectors(kbId, docId) {
    assertSafeId(docId, '文档 id');
    try {
      const buf = fs.readFileSync(path.join(this._vecDir(kbId), docId + '.f32'));
      const data = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
      const doc = this.getDoc(kbId, docId);
      const dim = (doc && doc.dim) || 0;
      return { dim, data };
    } catch (e) {
      return { dim: 0, data: new Float32Array(0) };
    }
  }

  // ==================== 来源 (留档, 供"重新处理") ====================
  //
  // 导入失败 (最常见: 当时还没配向量模型) 之后, 用户想在配好模型时**重跑一次**,
  // 而不是把文件再传一遍。所以导入时把来源留一份: 文件类记**路径**(重跑时重读),
  // 富文本/问答对记**正文**。没有它, 失败项就只能重传。

  _srcDir(kbId) { return path.join(this._kbDir(kbId), 'sources'); }

  writeSource(kbId, docId, obj) {
    assertSafeId(docId, '文档 id');
    const dir = this._srcDir(kbId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    writeFileAtomic(path.join(dir, docId + '.json'), JSON.stringify(obj));
  }

  readSource(kbId, docId) {
    assertSafeId(docId, '文档 id');
    return this._readJson(path.join(this._srcDir(kbId), docId + '.json'), null);
  }
}

module.exports = { KnowledgeStore, newId, KB_ID, FOL_ID, DOC_ID };
