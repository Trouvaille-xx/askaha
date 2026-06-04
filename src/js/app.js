// ============== SoloDB Renderer ==============
// 通过 window.api (preload) 与主进程通信

// 全局错误捕获: 即使 init 失败也能给用户看
const diag = (msg) => {
  try {
    console.log('[diag]', msg);
    const el = document.getElementById('diag');
    if (el) {
      el.textContent = 'diag: ' + msg;
      el.style.background = msg.startsWith('err') ? '#fecaca' : (msg.includes('ready') || msg.includes('ok') ? '#bbf7d0' : '#fde68a');
    }
    document.title = 'SoloDB · ' + msg;
  } catch (e) {}
};
diag('script-loaded');

function showFatalError(msg) {
  try {
    let bar = document.getElementById('fatalBar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'fatalBar';
      bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#b91c1c;color:#fff;padding:12px 18px;font-family:ui-monospace,Consolas,monospace;font-size:12.5px;white-space:pre-wrap;box-shadow:0 4px 12px rgba(0,0,0,.2);max-height:50vh;overflow:auto;';
      document.body.appendChild(bar);
    }
    bar.textContent = '[FATAL] ' + msg;
  } catch (e) {
    document.title = '[FATAL] ' + msg;
  }
}
window.addEventListener('error', (e) => {
  showFatalError(e.message + '\n' + (e.filename || '') + ':' + (e.lineno || '') + ':' + (e.colno || ''));
});
window.addEventListener('unhandledrejection', (e) => {
  showFatalError('Unhandled promise rejection: ' + (e.reason && e.reason.message || e.reason));
});

const api = window.bridge;
diag('api=' + (api ? 'ok' : 'undefined'));
if (!api) {
  showFatalError('window.bridge 未定义, preload 可能未生效。请检查 preload.js 是否被正确加载。');
}
let state = {
  config: null,
  conversation: [], // { role, content, steps, report }
  running: false,
  activeConversationId: null
};

const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

// ============== Init ==============
init().catch((e) => {
  showFatalError('初始化失败: ' + (e && e.stack || e));
});

async function init() {
  if (!api) { diag('init-skip'); return; }
  try {
    diag('init: getting config');
    state.config = await api.config.get();
    diag('init: binding events');
    bindEvents();
    diag('init: rendering');
    renderAll();
    diag('init: subscribe agent');
    api.agent.onEvent(handleAgentEvent);
    api.agent.onCheckpoint(handleCheckpoint);
    diag('ready dbs=' + (state.config.databases || []).length);
  } catch (e) {
    diag('err: ' + (e && e.message || e));
    showFatalError('init 失败: ' + (e && e.stack || e));
  }
}

function bindEvents() {
  // Tab navigation
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => switchView(tab.dataset.view));
  });

  // New chat
  $('btnNewChat').addEventListener('click', () => {
    state.conversation = [];
    state.activeConversationId = null;
    renderChat();
  });

  // Database selector in topbar
  $('dbSelector').addEventListener('click', () => switchView('databases'));

  // LLM page
  $('btnSaveLLM').addEventListener('click', saveLLM);

  // Database page
  $('btnAddDb').addEventListener('click', () => openDbModal());

  // Database modal
  $$('#modalDb [data-close]').forEach((el) => el.addEventListener('click', closeDbModal));
  $('btnTestDb').addEventListener('click', testDb);
  $('btnSaveDb').addEventListener('click', saveDb);
  $('dbType').addEventListener('change', toggleDbFields);

  // Skills page
  $('btnImportSkill').addEventListener('click', importSkillDir);
  $('btnImportSkillFile').addEventListener('click', importSkillFile);

  // Composer
  $('btnSend').addEventListener('click', sendTask);
  $('composerInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      sendTask();
    }
  });
}

// ============== View switching ==============
function switchView(view) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === view));
  if (view === 'databases') renderDbList();
  if (view === 'llm') renderLLMForm();
  if (view === 'skills') renderSkillList();
}

// ============== Render ==============
function renderAll() {
  renderTopDb();
  renderChat();
  renderLLMForm();
  renderDbList();
  renderSkillList();
}

function renderTopDb() {
  const active = (state.config.databases || []).find((d) => d.id === state.config.activeDatabase);
  $('activeDbLabel').textContent = active ? active.name : '未选择';
  $('composerMeta').textContent = state.config.llm?.apiKey
    ? `模型: ${state.config.llm.model}  ·  Base: ${trimBase(state.config.llm.baseURL)}`
    : '未配置模型 (前往"模型"页设置)';
}

