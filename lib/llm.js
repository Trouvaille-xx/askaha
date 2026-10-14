/**
 * OpenAI 兼容的 LLM 客户端
 * 通过原生 https/http 模块实现，避免引入额外依赖
 *
 * 两种调用方式:
 *   chat(messages)              -> 返回正文文本 (给"要一段 JSON"这类小调用用)
 *   chatStep(messages, tools)   -> 返回 { content, reasoning, toolCalls, truncated }
 *
 * 为什么主循环要走原生 tools:
 *   把动作定义放在系统提示里当"文字约定", 模型随时可能不守规矩。实测
 *   deepseek-v4.1-flash 会把工具调用写成自家方言 (DSML 标记) 塞进正文, 于是
 *   正文里既没有合法 JSON、也没有 tool_calls, 整单任务直接失败。
 *   走标准的 tools/tool_calls 通道, 模型有正规出口就不会往正文里写方言。
 *
 * 关于降级:
 *   不是所有网关都支持 tools。_request 遇到明确"tools 不支持"的错误时会给
 *   this.toolsUnsupported 打标, 之后自动不再带 tools, 由上层退回文本解析。
 *
 * 关于推理模型:
 *   会额外返回 reasoning_content, 它和 content 共用 max_tokens 配额。
 *   配额给小了, 正文会被截断甚至整段为空 —— 这是"无法解析"的另一个来源。
 *   所以这里 (1) 默认配额给得宽, (2) 单独取 reasoning 不混进正文,
 *   (3) 发现 finish_reason=length 就标 truncated, 让上层能重试。
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

// 推理模型"先想后答", 想的部分也吃配额, 所以不能按普通模型给 2048
const DEFAULT_MAX_TOKENS = 8192;
const RETRY_MAX_TOKENS = 16384;

// 单次请求的空闲超时: 超过这么久没收到任何数据就中断。
// 不设的话, 网关抽风时这条 promise 永远不 settle, 整个任务无限期卡死 ——
// 而用户只能看着一个既发不出也停不掉的界面。
// 用 socket 空闲超时 (不是总时长): 流式/长响应只要还在吐数据就不会被误杀。
// 注: 自动测试那条路径现在有真的取消通道了 (abort() 由 engine:autoTestCancel 调用),
//     分析模式那条还没有 —— 它只能靠这个超时兜底。
const DEFAULT_TIMEOUT_MS = Number(process.env.SOLODB_LLM_TIMEOUT_MS) || 180000;

// 单次响应体上限, 防止网关不认 max_tokens 时把内存吃满
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/**
 * 瞬时故障重试。
 *
 * 为什么必须有: 以前 chatStep 只对"网关不吃 tools"和"配额截断"重试, **网络抖动完全没管**。
 * 而 agent-loop 收到任何异常就立刻 `stopReason='error'` 整轮结束 —— 于是内网 VPN
 * 抖一下、网关重启一次, 用户搭到一半的卡就废了, 屏幕上只有一句 `socket hang up`。
 *
 * 实测证据: 会话日志里模型自己说过"连接超时了两次, 我再试一次" ——
 * 本该由传输层做的重试, 被模型用自然语言在补。那是本末倒置:
 * 模型看不见 socket 状态, 它只能猜, 而且它猜错的时候就是整个任务失败。
 *
 * 为什么重试是安全的: 一次 chat/completions 要么没被处理, 要么已经算完。
 * 我们**收到完整响应之后才会去执行工具调用**, 所以重试不会造成动作被执行两次。
 * 代价只是可能多花一次 token —— 比"搭了半小时的卡全丢"便宜得多。
 */
const RETRY_MAX_ATTEMPTS = 3;      // 首次 + 2 次重试
const RETRY_BASE_MS = 800;         // 退避基数
const RETRY_MAX_MS = 8000;

/** 连接层面的瞬时故障 —— 重试有意义 */
const RETRYABLE_CODES = new Set([
  'ECONNRESET',        // 对端掐断, 就是 "socket hang up"
  'EPIPE',             // 往已关闭的 socket 写
  'ETIMEDOUT',         // 空闲超时
  'ESOCKETTIMEDOUT',
  'ECONNREFUSED',      // 网关正在重启
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',         // DNS 解析失败 (VPN 刚连上/刚断)
  'EAI_AGAIN',         // DNS 临时失败
  'ERR_STREAM_PREMATURE_CLOSE'
]);

