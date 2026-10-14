'use strict';

/**
 * MCP 外部工具能不能真的注册进工具表。
 *
 * 起因: `attachMCP` 按**扁平形状**读工具 (`t.name` / `t.description` / `t.parameters`),
 * 而 `MCPManager.tools` 是 **OpenAI function 形状**
 * (`{type, function:{name, description, parameters}}`)。于是 `t.name` 恒为 undefined,
 * 每一个外部工具都在 `if (!t || !t.name) continue;` 那行被跳过 ——
 * 三个 Agent 一个都拿不到 MCP 工具, 而且一声不响。
 *
 * 493 条测试全绿是因为 `test/agent-runtime.test.js` 喂的是扁平形状, 跟真实形状不一致
 * —— 测试把 bug 锁成了契约。这个文件用**真实形状**把它钉死。
 */

const test = require('node:test');
const assert = require('node:assert');

const { ToolRegistry } = require('../lib/tools.js');
const { MCPManager } = require('../lib/mcp.js');

/** 真实形状: 就是 MCPManager.tools 里装的东西 (来自 MCPConnection.toOpenAITools) */
const openaiTool = (name) => ({
  type: 'function',
  function: {
    name,
    description: '[来自 测试服务器] 干点什么',
    parameters: { type: 'object', properties: { q: { type: 'string' } } }
  }
});

/** 造一个不 spawn 任何东西的 manager: defs 为空, 手动塞工具 */
function fakeManager(tools) {
  const m = new MCPManager([]);
  m.tools.push(...tools);
  return m;
}

/* ============================================================
 * 1. 形状
 * ============================================================ */

test('真实形状 (OpenAI function) 的工具必须能注册进去', () => {
  const reg = new ToolRegistry();
  reg.attachMCP(fakeManager([openaiTool('mcp__srv__do')]));
  assert.deepStrictEqual(reg.names(), ['mcp__srv__do'],
    '以前这里是空的 —— t.name 恒为 undefined, 每个外部工具都被 continue 掉');
});

test('扁平形状也认 (免得以后哪一边改了又静默失效)', () => {
  const reg = new ToolRegistry();
  reg.attachMCP({ tools: [{ name: 'mcp__srv__flat', description: 'd', parameters: { type: 'object', properties: {} } }] });
  assert.deepStrictEqual(reg.names(), ['mcp__srv__flat']);
});

test('注册进去的外部工具描述与参数来自 function 里面', () => {
  const reg = new ToolRegistry();
  reg.attachMCP(fakeManager([openaiTool('mcp__srv__do')]));
  const t = reg.get('mcp__srv__do');
  assert.ok(t, '工具应该存在');
  assert.ok(t.description.includes('测试服务器'), '描述要取到, 不能退化成"外部工具"');
  assert.deepStrictEqual(t.parameters.properties, { q: { type: 'string' } }, 'JSON Schema 要透传');
  assert.strictEqual(t.external, true);
  assert.strictEqual(t.readOnly, false, '外部工具不知道干什么, 一律当有副作用');
  assert.strictEqual(t.serial, true);
});

test('模型能看到的 schema 里带上了外部工具', () => {
  const reg = new ToolRegistry();
  reg.add('sql', '内置', { type: 'object', properties: {} }, async () => 'ok');
  reg.attachMCP(fakeManager([openaiTool('mcp__srv__do')]));
  const names = reg.schemas().map((s) => (s.function ? s.function.name : s.name));
  assert.ok(names.includes('mcp__srv__do'),
    '模型看不到工具清单就等于这个功能不存在; 实际 = ' + JSON.stringify(names));
});

/* ============================================================
 * 2. 生命周期: closeAll 之后不能还留着工具
 * ============================================================ */

test('closeAll 要把派生状态一起复位', () => {
  const m = fakeManager([openaiTool('mcp__srv__do')]);
  m.toolMeta.push({ exposed: 'mcp__srv__do' });
  m.ready = true;
  m.closeAll();
  assert.deepStrictEqual(m.connections, []);
  assert.deepStrictEqual(m.tools, [], 'tools 是从 connections 派生的, 必须一起清');
  assert.deepStrictEqual(m.toolMeta, []);
  assert.strictEqual(m.ready, false);
});

test('关掉的 manager 不能再把残留工具注册进去 (否则模型看得见、一调必失败)', () => {
  const m = fakeManager([openaiTool('mcp__srv__do')]);
  m.closeAll();
  const reg = new ToolRegistry();
  reg.attachMCP(m);
  assert.deepStrictEqual(reg.names(), [],
    '子进程已经杀了, 工具还挂在那里只会让模型反复调用失败');
});

test('attachMCP(null) 与空 tools 都不炸', () => {
  const reg = new ToolRegistry();
  reg.attachMCP(null);
  reg.attachMCP({});
  reg.attachMCP({ tools: [] });
  assert.deepStrictEqual(reg.names(), []);
});

test('形状不对的条目被跳过, 不炸也不占名字', () => {
  const reg = new ToolRegistry();
  reg.attachMCP({ tools: [null, {}, { type: 'function' }, openaiTool('mcp__ok')] });
  assert.deepStrictEqual(reg.names(), ['mcp__ok']);
});
