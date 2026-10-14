'use strict';

/**
 * 斜杠指令: 显式声明意图, 跳过意图闸门。
 *
 * 底线有两条:
 *   1. 命中指令 = **不调闸门** (省一次模型往返, 也没有误判)
 *   2. /chat 不碰数据库; 未知指令不当普通任务发出去
 */

const test = require('node:test');
const assert = require('node:assert');

const Agent = require('../lib/agent.js');

/* ============================================================ */

test('parseSlash: 行首、命名、参数、裸斜杠', () => {
  assert.deepStrictEqual(Agent.parseSlash('/'), { name: 'help', arg: '' });
  assert.deepStrictEqual(Agent.parseSlash('/help'), { name: 'help', arg: '' });
  assert.deepStrictEqual(Agent.parseSlash('/SQL  x'), { name: 'sql', arg: 'x' });
  assert.deepStrictEqual(Agent.parseSlash('  /card 采购卡 SO1 '), { name: 'card', arg: '采购卡 SO1' });
  assert.deepStrictEqual(Agent.parseSlash('/chat 你好'), { name: 'chat', arg: '你好' });
});

test('parseSlash: 普通任务 / 路径型文本不误判', () => {
  assert.strictEqual(Agent.parseSlash('帮我查一下订单'), null);
  assert.strictEqual(Agent.parseSlash('/etc/passwd 是路径'), null, '带内层斜杠的路径不是指令');
  assert.strictEqual(Agent.parseSlash(''), null);
});

test('SLASH_COMMANDS: 每项都有 name/usage/desc, 名字不重复', () => {
  const names = Agent.SLASH_COMMANDS.map((c) => c.name);
  assert.strictEqual(new Set(names).size, names.length, '指令名重复');
  for (const c of Agent.SLASH_COMMANDS) {
    assert.ok(c.name && c.usage && c.desc, '缺字段: ' + JSON.stringify(c));
  }
});

/* ---- 端到端: 走 Agent.run ---- */

function makeAgent(extra = {}) {
  const calls = [];
  const llm = {
    config: { apiKey: 'x' },
    async chatStep(msgs, tools) {
      calls.push({ msgs, tools });
      return { content: '这是回答', toolCalls: [], usage: { input: 5, output: 3 } };
    }
  };
  const agent = new Agent({
    llm, database: null, skills: null, tableInventory: [], mcp: null, prompt: null, general: null,
    engines: [], databases: [], openDb: null, ...extra
  });
  return { agent, llm, calls };
}

test('/sql: 跳过闸门 (没配库时直接报"未配置数据库", 而不是去调闸门)', async () => {
  const { agent } = makeAgent();
  let gate = false;
  agent._classifyIntent = async () => { gate = true; return { kind: 'analysis' }; };
  await assert.rejects(
    () => agent.run('/sql 近30天各供应商采购金额', {}, () => {}, async () => ({})),
    /未配置\/未选中数据库/
  );
  assert.strictEqual(gate, false, '命中 /sql 时绝不该调用意图闸门');
});

test('/chat: 直接回话, 不碰数据库, 不调闸门', async () => {
  const { agent, calls } = makeAgent();
  let gate = false;
  agent._classifyIntent = async () => { gate = true; return { kind: 'chat', reply: 'x' }; };
  const out = await agent.run('/chat 你好', {}, () => {}, async () => ({}));
  assert.match(out.reply || '', /这是回答/);
  assert.strictEqual(gate, false, '不该调闸门');
  assert.strictEqual(calls.length, 1, '一次纯文本调用');
  assert.deepStrictEqual(calls[0].tools, [], '对话不挂工具');
});

test('/help 与裸 /: 列出指令, 不调闸门', async () => {
  for (const input of ['/help', '/']) {
    const { agent } = makeAgent();
    let gate = false;
    agent._classifyIntent = async () => { gate = true; return { kind: 'chat', reply: 'x' }; };
    const out = await agent.run(input, {}, () => {}, async () => ({}));
    assert.match(out.reply || '', /\/sql/, input + ' 该列出指令清单');
    assert.match(out.reply || '', /\/card/);
    assert.strictEqual(gate, false);
  }
});

