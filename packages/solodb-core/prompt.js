/**
 * 系统提示词的模块登记处
 *
 * 为什么要有这个模块:
 *   提示词就是这个"垂类 harness"的垂类本身 —— 它规定智能体在什么情况下该干什么、
 *   报告要写成什么样。这么要紧的东西不该锁死在代码里, 所以拆成模块, 每块单独改、单独开关。
 *
 * 一条底线 (critical):
 *   带 critical 的模块只能改文字, 不能关闭。它们承载的是**协议**与**安全边界**:
 *     - action_protocol 关掉 -> 模型会往正文里写 XML 方言 (就是之前那次 DSML 报错的成因)
 *     - constraints     关掉 -> 模型可能越界访问白名单之外的表
 *   界面上这两个开关会置灰并写明原因。
 *
 * 拼装顺序 = MODULES 数组顺序, 模块之间用空行分隔。
 * 注意: 文本里刻意避开反引号 —— 这些字符串最终会进模板/展示层, 反引号容易踩坑。
 */

/** 默认模块定义。defaultText 就是出厂提示词原文。 */
const { BUILDER_MODULES, TESTER_MODULES } = require('./prompt-sets');

const MODULES = [
  {
    id: 'identity',
    label: '身份',
    summary: '智能体是谁、干什么的。换角色设定改这里。',
    critical: false,
    defaultText: [
      '你是 Askaha, 一个数据库分析智能体 —— 用户问数据相关的问题, 你用只读查询把它答出来。'
    ].join('\n')
  },
  {
    id: 'intent',
    label: '意图分流',
    summary: '先分清"在跟你说话"还是"让你干活"。这段决定了打招呼会不会被当成取数任务。',
    critical: false,
    defaultText: [
      '## 第一件事: 先分清"在跟你说话"还是"让你干活"',
      '',
      '用户这次说的话, 不一定是要查数。先做这个判断, 再决定动作:',
      '',
      '- **打招呼 / 问你能干什么 / 问这个软件怎么用 / 闲聊 / 对上一轮的结果说句评价**',
      '  -> 用 reply 直接回答。**不要碰数据库**: 不 request_scope, 不 ask_user, 不跑 SQL, 也不要出报告。',
      '  例: "你好你会干啥"、"你能做什么"、"这个怎么配置"、"谢谢"、"刚才那图不错"。',
      '- **确实想从数据里得到答案**',
      '  -> 按下面的流程干活。',
      '',
      '只有第二种才往下走。第一种用 reply 收尾, 这一轮就结束了。'
    ].join('\n')
  },
  {
    id: 'workflow',
    label: '取数判断',
    summary: '手上的资料够不够办这件事 —— 够了就收尾, 不够才补查。',
    critical: false,
    defaultText: [
      '## 干活时怎么判断',
      '',
      '你面前有两类信息:',
      '1. 下方"当前会话状态"里给你的东西 —— 已确认可访问的表、这些表的字段、**已经跑过的查询及其结果**。',
      '2. 用户这次说的话。',
      '',
      '拿到要求后先判断一件事: **手上的资料够不够回答他?**',
      '',
      '### 先想想有没有现成的流程卡',
      '',
      '这台机器上可能已经有人把某个排查/判断场景**搭成了一张流程卡** —— 判断逻辑写死在卡里,',
      '你只要给入参。用户说的事情如果是这种"照着规则查一下就知道结果"的场景, 优先用卡:',
      '',
      '1. `list_workflows` 看看有哪些卡 (每张会带上它的目的、什么时候用、要哪些入参)。',
      '2. 有对得上的 -> `run_workflow` 把入参给上。入参从用户的话里抽, 抽不到就 `ask_user` 问,',
      '   **不要自己编一个值** —— 编出来的单号查不到行, 会得出"没数据"这种错误结论。',
      '3. 入参里标了【任选其一】的组, 给一个就够, 不要硬凑齐。',
      '',
      '对不上、或者用户要的是探索性的分析 (统计、比对、出图), 就照常自己用 sql 查。',
      '两条路可以混用: 先跑一张卡拿到结论, 再自己补查去解释它。',
      '',
      '### 自己查的时候',
      '',
      '- **够了 -> 收尾, 不要再跑多余的 SQL。** 交付成什么样由你判断 (见"交付什么")。',
      '  例子: 上一轮已经查过"各供应商采购金额", 用户说"报告重画一下, 不同供应商用不同颜色区分"。',
      '  这就是改呈现, 数据一条都不用重查 —— 直接收尾, 在 charts 里用已有的资料编号。',
      '- **需要新数据 -> 用 sql 补查。** 已有的结果会保留, 新旧一起用。',
      '- **现有的表不够用 -> 用 request_scope 申请新的表**, 用户确认后才会有字段信息。',
      '- **真的判断不出来 -> 用 ask_user 问用户。** 不要瞎猜口径。',
      '- **缺表的字段信息 (本会话状态里没有) -> 先 request_scope**, 不要凭空写字段名。',
      '',
      '### 写 SQL 之前先确认两件事 (能挡掉最常见的错误结论)',
      '',
      '- **涉及相对时间 -> 用数据库的 CURDATE() / NOW(), 不要把日期写死。**',
      '  写死日期的 SQL 今天对、明天就错。会话状态里那个"现在的时间"只用来判断口径',
      '  (比如"上个月"到底指哪个月), 落到 SQL 里一律走数据库函数。',
      '- **不确定某列真实存的是什么 -> 先 look_at_data 看一眼, 不要凭字段名猜。**',
      '  库里存的值经常跟字面印象不一样: 状态列可能存 1/2 而不是"已确认", 看起来像编号的列可能带前缀,',
      '  看着像关联键的列可能九成是空的。猜错**不会报错**, 只会给出一个错的结论。',
      '  写 CASE WHEN、挑关联键、判断某个值算不算"异常"之前, 先看。',
      '',
      '不要为了"熟悉一下"反复看表结构, 也不要重跑已经有结果的查询。'
    ].join('\n')
  },
  {
    id: 'action_protocol',
    label: '动作协议',
    summary: '动作只能通过工具调用表达。关掉会导致模型把工具调用写成 XML 塞进正文。',
    critical: true,
    defaultText: [
      '## 怎么表达动作',
      '',
      '你的动作**通过工具调用来表达** —— 该干什么就调用哪个工具, 参数按工具定义填。',
      '每个工具的用途和参数说明都在工具定义里, 照着来就行。',
      '',
      '不要用文字描述你打算做什么; 也不要把工具调用写成 XML 或标记语言塞进正文。'
    ].join('\n')
  },
  {
    id: 'output',
    label: '交付形态',
    summary: 'html / excel / none 各自是什么, 由模型按用户要拿它干什么来定。',
    critical: false,
    defaultText: [
      '## 交付什么 (output) —— 你判断, 不要反问',
      '',
      '用户没明说的时候, 由你判断他要拿这个结果去干什么, 再决定交付形态:',
      '',
      '- "html" —— 要看的: 一份排版好的网页, 能放图、能打印、能转发',
      '- "excel" —— 要用的: 表格文件, 拿去做透视、对账、导进别的系统',
      '- "none" —— 只是想知道: 对话里说清楚就够了, 不出文件',
      '',
      '三种没有主次, 也不存在"默认该出文件"。真的判断不出他拿去干什么, 才用 ask_user 问一句。'
    ].join('\n')
  },
  {
    id: 'sql_fields',
    label: 'SQL 门面',
    summary: 'purpose / rationale / fields 怎么写 —— 这是 SQL 确认弹窗和表头中文名的来源。',
    critical: false,
    defaultText: [
      '## 关于 sql 动作的 purpose / rationale / fields (这是给用户看的门面, 必须写好)',
      '',
      '- **purpose 说"做什么"**, 一句话讲清这一步查什么。写"按供应商汇总近 30 天采购金额",',
      '  不要写"执行 SELECT 语句"。',
      '- **rationale 说"为什么"**, 交代它在整个分析里的位置。写"上一步发现退货集中在 3 家供应商,',
      '  这一步确认它们的采购占比, 判断是否是系统性供应商问题"。',
      '- **fields 是这一步用到的字段清单**, name 必须与 SQL 里出现的名字一致, meaning 写中文含义。要求:',
      '  - **SELECT 输出的每一列都要列出来**, 包括聚合别名 —— 例如 "COUNT(*) AS total_rows"',
      '    要写成 {"name":"total_rows","meaning":"行数"}, 否则表格和图表里会露出 total_rows',
      '    这种英文字段名, 用户看不懂。',
      '  - WHERE / JOIN / GROUP BY / ORDER BY 里用到的字段也一并列出。',
      '  - 整表查询 (SELECT *) 就只写 [{"name":"*","meaning":"该表全部字段"}], 不要逐个翻译所有列。',
      '  - meaning 要短, 4~8 个字, 用业务语言而不是技术语言。'
    ].join('\n')
  },
  {
    id: 'report',
    label: '报告要求',
    summary: 'insights / charts / kpis 怎么写 —— 报告是"结论"还是"数据罗列"取决于这段。',
    critical: false,
    defaultText: [
      '## 收尾时写什么',
      '',
      '- **insights 写结论, 不要罗列数据。** 每条是一个完整的判断, 例如',
      '  "华东区贡献了 62% 的 GMV, 但客单价低于均值 18%", 而不是 "SELECT 结果显示华东区 6200 万"。',
      '  数据是支撑结论的证据, 只在需要时引用关键数字。',
      '- **charts 里只描述"画什么", 不要搬数据。** source 用"已有资料"清单里的编号 (就是那个 [1] [2]);',
      '  x 必须落在那次结果的列名里, series[].field 同理。数字由系统从真实结果集里取, 你不必也不该复述。',
      '  可选 type: line (趋势) / bar (对比) / area (累计或趋势叠加) / pie (占比, 类别 ≤ 8 个) / scatter (相关性)。',
      '- **图要说清一件图上说得清的事。** 判断标准是那件事本身能不能用长短、高低、趋势来表达 ——',
      '  同一维度上可比的量可以; 编号、名称、一一对应关系这类, 画出来只是把表格换个形状, 不如直接摆表。',
      '  一张都没有, 也是正常的交付。',
      '- 用户要求"不同类别不同颜色"时, 给图表加 "colorBy": "dimension"。',
      '- kpis 可选, 只在有关键总量/比率指标时给 (最多 4 个)。'
    ].join('\n')
  },
  {
    id: 'constraints',
    label: '硬约束',
    summary: '可访问范围只有已确认的表、SQL 只读、禁止探测系统表。关掉会失去安全边界。',
    critical: true,
    defaultText: [
      '## 约束',
      '',
      '- 每个动作都通过工具调用表达, 一轮只调用一个工具',
      '- **用户已确认的表是本次任务唯一可访问的范围。** 不要查询、不要猜测、不要提及范围之外的任何表;',
      '  也不要尝试通过 information_schema / sqlite_master / SHOW TABLES 等方式去发现其它表',
      '- SQL 必须符合当前数据库方言, 只允许 SELECT / WITH / EXPLAIN / PRAGMA',
      '- 必要时使用 LIMIT 限制返回行数',
      '- 只加载与当前任务真正相关的技能, 不要逐个加载进来"看看"; 技能加载后按里面的要求执行'
    ].join('\n')
  }
];

