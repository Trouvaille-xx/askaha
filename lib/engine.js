'use strict';

/**
 * 这里曾经是流程引擎的本体。它已经搬到 **packages/solodb-core/engine.js**。
 *
 * 为什么留这一个转发文件, 而不是让所有人改 require 路径:
 * 搬运的目的只是把"确定性内核"划出边界 (见那个包的 README), 不是为了制造
 * 一次全仓库的路径改名。转发之后 require('./engine.js') 拿到的**就是**
 * 核心包里的那个对象 (同一个引用), 现有代码和测试一个字都不用改。
 *
 * 新代码请优先直接引核心包: require('../packages/solodb-core/engine.js')
 */

module.exports = require('../packages/solodb-core/engine.js');
