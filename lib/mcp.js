/**
 * MCP (Model Context Protocol) 客户端
 *
 * 为什么需要它:
 *   我们的动作空间是写死的 7 个内置动作。但"垂类 harness"不该被自己写死 ——
 *   用户想接自己的工具 (查工单、读 Confluence、跑内部脚本), 应该能插进来,
 *   而不是等我们改代码。MCP 就是那个插座。
 *
 * 传输方式:
 *   这里只实现 stdio 这一种 —— 主进程 spawn 一个子进程, 用换行分隔的
 *   JSON-RPC 2.0 跟它对话。这是 MCP 最常见的形态 (npx 一个 server 就能用),
 *   也最贴合桌面端: 不需要用户额外起服务、配端口。
 *
 * 三个概念:
 *   1) server  —— 一个外部工具进程, 配置里一条记录
 *   2) tool    —— server 暴露出来的一个能力, 形状对齐 OpenAI function
 *   3) 命名空间 —— 插进来的工具统一叫 mcp__<server>__<tool>,
 *                  这样模型看到的是一张平铺的工具表, 我们靠名字前缀路由回去。
 *                  (也顺带避免了跟内置动作重名)
 *
 * 对上层只暴露两样东西:
 *   .tools            -> OpenAI tools 定义数组, 直接并进内置工具表
 *   .call(name,args)  -> 执行一次调用, 返回可回灌给模型的文本
 */

const { spawn } = require('child_process');

const PROTOCOL_VERSION = '2024-11-05';
const REQUEST_TIMEOUT = 30000;
const MAX_TEXT = 8000;

/** OpenAI 的 function name 有字符限制, 这里统一清洗成安全字符 */
function sanitize(part) {
  return String(part || '')
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 40);
}

/**
 * 单个 MCP server 的连接。
 * 负责: 拉起子进程 -> initialize 握手 -> 拿工具清单 -> 转发调用。
 */
class MCPConnection {
  constructor(def) {
    this.def = def || {};
    this.id = sanitize(this.def.id || this.def.name || 'server');
    this.name = String(this.def.name || this.id);
    this.child = null;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.tools = [];
    this.error = '';
    this.stderrTail = '';
  }