function trimBase(url) {
  if (!url) return '';
  return url.replace(/^https?:\/\//, '').slice(0, 32);
}

function renderLLMForm() {
  const c = state.config.llm || {};
  $('llmBaseURL').value = c.baseURL || '';
  $('llmApiKey').value = c.apiKey || '';
  $('llmModel').value = c.model || '';
  $('llmTemp').value = c.temperature ?? 0.2;
  $('llmMaxTokens').value = c.maxTokens || 2048;
}

function renderDbList() {
  const list = $('dbList');
  const dbs = state.config.databases || [];
  if (!dbs.length) {
    list.innerHTML = '<div class="empty-block">暂无数据库, 点击右上角添加。</div>';
    return;
  }
  list.innerHTML = '';
  for (const db of dbs) {
    const item = document.createElement('div');
    item.className = 'db-item' + (db.id === state.config.activeDatabase ? ' active' : '');
    const sub = db.type === 'sqlite'
      ? `SQLite · ${db.database}`
      : `${db.type} · ${db.host || ''}:${db.port || ''} / ${db.database}`;
    item.innerHTML = `
      <div class="db-dot"></div>
      <div class="db-meta">
        <div class="db-name">${escapeHtml(db.name)}</div>
        <div class="db-sub">${escapeHtml(sub)}</div>
      </div>
      <div class="db-actions">
        ${db.id === state.config.activeDatabase
          ? '<span class="muted">当前使用</span>'
          : `<button class="btn" data-act="use">使用</button>`}
        <button class="btn btn-danger" data-act="del">删除</button>
      </div>
    `;
    item.querySelector('[data-act="use"]')?.addEventListener('click', async () => {
      await api.config.setActiveDatabase(db.id);
      state.config.activeDatabase = db.id;
      renderAll();
      toast('已切换到: ' + db.name);
    });
    item.querySelector('[data-act="del"]').addEventListener('click', async () => {
      if (!confirm(`确定删除数据库「${db.name}」?`)) return;
      await api.config.removeDatabase(db.id);
      state.config = await api.config.get();
      renderAll();
    });
    list.appendChild(item);
  }
}

function renderSkillList() {
  const list = $('skillList');
  api.skills.list().then((skills) => {
    if (!skills.length) {
      list.innerHTML = '<div class="empty-block">暂无技能, 点击"导入技能"选择一个目录。</div>';
      return;
    }
    list.innerHTML = '';
    for (const s of skills) {
      const item = document.createElement('div');
      item.className = 'skill-item';
      item.innerHTML = `
        <div class="skill-meta">
          <div class="skill-name">${escapeHtml(s.name)}<span class="skill-version">v${escapeHtml(s.version)}</span></div>
          <div class="skill-desc">${escapeHtml(s.description || '(无描述)')}</div>
        </div>
        <div class="skill-actions">
          <label class="switch">
            <input type="checkbox" ${s.enabled ? 'checked' : ''} data-name="${escapeAttr(s.name)}" />
            <span></span>
          </label>
        </div>
      `;
      const checkbox = item.querySelector('input');
      checkbox.addEventListener('change', async () => {
        await api.skills.toggle(s.name, checkbox.checked);
        toast((checkbox.checked ? '已启用' : '已禁用') + ' ' + s.name);
      });
      list.appendChild(item);
    }
  });
}

function renderChat() {
  const thread = $('chatThread');
  thread.innerHTML = '';
  if (!state.conversation.length) {
    thread.appendChild(emptyState());
    return;
  }
  const inner = document.createElement('div');
  inner.className = 'chat-thread-inner';
  for (const msg of state.conversation) {
    inner.appendChild(renderMessage(msg));
  }
  thread.appendChild(inner);
  thread.scrollTop = thread.scrollHeight;
}

function emptyState() {
  const el = document.createElement('div');
  el.className = 'empty-state';
  el.innerHTML = `
    <div class="empty-card">
      <h2>开始一次数据库分析</h2>
      <p>在下方输入你的任务, 智能体会自动规划 SQL、查询数据库并生成报告。</p>
      <div class="empty-tips">
        <div class="tip">示例: 统计近 30 天每天的订单数量与销售额</div>
        <div class="tip">示例: 找出销量最高的 10 个商品及其类目</div>
        <div class="tip">示例: 分析用户留存情况并生成周报</div>
      </div>
    </div>
  `;
  return el;
}

function renderMessage(msg) {
  const el = document.createElement('div');
  el.className = 'message ' + (msg.role === 'user' ? 'user' : 'assistant');
  const label = msg.role === 'user' ? 'USER' : 'ASSISTANT';
  const body = escapeHtml(msg.content || '');
  el.innerHTML = `<div class="msg-label">${label}</div><div class="msg-body">${body}</div>`;
  if (msg.steps && msg.steps.length) {
    const steps = document.createElement('div');
    steps.className = 'steps';
    for (const s of msg.steps) steps.appendChild(renderStep(s));
    el.appendChild(steps);
  }
  if (msg.report) {
    el.appendChild(renderReport(msg.report));
  }
  return el;
}

function renderStep(step) {
  const el = document.createElement('div');
  el.className = 'step';
  const tag = step.kind || 'step';
  const title = escapeHtml(step.title || step.message || tag);
  let html = `<div class="step-line">
    <span class="step-tag ${tag}">${tag.toUpperCase()}</span>
    <div class="step-content">
      <div class="step-title">${title}</div>`;
  if (step.sql) {
    html += `<div class="step-sql">${escapeHtml(step.sql)}</div>`;
  }
  if (step.table) {
    html += `<div class="step-meta">表: ${escapeHtml(step.table)}</div>`;
  }
  if (typeof step.rowCount === 'number') {
    html += `<div class="step-meta">${step.rowCount} 行 · ${step.elapsedMs} ms</div>`;
  }
  if (step.error) {
    html += `<div class="step-error">${escapeHtml(step.error)}</div>`;
  }
  if (step.message && step.kind && step.message !== step.title) {
    html += `<div class="step-meta">${escapeHtml(step.message)}</div>`;
  }
  html += `</div></div>`;
  el.innerHTML = html;
  return el;
}

function renderReport(report) {
  const el = document.createElement('div');
  el.className = 'report-card';
  const xlsxBtn = report.xlsxBase64
    ? `<button class="btn" data-act="export-xlsx">导出 Excel</button>`
    : '';
  el.innerHTML = `
    <div class="report-tabs">
      <button class="report-tab active" data-tab="html">HTML 预览</button>
      <button class="report-tab" data-tab="md">Markdown</button>
      <div class="report-actions">
        ${xlsxBtn}
        <button class="btn" data-act="export-html">导出 HTML</button>
        <button class="btn" data-act="export-md">导出 MD</button>
      </div>
    </div>
    <div class="report-body">
      <iframe data-pane="html" style="width:100%;height:420px;border:0;background:#fff;border-radius:8px;" srcdoc=""></iframe>
      <pre data-pane="md" class="report-md" style="display:none;"></pre>
    </div>
  `;
  const iframe = el.querySelector('iframe');
  iframe.srcdoc = report.html;
  const mdPre = el.querySelector('pre');
  mdPre.textContent = report.md;

  el.querySelectorAll('.report-tab').forEach((t) => {
    t.addEventListener('click', () => {
      el.querySelectorAll('.report-tab').forEach((x) => x.classList.toggle('active', x === t));
      const which = t.dataset.tab;
      el.querySelector('iframe').style.display = which === 'html' ? '' : 'none';
      el.querySelector('pre').style.display = which === 'md' ? '' : 'none';
    });
  });

  el.querySelector('[data-act="export-html"]')?.addEventListener('click', async () => {
    const res = await api.report.export({ html: report.html, md: report.md, baseName: report.title || 'solodb-report' });
    if (res.ok) toast('已导出: ' + res.filePath);
  });
  el.querySelector('[data-act="export-md"]')?.addEventListener('click', async () => {
    const res = await api.report.export({ html: report.html, md: report.md, baseName: report.title || 'solodb-report' });
    if (res.ok) toast('已导出: ' + res.filePath);
  });
  el.querySelector('[data-act="export-xlsx"]')?.addEventListener('click', async () => {
    const res = await api.report.exportXLSX({ base64: report.xlsxBase64, baseName: report.title || 'solodb-report' });
    if (res.ok) toast('Excel 已导出: ' + res.filePath);
  });
  return el;
}

// ============== LLM ==============
async function saveLLM() {
  const llm = {
    baseURL: $('llmBaseURL').value.trim() || 'https://api.openai.com/v1',
    apiKey: $('llmApiKey').value.trim(),
    model: $('llmModel').value.trim() || 'gpt-4o-mini',
    temperature: Number($('llmTemp').value) || 0.2,
    maxTokens: Number($('llmMaxTokens').value) || 2048
  };
  await api.config.setLLM(llm);
  state.config.llm = llm;
  const status = $('llmStatus');
  status.textContent = '已保存';
  status.className = 'form-status ok';
  renderTopDb();
  setTimeout(() => { status.textContent = ''; status.className = 'form-status'; }, 2000);
}

// ============== Database modal ==============
function openDbModal(prefill) {
  $('modalDb').hidden = false;
  $('dbName').value = prefill?.name || '';
  $('dbType').value = prefill?.type || 'mysql';
  $('dbHost').value = prefill?.host || '127.0.0.1';
  $('dbPort').value = prefill?.port || 3306;
  $('dbDatabase').value = prefill?.database || '';
  $('dbUser').value = prefill?.user || '';
  $('dbPassword').value = prefill?.password || '';
  $('dbSqlitePath').value = prefill?.type === 'sqlite' ? prefill.database : '';
  $('dbFormStatus').textContent = '';
  $('dbFormStatus').className = 'form-status';
  toggleDbFields();
}
function closeDbModal() {
  $('modalDb').hidden = true;
}
function toggleDbFields() {
  const t = $('dbType').value;
  $('dbNetGroup').style.display = t === 'sqlite' ? 'none' : '';
  $('dbDbNameGroup').style.display = t === 'sqlite' ? 'none' : '';
  $('dbUserGroup').style.display = t === 'sqlite' ? 'none' : '';
  $('dbSqliteGroup').hidden = t !== 'sqlite';
}
function readDbForm() {
  const type = $('dbType').value;
  const name = $('dbName').value.trim();
  if (!name) throw new Error('请填写显示名称');
  if (type === 'sqlite') {
    const path = $('dbSqlitePath').value.trim();
    if (!path) throw new Error('请填写 SQLite 文件路径');
    return { name, type, database: path };
  }
  return {
    name,
    type,
    host: $('dbHost').value.trim() || '127.0.0.1',
    port: Number($('dbPort').value) || undefined,
    database: $('dbDatabase').value.trim(),
    user: $('dbUser').value.trim(),
    password: $('dbPassword').value
  };
}
async function testDb() {
  const status = $('dbFormStatus');
  let cfg;
  try {
    cfg = readDbForm();
  } catch (e) {
    status.textContent = e.message;
    status.className = 'form-status err';
    return;
  }
  status.textContent = '正在测试连接...';
  status.className = 'form-status';
  try {
    const res = await api.db.test(cfg);
    if (res.ok) {
      status.textContent = `连接成功 · ${res.type} · ${res.version}`;
      status.className = 'form-status ok';
    } else {
      status.textContent = '连接失败: ' + res.error;
      status.className = 'form-status err';
    }
  } catch (e) {
    status.textContent = '调用失败: ' + e.message;
    status.className = 'form-status err';
  }
}
async function saveDb() {
  const status = $('dbFormStatus');
  let cfg;
  try {
    cfg = readDbForm();
  } catch (e) {
    status.textContent = e.message;
    status.className = 'form-status err';
    return;
  }
  status.textContent = '正在保存...';
  status.className = 'form-status';
  try {
    await api.config.addDatabase(cfg);
    state.config = await api.config.get();
    closeDbModal();
    renderAll();
    toast('已添加数据库: ' + cfg.name);
  } catch (e) {
    status.textContent = '保存失败: ' + e.message;
    status.className = 'form-status err';
  }
}

// ============== Skills ==============
async function importSkillDir() {
  const res = await api.skills.importDir();
  if (res.ok) {
    toast('技能文件夹导入成功');
    renderSkillList();
  } else if (res.error) {
    toast('导入失败: ' + res.error, 'err');
  }
}
async function importSkillFile() {
  const res = await api.skills.importFile();
  if (res.ok) {
    toast('技能文档导入成功');
    renderSkillList();
  } else if (res.error) {
    toast('导入失败: ' + res.error, 'err');
  }
}

// ============== Agent run ==============
async function sendTask() {
  const input = $('composerInput');
  const task = input.value.trim();
  if (!task) return;
  if (state.running) {
    toast('任务进行中, 请稍候', 'err');
    return;
  }
  if (!state.config.activeDatabase) {
    toast('请先在"数据库"页添加并选择数据库', 'err');
    return;
  }
  if (!state.config.llm?.apiKey) {
    toast('请先在"模型"页配置 API Key', 'err');
    return;
  }

  const userMsg = { role: 'user', content: task };
  const assistantMsg = { role: 'assistant', content: '正在规划任务...', steps: [] };
  state.conversation.push(userMsg, assistantMsg);
  input.value = '';
  renderChat();

  state.running = true;
  state.activeConversationId = 'c_' + Date.now();
  const result = await api.agent.run({
    task,
    conversationId: state.activeConversationId,
    history: state.conversation.filter((m) => m.role === 'user' || m.role === 'assistant').slice(0, -2)
  });
  state.running = false;

  if (!result.ok) {
    assistantMsg.content = '任务失败: ' + result.error;
    renderChat();
    toast('任务失败: ' + result.error, 'err');
    return;
  }
  // final result will be appended via events; in case event stream missed it, fallback:
  if (!assistantMsg.report) {
    assistantMsg.content = result.result.summary || '已完成';
    assistantMsg.report = {
      html: result.result.html,
      md: result.result.md,
      xlsxBase64: result.result.xlsxBase64,
      title: result.result.title,
      output: result.result.output
    };
    if (result.result.output === 'excel' && result.result.xlsxBase64) {
      setTimeout(async () => {
        const r = await api.report.exportXLSX({ base64: result.result.xlsxBase64, baseName: result.result.title || 'solodb-report' });
        if (r.ok) toast('Excel 已导出: ' + r.filePath);
      }, 200);
    }
    renderChat();
  }
}

function handleAgentEvent(ev) {
  if (!ev.conversationId || ev.conversationId !== state.activeConversationId) return;
  const last = state.conversation[state.conversation.length - 1];
  if (!last || last.role !== 'assistant') return;
  switch (ev.type) {
    case 'start':
      last.content = '智能体开始工作...';
      break;
    case 'phase':
      last.steps.push({
        kind: ev.phase,
        title: ev.message,
        sql: ev.sql,
        table: ev.table
      });
      break;
    case 'thought':
      // 不直接展示 thought, 已经通过 phase 展示
      break;
    case 'schema':
      last.steps.push({
        kind: 'schema',
        title: `加载了 ${ev.tables?.length || 0} 张表`,
        message: ev.schemaText?.split('\n').slice(0, 2).join(' / ')
      });
      break;
    case 'sql_result':
      // 找到最后一个 sql 步骤并填充结果
      for (let i = last.steps.length - 1; i >= 0; i--) {
        if (last.steps[i].kind === 'sql' && !last.steps[i].rowCount) {
          last.steps[i].rowCount = ev.rowCount;
          last.steps[i].elapsedMs = ev.elapsedMs;
          break;
        }
      }
      break;
    case 'sql_error':
      for (let i = last.steps.length - 1; i >= 0; i--) {
        if (last.steps[i].kind === 'sql' && !last.steps[i].error) {
          last.steps[i].error = ev.error;
          break;
        }
      }
      break;
    case 'describe_result':
      for (let i = last.steps.length - 1; i >= 0; i--) {
        if (last.steps[i].kind === 'describe' && !last.steps[i].rowCount) {
          last.steps[i].rowCount = ev.columns?.length || 0;
          break;
        }
      }
      break;
    case 'describe_error':
      for (let i = last.steps.length - 1; i >= 0; i--) {
        if (last.steps[i].kind === 'describe' && !last.steps[i].error) {
          last.steps[i].error = ev.error;
          break;
        }
      }
      break;
    case 'report':
      last.content = ev.title || '报告';
      last.report = { html: ev.html, md: ev.md, xlsxBase64: ev.xlsxBase64, title: ev.title, output: ev.output };
      if (ev.output === 'excel' && ev.xlsxBase64) {
        // 自动弹出 Excel 导出对话框
        setTimeout(async () => {
          const r = await api.report.exportXLSX({ base64: ev.xlsxBase64, baseName: ev.title || 'solodb-report' });
          if (r.ok) toast('Excel 已导出: ' + r.filePath);
        }, 200);
      }
      break;
    case 'error':
      last.content = (last.content || '') + '\n[错误] ' + ev.message;
      break;
  }
  renderChat();
}

// ============== Util ==============
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }

