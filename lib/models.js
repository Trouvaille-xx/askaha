'use strict';

/**
 * 模型清单。
 *
 * ## 为什么要有这一层
 *
 * 以前 config.llm 就是一个扁平的模型: `{ baseURL, apiKey, model, temperature, maxTokens }`。
 * 现在要能配多个、并且让用户在对话页选。于是配置变成 `{ models: [...], activeId }`。
 *
 * 但**旧的扁平形状必须继续能读**。原因很实际: 用户机器上已经有一份 config.json,
 * 里面存着密钥。如果新版本只认新形状, 那份配置就会被当成"没配过模型" —— 用户
 * 打开应用发现要重新填 Key, 而原来的 Key 其实还在文件里躺着。
 * 所以这里做单向迁移: 读到扁平形状就把它变成一条模型。写回之后就永久是新形状了。
 *
 * ## LLMClient 为什么不改
 *
 * LLMClient 接的**就是一个模型** (它有 baseURL / apiKey / model 三个字段, 并且
 * 用它们发请求)。让它去理解"模型清单"是把两件事混在一起。所以这里只做
 * "从清单里挑出当前那一个", 挑完还是把扁平对象交给它 —— LLMClient 一行都不用动,
 * 已有的测试也全部继续有效。
 */

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_TOKENS = 2048;
/**
 * 上下文窗口上限的默认值。
 *
 * 128k 是 2025 年前后主流模型的常见档位。它**只是个默认值, 用户必须能改** ——
 * 各家的真实上限差得很远 (8k 到 1M), 而这个数字直接决定界面上那个圆环的百分比。
 * 填大了会让用户以为"还很空"从而撞上截断, 填小了会让他过早开新会话。
 * 所以界面上要明确写着这是"你填的上限", 不是"我们探测出来的"。
 */
const DEFAULT_CONTEXT_LIMIT = 128000;

let seq = 0;

/**
 * 生成模型 id。
 *
 * 时间戳 + 随机 + 进程内自增。自增那一段是为了防"同一毫秒内连加两条" ——
 * 用户点两下"新增"就能撞上, 而撞上之后两条模型的 id 相同, 选中/删除都会
 * 只作用到第一条, 看起来像"点删除没反应"。
 */
