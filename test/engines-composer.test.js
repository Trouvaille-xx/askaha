'use strict';

/**
 * AI 搭建面板输入框的回归测试: 发出去之后**立刻**清空, 而且跑的过程中不被禁用。
 *
 * 现场 (用户截图 + 原话): "这个页面, 发送出去之后, 对话框内内容没释放, 而且也不让点击。"
 * 截图里同一个需求文字出现了两次 —— 上面那条是对话记录里的, 下面那个框是**输入框里
 * 还留着刚发出去的话**。
 *
 * 两个根因, 都在这一条链上:
 *
 *  1. 清空绑在"整轮跑完"上。老代码是
 *       const sent = await engAiSendText(text);
 *       if (sent && ta.value.trim() === text) ta.value = '';
 *     `sent` 要等 engAiSendText 整个 Promise 落地才为真 —— 而那一轮包括搭建 + 后面
 *     主进程接着跑的自测, 可能好几分钟。于是这几分钟里输入框一直挂着那句话。
 *     修法: engAiSendText 收下这句话时立刻回调 (onAccepted), 跟整轮啥时候结束无关。
 *
 *  2. busy 期间 `ta.disabled = true`。上一句还没清掉, 框又点不动, 用户只能盯着转圈,
 *     既改不了也写不了下一句。修法: 只禁用发送按钮, 输入框保持可点可写;
 *     真撞上"上一条还在处理", 发送那一步会明说原因 (不会静默什么都不发生)。
 *
 * 这个文件加载**真实的 engines.js** (vm + DOM 桩, 跟 engines-answer-once.test.js
 * 同一套办法), 所以测的是真代码路径。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'engines.js'), 'utf-8');

/** 会记住 class 的迷你元素 —— 断言"停止按钮亮没亮"要用 */
function miniEl(id) {
  const e = {
    id, value: '', textContent: '', innerHTML: '', disabled: false, hidden: false,
    dataset: {}, style: {}, children: [],
    _classes: new Set(),
    addEventListener() {}, appendChild() {}, remove() {},
    querySelector: () => null, querySelectorAll: () => [],
    setAttribute() {}, getAttribute: () => null,
    focus() {}, click() {}
  };
  e.classList = {
    add: (c) => e._classes.add(c),
    remove: (c) => e._classes.delete(c),
    contains: (c) => e._classes.has(c),
    toggle: (c, on) => { if (on) e._classes.add(c); else e._classes.delete(c); }
  };
  return e;
}

/**
 * 加载 engines.js, 交出输入框/按钮和几个被替掉的依赖。
 *
 * 被替掉的都是"会去够后端或 DOM"的: 渲染、刷新列表、看门狗、开会话、范围。
 * 要验的两件事 (清空时机、禁用状态) 全在真实代码里。
 */
function loadEngines() {
  const ta = miniEl('engAiInput');
  const btn = miniEl('btnAiSend');
  const stop = miniEl('btnAiStop');

  /** 一个"你说了算什么时候落地"的 aiSay */
  let settle;
  const sayPromise = new Promise((resolve, reject) => { settle = { resolve, reject }; });

  const toasts = [];
  const exposed = `
;engAiRenderLog = function () {};
engAiRefreshChats = function () {};
engAiKickWatchdog = function () {};
engAiStopWatchdog = function () {};
engAiEnsureSession = function () { return Promise.resolve('sid-1'); };
engAiScopeForSend = function () { return { db1: { tables: ['t'] } }; };
engToast = function (msg, kind) { globalThis.__toasts.push({ msg, kind }); };
globalThis.__T = {
  engState, engAiSend, engAiSendText, engAiSetComposerBusy,
  ta: document.__ta, btn: document.__btn, stop: document.__stop
};`;

  const bySel = {
    '#engAiInput': ta,
    '#btnAiSend': btn,
    '#btnAiStop': stop
  };

  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set,
    __toasts: toasts,
    document: {
      __ta: ta, __btn: btn, __stop: stop,
      querySelector: (sel) => bySel[sel] || null,
      querySelectorAll: () => [],
      getElementById: () => null,
      createElement: () => miniEl('div'),
      addEventListener() {},
      body: miniEl('body'),
      documentElement: miniEl('html'),
      title: ''
    },
    window: {
      bridge: { engine: { aiSay: () => sayPromise, aiOpen: () => Promise.resolve({ ok: true, sessionId: 'sid-1' }) } },
      addEventListener() {}
    },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }
  };
  sandbox.globalThis = sandbox;
  sandbox.window.document = sandbox.document;

  vm.createContext(sandbox);
  vm.runInContext(SRC + exposed, sandbox, { filename: 'engines.js' });

  const T = sandbox.__T;
  T.toasts = toasts;
  T.settle = settle;
  // 一张 2 个节点的卡: 不会触发"让 AI 改这张卡?"那个确认弹窗 (节点 > 2 才问)
  T.engState.card = { id: 'c1', nodes: [{ id: 'a' }, { id: 'b' }] };
  T.engState.aiLog = [];
  return T;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/* ============================================================
 * 1. 清空时机
 * ============================================================ */

