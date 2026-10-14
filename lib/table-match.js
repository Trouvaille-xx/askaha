/**
 * 选表匹配: 三级漏斗。
 *
 * ## 为什么要有这个模块
 *
 * 以前选表是一次模型调用 + 一份"表名: 备注"清单。DSC 那种 135 张表全勾、
 * 用户一条备注都没写的库里, 这个判据等于让模型看着表名猜 —— 而库里明明
 * 有一份写得极好的列注释 ("付款单号""选票批次 ID, 外键 → payment_select_bill.id"),
 * 一个字都没进提示词。实测: 需求里写着"付款单选票的付款单表", 它挑中的是
 * 注释逐字重合的 finance_payment_order_bill_callback (回调明细表), 打分 1.0,
 * 而真正装付款单号的那几张表连候选都没进。
 *
 * ## 三级漏斗 (而且不许变慢)
 *
 *   0. 值探测   (0 次模型调用) —— 需求里给了具体单号, 就拿这个值去候选表里各试一次。
 *                                这是**实测证据**, 比任何表名/注释的文本相似度都硬:
 *                                文本只能说"这表可能装付款单", 探测能说"这个号就在这一列里"。
 *   1. 词法预筛 (0 次模型调用) —— 把整库压成"详细候选"(带表注释 + 关键列注释) +
 *                                "其余表名"。提示词不变大, 该有的召回也还在。
 *   2. 一次模型调用            —— 判据从"表名 + 一句备注"升级成
 *                                "表名 + 表注释 + 关键列注释 + 实测命中情况",
 *                                并明确要求它说出"我没法从这些信息判断什么"。
 *
 * 速度从哪来:
 *   - 列注释走**一次** information_schema 查询 (database.schemaDigest, 带 10 分钟缓存),
 *     不是逐张表 DESCRIBE —— 135 张表也就是一次往返。
 *   - 探测全并发, 且有硬预算 (默认 6 秒) 与条数上限; 大表上没索引的列直接不试
 *     (那不是"慢", 是几十秒的全表扫)。
 *   - 提示词规模与旧版同量级: 详细候选封顶, 其余只给表名。
 *   - 任何一级拿不到东西都**降级**而不是失败: 没有 digest 就退回只看表名 + 备注,
 *     探测全超时就照旧用模型判断 —— 只是少一层证据, 不是整轮任务死掉。
 */

/** 需求里哪些词是"具体的值" —— 单号/编号这类可以直接拿去表里试的东西 */
const VALUE_PATTERNS = [
  // 字母前缀 + 长数字: D32026092200853340 / PO202508121092555 / DN2023012900006 / SO17893731586874737
  /[A-Za-z]{1,6}\d{8,}[A-Za-z0-9]*/g,
  // 纯长数字 (8 位以上): 订单号 / 流水号
  /(?<![\dA-Za-z])\d{8,}(?![\dA-Za-z])/g
];

/** 引号里那串东西通常就是用户想查的值 */
const QUOTED = /["'“”‘’]([A-Za-z0-9_\-]{5,64})["'“”‘’]/g;

/** 一列像不像"装着单号/编号"的那一列 */
const ID_COL = /(^|_)(no|num|number|code|serial|doc|order|bill|invoice|apply|sn|id)($|_)/i;
// 列注释里出现这些词 = "这一列装的是单据号"。
// 「请款单/款单/发票」是财务域的实词: DSC 实测真表那一列注释就一个字不差写着"请款单",
// 不认它, 那一列就进不了候选 —— 而它恰恰是全库唯一装着那两个单号的地方。
const ID_CMT = /单号|编号|序号|订单号|票号|单据|流水|凭证号|申请号|明细号|请款单|款单|发票/;

/**
 * 从需求里抽出可以直接拿去表里试的值。
 *
 * 宁少勿滥: 抽错了会白扫一遍表 (慢), 抽漏了只是少一层证据 (仍然有词法 + 模型)。
 * 所以只认两种形态 —— 带字母前缀的长编号、以及纯长数字; 引号里的小段也收。
 */
function extractValues(task, limit = 8) {
  const s = String(task == null ? '' : task);
  const out = [];
  const add = (v) => {
    const t = String(v || '').trim();
    if (t.length < 5 || t.length > 64) return;
    if (/^[\u4e00-\u9fa5]+$/.test(t)) return;      // 纯中文不是单号
    if (!/\d/.test(t)) return;                     // 一个数字都没有的多半是词, 不是号
    if (!out.includes(t)) out.push(t);
  };
  for (const re of VALUE_PATTERNS) {
    const r = new RegExp(re.source, 'g');
    let m;
    while ((m = r.exec(s))) add(m[0]);
  }
  const q = new RegExp(QUOTED.source, 'g');
  let m2;
  while ((m2 = q.exec(s))) add(m2[1]);
  return out.slice(0, limit);
}

/** 中文按 2~4 字滑窗 + 英文按词切开, 用来算"这张表跟需求沾不沾边" */
function tokenize(text) {
  const s = String(text == null ? '' : text);
  const terms = new Map(); // term -> 权重
  const bump = (t, w) => { if (!terms.has(t) || terms.get(t) < w) terms.set(t, w); };
  for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9_]{1,}/g)) bump(m[0].toLowerCase(), 1.5);
  for (const m of s.matchAll(/[\u4e00-\u9fa5]+/g)) {
    const seg = m[0];
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i + n <= seg.length; i++) {
        bump(seg.slice(i, i + n), n === 2 ? 1 : n === 3 ? 1.5 : 2);
      }
    }
  }
  return terms;
}

