/**
 * 流程引擎页: 卡片墙 -> 整页画板 -> 节点配置。
 *
 * 两级视图:
 *   卡片墙 (gallery)  列出现有流程卡, 第一张是虚线加号卡 = 新建
 *   画板 (board)      点进去整页都是画布, 右侧配置只在选中节点时滑出
 * 两者互斥, 靠 engState.view 与 [hidden] 切换。
 *
 * 坐标系: 节点自己存 x/y (世界坐标), 画布整体用 transform 平移缩放。
 * 连线用 SVG 贝塞尔画, 端点的位置在节点渲染完之后量 DOM 得到 ——
 * 节点高度随内容变, 写死高度迟早对不上。
 *
 * 配置期会调模型草拟 SQL (AI 按钮), 但那只是"帮作者写卡";
 * 卡存下来之后运行期不再调模型, 照写死的 SQL 跑 —— 这是流程引擎的立身之本。
 */
// 节点尺寸 (世界坐标)。宽度写死, 高度量出来。
const ENG_NODE_W = 208;
// 顶部两个图标按钮用内联 SVG (不引图标库, 免得为了俩图标多一个依赖)
const ENG_ICON_CFG = `<svg viewBox="0 0 16 16" width="15" height="15" fill="none"
  stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
  <path d="M2.5 4.5h11M2.5 11.5h11"/>
  <circle cx="6" cy="4.5" r="1.7" fill="var(--surface)"/>
  <circle cx="10.5" cy="11.5" r="1.7" fill="var(--surface)"/></svg>`;
const ENG_ICON_FULL = `<svg viewBox="0 0 16 16" width="15" height="15" fill="none"
  stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M6 2.5H2.5V6M10 2.5h3.5V6M6 13.5H2.5V10M10 13.5h3.5V10"/></svg>`;
const ENG_ICON_EXIT_FULL = `<svg viewBox="0 0 16 16" width="15" height="15" fill="none"
  stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M2.5 6H6V2.5M13.5 6H10V2.5M2.5 10H6v3.5M13.5 10H10v3.5"/></svg>`;
// 「测试」= 播放三角, 一眼看出是"跑一下"
const ENG_ICON_PLAY = `<svg viewBox="0 0 16 16" width="15" height="15" fill="none"
  stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true">
  <path d="M4.5 2.8 12.6 8l-8.1 5.2z"/></svg>`;
const ENG_LABEL = { input: '输入', query: '取数', condition: '条件', output: '输出' };
const ENG_HINT = {
  input: '声明这张卡要问用户什么',
  query: '连库跑一条写死的 SQL',
  condition: '按规则分岔，走成立或不成立',
  output: '把结果拼成给用户看的结论'
};
const ENG_CMP = [
  ['==', '等于'], ['!=', '不等于'], ['>', '大于'], ['>=', '大于等于'],
  ['<', '小于'], ['<=', '小于等于'], ['contains', '包含'], ['notContains', '不包含'],
  ['empty', '为空'], ['notEmpty', '有值']
];
const engState = {
  loaded: false,
  view: 'gallery',   // gallery | board
  engines: [],
  currentId: null,
  card: null,        // 正在编辑的卡 (副本, 保存时才写回)
  dirty: false,
  selectedNode: null,
  selectedEdge: null, // {from, port}
  inspOpen: false,    // 节点编辑框是否打开 —— 只由**双击**节点打开 (单击只选中, 不弹)
  pan: { x: 40, y: 30 },
  zoom: 1,
  cfg: null,
  tablesCache: {},   // dbId -> [表名]
  fieldsCache: {},   // dbId|table -> [{field,type}]
  drag: null,
  link: null,
  addMenuOpen: false,
  aiBusy: false,
  syncBusy: false,      // 取数节点的 SQL「同步」(跑一次 SQL 灌输出列)
  cfgSyncBusy: false,   // 库表配置「同步」(重新读一遍「数据库」页的配置)
  fullscreen: false,
  validateSeq: 0,    // 校验是异步的, 用它丢掉过期结果
  // ---- AI 搭建侧边栏 ----
  aiOpen: false,
  aiPool: null,        // { dbId: [表名, ...] } —— 本次会话 AI 能看到的范围; null = 还没配
  aiLog: [],           // [{role:'user'|'ai'|'act', text, err?}] 对话流水
  aiTypeRaf: 0,        // 逐字显示的动画句柄 (同一时刻只允许一个)
  aiChatBusy: false,   // 对话进行中 (与 aiBusy 分开: 那个是"AI 生成单条 SQL")
  // 发送序号 + "这次发送是替哪张卡跑的"。两者一起用来判断 finally 该不该
  // 解锁输入框 —— 详见 engAiSyncComposer 上面那段注释。
  aiSendSeq: 0,
  aiBusyCardId: null,
  aiSessionId: null,   // 主进程那边的会话 (= chatId)
  aiConfirmed: false,  // 改现有卡前已跟用户确认过
  aiChatId: null,      // 当前这条对话的 id (落盘用; 跟 aiSessionId 是同一个值)
  aiChats: [],         // 这张卡的历史对话索引 (来自主进程)
  aiTab: 'chat',       // AI 面板当前页签: chat(对话) / plan(规划) / history(历史)
  aiDropped: 0,        // 这一轮里被 sessionId 过滤掉的事件数 —— 静默丢事件要能看见
  aiWatchdog: null,    // busy 期间的心跳看门狗定时器
  // 忙的时候到底在忙什么: 'build' (搭建) | 'selftest' (收尾后主进程自动跑的自测)。
  // 两者用的是同一个「停止」按钮, 但走的是两条 IPC —— 不分流的话在搭建阶段点
  // 「停止」会得到一句"现在没有在跑的自测", 而搭建其实还在跑。
  aiPhase: null,
  // ---- 自动保存 ----
  //
  // 以前这张卡上的一切都要用户手点「保存」: 改个名字、拖个节点、配个范围,
  // 都得记得去点那一下。忘了就丢, 而且拖节点连"未保存"的提示都不会亮。
  //
  // rev / savedRev 是**版本号**, 不是布尔量。用布尔量的话会有这个漏洞:
  // 保存请求还在飞的时候用户又敲了一个字 -> 请求回来把 dirty 清成 false
  // -> 那一笔改动永远不落盘。改成"回来时对一下版本号"就没这个问题。
  autoSaveTimer: null,   // 防抖定时器
  autoSaveBusy: false,   // 有一次保存在飞
  autoSaveAgain: false,  // 飞行途中又改了 -> 落地后再来一次
  autoSaveState: '',     // '' | 'saving' | 'saved' | 'err'
  autoSaveError: '',
  autoSaveAt: null,      // 上次成功保存的时刻
  rev: 0,                // 编辑版本号 (每次 engTouch +1)
  savedRev: 0,           // 已落盘的版本号
  autoSaveGuarded: false, // blur / beforeunload 的兜底钩子只挂一次
  // ---- 测试 (画板右上角「测试」) ----
  testBusy: false,
  testInputs: null,    // 上次填过的样例值 { 字段名: 值 }
  // 批量模式: 输入框变成多行, 一行一个值, 一次把每一行都跑一遍。
  // 卡本身没有循环构造 (NODE_TYPES 只有 input/query/condition/output), 想查
  // 3 张单以前只能手工跑 3 次 —— 这是最常用的用法, 所以给它一个开关。
  testBatchMode: false,
  autoRunId: null,     // 正在跑的自动测试 (主进程那边的 id), null = 没在跑
  autoRounds: [],      // 自动测试的轮次流水 [{round, phase, message, report?, acts:[], run?}]
  autoCurrentRound: 0,
  autoSubscribed: false, // 自动测试事件流是否已订阅 (只订一次)
  autoDone: false,       // 这一轮自动测试是否已收尾 (挡住迟到的进度事件)
  autoPrompted: false,   // 这一轮搭建是否已经弹过"确认测试"的窗 (免得重复弹)
  testCollapsed: {}    // 节点结果折叠状态 { 节点id: true=收起 }
};
const eq1 = (sel, root) => (root || document).querySelector(sel);
const eqAll = (sel, root) => Array.from((root || document).querySelectorAll(sel));
function engId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function engEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function engToast(msg, kind) {
  if (typeof toast === 'function') toast(msg, kind || 'ok');
}
/** 新建的空白卡。结构跟 lib/engine.js 的 newEngine() 保持同形。 */
function engBlank() {
  const inId = engId('n');
  const outId = engId('n');
  return {
    id: engId('eng'),
    name: '未命名流程卡',
    description: '',
    enabled: true,
    examples: [],
    // 这张卡能用的库表范围, 跟节点一样是卡的内容 —— 新卡从空的开始
    scope: {},
    nodes: [
      { id: inId, type: 'input', title: '入口', x: 60, y: 200, fields: [{ key: 'input1', label: '输入项', required: true }] },
      { id: outId, type: 'output', title: '出口', x: 560, y: 200, template: '' }
    ],
    edges: [{ from: inId, to: outId, port: 'out' }]
  };
}
/* ==================== 数据加载 ==================== */
async function loadEngines(force) {
  if (engState.loaded && !force) return engState.engines;
  const r = await window.bridge.engine.list();
  engState.engines = (r && r.engines) || [];
  engState.loaded = true;
  return engState.engines;
}
/**
 * 配置读一份到内存里给这一页用。
 * 注意它是缓存的: 用户先去「数据库」页加了库、勾了表, 这一份不会自己变。
 * 需要拿到最新的时候走 engSyncConfig()。
 */
async function engConfig(force) {
  if (!engState.cfg || force) {
    engState.cfg = await window.bridge.config.get();
  }
  return engState.cfg;
}
function engDatabases() {
  return (engState.cfg && engState.cfg.databases) || [];
}
/**
 * 某个库在「数据库」页被维护过（勾选）的表名。
 * 流程卡能选的范围只能在这个集合里 —— 用户没勾的表不该冒出来让他选，
 * 更不该经由一个旧的范围池漏到 AI 那边去。
 */
function engDbMaintainedTables(d) {
  return ((d && d.tables) || [])
    .filter((t) => t && t.name && t.checked)
    .map((t) => t.name);
}
/**
 * 当前这份配置的指纹 —— 库、连接信息、表清单、勾选状态、备注都算进去。
 * 同步前后来比一下, 没变就别白清缓存 (清掉表名/字段缓存会重跑一次探测)。
 */
function engCfgSig() {
  return engDatabases().map((d) => [
    d.id, d.name, d.type, d.host, d.port, d.database, d.user,
    ((d.tables || []).map((t) => `${t.name}:${t.checked ? 1 : 0}:${t.note || ''}`).join(','))
  ].join('~')).join('|');
}
/**
 * 把「数据库」页的配置重新读一遍, 并把派生出来的两张缓存一起清掉。
 *
 * 这一页的库表清单是从内存里那份配置渲染的, 而配置只在进页面时读一次。
 * 用户常常先建流程卡、后去「数据库」页加库勾表 —— 回到这里, 内存里那份还是旧的,
 * 于是配置弹框、取数节点的库表下拉里, 新加的库和表一个都看不见。
 *
 * 缓存不清也不行: 表名和字段是按 dbId 缓存的, 配置换了但缓存还在,
 * 旧表名照样会从缓存里冒出来。
 */
async function engSyncConfig() {
  const before = engCfgSig();
  await engConfig(true);
  const changed = engCfgSig() !== before;
  if (changed) {
    engState.tablesCache = {};
    engState.fieldsCache = {};
  }
  const dbs = engDatabases();
  let tables = 0;
  for (const d of dbs) tables += engDbMaintainedTables(d).length;
  return { changed, dbs: dbs.length, tables };
}
/** 某个库里有哪几张表: 先用上次探测存下来的清单, 没有再问一次 */
async function engTablesOf(dbId) {
  if (engState.tablesCache[dbId]) return engState.tablesCache[dbId];
  const conf = engDatabases().find((d) => d.id === dbId);
  let names = ((conf && conf.tables) || []).map((t) => t && t.name).filter(Boolean);
  if (!names.length && dbId) {
    try {
      const r = await window.bridge.db.listTables({ dbId });
      // db:listTables 现在回的是 [{name, comment}] —— 顺带把库里维护的表注释
      // 也取回来了。这里只要表名, 但形状得跟着改, 否则整份清单会变成 "[object Object]"
      if (r && r.ok) names = (r.tables || []).map((t) => (t && t.name) || t).filter(Boolean);
    } catch (e) { /* 连不上就空着, 让用户手动敲 */ }
  }
  engState.tablesCache[dbId] = names;
  return names;
}
async function engFieldsOf(dbId, table) {
  const key = dbId + '|' + table;
  if (engState.fieldsCache[key]) return engState.fieldsCache[key];
  try {
    const r = await window.bridge.db.describeTable({ dbId, table });
    engState.fieldsCache[key] = (r && r.ok && r.fields) || [];
  } catch (e) {
    engState.fieldsCache[key] = [];
  }
  return engState.fieldsCache[key];
}
/* ==================== 卡片墙 ==================== */
/**
 * 启用/停用开关。卡片墙和画板顶栏共用这一个 —— 两处长得一样, 用户不用学第二遍。
 *
 * 文案写的是**状态** (启用中/已停用) 而不是动作 (启用/禁用)。开关本身已经
 * 表达了"按下去会变", 再写动作的话, 看到「启用」两个字会分不清它现在是
 * 启用着还是等着被启用。
 *
 * data-enable 是给卡片墙用的 —— 那边整张卡是个可点区域, 靠这个属性在
 * 点击处理里把它排除掉, 免得点开关顺手把卡也打开了。
 */
function engEnableSwitch(id, on, small) {
  const label = on ? '启用中' : '已停用';
  return `<button class="eng-enable${on ? ' on' : ''}${small ? ' eng-enable-sm' : ''}"`
    + (small ? '' : ' id="btnEngEnable"')
    + ` data-enable="${engEsc(id)}"`
    + ` title="${on ? '停用后路由不会再命中这张卡' : '启用后路由才会命中这张卡'}"`
    + ` aria-pressed="${on ? 'true' : 'false'}" aria-label="${label}">`
    + `<span class="eng-enable-knob"></span>`
    // 小号 (卡片墙) 只有滑块: 那一行还要放名称, 再塞两个字名称就没地方了
    + (small ? '' : `<span class="eng-enable-text">${label}</span>`)
    + `</button>`;
}
async function renderEngineGallery() {
  const grid = eq1('#engineGalleryGrid');
  if (!grid) return;
  await loadEngines();
  await engConfig();
  const cards = engState.engines.map((e) => {
    const tables = engTablesIn(e);
    const nodes = e.nodes || [];
    const scopeN = engScopeTableCount(e);
    const noDesc = !e.description && !(e.examples || []).length;
    const off = e.enabled === false;
    // 表名长度差很多, 全列出来会把卡片撑成一团。一张写名字, 多张写"名字 等 N 张",
    // 完整清单挂在 title 上 —— 想看全的把鼠标放上去。
    const tablesTxt = !tables.length
      ? '—'
      : (tables.length === 1 ? tables[0] : tables[0] + ' 等 ' + tables.length + ' 张');
    return `<div class="eng-card${off ? ' eng-off' : ''}" data-open="${engEsc(e.id)}">
      <div class="eng-card-tools">
        <button class="eng-card-io" data-exp="${engEsc(e.id)}" title="导出这张卡，发给别人">⤓</button>
        <button class="eng-card-del" data-del="${engEsc(e.id)}" title="删掉这张卡">×</button>
      </div>
      <div class="eng-card-head">
        <span class="eng-card-name">${engEsc(e.name || '未命名流程卡')}</span>
        ${engEnableSwitch(e.id, !off, true)}
      </div>
      <div class="eng-card-desc${noDesc ? ' eng-card-warn' : ''}">${engEsc(noDesc ? '还没写用途 —— 没有用途说明，路由器很难命中它。' : e.description)}</div>
      <div class="eng-card-foot">
        <div class="eng-row"><span class="k">节点</span><span class="v">${nodes.length}</span></div>
        <div class="eng-row"><span class="k">用表</span><span class="v${tables.length ? '' : ' dim'}" title="${engEsc(tables.join('、'))}">${engEsc(tablesTxt)}</span></div>
        <div class="eng-row"><span class="k">AI 范围</span><span class="v${scopeN ? '' : ' warn'}">${scopeN ? scopeN + ' 张表' : '未配置'}</span></div>
      </div>
      <div class="eng-card-time">创建 ${engEsc(engFmtTime(e.createdAt) || '—')} · 更新 ${engEsc(engFmtTime(e.updatedAt) || '—')}</div>
    </div>`;
  }).join('');
  // 「新建」放回第一个。它排第一的时候我一度把它挪到队尾, 理由是"一个几乎全空的
  // 虚线格子占着最显眼的位置"; 但进这一页最常见的动作就是新建, 摆在队首最好找,
  // 空一格换一次点击, 值。
  grid.innerHTML = `<button class="eng-card eng-card-new" id="btnNewEngine">
      <span class="eng-new-plus">+</span>
      <span class="eng-new-label">新建流程卡</span>
      <span class="eng-new-sub">从空白画板开始配</span>
    </button>` + cards;
  const newBtn = eq1('#btnNewEngine', grid);
  if (newBtn) newBtn.addEventListener('click', engNew);
  eqAll('[data-open]', grid).forEach((el) => {
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-del]')) return;
      if (ev.target.closest('[data-exp]')) return;
      // 开关自己处理, 别顺手把卡也打开 —— 整张卡都是可点区域, 不挡住这一下
      // 就等于"想停用一张卡, 结果进了它的编辑页"。
      if (ev.target.closest('[data-enable]')) return;
      engOpen(el.dataset.open);
    });
  });
  eqAll('[data-exp]', grid).forEach((el) => {
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      // 单个导出走的就是批量那条路, 只是预勾了这一张
      engExportOpen([el.dataset.exp]);
    });
  });
  eqAll('[data-enable]', grid).forEach((el) => {
    el.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const id = el.dataset.enable;
      const cur = (engState.engines || []).find((e) => e.id === id);
      await engSetEnabled(id, !(cur && cur.enabled !== false));
    });
  });
  eqAll('[data-del]', grid).forEach((el) => {
    el.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      await engDeleteById(el.dataset.del);
    });
  });
}
function engTablesIn(card) {
  const out = [];
  for (const n of (card && card.nodes) || []) {
    if (n.type === 'query' && n.table && out.indexOf(n.table) < 0) out.push(n.table);
  }
  return out;
}
/** 这张卡配了多少张"可用表" (跟真正发给 AI 的算法一致, 不含已被取消维护的表) */
function engScopeTableCount(card) {
  const clean = engScopeClean((card && card.scope) || {});
  let n = 0;
  for (const k of Object.keys(clean)) n += clean[k].length;
  return n;
}
/** 卡片墙 <-> 画板 */
function engShowView(view) {
  engState.view = view;
  const g = eq1('#engineGallery');
  const b = eq1('#engineBoard');
  if (g) g.hidden = view !== 'gallery';
  if (b) b.hidden = view !== 'board';
  if (view === 'gallery') {
    engToggleAddMenu(false);
    closeEngCfgModal();
    closeEngTest();
    engToggleFullscreen(false);   // 回卡片墙就别再占着整屏
    const dock = eq1('#engIssuesDock');
    if (dock) { dock.hidden = true; dock.classList.remove('open'); }
  }
}
async function engBackToGallery() {
  // 回卡片墙之前把待保存的落盘, 而不是弹一句"回去就没了"吓唬人。
  // 自动保存正常的话这一步是空操作 (没有待保存的东西)。
  const ok = await engFlushAutoSave();
  if (!ok) {
    // 只有自动保存**失败**时才拦一下 —— 静默丢掉用户的改动是不可接受的,
    // 但也不能因为一次网络/磁盘抖动就让他回不去。
    if (!(await askConfirm({
      title: '改动没能保存',
      message: '自动保存没成功, 回去这些改动就没了。',
      detail: '可能是磁盘写不进去或配置被占用。可以先去「配置」页看看, 或者留在这页再改一下触发重试。',
      okText: '仍然返回',
      cancelText: '留下',
      tone: 'danger'
    }))) return;
  }
  engState.card = null;
  engState.currentId = null;
  engState.dirty = false;
  // 换卡了, 版本号也要跟着归零 —— 否则下一张卡会带着上一张的 rev,
  // 自动保存会以为"已经存过了"而跳过
  engState.rev = 0;
  engState.savedRev = 0;
  engSetSaveState('');
  engState.selectedNode = null;
  engState.selectedEdge = null;
  // 范围属于卡, 卡关了范围也跟着走 —— 否则卡片墙上再点开另一张卡之前,
  // 侧边栏那行还挂着上一张卡的范围, 看着像"新卡也配好了"
  engState.aiPool = {};
  engAiDetach();
  engState.aiChats = [];
  engAiRenderHistory();
  engShowView('gallery');
  renderEngineGallery();
}
/* ==================== 打开 / 新建 / 保存 / 删除 ==================== */
/**
 * 把"跟某一张卡绑定"的会话状态全清掉, 但不碰盘上的记录。
 *
 * 范围(aiPool)不在这里清 —— 它是卡片自己的内容, 跟着卡走, 由 engApplyCardScope
 * 在打开卡的时候重新装进来。这里清掉反而会让"换回来"丢范围。
 *
 * 抽成一个函数是因为原来这段被抄了两份 —— 抄漏了一行 `autoPrompted`,
 * 后果是"第一次搭完卡之后测试窗再也不自动弹了", 而且极难发现
 * (换卡看起来一切正常, 只是不再弹窗)。以后再有新的"换上下文"入口,
 * 一律走这里, 别在旁边另写一份。
 */
function engAiDetach() {
  if (engState.aiSessionId) {
    try { window.bridge.engine.aiClose({ sessionId: engState.aiSessionId }); } catch (e) {}
  }
  engState.aiSessionId = null;
  engState.aiChatId = null;
  engState.aiLog = [];
  engState.aiConfirmed = false;
  // "这一轮搭完了"的标记要跟着清 —— 新的一张卡该重新有一次自动弹测试窗的机会
  engState.autoPrompted = false;
  // 脱离了原来那条会话, 输入框的锁也跟着放掉 (如果它属于别的卡)。
  // 不在这里放的话, 换卡之后输入框会一直灰到旧请求落地。
  engAiSyncComposer();
  engAiRenderLog();
}
/**
 * 打开一张卡时把它的 AI 对话接回来。
 *
 * 这里**不再**无脑清空 —— 之前换卡就把对话清了, 重进同一个卡也是空的, 用户
 * 看不到自己上次跟 AI 聊了什么, 更接不上话。现在按 chatId 从盘上把最近一条
 * 对话连对话史一起接回来; 这张卡还没聊过才留空。
 *
 * 注意 aiSessionId 留空: 真正的主进程会话在用户发第一句话时才建
 * (engAiEnsureSession), 打开卡不该产生一次没必要的模型侧开销。
 */
async function engAiRestoreForCard(card) {
  engAiDetach();
  engState.aiChats = [];
  engAiSetTab('chat');
  const cardId = card && card.id;
  if (!cardId || !window.bridge.engine.aiChatList) return;
  let r;
  try { r = await window.bridge.engine.aiChatList({ cardId }); } catch (e) { r = null; }
  // 等 IPC 回来的这段时间里, 用户可能已经切到别的卡了。不检查的话这次**过期响应**
  // 会把上一张卡的对话列表盖到当前卡上, 还会顺手打开一条属于上一张卡的对话 ——
  // 面板里显示的是 A 的聊天记录, 画板上却是 B。
  // 历史列表本来就按卡过滤 (aiChatStore.list(cardId)), 所以列表和画板必须同卡。
  if (!engState.card || engState.card.id !== cardId) return;
  engState.aiChats = (r && r.chats) || [];
  engAiRenderHistory();
  const latest = engState.aiChats[0];
  if (!latest) return;
  await engAiOpenChat(latest.id, { silent: true });
}
/**
 * 打开某一条历史对话: 把它的对话流水与"这一轮搭完了没"的标记接回来。
 *
 * autoPrompted 一并恢复 —— 它决定"要不要自动弹测试窗"。不恢复的话, 一条早就
 * 搭完收尾的对话, 每次重进都会再弹一次测试窗, 看着就像"它又自己重跑了一遍"。
 */
async function engAiOpenChat(chatId, opts) {
  if (!chatId) return;
  if (engState.aiSessionId && engState.aiSessionId !== chatId) {
    try { window.bridge.engine.aiClose({ sessionId: engState.aiSessionId }); } catch (e) {}
  }
  engState.aiSessionId = null;
  engState.aiChatId = chatId;
  engState.aiConfirmed = false;
  let r;
  try { r = await window.bridge.engine.aiChatGet({ id: chatId }); } catch (e) { r = null; }
  if (!r || !r.ok) {
    if (!(opts && opts.silent)) engToast((r && r.error) || '这条对话的记录找不到了', 'err');
    return;
  }
  engState.aiLog = (r.chat && r.chat.log) || [];
  // 从盘上读回来的都是**已经说过的**话, 一律标成已显示完。
  // 不标的话它们 revealed 是 undefined, 渲染分支会把它们当成"正在打字"而渲染成空 ——
  // 打开历史对话会看到一堆空白气泡。
  for (const m of engState.aiLog) if (m && typeof m === 'object') m.revealed = true;
  // 已经收尾的对话不该再自动弹测试窗
  engState.autoPrompted = !!(r.chat && r.chat.autoPrompted);
  engAiRenderLog();
}
/**
 * 在这张卡上开一条新对话。
 *
 * 不动历史 —— 老对话留在列表里, 只是当前这条换了。真正的记录在用户发第一句话
 * 时由主进程建 (那时候才有内容可存)。
 */
function engAiNewChat() {
  engAiDetach();
  // 回到对话页签; 新对话还没有规划, 规划页留空 (切过去时才渲染)
  engAiSetTab('chat');
  engAiRenderLog();
}
/**
 * 把卡里存的可用范围装进会话状态。
 *
 * 范围是卡片的内容 (跟节点/连线一样), 所以每次打开卡都从卡上重新读一遍,
 * 而不是沿用上一张卡留下的。之前它只活在内存里, 换张卡再回来就没了 ——
 * 用户得重新勾一次, 而且很容易以为"已经配过了"。
 *
 * 顺手把卡上的 scope 补成对象: 升级前建的卡盘上没有这个字段 (主进程只在保存时
 * 才规范化), 不补的话 engState.card.scope 是 undefined, 下游每次都得自己判空。
 */