let toastTimer = null;
function toast(msg, level) {
  const el = $('toast');
  el.textContent = msg;
  el.style.background = level === 'err' ? '#b91c1c' : '#111827';
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

// ============== Checkpoints ==============
// 智能体在关键节点会把决策权交回给用户. 这里负责:
//   1. 监听主进程的 checkpoint 事件
//   2. 弹出对应的模态, 让用户确认 / 编辑 / 复制
//   3. 通过 respondCheckpoint 把结果回传给主进程

let currentCheckpoint = null; // { id, type, data, resolve }

function handleCheckpoint(cp) {
  // 只接受属于当前任务 conversationId 的 checkpoint
  if (!cp.conversationId || cp.conversationId !== state.activeConversationId) return;
  showCheckpointModal(cp);
}

function showCheckpointModal(cp) {
  currentCheckpoint = cp;
  const modal = $('modalCp');
  const title = $('cpTitle');
  const step = $('cpStep');
  const body = $('cpBody');
  const footer = $('cpFooter');

  // 重置
  body.innerHTML = '';
  footer.innerHTML = '';

  if (cp.type === 'tables') {
    title.textContent = '步骤 1: 选择数据表';
    step.textContent = `${cp.allTables.length} 张表`;
    renderTablesCp(body, footer, cp);
  } else if (cp.type === 'fields') {
    title.textContent = '步骤 2: 选择字段';
    const totalCols = Object.values(cp.fieldsByTable || {}).reduce((a, b) => a + b.length, 0);
    step.textContent = `${Object.keys(cp.fieldsByTable || {}).length} 张表 / ${totalCols} 列`;
    renderFieldsCp(body, footer, cp);
  } else if (cp.type === 'sql') {
    title.textContent = `步骤 3: 确认 SQL (第 ${cp.step} 步)`;
    step.textContent = 'SQL 预览';
    renderSqlCp(body, footer, cp);
  } else if (cp.type === 'output') {
    title.textContent = '步骤 4: 选择输出格式';
    step.textContent = '报告就绪';
    renderOutputCp(body, footer, cp);
  } else {
    title.textContent = '智能体等待确认';
    step.textContent = '';
    body.innerHTML = `<pre>${escapeHtml(JSON.stringify(cp, null, 2))}</pre>`;
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.textContent = '确认';
    btn.onclick = () => respondCheckpoint({ confirmed: true });
    footer.appendChild(btn);
  }

  modal.hidden = false;
}

function respondCheckpoint(data) {
  if (!currentCheckpoint) return;
  const id = currentCheckpoint.id;
  $('modalCp').hidden = true;
  currentCheckpoint = null;
  api.agent.respondCheckpoint(id, data);
}

// ---- 1. 表选择 ----
function renderTablesCp(body, footer, cp) {
  const msg = document.createElement('p');
  msg.className = 'cp-msg';
  msg.textContent = cp.message || '请选择智能体可访问的表';
  body.appendChild(msg);

  const all = cp.allTables || [];
  const suggested = Array.isArray(cp.suggested) ? cp.suggested : [];
  const suggestedNames = new Set(suggested.map((s) => s.name));
  const otherTables = all.filter((t) => !suggestedNames.has(t));
  const defaultSet = new Set(cp.defaultSelected || []);

  // AI 推荐区
  if (suggested.length) {
    const sec = document.createElement('div');
    sec.className = 'cp-ai-section';
    sec.innerHTML = `<div class="cp-ai-section-title">AI 匹配 <span class="cp-tag">TOP ${suggested.length}</span></div>`;
    for (const s of suggested) {
      const row = document.createElement('label');
      row.className = 'cp-suggest-row';
      const sc = s.score;
      const scoreCls = sc >= 0.7 ? 'cp-score-high' : (sc >= 0.4 ? 'cp-score-mid' : 'cp-score-low');
      const scoreText = (sc * 100).toFixed(0) + '%';
      const checked = defaultSet.has(s.name);
      row.innerHTML = `
        <input type="checkbox" data-table="${escapeAttr(s.name)}" ${checked ? 'checked' : ''} />
        <span class="cp-suggest-name">${escapeHtml(s.name)}</span>
        <span class="cp-score ${scoreCls}">${scoreText}</span>
        <span class="cp-suggest-reason" title="${escapeAttr(s.reason || '')}">${escapeHtml(s.reason || '')}</span>
      `;
      sec.appendChild(row);
    }
    body.appendChild(sec);
  }

  // 其它表 (折叠)
  if (otherTables.length) {
    const det = document.createElement('details');
    det.className = 'cp-other-section';
    const sum = document.createElement('summary');
    sum.textContent = `其它 ${otherTables.length} 张表 (点击展开)`;
    det.appendChild(sum);
    const list = document.createElement('div');
    list.className = 'cp-list';
    for (const t of otherTables) {
      const row = document.createElement('label');
      row.className = 'cp-suggest-row';
      row.innerHTML = `
        <input type="checkbox" data-table="${escapeAttr(t)}" />
        <span class="cp-suggest-name">${escapeHtml(t)}</span>
        <span class="cp-suggest-reason" style="text-align:right;">未参与 AI 评分</span>
      `;
      list.appendChild(row);
    }
    det.appendChild(list);
    body.appendChild(det);
  }

  // 提示词输入框
  const hint = makeHintBox({
    label: '补充提示词',
    placeholder: '可选: 调整表的关注点, 比如"再调研日志相关表"、"只看近 30 天数据"、"关注未支付订单"等'
  });
  body.appendChild(hint.el);

  // 取消 / 确认
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-ghost';
  cancelBtn.textContent = '取消任务';
  cancelBtn.onclick = () => respondCheckpoint({ cancelled: true });
  footer.appendChild(cancelBtn);

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'btn btn-primary';
  confirmBtn.textContent = '确认';
  confirmBtn.onclick = () => {
    const checked = [...body.querySelectorAll('input[data-table]:checked')].map((c) => c.dataset.table);
    if (!checked.length) {
      toast('请至少选择一张表', 'err');
      return;
    }
    respondCheckpoint({ tables: checked, hint: hint.value() });
  };
  footer.appendChild(confirmBtn);
}

// ---- 2. 字段选择 ----
function renderFieldsCp(body, footer, cp) {
  const msg = document.createElement('p');
  msg.className = 'cp-msg';
  msg.textContent = cp.message || '请勾选要暴露给智能体的字段';
  body.appendChild(msg);

  const fbt = cp.fieldsByTable || {};
  const fsel = JSON.parse(JSON.stringify(cp.fieldsSelected || {}));

  for (const table of Object.keys(fbt)) {
    const group = document.createElement('div');
    group.className = 'cp-table-group';
    const head = document.createElement('div');
    head.className = 'cp-table-name';
    head.innerHTML = `<span>${escapeHtml(table)}</span>
      <span class="cp-count">${fbt[table].length} 列 / 已选 ${(fsel[table] || []).length}</span>
      <span class="cp-actions-inline">
        <button class="btn" data-tbl="${escapeAttr(table)}" data-act="all">全选</button>
        <button class="btn" data-tbl="${escapeAttr(table)}" data-act="none">清空</button>
      </span>`;
    head.querySelector('[data-act="all"]').onclick = () => setTable(table, true);
    head.querySelector('[data-act="none"]').onclick = () => setTable(table, false);
    group.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'cp-fields';
    grid.dataset.table = table;
    for (const col of fbt[table]) {
      const lab = document.createElement('label');
      const checked = (fsel[table] || []).includes(col);
      lab.innerHTML = `<input type="checkbox" data-table="${escapeAttr(table)}" data-col="${escapeAttr(col)}" ${checked ? 'checked' : ''} />
                       <span>${escapeHtml(col)}</span>`;
      grid.appendChild(lab);
    }
    group.appendChild(grid);
    body.appendChild(group);
  }

  // 提示词输入框
  const hint = makeHintBox({
    label: '补充提示词',
    placeholder: '可选: 调整字段, 比如"补上 refund_at 字段"、"看看 status 的分布"、"加一列设备类型"等'
  });
  body.appendChild(hint.el);

  // 取消 / 确认
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-ghost';
  cancelBtn.textContent = '取消任务';
  cancelBtn.onclick = () => respondCheckpoint({ cancelled: true });
  footer.appendChild(cancelBtn);

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'btn btn-primary';
  confirmBtn.textContent = '确认';
  confirmBtn.onclick = () => {
    const out = {};
    body.querySelectorAll('.cp-fields').forEach((grid) => {
      const t = grid.dataset.table;
      out[t] = [...grid.querySelectorAll('input:checked')].map((c) => c.dataset.col);
    });
    respondCheckpoint({ fields: out, hint: hint.value() });
  };
  footer.appendChild(confirmBtn);

  function setTable(t, v) {
    const grid = body.querySelector(`.cp-fields[data-table="${CSS.escape(t)}"]`);
    if (!grid) return;
    grid.querySelectorAll('input').forEach((c) => { c.checked = v; });
  }
}

// 提示词输入框 (通用)
function makeHintBox({ label, placeholder }) {
  const wrap = document.createElement('div');
  wrap.className = 'cp-hint';
  const lab = document.createElement('div');
  lab.className = 'cp-hint-label';
  lab.innerHTML = `<span>${escapeHtml(label || '补充提示词')}</span>
    <span class="cp-hint-hint">— 将作为附加上下文传给 AI, 不会替换你的任务</span>`;
  const ta = document.createElement('textarea');
  ta.className = 'cp-hint-input';
  ta.placeholder = placeholder || '';
  ta.rows = 2;
  wrap.appendChild(lab);
  wrap.appendChild(ta);
  return { el: wrap, value: () => ta.value.trim() };
}

// ---- 3. SQL 预览 ----
function renderSqlCp(body, footer, cp) {
  const row = document.createElement('div');
  row.className = 'cp-sql-row';
  row.innerHTML = `<div class="cp-sql-title">${escapeHtml(cp.title || 'SQL')}</div>
    <div class="cp-actions-inline">
      <button class="btn" data-act="copy">复制</button>
      <button class="btn" data-act="edit">编辑</button>
    </div>`;
  body.appendChild(row);

  const pre = document.createElement('pre');
  pre.className = 'cp-sql-block';
  pre.textContent = cp.sql || '';
  body.appendChild(pre);

  let editing = false;
  let editedSql = cp.sql || '';
  const ta = document.createElement('textarea');
  ta.className = 'cp-sql-edit';
  ta.value = editedSql;
  ta.style.display = 'none';
  body.appendChild(ta);

  row.querySelector('[data-act="copy"]').onclick = async () => {
    try {
      await navigator.clipboard.writeText(cp.sql || '');
      toast('已复制到剪贴板');
    } catch (e) {
      toast('复制失败: ' + e.message, 'err');
    }
  };
  row.querySelector('[data-act="edit"]').onclick = () => {
    editing = !editing;
    if (editing) {
      pre.style.display = 'none';
      ta.style.display = '';
      ta.value = cp.sql || '';
      row.querySelector('[data-act="edit"]').textContent = '取消编辑';
    } else {
      pre.style.display = '';
      ta.style.display = 'none';
      row.querySelector('[data-act="edit"]').textContent = '编辑';
    }
  };

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-ghost';
  cancelBtn.textContent = '取消任务';
  cancelBtn.onclick = () => respondCheckpoint({ cancelled: true });
  footer.appendChild(cancelBtn);

  const skipBtn = document.createElement('button');
  skipBtn.className = 'btn';
  skipBtn.textContent = '跳过本步';
  skipBtn.onclick = () => respondCheckpoint({ skip: true });
  footer.appendChild(skipBtn);

  const runBtn = document.createElement('button');
  runBtn.className = 'btn btn-primary';
  runBtn.textContent = '执行';
  runBtn.onclick = () => {
    const sql = editing ? ta.value.trim() : cp.sql;
    if (!sql) {
      toast('SQL 不能为空', 'err');
      return;
    }
    respondCheckpoint({ sql, confirmed: true });
  };
  footer.appendChild(runBtn);
}

// ---- 4. 输出格式 ----
function renderOutputCp(body, footer, cp) {
  const msg = document.createElement('p');
  msg.className = 'cp-msg';
  msg.textContent = cp.message || '请选择输出格式';
  body.appendChild(msg);

  const group = document.createElement('div');
  group.className = 'cp-radio-group';
  const opts = [
    { v: 'excel', title: 'Excel 表格 (.xlsx)', sub: '每个 SQL 结果作为一个 sheet, 包含总览页' },
    { v: 'html',  title: 'HTML 报告',          sub: '带样式的网页, 可在浏览器中查看或打印' },
    { v: 'none',  title: '不需要输出',          sub: '仅在对话中显示总结, 不生成文件' }
  ];
  let selected = 'none';
  for (const o of opts) {
    const lab = document.createElement('label');
    lab.className = 'cp-radio';
    lab.dataset.value = o.v;
    lab.innerHTML = `<input type="radio" name="cpOut" value="${o.v}" ${o.v === selected ? 'checked' : ''}/>
      <div class="cp-radio-body">
        <div class="cp-radio-title">${escapeHtml(o.title)}</div>
        <div class="cp-radio-sub">${escapeHtml(o.sub)}</div>
      </div>`;
    lab.onclick = () => {
      selected = o.v;
      group.querySelectorAll('.cp-radio').forEach((r) => r.classList.toggle('selected', r.dataset.value === selected));
    };
    if (o.v === selected) lab.classList.add('selected');
    group.appendChild(lab);
  }
  body.appendChild(group);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-ghost';
  cancelBtn.textContent = '取消任务';
  cancelBtn.onclick = () => respondCheckpoint({ cancelled: true });
  footer.appendChild(cancelBtn);

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'btn btn-primary';
  confirmBtn.textContent = '确认';
  confirmBtn.onclick = () => respondCheckpoint({ output: selected });
  footer.appendChild(confirmBtn);
}
