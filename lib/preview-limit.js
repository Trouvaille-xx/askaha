'use strict';

/**
 * 预览上限 —— 「数据过大就不预览, 改成下载」的那条线。
 *
 * 为什么要单独一个模块: 判定逻辑要能单测。它散在 store.js (读文件) 和
 * 渲染层 (解析) 两边的话, 两边对"多大算大"的理解迟早会漂移 ——
 * 一边放行一边卡住, 用户看到的是"有的能预览有的不能", 没有规律。
 *
 * ============ 为什么按文件类型分档, 而不是一刀切 ============
 *
 * 一开始想用统一的 1 MB。量了一下发现 HTML 报告**贴着线走**:
 *
 *   echarts.common.min.js (内联进报告的那个)   698 KB
 *   实测两份真实报告                       711 / 713 KB
 *   其中数据部分只有                          13 KB  (98% 是图表库)
 *
 * 也就是说报告体积基本等于图表库体积, 距 1 MB 只剩 313 KB 余量 ——
 * 数据涨 20 倍就会越线。而且 lib/report.js 的 echartsSource() 在
 * echarts.common.min.js 缺失时会**回退到 echarts.min.js (1096 KB)**,
 * 那一条路径下报告必然超过 1 MB, 预览会被整个挡掉。
 *
 * 用数据量的尺子去量文档体积, 量错了对象: 报告大不代表数据多, 只代表
 * 它自带了一个图表库。所以 HTML 单独放宽。
 *
 * 所以:
 *   - csv/json/md/txt/sql/log  -> 1 MB。这些是**逐字符解析或整段塞进 DOM** 的,
 *                                 体积直接等于代价。
 *   - html/htm                 -> 8 MB。整份丢给 iframe, 浏览器自己会流式处理;
 *                                 8 MB 只是防住"有人生成一份几百 MB 的报告"。
 */

const KB = 1024;
const MB = 1024 * KB;

/** 预览阈值 (字节), 按扩展名。没有列到的走 DEFAULT。 */
const PREVIEW_LIMITS = {
  csv: 1 * MB,
  json: 1 * MB,
  md: 1 * MB,
  txt: 1 * MB,
  sql: 1 * MB,
  log: 1 * MB,
  html: 8 * MB,
  htm: 8 * MB
};

const DEFAULT_PREVIEW_LIMIT = 1 * MB;

/**
 * 一次查询最多导出多少行到 CSV。
 *
 * **这不是"截断", 是防呆网。** 它的存在是为了挡住
 * `SELECT * FROM 一亿行的表` 写出一个几百 MB 的文件, 而不是为了限制正常使用。
 * 所以它比预览阈值高得多 (1 万行 vs 50 万行) —— 预览是常规路径, 天天走;
 * 这个只在极端情况下兜底。
 *
 * 如果把它设成和预览阈值一样, "下载查看"就失去意义了:
 * 用户点下载就是为了看全部数据, 结果拿到一份同样被截过的文件。
 */
const CSV_EXPORT_MAX_ROWS = 500000;

/** 从文件名取扩展名 (小写, 不含点)。没有扩展名返回空串。 */
function extOf(name) {
  const m = String(name || '').match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : '';
}

/** 这类文件预览时的体积上限 */
function previewLimitFor(name) {
  return PREVIEW_LIMITS[extOf(name)] || DEFAULT_PREVIEW_LIMIT;
}

/**
 * 这个文件是不是大到不该预览了。
 *
 * size 为 undefined / 非数字时一律放行 —— 宁可能预览, 也不要因为
 * 拿不到文件大小就让用户彻底看不到内容。
 */
function tooLargeToPreview(name, size) {
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0) return false;
  return n > previewLimitFor(name);
}

/** 人类可读的体积, 给提示文案用 */
function fmtSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < KB) return n + ' B';
  if (n < MB) return Math.round(n / KB) + ' KB';
  return (Math.round((n / MB) * 10) / 10) + ' MB';
}

module.exports = {
  PREVIEW_LIMITS,
  DEFAULT_PREVIEW_LIMIT,
  CSV_EXPORT_MAX_ROWS,
  extOf,
  previewLimitFor,
  tooLargeToPreview,
  fmtSize
};