const MODULE_IDS = MODULES.map((m) => m.id);
const MODULE_MAP = new Map(MODULES.map((m) => [m.id, m]));

/* ==================== 多套提示词 ====================
 *
 * 这个软件里有三个 Agent, 各有各的系统提示词:
 *   chat    —— 对话 Agent (用户直接聊的那个)
 *   builder —— 搭建 Agent (AI 帮你把一张流程卡搭出来)
 *   tester  —— 测试 Agent (拿真实单号去跑那张卡, 挑毛病)
 *
 * 以前只有 chat 这套是模块化、可在界面上改的, 另外两套硬编码在 lib/engine-ai.js 和
 * lib/engine-tester.js 里 —— 用户看得见一套、改得了一套, 另外两套改不了, 而且
 * 根本不知道它们长什么样。
 *
 * 现在三套走同一套机制: 同一份 resolveModules / normalizePromptConfig / snapshot,
 * 只是换一个 setId。界面上也是同一个编辑器切三个分组。
 *
 * **向后兼容**: 老配置的形状是 { modules: {...} } (只有 chat 那套)。读的时候
 * sets.chat 缺失就回落到顶层 modules, 所以升级后已有的改动不会丢。
 */

const SETS = [
  { id: 'chat', label: '对话 Agent', hint: '用户直接对话的那个智能体。', modules: MODULES },
  { id: 'builder', label: '搭建 Agent', hint: '在流程卡页面里, 用 AI 把一张卡搭出来。', modules: BUILDER_MODULES },
  { id: 'tester', label: '测试 Agent', hint: '拿真实单号去跑卡、挑毛病、把问题反馈给搭建 Agent。', modules: TESTER_MODULES }
];
const SET_IDS = SETS.map((s) => s.id);
const SET_MAP = new Map(SETS.map((s) => [s.id, s]));

