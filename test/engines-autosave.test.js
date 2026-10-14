'use strict';

/**
 * 流程卡页面的**自动保存**。
 *
 * 用户的要求: 「流程卡页面的所有信息，自动保存。」
 *
 * 改动前: 这张卡上的一切都要手点「保存」—— 改卡名、配范围、加节点、拖布局。
 * 忘了就丢。而且**拖节点连"未保存"的提示都不会亮**: 拖动只改 node.x / node.y,
 * 从不调 engTouch(), 于是摆好的布局在离开画板时静默消失 (除非恰好又改了
 * 别的东西再点保存, 位置才顺带被存下去)。
 *
 * 这个文件锁住自动保存的三条硬要求:
 *   1. 改了就存, 不用点按钮
 *   2. **绝不打断正在输入的人** —— 不替换 engState.card, 不重画面板
 *   3. 保存期间又改了, 那一笔不能丢
 *
 * 直接加载真实的 engines.js (vm + DOM 桩), 测的是真代码路径。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RAW_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'engines.js'), 'utf-8');

/**
 * 测试里把防抖窗口缩短。
 *
 * 生产值是 900ms (见下面的断言), 但每个用例都等 900ms 的话这个文件要跑 19 秒。
 * 只替换这一个常量, 其余源码原样加载 —— 测的还是真实代码路径。
 */
const TEST_DEBOUNCE = 40;
const SRC = RAW_SRC.replace(
  /const ENG_AUTOSAVE_DEBOUNCE_MS = \d+;/,
  'const ENG_AUTOSAVE_DEBOUNCE_MS = ' + TEST_DEBOUNCE + ';'
);

/** 一个能按选择器查到的假元素 */
function mkEl(sel) {
  const classes = new Set();
  const e = {
    _sel: sel,
    value: '', textContent: '', innerHTML: '', hidden: false, disabled: false,
    title: '', offsetWidth: 180, offsetHeight: 70,
    offsetTop: 0, clientWidth: 900, clientHeight: 600,
    dataset: {}, style: {}, children: [],
    classList: {
      add(c) { classes.add(c); }, remove(c) { classes.delete(c); },
      toggle(c, on) { if (on === undefined) { classes.has(c) ? classes.delete(c) : classes.add(c); } else if (on) classes.add(c); else classes.delete(c); },
      contains(c) { return classes.has(c); }
    },
    addEventListener(type, fn) { (e._on[type] = e._on[type] || []).push(fn); },
    removeEventListener() {},
    appendChild(c) { e.children.push(c); return c; },
    removeChild(c) { return c; },
    remove() {}, setAttribute() {}, getAttribute: () => null,
    focus() {}, blur() {}, click() {},
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 600 }),
    scrollTop: 0, scrollHeight: 0,
    _on: {}
  };
  // className 和 classList 必须联动 —— 代码里是 `hint.className = 'engine-dirty saved'`
  // 这种字符串赋值, 桩不同步的话 classList.contains 永远返回 false
  Object.defineProperty(e, 'className', {
    get() { return Array.from(classes).join(' '); },
    set(v) { classes.clear(); String(v || '').split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); }
  });
  return e;
}

/**
 * 装 engines.js 进沙箱, 交出内部符号 + 可控的 DOM。
 * els: 选择器 -> 假元素 (querySelector 会先查这张表)
 */
function loadEngines(opts = {}) {
  const els = opts.els || {};
  const winListeners = {};
  const calls = { save: 0, saveSync: 0, savedCards: [] };
  let saveImpl = opts.saveImpl || (async () => ({ ok: true, engine: { id: 'e1', name: '卡', nodes: [] }, engines: [] }));

  const exposed = `
;globalThis.__T = {
  engState, engTouch, engSave, engAutoSave, engFlushAutoSave, engFlushOnUnload,
  engSetSaveState, engBackToGallery, engBindCanvasEvents, engBindAutoSaveGuards,
  engCardScopeWriteBack,
  ENG_AUTOSAVE_DEBOUNCE_MS,
  setCard(c) { engState.card = c; }
};`;

  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set,
    document: {
      querySelector: (sel) => els[sel] || null,
      querySelectorAll: () => [],
      getElementById: () => null,
      createElement: () => mkEl('created'),
      addEventListener() {},
      body: mkEl('body'),
      documentElement: mkEl('html'),
      activeElement: null
    },
    window: {
      confirm: () => true,
      addEventListener(type, fn) { (winListeners[type] = winListeners[type] || []).push(fn); },
      removeEventListener() {},
      bridge: {
        engine: {
          save: (card) => { calls.save += 1; calls.savedCards.push(card); return saveImpl(card); },
          saveSync: (card) => { calls.saveSync += 1; calls.savedCards.push(card); return { ok: true, engines: [] }; }
        }
      }
    },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }
  };
  sandbox.globalThis = sandbox;
  sandbox.window.document = sandbox.document;

  vm.createContext(sandbox);
  vm.runInContext(SRC + exposed, sandbox, { filename: 'engines.js' });

  const T = sandbox.__T;
  T._els = els;
  T._winListeners = winListeners;
  T._calls = calls;
  T._setSaveImpl = (fn) => { saveImpl = fn; };
  return T;
}

