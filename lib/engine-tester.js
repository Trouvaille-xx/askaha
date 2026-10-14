/**
 * 测试 Agent —— 专职把一张流程卡"跑到通"。
 *
 * 它和搭建 Agent (lib/engine-ai.js) 的分工:
 *   搭建 Agent: 把卡搭出来 (结构、SQL、条件、结论)。
 *   测试 Agent: 拿真实单号跑这张卡, 跑不通就**查清为什么**, 产出一份结构化的
 *               修复建议, 交给搭建 Agent 去改。它自己不改卡。
 *
 * 为什么不让它自己改: 改卡要懂"用户当初想干什么" (需求、确认过的字段、分支意图),
 * 那份上下文在搭建会话里。测试 Agent 手里只有"跑出来的事实", 让它改容易越改越偏。
 * 所以它是**诊断者**, 不是修理工 —— 输出证据和建议, 由掌握上下文的那个去动手。
 *
 * 它比搭建 Agent 多一样东西: **能看真实数据**。
 * 这是关键。跑不通的根因大多不在结构里, 而在数据里:
 *   - 那一列 99% 是 NULL        -> 拿它当关联键必然查空
 *   - 那张表其实没有这一列      -> column does not exist
 *   - 那个过滤列没有索引        -> 全表扫几十秒, 看着像卡死
 *   - 枚举值的真实取值不是猜的  -> CASE WHEN 'valid_done' 才对得上
 * 光看 DDL 一条都发现不了。所以工具集里除了 describe_tables, 还有:
 *   sample_column (抽样看真实值) / find_column (这一列在哪些表里) /
 *   check_index (有没有索引) / run_sql (跑一条只读验证猜想)。
 *
 * 全部只读, 且都带 LIMIT 上限 —— 测试 Agent 不能改数据, 也不能把库拖垮。
 */

const Engine = require('./engine.js');
const Gate = require('./gate.js');
const Prompt = require('./prompt.js');
const { ToolRegistry } = require('./tools.js');
const { AgentLoop } = require('./agent-loop.js');
const { AgentContext } = require('./context.js');
const Peek = require('./data-peek.js');

// 一次诊断最多来回多少步。测试比搭建短: 搭一张卡要几十步, 诊断一轮十来步够了。
const MAX_TURNS = 24;
// 没给测试数据时, 最多花几步去库里找一个真实的值。
// 找测试数据是件简单的事 (抽一列看看就知道), 给多了会在这里耗掉配额,
// 反而挤掉真正用来诊断的步数。
const INVENT_TURNS = 6;
// 抽样只看这么多行。看"这一列长什么样"几十行足够, 不要拖数据。
const SAMPLE_ROWS = 20;

/* ==================== 工具定义 ==================== */

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_card',
      description: '重新看一遍当前这张卡的结构 (节点、SQL、条件、出口模板)。诊断前先看它。',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_available_tables',
      description: '列出本次可探索的全部表 (产品经理勾选的范围)。不确定有哪些表时用它。',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'describe_tables',
      description:
        '读这几张表的字段结构。同名表跨库时必须写成 "库id.表名" 指明是哪个库的, ' +
        '否则字段认错、SQL 报"列不存在"。一次别超过 12 张。',
      parameters: {
        type: 'object',
        properties: {
          tables: { type: 'array', items: { type: 'string' }, description: '表名, 或 "库id.表名"' },
          why: { type: 'string', description: '为什么需要看这几张表' }
        },
        required: ['tables']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'find_column',
      description:
        '这一列在哪些表里存在。定位"该用哪张表取这个字段"时用它 —— ' +
        '比如要按单号关联, 先看哪些表真的有这个列。只读元数据, 不读数据。',
      parameters: {
        type: 'object',
        properties: {
          column: { type: 'string', description: '列名, 如 po_no' },
          tables: {
            type: 'array',
            items: { type: 'string' },
            description: '限定在哪些表里找。不填就在全部可用表里找 (较慢)'
          }
        },
        required: ['column']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'sample_column',
      description:
        '抽样看某一列**真实长什么样**: 取前若干行, 给出真实取值、空值占比、去重后的取值。' +
        '这是定位问题的关键手段 —— 枚举值到底怎么拼、单号是什么格式、这一列是不是几乎全空, ' +
        '只有看真实值才知道。不要凭猜写 CASE WHEN。',
      parameters: {
        type: 'object',
        properties: {
          dbId: { type: 'string', description: '库 id' },
          table: { type: 'string', description: '表名' },
          column: { type: 'string', description: '要看的列' },
          where: { type: 'string', description: "可选的过滤条件 (不带 WHERE 关键字), 如 source_doc = 'SO...'" },
          why: { type: 'string', description: '想看什么' }
        },
        required: ['dbId', 'table', 'column']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'check_index',
      description:
        '看一张表的索引情况, 判断某个列能不能用来过滤。' +
        '大表上按没有索引的列过滤会全表扫, 几十秒甚至更久 —— 看起来像卡死, 其实是慢查询。' +
        '如果某个过滤条件很慢, 用它确认那一列有没有索引, 再找有索引的等价列。',
      parameters: {
        type: 'object',
        properties: {
          dbId: { type: 'string' },
          table: { type: 'string' },
          column: { type: 'string', description: '关心的列, 可选。给了就判断它有没有索引' }
        },
        required: ['dbId', 'table']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_sql',
      description:
        '在某个库上跑一条**只读** SELECT 验证猜想。用它把"我猜是这样"变成"确实是"。' +
        '只允许 SELECT / WITH, 且会自动限行。注意: 跑在真实的业务库上, 只读保护照旧生效。',
      parameters: {
        type: 'object',
        properties: {
          dbId: { type: 'string' },
          sql: { type: 'string', description: '一条只读 SELECT' },
          why: { type: 'string', description: '想验证什么' }
        },
        required: ['dbId', 'sql']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'report',
      description:
        '诊断完了, 交出结论。**必须调用它来收尾**。' +
        '跑通了就如实说通了 (verdict=pass); 跑不通要说清断在哪、证据是什么、建议怎么改 (verdict=fail)。',
      parameters: {
        type: 'object',
        properties: {
          verdict: { type: 'string', enum: ['pass', 'fail'], description: '这张卡跑通了没有' },
          summary: { type: 'string', description: '一两句人话: 结论是什么' },
          brokenStep: { type: 'string', description: '断在哪一步 (节点标题)。跑通了就不用填' },
          rootCause: {
            type: 'string',
            description: '根因。要具体到"哪一列/哪张表/哪个值"不对, 不要写"SQL 有问题"这种废话'
          },
          evidence: {
            type: 'array',
            items: { type: 'string' },
            description: '支撑判断的证据 (查到的真实数据、报错原文、索引情况)'
          },
          fixes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                nodeId: { type: 'string', description: '要改的节点 id (不确定可留空)' },
                nodeTitle: { type: 'string', description: '要改的节点标题' },
                action: {
                  type: 'string',
                  enum: ['configure_query', 'configure_condition', 'configure_output', 'configure_input', 'add_node', 'connect', 'delete_node'],
                  description: '建议用哪个动作改'
                },
                detail: { type: 'string', description: '具体怎么改, 要能照着做 (比如给出建议的 SQL)' },
                reason: { type: 'string', description: '为什么这么改' }
              },
              required: ['action', 'detail']
            },
            description: '修复建议, 一条一个动作'
          }
        },
        required: ['verdict', 'summary']
      }
    }
  }
];

