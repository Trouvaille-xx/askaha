/**
 * SoloDB 智能体
 *
 * 规划/执行循环 (ReAct 风格) + 4 个关键节点人工确认:
 *   1. tables  - 数据表选择 (用户可编辑)
 *   2. fields  - 字段选择 (用户可编辑)
 *   3. sql     - SQL 预览/复制/执行
 *   4. output  - 输出格式 (excel / html / none)
 *
 * checkpoint 是 async callback, 返回 Promise, 主进程负责把
 * 等待转给渲染端 UI, UI 回应后 resolve, 智能体继续.
 */

const Report = require('./report');

const SYSTEM_PROMPT_BASE = `你是 SoloDB, 一个专业的数据库分析智能体。
你的工作流程:
1. 仔细阅读用户任务, 分析要回答的问题
2. 基于数据库 schema 规划 SQL 查询步骤
3. 严格只使用 SELECT / WITH / EXPLAIN / PRAGMA 语句, 严禁写 INSERT/UPDATE/DELETE/DROP 等写操作
4. 每一步输出严格的 JSON 指令
5. 收集到足够信息后, 给出最终总结

可用动作 (action 字段):
- "sql": 执行 SQL 查询
   { "action": "sql", "sql": "SELECT ...", "rationale": "为什么执行这一步" }
- "describe_table": 查看表结构
   { "action": "describe_table", "table": "table_name", "rationale": "..." }
- "finish": 任务完成, 给出最终报告
   { "action": "finish", "title": "报告标题", "summary": "markdown 总结, 包含关键发现与数据洞察" }

约束:
- 始终只输出一个 JSON 对象, 不要包含解释性文字
- SQL 必须符合当前数据库方言
- 必要时使用 LIMIT 限制返回行数
- summary 中使用 markdown 格式 (列表, **加粗**, 表格等)`;

class Agent {
  constructor({ llm, database, skills }) {
    this.llm = llm;
    this.database = database;
    this.skills = skills;
    this.maxSteps = 12;
  }

  /**
   * 用 LLM 给数据库表打分, 选出最相关的 5 张.
   * 返回 [{name, score, reason}], score ∈ [0,1]
   */
  async scoreTables(task, allTables, schemaMap) {
    if (!this.llm.config.apiKey || !allTables.length) return [];
    const maxColsPerTable = 8;
    const lines = allTables.slice(0, 200).map((t) => {
      const cols = (schemaMap[t] || []).slice(0, maxColsPerTable).map((c) => c.field).filter(Boolean);
      return `- ${t}: ${cols.join(', ')}`;
    });
    const messages = [{
      role: 'user',
      content: [
        '你是数据库分析助手. 下面是数据库中所有表及部分字段 (供你判断相关性).',
        '',
        '## 用户任务',
        task,
        '',
        '## 数据库表',
        lines.join('\n'),
        '',
        `请从这些表里挑出与任务最相关的 ${Math.min(5, allTables.length)} 张, 按相关度从高到低排序, 并给每张打分 (0-1).`,
        '严格只输出 JSON, 不要任何解释文字: {"scored":[{"name":"table_name","score":0.95,"reason":"简述相关性, 不超过 20 字"}]}'
      ].join('\n')
    }];
    try {
      const raw = await this.llm.chat(messages);
      const parsed = this.llm._extractJSON(raw);
      if (parsed && Array.isArray(parsed.scored)) {
        return parsed.scored
          .filter((s) => s && s.name && allTables.includes(s.name))
          .slice(0, 5)
          .map((s) => ({
            name: s.name,
            score: typeof s.score === 'number' ? Math.max(0, Math.min(1, s.score)) : 0.5,
            reason: String(s.reason || '').slice(0, 40)
          }));
      }
    } catch (e) {
      // ignore, 退化到让用户全选
    }
    return [];
  }

