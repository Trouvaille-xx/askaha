/**
 * 流程引擎 (流程卡) —— 定义层 + 确定性执行器
 *
 * 为什么单独做一个模块:
 *   Askaha 原本只有一种模式 —— 探索式分析 (模型每步临场决定路线)。
 *   流程卡是**另一种模式**: 路线由管理员预先写死, 运行时只是照着走。
 *   两者对"谁定路线"的答案相反, 所以不复用 agent 的 ReAct 循环, 各跑各的。
 *
 * 典型场景 (用户给的例子):
 *   "D32026031100604750 这个付款单发起时报错是啥原因"
 *   -> 不是要分析数据, 而是按一套固定排查步骤查出来并给结论。
 *   这种活写死成一张卡, 每次跑出来的路线完全一样, 可复现、可审计。
 *
 * 节点只有四种:
 *   input      入口: 声明这张卡需要哪些输入 (如付款单号)
 *   query      取数: 连哪个库、哪张表、跑什么固定 SQL、产出哪些列
 *   condition  条件: 按显式规则判断, 走 true 或 false 两个出口
 *   output     出口: 用模板把上游结果拼成给人看的结论
 *
 * 关于 SQL:
 *   配置期由 AI 辅助写好, 存成固定 SQL; 运行期**不调模型**, 直接执行。
 *   参数用 {{占位符}} 绑定, 且**尊重作者写的引号** —— 写成 '{{payNo}}'
 *   就按字符串值代入, 写成 {{id}} 就按字面量代入 (数字不套引号)。
 *   这样作者对类型的意图是明确写在 SQL 里的, 不靠运行时猜。
 *
 * 规则里可以引用哪张卡, 见 README 的「流程引擎」一节。
 */

const NODE_TYPES = ['input', 'query', 'condition', 'output'];

const NODE_LABEL = {
  input: '入口',
  query: '取数节点',
  condition: '条件分支',
  output: '出口'
};

// 条件里支持的比较算子。字符串比较与数值比较分开, 免得 "10" < "9" 这种坑。
const CMP_OPS = ['==', '!=', '>', '>=', '<', '<=', 'contains', 'notContains', 'empty', 'notEmpty'];