function engApplyCardScope(card) {
  if (card && (!card.scope || typeof card.scope !== 'object' || Array.isArray(card.scope))) {
    card.scope = {};
  }
  const src = (card && card.scope) || {};
  const pool = {};
  for (const k of Object.keys(src)) {
    const list = (src[k] || []).filter(Boolean);
    if (list.length) pool[k] = list.slice();
  }
  engState.aiPool = pool;
  engAiRenderScope();
}
/** 把当前会话范围写回卡上 (保存前调一次, 保证存下去的就是眼前这份) */
function engCardScopeWriteBack() {
  if (!engState.card) return;
  engState.card.scope = JSON.parse(JSON.stringify(engState.aiPool || {}));
}
/**
 * 接住主进程推回来 / 测回来的一张卡。
 *
 * 主进程只认图 (节点、连线), 它手里的 scope 是"会话开始时那一份", 可能已经旧了;
 * 范围只有渲染进程能算 (要跟「数据库」页的配置求交集), 所以**本地这份为准**。
 * 不这么做的话, 用户在对话中间改了范围, AI 下一句回复推回图时就把范围冲回去了。
 *
 * name / description 同理: AI 手上根本没有改卡名的工具 (它只有 set_node_title,
 * 那个改的是节点标题), 所以主进程手里的卡名永远停在"会话开始时"。用户中途改了
 * 卡名并保存, AI 干完活把整张卡推回来 —— 卡名就被那份旧的覆盖了。
 * 这两个字段一律以本地为准。
 */
function engAdoptCard(incoming) {
  if (!incoming) return;
  const prev = engState.card || {};
  const localScope = prev.scope || null;
  engState.card = incoming;
  if (localScope && Object.keys(localScope).length) engState.card.scope = localScope;
  // AI 不碰这两个字段, 本地有值就用本地的 (含空串判断: 用户清空了也算他的意图)
  if (typeof prev.name === 'string' && prev.name) engState.card.name = prev.name;
  if (typeof prev.description === 'string') engState.card.description = prev.description;
}
async function engOpen(id) {
  await loadEngines();
  const found = engState.engines.find((e) => e.id === id);
  if (!found) return;
  engState.currentId = id;
  engState.card = JSON.parse(JSON.stringify(found));
  engState.dirty = false;
  // 刚打开的卡就是盘上那一份, 版本号归零 —— 不归零的话会带着上一张卡的
  // rev, 自动保存会以为"已经存过了"而跳过第一次改动
  engState.rev = 0;
  engState.savedRev = 0;
  engSetSaveState('');
  engState.selectedNode = null;
  engState.selectedEdge = null;
  engState.pan = { x: 40, y: 30 };
  engState.zoom = 1;
  engApplyCardScope(engState.card);   // 范围是卡的内容, 从这张卡上重新装
  engShowView('board');
  renderEngineHead();
  renderEngineCanvas();
  renderEngineInspector();
  // 画布尺寸要等视图可见之后才量得准
  requestAnimationFrame(() => { engFitIfNeeded(); });
  // 把这张卡上一次跟 AI 聊的接回来 (没聊过就留空)
  engAiRestoreForCard(engState.card);
}
async function engNew() {
  const card = engBlank();
  const r = await window.bridge.engine.save(card);
  engState.engines = (r && r.engines) || engState.engines;
  engState.currentId = card.id;
  engState.card = JSON.parse(JSON.stringify((r && r.engine) || card));
  engState.dirty = false;
  engState.rev = 0;
  engState.savedRev = 0;
  engState.selectedNode = null;
  engState.selectedEdge = null;
  engState.pan = { x: 40, y: 30 };
  engState.zoom = 1;
  engAiDetach();
  engState.aiChats = [];
  engAiRenderHistory();
  engApplyCardScope(engState.card);
  engShowView('board');
  renderEngineHead();
  renderEngineCanvas();
  renderEngineInspector();
  requestAnimationFrame(() => { engFitIfNeeded(); });
  // 新卡的输入框必须是可用的。上一张卡如果有请求还在飞, 它的 finally 要等
  // Promise 落地才执行, 那之前输入框会一直是灰的 —— 用户看到的就是
  // "新建了一张卡, 但对话框不让输入, 得等一会"。
  engAiSyncComposer();
  engToast('新建了一张流程卡，改完会自动保存', 'ok');
}
/**
 * 手点「保存」。现在它不再是唯一出路 (自动保存会兜着), 但保留着:
 * 它多做了两件自动保存**故意不做**的事 —— 用主进程洗过的对象替换本地这份,
 * 并把右侧面板重画一遍重新绑定。用户点它就是要一个"确定已落盘"的交代。
 */
async function engSave() {
  if (!engState.card) return;
  // 待保存的定时器作废: 这一次手点就把它该干的活干了, 留着会在稍后
  // 再存一遍同一个版本
  if (engState.autoSaveTimer) { clearTimeout(engState.autoSaveTimer); engState.autoSaveTimer = null; }
  // 可用范围是卡的内容, 存之前先把它写回卡上 —— 否则配了范围但没存过卡,
  // 关掉再打开就回到上一次保存时的范围 (或者干脆是空的)
  engCardScopeWriteBack();
  const rev = engState.rev;
  const r = await window.bridge.engine.save(engState.card);
  if (!r || !r.ok) {
    engSetSaveState('err', (r && r.error) || '未知原因');
    engToast('保存失败：' + ((r && r.error) || '未知原因'), 'err');
    return;
  }
  engState.engines = r.engines || engState.engines;
  // 存盘回来的是主进程洗过的新对象。若不重画, 右侧面板还攥着旧对象,
  // 之后再改就是改一个没人认领的副本 —— 下一次保存直接把这次改动丢掉。
  engState.card = JSON.parse(JSON.stringify(r.engine));
  engState.dirty = false;
  engState.savedRev = rev;
  // 存盘回来的是主进程洗过的对象, 范围也照它对齐一次 (比如库里已被删掉的表)
  engApplyCardScope(engState.card);
  renderEngineHead();
  renderEngineCanvas();
  renderEngineInspector();
  engSetSaveState('saved');
  engToast('已保存', 'ok');
}
async function engDeleteById(id) {
  const card = engState.engines.find((e) => e.id === id);
  const name = (card && card.name) || '这张卡';
  if (!(await askConfirm({
    title: '删除这张流程卡?',
    message: `删掉「${name}」? 用户以后就命中不到它了。`,
    detail: '这张卡的节点、连线、可用范围, 以及它的 AI 对话记录都会一起删掉。',
    okText: '删除流程卡',
    tone: 'danger'
  }))) return;
  const r = await window.bridge.engine.remove(id);
  engState.engines = (r && r.engines) || [];
  if (engState.currentId === id) {
    engState.currentId = null;
    engState.card = null;
    engState.dirty = false;
    engState.rev = 0;
    engState.savedRev = 0;
    if (engState.autoSaveTimer) { clearTimeout(engState.autoSaveTimer); engState.autoSaveTimer = null; }
    engAiDetach();
    engState.aiChats = [];
    engAiRenderHistory();
    engShowView('gallery');
  }
  renderEngineGallery();
  engToast('已删除', 'ok');
}
async function engDeleteCurrent() {
  if (!engState.card) return;
  const id = engState.card.id;
  const name = engState.card.name;
  if (!(await askConfirm({
    title: '删除这张流程卡?',
    message: `删掉「${name}」? 用户以后就命中不到它了。`,
    detail: '这张卡的节点、连线、可用范围, 以及它的 AI 对话记录都会一起删掉。',
    okText: '删除流程卡',
    tone: 'danger'
  }))) return;
  const r = await window.bridge.engine.remove(id);
  engState.engines = (r && r.engines) || [];
  engState.currentId = null;
  engState.card = null;
  engState.dirty = false;
  engState.rev = 0;
  engState.savedRev = 0;
  if (engState.autoSaveTimer) { clearTimeout(engState.autoSaveTimer); engState.autoSaveTimer = null; }
  engState.selectedNode = null;
  engState.selectedEdge = null;
  engState.aiPool = {};
  engAiDetach();
  engState.aiChats = [];
  engAiRenderHistory();
  engShowView('gallery');
  renderEngineGallery();
  engToast('已删除', 'ok');
}
function engTouch() {
  engState.rev += 1;
  engState.dirty = true;
  engSetSaveState('');
  engScheduleAutoSave();
}
/**
 * 启用/停用一张卡。
 *
 * 后端本来就认这个字段 —— gate.js 和 agent.js 在挑卡时都会跳过 enabled === false 的,
 * 所以停用是真的不进路由, 不是只换个颜色。这里补的只是"不用打开配置弹窗就能切"。
 *
 * 两条路走两套保存, 不能混:
 *  - 卡正开着: 改 engState.card 然后 engTouch(), 交给原有的自动保存。这条路上
 *    rev/dirty/范围写回都是现成的, 自己再存一遍反而会绕过它们。
 *  - 卡没开着 (在卡片墙): engState.card 是 null, 没有自动保存可言, 只能自己存。
 *    此时 engState.engines 里那份是上次保存的快照, 拿它去存是安全的 ——
 *    engBackToGallery 回墙之前会先 engFlushAutoSave, 所以两者不会脱节。
 */
async function engSetEnabled(id, next) {
  const inList = (engState.engines || []).find((e) => e.id === id);
  const isOpen = !!(engState.card && engState.card.id === id);
  if (!inList && !isOpen) return;
  const name = (inList && inList.name) || (engState.card && engState.card.name) || '这张卡';
  // 先改内存再画 —— 开关要立刻响应, 不能等写盘
  if (inList) inList.enabled = next;
  if (isOpen) engState.card.enabled = next;
  renderEngineGallery();
  if (isOpen) renderEngineHead();
  if (isOpen) {
    engTouch();   // 走自动保存
    engToast(next ? '已启用 ' + name : '已停用 ' + name);
    return;
  }
  const r = await window.bridge.engine.save(inList);
  if (!r || !r.ok) {
    // 存不进去就把界面拨回去, 否则开关显示的和盘上的不一致
    inList.enabled = !next;
    renderEngineGallery();
    engToast('改不了状态：' + ((r && r.error) || '未知原因'), 'err');
    return;
  }
  engState.engines = r.engines || engState.engines;
  renderEngineGallery();
  engToast(next ? '已启用 ' + name : '已停用 ' + name);
}
/* ==================== 自动保存 ==================== */
/**
 * 用户停手多久之后真写盘。
 *
 * 太短: 每敲一个字就是一次 config.json 全量重写 (里面还有 4 个库的配置)。
 * 太长: "改完立刻关窗"会丢。
 * 900ms 大约是"一句话打完想一下"的停顿。
 */
const ENG_AUTOSAVE_DEBOUNCE_MS = 900;
/** 防抖: 每次改动都重新计时, 停手了才真存 */
function engScheduleAutoSave() {
  if (!engState.card) return;
  if (engState.autoSaveTimer) clearTimeout(engState.autoSaveTimer);
  engState.autoSaveTimer = setTimeout(() => {
    engState.autoSaveTimer = null;
    engAutoSave();
  }, ENG_AUTOSAVE_DEBOUNCE_MS);
}
/** 顶部那行保存状态。失败要看得见 —— 静默失败等于静默丢数据。 */
function engSetSaveState(state, error) {
  engState.autoSaveState = state || '';
  engState.autoSaveError = error || '';
  if (state === 'saved') engState.autoSaveAt = new Date();
  const hint = eq1('#engineDirty');
  if (!hint) return;
  if (!state) {
    hint.hidden = !engState.dirty;
    hint.className = 'engine-dirty';
    hint.textContent = '有未保存的改动';
    return;
  }
  hint.hidden = false;
  if (state === 'saving') {
    hint.className = 'engine-dirty saving';
    hint.textContent = '正在保存…';
  } else if (state === 'saved') {
    hint.className = 'engine-dirty saved';
    hint.textContent = '已自动保存 ' + engState.autoSaveAt.toTimeString().slice(0, 8);
  } else {
    hint.className = 'engine-dirty err';
    hint.textContent = '自动保存失败：' + (engState.autoSaveError || '未知原因');
  }
}
/**
 * 静默保存当前这张卡。不重画、不弹 toast。
 *
 * **绝不替换 engState.card。** 右侧检查器的输入框直接攥着卡里的节点对象
 * (engBindNodeInspector 里 `node.table = ...` 那种), 手点「保存」时会把
 * engState.card 换成主进程洗过的新副本并重画面板, 所以引用能重新绑上;
 * 自动保存要是也这么干, 用户正打字的那一行就指向一个没人认领的旧对象,
 * 后面所有输入都写进孤儿里 —— 下一次保存把整段改动丢掉。
 * 保持同一个对象, 引用就一直有效, 也就不需要重画。
 */
async function engAutoSave() {
  if (!engState.card) return;
  if (engState.autoSaveBusy) {
    // 有保存在飞: 记一笔, 等它落地后再来一次 (别丢这一笔)
    engState.autoSaveAgain = true;
    return;
  }
  const rev = engState.rev;
  if (rev === engState.savedRev) return;   // 没有新改动
  engState.autoSaveBusy = true;
  engSetSaveState('saving');
  let failed = false;
  try {
    // 范围是卡的内容, 存之前写回 —— 否则配了范围但没改节点时存下去的是旧的
    engCardScopeWriteBack();
    const snapshot = JSON.parse(JSON.stringify(engState.card));
    const r = await window.bridge.engine.save(snapshot);
    if (!r || !r.ok) {
      failed = true;
      engSetSaveState('err', (r && r.error) || '未知原因');
      return;
    }
    engState.engines = r.engines || engState.engines;
    engState.savedRev = rev;
    if (engState.rev === rev) {
      // 这次保存期间没有新改动, 才算真的干净了
      engState.dirty = false;
      engSetSaveState('saved');
    }
  } catch (e) {
    failed = true;
    engSetSaveState('err', (e && e.message) || String(e));
  } finally {
    engState.autoSaveBusy = false;
    // **失败时绝不自动重排。**
    //
    // 这里曾经写成"只要 rev !== savedRev 就再排一次", 结果是: 磁盘满 / 权限不对
    // 这类持续失败会让它每 900ms 重试一次, 永远不停 —— 界面看着像在正常工作,
    // 实际上一个改动都没存下去, 而且一直在空转。
    // 现在失败就停下, 把错误摆在顶部让用户看见; 下一次编辑、切走窗口、
    // 离开画板或关窗时会再试。
    if (!failed && (engState.autoSaveAgain || engState.rev !== engState.savedRev)) {
      engState.autoSaveAgain = false;
      engScheduleAutoSave();
    }
    engState.autoSaveAgain = false;
  }
}
/**
 * 把待保存的东西立刻落盘, 并等它真的落完。
 * 返回 true 表示"盘上已经是最新的"。
 *
 * 离开画板 / 切走窗口 / 关窗时调 —— 这几条路上不能只排个防抖就走人。
 */
async function engFlushAutoSave() {
  if (!engState.card) return true;
  if (engState.autoSaveTimer) {
 clearTimeout(engState.autoSaveTimer);
 engState.autoSaveTimer = null;
 }
  // 等已经在飞的那次落地 (它可能正好在改 engState.savedRev)
  let guard = 0;
  while (engState.autoSaveBusy && guard++ < 100) {
    await new Promise((r) => setTimeout(r, 40));
  }
  if (engState.rev === engState.savedRev) return true;
  await engAutoSave();
  guard = 0;
  while (engState.autoSaveBusy && guard++ < 100) {
    await new Promise((r) => setTimeout(r, 40));
  }
  return engState.rev === engState.savedRev;
}
/**
 * 关窗时的最后一道。beforeunload 里没法 await, 只能走同步 IPC 把这次挡住。
 * 只有真的有未落盘的改动才发 —— 平时关窗不该多一次写盘。
 */
function engFlushOnUnload() {
  if (!engState.card) return;
  if (engState.rev === engState.savedRev) return;
  if (!window.bridge.engine.saveSync) return;
  try {
    engCardScopeWriteBack();
    const r = window.bridge.engine.saveSync(JSON.parse(JSON.stringify(engState.card)));
    if (r && r.ok) engState.savedRev = engState.rev;
  } catch (e) {
    // 关窗路上没地方报错, 也不能拦着不让关
  }
}
/* ==================== 画板顶部信息条 ==================== */
/**
 * 顶部只留一行, 按三簇排: [测试] │ [全屏·保存·删除] │ [AI 搭建]。
 * 全屏/保存/删除都收成了中性的图标按钮 (靠 title 提示), 让这行尽量短;
 * 保存/删除原本是文字实心/描边按钮, 加上 AI 搭建的实心块, 一行里三个大色块,
 * 读起来乱 —— 收成图标后整行只剩 AI 搭建一个视觉重心。
 * 详情、什么时候使用、启用都收进"配置"弹框 —— 顶部不再堆三行,
 * 免得挤压下面的画布。
 */
function renderEngineHead() {
  const box = eq1('#engineHead');
  if (!box) return;
  if (!engState.card) {
    box.innerHTML = '<div class="engine-head-empty">没打开任何卡。</div>';
    return;
  }
  const c = engState.card;
  const off = c.enabled === false;
  box.innerHTML = `
    <div class="engine-head-row">
      <input class="engine-name-input" id="engineName" value="${engEsc(c.name)}" placeholder="流程卡名称" />
      <button class="eng-icon-btn" id="btnEngineCfg" title="配置：详情、什么时候使用、启用">${ENG_ICON_CFG}</button>
      ${off ? '<span class="eng-off-chip">已停用</span>' : ''}
      <span class="engine-dirty" id="engineDirty" hidden>有未保存的改动</span>
      <span class="engine-head-gap"></span>
      <button class="btn btn-sm eng-test-btn" id="btnEngTest" title="填一组样例输入，把这张卡真跑一遍">${ENG_ICON_PLAY}<span>测试</span></button>
      <span class="engine-head-div" aria-hidden="true"></span>
      <button class="eng-icon-btn ${engState.fullscreen ? 'on' : ''}" id="btnEngFull"></button>
      <button class="eng-icon-btn" id="btnSaveEngine" title="保存（改动会自动保存；点这里可以立刻存一次）">${icon('save')}</button>
      <button class="eng-icon-btn eng-icon-danger" id="btnDeleteEngine" title="删除这张卡">${icon('trash')}</button>
      <span class="engine-head-div" aria-hidden="true"></span>
      <!-- AI 放在整行最右: 面板是从右边滑出来的, 按钮贴着它,
           "按这个 -> 那边开" 的关系一眼就看得出来。 -->
      <button class="eng-ai-btn${engState.aiOpen ? ' on' : ''}" id="btnAiFab" title="让 AI 帮你搭这张卡">
        <svg class="eng-ai-btn-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.2 1.6l1.2 3.1 3.1 1.2-3.1 1.2-1.2 3.1-1.2-3.1L1.9 5.9l3.1-1.2z"/><path d="M11.6 9l.75 1.95 1.95.75-1.95.75-.75 1.95-.75-1.95-1.95-.75 1.95-.75z"/></svg>
        <span>AI 搭建</span>
      </button>
    </div>`;
  eq1('#engineName').addEventListener('input', (e) => {
 engState.card.name = e.target.value;
 engTouch();
 });
  eq1('#btnEngineCfg').addEventListener('click', openEngCfgModal);
  // AI 按钮就长在这一行里, 而这行每次渲染都重建 —— 所以绑在这里。
  // (原来它挂在 engBindAi 里, 那边有 dataset.bound 去重; 两边都绑会执行两次,
  //  点一下等于开关两下, 面板就不动了。)
  eq1('#btnAiFab').addEventListener('mousedown', (ev) => ev.stopPropagation());
  eq1('#btnAiFab').addEventListener('click', (ev) => {
 ev.stopPropagation();
 engAiTogglePanel();
 });
  eq1('#btnEngTest').addEventListener('click', openEngTest);
  eq1('#btnSaveEngine').addEventListener('click', engSave);
  eq1('#btnDeleteEngine').addEventListener('click', engDeleteCurrent);
  eq1('#btnEngFull').addEventListener('click', () => engToggleFullscreen());
  paintFullscreenBtn();
  // 刚重建出来的那行提示是写死的默认文案, 照当前真实状态重刷一次
  // (否则"已自动保存 14:23:05"会被换回"有未保存的改动")
  engSetSaveState(engState.autoSaveState, engState.autoSaveError);
  engValidate();
}
/** 全屏按钮的图标与提示随状态变 (两个方向: 进 / 出) */
function paintFullscreenBtn() {
  const btn = eq1('#btnEngFull');
  if (!btn) return;
  const on = engState.fullscreen;
  btn.innerHTML = on ? ENG_ICON_EXIT_FULL : ENG_ICON_FULL;
  btn.title = on ? '退出全屏（Esc）' : '全屏编辑';
  btn.classList.toggle('on', on);
}
/** 全屏编辑: 把上方的 topbar 与 tabbar 收掉, 画布独占整屏 */
function engToggleFullscreen(on) {
  const next = on === undefined ? !engState.fullscreen : !!on;
  if (next === engState.fullscreen) return;
  engState.fullscreen = next;
  const app = document.querySelector('.app');
  if (app) app.classList.toggle('eng-fullscreen', next);
  paintFullscreenBtn();
  // 画布尺寸变了, 节点高度与连线端点都要按新尺寸重新量
  requestAnimationFrame(() => { renderEngineCanvas(); });
}
/* ---- 测试: 拿样例输入把这张卡真跑一遍 (类 Coze 的试跑) ---- */
/**
 * 打开测试弹框。
 *
 * 样例值从两个地方来, 按可信度排:
 *   1. 上次测过的 (engState.testInputs) —— 作者通常反复试同一单
 *   2. 卡的 examples 里能抠出来的号 (用户写的示例问法里往往就带着真实单号)
 * 都没有就空着, 让作者自己填。
 */
function openEngTest() {
  const c = engState.card;
  const modal = eq1('#modalEngTest');
  if (!c || !modal) return;
  engSyncBatchMode();
  engRenderTestInputs();
  engRenderTestResult(null);
  const st = eq1('#engTestStatus');
  if (st) st.textContent = '';
  modal.hidden = false;
  // 批量模式下输入是多行框, focus 之后光标在里面, 直接粘就行
  const first = eq1('.eng-test-field input, .eng-test-field textarea', eq1('#engTestInputs'));
  if (first) first.focus();
}
function closeEngTest() {
  const modal = eq1('#modalEngTest');
  if (modal) modal.hidden = true;
}
function engTestModalOpen() {
  const modal = eq1('#modalEngTest');
  return !!modal && !modal.hidden;
}
/** 从示例问法里抠出一个像单号的东西, 当默认样例值 */
function engGuessSample() {
  const c = engState.card || {};
  for (const ex of (c.examples || [])) {
    const m = String(ex).match(/\b([A-Z]{2,4}\d{8,})\b/);
    if (m) return m[1];
  }
  return '';
}
function engRenderTestInputs() {
  const box = eq1('#engTestInputs');
  if (!box) return;
  const c = engState.card || {};
  const inputNode = (c.nodes || []).find((n) => n.type === 'input');
  const fields = (inputNode && inputNode.fields) || [];
  const saved = engState.testInputs || {};
  const guess = engGuessSample();
  if (!fields.length) {
    box.innerHTML = '<div class="eng-test-empty">这张卡没有入口字段，直接点「开始测试」就行。</div>';
    return;
  }
  // 任选其一的组要摆在一起, 并标一句"给一个就行" —— 否则测试的人会以为三个都得填
  const groups = [];
  for (const f of fields) {
    if (!f.group) continue;
    let g = groups.find((x) => x.name === f.group);
    if (!g) { g = { name: f.group, fields: [] }; groups.push(g); }
    g.fields.push(f);
  }
  const grouped = new Set(groups.flatMap((g) => g.fields.map((f) => f.key)));
  const plain = fields.filter((f) => !grouped.has(f.key));
  const batch = !!engState.testBatchMode;
  const inputHtml = (f, inGroup) => {
    const v = saved[f.key] != null ? saved[f.key] : (f.required && !inGroup ? guess : '');
    const mark = inGroup ? '' : (f.required ? '<b class="eng-test-req">*</b>' : '');
    const ph = batch
      ? '一行一个，粘多行'
      : (f.desc || (f.required ? '必填' : '可空'));
    // 批量模式用多行框: 用户是从工单/表格里一次复制一列过来的, 单行框会
    // 只留最后一个值 —— 而他以为都填进去了。
    if (batch) {
      return `<label class="eng-test-field">
      <span class="eng-test-label">${engEsc(f.label || f.key)}${mark}</span>
      <textarea data-tkey="${engEsc(f.key)}" rows="3" placeholder="${engEsc(ph)}">${engEsc(v)}</textarea>
    </label>`;
    }
    return `<label class="eng-test-field">
      <span class="eng-test-label">${engEsc(f.label || f.key)}${mark}</span>
      <input type="text" data-tkey="${engEsc(f.key)}" value="${engEsc(v)}" placeholder="${engEsc(ph)}" />
    </label>`;
  };
  box.innerHTML =
    (batch ? `<div class="eng-test-batch-note">批量模式：每个框里一行一个值。<b>第 N 行和第 N 行配成一组</b>，组数按最长的那个框算。空白行跳过。</div>` : '') +
    plain.map((f) => inputHtml(f, false)).join('') +
    groups.map((g) => `<div class="eng-test-group">
      <div class="eng-test-group-head">${engEsc(g.name)} —— 以下任选其一，给一个就行</div>
      ${g.fields.map((f) => inputHtml(f, true)).join('')}
    </div>`).join('');
  eqAll('[data-tkey]', box).forEach((el) => {
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); engTestRun(); }
    });
  });
}
function engReadTestInputs() {
  const out = {};
  eqAll('#engTestInputs [data-tkey]').forEach((el) => { out[el.dataset.tkey] = el.value; });
  return out;
}
async function engTestRun(probe) {
  if (engState.testBusy || !engState.card) return;
  // 批量模式下走另一条路: 一张卡跑 N 组输入 (主进程整批共用一套连接)
  if (engState.testBatchMode) return engTestRunBatch();
  // 点按钮时浏览器会把 click 事件当第一个参数传进来 —— 所以严格判 === true
  const useProbe = probe === true;
  const inputs = engReadTestInputs();
  engState.testInputs = inputs;
  const btn = eq1(useProbe ? '#btnEngTestProbe' : '#btnEngTestRun');
  const st = eq1('#engTestStatus');
  engState.testBusy = true;
  if (btn) { btn.disabled = true; btn.textContent = useProbe ? '探针中…' : '测试中…'; }
  if (st) { st.textContent = useProbe ? '探针跑：只取前 200 行，秒级…' : '正在按卡里的路线跑…'; st.className = 'eng-test-status'; }
  engRenderTestResult(null);
  let r;
  try {
    r = await window.bridge.engine.test({ card: engState.card, inputs, probe: useProbe });
  } catch (e) {
    r = { ok: false, error: (e && e.message) || String(e) };
  }
  engState.testBusy = false;
  if (btn) { btn.disabled = false; btn.textContent = useProbe ? '快速探针' : '开始测试'; }
  if (!r || !r.ok) {
    if (st) { st.textContent = '没跑起来'; st.className = 'eng-test-status err'; }
    engRenderTestResult({ fatal: (r && r.error) || '未知原因' });
    return;
  }
  const res = r.result;
  if (st) {
    st.textContent = res.ok ? `跑通了 · ${res.steps.length} 步` : '中途断了';
    st.className = 'eng-test-status ' + (res.ok ? 'ok' : 'err');
  }
  engRenderTestResult(res);
}
/**
 * 把多行框里的值读成 N 组输入。
 *
 * 规则: 每个框按行拆, **第 N 行和第 N 行配成一组**, 组数按最长的那个框算。
 * 短了的框缺的行留空 —— 让卡自己报"缺少必要输入", 比我们瞎补一个值好。
 * 整行都空的跳过 (从工单/表格复制过来经常带空行)。
 *
 * 为什么不做笛卡尔积: 3 个字段各 3 行就是 27 组, 而用户想要的是 3 组。
 */
