const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// 把 userData (配置/技能等持久化数据) 放在项目内, 便于沙箱/便携环境运行
// 可通过环境变量 SOLODB_USER_DATA 覆盖
const userDataDir = process.env.SOLODB_USER_DATA || path.join(__dirname, '.appdata');
if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });
app.setPath('userData', userDataDir);

const Database = require('./lib/database');
const DbRouter = require('./lib/db-router');
const LLMClient = require('./lib/llm');
const Models = require('./lib/models');
const Agent = require('./lib/agent');
const Skills = require('./lib/skills');
const Store = require('./lib/store');
const { isSafeId } = require('./lib/safe-id');
const { publicConfig: toPublicConfig } = require('./lib/public-config');
const { CONV_MAX_TURNS, turnCount } = require('./lib/conversation.js');
const AiChatStore = require('./lib/ai-chat-store');
const Report = require('./lib/report');
const { MCPManager } = require('./lib/mcp');
const Prompt = require('./lib/prompt');
const Engine = require('./lib/engine');
// 流程卡包的格式与判断 (指纹、库对应、导入计划) 都在这里, 主进程只用它的文件那半边
const CardPack = require('./lib/cardpack');
const { EngineAiBuilder, normalizeBuilderLimits } = require('./lib/engine-ai');
const { runTestLoop } = require('./lib/test-loop');
const { buildCatalog } = require('./lib/tool-catalog');
const { writeFileAtomic } = require('./lib/atomic-write');
// 知识库 / RAG (见 docs/知识库-RAG-决策记录.md)
const { KnowledgeStore } = require('./lib/knowledge/store');
const { QaStore, FEEDBACK_TAGS } = require('./lib/knowledge/qa');
const { KnowledgeService } = require('./lib/knowledge');

let mainWindow = null;
let configPath = null;
// 配置有没有被成功读进来。false = 启动时文件在但读不出来, 此时内存里是出厂默认值,
// 任何写盘都是在盖掉用户的数据。见 saveConfig() 与 loadConfig()。
let configLoaded = false;
let store = null;
let aiChatStore = null;
// 知识库: store 管"知识库/文件夹/文档/分块/向量", qa 管问答飞轮, knowledge 是给
// Agent 用的门面 (检索 / 导入)。三者都在 whenReady 里初始化。
let knowledgeStore = null;
let qaStore = null;
let knowledge = null;
const pendingCheckpoints = new Map();
let config = {
  llm: {
    baseURL: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini'
  },
  databases: [],
  // 流程卡: 管理员在「流程引擎」页配好的确定性流程。空数组 = 这个功能没启用。
  // 形状见 lib/engine.js 的 newEngine()
  engines: [],
  skills: {
    enabled: []
  },
  // 外部工具 (MCP servers)。留空就是纯内置动作, 行为跟以前一致。
  mcp: {
    servers: []
  },
  // 知识库 / RAG。向量模型与分块策略都在这里统一配 (新建知识库时不再单独选);
  // retrieval 是检索参数; defaultKbId 是对话页没选库时的兜底。
  knowledge: {
    embedding: { provider: 'custom', baseURL: '', apiKey: '', model: '' },
    chunkConfig: { strategy: 'fixed', size: 800, overlap: 120, semanticThreshold: 0.72 },
    retrieval: { topK: 5, candidateN: 20, rerank: true },
    defaultKbId: null
  },
  // 系统提示词的模块化覆盖。只存"改过的/关掉的", 没提到的用出厂值。
  // 形状见 lib/prompt.js
  prompt: {
    modules: {}
  },
  // 行为参数。走设置页的「通用」。
  general: {
    maxSteps: 16,
    historyTurns: 6,
    // 一次提问里, 步数跑满之后最多自动接着开几轮。
    //
    // 以前没有这个概念: 步数跑满就**强制生成总结**, 任务半途被砍断 (用户看到的
    // "已达最大步数, 强制生成总结")。现在跑满会压缩上下文接着做, 这个值管的是
    // "最多接几轮"。给 12 是留足余量 —— 常规任务连一轮都跑不满, 撞上它的多半
    // 是真的陷入循环了, 那时候该如实报错而不是继续烧钱。
    maxRounds: 12
  },
  // 搭建 Agent 的行为参数。走设置页的「引擎」。
  //
  // 以前这两个值是 lib/engine-ai.js 里的硬编码常量 (40 步 / 3 轮), 用户既看不到
  // 也调不了 —— 只能等它跑满, 然后按提示"再说一句继续"。放到这里之后,
  // 卡复杂就调大, 嫌费钱就调小。
  builder: {
    maxSteps: 40,
    maxRounds: 3
  },
  // 版本更新。走设置页的「关于」。
  //
  // 只有一个字段: 更新源地址。**不存"上次检查结果"** —— 那是一份会过期的快照,
  // 存进 config.json 只会被那 900ms 一次的全量重写反复带上, 而用户下次打开
  // 看到的还是一条旧结论。检查结果只在本次会话里有效。
  update: {
    feedUrl: ''
  }
};

/** 通用设置的白名单与取值范围 —— 从模型那侧收上来的一律先过这里 */
const GENERAL_LIMITS = {
  maxSteps: { min: 3, max: 60, fallback: 16 },
  historyTurns: { min: 0, max: 30, fallback: 6 },
  maxRounds: { min: 1, max: 50, fallback: 12 }
};

/**
 * 搭建 Agent 的取值范围和夹取逻辑在 lib/engine-ai.js 里 (BUILDER_LIMITS)。
 * 放那儿是为了和 MAX_TURNS / MAX_ROUNDS 挨着 —— 那两个默认值就是它俩,
 * 分开放迟早会对不上; 而且 main.js 要 Electron 才能 require, 放这儿没法测。
 */
const normalizeBuilder = normalizeBuilderLimits;

function normalizeGeneral(input) {
  const src = (input && typeof input === 'object') ? input : {};
  const out = {};
  for (const key of Object.keys(GENERAL_LIMITS)) {
    const lim = GENERAL_LIMITS[key];
    // 不能直接 Number(raw): **Number(null) === 0, Number('') === 0**。
    // 那会把"这一项没填"当成填了 0, 再被夹成下限 —— 用户看到的是
    // "我什么都没动, 它自己变成最小值了"。(和 normalizeBuilderLimits 同一处坑)
    const raw = src[key];
    const n = (raw === null || raw === undefined || raw === '') ? NaN : Number(raw);
    out[key] = Number.isFinite(n) ? Math.min(lim.max, Math.max(lim.min, Math.floor(n))) : lim.fallback;
  }
  return out;
}

/**
 * 更新源地址的归一化。
 *
 * 只放行 http / https —— 这个值是主进程拿去发请求的, 放开别的协议等于"让配置
 * 决定读哪个本地文件"。不合法就落成空串 (等于没配), 由界面那边负责说明原因。
 */
function normalizeUpdate(input) {
  const src = (input && typeof input === 'object') ? input : {};
  const raw = typeof src.feedUrl === 'string' ? src.feedUrl.trim() : '';
  return { feedUrl: /^https?:\/\/\S+$/i.test(raw) ? raw : '' };
}

/** 取更新源的超时。内网地址通常毫秒级, 8 秒还没回来说明它根本没在跑。 */
const UPDATE_TIMEOUT_MS = 8000;

