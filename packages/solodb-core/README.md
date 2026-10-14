# solodb-core

SoloDB 的**确定性内核**。零依赖、不碰 Electron、不调模型 —— 任何 Node 宿主都能直接 require。

## 里面有什么

| 文件 | 是什么 | 为什么它在核心而不是宿主 |
|---|---|---|
| `engine.js` | 流程卡的 schema / 校验 / 模板渲染 / 执行 (`EngineRunner`, `validateEngine`, `renderTemplate`, `testEngine`) | 卡"怎么跑"是这个产品的立身之本: 存下来之后照写死的 SQL 跑, 运行期不再调模型。它必须只有一个实现 |
| `sql-guard.js` | 只读 SQL 策略 (`assertReadOnlySingleStatement`, `sqlSkeleton`) 与 `createReadOnlyDb` | "只能读"是安全承诺。宿主会有不止一个, 每个宿主各写一份闸门 = 迟早松掉一份, 且松掉没有症状 |
| `data-peek.js` | 「看一眼这列存的是什么」的统计与**抽样护栏** | 三个 Agent (搭建 / 分析 / 测试) 曾经各写一份, 三份都在千万行的表上做全表 `COUNT(DISTINCT)` —— 单列 11.6 秒 |
| `prompt.js` / `prompt-sets.js` | 搭建 / 测试 / 对话三套提示词的模块与拼装 | 这就是"写卡 Agent 的规则"。规则和引擎分家, 换宿主时就会出现"同一个引擎在两处被教成两种写法" |

## 刻意不装的东西

- **数据库驱动与连接池**: `mysql2` / `pg` / `mssql` / `sql.js` 都留在宿主。
- **Electron / IPC / 界面**: 核心不 import 任何 UI。
- **模型调用与 Agent 循环**: 核心不知道"Agent"的存在。

## 宿主怎么接

宿主只提供两样东西: 一个能 `query` 的连接, 和方言。

```js
const { Engine, Peek, createReadOnlyDb } = require('solodb-core');

// 1. 把你自己的连接 (驱动、连接池、凭证都由你管) 包成只读的
const db = createReadOnlyDb(myMysqlPoolishThing, 'mysql');
// 之后每一条 SQL 都先过只读闸门 —— 闸门在边界上, 不在调用点

// 2. 跑一张卡: openDb 由宿主注入, 内核自己不知道库在哪
const runner = new Engine.EngineRunner({
  engine: card,
  databases: [{ id: 'db1', type: 'mysql', /* ... */ }],
  openDb: () => db                       // 或 (dbConf) => createReadOnlyDb(...)
});
const out = await runner.run({ poNo: 'PO20250328008262' });

// 3. 需要看某列真实存的是什么
const s = await Peek.peekColumnStats({
  db, dialect: 'mysql', table: 'purchase_order_detail',
  tb: '`purchase_order_detail`', col: '`received_status`'
});
```

`db` 的形状就是鸭子类型: `{ query(sql, params) → { rows, columns, rowCount } }`。

## 测试

回归测试在仓库的 `test/` 下 (不在本目录), 跟着仓库一起跑:

```sh
node --test test/solodb-core.test.js   # 核心包自己的边界测试
node --test "test/**/*.test.js"        # 全量
```

其中 `test/solodb-core.test.js` 里有一条**结构性**断言: 本目录下任何文件都不许
`require` 外部模块 (只允许相对路径与 Node 内建)。这是"零依赖"的护栏 ——
不然几个月后有人顺手 `require('mysql2')` 进来, 边界就悄悄没了。

## 现在的宿主

- **SoloDB 桌面端** (Electron): `lib/*.js` 里有几个**转发文件**指向这里, 所以仓库里
  原有的 `require('./engine.js')` 一类写法照旧能用, 拿到的就是本包里的同一个对象。
- (计划中) DSH 插件: 同一个内核, 外面套一层 Cordis 工具/服务。
