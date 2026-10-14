/**
 * 多库路由器。
 *
 * 为什么需要它: 以前"当前数据库"是个全局单选 (activeDatabase), 通用问句只认它。
 * 库里配了第二个数据源之后, 用户没法在一次任务里跨库取数, 而且"使用"按钮
 * 到底在管什么也不直观。这里把概念换掉 —— 不再有"当前库", 改由**表名**
 * 反推它属于哪个库: 模型提出要查的表, 路由器按表名找到所属连接再发过去。
 *
 * 白名单仍然是用户勾过的表, 只是把所有库勾过的表合成一份, 所以"勾选"这个动作
 * 同时决定了"能访问什么"和"去哪张库取"。
 *
 * 设计取舍: 对外暴露的 inventory / describeTable / query / scopeLabel
 * 与单库的 Database 保持一致, Agent 那边不需要分情况处理。
 */

const Database = require('./database');

/**
 * 剥掉注释与**字符串字面量**, 但把反引号 / 双引号包着的**标识符**解开来。
 *
 * 不能直接用 database.js 的 sqlSkeleton: 那份骨架把反引号也当字符串边界抹成空白,
 * 那是为了 SQL 只读校验 (宁可少认几个字), 而这里正相反 —— `` `delivery_order` ``
 * 就是表名, 抹掉了就路由不了。单引号仍然是字符串 ('delivery_order' 多半是个值),
 * 所以照旧抹掉。
 */
