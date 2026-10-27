'use strict';

// 认模型漏出来的工具调用方言 (DSML) 与工具名的各种写法。
// 这两件事原来只有分析 Agent 有 (见 lib/agent.js 的 _resolveCall), 另外两个
// Agent 缺了 —— 换个网关就开始"动作无法解析"。放进运行时, 三个都受益。
const { parseDSML, normalizeToolName } = require('./actions');

/**
 * 统一的 Agent 运行时。
 *
 * ## 它替掉的是什么
 *
 * 改之前, "模型驱动的一步" 这件事被写了三遍:
 *   lib/agent.js:870        (分析, 16-60 步)
 *   lib/engine-ai.js:1468   (搭建, 40 步)
 *   lib/engine-tester.js:901(诊断, 24 步)
 * 三份都是 "拿工具清单调模型 -> 解析动作 -> 执行 -> 回灌", 各自抄了一份
 * 原生/文本两套协议的对接代码。抄漏的地方就永久缺失 —— 比如 MCP 只接进了分析
 * Agent, 另外两个看不到外部工具; 格式飘了自我纠正也只有分析 Agent 有。
 *
 * ## 它管什么, 不管什么
 *
 * 管: 控制流 (下一步做什么由模型决定)、协议对接、并发执行、预算、上下文压缩、取消。
 * 不管: 有哪些工具 (那是 ToolRegistry 的事)、提示词写什么 (调用方的事)。
 *
 * ## 三件让它"能放心交给模型"的事
 *
 * 1. **预算要可见**。快用完时明确告诉模型"你还剩 N 步, 该收尾了"。
 *    不让模型知道预算就让它自己决定何时停, 它只会一路做到底然后被硬截断 ——
 *    截断时它交出来的东西是不完整的, 而它自己不知道。这是"让模型决定"能成立的前提。
 * 2. **一轮里所有动作都执行**。以前只执行第一个, 其余回灌"已跳过" ——
 *    模型一次想查两张表是合理的, 硬性一次一个既慢又逼它绕路。
 *    只读工具并发跑, 有副作用/跨进程的串行。
 * 3. **失败是信息, 不是终止**。工具报错回灌给模型让它换个方式, 不炸整轮。
 *
 * ## 上下文压缩
 *
 * 工具结果会越攒越多 (一次 describe_tables 就是几千字), 不做处理迟早撑爆窗口。
 * 这里做**按需压缩**: 估算字符数超过阈值时, 把**旧的**工具结果替换成摘要存根,
 * 最近几轮原样保留。保留"发生过什么"、丢掉"具体每个字" ——
 * 这正是 harness 的标准做法, 比"切掉最早 N 轮"安全: 切轮次会连带丢掉
 * 用户的原始需求, 而摘要存根不会。
 */

const { ToolRegistry } = require('./tools');

// 估算用的字符阈值。中文一个字大约 1 token 上下, 这里按字符数粗算,
// 宁可早压缩: 压缩只是丢细节, 撑爆窗口是整轮失败。
//
// 注意: 自从有了按真实 token 的触发 (见 COMPACT_SAFETY / tokenBudget), 这个字符
// 阈值退居**兜底**: 网关没回 usage (拿不到真实 token 数) 时, 或者消息字符数先撞线时, 它仍然管用。
const DEFAULT_MAX_CHARS = 120000;
// 真实 token 占用的安全阈值: 占到模型上下文窗口的这个比例就开始折。
// 留的余量要塞得下"下一次输出"和估算误差 —— 压得刚好等于窗口 = 下一轮必溢出。
const COMPACT_SAFETY = 0.8;
// token 预算的下限。contextLimit 没配 (为 0) 时不算 token 预算, 走上面的字符兜底。
const MIN_TOKEN_BUDGET = 2000;
// 最近几轮的工具结果不压缩 —— 正在用的细节不能动
const KEEP_RECENT_RESULTS = 6;
// 存根留多少字: 够模型认出"这里发生过什么"就行
const STUB_CHARS = 240;
// 多长的 assistant 正文才值得折。
//
// 为什么连正文也要折:
//   原来只折 role:'tool'。可长任务里模型自己写的过程叙述一样占地 ——
//   "我先看一下表结构""这一步的结果说明…" 这种一段就好几百字, 而且它
//   恰恰是**信息密度最低**的那部分 (结论都在工具结果和最后的 finish 里)。
//   只折工具结果的话, 一个跑了很多轮的任务仍然能把预算吃满。
//
// 门槛给得高 (600) 是为了不动短回复: 短回复往往就是结论本身, 折了得不偿失。
const ASSISTANT_FOLD_MIN = 600;
// 进度账里每一条留多少字。
//
// 试过提到 200 (想让一条存根带上完整结论), 但没用 —— 存根本身只留 STUB_CHARS
// 个字, 账再宽也只能多抄一点存根标记 ("… (这条结果过长, 已折叠, 共 N 字。"),
// 拿不到更多真内容。真要装下完整结论得同时放宽 STUB_CHARS, 而那会让每条被折的
// 消息都变长, 是另一笔账。所以这里维持原值: 本次修的是"丢哪一条", 不是"每条多长"。
const LEDGER_ITEM_CHARS = 110;
// 账整体的上限 —— 账是为了省地方, 不能自己变成新的负担
const LEDGER_MAX_CHARS = 2600;
// 折叠存根里的标记。账靠它把"哪些消息已经折过"认出来 ——
// 所以账是**每次从现存存根反推**的, 不是攒出来的: 攒的话折叠多轮之后
// 会重复记同一件事, 而反推天然幂等。
const FOLDED_MARK = '… (这条结果过长, 已折叠';
// 账的开头。
//
// ## 账放哪儿: 系统提示, 不是消息数组
//
// 一开始我是把它追加到**第一条 user 消息**末尾的 —— 那是现成的做法 (预算提醒
// 就是这么干的), 而且不动消息条数、不动角色交替。但那条路有个真实的代价:
// 它把"用户说的话一个字都不能动"这条不变量破了。而这条不变量不是洁癖 ——
// 用户的原话是**需求**, 后面所有判断都以它为准; 一旦它被掺进系统文本,
// 就再没有一处能干净地回答"他最初到底要什么"。
//
// 所以改成放进系统提示。系统提示本来就是每轮重建的 (见 AgentLoop.run 里
// `this.systemText()`), 账搭它的车完全不碰消息数组: 不变量保住了, 也不存在
// "往消息中间插一条会不会破坏 assistant/tool 配对"的风险。
const LEDGER_HEAD = '[系统] 本次任务早期的一些步骤已经折叠掉了 (细节省略, 只留"发生过什么", 免得重复劳动):';
// 连续多少轮"动作无效"就放弃。
//
// 这个上限是必须的, 不是保守: 纠正路径**不消耗步数** (模型没做成任何事,
// 不该扣预算), 所以一个持续编造工具名的模型会让循环永远转下去 ——
// 不调模型了, 但内存一路涨, 最后 OOM 把整个应用拖死。实测踩到过。
// 给 3 次机会自纠 (和 lib/agent.js 里的 parseFailures > 2 一致), 之后如实报错。
const MAX_CONSECUTIVE_RETRIES = 3;

