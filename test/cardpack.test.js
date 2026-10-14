'use strict';

/**
 * 流程卡包 (lib/cardpack.js) —— 导入导出的全部纯逻辑。
 *
 * 这一块值得单独测的原因: 它天然是"跨机器"的代码, 而跨机器出问题是**看不见**的
 * —— 导进来的卡指向了不存在的库 id, 界面上只是这张卡永远跑不出结果, 没有报错。
 * 所以这里把三件事钉死:
 *   1. 卡包里绝不出现口令/用户名 (这是分享卡最容易犯的错);
 *   2. 库的对应关系靠指纹而不是 id (id 是每台机器各生成一份的时间戳);
 *   3. 同名卡的四种处理都要落到正确的那张卡上 (尤其"按名字覆盖"不能变成"多一张")。
 *
 * 夹具里有两组库, 代表两台机器上**同一个库的不同 id**:
 *   srcDbs   —— 来源机器 (id 是 db_a / db_b, 卡里引用的就是它们)
 *   localDbs —— 目标机器 (同一个库, id 是时间戳)
 * 两者的指纹相同。搞混这两组, 测试就会在"库全都对不上"的前提下空转。
 */

const test = require('node:test');
const assert = require('node:assert');

const CP = require('../lib/cardpack.js');

/* ---------- 夹具 ---------- */

function db(id, over) {
  return Object.assign({
    id,
    name: id.toUpperCase(),
    type: 'mysql',
    host: id + '.example.com',
    port: 3306,
    database: id + '_db',
    user: 'db_user',
    password: 'secret-pw'
  }, over || {});
}

/** 来源机器上的库 */
const srcDbs = [db('db_a'), db('db_b')];

/** 目标机器: 同样的库, id 完全不同 (时间戳 id 的必然结果) */
const localDbs = [
  db('db_a', { id: 'db_1789439222631' }),
  db('db_b', { id: 'db_1789439222999' })
];

function card(id, over) {
  return Object.assign({
    id,
    name: '卡-' + id,
    description: '说明',
    enabled: true,
    examples: ['怎么查'],
    scope: { db_a: ['orders', 'users'] },
    nodes: [
      { id: 'n1', type: 'input', title: '入口', fields: [{ key: 'no', label: '单号' }] },
      { id: 'n2', type: 'query', title: '取数', databaseId: 'db_a', table: 'orders', sql: 'select 1' },
      { id: 'n3', type: 'output', title: '出口', template: '{{n2.rows}}' }
    ],
    edges: [{ from: 'n1', to: 'n2', port: 'out' }, { from: 'n2', to: 'n3', port: 'out' }],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z'
  }, over || {});
}

/** 一张**只**引用指定库的卡。测试里最常问的就是"这张卡接的是哪个库", 所以单开一个。 */
function cardOn(dbId, over) {
  return card('eng_' + dbId, Object.assign({
    id: 'eng_' + dbId,
    name: '卡-' + dbId,
    scope: { [dbId]: ['orders', 'users'] },
    nodes: [
      { id: 'n1', type: 'input', title: '入口', fields: [{ key: 'no', label: '单号' }] },
      { id: 'n2', type: 'query', title: '取数', databaseId: dbId, table: 'orders', sql: 'select 1' },
      { id: 'n3', type: 'output', title: '出口', template: '{{n2.rows}}' }
    ]
  }, over || {}));
}

/* ---------- 指纹与打包 ---------- */

test('指纹: 同一个库在两台机器上指纹相同, 不同库指纹不同', () => {
  assert.strictEqual(CP.fingerprint(srcDbs[0]), CP.fingerprint(localDbs[0]), 'id 不同不代表库不同');
  assert.notStrictEqual(CP.fingerprint(srcDbs[0]), CP.fingerprint(srcDbs[1]));
});

test('指纹: 大小写与空格不影响 (主机名本来就不敏感)', () => {
  const a = db('db_a');
  const b = db('db_a', { host: ' DB_A.EXAMPLE.COM ', database: 'DB_A_DB' });
  assert.strictEqual(CP.fingerprint(a), CP.fingerprint(b));
});

test('指纹: 端口不同就是不同的库', () => {
  assert.notStrictEqual(CP.fingerprint(db('db_a')), CP.fingerprint(db('db_a', { port: 3307 })));
});

