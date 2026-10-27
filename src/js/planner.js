'use strict';
/* 规划器预览: 输入测试问题, 预览 意图路由 + 规划 + 校验 (只预览, 不执行)。 */
(function () {
  const api = window.bridge;
  let bound = false;
  let toolLabels = {};
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toastMsg = (m, l) => { if (typeof toast === 'function') toast(m, l); else console.log(m); };

  function initPlanner() {
    if (!bound) {
      bound = true;
      $('btnPlannerPreview').addEventListener('click', preview);
      const saveBtn = $('btnPlannerSaveCfg');
      if (saveBtn) saveBtn.addEventListener('click', saveConfig);
    }
    loadConfig();
    loadPrompt();
  }

  async function loadConfig() {
    const box = $('plannerConfig');
    if (!box) return;
    let res;
    try { res = await api.planner.configGet(); } catch (e) { box.innerHTML = '<div class="empty-block">加载失败</div>'; return; }
    if (!res || !res.ok) { box.innerHTML = '<div class="empty-block">加载失败</div>'; return; }
    const tools = res.allTools || (res.allCaps || []).map((id) => ({ id, label: id }));
    toolLabels = {};
    for (const t of tools) toolLabels[t.id] = t.label;
    const skills = res.enabledSkills || [];
    const allowedCaps = new Set(res.allowedCaps || []);
    const allowedSkills = new Set(res.allowedSkills || []);
    const mandatory = new Set(res.mandatory || []);
    const capChecks = tools.map((t) => `<label class="eval-check" title="${esc(t.id)}"><input type="checkbox" data-cfg="cap" value="${esc(t.id)}" ${allowedCaps.has(t.id) ? 'checked' : ''}/> ${esc(t.label)}</label>`).join('');
    const manChecks = tools.map((t) => `<label class="eval-check" title="${esc(t.id)}"><input type="checkbox" data-cfg="mand" value="${esc(t.id)}" ${mandatory.has(t.id) ? 'checked' : ''}/> ${esc(t.label)}</label>`).join('');
    const skillChecks = skills.length
      ? skills.map((s) => `<label class="eval-check"><input type="checkbox" data-cfg="skill" value="${esc(s)}" ${allowedSkills.has(s) ? 'checked' : ''}/> ${esc(s)}</label>`).join('')
      : '<span class="muted">(没有启用中的 Skill；可到「配置 · 技能」启用)</span>';
    box.innerHTML = `
      <div class="eval-detail-title">允许的能力（工具）</div>
      <div class="planner-checks">${capChecks}</div>
      <div class="eval-detail-title">允许的 Skill</div>
      <div class="planner-checks">${skillChecks}</div>
      <div class="eval-detail-title">必选能力（mandatoryCapabilities）</div>
      <div class="planner-checks">${manChecks}</div>`;
  }

  async function saveConfig() {
    const checked = (kind) => [...document.querySelectorAll(`input[data-cfg="${kind}"]:checked`)].map((x) => x.value);
    const res = await api.planner.configSave({ allowedCaps: checked('cap'), allowedSkills: checked('skill'), mandatory: checked('mand') });
    toastMsg(res && res.ok ? '配置已保存' : ('保存失败: ' + ((res && res.error) || '')), res && res.ok ? '' : 'err');
    if (res && res.ok) loadPrompt();
  }

  async function loadPrompt() {
    const el = $('plannerPromptView');
    if (!el) return;
    try {
      const res = await api.planner.prompt();
      el.textContent = (res && res.ok)
        ? ('【SYSTEM】\n' + res.system + '\n\n【模板】\n' + res.template)
        : ('无法加载提示词: ' + ((res && res.error) || ''));
    } catch (e) {
      el.textContent = '无法加载提示词: ' + e.message;
    }
  }

  async function preview() {
    const q = $('plannerQuestion').value.trim();
    const box = $('plannerResult');
    if (!q) { toastMsg('请输入测试问题', 'err'); return; }
    box.innerHTML = '<div class="empty-block">预览中…</div>';
    const res = await api.planner.preview({ question: q });
    if (!res.ok) { box.innerHTML = `<div class="empty-block">${esc(res.error)}</div>`; return; }
    const p = res.plan || {};
    const v = res.validation || { errors: [], warnings: [] };
    const pv = $('plannerPromptView');
    if (pv && res.system) pv.textContent = '【SYSTEM】\n' + res.system + '\n\n【本次提示词】\n' + (res.prompt || '');
    const toolNames = (p.selectedTools || []).map((id) => `${esc(id)}${toolLabels[id] ? '（' + esc(toolLabels[id]) + '）' : ''}`).join('、') || '无';
    const rj = p.riskJudgment || {};
    box.innerHTML = `<div class="eval-detail-title">意图路由: ${esc(res.route || '-')}</div>
      <div class="muted">思路: ${esc(p.approach || '(空)')}</div>
      <h4>选中的工具</h4><div class="muted">${toolNames}</div>
      <h4>选中的 Skill</h4><div class="muted">${esc((p.selectedSkills || []).join('、') || '无')}</div>
      <h4>必选能力</h4><div class="muted">${esc((p.mandatoryCapabilities || []).join('、') || '无')}</div>
      <h4>风险判断</h4><div class="muted">等级 ${esc(rj.level || 'none')} · 转人工 ${rj.handoff ? '是' : '否'}${rj.reason ? ' — ' + esc(rj.reason) : ''}</div>
      <h4>为什么这么选 (reasoning)</h4><div class="muted">${esc(p.reasoning || '(空)')}</div>
      <h4>步骤</h4>${(p.steps || []).map((s) => `<div class="trace-row">${esc(s.id || '')} ${esc(s.title || '')}${s.detail ? ' — ' + esc(s.detail) : ''}</div>`).join('') || '<div class="muted">无</div>'}
      <h4>要访问的表</h4><div class="muted">${esc((p.requiredTables || []).join('、') || '-')}</div>
      <h4>校验</h4>
      ${v.ok ? '<div class="pill pill-PASS">通过</div>' : '<div class="pill pill-FAIL">未通过</div>'}
      ${(v.errors || []).map((e) => `<div class="trace-row">错误: ${esc(e)}</div>`).join('')}
      ${(v.warnings || []).map((e) => `<div class="trace-row">提示: ${esc(e)}</div>`).join('')}`;
  }

  window.initPlanner = initPlanner;
})();