/** 把一条工具结果压成存根 */
function stubOf(text, handle) {
  const s = String(text == null ? '' : text);
  if (s.length <= STUB_CHARS) return s;
  const head = s.slice(0, STUB_CHARS);
  // 存根尾上带一个取回编号。没有它, 折掉的东西就是**真的没了** ——
  // 模型只能重新调一遍工具再查一次库, 那正是"重复劳动"最贵的形态:
  // 实测一个会话因为旧结果被折掉 22 条, 又把已经验证过的关联关系重验了一遍。
  const tail = handle
    ? `${FOLDED_MARK}, 共 ${s.length} 字。**全文还在, 用 recall("${handle}") 取回**, 不要重新查库)`
    : `${FOLDED_MARK}, 共 ${s.length} 字。需要细节请重新调用这个工具)`;
  return `${head}\n${tail}`;
}

/** 从存根的尾标里读回取回编号 (老快照里没有, 返回 null) */
function handleOf(m) {
  const s = String((m && m.content) || '');
  const i = s.indexOf(FOLDED_MARK);
  if (i === -1) return null;
  const mm = s.slice(i).match(/recall\("([^"]+)"\)/);
  return mm ? mm[1] : null;
}

/**
 * 折叠仓库: 装被折掉的长结果, 给每一条发一个短编号。
 *
 * 为什么要它:
 *   折叠本身是对的 (上下文装不下), 但"折掉"以前等于"删掉"。代价不是"模型少看了一点细节",
 *   而是**模型会重新去查一遍** —— 实测一个搭建会话折叠了 22 条旧结果, 之后又把已经
 *   验证过的关联关系从头验了一遍, 每次验证都是一次真跑 (几十秒到几分钟)。
 *   留一个编号让它能取回来, 比让它重跑便宜几个数量级。
 *
 * 有上限并且按插入顺序淘汰: 这是"临时记事本"不是"数据库"。上限之内取不到就返回 null,
 * 调用方要如实说"太早的记录已经清掉了", 不能假装还在。
 */
function createFoldStore(maxEntries = 40) {
  const cap = Math.max(1, maxEntries);
  const map = new Map();
  let seq = 0;
  return {
    put(text) {
      const s = String(text == null ? '' : text);
      seq += 1;
      const handle = 'h' + seq;
      map.set(handle, s);
      // 超了就丢最老的。丢的时候不报错 —— 它只是个缓存。
      while (map.size > cap) {
        const oldest = map.keys().next().value;
        map.delete(oldest);
      }
      return handle;
    },
    get(handle) {
      return map.has(handle) ? map.get(handle) : null;
    },
    get size() { return map.size; },
    clear() { map.clear(); }
  };
}

/** 这条消息是不是已经被折过的存根 */
function isFolded(m) {
  return String((m && m.content) || '').indexOf(FOLDED_MARK) !== -1;
}

/**
 * 从现存存根反推一份"进度账"。
 *
 * 为什么要账:
 *   折叠的代价是"忘了做过什么", 于是模型会**重复劳动** —— 再查一遍同一张表,
 *   再问一遍同一个问题。账把"发生过什么"留下来, 丢掉的只是明细。
 *
 * 为什么反推而不是攒:
 *   攒的话折叠两轮就会把同一件事记两遍, 而且中间被折掉的消息再也追不回来。
 *   存根本身就是账的来源, 从它读永远和当前状态一致。
 */
function ledgerLines(messages) {
  const lines = [];
  for (const m of messages) {
    if (!m || !isFolded(m)) continue;
    const head = String(m.content).split(FOLDED_MARK)[0].replace(/\s+/g, ' ').trim();
    if (!head) continue;
    const what = m.role === 'assistant' ? '过程说明' : '取数结果';
    lines.push('- ' + what + ': ' + head.slice(0, LEDGER_ITEM_CHARS));
  }
  return lines;
}

