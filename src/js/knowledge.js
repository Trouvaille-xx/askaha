/**
 * 知识库 / RAG 前端 (「知识库」页 + 「配置 · 知识库配置」+ 问答飞轮)。
 *
 * 依赖 app.js 里的全局辅助: $ $$ icon escapeHtml toast askConfirm switchView。
 * 本文件在 app.js **之后**加载, 这些届时都已定义。
 *
 * 三级结构: 知识库 > 文件夹 > 文档。
 * 检索只在单个知识库内 —— 所以左侧树的选中态决定"这个知识库", 文件夹只影响筛选。
 */

'use strict';

const kbState = {
  tab: 'manage',           // manage | qa
  view: 'list',            // list(知识库列表) | kb(库内: 文件夹 + 文档) | folder(文件夹内)
  kbs: [],
  activeKbId: null,
  activeFolderId: null,
  docs: [],
  kbQuery: '', kbPage: 1,     // 知识库列表的搜索与分页
  docQuery: '', docPage: 1,   // 库内 / 文件夹内的搜索与分页
  importing: false,
  presets: null,
  config: null,
  qa: { rows: [], total: 0, filter: { feedback: '', from: '', to: '', q: '' } },
  fb: null,                // 正在填反馈的问答对象
  importProgress: new Map() // docId -> 进度百分比 (0-100); 导入中的文档靠它画圆环
};

const KB_PAGE = 10;   // 每页条数 (列表 / 文档共用)

/**
 * 导入的四个步骤。进度 = **每一步等分 100%**:
 *   识别(parse) 0% → 分块(chunk) 25% → 向量化(embed) 50% → 写入(store) 75% → 完成 100%
 * (向量化那步内部可能分很多批, 但按"步骤等分"的口径只算 25%, 不做批次细分 —— 这是需求。)
 */
const KB_IMPORT_STEPS = ['parse', 'chunk', 'embed', 'store'];
function kbPhasePct(phase, kind) {
  if (kind === 'done') return 100;
  const i = KB_IMPORT_STEPS.indexOf(phase);
  return i < 0 ? 0 : Math.round((i / KB_IMPORT_STEPS.length) * 100);
}

/** 圆形进度环 (行尾用) */
function kbRing(pct) {
  const r = 11;
  const c = 2 * Math.PI * r;
  const off = c * (1 - Math.max(0, Math.min(100, pct)) / 100);
  return `<span class="kb-ring" title="处理中 ${pct}%">`
    + `<svg viewBox="0 0 26 26" aria-hidden="true">`
    + `<circle class="kb-ring-track" cx="13" cy="13" r="${r}"/>`
    + `<circle class="kb-ring-fill" cx="13" cy="13" r="${r}" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/>`
    + `</svg><span class="kb-ring-pct">${pct}</span></span>`;
}

/* ==================== 小工具 ==================== */

function kbEsc(s) { return (typeof escapeHtml === 'function') ? escapeHtml(String(s == null ? '' : s)) : String(s == null ? '' : s); }

function kbTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const KB_TYPE_LABEL = { md: 'MD', txt: 'TXT', docx: 'Word', pdf: 'PDF', richtext: '富文本', qa: '问答对' };
const KB_STATUS = {
  ready: { label: '已就绪', cls: 'ok' },
  processing: { label: '处理中', cls: 'warn' },
  failed: { label: '失败', cls: 'err' },
  pending: { label: '待处理', cls: 'muted' }
};

/** 眼 / 详情 图标 */
const KB_ICON_EYE = '<svg class="ic" viewBox="0 0 16 16"><path d="M1.6 8s2.4-4.3 6.4-4.3S14.4 8 14.4 8 12 12.3 8 12.3 1.6 8 1.6 8z"/><circle cx="8" cy="8" r="1.9"/></svg>';
/** 文件夹图标 (库内列表里区分"文件夹"行与"文档"行) */
const KB_ICON_FOLDER = '<svg class="kb-ico-svg" viewBox="0 0 16 16"><path d="M1.9 12.6V3.8a.9.9 0 0 1 .9-.9h3.2l1.5 1.7h5.7a.9.9 0 0 1 .9.9v7.1a.9.9 0 0 1-.9.9H2.8a.9.9 0 0 1-.9-.9z"/></svg>';
/** 知识库图标 */
const KB_ICON_BOOK = '<svg class="kb-ico-svg" viewBox="0 0 16 16"><path d="M3.1 3.4h3.8a1.7 1.7 0 0 1 1.1.5 1.7 1.7 0 0 1 1.1-.5h3.8v8.6H8.6a1.4 1.4 0 0 0-1.4 1.1 1.4 1.4 0 0 0-1.4-1.1H3.1z"/><path d="M8 3.9v9.2"/></svg>';
/** 文档图标 */
const KB_ICON_FILE = '<svg class="kb-ico-svg" viewBox="0 0 16 16"><path d="M3.4 2.6h5.3l3.9 3.9v6.9a.9.9 0 0 1-.9.9H3.4a.9.9 0 0 1-.9-.9V3.5a.9.9 0 0 1 .9-.9z"/><path d="M8.7 2.6v3.9h3.9"/></svg>';
/** 重试 (重新处理) 图标: 一个回转箭头 */
const KB_ICON_RETRY = '<svg class="ic" viewBox="0 0 16 16"><path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13.2 2.6v3h-3"/></svg>';

/**
 * 知识库图标的 16 种配色。
 * 取的都是 600 档 (中等饱和), 配白图标对比够、又不像 400 档那样发飘 —— 用户要的是"别太浅"。
 * 顺序刻意打散色相 (不是简单按彩虹排), 相邻两个库的颜色拉开, 一眼能区分。
 */
const KB_COLORS = [
  '#4f46e5', // 靛蓝
  '#ea580c', // 橙
  '#0d9488', // 青绿
  '#9333ea', // 紫
  '#16a34a', // 绿
  '#dc2626', // 红
  '#0284c7', // 天蓝
  '#ca8a04', // 琥珀
  '#c026d3', // 品红
  '#059669', // 翠绿
  '#7c3aed', // 紫罗兰
  '#db2777', // 玫红
  '#0891b2', // 青
  '#65a30d', // 橄榄
  '#475569', // 石板灰
  '#b45309'  // 棕橙
];

/**
 * 给知识库分配颜色: 按 **创建时间** 排序后的下标取色。
 *
 * 为什么不用 id 哈希: 哈希会让两个库撞到同一个颜色 (实测 16 个 id 只落到 13 色)。
 * 按创建时间排的下标则保证"前 16 个库两两不同", 而且颜色**跟着库走** ——
 * 之后编辑/改名的库不会换色 (创建时间不变; updatedAt 变了只影响列表排序, 不影响取色)。
 * 超过 16 个库才回绕复用。
 */
function kbColorMap() {
  const map = new Map();
  const sorted = (kbState.kbs || []).slice()
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  sorted.forEach((k, i) => map.set(k.id, KB_COLORS[i % KB_COLORS.length]));
  return map;
}

/* ==================== 入口 ==================== */

