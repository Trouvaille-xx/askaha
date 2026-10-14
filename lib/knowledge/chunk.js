'use strict';

/**
 * 分块: 把一段纯文本切成检索用的块。
 *
 * 三种策略 (配置页可选):
 *   fixed      —— 固定长度 + 重叠。最快, 不挑内容。
 *   structural —— 按 Markdown 标题 / 段落切。结构清晰的文档最准。
 *   semantic   —— 按句子语义相似度断句 (相邻句余弦低于阈值就断开)。
 *                 需要向量模型 (要 embedBatch), 没有就退化成 structural。
 *
 * 统一返回 [{ text, section }]。section 是"这块属于哪一节"的人类可读路径,
 * 既进检索结果的展示, 也进元数据参与排序 (同一节被命中说明用户问的是那一段)。
 */

const { cosine } = require('./math');

const MAX_CHUNKS = 20000;   // 防御: 再离谱的文档也不该切出这么多块

function cleanText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 句子级切分: 中文标点 + 英文标点, 尽量保留标点 */
function splitSentences(text) {
  const out = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    // 在 。！？；.!?; 之后断句 (英文句点要跟空格/结尾, 免得切坏小数、缩写)
    const parts = t.split(/(?<=[。！？；])|(?<=[.!?;])\s+/);
    for (const p of parts) {
      const s = p.trim();
      if (s) out.push(s);
    }
  }
  return out;
}

/** 在 [lo, hi) 区间里找一个"好看的"断点 (段落 > 句末 > 空白), 找不到就返回 hi */
function niceBreak(text, lo, hi) {
  const para = text.lastIndexOf('\n\n', hi);
  if (para > lo) return para + 2;
  const win = text.slice(lo, hi);
  let best = -1;
  const re = /[。！？；.!?;\n]/g;
  let m;
  while ((m = re.exec(win)) !== null) best = lo + m.index + 1;
  if (best > lo) return best;
  const sp = text.lastIndexOf(' ', hi);
  if (sp > lo) return sp + 1;
  return hi;
}

function chunkFixed(text, { size = 800, overlap = 120 } = {}) {
  const t = cleanText(text);
  if (!t) return [];
  const s = Math.max(120, Math.floor(size));
  const ov = Math.max(0, Math.min(Math.floor(overlap), s - 1));
  const chunks = [];
  let start = 0;
  while (start < t.length && chunks.length < MAX_CHUNKS) {
    let end = Math.min(start + s, t.length);
    if (end < t.length) end = niceBreak(t, start + Math.floor(s * 0.6), end);
    const seg = t.slice(start, end).trim();
    if (seg) chunks.push({ text: seg, section: '' });
    if (end >= t.length) break;
    start = Math.max(end - ov, start + 1);
  }
  return chunks;
}

function chunkStructural(text, { size = 800, overlap = 120 } = {}) {
  const t = cleanText(text);
  if (!t) return [];
  const lines = t.split('\n');
  const sections = [];
  let path = [];
  let buf = [];
  const flush = () => {
    const body = buf.join('\n').trim();
    if (body) sections.push({ path: path.slice(), body });
    buf = [];
  };
  for (const line of lines) {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flush();
      const level = h[1].length;
      path = path.slice(0, level - 1);
      path[level - 1] = h[2].trim();
      continue;
    }
    buf.push(line);
  }
  flush();

  const out = [];
  for (const sec of sections) {
    const title = sec.path.filter(Boolean).join(' / ');
    if (sec.body.length <= size) {
      out.push({ text: sec.body, section: title });
    } else {
      // 一节太长 → 退化成固定分块, 但保留节标题
      for (const c of chunkFixed(sec.body, { size, overlap })) {
        out.push({ text: c.text, section: title });
      }
    }
  }
  return out.slice(0, MAX_CHUNKS);
}

/**
 * 语义分块。需要 opts.embedBatch(texts) -> Promise<number[][]>。
 * 没有 embedBatch 时退化成 structural (配置页会提示"未配向量模型, 语义分块不可用")。
 */
async function chunkSemantic(text, { size = 800, semanticThreshold = 0.72 } = {}, opts = {}) {
  const embedBatch = opts.embedBatch;
  if (typeof embedBatch !== 'function') return chunkStructural(text, { size });
  const t = cleanText(text);
  if (!t) return [];
  const units = splitSentences(t);
  if (units.length <= 1) return chunkSemanticFallback(units, size);

  let vecs;
  try {
    vecs = await embedBatch(units);
  } catch (e) {
    // 向量化失败不该让整篇导入失败 —— 退化成结构分块, 由上层记一个 warning
    return chunkStructural(text, { size });
  }

  // 断点: 相邻句相似度低于阈值处
  const groups = [];
  let cur = [units[0]];
  for (let i = 1; i < units.length; i++) {
    const sim = cosine(vecs[i - 1] || [], vecs[i] || []);
    if (sim < semanticThreshold || cur.join('').length > size) {
      groups.push(cur);
      cur = [];
    }
    cur.push(units[i]);
  }
  if (cur.length) groups.push(cur);

  // 重叠: 上一组的最后一句带进下一组 (语义块的重叠, 不是字符重叠)
  const out = [];
  for (let i = 0; i < groups.length; i++) {
    const head = i > 0 ? [groups[i - 1][groups[i - 1].length - 1]] : [];
    const body = head.concat(groups[i]).join('');
    const seg = body.trim();
    if (seg) out.push({ text: seg, section: '' });
  }
  return out.slice(0, MAX_CHUNKS);
}

function chunkSemanticFallback(units, size) {
  const out = [];
  let cur = '';
  for (const u of units) {
    if (cur && (cur + u).length > size) { out.push({ text: cur.trim(), section: '' }); cur = ''; }
    cur += u;
  }
  if (cur.trim()) out.push({ text: cur.trim(), section: '' });
  return out;
}

/**
 * 统一入口。
 * @returns Promise<[{ text, section }]>
 */
async function chunkText(text, config = {}, opts = {}) {
  const strategy = config.strategy || 'fixed';
  if (strategy === 'structural') return chunkStructural(text, config);
  if (strategy === 'semantic') return chunkSemantic(text, config, opts);
  return chunkFixed(text, config);
}

module.exports = { chunkText, chunkFixed, chunkStructural, chunkSemantic, cleanText, splitSentences };
