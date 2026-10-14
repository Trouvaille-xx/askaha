'use strict';

/**
 * 配置文件的「读坏即覆盖」防线 —— 整个仓库最危险的一条链。
 *
 * 为什么以前没有测试: main.js 第 1 行就 `require('electron')`, 普通 node 加载不了,
 * 于是这条链一直是零覆盖。这里用一个**桩 electron** 把真实的 main.js 跑起来。
 *
 * 原来的行为 (读代码 + 实跑确认过):
 *   loadConfig() 的 catch 只打一行日志, config 就停在模块级出厂默认值
 *   (databases: []、llm.apiKey: '');
 *   紧接着的模型清单迁移 `storedLLM(扁平默认值) !== 扁平默认值` **恒为 true**,
 *   于是无条件 saveConfig() —— 把出厂默认整份盖到坏文件上。
 *   结果: 用户的 4 个库(含口令) / API Key / 全部流程卡一起没, 没有备份, 没有提示。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');

/**
 * 用桩 electron 加载一份**全新的** main.js。
 * 返回 { dir, cfgPath, handlers, settle }。
 */
function boot(rawConfig) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solodb-cfgguard-'));
  const cfgPath = path.join(dir, 'config.json');
  if (rawConfig !== null) fs.writeFileSync(cfgPath, rawConfig, 'utf-8');

  process.env.SOLODB_USER_DATA = dir;

  const handlers = new Map();
  let readyResolve;
  const ready = new Promise((r) => { readyResolve = r; });

  const fake = {
    app: {
      getPath: () => dir,
      setPath: () => {},
      whenReady: () => ready,
      on: () => {},
      quit: () => {}
    },
    BrowserWindow: class {
      constructor() { this.webContents = { send() {}, on() {}, setWindowOpenHandler() {}, openDevTools() {} }; }
      loadFile() {}
      on() {}
      once() {}
      isDestroyed() { return true; }
    },
    ipcMain: {
      handle: (ch, fn) => handlers.set(ch, fn),
      on: (ch, fn) => handlers.set(ch, fn)
    },
    dialog: { showSaveDialog: async () => ({ canceled: true }) },
    shell: { openPath: async () => {}, openExternal: async () => {} }
  };

  // 每次都从干净的模块缓存加载, 否则第二遍拿到的是上一遍的 main.js
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(ROOT) && !k.includes('node_modules')) delete require.cache[k];
  }

  const orig = Module._load;
  Module._load = function (req) {
    if (req === 'electron') return fake;
    return orig.apply(this, arguments);
  };
  try {
    require(path.join(ROOT, 'main.js'));
  } finally {
    Module._load = orig;
  }
  readyResolve();

  return {
    dir,
    cfgPath,
    handlers,
    settle: () => new Promise((r) => setTimeout(r, 250)),
    badFiles: () => fs.readdirSync(dir).filter((n) => n.startsWith('config.json.bad-'))
  };
}

const CORRUPT = '{ "llm": { "models": [ { "apiKey": "sk-KEEPME" } ] ,';

const VALID = JSON.stringify({
  llm: { models: [{ id: 'm1', name: '我的模型', baseURL: 'https://x/v1', apiKey: 'sk-KEEPME', model: 'm' }], activeId: 'm1' },
  databases: [{ id: 'db1', name: '生产库', type: 'mysql', host: 'h', user: 'u', password: 'p' }],
  engines: [{ id: 'card_1', name: '发票核对' }],
  general: { maxSteps: 16 }
}, null, 2);

/* ============================================================
 * 1. 读坏 -> 绝不许写
 * ============================================================ */

test('config.json 读坏时: 原始内容必须原样留在盘上 (不能被出厂默认盖掉)', async () => {
  const b = boot(CORRUPT);
  await b.settle();
  const after = fs.readFileSync(b.cfgPath, 'utf-8');
  assert.strictEqual(after, CORRUPT,
    '坏文件被改写成了: ' + after.slice(0, 120) +
    ' —— 这就是"用户的库/口令/Key/流程卡全丢"那一次事故');
});

test('config.json 读坏时: 另存一份 .bad 备份, 用户还有抢救余地', async () => {
  const b = boot(CORRUPT);
  await b.settle();
  const bads = b.badFiles();
  assert.strictEqual(bads.length, 1, '应该正好留一份备份, 实际 ' + JSON.stringify(bads));
  assert.strictEqual(fs.readFileSync(path.join(b.dir, bads[0]), 'utf-8'), CORRUPT,
    '备份里必须是原始内容');
});

