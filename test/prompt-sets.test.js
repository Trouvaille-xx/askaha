'use strict';

/**
 * 三个 Agent 的提示词都能在「设置 · 提示词」里看到、改到。
 *
 * 这次改动的核心是把硬编码在 lib/engine-ai.js / lib/engine-tester.js 里的两大段
 * 提示词搬进 lib/prompt-sets.js, 变成和"对话 Agent"一样的可配置模块。
 *
 * **最重要的一组断言是那 5 个 SHA-256。**
 * 搬迁是个纯搬运动作 —— 一个字都不该改。那几个哈希是搬迁**之前**跑出来的真实
 * 输出, 钉死在这里。以后谁再动提示词, 哈希会先红, 逼他确认"这是我有意改的"
 * 还是"我手滑搬错了一个空格"。
 *
 * 为什么用哈希而不是把整段文本抄进测试:
 *   五段加起来 18000 字符, 抄进来会变成一份需要同步维护的副本, 而且读的人看不出
 *   重点。哈希一样能钉住"逐字节相同", 还短。
 *
 * 第二重要的一组是**占位符不能误伤引用语法**:
 *   搭建 Agent 的提示词正文里写满了 {{orderNo}}、{{n_abc.col}} 这种示例 ——
 *   那是要原样给模型看的。填充逻辑必须是白名单, 不能"替换所有 {{xxx}}"。
 *   这条要是坏了, 提示词里的引用示例会被整段吃掉, 而且不会有任何报错。
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const path = require('path');

const Prompt = require(path.join(__dirname, '..', 'lib', 'prompt.js'));
const AI = require(path.join(__dirname, '..', 'lib', 'engine-ai.js'));
const TE = require(path.join(__dirname, '..', 'lib', 'engine-tester.js'));

/* ============================================================
 * 搬迁前的固定 fixture —— 哈希就是照这组输入算的, 不要改
 * ============================================================ */

const CARD = {
  id: 'eng_x', name: '测试卡', description: '',
  nodes: [
    { id: 'n_in', type: 'input', x: 0, y: 0, title: '入口', fields: [{ key: 'orderNo', label: '订单号' }] },
    { id: 'n_q1', type: 'query', x: 0, y: 100, title: '查订单', dbId: 'db1', table: 'purchase_order', sql: 'SELECT * FROM purchase_order WHERE no={{orderNo}}' },
    { id: 'n_out', type: 'output', x: 0, y: 200, title: '结论', template: '结论: {{n_q1.no}}' }
  ],
  edges: [{ from: 'n_in', to: 'n_q1' }, { from: 'n_q1', to: 'n_out' }]
};
const POOL = { db1: ['purchase_order', 'delivery_order'] };
const DBNAMES = { db1: '采购库' };
const DESCRIBED = new Map([['db1.purchase_order', [{ field: 'no', type: 'varchar' }, { field: 'status', type: 'int' }]]]);

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function current() {
  return {
    builder_empty: AI.buildSystemPrompt({ id: 'e', nodes: [] }, {}, {}, {}),
    builder_draft: AI.buildSystemPrompt(CARD, POOL, DESCRIBED, DBNAMES),
    builder_nopool: AI.buildSystemPrompt(CARD, {}, new Map(), {}),
    tester_empty: TE.buildSystemPrompt({ id: 'e', nodes: [] }, {}, {}, {}),
    tester_draft: TE.buildSystemPrompt(CARD, POOL, DESCRIBED, DBNAMES)
  };
}

/* ============================================================
 * 1. 搬迁是行为保持的 (哈希钉死)
 * ============================================================ */

