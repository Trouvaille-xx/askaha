/**
 * 报告生成器
 *
 * 报告的定位是「讲结论」, 不是「倒数据」:
 *   - kpis     关键指标大数字 (可选)
 *   - insights 洞察结论, 每条一张卡片
 *   - charts   图表, 由 ECharts 渲染 (配置在 Node 侧生成, 浏览器只负责画)
 * 原始数据不往报告里塞, 它已经归档到数据空间, 需要细看时去那里翻。
 *
 * 图表数据来源: charts[i].source 指向第 N 个 SQL 步骤 (1-based),
 * 直接从那次查询的真实结果集里取字段, 模型只负责"选图 + 指定维度指标",
 * 不负责搬数据 —— 这样图上的数字一定和执行结果一致。
 *
 * 产出的 HTML 是单文件: ECharts 直接内嵌, 离线可看、可直接外发。
 */

const fs = require('fs');
const path = require('path');
const { CSV_EXPORT_MAX_ROWS } = require('./preview-limit');

// ---------- 基础工具 ----------

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return escapeHtml(JSON.stringify(v));
  return escapeHtml(String(v));
}

function fmtCellMd(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/**
 * 列名中文化。
 *
 * 模型写 SQL 时会声明 fields: [{name, meaning}], 其中 meaning 是中文含义;
 * agent 会把「结果列里确实存在的那些」挑出来挂在 result.labels 上。
 * 所以这里优先用 labels, 没有就查常用别名词典, 再没有就原样返回。
 *
 * 表头一律走这个函数, 保证「报告里的表 / Excel / CSV / 产物预览」口径一致。
 */
const COMMON_LABELS = {
  total_rows: '总行数', row_count: '行数', total_count: '总数', total: '总计',
  cnt: '数量', count: '数量', num: '数量', qty: '数量', quantity: '数量',
  amount: '金额', total_amount: '总金额', sum_amount: '金额合计', price: '单价',
  sum: '合计', avg: '平均', max: '最大值', min: '最小值', avg_value: '平均值',
  id: '编号', name: '名称', type: '类型', status: '状态',
  create_time: '创建时间', created_at: '创建时间', update_time: '更新时间',
  updated_at: '更新时间', date: '日期', day: '日期', month: '月份', year: '年份',
  supplier: '供应商', supplier_name: '供应商', vendor: '供应商', vendor_name: '供应商',
  customer: '客户', customer_name: '客户', product: '商品', product_name: '商品',
  order_no: '订单号', order_id: '订单编号', order_count: '订单数',
  pct: '占比', percent: '占比', ratio: '占比', rate: '比率', growth: '增长率'
};

/** 取某列的中文显示名; 拿不到就回退原名 */
function columnLabel(result, col) {
  const labels = (result && result.labels) || {};
  const hit = labels[col];
  if (hit && String(hit).trim()) return String(hit).trim();
  const key = String(col || '').trim().toLowerCase();
  if (COMMON_LABELS[key]) return COMMON_LABELS[key];
  return String(col == null ? '' : col);
}

/** 一组列的显示名 */
function columnLabels(result, columns) {
  return (columns || []).map((c) => columnLabel(result, c));
}

/** 尽量把值转成数字, 转不了就原样返回 (交给 ECharts 处理) */
function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/[,\s￥$]/g, ''));
  return Number.isFinite(n) ? n : v;
}

// Excel 的 sheet 名限制: 不能包含 : \ / ? * [ ], 长度上限 31, 且同一工作簿内不可重名。
const SHEET_NAME_INVALID = /[:\\/?*[\]]/g;
const SHEET_NAME_MAX = 28;

function makeSheetNamer() {
  const used = new Set();
  return function nameSheet(raw, fallback) {
    let base = String(raw == null ? '' : raw)
      .replace(SHEET_NAME_INVALID, '_')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^'+|'+$/g, '');
    if (!base) base = fallback || 'Sheet';
    base = base.slice(0, SHEET_NAME_MAX);
    let candidate = base;
    let seq = 2;
    while (used.has(candidate.toLowerCase())) {
      const suffix = '_' + seq;
      seq += 1;
      candidate = base.slice(0, SHEET_NAME_MAX - suffix.length) + suffix;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  };
}