/**
 * 把账拼成一段文本。超长时丢**中间**的, 保住头部和尾部。
 *
 * ## 为什么不是丢最旧的
 *
 * 原来是从最旧的开始丢, 理由是"越早的事越不重要"。**在长任务里这个假设是反的。**
 *
 * 一个 40 步的搭建任务, 最早期做的事恰恰是确定目标表、摸清主键、搞清楚哪两列
 * 能关联 —— 那些是**结论**。中间那些是"试了 A 不行、试了 B 也不行"的**过程**。
 * 丢最旧的等于把结论丢了、留着过程, 而模型接下来正需要结论。
 *
 * 实测症状 (2026-09-21): 用户报"它有时候会忘记上下文"。追下去是历史裁剪
 * (见 lib/context.js 的 fromHistory, 只取最近 N 轮) 和这里丢最旧的两件事叠起来,
 * 让"最初定下了什么"活不过任务的早期阶段。
 *
 * 所以现在是: 先丢正中间那条, 再丢它两侧, 一路向两端扩散 ——
 * 头和尾是最后才动的。尾部保的是"最近在干什么", 头部保的是"最初定下了什么"。
 */
function ledgerText(lines) {
  if (!lines.length) return '';
  const kept = lines.slice();
  const render = (dropped) => LEDGER_HEAD + '\n' + kept.join('\n')
    + (dropped ? '\n… (中间 ' + dropped + ' 条较早的步骤已省略)' : '');
  let text = render(0);
  if (text.length <= LEDGER_MAX_CHARS) return text;

  // 两端各留一条 (最初 / 最近), 只从中间那段里丢。
  let head = 0;
  let tail = kept.length - 1;
  let dropped = 0;
  while (text.length > LEDGER_MAX_CHARS && tail - head > 1) {
    // 交替从中间段的靠前 / 靠后各丢一条, 让"丢掉的"始终是连续的一段中间步骤,
    // 而不是偏向某一端 —— 偏向哪一端都会让某一类信息先消失。
    const at = dropped % 2 === 0 ? head + 1 : tail - 1;
    kept.splice(at, 1);
    tail -= 1;
    dropped += 1;
    text = render(dropped);
  }
  return text;
}

/** 把之前挂在锚点上的账摘掉 (老快照里可能带着它, 见 LEDGER_HEAD 的注释) */
function stripLedger(content) {
  const s = String(content == null ? '' : content);
  const i = s.indexOf(LEDGER_HEAD);
  return i === -1 ? s : s.slice(0, i).replace(/\s+$/, '');
}

/**
 * 上下文压缩 (纯函数, 好测)。
 *
 * 折两类东西: role:'tool' 的结果、以及**过长的 assistant 正文**。
 * 不动 system、不动用户说的话 —— 那些是"需求", 丢了模型就不知道要干什么了。
 *
 * keepRecent 是**偏好**而不是硬线: 只保护最近几条时如果还是超预算, 就把保护的
 * 也折掉 (从最旧的开始)。不然会出现"工具结果一共只有 3 条、阈值设 6,
 * 于是永远折不动、上下文一路涨到撑爆窗口"这种事 —— 保护细节是为了够用,
 * 不是为了不压缩。
 *
 * 折出来的"进度账"**不写进消息数组**, 而是从返回值交给调用方放进系统提示
 * (为什么这么设计见 LEDGER_HEAD 的注释)。
 *
 * @returns {{ messages, compacted: number, chars: number, savedChars: number, ledger: string }}
 *   ledger 是给系统提示用的账文本, 没折东西时是空串
 */
function compactMessages(messages, opts = {}) {
  const maxChars = opts.maxChars || DEFAULT_MAX_CHARS;
  const keepRecent = opts.keepRecent == null ? KEEP_RECENT_RESULTS : opts.keepRecent;
  // 折掉的内容存这儿, 存根上留一个编号指回来 (没传就是老行为: 折了就真没了)。
  const store = opts.foldStore || null;

  const size = (m) => String((m && m.content) || '').length;
  const total = (list) => list.reduce((n, m) => n + size(m), 0);

  // 账是**从现存存根反推**的, 所以不管这次折没折都要算。
  //
  // 只在"这次折了"才算的话会漏一种情况: 上一轮折过、这一轮没超阈值 ——
  // 于是返回空账。调用方如果"没折就保留旧账", 看着没事; 但任何把这次返回值
  // 当权威的调用方 (比如续轮时新开的 AgentLoop) 就会丢掉账, 接着把同一张表
  // 再查一遍。账的意义就是"别重复劳动", 那它就不能依赖"这次刚好折了东西"。
  const buildLedger = (list) => ledgerText(ledgerLines(list));

  const before = total(messages);
  if (before <= maxChars) {
    return { messages, compacted: 0, chars: before, savedChars: 0, ledger: buildLedger(messages) };
  }

  const out = messages.map((m) => Object.assign({}, m));

  // 可折的: role:'tool'、调用方标进来的下标、以及过长的 assistant 正文。
  // 不可折的: system、user (需求)、已经是存根的。
  const foldable = [];
  for (let i = 0; i < out.length; i++) {
    const m = out[i];
    if (!m || m.role === 'system') continue;
    if (m.role === 'user') continue;                 // 需求, 一律不动
    if (isFolded(m)) continue;                       // 已经是存根了, 没什么可折
    if (m.role === 'tool') foldable.push(i);
    else if (m.role === 'assistant' && size(m) > ASSISTANT_FOLD_MIN) foldable.push(i);
  }
  // 调用方还能把"文本模式下的结果回灌"标进来。
  // 那种消息的 role 是 'user' —— 文本模式要求 assistant/user 交替, 没法用
  // role:'tool' —— 但它跟 role:'tool' 一样是"可以折叠的取数结果", 而且往往
  // 正是最占地方的那部分。光看 role 认不出来, 所以由调用方给下标。
  for (const i of (opts.toolIdx || [])) {
    if (Number.isInteger(i) && i >= 0 && i < out.length && !foldable.includes(i)) foldable.push(i);
  }
  foldable.sort((a, b) => a - b);
  const protect = new Set(foldable.slice(-keepRecent));

  let compacted = 0;
  const fold = (idx) => {
    const m = out[idx];
    const was = size(m);
    if (was <= STUB_CHARS) return false;
    // 只换 content, 别的字段 (assistant 的 tool_calls) 原样留着 ——
    // 把 tool_calls 弄丢会让原生模式的协议当场断掉。
    const handle = store && typeof store.put === 'function' ? store.put(m.content) : null;
    m.content = stubOf(m.content, handle);
    compacted += 1;
    return true;
  };

  // 第一遍: 只折"旧的"; 第二遍: 连保护的一起折 (最旧的优先)
  for (const skipProtected of [true, false]) {
    for (const i of foldable) {
      if (skipProtected && protect.has(i)) continue;
      if (total(out) <= maxChars) break;
      fold(i);
    }
    if (total(out) <= maxChars) break;
  }

  const ledger = buildLedger(out);
  const after = total(out);
  return { messages: out, compacted, chars: after, savedChars: Math.max(0, before - after), ledger };
}

