'use strict';

/**
 * 意图路由层。
 *
 * 一次判断要解决三个问题:
 *   1. 用户是在跟你说话, 还是让你干活? —— 闲聊 vs 取数
 *   2. 如果是干活, 是"分析型"(要探索、要出报告)还是"流程型"(规则明确、照着卡跑)?
 *   3. 如果是流程型, 命中哪一张卡?
 *
 * 这三问合成一次调用, 所以闲聊路径和取数路径的往返次数跟以前一样, 没多花钱。
 *
 * 命中多张卡时不硬猜 —— 由 Router 这一层"调研引擎"通过问答把范围缩小。
 *
 * **什么时候停由模型判断** (见 buildRouterPrompt 的输出契约): 有把握就 run,
 * 没把握就 ask, 分不出来就 choose 让用户自己挑。代码只兜三件事 ——
 * 不许跑候选之外的卡、问的轮数有上限、只剩一张时不必再花一次调用 (见 decideNext)。
 * 这样"跑错卡"不会因为模型一时自信而发生, 但"该不该再问一句"也不用代码替它拿主意。
 */

const MAX_ROUNDS = 3;      // 最多问几轮
const CHOOSE_AT = 3;       // 候选缩到这个数以内就不再问了, 直接弹出来让人选
const CONFIDENT = 0.6;     // 唯一命中但置信度低于这个值, 先确认一句再跑

const INTENT_MAX_TOKENS = 4096;

/* ==================== 目录: 把卡翻译成给模型看的清单 ==================== */

/** 只把启用的卡列给闸门 —— 停用的卡不该被命中 */
function usableEngines(engines) {
  return (Array.isArray(engines) ? engines : []).filter((e) => e && e.enabled !== false && e.id);
}

/** 这张卡碰哪些表 —— 匹配时最有用的一条线索, 比如"提到了采购订单" */
function tablesOf(engine) {
  const out = [];
  for (const n of (engine && engine.nodes) || []) {
    if (n && n.type === 'query' && n.table && !out.includes(n.table)) out.push(n.table);
  }
  return out;
}

/**
 * 给界面用的概览: 这张卡要用户给什么。
 *
 * 分成"必须给的"和"任选其一的组"两摞, 因为界面上这两者的提示语完全不同 ——
 * 前者是"请提供 X", 后者是"以下给一个就行"。
 */
function inputsOf(engine) {
  const node = ((engine && engine.nodes) || []).find((n) => n && n.type === 'input');
  const fields = ((node && node.fields) || []).filter((f) => f && (f.label || f.key));
  const plain = fields.filter((f) => !f.group).map((f) => f.label || f.key);
  const groups = [];
  for (const f of fields) {
    if (!f.group) continue;
    let g = groups.find((x) => x.name === f.group);
    if (!g) { g = { name: f.group, labels: [] }; groups.push(g); }
    g.labels.push(f.label || f.key);
  }
  // 扁平的一份, 给只想要"有哪些输入"的调用方 (兼容老形状: 原来返回的就是个字符串数组)
  return { plain, groups, all: plain.concat(...groups.map((g) => g.labels)) };
}

/**
 * 把一张卡翻译成清单里的一行。
 *
 * 这里要把字段的「说明」也带上 —— 用户说"查一下 DN2024xxxx"时, 路由器得能看出
 * 这个值属于「送货单号」这一项, 才能判定该命中哪张卡。只给字段名不够:
 * 三张卡都可能有个叫「单号」的入口。
 */