  /**
   * 用 LLM 给每张已确认的表挑选最相关的字段.
   * 返回 { table: [col, ...] }
   */
  async suggestFields(task, selectedTables, fieldsByTable) {
    if (!this.llm.config.apiKey || !selectedTables.length) return {};
    const lines = selectedTables.map((t) => {
      return `- ${t}: ${(fieldsByTable[t] || []).join(', ')}`;
    });
    const messages = [{
      role: 'user',
      content: [
        '你是数据库分析助手. 下面是用户已确认的表与全部字段.',
        '',
        '## 用户任务',
        task,
        '',
        '## 表与字段',
        lines.join('\n'),
        '',
        '为每张表挑选出与任务最相关的字段. 选得精准一些, 少而精.',
        '严格只输出 JSON, 不要任何解释文字: {"fields":{"table1":["col1","col2"],"table2":["col3","col4"]}}'
      ].join('\n')
    }];
    try {
      const raw = await this.llm.chat(messages);
      const parsed = this.llm._extractJSON(raw);
      if (parsed && parsed.fields) {
        const out = {};
        for (const t of selectedTables) {
          const valid = (parsed.fields[t] || []).filter((c) => (fieldsByTable[t] || []).includes(c));
          if (valid.length) out[t] = valid;
        }
        return out;
      }
    } catch (e) {
      // ignore
    }
    return {};
  }