/* ==================== 诊断辅助 ==================== */

/** 只读保护: 和 lib/database.js 同口径, 这里再拦一道 (测试 Agent 能自己写 SQL) */
function isReadOnly(sql) {
  const t = String(sql || '').trim().replace(/^(--[^\n]*\n|\s)+/g, '');
  if (!/^(select|with|explain|show|pragma)\b/i.test(t)) return false;
  const semi = t.indexOf(';');
  if (semi >= 0 && t.slice(semi + 1).trim()) return false;
  return true;
}

/** 给一条 SQL 套上行数上限 */
function withLimit(sql, n) {
  const t = String(sql || '').trim().replace(/;\s*$/, '');
  if (/\blimit\s+\d+/i.test(t) || /\btop\s+\d+/i.test(t)) return t;
  return `${t} LIMIT ${n}`;
}

function fmtVal(v) {
  if (v === null) return 'NULL';
  if (v === undefined) return 'undefined';
  if (v instanceof Date) return v.toISOString();
  const s = String(v);
  return s.length > 60 ? s.slice(0, 60) + '…' : s;
}

/** 方言: 标识符引用符 —— 实现收在 Engine.quoteIdent 一处, 别再本地抄一份 */
const quoteIdent = Engine.quoteIdent;

/* ==================== 系统提示词 ==================== */

function buildSystemPrompt(card, pool, described, dbNames, promptConfig) {
  return Prompt.buildSetPrompt(promptConfig, 'tester', {
    hasDescribed: !!(described && described.size),
    scope_tables: poolLines(pool, dbNames),
    described_tables: describedLines(described),
    draft_json: JSON.stringify(cardBrief(card, dbNames), null, 2)
  });
}

/** 可用范围那几行。原来内联在 buildSystemPrompt 里, 搬出来给占位符用。 */
function poolLines(pool, dbNames) {
  const out = [];
  for (const dbId of Object.keys(pool || {})) {
    const ts = pool[dbId] || [];
    if (!ts.length) continue;
    out.push(`- 库 ${(dbNames && dbNames[dbId]) || dbId} (id=${dbId}): ${ts.join(', ')}`);
  }
  return out.join('\n') || '- (没有可用范围)';
}

/** "你已经看过的表结构"那几行。测试 Agent 这里不带类型, 跟搭建 Agent 不一样。 */
function describedLines(described) {
  if (!described || !described.size) return '';
  const out = [];
  for (const [k, cols] of described.entries()) {
    out.push(`- ${k}: ${cols.map((c) => c.field).join(', ')}`);
  }
  return out.join('\n');
}

