'use strict';

/**
 * LLM 客户端的**瞬时故障重试**。
 *
 * 起因是一个真实故障: 用户搭卡搭到一半, 屏幕上出现一句 `socket hang up`,
 * 整个流程就断了。
 *
 * 根因不在网络本身 —— 网络抖一下是常态 —— 而在于**系统没有重试**:
 *   - llm.js 只对"网关不吃 tools"和"配额截断"重试
 *   - agent-loop.js 收到任何异常就 stopReason='error' 整轮结束
 * 于是 VPN 抖一次, 用户搭了半小时的卡就废了。
 *
 * 证据: 会话日志里模型自己说过"连接超时了两次, 我再试一次" ——
 * 本该由传输层做的重试被模型用自然语言在补, 而模型看不见 socket 状态,
 * 它猜错的时候就是整个任务失败。
 *
 * 这个文件用**真实的本地 HTTP 服务**制造各种故障, 不 mock 网络。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

const LLMClient = require('../lib/llm.js');
const { isTransient, friendlyLLMError, maxAttemptsFor, RETRY_MAX_ATTEMPTS } = LLMClient;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 造一个"按剧本办事"的假网关。
 * plan[i] 决定第 i+1 次请求怎么应答:
 *   'hangup'    -> 直接销毁 socket (真·socket hang up)
 *   'ok'        -> 正常返回
 *   {status:n}  -> 返回 n 状态码
 * 剧本用完之后重复最后一项。
 */
function startGateway(plan, opts = {}) {
  const seen = [];
  const s = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const step = plan[seen.length] !== undefined ? plan[seen.length] : plan[plan.length - 1];
      seen.push(step);
      if (step === 'hangup') { req.socket.destroy(); return; }
      if (typeof step === 'object' && step.status) {
        // html: true -> 模拟 nginx / 企业代理过载时吐的那一页 HTML, 而不是 JSON。
        // 这条路径以前完全没被测到, 所以"非 JSON 错误体不重试"的 bug 一直藏着。
        if (step.html) {
          res.writeHead(step.status, { 'Content-Type': 'text/html' });
          res.end('<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>');
          return;
        }
        res.writeHead(step.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: step.message || 'boom' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '好的' } }] }));
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
          timeoutMs: opts.timeoutMs || 1500,
          ...(extra || {})
        }),
        // 必须主动掐掉已有连接: Node 19+ 的客户端默认 keepAlive,
        // 光调 server.close() 会等那些长连接自己结束 —— 回调永远不触发, 测试挂死。
        close: () => new Promise((r) => { s.closeAllConnections(); s.close(() => r()); })
      });
    });
  });
}

/**
 * 跑一段测试并**保证关掉服务端**。
 *
 * 为什么必须 finally: 断言失败时如果漏掉 close(), 服务端会一直开着,
 * 事件循环不退出 —— `node --test` 就永远等下去, 报出来的是"超时"而不是
 * 那条真正失败的断言。刚才就是这么被坑的。
 */
async function withGateway(plan, opts, fn) {
  const g = await startGateway(plan, opts);
  try {
    return await fn(g);
  } finally {
    await g.close();
  }
}

const msgs = [{ role: 'user', content: 'hi' }];

/** 抓错误, 方便断言 */
async function grabErr(fn) {
  try { await fn(); } catch (e) { return e; }
  return null;
}

/* ============================================================
 * 1. 判定逻辑: 什么值得重试
 * ============================================================ */

test('判定: 连接层瞬时故障都算可重试', () => {
  for (const code of ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ESOCKETTIMEDOUT',
    'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN']) {
    assert.strictEqual(isTransient({ code }), true, code + ' 应该可重试');
  }
});

test('判定: 网关过载/限流算可重试', () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    assert.strictEqual(isTransient({ status }), true, status + ' 应该可重试');
  }
});

test('判定: 重试没意义的错误不能重试 (否则只是让用户白等)', () => {
  assert.strictEqual(isTransient({ status: 401 }), false, '401 密钥错, 重试一百次也一样');
  assert.strictEqual(isTransient({ status: 403 }), false);
  assert.strictEqual(isTransient({ status: 400 }), false, '400 请求本身有问题');
  assert.strictEqual(isTransient({ status: 404 }), false);
  assert.strictEqual(isTransient({ status: 413 }), false, '413 请求太大');
  assert.strictEqual(isTransient({ code: 'ABORT_ERR' }), false, '用户点了停止');
  assert.strictEqual(isTransient({ code: 'RESPONSE_TOO_LARGE' }), false);
});