  /** 启动并完成握手。失败时把原因留在 this.error, 不让整个应用起不来 */
  async connect() {
    const command = this.def.command;
    if (!command) throw new Error('MCP server 缺少 command');
    const args = Array.isArray(this.def.args) ? this.def.args : [];
    const env = { ...process.env, ...(this.def.env || {}) };

    this.child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    this.child.stdout.setEncoding('utf-8');
    this.child.stdout.on('data', (chunk) => this._onData(chunk));

    this.child.stderr.setEncoding('utf-8');
    this.child.stderr.on('data', (chunk) => {
      // 子进程的日志只留尾部, 出错时能给用户看个线索
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });

    this.child.on('error', (e) => {
      this.error = e.message;
      this._rejectAll(new Error('MCP server 启动失败: ' + e.message));
    });
    this.child.on('exit', (code) => {
      if (code !== 0 && !this.error) this.error = `MCP server 退出, code=${code}`;
      this._rejectAll(new Error(`MCP server 已退出 (code=${code})`));
    });

    await this._request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'solodb', version: '0.1.0' }
    });
    // 规范要求握手后补一条 initialized 通知 (通知没有 id, 不等回复)
    this._notify('notifications/initialized', {});

    const listed = await this._request('tools/list', {});
    const raw = (listed && Array.isArray(listed.tools)) ? listed.tools : [];
    this.tools = raw
      .filter((t) => t && t.name)
      .map((t) => {
        const exposed = `mcp__${this.id}__${sanitize(t.name)}`;
        return {
          exposed,
          toolName: t.name,
          serverId: this.id,
          serverName: this.name,
          description: String(t.description || ''),
          inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} }
        };
      });
    return this.tools;
  }

  /** 把工具定义转成 OpenAI tools 的形状 */
  toOpenAITools() {
    return this.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.exposed,
        description: `[来自 ${t.serverName}] ${t.description || t.toolName}`.slice(0, 900),
        parameters: t.inputSchema
      }
    }));
  }

  /** 执行一次工具调用, 返回给模型看的文本 */
  async call(exposedName, args) {
    const found = this.tools.find((t) => t.exposed === exposedName);
    if (!found) throw new Error(`没有叫 ${exposedName} 的工具`);
    const res = await this._request('tools/call', { name: found.toolName, arguments: args || {} });
    return renderContent(res);
  }

  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    // stdio 传输是"一行一条 JSON-RPC"
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        continue; // 有的 server 会往 stdout 混日志, 跳过而不是崩掉
      }
      if (msg && msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
      // 通知 (没有 id) 这里不处理
    }
  }

  _notify(method, params) {
    if (!this.child) return;
    try {
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    } catch (e) { /* 子进程已经没了 */ }
  }

  _request(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.child) return reject(new Error('MCP server 未启动'));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 请求超时 (${method})`));
      }, REQUEST_TIMEOUT);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
      try {
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  _rejectAll(err) {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  close() {
    if (!this.child) return;
    try { this.child.kill(); } catch (e) { /* ignore */ }
    this.child = null;
  }
}

/** MCP 返回的 content 可能是 text / image / resource 混排, 这里只取文本部分 */
function renderContent(res) {
  if (!res) return '(外部工具没有返回内容)';
  if (Array.isArray(res.content)) {
    const parts = res.content.map((c) => {
      if (!c) return '';
      if (c.type === 'text') return String(c.text || '');
      if (c.type === 'image') return '[图片输出]';
      if (c.type === 'resource') return `[资源 ${(c.resource && c.resource.uri) || ''}]`;
      return JSON.stringify(c);
    }).filter(Boolean);
    const text = parts.join('\n') || '(外部工具没有返回文本内容)';
    return truncate(text);
  }
  if (typeof res === 'string') return truncate(res);
  return truncate(JSON.stringify(res));
}

function truncate(s) {
  const t = String(s == null ? '' : s);
  return t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) + '\n...(已截断)' : t;
}

/**
 * 多个 server 的管理器。对外就是 Agent 眼里那个 mcp 对象。
 *
 * 设计取向: 单个 server 起不来不该拖垮整轮对话 —— 记下错误, 继续跑,
 * 界面上给个提示就行。工具是加分项, 不是必需项。
 */
class MCPManager {
  constructor(servers) {
    this.defs = Array.isArray(servers) ? servers.filter((s) => s && s.command) : [];
    this.connections = [];
    this.errors = [];
    // tools 是给模型看的 (OpenAI function 形状, 只有 function.name/description/parameters);
    // toolMeta 是给我们自己看的 (带 exposed / toolName / serverName), 界面和诊断用这个。
    this.tools = [];
    this.toolMeta = [];
    this.ready = false;
  }

  /** 起所有启用的 server (disabled 的跳过) */
  async connectAll() {
    for (const def of this.defs) {
      if (def.enabled === false) continue;
      const conn = new MCPConnection(def);
      try {
        await conn.connect();
        this.connections.push(conn);
        this.tools.push(...conn.toOpenAITools());
        this.toolMeta.push(...conn.tools.map((t) => ({
          exposed: t.exposed,
          toolName: t.toolName,
          serverId: t.serverId,
          serverName: t.serverName,
          description: t.description
        })));
      } catch (e) {
        conn.close();
        this.errors.push({ server: conn.name, error: e.message || String(e), stderr: (conn.stderrTail || '').slice(-400) });
      }
    }
    this.ready = true;
    return { tools: this.tools, toolMeta: this.toolMeta, errors: this.errors };
  }

  /** 名字 -> 连接, 供转发时路由 */
  _route(exposedName) {
    return this.connections.find((c) => c.tools.some((t) => t.exposed === exposedName));
  }

  async call(exposedName, args) {
    const conn = this._route(exposedName);
    if (!conn) throw new Error(`没有可处理 ${exposedName} 的 MCP server`);
    return conn.call(exposedName, args);
  }

  /**
   * 关掉所有子进程, 并把派生状态一起复位。
   *
   * tools / toolMeta / ready 都是从 connections 派生出来的, 必须同进同出。
   * 以前只清 connections, 于是 tools 数组留着上一次的清单 —— 模型在**下一个任务**
   * 里照样看得到 mcp__* 工具 (schema 来自这份残留), 一调用就报
   * "没有可处理 ... 的 MCP server"。对用户来说就是"外部工具时好时坏", 没法排查。
   */
  closeAll() {
    for (const c of this.connections) c.close();
    this.connections = [];
    this.tools = [];
    this.toolMeta = [];
    this.ready = false;
  }
}

module.exports = { MCPManager, MCPConnection, renderContent, sanitize };