test('config.json 读坏时: 出厂默认值一个字都不许落盘', async () => {
  const b = boot(CORRUPT);
  await b.settle();
  const all = fs.readdirSync(b.dir).map((n) => {
    try { return fs.readFileSync(path.join(b.dir, n), 'utf-8'); } catch (e) { return ''; }
  }).join('\n');
  assert.strictEqual(/"databases":\s*\[\]/.test(all), false,
    '盘上出现了空的 databases —— 说明出厂默认被写出去了');
});

/* ============================================================
 * 2. 正常配置 -> 照常读、照常写 (防线不能误伤)
 * ============================================================ */

test('正常 config.json: 用户的库/Key/流程卡都读进来了', async () => {
  const b = boot(VALID);
  await b.settle();
  const save = b.handlers.get('engine:save') || b.handlers.get('engine:saveSync');
  assert.ok(save, '应该注册了 engine:save 通道');

  // 存一张卡会回带整份 engines, 用它反查配置有没有被正确读进来
  // (注意 ipcMain.handle 的签名是 (event, payload), 这里 event 传 null)
  const r = await save(null, { id: 'card_1', name: '发票核对' });
  assert.ok(r && r.engines, 'engine:save 应该返回 engines');
  assert.ok(r.engines.some((e) => e.id === 'card_1'),
    '用户原有的流程卡必须还在: ' + JSON.stringify(r.engines));
});

test('正常 config.json: 写盘照常生效 (拒绝写盘只针对"没读成功")', async () => {
  const b = boot(VALID);
  await b.settle();
  const save = b.handlers.get('engine:save');
  const r = await save(null, { id: 'card_new', name: '新卡' });
  assert.strictEqual(r.ok, true, '写盘应该成功: ' + JSON.stringify(r));

  const onDisk = JSON.parse(fs.readFileSync(b.cfgPath, 'utf-8'));
  assert.ok((onDisk.engines || []).some((e) => e.id === 'card_new'), '新卡要真的落到盘上');
  assert.strictEqual(onDisk.databases.length, 1, '原有数据库不能被顺手清掉');
  assert.strictEqual(onDisk.llm.models[0].apiKey, 'sk-KEEPME', '用户的 Key 不能丢');
});

test('全新安装 (没有 config.json): 不报错, 也不产生 .bad 备份', async () => {
  const b = boot(null);
  await b.settle();
  assert.deepStrictEqual(b.badFiles(), [], '没有坏文件就不该有备份');
});

/* ============================================================
 * 3. 原子写: 落盘不能留临时文件
 * ============================================================ */

test('写盘之后目录里不留 .tmp-* 垃圾', async () => {
  const b = boot(VALID);
  await b.settle();
  const save = b.handlers.get('engine:save');
  assert.ok(save, '应该注册了 engine:save 通道');
  await save(null, { id: 'card_x', name: 'x' });
  const left = fs.readdirSync(b.dir).filter((n) => n.includes('.tmp-'));
  assert.deepStrictEqual(left, [], '临时文件必须被 rename 掉');
});

/* ============================================================
 * 4. 写盘失败必须报出去, 不能假装保存成功
 * ============================================================ */

test('写盘失败时 engine:save 必须报 ok:false (以前无条件报成功)', async () => {
  const b = boot(VALID);
  await b.settle();
  // 把 config.json 换成一个同名目录 -> rename 必定失败, 模拟磁盘满 / 目录只读
  fs.rmSync(b.cfgPath);
  fs.mkdirSync(b.cfgPath);

  const r = await b.handlers.get('engine:save')(null, { id: 'card_z', name: 'z' });
  assert.strictEqual(r.ok, false,
    '写盘失败必须报 ok:false —— 以前这里把 saveConfig() 的返回值丢掉, 无条件返回 ok:true, ' +
    '界面于是显示"已自动保存", 重启后改动全没了。实际 ' + JSON.stringify(r));
  assert.ok(r.error, '要带上能看懂的 error, 界面才有话可说');
});

test('写盘失败时不留 .tmp-* 垃圾', async () => {
  const b = boot(VALID);
  await b.settle();
  fs.rmSync(b.cfgPath);
  fs.mkdirSync(b.cfgPath);
  await b.handlers.get('engine:save')(null, { id: 'card_z', name: 'z' });
  const left = fs.readdirSync(b.dir).filter((n) => n.includes('.tmp-'));
  assert.deepStrictEqual(left, [], '失败路径也要清临时文件');
});

/* ============================================================
 * 5. 探测数据表: 只补库里那份注释, 绝不覆盖用户写的备注
 * ============================================================ */

