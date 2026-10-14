'use strict';

/**
 * 批量跑: 一张卡 + N 组输入。
 *
 * 为什么要有这个能力:
 *   卡本身没有循环构造 (NODE_TYPES 只有 input/query/condition/output), 一组输入
 *   跑一遍。"帮我看看这 3 张单的入库情况" 是最常见的用法, 以前只能手工跑 3 次。
 *
 * 这里守的是几件容易做错的事:
 *   1. **共享连接不能被单轮关掉**。EngineRunner 跑完会 closeAll() 把它拿到过的
 *      连接全关掉 —— 单跑时是对的, 批量时会把整批共用的那条关掉, 症状是
 *      "第一单正常, 后面几单全报连不上", 看起来像库的问题。这是最容易踩的坑。
 *   2. 一轮失败不能拖死整批 (第 2 单查不到, 第 1、3 单的结果也要拿得到)
 *   3. 顺序要按输入顺序回, 不能按完成顺序 (并发的完成顺序是随机的)
 *   4. 并发上限要真的生效 (50 单同时打开会把库打挂)
 *   5. 取消要能在批次之间生效
 */

const test = require('node:test');
const assert = require('node:assert');

const Engine = require('../lib/engine.js');

/* ---------- 桩 ---------- */

const DB_CONF = [{ id: 'd1', name: 'DB1', type: 'mysql', database: 'd' }];

function makeCard() {
  return {
    id: 'card_1', name: '测试卡',
    nodes: [
      { id: 'n_in', type: 'input', title: '入口', fields: [{ key: 'poNo', label: '单号', required: true }] },
      { id: 'n_q', type: 'query', title: '查', databaseId: 'd1', table: 't', sql: "SELECT '{{poNo}}' AS po" },
      { id: 'n_out', type: 'output', title: '结果', template: '单号 {{poNo}} 查到 {{n_q.po}}' }
    ],
    edges: [
      { from: 'n_in', to: 'n_q', port: 'out' },
      { from: 'n_q', to: 'n_out', port: 'out' }
    ]
  };
}

/**
 * 假库: 记下 open/close/query, 而且 **close 之后再 query 会抛** ——
 * 这样"共享连接被单轮关掉"就会变成看得见的失败, 而不是静默变成空结果。
 */
function makeOpenDb(log, opts = {}) {
  return (conf) => {
    log.opened.push(conf.id);
    let closed = false;
    return {
      type: conf.type,
      config: conf,
      async query(sql) {
        if (closed) throw new Error('连接已关闭 (共享连接被某一轮关掉了)');
        log.queried.push(sql);
        if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
        if (opts.failOn && sql.includes(opts.failOn)) throw new Error('这一单查不到: ' + opts.failOn);
        const m = /'([^']*)'/.exec(sql);
        return { columns: ['po'], rows: [{ po: m ? m[1] : '' }], rowCount: 1, elapsedMs: 1 };
      },
      async close() { closed = true; log.closed.push(conf.id); }
    };
  };
}

const newLog = () => ({ opened: [], closed: [], queried: [] });
const setsOf = (...ids) => ids.map((poNo) => ({ poNo }));

/* ============================================================
 * 1. 基本: N 组输入 -> N 个结果
 * ============================================================ */

test('3 组输入跑出 3 个结果, 每组带自己的输入和输出', async () => {
  const log = newLog();
  const r = await Engine.testEngineBatch(makeCard(), setsOf('A', 'B', 'C'), DB_CONF, makeOpenDb(log));

  assert.strictEqual(r.total, 3);
  assert.strictEqual(r.ran, 3);
  assert.strictEqual(r.okCount, 3);
  assert.strictEqual(r.failCount, 0);
  assert.strictEqual(r.cancelled, false);
  assert.strictEqual(r.ok, true);
  for (const run of r.runs) {
    assert.strictEqual(run.ok, true, run.error || '');
    assert.ok(run.answer.includes(run.inputs.poNo), '每组的结果要对应它自己的输入');
  }
});

test('结果顺序按输入顺序, 不按完成顺序 (并发完成顺序是随机的)', async () => {
  const log = newLog();
  const r = await Engine.testEngineBatch(makeCard(), setsOf('A', 'B', 'C', 'D'), DB_CONF, makeOpenDb(log, { delay: 5 }));
  assert.deepStrictEqual(r.runs.map((x) => x.index), [0, 1, 2, 3]);
  assert.deepStrictEqual(r.runs.map((x) => x.inputs.poNo), ['A', 'B', 'C', 'D']);
});