class AgentLoop {
  /**
   * @param llm       LLMClient
   * @param tools     ToolRegistry
   * @param system    系统提示词 (字符串, 或 () => string 每轮重建)
   * @param messages  初始消息 (会被复制, 不改调用方的数组)
   * @param budget    { maxSteps, maxMs, maxChars }
   * @param emit      事件回调
   * @param cancel    { v, abort } 取消信号
   * @param stopWhen  (name, args, result) => boolean
   *                  "终结工具": 调了它就停 (比如诊断 Agent 的 report)。
   *                  没有这个, report 之后模型还得再空转一轮, 而那一轮它可能
   *                  又去查东西 —— 已经交卷了还在改答案。
   * @param ctx       传给工具处理函数的上下文
   */
  constructor({ llm, tools, system, messages, budget, emit, cancel, stopWhen, ctx, ledger, foldStore } = {}) {
    this.llm = llm;
    this.tools = tools instanceof ToolRegistry ? tools : new ToolRegistry();
    this.system = system;
    this.messages = (messages || []).map((m) => Object.assign({}, m));
    // 折叠仓库: 折掉的长结果存在这里面, 存根上留编号, 模型可以用 recall 取回。
    // 不传就是老行为 (折了真没了) —— 测试和别的调用方不必都改。
    this.foldStore = foldStore || null;
    this.budget = Object.assign({ maxSteps: 24, maxMs: 0, maxChars: DEFAULT_MAX_CHARS }, budget || {});
    // 模型上下文窗口 (token)。来自 llm.config.contextLimit; 没配就是 0 —— 那时压缩
    // 退回按字符数估算 (见 tokenBudget 与 run() 里的判定)。
    this.contextLimit = Number(this.llm && this.llm.config && this.llm.config.contextLimit) || 0;
    this.emit = emit || (() => {});
    // 上一轮折出来的账。续轮时由调用方带进来, 不带的话这一轮就不知道
    // 前面折掉过什么 —— 那正是"重复劳动"的来源。
    this.ledgerText = String(ledger || '');
    // token 用量累计。calls 是"模型被调用了几次", 它和 steps 不是一回事:
    // 一次纠正重试会多一次调用但不加一步。
    this.usage = { input: 0, output: 0, calls: 0 };
    // 每一步花在哪。以前只记"整段任务 elapsedMs", 于是用户只看到"它一直在想",
    // 看不到"模型 12 秒 / 一次查数据 82 秒"。实测一个搭建会话 25 分钟没收敛,
    // 事后想复盘都没有数字可用 —— 这三个计数器就是给那件事用的账本。
    this.llmMs = 0;        // 模型往返累计
    this.toolMs = 0;       // 工具执行累计
    this.byTool = Object.create(null);       // 按工具名分: 耗时
    this.byToolCalls = Object.create(null);  // 按工具名分: 次数
    // 最近一次调用的输入 token (= 此刻的上下文占用)。
    // 名字不能叫 this.ctx —— 那已经被构造参数里的上下文对象占了。
    this.ctxTokens = 0;
    // 最近一次模型调用的耗时与用量, 由 _ack 写到 assistant 消息上再落盘。
    // 显式初始化: 新会话里它是 undefined 的话, 挂到消息上会变成 "elapsedMs: null",
    // 而 null 和"没记"在读日志时不好区分。
    this._lastLlmMs = null;
    this._lastUsage = null;
    this.cancel = cancel || null;
    this.stopWhen = typeof stopWhen === 'function' ? stopWhen : null;
    this.ctx = ctx || {};
    this.steps = 0;
    this.retries = 0;
    this.stopReason = '';
    this.finalText = '';
    this.compactions = 0;
    this._t0 = 0;
  }

  isCancelled() {
    return !!(this.cancel && this.cancel.v);
  }