function engReadTestInputsBatch() {
  const els = eqAll('#engTestInputs [data-tkey]');
  const cols = els.map((el) => ({
    key: el.dataset.tkey,
    lines: String(el.value || '').split(/\r?\n/).map((s) => s.trim())
  }));
  if (!cols.length) return [];
  const max = Math.max(...cols.map((c) => c.lines.length));
  const sets = [];
  for (let i = 0; i < max; i++) {
    const one = {};
    let any = false;
    for (const c of cols) {
      const v = c.lines[i] || '';
      one[c.key] = v;
      if (v) any = true;
    }
    if (any) sets.push(one);
  }
  return sets;
}
/** 批量模式的按钮状态。切模式、开窗都要调一次 */
function engSyncBatchMode() {
  const b = eq1('#btnEngTestBatchMode');
  if (!b) return;
  b.classList.toggle('on', !!engState.testBatchMode);
  b.title = engState.testBatchMode
    ? '批量模式：每个框一行一个值，第 N 行和第 N 行配成一组。点一下切回单次。'
    : '一列一个值：粘多行，一次把每一行都跑一遍';
}
async function engTestRunBatch() {
  if (engState.testBusy || !engState.card) return;
  const sets = engReadTestInputsBatch();
  const st = eq1('#engTestStatus');
  const btn = eq1('#btnEngTestRun');
  if (!sets.length) {
    if (st) { st.textContent = '一行都没填'; st.className = 'eng-test-status err'; }
    return;
  }
  engState.testBusy = true;
  if (btn) { btn.disabled = true; btn.textContent = '批量测试中…'; }
  if (st) { st.textContent = `正在跑 ${sets.length} 组…`; st.className = 'eng-test-status'; }
  engRenderTestResult(null);
  let r;
  try {
    r = await window.bridge.engine.testBatch({ card: engState.card, inputSets: sets, concurrency: 4 });
  } catch (e) {
    r = { ok: false, error: (e && e.message) || String(e) };
  }
  engState.testBusy = false;
  if (btn) { btn.disabled = false; btn.textContent = '开始测试'; }
  if (!r || !r.ok) {
    if (st) { st.textContent = '没跑起来'; st.className = 'eng-test-status err'; }
    engRenderTestResult({ fatal: (r && r.error) || '未知原因' });
    return;
  }
  if (st) {
    st.textContent = `${r.okCount}/${r.total} 组跑通`
      + (r.failCount ? ` · ${r.failCount} 组失败` : '')
      + (r.cancelled ? ' · 已取消' : '');
    st.className = 'eng-test-status ' + (r.failCount ? 'err' : 'ok');
  }
  engRenderTestBatchResult(r);
}
/**
 * 批量结果: 一行一组。
 *
 * 摘要放最上面 —— "3 单里有 2 单落在同一个结论上"是最需要一眼看到的,
 * 而一张 3 行的表反而要人自己扫。归堆在主进程算 (见 testEngineBatch)。
 */
