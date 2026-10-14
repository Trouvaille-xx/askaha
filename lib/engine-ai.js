/**
 * 流程卡 AI 搭建 —— 用对话把一张卡搭出来, 过程实时画到画板上。
 *
 * 和"分析模式"的区别:
 *   分析模式: 模型每步临场决定查什么, 出来的是结论。
 *   这里:     模型帮你把一张**卡**写出来 —— 摆哪些节点、怎么连、SQL 怎么写、
 *             条件怎么判、结论怎么拼。产出是一张可复用的卡, 不是一次结论。
 *
 * 工具集就是"作者在画板上能做的动作"的投影: 加节点 / 删节点 / 改节点 / 连线 / 校验 / 试跑。
 * 每做一步都 emit 一个事件, 界面据此把图画出来 —— 用户能看着图被搭出来。
 *
 * 关于"改现有卡" (这一条最容易做错):
 *   传进来的 card 可能是用户已经搭了一半的卡。**绝不能推倒重来** ——
 *   它只该在现有节点上增、删、改。所以:
 *     - 系统提示词里把"当前草稿"摆全, 并明确要求"保留已有的东西";
 *     - 工具层面给 delete_node / set_node_title, 让它有"删"和"改"的正规动作,
 *       而不是靠"重画一张"来达到目的;
 *     - 每改一步都重算草稿快照, 它看到的永远是当下这张图。
 *
 * 关于自测:
 *   搭完必须自测。两道: validate_draft (静态体检) 和 run_test (带样例输入真跑)。
 *   两道都过了才允许 finish —— 提示词里写了硬要求, finish 时也会再拦一次。
 *
 * 关于库表范围:
 *   模型只能看到调用方传进来的 pool (用户在「配置」里勾的那个范围)。
 *   它必须先在这个范围里圈出真正用到的表, 再动手 —— 不会自己扩大范围。
 *   读表结构走 DESCRIBE, 只读元数据, 不碰业务数据。
 *
 * 关于引用写法 (最容易踩的坑, 提示词里单独讲):
 *   查询出来的列 -> {{节点id.列名}}
 *   入口字段     -> {{字段名}}
 *   行数         -> {{节点id.rowCount}}
 *   裸列名不会被解析到, 一律渲染成空。
 */

const Engine = require('./engine.js');
const Prompt = require('./prompt.js');
const { ToolRegistry } = require('./tools.js');
const Loop = require('./agent-loop.js');
const { AgentLoop } = Loop;
const { AgentContext } = require('./context.js');
const Peek = require('./data-peek.js');
const TableMatch = require('./table-match.js');

// 搭一张卡要走的步数: 看表 -> 配入口 -> 一张表一个取数节点(加+配) -> 条件(加+配)
// -> 每个分支一个出口(加+配) -> 连线 -> 自检 -> 收尾。稍微复杂的卡三十步打不住,
// 16 步会把它拦腰截断, 图搭一半就停了。
//
// 注意这是**一轮**的步数, 不是总共 —— 一轮跑满会自动续下一轮, 见 MAX_ROUNDS。
const MAX_TURNS = 40;

/**
 * 一轮步数跑满之后, 自动接着跑几轮。
 *
 * 为什么要有: 以前跑满 40 步就停下, 在界面上留一句「再说一句"继续"可以接着改」,
 * 让用户手动再推一把。但**系统明确知道卡没搭完** —— `this.finished` 就是那个凭据,
 * 它只在 finish 真的通过闸门时才为 true。继续这件事不需要用户的判断力。
 *
 * 更糟的是这条信息会绕一圈: 系统的 nudge 告诉**模型**"步数快用完了, 请收敛",
 * 模型没法给自己加预算, 只好回头告诉**用户**"再说一句继续"。系统 -> 模型 -> 用户,
 * 两跳推诿, 最后是用户在替系统干活。
 *
 * 为什么仍然要有上限: 模型可能陷进"改一点 -> 自检不过 -> 再改一点"的循环。
 * 不设上限就是无限烧 token。到顶之后如实交回用户, 并说清跑了多少步。
 */
const MAX_ROUNDS = 3;

const MAX_TABLES_DESCRIBE = 12;
// 一次 look_at_data 最多看几列。给到 12: 再多说明它在瞎扫,
// 该先 describe_tables 看清楚有哪些列, 而不是把整张表挨个看一遍。
const MAX_LOOK_COLUMNS = 12;

/**
 * 搭建预算的取值范围 —— **单一事实来源**。
 *
 * main.js 的设置页按它夹取用户输入, 测试也用它。放在这里而不是 main.js:
 * 那两个默认值就是本文件的 MAX_TURNS / MAX_ROUNDS, 分开放迟早会对不上;
 * 而且 main.js 要 Electron 才能 require, 放那儿就没法测。
 *
 * 上限给到 120 步: 再大就是一次对话烧掉一整天的额度, 而真到那一步说明
 * 该把流程拆小, 不是该继续加步数。
 */
const BUILDER_LIMITS = {
  maxSteps: { min: 10, max: 120, fallback: MAX_TURNS },
  maxRounds: { min: 1, max: 5, fallback: MAX_ROUNDS }
};

/** 把外面传进来的搭建参数夹到合法范围 (越界取边界, 不是默认值) */
function normalizeBuilderLimits(input) {
  const src = (input && typeof input === 'object') ? input : {};
  const out = {};
  for (const key of Object.keys(BUILDER_LIMITS)) {
    const lim = BUILDER_LIMITS[key];
    // 注意不能直接 Number(raw): **Number(null) === 0, Number('') === 0**。
    // 那会把"这一项没填"当成填了 0, 然后被夹成下限 —— 用户看到的是
    // "我什么都没动, 它自己变成最小值了"。没填就该走默认值。
    const raw = src[key];
    const n = (raw === null || raw === undefined || raw === '') ? NaN : Number(raw);
    out[key] = Number.isFinite(n) ? Math.min(lim.max, Math.max(lim.min, Math.floor(n))) : lim.fallback;
  }
  return out;
}

