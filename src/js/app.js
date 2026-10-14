// ============== Askaha Renderer ==============
// 通过 window.api (preload) 与主进程通信

// 全局错误捕获: 即使 init 失败也能给用户看
const diag = (msg) => {
  try {
    console.log('[diag]', msg);
    const el = document.getElementById('diag');
    if (el) {
      el.textContent = 'diag: ' + msg;
      el.style.background = msg.startsWith('err') ? '#fecaca' : (msg.includes('ready') || msg.includes('ok') ? '#bbf7d0' : '#fde68a');
    }
    document.title = 'Askaha · ' + msg;
  } catch (e) {}
};
diag('script-loaded');

function showFatalError(msg) {
  try {
    let bar = document.getElementById('fatalBar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'fatalBar';
      bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#b91c1c;color:#fff;padding:12px 18px;font-family:ui-monospace,Consolas,monospace;font-size:12.5px;white-space:pre-wrap;box-shadow:0 4px 12px rgba(0,0,0,.2);max-height:50vh;overflow:auto;';
      document.body.appendChild(bar);
    }
    bar.textContent = '[FATAL] ' + msg;
  } catch (e) {
    document.title = '[FATAL] ' + msg;
  }
}
window.addEventListener('error', (e) => {
  showFatalError(e.message + '\n' + (e.filename || '') + ':' + (e.lineno || '') + ':' + (e.colno || ''));
});
window.addEventListener('unhandledrejection', (e) => {
  showFatalError('Unhandled promise rejection: ' + (e.reason && e.reason.message || e.reason));
});

const api = window.bridge;
diag('api=' + (api ? 'ok' : 'undefined'));
if (!api) {
  showFatalError('window.bridge 未定义, preload 可能未生效。请检查 preload.js 是否被正确加载。');
}

/**
 * 表选择模式的存储键。
 *
 * **必须声明在 state 前面。** state 初始化时会调 loadTableMode() 读它, 而 const
 * 声明虽然会被提升, 但在求值之前处于暂时性死区 —— 那时访问它会抛 ReferenceError。
 * loadTableMode 自带 try/catch 兜底, 于是异常被静默吃掉、直接返回默认值 'manual',
 * 表现就是"切到自动模式、重启后又变回手动", 而 localStorage 里明明存着 'auto'。
 * 这个坑很隐蔽: 没有任何报错, 只是偏好永远不生效。
 */
const TABLE_MODE_KEY = 'solodb.tableMode';

let state = {
  config: null,
  conversation: [], // { role, content, steps, report }
  running: false,
  activeConversationId: null,
  // 本会话智能体的"记忆": 已确认的表/字段 + 已查过的结果编号。
  // 每轮任务结束后由主进程回传并保存在这里, 下一轮原样传回去,
  // 让它在"同一件事继续说"时直接接着干, 而不是重新查表写 SQL。
  agentState: null,
  conversations: [],   // 历史对话索引 (来自 store)
  artifacts: [],       // 当前对话的产物清单
  activeArtifactId: null,
  artGroup: 'data',     // 产物侧栏当前停在哪个分组 (原始表 / 报告)
  rightCollapsed: false,
  navCollapsed: false,
  convExpanded: false,  // 侧边栏的历史对话是否已展开到全部 (默认只露 5 条)
  configTab: null,      // 「配置」上次停留在哪个子页 (数据库/流程引擎/技能/外部工具)
  // 本会话的 token 累计 (落盘在 conv.stats) 与上下文占用 (落盘在消息的 ctx 上)。
  // 两者语义不同: 前者是"一共花了多少", 后者是"最近一次提示词多大"。
  convUsage: { input: 0, output: 0, calls: 0 },
  convCtx: 0,
  // 表选择模式: 'manual' 每次问用户 / 'auto' AI 自己挑。见 renderModePick 上面那段注释。
  tableMode: loadTableMode(),
  // 这段对话检索哪些知识库 (多选; 空 = 用「知识库配置」里的默认库)。传给 search_knowledge。
  kbIds: [],
  // 这段对话只在哪些库里找表 (库 id 数组)。空数组 = 不限制, 所有勾过表的库都能查。
  // 约束的是**通用分析**; 流程卡有自己的一套表范围, 不读这个字段。
  //
  // 选库其实是**三个**状态, 而 dbIds 只能表达其中两个, 所以多了个 dbNone:
  //   dbIds = [id, ...]             -> 只查这几个库
  //   dbIds = [] 且 dbNone = false  -> 全部 (不限制)
  //   dbIds = [] 且 dbNone = true   -> 一个都不选
  //
  // 第三个状态为什么必须存在: 菜单顶上的「全部数据库」是总开关, 再点一次要能全取消
  // (见 fillDbMenu)。少了它, 用户想"只查某一个库"就只能把其它库逐个点掉 ——
  // 而初始状态本来就是全选, 那等于没有入口。
  //
  // 所以判断"是不是全部"一律走 dbPickAll(), 不要直接看 dbIds.length:
  // 空数组现在有两种含义, 直接看长度会把"一个都没选"当成"全选"。
  dbIds: [],
  dbNone: false,
  wbWidths: { right: 400 }
};

// 三栏宽度、右栏与左侧菜单的收起状态存本地, 下次打开保持原样
const WB_KEY = 'solodb.workbench';
function loadWbPrefs() {
  try {
    const raw = localStorage.getItem(WB_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      // 只回填 state 里还存在的键。不能整个 merge —— 否则老版本留下来的
      // 废弃键 (比如左栏的 left) 会被一并吃进来, 又在 saveWbPrefs 时写回去,
      // 永远清不掉。
      if (p.widths) {
        for (const k of Object.keys(state.wbWidths)) {
          if (typeof p.widths[k] === 'number') state.wbWidths[k] = p.widths[k];
        }
      }
      if (typeof p.rightCollapsed === 'boolean') state.rightCollapsed = p.rightCollapsed;
      if (typeof p.navCollapsed === 'boolean') state.navCollapsed = p.navCollapsed;
    }
  } catch (e) {}
}
function saveWbPrefs() {
  try {
    localStorage.setItem(WB_KEY, JSON.stringify({
      widths: state.wbWidths,
      rightCollapsed: state.rightCollapsed,
      navCollapsed: state.navCollapsed
    }));
  } catch (e) {}
}

/** 左侧菜单收起/展开。折叠态只是 .app 上的一个类, 具体长什么样全在 CSS 里。 */
function setNavCollapsed(v) {
  state.navCollapsed = !!v;
  const app = document.querySelector('.app');
  if (app) app.classList.toggle('nav-collapsed', state.navCollapsed);
  const btn = $('btnNavCollapse');
  if (btn) btn.title = state.navCollapsed ? '展开菜单' : '收起菜单';
  saveWbPrefs();
}

// 对话流的 DOM 节点缓存, 与 state.conversation 同序。
// 有了它才能做增量渲染: 智能体每产生一个事件不必重建整个会话,
// 报告卡片里的 iframe 也就不会反复重载。
let chatNodes = [];

// 本次任务待落盘的 token 用量增量。
//
// 为什么是"增量"而不是"总量": 落盘那侧做的是累加 (lib/store.js 的 saveMessages),
// 每次送总量过去会越加越多。而那种错在界面上看不出来 —— 数字一直在涨, 看着像
// "用得多", 要等到对账单才会发现。
//
// 声明在这儿 (而不是挨着用它的函数) 是因为它在好几处被读写: 发任务时写入、
// 落盘成功后清掉、切换/删除对话时清空。放在其中一处会让另外几处踩到 let 的
// 暂时性死区 —— 那是个运行时才炸、而且只在特定操作顺序下才炸的坑。
let pendingStats = null;

const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

// ============== Init ==============
init().catch((e) => {
  showFatalError('初始化失败: ' + (e && e.stack || e));
});

async function init() {
  if (!api) { diag('init-skip'); return; }
  try {
    diag('init: getting config');
    state.config = await api.config.get();
    loadWbPrefs();
    setNavCollapsed(state.navCollapsed); // 首屏就按上次的选择显示, 不要等用户点一下才生效
    diag('init: binding events');
    bindEvents();
    diag('init: rendering');
    renderAll();
    diag('init: subscribe agent');
    api.agent.onEvent(handleAgentEvent);
    api.agent.onCheckpoint(handleCheckpoint);
    // 历史对话与数据空间是异步的, 不挡住首屏
    loadConversations();
    // 斜杠指令清单 (给 / 补全菜单用), 也是异步的
    loadSlashCommands();
    diag('ready dbs=' + (state.config.databases || []).length);
  } catch (e) {
    diag('err: ' + (e && e.message || e));
    showFatalError('init 失败: ' + (e && e.stack || e));
  }
}

function bindEvents() {
  // 左侧一级菜单。带 data-view 的才是导航项 —— 底部那个"收起菜单"也用了
  // nav-item 的样式, 但它没有 data-view, 不能进这个循环 (否则会拿着 undefined
  // 去切视图, 把当前页清掉)。
  $$('.nav-item').forEach((tab) => {
    if (!tab.dataset.view) return;
    tab.addEventListener('click', () => switchView(tab.dataset.view));
  });

  $('btnNavCollapse').addEventListener('click', () => setNavCollapsed(!state.navCollapsed));

  // 表名全名提示。事件委托挂在 document 上 —— 表卡片是每次探测/切库都重渲染的,
  // 逐个绑会在重渲染后失效。鼠标移到别处就收起来, 免得提示赖着不走。
  document.addEventListener('mouseover', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('.dt-name') : null;
    if (el) showNameTip(el);
    else hideNameTip();
  });
  // 滚动时立刻收起: 提示是 fixed 定位, 不跟着滚, 留着就会指向错误的表
  window.addEventListener('scroll', hideNameTip, true);

  // 配置页的顶部页签。用事件委托 —— 页签是 renderConfigTabs() 动态生成的,
  // 逐个绑会在每次重渲染后失效。
  $$('[data-config-tabs]').forEach((box) => {
    box.addEventListener('click', (e) => {
      const tab = e.target.closest('.subnav-tab');
      if (tab && tab.dataset.pane) switchView(tab.dataset.pane);
    });
  });

  // New chat (顶部二级条 + 侧边栏历史对话头部各一个入口)
  $('btnNewChat').addEventListener('click', newChat);
  $('btnNewChatSide').addEventListener('click', newChat);

  // 侧边栏历史对话: 在「只看 5 条」和「全部展开」之间切换
  $('btnConvMore').addEventListener('click', () => {
    state.convExpanded = !state.convExpanded;
    renderConvList();
  });

  // 模型页
  $('btnAddModel').addEventListener('click', () => openModelModal(''));
  $$('#modalModel [data-close]').forEach((el) => el.addEventListener('click', closeModelModal));
  $('btnSaveModel').addEventListener('click', saveModel);
  $('mmModel').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveModel(); }
  });
  // 清单上的按钮用事件委托 —— 行是每次渲染重建的, 逐行挂监听会在重渲染后
  // 留下悬空引用, 而且行数一多就是几十个监听器
  $('modelList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const row = btn.closest('.model-row');
    const id = row && row.dataset.modelId;
    if (!id) return;
    if (btn.dataset.act === 'use') pickModel(id);
    else if (btn.dataset.act === 'edit') openModelModal(id);
    else if (btn.dataset.act === 'del') deleteModel(id);
  });
  // 对话页的模型选择器
  // 自绘下拉: 点开 / 键盘开, 点外面关。
  // dbPick (空态, 在输入框上方) 和 dbPickHead (对话抬头) 是同一个选择器的两处渲染,
  // 是两个独立节点 —— 一起列在这儿, 交互行为就自动一致了。
  for (const id of ['modePick', 'modelPick', 'dbPick', 'dbPickHead', 'kbPick', 'kbPickHead']) {
    const el = $(id);
    if (!el) continue;
    el.addEventListener('click', (ev) => {
      // 菜单项自己的 click 已经 stopPropagation 了, 能冒到这里的都是"点按钮本身"
      if (ev.target.closest('.pick-menu')) return;
      togglePick(id);
    });
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'ArrowDown') {
        ev.preventDefault();
        openPick(id);
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        closePick();
      }
    });
  }
  // 点页面任何别的地方都收起。用 mousedown 而不是 click: 拖拽选中文本时
  // 也会触发 click, 那样选着字下拉就没了。
  document.addEventListener('mousedown', (ev) => {
    // ev.target 在合成事件里可能是 document 本身, 它没有 closest ——
    // 不判类型的话这里会抛异常, 下拉就关不掉了。
    const t = ev.target;
    const inBox = (sel) => t && typeof t.closest === 'function' && t.closest(sel);
    // 斜杠菜单: 点到菜单里或输入框本身都不关 (要继续输入)
    if (slashOpen && !inBox('.slash-menu') && !inBox('#composerInput')) slashHide();
    if (!openPickId) return;
    if (inBox('.pick')) return;
    closePick();
  });
  window.addEventListener('blur', closePick);
  // 输入框高度拖拽。主输入框和流程卡 AI 面板各一根, 高度分开记 ——
  // 面板只有 3 成宽, 两者合适的高度差很多。
  bindGrip('composerGrip', 'composerInput', 'solodb.composerH', { min: 56 });
  bindGrip('engAiGrip', 'engAiInput', 'solodb.engAiInputH', { min: 62, max: () => Math.round(window.innerHeight * 0.6) });
  $$('#modalAutoMode [data-close]').forEach((el) => el.addEventListener('click', closeAutoModeModal));
  $('btnAutoModeOk').addEventListener('click', confirmAutoMode);
  // 通用二次确认。Esc 取消 —— 一个"删不删"的弹窗不能逼人用鼠标找取消按钮。
  $$('#modalConfirm [data-cf-cancel]').forEach((el) => el.addEventListener('click', () => closeConfirm(false)));
  $('cfOk').addEventListener('click', () => closeConfirm(true));
  $('modalConfirm').addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); closeConfirm(false); }
    else if (ev.key === 'Enter') { ev.preventDefault(); closeConfirm(true); }
  });
  // 上下文圆环的浮层。hover 和 focus 都开 —— 只用鼠标才能看的话键盘用户看不到。
  // 用 mouseenter/mouseleave 而不是 mouseover/mouseout: 后者在环内元素之间
  // 移动也会触发, 浮层会闪。
  $('ctxRing').addEventListener('mouseenter', () => { $('ctxTip').hidden = false; });
  $('ctxRing').addEventListener('mouseleave', () => { $('ctxTip').hidden = true; });
  $('ctxRing').addEventListener('focus', () => { $('ctxTip').hidden = false; });
  $('ctxRing').addEventListener('blur', () => { $('ctxTip').hidden = true; });
  $('ctxRing').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { $('ctxTip').hidden = true; $('ctxRing').blur(); }
  });

  // Database page
  $('btnAddDb').addEventListener('click', () => openDbModal());

  // Database modal
  $$('#modalDb [data-close]').forEach((el) => el.addEventListener('click', closeDbModal));
  $('btnTestDb').addEventListener('click', testDb);
  $('btnSaveDb').addEventListener('click', saveDb);
  $('dbType').addEventListener('change', toggleDbFields);

  // Skills page
  $('btnImportSkill').addEventListener('click', importSkillDir);
  $('btnImportSkillFile').addEventListener('click', importSkillFile);

  // Tools page (MCP)
  $('btnAddMcp').addEventListener('click', openMcpModal);
  $$('#modalMcp [data-close]').forEach((el) => el.addEventListener('click', closeMcpModal));
  $('btnSaveMcp').addEventListener('click', saveMcp);

  // Settings page: 顶部二级条上的页签切换
  $$('#settingsNav .subnav-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchSettingsPane(btn.dataset.pane));
  });

  // Settings page: 提示词
  $('btnPromptSave').addEventListener('click', savePrompt);
  $('btnPromptReset').addEventListener('click', resetPrompt);
  $('btnPromptPreview').addEventListener('click', openPromptPreview);
  $('peRestore').addEventListener('click', restoreCurrentModule);
  $('peText').addEventListener('input', () => { promptDirty = true; updatePromptHint(); });
  $('peEnabled').addEventListener('change', () => { promptDirty = true; onModuleToggle(); });
  $$('#modalPrompt [data-close]').forEach((el) => el.addEventListener('click', () => { $('modalPrompt').hidden = true; }));

  // 重命名对话 (Electron 不支持 window.prompt, 所以有自己的弹窗)
  $$('#modalRename [data-close]').forEach((el) => el.addEventListener('click', closeRenameModal));
  $('btnRenameSave').addEventListener('click', submitRenameModal);
  $('renameInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitRenameModal(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeRenameModal(); }
  });

  // Settings page: 通用
  $('btnSaveGeneral').addEventListener('click', saveGeneral);
  $('btnSaveBuilder').addEventListener('click', saveBuilder);

  // Settings page: 关于
  $('btnCheckUpdate').addEventListener('click', checkUpdate);
  // 失焦就存 —— 用户不会专门为"填一个地址"去点一个保存按钮
  $('updateFeed').addEventListener('change', saveUpdateFeed);
  $('btnAllChangelog').addEventListener('click', () => openChangelog());
  $('btnAllChangelog2').addEventListener('click', () => openChangelog());
  // 从更新日志页回「关于」, 并且落在关于这个页签上 (而不是跳回模型页)
  $('btnChangelogBack').addEventListener('click', () => {
    settingsPane = 'about';
    switchView('settings');
  });

  // Composer
  $('btnSend').addEventListener('click', sendTask);
  // Enter 发送, Shift+Enter 换行。
  //
  // 以前是 Ctrl/Cmd+Enter 才发送 —— 那是聊天框还少见时的老习惯, 现在没人这么用,
  // 而且它让"打字 -> 回车"这个最自然的动作变成了插入一个换行, 用户得先想起来
  // 这里有个修饰键。
  //
  // 两个必须挡住的回车:
  //   e.isComposing  —— 中文输入法选词时按回车是"确认候选", 不是"发送"。
  //                     不挡的话打「你好」选词那一下就发出去了, 打出半句话。
  //   e.keyCode===229 —— 老输入法不报 isComposing, 只会给 229。
  $('composerInput').addEventListener('keydown', (e) => {
    // 斜杠补全菜单开着时, 方向键/回车/Tab/Esc 归它管 —— **回车是"选中指令", 不是"发送"**,
    // 这是最容易打架的一处。中文输入法合成期间 (isComposing / 229) 一律放行, 别吞了选词。
    if (slashOpen && !e.isComposing && e.keyCode !== 229) {
      if (e.key === 'ArrowDown') { e.preventDefault(); slashMove(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); slashMove(-1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); slashAccept(); return; }
      if (e.key === 'Escape') { e.preventDefault(); slashHide(); return; }
    }
    if (e.key !== 'Enter') return;
    if (e.shiftKey || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    sendTask();
  });
  // 输入框高度跟着内容长, 但不超过 40% 屏高 —— 否则写长任务时把对话流挤没了
  $('composerInput').addEventListener('input', (e) => {
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, Math.round(window.innerHeight * 0.4)) + 'px';
    slashUpdate();
  });
  // 人工终止: 状态条上的「停止」
  const stopRun = $('btnStopRun');
  if (stopRun) stopRun.addEventListener('click', stopRunTask);

  // ---- 产物侧栏 ----
  $('btnArtFull').addEventListener('click', () => {
    const art = state.artifacts.find((a) => a.id === state.activeArtifactId);
    if (!art) { toast('先选中一个产物', 'err'); return; }
    openFullscreen(art);
  });
  $('btnArtCollapse').addEventListener('click', () => setRightCollapsed(true));
  $('btnArtToggle').addEventListener('click', () => setRightCollapsed(!state.rightCollapsed));
  $('btnArtRestore').addEventListener('click', () => setRightCollapsed(false));

  // ---- 数据空间 ----
  $('btnRefreshSpace').addEventListener('click', () => renderSpace(true));
  // 全部展开 / 全部收起 —— 按钮文案跟着当前状态走, 免得点了没反应还不知道为什么
  $('btnSpaceExpand').addEventListener('click', () => {
    const allCollapsed = spaceState.groups.length > 0
      && spaceState.groups.every((g) => spaceState.collapsed.has(g.conversationId));
    spaceState.collapsed.clear();
    if (!allCollapsed) {
      // 当前不是"全收起"状态 -> 点它就是全收起
      for (const g of spaceState.groups) spaceState.collapsed.add(g.conversationId);
    }
    syncSpaceExpandBtn();
    paintSpaceTree();
  });

  // ---- 全屏预览 ----
  $('pfClose').addEventListener('click', closeFullscreen);
  $('pfReveal').addEventListener('click', () => {
    if (!fullscreenTarget) return;
    revealArtifact(fullscreenTarget.conversationId, fullscreenTarget.artifact);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('previewFull').hidden) closeFullscreen();
  });

  // ---- 三栏拖拽 ----
  bindGutters();
  applyWbWidths();
}

// 产物栏宽度上限/下限: 太窄看不清内容, 太宽会把对话区挤没。
// (历史对话搬去菜单后, 左栏和它的把手一起没了, 所以只剩 right。)
const WB_LIMITS = {
  right: { min: 280, max: 720 }
};

function bindGutters() {
  $$('.wb-gutter').forEach((g) => {
    g.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const side = g.dataset.gutter;   // 历史对话搬去菜单后, 只剩 'right'
      const pane = $('wbRight');
      if (!pane) return;
      const startX = e.clientX;
      const startW = pane.offsetWidth;
      g.classList.add('dragging');
      document.body.classList.add('wb-resizing');

      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        // 右栏的把手往左拖是变宽, 所以取负
        const next = side === 'left' ? startW + dx : startW - dx;
        const lim = WB_LIMITS[side];
        state.wbWidths[side] = Math.round(Math.min(lim.max, Math.max(lim.min, next)));
        applyWbWidths();
      };
      const onUp = () => {
        g.classList.remove('dragging');
        document.body.classList.remove('wb-resizing');
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        saveWbPrefs();
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
    // 双击把手 = 恢复该栏默认宽度
    g.addEventListener('dblclick', () => {
      const side = g.dataset.gutter;
      state.wbWidths[side] = side === 'left' ? 250 : 400;
      applyWbWidths();
      saveWbPrefs();
    });
  });
}

function applyWbWidths() {
  const right = $('wbRight');
  if (right) right.style.width = state.wbWidths.right + 'px';
}

function setRightCollapsed(collapsed) {
  state.rightCollapsed = !!collapsed;
  $('wbRight').hidden = state.rightCollapsed;
  const rightGutter = document.querySelector('.wb-gutter[data-gutter="right"]');
  if (rightGutter) rightGutter.hidden = state.rightCollapsed;
  // 对话抬头里那颗「产物」按钮: 亮着 = 侧栏开着
  const t = $('btnArtToggle');
  if (t) {
    t.classList.toggle('on', !state.rightCollapsed);
    t.setAttribute('aria-pressed', String(!state.rightCollapsed));
  }
  // 二级条上的还原按钮: 只在收起时出现。它是**兜底入口** ——
  // 上面那颗开关在空态下随对话抬头一起隐藏，光靠它会把人锁在外面。
  const restore = $('btnArtRestore');
  if (restore) restore.hidden = !state.rightCollapsed;
  saveWbPrefs();
}

async function newChat() {
  if (state.running) {
    toast('任务进行中, 请等它跑完或先取消', 'err');
    return;
  }
  state.conversation = [];
  state.agentState = null;
  state.artifacts = [];
  state.activeArtifactId = null;
  // 新对话从 0 开始。不清的话上一段的累计量会挂在新的这段上。
  state.convUsage = { input: 0, output: 0, calls: 0 };
  state.convCtx = 0;
  // 分析范围跟着对话走: 新开一段就回到"不限制", 让用户在输入框上方重新选。
  // 沿用上一段更省事, 但那样"新对话顶部让你选库"就名存实亡了 —— 用户会以为
  // 自己选过, 实际继承的是上一段的, 那种错很难被发现。
  state.dbIds = [];
  // "一个都不选"是路上的一步, 不是要记住的偏好: 新开一段就回到默认的"全部",
  // 让用户在输入框上方重新选 (跟上面 dbIds 同一个理由)。
  state.dbNone = false;
  pendingStats = null;
  state.activeConversationId = null;

  // 侧边栏立刻落一条「新对话」占位, 让"新建了"这件事看得见 ——
  // 原来要等第一条消息发出去才建记录, 点完「＋」侧边栏毫无反应。
  // 已经有一条空的占位就复用它: 连点「＋」不该堆出一串空记录。
  const existing = (state.conversations || []).find(
    (c) => c.title === NEW_CHAT_TITLE && !c.messageCount
  );
  if (existing) {
    state.activeConversationId = existing.id;
  } else {
    try {
      // 不带 task: 占位阶段不起标题 (不花模型钱), 标题等第一轮发出后再补。
      const res = await api.conv.create({ placeholder: true });
      if (res && res.ok && res.conversation) {
        state.activeConversationId = res.conversation.id;
      }
    } catch (e) {
      // 占位建不出来也不拦着用: 兜底走"第一条消息发出时才建"的老路
      toast('新建对话失败: ' + e.message, 'err');
    }
    await loadConversations();
  }

  renderConvList();
  renderChat();
  renderArtifacts();
  if (state.rightCollapsed) setRightCollapsed(false);
}

// ============== View switching ==============

// 「配置」这一项底下其实是 5 个子页, 它们各自还是一个 .view
// (流程引擎那块要整屏画板, 拆成独立视图最省事), 只是左侧菜单共用一项、
// 右侧共用一条顶部页签。这里是唯一的清单 —— 加第 6 个子页只改这一处。
/**
 * 配置的 5 个子页。
 *
 * icon 里是 16x16 的描边路径, 跟左侧导航用同一套约定 (fill:none + stroke:currentColor),
 * 所以选中态文字变主色时图标会自动跟着变, 不用单独写一套高亮样式。
 *
 * 几个取舍:
 *  - 数据库用圆柱体, 不是"硬盘/服务器机架" —— 这三个库 (MySQL/PG/SQLite) 都是关系库,
 *    圆柱体是最没有歧义的那个符号。
 *  - 流程引擎用"两个方块 + 连线"而不是齿轮: 齿轮在这个尺寸下会糊成一个太阳,
 *    而且它跟「设置」的图标会撞。
 *  - 技能用四角星 (sparkle)。这一页配的是给 AI 看的技能说明, 星形比"灯泡/书本"
 *    更能一眼认出是"AI 能力"这一类。
 *  - 外部工具 = 插头 (要连出去), 内部工具 = 扳手 (自带的手艺)。两个都读作"工具",
 *    靠形状区分内外 —— 用"地球/房子"那类图标反而会跟「数据空间」混。
 */
const CONFIG_TABS = [
  {
    id: 'databases', label: '数据库',
    icon: '<ellipse cx="8" cy="4" rx="5.1" ry="2.1"/>'
        + '<path d="M2.9 4v8c0 1.16 2.28 2.1 5.1 2.1s5.1-.94 5.1-2.1V4"/>'
        + '<path d="M2.9 8c0 1.16 2.28 2.1 5.1 2.1s5.1-.94 5.1-2.1"/>'
  },
  {
    id: 'engines', label: '流程引擎',
    icon: '<rect x="1.7" y="1.8" width="5.2" height="3.7" rx="1.1"/>'
        + '<rect x="9.1" y="10.5" width="5.2" height="3.7" rx="1.1"/>'
        + '<path d="M4.3 5.5v4.4a1.8 1.8 0 0 0 1.8 1.8h3"/>'
  },
  {
    id: 'skills', label: '技能',
    icon: '<path d="M8 1.7l1.55 4.05L13.6 7.3l-4.05 1.55L8 12.9l-1.55-4.05L2.4 7.3l4.05-1.55z"/>'
        + '<path d="M12.7 11.4l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5z"/>'
  },
  {
    id: 'tools', label: '外部工具',
    icon: '<path d="M5.9 2.3v3.1M10.1 2.3v3.1"/>'
        + '<path d="M3.9 5.4h8.2v1.9a4.1 4.1 0 0 1-8.2 0z"/>'
        + '<path d="M8 11.4v2.3"/>'
  },
  {
    id: 'intools', label: '内部工具',
    icon: '<path d="M10.7 2.5a3.7 3.7 0 0 0-4.8 4.7l-3.6 3.6a1.35 1.35 0 0 0 1.9 1.9l3.6-3.6a3.7 3.7 0 0 0 4.7-4.8l-2.2 2.2-1.9-1.9z"/>'
  },
  {
    // 知识库配置: 分块策略 / 向量模型 / 检索参数。跟「知识库」页 (管理数据) 分开 ——
    // 那是数据, 这是行为配置。
    id: 'knowledgecfg', label: '知识库',
    icon: '<path d="M3.1 3.4h3.8a1.7 1.7 0 0 1 1.1.5 1.7 1.7 0 0 1 1.1-.5h3.8v8.6H8.6a1.4 1.4 0 0 0-1.4 1.1 1.4 1.4 0 0 0-1.4-1.1H3.1z"/>'
        + '<path d="M8 3.9v9.2"/>'
  }
];
const CONFIG_IDS = CONFIG_TABS.map((t) => t.id);

/** 把 5 个视图各自那条 [data-config-tabs] 填成同一组页签, 当前页高亮。 */
function renderConfigTabs() {
  $$('[data-config-tabs]').forEach((box) => {
    const view = box.closest('.view');
    const current = view && view.dataset.view;
    box.innerHTML = CONFIG_TABS.map((t) =>
      `<button class="subnav-tab${t.id === current ? ' active' : ''}" data-pane="${t.id}">`
      + `<svg class="subnav-tab-icon" viewBox="0 0 16 16" aria-hidden="true">${t.icon}</svg>`
      + `<span>${t.label}</span></button>`
    ).join('');
  });
}

function switchView(view) {
  // 左侧点「配置」时并没有一个叫 config 的视图 —— 它要落到具体的子页上。
  // 记住上次看的是哪个子页, 下次点「配置」直接回到那里 (默认第一个)。
  if (view === 'config') view = state.configTab || CONFIG_IDS[0];
  // 配置的 5 个子页共用左侧那一个「配置」菜单项
  let navKey = CONFIG_IDS.includes(view) ? 'config' : view;
  // 更新日志不是一个独立功能, 它是「设置 · 关于」里那份日志的放大版 ——
  // 所以进来之后左侧一级菜单仍然停在「设置」, 而不是一个都不高亮。
  if (view === 'changelog') navKey = 'settings';
  $$('.nav-item').forEach((t) => t.classList.toggle('active', t.dataset.view === navKey));
  $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === view));
  if (CONFIG_IDS.includes(view)) {
    state.configTab = view;
    renderConfigTabs();
  }
  if (view === 'databases') renderDbList();
  if (view === 'engines') initEngines();
  if (view === 'skills') renderSkillList();
  if (view === 'tools') renderMcpList();
  if (view === 'intools') renderInternalTools();
  if (view === 'settings') renderSettings();
  if (view === 'changelog') renderChangelogPage();
  if (view === 'space') renderSpace();
  if (view === 'chat') loadConversations();
  // 知识库 / 知识库配置 (实现在 src/js/knowledge.js)
  if (view === 'knowledge' && typeof initKnowledgeView === 'function') initKnowledgeView();
  if (view === 'knowledgecfg' && typeof renderKbConfig === 'function') renderKbConfig();
}

// ============== Render ==============
function renderAll() {
  fillIconSlots();   // 静态 HTML 里 <... data-icon="..."> 的占位补上图标
  renderConfigTabs();
  renderTopDb();
  renderChat();
  renderModelList();
  renderModelPick();
  renderModePick();
  renderDbPicks();
  renderKbPick();
  renderDbList();
  renderSkillList();
  renderMcpList();
  renderConvList();
  renderArtifacts();
  setRightCollapsed(state.rightCollapsed);
}