async function initKnowledgeView() {
  if (!kbState._bound) {
    kbState._bound = true;
    bindKnowledgeUI();
    if (window.bridge && api.knowledge && api.knowledge.onImportEvent) {
      api.knowledge.onImportEvent(onKbImportEvent);
    }
  }
  renderKbTabs();
  await loadKbs();
  if (kbState.tab === 'qa') await renderQaPanel();
}

function bindKnowledgeUI() {
  // 页签: 知识库管理 / 问答管理
  $$('#kbTabs [data-kbtab]').forEach((b) => b.addEventListener('click', async () => {
    kbState.tab = b.dataset.kbtab;
    renderKbTabs();
    if (kbState.tab === 'qa') await renderQaPanel();
  }));

  // 新建知识库
  $$('#modalNewKb [data-close]').forEach((el) => el.addEventListener('click', () => { $('modalNewKb').hidden = true; }));
  $('kbNewOk').addEventListener('click', submitNewKb);

  // 编辑知识库
  $$('#modalEditKb [data-close]').forEach((el) => el.addEventListener('click', () => { $('modalEditKb').hidden = true; }));
  $('kbEditOk').addEventListener('click', saveEditKb);

  // 新建文件夹
  $$('#modalNewFolder [data-close]').forEach((el) => el.addEventListener('click', () => { $('modalNewFolder').hidden = true; }));
  $('kbFolderOk').addEventListener('click', submitNewFolder);
  $('kbFolderName').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitNewFolder(); });

  // 导入
  $$('#modalKbImport [data-close]').forEach((el) => el.addEventListener('click', () => { $('modalKbImport').hidden = true; }));
  $$('#kbImportModes [data-imp]').forEach((b) => b.addEventListener('click', () => {
    $$('#kbImportModes [data-imp]').forEach((x) => x.classList.toggle('active', x === b));
    const m = b.dataset.imp;
    $('kbImpFilePane').hidden = m !== 'file';
    $('kbImpRichPane').hidden = m !== 'richtext';
    $('kbImpQaPane').hidden = m !== 'qa';
    kbState.importMode = m;
  }));
  kbState.importMode = 'file';
  $('kbImpPick').addEventListener('click', pickImportFiles);
  $('kbImpQaAdd').addEventListener('click', addQaPair);
  $('kbImpOk').addEventListener('click', submitImport);

  // 文档详情 / AI 分析 / 问答详情
  $$('#modalDocDetail [data-close]').forEach((el) => el.addEventListener('click', () => { $('modalDocDetail').hidden = true; }));
  $$('#modalQaAnalyze [data-close]').forEach((el) => el.addEventListener('click', () => { $('modalQaAnalyze').hidden = true; }));
  $$('#modalQaDetail [data-close]').forEach((el) => el.addEventListener('click', () => { $('modalQaDetail').hidden = true; }));

  // 反馈弹窗的按钮**不在这里绑** —— 它从对话页的 👎 触发, 那时用户可能还没进过
  // 「知识库」页 (initKnowledgeView 没跑过)。见文件底部 bindFeedbackModalEarly()。

  // 配置保存
  $('btnKbCfgSave').addEventListener('click', saveKbConfig);
}

/* ==================== 知识库管理 ==================== */

async function loadKbs() {
  try { kbState.kbs = await api.knowledge.listKbs() || []; }
  catch (e) { kbState.kbs = []; }
  // 当前打开的库没了 (被删 / 找不到) → 退回列表层
  if (kbState.activeKbId && !kbState.kbs.some((k) => k.id === kbState.activeKbId)) {
    kbState.activeKbId = null; kbState.activeFolderId = null; kbState.view = 'list';
  }
  // 对话页那个知识库选择器跟着刷新 (新建/删除/改名后它要同步)
  if (window.renderKbPick) window.renderKbPick();
  await loadDocs();
}

async function loadDocs() {
  if (kbState.activeKbId && kbState.view !== 'list') {
    try { kbState.docs = await api.knowledge.listDocs({ kbId: kbState.activeKbId }) || []; }
    catch (e) { kbState.docs = []; }
  } else {
    kbState.docs = [];
  }
  renderKbPanel();
}

function currentKb() { return kbState.kbs.find((k) => k.id === kbState.activeKbId) || null; }

/* ---- 三层下钻: 知识库列表 → 库内(文件夹+文档) → 文件夹内 ---- */

function gotoList() { kbState.view = 'list'; kbState.activeFolderId = null; kbState.kbQuery = ''; kbState.kbPage = 1; renderKbPanel(); }
async function enterKb(id) {
  if (!id) return;
  kbState.view = 'kb'; kbState.activeKbId = id; kbState.activeFolderId = null;
  kbState.docQuery = ''; kbState.docPage = 1;
  await loadDocs();
}
function enterFolder(id) { kbState.view = 'folder'; kbState.activeFolderId = id; kbState.docQuery = ''; kbState.docPage = 1; renderKbPanel(); }

/** 三块一起刷 (页签动作 / 面包屑+搜索 / 表格) */
function renderKbPanel() { renderKbTabs(); renderKbHead(); renderKbTable(); }

/* ---- 分页 ---- */

function kbPaginate(rows, page) {
  const totalPages = Math.max(1, Math.ceil(rows.length / KB_PAGE));
  const p = Math.min(Math.max(1, page || 1), totalPages);
  return { page: p, totalPages, slice: rows.slice((p - 1) * KB_PAGE, p * KB_PAGE) };
}
function kbPagerHtml(page, totalPages, total) {
  if (totalPages <= 1) return '';
  return `<div class="kb-pager">
    <span class="kb-pager-info">共 ${total} 条 · 第 ${page}/${totalPages} 页</span>
    <button class="btn btn-sm" data-pg="prev"${page <= 1 ? ' disabled' : ''}>上一页</button>
    <button class="btn btn-sm" data-pg="next"${page >= totalPages ? ' disabled' : ''}>下一页</button>
  </div>`;
}
function kbBindPager(box, getPage, setPage) {
  box.querySelectorAll('[data-pg]').forEach((b) => b.addEventListener('click', () => {
    setPage(getPage() + (b.dataset.pg === 'next' ? 1 : -1));
  }));
}

function renderKbTabs() {
  $$('#kbTabs [data-kbtab]').forEach((b) => b.classList.toggle('active', b.dataset.kbtab === kbState.tab));
  $('kbPanel').hidden = kbState.tab !== 'manage';
  $('qaPanel').hidden = kbState.tab !== 'qa';
  // 右上动作随"在哪一层"变 —— 行内动作在每行末尾, 这里的都是这一层的顶层动作
  const act = $('kbActions');
  if (kbState.tab !== 'manage') { act.innerHTML = ''; return; }
  if (kbState.view === 'list') {
    act.innerHTML = '<button class="btn btn-primary" id="btnKbNew">新建知识库</button>';
    $('btnKbNew').addEventListener('click', openNewKbModal);
  } else if (kbState.view === 'kb') {
    act.innerHTML = '<button class="btn" id="btnKbNewFolder">新建文件夹</button>'
      + '<button class="btn btn-primary" id="btnKbImport">新建文档</button>';
    $('btnKbNewFolder').addEventListener('click', openNewFolderModal);
    $('btnKbImport').addEventListener('click', openImportModal);
  } else {
    act.innerHTML = '<button class="btn btn-primary" id="btnKbImport">新建文档</button>';
    $('btnKbImport').addEventListener('click', openImportModal);
  }
}