/** 版本号只按数字段比大小: 1.10.0 > 1.9.0; v 前缀与 -beta 后缀都忽略。 */
function compareVersion(a, b) {
  const seg = (v) => String(v || '').trim().replace(/^v/i, '').split('-')[0].split('.')
    .map((x) => parseInt(x, 10) || 0);
  const x = seg(a);
  const y = seg(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * 拉一份更新源。请求在**主进程**发, 不是渲染层 —— 内网地址往往没有 CORS 头,
 * 从页面里 fetch 会被浏览器直接拦掉, 而且那样还得把内网地址暴露给页面。
 *
 * 认两种写法: 直接一份 { version, url, ... }, 或包一层 { latest: { ... } }。
 */
async function fetchUpdateFeed(url) {
  if (typeof fetch !== 'function') throw new Error('当前运行环境不支持 fetch');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), UPDATE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`更新源返回 ${res.status}`);
    const data = await res.json();
    const feed = (data && typeof data === 'object' && data.latest && typeof data.latest === 'object')
      ? data.latest : (data || {});
    const version = String(feed.version || '').trim();
    if (!version) throw new Error('更新源里没有 version 字段');
    const rawUrl = String(feed.url || '').trim();
    return {
      version,
      publishedAt: String(feed.publishedAt || feed.published_at || '').trim(),
      url: /^https?:\/\//i.test(rawUrl) ? rawUrl : '',
      notes: String(feed.notes || '').trim()
    };
  } catch (e) {
    // AbortError 的 message 是 "This operation was aborted", 对着界面说人话
    if (e && (e.name === 'AbortError' || /abort/i.test(e.message || ''))) {
      throw new Error(`请求超时 (${UPDATE_TIMEOUT_MS / 1000}s): 更新源没响应`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function loadConfig() {
  configPath = path.join(app.getPath('userData'), 'config.json');
  // 默认允许写盘: 全新安装根本没有这个文件, 那是正常情况。
  // 只有"文件在, 但读不出来"才置 false。
  configLoaded = true;
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      config = { ...config, ...parsed };
      // general 是**浅**合并: 存盘里的 general 会整个盖掉默认值里那一个。
      // 于是"新加了一个 general 项"这件事对老配置不生效 —— 它会一直缺着,
      // 靠下游各自的 || 兜底值活着, 而兜底值和默认值迟早会不一样。
      // 这里过一遍归一化, 缺的项用默认值补齐、越界的夹回范围。
      config.general = normalizeGeneral(config.general);
      config.update = normalizeUpdate(config.update);
    }
  } catch (e) {
    // 文件在, 但读不出来 —— 这跟"没配过"是两件完全不同的事。
    //
    // 以前这里只打一行日志, 然后下面的迁移会无条件 saveConfig(), 把出厂默认
    // 整份盖到坏文件上: 用户的 4 个库(含口令) / API Key / 全部流程卡一起没,
    // 而且没留任何备份。现在: 标记"没读成功"(让 saveConfig 拒绝写盘),
    // 并把坏文件另存一份, 用户还有手工抢救的余地。
    configLoaded = false;
    console.error('Failed to load config:', e);
    try {
      const bad = configPath + '.bad-' + Date.now();
      fs.copyFileSync(configPath, bad);
      console.error('原配置文件已备份到:', bad);
    } catch (e2) {
      console.error('备份坏配置也失败了:', e2);
    }
  }
  // 模型清单的归一**放在 try 外面**: 配置文件不存在、或者读坏了, 也要把出厂默认
  // 那个扁平形状变成清单。放在里面的话, 全新安装的机器上 config.llm 会一直是
  // 扁平形状, 第一次存盘就把旧形状写回盘里 —— 迁移等于没做。
  const before = JSON.stringify(config.llm || null);
  config.llm = Models.storedLLM(config.llm);
  // 形状变了就写回。不写回的话每次启动都要迁移一遍, 而迁移会生成新的 id:
  // 用户这次选中的是 m_abc, 重启后变成 m_xyz, 界面上看起来就是"选择没被记住"。
  if (JSON.stringify(config.llm) !== before) saveConfig();
}

function saveConfig() {
  // 配置没读成功时**绝不允许写盘**。
  //
  // 那意味着启动时 JSON.parse 失败了, 内存里的 config 是模块级出厂默认值
  // (databases: []、llm.apiKey: '')。把它写下去就是用默认值盖掉用户的
  // 4 个库(含口令) + API Key + 全部流程卡, 而且没有任何备份。
  if (!configLoaded) {
    console.error('配置没有成功读入, 拒绝写盘 (避免用出厂默认覆盖用户原有配置)');
    return false;
  }
  try {
    // 原子写: 这个文件每 900ms 就可能被流程卡自动保存全量重写一次,
    // 而半截的 config.json 正是上面那条要防的输入。
    writeFileAtomic(configPath, JSON.stringify(config, null, 2));
    return true;
  } catch (e) {
    console.error('Failed to save config:', e);
    return false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#f6f7f9',
    title: 'Askaha',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  // 把窗口钉在自己的页面上。
  // 这个应用没有任何"跳转到别处"的正常需求, 而报告里可能带链接 —— 万一有
  // 一段不可信 HTML 让主框架导航走了, 就会在一个持有 bridge 的窗口里加载外部页面。
  // 外链改为交给系统浏览器打开, 窗口本身永远停在 index.html。
  const appIndex = path.resolve(__dirname, 'src', 'index.html');
  const isAppPage = (url) => {
    try {
      const u = new URL(url);
      if (u.protocol !== 'file:') return false;
      // Windows 上 file:///D:/x → pathname 是 "/D:/x", 去掉开头的斜杠再规范化
      const p = path.resolve(decodeURIComponent(u.pathname).replace(/^\//, ''));
      return p.toLowerCase() === appIndex.toLowerCase();
    } catch (e) {
      return false;
    }
  };

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAppPage(url)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  // window.open / target=_blank 一律不开新窗口 (默认行为是开一个没有 preload 的
  // 裸 BrowserWindow, 不受我们控制)。外链同样丢给系统浏览器。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // 开发模式下自动打开 DevTools 方便排查
    if (process.argv.includes('--dev')) {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  });

  // 把渲染端的所有 console 输出也转发到主进程终端, 方便排查
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const tag = ['VRB', 'INF', 'WRN', 'ERR'][level] || 'LOG';
    console.log(`[renderer ${tag}] ${message}  (${sourceId}:${line})`);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  loadConfig();
  store = new Store({ rootDir: app.getPath('userData') });
  aiChatStore = new AiChatStore({ rootDir: app.getPath('userData') });
  knowledgeStore = new KnowledgeStore({ rootDir: path.join(app.getPath('userData'), 'knowledge') });
  qaStore = new QaStore({ rootDir: path.join(app.getPath('userData'), 'knowledge', 'qa') });
  knowledge = new KnowledgeService({
    store: knowledgeStore,
    qa: qaStore,
    getConfig: () => config.knowledge || {}
  });
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ========== IPC Handlers ==========

/**
 * 给渲染进程看的配置副本: **密钥一律抹掉, 只留"配没配"的布尔**。
 * 具体规则见 lib/public-config.js (单独一个模块, 便于单测)。
 */
function publicConfig() {
  return toPublicConfig(config);
}

/**
 * 当前选中模型上的 LLMClient。
 *
 * 收口成一个函数, 而不是让每个调用点自己 `currentLLM()` ——
 * 那样每加一处就多一个"忘了改成 activeModel"的机会, 而那种漏掉的症状是
 * "某个功能偷偷用了另一个模型", 极难发现 (界面显示的是 A, 实际跑的是 B)。
 */
function currentLLM() {
  return new LLMClient(Models.activeModel(config.llm) || {});
}

/** 当前选中模型有没有配 Key。没配时所有调用都该在入口就挡住。 */
function llmReady() {
  const m = Models.activeModel(config.llm);
  return !!(m && m.apiKey);
}

ipcMain.handle('config:get', () => publicConfig());

/**
 * 改当前选中模型的字段 (不含增删/切换)。
 *
 * 保留这个 handler 是因为它是"改一栏"的语义: 渲染层拿不到明文密钥, 所以它
 * **没带 apiKey 字段**就表示用户没动这一栏, 展开合并天然保留原有值。
 * 只有显式传 `apiKey: ''` 才是清空。
 *
 * 注意它现在只作用在**当前选中的那一条**上 —— 以前 config.llm 就是那个模型,
 * 现在它是个清单, 直接展开合并会把 models/activeId 覆盖成乱七八糟的东西。
 */
ipcMain.handle('config:setLLM', (_e, llm) => {
  const input = (llm && typeof llm === 'object') ? llm : {};
  const { models, activeId } = Models.normalizeLLM(config.llm);
  const idx = models.findIndex((m) => m.id === activeId);
  if (idx >= 0) {
    // 只接"模型字段", 不接清单字段。渲染层要是误传了 models, 也不该让它
    // 从这条路径改清单 —— 那会绕开 llm:save 的校验和 id 分配。
    const patch = { ...input };
    delete patch.models;
    delete patch.activeId;
    models[idx] = Models.normalizeModel({ ...models[idx], ...patch });
  }
  config.llm = { models, activeId };
  saveConfig();
  return publicConfig().llm;
});

/** 新增或更新一条模型。没有 id 就是新增, 有就是更新那一条。 */
ipcMain.handle('llm:save', (_e, input) => {
  const src = (input && typeof input === 'object') ? input : {};
  const { models, activeId } = Models.normalizeLLM(config.llm);
  const id = typeof src.id === 'string' ? src.id.trim() : '';
  const idx = id ? models.findIndex((m) => m.id === id) : -1;

  if (idx >= 0) {
    // 更新。apiKey 没带字段 = 不动; 显式传 '' = 清空。
    const patch = { ...src };
    if (!('apiKey' in patch)) patch.apiKey = models[idx].apiKey;
    models[idx] = Models.normalizeModel({ ...models[idx], ...patch, id });
  } else {
    const created = Models.normalizeModel(src);
    models.push(created);
    // 新增的第一条自动成为当前选中 —— 否则用户加了模型却发现"选了没用",
    // 因为选中还指着空字符串。
    if (!models.some((m) => m.id === activeId)) {
      config.llm = { models, activeId: created.id };
      saveConfig();
      return publicConfig().llm;
    }
  }
  config.llm = { models, activeId };
  saveConfig();
  return publicConfig().llm;
});

ipcMain.handle('llm:delete', (_e, id) => {
  const { models, activeId } = Models.normalizeLLM(config.llm);
  const rest = models.filter((m) => m.id !== id);
  // 删掉的正是当前选中那一条时, 选中回落到第一条 —— 不能留一个指向不存在
  // 模型的 activeId, 那样之后每次调用都会报"未配置模型", 而清单里明明还有别的。
  config.llm = { models: rest, activeId: activeId === id ? (rest[0] ? rest[0].id : '') : activeId };
  saveConfig();
  return publicConfig().llm;
});

ipcMain.handle('llm:setActive', (_e, id) => {
  const { models, activeId } = Models.normalizeLLM(config.llm);
  // 只接受清单里真实存在的 id。不接受的话界面上一个手滑 (或者渲染层被篡改)
  // 就能把 activeId 指到空处, 结果和上面一样。
  const next = models.some((m) => m.id === id) ? id : activeId;
  config.llm = { models, activeId: next };
  saveConfig();
  return publicConfig().llm;
});

ipcMain.handle('config:addDatabase', (_e, db) => {
  const id = 'db_' + Date.now();
  // tables 是用户勾选的可访问表清单: [{name, checked, note}]
  const record = { tables: [], ...db, id };
  config.databases.push(record);
  saveConfig();
  return publicConfig().databases;
});

/**
 * 保存某个数据库的表清单 (探测结果 + 勾选状态 + 备注)。
 * 探测用的是全量结果, 所以要保留已有条目的 checked / note, 不能整份覆盖。
 */
ipcMain.handle('config:setDatabaseTables', (_e, { id, tables }) => {
  const db = config.databases.find((d) => d.id === id);
  if (!db) return { ok: false, error: '数据库不存在' };
  if (!Array.isArray(tables)) return { ok: false, error: 'tables 必须是数组' };

  const prev = new Map((db.tables || []).map((t) => [t.name, t]));
  db.tables = tables.map((t) => {
    const name = typeof t === 'string' ? t : t && t.name;
    const old = prev.get(name);
    // comment 是**库里维护的**那份注释, 每次探测都刷新 (它是只读镜像, 用户改不了)。
    // 探测没带 comment 时保留上一次的 —— 有些调用方只传表名。
    const incomingComment = typeof t === 'object' && t && typeof t.comment === 'string'
      ? t.comment.trim()
      : '';
    return {
      name,
      checked: typeof t === 'object' && t && typeof t.checked === 'boolean'
        ? t.checked
        : (old ? !!old.checked : false),
      // note 是用户自己写的, 永远不动 —— 探测只补 comment, 绝不覆盖用户输入
      note: typeof t === 'object' && t && typeof t.note === 'string'
        ? t.note
        : (old && old.note) || '',
      comment: incomingComment || (old && old.comment) || ''
    };
  }).filter((t) => t.name);

  saveConfig();
  return { ok: true, tables: db.tables };
});

ipcMain.handle('config:removeDatabase', (_e, id) => {
  config.databases = config.databases.filter((d) => d.id !== id);
  saveConfig();
  return publicConfig().databases;
});

ipcMain.handle('db:test', async (_e, dbConfig) => {
  const db = new Database(dbConfig);
  try {
    const result = await db.test();
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    await db.close();
  }
});

/**
 * 探测数据表: 取表名 **以及库里维护的表注释**, 不读取任何表结构 (DDL)。
 * 按 dbId 传参时用配置里的连接信息, 避免把密码在渲染层来回传。
 *
 * 返回 { ok, tables: [{name, comment}] }。以前 tables 是 string[], 现在带上了
 * 注释 —— 选表那一步只看表名和备注, 而库里那份注释是最权威的说明, 不该让用户
 * 再手工抄一遍。调用方只有两处 (数据空间页的探测按钮、流程卡的取数节点),
 * 两边都已跟着改。
 */
ipcMain.handle('db:listTables', async (_e, { dbId, dbConfig }) => {
  let conf = dbConfig;
  if (!conf && dbId) {
    const found = config.databases.find((d) => d.id === dbId);
    if (!found) return { ok: false, error: '数据库不存在' };
    conf = found;
  }
  if (!conf) return { ok: false, error: '缺少连接信息' };

  const db = new Database(conf);
  try {
    const tables = await db.listTablesDetailed();
    return { ok: true, tables };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    await db.close();
  }
});

/**
 * 读一张表的字段清单。
 * 流程卡的取数节点要"选到字段维度", 所以渲染层需要一个只读字段的入口。
 */
ipcMain.handle('db:describeTable', async (_e, { dbId, dbConfig, table }) => {
  let conf = dbConfig;
  if (!conf && dbId) {
    const found = config.databases.find((d) => d.id === dbId);
    if (!found) return { ok: false, error: '数据库不存在' };
    conf = found;
  }
  if (!conf) return { ok: false, error: '缺少连接信息' };
  if (!table) return { ok: false, error: '缺少表名' };

  const db = new Database(conf);
  try {
    const fields = await db.describeTable(table);
    return { ok: true, table, fields };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    await db.close();
  }
});

/* ==================== 流程卡 ==================== */
// 卡片的形状与校验都在 lib/engine.js 里, 主进程只负责存取, 不自己拼结构。

// 列表里把每张卡过一遍 normalizeEngine: 补给旧卡的"输入项镜像"(见 normalizeNode) 和
// 其它规范化。**保留时间戳** —— 否则每次列出来 updatedAt 都被刷成"现在"。
// 只影响返回的这一份, 不落盘。
ipcMain.handle('engine:list', () => ({
  ok: true,
  engines: (Array.isArray(config.engines) ? config.engines : []).map((e) => Engine.normalizeEngine(e, { keepTimestamps: true }))
}));

/** 存一张流程卡。同步版和异步版共用这一份, 免得两边逻辑漂移。 */
function saveEngineCard(input) {
  const card = Engine.normalizeEngine(input || {});
  const list = Array.isArray(config.engines) ? config.engines.slice() : [];
  const i = list.findIndex((x) => x.id === card.id);
  if (i >= 0) list[i] = card; else list.push(card);
  config.engines = list;
  // 写盘失败必须报出去。以前这里把 saveConfig() 的返回值丢掉、无条件返回 ok:true,
  // 于是磁盘满 / 目录只读 / 同步盘占用文件时, 界面照样显示「已自动保存 12:34:56」,
  // 实际一个字节都没落盘, 重启后这张卡的改动全没了 —— 而界面从头到尾没提示过。
  // (渲染层本来就想报错, 见 src/js/engines.js 的 engAutoSave: 它判的就是 r.ok。)
  if (!saveConfig()) {
    return { ok: false, error: '写盘失败, 这张卡没有保存成功 (检查磁盘空间或目录权限)' };
  }
  return { ok: true, engine: card, engines: config.engines };
}

ipcMain.handle('engine:save', (_e, input) => saveEngineCard(input));

/**
 * 关窗时的最后一道保存。
 *
 * 渲染层的自动保存是防抖的 (停手 900ms 才写盘), 所以"改完立刻关窗"会落在
 * 那个窗口里。beforeunload 里没法 await, 只能用同步 IPC 把这一次挡住 ——
 * 宁可关窗慢几十毫秒, 也不要吃掉用户最后一笔改动。
 *
 * 只在关窗这一条路上用。平时一律走 engine:save, 不要把同步 IPC 当常规通道。
 */
ipcMain.on('engine:saveSync', (e, input) => {
  try {
    e.returnValue = saveEngineCard(input);
  } catch (err) {
    e.returnValue = { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('engine:delete', (_e, id) => {
  const list = Array.isArray(config.engines) ? config.engines : [];
  const before = list.length;
  const kept = list.filter((x) => x && x.id !== id);
  if (kept.length === before) return { ok: false, error: '找不到这张流程卡' };
  const prev = config.engines;
  config.engines = kept;
  if (!saveConfig()) {
    // 盘上没变, 内存也拨回去, 别让两边不一致; 更不能接着去删它的 AI 对话
    // —— 否则重启后卡回来了、它名下的对话却已经清掉。
    config.engines = prev;
    return { ok: false, error: '写盘失败, 没有删除成功 (检查磁盘空间或目录权限)' };
  }
  // 卡没了, 它名下的 AI 对话也一起清掉 —— 留着就是盘上的孤儿, 历史列表里
  // 还会挂着一堆点不开的条目
  if (aiChatStore) aiChatStore.removeByCard(id);
  return { ok: true, engines: config.engines };
});

ipcMain.handle('engine:validate', (_e, input) => Engine.validateEngine(input));

/* ---- 流程卡导入导出 (卡包) ----
 *
 * 卡包的格式与全部判断都在 lib/cardpack.js 里, 主进程只负责**文件那一半**:
 * 弹选择框、读写磁盘。哪张卡该覆盖、哪个库对应哪个库, 全由渲染层算好再送上来
 * (它手上就有本机的库清单), 这里不重复实现一遍 —— 两处各写一套迟早会对不上。
 *
 * 真正把关的是两件事:
 *   1. 卡包里**不带任何凭据** (由 buildPack 保证, 见那边的注释);
 *   2. 导入的卡一律过 Engine.normalizeEngine 洗一遍, 不信任文件里的形状。
 */

ipcMain.handle('engine:exportPack', async (_e, payload) => {
  const all = Array.isArray(config.engines) ? config.engines : [];
  const ids = (payload && Array.isArray(payload.ids)) ? payload.ids.map(String) : null;
  // 没给 ids = 导出全部; 给了就只导这几张 (单个导出就是这一条路径, 只有一张)
  const cards = ids ? all.filter((e) => e && ids.includes(String(e.id))) : all;
  if (!cards.length) {
    return { ok: false, error: ids ? '选中的流程卡都不在了' : '这台机器上还没有流程卡' };
  }

  const pack = CardPack.buildPack({
    cards,
    databases: config.databases || [],
    app: { name: 'Askaha', version: app.getVersion() }
  });
  const text = CardPack.stringifyPack(pack);

  const r = await dialog.showSaveDialog(mainWindow, {
    title: cards.length === 1 ? '导出流程卡' : `导出 ${cards.length} 张流程卡`,
    defaultPath: CardPack.suggestFileName(cards),
    filters: [{ name: '流程卡包', extensions: ['json'] }]
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(r.filePath, text, 'utf-8');
  } catch (e) {
    return { ok: false, error: '写入失败: ' + ((e && e.message) || e) };
  }
  return {
    ok: true,
    path: r.filePath,
    count: cards.length,
    // 卡包里用到了几个库 —— 界面上要如实说"这包里带了 2 个库的连接说明"
    databases: pack.databases.length
  };
});

ipcMain.handle('engine:pickPack', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '选择流程卡包',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '流程卡包', extensions: ['json'] }]
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };

  const packs = [];
  const errors = [];
  for (const f of r.filePaths) {
    const fileName = path.basename(f);
    let text;
    try {
      // 先看大小再读: 用户选了个几百兆的 JSON 时不该把它整个读进内存
      const st = fs.statSync(f);
      if (st.size > CardPack.MAX_BYTES) {
        errors.push({ fileName, error: '文件太大, 不像是流程卡包' });
        continue;
      }
      text = fs.readFileSync(f, 'utf-8');
    } catch (e) {
      errors.push({ fileName, error: '读不了: ' + ((e && e.message) || e) });
      continue;
    }
    const parsed = CardPack.parsePack(text);
    if (!parsed.ok) { errors.push({ fileName, error: parsed.error }); continue; }
    packs.push({ fileName, filePath: f, pack: parsed.pack });
  }
  if (!packs.length && !errors.length) return { ok: false, error: '没有可导入的卡包' };
  return { ok: true, packs, errors };
});

ipcMain.handle('engine:applyImport', (_e, payload) => {
  const raw = (payload && Array.isArray(payload.cards)) ? payload.cards.filter(Boolean) : [];
  if (!raw.length) return { ok: false, error: '没有要导入的流程卡' };
  if (raw.length > CardPack.MAX_CARDS) {
    return { ok: false, error: `一次最多导入 ${CardPack.MAX_CARDS} 张卡 (收到 ${raw.length} 张)` };
  }

  const prev = config.engines;
  const next = Array.isArray(prev) ? prev.slice() : [];
  const incomplete = [];
  let added = 0;
  let updated = 0;

  for (const item of raw) {
    const card = Engine.normalizeEngine(item);
    const i = next.findIndex((x) => x && x.id === card.id);
    if (i >= 0) { next[i] = card; updated += 1; } else { next.push(card); added += 1; }
    // 导进来的卡可能填得不完整 (缺 SQL / 缺出口)。**照样导** —— 它在来源机器上
    // 就是这么存的, 直接拒收等于让用户没法把半成品搬过来。但要如实报出去。
    const v = Engine.validateEngine(card);
    if (!v.ok) incomplete.push({ name: card.name, errors: v.errors });
  }

  config.engines = next;
  if (!saveConfig()) {
    // 盘上没变, 内存也拨回去 —— 否则界面显示导入成功, 重启后全没了
    config.engines = prev;
    return { ok: false, error: '写盘失败, 一张卡都没导入 (检查磁盘空间或目录权限)' };
  }
  return { ok: true, added, updated, incomplete, engines: config.engines };
});

/**
 * 画板右上角「测试」: 拿样例输入把当前这张卡真跑一遍。
 *
 * 跑的是**内存里的草稿**, 不要求先保存 —— 作者要的正是"改一版、试一版"。
 * 只读保护照旧生效 (走的是同一个 Database.query)。
 */
ipcMain.handle('engine:test', async (_e, { card, inputs, probe }) => {
  if (!card) return { ok: false, error: '没有可测试的卡' };
  try {
    const r = await Engine.testEngine(
      card,
      inputs || {},
      config.databases || [],
      (conf) => new Database(conf),
      // 探针跑: 给每条取数 SQL 套行数上限, 秒级确认链路 (结果截断, 不能当最终验证)
      { sampleRows: 20, probeRows: probe ? 200 : 0 }
    );
    return { ok: true, result: r };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

/**
 * 批量跑一张卡: 一张卡 + N 组输入。
 *
 * 以前只能一组输入跑一遍, 想查 3 张单就得手工跑 3 次 (每次重填单号, 结果自己
 * 抄到一起)。卡本身没有循环构造 (NODE_TYPES 只有 input/query/condition/output),
 * 而"帮我看看这 3 张单"是最常见的用法。
 *
 * 放在主进程而不是界面里循环调 engine:test 的原因:
 *   界面里循环是 N 次 IPC + N 套连接 (3 单 x 2 库 = 6 条)。这里整批共用一套
 *   连接, 而且并发可控 —— 界面循环做不到这两点。
 *
 * 可取消: 50 单批量可能跑很久, 没有取消通道的话用户只能等或者关窗口。
 */
const batchRuns = new Map();

ipcMain.handle('engine:testBatch', async (_e, { card, inputSets, concurrency, runId }) => {
  if (!card) return { ok: false, error: '没有可批量跑的卡' };
  const sets = (Array.isArray(inputSets) ? inputSets : []).filter((x) => x && typeof x === 'object');
  if (!sets.length) return { ok: false, error: '没有要跑的输入' };
  if (sets.length > 200) return { ok: false, error: `一次最多 200 组 (收到 ${sets.length} 组)。请分批跑。` };

  const id = runId || ('batch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6));
  const cancel = { v: false };
  batchRuns.set(id, cancel);
  const emit = (ev) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('engine:testBatchEvent', Object.assign({ runId: id }, ev));
    }
  };
  try {
    const r = await Engine.testEngineBatch(
      card,
      sets,
      config.databases || [],
      (conf) => new Database(conf),
      { sampleRows: 20, concurrency, cancel, onEvent: emit }
    );
    return Object.assign({ ok: true, runId: id }, r);
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), runId: id };
  } finally {
    batchRuns.delete(id);
  }
});

ipcMain.handle('engine:testBatchCancel', (_e, { runId }) => {
  const c = batchRuns.get(runId);
  if (!c) return { ok: false, error: '现在没有在跑的批量任务' };
  c.v = true;
  return { ok: true };
});

/* ==================== AI 搭建流程卡 ==================== */

/**
 * 正在跑的搭建: sessionId -> { v: boolean } 取消令牌。
 *
 * 为什么需要: 以前 `engine:aiSay` 里 `builder.send()` **完全接不了取消** ——
 * lib/engine-ai.js 从不给 toLoop 传 cancel, 所以它那条
 * `stopReason === 'cancelled'` 分支是死代码。界面上的「停止」按钮只停自测
 * (engine:aiStopSelfTest), 搭建一旦跑起来就只能干等它自己结束 —— 40 步
 * 加自动续跑之后可能是好几分钟, 没有逃生口是不能接受的。
 *
 * 令牌形状 `{ v }` 是 AgentLoop.isCancelled() 认的那个。
 */
const buildRuns = new Map();

/**
 * 活的会话表: chatId -> EngineAiBuilder。
 *
 * 键用 chatId 而不是随机 sessionId, 是为了让"一条对话"和"一个活会话"一一对应。
 * 用随机 id 的话, 同一个 chatId 每次打开都会新开一个空会话, 上一轮的对话史就断了 ——
 * 界面显示着历史, 模型却是从零开始, 会把你已经说过的话再问一遍。
 * 现在: 打开一条对话 → 有活会话就复用, 没有就按盘上的快照重建一个。
 */
const aiSessions = new Map();

/** 落盘一条对话: 界面的对话流水 + 模型的对话史 + 会话状态, 三样一起写 */
function persistAiChat(chatId, builder, log, extra) {
  if (!aiChatStore || !chatId) return;
  try {
    const snap = builder ? builder.snapshot() : null;
    aiChatStore.save(chatId, Object.assign({
      log: Array.isArray(log) ? log : undefined,
      messages: snap ? snap.messages : undefined,
      session: snap,
      pool: builder ? builder.pool : undefined,
      card: snap ? snap.card : undefined,
      finished: snap ? !!snap.finished : undefined,
      // 时间/token 总账。会话日志里没有它的话, 事后复盘一个"跑了很久还没搭完"
      // 的会话时, 连"模型慢还是数据库慢"都判断不了 (实测踩到过)。
      spent: snap ? snap.spent : undefined
    }, extra || {}));
  } catch (e) {
    // 存不下不该让对话中断 —— 顶多是这次记录丢了, 界面还在
    console.error('[ai-chat] 落盘失败:', e && e.message);
  }
}

/** 按盘上的快照重建一个会话 (首次打开历史对话时走这里) */
function reviveSession(chatId) {
  const rec = aiChatStore ? aiChatStore.get(chatId) : null;
  if (!rec) return null;
  const builder = new EngineAiBuilder({
    llm: currentLLM(),
    pool: rec.pool || {},
    card: (rec.session && rec.session.card) || rec.card || Engine.newEngine(),
    databases: config.databases || [],
    openDb: (conf) => new Database(conf),
    prompt: config.prompt || null
  });
  // rec.session 里已经带了 card, 会被 restore 一并接回去
  builder.restore(rec.session || { messages: rec.messages || [] });
  return builder;
}

ipcMain.handle('engine:aiOpen', (_e, { card, pool, chatId }) => {
  if (!llmReady()) return { ok: false, error: '还没配模型，去「设置 · 模型」页填 API Key' };

  // 有 chatId: 接着聊 (复用活会话, 或者按快照重建)
  if (chatId) {
    let builder = aiSessions.get(chatId);
    if (!builder) {
      builder = reviveSession(chatId);
      if (!builder) return { ok: false, error: '这条对话的记录找不到了' };
      aiSessions.set(chatId, builder);
    }
    if (pool) builder.pool = pool;
    const rec = aiChatStore ? aiChatStore.get(chatId) : null;
    return { ok: true, sessionId: chatId, chatId, log: (rec && rec.log) || [], resumed: true };
  }

  // 没带 chatId: 开一条新对话
  const chatIdNew = 'aich_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const builder = new EngineAiBuilder({
    llm: currentLLM(),
    pool: pool || {},
    card,
    databases: config.databases || [],
    openDb: (conf) => new Database(conf),
    prompt: config.prompt || null
  });
  aiSessions.set(chatIdNew, builder);
  if (aiChatStore) {
    aiChatStore.create({
      id: chatIdNew,
      cardId: (card && card.id) || null,
      title: (card && card.name) ? card.name + ' · 新对话' : '新对话'
    });
    // 把这张卡历史上读过的表结构接过来。
    //
    // 表结构是纯事实, 只要表没变就一直成立, 跟"在哪条对话里读到的"无关 ——
    // 但它原来只存在单条对话的 session 里, 于是同一张卡上开一条新对话, 模型
    // 就从头 describe_tables 一遍, 用户的感觉是"它怎么又忘了"。
    // 接过来只影响提示词里那几行列名, 没有副作用。
    const seen = aiChatStore.describedForCard((card && card.id) || null);
    if (seen.length) {
      builder.described = new Map(seen);
      console.log('[ai-chat] 从这张卡的历史对话接回了 ' + seen.length + ' 张表的结构');
    }
  }
  // 只留最近的几个, 免得攒着不放
  if (aiSessions.size > 8) {
    const oldest = aiSessions.keys().next().value;
    if (oldest !== chatIdNew) aiSessions.delete(oldest);
  }
  return { ok: true, sessionId: chatIdNew, chatId: chatIdNew, log: [], resumed: false };
});

ipcMain.handle('engine:aiSay', async (_e, { sessionId, text, pool, card, log }) => {
  const builder = aiSessions.get(sessionId);
  if (!builder) return { ok: false, error: '这次对话已经结束了，重新打开一下 AI 面板' };
  // 用户可能中途改了范围 (比如发现少勾了一张表)
  if (pool) builder.pool = pool;
  // 用户在画板上手改过卡的话, 以画板上的为准。
  //
  // 会话里攥着的是打开面板那一刻的草稿副本。用户在面板开着的时候手动改了 SQL、
  // 删了个节点, 这边毫无察觉; 下一轮 AI 一改, 回传的整张卡就把用户的手改盖掉了 ——
  // 表现就是"AI 一动手, 我刚才的改动就没了"。
  // 这里让画板覆盖会话草稿: 用户在界面上看到什么, AI 就接着改什么。
  const sync = builder.adoptCard(card);
  if (sync.changed) {
    const emit0 = (ev) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('engine:aiEvent', Object.assign({ sessionId }, ev));
      }
    };
    emit0({ type: 'ai_act', text: '发现画板上有新改动，已按画板上的最新版本继续' });
  }

  const emit = (ev) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('engine:aiEvent', Object.assign({ sessionId }, ev));
    }
  };

  // 建取消令牌挂上去, 界面的「停止」才能真的掐断在飞的模型请求。
  const cancel = { v: false };
  buildRuns.set(sessionId, cancel);

  let r;
  try {
    // 外部工具 (MCP) 挂到这次会话上 —— 搭建时经常要查内部系统才能知道字段含义。
    // 放在这里而不是 aiOpen: 连 MCP 要起子进程, 不该让"打开面板"这一步等它。
    builder.mcp = await getMCP();
    // 告诉界面"收尾之后主进程会自己跑一遍测试", 让它别再弹"请填测试单号"那个窗 ——
    // 自测会自己去库里找真实的单号 (EngineTester._inventInputs), 两个一起出现只会互相打脸。
    // 步数用尽那种收尾不算 (exhausted), 它不会触发自测, 弹窗照旧。
    const emitForSend = (ev) => emit(
      ev.type === 'ai_done' && !ev.exhausted
        ? Object.assign({}, ev, { autoSelfTest: true })
        : ev
    );
    const bcfg = normalizeBuilder(config.builder);
    r = await builder.send(text, emitForSend, {
      cancel,
      maxSteps: bcfg.maxSteps,
      maxRounds: bcfg.maxRounds
    });
  } catch (e) {
    buildRuns.delete(sessionId);
    return { ok: false, error: (e && e.message) || String(e) };
  }
  // 搭建这一段结束了, 令牌撤掉。
  // **必须在这里撤**, 不能拖到函数结尾: 下面跑的自测有它自己的一套取消
  // (selfTestRuns), 令牌不撤的话界面点「停止」会打到已经结束的搭建上,
  // 自测却停不下来 —— 用户看到的就是"点了停止没反应"。
  buildRuns.delete(sessionId);

  // 一轮对话结束 (不管是提问停住还是收尾), 都把最新状态落盘。
  // 提问停住也要存 —— 用户可能就关掉应用了, 下次回来得能接上那个问题。
  persistAiChat(sessionId, builder, log, { cardId: (card && card.id) || undefined });
  if (!r.ok) return r;

  // ---- 编排完自测 ----
  //
  // 搭建 Agent 收尾 (done) 之后, 自动把测试 Agent 拉起来独立跑一遍:
  // 它不共享搭建会话的上下文, 手里只有跑出来的事实, 所以能不带成见地查数据;
  // 不通就按诊断结果自动改, 最多来回几轮 (runTestLoop)。
  //
  // 以前这一步要用户自己去点「自动测试」。用户不该为了知道"它搭的对不对"
  // 而先学会另一个按钮。
  if (r.done) {
    await thisSelfTest(builder, sessionId, emit, log);
  }
  return { ok: true, ask: r.ask || '', choice: r.choice || null, card: builder.card, done: !!r.done };
});

