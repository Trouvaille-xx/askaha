'use strict';

/**
 * 落盘 id 的白名单校验。
 *
 * 为什么必须有这一层: 会话 / 对话的 id 是渲染进程直接传进来的 (preload.js 的
 * conv:get / conv:delete / engine:aiChatGet ...), 而 store 拿它拼路径 ——
 * `path.join(convDir, id + '.json')`。id 里只要有 `..` 就能跳出目录:
 *
 *   conv:delete('../config')  →  删掉 userData/config.json
 *                                 (里面是所有数据库口令与 API Key)
 *
 * 所以 id 一律当作不可信输入: 只允许我们自己生成的那种字符集
 * (`c_1758..._ab12` / `a_...`), 其余全部拒绝。不做 "过滤危险字符" ——
 * 那种做法总有漏网的编码变体, 白名单才关得死。
 */

// 我们生成的 id: 前缀 + 时间戳(36 进制) + 随机段, 只含字母数字与下划线
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** id 是否合法 */
function isSafeId(id) {
  return typeof id === 'string' && SAFE_ID.test(id);
}

/**
 * 断言 id 合法, 不合法直接抛错。
 * 用抛错而不是返回 null: 调用点大多在 IPC handler 里, 抛出去会变成
 * reject, 比"悄悄用了个错误路径"安全得多。
 */
function assertSafeId(id, what = 'id') {
  if (!isSafeId(id)) {
    throw new Error(`非法的${what}: 只允许字母、数字、下划线与连字符`);
  }
  return id;
}

module.exports = { isSafeId, assertSafeId };
