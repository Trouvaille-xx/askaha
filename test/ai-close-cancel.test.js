'use strict';

/**
 * 关掉搭建面板 = 真的把在跑的东西停掉。
 *
 * 修复前的行为 (读代码确认过):
 *   engine:aiClose 只有一句 `aiSessions.delete(sessionId)`。
 *   而在跑的 `builder.send()` 拿着自己的引用继续跑 —— 于是切走之后:
 *     - AI 继续烧 token
 *     - 跑完还把结果写回对话记录
 *     - 用户完全不知道 (界面上是"关了")
 *   而且三个调用点 (engAiDetach 换上下文 / engAiOpenChat 换对话 /
 *   engAiEnsureSession(force) 强制新会话) 都拿不到「停止」按钮 ——
 *   也就是说那个在跑的任务**再也没有东西能掐掉它**。
 *
 * 这里用桩 electron + 桩 LLM 把真实的 main.js 跑起来, 验证:
 *   1. aiClose 会报告取消了搭建
 *   2. 在飞的模型请求被 abort (不是只置个标志等它自己返回)
 *   3. 没有在跑的东西时, aiClose 照常工作, 不会误报
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 桩 LLM: chat() 挂住不返回, 记录 abort() 被调用 */
function makeLLMStub() {
  const rec = { aborted: [], created: 0 };
  class FakeLLM {
    constructor(cfg) {
      this.config = cfg;
      this._pending = null;
      rec.created += 1;
    }
    // 永不 resolve —— 模拟"请求还在飞"。搭建走的是 chatStep, 分析走的是 chat,
    // 两个都要挂住, 否则 aiSay 会在到达 buildRuns 之前就失败退出。
    _hang() {
      return new Promise((resolve, reject) => { this._pending = { resolve, reject }; });
    }
    chat() { return this._hang(); }
    chatStep() { return this._hang(); }
    abort(why) {
      rec.aborted.push(why);
      if (this._pending) {
        const p = this._pending;
        this._pending = null;
        p.reject(new Error('aborted: ' + why));
      }
    }
    _extractJSON() { return null; }
    get lastUsage() { return null; }
  }
  FakeLLM.normalizeToolCalls = () => [];
  FakeLLM.usageOf = () => null;
  FakeLLM.addUsage = () => null;
  FakeLLM.DEFAULT_MAX_TOKENS = 8192;
  return { FakeLLM, rec };
}

/** 用桩 electron + 桩 LLM 加载一份全新的 main.js */
function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solodb-aiclose-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    llm: {
      models: [{ id: 'm1', name: '测试模型', baseURL: 'https://x/v1', apiKey: 'sk-test', model: 'm', contextLimit: 128000, maxTokens: 8192 }],
      activeId: 'm1'
    },
    databases: [],
    engines: []
  }), 'utf-8');

  process.env.SOLODB_USER_DATA = dir;

  const handlers = new Map();
  let readyResolve;
  const ready = new Promise((r) => { readyResolve = r; });

  const fake = {
    app: { getPath: () => dir, setPath: () => {}, whenReady: () => ready, on: () => {}, quit: () => {} },
    BrowserWindow: class {
      constructor() { this.webContents = { send() {}, on() {}, setWindowOpenHandler() {}, openDevTools() {} }; }
      loadFile() {}
      on() {}
      once() {}
      isDestroyed() { return true; }
    },
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: (ch, fn) => handlers.set(ch, fn) },
    dialog: { showSaveDialog: async () => ({ canceled: true }) },
    shell: { openPath: async () => {}, openExternal: async () => {} }
  };

  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(ROOT) && !k.includes('node_modules')) delete require.cache[k];
  }

  const { FakeLLM, rec } = makeLLMStub();
  const LLM_PATH = path.join(ROOT, 'lib', 'llm.js');

  const orig = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req === 'electron') return fake;
    try {
      // 按**解析后的路径**换, 这样 main.js 和 lib/test-loop.js 拿到的都是桩
      if (Module._resolveFilename(req, parent, isMain) === LLM_PATH) return FakeLLM;
    } catch (e) { /* 解析不了就走原路 */ }
    return orig.apply(this, arguments);
  };
  try {
    require(path.join(ROOT, 'main.js'));
  } finally {
    Module._load = orig;
  }
  readyResolve();

  return { dir, handlers, llm: rec, settle: () => sleep(250) };
}

