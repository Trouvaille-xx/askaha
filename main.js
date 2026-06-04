const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// 把 userData (配置/技能等持久化数据) 放在项目内, 便于沙箱/便携环境运行
// 可通过环境变量 SOLODB_USER_DATA 覆盖
const userDataDir = process.env.SOLODB_USER_DATA || path.join(__dirname, '.appdata');
if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });
app.setPath('userData', userDataDir);

const Database = require('./lib/database');
const LLMClient = require('./lib/llm');
const Agent = require('./lib/agent');
const Skills = require('./lib/skills');
const Report = require('./lib/report');

let mainWindow = null;
let configPath = null;
const pendingCheckpoints = new Map();
let config = {
  llm: {
    baseURL: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini'
  },
  databases: [],
  activeDatabase: null,
  skills: {
    enabled: []
  }
};

function loadConfig() {
  configPath = path.join(app.getPath('userData'), 'config.json');
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      config = { ...config, ...parsed };
    }
  } catch (e) {
    console.error('Failed to load config:', e);
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('Failed to save config:', e);
    return false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#f6f7f9',
    title: 'SoloDB',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // 开发模式下自动打开 DevTools 方便排查
    if (process.argv.includes('--dev')) {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  });

  // 把渲染端的所有 console 输出也转发到主进程终端, 方便排查
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const tag = ['VRB', 'INF', 'WRN', 'ERR'][level] || 'LOG';
    console.log(`[renderer ${tag}] ${message}  (${sourceId}:${line})`);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  loadConfig();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ========== IPC Handlers ==========

ipcMain.handle('config:get', () => config);

ipcMain.handle('config:set', (_e, partial) => {
  config = { ...config, ...partial };
  saveConfig();
  return config;
});

ipcMain.handle('config:setLLM', (_e, llm) => {
  config.llm = { ...config.llm, ...llm };
  saveConfig();
  return config.llm;
});

ipcMain.handle('config:addDatabase', (_e, db) => {
  const id = 'db_' + Date.now();
  const record = { id, ...db };
  config.databases.push(record);
  if (!config.activeDatabase) config.activeDatabase = id;
  saveConfig();
  return config.databases;
});

ipcMain.handle('config:updateDatabase', (_e, id, patch) => {
  config.databases = config.databases.map((d) =>
    d.id === id ? { ...d, ...patch } : d
  );
  saveConfig();
  return config.databases;
});

ipcMain.handle('config:removeDatabase', (_e, id) => {
  config.databases = config.databases.filter((d) => d.id !== id);
  if (config.activeDatabase === id) {
    config.activeDatabase = config.databases[0]?.id || null;
  }
  saveConfig();
  return config.databases;
});

ipcMain.handle('config:setActiveDatabase', (_e, id) => {
  config.activeDatabase = id;
  saveConfig();
  return id;
});

ipcMain.handle('db:test', async (_e, dbConfig) => {
  const db = new Database(dbConfig);
  try {
    const result = await db.test();
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    await db.close();
  }
});

ipcMain.handle('db:listTables', async (_e, dbId) => {
  const dbConf = config.databases.find((d) => d.id === dbId);
  if (!dbConf) throw new Error('Database not found');
  const db = new Database(dbConf);
  try {
    const tables = await db.listTables();
    return { ok: true, tables };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    await db.close();
  }
});

ipcMain.handle('agent:run', async (_e, payload) => {
  const { task, conversationId, history } = payload;
  const dbConf = config.databases.find((d) => d.id === config.activeDatabase);

  const llm = new LLMClient(config.llm);
  const skills = new Skills({
    skillsDir: path.join(app.getPath('userData'), 'skills'),
    enabled: config.skills?.enabled || []
  });
  await skills.load();

  const agent = new Agent({
    llm,
    database: dbConf ? new Database(dbConf) : null,
    skills
  });

  const askCheckpoint = (cp) => {
    const id = 'cp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:checkpoint', { id, conversationId, ...cp });
    }
    return new Promise((resolve) => {
      pendingCheckpoints.set(id, resolve);
      // 10 分钟超时, 防止 UI 永远不响应把任务卡死
      setTimeout(() => {
        if (pendingCheckpoints.has(id)) {
          pendingCheckpoints.delete(id);
          resolve({ cancelled: true, timeout: true });
        }
      }, 10 * 60 * 1000);
    });
  };

  try {
    const result = await agent.run(
      task,
      history || [],
      (event) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('agent:event', { conversationId, ...event });
        }
      },
      askCheckpoint
    );
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    if (agent.database) await agent.database.close();
  }
});

