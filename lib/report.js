/**
 * 报告生成器
 * 根据 agent 收集到的 SQL + 数据 + 总结生成 HTML 和 Markdown 报告
 */

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

class Report {
  /**
   * @param {object} payload
   *   - title: 报告标题
   *   - task: 用户原始任务
   *   - summary: 智能体总结 (markdown)
   *   - steps: [{ kind, title, content, sql, result }]
   *   - generatedAt: ISO string
   */
  static build(payload) {
    const { title, task, summary, steps = [], generatedAt } = payload;
    const html = Report.buildHTML({ title, task, summary, steps, generatedAt });
    const md = Report.buildMD({ title, task, summary, steps, generatedAt });
    let xlsxBase64 = null;
    try {
      const buf = Report.buildXLSX({ title, task, summary, steps, generatedAt });
      xlsxBase64 = buf.toString('base64');
    } catch (e) {
      // 静默失败, 仍可输出 html/md
    }
    return { html, md, xlsxBase64 };
  }

  /**
   * 生成 .xlsx 文件 (buffer). 第一个 sheet 是总结 + 任务, 之后每个 SQL 步骤一个 sheet.
   */
  static buildXLSX({ title, task, summary, steps = [], generatedAt }) {
    const XLSX = require('xlsx');
    const wb = XLSX.utils.book_new();

    // Sheet 1: 总览
    const overview = [
      ['报告标题', title || 'SoloDB 报告'],
      ['生成时间', generatedAt || new Date().toISOString()],
      [],
      ['用户任务'],
      [task || ''],
      [],
      ['智能体总结']
    ];
    const summaryLines = String(summary || '').split('\n');
    for (const line of summaryLines) overview.push([line]);
    const ws1 = XLSX.utils.aoa_to_sheet(overview);
    ws1['!cols'] = [{ wch: 18 }, { wch: 80 }];
    XLSX.utils.book_append_sheet(wb, ws1, '概览');

    // 后续 sheet: 每个 SQL 步骤的数据
    let sheetIdx = 0;
    for (const s of steps) {
      sheetIdx += 1;
      if (s.kind !== 'sql' || !s.result || !s.result.columns) continue;
      const r = s.result;
      if (r.error) {
        const wsErr = XLSX.utils.aoa_to_sheet([
          [s.title || `SQL #${sheetIdx}`],
          ['错误: ' + r.error],
          [],
          [s.sql || '']
        ]);
        XLSX.utils.book_append_sheet(wb, wsErr, `SQL${sheetIdx}_错误`);
        continue;
      }
      const data = [r.columns];
      for (const row of r.rows || []) {
        data.push(r.columns.map((c) => row[c]));
      }
      const ws = XLSX.utils.aoa_to_sheet(data);
      ws['!cols'] = r.columns.map(() => ({ wch: 18 }));
      const safeTitle = String(s.title || `SQL${sheetIdx}`).slice(0, 28);
      XLSX.utils.book_append_sheet(wb, ws, safeTitle);
    }

    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  }

