/**
 * 流程卡包 —— 流程卡的导入/导出格式与全部纯逻辑。
 *
 * 为什么是**单个 JSON 文件**而不是 zip:
 *   1. "单个导出"就是卡包里只有一张卡, "批量导出"就是多张 —— 一条代码路径,
 *      不用为两种场景各写一遍打包/解包。
 *   2. 纯文本, 能 diff、能评审、能直接放进共享层的 git 仓库; zip 是二进制,
 *      评审时只能看到"一个包变了"。
 *   3. 不引新依赖。这个项目没有打包器, 也没有 zip 库; 为了导出流程卡引一个
 *      压缩库, 以后换 web 模式还要处理二进制流, 不划算。
 *   4. 当前流程卡的内容是纯数据 (节点/连线/SQL 文本/输入项)。哪天卡里要带
 *      外部脚本文件了, 再升级 formatVersion 换成 zip 容器 —— 版本号就是为这个留的。
 *
 * **卡包里不含任何凭据。** 库只带 id/name/type/host/port/database 六样, 用来在
 * 对方机器上认出"这是哪个库"; 口令和用户名一律不带 —— 分享一张卡不该顺手把
 * 生产库的口令发给对方, 而且数据库配置本来就是集中管理的。
 *
 * 真正麻烦的地方是**库 id 不可移植**: 本机的库 id 是 db_1789439222631 这种时间戳,
 * 换台机器新建同一个库会拿到另一个 id, 卡导过去就指向一个不存在的库。
 * 所以每个库额外带一份 fingerprint (type|host|port|database), 导入时按指纹认出
 * 本机对应的那个库, 再把卡里的 id 换掉。指纹对不上的, 交给用户在导入界面上手工指认。
 *
 * 同一份代码三处用:
 *   Node 侧 (主进程、测试) 走 module.exports;
 *   浏览器侧 (src/index.html 直接 <script src="../lib/cardpack.js">) 挂到
 *   window.SoloCardPack。所以下面那段 UMD 外壳是必要的, 不是样板。
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SoloCardPack = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FORMAT = 'solodb.cardpack';
  // 版本号只管**容器格式**。加字段不用动它 (老程序读到多余字段会忽略),
  // 只有当老程序会读错的时候才 +1。
  const FORMAT_VERSION = 1;

  // 上限是防呆不是安全边界: 一个 8MB 的 JSON 已经能装几千张卡了,
  // 再大基本就是选错了文件。真正的理由见 parsePack 的注释。
  const MAX_CARDS = 500;
  const MAX_BYTES = 8 * 1024 * 1024;

  function str(v, max) {
    const s = String(v == null ? '' : v);
    return max ? s.slice(0, max) : s;
  }

  /** 时间戳统一成「年月日时分」—— 和更新日志一个写法, 人一眼能读 */
  function nowStamp(d) {
    const t = d || new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`;
  }

  let seq = 0;
  /** 导入时"另存为新卡"要用的新 id。和 lib/engine.js 的 genId 同形。 */
  function genId(prefix) {
    seq += 1;
    return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}`;
  }

  /**
   * 一个库的指纹: 认"是不是同一个库"靠它, 不靠 id (id 每台机器都不一样)。
   *
   * sqlite 的 host/port 本来就是空的, 它的身份就是那个库文件路径 —— 路径里的大小写
   * 在 Windows 上不敏感, 所以统一转小写。
   */
  function fingerprint(db) {
    const d = (db && typeof db === 'object') ? db : {};
    const type = str(d.type, 20).trim().toLowerCase();
    const isFile = type === 'sqlite';
    const host = isFile ? '' : str(d.host, 200).trim().toLowerCase();
    const port = isFile || d.port == null ? '' : String(d.port).trim();
    const name = str(d.database, 400).trim().toLowerCase();
    return [type, host, port, name].join('|');
  }

  /** 卡包里记一个库时只留这七样 (指纹是算出来的, 存着是为了对方能直接显示) */
  function dbBrief(db) {
    const d = db || {};
    return {
      id: str(d.id, 80),
      name: str(d.name, 120),
      type: str(d.type, 20),
      host: str(d.host, 200),
      port: d.port == null ? '' : d.port,
      database: str(d.database, 400),
      fingerprint: fingerprint(d)
    };
  }

  /** 这张卡引用了哪些库: 可用范围 (scope 的键) + 每个取数节点选的库 */
  function collectDbIds(card) {
    const out = new Set();
    const c = (card && typeof card === 'object') ? card : {};
    if (c.scope && typeof c.scope === 'object' && !Array.isArray(c.scope)) {
      for (const k of Object.keys(c.scope)) if (str(k, 80).trim()) out.add(str(k, 80));
    }
    for (const n of (Array.isArray(c.nodes) ? c.nodes : [])) {
      if (n && n.type === 'query' && str(n.databaseId, 80).trim()) out.add(str(n.databaseId, 80));
    }
    return out;
  }

  /** 导出时把创建/更新时间剥掉 —— 那是来源机器上的事实, 对导入方没有意义 */
  function stripCard(card) {
    const c = Object.assign({}, card);
    delete c.createdAt;
    delete c.updatedAt;
    return c;
  }

  /**
   * 打包。
   *
   * @param cards      要导出的卡 (已经是内部形状)
   * @param databases  本机的库配置 (含口令, 这里只读不写)
   * @param app        { name, version }
   * @param now        时间戳, 测试用
   */
  function buildPack(opts) {
    const o = opts || {};
    const cards = (Array.isArray(o.cards) ? o.cards : []).filter(Boolean).map(stripCard);
    const localDbs = Array.isArray(o.databases) ? o.databases : [];

    // 只带这 N 张卡真正用到的库, 不把本机全部库倒出去
    const ids = new Set();
    for (const c of cards) for (const id of collectDbIds(c)) ids.add(id);

    const databases = [];
    for (const id of ids) {
      const db = localDbs.find((d) => d && str(d.id, 80) === id);
      if (db) databases.push(dbBrief(db));
      // 卡引用了一个本机也没有的库 (库被删了 / 卡是从别处导进来的)。
      // 照样记一条, 但标成 missing —— 对方能看出这张卡缺依赖, 而不是拿到一张
      // 静默指向空 id 的卡。
      else databases.push({ id, name: '', type: '', host: '', port: '', database: '', fingerprint: '', missing: true });
    }

    return {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      exportedAt: o.now || nowStamp(),
      app: { name: str((o.app && o.app.name) || 'Askaha', 40), version: str((o.app && o.app.version) || '', 40) },
      databases,
      cards
    };
  }

  /** 序列化。缩进 2 空格 + 末尾换行 —— 它是给人看、给 git 存的文本。 */
  function stringifyPack(pack) {
    return JSON.stringify(pack, null, 2) + '\n';
  }

  /**
   * 解析一个卡包。
   * 一律返回 { ok, pack } 或 { ok:false, error }, 不抛 —— 调用方要的是"能不能用",
   * 不是异常处理。
   */
  function parsePack(text) {
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: '文件是空的' };
    if (text.length > MAX_BYTES) return { ok: false, error: '文件太大, 不像是流程卡包' };

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return { ok: false, error: '不是合法的 JSON: ' + ((e && e.message) || e) };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, error: '文件内容不是一个卡包对象' };
    }
    if (data.format !== FORMAT) {
      // 说清楚"这是什么"比"格式不对"有用 —— 用户多半是选错了文件
      return { ok: false, error: `不是流程卡包 (format=${str(data.format, 60) || '缺失'})` };
    }
    const ver = Number(data.formatVersion);
    if (!Number.isFinite(ver) || ver < 1) return { ok: false, error: '卡包缺少 formatVersion' };
    if (ver > FORMAT_VERSION) {
      return { ok: false, error: `这个卡包来自更新的版本 (formatVersion=${ver}), 先升级 Askaha 再导入` };
    }
    if (!Array.isArray(data.cards)) return { ok: false, error: '卡包里没有 cards 数组' };
    if (!data.cards.length) return { ok: false, error: '卡包里一张卡都没有' };
    if (data.cards.length > MAX_CARDS) {
      return { ok: false, error: `一个卡包最多 ${MAX_CARDS} 张卡 (这个有 ${data.cards.length} 张)` };
    }

    const cards = [];
    for (let i = 0; i < data.cards.length; i++) {
      const c = data.cards[i];
      if (!c || typeof c !== 'object' || Array.isArray(c)) return { ok: false, error: `第 ${i + 1} 张卡不是对象` };
      if (!str(c.id, 80).trim()) return { ok: false, error: `第 ${i + 1} 张卡没有 id` };
      if (!Array.isArray(c.nodes)) return { ok: false, error: `第 ${i + 1} 张卡没有 nodes 数组` };
      cards.push(c);
    }

    const databases = (Array.isArray(data.databases) ? data.databases : [])
      .filter((d) => d && typeof d === 'object' && str(d.id, 80).trim())
      .map((d) => ({
        id: str(d.id, 80),
        name: str(d.name, 120),
        type: str(d.type, 20),
        host: str(d.host, 200),
        port: d.port == null ? '' : d.port,
        database: str(d.database, 400),
        // 指纹现算一遍, 不信任文件里那份 —— 它是判断"是不是同一个库"的唯一依据,
        // 手改过的卡包不该能把两张卡接到另一个库上。
        fingerprint: d.missing ? '' : fingerprint(d),
        missing: !!d.missing || !str(d.type, 20).trim()
      }));

    return {
      ok: true,
      pack: {
        format: FORMAT,
        formatVersion: ver,
        exportedAt: str(data.exportedAt, 40),
        app: { name: str((data.app && data.app.name) || '', 40), version: str((data.app && data.app.version) || '', 40) },
        databases,
        cards
      }
    };
  }

  /** 给人看的一行库描述 */
  function dbLabel(db) {
    const d = db || {};
    const type = str(d.type, 20).toLowerCase();
    if (type === 'sqlite') return str(d.name, 120) || str(d.database, 400) || '(未命名库)';
    const where = [d.host, d.port].filter((x) => x !== '' && x != null).join(':');
    const nm = str(d.name, 120) || str(d.database, 400) || '(未命名库)';
    return where ? `${nm} (${where}/${str(d.database, 200)})` : nm;
  }

  /**
   * 把一个卡包里的库对应到本机的库。
   *
   * 三级: 指纹完全一致 → 名字一致 → 认不出 (留给用户手工指定)。
   * 名字匹配排在指纹后面: 两个库重名 (测试库和生产库都叫「订单库」) 时, 指纹是
   * 唯一靠得住的依据, 而名字匹配只是"总比没有强"。
   *
   * @param overrides { [packDbId]: localDbId } 用户在界面上手工指定的, 优先级最高
   */
  function buildMatchMap(pack, localDbs, overrides) {
    const locals = Array.isArray(localDbs) ? localDbs.filter((d) => d && str(d.id, 80)) : [];
    const ov = (overrides && typeof overrides === 'object') ? overrides : {};
    const out = {};
    for (const pdb of ((pack && pack.databases) || [])) {
      const key = str(pdb.id, 80);
      if (!key) continue;

      const manual = str(ov[key], 80).trim();
      if (manual) {
        const hit = locals.find((d) => str(d.id, 80) === manual);
        if (hit) { out[key] = { localId: hit.id, how: 'manual', packDb: pdb }; continue; }
      }
      if (pdb.missing || !pdb.fingerprint) { out[key] = { localId: '', how: 'none', packDb: pdb }; continue; }

      const exact = locals.find((d) => fingerprint(d) === pdb.fingerprint);
      if (exact) { out[key] = { localId: exact.id, how: 'exact', packDb: pdb }; continue; }

      const nm = str(pdb.name, 120).trim().toLowerCase();
      const byName = nm ? locals.find((d) => str(d.name, 120).trim().toLowerCase() === nm) : null;
      out[key] = byName
        ? { localId: byName.id, how: 'name', packDb: pdb }
        : { localId: '', how: 'none', packDb: pdb };
    }
    return out;
  }

  /** 映射关系里还有哪些库没落地 (导入界面要拦"依赖没接上的卡") */
  function unmatchedDbIds(matchMap) {
    return Object.keys(matchMap || {}).filter((k) => !matchMap[k].localId);
  }

  /**
   * 把一张卡里的库 id 换成对方的库 id。
   * 认不出的库**保留原 id 不动** —— 换成空串会抹掉作者的选择, 而保留原样的卡
   * 在界面上会明确显示"这个库本机没有", 用户补上库之后还能自己改回来。
   */
  function remapCard(card, matchMap) {
    const map = matchMap || {};
    const out = JSON.parse(JSON.stringify(card));
    const missing = new Set();

    const swap = (id) => {
      const key = str(id, 80);
      const hit = map[key];
      if (hit && hit.localId) return hit.localId;
      if (hit) missing.add(key);
      return key;
    };

    if (out.scope && typeof out.scope === 'object' && !Array.isArray(out.scope)) {
      const next = {};
      for (const k of Object.keys(out.scope)) {
        const local = swap(k);
        // 两个来源库映射到同一个本机库时, 表清单要合并而不是后一个盖掉前一个
        const tables = Array.isArray(out.scope[k]) ? out.scope[k] : [];
        next[local] = (next[local] || []).concat(tables);
      }
      for (const k of Object.keys(next)) next[k] = Array.from(new Set(next[k]));
      out.scope = next;
    }
    for (const n of (Array.isArray(out.nodes) ? out.nodes : [])) {
      if (n && n.type === 'query' && str(n.databaseId, 80).trim()) n.databaseId = swap(n.databaseId);
    }
    return { card: out, missing: Array.from(missing) };
  }

  const STRATEGIES = ['skip', 'overwrite', 'copy'];

  /**
   * 排导入计划: 每张卡是"新增 / 覆盖 / 另存为新卡 / 跳过"。
   *
   * 撞车按 **id 或 名字** 判: 同一个 id 必然是同一张卡的另一个版本 (覆盖就是了);
   * 名字一样但 id 不同, 多半是同事从你这导出去改了改又导回来 (这时候覆盖会把你
   * 本机的同名卡干掉, 所以由策略决定)。
   *
   * @param cards       已经 remap 过的卡
   * @param localEngines 本机现有的卡
   * @param strategy    skip / overwrite / copy
   * @param newId       生成新 id 的函数 (copy 用), 测试时可注入
   */
  function planImport(opts) {
    const o = opts || {};
    const strategy = STRATEGIES.includes(o.strategy) ? o.strategy : 'skip';
    const locals = Array.isArray(o.localEngines) ? o.localEngines.filter(Boolean) : [];
    const mkId = typeof o.newId === 'function' ? o.newId : genId;
    const cards = Array.isArray(o.cards) ? o.cards : [];

    // 本批已经排过的 id / 名字。不记的话, 同一个卡包里的两张同名卡会双双按
    // "新增"落地, 结果本机出现两张一模一样的卡。
    const batchIds = new Set();
    const batchNames = new Set();

    return cards.map((card, index) => {
      const id = str(card && card.id, 80);
      const name = str(card && card.name, 120).trim();
      const nameKey = name.toLowerCase();

      const byId = locals.find((e) => str(e.id, 80) === id) || null;
      const byName = locals.find((e) => str(e.name, 120).trim().toLowerCase() === nameKey) || null;
      const inBatch = batchIds.has(id) || batchNames.has(nameKey);
      const conflict = byId || byName || (inBatch ? { id, name } : null);

      let action;
      if (!conflict) action = 'add';
      else if (strategy === 'skip') action = 'skip';
      else if (strategy === 'overwrite') action = 'overwrite';
      else action = 'copy';

      let targetId = id;
      let targetName = name;
      if (action === 'overwrite') {
        // 撞的是**名字**而不是 id 时, 覆盖要落到那张本机卡身上 (用它的 id),
        // 否则导入完本机会出现两张同名的卡 —— 用户以为覆盖了, 其实是多了一张。
        if (byName && !byId) targetId = str(byName.id, 80);
        else if (inBatch && !byId && !byName) targetId = id;
      } else if (action === 'copy') {
        do { targetId = mkId('eng'); } while (batchIds.has(targetId) || locals.some((e) => str(e.id, 80) === targetId));
        targetName = (name || '未命名流程卡') + ' (导入)';
      }

      batchIds.add(targetId);
      batchNames.add((targetName || '').toLowerCase());

      return {
        index,
        card,
        action,
        targetId,
        targetName,
        sourceName: name,
        conflictWith: conflict ? { id: conflict.id, name: conflict.name } : null,
        conflictBy: byId ? 'id' : (byName ? 'name' : (inBatch ? 'batch' : ''))
      };
    });
  }

  /** 一张卡的摘要, 给导入/导出界面显示 */
  function cardStats(card) {
    const c = (card && typeof card === 'object') ? card : {};
    const dbIds = Array.from(collectDbIds(c));
    return {
      name: str(c.name, 120) || '未命名流程卡',
      description: str(c.description, 500),
      enabled: c.enabled !== false,
      nodes: (Array.isArray(c.nodes) ? c.nodes : []).length,
      queries: (Array.isArray(c.nodes) ? c.nodes : []).filter((n) => n && n.type === 'query').length,
      examples: (Array.isArray(c.examples) ? c.examples : []).length,
      dbIds
    };
  }

  /** 导出文件名: 单张用卡名, 多张用张数。带上日期, 免得下回来一堆重名文件。 */
  function suggestFileName(cards, stamp) {
    const day = (stamp || nowStamp()).slice(0, 10).replace(/-/g, '');
    const list = Array.isArray(cards) ? cards : [];
    if (list.length === 1) {
      // 卡名里可能有 \ / : * ? " < > | 这些字符, 直接当文件名会写不出去
      const safe = str(list[0] && list[0].name, 60).trim().replace(/[\\/:*?"<>|\s]+/g, '_') || '流程卡';
      return `${safe}.solodb-cards.json`;
    }
    return `流程卡包-${list.length}张-${day}.solodb-cards.json`;
  }

  return {
    FORMAT,
    FORMAT_VERSION,
    MAX_CARDS,
    MAX_BYTES,
    STRATEGIES,
    nowStamp,
    genId,
    fingerprint,
    dbBrief,
    dbLabel,
    collectDbIds,
    buildPack,
    stringifyPack,
    parsePack,
    buildMatchMap,
    unmatchedDbIds,
    remapCard,
    planImport,
    cardStats,
    suggestFileName
  };
});