function engineLine(engine, i) {
  const bits = [`${i + 1}. id=${engine.id} 名称=${engine.name || '未命名'}`];
  if (engine.description) bits.push(`用途=${engine.description}`);
  const tables = tablesOf(engine);
  if (tables.length) bits.push(`涉及表=${tables.join('/')}`);

  const node = ((engine && engine.nodes) || []).find((n) => n && n.type === 'input');
  const fields = ((node && node.fields) || []).filter((f) => f && f.key);
  if (fields.length) {
    const one = (f) => (f.desc ? `${f.label || f.key}(${f.desc})` : (f.label || f.key));
    const plain = fields.filter((f) => !f.group).map(one);
    if (plain.length) bits.push(`需要的输入=${plain.join('/')}`);
    const groups = [];
    for (const f of fields) {
      if (!f.group) continue;
      let g = groups.find((x) => x.name === f.group);
      if (!g) { g = { name: f.group, members: [] }; groups.push(g); }
      g.members.push(f);
    }
    for (const g of groups) {
      bits.push(`【任选其一】${g.name}=${g.members.map(one).join(' 或 ')}`);
    }
  }

  const ex = (Array.isArray(engine.examples) ? engine.examples : []).filter(Boolean).slice(0, 3);
  if (ex.length) bits.push(`例句=${ex.map((x) => `「${x}」`).join('')}`);
  return bits.join(' | ');
}

function engineCatalogText(engines) {
  const list = usableEngines(engines);
  if (!list.length) return '(当前没有配置任何流程卡)';
  return list.map(engineLine).join('\n');
}

/**
 * 一张卡的"说明书", 给模型看的。
 *
 * engineLine 是**一行**的压缩版, 给路由做候选比对用; 这个是展开版, 给模型
 * 真正决定"要不要用它、要用它就得给我什么"时读。
 *
 * 为什么要把入参的说明和备注都摆出来: 用户手里可能同时有几个格式接近的单号
 * (送货单号 / 采购订单号 / 发票号), 模型得知道"这一项长什么样、从哪来"才敢
 * 判断用户给的那个值是哪一项。只给中文名不够 —— "发票号"和"红字发票号"
 * 光看名字分不出来。
 */
function engineBriefText(engine) {
  const b = engineBrief(engine);
  const lines = [`### ${b.name}`, `- id: ${b.id}`];
  lines.push(`- 目的: ${b.description || '(这张卡没有写描述)'}`);
  if (b.examples.length) lines.push(`- 什么时候用: ${b.examples.map((x) => `「${x}」`).join(' ')}`);
  if (b.tables.length) lines.push(`- 会读的表: ${b.tables.join(', ')}`);

  // 直接读字段本身, 不走 inputsOf —— 那个为了给界面用只返回了标签字符串,
  // 拿不到 key / 说明 / 必填。这里要的正是那些。
  const node = ((engine && engine.nodes) || []).find((n) => n && n.type === 'input');
  const fields = ((node && node.fields) || []).filter((f) => f && f.key);
  if (!fields.length) {
    lines.push('- 入参: 不需要任何入参, 直接跑');
    return lines.join('\n');
  }

  const one = (f) => `${f.key} (${f.label || f.key})` +
    (f.required === false ? ' [选填]' : ' [必填]') +
    (f.desc ? ` — ${f.desc}` : ' — (这项没写说明)');

  lines.push('- 入参:');
  for (const f of fields.filter((x) => !x.group)) lines.push(`  - ${one(f)}`);

  const groups = [];
  for (const f of fields) {
    if (!f.group) continue;
    let g = groups.find((x) => x.name === f.group);
    if (!g) { g = { name: f.group, members: [] }; groups.push(g); }
    g.members.push(f);
  }
  for (const g of groups) {
    lines.push(`  - 【任选其一】${g.name} —— 下面这些**给一个就够**, 不要硬凑齐:`);
    for (const f of g.members) lines.push(`    - ${one(f)}`);
  }
  return lines.join('\n');
}

/** 给界面用: 一张卡的概览 */
function engineBrief(engine) {
  return {
    id: engine.id,
    name: engine.name || '未命名流程卡',
    description: engine.description || '',
    tables: tablesOf(engine),
    inputs: inputsOf(engine),
    examples: (Array.isArray(engine.examples) ? engine.examples : []).filter(Boolean).slice(0, 3)
  };
}

