/**
 * 动作定义 + 容错解析
 *
 * 这个模块是"智能体能做什么"的唯一登记处, 有两件事:
 *
 * 1) BUILTIN_TOOLS —— 把内置动作写成 OpenAI function calling 的 tools 定义。
 *    **走原生工具通道以后, 工具描述就是提示词的一部分**, 所以这里的 description
 *    要写清"什么时候该用、什么时候不该用", 而不是只写参数。
 *
 * 2) parseDSML —— 兜底解析器。
 *    有些模型 (实测 deepseek-v4.1-flash) 即使没给它 tools, 也会把工具调用写成
 *    自家方言塞进正文, 例如:
 *      <|DSML|calls><|DSML|invoke name="load_skill">
 *      <|DSML|parameter name="name">lieflat-charts</|DSML|parameter>
 *      </|DSML|invoke></|DSML|calls>
 *    以前遇到这种输出直接判"无法解析"整单任务失败。现在先认再说 ——
 *    能翻译成动作就继续跑, 翻译不了才交给上层自纠错。
 *
 * 为什么要有第 2 条: 我们做的是垂类 harness, 底层是通用模型。
 * 通用模型的原生习惯 (工具调用方言、思维链) 会漏进来, harness 的职责是把它
 * 收敛到我们定义的动作空间里, 而不是假设模型永远守规矩。
 */

const CHART_TYPES = ['line', 'bar', 'area', 'pie', 'doughnut', 'scatter'];