/** 网关过载/限流 —— 等一下再试通常就好了 */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * 超时类故障本身就很慢 (一次要等满 timeoutMs)。
 * 对它重试两次 = 让用户干等好几分钟, 所以只给一次重试机会。
 * 连接类故障是"秒失败", 重试代价低, 可以多试。
 */
const SLOW_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT']);

function maxAttemptsFor(err) {
  if (err && err.status) return RETRY_MAX_ATTEMPTS;
  return SLOW_CODES.has(err && err.code) ? 2 : RETRY_MAX_ATTEMPTS;
}

/**
 * 这个错误值不值得重试。
 *
 * 明确**不重试**的: 401/403 (密钥不对)、400/404/413 (请求本身有问题)、
 * ABORT_ERR (用户点了停止)、以及响应体过大 —— 这些再试一百次也是同样的结果,
 * 重试只会让用户多等。
 */
function isTransient(err) {
  if (!err) return false;
  if (err.code === 'ABORT_ERR') return false;
  if (err.code === 'RESPONSE_TOO_LARGE') return false;
  if (err.status) return RETRYABLE_STATUS.has(Number(err.status));
  return RETRYABLE_CODES.has(err.code);
}

/** 退避 + 抖动。抖动是必须的: 多个请求同时失败时不能一起回来再撞一次。 */
function backoffMs(attempt) {
  const base = Math.min(RETRY_BASE_MS * Math.pow(2, attempt - 1), RETRY_MAX_MS);
  return Math.round(base * (0.6 + Math.random() * 0.8));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把连接层错误翻成人话 —— `socket hang up` 对业务用户等于没说话 */
function friendlyLLMError(err) {
  const raw = String((err && err.message) || err || '');
  if (err && err.status) {
    if (err.status === 401 || err.status === 403) return `模型服务拒绝了这次调用 (${err.status}): API Key 不对或没有权限。请到「设置 · 模型」页核对。`;
    if (err.status === 429) return '模型服务限流了 (429): 请求太频繁或额度用完了。等一会儿再试。';
    if (err.status >= 500) return `模型服务出错了 (${err.status}): 这是服务端的问题, 不是你配错了。过一会儿再试。`;
    return `模型服务返回 ${err.status}: ${raw}`;
  }
  switch (err && err.code) {
    case 'ECONNRESET':
      return '和模型服务的连接被中断了 (socket hang up)。通常是网络抖动或网关重启 —— 已经自动重试过, 还是不通。请检查 VPN / 网络后重试。';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return '模型服务的域名解析不了 (连不上 ' + ((err && err.hostname) || '网关') + ')。通常是没连 VPN 或 DNS 出问题。';
    case 'ETIMEDOUT':
    case 'ESOCKETTIMEDOUT':
      return '等模型服务响应超时了。可能是网关太慢或请求太重 —— 已经自动重试过。';
    case 'ECONNREFUSED':
      return '模型服务拒绝连接: 网关没起来, 或者地址/端口不对。';
    default:
      return raw;
  }
}

/**
 * 从一次响应里取出 token 用量, 归一成 { input, output }。
 *
 * 为什么要归一: 字段名各家不一样 —— OpenAI 系是 prompt_tokens / completion_tokens,
 * Anthropic 系和部分网关是 input_tokens / output_tokens。上层只想知道"进多少出多少",
 * 不该让它认识四五种拼法。
 *
 * 取不到就返回 null, **不要编 0** —— "这次没报用量"和"这次用了 0 个 token"
 * 是两件不同的事, 混在一起之后界面上的累计数就再也对不上了。
 */
function usageOf(res) {
  const u = res && res.usage;
  if (!u || typeof u !== 'object') return null;
  const pick = (...names) => {
    for (const n of names) {
      const v = u[n];
      if (Number.isFinite(v) && v >= 0) return v;
    }
    return null;
  };
  const input = pick('prompt_tokens', 'input_tokens');
  const output = pick('completion_tokens', 'output_tokens');
  if (input === null && output === null) return null;
  return { input: input || 0, output: output || 0 };
}

/** 两份额用量相加。任意一份为 null 时返回另一份 (不是 0) */
function addUsage(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return { input: (a.input || 0) + (b.input || 0), output: (a.output || 0) + (b.output || 0) };
}

class LLMClient {
  constructor(config) {
    this.config = {
      baseURL: (config.baseURL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
      apiKey: config.apiKey || '',
      model: config.model || 'gpt-4o-mini',
      temperature: typeof config.temperature === 'number' ? config.temperature : 0.2,
      maxTokens: config.maxTokens || DEFAULT_MAX_TOKENS,
      // 模型上下文窗口 (用户可在「设置 · 模型」里填)。以前它只喂给界面上那个占用环,
      // 从没进过 AgentLoop —— 于是"压不压缩"只能靠一个跟模型无关的字符阈值猜。
      // 0 表示没配, 上层据此退回字符估算 (见 lib/agent-loop.js 的 tokenBudget)。
      contextLimit: Number(config.contextLimit) || 0
    };
    // 网关不支持 tools 时置位, 之后不再带 tools (避免每次白跑一次失败请求)
    this.toolsUnsupported = false;
    // 网关不支持 stream 时置位, 之后不再走流式 (退回非流式, 避免每次白跑一次失败请求)
    this.streamUnsupported = false;
    this.timeoutMs = Number(config.timeoutMs) || DEFAULT_TIMEOUT_MS;
    this._active = null;    // 当前在飞的请求, 供 abort() 用
    this._aborted = false;  // 用户是否已取消 (重试退避期间也要能看见)
    // 可选: 重试时回调一次, 让界面能说"网络抖了一下, 正在重试"
    this.onRetry = null;
  }

  update(config) {
    this.config = { ...this.config, ...config };
  }

  /**
   * 中断当前在飞的请求。任务被取消 / 窗口关闭时调用, 避免请求悬着不放。
   * 被中断的 _request 会以 ABORT_ERR 拒绝, 由调用方决定怎么收尾。
   *
   * 注意这里**不只看在飞的请求**: 重试退避的那段时间里 _active 是空的,
   * 只判断 _active 的话用户点「停止」会点不动, 退避结束还会照常再发一次。
   * 所以置一个 _aborted 旗标, 让重试循环能看见。
   */
  abort(reason = 'LLM 请求已被取消') {
    this._aborted = true;
    const req = this._active;
    if (!req) return false;
    this._active = null;
    const err = new Error(reason);
    err.code = 'ABORT_ERR';
    req.destroy(err);
    return true;
  }

  /**
   * 发一次请求, 瞬时故障自动重试。
   *
   * 为什么要包一层: 见文件顶部关于 RETRY_MAX_ATTEMPTS 的说明 ——
   * 网络抖一下不该让用户搭了半小时的卡全废。
   */
  async _request(body, opts = {}) {
    const attempts = Math.max(1, Number(opts.retryAttempts) || RETRY_MAX_ATTEMPTS);
    this._aborted = false;   // 新一次调用, 清掉上一次的取消旗标
    let lastErr = null;

    /**
     * 以"用户取消"的形式收尾。
     *
     * 为什么不能顺手把 lastErr 抛出去: 退避期间点停止时, 手上那个错误是
     * ECONNRESET (触发重试的原因), 不是"被取消"。直接抛它的话 agent-loop 的
     * `e.code === 'ABORT_ERR'` 判断落空, stopReason 会变成 error 而不是 cancelled ——
     * 界面上就显示成一次网络故障, 而不是"你自己点的停止"。
     */
    const cancelled = () => {
      const e = new Error('LLM 请求已被取消');
      e.code = 'ABORT_ERR';
      return e;
    };

    for (let i = 1; i <= attempts; i++) {
      try {
        return await this._requestOnce(body, opts);
      } catch (e) {
        if (this._aborted) throw cancelled();
        lastErr = e;
        // 这个错重试没意义 (密钥错 / 请求本身有问题) -> 立刻放弃
        if (!isTransient(e) || i >= attempts) break;
        // 超时类只给一次重试, 见 SLOW_CODES
        if (i >= maxAttemptsFor(e)) break;
        const wait = backoffMs(i);
        // 让上层能告诉用户"在重试", 而不是干等
        if (typeof this.onRetry === 'function') {
          try { this.onRetry({ attempt: i, max: Math.min(attempts, maxAttemptsFor(e)), waitMs: wait, error: e }); } catch (err) {}
        }
        await sleep(wait);
        if (this._aborted) throw cancelled();
      }
    }
    // 重试也没通 -> 换成用户看得懂的话再抛。
    // 原始 error 挂回 raw; body 也要带上 —— chatStep 靠 body 判断"网关不支持 tools",
    // 丢了这个字段会让那条降级路径失效。
    const friendly = new Error(friendlyLLMError(lastErr));
    friendly.code = (lastErr && lastErr.code) || 'LLM_ERROR';
    friendly.status = lastErr && lastErr.status;
    friendly.body = lastErr && lastErr.body;
    friendly.raw = lastErr;
    throw friendly;
  }

  _requestOnce(body, opts = {}) {
    return new Promise((resolve, reject) => {
      let url;
      try {
        url = new URL(this.config.baseURL + '/chat/completions');
      } catch (e) {
        return reject(new Error('LLM baseURL 格式不正确: ' + e.message));
      }
      const lib = url.protocol === 'https:' ? https : http;

      const payloadObj = {
        model: this.config.model,
        messages: wireMessages(body.messages),
        temperature: typeof opts.temperature === 'number' ? opts.temperature : this.config.temperature,
        max_tokens: opts.maxTokens || this.config.maxTokens,
        stream: false
      };
      if (Array.isArray(body.tools) && body.tools.length) {
        payloadObj.tools = body.tools;
        payloadObj.tool_choice = body.tool_choice || 'auto';
      }
      const payload = JSON.stringify(payloadObj);

      const req = lib.request(
        {
          method: 'POST',
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search,
          timeout: this.timeoutMs,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            ...(this.config.apiKey ? { Authorization: 'Bearer ' + this.config.apiKey } : {})
          }
        },
        (res) => {
          let data = '';
          let bytes = 0;
          res.setEncoding('utf-8');
          res.on('data', (c) => {
            bytes += Buffer.byteLength(c);
            if (bytes > MAX_RESPONSE_BYTES) {
              const err = new Error('LLM 响应体过大, 已中断');
              err.code = 'RESPONSE_TOO_LARGE';
              req.destroy(err);
              return;
            }
            data += c;
          });
          res.on('end', () => {
            // 不管走哪条分支都要清 _active。以前 >=400 那条不清, 于是请求结束之后
            // _active 还指着一条已经死掉的请求, abort() 会返回 true 但实际是空操作。
            if (this._active === req) this._active = null;
            let json = null;
            try {
              json = JSON.parse(data);
            } catch (e) {
              // 网关返回**非 JSON** 错误体是常事: nginx / 企业代理过载时吐的
              // 是一页 HTML 的 502/503。以前状态码判断写在 JSON.parse 的 try 里,
              // 解析一失败就跟着走 catch —— err.status 丢了, isTransient 判成
              // false, 于是**一次都不重试** (而这恰恰是重试机制最该生效的场景),
              // 用户看到的是 "LLM 返回解析失败: Unexpected token '<'..."。
              //
              // 现在: 解析失败也要先把 HTTP 状态码认出来, 交给上层决定重不重试。
              if (res.statusCode >= 400) {
                const err = new Error(
                  `HTTP ${res.statusCode} (响应不是 JSON, 前 120 字: ${String(data).slice(0, 120)})`
                );
                err.status = res.statusCode;
                err.body = data;
                return reject(err);
              }
              return reject(new Error('LLM 返回解析失败: ' + e.message + ' / raw=' + data.slice(0, 200)));
            }
            if (res.statusCode >= 400) {
              const msg = (json.error && json.error.message) || `HTTP ${res.statusCode}`;
              const err = new Error(msg);
              err.status = res.statusCode;
              err.body = json;
              return reject(err);
            }
            resolve(json);
          });
          res.on('error', (e) => {
            if (this._active === req) this._active = null;
            reject(e);
          });
        }
      );
      this._active = req;
      req.on('error', (e) => {
        if (this._active === req) this._active = null;
        reject(e);
      });
      req.on('timeout', () => {
        const err = new Error(`LLM 请求超时 (${Math.round(this.timeoutMs / 1000)} 秒无响应), 已中断`);
        err.code = 'ETIMEDOUT';
        req.destroy(err);
      });
      req.write(payload);
      req.end();
    });
  }

  /**
   * 流式请求: 逐段把**正文**回调出去, 同时累积出与非流式**同形状**的结果。
   *
   * ## 为什么返回非流式的形状
   *   chatStep 之后的处理 (取 choices[0].message、normalizeToolCalls、usage、截断判定)
   *   一行都不用改 —— 流式只换"怎么拿到这份 JSON", 不换它的形状。这是最不容易出错的做法。
   *
   * ## 只回调正文
   *   content 的增量交给 opts.onDelta; reasoning (思考) 只累积、不回调 —— 界面不看过程。
   *
   * ## 工具调用分片
   *   流式下 tool_calls 是一帧帧来的 (index 标识第几个, function.arguments 是碎片),
   *   必须按 index 拼起来, 最后交给 normalizeToolCalls 解析。拼错了 = 工具调不动。
   */
  _requestStream(body, opts = {}) {
    return new Promise((resolve, reject) => {
      let url;
      try {
        url = new URL(this.config.baseURL + '/chat/completions');
      } catch (e) {
        return reject(new Error('LLM baseURL 格式不正确: ' + e.message));
      }
      const lib = url.protocol === 'https:' ? https : http;

      const payloadObj = {
        model: this.config.model,
        messages: wireMessages(body.messages),
        temperature: typeof opts.temperature === 'number' ? opts.temperature : this.config.temperature,
        max_tokens: opts.maxTokens || this.config.maxTokens,
        stream: true,
        stream_options: { include_usage: true }
      };
      if (Array.isArray(body.tools) && body.tools.length) {
        payloadObj.tools = body.tools;
        payloadObj.tool_choice = body.tool_choice || 'auto';
      }
      const payload = JSON.stringify(payloadObj);

      const onDelta = typeof opts.onDelta === 'function' ? opts.onDelta : null;
      const acc = { content: '', reasoning: '', toolCalls: [], usage: null, finishReason: '' };
      let buf = '';
      let bytes = 0;
      let started = false;   // 是否已经收到过任何片段 (决定"失败能不能重跑": 吐过了就不能)
      let done = false;

      const handleObj = (json) => {
        if (!json || typeof json !== 'object') return;
        // usage 通常单独一帧 (choices 为空) —— 必须在"没有 choices 就 return"之前接住
        // usage 通常单独一帧 (choices 为空) —— 必须在"没有 choices 就 return"之前接住。
        // 存**原始**形状 (prompt_tokens/…), 交给 chatStep 的 usageOf 归一 —— 别在这里先归一,
        // 否则 chatStep 再 usageOf 一次就认不出来了 (字段名不是它认的那几个)。
        if (json.usage) acc.usage = json.usage;
        const ch = (json.choices && json.choices[0]) || null;
        if (!ch) return;
        if (ch.finish_reason) acc.finishReason = ch.finish_reason;
        const d = ch.delta || {};
        if (typeof d.content === 'string' && d.content) {
          acc.content += d.content;
          started = true;
          if (onDelta) { try { onDelta(d.content); } catch (e) { /* 回调出错不该打断流 */ } }
        }
        if (typeof d.reasoning_content === 'string') { acc.reasoning += d.reasoning_content; started = true; }
        else if (typeof d.reasoning === 'string') { acc.reasoning += d.reasoning; started = true; }
        if (Array.isArray(d.tool_calls)) {
          started = true;
          for (const tc of d.tool_calls) {
            const i = Number.isInteger(tc.index) ? tc.index : 0;
            const slot = acc.toolCalls[i] || (acc.toolCalls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } });
            if (tc.id) slot.id = tc.id;
            if (tc.type) slot.type = tc.type;
            const fn = tc.function || {};
            if (fn.name != null) slot.function.name += String(fn.name);
            if (fn.arguments != null) slot.function.arguments += String(fn.arguments);
          }
        }
      };

      const finish = () => {
        if (done) return;
        done = true;
        const toolCalls = acc.toolCalls.filter(Boolean).map((tc) => ({
          id: tc.id || '',
          type: tc.type || 'function',
          function: { name: tc.function.name, arguments: tc.function.arguments }
        }));
        resolve({
          choices: [{
            message: {
              role: 'assistant',
              content: acc.content || '',
              reasoning_content: acc.reasoning || '',
              tool_calls: toolCalls.length ? toolCalls : undefined
            },
            finish_reason: acc.finishReason || 'stop'
          }],
          usage: acc.usage
        });
      };

      const fail = (err) => {
        if (done) return;
        done = true;
        // 已经吐了半截内容: 记下来, 上层据此决定"不能重跑一遍"(重跑会重复显示)
        if (err && typeof err === 'object') err.afterStreamStart = started;
        reject(err);
      };

      const req = lib.request(
        {
          method: 'POST',
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search,
          timeout: this.timeoutMs,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            Accept: 'text/event-stream',
            ...(this.config.apiKey ? { Authorization: 'Bearer ' + this.config.apiKey } : {})
          }
        },
        (res) => {
          // 非 2xx: 响应体是普通 JSON 错误 (不是 SSE)。按"带 status 的错误"抛,
          // 好让 toolsUnsupported 判定和上层降级认得出 (它读 err.body)。
          if (res.statusCode >= 400) {
            let data = '';
            res.setEncoding('utf-8');
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
              if (this._active === req) this._active = null;
              let jb = null;
              try { jb = JSON.parse(data); } catch (e) {}
              const msg = (jb && jb.error && jb.error.message) || `HTTP ${res.statusCode}`;
              const err = new Error(msg);
              err.status = res.statusCode;
              err.body = jb || data;
              fail(err);
            });
            res.on('error', (e) => { if (this._active === req) this._active = null; fail(e); });
            return;
          }

          res.setEncoding('utf-8');
          res.on('data', (chunk) => {
            bytes += Buffer.byteLength(chunk);
            if (bytes > MAX_RESPONSE_BYTES) {
              const err = new Error('LLM 响应体过大, 已中断');
              err.code = 'RESPONSE_TOO_LARGE';
              req.destroy(err);
              return;
            }
            buf += chunk;
            let idx;
            while ((idx = buf.indexOf('\n')) !== -1) {
              let line = buf.slice(0, idx);
              buf = buf.slice(idx + 1);
              if (line.endsWith('\r')) line = line.slice(0, -1);
              if (!line || line.startsWith(':')) continue;          // 空行 / SSE 注释
              if (!line.startsWith('data:')) continue;              // event: / id: / retry: 用不上
              const dataPart = line.slice(5).trim();
              if (dataPart === '[DONE]') { finish(); return; }
              try { handleObj(JSON.parse(dataPart)); } catch (e) { /* 半截帧, 等下一个 chunk */ }
            }
          });
          res.on('end', () => {
            if (this._active === req) this._active = null;
            finish();   // 有的网关不发 [DONE], 到 end 也要尽力收尾
          });
          res.on('error', (e) => { if (this._active === req) this._active = null; fail(e); });
        }
      );
      this._active = req;
      req.on('error', (e) => { if (this._active === req) this._active = null; fail(e); });
      req.on('timeout', () => {
        const err = new Error(`LLM 请求超时 (${Math.round(this.timeoutMs / 1000)} 秒无响应), 已中断`);
        err.code = 'ETIMEDOUT';
        req.destroy(err);
      });
      req.write(payload);
      req.end();
    });
  }

  async chat(messages, opts) {
    const res = await this._request({ messages }, opts);
    const msg = (res.choices && res.choices[0] && res.choices[0].message) || {};
    return msg.content || '';
  }

  /**
   * 带工具的一步。返回 { content, reasoning, toolCalls, truncated, finishReason }
   *
   * toolCalls 已归一化成 [{ id, name, args, rawArguments }]，arguments 尽力解析成对象,
   * 解析不了就留空对象并把原文放进 rawArguments, 让上层自纠错。
   *
   * 配额用尽 (finish_reason=length) 时会自动翻倍重试一次 —— 推理模型很容易
   * 把配额花在思考上, 不重试就会拿到半截 JSON。
   */
  async chatStep(messages, tools, opts = {}) {
    // 这一步模型往返花了多久 (含被截断后的重试)。以前只有整段任务的 elapsedMs,
    // 于是"慢"只能整体感知: 分不清是模型在想还是工具在查库 —— 而这两者
    // 实测差两个数量级 (模型 3~8 秒/步, 一次全表 COUNT(DISTINCT) 要十几秒)。
    const t0 = Date.now();
    const wantTools = Array.isArray(tools) && tools.length && !this.toolsUnsupported;
    // 实际有没有走工具通道, 可能因为网关不吃 tools 而中途变成 false
    let usedTools = wantTools;
    const budget = opts.maxTokens || this.config.maxTokens;

    // 上层传了 onDelta 就要边生成边显示正文 —— 走流式。网关不吃 stream 时,
    // 第一次失败就把 streamUnsupported 置位并退回非流式, 之后不再白试。
    const wantStream = typeof opts.onDelta === 'function' && !this.streamUnsupported;

    let res;
    if (wantStream) {
      try {
        res = await this._requestStream({ messages, tools: wantTools ? tools : null }, { ...opts, maxTokens: budget });
      } catch (e) {
        if (wantTools && looksLikeToolsUnsupported(e)) {
          // 网关不吃 tools: 去掉 tools 重来 (退回非流式, 稳一点)
          this.toolsUnsupported = true;
          usedTools = false;
          res = await this._request({ messages }, { ...opts, maxTokens: budget });
        } else if (e && (e.afterStreamStart || e.code === 'ABORT_ERR')) {
          // 已经吐了半截正文 (重跑会重复显示), 或者这是**用户取消** (重跑等于无视停止) ——
          // 两者都必须如实抛出, 不能退回非流式再来一遍。
          throw e;
        } else {
          // 流式这条路走不通 (网关不认 stream / 瞬时故障): 关掉流式, 退回非流式。
          // _request 自带瞬时重试, 兜底更稳。
          this.streamUnsupported = true;
          res = await this._request({ messages, tools: wantTools ? tools : null }, { ...opts, maxTokens: budget });
        }
      }
    } else {
      try {
        res = await this._request({ messages, tools: wantTools ? tools : null }, { ...opts, maxTokens: budget });
      } catch (e) {
        if (wantTools && looksLikeToolsUnsupported(e)) {
          this.toolsUnsupported = true;
          usedTools = false;
          res = await this._request({ messages }, { ...opts, maxTokens: budget });
        } else {
          throw e;
        }
      }
    }

    // 第一次响应 (可能因为截断被下面换掉)。换掉之前要把它的用量记下来 ——
    // 那一次调用是真花了钱的, 不能因为重试成功就当没发生过。
    let extraUsage = null;

    const choice = (res.choices && res.choices[0]) || {};
    let msg = choice.message || {};
    let finishReason = choice.finish_reason;

    // 被截断: 加大配额再要一次。思考吃掉配额是最常见的成因。
    if (finishReason === 'length' && !(opts.noRetryOnTruncate)) {
      const bigger = Math.max(budget * 2, Math.min(budget + 8192, RETRY_MAX_TOKENS));
      try {
        const res2 = await this._request({ messages, tools: usedTools ? tools : null }, { ...opts, maxTokens: bigger });
        const c2 = (res2.choices && res2.choices[0]) || {};
        if (c2.message) {
          extraUsage = usageOf(res);
          res = res2;
          msg = c2.message;
          finishReason = c2.finish_reason;
        }
      } catch (e) {
        // 重试失败就用手上这份, 交给上层判断
      }
    }

    return {
      content: msg.content || '',
      // reasoning 只是"想的过程", 不参与协议、也不该回灌给下一轮
      reasoning: msg.reasoning_content || msg.reasoning || '',
      toolCalls: normalizeToolCalls(msg.tool_calls),
      truncated: finishReason === 'length',
      finishReason: finishReason || '',
      toolsUsed: usedTools,
      // token 用量。以前这里整个丢掉了 —— 于是界面上永远没法回答
      // "这一轮花了多少"。字段名各家不统一 (OpenAI 系是 prompt/completion_tokens,
      // Anthropic 系是 input/output_tokens), 所以归一成 { input, output }。
      usage: addUsage(usageOf(res), extraUsage),
      elapsedMs: Date.now() - t0
    };
  }

  _extractJSON(text) {
    if (!text) return null;
    // 尝试直接解析
    try {
      return JSON.parse(text);
    } catch (e) {}
    // 尝试抽取 ```json ... ``` 块
    const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) {
      try {
        return JSON.parse(m[1].trim());
      } catch (e) {}
    }
    // 尝试抽取首个 { ... } 块
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last > first) {
      try {
        return JSON.parse(text.slice(first, last + 1));
      } catch (e) {}
    }
    return null;
  }
}