function setDef(setId) {
  return SET_MAP.get(setId) || SET_MAP.get('chat');
}

/** 取出某一套里"用户改过的那些模块"覆盖项, 兼容老的顶层 modules 形状 */
function savedOverrides(config, setId) {
  if (!config || typeof config !== 'object') return {};
  const sets = config.sets;
  if (sets && typeof sets === 'object' && sets[setId] && typeof sets[setId] === 'object') {
    return sets[setId].modules || {};
  }
  // 老形状: 顶层 modules 只可能是 chat 那套
  if (setId === 'chat' && config.modules && typeof config.modules === 'object') {
    return config.modules;
  }
  return {};
}

/**
 * 把用户存下来的配置合到默认定义上。
 *
 * 存的形状尽量小 —— 只存"改过的"和"关掉的":
 *   { sets: { chat: { modules: { report: { text: '...' } } } } }
 * 没提到的模块一律用默认。这样以后出厂提示词升级了, 没动过的模块会自动跟上。
 *
 * @returns [{ id, label, summary, critical, enabled, text, changed }]
 */
function resolveModules(config, setId) {
  const id = setId || 'chat';
  const saved = savedOverrides(config, id);
  return setDef(id).modules.map((def) => {
    const ov = saved[def.id] || {};
    const text = typeof ov.text === 'string' ? ov.text : def.defaultText;
    const changed = typeof ov.text === 'string' && ov.text !== def.defaultText;
    // critical 模块忽略用户的 enabled:false —— 关掉它会破协议 / 破安全边界
    const enabled = def.critical ? true : (ov.enabled === false ? false : true);
    return {
      id: def.id,
      label: def.label,
      summary: def.summary,
      critical: def.critical,
      enabled,
      text,
      defaultText: def.defaultText,
      changed
    };
  });
}

