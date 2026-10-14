'use strict';

/**
 * 对话页选库胶囊的**三态**回归测试。
 *
 * 现场 (用户原话): "点击全部数据库时, 应该全部选中, 本身已被选中再次点击应该
 * 全部都不选中"。
 *
 * 根因: 选库其实有三个状态 (子集 / 全部 / 一个都没选), 而 `state.dbIds` 只能
 * 表达两个 —— 当时把"全选"和"一个都不选"都写成空数组, 于是:
 *   - 「全部数据库」那一行已经是勾上的时候再点一次, 什么都不发生 (它只会再写一次
 *     空数组), 用户以为点坏了;
 *   - 更糟的是点掉**最后一个**勾的时候, 状态会跳回"全部" —— 用户明明取消了它,
 *     界面却全亮了, 看起来像点错了;
 *   - 而"先清空再挑一个库"这个最自然的用法走不通: 从"全部"出发点某个库, 得到的是
 *     "除了它之外的所有库" (从全部里去掉一个), 正好跟意图相反。
 *
 * 修法: 多一个 `state.dbNone` 把第三个状态显式表达出来 (空数组现在有两种含义,
 * 所以判断"是不是全部"一律走 dbPickAll(), 不能直接看 dbIds.length), 并让
 * 「全部数据库」成为真正的总开关。
 *
 * 这个文件加载**真实的 app.js** (vm + DOM 桩, 跟 engines-*.test.js 同一套办法),
 * 把 renderDbPicks / renderConvHead 换成空函数, 于是测的是真代码里的状态迁移,
 * 不是"源码里有没有某段字符串"。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'app.js'), 'utf-8');

/** 一个够用的 DOM 元素桩 */
function el() {
  return {
    value: '', textContent: '', innerHTML: '', title: '', hidden: false,
    dataset: {}, style: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, appendChild() {}, remove() {}, removeChild() {},
    querySelector: () => null, querySelectorAll: () => [],
    setAttribute() {}, getAttribute: () => null,
    scrollTop: 0, scrollHeight: 0, clientHeight: 0, offsetParent: null,
    focus() {}, click() {}, closest: () => null
  };
}

/**
 * 加载 app.js 并交出选库那几个内部符号。
 *
 * app.js 是普通脚本 (没有 module.exports), 所以往同一个作用域里追加一段代码
 * 就能把它们暴露出来 —— 源文件一个字都不用为测试改。
 * 两个 render 函数在测试里换成空函数: 它们只负责画界面, 而这里要验的是状态迁移。
 */
function loadApp() {
  const exposed = `
;renderDbPicks = function () {};
renderConvHead = function () {};
globalThis.__T = {
  state,
  toggleDbPick,
  dbPickNone,
  dbPickAll,
  dbPickLabel,
  selectedDbIds,
  setDbs(list) { pickableDbs = function () { return list; }; }
};`;

  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set,
    document: {
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: () => null,
      createElement: el,
      addEventListener() {},
      body: el(),
      documentElement: el(),
      title: ''
    },
    window: { confirm: () => true, bridge: {}, addEventListener() {} },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }
  };
  sandbox.globalThis = sandbox;
  sandbox.window.document = sandbox.document;

  vm.createContext(sandbox);
  vm.runInContext(SRC + exposed, sandbox, { filename: 'app.js' });
  return sandbox.__T;
}

const DBS = [
  { id: 'db1', name: 'OMS', type: 'mysql', tables: [{ name: 't1', checked: true }] },
  { id: 'db2', name: 'SRM', type: 'mysql', tables: [{ name: 't2', checked: true }] },
  { id: 'db3', name: 'WMS', type: 'mysql', tables: [{ name: 't3', checked: true }] }
];

/**
 * 沙箱里造出来的数组, 原型属于**另一个 realm** —— assert.deepStrictEqual 连原型
 * 一起比, 所以不转换的话会出现 "actual: [] / expected: [] 却断言失败" 这种
 * 看着像见了鬼的输出。比之前统一转到本 realm。
 */