function renderTopDb() {
  // 顶部不再显示"当前数据库" —— 这个概念已经取消, 通用问句的库由表名自动定位。
  // 配置正常时这里**什么都不写**: 模型名和它的 Base 已经由输入框右边那个下拉
  // 表达了, 再写一遍"模型: xxx · Base: xxx"是同一句话说两次, 纯噪声。
  // 只有"缺东西、需要用户动手"的状态才留字。
  // 注意判断的是 apiKeySet 而不是 apiKey: 密钥不下发到渲染层, apiKey 永远是空串。
  const el = $('composerMeta');
  const m = activeModelOf();
  if (m && m.apiKeySet) {
    el.textContent = '';
    el.classList.remove('warn');
    return;
  }
  el.classList.add('warn');
  if (m) {
    // 有模型但没 Key —— 说清楚差什么, 别只说"未配置"
    el.textContent = `「${m.name || m.model}」还没填 API Key (前往"设置 · 模型")`;
  } else {
    el.textContent = '未配置模型 (前往"设置 · 模型"页设置)';
  }
}

function trimBase(url) {
  if (!url) return '';
  return url.replace(/^https?:\/\//, '').slice(0, 32);
}

/* ============== 表名全名提示 ==============
 * 表名是英文而且经常很长 (delivery_order_detail_1781055600000), 卡片只有 140px 宽,
 * 会被 CSS 截断成 delivery_order_detail_1…。截断了就必须能看全名。
 *
 * 为什么不用原生 title: 实测它确实挂着 (8/8 都有), 但那是**操作系统画的** ——
 * 有大约一秒延迟, 窗口没有焦点时干脆不弹, 而且截图/自动化都抓不到, 出问题也没法
 * 验证。全名在界面上是必需信息, 不能挂在一个"有时候不出现"的机制上。
 */
function ensureNameTip() {
  let tip = document.getElementById('dtTip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'dtTip';
    tip.className = 'dt-tip';
    document.body.appendChild(tip);
  }
  return tip;
}

function showNameTip(el) {
  // 没被截断就不弹 —— 提示跟可见文字一字不差, 只是噪音
  if (el.scrollWidth <= el.clientWidth + 1) return;
  const tip = ensureNameTip();
  tip.textContent = el.textContent;
  tip.style.display = 'block';
  const r = el.getBoundingClientRect();
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  // 贴左边太靠外就往回拉, 免得提示跑出窗口
  let left = Math.max(8, Math.min(r.left, window.innerWidth - tw - 8));
  // 默认在下面; 下面放不下就翻到上面
  let top = r.bottom + 6;
  if (top + th > window.innerHeight - 8) top = Math.max(8, r.top - th - 6);
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}

function hideNameTip() {
  const tip = document.getElementById('dtTip');
  if (tip) tip.style.display = 'none';
}

function renderDbList() {
  const list = $('dbList');
  const dbs = state.config.databases || [];
  if (!dbs.length) {
    list.innerHTML = '<div class="empty-block">暂无数据库, 点击右上角添加。</div>';
    return;
  }
  list.innerHTML = '';
  for (const db of dbs) list.appendChild(renderDbBlock(db));
}

// 每个数据库一个区块: 头部 (信息 + 按钮) + 独立的表清单卡片 (可折叠)
function renderDbBlock(db) {
  const tables = Array.isArray(db.tables) ? db.tables : [];
  const checkedCount = tables.filter((t) => t.checked).length;

  const block = document.createElement('div');
  block.className = 'db-block';
  block.dataset.dbId = db.id;

  const item = document.createElement('div');
  item.className = 'db-item';
  const sub = db.type === 'sqlite'
    ? `SQLite · ${db.database}`
    : `${db.type} · ${db.host || ''}:${db.port || ''} / ${db.database}`;
  const tableMeta = tables.length
    ? `已勾选 ${checkedCount} / ${tables.length} 张表`
    : '尚未探测数据表';
  // 勾过的表就是可访问的范围, 每个库各自管自己的勾选 —— 不再有"当前使用哪个库"这回事
  item.innerHTML = `
    <div class="db-meta">
      <div class="db-name">${escapeHtml(db.name)}</div>
      <div class="db-sub">${escapeHtml(sub)}</div>
      <div class="db-sub db-sub-tables">${escapeHtml(tableMeta)}</div>
    </div>
    <div class="db-actions">
      <button class="btn" data-act="probe">探测数据表</button>
      <button class="btn btn-danger" data-act="del">删除</button>
      <button class="db-toggle" data-act="view" title="展开数据表" aria-label="展开数据表">
        <svg class="db-toggle-icon" width="14" height="14" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </button>
    </div>
  `;
  block.appendChild(item);

  // 表清单单独成卡片, 与上面的库信息卡片之间留白, 不粘在一起
  const panel = document.createElement('div');
  panel.className = 'db-tables-panel';
  panel.appendChild(buildPanelToolbar(db, tables));
  panel.appendChild(buildTableGrid(db, tables));
  block.appendChild(panel);

  const toggleBtn = item.querySelector('[data-act="view"]');
  const setOpen = (open) => {
    panelState(db.id).open = open;
    panel.hidden = !open;
    toggleBtn.classList.toggle('open', open);
    toggleBtn.title = open ? '收起数据表' : '展开数据表';
    toggleBtn.setAttribute('aria-label', toggleBtn.title);
    if (open) applyTableFilter(block);
  };

  if (panelState(db.id).open) setOpen(true);
  else { panel.hidden = true; }

  // ---- 头部按钮 ----
  item.querySelector('[data-act="del"]').addEventListener('click', async () => {
    if (!(await askConfirm({
      title: '删除数据库连接?',
      message: `确定删除数据库「${db.name}」?`,
      detail: '这条连接配置 (地址、账号、勾选的表) 会被移除。数据库里的数据不受影响, 但要重新填一遍才能再接回来。',
      okText: '删除连接',
      tone: 'danger'
    }))) return;
    await api.config.removeDatabase(db.id);
    state.config = await api.config.get();
    delete dbPanelStateMap[db.id];
    renderAll();
  });
  item.querySelector('[data-act="probe"]').addEventListener('click', () => probeTables(db, item));
  toggleBtn.addEventListener('click', () => setOpen(!panelState(db.id).open));

  updatePanelSummary(block);
  return block;
}

// 表清单面板的头部: 左摘要, 右上角搜索 (实时模糊) + 筛选
function buildPanelToolbar(db, tables) {
  const bar = document.createElement('div');
  bar.className = 'dt-toolbar';
  bar.innerHTML = `
    <div class="dt-summary"></div>
    <div class="dt-toolbar-right">
      <button class="btn btn-sm dt-all" data-act="all">全选</button>
      <input class="dt-search" type="search" placeholder="搜索表名 (支持模糊)" />
      <select class="dt-filter" title="筛选表">
        <option value="all">全部表</option>
        <option value="checked">已勾选</option>
        <option value="unchecked">未勾选</option>
      </select>
    </div>
  `;
  const search = bar.querySelector('.dt-search');
  const filter = bar.querySelector('.dt-filter');
  const allBtn = bar.querySelector('.dt-all');
  allBtn.addEventListener('click', () => toggleAllTables(bar.closest('.db-block'), db));
  const st = panelState(db.id);
  filter.value = st.filter;
  search.value = st.search;

  // 边打边筛, 不用回车; 命中结果按相关度排到前面
  search.addEventListener('input', () => {
    st.search = search.value.trim();
    applyTableFilter(bar.closest('.db-block'));
  });
  // type=search 自带的清除按钮不会触发 input 的某些时序, 这里补一次
  search.addEventListener('search', () => {
    st.search = search.value.trim();
    applyTableFilter(bar.closest('.db-block'));
  });
  filter.addEventListener('change', () => {
    st.filter = filter.value;
    applyTableFilter(bar.closest('.db-block'));
  });
  return bar;
}

/**
 * 全选 / 全不选。一个按钮来回切 —— 不拆成两个。
 *
 * 「全选」和「全不选」是同一个意图的两端, 拆成两个按钮只会让人多读一个字再决定
 * 点哪个; 而且拆开之后就没有地方表达"当前已经全勾上了"这件事。
 *
 * 标签跟着**下一次点击会做什么**变: 已经全勾上就显示「全不选」。否则会出现
 * "点了全选却什么都没变"的困惑 —— 因为本来就已经全勾了。
 *
 * 作用范围是**这个库的全部表**, 跟当前的搜索/筛选无关。筛选是"看"的控件,
 * 让它顺带决定"改哪些数据"会埋一个很难查的坑: 搜了「送货单」看到 5 张,
 * 点全选却把 1206 张全勾上了。
 */
async function toggleAllTables(blockEl, db) {
  if (!blockEl || !db) return;
  const cards = Array.from(blockEl.querySelectorAll('.dt-card'));
  if (!cards.length) return;

  const allChecked = cards.every((c) => c.querySelector('.dt-check')?.checked);
  const next = !allChecked;

  // DOM 与数据两头都要改: 数据对象是每张卡片闭包引用的那一份, 只改 DOM 会在
  // 下一次 saveTables 时被原值覆盖回去。
  for (const card of cards) {
    const box = card.querySelector('.dt-check');
    if (box) box.checked = next;
    card.classList.toggle('checked', next);
  }
  for (const t of db.tables) t.checked = next;

  // 一次落盘, 不要触发 1206 次 change 事件 (SRM 有 1206 张表)
  await saveTables(db);
  updatePanelSummary(blockEl);
  applyTableFilter(blockEl);
  toast(next ? `已勾选全部 ${cards.length} 张表` : `已取消全部 ${cards.length} 张表的勾选`);
}

/** 按钮文案与禁用态, 跟着当前勾选情况走。由 updatePanelSummary 统一调 */
function syncAllButton(blockEl) {
  const btn = blockEl && blockEl.querySelector('.dt-all');
  if (!btn) return;
  const boxes = Array.from(blockEl.querySelectorAll('.dt-check'));
  const all = boxes.length > 0 && boxes.every((b) => b.checked);
  btn.textContent = all ? '全不选' : '全选';
  btn.disabled = boxes.length === 0;
}

// 表卡片网格: 表名 + 备注(可编辑) + 右侧复选框
function buildTableGrid(db, tables) {
  const wrap = document.createElement('div');
  const grid = document.createElement('div');
  grid.className = 'dt-grid';

  // 空态提示常驻 DOM (平时隐藏): 表全被筛掉时由 applyTableFilter 显示出来,
  // 否则用户只会看到一片空白, 不知道是搜索没命中还是库是空的。
  const empty = document.createElement('div');
  empty.className = 'dt-empty';
  empty.hidden = true;

  if (!tables.length) {
    empty.hidden = false;
    empty.textContent = '还没有探测到数据表。点击上方「探测数据表」读取当前库的表名和表注释（只读，不读取表结构）。';
    wrap.appendChild(empty);
    wrap.appendChild(grid);
    return wrap;
  }

  for (let i = 0; i < tables.length; i++) {
    const t = tables[i];
    const card = document.createElement('div');
    card.className = 'dt-card' + (t.checked ? ' checked' : '');
    card.dataset.name = t.name;
    card.dataset.idx = String(i);
    // 库里维护的表注释 (探测时带回来的只读镜像)。它直接当**备注框的占位提示** ——
    // 不额外占一行, 用户点进去就能改成自己的口径, 改完就是 note。
    // 注释本身仍然单独存一个字段 (comment), 探测时刷新, 永不覆盖用户写的 note。
    const dbComment = String(t.comment || '').trim();
    card.innerHTML = `
      <div class="dt-card-head">
        <span class="dt-name">${escapeHtml(t.name)}</span>
        <input type="checkbox" class="dt-check" ${t.checked ? 'checked' : ''}
               title="勾选后 AI 才能访问这张表" />
      </div>
      <textarea class="dt-note" rows="1"
        placeholder="${escapeAttr(dbComment || '备注（选填）')}"
        title="${escapeAttr(dbComment
          ? '数据库里维护的注释：' + dbComment + '（可直接改成你的口径）'
          : '补充说明这张表是干什么的、口径如何，AI 会结合它来选表')}">${escapeHtml(t.note || '')}</textarea>
    `;

    const check = card.querySelector('.dt-check');
    const note = card.querySelector('.dt-note');

    check.addEventListener('change', async () => {
      t.checked = check.checked;
      card.classList.toggle('checked', check.checked);
      updatePanelSummary(card.closest('.db-block'));
      await saveTables(db);
      applyTableFilter(card.closest('.db-block'));
    });

    // 失焦或回车时保存备注, 不必每敲一个字就落盘
    note.addEventListener('blur', () => commitNote(t, note, db));
    note.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        note.blur();
      }
    });

    grid.appendChild(card);
  }

  wrap.appendChild(empty);
  wrap.appendChild(grid);
  return wrap;
}

async function commitNote(t, noteEl, db) {
  const val = noteEl.value.trim();
  if (val === (t.note || '')) return;
  t.note = val;
  await saveTables(db);
}

async function saveTables(db) {
  try {
    const res = await api.config.setDatabaseTables({ id: db.id, tables: db.tables });
    if (res && res.ok && Array.isArray(res.tables)) {
      // 就地更新, 不要替换数组或对象 —— 每张卡片的闭包还引用着原来的对象,
      // 一旦换成新对象, 后续的勾选与备注就会写到一个没人读的副本上。
      const byName = new Map(res.tables.map((t) => [t.name, t]));
      for (const t of db.tables) {
        const srv = byName.get(t.name);
        if (!srv) continue;
        t.checked = srv.checked;
        t.note = srv.note;
      }
      // 服务端条目数与本地不一致 (如探测后又变过), 交给整段重渲染对齐
      if (res.tables.length !== db.tables.length) renderDbList();
    } else if (res && res.error) {
      toast('保存表清单失败: ' + res.error, 'err');
    }
  } catch (e) {
    toast('保存表清单失败: ' + e.message, 'err');
  }
}

// 探测: 只取表名, 不读取表结构。已有勾选与备注按表名保留。
async function probeTables(db, itemEl) {
  const btn = itemEl.querySelector('[data-act="probe"]');
  btn.disabled = true;
  btn.textContent = '探测中…';
  try {
    const res = await api.db.listTables({ dbId: db.id });
    if (!res.ok) {
      toast('探测失败: ' + res.error, 'err');
      return;
    }
    const merged = await api.config.setDatabaseTables({ id: db.id, tables: res.tables });
    if (!merged.ok) {
      toast('保存表清单失败: ' + merged.error, 'err');
      return;
    }
    db.tables = merged.tables;
    panelState(db.id).open = true;
    renderDbList();
    // 把"带回来几张注释"说清楚 —— 用户据此知道哪些表 AI 是有依据的,
    // 哪些还得自己补备注
    const withComment = res.tables.filter((t) => t && String(t.comment || '').trim()).length;
    toast(`探测到 ${res.tables.length} 张表`
      + (withComment ? `（其中 ${withComment} 张带库注释，已带出）` : '')
      + '，请勾选本次要访问的表');
  } catch (e) {
    toast('探测失败: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '探测数据表';
  }
}

// 折叠栏的展开状态与筛选条件, 按数据库分别记住, 重渲染后不丢
const dbPanelStateMap = {};
function panelState(dbId) {
  if (!dbPanelStateMap[dbId]) dbPanelStateMap[dbId] = { open: false, filter: 'all', search: '' };
  return dbPanelStateMap[dbId];
}

// 按"全部/已勾选/未勾选" + 模糊搜索词过滤卡片。
// 只切 hidden + 重排序, 不重建 DOM, 这样勾选与备注输入不会被打断。
function applyTableFilter(blockEl) {
  if (!blockEl) return;
  const st = panelState(blockEl.dataset.dbId);
  const grid = blockEl.querySelector('.dt-grid');
  const cards = Array.from(blockEl.querySelectorAll('.dt-card'));
  const rows = [];

  for (const card of cards) {
    const checked = !!card.querySelector('.dt-check')?.checked;
    const name = card.dataset.name || '';
    const byFilter = st.filter === 'all'
      || (st.filter === 'checked' && checked)
      || (st.filter === 'unchecked' && !checked);

    let bySearch = true;
    let score = 0;
    if (st.search) {
      const s = fuzzyScore(name, st.search);
      bySearch = s != null;
      score = s == null ? 0 : s;
    }

    const show = byFilter && bySearch;
    card.hidden = !show;
    rows.push({ card, show, score, idx: Number(card.dataset.idx) || 0 });
  }

  // 可见的排在前面: 有搜索词时按相关度, 否则回到表名原序; 被筛掉的沉底
  if (grid) {
    rows.sort((a, b) => {
      if (a.show !== b.show) return a.show ? -1 : 1;
      if (st.search && b.score !== a.score) return b.score - a.score;
      return a.idx - b.idx;
    });
    const desired = rows.map((r) => r.card);
    const current = Array.from(grid.children).filter((c) => c.classList && c.classList.contains('dt-card'));
    const sameOrder = desired.length === current.length && desired.every((c, i) => c === current[i]);
    if (!sameOrder) for (const c of desired) grid.appendChild(c);
  }

  const shown = rows.filter((r) => r.show).length;
  const empty = blockEl.querySelector('.dt-empty');
  if (empty && cards.length) {
    empty.hidden = shown > 0;
    if (shown === 0) {
      empty.textContent = st.search
        ? `没有匹配「${st.search}」的表。`
        : '没有符合当前筛选条件的表。';
    }
  }
  updatePanelSummary(blockEl);
}

/**
 * 模糊匹配打分。命中越多、越连续、位置越靠前分越高; 不匹配返回 null。
 *
 * 两级策略:
 *   1. 包含匹配 —— 只要 query 是表名的一部分就算命中, 优先级最高
 *   2. 子序列匹配 —— 允许中间跳过字符 (ulog -> user_login_log), 但要求
 *      首个命中字符落在"段的开头"(开头 / 下划线连字符之后 / 驼峰边界)。
 *      没有这条约束, user 会把 customers 也匹配出来, 全是噪音。
 */
function fuzzyScore(name, query) {
  const raw = String(name || '');
  const hay = raw.toLowerCase();
  const q = String(query || '').toLowerCase().replace(/\s+/g, '');
  if (!q) return 0;

  const direct = hay.indexOf(q);
  if (direct >= 0) {
    // 连续命中: 越靠前、与表名长度越接近越好
    return 1000 - direct * 2 - (hay.length - q.length);
  }

  let cursor = 0;
  let score = 0;
  let lastHit = -2;
  let streak = 0;
  let firstHit = -1;
  for (const ch of q) {
    const found = hay.indexOf(ch, cursor);
    if (found < 0) return null;
    if (firstHit < 0) firstHit = found;
    if (found === lastHit + 1) {
      streak += 1;
      score += 8 + streak * 4;
    } else {
      streak = 0;
      score += 3;
    }
    if (isSegmentStart(raw, hay, found)) score += 6;
    lastHit = found;
    cursor = found + 1;
  }
  if (!isSegmentStart(raw, hay, firstHit)) return null;

  return score - (hay.length - q.length) * 0.3;
}

/** 这个位置是不是一个"词的开头": 表名开头 / 分隔符之后 / camelCase 边界 */
function isSegmentStart(raw, hay, i) {
  if (i <= 0) return true;
  if (/[_\-.\s]/.test(hay[i - 1])) return true;
  return /[a-z0-9]/.test(hay[i - 1]) && /[A-Z]/.test(raw[i] || '');
}

/**
 * 刷新面板头部的文字与按钮状态 (摘要 + 全选按钮文案)。
 *
 * 为什么把全选按钮也放这里: 勾选状态只有一个来源, 就是卡片上的复选框。任何改动
 * 勾选的地方都会调这个函数, 所以按钮文案挂在这儿就不可能跟实际状态漂移。
 */
function updatePanelSummary(blockEl) {
  if (!blockEl) return;
  const st = panelState(blockEl.dataset.dbId);
  const cards = blockEl.querySelectorAll('.dt-card');
  const checked = [...cards].filter((c) => c.querySelector('.dt-check')?.checked).length;
  const shown = [...cards].filter((c) => !c.hidden).length;
  const sum = blockEl.querySelector('.dt-summary');
  if (sum) {
    const searching = st.search || st.filter !== 'all';
    sum.textContent = `已勾选 ${checked} / ${cards.length} 张表` + (searching ? ` · 匹配 ${shown} 张` : '');
  }
  const meta = blockEl.querySelector('.db-sub-tables');
  if (meta) meta.textContent = `已勾选 ${checked} / ${cards.length} 张表`;
  syncAllButton(blockEl);
}

function renderSkillList() {
  const list = $('skillList');
  api.skills.list().then((skills) => {
    if (!skills.length) {
      list.innerHTML = '<div class="empty-block">暂无技能, 点击"导入技能"选择一个目录。</div>';
      return;
    }
    list.innerHTML = '';
    for (const s of skills) {
      const item = document.createElement('div');
      item.className = 'skill-item';
      item.innerHTML = `
        <div class="skill-meta">
          <div class="skill-name">${escapeHtml(s.name)}<span class="skill-version">v${escapeHtml(s.version)}</span></div>
          <div class="skill-desc">${escapeHtml(s.description || '(无描述)')}</div>
        </div>
        <div class="skill-actions">
          <label class="switch">
            <input type="checkbox" ${s.enabled ? 'checked' : ''} data-name="${escapeAttr(s.name)}" />
            <span></span>
          </label>
        </div>
      `;
      const checkbox = item.querySelector('input');
      checkbox.addEventListener('change', async () => {
        await api.skills.toggle(s.name, checkbox.checked);
        toast((checkbox.checked ? '已启用' : '已禁用') + ' ' + s.name);
      });
      list.appendChild(item);
    }
  });
}

// ============== 外部工具 (MCP) ==============

function renderMcpList() {
  const list = $('mcpList');
  if (!list) return;
  api.mcp.list().then((res) => {
    const servers = (res && res.servers) || [];
    if (!servers.length) {
      list.innerHTML = '<div class="empty-block">暂无外部工具, 点击"添加服务"接入一个 MCP 服务。</div>';
      return;
    }
    list.innerHTML = '';
    for (const s of servers) {
      const item = document.createElement('div');
      item.className = 'skill-item mcp-item';
      item.innerHTML = `
        <div class="skill-meta">
          <div class="skill-name">${escapeHtml(s.name)}<span class="skill-version">${s.enabled === false ? '已停用' : '启用中'}</span></div>
          <div class="skill-desc mcp-cmd">${escapeHtml([s.command].concat(s.args || []).join(' '))}</div>
          <div class="skill-desc mcp-tools" data-tools></div>
        </div>
        <div class="skill-actions">
          <button class="btn btn-ghost btn-sm" data-act="test">测试</button>
          <button class="btn btn-ghost btn-sm" data-act="remove">删除</button>
          <label class="switch">
            <input type="checkbox" ${s.enabled === false ? '' : 'checked'} />
            <span></span>
          </label>
        </div>
      `;
      const toolsEl = item.querySelector('[data-tools]');
      const checkbox = item.querySelector('input');

      checkbox.addEventListener('change', async () => {
        await api.mcp.toggle({ id: s.id, enabled: checkbox.checked });
        toast((checkbox.checked ? '已启用' : '已停用') + ' ' + s.name);
        renderMcpList();
      });

      item.querySelector('[data-act="remove"]').addEventListener('click', async () => {
        await api.mcp.remove(s.id);
        toast('已删除 ' + s.name);
        renderMcpList();
      });

      item.querySelector('[data-act="test"]').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        toolsEl.textContent = '正在启动服务...';
        toolsEl.classList.remove('mcp-err');
        const res2 = await api.mcp.probe({ id: s.id });
        btn.disabled = false;
        if (res2 && res2.ok) {
          toolsEl.textContent = `可用工具 ${res2.tools.length} 个: ` + res2.tools.map((t) => t.name.replace(/^mcp__[^_]+__/, '')).join(', ');
          toolsEl.classList.remove('mcp-err');
        } else {
          toolsEl.textContent = '启动失败: ' + ((res2 && res2.error) || '未知错误') + (res2 && res2.stderr ? ' | ' + String(res2.stderr).trim().slice(0, 160) : '');
          toolsEl.classList.add('mcp-err');
        }
      });

      list.appendChild(item);
    }
  });
}

// ============== 内部工具 (只读展示) ==============

/**
 * 三个智能体内置工具的清单。
 *
 * 这里**一行工具信息都不写死** —— 全部来自主进程的 tools:catalog, 而那边又是从
 * 各 Agent 的真实 schema 现取的 (见 lib/tool-catalog.js)。所以改了工具, 这个页面
 * 自动就对了; 不需要"记得同步文档"。
 *
 * 清单在一次会话里缓存: 搜索是纯前端过滤, 不该每敲一个字就走一次 IPC。
 * 想看最新的话重新进这个页会重新取 (switchView 每次都调 renderInternalTools)。
 */
let intoolsData = null;

async function renderInternalTools() {
  const groupsEl = $('intoolsGroups');
  const sumEl = $('intoolsSummary');
  if (!groupsEl) return;

  try {
    intoolsData = await api.internalTools.list();
  } catch (e) {
    groupsEl.innerHTML = `<div class="empty-block">读取工具清单失败: ${escapeHtml((e && e.message) || String(e))}</div>`;
    if (sumEl) sumEl.innerHTML = '';
    return;
  }
  if (!intoolsData || !Array.isArray(intoolsData.groups)) {
    groupsEl.innerHTML = '<div class="empty-block">主进程没有返回可用的工具清单。</div>';
    return;
  }

  bindInternalToolsSearch();
  paintInternalTools();
}

/** 搜索框只绑一次 (视图会被反复切进来, 重复绑会叠加监听) */
let intoolsSearchBound = false;
function bindInternalToolsSearch() {
  if (intoolsSearchBound) return;
  const box = $('intoolsSearch');
  if (!box) return;
  box.addEventListener('input', paintInternalTools);
  intoolsSearchBound = true;
}

/** 命中判断: 工具名 / 说明 / 参数名, 任一包含关键词即可 */
function intoolsMatch(tool, kw) {
  if (!kw) return true;
  const hay = [tool.name, tool.description, (tool.params || []).map((p) => p.name).join(' ')]
    .join(' ')
    .toLowerCase();
  return hay.indexOf(kw) >= 0;
}

/**
 * 工具说明里的 markdown 要渲染, 不要原样显示。
 *
 * 36 个工具里有 9 个在 description 里写了 `**加粗**` —— 那是写给模型看的, 模型按
 * markdown 读, 所以源码里那么写是对的。但页面上当纯文本渲染就会露出字面的星号,
 * 读起来像坏了。
 *
 * 这里**渲染它比转义它更忠实**: 让页面读起来和模型读到的是同一个强调结构。
 * 先 escapeHtml 再替换, 所以数据里的 HTML 不可能活下来 —— 只放行自己生成的
 * <strong>。目前只处理加粗: 实测 36 条说明里没有反引号和列表语法, 不为它们
 * 增加不必要的复杂度 (真出现了再加)。
 */
