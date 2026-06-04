# SoloDB

一个 Windows 桌面端数据库智能体: 你用自然语言提出任务, 智能体自动规划 SQL、查询数据库、生成 HTML/Markdown 报告。

## 功能

- 多数据库支持: MySQL / PostgreSQL / SQLite / SQL Server
- 兼容 OpenAI 协议的大模型接口 (OpenAI / DeepSeek / 通义千问 / 智谱 / 自建网关等)
- 智能体 ReAct 风格循环: 规划 → 执行 SQL → 观察结果 → 继续, 最多 12 步
- 报告生成: HTML 报告带样式预览, 同时产出 Markdown
- Skills 导入: 单个 `.md` 文档或含脚本/多份文档的文件夹
- 多数据库管理: 可在对话框上方切换当前数据库

## 快速开始

```bash
# 1) 安装依赖
npm install

# 2) 启动应用
npm start
```

首次启动后:

1. 切到 **模型** 标签, 填写 `Base URL` / `API Key` / `Model`, 保存
2. 切到 **数据库** 标签, 点击 **添加数据库**, 填写连接信息, 可先 **测试连接** 确认
3. 切回 **对话** 标签, 在底部输入任务并发送 (Ctrl+Enter 发送)

## 目录结构

```
soloDB/
├── main.js              # Electron 主进程
├── preload.js           # 安全桥接
├── lib/
│   ├── llm.js           # OpenAI 兼容 LLM 客户端
│   ├── database.js      # 数据库抽象层
│   ├── agent.js         # 智能体规划/执行循环
│   ├── report.js        # HTML/Markdown 报告生成
│   └── skills.js        # Skills 加载与系统提示注入
├── src/
│   ├── index.html
│   ├── styles/main.css
│   └── js/app.js        # 渲染层逻辑
└── example-skills/      # 示例技能
    ├── daily-report/    # 文件夹形式: SKILL.md
    ├── retention-analysis/
    ├── top-products/
    └── orders-domain.md # 单文件形式
```

## 技能 (Skills) 格式

技能可以是以下两种形态之一。

### 形态 A: 单个 Markdown 文件

带 YAML frontmatter, 正文即为注入到 Agent 的系统提示。

```markdown
---
name: orders-domain
version: 0.1.0
description: 电商订单域背景知识
---

本技能注入订单域的业务知识...

- 表 `orders.status` 取值: created / paid / shipped / ...
- 字段 `amount` 单位为分
```

### 形态 B: 文件夹

`my-skill/`
- `SKILL.md` — 主清单 (frontmatter + 正文) , 与 `skill.json` 二选一
- `skill.json` — 兼容旧版 (字段: name / version / description / systemPrompt / examples)
- `extra.md` 等附加 `.md` 文件 — 自动拼入系统提示
- `*.js` 脚本 — 启动时自动 `require`, 作为运行时辅助

#### frontmatter 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 技能名, 缺省回退到目录名/文件名 |
| `version` | 否 | 默认 `0.1.0` |
| `description` | 否 | 一句话说明 |
| `entry` | 否 | 指定入口 JS 文件, 不填则自动加载目录内所有 `.js` |
| `examples` | 否 | 一行一个示例 (用 `  - ` 列表) |

## 导入方式

在 **技能** 标签页:

- 点击 **导入 .md** 选择一个 Markdown 文件
- 点击 **导入文件夹** 选择一个包含 `SKILL.md` 或 `skill.json` 的目录
- 导入后用开关启用/停用

## 安全

- 智能体在 MVP 阶段仅允许执行 `SELECT` / `WITH` / `EXPLAIN` / `PRAGMA` 语句, 禁止任何写操作
- API Key 与数据库密码仅保存在本地用户目录 `config.json` 中, 不外发
- 所有数据库连接只在本地发起, 不经任何第三方服务