test('未知指令: 回一句提示, 不当普通任务发出去', async () => {
  const { agent, calls } = makeAgent();
  const out = await agent.run('/foo 随便', {}, () => {}, async () => ({}));
  assert.match(out.reply || '', /没有「\/foo」/, '要说清这条指令不存在');
  assert.strictEqual(calls.length, 0, '不该为未知指令做任何模型调用');
});

test('/card: 按卡名解析, 其余文字当输入交给 _runEngine', async () => {
  const { agent } = makeAgent({
    engines: [{ id: 'eng1', name: '采购订单入库核对', enabled: true }]
  });
  let ran = null;
  agent._runEngine = async (id, rest) => { ran = { id, rest }; return { reply: 'ok' }; };
  const out = await agent.run('/card 采购订单入库核对 SO123', {}, () => {}, async () => ({}));
  assert.deepStrictEqual(ran, { id: 'eng1', rest: 'SO123' }, '卡名做前缀, 其余当输入');
  assert.strictEqual(out.reply, 'ok');
});

test('/card 描述需求: 闸门在卡目录里挑一张来跑', async () => {
  const { agent } = makeAgent({ engines: [{ id: 'eng1', name: '某张卡', enabled: true }] });
  let ran = null;
  agent._runEngine = async (id, rest) => { ran = { id, rest }; return { reply: 'ok' }; };
  agent._classifyIntent = async () => ({ kind: 'engine', engineId: 'eng1', low: false });
  const out = await agent.run('/card 帮我查下这个采购单入库没 SO123', {}, () => {}, async () => ({}));
  assert.deepStrictEqual(ran, { id: 'eng1', rest: '帮我查下这个采购单入库没 SO123' }, '整段描述当输入交给卡');
  assert.strictEqual(out.reply, 'ok');
});

test('/card 认不出卡名、也挑不中: 列出可用卡', async () => {
  const { agent } = makeAgent({ engines: [{ id: 'eng1', name: '某张卡', enabled: true }] });
  agent._classifyIntent = async () => ({ kind: 'analysis' });   // 一条都没对上
  const out = await agent.run('/card 对不上的名字', {}, () => {}, async () => ({}));
  assert.match(out.reply || '', /没找到对得上的流程卡/);
  assert.match(out.reply || '', /某张卡/, '并把可用的卡列出来');
});

test('/card 多张都对得上: 交给选择层', async () => {
  const { agent } = makeAgent({ engines: [
    { id: 'e1', name: '卡一', enabled: true }, { id: 'e2', name: '卡二', enabled: true }
  ] });
  agent._classifyIntent = async () => ({ kind: 'route', candidates: ['e1', 'e2'] });
  const out = await agent.run('/card 帮我看看那个东西', {}, () => {}, async () => ({}));
  assert.match(out.reply || '', /对得上|哪一张/, '要弹选择层');
});

test('人工终止: 带 cancel.v=true 时立刻以"用户取消"收尾, 不调闸门', async () => {
  const { agent } = makeAgent();
  let gate = false;
  agent._classifyIntent = async () => { gate = true; return { kind: 'analysis' }; };
  await assert.rejects(
    () => agent.run('随便问一句', { cancel: { v: true } }, () => {}, async () => ({})),
    /用户取消/
  );
  assert.strictEqual(gate, false, '已经取消了, 不该再去调闸门');
});

test('_resolveCard: id / 卡名前缀(取最长) / 首段 id', () => {
  const list = [
    { id: 'e1', name: '采购订单' },
    { id: 'e2', name: '采购订单入库核对' }
  ];
  const { agent } = makeAgent();
  // 整段是 id
  assert.deepStrictEqual(agent._resolveCard('e1', list), { engine: list[0], rest: '' });
  // 卡名做前缀: 取最长的那个 ("采购订单入库核对" 比 "采购订单" 长)
  assert.deepStrictEqual(agent._resolveCard('采购订单入库核对 SO9', list), { engine: list[1], rest: 'SO9' });
  assert.deepStrictEqual(agent._resolveCard('采购订单 SO9', list), { engine: list[0], rest: 'SO9' });
  // 首段是 id
  assert.deepStrictEqual(agent._resolveCard('e2 额外输入', list), { engine: list[1], rest: '额外输入' });
  // 认不出
  assert.deepStrictEqual(agent._resolveCard('张三', list), { engine: null, rest: '张三' });
});