function renderPromptText(s) {
  return escapeHtml(String(s == null ? '' : s))
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function paintInternalTools() {
  const groupsEl = $('intoolsGroups');
  const sumEl = $('intoolsSummary');
  if (!groupsEl || !intoolsData) return;

  const box = $('intoolsSearch');
  const kw = box ? String(box.value || '').trim().toLowerCase() : '';

  const total = intoolsData.total;
  const shown = intoolsData.groups.reduce(
    (n, g) => n + g.tools.filter((t) => intoolsMatch(t, kw)).length, 0
  );

  // 顶部一行汇总 —— 36 个工具是怎么分的, 一眼能看出来
  if (sumEl) {
    const parts = intoolsData.groups.map((g) => `${g.label} ${g.count}`);
    sumEl.innerHTML = `
      <div class="intools-stat">
        <span class="intools-stat-num">${kw ? shown + ' / ' + total : total}</span>
        <span class="intools-stat-label">${kw ? '个工具匹配' : '个内部工具'}</span>
      </div>
      <div class="intools-stat-side">
        <div>${parts.map(escapeHtml).join(' · ')}</div>
        <div class="muted">${intoolsData.shared.length} 个工具被多个智能体共用</div>
      </div>
    `;
  }

  if (!shown) {
    groupsEl.innerHTML = '<div class="empty-block">没有匹配的工具。</div>';
    return;
  }

  groupsEl.innerHTML = '';
  for (const g of intoolsData.groups) {
    const hits = g.tools.filter((t) => intoolsMatch(t, kw));
    if (!hits.length) continue;

    const sec = document.createElement('section');
    sec.className = 'intools-group';
    sec.innerHTML = `
      <header class="intools-group-head">
        <div class="intools-group-title">
          ${escapeHtml(g.label)}
          <span class="intools-group-count">${hits.length}${kw ? ' / ' + g.count : ''} 个</span>
        </div>
        <div class="intools-group-desc">${escapeHtml(g.desc)}</div>
        <div class="intools-group-src">定义在 <code>${escapeHtml(g.where)}</code></div>
      </header>
      <div class="intools-tools"></div>
    `;
    const box2 = sec.querySelector('.intools-tools');
    for (const t of hits) box2.appendChild(internalToolNode(t));
    groupsEl.appendChild(sec);
  }
}

/** 单个工具卡片 */
function internalToolNode(t) {
  const el = document.createElement('div');
  el.className = 'intools-tool';

  const badges = [];
  // 只读 = 能并发跑; 串行 = 会碰外部世界, 一次只跑一个。见 lib/tools.js 的 canParallel
  badges.push(t.readOnly
    ? '<span class="intools-badge is-ro" title="只读工具，多个可以并发执行">只读</span>'
    : '<span class="intools-badge is-serial" title="会碰外部世界（数据库/弹窗/流程卡），强制串行执行">串行</span>');
  if (t.groupLabel) badges.push(`<span class="intools-badge is-group">${escapeHtml(t.groupLabel)}</span>`);
  if (t.shared) {
    badges.push(`<span class="intools-badge is-shared" title="同时被 ${escapeHtml(t.sharedWith.join('、'))} 使用">共用</span>`);
  }

  const params = (t.params || []).length
    ? `<div class="intools-params">${t.params.map((p) => {
        const req = p.required ? '<span class="intools-req" title="必填">*</span>' : '';
        const en = p.enum && p.enum.length
          ? `<span class="intools-enum">${p.enum.map(escapeHtml).join(' | ')}</span>`
          : `<span class="intools-ptype">${escapeHtml(p.type)}</span>`;
        return `<span class="intools-param" title="${escapeHtml(p.desc || '')}">`
          + `<code>${escapeHtml(p.name)}</code>${req}${en}</span>`;
      }).join('')}</div>`
    : '<div class="intools-params"><span class="muted">无参数</span></div>';

  el.innerHTML = `
    <div class="intools-tool-head">
      <code class="intools-name">${escapeHtml(t.name)}</code>
      <span class="intools-badges">${badges.join('')}</span>
    </div>
    <div class="intools-desc">${renderPromptText(t.description)}</div>
    ${params}
  `;
  return el;
}

function openMcpModal() {
  $('mcpName').value = '';
  $('mcpCommand').value = '';
  $('mcpEnv').value = '';
  setMcpStatus('');
  $('modalMcp').hidden = false;
  $('mcpCommand').focus();
}
function closeMcpModal() {
  $('modalMcp').hidden = true;
}

function setMcpStatus(msg, kind) {
  const el = $('mcpFormStatus');
  if (!el) return;
  el.textContent = msg || '';
  el.className = 'form-status' + (kind ? ' ' + kind : '');
}

/** 把 "KEY=VALUE" 的多行文本转成对象 */
function parseEnvText(text) {
  const env = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return env;
}

async function saveMcp() {
  const name = $('mcpName').value.trim();
  const commandLine = $('mcpCommand').value.trim();
  const env = parseEnvText($('mcpEnv').value);
  if (!commandLine) {
    setMcpStatus('请填写启动命令', 'err');
    return;
  }
  setMcpStatus('正在保存...');
  const res = await api.mcp.add({ name, commandLine, env });
  if (!res || !res.ok) {
    setMcpStatus((res && res.error) || '保存失败', 'err');
    return;
  }
  closeMcpModal();
  toast('已添加外部工具服务');
  renderMcpList();
}

// ============== 设置 ==============

// 当前停在哪个设置面板; 提示词编辑区的草稿状态
let settingsPane = 'model';
let promptSets = [];          // 服务端给的三套: [{ id, label, hint, modules }]
let activeSetId = 'chat';     // 正在编辑哪一套 (chat / builder / tester)
let promptModules = [];       // **派生**: 当前这一套的模块快照
let promptDraft = {};         // 本地草稿: { setId: { moduleId: { text, enabled } } } —— 只放被改过的
let activePromptId = null;
let promptDirty = false;

/** 把 promptModules 切到 activeSetId 那一套, 并保证 activePromptId 落在有效模块上 */
function syncActiveModules() {
  const s = promptSets.find((x) => x.id === activeSetId);
  promptModules = (s && s.modules) || [];
  const first = promptModules.find((m) => m.id === activePromptId) || promptModules[0];
  activePromptId = first ? first.id : null;
}

/** 这一套的草稿包 */
function draftOf(setId) {
  const id = setId || activeSetId;
  if (!promptDraft[id]) promptDraft[id] = {};
  return promptDraft[id];
}

/** 某一套里有没有改过的模块 (给切换按钮上的"已改"小标用) */
function setHasChanges(setId) {
  const d = promptDraft[setId];
  if (d && Object.keys(d).length) return true;
  const s = promptSets.find((x) => x.id === setId);
  return !!(s && s.modules.some((m) => m.changed || !m.enabled));
}

function switchSettingsPane(pane) {
  settingsPane = pane;
  $$('#settingsNav .subnav-tab').forEach((b) => b.classList.toggle('active', b.dataset.pane === pane));
  $$('#settingsBody .settings-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === pane));
  // 关于页的内容是纯本地数据, 但版本号要问一次主进程; 停在别的页签时不必问
  if (pane === 'about') renderAbout();
}

function renderSettings() {
  renderModelList();
  renderModelPick();
  renderGeneralForm();
  renderBuilderForm();
  switchSettingsPane(settingsPane);
  // 只有没在编辑时才重新拉提示词, 免得把用户正在敲的内容冲掉
  if (!promptDirty) loadPrompt();
}

// ---- 提示词 ----

async function loadPrompt() {
  const snap = await api.prompt.get();
  promptSets = (snap && snap.sets) || [];
  promptDraft = {};
  // 上次停在的那一套要是还在, 就接着停在那儿
  if (!promptSets.some((s) => s.id === activeSetId)) {
    activeSetId = promptSets.length ? promptSets[0].id : null;
  }
  syncActiveModules();
  renderPromptSets();
  renderPromptModules();
  renderPromptEditor();
}

/** 三套之间的切换按钮。改过的会带一个"已改"小标, 不然切来切去会忘了改过哪套。 */
function renderPromptSets() {
  const box = $('promptSets');
  if (!box) return;
  box.innerHTML = '';
  for (const s of promptSets) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'ps-item' + (s.id === activeSetId ? ' active' : '');
    item.dataset.id = s.id;
    item.title = s.hint || '';
    item.innerHTML = `
      <span class="ps-label">${escapeHtml(s.label)}</span>
      ${setHasChanges(s.id) ? '<span class="pm-changed">已改</span>' : ''}
    `;
    item.addEventListener('click', () => selectPromptSet(s.id));
    box.appendChild(item);
  }
  const cur = promptSets.find((s) => s.id === activeSetId);
  const hint = $('promptSetHint');
  if (hint) hint.textContent = cur ? (cur.hint || '') : '';
}

function selectPromptSet(id) {
  if (id === activeSetId) return;
  commitEditorToDraft();
  activeSetId = id;
  activePromptId = null;    // 换套之后原来选中的模块 id 可能不存在
  syncActiveModules();
  renderPromptSets();
  renderPromptModules();
  renderPromptEditor();
}

function renderPromptModules() {
  const box = $('promptModules');
  if (!box) return;
  box.innerHTML = '';
  for (const m of promptModules) {
    const item = document.createElement('button');
    const changed = isDraftChanged(m);
    item.className = 'pm-item' + (m.id === activePromptId ? ' active' : '') + (m.enabled ? '' : ' off');
    item.dataset.id = m.id;
    item.innerHTML = `
      <span class="pm-dot"></span>
      <span class="pm-label">${escapeHtml(m.label)}</span>
      ${m.critical ? '<span class="lock-tag" title="协议/安全边界, 只能改文字不能关闭">锁</span>' : ''}
      ${changed ? '<span class="pm-changed">已改</span>' : ''}
    `;
    item.addEventListener('click', () => selectPromptModule(m.id));
    box.appendChild(item);
  }
}

/** 这个模块相对出厂值有没有被改过 (文本改动或关闭) */
function isDraftChanged(m) {
  const d = draftOf()[m.id];
  if (d) {
    if (typeof d.text === 'string' && d.text !== m.defaultText) return true;
    if (d.enabled === false) return true;
    return false;
  }
  return !!m.changed || !m.enabled;
}

function selectPromptModule(id) {
  if (id === activePromptId) return;
  commitEditorToDraft();
  activePromptId = id;
  renderPromptModules();
  renderPromptEditor();
}

/** 把编辑区当前内容收进草稿 (切模块/切套/保存前调用) */
function commitEditorToDraft() {
  if (!activePromptId) return;
  const m = promptModules.find((x) => x.id === activePromptId);
  if (!m) return;
  const text = $('peText').value;
  const enabled = $('peEnabled').checked;
  const d = draftOf();
  const entry = {};
  if (text !== m.defaultText) entry.text = text;
  if (!enabled && !m.critical) entry.enabled = false;
  if (Object.keys(entry).length) d[activePromptId] = entry;
  else delete d[activePromptId];
  // 收进草稿就算动过 —— 切模块/切套之后 renderSettings 不该再把服务端的值拉回来盖掉它
  promptDirty = true;
}

function renderPromptEditor() {
  const m = promptModules.find((x) => x.id === activePromptId);
  if (!m) {
    $('peTitle').textContent = '—';
    $('peSummary').textContent = '';
    $('peText').value = '';
    return;
  }
  const d = draftOf()[m.id] || {};
  $('peTitle').innerHTML = escapeHtml(m.label) + (m.critical ? ' <span class="lock-tag">锁</span>' : '');
  $('peSummary').textContent = m.summary || '';
  $('peText').value = typeof d.text === 'string' ? d.text : m.text;
  const cb = $('peEnabled');
  cb.checked = d.enabled === false ? false : m.enabled;
  // critical 模块不能关, 开关置灰并说明
  cb.disabled = !!m.critical;
  cb.closest('.switch').classList.toggle('disabled', !!m.critical);
  cb.title = m.critical ? '这段承载协议与安全边界, 关掉会让智能体不守规矩, 所以只能改文字' : '停用这个模块';
  $('peRestore').disabled = !(typeof d.text === 'string' || d.enabled === false);
  updatePromptHint();
}

function onModuleToggle() {
  if (!activePromptId) return;
  const m = promptModules.find((x) => x.id === activePromptId);
  if (m && m.critical) {
    $('peEnabled').checked = true; // 兜底: critical 不允许关
    return;
  }
  updatePromptHint();
}

function updatePromptHint() {
  const m = promptModules.find((x) => x.id === activePromptId);
  if (!m) return;
  const text = $('peText').value;
  const parts = [];
  if (text !== m.defaultText) parts.push('已改动');
  if (!$('peEnabled').checked) parts.push('已停用');
  parts.push('字数 ' + text.length);
  $('peHint').textContent = parts.join(' · ');
}

function restoreCurrentModule() {
  const m = promptModules.find((x) => x.id === activePromptId);
  if (!m) return;
  delete draftOf()[m.id];
  $('peText').value = m.defaultText;
  $('peEnabled').checked = true;
  renderPromptSets();
  renderPromptModules();
  renderPromptEditor();
  setPromptStatus('已恢复 ' + m.label + ' 的出厂内容 (记得保存)');
}

async function savePrompt() {
  commitEditorToDraft();
  setPromptStatus('正在保存...');
  const res = await api.prompt.save({ sets: promptDraft });
  if (!res || !res.ok) {
    setPromptStatus('保存失败', 'err');
    return;
  }
  promptSets = (res && res.sets) || [];
  promptDraft = {};
  promptDirty = false;
  syncActiveModules();
  renderPromptSets();
  renderPromptModules();
  renderPromptEditor();
  setPromptStatus('已保存, 下次任务生效', 'ok');
  toast('提示词已保存');
}

async function resetPrompt() {
  if (!(await askConfirm({
    title: '恢复出厂提示词?',
    message: '三套提示词 (对话 / 搭建 / 测试) 的改动都会丢失。',
    detail: '恢复后回到软件自带的版本。你自己改过的措辞、加过的规则都要重新写。',
    okText: '恢复出厂',
    tone: 'danger'
  }))) return;
  const res = await api.prompt.reset();
  if (!res || !res.ok) {
    setPromptStatus('恢复失败', 'err');
    return;
  }
  promptSets = (res && res.sets) || [];
  promptDraft = {};
  promptDirty = false;
  syncActiveModules();
  renderPromptSets();
  renderPromptModules();
  renderPromptEditor();
  setPromptStatus('已恢复出厂设置', 'ok');
  toast('提示词已恢复出厂');
}

function openPromptPreview() {
  commitEditorToDraft();
  // 用草稿在本地拼一份, 让用户看到"改完保存后会是什么样", 不必先保存
  const d = draftOf();
  const parts = promptModules
    .map((m) => {
      const ov = d[m.id] || {};
      const text = typeof ov.text === 'string' ? ov.text : m.text;
      const enabled = ov.enabled === false ? false : m.enabled;
      return { label: m.label, enabled, text: (text || '').trim() };
    })
    .filter((x) => x.enabled && x.text);
  $('promptPreview').textContent = parts.map((p) => p.text).join('\n\n');
  const setName = (promptSets.find((s) => s.id === activeSetId) || {}).label || '';
  const runtimeNote = activeSetId === 'chat'
    ? ''
    : ' ({{...}} 那几处是运行时填的真实内容, 这里显示的是占位符本身)';
  $('promptPreviewHint').textContent = parts.length
    ? `${setName} · 共 ${parts.length} 个模块参与拼装: ` + parts.map((p) => p.label).join(' / ') + runtimeNote
    : '所有模块都被停用了, 提示词为空 —— 这不是一个可用的状态。';
  $('modalPrompt').hidden = false;
}

function setPromptStatus(msg, kind) {
  const el = $('promptStatus');
  if (!el) return;
  el.textContent = msg || '';
  el.className = 'form-status' + (kind ? ' ' + kind : '');
}

// ---- 通用 ----

async function renderGeneralForm() {
  const res = await api.general.get();
  const g = (res && res.general) || {};
  $('genMaxSteps').value = g.maxSteps;
  $('genMaxRounds').value = g.maxRounds;
  $('genHistoryTurns').value = g.historyTurns;
}

async function saveGeneral() {
  const res = await api.general.save({
    maxSteps: Number($('genMaxSteps').value),
    maxRounds: Number($('genMaxRounds').value),
    historyTurns: Number($('genHistoryTurns').value)
  });
  const el = $('generalStatus');
  if (!res || !res.ok) {
    el.textContent = '保存失败';
    el.className = 'form-status err';
    return;
  }
  // 回填被夹取后的值, 让用户看到真实生效的数字
  $('genMaxSteps').value = res.general.maxSteps;
  $('genMaxRounds').value = res.general.maxRounds;
  $('genHistoryTurns').value = res.general.historyTurns;
  el.textContent = '已保存';
  el.className = 'form-status ok';
  toast('通用设置已保存');
}

// ---- 搭建流程卡 ----

async function renderBuilderForm() {
  const res = await api.builder.get();
  const b = (res && res.builder) || {};
  $('buildMaxSteps').value = b.maxSteps;
  $('buildMaxRounds').value = b.maxRounds;
}

async function saveBuilder() {
  const res = await api.builder.save({
    maxSteps: Number($('buildMaxSteps').value),
    maxRounds: Number($('buildMaxRounds').value)
  });
  const el = $('builderStatus');
  if (!res || !res.ok) {
    el.textContent = '保存失败';
    el.className = 'form-status err';
    return;
  }
  // 回填夹取后的值 —— 用户填 9999 会看到它变成 120, 而不是以为存进去了
  $('buildMaxSteps').value = res.builder.maxSteps;
  $('buildMaxRounds').value = res.builder.maxRounds;
  el.textContent = '已保存';
  el.className = 'form-status ok';
  toast('搭建设置已保存');
}

// ============== 设置 · 关于 ==============

/**
 * 出厂数据: 产品简介 + 更新日志。和 markdown 渲染器一样是"两处共用一份",
 * 浏览器侧挂在 window.SoloChangelog 上 (见 lib/changelog.js 的 UMD 外壳)。
 *
 * 这里留一份空壳兜底: 脚本没加载上时页面不该整块白掉 —— 「关于」页最该做到的事
 * 就是"在出问题的时候还能告诉人装的是什么版本"。
 */
const CHANGELOG = window.SoloChangelog || {
  ABOUT: {},
  ENTRIES: [],
  tagStyle: () => ({ label: '变更', fg: '#4b5563', bg: '#f3f4f6' }),
  sortedEntries: () => []
};

let appInfo = null;           // 主进程给的应用信息 (真实版本号、配置目录), 拉一次缓存住
let updateFeedSaved = '';     // 已落盘的更新源地址
let changelogSelected = null; // 更新日志页当前选中的版本号

/** 版本号只按数字段比大小, 顺带把 v 前缀和后缀 (-beta) 去掉 */
function versionParts(v) {
  return String(v || '').trim().replace(/^v/i, '').split('-')[0].split('.')
    .map((x) => parseInt(x, 10) || 0);
}

async function loadAppInfo() {
  if (appInfo) return appInfo;
  try {
    const res = await api.app.info();
    appInfo = (res && res.info) || {};
  } catch (_) {
    appInfo = {};
  }
  return appInfo;
}

function renderAbout() {
  const about = CHANGELOG.ABOUT || {};
  $('aboutSlogan').textContent = about.slogan || '';
  $('aboutSummary').textContent = about.summary || '';

  const hl = $('aboutHighlights');
  hl.innerHTML = (about.highlights || [])
    .map((t) => `<li>${escapeHtml(t)}</li>`).join('');

  renderAboutChangelog();
  renderAboutMeta(about);
  renderUpdateForm();
}

/** 版本 / 许可 / 配置目录。三段都短, 一行放得下。 */
async function renderAboutMeta(about) {
  const info = await loadAppInfo();
  const box = $('aboutMeta');
  if (!box) return;
  const bits = [];
  if (info.version) bits.push(`<span class="about-meta-item">版本 <b>v${escapeHtml(info.version)}</b></span>`);
  if (about.license) bits.push(`<span class="about-meta-item">许可 ${escapeHtml(about.license)}</span>`);
  if (info.configPath) {
    bits.push(`<span class="about-meta-item" title="${escapeHtml(info.configPath)}">配置 <code>${escapeHtml(info.configPath)}</code></span>`);
  }
  box.innerHTML = bits.join('');

  // 版本号和日志对不上时明说。发版时忘了加日志是很常见的事, 而这一页存在的
  // 意义就是"版本对得上", 让它悄悄错着比报错更糟。
  const latest = (CHANGELOG.sortedEntries()[0] || {}).version;
  const v = $('aboutVersion');
  if (v) v.textContent = info.version ? ` v${info.version}` : '';
  const drift = (info.version && latest && versionParts(info.version).join('.') !== versionParts(latest).join('.'))
    ? `<div class="about-drift">更新日志最新一条是 v${escapeHtml(latest)}，当前运行的却是 v${escapeHtml(info.version)} —— 多半是发版时漏了日志。</div>`
    : '';
  if (drift) box.insertAdjacentHTML('afterend', drift);
  else {
    const old = box.parentElement && box.parentElement.querySelector('.about-drift');
    if (old) old.remove();
  }
}

/**
 * 一条日志的渲染。样式是固定的三段式 (维护者按这个格式写 lib/changelog.js):
 *   第一行 更新时间 (年月日时分) → 第二行 版本号 → 下面是无序列表, 每行前面一个标签。
 *
 * 关于页和更新日志页共用这一个函数 —— 两处各写一遍迟早会长得不一样。
 */
function logEntryHtml(entry) {
  const changes = (entry.changes || []).map((c) => {
    const st = CHANGELOG.tagStyle(c.tag);
    return `<li><span class="log-tag" style="color:${st.fg};background:${st.bg}">`
      + `${escapeHtml(st.label)}</span><span class="log-text">${escapeHtml(c.text)}</span></li>`;
  }).join('');
  const title = entry.title ? `<span class="log-title">${escapeHtml(entry.title)}</span>` : '';
  return `<div class="log-time">${escapeHtml(entry.time || '')}</div>`
    + `<div class="log-version">v${escapeHtml(entry.version || '')}${title}</div>`
    + `<ul class="log-changes">${changes}</ul>`;
}

/** 关于页只放最近两条: 这一页是"确认版本", 不是读史书 */
function renderAboutChangelog() {
  const box = $('aboutChangelog');
  if (!box) return;
  const entries = CHANGELOG.sortedEntries().slice(0, 2);
  if (!entries.length) {
    box.innerHTML = '<div class="empty-block">还没有更新日志</div>';
    return;
  }
  box.innerHTML = entries.map((e) => (
    `<div class="log-entry" data-version="${escapeHtml(e.version || '')}" title="点开看这个版本的完整日志">`
    + `${logEntryHtml(e)}<div class="log-more">查看完整日志 →</div></div>`
  )).join('');
  box.querySelectorAll('.log-entry').forEach((el) => {
    el.addEventListener('click', () => openChangelog(el.dataset.version));
  });
}

// ---- 更新日志页 (左侧按年月日时分排的版本菜单) ----

function openChangelog(version) {
  const entries = CHANGELOG.sortedEntries();
  changelogSelected = version || (entries[0] || {}).version || null;
  switchView('changelog');
}

async function renderChangelogPage() {
  const entries = CHANGELOG.sortedEntries();
  const menu = $('changelogMenu');
  const detail = $('changelogDetail');
  if (!menu || !detail) return;

  if (!entries.length) {
    menu.innerHTML = '';
    detail.innerHTML = '<div class="empty-block">还没有更新日志</div>';
    return;
  }
  if (!entries.some((e) => e.version === changelogSelected)) {
    changelogSelected = entries[0].version;
  }
  // 菜单里那个「当前」小标要靠主进程给的版本号。这一步必须在画之前 ——
  // 否则第一帧画出来是没标的, 得切一次版本才补上, 看着像"漏了"。
  const info = await loadAppInfo();
  const running = (info && info.version) || '';
  const runningKey = running ? versionParts(running).join('.') : '';

  menu.innerHTML = entries.map((e) => {
    const isNow = runningKey && versionParts(e.version).join('.') === runningKey;
    return `<button type="button" class="log-menu-item${e.version === changelogSelected ? ' active' : ''}" `
      + `data-version="${escapeHtml(e.version || '')}">`
      + `<span class="lmi-time">${escapeHtml(e.time || '')}</span>`
      + `<span class="lmi-version">v${escapeHtml(e.version || '')}`
      + `${isNow ? '<span class="lmi-now">当前</span>' : ''}</span></button>`;
  }).join('');

  menu.querySelectorAll('.log-menu-item').forEach((el) => {
    el.addEventListener('click', () => {
      changelogSelected = el.dataset.version;
      renderChangelogPage();
    });
  });

  const cur = entries.find((e) => e.version === changelogSelected);
  detail.innerHTML = `<div class="log-detail-head">${logEntryHtml(cur)}</div>`;
}

// ---- 检查更新 ----

function setUpdateStatus(text, kind) {
  const el = $('updateStatus');
  if (!el) return;
  el.textContent = text;
  el.className = 'form-status' + (kind ? ' ' + kind : '');
}

function setUpdateStatusHtml(html, kind) {
  const el = $('updateStatus');
  if (!el) return;
  el.innerHTML = html;
  el.className = 'form-status' + (kind ? ' ' + kind : '');
}

async function renderUpdateForm() {
  let cur = { feedUrl: '' };
  try {
    const res = await api.update.get();
    cur = (res && res.update) || cur;
  } catch (_) { /* 拿不到就当没配过, 下面那行提示本身就是引导 */ }
  updateFeedSaved = cur.feedUrl || '';
  const input = $('updateFeed');
  // 不要盖掉用户正在敲的内容
  if (input && document.activeElement !== input) input.value = updateFeedSaved;
  setUpdateStatus(updateFeedSaved
    ? '已配置更新源。点「检查更新」看看有没有新版本。'
    : '还没配置更新源 —— 填一个内网地址, 或找维护者要。', '');
}

/** 把输入框里的地址存下来。返回当前生效的地址。 */
async function saveUpdateFeed() {
  const input = $('updateFeed');
  if (!input) return '';
  const typed = (input.value || '').trim();
  if (typed === updateFeedSaved) return updateFeedSaved;

  const res = await api.update.set({ feedUrl: typed });
  if (!res || !res.ok) {
    setUpdateStatus('更新源保存失败', 'err');
    return updateFeedSaved;
  }
  const saved = (res.update && res.update.feedUrl) || '';
  updateFeedSaved = saved;
  // 填了东西却存成空 —— 一定是格式被归一化挡掉了。必须说清楚,
  // 否则用户看到的是"我明明填了, 关掉再打开就没了"。
  if (typed && !saved) {
    input.value = '';
    setUpdateStatus('更新源只支持 http:// 或 https:// 开头的地址。', 'err');
    return '';
  }
  input.value = saved;
  toast(saved ? '更新源已保存' : '已清空更新源');
  return saved;
}

async function checkUpdate() {
  const feedUrl = await saveUpdateFeed();
  if (!feedUrl) {
    if (!(($('updateStatus') || {}).textContent || '').includes('只支持')) {
      setUpdateStatus('还没配置更新源。', 'err');
    }
    return;
  }
  const btn = $('btnCheckUpdate');
  btn.disabled = true;
  setUpdateStatus('正在检查…', '');
  try {
    const res = await api.update.check({ feedUrl });
    if (!res || !res.ok) {
      setUpdateStatus('检查失败：' + ((res && res.error) || '未知错误'), 'err');
      return;
    }
    const r = res.remote || {};
    if (res.hasUpdate) {
      const when = r.publishedAt ? `（${escapeHtml(r.publishedAt)} 发布）` : '';
      // 地址由主进程校验过只可能是 http(s), 这里再确认一次才拼进 href
      const link = /^https?:\/\//i.test(r.url || '')
        ? ` <a class="update-link" href="${escapeHtml(r.url)}" target="_blank" rel="noreferrer">打开下载页</a>`
        : '';
      setUpdateStatusHtml(`发现新版本 <b>v${escapeHtml(r.version)}</b>${when}，当前 v${escapeHtml(res.current)}。${link}`, 'ok');
    } else {
      setUpdateStatus(`已是最新版本（v${escapeHtml(res.current)}）。`, 'ok');
    }
  } catch (e) {
    setUpdateStatus('检查失败：' + (e && e.message ? e.message : e), 'err');
  } finally {
    btn.disabled = false;
  }
}

function renderChat() {
  const thread = $('chatThread');
  applyEmptyLayout(!state.conversation.length);
  if (!state.conversation.length) {
    thread.innerHTML = '';
    chatNodes = [];
    thread.appendChild(emptyState());
    renderConvLimitBanner();
    renderConvStats();
    renderCtxRing();
    renderModePick();
    syncRunStatus();
    return;
  }
  const inner = thread.querySelector('.chat-thread-inner');
  // 结构对不上 (首次渲染 / 新增消息 / 节点数不一致) 时才补齐 DOM
  if (!inner || chatNodes.length !== state.conversation.length) {
    syncChatNodes();
  } else {
    // 其余情况只刷新最后一条 (智能体正在写的那条)
    const lastIndex = state.conversation.length - 1;
    updateMessageNode(chatNodes[lastIndex], state.conversation[lastIndex], lastIndex);
    scrollChatToBottom(false);
  }
  renderConvLimitBanner();
  renderConvStats();
  renderCtxRing();
  renderModePick();
  // 每次渲染都对一次状态条。它读的是 state.running, 所以哪怕某条路径漏了收尾,
  // 下一次渲染也会把"深度探索中"收掉 —— 而不是一直骗用户说还在跑。
  syncRunStatus();
}

/**
 * 对话长度提醒。
 *
 * 两个阈值都来自主进程 (lib/conversation.js), 界面**不自己写一份数字** ——
 * 两边各写一份迟早会对不上, 而那种错很难发现: 界面上显示还能发, 发出去却被后端拒了。
 *
 * 为什么用常驻提示条而不是 toast: toast 三秒就没了。而这件事 ("你该开新会话了")
 * 恰恰是用户下次想发消息时才需要想起来的东西 —— 它得一直在那儿。
 */
function convLimit() {
  const lim = (state.config && state.config.limits) || {};
  const max = Number(lim.convMaxTurns) || 100;
  const warnAt = Number(lim.convWarnTurns) || 80;
  const turns = state.conversation.filter((m) => m.role === 'user').length;
  const blocked = turns >= max;
  const warn = !blocked && turns > warnAt;
  return {
    turns,
    max,
    warnAt,
    warn,
    blocked,
    message: blocked
      ? `这段对话已经有 ${turns} 轮了, 到了上限 (${max} 轮)。请新建会话继续 —— 不是不能再答, 是这么长的上下文里我记不清你最初要什么了。`
      : (warn ? `当前对话已超过${warnAt}轮，为了保证输出质量，建议新开会话。` : '')
  };
}

function renderConvLimitBanner() {
  const thread = $('chatThread');
  if (!thread) return;
  const st = convLimit();
  let el = thread.querySelector('.conv-limit');
  if (!st.message) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.className = 'conv-limit';
    thread.insertBefore(el, thread.firstChild);
  }
  el.classList.toggle('blocked', st.blocked);
  el.innerHTML = `<span class="conv-limit-icon">${st.blocked ? '⛔' : '⚠'}</span>`
    + `<span class="conv-limit-text">${escapeHtml(st.message)}</span>`
    + (st.blocked ? '<button type="button" class="btn btn-ghost btn-sm conv-limit-btn">新建会话</button>' : '');
  const btn = el.querySelector('.conv-limit-btn');
  if (btn) btn.addEventListener('click', () => $('btnNewChat').click());
}

// 只创建缺失的节点, 已存在的节点原样保留 —— 报告卡片的 iframe 因此不会被重载
function syncChatNodes() {
  const thread = $('chatThread');
  let inner = thread.querySelector('.chat-thread-inner');
  if (!inner) {
    thread.innerHTML = '';
    inner = document.createElement('div');
    inner.className = 'chat-thread-inner';
    thread.appendChild(inner);
  }
  // 缓存与真实 DOM 可能因外部重置而错位, 每轮先按 DOM 对齐一次, 避免残留孤儿节点
  chatNodes = chatNodes.filter((el) => el && el.parentNode === inner);
  for (const child of Array.from(inner.children)) {
    if (!chatNodes.includes(child)) inner.removeChild(child);
  }
  while (chatNodes.length > state.conversation.length) {
    const el = chatNodes.pop();
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }
  for (let i = chatNodes.length; i < state.conversation.length; i++) {
    const el = renderMessage(state.conversation[i], i);
    el.dataset.index = String(i);
    inner.appendChild(el);
    chatNodes.push(el);
  }
  scrollChatToBottom(true);
}

function scrollChatToBottom(force) {
  const thread = $('chatThread');
  const distance = thread.scrollHeight - thread.scrollTop - thread.clientHeight;
  if (force || distance < 140) thread.scrollTop = thread.scrollHeight;
}

/**
 * 空态: 一块品牌抬头。
 *
 * 输入框**不在这里** —— 它是 .wb-main 的固定成员, 靠 .wb-main.is-empty 这个类
 * 被整体居中 (见 applyEmptyLayout)。所以这里只放"品牌 + 一句话",
 * 剩下的交给 flex 去排。这也是为什么加了这个类之后, 输入框、示例、
 * 上下文圆环的相对顺序一个都没变。
 */
function emptyState() {
  const el = document.createElement('div');
  el.className = 'empty-state';
  el.innerHTML = `
    <div class="hero">
      <div class="hero-brand">
        <span class="hero-mark" aria-hidden="true">ASK</span>
        <span class="hero-name">ASKAHA</span>
      </div>
      <p class="hero-slogan">${escapeHtml(CHANGELOG.ABOUT.slogan || '假如数据会说话······')}</p>
    </div>
  `;
  return el;
}

/**
 * 空态时把输入框挪到中间。
 *
 * 做法不是搬 DOM, 而是给 .wb-main 加个类: 它的 flex 从"对话流占满、输入框贴底"
 * 变成"整块垂直居中"。这样输入框、抬头、状态条、圆环的相对顺序完全没变,
 * 只是整体被居中 —— 搬节点的方案要在两套父子关系之间来回挪, 事件绑定和
 * 展开状态都得跟着重新处理, 不划算。
 */
function applyEmptyLayout(empty) {
  const main = $('wbMain');
  if (main) main.classList.toggle('is-empty', empty);
  renderConvHead();
  renderTips();
}

function renderMessage(msg, index) {
  const el = document.createElement('div');
  el.className = 'message ' + (msg.role === 'user' ? 'user' : 'assistant');
  const label = msg.role === 'user' ? 'USER' : 'ASSISTANT';
  el.innerHTML = `<div class="msg-label">${label}</div><div class="msg-body"></div>`;
  // index 得传对: 执行过程"跑时展开、跑完收起"要靠它认出"正在跑的那一条"
  updateMessageNode(el, msg, index == null ? 0 : index);
  return el;
}

/**
 * 流式正文的实时区: 模型边生成边把字显示在这里。
 *
 * delta 事件一秒来几十次 —— 只动这一个节点, 不整条消息重渲染 (会抖滚动、打断选中)。
 * 这段字是**临时的**: delta_end 之后由 reply / report / 执行过程接棒, 它自己清空。
 */
function renderStreamText(el, msg) {
  if (!el) return;
  const text = msg && msg.streamText;
  let box = el.querySelector('.msg-stream');
  if (text) {
    if (!box) {
      box = document.createElement('div');
      box.className = 'msg-stream';
      el.appendChild(box);
    }
    const html = renderMarkdown(text);
    if (box.dataset.md !== html) {
      box.dataset.md = html;
      box.innerHTML = html;
    }
  } else if (box) {
    box.remove();
  }
}

// 把一条消息的内容同步到已有节点上, 不替换节点本身
/** 开合执行过程。用户手动定过就照用户的, 否则听自动策略 (跑时展开、跑完收起) */
function applyStepsOpen(host) {
  const want = host.dataset.stepsUser != null ? host.dataset.stepsUser : (host.dataset.stepsAuto || '0');
  host.classList.toggle('collapsed', want === '0');
  const head = host.querySelector('.steps-head');
  if (head) {
    head.title = want === '0' ? '展开执行过程' : '收起执行过程';
    head.setAttribute('aria-expanded', want === '1' ? 'true' : 'false');
  }
}