const CARD = () => ({ id: 'card_1', name: '测试卡', nodes: {}, edges: [] });

/* ============================================================ */

test('aiClose 会取消在跑的搭建, 并且 abort 在飞的模型请求', async () => {
  const b = boot();
  await b.settle();

  const open = await b.handlers.get('engine:aiOpen')(null, { card: CARD(), pool: {} });
  assert.ok(open.ok, 'aiOpen 应该成功: ' + (open.error || ''));
  const sessionId = open.sessionId;

  // 起一轮搭建。**不 await** —— 它会挂在桩 LLM 上
  const pending = b.handlers.get('engine:aiSay')(null, { sessionId, text: '帮我搭一张查送货单签收状态的卡', pool: {}, card: CARD(), log: [] });
  pending.catch(() => {});   // 取消会让它 reject, 接住免得 unhandled rejection

  // 让 buildRuns 落位, 并尽量走到模型调用
  await sleep(200);

  const closed = await b.handlers.get('engine:aiClose')(null, { sessionId });

  assert.strictEqual(closed.ok, true);
  assert.strictEqual(closed.cancelledBuild, true,
    'aiClose 应该报告"取消了搭建" —— 修复前它只删会话, 什么都不取消');

  // 这一条是重点: 只置取消标志不够, AgentLoop 要到下一步才检查,
  // 当前那次模型调用得等它自己返回 (最长 3 分钟), 界面上看着像没反应。
  assert.ok(b.llm.aborted.length > 0,
    `在飞的模型请求必须被 abort (实际 abort 了 ${b.llm.aborted.length} 次) —— 只置标志不算停`);

  pending.catch(() => {});
});

test('没有在跑的东西时, aiClose 照常工作, 不误报取消', async () => {
  const b = boot();
  await b.settle();

  const open = await b.handlers.get('engine:aiOpen')(null, { card: CARD(), pool: {} });
  const closed = await b.handlers.get('engine:aiClose')(null, { sessionId: open.sessionId });

  assert.strictEqual(closed.ok, true);
  assert.strictEqual(closed.cancelledBuild, false, '没在跑就不该说取消了');
  assert.strictEqual(closed.cancelledSelfTest, false);
  assert.strictEqual(b.llm.aborted.length, 0, '没在跑就不该 abort 任何东西');
});

test('aiClose 之后会话确实没了 (再发消息会被挡住)', async () => {
  const b = boot();
  await b.settle();

  const open = await b.handlers.get('engine:aiOpen')(null, { card: CARD(), pool: {} });
  await b.handlers.get('engine:aiClose')(null, { sessionId: open.sessionId });

  const say = await b.handlers.get('engine:aiSay')(null, { sessionId: open.sessionId, text: '还在吗', pool: {}, card: CARD(), log: [] });
  assert.strictEqual(say.ok, false, '会话已经关掉了, 不该还能继续发');
});

test('sessionId 为空时 aiClose 不炸', async () => {
  const b = boot();
  await b.settle();
  const r = await b.handlers.get('engine:aiClose')(null, {});
  assert.strictEqual(r.ok, true);
});

test('aiCancel 与 aiClose 走的是同一条取消逻辑 (停止按钮不能被绕过)', async () => {
  const b = boot();
  await b.settle();

  const open = await b.handlers.get('engine:aiOpen')(null, { card: CARD(), pool: {} });
  const pending = b.handlers.get('engine:aiSay')(null, { sessionId: open.sessionId, text: '搭一张卡', pool: {}, card: CARD(), log: [] });
  pending.catch(() => {});
  await sleep(200);

  const r = await b.handlers.get('engine:aiCancel')(null, { sessionId: open.sessionId });
  assert.strictEqual(r.ok, true, '停止按钮应该能找到在跑的搭建');
  assert.ok(b.llm.aborted.length > 0, '停止按钮也要 abort 在飞的请求');
  pending.catch(() => {});
});
