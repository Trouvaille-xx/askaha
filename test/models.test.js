'use strict';

/**
 * 模型清单的回归测试。
 *
 * ## 这一组锁的是什么
 *
 * 需求是"能配多个模型、对话页能选"。功能本身简单, 风险全在**边角**上:
 *
 *   - 用户机器上已经有一份**旧的扁平配置** (里面存着密钥)。新版本读不懂它,
 *     用户就会看到"没配过模型" —— 而 Key 其实还在文件里。所以迁移必须成立。
 *   - 密钥**绝不能下发到渲染层** (报告是用 iframe srcdoc 渲染模型产出的 HTML 的,
 *     那层沙箱一旦松了, 明文密钥就等于递给了一段不可信脚本)。清单变成数组之后,
 *     每一层展开都是一个泄密机会, 所以这里逐条断言。
 *   - 选中项被删掉 / id 重复 / 字段缺失 —— 这些都不该让界面卡在一个
 *     "选了但没生效"的状态上。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  newModelId, normalizeModel, normalizeLLM, activeModel, publicLLM, storedLLM,
  DEFAULT_BASE_URL, DEFAULT_MODEL
} = require('../lib/models.js');
const { publicConfig } = require('../lib/public-config.js');

/* ============================================================
 * 一、旧的扁平配置要能迁移
 * ============================================================ */

test('迁移: 旧的扁平 llm 配置变成一条模型', () => {
  // 这是**真实存在的**形状 —— 用户机器上的 config.json 就长这样,
  // 里面那把 48 字符的 Key 是他填过的。读不懂就等于让他重填一遍。
  const legacy = {
    baseURL: 'https://llm.example.com/v1',
    apiKey: 'sk-real-key-48-chars',
    model: 'deepseek-v4.1-flash',
    temperature: 0.3,
    maxTokens: 4096
  };
  const { models, activeId } = normalizeLLM(legacy);
  assert.strictEqual(models.length, 1, '应该迁移出一条');
  assert.strictEqual(models[0].model, 'deepseek-v4.1-flash');
  assert.strictEqual(models[0].baseURL, 'https://llm.example.com/v1');
  assert.strictEqual(models[0].apiKey, 'sk-real-key-48-chars', '密钥必须保留 —— 否则用户要重填');
  assert.strictEqual(models[0].temperature, 0.3);
  assert.strictEqual(models[0].maxTokens, 4096);
  assert.strictEqual(activeId, models[0].id, '迁移出来的那条自动成为当前选中');
});

test('迁移: 迁移结果再读一次是稳定的 (幂等)', () => {
  // 启动时迁移 → 写回盘 → 下次启动读新形状。如果迁移不幂等, 每次启动都会
  // 生成新 id, 用户"选中的模型"就会莫名其妙地回到第一条。
  const legacy = { baseURL: 'https://x/v1', apiKey: 'k', model: 'm' };
  const once = storedLLM(legacy);
  const twice = storedLLM(once);
  assert.deepStrictEqual(twice, once, '第二次归一不该有任何变化');
  const thrice = storedLLM(twice);
  assert.deepStrictEqual(thrice, once, '第三次也一样');
});

test('迁移: 全新的空配置不该凭空造出一条假模型', () => {
  assert.strictEqual(normalizeLLM({}).models.length, 0);
  assert.strictEqual(normalizeLLM(null).models.length, 0);
  assert.strictEqual(normalizeLLM(undefined).models.length, 0);
  assert.strictEqual(normalizeLLM('nonsense').models.length, 0);
  assert.strictEqual(activeModel({}), null, '没有模型时当前模型是 null');
});