test('默认配置下, 提示词与搬迁前逐字节相同', () => {
  // 2026-09-21 有意改过一次 (不是搬迁走样): 「引用语法」模块加了**多行清单**的写法 ——
  // {{节点.rows}} 铺成表格 / {{#each 节点.rows}}...{{/each}} 逐行, 以及"循环只能一层、
  // 只能遍历 .rows"这两条限制; 「常见根因」模块加了第 7 条"清单只出来一行"。
  // 起因: 要搭「采购订单入库对账排查」, 结论里要列三份明细清单, 而引擎当时只能取首行。
  // 引擎侧同步支持在 lib/engine.js 的 renderTemplate / paramsOf,
  // 回归测试在 test/engine-template-rows.test.js。
  //
  // 2026-09-23 又改了一次, **只动了 builder 的三个, tester 的两个没动** —— 这次加的
  // 是新工具 find_value 的用法 (第 2c 条): 要确认"这个单号存在哪一列"时用它,
  // 不要自己写 `WHERE a LIKE 'PO%' OR b LIKE 'PO%' OR ...` 那种探针。
  // 起因: 真实会话里模型为找"SRM 侧哪一列装着 PO 号", 自己写了 4 条十几列拼起来的
  // 全表扫探针, 在 946 万行的表上单条最贵 129.8 秒、四条约 250 秒。
  // 回归测试在 test/find-value.test.js。
  //
  // 2026-09-23 同一天第二次改, 仍然**只动 builder 的三个** —— 加了第 6a / 6b 两条:
  // 6a 讲"只改一个节点时把 sqlByNode 传回 reuse"(别重跑全卡)、以及"想看渲染后的 SQL
  // 用 render_sql 而不是再跑一次试跑"; 6b 讲"记不清验证过什么就用 recall 取回旧结果"。
  // 起因: 复盘一个 90 分钟的搭建会话, 工具时间 33.2 分钟里有 33.1 分钟(99.7%)是 run_test,
  // 共 16 次、平均 124 秒、最慢 389 秒; 其中 4 次是在反复试同一个"跨库传列表被套引号"的问题,
  // 而那个问题 render_sql 一秒就能看出来。另外对话折叠了 22 条旧结果, 导致已验证的关联关系
  // 又被重验一遍。回归测试在 test/speedup.test.js。
  // 2026-09-23 同一天第三次改, 仍然**只动 builder 的三个** —— 这次是把「怎么干活」
  // 重写成四个阶段: 查清楚 → 出规划(plan_task) → 按规划建完 → 最后才测。
  // 新增了两条硬要求: 步骤要写具体、branches 必须列出全部结论 (列不出就是没想清楚);
  // 以及第 8 条"跑断了要先分清是规划错了还是实现错了 —— 同一个地方试第三次还不行
  // 就是规划层面错了, 停下来重想"。另外加了 2d: 跨库关联键必须真的 find_value 验证过
  // 再用 (实测有会话把 SRM 明细表的 ORDER_ITEM_NO 当成对方系统单号, 试跑了几十分钟,
  // 最后发现它其实是本系统采购明细行的主键 id)。
  // 配套的闸门在 lib/engine-ai.js (_hasSubstance / _pendingSteps), 测试在 test/plan-gate.test.js。
  // 2026-10 又改了一次, 仍然**只动 builder 的三个** —— 这次是让搭建 Agent **一次性
  // 产出整张卡**: 新增 write_card 工具 (一次交完整的 nodes+edges, 不再逐个 add_node),
  // 「怎么干活」第三阶段改成"用 write_card 一次写出整张卡", 「卡的结构」补了
  // 条件**可以嵌套** (引擎一直支持, 只是工具没暴露)。起因: 逐个画节点往返太多,
  // 搭一张多分支卡要几十次往返。回归测试见 test/engine-builder-runtime.test.js 与
  // test/engine-condition-nest.test.js。
  // 2026-10 再改一次, 只动 builder —— 「收尾规矩」补了「搭完必须明确告诉用户"完成了"」:
  // 以前只写"想说点什么就写在正文里", 模型常常静默结束, 用户不知道卡搭好没有。
  const expected = {
    builder_empty: '1beb1fcb8388a1de789ac9fe8c26722b7108812801235fa5c28ab46b124a0b8d',
    builder_draft: '94be3d97e3f26d96074a299d45d1483d5d1330ba89faa3f48b28835db6a15012',
    builder_nopool: '9603478cccfeff7c4318963e26c38c526bf5249fdb67991b6f400c6191d4b055',
    tester_empty: '15f4811773bd3ee58c5bbe9c64b2d11f95bf888e966a14b4d615d4061950e2e3',
    tester_draft: '0444c1b74d467661433471dfe6722be707d30e3293770a3a890786b6f7be81ce'
  };
  const got = current();
  for (const k of Object.keys(expected)) {
    assert.strictEqual(sha(got[k]), expected[k],
      k + ' 变了 (长度 ' + String(got[k]).length + ')。如果你是有意改提示词的, 更新这个哈希; 否则是搬错了。');
  }
});

