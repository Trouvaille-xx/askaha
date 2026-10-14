'use strict';

/**
 * 文档文本抽取。
 *
 * 一期支持 (见决策记录 D5):
 *   md / txt   —— 直接读
 *   docx       —— 内置最小 ZIP 读取 (zlib.inflateRaw) + 解 word/document.xml 的 <w:t>
 *   richtext   —— 富文本 HTML → 纯文本
 *   qa         —— 问答对清单 → 每对拼成一块文本
 *   pdf        —— **不内建解析**。没有零依赖的可靠 PDF 文本抽取; 硬写一个
 *                 "能跑一半"的解析器会产出静默的错误文本, 比明说更糟。
 *                 走"粘贴文本"入口 (前端提示), 这里只留一个明确的报错。
 *
 * 为什么用 zip 直读而不是引依赖: docx 就是一个 zip + 一份 XML, 用 Node 自带的
 * zlib 解 deflate 就够; 引 mammoth 之类会带来体积与离线安装风险, 见决策记录。
 */

const zlib = require('zlib');

// ---------- ZIP (只读, 只为从 docx 里取一个 entry) ----------

function readZipEntry(buf, name) {
  // 1) 找 EOCD (0x06054b50), 从尾部往前扫 (注释最长 64KB)
  let eocd = -1;
  const min = Math.max(0, buf.length - 22 - 65536);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const cdCount = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  // 2) 遍历中央目录找目标 entry
  let p = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const entryName = buf.toString('utf-8', p + 46, p + 46 + nameLen);
    if (entryName === name) {
      // 3) 读本地头, 跳过文件名/扩展区, 拿压缩数据
      const lhNameLen = buf.readUInt16LE(localOffset + 26);
      const lhExtraLen = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
      const data = buf.slice(dataStart, dataStart + compSize);
      if (method === 0) return data;                 // stored
      if (method === 8) return zlib.inflateRawSync(data); // deflate
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function decodeXmlEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function docxToText(buf) {
  const xml = readZipEntry(buf, 'word/document.xml');
  if (!xml) throw new Error('这个 .docx 读不出正文 (可能不是标准 docx, 或已加密)');
  const s = xml.toString('utf-8');
  // 每个 </w:p> 是一个段落; 段落里所有 <w:t> 拼起来是文本
  const paras = s.split(/<\/w:p>/);
  const lines = paras.map((para) => {
    const runs = [];
    const re = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
    let m;
    while ((m = re.exec(para)) !== null) runs.push(m[1]);
    return decodeXmlEntities(runs.join(''));
  });
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- 富文本 / 问答对 ----------

function htmlToText(html) {
  return decodeXmlEntities(
    String(html || '')
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, '')
  ).replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 问答对解析。容忍三种形态:
 *   1) JSON: [{ "q": "...", "a": "..." }, ...] (或 question/answer 字段)
 *   2) 空行分隔的 Q/A: 每段首行以 Q:/问:/Q. 开头, 次行 A:/答:
 *   3) 制表符两列
 * 每对拼成"问: ...\n答: ...", 作为**一个块** (问答对不该被切开)。
 */
function qaPairsToDocs(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  // 形态 1: JSON
  if (raw[0] === '[' || raw[0] === '{') {
    try {
      const arr = JSON.parse(raw);
      const list = Array.isArray(arr) ? arr : [arr];
      return list.map((x) => `问: ${x.q || x.question || x.Q || ''}\n答: ${x.a || x.answer || x.A || ''}`).filter((s) => s.length > 4);
    } catch (e) { /* 不是 JSON, 往下走 */ }
  }
  // 形态 3: 制表符两列
  const tabLines = raw.split('\n').filter((l) => l.includes('\t'));
  if (tabLines.length >= 2 && tabLines.length >= raw.split('\n').filter(Boolean).length * 0.6) {
    return tabLines.map((l) => {
      const [q, ...rest] = l.split('\t');
      return `问: ${q.trim()}\n答: ${rest.join('\t').trim()}`;
    }).filter((s) => s.replace(/[问答:\s]/g, '').length > 2);
  }
  // 形态 2: 空行分隔的 Q/A 段
  const blocks = raw.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const pairs = [];
  for (const b of blocks) {
    const m = b.match(/^(?:Q|问|Q[:.])\s*[:.：]?\s*([\s\S]*?)\n(?:A|答|A[:.])\s*[:.：]?\s*([\s\S]*)$/);
    if (m) pairs.push(`问: ${m[1].trim()}\n答: ${m[2].trim()}`);
    else pairs.push(b);   // 认不出就整段当一块, 不丢内容
  }
  return pairs;
}

// ---------- 统一入口 ----------

/**
 * @param {string} type  md | txt | docx | richtext | qa | pdf
 * @param {Buffer|string} content  文件是 Buffer; 富文本/问答对是字符串
 * @returns {{ text: string, units?: string[] }} units 存在时表示"每项本就是一个块"
 */
function extractText(type, content) {
  switch (type) {
    case 'md':
    case 'txt':
      return { text: Buffer.isBuffer(content) ? content.toString('utf-8') : String(content || '') };
    case 'docx':
      return { text: docxToText(Buffer.isBuffer(content) ? content : Buffer.from(String(content))) };
    case 'richtext':
      return { text: htmlToText(content) };
    case 'qa':
      return { units: qaPairsToDocs(content) };
    case 'pdf':
      throw new Error('PDF 暂不支持直接解析 (一期) —— 请在导入时改用「粘贴文本」把内容贴进来。');
    default:
      return { text: Buffer.isBuffer(content) ? content.toString('utf-8') : String(content || '') };
  }
}

module.exports = { extractText, docxToText, htmlToText, qaPairsToDocs, readZipEntry };