/**
 * 停止正在跑的**搭建**。
 *
 * 和 engine:aiStopSelfTest 是两条路: 那个停自测, 这个停搭建。
 * 界面上是同一个「停止」按钮, 由 src/js/engines.js 按当前在跑什么来分流。
 *
 * 置标志之外还要 abort: AgentLoop 只在每一步之间检查取消标志, 光置标志得等
 * 当前那次模型调用自己返回 (最长 3 分钟) —— 界面上看着像没反应。
 */
/**
 * 取消在跑的搭建: 置取消标志 **并且** abort 在飞的请求。
 *
 * 两件事都要做。AgentLoop 只在每一步之间检查取消标志, 光置标志得等当前那次
 * 模型调用自己返回 (最长 3 分钟) —— 界面上看着像没反应。
 *
 * @returns 有没有找到在跑的搭建
 */
function cancelBuildRun(sessionId, why) {
  const c = buildRuns.get(sessionId);
  if (!c) return false;
  c.v = true;
  const b = aiSessions.get(sessionId);
  if (b && b.llm && typeof b.llm.abort === 'function') {
    try { b.llm.abort(why); } catch (e) { /* 没有在飞的请求也没关系 */ }
  }
  return true;
}

/**
 * 取消在跑的自测。做法与 cancelBuildRun 相同, 只是令牌形状不同 ——
 * 自测的令牌自带 abort (它掐的是 builder 的 llm)。
 */