/* ==================== 工具定义 ==================== */

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_available_tables',
      description: '列出本次可用的表。动手之前先用它看看有哪些表可选。',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'describe_tables',
      description:
        '读这几张表的字段结构 (只有列名和类型, 不读数据)。写 SQL 前必须先用它确认字段名, 不要凭猜。' +
        '一次别超过 12 张。只能用本次可用的表。',
      parameters: {
        type: 'object',
        properties: {
          tables: { type: 'array', items: { type: 'string' }, description: '要看的表名列表' },
          why: { type: 'string', description: '为什么需要这几张表, 一句话' }
        },
        required: ['tables']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description:
        '向用户提问, 然后停下等回答。什么时候用: 可用的表里有多张看起来都沾边、选哪张会影响结果; ' +
        '或者用户的业务逻辑有关键含糊处 (比如"无数据"具体指什么)。别拿它寒暄, 也不要在自己能判断时滥用。',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '要问的问题, 一句话说清, 必要时把候选列出来' }
        },
        required: ['question']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ask_choice',
      description:
        '**一次只问一个问题**, 并且把答案做成选项让用户在页面上点选 —— 比 ask_user 的纯文字提问更好答。' +
        '搭卡前澄清需求时优先用这个: 确认输入是什么、最终输出要什么、中间分几步、在哪一步分叉。' +
        '选项要写成人话 (用户看得懂的业务说法), 每个选项给一句说明为什么可能是它。' +
        '用户还能自己补充 —— 所以别把选项写死成"只有这几个可能"。',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '要问的问题, 一句话, 不要塞多个问题' },
          why: { type: 'string', description: '为什么问这个 (会显示在问题下面一行小字)' },
          multi: { type: 'boolean', description: '是否允许多选。问"输入可以是哪些类型"这类就该 true' },
          options: {
            type: 'array',
            description: '2-6 个候选, 用户点一下就选中',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: '选项名 (用户看到的字)' },
                desc: { type: 'string', description: '一句说明, 帮用户判断选哪个' },
                value: { type: 'string', description: '这个选项对应的值, 不给就用 label' }
              },
              required: ['label']
            }
          },
          placeholder: { type: 'string', description: '用户想自己填时, 输入框里的提示语' },
          allowText: { type: 'boolean', description: '是否允许用户自己补充 (默认 true)' }
        },
        required: ['question', 'options']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'add_node',
      description:
        '往画板上加一个节点。返回的 id 后面配它、连它都要用。每加一个, 画板上就多一个方块。' +
        '入口一张卡只能有一个: 草稿里已经有入口就直接 configure_input 配它, 别再新增。',
      parameters: {
        type: 'object',
        properties: {
          nodeType: { type: 'string', enum: ['input', 'query', 'condition', 'output'], description: '节点类型' },
          title: { type: 'string', description: '节点标题, 用人话写, 如"查订单入库状态"' }
        },
        required: ['nodeType', 'title']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_node',
      description:
        '删掉一个节点 (连着它身上所有的线一起消失)。' +
        '只有在草稿里那个节点确实多余、或者你要用一个新节点替掉它时才用。' +
        '**不要为了"重新搭一遍"而删掉用户已经配好的节点** —— 想改什么就改什么, 别推倒重来。',
      parameters: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: '要删的节点 id' },
          why: { type: 'string', description: '为什么它多余, 一句话' }
        },
        required: ['nodeId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_node_title',
      description: '改一个节点的标题。标题是给人看的, 改它不影响逻辑。',
      parameters: {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          title: { type: 'string', description: '新的标题' }
        },
        required: ['nodeId', 'title']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'connect',
      description:
        '把两个节点接上, 接成一条链。普通节点用 port="out"; 条件节点两个出口: 成立走 port="true"、不成立走 port="false"。' +
        '注意一个出口只能接一条线: 那个出口上已经有线了就会失败, 说明你在搭菱形 —— 改成串行 (A→B→C), 真要走另一条先把旧线 disconnect 掉。',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: '上游节点 id' },
          to: { type: 'string', description: '下游节点 id' },
          port: { type: 'string', enum: ['out', 'true', 'false'], description: '从哪个口出去, 默认 out' }
        },
        required: ['from', 'to']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'disconnect',
      description: '拆掉某个出口上的线。接错了、或者要把出口改接到别的节点时用它。',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: '上游节点 id' },
          port: { type: 'string', enum: ['out', 'true', 'false'], description: '拆哪个口, 默认 out' }
        },
        required: ['from']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'configure_input',
      description:
        '配入口节点: 这张卡运行时需要从用户那句话里抽哪些信息。' +
        '字段名要用业务上有意义的英文, 如 orderNo / deliveryNo, 配一个中文标签。' +
        '每一项都要写 desc —— 说明这一项要的到底是什么(形如什么样、在哪个系统里), ' +
        '因为用户那句话里只有一个值, 模型要靠 desc 判断它属于哪一项。' +
        '如果这张卡支持"几种单号任选其一", 就把这几项写成同一个 group, 组内给一个就够。',
      parameters: {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          fields: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string', description: '字段名, 英文, 如 orderNo' },
                label: { type: 'string', description: '中文标签, 如 采购订单号' },
                desc: {
                  type: 'string',
                  description:
                    '这一项要什么, 越具体越好。写清格式和来源, 例如「SRM 送货单号, 形如 DN2024xxxx」' +
                    '或「Odoo 里的红字发票号, 纯数字」。别只重复标签。'
                },
                required: { type: 'boolean', description: '单独必填。写进 group 的字段不用管这个' },
                group: {
                  type: 'string',
                  description:
                    '任选其一的分组名, 如「单号」。同一组的字段只要有一个有值就算齐了。' +
                    '用了 group 就必须同时在卡里加条件节点按「哪一项有值」分流 (见提示词里的说明)。'
                }
              },
              required: ['key', 'label']
            }
          }
        },
        required: ['nodeId', 'fields']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'configure_query',
      description:
        '配取数节点: 连哪个库的哪张表、跑什么 SQL、产出哪些列。' +
        'SQL 里的参数写成 {{入口字段名}} 或 {{上游节点id.列名}}。列出来的 outputs 是后面条件与结论能引用的名字。' +
        'outputs 每项是 {key, label, type}; type 可选 (string/number/bool/date), 声明了就帮你查出"数字列跟文本比较"这类错。' +
        '改一条已有的 SQL 也是用它: 只传要改的字段, 没传的保持原样 (比如只想换 SQL 就不用再传 table)。',
      parameters: {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          databaseId: { type: 'string', description: '库的 id' },
          table: { type: 'string', description: '表名' },
          sql: { type: 'string', description: "只读 SELECT。字符串参数写成 '{{xxx}}', 数字参数写成 {{xxx}}" },
          outputs: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string', description: 'SELECT 出来的列名' },
                label: { type: 'string', description: '中文名, 如 入库状态' }
              },
              required: ['key']
            }
          }
        },
        required: ['nodeId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'configure_condition',
      description:
        '配条件节点: 按规则分岔。左值是引用, 查询出来的列写成 节点id.列名, 入口字段写裸名, 行数写 节点id.rowCount。' +
        '多项之间用 logic=and/or 组合。',
      parameters: {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          logic: { type: 'string', enum: ['and', 'or'], description: '多项之间怎么组合, 默认 and' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                left: { type: 'string', description: '左值引用, 如 n_q1.inbound_status 或 n_q2.rowCount' },
                op: {
                  type: 'string',
                  enum: ['==', '!=', '>', '>=', '<', '<=', 'contains', 'notContains', 'empty', 'notEmpty'],
                  description: '比较算子。"为空"用 empty, "有值"用 notEmpty'
                },
                right: { type: 'string', description: '右值。op 是 empty/notEmpty 时留空' }
              },
              required: ['left', 'op']
            }
          }
        },
        required: ['nodeId', 'items']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'configure_output',
      description:
        '配出口节点: 用模板拼出给用户看的结论。引用查询出来的列写成 {{节点id.列名}}, 入口字段写 {{字段名}}。' +
        '模板里引用的每一个名字都必须真的存在, 否则渲染出来是空的。' +
        '要列**一批行** (明细清单) 不能只写 节点id.列名 —— 那只取首行。两种多行写法:' +
        '① {{节点id.rows}} 把整个结果集铺成 markdown 表格 (列名即 SQL 查出来的列);' +
        '② {{#each 节点id.rows}}...{{/each}} 逐行渲染, 循环体里的裸名就是当前行的那一列, 序号写 {{@index}}。' +
        '循环只能一层, 只能遍历 节点id.rows; 判断"查到没有"用 节点id.rowCount。',
      parameters: {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          template: { type: 'string', description: '结论模板, 如"该订单明细已入库，但未找到待对账入库单：存在问题"' }
        },
        required: ['nodeId', 'template']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'validate_draft',
      description: '静态体检: 检查当前草稿有没有问题 (断链、缺 SQL、引用对不上、分支引用错)。搭完改完都要调一次。',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_test',
      description:
        '拿一组样例输入把这张卡**真跑一遍**, 看它到底能不能出结论 —— 这是唯一能证明卡能用的办法, 静态体检查不出 SQL 写错。' +
        '收尾之前必须至少成功跑通一次。跑出来哪一步断了, 就去修那一步, 再跑。' +
        '入口字段有必填项时必须把值给上, 否则跑不起来。' +
        '\n\n**只改了一个节点时, 用 reuse 把没动的节点跳过去。** ' +
        '把上一次试跑返回的 `sqlByNode` 原样传进 reuse, 那些 SQL 一个字都没变的节点就不会再查库, ' +
        '直接沿用上次的结果 —— 试跑会快很多。改过的节点因为 SQL 变了, 照旧真跑。' +
        '**这不是偷懒**: 实测一张 4 节点的卡重跑一次要 100~400 秒, 而其中大半时间花在没改的节点上。' +
        '\n\n**只想先确认链路通不通时, 用 probe:true 探针跑一遍** —— 给每条取数 SQL 套一层行数上限 (只取前 200 行), 秒级返回。' +
        '它能确认"SQL 跑得通、字段对得上、走哪条分支", 但**结果被截断, 不能当最终验证** —— 通了之后再真跑一次。',
      parameters: {
        type: 'object',
        properties: {
          inputs: {
            type: 'object',
            description: '入口字段的样例值, 如 {"orderNo": "SO178937315868747377"}。用户给了示例就用用户的, 没给就自己编一个看起来像真的。'
          },
          reuse: {
            type: 'object',
            description: '上一次试跑返回的 sqlByNode, 原样贴回来即可。只有 SQL 没变的节点会被跳过; 不传就全跑。'
          },
          probe: {
            type: 'boolean',
            description: '探针跑: 给每条取数 SQL 套行数上限, 只验"跑得通 / 字段对 / 分支走向", 秒级返回。结果被截断, 不能替代最终的真跑。'
          }
        },
        required: ['inputs']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'plan_task',
      description:
        '**动手建卡之前必须先调这个** —— 出一版规划 (相当于先写 PRD 再开发)。' +
        '\n\n没出规划之前, 建节点/连线/写 SQL 这些工具全都会被拦下来。查资料的' +
        '(list_available_tables / describe_tables / look_at_data / find_value / check_index) 不受限制 —— ' +
        '规划本来就要靠那些信息才写得出来, 所以顺序是: **先查清楚 -> 再出规划 -> 再动手建 -> 最后才测**。' +
        '\n\n**为什么必须先规划**: 边建边试看起来快, 实际上会让同一个问题被反复"试"出来。' +
        '实测一个会话 run_test 被叫了 16 次、花了 33 分钟 (占全部工具时间的 99.7%), 其中 8 次是在' +
        '对同一个节点的引号问题反复试 —— 因为它从来没先把整条链路想清楚。' +
        '\n\nbranches 是必须的: 这张卡最终会输出哪几个结论。列不出结论就是需求还没想清楚。' +
        '\n\n规划之后要改是可以的 (发现漏了一步、或者某步不必要), 再调一次这个工具出下一版即可 —— ' +
        '已经标过完成的步骤会保留状态。',
      parameters: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            description: '要做的步骤, 按执行顺序。至少两步。',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '短 id, 如 s1。不给自己编一个。' },
                title: { type: 'string', description: '这一步做什么, 一句话。如"查采购订单明细及入库状态"。' },
                kind: { type: 'string', description: 'input / query / condition / output 之一。' },
                detail: { type: 'string', description: '拿哪张表、按什么条件、关键列是什么。写具体。' }
              },
              required: ['title']
            }
          },
          branches: {
            type: 'array',
            items: { type: 'string' },
            description: '这张卡会输出的**全部结论**, 每条一句。如 ["未全部入库, 暂无法发起对账", "入库无误, 待供应商对账", "入库异常, 请找开发处理"]。必填。'
          },
          unknowns: {
            type: 'array',
            items: { type: 'string' },
            description: '还没确认的事。如 ["待对账按 billed_qty=0 还是 is_generate_account 算"]。'
          }
        },
        required: ['steps', 'branches']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'plan_step_done',
      description:
        '把规划里的某一步标记为做完了。做完一步就标一下 —— run_test 会检查"规划里的步骤是不是都做完了", ' +
        '还有没做完的就不让测。',
      parameters: {
        type: 'object',
        properties: {
          stepId: { type: 'string', description: '步骤 id (如 s3), 或者它的标题。' },
          note: { type: 'string', description: '这一步实际怎么做的, 有没有跟规划不一样。' }
        },
        required: ['stepId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_card',
      description:
        '**一次性把整张卡写出来** —— 传一整张卡 JSON (name + nodes + edges), 而不是一个个 add_node。' +
        '\n\n**搭新卡、或大改一张卡时优先用它, 比逐个加节点快得多** (逐个加节点要几十次往返)。' +
        '小改 (改一句 SQL、改一个标题、加一条线) 仍然用 configure_query / set_node_title / connect 等增量工具, 不要为小改整张重写。' +
        '\n\n写法要点: 一张 input(入口, 只放一个) + 至少一个 output(出口); ' +
        'query 节点带 databaseId / table / sql (只读 SELECT) / outputs (每项 {key, label, type}, type 可选); condition 节点带 expr; edges 把节点连起来, 条件节点两个口用 port=true / false。' +
        '\n\n写完系统会自动体检: 有硬错会原样退回让你改, 没错才落图。落图之后仍要 validate_draft + run_test 才能 finish。',
      parameters: {
        type: 'object',
        properties: {
          card: {
            type: 'object',
            description: '整张卡。形状照「卡的结构」+「引用语法」两段里写的来。',
            properties: {
              name: { type: 'string', description: '卡名, 人话, 如"采购订单入库核对"' },
              description: { type: 'string', description: '一句话说明这张卡干什么、什么时候用' },
              examples: { type: 'array', items: { type: 'string' }, description: '用户可能怎么问它 (1-3 条)' },
              nodes: { type: 'array', items: { type: 'object' }, description: '节点数组, 每个都要有 id 和 type' },
              edges: { type: 'array', items: { type: 'object' }, description: '连线 [{from,to,port}], port 默认 out' }
            },
            required: ['nodes', 'edges']
          }
        },
        required: ['card']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'recall',
      description:
        '取回一条**被折叠掉的旧结果**的全文。' +
        '\n\n对话长了之后, 早期的工具结果会被压成存根 (只留开头一小段), 存根尾上写着' +
        '「全文还在, 用 recall("h3") 取回」。看到那个编号就来这里取。' +
        '\n\n**为什么必须用它**: 折掉的往往是"我已经验证过的事实" —— 关联键是什么、某列存的是什么形态。' +
        '不取回来就会**重新查一遍库**, 而一次真跑要几十秒到几分钟; 取回来不到 1 秒。' +
        '如果记不清某个结论是怎么来的, 先 recall, 别急着重跑。',
      parameters: {
        type: 'object',
        properties: {
          handle: { type: 'string', description: '存根上写的编号, 形如 h3。' }
        },
        required: ['handle']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'render_sql',
      description:
        '把某个取数节点的 SQL **按当前上下文渲染出来看一眼**, 但不发给数据库 —— 瞬间返回。' +
        '\n\n**什么时候必须用它**: 某个 node 查出来是 0 行, 而你不确定是「真的没有」还是「参数没套对」的时候。' +
        '跨库传参最常见的坑是: 一个参数里装的是**列表**, 代入后会变成 IN (\'a,b,c\') 这种一整个字符串, ' +
        '而不是 IN (\'a\',\'b\',\'c\') —— 库那边只会老老实实告诉你是 0 行, 不会报错。' +
        '光看 SQL 模板看不出来, 试跑一百次也看不出来, 只有渲染出来才看得见。' +
        '\n\n先 run_test 一次, 再调它 —— 上游节点的真实取值来自上一次试跑。' +
        '**不要为了确认渲染结果去反复 run_test, 那一次要 100 秒以上, 这个不到 1 秒。**',
      parameters: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: '要看的取数节点 id。' }
        },
        required: ['nodeId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'look_at_data',
      description:
        '看某一列(或几列)**真实存的是什么**: 抽样取值、空值占比、去重后的全部取值。' +
        '写 CASE WHEN 之前、或者不确定某个字段能不能当关联键时用它 —— 不要凭猜。' +
        '比如要判断 ack_state 该映射成什么中文, 或者某个外键是不是几乎全空。' +
        '**要看多列就用 columns 数组一次给全**, 别一列调一次 —— 每次调用都吃一步预算。' +
        '注意: 超过 100 万行的表只给**前 5 万行抽样**, 结果里会标明"抽样" —— ' +
        '抽样数字不能当成全表结论 (尤其空值率)。大表上要靠它回答"哪一列能挂到 X 上"' +
        '这种关联问题往往是白花时间: 看值的形态 (前缀/长度) 或 check_index 更快, ' +
        '真正的答案要用一条 JOIN 试出来 (写进 SQL 节点跑 run_test)。',
      parameters: {
        type: 'object',
        properties: {
          dbId: { type: 'string', description: '库 id' },
          table: { type: 'string', description: '表名' },
          column: { type: 'string', description: '要看的列 (只看一列时用)' },
          columns: {
            type: 'array',
            items: { type: 'string' },
            description: '要看的列, 一次看多列时用这个 —— 一列调一次会白烧步数'
          },
          why: { type: 'string', description: '想看什么' }
        },
        required: ['dbId', 'table']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'find_value',
      description:
        '**问"这个值到底存在哪一列"** —— 给它一个单号/编号, 它去这张表里逐列试, ' +
        '告诉你哪一列真的装着它、哪些列试过没有。' +
        '回答"这两张表靠哪一列关联"时用它, **不要自己写 `WHERE a LIKE ... OR b LIKE ...` 那种探针**: ' +
        '那是全表扫描, 几百万行的表一条就是几十秒到两分钟, 而且试错要试好几轮。' +
        '这个工具会自动挑"查得动"的列 (大表只试有索引的), 并且有硬预算 —— ' +
        '它**不会**为了给答案把库拖死。',
      parameters: {
        type: 'object',
        properties: {
          dbId: { type: 'string', description: '库 id' },
          table: { type: 'string', description: '表名' },
          value: { type: 'string', description: '要找的值, 比如 PO20260921000003' },
          values: {
            type: 'array',
            items: { type: 'string' },
            description: '一次找多个值时用这个 (比一个值调一次省事)'
          }
        },
        required: ['dbId', 'table']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'check_index',
      description:
        '看某个列有没有索引。按没有索引的列过滤大表会全表扫几十秒 —— 看起来像卡死, 其实是慢查询。' +
        '如果这一步跑得异常慢, 用它确认, 再找一个有索引的等价列。',
      parameters: {
        type: 'object',
        properties: {
          dbId: { type: 'string' },
          table: { type: 'string' },
          column: { type: 'string', description: '关心的列, 可选' }
        },
        required: ['dbId', 'table']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'reply',
      description:
        '只是跟用户说一句话, 不碰这张卡。用于打招呼、回答"这个软件怎么用"、解释你刚才做了什么、' +
        '或者用户只是随口聊两句。**用户没在让你搭卡或改卡时, 用它, 不要去做搭卡的动作。**',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要说的话' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: '搭完了, 跟用户交代一句这张卡怎么跑。调了它就结束这一轮。',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '这张卡的执行路线, 用人话讲, 两三句' }
        },
        required: ['summary']
      }
    }
  }
];

/**
 * 内置工具的名字。分发时用它区分"这是内置动作"还是"该往 MCP 送"。
 * 从 TOOLS 直接推出来, 不手写第二份 —— 手写的那份迟早和 TOOLS 对不上。
 */
const BUILDER_TOOL_NAMES = new Set(
  TOOLS.map((t) => t && t.function && t.function.name).filter(Boolean)
);

/**
 * 会改动这张卡的工具。
 *
 * 没出规划之前这些一律拦住 (见 _runToolInner 里的规划闸门)。查资料的工具
 * **故意不在这个集合里** —— 规划要靠它们才写得出来, 拦了就等于让模型闭着眼睛写方案。
 * ask_user / ask_choice 也不在: 需求不清楚时本来就该先问, 而不是先规划。
 */
const BUILD_MUTATORS = new Set([
  'add_node', 'delete_node', 'set_node_title', 'connect', 'disconnect',
  'configure_input', 'configure_query', 'configure_condition', 'configure_output',
  // 整张重写也是"改图" —— 没出规划之前一样要拦住 (见下面的规划闸门)
  'write_card'
]);

/* ==================== 系统提示词 ==================== */

/**
 * 系统提示词。
 *
 * 散文部分现在住在 lib/prompt-sets.js 的 BUILDER_MODULES 里, 界面上「设置 · 提示词 ·
 * 搭建 Agent」那一组能直接改; 这里只负责把**每轮现算的东西**填进占位符。
 *
 * 为什么散文要搬出去:
 *   以前这一整段硬编码在这个函数里, 用户看得见"对话 Agent"的提示词、改得了一套,
 *   却不知道搭建 Agent 的提示词长什么样, 更别提改。而搭建 Agent 恰恰是最需要按自己
 *   业务调的那个 —— 它的规矩 ("必须 run_test"、"任选其一的入口要分流") 直接决定
 *   搭出来的卡对不对。
 *
 * 一条硬约束: 默认配置下这里拼出来的字符串必须和搬之前**逐字节相同**。
 *   test/prompt-sets.test.js 拿搬迁前的快照做比对, 搬错一个字都会红。
 *
 * @param promptConfig 用户改过的提示词配置 (可空 -> 全用出厂值)
 */
function buildSystemPrompt(card, pool, described, dbNames, promptConfig) {
  return Prompt.buildSetPrompt(promptConfig, 'builder', {
    // 草稿里已经有节点 -> 拼上"你是在改一张已有的卡"那一段
    hasDraft: (card.nodes || []).length > 2,
    hasDescribed: !!(described && described.size),
    scope_tables: poolLines(pool, dbNames),
    described_tables: describedLines(described),
    draft_json: JSON.stringify(draftBrief(card, dbNames), null, 2)
  });
}

/** "你已经看过的表结构"那几行。原来内联在 buildSystemPrompt 里, 搬出来给占位符用。 */
function describedLines(described) {
  if (!described || !described.size) return '';
  const out = [];
  for (const [k, cols] of described.entries()) {
    out.push(`- ${k}: ${cols.map((c) => c.field + (c.type ? '(' + c.type + ')' : '')).join(', ')}`);
  }
  return out.join('\n');
}

function poolLines(pool, dbNames) {
  const nameOf = (id) => (dbNames && dbNames[id]) || id;
  const out = [];
  for (const dbId of Object.keys(pool || {})) {
    const tables = pool[dbId] || [];
    if (!tables.length) continue;
    out.push(`- 库 ${nameOf(dbId)} (id=${dbId}): ${tables.join(', ')}`);
  }
  return out.length ? out.join('\n') : '- (还没有配范围, 先让用户配置)';
}

/**
 * 只挑模型需要知道的字段, 免得草稿一大就淹了提示词。
 * 取数节点要带上"哪个库的哪张表" —— 同名表跨库时, 只给表名它分不清是哪个。
 */
function draftBrief(card, dbNames) {
  const dbOf = (id) => (dbNames && dbNames[id]) || id || '(没选)';
  return {
    nodes: (card.nodes || []).map((n) => {
      const o = { id: n.id, type: n.type, title: n.title };
      if (n.type === 'input') o.fields = (n.fields || []).map((f) => f.key);
      if (n.type === 'query') {
        o.database = dbOf(n.databaseId);
        o.table = n.table || '(还没选)';
        o.sql = n.sql || '(还没写)';
        o.outputs = (n.outputs || []).map((c) => c.key);
      }
      if (n.type === 'condition') o.expr = n.expr || null;
      if (n.type === 'output') o.template = n.template || '(还没写)';
      return o;
    }),
    edges: (card.edges || []).map((e) => `${e.from} -${e.port}-> ${e.to}`)
  };
}

/* ==================== 会话 ==================== */

class EngineAiBuilder {
  /**
   * @param llm      LLMClient
   * @param pool     { [dbId]: [表名, ...] } 本次可用的库表范围
   * @param card     起始草稿 (改现有卡时传它, 新建时传空白卡)
   * @param openDb   (dbConf) => Database 实例
   * @param databases 全部数据库配置 (用来按 id 找)
   */
  /**
   * 对话史。**代理到 ctx**, 不是另存一份 —— 两份数组一定会分叉,
   * 而分叉的表现是"模型看到的和存盘的不是同一段对话", 极难查。
   *
   * 保留这个名字是因为卡片状态 (snapshot / restore) 和测试都在用它。
   */
  get messages() { return this.ctx.messages; }
  set messages(arr) { this.ctx.messages = arr; }

  constructor({ llm, pool, card, openDb, databases, mcp, general, prompt }) {
    this.llm = llm;
    this.pool = pool || {};
    this.card = Engine.normalizeEngine(JSON.parse(JSON.stringify(card || Engine.newEngine())));
    this.openDb = openDb;
    this.databases = databases || [];
    // 用户在「设置 · 提示词 · 搭建 Agent」里改过的那部分。空 -> 全用出厂值。
    this.promptConfig = prompt || null;
    // 外部接入的工具 (MCP)。可选 —— 搭建时经常要查内部系统才能知道字段含义
    // (工单系统里的枚举、监控里的表来源), 那些正是该用 MCP 接的东西。
    this.mcp = mcp || null;
    // 上下文统一由 AgentContext 管 (系统提示 / 历史裁剪 / 压缩阈值都只有一份实现)。
    this.ctx = new AgentContext({
      // 系统提示词每轮重建: 它里面含"当前草稿"快照。冻结一次的话, 模型对自己
      // 刚加的节点、刚改的 SQL 的认知会停在这一轮开始之前, 只能靠工具返回的
      // 文本去拼凑当前状态 —— 卡一大, 自我认知就是碎的。
      system: () => buildSystemPrompt(this.card, this.pool, this.described, this.dbNames(), this.promptConfig),
      maxChars: general && general.maxChars
    });
    this.messages = [];
    this.described = new Map();
    this.userPicked = new Set();   // 模型圈出来要用的表
    this.lastAsk = '';
    // 这次会话里被 AI 自己接过的出口。新建的卡总带着一条 入口→出口 的占位线,
    // 那条是脚手架, AI 改掉它很正常; 但它自己接出去的线再改就是搭菱形了。
    this.aiEdges = new Set();
    // 自测状态: 这一轮里 validate_draft / run_test 各自过了没有。
    // finish 要拿它当闸门 —— "搭完必须自测"不能只写在提示词里, 模型会忘。
    this.tested = { validated: false, ran: false };
    // "这一轮该收尾了"。**只是这一轮的临时标记**, 不是"会话结束了" ——
    // 每次 send 开头都会清掉, 因为用户随时可以接着说一句继续改。
    // 这里显式初始化, 免得新会话里它是 undefined, 语义含糊。
    this.finished = false;
    // 这一轮是不是"只是说了句话" (reply)。跟 finished 分开: 前者是"卡搭好了",
    // 后者是"用户没在搭卡, 我回了一句"。混在一起会让 main.js 误拉起整套自测。
    this.repliedOnly = false;
    // 上一次 send 的时间/token 总账, 由 send 收尾时填 (见 _emitSpent 附近)。
    // 显式初始化: 没跑过 send 的会话在 snapshot 里应该是 null, 不是 undefined。
    this.spent = null;
    // 上次试跑每个取数节点实际跑的 SQL 和结果, 供下一次 run_test 复用 (见 reuse)。
    // 按输入分组: _queryCacheKey 是那组输入的指纹, 换输入就整个作废 ——
    // 参数变了还拿旧结果, 会得出错误结论, 那是这个优化唯一真正危险的地方。
    this._queryCache = Object.create(null);
    this._queryCacheKey = '';
    this._lastTestInputs = null;
    // 被折叠掉的长工具结果存这儿, 存根上留编号, 模型可以用 recall 取回。
    // 详见 agent-loop.js 里 createFoldStore 的注释 (为什么"折了就删"代价很高)。
    this._foldStore = Loop.createFoldStore(40);
    // 规划 (PRD)。形状见 plan_task 的处理分支。
    // 它是"这一轮要干什么"的权威清单, 两个闸门都读它:
    //   没规划 -> 不许改图; 有规划但没做完 -> 不许试跑。
    this.plan = null;
    // 一次 send() 内共用的数据库连接 (dbId -> Database)。以前四个只读工具各自
    // openDb + finally close —— describe_tables 12 张表就是 12 次建连, 而
    // mssql+AzureAD 建连要握手取 token, 一次几秒。这里按库缓存, 生命周期 = 一次
    // send() (见 send/_closeDbs)。连接管理模式的出处见 db-router.js 的 _conn。
    this._dbs = new Map();
  }

  /**
   * 卡里有没有"实质内容" —— 取数或条件节点。
   *
   * 用来判断"这是从零开始搭, 还是在改一张已有的卡"。空白新卡只有入口和出口两个节点,
   * 那不叫搭过 —— 真正的活是取数和判断。规划闸门只对"还没搭过"的卡生效。
   */
  _hasSubstance() {
    return (this.card.nodes || []).some((n) => n.type === 'query' || n.type === 'condition');
  }

  /** 规划里还没做完的步骤 */
  _pendingSteps() {
    if (!this.plan || !Array.isArray(this.plan.steps)) return [];
    return this.plan.steps.filter((s) => s.status !== 'done');
  }

  /** 把规划渲染成给模型和用户看的文本 */
  _planText() {
    if (!this.plan) return '';
    const lines = ['规划:'];
    for (const s of this.plan.steps) {
      lines.push(`  ${s.status === 'done' ? '[x]' : '[ ]'} ${s.id} ${s.title}${s.detail ? ' —— ' + s.detail : ''}`);
    }
    if (this.plan.branches && this.plan.branches.length) {
      lines.push('结论(出口):');
      for (const b of this.plan.branches) lines.push(`  - ${b}`);
    }
    if (this.plan.unknowns && this.plan.unknowns.length) {
      lines.push('还没确认的:');
      for (const u of this.plan.unknowns) lines.push(`  ? ${u}`);
    }
    if (this.plan.revision > 1) lines.push(`(这是第 ${this.plan.revision} 版规划)`);
    return lines.join('\n');
  }

  /**
   * 把会话状态导成能落盘的普通对象。
   *
   * 这个类里有三个**不能直接 JSON 化**的容器: described 是 Map、userPicked / aiEdges
   * 是 Set。直接 JSON.stringify 会得到 `{}` —— 而且不报错, 恢复出来静悄悄变成空的,
   * 表现是"重开对话后 AI 又把表读了一遍、又按菱形规则改线", 极难查。
   * 所以这里显式转数组, 在 restore 里再转回去。
   *
   * 存的东西里, tested 最要紧: 它是 finish 的硬闸门。丢了这个状态, 一个已经搭好的
   * 对话重开后 AI 会认为"还没试跑过", 卡在收尾那一步反复要求 run_test。
   */
  snapshot() {
    return {
      messages: this.messages || [],
      described: Array.from(this.described || []).map(([k, v]) => [k, v]),
      userPicked: Array.from(this.userPicked || []),
      aiEdges: Array.from(this.aiEdges || []),
      tested: { validated: !!this.tested.validated, ran: !!this.tested.ran },
      lastAsk: this.lastAsk || '',
      finished: !!this.finished,
      // 规划要落盘: 重开这条历史对话时, "这张卡当初打算怎么搭、搭到哪一步" 不该变空。
      // 更实际的是 —— 不落盘的话, 恢复会话后规划闸门会认为"还没规划",
      // 于是模型得把同一份规划再写一遍, 而用户会看到两张不一样的规划。
      plan: this.plan || null,
      // 上一次 send 的时间/token 总账。落盘是为了事后能复盘 ——
      // 只推给界面的话, 关掉面板就没了 (见 send 里 this.spent 的注释)。
      spent: this.spent || null,
      card: this.card
    };
  }

  /**
   * 把 snapshot() 的产物灌回一个新构造的会话。
   *
   * 只在打开历史对话时调一次, 之后照常 send。card 也一并接回来 —— 历史对话里的
   * 卡就是那一轮搭出来的样子, 不接的话模型手里的图跟界面上显示的会对不上。
   */
  restore(state) {
    if (!state || typeof state !== 'object') return this;
    if (Array.isArray(state.messages)) this.messages = state.messages;
    if (Array.isArray(state.described)) this.described = new Map(state.described);
    if (Array.isArray(state.userPicked)) this.userPicked = new Set(state.userPicked);
    if (Array.isArray(state.aiEdges)) this.aiEdges = new Set(state.aiEdges);
    if (state.tested && typeof state.tested === 'object') {
      this.tested = { validated: !!state.tested.validated, ran: !!state.tested.ran };
    }
    if (typeof state.lastAsk === 'string') this.lastAsk = state.lastAsk;
    // 规划接回来 —— 不接的话恢复会话后闸门会认为"还没规划", 模型得重写一遍,
    // 而用户会看到两张不一样的规划。
    if (state.plan && typeof state.plan === 'object' && Array.isArray(state.plan.steps)) {
      this.plan = state.plan;
    }
    // 时间/token 总账接回来 —— 重开一条历史对话时, "上次这一轮花了多久"
    // 不该变回空白。它是只读的展示数据, 接回来没有副作用。
    if (state.spent && typeof state.spent === 'object') this.spent = state.spent;
    // 这里**故意不恢复 finished**。
    //
    // 它是"这一轮该停了"的临时标记, 不是会话状态 —— 每次 send 开头都会清掉。
    // 恢复它没有意义, 反而留了个隐患: 一旦以后有人把 send 开头那句重置删掉,
    // 一个从盘上恢复的会话就会"开口即收尾", 而症状是静默的 (对话看着正常,
    // 只是永远只做第一个动作)。不恢复, 这类 bug 就无从发生。
    // "这个会话搭完了"这件事由 store 里的 finished 字段单独记, 供历史列表显示徽标。
    if (state.card) this.card = Engine.normalizeEngine(JSON.parse(JSON.stringify(state.card)));
    // 落盘过又恢复回来的对话史, 也走一遍体检 —— 文件可能是旧版本写的, 或者中途被
    // 手工改过。坏形状发出去会被服务端 400 打回, 不如在这里就地修好。
    const healed = this._sanitizeHistory();
    if (healed.dropped) this.messages = healed.messages;
    return this;
  }

  /** 库 id -> 库名, 给草稿快照用 */
  dbNames() {
    const m = {};
    for (const d of this.databases) m[d.id] = d.name || d.id;
    return m;
  }

  /**
   * 把画板上的最新草稿接过来 —— 前提是它确实跟会话里这份不一样。
   *
   * 用户改了什么就以他改的为准 (界面才是他看得见的东西), 但**保留**:
   *   - 对话史 (他刚才说的话还得算数)
   *   - aiEdges (哪些线是 AI 接的, 决定"改接"是菱形还是脚手架)
   * 自测结果作废, 因为图已经不是跑过的那张了。
   *
   * 名字和描述单独处理, 且**不参与"变没变"的判定**:
   * AI 手上没有改卡名的工具, 它推回去的卡名永远是会话开始时那一份。
   * 如果拿名字参与比对, 会出现两种坏结果 —— 要么"只有名字变了"被判成没变、
   * 用户的改名传不进来; 要么判成变了、整张卡被推回界面时把名字冲掉。
   * 正确做法: 名字/描述一律从画板取, 图的部分才看指纹。
   *
   * @returns { changed: boolean } changed 只表示**图**变了 (界面据此决定要不要重画)
   */
  adoptCard(incoming) {
    if (!incoming) return { changed: false };
    const next = Engine.normalizeEngine(JSON.parse(JSON.stringify(incoming)));
    const sigOf = (c) => JSON.stringify({
      n: (c.nodes || []).map((x) => [x.id, x.type, x.title, x.sql || '', x.template || '', x.table || '', x.databaseId || '', JSON.stringify(x.expr || null), JSON.stringify(x.outputs || []), JSON.stringify(x.fields || [])]),
      e: (c.edges || []).map((x) => [x.from, x.to, x.port])
    });
    // 名字/描述无条件跟画板对齐 —— 这两个字段只有用户在改
    this.card.name = next.name;
    this.card.description = next.description;
    this.card.examples = next.examples;
    if (sigOf(next) === sigOf(this.card)) return { changed: false };
    this.card = next;
    this.tested = { validated: false, ran: false };
    return { changed: true };
  }

  /** 池内的表: [{ dbId, dbName, table }] */
  poolTableList() {
    const out = [];
    for (const dbId of Object.keys(this.pool)) {
      const db = this.databases.find((d) => d.id === dbId);
      for (const t of this.pool[dbId] || []) out.push({ dbId, dbName: db ? (db.name || db.id) : dbId, table: t });
    }
    return out;
  }

  /** 表名在池里对应几个库。>1 就是同名跨库, 只给表名分不清是哪个。 */
  tableHits(name) {
    return this.poolTableList().filter((x) => x.table === name);
  }

  allowedTable(name) {
    return this.tableHits(name).length > 0;
  }

  /**
   * 把模型给的表名认成"库 + 表"。
   *
   * 这里必须有歧义保护: 两个库都有一张 purchase_order 时, 光凭表名去 find()
   * 只会拿到**第一个** —— 模型以为自己看的是 A 库那张 (字段里有 po_no),
   * 实际节点指向 B 库那张 (字段里没有), SQL 一跑就是 column does not exist。
   * lib/db-router.js 早就为取数路径做了这层保护 (ambiguous), 这里补齐同一套。
   *
   * @returns { hit } | { ambiguous: [hit,...] } | { miss: true }
   */
  _resolveTable(name, dbId) {
    const hits = this.tableHits(name);
    if (!hits.length) return { miss: true };
    if (dbId) {
      const want = hits.find((x) => x.dbId === dbId);
      return want ? { hit: want } : { miss: true };
    }
    if (hits.length > 1) return { ambiguous: hits };
    return { hit: hits[0] };
  }

  /** 歧义时给模型一句能照着改的话 */
  _ambiguityMsg(name, hits) {
    return (
      `表 ${name} 在 ${hits.length} 个库里都有: ` +
      hits.map((h) => `${h.dbName} (id=${h.dbId})`).join('、') +
      `。它们字段不一样, 认错了 SQL 就会报"列不存在"。` +
      `用 describe_tables 时请写成 "库id.表名" 的形式指明是哪个库的。`
    );
  }

  /* ---- 工具执行 ---- */

  /** 草稿的指纹: 用来判断"这一步之后图变了没有" */
  _cardSig() {
    return JSON.stringify({
      n: (this.card.nodes || []).map((x) => [x.id, x.type, x.title, x.sql || '', x.template || '', x.table || '', x.databaseId || '', JSON.stringify(x.expr || null), JSON.stringify(x.outputs || []), JSON.stringify(x.fields || [])]),
      e: (this.card.edges || []).map((x) => [x.from, x.to, x.port])
    });
  }

  /**
   * 给模型的工具清单 = 内置 + 外部接入的 (MCP)。
   *
   * 内置的名字单独留一份 (BUILDER_TOOL_NAMES), 分发时据此区分:
   * 不在内置表里的就往 MCP 那边送。
   */
  toolSchemas() {
    const ext = (this.mcp && Array.isArray(this.mcp.tools)) ? this.mcp.tools : [];
    return TOOLS.concat(ext.filter((t) => t && t.function && t.function.name));
  }

  async _runTool(rawEmit, call) {    // 每次要把图推给界面之前, 先按层级把位置重排一遍。
    // 这样每加一个节点, 图都是整整齐齐往右长出来 —— 不会因为"插入顺序"跟
    // 草稿自带的节点撞在同一格上。
    const emit = rawEmit
      ? (ev) => { if (ev && ev.type === 'ai_graph') this._layout(); rawEmit(ev); }
      : null;
    const before = this._cardSig();
    const out = await this._runToolInner(emit, call);
    // 图一旦被改动, 之前那次"体检通过 / 跑通了"就作废了 ——
    // 否则模型会拿旧的自测结果去收尾, 改坏了也照样 finish。
    if (this._cardSig() !== before) this.tested = { validated: false, ran: false };
    return out;
  }

  async _runToolInner(emit, call) {
    const a = call.args || {};

    // ---- 外部接入的工具 (MCP): 不在内置表里的都往那边送 ----
    // 以前搭建 Agent 完全没有这条路, 外部工具只有分析 Agent 能看到。
    if (!BUILDER_TOOL_NAMES.has(call.name)) {
      if (this.mcp && typeof this.mcp.call === 'function' && /^mcp__/.test(call.name)) {
        if (emit) emit({ type: 'ai_act', text: `调用外部工具 ${call.name}` });
        try {
          const text = await this.mcp.call(call.name, a);
          return String(text == null ? '' : text);
        } catch (e) {
          return { error: `外部工具 ${call.name} 调用失败: ${e.message}` };
        }
      }
      return { error: `没有叫 ${call.name} 的工具。请只使用提供给你的工具。` };
    }

    // ---- 规划闸门: 从零搭卡之前必须先出规划 ----
    //
    // 为什么要有这道闸门 (不是洁癖, 是实测):
    //   以前模型是"边建边试" —— 加一个节点就 run_test 一次。一个 90 分钟的会话里
    //   run_test 被叫了 16 次、花了 33.1 分钟 (占全部工具时间的 99.7%), 而其中 8 次
    //   只是在对同一个节点的引号问题反复试。它每次试跑都在重新发现同一个事实,
    //   因为**它从来没有先把整条链路想清楚**。
    //
    //   企业开发不会改一行测一行 —— 先出方案, 方案定了再实现, 实现完了再测。
    //   这道闸门就是把那个顺序钉死。
    //
    // **只在"从零搭"的时候拦** (卡里还没有取数/条件节点)。
    //   为什么不一概拦: 改一张已经搭好的卡 (加个结论分支、改个列名) 是小事,
    //   逼它先写一份完整规划是官僚主义, 而且用户会实实在在地多等一轮。
    //   而"从零搭"恰恰是那 33 分钟发生的地方 —— 闸门对准的正是这一段。
    //   已经搭过的卡 (历史对话恢复回来的、用户自己画的) 因为已经有取数节点, 直接放行。
    if (BUILD_MUTATORS.has(call.name) && !this.plan && !this._hasSubstance()) {
      return {
        error: '这是一张还没开始搭的卡, 动手之前先出规划。用 plan_task 把这张卡打算怎么搭列清楚 —— ' +
          '分几步、每步建什么节点、最后有哪几个结论(出口)。' +
          '\n查资料不受限制 (list_available_tables / describe_tables / look_at_data / find_value 随时可用), ' +
          '但**建节点、连线和写 SQL 都要等规划出来之后**。' +
          '\n理由: 边建边试会让同一个问题被反复试跑出来, 实测有会话因此把 33 分钟花在重复试跑上。' +
          '\n(如果这是在改一张已经搭好的卡, 这条不该出现 —— 那说明卡里真的一个取数节点都没有。)' +
          '\n\n规划之后要改是可以的: 再调一次 plan_task 出下一版, 已标完成的步骤会保留。'
      };
    }

    switch (call.name) {
      case 'list_available_tables': {
        const list = this.poolTableList();
        if (!list.length) return '本次可用范围是空的。请让用户点右上角「配置」勾选库和表。';
        const byDb = {};
        for (const x of list) (byDb[x.dbName] = byDb[x.dbName] || []).push(x.table);
        const head = Object.keys(byDb).map((db) => `${db} (id=${list.find((l) => l.dbName === db).dbId}): ${byDb[db].join(', ')}`).join('\n');
        // 同名表要单独点出来: 只给表名的话, 模型分不清该读哪个库的结构
        const dup = {};
        for (const x of list) (dup[x.table] = dup[x.table] || []).push(x.dbName);
        const clashes = Object.keys(dup).filter((t) => dup[t].length > 1);
        return head + (clashes.length
          ? '\n\n注意: 这些表名在多个库里都有, 选表/看结构时必须带上库id (写成 "库id.表名"):\n' +
            clashes.map((t) => `- ${t}: ${dup[t].join('、')}`).join('\n')
          : '');
      }

      case 'describe_tables': {
        const want = (Array.isArray(a.tables) ? a.tables : []).slice(0, MAX_TABLES_DESCRIBE);
        const out = [];
        for (const raw of want) {
          // 允许写成 "库id.表名" —— 同名表跨库时这是唯一能说清的办法
          const spec = String(raw || '').trim();
          const dot = spec.indexOf('.');
          const dbHint = dot > 0 ? spec.slice(0, dot) : '';
          const t = dot > 0 ? spec.slice(dot + 1) : spec;
          if (!t) { out.push(`${spec}: 表名是空的。`); continue; }

          const got = this._resolveTable(t, dbHint);
          if (got.miss) {
            out.push(dbHint
              ? `${spec}: 在库 ${dbHint} 里没有这张表 (或者它不在本次可用范围里)。`
              : `${t}: 不在本次可用范围里, 用不了。`);
            continue;
          }
          if (got.ambiguous) { out.push(this._ambiguityMsg(t, got.ambiguous)); continue; }

          const hit = got.hit;
          const key = hit.dbId + '|' + t;
          if (this.described.has(key)) {
            const cols = this.described.get(key);
            out.push(`${t} (库 ${hit.dbName}): ${cols.map((c) => c.field).join(', ')}`);
            continue;
          }
          const dbConf = this.databases.find((d) => d.id === hit.dbId);
          if (!dbConf) { out.push(`${t}: 找不到它所在的库。`); continue; }
          const db = this._sharedDb(dbConf);
          try {
            const cols = await db.describeTable(t);
            this.described.set(key, cols);
            this.userPicked.add(key);
            // 这里以前还有一条 emit "看了表结构：库.表（N 个字段）"。
            // 它和通用 describeAct 的 "读了表结构：表" 是**同一件事**,
            // 于是每次调用在对话流里都出现两行 —— 用户看到的就是重复。
            // 规则统一为: "发生了什么"只由 describeAct 说一次;
            // 库名/字段数这类执行结果走工具返回值给模型, 由模型自己复述。
            out.push(`${t} (库 ${dbConf.name || hit.dbId}, id=${hit.dbId}):\n` + cols.map((c) => `  - ${c.field}${c.type ? ' ' + c.type : ''}`).join('\n'));
          } catch (e) {
            if (isConnError(e)) this._dropDb(dbConf);
            out.push(`${t}: 读表结构失败 (${e.message})`);
          }
        }
        return out.join('\n\n');
      }

      case 'look_at_data': {
        const dbConf = this.databases.find((d) => d.id === String(a.dbId || '').trim());
        if (!dbConf) return { error: `找不到库 ${a.dbId}。` };
        const table = String(a.table || '').trim();
        // 一次可以看多列。
        //
        // 为什么: 每次工具调用都吃一步预算, 而"看几列判断哪个是单号"这种探索
        // 经常要连着看七八列 —— 一列一次地调, 卡还没开始搭就把预算吃掉了小半。
        // 实测一个会话里 9 次 look_at_data 全是看同一张表的不同列。
        // column (单列, 老写法) 和 columns (数组) 都收, 合并去重。
        const wantCols = [];
        if (a.column) wantCols.push(String(a.column).trim());
        if (Array.isArray(a.columns)) for (const c of a.columns) if (c) wantCols.push(String(c).trim());
        const cols = Array.from(new Set(wantCols.filter(Boolean))).slice(0, MAX_LOOK_COLUMNS);
        if (!table || !cols.length) return { error: 'table 和 column (或 columns) 都要给。' };
        // 表要在可用范围里 —— 看数据也不能越界
        if (!this.tableHits(table).length) {
          return { error: `表 ${table} 不在本次可用范围里, 看不了。` };
        }
        const db = this._sharedDb(dbConf);
        try {
          // 标识符按库类型套引号 —— MySQL 只认反引号, 写双引号直接语法错误。
          // 以前这里是手写的双引号, 在 MySQL 上这个工具必挂。
          const tb = Engine.quoteIdent(table, dbConf.type);
          const blocks = [];
          for (const column of cols) {
            const q = Engine.quoteIdent(column, dbConf.type);
            const r1 = await db.query(`SELECT ${q} AS v FROM ${tb} LIMIT 20`);
            const vals = (r1.rows || []).map((x) => x.v);
            // 统计归 lib/data-peek.js: 大表 (超过 100 万行) 自动降级成抽样,
            // 详情和实测数字见那个文件开头。
            const s = await Peek.peekColumnStats({
              db, dialect: dbConf.type, table, tb, col: q
            });
            const lines = [
              `列 ${column}:`,
              `  样本 (前 ${vals.length} 行): ` + (vals.length ? vals.map((v) => (v === null ? 'NULL' : String(v).slice(0, 50))).join(' | ') : '(没有行)')
            ];
            for (const line of Peek.formatStats(s)) lines.push('  ' + line);
            blocks.push(lines.join('\n'));
          }
          // 以前这里也 emit 一条 "看了真实数据：表.列"。
          // 它和 describeAct 生成的字面**一模一样**, 所以每次调用必然出现两遍。
          // 删掉这一条, 由 describeAct 说一次。
          return blocks.join('\n\n');
        } catch (e) {
          if (isConnError(e)) this._dropDb(dbConf);
          return { error: `看数据失败: ${e.message}` };
        }
      }

      case 'find_value': {
        // 「这个值存在哪一列」—— 直接复用 table-match.js 里那套值探测。
        //
        // 为什么必须做成工具, 而不是继续让模型自己写 SQL:
        // 2026-09-23 实测那条会话里, 模型为了找"SRM 侧哪一列装着 PO 号",
        // 自己写了 4 条探针 —— `WHERE a LIKE 'PO%' OR b LIKE 'PO%' OR ...`
        // 十几列拼起来, 在 946 万行的表上全表扫, 单条最贵 129.8 秒,
        // 四条加起来约 250 秒。而它想回答的问题本来是一条等值探测就能答的。
        //
        // runProbes 已经把这件做对了: 大表只试有索引的列 (没索引的记进 untried
        // 而不是静默跳过), 有硬预算, 超预算当"没试过"不当"没有"。
        // 这里只需要给它一个最小的 router 适配层。
        const dbConf = this.databases.find((d) => d.id === String(a.dbId || '').trim());
        if (!dbConf) return { error: `找不到库 ${a.dbId}。` };
        const table = String(a.table || '').trim();
        if (!table) return { error: 'find_value 要给 table。' };
        if (!this.tableHits(table).length) {
          return { error: `表 ${table} 不在本次可用范围里, 查不了。` };
        }
        const wantVals = [];
        if (a.value != null && String(a.value).trim()) wantVals.push(String(a.value).trim());
        if (Array.isArray(a.values)) for (const v of a.values) if (v != null && String(v).trim()) wantVals.push(String(v).trim());
        const values = Array.from(new Set(wantVals));
        if (!values.length) return { error: 'find_value 要给 value (或 values 数组)。' };

        const db = this._sharedDb(dbConf);
        try {
          // digest 给出"表多大 + 哪些列有索引" —— runProbes 靠它决定试哪些列。
          // 拿不到就退化成"什么都试", 由硬预算兜住 (宁可慢一点也不能静默不试)。
          let digest = null;
          try {
            if (typeof db.schemaDigest === 'function') digest = await db.schemaDigest();
          } catch (e) { digest = null; }

          const router = {
            targetFor: () => ({ dialect: dbConf.type || 'mysql' }),
            query: (sql) => db.query(sql)
          };
          const probes = await TableMatch.runProbes({
            router,
            digest,
            tables: [table],
            values,
            budgetMs: 8000,
            maxQueries: 24,
            perTable: 8
          });

          const lines = [];
          if (probes.degraded) lines.push(`⚠ ${probes.degraded}`);
          if (probes.hits.length) {
            lines.push(`✓ 这些列**真的装着**要找的值:`);
            for (const h of probes.hits) lines.push(`    ${h.column}  =  ${h.value}`);
            lines.push('  要判断关联键, 拿这一列去 JOIN 才是站得住的写法。');
          } else {
            lines.push(`✗ 试过的列里没有找到这个值。`);
          }
          if (probes.missedCols.length) {
            lines.push(`· 试过且确认没有的列: ${probes.missedCols.map((m) => m.column).join(', ')}`);
          }
          if (probes.untried.length) {
            // 这条最要紧: "没试过"绝不能写成"没有" —— 那会让模型得出
            // "这列是空的、不能当关联键"这种它会据此建错卡的结论。
            lines.push(`⚠ 这些列**没试到** (不代表没有, 只是这次没查): `
              + probes.untried.map((u) => (u.column ? `${u.column}(${u.why})` : `${u.table}(${u.why})`)).join(', '));
          }
          if (probes.errors.length) {
            lines.push(`· 查询报错的列: ${probes.errors.map((e) => `${e.column}(${e.error})`).join(', ')}`);
          }
          lines.push(`(试了 ${probes.tried} 条查询, 用时 ${probes.elapsedMs} ms)`);
          if (!probes.hits.length && probes.untried.length) {
            lines.push('注意: 没找到**不等于**这个值不存在 —— 上面那些没试到的列要另行确认, 别据此断定"这列是空的"。');
          }
          return lines.join('\n');
        } catch (e) {
          if (isConnError(e)) this._dropDb(dbConf);
          return { error: `值探测失败: ${e.message}` };
        }
      }

      case 'check_index': {
        const dbConf = this.databases.find((d) => d.id === String(a.dbId || '').trim());
        if (!dbConf) return { error: `找不到库 ${a.dbId}。` };
        const table = String(a.table || '').trim();
        const column = String(a.column || '').trim();
        const db = this._sharedDb(dbConf);
        try {
          let rows = [];
          if (dbConf.type === 'postgres') {
            const r = await db.query(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = '${table.replace(/'/g, "''")}'`);
            rows = r.rows || [];
          } else if (dbConf.type === 'mysql') {
            // 以前这里发的是 SHOW INDEX FROM ... —— 只读闸门只放行
            // SELECT / WITH / PRAGMA / EXPLAIN 开头的语句, SHOW 会被直接拒掉,
            // 所以这个工具在 MySQL 上是**必挂**的 (而 4 个库里有 3 个是 MySQL)。
            // 改查 information_schema, 跟 describeTable 取的是同一份元数据。
            const r = await db.query(
              `SELECT INDEX_NAME AS index_name, COLUMN_NAME AS column_name,
                      NON_UNIQUE AS non_unique, SEQ_IN_INDEX AS seq
                 FROM information_schema.STATISTICS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table.replace(/'/g, "''")}'
                ORDER BY INDEX_NAME, SEQ_IN_INDEX`
            );
            rows = r.rows || [];
          } else {
            // 以前 mssql / sqlite 走到这里 rows 是空的, 会回一句"一个索引都没有"——
            // 那是假话, 只是没实现。宁可不给答案, 也别给错的。
            return `暂时只支持在 MySQL / PostgreSQL 上查索引, ${dbConf.type} 还没做。`;
          }
          if (!rows.length) return `表 ${table} 上一个索引都没有 (任何过滤都会全表扫)。`;
          const lines = [`表 ${table} 的索引: ${rows.length} 个`];
          for (const x of rows.slice(0, 20)) lines.push('  ' + JSON.stringify(x));
          if (column) {
            // 判断本体在 engine.js: 以前这里写的是 rows.some(x => JSON.stringify(x).includes(column)),
            // 而 MySQL 返回行的键名就叫 column_name —— 它自带 "name" 子串, 于是任何叫 name 的列
            // 都被判成"有索引"。这是句假话。
            const has = Engine.indexHasColumn(rows, column);
            lines.push(has ? `✓ ${column} 有索引。` : `✗ ${column} 没有索引 —— 按它过滤会全表扫, 换个有索引的等价列。`);
          }
          // 同理: describeAct 会说 "查了 表 的索引", 这里不必再说一遍 "查了索引：表"。
          return lines.join('\n');
        } catch (e) {
          if (isConnError(e)) this._dropDb(dbConf);
          return { error: `查索引失败: ${e.message}` };
        }
      }

      case 'ask_user': {
        this.lastAsk = String(a.question || '').trim() || '这一步需要你确认一下。';
        return { __ask: this.lastAsk };
      }

      case 'ask_choice': {
        const q = String(a.question || '').trim() || '这一步需要你确认一下。';
        const opts = (Array.isArray(a.options) ? a.options : [])
          .map((o) => {
            if (o == null) return null;
            if (typeof o === 'string') return { label: o, value: o, desc: '' };
            const label = String(o.label || o.value || '').trim();
            if (!label) return null;
            return {
              label,
              value: o.value != null ? String(o.value) : label,
              desc: String(o.desc || '')
            };
          })
          .filter(Boolean)
          .slice(0, 8);
        if (!opts.length) return { error: 'ask_choice 至少要给一个选项; 没有候选就用 ask_user。' };
        this.lastChoice = {
          question: q,
          why: String(a.why || '').trim(),
          multi: !!a.multi,
          options: opts,
          placeholder: String(a.placeholder || '').trim(),
          allowText: a.allowText !== false
        };
        // 走和 ask_user 同一条路: 停下来等用户答, 答完由调用方把结果当下一轮的用户消息喂回来
        this.lastAsk = q;
        return { __ask: q, __choice: this.lastChoice };
      }

      case 'plan_task': {
        const raw = Array.isArray(a.steps) ? a.steps : [];
        const steps = raw.map((s, i) => {
          const o = (typeof s === 'string') ? { title: s } : (s || {});
          const title = String(o.title || '').trim();
          if (!title) return null;
          return {
            id: String(o.id || '').trim() || ('s' + (i + 1)),
            title,
            // kind 只用来归类展示, 不强制 —— 硬绑枚举会让模型为了凑格式说废话
            kind: String(o.kind || '').trim(),
            detail: String(o.detail || '').trim(),
            status: 'todo',
            note: ''
          };
        }).filter(Boolean).slice(0, 20);
        if (steps.length < 2) {
          return { error: '规划至少要两步 —— 一张卡不可能一步搭完。把「建入口、取数、判断、出口」分别列出来。' };
        }
        const branches = (Array.isArray(a.branches) ? a.branches : [])
          .map((b) => String(b == null ? '' : b).trim()).filter(Boolean).slice(0, 12);
        if (!branches.length) {
          // 这条不是形式主义: 说不出这张卡会输出哪几个结论, 就是还没想清楚要做什么。
          // 而那正是"边建边试"的根源 —— 试跑成了探索需求的手段。
          return {
            error: '规划里必须写清 branches —— 这张卡最终会输出**哪几个结论** (比如「未全部入库」「入库无误待对账」「入库异常」)。' +
              '\n列不出结论就说明需求还没想清楚, 那时候去建卡只能靠反复试跑来找答案, 会非常慢。' +
              '\n先把结论列出来; 拿不准结论怎么分, 就用 ask_choice 问用户。'
          };
        }
        // 保留已经标完成的状态: 出一版新规划往往是"加一步"或"改一步",
        // 把已完成的清成 todo 会逼模型把做过的事再做一遍。
        const prev = new Map((this.plan && this.plan.steps ? this.plan.steps : []).map((s) => [s.id, s]));
        for (const s of steps) {
          const old = prev.get(s.id);
          if (old && old.status === 'done' && old.title === s.title) { s.status = 'done'; s.note = old.note; }
        }
        this.plan = {
          steps,
          branches,
          unknowns: (Array.isArray(a.unknowns) ? a.unknowns : []).map((u) => String(u == null ? '' : u).trim()).filter(Boolean).slice(0, 12),
          revision: (this.plan ? this.plan.revision + 1 : 1),
          at: Date.now()
        };
        if (emit) {
          emit({ type: 'ai_plan', plan: this.plan });
          emit({ type: 'ai_act', text: this.plan.revision > 1 ? '改了一版规划' : '出了一版规划' });
        }
        const doneN = steps.filter((s) => s.status === 'done').length;
        return this._planText() +
          `\n\n规划已记下 (${steps.length} 步${doneN ? ', 其中 ' + doneN + ' 步之前已完成' : ''})。` +
          '\n接下来按这个顺序一步步做: 建节点 -> 连好线 -> 写好 SQL/条件/结论模板。' +
          '\n**不要在做的过程中 run_test** —— 全部做完再测, 否则你会拿半成品的报错当真问题去改。' +
          '\n做完一步就用 plan_step_done 标一下。' +
          (this.plan.unknowns.length ? `\n还有 ${this.plan.unknowns.length} 件事没确认 —— 建的中间顺手确认掉, 别留到最后。` : '');
      }

      case 'plan_step_done': {
        if (!this.plan) return { error: '还没有规划。先用 plan_task 出一版。' };
        const id = String(a.stepId || '').trim();
        const step = this.plan.steps.find((s) => s.id === id)
          // 也允许按标题模糊匹配 —— 模型有时记不得自己编的 id, 却记得住标题。
          // 匹配不上就如实报错, 不猜。
          || this.plan.steps.find((s) => s.title === id);
        if (!step) {
          return { error: `规划里没有 ${id} 这一步。当前的步骤: ${this.plan.steps.map((s) => s.id + ' ' + s.title).join('; ')}` };
        }
        if (step.status === 'done') return `第 ${step.id} 步「${step.title}」之前就标过完成了。\n\n${this._planText()}`;
        step.status = 'done';
        step.note = String(a.note || '').trim();
        if (emit) emit({ type: 'ai_plan', plan: this.plan });
        const pend = this._pendingSteps();
        return this._planText() +
          (pend.length
            ? `\n\n还剩 ${pend.length} 步: ${pend.map((s) => s.title).join('、')}`
            : '\n\n规划里的步骤全部做完了 —— 现在可以 run_test 了。');
      }

      case 'write_card': {
        const raw = (a.card && typeof a.card === 'object' && !Array.isArray(a.card)) ? a.card : null;
        if (!raw) return { error: 'write_card 要给一个 card 对象 (含 nodes / edges)。' };
        // 一个出口接两条线 = 菱形。normalizeEngine 会把第二条**静默丢掉**, 模型却以为都接上了 ——
        // 先在这里拦下 (和增量 connect 的菱形保护同一件事)。
        const seenPort = new Set();
        for (const e of (Array.isArray(raw.edges) ? raw.edges : [])) {
          const from = String((e && e.from) || '').trim();
          if (!from) continue;
          const port = ['out', 'true', 'false'].includes(e && e.port) ? e.port : 'out';
          const k = from + '|' + port;
          if (seenPort.has(k)) {
            return { error: `一个出口只能接一条线: 「${this.byTitle(from)}」的 ${port} 出口接了不止一条。改成串行 (接在下游后面), 或者用条件节点的 true/false 两个口分岔。` };
          }
          seenPort.add(k);
        }
        const next = Engine.normalizeEngine(Object.assign({}, raw, {
          // id 保留本机的 —— 整张重写不该把卡换个身份
          id: this.card.id,
          // 名字/描述: 模型给了就用, 没给就保留原样 (别把用户起的名字抹成"未命名")
          name: String(raw.name || this.card.name || '').trim() || this.card.name,
          description: raw.description == null ? this.card.description : String(raw.description)
        }));
        const v = Engine.validateEngine(next, { schema: this._schemaForValidation() });
        if (!v.ok) {
          return { error: '这张卡有硬错, 没有写入。照着改完再调一次 write_card:\n' + v.errors.map((x) => '- ' + x).join('\n') };
        }
        this.card = next;
        // 图整个换了: 之前的自测结果作废
        this.tested = { validated: false, ran: false };
        // 整张重写后 AI 重认一遍连线: 新卡的线当作既有内容 (可自由改接), 不当作"AI 自己搭的菱形"
        this.aiEdges = new Set();
        if (emit) {
          emit({ type: 'ai_graph', card: this.card });
          emit({ type: 'ai_act', text: `一次性写出了整张卡 (${this.card.nodes.length} 个节点)` });
        }
        const warns = v.warnings.length ? '\n提醒 (不挡, 但看一眼):\n' + v.warnings.map((x) => '- ' + x).join('\n') : '';
        return `整张卡已写入: ${this.card.nodes.length} 个节点 / ${this.card.edges.length} 条线。${warns}` +
          '\n接下来: 先 validate_draft 体检, 再 run_test 真跑一遍, 跑通才 finish。';
      }

      case 'add_node': {
        const type = ['input', 'query', 'condition', 'output'].includes(a.nodeType) ? a.nodeType : 'query';
        // 入口只能有一个。多出来的入口是删不掉的死块, 而且在图上看着像两条并行路,
        // 运行起来其实只有第一条入口被当起点 —— 必须在这里拦住。
        if (type === 'input') {
          const had = (this.card.nodes || []).find((n) => n.type === 'input');
          if (had) {
            return { error: `已经有一个入口节点了 (id=${had.id}), 一张卡只放一个入口。用它的 id 去 configure_input 配字段就行, 不用新增。` };
          }
        }
        const node = this._newNode(type, String(a.title || '').trim() || Engine.NODE_LABEL[type]);
        this.card.nodes.push(node);
        if (emit) emit({ type: 'ai_graph', card: this.card, added: node.id });
        return `已加节点 id=${node.id} (${Engine.NODE_LABEL[type]}: ${node.title})。画板坐标 x=${node.x}, y=${node.y}。`;
      }

      case 'connect': {
        const from = String(a.from || '').trim();
        const to = String(a.to || '').trim();
        const port = ['out', 'true', 'false'].includes(a.port) ? a.port : 'out';
        const hasFrom = (this.card.nodes || []).some((n) => n.id === from);
        const hasTo = (this.card.nodes || []).some((n) => n.id === to);
        if (!hasFrom) return { error: `连线失败: 没有 id 为 ${from} 的节点。` };
        if (!hasTo) return { error: `连线失败: 没有 id 为 ${to} 的节点。` };
        if (from === to) return { error: '连线失败: 不能自己连自己。' };
        // 这个口上已经有线了。分两种情况:
        //   - 是 AI 自己这几步里接的 -> 它想把一条线改接到两处, 那是菱形, 拦下。
        //   - 是草稿自带的 (新建卡都带一条 入口→出口 的占位线) -> 脚手架, 换掉很正常。
        const key = from + '|' + port;
        const existing = (this.card.edges || []).find((e) => e.from === from && e.port === port);
        let replaced = '';
        if (existing && existing.to !== to) {
          if (this.aiEdges.has(key)) {
            return {
              error:
                `连不上: 「${this.byTitle(from)}」的 ${port} 出口刚连到「${this.byTitle(existing.to)}」, 现在又想连到「${this.byTitle(to)}」。` +
                `一个出口只能接一条线 —— 这是菱形。改成串行 (接在「${this.byTitle(existing.to)}」后面往下走) 就对了; ` +
                `确实要改接, 先 disconnect ${from} ${port}。`
            };
          }
          replaced = `（原来接的是「${this.byTitle(existing.to)}」, 已改）`;
        }
        this.card.edges = (this.card.edges || []).filter((e) => !(e.from === from && e.port === port));
        this.card.edges.push({ from, to, port });
        this.aiEdges.add(key);
        if (emit) emit({ type: 'ai_graph', card: this.card });
        return `已连上 ${from} -${port}-> ${to}${replaced}。`;
      }

      case 'disconnect': {
        const from = String(a.from || '').trim();
        const port = ['out', 'true', 'false'].includes(a.port) ? a.port : 'out';
        const before = (this.card.edges || []).length;
        this.card.edges = (this.card.edges || []).filter((e) => !(e.from === from && e.port === port));
        if (this.card.edges.length === before) return { error: `「${from}」的 ${port} 出口上本来就没有线。` };
        this.aiEdges.delete(from + '|' + port);
        if (emit) emit({ type: 'ai_graph', card: this.card });
        return `已拆掉 ${from} 的 ${port} 出口上的线。`;
      }

      case 'delete_node': {
        const node = this._find(a.nodeId);
        if (!node) return { error: `没有 id 为 ${a.nodeId} 的节点。` };
        if (node.type === 'input') {
          const others = (this.card.nodes || []).filter((n) => n.type === 'input' && n.id !== node.id);
          if (!others.length) return { error: '这是唯一的入口节点, 删了这张卡就没有起点了。要换入口就改它, 别删。' };
        }
        const id = node.id;
        const goneEdges = (this.card.edges || []).filter((e) => e.from === id || e.to === id).length;
        this.card.nodes = (this.card.nodes || []).filter((n) => n.id !== id);
        this.card.edges = (this.card.edges || []).filter((e) => e.from !== id && e.to !== id);
        for (const k of Array.from(this.aiEdges)) if (k.split('|')[0] === id) this.aiEdges.delete(k);
        if (emit) emit({ type: 'ai_graph', card: this.card });
        return `已删掉节点「${node.title}」(${id})${goneEdges ? `, 连带 ${goneEdges} 条线一起消失` : ''}。` +
          (a.why ? ` 原因: ${a.why}` : '') +
          (goneEdges ? ' 记得把断掉的地方重新接上。' : '');
      }

      case 'set_node_title': {
        const node = this._find(a.nodeId);
        if (!node) return { error: `没有 id 为 ${a.nodeId} 的节点。` };
        const t = String(a.title || '').trim();
        if (!t) return { error: '标题不能是空的。' };
        const old = node.title;
        node.title = t;
        if (emit) emit({ type: 'ai_graph', card: this.card, focus: node.id });
        return `节点标题已改: 「${old}」-> 「${t}」。`;
      }

      case 'configure_input': {
        const node = this._find(a.nodeId);
        if (!node || node.type !== 'input') return { error: `没找到入口节点 ${a.nodeId}。` };
        const fields = (Array.isArray(a.fields) ? a.fields : []).map((f, i) => ({
          key: String(f.key || '').trim() || `input${i + 1}`,
          label: String(f.label || f.key || '').trim(),
          required: f.required !== false,
          // desc / group 以前在这里被丢掉了 —— 字段模型支持它们, 工具也声明了,
          // 但落到卡上就没了, 于是"这个字段是什么意思""这几个是不是任选其一"全都留不下来。
          desc: String(f.desc || '').trim().slice(0, 200),
          group: String(f.group || '').trim().slice(0, 40)
        }));
        if (!fields.length) return { error: '至少要有一个字段。' };
        node.fields = fields;
        if (emit) emit({ type: 'ai_graph', card: this.card, focus: node.id });

        // 回执里要把 desc / group 的落地情况说出来, 否则模型不知道有没有存上,
        // 下一轮可能又"补"一遍。
        const shown = fields.map((f) => {
          const bits = [`${f.key}(${f.label})`];
          if (f.desc) bits.push(`说明:${f.desc}`);
          if (f.group) bits.push(`组:${f.group}`);
          return bits.join(' ');
        }).join('; ');

        const grouped = fields.filter((f) => f.group);
        const noDesc = fields.filter((f) => !f.desc);
        const warn = [];
        if (grouped.length) {
          const names = Array.from(new Set(grouped.map((f) => f.group)));
          warn.push(
            `注意: 「${names.join('」「')}」是任选其一。运行时会从这些项里挑用户给了的那个, ` +
            `但卡里现在还没按「谁有值」分流 —— 记得加条件节点 (op 用 notEmpty) 把每种单号引到各自的取数节点, ` +
            `否则 SQL 里的 {{某项}} 会渲染成空串, 条件变成 = '' 而静默查不到数据。`
          );
        }
        if (noDesc.length) {
          warn.push(`还有 ${noDesc.length} 项没写 desc (${noDesc.map((f) => f.key).join(', ')}), 补上 —— 用户那句话里只有一个值, 全靠 desc 判断它属于哪一项。`);
        }
        return '入口字段已设: ' + shown + '。' + (warn.length ? '\n' + warn.join('\n') : '');
      }

      case 'configure_query': {
        const node = this._find(a.nodeId);
        if (!node || node.type !== 'query') return { error: `没找到取数节点 ${a.nodeId}。` };
        // 增量改: 只动传进来的字段, 没传的保持原样。
        // 以前 sql 是必填, 模型想换一张表就得把 SQL 一起重写, 顺手把 outputs 也覆盖掉。
        const table = a.table == null ? '' : String(a.table).trim();
        const sql = a.sql == null ? '' : String(a.sql).trim();
        if (sql && !/^\s*(select|with)\b/i.test(sql)) return { error: 'SQL 必须是只读的 SELECT / WITH 语句。' };
        const nextDb = a.databaseId == null ? node.databaseId : String(a.databaseId).trim();

        // 认表: 有表名就校验, 并且要能说清是哪个库的
        if (table) {
          const got = this._resolveTable(table, nextDb);
          if (got.miss) {
            return { error: nextDb && this.tableHits(table).length
              ? `表 ${table} 不在库 ${nextDb} 里 (或者不在本次可用范围)。`
              : `表 ${table} 不在本次可用范围里, 用不了。` };
          }
          if (got.ambiguous) return { error: this._ambiguityMsg(table, got.ambiguous) + ' 请用 databaseId 指明用哪个库。' };
          if (!nextDb) node.databaseId = got.hit.dbId;
        }
        if (nextDb) node.databaseId = nextDb;
        if (table) node.table = table;
        if (sql) node.sql = sql;

        if (!node.sql) return { error: '这个取数节点还没有 SQL, 请把 sql 一起给上。' };

        // outputs 只在显式传了的时候覆盖 —— 否则改一条 SQL 会把作者填的中文列名全冲掉
        const outputs = (Array.isArray(a.outputs) ? a.outputs : [])
          .map((c) => Engine.normalizeOutputCol(c))
          .filter((c) => c.key);
        const keepOutputs = !outputs.length && !a.outputs;
        if (outputs.length) node.outputs = outputs;

        // SQL 的参数要在这里登记成"引用", 运行时才按引用去前面拿值
        node.fields = Engine.paramsOf(node.sql).map((k) => ({ key: k, label: k, required: true, desc: '' }));
        if (emit) emit({ type: 'ai_graph', card: this.card, focus: node.id });
        const miss = node.fields.map((f) => f.key).filter((k) => !this._refExists(k));
        // 列名对不上 SQL 里真正 SELECT 出来的东西时, 下游引用会全落空 —— 提前点出来
        const sel = Engine.selectAliases ? Engine.selectAliases(node.sql) : [];
        const declared = (node.outputs || []).map((c) => c.key);
        const notSel = declared.filter((k) => sel.length && !sel.includes(k));
        const noDecl = sel.filter((k) => !declared.includes(k));
        return `取数节点「${node.title}」已配 (库 ${this._dbName(node.databaseId)}, 表 ${node.table})。SQL: ${node.sql}` +
          (keepOutputs && declared.length ? `\n保留原有输出列: ${declared.join(', ')}` : '') +
          (outputs.length ? `\n输出列: ${outputs.map((c) => c.key).join(', ')}` : '') +
          (miss.length ? `\n注意: 这些参数找不到来源, 会跑不起来 -> ${miss.join(', ')}` : '') +
          (notSel.length ? `\n注意: 声明的输出列 ${notSel.join(', ')} 在这条 SQL 的 SELECT 里没有, 下游引用它们会拿到空值。` : '') +
          (noDecl.length ? `\n提醒: SQL 还查出了 ${noDecl.join(', ')}, 没登记成输出列, 下游引用不到。用得上就补进 outputs。` : '');
      }

      case 'configure_condition': {
        const node = this._find(a.nodeId);
        if (!node || node.type !== 'condition') return { error: `没找到条件节点 ${a.nodeId}。` };
        const rawItems = Array.isArray(a.items) ? a.items : [];
        // 子组用 {logic, items} 表达。补上 type:'group' 让 normalizeExpr 认出来 ——
        // 模型不一定写 type, 所以按"有没有 items 数组"判, 容错。
        const shape = (it) => {
          const o = (it && typeof it === 'object') ? it : {};
          if (Array.isArray(o.items)) return { type: 'group', logic: o.logic === 'or' ? 'or' : 'and', items: o.items.map(shape) };
          return { left: String(o.left || '').trim(), op: o.op, right: o.right };
        };
        const depthOf = (items, d) => {
          let m = d;
          for (const it of items) if (it && Array.isArray(it.items)) m = Math.max(m, depthOf(it.items, d + 1));
          return m;
        };
        if (depthOf(rawItems, 1) > 5) return { error: '条件嵌套太深 (最多 5 层)。拆简单点, 或者把这个判断拆成两个条件节点。' };
        // 交给引擎的 normalizeExpr 规范化 —— 它会**递归**处理子组 (引擎一直支持嵌套, 只是这个工具以前只认扁平的)
        const expr = Engine.normalizeNode({
          type: 'condition',
          expr: { type: 'group', logic: a.logic === 'or' ? 'or' : 'and', items: rawItems.map(shape) }
        }).expr;
        if (!expr) return { error: '条件至少要有一条规则。' };
        node.expr = expr;
        if (emit) emit({ type: 'ai_graph', card: this.card, focus: node.id });
        // 收集所有比较项的 left, 挨个查引用能不能落地 (子组也要挖进去)
        const lefts = [];
        const walk = (g) => { for (const it of (g.items || [])) (it.type === 'group' ? walk(it) : lefts.push(it.left)); };
        walk(expr);
        const bad = lefts.filter((l) => !this._refExists(l));
        // 顺带把这条条件相关的静态核对结论带回去 (数字列跟文本比较这类)
        const schemaWarns = Engine.validateEngine(this.card, { schema: this._schemaForValidation() })
          .warnings.filter((w) => w.startsWith(`条件节点「${node.title}」`));
        return `条件已配: ${Engine.describeExpr(node.expr, this._byId())}` +
          (bad.length ? `\n注意: 这些引用解析不到 -> ${bad.join(', ')}（查询出来的列要写成 节点id.列名）` : '') +
          (schemaWarns.length ? '\n' + schemaWarns.join('\n') : '');
      }

      case 'configure_output': {
        const node = this._find(a.nodeId);
        if (!node || node.type !== 'output') return { error: `没找到出口节点 ${a.nodeId}。` };
        node.template = String(a.template == null ? node.template : a.template);
        if (emit) emit({ type: 'ai_graph', card: this.card, focus: node.id });
        // 从模板里抽占位符用 paramsOf —— 它收的是**模板字符串**, 返回引用名数组。
        // 以前这里写的是 collectRefs, 那个收的是**整张卡**, 两处都不对:
        // 传单个节点进去会抛 "e.nodes is not iterable", 于是这个工具 100% 报内部错。
        // (validateEngine 里查同一件事用的就是 paramsOf, 那边一直是对的。)
        const refs = Engine.paramsOf(node.template);
        const bad = refs.filter((r) => !this._refExists(r));
        // 引用对得上, 还要"这条路上跑得到": 另一条分支上的节点, 走这条路时没跑过
        const anc = this._ancestorsOf(node.id);
        const offBranch = [];
        for (const r of refs) {
          const head = String(r || '').split('.')[0];
          if (!this._find(head)) continue;          // 不是节点引用, 上面那层已经管了
          if (!anc.has(head)) offBranch.push(`${r} (节点「${this.byTitle(head)}」不在通往这个出口的路上)`);
        }
        return `出口「${node.title}」模板已设: ${node.template}` +
          (bad.length ? `\n注意: 这些引用解析不到, 渲染出来会是空的 -> ${bad.join(', ')}` : '') +
          (offBranch.length
            ? `\n注意: 这些引用在这条分支上拿不到值 (那个节点只在另一条分支上跑), 渲染出来会是空的 -> ${offBranch.join('; ')}` +
              `。两条分支各自只引用自己这条路上跑过的节点; 要共用就把它挪到分支之前。`
            : '');
      }

      case 'validate_draft': {
        const r = Engine.validateEngine(this.card, { schema: this._schemaForValidation() });
        this.tested.validated = r.ok;
        if (r.ok && !r.warnings.length) return '草稿检查通过, 没有硬错也没有提醒。下一步该 run_test 真跑一遍了。';
        const parts = [];
        if (r.errors.length) parts.push('硬错:\n' + r.errors.map((e) => '- ' + (e.message || e)).join('\n'));
        if (r.warnings.length) parts.push('提醒:\n' + r.warnings.map((w) => '- ' + (w.message || w)).join('\n'));
        parts.push(r.ok ? '硬错清掉了, 提醒可以不管。接下来 run_test 真跑一遍。' : '先把硬错修掉, 再 run_test。');
        return parts.join('\n');
      }

      case 'recall': {
        const h = String(a.handle == null ? '' : a.handle).trim().replace(/^["']|["']$/g, '');
        if (!h) return { error: '要给一个编号, 形如 h3 —— 就是存根尾上写的那个。' };
        const text = this._foldStore.get(h);
        if (text == null) {
          // 如实说"取不到了", 不能假装还在 —— 模型据此决定要不要重跑。
          return `编号 ${h} 取不到了。可能是编号写错了, 也可能它太早、已经被清掉 (这个仓库只留最近 40 条)。` +
            '如果确实需要那个结果, 只能重新调用对应的工具再查一次。';
        }
        return `编号 ${h} 的全文：\n\n${text}`;
      }

      case 'render_sql': {
        const node = this._find(a.nodeId);
        if (!node) return { error: `没找到节点 ${a.nodeId}。` };
        if (node.type !== 'query') return { error: `节点「${node.title}」不是取数节点, 没有 SQL 可看。` };
        // 上游取值来自上一次真跑 (this._queryCache)。没跑过就只能渲染入口参数,
        // 那种情况下要如实说清楚"这部分我没法填", 不能假装渲染结果是全的。
        const inputs = {};
        if (this._lastTestInputs) for (const [k, v] of Object.entries(this._lastTestInputs)) inputs[k] = v;
        const r = Engine.previewSql(this.card, node.id, this._queryCache, inputs);
        if (r.error) return { error: r.error };
        const lines = [];
        lines.push(`节点「${r.title}」渲染后的 SQL：`);
        lines.push(r.sql || '(空)');
        if (r.params.length) {
          lines.push('\n各参数代入的值：');
          for (const p of r.params) lines.push(`  {{${p.key}}} <- ${p.value}  代入成 ${p.literal}`);
        }
        if (r.missing.length) {
          lines.push(`\n注意: 这些占位符没有值, 渲染时被整个抹掉了 -> ${r.missing.join(', ')}` +
            '\n(上游没查到行, 或者参数名写错了。被抹掉后条件会变成 WHERE x = 空串 这种, 库不会报错, 只会给 0 行。)');
        }
        if (r.blank.length) {
          lines.push(`\n注意: 这些参数取到的是空值 -> ${r.blank.join(', ')}`);
        }
        // 一眼能看出来的那个坑: 列表被当成一个字符串套了引号
        for (const p of r.params) {
          if (/^数组\(/.test(p.value) && /^'/.test(p.literal)) {
            lines.push(`\n**问题在这**: {{${p.key}}} 是一个列表, 但代入后成了 ${p.literal} —— ` +
              '整个列表被当成**一个字符串**套了引号。' +
              '\n如果它写在 IN (...) 里, 库会拿这个整串去比, 永远匹配不上, 而且不报错, 只给你 0 行。' +
              '\n改法: 别用 IN ({{x}})。要么让 SQL 那边用 FIND_IN_SET(列, {{x}}), 要么改成逐行取值再拼。');
          }
        }
        if (!Object.keys(this._queryCache).length) {
          lines.push('\n(还没成功跑过一次, 所以上游节点的值我填不上 —— 先 run_test 一次, 这里就能看到真实渲染结果了。)');
        }
        return lines.join('\n');
      }

      case 'run_test': {
        // ---- 闸门: 规划没做完不许测 ----
        //
        // 这正是用户提的那条: "全部按照规划完成后再进行测试"。不这么拦, 模型会
        // 建到一半就去跑一次 —— 那时候图还没连完, 跑出来的错跟真正的问题无关,
        // 它照着那个错去改, 改完再跑, 于是进入"每次都发现一个新错"的循环。
        // 实测会话里 16 次试跑有 8 次属于这类空转。
        const pend = this._pendingSteps();
        if (this.plan && pend.length) {
          return {
            error: `规划里还有 ${pend.length} 步没做完, 现在测不了。` +
              `\n没做完的: ${pend.map((s) => s.title).join('、')}` +
              '\n把规划里的步骤做完 (做完一步用 plan_step_done 标一下), 全部完成之后再来 run_test。' +
              '\n如果规划本身要改 (比如发现某一步不必要、或者漏了一步), 重新调 plan_task 出一版新规划 —— 那也算数。'
          };
        }
        const inputs = {};
        for (const [k, v] of Object.entries(a.inputs || {})) inputs[k] = v == null ? '' : String(v);
        // 必填没给会直接抛, 提前补一句能照着做的话, 比原始报错有用
        const inputNode = (this.card.nodes || []).find((n) => n.type === 'input');
        const missing = (inputNode ? inputNode.fields || [] : [])
          .filter((f) => f.required && !String(inputs[f.key] == null ? '' : inputs[f.key]).trim())
          .map((f) => f.label || f.key);
        if (missing.length) {
          return { error: `跑不起来: 还差必填输入 ${missing.join('、')}。把值填进 inputs 再调一次。` };
        }
        if (emit) emit({ type: 'ai_act', text: `试跑了一遍：${Object.keys(inputs).map((k) => k + '=' + inputs[k]).join(' ') || '(无输入)'}` });
        let r;
        try {
          // reuse: 模型把上次返回的 sqlByNode 贴回来, SQL 没变的节点就不查库。
          // 只认**上次真的跑过**的那些节点 —— 模型乱传的键会被引擎按"SQL 对不上"忽略掉,
          // 因为复用前要逐字节比对渲染后的 SQL。
          r = await Engine.testEngine(this.card, inputs, this.databases, this.openDb, {
            reuse: (a.reuse && typeof a.reuse === 'object') ? a.reuse : null,
            // 探针跑: 套行数上限, 秒级验链路 (结果被截断, 不能当最终验证)
            probeRows: a.probe ? 200 : 0
          });
        } catch (e) {
          return { error: '试跑失败: ' + e.message };
        }
        // 存下这次的查询结果, 供下一轮复用。按输入分组: 换了单号参数就全变了,
        // 拿旧结果会给出错误结论 —— 所以只在同一组输入内复用。
        {
          const key = JSON.stringify(inputs);
          if (this._queryCacheKey !== key) { this._queryCacheKey = key; this._queryCache = {}; }
          for (const [id, e] of Object.entries(r.queryCache || {})) this._queryCache[id] = e;
          // 记住这组输入 —— render_sql 要用它把入口参数填上
          this._lastTestInputs = Object.assign({}, inputs);
        }
        this.tested.ran = !!r.ok;
        const lines = [];
        for (const s of r.steps) {
          const tag = s.error ? '✗' : '·';
          const bits = [s.title];
          if (s.sql) bits.push(`SQL: ${s.sql}`);
          if (typeof s.rowCount === 'number') bits.push(`${s.rowCount} 行`);
          if (s.reused) bits.push('(沿用上次结果, 没重查)');
          if (s.condition) bits.push(`判定: ${s.condition} -> ${s.result ? '成立' : '不成立'}`);
          if (s.text) bits.push(`结论: ${s.text}`);
          if (s.error) bits.push(`错误: ${s.error}`);
          lines.push(`${tag} ${bits.join(' | ')}`);
        }
        if (r.reused && r.reused.length) {
          lines.push(`复用: ${r.reused.length} 个节点的 SQL 没变, 沿用了上次结果 (省下重查的时间)。`);
        }
        if (r.blankParams.length) {
          lines.push(`注意: 这些参数这一轮取到的是空值 (上游没查到行, 或那一列本身是 NULL), SQL 里的条件被抹成了 '' -> ${r.blankParams.join(', ')}`);
        }
        if (r.missingRefs.length) {
          lines.push(`注意: 结论里这些引用没落地, 渲染成了空白 -> ${r.missingRefs.join(', ')}`);
        }
        if (r.ok) {
          lines.push(`\n跑通了。用户会看到的结论:\n${r.answer || '(出口模板是空的, 用户什么也看不到)'}`);
          if (!r.answer) lines.push('出口模板得写点东西, 不然跑通了也没有结论。');
        } else {
          lines.push(`\n没跑通, 断在这一步: ${r.error}`);
          if (r.hint) lines.push(r.hint);
          lines.push('回去修这一步, 修完再 run_test。');
        }
        // 把"每个节点这次实际跑的 SQL"交回去, 让模型下一次原样贴进 reuse。
        // 只给 SQL 字符串, 不给行数据 —— 行数据会撑爆上下文, 而且下次由引擎自己从缓存里取。
        const sqlByNode = {};
        for (const [id, e] of Object.entries(r.queryCache || {})) {
          if (e && typeof e.sql === 'string') sqlByNode[id] = { sql: e.sql, ok: !!e.ok };
        }
        if (Object.keys(sqlByNode).length) {
          lines.push(`\n下次只改了一部分节点的话, 把下面这段原样传给 reuse, 没改的节点就不用重查了：\n`
            + JSON.stringify(sqlByNode));
        }
        return lines.join('\n');
      }

      case 'reply': {
        // 只是说话, 不碰卡。**不能**置 this.finished —— 那个标志的含义是
        // "这张卡搭好了", 置了之后 main.js 会把诊断 Agent 和自动修复循环
        // 整套拉起来。用户就说了句"你好", 不该付这个钱。
        const text = String(a.text || '').trim();
        if (!text) return 'reply 缺少 text 参数, 请重新调用。';
        this.repliedOnly = true;
        this.lastToolText = text;
        if (emit) emit({ type: 'ai_say', text });
        return text;
      }

      case 'finish': {
        // 硬闸门: 没真跑通就不许收尾。提示词里写了模型也会跳, 所以这里再拦一次。
        if (!this.tested.ran) {
          return {
            error:
              '先别收尾 —— 这张卡还没有成功试跑过一次。' +
              '调 run_test (带上入口字段的样例值) 真跑一遍; 跑通了再 finish。' +
              '静态体检 (validate_draft) 看不出 SQL 写错、字段不存在, 只有真跑才能证明它可用。'
          };
        }
        this.finished = true;
        const summary = String(a.summary || '搭好了。');
        // 收尾这句得让用户看见 —— 它是"这张卡怎么跑"的交代
        if (emit) emit({ type: 'ai_say', text: summary });
        return summary;
      }

      default:
        return `没有这个工具: ${call.name}`;
    }
  }

  _newNode(type, title) {
    const n = { id: Engine.genId('n'), type, title: title || Engine.NODE_LABEL[type] };
    // 位置交给 _layout() 统一排, 这里只给个占位
    n.x = 60;
    n.y = 240;
    if (type === 'input') { n.fields = [{ key: 'input1', label: '输入项', required: true, desc: '' }]; }
    if (type === 'query') { n.databaseId = ''; n.table = ''; n.sql = ''; n.fields = []; n.outputs = []; }
    if (type === 'condition') { n.expr = { type: 'group', logic: 'and', items: [] }; }
    if (type === 'output') { n.template = ''; }
    return Engine.normalizeNode(n);
  }

  /**
   * 按图的层级重排位置: 一条链从左往右铺开, 条件分出的两支上下岔开。
   * 位置只跟"图上离入口有多远"有关, 跟加的先后顺序无关 ——
   * 以前按 nodes.length 算 x, 草稿自带的节点就占了大半格, 新节点一上来就压住它。
   */
  _layout() {
    const nodes = this.card.nodes || [];
    const edges = this.card.edges || [];
    if (!nodes.length) return;
    const ids = new Set(nodes.map((n) => n.id));
    const indeg = new Map(nodes.map((n) => [n.id, 0]));
    const inPort = new Map();
    for (const e of edges) {
      if (!ids.has(e.from) || !ids.has(e.to)) continue;
      indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
      if (!inPort.has(e.to)) inPort.set(e.to, e.port);
    }

    // 层级 = 从入口出发的最长路。入口和没有入边的节点算第 0 层。
    const rank = new Map();
    const roots = nodes.filter((n) => n.type === 'input' || !indeg.get(n.id)).map((n) => n.id);
    if (!roots.length) roots.push(nodes[0].id);
    for (const r of roots) rank.set(r, 0);
    for (let pass = 0; pass <= nodes.length; pass++) {
      let moved = false;
      for (const e of edges) {
        const fr = rank.get(e.from);
        if (fr == null || !ids.has(e.to)) continue;
        const cur = rank.get(e.to);
        if (cur == null || cur < fr + 1) { rank.set(e.to, fr + 1); moved = true; }
      }
      if (!moved) break;
    }
    for (const n of nodes) if (!rank.has(n.id)) rank.set(n.id, 0);

    // 同层内再排: 走"成立"那支的排在上面, 走"不成立"的排下面
    const ordered = nodes.slice().sort((x, y) => {
      const d = rank.get(x.id) - rank.get(y.id);
      if (d) return d;
      const px = inPort.get(x.id) === 'false' ? 1 : 0;
      const py = inPort.get(y.id) === 'false' ? 1 : 0;
      return px - py;
    });
    const lane = new Map();
    for (const n of ordered) {
      const r = rank.get(n.id);
      const k = lane.get(r) || 0;
      lane.set(r, k + 1);
      n.x = 60 + r * 250;
      n.y = 220 + k * 165;
    }
  }

  _find(id) { return (this.card.nodes || []).find((n) => n.id === String(id || '').trim()); }
  _byId() { const m = {}; for (const n of this.card.nodes || []) m[n.id] = n; return m; }
  byTitle(id) { const n = this._find(id); return n ? n.title : id; }
  _dbName(dbId) {
    const d = this.databases.find((x) => x.id === dbId);
    return d ? (d.name || d.id) : (dbId || '没选');
  }

  /**
   * 一次 send() 内共用的连接: 按库缓存, 免得每张表/每次工具调用都重开一次。
   * (为什么这么重要见构造函数里 this._dbs 的注释。)
   */
  _sharedDb(dbConf) {
    const id = String((dbConf && (dbConf.id || dbConf.name)) || '');
    if (!this._dbs.has(id)) this._dbs.set(id, this.openDb(dbConf));
    return this._dbs.get(id);
  }

  /** 丢掉某个库的缓存连接 (连接已断时用, 下次取会重连) */
  _dropDb(dbConf) {
    const id = String((dbConf && (dbConf.id || dbConf.name)) || '');
    const db = this._dbs.get(id);
    if (!db) return;
    this._dbs.delete(id);
    try { db.close(); } catch (e) {}
  }

  /** send() 收尾: 关掉这次会话开出来的所有连接 */
  async _closeDbs() {
    for (const db of this._dbs.values()) {
      try { await db.close(); } catch (e) {}
    }
    this._dbs.clear();
  }

  /**
   * 把"看过的表结构"整理成 validateEngine 认的 schema 形状 (表名 -> 列 -> 类型)。
   * this.described 的键是 "库id|表名" —— validateEngine 只认表名, 所以取最后一段。
   */
  _schemaForValidation() {
    const schema = {};
    for (const [key, cols] of (this.described || new Map()).entries()) {
      const table = String(key).split('|').pop();
      if (!table) continue;
      const box = schema[table] || (schema[table] = {});
      for (const c of (cols || [])) if (c && c.field) box[c.field] = { type: c.type || '' };
    }
    return schema;
  }

  /**
   * 从 target 往回找, 哪些节点在通往它的路上。
   * 出口引用了一个"只在另一条分支上跑"的节点时, 走这条路渲染出来是空的 ——
   * 静态校验管不到这层, 但这里能提前告诉模型。
   */
  _ancestorsOf(target) {
    const seen = new Set();
    const stack = [target];
    while (stack.length) {
      const cur = stack.pop();
      for (const ed of this.card.edges || []) {
        if (ed.to !== cur || seen.has(ed.from)) continue;
        seen.add(ed.from);
        stack.push(ed.from);
      }
    }
    return seen;
  }

  /** 入口节点里有没有这个字段 */
  _inputFieldExists(key) {
    const inputs = (this.card.nodes || []).filter((n) => n.type === 'input');
    return inputs.some((n) => (n.fields || []).some((f) => f.key === key));
  }

  /** 这个引用解析得到吗 (跟引擎同一套规则, 提前把坑堵住) */
  _refExists(ref) {
    const path = String(ref || '').trim();
    if (!path) return false;
    const parts = path.split('.');
    const head = parts[0];
    const node = this._find(head);
    if (node) {
      const rest = parts.slice(1);
      if (!rest.length) return true;
      if (['rowCount', 'ok', 'error'].includes(rest[0])) return true;
      if (node.type === 'query') {
        if ((node.outputs || []).some((c) => c.key === rest[0]) || rest[0] === 'rows') return true;
        // 循环体里的裸名会被 paramsOf 限定成 节点.列名。如果这一格其实是**入口字段**
        // (循环里用入口字段是合法的), 这里得认 —— 否则搭建 Agent 会收到一次
        // 假的"这些引用解析不到", 然后去改一段本来正确的模板。
        return this._inputFieldExists(rest[0]);
      }
      if (node.type === 'output') return false;
      return true;
    }
    // 不是节点, 那就是入口字段
    return this._inputFieldExists(path);
  }

  /* ---- 主循环 ---- */

  /**
   * 发请求前给对话史做一次体检。
   *
   * 为什么需要: 只要有一轮 assistant(tool_calls) 没跟上对应的 role:'tool',
   * 服务端就会一直打回 400。而对话史是累积的 —— 一处不对, 之后每一轮都发不出去,
   * 用户卡在一句看不懂的英文报错上, 除了重开没有出路。
   *
   * 修法是保成合法形状, 不是整段丢掉: 摘掉 assistant 上那个悬空的 tool_calls
   * (它说过的话留着), 再把没主的 tool 应答丢掉。这样既保住上下文, 又不会 400。
   * 返回修了几处。
   */
  _sanitizeHistory() {
    const src = this.messages || [];
    const out = [];
    let fixed = 0;
    for (let i = 0; i < src.length; i++) {
      const m = src[i];
      if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        const need = m.tool_calls.map((c) => c.id);
        const acked = [];
        let j = i + 1;
        while (j < src.length && src[j].role === 'tool') { acked.push(src[j].tool_call_id); j++; }
        const complete = need.length === acked.length && need.every((id, k) => id === acked[k]);
        if (complete) {
          out.push(m);
          for (let k = i + 1; k < j; k++) out.push(src[k]);
        } else {
          // 悬空的 tool_calls: 摘掉它, 但保留 assistant 说过的话
          fixed++;
          if (m.content && String(m.content).trim()) out.push({ role: 'assistant', content: m.content });
        }
        i = j - 1;
        continue;
      }
      if (m.role === 'tool') { fixed++; continue; }   // 没主的 tool 应答, 丢掉
      out.push(m);
    }
    return { messages: out, dropped: fixed };
  }

  /**
   * 用户说一句, 模型接着干。边干边 emit。
   *
   * @param opts.cancel    { v:boolean } 取消令牌。用户点「停止」时置 v=true。
   *                       以前这里根本没有取消通道 —— stopReason === 'cancelled'
   *                       那条分支是死代码, 搭建一旦跑起来就只能等它自己结束。
   * @param opts.maxSteps  一轮的步数上限 (配置页可调), 默认 MAX_TURNS
   * @param opts.maxRounds 最多自动续几轮, 默认 MAX_ROUNDS
   * @returns { ok, reply, ask?, card, finished, exhausted? }
   */
  async send(userText, emit, opts = {}) {
    try {
      return await this._sendInner(userText, emit, opts);
    } finally {
      // 这次会话 (一次 send) 开出来的连接在这里统一收尾 —— 工具内部不再各自 close,
      // 由这一次性关闭兜底。用包装层而不是给 _sendInner 里每个 return 补清理: 漏一个就是泄漏。
      await this._closeDbs();
    }
  }

  async _sendInner(userText, emit, opts = {}) {
    const say = (text) => { if (emit && text) emit({ type: 'ai_say', text }); };

    const cancel = (opts && opts.cancel) || null;
    const maxSteps = Number.isFinite(opts && opts.maxSteps) && opts.maxSteps > 0
      ? Math.floor(opts.maxSteps) : MAX_TURNS;
    const maxRounds = Number.isFinite(opts && opts.maxRounds) && opts.maxRounds > 0
      ? Math.floor(opts.maxRounds) : MAX_ROUNDS;
    const isCancelled = () => !!(cancel && cancel.v);

    // 每次进来先清掉"上一轮收尾了"的标记。
    //
    // 这个标记的语义是"**这一轮**该停了", 不是"这个会话结束了"。之前只在 finish 里
    // 置 true、从不重置, 后果是: 一张搭完的卡, 用户接着说下一句话时, 主循环跑完
    // **第一个**动作就撞上 `if (this.finished)` 直接 break —— 模型明明打算接着干
    // 三个动作, 却只做了第一个就停。
    // 最坏的情况是那第一个动作恰好是 add_node: 节点加上了、线还没连, 卡被改坏在
    // 半路, 而且它没机会体检和自测。用户看到的就是"动了一下就没了"。
    //
    // 放在 push 用户消息之前清, 是因为下面那句"体检"和整个主循环都依赖它。
    this.finished = false;
    // 这一轮是不是"只是说了句话" (reply)。跟 finished 分开: 前者是"卡搭好了",
    // 后者是"用户没在搭卡, 我回了一句"。混在一起会让 main.js 误拉起整套自测。
    this.repliedOnly = false;

    if (userText && String(userText).trim()) {
      this.messages.push({ role: 'user', content: String(userText).trim() });
    }

    // 体检 + 就地修好 (修完写回去, 免得每轮都要重算)
    const healed = this._sanitizeHistory();
    if (healed.dropped) {
      this.messages = healed.messages;
      if (emit) emit({ type: 'ai_act', text: `发现 ${healed.dropped} 处对话记录不完整，已跳过，继续往下搭`, err: true });
    }

    let reply = '';
    // 用尽标志由运行时的 stopReason 决定 (见下面 res.stopReason === 'budget')。
    // 只有模型自己收尾 (调 finish, 或者明确不再有下一步) 才算正常结束 ——
    // 循环跑满 MAX_TURNS 而没收尾, 说明这张卡很可能只搭了一半, 这个信号必须
    // 传出去, 否则编排层会把它当成"改完了" (见 main.js 的 runTestLoop)。
    // 提问 / 最后一个工具返回的内容, 由 _registry 的适配层记下来
    this.pendingAsk = null;
    this.lastToolText = '';

    // ---- 交给统一运行时 ----
    //
    // 它管控制流、协议对接、并发执行、预算、上下文压缩; 这里只管"有哪些工具、
    // 提示词写什么、哪几个工具算终结"。
    //
    // 换过来的直接收益:
    //   - 一轮里多个只读动作会真的都执行 (以前只执行第一个, 其余回灌"已跳过")
    //   - 模型格式飘了 / 编了不存在的工具, 会回灌纠正并继续 (以前直接当收尾)
    //   - 上下文超限会折叠旧工具结果 (这张卡的对话史很长, 以前会一路涨到撑爆)
    //   - 预算快用完会明确告诉它"该收尾了", 而不是硬截断
    //
    // ---- 多轮 ----
    //
    // 一轮跑满步数**不等于**该交回用户了: 系统知道卡没搭完 (this.finished 才是凭据),
    // 所以自己接着跑下一轮。到顶 (maxRounds) 才交回, 并如实说清跑了多少步。
    let res = null;
    let round = 0;
    // 时间与 token 的账 —— 每轮都是一个新的 AgentLoop, 只取最后一轮会漏掉
    // 前面所有轮 (同 usage 的道理)。收尾时一次性报给用户, 见 _emitSpent。
    const spent = {
      steps: 0, calls: 0, input: 0, output: 0, llmMs: 0, toolMs: 0,
      byTool: Object.create(null), byToolCalls: Object.create(null)
    };
    for (let i = 1; i <= maxRounds; i++) {
      round = i;
      // 还有下一轮可用时, 告诉循环"别急着收敛"。
      //
      // 那条 nudge 的原文是"步数快用完了, 请立刻收敛, 不要再开新的探索"。在有续轮
      // 的情况下这句话是有害的: 它会逼模型提前交一份半成品 (半成品的 finish 会被
      // 闸门拦下, 白烧两步), 而本来它只要接着干就行。
      const loop = new AgentLoop(this.ctx.toLoop({
        llm: this.llm,
        tools: this._registry(),
        maxSteps,
        continues: i < maxRounds,
        cancel,
        // 折叠掉的旧结果留在仓库里, 存根上带编号 —— 模型可以用 recall 取回来,
        // 不必重新查一遍库
        foldStore: this._foldStore,
        emit: (ev) => this._onLoopEvent(ev, emit, say),
        // 三个终结工具。ask_user / ask_choice 也是终结: 它们要停下来等用户回答,
        // 继续跑下去模型会在没有答案的情况下自己往下搭。
        //
        // finish 要**看闸门有没有放行**, 不能只看名字: 被硬闸门拦下来的时候它返回的
        // 是一句"先别收尾, 去 run_test", 那时候停下来闸门就形同虚设了 ——
        // 模型说一句"我完事了"就结束了, 卡根本没跑过。
        // _runToolInner 只在放行时才置 this.finished。
        stopWhen: (name) => {
          if (name === 'ask_user' || name === 'ask_choice') return true;
          // reply 也是终结: 模型判断"用户不是在让我搭卡", 说完这句就该停,
          // 继续跑下去它会开始 list_available_tables —— 那就是白烧钱。
          if (name === 'reply') return true;
          if (name === 'finish') return this.finished === true;
          return false;
        },
        ctx: { emit }
      }));

      res = await loop.run();
      // 运行完之后的对话史才是权威的 (含回灌与折叠), 写回 this.messages,
      // 它会随卡片状态一起存盘 (见 snapshot / restore)
      this.messages = res.messages;

      // 把这一轮的时间/token 累进总账
      const tm = res.timing || {};
      spent.llmMs += tm.llmMs || 0;
      spent.toolMs += tm.toolMs || 0;
      spent.steps += res.steps || 0;
      spent.calls += (res.usage && res.usage.calls) || 0;
      spent.input += (res.usage && res.usage.input) || 0;
      spent.output += (res.usage && res.usage.output) || 0;
      for (const k of Object.keys(tm.byTool || {})) spent.byTool[k] = (spent.byTool[k] || 0) + tm.byTool[k];
      for (const k of Object.keys(tm.byToolCalls || {})) {
        spent.byToolCalls[k] = (spent.byToolCalls[k] || 0) + tm.byToolCalls[k];
      }

      // 下面几种情况都该立刻停, 不该再开一轮:
      //   - 要问用户 (停下等回答)
      //   - 不是"步数用尽" (正常收尾 / 出错 / 被取消)
      //   - 卡真的搭完了 (finish 过了闸门)
      //   - 用户点了停止
      if (this.pendingAsk) break;
      if (res.stopReason !== 'budget') break;
      if (this.finished === true) break;
      if (isCancelled()) break;
      // 已经是最后一轮了就别再预告"接着往下搭" —— 那次续跑不会发生,
      // 而且轮次会显示成 "第 4/3 轮" 这种不存在的说法。
      if (i >= maxRounds) break;

      if (emit) {
        emit({
          type: 'ai_act',
          text: `第 ${i} 轮 ${maxSteps} 步用完了, 这张卡还没搭完 —— 自动接着往下搭 (第 ${i + 1}/${maxRounds} 轮)`
        });
      }
    }

    // ---- 这一轮花在哪: 必须说出来 ----
    // 放在所有 return 之前, 收尾/提问/出错/被停止都要报 —— 恰恰是"跑得久还
    // 没结果"的那几种情况下, 用户最需要看到时间花在哪儿。
    this._emitSpent(emit, spent, round);
    // 挂到实例上, 让它随 snapshot() 一起落盘。
    //
    // 上面那两行只把账**推给了界面** (ai_act 文本 + ai_spent 事件), 而界面是
    // 易失的: 关掉面板、重开对话、或者事后想复盘, 数字就没了。实测一个搭建会话
    // 跑了 25 分钟没收敛, 会话日志里**一个耗时数字都没有** —— 想判断"是模型慢
    // 还是数据库慢"只能靠猜。这就是把账写进盘的理由。
    this.spent = spent;

    // ---- 要问用户: 停在等回答 ----
    // 运行时已经替我们把 ask 那一轮的 tool_call 应答掉了 (stopWhen 在 _ack 之后),
    // 所以用户答完再发消息时对话史是完整的。
    if (this.pendingAsk) {
      const { ask, choice } = this.pendingAsk;
      this.pendingAsk = null;
      if (emit) emit({ type: 'ai_ask', question: ask, card: this.card, choice });
      return { ok: true, reply: res.finalText || '', ask, choice, card: this.card };
    }

    if (res.stopReason === 'error') {
      return { ok: false, error: res.error || '模型调用失败', card: this.card };
    }

    // 收尾文本优先; 模型没留话就用最后一个工具返回的内容 (finish 的返回值就是小结)
    const finalReply = res.finalText || this.lastToolText || '';

    // 步数用尽: 卡可能只搭了一半。以前这里照样 return ok:true,
    // 编排层于是记成"改完了"并把半成品当成修复结果上报 —— 必须显式区分。
    //
    // 走到这里说明**所有轮次都跑满了** (能续的话上面已经续了), 所以该交回用户。
    // 话里不再出现"再说一句继续" —— 系统自己已经尽力续过了, 该说清楚的是
    // "跑了多少步、还没搭完", 以及用户可以怎么接着推。
    if (res.stopReason === 'budget') {
      const total = maxSteps * round;
      const msg = round > 1
        ? `步数用完了: 连着跑了 ${round} 轮、一共 ${total} 步, 这张卡还是没搭完 —— 可能它比预期复杂, 或者一直卡在同一个地方。再说一句"继续"接着搭, 或者把流程拆小一点。`
        : `步数用完了: 这一轮 ${total} 步跑满, 这张卡还没搭完。再说一句"继续"接着搭 (每轮步数可以在「设置 · 通用 · 搭建流程卡」里调大)。`;
      if (emit) emit({ type: 'ai_done', card: this.card, summary: finalReply, exhausted: true });
      return {
        ok: false, error: msg, reply: finalReply, card: this.card,
        done: false, exhausted: true, rounds: round, steps: total
      };
    }

    // 被用户点了「停止」—— 不是搭完了, 也不是失败。
    // 以前这条是死代码 (send 从来没拿到过 cancel), 现在真的会走到了。
    if (res.stopReason === 'cancelled' || isCancelled()) {
      if (emit) emit({ type: 'ai_done', card: this.card, summary: finalReply, cancelled: true });
      return {
        ok: false, error: '已停止。画板上是停在这一刻的半成品, 检查后再接着改。',
        reply: finalReply, card: this.card, done: false, cancelled: true, rounds: round
      };
    }

    // "搭完了"的唯一凭据是 finish 真的被放行过 (this.finished)。
    //
    // **不能**拿"循环正常结束"当凭据: 模型在正文里回一句话 (连工具都没调)、
    // 或者只读了几个只读工具就停下, 循环同样是"正常结束", 但那跟卡搭没搭好
    // 毫无关系。以前这里写死 done: true, 于是用户在搭建面板里说句"你好",
    // 模型随便回一句, main.js 就把诊断 Agent 和自动修复循环整套拉起来了。
    const cardDone = this.finished === true;
    if (emit) {
      emit({ type: 'ai_done', card: this.card, summary: finalReply, chatOnly: !cardDone });
    }
    return { ok: true, reply: finalReply, card: this.card, done: cardDone, chatOnly: !cardDone };
  }

  /**
   * 把内置工具挂到注册表上。
   *
   * 处理函数直接复用 _runTool —— 工具逻辑本身是对的 (而且被测试锁着),
   * 这次迁移只换"谁来决定下一步", 不重写工具。所以这里是薄薄一层适配。
   *
   * 适配要处理三件 _runTool 特有的东西:
   *   __ask      提问不是字符串结果, 得单独记下来交给 send()
   *   error      注册表约定"失败以 {error} 返回", 不让它抛
   *   副作用标记  改图的工具不能并发 (两个 add_node 并发会互相踩连线)
   */
  _registry() {
    const r = new ToolRegistry();
    // 只读的: 查表结构、看数据、体检、试跑。这些并发跑没问题。
    // (集合定义在模块作用域, 因为「内部工具」页要读同一份)
    for (const t of TOOLS) {
      const fn = t.function;
      if (!fn || !fn.name) continue;
      r.add(
        fn.name,
        fn.description,
        fn.parameters,
        async (args, ctx) => {
          const out = await this._runTool(ctx && ctx.emit, { name: fn.name, args });
          // 提问: 记下来, 回一句能写进对话史的话 (运行时会 ack 它)
          if (out && typeof out === 'object' && out.__ask) {
            this.pendingAsk = { ask: out.__ask, choice: out.__choice || null };
            return `已向用户提问，等对方回答：「${out.__ask}」`;
          }
          if (out && typeof out === 'object' && out.error) return { error: out.error };
          const text = String(out == null ? '' : out);
          this.lastToolText = text;
          return text;
        },
        {
          readOnly: READ_ONLY.has(fn.name),
          group: 'build',
          // 改图的工具串行 —— 并发两个 add_node 会互相踩连线
          serial: !READ_ONLY.has(fn.name)
        }
      );
    }
    // 外部接入的工具 (MCP)。以前搭建 Agent 完全没有这条路。
    if (this.mcp) r.attachMCP(this.mcp);
    return r;
  }

  /** 运行时事件 -> 搭建面板对外的 ai_* 事件 */
  _onLoopEvent(ev, emit, say) {
    if (!ev) return;
    switch (ev.type) {
      case 'say': say(ev.text); return;
      // 流式正文: 边生成边推给面板 (它往实时气泡里追字)。delta_end 只是收尾信号。
      case 'delta': if (emit && ev.text) emit({ type: 'ai_delta', text: ev.text }); return;
      case 'delta_end': return;
      case 'tool_result': {
        // finish 是交卷, 不用报"我调了 finish"; 失败的动作也不写进对话流,
        // 免得看着像做了其实没做
        if (ev.name === 'finish') return;
        if (!emit || ev.ok === false) return;
        // 每步带耗时。慢的时候要能一眼分出"模型在想"还是"库里在算" ——
        // 一次性把 7 列丢给千万行的表统计, 那一步就是一两分钟, 而界面上
        // 它和"模型卡住了"长得完全一样。1 秒以下的报数只是噪音, 不写。
        const ms = Number(ev.elapsedMs || 0);
        const tail = ms >= 1000 ? ` · ${(ms / 1000).toFixed(1)}s` : '';
        emit({ type: 'ai_act', text: describeAct(ev.name, ev.args) + tail });
        return;
      }
      case 'phase':
        if (emit && ev.message) emit({ type: 'ai_act', text: ev.message, err: true });
        return;
      case 'compact':
        if (emit) emit({ type: 'ai_act', text: `对话记录过长，折叠了 ${ev.count} 条旧结果` });
        return;
      default: return;   // thought / tool_start 太碎, 不往界面上推
    }
  }

  /**
   * 把"这一轮到底花在哪"写进对话流。
   *
   * 起因 (实测, 2026-09-21): 一个搭建会话跑了 25 分钟还没收敛, 用户只看到
   * "它一直在想", 分不清是模型慢还是数据库慢。追下去是 17 次模型往返里有
   * 13 次 look_at_data, 每次都在千万行的生产表上做全表 COUNT(DISTINCT) ——
   * 光工具就吃掉大半时间。而日志里一个耗时数字都没存, 想复盘只能靠猜。
   *
   * 这一行让"慢"变成可定位的数字: 模型多少秒、工具多少秒、哪个工具最贵。
   * 同时另发一条结构化的 ai_spent —— 界面要画细分, 不该靠解析这句话。
   */
  _emitSpent(emit, spent, rounds) {
    if (!emit || !spent || !spent.steps) return;
    const secs = (ms) => {
      const n = Math.max(0, Math.round(ms));
      if (n < 60000) return `${(n / 1000).toFixed(1)} 秒`;
      return `${Math.floor(n / 60000)} 分 ${String(Math.round((n % 60000) / 1000)).padStart(2, '0')} 秒`;
    };
    const tools = Object.keys(spent.byTool)
      .map((name) => ({ name, ms: spent.byTool[name], n: spent.byToolCalls[name] || 0 }))
      .sort((a, b) => b.ms - a.ms);
    const head = `这一轮一共 ${spent.steps} 步 / ${secs(spent.llmMs + spent.toolMs)}`
      + (rounds > 1 ? ` (${rounds} 轮)` : '');
    const parts = [
      head,
      `模型 ${secs(spent.llmMs)} (${spent.calls} 次调用, token ${spent.input} 进 / ${spent.output} 出)`,
      `工具 ${secs(spent.toolMs)}${tools.length ? ' —— 最费时的: ' + tools.slice(0, 3).map((t) => `${t.name} x${t.n} ${secs(t.ms)}`).join(', ') : ''}`
    ];
    emit({ type: 'ai_act', text: parts.join(' · ') });
    emit({
      type: 'ai_spent',
      spent: {
        rounds, steps: spent.steps, calls: spent.calls,
        input: spent.input, output: spent.output,
        llmMs: spent.llmMs, toolMs: spent.toolMs,
        byTool: Object.assign({}, spent.byTool),
        byToolCalls: Object.assign({}, spent.byToolCalls)
      }
    });
  }

  /** 把模型这一轮输出认成一个工具调用 —— 已归统一运行时 (lib/agent-loop.js) */
}

/** 把工具调用翻成一句人话, 写进对话流 */
function describeAct(name, args) {
  const a = args || {};
  switch (name) {
    case 'list_available_tables': return '看了下有哪些表可用';
    case 'describe_tables': return `读了表结构：${(a.tables || []).join('、')}`;
    case 'write_card': return '一次性写出了整张卡';
    case 'add_node': return `加了一个节点：${a.title || a.nodeType}`;
    case 'delete_node': return `删了一个节点：${a.nodeId}`;
    case 'set_node_title': return `改了一个节点的标题：${a.title || ''}`;
    case 'connect': return `连了一条线：${a.from} → ${a.to}`;
    case 'disconnect': return `拆了一条线：${a.from} ${a.port || 'out'}`;
    case 'ask_user': return '想跟你确认一件事';
    case 'ask_choice': return `想跟你确认：${a.question || '一件事'}`;
    case 'configure_input': return '配了入口要问的信息';
    case 'configure_query': return `写了一条取数 SQL`;
    case 'configure_condition': return '配了判断条件';
    case 'configure_output': return '写了结论文本';
    case 'validate_draft': return '自检了一遍';
    // 规划不进"只读"集合 (它改的是规划状态), 但也不该跟建卡动作抢顺序 ——
    // 串行执行对它是安全的, 不额外优化。
    case 'plan_task': return a.steps && a.steps.length ? `出了一版规划 (${a.steps.length} 步)` : '出了一版规划';
    case 'plan_step_done': return `标了完成：${a.stepId || ''}`;
    case 'recall': return `取回了一条旧结果：${a.handle || ''}`;
    case 'render_sql': return '看了一眼渲染后的 SQL';
    case 'run_test': return '拿样例输入真跑了一遍';
    case 'look_at_data': {
      // 支持一次看多列 (column 和 columns 两种写法), 报的时候要都说出来 ——
      // 只说第一列的话, 用户会以为后面的列没看
      const cols = [];
      if (a.column) cols.push(String(a.column));
      if (Array.isArray(a.columns)) for (const c of a.columns) if (c) cols.push(String(c));
      const uniq = Array.from(new Set(cols.filter(Boolean)));
      return `看了真实数据：${a.table || ''}${uniq.length ? '.' + uniq.join('、') : ''}`;
    }
    case 'check_index': return `查了 ${a.table || ''} 的索引`;
    case 'find_value': {
      // 把"找哪个值"说清楚 —— 用户看到这行就知道它在追哪个单号
      const vals = [];
      if (a.value != null && String(a.value).trim()) vals.push(String(a.value).trim());
      if (Array.isArray(a.values)) for (const v of a.values) if (v) vals.push(String(v));
      const uniq = Array.from(new Set(vals));
      return `在 ${a.table || ''} 里找这个值落在哪一列`
        + (uniq.length ? `：${uniq.join('、')}` : '');
    }
    default: return name;
  }
}

/**
 * 这个错误是不是"连接断了"(而不是 SQL 写错)?
 * 用来决定要不要把缓存的连接丢掉重连 —— SQL 语法错误丢掉连接是没必要的。
 */
function isConnError(e) {
  const code = String((e && e.code) || '');
  const msg = String((e && e.message) || e || '');
  return /ECONNRESET|EPIPE|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|PROTOCOL_CONNECTION_LOST/.test(code)
    || /Connection lost|Connection closed|closed state|socket hang up|connection is closed/i.test(msg);
}

/**
 * 搭建 Agent 里"只读、可并发"的工具: 查表结构、看数据、体检、试跑。
 * 其余的都会改图, 必须串行 —— 两个 add_node 并发会互相踩连线。
 *
 * 名字要和 TOOLS 里的一致: 写错的后果是那个工具被当成"改图工具"而串行,
 * 不会出错但会变慢; 反过来把改图工具写进这里是危险的。
 *
 * 提到模块作用域是为了能被导出 —— 「内部工具」页展示的只读/串行读的是这一份。
 */
const READ_ONLY = new Set([
  'list_available_tables', 'describe_tables', 'look_at_data', 'find_value', 'check_index',
  'validate_draft', 'run_test',
  // recall 只从本地折叠仓库里读文本, render_sql 只做字符串替换 —— 都不碰数据库, 也不碰卡
  'recall', 'render_sql',
  // reply 只是说话, 不碰卡 —— 它确实什么都不改
  'reply'
]);

// buildSystemPrompt 一并导出: 它是"模型怎么判断该不该动手"的唯一来源,
// 测试要能直接读它, 而不是隔着一次模型调用去猜提示词写了什么。
module.exports = { EngineAiBuilder, TOOLS, buildSystemPrompt };
module.exports.BUILDER_LIMITS = BUILDER_LIMITS;
module.exports.normalizeBuilderLimits = normalizeBuilderLimits;
module.exports.MAX_TURNS = MAX_TURNS;
module.exports.MAX_ROUNDS = MAX_ROUNDS;
// 「内部工具」页要展示每个工具是只读还是串行 —— 读这里, 不另抄一份
module.exports.READ_ONLY = READ_ONLY;
