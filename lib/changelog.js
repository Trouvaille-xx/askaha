/**
 * 关于本产品的元信息 + 更新日志 —— 「设置 · 关于」页与「更新日志」页的唯一数据源。
 *
 * 为什么是一个 .js 数据文件, 而不是 CHANGELOG.md 或 config.json 里的一项:
 *   1. 页面是几个平铺的 <script>, 没有打包器, 读 .md 得先过 fetch + 解析;
 *      .js 直接给结构, 页面拿到就能画。
 *   2. 它属于**出厂内容**, 不该进用户配置: 更新日志是"这个版本带了什么",
 *      跟用户改了什么无关, 更不该被 config.json 那 900ms 一次的全量重写带上。
 *   3. 走 UMD 外壳, Node 侧 (测试) 和浏览器侧共用同一份 —— 和 lib/markdown.js
 *      同一个套路, 以后要生成 Release Notes 也是直接 require 这份。
 *
 * 加一条日志的格式 (顺序即页面上的顺序, 新的写在最前面):
 *
 *   {
 *     version: '0.2.0',
 *     time: '2026-09-21 14:39',        // 年月日时分, 页面左菜单就按它排
 *     title: '一句话概括这个版本',       // 可省
 *     changes: [
 *       { tag: 'feat', text: '具体动到了哪个模块、怎么动的' },
 *     ]
 *   }
 *
 * tag 只能取下面 CHANGELOG_TAGS 里的键 —— 页面按它上色, 写错了会退化成默认灰。
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SoloChangelog = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * 更新标签词典。
   *
   * 用英文单词当键 (feat / fix / perf ...) 而不是中文: 这些词开发一眼就懂,
   * 而且以后要跟 commit message、Release Notes 对齐时不用再翻译一次。
   * 每个标签带一组配色 (前景色 + 底色), 用的是页面已有的浅色主题色系。
   */
  const CHANGELOG_TAGS = {
    feat:     { label: '新特性', fg: '#1d4ed8', bg: '#eff6ff' },
    fix:      { label: '缺陷修复', fg: '#dc2626', bg: '#fef2f2' },
    perf:     { label: '性能优化', fg: '#b45309', bg: '#fffbeb' },
    ui:       { label: '界面调整', fg: '#7c3aed', bg: '#f5f3ff' },
    refactor: { label: '重构', fg: '#0e7490', bg: '#ecfeff' },
    docs:     { label: '文档', fg: '#475569', bg: '#f1f5f9' },
    security: { label: '安全', fg: '#be123c', bg: '#fff1f2' },
    chore:    { label: '杂项', fg: '#6b7280', bg: '#f3f4f6' }
  };

  /** 页面上认不出的 tag 用这个兜底, 不让它变成空白 */
  const FALLBACK_TAG = { label: '变更', fg: '#4b5563', bg: '#f3f4f6' };

  /**
   * 「关于」页顶部的产品介绍。刻意写短 —— 这一页是给人确认"我装的是什么版本"的,
   * 不是产品宣传页。详细介绍留在 README 里。
   */
  const ABOUT = {
    name: 'Askaha',
    slogan: '假如数据会说话······',
    summary: '一个跑在本地的数据库智能体。你用自然语言提要求，它自己规划 SQL、查库、出报告 —— 全程只读，每条 SQL 执行前都要你点头。',
    highlights: [
      '四类库通吃：MySQL / PostgreSQL / SQLite / SQL Server',
      '只读安全闸门：每条 SQL 逐条预览，白名单外的表不查、不猜',
      '流程卡：把排查判断写成确定性的卡，跑起来路线不漂',
      '本地优先：密钥与数据不出本机，连接直连你的数据库'
    ],
    license: 'MIT'
  };

  /**
   * 更新日志。新的写在最前面。
   *
   * 注意: 第一条的 version 必须和 package.json 的 version 一致 —— 「关于」页显示的
   * "当前版本"读的是 package.json (app.getVersion()), 而列表读的是这里。
   * 两边对不上时页面会自己标一条提示, 免得出现"装的是 0.3, 日志最新写着 0.2"这种糊涂账。
   */
  const ENTRIES = [
    {
      version: '0.3.2',
      time: '2026-09-23 16:40',
      title: 'AI 搭建面板: 规划看得见、范围好扫、面板能拉宽',
      changes: [
        { tag: 'feat', text: '右上角新增「规划」按钮 —— 点开就能看到 AI 打算怎么搭: 分几步、每步建什么、最后输出哪几个结论, 还有进度条和「第几版」标记。AI 中途改规划, 这里跟着更新, 不用去翻对话' },
        { tag: 'feat', text: '按钮上直接带进度 (如「规划 5/12」), 不打开也知道搭到哪一步了' },
        { tag: 'feat', text: 'AI 面板宽度改成**拖左边缘**调整 (不是按钮切换宽窄)。拖到哪就是哪, 松手记住, 下次打开还是那个宽度; 双击把手复位' },
        { tag: 'feat', text: '拖动时画板至少保留 360px —— 一拖到底画板就没了, 会让人以为卡被删了' },
        { tag: 'fix', text: '「AI 可用：库A（3 张），库B（1 张）…」那行逗号连排的文字换成小圆片: 一个库一片、片上标张数、末尾给总数。鼠标停上去能看到具体是哪几张表' },
        { tag: 'fix', text: '「规划」和「历史」都从顶部展开, 现在互斥 —— 开一个自动关掉另一个, 不会再叠在一起' }
      ]
    },
    {
      version: '0.3.1',
      time: '2026-09-23 15:20',
      title: '测试窗: 删掉那段说明文字',
      changes: [
        { tag: 'fix', text: '删掉测试窗顶部那段三行说明 —— 它说了半天等于没说：讲了「自动测试并修复」干什么，却完全没讲「开始测试」是什么，看完还是不知道两个按钮差在哪' },
        { tag: 'fix', text: '两个按钮的区别改成鼠标停上去才显示的一句话：开始测试=只读看结果、不改卡、不花模型钱；自动测试并修复=跑不通自己查原因改卡复测、会改草稿、要花几分钟和模型钱' }
      ]
    },
    {
      version: '0.3.0',
      time: '2026-09-23 14:10',
      title: '搭建改成「先出方案再动手」：规划阶段 + 两道闸门',
      changes: [
        { tag: 'feat', text: '新增规划阶段。动手建卡之前先用 plan_task 出一版方案 —— 分几步、每步建什么、最终输出哪几个结论。规划会显示在对话里，你能在这时候发现"它理解错了"' },
        { tag: 'feat', text: '闸门一：从零搭卡时，没出规划就不许建节点/连线/写 SQL。查资料不受限制 —— 规划本来就要靠表结构和真实数据才写得出来' },
        { tag: 'feat', text: '闸门二：规划里的步骤没全部标完成，run_test 会被拦下并列出还剩哪几步。这就是"全部做完再测"' },
        { tag: 'feat', text: '规划必须列出 branches（这张卡会输出哪几个结论）。列不出结论说明需求还没想清楚 —— 那时候建卡只能靠反复试跑找答案' },
        { tag: 'feat', text: '跑不通时要求先分清"规划错了"还是"实现错了"：同一个地方试第三次还不行，就是规划层面错了，停下来重想' },
        { tag: 'fix', text: '闸门只拦"从零搭"，不拦"改已有的卡" —— 给一张搭好的卡改个列名不该逼人写完整规划' },
        { tag: 'docs', text: '起因：复盘一个 90 分钟会话，33.1 分钟花在 16 次 run_test 上，其中 8 次是对同一个节点的引号问题反复试 —— 根因是从来没先把整条链路想清楚' }
      ]
    },
    {
      version: '0.2.4',
      time: '2026-09-23 12:30',
      title: '搭建速度：一次 90 分钟的活，主要慢在这三处',
      changes: [
        { tag: 'perf', text: '试跑可以只跑改过的节点了。只改一个节点时把上次的 sqlByNode 传回来，没改的节点不再重查库' },
        { tag: 'perf', text: '新工具 render_sql：看一眼 SQL 到底渲染成什么样，不查库、不到 1 秒' },
        { tag: 'perf', text: '对话折叠掉的旧结果不再真的消失 —— 存根上留编号，用 recall 取回来，不必重查一遍库' },
        { tag: 'docs', text: '复盘数据：一个 90 分钟的搭建会话里，工具时间 33.2 分钟中有 33.1 分钟(99.7%)花在 run_test 上，共 16 次、平均 124 秒、最慢 389 秒' },
        { tag: 'fix', text: '诚实说明：这是把重复劳动去掉，不是让单次查询变快。单条跨库 SQL 该多慢还是多慢' }
      ]
    },
    {
      version: '0.2.3',
      time: '2026-09-23 11:40',
      title: '新增「一次请求的完整流程」图',
      changes: [
        { tag: 'docs', text: 'docs/solodb-ai-request-lifecycle.html —— 从用户按下回车到拿到一张跑通的卡，中间发生了什么。按真实代码画出，不是示意' },
        { tag: 'docs', text: '图里标清了三个出口（提问 / 判断不是搭卡 / 自认搭完）、两个闸门（续轮、收尾要体检过）、以及「诊断 → 改卡 → 重测」的修复循环最多 4 轮' }
      ]
    },
    {
      version: '0.2.2',
      time: '2026-09-23 11:00',
      title: '新增「这个单号落在哪一列」探测，替掉全表扫描',
      changes: [
        { tag: 'feat', text: 'AI 搭建：新增 find_value 工具 —— 给一个单号，它逐列试并告诉你哪一列真的装着它、哪些列试过没有。回答「两张表靠哪一列关联」时用它，不用自己写探针 SQL' },
        { tag: 'perf', text: 'AI 搭建：自己写 `WHERE a LIKE ... OR b LIKE ...` 那种十几列拼起来的探针是全表扫描 —— 实测一条 129.8 秒、四条约 250 秒。find_value 会自动只挑查得动的列，并且有硬预算，不会为了给答案把库拖死' },
        { tag: 'security', text: 'AI 搭建：find_value 明确区分「试过没有」和「没试到」—— 大表上没索引的列不试，但会如实列出来，绝不把「我没查」说成「这列是空的」' }
      ]
    },
    {
      version: '0.2.1',
      time: '2026-09-23 10:45',
      title: '模型回答逐字显示，并把耗时记进对话记录',
      changes: [
        { tag: 'ui', text: 'AI 搭建：模型的话改为逐字显示。以前要等它整段想完才一次性蹦出来，中间只有一行「正在想…」；现在边说边出字，等待时能看见它在写什么' },
        { tag: 'perf', text: 'AI 搭建：每次模型调用与工具执行的耗时、token 用量随对话一起落盘，事后可复盘「这一轮慢在哪」' },
        { tag: 'perf', text: 'AI 搭建：同一张卡的历史对话里读过的表结构会接回来，不用每次重新读一遍' },
        { tag: 'fix', text: 'AI 搭建：发给模型的消息只保留必要字段，不再把本机记账用的耗时字段一起送出去' }
      ]
    },
    {
      version: '0.2.0',
      time: '2026-09-21 14:39',
      title: '「关于」页、更新日志与流程卡导入导出',
      changes: [
        { tag: 'feat', text: '设置：新增「关于」页签，放产品简介、当前版本与更新日志' },
        { tag: 'feat', text: '设置 · 关于：新增「更新日志」页，左侧按年月日时分列出历史版本' },
        { tag: 'feat', text: '设置 · 关于：新增「检查更新」按钮，可配置内网更新源地址' },
        { tag: 'feat', text: '流程引擎：新增流程卡导出，打成 JSON 卡包（*.solodb-cards.json），单张或批量' },
        { tag: 'feat', text: '流程引擎：新增流程卡导入，支持一次选多个卡包文件，导入前预览库对应关系与同名卡处理' },
        { tag: 'security', text: '流程卡包只记库的类型/地址/端口/库名，不含口令与用户名，导入时按指纹认到本机库上' },
        { tag: 'ui', text: '对话空态：Slogan 改为「假如数据会说话······」' },
        { tag: 'docs', text: '更新日志：统一按「更新时间 / 版本号 / 【标签】条目」三段式记录' }
      ]
    },
    {
      version: '0.1.0',
      time: '2026-06-04 18:18',
      title: '首个版本',
      changes: [
        { tag: 'feat', text: '对话：自然语言取数，ReAct 循环最多 12 步，先判断意图再决定碰不碰库' },
        { tag: 'feat', text: '数据库：支持 MySQL / PostgreSQL / SQLite / SQL Server 四类库' },
        { tag: 'feat', text: '数据库：按库勾选可访问的表，支持写备注，跨库按表名自动定位' },
        { tag: 'feat', text: '流程卡：确定性流程引擎，路线预先写死，运行时不改道' },
        { tag: 'feat', text: '报告：产出 HTML（带样式预览）与 Markdown，支持导出 XLSX' },
        { tag: 'feat', text: '技能：导入 .md 单文件或含脚本的文件夹，按需注入系统提示词' },
        { tag: 'feat', text: '模型：兼容 OpenAI 协议的多模型清单，可在对话页随时切换' },
        { tag: 'feat', text: '外部工具：MCP stdio 客户端，接入外部工具服务器' },
        { tag: 'security', text: '安全：SQL 只读校验（剥离注释与字面量后三重检查），MySQL / PG 会话设为只读事务' },
        { tag: 'security', text: '安全：API Key 与数据库口令不下发到渲染层，报告在受限 iframe 中渲染' }
      ]
    }
  ];

  /** 取某个标签的配色, 认不出就给兜底 */
  function tagStyle(tag) {
    return CHANGELOG_TAGS[tag] || FALLBACK_TAG;
  }

  /** 按时间倒序返回一份副本 —— 页面左菜单直接用 */
  function sortedEntries() {
    return ENTRIES.slice().sort((a, b) => String(b.time).localeCompare(String(a.time)));
  }

  return { ABOUT, CHANGELOG_TAGS, FALLBACK_TAG, ENTRIES, tagStyle, sortedEntries };
});