function cancelSelfTestRun(sessionId) {
  const c = selfTestRuns.get(sessionId);
  if (!c) return false;
  c.v = true;
  try { c.abort(); } catch (e) { /* 没有在飞的请求也没关系 */ }
  return true;
}

ipcMain.handle('engine:aiCancel', (_e, { sessionId }) => {
  if (!cancelBuildRun(sessionId, '用户停止了搭建')) {
    return { ok: false, error: '现在没有在跑的搭建' };
  }
  return { ok: true };
});

/**
 * 停止正在跑的自测。
 *
 * 点了之后: 取消标志置上, 并把在飞的模型请求 abort 掉 —— 不然要等当前那次
 * 调用自己超时 (最长 3 分钟), 界面上看着像没反应。
 */
ipcMain.handle('engine:aiStopSelfTest', (_e, { sessionId }) => {
  if (!cancelSelfTestRun(sessionId)) {
    return { ok: false, error: '现在没有在跑的自测' };
  }
  return { ok: true };
});

/**
 * 搭建收尾之后的自测: 复用「测试 Agent ⇄ 开发 Agent」那个闭环。
 *
 * 注意用的是**同一个 LLMClient** —— 取消/超时能掐掉在飞的请求。
 * 闭环里那个开发 Agent 是新建的独立会话 (只带这张卡), 所以不会跟用户
 * 正在聊的这轮对话抢上下文; 改完的卡再 adopt 回来, 接着聊就是改过之后的版本。
 */
async function thisSelfTest(builder, sessionId, emit, log) {
  const cancelled = { v: false, abort: () => { try { builder.llm.abort('用户取消了自测'); } catch (e) {} } };
  // 记进表里, 让界面上的「停止自测」能按到它 —— 不然这个取消通道没有任何东西能触发
  const runId = sessionId;
  selfTestRuns.set(runId, cancelled);
  emit({ type: 'ai_act', text: '搭完了，先自己独立跑一遍看看对不对…' });

  // 闭环里两个 Agent 发的是 test_* / ai_* 两套事件, 而搭建面板只认 ai_*。
  // 不翻译的话用户看到"正在自测"之后就长时间没动静 —— 自测可能要跑好几分钟。
  const emitProgress = (ev) => {
    switch (ev.type) {
      // 开发 Agent 的事件面板本来就认, 原样转过去
      // ai_plan 也在里面: 自测阶段如果模型改了规划, 用户该看到新那一版
      case 'ai_act': case 'ai_say': case 'ai_ask': case 'ai_graph': case 'ai_done': case 'ai_plan':
        emit(ev);
        return;
      // 测试 Agent 的进度翻成对话里的一行
      case 'test_round':
        if (ev.message) emit({ type: 'ai_act', text: '· ' + ev.message });
        return;
      case 'test_phase':
        // run / inputs / diagnose 这几个阶段值得说, 其余太碎
        if (ev.message && ['inputs', 'run', 'diagnose'].includes(ev.phase)) {
          emit({ type: 'ai_act', text: '· ' + ev.message });
        }
        return;
      case 'test_say':
        if (ev.text) emit({ type: 'ai_act', text: '测试 Agent: ' + ev.text });
        return;
      case 'test_act':
        if (ev.text) emit({ type: 'ai_act', text: '· ' + ev.text });
        return;
      case 'test_run_done':
        if (ev.run && ev.run.ok === false && ev.run.error) {
          emit({ type: 'ai_act', text: '· 跑断了: ' + ev.run.error });
        }
        return;
      default:
        return;   // test_finish 之类由下面统一报结果, 不重复
    }
  };

  let r;
  try {
    r = await runTestLoop({
      card: builder.card,
      inputs: {},                       // 不给单号 —— 测试 Agent 会自己去库里找真实的
      pool: builder.pool,
      emit: emitProgress,
      cancelled,
      llm: builder.llm,
      llmConf: Models.activeModel(config.llm),
      databases: config.databases || [],
      openDb: (conf) => new Database(conf),
      mcp: builder.mcp || null,
      prompt: config.prompt || null
    });
  } catch (e) {
    selfTestRuns.delete(runId);
    emit({ type: 'ai_act', text: '自测没能跑完: ' + ((e && e.message) || e), err: true });
    return;
  }
  selfTestRuns.delete(runId);

  // 闭环改了卡就接回来 —— 用户接着说"再改改"时, 起点应该是修过的那一版
  const before = JSON.stringify(builder.card);
  if (r && r.card && JSON.stringify(r.card) !== before) {
    builder.adoptCard(r.card);
    emit({ type: 'ai_graph', card: builder.card });
  }
  persistAiChat(sessionId, builder, log, { cardId: builder.card && builder.card.id });

  if (r.verdict === 'pass') {
    emit({ type: 'ai_act', text: '自测跑通了 —— 这张卡能给出结论。' });
  } else if (r.verdict === 'limit') {
    emit({ type: 'ai_act', text: '自测没跑通，改到一半步数用尽了。画板上的卡有改动，但还没验证通过，请检查后再保存。', err: true });
  } else if (r.verdict === 'cancelled') {
    emit({ type: 'ai_act', text: '自测已停止。' });
  } else if (r.verdict === 'ask') {
    emit({ type: 'ai_act', text: '自测时发现有个地方需要你确认，先停在这里。' });
  } else {
    emit({ type: 'ai_act', text: '自测没跑通，也没能自己修好：' + (r.error || '原因不明') + ' —— 你可以接着说哪里不对。', err: true });
  }
}

/**
 * 关闭搭建面板。
 *
 * **必须真的把在跑的东西停掉**, 不能只把会话从表里删掉。
 *
 * 以前这里只有一句 `aiSessions.delete(sessionId)`, 而在跑的 `builder.send()`
 * 拿着自己的引用继续跑 —— 后果是: 切走之后 AI 在后台继续烧 token, 跑完还把
 * 结果写回对话记录, 用户完全不知道。界面上是"关了", 实际没关。
 *
 * 三个调用点都是"用户已经走开了", 所以取消是对的:
 *   - engAiDetach(): 换上下文 (切卡/切页)
 *   - engAiOpenChat(): 打开另一条对话
 *   - engAiEnsureSession(force): 强制开一条新会话
 * 三处都拿不到「停止」按钮, 所以这里不主动取消的话, 那个在跑的任务就再也
 * 没有东西能掐掉它了。
 *
 * 顺序要紧: 先 abort (需要 aiSessions 里的 builder), 再删会话。
 */
ipcMain.handle('engine:aiClose', (_e, { sessionId }) => {
  if (!sessionId) return { ok: true };
  const cancelledBuild = cancelBuildRun(sessionId, '面板已关闭, 搭建已取消');
  const cancelledSelfTest = cancelSelfTestRun(sessionId);
  aiSessions.delete(sessionId);
  return { ok: true, cancelledBuild, cancelledSelfTest };
});

/* ---- AI 对话的持久化读写 (历史列表 / 新建 / 重命名 / 删除) ---- */

/**
 * 某张卡的历史对话。
 *
 * 注意: **不传 cardId 会返回所有卡的对话** (aiChatStore.list 的语义)。
 * 界面两处调用点 (engAiRestoreForCard / engAiRefreshChats) 都自己守了 cardId,
 * 所以现在到不了这条路。但哪天有人漏传, 列表里就会出现别的卡的对话, 点进去
 * 还会把那张卡的草稿接进当前会话 —— 画板上是 B, 会话里是 A。
 * 真要加"全部对话"的入口, 请在这里显式开一个参数, 别靠漏传。
 */
