'use strict';

/**
 * 对话里的 markdown 渲染。
 *
 * 用户的要求: 「输出的内容需要把md格式渲染」。改动前 `updateMessageNode` 是
 * `body.textContent = msg.content`, 模型按 markdown 写的东西 (标题、加粗、列表)
 * 在页面上全是字面的 ** 和 ###。
 *
 * 这个文件里**安全那几条比格式那几条重要**。模型输出是不可信文本 —— 它可能
 * 吐出 <script> 或 <img onerror=...>, 也可能被用户的话诱导着吐出一个
 * javascript: 链接。渲染器唯一的防线是"先整体转义, 再加自己的标签", 顺序反了
 * 就等于开了个注入口子。所以那几条写成断言, 而不是靠注释提醒。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { renderMarkdown, escapeHtml, safeUrl } = require(path.join(__dirname, '..', 'lib', 'markdown.js'));

/* ============================================================
 * 1. 安全: 模型输出里的一切 HTML 都不许活下来
 * ============================================================ */

test('原始 <script> 不能活下来', () => {
  const html = renderMarkdown('正常一句话\n<script>alert(1)</script>');
  assert.ok(!/<script/i.test(html), '脚本标签漏出来了: ' + html);
  assert.match(html, /&lt;script&gt;/);
});

test('<img onerror> 这类标签不能活下来 (只剩转义后的纯文本)', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)>');
  // 真正的判据是"没有引入新标签", 而不是"文本里不出现 onerror" ——
  // 转义之后 onerror= 会作为**纯文本**留在页面上, 那是无害的, 也该留着
  // (否则用户就看不见模型到底写了什么)。
  assert.ok(!/<img/i.test(html), 'img 标签漏出来了: ' + html);
  assert.match(html, /^<p>&lt;img src=x onerror=alert\(1\)&gt;<\/p>$/,
    '应该原样转义成一段文本, 实际: ' + html);
});

test('svg / iframe / style 这些也一样', () => {
  for (const bad of ['<svg onload=alert(1)>', '<iframe src=javascript:alert(1)>', '<style>*{}</style>']) {
    const html = renderMarkdown(bad);
    assert.ok(!/<svg|<iframe|<style/i.test(html), bad + ' 漏出来了: ' + html);
  }
});

test('javascript: 链接降级成纯文本, 不生成 <a>', () => {
  const html = renderMarkdown('[点我](javascript:alert(1))');
  assert.ok(!/<a /i.test(html), '生成了 a 标签: ' + html);
  assert.ok(!/href/i.test(html), '出现了 href: ' + html);
});

test('data: 链接同样不放行', () => {
  const html = renderMarkdown('[x](data:text/html,<script>alert(1)</script>)');
  assert.ok(!/<a /i.test(html), '生成了 a 标签: ' + html);
});

test('http / https / mailto 放行', () => {
  assert.match(renderMarkdown('[文档](https://example.com/a)'), /<a href="https:\/\/example\.com\/a"/);
  assert.match(renderMarkdown('[写邮件](mailto:a@b.com)'), /<a href="mailto:a@b\.com"/);
  assert.strictEqual(safeUrl('javascript:x'), null);
  assert.strictEqual(safeUrl('  https://a.b  '), 'https://a.b');
});

test('链接文字里的 HTML 也转义了', () => {
  const html = renderMarkdown('[<b>x</b>](https://a.b)');
  assert.ok(!/<b>/i.test(html), '链接文字里的标签漏出来了: ' + html);
  assert.match(html, /&lt;b&gt;/);
});

test('代码块里的 HTML 被转义, 而且不被当 markdown', () => {
  const html = renderMarkdown('```\n<script>alert(1)</script>\n**不该变粗**\n```');
  assert.ok(!/<script/i.test(html), '代码块里的脚本漏出来了: ' + html);
  assert.ok(!/<strong>/i.test(html), '代码块里的 ** 被当成加粗了: ' + html);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /\*\*不该变粗\*\*/);
});

test('行内代码里的星号不被当成强调', () => {
  const html = renderMarkdown('用 `a**b**c` 这样写');
  assert.match(html, /<code>a\*\*b\*\*c<\/code>/);
  assert.ok(!/<strong>/i.test(html));
});

test('顺序: 先转义再格式化 (反例是 <b> 这种"看起来像 markdown"的标签)', () => {
  // 如果实现是先格式化再转义, 这里 <strong> 会被自己转义成 &lt;strong&gt;
  const html = renderMarkdown('**粗**');
  assert.match(html, /<strong>粗<\/strong>/, '自己生成的标签不该被转义');
  assert.ok(!/&lt;strong&gt;/.test(html));
});