/** 被测那张卡的摘要。字段拼成 key(label), 因为测试时要按 label 核对用户看到的东西。 */
function cardBrief(card, dbNames) {
  return {
    name: card.name || '',
    description: card.description || '',
    nodes: (card.nodes || []).map((n) => {
      const o = { id: n.id, type: n.type, title: n.title };
      if (n.type === 'input') o.fields = (n.fields || []).map((f) => `${f.key}(${f.label || ''})`);
      if (n.type === 'query') {
        o.database = (dbNames && dbNames[n.databaseId]) || n.databaseId || '(没选)';
        o.table = n.table || '';
        o.sql = n.sql || '';
        o.outputs = (n.outputs || []).map((c) => c.key);
      }
      if (n.type === 'condition') o.expr = n.expr || null;
      if (n.type === 'output') o.template = n.template || '';
      return o;
    }),
    edges: (card.edges || []).map((e) => `${e.from} -${e.port}-> ${e.to}`)
  };
}

/* ==================== 主类 ==================== */

class EngineTester {
  /**
   * @param llm       LLMClient
   * @param pool      { [dbId]: [表名] } 产品经理勾选的探索范围
   * @param card      要测的这张卡
   * @param databases 全部库配置
   * @param openDb    (conf) => Database
   */
  /**
   * 对话史。**代理到 ctx**, 不是另存一份 —— 两份数组一定会分叉,
   * 而分叉的表现是"模型看到的和最终存下的不是同一段对话", 极难查。
   */
  get messages() { return this.ctx.messages; }
  set messages(arr) { this.ctx.messages = arr; }

  constructor({ llm, pool, card, databases, openDb, mcp, general, prompt }) {
    this.llm = llm;
    // 用户在「设置 · 提示词 · 测试 Agent」里改过的那部分。空 -> 全用出厂值。
    this.promptConfig = prompt || null;
    this.pool = pool || {};
    this.card = card;
    this.databases = databases || [];
    this.openDb = openDb;
    // 外部接入的工具 (MCP)。可选 —— 没配就是没有, 不影响内置工具。
    this.mcp = mcp || null;
    // 上下文统一由 AgentContext 管 (跟搭建 Agent / 分析 Agent 同一份实现)。
    // 每轮重建提示词: 它里面含"当前草稿", 冻结的话模型看不到自己这一轮查到了什么
    this.ctx = new AgentContext({
      system: () => buildSystemPrompt(this.card, this.pool, this.described, this.dbNames(), this.promptConfig),
      maxChars: general && general.maxChars
    });
    this.messages = [];
    this.described = new Map();
    this.report = null;
    this.lastRun = null;
    this.openHandles = [];
  }

  dbNames() {
    const m = {};
    for (const d of this.databases) m[d.id] = d.name || d.id;
    return m;
  }

  dbConf(dbId) {
    return this.databases.find((d) => d.id === dbId);
  }

  poolTableList() {
    const out = [];
    for (const dbId of Object.keys(this.pool)) {
      const db = this.dbConf(dbId);
      for (const t of this.pool[dbId] || []) out.push({ dbId, dbName: db ? (db.name || db.id) : dbId, table: t });
    }
    return out;
  }

  tableHits(name) {
    return this.poolTableList().filter((x) => x.table === name);
  }

  /** 和搭建 Agent 同一套歧义保护: 同名表不猜 */
  _resolveTable(name, dbId) {
    const hits = this.tableHits(name);
    if (!hits.length) return { miss: true };
    if (dbId) {
      const want = hits.find((x) => x.dbId === dbId);
      return want ? { hit: want } : { miss: true };
    }
    if (hits.length > 1) return { ambiguous: hits };
    return { hit: hits[0] };
  }

  async _db(dbId) {
    const conf = this.dbConf(dbId);
    if (!conf) throw new Error(`没有这个库: ${dbId}`);
    const handle = await this.openDb(conf);
    this.openHandles.push(handle);
    return handle;
  }

  async _closeAll() {
    for (const h of this.openHandles) {
      try { await h.close(); } catch (e) { /* ignore */ }
    }
    this.openHandles = [];
  }

  /** 这张卡的入口还缺什么 (用引擎那套判定, 任选组给一个就算齐) */
  missingInputs(inputs) {
    const node = (this.card.nodes || []).find((n) => n.type === 'input');
    return Engine.checkInputs((node && node.fields) || [], inputs || {});
  }