ipcMain.handle('engine:aiChatList', (_e, { cardId }) => {
  if (!aiChatStore) return { ok: true, chats: [] };
  return { ok: true, chats: aiChatStore.list(cardId) };
});

ipcMain.handle('engine:aiChatGet', (_e, { id }) => {
  if (badId(id)) return { ok: false, error: '非法的对话 id' };
  if (!aiChatStore) return { ok: false, error: '存储未就绪' };
  const rec = aiChatStore.get(id);
  if (!rec) return { ok: false, error: '这条对话的记录找不到了' };
  return { ok: true, chat: rec };
});

ipcMain.handle('engine:aiChatRename', (_e, { id, title }) => {
  if (badId(id)) return { ok: false, error: '非法的对话 id' };
  if (!aiChatStore) return { ok: false, error: '存储未就绪' };
  const r = aiChatStore.rename(id, title);
  return r.ok ? { ok: true, chats: aiChatStore.list() } : r;
});

ipcMain.handle('engine:aiChatDelete', (_e, { id }) => {
  if (badId(id)) return { ok: false, error: '非法的对话 id' };
  if (!aiChatStore) return { ok: false, error: '存储未就绪' };
  aiSessions.delete(id);
  aiChatStore.remove(id);
  return { ok: true };
});

/** 界面主动存一次 (改完标题、点完保存这类) */
ipcMain.handle('engine:aiChatSave', (_e, { id, log, cardId, autoPrompted, pool }) => {
  if (badId(id)) return { ok: false, error: '非法的对话 id' };
  if (!aiChatStore) return { ok: false, error: '存储未就绪' };
  const builder = aiSessions.get(id);
  const snap = builder ? builder.snapshot() : null;
  const r = aiChatStore.save(id, {
    log,
    messages: snap ? snap.messages : undefined,
    session: snap,
    cardId,
    pool: builder ? builder.pool : pool,
    card: snap ? snap.card : undefined,
    autoPrompted,
    finished: snap ? !!snap.finished : undefined
  });
  return r.ok ? { ok: true } : r;
});


/* ==================== 自动测试: 测试 Agent ⇄ 开发 Agent 闭环 ==================== */

// 正在跑的测试任务, 支持取消。值是 { v, abort } —— v 是取消标志, abort 掐掉在飞请求。
const testRuns = new Map();

ipcMain.handle('engine:autoTest', async (_e, { card, inputs, pool, runId }) => {
  if (!card) return { ok: false, error: '没有可测试的卡' };
  if (!llmReady()) {
    return { ok: false, error: '还没配模型，去「设置 · 模型」页填 API Key' };
  }
  const id = runId || ('atr_' + Date.now());
  // 整个测试共用一个 LLMClient: 两个 Agent 共用它, 取消时 abort() 打的就是
  // "此刻正在飞的那一个请求"。光在轮次之间检查取消标志, 是停不掉一个正卡在
  // 60 秒请求上的循环的。
  const client = currentLLM();
  const cancelled = {
    v: false,
    abort: () => { try { client.abort('用户取消了自动测试'); } catch (e) { /* 没有在飞请求就算了 */ } }
  };
  testRuns.set(id, cancelled);
  /** 无条件发给界面 —— 只有"已停止"这一条必须绕过静音 */
  const send = (ev) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('engine:autoTestEvent', Object.assign({ runId: id }, ev));
    }
  };
  /** 取消之后不再推任何进度事件, 免得界面在停下之后还在刷新 */
  const emit = (ev) => {
    if (cancelled.v) return;
    send(ev);
  };
  try {
    emit({ type: 'test_start', card });
    const r = await runTestLoop({
      card,
      inputs,
      pool,
      emit,
      cancelled,
      llm: client,
      llmConf: Models.activeModel(config.llm),
      databases: config.databases || [],
      openDb: (conf) => new Database(conf),
      prompt: config.prompt || null
    });
    if (r && r.verdict === 'cancelled') {
      // 这条走 send 不走 emit —— 用 emit 的话它会被 cancelled.v 自己吞掉,
      // 界面永远收不到"已停止"(旧代码就是这么写的)。
      send({ type: 'test_cancelled' });
      return { ok: false, error: '已取消', runId: id };
    }
    emit({ type: 'test_finish', result: r });
    return Object.assign({ runId: id }, r);
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), runId: id };
  } finally {
    testRuns.delete(id);
  }
});

ipcMain.handle('engine:autoTestCancel', (_e, { runId }) => {
  const c = testRuns.get(runId);
  if (!c) return { ok: false, error: '这个测试已经结束了' };
  c.v = true;
  // 先把正在飞的那个请求掐掉, 循环下一轮开头才会看到 v 并退出
  if (typeof c.abort === 'function') c.abort();
  return { ok: true };
});

/** 只跑一次, 不诊断不改卡 —— 给界面上的快速试跑用 */
ipcMain.handle('engine:autoTestOnce', async (_e, { card, inputs }) => {
  if (!card) return { ok: false, error: '没有可测试的卡' };
  try {
    const r = await Engine.testEngine(card, inputs || {}, config.databases || [], (c) => new Database(c));
    return { ok: true, result: r };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});


/**
 * 同步: 把这条 SQL 真的跑一次, 拿回结果集有哪些列。
 *
 * 参数一律按「中性值」代入 —— 引号内给空串、引号外给 NULL。这样带 {{占位符}}
 * 的 SQL 变成合法语句, 通常查出 0 行, 但**列元数据照样拿得到** (这也是
 * lib/database.js 里要改成从驱动元数据读列名的原因)。
 * 目的是给作者填"输出列", 不是取数, 所以带上 LIMIT 也拦不住 —— 只读保护照旧生效。
 */
ipcMain.handle('engine:syncSql', async (_e, { dbId, dbConfig, sql }) => {
  const conf = dbConfig || (config.databases || []).find((d) => d.id === dbId);
  if (!conf) return { ok: false, error: '找不到这个数据库的连接信息' };
  const src = String(sql || '').trim();
  if (!src) return { ok: false, error: 'SQL 还是空的' };

  const params = {};
  for (const k of Engine.paramsOf(src)) params[k] = null;
  const bound = Engine.bindParams(src, params);
  if (bound.missing.length) return { ok: false, error: 'SQL 里还有没处理好的占位符: ' + bound.missing.join(', ') };

  const db = new Database(conf);
  try {
    const res = await db.query(bound.sql);
    return {
      ok: true,
      sql: bound.sql,
      columns: res.columns || [],
      rowCount: res.rowCount || 0,
      rows: (res.rows || []).slice(0, 3),
      elapsedMs: res.elapsedMs
    };
  } catch (e) {
    return { ok: false, error: e.message, sql: bound.sql };
  } finally {
    await db.close();
  }
});

/**
 * 让模型按「表结构 + 这张卡的用途」草拟一条固定 SQL。
 *
 * 只草拟, 不执行 —— 存不存、改不改由作者决定。占位符要它用 {{输入项名}},
 * 所以把这一环能用的输入名都念给它, 免得它自己编一个对不上的参数名。
 */
ipcMain.handle('engine:aiSql', async (_e, { dbId, dbConfig, table, engineName, description, examples, existingSql, fields, upstream }) => {
  const conf = dbConfig || (config.databases || []).find((d) => d.id === dbId);
  if (!conf) return { ok: false, error: '先选一个库, 我才能看表结构' };
  if (!table) return { ok: false, error: '先选一张表' };
  if (!llmReady()) return { ok: false, error: '还没配模型, 去设置页填 API Key' };

  let cols = [];
  const db = new Database(conf);
  try {
    cols = await db.describeTable(table);
  } catch (e) {
    return { ok: false, error: '读表结构失败: ' + e.message };
  } finally {
    // 必须在 finally 里关: describeTable 抛错时如果跳过 close, 这条连接就永久泄漏
    await db.close();
  }

  const fieldLines = cols.map((c) => `  - ${c.field}${c.type ? ' (' + c.type + ')' : ''}`).join('\n');
  const avail = []
    .concat((fields || []).map((f) => `${f.key}${f.label ? '（' + f.label + '）' : ''}`))
    .concat(upstream || []);
  const uniq = Array.from(new Set(avail)).filter(Boolean);

  const sys = [
    '你帮业务人员在"流程卡"里写一条固定 SQL。',
    '只输出一条只读 SELECT 语句本身。不要解释、不要 Markdown 代码块、不要分号结尾之外的内容。',
    '',
    '规则:',
    '1. 只查指定的这一张表, 不要 JOIN、不要子查询其它表。',
    '2. 需要按用户提供的信息筛选时, 用 {{名字}} 当占位符, 名字必须从下面"可以引用的输入"里挑。',
    '3. 想当字符串用时把占位符写在引号里: pay_no = \'{{payNo}}\'; 想原样代入（数字）就不加引号: id = {{id}}。',
    '4. 只选真正用得上的列, 不要 SELECT *。',
    '5. 可以带 ORDER BY / LIMIT 让结果稳定。'
  ].join('\n');

  const user = [
    `这张流程卡的用途: ${description || engineName || '(没写)'}`,
    (examples || []).length ? `用户可能这样问: ${examples.join(' / ')}` : '',
    `当前这一环要查的表: ${table}`,
    '这张表的字段:',
    fieldLines || '  (没读到字段清单)',
    uniq.length ? `可以引用的输入: ${uniq.join('、')}` : '可以引用的输入: (还没有, 那就不要用占位符)',
    existingSql ? `\n作者已经写了半条, 请在它基础上改好:\n${existingSql}` : ''
  ].filter(Boolean).join('\n');

  try {
    const llm = currentLLM();
    let out = await llm.chat(
      [{ role: 'system', content: sys }, { role: 'user', content: user }],
      { maxTokens: 900, temperature: 0.2 }
    );
    out = String(out || '').trim()
      .replace(/^```(?:sql)?/i, '').replace(/```$/, '')
      .trim();
    if (!out) return { ok: false, error: '模型没给出内容' };
    return { ok: true, sql: out, columns: cols };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/**
 * 正在跑的自测, 按会话 id 索引。
 *
 * 自测可能要跑好几分钟 (测试 Agent 找数据 + 真跑 + 诊断 + 改 + 再测),
 * 没有停止按钮的话用户只能干等或者关掉面板。这里存的就是那个停止开关。
 */
const selfTestRuns = new Map();

/**
 * 外部工具 (MCP): 全进程一份, 三个 Agent 共用。
 *
 * 以前是"每个分析任务跑起来就 new 一个 MCPManager 并重新连一遍" —— 既慢,
 * 又意味着搭建 Agent 和测试 Agent **永远看不到外部工具** (它们各自构造时
 * 根本拿不到这个对象)。工具该由主程序统一管, 不是每个 Agent 各连一份。
 *
 * 连接失败不抛: 工具是加分项, 没有它内置工具照常跑。
 */
let mcpManager = null;
let mcpConnectInfo = { tools: [], errors: [] };

async function getMCP() {
  // 关过的 manager 不能复用: agent:run 的 finally 每次都会 mcp.closeAll(),
  // 把所有子进程杀掉。以前这里只看 mcpManager 非空就返回, 于是从第二个任务起
  // 拿到的是一个 connections 已经空掉的 manager —— 工具还列在 tools 里 (schema
  // 照常下发给模型), 一调用就报"没有可处理 ... 的 MCP server"。
  if (mcpManager && mcpManager.connections && mcpManager.connections.length) return mcpManager;
  mcpManager = new MCPManager((config.mcp && config.mcp.servers) || []);
  try {
    mcpConnectInfo = await mcpManager.connectAll();
  } catch (e) {
    mcpConnectInfo = { tools: [], errors: [{ server: 'mcp', error: e.message }] };
  }
  return mcpManager;
}

// 斜杠指令清单 —— 界面的 / 自动补全菜单读它。**单一来源**: 和 Agent.run 的解析器
// 读的是同一份 (lib/agent.js 的 SLASH_COMMANDS), 界面不另抄一份。
ipcMain.handle('agent:commands', () => Agent.SLASH_COMMANDS || []);

// 正在跑的对话任务 (单飞, 靠 state.running 保证同一时刻只有一个): 只留一个取消令牌,
// 供 agent:cancel 按。形状 { v, abort } —— 和 AgentLoop.isCancelled() 认的一致。
let agentRunCancel = null;

// 人工终止正在跑的对话任务: 置取消标志 + 掐掉在飞的模型请求。
ipcMain.handle('agent:cancel', () => {
  if (!agentRunCancel) return { ok: false, error: '当前没有在跑的任务' };
  agentRunCancel.v = true;
  try { agentRunCancel.abort(); } catch (e) {}
  return { ok: true };
});

ipcMain.handle('agent:run', async (_e, payload) => {
  const { task, conversationId, history, state: priorState, pickEngineId, tableMode, dbIds, kbIds } = payload;

  // 对话长度兜底。界面那一侧也挡了 (src/js/app.js 的 sendTask), 但界面能被绕过
  // —— 光靠它不算数。两边读的是同一份常量 (lib/conversation.js), 所以不会出现
  // "界面显示还能发、发出来却被拒"这种对不上的情况。
  const turns = turnCount(history);
  if (turns >= CONV_MAX_TURNS) {
    return { ok: false, error: `这段对话已到 ${CONV_MAX_TURNS} 轮上限, 请新建会话继续` };
  }

  // 人工终止: 建取消令牌挂到模块上, 界面的「停止」(agent:cancel) 能按到它。
  // abort 要等 llm 建好再补上 (见下面 currentLLM 之后)。
  const cancel = { v: false, abort: () => {} };
  agentRunCancel = cancel;

  // 不再有"当前数据库"这个概念: 通用问句的库由**表名**反推 (见 lib/db-router.js)。
  // 所有库里勾过的表合成一份白名单, 勾选这个动作同时决定了"能访问什么"和"去哪取"。
  //
  // dbIds 是对话抬头里选的那几个库 (空 = 不限制)。它只往下传给路由器,
  // **不碰 config.databases**, 所以流程卡拿到的仍然是全量配置, 不受这里影响。
  const router = new DbRouter({
    databases: config.databases || [],
    openDb: (conf) => new Database(conf),
    dbIds
  });

  const llm = currentLLM();
  // 有了 llm 才能掐在飞的模型请求。取消只在"步与步之间"生效 —— 卡在一条慢 SQL 上时
  // 要等它回来才停 (驱动层没有 cancel)。
  cancel.abort = () => { try { llm.abort('用户停止了任务'); } catch (e) {} };
  const skills = new Skills({
    skillsDir: path.join(app.getPath('userData'), 'skills'),
    enabled: config.skills?.enabled || []
  });
  await skills.load();

  // 外部工具 (MCP): 起得来就并进工具表, 起不来就记一笔继续跑 —— 工具是加分项
  const mcp = await getMCP();
  const mcpInfo = mcpConnectInfo;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('agent:event', {
      conversationId,
      type: 'mcp',
      tools: mcpInfo.tools.map((t) => t.function && t.function.name).filter(Boolean),
      errors: mcpInfo.errors
    });
  }

  const agent = new Agent({
    llm,
    // 通用问句走路由器: 同一个对象既能报"有哪些表", 也能按表名把 SQL 发到正确的库
    database: router,
    skills,
    mcp,
    prompt: config.prompt || null,
    general: config.general || null,
    engines: config.engines || [],
    databases: config.databases || [],
    openDb: (conf) => new Database(conf),
    // 知识库服务: 有它, search_knowledge 工具才暴露给模型
    knowledge
  });

  const askCheckpoint = (cp) => {
    const id = 'cp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:checkpoint', { id, conversationId, ...cp });
    }
    return new Promise((resolve) => {
      pendingCheckpoints.set(id, resolve);
      // 10 分钟超时, 防止 UI 永远不响应把任务卡死
      setTimeout(() => {
        if (pendingCheckpoints.has(id)) {
          pendingCheckpoints.delete(id);
          resolve({ cancelled: true, timeout: true });
        }
      }, 10 * 60 * 1000);
    });
  };

  try {
    const result = await agent.run(
      task,
      { history: history || [], state: priorState || null, pickEngineId: pickEngineId || null,
        // 自动模式: AI 自己选库选表, 不再弹窗问用户。见 lib/agent.js 里 autoTables 的说明。
        autoTables: tableMode === 'auto',
        // 对话页选中的知识库 (可多选; 空 = 用配置里的默认库)。
        kbIds: Array.isArray(kbIds) ? kbIds.filter(Boolean) : [],
        // 人工终止令牌 —— Agent 把它传给工具循环 (每轮检查) 和 _classifyIntent 前后的卡点
        cancel },
      (event) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('agent:event', { conversationId, ...event });
        }
      },
      askCheckpoint
    );

    // 任务跑完就把产物归档到数据空间, 免得用户忘了导出就再也找不回来
    let artifacts = [];
    try {
      artifacts = persistArtifacts(conversationId, result, router.scopeLabel());
    } catch (e) {
      console.error('Failed to persist artifacts:', e);
    }

    // 问答飞轮: 只有**用了 RAG 的问答**才记一条。这样列表里全是"知识库参与过"的问答,
    // 反馈才有意义 —— 没用知识库的问答, 点踩也怪不到知识库头上。
    let qaId = null;
    try {
      // 记录**每一次**问答 —— 不再只记"用了知识库的"。
      // 以前只在 result.ragHits 非空时才记, 于是"问了一句、AI 没检索"就查不到记录,
      // 用户会疑惑"我刚问答了, 问答管理里怎么是空的"。ragHits 为空是正常情况。
      const answer = (result && (result.summary || result.title)) || '';
      if (qaStore && task && answer) {
        const steps = Array.isArray(result.steps) ? result.steps : [];
        const rec = qaStore.record({
          kbId: (Array.isArray(kbIds) && kbIds[0]) || (config.knowledge && config.knowledge.defaultKbId) || null,
          kbName: (result.ragHits && result.ragHits[0] && result.ragHits[0].kbName) || '',
          conversationId,
          question: task,
          answer,
          // 推理过程: 把每一步的标题串起来 (问答管理里"思维推理"那一栏)
          reasoning: steps.map((s) => s.title || s.kind || '').filter(Boolean).join(' → ').slice(0, 2000),
          // 结构化步骤 — 供"查看"里画执行流程图
          steps: steps.map((s) => ({ kind: s.kind || '', title: s.title || s.message || '' })).slice(0, 60),
          // 决策轨迹 (闸门怎么判的、为什么查知识库、命中了什么) —— 详情里可视化的就是它
          trace: Array.isArray(result.trace) ? result.trace.slice(0, 80) : [],
          ragHits: (result.ragHits || []).map((h) => ({
            docId: h.docId, docName: h.docName, chunkId: h.chunkId,
            section: h.section || '', score: h.score
          })),
          model: (Models.activeModel(config.llm) || {}).model || '',
          latencyMs: (result.usage && result.elapsedMs) || 0,
          usage: result.usage || null
        });
        if (rec && rec.ok) qaId = rec.record.id;
      }
    } catch (e) {
      console.error('Failed to record QA flywheel entry:', e);
    }

    return { ok: true, result: Object.assign({}, result, { qaId }), artifacts };
  } catch (e) {
    // 用户点了「停止」—— 不是故障, 单独标出来让界面显示"已停止"
    if (cancel.v) return { ok: false, cancelled: true, error: '已停止' };
    return { ok: false, error: e.message };
  } finally {
    if (agentRunCancel === cancel) agentRunCancel = null;
    // 路由器可能开了好几个连接 (跨库任务), 统一收
    await router.close();
    mcp.closeAll();
  }
});