  /** 预算还剩多少 */
  remaining() {
    const stepsLeft = this.budget.maxSteps - this.steps;
    const msLeft = this.budget.maxMs ? this.budget.maxMs - (Date.now() - this._t0) : Infinity;
    return { stepsLeft, msLeft };
  }

  /**
   * 上下文 token 预算: 实际占用 (ctxTokens) 超过它就该折了。
   *
   * 返回 0 表示这个模型没配 contextLimit —— 调用方据此退回字符估算。
   * 以前只有字符阈值 (DEFAULT_MAX_CHARS), 它对中文约等于十几万 token, 对小窗口
   * 模型是**压得太晚**(会溢出), 对英文/代码又太早。真实 token 数其实每次都在
   * usage.input 里 (ctxTokens), 这个预算就是把它用起来。
   */
  tokenBudget() {
    if (!this.contextLimit) return 0;
    const out = Number(this.llm && this.llm.config && this.llm.config.maxTokens) || 0;
    // 预留一次输出; 但别让预留把预算吃掉太多 (小窗口模型上 maxTokens 可能跟窗口一个量级)
    const reserve = Math.min(out, Math.floor(this.contextLimit * 0.25));
    return Math.max(MIN_TOKEN_BUDGET, Math.floor(this.contextLimit * COMPACT_SAFETY) - reserve);
  }

  systemText() {
    return typeof this.system === 'function' ? this.system() : String(this.system || '');
  }

  /**
   * 系统提示 + 进度账。
   *
   * 账必须每轮**现拼**: 系统提示是每轮重建的 (它依赖运行期状态), 账也一样 ——
   * 折叠之后内容会变, 拼一次存下来就会给出过期的账。
   */
  systemWithLedger() {
    const base = this.systemText();
    return this.ledgerText ? base + '\n\n' + this.ledgerText : base;
  }