function engRenderTestBatchResult(r) {
  const box = eq1('#engTestResult');
  if (!box) return;
  const runs = r.runs || [];
  const buckets = (r.buckets || []).map((b) =>
    `<span class="eng-batch-bucket">${b.count} 组 → ${engEsc(b.title || '输出')}</span>`
  ).join('');
  const rows = runs.map((run) => {
    const key = Object.keys(run.inputs || {}).map((k) => run.inputs[k]).join(' / ');
    const first = (run.outputs && run.outputs[0]) || null;
    const text = run.ok
      ? ((first && first.text) || run.answer || '(没有输出)')
      : (run.error || '失败');
    return `<tr class="${run.ok ? '' : 'bad'}">
      <td class="k">${engEsc(key)}</td>
      <td>${engEsc(text)}</td>
      <td class="ms">${run.elapsedMs != null ? engEsc(String(run.elapsedMs)) + 'ms' : ''}</td>
    </tr>`;
  }).join('');
  box.innerHTML = `
    <div class="eng-batch-sum">
      ${buckets || '<span class="eng-batch-bucket">没有输出</span>'}
      <span class="eng-batch-time">共 ${r.total} 组 · ${r.okCount} 成功`
      + `${r.failCount ? ` · <b>${r.failCount} 失败</b>` : ''}${r.cancelled ? ' · 已取消' : ''}</span>
    </div>
    <table class="eng-batch-table">
      <thead><tr><th>输入</th><th>结论</th><th>耗时</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}
/** 把一次试跑的过程画出来: 每一步一行, 断了的那步标红 */
function engRenderTestResult(res) {
  const box = eq1('#engTestResult');
  if (!box) return;
  if (!res) { box.innerHTML = ''; return; }
  if (res.fatal) {
    box.innerHTML = `<div class="eng-test-note err">测试没跑起来：${engEsc(res.fatal)}</div>`;
    return;
  }
  const steps = (res.steps || []).map((s) => {
    const bits = [];
    if (typeof s.rowCount === 'number') bits.push(`<span class="eng-test-chip">${s.rowCount} 行</span>`);
    if (s.elapsedMs) bits.push(`<span class="eng-test-chip">${s.elapsedMs}ms</span>`);
    if (s.condition) bits.push(`<span class="eng-test-chip ${s.result ? 'ok' : 'no'}">${s.result ? '成立' : '不成立'}</span>`);
    const body = [];
    if (s.sql) body.push(`<pre class="eng-test-sql">${engEsc(s.sql)}</pre>`);
    if (s.condition) body.push(`<div class="eng-test-sub">判定：${engEsc(s.condition)}</div>`);
    if (s.text) body.push(`<div class="eng-test-sub">结论：${engEsc(s.text)}</div>`);
    if (s.error) body.push(`<div class="eng-test-sub err">${engEsc(s.error)}</div>`);
    // 这一步真查回来的前几行 —— Coze 那种"节点下面挂着它的返回"。
    // 作者最常问的就是"它到底查到什么了", 摆出来比任何解释都直接。
    if ((s.sample || []).length) {
      const rows = s.sample.map((r) => {
        const t = Object.keys(r).map((k) => `${k}=${r[k] === null ? 'NULL' : String(r[k])}`).join('  ');
        return `<li title="${engEsc(t)}">${engEsc(t)}</li>`;
      }).join('');
      const more = s.sampleTruncated ? `<li class="eng-test-rows-more">… 还有更多，只摆了前 ${s.sample.length} 行</li>` : '';
      body.push(`<ul class="eng-test-rows">${rows}${more}</ul>`);
    }
    const hasBody = body.length > 0;
    const collapsed = hasBody && !!engState.testCollapsed[s.id];
    const fold = hasBody
      ? `<button class="eng-test-step-fold" data-fold="${engEsc(s.id)}">${collapsed ? '展开' : '收起'}</button>`
      : '';
    return `<div class="eng-test-step${s.error ? ' err' : ''}${collapsed ? ' collapsed' : ''}" data-step="${engEsc(s.id)}">
      <div class="eng-test-step-head">
        <span class="eng-test-dot eng-test-dot-${engEsc(s.type)}"></span>
        <span class="eng-test-step-title">${engEsc(s.title)}</span>
        ${bits.join('')}
        ${fold}
      </div>
      ${body.join('')}
    </div>`;
  }).join('');
  const notes = [];
  if ((res.blankParams || []).length) {
    notes.push(`这些参数这一轮取到的是空值（上游没查到行，或那一列本身是 NULL），SQL 里的条件被抹成了 <code>''</code>：${res.blankParams.map(engEsc).join('、')}`);
  }
  if ((res.missingRefs || []).length) {
    notes.push(`结论里这些引用没落地，渲染出来是空白：${res.missingRefs.map(engEsc).join('、')}`);
  }
  const answer = res.ok
    ? `<div class="eng-test-answer">
         <div class="eng-test-answer-head">用户会看到的结论</div>
         <div class="eng-test-answer-body">${engEsc(res.answer || '（出口模板是空的，用户什么也看不到）')}</div>
       </div>`
    : `<div class="eng-test-note err">断在这一步：${engEsc(res.error || '未知错误')}${res.hint ? '<br>' + engEsc(res.hint) : ''}</div>`;
  box.innerHTML =
    `<div class="eng-test-steps">${steps}</div>` +
    (notes.length ? `<div class="eng-test-note warn">${notes.join('<br>')}</div>` : '') +
    answer;
  // 每个节点自己的返回可以收起 —— 步骤多的时候一屏放不下
  eqAll('[data-fold]', box).forEach((b) => {
    b.addEventListener('click', () => {
      const id = b.dataset.fold;
      engState.testCollapsed[id] = !engState.testCollapsed[id];
      const wrap = b.closest('.eng-test-step');
      if (wrap) {
        wrap.classList.toggle('collapsed', !!engState.testCollapsed[id]);
        b.textContent = engState.testCollapsed[id] ? '展开' : '收起';
      }
    });
  });
}
/* ==================== 自动测试: 测试 Agent ⇄ 开发 Agent ==================== */
/** 开始自动测试: 跑不通就自动诊断并修, 直到跑通 */
async function engAutoTest() {
  if (engState.autoRunId || !engState.card) return;
  // 自动测试跑的是"这张卡 + 它自己的可用范围"。范围必须先写回卡上再送出去,
  // 否则改过范围还没保存时, 测试用的还是上一次的范围 (跟界面上看到的对不上)。
  engCardScopeWriteBack();
  const inputs = engReadTestInputs();
  engState.testInputs = inputs;
  engState.autoRounds = [];
  engState.autoCurrentRound = 0;
  engState.testCollapsed = {};
  engState.autoDone = false;
  const btn = eq1('#btnEngTestAuto');
  const cancel = eq1('#btnEngTestCancel');
  const st = eq1('#engTestStatus');
  if (btn) btn.disabled = true;
  if (cancel) cancel.hidden = false;
  if (st) { st.textContent = '自动测试中…'; st.className = 'eng-test-status'; }
  engRenderTestResult(null);
  engRenderAutoRounds();
  let r;
  try {
    r = await window.bridge.engine.autoTest({
      card: engState.card,
      inputs,
      pool: engAiScopeForSend()
    });
  } catch (e) {
    r = { ok: false, error: (e && e.message) || String(e) };
  }
  engState.autoRunId = null;
  engState.autoDone = true;   // 收尾: 之后迟到的进度事件不再回写状态行
  if (btn) btn.disabled = false;
  if (cancel) cancel.hidden = true;
  // 最后一轮的报告常常还在路上 (事件和返回值两条通道没有先后保证)。
  // 返回值里带着权威的 rounds, 用它把本地流水补齐 —— 不然面板上最后一轮
  // 会永远停在"进行中", 明明已经跑通了。
  if (r && r.ok && Array.isArray(r.rounds)) {
    for (const rr of r.rounds) {
      const local = engAutoRound(rr.round);
      if (!local) {
        engState.autoRounds.push({
          round: rr.round, phase: 'done', acts: [],
          report: rr.report || null, run: null
        });
        continue;
      }
      if (rr.report) local.report = rr.report;
      if (local.phase !== 'ask') local.phase = 'done';
    }
  }
  // 用户按了停止: 这不是失败, 别摆一个"没跑起来"的报错框出来
  if (r && r.verdict === 'cancelled') {
    if (st) { st.textContent = '已停止'; st.className = 'eng-test-status'; }
    engRenderAutoRounds();
    return;
  }
  // 步数用尽: 跑了, 但没跑完 —— 和"没跑起来"是两回事, 分开说
  if (r && r.verdict === 'limit') {
    const why = '开发 Agent 步数用尽，这张卡可能只改了一半 —— 画板上的卡没有动，请检查后再试';
    if (st) { st.textContent = '改到一半停住了'; st.className = 'eng-test-status err'; }
    engRenderTestResult({ fatal: why });
    engRenderAutoRounds();
    return;
  }
  if (!r || !r.ok) {
    if (st) { st.textContent = '没跑起来'; st.className = 'eng-test-status err'; }
    engRenderTestResult({ fatal: (r && r.error) || '未知原因' });
    return;
  }
  // 卡被改动了就接回画板。但只有真的跑通才敢说"修好了" ——
  // exhausted / ask 这两种情况卡也可能变了, 那是半成品。
  const passed = r.verdict === 'pass';
  if (r.card && !engCardEquals(engState.card, r.card)) {
    engAdoptCard(r.card);
    engTouch();
    renderEngineCanvas();
    renderEngineInspector();
    engValidate();
    if (passed) {
      engToast('自动测试修好了这张卡，已同步到画板', 'ok');
    } else {
      engToast('画板上的卡有改动，但还没跑通 —— 请确认后再保存', 'warn');
    }
  }
  if (st) {
    st.textContent = passed
      ? `跑通了 · 共 ${r.rounds.length} 轮`
      : (r.verdict === 'ask' ? '需要你确认一件事' : `没跑通 · 试了 ${r.rounds.length} 轮`);
    st.className = 'eng-test-status ' + (passed ? 'ok' : 'err');
  }
  engRenderAutoRounds();
}
async function engAutoTestStop() {
  if (!engState.autoRunId) return;
  try { await window.bridge.engine.autoTestCancel({ runId: engState.autoRunId }); } catch (e) {}
  engState.autoRunId = null;
  engState.autoDone = true;
  const cancel = eq1('#btnEngTestCancel');
  const btn = eq1('#btnEngTestAuto');
  if (cancel) cancel.hidden = true;
  if (btn) btn.disabled = false;
  const st = eq1('#engTestStatus');
  if (st) { st.textContent = '已停止'; st.className = 'eng-test-status'; }
}
/** 主进程推来的自动测试事件 */
function engAutoTestEvent(ev) {
  if (!ev) return;
  if (ev.type === 'test_start') {
    engState.autoRunId = ev.runId;
    return;
  }
  // 进度事件走的是 webContents.send, 最终结果走的是 invoke 的返回值 ——
  // 两条通道之间**没有先后保证**。收尾之后迟到的 test_round 会把
  // "跑通了 · 共 N 轮" 冲回"正在跑…"。所以收尾了就一律不再回写;
  // 顺带按 runId 认一下, 别让上一轮的尾巴污染这一轮。
  if (engState.autoDone) return;
  if (ev.runId && engState.autoRunId && ev.runId !== engState.autoRunId) return;
  if (ev.type === 'test_phase') {
    const cur = engAutoRound(ev.round || engState.autoCurrentRound);
    if (cur) cur.phase = ev.phase;
    engAutoStatus(ev.message);
    return;
  }
  if (ev.type === 'test_run_done') {
    const cur = engAutoRound(ev.round || engState.autoCurrentRound);
    if (cur) cur.run = ev.run;
    // 顺手把这次跑的步骤也画到下面 (和单次测试同一种视图)
    engRenderTestResult(ev.run);
    engRenderAutoRounds();
    return;
  }
  if (ev.type === 'test_act') {
    const cur = engAutoRound(ev.round || engState.autoCurrentRound);
    if (cur) cur.acts.push({ kind: 'act', text: ev.text });
    engRenderAutoRounds();
    return;
  }
  if (ev.type === 'test_say') {
    const cur = engAutoRound(ev.round || engState.autoCurrentRound);
    if (cur) cur.acts.push({ kind: 'say', text: ev.text });
    engRenderAutoRounds();
    return;
  }
  if (ev.type === 'test_report') {
    const cur = engAutoRound(ev.round || engState.autoCurrentRound);
    if (cur) cur.report = ev.report;
    engRenderAutoRounds();
    return;
  }
  if (ev.type === 'test_round') {
    if (ev.phase === 'test') {
      engState.autoCurrentRound = ev.round;
      engState.autoRounds.push({ round: ev.round, phase: 'test', acts: [], report: null, run: null });
    }
    engAutoStatus(ev.message);
    engRenderAutoRounds();
    return;
  }
  if (ev.type === 'test_cancelled') {
    engAutoStatus('已停止');
    return;
  }
}
function engAutoRound(n) {
  return engState.autoRounds.find((r) => r.round === n) || null;
}
function engAutoStatus(msg) {
  const st = eq1('#engTestStatus');
  if (st && msg) { st.textContent = msg; st.className = 'eng-test-status'; }
}
/** 画轮次流水: 每轮一张卡, 里面有诊断日志、结论、修复建议 */
function engRenderAutoRounds() {
  const box = eq1('#engTestRounds');
  if (!box) return;
  if (!engState.autoRounds.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = engState.autoRounds.map((r) => {
    const rep = r.report;
    const badge = rep
      ? (rep.verdict === 'pass'
        ? '<span class="eng-round-badge ok">跑通</span>'
        : '<span class="eng-round-badge err">没通</span>')
      : '<span class="eng-round-badge">进行中</span>';
    const acts = r.acts.map((a) => {
      const cls = a.kind === 'say' ? 'eng-round-say' : 'eng-round-act';
      return `<div class="${cls}">${engEsc(a.text)}</div>`;
    }).join('');
    let diag = '';
    if (rep && rep.verdict === 'fail') {
      const bits = [];
      if (rep.brokenStep) bits.push(`<div class="eng-round-row"><b>断在哪</b>${engEsc(rep.brokenStep)}</div>`);
      if (rep.rootCause) bits.push(`<div class="eng-round-row"><b>根因</b>${engEsc(rep.rootCause)}</div>`);
      if ((rep.evidence || []).length) {
        bits.push(`<div class="eng-round-row"><b>证据</b><ul class="eng-round-ul">${rep.evidence.map((e) => `<li>${engEsc(e)}</li>`).join('')}</ul></div>`);
      }
      if ((rep.fixes || []).length) {
        bits.push(`<div class="eng-round-row"><b>修复建议</b><ul class="eng-round-ul">${rep.fixes.map((f) => `<li><code>${engEsc(f.action)}</code> ${engEsc(f.nodeTitle || f.nodeId || '')}：${engEsc(f.detail)}${f.reason ? '<span class="eng-round-why">（' + engEsc(f.reason) + '）</span>' : ''}</li>`).join('')}</ul></div>`);
      }
      diag = bits.join('');
    } else if (rep && rep.verdict === 'pass') {
      diag = `<div class="eng-round-row">${engEsc(rep.summary || '跑通了。')}</div>`;
    }
    return `<div class="eng-round${rep && rep.verdict === 'pass' ? ' ok' : ''}">
      <div class="eng-round-head">${badge}<span class="eng-round-title">第 ${r.round} 轮</span>${r.phase === 'fix' ? '<span class="eng-round-tag">正在修</span>' : ''}</div>
      ${acts ? `<div class="eng-round-acts">${acts}</div>` : ''}
      ${diag}
    </div>`;
  }).join('');
}
/* ---- 配置弹框: 详情 / 什么时候使用 / 启用 ---- */
function openEngCfgModal() {
  const c = engState.card;
  if (!c) return;
  const d = eq1('#engCfgDesc');
  const x = eq1('#engCfgExamples');
  const e = eq1('#engCfgEnabled');
  if (!d || !x || !e) return;
  d.value = c.description || '';
  x.value = (c.examples || []).join(' | ');
  e.checked = c.enabled !== false;
  const modal = eq1('#modalEngCfg');
  if (modal) modal.hidden = false;
  d.focus();
}
function closeEngCfgModal() {
  const modal = eq1('#modalEngCfg');
  if (modal) modal.hidden = true;
}
function engCfgModalOpen() {
  const modal = eq1('#modalEngCfg');
  return !!modal && !modal.hidden;
}
/** 弹框里的改动即时落到内存里的卡上 (和以前顶部输入框一个口径) */
function engBindCfgModal() {
  const modal = eq1('#modalEngCfg');
  if (!modal || modal.dataset.bound) return;
  modal.dataset.bound = '1';
  eqAll('[data-close]', modal).forEach((el) => el.addEventListener('click', closeEngCfgModal));
  const d = eq1('#engCfgDesc');
  const x = eq1('#engCfgExamples');
  const e = eq1('#engCfgEnabled');
  if (d) d.addEventListener('input', () => { engState.card.description = d.value; engTouch(); });
  if (x) x.addEventListener('input', () => {
    engState.card.examples = x.value.split('|').map((s) => s.trim()).filter(Boolean);
    engTouch();
  });
  if (e) e.addEventListener('change', () => {
    engState.card.enabled = e.checked;
    engTouch();
    renderEngineHead();   // 标题行的"已停用"要跟着变
  });
}
function engBindTestModal() {
  const modal = eq1('#modalEngTest');
  if (!modal || modal.dataset.bound) return;
  modal.dataset.bound = '1';
  eqAll('[data-close]', modal).forEach((el) => el.addEventListener('click', closeEngTest));
  const run = eq1('#btnEngTestRun');
  if (run) run.addEventListener('click', engTestRun);
  // 快速探针: 同样的跑法, 但给每条取数 SQL 套行数上限, 秒级确认链路通不通
  const probeBtn = eq1('#btnEngTestProbe');
  if (probeBtn) probeBtn.addEventListener('click', () => engTestRun(true));
  // 批量开关: 只切输入框的形状 (单行 -> 多行), 不改卡
  const batchBtn = eq1('#btnEngTestBatchMode');
  if (batchBtn) batchBtn.addEventListener('click', () => {
    // 切之前先把已经填的存下来, 否则重画之后输入就没了
    engState.testInputs = engReadTestInputs();
    engState.testBatchMode = !engState.testBatchMode;
    engSyncBatchMode();
    engRenderTestInputs();
  });
  const auto = eq1('#btnEngTestAuto');
  if (auto) auto.addEventListener('click', engAutoTest);
  const cancel = eq1('#btnEngTestCancel');
  if (cancel) cancel.addEventListener('click', engAutoTestStop);
  // 自动测试的进度是主进程推过来的 (一轮一轮推)
  if (window.bridge.engine.onAutoTestEvent && !engState.autoSubscribed) {
    engState.autoSubscribed = true;
    window.bridge.engine.onAutoTestEvent(engAutoTestEvent);
  }
}
/** 存之前先把问题指出来 —— 校验在 lib/engine.js, 这里只负责显示 */
async function engValidate() {
  const box = eq1('#engineIssues');
  const dock = eq1('#engIssuesDock');
  if (!box || !dock) return;
  if (!engState.card) { dock.hidden = true; box.innerHTML = ''; return; }
  const seq = ++engState.validateSeq;
  let r = null;
  try { r = await window.bridge.engine.validate(engState.card); } catch (e) { r = null; }
  // 校验是异步的: 期间用户又改了卡的话, 这个结果已经过期, 丢掉
  if (seq !== engState.validateSeq) return;
  const errs = (r && r.errors) || [];
  const warns = (r && r.warnings) || [];
  if (!errs.length && !warns.length) {
    dock.hidden = true;
    dock.classList.remove('open', 'has-err');
    box.innerHTML = '';
    return;
  }
  dock.hidden = false;
  dock.classList.toggle('has-err', errs.length > 0);
  const tip = eq1('#engIssuesTip');
  if (tip) {
    // 小条的文案要跟展开后的条数对得上
    if (errs.length && warns.length) tip.textContent = `${errs.length} 个问题 · ${warns.length} 条提醒`;
    else if (errs.length) tip.textContent = `${errs.length} 个问题待处理`;
    else tip.textContent = `${warns.length} 条提醒`;
  }
  box.innerHTML = errs.map((t) => `<div class="engine-issue engine-issue-err">${engEsc(t)}</div>`)
    .concat(warns.map((t) => `<div class="engine-issue engine-issue-warn">${engEsc(t)}</div>`))
    .join('');
}
/** 左下角检测条的展开 / 收起 */
function engBindIssuesDock() {
  const btn = eq1('#btnIssuesToggle');
  const dock = eq1('#engIssuesDock');
  if (!btn || !dock || btn.dataset.bound) return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', () => dock.classList.toggle('open'));
}
/* ==================== 画布 ==================== */
function renderEngineCanvas() {
  const world = eq1('#engineWorld');
  const nodesBox = eq1('#engineNodes');
  const svg = eq1('#engineEdges');
  if (!world || !nodesBox) return;
  if (!engState.card) {
    world.style.display = 'none';
    return;
  }
  world.style.display = '';
  world.style.transform = `translate(${engState.pan.x}px, ${engState.pan.y}px) scale(${engState.zoom})`;
  const card = engState.card;
  // ---- 节点 ----
  nodesBox.innerHTML = card.nodes.map((n) => engNodeHtml(n)).join('');
  eqAll('[data-node]', nodesBox).forEach((el) => {
    const id = el.dataset.node;
    const node = card.nodes.find((x) => x.id === id);
    if (!node) return;
    el.style.left = node.x + 'px';
    el.style.top = node.y + 'px';
    el.style.width = ENG_NODE_W + 'px';
    el.addEventListener('mousedown', (ev) => engNodeMouseDown(ev, node));
    // **双击**节点才打开编辑框 (单击只选中, 不弹 —— 见 engNodeMouseDown)
    el.addEventListener('dblclick', (ev) => {
      if (ev.target.closest('.eng-port-in, .eng-port-out')) return;
      ev.preventDefault();
      ev.stopPropagation();
      engState.selectedNode = node.id;
      engState.selectedEdge = null;
      engState.inspOpen = true;
      engSyncNodeSelection();
      renderEngineInspector();
    });
    const inDot = eq1('.eng-port-in', el);
    if (inDot) inDot.addEventListener('mousedown', (ev) => ev.stopPropagation());
  });
  // ---- 连线 (节点的实际高度要量出来, 所以放在节点渲染之后) ----
  if (svg) {
    svg.setAttribute('width', 6000);
    svg.setAttribute('height', 4000);
    svg.innerHTML = engEdgesSvg(card, nodesBox);
    eqAll('[data-edge]', svg).forEach((p) => {
      p.addEventListener('mousedown', (ev) => {
        ev.stopPropagation();
        engState.selectedEdge = { from: p.dataset.from, port: p.dataset.port };
        engState.selectedNode = null;
        renderEngineCanvas();
        renderEngineInspector();
      });
    });
  }
}
function engNodeHtml(n) {
  const bits = [];
  if (n.type === 'input') {
    const fs = (n.fields || []).filter((f) => f.key);
    if (!fs.length) { bits.push('<i>还没配输入项</i>'); }
    else {
      // 任选其一要单独说, 否则画板上看不出这三个是可以只给一个的
      const plain = fs.filter((f) => !f.group);
      if (plain.length) bits.push(plain.map((f) => engEsc(f.label || f.key) + (f.required ? ' *' : '')).join('、'));
      const groups = [];
      for (const f of fs) {
        if (!f.group) continue;
        let g = groups.find((x) => x.name === f.group);
        if (!g) { g = { name: f.group, members: [] }; groups.push(g); }
        g.members.push(f);
      }
      for (const g of groups) {
        bits.push(`<span class="eng-anyof">任选其一 · ${engEsc(g.name)}：${g.members.map((f) => engEsc(f.label || f.key)).join(' / ')}</span>`);
      }
    }
  } else if (n.type === 'query') {
    bits.push(n.table ? '表 <b>' + engEsc(n.table) + '</b>' : '<i>还没选表</i>');
    if (n.sql) bits.push('<code>' + engEsc(n.sql.length > 60 ? n.sql.slice(0, 60) + '…' : n.sql) + '</code>');
    const fs = (n.fields || []).filter((f) => f.key).map((f) => f.label || f.key);
    if (fs.length) bits.push('输入 ' + engEsc(fs.join('、')));
    const cols = (n.outputs || []).map((c) => c.label || c.key);
    if (cols.length) bits.push('输出 ' + engEsc(cols.join('、')));
  } else if (n.type === 'condition') {
    bits.push(n.expr ? engEsc(engExprText(n.expr)) : '<i>还没配规则</i>');
  } else if (n.type === 'output') {
    bits.push(n.template ? '<code>' + engEsc(n.template) + '</code>' : '<i>还没写结论模板</i>');
  }
  const sel = engState.selectedNode === n.id ? ' selected' : '';
  return `<div class="eng-node eng-node-${n.type}${sel}" data-node="${engEsc(n.id)}">    <div class="eng-node-head">      <span class="eng-node-kind eng-kind-${n.type}">${ENG_LABEL[n.type] || n.type}</span>      <span class="eng-node-title">${engEsc(n.title || ENG_LABEL[n.type])}</span>    </div>    <div class="eng-node-body">${bits.map((b) => '<div class="eng-node-line">' + b + '</div>').join('')}</div>    ${n.type === 'input' ? '' : '<span class="eng-port eng-port-in" data-port-in="1"></span>'}    ${n.type === 'condition'      ? '<span class="eng-port eng-port-out eng-port-true" data-port="true" title="成立"></span>' +        '<span class="eng-port eng-port-out eng-port-false" data-port="false" title="不成立"></span>'      : (n.type === 'output' ? '' : '<span class="eng-port eng-port-out" data-port="out" title="拖出去连线"></span>')}  </div>`;
}
/** 端口在世界坐标里的位置 —— 高度是量出来的 */
function engPortPos(nodesBox, node, which) {
  const el = eq1(`[data-node="${node.id}"]`, nodesBox);
  const w = el ? el.offsetWidth : ENG_NODE_W;
  const h = el ? el.offsetHeight : 70;
  const x = node.x;
  const y = node.y;
  if (which === 'in') return { x: x, y: y + h / 2 };
  if (node.type === 'condition') {
    // 两个出口按上下分开摆, 免得两条线叠在一起
    const trueLayer = el ? eq1('.eng-port-true', el) : null;
    const falseLayer = el ? eq1('.eng-port-false', el) : null;
    const ty = trueLayer ? trueLayer.offsetTop + trueLayer.offsetHeight / 2 : h * 0.35;
    const fy = falseLayer ? falseLayer.offsetTop + falseLayer.offsetHeight / 2 : h * 0.7;
    return { x: x + w, y: y + (which === 'true' ? ty : fy) };
  }
  return { x: x + w, y: y + h / 2 };
}
function engBezier(a, b) {
  const dx = Math.max(36, Math.abs(b.x - a.x) * 0.45);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}
function engEdgesSvg(card, nodesBox) {
  const byId = new Map(card.nodes.map((n) => [n.id, n]));
  let out = '';
  for (const e of card.edges || []) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from || !to) continue;
    const a = engPortPos(nodesBox, from, e.port || 'out');
    const b = engPortPos(nodesBox, to, 'in');
    const d = engBezier(a, b);
    const cls = (e.port === 'true' ? ' eng-edge-true' : e.port === 'false' ? ' eng-edge-false' : '') +
      (engState.selectedEdge && engState.selectedEdge.from === e.from && engState.selectedEdge.port === e.port ? ' selected' : '');
    out += `<path class="eng-edge-hit" data-edge="1" data-from="${engEsc(e.from)}" data-port="${engEsc(e.port || 'out')}" d="${d}" />            <path class="eng-edge${cls}" d="${d}" />`;
    if (e.port === 'true' || e.port === 'false') {
      out += `<text class="eng-edge-label" x="${a.x + 10}" y="${a.y + (e.port === 'true' ? -6 : 14)}">${e.port === 'true' ? '成立' : '不成立'}</text>`;
    }
  }
  return out;
}
/** 规则翻译成人话 (与 lib/engine.js 的 describeExpr 同口径, 这边只为了画布上看着顺) */
function engExprText(expr) {
  if (!expr) return '';
  if (expr.type === 'group') {
    return '(' + (expr.items || []).map(engExprText).join(expr.logic === 'or' ? ' 或 ' : ' 且 ') + ')';
  }
  const word = (ENG_CMP.find((x) => x[0] === expr.op) || ['', expr.op])[1];
  const lhs = String(expr.left || '?');
  if (expr.op === 'empty' || expr.op === 'notEmpty') return lhs + ' ' + word;
  return `${lhs} ${word} ${expr.right === '' || expr.right == null ? '?' : JSON.stringify(expr.right)}`;
}
/** 打开画板时把内容拉进视野 */
function engFitIfNeeded() {
  const wrap = eq1('#engineCanvas');
  const card = engState.card;
  if (!wrap || !card || !card.nodes.length) return;
  const w = wrap.clientWidth, h = wrap.clientHeight;
  if (!w || !h) return;
  let maxR = 0, maxB = 0;
  card.nodes.forEach((n) => {
    maxR = Math.max(maxR, n.x + ENG_NODE_W + 40);
    maxB = Math.max(maxB, n.y + 150);
  });
  const z = Math.min((w - 70) / maxR, (h - 90) / maxB, 1);
  engState.zoom = Math.max(0.35, z);
  engState.pan = { x: 26, y: Math.max(18, (h - maxB * engState.zoom) / 2) };
  renderEngineCanvas();
}
/* ---- 画布交互: 拖节点 / 拉连线 / 平移 / 缩放 ---- */
/** 只切"选中"高亮的 class, **不重渲染**整块节点 —— 重渲染会把节点元素换掉, 双击就接不上了 */
function engSyncNodeSelection() {
  const box = eq1('#engineNodes');
  if (!box) return;
  eqAll('[data-node]', box).forEach((el) => {
    el.classList.toggle('selected', el.dataset.node === engState.selectedNode);
  });
}
function engNodeMouseDown(ev, node) {
  if (ev.button !== 0) return;
  const portEl = ev.target.closest('.eng-port-out');
  if (portEl) {
    ev.preventDefault();
    ev.stopPropagation();
    engState.link = { from: node.id, port: portEl.dataset.port || 'out', to: { x: node.x, y: node.y }, temp: true };
    return;
  }
  if (ev.target.closest('input,textarea,select,button')) return;
  ev.preventDefault();
  ev.stopPropagation();
  engState.selectedNode = node.id;
  engState.selectedEdge = null;
  // 单击只**选中** (高亮 + 可拖 + Delete 可删), 弹编辑框改成双击才开 —— 所以这里关掉 inspOpen。
  // 直接改 class 而不是整个重渲染: 见 engSyncNodeSelection 的注释。
  engState.inspOpen = false;
  engSyncNodeSelection();
  renderEngineInspector();
  engState.drag = {
    id: node.id,
    startX: ev.clientX,
    startY: ev.clientY,
    ox: node.x,
    oy: node.y
  };
}
function engBindCanvasEvents() {
  const wrap = eq1('#engineCanvas');
  if (!wrap || wrap.dataset.bound) return;
  wrap.dataset.bound = '1';
  wrap.addEventListener('mousedown', (ev) => {
    engToggleAddMenu(false);
    if (ev.button !== 0 || ev.target.closest('.eng-node') || ev.target.closest('[data-edge]')) return;
    engState.selectedNode = null;
    engState.selectedEdge = null;
    engState.inspOpen = false;
    engState.drag = { pan: true, startX: ev.clientX, startY: ev.clientY, ox: engState.pan.x, oy: engState.pan.y };
    renderEngineCanvas();
    renderEngineInspector();
  });
  window.addEventListener('mousemove', (ev) => {
    const d = engState.drag;
    if (d && d.pan) {
      engState.pan = { x: d.ox + (ev.clientX - d.startX), y: d.oy + (ev.clientY - d.startY) };
      const world = eq1('#engineWorld');
      if (world) world.style.transform = `translate(${engState.pan.x}px, ${engState.pan.y}px) scale(${engState.zoom})`;
      return;
    }
    if (d && d.id) {
      const node = engState.card && engState.card.nodes.find((n) => n.id === d.id);
      if (!node) return;
      const nx = Math.round(d.ox + (ev.clientX - d.startX) / engState.zoom);
      const ny = Math.round(d.oy + (ev.clientY - d.startY) / engState.zoom);
      if (nx !== node.x || ny !== node.y) d.moved = true;
      node.x = nx;
      node.y = ny;
      const el = eq1(`[data-node="${node.id}"]`);
      if (el) { el.style.left = node.x + 'px'; el.style.top = node.y + 'px'; }
      engRedrawEdges();
      return;
    }
    if (engState.link) {
      const pt = engToWorld(ev.clientX, ev.clientY);
      engState.link.to = pt;
      engDrawTempLink();
    }
  });
  window.addEventListener('mouseup', (ev) => {
    if (engState.link) {
      const targetEl = ev.target.closest && ev.target.closest('.eng-node');
      const targetId = targetEl && targetEl.dataset.node;
      if (targetId && targetId !== engState.link.from) engAddEdge(engState.link.from, targetId, engState.link.port);
      engState.link = null;
      renderEngineCanvas();
    }
    // 拖完节点要标改动。
    //
    // 以前这里什么都不做 —— 拖动只改 node.x / node.y, 而节点位置**是卡的内容**
    // (存盘时整张卡一起存)。于是摆好的布局既不会亮"未保存", 离开画板时也不会
    // 提示, 直接丢。只有恰好又改了别的东西再点保存, 位置才顺带被存下去。
    //
    // 只在真的移动过 (d.moved) 时才标: 单击选中一个节点也会走到这里,
    // 不判断的话点一下就把卡标成"有未保存的改动"。
    if (engState.drag && engState.drag.moved) engTouch();
    engState.drag = null;
  });
  wrap.addEventListener('wheel', (ev) => {
    if (!engState.card) return;
    ev.preventDefault();
    const step = ev.deltaY > 0 ? 0.9 : 1.1;
    const next = Math.min(1.8, Math.max(0.35, engState.zoom * step));
    // 以光标为锚点缩放, 否则放大后内容会跑出视野
    const rect = wrap.getBoundingClientRect();
    const cx = ev.clientX - rect.left;
    const cy = ev.clientY - rect.top;
    const k = next / engState.zoom;
    engState.pan = { x: cx - (cx - engState.pan.x) * k, y: cy - (cy - engState.pan.y) * k };
    engState.zoom = next;
    const world = eq1('#engineWorld');
    if (world) world.style.transform = `translate(${engState.pan.x}px, ${engState.pan.y}px) scale(${engState.zoom})`;
    engRedrawEdges();
  }, { passive: false });
  window.addEventListener('keydown', (ev) => {
    const view = eq1('.view[data-view="engines"]');
    if (!view || !view.classList.contains('active')) return;
    if (engState.view !== 'board') return;
    // Esc 先关最上面那层: 测试弹框 -> 配置弹框 -> 加节点菜单 -> 退出全屏
    // 这一段要放在"焦点在输入框就放行"之前, 否则在弹框输入框里按 Esc 没反应
    if (ev.key === 'Escape') {
      if (engTestModalOpen()) { ev.preventDefault(); closeEngTest(); return; }
      if (engCfgModalOpen()) { ev.preventDefault(); closeEngCfgModal(); return; }
      if (engState.addMenuOpen) { engToggleAddMenu(false); return; }
      if (engState.fullscreen) { ev.preventDefault(); engToggleFullscreen(false); return; }
    }
    if (eq1('#engineName') === document.activeElement) return;
    const inField = /INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || '');
    if (inField) return;
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      if (engState.selectedNode) { ev.preventDefault(); engRemoveNode(engState.selectedNode); }
      else if (engState.selectedEdge) { ev.preventDefault(); engRemoveEdge(engState.selectedEdge); }
    }
  });
}
function engToWorld(clientX, clientY) {
  const wrap = eq1('#engineCanvas');
  if (!wrap) return { x: 0, y: 0 };
  const rect = wrap.getBoundingClientRect();
  return {
    x: (clientX - rect.left - engState.pan.x) / engState.zoom,
    y: (clientY - rect.top - engState.pan.y) / engState.zoom
  };
}
function engDrawTempLink() {
  const svg = eq1('#engineEdges');
  const box = eq1('#engineNodes');
  if (!svg || !box || !engState.link) return;
  let el = eq1('#engTempEdge', svg);
  if (!el) {
    el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    el.setAttribute('id', 'engTempEdge');
    el.setAttribute('class', 'eng-edge eng-edge-temp');
    svg.appendChild(el);
  }
  const node = engState.card.nodes.find((n) => n.id === engState.link.from);
  if (!node) return;
  const a = engPortPos(box, node, engState.link.port);
  el.setAttribute('d', engBezier(a, engState.link.to));
}
function engRedrawEdges() {
  const svg = eq1('#engineEdges');
  const box = eq1('#engineNodes');
  if (!svg || !box || !engState.card) return;
  svg.innerHTML = engEdgesSvg(engState.card, box);
  eqAll('[data-edge]', svg).forEach((p) => {
    p.addEventListener('mousedown', (ev) => {
      ev.stopPropagation();
      engState.selectedEdge = { from: p.dataset.from, port: p.dataset.port };
      engState.selectedNode = null;
      engRedrawEdges();
      renderEngineInspector();
    });
  });
}
function engAddEdge(from, to, port) {
  const card = engState.card;
  if (!card || from === to) return;
  // 一个出口只能接一条线 —— 条件节点必须二选一, 不能两条都走
  card.edges = (card.edges || []).filter((e) => !(e.from === from && (e.port || 'out') === port));
  card.edges.push({ from, to, port: port || 'out' });
  engTouch();
  engValidate();
}
function engRemoveNode(id) {
  const card = engState.card;
  if (!card) return;
  const node = card.nodes.find((n) => n.id === id);
  if (!node) return;
  card.nodes = card.nodes.filter((n) => n.id !== id);
  card.edges = (card.edges || []).filter((e) => e.from !== id && e.to !== id);
  engState.selectedNode = null;
  engTouch();
  renderEngineCanvas();
  renderEngineInspector();
  engValidate();
}
function engRemoveEdge(sel) {
  const card = engState.card;
  if (!card) return;
  card.edges = (card.edges || []).filter((e) => !(e.from === sel.from && (e.port || 'out') === sel.port));
  engState.selectedEdge = null;
  engTouch();
  renderEngineCanvas();
  renderEngineInspector();
  engValidate();
}
function engAddNode(type) {
  const card = engState.card;
  if (!card) return;
  // 摆在当前视野中间, 别摆到看不见的地方
  const wrap = eq1('#engineCanvas');
  const w = wrap ? wrap.clientWidth : 800;
  const h = wrap ? wrap.clientHeight : 500;
  const x = Math.round((w / 2 - engState.pan.x) / engState.zoom) - ENG_NODE_W / 2;
  const y = Math.round((h / 2 - engState.pan.y) / engState.zoom) - 60;
  const node = { id: engId('n'), type, title: ENG_LABEL[type], x: x, y: y };
  if (type === 'input') node.fields = [{ key: 'input1', label: '输入项', required: true }];
  if (type === 'query') { node.databaseId = ''; node.table = ''; node.sql = ''; node.fields = []; node.outputs = []; }
  if (type === 'condition') node.expr = { type: 'group', logic: 'and', items: [] };
  if (type === 'output') node.template = '';
  card.nodes.push(node);
  engState.selectedNode = node.id;
  engState.selectedEdge = null;
  engState.inspOpen = true;   // 新加的节点直接把编辑框开出来 (方便接着配)
  engTouch();
  engToggleAddMenu(false);
  renderEngineCanvas();
  renderEngineInspector();
  engValidate();
}
/* ---- 加节点: 画板正下方悬浮按钮 ---- */
function engToggleAddMenu(open) {
  engState.addMenuOpen = open === undefined ? !engState.addMenuOpen : !!open;
  const menu = eq1('#engAddMenu');
  const fab = eq1('#btnAddNodeFab');
  if (menu) menu.hidden = !engState.addMenuOpen;
  if (fab) fab.classList.toggle('open', engState.addMenuOpen);
}
function engBindFab() {
  const fab = eq1('#btnAddNodeFab');
  const wrap = eq1('.eng-fab-wrap');
  if (fab && !fab.dataset.bound) {
    fab.dataset.bound = '1';
    // 点按钮只开关菜单, 别让画布把它当成"点空白"而收掉
    fab.addEventListener('mousedown', (ev) => ev.stopPropagation());
    fab.addEventListener('click', (ev) => { ev.stopPropagation(); engToggleAddMenu(); });
  }
  if (wrap && !wrap.dataset.bound) {
    wrap.dataset.bound = '1';
    wrap.addEventListener('mousedown', (ev) => ev.stopPropagation());
  }
  eqAll('#engAddMenu [data-add]').forEach((b) => {
    if (b.dataset.bound) return;
    b.dataset.bound = '1';
    b.addEventListener('click', () => engAddNode(b.dataset.add));
  });
}
/* ==================== AI 侧边栏 (外壳) ==================== */
/* 输入框高度可拖拽 (CSS 里 resize: vertical), 并把拖过的高度记住 ——
   面板只有 3 成宽, 默认三行写长需求时看不见上面正在编辑的内容。
   textarea 没有 resize 事件, 只能靠 ResizeObserver 观察尺寸变化。 */
const ENG_AI_H_KEY = 'solodb.engAiInputH';
const ENG_AI_H_MIN = 62;
function engAiApplyInputHeight() {
  const ta = eq1('#engAiInput');
  if (!ta) return;
  const saved = Number(localStorage.getItem(ENG_AI_H_KEY));
  if (Number.isFinite(saved) && saved >= ENG_AI_H_MIN) ta.style.height = saved + 'px';
  if (ta._hRo) return; // 只挂一次
  let timer = 0;
  const ro = new ResizeObserver(() => {
    clearTimeout(timer);
    // 防抖: 拖拽过程中会连续触发, 等手停下来再写
    timer = setTimeout(() => {
      const h = Math.round(ta.offsetHeight);
      // 面板收起时高度是 0, 别把 0 存进去覆盖掉用户的设置
      if (h >= ENG_AI_H_MIN) { try { localStorage.setItem(ENG_AI_H_KEY, String(h)); } catch (e) {} }
    }, 300);
  });
  ro.observe(ta);
  ta._hRo = ro;
}
/** 打开/收起 AI 侧边栏。打开时画板让出右边, 两者并排 (画板:侧边栏 = 7:3)。 */
function engAiTogglePanel(open) {
  engState.aiOpen = open === undefined ? !engState.aiOpen : !!open;
  const panel = eq1('#engAiPanel');
  const fab = eq1('#btnAiFab');
  if (panel) panel.hidden = !engState.aiOpen;
  if (fab) fab.classList.toggle('on', engState.aiOpen);
  if (engState.aiOpen) {
    engAiRenderLog();
    // 按当前页签把内容区摆对 (规划/历史也要按需渲染一次)
    engAiSetTab(engState.aiTab);
    engAiApplyInputHeight();
    // 开面板时按真实状态重算一次输入框。面板可能在"上一张卡的请求还在飞"
    // 的时候被打开 —— 不重算的话用户看到的是一个灰掉的输入框, 只能干等。
    engAiSyncComposer();
  }
  // 画板宽度变了, 连线要重画一遍
  requestAnimationFrame(() => { renderEngineCanvas(); });
}
/**
 * 切 AI 面板的页签 (对话 / 规划 / 历史)。
 *
 * 三个页签**各占满内容区**: 显示目标 view、隐藏其余两个, 并刷新那条 tab。
 * 取代了以前"规划/历史从顶部滑出盖住对话、还互相排斥"的做法。
 */
function engAiSetTab(tab) {
  const t = (tab === 'plan' || tab === 'history') ? tab : 'chat';
  engState.aiTab = t;
  const views = { chat: eq1('#engAiViewChat'), plan: eq1('#engAiViewPlan'), history: eq1('#engAiViewHistory') };
  for (const k of Object.keys(views)) if (views[k]) views[k].hidden = (k !== t);
  eqAll('#engAiTabs .eng-ai-tab').forEach((b) => b.classList.toggle('on', b.dataset.aitab === t));
  if (t === 'plan') engAiRenderPlan();
  else if (t === 'history') engAiRenderHistory();
  else { engAiRenderScope(); engAiApplyInputHeight(); }
}
/**
 * 历史对话列表。
 *
 * 只列**这张卡**聊过的 —— 侧边栏的历史是"这张卡聊过什么", 不是全局对话列表。
 * 换卡之后列表自然跟着换 (engAiRestoreForCard 会重新拉一次)。
 */
function engAiRenderHistory() {
  const box = eq1('#engAiHistory');
  if (!box) return;
  // 显隐交给页签 (engAiSetTab)。这里只在"当前就是历史页"时填内容。
  if (engState.aiTab !== 'history') return;
  const list = engState.aiChats || [];
  const head = '<div class="eng-ai-hist-head">这张卡的对话记录'
    + '<button class="eng-ai-hist-new" id="btnAiNewChat">+ 新建</button></div>';
  if (!list.length) {
    box.innerHTML = head + '<div class="eng-ai-hist-empty">还没有记录。发第一句话就会记下来。</div>';
    engBindHistoryButtons(box);
    return;
  }
  box.innerHTML = head + list.map((c) => {
    const on = c.id === engState.aiChatId ? ' on' : '';
    const bits = [engFmtTime(c.updatedAt || c.createdAt)];
    if (c.messageCount) bits.push(c.messageCount + ' 条');
    if (c.finished) bits.push('已搭完');
    return `<div class="eng-ai-hist-item${on}" data-chat="${engEsc(c.id)}">
      <div class="eng-ai-hist-main">
        <div class="eng-ai-hist-title" title="${engEsc(c.title)}">${engEsc(c.title)}</div>
        <div class="eng-ai-hist-meta">${bits.map(engEsc).join(' · ')}</div>
      </div>
      <div class="eng-ai-hist-acts">
        <button class="eng-ai-hist-mini" data-hact="rename" title="重命名">${icon('pencil')}</button>
        <button class="eng-ai-hist-mini eng-ai-hist-del" data-hact="del" title="删除">${icon('trash')}</button>
      </div>
    </div>`;
  }).join('');
  engBindHistoryButtons(box);
}
/** 时间显示: 今天只给时分, 今年只给月日, 更早给年月日 */
function engFmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function engBindHistoryButtons(box) {
  const newBtn = eq1('#btnAiNewChat', box);
  if (newBtn) newBtn.addEventListener('click', () => engAiNewChat());
  eqAll('[data-chat]', box).forEach((el) => {
    const id = el.dataset.chat;
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-hact]')) return;
      engAiOpenChat(id).then(() => { engAiRenderHistory(); });
    });
    const rn = eq1('[data-hact="rename"]', el);
    if (rn) rn.addEventListener('click', () => engAiRenameChat(id, el));
    const dl = eq1('[data-hact="del"]', el);
    if (dl) dl.addEventListener('click', () => engAiDeleteChat(id));
  });
}
/**
 * 重命名。用 inline 输入框而不是 window.prompt —— Electron 里 prompt 不支持, 会直接抛错。
 */
function engAiRenameChat(id, itemEl) {
  const cur = (engState.aiChats || []).find((c) => c.id === id);
  const titleEl = eq1('.eng-ai-hist-title', itemEl);
  if (!titleEl || itemEl.dataset.editing) return;
  itemEl.dataset.editing = '1';
  const old = (cur && cur.title) || '';
  titleEl.innerHTML = `<input type="text" class="eng-ai-hist-input" value="${engEsc(old)}" />`;
  const input = eq1('.eng-ai-hist-input', titleEl);
  if (!input) return;
  input.focus();
  input.select();
  let done = false;
  const commit = async (save) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (save && v && v !== old) {
      try { await window.bridge.engine.aiChatRename({ id, title: v }); } catch (e) {}
      await engAiRefreshChats();
    } else {
      engAiRenderHistory();
    }
  };
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); commit(true); }
    if (ev.key === 'Escape') { ev.preventDefault(); commit(false); }
  });
  input.addEventListener('blur', () => commit(true));
}
async function engAiDeleteChat(id) {
  if (!(await askConfirm({
    title: '删除这条对话记录?',
    message: '删掉这条对话记录? 流程卡不受影响。',
    detail: '只是这张卡跟 AI 聊过的流水记录, 卡本身的节点和配置都还在。',
    okText: '删除记录',
    tone: 'danger'
  }))) return;
  try { await window.bridge.engine.aiChatDelete({ id }); } catch (e) {}
  // 删的正是当前这条: 清空面板, 但不动画板
  if (engState.aiChatId === id) {
    engState.aiSessionId = null;
    engState.aiChatId = null;
    engState.aiLog = [];
    engAiRenderLog();
  }
  await engAiRefreshChats();
}
function engAiPoolSummary() {
  const pool = engAiScopeForSend();
  const parts = [];
  for (const dbId of Object.keys(pool)) {
    const t = pool[dbId] || [];
    if (!t.length) continue;
    const db = engDatabases().find((d) => d.id === dbId);
    parts.push(`${db ? (db.name || db.id) : dbId}（${t.length} 张）`);
  }
  return parts.join('，');
}
/**
 * 侧边栏顶部那行: AI 当前能看哪些表。
 *
 * 措辞刻意写成"AI 可用"而不是"本流程可用" —— 这个范围**只约束 AI 搭建**
 * (模型碰范围外的表会被拒), 手动配的取数节点、保存校验、运行期都不看它。
 * 写成"本流程可用"会让人以为圈了范围就安全, 实际上手动拖一个节点就能绕过去。
 *
 * 展示形式: 一个库一片小圆片, 片上是张数, 末尾给个总数。
 * 原来是一行逗号连起来的文字, 库一多就糊成一片、也数不清到底几张。
 */
function engAiRenderScope() {
  const box = eq1('#engAiScope');
  if (!box) return;
  const pool = engAiScopeForSend();
  const items = [];
  for (const dbId of Object.keys(pool)) {
    const t = pool[dbId] || [];
    if (!t.length) continue;
    const db = engDatabases().find((d) => d.id === dbId);
    items.push({ name: db ? (db.name || db.id) : dbId, n: t.length, tables: t });
  }
  if (!items.length) {
    box.className = 'eng-ai-scope none';
    box.innerHTML = '还没配范围。<b>点右上角「配置」</b>选 AI 能用哪些表。';
    return;
  }
  const total = items.reduce((a, x) => a + x.n, 0);
  box.className = 'eng-ai-scope';
  // 悬停能看到这个库里具体是哪几张表 —— 片子上只放得下库名和张数
  box.innerHTML =
    '<span class="eng-ai-scope-label">AI 可用</span>' +
    items.map((x) =>
      `<span class="eng-ai-scope-chip" title="${engEsc(x.name + '：' + x.tables.join('、'))}">` +
      `<span class="eng-ai-scope-name">${engEsc(x.name)}</span><b>${x.n}</b></span>`
    ).join('') +
    `<span class="eng-ai-scope-total">共 ${total} 张</span>`;
}

/* ==================== 规划面板 ====================
 * 让用户不用翻对话就能看到: AI 打算怎么搭、搭到哪一步了、它改过规划没有。
 *
 * 数据来源刻意选成**对话记录里那张规划卡**, 而不是另存一份状态:
 *   - 对话记录本身会被保存和恢复 (见 engAiOpenChat 里 engState.aiLog = r.chat.log),
 *     所以重开面板、切历史对话、重启应用之后, 规划都还在, 不用额外做持久化;
 *   - 也就不存在"面板上显示的规划"和"对话里那张卡"对不上的可能。
 * 代价是必须保证两者同步 —— 所以同步点统一放在 engAiRenderLog() 的末尾。
 */
function engAiPlanOf() {
  const log = engState.aiLog || [];
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i] && log[i].role === 'plan' && log[i].plan) return log[i].plan;
  }
  return null;
}
/** 按钮上的进度: 有规划就写「规划 5/12」, 没规划就是「规划」 */
function engAiSyncPlanBtn() {
  const btn = eq1('#engAiTabs [data-aitab="plan"]');
  if (!btn) return;
  const p = engAiPlanOf();
  const steps = (p && p.steps) || [];
  if (!steps.length) {
    btn.textContent = '规划';
    btn.classList.remove('has');
    btn.title = '看 AI 打算怎么搭、搭到哪一步了';
    return;
  }
  const done = steps.filter((s) => s.status === 'done').length;
  btn.textContent = '规划 ' + done + '/' + steps.length;
  btn.classList.add('has');
  btn.title = `规划 ${steps.length} 步, 已完成 ${done} 步` + (p.revision > 1 ? `（第 ${p.revision} 版）` : '');
}
function engAiRenderPlan() {
  const box = eq1('#engAiPlan');
  if (!box) return;
  // 显隐交给页签。这里只在"当前就是规划页"时填内容。
  if (engState.aiTab !== 'plan') return;
  const p = engAiPlanOf();
  const steps = (p && p.steps) || [];
  if (!steps.length) {
    box.innerHTML = '<div class="eng-aip-empty">AI 还没出规划。<br>' +
      '从零搭一张卡时，它会先查清表结构、再列一份「分几步、每步建什么、最后输出哪几个结论」，' +
      '然后才动手建。<br><br>规划出来之后这里会自动更新。</div>';
    return;
  }
  const done = steps.filter((s) => s.status === 'done').length;
  const pct = Math.round(100 * done / steps.length);
  const stepHtml = steps.map((s) => {
    const on = s.status === 'done';
    return `<li class="eng-aip-step${on ? ' done' : ''}">` +
      `<span class="eng-aip-tick">${on ? '✓' : '○'}</span>` +
      `<span class="eng-aip-step-body">` +
      `<span class="eng-aip-title">${engEsc(s.title)}</span>` +
      (s.detail ? `<span class="eng-aip-detail">${engEsc(s.detail)}</span>` : '') +
      (s.note ? `<span class="eng-aip-note">实际: ${engEsc(s.note)}</span>` : '') +
      `</span></li>`;
  }).join('');
  const branches = (p.branches || []).length
    ? `<div class="eng-aip-sec"><div class="eng-aip-sec-head">会输出这几个结论</div>` +
      `<ul class="eng-aip-branches">${p.branches.map((b) => `<li>${engEsc(b)}</li>`).join('')}</ul></div>`
    : '';
  const unknowns = (p.unknowns || []).length
    ? `<div class="eng-aip-sec"><div class="eng-aip-sec-head">还没确认</div>` +
      `<ul class="eng-aip-unknowns">${p.unknowns.map((u) => `<li>${engEsc(u)}</li>`).join('')}</ul></div>`
    : '';
  box.innerHTML =
    `<div class="eng-aip-head">规划<span class="eng-aip-count">${done}/${steps.length} 步</span>` +
    (p.revision > 1 ? `<span class="eng-aip-rev">第 ${p.revision} 版</span>` : '') + `</div>` +
    `<div class="eng-aip-bar"><span style="width:${pct}%"></span></div>` +
    `<ol class="eng-aip-steps">${stepHtml}</ol>` +
    branches + unknowns;
}
function engAiRenderLog() {
  const box = eq1('#engAiLog');
  if (!box) return;
  const log = engState.aiLog || [];
  if (!log.length) {
    box.innerHTML = `<div class="eng-ai-empty">
      用大白话说清这张卡要怎么判断，我来搭。<br><br>
      这张卡已经有东西了也没关系 —— 我只在你现有的节点上改，不会推倒重来。改完会自己跑一遍确认能出结论。
    </div>`;
    return;
  }
  box.innerHTML = log.map((m, i) => {
    if (m.role === 'act') {
      return `<div class="eng-ai-act${m.err ? ' err' : ''}"><span class="eng-ai-act-dot"></span><span>${engEsc(m.text)}</span></div>`;
    }
    if (m.role === 'choice') return engRenderChoiceCard(m, i);
    if (m.role === 'plan') return engRenderPlanCard(m);
    // 正在逐字显示的那一条: 先渲染成空的, 由 engAiTypeIn 往里填。
    // 不这么判的话, 打字期间任何一次重画 (别的消息进来、面板重绘) 都会把
    // 全文一次性糊上去 —— 表现就是"打到一半突然跳完"。
    const pending = m.role !== 'user' && m.revealed === false;
    return `<div class="eng-ai-msg ${m.role === 'user' ? 'user' : 'ai'}">${pending ? '' : engEsc(m.text)}</div>`;
  }).join('') + (engState.aiChatBusy ? '<div class="eng-ai-act thinking"><span class="eng-ai-act-dot"></span><span>正在想…</span></div>' : '');
  engBindChoiceCards(box);
  box.scrollTop = box.scrollHeight;
  // 规划面板和「规划」按钮的进度都从这份记录里读, 所以同步点放这里 ——
  // 一处管住全部入口 (新事件、切历史对话、恢复会话、新建对话)。
  engAiSyncPlanBtn();
  engAiRenderPlan();
}
/**
 * 一个选择题卡片: 问题 + 一排可点的选项 (+ 想自己填时的输入框)。
 *
 * 用户在页面上点选而不是在对话框里打长句 —— 这是产品经理要的答法。
 * 选中后把答案当一条普通用户消息发回去, 对模型来说和用户手打没有区别。
 */
function engRenderChoiceCard(m, idx) {
  const c = m.choice || {};
  const answered = !!m.answered;
  const picked = m.picked || [];
  const opts = (c.options || []).map((o) => {
    const on = picked.includes(o.value);
    return `<button class="eng-choice-opt${on ? ' on' : ''}" data-choice-opt="${engEsc(o.value)}"${answered ? ' disabled' : ''}>
      <span class="eng-choice-opt-label">${engEsc(o.label)}</span>
      ${o.desc ? `<span class="eng-choice-opt-desc">${engEsc(o.desc)}</span>` : ''}
    </button>`;
  }).join('');
  const textRow = c.allowText !== false && !answered
    ? `<div class="eng-choice-text">
         <input type="text" class="eng-choice-input" placeholder="${engEsc(c.placeholder || '也可以自己填一个…')}" />
       </div>`
    : '';
  const submit = answered
    ? `<div class="eng-choice-done">已答：${engEsc((m.answerText || '').trim() || '（空）')}</div>`
    : `<div class="eng-choice-foot">
         <button class="btn btn-primary btn-sm" data-choice-submit>确认</button>
         ${c.multi ? '<span class="eng-choice-hint">可以多选</span>' : ''}
       </div>`;
  return `<div class="eng-choice" data-choice-idx="${idx}" data-multi="${c.multi ? '1' : ''}">
    <div class="eng-choice-q">${engEsc(c.question || m.text || '')}</div>
    ${c.why ? `<div class="eng-choice-why">${engEsc(c.why)}</div>` : ''}
    <div class="eng-choice-opts">${opts}</div>
    ${textRow}
    ${submit}
  </div>`;
}
/** 给日志里的每张选择题卡片挂上交互 */
function engBindChoiceCards(box) {
  eqAll('[data-choice-idx]', box).forEach((card) => {
    const idx = Number(card.dataset.choiceIdx);
    const multi = card.dataset.multi === '1';
    const optBtns = eqAll('[data-choice-opt]', card);
    const input = eq1('.eng-choice-input', card);
    const submit = eq1('[data-choice-submit]', card);
    optBtns.forEach((b) => b.addEventListener('click', () => {
      if (multi) {
        b.classList.toggle('on');
      } else {
        optBtns.forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
      }
      if (input) input.value = '';
    }));
    if (input) input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); if (submit) submit.click(); }
    });
    if (submit) submit.addEventListener('click', () => {
      const picked = optBtns.filter((b) => b.classList.contains('on')).map((b) => b.dataset.choiceOpt);
      const typed = input ? input.value.trim() : '';
      if (!picked.length && !typed) { engToast('先点一个选项，或者自己填一个', 'err'); return; }
      engAnswerChoice(idx, picked, typed);
    });
  });
}
/**
 * 用户答完一张选择题: 记下来, 然后把答案发回给 AI 继续。
 *
 * 这里**不要**自己再 engAiPush 那句话。engAiSendText 内部已经会推 (输入框和
 * 选择题两条路要走同一个出口), 以前两边各推一次, 于是同一个回答在面板里
 * 出现两遍 —— 用户看到的就是"我明明只答了一次, 怎么显示发了两条"。
 *
 * 但发送**是可能被拒的** (上一条还在处理 / 画板上没有卡 / 没配可访问的表),
 * 那时它不会推。所以要按返回值决定补不补 —— 补了才是"一定看得见且只出现一次"。
 */
async function engAnswerChoice(idx, picked, typed) {
  const m = (engState.aiLog || [])[idx];
  if (!m || m.answered) return;
  const c = m.choice || {};
  const labelOf = (v) => {
    const o = (c.options || []).find((x) => x.value === v);
    return o ? o.label : v;
  };
  const parts = picked.map(labelOf);
  if (typed) parts.push(typed);
  const answerText = parts.join('、');
  m.answered = true;
  m.picked = picked;
  m.answerText = answerText;
  engAiRenderLog();
  // 答完接着往下搭 (把答案当下一轮输入)。这句话由它负责推进日志。
  const sent = await engAiSendText(answerText);
  // 没发出去才补记 —— 否则用户答过的话在面板里就凭空消失了
  if (!sent) engAiPush('user', answerText);
}
/**
 * 规划卡片 —— 相当于开发前的 PRD, 让用户先看一眼"它打算怎么搭"。
 *
 * 为什么值得单独做一张卡 (而不是当成一行普通文字):
 *   规划阶段的价值就在于**用户能在这时候发现"它理解错了"** —— 那时候改一句话
 *   就够了; 等它把卡搭完再发现, 就要推倒重来。所以三件事必须一眼看得到:
 *   分几步、每步干什么、最终输出哪几个结论。尤其是结论 —— 结论错了就是方向错了。
 *
 * 步骤上带勾: 用户能看着它一步步做掉, 而不是面对一个"正在想…"干等。
 */
function engRenderPlanCard(m) {
  const p = m.plan || {};
  const steps = (p.steps || []).map((s) => {
    const done = s.status === 'done';
    return `<li class="eng-plan-step${done ? ' done' : ''}">
      <span class="eng-plan-tick">${done ? '✓' : '○'}</span>
      <span class="eng-plan-step-body">
        <span class="eng-plan-step-title">${engEsc(s.title)}</span>
        ${s.detail ? `<span class="eng-plan-step-detail">${engEsc(s.detail)}</span>` : ''}
      </span>
    </li>`;
  }).join('');
  const branches = (p.branches || []).length
    ? `<div class="eng-plan-sec">
        <div class="eng-plan-sec-head">会输出这几个结论</div>
        <ul class="eng-plan-branches">${p.branches.map((b) => `<li>${engEsc(b)}</li>`).join('')}</ul>
      </div>`
    : '';
  const unknowns = (p.unknowns || []).length
    ? `<div class="eng-plan-sec">
        <div class="eng-plan-sec-head">还没确认</div>
        <ul class="eng-plan-unknowns">${p.unknowns.map((u) => `<li>${engEsc(u)}</li>`).join('')}</ul>
      </div>`
    : '';
  const rev = p.revision > 1 ? `<span class="eng-plan-rev">第 ${p.revision} 版</span>` : '';
  return `<div class="eng-plan">
    <div class="eng-plan-head">规划 · 打算这么搭 ${rev}</div>
    <ol class="eng-plan-steps">${steps}</ol>
    ${branches}
    ${unknowns}
    <div class="eng-plan-foot">认可就让它接着搭；哪里理解错了，直接说，它会改规划再动手。</div>
  </div>`;
}

function engAiPush(role, text, opts) {
  // 用户新说了一句 = 新一轮, 上一轮可能还挂着的流式条目要断开, 别把新内容续到它后面
  if (role === 'user') engState.aiStream = null;
  engState.aiLog = engState.aiLog || [];
  const item = Object.assign({ role, text }, opts || {});
  engState.aiLog.push(item);
  engAiRenderLog();
  // 模型的话**逐字显示**出来。
  //
  // 为什么: 模型一次往返要 10~20 秒, 那段时间界面上只有一行"正在想…"。
  // 一句 200 字的回答瞬间整段蹦出来, 用户的感受是"卡了很久然后突然有东西",
  // 而人读 200 字本来就要好几秒 —— 把这几秒花在显示上, 总耗时没变,
  // 但"卡死了"变成了"它在说话"。
  //
  // 只对模型说的话做 (role==='ai'): 动作行 (act) 是系统播报, 应该干脆利落;
  // 用户自己打的话当然也不能再打一遍。
  if (role === 'ai' && String(text || '').trim()) engAiTypeIn(item);
}
/**
 * 把一条消息的正文一段段显示出来。
 *
 * 直接改那一条的 DOM, **不重画整个列表** —— engAiRenderLog 每次都是全量重建,
 * 打字期间每秒调几十次会白烧 CPU, 而且会不停重置滚动位置。
 *
 * 时长封顶: 长回答按固定速度打会拖很久 (500 字要 5 秒), 那反而更慢。
 * 所以总时长控制在 0.8~1.6 秒之间, 长文本打得更快。
 */
function engAiTypeIn(item) {
  const box = eq1('#engAiLog');
  if (!box) { item.revealed = true; return; }
  // 先把上一条还在打的动画收掉。
  // 必须做: 新消息进来会触发 engAiRenderLog 全量重建, 正在打字的那个 DOM
  // 节点已经不在文档里了 —— 老动画还在对着一个游离节点写 textContent,
  // 而新那条因为 revealed===false 渲染成空的, 表现就是"回答永远不出现"。
  engAiTypeCancel();
  const nodes = eqAll('.eng-ai-msg.ai', box);
  const el = nodes[nodes.length - 1];
  if (!el) { item.revealed = true; return; }
  const full = String(item.text || '');
  const total = full.length;
  if (total < 2) { item.revealed = true; return; }

  // 打字期间别让"正在想…"也挂在下面, 两个指示器同时转看着像卡住
  const thinking = eq1('.eng-ai-act.thinking', box);
  if (thinking) thinking.style.display = 'none';

  const dur = Math.min(1600, Math.max(800, total * 12));
  const t0 = performance.now();
  item.revealed = false;
  const step = () => {
    const p = Math.min(1, (performance.now() - t0) / dur);
    const n = Math.max(1, Math.floor(total * p));
    el.textContent = full.slice(0, n);
    if (n < total) {
      engState.aiTypeRaf = requestAnimationFrame(step);
      box.scrollTop = box.scrollHeight;
    } else {
      el.textContent = full;
      item.revealed = true;
      engState.aiTypeRaf = 0;
      if (thinking) thinking.style.display = '';
      box.scrollTop = box.scrollHeight;
    }
  };
  // 先清空再开始, 否则会先闪一下全文再从头打
  el.textContent = '';
  engState.aiTypeRaf = requestAnimationFrame(step);
}
/** 收掉正在跑的逐字动画, 并把那条消息标成已显示完 (内容是全的, 不能留在半截) */
function engAiTypeCancel() {
  if (!engState.aiTypeRaf) return;
  cancelAnimationFrame(engState.aiTypeRaf);
  engState.aiTypeRaf = 0;
  const log = engState.aiLog || [];
  for (const m of log) if (m && m.revealed === false) m.revealed = true;
}

/**
 * 流式正文: 模型边说边显示。
 *
 * 和分析 Agent 那条路一样, 用**真实的 SSE 增量**, 而不是 engAiTypeIn 那种
 * "整段拿到再假装逐字打" (那个总时长没变, 只是把等待挪到了显示上)。
 * 这里字是真的边生成边到 —— 慢的那十几秒里屏幕上一直在长字。
 */
function engAiDelta(text) {
  const box = eq1('#engAiLog');
  // 真流式和打字机不能并存: 打字机在往一个旧节点写 textContent, 会打架
  engAiTypeCancel();
  let item = engState.aiStream;
  if (!item || item.done) {
    item = { role: 'ai', text: '', revealed: true, streaming: true, done: false };
    engState.aiStream = item;
    engState.aiLog = engState.aiLog || [];
    engState.aiLog.push(item);
    engAiRenderLog();   // 先把这一条的 DOM 建出来
  }
  item.text += String(text || '');
  const nodes = box ? eqAll('.eng-ai-msg.ai', box) : [];
  const el = nodes[nodes.length - 1];
  if (el) {
    el.textContent = item.text;   // 只改这一条, 高频事件不整表重渲染 (会抖滚动)
    box.scrollTop = box.scrollHeight;
  }
  // 流式期间别让"正在想…"也挂在下面 —— 字正在长, 两个指示器同时转看着像卡住
  const thinking = box ? eq1('.eng-ai-act.thinking', box) : null;
  if (thinking) thinking.style.display = 'none';
}

/**
 * 收编当前正在流式的正文 —— 标记完成并摘掉。
 * 返回它流出来的文本 (没有就返回 null), 让调用方判断"接下来那条 ai_say 是不是同一段"。
 */
function engAiCommitStream() {
  const s = engState.aiStream;
  engState.aiStream = null;
  if (!s) return null;
  s.streaming = false;
  s.done = true;
  return s.text;
}
function engAiPushChoice(question, choice) {
  engState.aiLog = engState.aiLog || [];
  engState.aiLog.push({ role: 'choice', text: question, choice, answered: false, picked: [] });
  engAiRenderLog();
}
/** 只画范围清单本身, 不动事件绑定 —— 同步之后要能原地重画一遍 */
function engRenderAiScopeList() {
  const list = eq1('#aiScopeList');
  if (!list) return;
  const dbs = engDatabases();
  const pool = engState.aiPool || {};
  if (!dbs.length) {
    list.innerHTML = '<div class="eng-ai-scope-empty">还没有配置数据库。先去「数据库」页添加，再回来配范围。</div>';
    return;
  }
  list.innerHTML = dbs.map((d) => {
    // 只列出用户在「数据库」页勾选维护过的表; 没勾的这里不给选
    const tables = engDbMaintainedTables(d);
    const chosen = new Set(pool[d.id] || []);
    const head = `<div class="eng-ai-scope-dbhead">
        <span>${engEsc(d.name || d.id)}</span>
        <span class="muted">${engEsc(d.type || '')}</span>
      </div>`;
    const body = tables.length
      ? `<div class="eng-ai-scope-tables">${tables.map((t) => `<label class="eng-ai-scope-tbl${chosen.has(t) ? ' on' : ''}" data-db="${engEsc(d.id)}" data-tbl="${engEsc(t)}"><input type="checkbox" ${chosen.has(t) ? 'checked' : ''} /> ${engEsc(t)}</label>`).join('')}</div>`
      : `<div class="eng-ai-scope-tables"><span class="eng-ai-scope-empty">这个库还没有维护过的表。去「数据库」页勾上要用的表，再回来选。</span></div>`;
    return `<div class="eng-ai-scope-db">${head}${body}</div>`;
  }).join('');
  // 勾选只切样式, 不重建面板 —— 重建会打断连续勾选
  eqAll('.eng-ai-scope-tbl', list).forEach((el) => {
    el.addEventListener('change', () => {
      const cb = eq1('input[type="checkbox"]', el);
      el.classList.toggle('on', !!(cb && cb.checked));
    });
  });
}
/**
 * 范围弹框里的「同步」: 重新读配置 -> 重画清单。
 * 勾选状态挂在 engState.aiPool 上, 重画时会照旧勾回来;
 * 但如果某个库/表在「数据库」页被删掉或取消了勾选, 它就真的消失了 —— 这正是要的效果。
 */
async function engAiScopeSync() {
  const btn = eq1('#btnAiScopeSync');
  if (engState.cfgSyncBusy) return;
  engState.cfgSyncBusy = true;
  const old = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '同步中…'; }
  try {
    const r = await engSyncConfig();
    engRenderAiScopeList();
    // 配置变了的话, 取数节点那边的库表下拉也得跟着换新的
    if (r.changed) renderEngineInspector();
    engToast(r.changed
      ? `已同步 · ${r.dbs} 个库 / ${r.tables} 张表`
      : `已是最新 · ${r.dbs} 个库 / ${r.tables} 张表`, 'ok');
  } catch (e) {
    engToast('同步失败: ' + (e && e.message || e), 'err');
  } finally {
    engState.cfgSyncBusy = false;
    if (btn) { btn.disabled = false; btn.textContent = old || '同步'; }
  }
}
/**
 * 流程引擎页头部的「同步库表配置」。
 * 场景: 先建了流程卡, 后去「数据库」页加库勾表 —— 回来时这一页还拿着旧配置,
 * 新加的库表在配置弹框和取数节点里都看不见。点一下把它拉过来。
 */
async function engSyncConfigClick(btn) {
  if (engState.cfgSyncBusy) return;
  engState.cfgSyncBusy = true;
  const old = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '同步中…'; }
  try {
    const r = await engSyncConfig();
    // 卡片墙上的表名标签、取数节点的库表下拉, 都是照这份配置画的
    renderEngineGallery();
    renderEngineInspector();
    engToast(r.changed
      ? `已同步 · ${r.dbs} 个库 / ${r.tables} 张表`
      : `已是最新 · ${r.dbs} 个库 / ${r.tables} 张表`, 'ok');
  } catch (e) {
    engToast('同步失败: ' + (e && e.message || e), 'err');
  } finally {
    engState.cfgSyncBusy = false;
    if (btn) { btn.disabled = false; btn.textContent = old || '同步库表配置'; }
  }
}
/** 「配置」弹框: 勾出 AI 能用哪些库和表 (只列数据库页维护过的) */
function engOpenAiScope() {
  const list = eq1('#aiScopeList');
  const modal = eq1('#modalAiScope');
  if (!list || !modal) return;
  engRenderAiScopeList();
  const close = () => { modal.hidden = true; };
  eqAll('#modalAiScope [data-close]').forEach((el) => {
    if (el.dataset.bound) return;
    el.dataset.bound = '1';
    el.addEventListener('click', close);
  });
  const sync = eq1('#btnAiScopeSync');
  if (sync && !sync.dataset.bound) {
    sync.dataset.bound = '1';
    sync.addEventListener('click', engAiScopeSync);
  }
  const save = eq1('#btnAiScopeSave');
  if (save && !save.dataset.bound) {
    save.dataset.bound = '1';
    save.addEventListener('click', () => {
      const next = {};
      eqAll('.eng-ai-scope-tbl', list).forEach((el) => {
        const cb = eq1('input[type="checkbox"]', el);
        if (!cb || !cb.checked) return;
        const db = el.dataset.db;
        (next[db] = next[db] || []).push(el.dataset.tbl);
      });
      engState.aiPool = next;
      // 范围是这张卡的内容, 跟改节点一样要落盘 —— 写回卡上并标改动,
      // 自动保存会把它存下去
      engCardScopeWriteBack();
      engTouch();
      close();
      engAiRenderScope();
      engToast('范围已改', 'ok');
    });
  }
  modal.hidden = false;
}
/**
 * AI 面板宽度: 拖左边缘那根把手来改。
 *
 * 为什么做成拖拽而不是一个"展开/收起"按钮:
 *   面板宽度该多宽取决于当下在干什么 —— 看规划时想让画板大点, 改 SQL 时想让自己
 *   大点, 这两个需求没法用两档表达。拖拽是连续的, 用户自己找那个合适的宽度。
 *
 * 宽度的记法: 给面板一个**固定的 flex-basis (px)**, 而不是改 flex-grow 比例。
 *   比例写法 (原来试过的 7:13) 会随窗口宽度漂移 —— 窗口一变宽, 面板跟着变宽,
 *   用户拖好的宽度就白拖了。写死 px 才能"拖到哪就是哪"。
 *   画板那一侧不用动: 它是 flex:7 1 0, 面板不参与 grow 之后, 剩下的宽度全归画板。
 *
 * 上下限:
 *   下限定在 280 (跟 CSS 的 min-width 一致), 再窄对话就没法看了;
 *   上限按**容器当前宽度减 360** 现算 —— 保证画板至少还剩 360px,
 *   否则一拖到底画板就没了, 用户会以为卡被删了。
 */
const ENG_AI_W_KEY = 'solodb.engAiPanelW';
const ENG_AI_W_MIN = 280;
const ENG_AI_CANVAS_MIN = 360;

function engAiApplyPanelWidth(px) {
  const panel = eq1('#engAiPanel');
  if (!panel) return 0;
  const host = panel.parentElement;
  const avail = host ? host.offsetWidth : 0;
  // 容器还没量出来时 (面板隐藏中) 不设上限, 免得把宽度压成一个假的极小值
  const max = avail ? Math.max(ENG_AI_W_MIN, avail - ENG_AI_CANVAS_MIN) : 9999;
  const w = Math.max(ENG_AI_W_MIN, Math.min(max, Math.round(px)));
  panel.style.flex = '0 0 ' + w + 'px';
  return w;
}
function engAiRestorePanelWidth() {
  let saved = 0;
  try { saved = Number(localStorage.getItem(ENG_AI_W_KEY)); } catch (e) {}
  if (Number.isFinite(saved) && saved >= ENG_AI_W_MIN) engAiApplyPanelWidth(saved);
}
function engBindAiGutter() {
  const grip = eq1('#engAiGutter');
  const panel = eq1('#engAiPanel');
  if (!grip || !panel || grip.dataset.bound) return;
  grip.dataset.bound = '1';
  engAiRestorePanelWidth();

  let dragging = false, startX = 0, startW = 0, raf = 0;
  // 拖的过程中画板的宽度一直在变, 连线要跟着重画。但 pointermove 每秒能来上百次,
  // 每次都重画会卡 —— 合并到一帧一次。
  const redraw = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (typeof renderEngineCanvas === 'function') renderEngineCanvas();
    });
  };

  grip.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    dragging = true;
    startX = ev.clientX;
    startW = panel.offsetWidth;
    grip.classList.add('dragging');
    document.body.classList.add('eng-ai-resizing');
    try { grip.setPointerCapture(ev.pointerId); } catch (e) {}
  });
  grip.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    // 往左拖 (clientX 变小) 面板要变宽, 所以是 startW - 位移
    engAiApplyPanelWidth(startW - (ev.clientX - startX));
    redraw();
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    grip.classList.remove('dragging');
    document.body.classList.remove('eng-ai-resizing');
    const w = panel.offsetWidth;
    try { localStorage.setItem(ENG_AI_W_KEY, String(w)); } catch (e) {}
    if (typeof renderEngineCanvas === 'function') renderEngineCanvas();
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
  // 双击复位到默认比例 —— 拖歪了想回到"画板七成、面板三成"的快捷方式
  grip.addEventListener('dblclick', () => {
    panel.style.flex = '';
    try { localStorage.removeItem(ENG_AI_W_KEY); } catch (e) {}
    if (typeof renderEngineCanvas === 'function') renderEngineCanvas();
  });
}

function engBindAi() {
  // 注意: #btnAiFab 不在这里绑 —— 它在 renderEngineHead 重建的那一行里,
  // 由那边每次渲染时重新挂 (这函数只跑一次, 挂上就丢了)。
  const close = eq1('#btnAiClose');
  if (close && !close.dataset.bound) {
    close.dataset.bound = '1';
    close.addEventListener('click', () => engAiTogglePanel(false));
  }
  const cfg = eq1('#btnAiConfig');
  if (cfg && !cfg.dataset.bound) {
    cfg.dataset.bound = '1';
    cfg.addEventListener('click', engOpenAiScope);
  }
  const reset = eq1('#btnAiReset');
  if (reset && !reset.dataset.bound) {
    reset.dataset.bound = '1';
    // 走同一个重置函数 —— 这里原来抄了一份, 抄漏了 autoPrompted
    reset.addEventListener('click', () => engAiNewChat());
  }
  // 页签: 对话 / 规划 / 历史。点哪个切哪个 (三个各占满内容区)。
  const tabs = eq1('#engAiTabs');
  if (tabs && !tabs.dataset.bound) {
    tabs.dataset.bound = '1';
    eqAll('.eng-ai-tab', tabs).forEach((b) => {
      b.addEventListener('click', async () => {
        const which = b.dataset.aitab;
        engAiSetTab(which);
        // 切到历史页时顺便拉一次最新列表 (对话推进之后标题/时间会变)
        if (which === 'history') await engAiRefreshChats();
      });
    });
  }
  engBindAiGutter();
  const send = eq1('#btnAiSend');
  if (send && !send.dataset.bound) {
    send.dataset.bound = '1';
    send.addEventListener('click', engAiSend);
  }
  const stop = eq1('#btnAiStop');
  if (stop && !stop.dataset.bound) {
    stop.dataset.bound = '1';
    stop.addEventListener('click', engAiStop);
  }
  const input = eq1('#engAiInput');
  if (input && !input.dataset.bound) {
    input.dataset.bound = '1';
    // Ctrl/Cmd + Enter 发送, 单纯回车留给换行 (判断逻辑常常要分行写)
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); engAiSend(); }
    });
  }
  // 画板收起来时 AI 面板一并收起, 免得留着占位
  const panel = eq1('#engAiPanel');
  if (panel && !panel.dataset.bound) {
    panel.dataset.bound = '1';
    panel.addEventListener('mousedown', (ev) => ev.stopPropagation());
  }
}
/* ---- AI 对话: 一步步把这张卡搭出来 ---- */
/**
 * 把一份范围池跟「数据库」页维护过的表求交集。
 *
 * 抽出来是因为有两个用处, 两边必须是同一套规则:
 *  - 发给 AI 之前滤一遍 (engAiScopeForSend)
 *  - 卡片墙上那个"AI 可用 N 张表"标签 (engScopeTableCount)
 * 各写一份的话, 卡片上写着"AI 可用 5 张"、AI 实际只看到 3 张, 会让人以为范围配错了。
 */
function engScopeClean(pool) {
  const dbs = engDatabases();
  const clean = {};
  for (const k of Object.keys(pool || {})) {
    const list = pool[k] || [];
    if (!list.length) continue;
    // 配置还没加载出来时先别乱砍, 免得把范围清空
    if (!dbs.length) { clean[k] = list; continue; }
    const ok = new Set(engDbMaintainedTables(dbs.find((d) => d.id === k)));
    const kept = list.filter((t) => ok.has(t));
    if (kept.length) clean[k] = kept;
  }
  return clean;
}
/**
 * 真正发给 AI 的范围池。
 * 顺手和「数据库」页维护过的表求个交集 —— 用户在数据库那边把某张表取消勾选之后,
 * 范围池里可能还留着它, 不在这里滤掉的话它照样会被送过去给 AI 用。
 */
function engAiScopeForSend() {
  return engScopeClean(engState.aiPool);
}
async function engAiEnsureSession(force) {
  if (engState.aiSessionId && !force) return engState.aiSessionId;
  if (engState.aiSessionId && force) {
    try { await window.bridge.engine.aiClose({ sessionId: engState.aiSessionId }); } catch (e) {}
    engState.aiSessionId = null;
  }
  if (!engState.card) {
    // 以前这里是静默 return null, 上游 engAiSendText 也只是 return —— 结果是
    // "我打了字, 它一个字都不回"。面板开着但画板上的卡没了 (切了页、卡被删), 得说清楚。
    engAiPush('act', '画板上没有卡了，打不开 AI 会话。先打开一张卡再继续。', { err: true });
    return null;
  }
  // 带上 chatId: 有就接着那条聊 (主进程会复用活会话或按快照重建), 没有就开新的
  //
  // 这里必须自己接住异常。以前没接: aiOpen 一失败就一路冒到 engAiSendText,
  // 把 aiChatBusy 永远留在 true 上 —— 之后每条消息都在 busy 闸门被静默丢掉,
  // 输入框也永久禁用, 只能重启应用。
  let r;
  try {
    r = await window.bridge.engine.aiOpen({
      card: engState.card,
      pool: engAiScopeForSend(),
      chatId: engState.aiChatId || null
    });
  } catch (e) {
    engAiPush('act', '打不开 AI 会话: ' + ((e && e.message) || e), { err: true });
    return null;
  }
  if (!r || !r.ok) { engAiPush('act', (r && r.error) || '打不开 AI 会话', { err: true }); return null; }
  engState.aiSessionId = r.sessionId;
  if (r.chatId) engState.aiChatId = r.chatId;
  return r.sessionId;
}
async function engAiSend() {
  const ta = eq1('#engAiInput');
  const text = (ta ? ta.value : '').trim();
  if (!text) return;
  // 以前这里是 `if (!text || engState.aiChatBusy || !engState.card) return;` —— 静默。
  // 而这是"按回车"的入口, 所以症状是"打完字按回车, 什么都不发生, 连字都还留在框里"。
  // 现在统一交给 engAiSendText 判断并说明原因; 它说没发出去, 就不清空输入框 —— 用户的话不丢。
  //
  // 清空的时机是**这句话被收下的那一刻**, 不是整轮跑完。
  //
  // 以前是 `const sent = await engAiSendText(text); if (sent) ta.value = ''` ——
  // sent 要等 engAiSendText 整个 Promise 落地才为真, 而那一轮包括搭建 + 后面的自测,
  // 可能好几分钟。于是这几分钟里输入框还挂着刚发出去的那句话, 看着像"没发出去";
  // 又因为当时 busy 会把输入框禁用, 想改也改不了。用户原话就是这两句:
  // "内容没释放" + "也不让点击"。
  //
  // 回调只在闸门全部通过之后触发 (见 engAiSendText), 所以"没发出去"时字仍然留在框里。
  await engAiSendText(text, () => {
    if (ta && ta.value.trim() === text) ta.value = '';
  });
}
/**
 * 真正把一句话发出去。选择题答完也走这里, 所以和输入框解耦。
 *
 * @param {string} text
 * @param {Function} [onAccepted] 这句话被收下时**立刻**回调 (调用方用清输入框)。
 *   由调用方传进来而不是自己去够输入框: 选择题那条路根本没有输入框。
 */
async function engAiSendText(text, onAccepted) {
  text = String(text || '').trim();
  if (!text) return false;
  // 以前这两个条件和 !text 挤在同一个静默 return 里: 打了字什么都没发生, 分不清是
  // "上一条还没跑完"、"画板上的卡没了"还是"程序坏了"。分开说, 让人一眼知道该干嘛。
  // 返回 false = 这一轮没发出去, 调用方 (engAiSend) 据此决定别清空输入框。
  if (engState.aiChatBusy) {
    engToast('上一条还在处理，等它结束再发', 'err');
    return false;
  }
  if (!engState.card) {
    engToast('画板上没有卡，先打开一张卡', 'err');
    return false;
  }
  // 范围没配就不让开工 —— 模型看不到任何表, 只能瞎猜
  if (!Object.keys(engAiScopeForSend()).length) {
    engToast('先点右上角「配置」，选 AI 能用哪些表', 'err');
    engOpenAiScope();
    return false;
  }
  // 改现有卡之前先问一次: 它确实会往你手上这张卡里加东西
  if (!engState.aiConfirmed) {
    const n = (engState.card.nodes || []).length;
    if (n > 2 && !(await askConfirm({
      title: '让 AI 改这张卡?',
      message: 'AI 会在当前这张卡上增删改节点、改配置, 不会推倒重来。',
      detail: `这张卡现在有 ${n} 个节点。AI 只动它认为要动的部分, 但你手改过的节点也可能被覆盖 —— 改完记得自己看一眼。`,
      okText: '继续',
      cancelText: '先不了'
    }))) return false;
    engState.aiConfirmed = true;
  }
  engState.aiChatBusy = true;
  engState.aiDropped = 0;          // 新一轮, 丢弃计数重新开始
  // 领一个序号, 并记下这次发送是替哪张卡跑的。finally 靠它们判断
  // "我还是不是最新的那一次" (见 engAiSyncComposer 上面那段注释)。
  engState.aiSendSeq = (engState.aiSendSeq || 0) + 1;
  const mySeq = engState.aiSendSeq;
  engState.aiBusyCardId = engState.currentId;
  // 先当作"在搭建"。收尾之后主进程会接着跑自测, 那时候 ai_done 事件
  // (autoSelfTest) 会把它改成 'selftest' —— 「停止」按钮据此分流。
  engState.aiPhase = 'build';
  engAiKickWatchdog();
  engAiSetComposerBusy(true);
  engAiPush('user', text);
  // 已经收下了 —— 通知调用方现在就可以清输入框 (它必须**立刻**发生,
  // 不能等这轮跑完; 见 engAiSend 上面那段说明)。
  if (typeof onAccepted === 'function') onAccepted();
  // 整段包在 try/finally 里。
  //
  // 以前 busy 的复位散在正常路径和"sid 为空"那条早退路径上, 中间任何一步抛异常,
  // aiChatBusy 就永远停在 true —— 之后每一条消息都在上面那道 busy 闸门被静默丢掉,
  // 输入框也永久禁用, 只能重启应用。放进 finally, 无论怎么退出都会复位。
  try {
    const sid = await engAiEnsureSession();
    if (!sid) return;   // 原因 engAiEnsureSession 已经写进对话里了, 这里别再重复一遍
    let r;
    try {
      // 把画板上当前的草稿一起带上: 用户可能在面板开着的时候手改过这张卡,
      // 不带过去的话 AI 会拿着旧副本继续改, 回传时把用户的手改盖掉。
      // log 也带上 —— 主进程要把它和模型对话史一起落盘, 界面才和记录对得上。
      r = await window.bridge.engine.aiSay({
        sessionId: sid,
        text,
        pool: engAiScopeForSend(),
        card: engState.card,
        log: engState.aiLog
      });
    } catch (e) {
      r = { ok: false, error: (e && e.message) || String(e) };
    }
    if (!r || !r.ok) engAiPush('act', (r && r.error) || '这次没跑通', { err: true });
  } finally {
    // 只在自己仍是最新那次发送时才解锁。否则: 用户等不及又发了一条,
    // 先落地的那条会把 busy 清掉, 第二条还在跑输入框却能打字了。
    if (engState.aiSendSeq === mySeq) {
      engState.aiChatBusy = false;
      engState.aiPhase = null;
      engState.aiBusyCardId = null;
      engAiStopWatchdog();
      engAiSetComposerBusy(false);
    }
    engAiRenderLog();
  }
  // 对话内容变了, 历史列表的标题/时间跟着刷新
  engAiRefreshChats();
  return true;
}
/** 刷新这张卡的历史对话列表 (对话推进之后调, 让标题和时间跟上) */
async function engAiRefreshChats() {
  const cardId = engState.card && engState.card.id;
  if (!cardId || !window.bridge.engine.aiChatList) return;
  let r;
  try { r = await window.bridge.engine.aiChatList({ cardId }); } catch (e) { r = null; }
  // 同 engAiRestoreForCard: 回来时可能已经换卡了, 过期响应不能盖上去
  if (!engState.card || engState.card.id !== cardId) return;
  engState.aiChats = (r && r.chats) || [];
  engAiRenderHistory();
}
/**
 * 输入框的"忙"状态, 一律从这里改。
 *
 * 之前只有 engAiSetComposerBusy(true/false) 两个调用点 (发送开头 + finally),
 * 看着够用, 但漏了两种情况:
 *
 *  1. **换卡/新建卡之后输入框还锁着。** 上一张卡的 aiSay 还在飞 (搭建完了
 *     主进程还会接着跑自测, 可能好几分钟), 它的 finally 要等 Promise 落地
 *     才执行。这期间用户切到新卡、打开 AI 面板, 看到的是一个灰掉的输入框,
 *     只能等 —— 这正是"不让输入, 需要等一会"的来源。切走再回来之所以能好,
 *     是因为切走时 engAiDetach 发了 aiClose, 主进程收工, Promise 才落地。
 *
 *  2. **旧请求的 finally 会解锁新请求的输入框。** 两条发送重叠时,
 *     先落地的那条的 finally 把 busy 清成 false, 于是第二条还在跑,
 *     输入框却能打字了, 用户再发一条就变成三条并发。
 *
 * 修法: 每次发送领一个序号。finally 只在序号仍然是最新的时候才解锁;
 * 而切卡/开面板时直接按"当前这张卡有没有在跑的发送"重算一次。
 */
function engAiSetComposerBusy(busy) {
  const btn = eq1('#btnAiSend');
  if (btn) { btn.disabled = busy; btn.textContent = busy ? '思考中…' : '发送'; }
  // 输入框**不跟着禁用** —— 这里以前是 `const ta = eq1('#engAiInput'); ta.disabled = busy`。
  //
  // 这一轮可能跑好几分钟 (搭建完主进程还要接着自测), 那几分钟里连点进输入框都不行,
  // 而上一句还挂在里面 (见 engAiSend 的说明), 用户只能盯着转圈, 既改不了也写不了下一句。
  // 现在正文照旧可点可写; 真撞上"上一条还在处理", 发送那一步会明说原因
  // (engAiSendText 的 busy 闸门), 比一个灰掉的框有用得多。
  // 忙的时候给一个"停止"。收尾之后主进程会接着跑自测 (可能好几分钟),
  // 没有这个按钮用户只能干等 —— 所以它跟着 busy 一起出现。
  const stop = eq1('#btnAiStop');
  if (stop) stop.classList.toggle('on', !!busy);
}
/**
 * 按当前真实状态重算一次输入框的可用性。
 *
 * 开面板 / 换卡 / 新建对话 / detach 之后都要调。只依赖 engState.aiChatBusy
 * 和"这个 busy 属不属于眼前这张卡"。
 */
function engAiSyncComposer() {
  // 上一次发送如果属于另一张卡, 它对当前这张卡没有意义 —— 输入框不该被它锁住
  if (engState.aiChatBusy && engState.aiBusyCardId && engState.aiBusyCardId !== engState.currentId) {
    engState.aiChatBusy = false;
    engState.aiPhase = null;
    engState.aiSendSeq = (engState.aiSendSeq || 0) + 1;  // 让旧 finally 认不出自己
  }
  engAiSetComposerBusy(!!engState.aiChatBusy);
}
/**
 * busy 期间的心跳看门狗。
 *
 * busy 现在由 try/finally 保证复位, 所以"抛异常导致永久卡死"应该不会发生了。
 * 但那只挡得住异常, 挡不住"某个 await 永远不返回"。留着这个兜底, 免得将来又多出
 * 一条新的静默路径 —— 用户只能盯着转圈干等, 不知道该点哪里。
 *
 * 每次收到事件都重新计时, 所以正常跑着 (哪怕自测要好几分钟) 不会误报;
 * 阈值也比模型最长超时 (3 分钟) 宽得多。
 */
const ENG_AI_STALL_MS = 10 * 60 * 1000;
function engAiKickWatchdog() {
  engAiStopWatchdog();
  engState.aiWatchdog = setTimeout(() => {
    if (!engState.aiChatBusy) return;
    engAiPush('act', '已经 10 分钟没有任何进展了，可能卡住了。可以点「停止」，或者关掉 AI 面板重开。', { err: true });
  }, ENG_AI_STALL_MS);
}
function engAiStopWatchdog() {
  if (engState.aiWatchdog) { clearTimeout(engState.aiWatchdog); engState.aiWatchdog = null; }
}
/**
 * 点「停止」。
 *
 * 忙的时候有两种活, 走两条不同的 IPC:
 *   - 搭建中   -> engine:aiCancel        (停搭建)
 *   - 收尾后的自测 -> engine:aiStopSelfTest (停自测)
 *
 * 以前这里**写死只停自测**, 所以搭建阶段点下去只会得到一句
 * "现在没有在跑的自测", 而搭建还在跑 —— 用户以为按钮坏了。
 * 现在按 aiPhase 分流。
 */
async function engAiStop() {
  const sid = engState.aiSessionId;
  if (!sid) return;
  const phase = engState.aiPhase === 'selftest' ? 'selftest' : 'build';
  engAiPush('act', phase === 'build' ? '已请求停止搭建，正在收尾…' : '已请求停止自测，正在收尾…');
  engAiRenderLog();
  const api = window.bridge.engine;
  const call = phase === 'build' ? api.aiCancel : api.aiStopSelfTest;
  if (typeof call !== 'function') {
    engAiPush('act', '这个版本还不支持停止，等它自己跑完吧', { err: true });
    engAiRenderLog();
    return;
  }
  try {
    const r = await call({ sessionId: sid });
    if (!r || !r.ok) {
      engAiPush('act', (r && r.error) || '现在没有在跑的任务', { err: true });
      engAiRenderLog();
    }
  } catch (e) {
    engAiPush('act', '停止失败: ' + ((e && e.message) || e), { err: true });
    engAiRenderLog();
  }
}
/**
 * 两张卡的"逻辑内容"是否一致。
 *
 * 只比结构、SQL、条件、模板、连线 —— **不比 x/y**, 也**不比 name / description**。
 *
 * 位置是界面自己的事: AI 每次推图都会重排一遍坐标, 连位置一起比的话,
 * 用户拖过的节点会被判成"变了", 于是一次没必要的重画, 顺带把拖拽结果盖掉。
 *
 * 名字和描述同理, 但更严重: AI 没有改卡名的工具, 它推回来的卡名永远是会话开始
 * 时那一份。这里如果拿名字参与比对, 就会把"只有名字不同"判成"卡变了", 进而
 * 走覆盖流程 —— 用户在 AI 干活期间填的名字就这么被冲掉了。
 * (主进程侧 adoptCard 的指纹也不含这两个字段, 两边口径必须一致。)
 */
function engCardEquals(a, b) {
  if (!a || !b) return a === b;
  const sig = (c) => JSON.stringify({
    id: c.id,
    n: (c.nodes || []).map((x) => [x.id, x.type, x.title, x.sql || '', x.template || '', x.table || '', x.databaseId || '', JSON.stringify(x.expr || null), JSON.stringify(x.outputs || []), JSON.stringify(x.fields || [])]),
    e: (c.edges || []).map((x) => [x.from, x.to, x.port])
  });
  return sig(a) === sig(b);
}

function engAiHandleEvent(ev) {
  if (!ev) return;
  if (ev.sessionId && engState.aiSessionId && ev.sessionId !== engState.aiSessionId) {
    // 以前这里是静默 return —— 这是唯一一处"AI 明明回了, 界面上却什么都没有"的地方,
    // 表现就是"我问它, 它不说话"。现在至少留个痕迹: 控制台一条 + 对话里一条。
    // 只提示一次: 事件很密, 逐条提示会把对话刷屏。
    engState.aiDropped = (engState.aiDropped || 0) + 1;
    if (engState.aiDropped === 1) {
      console.warn('[engAi] 丢弃了不属于当前会话的事件', ev.sessionId, '当前会话', engState.aiSessionId);
      engAiPush('act', '收到一个不属于当前会话的事件，已忽略（可能是会话刚被重建）。如果对话不动了，关掉 AI 面板重开一下。', { err: true });
    }
    return;
  }
  // 有事件进来就说明没卡死, 看门狗重新计时
  if (engState.aiChatBusy) engAiKickWatchdog();
  if (ev.type === 'ai_delta') {
    engAiDelta(ev.text || '');
    return;
  }
  // 非 delta 事件 = 这一轮的话说完了: 收编正在流式的正文 (拿回它的文本备用)
  const streamed = engAiCommitStream();
  if (ev.type === 'ai_say' || ev.type === 'ai_act') {
    // 这段正文刚才已经流式显示过 (agent-loop 发完流式正文后会补一条同内容的 ai_say):
    // 认出来就别再 push 一遍 (会重复), 也不要再走打字机。
    if (streamed != null && ev.type === 'ai_say'
        && String(ev.text || '').trim() === String(streamed).trim()) {
      return;
    }
    engAiPush(ev.type === 'ai_say' ? 'ai' : 'act', ev.text || '');
    return;
  }
  if (ev.type === 'ai_ask') {
    // 带选项的提问做成卡片让用户点选, 没有选项就退回普通文字提问
    if (ev.choice && (ev.choice.options || []).length) {
      engAiPushChoice(ev.question || ev.choice.question, ev.choice);
    } else {
      engAiPush('ai', ev.question || '');
    }
    return;
  }
  if (ev.type === 'ai_plan') {
    // 规划可能被改好几版。同一版不该在对话里堆成好几张卡 —— 后一版覆盖前一版,
    // 位置留在原处, 这样"规划"始终只有一张, 而且它就在对话里当初那个位置。
    const log = engState.aiLog || [];
    const prev = log.findIndex((x) => x.role === 'plan');
    const item = { role: 'plan', plan: ev.plan || {} };
    if (prev >= 0) log[prev] = item; else log.push(item);
    // 改规划时如果面板正开着, 让用户看得见它变了 —— 不然"更新了这里"是句空话
    // 改规划时如果正停在规划页, 让它立刻刷新 —— 不然"更新了这里"是句空话
    // (不在规划页就什么都不做: engAiRenderPlan 自己会早退)
    engAiRenderPlan();
    engAiRenderLog();
    return;
  }
  if (ev.type === 'ai_graph') {
    // 主进程推来的图是"它眼里的草稿"。用户可能在等 AI 回复的时候手改过画板 ——
    // 那种情况下不能拿它覆盖, 否则用户刚拖的一根线、刚改的一句 SQL 就没了。
    // 判据用"图变没变"而不是"是不是同一个对象": 只改了位置不该算改动。
    if (ev.card && !engCardEquals(engState.card, ev.card)) {
      engAdoptCard(ev.card);
      engTouch();
      // 别在这里自动选中节点: 右侧的节点配置面板会把画板盖住,
      // 用户想看的正是"图一点点长出来", 盖住了就白搭。
      renderEngineCanvas();
      // 新节点是往右铺的, 不重新适配就会加到可视区外面, 看着像没反应。
      engFitIfNeeded();
    }
    return;
  }
  if (ev.type === 'ai_done') {
    // 同上: 只有图真的变了才覆盖画板, 免得把用户手改的东西冲掉。
    // 但校验与面板一定要重画 —— AI 可能只改了描述这类不影响图的东西。
    if (ev.card && !engCardEquals(engState.card, ev.card)) {
      engAdoptCard(ev.card);
      engTouch();
      renderEngineCanvas();
      engFitIfNeeded();
      renderEngineInspector();
    }
    engValidate();
    // 刚搭完一张能跑的卡: 直接把"确认测试"的窗弹出来, 让作者填一组单号试跑。
    // 只在真搭出东西的时候弹 (没搭完就弹会打断对话)。
    //
    // 主进程说它会自己跑自测时 (autoSelfTest) 就不弹了 —— 自测会自己去库里
    // 找真实的单号, 这时候再弹一个"请填单号"的窗只会互相打脸。
    if (ev.autoSelfTest) {
      // 搭建这一段结束, 接下来忙的是自测 —— 让「停止」打到自测那条 IPC 上。
      engState.aiPhase = 'selftest';
      engAiSetComposerBusy(true);
    } else {
      engMaybePromptTest(ev.summary);
    }
    return;
  }
}

/**
 * 搭完了就弹测试窗。
 *
 * 判据是"这张卡能不能跑" —— 有入口、有至少一个取数、有出口, 且校验没报错。
 * 缺一样就说明还在搭, 这时候弹窗只会打断人。同一张卡只弹一次 (autoPrompted),
 * 不然每轮对话都弹, 很烦。
 */
function engMaybePromptTest(summary) {
  if (engState.autoPrompted || engState.autoRunId) return;
  if (engTestModalOpen()) return;
  const c = engState.card;
  if (!c || !c.nodes || c.nodes.length < 3) return;
  const types = c.nodes.map((n) => n.type);
  if (!types.includes('input') || !types.includes('output')) return;
  if (!types.some((t) => t === 'query' || t === 'condition')) return;
  engState.autoPrompted = true;
  engAiPush('ai', '搭好了。接着弹个测试窗 —— 填一组真实单号，点「自动测试并修复」，跑不通我会自己往下查。');
  engAiRenderLog();
  // 把这个"已经弹过了"的标记落盘 —— 不落的话, 一条早就搭完收尾的对话每次重进
  // 都会再弹一次测试窗, 看着就像"它又自己重跑了一遍"。
  engAiPersistChat();
  openEngTest();
}

/** 把当前对话存一次 (改完标题、弹过测试窗这类需要记住的状态变化) */
function engAiPersistChat() {
  const id = engState.aiChatId;
  if (!id || !window.bridge.engine.aiChatSave) return;
  try {
    window.bridge.engine.aiChatSave({
      id,
      log: engState.aiLog,
      cardId: engState.card && engState.card.id,
      autoPrompted: engState.autoPrompted
    });
  } catch (e) {}
}

/* ==================== 节点配置 (右侧滑出) ==================== */
function renderEngineInspector() {
  const box = eq1('#engineInspector');
  if (!box) return;
  // 节点编辑框只由**双击**节点打开 (inspOpen); 连线点一下即开。
  const nodeOpen = !!(engState.card && engState.selectedNode && engState.inspOpen);
  const edgeOpen = !!(engState.card && engState.selectedEdge);
  if (!nodeOpen && !edgeOpen) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  if (engState.selectedEdge) {
    box.innerHTML = `<div class="eng-insp">
      <div class="eng-insp-bar">
        <span class="eng-insp-bar-title">选中的连线</span>
        <button class="eng-insp-close" id="btnCloseInsp" title="收起">×</button>
      </div>
      <div class="eng-insp-row">${engEsc(engEdgeText(engState.selectedEdge))}</div>
      <button class="btn btn-sm btn-danger" id="btnDelEdge">删掉这条连线</button>
    </div>`;
    eq1('#btnCloseInsp').addEventListener('click', () => { engState.selectedEdge = null; renderEngineInspector(); });
    eq1('#btnDelEdge').addEventListener('click', () => engRemoveEdge(engState.selectedEdge));
    return;
  }
  const node = engState.card.nodes.find((n) => n.id === engState.selectedNode);
  if (!node) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  const head = `
    <div class="eng-insp-bar">
      <span class="eng-node-kind eng-kind-${node.type}">${ENG_LABEL[node.type] || node.type}</span>
      <input class="eng-insp-title-input" id="engNodeTitle" value="${engEsc(node.title || '')}" placeholder="节点名称" />
      <button class="eng-insp-close" id="btnCloseInsp" title="收起">×</button>
    </div>`;
  const foot = `<div class="eng-insp-foot">
      <span class="eng-insp-id">${engEsc(node.id)}</span>
      <button class="btn btn-sm btn-danger" id="btnDelNode">删除节点</button>
    </div>
    </div>`;
  if (node.type === 'input') box.innerHTML = '<div class="eng-insp">' + head + engInspInput(node) + foot;
  else if (node.type === 'query') box.innerHTML = '<div class="eng-insp">' + head + engInspQuery(node) + foot;
  else if (node.type === 'condition') box.innerHTML = '<div class="eng-insp">' + head + engInspCondition(node) + foot;
  else box.innerHTML = '<div class="eng-insp">' + head + engInspOutput(node) + foot;
  eq1('#engNodeTitle').addEventListener('input', (e) => {
    node.title = e.target.value;
    engTouch();
    renderEngineCanvas();
  });
  eq1('#btnCloseInsp').addEventListener('click', () => {
    engState.selectedNode = null;
    engState.selectedEdge = null;
    engState.inspOpen = false;
    renderEngineCanvas();
    renderEngineInspector();
  });
  eq1('#btnDelNode').addEventListener('click', () => engRemoveNode(node.id));
  if (node.type === 'input') engBindInput(node);
  if (node.type === 'query') engBindQuery(node);
  if (node.type === 'condition') engBindCondition(node);
  if (node.type === 'output') engBindOutput(node);
}
function engEdgeText(sel) {
  const card = engState.card;
  const from = card.nodes.find((n) => n.id === sel.from);
  const edge = card.edges.find((e) => e.from === sel.from && (e.port || 'out') === sel.port);
  const target = edge && card.nodes.find((n) => n.id === edge.to);
  const portWord = sel.port === 'true' ? '（成立）' : sel.port === 'false' ? '（不成立）' : '';
  return `${from ? from.title : sel.from}${portWord} → ${target ? target.title : '?'}`;
}
/* ---- 输入项区块: 入口节点与取数节点共用 ---- */
function engFieldsHtml(node) {
  const rows = (node.fields || []).map((f, i) => `
    <div class="eng-field" data-field-row="${i}">
      <input class="eng-f-key" type="text" data-f="key" value="${engEsc(f.key)}" placeholder="名字" />
      <input class="eng-f-label" type="text" data-f="label" value="${engEsc(f.label || '')}" placeholder="中文名" />
      <label class="eng-f-req"><input type="checkbox" data-f="required" ${f.required ? 'checked' : ''} /> 必填</label>
      <button class="eng-f-del" data-fdel="${i}" title="删掉">×</button>
      <input class="eng-f-desc" type="text" data-f="desc" value="${engEsc(f.desc || '')}" placeholder="说明" />
      <input class="eng-f-group" type="text" data-f="group" value="${engEsc(f.group || '')}" placeholder="任选其一组名" />
    </div>`).join('');
  // 有任选组的时候要把规则说清楚, 否则很容易以为"标了选填那项就变成可选"
  const groups = [];
  for (const f of (node.fields || [])) {
    if (f.group && !groups.includes(f.group)) groups.push(f.group);
  }
  const groupNote = groups.length
    ? `<div class="eng-insp-hint eng-insp-warn">「${groups.map(engEsc).join('」「')}」是任选其一：组里给一个就算齐。
       但卡里还要加条件节点按「哪一项有值」分流（算子用 notEmpty），否则没填的那几项在 SQL 里会渲染成空串而查不到数。</div>`
    : '';
  return `
    <div class="eng-insp-label">输入</div>
    ${groupNote}
    <div class="eng-fields">${rows}</div>
    <button class="btn btn-sm" id="btnAddField">加一个输入项</button>`;
}
function engBindFields(node, afterChange) {
  const box = eq1('#engineInspector');
  const fire = () => { engTouch(); engValidate(); if (afterChange) afterChange(); };
  eqAll('[data-field-row]', box).forEach((row) => {
    const i = Number(row.dataset.fieldRow);
    eqAll('[data-f]', row).forEach((el) => {
      el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', () => {
        const f = node.fields[i];
        if (!f) return;
        const k = el.dataset.f;
        if (k === 'required') f.required = el.checked;
        else {
          const before = f.key;
          f[k] = el.value;
          // 改了名字 -> SQL 里写的 {{旧名}} 会变成"没有来源", 顺手一起改掉
          if (k === 'key' && before && before !== el.value && node.sql) {
            const next = String(node.sql).split('{{' + before + '}}').join('{{' + el.value + '}}');
            if (next !== node.sql) node.sql = next;
          }
        }
        fire();
      });
    });
  });
  eqAll('[data-fdel]', box).forEach((b) => b.addEventListener('click', () => {
    node.fields.splice(Number(b.dataset.fdel), 1);
    renderEngineInspector();
    fire();
  }));
  const add = eq1('#btnAddField', box);
  if (add) add.addEventListener('click', () => {
    node.fields = node.fields || [];
    node.fields.push({ key: 'input' + (node.fields.length + 1), label: '输入项', required: false });
    renderEngineInspector();
    fire();
  });
}
/* ---- 输入节点 ---- */
function engInspInput(node) {
  return engFieldsHtml(node);
}
function engBindInput(node) {
  engBindFields(node, () => renderEngineCanvas());
}
/* ---- 取数节点的「输入」: 和条件节点的左值同一套, 只能引用, 不凭空造 ---- */
/** 取数节点的输入区。
 *  入口节点的输入是"要问用户什么", 可以凭空声明；取数节点的输入是 SQL 参数,
 *  值必然来自入口字段或上游取数节点的输出列, 所以这里不给"新建"的口子, 只给引用。
 *  交互与条件节点的左值一致: 输入框带补全清单, 下面列出能引用的东西。
 *  行尾多一个来源徽标, 把"接没接上"直接摆出来。 */
function engQueryRefsHtml(node, refs) {
  const refList = `<datalist id="engRefList">${refs.map((r) => `<option value="${engEsc(r.ref)}">${engEsc(r.label)}</option>`).join('')}</datalist>`;
  const rows = (node.fields || []).map((f, i) => {
    const hit = refs.find((r) => r.ref === f.key);
    const tag = !f.key
      ? '<span class="eng-ref-src none">待选</span>'
      : (hit
        ? `<span class="eng-ref-src">来自 ${engEsc(hit.src)}</span>`
        : '<span class="eng-ref-src miss">没接上</span>');
    return `<div class="eng-rule" data-field-row="${i}">
      <input class="eng-r-left" type="text" data-f="key" list="engRefList" value="${engEsc(f.key)}" placeholder="引用" />
      ${tag}
      <button class="eng-f-del" data-fdel="${i}" title="删掉">×</button>
    </div>`;
  }).join('');
  // 能引用的东西: 引用本身蓝、后面的中文名黑 (见 .eng-ref-token / .eng-ref-name)
  const help = refs.slice(0, 10)
    .map((r) => `<span class="eng-ref-token">{{${engEsc(r.ref)}}}</span> <span class="eng-ref-name">${engEsc(r.label)}</span> <span class="eng-ref-from">· ${engEsc(r.src)}</span>`)
    .join('<br>');
  return `
    ${refList}
    <div class="eng-insp-label">输入</div>
    <div class="eng-rules">${rows}</div>
    <button class="btn btn-sm" id="btnAddField">加一个引用</button>
    ${help ? `<div class="eng-insp-hint eng-ref-help">能引用的东西：<br>${help}</div>` : ''}`;
}
function engBindQueryRefs(node, refs, afterChange) {
  const box = eq1('#engineInspector');
  const fire = () => { engTouch(); engValidate(); if (afterChange) afterChange(); };
  eqAll('[data-field-row]', box).forEach((row) => {
    const i = Number(row.dataset.fieldRow);
    const input = eq1('[data-f="key"]', row);
    if (!input) return;
    input.addEventListener('input', () => {
      const f = (node.fields || [])[i];
      if (!f) return;
      const before = f.key;
      f.key = input.value.trim();
      // 引用到谁就把谁的中文名一起带过来, 画板上显示的就是人看得懂的那个
      const hit = refs.find((r) => r.ref === f.key);
      f.label = hit ? hit.label : '';
      // SQL 里原来写的 {{旧名}} 跟着改掉, 免得留下一个接不上的占位符
      if (before && before !== f.key && node.sql) {
        const next = String(node.sql).split('{{' + before + '}}').join(f.key ? '{{' + f.key + '}}' : '');
        if (next !== node.sql) node.sql = next;
      }
      // 就地改徽标, 不重建面板 —— 重建会让输入框失焦
      const tag = eq1('.eng-ref-src', row);
      if (tag) {
        if (!f.key) { tag.className = 'eng-ref-src none'; tag.textContent = '待选'; }
        else if (hit) { tag.className = 'eng-ref-src'; tag.textContent = '来自 ' + hit.src; }
        else { tag.className = 'eng-ref-src miss'; tag.textContent = '没接上'; }
      }
      fire();
    });
  });
  eqAll('[data-fdel]', box).forEach((b) => b.addEventListener('click', () => {
    node.fields.splice(Number(b.dataset.fdel), 1);
    renderEngineInspector();
    fire();
  }));
  const add = eq1('#btnAddField', box);
  if (add) add.addEventListener('click', () => {
    node.fields = node.fields || [];
    node.fields.push({ key: '', label: '' });
    renderEngineInspector();
    fire();
  });
}
/* ---- 取数节点: 输入 + 库表字段级联 + SQL(AI/同步) + 输出列 ---- */
function engInspQuery(node) {
  const dbs = engDatabases();
  const refs = engRefOptions(engState.card, node.id);
  const dbOpts = ['<option value="">（选库）</option>'].concat(
    dbs.map((d) => `<option value="${engEsc(d.id)}" ${node.databaseId === d.id ? 'selected' : ''}>${engEsc(d.name || d.type || d.id)}</option>`)
  ).join('');
  const cols = (node.outputs || []).map((c, i) => `
    <div class="eng-col" data-col-row="${i}">
      <input class="eng-c-key" type="text" data-c="key" value="${engEsc(c.key)}" placeholder="列名" list="engFieldsList" />
      <input class="eng-c-label" type="text" data-c="label" value="${engEsc(c.label || '')}" placeholder="中文名（可选）" />
      <button class="eng-f-del" data-cdel="${i}" title="删掉">×</button>
    </div>`).join('');
  return `
    ${engQueryRefsHtml(node, refs)}
    <div class="eng-insp-label">库</div>
    <select class="eng-input" id="engDb">${dbOpts}</select>
    <div class="eng-insp-label">表 <span class="eng-insp-sub">（可输入关键字筛）</span></div>
    <input class="eng-input" type="text" id="engTable" list="engTablesList" value="${engEsc(node.table)}" placeholder="表名" />
    <datalist id="engTablesList" data-for="tables"></datalist>
    <datalist id="engFieldsList" data-for="fields"></datalist>
    <div class="eng-sql-block">
      <div class="eng-sql-bar">
        <span class="eng-sql-bar-label">SQL</span>
        <button class="eng-sql-btn eng-ai" id="btnAiSql" title="按表结构和这张卡的用途草拟一条 SQL">AI 生成</button>
        <button class="eng-sql-btn" id="btnSyncSql" title="真跑一次，把返回的列灌进输出列">同步</button>
      </div>
      <div class="eng-sql-wrap">
        <div class="eng-sql-hl" id="engSqlHl"></div>
        <textarea class="eng-sql" id="engSql" spellcheck="false"
          placeholder="SELECT status FROM payment_order WHERE pay_no = '{{payNo}}'">${engEsc(node.sql)}</textarea>
      </div>
    </div>
    <div class="eng-insp-label">输出列 <span class="eng-insp-sub">（后面条件与结论都按这些名字引用）</span></div>
    <div class="eng-cols">${cols || ''}</div>
    <button class="btn btn-sm" id="btnAddCol">加一个输出列</button>
    <div class="eng-insp-hint" id="engColHint"></div>`;
}
/** 这个节点能引用的东西: 入口字段 + 上游取数节点的输出列/行数 */
function engRefOptions(card, excludeId) {
  const out = [];
  for (const n of card.nodes) {
    if (n.id === excludeId) continue;
    if (n.type === 'input') {
      for (const f of (n.fields || [])) out.push({ ref: f.key, label: f.label || f.key, src: n.title || '入口' });
    } else if (n.type === 'query') {
      out.push({ ref: n.id + '.rowCount', label: '行数', src: n.title || n.id });
      for (const c of (n.outputs || [])) {
        if (c.key) out.push({ ref: n.id + '.' + c.key, label: c.label || c.key, src: n.title || n.id });
      }
    }
  }
  return out;
}
function engBindQuery(node) {
  const box = eq1('#engineInspector');
  const dbSel = eq1('#engDb', box);
  const tableInput = eq1('#engTable', box);
  const sqlArea = eq1('#engSql', box);
  const sqlHl = eq1('#engSqlHl', box);
  // SQL 里 {{}} 的候选就是"能引用的东西"。本节点的输入项不再单独加进来:
  // 它本来就是这上面的引用, 上游清单里已经有了; 而接不上的引用应该在 SQL 里标红,
  // 好让作者一眼看见哪一处没落地。
  const refsOf = () => engRefOptions(engState.card, node.id);
  const refreshDatalists = async () => {
    const t = eq1('[data-for="tables"]', box);
    if (t) {
      const names = node.databaseId ? await engTablesOf(node.databaseId) : [];
      t.innerHTML = names.map((n) => `<option value="${engEsc(n)}"></option>`).join('');
    }
    const f = eq1('[data-for="fields"]', box);
    if (f) {
      const fields = (node.databaseId && node.table) ? await engFieldsOf(node.databaseId, node.table) : [];
      f.innerHTML = fields.map((c) => `<option value="${engEsc(c.field)}">${engEsc(c.type || '')}</option>`).join('');
      const hint = eq1('#engColHint', box);
      if (hint) {
        hint.textContent = fields.length
          ? '这张表有 ' + fields.length + ' 个字段：' + fields.slice(0, 12).map((c) => c.field).join('、') + (fields.length > 12 ? ' …' : '')
          : (node.table ? '没读到字段清单，列名可以直接手敲。' : '');
      }
    }
  };
  /* ---- SQL 引用高亮: 认得的标蓝, 认不得的标红 ---- */
  const paint = () => {
    if (!sqlHl) return;
    const known = new Set(refsOf().map((r) => r.ref));
    const src = String(sqlArea.value || '');
    let html = '';
    const re = /\{\{\s*([^}]*?)\s*\}\}/g;
    let last = 0, m;
    while ((m = re.exec(src))) {
      html += engEsc(src.slice(last, m.index));
      const name = m[1];
      html += `<span class="${known.has(name) ? 'eng-sql-ref' : 'eng-sql-bad'}">{{${engEsc(name)}}}</span>`;
      last = m.index + m[0].length;
    }
    html += engEsc(src.slice(last));
    // 末尾补一个换行: textarea 最后一行是空的时, 高亮层也要占住那一行
    sqlHl.innerHTML = html + '\n';
    // 高度跟着内容走, 两层才严格重合 (textarea 自己不许滚)
    sqlArea.style.height = 'auto';
    // scrollHeight 含内边距不含边框, 而 box-sizing 是 border-box, 所以补上上下各 1px 边框
    sqlArea.style.height = Math.max(104, sqlArea.scrollHeight + 2) + 'px';
  };
  /* ---- 敲 {{ 时的补全: 候选来自这个画布里能引用到的东西 ---- */
  let pop = null;
  const closePop = () => { if (pop) { pop.remove(); pop = null; } };
  const insertRef = (ref) => {
    const v = sqlArea.value;
    const caret = sqlArea.selectionStart;
    const before = v.slice(0, caret);
    const open = before.lastIndexOf('{{');
    if (open < 0) { closePop(); return; }
    const after = v.slice(caret);
    sqlArea.value = before.slice(0, open) + '{{' + ref + '}}' + after;
    const pos = open + ref.length + 4;
    sqlArea.setSelectionRange(pos, pos);
    sqlArea.focus();
    closePop();
    node.sql = sqlArea.value;
    engTouch(); engValidate(); paint();
  };
  const openPop = (items, anchorTop) => {
    closePop();
    if (!items.length) return;
    pop = document.createElement('div');
    pop.className = 'eng-ref-pop';
    pop.innerHTML = items.map((r, i) =>
      `<div class="eng-ref-pop-item${i === 0 ? ' active' : ''}" data-ref="${engEsc(r.ref)}">
        <code>{{${engEsc(r.ref)}}}</code><span>${engEsc(r.label)}</span>
        <span class="eng-ref-pop-src">${engEsc(r.src)}</span>
      </div>`).join('');
    const wrap = eq1('.eng-sql-wrap', box);
    wrap.appendChild(pop);
    pop.style.top = Math.round(anchorTop) + 'px';
    eqAll('.eng-ref-pop-item', pop).forEach((el) => {
      // 用 mousedown 而不是 click: blur 会先把面板收掉
      el.addEventListener('mousedown', (ev) => { ev.preventDefault(); insertRef(el.dataset.ref); });
    });
  };
  sqlArea.addEventListener('input', () => {
    node.sql = sqlArea.value;
    engTouch(); engValidate(); paint();
    const before = sqlArea.value.slice(0, sqlArea.selectionStart);
    const open = before.lastIndexOf('{{');
    const closed = before.lastIndexOf('}}');
    if (open > closed) {
      const typed = before.slice(open + 2).trim().toLowerCase();
      const items = refsOf().filter((r) => !typed ||
        String(r.ref).toLowerCase().includes(typed) ||
        String(r.label).toLowerCase().includes(typed));
      openPop(items.slice(0, 8), 30 + (before.split('\n').length - 1) * 19.2);
    } else closePop();
  });
  sqlArea.addEventListener('blur', () => setTimeout(closePop, 160));
  sqlArea.addEventListener('keydown', (ev) => {
    if (!pop) return;
    const items = eqAll('.eng-ref-pop-item', pop);
    if (!items.length) return;
    const idx = items.findIndex((el) => el.classList.contains('active'));
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const next = ev.key === 'ArrowDown' ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
      items.forEach((el, i) => el.classList.toggle('active', i === next));
      return;
    }
    if (ev.key === 'Enter' || ev.key === 'Tab') {
      ev.preventDefault();
      insertRef(items[Math.max(0, idx)].dataset.ref);
      return;
    }
    if (ev.key === 'Escape') { ev.preventDefault(); closePop(); }
  });
  /* ---- AI 生成 ---- */
  const aiBtn = eq1('#btnAiSql', box);
  if (aiBtn) aiBtn.addEventListener('click', async () => {
    if (engState.aiBusy) return;
    if (!node.databaseId || !node.table) { engToast('先把库和表选上，AI 才知道看哪张表的字段', 'err'); return; }
    engState.aiBusy = true;
    const old = aiBtn.textContent;
    aiBtn.disabled = true; aiBtn.textContent = '生成中…';
    try {
      const upstream = engRefOptions(engState.card, node.id).map((r) => `${r.ref}（${r.label}，来自${r.src}）`);
      const r = await window.bridge.engine.aiSql({
        dbId: node.databaseId,
        table: node.table,
        engineName: engState.card.name,
        description: engState.card.description,
        examples: engState.card.examples,
        existingSql: sqlArea.value.trim() || '',
        fields: node.fields || [],
        upstream
      });
      if (!r || !r.ok) { engToast('生成失败：' + ((r && r.error) || '未知原因'), 'err'); return; }
      sqlArea.value = r.sql;
      node.sql = r.sql;
      engTouch(); engValidate(); paint();
      engToast('SQL 草拟好了，看一眼再存', 'ok');
    } catch (e) {
      engToast('生成失败：' + ((e && e.message) || e), 'err');
    } finally {
      engState.aiBusy = false;
      aiBtn.disabled = false; aiBtn.textContent = old;
    }
  });
  /* ---- 同步: 真跑一次取回列名, 灌进输出列 ---- */
  const syncBtn = eq1('#btnSyncSql', box);
  if (syncBtn) syncBtn.addEventListener('click', async () => {
    if (engState.syncBusy) return;
    if (!node.databaseId || !node.table) { engToast('先把库和表选上，同步要用', 'err'); return; }
    if (!sqlArea.value.trim()) { engToast('SQL 还是空的', 'err'); return; }
    engState.syncBusy = true;
    const old = syncBtn.textContent;
    syncBtn.disabled = true; syncBtn.textContent = '同步中…';
    try {
      const r = await window.bridge.engine.syncSql({ dbId: node.databaseId, sql: sqlArea.value });
      if (!r || !r.ok) { engToast('同步失败：' + ((r && r.error) || '未知原因'), 'err'); return; }
      const cols = r.columns || [];
      if (!cols.length) { engToast('这条 SQL 没跑出列名，检查一下语句', 'warn'); return; }
      // 合并而不是覆盖: 已经填过的中文名保留, 只补缺的列
      const byKey = new Map((node.outputs || []).map((c) => [c.key, c]));
      const dropped = Array.from(byKey.keys()).filter((k) => cols.indexOf(k) < 0);
      node.outputs = cols.map((k) => {
        const had = byKey.get(k);
        return { key: k, label: (had && had.label) || k };
      });
      engTouch(); engValidate();
      renderEngineInspector();
      engToast(`同步完成：${cols.length} 个输出列${dropped.length ? `，去掉了 ${dropped.length} 个对不上的` : ''}`, 'ok');
    } catch (e) {
      engToast('同步失败：' + ((e && e.message) || e), 'err');
    } finally {
      engState.syncBusy = false;
      syncBtn.disabled = false; syncBtn.textContent = old;
    }
  });
  /* ---- 库 / 表 ---- */
  dbSel.addEventListener('change', () => {
    node.databaseId = dbSel.value;
    engTouch(); engValidate();
    refreshDatalists();
    renderEngineCanvas();
  });
  tableInput.addEventListener('input', () => {
    const v = tableInput.value.trim();
    if (v !== node.table) {
      node.table = v;
      engTouch(); engValidate();
      if (!v) renderEngineCanvas();
    }
    refreshDatalists();
  });
  tableInput.addEventListener('change', () => { node.table = tableInput.value.trim(); engTouch(); renderEngineCanvas(); });
  /* ---- 输出列 ---- */
  eqAll('[data-col-row]', box).forEach((row) => {
    const i = Number(row.dataset.colRow);
    eqAll('[data-c]', row).forEach((el) => {
      el.addEventListener('input', () => {
        const c = (node.outputs || [])[i];
        if (!c) return;
        c[el.dataset.c] = el.value;
        engTouch(); engValidate();
      });
    });
  });
  eqAll('[data-cdel]', box).forEach((b) => b.addEventListener('click', () => {
    node.outputs.splice(Number(b.dataset.cdel), 1);
    engTouch(); renderEngineCanvas(); renderEngineInspector(); engValidate();
  }));
  const addCol = eq1('#btnAddCol', box);
  if (addCol) addCol.addEventListener('click', () => {
    node.outputs = node.outputs || [];
    node.outputs.push({ key: '', label: '' });
    engTouch(); renderEngineInspector(); engValidate();
  });
  engBindQueryRefs(node, engRefOptions(engState.card, node.id), () => { paint(); renderEngineCanvas(); });
  refreshDatalists();
  paint();
}
/* ---- 条件节点 ---- */
function engInspCondition(node) {
  const card = engState.card;
  const refs = engRefOptions(card, node.id);
  const refList = `<datalist id="engRefList">${refs.map((r) => `<option value="${engEsc(r.ref)}">${engEsc(r.label)}</option>`).join('')}</datalist>`;
  const expr = node.expr || { type: 'group', logic: 'and', items: [] };
  const items = expr.items || [];
  const opOpts = (cur) => ENG_CMP.map(([v, t]) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${t}</option>`).join('');
  const rows = items.map((item, i) => {
    if (item.type === 'group') {
      return `<div class="eng-rule eng-rule-group" data-rule-row="${i}">
        <span class="eng-rule-group-tag">子组（${item.logic === 'or' ? '任一成立' : '全部成立'}）</span>
        <button class="eng-f-del" data-rdel="${i}" title="删掉">×</button>
      </div>`;
    }
    return `<div class="eng-rule" data-rule-row="${i}">
      <input class="eng-r-left" type="text" data-r="left" list="engRefList" value="${engEsc(item.left || '')}" placeholder="引用" />
      <select class="eng-r-op" data-r="op">${opOpts(item.op)}</select>
      <input class="eng-r-right" type="text" data-r="right" value="${engEsc(item.right || '')}"
        placeholder="值" ${['empty', 'notEmpty'].indexOf(item.op) >= 0 ? 'disabled' : ''} />
      <button class="eng-f-del" data-rdel="${i}" title="删掉">×</button>
    </div>`;
  }).join('');
  const refHelp = refs.slice(0, 10)
    .map((r) => `<span class="eng-ref-token">{{${engEsc(r.ref)}}}</span> <span class="eng-ref-name">${engEsc(r.label)}</span> <span class="eng-ref-from">· ${engEsc(r.src)}</span>`)
    .join('<br>');
  return `
    ${refList}
    <div class="eng-insp-label">这些条件 <select class="eng-input eng-logic" id="engLogic">
      <option value="and" ${expr.logic !== 'or' ? 'selected' : ''}>全部成立</option>
      <option value="or" ${expr.logic === 'or' ? 'selected' : ''}>任一成立</option>
    </select></div>
    <div class="eng-rules">${rows}</div>
    <button class="btn btn-sm" id="btnAddRule">加一条条件</button>
    ${refHelp ? `<div class="eng-insp-hint eng-ref-help">能引用的东西：<br>${refHelp}</div>` : ''}`;
}
function engBindCondition(node) {
  const box = eq1('#engineInspector');
  if (!node.expr) node.expr = { type: 'group', logic: 'and', items: [] };
  if (!Array.isArray(node.expr.items)) node.expr.items = [];
  const logic = eq1('#engLogic', box);
  if (logic) logic.addEventListener('change', () => {
    node.expr.logic = logic.value; engTouch(); renderEngineCanvas(); engValidate();
  });
  eqAll('[data-rule-row]', box).forEach((row) => {
    const i = Number(row.dataset.ruleRow);
    eqAll('[data-r]', row).forEach((el) => {
      const handler = () => {
        const item = node.expr.items[i];
        if (!item || item.type === 'group') return;
        item[el.dataset.r] = el.value;
        if (el.dataset.r === 'op') {
          renderEngineInspector();
        }
        engTouch(); renderEngineCanvas(); engValidate();
      };
      el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', handler);
    });
  });
  eqAll('[data-rdel]', box).forEach((b) => b.addEventListener('click', () => {
    node.expr.items.splice(Number(b.dataset.rdel), 1);
    engTouch(); renderEngineCanvas(); renderEngineInspector(); engValidate();
  }));
  const add = eq1('#btnAddRule', box);
  if (add) add.addEventListener('click', () => {
    node.expr.items.push({ type: 'cmp', left: '', op: '==', right: '' });
    engTouch(); renderEngineCanvas(); renderEngineInspector(); engValidate();
  });
}
/* ---- 输出节点 ---- */
function engInspOutput(node) {
  const card = engState.card;
  const refs = engRefOptions(card, node.id);
  const refList = `<datalist id="engRefList">${refs.map((r) => `<option value="${engEsc(r.ref)}">${engEsc(r.label)}</option>`).join('')}</datalist>`;
  const refHelp = refs
    .map((r) => `<span class="eng-ref-token">{{${engEsc(r.ref)}}}</span> <span class="eng-ref-name">${engEsc(r.label)}</span> <span class="eng-ref-from">· ${engEsc(r.src)}</span>`)
    .join('<br>');
  return `
    ${refList}
    <textarea class="eng-input eng-sql" id="engTemplate" rows="5"
      placeholder="付款单 {{payNo}} 报错原因: {{n_q2.reason}}">${engEsc(node.template)}</textarea>
    <div class="eng-insp-label">可以引用</div>
    ${refHelp ? `<div class="eng-insp-hint eng-ref-help">${refHelp}</div>` : ''}`;
}
function engBindOutput(node) {
  const box = eq1('#engineInspector');
  const ta = eq1('#engTemplate', box);
  if (ta) ta.addEventListener('input', () => { node.template = ta.value; engTouch(); renderEngineCanvas(); engValidate(); });
}
/* ==================== 初始化 ==================== */
/**
 * 自动保存的兜底钩子。只挂一次。
 *
 * blur: 用户切到别的应用 (常常下一步就是关窗), 这时候先把待保存的落盘。
 *       比 beforeunload 早, 而且还能 await。
 * beforeunload: 关窗那一下。异步来不及, 走同步 IPC 挡一次。
 */