/**
 * 把本次任务的结果落盘到该对话的工作区。
 * - 每条成功的 SQL 结果存一份 CSV (原始数据)
 * - 用户选了 html / excel 时, 对应的报告文件也存一份
 * 返回产物记录列表, 供界面立即刷新数据空间。
 */
function persistArtifacts(conversationId, result, databaseName) {
  if (!store || !conversationId || !result) return [];
  const saved = [];

  const sqlSteps = (result.steps || []).filter((s) => s.kind === 'sql' && s.result && !s.result.error && s.result.columns?.length);
  sqlSteps.forEach((s, i) => {
    const label = String(s.title || `查询${i + 1}`);
    const built = Report.buildCSV(s.result);
    if (!built.csv) return;
    const r = store.saveArtifact(conversationId, {
      kind: 'data',
      name: `${String(i + 1).padStart(2, '0')}-${safeName(label)}`,
      sub: 'data',
      ext: 'csv',
      content: built.csv,
      meta: {
        title: label,
        sql: s.sql || '',
        rowCount: s.result.rowCount,
        // 这次到底导出了多少行 / 一共多少行 / 有没有被防呆网截过。
        // 预览层要靠这几个数字决定"能不能预览、下载的是什么",
        // 界面上也要如实标注 —— 用户点下载就是为了看全量, 不能让他以为
        // 拿到的是全部却其实被截过。
        exportedRows: built.rows,
        totalRows: built.totalRows,
        truncated: built.truncated,
        // 原始列名 (按位对应 CSV 的中文表头) + 原始名→中文名映射,
        // 供产物表格显示中文表头并把原名放到悬浮提示里
        columns: s.result.columns || [],
        labels: s.result.labels || null,
        purpose: s.purpose || '',
        why: s.why || ''
      }
    });
    if (r.ok) saved.push(r.artifact);
  });

  const baseName = safeName(result.title || '报告');
  if (result.output === 'html' && result.html) {
    const r = store.saveArtifact(conversationId, {
      kind: 'report',
      name: baseName,
      ext: 'html',
      content: result.html,
      meta: { title: result.title || '报告', databaseName }
    });
    if (r.ok) saved.push(r.artifact);
  }
  if (result.output === 'excel' && result.xlsxBase64) {
    const r = store.saveArtifact(conversationId, {
      kind: 'excel',
      name: baseName,
      ext: 'xlsx',
      content: Buffer.from(result.xlsxBase64, 'base64'),
      meta: { title: result.title || 'Excel', databaseName }
    });
    if (r.ok) saved.push(r.artifact);
  }
  return saved;
}

function safeName(s) {
  return Store.safeFileName(s || '未命名', 40) || '未命名';
}

/**
 * IPC 边界的 id 校验。
 *
 * 这些 id 会直接参与拼落盘路径 (conversations/<id>.json 等), 不校验的话
 * `../config` 这种值能跳出目录 —— 而 deleteConversation 会 unlink 掉它,
 * 那正好是存着全部数据库口令与 API Key 的 config.json。
 * store 内部也有白名单兜底, 这里再挡一道是为了让非法输入**显式报错**,
 * 而不是被 getConversation 里那个 catch 吞掉、看起来像"文件不存在"。
 */
function badId(id) {
  return !isSafeId(id);
}

// ==================== 对话历史 ====================

ipcMain.handle('conv:list', () => (store ? store.listConversations() : []));

ipcMain.handle('conv:get', (_e, id) => {
  if (badId(id)) return null;
  return store ? store.getConversation(id) : null;
});

/**
 * 新建对话: 让模型起一个短标题 (失败就用任务前几个字兜底), 同时建好工作区目录。
 * 标题同时决定目录名, 所以要在产物落盘之前定下来。
 */
// 点「＋」时先落的那条占位记录用的名字。第一轮任务发出后由 conv:title 换成 AI 标题。
const NEW_CHAT_TITLE = '新对话';

ipcMain.handle('conv:create', async (_e, { task, databaseId, databaseName, dbIds, placeholder }) => {
  if (!store) return { ok: false, error: '存储未初始化' };
  const dbName = databaseName || config.databases.find((d) => d.id === databaseId)?.name || '';
  // placeholder: 点「＋」立刻落一条「新对话」, 这里**不起标题** —— 不起就不花模型钱,
  // 也不会因为 task 为空把标题退化成"未命名分析"。真实标题等第一轮发出去了再补, 见 conv:title。
  const title = placeholder ? NEW_CHAT_TITLE : await generateTitle(task);
  const conv = store.createConversation({
    id: 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    title,
    databaseId: databaseId || null,
    databaseName: dbName,
    dbIds
  });
  return { ok: true, conversation: conv };
});

// 第一轮任务发出后, 把占位「新对话」补成 AI 标题, 并把这次的分析范围 (库) 记进对话。
// 范围原本是在 conv:create 那一刻记的, 现在 create 提前到了点「＋」的时候 —— 那时用户
// 还没选库, 所以范围挪到这里补写。
ipcMain.handle('conv:title', async (_e, { id, task, dbIds, databaseName }) => {
  if (badId(id)) return { ok: false, error: '非法的对话 id' };
  if (!store) return { ok: false, error: '存储未初始化' };
  const title = await generateTitle(task);
  const r = store.applyTitle(id, title, { dbIds, databaseName });
  return r && r.ok
    ? { ok: true, title, conversation: r.conversation }
    : { ok: false, error: (r && r.error) || '更新失败' };
});

ipcMain.handle('conv:saveMessages', (_e, { id, messages, agentState, stats }) => {
  if (badId(id)) return { ok: false, error: '非法的对话 id' };
  return store ? store.saveMessages(id, messages, agentState, stats) : { ok: false, error: '存储未初始化' };
});

ipcMain.handle('conv:rename', (_e, { id, title }) => {
  if (badId(id)) return { ok: false, error: '非法的对话 id' };
  return store ? store.renameConversation(id, title) : { ok: false, error: '存储未初始化' };
});

ipcMain.handle('conv:delete', (_e, id) => {
  if (badId(id)) return { ok: false, error: '非法的对话 id' };
  return store ? store.deleteConversation(id) : { ok: false, error: '存储未初始化' };
});

// ==================== 知识库 / RAG ====================

/** 导入进度事件 (逐文档推给界面, 导入可能几十秒) */
function kbEmit(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('knowledge:importEvent', payload);
}

ipcMain.handle('knowledge:listKbs', () => (knowledgeStore ? knowledgeStore.listKbs() : []));