// ---------- ECharts 内嵌 ----------

let _echartsCache = null;

/** 读取本地 ECharts 构建产物, 用于内嵌进报告 */
function echartsSource() {
  if (_echartsCache !== null) return _echartsCache;
  const candidates = [
    path.join(__dirname, '..', 'node_modules', 'echarts', 'dist', 'echarts.common.min.js'),
    path.join(__dirname, '..', 'node_modules', 'echarts', 'dist', 'echarts.min.js')
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        _echartsCache = fs.readFileSync(p, 'utf-8');
        return _echartsCache;
      }
    } catch (e) {
      /* 换下一个候选 */
    }
  }
  _echartsCache = '';
  return _echartsCache;
}

/**
 * 把一段 JS 安全地放进 <script> 标签。
 * 源码里若出现 </script 或 <!-- 会被 HTML 解析器当标签处理, 需要转义成 <\/script / <\!--
 * (在 JS 里 \/ 等价于 /, \! 等价于 !, 不改变语义)
 *
 * 必须大小写不敏感: HTML 的标签名匹配是 ASCII 大小写不敏感的, `</SCRIPT>` 一样能
 * 提前闭合脚本块。只挡小写等于没挡。
 */
function safeScript(js) {
  return String(js)
    .replace(/<\/script/gi, '<\\/script')
    .replace(/<!--/g, '<\\!--');
}

/**
 * 把一段**不可信数据** (图表 option, 里面直接装着数据库单元格的值) 嵌进 <script>。
 *
 * 对数据不能用 safeScript: 那是给 JS 源码用的, 对 JSON 里的字符串做 <\/script 替换
 * 只是碰巧能解析, 挡不干净。这里直接把 < 转成 \u003c —— JSON 字符串里完全等价,
 * 但 HTML 解析器再也看不到任何标签起头, </SCRIPT 之类一律失效。
 * 顺手把 U+2028 / U+2029 也转掉 (它们合法存在于 JSON, 但会截断 JS 字符串字面量)。
 */
function safeJsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// ---------- 图表配置 ----------

const PALETTE = [
  '#4f46e5', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444',
  '#8b5cf6', '#14b8a6', '#f97316', '#64748b', '#ec4899'
];

const CHART_TYPES = new Set(['line', 'bar', 'area', 'pie', 'doughnut', 'scatter']);

/**
 * 把「模型给的图表意图 + 真实结果集」编译成 ECharts option。
 * 字段不存在、类型不支持、数据为空 → 返回 error, 由上层决定丢弃还是降级。
 */