let seq = 0;
function genId(prefix) {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}`;
}

/** 新建一张空卡: 一个入口 + 一个出口, 中间留给管理员填 */
function newEngine(over) {
  const inputId = genId('n');
  const outputId = genId('n');
  return normalizeEngine({
    id: genId('eng'),
    name: '未命名流程卡',
    description: '',
    enabled: true,
    examples: [],
    nodes: [
      { id: inputId, type: 'input', title: '入口', x: 80, y: 200, fields: [{ key: 'input1', label: '输入项', required: true }] },
      { id: outputId, type: 'output', title: '出口', x: 640, y: 200, template: '{{input1}}' }
    ],
    edges: [{ from: inputId, to: outputId, port: 'out' }],
    ...(over || {})
  });
}

/* ==================== 规范化 ==================== */

function str(v, max) {
  const s = String(v == null ? '' : v);
  return max ? s.slice(0, max) : s;
}
function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/**
 * 入口 / 取数节点的输入项。
 *
 * desc 和 group 是给"模型看得懂"用的, 不影响 SQL 绑定:
 *   desc  —— 这一项到底要什么。比如「SRM 里的送货单号, 形如 DN2024xxxx」。
 *            没有它, 模型只知道字段叫「送货单号」, 用户给一串 DN2024xxx 时它
 *            没有依据判断该填哪一项 —— 三个入口任选其一的场景全靠这个。
 *   group —— 任选其一的分组名。同一组的字段, 只要**有一个**有值就算齐了。
 *            典型场景: 一张卡既能按送货单号查、也能按采购订单号查、也能按发票号查,
 *            用户手里有哪个就给哪个。
 *
 * 分组的语义只在"够不够跑"这件事上生效; 卡里怎么按"谁有值"分流是另一件事,
 * 由条件节点的 empty/notEmpty 表达 (见 checkInputs 的注释)。
 */
function normalizeField(f, i) {
  return {
    key: str(f && f.key, 60).trim() || `input${i + 1}`,
    label: str(f && f.label, 60).trim() || str(f && f.key, 60) || `输入项${i + 1}`,
    required: !(f && f.required === false),
    desc: str(f && f.desc, 200),
    // 分组名是自由文本标签 (如「单号」), 不做枚举 —— 模型自己起名, 只要同组一致
    group: str(f && f.group, 40).trim()
  };
}

const OUTPUT_TYPES = ['string', 'number', 'bool', 'date'];

function normalizeOutputCol(c, i) {
  const t = String((c && c.type) || '').trim().toLowerCase();
  return {
    key: str(c && c.key, 60).trim(),
    label: str(c && c.label, 60).trim() || str(c && c.key, 60),
    // 输出列的类型。可选, 但声明了就用于静态核对 (对数字列做字符串比较这类坑)。
    type: OUTPUT_TYPES.includes(t) ? t : ''
  };
}

function normalizeExpr(e) {
  if (!e || typeof e !== 'object') return null;
  // 分组: 写成 type:'group' 或**直接给一个 items 数组**都算。
  // 按"有 items"判是刻意的 —— 模型 (或手写卡) 很容易忘写 type:'group', 一旦漏了,
  // 旧逻辑会把它当成一条 left 为空的 cmp 丢掉, 结果是**条件少了一半而一声不吭**。
  if (e.type === 'group' || Array.isArray(e.items)) {
    const items = (Array.isArray(e.items) ? e.items : []).map(normalizeExpr).filter(Boolean);
    if (!items.length) return null;
    return { type: 'group', logic: e.logic === 'or' ? 'or' : 'and', items };
  }
  const op = CMP_OPS.includes(e.op) ? e.op : '==';
  const left = str(e.left, 120).trim();
  if (!left) return null;
  return { type: 'cmp', left, op, right: e.right == null ? '' : String(e.right) };
}

/**
 * 这张卡的入口"够不够跑"。
 *
 * 这是唯一的判定处 —— 运行前的校验 (runner)、对话里的补问 (agent)、
 * 界面上的红字提示 (renderer) 都走它。以前这条规则在三个地方各写了一遍,
 * 于是"任选其一"这种新语义要改三处, 漏一处就会出现"界面说能跑、引擎说不能跑"。
 *
 * 规则:
 *   - 没分组的字段: required 且为空 -> 缺这一项
 *   - 分了组的字段: 组内**全为空**才算缺 (组内某一个为空不算缺)
 *   - 一个组要不要给, 看组里有没有 required 的成员: 有 -> 这个组必须给一个;
 *     全组成员都是 required:false -> 整组可选, 给不给都行
 *
 * 注意这里只管"够不够跑"。卡里怎么按"谁有值"分流是另一件事 ——
 * 用条件节点的 empty / notEmpty 表达 (「{{deliveryNo}} 有值」就走按送货单号查的那条),
 * 因为三个入口往往查的是不同的库、不同的表, 一条 SQL 用 OR 拼不出来。
 *
 * @returns {{ok:boolean, missing:string[], missingGroups:string[], missingLabels:string}}
 */
function checkInputs(fields, inputs) {
  const vals = inputs || {};
  const has = (f) => String(vals[f.key] == null ? '' : vals[f.key]).trim() !== '';
  const list = (Array.isArray(fields) ? fields : []).filter((f) => f && f.key);

  const missing = [];
  const missingGroups = [];
  const missingFields = [];
  const seen = new Set();

  for (const f of list) {
    if (!f.group) {
      if (f.required && !has(f)) { missing.push(f.key); missingFields.push(f); }
      continue;
    }
    if (seen.has(f.group)) continue;
    seen.add(f.group);
    const members = list.filter((x) => x.group === f.group);
    if (members.some(has)) continue;                       // 组里有一个就够了
    if (!members.some((x) => x.required)) continue;         // 整组都是选填 -> 不给也行
    missingGroups.push(f.group);
    missingFields.push(...members);
  }

  // 组缺了就把整组摆出来让人选, 用「或」连 —— 「请提供 A、B、C」会被读成三个都要
  const missingLabels = missingGroups.length
    ? missingGroups.map((g) => list.filter((x) => x.group === g).map((x) => x.label).join(' 或 ')).join('、')
    : missingFields.map((f) => f.label).join('、');

  return { ok: !missing.length && !missingGroups.length, missing, missingGroups, missingLabels };
}

function normalizeNode(n) {
  const type = NODE_TYPES.includes(n && n.type) ? n.type : 'query';
  const base = {
    id: str(n && n.id, 60).trim() || genId('n'),
    type,
    title: str(n && n.title, 80).trim() || NODE_LABEL[type],
    x: num(n && n.x, 100),
    y: num(n && n.y, 100)
  };
  if (type === 'input') {
    // 不给默认项: 入口没配字段就是"不需要输入"。新建卡片的默认输入项由 newEngine 负责给,
    // 否则管理员在画布上把输入项删光后, 运行期会冒出一个谁也没配过的必填项。
    base.fields = (Array.isArray(n.fields) ? n.fields : []).map(normalizeField);
  } else if (type === 'query') {
    base.databaseId = str(n && n.databaseId, 80).trim();
    base.table = str(n && n.table, 120).trim();
    base.sql = str(n && n.sql, 8000);
    // 取数节点的输入项是 SQL 里 {{占位符}} 的**镜像**: 声明了才允许运行时"引用前面的"
    // 按列名兜底, 界面上也才显示得出"来自 X / 没接上"。作者/工具没给就按 SQL 补上 ——
    // 否则 write_card 一次写出来的卡 fields 空着, 看着像"没参数", 运行时却照常从入口/
    // 上游取值。补齐后与 configure_query 建出来的卡行为一致。
    const declared = (Array.isArray(n.fields) ? n.fields : []).map(normalizeField);
    base.fields = declared.length
      ? declared
      : paramsOf(base.sql).map((k) => ({ key: k, label: k, required: true, desc: '', group: '' }));
    base.outputs = (Array.isArray(n && n.outputs) ? n.outputs : []).map(normalizeOutputCol).filter((c) => c.key);
  } else if (type === 'condition') {
    base.expr = normalizeExpr(n && n.expr);
  } else if (type === 'output') {
    base.template = str(n && n.template, 4000);
  }
  return base;
}

function normalizeEdge(e, nodeIds) {
  const from = str(e && e.from, 60).trim();
  const to = str(e && e.to, 60).trim();
  if (!from || !to || !nodeIds.has(from) || !nodeIds.has(to) || from === to) return null;
  const port = ['out', 'true', 'false'].includes(e && e.port) ? e.port : 'out';
  return { from, to, port };
}

/**
 * 这张流程卡"能用的库和表"的范围。
 *
 * 它是卡片自己的属性, 跟节点、连线一样跟着卡走 —— 换一张卡就该换一套范围,
 * 关掉再打开也得还在。形状是 { 库id: [表名, ...] }。
 *
 * 这里只保证形状干净 (字符串、去重、空的不留), **不**校验库表还在不在配置里:
 * 那件事依赖运行期读到的「数据库」页配置, 只有渲染进程知道。
 * 读取时统一走 renderer 的过滤, 所以这里留下的"死"库表不会漏到 AI 那边去。
 */
function normalizeScope(v) {
  const out = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const key of Object.keys(v)) {
    const dbId = str(key, 80).trim();
    if (!dbId) continue;
    const seen = new Set();
    const tables = [];
    for (const t of (Array.isArray(v[key]) ? v[key] : [])) {
      const name = str(t, 120).trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      tables.push(name);
    }
    if (tables.length) out[dbId] = tables;
  }
  return out;
}

/** 把外部传进来的数据洗成内部形状。未知字段一律丢弃。 */
function normalizeEngine(input, opts) {
  const src = input && typeof input === 'object' ? input : {};
  // 读路径 (engine:list) 传 keepTimestamps: 保留原 updatedAt。
  // 否则一列出列表每张卡都被刷成"刚更新", 时间戳就没法看了。
  const keepTs = !!(opts && opts.keepTimestamps);
  const nodes = (Array.isArray(src.nodes) ? src.nodes : []).map(normalizeNode);
  const nodeIds = new Set(nodes.map((n) => n.id));
  let edges = (Array.isArray(src.edges) ? src.edges : []).map((e) => normalizeEdge(e, nodeIds)).filter(Boolean);
  // 同一端口只留一条出边 —— 条件节点必须二选一, 不能走两条
  const seen = new Set();
  edges = edges.filter((e) => {
    const k = e.from + '|' + e.port;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return {
    id: str(src.id, 80).trim() || genId('eng'),
    name: str(src.name, 80).trim() || '未命名流程卡',
    description: str(src.description, 500).trim(),
    enabled: src.enabled !== false,
    examples: (Array.isArray(src.examples) ? src.examples : []).map((s) => str(s, 200).trim()).filter(Boolean),
    // 这张卡能用的库表范围, 跟节点/连线一样属于卡片内容 —— 必须在这里放行,
    // 否则渲染进程存上来的 scope 会被这张白名单悄悄丢掉。
    scope: normalizeScope(src.scope),
    nodes,
    edges,
    createdAt: src.createdAt || new Date().toISOString(),
    // 存盘时刷成"现在"(那是"刚改过"的标记); 读的时候 (keepTs) 保留原值
    updatedAt: (keepTs && src.updatedAt) ? src.updatedAt : new Date().toISOString()
  };
}

/* ==================== 校验 ==================== */

/**
 * 存盘前的体检。返回 { ok, errors, warnings }。
 * errors 会让保存被拦下 (结构性问题); warnings 只是提醒, 照样能存。
 */
/** 把条件里的比较项摊平 (子组也要挖出来) */
function flattenCmp(expr, out) {
  const acc = out || [];
  if (!expr || typeof expr !== 'object') return acc;
  if (expr.type === 'group') {
    for (const it of (expr.items || [])) flattenCmp(it, acc);
    return acc;
  }
  acc.push(expr);
  return acc;
}

/** 这张卡里"能引用到的东西" */
function collectRefs(e) {
  const bare = new Set();     // 入口字段: 裸名直接用
  const nodeIds = new Set();  // 能当前缀的节点
  const cols = new Map();     // nodeId -> 声明过的列名
  for (const n of e.nodes) {
    if (n.type === 'input') {
      for (const f of (n.fields || [])) if (f.key) bare.add(f.key);
    } else if (n.type === 'query') {
      nodeIds.add(n.id);
      cols.set(n.id, new Set((n.outputs || []).map((c) => c.key).filter(Boolean)));
    }
  }
  return { bare, nodeIds, cols };
}

/**
 * 一个引用能不能落地。
 * hard=true 表示连渲染期的兜底都救不回来 —— 那一处必然是空的。
 *
 * 这里的规则必须和 resolveRef / renderTemplate 保持一致:
 *  - 裸名只认入口字段, **不**参与 findColumn 兜底, 所以对不上就是死的
 *  - 节点.列 形式: 节点在、列没声明的话, 渲染时有 findColumn 按列名兜底, 可能救得回来
 */
function refStatus(ref, R) {
  // 花括号剥掉再判 —— 跟 resolveRef 保持一致。
  // 不剥的话, 条件里写 {{docNo}} 会被这里判成"没有来源"的硬错,
  // 而运行期其实跑得通 (resolveRef 认两种写法), 两边就对不上了。
  const key = String(ref == null ? '' : ref).trim()
    .replace(/^\{\{\s*/, '')
    .replace(/\s*\}\}$/, '');
  if (!key) return { ok: false, hard: true };
  if (key.indexOf('.') < 0) {
    return R.bare.has(key) ? { ok: true, hard: false } : { ok: false, hard: true };
  }
  const parts = key.split('.');
  const head = parts[0];
  const rest = parts.slice(1);
  if (!R.nodeIds.has(head)) return { ok: false, hard: true };
  if (rest[0] === 'rowCount' || rest[0] === 'ok' || rest[0] === 'error' || rest[0] === 'rows') {
    return { ok: true, hard: false };
  }
  const declared = R.cols.get(head) || new Set();
  if (declared.has(rest[0])) return { ok: true, hard: false };
  return { ok: false, hard: false };
}

/** 节点 id -> 标题, 只用于把校验信息写成给人看的话 */
function byIdTitle(e, id) {
  const n = (e.nodes || []).find((x) => x.id === id);
  return n ? n.title : id;
}

function validateEngine(engine, opts) {
  const errors = [];
  const warnings = [];
  // 可选的真实表结构 { 表名: { 列名: {type} } }, 由调用方 (搭建 Agent) 注入 —— core 不碰数据库。
  const schema = (opts && opts.schema && typeof opts.schema === 'object') ? opts.schema : null;
  const e = normalizeEngine(engine);

  const inputs = e.nodes.filter((n) => n.type === 'input');
  const outputs = e.nodes.filter((n) => n.type === 'output');
  const queries = e.nodes.filter((n) => n.type === 'query');

  if (!inputs.length) errors.push('缺少入口节点: 至少要有一个输入节点来声明这张卡需要什么。');
  if (!outputs.length) errors.push('缺少出口节点: 至少要有一个输出节点来给出结论。');
  if (!e.name || e.name === '未命名流程卡') warnings.push('这张卡还没有名字, 路由器只能靠描述来匹配它。');
  if (!e.description && !e.examples.length) {
    warnings.push('没有描述也没有示例问法, 路由器很难在合适的场景命中它。');
  }

  for (const n of queries) {
    if (!n.databaseId) errors.push(`取数节点「${n.title}」没有选数据库。`);
    if (!n.table) errors.push(`取数节点「${n.title}」没有选表。`);
    if (!n.sql.trim()) errors.push(`取数节点「${n.title}」没有写 SQL。`);
    if (!n.outputs.length) warnings.push(`取数节点「${n.title}」没有声明输出列, 下游的条件和模板可能引用不到东西。`);
  }
  for (const n of e.nodes.filter((x) => x.type === 'condition')) {
    if (!n.expr) errors.push(`条件节点「${n.title}」还没有配置判断规则。`);
    const outs = e.edges.filter((x) => x.from === n.id);
    const hasT = outs.some((x) => x.port === 'true');
    const hasF = outs.some((x) => x.port === 'false');
    if (!hasT && !hasF) errors.push(`条件节点「${n.title}」两个出口都没接线, 流程会走到这里断掉。`);
    else if (!hasT || !hasF) warnings.push(`条件节点「${n.title}」只接了一个出口, 走另一条路时会中断。`);
  }

  // ---- 引用体检: 条件与结论模板里引用的东西, 到底有没有来源 ----
  // 这一层是补上来的。以前只查"有没有配", 不查"配的东西对不对得上",
  // 于是像「模板里少打一个字母」「查询出来的列没写节点前缀」这种必然输出空的情况,
  // 校验一声不吭, 要等用户跑完看见空结果才发现。
  const R = collectRefs(e);

  for (const n of e.nodes.filter((x) => x.type === 'condition')) {
    for (const it of flattenCmp(n.expr)) {
      const st = refStatus(it.left, R);
      if (st.ok) continue;
      if (st.hard) {
        errors.push(`条件节点「${n.title}」引用的「${it.left}」找不到来源, 这一条运行时永远判不出来。（查询出来的列要写成 节点.列名 的形式）`);
      } else {
        warnings.push(`条件节点「${n.title}」引用的「${it.left}」: 那个取数节点没有声明这一列, 运行时按列名去跑过的节点里兜底找, 可能拿不到值。`);
      }
    }
  }

  for (const n of e.nodes.filter((x) => x.type === 'output')) {
    // ---- 循环结构: 成对、不嵌套、只能遍历 节点.rows ----
    // 结构错必须在存盘前拦下: 运行期遇到没配对的标记只会渲染成空白, 用户看到的是
    // "结论里少了一段", 而卡看起来完全正常。
    const tpl = String(n.template || '');
    const opens = (tpl.match(/\{\{#each\b/g) || []).length;
    const closes = (tpl.match(/\{\{\/each\}\}/g) || []).length;
    if (opens !== closes) {
      errors.push(`出口「${n.title}」的结论模板里 {{#each}} 与 {{/each}} 没配上对 (${opens} 个开始 / ${closes} 个结束), 循环必须成对写。`);
    }
    for (const m of tpl.matchAll(/\{\{#each\s+([^}]+?)\s*\}\}([\s\S]*?)\{\{\/each\}\}/g)) {
      const ref = m[1].trim();
      if (/\{\{#each\b/.test(m[2])) {
        errors.push(`出口「${n.title}」的模板里嵌套了循环 —— 不支持。一层循环里直接写当前行的列就行。`);
      }
      const head = ref.split('.')[0];
      const tail = ref.split('.').slice(1).join('.');
      if (!R.nodeIds.has(head)) {
        errors.push(`出口「${n.title}」的 {{#each ${ref}}} 遍历的不是取数节点。只能写成 {{#each 节点id.rows}}。`);
      } else if (tail && tail !== 'rows') {
        errors.push(`出口「${n.title}」的 {{#each ${ref}}} 只能遍历 节点id.rows (整个结果集), 不能遍历单个格子。`);
      }
    }

    for (const ref of paramsOf(n.template)) {
      const st = refStatus(ref, R);
      if (st.ok) continue;
      // 循环体里的裸名会被 paramsOf 记成 节点.列名。如果这个名字其实是入口字段
      // (循环里用入口字段是合法的), 那不是错, 别报。
      const col = String(ref).split('.').slice(1).join('.');
      if (!st.hard && col && R.bare.has(col)) continue;
      if (st.hard) {
        errors.push(`出口「${n.title}」的结论模板引用了「${ref}」, 但流程里没有任何地方产出这个名字, 这一处渲染出来是空的。(查是否拼错; 查询出来的列要写成 节点.列名)`);
      } else {
        warnings.push(`出口「${n.title}」引用的「${ref}」: 那个取数节点没有声明这一列, 运行时按列名去跑过的节点里兜底找, 可能拿不到值。`);
      }
    }
  }

  // ---- 分支可达性: 引用得对得上, 还要"这条路上真的跑得到" ----
  //
  // 上面那层只问"这个名字有没有来源", 不问"来源在不在这条分支上"。
  // 于是「条件 → true 支跑节点A → 出口甲 / false 支 → 出口乙」这种菱形里,
  // 出口乙写 {{A.某列}} 照样能通过校验 —— A 确实有这一列, 只是走 false 时它压根没跑。
  // 用户看到的是结论里凭空少了一段, 而校验一声不吭。
  //
  // 只算"警告"不算"硬错": 模板渲染有一层按列名兜底 (findColumn), 别的分支上
  // 跑过的节点如果恰好有同名列, 这里照样能取到值 —— 那正是"分支合并"的用法。
  const ancestorsOf = (target) => {
    const seen = new Set();
    const stack = [target];
    while (stack.length) {
      const cur = stack.pop();
      for (const ed of e.edges) {
        if (ed.to !== cur || seen.has(ed.from)) continue;
        seen.add(ed.from);
        stack.push(ed.from);
      }
    }
    return seen;
  };
  const reachCache = new Map();
  const canReach = (nodeId, target) => {
    if (!reachCache.has(target)) reachCache.set(target, ancestorsOf(target));
    return reachCache.get(target).has(nodeId);
  };

  for (const n of e.nodes.filter((x) => x.type === 'output')) {
    for (const ref of paramsOf(n.template)) {
      const head = String(ref).split('.')[0];
      if (!R.nodeIds.has(head)) continue;          // 不是节点引用, 上面那层已经管了
      if (canReach(head, n.id)) continue;
      warnings.push(`出口「${n.title}」引用了「${ref}」, 但「${byIdTitle(e, head)}」不在通往这个出口的路上 (它只在另一条分支上跑), 走这条路时这一处会渲染成空 —— 除非别处有同名列兜底。`);
    }
  }

  // ---- 恒不成立的条件: 同一个值既要求为空、又要求有值, 还用"全部成立"连起来 ----
  for (const n of e.nodes.filter((x) => x.type === 'condition')) {
    const g = n.expr;
    if (!g || g.type !== 'group' || g.logic === 'or') continue;
    const byLeft = new Map();
    for (const it of (g.items || [])) {
      if (!it || it.type !== 'cmp' || !it.left) continue;
      if (!byLeft.has(it.left)) byLeft.set(it.left, new Set());
      byLeft.get(it.left).add(it.op);
    }
    for (const [left, ops] of byLeft) {
      if (ops.has('empty') && ops.has('notEmpty')) {
        errors.push(`条件节点「${n.title}」自相矛盾: 同一个「${left}」既要求为空、又要求有值, 用「全部成立」连起来永远不成立, 每次都走另一条路。留一条就够了。`);
      }
    }
  }

  // ---- 任选其一的入口: 声明了 group, 就必须真的按"谁有值"分流 ----
  //
  // 这是最容易只做一半的地方: 在入口上把三项标成一组, 运行期确实不再逼用户给三个,
  // 但卡里没有分叉 —— 于是没被填的那几项在 SQL 里渲染成空串, 条件变成 `= ''`。
  // **不报错, 就是查不到数**, 而且换一个入口去查还是查不到, 用户完全看不出问题在哪。
  // 所以这里必须出声。
  {
    const inputNode = inputs[0];
    const grouped = ((inputNode && inputNode.fields) || []).filter((f) => f.group);
    const names = Array.from(new Set(grouped.map((f) => f.group)));
    for (const g of names) {
      const keys = grouped.filter((f) => f.group === g).map((f) => f.key);
      // 卡里有没有一个条件节点在按"这几项谁有值"分流
      const branched = e.nodes.some((n) => {
        if (n.type !== 'condition' || !n.expr) return false;
        return flattenCmp(n.expr).some((it) => it.op === 'notEmpty' && keys.some((k) => String(it.left).includes(k)));
      });
      if (!branched) {
        warnings.push(
          `入口的「${g}」是任选其一 (${keys.join(' / ')}), 但流程里没有按"哪一项有值"分流。` +
          `用户只给其中一项时, SQL 里另外几项会渲染成空串, 条件变成 = '' 而查不到数 —— 加个条件节点 (op 用 notEmpty) 分开走。`
        );
      }
    }
    // 同一组里字段的"必填"标记自相矛盾: 有的必填有的选填, 运行期按"组里有必填成员就整组必给"算,
    // 跟界面上看到的标记对不上, 这里提醒一下免得作者以为选填那项能单独控制。
    for (const g of names) {
      const members = grouped.filter((f) => f.group === g);
      if (members.some((f) => f.required) && members.some((f) => !f.required)) {
        warnings.push(
          `入口「${g}」组内既有必填又有选填的项 (${members.map((f) => f.label + (f.required ? '必填' : '选填')).join(' / ')})。` +
          `整组的规则是"组里只要有必填成员, 就必须给一个", 单独把某一项标成选填不会让它变成可选。`
        );
      }
    }
  }

  // ---- 用真实表结构核对 (schema 由调用方注入, core 不依赖数据库) ----
  //
  // 两件能静态判定、又最常导致"跑出来是空的/走错分支"的事:
  //   1. 声明的输出列在真实表里不存在 —— 只在 SQL 没有 JOIN、且该列在 SQL 里也一个字都找不到时报
  //      (是别名/表达式列的话名字会出现在 SQL 里, 那种放行, 免得误伤)。
  //   2. 条件里对**数字列**做文本比较 —— 数字列跟 '未入库' 比永远不成立, 不报错、只走错分支。
  if (schema) {
    const wordRe = (s) => new RegExp('(^|[^\\w$])' + String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^\\w$]|$)', 'i');
    for (const n of queries) {
      const cols = n.table ? schema[n.table] : null;
      if (!cols) continue;                       // 这张表没看过结构, 不判
      const sql = String(n.sql || '');
      const hasJoin = /\bjoin\b/i.test(sql);
      for (const c of (n.outputs || [])) {
        if (!c.key) continue;
        if (Object.prototype.hasOwnProperty.call(cols, c.key)) continue;
        if (hasJoin) continue;                   // JOIN 时列可能来自别的表, 静态判断不了
        if (wordRe(c.key).test(sql)) continue;   // 是别名/表达式列 (名字出现在 SQL 里)
        warnings.push(`取数节点「${n.title}」声明的输出列「${c.key}」在表 ${n.table} 里不存在, 这条 SQL 里也没出现 —— 下游引用它会拿到空值。`);
      }
    }
    // 条件: 数字列 vs 文本比较
    const typeOfRef = (ref) => {
      const key = String(ref == null ? '' : ref).trim().replace(/^\{\{\s*/, '').replace(/\s*\}\}$/, '');
      const parts = key.split('.');
      if (parts.length < 2) return '';
      const node = e.nodes.find((x) => x.id === parts[0] && x.type === 'query');
      if (!node) return '';
      const col = (node.outputs || []).find((x) => x.key === parts[1]);
      if (col && col.type) return col.type;
      const sc = node.table && schema[node.table];
      if (sc && sc[parts[1]] && sc[parts[1]].type) {
        const t = String(sc[parts[1]].type).toLowerCase();
        if (/int|num|decimal|float|double|real|bigint|smallint/.test(t)) return 'number';
        if (/char|text|varchar|clob|string|uuid/.test(t)) return 'string';
      }
      return '';
    };
    for (const n of e.nodes.filter((x) => x.type === 'condition')) {
      for (const it of flattenCmp(n.expr)) {
        if (typeOfRef(it.left) !== 'number') continue;
        if (!['==', '!=', '>', '>=', '<', '<='].includes(it.op)) continue;
        const r = String(it.right == null ? '' : it.right).trim();
        if (r === '' || /^-?\d+(\.\d+)?$/.test(r)) continue;   // 右值也是数字 -> 没问题
        warnings.push(`条件节点「${n.title}」拿数字列「${it.left}」和文本「${it.right}」比较 —— 数字列不会等于一段文字, 这一条很可能永远不成立。核对下这一列的真实取值。`);
      }
    }
  }

  // 环检测
  const adj = new Map();
  for (const n of e.nodes) adj.set(n.id, []);
  for (const ed of e.edges) adj.get(ed.from).push(ed.to);
  const color = new Map();
  let cycle = false;
  const dfs = (id) => {
    color.set(id, 1);
    for (const nx of adj.get(id) || []) {
      if (color.get(nx) === 1) { cycle = true; return; }
      if (!color.get(nx)) dfs(nx);
      if (cycle) return;
    }
    color.set(id, 2);
  };
  for (const n of e.nodes) { if (!color.get(n.id)) dfs(n.id); if (cycle) break; }
  if (cycle) errors.push('流程里存在环, 会无限循环。请检查连线。');

  // 可达性
  const reach = new Set();
  const stack = inputs.map((n) => n.id);
  while (stack.length) {
    const cur = stack.pop();
    if (reach.has(cur)) continue;
    reach.add(cur);
    for (const nx of adj.get(cur) || []) stack.push(nx);
  }
  const orphan = e.nodes.filter((n) => !reach.has(n.id));
  if (orphan.length) {
    warnings.push(`有 ${orphan.length} 个节点从入口走不到: ${orphan.map((n) => n.title).join('、')}`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** 从入口出发算可达节点 (拓扑序)。用于执行器与界面预览。 */function executionPlan(engine) {
  const e = normalizeEngine(engine);
  const byId = new Map(e.nodes.map((n) => [n.id, n]));
  const outEdges = new Map();
  for (const ed of e.edges) {
    if (!outEdges.has(ed.from)) outEdges.set(ed.from, []);
    outEdges.get(ed.from).push(ed);
  }
  const starts = e.nodes.filter((n) => n.type === 'input').map((n) => n.id);
  const order = [];
  const seen = new Set();
  const stack = starts.slice();
  while (stack.length) {
    const id = stack.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const ed of outEdges.get(id) || []) stack.push(ed.to);
  }
  return { engine: e, byId, outEdges, order, edgeCount: e.edges.length };
}

/* ==================== SQL 参数绑定 ==================== */

/**
 * 把 {{key}} 换成实际值。
 *
 * 尊重作者的引号: 占位符写在字符串字面量里面 ('{{payNo}}') 就只替换内容
 * 并做转义; 写在外面 ({{id}}) 就按字面量代入 —— 数字不套引号, 其余套引号。
 * 作者对类型的意图由此变得明确, 不必让运行时去猜列的类型。
 */
function sqlLiteral(v) {
  if (v === null || v === undefined || v === '') return 'NULL';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  const s = String(v);
  // 看起来是纯数字就按数字给, 免得 Postgres 这类强类型库拿 int 列跟字符串比
  if (/^-?\d+(\.\d+)?$/.test(s.trim())) return s.trim();
  return "'" + s.replace(/'/g, "''") + "'";
}

function escapeInsideString(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/'/g, "''");
}

/**
 * 按库类型给标识符 (表名/列名) 套引号。
 *
 * MySQL 只认反引号, 双引号会被当成字符串 —— 写成 "tbl" 直接语法错误。
 * MSSQL 用方括号, Postgres / SQLite 用双引号。
 *
 * 放在这里而不是各写一份: 测试 Agent 的 sample_column 早就用对了,
 * 搭建 Agent 的 look_at_data 自己手写了一遍双引号, 结果在 MySQL 上必挂。
 * 这类"同一个动作两份实现"是重复代码最容易出事的地方。
 */
function quoteIdent(name, type) {
  const t = String(name || '');
  if (type === 'mysql') return '`' + t.replace(/`/g, '') + '`';
  if (type === 'mssql') return '[' + t.replace(/]/g, '') + ']';
  return '"' + t.replace(/"/g, '""') + '"';
}

/**
 * 索引查询结果里有没有这一列。
 *
 * 别写成 `rows.some(x => JSON.stringify(x).includes(column))` —— 那是错的:
 * MySQL 的返回行里键名就叫 column_name, 它**自带 "name" 这个子串**, 于是任何叫
 * name 的列都会被判成"有索引"。这是句假话, 而 name 是最常见的列名之一。
 * (同样会被误判的还有 unique / seq —— 键名 non_unique / seq 里都有。)
 *
 * 所以只看**值**:
 *   - MySQL 走 information_schema.STATISTICS -> 有 column_name 字段, 精确比
 *   - PostgreSQL 走 pg_indexes -> 只给 indexdef 全文, 按标识符边界匹配
 *
 * 放在这里而不是各自的 agent 里: 搭建 Agent 和测试 Agent 都要用同一份判断,
 * 抄两份就一定会有一份忘了改。
 */
function indexHasColumn(rows, column) {
  const want = String(column || '');
  if (!want) return false;
  const esc = want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^\\w$])${esc}([^\\w$]|$)`);
  return (rows || []).some((x) => {
    if (!x) return false;
    if (x.column_name != null) return String(x.column_name) === want;
    if (x.columnName != null) return String(x.columnName) === want;
    if (x.indexdef != null) return re.test(String(x.indexdef));
    return false;
  });
}

function bindParams(sql, params) {
  const src = String(sql || '');
  let out = '';
  let i = 0;
  let inStr = false;
  const missing = [];
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'") {
      // 串内的 '' 是转义单引号, 来回切换后仍是"在串内", 正好符合预期
      inStr = !inStr;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '{' && src[i + 1] === '{') {
      const end = src.indexOf('}}', i + 2);
      if (end !== -1) {
        const key = src.slice(i + 2, end).trim();
        const has = Object.prototype.hasOwnProperty.call(params, key);
        if (!has) missing.push(key);
        const v = has ? params[key] : undefined;
        out += has ? (inStr ? escapeInsideString(v) : sqlLiteral(v)) : '';
        i = end + 2;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return { sql: out, missing };
}

/**
 * 找出 SQL / 结论模板里用到的占位符名字。
 *
 * 必须认得循环 {{#each 节点.rows}}...{{/each}}, 三条规则:
 *  - 循环源本身 (节点.rows) 算一个引用;
 *  - 循环体里的**裸名**是"当前行的那一列", 记成 节点.列名 —— 不这么记的话,
 *    体检会把这些名字当成入口字段, 报一堆"找不到来源"的假硬错, 而运行时其实是好的;
 *  - {{@index}} 这类内建变量不是引用, 跳过。
 *
 * 返回的是**扁平字符串数组**, 调用方 (validateEngine / 搭建 Agent 的工具回执 / SQL 绑定)
 * 都按名字查有无, 所以循环体里的裸名要先限定到循环节点上再返回。
 */
function paramsOf(tpl) {
  const src = String(tpl || '');
  const out = [];
  const push = (k) => { if (k && !out.includes(k)) out.push(k); };
  const scan = (text, rowNode) => {
    const re = /\{\{\s*([^}]+?)\s*\}\}/g;
    let m;
    while ((m = re.exec(text))) {
      const k = m[1].trim();
      if (!k || k === '/each') continue;
      if (k.startsWith('#each')) { push(k.slice(5).trim()); continue; }
      if (k.startsWith('@')) continue;
      if (rowNode && !k.includes('.')) push(rowNode + '.' + k);
      else push(k);
    }
  };
  const loopRe = /\{\{#each\s+([^}]+?)\s*\}\}([\s\S]*?)\{\{\/each\}\}/g;
  let last = 0;
  let m;
  while ((m = loopRe.exec(src))) {
    scan(src.slice(last, m.index), null);
    const ref = m[1].trim();
    push(ref);
    scan(m[2], ref.split('.')[0]);
    last = loopRe.lastIndex;
  }
  // 尾巴: 如果这里还留着一个没配对的 {{#each X}}, 它后面那段仍然算"在循环体里" ——
  // 不然那些裸名会被记成入口字段, 体检会额外报一堆假的"找不到来源",
  // 把真正该看的那条"循环没配对"淹掉。
  const tail = src.slice(last);
  const open = /\{\{#each\s+([^}]+?)\s*\}\}/.exec(tail);
  if (open) {
    scan(tail.slice(0, open.index), null);
    push(open[1].trim());
    scan(tail.slice(open.index + open[0].length), open[1].trim().split('.')[0]);
  } else {
    scan(tail, null);
  }
  return out;
}

/**
 * 从 SELECT 里把"会产出的列名"抠出来 —— 只看最外层的逗号, 别名优先。
 *
 * 用途是**提前发现"声明了但查不出"**: 作者在 outputs 里写了 ack_state,
 * 但 SQL 里其实 SELECT 的是别的列, 下游引用全落空, 而校验只看 outputs 声明,
 * 一声不吭。这里不做完整 SQL 解析, 抠不到就返回空数组 (调用方据此不报警)。
 */
function selectAliases(sql) {
  const s = String(sql || '');
  const m = /^\s*select\s+(?:distinct\s+)?([\s\S]*?)\s+from\s/i.exec(s);
  if (!m) return [];
  const body = m[1];
  // 按顶层逗号切分 (忽略括号里的逗号)
  const parts = [];
  let depth = 0;
  let cur = '';
  let inStr = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "'") { inStr = !inStr; cur += ch; continue; }
    if (!inStr && ch === '(') depth += 1;
    if (!inStr && ch === ')') depth -= 1;
    if (!inStr && ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);

  const out = [];
  for (const raw of parts) {
    const p = raw.trim();
    if (!p) continue;
    if (p === '*') return [];                       // SELECT * 无法静态确定列名
    if (/^[a-z_][\w$]*\s*\.\s*\*$/i.test(p)) return [];
    // 显式别名: ... AS xxx  (xxx 可能带引号)
    const as = /(?:\bas\b)\s+["`\[]?([A-Za-z_][\w$]*)["`\]]?\s*$/i.exec(p);
    if (as) { out.push(as[1]); continue; }
    // 没写 AS: 取最后一段标识符 (a.b -> b; count(*) -> 抠不到)
    const tail = /["`\[]?([A-Za-z_][\w$]*)["`\]]?\s*$/.exec(p);
    if (tail && !/\)$/.test(p)) out.push(tail[1]);
  }
  return Array.from(new Set(out));
}

/* ==================== 条件求值 ==================== */

/** 取一个引用值。支持 n2.status (取数节点首行该列)、n2.rowCount、以及入口字段名 */
function resolveRef(ref, ctx) {
  // 引用有两种写法, 两种都得认:
  //   SQL 模板里: {{docNo}} / {{n1.col}}  —— 花括号是模板语法的一部分
  //   条件表达式里: docNo / n1.col       —— 按惯例是裸的
  //
  // 作者 (和模型) 很容易在条件里也写成花括号。那时候这里会拿 '{{docNo}}'
  // 去 ctx.inputs 里找, 找不到 -> undefined -> `notEmpty` 恒为 false ->
  // **分支永远走"假"那条**, 而且一声不吭。实测踩到过: 三个入口的任选其一
  // 全都不生效, 最后总是落到最后一条兜底分支上。
  // 所以这里统一剥掉花括号, 两种写法等价。
  const path = String(ref || '').trim()
    .replace(/^\{\{\s*/, '')
    .replace(/\s*\}\}$/, '');
  if (!path) return undefined;
  const parts = path.split('.');
  const head = parts[0];
  const rest = parts.slice(1);

  let root;
  if (ctx.nodes[head]) {
    const node = ctx.nodes[head];
    if (rest.length === 0) return node;
    if (rest[0] === 'rowCount') return node.rowCount;
    if (rest[0] === 'ok') return node.ok;
    if (rest[0] === 'error') return node.error;
    if (rest[0] === 'rows' && /^\d+$/.test(rest[1] || '')) {
      const row = (node.rows || [])[Number(rest[1])];
      return row && rest[2] ? row[rest[2]] : row;
    }
    // 默认: 首行 + 列名
    const first = (node.rows || [])[0] || {};
    return first[rest[0]];
  }
  // 不是节点, 那就是入口字段
  return ctx.inputs[path];
}

/**
 * 在已经跑过的取数节点里, 按列名倒着找第一个有值的首行单元格。
 *
 * 用于「分支查询 -> 合并到一个出口」: 作者只画一个出口, 模板里写的是其中一支的节点,
 * 另一支跑完后没人给值。这时按列名兜底, 作者就不用为每条分支各画一个出口。
 * 只在模板渲染时启用, 不参与条件求值与参数绑定 —— 那两处必须严格按作者写的引用走。
 */
function findColumn(col, ctx) {
  if (!col || !ctx || !ctx.nodes) return undefined;
  const ids = Object.keys(ctx.nodes);
  for (let i = ids.length - 1; i >= 0; i--) {
    const node = ctx.nodes[ids[i]];
    const first = node && node.rows && node.rows.length ? node.rows[0] : null;
    if (first && Object.prototype.hasOwnProperty.call(first, col)) return first[col];
  }
  return undefined;
}

function compare(left, op, right) {
  if (op === 'empty') return left === undefined || left === null || String(left).trim() === '';
  if (op === 'notEmpty') return !(left === undefined || left === null || String(left).trim() === '');
  if (op === 'contains') return String(left == null ? '' : left).includes(String(right));
  if (op === 'notContains') return !String(left == null ? '' : left).includes(String(right));

  const l = left === undefined || left === null ? '' : String(left);
  const r = right === undefined || right === null ? '' : String(right);
  const ln = Number(l);
  const rn = Number(r);
  const bothNumeric = l.trim() !== '' && r.trim() !== '' && Number.isFinite(ln) && Number.isFinite(rn);

  switch (op) {
    case '==': return bothNumeric ? ln === rn : l === r;
    case '!=': return bothNumeric ? ln !== rn : l !== r;
    case '>': return bothNumeric ? ln > rn : l > r;
    case '>=': return bothNumeric ? ln >= rn : l >= r;
    case '<': return bothNumeric ? ln < rn : l < r;
    case '<=': return bothNumeric ? ln <= rn : l <= r;
    default: return false;
  }
}

function evalExpr(expr, ctx) {
  if (!expr) return false;
  if (expr.type === 'group') {
    const items = (expr.items || []).map((x) => evalExpr(x, ctx));
    return expr.logic === 'or' ? items.some(Boolean) : items.every(Boolean);
  }
  return compare(resolveRef(expr.left, ctx), expr.op, expr.right);
}

/** 把规则翻译成人话, 给界面和运行日志用 */
const OP_WORD = {
  '==': '等于', '!=': '不等于', '>': '大于', '>=': '大于等于', '<': '小于', '<=': '小于等于',
  contains: '包含', notContains: '不包含', empty: '为空', notEmpty: '有值'
};

function describeExpr(expr, byId) {
  if (!expr) return '(未配置)';
  if (expr.type === 'group') {
    const sep = expr.logic === 'or' ? ' 或 ' : ' 且 ';
    return '(' + (expr.items || []).map((x) => describeExpr(x, byId)).join(sep) + ')';
  }
  // 取数节点声明过输出列时优先用列的中文名, 读起来才是给操作人看的话
  const label = (ref) => {
    const parts = String(ref || '').split('.');
    const node = byId && byId.get ? byId.get(parts[0]) : null;
    const tail = parts.slice(1).join('.');
    if (!node) return String(ref || '');
    if (!tail) return node.title;
    if (tail === 'rowCount') return node.title + '.行数';
    const col = (node.outputs || []).find((c) => c.key === tail);
    return node.title + '.' + ((col && col.label) || tail);
  };
  const word = OP_WORD[expr.op] || expr.op;
  switch (expr.op) {
    case 'empty':
    case 'notEmpty': return `${label(expr.left)} ${word}`;
    case 'contains':
    case 'notContains': return `${label(expr.left)} ${word}「${expr.right}」`;
    default: {
      const rhs = expr.right === undefined || expr.right === null || expr.right === '' ? '' : JSON.stringify(expr.right);
      return `${label(expr.left)} ${word}${rhs ? ' ' + rhs : ''}`;
    }
  }
}

/* ==================== 模板渲染 ==================== */

/**
 * 结论模板支持三种引用:
 *   {{节点.列名}}                      取首行那一列
 *   {{节点.rows}}                      把整个结果集铺成一张 markdown 表格
 *   {{#each 节点.rows}} ... {{/each}}  逐行渲染, 循环体里的裸名 = 当前行的那一列
 *
 * 为什么必须有多行: 「把这个 PO 的单据明细全列出来」这类结论本身就**是一张清单**。
 * 以前只能拿到首行 —— 作者写 {{节点.rows}} 校验还放行 (refStatus 认这个名字),
 * 渲染出来却永远是空的, 一声不吭。要拼清单只能靠节点.rows[0]、rows[1]… 一行行写死,
 * 行数一变就漏。
 */
const PLACEHOLDER_RE = /\{\{\s*([^}]+?)\s*\}\}/g;
const EACH_RE = /\{\{#each\s+([^}]+?)\s*\}\}([\s\S]*?)\{\{\/each\}\}/g;

/** 值转文本: NULL 留空, 对象转 JSON —— 和单值占位符同一套口径 */
function cellText(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** markdown 表格里 | 和换行会破坏结构, 必须转义 */
function cellMd(v) {
  return cellText(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * 把一个取数节点的整个结果集渲染成 markdown 表格。
 * 列名优先用驱动给的元数据 (node.columns), 不靠 rows[0] 反推 —— 空结果集反推不出列名,
 * 而"这个 PO 一行都没查到"恰恰是最该把表头摆出来的时候。
 */
function rowsToMarkdown(node) {
  const rows = (node && node.rows) || [];
  const cols = (node && node.columns && node.columns.length)
    ? node.columns.slice()
    : Object.keys(rows[0] || {});
  if (!rows.length || !cols.length) return '（无数据）';
  const lines = [
    '| ' + cols.join(' | ') + ' |',
    '| ' + cols.map(() => '---').join(' | ') + ' |'
  ];
  for (const r of rows) lines.push('| ' + cols.map((c) => cellMd(r[c])).join(' | ') + ' |');
  return lines.join('\n');
}

/** 单个占位符 -> 文本。节点.rows 走整表, 其余走引用解析 + 分支兜底 */
function placeholderValue(key, ctx) {
  const tableRef = /^(.+?)\.rows$/.exec(key);
  if (tableRef && ctx.nodes[tableRef[1]]) return rowsToMarkdown(ctx.nodes[tableRef[1]]);
  let v = resolveRef(key, ctx);
  // 引用的是「节点.列」但那个节点这一轮没跑 (走了另一条分支) —— 按列名在跑过的节点里兜底
  if (v === undefined && key.includes('.')) v = findColumn(key.split('.').slice(1)[0], ctx);
  if (v === undefined || v === null) return '';
  return cellText(v);
}

/**
 * 展开 {{#each 节点.rows}}...{{/each}}。只支持一层 —— 嵌套会让"这个裸名是谁的列"
 * 变成猜谜, 校验里直接拦下 (validateEngine 会报错), 这里遇到也退化成空并记一条 problems。
 */
function expandEach(tpl, ctx, used, problems) {
  return String(tpl || '').replace(EACH_RE, (whole, refRaw, body) => {
    const ref = String(refRaw).trim();
    if (/\{\{#each\b/.test(body)) {
      problems.push(`循环体里又套了一层 {{#each ${ref}}} —— 不支持嵌套循环。`);
      return '';
    }
    used.push(ref);
    const parts = ref.split('.');
    const head = parts[0];
    const rest = parts.slice(1).join('.');
    const node = ctx.nodes[head];
    if (!node || (rest && rest !== 'rows')) {
      problems.push(`{{#each ${ref}}} 只能遍历「取数节点.rows」, 这个引用取不到结果集。`);
      return '';
    }
    const rows = node.rows || [];
    return rows.map((row, i) => String(body).replace(PLACEHOLDER_RE, (__, raw2) => {
      const k = String(raw2).trim();
      if (!k || k.startsWith('#each') || k === '/each') return '';
      if (k === '@index') return String(i + 1);   // 序号从 1 开始, 给人看的
      if (k.startsWith('@')) return '';
      if (!k.includes('.')) {
        if (Object.prototype.hasOwnProperty.call(row, k)) return cellText(row[k]);
        // 行里没有这个裸名: 先当入口字段 (入口字段在循环里照样能用), 其余记成
        // 节点.列名 —— 这样体检能直接指出"是这一列没查出来", 而不是含糊地说找不到
        if (ctx.inputs && Object.prototype.hasOwnProperty.call(ctx.inputs, k)) {
          used.push(k);
          return cellText(ctx.inputs[k]);
        }
        used.push(head + '.' + k);
        return '';
      }
      used.push(k);
      return placeholderValue(k, ctx);
    })).join('');
  });
}

function renderTemplate(tpl, ctx, byId) {
  const used = [];
  const problems = [];
  // 1) 先把循环展开成纯文本
  let text = expandEach(tpl, ctx, used, problems);
  // 2) 再处理普通占位符
  text = text.replace(PLACEHOLDER_RE, (_, raw) => {
    const key = String(raw).trim();
    if (!key) return '';
    if (key === '/each' || key.startsWith('#each')) {
      // 走到这里说明循环标记没配上对 (配上的在第 1 步就消掉了)
      const ref = key.startsWith('#each') ? key.slice(5).trim() : '';
      if (ref) used.push(ref);
      problems.push(`模板里有没配对的 {{${key}}} —— 循环要成对写成 {{#each 节点.rows}}...{{/each}}。`);
      return '';
    }
    if (key.startsWith('@')) return '';   // 循环外的 @index 没有意义
    used.push(key);
    return placeholderValue(key, ctx);
  });
  // 缺失要在兜底之后再算, 不然走了分支的正常情况会被误报成缺失
  const missing = used.filter((k) => {
    const tableRef = /^(.+?)\.rows$/.exec(k);
    if (tableRef && ctx.nodes[tableRef[1]]) return false;   // 整表引用是好的, 别误报
    if (resolveRef(k, ctx) !== undefined) return false;
    if (k.includes('.') && findColumn(k.split('.').slice(1)[0], ctx) !== undefined) return false;
    return true;
  });
  return { text, missing, used, problems };
}

/* ==================== 执行器 ==================== */

/**
 * 给一条只读 SQL 套一层行数上限 (探针跑用)。
 *
 * 探针要回答的是"这条 SQL 跑得通吗、字段对不对、走哪条分支", 不看全量 —— 行一多
 * 就慢, 而慢的不是逻辑。套一层 LIMIT 把"结果集"卡住。
 *
 * 直接改写成什么方言: mysql/pg/sqlite 用 `... LIMIT N`, mssql 用 `SELECT TOP N`。
 * 先剥掉结尾的分号, 否则套进子查询会语法错。
 */
function wrapProbe(sql, dialect, n) {
  const body = String(sql || '').trim().replace(/;+\s*$/, '');
  const k = Math.max(1, Math.floor(Number(n) || 1));
  if (dialect === 'mssql') return `SELECT TOP ${k} * FROM (\n${body}\n) AS _solodb_probe`;
  return `SELECT * FROM (\n${body}\n) AS _solodb_probe LIMIT ${k}`;
}

/**
 * 确定性执行器。
 *
 * 按连边走, 不允许模型临时改路线 —— 这正是流程卡与分析模式的分界。
 * 一路发 phase/query_result/... 事件, 让界面能把每一步实时滚出来
 * (不弹确认框: 路线是管理员预先审过的, 不是模型临场决定的)。
 */
class EngineRunner {
  /**
   * @param engine   流程卡定义
   * @param databases 可用的数据库列表 (含 id/name/type/database)
   * @param openDb    异步函数 (dbConf) => Database 实例, 由调用方注入, 便于测试
   */
  constructor({ engine, databases, openDb, sampleRows, reuse, probeRows }) {
    this.engine = normalizeEngine(engine);
    this.plan = executionPlan(this.engine);
    this.databases = Array.isArray(databases) ? databases : [];
    this.openDb = openDb;
    // 每一步回传多少行给界面看。默认 5 (够确认"查到了东西"), 排查的时候调大。
    this.sampleRows = Math.max(1, Math.min(50, sampleRows || 5));
    // 探针跑: >0 就给每条取数 SQL 套一层行数上限 (见 wrapProbe)。0 = 正常全量。
    this.probeRows = Math.max(0, Math.floor(Number(probeRows) || 0));
    // ---- 复用上次跑出来的节点结果 ----
    //
    // 为什么需要: 改一个节点的 SQL 不该把整张卡重跑一遍。实测一次搭建会话里
    // run_test 被叫了 16 次、总共 33 分钟 (占全部工具时间的 99.7%), 而其中
    // 大半只是在调同一个节点的引号问题 —— 另外三个取数节点根本没变,
    // 却每次都要跟着重新查一遍库。
    //
    // reuse 是 { 节点id: { rows, columns, rowCount, ok } }。命中的节点**不查库**,
    // 直接把上次的结果放回 ctx.nodes —— 下游节点照样能解析 {{它.列}}。
    // 只对 type==='query' 生效: input/condition/output 本身就是纯计算, 跳过没意义。
    this.reuse = reuse && typeof reuse === 'object' ? reuse : null;
    this.reused = [];
    // 本次跑图每条取数 SQL 实际跑出了什么 —— 供下次试跑复用 (见 run 里取数那段)。
    this.queryCache = {};
    // 本次跑图打开的连接。挂在实例上而不是 run() 的局部变量里,
    // 这样调用方可以在 finally 里兜底回收 —— run() 中途抛出时也要关得掉。
    this._dbHandles = [];
  }

  /**
   * 关闭本次跑图打开的所有连接。可以重复调用 (Database.close 对未建连的实例是空操作)。
   * 调用方应当放在 finally 里: run() 内部正常路径也会调一次, 但异常路径只有靠这里。
   */
  async closeAll() {
    const handles = this._dbHandles;
    this._dbHandles = [];
    for (const db of handles) {
      try { await db.close(); } catch (err) { /* 关不掉也不该挡住主流程 */ }
    }
  }

  async run(inputs, onEvent) {
    const emit = (e) => { if (onEvent) onEvent(e); };
    const e = this.plan.engine;
    const ctx = { inputs: Object.assign({}, inputs), nodes: {} };
    const steps = [];
    const openDbHandles = this._dbHandles;

    emit({ type: 'engine_start', engineId: e.id, engineName: e.name, inputs: ctx.inputs });

    // ---- 校验入口输入 ----
    const inputNode = e.nodes.find((n) => n.type === 'input');
    if (!inputNode) throw new Error('这张流程卡没有入口节点');
    const chk = checkInputs(inputNode.fields, ctx.inputs);
    if (!chk.ok) {
      const err = new Error('缺少必要输入: ' + chk.missingLabels);
      err.missingInputs = chk.missing;
      err.missingGroups = chk.missingGroups;
      err.missingLabels = chk.missingLabels;
      throw err;
    }

    // ---- 走图 ----
    const byId = this.plan.byId;
    const outEdges = this.plan.outEdges;
    let cursor = inputNode.id;
    const visited = new Set();
    const MAX_STEPS = 200;

    while (cursor && steps.length < MAX_STEPS) {
      const node = byId.get(cursor);
      if (!node) break;
      if (visited.has(cursor)) {
        emit({ type: 'engine_error', message: `节点「${node.title}」被重复执行, 疑似成环, 已中止。` });
        break;
      }
      visited.add(cursor);

      const step = { id: node.id, type: node.type, title: node.title };
      steps.push(step);

      // ---- 入口 ----
      if (node.type === 'input') {
        emit({ type: 'engine_phase', nodeId: node.id, nodeType: 'input', title: node.title, message: '接收输入' });
      }

      // ---- 取数 ----
      else if (node.type === 'query') {
        // 上次的结果还能用就不查库 —— 直接放回上下文。
        //
        // 判据是"**渲染出来的 SQL 与上次逐字节相同**", 而不是"节点没被改过"。
        // 光看节点改没改是不够的: 上游行数变了, 同一个节点的参数也会变,
        // 拿旧结果就会给出错误结论。所以先把参数重算一遍再比。
        const cached = this.reuse && this.reuse[node.id];
        if (cached && cached.ok && typeof cached.sql === 'string' && Array.isArray(cached.rows)) {
          const probeParams = {};
          for (const key of paramsOf(node.sql)) {
            let v = resolveRef(key, ctx);
            if (v === undefined && (node.fields || []).some((f) => f.key === key)) {
              const byCol = findColumn(key, ctx);
              if (byCol !== undefined) v = byCol;
            }
            if (v !== undefined) probeParams[key] = v;
          }
          if (ctx.inputs && typeof ctx.inputs === 'object') {
            for (const k of Object.keys(ctx.inputs)) if (!(k in probeParams)) probeParams[k] = ctx.inputs[k];
          }
          const probe = bindParams(node.sql, probeParams);
          if (probe.missing.length === 0 && probe.sql === cached.sql) {
            ctx.nodes[node.id] = {
              rows: cached.rows,
              columns: cached.columns || [],
              rowCount: cached.rowCount != null ? cached.rowCount : cached.rows.length,
              ok: true,
              reused: true
            };
            step.sql = probe.sql;
            step.table = node.table;
            step.rowCount = ctx.nodes[node.id].rowCount;
            step.columns = ctx.nodes[node.id].columns;
            step.elapsedMs = 0;
            step.reused = true;
            this.reused.push(node.id);
            emit({
              type: 'engine_query_result',
              nodeId: node.id,
              rowCount: step.rowCount,
              columns: step.columns,
              elapsedMs: 0,
              reused: true,
              sample: cached.rows.slice(0, this.sampleRows)
            });
            // 自己推进游标 —— 下面那套(算参数、发事件、查库、找下一跳)整段跳过了
            const rEdges = outEdges.get(node.id) || [];
            const rNext = rEdges.find((x) => x.port === 'out') || rEdges[0];
            cursor = rNext ? rNext.to : null;
            continue;
          }
        }
        const dbConf = this.databases.find((d) => d.id === node.databaseId);
        if (!dbConf) {
          const msg = `取数节点「${node.title}」指向的数据库不存在 (可能已被删除)`;
          step.error = msg;
          emit({ type: 'engine_error', nodeId: node.id, message: msg });
          break;
        }
        const params = {};
        const blankParams = [];
        for (const key of paramsOf(node.sql)) {
          let v = resolveRef(key, ctx);
          // 「引用前面的」: 这条 SQL 的参数来自上游节点时, 作者只要在输入项里声明过它,
          // 就允许按列名去前面跑过的节点里找值 (跟上一条取数的输出列同名即可)。
          // 只对**声明过**的输入兜底 —— 没声明的一律不兜, 免得把拼错的参数名静默圆过去。
          if (v === undefined && (node.fields || []).some((f) => f.key === key)) {
            const byCol = findColumn(key, ctx);
            if (byCol !== undefined) v = byCol;
          }
          if (v !== undefined) params[key] = v;
          // 有来源、但这一轮取到的是空 —— 占位符照旧会被换成 '' 或 NULL。
          // 这不是"跑得通", 是"查询条件被抹掉了": 它会静默地查全表、或者一条都查不出,
          // 而报错信息完全指不到真正的原因 (作者看到的是 WHERE po_no = '' 这种怪句)。
          if (v === undefined || v === null || String(v).trim() === '') blankParams.push(key);
        }
        if (ctx.inputs && typeof ctx.inputs === 'object') {
          for (const k of Object.keys(ctx.inputs)) if (!(k in params)) params[k] = ctx.inputs[k];
        }
        const bound = bindParams(node.sql, params);
        if (bound.missing.length) {
          const msg = `取数节点「${node.title}」的 SQL 引用了没有来源的参数: ${bound.missing.join(', ')}`;
          step.error = msg;
          emit({ type: 'engine_error', nodeId: node.id, message: msg, sql: bound.sql });
          break;
        }
        // 先换好占位符再播这一步: 界面上摆的是真正要跑的那句, 拿出去就能直接查。
        // (带 {{}} 的模板没法和库对上, 摆出来只会让人以为 SQL 有问题)
        // 探针跑: 套一层行数上限再发给库 —— 界面上仍显示作者写的那句 (未套壳的)。
        const runSql = this.probeRows > 0 ? wrapProbe(bound.sql, dbConf.type, this.probeRows) : bound.sql;
        emit({ type: 'engine_phase', nodeId: node.id, nodeType: 'query', title: node.title, message: '正在取数...', sql: bound.sql, table: node.table, blankParams, probe: this.probeRows > 0 });
        step.sql = bound.sql;
        step.table = node.table;
        step.blankParams = blankParams;
        if (this.probeRows > 0) step.probe = true;

        let db = null;
        try {
          db = await this.openDb(dbConf);
          openDbHandles.push(db);
          const res = await db.query(runSql);
          ctx.nodes[node.id] = {
            rows: res.rows || [],
            columns: res.columns || [],
            rowCount: res.rowCount != null ? res.rowCount : (res.rows || []).length,
            ok: true
          };
          step.rowCount = ctx.nodes[node.id].rowCount;
          step.elapsedMs = res.elapsedMs;
          step.columns = res.columns;
          // 记下"这条 SQL 跑出了什么" —— 下次试跑如果 SQL 没变, 直接拿它复用,
          // 不必再查一遍库 (见构造函数里的 reuse)。只存内存, 不往事件里塞:
          // 事件会被写进对话史, 把全量行带进去会把上下文撑爆。
          this.queryCache[node.id] = {
            // 存**实际跑的那句** (探针时是套了行数上限的) —— 这样一次全量跑不会把
            // 探针的截断结果当成"同一句"复用, 反过来也一样。
            sql: runSql,
            rows: ctx.nodes[node.id].rows,
            columns: ctx.nodes[node.id].columns,
            rowCount: ctx.nodes[node.id].rowCount,
            ok: true
          };
          emit({
            type: 'engine_query_result',
            nodeId: node.id,
            rowCount: step.rowCount,
            columns: step.columns,
            elapsedMs: step.elapsedMs,
            sample: (res.rows || []).slice(0, this.sampleRows)
          });
        } catch (err2) {
          const msg = (err2 && err2.message) || String(err2);
          ctx.nodes[node.id] = { rows: [], columns: [], rowCount: 0, ok: false, error: msg };
          step.error = msg;
          // 空参数是独立的一件事, 得单独说: 库那边只会说"这一列不存在"或"语法不对",
          // 作者顺着报错去改列名, 改完还是查不出东西 —— 因为条件其实早就被抹掉了。
          const hint = blankParams.length
            ? `另外: 这一步的参数 ${blankParams.join('、')} 这一轮取到的是空值 (上游那个节点要么没查到行, 要么那一列本身就是 NULL), 代入后 SQL 里的条件变成了 WHERE ... = '' 这种被抹掉的写法。`
            : '';
          emit({ type: 'engine_error', nodeId: node.id, message: msg, sql: bound.sql, blankParams, hint });
          break;
        }
      }

      // ---- 条件 ----
      else if (node.type === 'condition') {
        const pass = evalExpr(node.expr, ctx);
        step.condition = describeExpr(node.expr, byId);
        step.result = pass;
        emit({
          type: 'engine_phase',
          nodeId: node.id,
          nodeType: 'condition',
          title: node.title,
          message: `判断${pass ? '成立' : '不成立'}: ${step.condition}`,
          pass
        });
        const edges = outEdges.get(node.id) || [];
        const want = pass ? 'true' : 'false';
        const next = edges.find((x) => x.port === want) || edges.find((x) => x.port === 'out');
        if (!next) {
          const msg = `条件「${node.title}」的「${pass ? '成立' : '不成立'}」出口没有接线, 流程在此中断。`;
          step.error = msg;
          emit({ type: 'engine_error', nodeId: node.id, message: msg });
          break;
        }
        cursor = next.to;
        continue;
      }

      // ---- 出口 ----
      else if (node.type === 'output') {
        const r = renderTemplate(node.template, ctx, byId);
        step.text = r.text;
        // problems 是模板**结构**上的毛病 (循环没配对、嵌套、遍历了非 .rows 的东西):
        // 它和 missing 不是一回事 —— missing 是"值没取到", 这个是"模板本身写坏了"。
        // 存盘前的 validateEngine 会拦, 这里再报一次是为了"绕过校验直接跑"的路径也能看见。
        emit({
          type: 'engine_output',
          nodeId: node.id,
          text: r.text,
          missing: r.missing,
          problems: r.problems || []
        });
      }

      // 顺着连线走
      const edges = outEdges.get(node.id) || [];
      const next = edges.find((x) => x.port === 'out') || edges[0];
      cursor = next ? next.to : null;
    }

    // 关闭本次打开的连接
    await this.closeAll();

    const outputs = steps.filter((s) => s.type === 'output' && s.text);
    const answer = outputs.length ? outputs.map((s) => s.text).join('\n\n') : '';
    emit({ type: 'engine_done', engineId: e.id, engineName: e.name, steps });

    return {
      ok: true,
      engineId: e.id,
      engineName: e.name,
      steps,
      answer,
      outputs: outputs.map((s) => ({ nodeId: s.id, title: s.title, text: s.text })),
      error: steps.find((s) => s.error) ? steps.find((s) => s.error).error : null
    };
  }
}

/* ==================== 只看不跑: 把 SQL 渲染出来 ==================== */

/**
 * 把某个取数节点的 SQL **按当前上下文渲染出来**, 但不发给数据库。
 *
 * 为什么要有它: 跨库传参这类毛病, 症状全是"查出来 0 行", 而 0 行既可以是真的没有,
 * 也可以是参数被套错了引号。分不清就只能反复试跑 —— 实测有会话为这一个问题
 * 试跑了 4 次, 每次 80~255 秒。而真正要看的东西 (渲染后的 SQL 长什么样) 一秒钟就能算出来。
 *
 * @param card    卡定义
 * @param nodeId  要看的取数节点
 * @param nodes   上游节点的结果 { 节点id: {rows, columns, rowCount} } —— 通常来自上一次真跑
 * @param inputs  入口值
 */
function previewSql(card, nodeId, nodes, inputs) {
  const e = normalizeEngine(card);
  const node = e.nodes.find((n) => n.id === nodeId);
  if (!node) return { error: `没找到节点 ${nodeId}。` };
  if (node.type !== 'query') return { error: `节点「${node.title}」不是取数节点, 没有 SQL 可看。` };

  // 拼一个最小可用的上下文: 入口值 + 传进来的上游结果。
  // 只需要 resolveRef / findColumn 能取到值, 别的字段运行时用不到。
  const ctx = { inputs: Object.assign({}, inputs || {}), nodes: Object.assign({}, nodes || {}) };
  const params = {};
  const blank = [];
  for (const key of paramsOf(node.sql)) {
    let v = resolveRef(key, ctx);
    if (v === undefined && (node.fields || []).some((f) => f.key === key)) {
      const byCol = findColumn(key, ctx);
      if (byCol !== undefined) v = byCol;
    }
    if (v === undefined) continue;
    params[key] = v;
    if (v === '' || v === null) blank.push(key);
  }

  const bound = bindParams(node.sql, params);
  // 每个参数代入的是什么, 一并交出去 —— 「值本身对不对」和「代入方式对不对」
  // 是两个不同的毛病, 只看渲染结果分不出来。
  const detail = Object.keys(params).map((k) => {
    const v = params[k];
    const shown = Array.isArray(v) ? `数组(${v.length} 项): ${JSON.stringify(v.slice(0, 6))}` : JSON.stringify(v);
    return { key: k, value: shown, literal: sqlLiteral(v) };
  });

  return {
    nodeId: node.id,
    title: node.title,
    sql: bound.sql,
    missing: bound.missing,
    blank,
    params: detail,
    // 参数代入前的原文, 方便对照"我写的是什么 / 渲染成了什么"
    template: node.sql
  };
}

/* ==================== 试跑 (画板右上角「测试」) ==================== */

/**
 * 把一张卡按样例输入跑一遍, 收集每一步的结果。
 *
 * 和 EngineRunner 的区别只是"给谁看": Runner 面向运行时 (要的是结论),
 * 这里面向作者 (要的是"哪一步出了什么事")。所以除了结论, 还把
 * 每步的 SQL、行数、条件判定、以及"引用没落地"的位置一并收上来。
 *
 * @param card      卡定义 (允许是还没保存的草稿)
 * @param inputs    入口字段的样例值
 * @param databases 数据库配置列表
 * @param openDb    (conf) => Database
 */
/**
 * 把一次 run 的原始结果 + 事件流, 整理成给界面看的形状。
 *
 * 单跑和批量跑共用这一段 —— 两边各写一份的话, "每一步查回来的前几行"这种
 * 细节迟早会有一边漏掉, 而症状是"批量跑看不到数据"这种莫名其妙的表现。
 */
function finalizeRun(res, events, sampleRows) {
  // 把"这一步查回来的前几行"贴回对应的 step 上。
  // 排查"查出来是空的 / 值不对"的时候, 几行常常不够看清分布, 所以默认给 20 行。
  const byNode = new Map();
  for (const ev of events) {
    if (ev.type === 'engine_query_result') byNode.set(ev.nodeId, ev);
  }
  for (const st of res.steps) {
    const ev = byNode.get(st.id);
    if (!ev) continue;
    st.sample = ev.sample || [];
    st.sampleTruncated = (ev.rowCount || 0) > (ev.sample || []).length;
  }

  const refIssues = events
    .filter((ev) => ev.type === 'engine_output' && Array.isArray(ev.missing) && ev.missing.length)
    .flatMap((ev) => ev.missing);
  const blanks = events
    .filter((ev) => ev.type === 'engine_phase' && Array.isArray(ev.blankParams) && ev.blankParams.length)
    .flatMap((ev) => ev.blankParams);
  const errEvent = events.find((ev) => ev.type === 'engine_error');
  return {
    ok: !errEvent,
    answer: res.answer,
    error: errEvent ? errEvent.message : null,
    hint: errEvent ? errEvent.hint || '' : '',
    steps: res.steps,
    missingRefs: Array.from(new Set(refIssues)),
    blankParams: Array.from(new Set(blanks)),
    outputs: res.outputs,
    sampleRows
  };
}

/**
 * 批量共用连接时, 每一轮拿到的"壳"。
 *
 * EngineRunner 跑完会 closeAll() 把它拿到过的连接全关掉 —— 单跑时这是对的,
 * 但批量时它会把**整批共用**的那条连接关掉, 后面几轮就全炸了 (而且症状是
 * "第一单正常, 后面几单全报连不上", 看起来像库的问题)。
 *
 * 所以给每轮一个关不掉的壳, 真正的关闭由批量层在 finally 里统一做一次。
 * 只包 query: EngineRunner 从连接上只用到 query 和 close (见 run 里那两处)。
 */
function sharedHandle(db) {
  return {
    type: db && db.type,
    config: db && db.config,
    query: (sql) => db.query(sql),
    close: async () => { /* 整批共用的连接, 单轮不许关 */ }
  };
}

/** 按库配置缓存连接, 整批共用一套; closeAll 由批量层在 finally 里调 */
function makeSharedOpener(openDb) {
  const cache = new Map();
  const opened = [];
  return {
    open(conf) {
      const key = (conf && (conf.id || conf.name || conf.database)) || '__default__';
      if (!cache.has(key)) {
        const p = Promise.resolve().then(() => openDb(conf));
        cache.set(key, p);
        opened.push(p);
      }
      return cache.get(key).then(sharedHandle);
    },
    async closeAll() {
      for (const p of opened) {
        try {
          const db = await p;
          if (db && typeof db.close === 'function') await db.close();
        } catch (e) { /* 关不掉不该挡住主流程 */ }
      }
      opened.length = 0;
      cache.clear();
    }
  };
}

/**
 * 一张卡 + **N 组输入** —— 批量跑。
 *
 * 为什么需要它:
 *   卡本身没有循环构造 (NODE_TYPES 只有 input/query/condition/output), 一组输入
 *   跑一遍。"帮我看看这 3 张单的入库情况" 是最常见的用法, 而以前只能手工跑 3 次 ——
 *   每跑一次重填一遍单号, 结果还要自己抄到一起, 单数一多就不现实了。
 *
 * 为什么不做成"循环节点":
 *   循环要引入子图和每轮的变量作用域, 会同时改动**图语义 / 执行模型 / 界面**三处,
 *   而且现有卡都得重画。批量跑只是把同一张卡跑 N 遍 —— 一张现有卡都不用改。
 *
 * 一轮失败不拖死整批:
 *   第 2 单查不到, 不该让第 1、3 单的结果也拿不到。每轮各自接住异常, 结果里
 *   带着各自的 error。
 *
 * @param card       卡定义
 * @param inputSets  [{ poNo: 'A' }, { poNo: 'B' }, ...]
 * @param databases  数据库配置列表
 * @param openDb     (conf) => Database
 * @param opts       { sampleRows, concurrency, cancel, onEvent }
 *        cancel 形如 { v: false } —— 与搭建/自测的取消令牌同一形状
 */
async function testEngineBatch(card, inputSets, databases, openDb, opts = {}) {
  const sets = (Array.isArray(inputSets) ? inputSets : []).filter((x) => x && typeof x === 'object' && !Array.isArray(x));
  const sampleRows = Math.max(1, Math.min(50, opts.sampleRows || 20));
  // 并发默认 4: 单跑一次 100~300ms, 4 路已经能把"3 单"压到一次往返的时间,
  // 又不至于让库那边觉得我们在打它。
  const concurrency = Math.max(1, Math.min(8, opts.concurrency || 4));
  const probeRows = Math.max(0, Math.floor(Number(opts.probeRows) || 0));
  const cancel = opts.cancel || null;
  const emit = (e) => { if (opts.onEvent) opts.onEvent(e); };

  const shared = makeSharedOpener(openDb);
  const runs = [];
  let cancelled = false;

  const runOne = async (inputs, index) => {
    const t0 = Date.now();
    const runner = new EngineRunner({ engine: card, databases, openDb: shared.open, sampleRows, probeRows });
    const events = [];
    try {
      // 给单轮内部的每个事件标上"第几单" —— 批量跑时界面会把 N 单的
      // "正在取数"混在一起滚, 没有这个标记根本分不清谁是谁。
      const res = await runner.run(inputs, (ev) => {
        const tagged = Object.assign({ __index: index }, ev);
        events.push(tagged);
        emit(tagged);
      });
      return Object.assign({ index, inputs, elapsedMs: Date.now() - t0 }, finalizeRun(res, events, sampleRows));
    } catch (e) {
      // 一轮炸了不能拖死整批
      return {
        index, inputs, elapsedMs: Date.now() - t0,
        ok: false, answer: '', error: (e && e.message) || String(e), hint: '',
        steps: [], missingRefs: [], blankParams: [], outputs: [], sampleRows
      };
    } finally {
      // 这里只清 runner 自己的引用, 共享连接由下面的 finally 统一关
      await runner.closeAll();
    }
  };

  try {
    for (let i = 0; i < sets.length; i += concurrency) {
      if (cancel && cancel.v) { cancelled = true; break; }
      const wave = sets.slice(i, i + concurrency);
      emit({ type: 'engine_batch_wave', from: i, count: wave.length, total: sets.length });
      const done = await Promise.all(wave.map((inputs, k) => runOne(inputs, i + k)));
      for (const r of done) {
        runs.push(r);
        emit({
          type: 'engine_batch_item',
          index: r.index, total: sets.length, ok: r.ok,
          inputs: r.inputs, answer: r.answer, error: r.error
        });
      }
    }
  } finally {
    await shared.closeAll();
  }

  runs.sort((a, b) => a.index - b.index);
  const okCount = runs.filter((r) => r.ok).length;
  const failCount = runs.length - okCount;

  // 按"输出节点"归堆, 让界面能一眼看出"3 单里有 2 单落在同一个结论上"。
  // 这是纯统计, 不解释业务含义 —— 含义由卡自己决定。
  const buckets = [];
  for (const r of runs) {
    const key = (r.outputs || []).map((o) => o.nodeId).join('|') || '(无输出)';
    let b = buckets.find((x) => x.key === key);
    if (!b) {
      b = { key, nodeId: (r.outputs && r.outputs[0] && r.outputs[0].nodeId) || null, title: (r.outputs && r.outputs[0] && r.outputs[0].title) || '', count: 0, inputs: [] };
      buckets.push(b);
    }
    b.count += 1;
    b.inputs.push(r.inputs);
  }

  return {
    ok: failCount === 0 && !cancelled,
    total: sets.length,
    ran: runs.length,
    okCount,
    failCount,
    cancelled,
    runs,
    buckets,
    sampleRows
  };
}

async function testEngine(card, inputs, databases, openDb, opts) {
  // 每一步回传多少行给界面看 —— 测试面板上"节点下面挂着它的返回"要的就是这个
  const sampleRows = Math.max(1, Math.min(50, (opts && opts.sampleRows) || 20));
  // reuse: 上次试跑存下来的 { 节点id: {sql, rows, columns, rowCount} }。
  // 传了它, SQL 没变的节点就不再查库 —— 这是"改一个节点不该重跑全卡"的落点。
  const reuse = (opts && opts.reuse) || null;
  // 探针跑: 给每条取数 SQL 套行数上限, 只验"跑得通 / 字段对 / 分支走向"(见 wrapProbe)。
  const probeRows = (opts && opts.probeRows) || 0;
  const runner = new EngineRunner({ engine: card, databases, openDb, sampleRows, reuse, probeRows });
  const events = [];
  let res;
  try {
    res = await runner.run(inputs, (ev) => events.push(ev));
  } finally {
    // 跑挂了也要把连接收回去 (run() 的异常路径不会走到它自己的 closeAll)
    await runner.closeAll();
  }

  const out = finalizeRun(res, events, sampleRows);
  // 把这次的查询结果带出去, 让调用方存起来给下一次用。
  // 只对**真跑过**的节点更新: 复用来的结果没必要再覆盖一遍。
  out.queryCache = runner.queryCache;
  out.reused = runner.reused.slice();
  return out;
}

module.exports = {
  NODE_TYPES,
  NODE_LABEL,
  CMP_OPS,
  OUTPUT_TYPES,
  normalizeOutputCol,
  wrapProbe,
  genId,
  newEngine,
  normalizeEngine,
  normalizeScope,
  checkInputs,
  validateEngine,
  executionPlan,
  bindParams,
  paramsOf,
  selectAliases,
  sqlLiteral,
  quoteIdent,
  indexHasColumn,
  resolveRef,
  findColumn,
  evalExpr,
  compare,
  describeExpr,
  renderTemplate,
  normalizeNode,
  collectRefs,
  EngineRunner,
  testEngine,
  testEngineBatch,
  previewSql
};
