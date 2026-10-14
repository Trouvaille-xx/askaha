'use strict';

/**
 * 产物预览上限 —— 「数据过大就不预览, 改成下载」。
 *
 * 起因: 用户要求「如果查询出来的数据过大, 不再允许预览, 而是支持下载查看」。
 *
 * 查下去发现代价链是这样的:
 *   store.readArtifact  无条件 readFileSync 读满整个文件 (主进程同步阻塞)
 *     -> IPC 结构化克隆再拷一份大字符串
 *     -> 渲染层 parseCSV 逐字符 field += ch 走完整个字符串
 *     -> 最后只显示 300 行
 * 也就是"为了看 300 行, 付了整份数据的代价"。而且 lib/database.js 的
 * query() 连行数上限都没有, 一条 SELECT * 就能把整表拉进内存。
 *
 * 这个文件锁住修复后的行为。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const P = require('../lib/preview-limit');
const Report = require('../lib/report');
const Store = require('../lib/store');

const MB = 1024 * 1024;
const KB = 1024;

/* ============================================================
 * 阈值分档
 * ============================================================ */

test('阈值: 逐字符解析的文本按 1 MB 卡', () => {
  for (const n of ['a.csv', 'a.json', 'a.md', 'a.txt', 'a.sql', 'a.log']) {
    assert.strictEqual(P.previewLimitFor(n), 1 * MB, n + ' 应该是 1 MB');
  }
});

test('阈值: HTML 报告放宽到 8 MB —— 它 98% 的体积是内联的图表库, 不是数据', () => {
  // 这一条是**防回归**。实测:
  //   echarts.common.min.js (内联进报告的那个)  698 KB
  //   两份真实报告                            711 / 713 KB  (数据只占 13 KB)
  // 距 1 MB 只剩 313 KB 余量; 而且 echartsSource() 在 common 版缺失时会
  // 回退到 echarts.min.js (1096 KB), 那条路径下报告必然越线。
  // 所以 HTML 不能和 CSV 共用 1 MB。
  const fallbackLib = 1096 * KB;
  assert.ok(P.previewLimitFor('report.html') > fallbackLib,
    'HTML 上限必须大于完整版 echarts (' + fallbackLib + '), 否则回退路径下带图报告无法预览');
  assert.strictEqual(P.previewLimitFor('report.htm'), P.previewLimitFor('report.html'));
  assert.strictEqual(P.previewLimitFor('report.html'), 8 * MB);
});

test('阈值: 大小写不敏感, 没有扩展名走默认', () => {
  assert.strictEqual(P.previewLimitFor('A.CSV'), P.previewLimitFor('a.csv'));
  assert.strictEqual(P.previewLimitFor('Report.HTML'), P.previewLimitFor('r.html'));
  assert.strictEqual(P.previewLimitFor('noext'), P.DEFAULT_PREVIEW_LIMIT);
  assert.strictEqual(P.previewLimitFor(''), P.DEFAULT_PREVIEW_LIMIT);
  assert.strictEqual(P.previewLimitFor(null), P.DEFAULT_PREVIEW_LIMIT);
});

test('判定: 刚好等于上限算能预览, 超过一点点就算大', () => {
  assert.strictEqual(P.tooLargeToPreview('a.csv', 1 * MB), false, '等于上限应该放行');
  assert.strictEqual(P.tooLargeToPreview('a.csv', 1 * MB + 1), true, '超一个字节就该拦');
  assert.strictEqual(P.tooLargeToPreview('a.csv', 1 * MB - 1), false);
});

test('判定: 拿不到大小时一律放行 (宁可能预览, 也不要因为一次 stat 失败就彻底看不了)', () => {
  for (const bad of [undefined, null, NaN, -1, 'abc', 0]) {
    assert.strictEqual(P.tooLargeToPreview('a.csv', bad), false, 'size=' + bad + ' 不该判成过大');
  }
});

test('判定: 2 MB 的带图报告仍然能预览 (真实场景)', () => {
  // 报告内联 echarts 之后 1~2 MB 是常态, 不该被拦
  assert.strictEqual(P.tooLargeToPreview('report.html', 2 * MB), false);
  assert.strictEqual(P.tooLargeToPreview('report.html', 9 * MB), true);
});

test('fmtSize: 三种量级都能读', () => {
  assert.strictEqual(P.fmtSize(512), '512 B');
  assert.strictEqual(P.fmtSize(2 * KB), '2 KB');
  assert.strictEqual(P.fmtSize(1.5 * MB), '1.5 MB');
});