/* ============================================================
 * 2. 共享连接: 最容易踩的坑
 * ============================================================ */

test('同一个库配置整批只开一次连接', async () => {
  const log = newLog();
  await Engine.testEngineBatch(makeCard(), setsOf('A', 'B', 'C', 'D', 'E'), DB_CONF, makeOpenDb(log), { concurrency: 2 });
  assert.strictEqual(log.opened.length, 1,
    `整批应该只开一次连接 (实际开了 ${log.opened.length} 次) —— 5 单 x 2 库就是 10 条连接`);
});

test('单轮跑完不能把整批共用的连接关掉', async () => {
  const log = newLog();
  const r = await Engine.testEngineBatch(makeCard(), setsOf('A', 'B', 'C'), DB_CONF, makeOpenDb(log, { delay: 3 }));

  // 假库在 close 之后再 query 会抛 —— 所以只要有后续轮次踩到, 这里就会是 failCount > 0
  assert.strictEqual(r.failCount, 0,
    '有轮次在共享连接被关掉之后才跑 —— 症状是"第一单正常, 后面几单全报连不上"');
  for (const run of r.runs) {
    assert.ok(!/连接已关闭/.test(run.error || ''), `第 ${run.index} 轮踩到了已关闭的连接`);
  }
  assert.strictEqual(log.closed.length, 1, '整批结束时应该只关一次');
});

test('整批结束后连接要真的关掉 (不能泄漏)', async () => {
  const log = newLog();
  await Engine.testEngineBatch(makeCard(), setsOf('A', 'B'), DB_CONF, makeOpenDb(log));
  assert.deepStrictEqual(log.closed, ['d1'], '跑完必须把连接收回去');
});

test('某轮抛异常时, 整批结束仍然把连接关掉', async () => {
  const log = newLog();
  await Engine.testEngineBatch(makeCard(), setsOf('A', 'B'), DB_CONF, makeOpenDb(log, { failOn: "'A'" }));
  assert.deepStrictEqual(log.closed, ['d1'], '异常路径也不能漏掉 closeAll');
});

/* ============================================================
 * 3. 一轮失败不拖死整批
 * ============================================================ */

test('第 2 单失败, 第 1、3 单的结果照样拿得到', async () => {
  const log = newLog();
  const r = await Engine.testEngineBatch(makeCard(), setsOf('A', 'B', 'C'), DB_CONF, makeOpenDb(log, { failOn: "'B'" }));

  assert.strictEqual(r.total, 3);
  assert.strictEqual(r.ran, 3, '失败的那一轮也要占一个位置, 不能整批少一个');
  assert.strictEqual(r.okCount, 2);
  assert.strictEqual(r.failCount, 1);
  assert.strictEqual(r.runs[0].ok, true);
  assert.strictEqual(r.runs[1].ok, false);
  assert.match(r.runs[1].error, /查不到/);
  assert.strictEqual(r.runs[2].ok, true);
  assert.strictEqual(r.ok, false, '有失败就不能说整批 ok');
});

test('失败的那一轮也要带上它的输入 (否则不知道是哪一单坏了)', async () => {
  const log = newLog();
  const r = await Engine.testEngineBatch(makeCard(), setsOf('A', 'B'), DB_CONF, makeOpenDb(log, { failOn: "'B'" }));
  assert.deepStrictEqual(r.runs[1].inputs, { poNo: 'B' });
});

/* ============================================================
 * 4. 并发
 * ============================================================ */

test('并发上限真的生效 (50 单同时打开会把库打挂)', async () => {
  const log = newLog();
  let live = 0, peak = 0;
  const openDb = (conf) => {
    log.opened.push(conf.id);
    return {
      type: conf.type,
      async query() {
        live += 1;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 4));
        live -= 1;
        return { columns: ['x'], rows: [{ x: 1 }], rowCount: 1 };
      },
      async close() {}
    };
  };
  await Engine.testEngineBatch(makeCard(), setsOf('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'), DB_CONF, openDb, { concurrency: 2 });
  assert.ok(peak <= 2, `同时在跑的不该超过 2 个 (实际峰值 ${peak})`);
});

test('并发 1 = 串行, 结果一样全', async () => {
  const log = newLog();
  const r = await Engine.testEngineBatch(makeCard(), setsOf('A', 'B', 'C'), DB_CONF, makeOpenDb(log), { concurrency: 1 });
  assert.strictEqual(r.okCount, 3);
});