function buildChartOption(spec, steps) {
  const type = String(spec.type || 'bar').toLowerCase();
  if (!CHART_TYPES.has(type)) {
    return { ok: false, error: `不支持的图表类型: ${spec.type}` };
  }
  const src = Number(spec.source);
  if (!Number.isInteger(src) || src < 1) {
    return { ok: false, error: 'source 必须是 SQL 步骤序号 (从 1 开始)' };
  }
  const step = steps.filter((s) => s.kind === 'sql' && s.result && !s.result.error)[src - 1];
  if (!step) return { ok: false, error: `找不到第 ${src} 个 SQL 结果` };

  const r = step.result;
  const columns = r.columns || [];
  const rows = r.rows || [];
  if (!columns.length || !rows.length) return { ok: false, error: `第 ${src} 个 SQL 没有数据` };

  const xField = spec.x || spec.nameField;
  if (!xField || !columns.includes(xField)) {
    return { ok: false, error: `维度字段 ${xField || '(未指定)'} 不在结果列里 (可用: ${columns.join(', ')})` };
  }

  const seriesSpec = Array.isArray(spec.series) ? spec.series.filter((s) => s && (s.field || s.name)) : [];
  if (!seriesSpec.length) return { ok: false, error: 'series 为空, 至少要指定一个指标字段' };

  const missing = seriesSpec.map((s) => s.field).filter((f) => f && !columns.includes(f));
  if (missing.length) {
    return { ok: false, error: `指标字段 ${missing.join(', ')} 不在结果列里 (可用: ${columns.join(', ')})` };
  }

  const cap = 300;
  const used = rows.slice(0, cap);
  const truncated = rows.length > cap ? `仅取前 ${cap} 条` : '';
  const base = {
    color: PALETTE,
    animationDuration: 420,
    textStyle: { fontFamily: '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif' }
  };
  // 图例/坐标轴也走中文列名, 让图本身就能读懂
  const legendNames = seriesSpec.map((s, i) => s.name || (s.field ? columnLabel(r, s.field) : '') || `指标${i + 1}`);

  let option;
  if (type === 'pie' || type === 'doughnut') {
    const valueField = seriesSpec[0].field;
    option = {
      ...base,
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { bottom: 0, type: 'scroll', icon: 'circle' },
      series: [{
        name: spec.title || '占比',
        type: 'pie',
        radius: type === 'doughnut' ? ['42%', '68%'] : '62%',
        center: ['50%', '46%'],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: '#fff', borderWidth: 2, borderRadius: 4 },
        label: { formatter: '{b}\n{d}%', fontSize: 11 },
        data: used.map((row) => ({ name: String(row[xField] ?? ''), value: toNum(row[valueField]) }))
      }]
    };
  } else if (type === 'scatter') {
    const yField = seriesSpec[0].field;
    option = {
      ...base,
      tooltip: {
        trigger: 'item',
        formatter: (p) => `${escapeHtml(xField)}: ${p.value[0]}<br/>${escapeHtml(legendNames[0])}: ${p.value[1]}`
      },
      grid: { left: 56, right: 24, top: 28, bottom: 44, containLabel: false },
      xAxis: { type: 'value', name: columnLabel(r, xField), nameLocation: 'middle', nameGap: 26, splitLine: { lineStyle: { color: '#eef0f4' } } },
      yAxis: { type: 'value', name: legendNames[0], splitLine: { lineStyle: { color: '#eef0f4' } } },
      series: [{
        name: legendNames[0],
        type: 'scatter',
        symbolSize: 9,
        data: used.map((row) => [toNum(row[xField]), toNum(row[yField])])
      }]
    };
  } else {
    const echartsType = type === 'area' ? 'line' : type;
    option = {
      ...base,
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: legendNames.length > 1 ? { bottom: 0, type: 'scroll', icon: 'circle' } : undefined,
      grid: { left: 12, right: 20, top: 24, bottom: legendNames.length > 1 ? 44 : 20, containLabel: true },
      xAxis: {
        type: 'category',
        data: used.map((row) => String(row[xField] ?? '')),
        axisLabel: { fontSize: 11, hideOverlap: true, color: '#6b7280' },
        axisLine: { lineStyle: { color: '#dfe3e8' } },
        axisTick: { show: false }
      },
      yAxis: {
        type: 'value',
        axisLabel: { fontSize: 11, color: '#6b7280' },
        splitLine: { lineStyle: { color: '#eef0f4' } }
      },
      series: seriesSpec.map((s, i) => ({
        name: legendNames[i],
        type: echartsType,
        smooth: echartsType === 'line',
        symbol: 'circle',
        symbolSize: 6,
        // 用户要求"不同类别不同颜色"时, 让每个柱子各取一色
        colorBy: spec.colorBy === 'dimension' && echartsType === 'bar' ? 'data' : undefined,
        stack: spec.stack && echartsType === 'bar' ? 'total' : undefined,
        areaStyle: type === 'area' ? { opacity: 0.16 } : undefined,
        barMaxWidth: 34,
        itemStyle: echartsType === 'bar' ? { borderRadius: [6, 6, 0, 0] } : undefined,
        emphasis: { focus: 'series' },
        data: used.map((row) => toNum(row[s.field]))
      }))
    };
  }

  return {
    ok: true,
    option,
    pointCount: used.length,
    note: truncated,
    sourceTitle: step.title || `SQL #${src}`
  };
}