function updateMessageNode(el, msg, index) {
  if (!el || !msg) return;
  if (index != null) el.dataset.index = String(index);

  const body = el.querySelector('.msg-body');
  if (body) {
    // 用户说的话原样显示 —— 他打的星号就是星号, 不该被当成语法。
    // 助手的话走 markdown: 模型本来就按 markdown 写 (标题、加粗、列表、代码),
    // 以前当纯文本渲染, 页面上就露出一堆字面的 ** 和 ###。
    const html = msg.role === 'user'
      ? escapeHtml(msg.content || '')
      : renderMarkdown(msg.content || '');
    // 比对 html 再写, 避免每次事件刷新都重建 DOM (重建会打断选中文本)
    if (body.dataset.md !== html) {
      body.dataset.md = html;
      body.innerHTML = html;
    }
  }

  const existingSteps = el.querySelector('.steps');
  if (msg.steps && msg.steps.length) {
    let host = existingSteps;
    if (!host) {
      host = document.createElement('div');
      host.className = 'steps';
      el.appendChild(host);
    }
    // 外壳 (标题头 + 内容区) 只建一次, 之后每次只重填内容区 ——
    // 否则用户点开的那个状态会在下一次事件刷新时被抹掉。
    if (!host.querySelector('.steps-body')) {
      host.innerHTML = '';
      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'steps-head';
      const caret = document.createElement('span');
      caret.className = 'steps-caret';
      caret.textContent = '▾';
      const label = document.createElement('span');
      label.className = 'steps-label';
      head.appendChild(caret);
      head.appendChild(label);
      const bodyBox = document.createElement('div');
      bodyBox.className = 'steps-body';
      head.addEventListener('click', () => {
        const open = host.dataset.stepsUser != null
          ? host.dataset.stepsUser === '1'
          : (host.dataset.stepsAuto || '0') === '1';
        host.dataset.stepsUser = open ? '0' : '1';
        applyStepsOpen(host);
      });
      host.appendChild(head);
      host.appendChild(bodyBox);
    }
    const label = host.querySelector('.steps-label');
    const errs = msg.steps.filter((s) => s && s.error).length;
    if (label) label.textContent = '执行过程 · ' + msg.steps.length + ' 步' + (errs ? ' · ' + errs + ' 处报错' : '');
    host.classList.toggle('has-error', errs > 0);

    const bodyBox = host.querySelector('.steps-body');
    bodyBox.innerHTML = '';
    for (const s of msg.steps) bodyBox.appendChild(renderStep(s));

    // 自动策略: 正在跑的这一条展开 (能看着它滚), 跑完/历史消息收起 (只留结论)。
    // 这一步每轮都会重算, 所以运行结束时它会自己收起来。
    const isLive = state.running && index === state.conversation.length - 1;
    host.dataset.stepsAuto = isLive ? '1' : '0';
    applyStepsOpen(host);
  } else if (existingSteps) {
    existingSteps.remove();
  }

  // 报告卡片只创建一次, 避免 iframe 被反复重建
  if (msg.report && !el.querySelector('.report-card')) {
    const card = renderReport(msg.report);
    if (card) el.appendChild(card);
  }

  // 本次任务的耗时与用量。跑完之后才显示 —— 跑的时候数字一直在变,
  // 摆出来只会分散注意力 (那时候用户要看的是"它在干什么")。
  const existingStats = el.querySelector('.msg-stats');
  const hasStats = msg.role === 'assistant' && (msg.elapsedMs != null || msg.usage);
  if (hasStats) {
    let box = existingStats;
    if (!box) {
      box = document.createElement('div');
      box.className = 'msg-stats';
      el.appendChild(box);
    }
    const parts = [];
    if (msg.elapsedMs != null) parts.push(`耗时 ${fmtDurationShort(msg.elapsedMs)}`);
    if (msg.usage) {
      parts.push(`输入 ${fmtNum(msg.usage.input)} tokens`);
      parts.push(`输出 ${fmtNum(msg.usage.output)} tokens`);
    }
    box.innerHTML = parts.map((p) => `<span class="ms-item">${escapeHtml(p)}</span>`).join('');
  } else if (existingStats) {
    existingStats.remove();
  }

  // 每条助手回答下面: 参考资料 (有才显示, ≤5 条, 可折叠) + 👍/👎 (总是显示)。
  // 跑任务 / 流式进行中先不挂, 免得页脚跟着正文一起闪。
  const existingFoot = el.querySelector('.msg-foot');
  const live = state.running && index === state.conversation.length - 1;
  const showFoot = msg.role === 'assistant' && !live && (msg.qaId || (msg.ragHits || []).length);
  if (showFoot) {
    let foot = existingFoot;
    if (!foot) {
      foot = document.createElement('div');
      foot.className = 'msg-foot';
      el.appendChild(foot);
    }
    foot.innerHTML = renderMsgFoot(msg);
    const refsBox = foot.querySelector('.rag-refs');
    if (refsBox) {
      const head = refsBox.querySelector('.rag-refs-head');
      if (head) head.addEventListener('click', () => refsBox.classList.toggle('open'));
    }
    const up = foot.querySelector('[data-rfb="up"]');
    const down = foot.querySelector('[data-rfb="down"]');
    if (up) up.addEventListener('click', () => sendMsgFeedback(msg, 'up'));
    if (down) down.addEventListener('click', () => sendMsgFeedback(msg, 'down'));
  } else if (existingFoot) {
    existingFoot.remove();
  }

  // 流式正文的实时区 —— 全量渲染时也要带上它 (delta 走的是只更新这一个节点的快路径)
  renderStreamText(el, msg);
}

/** 大拇指 (SVG)。倒大拇指 = 同一个图标旋转 180° (由 CSS 处理), 不额外画一份。 */
const MSG_ICON_THUMB = '<svg class="msg-fb-svg" viewBox="0 0 16 16" aria-hidden="true">'
  + '<path d="M4.7 7.1V13.9H2.5a.9.9 0 0 1-.9-.9V8a.9.9 0 0 1 .9-.9h2.2z"/>'
  + '<path d="M4.7 7.1l2.9-4.8a1.3 1.3 0 0 1 2.4.7l-.6 2.9h3.4a1.3 1.3 0 0 1 1.3 1.6l-.9 4.3a1.3 1.3 0 0 1-1.3 1H4.7z"/>'
  + '</svg>';

/** 助手回答的页脚: 参考资料 (可折叠, ≤5 条, 小字) + 👍/👎 (SVG) */
function renderMsgFoot(msg) {
  const hits = (msg.ragHits || []).slice(0, 5);
  const refs = hits.length ? `<div class="rag-refs">
    <button type="button" class="rag-refs-head"><span class="rag-caret">▸</span>参考资料 · ${escapeHtml(msg.ragKbName || '知识库')} (${hits.length})</button>
    <div class="rag-refs-body">${hits.map((h, i) => `
      <div class="rag-ref">
        <div class="rag-ref-head">[${i + 1}] ${escapeHtml(h.docName || '')}${h.section ? ' · ' + escapeHtml(h.section) : ''}${h.folderName ? ' · ' + escapeHtml(h.folderName) : ''}<span class="rag-score">${h.score != null ? h.score : ''}</span></div>
        <div class="rag-ref-text">${escapeHtml(String(h.snippet || '').slice(0, 400))}</div>
      </div>`).join('')}</div>
  </div>` : '';
  const fbState = msg.feedback === 'up' ? '已点赞' : msg.feedback === 'down' ? '已点踩' : '';
  return `${refs}
    <div class="rag-fb">
      <button type="button" class="rag-fb-btn${msg.feedback === 'up' ? ' on' : ''}" data-rfb="up" title="有帮助">${MSG_ICON_THUMB}</button>
      <button type="button" class="rag-fb-btn${msg.feedback === 'down' ? ' on' : ''}" data-rfb="down" title="没帮助">${MSG_ICON_THUMB}</button>
      ${fbState ? `<span class="rag-fb-state">${fbState}</span>` : ''}
    </div>`;
}

/** 对话页的 👍/👎。记录 id 由主进程在跑完后生成 (msg.qaId), 没有就提示无法反馈。 */
function sendMsgFeedback(msg, verdict) {
  if (!msg.qaId) { toast('这条记录暂时无法反馈', 'err'); return; }
  if (verdict === 'up') {
    msg.feedback = 'up';
    if (window.kbSendFeedback) window.kbSendFeedback(msg.qaId, 'up', [], '');
    renderChat();
  } else {
    msg.feedback = 'down';
    renderChat();
    if (window.kbOpenFeedback) window.kbOpenFeedback(msg.qaId, msg.content);
  }
}

function renderStep(step) {
  const el = document.createElement('div');
  el.className = 'step' + (step.warn ? ' step-warn' : '');
  const tag = step.kind || 'step';
  const title = escapeHtml(step.title || step.message || tag);
  let html = `<div class="step-line">
    <span class="step-tag ${tag}">${tag.toUpperCase()}</span>
    <div class="step-content">
      <div class="step-title">${title}</div>`;
  if (step.sql) {
    html += `<div class="step-sql">${escapeHtml(step.sql)}</div>`;
  }
  if (step.why && step.why !== step.title) {
    html += `<div class="step-why">为什么: ${escapeHtml(step.why)}</div>`;
  }
  if (Array.isArray(step.fields) && step.fields.length) {
    const items = step.fields
      .map((f) => {
        const n = escapeHtml((f && f.name) || '');
        const m = escapeHtml((f && f.meaning) || '');
        return `<span class="cp-field"><code>${n}</code>${m ? `<em>${m}</em>` : ''}</span>`;
      })
      .join('');
    html += `<div class="step-fields">${items}</div>`;
  }
  if (step.table) {
    html += `<div class="step-meta">表: ${escapeHtml(step.table)}</div>`;
  }
  if (typeof step.rowCount === 'number') {
    html += `<div class="step-meta">${step.rowCount} 行 · ${step.elapsedMs} ms</div>`;
  }
  if (step.error) {
    html += `<div class="step-error">${escapeHtml(step.error)}</div>`;
  }
  // 路由层的可点选项: 点一下等于回答了那个问题, 不用打字
  if (Array.isArray(step.options) && step.options.length) {
    const items = step.options.map((o) => {
      if (o && typeof o === 'object') {
        const desc = o.desc ? `<em>${escapeHtml(o.desc)}</em>` : '';
        const ins = (o.inputs && o.inputs.length)
          ? `<span class="pick-inputs">需要: ${escapeHtml(o.inputs.join(' / '))}</span>`
          : '';
        return `<button class="btn btn-sm pick-opt" data-pick="${escapeAttr(o.label || '')}">${escapeHtml(o.label || '')}${desc}${ins}</button>`;
      }
      return `<button class="btn btn-sm pick-opt" data-pick="${escapeAttr(String(o))}">${escapeHtml(String(o))}</button>`;
    }).join('');
    html += `<div class="step-options">${items}</div>`;
  }
  if (step.message && step.kind && step.message !== step.title) {
    html += `<div class="step-meta">${escapeHtml(step.message)}</div>`;
  }
  html += `</div></div>`;
  el.innerHTML = html;
  // 选项点了就等于回答了那个问题 —— 填进输入框再走正常发送路径,
  // 这样对话记录、落盘、后续路由都跟用户手打一句完全一样。
  el.querySelectorAll('.pick-opt').forEach((b) => {
    b.addEventListener('click', () => {
      const box = $('composerInput');
      if (!box || state.running) return;
      box.value = b.dataset.pick || '';
      sendTask();
    });
  });
  return el;
}

function renderReport(report) {
  const el = document.createElement('div');
  el.className = 'report-card';

  // 没有文件的那种交付: 模型判了 output=none, 只是想知道结果 ——
  // 那就把这次查询的表直接摆出来, 不给一个空壳报告卡。
  if (!report.html && report.table) {
    el.classList.add('report-inline');
    return renderInlineTable(el, report);
  }
  // 既没有文件也没有表 (比如查询成功但零行), 就不摆卡片 ——
  // 结论正文已经写在对话里了, 下面再跟一个空壳没有意义。
  if (!report.html) return null;

  const xlsxBtn = report.xlsxBase64
    ? `<button class="btn" data-act="export-xlsx">导出 Excel</button>`
    : '';
  const warn = report.xlsxError
    ? `<div class="report-warn">Excel 生成失败: ${escapeHtml(report.xlsxError)}。可改用 HTML 或 Markdown 导出。</div>`
    : '';
  el.innerHTML = `
    <div class="report-tabs">
      <button class="report-tab active" data-tab="html">HTML 预览</button>
      <button class="report-tab" data-tab="md">Markdown</button>
      <div class="report-actions">
        ${xlsxBtn}
        <button class="btn" data-act="export-html">导出 HTML</button>
        <button class="btn" data-act="export-md">导出 MD</button>
        <button class="btn-icon" data-act="full" title="全屏预览">${icon('full')}</button>
      </div>
    </div>
    ${warn}
    <div class="report-body">
      <iframe data-pane="html" sandbox="allow-scripts" style="width:100%;height:420px;border:0;background:#fff;border-radius:8px;" srcdoc=""></iframe>
      <pre data-pane="md" class="report-md" style="display:none;"></pre>
    </div>
  `;
  const iframe = el.querySelector('iframe');
  iframe.srcdoc = report.html;
  const mdPre = el.querySelector('pre');
  mdPre.textContent = report.md;

  el.querySelectorAll('.report-tab').forEach((t) => {
    t.addEventListener('click', () => {
      el.querySelectorAll('.report-tab').forEach((x) => x.classList.toggle('active', x === t));
      const which = t.dataset.tab;
      el.querySelector('iframe').style.display = which === 'html' ? '' : 'none';
      el.querySelector('pre').style.display = which === 'md' ? '' : 'none';
    });
  });

  el.querySelector('[data-act="full"]')?.addEventListener('click', () =>
    openFullscreenHtml(report.title || '报告', report.html)
  );
  el.querySelector('[data-act="export-html"]')?.addEventListener('click', () => exportReport(report, 'html'));
  el.querySelector('[data-act="export-md"]')?.addEventListener('click', () => exportReport(report, 'md'));
  el.querySelector('[data-act="export-xlsx"]')?.addEventListener('click', async () => {
    const res = await api.report.exportXLSX({ base64: report.xlsxBase64, baseName: report.title || 'askaha-report' });
    if (res.ok) toast('Excel 已导出: ' + res.filePath);
    else if (res.error) toast('Excel 导出失败: ' + res.error, 'err');
  });
  return el;
}

/**
 * 不出文件的那种交付: 把这次查询的结果直接摆进对话。
 * 表头已经是中文 (lib/agent.js 侧走的是同一套 columnLabel), keys 留原始列名做悬浮。
 */
function renderInlineTable(el, report) {
  const t = report.table;
  const wrap = document.createElement('div');
  wrap.className = 'inline-table-wrap';

  const head = document.createElement('div');
  head.className = 'inline-table-head';
  head.innerHTML = `<span class="inline-table-title">${escapeHtml(t.title || '查询结果')}</span>`;

  const actions = document.createElement('div');
  actions.className = 'inline-table-actions';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn';
  copyBtn.textContent = '复制';
  copyBtn.addEventListener('click', async () => {
    const lines = [t.columns.join('\t')].concat(t.rows.map((r) => r.map((c) => String(c == null ? '' : c)).join('\t')));
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      toast('已复制 ' + t.rows.length + ' 行');
    } catch (e) {
      toast('复制失败', 'err');
    }
  });
  actions.appendChild(copyBtn);
  head.appendChild(actions);
  wrap.appendChild(head);

  const scroll = document.createElement('div');
  scroll.className = 'inline-table-scroll';
  const table = document.createElement('table');
  table.className = 'art-table';
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  t.columns.forEach((c, i) => {
    const th = document.createElement('th');
    th.textContent = c;
    // 中文表头 + 原始列名悬浮, 跟数据空间的表保持一致
    if (t.keys && t.keys[i] && t.keys[i] !== c) th.title = t.keys[i];
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const row of t.rows) {
    const tr = document.createElement('tr');
    for (const cell of row) {
      const td = document.createElement('td');
      const s = cell == null ? '' : String(cell);
      td.textContent = s;
      td.title = s;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  scroll.appendChild(table);
  wrap.appendChild(scroll);

  const foot = document.createElement('div');
  foot.className = 'inline-table-foot';
  const extra = t.sqlCount > 1 ? ` · 共 ${t.sqlCount} 次查询, 这里是最新一次的结果` : '';
  foot.textContent = `${t.rowCount} 行${t.truncated ? ` (显示前 ${t.rows.length} 行)` : ''}${extra}`;
  wrap.appendChild(foot);

  el.appendChild(wrap);
  return el;
}

async function exportReport(report, format) {
  const res = await api.report.export({
    html: report.html,
    md: report.md,
    baseName: report.title || 'askaha-report',
    format
  });
  if (res.ok) toast('已导出: ' + res.filePath);
  else if (res.error) toast('导出失败: ' + res.error, 'err');
}

// ============== 历史对话 ==============
async function loadConversations() {
  if (!api.conv) return;
  try {
    state.conversations = await api.conv.list();
  } catch (e) {
    state.conversations = [];
  }
  renderConvList();
}

const KIND_LABEL = { report: '报告', data: '数据', excel: 'Excel' };
function kindLabel(kind) { return KIND_LABEL[kind] || kind || '文件'; }

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const pad = (n) => String(n).padStart(2, '0');
  if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

// 侧边栏历史对话默认露这么多条, 其余的点「查看更多」展开
const CONV_PREVIEW = 5;

// 点「＋」时先落的占位对话用的名字 (主进程 main.js 里也有一份, 两边必须一致)。
// 第一轮任务发出后, 这个名字会被换成 AI 起的标题 —— 见 ensureConversation。
const NEW_CHAT_TITLE = '新对话';

function renderConvList() {
  const list = $('convList');
  if (!list) return;
  const all = state.conversations || [];
  const more = $('btnConvMore');

  if (!all.length) {
    list.innerHTML = '<div class="conv-list-empty">还没有历史对话。<br />发一次分析任务, 这里就会记下来。</div>';
    if (more) more.hidden = true;
    return;
  }

  const hiddenCount = Math.max(0, all.length - CONV_PREVIEW);
  const expanded = !!state.convExpanded;
  const items = expanded ? all : all.slice(0, CONV_PREVIEW);

  if (more) {
    more.hidden = hiddenCount === 0;
    more.textContent = expanded ? '收起' : `查看更多 (还有 ${hiddenCount} 条)`;
  }

  list.innerHTML = '';
  for (const c of items) {
    const el = document.createElement('div');
    el.className = 'conv-item' + (c.id === state.activeConversationId ? ' active' : '');
    el.dataset.id = c.id;
    // 侧边栏很窄, 会话项压成单行 (标题 + 日期)。
    // 数据库名和产物数挤不进这一行, 挪进悬浮提示。
    const dateStr = fmtTime(c.updatedAt || c.createdAt);
    el.title = [
      c.title,
      dateStr,
      c.databaseName,
      c.artifactCount ? c.artifactCount + ' 个产物' : ''
    ].filter(Boolean).join(' · ');
    el.innerHTML = `
      <div class="conv-item-title">${escapeHtml(c.title)}</div>
      <div class="conv-date">${escapeHtml(dateStr)}</div>
      <div class="conv-item-actions">
        <button class="conv-mini" data-cact="rename" title="重命名">${icon('pencil')}</button>
        <button class="conv-mini conv-mini-del" data-cact="del" title="删除">${icon('trash')}</button>
      </div>
    `;
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-cact]')) return;
      openConversation(c.id);
    });
    el.querySelector('[data-cact="rename"]').addEventListener('click', () => {
      // 注意: Electron 里 window.prompt() 是不支持的 (会直接抛错),
      // 所以重命名走自己的弹窗, 不能用 prompt。
      openRenameModal(c, async (title) => {
        await api.conv.rename({ id: c.id, title });
        await loadConversations();
        renderArtifacts();
      });
    });
    el.querySelector('[data-cact="del"]').addEventListener('click', async () => {
      if (!(await askConfirm({
        title: '删除这条对话?',
        message: `删除对话「${c.title}」?`,
        detail: '它跑出来的产物文件 (CSV / 报告) 也会一起删掉, 删了就找不回来了。',
        okText: '删除对话',
        tone: 'danger'
      }))) return;
      await api.conv.remove(c.id);
      if (state.activeConversationId === c.id) {
        state.conversation = [];
        state.activeConversationId = null;
        state.artifacts = [];
        state.activeArtifactId = null;
        // 对话没了, 它的累计用量也就没了 —— 不清的话下一条对话会继承上一段的数字
        state.convUsage = { input: 0, output: 0, calls: 0 };
  state.convCtx = 0;
        pendingStats = null;
        renderChat();
        renderArtifacts();
      }
      await loadConversations();
    });
    list.appendChild(el);
  }
}

// ============== 重命名对话 ==============
// Electron 的渲染进程不实现 window.prompt() (调用会直接抛错, 且无法降级),
// 所以这里用一个最小弹窗替代。打开时预填原名并全选, 回车即保存。
let renameCtx = null;

function openRenameModal(conv, onSave) {
  renameCtx = { id: conv.id, original: conv.title, onSave };
  const input = $('renameInput');
  input.value = conv.title || '';
  $('modalRename').hidden = false;
  input.focus();
  input.select();
}

function closeRenameModal() {
  renameCtx = null;
  $('modalRename').hidden = true;
}

async function submitRenameModal() {
  if (!renameCtx) return;
  const t = ($('renameInput').value || '').trim();
  const ctx = renameCtx;
  closeRenameModal();
  // 没改、或改空了, 都当作放弃
  if (!t || t === ctx.original) return;
  await ctx.onSave(t);
}

async function openConversation(id) {
  if (state.running) {
    toast('任务进行中, 请等它跑完再切换对话', 'err');
    return;
  }
  // 侧边栏那份历史对话在「配置」「数据空间」这些页上也一直看得见。点它的意图是
  // "我要去看这条对话", 所以必须先切到对话页。
  //
  // 以前这里只加载数据、不切视图: 在配置页点历史对话, 数据其实读进来了, 界面却还
  // 停在配置页, 表现就是"点了没反应"。切换动作要放在最前面 —— 后面两个 return
  // (点的是当前这条 / 对话坏了) 都不能把它挡掉。
  switchView('chat');
  // 点的就是当前这条: 页已经切好了, 不用再拉一遍
  if (id === state.activeConversationId) return;
  const conv = await api.conv.get(id);
  if (!conv) { toast('对话不存在或已损坏', 'err'); return; }
  state.activeConversationId = id;
  state.conversation = Array.isArray(conv.messages) ? conv.messages : [];
  // 把这条对话上次留下的智能体记忆接回来, 重开之后继续聊还是接着干
  state.agentState = conv.agentState || null;
  // 把这条对话上次选的分析范围接回来。老对话没这个字段, 回落到空数组 (= 不限制)。
  state.dbIds = Array.isArray(conv.dbIds) ? conv.dbIds.slice() : [];
  // "一个都不选"**不落盘**: 它只对紧接着的那一次发送有意义, 而那种发送会被拦下
  // (见 sendTask)。落盘再读回来会得到一个"看着没选、后端却按不限制跑"的假状态 ——
  // 那正是这套选库逻辑最怕的错。所以一律回到"全部"。
  state.dbNone = false;
  // 累计用量也要接回来。轮数和步数能从 messages 数出来, token 不能 ——
  // 它只存在于落盘的 stats 里, 不接回来"本会话用了多少"就会从 0 重新开始。
  const st = (conv.stats && typeof conv.stats === 'object') ? conv.stats : {};
  state.convUsage = {
    input: Number(st.input) || 0,
    output: Number(st.output) || 0,
    calls: Number(st.calls) || 0
  };
  // 上下文占用从**消息里**恢复, 不从 stats: stats 是累计花费 (会一直涨),
  // 占用是"最近一次提示词多大", 两者语义不同, 混用会让圆环显示成累计值。
  state.convCtx = 0;
  for (let i = state.conversation.length - 1; i >= 0; i--) {
    const c = state.conversation[i].ctx;
    if (Number.isFinite(c) && c > 0) { state.convCtx = c; break; }
  }
  pendingStats = null;
  chatNodes = [];
  renderConvList();
  renderChat();
  renderArtifacts();
  if (state.rightCollapsed && (conv.artifacts || []).length) setRightCollapsed(false);
}

// ============== 产物侧栏 ==============
/**
 * 产物按用途分两组。
 *
 * 以前是一份文件一个 tab —— 跑一次任务产出 3~4 个文件 (报告 html、数据 csv、
 * Excel) 就排成一长条, 名字还都被截断成差不多, 用户得逐个点开才知道哪个是
 * 哪个。按用途分就只剩两个 tab, 意图一目了然: 我要看结论 (报告) 还是要看
 * 原始数据 (原始表)。
 *
 * excel 归到"原始表": 它和 csv 是同一份数据的两种格式, 不是第三种东西。
 */
const ART_GROUPS = [
  { key: 'data', label: '原始表', kinds: ['data', 'excel'] },
  { key: 'report', label: '报告', kinds: ['report'] }
];

/** 某个产物属于哪一组 (认不出的归到"原始表", 因为未知文件更可能是数据) */
function artGroupOf(art) {
  for (const g of ART_GROUPS) {
    if (g.kinds.includes(art && art.kind)) return g.key;
  }
  return 'data';
}

async function renderArtifacts() {
  const tabs = $('artTabs');
  const body = $('artBody');
  if (!tabs || !body) return;

  if (!state.activeConversationId) {
    state.artifacts = [];
    state.activeArtifactId = null;
  } else {
    try {
      const res = await api.space.listArtifacts(state.activeConversationId);
      state.artifacts = (res && res.ok && res.artifacts) || [];
    } catch (e) {
      state.artifacts = [];
    }
  }

  $('btnArtFull').disabled = !state.artifacts.length;

  // 每一组里有哪些文件
  const byGroup = {};
  for (const g of ART_GROUPS) byGroup[g.key] = [];
  for (const a of state.artifacts) byGroup[artGroupOf(a)].push(a);

  // 当前这一组没了 (或还没选) 就落到第一个有内容的组。
  // 必须先算这个再挑文件 —— 否则会出现在一个空组里找文件, 找到 null。
  const nonEmpty = ART_GROUPS.filter((g) => byGroup[g.key].length);
  if (!nonEmpty.some((g) => g.key === state.artGroup)) {
    state.artGroup = nonEmpty.length ? nonEmpty[0].key : 'data';
  }

  // 选中项必须属于**当前组**, 不然切 tab 时会停在上一组的文件上 ——
  // 表现就是"切了 tab 内容没变"。
  const pool = byGroup[state.artGroup] || [];
  if (!pool.some((a) => a.id === state.activeArtifactId)) {
    state.activeArtifactId = pool.length ? pool[0].id : null;
  }

  tabs.innerHTML = '';
  if (!state.artifacts.length) {
    await renderArtifactBody(body, null);
    return;
  }

  for (const g of ART_GROUPS) {
    const items = byGroup[g.key];
    const t = document.createElement('button');
    t.className = 'art-tab' + (g.key === state.artGroup ? ' active' : '');
    t.dataset.group = g.key;
    // 空的组也画出来但禁用 —— 藏掉的话用户不知道"这次没有原始数据",
    // 只会以为这个功能没了。
    t.disabled = !items.length;
    t.innerHTML = `<span class="art-tab-label">${escapeHtml(g.label)}</span>` +
      (items.length > 1 ? `<span class="art-tab-kind">${items.length}</span>` : '');
    t.addEventListener('click', () => {
      if (!items.length) return;
      state.artGroup = g.key;
      // 切组时选中该组第一个, 不沿用上一组的 id (它根本不在这一组里)
      state.activeArtifactId = items[0].id;
      renderArtifacts();
    });
    tabs.appendChild(t);
  }

  // 同一组里有多个文件时, 在 tab 下面补一行文件条 —— 只在真有得选时才出现
  if (pool.length > 1) {
    const strip = document.createElement('div');
    strip.className = 'art-files';
    for (const a of pool) {
      const c = document.createElement('button');
      c.className = 'art-file' + (a.id === state.activeArtifactId ? ' active' : '');
      c.textContent = a.name;
      c.title = a.name;
      c.addEventListener('click', () => {
        state.activeArtifactId = a.id;
        renderArtifacts();
      });
      strip.appendChild(c);
    }
    tabs.appendChild(strip);
  }

  await renderArtifactBody(body, pool.find((a) => a.id === state.activeArtifactId) || null);
}

function shortName(name) {
  return String(name || '').replace(/\.[a-z0-9]+$/i, '');
}

/**
 * 把产物渲染进容器。html 走 iframe, csv 走表格, 其余给个提示 + 在文件夹中显示。
 * 同一份渲染逻辑被侧栏和全屏预览复用, 所以抽出来收在容器里。
 */