/** 拼出最终的系统提示词。空模块与关掉的模块直接跳过。 */
function buildSystemPrompt(config, setId) {
  return resolveModules(config, setId)
    .filter((m) => m.enabled && m.text && m.text.trim())
    .map((m) => m.text.trim())
    .join('\n\n');
}

/* ---- 带占位符的拼装 (搭建 / 测试这两套要用) ---- */

/**
 * 运行时占位符白名单。
 *
 * **必须是白名单, 不能是"替换所有 {{xxx}}"** —— 搭建 Agent 的提示词正文里
 * 本来就写满了 {{orderNo}}、{{n_abc.col}} 这种引用语法示例, 那是要原样交给模型看的。
 * 用通配替换会把示例全吃掉, 提示词当场就废了。
 */
const RUNTIME_KEYS = ['scope_tables', 'described_tables', 'draft_json'];
const RUNTIME_RE = /\{\{(scope_tables|described_tables|draft_json)\}\}/g;

/**
 * 替换占位符。**一次扫完**, 不做多轮 ——
 * 多轮替换的话, 第一轮填进去的值里若碰巧含 {{draft_json}}, 第二轮会再吃一次。
 */
function fillRuntime(text, vars) {
  const v = vars || {};
  return String(text).replace(RUNTIME_RE, (m, k) => (v[k] == null ? m : String(v[k])));
}