const DB_CFG = JSON.stringify({
  llm: { models: [{ id: 'm1', name: 'm', baseURL: 'https://x/v1', apiKey: 'sk-K', model: 'm' }], activeId: 'm1' },
  databases: [{
    id: 'db1', name: 'OMS_POS', type: 'mysql', host: 'h', user: 'u', password: 'p',
    tables: [
      { name: 'delivery_order', checked: true, note: '只算已签收的', comment: '旧注释' },
      { name: 'stale_table', checked: false, note: '', comment: '要被淘汰的' }
    ]
  }],
  engines: [], general: { maxSteps: 16 }
}, null, 2);

/** 找某张表在盘上存成什么样 */
function tableOnDisk(b, name) {
  const onDisk = JSON.parse(fs.readFileSync(b.cfgPath, 'utf-8'));
  return (onDisk.databases[0].tables || []).find((t) => t.name === name) || null;
}

test('探测: 带回来的库注释存下来了, 用户备注与勾选一个都不动', async () => {
  const b = boot(DB_CFG);
  await b.settle();
  b.handlers.get('config:setDatabaseTables')(null, {
    id: 'db1',
    tables: [
      { name: 'delivery_order', comment: '送货单主表' },
      { name: 'new_table', comment: '新增的表' }
    ]
  });

  const kept = tableOnDisk(b, 'delivery_order');
  assert.strictEqual(kept.comment, '送货单主表', '库注释要刷新成最新那次探测的结果');
  assert.strictEqual(kept.note, '只算已签收的',
    '用户写的备注必须原样保留 —— 探测覆盖它就是把用户的工作冲掉了');
  assert.strictEqual(kept.checked, true, '勾选状态也要保留');

  const added = tableOnDisk(b, 'new_table');
  assert.strictEqual(added.comment, '新增的表');
  assert.strictEqual(added.note, '', '新表没有备注');
  assert.strictEqual(added.checked, false, '新表默认不勾');

  assert.strictEqual(tableOnDisk(b, 'stale_table'), null, '这次探测没返回的表应该从清单里去掉');
});

test('探测: 调用方只传表名时, 上一次的库注释不被清掉', async () => {
  const b = boot(DB_CFG);
  await b.settle();
  b.handlers.get('config:setDatabaseTables')(null, {
    id: 'db1',
    tables: ['delivery_order']
  });
  const kept = tableOnDisk(b, 'delivery_order');
  assert.strictEqual(kept.comment, '旧注释',
    '没带 comment 不等于"注释没了" —— 清掉会让界面上刚看到的中文说明突然消失');
  assert.strictEqual(kept.note, '只算已签收的');
});

test('探测: 空字符串的注释也是"这次没取到", 保留上一次的', async () => {
  const b = boot(DB_CFG);
  await b.settle();
  b.handlers.get('config:setDatabaseTables')(null, {
    id: 'db1',
    tables: [{ name: 'delivery_order', comment: '   ' }]
  });
  assert.strictEqual(tableOnDisk(b, 'delivery_order').comment, '旧注释');
});

test('探测: 用户在界面上改了备注, 不会被下一次探测冲掉', async () => {
  const b = boot(DB_CFG);
  await b.settle();
  const set = b.handlers.get('config:setDatabaseTables');
  // 用户改成自己的话
  set(null, { id: 'db1', tables: [{ name: 'delivery_order', note: '口径: 只算本月', comment: '送货单主表' }] });
  assert.strictEqual(tableOnDisk(b, 'delivery_order').note, '口径: 只算本月');
  // 再探测一次
  set(null, { id: 'db1', tables: [{ name: 'delivery_order', comment: '送货单主表(改过)' }] });
  const after = tableOnDisk(b, 'delivery_order');
  assert.strictEqual(after.note, '口径: 只算本月', '用户改的备注要活过探测');
  assert.strictEqual(after.comment, '送货单主表(改过)', '库注释照常刷新');
});

test('探测: 用户把备注清空了, 也不会被库注释顶回来', async () => {
  const b = boot(DB_CFG);
  await b.settle();
  const set = b.handlers.get('config:setDatabaseTables');
  set(null, { id: 'db1', tables: [{ name: 'delivery_order', note: '', comment: '送货单主表' }] });
  assert.strictEqual(tableOnDisk(b, 'delivery_order').note, '',
    '用户清空备注是他的意图, 系统不该自作主张填回去');
  assert.strictEqual(tableOnDisk(b, 'delivery_order').comment, '送货单主表',
    '但库注释还在, 界面上仍然能看到, AI 也仍然能用');
});