/** 把 OpenAI 的 tool_calls 归一化, arguments 尽力解析成对象 */
function normalizeToolCalls(rawCalls) {
  if (!Array.isArray(rawCalls)) return [];
  return rawCalls
    .map((c, i) => {
      const fn = (c && c.function) || {};
      const argText = fn.arguments;
      let args = {};
      let parseFailed = false;
      if (typeof argText === 'string') {
        const t = argText.trim();
        if (t) {
          try { args = JSON.parse(t); } catch (e) { parseFailed = true; }
        }
      } else if (argText && typeof argText === 'object') {
        args = argText;
      }
      return {
        id: (c && c.id) || `call_${i}`,
        name: String(fn.name || '').trim(),
        args: args && typeof args === 'object' ? args : {},
        rawArguments: typeof argText === 'string' ? argText : JSON.stringify(argText || {}),
        parseFailed
      };
    })
    .filter((c) => c.name);
}

/** 判断一个报错是不是"这个网关/模型不吃 tools 参数" */
function looksLikeToolsUnsupported(err) {
  const m = String((err && err.message) || '').toLowerCase();
  const b = err && err.body ? JSON.stringify(err.body).toLowerCase() : '';
  const s = m + ' ' + b;
  return /tool/.test(s) && /(not support|unsupported|unknown|invalid|not allowed|unrecognized|不支持)/.test(s);
}

