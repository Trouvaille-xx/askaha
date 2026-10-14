/**
 * Askaha 智能体
 *
 * 工作方式: 工具循环 (模型自己决定下一步), 而不是固定的四步流程。
 *
 * 会话是有状态的。每次运行都会带上"本会话已知的资料":
 *   - 已确认可访问的表, 以及这些表的字段
 *   - 本会话已经跑过的查询及其结果 (可以直接用来出报告, 不必重查)
 *   - 上一次产出的报告
 * 所以"把报告重画一下""换个配色"这类要求, 模型会直接 finish, 不会去碰数据库。
 *
 * 只有下面两种情况才会打扰用户:
 *   1. 需要访问新的表 (request_scope -> 选表/选字段弹窗)
 *   2. 模型自己判断信息不够 (ask_user)
 * 另外 SQL 执行前一律过目确认 —— 只读模式下这是唯一的硬闸门。
 *
 * 可访问范围仍然是用户在数据库页勾选的白名单, 范围外的表模型看不到也拿不到。
 */

const Report = require('./report');
const { BUILTIN_TOOLS, parseDSML, normalizeToolName } = require('./actions');
const TableMatch = require('./table-match');
const LlmUsage = require('./llm.js');
const { buildSystemPrompt } = require('./prompt');
const Gate = require('./gate');
const Engine = require('./engine');
const { DEFAULT_MAX_CHARS, AgentLoop } = require('./agent-loop');
const { ToolRegistry } = require('./tools');
const { AgentContext } = require('./context');
const Peek = require('./data-peek.js');

// 意图路由(闲聊 / 分析 / 流程卡三分、以及多张卡时的调研收窄)整体在 lib/gate.js 里。
// 放那儿是为了能单跑: 它不吃数据库、不吃工具, 只吃一次模型调用。

/**
 * 分析 Agent 里"只读、可并发"的工具。其余的都要碰外部世界 (库、弹窗、流程卡),
 * 一律串行 —— 慢一点好过两个弹窗一起弹。
 *
 * 提到模块作用域是为了能被导出: 「内部工具」页要展示每个工具是只读还是串行,
 * 那份展示必须读这里, 不能在界面上另抄一份 —— 抄一份就等于埋一个必然漂移的副本。
 */
const ANALYSIS_READ_ONLY = new Set([
  'describe_table', 'load_skill', 'list_workflows',
  // 下面三个只读且不弹窗: 抽样看值 / 查索引 / 读回早先的结果。
  // 它们存在的意义就是"不用为了看一眼数据而弹一次 SQL 确认框", 所以必须留在只读集合里 ——
  // 一旦掉出去就会变成串行 + 走确认流程, 那还不如让模型直接跑 SQL。
  'look_at_data', 'check_index', 'read_result',
  // 检索知识库: 只读、不弹窗, 且天然希望和 sql 并行 (混合意图: 一边查数一边查口径)。
  // 放进只读集合, 运行时才允许它和别的只读工具并发。
  'search_knowledge'
]);


/**
 * 已确认的表 + 字段, 拼成给模型看的结构文本。
 *
 * 三条信息缺一不可:
 *   1. **列注释** —— 库维护的那份口径 ("付款单号""选票批次 ID, 外键 → …")。
 *      没有它, 模型只能靠 `doc_num` 这个名字猜这一列装什么, 猜错不报错。
 *   2. **字段筛选之后剩下的列要报个数** —— 以前被筛掉的列在上下文里**完全不存在**,
 *      于是"全字段导出"这种要求会落空: 模型连这几列存在都不知道。
 *      这里只列名字不带注释, 成本很低, 但"这表还有别的列"这件事不再丢。
 *   3. 类型 —— 判断某个字面量该不该加引号还得靠它。
 */
function buildSchemaText(scope, noteOf) {
  const lines = [`已确认的表 (${scope.tables.length}):`];
  for (const t of scope.tables) {
    const all = scope.schemaMap[t] || [];
    const picked = (scope.fieldsSelected[t] || []);
    const cols = all.filter((c) => picked.includes(c.field));
    lines.push(`- ${t}(${cols.map((c) => `${c.field}:${c.type}${c.comment ? ` -- ${c.comment}` : ''}`).join(', ')})`);
    if (noteOf[t]) lines.push(`  说明: ${noteOf[t]}`);
    const left = all.filter((c) => !picked.includes(c.field)).map((c) => c.field);
    if (left.length) {
      lines.push(`  该表另有 ${left.length} 列未纳入本次范围 (需要就用, 直接写进 SQL 即可): ${left.join(', ')}`);
    }
  }
  return lines.join('\n');
}

/**
 * 把模型给的表名归一化成**清单里的那个写法**。
 *
 * 模型经常把表名写成 `库名.表名`, 或者带反引号 / 双引号。以前直接拿去和候选
 * 清单比, `candidates.includes('opc销售订单库.order_info')` 是 false —— 这条
 * 结果被**静默丢掉**: 不报错、不打日志, 表现只是"AI 明明挑出来了, 界面上却没有"。
 * 这种失败最难查, 因为每一步看起来都正常。
 *
 * 做两件事:
 *   1. 去掉反引号/双引号/方括号; 有库名前缀就取最后一段
 *   2. 按**大小写不敏感**匹配回清单里的原样写法 —— 清单是唯一权威, 不能把模型
 *      的写法带出去, 下游到处都在用这个名字查表
 *
 * 匹配不上返回空串 (调用方一律 filter(Boolean)), 不要返回模型的原名。
 */