/* ==================== 闸门: 三分契约 ==================== */

function gateContract(hasEngines) {
  const lines = [
    '## 这一轮只做判断',
    '',
    '只输出一个 JSON 对象, 不要输出任何其它文字, 也不要用代码块包裹。三种情况选一种:',
    '',
    '1) 用户在跟你说话 (自我介绍、问软件怎么用、闲聊、问现在几点/今天几号、评价上一轮结果、问你应该怎么用你):',
    '   ⚠️ 但"某个流程/制度/规则/口径是怎么规定的"**不算闲聊** —— 那需要依据才能答准,',
    '      不要用你的通识直接回答 (也不要说"通常是/一般是"), 归到 2) 并让 hints.rag=true。',
    '   {"intent": "chat", "reply": "你要回答用户的话"}',
    '',
    '2) 用户要你干活 —— 下面两类都算:',
    '   (a) 取数分析: 需要探索、比对、统计、出图、出报告, 结论要现算 → hints.sql=true',
    '   (b) 问制度/流程/规则/口径/名词解释/操作说明这类**需要依据**的问题 → hints.rag=true,',
    '       **不要凭通识直接回答**, 让下游去查知识库拿依据。',
    '   {"intent": "analysis", "hints": {"rag": true, "sql": false}}',
    ''
  ];
  if (hasEngines) {
    lines.push(
      '3) 用户要的是"按一张已经配好的流程卡查一下" —— 结论靠卡里写死的规则得出,',
      '   不需要探索: 例如"这个单号报错是啥原因"这种查一下就知道结果的问法:',
      '   {"intent": "engine", "engineId": "卡片的id", "confidence": 0.9, "candidates": ["最像的id","次像的id"]}',
      '',
      '   如果只有一张对得上, candidates 里就只放它一个, confidence 给 0-1 的把握。',
      '   如果有多张对得上, candidates 按相像程度从高到低列出 (最多 5 个), engineId 可以留空。',
      '   如果一张都对不上, 就不要写 engine, 归到 2)。',
      ''
    );
  } else {
    lines.push('3) (当前没有配置任何流程卡, 所以永远不要输出 engine 这种 intent)', '');
  }
  lines.push(
    '4) **你确实判断不出**用户是要闲聊、查数据、还是查文档, 且猜错代价大时 (例如只丢来一个没头没尾的短语) ——',
    '   不要瞎猜, 反问用户。给几个具体选项让它点一下就说清:',
    '   {"intent": "clarify", "question": "你是想… 还是…?", "options": ["选项一", "选项二"]}',
    '   ⚠️ 只在**真拿不准**时用; 能判断的一律按 1)/2)/3) 直接走, 别动不动就反问 (会让用户烦)。',
    '',
    '## 顺带给两个软提示 (不改变上面那三种判断, 只帮下游少走弯路)',
    '',
    '不管你判成 1) / 2) / 3) 中的哪一种, 都在 JSON 里多带一个 hints 字段:',
    '  {"intent": "analysis", "hints": {"rag": true, "sql": true}}',
    '',
    '- hints.rag: 要答好这个问题, 是否需要查**知识库/文档** (制度、口径、SLA、政策、名词解释、操作说明)。',
    '- hints.sql: 是否需要查**数据库里的数据** (统计、筛选、数值、明细、排名)。',
    '- 两者可以同时为 true —— 比如"按制度口径算一下各供应商的超期率": 既要查数据库, 也要查口径文档。',
    '- 拿不准就给 true: 这是**软提示**, 多查一次只是慢一点, 漏查才会答错。',
    '',
    '拿不准是 1) 还是 2) 的时候选 2)。判成闲聊却其实要取数, 是功能故障;',
    '多走一遍取数流程只是慢一点。',
    '',
    '**但这个"只是慢一点"有个前提: 数据库连得上。** 所以有一类例外必须归 1) ——',
    '**答案不碰数据库就能给的**: 现在几点、今天几号星期几、这个软件怎么用、',
    '你上一轮说的是什么意思。这类问题走取数路径不但答不出, 还要先连库,',
    '库连不上就整个失败 —— 用户问个时间, 收到的却是一条数据库报错。'
  );
  return lines.join('\n');
}

