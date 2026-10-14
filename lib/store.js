/**
 * 持久化存储: 对话历史 + 数据空间(产物文件)
 *
 * 目录结构 (都在 userData 下):
 *   conversations/index.json          对话索引, 供历史列表快速加载
 *   conversations/<id>.json           单个对话的完整内容(消息 + 产物清单)
 *   workspace/<slug>-<id尾>/          该对话的产物目录 (按对话分离)
 *     data/01-xxx.csv                 SQL 原始数据
 *     report-xxx.html                 报告
 *     report-xxx.xlsx                 Excel
 *
 * 设计取舍:
 * - 索引与正文分开, 历史列表只需读一个小文件, 不必加载全部对话正文
 * - 产物用真实文件落盘(而不是塞进 json), 这样数据空间里的东西能直接被用户拷走
 * - 目录名带可读标题, 方便用户自己去文件管理器翻; 重命名对话不改目录, 避免链接失效
 */

const fs = require('fs');
const path = require('path');
const { assertSafeId } = require('./safe-id');
const { tooLargeToPreview, previewLimitFor } = require('./preview-limit');
const { writeFileAtomic } = require('./atomic-write');

const MAX_TITLE = 40;

class Store {
  constructor({ rootDir }) {
    this.rootDir = rootDir;
    this.convDir = path.join(rootDir, 'conversations');
    this.wsDir = path.join(rootDir, 'workspace');
    this._ensureDirs();
  }

  _ensureDirs() {
    for (const d of [this.convDir, this.wsDir]) {
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    }
  }

  // ==================== 对话 ====================

  _indexPath() {
    return path.join(this.convDir, 'index.json');
  }

  _convPath(id) {
    // id 来自渲染进程, 当作不可信输入: 不做校验的话 `../config` 能跳出目录,
    // 而 deleteConversation 会直接 unlink 掉它 —— 那正好是存放全部口令的 config.json
    assertSafeId(id, '对话 id');
    return path.join(this.convDir, `${id}.json`);
  }

