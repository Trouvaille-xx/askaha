'use strict';

/**
 * 「测试 Agent ⇄ 开发 Agent」的编排循环。
 *
 * 一轮 = 测试 Agent 跑一次卡, 不通就诊断出「修复建议」-> 交给开发 Agent 改卡
 *      -> 改完再交回测试 Agent。直到跑通, 或者达到轮数上限。
 *
 * 为什么做成两个 Agent 来回, 而不是让测试 Agent 自己改:
 *   测试 Agent 手里只有"跑出来的事实", 没有"用户当初要什么"。
 *   改卡需要后者 —— 需求、确认过的字段、分支意图都在搭建会话里。
 *   所以让测试的只诊断 (它反而能不带成见地查数据), 让搭建的去改。
 *
 * 每一轮都给界面推事件, 所以进度是实时可见的。
 *
 * 单独放在这里而不是留在 main.js 里, 是为了能测: main.js 一 require 就会拉进
 * electron, 于是这个循环的"取消到底生不生效""步数用尽会不会被当成改完了"
 * 这类问题只能靠肉眼看代码 —— 而那正是它出过 bug 的地方。现在它只依赖注入进来的
 * 东西, 测试里可以喂假 LLM 和空数据库, 全流程可断言。
 */

const Engine = require('./engine');
const LLMClient = require('./llm'); // 注意: 这个模块是直接导出类的
const { EngineAiBuilder } = require('./engine-ai');
const { EngineTester } = require('./engine-tester');

/**
 * @param card      要测的卡 (会深拷贝, 不改调用方的对象)
 * @param inputs    跑卡用的样例输入
 * @param pool      { dbId: [表名] } —— Agent 能看到的范围
 * @param emit      事件回调
 * @param maxRounds 最多来回几轮
 * @param cancelled 取消信号 { v: boolean } —— 每轮开头和每次调 Agent 之前都检查。
 *        以前这个信号只在 IPC 层的 emit 里被用来"静音界面", 循环本身从不检查,
 *        于是点了停止之后两个 Agent 照样把 4 轮跑完、照样烧配额。
 * @param llm       整个测试共用同一个 LLMClient。共用的意义有两个: 一是少建 5 个
 *        客户端; 二是取消时能直接 abort() 掉那个正在飞的请求 —— 光靠轮次之间的
 *        检查是停不掉"正卡在一次 60 秒请求上"的循环的。
 * @param llmConf   模型配置 (没传 llm 时用它新建)
 * @param databases 数据库配置列表
 * @param openDb    (conf) => Database
 * @param mcp       外部工具 (MCP) 管理器, 可选 —— 两个 Agent 都能用它
 */
