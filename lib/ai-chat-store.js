/**
 * AI 搭建对话的持久化存储。
 *
 * 跟 lib/store.js 的分析对话**分开存**: 那边是"问数据 → 出报告"的对话, 有工作区和
 * 产物; 这边是"把一张流程卡搭出来"的对话, 产物就是卡本身。混在一起会让历史列表
 * 里出现两种语义完全不同的东西。
 *
 * 目录结构 (都在 userData 下):
 *   ai-chats/index.json       索引, 供历史列表快速加载 (不读正文)
 *   ai-chats/<id>.json        单条对话全文
 *
 * 单条对话存三样东西, 缺一不可:
 *   log       界面上那串对话流水 (用户说的话 / AI 的话 / 中间动作 / 选择题)
 *   messages  发给模型的对话史 (assistant 的 tool_calls 与 tool 应答都在里面)
 *   session   会话状态 (读过哪些表、哪些线是 AI 接的、自测过没有)
 *
 * 为什么 messages 和 session 也要存:
 *   只存 log 的话, 重进这个对话看着有历史, 但模型那边是空白 —— 它会从头再搭一遍,
 *   而界面上明明显示"已经聊过了"。要真接着聊, 模型手上的上下文必须一起回来。
 *   session 里的 tested 更要紧: 它决定 AI 能不能调 finish 收尾。丢了的话, 一个已经
 *   搭好的对话重开后 AI 会认为"还没试跑过", 卡在收尾那一步反复要求 run_test。
 *
 * 设计取舍:
 *   - 索引与正文分开: 历史列表只读一个小文件, 不把全部对话正文拖进内存
 *   - 写盘时机由主进程控制 (一轮对话结束时写), 不做逐条追加 —— 对话史是整体语义,
 *     逐条写容易出现"assistant 挂了 tool_calls 但 tool 应答还没落盘"的坏中间态
 *   - 按 cardId 归属: 一张卡可以有多轮对话, 历史列表按卡过滤
 */

const fs = require('fs');
const path = require('path');
const { assertSafeId } = require('./safe-id');
const { writeFileAtomic } = require('./atomic-write');

const MAX_TITLE = 40;

class AiChatStore {
  constructor({ rootDir }) {
    this.rootDir = rootDir;
    this.dir = path.join(rootDir, 'ai-chats');
    this._ensureDir();
  }

  _ensureDir() {
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
  }

  _indexPath() {
    return path.join(this.dir, 'index.json');
  }

  _chatPath(id) {
    // 同 store.js: id 来自渲染进程, 拼路径前必须过白名单, 否则 `..` 可以跳出目录
    assertSafeId(id, 'AI 对话 id');
    return path.join(this.dir, `${id}.json`);
  }

