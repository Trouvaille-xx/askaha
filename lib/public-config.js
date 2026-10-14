'use strict';

const { CONV_MAX_TURNS, CONV_WARN_TURNS } = require('./conversation.js');
const { publicLLM } = require('./models.js');

/**
 * 把主进程持有的配置转成"可以交给渲染进程"的副本。
 *
 * 为什么必须有一层转换: 渲染层根本不需要明文密钥 —— 它只负责显示"配没配"、
 * 以及把用户新填的值送上来。而报告是用 iframe srcdoc 渲染模型产出的 HTML 的,
 * 一旦那层沙箱松了、或者 report.js 的转义漏了一个槽位, 明文密钥就等于直接
 * 递给了一段不可信脚本。所以密钥只留在主进程内存与 config.json 里。
 *
 * 用 apiKeySet / passwordSet 两个布尔代替明文, 让界面仍然能显示"已保存"。
 *
 * 注意: 这个函数只做"往外发"的方向。渲染层回传时**不带** apiKey 字段,
 * 展开合并天然保留原有密钥, 不会因为"表单里没显示"就被抹掉。
 */
function publicConfig(config) {
  const src = (config && typeof config === 'object') ? config : {};
  return {
    ...src,
    // 模型清单。密钥在这一层被剥掉, 只留 apiKeySet 让界面能显示"已保存"。
    // 顶层的 model / baseURL / apiKeySet 是当前选中那一个的摘要 —— 别把
    // ...src.llm 展开进来, 那会把明文 apiKey 一起带出去。
    llm: publicLLM(src.llm),
    databases: (Array.isArray(src.databases) ? src.databases : []).map((d) => ({
      ...d,
      password: '',
      passwordSet: !!d.password
    })),
    // 对话长度上限。界面要拿它决定"还能不能发、要不要显示提示条"。
    //
    // 数字**不在界面里再写一份**: 界面和后端各写一份迟早会对不上, 而那种错
    // 很难发现 —— 界面上显示还能发, 发出去却被后端拒了。这里由主进程统一发下去,
    // 两边读的是同一个常量 (lib/conversation.js)。
    limits: {
      convMaxTurns: CONV_MAX_TURNS,
      convWarnTurns: CONV_WARN_TURNS
    }
  };
}

module.exports = { publicConfig };
