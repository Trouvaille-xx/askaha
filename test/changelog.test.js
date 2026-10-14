'use strict';

/**
 * 「设置 · 关于」页与更新日志。
 *
 * 这一页的性质是"出厂数据 + 一份静态页面", 没有需要替身的运行时依赖, 所以这里
 * 验的是**契约**, 而不是行为:
 *
 *   1. lib/changelog.js 里每条日志的结构都对 (格式错了页面上会画成一片空白,
 *      而这一页恰恰是"出问题时唯一还能看的页", 它不能白);
 *   2. package.json 的版本号和日志最新一条一致 —— 「关于」页显示的"当前版本"读的
 *      是 package.json, 日志列表读的是 changelog.js。这两处对不上时页面会亮一条
 *      提醒, 但提醒是给用户的兜底, 不该靠它过日子;
 *   3. index.html 里真的有 app.js 要用的那些 id。拼错一个 id 不会报错, 只会让
 *      那一块永远空着 —— 这类错只有打开页面才看得见, 所以在这里钉住。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const Changelog = require('../lib/changelog.js');

const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'src', 'js', 'app.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const { ABOUT, ENTRIES, CHANGELOG_TAGS, tagStyle, sortedEntries } = Changelog;

test('关于: 产品介绍该有的字段都在, 且不是空话', () => {
  assert.ok(ABOUT.name, '要有产品名');
  assert.ok(ABOUT.slogan, '要有 slogan');
  assert.ok(ABOUT.summary && ABOUT.summary.length > 10, '简介不能是空的');
  assert.ok(Array.isArray(ABOUT.highlights) && ABOUT.highlights.length >= 3,
    '至少三条能力点, 少了这一页就只剩一个版本号');
  for (const h of ABOUT.highlights) assert.ok(h && h.trim(), '能力点不能有空行');
});

test('关于: Slogan 只有一处出处 (changelog.js), 对话空态从它取值', () => {
  assert.strictEqual(ABOUT.slogan, '假如数据会说话······');
  // 空态抬头过去是写死的字符串, 现在改成读 ABOUT.slogan —— 两处各存一份迟早会漂
  assert.match(appJs, /CHANGELOG\.ABOUT\.slogan/, '对话空态应该从 About 数据里取 slogan');
  assert.ok(!appJs.includes('数据不言，自成结论'), '旧 slogan 不该还留在代码里');
});

test('更新日志: 每条日志的格式都对', () => {
  assert.ok(ENTRIES.length >= 1, '至少要有一条');
  for (const e of ENTRIES) {
    assert.match(e.version, /^\d+\.\d+\.\d+$/, `版本号格式不对: ${e.version}`);
    // 第一行是更新时间 (年月日时分)
    assert.match(e.time, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, `更新时间格式不对: ${e.time}`);
    assert.ok(Array.isArray(e.changes) && e.changes.length, `${e.version} 没有任何变更条目`);
    for (const c of e.changes) {
      // 每行最前面是标签 —— 认不出的标签会退化成灰块, 所以这里必须是词典里的键
      assert.ok(CHANGELOG_TAGS[c.tag], `${e.version} 用了词典外的标签: ${c.tag}`);
      assert.ok(c.text && c.text.trim(), `${e.version} 有一条空的变更描述`);
    }
  }
});

test('更新日志: 版本号不重复, 时间不重复', () => {
  const versions = ENTRIES.map((e) => e.version);
  const times = ENTRIES.map((e) => e.time);
  assert.strictEqual(new Set(versions).size, versions.length, '同一个版本号出现了两次');
  assert.strictEqual(new Set(times).size, times.length,
    '同一个时间戳出现了两次 —— 更新日志页的左菜单是按时间排的, 重了就分不清点的是哪条');
});

test('更新日志: sortedEntries 按时间倒序, 且不动原数组', () => {
  const sorted = sortedEntries();
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(sorted[i - 1].time >= sorted[i].time, '左菜单要最新的在最上面');
  }
  assert.notStrictEqual(sorted, ENTRIES, '要返回副本, 页面拿到的顺序不该改到数据本身');
});

test('更新日志: 最新一条的版本号与 package.json 一致', () => {
  const latest = sortedEntries()[0];
  assert.strictEqual(latest.version, pkg.version,
    '「关于」页的当前版本读 package.json, 日志读 changelog.js —— 对不上时页面会亮红条, '
    + '但那是给用户的兜底: 发版时要顺手把 lib/changelog.js 补上');
});

test('更新日志: 认不出的标签退化成兜底灰块, 不是空白', () => {
  const st = tagStyle('不存在的标签');
  assert.ok(st && st.label && st.fg && st.bg, '兜底色块必须有文字和配色');
  assert.strictEqual(tagStyle('feat').label, '新特性');
});

test('更新日志: 标签配色各不相同 (不然一列标签看着像同一个)', () => {
  const colors = Object.values(CHANGELOG_TAGS).map((t) => t.fg);
  assert.strictEqual(new Set(colors).size, colors.length, '有两个标签用了同一个前景色');
});

test('页面: 关于页要用的元素都在 index.html 里', () => {
  for (const id of [
    'aboutVersion', 'aboutSlogan', 'aboutSummary', 'aboutHighlights', 'aboutMeta',
    'updateFeed', 'updateStatus', 'aboutChangelog',
    'btnCheckUpdate', 'btnAllChangelog', 'btnAllChangelog2',
    'changelogMenu', 'changelogDetail', 'btnChangelogBack'
  ]) {
    assert.ok(html.includes(`id="${id}"`), `index.html 里没有 id="${id}"`);
  }
});

test('页面: 设置页签里有「关于」, 并且有独立的更新日志视图', () => {
  assert.match(html, /data-pane="about"[^>]*>关于</, '设置二级条上要有「关于」页签');
  assert.match(html, /data-pane="about"/, '要有关于面板');
  assert.match(html, /data-view="changelog"/, '要有一个独立的更新日志视图');
  assert.match(html, /lib\/changelog\.js/, 'index.html 要引入 changelog.js 数据模块');
});

test('页面: 更新日志页在左侧一级菜单上仍停在「设置」', () => {
  // 否则点进更新日志后, 左侧一个菜单项都不高亮, 用户会以为"迷路了"
  assert.match(appJs, /if \(view === 'changelog'\) navKey = 'settings'/);
  assert.match(appJs, /if \(view === 'changelog'\) renderChangelogPage\(\)/);
});

test('页面: 更新源只在主进程发请求, 页面不自己 fetch', () => {
  // 内网更新源一般没有 CORS 头, 从渲染层 fetch 会被浏览器直接拦掉
  assert.ok(!/fetch\(/.test(appJs), 'app.js 里不该出现 fetch —— 检查更新走 api.update.check');
  assert.match(appJs, /api\.update\.check\(/);
});
