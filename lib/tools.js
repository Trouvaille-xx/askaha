'use strict';

/**
 * 工具注册表 —— "万物可接口" 的那个接口。
 *
 * ## 为什么要它
 *
 * 改之前, 三套工具是三个各自为政的数组:
 *   - lib/agent.js   里 _toolSchemas() 手拼内置动作 + MCP 工具
 *   - lib/engine-ai.js 里一个 18 项的 TOOLS 常量
 *   - lib/engine-tester.js 里一个 8 项的 TOOLS 常量
 * 分发也是三份 switch。结果是 MCP 只接进了分析 Agent, 另外两个永远看不到外部工具;
 * 想知道"这张卡能不能改数据"得去翻三个 switch。
 *
 * ## 它做什么
 *
 * 一份注册表同时装内置工具 (function call) 和外部工具 (MCP), 同一个命名空间。
 * 每个工具带**元数据**, 而不是只有 schema —— 元数据是给运行期和界面用的:
 *   readOnly  只读工具才能并发跑; 有副作用的必须串行, 免得互相踩
 *   cost      大概多重 (fast / slow)。预算紧张时优先砍 slow 的
 *   group     给界面分组 (data / flow / external)
 *
 * 运行期 (lib/agent-loop.js) 只认这张表, 不关心工具从哪来 ——
 * 所以"这个工具是内置的还是 MCP 插进来的"不再影响循环的写法。
 */

/** 工具执行失败时抛这个, 循环会把它当成"可回灌给模型的失败"而不是致命错误 */
class ToolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolError';
    this.isToolError = true;
  }
}

class ToolRegistry {
  constructor() {
    /** @type {Map<string, {name,description,parameters,handler,readOnly,cost,group,serial}>} */
    this._tools = new Map();
    this._mcp = null;
  }

  /**
   * 注册一个内置工具。
   *
   * @param name       模型看到的名字
   * @param description 给模型看的说明 —— 这是提示词的一部分, 写清"什么时候用它"
   * @param parameters  JSON Schema
   * @param handler     async (args, ctx) => string | object
   * @param opts        { readOnly=true, cost='fast', group='data', serial=false }
   */
  add(name, description, parameters, handler, opts = {}) {
    if (!name) throw new Error('工具必须有名字');
    if (typeof handler !== 'function') throw new Error(`工具 ${name} 没有处理函数`);
    this._tools.set(name, {
      name,
      description: String(description || ''),
      parameters: parameters || { type: 'object', properties: {} },
      handler,
      // 默认只读: 拿不准的时候保守, 让运行期串行执行 —— 慢一点好过踩数据
      readOnly: opts.readOnly !== false,
      cost: opts.cost === 'slow' ? 'slow' : 'fast',
      group: opts.group || 'data',
      serial: !!opts.serial
    });
    return this;
  }

  /**
   * 把一个 MCP 管理器挂进来。
   *
   * MCP 工具的 schema 是服务器自己报的, 直接透传 —— 我们不改它的描述,
   * 那是服务器作者写的、也是模型要读的。它们的名字已经带 mcp__<server>__ 前缀,
   * 所以和内置工具同处一个命名空间也不会撞。
   */
  attachMCP(mcp) {
    this._mcp = mcp || null;
    for (const raw of (mcp && mcp.tools) || []) {
      // MCPManager.tools 是 **OpenAI function 形状** ({type, function:{name,description,parameters}}),
      // 不是扁平的 {name,description,parameters}。
      //
      // 以前这里按扁平读, 于是 t.name 恒为 undefined, 每一个外部工具都在下面那行
      // continue 掉 —— 三个 Agent 一个都拿不到 MCP 工具, 而且一声不响。
      // (493 条测试没发现, 是因为 test/agent-runtime.test.js 喂的是扁平形状,
      //  跟真实形状不一致 —— 测试把 bug 锁成了契约。)
      //
      // 两种形状都认: 免得以后哪一边改了又静默失效。
      const t = raw && raw.function ? raw.function : raw;
      if (!t || !t.name) continue;
      this._tools.set(t.name, {
        name: t.name,
        description: String(t.description || '外部工具'),
        parameters: t.parameters || { type: 'object', properties: {} },
        handler: null,              // 交给 mcp 转发
        readOnly: false,            // 外部工具不知道它干什么, 一律当有副作用
        cost: 'slow',               // 跨进程调用, 比内置慢
        group: 'external',
        serial: true,
        external: true
      });
    }
    return this;
  }

  has(name) {
    return this._tools.has(name);
  }

  get(name) {
    return this._tools.get(name) || null;
  }

  names() {
    return Array.from(this._tools.keys());
  }

  /** 按名字取工具定义 (用于子集: 某个阶段只给一部分工具) */
  subset(names) {
    const r = new ToolRegistry();
    for (const n of names) {
      const t = this._tools.get(n);
      if (t) r._tools.set(n, t);
    }
    r._mcp = this._mcp;
    return r;
  }

  /** 给模型的工具清单 (OpenAI function-calling 形状) */
  schemas() {
    return Array.from(this._tools.values()).map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters }
    }));
  }

  /**
   * 统一分发。
   *
   * 失败一律以 { error } 返回, 不抛 —— 工具的失败是**给模型看的信息**,
   * 它据此换个方式再试; 抛出去就变成整轮中止, 那是把"模型走错一步"当成
   * "任务失败", 太脆。
   */
  async call(name, args, ctx) {
    const t = this._tools.get(name);
    if (!t) return { error: `没有叫 ${name} 的工具。请只使用提供给你的工具。` };
    try {
      if (t.external) {
        if (!this._mcp || typeof this._mcp.call !== 'function') {
          return { error: `外部工具 ${name} 现在不可用。` };
        }
        const text = await this._mcp.call(name, args || {});
        return String(text == null ? '' : text);
      }
      const out = await t.handler(args || {}, ctx || {});
      return out;
    } catch (e) {
      if (e && e.isToolError) return { error: e.message };
      return { error: `工具 ${name} 执行失败: ${(e && e.message) || e}` };
    }
  }

  /** 这一轮能不能并发跑这几个调用 */
  canParallel(names) {
    return names.every((n) => {
      const t = this._tools.get(n);
      return t && t.readOnly && !t.serial && !t.external;
    });
  }

  /** 人话描述一次调用, 给界面用 */
  describe(name, args) {
    const t = this._tools.get(name);
    const a = args || {};
    const bits = Object.entries(a)
      .filter(([, v]) => v !== undefined && v !== null && String(v) !== '')
      .slice(0, 3)
      .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`)
      .join(' ');
    const label = t ? t.group : 'tool';
    return `[${label}] ${name}${bits ? ' ' + bits : ''}`;
  }
}

module.exports = { ToolRegistry, ToolError };
