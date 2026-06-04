/**
 * Skills 系统
 *
 * 支持两种形态:
 *
 * 1) 单个 .md 文件 (带 YAML frontmatter)
 *    ---
 *    name: my-skill
 *    version: 0.1.0
 *    description: 一段说明
 *    ---
 *    这里是 system prompt 内容...
 *
 * 2) 文件夹
 *    my-skill/
 *    ├── SKILL.md            # 主清单 (frontmatter + 正文) ; 与 skill.json 二选一
 *    ├── skill.json          # 兼容旧版 (frontmatter 形式也支持)
 *    ├── extra-doc.md        # 附加文档, 将拼入系统提示
 *    ├── helper.js           # 运行时脚本, 会被 require 加载
 *    └── another.js
 *
 * frontmatter 字段:
 *   - name: 技能名 (必填, 缺省回退到目录名/文件名)
 *   - version: 版本
 *   - description: 描述
 *   - entry: 入口 JS 文件名 (不填则自动加载目录内所有 .js)
 *   - tools: JSON 字符串, 工具声明 (MVP 仅作为提示)
 *   - examples: 一行一个示例 (用 `  - ` 列表)
 */

const fs = require('fs');
const path = require('path');

class Skills {
  constructor({ skillsDir, enabled = [] }) {
    this.skillsDir = skillsDir;
    this.enabled = new Set(enabled);
    this.skills = [];
  }

  async load() {
    this.skills = [];
    if (!fs.existsSync(this.skillsDir)) {
      fs.mkdirSync(this.skillsDir, { recursive: true });
      return this.skills;
    }
    const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });
    for (const e of entries) {
      try {
        if (e.isDirectory()) {
          const s = this._loadDir(path.join(this.skillsDir, e.name), e.name);
          if (s) this.skills.push(s);
        } else if (e.isFile() && /\.md$/i.test(e.name)) {
          const s = this._loadFile(path.join(this.skillsDir, e.name));
          if (s) this.skills.push(s);
        }
      } catch (err) {
        console.error('Skill load error:', e.name, err.message);
      }
    }
    return this.skills;
  }

  // 加载文件夹形式的技能
  _loadDir(dir, defaultName) {
    const skillMdPath = path.join(dir, 'SKILL.md');
    const skillJsonPath = path.join(dir, 'skill.json');
    let meta, body;
    if (fs.existsSync(skillMdPath)) {
      const fm = readFrontmatter(fs.readFileSync(skillMdPath, 'utf-8'));
      meta = fm.meta;
      body = fm.body;
    } else if (fs.existsSync(skillJsonPath)) {
      meta = JSON.parse(fs.readFileSync(skillJsonPath, 'utf-8'));
      body = '';
    } else {
      return null; // 没有清单, 跳过
    }
    const name = meta.name || defaultName;
    const version = meta.version || '0.1.0';
    const description = meta.description || '';
    const systemPrompt = (body || meta.systemPrompt || '').trim();

    // 附加 .md 文档
    const extraDocs = [];
    const all = fs.readdirSync(dir);
    for (const f of all) {
      const full = path.join(dir, f);
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      if (/\.md$/i.test(f) && !/^SKILL\.md$/i.test(f)) {
        const fm = readFrontmatter(fs.readFileSync(full, 'utf-8'));
        extraDocs.push({ file: f, title: fm.meta.title || f.replace(/\.md$/i, ''), body: fm.body.trim() });
      }
    }

    // 加载脚本
    const scripts = {};
    let runtimeError = null;
    if (meta.entry) {
      const entryPath = path.join(dir, meta.entry);
      if (fs.existsSync(entryPath)) {
        try { scripts[meta.entry] = require(entryPath); } catch (e) { runtimeError = `${meta.entry}: ${e.message}`; }
      }
    } else {
      // 自动加载所有 .js (排除 node_modules)
      for (const f of all) {
        if (/\.js$/i.test(f)) {
          const full = path.join(dir, f);
          try { scripts[f] = require(full); } catch (e) { runtimeError = `${f}: ${e.message}`; }
        }
      }
    }

    return {
      name,
      dirName: defaultName,
      kind: 'directory',
      version,
      description,
      systemPrompt,
      examples: meta.examples || [],
      tools: meta.tools || [],
      extraDocs,
      scripts,
      runtime: scripts[meta.entry] || Object.values(scripts)[0] || null,
      runtimeError
    };
  }

  // 加载单文件 .md
  _loadFile(filePath) {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const fm = readFrontmatter(raw);
    const meta = fm.meta;
    const name = meta.name || path.basename(filePath, path.extname(filePath));
    return {
      name,
      dirName: null,
      kind: 'file',
      version: meta.version || '0.1.0',
      description: meta.description || '',
      systemPrompt: (fm.body || '').trim(),
      examples: meta.examples || [],
      tools: meta.tools || [],
      extraDocs: [],
      scripts: {},
      runtime: null,
      runtimeError: null
    };
  }

  list() {
    return this.skills.map((s) => ({
      name: s.name,
      kind: s.kind,
      version: s.version,
      description: s.description,
      enabled: this.enabled.has(s.name),
      runtimeError: s.runtimeError || null
    }));
  }

  active() {
    return this.skills.filter((s) => this.enabled.has(s.name));
  }

  buildSystemPromptFragment() {
    const active = this.active();
    if (!active.length) return '';
    const parts = active.map((s) => {
      const examples = (s.examples || [])
        .slice(0, 3)
        .map((ex) => '  - ' + (typeof ex === 'string' ? ex : JSON.stringify(ex)))
        .join('\n');
      const extraDocText = (s.extraDocs || [])
        .map((d) => `附加文档 [${d.title}]:\n${d.body}`)
        .join('\n\n');
      return [
        `### 技能: ${s.name} (v${s.version}, ${s.kind})`,
        s.description,
        s.systemPrompt,
        extraDocText,
        examples ? '示例:\n' + examples : ''
      ]
        .filter(Boolean)
        .join('\n');
    });
    return [
      '你具备以下加载的技能 (Skills), 在合适场景请优先使用:',
      ...parts
    ].join('\n\n');
  }
}

/**
 * 极简 YAML frontmatter 解析
 * 支持:
 *   key: value
 *   key: 'quoted value'
 *   key: "double quoted"
 *   key:
 *     - item1
 *     - item2
 */
function readFrontmatter(text) {
  if (!text) return { meta: {}, body: '' };
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  const lines = m[1].split('\n');
  let currentKey = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    const li = line.match(/^\s+-\s+(.*)$/);
    if (li && currentKey) {
      if (!Array.isArray(meta[currentKey])) meta[currentKey] = [];
      meta[currentKey].push(parseScalar(li[1].trim()));
      continue;
    }
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (kv) {
      const k = kv[1];
      const v = kv[2].trim();
      if (v === '') {
        meta[k] = [];
        currentKey = k;
      } else {
        meta[k] = parseScalar(v);
        currentKey = null;
      }
    }
  }
  return { meta, body: m[2] };
}

function parseScalar(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
    return v.slice(1, -1);
  }
  return v;
}

module.exports = Skills;