ipcMain.handle('knowledge:getKb', (_e, id) => (knowledgeStore ? knowledgeStore.getKb(id) : null));

ipcMain.handle('knowledge:createKb', (_e, { name, desc }) => {
  if (!knowledgeStore) return { ok: false, error: '存储未初始化' };
  try {
    // 向量模型与分块策略统一来自「配置 · 知识库」, 这里只把当前配置存一份快照 (仅展示用)。
    const cfg = knowledge.config();
    const kb = knowledgeStore.createKb({ name, desc, embedding: cfg.embedding, chunkConfig: cfg.chunkConfig });
    return { ok: true, kb, kbs: knowledgeStore.listKbs() };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('knowledge:updateKb', (_e, { id, patch }) => {
  if (!knowledgeStore) return { ok: false, error: '存储未初始化' };
  try { return knowledgeStore.updateKb(id, patch || {}); }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('knowledge:deleteKb', (_e, id) => {
  if (!knowledgeStore) return { ok: false, error: '存储未初始化' };
  try { return knowledgeStore.deleteKb(id); }
  catch (e) { return { ok: false, error: e.message }; }
});

// ---- 文件夹 (知识库内) ----
ipcMain.handle('knowledge:createFolder', (_e, { kbId, name }) => {
  try { return knowledgeStore.createFolder(kbId, { name }); } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('knowledge:renameFolder', (_e, { kbId, folderId, name }) => {
  try { return knowledgeStore.renameFolder(kbId, folderId, name); } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('knowledge:deleteFolder', (_e, { kbId, folderId }) => {
  try { return knowledgeStore.deleteFolder(kbId, folderId); } catch (e) { return { ok: false, error: e.message }; }
});

// ---- 文档 ----
ipcMain.handle('knowledge:listDocs', (_e, { kbId, folderId }) => {
  try { return knowledgeStore.listDocs(kbId, folderId); } catch (e) { return []; }
});

/** 文档详情: 导入时的参数快照 + 前 20 个分块预览 (详情弹窗用) */
ipcMain.handle('knowledge:docDetail', (_e, { kbId, docId }) => {
  if (!knowledgeStore) return { ok: false, error: '存储未初始化' };
  const doc = knowledgeStore.getDoc(kbId, docId);
  if (!doc) return { ok: false, error: '文档不存在' };
  const chunks = knowledgeStore.readChunks(kbId, docId);
  return {
    ok: true, doc, chunkTotal: chunks.length,
    chunks: chunks.slice(0, 20).map((c) => ({
      id: c.id, ord: c.ord, section: c.section || '', chars: c.chars || 0,
      text: String(c.text || '').slice(0, 600)
    }))
  };
});

ipcMain.handle('knowledge:deleteDoc', (_e, { kbId, docId }) => {
  try { return knowledgeStore.deleteDoc(kbId, docId); } catch (e) { return { ok: false, error: e.message }; }
});

/** 选文件 (单个/批量)。pdf 也允许选 —— 导入时会明确提示"请改用粘贴文本"。 */
ipcMain.handle('knowledge:pickFiles', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '选择要导入的文档',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '文档', extensions: ['md', 'txt', 'docx', 'pdf'] },
      { name: '全部文件', extensions: ['*'] }
    ]
  });
  if (r.canceled) return { ok: false };
  return { ok: true, paths: r.filePaths };
});

/**
 * 导入 (单个或批量)。items: [{ type, path?, name?, content? }]
 * type ∈ md|txt|docx|pdf|richtext|qa。文件走 path, 富文本/问答对走 content。
 */
ipcMain.handle('knowledge:import', async (_e, { kbId, folderId, items }) => {
  if (!knowledge) return { ok: false, error: '知识库未初始化' };
  const kb = knowledgeStore.getKb(kbId);
  if (!kb) return { ok: false, error: '知识库不存在' };
  const list = Array.isArray(items) ? items : [];
  const results = [];
  for (const it of list) {
    const type = String(it.type || 'txt').toLowerCase();
    const name = it.name || (it.path ? path.basename(it.path) : (type === 'qa' ? '问答对' : '富文本'));
    let content = it.content;
    if (it.path) {
      try { content = fs.readFileSync(it.path); }
      catch (e) { results.push({ ok: false, name, error: '读文件失败: ' + e.message }); continue; }
    }
    const created = knowledgeStore.createDoc(kbId, { name, type, folderId: folderId || null, status: 'pending' });
    if (!created.ok) { results.push({ ok: false, name, error: created.error }); continue; }
    const docId = created.doc.id;
    // 留一份来源: 失败后 (比如当时还没配向量模型) 才能"重新处理", 不用把文件再传一遍。
    // 文件类记路径 (重跑时重读), 富文本/问答对记正文。
    try {
      if (it.path) knowledgeStore.writeSource(kbId, docId, { type, name, path: it.path });
      else knowledgeStore.writeSource(kbId, docId, { type, name, content: typeof content === 'string' ? content : '' });
    } catch (e) { /* 留档失败不该拦住本次导入 */ }
    kbEmit({ kind: 'start', docId, name });
    const r = await knowledge.ingest({
      kbId, docId, type, content,
      onProgress: (p) => kbEmit(Object.assign({ kind: 'progress', docId, name }, p))
    });
    kbEmit({ kind: 'done', docId, name, ok: !!r.ok, error: r.error || '', chunkCount: r.chunkCount || 0 });
    results.push({ ok: !!r.ok, docId, name, type, error: r.error, chunkCount: r.chunkCount || 0 });
  }
  return { ok: true, results, docs: knowledgeStore.listDocs(kbId) };
});

/**
 * 重新处理一个文档: 用**留下来的来源**重跑导入 (解析→分块→向量化)。
 * 用途: ① 导入时没配向量模型 → 配好后重跑; ② 改了分块策略 → 重建。
 * 文件类重读原路径; 富文本/问答对用存下来的正文。
 */
ipcMain.handle('knowledge:reingest', async (_e, { kbId, docId }) => {
  if (!knowledge) return { ok: false, error: '知识库未初始化' };
  const doc = knowledgeStore.getDoc(kbId, docId);
  if (!doc) return { ok: false, error: '文档不存在' };
  const src = knowledgeStore.readSource(kbId, docId);
  if (!src) return { ok: false, error: '这条没有留下来源, 无法重新处理, 请重新新建。' };
  let content = src.content;
  if (src.path) {
    try { content = fs.readFileSync(src.path); }
    catch (e) { return { ok: false, error: '原始文件读不到了 (' + e.message + '), 请重新新建。' }; }
  }
  if (content == null) return { ok: false, error: '来源内容为空, 请重新新建。' };
  kbEmit({ kind: 'start', docId, name: doc.name });
  const r = await knowledge.ingest({
    kbId, docId, type: src.type || doc.type, content,
    onProgress: (p) => kbEmit(Object.assign({ kind: 'progress', docId, name: doc.name }, p))
  });
  kbEmit({ kind: 'done', docId, name: doc.name, ok: !!r.ok, error: r.error || '', chunkCount: r.chunkCount || 0 });
  return { ok: !!r.ok, error: r.error, chunkCount: r.chunkCount || 0, docs: knowledgeStore.listDocs(kbId) };
});

/** 检索自测 (配置页 / 知识库页的"测试检索") */
ipcMain.handle('knowledge:search', async (_e, { kbId, query, topK }) => {
  if (!knowledge) return { ok: false, error: '知识库未初始化' };
  try { return await knowledge.search({ kbId, query, llm: currentLLM(), topK }); }
  catch (e) { return { ok: false, error: e.message }; }
});

// ---- 知识库配置 ----
ipcMain.handle('knowledge:configGet', () => ({
  config: config.knowledge || {},
  presets: require('./lib/knowledge/embed').PRESETS,
  defaultKbId: (config.knowledge && config.knowledge.defaultKbId) || null
}));

ipcMain.handle('knowledge:configSave', (_e, patch) => {
  const cur = config.knowledge || {};
  const next = Object.assign({ embedding: {}, chunkConfig: {}, retrieval: {}, defaultKbId: null }, cur);
  if (patch && patch.embedding) next.embedding = Object.assign({}, next.embedding, patch.embedding);
  if (patch && patch.chunkConfig) next.chunkConfig = Object.assign({}, next.chunkConfig, patch.chunkConfig);
  if (patch && patch.retrieval) next.retrieval = Object.assign({}, next.retrieval, patch.retrieval);
  if (patch && 'defaultKbId' in patch) next.defaultKbId = patch.defaultKbId || null;
  config.knowledge = next;
  saveConfig();
  return { ok: true, config: next };
});

// ---- 问答飞轮 ----
ipcMain.handle('qa:list', (_e, filter) => (qaStore ? qaStore.list(filter || {}) : { total: 0, rows: [] }));
ipcMain.handle('qa:tags', () => FEEDBACK_TAGS);

ipcMain.handle('qa:feedback', (_e, { id, verdict, tags, text }) => {
  if (!qaStore) return { ok: false, error: '存储未初始化' };
  try { return qaStore.setFeedback(id, { verdict, tags, text }); }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('qa:export', async (_e, { format, filter }) => {
  if (!qaStore) return { ok: false, error: '存储未初始化' };
  const content = qaStore.export(format || 'jsonl', filter || {});
  const ext = format === 'csv' ? 'csv' : 'jsonl';
  const r = await dialog.showSaveDialog(mainWindow, {
    title: '导出问答记录',
    defaultPath: `askaha-qa.${ext}`,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
  });
  if (r.canceled || !r.filePath) return { ok: false };
  fs.writeFileSync(r.filePath, content, 'utf-8');
  return { ok: true, filePath: r.filePath };
});

/** AI 分析: 把筛选出的问答摘要交给模型, 产出"该怎么改进知识库/回答" */
ipcMain.handle('qa:analyze', async (_e, filter) => {
  if (!qaStore) return { ok: false, error: '存储未初始化' };
  if (!llmReady()) return { ok: false, error: '还没配模型, 去「设置 · 模型」页填 API Key' };
  const { rows } = qaStore.list(Object.assign({ limit: 200 }, filter || {}));
  if (!rows.length) return { ok: false, error: '没有符合条件的问答记录' };
  const up = rows.filter((r) => r.feedback === 'up').length;
  const down = rows.filter((r) => r.feedback === 'down').length;
  const digest = rows.slice(0, 120).map((r, i) =>
    `#${i + 1} [${r.feedback || '无反馈'}] 问: ${String(r.question || '').slice(0, 120)} | 答: ${String(r.answer || '').slice(0, 160)}${r.feedbackText ? ' | 点踩原因: ' + r.feedbackText : ''}`
  ).join('\n');
  const prompt = [
    '你在分析一个知识库问答系统的用户反馈, 目标是找出"知识库 / 回答该改进什么"。',
    `样本: 共 ${rows.length} 条, 其中 👍 ${up} 条, 👎 ${down} 条。`,
    '',
    digest,
    '',
    '请输出 4 部分 (markdown):',
    '1) 用户不满意的主要类型 (归纳 2-4 类);',
    '2) 每一类举 1-2 个具体例子 (引用原问题);',
    '3) 知识库该补什么文档 / 检索该怎么改 (要可执行);',
    '4) 一句话总体结论。'
  ].join('\n');
  try {
    const text = await currentLLM().chat([{ role: 'user', content: prompt }], { maxTokens: 2000, temperature: 0.3 });
    return { ok: true, analysis: text, stats: { total: rows.length, up, down } };
  } catch (e) { return { ok: false, error: e.message }; }
});

async function generateTitle(task) {
  const fallback = String(task || '').replace(/\s+/g, ' ').trim().slice(0, 18) || '未命名分析';
  if (!llmReady()) return fallback;
  try {
    const llm = currentLLM();
    const raw = await llm.chat(
      [
        { role: 'system', content: '你给数据库分析任务起标题。只输出标题本身, 8-16 个汉字, 概括分析对象与意图, 不要标点、不要引号、不要解释。' },
        { role: 'user', content: String(task || '').slice(0, 500) }
      ],
      { maxTokens: 60, temperature: 0.3 }
    );
    const t = String(raw || '')
      .replace(/[\r\n]+/g, ' ')
      .replace(/["'“”‘’《》【】。，,、：:；;！!？?]/g, '')
      .replace(/\s+/g, '')
      .trim();
    return t.slice(0, 24) || fallback;
  } catch (e) {
    // 起名失败不该挡住主流程
    return fallback;
  }
}

// ==================== 数据空间 ====================

ipcMain.handle('space:list', () => (store ? store.listDataSpace() : []));

ipcMain.handle('artifact:list', (_e, conversationId) => {
  if (badId(conversationId)) return { ok: false, error: '非法的对话 id' };
  return store ? store.listArtifacts(conversationId) : { ok: false, error: '存储未初始化' };
});

ipcMain.handle('artifact:read', (_e, { conversationId, artifactId }) => {
  if (badId(conversationId)) return { ok: false, error: '非法的对话 id' };
  return store ? store.readArtifact(conversationId, artifactId) : { ok: false, error: '存储未初始化' };
});

ipcMain.handle('artifact:delete', (_e, { conversationId, artifactId }) => {
  if (badId(conversationId)) return { ok: false, error: '非法的对话 id' };
  return store ? store.deleteArtifact(conversationId, artifactId) : { ok: false, error: '存储未初始化' };
});

/** 在系统文件管理器里定位产物, 方便用户直接拷走 */
ipcMain.handle('artifact:reveal', (_e, { conversationId, artifactId }) => {
  if (badId(conversationId)) return { ok: false, error: '非法的对话 id' };
  const r = store ? store.resolveArtifactPath(conversationId, artifactId) : null;
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || '产物不存在' };
  shell.showItemInFolder(r.absolute);
  return { ok: true };
});

/**
 * 把产物另存到用户选的位置。
 *
 * 和 artifact:reveal 的区别: 那个只是"在文件管理器里定位", 产物还躺在
 * 对话的工作区里; 这个是**真的拷一份出去**, 用户可以放到自己的目录、
 * 发给别人、用 Excel 打开。
 *
 * 数据太大的产物不再预览, 就是走这条路 —— 所以它是"看大数据"的唯一出口,
 * 必须存在。用 copyFile 而不是读进内存再写: 几百 MB 的文件也不该
 * 经过主进程的堆。
 */
ipcMain.handle('artifact:saveAs', async (_e, { conversationId, artifactId }) => {
  if (badId(conversationId)) return { ok: false, error: '非法的对话 id' };
  const r = store ? store.resolveArtifactPath(conversationId, artifactId) : null;
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || '产物不存在' };

  const ext = (String(r.artifact.name).match(/\.([a-z0-9]+)$/i) || [])[1] || '';
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '保存到…',
    defaultPath: r.artifact.name,
    filters: ext
      ? [{ name: ext.toUpperCase(), extensions: [ext] }, { name: '所有文件', extensions: ['*'] }]
      : [{ name: '所有文件', extensions: ['*'] }]
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };

  try {
    fs.copyFileSync(r.absolute, result.filePath);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: true, filePath: result.filePath };
});

ipcMain.handle('skills:list', async () => {
  const skills = new Skills({
    skillsDir: path.join(app.getPath('userData'), 'skills'),
    enabled: config.skills?.enabled || []
  });
  await skills.load();
  return skills.list();
});

/**
 * 「配置 > 内部工具」的清单。
 *
 * 完全只读, 且**不缓存** —— 清单直接从三个 Agent 的真实 schema 现取
 * (见 lib/tool-catalog.js 的注释: 界面绝不另存一份, 免得改了工具忘了改页面)。
 * 36 个工具的一次聚合是纯内存操作, 不值得缓存, 缓存反而会带来"改了代码要重启两次"
 * 的困惑。
 */
ipcMain.handle('tools:catalog', () => buildCatalog());

ipcMain.handle('skills:importDir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '导入技能文件夹',
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths.length) return { ok: false };

  const targetDir = path.join(app.getPath('userData'), 'skills');
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  const sourceDir = result.filePaths[0];
  const baseName = path.basename(sourceDir);
  const destDir = path.join(targetDir, baseName);
  if (fs.existsSync(destDir)) {
    return { ok: false, error: '同名技能已存在' };
  }
  // 必须包含 SKILL.md 或 skill.json
  const hasManifest =
    fs.existsSync(path.join(sourceDir, 'SKILL.md')) ||
    fs.existsSync(path.join(sourceDir, 'skill.json'));
  if (!hasManifest) {
    return { ok: false, error: '所选文件夹中未找到 SKILL.md 或 skill.json' };
  }
  fs.cpSync(sourceDir, destDir, { recursive: true });

  const skills = new Skills({ skillsDir: targetDir, enabled: config.skills?.enabled || [] });
  await skills.load();
  return { ok: true, skills: skills.list() };
});

ipcMain.handle('skills:importFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '导入 Markdown 技能',
    properties: ['openFile'],
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  });
  if (result.canceled || !result.filePaths.length) return { ok: false };

  const targetDir = path.join(app.getPath('userData'), 'skills');
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  const sourceFile = result.filePaths[0];
  const baseName = path.basename(sourceFile);
  const destFile = path.join(targetDir, baseName);
  if (fs.existsSync(destFile)) {
    return { ok: false, error: '同名技能已存在' };
  }
  fs.copyFileSync(sourceFile, destFile);

  const skills = new Skills({ skillsDir: targetDir, enabled: config.skills?.enabled || [] });
  await skills.load();
  return { ok: true, skills: skills.list() };
});