/**
 * 现在的时间, 给闸门用。
 *
 * 闸门是**唯一一次**能回答"现在是几点"这种问题的模型调用 —— 闲聊路径不碰数据库,
 * 答完就结束了。所以时间必须在这里就给到, 不能只放在取数路径的 contextBlock 里:
 * 那样的话"现在是几点"会被判成取数, 然后为了查个时间先去连库, 库一忙/一连不上
 * 整个问题就答不出来。
 */
function nowLine() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())} (${week})`;
}

function buildGatePrompt(promptConfig, engines) {
  const { intentPolicy } = require('./prompt');
  const list = usableEngines(engines);
  return [
    intentPolicy(promptConfig),
    '',
    '## 现在的时间',
    nowLine(),
    '问时间/日期/星期几这类问题的, 直接用这个回答, 归到 1) —— **不要为了查时间去连数据库**。',
    '',
    '## 可以命中的流程卡',
    '',
    engineCatalogText(list),
    '',
    gateContract(list.length > 0)
  ].join('\n');
}

/**
 * 把"最近几轮对话 + 这次要判的那句"拼成**一条** user 消息。
 *
 * 为什么不直接把历史按 user / assistant 交替喂进去:
 *   那样喂的话, 闸门看到的就是一段**多轮对话**, 它会开始模仿历史里 assistant
 *   的说话方式 —— 也就是长篇散文 —— 而不是按系统提示词输出那个 JSON。
 *
 *   实测 (2026-09-20, 真实历史 + "你会干啥，"):
 *     多轮结构    6/6 次输出散文, 解析失败
 *     压成一条    6/6 次输出 JSON, 判成 chat
 *
 *   解析失败会 fallback 到 analysis, 于是用户问一句"你会干啥"却看见
 *   "正在读取可访问的表…"。这就是那次扫表的真实成因。
 *
 * 信息一点没少 (历史照样给), 变的是**结构**: 它不再长得像一场对话,
 * 模型就不会去扮演对话里的角色。
 *
 * 助手那几轮还会被截断 —— 闸门只需要知道"刚才在聊什么", 不需要读完整篇。
 */
function gateInput(task, history) {
  const hist = (Array.isArray(history) ? history : [])
    .filter((h) => h && typeof h.content === 'string' && h.content.trim())
    .slice(-6);
  if (!hist.length) return task;

  const lines = [
    '## 刚才的对话 (只是背景, 帮你理解最后那句在说什么; 不是要你接着聊)',
    ''
  ];
  for (const h of hist) {
    const who = h.role === 'user' ? '用户' : '助手';
    lines.push(who + ': ' + h.content.replace(/\s+/g, ' ').trim().slice(0, 220));
  }
  lines.push('', '## 现在要判的是最后这一句', '', '用户: ' + task);
  return lines.join('\n');
}

/* ==================== 认闸门的输出 ==================== */

function extractJSON(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try {
    const obj = JSON.parse(t);
    if (obj && typeof obj === 'object') return obj;
  } catch (e) { /* 往下走, 试着抠出花括号里的内容 */ }
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a !== -1 && b > a) {
    try {
      const obj = JSON.parse(t.slice(a, b + 1));
      if (obj && typeof obj === 'object') return obj;
    } catch (e) { /* 认不出来 */ }
  }
  return null;
}

/**
 * 认闸门输出。认不出来返回 null, 调用方退回"分析"(最稳的那条路)。
 *
 * @returns {kind:'chat',reply} | {kind:'analysis'} | {kind:'engine',engineId,low,candidates}
 */
function parseRoute(text, engines) {
  const obj = extractJSON(text);
  if (!obj) return null;

  const list = usableEngines(engines);
  const known = new Map(list.map((e) => [e.id, e]));
  const rawKind = String(obj.intent || obj.type || '').toLowerCase().trim();

  // 软提示 (见 gateContract): 只作为 bias 传给下游, **不作分支**。
  // 缺省值刻意的: sql 默认 true (分析路径本来就要查库, 漏查更糟);
  // rag 默认 false (没配知识库时给 true 只会造成噪声)。
  const h = (obj.hints && typeof obj.hints === 'object') ? obj.hints : {};
  const hint = { rag: !!h.rag, sql: h.sql === undefined ? true : !!h.sql };

  if (/^(chat|reply|talk|闲聊|聊天|说话)$/.test(rawKind)) {
    const reply = String(obj.reply || obj.text || obj.message || '').trim();
    // 说是闲聊却没给话, 等于没判出来
    return reply ? { kind: 'chat', reply, hint } : null;
  }

  if (/^(engine|flow|card|流程|流程卡)$/.test(rawKind)) {
    // 一张卡都没配, 模型却说走流程卡 —— 只能按分析去做, 别把用户的话咽了
    if (!list.length) return { kind: 'analysis', hint };
    // 候选列表先洗干净: 只留真的存在的卡, 去重, 按给的顺序
    const ids = [];
    const push = (v) => {
      const id = String(v || '').trim();
      if (id && known.has(id) && !ids.includes(id)) ids.push(id);
    };
    if (Array.isArray(obj.candidates)) obj.candidates.forEach(push);
    else if (typeof obj.candidates === 'string') obj.candidates.split(/[,，\s]+/).forEach(push);
    push(obj.engineId);

    if (!ids.length) {
      // 说是流程卡却给不出任何有效的卡, 别硬撑 —— 退回分析
      return { kind: 'analysis', hint };
    }

    const raw = Number(obj.confidence);
    const confidence = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.5;
    const top = String(obj.engineId || ids[0]).trim();
    const engineId = known.has(top) ? top : ids[0];

    if (ids.length === 1) {
      return { kind: 'engine', engineId, low: confidence < CONFIDENT, candidates: ids, hint };
    }
    // 多张都对得上 -> 交给调研层缩小范围
    return { kind: 'route', candidates: ids.slice(0, 5), engineId, confidence, hint };
  }

  if (/^(clarify|ask|反问|澄清|unsure)$/.test(rawKind)) {
    const q = String(obj.question || obj.reply || obj.text || '').trim();
    if (!q) return null;   // 说要反问却没给问题 → 认不出来, 退回分析
    const options = Array.isArray(obj.options) ? obj.options.map(String).filter(Boolean).slice(0, 6) : [];
    return { kind: 'clarify', question: q, options, hint };
  }

  if (/^(task|work|query|analysis|取数|分析|干活)$/.test(rawKind)) return { kind: 'analysis', hint };
  return null;
}

/* ==================== 调研: 一轮淘汰 ==================== */

function buildRouterPrompt(candidates, original, qa, round) {
  const lines = [
    '## 你的角色',
    '',
    '用户想走一张已经配好的流程卡, 但有几张卡看起来都对得上。你的唯一任务是把范围缩小,',
    '不要替用户取数, 也不要回答业务问题。',
    '',
    '## 用户最初说的话',
    '',
    original || '(空)',
    ''
  ];
  if (qa && qa.length) {
    lines.push('## 已经问过的', '');
    qa.forEach((x, i) => lines.push(`${i + 1}. 你问: ${x.q}`, `   用户答: ${x.a || '(没答)'}`));
    lines.push('');
  }
  lines.push(
    `## 还剩下的候选卡 (第 ${round} 轮, 最多 ${MAX_ROUNDS} 轮)`,
    '',
    engineCatalogText(candidates),
    '',
    '## 你要输出什么',
    '',
    '只输出一个 JSON 对象, 不要有其它文字, 不要用代码块。**由你来决定这一步该做什么**:',
    '',
    '- 再问一句就能分清 -> {"action":"ask","question":"你要问用户的那一句话","options":["选项A","选项B"],"keep":["问完还想留着的id"]}',
    '- 已经有把握是哪一张了 -> {"action":"run","engineId":"那一个id","why":"你凭什么这么定"}',
    '- 你也分不出来, 该让用户自己挑 -> {"action":"choose","why":"为什么分不出来"}',
    '',
    '规则:',
    '- **问不问、跑不跑由你判断**, 不用凑轮数。有把握就直接 run, 没把握就 ask, 别为了稳妥反复追问。',
    '- 但只有一次机会: 问出去的每一个问题都必须真的能淘汰候选。',
    '- question 要短, 一句话, 而且要问"什么模块 / 什么操作 / 你要看哪一种"这类能直接淘汰候选的话。',
    '- **options 尽量给**: 2-6 个短选项, 用户点一下就能回答, 不用打字。',
    '  选项要是用户会说的话 (如「销售出库」「采购入库」), 不要写成卡片的 id。',
    '  确实只有自由回答才说得清时才不给 options。',
    '- 别解释你的推理过程, 别把候选卡的名字念一遍。',
    '- keep 只写候选里真实存在的 id, 且必须包含 engineId (如果你给了)。',
    '- run 的时候 why 里说清依据 —— 用户会看到你的判断理由, 跑错了也才知道是哪里认错了。',
    '- **拿不准就不要 run**。跑错一张卡给出的是"看着像结论的错结论", 比多问一句的代价大得多。'
  );
  return lines.join('\n');
}