  /**
   * 跑起来。
   *
   * 返回值里的 stopReason 是**诚实的停止原因**, 调用方必须按它分支 ——
   * 不能把 budget 用尽当成正常收尾 (那正是之前那个"步数用尽却报改完了"的 bug)。
   *
   * @returns {{ ok, stopReason, finalText, steps, messages, compactions, error? }}
   */
  async run() {
    this._t0 = Date.now();
    const tools = this.tools.schemas();

    for (;;) {
      if (this.isCancelled()) {
        this.stopReason = 'cancelled';
        return this._result(true);
      }

      const { stepsLeft, msLeft } = this.remaining();
      if (stepsLeft <= 0) {
        this.stopReason = 'budget';
        return this._result(true);
      }
      if (msLeft <= 0) {
        this.stopReason = 'budget';
        return this._result(true);
      }

      // 上下文压缩: 超阈值就把旧工具结果和过长的正文折起来。
      // 折出来的"进度账"进系统提示 —— 不写消息数组, 用户原话一个字不动。
      //
      // 何时触发用**真实 token**: 上一次调用的 usage.input (ctxTokens) 超过 tokenBudget
      // 就该折。网关没回 usage (ctxTokens 停在 0) 或模型没配 contextLimit 时 tokenBudget()
      // 是 0 —— 那就退回按字符估算 (budget.maxChars)。
      //
      // 折多少: 把 token 预算按**实测的字/token 比**换算成"消息部分的字符上限"再交给
      // compactMessages —— 折的粒度仍是字符, 但目标是真实 token 定的, 不是拍一个字符数。
      let charCap = this.budget.maxChars;
      const tb = this.tokenBudget();
      if (tb > 0 && this.ctxTokens > 0 && this.ctxTokens >= tb) {
        const sysChars = this.systemWithLedger().length;
        const msgChars = this.messages.reduce((n, m) => n + String((m && m.content) || '').length, 0);
        const ratio = (sysChars + msgChars) > 0 ? (sysChars + msgChars) / this.ctxTokens : 1;
        charCap = Math.max(STUB_CHARS, Math.floor(tb * ratio) - sysChars);
      }
      const comp = compactMessages(this.messages, { maxChars: charCap, foldStore: this.foldStore });
      if (comp.compacted) {
        this.messages = comp.messages;
        this.compactions += 1;
        this.emit({ type: 'compact', count: comp.compacted, chars: comp.chars, tokens: this.ctxTokens, budget: tb || null });
      }
      // 账无条件接过来 (见 compactMessages 里 buildLedger 的注释)
      this.ledgerText = comp.ledger || '';

      const msgs = [{ role: 'system', content: this.systemWithLedger() }].concat(this.messages);

      let out;
      // 这一次模型调用花了多久 (下面的 usage 事件要带上它)
      let llmMsThis = 0;
      try {
        // 传输层自动重试时要说一声。
        // 不说的话退避那几秒界面上一片安静 —— 用户分不清"在重试"和"卡死了",
        // 而这两者的正确反应完全不同 (等 vs 点停止)。
        this.llm.onRetry = (info) => {
          const why = (info.error && (info.error.code || info.error.message)) || '连接失败';
          this.emit({
            type: 'phase',
            phase: 'retry',
            message: `网络抖了一下 (${why}), 正在自动重试 ${info.attempt}/${info.max}…`
          });
        };
        const tLlm = Date.now();
        out = await this.llm.chatStep(msgs, tools, {
          temperature: this.temperature,
          // 流式: 逐段把正文推给上层 (界面边生成边显示)。传了它 chatStep 才走流式;
          // 网关不支持时它内部会自动退回非流式, 这里不用管。
          onDelta: (t) => this.emit({ type: 'delta', text: t })
        });
        // 用 llm 自己报的耗时优先 (它含重试), 没报就用我这边量的。
        llmMsThis = Number.isFinite(out.elapsedMs) ? out.elapsedMs : Date.now() - tLlm;
        this.llmMs += llmMsThis;
        // 记下这一次调用的账, 由 _ack 写到 assistant 消息上 ——
        // 这样它会随对话史一起落盘, 事后能按轮复盘 (见 _ack 的注释)。
        this._lastLlmMs = llmMsThis;
        this._lastUsage = out.usage || null;
      } catch (e) {
        // 取消造成的失败不是故障
        if (this.isCancelled() || (e && (e.code === 'ABORT_ERR' || /已取消/.test(e.message || '')))) {
          this.stopReason = 'cancelled';
          return this._result(true);
        }
        this.stopReason = 'error';
        return this._result(false, (e && e.message) || String(e));
      }

      // 正文流式结束 (可能一个字都没流 —— 界面据此收尾实时缓冲, 不该留个半截气泡)
      this.emit({ type: 'delta_end' });

      if (out.reasoning) this.emit({ type: 'thought', step: this.steps + 1, reasoning: out.reasoning });

      // 累计 token 用量。
      //
      // 每一次模型调用都要累 —— 包括那些"没给出动作"的、以及纠正重试的。
      // 只记最后一次的话, 界面上显示的用量会比真实账单少一大截, 而那种偏差
      // 恰好是用户最在意的时候 (跑了很多轮、花了钱) 才暴露出来。
      if (out.usage) {
        this.usage.input += out.usage.input || 0;
        this.usage.output += out.usage.output || 0;
        this.usage.calls += 1;
        // 上下文占用 = **最近一次**调用的输入 token。
        //
        // 和上面那个累计值是两回事, 不能混: 累计是"这个任务一共花了多少",
        // 用来算钱; 占用是"此刻发给模型的提示词有多大", 用来判断离上下文
        // 上限还有多远。拿累计值去比上限的话, 一个跑了 10 轮的任务会显示
        // "上下文 300%", 而每一轮实际只用了 30% —— 用户会被吓得不敢继续。
        //
        // 只在**确实报了数**时才更新: 有些网关某些调用不回 usage, 那时候
        // 拿 0 覆盖会把上一次的真实占用抹掉, 进度条突然归零比不更新更糟。
        if (Number.isFinite(out.usage.input) && out.usage.input > 0) {
          this.ctxTokens = out.usage.input;
        }
        // 发**副本**。直接发 this.usage 的话, 同一个对象会被后面的调用就地改掉 ——
        // 同进程的消费者 (测试、以及将来任何直接挂在这条流上的东西) 拿到手时
        // 看到的已经是最终值, "实时更新"就成了空话。
        // 跨 IPC 那条路有序列化挡着看不出来, 但那是运气, 不是设计。
        this.emit({ type: 'usage', task: { ...this.usage }, ctx: this.ctxTokens, step: this.steps, elapsedMs: llmMsThis });
      }

      // 模型一边调工具一边说的话。界面上这就是"它在想什么" ——
      // 只有动作没有话, 用户看到的就是一串工具名, 不知道它在查什么。
      if (out.content && String(out.content).trim() && (out.toolCalls || []).length) {
        this.emit({ type: 'say', text: String(out.content).trim() });
      }

      const turn = this._resolveTurn(out);

      // 动作无效 (编了个不存在的工具名): 纠正的话已经回灌, 继续下一轮。
      // 不计数 —— 模型没真的做成任何事, 不该消耗预算。
      //
      // 但要限次数: 不消耗预算意味着不设上限的话它能永远转下去。见 MAX_CONSECUTIVE_RETRIES。
      if (turn && turn.retry) {
        this.retries += 1;
        if (this.retries > MAX_CONSECUTIVE_RETRIES) {
          this.stopReason = 'error';
          return this._result(false,
            `模型连续 ${this.retries} 次给出了不存在的工具, 已中止 (它可能一直在编工具名)`);
        }
        continue;
      }
      this.retries = 0;

      if (!turn) {
        // 模型没有给出动作 —— 这就是它自己决定收尾了 (直接回答)
        this.finalText = out.content || '';
        // 这一条也要带账。它是"模型决定收尾"的那一轮, 往往是一次很长的思考
        // (正文一次写完), 漏掉它的话日志里最慢的一轮恰好没有数字。
        this.messages.push(Object.assign(
          { role: 'assistant', content: this.finalText },
          this._llmStamp()
        ));
        this.stopReason = 'done';
        return this._result(true);
      }

      this.steps += 1;
      this.emit({ type: 'thought', step: this.steps, action: { action: turn.primary.name, ...(turn.primary.args || {}) } });

      // 预算快用完: 明确告诉模型该收尾了。
      // 不让它知道预算, "让模型决定何时停"就是空话 —— 它会一路做到底然后被硬截断。
      //
      // 但"该收尾了"只在**没有下一轮**时才对。还有下一轮的时候叫它收敛是有害的:
      // 它会提前交一份半成品 (半成品的 finish 会被闸门拦下, 白烧两步), 而本来
      // 它只要接着干就行 —— 所以那时候改成告诉它"别慌, 接着做"。
      const after = this.remaining();
      const nearlyOut = after.stepsLeft === 2
        || (this.budget.maxMs && after.msLeft <= 20000 && after.stepsLeft <= 4);
      let nudge = '';
      if (nearlyOut) {
        nudge = this.budget.continues
          ? `\n\n[系统] 这一轮还剩 ${after.stepsLeft} 步。不用急着收尾 —— 这一轮跑完会自动接着开下一轮, 你把手上的事做完就好。`
          : `\n\n[系统] 你的步数快用完了 (还剩 ${after.stepsLeft} 步)。请立刻收敛: 把已经拿到的信息整理成最终结论, 不要再开新的探索。`;
      }

      const results = await this._executeTurn(turn);
      this._ack(turn, results, nudge);

      // 终结工具 (比如诊断 Agent 的 report): 调了就停。
      // 不停的话模型还得再空转一轮, 而那一轮它可能又去查东西 —— 已经交卷了还在改答案。
      if (this.stopWhen) {
        const hit = results.find((r) => this.stopWhen(r.name, r.args, r.text));
        if (hit) {
          this.stopReason = 'done';
          this.finalText = this.finalText || String(hit.text || '');
          return this._result(true);
        }
      }

      if (this.isCancelled()) {
        this.stopReason = 'cancelled';
        return this._result(true);
      }
    }
  }

