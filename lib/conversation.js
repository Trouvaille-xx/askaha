'use strict';

/**
 * 一段对话能有多长。
 *
 * ## 为什么要有这个
 *
 * 之前"跑不完"的体验来自**每轮步数**上限: 16 步跑满就强制生成总结, 任务半途
 * 被砍断。那个上限现在改成"跑满就自动压缩 + 接着开下一轮"了 —— 也就是说,
 * 一次提问里智能体可以做很久。
 *
 * 于是长度这件事换了个地方管: 不再是"一次提问能走几步", 而是"**一段对话能积累
 * 多少轮**"。这两个不是一回事, 后者才是真正影响输出质量的那个 —— 对话越长,
 * 早先的上下文被折叠得越狠, 模型对"你到底要什么"的记忆就越薄。
 *
 * 所以到 100 轮就硬停 (再往下质量只会更差, 不如让用户开一段新的),
 * 到 80 轮先提醒一次。
 *
 * ## 为什么数字在这里而不是散在两边
 *
 * 界面要拿它决定"能不能发、要不要显示提示条", 后端也要拿它兜底 (界面被绕过
 * 时不能让它无限长下去)。两边各写一份数字迟早会对不上, 而那种错很难发现 ——
 * 界面上显示还能发, 发出去却被后端拒了。所以放这里一份, 由 main.js 通过
 * config:get 交给界面 (见 lib/public-config.js)。
 */

/** 到这儿就不再接受新消息了 */
const CONV_MAX_TURNS = 100;
/** 超过这个数就开始提醒用户开新会话 */
const CONV_WARN_TURNS = 80;

/**
 * 数一段对话有多少轮。
 *
 * 按**用户说了几句**算, 不按消息条数 —— 助手的一条回复可能拆成好几条消息
 * (过程、工具结果、结论), 那些不该算成好几轮。
 */
function turnCount(messages) {
  if (!Array.isArray(messages)) return 0;
  let n = 0;
  for (const m of messages) {
    if (m && m.role === 'user') n += 1;
  }
  return n;
}

/**
 * 这段对话现在什么状态。界面直接拿它决定显示什么。
 *
 * @returns {{ turns, max, warnAt, warn, blocked, message }}
 *   warn    已经超过提醒线, 该提示"建议新开会话"
 *   blocked 到硬上限了, 不该再接受新消息
 *   message 给用户看的那句话 (不需要提示时是空串)
 */
function convStatus(messages) {
  const turns = turnCount(messages);
  const blocked = turns >= CONV_MAX_TURNS;
  const warn = !blocked && turns > CONV_WARN_TURNS;
  let message = '';
  if (blocked) {
    message = `这段对话已经有 ${turns} 轮了, 到了上限 (${CONV_MAX_TURNS} 轮)。请新建会话继续 —— 不是不能再答, 是这么长的上下文里我记不清你最初要什么了。`;
  } else if (warn) {
    message = `当前对话已超过${CONV_WARN_TURNS}轮，为了保证输出质量，建议新开会话。`;
  }
  return { turns, max: CONV_MAX_TURNS, warnAt: CONV_WARN_TURNS, warn, blocked, message };
}

module.exports = { CONV_MAX_TURNS, CONV_WARN_TURNS, turnCount, convStatus };