test('迁移: 出厂默认 (有地址有模型名但没 Key) 会带出一条待填 Key 的模型', () => {
  // 这是**刻意的**: 比给一个空列表体验好 —— 用户打开设置页看到一条已经填好
  // 地址和模型名的条目, 只需要补 Key。所以"配没配"必须靠 apiKeySet 判断,
  // 不能靠 models.length。
  const factory = { baseURL: DEFAULT_BASE_URL, apiKey: '', model: DEFAULT_MODEL };
  const { models } = normalizeLLM(factory);
  assert.strictEqual(models.length, 1);
  assert.strictEqual(models[0].apiKey, '');
  assert.strictEqual(publicLLM(factory).apiKeySet, false, '有模型但没 Key → apiKeySet 为 false');
});

/* ============================================================
 * 二、密钥绝不下发
 * ============================================================ */

test('安全: 清单里每一条的明文密钥都不下发', () => {
  const cfg = {
    models: [
      { id: 'a', name: 'A', baseURL: 'https://a/v1', model: 'ma', apiKey: 'sk-aaa-secret' },
      { id: 'b', name: 'B', baseURL: 'https://b/v1', model: 'mb', apiKey: 'sk-bbb-secret' }
    ],
    activeId: 'b'
  };
  const pub = publicLLM(cfg);
  assert.strictEqual(pub.models.length, 2);
  for (const m of pub.models) {
    assert.strictEqual(m.apiKey, '', '每一条的 apiKey 都必须是空串');
  }
  // 最要紧的一条: 整个下发对象序列化之后**不能出现**任何明文
  const dump = JSON.stringify(pub);
  assert.ok(!dump.includes('sk-aaa-secret'), '明文不该出现在下发副本里');
  assert.ok(!dump.includes('sk-bbb-secret'), '明文不该出现在下发副本里');
});

test('安全: 每条带 apiKeySet 让界面能显示"已保存"', () => {
  const cfg = {
    models: [
      { id: 'a', model: 'ma', apiKey: 'k' },
      { id: 'b', model: 'mb', apiKey: '' }
    ],
    activeId: 'a'
  };
  const pub = publicLLM(cfg);
  assert.strictEqual(pub.models[0].apiKeySet, true);
  assert.strictEqual(pub.models[1].apiKeySet, false);
});

test('安全: publicConfig 走的是同一层剥密钥', () => {
  // 端到端: 主进程整个 config 交给 publicConfig, 出来的东西不能有明文
  const out = publicConfig({
    llm: { models: [{ id: 'a', model: 'm', apiKey: 'sk-whole-config-secret' }], activeId: 'a' },
    databases: [{ id: 'd', password: 'db-secret' }]
  });
  const dump = JSON.stringify(out);
  assert.ok(!dump.includes('sk-whole-config-secret'));
  assert.ok(!dump.includes('db-secret'));
  assert.strictEqual(out.llm.apiKeySet, true);
});

test('安全: 顶层不带 ...llm 展开 (那会把明文一起带出去)', () => {
  const out = publicConfig({ llm: { models: [{ id: 'a', model: 'm', apiKey: 'sk-x' }], activeId: 'a' } });
  assert.deepStrictEqual(
    Object.keys(out.llm).sort(),
    ['activeId', 'apiKey', 'apiKeySet', 'baseURL', 'contextLimit', 'model', 'models'].sort()
  );
});

test('安全: 逐字段加整份序列化双重检查', () => {
  // 只查 apiKey 字段是不够的 —— 密钥可能被塞进任何别的字段里溜出去
  // (比如有人在某处做了 `{...m}` 展开)。所以再整份 dump 一次找明文。
  const secrets = ['sk-top-secret', 'sk-model-secret', 'sk-flat-secret'];
  const out = publicConfig({
    llm: {
      models: [
        { id: 'a', name: 'A', model: 'ma', baseURL: 'https://a/v1', apiKey: secrets[1] },
        { id: 'b', name: 'B', model: 'mb', baseURL: 'https://b/v1', apiKey: '' }
      ],
      activeId: 'a',
      apiKey: secrets[2]
    }
  });
  assert.strictEqual(out.llm.apiKey, '');
  for (const m of out.llm.models) assert.strictEqual(m.apiKey, '');
  const dump = JSON.stringify(out);
  for (const s of secrets) {
    assert.ok(!dump.includes(s), `明文 ${s} 不该出现在下发副本的任何位置`);
  }
});