// ---------- Report ----------

class Report {
  /**
   * @param {object} payload
   *   - title, task, summary
   *   - insights: [string]
   *   - kpis: [{ label, value, hint }]
   *   - charts: [{ title, type, source, x, series, note, stack }]
   *   - steps: [{ kind, title, content, sql, result }]
   *   - databaseName, generatedAt
   */
  static build(payload) {
    const compiled = Report.compileCharts(payload);
    const html = Report.buildHTML({ ...payload, compiled });
    const md = Report.buildMD({ ...payload, compiled });
    let xlsxBase64 = null;
    let xlsxError = null;
    try {
      const buf = Report.buildXLSX(payload);
      xlsxBase64 = buf.toString('base64');
    } catch (e) {
      // 不静默吞掉: 交给上层提示用户, 避免"选了 Excel 却什么都没发生"
      xlsxError = e.message;
    }
    return { html, md, xlsxBase64, xlsxError, chartWarnings: compiled.warnings };
  }

  /**
   * 编译图表: 能画的进 charts, 画不了的记 warning。
   * 一张图都没画成时, 回退到"附数据表", 免得报告空得没法看。
   */
  static compileCharts({ charts = [], steps = [], title }) {
    const out = [];
    const warnings = [];
    for (const spec of Array.isArray(charts) ? charts : []) {
      if (!spec || typeof spec !== 'object') continue;
      const res = buildChartOption(spec, steps);
      if (!res.ok) {
        warnings.push(`图表「${spec.title || '未命名'}」未生成: ${res.error}`);
        continue;
      }
      out.push({
        title: spec.title || res.sourceTitle || '图表',
        note: [spec.note, res.note].filter(Boolean).join('  '),
        option: res.option,
        pointCount: res.pointCount
      });
    }
    return {
      charts: out,
      warnings,
      // 没画出图时把数据表附上, 保证报告不至于只有几行字
      fallbackTables: out.length === 0
    };
  }