async function renderArtifactBody(container, art) {
  container.innerHTML = '';
  if (!art) {
    container.innerHTML = `<div class="art-hint">
      <div class="art-hint-title">暂无产物</div>
      <div>分析任务跑完后, 查询到的原始数据和生成的报告会自动归档到这里。</div>
    </div>`;
    return;
  }

  const res = await api.space.read({ conversationId: state.activeConversationId, artifactId: art.id });
  if (!res || !res.ok) {
    container.innerHTML = `<div class="art-hint">
      <div class="art-hint-title">无法读取</div>
      <div>${escapeHtml((res && res.error) || '未知错误')}</div>
    </div>`;
    return;
  }

  const ext = (art.name.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';

  // 太大了: 不读、不解析, 直接给下载。
  //
  // 主进程那边用 statSync 拿到体积就返回了, 内容根本没读 —— 所以这条路
  // 不管文件多大都是秒开的。以前这里会先把整份数据读成字符串过 IPC,
  // 再逐字符解析一遍, 最后只显示 300 行。
  if (res.tooLarge) {
    renderTooLargeHint(container, art, res);
    return;
  }

  if (ext === 'html') {
    const frame = document.createElement('iframe');
    // 高度靠 .art-frame 这条类, **不能**靠父元素的类名。
    //
    // 原来只有 `.art-body > iframe` 一条规则, 而这条渲染逻辑被三个宿主复用:
    //   对话页      #artBody            (有 .art-body)      -> 撑满
    //   全屏预览    holder(.art-body)   (有 .art-body)      -> 撑满
    //   数据空间    #spacePreviewBody   (.space-preview-body) -> **一条高度规则都没有**
    // 第三条路上 iframe 落到浏览器默认的 150px, 下面留一大片空白。
    // 把尺寸挂在 iframe 自己身上, 换宿主就不用再想这件事。
    frame.className = 'art-frame';
    // 只给 allow-scripts: 报告里的 ECharts 初始化脚本要能跑, 但不需要同源,
    // 同时给了 allow-same-origin 会让 iframe 有机会逃出沙箱 (Electron 会告警)
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.srcdoc = res.text || '';
    container.appendChild(frame);
    return;
  }

  if (ext === 'csv') {
    const parsed = parseCSV(res.text || '');
    // 归档时 CSV 表头已经写成中文, 原始列名存在 artifact.columns 里 (同序),
    // 所以这里直接按位取原名做悬浮提示; 老产物没有 columns, 才退回词表翻译。
    const labels = Object.assign({}, COMMON_COL_LABELS, (res.artifact && res.artifact.labels) || {}, (art && art.labels) || {});
    const origCols = (res.artifact && res.artifact.columns) || (art && art.columns) || [];
    const scroll = document.createElement('div');
    scroll.className = 'art-scroll';
    const wrap = document.createElement('div');
    wrap.className = 'art-table-wrap';
    const table = document.createElement('table');
    table.className = 'art-table';
    const head = document.createElement('thead');
    const hr = document.createElement('tr');
    for (let i = 0; i < parsed.header.length; i++) {
      const c = parsed.header[i];
      const th = document.createElement('th');
      let shown = c;
      let tip = '';
      const orig = origCols[i];
      if (orig && orig !== c) {
        tip = orig;
      } else if (!orig) {
        const mapped = displayColName(c, labels);
        if (mapped !== c) { shown = mapped; tip = c; }
      }
      th.textContent = shown;
      if (tip) th.title = tip;
      hr.appendChild(th);
    }
    head.appendChild(hr);
    table.appendChild(head);
    const tbody = document.createElement('tbody');
    for (const row of parsed.rows) {
      const tr = document.createElement('tr');
      for (const cell of row) {
        const td = document.createElement('td');
        td.textContent = cell;
        td.title = cell;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    scroll.appendChild(wrap);
    container.appendChild(scroll);
    const foot = document.createElement('div');
    foot.className = 'art-foot';
    const shown = parsed.rows.length;
    foot.innerHTML = `<span>${parsed.totalRows} 行 · ${parsed.header.length} 列${parsed.truncated ? ` · 预览前 ${shown} 行` : ''}</span>`;
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.style.padding = '3px 10px';
    btn.style.fontSize = '11.5px';
    btn.textContent = '在文件夹中显示';
    btn.addEventListener('click', () => revealArtifact(state.activeConversationId, art));
    foot.appendChild(btn);
    container.appendChild(foot);
    return;
  }

  if (res.text != null) {
    const pre = document.createElement('pre');
    pre.className = 'art-pre';
    pre.textContent = res.text;
    container.appendChild(pre);
    return;
  }

  // 二进制 (xlsx 等): 不解析, 直接给用户路径
  container.innerHTML = `<div class="art-hint">
    <div class="art-hint-title">${escapeHtml(art.name)}</div>
    <div>这是一份二进制文件 (${escapeHtml(fmtSize(art.size))}), 无法直接预览。</div>
    <div style="margin-top:10px;"><button class="btn" id="artHintReveal">在文件夹中显示</button></div>
  </div>`;
  container.querySelector('#artHintReveal').addEventListener('click', () => revealArtifact(state.activeConversationId, art));
}

/**
 * 产物太大 —— 不预览, 给下载。
 *
 * 说清三件事, 少一件用户就会来问:
 *   1. 为什么看不到 (有多大, 上限是多少)
 *   2. 数据有没有丢 (没丢, 下载能拿到全量)
 *   3. 点了下载会怎样 (弹另存为, 存到哪由你定)
 */
function renderTooLargeHint(container, art, res) {
  const size = fmtSize(res.size);
  const limit = fmtSize(res.limit);
  container.innerHTML = `<div class="art-hint">
    <div class="art-hint-title">${escapeHtml(art.name)}</div>
    <div class="art-hint-body">
      这份数据有 <b>${escapeHtml(size)}</b>, 超过了预览上限 (${escapeHtml(limit)})。
      直接在界面上打开会卡住, 所以这里不预览了 —— 下载到本地用 Excel
      或文本编辑器看, 数据是完整的。
    </div>
    <div class="art-hint-actions">
      <button class="btn btn-primary" id="artDownload">下载</button>
      <button class="btn" id="artTooLargeReveal">在文件夹中显示</button>
    </div>
    <div class="art-hint-note" id="artDownloadNote"></div>
  </div>`;

  const note = container.querySelector('#artDownloadNote');
  const btn = container.querySelector('#artDownload');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    note.className = 'art-hint-note';
    note.textContent = '正在保存…';
    try {
      const r = await api.space.saveAs({ conversationId: state.activeConversationId, artifactId: art.id });
      if (r && r.ok) {
        note.className = 'art-hint-note ok';
        note.innerHTML = '已保存到 <code>' + escapeHtml(r.filePath) + '</code>';
      } else if (r && r.canceled) {
        note.textContent = '';
      } else {
        note.className = 'art-hint-note err';
        note.textContent = (r && r.error) || '保存失败';
      }
    } catch (e) {
      note.className = 'art-hint-note err';
      note.textContent = '保存失败: ' + ((e && e.message) || e);
    }
    btn.disabled = false;
  });

  container.querySelector('#artTooLargeReveal')
    .addEventListener('click', () => revealArtifact(state.activeConversationId, art));
}

/**
 * 表头兜底词表。
 * 新产物归档时会带上 labels (模型声明的中文列名), 老产物只有英文列名,
 * 这里兜一层常用别名, 免得历史数据在界面上还是 total_rows 这种样子。
 */
const COMMON_COL_LABELS = {
  total_rows: '总行数', row_count: '行数', total_count: '总数', total: '总计',
  cnt: '数量', count: '数量', num: '数量', qty: '数量', quantity: '数量',
  amount: '金额', total_amount: '总金额', sum_amount: '金额合计', price: '单价',
  sum: '合计', avg: '平均', max: '最大值', min: '最小值',
  id: '编号', name: '名称', type: '类型', status: '状态',
  create_time: '创建时间', created_at: '创建时间', update_time: '更新时间',
  updated_at: '更新时间', date: '日期', day: '日期', month: '月份', year: '年份',
  supplier: '供应商', supplier_name: '供应商', vendor: '供应商',
  customer: '客户', customer_name: '客户', product: '商品', product_name: '商品',
  order_no: '订单号', order_id: '订单编号', order_count: '订单数',
  pct: '占比', percent: '占比', ratio: '占比', rate: '比率', growth: '增长率'
};

/** 某列的中文显示名; 已经是中文就原样返回 */
function displayColName(col, labels) {
  const raw = String(col == null ? '' : col).trim();
  if (!raw) return raw;
  if (/[\u4e00-\u9fa5]/.test(raw)) return raw;
  const mapped = (labels || {})[raw];
  if (mapped) return mapped;
  return COMMON_COL_LABELS[raw.toLowerCase()] || raw;
}

/** CSV 解析: 支持引号包裹、双写转义、字段内换行。预览最多 300 行。 */
function parseCSV(text, maxRows = 300) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  let total = 0;
  const pushRow = () => {
    row.push(field);
    field = '';
    if (row.length > 1 || row[0] !== '') {
      total++;
      if (rows.length < maxRows) rows.push(row);
    }
    row = [];
  };
  // 归档的 CSV 带 BOM (为了让 Excel 正确识别 UTF-8), 预览时要去掉,
  // 否则第一个表头会变成 "\ufeff日期"。
  const src = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n') {
      pushRow();
    } else if (ch === '\r') {
      // 忽略, 由 \n 收尾
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) pushRow();

  const header = rows.length ? rows[0] : [];
  const body = rows.slice(1);
  return { header, rows: body, totalRows: Math.max(0, total - (rows.length ? 1 : 0)), truncated: total - 1 > maxRows };
}

async function revealArtifact(conversationId, art) {
  const res = await api.space.reveal({ conversationId, artifactId: art.id });
  if (!res.ok) toast(res.error || '打开失败', 'err');
}

// ============== 全屏预览 ==============
let fullscreenTarget = null;

async function openFullscreen(art) {
  if (!art) return;
  fullscreenTarget = { conversationId: state.activeConversationId, artifact: art };
  $('pfKind').textContent = kindLabel(art.kind);
  $('pfTitle').textContent = art.name;
  $('pfReveal').hidden = false;
  const body = $('pfBody');
  body.innerHTML = '<div class="art-hint">正在加载…</div>';
  $('previewFull').hidden = false;
  await renderArtifactBodyInto(body, state.activeConversationId, art, true);
}

/** 对话里的报告还没归档时 (或用户没选输出格式) 直接拿内存里的 html 全屏 */
function openFullscreenHtml(title, html) {
  fullscreenTarget = null;
  $('pfKind').textContent = '报告';
  $('pfTitle').textContent = title || '报告';
  $('pfReveal').hidden = true;
  const body = $('pfBody');
  body.innerHTML = '';
  const holder = document.createElement('div');
  holder.className = 'art-body';
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.srcdoc = html || '';
  holder.appendChild(frame);
  body.appendChild(holder);
  $('previewFull').hidden = false;
}

function closeFullscreen() {
  $('previewFull').hidden = true;
  $('pfBody').innerHTML = '';
  fullscreenTarget = null;
}

/** 把产物内容渲染进 host。
 *
 * 关键在"对齐对话": renderArtifactBody 是从 state.activeConversationId 取产物的,
 * 而调用方要渲染的往往是**别的**对话里的产物 (全屏看历史对话、数据空间里点任意一个)。
 * 所以这里必须临时把 activeConversationId 拨过去, 渲染完再还回来。
 *
 * 原来只有 framed=true 那条路径做了对齐, framed=false 直接透传 —— 数据空间换成分栏
 * 预览后就撞上了: 右侧报"非法的对话 id"。
 */
async function renderArtifactBodyInto(host, conversationId, art, framed) {
  const savedConv = state.activeConversationId;
  state.activeConversationId = conversationId;
  try {
    if (!framed) {
      await renderArtifactBody(host, art);
      return;
    }
    // 宿主里预置了「正在加载…」占位, 必须先清掉再放内容。
    // 漏了这一步的话, .art-hint 是 flex:1, 会一直霸占上半屏 —— 看起来就是
    // "顶部半区永远在加载"。
    host.innerHTML = '';
    const holder = document.createElement('div');
    holder.className = 'art-body pf-card';
    host.appendChild(holder);
    await renderArtifactBody(holder, art);
  } finally {
    state.activeConversationId = savedConv;
  }
}

// ============== 数据空间 (文件浏览器) ==============

/**
 * 数据空间按"文件管理器"来呈现: 左边一棵可折叠的目录树, 右边预览选中的文件,
 * 顶上一条能点回去的目录层级。
 *
 * 树的两层对应真实的两层归档结构:
 *   一次对话 = 一个文件夹 (归档目录就是按对话分的)
 *   一个产物 = 一个文件 (报告 html / 数据 csv / Excel)
 * 所以这不是硬套的层级 —— 它就是磁盘上的样子。
 *
 * 选中态记在 spaceState 里而不是 DOM 上: 树和预览是两块独立的 DOM,
 * 靠 class 反查选中项会在重绘时丢掉 (重绘时整个子树被换掉)。
 */
const spaceState = {
  groups: [],            // api.space.list() 的原始返回
  collapsed: new Set(),  // 折叠起来的对话 id
  conv: null,            // 当前选中的对话 id
  art: null              // 当前选中的产物 id
};

/** 按对话 id 找那一组 */
function spaceGroupOf(convId) {
  return spaceState.groups.find((g) => g.conversationId === convId) || null;
}

/** 「全部展开 / 全部收起」按钮的文案跟着当前状态走 */
function syncSpaceExpandBtn() {
  const btn = $('btnSpaceExpand');
  if (!btn) return;
  const all = spaceState.groups.length;
  const collapsed = spaceState.groups.filter((g) => spaceState.collapsed.has(g.conversationId)).length;
  btn.textContent = (all > 0 && collapsed === all) ? '全部展开' : '全部收起';
  btn.disabled = all === 0;
}

/** 按产物 id 在某一组里找产物 */
function spaceArtifactOf(convId, artId) {
  const g = spaceGroupOf(convId);
  return g ? (g.artifacts || []).find((a) => a.id === artId) || null : null;
}

async function renderSpace(refresh) {
  const tree = $('spaceTree');
  if (!tree) return;
  if (refresh) tree.innerHTML = '<div class="empty-block">正在读取…</div>';

  let groups = [];
  try {
    groups = await api.space.list();
  } catch (e) {
    groups = [];
  }
  // 只留有产物的对话 —— 空文件夹没有意义
  spaceState.groups = (groups || []).filter((g) => (g.artifacts || []).length);

  // 选中的东西可能已经被删掉了, 这里做一次校正
  if (spaceState.conv && !spaceGroupOf(spaceState.conv)) {
    spaceState.conv = null;
    spaceState.art = null;
  }
  if (spaceState.art && !spaceArtifactOf(spaceState.conv, spaceState.art)) {
    spaceState.art = null;
  }
  // 首次进来默认选中第一个对话的第一份产物, 免得右边空着
  if (!spaceState.conv && spaceState.groups.length) {
    const g = spaceState.groups[0];
    spaceState.conv = g.conversationId;
    spaceState.art = (g.artifacts[0] || {}).id || null;
  }

  paintSpaceCrumbs();
  paintSpaceTree();
  await paintSpacePreview();
}

/** 顶部目录层级: 数据空间 / 对话名 / 文件名, 每层都能点 */function paintSpaceCrumbs() {
  const el = $('spaceCrumbs');
  if (!el) return;

  const g = spaceState.conv ? spaceGroupOf(spaceState.conv) : null;
  const a = g && spaceState.art ? spaceArtifactOf(spaceState.conv, spaceState.art) : null;

  const parts = [];
  parts.push(`<button class="space-crumb${g ? '' : ' is-current'}" data-crumb="root">数据空间</button>`);
  if (g) {
    const cls = a ? '' : ' is-current';
    parts.push(`<span class="space-crumb-sep">/</span>`);
    parts.push(`<button class="space-crumb${cls}" data-crumb="conv" title="${escapeAttr(g.title)}">${escapeHtml(g.title)}</button>`);
  }
  if (a) {
    parts.push(`<span class="space-crumb-sep">/</span>`);
    parts.push(`<button class="space-crumb is-current" data-crumb="file" title="${escapeAttr(a.name)}">${escapeHtml(shortName(a.name))}</button>`);
  }

  // 右侧补一句当前层的统计, 空着的时候不至于只有光秃秃一条线
  let tail = '';
  if (!g) {
    const files = spaceState.groups.reduce((n, x) => n + (x.artifacts || []).length, 0);
    tail = `${spaceState.groups.length} 个对话 · ${files} 个文件`;
  } else if (!a) {
    tail = `${(g.artifacts || []).length} 个文件`;
  }

  el.innerHTML = `<div class="space-crumb-trail">${parts.join('')}</div>`
    + (tail ? `<div class="space-crumb-tail">${escapeHtml(tail)}</div>` : '');

  el.querySelectorAll('[data-crumb]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.crumb;
      if (kind === 'root') {
        // 回到顶层: 取消选中, 树也全部收起
        spaceState.conv = null;
        spaceState.art = null;
      } else if (kind === 'conv') {
        // 退到对话层: 文件取消选中, 但把这一层展开, 好让人看见里面有啥
        spaceState.art = null;
        spaceState.collapsed.delete(spaceState.conv);
      }
      paintSpaceCrumbs();
      paintSpaceTree();
      paintSpacePreview();
    });
  });
}

/** 左侧目录树 */
function paintSpaceTree() {
  const tree = $('spaceTree');
  if (!tree) return;
  syncSpaceExpandBtn();   // 折叠状态一变, 按钮文案就要跟着变

  if (!spaceState.groups.length) {
    tree.innerHTML = '<div class="empty-block">暂无产物。<br>跑完一次分析任务后, 结果会自动归档到这里。</div>';
    return;
  }

  tree.innerHTML = '';
  for (const g of spaceState.groups) {
    const arts = g.artifacts || [];
    const collapsed = spaceState.collapsed.has(g.conversationId);
    const isSel = spaceState.conv === g.conversationId;

    // ---- 文件夹行 ----
    const folder = document.createElement('div');
    folder.className = 'space-node is-folder'
      + (collapsed ? ' is-collapsed' : '')
      + (isSel && !spaceState.art ? ' is-selected' : '')
      + (isSel ? ' is-active-path' : '');
    folder.innerHTML = `
      <span class="space-node-caret">▾</span>
      <span class="space-node-icon">${icon('folder')}</span>
      <span class="space-node-name">${escapeHtml(g.title)}</span>
      <span class="space-node-count">${arts.length}</span>
    `;
    folder.title = `${g.title}\n${fmtTime(g.updatedAt)}${g.databaseName ? ' · ' + g.databaseName : ''}`;
    folder.addEventListener('click', () => {
      // 点文件夹 = 选中它 + 切换展开 (再点一下收起)
      if (spaceState.conv === g.conversationId) {
        if (spaceState.collapsed.has(g.conversationId)) spaceState.collapsed.delete(g.conversationId);
        else spaceState.collapsed.add(g.conversationId);
      } else {
        spaceState.conv = g.conversationId;
        spaceState.collapsed.delete(g.conversationId);
      }
      spaceState.art = null;
      paintSpaceCrumbs();
      paintSpaceTree();
      paintSpacePreview();
    });
    tree.appendChild(folder);

    // ---- 文件行 ----
    if (collapsed) continue;
    for (const a of arts) {
      const sel = spaceState.conv === g.conversationId && spaceState.art === a.id;
      const file = document.createElement('div');
      file.className = 'space-node is-file' + (sel ? ' is-selected' : '');
      file.innerHTML = `
        <span class="space-node-icon">${icon('file')}</span>
        <span class="space-node-name">${escapeHtml(shortName(a.name))}</span>
        <span class="space-kind ${escapeAttr(a.kind || '')}">${escapeHtml(kindLabel(a.kind))}</span>
      `;
      file.title = `${a.name}\n${fmtSize(a.size)} · ${fmtTime(a.createdAt)}`;
      file.addEventListener('click', () => openSpaceFile(g.conversationId, a.id));
      tree.appendChild(file);
    }
  }
}

/** 点一个文件: 选中它, 并保证它所在的文件夹是展开的 */
function openSpaceFile(convId, artId) {
  spaceState.conv = convId;
  spaceState.art = artId;
  spaceState.collapsed.delete(convId);
  paintSpaceCrumbs();
  paintSpaceTree();
  paintSpacePreview();
}

/** 右侧预览 */
async function paintSpacePreview() {
  const host = $('spacePreview');
  if (!host) return;

  const g = spaceState.conv ? spaceGroupOf(spaceState.conv) : null;
  const a = g && spaceState.art ? spaceArtifactOf(spaceState.conv, spaceState.art) : null;

  // 没选文件: 给一张该对话的概览 (列出文件 + 能跳去对话)
  if (!g || !a) {
    if (!g) {
      host.innerHTML = `
        <div class="space-preview-empty">
          <div class="space-preview-empty-title">从左侧选一个文件</div>
          <div class="space-preview-empty-sub">左侧按对话分组, 展开文件夹就能看到这次分析归档下来的报告和数据。</div>
        </div>`;
      return;
    }
    const rows = (g.artifacts || []).map((x) => `
      <button class="space-file-row" data-art="${escapeAttr(x.id)}">
        <span class="space-kind ${escapeAttr(x.kind || '')}">${escapeHtml(kindLabel(x.kind))}</span>
        <span class="space-file-row-name">${escapeHtml(shortName(x.name))}</span>
        <span class="space-file-row-meta">${escapeHtml(fmtSize(x.size))} · ${escapeHtml(fmtTime(x.createdAt))}</span>
      </button>`).join('');
    host.innerHTML = `
      <div class="space-conv-overview">
        <div class="space-conv-head">
          <div class="space-conv-title">${escapeHtml(g.title)}</div>
          <div class="space-conv-meta">${escapeHtml([fmtTime(g.updatedAt), g.databaseName].filter(Boolean).join(' · '))}</div>
          <button class="btn btn-ghost btn-sm" data-open-conv>在对话中打开 →</button>
        </div>
        <div class="space-file-rows">${rows}</div>
      </div>`;
    host.querySelector('[data-open-conv]').addEventListener('click', () => {
      switchView('chat');
      openConversation(g.conversationId);
    });
    host.querySelectorAll('[data-art]').forEach((btn) => {
      btn.addEventListener('click', () => openSpaceFile(g.conversationId, btn.dataset.art));
    });
    return;
  }

  // 选了文件: 头部一行元信息 + 工具按钮, 下面放内容
  host.innerHTML = `
    <div class="space-preview-head">
      <div class="space-preview-title">
        <span class="space-kind ${escapeAttr(a.kind || '')}">${escapeHtml(kindLabel(a.kind))}</span>
        <span class="space-preview-name" title="${escapeAttr(a.name)}">${escapeHtml(shortName(a.name))}</span>
      </div>
      <div class="space-preview-meta">${escapeHtml(fmtSize(a.size))} · ${escapeHtml(fmtTime(a.createdAt))} · 来自「${escapeHtml(g.title)}」</div>
      <div class="space-preview-actions">
        <button class="btn btn-ghost btn-sm" data-pact="full">全屏</button>
        <button class="btn btn-ghost btn-sm" data-pact="reveal">在文件夹中显示</button>
        <button class="btn btn-ghost btn-sm" data-pact="del">删除</button>
      </div>
    </div>
    <div class="space-preview-body" id="spacePreviewBody">
      <div class="art-hint">正在加载…</div>
    </div>
  `;

  host.querySelector('[data-pact="full"]').addEventListener('click', () => openFullscreenOf(g.conversationId, a));
  host.querySelector('[data-pact="reveal"]').addEventListener('click', () => revealArtifact(g.conversationId, a));
  host.querySelector('[data-pact="del"]').addEventListener('click', async () => {
    if (!(await askConfirm({
      title: '删除产物?',
      message: `删除产物「${a.name}」?`,
      detail: '文件会从数据空间里移除, 删了就找不回来了。',
      okText: '删除产物',
      tone: 'danger'
    }))) return;
    await api.space.remove({ conversationId: g.conversationId, artifactId: a.id });
    if (state.activeConversationId === g.conversationId) renderArtifacts();
    await renderSpace(true);
  });

  // 走 renderArtifactBodyInto 而不是直接调 renderArtifactBody —— 它会先把
  // activeConversationId 对齐到这份产物所属的对话, 否则读到的是对话页里当前
  // 打开的那个对话, 报"非法的对话 id"。
  await renderArtifactBodyInto($('spacePreviewBody'), g.conversationId, a, false);
}

async function openFullscreenOf(conversationId, art) {
  fullscreenTarget = { conversationId, artifact: art };
  $('pfKind').textContent = kindLabel(art.kind);
  $('pfTitle').textContent = art.name;
  $('pfReveal').hidden = false;
  const body = $('pfBody');
  body.innerHTML = '<div class="art-hint">正在加载…</div>';
  $('previewFull').hidden = false;
  await renderArtifactBodyInto(body, conversationId, art, true);
}

// ============== 自动 / 手动模式 ==============

/**
 * 表选择模式。
 *
 * 存在 localStorage 而不是 config.json: 这是"我这次想怎么干活"的界面偏好,
 * 不是系统配置 —— 换台机器、换份配置不该把用户的使用习惯一起搬过去。
 *
 * 默认**手动**。默认自动的话, 第一次用的人会在毫不知情的情况下让 AI 自己挑表,
 * 而挑表依赖的备注他多半还没填 —— 那正是最容易产出"看着正常但是错的"数字的组合。
 *
 * TABLE_MODE_KEY 本身声明在文件开头 (state 之前), 原因见那儿的注释。
 */
function loadTableMode() {
  try {
    const v = localStorage.getItem(TABLE_MODE_KEY);
    return v === 'auto' ? 'auto' : 'manual';
  } catch (e) { return 'manual'; }
}

function saveTableMode(v) {
  try { localStorage.setItem(TABLE_MODE_KEY, v); } catch (e) { /* 存不下就只影响下次启动 */ }
}

/* ============== 输入框高度拖拽 ============== */

/**
 * 把一根拖拽条接到一个 textarea 上。
 *
 * 手柄放在输入框**上面**: 原生 textarea 的 resize 手柄在右下角, 而右下角
 * 正是"发送"按钮的位置, 想拉高度十次有九次会点成发送。往上拖 = 变高,
 * 方向也跟视觉一致。
 *
 * 用 pointer 事件 + setPointerCapture, 不是 mousemove:
 * 鼠标移出窗口或移得很快时 mousemove 会断, 拖到一半卡住。
 */
function bindGrip(gripId, taId, storeKey, opts) {
  const grip = $(gripId);
  const ta = $(taId);
  if (!grip || !ta) return;
  const min = (opts && opts.min) || 56;
  const maxFn = (opts && opts.max) || (() => Math.round(window.innerHeight * 0.7));

  const apply = (h) => {
    const clamped = Math.max(min, Math.min(maxFn(), Math.round(h)));
    ta.style.height = clamped + 'px';
    return clamped;
  };
  const save = (h) => { try { localStorage.setItem(storeKey, String(h)); } catch (e) {} };

  // 恢复上次的高度
  const saved = Number(localStorage.getItem(storeKey));
  if (Number.isFinite(saved) && saved >= min) ta.style.height = saved + 'px';

  let startY = 0, startH = 0, dragging = false;

  grip.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    dragging = true;
    startY = ev.clientY;
    startH = ta.offsetHeight;
    grip.classList.add('dragging');
    document.body.classList.add('resizing');
    try { grip.setPointerCapture(ev.pointerId); } catch (e) {}
  });

  grip.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    // 往上拖 (clientY 变小) 要变高, 所以是 startH - 位移
    apply(startH - (ev.clientY - startY));
  });

  const end = () => {
    if (!dragging) return;
    dragging = false;
    grip.classList.remove('dragging');
    document.body.classList.remove('resizing');
    save(ta.offsetHeight);
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);

  // 双击回到默认高度。拖歪了不用手工一点点拖回来。
  grip.addEventListener('dblclick', () => { ta.style.height = ''; save(0); });

  // 键盘也能调 —— 只给鼠标用的话键盘用户改不了
  grip.addEventListener('keydown', (ev) => {
    const step = ev.shiftKey ? 40 : 12;
    if (ev.key === 'ArrowUp') { ev.preventDefault(); save(apply(ta.offsetHeight + step)); }
    else if (ev.key === 'ArrowDown') { ev.preventDefault(); save(apply(ta.offsetHeight - step)); }
  });
  grip.tabIndex = 0;
}

/* ============== 自定义下拉 ============== */

/**
 * 为什么不用原生 <select>:
 *
 *  - 它只能显示一行纯文本。"手动 / 自动"的差别不是两个字能说清的 ——
 *    真正的差别是"要不要先问你", 那必须有一行副标题;
 *  - 模型选择同样: 光看 "deepseek-v4.1-flash" 分不清两条同名配置连的是
 *    哪个网关。副标题里带上 baseURL 的域名才分得清;
 *  - 系统原生下拉的弹出层是 OS 画的, 圆角/阴影/配色跟应用完全无关, 在
 *    Electron 里尤其突兀 —— 这正是它"丑"的来源。
 *
 * 同一时刻只允许开一个, 所以状态就是一个 openPickId。
 */
let openPickId = '';

function closePick() {
  if (!openPickId) return;
  const el = $(openPickId);
  if (el) {
    el.classList.remove('open');
    const m = el.querySelector('.pick-menu');
    if (m) m.hidden = true;
  }
  openPickId = '';
}

function openPick(id) {
  closePick();
  const el = $(id);
  if (!el || el.classList.contains('disabled')) return;
  el.classList.add('open');
  const m = el.querySelector('.pick-menu');
  if (m) {
    m.hidden = false;
    fitPickMenu(el, m);
  }
  openPickId = id;
}

function togglePick(id) {
  if (openPickId === id) closePick(); else openPick(id);
}

/* ==================== 斜杠指令补全 ====================
 *
 * 输入框以 / 开头、还没打空格时, 在它上方弹一个指令菜单。**纯 UX**: 命令清单来自
 * 主进程 (agent:commands), 解析也在主进程 —— 用户无视菜单、直接手打 /sql … 回车照样走。
 */
let slashCommands = [];
let slashItems = [];
let slashIndex = 0;
let slashOpen = false;

/** 拿不到主进程清单时的兜底 —— 保证菜单永远能用 */
const SLASH_FALLBACK = [
  { name: 'help', usage: '/help', desc: '列出这些指令' },
  { name: 'sql', usage: '/sql <需求>', desc: '强制取数分析 (跳过意图判断)' },
  { name: 'chat', usage: '/chat <话>', desc: '强制纯对话, 不碰数据库' },
  { name: 'card', usage: '/card <需求或卡名> [输入]', desc: '按需求挑一张流程卡来跑' }
];

async function loadSlashCommands() {
  try {
    slashCommands = (await api.agent.commands()) || [];
  } catch (e) {
    slashCommands = [];
  }
  if (!slashCommands.length) slashCommands = SLASH_FALLBACK.slice();
}

/** 输入框是不是"正在打一条指令" —— 以 / 起头且还没空格; 是就返回 / 后面的片段 */
function slashQuery() {
  const el = $('composerInput');
  if (!el) return null;
  const m = /^\s*\/([^\s]*)$/.exec(el.value || '');
  return m ? m[1] : null;
}

function slashRender() {
  const box = $('slashMenu');
  if (!box) return;
  if (!slashOpen) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = '';
  slashItems.forEach((c, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'slash-item' + (i === slashIndex ? ' on' : '');
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', i === slashIndex ? 'true' : 'false');
    const nm = document.createElement('span');
    nm.className = 'slash-item-name';
    nm.textContent = c.usage || ('/' + c.name);
    const ds = document.createElement('span');
    ds.className = 'slash-item-desc';
    ds.textContent = c.desc || '';
    b.appendChild(nm);
    b.appendChild(ds);
    // mousedown 而不是 click: 用 click 的话输入框先失焦、菜单先被 document 那个
    // handler 关掉, 这一下就落空了。
    b.addEventListener('mousedown', (e) => { e.preventDefault(); slashIndex = i; slashAccept(); });
    box.appendChild(b);
  });
}

/** 输入变化时重算菜单 (过滤 + 显示/隐藏) */
function slashUpdate() {
  const q = slashQuery();
  if (q == null) { slashOpen = false; slashRender(); return; }
  const lower = q.toLowerCase();
  slashItems = slashCommands.filter((c) => String(c.name).toLowerCase().startsWith(lower));
  if (!slashItems.length) { slashOpen = false; slashRender(); return; }
  if (!slashOpen) slashIndex = 0;
  slashOpen = true;
  if (slashIndex >= slashItems.length) slashIndex = 0;
  slashRender();
}

function slashMove(delta) {
  if (!slashItems.length) return;
  slashIndex = (slashIndex + delta + slashItems.length) % slashItems.length;
  slashRender();
}

function slashHide() {
  if (!slashOpen) return;
  slashOpen = false;
  slashRender();
}

/** 选中当前项: 输入框换成 /name (需要参数的补一个空格), 光标放末尾 —— **不发送** */
function slashAccept() {
  if (!slashOpen || !slashItems[slashIndex]) return;
  const el = $('composerInput');
  if (!el) return;
  const cmd = slashItems[slashIndex];
  const needsArg = cmd.name === 'sql' || cmd.name === 'chat' || cmd.name === 'card';
  el.value = '/' + cmd.name + (needsArg ? ' ' : '');
  el.focus();
  const n = el.value.length;
  try { el.setSelectionRange(n, n); } catch (e) {}
  el.dispatchEvent(new Event('input', { bubbles: true }));   // 触发高度自适应 + 关菜单
}

/**
 * 决定菜单往哪边开, 以及最高能有多高。
 *
 * CSS 默认往上开 (bottom: 100% + 8px) —— 因为选择器一般贴在页面底部。
 * 但空态时输入框是垂直居中的, 上面只剩两百多像素, 而菜单想要三百多;
 * .wb-pane 又是 overflow:hidden, 超出去的部分被直接切掉 ——
 * 用户看到的就是"菜单顶部有很大一块不见了"。
 *
 * 所以打开前先量上下各有多少空间: 哪边装得下就开哪边,
 * 两边都装不下就开在宽敞的那边, 并把 max-height 压到刚好放得下。
 */
function fitPickMenu(el, menu) {
  menu.classList.remove('pick-up', 'pick-down');
  menu.style.maxHeight = '';
  const pane = el.closest('.wb-pane');
  const pr = pane ? pane.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
  const er = el.getBoundingClientRect();
  const GAP = 8;
  const CAP = 320;
  const want = Math.min(menu.scrollHeight, CAP);
  const above = er.top - pr.top - GAP;
  const below = pr.bottom - er.bottom - GAP;

  let down;
  if (above >= want) down = false;      // 上面够, 保持默认的往上开
  else if (below >= want) down = true;  // 上面不够、下面够, 翻下去
  else down = below > above;            // 都不够, 开在宽敞的那边

  // 80 是保底: 真矮到这个程度说明面板本身就有问题, 但至少别给个 0 高度的菜单
  const room = Math.max(80, down ? below : above);
  menu.style.maxHeight = Math.min(CAP, room) + 'px';
  menu.classList.add(down ? 'pick-down' : 'pick-up');
}