test('指纹: sqlite 的 host/port 留空, 身份就是那个库文件', () => {
  const f = CP.fingerprint({ id: 'x', type: 'sqlite', database: 'C:\\data\\a.db' });
  assert.strictEqual(f, 'sqlite|||c:\\data\\a.db', '四段固定: 类型|主机|端口|库');
  // 大小写不敏感 (Windows 路径本来就不敏感)
  assert.strictEqual(f, CP.fingerprint({ id: 'x', type: 'sqlite', database: 'C:\\DATA\\A.DB' }));
});

test('打包: 只带这些卡用到的库, 不倒本机全部库', () => {
  const pack = CP.buildPack({
    cards: [cardOn('db_a')],
    databases: srcDbs.concat([db('db_unused')]),
    now: '2026-09-21 15:00'
  });
  assert.strictEqual(pack.databases.length, 1, '没用到的库不该出现在卡包里');
  assert.strictEqual(pack.databases[0].id, 'db_a');
  assert.strictEqual(pack.databases[0].fingerprint, CP.fingerprint(db('db_a')));
});

test('打包: **口令和用户名一个字节都不能出现**', () => {
  const pack = CP.buildPack({ cards: [cardOn('db_a')], databases: srcDbs });
  const text = CP.stringifyPack(pack);
  assert.ok(!text.includes('secret-pw'), '口令泄进卡包了');
  assert.ok(!text.includes('db_user'), '用户名泄进卡包了');
  assert.strictEqual(pack.databases.length, 1, '这一条要有真库在里面才有意义');
  for (const d of pack.databases) {
    assert.strictEqual(d.password, undefined);
    assert.strictEqual(d.user, undefined);
  }
});

test('打包: 库被删掉后卡还引用着它 —— 记一条 missing, 不是静默丢掉', () => {
  const pack = CP.buildPack({ cards: [cardOn('db_gone')], databases: srcDbs });
  assert.strictEqual(pack.databases.length, 1);
  assert.strictEqual(pack.databases[0].id, 'db_gone');
  assert.strictEqual(pack.databases[0].missing, true);
});

test('打包: 创建/更新时间不带出去 (那是来源机器上的事实)', () => {
  const pack = CP.buildPack({ cards: [cardOn('db_a')], databases: srcDbs });
  assert.strictEqual(pack.cards[0].createdAt, undefined);
  assert.strictEqual(pack.cards[0].updatedAt, undefined);
  assert.strictEqual(pack.cards[0].nodes.length, 3, '节点这些内容要原样带上');
});

test('打包: collectDbIds 同时认得 scope 的键和取数节点选的库', () => {
  const c = card('eng1', {
    scope: { db_a: ['t'], db_c: ['u'] },
    nodes: [{ id: 'n2', type: 'query', databaseId: 'db_b', table: 't', sql: 's' }]
  });
  assert.deepStrictEqual(Array.from(CP.collectDbIds(c)).sort(), ['db_a', 'db_b', 'db_c']);
});

/* ---------- 解析 ---------- */

test('解析: 正常的包能读回来', () => {
  const pack = CP.buildPack({ cards: [cardOn('db_a')], databases: srcDbs, app: { name: 'SoloDB', version: '0.2.0' } });
  const r = CP.parsePack(CP.stringifyPack(pack));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.pack.cards.length, 1);
  assert.strictEqual(r.pack.app.version, '0.2.0');
  assert.strictEqual(r.pack.databases[0].fingerprint, CP.fingerprint(db('db_a')));
});

test('解析: 各种坏文件都给一句人话, 不是抛异常', () => {
  assert.match(CP.parsePack('').error, /空/);
  assert.match(CP.parsePack('   ').error, /空/);
  assert.match(CP.parsePack('{').error, /JSON/);
  assert.match(CP.parsePack('[1,2]').error, /不是一个卡包/);
  assert.match(CP.parsePack('{"a":1}').error, /不是流程卡包/);
  assert.match(CP.parsePack('{"format":"solodb.cardpack"}').error, /formatVersion/);
  assert.match(CP.parsePack('{"format":"solodb.cardpack","formatVersion":1}').error, /没有 cards/);
  assert.match(CP.parsePack('{"format":"solodb.cardpack","formatVersion":1,"cards":[]}').error, /一张卡都没有/);
});

test('解析: 来自更新版本的卡包要拦下, 并说明原因', () => {
  const r = CP.parsePack(JSON.stringify({
    format: 'solodb.cardpack', formatVersion: 99, cards: [cardOn('db_a')]
  }));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /更新的版本/);
});