function engBindAutoSaveGuards() {
  if (engState.autoSaveGuarded) return;
  engState.autoSaveGuarded = true;
  window.addEventListener('blur', () => {
    if (engState.card && engState.rev !== engState.savedRev) engFlushAutoSave();
  });
  window.addEventListener('beforeunload', () => {
    engFlushOnUnload();
  });
}
async function initEngines() {
  if (!eq1('#engineGalleryGrid')) return;
  engBindFab();
  engBindAi();
  engBindCanvasEvents();
  engBindAutoSaveGuards();
  // AI 搭建的事件流 (一步一步把图画出来)
  if (window.bridge.engine.onAiEvent && !engState.aiSubscribed) {
    engState.aiSubscribed = true;
    window.bridge.engine.onAiEvent(engAiHandleEvent);
  }
  engBindIssuesDock();
  engBindCfgModal();
  engBindTestModal();
  const cfgSync = eq1('#btnEngCfgSync');
  if (cfgSync && !cfgSync.dataset.bound) {
    cfgSync.dataset.bound = '1';
    cfgSync.addEventListener('click', () => engSyncConfigClick(cfgSync));
  }
  const back = eq1('#btnBackGallery');
  if (back && !back.dataset.bound) {
    back.dataset.bound = '1';
    back.addEventListener('click', engBackToGallery);
  }
  await loadEngines(true);
  // 进页面就重新读一遍库表配置。用户常常先去「数据库」页加库勾表, 再切回这里,
  // 读缓存的话新加的库表在这页看不见 —— 页头那个「同步」按钮是同一件事的手动入口,
  // 留给「这一页已经开着、去别处改了配置」的情况。
  await engSyncConfig();
  engBindCardPack();
  // 切回来时如果本来就开着一张卡, 直接回画板
  if (engState.card && engState.currentId) {
    engShowView('board');
    renderEngineHead();
    renderEngineCanvas();
    renderEngineInspector();
    requestAnimationFrame(() => { engFitIfNeeded(); });
    return;
  }
  engShowView('gallery');
  renderEngineGallery();
}
/* ==================== 流程卡导入导出 (卡包) ==================== *
 * 格式与全部判断都在 lib/cardpack.js, 这里只做界面:
 *   导出 —— 挑几张卡 → 主进程弹另存为
 *   导入 —— 选文件 → 主进程解析 → 这个弹窗做预览 (库怎么对应、同名怎么办) → 落盘
 *
 * 为什么预览这一步不能省: 流程卡里写死了"连哪个库", 而库 id 每台机器都不一样。
 * 直接落盘的话, 对方拿到的是一张永远跑不出结果的卡, 而且界面上不会报任何错。
 * 所以导入前必须把三件事摆给用户看: 卡包里带的是哪些库、它们对到了本机哪个库、
 * 同名卡是要覆盖还是跳过。
 */