/**
 * 解析调研层的输出。
 *
 * 兼容两种形状:
 *   新的 {action, engineId, keep, question, why}
 *   旧的 {keep, engineId, question} —— 没有 action, 由 decideNext 的老规则兜底
 */
function parseRouter(text, candidates) {
  const obj = extractJSON(text);
  if (!obj) return null;
  const ids = candidates.map((c) => c.id);
  const keep = [];
  const push = (v) => {
    const id = String(v || '').trim();
    if (ids.includes(id) && !keep.includes(id)) keep.push(id);
  };
  if (Array.isArray(obj.keep)) obj.keep.forEach(push);
  else if (typeof obj.keep === 'string') obj.keep.split(/[,，\s]+/).forEach(push);
  const engineId = String(obj.engineId || '').trim();
  if (engineId && ids.includes(engineId) && !keep.includes(engineId)) keep.push(engineId);

  const action = ['ask', 'run', 'choose'].includes(String(obj.action || '').trim())
    ? String(obj.action).trim()
    : '';

  // 问句的可点选项。最多 6 个, 太长的一律丢掉 —— 选项是给人点一下的, 不是一段话。
  // 这里故意"丢"而不是"截断": 截断出来的是半句话, 用户看到「你要看的是采购入库还是销售出
  // 库…」这种被切掉的标签反而更糊涂; 丢掉之后问题照常显示, 用户自己打字就行。
  const options = (Array.isArray(obj.options) ? obj.options : [])
    .map((x) => String(x == null ? '' : x).trim())
    .filter((s) => s && s.length <= 40)
    .slice(0, 6);

  return {
    keep: keep.length ? keep : ids.slice(),
    question: String(obj.question || '').trim(),
    options,
    engineId: ids.includes(engineId) ? engineId : '',
    action,
    why: String(obj.why || '').trim().slice(0, 300)
  };
}