  async run(task, history, onEvent, onCheckpoint) {
    const events = [];
    const emit = (e) => { events.push(e); if (onEvent) onEvent(e); };

    emit({ type: 'start', task });

    if (!this.database) throw new Error('未配置/未选中数据库, 无法执行任务');
    if (!this.llm.config.apiKey) throw new Error('未配置 LLM API Key');

    const ask = onCheckpoint || (async () => ({}));

    // ---------- 1. 收集 schema ----------
    let tables = [];
    let schemaMap = {}; // table -> columns[]
    try {
      emit({ type: 'phase', phase: 'schema', message: '正在加载数据库 schema...' });
      tables = await this.database.listTables();
      for (const t of tables) {
        try {
          schemaMap[t] = await this.database.describeTable(t);
        } catch (e) {
          schemaMap[t] = [];
        }
      }
      emit({ type: 'schema', tables });
    } catch (e) {
      emit({ type: 'error', message: '读取 schema 失败: ' + e.message });
      throw e;
    }

    // ---------- Checkpoint 1: 表选择 (AI 预筛) ----------
    let scored = [];
    try {
      emit({ type: 'phase', phase: 'score_tables', message: 'AI 正在匹配最相关的表...' });
      scored = await this.scoreTables(task, tables, schemaMap);
    } catch (e) {
      emit({ type: 'phase', phase: 'score_tables', message: '表匹配失败, 将展示所有表: ' + e.message });
    }
    const defaultTable = scored.length ? [scored[0].name] : (tables.length ? [tables[0]] : []);
    const tableCp = await ask({
      type: 'tables',
      allTables: tables,
      suggested: scored,            // [{name, score, reason}]
      defaultSelected: defaultTable,
      dbType: this.database.type,
      dbName: this.database.config.database,
      message: 'AI 已匹配最相关的 5 张表, 默认选第一个. 可调整或在下方补充提示.'
    });
    if (!tableCp || tableCp.cancelled) {
      emit({ type: 'cancelled', message: '用户在表选择阶段取消' });
      throw new Error('用户取消');
    }
    const selectedTables = (tableCp.tables || []).filter((t) => tables.includes(t));
    if (!selectedTables.length) {
      throw new Error('用户未选择任何表');
    }
    const tableHint = (tableCp.hint || '').trim();
    emit({ type: 'checkpoint', phase: 'tables', selected: selectedTables, hint: tableHint, scored });

    // ---------- Checkpoint 2: 字段选择 (AI 预筛) ----------
    const fieldsByTable = {};
    for (const t of selectedTables) {
      fieldsByTable[t] = (schemaMap[t] || []).map((c) => c.field).filter(Boolean);
    }
    let aiFields = {};
    try {
      emit({ type: 'phase', phase: 'suggest_fields', message: 'AI 正在挑选相关字段...' });
      aiFields = await this.suggestFields(task, selectedTables, fieldsByTable);
    } catch (e) {
      emit({ type: 'phase', phase: 'suggest_fields', message: '字段预筛失败, 默认全选: ' + e.message });
    }
    const fieldsSelected = {};
    for (const t of selectedTables) {
      const aiSel = (aiFields[t] || []).filter((c) => fieldsByTable[t].includes(c));
      fieldsSelected[t] = aiSel.length ? aiSel : fieldsByTable[t].slice();
    }
    const fieldCp = await ask({
      type: 'fields',
      fieldsByTable,
      fieldsSelected,
      message: 'AI 已筛选字段, 默认勾选. 可调整或在下方补充提示.'
    });
    if (!fieldCp || fieldCp.cancelled) {
      emit({ type: 'cancelled', message: '用户在字段选择阶段取消' });
      throw new Error('用户取消');
    }
    if (fieldCp.fields) {
      for (const t of selectedTables) {
        if (Array.isArray(fieldCp.fields[t])) {
          fieldsSelected[t] = fieldCp.fields[t].filter((c) => fieldsByTable[t].includes(c));
        }
      }
    }
    const fieldHint = (fieldCp.hint || '').trim();
    emit({ type: 'checkpoint', phase: 'fields', selected: fieldsSelected, hint: fieldHint });

    // ---------- 2. 构造过滤后的 schema 文本 ----------
    const buildSchemaText = () => {
      const lines = [
        `数据库类型: ${this.database.type}`,
        `数据库名: ${this.database.config.database}`,
        `已确认表 (${selectedTables.length}):`
      ];
      for (const t of selectedTables) {
        const cols = (schemaMap[t] || []).filter((c) => fieldsSelected[t].includes(c.field));
        lines.push(`- ${t}(${cols.map((c) => `${c.field}:${c.type}`).join(', ')})`);
      }
      return lines.join('\n');
    };
    const schemaText = buildSchemaText();

    // 收集用户在两个检查点补充的提示
    const hintLines = [];
    if (tableHint) hintLines.push(`- 表选择阶段: ${tableHint}`);
    if (fieldHint) hintLines.push(`- 字段选择阶段: ${fieldHint}`);
    const hintsText = hintLines.length ? hintLines.join('\n') : '';

    // ---------- 3. 准备对话 ----------
    const skillFragment = this.skills ? this.skills.buildSystemPromptFragment() : '';
    const systemPrompt = [SYSTEM_PROMPT_BASE, skillFragment].filter(Boolean).join('\n\n');

    const messages = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          '## 数据库 Schema (用户已确认)',
          schemaText,
          '',
          '## 用户任务',
          task,
          hintsText ? '\n## 用户在确认阶段补充的提示\n' + hintsText : '',
          '',
          '请开始规划, 输出第一步动作的 JSON.'
        ].filter(Boolean).join('\n')
      }
    ];
    if (Array.isArray(history) && history.length) {
      for (const h of history.slice(-6)) {
        if (h.role === 'user' || h.role === 'assistant') {
          messages.push({ role: h.role, content: h.content });
        }
      }
    }

    const steps = [];
    let finalAction = null;

    // ---------- 4. 循环 ----------
    for (let i = 0; i < this.maxSteps; i++) {
      emit({ type: 'phase', phase: 'think', message: `第 ${i + 1} 步: 思考中...` });
      const raw = await this.llm.chat(messages);
      const action = this.llm._extractJSON(raw);

      if (!action || !action.action) {
        emit({ type: 'error', message: 'LLM 输出无法解析为 JSON 动作, 中止' });
        throw new Error('LLM 输出的动作无法解析: ' + (raw || '').slice(0, 200));
      }

      emit({ type: 'thought', step: i + 1, raw, action });

      if (action.action === 'sql') {
        const sqlText = (action.sql || '').trim();
        const title = action.rationale || `执行 SQL #${i + 1}`;

        // ---------- Checkpoint 3: SQL 预览 ----------
        const sqlCp = await ask({
          type: 'sql',
          step: i + 1,
          title,
          sql: sqlText,
          message: '请确认 / 复制 / 编辑以下 SQL, 或选择跳过本步'
        });
        if (!sqlCp || sqlCp.cancelled) {
          emit({ type: 'cancelled', message: `用户在第 ${i + 1} 步 SQL 阶段取消` });
          throw new Error('用户取消');
        }
        if (sqlCp.skip) {
          emit({ type: 'phase', phase: 'sql_skipped', message: title });
          messages.push({ role: 'assistant', content: raw });
          messages.push({ role: 'user', content: '用户跳过了这条 SQL, 请继续下一步规划.' });
          continue;
        }
        const sqlToRun = (sqlCp.sql || sqlText).trim();
        emit({ type: 'phase', phase: 'sql', message: title, sql: sqlToRun });
        let result;
        try {
          result = await this.database.query(sqlToRun);
          emit({ type: 'sql_result', step: i + 1, columns: result.columns, rowCount: result.rowCount, elapsedMs: result.elapsedMs });
        } catch (e) {
          result = { error: e.message, columns: [], rows: [], rowCount: 0, elapsedMs: 0 };
          emit({ type: 'sql_error', step: i + 1, error: e.message });
        }
        steps.push({ kind: 'sql', title, sql: sqlToRun, result });

        messages.push({ role: 'assistant', content: raw });
        messages.push({
          role: 'user',
          content: result.error
            ? `SQL 执行错误: ${result.error}\n请修正 SQL 后重试, 或调整策略.`
            : `SQL 执行成功: ${result.rowCount} 行, 耗时 ${result.elapsedMs} ms\n列: ${(result.columns || []).join(', ')}\n前 ${Math.min(10, result.rows.length)} 行样本:\n${previewRows(result.rows, 10)}`
        });
      } else if (action.action === 'describe_table') {
        const table = action.table;
        const title = action.rationale || `查看表 ${table} 结构`;
        // 字段已被用户裁剪, 给出过滤后的列
        let result;
        try {
          const cols = (schemaMap[table] || []).filter((c) => (fieldsSelected[table] || []).includes(c.field));
          if (!cols.length) {
            result = { error: '该表未被确认或所有字段被取消', columns: [], rows: [], rowCount: 0, elapsedMs: 0 };
          } else {
            result = { columns: cols.map((c) => c.field), rows: cols, rowCount: cols.length, elapsedMs: 0 };
          }
          emit({ type: 'describe_result', table, columns: result.columns });
        } catch (e) {
          result = { error: e.message, columns: [], rows: [], rowCount: 0, elapsedMs: 0 };
          emit({ type: 'describe_error', table, error: e.message });
        }
        steps.push({ kind: 'describe', title, content: `查看表 ${table} 的结构`, result });
        messages.push({ role: 'assistant', content: raw });
        messages.push({
          role: 'user',
          content: result.error
            ? `describe_table 错误: ${result.error}`
            : `表 ${table} 字段: ${result.columns.join(', ')}\n详情: ${JSON.stringify(result.rows, null, 2).slice(0, 1500)}`
        });
      } else if (action.action === 'finish') {
        finalAction = action;
        emit({ type: 'phase', phase: 'finish', message: '任务完成' });
        break;
      } else {
        emit({ type: 'error', message: '未知的 action: ' + action.action });
        throw new Error('Unknown action: ' + action.action);
      }
    }

    if (!finalAction) {
      emit({ type: 'phase', phase: 'forcing_finish', message: '已达最大步数, 强制生成总结' });
      messages.push({ role: 'user', content: '已达最大步数, 请基于已收集的数据, 输出 finish 动作的 JSON 总结.' });
      const raw = await this.llm.chat(messages);
      const action = this.llm._extractJSON(raw);
      if (action && action.action === 'finish') {
        finalAction = action;
      } else {
        finalAction = { action: 'finish', title: 'SoloDB 报告', summary: raw || '已达到最大步数限制.', task_recap: task };
      }
    }

    // ---------- Checkpoint 4: 输出格式 ----------
    const outputCp = await ask({
      type: 'output',
      title: finalAction.title || 'SoloDB 报告',
      summary: finalAction.summary || '',
      message: '请选择输出格式'
    });
    if (!outputCp || outputCp.cancelled) {
      emit({ type: 'cancelled', message: '用户在输出选择阶段取消' });
      throw new Error('用户取消');
    }
    const outputFormat = outputCp.output || 'none'; // 'html' | 'excel' | 'none'
    emit({ type: 'checkpoint', phase: 'output', output: outputFormat });

    // ---------- 5. 生成报告 ----------
    const reportPayload = {
      title: finalAction.title || 'SoloDB 报告',
      task,
      summary: finalAction.summary || '',
      steps,
      generatedAt: new Date().toISOString()
    };
    const { html, md, xlsxBase64 } = Report.build(reportPayload);
    emit({ type: 'report', html, md, xlsxBase64, title: reportPayload.title, output: outputFormat });

    return {
      title: reportPayload.title,
      summary: reportPayload.summary,
      steps,
      html,
      md,
      xlsxBase64: outputFormat === 'excel' ? xlsxBase64 : null,
      output: outputFormat
    };
  }
}

function previewRows(rows, n) {
  if (!rows || !rows.length) return '(无数据)';
  const cols = Object.keys(rows[0]);
  const lines = [];
  lines.push(cols.join(' | '));
  lines.push(cols.map(() => '---').join(' | '));
  for (const r of rows.slice(0, n)) {
    lines.push(cols.map((c) => formatCell(r[c])).join(' | '));
  }
  return lines.join('\n');
}

function formatCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  return s.length > 80 ? s.slice(0, 77) + '...' : s;
}

module.exports = Agent;
