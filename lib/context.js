'use strict';

/**
 * 统一的上下文管理。
 *
 * ## 它替掉的是什么
 *
 * 三个 Agent 各自管着自己那串 messages:
 *   - lib/agent.js          一个局部数组, 每轮从 history 重建
 *   - lib/engine-ai.js      this.messages, 还要序列化进 state 存盘
 *   - lib/engine-tester.js  this.messages, 每轮新建
 *
 * 各自管各自的直接后果是**规则不一致**: 分析 Agent 有可配的 maxChars,
 * 另外两个只能用默认值; 历史裁剪只有分析 Agent 做; 压缩阈值三处各写一遍。
 * 于是"长会话会不会爆窗口"取决于你用的是哪个 Agent, 而不是取决于配置。
 *
 * ## 它做什么
 *
 * 一个对象同时管三件事, 三处调用同一份实现:
 *   1. **messages 的所有权** —— 谁都能读写, 但只有这里决定它怎么长
 *   2. **历史裁剪** —— 按轮数取最近 N 轮, 规则只有一份
 *   3. **压缩** —— 超阈值时折掉早期取数结果, 系统提示和用户原话不动
 *
 * `toLoop()` 是唯一的出口: 它产出 AgentLoop 要的那份配置, 形状固定,
 * 三个 Agent 都不再自己拼 `{system, messages, budget}`。
 *
 * ## 一个容易踩的点
 *
 * 压缩只看**这里**的 messages。系统提示是每轮单独拼上去的 (AgentLoop 会
 * 在调模型前把 system 放在最前面), 不算在这个数组里, 也不参与阈值判断。
 * 所以 maxChars 要压在"对话本身"的量级上 —— 按"连系统提示一起"估就会
 * 永远不触发。实测踩过一次。
 */

const { compactMessages, DEFAULT_MAX_CHARS, KEEP_RECENT_RESULTS } = require('./agent-loop');

/** 默认保留最近多少轮历史对话 */
const DEFAULT_HISTORY_TURNS = 6;

class AgentContext {
  /**
   * @param system       系统提示词: 字符串, 或 () => string (每轮重建)
   * @param maxChars     对话本身的上限 (不含系统提示), 超了就开始折叠
   * @param keepRecent   最近多少条取数结果要保护住 (偏好; 字数上限是硬线)
   * @param historyTurns 默认保留最近多少轮历史
   */
  constructor({ system = '', maxChars, keepRecent, historyTurns } = {}) {
    this._system = system || '';
    this._messages = [];
    this.maxChars = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : DEFAULT_MAX_CHARS;
    this.keepRecent = Number.isFinite(keepRecent) && keepRecent >= 0 ? Math.floor(keepRecent) : KEEP_RECENT_RESULTS;
    this.historyTurns = Number.isFinite(historyTurns) && historyTurns > 0
      ? Math.min(30, Math.floor(historyTurns))
      : DEFAULT_HISTORY_TURNS;
    /** 累计折叠过多少条 —— 给界面和诊断用 */
    this.compactions = 0;
    /** 折叠出来的进度账, 由 toLoop() 拼进系统提示 (见 compact) */
    this.ledger = '';
  }

  /** 消息数组本体。可以整体替换 (运行完之后 loop.messages 才是权威的) */
  get messages() { return this._messages; }
  set messages(arr) { this._messages = Array.isArray(arr) ? arr : []; }

  get length() { return this._messages.length; }

  /** 系统提示: 传函数就是每轮重建 (适合依赖运行期状态的提示词) */
  setSystem(s) { this._system = s || ''; return this; }

  systemText() {
    const s = this._system;
    return typeof s === 'function' ? String(s() || '') : String(s || '');
  }

  /** 对话本身的字数 (不含系统提示) */
  chars() {
    return this._messages.reduce((n, m) => n + String((m && m.content) || '').length, 0);
  }

  push(msg) {
    if (msg && msg.role) this._messages.push(msg);
    return this;
  }

  pushUser(text) {
    const t = String(text == null ? '' : text);
    if (t.trim()) this._messages.push({ role: 'user', content: t });
    return this;
  }

