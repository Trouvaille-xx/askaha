'use strict';

/**
 * 模型的话**逐字显示**这件事的回归测试。
 *
 * 起因 (产品经理的原话): "四，这个问题，可以加。"
 * —— 指的是模型一次往返要 10~20 秒, 那段时间界面上只有一行"正在想…",
 * 然后整段回答瞬间蹦出来。总耗时没变, 但感受是"卡了很久然后突然有东西"。
 *
 * 这个文件要钉住的是**三件容易写错的事**:
 *
 *  1. 正在打字的那一条必须渲染成**空的**。
 *     渲染成全文的话, 打字期间任何一次重画 (别的消息进来、面板重绘) 都会把
 *     全文一次性糊上去 —— 表现就是"打到一半突然跳完", 白做了。
 *
 *  2. `revealed === undefined` 必须**照常渲染全文**, 不能当成"正在打字"。
 *     从盘上读回来的历史对话没有这个字段; 判错的话打开历史会看到一堆空白气泡。
 *     (engAiLoadChat 现在会主动把读回来的标成 true, 但这里再钉一层 ——
 *      渲染逻辑本身就该对缺失字段安全, 不能依赖调用方记得标。)
 *
 *  3. 用户自己打的话永远不参与逐字 —— 再打一遍自己的话很怪。
 *
 * 加载的是**真实的 engines.js** (vm + DOM 桩, 跟 engines-composer.test.js 同一套办法)。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'engines.js'), 'utf-8');

function miniEl(id) {
  const e = {
    id, value: '', textContent: '', innerHTML: '', disabled: false, hidden: false,
    dataset: {}, style: {}, children: [], scrollTop: 0, scrollHeight: 0,
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

/** 加载 engines.js, 但**保留真实的 engAiRenderLog** —— 要验的正是它 */
function loadEngines(opts) {
  const logBox = miniEl('engAiLog');

  /**
   * 够用的 DOM 桩: 从 innerHTML 里认出消息气泡, 并交出**可以写的**元素。
   *
   * 为什么要做到这一步: 逐字动画是 `eqAll('.eng-ai-msg.ai', box)` 找到元素后
   * 往里写 textContent 的。桩要是返回空数组, 动画会走"找不到元素"的早退分支,
   * 于是"动画有没有真的把字打出来"这件事根本测不到 —— 只会测到早退。
   */
  logBox.querySelectorAll = (sel) => {
    if (!/eng-ai-msg/.test(sel)) return [];
    lastWritten = null;
    const els = [];
    const re = /<div class="eng-ai-msg ([^"]*)">([\s\S]*?)<\/div>/g;
    let m;
    while ((m = re.exec(logBox.innerHTML)) !== null) {
      const cls = m[1];
      if (/\.ai/.test(sel) && !cls.split(/\s+/).includes('ai')) continue;
      const el = { _text: m[2], style: {} };
      // 动画是往元素的 textContent 里写的。真实 DOM 会立刻反映到 innerHTML,
      // 但这个桩是游离的 —— 所以把写入记下来, 测试用它看"字打到哪了"。
      Object.defineProperty(el, 'textContent', {
        get: () => el._text,
        set: (v) => { el._text = String(v); lastWritten = String(v); }
      });
      els.push(el);
    }
    return els;
  };
  logBox.querySelector = () => null;

  // 假的时钟: 动画时长是按"真实经过时间"算的 (0.8~1.6 秒)。
  // 直接 sleep 会拖慢测试, 所以把 performance.now 换成我们自己推的 ——
  // 每帧往后跳 400ms, 三帧内必定打完。
  let clock = 0;
  const frames = [];
  const fakeNow = () => clock;
  let lastWritten = null;

  const bySel = { '#engAiLog': logBox };

  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set,
    document: {
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
      bridge: { engine: {} },
      addEventListener() {}
    },
    // 帧回调攒起来由测试自己推, 这样"打了几帧"是确定的, 不靠 sleep
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    cancelAnimationFrame: () => {},
    performance: { now: fakeNow },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }
  };
  sandbox.globalThis = sandbox;
  sandbox.window.document = sandbox.document;

  const exposed = `
;engAiRefreshChats = function () {};
engAiKickWatchdog = function () {};
engAiStopWatchdog = function () {};
engAiEnsureSession = function () { return Promise.resolve('sid-1'); };
globalThis.__T = { engState, engAiPush, engAiRenderLog, engAiTypeCancel };`;

  vm.createContext(sandbox);
  vm.runInContext(SRC + exposed, sandbox, { filename: 'engines.js' });
  const T = sandbox.__T;
  T.logBox = logBox;
  /** 动画往 DOM 里写的最后一段字 (桩是游离的, innerHTML 不会变, 只能这样看) */
  T.written = () => lastWritten;
  /** 推进 n 帧, 每帧让时钟走 400ms (动画最长 1600ms, 所以 4 帧一定打完) */
  T.tick = (n = 5) => {
    for (let i = 0; i < n; i++) {
      const fn = frames.shift();
      if (!fn) break;
      clock += 400;
      fn();
    }
  };
  return T;
}

