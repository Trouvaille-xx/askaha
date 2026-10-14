'use strict';

/**
 * solodb-core —— 这个产品的确定性内核。零依赖, 宿主无关。
 *
 * 里面装的是:
 *   Engine    流程卡的 schema / 校验 / 模板渲染 / 执行 (照写死的 SQL 跑, 运行期不调模型)
 *   Peek      "看一眼这列存的是什么"的统计与抽样护栏 (大表不做全表 COUNT)
 *   SqlGuard  只读 SQL 策略 + createReadOnlyDb (把宿主的连接包成只能读)
 *   Prompt    搭建 / 测试 / 对话三套提示词的模块与拼装 (规则文本)
 *
 * 刻意**不装**的:
 *   驱动与连接池 (mysql2 / pg / mssql / sql.js)、Electron / IPC / 任何界面、
 *   模型调用与 Agent 循环。宿主通过 openDb / createReadOnlyDb 把数据库能力注入
 *   进来 —— 于是这份内核在 Electron 应用和别的宿主 (比如 DSH 插件) 里是
 *   同一个对象, 不存在"两份引擎各自演化"的问题。
 *
 * 边界怎么用, 见同目录 README.md。
 */

const Engine = require('./engine.js');
const Peek = require('./data-peek.js');
const SqlGuard = require('./sql-guard.js');
const Prompt = require('./prompt.js');

module.exports = {
  Engine,
  Peek,
  SqlGuard,
  Prompt,
  // 最常用的两个直接提到顶层, 免得宿主每次写 SqlGuard.xxx
  createReadOnlyDb: SqlGuard.createReadOnlyDb,
  assertReadOnlySingleStatement: SqlGuard.assertReadOnlySingleStatement
};