const arr = (v) => Array.from(v || []);

/**
 * 一个会**记住**自己 children / class / 点击处理器的迷你元素。
 *
 * 上面那个 el() 桩什么都不记 (appendChild 是个空函数), 所以只能测到"函数被调用过";
 * 要验"点这一行真的会跑到那套状态迁移上", 就必须让 DOM 桩把子节点和事件留下来。
 */
function miniEl(tag) {
  const e = {
    tagName: tag, id: '', children: [], hidden: false, textContent: '', title: '',
    style: {}, dataset: {},
    _classes: new Set(),
    _handlers: {},
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); },
    addEventListener(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
    setAttribute() {}, getAttribute: () => null,
    querySelector: () => null, querySelectorAll: () => [],
    click() { for (const fn of (this._handlers.click || [])) fn({ stopPropagation() {} }); },
    focus() {}, remove() {}, closest: () => null
  };
  e.classList = {
    add: (c) => e._classes.add(c),
    remove: (c) => e._classes.delete(c),
    contains: (c) => e._classes.has(c),
    toggle: (c, on) => {
      if (on === undefined) { if (e._classes.has(c)) e._classes.delete(c); else e._classes.add(c); }
      else if (on) e._classes.add(c);
      else e._classes.delete(c);
    }
  };
  Object.defineProperty(e, 'className', {
    get: () => [...e._classes].join(' '),
    set: (v) => { e._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  });
  Object.defineProperty(e, 'innerHTML', { get: () => '', set: () => { e.children = []; } });
  return e;
}

/**
 * 带一层"够用的 DOM 桩"加载 app.js, 这次**保留真实的 renderDbPicks**。
 *
 * 于是测的是接线: 菜单里那一行到底连到哪个动作上。逻辑本身由上面那组直接调函数的
 * 测试负责 —— 两组缺一不可 (逻辑对但接错线, 用户点下去照样是坏的)。
 */
function loadAppWithMenu(list = DBS) {
  const exposed = `
;renderConvHead = function () {};
pickableDbs = function () { return __DBS; };
globalThis.__T = {
  state, renderDbPicks, dbPickNone, dbPickAll, dbPickLabel,
  setDbs(l) { __DBS = l; }
};`;

  const menus = {};
  const picks = {};
  for (const id of ['dbPick', 'dbPickHead']) {
    const m = miniEl('div');
    const p = miniEl('div');
    p.id = id;
    p.querySelector = (sel) => (sel === '.pick-menu' ? m : null);
    menus[id] = m;
    picks[id] = p;
  }

  const empty = () => miniEl('span');
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set,
    __DBS: list,
    document: {
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: (id) => picks[id] || null,
      createElement: (tag) => miniEl(tag || 'div'),
      addEventListener() {},
      body: miniEl('body'),
      documentElement: miniEl('html'),
      title: ''
    },
    window: { confirm: () => true, bridge: {}, addEventListener() {} },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }
  };
  sandbox.globalThis = sandbox;
  sandbox.window.document = sandbox.document;

  vm.createContext(sandbox);
  vm.runInContext(SRC + exposed, sandbox, { filename: 'app.js' });

  const T = sandbox.__T;
  T.menu = menus.dbPick;                 // 菜单本体
  T.pick = picks.dbPick;                 // 胶囊本体 (看它有没有被标成"未选")
  T.rows = () => T.menu.children.filter((c) => c.tagName === 'button');
  T.master = () => T.rows()[0];          // 第一行永远是「全部数据库」
  T.rowOf = (i) => T.rows()[i + 1];      // 第 i 个库 (分隔线不是 button, 所以对得上)
  return T;
}

const cls = (e) => ' ' + e.className + ' ';

/** 新起一个"全部选中"的初始状态 (跟 state 的默认值一致) */
function fresh(T, list = DBS) {
  T.setDbs(list);
  T.state.dbIds = [];
  T.state.dbNone = false;
  return T;
}

