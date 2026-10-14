'use strict';

/**
 * LLM 客户端的**流式输出** (SSE)。
 *
 * 起因: chatStep 以前一律 `stream: false` —— 模型一次往返十几秒, 界面全程静默,
 * 用户感知就是"卡死了"。改成流式后, 正文边生成边到, 那十几秒里屏幕上一直在长字。
 *
 * 三条最容易做错的:
 *   1. tool_calls 是**分片**来的 (index 分组, arguments 是碎片) —— 拼错 = 工具调不动
 *   2. usage 在**单独一帧** (choices 为空), 不能被"没 choices 就跳过"吃掉
 *   3. 网关不支持 stream 时, 要**自动退回**非流式, 而不是让整轮失败
 *
 * 用真实的本地 HTTP 服务发 SSE, 不 mock。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

const LLMClient = require('../lib/llm.js');

/**
 * 起一个假网关。handler(parsedBody, res) 自己决定怎么应答。
 * 返回 { port, client(), seen, close() }。
 */
function startGateway(handler) {
  const seen = [];
  const s = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch (e) {}
      seen.push(parsed);
      handler(parsed, res);
    });
  });
  return new Promise((resolve) => {
    s.listen(0, '127.0.0.1', () => {
      resolve({
        seen,
        port: s.address().port,
        client: (extra) => new LLMClient({
          baseURL: `http://127.0.0.1:${s.address().port}/v1`,
          apiKey: 'x', model: 'm',
          timeoutMs: 2000,
          ...(extra || {})
        }),
        close: () => new Promise((r) => { s.closeAllConnections(); s.close(() => r()); })
      });
    });
  });
}

async function withGateway(handler, fn) {
  const g = await startGateway(handler);
  try {
    return await fn(g);
  } finally {
    await g.close();
  }
}

/** SSE 应答的便捷写法 */
function sse(res, frames) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const f of frames) {
    if (f === '[DONE]') res.write('data: [DONE]\n\n');
    else res.write('data: ' + JSON.stringify(f) + '\n\n');
  }
  res.end();
}

const msgs = [{ role: 'user', content: 'hi' }];

/* ============================================================
 * 1. 正文增量
 * ============================================================ */