/* ============================================================
 * 2. 格式: 模型真正会吐的那几种
 * ============================================================ */

test('标题', () => {
  assert.match(renderMarkdown('## 二级标题'), /<h2 class="md-h">二级标题<\/h2>/);
  assert.match(renderMarkdown('### 三级'), /<h3 class="md-h">三级<\/h3>/);
  assert.match(renderMarkdown('# 一级'), /<h1 class="md-h">一级<\/h1>/);
});

test('加粗与斜体', () => {
  assert.match(renderMarkdown('**加粗**'), /<strong>加粗<\/strong>/);
  assert.match(renderMarkdown('这是 *斜* 的'), /<em>斜<\/em>/);
  // ** 不该被斜体规则吃掉一半
  const html = renderMarkdown('**粗**');
  assert.ok(!/<em>/.test(html), '斜体规则误伤了加粗: ' + html);
});

test('无序列表', () => {
  const html = renderMarkdown('- 第一项\n- 第二项\n* 第三项');
  assert.match(html, /<ul><li>第一项<\/li><li>第二项<\/li><li>第三项<\/li><\/ul>/);
});

test('有序列表', () => {
  const html = renderMarkdown('1. 甲\n2. 乙');
  assert.match(html, /<ol><li>甲<\/li><li>乙<\/li><\/ol>/);
});

test('列表和段落要断开 (不能把后面的段落吞进 li)', () => {
  const html = renderMarkdown('- 一项\n\n普通段落');
  assert.match(html, /<\/ul><p>普通段落<\/p>/);
});

test('代码块', () => {
  const html = renderMarkdown('```sql\nSELECT 1\n```');
  assert.match(html, /<pre class="md-pre"><code>SELECT 1<\/code><\/pre>/);
});

test('引用', () => {
  assert.match(renderMarkdown('> 引用一句'), /<blockquote>引用一句<\/blockquote>/);
});

test('分隔线', () => {
  assert.match(renderMarkdown('上面\n\n---\n\n下面'), /<hr>/);
});

test('表格', () => {
  const md = '| 名字 | 数量 |\n|---|---|\n| 甲 | 1 |\n| 乙 | 2 |';
  const html = renderMarkdown(md);
  assert.match(html, /<table class="md-table">/);
  assert.match(html, /<th>名字<\/th><th>数量<\/th>/);
  assert.match(html, /<td>甲<\/td><td>1<\/td>/);
  assert.match(html, /<td>乙<\/td><td>2<\/td>/);
});

test('表格单元格里的加粗也渲染', () => {
  const html = renderMarkdown('| a |\n|---|\n| **粗** |');
  assert.match(html, /<td><strong>粗<\/strong><\/td>/);
});

test('表格后面还能接普通段落 (不能被吞掉)', () => {
  const html = renderMarkdown('| a |\n|---|\n| 1 |\n\n结尾一句');
  assert.match(html, /<\/table><p>结尾一句<\/p>/);
});

/* ============================================================
 * 3. 边界
 * ============================================================ */

test('空输入不炸', () => {
  assert.strictEqual(renderMarkdown(''), '');
  assert.strictEqual(renderMarkdown(null), '');
  assert.strictEqual(renderMarkdown(undefined), '');
});

test('没有 markdown 语法时, 换行仍然保留成段落', () => {
  const html = renderMarkdown('第一行\n第二行');
  assert.match(html, /第一行<br>第二行/);
});

test('没闭合的代码块也要有收尾 (流式输出中途会这样)', () => {
  const html = renderMarkdown('```js\nconst a = 1');
  assert.match(html, /<pre class="md-pre">/);
  assert.match(html, /const a = 1/);
});

test('CRLF 也认', () => {
  assert.match(renderMarkdown('- a\r\n- b'), /<ul><li>a<\/li><li>b<\/li><\/ul>/);
});

test('真实那次的助手回复能渲染出来 (回归)', () => {
  // 这是用户实际看到过的一段输出, 改动前它满屏都是字面的 ** 和 -
  const md = [
    '我是查业务数据的助手，主要能帮你看这几类问题：',
    '',
    '**1. 送货单 / 签收相关**',
    '- 查送货单的签收状态（给我送货单号）',
    '- 比亚迪客户场景：按 SO 单号查客户签收时间',
    '',
    '**我做不了的**：天气、新闻这类。'
  ].join('\n');
  const html = renderMarkdown(md);
  assert.ok(!/\*\*/.test(html), '还有字面的星号: ' + html);
  assert.match(html, /<strong>1\. 送货单 \/ 签收相关<\/strong>/);
  assert.match(html, /<ul><li>查送货单的签收状态/);
  assert.match(html, /<p>我是查业务数据的助手/);
});
