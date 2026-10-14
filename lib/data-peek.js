'use strict';

/**
 * 这里曾经是"看一眼这列存的是什么"的护栏本体。
 * 它已经搬到 **packages/solodb-core/data-peek.js** —— 那件事与宿主无关,
 * 三个 Agent (搭建 / 分析 / 测试) 和将来的别的宿主都该用同一份。
 *
 * 转发而不是改所有 require: 改动只为划边界, 不为制造全仓路径改名。
 */

module.exports = require('../packages/solodb-core/data-peek.js');
