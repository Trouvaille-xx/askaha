'use strict';
/* 运行记录视图: 列出 RunRecord, 查看详情 / 人工接管 / 标注 / 加入评测。 */
(function () {
  const api = window.bridge;
  let bound = false;
  let currentId = null;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toastMsg = (m, l) => { if (typeof toast === 'function') toast(m, l); else console.log(m); };
  const STATUS_CN = { ok: '成功', error: '错误', cancelled: '已取消', handoff: '已接管' };

  function initRuns() {
    if (!bound) {
      bound = true;
      $('btnRunRefresh').addEventListener('click', loadRuns);
      $('runFilterStatus').addEventListener('change', loadRuns);
    }
    loadRuns();
  }

  async function loadRuns() {
    const status = $('runFilterStatus').value || undefined;
    const list = $('runList');
    list.innerHTML = '<div class="empty-block">加载中…</div>';
    const res = await api.run.list(status ? { status } : {});
    if (!res.ok || !res.runs.length) { list.innerHTML = '<div class="empty-block">暂无运行记录</div>'; return; }
    list.innerHTML = '';
    for (const r of res.runs) {
      const item = document.createElement('div');
      item.className = 'eval-item' + (r.id === currentId ? ' active' : '');
      item.dataset.id = r.id;
      item.innerHTML = `<div class="eval-item-title"><span class="eval-item-name">${esc((r.question || '').slice(0, 40) || '(无问题)')}</span><span class="pill pill-${esc(r.status)}">${esc(STATUS_CN[r.status] || r.status)}</span></div>
        <div class="eval-item-sub">${esc(r.source)} · ${esc(r.model || '-')} · ${r.durationMs || 0}ms</div>`;
      item.onclick = () => openRun(r.id);
      list.appendChild(item);
    }
  }

  async function openRun(id) {
    currentId = id;
    document.querySelectorAll('#runList .eval-item').forEach((x) => x.classList.toggle('active', x.dataset.id === id));
    const box = $('runDetail');
    box.innerHTML = '<div class="empty-block">加载中…</div>';
    const res = await api.run.get(id);
    if (!res.ok) { box.innerHTML = `<div class="empty-block">${esc(res.error)}</div>`; return; }
    const r = res.run;
    const plan = r.plan ? `<pre class="plan-block">${esc(JSON.stringify(r.plan, null, 2))}</pre>` : '<div class="muted">本轮无显式规划</div>';
    const trace = (r.trace || []).map((t) => `<div class="trace-row"><span class="pill">${esc(t.kind || '')}</span> ${esc(t.title || '')}${t.detail ? ' — ' + esc(String(t.detail).slice(0, 200)) : ''}</div>`).join('') || '<div class="muted">无 trace</div>';
    box.innerHTML = `
      <div class="eval-detail-head"><div class="eval-detail-title">${esc((r.question || '').slice(0, 80))}</div><span class="pill pill-${esc(r.status)}">${esc(STATUS_CN[r.status] || r.status)}</span></div>
      <div class="muted">来源 ${esc(r.source)} · 模型 ${esc(r.model || '-')} · ${r.durationMs || 0}ms · ${esc(r.createdAt || '')}</div>
      <h4>最终回复</h4><div class="reply-block">${esc(r.finalReply || '(空)')}</div>
      <h4>规划</h4>${plan}
      <h4>能力</h4><div class="muted">${esc((r.capabilities || []).join(', ') || '(无)')}</div>
      <h4>执行 Trace</h4>${typeof traceStepsHtml === 'function' ? traceStepsHtml(r.traceSteps || []) : ''}
      <h4>决策链（简）</h4><div class="trace-list">${trace}</div>
      <h4>标注</h4>
      <textarea id="runAnnotation" class="prompt-body" rows="2" placeholder="写下这条运行的标注">${esc((r.annotation && r.annotation.note) || '')}</textarea>
      <div class="eval-actions">
        <button class="btn" id="btnRunHandoff">人工接管</button>
        <button class="btn" id="btnRunSaveAnn">保存标注</button>
        <button class="btn" id="btnRunToEval">加入评测</button>
      </div>`;
    $('btnRunHandoff').onclick = async () => { await api.run.handoff(id); toastMsg('已标记人工接管'); loadRuns(); };
    $('btnRunSaveAnn').onclick = async () => {
      const note = $('runAnnotation').value.trim();
      await api.run.annotate({ id, annotation: { note, at: new Date().toISOString() } });
      toastMsg('标注已保存');
    };
    $('btnRunToEval').onclick = async () => {
      const rr = await api.eval.caseFromRun({ runId: id });
      toastMsg(rr.ok ? '已加入评测集' : ('失败: ' + (rr.error || '')), rr.ok ? '' : 'err');
    };
  }

  window.initRuns = initRuns;
})();