  _result(ok, error) {
    const r = {
      ok: !!ok,
      stopReason: this.stopReason || 'done',
      finalText: this.finalText,
      steps: this.steps,
      messages: this.messages,
      compactions: this.compactions,
      // 账要带出去: 续轮时 agent.js 会开一个**新的** AgentLoop, 不带过去的话
      // 第二轮就不知道第一轮折掉过什么了 —— 那正是"重复劳动"的来源。
      ledger: this.ledgerText,
      // 这一轮的 token 用量。续轮时要累加, 不能只看最后一轮。
      usage: { input: this.usage.input, output: this.usage.output, calls: this.usage.calls },
      // 上下文占用 (最近一次调用的输入 token)。界面上那个圆环读的是它。
      ctx: this.ctxTokens,
      // 时间账: 模型往返 / 工具执行 / 分别哪个工具最费时。
      // 续轮时要累加 (调用方见 engine-ai.js 的 send)。
      timing: {
        llmMs: this.llmMs,
        toolMs: this.toolMs,
        byTool: Object.assign({}, this.byTool),
        byToolCalls: Object.assign({}, this.byToolCalls)
      },
      elapsedMs: Date.now() - this._t0
    };
    if (error) r.error = error;
    return r;
  }

  /**
   * 把模型这一轮的输出解析成动作。三种结果:
   *   null                      -> 这一轮没有动作, 模型是在直接回答 (收尾)
   *   { retry: true }           -> 动作无效, 已经回灌了纠正, 继续下一轮
   *   { native, calls, ... }    -> 可以执行
   *
   * 中间那种必须有 —— 一开始我把它也归到 null, 于是模型一旦编了个不存在的
   * 工具名, 循环直接当它"答完了"收尾: 纠正的话刚写进 messages 就再没人读了。
   * "模型走错一步"和"模型决定结束"是两件事, 不能共用一个返回值。
   *
   * 两套协议都要认: 原生 tool_calls (首选), 以及正文里的 JSON 动作
   * (网关不支持 tools 时退化成这个)。
   */
  _resolveTurn(out) {
    const native = Array.isArray(out.toolCalls) ? out.toolCalls.filter((c) => c && c.name) : [];
    if (native.length) {
      // 工具名要先归一化: 有的网关会把它写成 "SQL"、" sql "、或者带上前缀。
      // 不归一化的话, 这些写法全都算"不存在的工具", 模型会被反复打回。
      const calls = native
        .map((c) => ({ id: c.id, name: normalizeToolName(c.name), args: c.args || {} }))
        .filter((c) => this.tools.has(c.name));
      if (!calls.length) {
        const unknown = Array.from(new Set(native.map((c) => normalizeToolName(c.name)))).join(', ');
        this.messages.push({ role: 'assistant', content: out.content || null });
        this.messages.push({ role: 'user', content: `没有叫 ${unknown} 的工具。请只使用提供给你的工具。` });
        this.emit({ type: 'phase', phase: 'retry', message: `模型用了一个不存在的工具 (${unknown})，已让它改` });
        return { retry: true };
      }
      return { native: true, content: out.content || null, raw: null, calls, primary: calls[0] };
    }

    const json = this.llm._extractJSON ? this.llm._extractJSON(out.content) : null;
    if (json && (json.action || json.tool)) {
      const name = normalizeToolName(json.action || json.tool);
      const args = Object.assign({}, json);
      delete args.action; delete args.tool;
      if (this.tools.has(name)) {
        return { native: false, content: out.content || '', raw: out.content || '', calls: [{ id: 'text_1', name, args }], primary: { name, args } };
      }
      this.messages.push({ role: 'assistant', content: out.content || '' });
      this.messages.push({ role: 'user', content: `没有叫 ${name} 的工具。请只使用提供给你的工具。` });
      this.emit({ type: 'phase', phase: 'retry', message: `模型用了一个不存在的工具 (${name})，已让它改` });
      return { retry: true };
    }

    // 兜底: 模型没守规矩, 在正文里漏出了 DSML 那种标记语言的工具调用。
    // 这条原来只有分析 Agent 有, 是它最能扛网关差异的地方, 所以搬进来共用。
    const dsml = parseDSML(out.content);
    if (dsml) {
      const name = normalizeToolName(dsml.name);
      const args = dsml.args || {};
      if (this.tools.has(name)) {
        return { native: false, content: out.content || '', raw: out.content || '', calls: [{ id: 'dsml_1', name, args }], primary: { name, args } };
      }
      this.messages.push({ role: 'assistant', content: out.content || '' });
      this.messages.push({ role: 'user', content: `没有叫 ${name} 的工具。请只使用提供给你的工具。` });
      this.emit({ type: 'phase', phase: 'retry', message: `模型用了一个不存在的工具 (${name})，已让它改` });
      return { retry: true };
    }

    return null;
  }