test('解析: 超过张数上限的包要拦下', () => {
  const cards = [];
  for (let i = 0; i <= CP.MAX_CARDS; i++) cards.push(cardOn('db_a', { id: 'eng_' + i, name: '卡' + i }));
  const r = CP.parsePack(JSON.stringify({ format: 'solodb.cardpack', formatVersion: 1, cards }));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /最多 500 张/);
});

test('解析: 缺 id / 缺 nodes 的卡要指出是第几张', () => {
  const head = { format: 'solodb.cardpack', formatVersion: 1 };
  const r1 = CP.parsePack(JSON.stringify(Object.assign({}, head, { cards: [{ nodes: [] }] })));
  assert.match(r1.error, /第 1 张卡没有 id/);
  const r2 = CP.parsePack(JSON.stringify(Object.assign({}, head, { cards: [cardOn('db_a'), { id: 'x' }] })));
  assert.match(r2.error, /第 2 张卡没有 nodes/);
});

test('解析: 卡包里的指纹一概重算, 手改文件改不动对应关系', () => {
  const raw = JSON.stringify({
    format: 'solodb.cardpack',
    formatVersion: 1,
    cards: [cardOn('db_a')],
    databases: [{
      id: 'db_a', name: 'A', type: 'mysql', host: 'evil.example.com', port: 3306, database: 'x',
      // 伪造一个指向本机真实库的指纹: 若信任文件里这份, 卡就会被接到别的库上
      fingerprint: CP.fingerprint(db('db_a'))
    }]
  });
  const r = CP.parsePack(raw);
  assert.strictEqual(r.ok, true);
  assert.notStrictEqual(r.pack.databases[0].fingerprint, CP.fingerprint(db('db_a')));
  assert.strictEqual(r.pack.databases[0].fingerprint, CP.fingerprint(db('db_a', { host: 'evil.example.com', database: 'x' })));
  // 于是它匹配不到本机任何一个库 —— 正是我们要的结果
  assert.strictEqual(CP.buildMatchMap(r.pack, localDbs).db_a.localId, '');
});

/* ---------- 库的对应 ---------- */

test('对应: 指纹一致就算同一个库, 与 id 无关', () => {
  const pack = CP.buildPack({ cards: [cardOn('db_a')], databases: srcDbs });
  const map = CP.buildMatchMap(pack, localDbs);
  assert.strictEqual(map.db_a.localId, 'db_1789439222631');
  assert.strictEqual(map.db_a.how, 'exact');
});

test('对应: 指纹认不出时退回名字, 并标成 name (不是 exact)', () => {
  const pack = CP.buildPack({ cards: [cardOn('db_a')], databases: [db('db_a', { host: 'other.host' })] });
  const map = CP.buildMatchMap(pack, localDbs);
  assert.strictEqual(map.db_a.localId, 'db_1789439222631');
  assert.strictEqual(map.db_a.how, 'name', '靠名字匹配必须如实标出来, 界面上要提示它没验过');
});

test('对应: 都不认得出就留空, 交给用户手工指认', () => {
  const pack = CP.buildPack({ cards: [cardOn('db_x')], databases: [db('db_x', { name: '陌生库' })] });
  const map = CP.buildMatchMap(pack, localDbs);
  assert.strictEqual(map.db_x.localId, '');
  assert.strictEqual(map.db_x.how, 'none');
  assert.deepStrictEqual(CP.unmatchedDbIds(map), ['db_x']);
});

test('对应: 用户手工指定的优先级最高', () => {
  const pack = CP.buildPack({ cards: [cardOn('db_a')], databases: srcDbs });
  const map = CP.buildMatchMap(pack, localDbs, { db_a: 'db_1789439222999' });
  assert.strictEqual(map.db_a.localId, 'db_1789439222999');
  assert.strictEqual(map.db_a.how, 'manual');
});

test('对应: 手工指定了一个本机不存在的 id, 当没指定 (不能信界面传来的值)', () => {
  const pack = CP.buildPack({ cards: [cardOn('db_a')], databases: srcDbs });
  const map = CP.buildMatchMap(pack, localDbs, { db_a: 'db_不存在' });
  assert.strictEqual(map.db_a.localId, 'db_1789439222631', '该退回自动匹配, 而不是留一个悬空 id');
});

test('对应: 来源机器上就缺的库, 不给它编一个对应', () => {
  const pack = CP.buildPack({ cards: [cardOn('db_gone')], databases: srcDbs });
  const map = CP.buildMatchMap(pack, localDbs);
  assert.strictEqual(map.db_gone.localId, '');
});

/* ---------- 换 id ---------- */