const DEBOUNCE = TEST_DEBOUNCE;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('生产用的防抖是 900ms (测试里改短了, 这里锁住真实值)', () => {
  const m = RAW_SRC.match(/const ENG_AUTOSAVE_DEBOUNCE_MS = (\d+);/);
  assert.ok(m, '找不到防抖常量');
  const ms = Number(m[1]);
  // 太短: 每敲一个字就是一次 config.json 全量重写 (里面还有 4 个库的配置)
  // 太长: "改完立刻关窗"会丢 (关窗那条路有同步兜底, 但切走窗口没有)
  assert.ok(ms >= 300 && ms <= 3000, '防抖窗口 ' + ms + 'ms 不合理');
});

/** 造一张最小的卡, 挂进 engState */
function seedCard(T, nodes) {
  const card = { id: 'e1', name: '测试卡', description: '', enabled: true, nodes: nodes || [], edges: [], scope: {} };
  T.engState.card = card;
  T.engState.currentId = 'e1';
  T.engState.dirty = false;
  T.engState.rev = 0;
  T.engState.savedRev = 0;
  T.engState.autoSaveState = '';
  return card;
}

/* ============================================================
 * 1. 改了就存
 * ============================================================ */

test('改一下就自动存, 不用点「保存」', async () => {
  const T = loadEngines();
  seedCard(T);
  assert.strictEqual(T._calls.save, 0, '还没改, 不该存');

  T.engTouch();
  assert.strictEqual(T._calls.save, 0, '刚改不该立刻存 —— 要等防抖');

  await wait(DEBOUNCE + 250);
  assert.strictEqual(T._calls.save, 1, '停手之后应该自动存一次');
  assert.strictEqual(T.engState.dirty, false, '存完就不脏了');
  assert.strictEqual(T.engState.savedRev, T.engState.rev, '已落盘的版本号要跟上');
});

test('连续打字只存一次 (防抖, 不是每敲一个字写一次盘)', async () => {
  const T = loadEngines();
  seedCard(T);

  for (let i = 0; i < 10; i++) {
    T.engState.card.name = '卡' + i;
    T.engTouch();
    await wait(30);   // 打字间隔远小于防抖窗口
  }
  assert.strictEqual(T._calls.save, 0, '打字期间一次都不该存');

  await wait(DEBOUNCE + 250);
  assert.strictEqual(T._calls.save, 1, '停手后只存一次, 实际 ' + T._calls.save);
  assert.strictEqual(T._calls.savedCards[0].name, '卡9', '存的应该是最后一次的内容');
});

test('存的确实是当前这张卡 (不是空白或旧快照)', async () => {
  const T = loadEngines();
  const card = seedCard(T, [{ id: 'n1', type: 'input', x: 11, y: 22, title: '入口' }]);
  card.name = '红字发票';
  T.engTouch();
  await wait(DEBOUNCE + 250);

  const sent = T._calls.savedCards[0];
  assert.strictEqual(sent.name, '红字发票');
  assert.strictEqual(sent.nodes[0].x, 11, '节点坐标也要带上');
  assert.strictEqual(sent.nodes[0].title, '入口');
});

test('保存前会把可用范围写回卡上 (否则配了范围存不下去)', async () => {
  const T = loadEngines();
  seedCard(T);
  T.engState.aiPool = { db1: ['t1', 't2'] };
  T.engTouch();
  await wait(DEBOUNCE + 250);
  assert.deepStrictEqual(T._calls.savedCards[0].scope, { db1: ['t1', 't2'] });
});

