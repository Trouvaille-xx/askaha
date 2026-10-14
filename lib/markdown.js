/**
 * 极简 markdown 渲染器 —— 只覆盖模型在对话里真正会吐的那几种语法。
 *
 * 为什么自己写而不装库:
 *   这个项目没有打包器, 页面是几个平铺的 <script>。装 marked / markdown-it 就得
 *   把整个 dist 塞进仓库再手工引进来, 而对话里出现过的语法其实只有标题、加粗、
 *   列表、行内代码、代码块、引用、链接、表格这几种。
 *
 * 安全上只有一条规则, 但它是硬规则:
 *   **先把整段文本转义, 再往上加自己的标签。**
 *   模型输出必须当成不可信文本 —— 它可能吐出 <script> 或 <img onerror=...>。
 *   先转义的话, 原始 HTML 一个字符都活不下来, 页面上出现的标签全是这里生成的。
 *   顺序反了 (先格式化再转义) 就等于开了个注入口子。
 *
 * 链接只放行 http / https / mailto —— javascript: 和 data: 一律降级成纯文本。
 *
 * 同一份代码两处用:
 *   Node 侧 (测试、以后生成 HTML) 走 module.exports;
 *   浏览器侧 (src/index.html 直接 <script src="../lib/markdown.js">) 挂到
 *   window.SoloMarkdown。所以下面那段 UMD 外壳是必要的, 不是样板。
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SoloMarkdown = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // 围栏代码块的占位符。用 \u0000 包起来: 转义不会碰它, 正文里也不会出现。
  const TOKEN = '\u0000C';
  const TOKEN_RE = /\u0000C(\d+)\u0000/g;

  /** 只放行 http / https / mailto, 其余一律不生成 <a> */
  function safeUrl(url) {
    const u = String(url || '').trim();
    return /^(https?:\/\/|mailto:)/i.test(u) ? u : null;
  }

  /** 行内语法: 代码 -> 加粗 -> 斜体 -> 链接 -> 还原代码块占位符 */
  function inline(s) {
    let t = s;

    // 行内代码先抽出来, 免得里面的星号被当成强调 (内容已经是转义过的)
    const codes = [];
    t = t.replace(/`([^`]+)`/g, (m, c) => {
      codes.push(c);
      return '\u0001' + (codes.length - 1) + '\u0001';
    });

    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    // 斜体: 前后不能是星号, 否则 ** 会被吃掉一半
    t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    t = t.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');

    // 链接。URL 不合法就整段按纯文本留着 (不生成 a 标签)
    t = t.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (m, text, url) => {
      const ok = safeUrl(url);
      return ok ? '<a href="' + ok + '" target="_blank" rel="noreferrer">' + (text || ok) + '</a>'
        : m;
    });
    // 裸链接
    t = t.replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+)/g, (m, pre, url) =>
      pre + '<a href="' + url + '" target="_blank" rel="noreferrer">' + url + '</a>');

    // 还原行内代码
    t = t.replace(/\u0001(\d+)\u0001/g, (m, i) => '<code>' + codes[Number(i)] + '</code>');
    return t;
  }

  /** 表格分隔行: |---|:--:|---| */
  function isTableSep(line) {
    return /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.indexOf('-') !== -1 && line.indexOf('|') !== -1;
  }

  function splitRow(line) {
    return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
  }

  function renderMarkdown(src) {
    const raw = String(src == null ? '' : src).replace(/\r\n?/g, '\n');

    // 1. 先把围栏代码块抽走, 用占位符顶替 —— 里面的内容一个字符都不该被当 markdown
    const blocks = [];
    const staged = raw.replace(/```[^\n`]*\n?([\s\S]*?)(?:```|$)/g, (m, body) => {
      blocks.push(body.replace(/\n+$/, ''));
      return TOKEN + (blocks.length - 1) + '\u0000';
    });

    // 2. 整体转义 (顺序关键: 先转义, 后加标签)
    const lines = escapeHtml(staged).split('\n');

    const out = [];
    let para = [];
    let list = null;   // { tag, items }
    let quote = [];

    const flushPara = () => { if (para.length) { out.push('<p>' + para.join('<br>') + '</p>'); para = []; } };
    const flushList = () => {
      if (list) {
        out.push('<' + list.tag + '>' + list.items.map((i) => '<li>' + i + '</li>').join('') + '</' + list.tag + '>');
        list = null;
      }
    };
    const flushQuote = () => {
      if (quote.length) { out.push('<blockquote>' + quote.join('<br>') + '</blockquote>'); quote = []; }
    };
    const flushAll = () => { flushPara(); flushList(); flushQuote(); };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // 空行: 断掉所有块
      if (!line.trim()) { flushAll(); continue; }

      // 整行就是一个代码块占位符
      const only = line.trim().match(/^\u0000C(\d+)\u0000$/);
      if (only) {
        flushAll();
        out.push('<pre class="md-pre"><code>' + escapeHtml(blocks[Number(only[1])] || '') + '</code></pre>');
        continue;
      }

      // 表格: 当前行有竖线, 下一行是分隔行
      if (line.indexOf('|') !== -1 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        flushAll();
        const head = splitRow(line);
        const rows = [];
        i += 2;
        while (i < lines.length && lines[i].indexOf('|') !== -1 && lines[i].trim()) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        i--;
        out.push('<table class="md-table"><thead><tr>'
          + head.map((c) => '<th>' + inline(c) + '</th>').join('')
          + '</tr></thead><tbody>'
          + rows.map((r) => '<tr>' + head.map((c, k) => '<td>' + inline(r[k] || '') + '</td>').join('') + '</tr>').join('')
          + '</tbody></table>');
        continue;
      }

      // 标题
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        flushAll();
        const lv = h[1].length;
        out.push('<h' + lv + ' class="md-h">' + inline(h[2]) + '</h' + lv + '>');
        continue;
      }

      // 分隔线
      if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { flushAll(); out.push('<hr>'); continue; }

      // 引用
      const q = line.match(/^\s*&gt;\s?(.*)$/);
      if (q) { flushPara(); flushList(); quote.push(inline(q[1])); continue; }

      // 无序列表
      const ul = line.match(/^\s*[-*+]\s+(.*)$/);
      if (ul) {
        flushPara(); flushQuote();
        if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; }
        list.items.push(inline(ul[1]));
        continue;
      }

      // 有序列表
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ol) {
        flushPara(); flushQuote();
        if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; }
        list.items.push(inline(ol[1]));
        continue;
      }

      // 普通段落行
      flushList(); flushQuote();
      para.push(inline(line));
    }
    flushAll();

    return out.join('');
  }

  return { renderMarkdown, escapeHtml, safeUrl };
});