/**
 * 把选项铺进菜单。
 *
 * 一律用 textContent 写文本, 不拼 innerHTML —— 模型名和 baseURL 都是用户
 * 自己填的, 拼字符串就等于给自己开一个注入口子。
 */
function fillPickMenu(el, items, currentId, onPick) {
  const menu = el.querySelector('.pick-menu');
  if (!menu) return;
  // 只有"当前正开着的那个"才保持展开。少了这一句, 重画菜单会把它重新露出来 ——
  // 启动时 renderAll 就会调到这里, 结果两个下拉的菜单一直摊在屏幕上。
  menu.hidden = openPickId !== el.id;
  menu.innerHTML = '';
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pick-item' + (it.id === currentId ? ' on' : '') + (it.warn ? ' warn' : '');
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', it.id === currentId ? 'true' : 'false');

    const main = document.createElement('span');
    main.className = 'pick-item-main';
    const t = document.createElement('span');
    t.className = 'pick-item-title';
    t.textContent = it.label;
    main.appendChild(t);
    if (it.sub) {
      const s = document.createElement('span');
      s.className = 'pick-item-sub';
      s.textContent = it.sub;
      main.appendChild(s);
    }
    const chk = document.createElement('span');
    chk.className = 'pick-item-check';
    chk.textContent = '✓';
    b.appendChild(main);
    b.appendChild(chk);

    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closePick();
      onPick(it.id);
    });
    menu.appendChild(b);
  }
}

/** 从 baseURL 里取出域名 —— 选项副标题只放域名, 整串太长会把菜单撑爆 */
function hostOf(u) {
  try { return new URL(u).host; } catch (e) { return String(u || '').replace(/^https?:\/\//, '').split('/')[0]; }
}

function renderModePick() {
  const el = $('modePick');
  if (!el) return;
  const cur = state.tableMode === 'auto' ? 'auto' : 'manual';
  el.querySelector('.pick-label').textContent = cur === 'auto' ? '自动模式' : '手动模式';
  el.classList.toggle('disabled', !!state.running);
  el.classList.toggle('is-auto', cur === 'auto');
  // 整张输入卡片也跟着描红边。"你在自动模式"这件事要一眼看见, 而不是
  // 只有左下角那个小标签在说 —— 那个标签在长任务里很容易被忽略。
  const card = document.querySelector('.composer-inner');
  if (card) card.classList.toggle('is-auto', cur === 'auto');
  el.title = cur === 'auto' ? 'AI 按表的备注自己挑表' : '每次任务前由你确认要查哪些表';
  fillPickMenu(el, [
    { id: 'manual', label: '手动模式', sub: '每次任务前, 由你确认要查哪些表' },
    { id: 'auto', label: '自动模式', sub: 'AI 按表的备注自己挑, 不再问你', warn: true }
  ], cur, onModePick);
}

/** 用户在下拉里选了另一项。切到自动要走二次确认。 */
function onModePick(next) {
  if (next === state.tableMode) return;
  if (next !== 'auto') {
    // 切回手动不需要确认 —— 它只是"更谨慎", 没有需要用户知情的副作用
    state.tableMode = 'manual';
    saveTableMode('manual');
    renderModePick();
    toast('已切回手动模式: 每次任务前由你确认要查哪些表');
    return;
  }
  // 先不动状态, 等确认了再真正切。以前是把 <select> 拨回去, 现在下拉是自绘的,
  // 没选中就不重画即可 —— 取消之后下拉上仍然是"手动模式", 不会闪。
  pendingModeSwitch = true;
  $('modalAutoMode').hidden = false;
}

function closeAutoModeModal() {
  pendingModeSwitch = false;
  $('modalAutoMode').hidden = true;
  renderModePick();
}

function confirmAutoMode() {
  pendingModeSwitch = false;
  $('modalAutoMode').hidden = true;
  state.tableMode = 'auto';
  saveTableMode('auto');
  renderModePick();
  toast('已切到自动模式: AI 会自己决定查哪些表');
}

/* ============== 这段对话只分析哪些库 ============== */

/**
 * 能参与分析的库 —— 必须**勾过至少一张表**。
 *
 * 这个条件和 lib/db-router.js 的 _activeConfs() 是同一个口径, 不能松:
 * 没勾表的库就算在这里列出来、用户选了, 后端也会把它排掉, 于是出现
 * "胶囊上写着选了 3 个库、实际只用得上 1 个"这种对不上的状态。
 */
function pickableDbs() {
  return (state.config && state.config.databases ? state.config.databases : [])
    .filter((d) => (d.tables || []).some((t) => t && t.checked && t.name));
}

/** 真正生效的选中库 id。落盘的 id 可能指向已删掉的库, 这里滤一遍。 */
function selectedDbIds() {
  const ok = new Set(pickableDbs().map((d) => d.id));
  return (state.dbIds || []).filter((id) => ok.has(id));
}

/** 一个库都没选 (「全部数据库」被点了两次之后的状态) */
function dbPickNone() {
  return state.dbNone === true && selectedDbIds().length === 0;
}

/**
 * 是不是"所有库都能查"。
 *
 * 跟 dbPickNone 互斥, 但两者的 dbIds **都是空数组** —— 差别只在 dbNone 上。
 * 所以任何"该不该按库列出全部库"的判断都必须走这里 (或 dbPickNone),
 * 不能直接写 dbIds.length === 0: 那正是"没选库"被当成"全选"的来源。
 *
 * "全列出来"也算全部: 落盘里可能存着一份把每个 id 都写上的清单 (旧版本写的,
 * 或者用户手工改过)。它跟空数组是同一个意思, 不该显示成"半勾"。
 */
function dbPickAll() {
  if (state.dbNone === true) return false;
  const sel = selectedDbIds().length;
  return sel === 0 || sel >= pickableDbs().length;
}

/** 胶囊上显示什么 */
function dbPickLabel() {
  const all = pickableDbs();
  const sel = selectedDbIds();
  if (!all.length) return '还没有勾选数据表';
  if (dbPickNone()) return '未选数据库';
  // 用 dbPickAll() 而不是 sel.length === 0: 落盘里可能存着一份把每个库都列全的
  // 清单 (旧版本写的), 它跟空数组是同一个意思, 不该显示成"已选 3 个库"。
  if (dbPickAll()) return '全部数据库';
  if (sel.length === 1) {
    const d = all.find((x) => x.id === sel[0]);
    return (d && d.name) || sel[0];
  }
  return '已选 ' + sel.length + ' 个库';
}

/**
 * 勾 / 取消一个库。
 *
 * 「全部」在内部就是空数组, 所以这里先把空数组摊开成具体清单再增删 ——
 * 否则"从全部里去掉一个"会被当成"给空清单加一个", 结果变成只选了一个。
 *
 * 但"一个都没选"时**不能摊开**: 那时候清单本来就是空的, 点一个库就该只选它;
 * 摊开的话会变成"从全部里去掉一个", 跟用户的意图正好相反。
 */
function toggleDbPick(id) {
  const all = pickableDbs();
  const sel = selectedDbIds();
  const effective = dbPickNone() ? [] : (sel.length ? sel : all.map((d) => d.id));
  const next = effective.includes(id) ? effective.filter((x) => x !== id) : effective.concat(id);
  // 三种结果分开处理。
  //
  // 以前"全选"和"一个都不选"被并成同一个含义 (都写回空数组), 于是点掉最后一个勾
  // 时状态会**跳回全选** —— 用户明明取消了它, 界面却全亮了, 像是点错了。
  // 现在: 勾满 = 不限制 (全选等于没限制, 胶囊显示"全部数据库"), 勾空 = 一个都不选
  // (留着这个状态, 发送时拦), 其它 = 具体子集。
  if (next.length === 0) {
    state.dbIds = [];
    state.dbNone = true;
  } else if (next.length >= all.length) {
    state.dbIds = [];
    state.dbNone = false;
  } else {
    state.dbIds = next;
    state.dbNone = false;
  }
  renderDbPicks();
  renderConvHead();
}

/**
 * 把库清单铺进某个 pick 的菜单里。
 *
 * 和 fillPickMenu 的区别是**点完不关菜单** —— 多选要连着勾好几个, 每勾一个
 * 就得重新点开一次会很烦。也正因为不关, 这里不能复用 fillPickMenu。
 * 文本一律 textContent, 不拼 innerHTML (库名是用户自己填的)。
 */
function fillDbMenu(el) {
  const menu = el.querySelector('.pick-menu');
  if (!menu) return;
  menu.hidden = openPickId !== el.id;
  menu.innerHTML = '';

  const all = pickableDbs();
  if (!all.length) {
    const p = document.createElement('div');
    p.className = 'pick-empty';
    p.textContent = '还没有勾选任何数据表。先去「配置 · 数据库」探测并勾选。';
    menu.appendChild(p);
    return;
  }

  const sel = selectedDbIds();
  const none = dbPickNone();
  const unlimited = dbPickAll();
  // 部分选中: 总开关要显示成"半勾", 不能显示成"没勾" —— 否则 3/5 选中的时候它
  // 跟"一个都没选"长得完全一样, 用户没法预判点下去会发生什么。
  const partial = !unlimited && !none;

  const row = (label, sub, on, handler, half) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pick-item' + (on ? ' on' : '') + (half ? ' half' : '');
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    const main = document.createElement('span');
    main.className = 'pick-item-main';
    const t = document.createElement('span');
    t.className = 'pick-item-title';
    t.textContent = label;
    main.appendChild(t);
    if (sub) {
      const s = document.createElement('span');
      s.className = 'pick-item-sub';
      s.textContent = sub;
      main.appendChild(s);
    }
    const chk = document.createElement('span');
    chk.className = 'pick-item-check';
    chk.textContent = half ? '–' : '✓';
    b.appendChild(main);
    b.appendChild(chk);
    b.addEventListener('click', (ev) => { ev.stopPropagation(); handler(); });
    return b;
  };

  // 总开关: 已经是"全部"就全部取消, 否则全选。
  //
  // 多选菜单的通用约定 —— 它是个复选框, 不是个单向按钮。以前这里只会写回空数组,
  // 于是"已经全选时再点一次"什么都不发生, 用户会以为点坏了; 也没法从"全部"
  // 干净地回到"一个都不选"再挑一个库。
  menu.appendChild(row('全部数据库',
    unlimited ? '所有勾过表的库都能查 · 再点全取消' : '所有勾过表的库都能查 · 点一下全选',
    unlimited, () => {
      if (dbPickAll()) {
        state.dbIds = [];
        state.dbNone = true;
      } else {
        state.dbIds = [];
        state.dbNone = false;
      }
      renderDbPicks();
      renderConvHead();
    }, partial));

  const sep = document.createElement('div');
  sep.className = 'pick-sep';
  menu.appendChild(sep);

  for (const d of all) {
    const n = (d.tables || []).filter((t) => t && t.checked && t.name).length;
    menu.appendChild(row(
      d.name || d.id,
      n + ' 张已勾选的表' + (d.type ? ' · ' + d.type : ''),
      // 「全部」时每个库都显示为勾上 —— 它确实都在范围内, 勾选状态要跟实际一致
      unlimited || sel.includes(d.id),
      () => toggleDbPick(d.id)
    ));
  }
}

/**
 * 知识库选择器 —— **多选**, 样式跟数据库那个 .pick 一致 (同一个组件, 同一个菜单)。
 * 两处渲染: kbPick (空态, 在输入框上方) + kbPickHead (对话抬头)。没建库就整条不显示。
 */
let kbListCache = [];
async function renderKbPick() {
  if (!api.knowledge) return;
  try { kbListCache = await api.knowledge.listKbs() || []; } catch (e) { kbListCache = []; }
  const usable = kbListCache.length > 0;
  // 选过的库若被删了, 从选择里去掉, 免得留下一个指不到的 id
  state.kbIds = (state.kbIds || []).filter((id) => kbListCache.some((k) => k.id === id));
  for (const id of ['kbPick', 'kbPickHead']) {
    const el = $(id);
    if (!el) continue;
    el.hidden = !usable;   // 没建知识库就整条不显示
    if (!usable) continue;
    const lb = el.querySelector('.pick-label');
    if (lb) lb.textContent = kbPickLabel();
    el.title = '这段对话检索哪些知识库 (可多选; 不选 = 用配置里的默认库)';
    fillKbMenu(el);
  }
}
function kbPickLabel() {
  const ids = state.kbIds || [];
  if (!ids.length) return '知识库: 默认';
  const names = ids.map((id) => (kbListCache.find((k) => k.id === id) || {}).name).filter(Boolean);
  if (!names.length) return '知识库: 默认';
  const s = names.join('、');
  return '知识库: ' + (s.length > 12 ? names.length + ' 个' : s);
}
function fillKbMenu(el) {
  const menu = el.querySelector('.pick-menu');
  if (!menu) return;
  menu.hidden = openPickId !== el.id;
  menu.innerHTML = '';
  const row = (label, sub, on, handler) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pick-item' + (on ? ' on' : '');
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    const main = document.createElement('span');
    main.className = 'pick-item-main';
    const t = document.createElement('span');
    t.className = 'pick-item-title';
    t.textContent = label;
    main.appendChild(t);
    if (sub) {
      const s = document.createElement('span');
      s.className = 'pick-item-sub';
      s.textContent = sub;
      main.appendChild(s);
    }
    const chk = document.createElement('span');
    chk.className = 'pick-item-check';
    chk.textContent = '✓';
    b.appendChild(main);
    b.appendChild(chk);
    b.addEventListener('click', (ev) => { ev.stopPropagation(); handler(); });
    return b;
  };
  menu.appendChild(row('默认', '用「配置 · 知识库」里设的默认库', !(state.kbIds || []).length, () => {
    state.kbIds = [];
    renderKbPick();
  }));
  const sep = document.createElement('div');
  sep.className = 'pick-sep';
  menu.appendChild(sep);
  for (const k of kbListCache) {
    menu.appendChild(row(k.name, (k.docCount || 0) + ' 篇文档', (state.kbIds || []).includes(k.id), () => {
      const set = new Set(state.kbIds || []);
      if (set.has(k.id)) set.delete(k.id); else set.add(k.id);
      state.kbIds = Array.from(set);
      renderKbPick();
    }));
  }
}
window.renderKbPick = renderKbPick;

/** 两处胶囊 (空态那处 + 抬头那处) 一起刷 */
function renderDbPicks() {
  const label = dbPickLabel();
  const usable = pickableDbs().length > 0;
  for (const id of ['dbPick', 'dbPickHead']) {
    const el = $(id);
    if (!el) continue;
    const lb = el.querySelector('.pick-label');
    if (lb) lb.textContent = label;
    // 没勾过表时置灰并说明原因, 而不是让人点开一个只有一行提示的空菜单
    el.classList.toggle('disabled', !usable);
    // "一个都不选"跟"全部"在胶囊上长得一模一样, 但前者发送会被拦下 ——
    // 不标出来的话, 用户看到的就是"点了没反应, 然后发不出去"。
    el.classList.toggle('is-none', usable && dbPickNone());
    el.title = !usable
      ? '还没有勾选任何数据表, 先去「配置 · 数据库」勾选'
      : (dbPickNone()
        ? '一个库都没选, 至少选一个才能查数据'
        : '这段对话只在选中的库里找表');
    fillDbMenu(el);
  }
}

/**
 * 对话抬头。
 *
 * 空态时整条隐藏 —— 那时候选库的胶囊长在输入框上方 (见 index.html 的 .composer-top)。
 * 对话一开始, "这段对话的范围是什么"就该钉在顶上, 而不是跟着输入框一起待在底部:
 * 输入框会随对话变长被推来推去, 而范围是整段对话的属性。
 */
function renderConvHead() {
  const head = $('convHead');
  const top = $('composerTop');
  const tips = $('composerTips');
  const empty = !state.conversation.length;
  if (head) head.hidden = empty;
  if (top) top.hidden = !empty;
  if (tips) tips.hidden = !empty;
}

/** 空态下面那排示例。做成按钮, 点了直接填进输入框。 */
function renderTips() {
  const box = $('composerTips');
  if (!box) return;
  const tips = [
    '统计近 30 天每天的订单数量与销售额',
    '找出销量最高的 10 个商品及其类目'
  ];
  box.innerHTML = '';
  for (const t of tips) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tip';
    b.textContent = '示例: ' + t;
    b.addEventListener('click', () => {
      const input = $('composerInput');
      if (!input) return;
      input.value = t;
      input.focus();
    });
    box.appendChild(b);
  }
}

/* ============== 通用二次确认 ============== */

/**
 * 代替原生 window.confirm。
 *
 * 为什么值得自己写一个:
 *  - 原生的长得跟应用完全无关, 在 Electron 里还会带一句"127.0.0.1:xxxx 说"的
 *    来源前缀, 看着像浏览器弹的广告, 不像这个软件在问你话;
 *  - 删库 / 删对话 / 删流程卡都是**不可逆**的, 需要一个红色按钮让人停半秒。
 *    原生 confirm 两个按钮长得一模一样, 手快就点错了;
 *  - 不能标出"连带会删掉什么"(对话的产物文件会一起没)。那种后果必须写在
 *    按钮旁边, 而不是等删完才发现。
 *
 * 返回 Promise<boolean>, 所以调用处可以照旧写成
 *   if (!(await askConfirm({...}))) return;
 */
let cfResolve = null;

function askConfirm(opts) {
  const o = opts || {};
  const modal = $('modalConfirm');
  if (!modal) return Promise.resolve(window.confirm(o.message || '确认?'));

  // 上一个还没答完就被顶掉了 (理论上不会, 但别让 Promise 永远悬着)
  if (cfResolve) { cfResolve(false); cfResolve = null; }

  $('cfTitle').textContent = o.title || '确认';
  $('cfMessage').textContent = o.message || '';
  const detail = $('cfDetail');
  if (o.detail) { detail.textContent = o.detail; detail.hidden = false; } else { detail.hidden = true; }
  $('cfCancel').textContent = o.cancelText || '取消';

  const ok = $('cfOk');
  ok.textContent = o.okText || '确定';
  // 危险操作标红。tone 缺省就是 primary —— 只有真会丢东西的才给红色,
  // 到处都红等于到处都不红。
  ok.className = 'btn ' + (o.tone === 'danger' ? 'btn-danger-solid' : 'btn-primary');
  modal.hidden = false;
  // 焦点落在"取消"上而不是"确定"上: 回车误触时默认什么都不做。
  $('cfCancel').focus();

  return new Promise((resolve) => { cfResolve = resolve; });
}

function closeConfirm(answer) {
  const modal = $('modalConfirm');
  if (modal) modal.hidden = true;
  const r = cfResolve;
  cfResolve = null;
  if (r) r(!!answer);
}

let pendingModeSwitch = false;

// ============== 模型清单 ==============

/** 当前选中的模型 (publicConfig 已经把密钥剥掉了, 这里拿到的是安全副本) */
function activeModelOf(cfg) {
  const c = (cfg || state.config || {}).llm || {};
  const models = Array.isArray(c.models) ? c.models : [];
  return models.find((m) => m.id === c.activeId) || models[0] || null;
}

function renderModelList() {
  const list = $('modelList');
  if (!list) return;
  const c = state.config.llm || {};
  const models = Array.isArray(c.models) ? c.models : [];

  if (!models.length) {
    list.innerHTML = '<div class="empty-block">还没有模型。点右上角「新增模型」加一个 —— 填上网关地址、模型名和 API Key 就能用。</div>';
    return;
  }

  list.innerHTML = '';
  for (const m of models) {
    const row = document.createElement('div');
    row.className = 'model-row' + (m.id === c.activeId ? ' active' : '');
    row.dataset.modelId = m.id;

    const main = document.createElement('div');
    main.className = 'model-main';
    const title = document.createElement('div');
    title.className = 'model-title';
    const nameEl = document.createElement('span');
    nameEl.textContent = m.name || m.model || '未命名';
    title.appendChild(nameEl);
    if (m.id === c.activeId) {
      const tag = document.createElement('span');
      tag.className = 'model-tag';
      tag.textContent = '当前使用';
      title.appendChild(tag);
    }
    if (!m.apiKeySet) {
      // 没 Key 的模型必须显眼 —— 它选了也发不出去, 而失败信息会跑到
      // 一次任务失败之后才出现, 那时候用户已经在查别的原因了
      const tag = document.createElement('span');
      tag.className = 'model-tag warn';
      tag.textContent = '缺 API Key';
      title.appendChild(tag);
    }
    const sub = document.createElement('div');
    sub.className = 'model-sub';
    sub.textContent = (m.model || '(未填模型名)') + '  ·  ' + trimBase(m.baseURL);
    sub.title = (m.model || '') + '\n' + (m.baseURL || '');
    main.appendChild(title);
    main.appendChild(sub);

    const actions = document.createElement('div');
    actions.className = 'model-actions';
    if (m.id !== c.activeId) {
      const use = document.createElement('button');
      use.className = 'btn btn-ghost btn-sm';
      use.dataset.act = 'use';
      use.textContent = '设为当前';
      actions.appendChild(use);
    }
    const edit = document.createElement('button');
    edit.className = 'btn btn-ghost btn-sm';
    edit.dataset.act = 'edit';
    edit.textContent = '编辑';
    actions.appendChild(edit);
    const del = document.createElement('button');
    del.className = 'btn btn-ghost btn-sm';
    del.dataset.act = 'del';
    del.textContent = '删除';
    actions.appendChild(del);

    row.appendChild(main);
    row.appendChild(actions);
    list.appendChild(row);
  }
}

/** 对话页那个选择器。和设置页共用同一份清单和同一个 activeId。 */
function renderModelPick() {
  const el = $('modelPick');
  if (!el) return;
  const c = state.config.llm || {};
  const models = Array.isArray(c.models) ? c.models : [];
  const usable = models.filter((m) => m.apiKeySet);
  const label = el.querySelector('.pick-label');

  if (!usable.length) {
    // 一个能用的都没有: 保留控件本身, 只是置灰并说明原因。整个藏掉的话
    // 用户不知道这里本该有个东西, 只会觉得"怎么没地方选模型"。
    label.textContent = models.length ? '模型都缺 API Key' : '还没配模型';
    el.classList.add('disabled', 'empty');
    el.title = '去「配置 · 模型」里补上 API Key';
    fillPickMenu(el, [{
      id: '__none__',
      label: label.textContent,
      sub: '去「配置 · 模型」里补上 API Key'
    }], '', () => {});
    return;
  }

  el.classList.remove('empty');
  el.classList.toggle('disabled', !!state.running);
  // 当前选中的那个如果恰好没 Key, 它不在列表里 —— 这时选中项会自己落到第一个。
  // activeId 也得跟着挪, 否则"框里显示 A、实际用的是 B"。
  const cur = usable.find((m) => m.id === c.activeId) || usable[0];
  label.textContent = cur.name || cur.model;
  el.title = (cur.name || cur.model) + ' · ' + hostOf(cur.baseURL);
  fillPickMenu(el, usable.map((m) => ({
    id: m.id,
    label: m.name || m.model
  })), cur.id, pickModel);
}

async function pickModel(id) {
  if (!id || id === state.config.llm?.activeId) return;
  try {
    state.config.llm = await api.config.setActiveModel(id);
    renderModelList();
    renderModelPick();
    renderTopDb();
    const m = activeModelOf();
    toast('已切换到 ' + ((m && (m.name || m.model)) || '该模型'));
  } catch (e) {
    toast('切换失败: ' + e.message, 'err');
  }
}

function openModelModal(id) {
  const models = state.config.llm?.models || [];
  const m = id ? models.find((x) => x.id === id) : null;
  editingModelId = m ? m.id : '';
  $('modalModelTitle').textContent = m ? '编辑模型' : '新增模型';
  $('mmName').value = m ? (m.name || '') : '';
  $('mmBaseURL').value = m ? (m.baseURL || '') : 'https://api.openai.com/v1';
  $('mmModel').value = m ? (m.model || '') : '';
  // 主进程不下发明文密钥, 所以这里永远是空的 —— 留空 = 不修改已保存的那把
  $('mmApiKey').value = '';
  $('mmApiKey').placeholder = (m && m.apiKeySet) ? '已保存 (留空表示不修改)' : 'sk-...';
  $('mmKeyHint').textContent = (m && m.apiKeySet)
    ? '出于安全考虑密钥不再回显; 留空表示不修改已保存的那把。'
    : '密钥只存在本机配置文件里, 不会下发到界面。';
  $('mmTemp').value = m ? (m.temperature ?? 0.2) : 0.2;
  $('mmMaxTokens').value = m ? (m.maxTokens || 2048) : 2048;
  $('mmCtxLimit').value = m ? (m.contextLimit || 128000) : 128000;
  $('mmStatus').textContent = '';
  $('mmStatus').className = 'form-status';
  $('modalModel').hidden = false;
  setTimeout(() => $('mmName').focus(), 30);
}

function closeModelModal() {
  $('modalModel').hidden = true;
  editingModelId = '';
}

let editingModelId = '';

async function saveModel() {
  const status = $('mmStatus');
  const model = $('mmModel').value.trim();
  if (!model) {
    status.textContent = '模型名不能为空 —— 它是发给网关的标识';
    status.className = 'form-status err';
    return;
  }
  const payload = {
    name: $('mmName').value.trim(),
    baseURL: $('mmBaseURL').value.trim() || 'https://api.openai.com/v1',
    model,
    temperature: Number($('mmTemp').value),
    maxTokens: Number($('mmMaxTokens').value),
    contextLimit: Number($('mmCtxLimit').value)
  };
  if (editingModelId) payload.id = editingModelId;
  // 留空就不带这个字段, 主进程会保留已保存的密钥 —— 否则每次改个温度
  // 都会把 Key 抹掉, 而用户要等到下次发任务才知道
  const typedKey = $('mmApiKey').value.trim();
  if (typedKey) payload.apiKey = typedKey;

  try {
    state.config.llm = await api.config.saveModel(payload);
    closeModelModal();
    renderModelList();
    renderModelPick();
    renderTopDb();
    toast(editingModelId ? '模型已更新' : '模型已添加');
  } catch (e) {
    status.textContent = '保存失败: ' + e.message;
    status.className = 'form-status err';
  }
}

async function deleteModel(id) {
  const models = state.config.llm?.models || [];
  const m = models.find((x) => x.id === id);
  if (!m) return;
  const isActive = id === state.config.llm?.activeId;
  if (!(await askConfirm({
    title: '删除模型?',
    message: isActive
      ? `「${m.name || m.model}」正在使用中, 删除后会自动切到另一个模型。`
      : `确定删除模型「${m.name || m.model}」?`,
    detail: '只删这条配置 (地址 / 模型名 / Key), 不影响网关那边的账号。',
    okText: '删除模型',
    tone: 'danger'
  }))) return;
  try {
    state.config.llm = await api.config.deleteModel(id);
    renderModelList();
    renderModelPick();
    renderTopDb();
    toast('模型已删除');
  } catch (e) {
    toast('删除失败: ' + e.message, 'err');
  }
}

// ============== Database modal ==============
function openDbModal(prefill) {
  $('modalDb').hidden = false;
  $('dbName').value = prefill?.name || '';
  $('dbType').value = prefill?.type || 'mysql';
  $('dbHost').value = prefill?.host || '127.0.0.1';
  $('dbPort').value = prefill?.port || 3306;
  $('dbDatabase').value = prefill?.database || '';
  $('dbUser').value = prefill?.user || '';
  $('dbPassword').value = prefill?.password || '';
  $('dbSqlitePath').value = prefill?.type === 'sqlite' ? prefill.database : '';
  $('dbFormStatus').textContent = '';
  $('dbFormStatus').className = 'form-status';
  toggleDbFields();
}
function closeDbModal() {
  $('modalDb').hidden = true;
}
function toggleDbFields() {
  const t = $('dbType').value;
  $('dbNetGroup').style.display = t === 'sqlite' ? 'none' : '';
  $('dbDbNameGroup').style.display = t === 'sqlite' ? 'none' : '';
  $('dbUserGroup').style.display = t === 'sqlite' ? 'none' : '';
  $('dbSqliteGroup').hidden = t !== 'sqlite';
}
function readDbForm() {
  const type = $('dbType').value;
  const name = $('dbName').value.trim();
  if (!name) throw new Error('请填写显示名称');
  if (type === 'sqlite') {
    const path = $('dbSqlitePath').value.trim();
    if (!path) throw new Error('请填写 SQLite 文件路径');
    return { name, type, database: path };
  }
  return {
    name,
    type,
    host: $('dbHost').value.trim() || '127.0.0.1',
    port: Number($('dbPort').value) || undefined,
    database: $('dbDatabase').value.trim(),
    user: $('dbUser').value.trim(),
    password: $('dbPassword').value
  };
}
async function testDb() {
  const status = $('dbFormStatus');
  let cfg;
  try {
    cfg = readDbForm();
  } catch (e) {
    status.textContent = e.message;
    status.className = 'form-status err';
    return;
  }
  status.textContent = '正在测试连接...';
  status.className = 'form-status';
  try {
    const res = await api.db.test(cfg);
    if (res.ok) {
      status.textContent = `连接成功 · ${res.type} · ${res.version}`;
      status.className = 'form-status ok';
    } else {
      status.textContent = '连接失败: ' + res.error;
      status.className = 'form-status err';
    }
  } catch (e) {
    status.textContent = '调用失败: ' + e.message;
    status.className = 'form-status err';
  }
}
async function saveDb() {
  const status = $('dbFormStatus');
  let cfg;
  try {
    cfg = readDbForm();
  } catch (e) {
    status.textContent = e.message;
    status.className = 'form-status err';
    return;
  }
  status.textContent = '正在保存...';
  status.className = 'form-status';
  try {
    await api.config.addDatabase(cfg);
    state.config = await api.config.get();
    closeDbModal();
    renderAll();
    toast('已添加数据库: ' + cfg.name);
  } catch (e) {
    status.textContent = '保存失败: ' + e.message;
    status.className = 'form-status err';
  }
}

// ============== Skills ==============
async function importSkillDir() {
  const res = await api.skills.importDir();
  if (res.ok) {
    toast('技能文件夹导入成功');
    renderSkillList();
  } else if (res.error) {
    toast('导入失败: ' + res.error, 'err');
  }
}
async function importSkillFile() {
  const res = await api.skills.importFile();
  if (res.ok) {
    toast('技能文档导入成功');
    renderSkillList();
  } else if (res.error) {
    toast('导入失败: ' + res.error, 'err');
  }
}

