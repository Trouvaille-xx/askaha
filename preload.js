const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (partial) => ipcRenderer.invoke('config:set', partial),
    setLLM: (llm) => ipcRenderer.invoke('config:setLLM', llm),
    addDatabase: (db) => ipcRenderer.invoke('config:addDatabase', db),
    updateDatabase: (id, patch) => ipcRenderer.invoke('config:updateDatabase', id, patch),
    removeDatabase: (id) => ipcRenderer.invoke('config:removeDatabase', id),
    setActiveDatabase: (id) => ipcRenderer.invoke('config:setActiveDatabase', id)
  },
  db: {
    test: (cfg) => ipcRenderer.invoke('db:test', cfg),
    listTables: (id) => ipcRenderer.invoke('db:listTables', id)
  },
  agent: {
    run: (payload) => ipcRenderer.invoke('agent:run', payload),
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
  report: {
    openExternal: (filePath) => ipcRenderer.invoke('report:openExternal', filePath),
    export: (payload) => ipcRenderer.invoke('report:export', payload),
    exportXLSX: (payload) => ipcRenderer.invoke('report:exportXLSX', payload)
  }
});