  /**
   * 没有测试数据时, 自己去库里找一份真实的。
   *
   * 为什么不让调用方"编一个单号": 编出来的单号在库里查不到行, 卡会一路走到
   * "零行"那条路上 —— 测试就变成在验证一张空结果, 而不是在验证这张卡。
   * 真跑一遍的前提是有一个**真实存在**的单号。
   *
   * 这里复用测试 Agent 自己的工具 (sample_column / run_sql), 所以它找出来的值
   * 一定是从真库里读到的。步数给得少: 找测试数据是件简单的事, 找不到就如实返回空,
   * 让上层报"需要你给一个测试单号", 而不是在这里耗光配额。
   */
  async _inventInputs(emit) {
    const node = (this.card.nodes || []).find((n) => n.type === 'input');
    const fields = ((node && node.fields) || []).filter((f) => f.key);
    if (!fields.length) return {};

    const one = (f) => `- ${f.key} (${f.label || f.key})` + (f.desc ? ` — 说明: ${f.desc}` : '');
    const groups = [];
    for (const f of fields) {
      if (!f.group) continue;
      let g = groups.find((x) => x.name === f.group);
      if (!g) { g = { name: f.group, members: [] }; groups.push(g); }
      g.members.push(f);
    }
    const plain = fields.filter((f) => !f.group);
    const need = [];
    if (plain.length) need.push(...plain.map(one));
    for (const g of groups) {
      need.push(`- 【任选其一】${g.name} —— 下面几项里挑**一个**给上就够:`);
      need.push(...g.members.map((f) => '  ' + one(f)));
    }

    const sys = [
      '这张流程卡要跑起来, 需要下面这些输入。但你手上没有现成的单号。',
      '',
      '需要的输入:',
      ...need,
      '',
      '## 你的任务',
      '',
      '去库里找一个**真实存在**的值来当测试数据 —— 用 sample_column 抽一列看看真实长什么样,',
      '或用 run_sql 直接挑一行出来。不要编一个看起来像的单号: 库里查不到的号会让这张卡',
      '一路走到"零行", 那测的是一张空结果, 不是这张卡。',
      '',
      '【任选其一】的组只需要给其中一项 —— 挑你最容易找到真实值的那一项。',
      '',
      '找齐之后, 只输出一个 JSON 对象, 不要有其它文字, 不要用代码块:',
      '{"<输入项名>": "<真实的值>"}',
      '',
      '实在找不到就给空对象 {}, 不要编。'
    ].join('\n');

    const found = {};
    const take = (text) => {
      const got = Gate.extractJSON(text);
      if (!got || typeof got !== 'object') return false;
      for (const f of fields) {
        const v = got[f.key];
        if (v === undefined || v === null) continue;
        const s = String(v).trim();
        if (s) found[f.key] = s;
      }
      return Object.keys(found).length > 0;
    };

    // 这一段以前是手抄主诊断循环写出来的 (同一个 ack / 原生协议对接逻辑再写一遍)。
    // 交给统一运行时之后, 只剩"提示词 + 预算 + 怎么算找到了"。
    const loop = new AgentLoop({
      llm: this.llm,
      tools: this._registry(),
      system: sys,
      messages: [{ role: 'user', content: '去找这些值。' }],
      budget: { maxSteps: INVENT_TURNS },
      emit: () => {},
      // 它自己把 JSON 交出来了就停, 不用再转一轮
      stopWhen: (name, args, text) => take(text),
      ctx: { emit }
    });

    try {
      const res = await loop.run();
      // 收尾文本里可能也带着那份 JSON
      take(res.finalText || '');
      // 中途某一轮正文里给了也算
      for (const m of loop.messages) {
        if (m.role === 'assistant' && m.content) take(m.content);
      }
    } catch (e) {
      // 找测试数据失败不该让整轮测试挂掉 —— 上层会如实报"缺测试数据"
    }
    return found;
  }

  /* ---- 工具执行 ---- */