  static buildHTML({ title, task, summary, steps, generatedAt }) {
    const ts = generatedAt || new Date().toISOString();

    const stepBlocks = steps
      .map((s, i) => {
        const head = `<div class="step-head"><span class="step-no">${i + 1}</span><span class="step-title">${escapeHtml(
          s.title || s.kind || '步骤'
        )}</span></div>`;
        let body = '';
        if (s.content) {
          body += `<div class="step-content">${mdToHtml(s.content)}</div>`;
        }
        if (s.sql) {
          body += `<pre class="sql"><code>${escapeHtml(s.sql)}</code></pre>`;
        }
        if (s.result) {
          const r = s.result;
          if (r.error) {
            body += `<div class="error">${escapeHtml(r.error)}</div>`;
          } else if (r.columns && r.columns.length) {
            const header =
              '<tr>' + r.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('') + '</tr>';
            const rows = r.rows
              .slice(0, 500)
              .map(
                (row) =>
                  '<tr>' +
                  r.columns
                    .map((c) => {
                      const v = row[c];
                      return `<td>${fmtCell(v)}</td>`;
                    })
                    .join('') +
                  '</tr>'
              )
              .join('');
            body += `<div class="meta">${r.rowCount} 行 / ${r.elapsedMs} ms</div>`;
            body += `<div class="table-wrap"><table>${header}${rows}</table></div>`;
            if (r.rowCount > 500) {
              body += `<div class="meta">仅显示前 500 行, 共 ${r.rowCount} 行</div>`;
            }
          } else {
            body += `<div class="meta">查询成功, 0 行 / ${r.elapsedMs || 0} ms</div>`;
          }
        }
        return `<section class="step">${head}${body}</section>`;
      })
      .join('');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title || 'SoloDB 报告')}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
         margin: 0; padding: 40px 56px; color: #1f2328; background: #f6f7f9; line-height: 1.6; }
  .container { max-width: 960px; margin: 0 auto; background: #ffffff; border-radius: 16px;
               padding: 40px 48px; box-shadow: 0 1px 2px rgba(0,0,0,.04), 0 4px 18px rgba(0,0,0,.04); }
  h1 { margin: 0 0 8px; font-size: 28px; }
  .meta-line { color: #6b7280; font-size: 13px; margin-bottom: 28px; }
  .task-box { background: #f3f4f6; border-radius: 12px; padding: 14px 18px; margin-bottom: 28px; }
  .task-box .label { font-size: 12px; color: #6b7280; margin-bottom: 4px; letter-spacing: .04em; }
  .summary { background: #eef2ff; border-radius: 12px; padding: 18px 22px; margin-bottom: 32px; }
  .summary h2 { margin: 0 0 8px; font-size: 16px; color: #4338ca; }
  .step { border: 1px solid #eceef2; border-radius: 12px; padding: 18px 20px; margin-bottom: 16px; }
  .step-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .step-no { display: inline-flex; width: 24px; height: 24px; align-items: center; justify-content: center;
             background: #111827; color: #fff; border-radius: 8px; font-size: 12px; font-weight: 600; }
  .step-title { font-weight: 600; }
  .step-content p { margin: 6px 0; }
  .step-content code { background: #f3f4f6; padding: 1px 6px; border-radius: 4px; font-size: 13px; }
  pre.sql { background: #0f172a; color: #e2e8f0; padding: 14px 18px; border-radius: 10px; overflow-x: auto;
            font-size: 13px; line-height: 1.5; margin: 10px 0; }
  pre.sql code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .meta { color: #6b7280; font-size: 12px; margin: 6px 0; }
  .table-wrap { overflow-x: auto; border: 1px solid #eceef2; border-radius: 10px; margin-top: 6px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #f0f1f3; white-space: nowrap; }
  th { background: #f8f9fb; font-weight: 600; color: #374151; position: sticky; top: 0; }
  tr:last-child td { border-bottom: none; }
  .error { background: #fef2f2; color: #b91c1c; padding: 10px 14px; border-radius: 8px; font-size: 13px; }
  ul, ol { padding-left: 22px; }
  h3 { margin: 12px 0 6px; font-size: 15px; }
  footer { margin-top: 32px; color: #9ca3af; font-size: 12px; text-align: right; }
</style>
</head>
<body>
<div class="container">
  <h1>${escapeHtml(title || 'SoloDB 报告')}</h1>
  <div class="meta-line">生成时间: ${escapeHtml(ts)}</div>
  <div class="task-box">
    <div class="label">USER TASK</div>
    <div>${escapeHtml(task || '')}</div>
  </div>
  <div class="summary">
    <h2>总结</h2>
    <div>${mdToHtml(summary || '')}</div>
  </div>
  ${stepBlocks || '<div class="meta">无执行步骤</div>'}
  <footer>由 SoloDB 智能体生成</footer>
</div>
</body>
</html>`;
  }

  static buildMD({ title, task, summary, steps = [], generatedAt }) {
    const ts = generatedAt || new Date().toISOString();
    const lines = [];
    lines.push(`# ${title || 'SoloDB 报告'}`);
    lines.push('');
    lines.push(`> 生成时间: ${ts}`);
    lines.push('');
    lines.push('## 任务');
    lines.push('');
    lines.push(task || '');
    lines.push('');
    lines.push('## 总结');
    lines.push('');
    lines.push(summary || '');
    lines.push('');
    if (steps.length) {
      lines.push('## 执行步骤');
      lines.push('');
      steps.forEach((s, i) => {
        lines.push(`### ${i + 1}. ${s.title || s.kind || '步骤'}`);
        lines.push('');
        if (s.content) {
          lines.push(s.content);
          lines.push('');
        }
        if (s.sql) {
          lines.push('```sql');
          lines.push(s.sql);
          lines.push('```');
          lines.push('');
        }
        if (s.result) {
          const r = s.result;
          if (r.error) {
            lines.push('**错误**: ' + r.error);
          } else if (r.columns && r.columns.length) {
            lines.push('| ' + r.columns.join(' | ') + ' |');
            lines.push('| ' + r.columns.map(() => '---').join(' | ') + ' |');
            for (const row of r.rows.slice(0, 500)) {
              lines.push('| ' + r.columns.map((c) => fmtCellMd(row[c])).join(' | ') + ' |');
            }
            lines.push('');
            lines.push(`*${r.rowCount} 行 / ${r.elapsedMs} ms*`);
            if (r.rowCount > 500) {
              lines.push('');
              lines.push(`_仅显示前 500 行, 共 ${r.rowCount} 行_`);
            }
          } else {
            lines.push(`*查询成功, 0 行 / ${r.elapsedMs || 0} ms*`);
          }
          lines.push('');
        }
      });
    }
    lines.push('---');
    lines.push('_由 SoloDB 智能体生成_');
    return lines.join('\n');
  }
}

// 简易 markdown -> html (仅支持本报告所需: 标题/列表/代码/加粗/段落/换行)
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