/* ============================================================
 * 三、当前模型的选择
 * ============================================================ */

test('选中: activeId 指向不存在时回落到第一条', () => {
  // 用户删掉正在用的那条之后, activeId 会指向一个不存在的 id。
  // 不回落的后果是每次调用都报"未配置模型" —— 而清单里明明还有别的能用。
  const cfg = {
    models: [{ id: 'a', model: 'ma', apiKey: 'k' }, { id: 'b', model: 'mb', apiKey: 'k' }],
    activeId: 'deleted-one'
  };
  assert.strictEqual(activeModel(cfg).id, 'a');
});

test('选中: activeId 为空时用第一条', () => {
  const cfg = { models: [{ id: 'a', model: 'ma' }, { id: 'b', model: 'mb' }], activeId: '' };
  assert.strictEqual(activeModel(cfg).id, 'a');
});

test('选中: 明确指定的那一条会被选中 (不是永远第一条)', () => {
  const cfg = {
    models: [{ id: 'a', model: 'ma', apiKey: 'k' }, { id: 'b', model: 'mb', apiKey: 'k' }],
    activeId: 'b'
  };
  assert.strictEqual(activeModel(cfg).id, 'b');
  assert.strictEqual(activeModel(cfg).model, 'mb');
});

test('选中: 旧的扁平配置直接 activeModel 也能拿到 (不用先迁移)', () => {
  // main.js 在 loadConfig 里迁移, 但测试和别的调用点可能直接传扁平的。
  // 让它也能用, 免得出现"某些路径能跑、某些路径报未配置"。
  assert.strictEqual(activeModel({ baseURL: 'https://x/v1', apiKey: 'k', model: 'flat' }).model, 'flat');
});

test('选中: 切到没 Key 的那条时, publicLLM 的顶层摘要跟着变', () => {
  // 顶栏和"能不能发消息"读的都是顶层摘要。它不跟着变的话, 界面会显示
  // "已配置"而实际发不出去 —— 用户只会看到任务失败, 不知道差在 Key 上。
  const cfg = {
    models: [{ id: 'a', model: 'ma', apiKey: 'k' }, { id: 'b', model: 'mb', apiKey: '' }],
    activeId: 'a'
  };
  assert.strictEqual(publicLLM(cfg).apiKeySet, true);
  cfg.activeId = 'b';
  const pub = publicLLM(cfg);
  assert.strictEqual(pub.apiKeySet, false);
  assert.strictEqual(pub.model, 'mb');
});

/* ============================================================
 * 四、单条模型的字段补全
 * ============================================================ */

test('字段: 缺什么补什么, 不留 undefined', () => {
  const m = normalizeModel({ model: 'gpt-4o' });
  assert.strictEqual(m.baseURL, DEFAULT_BASE_URL);
  assert.strictEqual(m.temperature, 0.2);
  assert.strictEqual(m.maxTokens, 2048);
  assert.strictEqual(m.apiKey, '');
  assert.ok(m.id, '必须有 id');
  assert.strictEqual(m.name, 'gpt-4o', '名字留空就用模型名');
});

test('字段: 完全空的输入也给出一个可用的形状', () => {
  const m = normalizeModel({});
  assert.strictEqual(m.model, DEFAULT_MODEL);
  assert.strictEqual(m.baseURL, DEFAULT_BASE_URL);
  assert.ok(m.id && m.name);
});

test('字段: temperature 夹在 0~2, maxTokens 至少 1', () => {
  assert.strictEqual(normalizeModel({ temperature: 9 }).temperature, 2);
  assert.strictEqual(normalizeModel({ temperature: -3 }).temperature, 0);
  assert.strictEqual(normalizeModel({ maxTokens: 0 }).maxTokens, 1);
  assert.strictEqual(normalizeModel({ maxTokens: -100 }).maxTokens, 1);
  // 非数字走默认值, 不要 NaN —— NaN 发进请求体会被网关拒, 而报错信息
  // 通常只说"参数不合法", 查不到是 temperature 的锅
  assert.strictEqual(normalizeModel({ temperature: 'abc' }).temperature, 0.2);
  assert.strictEqual(normalizeModel({ maxTokens: null }).maxTokens, 2048);
});