test('对话 Agent 的提示词也没被这次改动影响', () => {
  // 空的配置 = 全出厂值。这几个模块都在, 顺序也没变。
  const p = Prompt.buildSystemPrompt(null);
  assert.match(p, /^你是 Askaha, 一个数据库分析智能体/);
  assert.match(p, /## 怎么表达动作/);
  assert.match(p, /## 约束/);
  assert.strictEqual(Prompt.resolveModules(null).length, 8);
});

/* ============================================================
 * 2. 三套提示词都登记上了
 * ============================================================ */

test('三套都在: 对话 / 搭建 / 测试', () => {
  assert.deepStrictEqual(Prompt.SET_IDS, ['chat', 'builder', 'tester']);
  const snap = Prompt.snapshot(null);
  assert.strictEqual(snap.sets.length, 3);
  for (const s of snap.sets) {
    assert.ok(s.modules.length > 0, s.id + ' 一个模块都没有');
    assert.ok(s.preview.trim(), s.id + ' 拼出来是空的');
    assert.ok(s.label && s.hint, s.id + ' 缺界面要用的标题');
  }
});

test('每套里的模块 id 不重复, 且都有 label / summary', () => {
  for (const s of Prompt.SETS) {
    const ids = s.modules.map((m) => m.id);
    assert.strictEqual(new Set(ids).size, ids.length, s.id + ' 有重复的模块 id');
    for (const m of s.modules) {
      assert.ok(m.label, s.id + '.' + m.id + ' 缺 label');
      assert.ok(m.summary, s.id + '.' + m.id + ' 缺 summary');
      assert.ok(typeof m.defaultText === 'string' && m.defaultText.trim(), s.id + '.' + m.id + ' 没有默认文本');
    }
  }
});

test('搭建 Agent 的模块覆盖了搬迁前的每一段 (按 ## 标题核对)', () => {
  const p = AI.buildSystemPrompt(CARD, POOL, DESCRIBED, DBNAMES);
  for (const h of ['## 先判断', '## 卡长什么样', '## 引用怎么写', '## 流程图长什么样',
    '## 你是在', '## 可用范围', '## 你已经看过的表结构', '## 当前草稿',
    '## 怎么干活', '## 入口是', '## 问问题的方式', '## 如果有人在帮你测试']) {
    assert.ok(p.includes(h), '搭建提示词里丢了这一段: ' + h);
  }
});

/* ============================================================
 * 3. 占位符: 填对了, 而且没误伤引用语法
 * ============================================================ */

test('运行时占位符都被填掉了, 一个不剩', () => {
  for (const [label, text] of [
    ['builder', AI.buildSystemPrompt(CARD, POOL, DESCRIBED, DBNAMES)],
    ['tester', TE.buildSystemPrompt(CARD, POOL, DESCRIBED, DBNAMES)]
  ]) {
    for (const k of Prompt.RUNTIME_KEYS) {
      assert.ok(!text.includes('{{' + k + '}}'), label + ' 里还留着 {{' + k + '}}');
    }
  }
});

test('**引用语法的示例必须原样保留** —— 这是最容易踩的一处', () => {
  // 搭建提示词正文里教模型怎么引用, 写的就是 {{orderNo}} / {{n_abc.col}} 这种。
  // 填充逻辑要是写成"替换所有 {{xxx}}", 这些示例会被吃掉, 而且不报错。
  //
  // 注意 invoiceNo 不在这张表里: 它在正文里是 JSON 的 "key":"invoiceNo",
  // 不是 {{invoiceNo}} 引用。只有 deliveryNo / poNo 出现在那个分流示意图里。
  const p = AI.buildSystemPrompt(CARD, POOL, DESCRIBED, DBNAMES);
  for (const ref of ['{{n_abc.inbound_status}}', '{{orderNo}}', '{{inbound_status}}',
    '{{deliveryNo}}', '{{poNo}}', '{{true支的节点.某列}}']) {
    assert.ok(p.includes(ref), '引用示例被吃掉了: ' + ref);
  }
  // 入口声明那段的 JSON 也要原样在 (它里面带花括号, 别被误当成占位符)
  assert.ok(p.includes('{"key":"invoiceNo","label":"发票号"'), '入口声明示例被吃掉了');
});

test('填进去的真实值确实到了位', () => {
  const p = AI.buildSystemPrompt(CARD, POOL, DESCRIBED, DBNAMES);
  assert.ok(p.includes('- 库 采购库 (id=db1): purchase_order, delivery_order'), '可用范围没填对');
  assert.ok(p.includes('- db1.purchase_order: no(varchar), status(int)'), '表结构没填对 (搭建 Agent 带类型)');
  assert.ok(p.includes('"sql": "SELECT * FROM purchase_order WHERE no={{orderNo}}"'), '草稿没填对');
});

test('测试 Agent 的表结构不带类型 (和搭建 Agent 不一样)', () => {
  const t = TE.buildSystemPrompt(CARD, POOL, DESCRIBED, DBNAMES);
  assert.ok(t.includes('- db1.purchase_order: no, status'), '测试 Agent 的表结构格式变了');
});

test('草稿里的值含占位符字样也不会被二次替换', () => {
  // 单次扫描的保证: 第一轮填进去的值不该被第二轮再扫一遍
  const card = {
    id: 'e', name: '', description: '',
    nodes: [{ id: 'n_q', type: 'query', title: 'q', databaseId: 'db1', table: 't', sql: 'SELECT {{scope_tables}}' }],
    edges: []
  };
  const p = AI.buildSystemPrompt(card, POOL, new Map(), DBNAMES);
  assert.ok(p.includes('SELECT {{scope_tables}}'), '草稿里的字样被二次替换了');
});

/* ============================================================
 * 4. 条件模块: 该出现才出现
 * ============================================================ */

test('空草稿时不出"你是在改一张已经存在的卡"', () => {
  const empty = AI.buildSystemPrompt({ id: 'e', nodes: [] }, POOL, DESCRIBED, DBNAMES);
  assert.ok(!empty.includes('不是从零搭'), '空草稿不该出现改卡那一段');
});

test('草稿非空时出"你是在改一张已经存在的卡"', () => {
  const draft = AI.buildSystemPrompt(CARD, POOL, DESCRIBED, DBNAMES);
  assert.ok(draft.includes('不是从零搭'), '有草稿时该出现改卡那一段');
});

test('没看过表结构时, 整段"你已经看过的表结构"不出现 (不留空壳标题)', () => {
  for (const [label, p] of [
    ['builder', AI.buildSystemPrompt(CARD, POOL, new Map(), DBNAMES)],
    ['tester', TE.buildSystemPrompt(CARD, POOL, new Map(), DBNAMES)]
  ]) {
    assert.ok(!p.includes('## 你已经看过的表结构'), label + ' 留了一个空壳标题');
  }
});

test('看过表结构时才出现', () => {
  assert.ok(AI.buildSystemPrompt(CARD, POOL, DESCRIBED, DBNAMES).includes('## 你已经看过的表结构'));
  assert.ok(TE.buildSystemPrompt(CARD, POOL, DESCRIBED, DBNAMES).includes('## 你已经看过的表结构'));
});

test('没有可用范围时给的是各自那句兜底', () => {
  assert.ok(AI.buildSystemPrompt(CARD, {}, new Map(), {}).includes('- (还没有配范围, 先让用户配置)'));
  assert.ok(TE.buildSystemPrompt(CARD, {}, new Map(), {}).includes('- (没有可用范围)'));
});

/* ============================================================
 * 5. 用户改动能生效
 * ============================================================ */

test('改搭建 Agent 的一个模块, 拼出来的提示词跟着变', () => {
  const cfg = { sets: { builder: { modules: { closing: { text: '每轮可以调多个工具。' } } } } };
  const p = AI.buildSystemPrompt(CARD, POOL, DESCRIBED, DBNAMES, cfg);
  assert.ok(p.includes('每轮可以调多个工具。'), '改动没生效');
  assert.ok(!p.includes('每轮只调一个工具。想说点什么'), '旧文本还在');
});

test('改测试 Agent 的模块不影响搭建 Agent', () => {
  const cfg = { sets: { tester: { modules: { closing: { text: '测试收尾。' } } } } };
  assert.ok(TE.buildSystemPrompt(CARD, POOL, DESCRIBED, DBNAMES, cfg).includes('测试收尾。'));
  assert.ok(AI.buildSystemPrompt(CARD, POOL, DESCRIBED, DBNAMES, cfg).includes('每轮只调一个工具。想说点什么'));
});

test('关掉一个非 critical 模块, 它就不出现', () => {
  // root_causes 是**测试 Agent** 的模块, 所以要挂在 sets.tester 下
  const cfg = { sets: { tester: { modules: { root_causes: { enabled: false } } } } };
  const t = TE.buildSystemPrompt(CARD, POOL, DESCRIBED, DBNAMES, cfg);
  assert.ok(!t.includes('## 跑不通的常见根因'), '关掉的模块还在');
});

test('critical 模块关不掉 (关掉会破职责边界 / 安全边界)', () => {
  const cfg = { sets: { builder: { modules: { scope: { enabled: false }, closing: { enabled: false } } } } };
  const p = AI.buildSystemPrompt(CARD, POOL, DESCRIBED, DBNAMES, cfg);
  assert.ok(p.includes('## 可用范围'), 'critical 的 scope 被关掉了');
  assert.ok(p.includes('每轮只调一个工具'), 'critical 的 closing 被关掉了');
});

test('传 null / undefined 配置时全用出厂值, 不炸', () => {
  assert.strictEqual(AI.buildSystemPrompt(CARD, POOL, DESCRIBED, DBNAMES, null),
    AI.buildSystemPrompt(CARD, POOL, DESCRIBED, DBNAMES));
  assert.strictEqual(AI.buildSystemPrompt(CARD, POOL, DESCRIBED, DBNAMES, undefined),
    AI.buildSystemPrompt(CARD, POOL, DESCRIBED, DBNAMES));
});

/* ============================================================
 * 6. 配置形状: 老配置还能读 (升级不能丢用户的改动)
 * ============================================================ */

test('老形状 { modules } 仍然被当成对话 Agent 那套读', () => {
  const old = { modules: { identity: { text: '老配置里的身份。' } } };
  const mods = Prompt.resolveModules(old, 'chat');
  assert.strictEqual(mods.find((m) => m.id === 'identity').text, '老配置里的身份。');
  assert.ok(Prompt.buildSystemPrompt(old).includes('老配置里的身份。'));
});

test('老形状不会污染搭建 / 测试那两套', () => {
  const old = { modules: { identity: { text: '老配置里的身份。' } } };
  assert.ok(!AI.buildSystemPrompt(CARD, POOL, DESCRIBED, DBNAMES, old).includes('老配置里的身份。'));
});

test('normalizePromptConfig 把老形状升级成新形状', () => {
  const out = Prompt.normalizePromptConfig({ modules: { identity: { text: 'x' } } });
  assert.deepStrictEqual(out, { sets: { chat: { modules: { identity: { text: 'x' } } } } });
});

test('normalizePromptConfig 保留三套各自的改动', () => {
  const out = Prompt.normalizePromptConfig({
    sets: {
      chat: { modules: { identity: { text: 'c' } } },
      builder: { modules: { closing: { text: 'b' } } },
      tester: { modules: { closing: { text: 't' } } }
    }
  });
  assert.strictEqual(out.sets.chat.modules.identity.text, 'c');
  assert.strictEqual(out.sets.builder.modules.closing.text, 'b');
  assert.strictEqual(out.sets.tester.modules.closing.text, 't');
});

test('normalizePromptConfig 丢弃不认识的模块 id 和等于出厂值的文本', () => {
  const out = Prompt.normalizePromptConfig({
    sets: {
      builder: {
        modules: {
          不存在的模块: { text: 'x' },
          // 文本正好等于搭建 Agent 的出厂值 -> 不存 (省空间, 也让它跟着出厂版升级)
          closing: { text: '每轮只调一个工具。想说点什么跟用户交代, 就直接写在正文里。\n\n## 搭完要明确告诉用户「完成了」(重要)\n- 这张卡**搭完 / 改完并自测通过**时, 正文里必须**明说一句"搭好了"或"改好了"** ——\n  再用一两句话讲清它怎么跑 (入口要给什么、最后会得出什么结论)。\n  用户就是靠这句话确认"事情办完了"的; 不吭声就结束, 他会以为你还在忙、或者以为没成功。\n- 需要用户动手时 (补一个输入、在界面上点一下保存等) 也要在正文里明说。\n- 还在半路 (只是把需求问清楚了 / 刚改了一步) 时, 不要谎报"完成"。' }
        }
      }
    }
  });
  assert.deepStrictEqual(out, { sets: {} });
});

test('文本和出厂值只差一点也要存下来', () => {
  const out = Prompt.normalizePromptConfig({
    sets: { builder: { modules: { closing: { text: '每轮只调一个工具。' } } } }
  });
  assert.deepStrictEqual(out, { sets: { builder: { modules: { closing: { text: '每轮只调一个工具。' } } } } });
});

test('normalizePromptConfig 不允许关掉 critical 模块', () => {
  const out = Prompt.normalizePromptConfig({ sets: { builder: { modules: { scope: { enabled: false } } } } });
  assert.deepStrictEqual(out, { sets: {} });
});

test('snapshot(config, setId) 只给一套 (老调用点的形状没变)', () => {
  const s = Prompt.snapshot(null, 'builder');
  assert.strictEqual(s.setId, 'builder');
  assert.ok(Array.isArray(s.modules));
  assert.ok(typeof s.preview === 'string');
});

/* ============================================================
 * 7. 意图闸门用的还是对话那套的 intent 模块
 * ============================================================ */

test('intentPolicy 读的是对话 Agent 的 intent, 不受搭建/测试影响', () => {
  const cfg = { sets: { builder: { modules: { intent: { text: '搭建的意图段。' } } } } };
  assert.ok(!Prompt.intentPolicy(cfg).includes('搭建的意图段。'));
  assert.ok(Prompt.intentPolicy({ sets: { chat: { modules: { intent: { text: '对话的意图段。' } } } } })
    .includes('对话的意图段。'));
});

test('intent 模块被写空时, 闸门退回内置判据 (不能因此失效)', () => {
  const cfg = { sets: { chat: { modules: { intent: { text: '   ' } } } } };
  assert.ok(Prompt.intentPolicy(cfg).includes('先分清用户是在'));
});