  /**
   * 执行这一轮的动作。
   *
   * 只读的内置工具并发跑 (模型一次查两张表是合理的, 逼它一次一个既慢又绕路);
   * 有副作用或跨进程的串行 —— 外部工具不知道它干什么, 并发可能互相踩。
   */
  async _executeTurn(turn) {
    const names = turn.calls.map((c) => c.name);
    const parallel = turn.calls.length > 1 && this.tools.canParallel(names);

    const runOne = async (c) => {
      const t = this.tools.get(c.name);
      this.emit({ type: 'tool_start', name: c.name, args: c.args, group: t ? t.group : '' });
      const tTool = Date.now();
      let toolMs = 0;
      let value;
      try {
        value = await this.tools.call(c.name, c.args, this.ctx);
      } finally {
        // 入账放在 finally 里: 工具抛错时也要记 —— "哪个工具又慢又挂"
        // 恰恰是最该看到的东西, 而抛错路径最容易漏账。
        toolMs = Date.now() - tTool;
        this.toolMs += toolMs;
        this.byTool[c.name] = (this.byTool[c.name] || 0) + toolMs;
        this.byToolCalls[c.name] = (this.byToolCalls[c.name] || 0) + 1;
      }
      const isErr = value && typeof value === 'object' && value.error;
      const text = isErr ? `[失败] ${value.error}` : String(value == null ? '' : value);
      this.emit({
        type: 'tool_result', name: c.name, args: c.args,
        ok: !isErr, error: isErr ? value.error : '', chars: text.length,
        elapsedMs: toolMs,
        // 结果前 400 字 —— 供结构化 Trace 展示"这一步实际返回了什么"
        preview: text.slice(0, 400),
        describe: this.tools.describe(c.name, c.args)
      });
      return { id: c.id, name: c.name, args: c.args, text };
    };

    if (parallel) {
      return Promise.all(turn.calls.map(runOne));
    }
    const out = [];
    for (const c of turn.calls) out.push(await runOne(c));
    return out;
  }

  /**
   * 最近一次模型调用的账, 用来挂到 assistant 消息上。
   *
   * 单独抽出来是因为有**两处**要挂: _ack 里的工具调用轮, 以及循环末尾
   * "模型自己决定收尾"的那一轮 (它不走 _ack)。漏掉后者的话, 日志里最慢的
   * 那一次 —— 正文一次写完的长思考 —— 恰好没有数字。
   */
  _llmStamp() {
    return {
      elapsedMs: Number.isFinite(this._lastLlmMs) ? this._lastLlmMs : null,
      usage: this._lastUsage || null
    };
  }

  /**
   * 把结果回灌给模型。
   *
   * 原生模式必须守协议: assistant(tool_calls) 后面跟 role:'tool', 一个 id 一条。
   * 文本模式沿用 assistant + user 的老形状 (网关不吃 tools 时走这条)。
   *
   * ## 为什么在 assistant 消息上挂 elapsedMs / usage
   *
   * 这两个字段**不发给模型** (llm.chatStep 只取 role/content/tool_calls), 它们是
   * 给落盘和复盘用的。原来每一轮的耗时与 token 只活在 AgentLoop 实例的计数器里,
   * 跑完就随实例消失 —— `_emitSpent` 把它推给了界面, 但没写进任何文件。
   * 结果是: 一个跑了 25 分钟没收敛的搭建会话, 事后**一个耗时数字都没有**,
   * 想判断"是模型慢还是数据库慢"只能靠猜。实测踩到过。
   *
   * 挂在这里而不是别处, 是因为 assistant 消息本来就会随对话史一起落盘
   * (builder 走 snapshot -> ai-chat-store, 分析 Agent 走 conv:saveMessages),
   * 不需要新增任何落盘通道。
   */
  _ack(turn, results, nudge) {
    const stamp = this._llmStamp();
    if (turn.native) {
      this.messages.push(Object.assign({
        role: 'assistant',
        content: turn.content,
        tool_calls: turn.calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args || {}) }
        }))
      }, stamp));
      for (const r of results) {
        this.messages.push({ role: 'tool', tool_call_id: r.id, content: r.text + (nudge || '') });
      }
      return;
    }
    const joined = results.map((r) => `[工具 ${r.name} 返回]\n${r.text}`).join('\n\n');
    this.messages.push(Object.assign({ role: 'assistant', content: turn.raw || '' }, stamp));
    this.messages.push({ role: 'user', content: joined + (nudge || '') + '\n\n继续下一步。' });
  }
}

module.exports = {
  AgentLoop,
  compactMessages,
  stubOf,
  handleOf,
  createFoldStore,
  ledgerLines,
  ledgerText,
  stripLedger,
  isFolded,
  DEFAULT_MAX_CHARS,
  KEEP_RECENT_RESULTS,
  STUB_CHARS,
  ASSISTANT_FOLD_MIN,
  FOLDED_MARK,
  LEDGER_HEAD,
  LEDGER_MAX_CHARS,
  MAX_CONSECUTIVE_RETRIES
};
