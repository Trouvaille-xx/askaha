/**
 * 运行记录 (RunRecord) 持久化。
 *
 * 一次 agent 运行 = 一条记录: 问题、来源、状态、最终回复、计划、步骤、trace、
 * 风险结果、耗时、模型、能力命中、用量。它既是"运行历史"的数据源, 也是 Eval
 * 评分器读取"这次真实跑了什么"的依据。
 *
 * 目录结构 (在 userData 下):
 *   runs/index.json   索引 (轻量摘要, 供列表快速加载)
 *   runs/<id>.json    单条完整记录
 *
 * 和 ai-chat-store 同款约定: id 过白名单 (防 `..` 越级), 写盘走原子 rename。
 */

const fs = require('fs');
const path = require('path');
const { assertSafeId } = require('./safe-id');
const { writeFileAtomic } = require('./atomic-write');

class RunsStore {
  constructor({ rootDir }) {
    this.dir = path.join(rootDir, 'runs');
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
  }

  _indexPath() {
    return path.join(this.dir, 'index.json');
  }

  _path(id) {
    assertSafeId(id, '运行 id');
    return path.join(this.dir, `${id}.json`);
  }

  readIndex() {
    let raw;
    try {
      raw = fs.readFileSync(this._indexPath(), 'utf-8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return [];
      return this._rebuildIndex(e);
    }
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr;
    } catch (e) {}
    return this._rebuildIndex(new Error('索引不是数组'));
  }

  _rebuildIndex(cause) {
    console.error('运行记录索引读不出来, 正在从记录文件重建:', (cause && cause.message) || cause);
    const out = [];
    let files = [];
    try {
      files = fs.readdirSync(this.dir);
    } catch (e) {
      return out;
    }
    for (const f of files) {
      if (!f.endsWith('.json') || f === 'index.json') continue;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf-8'));
        if (rec && rec.id) out.push(RunsStore.summary(rec));
      } catch (e) {}
    }
    return out;
  }

  writeIndex(list) {
    writeFileAtomic(this._indexPath(), JSON.stringify(list, null, 2));
  }

  /** 索引里的轻量摘要 —— 列表只读它, 不把 trace/steps 拖进内存 */
  static summary(rec) {
    return {
      id: rec.id,
      question: rec.question || '',
      source: rec.source || 'chat',
      status: rec.status || 'ok',
      createdAt: rec.createdAt || null,
      durationMs: rec.durationMs || 0,
      model: rec.model || '',
      provider: rec.provider || '',
      riskLevel: (rec.riskResult && rec.riskResult.level) || 'none'
    };
  }

  create(record) {
    const rec = Object.assign({}, record);
    if (!rec.id) rec.id = 'r_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    if (!rec.createdAt) rec.createdAt = new Date().toISOString();
    assertSafeId(rec.id, '运行 id');
    writeFileAtomic(this._path(rec.id), JSON.stringify(rec, null, 2));
    const list = this.readIndex().filter((c) => c.id !== rec.id);
    list.unshift(RunsStore.summary(rec));
    this.writeIndex(list);
    return { ok: true, run: rec };
  }

  get(id) {
    if (!id) return null;
    try {
      return JSON.parse(fs.readFileSync(this._path(id), 'utf-8'));
    } catch (e) {
      return null;
    }
  }

  list({ source, status, limit } = {}) {
    let list = this.readIndex();
    if (source) list = list.filter((r) => r.source === source);
    if (status) list = list.filter((r) => r.status === status);
    list = list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    if (limit && limit > 0) list = list.slice(0, limit);
    return list;
  }

  /** 局部更新 (人工接管 / 标注 / 关联重试)。只改传入字段。 */
  patch(id, patch) {
    const rec = this.get(id);
    if (!rec) return { ok: false, error: '运行记录不存在' };
    Object.assign(rec, patch || {});
    rec.updatedAt = new Date().toISOString();
    writeFileAtomic(this._path(id), JSON.stringify(rec, null, 2));
    const list = this.readIndex().filter((c) => c.id !== id);
    list.unshift(RunsStore.summary(rec));
    this.writeIndex(list);
    return { ok: true, run: rec };
  }

  remove(id) {
    try {
      if (fs.existsSync(this._path(id))) fs.unlinkSync(this._path(id));
    } catch (e) {}
    this.writeIndex(this.readIndex().filter((c) => c.id !== id));
    return { ok: true };
  }
}

module.exports = RunsStore;