/** 面包屑 + 搜索框。搜索的语义随层级变 (列表层搜知识库, 库内/文件夹内搜名称)。 */
function renderKbHead() {
  const box = $('kbMainHead');
  if (!box) return;
  const kb = currentKb();
  let crumb = '<span class="kb-crumb-link" data-nav="list">知识库</span>';
  if (kbState.view !== 'list' && kb) {
    crumb += '<span class="kb-crumb-sep">›</span>'
      + (kbState.view === 'folder'
        ? `<span class="kb-crumb-link" data-nav="kb">${kbEsc(kb.name)}</span>`
        : `<span class="kb-crumb-cur">${kbEsc(kb.name)}</span>`);
  }
  if (kbState.view === 'folder') {
    const f = (kb.folders || []).find((x) => x.id === kbState.activeFolderId);
    crumb += '<span class="kb-crumb-sep">›</span><span class="kb-crumb-cur">' + kbEsc(f ? f.name : '') + '</span>';
  }
  const isList = kbState.view === 'list';
  const val = isList ? kbState.kbQuery : kbState.docQuery;
  box.innerHTML = `<div class="kb-crumb">${crumb}</div>`
    + `<input class="kb-doc-search field-input" id="kbDocSearch" placeholder="${isList ? '搜索知识库' : '搜索名称'}" value="${kbEsc(val)}" />`;
  box.querySelectorAll('[data-nav]').forEach((el) => el.addEventListener('click', () => {
    if (el.dataset.nav === 'list') gotoList();
    else enterKb(kbState.activeKbId);
  }));
  const s = $('kbDocSearch');
  s.addEventListener('input', () => {
    if (isList) { kbState.kbQuery = s.value; kbState.kbPage = 1; }
    else { kbState.docQuery = s.value; kbState.docPage = 1; }
    renderKbTable();
  });
}

function renderKbTable() {
  const box = $('kbTableWrap');
  if (!box) return;
  if (kbState.view === 'list') return renderKbListTable(box);
  return renderItemsTable(box);
}

/* ---- 第一层: 知识库列表 ---- */
function renderKbListTable(box) {
  const q = kbState.kbQuery.trim().toLowerCase();
  const rows = q ? kbState.kbs.filter((k) => (k.name || '').toLowerCase().includes(q)) : kbState.kbs;
  if (!rows.length) {
    box.innerHTML = `<div class="kb-empty">${kbState.kbs.length ? '没有匹配的知识库。' : '还没有知识库。点右上角「新建知识库」开始。'}</div>`;
    return;
  }
  const pg = kbPaginate(rows, kbState.kbPage);
  kbState.kbPage = pg.page;
  const colors = kbColorMap();
  box.innerHTML = `
    <table class="kb-table">
      <thead><tr>
        <th class="kb-col-name">知识库</th><th class="kb-col-num">文件夹</th><th class="kb-col-num">文档</th>
        <th class="kb-col-num">分块</th><th>更新时间</th><th class="kb-col-act">操作</th>
      </tr></thead>
      <tbody>${pg.slice.map((k) => `<tr data-kbrow="${k.id}" class="kb-row-link">
        <td class="kb-col-name"><span class="kb-name-cell"><span class="kb-ico kb-ico-kb" style="background:${colors.get(k.id)};color:#fff">${KB_ICON_BOOK}</span><span class="kb-name-text">${kbEsc(k.name)}</span></span></td>
        <td class="kb-col-num">${(k.folders || []).length || k.folderCount || 0}</td>
        <td class="kb-col-num">${k.docCount || 0}</td>
        <td class="kb-col-num">${k.chunkTotal || 0}</td>
        <td>${kbEsc(kbTime(k.updatedAt))}</td>
        <td class="kb-col-act">
          <button class="btn-icon kb-act" data-kbact="edit" title="编辑">${icon('pencil')}</button>
          <button class="btn-icon kb-act kb-act-del" data-kbact="del" title="删除">${icon('trash')}</button>
        </td></tr>`).join('')}</tbody>
    </table>${kbPagerHtml(pg.page, pg.totalPages, rows.length)}`;
  box.querySelectorAll('tr[data-kbrow]').forEach((tr) => {
    const id = tr.dataset.kbrow;
    tr.addEventListener('click', (e) => { if (e.target.closest('[data-kbact]')) return; enterKb(id); });
    tr.querySelector('[data-kbact="edit"]').addEventListener('click', () => { kbState.activeKbId = id; openEditKbModal(); });
    tr.querySelector('[data-kbact="del"]').addEventListener('click', () => { kbState.activeKbId = id; deleteKb(); });
  });
  kbBindPager(box, () => kbState.kbPage, (p) => { kbState.kbPage = p; renderKbTable(); });
}

