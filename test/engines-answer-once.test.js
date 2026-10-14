'use strict';

/**
 * AI 面板里"答一次显示两遍"的回归测试。
 *
 * 现场: 搭建 Agent 弹一张选择题问用户, 用户答完点确认, 面板里同一个回答
 * 出现了**两遍** (用户的原话: "它找我确认之后, 页面显示发了两次")。
 *
 * 根因: 两条路都往日志里推了同一句话 ——
 *   engAnswerChoice 里  engAiPush('user', answerText)
 *   engAiSendText 里    engAiPush('user', text)          <- 它自己本来就会推
 *
 * 为什么不能只把前者删掉: engAiSendText **可能拒绝发送** (上一条还在处理 /
 * 画板上没有卡 / 没配可访问的表)。拒绝时它不会推, 那时用户答的话就在面板里
 * 凭空消失了。所以正确的形状是"发成功就不补, 失败才补" —— 这句话
 * **一定看得见, 且只出现一次**。
 *
 * 这个文件直接加载真实的 engines.js (vm + DOM 桩), 所以测的是真代码路径,
 * 不是"源码里有没有某个字符串"。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'engines.js'), 'utf-8');

/**
 * 把 engines.js 装进一个沙箱, 并交出我们要用的那几个内部符号。
 *
 * engines.js 是普通脚本 (没有 module.exports), 顶层都是函数声明, 所以
 * 在同一个作用域里追加一段代码就能把它们暴露出来 —— 不需要改动源文件。
 */
function loadEngines() {
  const exposed = `
;globalThis.__T = {
  engState,
  engAnswerChoice,
  engAiPush,
  setSend(fn) { engAiSendText = fn; },
  setRender(fn) { engAiRenderLog = fn; },
  setBusy(v) { engState.aiChatBusy = v; }
};`;

  const el = () => ({
    value: '', textContent: '', innerHTML: '',
    dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, appendChild() {}, remove() {}, querySelector: () => null,
    querySelectorAll: () => [], setAttribute() {}, getAttribute: () => null,
    scrollTop: 0, scrollHeight: 0, clientHeight: 0, focus() {}, click() {}, removeChild() {}
  });

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
      documentElement: el()
    },
    window: { confirm: () => true, bridge: {}, addEventListener() {} },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }
  };
  sandbox.globalThis = sandbox;
  sandbox.window.document = sandbox.document;

  vm.createContext(sandbox);
  vm.runInContext(SRC + exposed, sandbox, { filename: 'engines.js' });
  return sandbox.__T;
}

/** 造一个"已经弹出来、还没答"的选择题 */
function seedChoice(T, question, options) {
  T.engState.aiLog = [];
  T.engState.aiLog.push({
    role: 'choice', text: question, answered: false, picked: [],
    choice: { options: options.map((o) => ({ value: o.v, label: o.l })), allowText: true }
  });
  return 0; // 这张卡在日志里的下标
}

const userMsgs = (T) => T.engState.aiLog.filter((m) => m.role === 'user').map((m) => m.text);

/* ============================================================
 * 1. 核心回归: 答一次, 只能出现一条用户消息
 * ============================================================ */

test('答完选择题: 回答只出现一次 (修复前是两次)', async () => {
  const T = loadEngines();
  T.setRender(() => {}); // 渲染要真 DOM, 这里不测渲染

  // engAiSendText 的真实行为: 推一条 user 消息。用桩模拟这个关键副作用。
  let sent = [];
  T.setSend(async (text) => {
    T.engAiPush('user', text);
    sent.push(text);
    return true;
  });

  const idx = seedChoice(T, '红字确认单编号是哪个字段?', [{ v: 'cp', l: 'cp' }, { v: 'bill_no', l: 'bill_no' }]);
  await T.engAnswerChoice(idx, ['bill_no'], '红字单号是 no');

  assert.strictEqual(sent.length, 1, '应该只发一次');
  const msgs = userMsgs(T);
  assert.deepStrictEqual(msgs, ['bill_no、红字单号是 no'],
    '回答在面板里必须**只出现一次**, 实际: ' + JSON.stringify(msgs));
});

test('答完选择题: 选项标签拼进回答, 自填内容也带上', async () => {
  const T = loadEngines();
  T.setRender(() => {});
  T.setSend(async (text) => { T.engAiPush('user', text); return true; });

  const idx = seedChoice(T, 'q', [{ v: 'a', l: '选项甲' }, { v: 'b', l: '选项乙' }]);
  await T.engAnswerChoice(idx, ['a', 'b'], '另外补充一句');

  assert.deepStrictEqual(userMsgs(T), ['选项甲、选项乙、另外补充一句']);
});

/* ============================================================
 * 2. 发送被拒时不能把用户的话弄丢
 *
 * 这是"只把重复的那行删掉"会引入的 bug —— 所以专门测。
 * ============================================================ */

test('发送被拒 (上一条还在处理): 回答仍然要出现在面板里', async () => {
  const T = loadEngines();
  T.setRender(() => {});
  // 模拟 engAiSendText 被 busy 闸门挡住: 什么都没推就返回 false
  T.setSend(async () => false);

  const idx = seedChoice(T, 'q', [{ v: 'bill_no', l: 'bill_no' }]);
  await T.engAnswerChoice(idx, ['bill_no'], '');

  const msgs = userMsgs(T);
  assert.deepStrictEqual(msgs, ['bill_no'],
    '发不出去也得补记一条, 否则用户答过的话在面板里凭空消失');
});

test('发送被拒时也只补一条, 不能补成两条', async () => {
  const T = loadEngines();
  T.setRender(() => {});
  T.setSend(async () => false);
  const idx = seedChoice(T, 'q', [{ v: 'x', l: 'x' }]);
  await T.engAnswerChoice(idx, ['x'], '');
  assert.strictEqual(userMsgs(T).length, 1);
});

/* ============================================================
 * 3. 幂等与状态
 * ============================================================ */

test('同一张选择题点两次确认: 第二次不该再发一遍', async () => {
  const T = loadEngines();
  T.setRender(() => {});
  let calls = 0;
  T.setSend(async (text) => { calls += 1; T.engAiPush('user', text); return true; });

  const idx = seedChoice(T, 'q', [{ v: 'a', l: 'a' }]);
  await T.engAnswerChoice(idx, ['a'], '');
  await T.engAnswerChoice(idx, ['a'], ''); // 重复点击 / 双击

  assert.strictEqual(calls, 1, '答过的题不该再发一次');
  assert.strictEqual(userMsgs(T).length, 1);
});

test('答完的选择题被标成已答, 并记下答案原文', async () => {
  const T = loadEngines();
  T.setRender(() => {});
  T.setSend(async (text) => { T.engAiPush('user', text); return true; });

  const idx = seedChoice(T, 'q', [{ v: 'bill_no', l: 'bill_no' }]);
  await T.engAnswerChoice(idx, ['bill_no'], '红字单号是 no');

  const m = T.engState.aiLog[idx];
  assert.strictEqual(m.answered, true, '要标成已答 —— 否则按钮还能再点');
  assert.deepStrictEqual(m.picked, ['bill_no']);
  assert.strictEqual(m.answerText, 'bill_no、红字单号是 no');
});

test('日志里没有那张选择题时: 不抛异常, 也不发东西', async () => {
  const T = loadEngines();
  T.setRender(() => {});
  let calls = 0;
  T.setSend(async () => { calls += 1; return true; });
  T.engState.aiLog = [];

  await T.engAnswerChoice(99, ['a'], '');
  assert.strictEqual(calls, 0);
});
