/**
 * 原子写文本文件。
 *
 * 为什么需要: fs.writeFileSync 是「先把目标文件截断, 再往里写」。进程被杀、
 * 断电、磁盘写满、同步盘冲突 —— 任何一个发生在中间, 盘上留下的就是半截 JSON。
 * 而本项目的落盘全是**全量重写** (config.json 甚至每 900ms 就被流程卡自动保存
 * 重写一次), 所以这个窗口并不小。
 *
 * 那个半截文件不只是「这一次没存上」: 下次启动读不出来, 就触发了
 * main.js 里「读失败当成没配过」那条链, 用户的库/口令/Key/流程卡会被出厂默认
 * 整份盖掉。所以这里不是洁癖, 是那条数据丢失链的第一环。
 *
 * rename 在同一个文件系统内是原子的: 目标文件要么是旧内容, 要么是新内容,
 * 不存在「写到一半」的中间态。
 */

const fs = require('fs');
const path = require('path');

/**
 * 原子地把 text 写到 file。
 *
 * 临时文件刻意放在**目标同目录**(而不是 os.tmpdir): rename 跨文件系统会退化成
 * 「复制 + 删除」, 就不再原子了, 而这个项目里 userData 完全可能和系统临时目录
 * 不在同一个盘上。
 *
 * 失败时抛错 —— 调用方必须把失败透传出去。静默失败等于静默丢数据。
 *
 * @param {string} file 目标文件绝对路径
 * @param {string|Buffer} text 要写入的内容
 */
function writeFileAtomic(file, text) {
  const dir = path.dirname(file);
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  try {
    fs.writeFileSync(tmp, text, 'utf-8');
    // Windows 上 renameSync 走 MoveFileEx + MOVEFILE_REPLACE_EXISTING, 会覆盖已存在的目标
    fs.renameSync(tmp, file);
  } catch (e) {
    // 别把临时文件留在盘上 —— 否则 userData 里会慢慢堆一堆 .tmp-* 垃圾
    try {
      fs.unlinkSync(tmp);
    } catch (e2) {
      /* 本来就没建起来, 或者已经被 rename 走了 */
    }
    throw e;
  }
}

module.exports = { writeFileAtomic };