/* ---- 第二/三层: 库内 (文件夹行 + 文档行) / 文件夹内 (文档行) ---- */
function renderItemsTable(box) {
  const kb = currentKb();
  if (!kb) { box.innerHTML = '<div class="kb-empty">知识库不存在。</div>'; return; }
  const folders = kb.folders || [];
  const inFolder = kbState.view === 'folder';
  const q = kbState.docQuery.trim().toLowerCase();

  // 行 = 文件夹行 (仅库内) + 文档行。文件夹排在文档前面。
  let items = [];
  if (!inFolder) {
    const fol = q ? folders.filter((f) => (f.name || '').toLowerCase().includes(q)) : folders;
    items = fol.map((f) => ({
      kind: 'folder', id: f.id, name: f.name, createdAt: f.createdAt,
      docCount: kbState.docs.filter((d) => (d.folderId || null) === f.id).length
    }));
  }
  const docRows = kbState.docs.filter((d) => inFolder ? (d.folderId || null) === kbState.activeFolderId : true);
  const docFiltered = q ? docRows.filter((d) => (d.name || '').toLowerCase().includes(q)) : docRows;
  items = items.concat(docFiltered.map((d) => ({ kind: 'doc', doc: d })));

  if (!items.length) {
    box.innerHTML = `<div class="kb-empty">${inFolder ? '这个文件夹里还没有文档。' : (folders.length || kbState.docs.length ? '没有匹配的内容。' : '还没有内容。点右上角「新建文件夹」或「新建文档」。')}</div>`;
    return;
  }
  const pg = kbPaginate(items, kbState.docPage);
  kbState.docPage = pg.page;
  const folderNames = new Map(folders.map((f) => [f.id, f.name]));
  const body = pg.slice.map((it) => {
    if (it.kind === 'folder') {
      return `<tr data-folderrow="${it.id}" class="kb-row-link">
        <td class="kb-col-name"><span class="kb-name-cell"><span class="kb-ico kb-ico-fol">${KB_ICON_FOLDER}</span><span class="kb-name-text">${kbEsc(it.name)}</span></span></td>
        <td>文件夹</td><td>—</td><td>—</td>
        <td class="kb-col-num">${it.docCount}</td>
        <td>${kbEsc(kbTime(it.createdAt))}</td>
        <td class="kb-col-act"><button class="btn-icon kb-act kb-act-del" data-fact="del" title="删除文件夹">${icon('trash')}</button></td>
      </tr>`;
    }
    const d = it.doc;
    const st = KB_STATUS[d.status] || KB_STATUS.pending;
    const prog = kbState.importProgress.get(d.id);
    const importing = prog != null;
    return `<tr data-doc="${d.id}">
      <td class="kb-col-name"><span class="kb-name-cell"><span class="kb-ico kb-ico-doc">${KB_ICON_FILE}</span><span class="kb-name-text" title="${kbEsc(d.name)}">${kbEsc(d.name)}</span></span></td>
      <td>${kbEsc(KB_TYPE_LABEL[d.type] || d.type)}</td>
      <td>${kbEsc(d.folderId ? (folderNames.get(d.folderId) || '') : '—')}</td>
      <td>${importing ? '<span class="kb-chip kb-chip-warn">处理中</span>' : `<span class="kb-chip kb-chip-${st.cls}">${st.label}</span>${d.status === 'failed' && d.error ? `<div class="kb-doc-reason" title="${kbEsc(d.error)}">${kbEsc(d.error)}</div>` : ''}`}</td>
      <td class="kb-col-num">${d.chunkCount || 0}</td>
      <td>${kbEsc(kbTime(d.updatedAt))}</td>
      <td class="kb-col-act">${importing ? kbRing(prog) : `
        ${d.status === 'failed' ? `<button class="btn-icon kb-act" data-act="retry" title="重新处理">${KB_ICON_RETRY}</button>` : ''}
        <button class="btn-icon kb-act" data-act="detail" title="详情">${KB_ICON_EYE}</button>
        <button class="btn-icon kb-act kb-act-del" data-act="del" title="删除">${icon('trash')}</button>`}</td></tr>`;
  }).join('');
  box.innerHTML = `
    <table class="kb-table">
      <thead><tr>
        <th class="kb-col-name">名称</th><th>类型</th><th>分类</th>
        <th>状态</th><th class="kb-col-num">分块数</th><th>更新时间</th><th class="kb-col-act">操作</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>${kbPagerHtml(pg.page, pg.totalPages, items.length)}`;
  box.querySelectorAll('tr[data-folderrow]').forEach((tr) => {
    const id = tr.dataset.folderrow;
    tr.addEventListener('click', (e) => { if (e.target.closest('[data-fact]')) return; enterFolder(id); });
    tr.querySelector('[data-fact="del"]').addEventListener('click', () => deleteFolder(id));
  });
  box.querySelectorAll('tr[data-doc]').forEach((tr) => {
    const doc = kbState.docs.find((d) => d.id === tr.dataset.doc);
    const retry = tr.querySelector('[data-act="retry"]');
    if (retry) retry.addEventListener('click', () => reingestDoc(doc));
    const detail = tr.querySelector('[data-act="detail"]');
    if (detail) detail.addEventListener('click', () => openDocDetail(doc));
    const del = tr.querySelector('[data-act="del"]');
    if (del) del.addEventListener('click', () => deleteDoc(doc));
  });
  kbBindPager(box, () => kbState.docPage, (p) => { kbState.docPage = p; renderKbTable(); });
}

/* ---- 新建 / 重命名 / 删除知识库 ---- */

async function openNewKbModal() {
  // 向量模型 / 分块策略都在「配置 · 知识库」里配 —— 这里只收名字和说明。
  $('kbNewName').value = '';
  $('kbNewDesc').value = '';
  $('modalNewKb').hidden = false;
}

async function submitNewKb() {
  const name = $('kbNewName').value.trim();
  if (!name) return toast('请填知识库名称', 'err');
  const r = await api.knowledge.createKb({ name, desc: $('kbNewDesc').value.trim() });
  if (!r || !r.ok) return toast('创建失败: ' + ((r && r.error) || '未知错误'), 'err');
  $('modalNewKb').hidden = true;
  toast('知识库已创建');
  await loadKbs();            // 先把新库拉进列表
  await enterKb(r.kb.id);     // 直接进入它
}

/** 编辑知识库信息 (名称 / 说明) —— 原来的"重命名"升级成它 */
function openEditKbModal() {
  const kb = currentKb();
  if (!kb) return;
  $('kbEditName').value = kb.name || '';
  $('kbEditDesc').value = kb.desc || '';
  $('modalEditKb').hidden = false;
}

async function saveEditKb() {
  const kb = currentKb();
  if (!kb) return;
  const name = $('kbEditName').value.trim();
  if (!name) return toast('名称不能为空', 'err');
  const r = await api.knowledge.updateKb({ id: kb.id, patch: { name, desc: $('kbEditDesc').value.trim() } });
  if (r && r.ok) { $('modalEditKb').hidden = true; toast('已保存'); await loadKbs(); if (window.renderKbPick) window.renderKbPick(); }
  else toast('保存失败: ' + ((r && r.error) || ''), 'err');
}

async function deleteKb() {
  const kb = currentKb();
  if (!kb) return;
  const ok = await askConfirm({ title: '删除知识库?', message: `删除「${kb.name}」?`, detail: '它下面的文档、分块、向量都会被一起删掉, 找不回来。', okText: '删除', tone: 'danger' });
  if (!ok) return;
  const r = await api.knowledge.deleteKb(kb.id);
  if (r && r.ok) { kbState.activeKbId = null; kbState.activeFolderId = null; kbState.view = 'list'; toast('已删除'); await loadKbs(); }
  else toast('删除失败', 'err');
}

/** 删除文件夹 (里面的文档不删, 上浮到知识库根) */
async function deleteFolder(folderId) {  const kb = currentKb();
  if (!kb || !folderId) return;
  const ok = await askConfirm({ title: '删除文件夹?', message: '确定删除这个文件夹?', detail: '文件夹里的文档不会被删除, 会上浮到知识库根目录。', okText: '删除', tone: 'danger' });
  if (!ok) return;
  const r = await api.knowledge.deleteFolder({ kbId: kb.id, folderId });
  if (r && r.ok) { toast('已删除'); await loadKbs(); }
  else toast('删除失败: ' + ((r && r.error) || ''), 'err');
}

/**
 * 新建文件夹。
 * 这里原来用 window.prompt() 收名字 —— 但 **Electron 的渲染进程不实现 prompt()**,
 * 调用会直接抛 "prompt() is and will not be supported"。整个项目其它地方也都是
 * 自建小弹窗来替代 (见 app.js 的 openRenameModal), 这里照做。
 */
function openNewFolderModal() {
  if (!currentKb()) return;
  $('kbFolderName').value = '';
  $('modalNewFolder').hidden = false;
  $('kbFolderName').focus();
}

async function submitNewFolder() {
  const kb = currentKb();
  if (!kb) return;
  const name = $('kbFolderName').value.trim();
  if (!name) return toast('请填文件夹名称', 'err');
  const r = await api.knowledge.createFolder({ kbId: kb.id, name });
  if (r && r.ok) { $('modalNewFolder').hidden = true; toast('文件夹已创建'); await loadKbs(); }
  else toast('创建失败: ' + ((r && r.error) || ''), 'err');
}

/**
 * 重新处理一个文档 (用导入时留档的来源重跑)。
 * 典型场景: 导入时还没配向量模型 → 失败; 配好模型后点一下重跑, 不用重传文件。
 */