ipcMain.handle('skills:list', async () => {
  const skills = new Skills({
    skillsDir: path.join(app.getPath('userData'), 'skills'),
    enabled: config.skills?.enabled || []
  });
  await skills.load();
  return skills.list();
});

ipcMain.handle('skills:importDir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '导入技能文件夹',
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths.length) return { ok: false };

  const targetDir = path.join(app.getPath('userData'), 'skills');
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  const sourceDir = result.filePaths[0];
  const baseName = path.basename(sourceDir);
  const destDir = path.join(targetDir, baseName);
  if (fs.existsSync(destDir)) {
    return { ok: false, error: '同名技能已存在' };
  }
  // 必须包含 SKILL.md 或 skill.json
  const hasManifest =
    fs.existsSync(path.join(sourceDir, 'SKILL.md')) ||
    fs.existsSync(path.join(sourceDir, 'skill.json'));
  if (!hasManifest) {
    return { ok: false, error: '所选文件夹中未找到 SKILL.md 或 skill.json' };
  }
  fs.cpSync(sourceDir, destDir, { recursive: true });

  const skills = new Skills({ skillsDir: targetDir, enabled: config.skills?.enabled || [] });
  await skills.load();
  return { ok: true, skills: skills.list() };
});

ipcMain.handle('skills:importFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '导入 Markdown 技能',
    properties: ['openFile'],
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  });
  if (result.canceled || !result.filePaths.length) return { ok: false };

  const targetDir = path.join(app.getPath('userData'), 'skills');
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  const sourceFile = result.filePaths[0];
  const baseName = path.basename(sourceFile);
  const destFile = path.join(targetDir, baseName);
  if (fs.existsSync(destFile)) {
    return { ok: false, error: '同名技能已存在' };
  }
  fs.copyFileSync(sourceFile, destFile);

  const skills = new Skills({ skillsDir: targetDir, enabled: config.skills?.enabled || [] });
  await skills.load();
  return { ok: true, skills: skills.list() };
});

ipcMain.handle('agent:checkpoint:respond', (_e, { id, data }) => {
  const resolver = pendingCheckpoints.get(id);
  if (resolver) {
    pendingCheckpoints.delete(id);
    resolver(data || { cancelled: true });
  }
  return true;
});

ipcMain.handle('skills:toggle', async (_e, name, enabled) => {
  const enabledList = new Set(config.skills?.enabled || []);
  if (enabled) enabledList.add(name);
  else enabledList.delete(name);
  config.skills = { enabled: Array.from(enabledList) };
  saveConfig();
  return config.skills;
});

ipcMain.handle('report:openExternal', async (_e, filePath) => {
  await shell.openPath(filePath);
  return true;
});

ipcMain.handle('report:export', async (_e, { html, md, baseName }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Report',
    defaultPath: `${baseName || 'report'}.html`,
    filters: [
      { name: 'HTML', extensions: ['html'] },
      { name: 'Markdown', extensions: ['md'] }
    ]
  });
  if (result.canceled || !result.filePath) return { ok: false };

  const isMd = result.filePath.toLowerCase().endsWith('.md');
  fs.writeFileSync(result.filePath, isMd ? md : html, 'utf-8');
  return { ok: true, filePath: result.filePath };
});

ipcMain.handle('report:exportXLSX', async (_e, { base64, baseName }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Excel',
    defaultPath: `${baseName || 'report'}.xlsx`,
    filters: [{ name: 'Excel', extensions: ['xlsx'] }]
  });
  if (result.canceled || !result.filePath) return { ok: false };
  const buf = Buffer.from(base64, 'base64');
  fs.writeFileSync(result.filePath, buf);
  return { ok: true, filePath: result.filePath };
});