  /**
   * 读索引。跟 lib/store.js 同款处理: 文件不存在 -> [], 文件在但读不出来 ->
   * **从对话文件重建**, 而不是当成空。
   *
   * 为什么不能返回 []: _write() 拿 readIndex() 的结果重建整个索引, 所以索引坏一次,
   * 下一次存对话就把整张卡的历史列表写没 —— 而正文文件都还在盘上。
   */
  readIndex() {
    let raw;
    try {
      raw = fs.readFileSync(this._indexPath(), 'utf-8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return [];
      return this._rebuildIndex(e);
    }
    let arr = null;
    try {
      arr = JSON.parse(raw);
    } catch (e) {
      return this._rebuildIndex(e);
    }
    if (Array.isArray(arr)) return arr;
    return this._rebuildIndex(new Error('索引不是数组'));
  }

  /** 索引坏掉时的兜底: 扫对话目录, 用正文文件里的信息把索引拼回来。 */
  _rebuildIndex(cause) {
    console.error('AI 对话索引读不出来, 正在从对话文件重建:', (cause && cause.message) || cause);
    const out = [];
    let files = [];
    try {
      files = fs.readdirSync(this.dir);
    } catch (e) {
      return out;
    }
    for (const f of files) {
      if (!f.endsWith('.json') || f === 'index.json') continue;
      try {
        const conv = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf-8'));
        if (!conv || !conv.id) continue;
        out.push({
          id: conv.id,
          cardId: conv.cardId || null,
          title: conv.title || '新对话',
          createdAt: conv.createdAt || null,
          updatedAt: conv.updatedAt || conv.createdAt || null,
          messageCount: (conv.log || []).filter((m) => m && (m.role === 'user' || m.role === 'ai')).length,
          finished: !!conv.finished
        });
      } catch (e) {
        // 这个文件本身也坏了: 跳过, 别让一个坏文件毁掉整张卡的历史
      }
    }
    return out;
  }

  writeIndex(list) {
    writeFileAtomic(this._indexPath(), JSON.stringify(list, null, 2));
  }

  /**
   * 历史列表。传 cardId 就只给这张卡的 —— 侧边栏的历史是"这张卡聊过什么",
   * 不是全局对话列表。
   *
   * 没说过话的空记录不列: 它只在"建了对话但第一句就抛异常"时出现, 列出来
   * 是一行点开什么都没有的"新对话", 纯噪音。
   */
  list(cardId) {
    let list = this.readIndex().filter((c) => (c.messageCount || 0) > 0);
    if (cardId) list = list.filter((c) => c.cardId === cardId);
    return list.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  get(id) {
    if (!id) return null;
    try {
      const conv = JSON.parse(fs.readFileSync(this._chatPath(id), 'utf-8'));
      // 旧文件可能没有这些字段, 补成空数组/对象, 免得下游每次判空
      if (!Array.isArray(conv.log)) conv.log = [];
      if (!Array.isArray(conv.messages)) conv.messages = [];
      return conv;
    } catch (e) {
      return null;
    }
  }

  /** 从第一句用户消息推一个标题出来。推不出来就用兜底文案。 */
  static titleFrom(log, fallback) {
    const first = (log || []).find((m) => m && m.role === 'user' && String(m.text || '').trim());
    const raw = first ? String(first.text).trim() : '';
    const t = raw.replace(/\s+/g, ' ').slice(0, MAX_TITLE);
    return t || fallback || '新对话';
  }

  create({ id, cardId, title }) {
    const now = new Date().toISOString();
    const conv = {
      id,
      cardId: cardId || null,
      title: title || '新对话',
      createdAt: now,
      updatedAt: now,
      log: [],
      messages: [],
      session: null,
      pool: null,
      finished: false,
      autoPrompted: false,
      // 时间/token 总账 (轮数、步数、模型耗时、工具耗时、按工具分账)。
      // 见 lib/engine-ai.js 的 _emitSpent —— 它本来只推给界面, 关掉面板就没了。
      spent: null
    };
    this._write(conv);
    return conv;
  }

  _write(conv) {
    writeFileAtomic(this._chatPath(conv.id), JSON.stringify(conv, null, 2));
    const list = this.readIndex().filter((c) => c.id !== conv.id);
    list.push({
      id: conv.id,
      cardId: conv.cardId || null,
      title: conv.title,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
      messageCount: (conv.log || []).filter((m) => m && (m.role === 'user' || m.role === 'ai')).length,
      finished: !!conv.finished
    });
    this.writeIndex(list);
  }

  /**
   * 存一条对话。只传想更新的字段, 其余保持原样。
   *
   * 落盘的是一轮对话**结束之后**的状态, 所以 messages / session 一起写 ——
   * 它们和 log 必须同进同出, 否则重开时会出现"界面有历史、模型没上下文"的错位。
   */
  save(id, patch) {
    const conv = this.get(id);
    if (!conv) return { ok: false, error: '对话不存在' };
    if (patch && Array.isArray(patch.log)) conv.log = patch.log;
    if (patch && Array.isArray(patch.messages)) conv.messages = patch.messages;
    if (patch && patch.session !== undefined) conv.session = patch.session || null;
    if (patch && patch.cardId !== undefined) conv.cardId = patch.cardId || null;
    if (patch && patch.pool !== undefined) conv.pool = patch.pool || null;
    if (patch && patch.card !== undefined) conv.card = patch.card || null;
    if (patch && patch.finished !== undefined) conv.finished = !!patch.finished;
    if (patch && patch.autoPrompted !== undefined) conv.autoPrompted = !!patch.autoPrompted;
    // 时间/token 总账。**不做累加** —— 它已经是一份算好的总量 (builder 在
    // send 里跨轮累过), 这里再累就成了"每存一次翻一倍"。store.js 那边的 stats
    // 要累加是因为渲染层送的是增量, 两者语义不同, 别照抄。
    if (patch && patch.spent !== undefined) conv.spent = patch.spent || null;
    if (patch && patch.title) conv.title = String(patch.title).trim().slice(0, MAX_TITLE) || conv.title;
    // 标题还没定下来 (用户第一句刚发出去) 时, 顺手从对话里推一个
    if (conv.title === '新对话' && (conv.log || []).length) {
      conv.title = AiChatStore.titleFrom(conv.log, conv.title);
    }
    conv.updatedAt = new Date().toISOString();
    this._write(conv);
    return { ok: true, chat: conv };
  }

  rename(id, title) {
    const conv = this.get(id);
    if (!conv) return { ok: false, error: '对话不存在' };
    conv.title = String(title || '').trim().slice(0, MAX_TITLE) || conv.title;
    conv.updatedAt = new Date().toISOString();
    this._write(conv);
    return { ok: true, chat: conv };
  }

  remove(id) {
    try {
      if (fs.existsSync(this._chatPath(id))) fs.unlinkSync(this._chatPath(id));
    } catch (e) {}
    this.writeIndex(this.readIndex().filter((c) => c.id !== id));
    return { ok: true };
  }

  /**
   * 这张卡历史上读过哪些表结构 —— 跨对话取并集。
   *
   * ## 为什么需要它
   *
   * 表结构是**纯事实**: 只要表没变, 它就一直成立, 跟"在哪条对话里读到的"无关。
   * 但它原来只存在单条对话的 session.described 里, 所以用户在同一张卡上开一条
   * 新对话, 模型就得从头 describe_tables 一遍 —— 而用户的感觉是"它怎么又忘了"。
   *
   * 表结构本来就随卡走 (卡决定要用哪些表), 所以按 cardId 取并集是对的。
   * 不做"哪条对话最新就用哪条": 旧对话里读过的表在新对话里同样有效, 并集
   * 只会让模型知道得更多, 而 describe_tables 的代价远高于多带几行列名。
   *
   * @returns {Array<[string, Array]>} 能直接喂给 new Map() 的键值对数组
   */
  describedForCard(cardId) {
    if (!cardId) return [];
    const merged = new Map();
    // 直接读索引, **不走 list()** —— list() 会滤掉 messageCount 为 0 的对话
    // (历史列表里那种空记录是噪音), 但一条还没说过话的对话同样可能已经带着
    // 读过的表结构。用 list() 会静默漏掉它, 而漏掉的表现正好是"又忘了"。
    const metas = this.readIndex().filter((c) => c && c.cardId === cardId);
    for (const meta of metas) {
      let conv = null;
      try {
        conv = this.get(meta.id);
      } catch (e) {
        continue;   // 单条坏了不该让整张卡的缓存都取不出来
      }
      const pairs = conv && conv.session && conv.session.described;
      if (!Array.isArray(pairs)) continue;
      for (const p of pairs) {
        if (Array.isArray(p) && typeof p[0] === 'string' && Array.isArray(p[1])) {
          merged.set(p[0], p[1]);
        }
      }
    }
    return Array.from(merged.entries());
  }

  /** 卡被删掉时, 把它名下的对话一起清掉, 免得盘上留下孤儿 */  removeByCard(cardId) {
    if (!cardId) return { ok: true, removed: 0 };
    const mine = this.list(cardId);
    for (const c of mine) {
      try {
        if (fs.existsSync(this._chatPath(c.id))) fs.unlinkSync(this._chatPath(c.id));
      } catch (e) {}
    }
    this.writeIndex(this.readIndex().filter((c) => c.cardId !== cardId));
    return { ok: true, removed: mine.length };
  }
}

module.exports = AiChatStore;
module.exports.titleFrom = AiChatStore.titleFrom;