test('换 id: scope 的键和取数节点都要换成本机的库 id', () => {
  const pack = CP.buildPack({ cards: [cardOn('db_a')], databases: srcDbs });
  const map = CP.buildMatchMap(pack, localDbs);
  const { card: out, missing } = CP.remapCard(pack.cards[0], map);
  assert.strictEqual(out.nodes[1].databaseId, 'db_1789439222631');
  assert.deepStrictEqual(out.scope, { db_1789439222631: ['orders', 'users'] });
  assert.deepStrictEqual(missing, []);
});

test('换 id: 认不出的库保留原 id 不动, 并报进 missing (不是悄悄换成空串)', () => {
  const pack = CP.buildPack({ cards: [cardOn('db_gone')], databases: srcDbs });
  const map = CP.buildMatchMap(pack, localDbs);
  const { card: out, missing } = CP.remapCard(pack.cards[0], map);
  assert.strictEqual(out.nodes[1].databaseId, 'db_gone', '原来的选择要留着, 用户补上库之后还能自己改回来');
  assert.deepStrictEqual(missing, ['db_gone']);
});

test('换 id: 两个来源库映射到同一个本机库时, 表清单合并而不是后者盖前者', () => {
  const c = card('eng1', {
    scope: { db_a: ['orders'], db_b: ['users'] },
    nodes: [{ id: 'n2', type: 'query', databaseId: 'db_a', table: 'orders', sql: 's' }]
  });
  const pack = CP.buildPack({ cards: [c], databases: srcDbs });
  // 两个来源库都指到本机同一个库
  const map = CP.buildMatchMap(pack, localDbs, {
    db_a: 'db_1789439222631',
    db_b: 'db_1789439222631'
  });
  const { card: out } = CP.remapCard(pack.cards[0], map);
  assert.deepStrictEqual(out.scope.db_1789439222631, ['orders', 'users']);
});

test('换 id: 不改动传进来的那张卡 (界面上的预览还要用原对象)', () => {
  const pack = CP.buildPack({ cards: [cardOn('db_a')], databases: srcDbs });
  const before = JSON.stringify(pack.cards[0]);
  CP.remapCard(pack.cards[0], CP.buildMatchMap(pack, localDbs));
  assert.strictEqual(JSON.stringify(pack.cards[0]), before);
});

/* ---------- 导入计划 ---------- */

const existing = [
  { id: 'eng_local1', name: '对账排查' },
  { id: 'eng_shared', name: '缺货分析' }
];

test('计划: 全新卡一律"新增", id 原样保留', () => {
  const [e] = CP.planImport({ cards: [card('eng_new')], localEngines: existing });
  assert.strictEqual(e.action, 'add');
  assert.strictEqual(e.targetId, 'eng_new');
  assert.strictEqual(e.conflictWith, null);
});

test('计划 skip: 同名同 id 的跳过, 并说清撞的是哪张', () => {
  const [e] = CP.planImport({ cards: [card('eng_shared', { name: '缺货分析' })], localEngines: existing, strategy: 'skip' });
  assert.strictEqual(e.action, 'skip');
  assert.strictEqual(e.conflictBy, 'id');
  assert.strictEqual(e.conflictWith.name, '缺货分析');
});

test('计划 overwrite: 撞 id 时覆盖同一张', () => {
  const [e] = CP.planImport({ cards: [card('eng_shared', { name: '缺货分析' })], localEngines: existing, strategy: 'overwrite' });
  assert.strictEqual(e.action, 'overwrite');
  assert.strictEqual(e.targetId, 'eng_shared');
});

test('计划 overwrite: **撞名字但 id 不同**时要落到本机那张卡上, 不能变成两张同名卡', () => {
  const [e] = CP.planImport({
    cards: [card('eng_other_id', { name: '缺货分析' })],
    localEngines: existing,
    strategy: 'overwrite'
  });
  assert.strictEqual(e.conflictBy, 'name');
  assert.strictEqual(e.action, 'overwrite');
  assert.strictEqual(e.targetId, 'eng_shared', '覆盖必须用本机那张卡的 id');
});

test('计划 copy: 换新 id 并改名字, 本机那张原封不动', () => {
  const [e] = CP.planImport({
    cards: [card('eng_shared', { name: '缺货分析' })],
    localEngines: existing,
    strategy: 'copy'
  });
  assert.strictEqual(e.action, 'copy');
  assert.notStrictEqual(e.targetId, 'eng_shared');
  assert.strictEqual(e.targetName, '缺货分析 (导入)');
});