test('判定: 超时类只给一次重试 (一次要等满 timeout, 多试等于让用户干等)', () => {
  assert.strictEqual(maxAttemptsFor({ code: 'ETIMEDOUT' }), 2);
  assert.strictEqual(maxAttemptsFor({ code: 'ESOCKETTIMEDOUT' }), 2);
  assert.strictEqual(maxAttemptsFor({ code: 'ECONNRESET' }), RETRY_MAX_ATTEMPTS);
});

/* ============================================================
 * 2. 真的会重试 (端到端, 真网络故障)
 * ============================================================ */

test('socket hang up 之后自动重试, 第二次成功就正常返回', async () => {
  await withGateway(['hangup', 'ok'], {}, async (g) => {
    const r = await g.client().chat(msgs);
    assert.strictEqual(r, '好的', '重试后应该拿到结果');
    assert.strictEqual(g.seen.length, 2, '应该发了 2 次请求 (首次失败 + 重试成功)');
  });
});

test('连挂两次也能救回来 (重试上限内)', async () => {
  await withGateway(['hangup', 'hangup', 'ok'], {}, async (g) => {
    const r = await g.client().chat(msgs);
    assert.strictEqual(r, '好的');
    assert.strictEqual(g.seen.length, 3);
  });
});

test('502/503 网关过载会重试', async () => {
  await withGateway([{ status: 503, message: 'upstream down' }, 'ok'], {}, async (g) => {
    const r = await g.client().chat(msgs);
    assert.strictEqual(r, '好的');
    assert.strictEqual(g.seen.length, 2);
  });
});

/* ============================================================
 * 3. 不该重试的绝不重试
 * ============================================================ */

test('401 不重试: 密钥错重试一百次也一样, 只是让用户白等', async () => {
  await withGateway([{ status: 401, message: 'invalid api key' }], {}, async (g) => {
    await assert.rejects(() => g.client().chat(msgs));
    assert.strictEqual(g.seen.length, 1, '401 只能发一次请求');
  });
});

test('400 不重试', async () => {
  await withGateway([{ status: 400, message: 'bad request' }], {}, async (g) => {
    await assert.rejects(() => g.client().chat(msgs));
    assert.strictEqual(g.seen.length, 1);
  });
});

/* ============================================================
 * 4. 重试耗尽之后: 错误必须是用户看得懂的
 * ============================================================ */

test('重试耗尽: 抛出的不再是 socket hang up 这种光秃秃的原文', async () => {
  await withGateway(['hangup'], {}, async (g) => {
    const err = await grabErr(() => g.client().chat(msgs));
    assert.ok(err, '应该抛错');

    // 要点是"有中文解释", 不是"绝不出现技术术语" ——
    // 术语放在括号里是刻意的: 中文先讲清楚, 术语留给需要转发/搜索的人。
    assert.notStrictEqual(err.message.trim(), 'socket hang up', '不能原样上抛');
    assert.match(err.message, /连接被中断/, '要有中文解释');
    assert.match(err.message, /重试/, '要告诉用户已经自动重试过了');
    assert.match(err.message, /VPN|网络/, '要给出可执行的下一步');

    // 术语如果出现, 必须是被解释包着的, 不是开头第一句
    if (/socket hang up/i.test(err.message)) {
      assert.strictEqual(/^socket hang up/i.test(err.message), false,
        '不能拿术语当开头: ' + err.message);
    }

    assert.strictEqual(err.code, 'ECONNRESET', '原始 code 要保留');
    assert.ok(err.raw, '原始 error 要挂在 raw 上');
  });
});

test('重试耗尽: 抛出的错误保留 code 和 body (上层靠它们分流)', async () => {
  // chatStep 靠 body 判断"网关不支持 tools"; agent-loop 靠 code 判断"是不是取消"
  await withGateway([{ status: 503, message: 'tools not supported here' }], {}, async (g) => {
    const err = await grabErr(() => g.client().chat(msgs));
    assert.strictEqual(err.status, 503);
    assert.ok(err.body, 'body 必须保留, 否则 tools 降级那条路会失效');
    assert.match(JSON.stringify(err.body), /tools not supported/);
  });
});

test('错误翻译: 各种故障都有中文解释', () => {
  assert.match(friendlyLLMError({ code: 'ECONNRESET' }), /连接被中断/);
  assert.match(friendlyLLMError({ code: 'ENOTFOUND' }), /域名解析/);
  assert.match(friendlyLLMError({ code: 'ETIMEDOUT' }), /超时/);
  assert.match(friendlyLLMError({ code: 'ECONNREFUSED' }), /拒绝连接/);
  assert.match(friendlyLLMError({ status: 401 }), /API Key/);
  assert.match(friendlyLLMError({ status: 429 }), /限流/);
  assert.match(friendlyLLMError({ status: 502 }), /服务端的问题/);
  assert.match(friendlyLLMError({ code: 'WEIRD', message: 'wat' }), /wat/, '认不出的原样返回, 不编解释');
});