/* ============================================================
 * 三个状态各自的含义
 * ============================================================ */

test('默认是"全部": 空数组 + dbNone=false, 胶囊写「全部数据库」', () => {
  const T = fresh(loadApp());
  assert.strictEqual(T.dbPickAll(), true, '默认是全部');
  assert.strictEqual(T.dbPickNone(), false, '默认不是"一个都没选"');
  assert.strictEqual(T.dbPickLabel(), '全部数据库');
});

test('「全部数据库」再点一次 -> 一个都不选中', () => {
  const T = fresh(loadApp());
  // 菜单里那一行的动作: 已经是全部就全取消 (见 fillDbMenu)
  T.state.dbIds = [];
  T.state.dbNone = true;
  assert.strictEqual(T.dbPickNone(), true, '进入"一个都没选"');
  assert.strictEqual(T.dbPickAll(), false, '"一个都没选"不是全部');
  assert.strictEqual(T.dbPickLabel(), '未选数据库', '胶囊必须跟"全部"区分开');
  assert.deepStrictEqual(arr(T.selectedDbIds()), [], '一个库都不生效');
});

test('「全部数据库」在非全选状态下点 -> 全选', () => {
  const T = fresh(loadApp());
  T.state.dbIds = ['db2'];            // 只选了 SRM
  T.state.dbNone = false;
  // 菜单里那一行的动作: 不是全部就写回"全部"
  T.state.dbIds = [];
  T.state.dbNone = false;
  assert.strictEqual(T.dbPickAll(), true);
  assert.strictEqual(T.dbPickLabel(), '全部数据库');
});

/* ============================================================
 * 逐个勾选时的迁移 (以前错在这里)
 * ============================================================ */

test('从"全部"点掉一个库 -> 变成"除了它"的子集, 不是全取消', () => {
  const T = fresh(loadApp());
  T.toggleDbPick('db2');
  assert.deepStrictEqual(arr(T.state.dbIds), ['db1', 'db3'], '剩下的两个');
  assert.strictEqual(T.state.dbNone, false);
  assert.strictEqual(T.dbPickLabel(), '已选 2 个库');
});

test('点掉最后一个勾 -> "一个都不选", 绝不跳回全选 (这次报的就是这个)', () => {
  const T = fresh(loadApp());
  T.toggleDbPick('db1');
  assert.deepStrictEqual(arr(T.state.dbIds), ['db2', 'db3']);
  T.toggleDbPick('db2');
  assert.deepStrictEqual(arr(T.state.dbIds), ['db3']);
  T.toggleDbPick('db3');
  assert.strictEqual(T.dbPickNone(), true, '取消最后一个勾之后就该是"一个都没选"');
  assert.deepStrictEqual(arr(T.state.dbIds), [], '内部仍然是空数组');
  assert.strictEqual(T.dbPickAll(), false, '但**不能**被当成全部 —— 那正是以前的 bug');
  assert.strictEqual(T.dbPickLabel(), '未选数据库');
});

test('"一个都不选"之后点一个库 -> 只选它 (以前会变成"除了它全选")', () => {
  const T = fresh(loadApp());
  T.state.dbIds = [];
  T.state.dbNone = true;
  T.toggleDbPick('db2');
  assert.deepStrictEqual(arr(T.state.dbIds), ['db2'], '应该是只选中 SRM');
  assert.strictEqual(T.state.dbNone, false);
  assert.strictEqual(T.dbPickLabel(), 'SRM');
});

test('从子集重新勾满 -> 回到"全部" (全选等于不限制, 胶囊不该写"已选 3 个库")', () => {
  const T = fresh(loadApp());
  T.state.dbIds = ['db1', 'db2'];
  T.state.dbNone = false;
  T.toggleDbPick('db3');
  assert.deepStrictEqual(arr(T.state.dbIds), [], '勾满就收敛成"不限制"');
  assert.strictEqual(T.state.dbNone, false);
  assert.strictEqual(T.dbPickLabel(), '全部数据库');
});

