const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    setLLM: (llm) => ipcRenderer.invoke('config:setLLM', llm),
    // 模型清单。setLLM 保留着 (它现在改的是"当前选中那一个"的字段), 但增删和
    // 切换选中走这三个 —— 它们的语义是"对清单的操作", 塞进 setLLM 会变成
    // 一个参数形状忽扁忽扁平的函数, 谁都读不懂。
    saveModel: (m) => ipcRenderer.invoke('llm:save', m),
    deleteModel: (id) => ipcRenderer.invoke('llm:delete', id),
    setActiveModel: (id) => ipcRenderer.invoke('llm:setActive', id),
    testModel: (payload) => ipcRenderer.invoke('llm:test', payload),
    addDatabase: (db) => ipcRenderer.invoke('config:addDatabase', db),
    removeDatabase: (id) => ipcRenderer.invoke('config:removeDatabase', id),
    setDatabaseTables: (payload) => ipcRenderer.invoke('config:setDatabaseTables', payload)
  },
  db: {
    test: (cfg) => ipcRenderer.invoke('db:test', cfg),
    listTables: (payload) => ipcRenderer.invoke('db:listTables', payload),
    describeTable: (payload) => ipcRenderer.invoke('db:describeTable', payload)
  },
  engine: {
    list: () => ipcRenderer.invoke('engine:list'),
    save: (input) => ipcRenderer.invoke('engine:save', input),
    // 只给 beforeunload 用: 关窗时没法 await, 只能同步挡住那一次写盘
    saveSync: (input) => ipcRenderer.sendSync('engine:saveSync', input),
    remove: (id) => ipcRenderer.invoke('engine:delete', id),
    validate: (input) => ipcRenderer.invoke('engine:validate', input),
    test: (payload) => ipcRenderer.invoke('engine:test', payload),
    // 一张卡 + N 组输入。整批共用一套连接, 并发可控, 可取消。
    testBatch: (payload) => ipcRenderer.invoke('engine:testBatch', payload),
    testBatchCancel: (payload) => ipcRenderer.invoke('engine:testBatchCancel', payload),
    onTestBatchEvent: (handler) => {
      const h = (_e, ev) => handler(ev);
      ipcRenderer.on('engine:testBatchEvent', h);
      return () => ipcRenderer.removeListener('engine:testBatchEvent', h);
    },
    aiSql: (payload) => ipcRenderer.invoke('engine:aiSql', payload),
    syncSql: (payload) => ipcRenderer.invoke('engine:syncSql', payload),
    aiOpen: (payload) => ipcRenderer.invoke('engine:aiOpen', payload),
    aiSay: (payload) => ipcRenderer.invoke('engine:aiSay', payload),
    aiStopSelfTest: (payload) => ipcRenderer.invoke('engine:aiStopSelfTest', payload),
    // 停搭建 (和停自测是两条路, 界面上同一个「停止」按在跑什么分流)
    aiCancel: (payload) => ipcRenderer.invoke('engine:aiCancel', payload),
    aiClose: (payload) => ipcRenderer.invoke('engine:aiClose', payload),
    aiChatList: (payload) => ipcRenderer.invoke('engine:aiChatList', payload),
    aiChatGet: (payload) => ipcRenderer.invoke('engine:aiChatGet', payload),
    aiChatRename: (payload) => ipcRenderer.invoke('engine:aiChatRename', payload),
    aiChatDelete: (payload) => ipcRenderer.invoke('engine:aiChatDelete', payload),
    aiChatSave: (payload) => ipcRenderer.invoke('engine:aiChatSave', payload),
    onAiEvent: (cb) => {
      const handler = (_e, data) => cb(data);
      ipcRenderer.on('engine:aiEvent', handler);
      return () => ipcRenderer.removeListener('engine:aiEvent', handler);
    },
    autoTest: (payload) => ipcRenderer.invoke('engine:autoTest', payload),
    autoTestCancel: (payload) => ipcRenderer.invoke('engine:autoTestCancel', payload),
    autoTestOnce: (payload) => ipcRenderer.invoke('engine:autoTestOnce', payload),
    // 流程卡导入导出 (卡包)。三个都只在「流程引擎」页用:
    //   exportPack  打完包写盘 (打开系统另存为)
    //   pickPack    选文件 + 解析, 把卡包原样交回来给界面做预览
    //   applyImport 把界面排好的最终卡片表落盘
    exportPack: (payload) => ipcRenderer.invoke('engine:exportPack', payload),
    pickPack: () => ipcRenderer.invoke('engine:pickPack'),
    applyImport: (payload) => ipcRenderer.invoke('engine:applyImport', payload),
    onAutoTestEvent: (cb) => {
      const handler = (_e, data) => cb(data);
      ipcRenderer.on('engine:autoTestEvent', handler);
      return () => ipcRenderer.removeListener('engine:autoTestEvent', handler);
    }
  },
  agent: {
    run: (payload) => ipcRenderer.invoke('agent:run', payload),
    // 斜杠指令清单 (给输入框的 / 自动补全菜单用)。单一来源在主进程。
    commands: () => ipcRenderer.invoke('agent:commands'),
    // 人工终止正在跑的对话任务
    cancel: () => ipcRenderer.invoke('agent:cancel'),
    onEvent: (cb) => {
      const handler = (_e, data) => cb(data);
      ipcRenderer.on('agent:event', handler);
      return () => ipcRenderer.removeListener('agent:event', handler);
    },
    onCheckpoint: (cb) => {
      const handler = (_e, data) => cb(data);
      ipcRenderer.on('agent:checkpoint', handler);
      return () => ipcRenderer.removeListener('agent:checkpoint', handler);
    },
    respondCheckpoint: (id, data) => ipcRenderer.invoke('agent:checkpoint:respond', { id, data })
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    importDir: () => ipcRenderer.invoke('skills:importDir'),
    importFile: () => ipcRenderer.invoke('skills:importFile'),
    toggle: (name, enabled) => ipcRenderer.invoke('skills:toggle', name, enabled)
  },
  // 内部工具 (三个 Agent 内置的工具清单)。只读, 纯展示 —— 它不能改任何东西,
  // 清单本身也是从真实 schema 现取的, 不是存在配置里的一份副本。
  internalTools: {
    list: () => ipcRenderer.invoke('tools:catalog')
  },
  mcp: {
    list: () => ipcRenderer.invoke('mcp:list'),
    add: (input) => ipcRenderer.invoke('mcp:add', input),
    remove: (id) => ipcRenderer.invoke('mcp:remove', id),
    toggle: (payload) => ipcRenderer.invoke('mcp:toggle', payload),
    probe: (payload) => ipcRenderer.invoke('mcp:probe', payload)
  },
  prompt: {
    get: () => ipcRenderer.invoke('prompt:get'),
    save: (modules) => ipcRenderer.invoke('prompt:save', modules),
    reset: () => ipcRenderer.invoke('prompt:reset')
  },
  general: {
    get: () => ipcRenderer.invoke('general:get'),
    save: (input) => ipcRenderer.invoke('general:save', input)
  },
  builder: {
    get: () => ipcRenderer.invoke('builder:get'),
    save: (input) => ipcRenderer.invoke('builder:save', input)
  },
  // 应用自身的信息 (版本号 / 配置目录)。「设置 · 关于」用 —— 版本号只有一个来源,
  // 就是 package.json, 界面不另存一份。
  app: {
    info: () => ipcRenderer.invoke('app:info')
  },
  // 版本更新。检查由**主进程**发请求: 内网更新源一般没有 CORS 头, 从页面里 fetch
  // 会被浏览器拦掉, 而且那样还得把内网地址交给渲染层。
  update: {
    get: () => ipcRenderer.invoke('update:get'),
    set: (input) => ipcRenderer.invoke('update:set', input),
    check: (input) => ipcRenderer.invoke('update:check', input)
  },
  conv: {
    list: () => ipcRenderer.invoke('conv:list'),
    get: (id) => ipcRenderer.invoke('conv:get', id),
    create: (payload) => ipcRenderer.invoke('conv:create', payload),
    saveMessages: (payload) => ipcRenderer.invoke('conv:saveMessages', payload),
    rename: (payload) => ipcRenderer.invoke('conv:rename', payload),
    // 占位「新对话」在第一轮任务发出后补标题 + 记下本次分析范围
    title: (payload) => ipcRenderer.invoke('conv:title', payload),
    remove: (id) => ipcRenderer.invoke('conv:delete', id)
  },
  // 运行记录 / 评测 / 规划器
  run: {
    list: (filter) => ipcRenderer.invoke('run:list', filter),
    get: (id) => ipcRenderer.invoke('run:get', id),
    handoff: (id) => ipcRenderer.invoke('run:handoff', id),
    annotate: (payload) => ipcRenderer.invoke('run:annotate', payload),
    remove: (id) => ipcRenderer.invoke('run:delete', id)
  },
  eval: {
    list: () => ipcRenderer.invoke('eval:list'),
    caseCreate: (input) => ipcRenderer.invoke('eval:caseCreate', input),
    caseUpdate: (input) => ipcRenderer.invoke('eval:caseUpdate', input),
    caseDelete: (id) => ipcRenderer.invoke('eval:caseDelete', id),
    caseFromRun: (payload) => ipcRenderer.invoke('eval:caseFromRun', payload),
    runOne: (caseId) => ipcRenderer.invoke('eval:runOne', caseId),
    batchCreate: (payload) => ipcRenderer.invoke('eval:batchCreate', payload),
    batchRun: (payload) => ipcRenderer.invoke('eval:batchRun', payload),
    batchRuns: (payload) => ipcRenderer.invoke('eval:batchRuns', payload),
    batchRunGet: (id) => ipcRenderer.invoke('eval:batchRunGet', id),
    batchCancel: (id) => ipcRenderer.invoke('eval:batchCancel', id),
    batchGet: (id) => ipcRenderer.invoke('eval:batchGet', id),
    compare: (payload) => ipcRenderer.invoke('eval:compare', payload),
    onBatchEvent: (cb) => {
      const h = (_e, ev) => cb(ev);
      ipcRenderer.on('eval:batchEvent', h);
      return () => ipcRenderer.removeListener('eval:batchEvent', h);
    }
  },
  planner: {
    preview: (payload) => ipcRenderer.invoke('planner:preview', payload),
    prompt: () => ipcRenderer.invoke('planner:prompt'),
    configGet: () => ipcRenderer.invoke('planner:config'),
    configSave: (payload) => ipcRenderer.invoke('planner:config:save', payload)
  },
  space: {
    list: () => ipcRenderer.invoke('space:list'),
    listArtifacts: (conversationId) => ipcRenderer.invoke('artifact:list', conversationId),
    read: (payload) => ipcRenderer.invoke('artifact:read', payload),
    remove: (payload) => ipcRenderer.invoke('artifact:delete', payload),
    reveal: (payload) => ipcRenderer.invoke('artifact:reveal', payload),
    // 真的拷一份出去 (另存为)。大产物不再预览, 走的就是这条路。
    saveAs: (payload) => ipcRenderer.invoke('artifact:saveAs', payload)
  },
  report: {
    export: (payload) => ipcRenderer.invoke('report:export', payload),
    exportXLSX: (payload) => ipcRenderer.invoke('report:exportXLSX', payload)
  },
  // 知识库 / RAG。KB = 知识库, folder 在其内, doc 是文档。
  knowledge: {
    listKbs: () => ipcRenderer.invoke('knowledge:listKbs'),
    getKb: (id) => ipcRenderer.invoke('knowledge:getKb', id),
    createKb: (payload) => ipcRenderer.invoke('knowledge:createKb', payload),
    updateKb: (payload) => ipcRenderer.invoke('knowledge:updateKb', payload),
    deleteKb: (id) => ipcRenderer.invoke('knowledge:deleteKb', id),
    createFolder: (payload) => ipcRenderer.invoke('knowledge:createFolder', payload),
    renameFolder: (payload) => ipcRenderer.invoke('knowledge:renameFolder', payload),
    deleteFolder: (payload) => ipcRenderer.invoke('knowledge:deleteFolder', payload),
    listDocs: (payload) => ipcRenderer.invoke('knowledge:listDocs', payload),
    docDetail: (payload) => ipcRenderer.invoke('knowledge:docDetail', payload),
    deleteDoc: (payload) => ipcRenderer.invoke('knowledge:deleteDoc', payload),
    pickFiles: () => ipcRenderer.invoke('knowledge:pickFiles'),
    import: (payload) => ipcRenderer.invoke('knowledge:import', payload),
    reingest: (payload) => ipcRenderer.invoke('knowledge:reingest', payload),
    search: (payload) => ipcRenderer.invoke('knowledge:search', payload),
    configGet: () => ipcRenderer.invoke('knowledge:configGet'),
    configSave: (patch) => ipcRenderer.invoke('knowledge:configSave', patch),
    // 导入进度 (逐文档)
    onImportEvent: (cb) => {
      const handler = (_e, data) => cb(data);
      ipcRenderer.on('knowledge:importEvent', handler);
      return () => ipcRenderer.removeListener('knowledge:importEvent', handler);
    }
  },
  // 问答飞轮
  qa: {
    list: (filter) => ipcRenderer.invoke('qa:list', filter),
    tags: () => ipcRenderer.invoke('qa:tags'),
    feedback: (payload) => ipcRenderer.invoke('qa:feedback', payload),
    export: (payload) => ipcRenderer.invoke('qa:export', payload),
    analyze: (filter) => ipcRenderer.invoke('qa:analyze', filter)
  }
});