/* ============================================================
 * 5. 取消: 退避期间点停止也要停得住
 * ============================================================ */

test('退避期间调用 abort(): 不再重试, 且以"取消"收尾而不是"网络故障"', async () => {
  await withGateway(['hangup'], {}, async (g) => {
    const c = g.client();
    const inflight = c.chat(msgs);
    await sleep(150);          // 等第一次失败、进入退避
    c.abort();

    const err = await grabErr(() => inflight);
    // 这一条是关键: 退避期间手上那个错误是 ECONNRESET (触发重试的原因),
    // 但它不是"被取消"。直接抛它的话 agent-loop 会把 stopReason 记成 error,
    // 界面上显示成一次故障, 而不是"你自己点的停止"。
    assert.strictEqual(err.code, 'ABORT_ERR',
      '必须报"取消", 不能报成网络故障。实际 code=' + err.code + ' msg=' + err.message);

    const n = g.seen.length;
    await sleep(1400);         // 等过一轮退避窗口
    assert.strictEqual(g.seen.length, n, 'abort 之后不该再发请求');
  });
});

test('abort 在没有在飞请求时也置旗标 (否则退避期间点停止是空操作)', async () => {
  await withGateway(['hangup'], {}, async (g) => {
    const c = g.client();
    const inflight = c.chat(msgs);
    await sleep(150);
    assert.strictEqual(c._active, null, '前提: 退避期间没有在飞请求');
    assert.strictEqual(c.abort(), false, '没有在飞请求, 返回值是 false');
    assert.strictEqual(c._aborted, true, '但旗标必须置上, 重试循环要能看见');
    const err = await grabErr(() => inflight);
    assert.strictEqual(err.code, 'ABORT_ERR');
  });
});

/* ============================================================
 * 6. 不重试的错误不能被包装成"重试过了"
 * ============================================================ */

test('401 的错误信息不能提"已经重试过" (那是误导)', async () => {
  await withGateway([{ status: 401, message: 'invalid api key' }], {}, async (g) => {
    const err = await grabErr(() => g.client().chat(msgs));
    assert.strictEqual(/重试/.test(err.message), false,
      '401 一次都没重试, 不能说重试过: ' + err.message);
  });
});

test('重试回调: 每次重试都通知一次 (界面据此说"正在重试")', async () => {
  await withGateway(['hangup', 'hangup', 'ok'], {}, async (g) => {
    const c = g.client();
    const notes = [];
    c.onRetry = (info) => notes.push(info);
    await c.chat(msgs);
    assert.strictEqual(notes.length, 2, '挂了两次, 应该通知两次');
    assert.strictEqual(notes[0].attempt, 1);
    assert.ok(notes[0].waitMs > 0, '要带上退避时长');
  });
});

/* ============================================================
 * 7. 非 JSON 错误体 (nginx / 代理的 HTML 502/503)
 *
 * 起因: 网关过载时吐的是一页 HTML, 不是 JSON。以前状态码判断写在
 * JSON.parse 的 try 里, 解析一失败就跟着走 catch —— err.status 丢了,
 * isTransient 判成 false, 于是一次都不重试, 还把整段 HTML 当错误信息抛给用户。
 * 而这恰恰是重试机制最该生效的场景 (文件头注释里那个"搭到一半的卡全废")。
 * ============================================================ */

test('网关吐 HTML 的 503 也要重试 (以前一次都不重试)', async () => {
  await withGateway([{ status: 503, html: true }, 'ok'], {}, async (g) => {
    const r = await g.client().chat(msgs);
    assert.strictEqual(r, '好的', 'HTML 503 之后应该重试并成功');
    assert.strictEqual(g.seen.length, 2, '应该发了 2 次 (首次 HTML 503 + 重试成功), 实际 ' + g.seen.length);
  });
});

test('HTML 错误体必须把 HTTP 状态码带出来 (丢了它就没法判重试)', async () => {
  await withGateway([{ status: 503, html: true }], {}, async (g) => {
    const err = await grabErr(() => g.client().chat(msgs));
    assert.strictEqual(err.status, 503,
      'err.status 必须是 503; 实际 ' + err.status + ', msg=' + err.message);
    assert.strictEqual(isTransient(err), true, '带着 status 才能被判成可重试');
  });
});

test('HTML 错误体不该被报成"返回解析失败" (那是内部细节, 用户看不懂)', async () => {
  await withGateway([{ status: 502, html: true }], {}, async (g) => {
    const err = await grabErr(() => g.client().chat(msgs));
    assert.strictEqual(/解析失败/.test(err.message), false,
      '应该报 HTTP 状态码, 而不是 JSON 解析失败: ' + err.message);
  });
});