function normalizeTableName(raw, candidates) {
  let s = String(raw == null ? '' : raw).trim().replace(/[`"[\]]/g, '');
  if (s.includes('.')) s = s.split('.').pop().trim();
  if (!s) return '';
  if (!Array.isArray(candidates)) return s;
  const lower = s.toLowerCase();
  for (const c of candidates) {
    if (String(c).toLowerCase() === lower) return c;
  }
  return '';
}

/**
 * 一张表"是干什么的"这句话, 从哪来。
 *
 * 优先用**用户自己写的备注** —— 那是对着业务口径写的, 比库里的通用描述准。
 * 用户没写就退回**数据库里维护的注释** (探测数据表时带回来的)。
 *
 * 以前这里只认备注, 于是库里明明有中文注释, 选表那一步还是只能按表名猜。
 * 而 _scoreTables 的注释自己就写着"表名通常看不出业务含义 (t_ord_hdr、f_st),
 * 真正起作用的是备注" —— 库里那份最权威的说明以前完全没用上。
 */
function tableDesc(t) {
  if (!t) return '';
  const note = String(t.note || '').trim();
  if (note) return note;
  return String(t.comment || '').trim();
}

function buildCarriedText(carried) {
  if (!carried.length) return '(还没有, 这是本会话的第一轮)';
  return carried
    .map((s, i) => {
      const labels = (s.result && s.result.labels) || {};
      const cols = ((s.result && s.result.columns) || []).map((c) => (labels[c] ? `${c}(${labels[c]})` : c));
      const name = s.purpose || s.title || `查询${i + 1}`;
      const rows = (s.result && s.result.rowCount) || 0;
      const line = `[${i + 1}] ${name} · ${rows} 行 · 列: ${cols.join(', ')}`;
      // 带上**来源 SQL**。否则用户追问"这条数据是哪张表 / 哪条 SQL 取的"时, 模型手里
      // 只有列名, 答不出来 (实测踩过: 一句"销售订单额去哪张表查的"就卡住, 只能说看不到)。
      // SQL 很短 (几百字), 和"全量行贴进上下文会撑爆"是两回事。
      const sql = String(s.sql || '').replace(/\s+/g, ' ').trim();
      return sql ? line + `\n    SQL: ${sql.length > 400 ? sql.slice(0, 400) + ' …' : sql}` : line;
    })
    .join('\n');
}

/** 落盘用的瘦身版步骤: 结果行数封顶, 免得对话 json 越滚越大 */
function compactSteps(steps, maxRows = 300) {
  return (steps || [])
    .filter((s) => s && s.kind === 'sql' && s.result && !s.result.error && Array.isArray(s.result.columns) && s.result.columns.length)
    .map((s) => ({
      kind: 'sql',
      title: s.title || '',
      purpose: s.purpose || '',
      why: s.why || '',
      fields: s.fields || [],
      sql: s.sql || '',
      result: {
        columns: s.result.columns,
        rows: (s.result.rows || []).slice(0, maxRows),
        labels: s.result.labels || null,
        rowCount: s.result.rowCount,
        elapsedMs: s.result.elapsedMs
      }
    }));
}

/**
 * 识别"一个值里其实塞了好几个单号", 把它们拆开。
 *
 * 为什么需要它 (实测踩出来的):
 *   流程卡的契约是"一个输入项 = 一个值", 取数 SQL 拿它做单值比较 (WHERE no = {{x}})。
 *   而抽取输入那一步是个**通用**提示词, 它不知道卡的这层约束, 用户一次给 3 个 SO 时,
 *   实测模型会把它们拼成 'a,b,c' 塞进同一个 key —— 引擎又只拦"空值"不拦"一个值里
 *   塞了多个", 渲染成 WHERE no = 'a,b,c', 查不到任何行, 结论却是"查无数据"。
 *
 * 为什么放代码里而不是提示词里:
 *   提示词是概率, 这层是契约。用户连问三次、纠正两次还是被拼成一个值, 说明
 *   "嘱咐模型别拼"靠不住 —— 必须在交给引擎前用代码把这一关把死。
 *
 * 拆得**很保守** (拿不准就原样返回单值, 不误拆正常值):
 *   - 至少 2 段;
 *   - 每段都长得像单号 (字母数字, 允许 - _ . /, 至少 6 位) —— 把中文说明、
 *     短词 ("无" "没有") 这类段挡在外面;
 *   - 形状一致 (都带同一种字母前缀, 或都是纯数字) —— 'SO1, SO2, SO3' 拆,
 *     'SO1, 没查到' 不拆。
 *
 * 分隔符: 逗号/顿号/分号, 以及"两个及以上的空白" (单个空格可能是值内部的,
 * 但连续空格/换行几乎一定是用户在分隔多个单号)。
 *
 * @param {string} s 抽取出来的单个输入值
 * @returns {string[]} 拆出的单号数组; 只有一个 (或不该拆) 时返回 [s]
 */
function splitMultiValues(s) {
  const v = String(s == null ? '' : s).trim();
  if (!v) return [];
  const ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9\-_./]{5,}$/;

  // 第一刀: 明确的分隔符 (逗号/顿号/分号/换行)。
  let parts = v.split(/[,，、;；\n]+/).map((x) => x.trim()).filter(Boolean);

  // 只拆出一段、但里面其实有多个"长得像单号"的词 → 多半是拿空格隔开的
  // ('SO... SO... SO...' 是用户最常见的给法, 实测就是这样)。这时按单空格兜底再切一刀。
  // 但"SO... 帮我看下签收" 这种"单号 + 中文说明"不能切 —— 单号形状的词只有 1 个, 不触发。
  if (parts.length === 1 && parts[0].includes(' ')) {
    const words = parts[0].split(/\s+/).map((x) => x.trim()).filter(Boolean);
    if (words.filter((w) => ID_SHAPE.test(w)).length >= 2) parts = words;
  }

  if (parts.length < 2) return [v];
  const shaped = parts.filter((p) => ID_SHAPE.test(p));
  if (shaped.length < 2) return [v];
  const pref = (p) => { const m = /^([A-Za-z]+)\d/.exec(p); return m ? m[1].toUpperCase() : ''; };
  const prefs = new Set(shaped.map(pref));
  const allNumeric = shaped.every((p) => /^\d+$/.test(p));
  if (!(prefs.size === 1 || allNumeric)) return [v];
  // 形状明显不一致的段 (含中文/空格/太短) 不往结果里带 —— 它们多半不是单号
  return shaped;
}

/**
 * 斜杠指令。**单一来源** —— 主进程的解析器 (parseSlash / _handleSlash) 和给界面的
 * agent:commands 接口都读这一份; 两处各写一份清单迟早漂移。
 */
const SLASH_COMMANDS = [
  { name: 'help', usage: '/help', desc: '列出这些指令' },
  { name: 'sql', usage: '/sql <需求>', desc: '强制取数分析 (跳过意图判断)' },
  { name: 'chat', usage: '/chat <话>', desc: '强制纯对话, 不碰数据库' },
  { name: 'card', usage: '/card <需求或卡名> [输入]', desc: '按需求挑一张流程卡来跑 (也可以直接给卡名/id)' }
];

/**
 * 认**行首**的斜杠指令。命令名只认 ASCII 字母; 必须是整串的第一个 token。
 * 返回 { name, arg } 或 null; 裸 "/" 归一成 help。
 */
function parseSlash(task) {
  const s = String(task == null ? '' : task).trim();
  if (s === '/') return { name: 'help', arg: '' };
  const m = /^\/([A-Za-z]+)(?:\s+([\s\S]*))?$/.exec(s);
  if (!m) return null;
  return { name: m[1].toLowerCase(), arg: (m[2] || '').trim() };
}

/** 给用户的指令清单 (也是 /help 的正文) */
function slashHelpText() {
  return '斜杠指令 —— 直接说明要做什么, 省掉一次意图判断:\n' +
    SLASH_COMMANDS.map((c) => `- ${c.usage}   ${c.desc}`).join('\n') +
    '\n\n不写斜杠就照常: 系统自己判断你是闲聊、取数, 还是该走某张流程卡。';
}

class Agent {
  /**
   * @param tableInventory 用户勾选的可访问表, [{name, note}]. 空数组表示白名单为空。
   * @param prompt  提示词的模块配置, 形状见 lib/prompt.js。不传就用出厂提示词。
   * @param general 行为参数 { maxSteps, historyTurns }, 不传用默认值。
   */
  constructor({ llm, database, skills, tableInventory, mcp, prompt, general, engines, databases, openDb, knowledge }) {
    this.llm = llm;
    this.database = database;
    this.skills = skills;
    this.tableInventory = Array.isArray(tableInventory) ? tableInventory : [];
    // 知识库服务 (lib/knowledge/index.js)。没配就为 null —— 此时 search_knowledge
    // 工具根本不会暴露给模型 (见 _toolSchemas)。
    this.knowledge = knowledge || null;
    // 流程卡: 管理员在「流程引擎」页配好的卡。空数组 = 这个功能没启用, 闸门退化成二分。
    this.engines = Array.isArray(engines) ? engines : [];
    // 流程卡可以指向任意一个已配置的库 (不只是当前选中的那个), 所以这里要拿到全量清单。
    this.databases = Array.isArray(databases) ? databases : [];
    this.openDb = typeof openDb === 'function' ? openDb : null;
    // 外部接入的工具 (MCP 服务器等), 形状与内置动作一致
    this.mcp = mcp || null;
    this.extraTools = Array.isArray(mcp && mcp.tools) ? mcp.tools : [];
    // 提示词与行为参数都由设置页决定, 这里只留兜底
    this.promptConfig = prompt || null;
    const g = general || {};
    this.maxSteps = Number.isFinite(g.maxSteps) && g.maxSteps > 0 ? Math.min(60, Math.floor(g.maxSteps)) : 16;
    // 一次提问里, 步数跑满之后最多自动接着开几轮 (见 run() 里的续轮循环)。
    // 上限 50 是防呆 —— 这个值乘上 maxSteps 就是单次提问最坏情况下的模型调用数。
    this.maxRounds = Number.isFinite(g.maxRounds) && g.maxRounds > 0 ? Math.min(50, Math.floor(g.maxRounds)) : 12;
    this.historyTurns = Number.isFinite(g.historyTurns) && g.historyTurns > 0 ? Math.min(30, Math.floor(g.historyTurns)) : 6;
    // 上下文上限: 超过就把早期的取数结果折成摘要 (跟 AgentLoop 用同一个默认值)
    this.maxChars = Number.isFinite(g.maxChars) && g.maxChars > 0 ? Math.floor(g.maxChars) : DEFAULT_MAX_CHARS;
  }

  /** 本轮可用的工具: 内置动作 + 外部接入的 (MCP) */
  _toolSchemas() {
    let base = BUILTIN_TOOLS;
    // 没配知识库就别把 search_knowledge 摆给模型看 —— 摆出来它就会去调, 白烧一次往返。
    if (!this.knowledge) base = base.filter((t) => !(t.function && t.function.name === 'search_knowledge'));
    // 纯知识路径: 只留"查知识库 / 回话 / 收尾 / 问用户"这几个工具, 不摆 SQL 类 ——
    // 免得模型在纯知识问题上又去读表、写 SQL。
    if (this._knowledgeOnly) {
      const keep = new Set(['search_knowledge', 'reply', 'finish', 'ask_user']);
      base = base.filter((t) => t.function && keep.has(t.function.name));
    }
    return (this.extraTools.length && !this._knowledgeOnly) ? [...base, ...this.extraTools] : base.slice();
  }


  /**
   * 把分析 Agent 的每个动作实现成注册表里的一个工具。
   *
   * 为什么用闭包而不是把状态挂在 this 上: 这些东西 (scope / candidates / steps /
   * st) 都是**这一轮 run() 的局部状态**, 挂到实例上会在并发或下一轮里串味。
   * 闭包天然只活在这一次 run() 里。
   *
   * 工具的 schema 仍然从 actions.js 的 BUILTIN_TOOLS 取 —— 模型看到的那份说明
   * 只有一处来源, 这里只补实现。没实现的动作不会被暴露出去。
   */
  _analysisTools(env) {
    const { ask, emit, scope, candidates, task, steps, carry, st, contextBlock, autoRun } = env;
    const registry = new ToolRegistry();

    /* ---- 只在跟用户说话, 不取数 ---- */
    const reply = async (args) => {
      const text = String(args.text || args.message || '').trim();
      if (!text) return 'reply 缺少 text 参数, 请重新调用。';
      st.finalAction = { action: 'reply', text };
      emit({ type: 'reply', text });
      return '已回复用户, 这一轮结束。';
    };

    /* ---- 申请扩大可访问范围 ---- */
    const requestScope = async (args) => {
      const wanted = (Array.isArray(args.tables) ? args.tables : [])
        .map((t) => (typeof t === 'string' ? t : t && t.name))
        // 模型可能写成 库名.表名 或带反引号。以前直接 includes 比对, 这种申请会被
        // 静默丢掉, 然后模型收到"这些表不在清单里" —— 而它明明看得见那张表。
        .map((n) => normalizeTableName(n, candidates))
        .filter(Boolean);
      const fresh = Array.from(new Set(wanted.filter((t) => !scope.tables.includes(t))));
      if (!fresh.length) {
        return wanted.length
          ? `这些表 (${wanted.join(', ')}) 已经在可访问范围内了, 直接用即可, 不必再申请。`
          : '你没有给出有效的表名, 或者这些表不在"可访问的表"清单里。请从清单里挑。';
      }

      // 弹窗里给个 AI 推荐做默认值
      let scored = [];
      let match = null;
      try {
        emit({ type: 'phase', phase: 'score_tables', message: 'AI 正在匹配最相关的表...' });
        match = await this._matchTables(task, candidates, emit);
        scored = (match.scored || [])
          .map((s) => Object.assign({}, s, { name: normalizeTableName(s.name, candidates) }))
          .filter((s) => s && s.name)
          .slice(0, 8);
      } catch (e) { /* 推荐失败不影响弹窗 */ }

      // 实测命中过的表默认勾上 —— 这是"这个号真的在这张表里"级别的证据,
      // 比模型的名字相似度硬。用户仍然可以取消勾选。
      const hitTables = (match && match.probes && match.probes.hits || [])
        .map((h) => h.table).filter((t) => candidates.includes(t));

      const tableCp = await ask({
        type: 'tables',
        allTables: candidates,
        suggested: scored,
        probes: match ? match.probes : null,
        uncertain: (match && match.uncertain) || '',
        untriedCols: (match && match.untriedCols) || [],
        defaultSelected: Array.from(new Set([...scope.tables, ...fresh, ...hitTables])),
        dbType: this.database.type,
        dbName: (this.database.config && this.database.config.database)
          || (typeof this.database.scopeLabel === 'function' ? this.database.scopeLabel() : ''),
        reason: String(args.reason || '').slice(0, 120),
        message: '智能体判断现有范围不够用, 请确认本次要访问的表。'
      });
      if (!tableCp || tableCp.cancelled) {
        emit({ type: 'cancelled', message: '用户在表选择阶段取消' });
        st.fatal = new Error('用户取消');
        return '用户取消了。';
      }
      // 这里用精确匹配是**对的**: tableCp 来自界面弹窗, 选项就是 candidates 本身,
      // 不经过模型的手。凡是模型给的表名, 一律走 normalizeTableName。
      const picked = (tableCp.tables || []).filter((t) => candidates.includes(t));
      if (!picked.length) {
        st.fatal = new Error('用户未选择任何表');
        return '用户没有选任何表。';
      }
      emit({ type: 'checkpoint', phase: 'tables', selected: picked, scored });

      // 新表的字段读出来, 顺便让用户过一眼
      const added = picked.filter((t) => !scope.schemaMap[t] || !scope.schemaMap[t].length);
      const schemaMapNew = {};
      for (const t of added) {
        try {
          schemaMapNew[t] = await this.database.describeTable(t);
        } catch (e) {
          schemaMapNew[t] = [];
        }
      }
      const fieldsByTable = {};
      for (const t of picked) {
        const cols = schemaMapNew[t] || scope.schemaMap[t] || [];
        fieldsByTable[t] = cols.map((c) => c.field).filter(Boolean);
      }

      let aiFields = {};
      try {
        emit({ type: 'phase', phase: 'suggest_fields', message: 'AI 正在挑选相关字段...' });
        aiFields = await this.suggestFields(task, picked, fieldsByTable);
      } catch (e) { /* 预筛失败就全选 */ }
      const fieldsSelectedNew = {};
      for (const t of picked) {
        const aiSel = (aiFields[t] || []).filter((c) => fieldsByTable[t].includes(c));
        fieldsSelectedNew[t] = aiSel.length ? aiSel : fieldsByTable[t].slice();
      }

      const fieldCp = await ask({
        type: 'fields',
        fieldsByTable,
        fieldsSelected: fieldsSelectedNew,
        message: 'AI 已筛选字段, 默认勾选。可调整或在下方补充提示。'
      });
      if (!fieldCp || fieldCp.cancelled) {
        emit({ type: 'cancelled', message: '用户在字段选择阶段取消' });
        st.fatal = new Error('用户取消');
        return '用户取消了。';
      }
      const chosen = {};
      for (const t of picked) {
        const fromUser = fieldCp.fields && Array.isArray(fieldCp.fields[t]) ? fieldCp.fields[t] : null;
        chosen[t] = (fromUser || fieldsSelectedNew[t]).filter((c) => fieldsByTable[t].includes(c));
      }
      emit({ type: 'checkpoint', phase: 'fields', selected: chosen });

      // 落到会话状态里
      scope.tables = picked;
      for (const t of picked) {
        if (schemaMapNew[t]) scope.schemaMap[t] = schemaMapNew[t];
        scope.fieldsSelected[t] = chosen[t];
      }
      // 被用户取消勾选的表要移出去, 否则字段范围对不上
      for (const t of Object.keys(scope.schemaMap)) {
        if (!scope.tables.includes(t)) {
          delete scope.schemaMap[t];
          delete scope.fieldsSelected[t];
        }
      }

      const hint = String(fieldCp.hint || '').trim();
      return [
        '## 范围已更新',
        contextBlock(),
        hint ? `\n用户补充: ${hint}` : '',
        '',
        '请继续, 给出下一个动作。'
      ].filter(Boolean).join('\n');
    };

    /* ---- 执行 SQL ---- */
    const sql = async (args) => {
      const sqlText = String(args.sql || '').trim();
      const purpose = String(args.purpose || '').trim();
      const why = String(args.rationale || '').trim();
      const fields = normalizeFields(args.fields);
      // 步骤名优先用"做什么": 它既显示在界面, 也决定归档文件的名字
      const title = purpose || why || `执行 SQL #${st.sqlStepNo + 1}`;

      // 没有确认过任何表就写 SQL: 字段名多半是编的, 打回去让它先申请范围
      if (!scope.tables.length) {
        return '你还没有确认任何可访问的表, 现在写的字段名可能是猜的。请先用 request_scope 申请需要的表。';
      }

      // ---------- SQL 预览确认 ----------
      //
      // 手动模式: 每条 SQL 都停下来让用户确认 / 编辑 / 跳过 —— 这是唯一的一道硬闸门。
      // 自动模式: 不拦。用户选自动模式要的就是"别问我", 每条 SQL 弹一次确认等于
      // 把自动模式变成"手动模式 + 一次点击"。SQL 仍然会通过下面的 phase 事件显示
      // 在流程里, 只是不再挡住执行。
      let sqlToRun = sqlText;
      if (!autoRun) {
        const sqlCp = await ask({
          type: 'sql',
          step: st.sqlStepNo + 1,
          title,
          purpose,
          why,
          fields,
          sql: sqlText,
          message: '请确认 / 复制 / 编辑以下 SQL, 或选择跳过本步'
        });
        if (!sqlCp || sqlCp.cancelled) {
          emit({ type: 'cancelled', message: `用户在第 ${st.sqlStepNo + 1} 步 SQL 阶段取消` });
          st.fatal = new Error('用户取消');
          return '用户取消了。';
        }
        if (sqlCp.skip) {
          emit({ type: 'phase', phase: 'sql_skipped', message: title });
          return '用户跳过了这条 SQL, 请继续下一步规划。';
        }
        sqlToRun = (sqlCp.sql || sqlText).trim();
      }
      emit({ type: 'phase', phase: 'sql', message: title, purpose, why, fields, sql: sqlToRun });

      let result;
      try {
        result = await this.database.query(sqlToRun);
        emit({ type: 'sql_result', step: st.sqlStepNo + 1, columns: result.columns, rowCount: result.rowCount, elapsedMs: result.elapsedMs });
      } catch (e) {
        result = { error: e.message, columns: [], rows: [], rowCount: 0, elapsedMs: 0 };
        emit({ type: 'sql_error', step: st.sqlStepNo + 1, error: e.message });
      }
      // 结果列的中文名: 只挑 fields 里确实落在结果列上的那些
      const labels = buildLabels(fields, result.columns);
      if (Object.keys(labels).length) result.labels = labels;
      steps.push({ kind: 'sql', title, purpose, why, fields, sql: sqlToRun, result });
      // 报错的那次不算编号, 免得模型按"成功的第几步"算 source 时对不上
      if (!result.error) st.sqlStepNo += 1;

      return result.error
        ? `SQL 执行错误: ${result.error}\n请修正 SQL 后重试, 或调整策略。`
        : `SQL 执行成功 (这是资料 [${st.sqlStepNo}], 报告图表可用 source=${st.sqlStepNo} 引用它): ${result.rowCount} 行, 耗时 ${result.elapsedMs} ms\n列: ${(result.columns || []).join(', ')}\n前 ${Math.min(10, result.rows.length)} 行样本:\n${previewRows(result.rows, 10)}`;
    };

    /* ---- 主动问用户 ---- */
    const askUser = async (args) => {
      const question = String(args.question || '').trim();
      const optionsList = (Array.isArray(args.options) ? args.options : [])
        .map((o) => String(o || '').trim())
        .filter(Boolean)
        .slice(0, 6);
      if (!question) return 'ask_user 缺少 question 参数, 请重新调用。';
      emit({ type: 'phase', phase: 'ask', message: question });
      const ans = await ask({ type: 'question', question, options: optionsList, message: '智能体需要你补充一点信息' });
      if (!ans || ans.cancelled) {
        emit({ type: 'cancelled', message: '用户在追问阶段取消' });
        st.fatal = new Error('用户取消');
        return '用户取消了。';
      }
      const answer = String(ans.answer || '').trim();
      return answer
        ? `用户回答: ${answer}`
        : '用户没有给出明确回答, 请基于现有信息继续, 不要重复追问同一个问题。';
    };

    /* ---- 再看一次表结构 ---- */
    const describeTable = async (args) => {
      const table = args.table;
      const title = args.rationale || `查看表 ${table} 结构`;
      emit({ type: 'phase', phase: 'describe', message: title, table });
      let result;
      try {
        if (!scope.schemaMap[table]) {
          throw new Error(`表 ${table} 不在本会话已确认的范围内, 只能使用: ${scope.tables.join(', ') || '(无)'}`);
        }
        const cols = (scope.schemaMap[table] || []).filter((c) => (scope.fieldsSelected[table] || []).includes(c.field));
        if (!cols.length) {
          result = { error: '该表所有字段都被取消了, 没有可用字段', columns: [], rows: [], rowCount: 0, elapsedMs: 0 };
        } else {
          result = { columns: cols.map((c) => c.field), rows: cols, rowCount: cols.length, elapsedMs: 0 };
        }
        emit({ type: 'describe_result', table, columns: result.columns });
      } catch (e) {
        result = { error: e.message, columns: [], rows: [], rowCount: 0, elapsedMs: 0 };
        emit({ type: 'describe_error', table, error: e.message });
      }
      return result.error
        ? `describe_table 错误: ${result.error}`
        : `表 ${table} 字段: ${result.columns.join(', ')}\n详情: ${JSON.stringify(result.rows, null, 2).slice(0, 1500)}`;
    };

    /* ---- 看某一列真实存的是什么 (只读抽样, 不弹确认框) ---- */
    const lookAtData = async (args) => {
      const table = String(args.table || '').trim();
      const column = String(args.column || '').trim();
      if (!table || !column) return 'look_at_data 要同时给 table 和 column。';
      // 看数据也不能越界: 表和列都必须在本次已确认的范围内。
      // 只校验表是不够的 —— 用户取消勾选的字段照样能被看光。
      if (!scope.schemaMap[table]) {
        return `表 ${table} 不在本会话已确认的范围内, 看不了。当前能用的是: ${scope.tables.join(', ') || '(无)'}`;
      }
      const okCols = (scope.schemaMap[table] || []).filter((c) => (scope.fieldsSelected[table] || []).includes(c.field));
      if (!okCols.some((c) => c.field === column)) {
        return `列 ${column} 不在 ${table} 已确认的字段里。可用字段: ${okCols.map((c) => c.field).join(', ') || '(无)'}`;
      }
      emit({ type: 'phase', phase: 'peek', message: args.why || `看 ${table}.${column} 的真实值`, table, column });

      let target;
      try {
        target = this.database.targetFor(table);
      } catch (e) {
        return `看数据失败: ${e.message}`;
      }
      // 标识符按方言加引号 —— MySQL 只认反引号, 写双引号是语法错误, 不是"查不到"
      const q = Engine.quoteIdent(column, target.dialect);
      const tb = Engine.quoteIdent(table, target.dialect);
      try {
        const r1 = await target.db.query(`SELECT ${q} AS v FROM ${tb} LIMIT 20`);
        const vals = (r1.rows || []).map((x) => x.v);
        // 统计归 lib/data-peek.js: 大表 (超过 100 万行) 自动降级成抽样。
        // 以前这里对全表跑 COUNT(DISTINCT) —— 千万行的表上一列十几秒,
        // 而"哪一列能挂到 X 上"这种关联问题列统计根本答不了。
        const s = await Peek.peekColumnStats({
          db: target.db, dialect: target.dialect, table, tb, col: q
        });
        const lines = [
          `样本 (前 ${vals.length} 行): ` + (vals.length
            ? vals.map((v) => (v === null ? 'NULL' : String(v).slice(0, 50))).join(' | ')
            : '(表里没有行)')
        ];
        for (const line of Peek.formatStats(s)) lines.push(line);
        return lines.join('\n');
      } catch (e) {
        return `看数据失败: ${e.message}`;
      }
    };

    /* ---- 看索引 (只读, 不弹确认框) ---- */
    const checkIndex = async (args) => {
      const table = String(args.table || '').trim();
      const column = String(args.column || '').trim();
      if (!table) return 'check_index 需要 table。';
      if (!scope.schemaMap[table]) {
        return `表 ${table} 不在本会话已确认的范围内, 看不了。`;
      }
      emit({ type: 'phase', phase: 'index', message: `查 ${table} 的索引`, table });

      let target;
      try {
        target = this.database.targetFor(table);
      } catch (e) {
        return `查索引失败: ${e.message}`;
      }
      const lit = (s) => String(s).replace(/'/g, "''");
      try {
        let rows = [];
        if (target.dialect === 'postgres') {
          const r = await target.db.query(
            `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = '${lit(table)}'`
          );
          rows = r.rows || [];
        } else if (target.dialect === 'mysql') {
          // 只读闸门只放行 SELECT / WITH / PRAGMA / EXPLAIN, SHOW 会被直接拒掉 ——
          // 所以查 information_schema, 跟 describeTable 取的是同一份元数据。
          const r = await target.db.query(
            `SELECT INDEX_NAME AS index_name, COLUMN_NAME AS column_name,
                    NON_UNIQUE AS non_unique, SEQ_IN_INDEX AS seq
               FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${lit(table)}'
              ORDER BY INDEX_NAME, SEQ_IN_INDEX`
          );
          rows = r.rows || [];
        } else {
          // 宁可不给答案, 也别给错的 (以前这里返回空 -> 会回一句"一个索引都没有")
          return `暂时只支持在 MySQL / PostgreSQL 上查索引, ${target.dialect} 还没做。`;
        }
        if (!rows.length) return `表 ${table} 上一个索引都没有 (任何过滤都会全表扫)。`;
        const lines = [`表 ${table} 的索引: ${rows.length} 个`];
        for (const x of rows.slice(0, 20)) lines.push('  ' + JSON.stringify(x));
        if (column) {
          lines.push(indexHasColumn(rows, column)
            ? `✓ ${column} 有索引。`
            : `✗ ${column} 没有索引 —— 按它过滤会全表扫, 换个有索引的等价列。`);
        }
        return lines.join('\n');
      } catch (e) {
        return `查索引失败: ${e.message}`;
      }
    };

    /* ---- 把本会话早先某次查询的结果逐行读回来 ---- */
    const readResult = async (args) => {
      const idx = Math.floor(Number(args.index));
      if (!Number.isInteger(idx) || idx < 1) {
        return 'read_result 的 index 要从 1 开始 —— 就是会话状态里那个 [1] [2]。';
      }
      const src = steps[idx - 1];
      if (!src) {
        const have = steps.map((s, i) => `[${i + 1}] ${s.purpose || s.title || '查询'}`).join(', ');
        return `没有第 [${idx}] 份资料。本会话现在有 ${steps.length} 份${have ? ': ' + have : ''}。`;
      }
      const rows = (src.result && src.result.rows) || [];
      if (!rows.length) return `资料 [${idx}]「${src.purpose || src.title || ''}」没有行数据。`;
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
      const limit = Math.min(200, Math.max(1, Math.floor(Number(args.limit) || 50)));
      const page = rows.slice(offset, offset + limit);
      if (!page.length) {
        return `资料 [${idx}] 一共 ${rows.length} 行, 从第 ${offset} 行起就没有了。`;
      }
      emit({ type: 'phase', phase: 'read', message: `读回资料 [${idx}] 的第 ${offset}~${offset + page.length - 1} 行` });
      const total = src.result.rowCount == null ? rows.length : src.result.rowCount;
      const head = `资料 [${idx}]「${src.purpose || src.title || ''}」共 ${total} 行`
        + (src.result.truncated ? ` (只留了前 ${rows.length} 行)` : '')
        + `, 这次给第 ${offset}~${offset + page.length - 1} 行:`;
      return head + '\n' + previewRows(page, page.length);
    };

    /* ---- 加载技能 ---- */
    const loadSkill = async (args) => {
      const name = String(args.name || '').trim();
      const full = this.skills && name ? this.skills.loadFull(name) : null;
      emit({ type: 'phase', phase: 'skill', message: `加载技能 ${name || '(未指定)'}` });
      return full
        ? `技能 ${name} 的完整内容如下, 请按其中的要求继续:\n\n${full}`
        : `技能 ${name || '(未指定名称)'} 不存在或未启用。当前可用技能见系统提示中的清单, 请换一个或继续当前策略。`;
    };

    /* ---- 工作流: 看看有哪些现成的卡 ---- */
    const listWorkflows = async () => {
      const list = (this.engines || []).filter((e) => e && e.enabled !== false);
      if (!list.length) return '这台机器上还没有搭好的流程卡。请用 sql 等工具自己查。';
      emit({ type: 'phase', phase: 'workflow', message: `看了下有哪些流程卡 (${list.length} 张)` });
      return '已搭好的流程卡:\n\n' + list.map((e) => Gate.engineBriefText(e)).join('\n\n')
        + '\n\n如果有哪张正好对上用户说的事, 用 run_workflow 跑它; 没有就照常自己查。';
    };

    /* ---- 工作流: 跑一张卡 ---- */
    const runWorkflow = async (args) => {
      const id = String(args.engineId || '').trim();
      const engine = this._engineById(id);
      if (!engine) {
        return `没有 id 是 ${id || '(空)'} 的流程卡。请先用 list_workflows 看清有哪些、它们的 id 是什么。`;
      }
      const given = (args.inputs && typeof args.inputs === 'object') ? args.inputs : {};
      // 用引擎那套判定: 任选其一的组里给一个就不算缺
      const node = (engine.nodes || []).find((n) => n.type === 'input');
      const chk = Engine.checkInputs((node && node.fields) || [], given);
      if (!chk.ok) {
        return `跑「${engine.name}」还缺 ${chk.missingLabels}。请先 ask_user 问清楚, 拿到值再调一次 run_workflow —— 不要自己编一个值。`;
      }
      if (args.why) {
        emit({ type: 'phase', phase: 'workflow', message: `用「${engine.name}」：${String(args.why).slice(0, 120)}` });
      }
      // 真正跑卡。_execEngine 的返回形状**就是** run() 的返回形状,
      // 所以整轮就以此收尾 —— 不能塞进 finalAction, 那是当"finish 动作"用的。
      st.workflowResult = await this._execEngine(engine, given, emit, carry);
      return `「${engine.name}」已跑完。`;
    };

    /* ---- 出报告 ---- */
    const finish = async (args) => {
      st.finalAction = { action: 'finish', ...args };
      emit({ type: 'phase', phase: 'finish', message: '任务完成' });
      return '已收尾。';
    };

    /* ---- 检索知识库 (RAG) ---- */
    const searchKnowledge = async (args) => {
      if (!this.knowledge) return '知识库未启用。请先在「知识库」页新建一个知识库并导入文档。';
      const query = String(args.query || '').trim();
      if (!query) return 'search_knowledge 缺少 query 参数, 请重新调用并给出检索词。';
      // 多选知识库: 对话页选了多个就逐个搜、合并 rerank (见 KnowledgeService.searchMany)。
      // 模型也可以显式给一个 kbId 覆盖选择。
      const kbIds = args.kbId ? [String(args.kbId).trim()] : this._kbIds;
      const topK = Number.isFinite(Number(args.topK)) ? Number(args.topK) : undefined;
      emit({ type: 'phase', phase: 'rag', message: `正在检索知识库: ${query.slice(0, 40)}` });
      let r;
      try {
        r = await this.knowledge.searchMany({ kbIds, query, llm: this.llm, topK });
      } catch (e) {
        return '检索知识库失败: ' + e.message;
      }
      if (!r || !r.ok) return '检索失败: ' + ((r && r.error) || '未知错误');
      const kbLabel = (r.kbNames && r.kbNames.length ? r.kbNames.join('、') : r.kbName) || '知识库';
      if (!r.hits.length) {
        return `知识库「${kbLabel}」里没有找到与「${query}」相关的内容。可以换个关键词再试; 若仍没有, 就如实告诉用户没有查到依据, 不要编。`;
      }
      // 记进本轮: 给对话页"参考结果" + 问答飞轮用
      const slim = r.hits.map((h) => ({
        kbId: h.kbId || r.kbId, kbName: h.kbName || r.kbName, docId: h.docId, docName: h.docName,
        folderName: h.folderName || '', section: h.section || '', chunkId: h.chunkId,
        score: h.score, snippet: String(h.text || '').slice(0, 300)
      }));
      this._ragHits.push(...slim);
      // 轨迹: 记下"查了知识库、用什么词、命中多少、最高相关度"
      this._trace.push({
        kind: 'rag',
        title: '检索知识库「' + kbLabel + '」',
        detail: '检索词: ' + query.slice(0, 60) + ' · 命中 ' + r.hits.length + ' 条'
          + (r.reranked ? ' (已 LLM 重排)' : '')
          + (r.hits[0] ? ' · 最高相关度 ' + r.hits[0].score : '')
      });
      emit({
        type: 'rag_hits', kbName: kbLabel, reranked: r.reranked,
        hits: r.hits.map((h) => ({
          docName: h.docName, folderName: h.folderName || '', section: h.section || '',
          score: h.score, snippet: String(h.text || '').slice(0, 400), docId: h.docId, chunkId: h.chunkId
        }))
      });
      return `知识库「${kbLabel}」命中 ${r.hits.length} 条 (相关度从高到低):\n\n`
        + r.hits.map((h, i) => `[${i + 1}] 来源: ${h.docName}${h.folderName ? ' / ' + h.folderName : ''}${h.section ? ' / ' + h.section : ''} (相关度 ${h.score})\n${String(h.text || '').slice(0, 900)}`).join('\n\n')
        + '\n\n以上是**原始片段**, 请自己综合成结论, 不要照抄; 并在结论里说明依据来自哪份文档。';
    };

    const impl = {
      reply, request_scope: requestScope, sql, ask_user: askUser,
      describe_table: describeTable, load_skill: loadSkill,
      look_at_data: lookAtData, check_index: checkIndex, read_result: readResult,
      list_workflows: listWorkflows, run_workflow: runWorkflow,
      search_knowledge: searchKnowledge, finish
    };

    // 只读的才能并发跑。sql / request_scope / ask_user / run_workflow 都会碰
    // 外部世界 (库、弹窗、流程卡), 一律串行 —— 慢一点好过两个弹窗一起弹。
    // (集合定义在模块作用域, 因为「内部工具」页要读同一份)
    const READ_ONLY = ANALYSIS_READ_ONLY;

    for (const schema of this._toolSchemas()) {
      const fn = schema && schema.function;
      if (!fn || !fn.name || !impl[fn.name]) continue;
      registry.add(fn.name, fn.description, fn.parameters, impl[fn.name], {
        readOnly: READ_ONLY.has(fn.name),
        group: /workflow/.test(fn.name) ? 'flow' : 'data',
        serial: !READ_ONLY.has(fn.name)
      });
    }

    // MCP 工具跟内置工具同一个命名空间, 运行期不区分来源
    registry.attachMCP(this.mcp);
    return registry;
  }

  /**
   * 把运行时的通用事件翻译成界面认的事件。
   *
   * 界面只认 phase / reply / sql_result / checkpoint / cancelled 这些
   * (app.js 的 case 'thought' 是空的 —— thought 根本不显示)。
   * 所以这里主要是把工具调用过程说成人话, 让用户看得见它在干什么。
   */
  _onLoopEvent(ev, emit) {
    if (!ev) return;
    if (ev.type === 'delta') {
      emit({ type: 'delta', text: ev.text });
      return;
    }
    if (ev.type === 'delta_end') {
      emit({ type: 'delta_end' });
      return;
    }
    if (ev.type === 'thought') {
      emit({ type: 'thought', step: ev.step, action: ev.action });
      return;
    }
    if (ev.type === 'say') {
      emit({ type: 'phase', phase: 'say', message: ev.text });
      return;
    }
    if (ev.type === 'compact') {
      emit({ type: 'phase', phase: 'compact', message: `上下文过长, 折叠了 ${ev.count} 条早期取数结果` });
      return;
    }
    if (ev.type === 'tool_start') {
      // 各工具自己会发更具体的 phase (sql / describe / workflow...),
      // 这里只在没有专属事件时说一句, 免得界面上出现两行说同一件事。
      const specific = new Set(['sql', 'request_scope', 'ask_user', 'describe_table', 'run_workflow', 'list_workflows', 'finish', 'reply']);
      if (!specific.has(ev.name)) {
        emit({ type: 'phase', phase: 'tool', message: `调用 ${ev.name}` });
      }
      return;
    }
    // tool_result / retry 之类的不往界面上摆: 过程噪音, 用户要的是结论
  }

  /**
   * 意图闸门: 在碰数据库之前先问一次"这是在跟你说话, 还是让你干活, 还是照卡办事"。
   *
   * 为什么要单起一次调用:
   *   不先判就没法知道该不该读表, 而"读表"一旦发生, 界面上就会冒出
   *   "正在读取可访问的表 / 加载了 N 张表"这一串取数步骤。用户问一句闲聊
   *   却看见智能体在翻数据库, 观感是错的。所以顺序必须是先判意图、再决定碰不碰库。
   *
   * 三分类合成一次调用, 所以闲聊与取数这两条老路径的往返次数没变。
   *
   * 这一路不挂工具 —— 闸门只要一个判断, 给它工具反而会诱导它去申请表范围。
   *
   * 历史**压成一条 user 消息**再喂 (Gate.gateInput), 不按 user/assistant 交替喂。
   * 交替喂的话闸门会把自己当成对话的下一棒, 学历史里 assistant 的口气写散文,
   * 而不是输出 JSON —— 实测 6/6 解析失败, 然后 fallback 到 analysis 去扫表。
   *
   * 兜底原则: 判不出来、格式不对、调用失败, 一律当成"分析型取数"。
   *   多走一遍取数流程只是慢一点; 把真正的取数需求当闲聊回掉, 是功能故障。
   *
   * @returns {kind:'chat'|'analysis'|'engine'|'route', ...}
   */
  async _classifyIntent(task, history) {
    const system = Gate.buildGatePrompt(this.promptConfig, this.engines);
    const opts = { maxTokens: Gate.INTENT_MAX_TOKENS, temperature: 0 };

    // 闸门的用量记在这儿, 由 run() 收走。
    //
    // 它是**每一次提问都会发生**的一次调用 —— 包括判成闲聊的那些。不记的话
    // 界面上的"这次花了多少"会稳定偏低, 而且偏低得最厉害的场景恰恰是
    // "用户连问十句闲聊": 十次闸门调用一个都不算。
    this._gateUsage = null;
    const takeGate = (out) => {
      if (out && out.usage) this._gateUsage = LlmUsage.addUsage(this._gateUsage, out.usage);
    };

    try {
      const out = await this.llm.chatStep(
        [{ role: 'system', content: system }, { role: 'user', content: Gate.gateInput(task, history) }],
        [], opts
      );
      takeGate(out);
      const parsed = Gate.parseRoute(out && out.content, this.engines);
      if (parsed) return parsed;

      // 认不出就**再问一次**, 这次把历史整个拿掉。
      //
      // 只留光秃秃的一句话, 是刻意换一种输入: 刚才那次没吐出 JSON, 多半是被
      // 历史里的对话结构带偏了 (模型在学历史里 assistant 的散文口气)。
      // 去掉历史它就没有可模仿的对象。实测这一手能把"你好"这类从 5/6 提到 6/6。
      //
      // 代价是这一句的上下文变薄 —— 但闸门认不出时本来就要退回 analysis,
      // 那更糟: 用户问一句"你会干啥"却看见它在翻数据库。
      const retry = await this.llm.chatStep(
        [{ role: 'system', content: system }, { role: 'user', content: task }],
        [], opts
      );
      takeGate(retry);
      return Gate.parseRoute(retry && retry.content, this.engines) || { kind: 'analysis' };
    } catch (e) {
      // 网关抖一下不该把整轮判死, 退回"干活"这条稳妥的路
      return { kind: 'analysis' };
    }
  }

  /**
   * 处理一条斜杠指令。
   *
   * @returns 一个结果对象 (直接收尾) 或 null (/sql: 落下去当分析处理, 跳过闸门)
   */
  async _handleSlash(cmd, ctx) {
    const { emit, carry, timing } = ctx;
    const reply = (text) => { emit({ type: 'reply', text }); return this._replyResult(text, Object.assign({}, carry, timing())); };

    // 用户已经点了停止 —— 别再往下做任何事
    if (ctx.cancel && ctx.cancel.v) throw new Error('用户取消');

    if (cmd.name === 'help') return reply(slashHelpText());
    // 认不出/没给参数的命令: 当成"指令写错了"回一句, **不**当普通任务发出去
    if (!SLASH_COMMANDS.some((c) => c.name === cmd.name)) {
      return reply(`没有「/${cmd.name}」这条指令。输入 / 或 /help 看有哪些。`);
    }
    if (cmd.name === 'sql') {
      if (!cmd.arg) return reply('用法: /sql <你要查什么>, 例如 /sql 近30天各供应商采购金额。');
      return null;   // /sql: 落到分析路径 (verdict 由调用方设成 analysis, 跳过闸门)
    }
    if (cmd.name === 'chat') {
      if (!cmd.arg) return reply('用法: /chat <想说/想问的话>。');
      return await this._slashChat(cmd.arg, ctx);
    }
    if (cmd.name === 'card') return await this._slashCard(cmd.arg, ctx);
    return null;
  }

  /** /chat: 一次纯对话, **不碰数据库** */
  async _slashChat(text, ctx) {
    const { emit, carry, timing } = ctx;
    const msgs = [{ role: 'system', content: '你是 Askaha, 一个数据库分析智能体。用户在跟你说话 (不是让你取数), 直接回答。' }];
    for (const h of (carry.history || [])) {
      if (h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string' && h.content.trim()) {
        msgs.push({ role: h.role, content: h.content });
      }
    }
    msgs.push({ role: 'user', content: text });
    let replyText = '';
    let usage = null;
    try {
      const out = await this.llm.chatStep(msgs, [], { temperature: 0.3 });
      replyText = (out && out.content) || '';
      usage = (out && out.usage) || null;
    } catch (e) {
      // 取消不是"答不上来"—— 如实抛出去, 由上层显示"已停止"
      if (ctx.cancel && ctx.cancel.v) throw new Error('用户取消');
      replyText = '（这次没答上来: ' + ((e && e.message) || e) + '）';
    }
    emit({ type: 'reply', text: replyText });
    const t = timing();
    return this._replyResult(replyText, Object.assign({}, carry, {
      usage: usage ? { input: usage.input || 0, output: usage.output || 0, calls: 1 } : t.usage,
      ctx: usage && usage.input ? usage.input : t.ctx,
      elapsedMs: t.elapsedMs
    }));
  }

  /**
   * /card: 跑一张流程卡。
   * 先按**卡名/id 精确认** (便宜且准); 认不出就把这段当成**需求描述**,
   * 交给闸门在卡目录里挑一张 (和"不写指令时闸门判 engine/route"是同一套)。
   */
  async _slashCard(arg, ctx) {
    const { emit, carry, timing } = ctx;
    const list = (this.engines || []).filter((e) => e && e.enabled !== false && e.id);
    const reply = (text) => { emit({ type: 'reply', text }); return this._replyResult(text, Object.assign({}, carry, timing())); };
    const cardListText = () => '可用的卡:\n' + list.map((e) => `- ${e.name || '未命名'}（id: ${e.id}）`).join('\n');
    if (!list.length) return reply('这台机器上还没有搭好的流程卡。去「配置 · 流程引擎」搭一张先。');

    // 1) 卡名 / id 精确认 —— 命中就把剩下的字当输入
    const resolved = this._resolveCard(arg, list);
    if (resolved.engine) {
      emit({ type: 'phase', phase: 'engine', message: `命中流程卡「${resolved.engine.name}」` });
      return await this._runEngine(resolved.engine.id, resolved.rest, emit, carry);
    }
    if (!arg) return reply('用法: /card <需求或卡名> [输入]。' + cardListText());

    // 2) 当成需求描述, 让闸门在卡目录里挑一张
    const match = await this._classifyIntent(arg, carry.history || []);
    if (ctx.cancel && ctx.cancel.v) throw new Error('用户取消');
    if (match.kind === 'engine') {
      const card = this._engineById(match.engineId);
      emit({ type: 'phase', phase: 'engine', message: `按需求命中流程卡「${card ? card.name : match.engineId}」` });
      return await this._runEngine(match.engineId, arg, emit, carry);
    }
    if (match.kind === 'route') {
      const ids = (match.candidates || []).slice(0, Gate.CHOOSE_AT);
      const next = { phase: 'choose', candidates: ids, round: 0, original: arg, qa: [] };
      return this._chooseRoute(next, ids, emit, carry);
    }
    // 3) 一条都对不上 —— 列卡, 让用户点或换个说法
    return reply('没找到对得上的流程卡。把需求说具体点, 或者从这些里点一张:\n' +
      list.map((e) => `- ${e.name || '未命名'}（id: ${e.id}）`).join('\n'));
  }

  /**
   * 把 /card 后面的那串解析成"哪张卡 + 其余输入"。
   * 顺序: 整段是 id -> 卡名做前缀(取最长) -> 首段是 id。都不中返回 engine:null。
   */
  _resolveCard(arg, list) {
    const a = String(arg == null ? '' : arg).trim();
    if (!a) return { engine: null, rest: '' };
    let e = list.find((x) => x.id === a);
    if (e) return { engine: e, rest: '' };
    let best = null;
    for (const x of list) {
      const nm = String(x.name || '').trim();
      if (!nm) continue;
      if (a === nm || a.startsWith(nm + ' ')) {
        if (!best || nm.length > best.nm.length) best = { engine: x, nm };
      }
    }
    if (best) return { engine: best.engine, rest: a.slice(best.nm.length).trim() };
    const first = a.split(/\s+/)[0];
    e = list.find((x) => x.id === first);
    if (e) return { engine: e, rest: a.slice(first.length).trim() };
    return { engine: null, rest: a };
  }

  /**
   * 调研一轮: 把候选收窄, 或者决定该让人自己选。
   * 模型只负责淘汰候选与出问题; 什么时候停由 Gate.routeStep 里的代码定。
   */
  async _routeStep(route, answer) {
    return Gate.routeStep({
      ask: async (messages) => {
        const out = await this.llm.chatStep(messages, [], {
          maxTokens: Gate.INTENT_MAX_TOKENS,
          temperature: 0
        });
        return out && out.content;
      },
      route,
      allEngines: this.engines,
      answer
    });
  }

  /** 只回一句话 / 只弹一个选择层时的返回形状: 不出报告、不归档, 会话状态原样带回。 */
  _replyResult(text, src) {
    const s = src || {};
    return {
      reply: text,
      summary: text,
      title: '',
      insights: [],
      steps: [],
      html: null,
      md: null,
      xlsxBase64: null,
      xlsxError: null,
      chartWarnings: [],
      output: 'none',
      // 闲聊那条路也要交代花了多少 —— 闸门本身是一次真调用, 而且判成闲聊时
      // 用户更容易觉得"它什么都没干", 更该让这个数字可见。
      usage: s.usage || null,
      ctx: Number.isFinite(s.ctx) && s.ctx > 0 ? s.ctx : null,
      elapsedMs: Number.isFinite(s.elapsedMs) ? s.elapsedMs : null,
      route: s.route || null,
      trace: Array.isArray(s.trace) ? s.trace : [],
      state: {
        tables: Array.isArray(s.tables) ? s.tables : [],
        schemaMap: s.schemaMap || {},
        fieldsSelected: s.fieldsSelected || {},
        steps: compactSteps(s.steps),
        report: (s.report && typeof s.report === 'object') ? s.report : null,
        route: s.route || null
      }
    };
  }

  /**
   * 把模型这一轮输出认成一个动作调用。
   *
   * 三条路, 依次尝试:
   *   1. 原生 tool_calls —— 走正规通道时的样子, 最可靠
   *   2. 正文里的 JSON 动作 —— 网关不支持 tools 时的降级路径
   *   3. 正文里漏出来的工具调用方言 (DSML) —— 模型没守规矩时的兜底
   * 三条都不成, 返回 null, 交给上层回灌自纠错。
   */
  _resolveCall(out) {
    const calls = Array.isArray(out.toolCalls) ? out.toolCalls : [];

    if (calls.length) {
      return {
        call: { id: calls[0].id, name: normalizeToolName(calls[0].name), args: calls[0].args },
        turn: {
          native: true,
          content: out.content,
          raw: out.content || '',
          toolCalls: calls,
          primaryId: calls[0].id
        }
      };
    }

    const json = this.llm._extractJSON(out.content);
    if (json && json.action) {
      const args = { ...json };
      delete args.action;
      return {
        call: { id: 'text_' + Date.now(), name: normalizeToolName(json.action), args },
        turn: { native: false, content: out.content, raw: out.content || '' }
      };
    }

    const dsml = parseDSML(out.content);
    if (dsml) {
      return {
        call: { id: 'dsml_' + Date.now(), name: normalizeToolName(dsml.name), args: dsml.args || {} },
        turn: { native: false, content: out.content, raw: out.content || '' }
      };
    }

    return null;
  }

  /**
   * 本次可访问的表: checked = 勾过的, resolved = 勾过且确实存在的。
   *
   * 优先问 database 自己 (多库路由器知道每张表在哪个库)。直接塞一个单库
   * Database 进来的场景 (桩/测试) 没有 inventory(), 就按老办法比对表清单。
   */
  async _inventory() {
    if (this.database && typeof this.database.inventory === 'function') {
      return this.database.inventory();
    }
    const checked = this.tableInventory.map((t) => ({ name: t.name, note: t.note || '', comment: t.comment || '' }));
    const existing = await this.database.listTables();
    return { checked, resolved: checked.filter((t) => existing.includes(t.name)) };
  }

  /** 把表名 + 说明拼成给模型看的清单。表在多个库里时带上是哪个库, 免得它拼跨库 SQL。 */
  _inventoryLines(names) {
    const notes = {};
    const dbs = {};
    for (const t of this.tableInventory) {
      // 说明 = 用户备注, 没写就用库里的注释 (见 tableDesc)
      notes[t.name] = tableDesc(t);
      if (t.dbName) dbs[t.name] = t.dbName;
    }
    return names.map((n) => `- ${n}${dbs[n] ? ` (库: ${dbs[n]})` : ''}: ${notes[n] || '(无说明)'}`);
  }

  /** 连不上的库, 一句话讲清楚 —— 给用户看, 也给模型看 */
  _offlineSummary() {
    const list = this.offlineDbs || [];
    if (!list.length) return '';
    const who = list.map((d) => d.dbName).join('、');
    return `有 ${list.length} 个库连不上: ${who}。`;
  }

  /**
   * 自动模式: AI 自己挑表, 不问用户。
   *
   * ## 为什么它依赖表备注
   *
   * 判据只有**表名 + 备注** (scoreTables 不读表结构)。表名通常看不出业务含义
   * (`t_ord_hdr`、`f_st`), 所以真正起作用的是备注。备注缺失或含糊时, AI 只能
   * 按表名猜 —— 猜错的表现是"查出来的数字看着正常但是错的", 比报错危险得多。
   * 界面上那句警告说的就是这件事, 这里则是它的实现。
   *
   * ## 挑不出来就退回去问
   *
   * 打分失败 (网关报错、返回不是 JSON、一张都对不上) 时**不硬挑**, 而是返回
   * null 让调用方走原来的弹窗。理由: 自动模式最坏的失败是"选错表却不说",
   * 而退回弹窗最坏只是"多问一句"。用一个任意挑选 (比如"白名单前 5 张") 顶上去
   * 是把不确定性藏进结果里, 那是拿用户的数字冒险。
   *
   * @returns {Promise<null|{tables, schemaMap, fieldsSelected, scored, noNote}>}
   */
  async autoScope(task, candidates, emit) {
    let match = { scored: [], picked: [], probes: null, uncertain: '', note: '', timing: {}, degraded: [] };
    try {
      emit({ type: 'phase', phase: 'score_tables', message: '自动模式: AI 正在挑选相关的表...' });
      match = await this._matchTables(task, candidates, emit);
    } catch (e) {
      match = { scored: [], picked: [], probes: null, uncertain: '', note: '', timing: {}, degraded: [String(e.message || e)] };
    }
    const picked = match.picked
      .map((n) => normalizeTableName(n, candidates))
      .filter((n, i, a) => n && a.indexOf(n) === i)
      // 封顶: 提示词里已经要它给"最少需要哪几张", 但模型会飘 —— 而"多带一张"
      // 的代价是 SQL 更容易连错表, 所以这里仍留一道硬上限 (不再有"只挑 1 张"那种偏向)。
      .slice(0, 8);
    if (!picked.length) return null;

    const schemaMap = {};
    for (const t of picked) {
      try {
        schemaMap[t] = await this.database.describeTable(t);
      } catch (e) {
        schemaMap[t] = [];
      }
    }

    const fieldsByTable = {};
    for (const t of picked) fieldsByTable[t] = (schemaMap[t] || []).map((c) => c.field).filter(Boolean);

    let aiFields = {};
    try {
      emit({ type: 'phase', phase: 'suggest_fields', message: 'AI 正在挑选相关字段...' });
      aiFields = await this.suggestFields(task, picked, fieldsByTable, schemaMap);
    } catch (e) { /* 预筛失败就全选 */ }

    const fieldsSelected = {};
    for (const t of picked) {
      const sel = (aiFields[t] || []).filter((c) => fieldsByTable[t].includes(c));
      fieldsSelected[t] = sel.length ? sel : fieldsByTable[t];
    }

    // 挑中的表里有多少张**没有说明** —— 这是"准确性风险"的量化。
    // 一句"依赖说明"是抽象的; "5 张里有 3 张没说明"才是用户能立刻去补的东西。
    // 说明 = 用户备注或库里的注释, 两者都没有才算"没说明"。
    const noteOf = {};
    for (const t of this.tableInventory) noteOf[t.name] = tableDesc(t);
    const noNote = picked.filter((t) => !noteOf[t]);

    return {
      tables: picked, schemaMap, fieldsSelected, scored: match.scored, noNote,
      probes: match.probes, uncertain: match.uncertain, note: match.note, degraded: match.degraded,
      untriedCols: match.untriedCols,
      // 耗时和 token 用量一路带到界面: 用户抱怨"慢"的时候, 得能一眼看出
      // 时间花在模型思考上还是花在探测上 —— 这两者的处置办法完全不同。
      timing: match.timing
    };
  }

  /**
   * 一次完整的选表匹配 (三级漏斗, 见 lib/table-match.js)。
   *
   * 同一轮里可能被问两次 (自动模式一次 + 模型自己 request_scope 一次),
   * 而每跑一次都要花一次模型调用和一轮探测 —— 所以按"任务原文"记一次结果。
   * 只记一条: 缓存不该变成"上次那题的答案", 那会把新的需求带偏。
   */
  async _matchTables(task, candidates, emit) {
    const key = `${task}||${candidates.length}`;
    if (this._matchCache && this._matchCache.key === key) return this._matchCache.value;
    const noteOf = {};
    for (const t of this.tableInventory) noteOf[t.name] = tableDesc(t);
    const value = await TableMatch.matchTables({
      llm: this.llm, router: this.database, task, candidates, noteOf,
      emit, opts: this.matchOpts || {}
    });
    this._matchCache = { key, value };
    return value;
  }

  /**
   * 用 LLM 给候选表打分 (弹"选表"窗口时给默认推荐)。
   *
   * 判据不再是"表名 + 一句备注", 而是:
   *   列注释 (库维护的口径) + 关键列清单 + **拿需求里的单号实测过的命中情况**。
   * 漏斗细节与取舍都在 lib/table-match.js; 这里只保留对外的老形状
   * ({name, score, reason}), 免得弹窗那一侧跟着改。
   */
  async scoreTables(task, candidates) {
    if (!this.llm.config.apiKey || !candidates.length) return [];
    const match = await this._matchTables(task, candidates, () => {});
    const valid = (match.scored || [])
      .map((s) => Object.assign({}, s, { name: normalizeTableName(s.name, candidates) }))
      .filter((s) => s && s.name);
    this._lastMatch = match;
    return valid.slice(0, 8);
  }

  /** 用 LLM 给每张已确认的表挑最相关的字段, 供弹窗给默认勾选 */
  async suggestFields(task, selectedTables, fieldsByTable, schemaMap) {
    if (!this.llm.config.apiKey || !selectedTables.length) return {};
    // 字段清单带上列注释: "这张表里哪个列装的是那个单号"这个问题,
    // 答案就写在注释里 (doc_num -- 付款单号), 不带注释等于让模型看列名猜。
    const lines = selectedTables.map((t) => {
      const cols = (schemaMap && schemaMap[t]) || [];
      const byField = new Map(cols.map((c) => [c.field, c]));
      const parts = (fieldsByTable[t] || []).map((f) => {
        const c = byField.get(f);
        const cmt = c && c.comment ? ` -- ${c.comment}` : '';
        return `${f}${cmt}`;
      });
      return `- ${t}: ${parts.join(', ')}`;
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
        '注意: 结果要"导出全字段""看明细"这类要求时, 相关的列一个都不要漏.',
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

  _engineById(id) {
    return this.engines.find((e) => e && e.id === id) || null;
  }

  /** 弹一句话 / 弹一个选择层, 并把"还在等回答"的状态带回会话, 重启后能接着问 */
  _askRoute(route, question, emit, carry, payload) {
    // 模型给的选项优先 —— 有选项就能点, 不用打字
    const options = (payload && payload.options) || (route && route.options) || [];
    const extra = options.length ? Object.assign({ options }, payload || {}) : payload;
    route.lastQuestion = question;
    if (extra) emit(Object.assign({ type: 'route_ask', question, route }, extra));
    else emit({ type: 'route_ask', question, route });
    return this._replyResult(question, Object.assign({}, carry, { route }));
  }

  /** 弹选择层: 让操作人从这几张卡里点一张 */
  _chooseRoute(route, engineIds, emit, carry) {
    const cards = engineIds.map((id) => this._engineById(id)).filter(Boolean).map(Gate.engineBrief);
    emit({ type: 'route_choose', candidates: cards, question: '这几张卡都对得上，你要查哪一个？' });
    return this._replyResult('这几张卡都对得上，你要查哪一个？', Object.assign({}, carry, { route }));
  }

  /**
   * 从用户那句话里把流程卡需要的输入抽出来。
   * 抽不出必填项不猜, 直接问用户 —— 猜错单号的代价是拿别人的数据当结论。
   */
  async _extractInputs(engine, task, history) {
    const node = (engine.nodes || []).find((n) => n.type === 'input');
    const fields = ((node && node.fields) || []).filter((f) => f.key);
    if (!fields.length) return { inputs: {}, fields };

    // 提示词要把"含义"和"任选其一"都讲清楚, 否则模型只能靠字段名猜。
    // 用户给的是一串 DN2024xxx 时, 它得知道这属于「送货单号」而不是「采购订单号」。
    const one = (f) => {
      const bits = [`- ${f.key} (${f.label || f.key})`];
      if (f.desc) bits.push(`说明: ${f.desc}`);
      return bits.join(' — ');
    };
    // 分组按出现顺序摆好, 组内用"任选其一"的措辞
    const groups = [];
    const plain = [];
    for (const f of fields) {
      if (!f.group) { plain.push(f); continue; }
      let g = groups.find((x) => x.name === f.group);
      if (!g) { g = { name: f.group, members: [] }; groups.push(g); }
      g.members.push(f);
    }

    const need = [];
    if (plain.length) need.push(...plain.map(one));
    for (const g of groups) {
      need.push(`- 【任选其一】${g.name} —— 以下几项里用户通常只会给一个, 给一个就够:`);
      need.push(...g.members.map((f) => '  ' + one(f)));
    }

    const messages = [
      {
        role: 'system',
        content: [
          '从用户的话里把这张流程卡需要的输入项抽出来。',
          '',
          '需要的输入项:',
          ...need,
          '',
          '只输出一个 JSON 对象, 不要有其它文字, 不要用代码块:',
          '{"inputs": {"<输入项名>": "值"}, "matched": [{"key": "<输入项名>", "why": "你凭什么认为用户给的是这一项"}]}',
          '',
          '注意:',
          '- 用户没给的项就不要写进 inputs。不要编, 不要拿示例值凑数。',
          '- 【任选其一】的组里, 只要有一个项有值, 这一组就算齐了, 不要为了凑齐而把同一个值填进多项。',
          '- 如果用户给的值你不确定属于哪一项 (比如三个单号格式很像), 挑最像的那一项,',
          '  并在 matched 的 why 里说清你为什么这么判断 —— 拿不准就明说"不确定, 可能是 X 也可能是 Y"。',
          '- 值要原样抄用户给的, 不要改写、不要补前缀、不要去掉引号。'
        ].join('\n')
      }
    ];
    for (const h of (history || []).slice(-this.historyTurns)) {
      if (h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string' && h.content.trim()) {
        messages.push({ role: h.role, content: h.content });
      }
    }
    messages.push({ role: 'user', content: String(task || '') });

    let got = null;
    try {
      const out = await this.llm.chatStep(messages, [], { maxTokens: 1024, temperature: 0 });
      got = Gate.extractJSON(out && out.content);
    } catch (e) {
      got = null;
    }

    // 兼容两种形状: 新的 {inputs, matched} 和旧的直接 {"<key>": "值"}。
    // 老提示词/老缓存里存的是旧形状, 不能因为换了格式就整段丢掉。
    let raw = {};
    let matched = [];
    if (got && typeof got === 'object') {
      if (got.inputs && typeof got.inputs === 'object') {
        raw = got.inputs;
        matched = Array.isArray(got.matched) ? got.matched : [];
      } else {
        raw = got;
      }
    }

    const inputs = {};
    for (const f of fields) {
      const v = raw[f.key];
      if (v === undefined || v === null) continue;
      const s = String(v).trim();
      if (s) inputs[f.key] = s;
    }

    // ---- 一个值里塞了好几个单号? 拆开 ----
    //
    // 卡的契约是"一个输入项 = 一个值", 取数 SQL 拿它做单值比较 (WHERE no = {{x}})。
    // 但用户很自然地一次给 3 个单号, 而抽取那一步 (上面 chatStep) 是个通用提示词,
    // 不知道卡的这一层约束, 实测会把三个值拼成 'a,b,c' 塞进同一个 key ——
    // 引擎又只拦"空值"不拦"一个值里塞了多个", 结果渲染成 WHERE no = 'a,b,c',
    // 查不到任何行, 结论却是"查无数据"。
    //
    // 这层必须在**代码**里兜: 不靠提示词赌模型自觉。识别出"多个同形单号"就拆成数组,
    // 交给 _runEngine 去逐个各跑一遍 (见 splitMultiValues 的注释, 保守: 拿不准就不拆)。
    const multi = {};
    for (const f of fields) {
      const s = inputs[f.key];
      if (!s) continue;
      const parts = splitMultiValues(s);
      if (parts.length > 1) { inputs[f.key] = parts[0]; multi[f.key] = parts; }
    }

    // 只保留真的落到 inputs 里的那些说明, 免得界面上显示"AI 认为是送货单号"但值没填上
    const why = matched
      .filter((m) => m && m.key && inputs[m.key])
      .map((m) => ({ key: m.key, why: String(m.why || '').slice(0, 300) }));

    return { inputs, fields, matched: why, multi };
  }

  /** 照着一张流程卡跑到底。路线是卡上写死的, 中途不弹 SQL 确认。 */
  async _runEngine(engineId, task, emit, carry) {
    const engine = this._engineById(engineId);
    if (!engine) {
      const text = '没找到那张流程卡，可能已经被删掉了。';
      emit({ type: 'reply', text });
      return this._replyResult(text, carry);
    }

    emit({ type: 'phase', phase: 'engine', message: `命中流程卡「${engine.name}」，正在准备输入...` });
    const hist = (carry && carry.history) || [];
    const { inputs, fields, matched, multi } = await this._extractInputs(engine, task, hist);

    // 用引擎那套判定, 不在这里另写一遍 —— 任选其一的组里给了一个就不算缺
    const chk = Engine.checkInputs(fields, inputs);
    if (!chk.ok) {
      const route = {
        phase: 'inputs',
        engineId,
        candidates: [engineId],
        round: 0,
        original: task,
        inputs,
        qa: []
      };
      return this._askRoute(
        route,
        `要跑「${engine.name}」，还差：${chk.missingLabels}，给我一下？`,
        emit,
        carry,
        { missing: chk.missing, missingGroups: chk.missingGroups }
      );
    }

    // AI 自己判断了"你给的是哪一项"时, 把它的判断说出来。
    // 三个入口格式接近的场合, 用户需要知道它认成了哪个, 否则查不到数时无从判断是给错了还是没数据。
    if (matched && matched.length) {
      const names = {};
      for (const f of fields || []) names[f.key] = f.label || f.key;
      const said = matched
        .filter((m) => m.why)
        .map((m) => `「${names[m.key] || m.key}」${m.why}`)
        .join('；');
      if (said) emit({ type: 'phase', phase: 'engine', message: `我把你给的当成了：${said}` });
    }

    // ---- 一个输入项里拆出了多个单号 → 每个单号各跑一遍, 结果合并 ----
    //
    // 卡是"一次一个值"的 (取数 SQL 拿它单值比较), 但用户一次给几个单号是最常见的用法。
    // 以前这会被拼成一个 'a,b,c' 塞进占位符, WHERE no = 'a,b,c' 查不到任何行。
    // 这里用现成的批量执行器 (共享连接 / 逐单容错 / 按输入顺序回) 逐个各跑一遍,
    // 一张卡都不用改。
    const multiKeys = Object.keys(multi || {});
    if (multiKeys.length) {
      const key = multiKeys[0];
      const values = multi[key];
      const label = ((fields || []).find((f) => f.key === key) || {}).label || key;
      const sets = values.map((v) => Object.assign({}, inputs, { [key]: v }));
      emit({
        type: 'phase', phase: 'engine',
        message: `你给的是 ${values.length} 个「${label}」，这张卡一次查一个，我分开各跑一遍`
      });
      return await this._execEngineBatch(engine, key, sets, emit, carry);
    }

    return await this._execEngine(engine, inputs, emit, carry);
  }

  /**
   * 一张卡 + 多组输入 (同一个 key 拆出来的多个单号), 逐单各跑一遍再合并。
   *
   * 复用 testEngineBatch: 共享连接 (第一单跑完不会把整批共用的连接关掉)、
   * 一轮失败不拖死整批、结果按输入顺序回 —— 这几件事自己另写一遍很容易做错。
   *
   * 与测试面板不同的是: 这里把过程事件实时接到对话界面上 (testEngineBatch 的 onEvent
   * 会把 engine_start/phase/query_result 按"第几单"带出来), 让用户看见每一单的走向。
   */
  async _execEngineBatch(engine, key, sets, emit, carry) {
    const events = [];
    const r = await Engine.testEngineBatch(
      engine,
      sets,
      this.databases,
      this.openDb,
      {
        sampleRows: 20,
        concurrency: 4,
        onEvent: (ev) => {
          events.push(ev);
          // 只把"跑的过程"转发到界面; engine_batch_* 这种批量控制事件由界面单独画
          if (ev.type === 'engine_batch_wave') {
            emit({ type: 'engine_batch_progress', engineId: engine.id, engineName: engine.name, from: ev.from, count: ev.count, total: ev.total });
            return;
          }
          if (ev.type === 'engine_batch_item') return; // 逐单结果在最后的汇总里给
          // 单轮内部的事件 (engine_start/phase/query_result/output/error) 都转出去,
          // 并标上是第几单, 免得 3 单的"正在取数"在界面上分不清谁是谁
          const idx = ev && ev.__index;
          emit(Object.assign({ engineId: engine.id, engineName: engine.name, batchIndex: idx }, ev));
        }
      }
    );

    // ---- 汇总成一段能直接当结论读的文字 ----
    const inputNode = (engine.nodes || []).find((n) => n.type === 'input');
    const names = {};
    for (const f of ((inputNode && inputNode.fields) || [])) names[f.key] = f.label || f.key;
    const label = names[key] || key;
    const lines = [`一共 ${r.total} 个「${label}」，逐单查的结果：`];
    for (const run of r.runs) {
      const v = run.inputs && run.inputs[key];
      const head = `\n【${v}】`;
      if (!run.ok) {
        lines.push(`${head} 这一单没跑成：${run.error || '未知错误'}`);
        continue;
      }
      const ans = String(run.answer || '').trim();
      lines.push(head + (ans ? '\n' + ans : ' （这一单没有产出结论）'));
    }
    if (r.buckets && r.buckets.length > 1) {
      lines.push('\n归堆看：');
      for (const b of r.buckets) {
        const vs = (b.inputs || []).map((x) => x && x[key]).filter(Boolean).join('、');
        lines.push(`· ${b.title || '(无输出)'} —— ${b.count} 单：${vs}`);
      }
    }
    const answer = lines.join('\n');
    const batchAnswer = r.failCount
      ? `「${engine.name}」有 ${r.failCount} 单没跑成（多半是连不上库），结果不全：\n\n${answer}`
      : answer;

    emit({ type: 'reply', text: batchAnswer, keepSteps: true });
    const allSteps = r.runs.flatMap((run) => (run.steps || []).map((s) => ({
      kind: 'engine', title: `【${run.inputs && run.inputs[key]}】${s.title}`,
      purpose: s.condition || '', sql: s.sql || '', result: { rowCount: s.rowCount }
    })));
    return {
      reply: batchAnswer,
      summary: batchAnswer,
      title: engine.name,
      insights: [],
      steps: allSteps,
      html: null, md: null, xlsxBase64: null, xlsxError: null, chartWarnings: [],
      output: 'engine',
      engine: {
        id: engine.id, name: engine.name, batch: true, batchKey: key,
        runs: r.runs.map((run) => ({ inputs: run.inputs, ok: run.ok, answer: run.answer, error: run.error })),
        buckets: r.buckets,
        answer: batchAnswer,
        error: r.failCount ? `${r.failCount} 单没跑成` : null
      },
      route: null,
      state: {
        tables: carry.tables || [],
        schemaMap: carry.schemaMap || {},
        fieldsSelected: carry.fieldsSelected || {},
        steps: compactSteps(carry.steps),
        report: (carry.report && typeof carry.report === 'object') ? carry.report : null,
        route: null
      }
    };
  }

  /** 真正把卡跑起来, 并把卡里的每一步实时送到界面 */
  async _execEngine(engine, inputs, emit, carry) {
    // engine_start 由执行器自己发, 这里不重复发, 免得界面上多一行
    const runner = new Engine.EngineRunner({
      engine,
      databases: this.databases,
      openDb: this.openDb
    });

    let res;
    try {
      res = await runner.run(inputs, (ev) => emit(Object.assign({ engineId: engine.id, engineName: engine.name }, ev)));
    } catch (err) {
      const text = `跑「${engine.name}」的时候断了：${(err && err.message) || err}`;
      emit({ type: 'reply', text });
      return this._replyResult(text, carry);
    } finally {
      // 兜底: run() 中途抛出时它自己那句 closeAll 不会执行, 连接会一直挂着
      await runner.closeAll();
    }

    const rawAnswer = res.answer || `「${engine.name}」跑完了，但没有配置出口结论。`;
    // 卡中途断了 (库连不上 / SQL 报错) 时, 不能把"断了"埋在一堆执行步骤中间 ——
    // 用户看到的最终结论却是"跑完了"。把失败提到结论最前面, 原因一目了然。
    const answer = res.error
      ? `「${engine.name}」没跑完：${res.error}\n\n${rawAnswer}`
      : rawAnswer;
    // keepSteps: 这条 reply 是流程卡跑完后的结论, 前面已经攒了一路的执行步骤,
    // 不能像闲聊那样把步骤清掉 —— 用户要看的正是"它到底干了什么"。
    emit({ type: 'reply', text: answer, keepSteps: true });
    return {
      reply: answer,
      summary: answer,
      title: engine.name,
      insights: [],
      steps: res.steps.map((s) => ({ kind: 'engine', title: s.title, purpose: s.condition || '', sql: s.sql || '', result: { rowCount: s.rowCount } })),
      html: null,
      md: null,
      xlsxBase64: null,
      xlsxError: null,
      chartWarnings: [],
      output: 'engine',
      engine: {
        id: engine.id,
        name: engine.name,
        inputs,
        steps: res.steps,
        answer,
        error: res.error || null
      },
      route: null,
      state: {
        tables: carry.tables || [],
        schemaMap: carry.schemaMap || {},
        fieldsSelected: carry.fieldsSelected || {},
        steps: compactSteps(carry.steps),
        report: (carry.report && typeof carry.report === 'object') ? carry.report : null,
        route: null
      }
    };
  }

  /**
   * 接着上一轮的路由状态往下走。
   *
   * 上一轮停在"等用户确认 / 等用户补充输入 / 正在调研", 这一轮用户说的话就是那句回答。
   */
  /**
   * 用户是不是"不想接着跑这张卡了" (或者根本不是来补输入的)。
   * 两种信号, 都只认**短句** —— 长了就别猜, 免得把正常回答误判成放弃:
   *   1) 取消词: 算了 / 取消 / 不查了 ...
   *   2) 明显在**问问题**而不是给值: 句尾问号, 或含 怎么/为什么/如何/解答/是什么 ...
   *      但句子里要是已经有**像单号的值** (4 位以上字母数字), 就当它是输入, 不放弃。
   */
  _isRouteCancel(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    if (t.length <= 16 && /(取消|算了|不用了|不查了|不问了|换个|退回|别查|不跑|不查卡)/.test(t)) return true;
    const hasValue = /[A-Za-z0-9]{4,}/.test(t);
    if (!hasValue && (/[?？]$/.test(t) || /(怎么|为什么|为何|如何|是什么|什么意思|解答|解释一下|说明一下)/.test(t))) return true;
    return false;
  }

  async _continueRoute(route, answer, emit, carry) {
    const card = route.engineId ? this._engineById(route.engineId) : null;

    // 用户明说"算了/取消" → 放弃这张卡 (返回 null, 由 run() 掉回正常流程)
    if (this._isRouteCancel(answer)) return null;

    // ---- 等确认: 用户点了个头就跑 ----
    if (route.phase === 'confirm') {
      const yes = await this._judgeAffirm(answer);
      if (yes) return await this._runEngine(route.engineId, route.original || answer, emit, carry);
      // 说不像 —— 把原来那些候选摊开, 让操作人自己挑
      const rest = (route.candidates || []).filter((id) => id !== route.engineId);
      const ids = rest.length ? rest : this.engines.filter((e) => e.enabled !== false).map((e) => e.id);
      const next = { phase: 'choose', candidates: ids.slice(0, Gate.CHOOSE_AT), round: 0, original: route.original, qa: [] };
      return this._chooseRoute(next, next.candidates, emit, carry);
    }

    // ---- 等补充输入: 把这一句并回原话, 重新抽一次 ----
    if (route.phase === 'inputs') {
      const merged = [route.original, answer].filter(Boolean).join(' ');
      const eng = this._engineById(route.engineId);
      if (!eng) return this._replyResult('那张流程卡不在了。', carry);
      emit({ type: 'phase', phase: 'engine', message: `正在准备输入...` });
      const { inputs, fields } = await this._extractInputs(eng, merged, []);
      const chk = Engine.checkInputs(fields, inputs);
      if (chk.ok) return await this._execEngine(eng, inputs, emit, carry);

      // 又没抽到。**连着两次都抽不到, 就别再问了** —— 用户多半不是在给输入, 是换了个问题。
      // 以前这里会无限重复同一句"还差：X，给我一下？", 用户怎么答都出不去。
      const round = (route.round || 0) + 1;
      if (round >= 2) return null;   // 放弃 → run() 掉回正常流程 (闸门会重判, 大概率走知识库)
      const next = Object.assign({}, route, { inputs, round });
      return this._askRoute(
        next,
        `还差：${chk.missingLabels}，给我一下？`,
        emit,
        carry,
        { missing: chk.missing, missingGroups: chk.missingGroups }
      );
    }

    // ---- 等选卡: 用户点了哪张就跑哪张 ----
    if (route.phase === 'choose') {
      const pickId = this._pickFrom(answer, route.candidates);
      if (pickId) return await this._runEngine(pickId, route.original || answer, emit, carry);
      // 没听出选的是哪张 —— 再弹一次, 别把话咽了
      return this._chooseRoute(route, route.candidates, emit, carry);
    }

    // ---- 调研中: 收窄一轮 ----
    emit({ type: 'phase', phase: 'engine', message: '正在确认你要查哪一张流程卡...' });
    const step = await this._routeStep(route, answer);

    if (step.action === 'run') {
      return await this._runEngine(step.engineId, route.original || answer, emit, carry);
    }
    if (step.action === 'choose') {
      const next = Object.assign({}, route, { phase: 'choose', candidates: step.engineIds, qa: step.qa || route.qa });
      return this._chooseRoute(next, step.engineIds, emit, carry);
    }
    const next = Object.assign({}, route, {
      phase: 'probe',
      candidates: step.candidates,
      round: step.round != null ? step.round : (route.round || 0) + 1,
      qa: step.qa || route.qa,
      lastQuestion: step.question
    });
    return this._askRoute(next, step.question, emit, carry);
  }

  /** 用户点的是哪张卡: 先认 id, 再认名字 */
  _pickFrom(answer, candidateIds) {
    const raw = String(answer || '').trim();
    if (!raw) return null;
    if (candidateIds && candidateIds.includes(raw)) return raw;
    for (const id of candidateIds || []) {
      const card = this._engineById(id);
      if (card && card.name && raw.includes(card.name)) return id;
    }
    return null;
  }

  /** "对/是/没错" 与 "不对/不是" 这种一句话的判定 */
  async _judgeAffirm(answer) {
    const raw = String(answer || '').trim();
    if (/^(对|是|是的|对的对的|没错|是的呀|yes|y|ok|好|好的|嗯|确认|是的没错)/i.test(raw) && !/^(不|否|no)/i.test(raw)) return true;
    if (/^(不|不对|不是|否|no|nope|错了)/i.test(raw)) return false;
    try {
      const out = await this.llm.chatStep([
        {
          role: 'system',
          content: '用户被问"是不是要做这件事"。只输出 true 或 false, 不要有其它文字。'
        },
        { role: 'user', content: raw }
      ], [], { maxTokens: 16, temperature: 0 });
      return /true/i.test((out && out.content) || '');
    } catch (e) {
      // 判不出来就当"是" —— 用户已经看到卡名了, 否认的话通常会说"不对"
      return true;
    }
  }

  /**
   * 跑一轮。
   * @param task    用户这次说的话
   * @param opts    { history, state, pickEngineId }。state 是上一次返回的会话状态, 首轮传 null。
   */
  async run(task, opts, onEvent, onCheckpoint) {
    // 兼容老签名 run(task, history, onEvent, onCheckpoint)
    const options = Array.isArray(opts) ? { history: opts } : (opts || {});
    const history = Array.isArray(options.history) ? options.history : [];
    const prior = options.state && typeof options.state === 'object' ? options.state : {};
    // 人工终止令牌 (可选)。传给工具循环 (每轮检查), 并在几个卡点检查。
    const cancel = options.cancel || null;

    const events = [];
    const emit = (e) => { events.push(e); if (onEvent) onEvent(e); };
    emit({ type: 'start', task });

    // 每轮开头清掉上一轮的流程卡提示。不清的话: 上一轮判成 route 留下了提示,
    // 这一轮判成 chat/engine 会**提前 return**, 那个提示就留在了实例上,
    // 下一轮走到分析路径时会被当成"这轮也有候选", 影响 scope 判定。
    this._workflowHint = '';
    // 闸门给的"这轮可能要查知识库"软提示, 同一套路, 每轮先清。
    this._ragHint = false;
    // 本轮 RAG 命中记录 (给对话页"参考结果" + 问答飞轮)。每轮清空。
    this._ragHits = [];
    // 本轮要检索的知识库 (对话页可以多选)。空 = 用配置里的默认库 (或全部)。
    this._kbIds = Array.isArray(options.kbIds) ? options.kbIds.filter(Boolean) : (options.kbId ? [options.kbId] : []);
    // 本轮"执行轨迹": 闸门判定 / 读表 / 检索知识库 / SQL 步 / 收尾。
    // 问答管理"查看"里画的就是它 —— 所以**决策依据**也要记下来 (为什么去查 RAG)。
    this._trace = [];
    // 纯知识路径标记 (闸门说不用查库时置真)。每轮先清。
    this._knowledgeOnly = false;

    // API Key 是任何一次调用(包括下面的闸门)的前提, 先挡住
    if (!this.llm.config.apiKey) throw new Error('未配置 LLM API Key');
    if (cancel && cancel.v) throw new Error('用户取消');

    const ask = onCheckpoint || (async () => ({}));

    // ---------- 0. 意图闸门: 先判"在跟你说话"还是"让你干活", 这一步不碰数据库 ----------
    // 顺序很要紧。反过来先读表的话, 用户问一句"今天天气咋样", 界面上会先冒出
    // "正在读取可访问的表 / 加载了 N 张表"才等到回答 —— 那是取数任务的步骤,
    // 不该出现在闲聊里。所以先判意图, 判成闲聊就地收尾。
    const gateHistory = [];
    for (const h of history.slice(-this.historyTurns)) {
      if (!h || (h.role !== 'user' && h.role !== 'assistant')) continue;
      if (typeof h.content !== 'string' || !h.content.trim()) continue;
      gateHistory.push({ role: h.role, content: h.content });
    }

    const carry = {
      tables: prior.tables,
      schemaMap: prior.schemaMap,
      fieldsSelected: prior.fieldsSelected,
      steps: prior.steps,
      report: prior.report,
      history: gateHistory
    };
    const priorRoute = prior.route && prior.route.phase ? prior.route : null;

    // 本次任务的累计用量和耗时。
    //
    // 放在这里 (而不是循环前面) 是因为**闲聊那条路也要用** —— 闸门本身是一次
    // 模型调用, 判成闲聊就地收尾时它已经花掉 token 了。声明在循环前面的话,
    // "闲聊"这个最常见的出口就没有用量, 界面上会显示成 0。
    //
    // 跨续轮累加: 只看最后一轮的话, 界面上的"这次花了多少"会比真实账单少一大截,
    // 而那恰好是用户最在意的时候 (跑了很多轮、花了钱)。
    const taskUsage = { input: 0, output: 0, calls: 0 };
    // 上下文占用 (最近一次调用的输入 token)。和 taskUsage 分开记:
    // 一个是"一共花了多少", 一个是"此刻提示词有多大"。见 agent-loop.js 的注释。
    let taskCtx = 0;
    const taskStart = Date.now();
    const timing = () => ({ usage: { ...taskUsage }, ctx: taskCtx || null, elapsedMs: Date.now() - taskStart });

    // ---------- 0.5 斜杠指令: 显式意图, 跳过闸门 ----------
    //
    // 用户知道要干什么时直接点名 —— 省掉闸门那一次模型往返, 也没有误判。
    // 检测放在 priorRoute **之前**: 显式指令要能覆盖上一轮还挂着的多轮路由。
    const slash = parseSlash(task);
    if (slash) {
      const handled = await this._handleSlash(slash, { emit, carry, timing, cancel });
      if (handled) return handled;
      // /sql 不返回 —— 落下去当分析处理 (verdict 设成 analysis, 跳过闸门)
    }

    // 上一轮还在"确认 / 调研"里, 这一句就是那句回答 —— 不再重跑闸门,
    // 否则用户答一句"采购模块", 闸门会把它当成一个全新的需求重判一遍。
    let routeAbandoned = false;
    if (!slash && priorRoute) {
      // 界面上点了某一选 项, 直接跑, 不用再让模型从文字里猜
      if (options.pickEngineId && this._engineById(options.pickEngineId)) {
        return await this._runEngine(options.pickEngineId, priorRoute.original || task || '', emit, carry);
      }
      const cont = await this._continueRoute(priorRoute, task, emit, carry);
      // null = 用户显然不是要接着跑这张卡 (说了取消 / 连着两次给的都不是要的输入)
      // → 放弃路由, 掉下去走正常流程 (闸门重判这一句)。
      if (cont !== null) return cont;
      routeAbandoned = true;
      emit({ type: 'phase', phase: 'engine', message: '看着你不是要查这张卡了，我按你的新问题来' });
      this._trace.push({ kind: 'gate', title: '放弃流程卡', detail: '用户不是在补输入 (取消 / 换问题) → 按新问题重判' });
    }

    // 这一步不发 phase 步骤 —— 判成闲聊时整轮不该留下任何"执行过程",
    // 判成干活时也不需要多一行噪声。等待期的提示由 assistant 正文占位承担。
    // /sql 是显式"要取数", 直接当 analysis, 不再花一次调用去判。
    let verdict = slash ? { kind: 'analysis' } : await this._classifyIntent(task, gateHistory);
    // 刚放弃了流程卡: 别再让这一句立刻又命中同一张卡 (否则用户还是出不去)。
    // 按"用户是在问一个问题"处理 → 走分析路径; 知识库需要与否沿用闸门的提示。
    if (routeAbandoned && (verdict.kind === 'engine' || verdict.kind === 'route')) {
      verdict = { kind: 'analysis', hint: { rag: true, sql: !!(verdict.hint && verdict.hint.sql) } };
    }
    // 闸门自己会把 abort 吞成 {kind:'analysis'} —— 所以这里必须再确认一次取消,
    // 否则会带着"已取消"继续往分析段跑 (白连一次库)。
    if (cancel && cancel.v) throw new Error('用户取消');

    // 软提示: 这轮可能要查知识库。**只当 bias, 不作分支** —— 拿它去调一次
    // 系统提示的措辞, 用不用 search_knowledge 还是模型在循环里自己定。
    this._ragHint = !!(verdict && verdict.hint && verdict.hint.rag);
    // 轨迹第一步: 闸门怎么判的 (含"为什么要查知识库"的提示)
    this._trace.push({
      kind: 'gate',
      title: '意图闸门',
      detail: verdict.kind === 'chat'
        ? '判定为「闲聊」→ 直接回答, 不查库'
        : (verdict.kind === 'clarify'
          ? '判断不清 → 反问用户, 不瞎猜'
          : ('判定为「' + verdict.kind + '」' + (verdict.hint
            ? ' · 提示: 知识库' + (verdict.hint.rag ? '需要' : '不需要') + ' / 数据库' + (verdict.hint.sql ? '需要' : '不需要')
            : '')))
    });

    // 闸门那一次 (或两次) 调用也算进本次任务
    if (this._gateUsage) {
      taskUsage.input += this._gateUsage.input || 0;
      taskUsage.output += this._gateUsage.output || 0;
      taskUsage.calls += 1;
      // 闲聊路径**直接就从闸门返回了**, 不会再进循环 —— 那条路上闸门这次调用
      // 的输入 token 就是本次唯一的上下文占用, 不记的话进度条会一直是空的。
      if (Number.isFinite(this._gateUsage.input) && this._gateUsage.input > 0) {
        taskCtx = this._gateUsage.input;
      }
      this._gateUsage = null;
      emit({ type: 'usage', task: { ...taskUsage }, ctx: taskCtx, step: 0 });
    }

    if (verdict.kind === 'chat') {
      emit({ type: 'reply', text: verdict.reply });
      return this._replyResult(verdict.reply, Object.assign({}, carry, timing(), { trace: this._trace }));
    }

    // 闸门拿不准 → 直接反问用户 (不猜)。用户答完, 下一轮带着这句上下文重新判 ——
    // 不引入状态机: 反问本身就在历史里, 闸门下一轮看得见。
    if (verdict.kind === 'clarify') {
      const opts = (verdict.options || []).map((o, i) => (i + 1) + '. ' + o).join('\n');
      const text = verdict.question + (opts ? '\n\n' + opts : '');
      emit({ type: 'reply', text });
      return this._replyResult(text, Object.assign({}, carry, timing(), { trace: this._trace }));
    }

    // 命中流程卡: 唯一命中且把握够就照卡跑; 把握不够先要个点头; 多张命中就进调研。
    if (verdict.kind === 'engine') {
      this._trace.push({ kind: 'engine', title: '命中流程卡', detail: String(verdict.engineId || '') });
      if (verdict.low) {
        const card = this._engineById(verdict.engineId);
        return this._askRoute(
          {
            phase: 'confirm',
            engineId: verdict.engineId,
            candidates: verdict.candidates || [verdict.engineId],
            round: 0,
            original: task,
            qa: []
          },
          `我理解你是要查「${card ? card.name : verdict.engineId}」的结果，对吗？`,
          emit,
          carry
        );
      }
      return await this._runEngine(verdict.engineId, task, emit, carry);
    }

    // ---- 多张卡都对得上: 交给模型自己判断, 不再进"调研收窄"那台状态机 ----
    //
    // 以前这里会开一台多轮状态机 (phase: probe -> choose), 一轮问一句、
    // 最多问 MAX_ROUNDS 轮, 由 lib/gate.js 里的代码决定"下一句该问什么、什么时候停"。
    //
    // 为什么把它拆了:
    //   1. 那台状态机的**存在理由**是"路由决定发生在对话之外", 所以状态必须被
    //      序列化进 state、下一轮再灌回来。而 workflow 工具现在就在模型的工具表里
    //      (list_workflows / run_workflow), 对话历史本身就是状态 —— 不需要再养一套。
    //   2. 它正是"接续对话被误判"的来源: 用户答一句"采购模块", 状态机只能拿
    //      这句话去和候选卡名做匹配; 而模型看得见完整对话, 知道上一句在问什么。
    //   3. 每轮一次额外的模型调用, 问什么由代码模板定死, 问不出人话。
    //
    // 现在: 直接走下面的分析循环, 模型自己 list_workflows 看有哪些卡、
    // 自己决定是跑卡还是自己查、自己组织语言问用户。控制权归它。
    if (verdict.kind === 'route') {
      const names = (verdict.candidates || [])
        .map((id) => { const c = this._engineById(id); return c ? c.name : id; })
        .filter(Boolean);
      emit({
        type: 'phase',
        phase: 'workflow',
        message: names.length
          ? `有 ${names.length} 张流程卡可能对得上 (${names.join('、')})，让它自己看该用哪张`
          : '正在判断该用哪张流程卡'
      });
      // 把候选顺带告诉它, 省一次 list_workflows 往返 —— 但**只是提示**,
      // 用不用、用哪张、要不要先问用户, 都由它决定。
      this._workflowHint = names.length ? `这一轮可能相关的流程卡: ${names.join('、')}。用 list_workflows 看它们的入参。` : '';
    } else {
      this._workflowHint = '';
    }

    // ---------- 1. 到这里才是真要干活, 这时才需要数据库与白名单 ----------
    // 空环境(没配库 / 没勾表)下闲聊仍然能走通 —— 它在上一步就返回了
    //
    // 但"有流程卡候选"是例外: 流程卡自己带库和 SQL, **不需要**分析用的白名单。
    // 这时候因为"没勾表"就把整轮挡回去, 等于用分析路径的前提否掉了工作流路径 ——
    // 而这两条路现在都在模型手里, 该让它自己选。
    const workflowOnly = !!this._workflowHint;
    // 闸门说"不用查数据库 (sql=false)、但要查知识库 (rag=true)" → 走**纯知识路径**:
    // 不连库、不读表。对纯知识问题读表既没用, 界面上还会冒出"正在读取可访问的表…",
    // 让用户以为它在乱翻数据库。
    const knowledgeOnly = !!(verdict.hint && verdict.hint.sql === false && verdict.hint.rag);
    this._knowledgeOnly = knowledgeOnly;
    let candidates = [];
    if (knowledgeOnly) {
      this.offlineDbs = [];
      this.tableInventory = [];
      this._trace.push({ kind: 'rag', title: '跳过数据库', detail: '闸门判断这轮不需要查数据库, 直接查知识库' });
    } else {
      if (!this.database) throw new Error('未配置/未选中数据库, 无法执行任务');
      emit({ type: 'phase', phase: 'schema', message: '正在读取可访问的表...' });
      const inv = await this._inventory();
      if (!inv.checked.length && !workflowOnly) {
        throw new Error('尚未勾选任何数据表。请到"数据库"页, 先探测数据表, 再勾选本次要访问的表。');
      }
      // 连不上的库: 记下来, 一路告诉用户和模型。
      // 以前这里连不上就直接抛出去, 于是"配了 4 个库、其中一个没连 VPN"会让
      // **另外 3 个库也一起用不了**, 而用户看到的是 getaddrinfo ENOTFOUND 这种原文。
      // 现在是降级 + 明说: 能查的照查, 查不了的明确讲清楚是哪个库、为什么。
      this.offlineDbs = Array.isArray(inv.offline) ? inv.offline : [];
      if (this.offlineDbs.length) {
        emit({ type: 'phase', phase: 'offline', message: this._offlineSummary(), offline: this.offlineDbs });
      }
      candidates = inv.resolved.map((t) => t.name);
      if (!candidates.length && !workflowOnly) {
        // 分清"库连不上"和"表真的不存在" —— 以前一律报后者, 那是误导
        if (this.offlineDbs.length) {
          throw new Error(`${this._offlineSummary()} 所以这次一张表都没法确认可用。`);
        }
        throw new Error('已勾选的表在对应数据库中都不存在, 请重新探测后再勾选。');
      }
      // 表可能分散在多个库里; 清单里带上归属, 模型才知道哪些表不能拼进同一条 SQL
      this.tableInventory = inv.checked.map((t) => ({ name: t.name, note: t.note, comment: t.comment, dbId: t.dbId, dbName: t.dbName }));
      emit({ type: 'schema', tables: candidates, scope: 'allowlist' });
      this._trace.push({ kind: 'schema', title: '读取可访问的表', detail: '可查 ' + candidates.length + ' 张表' });
    }

    // ---------- 2. 继承本会话已有的工作状态 ----------
    const scope = { tables: [], schemaMap: {}, fieldsSelected: {} };
    for (const t of (Array.isArray(prior.tables) ? prior.tables : [])) {
      // 精确匹配是对的: prior 是上次会话存下来的, 存进去时已经过 candidates 过滤
      if (!candidates.includes(t)) continue;
      const cols = Array.isArray(prior.schemaMap && prior.schemaMap[t]) ? prior.schemaMap[t] : [];
      if (!cols.length) continue;
      const picked = Array.isArray(prior.fieldsSelected && prior.fieldsSelected[t]) ? prior.fieldsSelected[t] : [];
      scope.tables.push(t);
      scope.schemaMap[t] = cols;
      scope.fieldsSelected[t] = picked.length
        ? picked.filter((c) => cols.some((x) => x.field === c))
        : cols.map((c) => c.field);
    }

    // 上一次的结果直接接在编号后面, 让 charts[].source 还能指到它们
    const carried = compactSteps(prior.steps);
    const steps = carried.map((s) => ({ ...s, result: { ...s.result } }));

    // ---------- 2.5 自动模式: 新会话时由 AI 自己把表挑出来 ----------
    //
    // 只在**新会话**上做。已经有 scope 的续轮里再挑一次的话, 用户上一轮确认过的
    // 范围会被无声地换掉 —— 而他这一轮问的很可能就是"接着上面那个再算一下"。
    if (options.autoTables && !scope.tables.length && candidates.length) {
      const auto = await this.autoScope(task, candidates, emit);
      if (auto) {
        scope.tables = auto.tables;
        for (const t of auto.tables) {
          scope.schemaMap[t] = auto.schemaMap[t] || [];
          scope.fieldsSelected[t] = auto.fieldsSelected[t] || [];
        }
        // 告诉界面"自动挑了这些", 而且这不是一个问题 —— 界面据此只展示不拦截
        emit({
          type: 'checkpoint',
          phase: 'tables',
          auto: true,
          selected: auto.tables,
          scored: auto.scored,
          noNote: auto.noNote,
          // 实测证据与"它自己说不确定的地方": 自动模式不弹窗, 这两样是用户
          // 唯一能看出"这次选表到底靠不靠得住"的东西 (见 src/js/app.js)。
          probes: auto.probes,
          uncertain: auto.uncertain,
          untriedCols: auto.untriedCols,
          timing: auto.timing,
          degraded: auto.degraded,
          message: `自动模式: AI 选了 ${auto.tables.length} 张表`
        });
      } else {
        // 挑不出来就退回手动 —— 界面会照常弹选表窗口。
        // 这里明确说一句原因, 免得用户以为"自动模式坏了"。
        emit({
          type: 'phase',
          phase: 'auto_fallback',
          message: '自动模式没能判断出该用哪些表, 改为请你手动确认'
        });
      }
    }

    const noteOf = {};
    for (const t of this.tableInventory) noteOf[t.name] = tableDesc(t);

    emit({
      type: 'state',
      tables: scope.tables,
      carried: carried.map((s, i) => ({
        index: i + 1,
        title: s.purpose || s.title || `查询${i + 1}`,
        rowCount: s.result.rowCount,
        columns: s.result.columns
      })),
      reportTitle: (prior.report && prior.report.title) || '',
      message: carried.length
        ? `沿用本会话资料: ${scope.tables.length} 张表 / ${carried.length} 份查询结果`
        : (scope.tables.length
          ? `沿用已确认的 ${scope.tables.length} 张表`
          : '新会话: 需要先确定要访问哪些表')
    });

    /**
     * 当前时间。
     *
     * 模型自己没有时钟 —— 它只知道训练截止日。不告诉它今天是几号, 用户说
     * "最近一周""上个月""今天"的时候, 它只能从记忆里猜一个日期, 然后**静默查错区间**:
     * 不报错, 只是结论是错的, 而且报告里还会写出一个错的年月。
     *
     * 每次取 contextBlock() 都重新算, 所以长任务里也不会停在开始那一刻的时间。
     */
    const nowLine = () => {
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
        + `${pad(d.getHours())}:${pad(d.getMinutes())} (${week})`;
    };

    /** 当前会话状态文本; 范围变化后要重新贴给模型 */
    const contextBlock = () => {
      // 纯知识路径: 没有数据库上下文, 只交代"这轮查知识库"。
      if (this._knowledgeOnly) {
        return [
          '## 现在的时间', nowLine(),
          '',
          '## 这一轮不查数据库',
          '闸门判断这是**需要查知识库**的问题 (制度/流程/规则/口径/操作说明), 不要读表、不要写 SQL。',
          '直接用 search_knowledge 检索知识库, 拿到片段后自己综合成答案, 并在结论里说明依据来自哪份文档。',
          '若知识库里确实没有依据, 就如实说"文档里没查到", 不要凭通识编。'
        ].join('\n');
      }
      return [
      '## 现在的时间',
      `${nowLine()} —— 判断"最近一周""上个月""今天"这类相对时间时按它算。`,
      '但**写进 SQL 时不要用这个日期**: 改成数据库的 CURDATE() / NOW(), 否则这条 SQL 明天就错了。',
      // 连不上的库必须让模型知道。不告诉它, 它会拿别的表硬凑一个答案 ——
      // 那比直说"连不上"糟糕得多: 用户会拿到一个看起来正常但答非所问的结论。
      ...(this.offlineDbs && this.offlineDbs.length ? [
        '',
        '## 连不上的库 (本次查不了)',
        ...this.offlineDbs.map((d) => `- ${d.dbName}: ${d.reason}`),
        '这些库里的表**本次一条都查不了**。如果用户的请求只能靠它们回答, 就如实说明连不上、',
        '把原因告诉他, 并建议他检查网络或 VPN —— **不要换成别的表硬凑一个答案**。'
      ] : []),
      '',
      '## 可访问的表 (白名单, 只能访问这些)',
      this._inventoryLines(candidates).join('\n'),
      '',
      scope.tables.length ? '## 本会话已确认的表与字段' : '## 本会话已确认的表与字段 (还没有)',
      scope.tables.length ? buildSchemaText(scope, noteOf) : '先用 request_scope 申请需要的表。',
      '',
      '## 已有资料 (已查到的结果)',
      // 这里只给列名和行数, 不给值 —— 全量行贴进上下文会撑爆。
      // 所以要明确告诉它值在哪儿拿: 以前只写"可直接用于出报告, 不必重查",
      // 模型看不到值却以为能用, 要么写出空泛的结论, 要么把 SQL 重跑一遍。
      '要逐行看明细、按某个值排序、或核对一个具体数字, 用 read_result 按编号读回来, 不必重跑 SQL。',
      buildCarriedText(carried)
      ].join('\n');
    };

    // ---------- 3. 准备对话 ----------
    // 提示词来自设置页 (分模块拼装); 技能清单是运行期注入的部分, 不参与配置
    const skillFragment = this.skills ? this.skills.buildSystemPromptFragment() : '';
    // 闸门的 rag 软提示: 让模型更容易想到去查知识库。它只是"提个醒",
    // 工具(search_knowledge)在不在、能不能用, 由工具表和 main.js 决定。
    const ragHint = this._ragHint
      ? '闸门判断这一轮可能需要参考**知识库/文档** (制度、口径、SLA、政策、名词解释)。若问题涉及规则或口径, 先用 search_knowledge 查一下再据此回答, 并在结论里说明依据来自哪份文档。'
      : '';
    const systemPrompt = [
      buildSystemPrompt(this.promptConfig),
      skillFragment,
      // 路由说"有几张卡可能对得上"时, 把候选顺带告诉它。
      // 只是提示: 用不用、用哪张、要不要先问用户, 都由它决定 (见上面拆状态机那段)。
      this._workflowHint || '',
      ragHint
    ].filter(Boolean).join('\n\n');

    const ctx = new AgentContext({ system: () => systemPrompt, maxChars: this.maxChars, historyTurns: this.historyTurns });

    // 历史对话排在当前任务之前, 否则模型看到的顺序是颠倒的。
    // 裁剪规则统一在 AgentContext 里, 不再各处手写一遍。
    ctx.fromHistory(history, this.historyTurns);

    ctx.pushUser([
      '## 当前会话状态',
      contextBlock(),
      '',
      '## 用户这次的要求',
      task,
      '',
      '先判断这是"在跟你说话"还是"让你干活"; 若是干活, 再看手上的资料够不够办。然后通过工具调用表达你的下一个动作。'
    ].join('\n'));

    // ---------- 4. 工具循环 ----------
    //
    // 这一段以前是手写的 for 循环 + 一个大 switch, 每个动作各自把结果拼成字符串
    // 回灌给模型, 还自己抄了一份"原生 tool_calls / 正文 JSON"两套协议的对接代码。
    // 现在交给统一运行时 (lib/agent-loop.js), 这里只剩两件事:
    //   1. 把每个动作实现成注册表里的一个工具 (下面的 _analysisTools)
    //   2. 把运行时的事件翻译成界面认的事件 (_onLoopEvent)
    //
    // 状态用 st 兜着: 循环是运行时的, 但"这一轮结束了吗、以什么结束"仍然由
    // 工具的实现决定 —— 它们是闭包, 直接往 st 上写。
    const st = {
      sqlStepNo: steps.length,   // 资料编号从已有结果之后接着排
      finalAction: null,         // reply / finish
      workflowResult: null,      // run_workflow 直接把整轮结果交出去
      fatal: null                // 用户取消之类: 必须抛出, 不能当成"工具失败"
    };

    const registry = this._analysisTools({
      ask, emit, scope, candidates, task, steps, carry, st, contextBlock,
      // 自动模式下 SQL 不再逐步确认 (见 _analysisTools 里 sql 那段)
      autoRun: !!options.autoTables
    });

    // 系统提示走 system (每轮重建), 所以 messages 里**不能**再放一条 system。
    // 这件事由 AgentContext.toLoop() 统一保证, 不再各处自己拼。
    //
    // ---- 续轮循环 ----
    //
    // 以前这里只跑一次 AgentLoop: 步数跑满 -> stopReason='budget' -> 逼模型交一份
    // 总结 ("已达最大步数, 强制生成总结")。用户看到的是任务**半途被砍断**, 而且
    // 砍在哪儿跟任务难度无关, 只跟它配的步数有关。
    //
    // 现在改成: 跑满就**压缩上下文接着开下一轮**, 直到真的做完 (调了 finish) 或者
    // 撞上 this.maxRounds。这样"一次提问能做多少事"不再被一个拍脑袋的步数卡住。
    //
    // 为什么还要留 maxRounds: 步数完全不设上限的话, 一个陷入循环的模型会一直烧
    // 下去, 而它烧的是真金白银。12 轮 × 每轮步数已经远高于任何正常任务的需要 ——
    // 撞上它基本就是真循环了, 那时候该如实报错, 而不是继续烧。
    let finalAction = null;
    let round = 0;
    let res = null;

    while (round < this.maxRounds) {
      round += 1;
      // continues 告诉循环"后面还有下一轮": 快用完时它就不会催模型收敛
      // (催了它会提前交半成品), 而是让它把手上的事做完。
      const isLast = round >= this.maxRounds;
      const loop = new AgentLoop(ctx.toLoop({
        llm: this.llm,
        tools: registry,
        maxSteps: this.maxSteps,
        continues: !isLast,
        // 人工终止: 传给运行时 —— 每轮开头检查 + 在飞请求被 abort 都认成"取消"
        cancel,
        emit: (ev) => this._onLoopEvent(ev, emit),
        // 任一工具把"这一轮结束了"写进 st 就停。停的理由由工具自己定 ——
        // 运行时不猜"finish 是不是真的该收尾", 那是工具实现的事。
        stopWhen: () => !!(st.fatal || st.finalAction || st.workflowResult)
      }));

      res = await loop.run();
      // 运行完之后的 messages 才是权威的 (它里面含回灌和折叠)
      ctx.messages = res.messages;
      // 账也要接回来: 下一轮是新开一个 AgentLoop, 不带过去的话它就不知道
      // 上一轮折掉过什么 —— 于是把同一张表再查一遍。
      ctx.ledger = res.ledger || '';
      // 用量跨轮累加
      if (res.usage) {
        taskUsage.input += res.usage.input || 0;
        taskUsage.output += res.usage.output || 0;
        taskUsage.calls += res.usage.calls || 0;
        if (Number.isFinite(res.ctx) && res.ctx > 0) taskCtx = res.ctx;
        emit({ type: 'usage', task: { ...taskUsage }, ctx: taskCtx, step: steps.length });
      }

      if (st.fatal) throw st.fatal;
      if (st.workflowResult) return st.workflowResult;

      finalAction = st.finalAction;
      if (finalAction) break;

      if (res.stopReason === 'cancelled') throw new Error('用户取消');
      if (res.stopReason === 'error' && res.error) throw new Error(res.error);
      // done 但没给 finalAction: 模型直接回答了一句 (它在正文里收尾了)。
      // 那不是"没做完", 不该续轮 —— 续了反而把它已经说出口的结论又推翻一遍。
      if (res.stopReason !== 'budget') break;

      // 步数跑满但活没干完 -> 压缩上下文, 接着开下一轮
      if (!isLast) {
        const c = ctx.compact();
        emit({
          type: 'phase',
          phase: 'continue',
          message: `这一轮步数用完了, 正在压缩上下文接着做 (第 ${round + 1}/${this.maxRounds} 轮` +
            (c.compacted ? `, 折叠了 ${c.compacted} 条旧记录` : '') + ')…'
        });
      }
    }

    // 预算用完但模型还没收尾: 逼它交一份总结, 而不是把这一轮判死。
    // 走到这里说明连 maxRounds 都用完了 —— 那也得给用户一个交代。
    if (!finalAction) {
      if (res && res.stopReason === 'cancelled') throw new Error('用户取消');
      if (res && res.stopReason === 'error' && res.error) throw new Error(res.error);
      // 撞上续轮上限就如实说。不说的话用户会以为"它就只做了这些" ——
      // 以前那句"已达最大步数, 强制生成总结"正是这个问题: 它把一次**截断**
      // 说成了一次**完成**。
      emit({
        type: 'phase',
        phase: 'forcing_finish',
        message: round >= this.maxRounds
          ? `已经自动接着做了 ${round} 轮还没做完, 先交一份阶段总结`
          : '已达最大步数, 强制生成总结'
      });
      const tail = res.messages.concat([{
        role: 'user',
        content: '已达最大步数。请基于已收集的数据调用 finish 工具收尾 (title、output、insights 结论数组、charts 图表数组, 图表的 source 用资料编号)。交付形态按用户要拿它干什么来定。'
      }]);
      const out = await this.llm.chatStep([{ role: 'system', content: systemPrompt }].concat(tail), registry.schemas());
      // 逼出来的这次收尾也是一次真调用, 用量照记 —— 漏了它, 用户看到的
      // 数字就比账单少 (而这恰恰是最容易发生截断、也就是花得最多的那类任务)。
      if (out.usage) {
        taskUsage.input += out.usage.input || 0;
        taskUsage.output += out.usage.output || 0;
        taskUsage.calls += 1;
        if (Number.isFinite(out.usage.input) && out.usage.input > 0) taskCtx = out.usage.input;
      }
      const parsed = this._resolveCall(out);
      const forced = parsed ? { action: parsed.call.name, ...(parsed.call.args || {}) } : null;
      finalAction = forced && forced.action === 'finish'
        ? forced
        : { action: 'finish', title: 'Askaha 报告', summary: out.content || '已达到最大步数限制。', output: 'html' };
    }

    // 只是回了一句话: 不出报告, 不改动会话状态, 这一轮到此为止。
    // 注意别把 state 清空 —— 闲聊不该让"查到哪一步"的记忆丢失。
    if (finalAction && finalAction.action === 'reply') {
      return this._replyResult(finalAction.text, {
        tables: scope.tables,
        schemaMap: scope.schemaMap,
        fieldsSelected: scope.fieldsSelected,
        steps: prior.steps,
        report: prior.report,
        ...timing()
      });
    }

    // ---------- 5. 交付 ----------
    const outputFormat = normalizeOutput(finalAction.output, finalAction, steps);
    const insights = normalizeInsights(finalAction);
    // 把 SQL / describe 这些步也收进轨迹, 再补一个收尾 ——
    // 汇总是"决策链"的最后一节, 前端按顺序画成流程图。
    for (const s of steps) {
      this._trace.push({ kind: s.kind || 'step', title: s.title || s.kind || '步骤', detail: s.sql ? String(s.sql).slice(0, 240) : '' });
    }
    this._trace.push({ kind: 'finish', title: '给出回答' });

    const reportPayload = {
      title: finalAction.title || 'Askaha 报告',
      task,
      summary: finalAction.summary || '',
      insights,
      kpis: Array.isArray(finalAction.kpis) ? finalAction.kpis.slice(0, 4) : [],
      charts: Array.isArray(finalAction.charts) ? finalAction.charts : [],
      steps,
      generatedAt: new Date().toISOString()
    };

    // 交付形态由模型定 (见 finish 工具说明)。none = 只是想知道, 对话里说清楚就够了:
    // 不出文件, 也不画图 —— 那次查询的真实结果直接摆进对话。
    // 模型说了不要, 界面上就不该冒出一张报告卡或一张图。
    const wantsFile = outputFormat !== 'none';
    let html = null;
    let md = null;
    let xlsxBase64 = null;
    let xlsxError = null;
    let chartWarnings = [];
    if (wantsFile) {
      const built = Report.build(reportPayload);
      html = built.html;
      md = built.md;
      xlsxBase64 = built.xlsxBase64;
      xlsxError = built.xlsxError;
      chartWarnings = built.chartWarnings || [];
      for (const w of chartWarnings) emit({ type: 'chart_warning', message: w });
    }
    const table = wantsFile ? null : inlineTable(steps);

    emit({
      type: 'report',
      html,
      md,
      xlsxBase64,
      xlsxError,
      chartWarnings,
      title: reportPayload.title,
      insights,
      summary: reportPayload.summary,
      chartCount: (reportPayload.charts || []).length,
      output: outputFormat,
      table
    });

    return {
      title: reportPayload.title,
      summary: reportPayload.summary,
      insights,
      steps,
      html,
      md,
      xlsxBase64: outputFormat === 'excel' ? xlsxBase64 : null,
      xlsxError: outputFormat === 'excel' ? xlsxError : null,
      chartWarnings,
      output: outputFormat,
      table,
      // 本轮 RAG 命中的知识库片段。空数组 = 这轮没用到知识库。
      // main.js 据此决定要不要往「问答管理」飞轮里记一条 (只有用了 RAG 的问答才记)。
      ragHits: this._ragHits || [],
      // 本轮执行轨迹 (决策链), 问答管理"查看"里可视化
      trace: this._trace || [],
      // 本次任务的用量与耗时 (跨续轮累加)
      ...timing(),
      // 交给上层落盘, 下一轮就靠它认路
      state: {
        tables: scope.tables,
        schemaMap: scope.schemaMap,
        fieldsSelected: scope.fieldsSelected,
        steps: compactSteps(steps),
        report: {
          title: reportPayload.title,
          insights,
          kpis: reportPayload.kpis,
          charts: reportPayload.charts,
          output: outputFormat
        }
      }
    };
  }
}

/**
 * 输出格式: 模型自己判断。
 * 模型没说时按它实际产出了什么来推断 —— 给了图就说明它想要一份能看的网页;
 * 只说文字结论、或只有结果表时, 摆进对话就够了, 不替它决定"要出文件"。
 */
function normalizeOutput(output, finalAction, steps) {
  const v = String(output || '').trim().toLowerCase();
  if (['html', 'excel', 'none'].includes(v)) return v;
  const hasCharts = Array.isArray(finalAction.charts) && finalAction.charts.length > 0;
  return hasCharts ? 'html' : 'none';
}

/** 对话内摆结果表时的行数上限: 再多就该出文件了 */
const INLINE_TABLE_MAX_ROWS = 200;
const INLINE_TABLE_MAX_COLS = 12;

/**
 * 把这次跑的 SQL 结果整理成"能直接摆在对话里"的表。
 *
 * 这是 output=none 的交付形态 —— 用户只是想知道结果, 那就把表摆出来。
 * 表头走 report.js 的 columnLabel, 跟报告 / Excel / CSV 同一个口径。
 * 多条 SQL 时取最后一条: 那通常是最终结果, 前面几条是过程。
 */
function inlineTable(steps) {
  const sqlSteps = (steps || []).filter(
    (s) => s && s.kind === 'sql' && s.result && !s.result.error
      && Array.isArray(s.result.columns) && s.result.columns.length
  );
  if (!sqlSteps.length) return null;
  const step = sqlSteps[sqlSteps.length - 1];
  const r = step.result;
  const cols = r.columns.slice(0, INLINE_TABLE_MAX_COLS);
  const rows = (r.rows || []).slice(0, INLINE_TABLE_MAX_ROWS);
  if (!rows.length) return null;
  return {
    title: step.title || step.purpose || '查询结果',
    // keys 是原始列名, 界面拿它做悬浮提示; labels 是中文表头
    keys: cols,
    columns: cols.map((c) => Report.columnLabel(r, c)),
    rows: rows.map((row) => cols.map((c) => (row[c] === null || row[c] === undefined ? '' : row[c]))),
    rowCount: r.rowCount == null ? rows.length : r.rowCount,
    truncated: (r.rowCount || rows.length) > rows.length,
    sqlCount: sqlSteps.length
  };
}

/**
 * 规范化模型给的 fields。
 * 容忍三种写法: 字符串数组、{name, meaning} 对象数组、以及 meaning 写成 label/desc。
 */
function normalizeFields(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((f) => {
      if (typeof f === 'string') return { name: f.trim(), meaning: '' };
      if (f && typeof f === 'object') {
        return {
          name: String(f.name || f.field || f.column || '').trim(),
          meaning: String(f.meaning || f.label || f.desc || f.description || '').trim()
        };
      }
      return null;
    })
    .filter((f) => f && f.name)
    .slice(0, 80);
}

/**
 * 从 fields 里挑出「结果列的中文名」映射。
 * 只保留确实出现在结果列里的名字, 这样 WHERE 用的输入字段不会污染表头。
 * 整表查询 (fields 里是 "*") 时不做映射, 保持原样。
 */
function buildLabels(fields, columns) {
  const cols = Array.isArray(columns) ? columns : [];
  if (!cols.length) return {};
  const out = {};
  for (const f of fields || []) {
    if (!f || !f.meaning || f.name === '*') continue;
    if (!cols.includes(f.name)) continue;
    out[f.name] = f.meaning;
  }
  return out;
}

/**
 * 兼容两种 finish 写法: 新的 insights 数组, 或旧的 summary 大段 markdown。
 * 都没有时退回 steps 里能拿到的信息, 保证报告不至于空着。
 */
function normalizeInsights(finalAction) {
  if (Array.isArray(finalAction.insights)) {
    const arr = finalAction.insights.map((s) => String(s == null ? '' : s).trim()).filter(Boolean);
    if (arr.length) return arr;
  }
  if (typeof finalAction.insights === 'string' && finalAction.insights.trim()) {
    return finalAction.insights.split('\n').map((s) => s.replace(/^[-*\d.\s]+/, '').trim()).filter(Boolean);
  }
  return [];
}

/**
 * 索引结果里有没有这一列。
 *
 * 判断本体在 lib/engine.js —— 搭建 Agent / 测试 Agent 用的是同一份。
 * 这里只做转发, 免得三个 agent 各留一个副本、改了一个忘了另两个。
 */
function indexHasColumn(rows, column) {
  return Engine.indexHasColumn(rows, column);
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
// 「内部工具」页要展示每个工具是只读还是串行 —— 读这里, 不另抄一份
module.exports.ANALYSIS_READ_ONLY = ANALYSIS_READ_ONLY;
// 斜杠指令的单一来源 —— main.js 的 agent:commands 接口和这里的解析器读同一份
module.exports.SLASH_COMMANDS = SLASH_COMMANDS;
module.exports.parseSlash = parseSlash;
