'use strict';

/**
 * 规则文本 (搭建 / 测试 / 对话三套提示词的模块) 的登记与拼装。
 * 本体已搬到 **packages/solodb-core/prompt.js** —— 它是纯数据 + 纯函数,
 * 零依赖, 而且"规则住在哪里"决定了 Agent 会写出什么样的卡:
 * 换个宿主 (比如 DSH 插件里的 skill) 时, 规则必须跟着走, 不能各写一份。
 *
 * 转发而不是改所有 require: 改动只为划边界。
 */

module.exports = require('../packages/solodb-core/prompt.js');
