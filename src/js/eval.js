'use strict';
/* 评测页: 单条测试 / 批量测试 两个页签 + 右上角「用例管理」弹窗 + 新建/编辑用例弹窗 + 从 Run 加入弹窗。 */
(function () {
  const api = window.bridge;
  let bound = false;
  let cases = [];
  let batches = [];
  let scorerVersion = '';
  let editingCaseId = null;
  let pollTimer = null;
  let openBatchId = null;
  let openRunId = null;

  // 从 Run 选择弹窗
  let runPick = [];
  let runPickSelected = new Set();
  let runPickLimit = 25;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toastMsg = (m, l) => { if (typeof toast === 'function') toast(m, l); else console.log(m); };
  const fmtTime = (iso) => { try { return new Date(iso).toLocaleString('zh-CN', { hour12: false }); } catch (e) { return iso || ''; } };
  const traceHtml = (steps) => (typeof traceStepsHtml === 'function' ? traceStepsHtml(steps || []) : '');

  /* ---------- 外层 Eval 平台页签 (运行记录/评测/规划器/工具) ---------- */
  function initEvalPlatform() {
    if (!bound) {
      bound = true;
      bindEvalUI();
      document.querySelectorAll('#evalPlatformTabs .subnav-tab').forEach((t) => {
        t.addEventListener('click', () => activatePane(t.dataset.pane));
      });
    }
    activatePane(currentPane());
  }
  function currentPane() {
    const el = document.querySelector('#evalPlatformTabs .subnav-tab.active');
    return el ? el.dataset.pane : 'runs';
  }
  function activatePane(pane) {
    document.querySelectorAll('#evalPlatformTabs .subnav-tab').forEach((t) => t.classList.toggle('active', t.dataset.pane === pane));
    document.querySelectorAll('.eval-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === pane));
    setEvalFill(false);
    if (pane === 'runs' && typeof window.initRuns === 'function') window.initRuns();
    else if (pane === 'eval') loadEval();
    else if (pane === 'planner' && typeof window.initPlanner === 'function') window.initPlanner();
    else if (pane === 'tools' && typeof window.initToolsPane === 'function') window.initToolsPane();
  }

  /* ---------- 绑定 ---------- */
  function bindEvalUI() {
    document.querySelectorAll('#evalModeTabs .subnav-tab').forEach((t) => {
      t.addEventListener('click', () => switchMode(t.dataset.mode));
    });
    $('btnEvalCases').addEventListener('click', openCasesPage);
    $('btnEvalCasesBack').addEventListener('click', () => activatePane('eval'));
    $('btnEvalRunOne').addEventListener('click', runSingle);
    $('btnEvalNewBatch').addEventListener('click', openNewBatch);
    $('btnEvalBatchRefresh').addEventListener('click', () => loadEval());
    $('btnEvalBatchCreate').addEventListener('click', createBatch);
    $('btnBatchRunsBack').addEventListener('click', () => { activatePane('eval'); switchMode('batch'); });
    $('btnBatchRunsRefresh').addEventListener('click', () => { if (openBatchId) openBatchRuns(openBatchId, openRunId); });
    $('btnEvalCompare').addEventListener('click', compare);

    // 用例管理弹窗
    $('btnEvalNewCase').addEventListener('click', () => openCaseModal(null));
    $('btnEvalFromRun').addEventListener('click', openFromRun);
    $('evalCaseSearch').addEventListener('input', renderCaseTable);
    $('evalFilterStatus').addEventListener('change', renderCaseTable);
    $('evalFilterDim').addEventListener('change', renderCaseTable);

    // 新建/编辑弹窗
    $('btnEvalCaseSave').addEventListener('click', saveCase);

    // 从 Run 弹窗
    $('evalRunSearch').addEventListener('input', renderRunPick);
    $('btnEvalRunMore').addEventListener('click', () => { runPickLimit += 25; loadRunPick(); });
    $('btnEvalFromRunCreate').addEventListener('click', createFromSelected);

    // 关闭
    for (const id of ['modalEvalBatch', 'modalEvalCase', 'modalEvalFromRun']) {
      document.querySelectorAll(`#${id} [data-close]`).forEach((el) => el.addEventListener('click', () => { $(id).hidden = true; }));
    }
  }

  function switchMode(mode) {
    document.querySelectorAll('#evalModeTabs .subnav-tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
    document.querySelectorAll('.eval-mode').forEach((m) => m.classList.toggle('active', m.dataset.mode === mode));
  }

  /* ---------- 载入 ---------- */
  async function loadEval() {
    const res = await api.eval.list();
    if (!res || !res.ok) { toastMsg('评测加载失败: ' + ((res && res.error) || ''), 'err'); return; }
    cases = res.cases || [];
    batches = res.batches || [];
    scorerVersion = res.scorerVersion || '';
    if ($('evalScorerVer')) $('evalScorerVer').textContent = '评分器 ' + scorerVersion + ' · 规则评测';
    renderSingleOptions();
    renderBatches();
    if (casesPageActive()) renderCaseTable();
    if (window.syncEvalSelects) window.syncEvalSelects();
  }

  function renderSingleOptions() {
    const sel = $('evalSingleCase');
    const prev = sel.value;
    const enabled = cases.filter((c) => c.enabled !== false);
    sel.innerHTML = enabled.length
      ? enabled.map((c) => `<option value="${esc(c.id)}">${esc(c.name || c.question)}</option>`).join('')
      : '<option value="">(没有启用的用例)</option>';
    if (prev && enabled.some((c) => c.id === prev)) sel.value = prev;
  }

  /* ---------- 用例管理弹窗 ---------- */
  function openCasesPage() {
    document.querySelectorAll('#evalPlatformTabs .subnav-tab').forEach((t) => t.classList.toggle('active', t.dataset.pane === 'eval'));
    document.querySelectorAll('.eval-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === 'cases'));
    setEvalFill(false);
    const dims = [...new Set(cases.map((c) => c.evalDimension).filter(Boolean))];
    const cur = $('evalFilterDim').value;
    $('evalFilterDim').innerHTML = '<option value="">全部维度</option>' + dims.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
    if (cur && dims.includes(cur)) $('evalFilterDim').value = cur;
    $('evalCasesTitle').textContent = `评测用例 (${cases.length})`;
    renderCaseTable();
  }
  function casesPageActive() {
    const p = document.querySelector('.eval-pane[data-pane="cases"]');
    return !!(p && p.classList.contains('active'));
  }
  function evalPageEl() { return document.querySelector('[data-view="evalplatform"] .page'); }
  function setEvalFill(on) { const p = evalPageEl(); if (p) p.classList.toggle('eval-page-fill', !!on); }

  function filteredCases() {
    const q = ($('evalCaseSearch').value || '').trim().toLowerCase();
    const st = $('evalFilterStatus').value;
    const dim = $('evalFilterDim').value;
    return cases.filter((c) => {
      if (st === 'on' && c.enabled === false) return false;
      if (st === 'off' && c.enabled !== false) return false;
      if (dim && c.evalDimension !== dim) return false;
      if (q) {
        const hay = `${c.name || ''} ${c.question || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function renderCaseTable() {
    const box = $('evalCaseTable');
    const rows = filteredCases();
    if (!rows.length) { box.innerHTML = '<div class="empty-block">没有匹配的用例</div>'; return; }
    const head = '<thead><tr><th>用例</th><th>场景</th><th>难度 / 风险</th><th>维度</th><th>状态</th><th class="ta-r">操作</th></tr></thead>';
    const body = rows.map((c) => {
      const on = c.enabled !== false;
      return `<tr>
        <td class="eval-cell-main">
          <div class="eval-row-title">${esc(c.name || c.question || '(未命名)')}</div>
          <div class="eval-row-sub">${esc((c.question || '').slice(0, 60))}</div>
          <div class="eval-row-meta">${esc(c.id)} · ${esc(fmtTime(c.createdAt))}</div>
        </td>
        <td>${esc(c.category || '-')}</td>
        <td>${esc(c.difficulty || '-')} · ${esc(c.riskLevel || 'none')}</td>
        <td>${esc(c.evalDimension || '-')}</td>
        <td><span class="pill ${on ? 'pill-ok' : 'pill-cancelled'}">${on ? '启用' : '停用'}</span></td>
        <td class="ta-r">
          <button class="btn btn-xs" data-act="edit" data-id="${esc(c.id)}">编辑</button>
          <button class="btn btn-xs" data-act="dup" data-id="${esc(c.id)}">复制</button>
          <button class="btn btn-xs" data-act="toggle" data-id="${esc(c.id)}">${on ? '停用' : '启用'}</button>
          <button class="btn btn-xs btn-danger" data-act="del" data-id="${esc(c.id)}">删除</button>
        </td>
      </tr>`;
    }).join('');
    box.innerHTML = `<table class="eval-case-table">${head}<tbody>${body}</tbody></table>`;
    box.querySelectorAll('button[data-act]').forEach((btn) => {
      btn.onclick = () => caseRowAction(btn.dataset.act, btn.dataset.id);
    });
  }

  async function caseRowAction(act, id) {
    const c = cases.find((x) => x.id === id);
    if (!c) return;
    if (act === 'edit') return openCaseModal(c);
    if (act === 'dup') {
      const copy = Object.assign({}, c); delete copy.id; copy.name = (c.name || '') + ' (副本)';
      const res = await api.eval.caseCreate(copy);
      if (res.ok) { toastMsg('已复制'); await loadEval(); } else toastMsg('复制失败: ' + res.error, 'err');
      return;
    }
    if (act === 'toggle') {
      const res = await api.eval.caseUpdate(Object.assign({}, c, { enabled: c.enabled === false }));
      if (res.ok) await loadEval(); else toastMsg('保存失败: ' + res.error, 'err');
      return;
    }
    if (act === 'del') {
      if (!confirm('确定删除该用例？')) return;
      const res = await api.eval.caseDelete(id);
      if (res.ok) { toastMsg('已删除'); await loadEval(); } else toastMsg('删除失败: ' + res.error, 'err');
    }
  }

  /* ---------- 新建 / 编辑用例弹窗 ---------- */
  function openCaseModal(c, prefill) {
    editingCaseId = c ? c.id : null;
    const d = c || prefill || {};
    $('evalCaseTitle').textContent = c ? '编辑用例' : '新增用例';
    $('ecName').value = d.name || '';
    $('ecQuestion').value = d.question || '';
    $('ecScenario').value = d.category || d.scenario || '';
    $('ecDimension').value = d.evalDimension || 'correctness';
    $('ecDifficulty').value = d.difficulty || 'medium';
    $('ecRisk').value = d.riskLevel || 'none';
    $('ecBehavior').value = d.expectedBehavior || '';
    $('ecKeywords').value = (d.expectedKeywords || []).join('\n');
    $('ecForbidden').value = (d.forbiddenWords || []).join('\n');
    $('ecPrice').value = d.expectedPrice == null ? '' : d.expectedPrice;
    $('ecReqCaps').value = (d.requiredCapabilities || []).join('\n');
    $('ecTags').value = (d.tags || []).join(', ');
    $('ecRiskPass').checked = d.expectRiskPassed !== false;
    $('ecEnabled').checked = d.enabled !== false;
    $('ecStatus').textContent = '';
    $('ecStatus').className = 'form-status';
    $('modalEvalCase').hidden = false;
    if (window.syncEvalSelects) window.syncEvalSelects();
    setTimeout(() => $('ecName').focus(), 30);
  }

  function readCaseForm() {
    const lines = (id) => $(id).value.split('\n').map((x) => x.trim()).filter(Boolean);
    return {
      name: $('ecName').value.trim(),
      question: $('ecQuestion').value.trim(),
      category: $('ecScenario').value.trim(),
      evalDimension: $('ecDimension').value,
      difficulty: $('ecDifficulty').value,
      riskLevel: $('ecRisk').value,
      expectedBehavior: $('ecBehavior').value.trim(),
      expectedKeywords: lines('ecKeywords'),
      forbiddenWords: lines('ecForbidden'),
      expectedPrice: $('ecPrice').value.trim() === '' ? null : Number($('ecPrice').value),
      requiredCapabilities: lines('ecReqCaps'),
      tags: $('ecTags').value.split(',').map((x) => x.trim()).filter(Boolean),
      expectRiskPassed: $('ecRiskPass').checked,
      enabled: $('ecEnabled').checked
    };
  }

  async function saveCase() {
    const payload = readCaseForm();
    if (editingCaseId) payload.id = editingCaseId;
    const res = editingCaseId ? await api.eval.caseUpdate(payload) : await api.eval.caseCreate(payload);
    if (!res || !res.ok) { $('ecStatus').textContent = '保存失败: ' + ((res && res.error) || ''); $('ecStatus').className = 'form-status err'; return; }
    $('modalEvalCase').hidden = true;
    toastMsg('已保存');
    await loadEval();
  }

  /* ---------- 从 Run 加入弹窗 ---------- */
  async function openFromRun() {
    runPickSelected.clear();
    runPickLimit = 25;
    $('evalRunSearch').value = '';
    $('modalEvalFromRun').hidden = false;
    await loadRunPick();
  }

  async function loadRunPick() {
    const box = $('evalRunPickList');
    box.innerHTML = '<div class="empty-block">加载中…</div>';
    const res = await api.run.list({ limit: runPickLimit });
    runPick = (res && res.ok ? res.runs : []) || [];
    renderRunPick();
  }

  function renderRunPick() {
    const box = $('evalRunPickList');
    const q = ($('evalRunSearch').value || '').trim().toLowerCase();
    const rows = runPick.filter((r) => !q || (r.question || '').toLowerCase().includes(q));
    $('evalRunPickCount').textContent = `已选 ${runPickSelected.size}`;
    if (!rows.length) { box.innerHTML = '<div class="empty-block">没有运行记录</div>'; return; }
    box.innerHTML = '';
    for (const r of rows) {
      const item = document.createElement('label');
      item.className = 'eval-run-pick-item';
      const st = r.status || 'ok';
      const stCls = st === 'ok' ? 'pill-ok' : (st === 'error' ? 'pill-error' : 'pill-cancelled');
      const stCn = { ok: '成功', error: '失败', cancelled: '已取消', handoff: '已接管' }[st] || st;
      item.innerHTML = `<input type="checkbox" ${runPickSelected.has(r.id) ? 'checked' : ''}/>
        <span class="pill ${stCls}">${esc(stCn)}</span>
        <span class="eval-run-q">${esc((r.question || '').slice(0, 80) || '(无问题)')}</span>
        <span class="eval-run-t">${esc(fmtTime(r.createdAt))}</span>`;
      const cb = item.querySelector('input');
      cb.onchange = () => { if (cb.checked) runPickSelected.add(r.id); else runPickSelected.delete(r.id); $('evalRunPickCount').textContent = `已选 ${runPickSelected.size}`; };
      box.appendChild(item);
    }
  }

  async function createFromSelected() {
    if (!runPickSelected.size) { toastMsg('请先勾选运行记录', 'err'); return; }
    let ok = 0;
    for (const runId of runPickSelected) {
      const res = await api.eval.caseFromRun({ runId });
      if (res && res.ok) ok += 1;
    }
    $('modalEvalFromRun').hidden = true;
    toastMsg(`已新建 ${ok} 条用例`);
    await loadEval();
  }

  /* ---------- 单条测试 ---------- */
  async function runSingle() {
    const caseId = $('evalSingleCase').value;
    if (!caseId) { toastMsg('没有可运行的用例', 'err'); return; }
    const box = $('evalSingleResult');
    box.innerHTML = '<div class="empty-block">运行中…（走真实 Agent 链路，可能几十秒）</div>';
    const res = await api.eval.runOne(caseId);
    renderRunResult(res);
  }

  function renderRunResult(res) {
    const box = $('evalSingleResult');
    if (!res || (!res.ok && !res.run)) { box.innerHTML = `<div class="empty-block">${esc((res && res.error) || '运行失败')}</div>`; return; }
    const s = res.score || {};
    const r = res.run || {};
    const st = s.status || 'ERROR';
    const stCls = st === 'PASS' ? 'pill-PASS' : st === 'FAIL' ? 'pill-FAIL' : st === 'REVIEW' ? 'pill-REVIEW' : 'pill-error';
    box.innerHTML = `
      <div class="eval-detail-head"><div class="eval-detail-title">运行结果 <span class="pill ${stCls}">${esc(st)}</span></div>
        <span class="muted">runId ${esc(r.id || '-')} · ${r.durationMs || 0}ms</span></div>
      <div class="muted">${esc(s.reason || '')}</div>
      <h4>最终回复</h4><div class="reply-block">${esc(r.finalReply || r.error || '(空)')}</div>
      <div class="muted">证据: ${esc((s.evidence || []).join(' | ') || '-')}</div>
      <h4>执行 Trace</h4>${traceHtml(r.traceSteps)}`;
  }

  /* ---------- 批量测试 ---------- */
  async function openNewBatch() {
    const box = $('ebCaseList');
    $('ebName').value = '';
    $('ebLabel').value = '';
    const eligible = cases.filter((c) => c.enabled !== false);
    if (!eligible.length) {
      box.innerHTML = '<div class="empty-block">没有启用的用例，请先到用例管理启用</div>';
    } else {
      box.innerHTML = eligible.map((c) => `<label class="eb-case"><input type="checkbox" value="${esc(c.id)}" checked/>
        <span class="pill">${esc(c.evalDimension || '-')}</span>
        <span class="eb-case-name">${esc(c.name || c.question)}</span></label>`).join('');
      box.querySelectorAll('input[type=checkbox]').forEach((cb) => cb.addEventListener('change', updateEbCount));
    }
    updateEbCount();
    $('modalEvalBatch').hidden = false;
  }
  function ebSelected() {
    return [...document.querySelectorAll('#ebCaseList input[type=checkbox]:checked')].map((x) => x.value);
  }
  function updateEbCount() { if ($('ebCount')) $('ebCount').textContent = '已选 ' + ebSelected().length + ' 条'; }

  async function createBatch() {
    const ids = ebSelected();
    if (!ids.length) { toastMsg('请至少选择一条用例', 'err'); return; }
    const res = await api.eval.batchCreate({ caseIds: ids, name: $('ebName').value.trim(), versionLabel: $('ebLabel').value.trim() });
    if (!res || !res.ok) { toastMsg('创建失败: ' + ((res && res.error) || ''), 'err'); return; }
    $('modalEvalBatch').hidden = true;
    toastMsg('批次已创建');
    await loadEval();
    openBatchRuns(res.batchId);
  }

  function renderBatches() {
    const box = $('evalBatches');
    if (!batches.length) {
      box.innerHTML = '<div class="empty-block">暂无批次，点「新建批次」</div>';
    } else {
      box.innerHTML = '';
      for (const b of batches) {
        const item = document.createElement('div');
        item.className = 'eval-item eval-batch-item' + (b.id === openBatchId ? ' active' : '');
        item.innerHTML = `<div class="eval-item-title">${esc(b.name || b.id)}<span class="pill">${esc(String(b.runCount || 0))} 次运行</span></div>
          <div class="eval-item-sub">${(b.caseIds || []).length} 用例 · ${esc(b.versionLabel || '')} · ${esc(b.caseSetHash || '')} · ${esc(fmtTime(b.createdAt))}</div>
          <div class="eval-batch-actions">
            <button class="btn btn-xs" data-act="history" data-id="${esc(b.id)}">运行历史</button>
            <button class="btn btn-xs btn-primary" data-act="run" data-id="${esc(b.id)}">运行</button>
          </div>`;
        box.appendChild(item);
      }
      box.querySelectorAll('button[data-act]').forEach((btn) => {
        btn.onclick = () => {
          const id = btn.dataset.id;
          if (btn.dataset.act === 'history') openBatchRuns(id);
          else if (btn.dataset.act === 'run') runBatch(id);
        };
      });
    }
    refreshCompareOptions();
  }

  async function refreshCompareOptions() {
    const res = await api.eval.batchRuns({});
    const runs = (res && res.ok ? res.runs : []) || [];
    const opts = runs.map((r) => `<option value="${esc(r.id)}">${esc((r.batchName || r.batchId) + ' · ' + (r.versionLabel || '') + ' · ' + fmtTime(r.createdAt))}</option>`).join('');
    if ($('evalCompareA')) $('evalCompareA').innerHTML = opts;
    if ($('evalCompareB')) $('evalCompareB').innerHTML = opts;
    if (window.syncEvalSelects) window.syncEvalSelects();
  }

  async function openBatchRuns(batchId, focusRunId) {
    openBatchId = batchId;
    // 打开"批次运行历史"整页 (左侧目录 / 右侧报告), 顶部页签仍停在「评测」
    document.querySelectorAll('#evalPlatformTabs .subnav-tab').forEach((t) => t.classList.toggle('active', t.dataset.pane === 'eval'));
    document.querySelectorAll('.eval-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === 'batchruns'));
    setEvalFill(true);
    const b = batches.find((x) => x.id === batchId);
    if ($('batchRunsTitle')) $('batchRunsTitle').textContent = '运行历史 · ' + ((b && b.name) || batchId);
    await loadRunDir(batchId, focusRunId);
  }

  async function loadRunDir(batchId, focusRunId) {
    const res = await api.eval.batchRuns({ batchId });
    const runs = (res && res.ok ? res.runs : []) || [];
    const dir = $('evalRunDir');
    if (!runs.length) {
      dir.innerHTML = '<div class="empty-block">这个批次还没有运行记录</div>';
      $('evalBatchReport').innerHTML = '<div class="empty-block">暂无运行，回到批量测试点批次上的「运行」</div>';
      return;
    }
    const focus = focusRunId && runs.some((r) => r.id === focusRunId) ? focusRunId : runs[0].id;
    openRunId = focus;
    dir.innerHTML = runs.map((r) => {
      const st = r.status;
      const stCls = st === 'running' ? 'pill-REVIEW' : st === 'done' ? 'pill-PASS' : st === 'error' ? 'pill-FAIL' : 'pill-cancelled';
      return `<div class="eval-item${r.id === focus ? ' active' : ''}" data-run="${esc(r.id)}">
        <div class="eval-item-title">${esc(fmtTime(r.createdAt))}<span class="pill ${stCls}">${esc(st)}</span></div>
        <div class="eval-item-sub">total ${r.total} · pass ${r.passed} · fail ${r.failed} · review ${r.review} · error ${r.errors}</div></div>`;
    }).join('');
    dir.querySelectorAll('[data-run]').forEach((el) => {
      el.onclick = () => {
        openRunId = el.dataset.run;
        dir.querySelectorAll('[data-run]').forEach((x) => x.classList.toggle('active', x === el));
        renderBatchReport(el.dataset.run);
      };
    });
    renderBatchReport(focus);
  }

  async function runBatch(batchId) {
    const res = await api.eval.batchRun({ batchId });
    if (!res || !res.ok) { toastMsg('运行失败: ' + ((res && res.error) || ''), 'err'); return; }
    toastMsg('已开始运行');
    openBatchId = batchId;
    openRunId = res.runId;
    await loadEval();
    openBatchRuns(batchId, res.runId);
    pollRun(res.runId, batchId);
  }

  async function cancelBatch(runId) { await api.eval.batchCancel(runId); toastMsg('已请求取消'); }

  function pollRun(runId, batchId) {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      const res = await api.eval.batchRunGet(runId);
      if (!res || !res.ok) { clearInterval(pollTimer); pollTimer = null; return; }
      const r = res.run;
      if (openRunId === runId) renderBatchReport(runId, r);
      if (['done', 'error', 'cancelled'].includes(r.status)) {
        clearInterval(pollTimer); pollTimer = null;
        loadEval();
        if (openBatchId === batchId) loadRunDir(batchId, openRunId);
      }
    }, 900);
  }

  async function renderBatchReport(runId, preset) {
    openRunId = runId;
    let b = preset;
    if (!b) { const res = await api.eval.batchRunGet(runId); if (!res || !res.ok) { const el = $('evalBatchReport'); if (el) el.innerHTML = `<div class="empty-block">${esc((res && res.error) || '报告不存在')}</div>`; return; } b = res.run; }
    const box = $('evalBatchReport');
    const st = b.status;
    const denom = (b.passed || 0) + (b.failed || 0) + (b.review || 0);
    const passRate = denom > 0 ? ((b.passed / denom) * 100).toFixed(0) : '-';
    const sumOk = b.total === (b.passed + b.failed + b.review + b.errors);
    const pct = b.total ? Math.round((b.currentIndex / b.total) * 100) : 0;
    const stCls = st === 'running' ? 'pill-REVIEW' : st === 'done' ? 'pill-PASS' : st === 'error' ? 'pill-FAIL' : 'pill-cancelled';
    const cases = (b.caseResults || []).map((r) => {
      const s = r.score || {};
      const rs = r.status || 'ERROR';
      const cls = rs === 'PASS' ? 'pill-PASS' : rs === 'FAIL' ? 'pill-FAIL' : rs === 'REVIEW' ? 'pill-REVIEW' : 'pill-error';
      return `<div class="eval-report-case">
        <div class="eval-report-case-head"><span class="eval-row-title">${esc(r.name || r.caseId)}</span><span class="muted">${esc(r.caseId)}</span>
          <span class="pill ${cls}">${esc(rs)}</span><span class="trace-ms">${r.durationMs || 0}ms</span></div>
        <div class="muted">${esc(r.question || '')}</div>
        <div class="muted">${esc(s.reason || r.error || '')}</div>
        <details class="trace-io" ${rs === 'PASS' ? '' : 'open'}><summary>实际最终回复</summary>
          <div class="reply-block">${esc(r.finalReply || r.error || '(空)')}</div></details>
        ${(s.evidence && s.evidence.length) ? `<div class="muted">证据: ${esc(s.evidence.join(' | '))}</div>` : ''}
        ${r.runId ? `<div class="muted">runId ${esc(r.runId)}</div>` : ''}
      </div>`;
    }).join('');
    box.innerHTML = `
      <div class="eval-report">
        <div class="eval-report-head">
          <div class="eval-report-title">结果报告 <span class="pill ${stCls}">${esc(st)}</span></div>
          <div class="eval-report-actions">
            <button class="btn btn-xs" id="btnBatchReportRefresh">刷新</button>
            ${st === 'running' ? '<button class="btn btn-xs btn-danger" id="btnBatchReportCancel">取消批次</button>' : ''}
          </div>
        </div>
        <div class="muted">评测批次 · ${esc(b.batchName || '')} · ${b.total} 用例 · ${esc(fmtTime(b.createdAt))}</div>
        <div class="eval-report-note">当前评测方式：规则评测（关键词 AND/OR、禁词、价格、能力路径、风险语义）。LLM-as-a-Judge 未启用，不展示虚假 Judge 分数。</div>
        <div class="eval-report-progress"><div class="muted">${st === 'running' ? `运行中 ${b.currentIndex}/${b.total}` : `已${st === 'done' ? '完成' : st === 'cancelled' ? '取消' : '结束'} ${b.currentIndex}/${b.total}`}</div><div class="bar"><i style="width:${pct}%"></i></div><span class="pct">${pct}%</span></div>
        <div class="eval-stat-row">
          <div class="tool-stat"><div class="tool-stat-k">总数 total</div><div class="tool-stat-v">${b.total}</div></div>
          <div class="tool-stat"><div class="tool-stat-k">PASS</div><div class="tool-stat-v">${b.passed}</div></div>
          <div class="tool-stat"><div class="tool-stat-k">FAIL</div><div class="tool-stat-v">${b.failed}</div></div>
          <div class="tool-stat"><div class="tool-stat-k">REVIEW</div><div class="tool-stat-v">${b.review}</div></div>
          <div class="tool-stat"><div class="tool-stat-k">ERROR（不计入分母）</div><div class="tool-stat-v">${b.errors}</div></div>
          <div class="tool-stat"><div class="tool-stat-k">通过率（排除 ERROR）</div><div class="tool-stat-v">${passRate}</div></div>
        </div>
        ${sumOk ? '' : '<div class="eval-report-warn">统计校验失败：total 与各项之和不一致</div>'}
        <div class="eval-meta-grid">
          <div><div class="tool-stat-k">Provider / 模型</div><div>${esc(b.provider || '-')} / ${esc(b.model || '-')}</div></div>
          <div><div class="tool-stat-k">评测器</div><div>rules-scorer · ${esc(b.scorerVersion || '-')}</div></div>
          <div><div class="tool-stat-k">用例集哈希</div><div>${esc(b.caseSetHash || '-')}</div></div>
          <div><div class="tool-stat-k">版本标签</div><div>${esc(b.versionLabel || '-')}</div></div>
          <div><div class="tool-stat-k">创建时间</div><div>${esc(fmtTime(b.createdAt))}</div></div>
          <div><div class="tool-stat-k">完成时间</div><div>${esc(b.finishedAt ? fmtTime(b.finishedAt) : '-')}</div></div>
        </div>
        <div class="eval-report-cases">${cases || '<div class="empty-block">暂无结果，点上方「运行」开始</div>'}</div>
      </div>`;
    if ($('btnBatchReportRefresh')) $('btnBatchReportRefresh').onclick = () => renderBatchReport(runId);
    if ($('btnBatchReportCancel')) $('btnBatchReportCancel').onclick = () => cancelBatch(runId);
  }

  async function compare() {
    const a = $('evalCompareA').value, b = $('evalCompareB').value;
    if (!a || !b) { toastMsg('请选择两个批次', 'err'); return; }
    const res = await api.eval.compare({ a, b });
    const box = $('evalCompare');
    if (!res || !res.ok) { box.innerHTML = `<div class="empty-block">${esc((res && res.error) || '')}</div>`; return; }
    const r = res.result;
    if (!r.comparable) { box.innerHTML = `<div class="empty-block">${esc(r.reason)}</div>`; return; }
    box.innerHTML = `<div class="eval-detail-title">对比结果</div>
      <div class="muted">通过率 ${(r.passRateA * 100).toFixed(0)}% → ${(r.passRateB * 100).toFixed(0)}% (Δ ${(r.passRateDelta * 100).toFixed(1)}%)</div>
      <div class="muted">已修复 ${r.fixed.length} · 新增失败 ${r.newlyFailed.length} · 回复改变 ${r.replyChanged.length}</div>
      ${r.fixed.map((x) => `<div class="trace-row">已修复: ${esc(x.caseId)} (${esc(x.from)}→PASS)</div>`).join('')}
      ${r.newlyFailed.map((x) => `<div class="trace-row">新增失败: ${esc(x.caseId)} (PASS→${esc(x.to)})</div>`).join('')}`;
  }

  window.initEvalPlatform = initEvalPlatform;
})();