async function reingestDoc(doc) {
  const kb = currentKb();
  if (!doc || !kb) return;
  const bar = $('kbImportBar');
  if (bar) { bar.hidden = false; bar.textContent = '正在重新处理: ' + doc.name; }
  let r;
  try { r = await api.knowledge.reingest({ kbId: kb.id, docId: doc.id }); }
  catch (e) { r = { ok: false, error: e.message }; }
  await loadKbs();
  if (bar) bar.hidden = true;
  if (r && r.ok) toast('已重新处理: ' + (r.chunkCount || 0) + ' 个分块');
  else toast('重新处理失败: ' + ((r && r.error) || '未知错误'), 'err');
}

/* ---- 导入 ---- */

function openImportModal() {
  const kb = currentKb();
  if (!kb) return toast('先进入一个知识库再新建文档', 'err');
  // 明确告诉用户会创建到哪个库、哪个文件夹, 并允许在弹窗里改文件夹
  // (否则"新建"到底落在哪, 只能靠"我现在在哪个层级"去猜)
  $('kbDestKb').textContent = kb.name;
  const sel = $('kbDestFolder');
  sel.innerHTML = '<option value="">根目录 (不放进文件夹)</option>'
    + (kb.folders || []).map((f) => `<option value="${f.id}">${kbEsc(f.name)}</option>`).join('');
  sel.value = kbState.activeFolderId || '';   // 默认: 当前所在文件夹

  kbState.importFiles = [];
  kbState.qaPairs = [];
  // 回到"文件"模式
  kbState.importMode = 'file';
  $$('#kbImportModes [data-imp]').forEach((x) => x.classList.toggle('active', x.dataset.imp === 'file'));
  $('kbImpFilePane').hidden = false;
  $('kbImpRichPane').hidden = true;
  $('kbImpQaPane').hidden = true;
  $('kbImpFiles').innerHTML = '';
  $('kbImpRichText').value = '';
  $('kbImpQaQ').value = '';
  $('kbImpQaA').value = '';
  renderQaPairs();
  $('modalKbImport').hidden = false;
}

/** 问答对: 一问一答分开填, 加进临时清单 (导入时拼成文档) */
function addQaPair() {
  const q = $('kbImpQaQ').value.trim();
  const a = $('kbImpQaA').value.trim();
  if (!q || !a) return toast('问题和答案都要填', 'err');
  kbState.qaPairs = kbState.qaPairs || [];
  kbState.qaPairs.push({ q, a });
  $('kbImpQaQ').value = '';
  $('kbImpQaA').value = '';
  $('kbImpQaQ').focus();
  renderQaPairs();
}

function renderQaPairs() {
  const box = $('kbImpQaList');
  if (!box) return;
  const pairs = kbState.qaPairs || [];
  if (!pairs.length) { box.innerHTML = '<div class="kb-hint">还没有添加问答对。上面填好一问一答, 点「添加」。</div>'; return; }
  box.innerHTML = pairs.map((p, i) => `
    <div class="kb-qa-item">
      <span class="kb-qa-i">${i + 1}</span>
      <span class="kb-qa-q">${kbEsc(p.q)}</span>
      <span class="kb-qa-a">${kbEsc(p.a)}</span>
      <button class="kb-qa-del" data-i="${i}" title="删除" type="button">×</button>
    </div>`).join('');
  box.querySelectorAll('.kb-qa-del').forEach((b) => b.addEventListener('click', () => {
    kbState.qaPairs.splice(Number(b.dataset.i), 1);
    renderQaPairs();
  }));
}

async function pickImportFiles() {
  const r = await api.knowledge.pickFiles();
  if (!r || !r.ok) return;
  kbState.importFiles = r.paths || [];
  $('kbImpFiles').innerHTML = kbState.importFiles.map((p) => `<div class="kb-file">${kbEsc(p.split(/[\\/]/).pop())}</div>`).join('');
}

function extToType(p) {
  const m = String(p).toLowerCase().match(/\.([a-z0-9]+)$/);
  const e = m ? m[1] : 'txt';
  return ['md', 'txt', 'docx', 'pdf'].includes(e) ? e : 'txt';
}

async function submitImport() {
  const kb = currentKb();
  if (!kb) return;
  let items = [];
  const mode = kbState.importMode || 'file';
  if (mode === 'file') {
    if (!kbState.importFiles || !kbState.importFiles.length) return toast('请先选择文件', 'err');
    items = kbState.importFiles.map((p) => ({ type: extToType(p), path: p }));
  } else if (mode === 'richtext') {
    const content = $('kbImpRichText').value.trim();
    if (!content) return toast('内容为空', 'err');
    items = [{ type: 'richtext', name: $('kbImpRichName').value.trim() || '富文本', content }];
  } else {
    const pairs = kbState.qaPairs || [];
    if (!pairs.length) return toast('还没有添加问答对', 'err');
    // 每对拼成"Q: …\nA: …" —— parse.js 的 qa 解析会按空行再切成一个个块
    const content = pairs.map((p) => `Q: ${p.q}\nA: ${p.a}`).join('\n\n');
    items = [{ type: 'qa', name: $('kbImpQaName').value.trim() || '问答对', content }];
  }
  $('modalKbImport').hidden = true;
  kbState.importing = true;
  const bar = $('kbImportBar');
  bar.hidden = false;
  bar.textContent = '正在创建...';
  try {
    const r = await api.knowledge.import({ kbId: kb.id, folderId: ($('kbDestFolder').value || null), items });
    const okN = (r.results || []).filter((x) => x.ok).length;
    const failN = (r.results || []).filter((x) => !x.ok).length;
    toast(`创建完成: 成功 ${okN} 篇${failN ? ', 失败 ' + failN + ' 篇' : ''}`, failN ? 'err' : undefined);
    if (failN) {
      const first = (r.results || []).find((x) => !x.ok);
      if (first) console.warn('[kb] import failed:', first.name, first.error);
    }
  } catch (e) {
    toast('创建失败: ' + e.message, 'err');
  } finally {
    kbState.importing = false;
    bar.hidden = true;
    await loadKbs();
  }
}

/** 导入进度事件 (来自主进程): 让该文档立刻出现在列表里, 行尾挂一个圆环推进 */
async function onKbImportEvent(ev) {
  if (!ev || !ev.docId) return;
  const bar = $('kbImportBar');
  if (ev.kind === 'start') {
    kbState.importProgress.set(ev.docId, 0);
    if (bar) { bar.hidden = false; bar.textContent = '正在处理: ' + ev.name; }
    await loadDocs();            // 让这一行立刻出现在表格里
  } else if (ev.kind === 'progress') {
    kbState.importProgress.set(ev.docId, kbPhasePct(ev.phase, ev.kind));
    if (bar) bar.textContent = ev.name + ' — ' + (ev.message || ev.phase);
    renderKbTable();             // 只重画表格 (圆环推进)
  } else if (ev.kind === 'done') {
    if (bar) bar.textContent = ev.name + ' — ' + (ev.ok ? '完成 (' + (ev.chunkCount || 0) + ' 块)' : '失败: ' + ev.error);
    kbState.importProgress.delete(ev.docId);
    await loadKbs();             // 拉真实状态 (就绪 / 失败)
    if (bar) bar.hidden = true;
  }
}

