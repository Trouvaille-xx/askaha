'use strict';

/**
 * 三套提示词的模块正文 (BUILDER_MODULES / TESTER_MODULES / CHAT_MODULES 等)。
 * 本体已搬到 **packages/solodb-core/prompt-sets.js**。
 *
 * 为什么要跟着核心包走: 这份文本就是"写卡 Agent 的规则"。规则和引擎分家之后,
 * 换宿主时最容易出现的事就是规则留在老地方、新宿主里另写一份 —— 于是同一个
 * 引擎在两处被教成两种写法。转发文件把这条路堵住。
 */

module.exports = require('../packages/solodb-core/prompt-sets.js');