/** 内置动作 → OpenAI tools 定义 */
const BUILTIN_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'sql',
      description:
        '执行一条只读 SQL 查询。每条 SQL 执行前都会让用户过目确认。' +
        '需要新数据时用它; 已经查到过的结果不要重跑。',
      parameters: {
        type: 'object',
        properties: {
          purpose: {
            type: 'string',
            description: '这一步在做什么, 一句话, 不懂 SQL 的人也能看懂。写"按供应商汇总采购金额", 不要写"执行 SELECT 语句"'
          },
          rationale: {
            type: 'string',
            description: '为什么需要这一步 —— 承接前面的什么发现, 或在回答哪个问题'
          },
          sql: { type: 'string', description: '要执行的只读 SQL (仅 SELECT / WITH / EXPLAIN / PRAGMA)' },
          fields: {
            type: 'array',
            description:
              '这一步用到的字段, 逐个给出中文含义。SELECT 输出的每一列都要列出 (含聚合别名, 否则表格会露出 total_rows 这种英文名); ' +
              'WHERE / JOIN / GROUP BY / ORDER BY 里用到的也一并列出; 整表查询写 [{"name":"*","meaning":"该表全部字段"}]',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: '字段名, 必须与 SQL 里出现的名字一致' },
                meaning: { type: 'string', description: '中文含义, 4~8 个字, 用业务语言' }
              },
              required: ['name']
            }
          }
        },
        required: ['purpose', 'sql']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'request_scope',
      description:
        '申请访问新的数据表。只在现有的表不够用时调用, 且只能申请"可访问的表"清单里列出的表。' +
        '用户确认后你才会拿到这些表的字段信息。缺字段信息时不要凭空编字段名, 先申请。',
      parameters: {
        type: 'object',
        properties: {
          tables: { type: 'array', items: { type: 'string' }, description: '要申请的表名' },
          reason: { type: 'string', description: '为什么需要这几张表' }
        },
        required: ['tables', 'reason']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description:
        '你确实要办这件事, 但缺一个关键口径, 不问清楚就没法往下做, 这时才用。' +
        '不要用它做自我介绍或闲聊 (那用 reply); 能从任务里读出来的就别问 —— ' +
        '用户说了要报告就直接出报告, 不要反过来问他"要 HTML 还是 Excel"。',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '要问用户的话' },
          options: { type: 'array', items: { type: 'string' }, description: '可选的候选答案, 最多 6 个' }
        },
        required: ['question']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'describe_table',
      description: '再看一次某张已确认表的结构。只在会话状态里给的字段信息不够用时才用。',
      parameters: {
        type: 'object',
        properties: { table: { type: 'string', description: '表名, 必须是本会话已确认的表' } },
        required: ['table']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_knowledge',
      description:
        '在知识库里检索**文档知识**: 制度、口径、SLA、政策、名词解释、操作说明。' +
        '当问题涉及规则/定义/依据, 或需要引用文档来支撑结论时用它。' +
        '它只返回相关片段, **不会替你组织答案** —— 你要自己读片段、综合成结论, ' +
        '并说明依据来自哪份文档; 直接把原文照抄回来是错的。' +
        '同一个问题不必反复检索 (历史里已经查过的片段不用重查)。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '检索词。用"问题里的关键词 + 你要的东西", 例如"供应商超期 判定口径"、"SLA 赔付上限"。别把整句话原样丢进来。'
          },
          kbId: { type: 'string', description: '要查的知识库 id (可选; 不填则用当前对话选中的知识库)' },
          topK: { type: 'number', description: '要几条 (可选, 默认按「知识库配置」里的 topK)' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'load_skill',
      description:
        '加载某个技能的完整内容。未加载前你只知道技能的名字和用途。' +
        '只在技能确实与当前任务相关时加载, 不要逐个加载进来"看看"。',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: '技能名, 见系统提示里的技能清单' } },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'reply',
      description:
        '只是跟用户说一句话, 不做任何取数。用于打招呼、介绍你能干什么、闲聊、' +
        '解释你刚才做了什么、回答关于这个软件本身的问题。' +
        '**这是唯一不碰数据库的收尾动作**: 说完这一轮就结束, 不会产生报告。',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '你要说的话' } },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description:
        '这一轮到此为止。取数类任务用它收尾 —— 资料够了就用, 不要再跑多余的 SQL。' +
        '交付成什么样由你定: 只是想让人知道结果, output 给 none 就够了; 要一份能看的网页给 html; ' +
        '要能拿去用的表格给 excel。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '这一轮的标题' },
          output: {
            type: 'string',
            enum: ['html', 'excel', 'none'],
            description:
              '交付形态。要看的 -> html; 要用的 (拿去对账/导进别的系统) -> excel; ' +
              '只是想知道结果 -> none (对话里直接把结果表摆出来)。三种没有主次。'
          },
          summary: { type: 'string', description: '一句话总结' },
          insights: {
            type: 'array',
            items: { type: 'string' },
            description:
              '结论, 每条是一个完整的判断 (如"华东区贡献 62% 的 GMV, 但客单价低于均值 18%"), ' +
              '不要罗列数据。数据是支撑结论的证据, 只在需要时引用关键数字。'
          },
          kpis: {
            type: 'array',
            description: '关键总量/比率指标, 最多 4 个',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                value: { type: 'string' },
                unit: { type: 'string' },
                hint: { type: 'string', description: '补充说明, 如"环比 +12%"' }
              },
              required: ['label', 'value']
            }
          },
          charts: {
            type: 'array',
            description:
              '图, 用来表达图上说得清的事 (长短/高低/趋势/占比)。只描述"画什么", 不要搬数据。' +
              '编号、名称、一一对应关系这类结果不必配图, 直接摆表更清楚; 一张不画也正常。',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                type: { type: 'string', enum: CHART_TYPES },
                source: { type: 'integer', description: '引用第几份已有资料 (就是状态里那个 [1] [2])' },
                x: { type: 'string', description: '维度字段名, 必须落在该结果的列里' },
                series: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string', description: '图例名' },
                      field: { type: 'string', description: '指标字段名, 必须落在该结果的列里' }
                    },
                    required: ['field']
                  }
                },
                note: { type: 'string', description: '这张图说明了什么' },
                stack: { type: 'boolean', description: '柱状图是否堆叠' },
                colorBy: {
                  type: 'string',
                  enum: ['dimension'],
                  description: '用户要求"不同类别用不同颜色"时填 dimension'
                }
              },
              required: ['title', 'type', 'source', 'x', 'series']
            }
          }
        },
        required: ['title', 'output']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_workflows',
      description:
        '列出这台机器上已经搭好的流程卡 (工作流)。' +
        '每张卡带上: 它解决什么问题、什么时候该用它、需要哪些入参 (含义 + 备注 + 是不是任选其一)。' +
        '当用户描述的是一个**已知的排查/判断场景**, 先调它看看有没有现成的卡 —— ' +
        '有卡就直接 run_workflow, 不用自己从表开始查。' +
        '如果用户只是想随便看看数据, 就别调它。',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_workflow',
      description:
        '跑一张流程卡。卡里已经把判断逻辑写死了, 你只需要给出它的入参。' +
        '入参从用户的话里抽 —— 抽不到就别猜, 先 ask_user 问清楚。' +
        '标了【任选其一】的入参组给一个就够, 不要硬凑齐。' +
        '调之前最好先 list_workflows 看清它要什么。',
      parameters: {
        type: 'object',
        properties: {
          engineId: { type: 'string', description: '流程卡 id (来自 list_workflows)' },
          inputs: {
            type: 'object',
            description: '入参: {入参名: 值}。只需要给用户实际提供了的那几个。',
            additionalProperties: { type: 'string' }
          },
          why: {
            type: 'string',
            description: '为什么选这张卡、以及你把用户给的哪个值当成了哪个入参 (一句话, 会给用户看)'
          }
        },
        required: ['engineId', 'inputs']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'look_at_data',
      description:
        '看某一列**真实存的是什么**: 抽样取值、空值占比、去重后的取值分布。' +
        '写 CASE WHEN、判断枚举值的含义、或者不确定某列能不能当关联键之前用它 —— 不要凭字面猜。' +
        '库里存的值经常跟字段名给人的印象不一样 (比如 ack_state 存的是 1/2 还是"已确认")。' +
        '这是只读抽样, 不弹确认框, 也不返回全量数据。' +
        '注意: 超过 100 万行的表只给**前 5 万行抽样**, 结果里会标明"抽样" —— ' +
        '抽样足以看清枚举值长什么样, 但空值率可能不代表全表, 别据此下"这列是空的"这种结论。',
      parameters: {
        type: 'object',
        properties: {
          table: { type: 'string', description: '表名, 必须是本会话已确认的表' },
          column: { type: 'string', description: '要看的列名' },
          why: { type: 'string', description: '想看什么, 一句话 (会给用户看)' }
        },
        required: ['table', 'column']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'check_index',
      description:
        '看某张表 (或某个列) 有没有索引。按没有索引的列过滤大表会全表扫几十秒 —— ' +
        '表现出来像卡死, 其实是慢查询。某一步跑得异常慢时用它确认, 再换一个有索引的等价列。',
      parameters: {
        type: 'object',
        properties: {
          table: { type: 'string', description: '表名, 必须是本会话已确认的表' },
          column: { type: 'string', description: '关心的列, 可以不给 (不给就看整张表的索引)' }
        },
        required: ['table']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_result',
      description:
        '把本会话早先某次查询的结果**逐行读回来**。' +
        '会话状态里的"已有资料"只给了列名和行数, 看不到具体值 —— 要按某个值排序、' +
        '逐条看明细、或者核对一个具体数字时用它, 不用为了看一眼就把整条 SQL 重跑一遍。' +
        '注意: 这是**当时**查到的结果, 如果你要的是"现在"的数据, 应该用 sql 重查。',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: '第几份资料, 就是会话状态里那个 [1] [2]' },
          offset: { type: 'integer', description: '从第几行开始, 默认 0' },
          limit: { type: 'integer', description: '读多少行, 默认 50, 最多 200' }
        },
        required: ['index']
      }
    }
  }
];