/** 取渲染结果里第 n 条消息气泡的内文 */
function bubble(T, n) {
  const html = T.logBox.innerHTML;
  const msgs = [...html.matchAll(/<div class="eng-ai-msg [^"]*">([\s\S]*?)<\/div>/g)].map((m) => m[1]);
  return msgs[n];
}

test('正在打字的那一条渲染成空的 —— 否则重画会把全文一次性糊上去', () => {
  const T = loadEngines();
  T.engState.aiLog = [
    { role: 'ai', text: '第一句已经说完', revealed: true },
    { role: 'ai', text: '第二句正在逐字显示', revealed: false }
  ];
  T.engAiRenderLog();
  assert.strictEqual(bubble(T, 0), '第一句已经说完', '说完的照常显示');
  assert.strictEqual(bubble(T, 1), '', '正在打字的必须留空, 由动画往里填');
});

test('revealed 缺失时照常显示全文 —— 历史对话没有这个字段', () => {
  const T = loadEngines();
  T.engState.aiLog = [{ role: 'ai', text: '这是从盘上读回来的老回答' }];
  T.engAiRenderLog();
  assert.strictEqual(
    bubble(T, 0),
    '这是从盘上读回来的老回答',
    '缺 revealed 不能当成"正在打字", 否则打开历史对话全是空白气泡'
  );
});

test('用户自己说的话不参与逐字', () => {
  const T = loadEngines();
  T.engState.aiLog = [{ role: 'user', text: '帮我改一下这张卡', revealed: false }];
  T.engAiRenderLog();
  assert.strictEqual(bubble(T, 0), '帮我改一下这张卡', '用户的话就算 revealed=false 也要照常显示');
});

test('动作行不受影响 —— 它是系统播报, 该干脆利落', () => {
  const T = loadEngines();
  T.engState.aiLog = [{ role: 'act', text: '读了表结构：purchase_order' }];
  T.engAiRenderLog();
  assert.match(T.logBox.innerHTML, /读了表结构：purchase_order/, 'act 行照常渲染');
});

test('打字动画会真的把字一个个打出来, 结束正文是全的', () => {
  const T = loadEngines();
  T.engState.aiLog = [];
  T.engAiPush('ai', '这句话应该一个字不少地显示出来');
  const item = T.engState.aiLog[0];
  assert.strictEqual(item.revealed, false, '刚推进去时是"正在打字"');
  assert.strictEqual(T.written(), '', '起手要清空, 不能先闪一下全文');

  // 第一帧: 时钟走了 400ms, 进度还没满 —— 应该只打出一部分
  T.tick(1);
  const partial = T.written();
  assert.ok(partial.length > 0, '第一帧就该有字了, 不能等打完才出现');
  assert.ok(partial.length < item.text.length, '第一帧不该是全文 (那就等于没逐字)');

  // 推到动画结束
  T.tick(6);
  assert.strictEqual(item.revealed, true, '跑完要标成已显示 —— 否则下次重画它又变空白');
  assert.strictEqual(T.written(), item.text, '最终正文一个字都不能少');
});

test('被打断时按"全文已显示"收尾, 不能留在半句', () => {
  const T = loadEngines();
  T.engState.aiLog = [];
  T.engAiPush('ai', '这句会被下一条消息打断');
  const item = T.engState.aiLog[0];
  T.tick(1);                       // 打了一半
  assert.strictEqual(item.revealed, false, '此刻确实还在打字');
  const half = T.written();
  assert.ok(half.length < item.text.length, '确认只打了一半');

  // 新消息进来 -> engAiPush 内部会先收掉上一条
  T.engAiPush('ai', '新的一句');
  assert.strictEqual(item.revealed, true, '被打断的那条要按已显示处理');
  // 重画之后, 被打断那条的正文必须是完整的
  T.engAiRenderLog();
  assert.strictEqual(bubble(T, 0), item.text, '内容必须是完整的, 不能只剩半句');
});

test('收掉动画时那条消息标成已显示, 不能留在半截', () => {
  const T = loadEngines();
  T.engState.aiLog = [{ role: 'ai', text: '被打断的一句', revealed: false }];
  T.engState.aiTypeRaf = 12345;   // 假装有个动画在跑
  T.engAiTypeCancel();
  assert.strictEqual(T.engState.aiLog[0].revealed, true, '打断后要按"全文已显示"处理');
  assert.strictEqual(T.engState.aiTypeRaf, 0, '句柄要清掉');
  T.engAiRenderLog();
  assert.strictEqual(bubble(T, 0), '被打断的一句', '内容必须完整, 不能只剩半句');
});