/* ============================================================
 * 归档层: buildCSV 要如实报出导出了多少行
 * ============================================================ */

test('buildCSV: 返回行数信息, 不再只给一个字符串', () => {
  const r = Report.buildCSV({ columns: ['a', 'b'], rows: [{ a: 1, b: 2 }, { a: 3, b: 4 }], rowCount: 2 });
  assert.strictEqual(r.rows, 2);
  assert.strictEqual(r.totalRows, 2);
  assert.strictEqual(r.truncated, false);
  assert.ok(r.csv.includes('a,b'), '内容照旧');
  assert.ok(r.csv.startsWith('\ufeff'), 'BOM 要留着, 否则 Excel 打开中文乱码');
});

test('buildCSV: 超上限时截断并如实标记', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ a: i }));
  const r = Report.buildCSV({ columns: ['a'], rows, rowCount: 10 }, { maxRows: 3 });
  assert.strictEqual(r.rows, 3, '只写 3 行');
  assert.strictEqual(r.totalRows, 10, '但要报出总共 10 行');
  assert.strictEqual(r.truncated, true, '必须标记截断了');
  const body = r.csv.split('\r\n').slice(1);
  assert.strictEqual(body.length, 3, '文件里确实只有 3 行数据');
});

test('buildCSV: 默认上限是防呆网, 远高于预览阈值 —— 否则"下载查看"就没意义了', () => {
  // 用户点下载就是为了看全部数据。如果导出上限等于预览阈值,
  // 下载拿到的还是被截过的, 等于白下载。
  assert.ok(P.CSV_EXPORT_MAX_ROWS >= 100000,
    '导出上限不能和预览阈值一个量级, 否则下载失去意义');
});

test('buildCSV: 没有列就没有 CSV, 不报错', () => {
  for (const bad of [null, undefined, {}, { columns: [] }, { columns: [], rows: [] }]) {
    const r = Report.buildCSV(bad);
    assert.strictEqual(r.csv, '', JSON.stringify(bad) + ' 应该得到空 CSV');
    assert.strictEqual(r.rows, 0);
    assert.strictEqual(r.totalRows, 0);
    assert.strictEqual(r.truncated, false);
  }
});

test('buildCSV: 有列但没有行 -> 只出表头 (合法 CSV, 且是改动前就有的行为)', () => {
  // "取数没命中任何行"是正常结果, 不该被当成错误, 也不该丢掉列信息 ——
  // 用户需要看到"这条 SQL 跑通了, 但没查到数据"。
  const r = Report.buildCSV({ columns: ['a', 'b'], rows: [], rowCount: 0 });
  assert.strictEqual(r.rows, 0, '没有数据行');
  assert.strictEqual(r.totalRows, 0);
  assert.strictEqual(r.truncated, false);
  assert.ok(r.csv.includes('a,b'), '表头要留着, 实际: ' + JSON.stringify(r.csv));
  assert.strictEqual(r.csv.split('\r\n').length, 1, '除表头外不该有多余的行');
});

test('buildCSV: 含逗号/引号/换行的单元格照旧正确转义', () => {
  const r = Report.buildCSV({ columns: ['a', 'b'], rows: [{ a: 'x,y', b: 'he said "hi"' }] });
  assert.ok(r.csv.includes('"x,y"'), '逗号要包引号');
  assert.ok(r.csv.includes('"he said ""hi"""'), '引号要双写');
});

/* ============================================================
 * 预览层: 大文件必须**不被读**
 *
 * 只断言"返回了 tooLarge"是不够的 —— 完全可能读完了再告诉你太大。
 * 所以这里把 fs.readFileSync 换成会抛错的桩: 只要它被调到, 测试就炸。
 * ============================================================ */

function makeStoreWithArtifact(content, name, ext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solodb-preview-'));
  const store = new Store({ rootDir: root });
  const conv = store.createConversation({ id: 'c_1_aaaa', title: '测试' });
  const saved = store.saveArtifact(conv.id, {
    kind: 'data',
    name,
    sub: 'data',
    ext,
    content,
    meta: { title: name }
  });
  assert.ok(saved.ok, '产物要能存进去: ' + JSON.stringify(saved));
  return { root, store, convId: conv.id, artifactId: saved.artifact.id };
}

/**
 * 在"读产物文件"这件事上装一个会抛错的桩, 用来证明**大文件真的没被读**。
 *
 * 只拦产物那个路径: readArtifact 内部还要 getConversation, 那会读对话的
 * json (一个小文件, 合法且必要)。一刀切拦掉所有 readFileSync 会误伤。
 */