/** 内置动作名集合, 供上层判断一个调用是不是自家的 */
const BUILTIN_NAMES = new Set(BUILTIN_TOOLS.map((t) => t.function.name));

// ==================== 容错解析 ====================

/**
 * 认模型漏出来的工具调用方言。
 *
 * 形状 (不同版本可能带空格/全角, 所以先归一化再匹配):
 *   <|DSML|calls>
 *     <|DSML|invoke name="工具名">
 *       <|DSML|parameter name="参数名" string="true">值</|DSML|parameter>
 *     </|DSML|invoke>
 *   </|DSML|calls>
 *
 * @returns { name, args } 或 null
 */
function parseDSML(text) {
  if (!text || !/dsml/i.test(text)) return null;

  // 第 1 步 全角 → 半角。模型漏方言时经常混着全角标点,
  // 全角 ＜ ＞ 是 U+FF1C / U+FF1E, 跟 ASCII 的不是一个字符, 不换就永远匹配不上。
  // 把竖线类字符 (| ｜ 丨 │) 也统一成 ASCII 竖线。
  const flat = String(text)
    .replace(/[＜《〈]/g, '<')
    .replace(/[＞》〉]/g, '>')
    .replace(/[｜丨│]/g, '|');

  // 第 2 步 把 marker 归一化, 容忍 token 之间的任意空白:
  //   < | | DSML | | calls >  ->  <|DSML|calls>
  const norm = flat
    // 开标签 (可能带属性: <|DSML|invoke name="x"> / <|DSML|parameter name="y" string="true">)
    .replace(/<\s*(?:\|\s*)+dsml\s*(?:\|\s*)+([a-z_]+)([^>]*?)\s*>/gi, (m, tag, attrs) => `<|DSML|${tag.toLowerCase()}${attrs}>`)
    // 闭标签 (先跑开标签不会误伤它: 闭标签 '<' 后面跟的是 '/', 不满足 '\|+')
    .replace(/<\s*\/\s*(?:\|\s*)+dsml\s*(?:\|\s*)+([a-z_]+)\s*>/gi, (m, tag) => `</|DSML|${tag.toLowerCase()}>`);

  const invokeRe = /<\|DSML\|invoke\s+name\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)<\/\|DSML\|invoke>/i;
  const im = norm.match(invokeRe);
  if (!im) return null;

  const name = im[1].trim();
  const body = im[2];
  const args = {};

  const paramRe = /<\|DSML\|parameter\s+([^>]*?)>([\s\S]*?)<\/\|DSML\|parameter>/gi;
  let pm;
  while ((pm = paramRe.exec(body))) {
    const attrs = pm[1];
    const rawValue = pm[2];
    const nameMatch = attrs.match(/name\s*=\s*["']([^"']+)["']/i);
    if (!nameMatch) continue;
    const key = nameMatch[1].trim();
    const isString = /string\s*=\s*["']?\s*(true|false)/i.exec(attrs);
    const asString = isString ? isString[1].toLowerCase() === 'true' : true;
    const value = rawValue.trim();
    if (asString) {
      args[key] = value;
    } else {
      try { args[key] = JSON.parse(value); } catch (e) { args[key] = value; }
    }
  }

  return { name, args };
}

/**
 * 一次调用里可能带多个动作名变体 (如 "load_skill" / "load_skill:" ), 统一清洗。
 */
function normalizeToolName(name) {
  return String(name || '').trim().replace(/[:\s]+$/, '');
}

module.exports = {
  BUILTIN_TOOLS,
  BUILTIN_NAMES,
  CHART_TYPES,
  parseDSML,
  normalizeToolName
};