/* ---- 文档详情 / 删除 ---- */

async function openDocDetail(doc) {
  if (!doc) return;
  const kb = currentKb();
  const r = await api.knowledge.docDetail({ kbId: kb.id, docId: doc.id });
  if (!r || !r.ok) return toast('读取详情失败', 'err');
  const d = r.doc;
  const p = d.params || {};
  const kv = (k, v) => `<div class="kv"><span class="kv-k">${k}</span><span class="kv-v">${kbEsc(v)}</span></div>`;
  $('docDetailTitle').textContent = d.name;
  $('docDetailBody').innerHTML = `
    <div class="kb-detail-grid">
      ${kv('类型', KB_TYPE_LABEL[d.type] || d.type)}
      ${kv('状态', (KB_STATUS[d.status] || {}).label || d.status)}
      ${kv('分块策略', p.strategy || '—')}
      ${kv('块大小 / 重叠', (p.size || '—') + ' / ' + (p.overlap == null ? '—' : p.overlap))}
      ${kv('分块数', d.chunkCount || 0)}
      ${kv('向量维度', d.dim || 0)}
      ${kv('向量模型', p.embeddingModel || '—')}
      ${kv('字符数', p.chars || '—')}
      ${kv('创建时间', kbTime(d.createdAt))}
      ${kv('完成时间', kbTime(p.finishedAt))}
    </div>
    ${d.error ? `<div class="kb-detail-err">${kbEsc(d.error)}</div>` : ''}
    <div class="kb-detail-sub">实际分块预览 (前 ${r.chunks.length} / 共 ${r.chunkTotal} 块)</div>
    <div class="kb-chunks">${r.chunks.map((c) => `
      <div class="kb-chunk"><div class="kb-chunk-head">#${c.ord + 1}${c.section ? ' · ' + kbEsc(c.section) : ''} · ${c.chars} 字</div>
      <div class="kb-chunk-text">${kbEsc(c.text)}</div></div>`).join('') || '<div class="kb-hint">没有分块</div>'}</div>`;
  $('modalDocDetail').hidden = false;
}

async function deleteDoc(doc) {
  const kb = currentKb();
  if (!doc || !kb) return;
  const ok = await askConfirm({ title: '删除文档?', message: `删除「${doc.name}」?`, detail: '它的分块与向量会一起删掉。', okText: '删除', tone: 'danger' });
  if (!ok) return;
  const r = await api.knowledge.deleteDoc({ kbId: kb.id, docId: doc.id });
  if (r && r.ok) { toast('已删除'); await loadKbs(); } else toast('删除失败', 'err');
}

/* ==================== 知识库配置 (配置 · 知识库) ==================== */

async function renderKbConfig() {
  const body = $('kbCfgBody');
  if (!body) return;
  const info = await api.knowledge.configGet();
  kbState.config = (info && info.config) || {};
  kbState.presets = (info && info.presets) || {};
  const emb = kbState.config.embedding || {};
  const ret = kbState.config.retrieval || {};
  const cc = kbState.config.chunkConfig || {};
  const kbs = await api.knowledge.listKbs() || [];
  body.innerHTML = `
    <div class="cfg-block">
      <div class="cfg-block-title">向量模型</div>
      <div class="kb-embed-row">
        <select id="cfgEmbPreset" class="field-input">${Object.entries(kbState.presets).map(([k, v]) => `<option value="${k}"${(emb.provider === k) ? ' selected' : ''}>${kbEsc(v.label || k)}</option>`).join('')}</select>
        <input id="cfgEmbBase" class="field-input" placeholder="Base URL" value="${kbEsc(emb.baseURL || '')}" />
        <input id="cfgEmbModel" class="field-input" placeholder="模型名" value="${kbEsc(emb.model || '')}" />
        <input id="cfgEmbKey" class="field-input" type="password" placeholder="API Key (留空不修改)" />
      </div>
      <div class="kb-hint">换了模型后, 旧文档若维度不一致, 检索时会自动跳过 (需要重新导入)。</div>
    </div>

    <div class="cfg-block">
      <div class="cfg-block-title">分块策略</div>
      <div class="kb-embed-row">
        <select id="cfgChunkStrategy" class="field-input">
          <option value="fixed">固定分块</option>
          <option value="structural">基于结构 (Markdown 标题)</option>
          <option value="semantic">基于语义 (需向量模型)</option>
        </select>
        <label class="kb-inline"><span>块大小</span><input id="cfgChunkSize" class="field-input" type="number" value="${cc.size || 800}" /></label>
        <label class="kb-inline"><span>重叠</span><input id="cfgChunkOverlap" class="field-input" type="number" value="${cc.overlap == null ? 120 : cc.overlap}" /></label>
        <label class="kb-inline"><span>语义阈值</span><input id="cfgChunkThresh" class="field-input" type="number" step="0.01" value="${cc.semanticThreshold || 0.72}" /></label>
      </div>
      <div class="kb-hint">导入时按这个策略切块。语义分块需要向量模型 (未配则自动退化为结构分块)。</div>
    </div>

    <div class="cfg-block">
      <div class="cfg-block-title">检索</div>
      <div class="kb-embed-row">
        <label class="kb-inline"><span>topK</span><input id="cfgTopK" class="field-input" type="number" value="${Number(ret.topK) || 5}" /></label>
        <label class="kb-inline"><span>召回条数</span><input id="cfgCand" class="field-input" type="number" value="${Number(ret.candidateN) || 20}" /></label>
        <label class="kb-inline"><span>LLM 重排</span><input id="cfgRerank" type="checkbox" ${ret.rerank !== false ? 'checked' : ''} /></label>
      </div>
      <div class="kb-hint">先向量召回「召回条数」条, 再让模型按相关性重排取 topK。关掉重排就纯按向量分取前 topK。</div>
    </div>

    <div class="cfg-block">
      <div class="cfg-block-title">默认检索知识库</div>
      <select id="cfgDefaultKb" class="field-input">
        <option value="">(不指定)</option>
        ${kbs.map((k) => `<option value="${k.id}"${kbState.config.defaultKbId === k.id ? ' selected' : ''}>${kbEsc(k.name)}</option>`).join('')}
      </select>
      <div class="kb-hint">对话页没手动选知识库时, search_knowledge 查这个库。</div>
    </div>

    <div class="cfg-block">
      <div class="cfg-block-title">检索自测</div>
      <div class="kb-embed-row">
        <select id="cfgTestKb" class="field-input">${kbs.map((k) => `<option value="${k.id}">${kbEsc(k.name)}</option>`).join('')}</select>
        <input id="cfgTestQuery" class="field-input" placeholder="输入一个问题试试检索" />
        <button class="btn" id="cfgTestGo">测试检索</button>
      </div>
      <div id="cfgTestOut" class="kb-test-out"></div>
    </div>`;

  $('cfgEmbPreset').addEventListener('change', () => {
    const p = kbState.presets[$('cfgEmbPreset').value];
    if (p) { $('cfgEmbBase').value = p.baseURL || ''; $('cfgEmbModel').value = p.model || ''; }
  });
  $('cfgChunkStrategy').value = cc.strategy || 'fixed';
  $('cfgTestGo').addEventListener('click', testSearch);
}