const CPK = window.SoloCardPack || null;
// 弹窗打开期间的状态。null = 没开。
let cpkState = null;
function cpkEl(id) { return eq1('#' + id); }
function cpkOpen() {
  const modal = cpkEl('modalCardPack');
  if (modal) modal.hidden = false;
}
function cpkClose() {
  const modal = cpkEl('modalCardPack');
  if (modal) modal.hidden = true;
  cpkState = null;
}
function engBindCardPack() {
  const modal = cpkEl('modalCardPack');
  if (!modal || modal.dataset.bound) return;
  modal.dataset.bound = '1';
  eqAll('[data-cpk-close]', modal).forEach((el) => el.addEventListener('click', cpkClose));
  const ok = cpkEl('cpkOk');
  if (ok) ok.addEventListener('click', () => (cpkState && cpkState.mode === 'export' ? cpkDoExport() : cpkDoImport()));
  const imp = eq1('#btnEngImport');
  if (imp) imp.addEventListener('click', engImportOpen);
  const exp = eq1('#btnEngExport');
  if (exp) exp.addEventListener('click', () => engExportOpen());
}
/* ---------- 导出 ---------- */
async function engExportOpen(preIds) {
  if (!CPK) { engToast('流程卡包模块没加载上', 'err'); return; }
  await loadEngines();
  await engConfig();
  const cards = engState.engines || [];
  if (!cards.length) { engToast('这台机器上还没有流程卡', 'err'); return; }
  // 从单张卡的「导出」进来的话, 只勾那一张
  const pre = Array.isArray(preIds) ? preIds.filter(Boolean) : null;
  cpkState = {
    mode: 'export',
    ids: new Set(pre && pre.length ? pre : cards.map((c) => c.id))
  };
  cpkRenderExport();
  cpkOpen();
}
function cpkRenderExport() {
  const cards = engState.engines || [];
  const picked = cards.filter((c) => cpkState.ids.has(c.id));
  // 卡包里会带几个库 —— 选中项变了它就该跟着变, 所以每次重画都算一遍
  const dbIds = new Set();
  for (const c of picked) for (const id of CPK.collectDbIds(c)) dbIds.add(id);
  cpkEl('cpkTitle').textContent = '导出流程卡';
  eq1('#cpkOk').textContent = '导出…';
  eq1('#cpkFootNote').textContent = '';
  const rows = cards.map((c) => {
    const st = CPK.cardStats(c);
    return `<label class="cpk-item">
      <input type="checkbox" data-pick="${engEsc(c.id)}"${cpkState.ids.has(c.id) ? ' checked' : ''} />
      <span class="cpk-main">
        <span class="cpk-name">${engEsc(st.name)}${st.enabled ? '' : '<span class="cpk-off">已停用</span>'}</span>
        <span class="cpk-desc">${engEsc(st.description || '（还没写用途说明）')}</span>
      </span>
      <span class="cpk-meta">${st.nodes} 节点 · ${st.queries} 取数 · ${st.dbIds.length} 库</span>
    </label>`;
  }).join('');
  cpkEl('cpkBody').innerHTML = `
    <p class="cpk-lead">选中的卡会打成一个 JSON 卡包（<code>*.solodb-cards.json</code>），
      对方在「流程引擎」页点「导入」就能用。</p>
    <div class="cpk-note">
      卡包里<b>不带数据库口令和用户名</b> —— 只记下「这些卡连的是哪个库」（类型 / 地址 / 端口 / 库名）。
      对方导入时按这份说明认到他自己的库上，认不出的会让他手工指认。
    </div>
    <div class="cpk-bar">
      <label class="cpk-check"><input type="checkbox" id="cpkAll" /> 全选</label>
      <span class="cpk-count" id="cpkCount"></span>
    </div>
    <div class="cpk-list">${rows}</div>`;
  const all = eq1('#cpkAll');
  all.checked = picked.length === cards.length;
  all.indeterminate = picked.length > 0 && picked.length < cards.length;
  all.addEventListener('change', () => {
    cpkState.ids = new Set(all.checked ? cards.map((c) => c.id) : []);
    cpkRenderExport();
  });
  eqAll('[data-pick]').forEach((el) => el.addEventListener('change', () => {
    if (el.checked) cpkState.ids.add(el.dataset.pick);
    else cpkState.ids.delete(el.dataset.pick);
    cpkRenderExport();
  }));
  eq1('#cpkCount').textContent = picked.length
    ? `已选 ${picked.length} 张 · 会带上 ${dbIds.size} 个库的连接说明`
    : '一张都没选';
  const ok = eq1('#cpkOk');
  ok.disabled = !picked.length;
  ok.textContent = picked.length === 1 ? '导出这张卡' : `导出 ${picked.length} 张`;
}
async function cpkDoExport() {
  if (!cpkState || cpkState.mode !== 'export' || cpkState.busy) return;
  const ids = Array.from(cpkState.ids);
  if (!ids.length) return;
  cpkState.busy = true;
  const ok = eq1('#cpkOk');
  ok.disabled = true;
  ok.textContent = '导出中…';
  try {
    const r = await window.bridge.engine.exportPack({ ids });
    if (!r || !r.ok) {
      if (r && r.canceled) { ok.disabled = false; cpkRenderExport(); return; }
      engToast('导出失败: ' + ((r && r.error) || '未知错误'), 'err');
      ok.disabled = false;
      cpkRenderExport();
      return;
    }
    cpkClose();
    engToast(`已导出 ${r.count} 张流程卡（含 ${r.databases} 个库的连接说明）`, 'ok');
  } catch (e) {
    engToast('导出失败: ' + ((e && e.message) || e), 'err');
    ok.disabled = false;
    cpkRenderExport();
  } finally {
    if (cpkState) cpkState.busy = false;
  }
}
/* ---------- 导入 ---------- */
async function engImportOpen() {
  if (!CPK) { engToast('流程卡包模块没加载上', 'err'); return; }
  await engConfig();
  let r;
  try {
    r = await window.bridge.engine.pickPack();
  } catch (e) {
    engToast('读取失败: ' + ((e && e.message) || e), 'err');
    return;
  }
  if (!r || !r.ok) {
    if (r && r.canceled) return;
    engToast((r && r.error) || '没有可导入的卡包', 'err');
    return;
  }
  // 一个文件都没解析成功时, 把每个文件的原因都说清楚 —— 只说"导入失败"
  // 等于让用户自己猜是不是选错了文件
  if (!r.packs.length) {
    const detail = (r.errors || []).map((e) => `${e.fileName}: ${e.error}`).join('\n');
    engToast('这些文件都读不了 —— ' + detail, 'err');
    return;
  }
  cpkState = {
    mode: 'import',
    packs: r.packs,
    errors: r.errors || [],
    overrides: {},       // 来源库 id -> 本机库 id (用户手工指认的)
    strategy: 'skip',
    unpicked: new Set()  // 被用户取消勾选的卡 (key = packIdx:cardIdx)
  };
  cpkRenderImport();
  cpkOpen();
}
/** 把所有卡包里的卡摊平, 每张都算好"换成本机库 id 之后长什么样" */
function cpkImportRows() {
  const locals = engDatabases();
  const rows = [];
  for (let pi = 0; pi < cpkState.packs.length; pi++) {
    const p = cpkState.packs[pi];
    const map = CPK.buildMatchMap(p.pack, locals, cpkState.overrides);
    for (let ci = 0; ci < p.pack.cards.length; ci++) {
      const key = pi + ':' + ci;
      const remapped = CPK.remapCard(p.pack.cards[ci], map);
      rows.push({
        key,
        fileName: p.fileName,
        card: remapped.card,
        missing: remapped.missing,
        // 没指定库的卡默认不勾 —— 导进来也是一张跑不动的卡
        picked: remapped.missing.length ? false : !cpkState.unpicked.has(key)
      });
    }
  }
  return rows;
}
/** 所有卡包引用到的库 + 它们对到了本机哪个库 */
function cpkDbRows() {
  const locals = engDatabases();
  const seen = new Map();
  for (const p of cpkState.packs) {
    const map = CPK.buildMatchMap(p.pack, locals, cpkState.overrides);
    for (const key of Object.keys(map)) if (!seen.has(key)) seen.set(key, map[key]);
  }
  return Array.from(seen.values());
}
function cpkRenderImport() {
  const rows = cpkImportRows();
  const plan = CPK.planImport({
    cards: rows.map((r) => r.card),
    localEngines: engState.engines || [],
    strategy: cpkState.strategy
  });
  const locals = engDatabases();
  cpkEl('cpkTitle').textContent = '导入流程卡';
  eq1('#cpkOk').textContent = '导入…';
  // ---- 库对应关系 ----
  const dbs = cpkDbRows();
  const dbHtml = dbs.length ? `
    <div class="cpk-sec">库对应关系</div>
    <div class="cpk-dbs">
      ${dbs.map((d) => {
        const pd = d.packDb;
        const label = pd.missing || !pd.fingerprint
          ? `${engEsc(pd.id)} <span class="cpk-warn">来源机器上也没有这个库</span>`
          : `${engEsc(CPK.dbLabel(pd))}`;
        const how = d.how === 'exact' ? '<span class="cpk-tag ok">地址一致</span>'
          : d.how === 'manual' ? '<span class="cpk-tag manual">手工指定</span>'
            : d.how === 'name' ? '<span class="cpk-tag warn">仅名字相同</span>'
              : '<span class="cpk-tag err">没认出来</span>';
        const opts = ['<option value="">— 不指定 —</option>'].concat(
          locals.map((l) => `<option value="${engEsc(l.id)}"${d.localId === l.id ? ' selected' : ''}>${engEsc(l.name || l.database || l.id)}</option>`)
        ).join('');
        return `<div class="cpk-dbrow">
          <span class="cpk-dbsrc" title="${engEsc(pd.host ? pd.host + ':' + pd.port + '/' + pd.database : pd.database)}">${label}</span>
          <span class="cpk-arrow">→</span>
          <select class="cpk-dbsel" data-packdb="${engEsc(pd.id)}">${opts}</select>
          ${how}
        </div>`;
      }).join('')}
    </div>` : '';
  const unmapped = dbs.filter((d) => !d.localId).length;
  const needMap = unmapped ? `
    <div class="cpk-note warn">
      有 ${unmapped} 个库没认出来。<b>先把它们指到本机的一个库</b>，依赖这些库的卡才能导入 ——
      否则导进来也是一张跑不出结果的卡。
    </div>` : '';
  // ---- 同名卡策略 ----
  const conflicts = plan.filter((p) => p.conflictWith).length;
  const stratHtml = `
    <div class="cpk-sec">同名卡怎么处理${conflicts ? `<span class="cpk-sub">本机有 ${conflicts} 张会撞上</span>` : ''}</div>
    <div class="cpk-radios">
      <label><input type="radio" name="cpkStrategy" value="skip"${cpkState.strategy === 'skip' ? ' checked' : ''} />
        <span><b>跳过同名</b><em>本机已有的那张不动，只导入新的</em></span></label>
      <label><input type="radio" name="cpkStrategy" value="overwrite"${cpkState.strategy === 'overwrite' ? ' checked' : ''} />
        <span><b>覆盖同名</b><em>用卡包里的替换本机那张（对方的版本为准）</em></span></label>
      <label><input type="radio" name="cpkStrategy" value="copy"${cpkState.strategy === 'copy' ? ' checked' : ''} />
        <span><b>都存成新卡</b><em>谁都不动，导入的卡名字后面加「(导入)」</em></span></label>
    </div>`;
  // ---- 卡清单 ----
  const actionText = {
    add: '<span class="cpk-act add">新增</span>',
    skip: '<span class="cpk-act skip">跳过</span>',
    overwrite: '<span class="cpk-act ovr">覆盖</span>',
    copy: '<span class="cpk-act copy">存为新卡</span>'
  };
  const listHtml = rows.map((r, i) => {
    const p = plan[i];
    const st = CPK.cardStats(r.card);
    const blocked = r.missing.length > 0;
    const on = r.picked && !blocked;
    const why = blocked
      ? `<span class="cpk-warn">依赖 ${r.missing.length} 个本机没有的库，先在上面指定</span>`
      : (p.conflictWith ? `<span class="cpk-muted">本机已有「${engEsc(p.conflictWith.name)}」</span>` : '');
    return `<label class="cpk-item${blocked ? ' cpk-blocked' : ''}">
      <input type="checkbox" data-row="${r.key}"${on ? ' checked' : ''}${blocked ? ' disabled' : ''} />
      <span class="cpk-main">
        <span class="cpk-name">${engEsc(st.name)}</span>
        <span class="cpk-desc">${engEsc(st.description || '（没有用途说明）')}</span>
        ${why ? `<span class="cpk-why">${why}</span>` : ''}
      </span>
      <span class="cpk-meta">${st.nodes} 节点 · ${st.queries} 取数</span>
      ${on ? actionText[p.action] : ''}
    </label>`;
  }).join('');
  const errHtml = cpkState.errors.length
    ? `<div class="cpk-note warn">这些文件没读进来：${cpkState.errors.map((e) => `${engEsc(e.fileName)}（${engEsc(e.error)}）`).join('；')}</div>`
    : '';
  const fromFiles = cpkState.packs.map((p) => p.fileName).join('、');
  cpkEl('cpkBody').innerHTML = `
    <p class="cpk-lead">来自 <b>${engEsc(fromFiles)}</b> 的 ${rows.length} 张卡。
      导入的卡会直接注册进来，之后在对话里就能命中。</p>
    ${errHtml}
    ${dbHtml}
    ${needMap}
    ${stratHtml}
    <div class="cpk-sec">要导入的卡<span class="cpk-sub">共 ${rows.length} 张</span></div>
    <div class="cpk-list">${listHtml}</div>`;
  // ---- 交互 ----
  eqAll('[data-packdb]').forEach((sel) => sel.addEventListener('change', () => {
    const key = sel.dataset.packdb;
    if (sel.value) cpkState.overrides[key] = sel.value;
    else delete cpkState.overrides[key];
    cpkRenderImport();
  }));
  eqAll('input[name="cpkStrategy"]').forEach((el) => el.addEventListener('change', () => {
    cpkState.strategy = el.value;
    cpkRenderImport();
  }));
  eqAll('[data-row]').forEach((el) => el.addEventListener('change', () => {
    if (el.checked) cpkState.unpicked.delete(el.dataset.row);
    else cpkState.unpicked.add(el.dataset.row);
    cpkRenderImport();
  }));
  const pickedCount = rows.filter((r, i) => r.picked && !r.missing.length).length;
  const willWrite = plan.filter((p, i) => rows[i].picked && !rows[i].missing.length && p.action !== 'skip').length;
  eq1('#cpkFootNote').textContent = pickedCount ? `已选 ${pickedCount} 张 · 会写入 ${willWrite} 张` : '一张都没选';
  eq1('#cpkOk').disabled = !willWrite;
  eq1('#cpkOk').textContent = willWrite ? `导入 ${willWrite} 张` : '导入';
}async function cpkDoImport() {
  if (!cpkState || cpkState.mode !== 'import' || cpkState.busy) return;
  const rows = cpkImportRows();
  const plan = CPK.planImport({
    cards: rows.map((r) => r.card),
    localEngines: engState.engines || [],
    strategy: cpkState.strategy
  });
  const cards = [];
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i].picked || rows[i].missing.length) continue;
    const p = plan[i];
    if (p.action === 'skip') continue;
    // plan 决定落到哪个 id 上 (覆盖同名时用的是本机那张卡的 id, 另存为新卡时是新 id)
    cards.push(Object.assign({}, p.card, { id: p.targetId, name: p.targetName }));
  }
  if (!cards.length) { engToast('没有要导入的卡', 'err'); return; }
  cpkState.busy = true;
  const ok = eq1('#cpkOk');
  ok.disabled = true;
  ok.textContent = '导入中…';
  try {
    const r = await window.bridge.engine.applyImport({ cards });
    if (!r || !r.ok) {
      engToast('导入失败: ' + ((r && r.error) || '未知错误'), 'err');
      ok.disabled = false;
      cpkRenderImport();
      return;
    }
    cpkClose();
    await loadEngines(true);
    renderEngineGallery();
    const parts = [];
    if (r.added) parts.push(`新增 ${r.added} 张`);
    if (r.updated) parts.push(`更新 ${r.updated} 张`);
    engToast('已导入 · ' + (parts.join(' / ') || '没有变化'), 'ok');    // 导进来的卡里有填得不完整的, 单独说一声 —— 它们在来源机器上就是这样存的,
    // 不说的话用户会以为是导入弄坏了
    if (r.incomplete && r.incomplete.length) {
      const names = r.incomplete.map((x) => x.name).join('、');
      engToast(`有 ${r.incomplete.length} 张卡不完整（${names}），打开画板补一下才能跑`, 'err');
    }
  } catch (e) {
    engToast('导入失败: ' + ((e && e.message) || e), 'err');
    ok.disabled = false;
    cpkRenderImport();
  } finally {
    if (cpkState) cpkState.busy = false;
  }}
