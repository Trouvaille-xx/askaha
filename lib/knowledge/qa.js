'use strict';

/**
 * 问答飞轮存储。
 *
 * 每个知识库一条问答记录流 (<rootDir>/qa.jsonl, append-only)。
 * 一条记录 = 一次"调用了 RAG 的问答"的完整上下文 + 用户反馈。
 *
 * 为什么 append-only: 记录是"事实发生"的流水, 追加最抗损坏 —— 写到一半断电,
 * 顶多丢最后一行, 前面的都还在。唯一的例外是**反馈**: 用户点 👍/👎 要改已有记录,
 * 那就整份重写一次 (记录量级不大, 可接受)。重写走 writeFileAtomic。
 *
 * 字段面向"飞轮": 哪类问题答不好 → 补哪份文档 → 再测。所以 ragHits 里保留
 * 命中了哪些块、分数多少; feedbackReason 保留结构化标签 + 自由文本。
 */

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('../atomic-write');
const { assertSafeId } = require('../safe-id');

const FEEDBACK_TAGS = ['有害/不安全', '虚假信息', '没有帮助', '其他'];

class QaStore {
  constructor({ rootDir }) {
    this.rootDir = rootDir;
    if (!fs.existsSync(this.rootDir)) fs.mkdirSync(this.rootDir, { recursive: true });
  }

  _file() { return path.join(this.rootDir, 'qa.jsonl'); }

  _readAll() {
    try {
      return fs.readFileSync(this._file(), 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
        .filter(Boolean);
    } catch (e) { return []; }
  }

  /** 追加一条问答记录 */
  record(entry) {
    const rec = {
      id: entry.id || ('qa_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)),
      ts: entry.ts || new Date().toISOString(),
      user: entry.user || '本机用户',
      kbId: entry.kbId || null,
      kbName: entry.kbName || '',
      conversationId: entry.conversationId || null,
      question: String(entry.question || '').slice(0, 4000),
      answer: String(entry.answer || '').slice(0, 20000),
      reasoning: String(entry.reasoning || '').slice(0, 20000),
      // 执行步骤 (结构化), 供"查看"里画执行流程图。每项 {kind, title}
      steps: Array.isArray(entry.steps) ? entry.steps.slice(0, 60) : [],
      // 决策轨迹 (闸门判定 / 读表 / 检索 / SQL / 收尾), 每项 {kind, title, detail}
      trace: Array.isArray(entry.trace) ? entry.trace.slice(0, 80) : [],
      ragHits: Array.isArray(entry.ragHits) ? entry.ragHits.slice(0, 20) : [],
      model: entry.model || '',
      latencyMs: entry.latencyMs || 0,
      usage: entry.usage || null,
      feedback: null,               // null | 'up' | 'down'
      feedbackTags: [],
      feedbackText: '',
      feedbackAt: null
    };
    try {
      fs.appendFileSync(this._file(), JSON.stringify(rec) + '\n', 'utf-8');
      return { ok: true, record: rec };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** 更新一条记录的反馈 (整份重写落盘) */
  setFeedback(id, { verdict, tags, text }) {
    assertSafeId(id, '问答 id');
    const all = this._readAll();
    const rec = all.find((r) => r.id === id);
    if (!rec) return { ok: false, error: '记录不存在' };
    if (verdict === 'up' || verdict === 'down' || verdict === null) rec.feedback = verdict;
    if (Array.isArray(tags)) rec.feedbackTags = tags.filter((t) => FEEDBACK_TAGS.includes(t));
    if (typeof text === 'string') rec.feedbackText = text.slice(0, 2000);
    rec.feedbackAt = new Date().toISOString();
    writeFileAtomic(this._file(), all.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return { ok: true, record: rec };
  }

  /** 列表 + 筛选 */
  list({ feedback, from, to, kbId, q, limit } = {}) {
    let rows = this._readAll();
    if (feedback) rows = rows.filter((r) => r.feedback === feedback);
    if (kbId) rows = rows.filter((r) => r.kbId === kbId);
    if (from) rows = rows.filter((r) => r.ts >= from);
    if (to) rows = rows.filter((r) => r.ts <= to);
    if (q) {
      const needle = String(q).toLowerCase();
      rows = rows.filter((r) => (r.question || '').toLowerCase().includes(needle) || (r.answer || '').toLowerCase().includes(needle));
    }
    rows.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    const total = rows.length;
    if (limit) rows = rows.slice(0, limit);
    return { total, rows };
  }

  get(id) {
    assertSafeId(id, '问答 id');
    return this._readAll().find((r) => r.id === id) || null;
  }

  /** 导出: jsonl | csv */
  export(format = 'jsonl', filter = {}) {
    const { rows } = this.list(Object.assign({ limit: 0 }, filter));
    if (format === 'csv') {
      const head = ['id', 'ts', 'user', 'kbName', 'question', 'answer', 'feedback', 'feedbackTags', 'feedbackText', 'model', 'latencyMs'];
      const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"';
      return [head.join(',')].concat(rows.map((r) => head.map((k) => esc(k === 'feedbackTags' ? (r[k] || []).join('|') : r[k])).join(','))).join('\n');
    }
    return rows.map((r) => JSON.stringify(r)).join('\n');
  }
}

module.exports = { QaStore, FEEDBACK_TAGS };