  static buildHTML({ title, task, summary, insights = [], kpis = [], steps = [], databaseName, generatedAt, compiled = {} }) {
    const ts = generatedAt || new Date().toISOString();
    const chartList = compiled.charts || [];
    const warnings = compiled.warnings || [];
    const showTables = compiled.fallbackTables;

    const kpiHtml = (Array.isArray(kpis) ? kpis : [])
      .filter((k) => k && (k.label || k.value !== undefined))
      .map((k) => `
        <div class="kpi">
          <div class="kpi-label">${escapeHtml(k.label || '')}</div>
          <div class="kpi-value">${escapeHtml(k.value == null ? '' : String(k.value))}${k.unit ? `<span class="kpi-unit">${escapeHtml(k.unit)}</span>` : ''}</div>
          ${k.hint ? `<div class="kpi-hint">${escapeHtml(k.hint)}</div>` : ''}
        </div>`)
      .join('');

    const insightItems = (Array.isArray(insights) ? insights : [])
      .filter((s) => String(s || '').trim())
      .map((s, i) => `<li class="insight"><span class="insight-no">${i + 1}</span><div class="insight-text">${mdToHtml(String(s))}</div></li>`)
      .join('');

    // 模型没给 insights 时, 退回用 summary 当正文, 别让报告缺了结论区
    const summaryHtml = String(summary || '').trim();
    const conclusionBlock = insightItems
      ? `<ul class="insights">${insightItems}</ul>`
      : (summaryHtml ? `<div class="summary-body">${mdToHtml(summaryHtml)}</div>` : '<div class="meta">本次分析没有产出结论。</div>');

    const chartCards = chartList.map((c, i) => `
      <section class="chart-card">
        <div class="chart-head">
          <h3>${escapeHtml(c.title)}</h3>
          ${c.note ? `<div class="chart-note">${mdToHtml(c.note)}</div>` : ''}
        </div>
        <div class="chart" id="chart-${i}"></div>
      </section>`).join('');

    const warnHtml = warnings.length
      ? `<div class="warn"><b>部分图表未能生成</b><ul>${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul></div>`
      : '';

    const tableBlocks = showTables ? buildTableBlocks(steps) : '';

    const needEcharts = chartList.length > 0;
    const echartsJs = needEcharts ? echartsSource() : '';
    const chartsPayload = safeJsonForScript(chartList.map((c) => c.option));

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title || 'Askaha 报告')}</title>
<style>
  :root { color-scheme: light; --ink:#1f2328; --muted:#6b7280; --line:#eceef2; --primary:#4f46e5; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
         margin: 0; padding: 36px 40px 56px; color: var(--ink); background: #f6f7f9; line-height: 1.65;
         -webkit-font-smoothing: antialiased; }
  .container { max-width: 1000px; margin: 0 auto; background: #fff; border-radius: 18px;
               padding: 40px 44px 48px; box-shadow: 0 1px 2px rgba(15,23,42,.04), 0 8px 28px rgba(15,23,42,.05); }
  header { border-bottom: 1px solid var(--line); padding-bottom: 20px; margin-bottom: 28px; }
  h1 { margin: 0 0 10px; font-size: 27px; letter-spacing: -.01em; }
  .task { color: #374151; background: #f8f9fb; border-left: 3px solid var(--primary);
          border-radius: 0 10px 10px 0; padding: 11px 16px; margin-bottom: 12px; font-size: 14px; }
  .meta-line { color: var(--muted); font-size: 12.5px; }
  h2 { font-size: 15px; margin: 34px 0 14px; color: #111827;
       display: flex; align-items: center; gap: 9px; }
  h2::before { content:''; width: 3px; height: 15px; background: var(--primary); border-radius: 2px; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 8px; }
  .kpi { border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; background: #fcfcfd; }
  .kpi-label { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
  .kpi-value { font-size: 24px; font-weight: 650; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
  .kpi-unit { font-size: 13px; font-weight: 400; color: var(--muted); margin-left: 3px; }
  .kpi-hint { font-size: 12px; color: var(--muted); margin-top: 4px; }
  ul.insights { list-style: none; padding: 0; margin: 0; }
  li.insight { display: flex; gap: 12px; padding: 12px 16px; border: 1px solid var(--line);
               border-radius: 12px; margin-bottom: 10px; background: #fcfcfd; }
  .insight-no { flex: 0 0 22px; height: 22px; border-radius: 7px; background: #eef2ff; color: #4338ca;
                font-size: 12px; font-weight: 600; display: flex; align-items: center; justify-content: center; }
  .insight-text { flex: 1; min-width: 0; }
  .insight-text p { margin: 0; }
  .summary-body p { margin: 6px 0; }
  .chart-card { border: 1px solid var(--line); border-radius: 14px; padding: 18px 20px 12px; margin-bottom: 16px; background: #fff; }
  .chart-head { margin-bottom: 6px; }
  .chart-head h3 { margin: 0; font-size: 15px; font-weight: 600; }
  .chart-note { color: var(--muted); font-size: 12.5px; margin-top: 4px; }
  .chart { width: 100%; height: 340px; }
  .warn { background: #fffbeb; border: 1px solid #fde68a; color: #92400e; border-radius: 10px;
          padding: 12px 16px; font-size: 13px; margin-bottom: 18px; }
  .warn ul { margin: 6px 0 0; padding-left: 20px; }
  pre.sql { background: #0f172a; color: #e2e8f0; padding: 14px 18px; border-radius: 10px; overflow-x: auto;
            font-size: 12.5px; line-height: 1.5; margin: 10px 0; }
  .meta { color: var(--muted); font-size: 12px; margin: 6px 0; }
  .table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 10px; margin-top: 6px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #f0f1f3; white-space: nowrap; }
  th { background: #f8f9fb; font-weight: 600; color: #374151; position: sticky; top: 0; }
  tr:last-child td { border-bottom: none; }
  .step-block { margin-bottom: 22px; }
  .step-block h4 { font-size: 13.5px; margin: 0 0 4px; font-weight: 600; }
  code { background: #f3f4f6; padding: 1px 6px; border-radius: 4px; font-size: .92em; }
  footer { margin-top: 36px; padding-top: 16px; border-top: 1px solid var(--line);
           color: #9ca3af; font-size: 12px; display: flex; justify-content: space-between; }
  @media print { body { background: #fff; padding: 0; } .container { box-shadow: none; border-radius: 0; } }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>${escapeHtml(title || 'Askaha 报告')}</h1>
    <div class="task">${escapeHtml(task || '')}</div>
    <div class="meta-line">生成时间 ${escapeHtml(formatTime(ts))}${databaseName ? ' · 数据源 ' + escapeHtml(databaseName) : ''}</div>
  </header>

  ${kpiHtml ? `<h2>关键指标</h2><div class="kpis">${kpiHtml}</div>` : ''}

  <h2>分析结论</h2>
  ${conclusionBlock}

  ${chartCards ? `<h2>图表</h2>${warnHtml}${chartCards}` : warnHtml}

  ${tableBlocks ? `<h2>附录: 查询数据</h2>${tableBlocks}` : ''}

  <footer>
    <span>由 Askaha 智能体生成</span>
    <span>${escapeHtml(ts)}</span>
  </footer>
</div>
${echartsJs ? `<script>${safeScript(echartsJs)}</script>` : ''}
${needEcharts ? `<script>
(function(){
  var OPTS = ${chartsPayload};
  function draw(){
    if (!window.echarts) {
      document.querySelectorAll('.chart').forEach(function(el){
        el.innerHTML = '<div style="padding:16px;color:#92400e;background:#fffbeb;border-radius:10px;font-size:13px">图表库未加载, 无法渲染图表</div>';
      });
      return;
    }
    OPTS.forEach(function(opt, i){
      var el = document.getElementById('chart-' + i);
      if (!el) return;
      try {
        var chart = echarts.init(el, null, { renderer: 'canvas' });
        chart.setOption(opt);
        window.addEventListener('resize', function(){ chart.resize(); });
      } catch (e) {
        el.innerHTML = '<div style="padding:16px;color:#b91c1c;background:#fef2f2;border-radius:10px;font-size:13px">图表渲染失败: ' + e.message + '</div>';
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', draw);
  else draw();
})();
</script>` : ''}
</body>
</html>`;
  }

  static buildMD({ title, task, summary, insights = [], kpis = [], compiled = {}, generatedAt }) {
    const ts = generatedAt || new Date().toISOString();
    const lines = [];
    lines.push(`# ${title || 'Askaha 报告'}`);
    lines.push('');
    lines.push(`> 任务: ${task || ''}`);
    lines.push(`> 生成时间: ${formatTime(ts)}`);
    lines.push('');

    const kpiList = (Array.isArray(kpis) ? kpis : []).filter((k) => k && k.label);
    if (kpiList.length) {
      lines.push('## 关键指标');
      lines.push('');
      for (const k of kpiList) {
        lines.push(`- **${k.label}**: ${k.value == null ? '' : k.value}${k.unit || ''}${k.hint ? ` (${k.hint})` : ''}`);
      }
      lines.push('');
    }

    const insightList = (Array.isArray(insights) ? insights : []).filter((s) => String(s || '').trim());
    lines.push('## 分析结论');
    lines.push('');
    if (insightList.length) {
      insightList.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    } else {
      lines.push(summary || '(无)');
    }
    lines.push('');

    const chartList = compiled.charts || [];
    if (chartList.length) {
      lines.push('## 图表 (见 HTML 版本)');
      lines.push('');
      for (const c of chartList) {
        lines.push(`### ${c.title}`);
        lines.push('');
        if (c.note) lines.push(c.note);
        lines.push('');
      }
    }
    if ((compiled.warnings || []).length) {
      lines.push('## 未生成的图表');
      lines.push('');
      for (const w of compiled.warnings) lines.push(`- ${w}`);
      lines.push('');
    }

    lines.push('---');
    lines.push('_由 Askaha 智能体生成_');
    return lines.join('\n');
  }

  /**
   * 把一条 SQL 结果导出成 CSV (数据空间里的原始数据)。
   *
   * 返回 { csv, rows, totalRows, truncated } —— 以前只返回字符串,
   * 调用方无从知道到底导出了多少行, 也就没法在界面上如实标注。
   *
   * maxRows 是**防呆网**, 不是常规截断: 默认 50 万行, 比预览阈值 (1 万行)
   * 高得多。常规的大结果集会完整导出, 用户点「下载」拿到的是全量数据;
   * 只有 `SELECT * FROM 一亿行的表` 这种才会碰到它。
   */
  static buildCSV(result, opts = {}) {
    const empty = { csv: '', rows: 0, totalRows: 0, truncated: false };
    if (!result || !result.columns || !result.columns.length) return empty;
    const cell = (v) => {
      if (v === null || v === undefined) return '';
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      // 含分隔符/引号/换行时必须包引号, 否则 Excel 打开会串列
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const all = result.rows || [];
    const maxRows = Number.isFinite(Number(opts.maxRows)) && Number(opts.maxRows) > 0
      ? Math.floor(Number(opts.maxRows))
      : CSV_EXPORT_MAX_ROWS;
    const used = all.length > maxRows ? all.slice(0, maxRows) : all;

    // 表头用中文列名 (原始列名在 labels 里留底, 没标签时原样输出)
    const lines = [columnLabels(result, result.columns).map(cell).join(',')];
    for (const row of used) {
      lines.push(result.columns.map((c) => cell(row[c])).join(','));
    }
    // Excel 对 UTF-8 CSV 的识别: 加 BOM 才不会把中文显示成乱码
    return {
      csv: '\ufeff' + lines.join('\r\n'),
      rows: used.length,
      // rowCount 是数据库报的总行数, 可能比 rows.length 大 (驱动自己截过);
      // 取两者大的那个, 才是"这次查询到底有多少行"的诚实答案
      totalRows: Math.max(all.length, Number(result.rowCount) || 0),
      truncated: used.length < all.length
    };
  }

  /** Excel 本质是表格, 这里保留每个 SQL 一个 sheet 的结构 */
  static buildXLSX({ title, task, summary, insights = [], steps = [], generatedAt }) {
    const XLSX = require('xlsx');
    const wb = XLSX.utils.book_new();
    const nameSheet = makeSheetNamer();

    const overview = [
      ['报告标题', title || 'Askaha 报告'],
      ['生成时间', generatedAt || new Date().toISOString()],
      [],
      ['用户任务'],
      [task || ''],
      [],
      ['分析结论']
    ];
    const insightList = (Array.isArray(insights) ? insights : []).filter((s) => String(s || '').trim());
    if (insightList.length) {
      insightList.forEach((s, i) => overview.push([`${i + 1}.`, String(s)]));
    } else {
      for (const line of String(summary || '').split('\n')) overview.push([line]);
    }
    const ws1 = XLSX.utils.aoa_to_sheet(overview);
    ws1['!cols'] = [{ wch: 6 }, { wch: 90 }];
    XLSX.utils.book_append_sheet(wb, ws1, nameSheet('概览', '概览'));

    let sqlIdx = 0;
    for (const s of steps) {
      if (s.kind !== 'sql' || !s.result || !s.result.columns) continue;
      sqlIdx += 1;
      const r = s.result;
      const fallback = `SQL${sqlIdx}`;
      if (r.error) {
        const wsErr = XLSX.utils.aoa_to_sheet([
          [s.title || fallback],
          ['错误: ' + r.error],
          [],
          [s.sql || '']
        ]);
        XLSX.utils.book_append_sheet(wb, wsErr, nameSheet(`${s.title || fallback} 错误`, `${fallback}_错误`));
        continue;
      }
      const data = [columnLabels(r, r.columns)];
      for (const row of r.rows || []) {
        data.push(r.columns.map((c) => row[c]));
      }
      const ws = XLSX.utils.aoa_to_sheet(data);
      ws['!cols'] = r.columns.map(() => ({ wch: 18 }));
      XLSX.utils.book_append_sheet(wb, ws, nameSheet(s.title || fallback, fallback));
    }

    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  }
}

function buildTableBlocks(steps) {
  const sqlSteps = steps.filter((s) => s.kind === 'sql');
  return sqlSteps
    .map((s, i) => {
      const r = s.result;
      const head = `<h4>${i + 1}. ${escapeHtml(s.title || 'SQL #' + (i + 1))}</h4>`;
      const sql = s.sql ? `<pre class="sql"><code>${escapeHtml(s.sql)}</code></pre>` : '';
      let body = '';
      if (r && r.error) {
        body = `<div class="warn">${escapeHtml(r.error)}</div>`;
      } else if (r && r.columns && r.columns.length) {
        const header = '<tr>' + r.columns
          .map((c) => {
            const lb = columnLabel(r, c);
            // 中文名 + 原名悬浮, 既不丢技术信息又能让人看懂
            return lb === c ? `<th>${escapeHtml(c)}</th>` : `<th title="${escapeHtml(c)}">${escapeHtml(lb)}</th>`;
          })
          .join('') + '</tr>';
        const rows = r.rows
          .slice(0, 300)
          .map((row) => '<tr>' + r.columns.map((c) => `<td>${fmtCell(row[c])}</td>`).join('') + '</tr>')
          .join('');
        body += `<div class="meta">${r.rowCount} 行 / ${r.elapsedMs} ms</div>`;
        body += `<div class="table-wrap"><table>${header}${rows}</table></div>`;
        if (r.rowCount > 300) body += `<div class="meta">仅显示前 300 行, 共 ${r.rowCount} 行</div>`;
      } else {
        body = `<div class="meta">查询成功, 无数据</div>`;
      }
      return `<div class="step-block">${head}${sql}${body}</div>`;
    })
    .join('');
}

function formatTime(iso) {
  try {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch (e) {
    return String(iso || '');
  }
}

// 简易 markdown -> html (标题/列表/代码/加粗/段落/换行)
function mdToHtml(md) {
  if (!md) return '';
  const lines = String(md).split('\n');
  const out = [];
  let inList = false;
  let para = [];
  const flushPara = () => {
    if (para.length) {
      out.push('<p>' + inline(para.join(' ')) + '</p>');
      para = [];
    }
  };
  const closeList = () => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      flushPara();
      closeList();
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushPara();
      closeList();
      const lvl = h[1].length;
      out.push(`<h${lvl + 2}>${inline(h[2])}</h${lvl + 2}>`);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      flushPara();
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push('<li>' + inline(line.replace(/^[-*]\s+/, '')) + '</li>');
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      flushPara();
      closeList();
      out.push('<p>' + inline(line) + '</p>');
      continue;
    }
    closeList();
    para.push(line);
  }
  flushPara();
  closeList();
  return out.join('');
}

function inline(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

module.exports = Report;
module.exports.buildChartOption = buildChartOption;
module.exports.echartsSource = echartsSource;
module.exports.buildCSV = Report.buildCSV;
module.exports.columnLabel = columnLabel;
module.exports.columnLabels = columnLabels;
// 报告是把模型产出的 HTML 塞进 iframe 渲染的, 这两个转义函数是那道边界, 单独导出来测
module.exports.safeScript = safeScript;
module.exports.safeJsonForScript = safeJsonForScript;