  async _runTool(emit, call) {
    const a = call.args || {};
    try {
      switch (call.name) {
        case 'get_card':
          return JSON.stringify(this._brief(), null, 2);

        case 'list_available_tables': {
          const byName = {};
          for (const x of this.poolTableList()) {
            (byName[x.table] = byName[x.table] || []).push(x.dbName + '(id=' + x.dbId + ')');
          }
          const lines = [];
          for (const dbId of Object.keys(this.pool)) {
            const ts = this.pool[dbId] || [];
            if (!ts.length) continue;
            const db = this.dbConf(dbId);
            lines.push(`库 ${db ? (db.name || db.id) : dbId} (id=${dbId}): ${ts.join(', ')}`);
          }
          const dup = Object.keys(byName).filter((k) => byName[k].length > 1);
          if (dup.length) {
            lines.push('');
            lines.push('注意: 这些表在多个库里都有 (字段不一样, 必须用 "库id.表名" 指明):');
            for (const d of dup) lines.push(`  ${d} -> ${byName[d].join('、')}`);
          }
          return lines.join('\n') || '(没有可用的表)';
        }

        case 'describe_tables': {
          const want = (Array.isArray(a.tables) ? a.tables : []).map(String);
          if (!want.length) return { error: '要给 tables。' };
          const lines = [];
          for (const spec of want.slice(0, 12)) {
            let name = spec, dbId = '';
            const dot = spec.indexOf('.');
            if (dot > 0) { dbId = spec.slice(0, dot); name = spec.slice(dot + 1); }
            const got = this._resolveTable(name, dbId);
            if (got.miss) { lines.push(`${spec}: 不在可用范围里。`); continue; }
            if (got.ambiguous) {
              lines.push(`${spec}: 歧义 —— ${name} 在 ${got.ambiguous.length} 个库里都有 (${got.ambiguous.map((h) => h.dbName + ' id=' + h.dbId).join('、')}), 请写成 "库id.表名"。`);
              continue;
            }
            const h = got.hit;
            const key = h.dbId + '.' + h.table;
            try {
              let cols = this.described.get(key);
              if (!cols) {
                const db = await this._db(h.dbId);
                cols = await db.describeTable(h.table);
                this.described.set(key, cols);
              }
              lines.push(`${key} (库 ${h.dbName}) 共 ${cols.length} 列:`);
              lines.push('  ' + cols.map((c) => c.field + (c.type ? ':' + String(c.type).split(' ')[0] : '')).join(', '));
            } catch (e) {
              lines.push(`${key}: 读表结构失败 -> ${e.message}`);
            }
          }
          return lines.join('\n');
        }

        case 'find_column': {
          const col = String(a.column || '').trim();
          if (!col) return { error: '要给 column。' };
          let targets = this.poolTableList();
          if (Array.isArray(a.tables) && a.tables.length) {
            const set = new Set(a.tables.map(String));
            targets = targets.filter((x) => set.has(x.table) || set.has(x.dbId + '.' + x.table));
          }
          const found = [];
          for (const t of targets) {
            const key = t.dbId + '.' + t.table;
            try {
              let cols = this.described.get(key);
              if (!cols) {
                const db = await this._db(t.dbId);
                cols = await db.describeTable(t.table);
                this.described.set(key, cols);
              }
              if (cols.some((c) => c.field === col)) found.push(key + ' (库 ' + t.dbName + ')');
            } catch (e) { /* 读不到就跳过 */ }
          }
          return found.length
            ? `列 ${col} 出现在这些表里:\n  ` + found.join('\n  ')
            : `可用范围里没有任何表有 ${col} 这一列。`;
        }

        case 'sample_column': {
          const dbId = String(a.dbId || '').trim();
          const table = String(a.table || '').trim();
          const column = String(a.column || '').trim();
          if (!dbId || !table || !column) return { error: 'dbId / table / column 都要给。' };
          const conf = this.dbConf(dbId);
          const db = await this._db(dbId);
          const q = quoteIdent(column, conf && conf.type);
          const tb = quoteIdent(table, conf && conf.type);
          const where = String(a.where || '').trim();
          const whereSql = where ? ` WHERE ${where}` : '';
          const out = [];

          const r1 = await db.query(`SELECT ${q} AS v FROM ${tb}${whereSql} LIMIT ${SAMPLE_ROWS}`);
          const vals = (r1.rows || []).map((x) => x.v);
          out.push(`样本 (前 ${vals.length} 行): ` + (vals.length ? vals.map(fmtVal).join(' | ') : '(没有行)'));

          // 统计归 lib/data-peek.js: 没给 where 且表超过 100 万行时自动降级成
          // 抽样 (以前这里是全表 COUNT(DISTINCT), 千万行的表一列十几秒)。
          // 给了 where 就不抽样 —— 那是调用方限定的范围, 报"抽样"会和它自己的口径打架。
          const s = await Peek.peekColumnStats({
            db, dialect: conf && conf.type, table, tb, col: q, where
          });
          for (const line of Peek.formatStats(s)) out.push(line);
          return out.join('\n');
        }

        case 'check_index': {
          const dbId = String(a.dbId || '').trim();
          const table = String(a.table || '').trim();
          const column = String(a.column || '').trim();
          if (!dbId || !table) return { error: 'dbId / table 都要给。' };
          const conf = this.dbConf(dbId);
          const db = await this._db(dbId);
          const type = (conf && conf.type) || '';
          const esc = table.replace(/'/g, "''");

          if (type === 'postgres') {
            const r = await db.query(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = '${esc}'`);
            const rows = r.rows || [];
            if (!rows.length) return `表 ${table} 上一个索引都没有 (任何过滤都会全表扫)。`;
            const lines = [`表 ${table} 的索引:`];
            for (const x of rows) lines.push(`  ${x.indexname}: ${x.indexdef}`);
            if (column) {
              const hit = rows.filter((x) => String(x.indexdef || '').includes(column));
              lines.push('');
              lines.push(hit.length
                ? `✓ ${column} 有索引 (走 ${hit.map((h) => h.indexname).join(', ')})。`
                : `✗ ${column} 没有索引 —— 按它过滤会全表扫, 大表上可能要几十秒。换个有索引的等价列。`);
            }
            return lines.join('\n');
          }
          if (type === 'mysql') {
            const r = await db.query(`SHOW INDEX FROM \`${table.replace(/`/g, '')}\``);
            const rows = r.rows || [];
            if (!rows.length) return `表 ${table} 上一个索引都没有 (任何过滤都会全表扫)。`;
            const lines = [`表 ${table} 的索引:`];
            for (const x of rows) {
              const cn = x.Column_name || x.column_name;
              const kn = x.Key_name || x.key_name;
              lines.push(`  ${kn}: 列 ${cn}`);
            }
            if (column) {
              const hit = rows.filter((x) => (x.Column_name || x.column_name) === column);
              lines.push('');
              lines.push(hit.length ? `✓ ${column} 有索引。` : `✗ ${column} 没有索引 —— 按它过滤会全表扫。`);
            }
            return lines.join('\n');
          }
          return `这个库类型 (${type}) 暂不支持查索引。`;
        }

        case 'run_sql': {
          const dbId = String(a.dbId || '').trim();
          const sql = String(a.sql || '').trim();
          if (!dbId || !sql) return { error: 'dbId / sql 都要给。' };
          if (!isReadOnly(sql)) return { error: '只允许只读的 SELECT / WITH, 且一次只能一条语句。' };
          const db = await this._db(dbId);
          const r = await db.query(withLimit(sql, 50));
          const cols = r.columns || [];
          const rows = r.rows || [];
          const lines = [`${r.rowCount} 行, ${r.elapsedMs}ms`];
          if (!rows.length) {
            lines.push('(没有行)');
          } else {
            lines.push('列: ' + cols.join(' | '));
            for (const row of rows.slice(0, 20)) {
              lines.push(cols.map((c) => fmtVal(row[c])).join(' | '));
            }
            if (rows.length > 20) lines.push(`... 还有 ${rows.length - 20} 行`);
          }
          return lines.join('\n');
        }

        case 'report': {
          this.report = {
            verdict: a.verdict === 'pass' ? 'pass' : 'fail',
            summary: String(a.summary || ''),
            brokenStep: String(a.brokenStep || ''),
            rootCause: String(a.rootCause || ''),
            evidence: (Array.isArray(a.evidence) ? a.evidence : []).map(String),
            fixes: (Array.isArray(a.fixes) ? a.fixes : []).map((f) => ({
              nodeId: String(f.nodeId || ''),
              nodeTitle: String(f.nodeTitle || ''),
              action: String(f.action || ''),
              detail: String(f.detail || ''),
              reason: String(f.reason || '')
            }))
          };
          // 不用再自己记"该停了" —— 运行时通过 stopWhen 认 report 这个终结工具。
          // (以前这里置一个 this.done, 循环里读它; 现在那个循环归运行时了。)
          if (emit) emit({ type: 'test_report', report: this.report });
          return '诊断结论已记录。';
        }

        default:
          return `没有这个工具: ${call.name}`;
      }
    } catch (e) {
      return { error: '执行失败: ' + ((e && e.message) || String(e)) };
    }
  }

  _brief() {
    return {
      name: this.card.name || '',
      description: this.card.description || '',
      nodes: (this.card.nodes || []).map((n) => {
        const o = { id: n.id, type: n.type, title: n.title };
        if (n.type === 'input') o.fields = (n.fields || []).map((f) => `${f.key}(${f.label || ''})`);
        if (n.type === 'query') {
          o.database = this.dbNames()[n.databaseId] || n.databaseId || '(没选)';
          o.table = n.table || '';
          o.sql = n.sql || '';
          o.outputs = (n.outputs || []).map((c) => c.key);
        }
        if (n.type === 'condition') o.expr = n.expr || null;
        if (n.type === 'output') o.template = n.template || '';
        return o;
      }),
      edges: (this.card.edges || []).map((e) => `${e.from} -${e.port}-> ${e.to}`)
    };
  }

  /** 把一次试跑的结果写成模型能读的文本 */
  /**
   * 结论是不是"空壳"。
   *
   * 两种情况都算:
   *   1. 引用没落地 (missingRefs) —— 模板里那些占位符渲染出来是空白
   *   2. 结论里除了标签和标点, 没有任何真实值 —— 比如 "回单状态：" 后面空着
   *
   * 为什么要单独判: 引擎的 ok 只反映"有没有硬错误"。一张出口模板引用错分支
   * 的卡跑起来**不报任何错**, 但用户什么也看不到 —— 对作者来说这就是没跑通。
   */
  _thinAnswer(r) {
    if (!r || !r.ok) return false;
    if ((r.missingRefs || []).length) return true;
    const ans = String(r.answer || '').trim();
    if (!ans) return true;
    // 把"像值的东西"抠出来: 数字、含字母的串、中文实词。只剩标签和标点就算空壳。
    const valueish = ans.match(/[0-9]|[A-Za-z]{2,}|[\u4e00-\u9fa5]{2,}/g) || [];
    // 结论短得离谱、又没有明显的数据 —— 认定为空壳
    if (valueish.length <= 2 && ans.length < 24) return true;
    return false;
  }

  _runDigest(r, thin) {
    const lines = [];
    if (thin) {
      lines.push('⚠ 这一轮**没有报错, 但给出的结论是空的** —— 用户什么也看不到。');
    } else if (r.ok) {
      lines.push('✓ 这一轮**跑通了**。');
    } else {
      lines.push('✗ 这一轮**没跑通**。');
    }
    lines.push('逐步结果:');
    for (const s of r.steps || []) {
      const bits = [`[${s.type}] ${s.title}`];
      if (s.sql) bits.push(`SQL: ${s.sql}`);
      if (typeof s.rowCount === 'number') bits.push(`${s.rowCount} 行`);
      if (s.elapsedMs) bits.push(`${s.elapsedMs}ms`);
      if (s.condition) bits.push(`判定 ${s.condition} -> ${s.result ? '成立' : '不成立'}`);
      if (s.text) bits.push(`结论: ${s.text}`);
      if (s.error) bits.push(`❌ 错误: ${s.error}`);
      lines.push('  ' + (s.error ? '✗ ' : '· ') + bits.join(' | '));
    }
    if (!r.ok) {
      lines.push('');
      lines.push(`断在这一步: ${r.error}`);
      if (r.hint) lines.push(r.hint);
    }
    if ((r.blankParams || []).length) {
      lines.push('');
      lines.push(`注意: 这些参数这一轮取到的是空值 (上游没查到行, 或那一列本身是 NULL), SQL 里的条件被抹成了 '' -> ${r.blankParams.join(', ')}`);
    }
    if ((r.missingRefs || []).length) {
      lines.push('');
      lines.push(`注意: 结论里这些引用没落地, 渲染成了空白 -> ${r.missingRefs.join(', ')}`);
    }
    if (r.ok && r.answer) {
      lines.push('');
      lines.push('用户会看到的结论:');
      lines.push(r.answer);
    } else if (r.ok && !r.answer) {
      lines.push('');
      lines.push('⚠ 出口没有产出任何结论 (模板是空的, 或者引用全部落空)。');
    }
    return lines.join('\n');
  }

  /**
   * 跑一次卡, 然后让模型诊断。
   *
   * @param inputs  测试单号 (入口字段 -> 值)
   * @param emit    事件回调: test_phase / test_act / test_say / test_report
   * @returns { ok, verdict, report, run, error }
   */
  async run(inputs, emit) {
    const say = (t) => { if (emit && t) emit({ type: 'test_say', text: t }); };

    // ---- 0. 没给测试数据就自己去库里找一个真实的 ----
    //
    // 编排完自动自测时没有人给它单号。以前这种情况会直接拿空输入去跑, 卡报
    // "缺少必要输入" —— 测试 Agent 于是对着一个"输入没给"的报错做诊断,
    // 而那张卡本身可能完全没问题。先补数据, 再谈测。
    let use = Object.assign({}, inputs || {});
    if (!this.missingInputs(use).ok) {
      const miss = this.missingInputs(use).missingLabels;
      if (emit) emit({ type: 'test_phase', phase: 'inputs', message: `这张卡要跑起来还缺 ${miss}，正在从库里找一个真实的值…` });
      const found = await this._inventInputs(emit);
      // 调用方给的值优先 —— 它给的才是用户真正想测的那个单号
      use = Object.assign({}, found, use);
      const still = this.missingInputs(use);
      if (!still.ok) {
        const msg = `找不到可用的测试数据 (还缺 ${still.missingLabels})。给一个真实的单号再测 —— 编一个查不到的号, 测出来的是空结果, 不是这张卡。`;
        if (emit) emit({ type: 'test_phase', phase: 'done', message: msg });
        return {
          ok: false, verdict: 'error', exhausted: false,
          report: { verdict: 'fail', summary: msg, brokenStep: '入口', rootCause: '缺少测试数据', evidence: [], fixes: [] },
          run: { ok: false, error: msg, steps: [], blankParams: [], missingRefs: [] }
        };
      }
      if (emit) emit({ type: 'test_phase', phase: 'inputs', message: `用这份数据测: ${Object.entries(use).map(([k, v]) => k + '=' + v).join('  ')}` });
    }

    // ---- 1. 先真跑一遍 ----
    if (emit) emit({ type: 'test_phase', phase: 'run', message: '正在按这张卡的路线真跑一遍…' });
    let r;
    try {
      r = await Engine.testEngine(this.card, use, this.databases, this.openDb, { sampleRows: SAMPLE_ROWS });
    } catch (e) {
      r = { ok: false, error: (e && e.message) || String(e), steps: [], blankParams: [], missingRefs: [] };
    }
    this.lastRun = r;
    if (emit) emit({ type: 'test_run_done', run: r });

    // ---- 1b. "没报错"不等于"跑通了" ----
    //
    // 引擎只在硬错误 (SQL 挂了 / 条件出口没接线) 时置 ok=false。但作者最常踩的
    // 恰恰是**没报错却给不出结论**: 出口模板引用了只挂在另一条分支上的节点,
    // 走这条路时那处渲染成空; 或者结论里只剩标签、值全空。用户看到的是
    // "回单状态：" 后面什么都没有 —— 这必须算不通, 否则测试 Agent 会放行一张废卡。
    const thin = this._thinAnswer(r);
    if (r.ok && !thin) {
      this.report = {
        verdict: 'pass',
        summary: '这张卡跑通了，结论正常输出。',
        brokenStep: '',
        rootCause: '',
        evidence: [],
        fixes: []
      };
      if (emit) emit({ type: 'test_report', report: this.report });
      return { ok: true, verdict: 'pass', report: this.report, run: r };
    }

    // ---- 2. 没通 / 跑通了但结论是空的: 让模型诊断 ----
    if (emit) {
      emit({
        type: 'test_phase', phase: 'diagnose',
        message: thin ? '跑完了，但结论是空的，正在查原因…' : '没跑通，正在查原因…'
      });
    }

    const digest = this._runDigest(r, thin);
    this.messages.push({
      role: 'user',
      content: `这张卡${thin ? '**跑完了但给出的结论是空的**' : '跑不通'}。以下是这一轮的真实结果:\n\n${digest}\n\n请查清原因, 给出修复建议, 然后调 report 交出结论。`
    });

    let reply = '';
    // 模型有没有自己调 report 收尾。没调就说明是步数用尽, 兜底报告要如实说明。
    let diagnosed = false;

    // ---- 交给统一运行时 ----
    //
    // 它管控制流 (下一步做什么由模型决定)、协议对接、并发执行、预算、上下文压缩;
    // 这里只管"有哪些工具、提示词写什么"。
    //
    // 换过来的直接收益 (以前这三样都缺):
    //   - 一轮里多个只读动作会真的都执行 (以前只执行第一个, 其余回灌"已跳过")
    //   - 模型格式飘了 / 编了不存在的工具, 会回灌纠正并继续 (以前直接当收尾)
    //   - 上下文超限会压缩旧工具结果 (以前一路涨到撑爆窗口)
    //   - 挂上 MCP 就多了外部工具, 不用改这里一行
    const loop = new AgentLoop(this.ctx.toLoop({
      llm: this.llm,
      tools: this._registry(),
      maxSteps: MAX_TURNS,
      emit: (ev) => this._onLoopEvent(ev, emit, say),
      stopWhen: (name) => name === 'report',
      ctx: { emit }
    }));

    let res;
    try {
      res = await loop.run();
    } finally {
      await this._closeAll();
    }
    // 运行完之后的对话史才是权威的 (含回灌与折叠)
    this.messages = res.messages;
    reply = res.finalText || '';
    diagnosed = !!this.report;

    if (res.stopReason === 'error') {
      return { ok: false, error: '模型调用失败: ' + (res.error || '原因不明'), run: r };
    }

    // 模型没给结论就兜一个, 免得界面上什么都没有
    let fabricated = false;
    if (!this.report) {
      fabricated = true;
      this.report = {
        verdict: 'fail',
        summary: reply || (diagnosed ? '诊断没有给出明确结论。' : `诊断步数用尽 (${MAX_TURNS} 轮) 仍没给出结论。`),
        brokenStep: '',
        rootCause: r.error || '',
        evidence: [],
        fixes: []
      };
      if (emit) emit({ type: 'test_report', report: this.report });
    }
    // exhausted: 这份报告是兜底出来的, 不是模型真诊断出来的 —— 编排层据此
    // 区分"诊断说修不好"和"诊断自己没跑完", 后者不该当成有效的修复建议。
    return { ok: true, verdict: this.report.verdict, report: this.report, run: r, exhausted: fabricated };
  }

  /**
   * 把现有工具挂到注册表上。
   *
   * 处理函数直接复用 _runTool —— 工具逻辑本身是对的 (而且被测试锁着)。
   * 这次迁移只换"谁来决定下一步", 不重写工具, 所以这里是薄薄一层适配。
   */
  _registry() {
    const r = new ToolRegistry();
    for (const t of TOOLS) {
      const fn = t.function;
      if (!fn || !fn.name) continue;
      r.add(
        fn.name,
        fn.description,
        fn.parameters,
        (args, ctx) => this._runTool(ctx && ctx.emit, { name: fn.name, args }),
        // 这个 Agent 的工具全是只读的 (硬约束: 它不能改数据), report 只是交卷
        { readOnly: true, group: 'diagnose' }
      );
    }
    // 外部接入的工具 (MCP)。以前测试 Agent 看不到它们 —— 而诊断经常需要查
    // 内部系统 (工单、监控、发布记录), 那些正是该用 MCP 接的东西。
    if (this.mcp) r.attachMCP(this.mcp);
    return r;
  }

  /** 运行时事件 -> 这个 Agent 对外的 test_* 事件 */
  _onLoopEvent(ev, emit, say) {
    if (!ev) return;
    switch (ev.type) {
      case 'say': say(ev.text); return;
      case 'tool_result':
        // report 是交卷, 不用报"我调了 report"
        if (ev.name === 'report') return;
        if (emit && ev.ok !== false) emit({ type: 'test_act', text: describeAct(ev.name, ev.args) });
        return;
      case 'phase':
        if (emit && ev.message) emit({ type: 'test_phase', phase: ev.phase || 'retry', message: ev.message });
        return;
      case 'compact':
        if (emit) emit({ type: 'test_phase', phase: 'compact', message: `上下文过长，折叠了 ${ev.count} 条旧结果` });
        return;
      default: return;   // thought / tool_start 太碎, 不往界面上推
    }
  }
}

/** 把工具名翻成一句人话, 显示在诊断日志里 */
function describeAct(name, a) {
  a = a || {};
  switch (name) {
    case 'get_card': return '重新看了一遍这张卡';
    case 'list_available_tables': return '看了下可探索的范围';
    case 'describe_tables': return `读了表结构：${(a.tables || []).join('、')}`;
    case 'find_column': return `查了 ${a.column} 出现在哪些表里`;
    case 'sample_column': return `抽样看了 ${a.table}.${a.column} 的真实值`;
    case 'check_index': return `查了 ${a.table} 的索引${a.column ? '（关心 ' + a.column + '）' : ''}`;
    case 'run_sql': return '跑了一条只读 SQL 验证猜想';
    case 'report': return '交出了诊断结论';
    default: return name;
  }
}

module.exports = { EngineTester, TOOLS, buildSystemPrompt, describeAct, isReadOnly, withLimit, fmtVal, MAX_TURNS, SAMPLE_ROWS };