async function runTestLoop({
  card,
  inputs,
  pool,
  emit,
  maxRounds = 4,
  cancelled,
  llm,
  llmConf,
  databases,
  openDb,
  mcp,
  prompt
}) {
  if (!llmConf || !llmConf.apiKey) {
    return { ok: false, error: '还没配模型，去「设置 · 模型」页填 API Key' };
  }
  const isCancelled = () => !!(cancelled && cancelled.v);
  // 被 abort() 打断的请求会以 ABORT_ERR 拒绝 —— 那不是故障, 是用户按了停止
  const isAbort = (e) => !!(e && (e.code === 'ABORT_ERR' || /已取消|已被取消/.test(e.message || '')));
  const client = llm || new LLMClient(llmConf);
  const dbs = databases || [];
  const rounds = [];
  let current = Engine.normalizeEngine(JSON.parse(JSON.stringify(card)));

  const cancelledResult = () => ({ ok: false, verdict: 'cancelled', error: '已取消', card: current, rounds });

  // 开发 Agent 只开一次会话, 后面每轮把修复建议喂进去 —— 它记得住上下文
  const builder = new EngineAiBuilder({
    llm: client,
    pool: pool || {},
    card: current,
    databases: dbs,
    openDb,
    mcp: mcp || null,
    prompt: prompt || null
  });

  for (let round = 1; round <= maxRounds; round++) {
    if (isCancelled()) return cancelledResult();
    const rec = { round, verdict: '', report: null, fixesApplied: false, exhausted: false };

    // ---- 测试 Agent: 跑 + 诊断 ----
    emit({ type: 'test_round', round, phase: 'test', message: `第 ${round} 轮：正在测试…` });
    const tester = new EngineTester({
      llm: client,
      pool: pool || {},
      card: current,
      databases: dbs,
      openDb,
      mcp: mcp || null,
      prompt: prompt || null
    });

    let tr;
    try {
      tr = await tester.run(inputs || {}, (ev) => emit(Object.assign({ round }, ev)));
    } catch (e) {
      if (isAbort(e) || isCancelled()) return cancelledResult();
      rec.verdict = 'error';
      rec.report = { verdict: 'fail', summary: '测试 Agent 出错: ' + ((e && e.message) || String(e)), fixes: [] };
      rounds.push(rec);
      emit({ type: 'test_round', round, phase: 'done', message: '测试出错' });
      break;
    }
    rec.verdict = tr.verdict;
    rec.report = tr.report;
    rec.exhausted = !!tr.exhausted;

    // 取消检查必须放在最前面。
    // abort() 会让测试 Agent 以"模型调用失败: ..."收场 (它把 ABORT_ERR 当普通错误
    // 吞掉了), 那份结果里 fixes 是空的 —— 先看 fixes 就会在取消的当口走进
    // "没给出可执行建议"那个分支, 把"用户按了停止"误报成"诊断没结果"。
    if (isCancelled()) return cancelledResult();

    // 测试 Agent 自己出错 (不是取消): 如实报出来, 别让它伪装成"没给出建议"
    if (tr.ok === false && !tr.verdict) {
      rec.verdict = 'error';
      rec.report = tr.report || { verdict: 'fail', summary: tr.error || '测试 Agent 出错', fixes: [] };
      rounds.push(rec);
      emit({
        type: 'test_round', round, phase: 'done',
        message: `第 ${round} 轮：测试 Agent 出错 —— ${tr.error || '未知原因'}`
      });
      break;
    }

    // 通了就收工
    if (tr.verdict === 'pass') {
      rounds.push(rec);
      emit({ type: 'test_round', round, phase: 'done', message: `第 ${round} 轮：跑通了` });
      return { ok: true, verdict: 'pass', card: current, rounds };
    }

    // ---- 开发 Agent: 按建议改卡 ----
    const report = tr.report || {};
    const fixes = report.fixes || [];
    if (!fixes.length) {
      rounds.push(rec);
      // 诊断自己没跑完 (步数用尽) 和"诊断说没得改"是两回事, 界面上不该混为一谈
      emit({
        type: 'test_round', round, phase: 'done',
        message: rec.exhausted
          ? `第 ${round} 轮：诊断 Agent 步数用尽, 没给出可执行的修复建议`
          : `第 ${round} 轮：没跑通，但测试 Agent 没给出可执行的修复建议`
      });
      break;
    }

    // 诊断跑完了再检查一次: 用户可能是在诊断过程中按的停止。
    if (isCancelled()) return cancelledResult();

    emit({ type: 'test_round', round, phase: 'fix', message: `第 ${round} 轮：开发 Agent 正在按 ${fixes.length} 条建议修…` });

    const fixPrompt = [
      `测试 Agent 拿真实单号跑了一遍这张卡，没跑通。它给的诊断和修复建议如下：`,
      ``,
      `**断在哪**：${report.brokenStep || '(未指明)'}`,
      `**根因**：${report.rootCause || '(未指明)'}`,
      report.evidence && report.evidence.length ? `**证据**：\n${report.evidence.map((e) => '- ' + e).join('\n')}` : '',
      ``,
      `**要改的地方**：`,
      ...fixes.map((f, i) => `${i + 1}. [${f.action}] ${f.nodeTitle || f.nodeId || '?'}：${f.detail}${f.reason ? '（原因：' + f.reason + '）' : ''}`),
      ``,
      `请**按这些建议增量修改**这张卡 —— 只改需要改的地方，不要推倒重来。`,
      `改完必须 validate_draft 体检 + run_test 用同样的输入真跑一遍，跑通了再 finish。`
    ].filter(Boolean).join('\n');

    let fr;
    try {
      fr = await builder.send(fixPrompt, (ev) => emit(Object.assign({ round }, ev)));
    } catch (e) {
      if (isAbort(e) || isCancelled()) return cancelledResult();
      emit({ type: 'test_round', round, phase: 'done', message: `第 ${round} 轮：开发 Agent 修复失败 —— ${(e && e.message) || e}` });
      rounds.push(rec);
      break;
    }

    if (fr && fr.card) current = Engine.normalizeEngine(fr.card);
    // 只有开发 Agent 真的自己收尾了才算"改完了"。步数用尽时它可能只改了一半 ——
    // 以前这里无条件写 true, 半成品被当成修复结果上报, 用户看到的是"改完了"。
    rec.fixesApplied = !(fr && fr.exhausted);
    rec.exhausted = rec.exhausted || !!(fr && fr.exhausted);

    // 用户中途被问了问题 (ask_user / ask_choice), 循环得停 —— 等用户回答再继续
    if (fr && fr.ask) {
      rounds.push(rec);
      emit({
        type: 'test_round', round, phase: 'ask',
        message: `第 ${round} 轮：开发 Agent 需要你确认一件事`,
        question: fr.ask,
        choice: fr.choice || null
      });
      return { ok: true, verdict: 'ask', card: current, rounds, ask: fr.ask, choice: fr.choice || null };
    }

    rounds.push(rec);

    // 改了一半就停下: 卡处在未知状态, 再喂给下一轮测试只会让诊断更混乱。
    // 如实报 'limit' 让用户决定, 而不是假装改完继续跑。
    if (!rec.fixesApplied) {
      emit({
        type: 'test_round', round, phase: 'done',
        message: `第 ${round} 轮：开发 Agent 步数用尽，这张卡可能只改了一半，先停在这里`
      });
      return {
        ok: false,
        verdict: 'limit',
        error: '开发 Agent 步数用尽, 这张卡可能只改了一半 —— 请检查后再试',
        card: current,
        rounds
      };
    }

    emit({ type: 'test_round', round, phase: 'done', message: `第 ${round} 轮：改完了，进入下一轮测试` });
  }

  const last = rounds[rounds.length - 1] || {};
  const hitLimit = rounds.some((r) => r.exhausted);
  return {
    ok: true,
    verdict: last.verdict === 'pass' ? 'pass' : (hitLimit ? 'limit' : 'exhausted'),
    card: current,
    rounds
  };
}

module.exports = { runTestLoop };