  /**
   * 读对话索引。
   *
   * 三种情况要分开对待, 以前它们被合并成了同一种:
   *   1) 文件不存在       -> [] (全新安装, 正常)
   *   2) 文件在但读不出来 -> **从对话文件重建**, 而不是当成空
   *   3) 正常             -> 索引
   *
   * 为什么 2) 不能返回 []: _writeConversation 是拿 readIndex() 的结果**重建整个
   * 索引**的。索引只要坏一次, 下一次存消息就把用户的整个对话列表写没
   * (实测: 3 个对话 -> 剩 1 个)。对话正文文件都还在盘上, 但界面上永远看不到了,
   * 也没有任何提示 —— 用户以为对话丢了。
   *
   * 索引本质上只是一份缓存 (真正的数据在每个 <id>.json 里), 所以坏掉时正确的
   * 做法是把它重建出来, 最坏也只是标题/时间回退到正文文件里的值。
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
    console.error('对话索引读不出来, 正在从对话文件重建:', (cause && cause.message) || cause);
    const out = [];
    let files = [];
    try {
      files = fs.readdirSync(this.convDir);
    } catch (e) {
      return out;
    }
    for (const f of files) {
      if (!f.endsWith('.json') || f === 'index.json') continue;
      try {
        const conv = JSON.parse(fs.readFileSync(path.join(this.convDir, f), 'utf-8'));
        if (!conv || !conv.id) continue;
        out.push({
          id: conv.id,
          title: conv.title || '未命名分析',
          createdAt: conv.createdAt || null,
          updatedAt: conv.updatedAt || conv.createdAt || null,
          databaseName: conv.databaseName || '',
          messageCount: (conv.messages || []).length,
          artifactCount: (conv.artifacts || []).length
        });
      } catch (e) {
        // 这一个文件本身也坏了: 跳过它, 别让一个坏文件毁掉整个列表
      }
    }
    return out;
  }

  writeIndex(list) {
    writeFileAtomic(this._indexPath(), JSON.stringify(list, null, 2));
  }

  listConversations() {
    return this.readIndex().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  getConversation(id) {
    if (!id) return null;
    try {
      return JSON.parse(fs.readFileSync(this._convPath(id), 'utf-8'));
    } catch (e) {
      return null;
    }
  }

  createConversation({ id, title, databaseId, databaseName, dbIds }) {
    const now = new Date().toISOString();
    // 目录名在这里定下来并记进对话, 之后重命名对话也不改目录 —— 否则旧链接会失效。
    // 同时要避开同名目录, 免得两个对话的产物混在一起。
    const workspace = uniqueDirName(this.wsDir, workspaceName(title, id));
    const conv = {
      id,
      title: title || '未命名分析',
      workspace,
      createdAt: now,
      updatedAt: now,
      databaseId: databaseId || null,
      databaseName: databaseName || '',
      // 这段对话限定在哪些库里找表。空数组 = 不限制 (全部勾过表的库)。
      // 它约束的是**通用分析**; 流程卡有自己的一套表范围, 不读这个字段。
      dbIds: Array.isArray(dbIds) ? dbIds.slice() : [],
      messages: [],
      artifacts: [],
      // 本会话的智能体状态 (已确认的表/字段 + 已查过的结果编号)。
      // 下一轮对话靠它认出"这件事已经查过", 不必从头再来一遍。
      agentState: null
    };
    const dir = path.join(this.wsDir, workspace);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this._writeConversation(conv);
    return conv;
  }

  _writeConversation(conv) {
    writeFileAtomic(this._convPath(conv.id), JSON.stringify(conv, null, 2));
    const list = this.readIndex().filter((c) => c.id !== conv.id);
    list.push({
      id: conv.id,
      title: conv.title,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
      databaseName: conv.databaseName || '',
      messageCount: (conv.messages || []).length,
      artifactCount: (conv.artifacts || []).length
    });
    this.writeIndex(list);
  }

  /** 前端同步消息; 不动产物(main 自己维护)。
   *  agentState 一并落盘 —— 重开这个对话时要把"查到哪一步"接回来。
   *
   *  stats 是**累计**用量, 由渲染层传上来并在这里累加。
   *  为什么只有 token 需要存: 轮数和步数都能从 messages 数出来 (用户几条、
   *  assistant 各自带了多少 steps), 存了反而会有两份对不上的真相。
   *  token 不一样 —— 它来自模型响应的 usage, 消息里没有, 不存就永久丢了。
   */
  saveMessages(id, messages, agentState, stats) {
    const conv = this.getConversation(id);
    if (!conv) return { ok: false, error: '对话不存在' };
    conv.messages = Array.isArray(messages) ? messages : [];
    if (agentState !== undefined) conv.agentState = agentState || null;
    if (stats && typeof stats === 'object') {
      const prev = (conv.stats && typeof conv.stats === 'object') ? conv.stats : {};
      conv.stats = {
        input: (Number(prev.input) || 0) + (Number(stats.input) || 0),
        output: (Number(prev.output) || 0) + (Number(stats.output) || 0),
        calls: (Number(prev.calls) || 0) + (Number(stats.calls) || 0)
      };
    }
    conv.updatedAt = new Date().toISOString();
    this._writeConversation(conv);
    return { ok: true, conversation: conv };
  }

  renameConversation(id, title) {
    const conv = this.getConversation(id);
    if (!conv) return { ok: false, error: '对话不存在' };
    conv.title = String(title || '').trim().slice(0, MAX_TITLE) || conv.title;
    conv.updatedAt = new Date().toISOString();
    this._writeConversation(conv);
    return { ok: true, conversation: conv };
  }

  /**
   * 补写一条占位对话的标题与范围。
   *
   * 点「＋」时先落一条 title=「新对话」的占位, 那时用户还没选库、也没内容起标题;
   * 第一轮任务发出后才拿到真实标题和这次用到的库, 这里把两者一起写回去。
   * 刻意跟 renameConversation 分开: 那个是"用户手动改名", 只动标题; 这个还要带上范围。
   */
  applyTitle(id, title, scope = {}) {
    const conv = this.getConversation(id);
    if (!conv) return { ok: false, error: '对话不存在' };
    if (title) conv.title = String(title).trim().slice(0, MAX_TITLE) || conv.title;
    if (Array.isArray(scope.dbIds)) conv.dbIds = scope.dbIds.slice();
    if (typeof scope.databaseName === 'string') conv.databaseName = scope.databaseName;
    conv.updatedAt = new Date().toISOString();
    this._writeConversation(conv);
    return { ok: true, conversation: conv };
  }