// ==================== 外部工具 (MCP) ====================

/** 把用户输入的 "npx -y @scope/pkg --flag" 拆成 command + args (支持引号) */
function splitCommandLine(line) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(line || '')))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** 从用户的输入里补全成一条 server 配置 */
function normalizeServerInput(input) {
  const raw = input || {};
  const line = String(raw.commandLine || '').trim();
  let command = String(raw.command || '').trim();
  let args = Array.isArray(raw.args) ? raw.args.map(String) : [];
  if (line) {
    const parts = splitCommandLine(line);
    command = parts[0] || command;
    args = parts.slice(1);
  }
  return {
    name: String(raw.name || '').trim() || command || 'MCP Server',
    command,
    args,
    env: raw.env && typeof raw.env === 'object' ? raw.env : {},
    enabled: raw.enabled !== false
  };
}

ipcMain.handle('mcp:list', () => ({ ok: true, servers: config.mcp?.servers || [] }));

ipcMain.handle('mcp:add', (_e, input) => {
  const server = normalizeServerInput(input);
  if (!server.command) return { ok: false, error: '缺少启动命令' };
  const list = config.mcp?.servers || [];
  if (list.some((s) => s.name === server.name && s.command === server.command)) {
    return { ok: false, error: '同样的 MCP 服务已存在' };
  }
  const record = { id: 'mcp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), ...server };
  config.mcp = { servers: [...list, record] };
  saveConfig();
  return { ok: true, servers: config.mcp.servers };
});

ipcMain.handle('mcp:remove', (_e, id) => {
  config.mcp = { servers: (config.mcp?.servers || []).filter((s) => s.id !== id) };
  saveConfig();
  return { ok: true, servers: config.mcp.servers };
});

ipcMain.handle('mcp:toggle', (_e, { id, enabled }) => {
  const list = config.mcp?.servers || [];
  const found = list.find((s) => s.id === id);
  if (!found) return { ok: false, error: '服务不存在' };
  found.enabled = !!enabled;
  config.mcp = { servers: list };
  saveConfig();
  return { ok: true, servers: list };
});

/** 试一试: 真的起一次, 把工具清单和报错拿回来给界面看 */
ipcMain.handle('mcp:probe', async (_e, { id }) => {
  const found = (config.mcp?.servers || []).find((s) => s.id === id);
  if (!found) return { ok: false, error: '服务不存在' };
  const mgr = new MCPManager([{ ...found, enabled: true }]);
  try {
    const info = await mgr.connectAll();
    if (info.errors.length) {
      return { ok: false, error: info.errors[0].error, stderr: info.errors[0].stderr || '' };
    }
    return {
      ok: true,
      tools: info.tools.map((t) => ({
        name: (t.function && t.function.name) || '',
        description: (t.function && t.function.description) || ''
      }))
    };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    mgr.closeAll();
  }
});

// ==================== 设置: 提示词 ====================

/**
 * 提示词快照。
 * 界面拿它渲染模块列表 + 编辑框 + 预览, 所以一次给全:
 * 默认值、当前值、改没改过、critical 标记。
 */
ipcMain.handle('prompt:get', () => Prompt.snapshot(config.prompt));

/**
 * 保存。只留认识的模块 id, critical 的开关忽略 —— 清洗在 lib/prompt.js 里。
 *
 * 现在有三套 (对话 / 搭建 / 测试), 所以界面传上来的是
 *   { sets: { chat: { modules }, builder: { modules }, tester: { modules } } }
 * 老界面传的 { modules } 也照样认 —— normalizePromptConfig 会把它当对话那套。
 */
ipcMain.handle('prompt:save', (_e, payload) => {
  const clean = Prompt.normalizePromptConfig(payload);
  config.prompt = clean;
  saveConfig();
  return { ok: true, ...Prompt.snapshot(config.prompt) };
});

/** 恢复出厂: 整个 prompt 段落清空, 三套一起回到默认提示词 */
ipcMain.handle('prompt:reset', () => {
  config.prompt = { sets: {} };
  saveConfig();
  return { ok: true, ...Prompt.snapshot(config.prompt) };
});

// ==================== 设置: 通用 ====================

ipcMain.handle('general:get', () => ({ ok: true, general: normalizeGeneral(config.general) }));

ipcMain.handle('general:save', (_e, input) => {
  config.general = normalizeGeneral(input);
  saveConfig();
  return { ok: true, general: config.general };
});

// ==================== 设置: 搭建 Agent ====================

ipcMain.handle('builder:get', () => ({ ok: true, builder: normalizeBuilder(config.builder) }));

ipcMain.handle('builder:save', (_e, input) => {
  config.builder = normalizeBuilder(input);
  saveConfig();
  return { ok: true, builder: config.builder };
});

// ==================== 设置: 关于 / 版本更新 ====================

ipcMain.handle('app:info', () => ({
  ok: true,
  info: {
    name: 'Askaha',
    // 版本号只有一个来源: package.json。界面**不另写一份** —— 两处各存一个版本号
    // 迟早会对不上, 而"我装的到底是哪个版本"是这一页唯一必须答对的问题。
    version: app.getVersion(),
    configPath: configPath || '',
    userDataDir: app.getPath('userData'),
    electron: process.versions.electron || '',
    node: process.versions.node || ''
  }
}));

ipcMain.handle('update:get', () => ({
  ok: true,
  update: normalizeUpdate(config.update),
  current: app.getVersion()
}));

ipcMain.handle('update:set', (_e, input) => {
  config.update = normalizeUpdate(input);
  saveConfig();
  return { ok: true, update: config.update };
});

ipcMain.handle('update:check', async (_e, input) => {
  // 允许"检查时顺手把刚改的地址存下来": 用户填完地址直接点检查是很自然的动作,
  // 若这里读的还是上一次保存的值, 界面会拿旧地址去查, 然后显示一个莫名其妙的
  // 结果 —— 他明明把地址改了。
  if (input && typeof input === 'object' && input.feedUrl !== undefined) {
    config.update = normalizeUpdate(input);
    saveConfig();
  }
  const feedUrl = normalizeUpdate(config.update).feedUrl;
  if (!feedUrl) return { ok: false, error: '还没配置更新源' };

  try {
    const remote = await fetchUpdateFeed(feedUrl);
    const current = app.getVersion();
    return { ok: true, current, remote, hasUpdate: compareVersion(remote.version, current) > 0 };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

ipcMain.handle('agent:checkpoint:respond', (_e, { id, data }) => {
  const resolver = pendingCheckpoints.get(id);
  if (resolver) {
    pendingCheckpoints.delete(id);
    resolver(data || { cancelled: true });
  }
  return true;
});

ipcMain.handle('skills:toggle', async (_e, name, enabled) => {
  const enabledList = new Set(config.skills?.enabled || []);
  if (enabled) enabledList.add(name);
  else enabledList.delete(name);
  config.skills = { enabled: Array.from(enabledList) };
  saveConfig();
  return config.skills;
});

ipcMain.handle('report:export', async (_e, { html, md, baseName, format }) => {
  const preferMd = format === 'md';
  const result = await dialog.showSaveDialog(mainWindow, {
    title: preferMd ? '导出 Markdown' : '导出 HTML',
    defaultPath: `${baseName || 'report'}.${preferMd ? 'md' : 'html'}`,
    filters: preferMd
      ? [{ name: 'Markdown', extensions: ['md'] }, { name: 'HTML', extensions: ['html'] }]
      : [{ name: 'HTML', extensions: ['html'] }, { name: 'Markdown', extensions: ['md'] }]
  });
  if (result.canceled || !result.filePath) return { ok: false };

  const isMd = result.filePath.toLowerCase().endsWith('.md');
  const content = isMd ? md : html;
  if (typeof content !== 'string' || !content) {
    return { ok: false, error: '报告内容为空, 未写入文件' };
  }
  try {
    fs.writeFileSync(result.filePath, content, 'utf-8');
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: true, filePath: result.filePath };
});

ipcMain.handle('report:exportXLSX', async (_e, { base64, baseName }) => {
  if (typeof base64 !== 'string' || !base64) {
    return { ok: false, error: '没有可导出的 Excel 数据' };
  }
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Excel',
    defaultPath: `${baseName || 'report'}.xlsx`,
    filters: [{ name: 'Excel', extensions: ['xlsx'] }]
  });
  if (result.canceled || !result.filePath) return { ok: false };
  try {
    fs.writeFileSync(result.filePath, Buffer.from(base64, 'base64'));
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: true, filePath: result.filePath };
});