/* ============================================================
 * 2. 绝不打断正在输入的人
 *
 * 这是自动保存最容易做砸的地方: 手点「保存」会拿主进程洗过的新对象替换
 * engState.card 并把右侧面板重画一遍, 那是**点击**换来的, 用户预期被重画。
 * 自动保存要是也这么干, 用户正打字的那一行就指向一个没人认领的旧对象。
 * ============================================================ */

test('自动保存**不替换** engState.card —— 否则检查器里的输入会写进孤儿对象', async () => {
  const T = loadEngines({
    saveImpl: async () => ({
      ok: true,
      // 主进程洗过的一份**全新对象**
      engine: { id: 'e1', name: '主进程洗过的', nodes: [], edges: [], scope: {} },
      engines: []
    })
  });
  const card = seedCard(T);
  card.name = '用户打的字';
  T.engTouch();
  await wait(DEBOUNCE + 250);

  assert.strictEqual(T._calls.save, 1, '应该存过了');
  assert.strictEqual(T.engState.card, card, '必须是同一个对象 —— 换了引用, 检查器就断了');
  assert.strictEqual(T.engState.card.name, '用户打的字', '本地这份不能被主进程的版本盖掉');
});

test('手点「保存」仍然会采纳主进程洗过的对象 (那条路该重画就重画)', async () => {
  const T = loadEngines({
    saveImpl: async () => ({
      ok: true,
      engine: { id: 'e1', name: '主进程洗过的', nodes: [], edges: [], scope: {} },
      engines: []
    })
  });
  const card = seedCard(T);
  card.name = '用户打的字';
  await T.engSave();
  assert.notStrictEqual(T.engState.card, card, '手点保存是要一个"确定已落盘"的交代, 该采纳新的');
  assert.strictEqual(T.engState.card.name, '主进程洗过的');
});

/* ============================================================
 * 3. 保存期间又改了, 那一笔不能丢
 *
 * 用布尔量的 dirty 会有这个漏洞: 请求还在飞的时候用户又敲了一个字,
 * 请求回来把 dirty 清成 false, 那一笔就永远不落盘了。
 * ============================================================ */

test('保存在飞的时候又改了 -> 落地后自动再存一次, 改动不丢', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let n = 0;
  const T = loadEngines({
    saveImpl: async (card) => {
      n += 1;
      if (n === 1) await gate;    // 第一次卡住, 模拟慢写盘
      return { ok: true, engine: card, engines: [] };
    }
  });
  const card = seedCard(T);
  card.name = '第一次';

  T.engTouch();
  await wait(DEBOUNCE + 200);
  assert.strictEqual(T._calls.save, 1, '第一次应该已经发出去了');

  // 飞行途中再改
  card.name = '第二次';
  T.engTouch();
  assert.strictEqual(T.engState.dirty, true, '改了就该是脏的');

  release();                    // 第一次落地
  await wait(DEBOUNCE + 400);

  assert.strictEqual(T._calls.save, 2, '应该补存第二次, 实际 ' + T._calls.save);
  assert.strictEqual(T._calls.savedCards[1].name, '第二次', '补存的是新内容');
  assert.strictEqual(T.engState.dirty, false, '两次都存完才干净');
});

test('保存失败: 状态标成 err, 而且仍然是脏的 (不能假装存上了)', async () => {
  const T = loadEngines({ saveImpl: async () => ({ ok: false, error: '磁盘满了' }) });
  seedCard(T);
  T.engTouch();
  await wait(DEBOUNCE + 250);

  assert.strictEqual(T.engState.autoSaveState, 'err');
  assert.match(T.engState.autoSaveError, /磁盘满了/);
  assert.strictEqual(T.engState.dirty, true, '失败了还是脏的, 不能骗自己');
  assert.notStrictEqual(T.engState.savedRev, T.engState.rev);
});

test('保存抛异常也不能把页面搞崩', async () => {
  const T = loadEngines({ saveImpl: async () => { throw new Error('IPC 断了'); } });
  seedCard(T);
  T.engTouch();
  await wait(DEBOUNCE + 250);
  assert.strictEqual(T.engState.autoSaveState, 'err');
  assert.match(T.engState.autoSaveError, /IPC 断了/);
  assert.strictEqual(T.engState.autoSaveBusy, false, 'busy 要复位, 否则后面再也存不了');
});