/**
 * 只把协议认的字段发出去, 其余一律剥掉。
 *
 * ## 为什么需要它
 *
 * 上层的消息数组**同时**承担两个角色: 发给模型、以及落盘给事后复盘。所以
 * assistant 消息上会挂一些只给复盘用的字段 —— 比如 elapsedMs / usage
 * (见 lib/agent-loop.js 的 _ack)。
 *
 * 这些字段原样发给网关就是隐患: 部分网关对不认识的字段直接 400, 而报错是
 * 英文的、指向 payload 而不是业务, 用户完全无从下手。修在这里而不是在上游
 * 逐个剔除, 是因为**这里是唯一的出口** —— 以后谁再往上挂字段都不会漏出去,
 * 不需要记得回来改这里。
 *
 * 白名单而不是黑名单: 黑名单每加一个字段都要有人记得同步, 白名单天然是
 * "没列出来的一律不发"。
 */
function wireMessages(list) {
  const out = [];
  for (const m of Array.isArray(list) ? list : []) {
    if (!m || typeof m !== 'object' || !m.role) continue;
    const one = { role: m.role };
    // 用 != null 而不是真值判断: content 是空串也要发 —— 工具调用那一轮的
    // content 本来就是空串, 丢掉会让这条消息看着不完整。
    if (m.content != null) one.content = m.content;
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) one.tool_calls = m.tool_calls;
    if (m.tool_call_id != null) one.tool_call_id = m.tool_call_id;
    if (m.name != null) one.name = m.name;
    out.push(one);
  }
  return out;
}

module.exports = LLMClient;
module.exports.normalizeToolCalls = normalizeToolCalls;
module.exports.usageOf = usageOf;
module.exports.addUsage = addUsage;
module.exports.wireMessages = wireMessages;
module.exports.DEFAULT_MAX_TOKENS = DEFAULT_MAX_TOKENS;
// 重试策略对外暴露, 好让测试直接验判定逻辑 (不必真的造网络故障)
module.exports.isTransient = isTransient;
module.exports.friendlyLLMError = friendlyLLMError;
module.exports.maxAttemptsFor = maxAttemptsFor;
module.exports.RETRY_MAX_ATTEMPTS = RETRY_MAX_ATTEMPTS;