function newModelId() {
  seq = (seq + 1) % 1000;
  return 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + seq.toString(36);
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * 取数字, 取不到就用兜底值。
 *
 * `null` / `undefined` / `''` 都算"没填" —— 这一点很要紧, 因为 `Number(null)`
 * 是 **0**, 而 0 是个合法数字。不特判的话 `maxTokens: null` 会被读成"用户填了 0",
 * 然后夹到 1: 每次请求只给模型 1 个 token, 正文永远是空的, 而配置里那个
 * 孤零零的 `null` 看起来人畜无害。
 *
 * 显式填的 0 和负数则**当作填了**, 交给后面的夹取 —— 那是"填错了", 该被纠正,
 * 不是"没填", 该被忽略。
 */
function num(v, fallback) {
  if (v === null || v === undefined || v === '') return fallback;
  if (typeof v === 'boolean') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 把一条模型补全成确定的形状。字段名做过兼容: baseUrl / baseURL 都收。 */
function normalizeModel(m) {
  const s = (m && typeof m === 'object') ? m : {};
  const model = str(s.model) || DEFAULT_MODEL;
  return {
    id: str(s.id) || newModelId(),
    // 名字留空就用模型名当名字 —— 界面上列出来总得有个能认的东西
    name: str(s.name) || model,
    baseURL: str(s.baseURL) || str(s.baseUrl) || DEFAULT_BASE_URL,
    model,
    apiKey: typeof s.apiKey === 'string' ? s.apiKey : '',
    temperature: Math.min(2, Math.max(0, num(s.temperature, DEFAULT_TEMPERATURE))),
    maxTokens: Math.max(1, Math.round(num(s.maxTokens, DEFAULT_MAX_TOKENS))),
    // 上下文窗口上限。下限给 1000 —— 比这更小的模型不存在, 而 0 会让
    // 进度条除零。上限不设: 有的模型真的到 1M。
    contextLimit: Math.max(1000, Math.round(num(s.contextLimit, DEFAULT_CONTEXT_LIMIT)))
  };
}

/**
 * 把任何历史形状的 llm 配置归一成 `{ models, activeId }`。
 *
 * 三种输入都要能处理:
 *   1. 新形状 `{ models: [...], activeId }`
 *   2. 旧的扁平形状 `{ baseURL, apiKey, model }` → 迁移成一条
 *   3. 空 / 坏值 → 空清单 (界面显示"还没配模型")
 */
function normalizeLLM(llm) {
  const s = (llm && typeof llm === 'object') ? llm : {};
  let models = Array.isArray(s.models) ? s.models.map(normalizeModel) : [];

  // 旧的扁平形状: 只要有任何一个实质字段就迁移。
  // 注意判断的是"有没有内容", 不是"有没有这个 key" —— 出厂默认里
  // baseURL 是有值的, 拿它当依据会把一个空配置迁移成一条假模型。
  if (!models.length && (str(s.apiKey) || str(s.model) || str(s.baseURL))) {
    models = [normalizeModel({
      name: str(s.model) || '默认模型',
      baseURL: s.baseURL,
      model: s.model,
      apiKey: s.apiKey,
      temperature: s.temperature,
      maxTokens: s.maxTokens
    })];
  }

  // id 去重。手工编辑过 config.json 是能造出重复 id 的, 而重复 id 会让
  // "选中/删除"只作用到第一条 —— 那种 bug 在界面上看起来像"点了没反应"。
  const seen = new Set();
  for (const m of models) {
    if (seen.has(m.id)) m.id = newModelId();
    seen.add(m.id);
  }

  let activeId = str(s.activeId);
  if (!models.some((m) => m.id === activeId)) {
    activeId = models.length ? models[0].id : '';
  }
  return { models, activeId };
}

/**
 * 当前选中的那个模型 (扁平对象, 直接喂给 LLMClient)。
 *
 * 选中项被删掉时**回落到第一条**, 而不是返回 null —— 否则用户删掉正在用的模型
 * 之后每一次调用都会报"未配置模型", 而清单里明明还有别的能用。
 */
function activeModel(llm) {
  const { models, activeId } = normalizeLLM(llm);
  return models.find((m) => m.id === activeId) || models[0] || null;
}

/**
 * 下发给渲染层的形状: **绝不带明文密钥**。
 *
 * 顶层的 model / baseURL / apiKeySet 是当前选中那一个的摘要 —— 界面上顶栏、
 * 输入框旁边、以及"能不能发消息"的判断都要用, 让它们各自去 models 里翻
 * 会散出一堆重复的查找逻辑。
 */
function publicLLM(llm) {
  const { models, activeId } = normalizeLLM(llm);
  const cur = models.find((m) => m.id === activeId) || models[0] || null;
  return {
    models: models.map((m) => ({ ...m, apiKey: '', apiKeySet: !!m.apiKey })),
    activeId,
    // 顶层保留一个恒为空串的 apiKey。
    //
    // 它没有任何读取方 —— 留着是因为这一层是**安全边界**, 而 `apiKey: ''`
    // 摆在这儿就是在明说"这里把密钥剥掉了"。字段静默消失的话, 将来有人
    // 往这里加一句 `...m` 展开就没人看得出来多了个泄密点。
    apiKey: '',
    model: cur ? cur.model : '',
    baseURL: cur ? cur.baseURL : '',
    apiKeySet: !!(cur && cur.apiKey),
    // 上下文上限要下发 —— 界面上的圆环拿它做分母, 不下发的话渲染层只能
    // 自己编一个, 那就成了"两处各有一份真相"。
    contextLimit: cur ? cur.contextLimit : DEFAULT_CONTEXT_LIMIT
  };
}

/**
 * 存盘前的形状: 保留明文密钥 (它本来就存在 config.json 里), 丢掉派生的顶层字段。
 *
 * 只存 models + activeId。顶层那几个字段是"算出来的", 存进去就会有两份真相 ——
 * 而两份真相迟早对不上 (改了一条模型的 model 字段, 顶层的还是旧的)。
 */
function storedLLM(llm) {
  const { models, activeId } = normalizeLLM(llm);
  return { models, activeId };
}

module.exports = {
  newModelId,
  normalizeModel,
  normalizeLLM,
  activeModel,
  publicLLM,
  storedLLM,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_TEMPERATURE,
  DEFAULT_MAX_TOKENS,
  DEFAULT_CONTEXT_LIMIT
};