/** 把表名拆成可匹配的碎片 (payment_select_bill_payment -> payment select bill) */
function nameText(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
}

/**
 * 一张表跟需求的相关度。纯字符串, 不调模型 —— 它的活是**把清单压小**,
 * 不是下结论, 所以宁可宽松 (只要沾边就留下)。
 */
function scoreEntry(entry, terms) {
  const name = nameText(entry && entry.table);
  const note = String((entry && entry.note) || '').toLowerCase();
  const cols = (entry && entry.cols) || [];
  const colNames = cols.map((c) => nameText(c.field)).join(' ');
  const colCmts = cols.map((c) => String(c.comment || '')).join(' ').toLowerCase();
  let score = 0;
  for (const [term, w] of terms) {
    if (name.includes(term)) score += w * 3;
    else if (note.includes(term)) score += w * 2;
    else if (colNames.includes(term)) score += w * 1.5;
    else if (colCmts.includes(term)) score += w * 0.5;
  }
  return score;
}

/**
 * 把候选切成"详细"与"其余"两段。
 *
 * 详细段 = **跟需求有字面交集的表** (score > 0) + 探测命中的表, 上限 detailLimit。
 * 其余段**只给表名** —— 这样即使详细段漏掉了正主, 模型仍然看得见它 (召回不塌),
 * 而提示词也不会因为塞进 135 张表的注释而膨胀。
 *
 * 一个刻意的取舍: **不拿零分的表把详细段填满**。零分 = 与需求没有任何字符交集,
 * 给它配注释只是白占上下文 —— 上限是上限, 不是指标。
 *
 * 上限为什么是 12 (实测, 不是拍的):
 *   DSC 上跑 30 张 vs 12 张交替各 3 次: 提示词 13174 -> 9033 字符,
 *   模型思考量中位 8780 -> 5578 token, 墙上时间中位 58.0s -> 37.4s (省 36%)。
 *   生成速率稳定在 ~150 tok/s (三组数据都吻合), 所以"少给它看东西"直接等于"少想"。
 *   而**准确率信号没变**: 真表 finance_pass_log_payment_order_detail_from_bip
 *   探测优先级排第 3, 两版都在详细段里、"请款单"这个列注释两版都在提示词里。
 *   关键认识: 值探测的**证据**来自 probePlan (12 张) 和 untried 清单 (8 条),
 *   与详细段长度无关 —— 所以砍详细段只省时间, 不动证据。
 */
function splitCandidates({ candidates, digest, noteOf, terms, hitTables, detailLimit = 12 }) {
  const rows = candidates.map((name) => {
    const d = (digest && digest.get(name)) || null;
    const entry = {
      table: name,
      note: (noteOf && noteOf[name]) || (d && d.comment) || '',
      cols: (d && d.cols) || [],
      rows: d ? d.rows : null,
      dbName: d ? d.dbName : ''
    };
    return { name, entry, score: scoreEntry(entry, terms) };
  });
  rows.sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)));

  const hits = new Set(hitTables || []);
  const detail = [];
  const rest = [];
  // 命中的表先占位 —— 它们是硬证据, 不该因为"字面分低"被上限挤掉
  for (const r of rows) {
    if (hits.has(r.name) && detail.length < detailLimit) detail.push(r);
  }
  const inDetail = new Set(detail.map((d) => d.name));
  for (const r of rows) {
    if (inDetail.has(r.name)) continue;
    if (r.score > 0 && detail.length < detailLimit) { detail.push(r); inDetail.add(r.name); }
    else rest.push(r.name);
  }
  return { detail, rest, rows };
}

/**
 * 这张表里哪些列值得拿值去试。
 *
 * 排序 = "像单号列" 且 "带索引" 的最优先。大表上没索引的列不试 ——
 * 那不是慢一点, 是把一次任务卡在一列几十秒的全表扫上。
 */