test('计划: 同一个包里两张同名卡, 第二张不能再算"新增"', () => {
  const cards = [card('e1', { name: '重复的卡' }), card('e2', { name: '重复的卡' })];
  const plan = CP.planImport({ cards, localEngines: [], strategy: 'skip' });
  assert.strictEqual(plan[0].action, 'add');
  assert.strictEqual(plan[1].action, 'skip');
  assert.strictEqual(plan[1].conflictBy, 'batch');
});

test('计划: copy 生成的新 id 不会跟本机或本批里已有的撞', () => {
  const cards = [card('eng_shared', { name: '缺货分析' }), card('eng_shared', { name: '缺货分析' })];
  const plan = CP.planImport({ cards, localEngines: existing, strategy: 'copy' });
  const ids = plan.map((p) => p.targetId);
  assert.strictEqual(new Set(ids).size, 2, '两张卡必须拿到不同的新 id');
  for (const id of ids) assert.ok(!existing.some((e) => e.id === id), '新 id 不能撞本机的卡');
});

test('计划: 大小写和首尾空格不构成"不同的卡名"', () => {
  const [e] = CP.planImport({
    cards: [card('eng_zzz', { name: '  缺货分析 ' })],
    localEngines: existing,
    strategy: 'skip'
  });
  assert.strictEqual(e.action, 'skip');
  assert.strictEqual(e.conflictBy, 'name');
});

test('计划: 认不出的策略退回 skip (宁可少导, 不可乱覆盖)', () => {
  const [e] = CP.planImport({ cards: [card('eng_shared', { name: '缺货分析' })], localEngines: existing, strategy: '乱写' });
  assert.strictEqual(e.action, 'skip');
});

/* ---------- 界面要用的摘要 ---------- */

test('摘要: 数得清节点、取数节点、示例和依赖的库', () => {
  const s = CP.cardStats(cardOn('db_a'));
  assert.strictEqual(s.nodes, 3);
  assert.strictEqual(s.queries, 1);
  assert.strictEqual(s.examples, 1);
  assert.deepStrictEqual(s.dbIds, ['db_a']);
});

test('摘要: 空卡不炸', () => {
  const s = CP.cardStats(null);
  assert.strictEqual(s.name, '未命名流程卡');
  assert.strictEqual(s.nodes, 0);
});

test('文件名: 单张用卡名, 多张用张数, 都要能安全落盘', () => {
  assert.strictEqual(CP.suggestFileName([card('e', { name: '对账排查' })]), '对账排查.solodb-cards.json');
  // 卡名里带 \ / : 这类字符时直接当文件名会写不出去
  const bad = CP.suggestFileName([card('e', { name: 'a/b:c*d?e"f<g>h|i' })]);
  assert.ok(!/[\\/:*?"<>|]/.test(bad), '文件名里还有非法字符: ' + bad);
  assert.match(CP.suggestFileName([card('a'), card('b')], '2026-09-21 15:00'), /^流程卡包-2张-20260921\.solodb-cards\.json$/);
});

test('文件名: 没名字的卡也有文件名', () => {
  assert.strictEqual(CP.suggestFileName([{ id: 'x', name: '   ' }]), '流程卡.solodb-cards.json');
});

test('库的描述: 网络库带主机端口, sqlite 就是文件名', () => {
  assert.match(CP.dbLabel(db('db_a')), /DB_A \(db_a\.example\.com:3306\/db_a_db\)/);
  assert.strictEqual(CP.dbLabel({ type: 'sqlite', name: '本地库', database: 'C:\\a.db' }), '本地库');
});

/* ---------- 走一遍完整链路 ---------- */

test('闭环: A 导出 → B 导入, 卡能落到 B 的库上', () => {
  const pack = CP.buildPack({ cards: [cardOn('db_a')], databases: srcDbs });
  const parsed = CP.parsePack(CP.stringifyPack(pack));
  assert.strictEqual(parsed.ok, true);

  // B 机器: 同一个库, 另一个 id, 本机还没有这张卡
  const map = CP.buildMatchMap(parsed.pack, localDbs);
  const { card: remapped, missing } = CP.remapCard(parsed.pack.cards[0], map);
  assert.deepStrictEqual(missing, []);
  const plan = CP.planImport({ cards: [remapped], localEngines: [] });

  assert.strictEqual(plan[0].action, 'add');
  assert.strictEqual(plan[0].card.nodes[1].databaseId, 'db_1789439222631');
  assert.deepStrictEqual(Object.keys(plan[0].card.scope), ['db_1789439222631']);
});