/**
 * 安全阀 —— 不再是"决策者"。
 *
 * 该问还是该跑, 现在由模型判断 (见 buildRouterPrompt 的输出契约)。
 * 这里只兜住三件模型不该有权决定的事:
 *   1. 不能跑候选之外的卡 (engineId 必须来自候选, 否则等于凭空选一张)
 *   2. 问的轮数有上限 —— 模型可能一直觉得"再问一句更好", 用户会被问烦
 *   3. 只剩一张时直接跑, 不必再花一次模型调用
 *
 * 老形状 (模型没给 action) 仍然走原来的规则, 这样网关/缓存里存的老对话不会坏。
 */
function decideNext({ keep, engineId, keepCount, round, action }) {
  if (keepCount === 1) return { action: 'run', engineId: engineId || keep[0] };

  if (action === 'run') {
    // 模型说跑, 但它指的卡必须在候选里 —— 这是唯一的硬闸门
    if (engineId && keep.includes(engineId)) return { action: 'run', engineId };
    return { action: 'ask' };   // 指向了候选外/没指明 -> 当它没把握, 继续问
  }
  if (action === 'choose') return { action: 'choose', engineIds: keep.slice(0, CHOOSE_AT) };
  if (action === 'ask') {
    if (round >= MAX_ROUNDS) return { action: 'choose', engineIds: keep.slice(0, CHOOSE_AT) };
    return { action: 'ask' };
  }

  // 老形状: 没有 action, 按原来的规则推
  if (keepCount <= CHOOSE_AT) return { action: 'choose', engineIds: keep.slice() };
  if (round >= MAX_ROUNDS) return { action: 'choose', engineIds: keep.slice(0, CHOOSE_AT) };
  return { action: 'ask' };
}