function probeColumns(entry, { onlyIndexed = false } = {}) {
  const cols = ((entry && entry.cols) || []).filter((c) => typeof c.field === 'string');
  const scored = [];
  for (const c of cols) {
    const type = String(c.type || '').toLowerCase();
    const stringy = /char|text|clob|uuid|enum/.test(type);
    if (!stringy) continue;
    const byName = ID_COL.test(c.field);
    const byCmt = ID_CMT.test(String(c.comment || ''));
    if (!byName && !byCmt) continue;
    if (onlyIndexed && !c.indexed) continue;
    scored.push({ field: c.field, score: (byName ? 2 : 0) + (byCmt ? 2 : 0) + (c.indexed ? 1 : 0) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.field);
}

/**
 * 这张表值不值得拿去试 —— 决定探测预算先花在谁身上。
 *
 * 为什么不是"只试详细候选": **最需要探测的, 恰恰是字面对不上的那种表**。
 * DSC 那次就是 —— 真正装着这两个单号的是 `…_from_bip` 那张 763 万行的
 * 请款明细日志表, 说明只写着"bip返回的付款单状态", 跟用户那句"付款单选票"
 * 的字面相似度远不如那张名字几乎逐字重合的回调表。只按字面分挑探测对象,
 * 等于把唯一能戳穿误判的证据留在了门外。
 *
 * 所以排序看两件事: 字面相关度 + "它的列有多像一个单号列" (名字/注释/有没有索引)。
 * 返回 <= 0 表示"不值得试": 没有像单号的列, 或大表上那些列都没索引。
 */
function probePriority(entry, terms) {
  if (!entry) return 0;
  // 归一成 scoreEntry 认的形状: 它读的是 `.note`, 而摘要里的说明叫 `.comment`。
  // 直接把摘要条目传进去, 字面相关度会被**静默算成 0** —— 实测这会让真正装着单号的
  // 那张表 (注释"bip返回的付款单状态", 字面 16 分) 掉到第 59 名, 连探测计划都进不去。
  const norm = {
    table: entry.table, note: entry.comment || '',
    cols: entry.cols || [], rows: entry.rows
  };
  const big = Number(entry.rows) > 2000000;
  const all = probeColumns(entry, { onlyIndexed: false });
  if (!all.length) return 0;               // 连像单号的列都没有: 问都问不出来
  // 大表上"只有没索引的列"也要进计划 —— 不是去扫它, 而是让 untried 有机会记下
  // "这一列我们没验过"。把它整个排除在计划外, 就等于连"没验过"这个事实都丢了,
  // 后面那句"没有数据"会显得比实际可信 (DSC 那次就是这么错过 invoice 列的)。
  const cols = big ? probeColumns(entry, { onlyIndexed: true }) : all;
  const byField = new Map(((entry.cols) || []).map((c) => [c.field, c]));
  let best = 0;
  for (const f of all.slice(0, 3)) {
    const c = byField.get(f) || {};
    let s = (ID_COL.test(f) ? 2 : 0) + (ID_CMT.test(String(c.comment || '')) ? 2 : 0);
    if (c.indexed) s += 1;                 // 有索引 = 真能试, 优先
    else if (big) s -= 1;                  // 大表上没索引 = 只能记进 untried, 让位给能试的
    if (s > best) best = s;
  }
  if (!cols.length) best = Math.max(1, best - 2);
  return best * 2 + scoreEntry(norm, terms);
}

/**
 * 探测计划: 从全部候选里挑出"值得试"的表, 按价值排序, 取前 N 张。
 * 条数上限另有约束 (runProbes 的 maxQueries) —— 两层上限都要有,
 * 因为一张表可能有两三个候选列。
 */
function probePlan({ candidates, digest, terms, limit = 12 }) {
  return candidates
    .map((name) => ({ name, p: probePriority(digest && digest.get(name), terms) }))
    .filter((x) => x.p > 0)
    .sort((a, b) => b.p - a.p || String(a.name).localeCompare(String(b.name)))
    .slice(0, limit)
    .map((x) => x.name);
}

/** 按方言把值写成字符串字面量。**值是用户的话里来的, 必须转义, 不能拼错。** */
function literal(value, dialect) {
  const v = String(value);
  if (dialect === 'mysql') {
    return "'" + v.replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
  }
  // postgres / sqlite / mssql: 标准写法 —— 单引号翻倍; 反斜杠是普通字符
  return "N'" + v.replace(/'/g, "''") + "'";
}

function quoteIdent(name, dialect) {
  const s = String(name);
  if (dialect === 'mssql') return '[' + s.replace(/\]/g, ']]') + ']';
  if (dialect === 'mysql') return '`' + s.replace(/`/g, '``') + '`';
  return '"' + s.replace(/"/g, '""') + '"';
}

/** 一条探测 SQL: 这个值在这张表的这一列里存在吗 */
function probeSql({ table, column, value, dialect }) {
  const t = quoteIdent(table, dialect);
  const c = quoteIdent(column, dialect);
  const v = literal(value, dialect);
  const head = dialect === 'mssql' ? 'SELECT TOP 1 1 AS hit' : 'SELECT 1 AS hit';
  const tail = dialect === 'mssql' ? '' : ' LIMIT 1';
  return `${head} FROM ${t} WHERE ${c} = ${v}${tail}`;
}

/**
 * 并发探测, 带硬预算。
 *
 * 返回的 hits 是**实测证据**: 这个值确实出现在这张表的这一列里。
 * 超预算没回来的探测一律当"没试过"(进 untried), 不当"没命中" ——
 * 把"我没查完"说成"没有", 正是这个产品最不能犯的错。
 */
async function runProbes({ router, digest, tables, values, budgetMs = 6000, maxQueries = 16, perTable = 2, onQuery = null }) {
  const t0 = Date.now();
  const probes = { values: values.slice(), hits: [], misses: [], missedCols: [], untried: [], errors: [], tried: 0, elapsedMs: 0, degraded: '' };
  if (!values.length || !tables.length) { probes.elapsedMs = Date.now() - t0; return probes; }
  if (!router || typeof router.targetFor !== 'function') {
    probes.degraded = '这个数据源不支持值探测';
    probes.elapsedMs = Date.now() - t0;
    return probes;
  }

  const jobs = [];
  const triedTables = new Set();
  // 每张表最多试几条: perTable 列 × 值的个数
  const rounds = [];
  const colPlan = new Map();   // 表 -> 这次**打算**验的全部像单号列 (只有这些验完才算"清过")
  for (const name of tables) {
    const entry = (digest && digest.get(name)) || null;
    if (!entry) { probes.untried.push({ table: name, why: '没有字段信息' }); continue; }
    const big = Number(entry.rows) > 2000000;
    // 大表只试带索引的列; 小表随便试
    const all = probeColumns(entry, { onlyIndexed: false });
    let cols = probeColumns(entry, { onlyIndexed: big });
    if (!cols.length && !big) cols = all;
    // 大表上**没索引的**候选列: 不试 (全表扫不是慢, 是卡死), 但要**记下来**。
    // 这是 DSC 那次的关键缺口: 真正装着那两个单号的是
    // finance_pass_log_..._from_bip 的 invoice 列 (注释写着"请款单"),
    // 763 万行且没索引 —— 一声不响地跳过它, 模型就永远不知道"这一列我们没验过",
    // 于是那句"没有数据"显得比实际可信。写进 untried, 它就得如实对待 ——
    // 界面上也要原样摆给用户看 (哪一列装的是他们家的单号, 用户一眼就知道)。
    if (big) {
      for (const col of all) {
        if (!cols.includes(col)) probes.untried.push({ table: name, column: col, why: '表太大且该列没索引, 没试' });
      }
    }
    if (!cols.length) {
      if (!all.length) probes.untried.push({ table: name, why: big ? '表太大且没有像单号的列' : '没有像单号的列' });
      continue;
    }
    const planned = cols.slice(0, perTable);
    // 因为条数上限没轮到的列, 也算"没验过" —— 不写在这里, 那张表就会被当成"查过了"
    for (const col of all) {
      if (!planned.includes(col)) probes.untried.push({ table: name, column: col, why: '本次没试到' });
    }
    colPlan.set(name, planned);
    const pairs = [];
    for (const col of planned) for (const value of values) pairs.push({ table: name, column: col, value });
    if (pairs.length) rounds.push({ name, pairs, cols: planned });
  }

  // **广度优先**派发: 先给每张表发它的第一条查询, 再轮到第二轮。
  // 按表逐个发完 (深度优先) 的话, 16 条预算会被前 3~4 张表吃光 —— 而值探测要回答的
  // 是"哪张表装着这个号", 广度远比在单张表上多试一列重要。DSC 实测就是这样: 深度优先
  // 只覆盖到 4 张表, 改成广度优先同样 16 条能覆盖 12 张。
  for (let round = 0; jobs.length < maxQueries; round++) {
    let added = false;
    for (const r of rounds) {
      if (round >= r.pairs.length) continue;
      if (jobs.length >= maxQueries) break;
      jobs.push(r.pairs[round]);
      triedTables.add(r.name);
      added = true;
    }
    if (!added) break;
  }

  if (!jobs.length) {
    probes.degraded = probes.untried.length ? '没有可试的列' : '';
    probes.elapsedMs = Date.now() - t0;
    return probes;
  }

  let target = null;
  try { target = router.targetFor(tables[0]); } catch (e) { target = null; }
  const dialect = (target && target.dialect) || 'mysql';

  const run = async (job) => {
    const sql = probeSql({ ...job, dialect });
    if (onQuery) onQuery(sql);
    const r = await router.query(sql, { timeoutMs: budgetMs });
    const rows = (r && r.rows) || [];
    return { ...job, hit: rows.length > 0 };
  };

  const settled = await Promise.race([
    Promise.allSettled(jobs.map(run)),
    new Promise((resolve) => setTimeout(() => resolve(null), budgetMs))
  ]);

  probes.tried = jobs.length;
  const answered = new Set();
  if (settled) {
    settled.forEach((s, i) => {
      const job = jobs[i];
      answered.add(`${job.table}.${job.column}`);
      if (s.status === 'fulfilled' && s.value.hit) {
        probes.hits.push({ table: job.table, column: job.column, value: job.value });
      } else if (s.status === 'rejected') {
        probes.errors.push({ table: job.table, column: job.column, error: String((s.reason && s.reason.message) || s.reason).slice(0, 80) });
      }
    });
  } else {
    probes.degraded = `值探测超出 ${budgetMs} ms 预算, 没回来的当"没试过"`;
  }

  const hitTables = new Set(probes.hits.map((h) => h.table));
  for (const job of jobs) {
    if (hitTables.has(job.table)) continue;
    if (!answered.has(`${job.table}.${job.column}`) && !settled) {
      probes.untried.push({ table: job.table, column: job.column, why: '超时未返回' });
    }
  }
  // 按**列**记账: 哪些列是"所有的值都试过、都没命中"。
  // 这是最细、也最能站住的说法 —— 表级的"试过没有"太容易被误读成"整张表没有",
  // 而一张表常常只验了其中一两列 (DSC 实测: 只验了一列的大表被算成"试过没命中",
  // 跟"我没查"冒充"查了没有"是同一类错误, 只是方向反了)。
  const hitCols = new Set(probes.hits.map((h) => `${h.table}.${h.column}`));
  for (const [name, planned] of colPlan) {
    for (const col of planned) {
      const key = `${name}.${col}`;
      if (hitCols.has(key)) continue;
      const jobsFor = jobs.filter((j) => j.table === name && j.column === col);
      const allDispatched = values.every((v) => jobsFor.some((j) => j.value === v));
      const allAnswered = jobsFor.every((j) => answered.has(`${j.table}.${j.column}`));
      const hadError = probes.errors.some((e) => e.table === name && e.column === col);
      // 三个都要满足: 每个值都发过查询、都回来了、都没报错 —— 缺一个就只是"没验完"
      if (allDispatched && allAnswered && !hadError) probes.missedCols.push({ table: name, column: col });
    }
  }
  // 表级 misses 只留给"像单号的列**一列都没落下**"的表 —— 只要还有没验过的列,
  // 这张表就还没清干净, 不能说成"试过没有"。
  const untriedTables = new Set(probes.untried.filter((u) => u.column).map((u) => u.table));
  for (const name of tables) {
    if (!triedTables.has(name)) continue;
    if (probes.hits.some((h) => h.table === name)) continue;
    if (untriedTables.has(name)) continue;
    const planned = colPlan.get(name) || [];
    if (!planned.length) continue;
    const allDone = planned.every((c) => probes.missedCols.some((m) => m.table === name && m.column === c));
    if (allDone) probes.misses.push(name);
  }
  probes.elapsedMs = Date.now() - t0;
  return probes;
}

/** 探测结果 -> 给模型看的实测段落 */
function probesText(probes, untriedCols) {
  if (!probes || !probes.values.length) return '';
  const lines = ['## 已经拿这些值试过的结果 (这是实测, 比表名和注释都硬, 优先采信)',
    `试的值: ${probes.values.join(', ')}`];
  if (probes.hits.length) {
    for (const h of probes.hits) lines.push(`- 命中: ${h.table}.${h.column} ← ${h.value}`);
  }
  // 说"没有"的时候要说到列上: "这些列都试过, 没命中" 是能站住的;
  // "这些表没有" 站不住 —— 一张表往往只验了其中一两列。
  if (probes.missedCols && probes.missedCols.length) {
    lines.push('- 这些列**每个值都试过, 都没命中**: ' + probes.missedCols.map((m) => `${m.table}.${m.column}`).join(', '));
  }
  if (probes.misses.length) lines.push(`- 这些表的像单号列**全部**试过了, 都没有命中: ${probes.misses.join(', ')}`);
  if (untriedCols && untriedCols.length) {
    // 带上**列注释**: "这一列装的是请款单" 才是可用信息 —— 光说"有一张表没试成",
    // 模型没法把它跟自己正在找的那个号联系起来。
    const items = untriedCols.map((u) => `${u.table}.${u.column}`
      + (u.comment ? ` (注释: ${u.comment})` : '') + ` [${u.why}]`);
    lines.push(`- 没试成的列 (表太大或列没索引, 所以**没验过**): ${items.join('; ')}`);
  } else if (probes.untried.length) {
    const names = Array.from(new Set(probes.untried.map((u) => u.table)));
    lines.push(`- 没试成的表 (表太大 / 没有像单号的列 / 超时): ${names.join(', ')}`);
  }
  lines.push(probes.hits.length
    ? '- 命中的表是**证据**, 直接列为需要; 只在"没命中"的列上、不要因为名字像就当成有数据。'
    : '- 一条都没命中。**注意区分两种情况**: 上面那些"没命中的列"是确实没有;'
      + '而"没验过的列"是不知道 —— 不要把它当成"没有", 也不要换一张名字像的表硬凑出结果。');
  return lines.join('\n');
}

/**
 * 详细候选的一段: 表注释 + 关键列 (带列注释) —— 列注释才是判断"这表装什么"的硬证据 */
function detailLines(detail, { perTableCols = 8 } = {}) {
  return detail.map((row) => {
    const e = row.entry;
    let head = `- ${row.name}${e.dbName ? ` (库: ${e.dbName})` : ''}: ${e.note || '(无说明)'}`;
    const cols = (e.cols || [])
      .slice()
      .sort((a, b) => {
        const ai = ID_COL.test(a.field) || ID_CMT.test(String(a.comment || '')) ? 1 : 0;
        const bi = ID_COL.test(b.field) || ID_CMT.test(String(b.comment || '')) ? 1 : 0;
        return bi - ai;
      })
      .slice(0, perTableCols)
      .map((c) => `${c.field}${c.comment ? ` -- ${c.comment}` : ''}`);
    if (cols.length) head += `\n    列: ${cols.join(', ')}`;
    return head;
  });
}

/**
 * 选表提示词。
 *
 * 与旧版的关键差别 (每一条都是实测踩出来的):
 *
 *   1. 不再写"宁少勿多""只挑出 1 张是正常结果" —— 那句话会让它在一个需要
 *      JOIN 三张表的需求上只挑一张, 于是结构性地查不出数据。改成"最少需要哪几张
 *      (含 JOIN 链路)"。
 *   2. 明确要求它说出"我没法从表名/注释判断的那一点" —— 实测同一个模型在被允许
 *      说"不知道"时, 会自己指出"无法确认这个号是付款单号还是选票号", 而旧提示词
 *      下它只会硬挑一张并给出 1.0 的自信分。
 *   3. 把实测命中情况摆进去, 并规定"跟着证据走"。
 *   4. **明确告诉它表名不可靠** —— DSC 实测: 155 张表里 20 张的注释都写着"付款单",
 *      而模型仍然整份名单都照着英文表名里有没有 payment 来挑, 结果真正装着那两个
 *      单号的那张 (名字是 finance_pass_log_..._from_bip, 注释只写"bip返回的付款单状态",
 *      列注释写着 invoice -- 请款单) 一次都没被提到。表名是历史缩写, 注释才是口径。
 *   5. **只让它写一张清单**。旧形状要它把同一批表写两遍 (candidates 一遍 need 一遍),
 *      同一张表解释两次 —— DSC 实测这一次往返 124 秒, 是旧版的 6 倍, 而慢的原因
 *      大半是多写的那一遍。现在每张表只写一次, 用 need 标出"是不是必需"。
 */
function buildMatchPrompt({ task, detail, rest, probes, untriedCols, limit = 6 }) {
  return [
    '你是数据库分析助手. 下面是本次可访问的表及其说明 (来自人工备注或数据库注释).',
    '',
    '## 用户任务',
    String(task || ''),
    '',
    '## 详细候选 (有表说明与关键列注释)',
    detailLines(detail).join('\n') || '(没有)',
    '',
    rest.length ? `## 其余可访问的表 (只有表名)\n${rest.join(', ')}` : '',
    '',
    probesText(probes, untriedCols),
    '',
    '怎么判断 (按这个顺序想):',
    '1. 先看用户给的**值** (单号/编号): 它像哪一类单据? 上面哪一列的表说明/列注释跟它对得上?',
    '2. 再看**表注释和列注释**, 以它们为准 —— **表名不可靠**: 它们是英文简写, 很多表的名字跟',
    '   实际装的东西对不上 (比如名字里有 payment 的表未必装付款单)。名字像但注释对不上的, 分要压低。',
    '3. 最后给出回答这个问题**最少需要哪几张表** (上限 ' + limit + ' 张, 含 JOIN 链路 ——',
    '   只要一张不够就不要只写一张), 每张一句话说清依据。',
    '',
    '注意:',
    '- 只能从上面列出的表里选, 不要臆造表名.',
    '- 实测命中的表优先级最高; 实测显示试过没命中的表, 不要因为名字像就当成有数据.',
    '- "没试成"的表不等于"没数据" —— 表太大或没有像单号的列所以没试, 如实对待.',
    '- uncertain 里写清: 你**没法**从表名和注释判断的那一点 (比如"哪个列装的是这个单号")。',
    '',
    'JSON 形状 (只输出这一个对象, 不要解释文字):',
    '{"tables":[{"name":"","why":"依据, 20 字内","score":0.9,"need":true}],"uncertain":"","note":""}',
    `tables 最多 ${limit + 2} 条。**每一项都必须写 need**: need=true = 你真正要用的 (会拿去查);` +
    ' need=false = 只是"有点可能"的备选 (不会查, 只作参考)。' +
    '\n只列回答这个问题**最少需要哪几张表** (含 JOIN 链路); 只有"可能沾边"的一律 need=false ——' +
    ' **别一股脑都标 true**, 那会把查询范围撑得很大、又慢又容易连错表。'
  ].filter((x) => x !== '').join('\n');
}

/**
 * 解析模型返回。
 *
 * 主形状是 `{tables:[{name,why,score,need}]}`; 同时兼容三种老形状
 * (need / scored / candidates) —— 免得换回旧提示词时整条路失效。
 *
 * 关键: **`picked` 只取"必需"的那批**, 不是取全部候选。旧实现把 candidates 和 need
 * 合并后当 picked 用, DSC 实测直接把 scope 撑到 11 张表 —— 而"可能相关"这个清单
 * 天生就该比"要用的"长, 混在一起等于取消了这一步筛选。
 */
function parseMatch(raw, candidates) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
  }
  if (!parsed || typeof parsed !== 'object') return { scored: [], picked: [], uncertain: '', note: '' };
  const pick = (arr) => (Array.isArray(arr) ? arr : [])
    .map((x) => {
      if (typeof x === 'string') return { name: x, score: 0.5, reason: '', need: null };
      if (!x || typeof x !== 'object') return null;
      return {
        name: String(x.name || ''),
        score: typeof x.score === 'number' ? Math.max(0, Math.min(1, x.score)) : 0.5,
        reason: String(x.reason || x.why || '').slice(0, 60),
        // need 只认真正的布尔; 缺省 null = "没表态", 由调用方决定怎么解释
        need: typeof x.need === 'boolean' ? x.need : null
      };
    })
    .filter((x) => x && x.name);

  const merged = [];
  const add = (s) => { if (!merged.some((m) => m.name === s.name)) merged.push(s); };
  // 主形状是"AI 列的清单"(`tables[]`); 其余是更早的形状 —— 那几份清单**本身就是选中结果**。
  const mainShape = Array.isArray(parsed.tables) && parsed.tables.length > 0;
  for (const s of pick(parsed.tables)) add(s);          // 主形状
  for (const s of pick(parsed.need)) add(Object.assign({}, s, { need: true }));   // 老形状
  for (const s of pick(parsed.scored)) add(Object.assign({}, s, { need: true })); // 更老的形状
  for (const s of pick(parsed.candidates)) add(s);      // 老形状: 只是候选

  // 谁进 picked:
  //   主形状 (tables[]): **只取明确标了 need:true 的**。没标 = 不是必需。
  //     以前是"一张都没标就整份算必需", 而提示词当时还写着"need=false 可不写" ——
  //     于是模型一偷懒不表态, 它列出的几张表全被当必需, scope 被撑大
  //     (实测踩过: 一个"找销量最高的 10 个商品及其类目"的任务把表全选上了)。
  //   老形状: 那份清单本身就是"选中结果", 维持原语义 —— 标了 need 的按标记,
  //     一张都没标就全算必需 (向后兼容)。
  let picked;
  if (mainShape) {
    picked = merged.filter((m) => m.need === true).map((m) => m.name);
  } else {
    const anyFlag = merged.some((m) => m.need !== null);
    picked = merged.filter((m) => (anyFlag ? m.need === true : true)).map((m) => m.name);
  }

  return {
    scored: merged.slice(0, 12),
    picked: picked.slice(0, 12),
    uncertain: String(parsed.uncertain || '').slice(0, 200),
    note: String(parsed.note || '').slice(0, 200),
    candidates: pick(parsed.candidates)
  };
}

/**
 * 走完整条漏斗: 摘要 -> 预筛 -> 探测 -> 一次模型调用 -> 取交集。
 *
 * 返回里带着每一段的耗时 —— "加准确率不能靠悄悄变慢", 所以这件事必须可量化,
 * 而不是嘴上说"很快"。
 */
async function matchTables({ llm, router, task, candidates, noteOf, emit, opts = {} }) {
  const t0 = Date.now();
  const timing = { digest: 0, probe: 0, llm: 0, shortlist: 0 };
  const log = typeof emit === 'function' ? emit : () => {};
  const detailLimit = Number.isFinite(opts.detailLimit) ? opts.detailLimit : 12;
  const probeBudgetMs = Number.isFinite(opts.probeBudgetMs) ? opts.probeBudgetMs : 6000;
  const probeMaxQueries = Number.isFinite(opts.probeMaxQueries) ? opts.probeMaxQueries : 16;
  const out = { scored: [], picked: [], probes: null, uncertain: '', note: '', timing, degraded: [], untriedCols: [] };

  // ---- 0. 字段目录 (一次往返, 带缓存) ----
  let digest = null;
  if (router && typeof router.schemaDigest === 'function') {
    const d0 = Date.now();
    try { digest = await router.schemaDigest(); } catch (e) { digest = null; }
    timing.digest = Date.now() - d0;
  }
  if (!digest || !digest.size) {
    // 把**原因**带上: "目录为空"用户没法处理, "connect ETIMEDOUT" 他能立刻想到 VPN。
    // 这条降级路径不是小事 —— 它等于把整条链路退回旧行为 (不探测、不带列注释),
    // 也就是用户最初投诉的那个行为。必须让他看得见。
    const errs = (router && router.lastDigestErrors) || [];
    const why = errs.length ? errs.map((e) => `${e.dbName}: ${e.error}`).join('; ') : '';
    out.degraded.push('没有拿到字段目录, 退回到"只看表名 + 备注"' + (why ? ` (${why})` : ''));
  }
  const hasCols = !!(digest && Array.from(digest.values()).some((e) => (e.cols || []).length));

  // ---- 1. 词法预筛 + 值提取 (0 次模型调用) ----
  const s0 = Date.now();
  const terms = tokenize(task);
  const values = extractValues(task);
  const pre = splitCandidates({ candidates, digest, noteOf, terms, hitTables: [], detailLimit });
  timing.shortlist = Date.now() - s0;

  // ---- 2. 值探测 (并发 + 硬预算) ----
  // 探测对象从**全部候选**里挑 (不是只挑详细候选): 见 probePriority 的说明 ——
  // 最需要被探测的, 往往是字面对不上的那张表。
  const probeTables = values.length && hasCols
    ? probePlan({ candidates, digest, terms, limit: opts.probeTables || 12 })
    : [];
  if (values.length && hasCols) {
    log({ type: 'phase', phase: 'probe_values', message: `AI 正在拿单号去候选表里核对: ${values.join(', ')}` });
    out.probes = await runProbes({
      router, digest, tables: probeTables, values,
      budgetMs: probeBudgetMs, maxQueries: probeMaxQueries
    });
    timing.probe = out.probes.elapsedMs;
    if (out.probes.hits.length) {
      log({
        type: 'phase', phase: 'probe_hit',
        message: '值探测命中: ' + out.probes.hits.map((h) => `${h.table}.${h.column}`).join(', ')
      });
    }
  } else if (values.length) {
    out.probes = { values, hits: [], misses: [], missedCols: [], untried: [], errors: [], tried: 0, elapsedMs: 0, degraded: '没有字段目录, 试不了' };
  }

  // ---- 3. 一次模型调用 ----
  const hitTables = out.probes ? out.probes.hits.map((h) => h.table) : [];
  if (hitTables.length) {
    const withHits = new Set(hitTables);
    for (const r of pre.rows) {
      if (withHits.has(r.name) && !pre.detail.some((d) => d.name === r.name)) pre.detail.push(r);
    }
  }
  // 没验过的列 (带列注释, 最多 8 条): 既进提示词, 也交给界面显示。
  // 这是"值探测没能给答案"时**唯一**诚实且零成本的替代品: 把"哪一列装的是你们家的
  // 单号"这个问题还给用户 —— 他看一眼注释就知道, 而模型猜三次都是错的 (见第 4 节说明)。
  //
  // **必须排序再截断**: 像单号的列远多于预算 (DSC 实测 69 条), 不排的话前 8 条会被
  // create_user_code / update_user_code 这种"名字里恰好有个 code"的噪声列占满,
  // 真正写着"请款单"的那一列反而看不见 —— 那这条提示就等于没给。
  const untriedRank = (u) => {
    const e = digest && digest.get(u.table);
    const c = e && (e.cols || []).find((x) => x.field === u.column);
    const cmt = (c && c.comment) || '';
    let s = 0;
    if (ID_CMT.test(cmt)) s += 3;                 // 注释直接说了它装的是单据: 最该看
    if (ID_CMT.test(u.column)) s += 1;
    if (/没索引/.test(u.why || '')) s += 1;       // 大表上被跳过的, 比"本次没试到"更值得看
    const rows = e && Number(e.rows);
    if (rows > 0) s += Math.min(2, Math.log10(rows) / 3);   // 大表里更容易躺着历史单据
    return s;
  };
  out.untriedCols = (out.probes ? out.probes.untried : [])
    .filter((u) => u.column)
    .filter((u, i, a) => a.findIndex((x) => x.table === u.table && x.column === u.column) === i)
    .map((u) => {
      const e = digest && digest.get(u.table);
      const c = e && (e.cols || []).find((x) => x.field === u.column);
      return { table: u.table, column: u.column, comment: (c && c.comment) || '', why: u.why, _r: untriedRank(u) };
    })
    .sort((a, b) => b._r - a._r)
    .slice(0, 8)
    .map((u) => ({ table: u.table, column: u.column, comment: u.comment, why: u.why }));

  const prompt = buildMatchPrompt({
    task, detail: pre.detail, rest: pre.rest, probes: out.probes, untriedCols: out.untriedCols
  });
  const l0 = Date.now();
  let raw = '';
  // 优先走 chatStep: 它会带回 usage (真实 token 用量) 和 truncated。
  // chat() 只给一段字符串 —— 被截断时返回半截 JSON, 上层无从分辨, 只能当成
  // "模型没给推荐"然后静默退回手动选表。用量也拿不到, "这次为什么慢"就查不了。
  try {
    if (typeof llm.chatStep === 'function') {
      const step = await llm.chatStep([{ role: 'user', content: prompt }], []);
      raw = (step && step.content) || '';
      if (step && step.usage) {
        timing.tokens = { in: step.usage.input || 0, out: step.usage.output || 0 };
      }
      if (step && step.truncated) {
        // 配额用尽: 正文很可能只有半截。如实说, 并且让上层知道这次结果不可靠。
        out.degraded.push('模型输出被 max_tokens 截断, 这次的表清单可能不完整');
      }
    } else {
      raw = await llm.chat([{ role: 'user', content: prompt }]);
    }
  } catch (e) {
    out.degraded.push('模型调用失败: ' + String(e.message || e).slice(0, 80));
  }
  timing.llm = Date.now() - l0;
  timing.llmCalls = 1;

  let parsed = { scored: [], picked: [], uncertain: '', note: '' };
  if (raw) {
    let obj = null;
    try { obj = llm._extractJSON ? llm._extractJSON(raw) : JSON.parse(raw); } catch (e) { obj = null; }
    parsed = parseMatch(obj || raw, candidates);
  }
  out.scored = parsed.scored;
  out.uncertain = parsed.uncertain;
  out.note = parsed.note;

  // ---- 4. 合起来: 模型说"必需"的 ∪ 实测命中的 ----
  // 用 parsed.picked (只含必需的那批), 不是 out.scored (含"可能相关") —— 见 parseMatch。
  //
  // 一个**试过但撤掉**的做法, 记在这里免得下次又走一遍: 值探测一条都没命中时,
  // 再问模型一次"这些没验过的列里哪个最可能装这个值"。实测 (DSC, 3/3 次) 它稳定地
  // 指向 finance_payment_order_odoo_callback.payment_order_num ("用友付款单编号"),
  // 而真值在 finance_pass_log_..._from_bip.invoice ("请款单") —— 因为用户自己的话
  // 就是"付款单", 模型跟着这个词走, 换多少种问法都一样。代价还很高 (每次 27~53 秒),
  // 而且会把一张它本来没选的 760 万行大表塞进 scope。
  // 现在的做法是零成本的: 没验过的列原样写进提示词 + 摆到界面上, **让用户看** ——
  // "哪一列装的是我们家的单号"这件事, 用户一眼就知道, 模型猜三次都是错的。
  const picked = [];
  for (const n of parsed.picked) if (!picked.includes(n)) picked.push(n);
  // 命中的表直接进 (实测证据优先于文本判断), 但排在模型选中的后面
  for (const h of hitTables) if (!picked.includes(h)) picked.push(h);
  out.picked = picked;

  out.timing.total = Date.now() - t0;
  return out;
}

module.exports = {
  extractValues,
  tokenize,
  nameText,
  scoreEntry,
  splitCandidates,
  probeColumns,
  probePriority,
  probePlan,
  probeSql,
  literal,
  quoteIdent,
  runProbes,
  probesText,
  detailLines,
  buildMatchPrompt,
  parseMatch,
  matchTables
};