/* ============================================================
 * 4. 状态显示
 * ============================================================ */

test('状态: 存的时候显示"正在保存", 存完显示"已自动保存 + 时刻"', async () => {
  const hint = mkEl('#engineDirty');
  const T = loadEngines({ els: { '#engineDirty': hint } });
  seedCard(T);

  T.engSetSaveState('saving');
  assert.match(hint.textContent, /正在保存/);
  assert.strictEqual(hint.hidden, false);

  T.engSetSaveState('saved');
  assert.match(hint.textContent, /已自动保存/);
  assert.match(hint.textContent, /\d{2}:\d{2}:\d{2}/, '要带上时刻, 实际: ' + hint.textContent);
  assert.ok(hint.classList.contains('saved'));
});

test('状态: 失败要看得见 (静默失败等于静默丢数据)', async () => {
  const hint = mkEl('#engineDirty');
  const T = loadEngines({ els: { '#engineDirty': hint } });
  seedCard(T);
  T.engSetSaveState('err', '写盘失败');
  assert.match(hint.textContent, /自动保存失败/);
  assert.match(hint.textContent, /写盘失败/);
  assert.strictEqual(hint.hidden, false, '失败绝不能被隐藏');
  assert.ok(hint.classList.contains('err'));
});

/* ============================================================
 * 5. 离开画板 / 关窗
 * ============================================================ */

test('离开画板前会把待保存的落盘, 而不是弹"回去就没了"', async () => {
  const T = loadEngines();
  seedCard(T);
  T.engTouch();
  assert.strictEqual(T._calls.save, 0, '还在防抖窗口里');

  await T.engBackToGallery();
  assert.strictEqual(T._calls.save, 1, '回卡片墙之前必须先落盘');
  assert.strictEqual(T.engState.card, null, '然后才清空');
});

test('保存失败时**不会无限重试** (否则磁盘满就是每 900ms 空转一次, 永远不停)', async () => {
  let attempts = 0;
  const T = loadEngines({ saveImpl: async () => { attempts += 1; return { ok: false, error: '磁盘满了' }; } });
  seedCard(T);
  T.engTouch();
  await wait(DEBOUNCE + 250);
  assert.strictEqual(attempts, 1, '失败一次就该停, 实际试了 ' + attempts + ' 次');

  // 再等几个防抖周期, 不该有任何新尝试
  await wait(DEBOUNCE * 3);
  assert.strictEqual(attempts, 1, '不该自己重排, 实际试了 ' + attempts + ' 次');
  assert.strictEqual(T.engState.autoSaveState, 'err', '错误要留在界面上');
  assert.strictEqual(T.engState.dirty, true, '还是脏的');
});

test('失败之后, 下一次编辑会再试一次 (不是永久放弃)', async () => {
  let attempts = 0;
  const T = loadEngines({ saveImpl: async () => { attempts += 1; return attempts === 1 ? { ok: false, error: '抖了一下' } : { ok: true, engine: { id: 'e1', nodes: [] }, engines: [] }; } });
  const card = seedCard(T);
  T.engTouch();
  await wait(DEBOUNCE + 250);
  assert.strictEqual(attempts, 1);

  card.name = '再改一下';
  T.engTouch();
  await wait(DEBOUNCE + 250);
  assert.strictEqual(attempts, 2, '用户又改了, 就该再试');
  assert.strictEqual(T.engState.autoSaveState, 'saved', '这次成功了');
  assert.strictEqual(T.engState.dirty, false);
});

test('离开画板时若保存失败, 返回 false 让调用方决定要不要拦', async () => {
  const T = loadEngines({ saveImpl: async () => ({ ok: false, error: '写盘失败' }) });
  seedCard(T);
  T.engTouch();
  const ok = await T.engFlushAutoSave();
  assert.strictEqual(ok, false, '存不上就该返回 false');
  assert.strictEqual(T.engState.dirty, true);
});

test('没有待保存的东西时, 离开画板不产生多余的写盘', async () => {
  const T = loadEngines();
  seedCard(T);
  await T.engBackToGallery();
  assert.strictEqual(T._calls.save, 0, '干净的卡不该被写一次');
});