function withArtifactReadForbidden(artifactPath, fn) {
  const orig = fs.readFileSync;
  const hits = [];
  fs.readFileSync = function (p, ...rest) {
    if (String(p) === String(artifactPath)) {
      hits.push(String(p));
      throw new Error('不该读产物文件, 但读了: ' + p);
    }
    return orig.call(fs, p, ...rest);
  };
  try {
    return { out: fn(), hits };
  } finally {
    fs.readFileSync = orig;
  }
}

test('大 CSV: 完全不读文件, 直接返回 tooLarge', () => {
  // 造一个真的超过 1 MB 的 CSV
  const big = 'a,b\r\n' + Array.from({ length: 80000 }, (_, i) => i + ',x'.repeat(10)).join('\r\n');
  assert.ok(Buffer.byteLength(big) > 1 * MB, '测试数据要真的超过 1 MB, 实际 ' + Buffer.byteLength(big));
  const ctx = makeStoreWithArtifact(big, '01-大查询', 'csv');
  try {
    const abs = ctx.store.resolveArtifactPath(ctx.convId, ctx.artifactId).absolute;
    const { out, hits } = withArtifactReadForbidden(abs, () => ctx.store.readArtifact(ctx.convId, ctx.artifactId));
    assert.strictEqual(hits.length, 0, '产物文件被读了 —— 大文件不该被读');
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.tooLarge, true, '要标记为过大');
    assert.strictEqual(out.text, undefined, '不能把内容带回来');
    assert.ok(out.size > 1 * MB, '要如实报出体积, 实际 ' + out.size);
    assert.strictEqual(out.limit, 1 * MB, '要带上限, 界面要显示给用户看');
    assert.ok(out.absolute, '要带绝对路径, 下载按钮要用');
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});

test('小 CSV: 照旧读出来预览', () => {
  const small = 'a,b\r\n1,2\r\n3,4';
  const ctx = makeStoreWithArtifact(small, '01-小查询', 'csv');
  try {
    const out = ctx.store.readArtifact(ctx.convId, ctx.artifactId);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.tooLarge, undefined, '小文件不该被标记为过大');
    assert.strictEqual(out.text, small, '内容要原样返回');
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});

test('2 MB 的 HTML 报告: 仍然预览 (内联 echarts 导致体积大, 但那不是数据量大)', () => {
  // 用一段真实 HTML 撑到 2 MB
  const html = '<html><body>' + '<script>/*echarts*/</script>'.repeat(90000) + '</body></html>';
  assert.ok(Buffer.byteLength(html) > 2 * MB, '测试数据要超过 2 MB, 实际 ' + Buffer.byteLength(html));
  const ctx = makeStoreWithArtifact(html, 'report-报告', 'html');
  try {
    const out = ctx.store.readArtifact(ctx.convId, ctx.artifactId);
    assert.strictEqual(out.tooLarge, undefined, '2 MB 的报告不该被拦, 否则所有带图报告都看不了');
    assert.ok(out.text && out.text.length > 0, '内容要读出来');
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});

test('9 MB 的 HTML: 拦下来', () => {
  const html = '<html><body>' + 'x'.repeat(9 * MB) + '</body></html>';
  const ctx = makeStoreWithArtifact(html, 'report-巨报告', 'html');
  try {
    const abs = ctx.store.resolveArtifactPath(ctx.convId, ctx.artifactId).absolute;
    const { out, hits } = withArtifactReadForbidden(abs, () => ctx.store.readArtifact(ctx.convId, ctx.artifactId));
    assert.strictEqual(hits.length, 0, '超大文件不该被读');
    assert.strictEqual(out.tooLarge, true);
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});

test('产物不存在时照旧报错, 不被上限逻辑吞掉', () => {
  const ctx = makeStoreWithArtifact('a,b\r\n1,2', '01-x', 'csv');
  try {
    const out = ctx.store.readArtifact(ctx.convId, 'art_不存在');
    assert.strictEqual(out.ok, false);
    assert.match(out.error, /不存在/);
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});

test('文件被删掉时照旧报错', () => {
  const ctx = makeStoreWithArtifact('a,b\r\n1,2', '01-x', 'csv');
  try {
    const p = ctx.store.resolveArtifactPath(ctx.convId, ctx.artifactId);
    fs.rmSync(p.absolute);
    const out = ctx.store.readArtifact(ctx.convId, ctx.artifactId);
    assert.strictEqual(out.ok, false);
    assert.match(out.error, /移动或删除/);
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});