  deleteConversation(id) {
    const conv = this.getConversation(id);
    if (conv) {
      // 连同工作区目录一起删掉, 避免磁盘上留下孤儿文件
      const dir = this.workspaceDir(conv);
      try {
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      } catch (e) {
        // 目录删不掉不影响对话本身的删除
      }
    }
    try {
      if (fs.existsSync(this._convPath(id))) fs.unlinkSync(this._convPath(id));
    } catch (e) {}
    this.writeIndex(this.readIndex().filter((c) => c.id !== id));
    return { ok: true };
  }

  // ==================== 工作区 (数据空间) ====================

  /** 对话的工作区目录。优先用创建时定下的目录名, 旧数据回退到按标题推导。 */
  workspaceDir(conv) {
    const name = conv.workspace || workspaceName(conv.title, conv.id);
    return path.join(this.wsDir, name);
  }

  /** 某个对话工作区里的子目录 */
  _subDir(conv, sub) {
    const dir = path.join(this.workspaceDir(conv), sub);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * 落盘一个产物。
   * @param convId 对话 id
   * @param { kind, name, sub, ext, content (string|Buffer), meta }
   * @returns 产物记录 (相对路径入库, 便于整体搬迁)
   */
  saveArtifact(convId, { kind, name, sub = '', ext = '', content, meta = {} }) {
    const conv = this.getConversation(convId);
    if (!conv) return { ok: false, error: '对话不存在' };

    const dir = sub ? this._subDir(conv, sub) : this.workspaceDir(conv);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const fileName = uniqueFileName(dir, `${name}${ext ? '.' + ext : ''}`);
    const abs = path.join(dir, fileName);
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf-8');
    writeFileAtomic(abs, buf);

    const rel = path.relative(this.workspaceDir(conv), abs).split(path.sep).join('/');
    const artifact = {
      id: 'a_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      kind,
      name: fileName,
      rel,
      size: buf.length,
      createdAt: new Date().toISOString(),
      ...meta
    };
    conv.artifacts = conv.artifacts || [];
    conv.artifacts.push(artifact);
    conv.updatedAt = conv.createdAt ? conv.updatedAt : new Date().toISOString();
    this._writeConversation(conv);
    return { ok: true, artifact };
  }

  listArtifacts(convId) {
    const conv = this.getConversation(convId);
    if (!conv) return { ok: false, error: '对话不存在' };
    return { ok: true, artifacts: conv.artifacts || [], workspaceDir: this.workspaceDir(conv) };
  }

  /**
   * 读取产物内容 (供界面预览)。二进制文件返回 base64 + 标记。
   *
   * **超大的文件不读, 直接告诉界面"太大, 请下载"。**
   *
   * 以前这里是无条件 readFileSync + 把整个文件当字符串返回。代价链是:
   *   主进程同步读满整个文件 -> IPC 结构化克隆再拷一份 -> 渲染层逐字符解析
   *   -> 最后只显示 300 行。
   * 也就是"为了看 300 行, 付了整份数据的代价"。几十 MB 的 CSV 会让主进程
   * 卡住 (同步 IO), 界面跟着假死。
   *
   * 现在先用 statSync 拿体积 (一次系统调用, 不读内容), 超过该类型的阈值就
   * 到此为止。界面收到 tooLarge 之后显示一个「下载」按钮 —— 数据没有丢,
   * 只是不再走"塞进 DOM 里看"这条路。
   */
  readArtifact(convId, artifactId) {
    const conv = this.getConversation(convId);
    if (!conv) return { ok: false, error: '对话不存在' };
    const a = (conv.artifacts || []).find((x) => x.id === artifactId);
    if (!a) return { ok: false, error: '产物不存在' };
    const abs = path.join(this.workspaceDir(conv), a.rel);
    if (!fs.existsSync(abs)) return { ok: false, error: '文件已被移动或删除' };

    let size = 0;
    try {
      size = fs.statSync(abs).size;
    } catch (e) {
      // 拿不到大小就当它不大 —— 宁可让用户看到内容, 也不要因为一次 stat 失败
      // 就彻底看不了。真读不动的话下面的 readFileSync 会抛, 一样有错可报。
      size = 0;
    }
    if (tooLargeToPreview(a.name, size)) {
      return {
        ok: true,
        artifact: a,
        tooLarge: true,
        size,
        limit: previewLimitFor(a.name),
        absolute: abs
      };
    }

    const textLike = /\.(html?|csv|json|md|txt|sql|log)$/i.test(a.name);
    if (textLike) {
      return { ok: true, artifact: a, text: fs.readFileSync(abs, 'utf-8'), absolute: abs };
    }
    return {
      ok: true,
      artifact: a,
      base64: fs.readFileSync(abs).toString('base64'),
      absolute: abs
    };
  }

  /** 只解析产物的绝对路径, 不读内容 (供"在文件夹中显示"这类操作用) */
  resolveArtifactPath(convId, artifactId) {
    const conv = this.getConversation(convId);
    if (!conv) return { ok: false, error: '对话不存在' };
    const a = (conv.artifacts || []).find((x) => x.id === artifactId);
    if (!a) return { ok: false, error: '产物不存在' };
    const abs = path.join(this.workspaceDir(conv), a.rel);
    if (!fs.existsSync(abs)) return { ok: false, error: '文件已被移动或删除' };
    return { ok: true, absolute: abs, artifact: a };
  }

  deleteArtifact(convId, artifactId) {
    const conv = this.getConversation(convId);
    if (!conv) return { ok: false, error: '对话不存在' };
    const a = (conv.artifacts || []).find((x) => x.id === artifactId);
    if (!a) return { ok: false, error: '产物不存在' };
    try {
      const abs = path.join(this.workspaceDir(conv), a.rel);
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    } catch (e) {}
    conv.artifacts = conv.artifacts.filter((x) => x.id !== artifactId);
    this._writeConversation(conv);
    return { ok: true };
  }

  /**
   * 数据空间总览: 按对话分组的产物清单。
   * 只返回存在的文件, 顺手把索引里已失联的对话过滤掉。
   */
  listDataSpace() {
    const groups = [];
    for (const meta of this.listConversations()) {
      const conv = this.getConversation(meta.id);
      if (!conv) continue;
      const base = this.workspaceDir(conv);
      const artifacts = (conv.artifacts || [])
        .map((a) => {
          const abs = path.join(base, a.rel);
          return fs.existsSync(abs) ? a : null;
        })
        .filter(Boolean);
      groups.push({
        conversationId: conv.id,
        title: conv.title,
        updatedAt: conv.updatedAt,
        databaseName: conv.databaseName || '',
        workspace: conv.workspace || path.basename(base),
        artifacts
      });
    }
    return groups;
  }
}

/** 目录名安全化: 去掉文件系统非法字符, 压掉空白, 限长 */
function slugify(s) {
  return String(s == null ? '' : s)
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, MAX_TITLE)
    .toLowerCase();
}

/** workspace/<标题>-<id随机尾> */
function workspaceName(title, id) {
  const slug = slugify(title) || 'chat';
  const tail = String(id || '').split('_').pop().replace(/[^a-z0-9]/gi, '').slice(0, 6) || 'x';
  return `${slug}-${tail}`;
}

/** 同名目录自动加序号, 避免两个对话共用工作区 */
function uniqueDirName(parent, name) {
  let candidate = name;
  let i = 2;
  while (fs.existsSync(path.join(parent, candidate))) {
    candidate = `${name}-${i}`;
    i += 1;
  }
  return candidate;
}

/** 同名文件自动加序号, 不覆盖已有产物 */
function uniqueFileName(dir, fileName) {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  let candidate = fileName;
  let i = 2;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${base}-${i}${ext}`;
    i += 1;
  }
  return candidate;
}

/** 文件名安全化: 留可读性, 只去掉文件系统非法字符并限长 */
function safeFileName(s, maxLen = 40) {
  const out = String(s == null ? '' : s)
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  return out.slice(0, maxLen);
}

module.exports = Store;
module.exports.slugify = slugify;
module.exports.safeFileName = safeFileName;