async function saveKbConfig() {
  const patch = {
    embedding: {
      provider: $('cfgEmbPreset').value,
      baseURL: $('cfgEmbBase').value.trim(),
      model: $('cfgEmbModel').value.trim()
    },
    chunkConfig: {
      strategy: $('cfgChunkStrategy').value,
      size: Number($('cfgChunkSize').value) || 800,
      overlap: Number($('cfgChunkOverlap').value) || 0,
      semanticThreshold: Number($('cfgChunkThresh').value) || 0.72
    },
    retrieval: {
      topK: Number($('cfgTopK').value) || 5,
      candidateN: Number($('cfgCand').value) || 20,
      rerank: $('cfgRerank').checked
    },
    defaultKbId: $('cfgDefaultKb').value || null
  };
  const key = $('cfgEmbKey').value;
  if (key) patch.embedding.apiKey = key;   // 留空 = 不改
  const r = await api.knowledge.configSave(patch);
  if (r && r.ok) toast('已保存'); else toast('保存失败', 'err');
}

async function testSearch() {
  const kbId = $('cfgTestKb').value;
  const query = $('cfgTestQuery').value.trim();
  const out = $('cfgTestOut');
  if (!query) return toast('先输入问题', 'err');
  out.innerHTML = '<div class="kb-hint">检索中...</div>';
  const r = await api.knowledge.search({ kbId, query });
  if (!r || !r.ok) { out.innerHTML = `<div class="kb-detail-err">${kbEsc((r && r.error) || '检索失败')}</div>`; return; }
  if (!r.hits.length) { out.innerHTML = '<div class="kb-hint">没有命中。</div>'; return; }
  out.innerHTML = r.hits.map((h, i) => `<div class="kb-chunk"><div class="kb-chunk-head">#${i + 1} ${kbEsc(h.docName)}${h.section ? ' · ' + kbEsc(h.section) : ''} · 相关度 ${h.score}</div><div class="kb-chunk-text">${kbEsc(String(h.text || '').slice(0, 300))}</div></div>`).join('');
}

/* ==================== 问答管理 (飞轮) ==================== */

async function renderQaPanel() {
  const bar = $('qaBar');
  const list = $('qaList');
  if (!bar) return;
  const f = kbState.qa.filter;
  bar.innerHTML = `
    <div class="qa-filters">
      <select id="qaFb" class="field-input">
        <option value="">全部反馈</option>
        <option value="up">👍 点赞</option>
        <option value="down">👎 点踩</option>
      </select>
      <input id="qaFrom" class="field-input" type="date" title="起始日期" />
      <input id="qaTo" class="field-input" type="date" title="结束日期" />
      <input id="qaQ" class="field-input" placeholder="搜索问题/答案" />
      <button class="btn" id="qaApply">筛选</button>
      <span class="qa-bar-gap"></span>
      <button class="btn" id="qaAnalyze">AI 分析</button>
      <button class="btn" id="qaExportJsonl">导出 JSONL</button>
      <button class="btn" id="qaExportCsv">导出 CSV</button>
    </div>`;
  if (f.feedback) $('qaFb').value = f.feedback;
  if (f.from) $('qaFrom').value = f.from.slice(0, 10);
  if (f.to) $('qaTo').value = f.to.slice(0, 10);
  if (f.q) $('qaQ').value = f.q;
  $('qaApply').addEventListener('click', applyQaFilter);
  $('qaAnalyze').addEventListener('click', runQaAnalyze);
  $('qaExportJsonl').addEventListener('click', () => exportQa('jsonl'));
  $('qaExportCsv').addEventListener('click', () => exportQa('csv'));

  const r = await api.qa.list(qaFilterPayload());
  kbState.qa.rows = (r && r.rows) || [];
  kbState.qa.total = (r && r.total) || 0;
  if (!kbState.qa.rows.length) {
    list.innerHTML = '<div class="kb-empty">还没有问答记录。去对话页问一句, 这里就会记下来。</div>';
    return;
  }
  list.innerHTML = `<div class="qa-count">共 ${kbState.qa.total} 条</div>
    <table class="kb-table qa-table">
      <thead><tr>
        <th class="qa-c-time">时间</th>
        <th class="qa-c-user">用户</th>
        <th class="qa-c-q">问题</th>
        <th class="qa-c-a">答案</th>
        <th class="qa-c-kb">知识库</th>
        <th class="kb-col-num">参考</th>
        <th class="qa-c-fb">反馈</th>
        <th class="kb-col-act">操作</th>
      </tr></thead>
      <tbody>${kbState.qa.rows.map((row) => {
        const ans = String(row.answer || '');
        const long = ans.length > 80;
        return `<tr data-qaid="${row.id}">
          <td class="qa-c-time">${kbEsc(kbTime(row.ts))}</td>
          <td class="qa-c-user">${kbEsc(row.user || '本机用户')}</td>
          <td class="qa-c-q">${kbEsc(row.question)}</td>
          <td class="qa-c-a"><span class="qa-a-text${long ? ' clamp' : ''}">${kbEsc(ans)}</span>${long ? '<button class="qa-a-toggle" type="button">展开</button>' : ''}</td>
          <td class="qa-c-kb">${kbEsc(row.kbName || '—')}</td>
          <td class="kb-col-num">${(row.ragHits || []).length}</td>
          <td class="qa-c-fb">${row.feedback === 'up' ? '点赞' : row.feedback === 'down' ? '点踩' : '未反馈'}</td>
          <td class="kb-col-act"><button class="btn btn-sm" data-qaact="view">查看</button></td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;

  list.querySelectorAll('tr[data-qaid]').forEach((el) => {
    const row = kbState.qa.rows.find((x) => x.id === el.dataset.qaid);
    el.querySelector('[data-qaact="view"]').addEventListener('click', () => openQaDetail(row));
    const tgl = el.querySelector('.qa-a-toggle');
    if (tgl) tgl.addEventListener('click', () => {
      const span = el.querySelector('.qa-a-text');
      const clamped = span.classList.toggle('clamp');
      tgl.textContent = clamped ? '展开' : '收起';
    });
  });
}

/** 问答详情: 字段 + 问题 + 执行流程图 + 回答 + 参考资料 */
function openQaDetail(row) {
  if (!row) return;
  const u = row.usage || {};
  const fields = [
    ['问答用户', row.user || '本机用户'],
    ['知识库', row.kbName || '—'],
    ['模型', row.model || '—'],
    ['耗时', row.latencyMs ? row.latencyMs + ' ms' : '—'],
    ['用量', (u.input != null || u.output != null) ? `输入 ${u.input || 0} / 输出 ${u.output || 0} tokens` : '—'],
    ['反馈', row.feedback === 'up' ? '点赞' : row.feedback === 'down' ? '点踩' : '未反馈'],
    ['点踩原因', [(row.feedbackTags || []).join('、'), row.feedbackText || ''].filter(Boolean).join(' · ') || '—'],
    ['问答时间', kbTime(row.ts)]
  ];
  const hits = row.ragHits || [];
  $('qaDetailBody').innerHTML = `
    <div class="qa-detail-fields">${fields.map(([k, v]) => `<div class="qa-f"><span class="qa-f-k">${kbEsc(k)}</span><span class="qa-f-v">${kbEsc(v)}</span></div>`).join('')}</div>
    <div class="qa-detail-sec">问题</div>
    <div class="qa-detail-q">${kbEsc(row.question)}</div>
    <div class="qa-detail-sec">执行流程</div>
    ${renderQaFlow(row, hits)}
    <div class="qa-detail-sec">AI 回答</div>
    <div class="qa-detail-a">${(typeof renderMarkdown === 'function') ? renderMarkdown(row.answer || '') : kbEsc(row.answer || '')}</div>
    ${hits.length ? `<div class="qa-detail-sec">参考资料 (${hits.length})</div><div class="qa-detail-refs">${hits.map((h, i) => `<div class="qa-chunk"><div class="qa-chunk-head">[${i + 1}] ${kbEsc(h.docName || '')}${h.section ? ' · ' + kbEsc(h.section) : ''} · 相关度 ${h.score}</div></div>`).join('')}</div>` : ''}`;
  $('modalQaDetail').hidden = false;
}