// ============== Agent run ==============
async function sendTask() {
  const input = $('composerInput');
  const task = input.value.trim();
  if (!task) return;
  if (state.running) {
    toast('任务进行中, 请稍候', 'err');
    return;
  }
  // 这里只挡一个前提: 没有 API Key 什么调用都跑不起来。
  // "没配库 / 没勾表"不再在发送前拦 —— 现在闲聊不碰数据库, 拦在这儿会把
  // 空环境下的对话一起挡在门外。真要取数时后端会抛错, 由下面失败分支引导。
  if (!state.config.llm?.apiKeySet) {
    toast('请先在"设置 · 模型"页配置 API Key', 'err');
    return;
  }
  // "一个库都没选"要拦下来。这跟上面"没配库不拦"不矛盾: 那是**环境**还没准备好,
  // 闲聊不碰数据库, 拦了会把空环境下的对话一起挡在门外; 而这里是用户刚亲手把库
  // 全取消掉的一个明确状态, 后端拿到的却是"空数组 = 不限制" —— 放过去就等于
  // "他说一个都没选, 系统去查了所有的库", 那种对不上比拦一下糟得多。
  if (dbPickNone()) {
    toast('还没选数据库 —— 至少选一个库才能查数据', 'err');
    // 拦下来就得告诉他去哪儿改: 顺手把菜单弹开, 而不是只给一句拒绝。
    // 两个胶囊里只有一个是可见的 (空态在输入框上方, 开聊后收进抬头)。
    const pick = ['dbPick', 'dbPickHead'].map((id) => $(id)).find((x) => x && x.offsetParent !== null);
    if (pick) openPick(pick.id);
    return;
  }
  // 对话长度到上限就拦住。这是界面这一侧的护栏, 后端 (main.js 的 agent:run)
  // 还有一道 —— 界面能被绕过, 光靠这里不算数。
  const lim = convLimit();
  if (lim.blocked) {
    toast(`这段对话已到 ${lim.max} 轮上限, 请新建会话继续`, 'err');
    renderConvLimitBanner();
    return;
  }

  const userMsg = { role: 'user', content: task };
  const assistantMsg = { role: 'assistant', content: '正在理解你的要求...', steps: [] };
  state.conversation.push(userMsg, assistantMsg);
  input.value = '';
  input.style.height = '';
  state.running = true;
  runInFlight = true;
  setComposerBusy(true);

  let result;
  try {
    // **先把自己说的话画出来, 再去建对话。**
    //
    // 以前是 await ensureConversation(task) 之后再 renderChat()。而 ensureConversation
    // 建对话时要调一次模型起标题 —— 那是一次网络往返。于是新开一段对话时, 用户按下
    // 回车后自己的那句话要等一两秒才出现, 界面像卡住了。
    //
    // 顺序换过来就对了: 用户按下回车的瞬间先看见自己说的话, 归档/起标题在后台做。
    renderChat();

    // 对话先落盘再跑: 产物是按对话分目录归档的, 得先有目录。
    // 已有对话就接着它继续, 否则让模型起个标题建一条新的。
    //
    // 这一段**必须在 try 里面**。它以前在 try 外面 —— 而它要发网络请求 (起标题)。
    // 只要它抛一次 (网关抖、模型返回怪东西、DOM 状态不对), 下面的 finally 就
    // 永远不执行: state.running 停在 true, 界面永远显示"深度探索中"、输入框永远
    // 禁用。而 AI 其实早就没在跑了 —— 那是个骗人的状态, 用户会一直等下去。
    try {
      await ensureConversation(task);
      renderConvList();
    } catch (e) {
      // 归档/刷新列表失败不该让任务跑不起来, 但也不能把 busy 卡住
      renderChat();
    }

    result = await api.agent.run({
      task,
      conversationId: state.activeConversationId,
      history: state.conversation.filter((m) => m.role === 'user' || m.role === 'assistant').slice(0, -2),
      // 把本会话已经确认过的表/字段和已查过的结果交回去, 它能认出是同一件事
      state: state.agentState || null,
      // 表选择模式。每轮都发当前值, 而不是在会话上记一份 ——
      // 用户中途切模式, 下一句就该按新模式跑, 不该等到新开会话才生效。
      tableMode: state.tableMode,
      // 这段对话只在哪些库里找表 (空数组 = 不限制)。后端只把它交给**通用分析**
      // 的路由器; 流程卡走的是另一条路, 拿到的仍是全量库配置, 所以不受这里影响。
      dbIds: selectedDbIds(),
      // 这段对话检索哪些知识库 (多选; 空 = 用配置里的默认库)。
      kbIds: (state.kbIds || []).slice()
    });
  } catch (e) {
    result = { ok: false, error: (e && e.message) || String(e) };
  } finally {
    runInFlight = false;
    state.running = false;
    setComposerBusy(false);
  }

  if (result.cancelled) {
    // 用户点了「停止」—— 不是故障。正文写"已停止", 已经跑出来的步骤留着。
    assistantMsg.content = '已停止。';
    renderChat();
    await persistMessages();
    return;
  }

  if (!result.ok) {
    // 取数任务"还没准备好"的三种情况 —— 引导到数据库页。闲聊走不到这里。
    if (/未配置\/未选中数据库|尚未勾选任何数据表|都不存在/.test(result.error || '')) {
      toast(result.error, 'err');
      switchView('databases');
    }
    assistantMsg.content = '任务失败: ' + result.error;
    renderChat();
    await persistMessages();
    toast('任务失败: ' + result.error, 'err');
    return;
  }

  // 记住这一轮跑完后的会话状态, 下一轮接着用
  if (result.result && result.result.state) {
    state.agentState = result.result.state;
  }
  // 本次任务的耗时与用量: 记到消息上 (显示用), 并累进会话总量 (落盘用)。
  //
  // 累进的是**增量**, 不是总量 —— 落盘那侧做的是累加 (见 lib/store.js 的
  // saveMessages), 每次送总量过去会越加越多。
  if (result.result) {
    if (result.result.elapsedMs != null) assistantMsg.elapsedMs = result.result.elapsedMs;
    if (result.result.usage) {
      assistantMsg.usage = result.result.usage;
      state.convUsage = state.convUsage || { input: 0, output: 0, calls: 0 };
      state.convUsage.input += result.result.usage.input || 0;
      state.convUsage.output += result.result.usage.output || 0;
      state.convUsage.calls += result.result.usage.calls || 0;
      pendingStats = {
        input: result.result.usage.input || 0,
        output: result.result.usage.output || 0,
        calls: result.result.usage.calls || 0
      };
    }
    // 上下文占用。结果里那份是"任务结束那一刻"的值 —— 事件流可能因为
    // 网络或渲染时序漏掉最后一拍, 用它兜底。
    if (Number.isFinite(result.result.ctx) && result.result.ctx > 0) {
      assistantMsg.ctx = result.result.ctx;
      state.convCtx = result.result.ctx;
    }
    renderCtxRing();

    // 问答记录 id: **每次问答都有** (主进程现在每次都记), 反馈 👍/👎 要用它 ——
    // 所以放在 ragHits 判断之外。
    assistantMsg.qaId = result.result.qaId || null;
    // 参考结果 (只有真检索了才有)
    if (Array.isArray(result.result.ragHits) && result.result.ragHits.length) {
      if (!assistantMsg.ragHits || !assistantMsg.ragHits.length) {
        assistantMsg.ragHits = result.result.ragHits.map((h) => ({
          docName: h.docName, section: h.section, folderName: h.folderName,
          score: h.score, snippet: h.snippet
        }));
      }
      assistantMsg.ragKbName = (result.result.ragHits[0] || {}).kbName || assistantMsg.ragKbName || '';
    }
  }
  // 正文已由事件流铺好; 纯对话回复没有 report 事件, 这里兜个底
  if (!assistantMsg.report && !assistantMsg.content) {
    assistantMsg.content = result.result.summary || '已完成';
  }
  // 有产出才建卡片。output=none 的那次不出文件, 事件流已经把结果表摆进对话了;
  // 纯对话回复 html/md 都是空的 —— 两种情况都不该建出一个空壳卡片。
  if (!assistantMsg.report && (result.result.html || result.result.md)) {
    assistantMsg.report = {
      html: result.result.html,
      md: result.result.md,
      xlsxBase64: result.result.xlsxBase64,
      xlsxError: result.result.xlsxError,
      title: result.result.title,
      output: result.result.output,
      table: result.result.table || null
    };
    if (result.result.output === 'excel' && result.result.xlsxBase64) {
      setTimeout(async () => {
        const r = await api.report.exportXLSX({ base64: result.result.xlsxBase64, baseName: result.result.title || 'askaha-report' });
        if (r.ok) toast('Excel 已导出: ' + r.filePath);
        else if (r.error) toast('Excel 导出失败: ' + r.error, 'err');
      }, 200);
    }
  }
  renderChat();

  // 消息与产物落盘, 左栏与右栏同步刷新
  await persistMessages();
  await loadConversations();
  await renderArtifacts();
  if ((result.artifacts || []).length) {
    if (state.rightCollapsed) setRightCollapsed(false);
    toast(`已归档 ${result.artifacts.length} 个产物到数据空间`);
  }
}

/** 确保当前有一个已落盘的对话; 点「＋」落下的占位「新对话」在这一步补上 AI 标题 */
async function ensureConversation(task) {
  const cur = (state.conversations || []).find((c) => c.id === state.activeConversationId);
  if (state.activeConversationId && cur) {
    // 还是点「＋」时落的那条占位 → 第一轮到了, 补 AI 标题 + 记下这次的分析范围。
    // (范围原本在 conv:create 时记, 现在 create 提前到了"用户还没选库"的占位那一刻。)
    if (cur.title === NEW_CHAT_TITLE) {
      try {
        const r = await api.conv.title({
          id: cur.id,
          task,
          databaseName: reachableDbNames(),
          dbIds: selectedDbIds()
        });
        if (r && r.ok) await loadConversations();
      } catch (e) {
        // 标题补不上不影响任务本身, 忽略
      }
    }
    return;
  }
  // 没有已落盘的对话 (老路径 / 兜底) → 直接建一条带 AI 标题的
  try {
    const res = await api.conv.create({
      task,
      // 不再有"当前数据库"这个字段; 记的是这次能碰到哪些库 (勾过表的那些),
      // 供对话列表标出数据来源。
      databaseName: reachableDbNames(),
      // 记进对话, 重开这条对话时能把分析范围接回来
      dbIds: selectedDbIds()
    });
    if (res && res.ok && res.conversation) {
      state.activeConversationId = res.conversation.id;
      return;
    }
    toast('对话归档失败: ' + ((res && res.error) || '未知错误'), 'err');
  } catch (e) {
    toast('对话归档失败: ' + e.message, 'err');
  }
  // 兜底: 建不出对话也给个临时 id, 任务本身不能因此跑不起来
  if (!state.activeConversationId) state.activeConversationId = 'c_' + Date.now();
}

/** 勾过表的库名 (通用问句能访问到的范围), 用来标对话的数据来源 */
function reachableDbNames() {
  return (state.config.databases || [])
    .filter((d) => (d.tables || []).some((t) => t && t.checked && t.name))
    .map((d) => d.name || d.id)
    .join('、');
}

async function persistMessages() {
  if (!state.activeConversationId) return;
  try {
    // stats 送的是**增量**: 落盘那侧做累加 (lib/store.js 的 saveMessages)。
    // 送总量过去会越加越多 —— 而那种错在界面上看不出来 (数字一直在涨,
    // 看着像是"用得多"), 要等到对账单才会发现。
    const delta = pendingStats;
    pendingStats = null;
    await api.conv.saveMessages({
      id: state.activeConversationId,
      messages: state.conversation.map((m) => ({
        role: m.role,
        content: m.content || '',
        steps: m.steps || [],
        // 用量和耗时也要落盘, 否则重开这段对话时"这次花了多少"就没了
        usage: m.usage || null,
        elapsedMs: m.elapsedMs != null ? m.elapsedMs : null,
        // 上下文占用。重开这段对话时圆环要接着显示上次的占用, 不落盘的话
        // 会变回"暂无数据" —— 而用户恰恰是重开之后才最需要知道还剩多少余量。
        ctx: Number.isFinite(m.ctx) && m.ctx > 0 ? m.ctx : null,
        report: m.report ? { title: m.report.title, output: m.report.output, html: m.report.html, md: m.report.md, table: m.report.table || null } : null
      })),
      agentState: state.agentState || null,
      stats: delta || undefined
    });
  } catch (e) {
    // 落盘失败不该打断对话。但增量要还回去 —— 丢了它这一轮的用量就永久少了。
    if (delta && !pendingStats) pendingStats = delta;
  }
}

function setComposerBusy(busy) {
  const btn = $('btnSend');
  btn.disabled = !!busy;
  // 图标按钮没有文字可换, 忙碌态由 CSS 按 .busy 切成转圈。
  // 文字挪到 title / aria-label, 读屏和悬停都还知道现在是什么状态。
  btn.classList.toggle('busy', !!busy);
  btn.title = busy ? '执行中…' : '发送';
  btn.setAttribute('aria-label', busy ? '执行中…' : '发送');
  $('btnNewChat').disabled = !!busy;
  $('btnNewChatSide').disabled = !!busy;
  // 不看传进来的 busy, 看 state.running —— 状态条只认这一个真相源
  syncRunStatus();
}

/* ============================================================
 * 执行状态: 「深度探索中」+ 计时
 * ============================================================ */

/** 毫秒 -> 时:分:秒。固定两位, 免得秒数跳动时整行宽度跟着变。 */
function fmtDuration(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (n) => String(n).padStart(2, '0');
  return p(h) + ':' + p(m) + ':' + p(s);
}

/** 毫秒 -> 给人看的短描述 (任务结束后用)。不足一秒也说"不到 1 秒"。 */
function fmtDurationShort(ms) {
  const n = Number(ms) || 0;
  if (n < 1000) return '不到 1 秒';
  const total = Math.round(n / 1000);
  if (total < 60) return total + ' 秒';
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return s ? `${m} 分 ${s} 秒` : `${m} 分`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}

/** 千分位。token 数动辄上万, 不分位读不出来。 */
function fmtNum(n) {
  const v = Number(n) || 0;
  return v.toLocaleString('en-US');
}

let runTimerId = null;
let runStartAt = 0;
// 「确实有一次运行在飞」的凭据。
//
// state.running 和它是**同生同灭**的 (都在 sendTask 的 finally 里清), 所以正常情况下
// 两者一致。它存在的意义是当交叉校验: 万一将来有人加了条早退路径、或者在 finally
// 之前 return 了, state.running 就会停在 true —— 而那时凭据已经没了。
// 界面宁可少显示一次状态, 也不能一直骗用户说"还在跑"。
let runInFlight = false;

function runTick() {
  const el = $('runTimer');
  if (el) el.textContent = fmtDuration(Date.now() - runStartAt);
}

/**
 * 状态条的唯一真相是 state.running。
 *
 * 以前是 start/stop 配对调用 —— 那种写法只要漏一次, 界面就永远停在"深度探索中",
 * 而这是个**骗人的状态**: AI 早就停了, 用户还在等它。配对漏掉的原因可以有很多
 * (中途抛异常、多一条早退路径、将来新加一个入口), 靠人记得配对是防不住的。
 *
 * 改成从 state.running 派生之后, 它就有了自愈能力: 任何一次渲染都会把它拉回
 * 正确的样子, 包括我没想到的那些路径。
 */
function syncRunStatus() {
  const bar = $('runStatus');
  if (!bar) return;
  // 交叉校验: 说是"在跑"但根本没有运行在飞 —— 那是残留, 清掉。
  if (state.running && !runInFlight) state.running = false;
  if (state.running) {
    // 只补开, 不重开 —— 重开会把计时清零, 于是每次渲染都从头开始数,
    // 用户看到的计时器永远走不过几秒。
    if (!runTimerId) {
      runStartAt = Date.now();
      runTimerId = setInterval(runTick, 1000);
    }
    bar.hidden = false;
    // 每次显示都把「停止」按钮复位 (上一轮点过之后它是禁用+“正在停止…”)
    const stop = $('btnStopRun');
    if (stop) { stop.disabled = false; stop.textContent = '停止'; }
    runTick();
  } else {
    bar.hidden = true;
    if (runTimerId) { clearInterval(runTimerId); runTimerId = null; }
  }
}

/**
 * 人工终止正在跑的对话任务。置一个"正在停止…"的即时反馈, 再叫主进程取消:
 * 主进程置取消标志 + abort 在飞的模型请求; 任务会在**下一个检查点**停下
 * (正在飞的数据库查询中断不了, 得等它回来)。
 */
async function stopRunTask() {
  const btn = $('btnStopRun');
  if (btn) { btn.disabled = true; btn.textContent = '正在停止…'; }
  setRunStatusText('正在停止…');
  try { await api.agent.cancel(); } catch (e) { /* 没在跑就算了 */ }
}

function startRunStatus() { syncRunStatus(); }

function stopRunStatus() { syncRunStatus(); }

/** 把状态条上的文字换掉 (闸门阶段/调研阶段用) */
function setRunStatusText(text) {
  const el = $('runStatusText');
  if (el && text) el.textContent = text;
}

/* ============================================================
 * 本会话累计
 * ============================================================ */

/**
 * 数出本会话的累计量。
 *
 * 轮数和步数**从消息里数**, 不从计数器读 —— 计数器会因为"重开对话""删消息"
 * 之类的操作和真实内容对不上, 而从内容数永远是对的。
 * token 反过来: 它来自模型响应的 usage, 消息里没有, 只能靠累计值 (落盘在 stats)。
 */
function convStatsOf() {
  let turns = 0;
  let steps = 0;
  for (const m of state.conversation) {
    if (m.role === 'user') turns += 1;
    if (m.role === 'assistant' && Array.isArray(m.steps)) steps += m.steps.length;
  }
  const u = state.convUsage || { input: 0, output: 0 };
  return { turns, steps, input: u.input || 0, output: u.output || 0 };
}

function renderConvStats() {
  const el = $('convStats');
  if (!el) return;
  const s = convStatsOf();
  // 一段全新对话什么都不显示 —— 一排 0 只是噪声
  if (!s.turns && !s.steps && !s.input && !s.output) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML =
    `<span class="cs-item">本会话 <b>${s.turns}</b> 轮对话</span>` +
    `<span class="cs-item">AI 执行 <b>${s.steps}</b> 步</span>` +
    `<span class="cs-item">输入 <b>${fmtNum(s.input)}</b> tokens</span>` +
    `<span class="cs-item">输出 <b>${fmtNum(s.output)}</b> tokens</span>`;
}

/**
 * 上下文占用圆环。
 *
 * 分子是**最近一次模型调用的输入 token** —— 那正好就是"此刻发给模型的提示词
 * 有多大"。不用累计值: 累计是花费, 拿它比上限会让跑了多轮的任务显示成几百
 * 百分比, 而每一轮其实都很空。
 *
 * 分母是**当前模型上用户填的 contextLimit**, 不是我们探测出来的。所以浮层里
 * 明确写着"上限按你填的算" —— 各家真实窗口差得很远 (8k~1M), 猜错了这个环
 * 就只是个装饰, 甚至误导。
 */
function renderCtxRing() {
  const ring = $('ctxRing');
  const fill = $('ctxFill');
  const pctEl = $('ctxPct');
  const tip = $('ctxTip');
  if (!ring || !fill) return;

  const limit = Number(state.config.llm?.contextLimit) || 128000;
  const used = Number(state.convCtx) || 0;
  const known = used > 0;
  const pct = known ? Math.min(100, (used / limit) * 100) : 0;

  // 97.39 = 2π × 15.5 (半径), 和 CSS 里那条 dasharray 是同一个数
  fill.style.strokeDashoffset = String(97.39 * (1 - pct / 100));
  pctEl.textContent = known ? (pct >= 100 ? '99+' : String(Math.round(pct))) : '';

  ring.classList.toggle('unknown', !known);
  ring.classList.toggle('warn', known && pct >= 60 && pct < 85);
  ring.classList.toggle('danger', known && pct >= 85);

  const m = activeModelOf();
  const modelName = (m && (m.name || m.model)) || '未配置模型';
  ring.title = known
    ? `上下文占用 ${Math.round(pct)}% (${fmtNum(used)} / ${fmtNum(limit)} tokens)`
    : '上下文占用情况';

  if (tip) {
    const lvl = !known ? '' : (pct >= 85 ? ' danger' : (pct >= 60 ? ' warn' : ''));
    // 只在"需要用户动手"的时候才留字。
    // 去掉的两句 (都在你截的那张图里):
    //   1. "这个会话还没跑过任务…" —— 上面那行"暂无数据"已经说了同一件事
    //   2. "上限按你在「设置 · 模型」里填的 contextLimit 算…" —— 常驻的解释性
    //      脚注, 每次 hover 都占一行, 而它要说的东西填配置时看一次就够了
    let note = '';
    if (known && pct >= 85) {
      note = '快满了。继续追问容易触发截断 —— 建议新开一个会话, 把这个话题的结论先记下来。';
    } else if (known && pct >= 60) {
      note = '用掉大半了。还能继续问, 但要注意后面几轮的回答可能开始丢细节。';
    } else if (known) {
      note = '还很空, 可以放心继续追问。';
    }
    tip.className = 'ctx-tip' + lvl;
    tip.innerHTML =
      `<div class="ctx-tip-title"><span>上下文占用</span>` +
      `<span class="ctx-tip-num">${known ? Math.round(pct) + '%' : '—'}</span></div>` +
      `<div class="ctx-bar"><div class="ctx-bar-fill" style="width:${pct}%"></div></div>` +
      `<div class="ctx-tip-row"><span>已占用</span><b>${known ? fmtNum(used) + ' tokens' : '暂无数据'}</b></div>` +
      `<div class="ctx-tip-row"><span>上限</span><b>${fmtNum(limit)} tokens</b></div>` +
      `<div class="ctx-tip-row"><span>当前模型</span><b>${escapeHtml(modelName)}</b></div>` +
      (note ? `<div class="ctx-tip-note${lvl}">${note}</div>` : '');
  }
}

function handleAgentEvent(ev) {
  if (!ev.conversationId || ev.conversationId !== state.activeConversationId) return;
  const last = state.conversation[state.conversation.length - 1];
  if (!last || last.role !== 'assistant') return;
  switch (ev.type) {
    case 'state': {
      // 主进程把"本会话已有的资料"交回来 —— 有资料说明这轮是接着干, 没有则是新任务
      const carried = Array.isArray(ev.carried) ? ev.carried : [];
      if (carried.length || (ev.tables || []).length) {
        last.steps.push({
          kind: 'carry',
          title: ev.message || '沿用本会话资料',
          message: carried.length
            ? carried.map((c) => `[${c.index}] ${c.title} · ${c.rowCount} 行`).join('   ')
            : ''
        });
      }
      break;
    }
    case 'reply':
      // 只是回一句话: 不该带任何执行过程, 把攒下的步骤清掉, 只留正文。
      // 流程卡跑完也会发 reply, 但它带 keepSteps —— 那些步骤正是用户要看的。
      if (!ev.keepSteps) last.steps = [];
      last.content = ev.text || '';
      break;
    case 'rag_hits':
      // 用了知识库: 记下参考片段, 正文下面会挂"参考资料"卡片 (可折叠) + 👍/👎。
      last.ragHits = (ev.hits || []).map((h) => ({
        docName: h.docName, section: h.section, folderName: h.folderName,
        score: h.score, snippet: h.snippet, docId: h.docId, chunkId: h.chunkId
      }));
      last.ragKbName = ev.kbName || '';
      break;
    case 'start':
      // 中性的占位文案: 这时候还不知道是闲聊还是干活
      last.content = '正在理解你的要求...';
      // 新一轮: 清掉上一轮可能残留的流式实时区
      last.streamText = '';
      last.streamSeen = false;
      break;
    case 'delta': {
      // 流式正文: 追字。这里**只更新最后一条气泡的实时区**, 不走末尾的 renderChat ——
      // delta 一秒来几十次, 整表重渲染会把滚动位置和正在选中的文字抖掉。
      if (!last.streamSeen) { last.streamSeen = true; last.content = ''; }  // 顶掉占位文案
      last.streamText = (last.streamText || '') + (ev.text || '');
      renderStreamText(chatNodes[state.conversation.length - 1], last);
      return;   // 自己更新了 DOM, 不再走末尾的 renderChat
    }
    case 'delta_end':
      // 正文流完了: 清掉实时区, 交给随后的 reply / report / 执行过程接棒
      last.streamText = '';
      break;
    case 'usage':
      // 本次任务的实时用量。挂在消息上, 这样"跑完就收起来"的执行过程里
      // 仍然留着它 —— 用户回头翻这一段时还看得到花了多少。
      last.usage = ev.task || last.usage || null;
      // 上下文占用 (最近一次调用的输入 token)。它单独记在 state 上而不是
      // 只挂在消息里: 圆环显示的是"此刻"的占用, 而消息是历史。
      if (Number.isFinite(ev.ctx) && ev.ctx > 0) {
        last.ctx = ev.ctx;
        state.convCtx = ev.ctx;
        renderCtxRing();
      }
      updateMessageNode(chatNodes[state.conversation.length - 1], last, state.conversation.length - 1);
      break;
    case 'phase':
      last.steps.push({
        kind: ev.phase,
        title: ev.message,
        purpose: ev.purpose,
        why: ev.why,
        fields: ev.fields,
        sql: ev.sql,
        table: ev.table
      });
      break;
    case 'thought':
      // 不直接展示 thought, 已经通过 phase 展示
      break;
    case 'schema': {
      const tableNames = Array.isArray(ev.tables) ? ev.tables : [];
      last.steps.push({
        kind: 'schema',
        title: `加载了 ${tableNames.length} 张表`,
        message: tableNames.slice(0, 8).join(', ') + (tableNames.length > 8 ? ' …' : '')
      });
      break;
    }
    case 'checkpoint':
      // 条件充分时智能体会自己定下表与字段, 不弹窗; 这里补一条被动说明,
      // 让用户知道它替你决定了什么 (手工确认的路径不必重复展示)
      if (!ev.auto) break;
      if (ev.phase === 'tables') {
        last.steps.push({
          kind: 'auto',
          title: '自动模式: AI 已选定数据表',
          message: (ev.selected || []).join(', ') + (ev.reason ? '  ·  ' + ev.reason : '')
        });
        // 挑中的表里没有备注的那几张单独说一句。自动选表的判据只有表名 + 备注,
        // 所以"这几张没备注"是这次结果可靠性的直接提示 —— 用户看到才知道该去
        // 补哪一张, 而不是笼统地知道"要维护备注"却不知道从哪开始。
        const noNote = Array.isArray(ev.noNote) ? ev.noNote : [];
        if (noNote.length) {
          last.steps.push({
            kind: 'auto',
            warn: true,
            title: `其中 ${noNote.length} 张表没有备注, 选表准确性可能受影响`,
            message: noNote.join(', ') + '  ·  去「数据空间」给它们补上备注'
          });
        }

        // 值探测: 需求里给了单号时, 系统会先拿这个值去候选表里各试一次。
        // 命中 = "这个号真的在这张表的这一列里", 比表名相似度硬得多;
        // 全未命中则是一条**警告** —— 结论可能是"确实没有", 也可能是表选错了,
        // 这两件事在界面上必须分得开。
        const probes = ev.probes || null;
        if (probes && Array.isArray(probes.values) && probes.values.length) {
          const hits = Array.isArray(probes.hits) ? probes.hits : [];
          if (hits.length) {
            last.steps.push({
              kind: 'auto',
              title: '值探测命中 (这个号确实在这些表里)',
              message: hits.map((h) => `${h.table}.${h.column} ← ${h.value}`).join('   ')
            });
          } else if ((probes.missedCols || []).length || (probes.misses || []).length) {
            // 说"没有"要说在**列**上: 验过的列一个都没命中, 这是能站住的结论;
            // "这些表没有" 站不住 —— 一张表往往只验了其中一两列。
            const cols = (probes.missedCols || []).map((m) => `${m.table}.${m.column}`).join(', ');
            last.steps.push({
              kind: 'auto',
              warn: true,
              title: `${probes.values.join(', ')} 在验过的列里没有命中`,
              message: (cols ? '验过这些列: ' + cols : '')
                + '  ·  这不等于"没有数据": 没验过的列还在下面列着, 而且大表只有索引列能试'
            });
          }
        }
        // 模型自己说"我没法从表名/注释判断什么" —— 这句最该被看见, 而不是埋在提示词里
        if (ev.uncertain) {
          last.steps.push({ kind: 'auto', warn: true, title: 'AI 说这一点它没法确认', message: ev.uncertain });
        }
        // 没能验证的列 —— 摆出来让**用户**看。
        // 这一条是替代方案: 我们试过让模型在这些列里挑"最可能装这个值的",
        // 实测 3/3 次都挑错 (它跟着用户话里的"付款单"走, 挑中"用友付款单编号",
        // 而真值在列注释写着"请款单"的那张表上), 每次还要多花几十秒。
        // "哪一列装的是我们家的单号"这件事用户看一眼注释就知道, 交给他判断最省事也最准。
        const untried = Array.isArray(ev.untriedCols) ? ev.untriedCols : [];
        if (untried.length) {
          last.steps.push({
            kind: 'auto',
            warn: true,
            title: `有 ${untried.length} 个像单号的列没能验证 (表太大/列没索引)`,
            message: untried.map((u) => `${u.table}.${u.column}${u.comment ? ' — ' + u.comment : ''}`).join('   ')
              + '  ·  这些列里有没有你要的号, 工具答不上来 —— 别把"查不到"当成"没有"'
          });
        }
        if (Array.isArray(ev.degraded) && ev.degraded.length) {
          // 降级不是小事: 它意味着值探测和列注释**都没生效**, 等于退回旧行为。
          // 以前这里是个普通步骤, 用户很容易划过去 —— 而"时好时坏"最难排查。
          last.steps.push({
            kind: 'auto',
            warn: true,
            title: '匹配时降级了 (这次没有用值核对, 也没有列注释)',
            message: ev.degraded.join('  ·  ')
          });
        }
        // 耗时和 token: 用户说"慢"的时候, 这一行要能回答"慢在哪"。
        // 实测这条链路的机器部分 (目录 + 预筛 + 探测) 不到 1 秒, 其余全是模型思考,
        // 所以把它拆开显示 —— 否则用户会以为是"加了个功能所以变慢了"。
        const tm = ev.timing || null;
        if (tm && (tm.total || tm.llm)) {
          const parts = [];
          if (tm.digest != null) parts.push(`字段目录 ${tm.digest}ms`);
          if (tm.shortlist != null) parts.push(`预筛 ${tm.shortlist}ms`);
          if (tm.probe != null) parts.push(`值探测 ${tm.probe}ms`);
          if (tm.llm != null) parts.push(`模型 ${(tm.llm / 1000).toFixed(1)}s`);
          const tok = tm.tokens ? `  ·  token 输入 ${tm.tokens.in} / 输出 ${tm.tokens.out}` : '';
          last.steps.push({
            kind: 'auto',
            title: `选表耗时 ${((tm.total || tm.llm || 0) / 1000).toFixed(1)} 秒`,
            message: parts.join('  ·  ') + tok
          });
        }
      } else if (ev.phase === 'fields') {
        const parts = Object.entries(ev.selected || {})
          .map(([t, cols]) => `${t}: ${(cols || []).length} 列`);
        last.steps.push({
          kind: 'auto',
          title: '已自动选定字段',
          message: parts.join('  ·  ')
        });
      }
      break;
    case 'sql_result':
      // 找到最后一个 sql 步骤并填充结果
      for (let i = last.steps.length - 1; i >= 0; i--) {
        if (last.steps[i].kind === 'sql' && !last.steps[i].rowCount) {
          last.steps[i].rowCount = ev.rowCount;
          last.steps[i].elapsedMs = ev.elapsedMs;
          break;
        }
      }
      break;
    case 'sql_error':
      for (let i = last.steps.length - 1; i >= 0; i--) {
        if (last.steps[i].kind === 'sql' && !last.steps[i].error) {
          last.steps[i].error = ev.error;
          break;
        }
      }
      break;
    case 'describe_result':
      for (let i = last.steps.length - 1; i >= 0; i--) {
        if (last.steps[i].kind === 'describe' && !last.steps[i].rowCount) {
          last.steps[i].rowCount = ev.columns?.length || 0;
          break;
        }
      }
      break;
    case 'describe_error':
      for (let i = last.steps.length - 1; i >= 0; i--) {
        if (last.steps[i].kind === 'describe' && !last.steps[i].error) {
          last.steps[i].error = ev.error;
          break;
        }
      }
      break;
    /* ---- 流程卡执行过程: 引擎一路发的事件, 接到界面上滚出来 ---- */
    case 'engine_start':
      last.steps.push({
        kind: 'engine',
        title: '走流程卡「' + (ev.engineName || '未命名') + '」',
        message: ev.inputs && Object.keys(ev.inputs).length
          ? Object.keys(ev.inputs).map((k) => k + ' = ' + ev.inputs[k]).join('   ')
          : ''
      });
      break;
    case 'engine_batch_progress':
      // 批量跑 (一次给了好几个单号, 逐单各跑一遍) 的进度: 让用户知道还在跑、跑到第几单
      last.steps.push({
        kind: 'engine',
        title: '批量查 ' + (ev.total || '?') + ' 单',
        message: '正在跑第 ' + ((ev.from || 0) + 1) + ' ~ ' + Math.min(ev.total || 0, (ev.from || 0) + (ev.count || 0)) + ' 单 ...'
      });
      break;
    case 'engine_phase': {
      // 批量跑时每条事件带 batchIndex (第几单), 标在标题前面, 免得 3 单的步骤混在一起分不清
      const tag = (typeof ev.batchIndex === 'number') ? ('第 ' + (ev.batchIndex + 1) + ' 单 · ') : '';
      last.steps.push({
        kind: 'engine',
        engineNodeId: ev.nodeId,
        title: tag + (ev.message || ev.title || '执行'),
        sql: ev.sql,
        table: ev.table
      });
      break;
    }
    case 'engine_query_result':
      // 回填到这一步上, 跟分析模式的 sql_result 一个做法
      for (let i = last.steps.length - 1; i >= 0; i--) {
        const s = last.steps[i];
        if (s.kind === 'engine' && s.engineNodeId === ev.nodeId && typeof s.rowCount !== 'number') {
          s.rowCount = ev.rowCount;
          s.elapsedMs = ev.elapsedMs;
          break;
        }
      }
      break;
    case 'engine_output':
      // 结论本身由后面的 reply 给, 这里只把"引用对不上"这件事摆出来 ——
      // 那正是输出里出现空白的直接原因, 不摆出来用户只能看见一个空结果。
      if (Array.isArray(ev.missing) && ev.missing.length) {
        last.steps.push({
          kind: 'engine',
          title: '结论文本里有对不上的引用',
          error: ev.missing.join('、') + ' —— 这些位置渲染出来是空的'
        });
      }
      break;
    case 'engine_error':
      last.steps.push({
        kind: 'engine',
        title: '流程卡在这一步断了',
        sql: ev.sql,
        error: ev.message
      });
      break;
    case 'engine_done':
      // 收尾不额外加行, 结论由随后的 reply 给
      break;
    case 'report': {
      // output=none 的交付: 正文放结论, 下面直接跟结果表 —— 不出文件, 也没有报告卡。
      // html/excel 的正文仍是标题, 内容由报告卡片承担。
      const isPlain = ev.output === 'none';
      const lines = isPlain
        ? (Array.isArray(ev.insights) && ev.insights.length ? ev.insights : [ev.summary || ev.title || ''])
        : [];
      last.content = isPlain
        ? lines.map((s) => String(s || '').trim()).filter(Boolean).join('\n')
        : (ev.title || '报告');
      last.report = {
        html: ev.html,
        md: ev.md,
        xlsxBase64: ev.xlsxBase64,
        xlsxError: ev.xlsxError,
        title: ev.title,
        output: ev.output,
        // output=none 时没有文件, 只有这次查询的结果表
        table: ev.table || null
      };
      if (ev.xlsxError) toast('Excel 生成失败: ' + ev.xlsxError, 'err');
      if (ev.output === 'excel' && ev.xlsxBase64) {
        // 自动弹出 Excel 导出对话框
        setTimeout(async () => {
          const r = await api.report.exportXLSX({ base64: ev.xlsxBase64, baseName: ev.title || 'askaha-report' });
          if (r.ok) toast('Excel 已导出: ' + r.filePath);
          else if (r.error) toast('Excel 导出失败: ' + r.error, 'err');
        }, 200);
      }
      break;
    }
    case 'error':
      last.content = (last.content || '') + '\n[错误] ' + ev.message;
      break;

    /* ---- 路由层的提问与选卡 ----
     *
     * 这两个事件以前主进程一直在发, 但这里没有分支, 于是事件被静默丢掉:
     * 用户只看到「这几张卡都对得上，你要查哪一个？」这句话, **看不到是哪几张卡** ——
     * 一个问题问出来却没法回答。现在把它们渲染成可点的选项。
     */
    case 'route_ask': {
      // 模型给的可点选项 (如「销售出库」「采购入库」); 没给就是开放问题, 用户自己打字
      const opts = Array.isArray(ev.options) ? ev.options : [];
      const q = ev.question || '再确认一下';
      // **这问题就是助手要说的话**, 必须进正文 —— 以前只塞进"执行过程"里,
      // 用户看到的是"正在理解你的要求…", 根本不知道要答什么。
      last.content = q;
      last.steps.push({ kind: 'route_ask', title: q, options: opts, why: ev.why || '' });
      break;
    }
    case 'route_choose': {
      const cards = Array.isArray(ev.candidates) ? ev.candidates : [];
      const q = ev.question || '这几张卡都对得上，你要查哪一个？';
      last.content = q;
      last.steps.push({
        kind: 'route_choose',
        title: q,
        // 卡的名字 + 用途: 用户靠这两样才选得出来
        options: cards.map((c) => ({
          id: c.id,
          label: c.name || '未命名流程卡',
          desc: c.description || '',
          inputs: (c.inputs && c.inputs.all) || []
        }))
      });
      break;
    }
  }
  renderChat();
}

