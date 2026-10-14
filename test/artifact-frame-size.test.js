'use strict';

/**
 * 产物预览的 iframe 必须**自己带类**, 不能靠父元素的类名决定高度。
 *
 * 现场 (用户截图): 数据空间里打开一份 HTML 报告, 报告挤在顶上一条里, 下面
 * 一大片空白。量出来 iframe 只有 153px —— 那正是 Chromium 的 iframe 默认高度,
 * 说明**一条高度规则都没匹配上**。
 *
 * 根因: 高度规则写的是 `.art-body > iframe`, 而这段渲染逻辑被三个宿主复用:
 *
 *   对话页    #artBody          有 .art-body            -> 撑满
 *   全屏预览  holder            有 .art-body pf-card    -> 撑满
 *   数据空间  #spacePreviewBody 叫 .space-preview-body  -> 一条都匹配不上
 *
 * 这类 bug 的特征是: **JS 里写的类名和 CSS 里的选择器对不上, 而代码不报错** ——
 * 只是元素悄悄退回浏览器默认样式。所以这里测的不是"某个函数被调用了",
 * 而是"JS 挂上去的类名, CSS 里真的有对应的尺寸规则"。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf-8');

const APP = read('src/js/app.js');
const CSS = read('src/styles/main.css');
const HTML = read('src/index.html');

/* ============================================================
 * 1. iframe 自己带类
 * ============================================================ */

test('renderArtifactBody 给 iframe 挂了自己的类 (而不是指望父元素叫 .art-body)', () => {
  // 取 renderArtifactBody 函数体
  const i = APP.indexOf('async function renderArtifactBody(');
  assert.ok(i > 0, '找不到 renderArtifactBody');
  const body = APP.slice(i, APP.indexOf('\nasync function ', i + 10) > 0
    ? APP.indexOf('\nasync function ', i + 10) : i + 6000);

  const m = body.match(/createElement\('iframe'\)[\s\S]{0,900}?frame\.className\s*=\s*'([^']+)'/);
  assert.ok(m, 'renderArtifactBody 里创建 iframe 之后没有给它挂类名 —— ' +
    '这样只要宿主不叫 .art-body, iframe 就会退回默认的 150px');
  assert.strictEqual(m[1], 'art-frame');
});

test('CSS 里真的有 .art-frame 的尺寸规则', () => {
  const m = CSS.match(/\.art-frame\s*\{([^}]*)\}/);
  assert.ok(m, 'CSS 里找不到 .art-frame —— JS 挂了个没人认领的类名, 等于没挂');
  const rule = m[1];
  assert.match(rule, /flex\s*:/, '.art-frame 要有 flex, 否则在 flex 父容器里撑不满');
  assert.match(rule, /min-height\s*:\s*0/, 'flex 子项默认 min-height:auto, 不加 0 撑不开');
  assert.match(rule, /width\s*:\s*100%/);
});

test('三个宿主都能让 iframe 撑满', () => {
  // 对话页 + 全屏预览: 靠 .art-body 本身是 flex 列
  const artBody = CSS.match(/\.art-body\s*\{([^}]*)\}/);
  assert.ok(artBody, '找不到 .art-body 规则');
  assert.match(artBody[1], /display\s*:\s*flex/);
  assert.match(artBody[1], /flex-direction\s*:\s*column/);

  // 数据空间: 靠 .space-preview-body 是 flex 列
  const spBody = CSS.match(/\.space-preview-body\s*\{([^}]*)\}/);
  assert.ok(spBody, '找不到 .space-preview-body 规则');
  assert.match(spBody[1], /display\s*:\s*flex/);
  assert.match(spBody[1], /flex-direction\s*:\s*column/);
  assert.match(spBody[1], /min-height\s*:\s*0/);
});

/* ============================================================
 * 2. 数据空间那条路确实把 iframe 放进了一个 flex 列的宿主
 * ============================================================ */

test('数据空间的预览宿主有 .space-preview-body 类 (iframe 的 flex 父容器)', () => {
  assert.match(APP, /class="space-preview-body"\s+id="spacePreviewBody"/,
    'spacePreviewBody 的类名变了的话, .space-preview-body 的 flex 规则就失效了');
});

test('数据空间走的是 framed=false 那条路 (iframe 直接进宿主, 没有 .art-body 包裹)', () => {
  // 这条断言是在钉住"为什么需要 .art-frame": 这条路上没有 .art-body 可以依靠
  const m = APP.match(/renderArtifactBodyInto\(\$\('spacePreviewBody'\)[^)]*\)/);
  assert.ok(m, '找不到数据空间调用 renderArtifactBodyInto 的地方');
  assert.match(m[0], /,\s*false\s*\)/, '第三个参数是 framed —— 必须还是 false, ' +
    '如果哪天改成 true 就会多一层 .art-body 包裹, 这个测试要跟着更新');
});

/* ============================================================
 * 3. 别把报告卡片那条路一起改了
 * ============================================================ */

test('聊天流里的报告卡片仍然是固定高度 (它是内联卡片, 不是整屏预览)', () => {
  // 那条路上的 iframe 是嵌在对话流里的, 下面还有消息 —— 固定 420px 是有意的,
  // 改成撑满会把整段对话顶下去
  assert.match(APP, /<iframe data-pane="html"[^>]*height:420px/,
    '报告卡片的固定高度被改掉了? 那条路不该跟数据空间共用撑满的规则');
});