test('关窗: 有未落盘的改动才走同步保存', () => {
  const T = loadEngines();
  seedCard(T);

  T.engFlushOnUnload();
  assert.strictEqual(T._calls.saveSync, 0, '干净的卡不该在关窗时写盘');

  T.engTouch();
  T.engFlushOnUnload();
  assert.strictEqual(T._calls.saveSync, 1, '有改动就要挡住这一次');
  assert.strictEqual(T.engState.savedRev, T.engState.rev, '挡完要记账, 免得重复写');
});

test('关窗: 同步通道不可用时不抛错 (老版本 preload 也要能正常关)', () => {
  const T = loadEngines();
  seedCard(T);
  T.engTouch();
  // 模拟老 preload: 没有 saveSync
  delete T.engState.__x;
  const realSaveSync = T._calls.saveSync;
  assert.doesNotThrow(() => T.engFlushOnUnload(), '没有同步通道也不能拦着不让关窗');
});

/* ============================================================
 * 6. 拖拽节点也要算改动 (改动前这里漏了)
 * ============================================================ */

test('拖完节点要标改动 —— 位置是卡的内容, 以前漏标所以静默丢失', async () => {
  const canvas = mkEl('#engineCanvas');
  canvas.dataset = {};
  const world = mkEl('#engineWorld');
  const T = loadEngines({ els: { '#engineCanvas': canvas, '#engineWorld': world } });

  seedCard(T, [{ id: 'n1', type: 'input', x: 100, y: 100, title: '入口' }]);
  T.engBindCanvasEvents();

  // 按下节点 -> 移动 -> 松开
  const mouseup = (T._winListeners.mouseup || [])[0];
  const mousemove = (T._winListeners.mousemove || [])[0];
  assert.ok(mouseup && mousemove, '画布的 mousemove / mouseup 应该已经绑上');

  T.engState.drag = { id: 'n1', startX: 0, startY: 0, ox: 100, oy: 100 };
  mousemove({ clientX: 60, clientY: 30 });
  mouseup({});

  assert.strictEqual(T.engState.card.nodes[0].x, 160, '节点该被移到新位置');
  assert.strictEqual(T.engState.card.nodes[0].y, 130);
  assert.strictEqual(T.engState.dirty, true, '拖完必须标成有改动');

  await wait(DEBOUNCE + 250);
  assert.strictEqual(T._calls.save, 1, '而且真的会存下去');
  assert.strictEqual(T._calls.savedCards[0].nodes[0].x, 160, '存的是新坐标');
});

test('只是点一下节点 (没移动) 不该标成有改动', () => {
  const canvas = mkEl('#engineCanvas');
  const T = loadEngines({ els: { '#engineCanvas': canvas, '#engineWorld': mkEl('#engineWorld') } });
  seedCard(T, [{ id: 'n1', type: 'input', x: 100, y: 100, title: '入口' }]);
  T.engBindCanvasEvents();

  const mouseup = (T._winListeners.mouseup || [])[0];
  const mousemove = (T._winListeners.mousemove || [])[0];

  T.engState.drag = { id: 'n1', startX: 0, startY: 0, ox: 100, oy: 100 };
  mousemove({ clientX: 0, clientY: 0 });   // 坐标没变
  mouseup({});

  assert.strictEqual(T.engState.dirty, false, '点一下不该算改动, 否则卡永远是脏的');
});

test('兜底钩子只挂一次 (重复进页面不会累积监听器)', () => {
  const T = loadEngines();
  T.engBindAutoSaveGuards();
  T.engBindAutoSaveGuards();
  T.engBindAutoSaveGuards();
  assert.strictEqual((T._winListeners.blur || []).length, 1, 'blur 只该有一个');
  assert.strictEqual((T._winListeners.beforeunload || []).length, 1, 'beforeunload 只该有一个');
});

test('切走窗口 (blur) 会把待保存的落盘', async () => {
  const T = loadEngines();
  seedCard(T);
  T.engBindAutoSaveGuards();
  T.engTouch();
  const blur = (T._winListeners.blur || [])[0];
  blur();
  await wait(250);
  assert.strictEqual(T._calls.save, 1, 'blur 之后不该还等着防抖');
});