function tableSkeleton(rawSql) {
  const s = String(rawSql == null ? '' : rawSql);
  const n = s.length;
  let out = '';
  let i = 0;
  while (i < n) {
    const ch = s[i];
    const next = s[i + 1];
    if (ch === '-' && next === '-') {
      const nl = s.indexOf('\n', i);
      i = nl === -1 ? n : nl;
      out += ' ';
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      out += ' ';
      continue;
    }
    // 单引号 = 字符串, 抹掉 (里面的表名不算数)
    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === "'") {
          if (s[j + 1] === "'") { j += 2; continue; }
          break;
        }
        j += 1;
      }
      i = j + 1 > n ? n : j + 1;
      out += ' ';
      continue;
    }
    // 反引号 / 双引号 = 标识符, 解开来 (内容留着, 引号去掉)
    if (ch === '`' || ch === '"') {
      let j = i + 1;
      let inner = '';
      while (j < n) {
        if (s[j] === ch) {
          if (s[j + 1] === ch) { inner += ch; j += 2; continue; }
          break;
        }
        inner += s[j];
        j += 1;
      }
      out += inner;
      i = j + 1 > n ? n : j + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

class DbRouter {
  /**
   * @param databases 全量库配置 [{id, name, type, tables:[{name,checked,note}], ...}]
   * @param openDb    开连接的工厂, 默认直接 new Database(conf)。测试里可换成桩。
   */
  constructor({ databases, openDb, dbIds }) {
    this.databases = Array.isArray(databases) ? databases : [];
    this.openDb = typeof openDb === 'function' ? openDb : (conf) => new Database(conf);
    this.pool = new Map(); // dbId -> Database 实例 (懒建, 用完统一关)
    this._tableMap = null; // 表名 -> { dbId, dbName }
    // 这次对话限定在哪些库里找表。空数组 / 不传 = 不限制 (全部库)。
    //
    // **只约束通用分析这条路。** 流程卡走的是 EngineRunner, 它拿的是全量
    // databases 配置 (见 lib/agent.js 的 _execEngine), 根本不经过这个类 ——
    // 所以"流程卡不受对话抬头里选的库影响"是结构上就成立的, 不是靠某个 if 绕开的。
    // 改这里的时候别顺手把 EngineRunner 也接上, 那会破坏这条约定。
    this.dbIds = Array.isArray(dbIds) && dbIds.length ? dbIds.slice() : null;
  }

  _conn(dbId) {
    if (!this.pool.has(dbId)) {
      const conf = this.databases.find((d) => d.id === dbId);
      if (!conf) throw new Error(`数据库不存在 (可能已被删除): ${dbId}`);
      this.pool.set(dbId, this.openDb(conf));
    }
    return this.pool.get(dbId);
  }

  /** 勾过表的库。没勾表的库不参与, 免得为了校验它白连一次。 */
  _activeConfs() {
    const base = this.databases.filter((d) => (d.tables || []).some((t) => t && t.checked && t.name));
    if (!this.dbIds) return base;
    // 用户在对话抬头里点了具体的库: 只在其中找表。选了但一张表都没勾的库
    // 本来就被 base 排掉了, 所以这里只是取交集。
    const want = new Set(this.dbIds);
    return base.filter((d) => want.has(d.id));
  }

  /** 表名 -> 所属库。只认勾过的表 (勾选即白名单)。 */
  _map() {
    if (this._tableMap) return this._tableMap;
    const map = new Map();
    for (const conf of this._activeConfs()) {
      for (const t of conf.tables || []) {
        if (!t || !t.checked || !t.name) continue;
        if (!map.has(t.name)) {
          map.set(t.name, { dbId: conf.id, dbName: conf.name || conf.id });
        } else if (map.get(t.name).dbId !== conf.id) {
          // 两个库里有同名表: 记下来, 路由时按"拿不准"处理
          map.get(t.name).ambiguous = true;
        }
      }
    }
    this._tableMap = map;
    return map;
  }

  /** 有没有勾过任何表 */
  hasAny() {
    return this._map().size > 0;
  }

  /**
   * 勾选清单 + 存在性核对。形状与 Database.inventory() 一致。
   * checked  = 勾过的 (含在库里其实不存在的)
   * resolved = 勾过且确实存在的
   * offline  = 连不上的库 (连不上就没法核对存在性, 但**不能因此让整轮任务死掉**)
   *
   * 关于 offline: 以前这里让连接错误直接抛出去, 注释理由是"静默吞掉会变成
   * '这些表不存在'这种误导性的错"。这个担心是对的, 但只给了两个选项 ——
   * 抛出去 (整轮任务死) 或吞掉 (说谎)。还有第三个, 严格更好:
   * **把失败当数据传下去**。
   *
   * 为什么必须这么做: 用户配了 4 个库, 其中 oms-01 走内网域名。没连 VPN 时
   * 它的 DNS 就解析不了 —— 于是"查另外 3 个库"这种完全正当的请求也会失败,
   * 用户看到的是 `getaddrinfo ENOTFOUND oms-01.example.com`。
   * 一个库连不上不该让整个产品不可用。
   *
   * 所以: 离线的库照常进 checked (用户确实勾了), 但不进 resolved (没核对过),
   * 并把失败原因放进 offline 让上层**说清楚** —— 不是吞掉, 是降级并且明说。
   */
  async inventory() {
    const checked = [];
    const resolved = [];
    const offline = [];
    for (const conf of this._activeConfs()) {
      const picked = (conf.tables || []).filter((t) => t && t.checked && t.name);
      const rec = picked.map((t) => ({
        name: t.name,
        // note 是用户自己写的; comment 是库里维护的 (探测时带回来的)。
        // 两个都往下传 —— 上层把它们合成"这张表是干什么的", 用户写的优先。
        note: t.note || '',
        comment: t.comment || '',
        dbId: conf.id,
        dbName: conf.name || conf.id
      }));
      checked.push(...rec);
      let existing;
      try {
        existing = await this._conn(conf.id).listTables();
      } catch (e) {
        offline.push({
          dbId: conf.id,
          dbName: conf.name || conf.id,
          // 库配置是**扁平**的: {id, name, type, host, port, database, user, password, tables}
          // 不是 {config:{host}}。sqlite 用 file。
          host: conf.host || conf.file || '',
          reason: friendlyDbError(e, conf)
        });
        continue;
      }
      const set = new Set(existing);
      resolved.push(...rec.filter((r) => set.has(r.name)));
    }
    return { checked, resolved, offline };
  }

  /** 界面上标一下这次涉及哪些库 */
  scopeLabel() {
    const names = Array.from(new Set(this._activeConfs().map((d) => d.name || d.id)));
    return names.join('、');
  }

  get type() {
    const types = Array.from(new Set(this._activeConfs().map((d) => d.type)));
    return types.length === 1 ? types[0] : 'multi';
  }

  /**
   * 某张表所在库的**连接 + 方言**。
   *
   * 给"要自己拼 SQL"的工具用 (标识符加引号、一条工具里跑好几段查询)。
   * 这类工具**不该走 query()** —— query() 是靠正则解析 SQL 里的表名来路由的,
   * 而拼出来的语句里表名带引号 (MySQL 是反引号), 走那条路等于把路由押在正则上。
   * 这里直接按表名查映射表, 跟 describeTable 用同一套判定。
   *
   * 方言是必须的: MySQL 只认反引号、SQL Server 只认方括号, 写错了不是"查不到",
   * 是整条 SQL 直接语法错误。全局的 this.type 在多库混合时只会给出 'multi', 用不了。
   *
   * 连接由池子管, 调用方**不要关它** (关了会把池子里的连接弄坏)。
   */
  targetFor(table) {
    const map = this._map();
    // 大小写不敏感: 表名是模型给的, 它可能写成 Delivery_Order。
    // 只按原样查会把这种完全合法的调用误拦掉。
    const lower = String(table == null ? '' : table).toLowerCase();
    let hit = map.get(table);
    if (!hit) {
      for (const [k, v] of map) { if (k.toLowerCase() === lower) { hit = v; break; } }
    }
    if (hit && hit.ambiguous) {
      throw new Error(`表 ${table} 在多个库里同名, 无法确定它在哪个库。请在表名里写清库名。`);
    }
    const conf = hit ? (this.databases.find((d) => d.id === hit.dbId) || null) : null;
    // 这里**没有**"只有一个库就退回它"的兜底。那是召回的逻辑, 不是边界的逻辑:
    // 有兜底的话, 清单外的表在一库场景下照样能查, "勾选即白名单"就成了空话。
    if (!conf) {
      throw new Error(`表 ${table} 不在已勾选的清单里, 查不了。请先到「数据库」页把它勾上。`);
    }
    return { db: this._conn(conf.id), dialect: conf.type || 'mysql', dbName: conf.name || conf.id };
  }

  /**
   * 这条 SQL 引用了哪几张表 —— **全部**, 包括没勾过的。
   *
   * 以前这里用 `known.includes(name)` 过滤, 只返回勾过的表名。后果是清单外的表
   * 根本不进结果, 后面的白名单校验就成了"永远通过": 勾了 5 张表, SQL 里写别的
   * 表照样能查出来。**要拦住清单外的表, 首先得看得见它们。**
   *
   * 认两种写法:
   *   1. FROM / JOIN 后面直接跟的标识符 (最准)
   *   2. FROM 后面的逗号列表 `FROM a, b` (老写法, 模型偶尔会用)
   * 子查询 `FROM (SELECT ...)` 跳过 —— 它里面的 FROM 会被下一轮循环单独认出来。
   */
  _tablesInSql(rawSql) {
    const skel = tableSkeleton(rawSql);
    const out = [];
    const add = (n) => { if (n && !out.includes(n)) out.push(n); };
    // 一个逗号段里的第一个标识符; 带库名前缀 (db.tbl) 时取最后一段
    const firstIdent = (seg) => {
      const m = /^\s*([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)?)/.exec(seg);
      if (!m) return '';
      const parts = m[1].replace(/[`"[\]]/g, '').split('.').map((x) => x.trim()).filter(Boolean);
      return parts[parts.length - 1] || '';
    };
    // 这一段后面还接得上表名 (可带别名), 才继续取下一段;
    // 接不上就说明 FROM 子句到头了 (碰到 WHERE / JOIN / 函数调用等)
    const moreTables = /^\s*[A-Za-z_$][\w$]*(\s*\.\s*[A-Za-z_$][\w$]*)?(\s+(as\s+)?[A-Za-z_$][\w$]*)?\s*,$/i;
    const STOP = /^(where|group|order|having|limit|union|join|inner|left|right|full|cross|on|using|as|set|values|window|qualify|for|lock)$/i;

    const re = /\b(from|join)\b/gi;
    let m;
    while ((m = re.exec(skel))) {
      const isJoin = m[1].toLowerCase() === 'join';
      const rest = skel.slice(m.index + m[1].length);
      if (/^\s*\(/.test(rest)) continue;              // 子查询, 里面的表另有 FROM
      const segs = isJoin ? [rest] : rest.split(',');
      for (const seg of segs) {
        const name = firstIdent(seg);
        if (!name || STOP.test(name)) break;
        add(name);
        if (isJoin || !moreTables.test(seg + ',')) break;
      }
    }
    return out;
  }

  /**
   * WITH x AS (...), y AS (...) 里定义的 CTE 名。
   *
   * 它们是这条 SQL 内部的临时表, 数据库里并不存在, 所以**不能**按白名单校验 ——
   * 不排除掉的话, 用户现有的、带 CTE 的流程卡会被全部误拦。
   * (实测用户的卡片大量使用 CTE, 如 monthly / ranked / top10。)
   */
  _cteNames(skel) {
    const out = [];
    const re = /(?:\bwith\b|,)\s*([A-Za-z_$][\w$]*)\s*(?:\([^)]*\))?\s+as\s*\(/gi;
    let m;
    while ((m = re.exec(skel))) out.push(m[1]);
    return out;
  }

  /**
   * 白名单边界: SQL 里出现的表必须都在勾选清单里。**这里不允许任何回退。**
   *
   * 召回 (判断该查哪个库) 需要宽容的兜底 —— "认不出来但只有一个库, 那就是它"。
   * 边界不能有这种兜底, 否则"勾选即白名单"就是一句空话。以前这两件事挤在
   * _route 里, 结果边界给召回让了路。
   *
   * 大小写不敏感: 清单里存的是 delivery_order, SQL 里写 Delivery_Order 是同一张表,
   * 不能因为大小写就误拦。
   */
  _assertKnown(names, skel) {
    const map = this._map();
    const known = new Set(Array.from(map.keys()).map((n) => n.toLowerCase()));
    const ctes = new Set(this._cteNames(skel).map((n) => n.toLowerCase()));
    const unknown = names.filter((n) => !known.has(n.toLowerCase()) && !ctes.has(n.toLowerCase()));
    if (!unknown.length) return;

    const active = this._activeConfs();
    const sample = Array.from(map.keys()).slice(0, 8);
    throw new Error(
      `SQL 里用到了没勾选的表: ${unknown.join('、')}。`
      + `只有「数据库」页里勾选过的表能查 (现在勾了 ${map.size} 张`
      + (sample.length ? `, 例如 ${sample.join(', ')}${map.size > sample.length ? ' …' : ''}` : '')
      + ')。要查这些表, 请先去勾上'
      + (active.length ? `; 当前参与路由的库: ${active.map((d) => d.name || d.id).join('、')}` : '')
      + '。'
    );
  }

  /** 决定这条 SQL 该发到哪个库 */
  _route(sql) {
    const skel = tableSkeleton(sql);
    const names = this._tablesInSql(sql);
    // 边界先过, 放在最前面 —— 免得后面任何一条分支把它绕过去。
    this._assertKnown(names, skel);

    const map = this._map();
    // 大小写不敏感的表名 -> 库, 只用于查找; 真正的键仍是清单里的原样写法
    const byLower = new Map();
    for (const [k, v] of map) {
      if (!byLower.has(k.toLowerCase())) byLower.set(k.toLowerCase(), v);
    }

    const hits = [];
    const ambiguous = [];
    for (const n of names) {
      const hit = map.get(n) || byLower.get(n.toLowerCase());
      if (!hit) continue;
      if (hit.ambiguous) ambiguous.push(n);
      if (!hits.some((h) => h.dbId === hit.dbId)) hits.push(hit);
    }

    if (ambiguous.length) {
      throw new Error(
        `表 ${ambiguous.join('、')} 在多个库里同名，无法确定查哪一个。请到"数据库"页只勾选其中的一张，或在表名里写清库名。`
      );
    }
    if (hits.length === 1) return hits[0];
    if (hits.length === 0) {
      // 没引用任何表 (SELECT 1 / SELECT NOW() 这种): 只勾了一个库就用它。
      // 这**不是**白名单的兜底 —— 白名单上面已经校验过了, 这里只是挑一个库来执行。
      const active = this._activeConfs();
      if (active.length === 1) return { dbId: active[0].id, dbName: active[0].name || active[0].id };
      throw new Error(
        `这条 SQL 没引用任何表, 但当前有 ${active.length} 个库, 无法确定查哪个。请在 SQL 里写出表名。`
      );
    }
    throw new Error(
      `这条 SQL 同时用到了 ${hits.map((h) => h.dbName).join('、')} 这些库的表。不同库在不同服务器上，一次查不完，请拆成几条分别取数。`
    );
  }

  async query(sql, opts) {
    const target = this._route(sql);
    return this._conn(target.dbId).query(sql, opts);
  }

  async describeTable(table) {
    const hit = this._map().get(table);
    if (hit && !hit.ambiguous) return this._conn(hit.dbId).describeTable(table);
    const active = this._activeConfs();
    if (active.length === 1) return this._conn(active[0].id).describeTable(table);
    throw new Error(`表 ${table} 不在已勾选的清单里, 无法确定它在哪个库。`);
  }

  /**
   * 全量"字段目录": 表名 -> {dbId, dbName, comment, rows, cols:[{field,type,comment,indexed}]}。
   *
   * 只覆盖**勾过的表** (勾选即白名单这条边界在这里也成立: 没勾的表连元数据都不该拿)。
   * 各库的摘要是并发拉的 —— 单库时就是一次往返, 多库时是 max(各库) 而不是 sum。
   * 连不上的库静默跳过 (它的表本来也不在 resolved 里), 不拖累其它库。
   *
   * 拿不到摘要 (sqlite / 库连不上 / 没权限读 information_schema) 时返回空 Map,
   * 调用方按"没有列信息"降级 —— 选表退回到只看表名 + 备注的旧行为, 而不是报错。
   */
  async schemaDigest() {
    const out = new Map();
    const confs = this._activeConfs();
    // 哪个库没拿到、为什么。上层会把它显示给用户 —— "目录为空"本身没有可操作性,
    // "DSC请款库: connect ETIMEDOUT" 才有 (用户能立刻想到 VPN)。
    const errors = [];
    const results = await Promise.all(confs.map(async (conf) => {
      const picked = new Set((conf.tables || []).filter((t) => t && t.checked && t.name).map((t) => t.name));
      let digest;
      try {
        const db = this._conn(conf.id);
        if (typeof db.schemaDigest !== 'function') {
          errors.push({ dbName: conf.name || conf.id, error: '该数据源不支持字段目录' });
          return null;
        }
        digest = await db.schemaDigest();
        // 底层把错误吞在 lastDigestError 里 (它必须返回"已经拿到的部分")
        if (db.lastDigestError && !digest.size) {
          errors.push({ dbName: conf.name || conf.id, error: db.lastDigestError });
        }
      } catch (e) {
        errors.push({ dbName: conf.name || conf.id, error: (e && e.message) || String(e) });
        return null; // 连不上 / 不支持: 跳过这个库
      }
      return { conf, picked, digest };
    }));

    for (const r of results) {
      if (!r) continue;
      for (const [name, entry] of r.digest) {
        if (!r.picked.has(name)) continue;      // 白名单外的表不进上下文
        if (out.has(name)) continue;            // 同名表: 保留先出现的那个, 路由那边会按"拿不准"处理
        out.set(name, {
          table: name,
          dbId: r.conf.id,
          dbName: r.conf.name || r.conf.id,
          comment: entry.comment || '',
          rows: entry.rows,
          cols: entry.cols || []
        });
      }
    }
    this.lastDigestErrors = errors;
    return out;
  }

  /** 各库实际有哪些表 (并集, 同名只算一个) */
  async listTables() {
    const out = new Set();
    for (const t of await this.listTablesDetailed()) out.add(t.name);
    return Array.from(out);
  }

  /**
   * 各库的表 + 注释 (并集)。
   *
   * 表名在多库之间可能重名, 所以每一条都带上 dbId / dbName, 上层要标"来自哪个库"
   * 才有依据。注释也一并带出来, 见 database.js 的 listTablesDetailed。
   *
   * 同名表**两边都保留**: 探测是用来给用户勾选的, 把重名的那张悄悄丢掉,
   * 用户会以为库里没有这张表。
   */
  async listTablesDetailed() {
    const out = [];
    const seen = new Set();
    for (const conf of this._activeConfs()) {
      const list = await this._conn(conf.id).listTablesDetailed();
      for (const t of list) {
        if (!t || !t.name) continue;
        const key = conf.id + '\u0000' + t.name;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          name: t.name,
          comment: t.comment || '',
          dbId: conf.id,
          dbName: conf.name || conf.id
        });
      }
    }
    return out;
  }

  async close() {
    const conns = Array.from(this.pool.values());
    this.pool.clear();
    for (const c of conns) {
      try { await c.close(); } catch (e) { /* 关不掉也不该挡住主流程 */ }
    }
  }
}

/**
 * 把数据库驱动的原始错误翻译成用户能看懂的一句话。
 *
 * 为什么必须翻译: `getaddrinfo ENOTFOUND oms-01.example.com` 对一个
 * 业务用户等于没说话 —— 他不知道这是 DNS、不知道该怎么办。
 * 而这类错误的成因高度集中, 全都可以给出可执行的下一步。
 *
 * 拿不准的**原样返回**, 不要编一个解释: 编错了比不解释更耽误事。
 */
function friendlyDbError(err, conf) {
  const raw = String((err && err.message) || err || '');
  const host = (conf && (conf.host || conf.file)) || '';
  const where = conf && conf.name ? `「${conf.name}」` : '';

  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) {
    return `连不上${where}${host ? ' (' + host + ')' : ''}: 域名解析失败。`
      + '通常是没连 VPN / 内网不通, 或者主机名写错了。';
  }
  if (/ETIMEDOUT|timeout|timed out/i.test(raw)) {
    return `连不上${where}${host ? ' (' + host + ')' : ''}: 连接超时。检查网络或防火墙。`;
  }
  if (/ECONNREFUSED/i.test(raw)) {
    return `连不上${where}${host ? ' (' + host + ')' : ''}: 端口拒绝连接。库没启动, 或端口不对。`;
  }
  if (/ER_ACCESS_DENIED|28P01|authentication failed|password authentication/i.test(raw)) {
    return `登录${where}失败: 账号或密码不对。请到「数据库」页重新填写。`;
  }
  if (/ER_BAD_DB_ERROR|3D000|database .* does not exist/i.test(raw)) {
    return `登录${where}失败: 库名不存在。请到「数据库」页核对。`;
  }
  return `连不上${where}: ${raw}`;
}

module.exports = DbRouter;