  pushAssistant(text) {
    const t = String(text == null ? '' : text);
    if (t.trim()) this._messages.push({ role: 'assistant', content: t });
    return this;
  }

  /**
   * 按统一规则把历史对话铺进来。
   *
   * 规则只有一份, 三个 Agent 不再各写一遍:
   *   - 只认 user / assistant 两种角色 (system 由 system 那条路走)
   *   - 空内容丢掉 (模型偶发返回空串, 铺进去只会让协议看着怪)
   *   - 只取最近 N 轮
   */
  fromHistory(history, turns) {
    const n = Number.isFinite(turns) && turns > 0 ? Math.min(30, Math.floor(turns)) : this.historyTurns;
    const list = Array.isArray(history) ? history : [];
    for (const h of list.slice(-n)) {
      if (!h || (h.role !== 'user' && h.role !== 'assistant')) continue;
      if (typeof h.content !== 'string' || !h.content.trim()) continue;
      this._messages.push({ role: h.role, content: h.content });
    }
    return this;
  }

  /**
   * 超阈值就把早期的取数结果折成摘要。
   *
   * 只折"工具结果" —— 系统提示不在这个数组里, 用户原话和模型的回答也不动。
   * 这样折叠之后模型仍然知道"查过什么、结论是什么", 丢掉的只是明细。
   *
   * @returns {{compacted:number, savedChars:number, chars:number}} 折了几条、省了多少
   */
  compact(extraToolIdx) {
    const r = compactMessages(this._messages, {
      maxChars: this.maxChars,
      keepRecent: this.keepRecent,
      toolIdx: extraToolIdx || []
    });
    // 账**无条件**更新, 不是"折了才更新" —— 账是从现存存根反推的, 上一轮折过
    // 的存根这一轮仍然需要一份账来说明"发生过什么"。见 compactMessages 里的注释。
    this.ledger = r.ledger || '';
    if (r.compacted) {
      this._messages = r.messages;
      this.compactions += 1;
    }
    return { compacted: r.compacted, savedChars: r.savedChars || 0, chars: r.chars, ledger: this.ledger };
  }

  /** 从最近一条消息倒着找一条满足条件的 */
  findLast(pred) {
    for (let i = this._messages.length - 1; i >= 0; i--) {
      if (pred(this._messages[i], i)) return this._messages[i];
    }
    return null;
  }

  /** 清空对话 (系统提示留着) */
  reset() {
    this._messages = [];
    return this;
  }

  /**
   * 产出 AgentLoop 要的那份配置 —— 唯一的出口。
   *
   * 三个 Agent 都从这里拿, 所以"系统提示怎么拼、messages 怎么给、预算怎么设"
   * 不再有第二份实现。maxChars 由这里统一注入, 谁也不会漏配。
   */
  toLoop({ llm, tools, maxSteps, maxMs, emit, cancel, stopWhen, temperature, ctx, continues, foldStore } = {}) {
    return {
      llm,
      tools,
      system: () => this.systemText(),
      messages: this._messages,
      // continues: 步数跑满之后还有下一轮。循环靠它决定"快用完时"该怎么提醒模型 ——
      // 有下一轮就别叫它收敛 (那会让它提前交半成品), 没有才叫。
      budget: { maxSteps, maxMs, maxChars: this.maxChars, continues: !!continues },
      // 上一轮折出来的账带进这一轮, 免得续轮之后重复劳动
      ledger: this.ledger,
      // 被折掉的长结果存在这里, 存根上留编号, 模型可以 recall 取回 (见 agent-loop 里 createFoldStore)
      foldStore,
      emit,
      cancel,
      stopWhen,
      temperature,
      ctx
    };
  }

  /** 存盘用的快照 (builder 要把对话存进卡片的编辑状态) */
  snapshot() {
    return { messages: this._messages, maxChars: this.maxChars };
  }

  /** 从快照恢复 */
  restore(snap) {
    if (!snap || typeof snap !== 'object') return this;
    if (Array.isArray(snap.messages)) this._messages = snap.messages;
    if (Number.isFinite(snap.maxChars) && snap.maxChars > 0) this.maxChars = Math.floor(snap.maxChars);
    return this;
  }
}

module.exports = { AgentContext, DEFAULT_HISTORY_TURNS };