test('流式: 正文逐段回调, 同时拼成完整 content', async () => {
  await withGateway((parsed, res) => {
    assert.strictEqual(parsed.stream, true, '开了 onDelta 就该走流式');
    sse(res, [
      { choices: [{ delta: { role: 'assistant', content: '你' } }] },
      { choices: [{ delta: { content: '好' } }] },
      { choices: [{ delta: { content: '呀' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3 } },
      '[DONE]'
    ]);
  }, async (g) => {
    const deltas = [];
    const out = await g.client().chatStep(msgs, [], { onDelta: (t) => deltas.push(t) });
    assert.strictEqual(out.content, '你好呀', '拼出来的正文要完整');
    assert.deepStrictEqual(deltas, ['你', '好', '呀'], '每个增量都要回调出去 (顺序要对)');
    assert.deepStrictEqual(out.usage, { input: 10, output: 3 }, 'usage 从末帧取');
    assert.strictEqual(out.finishReason, 'stop');
  });
});

test('流式: 思考过程 (reasoning) 只累积、不回调', async () => {
  await withGateway((parsed, res) => {
    sse(res, [
      { choices: [{ delta: { reasoning_content: '我在想…' } }] },
      { choices: [{ delta: { content: '答案' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] }
    ]);
  }, async (g) => {
    const deltas = [];
    const out = await g.client().chatStep(msgs, [], { onDelta: (t) => deltas.push(t) });
    assert.deepStrictEqual(deltas, ['答案'], '只回调正文, 思考不该混进来');
    assert.strictEqual(out.reasoning, '我在想…', '但思考要累积到 reasoning 里 (供别的用途)');
    assert.strictEqual(out.content, '答案');
  });
});

test('流式: 没有 usage 帧时 usage 是 null, 不编 0', async () => {
  await withGateway((parsed, res) => {
    sse(res, [
      { choices: [{ delta: { content: 'x' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] }
    ]);
  }, async (g) => {
    const out = await g.client().chatStep(msgs, [], { onDelta: () => {} });
    assert.strictEqual(out.usage, null, '没报用量就是没报, 不是 0');
  });
});

/* ============================================================
 * 2. 工具调用分片 (最易错处)
 * ============================================================ */

test('流式: tool_calls 的分片要按 index 拼成完整的调用', async () => {
  await withGateway((parsed, res) => {
    sse(res, [
      // 名字整段来、arguments 分两片 —— 这是最常见的形状
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'sql', arguments: '{"query":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"select 1"' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 9 } },
      '[DONE]'
    ]);
  }, async (g) => {
    const out = await g.client().chatStep(msgs, [{ type: 'function', function: { name: 'sql' } }], { onDelta: () => {} });
    assert.strictEqual(out.toolCalls.length, 1);
    assert.strictEqual(out.toolCalls[0].name, 'sql');
    assert.deepStrictEqual(out.toolCalls[0].args, { query: 'select 1' }, 'arguments 的碎片要拼对');
    assert.strictEqual(out.toolCalls[0].id, 'call_1');
    assert.strictEqual(out.finishReason, 'tool_calls');
  });
});

test('流式: 同一步里的多个 tool_call 按 index 分开, 不串味', async () => {
  await gatewayTwoCalls(async (g) => {
    const out = await g.client().chatStep(msgs, [], { onDelta: () => {} });
    assert.strictEqual(out.toolCalls.length, 2);
    assert.strictEqual(out.toolCalls[0].name, 'read_a');
    assert.deepStrictEqual(out.toolCalls[0].args, { n: 1 });
    assert.strictEqual(out.toolCalls[1].name, 'read_b');
    assert.deepStrictEqual(out.toolCalls[1].args, { n: 2 });
  });
});
async function gatewayTwoCalls(fn) {
  return withGateway((parsed, res) => {
    sse(res, [
      { choices: [{ delta: { tool_calls: [
        { index: 0, id: 'a', type: 'function', function: { name: 'read_a', arguments: '{"n":1}' } },
        { index: 1, id: 'b', type: 'function', function: { name: 'read_b', arguments: '{"n":2}' } }
      ] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    ]);
  }, fn);
}

/* ============================================================
 * 3. 网关不支持 stream -> 自动退回非流式
 * ============================================================ */

test('流式: 网关不认 stream 时自动退回非流式, 整轮不失败', async () => {
  await withGateway((parsed, res) => {
    if (parsed.stream) {
      // 网关对流式报錯 (常见: 不认 stream 参数)
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'stream not supported' } }));
      return;
    }
    // 非流式: 正常返回
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '退回了' }, finish_reason: 'stop' }] }));
  }, async (g) => {
    const c = g.client();
    const out = await c.chatStep(msgs, [], { onDelta: () => {} });
    assert.strictEqual(out.content, '退回了', '应该退回非流式并拿到结果');
    assert.strictEqual(c.streamUnsupported, true, '记下网关不吃流式, 之后不再白试');
    assert.strictEqual(g.seen.length, 2, '一次流式失败 + 一次非流式成功');
    // 第二次直接用非流式 (stream 是 false, 不是 true), 不再试 stream
    const out2 = await c.chatStep(msgs, [], { onDelta: () => {} });
    assert.strictEqual(out2.content, '退回了');
    assert.notStrictEqual(g.seen[2].stream, true, '第二次不该再走流式');
  });
});

test('流式: 不传 onDelta 时不走流式 (老路径不受影响)', async () => {
  await withGateway((parsed, res) => {
    assert.notStrictEqual(parsed.stream, true, '没传 onDelta 就不该开流式');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '普通' }, finish_reason: 'stop' }] }));
  }, async (g) => {
    const out = await g.client().chatStep(msgs, []);
    assert.strictEqual(out.content, '普通');
  });
});