/* ============================================================
 * 5. 取消
 * ============================================================ */

test('取消令牌置上之后, 后面的批次不再开跑', async () => {
  const log = newLog();
  const cancel = { v: false };
  const r = await Engine.testEngineBatch(
    makeCard(), setsOf('A', 'B', 'C', 'D', 'E', 'F'), DB_CONF, makeOpenDb(log),
    { concurrency: 2, cancel, onEvent: (ev) => { if (ev.type === 'engine_batch_wave' && ev.from >= 2) cancel.v = true; } }
  );
  assert.strictEqual(r.cancelled, true, '取消要能被察觉');
  assert.ok(r.ran < 6, `取消之后不该把 6 组都跑完 (实际跑了 ${r.ran})`);
  assert.strictEqual(r.ok, false, '取消了的批次不能说 ok');
});

test('已经跑完的那些结果要保留 (取消不是"全丢")', async () => {
  const log = newLog();
  const cancel = { v: false };
  const r = await Engine.testEngineBatch(
    makeCard(), setsOf('A', 'B', 'C', 'D'), DB_CONF, makeOpenDb(log),
    { concurrency: 2, cancel, onEvent: (ev) => { if (ev.type === 'engine_batch_wave' && ev.from >= 2) cancel.v = true; } }
  );
  assert.ok(r.ran >= 2, '取消前跑完的那批要留下');
  assert.strictEqual(r.runs.length, r.ran);
});

/* ============================================================
 * 6. 归堆: 让界面一眼看出"几单落在同一个结论上"
 * ============================================================ */

test('归堆按输出节点分组, 带上是哪几组', async () => {
  const log = newLog();
  const r = await Engine.testEngineBatch(makeCard(), setsOf('A', 'B', 'C'), DB_CONF, makeOpenDb(log));
  assert.strictEqual(r.buckets.length, 1);
  assert.strictEqual(r.buckets[0].count, 3);
  assert.deepStrictEqual(r.buckets[0].inputs.map((i) => i.poNo), ['A', 'B', 'C']);
});

/* ============================================================
 * 7. 边界
 * ============================================================ */

test('空输入 / 非数组 / 垃圾项: 安全返回, 不炸', async () => {
  const log = newLog();
  for (const bad of [[], null, undefined, 'nope', [null, 1, 'x', []]]) {
    const r = await Engine.testEngineBatch(makeCard(), bad, DB_CONF, makeOpenDb(log));
    assert.strictEqual(r.total, 0);
    assert.strictEqual(r.ran, 0);
    assert.deepStrictEqual(r.runs, []);
  }
});

test('空对象 {} 是**合法**的输入组, 不能当成垃圾滤掉', async () => {
  // 没有必填字段的卡就是收 {} 的。滤掉它等于"这张卡永远跑不了"。
  // 这张测试卡有必填的 poNo, 所以它应该**跑起来然后报缺输入**, 而不是被静默丢掉。
  const log = newLog();
  const r = await Engine.testEngineBatch(makeCard(), [{}], DB_CONF, makeOpenDb(log));
  assert.strictEqual(r.total, 1, '{} 被当成垃圾丢掉了 —— 没有必填字段的卡会因此跑不了');
  assert.strictEqual(r.runs.length, 1);
  assert.strictEqual(r.runs[0].ok, false);
  assert.match(r.runs[0].error, /缺少必要输入|单号/, '应该是"缺输入"这个明确的错, 不是别的');
});

test('sampleRows 会透传到每一轮 (界面靠它看每一步的样本)', async () => {
  const log = newLog();
  const r = await Engine.testEngineBatch(makeCard(), setsOf('A'), DB_CONF, makeOpenDb(log), { sampleRows: 7 });
  assert.strictEqual(r.sampleRows, 7);
  assert.strictEqual(r.runs[0].sampleRows, 7);
});

test('单跑 testEngine 的行为没被这次重构改坏', async () => {
  const log = newLog();
  const r = await Engine.testEngine(makeCard(), { poNo: 'A' }, DB_CONF, makeOpenDb(log));
  assert.strictEqual(r.ok, true, r.error || '');
  assert.ok(r.answer.includes('A'));
  assert.ok(Array.isArray(r.steps));
  assert.ok(r.steps.length > 0, '单跑也要有 steps');
  assert.strictEqual(log.closed.length, 1, '单跑跑完要关连接');
});