test('字段: baseUrl 和 baseURL 两种拼法都收', () => {
  // 手写 config.json 很容易写成小写 u, 而这一个字母的差别会让请求打到
  // 默认的 openai.com 上去 —— 现象是"认证失败", 完全指不到真正的原因
  assert.strictEqual(normalizeModel({ baseUrl: 'https://lower/v1' }).baseURL, 'https://lower/v1');
  assert.strictEqual(normalizeModel({ baseURL: 'https://upper/v1' }).baseURL, 'https://upper/v1');
});

test('字段: 名字/地址/模型名都去掉首尾空白', () => {
  const m = normalizeModel({ name: '  主力  ', baseURL: '  https://x/v1  ', model: '  gpt-4o  ' });
  assert.strictEqual(m.name, '主力');
  assert.strictEqual(m.baseURL, 'https://x/v1');
  assert.strictEqual(m.model, 'gpt-4o');
});

test('id: 重复的 id 会被换掉', () => {
  // 手工编辑 config.json 能造出重复 id, 而重复 id 会让"选中/删除"只作用到
  // 第一条 —— 现象是"点了删除没反应"。
  const cfg = {
    models: [{ id: 'same', model: 'a' }, { id: 'same', model: 'b' }, { id: 'same', model: 'c' }],
    activeId: 'same'
  };
  const { models } = normalizeLLM(cfg);
  const ids = models.map((m) => m.id);
  assert.strictEqual(new Set(ids).size, 3, '三个 id 必须互不相同');
  assert.strictEqual(models.length, 3, '不能因为去重把模型丢了');
});

test('id: 同一毫秒连造多个也不撞', () => {
  // 用户连点两下"新增"就会撞上。撞上的后果是两条模型 id 相同,
  // 删除/切换只作用到第一条 —— 看起来像"点了没反应"。
  const ids = new Set();
  for (let i = 0; i < 500; i++) ids.add(newModelId());
  assert.strictEqual(ids.size, 500);
});

test('id: 缺 id 的条目会被补上, 且互不相同', () => {
  const { models } = normalizeLLM({ models: [{ model: 'a' }, { model: 'b' }], activeId: '' });
  assert.ok(models[0].id && models[1].id);
  assert.notStrictEqual(models[0].id, models[1].id);
});

/* ============================================================
 * 五、存盘形状
 * ============================================================ */

test('存盘: 只存 models + activeId, 不存派生的顶层字段', () => {
  // 顶层那几个 (model / baseURL / apiKeySet) 是"算出来的"。存进去就有两份真相,
  // 而两份真相迟早对不上 —— 改了一条模型的 model 字段, 顶层的还是旧的。
  const stored = storedLLM({ baseURL: 'https://x/v1', apiKey: 'k', model: 'm' });
  assert.deepStrictEqual(Object.keys(stored).sort(), ['activeId', 'models']);
});

test('存盘: 明文密钥保留在盘上 (它本来就存那儿)', () => {
  const stored = storedLLM({ models: [{ id: 'a', model: 'm', apiKey: 'sk-keep-me' }], activeId: 'a' });
  assert.strictEqual(stored.models[0].apiKey, 'sk-keep-me');
});

test('存盘: 坏输入不会把配置写坏', () => {
  for (const bad of [null, undefined, 0, '', 'x', [], { models: 'not-an-array' }]) {
    const s = storedLLM(bad);
    assert.ok(Array.isArray(s.models), `models 必须是数组 (输入 ${JSON.stringify(bad)})`);
    assert.strictEqual(typeof s.activeId, 'string');
  }
});