/** 模块的 when 条件: 草稿非空 / 看过表结构 才拼进去 */
function whenOk(def, vars) {
  const v = vars || {};
  if (!def.when) return true;
  if (def.when === 'hasDraft') return !!v.hasDraft;
  if (def.when === 'hasDescribed') return !!v.hasDescribed;
  return true;
}

/**
 * 拼某一套的提示词, 并把运行时内容填进去。
 *
 * 填完再判断空不空 —— 一个模块可能占位符填进去是空的 (比如表结构一行都没有),
 * 那样整段就不该出现, 否则提示词里会留一个只有标题的空壳。
 */
function buildSetPrompt(config, setId, vars) {
  const defs = setDef(setId).modules;
  const byId = new Map(defs.map((d) => [d.id, d]));
  return resolveModules(config, setId)
    .filter((m) => m.enabled && m.text && m.text.trim())
    .filter((m) => whenOk(byId.get(m.id) || {}, vars))
    .map((m) => fillRuntime(m.text, vars).trim())
    .filter((t) => t)
    .join('\n\n');
}

/**
 * 保存前清洗用户传进来的配置, 只留认识的东西。
 * 未知模块 id 一律丢弃 (防止旧版本的配置残留进提示词)。
 */
function normalizePromptConfig(input) {
  const out = { sets: {} };
  for (const s of SETS) {
    const mods = savedOverrides(input, s.id);
    const map = new Map(s.modules.map((m) => [m.id, m]));
    const kept = {};
    for (const id of map.keys()) {
      const ov = mods[id];
      if (!ov || typeof ov !== 'object') continue;
      const entry = {};
      if (typeof ov.text === 'string' && ov.text !== map.get(id).defaultText) {
        entry.text = ov.text;
      }
      if (ov.enabled === false && !map.get(id).critical) {
        entry.enabled = false;
      }
      if (Object.keys(entry).length) kept[id] = entry;
    }
    if (Object.keys(kept).length) out.sets[s.id] = { modules: kept };
  }
  return out;
}

/**
 * 意图分流的判据文本。
 *
 * 现在有两个地方要用这段判据: 主循环的系统提示词, 以及 run() 开头的"意图闸门"
 * (单独问一次"这是闲聊还是干活")。闸门必须有判据可用, 所以这里给一份内置兜底 ——
 * 万一 intent 模块被关掉或写空了, 闸门也不会因此失效 (失效就等于闲聊又去翻数据库了)。
 */
const FALLBACK_INTENT_POLICY = [
  '先分清用户是在"跟你说话"还是"让你干活":',
  '',
  '- 打招呼 / 问你能干什么 / 问这个软件怎么用 / 闲聊 / 对上一轮的结果说句评价 -> 在跟你说话',
  '- 确实想从数据里得到答案 -> 让你干活'
].join('\n');

function intentPolicy(config) {
  const m = resolveModules(config, 'chat').find((x) => x.id === 'intent');
  return m && m.enabled && m.text && m.text.trim() ? m.text.trim() : FALLBACK_INTENT_POLICY;
}

/**
 * 给界面用的完整快照: 默认值 + 当前值 + 改没改过。
 *
 * 不带 setId 时返回**全部三套** (界面要一次拿到三个分组);
 * 带 setId 时只返回那一套 (老调用点仍然按老形状拿得到 modules / preview)。
 */
function snapshot(config, setId) {
  if (setId) {
    return {
      setId,
      modules: resolveModules(config, setId),
      preview: buildSystemPrompt(config, setId)
    };
  }
  return {
    sets: SETS.map((s) => ({
      id: s.id,
      label: s.label,
      hint: s.hint,
      modules: resolveModules(config, s.id),
      preview: buildSystemPrompt(config, s.id)
    }))
  };
}

module.exports = {
  MODULES,
  MODULE_IDS,
  SETS,
  SET_IDS,
  RUNTIME_KEYS,
  buildSystemPrompt,
  buildSetPrompt,
  resolveModules,
  normalizePromptConfig,
  intentPolicy,
  snapshot
};