// ============== Util ==============

/* ---------- 图标 (内联 SVG) ----------
   一律用 SVG, 不用 emoji。emoji 的毛病:
     · 各平台字体不同, 有的渲染成彩色大图, 尺寸和基线都对不齐
     · 颜色锁死在字形里, 没法跟着 currentColor 走 —— 想让"删除"hover 变红都做不到
     · 跟同一排里其它描边图标风格不统一
   这里只存 <path>, 外层的 <svg> 由 icon() 统一包, 尺寸和颜色都交给 CSS。 */
const ICONS = {
  // 铅笔: 笔身 + 笔杆上那道箍
  pencil: '<path d="M11.4 2.3a1.7 1.7 0 0 1 2.4 2.4l-7.9 7.9-3.1.7.7-3.1z"/>'
        + '<path d="M9.7 4l2.3 2.3"/>',
  // 垃圾桶: 桶盖 + 提手 + 桶身
  trash: '<path d="M2.9 4.5h10.2"/>'
       + '<path d="M6.3 4.5V3.4a.8.8 0 0 1 .8-.8h1.8a.8.8 0 0 1 .8.8v1.1"/>'
       + '<path d="M4.4 4.5l.6 7.9a1.6 1.6 0 0 0 1.6 1.5h2.8a1.6 1.6 0 0 0 1.6-1.5l.6-7.9"/>',
  // 文件夹
  folder: '<path d="M1.9 12.6V3.8a.9.9 0 0 1 .9-.9h3.2l1.5 1.7h5.7a.9.9 0 0 1 .9.9v7.1a.9.9 0 0 1-.9.9H2.8a.9.9 0 0 1-.9-.9z"/>',
  // 文件: 纸张 + 右上角折角 (数据空间目录树里的产物行用)
  file: '<path d="M3.4 2.6h5.3l3.9 3.9v6.9a.9.9 0 0 1-.9.9H3.4a.9.9 0 0 1-.9-.9V3.5a.9.9 0 0 1 .9-.9z"/>'
      + '<path d="M8.7 2.6v3.9h3.9"/>',
  // 全屏: 四个角括号。原来这里放的是"方框四角"那个符号字形
  full: '<path d="M6.2 2.3H3.2a.9.9 0 0 0-.9.9v3"/>'
      + '<path d="M9.8 2.3h3a.9.9 0 0 1 .9.9v3"/>'
      + '<path d="M13.7 9.8v3a.9.9 0 0 1-.9.9h-3"/>'
      + '<path d="M2.3 9.8v3a.9.9 0 0 0 .9.9h3"/>',
  // 软盘: 保存 (画板顶栏那个图标化后的保存按钮用)
  save: '<path d="M3.4 2.5h5.1l3.6 3.6v6.5a.9.9 0 0 1-.9.9H3.4a.9.9 0 0 1-.9-.9V3.4a.9.9 0 0 1 .9-.9z"/>'
      + '<path d="M5.4 2.5v3.1h4.2V2.5"/>'
      + '<path d="M4.8 13.5v-3.3h5.9v3.3"/>',
  // 上传: 箭头向上 + 底部托盘 (知识库"导入文档"用)
  upload: '<path d="M8 10.6V2.9"/>'
      + '<path d="M4.8 6.1 8 2.9l3.2 3.2"/>'
      + '<path d="M3.2 13.1h9.6"/>'
};

/** 包一个 16x16 的描边图标。尺寸、颜色、线宽全部由 CSS 的 .ic 控制。 */
function icon(name) {
  return `<svg class="ic" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

/** 静态 HTML 里写 <button data-icon="trash"></button>, 由这里把图标填进去 ——
    这样图标只在 ICONS 里定义一份, 不会 HTML/JS 各抄一遍。 */
function fillIconSlots(root) {
  (root || document).querySelectorAll('[data-icon]').forEach((el) => {
    el.innerHTML = icon(el.dataset.icon);
    el.removeAttribute('data-icon');   // 填完摘掉标记, 重复调用就是空转
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }

/**
 * markdown 渲染。真正的实现在 lib/markdown.js (纯函数, Node 测试和浏览器共用)。
 *
 * 这里留一个降级: 万一那个文件没加载上 (缓存 / 路径变了), 至少按纯文本显示,
 * 而不是抛错把整条消息变成空白 —— 渲染不上是小事, 看不见回答是大事。
 */
function renderMarkdown(s) {
  const impl = window.SoloMarkdown && window.SoloMarkdown.renderMarkdown;
  return impl ? impl(s) : escapeHtml(s).replace(/\n/g, '<br>');
}

let toastTimer = null;
function toast(msg, level) {
  const el = $('toast');
  el.textContent = msg;
  // 三种语气要能一眼分开: 出错=红, 需要注意=琥珀, 其它=常规深色
  el.style.background = level === 'err' ? '#b91c1c' : (level === 'warn' ? '#b45309' : '#111827');
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, level === 'warn' ? 3600 : 2200);
}

// ============== Checkpoints ==============
// 智能体在关键节点会把决策权交回给用户. 这里负责:
//   1. 监听主进程的 checkpoint 事件
//   2. 弹出对应的模态, 让用户确认 / 编辑 / 复制
//   3. 通过 respondCheckpoint 把结果回传给主进程

let currentCheckpoint = null; // { id, type, data, resolve }

function handleCheckpoint(cp) {
  // 只接受属于当前任务 conversationId 的 checkpoint
  if (!cp.conversationId || cp.conversationId !== state.activeConversationId) return;
  showCheckpointModal(cp);
}

function showCheckpointModal(cp) {
  currentCheckpoint = cp;
  const modal = $('modalCp');
  const title = $('cpTitle');
  const step = $('cpStep');
  const body = $('cpBody');
  const footer = $('cpFooter');

  // 重置
  body.innerHTML = '';
  footer.innerHTML = '';

  if (cp.type === 'tables') {
    title.textContent = '选择数据表';
    step.textContent = `${cp.allTables.length} 张表`;
    renderTablesCp(body, footer, cp);
  } else if (cp.type === 'fields') {
    title.textContent = '选择字段';
    const totalCols = Object.values(cp.fieldsByTable || {}).reduce((a, b) => a + b.length, 0);
    step.textContent = `${Object.keys(cp.fieldsByTable || {}).length} 张表 / ${totalCols} 列`;
    renderFieldsCp(body, footer, cp);
  } else if (cp.type === 'sql') {
    title.textContent = `确认 SQL (第 ${cp.step} 步)`;
    step.textContent = 'SQL 预览';
    renderSqlCp(body, footer, cp);
  } else if (cp.type === 'output') {
    title.textContent = '选择输出格式';
    step.textContent = '报告就绪';
    renderOutputCp(body, footer, cp);
  } else if (cp.type === 'question') {
    title.textContent = '智能体需要你补充信息';
    step.textContent = '追问';
    renderQuestionCp(body, footer, cp);
  } else {
    title.textContent = '智能体等待确认';
    step.textContent = '';
    body.innerHTML = `<pre>${escapeHtml(JSON.stringify(cp, null, 2))}</pre>`;
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.textContent = '确认';
    btn.onclick = () => respondCheckpoint({ confirmed: true });
    footer.appendChild(btn);
  }

  modal.hidden = false;
}

function respondCheckpoint(data) {
  if (!currentCheckpoint) return;
  const id = currentCheckpoint.id;
  $('modalCp').hidden = true;
  currentCheckpoint = null;
  api.agent.respondCheckpoint(id, data);
}

// ---- 1. 表选择 ----
function renderTablesCp(body, footer, cp) {
  const msg = document.createElement('p');
  msg.className = 'cp-msg';
  msg.textContent = cp.message || '请选择智能体可访问的表';
  body.appendChild(msg);

  const all = cp.allTables || [];
  const suggested = Array.isArray(cp.suggested) ? cp.suggested : [];
  const suggestedNames = new Set(suggested.map((s) => s.name));
  const otherTables = all.filter((t) => !suggestedNames.has(t));
  const defaultSet = new Set(cp.defaultSelected || []);
  const untriedCols = Array.isArray(cp.untriedCols) ? cp.untriedCols : [];

  // 实测证据 + 模型自己说不确定的地方。
  // 放在推荐区**上面**: 用户在这一屏要做的是"决定勾哪几张", 而"这个号已经
  // 在哪张表里试出来了"比任何百分比都更能决定这件事。
  const probes = cp.probes || null;
  if (probes && Array.isArray(probes.values) && probes.values.length) {
    const hitByTable = new Map();
    for (const h of (probes.hits || [])) {
      if (!hitByTable.has(h.table)) hitByTable.set(h.table, []);
      hitByTable.get(h.table).push(`${h.column} ← ${h.value}`);
    }
    const box = document.createElement('div');
    box.className = 'cp-probe-section';
    const rows = [];
    for (const [table, whats] of hitByTable) {
      rows.push(`<div class="cp-probe-hit">✔ ${escapeHtml(table)}: ${escapeHtml(whats.join('; '))}</div>`);
    }
    if (!hitByTable.size) {
      const tried = (probes.missedCols || []).map((m) => `${m.table}.${m.column}`);
      rows.push(`<div class="cp-probe-miss">验过的列里一个都没命中`
        + `${tried.length ? ': ' + escapeHtml(tried.join(', ')) : ''} —— 这不等于"没有数据",`
        + ` 没验过的列在下面列着</div>`);
    }
    if ((probes.untried || []).length && !untriedCols.length) {
      rows.push(`<div class="cp-probe-note">另有 ${probes.untried.length} 张没试成 (表太大 / 没有像单号的列 / 超时)</div>`);
    }
    box.innerHTML = `<div class="cp-probe-title">拿 ${escapeHtml(probes.values.join(', '))} 实测的结果</div>` + rows.join('');
    body.appendChild(box);
  }
  if (cp.uncertain) {
    const box = document.createElement('div');
    box.className = 'cp-probe-section';
    box.innerHTML = `<div class="cp-probe-title">AI 说这一点它没法确认</div>`
      + `<div class="cp-probe-miss">${escapeHtml(cp.uncertain)}</div>`;
    body.appendChild(box);
  }
  // 没能验证的列 —— 原样摆出来, 让**用户**判断。
  // 这一条是替代方案: 我们试过让模型在这些列里挑"最可能装这个值的", 实测 3/3 次都挑错
  // (它跟着用户话里的"付款单"走, 挑中"用友付款单编号", 而真值在列注释写着"请款单"的表上),
  // 每次还要多花几十秒。"哪一列装的是我们家的单号"用户看一眼就知道, 交给他最准。
  const untried = Array.isArray(cp.untriedCols) ? cp.untriedCols : [];
  if (untried.length) {
    const box = document.createElement('div');
    box.className = 'cp-probe-section';
    box.innerHTML = `<div class="cp-probe-title">这些像单号的列没能验证 (表太大 / 列没索引)</div>`
      + untried.map((u) => `<div class="cp-probe-miss">? ${escapeHtml(u.table)}.${escapeHtml(u.column)}`
        + `${u.comment ? ' — ' + escapeHtml(u.comment) : ''}</div>`).join('')
      + `<div class="cp-probe-note">这些列里有没有你要的号, 工具答不上来 —— 别把"查不到"当成"没有"。</div>`;
    body.appendChild(box);
  }

  // AI 推荐区
  if (suggested.length) {
    const sec = document.createElement('div');
    sec.className = 'cp-ai-section';
    sec.innerHTML = `<div class="cp-ai-section-title">AI 匹配 <span class="cp-tag">TOP ${suggested.length}</span></div>`;
    for (const s of suggested) {
      const row = document.createElement('label');
      row.className = 'cp-suggest-row';
      const sc = s.score;
      const scoreCls = sc >= 0.7 ? 'cp-score-high' : (sc >= 0.4 ? 'cp-score-mid' : 'cp-score-low');
      const scoreText = (sc * 100).toFixed(0) + '%';
      const checked = defaultSet.has(s.name);
      row.innerHTML = `
        <input type="checkbox" data-table="${escapeAttr(s.name)}" ${checked ? 'checked' : ''} />
        <span class="cp-suggest-name">${escapeHtml(s.name)}</span>
        <span class="cp-score ${scoreCls}">${scoreText}</span>
        <span class="cp-suggest-reason" title="${escapeAttr(s.reason || '')}">${escapeHtml(s.reason || '')}</span>
      `;
      sec.appendChild(row);
    }
    body.appendChild(sec);
  }

  // 其它表 (折叠)
  if (otherTables.length) {
    const det = document.createElement('details');
    det.className = 'cp-other-section';
    const sum = document.createElement('summary');
    sum.textContent = `其它 ${otherTables.length} 张表 (点击展开)`;
    det.appendChild(sum);
    const list = document.createElement('div');
    list.className = 'cp-list';
    for (const t of otherTables) {
      const row = document.createElement('label');
      row.className = 'cp-suggest-row';
      // defaultSelected 里可能有**没进 AI 推荐**的表 —— 比如值探测命中的那几张
      // (证据在数据里, 模型未必推荐)。它们必须照样默认勾上, 否则"命中了却默认不查"
      // 就等于白探测一场。
      const checked = defaultSet.has(t);
      row.innerHTML = `
        <input type="checkbox" data-table="${escapeAttr(t)}" ${checked ? 'checked' : ''} />
        <span class="cp-suggest-name">${escapeHtml(t)}</span>
        <span class="cp-suggest-reason" style="text-align:right;">${checked ? '实测命中, 已默认勾选' : '未参与 AI 评分'}</span>
      `;
      list.appendChild(row);
    }
    det.appendChild(list);
    body.appendChild(det);
  }

  // 提示词输入框
  const hint = makeHintBox({
    label: '补充提示词',
    placeholder: '可选: 调整表的关注点, 比如"再调研日志相关表"、"只看近 30 天数据"、"关注未支付订单"等'
  });
  body.appendChild(hint.el);

  // 取消 / 确认
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-ghost';
  cancelBtn.textContent = '取消任务';
  cancelBtn.onclick = () => respondCheckpoint({ cancelled: true });
  footer.appendChild(cancelBtn);

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'btn btn-primary';
  confirmBtn.textContent = '确认';
  confirmBtn.onclick = () => {
    const checked = [...body.querySelectorAll('input[data-table]:checked')].map((c) => c.dataset.table);
    if (!checked.length) {
      toast('请至少选择一张表', 'err');
      return;
    }
    respondCheckpoint({ tables: checked, hint: hint.value() });
  };
  footer.appendChild(confirmBtn);
}

// ---- 2. 字段选择 ----
function renderFieldsCp(body, footer, cp) {
  const msg = document.createElement('p');
  msg.className = 'cp-msg';
  msg.textContent = cp.message || '请勾选要暴露给智能体的字段';
  body.appendChild(msg);

  const fbt = cp.fieldsByTable || {};
  const fsel = JSON.parse(JSON.stringify(cp.fieldsSelected || {}));

  for (const table of Object.keys(fbt)) {
    const group = document.createElement('div');
    group.className = 'cp-table-group';
    const head = document.createElement('div');
    head.className = 'cp-table-name';
    head.innerHTML = `<span>${escapeHtml(table)}</span>
      <span class="cp-count">${fbt[table].length} 列 / 已选 ${(fsel[table] || []).length}</span>
      <span class="cp-actions-inline">
        <button class="btn" data-tbl="${escapeAttr(table)}" data-act="all">全选</button>
        <button class="btn" data-tbl="${escapeAttr(table)}" data-act="none">清空</button>
      </span>`;
    head.querySelector('[data-act="all"]').onclick = () => setTable(table, true);
    head.querySelector('[data-act="none"]').onclick = () => setTable(table, false);
    group.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'cp-fields';
    grid.dataset.table = table;
    for (const col of fbt[table]) {
      const lab = document.createElement('label');
      const checked = (fsel[table] || []).includes(col);
      lab.innerHTML = `<input type="checkbox" data-table="${escapeAttr(table)}" data-col="${escapeAttr(col)}" ${checked ? 'checked' : ''} />
                       <span>${escapeHtml(col)}</span>`;
      grid.appendChild(lab);
    }
    group.appendChild(grid);
    body.appendChild(group);
  }

  // 提示词输入框
  const hint = makeHintBox({
    label: '补充提示词',
    placeholder: '可选: 调整字段, 比如"补上 refund_at 字段"、"看看 status 的分布"、"加一列设备类型"等'
  });
  body.appendChild(hint.el);

  // 取消 / 确认
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-ghost';
  cancelBtn.textContent = '取消任务';
  cancelBtn.onclick = () => respondCheckpoint({ cancelled: true });
  footer.appendChild(cancelBtn);

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'btn btn-primary';
  confirmBtn.textContent = '确认';
  confirmBtn.onclick = () => {
    const out = {};
    body.querySelectorAll('.cp-fields').forEach((grid) => {
      const t = grid.dataset.table;
      out[t] = [...grid.querySelectorAll('input:checked')].map((c) => c.dataset.col);
    });
    respondCheckpoint({ fields: out, hint: hint.value() });
  };
  footer.appendChild(confirmBtn);

  function setTable(t, v) {
    const grid = body.querySelector(`.cp-fields[data-table="${CSS.escape(t)}"]`);
    if (!grid) return;
    grid.querySelectorAll('input').forEach((c) => { c.checked = v; });
  }
}

// 提示词输入框 (通用)
function makeHintBox({ label, placeholder }) {
  const wrap = document.createElement('div');
  wrap.className = 'cp-hint';
  const lab = document.createElement('div');
  lab.className = 'cp-hint-label';
  lab.innerHTML = `<span>${escapeHtml(label || '补充提示词')}</span>
    <span class="cp-hint-hint">— 将作为附加上下文传给 AI, 不会替换你的任务</span>`;
  const ta = document.createElement('textarea');
  ta.className = 'cp-hint-input';
  ta.placeholder = placeholder || '';
  ta.rows = 2;
  wrap.appendChild(lab);
  wrap.appendChild(ta);
  return { el: wrap, value: () => ta.value.trim() };
}

// ---- 3. SQL 预览 ----
function renderSqlCp(body, footer, cp) {
  const row = document.createElement('div');
  row.className = 'cp-sql-row';
  row.innerHTML = `<div class="cp-sql-title">${escapeHtml(cp.title || 'SQL')}</div>
    <div class="cp-actions-inline">
      <button class="btn" data-act="copy">复制</button>
      <button class="btn" data-act="edit">编辑</button>
    </div>`;
  body.appendChild(row);

  // 先用业务语言把这一步交代清楚, 再给 SQL 本身。
  // title 已经是"做什么" (模型给的 purpose), 所以这里只补"为什么"和字段清单。
  const fields = Array.isArray(cp.fields) ? cp.fields : [];
  const infoHtml = [];
  if (cp.why && cp.why !== cp.title) {
    infoHtml.push(`<div class="cp-sql-info-row"><span class="cp-sql-info-k">为什么</span><span class="cp-sql-info-v">${escapeHtml(cp.why)}</span></div>`);
  }
  if (fields.length) {
    const items = fields
      .map((f) => {
        const n = escapeHtml((f && f.name) || '');
        const m = escapeHtml((f && f.meaning) || '');
        return `<span class="cp-field"><code>${n}</code>${m ? `<em>${m}</em>` : ''}</span>`;
      })
      .join('');
    infoHtml.push(`<div class="cp-sql-info-row"><span class="cp-sql-info-k">用到的字段</span><span class="cp-sql-info-v cp-fields">${items}</span></div>`);
  }
  if (infoHtml.length) {
    const info = document.createElement('div');
    info.className = 'cp-sql-info';
    info.innerHTML = infoHtml.join('');
    body.appendChild(info);
  }

  const pre = document.createElement('pre');
  pre.className = 'cp-sql-block';
  pre.textContent = cp.sql || '';
  body.appendChild(pre);

  let editing = false;
  let editedSql = cp.sql || '';
  const ta = document.createElement('textarea');
  ta.className = 'cp-sql-edit';
  ta.value = editedSql;
  ta.style.display = 'none';
  body.appendChild(ta);

  row.querySelector('[data-act="copy"]').onclick = async () => {
    try {
      await navigator.clipboard.writeText(cp.sql || '');
      toast('已复制到剪贴板');
    } catch (e) {
      toast('复制失败: ' + e.message, 'err');
    }
  };
  row.querySelector('[data-act="edit"]').onclick = () => {
    editing = !editing;
    if (editing) {
      pre.style.display = 'none';
      ta.style.display = '';
      ta.value = cp.sql || '';
      row.querySelector('[data-act="edit"]').textContent = '取消编辑';
    } else {
      pre.style.display = '';
      ta.style.display = 'none';
      row.querySelector('[data-act="edit"]').textContent = '编辑';
    }
  };

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-ghost';
  cancelBtn.textContent = '取消任务';
  cancelBtn.onclick = () => respondCheckpoint({ cancelled: true });
  footer.appendChild(cancelBtn);

  const skipBtn = document.createElement('button');
  skipBtn.className = 'btn';
  skipBtn.textContent = '跳过本步';
  skipBtn.onclick = () => respondCheckpoint({ skip: true });
  footer.appendChild(skipBtn);

  const runBtn = document.createElement('button');
  runBtn.className = 'btn btn-primary';
  runBtn.textContent = '执行';
  runBtn.onclick = () => {
    const sql = editing ? ta.value.trim() : cp.sql;
    if (!sql) {
      toast('SQL 不能为空', 'err');
      return;
    }
    respondCheckpoint({ sql, confirmed: true });
  };
  footer.appendChild(runBtn);
}

// ---- 4. 输出格式 ----
function renderOutputCp(body, footer, cp) {
  const msg = document.createElement('p');
  msg.className = 'cp-msg';
  msg.textContent = cp.message || '请选择输出格式';
  body.appendChild(msg);

  const group = document.createElement('div');
  group.className = 'cp-radio-group';
  const opts = [
    { v: 'excel', title: 'Excel 表格 (.xlsx)', sub: '每个 SQL 结果作为一个 sheet, 包含总览页' },
    { v: 'html',  title: 'HTML 报告',          sub: '带样式的网页, 可在浏览器中查看或打印' },
    { v: 'none',  title: '不需要输出',          sub: '仅在对话中显示总结, 不生成文件' }
  ];
  let selected = 'none';
  for (const o of opts) {
    const lab = document.createElement('label');
    lab.className = 'cp-radio';
    lab.dataset.value = o.v;
    lab.innerHTML = `<input type="radio" name="cpOut" value="${o.v}" ${o.v === selected ? 'checked' : ''}/>
      <div class="cp-radio-body">
        <div class="cp-radio-title">${escapeHtml(o.title)}</div>
        <div class="cp-radio-sub">${escapeHtml(o.sub)}</div>
      </div>`;
    lab.onclick = () => {
      selected = o.v;
      group.querySelectorAll('.cp-radio').forEach((r) => r.classList.toggle('selected', r.dataset.value === selected));
    };
    if (o.v === selected) lab.classList.add('selected');
    group.appendChild(lab);
  }
  body.appendChild(group);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-ghost';
  cancelBtn.textContent = '取消任务';
  cancelBtn.onclick = () => respondCheckpoint({ cancelled: true });
  footer.appendChild(cancelBtn);

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'btn btn-primary';
  confirmBtn.textContent = '确认';
  confirmBtn.onclick = () => respondCheckpoint({ output: selected });
  footer.appendChild(confirmBtn);
}

// ---- 5. 追问 (智能体缺信息时反问) ----
/*
 * 这里原来是个兜底分支: 把整个 checkpoint 对象 JSON.stringify 出来丢进 <pre>,
 * 底下只给一个"确认"。后果是模型明明给了三个选项, 用户一个都点不了 ——
 * 他只能点"确认", 而"确认"回的是 { confirmed: true }, 没有 answer 字段,
 * agent 那头读到的就是"用户没有给出明确回答"。
 * 于是选项形同虚设, 追问这一轮等于白问。
 */
function renderQuestionCp(body, footer, cp) {
  const msg = document.createElement('p');
  msg.className = 'cp-msg';
  msg.textContent = cp.question || '智能体需要你补充一点信息';
  body.appendChild(msg);

  const opts = (Array.isArray(cp.options) ? cp.options : [])
    .map((o) => String(o || '').trim())
    .filter(Boolean);

  const ta = document.createElement('textarea');
  ta.className = 'cp-answer';
  ta.rows = 3;
  ta.placeholder = opts.length ? '也可以不选, 自己写一句' : '写一句你的回答';

  const group = document.createElement('div');
  group.className = 'cp-radio-group';
  opts.forEach((o, i) => {
    const lab = document.createElement('label');
    lab.className = 'cp-radio';
    lab.dataset.value = String(i);
    lab.innerHTML = `<input type="radio" name="cpQ" value="${i}"/>
      <div class="cp-radio-body"><div class="cp-radio-title">${escapeHtml(o)}</div></div>`;
    lab.onclick = () => {
      group.querySelectorAll('.cp-radio').forEach((r) => r.classList.toggle('selected', r.dataset.value === String(i)));
      // 选中只是把这句话填进输入框 —— 你还能在它基础上改
      ta.value = o;
      syncSubmit();
      ta.focus();
    };
    group.appendChild(lab);
  });
  if (opts.length) body.appendChild(group);

  const hint = document.createElement('div');
  hint.className = 'cp-hint-label';
  hint.textContent = opts.length ? '或者自己说' : '你的回答';
  body.appendChild(hint);
  body.appendChild(ta);

  // 手打的内容和任何选项都不一样时, 把选项的高亮撤掉, 免得看着像"你选了那个"
  ta.addEventListener('input', () => {
    if (!opts.includes(ta.value)) {
      group.querySelectorAll('.cp-radio').forEach((r) => r.classList.remove('selected'));
    }
    syncSubmit();
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-ghost';
  cancelBtn.textContent = '取消任务';
  cancelBtn.onclick = () => respondCheckpoint({ cancelled: true });
  footer.appendChild(cancelBtn);

  // 留着这条路: 有时用户确实没什么可补充的, 那就明确说"没有", 而不是让
  // agent 以为收到了一条空回答。agent 对这两种情况的处理是不一样的。
  const skipBtn = document.createElement('button');
  skipBtn.className = 'btn';
  skipBtn.textContent = '不补充, 直接继续';
  skipBtn.onclick = () => respondCheckpoint({ confirmed: true });
  footer.appendChild(skipBtn);

  const okBtn = document.createElement('button');
  okBtn.className = 'btn btn-primary';
  okBtn.textContent = '提交回答';
  function syncSubmit() {
    okBtn.disabled = !ta.value.trim();
  }
  okBtn.onclick = () => {
    const answer = ta.value.trim();
    if (!answer) {
      toast('先写一句回答, 或者点「不补充, 直接继续」', 'err');
      return;
    }
    respondCheckpoint({ answer, confirmed: true });
  };
  footer.appendChild(okBtn);
  syncSubmit();
}