/**
 * 走一轮调研。
 *
 * @param ask     (messages) => Promise<string>  调用模型
 * @param route   当前路由状态 { candidates:[id], original, qa:[], round }
 * @param allEngines 全部卡 (用来把 id 还原成卡)
 * @param answer  用户这一轮的回答 (第一轮没有)
 */
async function routeStep({ ask, route, allEngines, answer }) {
  const list = usableEngines(allEngines);
  const byId = new Map(list.map((e) => [e.id, e]));

  const candidates = (route.candidates || []).map((id) => byId.get(id)).filter(Boolean);
  if (!candidates.length) return { action: 'choose', engineIds: list.slice(0, CHOOSE_AT).map((e) => e.id) };
  if (candidates.length === 1) return { action: 'run', engineId: candidates[0].id };

  const qa = (route.qa || []).slice();
  if (answer != null) qa.push({ q: route.lastQuestion || '', a: String(answer) });
  // round = 已经问出去几轮。首次进来是 0, 每问出一个问题 +1。
  const round = route.round || 0;

  let out = null;
  try {
    const text = await ask([
      { role: 'system', content: buildRouterPrompt(candidates, route.original, qa, Math.max(1, round)) },
      { role: 'user', content: '请给出这一步。' }
    ]);
    out = parseRouter(text, candidates);
  } catch (e) {
    out = null;
  }

  // 模型没吐出可用的东西: 不硬问, 直接把候选端给操作人
  if (!out) return { action: 'choose', engineIds: candidates.slice(0, CHOOSE_AT).map((e) => e.id) };

  const keep = out.keep
    .map((id) => byId.get(id))
    .filter(Boolean);
  const next = decideNext({
    keep: out.keep, engineId: out.engineId,
    keepCount: keep.length, round, action: out.action
  });
  next.round = round;
  next.qa = qa;
  next.why = out.why || '';
  if (next.action === 'ask') {
    next.question = out.question || '你想看的是哪一种？';
    next.options = out.options || [];
    next.candidates = out.keep;
    next.lastQuestion = next.question;
    next.round = round + 1;   // 这一问已经问出去了
  } else if (next.action === 'choose') {
    next.candidates = next.engineIds;
  }
  return next;
}

module.exports = {
  MAX_ROUNDS,
  CHOOSE_AT,
  CONFIDENT,
  INTENT_MAX_TOKENS,
  usableEngines,
  tablesOf,
  engineCatalogText,
  engineBrief,
  engineBriefText,
  buildGatePrompt,
  gateInput,
  parseRoute,
  buildRouterPrompt,
  parseRouter,
  decideNext,
  routeStep,
  extractJSON
};