/* ============================================================
 * 边界: 没勾过表的库 / 落盘语义
 * ============================================================ */

test('一个可选的库都没有时, 提示优先于"未选数据库"', () => {
  const T = fresh(loadApp(), []);
  T.state.dbNone = true;
  assert.strictEqual(T.dbPickLabel(), '还没有勾选数据表', '这条提示更有用, 不能被覆盖');
});

test('"全部"发给后端的仍然是空数组 (后端契约没变)', () => {
  const T = fresh(loadApp());
  assert.deepStrictEqual(arr(T.selectedDbIds()), [], '空数组 = 不限制, lib/db-router.js 就是这么读的');
  // 从"全部"去掉一个 = 剩下两个。故意钉住这条: 去掉一个跟"只选一个"是两件事,
  // 三态改动**不能**把这个语义碰坏 (想去掉全部再挑一个, 才有「再点一次全取消」)。
  T.toggleDbPick('db1');
  assert.deepStrictEqual(arr(T.selectedDbIds()), ['db2', 'db3']);
});

test('落盘里指向已删掉的库的 id 会被滤掉 (这条一直是这样, 别被三态改坏)', () => {
  const T = fresh(loadApp());
  T.state.dbIds = ['db1', 'db_gone'];
  assert.deepStrictEqual(arr(T.selectedDbIds()), ['db1']);
  assert.strictEqual(T.dbPickLabel(), 'OMS');
});

test('落盘里把每个库都列全了 -> 仍然算"全部", 不是"半勾"', () => {
  const T = fresh(loadApp());
  T.state.dbIds = ['db1', 'db2', 'db3'];   // 旧版本或手工改过的落盘可能长这样
  assert.strictEqual(T.dbPickAll(), true, '全列出来跟空数组是同一个意思');
  assert.strictEqual(T.dbPickLabel(), '全部数据库');
  assert.strictEqual(T.dbPickNone(), false);
});

/* ============================================================
 * 接线: 点菜单里那一行, 真的会跑到上面这套状态迁移上
 * (逻辑对但接错线, 用户点下去照样是坏的, 所以这组不能省)
 * ============================================================ */

test('点「全部数据库」两次 = 全取消, 再点一次 = 全选', () => {
  const T = loadAppWithMenu();
  T.renderDbPicks();
  assert.ok(cls(T.master()).includes(' on '), '默认全选, 总开关该是勾上的');

  T.master().click();
  assert.strictEqual(T.dbPickNone(), true, '已经全选时再点一次 = 全部取消');
  assert.ok(T.pick.classList.contains('is-none'), '胶囊要标出"未选数据库", 否则用户看不出发生了什么');

  T.renderDbPicks();
  assert.strictEqual(cls(T.master()).includes(' on '), false, '全取消之后总开关不该还是勾上的');
  assert.strictEqual(cls(T.master()).includes(' half '), false, '也不该是半勾');

  T.master().click();
  assert.strictEqual(T.dbPickAll(), true, '再点一次回到全选');
  assert.strictEqual(T.dbPickNone(), false);
});

test('点某个库 = 从"全部"里去掉它, 并且总开关变成半勾', () => {
  const T = loadAppWithMenu();
  T.renderDbPicks();
  T.rowOf(1).click();                              // SRM
  assert.deepStrictEqual(arr(T.state.dbIds), ['db1', 'db3']);
  T.renderDbPicks();
  assert.ok(cls(T.master()).includes(' half '), '部分选中时总开关是半勾 —— 不是"没勾"');
});

test('"未选"状态下点某个库 = 只选它 (不是"除了它全选")', () => {
  const T = loadAppWithMenu();
  T.state.dbIds = [];
  T.state.dbNone = true;
  T.renderDbPicks();
  assert.strictEqual(cls(T.master()).includes(' on '), false, '未选时总开关是空的');

  T.rowOf(1).click();                              // SRM
  assert.deepStrictEqual(arr(T.state.dbIds), ['db2'], '应该只选中 SRM');
});