test('发送之后输入框**立刻**清空, 不等整轮跑完', async () => {
  const T = loadEngines();
  T.ta.value = '  帮我加一个节点  ';
  const p = T.engAiSend();          // 故意不 await: aiSay 还没落地

  await flush();
  assert.strictEqual(T.ta.value, '', '收下那句话的当下就该清空 —— 不然要挂好几分钟');
  assert.strictEqual(T.engState.aiChatBusy, true, '这一轮确实还在跑');
  assert.strictEqual(T.ta.disabled, false, '跑的时候输入框仍然可以点、可以打字');

  T.settle.resolve({ ok: true });
  await p;
  assert.strictEqual(T.ta.value, '');
  assert.strictEqual(T.engState.aiChatBusy, false, '跑完要解锁');
  assert.strictEqual(T.ta.disabled, false);
});

test('那句话确实进了对话记录 (清空不等于丢掉)', async () => {
  const T = loadEngines();
  T.ta.value = '查入库状态';
  const p = T.engAiSend();
  await flush();
  const mine = T.engState.aiLog.filter((m) => m.role === 'user').map((m) => m.text);
  assert.deepStrictEqual(mine, ['查入库状态']);
  T.settle.resolve({ ok: true });
  await p;
});

test('发不出去时字留在框里, 并且明说原因 (用户的话不丢)', async () => {
  const T = loadEngines();
  T.engState.aiChatBusy = true;            // 上一条还在跑
  T.ta.value = '再来一条';
  await T.engAiSend();
  assert.strictEqual(T.ta.value, '再来一条', '没发出去就不能把用户的话吞掉');
  assert.ok(T.toasts.some((t) => /上一条还在处理/.test(t.msg)), '要说清为什么没发出去: ' + JSON.stringify(T.toasts));
  assert.deepStrictEqual(T.engState.aiLog, [], '没发出去就不该进记录');
});

test('这一轮抛错也要复位: busy 解开、输入框继续可用', async () => {
  const T = loadEngines();
  T.ta.value = '会失败的一句';
  const p = T.engAiSend();
  await flush();
  T.settle.reject(new Error('网关 502'));
  await p;

  assert.strictEqual(T.engState.aiChatBusy, false, '异常路径不能把 busy 卡住');
  assert.strictEqual(T.ta.disabled, false, '输入框永远不该被锁住');
  assert.ok(T.engState.aiLog.some((m) => m.err), '失败要写进对话记录');
});

/* ============================================================
 * 2. 忙碌状态: 只锁按钮, 不锁输入框
 * ============================================================ */

test('忙碌时: 发送按钮禁用 + 亮出「停止」, 但输入框不禁用', () => {
  const T = loadEngines();
  T.engAiSetComposerBusy(true);
  assert.strictEqual(T.btn.disabled, true, '按钮禁用, 并且文案会变成"思考中…"');
  assert.strictEqual(T.btn.textContent, '思考中…');
  assert.strictEqual(T.stop.classList.contains('on'), true, '"停止"要跟着 busy 一起出现');
  assert.strictEqual(T.ta.disabled, false, '输入框不许禁用 —— 这就是"不让点击"的来源');

  T.engAiSetComposerBusy(false);
  assert.strictEqual(T.btn.disabled, false);
  assert.strictEqual(T.btn.textContent, '发送');
  assert.strictEqual(T.stop.classList.contains('on'), false);
  assert.strictEqual(T.ta.disabled, false);
});
