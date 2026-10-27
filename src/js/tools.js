'use strict';
/* 工具页签: 列出三个 Agent 的全部内置工具 (注册表) + Input Schema。
   其中"规划器可选"的那批可以开关 (写进 planner.allowedCaps), 其余标为内置。 */
(function () {
  const api = window.bridge;
  let bound = false;
  let groups = [];          // catalog.groups
  let eligible = new Set(); // 规划器可选的工具 id
  let allowed = new Set();  // planner.allowedCaps
  let labels = {};
  let allowedSkills = [];
  let mandatory = [];
  let selected = null;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toastMsg = (m, l) => { if (typeof toast === 'function') toast(m, l); else console.log(m); };
  const labelOf = (name) => labels[name] || name;

  function allTools() {
    const out = [];
    for (const g of groups) for (const t of (g.tools || [])) {
      out.push(Object.assign({}, t, { agentId: g.id, agentLabel: g.label }));
    }
    return out;
  }

  async function initToolsPane() {
    if (!bound) {
      bound = true;
      const s = $('toolSearch');
      if (s) s.addEventListener('input', renderList);
    }
    await loadTools();
  }

  async function loadTools() {
    const list = $('toolList');
    list.innerHTML = '<div class="empty-block">加载中…</div>';
    try {
      const [cat, pc] = await Promise.all([api.internalTools.list(), api.planner.configGet()]);
      groups = cat.groups || [];
      eligible = new Set((pc.allTools || []).map((a) => a.id));
      labels = {};
      for (const a of (pc.allTools || [])) labels[a.id] = a.label;
      allowed = new Set(pc.allowedCaps || []);
      allowedSkills = pc.allowedSkills || [];
      mandatory = pc.mandatory || [];
    } catch (e) {
      list.innerHTML = `<div class="empty-block">加载失败: ${esc(e.message)}</div>`;
      return;
    }
    renderStats();
    renderList();
    const first = allTools()[0];
    if (first) openTool(first.name);
  }

  function total() { return allTools().length; }
  function enabledCount() { return [...eligible].filter((id) => allowed.has(id)).length; }

  function renderStats() {
    const box = $('toolStats');
    if (!box) return;
    const t = total();
    const cfg = eligible.size;
    const on = enabledCount();
    box.innerHTML = `
      <div class="tool-stat"><div class="tool-stat-k">注册 Tool</div><div class="tool-stat-v">${t}</div><div class="tool-stat-s">三个 Agent 全部内置工具</div></div>
      <div class="tool-stat"><div class="tool-stat-k">规划器可选</div><div class="tool-stat-v">${cfg}</div><div class="tool-stat-s">可开关的分析工具</div></div>
      <div class="tool-stat"><div class="tool-stat-k">已启用</div><div class="tool-stat-v">${on}</div><div class="tool-stat-s">会出现在规划器清单</div></div>
      <div class="tool-stat"><div class="tool-stat-k">已停用</div><div class="tool-stat-v">${cfg - on}</div><div class="tool-stat-s">可配置但已关闭</div></div>`;
  }

  function renderList() {
    const list = $('toolList');
    if (!list) return;
    const q = (($('toolSearch') && $('toolSearch').value) || '').trim().toLowerCase();
    const match = (t) => !q ||
      (t.name || '').toLowerCase().includes(q) ||
      labelOf(t.name).toLowerCase().includes(q) ||
      (t.description || '').toLowerCase().includes(q);
    list.innerHTML = '';
    let any = false;
    for (const g of groups) {
      const shown = (g.tools || []).filter(match);
      if (!shown.length) continue;
      any = true;
      const head = document.createElement('div');
      head.className = 'tool-group-head';
      head.textContent = `${g.label} · ${shown.length}`;
      list.appendChild(head);
      for (const t of shown) {
        const configurable = eligible.has(t.name);
        const on = configurable && allowed.has(t.name);
        const badge = configurable
          ? `<span class="pill ${on ? 'pill-ok' : 'pill-cancelled'}">${on ? '已启用' : '已停用'}</span>`
          : '<span class="pill">内置</span>';
        const item = document.createElement('div');
        item.className = 'eval-item' + (t.name === selected ? ' active' : '');
        item.innerHTML = `<div class="eval-item-title"><span class="eval-item-name">${esc(labelOf(t.name))}</span>${badge}</div>
          <div class="eval-item-sub">${esc(t.name)}</div>`;
        item.onclick = () => openTool(t.name);
        list.appendChild(item);
      }
    }
    if (!any) list.innerHTML = '<div class="empty-block">没有匹配的工具</div>';
  }

  function openTool(name) {
    selected = name;
    renderList();
    const t = allTools().find((x) => x.name === name);
    const box = $('toolDetail');
    if (!t) { box.innerHTML = '<div class="empty-block">工具不存在</div>'; return; }
    const configurable = eligible.has(name);
    const on = configurable && allowed.has(name);
    const schemaText = t.schema ? JSON.stringify(t.schema, null, 2) : '(该工具无参数)';
    const toggle = configurable
      ? `<label class="eval-check"><input type="checkbox" id="toolEnabled" ${on ? 'checked' : ''}/> ${on ? '已启用' : '已停用'}</label>`
      : '<span class="pill">内置 · 不可在规划器配置</span>';
    box.innerHTML = `
      <div class="eval-detail-head"><div class="eval-detail-title">${esc(labelOf(t.name))} <span class="muted">${esc(t.name)}</span></div>${toggle}</div>
      <div class="muted">${esc(t.description || '')}</div>
      <div class="muted">Agent: ${esc(t.agentLabel || '')} · 分组: ${esc(t.groupLabel || t.group || '-')} · ${t.readOnly ? '只读' : '有副作用'}${t.shared ? ' · 多 Agent 共用' : ''}</div>
      <h4>Input Schema</h4>
      <pre class="plan-block">${esc(schemaText)}</pre>
      <h4>输出</h4>
      <div class="muted">工具返回值（结构化结果或错误信息）。Askaha 的内置工具不单独声明输出 Schema。</div>
      ${configurable ? `
      <h4>参数校验（不执行数据库）</h4>
      <textarea id="toolArgs" class="prompt-body" rows="3" placeholder='按 Input Schema 填 JSON，例如 {"table":"orders"}'></textarea>
      <div class="eval-actions"><button class="btn" id="btnToolValidate">校验参数</button></div>
      <div id="toolValidateResult"></div>` : ''}`;
    if (configurable) {
      $('toolEnabled').onchange = (e) => setToolEnabled(name, e.target.checked);
      $('btnToolValidate').onclick = () => validateTool(t);
    }
  }

  async function setToolEnabled(name, on) {
    if (on) allowed.add(name); else allowed.delete(name);
    const res = await api.planner.configSave({ allowedCaps: [...allowed], allowedSkills, mandatory });
    if (!res || !res.ok) {
      if (on) allowed.delete(name); else allowed.add(name);
      toastMsg('保存失败: ' + ((res && res.error) || ''), 'err');
      return;
    }
    if (Array.isArray(res.allowedSkills)) allowedSkills = res.allowedSkills;
    if (Array.isArray(res.mandatory)) mandatory = res.mandatory;
    renderStats();
    openTool(name);
    toastMsg((on ? '已启用 ' : '已停用 ') + labelOf(name));
  }

  function validateTool(t) {
    const box = $('toolValidateResult');
    let args;
    const raw = ($('toolArgs').value || '').trim();
    try { args = raw ? JSON.parse(raw) : {}; }
    catch (e) { box.innerHTML = `<div class="pill pill-FAIL">JSON 解析失败: ${esc(e.message)}</div>`; return; }
    if (args == null || typeof args !== 'object' || Array.isArray(args)) {
      box.innerHTML = '<div class="pill pill-FAIL">参数应为 JSON 对象</div>';
      return;
    }
    const schema = t.schema || {};
    const errors = [];
    for (const req of (schema.required || [])) {
      if (!(req in args)) errors.push('缺少必填参数: ' + req);
    }
    const props = schema.properties || {};
    for (const k of Object.keys(args)) {
      const p = props[k];
      if (!p) { errors.push('未知参数: ' + k); continue; }
      const ty = p.type;
      if (ty === 'string' && typeof args[k] !== 'string') errors.push(`${k}: 应为 string`);
      else if ((ty === 'number' || ty === 'integer') && typeof args[k] !== 'number') errors.push(`${k}: 应为 number`);
      else if (ty === 'boolean' && typeof args[k] !== 'boolean') errors.push(`${k}: 应为 boolean`);
      else if (ty === 'array' && !Array.isArray(args[k])) errors.push(`${k}: 应为 array`);
    }
    box.innerHTML = errors.length
      ? `<div class="pill pill-FAIL">校验未通过</div>${errors.map((e) => `<div class="trace-row">${esc(e)}</div>`).join('')}`
      : '<div class="pill pill-PASS">参数校验通过（实际执行需在对话中进行）</div>';
  }

  window.initToolsPane = initToolsPane;
})();