/**
 * 执行流程可视化。优先用主进程记的**决策轨迹** (trace):
 * 闸门怎么判的 / 读表 / 为什么查知识库 / 命中多少 / SQL 步 / 收尾。
 * 老记录没有 trace 时, 退回用 steps 拼一个简版。
 */
function renderQaFlow(row, hits) {
  let trace = Array.isArray(row.trace) ? row.trace.slice() : [];
  if (!trace.length) {
    trace = [];
    if (hits && hits.length) trace.push({ kind: 'rag', title: '检索知识库', detail: '命中 ' + hits.length + ' 条' });
    for (const s of (row.steps || [])) trace.push({ kind: s.kind, title: s.title || s.kind });
    trace.push({ kind: 'finish', title: '给出回答' });
  }
  const nodes = [{ kind: 'start', title: '收到问题', detail: String(row.question || '').slice(0, 60) }].concat(trace);
  return `<div class="qa-flow">${nodes.map((n) => `
    <div class="qa-flow-node ${kbFlowCls(n.kind)}">
      <span class="qa-flow-dot"></span>
      <div class="qa-flow-body">
        <div class="qa-flow-t">${kbEsc(n.title || n.kind || '')}</div>
        ${n.detail ? `<div class="qa-flow-d">${kbEsc(n.detail)}</div>` : ''}
      </div>
    </div>`).join('')}</div>`;
}

/** 轨迹节点的颜色分类 */
function kbFlowCls(kind) {
  if (kind === 'start') return 'start';
  if (kind === 'gate') return 'gate';
  if (kind === 'schema') return 'schema';
  if (kind === 'rag') return 'rag';
  if (kind === 'finish' || kind === 'reply') return 'end';
  return 'step';
}

function qaFilterPayload() {
  const f = kbState.qa.filter;
  const p = {};
  if (f.feedback) p.feedback = f.feedback;
  if (f.from) p.from = f.from;
  if (f.to) p.to = f.to + 'T23:59:59.999Z';
  if (f.q) p.q = f.q;
  return p;
}

async function applyQaFilter() {
  kbState.qa.filter = {
    feedback: $('qaFb').value,
    from: $('qaFrom').value,
    to: $('qaTo').value,
    q: $('qaQ').value.trim()
  };
  await renderQaPanel();
}

async function runQaAnalyze() {
  const body = $('qaAnalyzeBody');
  body.innerHTML = '<div class="kb-hint">AI 正在分析... (要用一次模型)</div>';
  $('modalQaAnalyze').hidden = false;
  const r = await api.qa.analyze(qaFilterPayload());
  if (!r || !r.ok) { body.innerHTML = `<div class="kb-detail-err">${kbEsc((r && r.error) || '分析失败')}</div>`; return; }
  const s = r.stats || {};
  body.innerHTML = `<div class="qa-analyze-stats">样本 ${s.total} 条 · 👍 ${s.up} · 👎 ${s.down}</div>`
    + `<div class="kb-analyze-md">${(typeof window.renderMarkdown === 'function') ? window.renderMarkdown(r.analysis) : kbEsc(r.analysis)}</div>`;
}

async function exportQa(format) {
  const r = await api.qa.export({ format, filter: qaFilterPayload() });
  if (r && r.ok) toast('已导出: ' + r.filePath); else if (r && r.error) toast(r.error, 'err');
}

/* ---- 反馈 ---- */

function openFeedbackModal(row) {
  kbState.fb = row;
  const tags = ['有害/不安全', '虚假信息', '没有帮助', '其他'];
  $('qaFbTags').innerHTML = tags.map((t) => `<button class="qa-fb-tag" data-tag="${kbEsc(t)}">${kbEsc(t)}</button>`).join('');
  $('qaFbTags').querySelectorAll('.qa-fb-tag').forEach((b) => b.addEventListener('click', () => b.classList.toggle('on')));
  $('qaFbText').value = '';
  $('modalQaFeedback').hidden = false;
}

async function submitFeedbackModal() {
  const row = kbState.fb;
  if (!row) return;
  const tags = [...$('qaFbTags').querySelectorAll('.qa-fb-tag.on')].map((b) => b.dataset.tag);
  const text = $('qaFbText').value.trim();
  $('modalQaFeedback').hidden = true;
  await sendFeedback(row.id, 'down', tags, text);
}

async function sendFeedback(id, verdict, tags, text) {
  const r = await api.qa.feedback({ id, verdict, tags, text });
  if (r && r.ok) toast('感谢反馈');
  else toast((r && r.error) || '反馈失败', 'err');
  if (kbState.tab === 'qa') await renderQaPanel();
}

// 暴露给 app.js (对话页的 👍/👎 与反馈弹窗复用)
window.kbOpenFeedback = function (qaId, question) {
  kbState.fb = { id: qaId, question: question || '' };
  const tags = ['有害/不安全', '虚假信息', '没有帮助', '其他'];
  $('qaFbTags').innerHTML = tags.map((t) => `<button class="qa-fb-tag" data-tag="${kbEsc(t)}">${kbEsc(t)}</button>`).join('');
  $('qaFbTags').querySelectorAll('.qa-fb-tag').forEach((b) => b.addEventListener('click', () => b.classList.toggle('on')));
  $('qaFbText').value = '';
  $('modalQaFeedback').hidden = false;
};
window.kbSendFeedback = sendFeedback;

/**
 * 反馈弹窗的按钮绑在**脚本加载时**, 而不是等 initKnowledgeView。
 *
 * 它是从**对话页**的 👎 打开的 (window.kbOpenFeedback)。如果用户从没进过「知识库」页,
 * bindKnowledgeUI() 就没跑过 —— 那时弹窗能弹出, 但取消/提交都没有监听, 点了没反应。
 * 这个函数在 knowledge.js 加载时立即执行一次; 那时 index.html 已经解析完, 弹窗元素在。
 */
(function bindFeedbackModalEarly() {
  const modal = document.getElementById('modalQaFeedback');
  if (!modal) return;
  modal.querySelectorAll('[data-close]').forEach((el) => {
    el.addEventListener('click', () => { modal.hidden = true; });
  });
  const ok = document.getElementById('qaFbOk');
  if (ok) ok.addEventListener('click', submitFeedbackModal);
})();
