'use strict';

/**
 * 向量化客户端 (OpenAI 兼容的 /embeddings 协议)。
 *
 * 统一协议: POST {baseURL}/embeddings  body={ model, input: [...] }
 *           响应: { data: [{ embedding: [...], index }] }
 * Qwen/DashScope 的 compatible-mode、OpenAI、以及自建网关都吃这一套。
 *
 * 为什么不复用 lib/llm.js: 那个客户端绑死了 /chat/completions 与 messages 形状。
 * 硬塞一个 embeddings 方法进去会让它变成"两个协议的合体", 谁读都别扭。
 * 这里独立成一个小客户端, 但沿用同一套 baseURL + apiKey 习惯。
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const DEFAULT_BATCH = 16;       // 一次请求塞多少条文本 (多数网关限制 10~2048, 16 稳)
const MAX_RETRY = 3;

const PRESETS = {
  qwen: { label: '通义千问 / DashScope', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'text-embedding-v3' },
  openai: { label: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'text-embedding-3-small' },
  custom: { label: '自定义 (OpenAI 兼容)', baseURL: '', model: '' }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Embedder {
  constructor(config = {}) {
    this.baseURL = String(config.baseURL || '').replace(/\/+$/, '');
    this.apiKey = config.apiKey || '';
    this.model = config.model || '';
    this.batch = Math.max(1, Math.min(256, Number(config.batch) || DEFAULT_BATCH));
    this.timeoutMs = Number(config.timeoutMs) || 60000;
  }

  ready() {
    return !!(this.baseURL && this.model);
  }

  _post(pathSuffix, bodyObj) {
    return new Promise((resolve, reject) => {
      let url;
      try { url = new URL(this.baseURL + pathSuffix); }
      catch (e) { return reject(new Error('向量模型 baseURL 格式不正确: ' + e.message)); }
      const lib = url.protocol === 'https:' ? https : http;
      const payload = JSON.stringify(bodyObj);
      const req = lib.request({
        method: 'POST',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        timeout: this.timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...(this.apiKey ? { Authorization: 'Bearer ' + this.apiKey } : {})
        }
      }, (res) => {
        let data = '';
        res.setEncoding('utf-8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch (e) {}
          if (res.statusCode >= 400) {
            const msg = (json && json.error && json.error.message) || `HTTP ${res.statusCode} (前 120 字: ${data.slice(0, 120)})`;
            const err = new Error('向量服务返回错误: ' + msg);
            err.status = res.statusCode;
            return reject(err);
          }
          if (!json) return reject(new Error('向量服务返回的不是 JSON: ' + data.slice(0, 120)));
          resolve(json);
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { const e = new Error('向量请求超时, 已中断'); e.code = 'ETIMEDOUT'; req.destroy(e); });
      req.write(payload);
      req.end();
    });
  }

  /** 一次性把一批文本向量化 (内部自动按 batch 分组 + 瞬时重试) */
  async embed(texts) {
    const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t == null ? '' : t));
    if (!list.length) return [];
    if (!this.ready()) throw new Error('未配置向量模型 (baseURL / model)');
    const out = [];
    for (let i = 0; i < list.length; i += this.batch) {
      const slice = list.slice(i, i + this.batch);
      out.push(...await this._embedBatch(slice, i));
    }
    return out;
  }

  async embedOne(text) {
    const r = await this.embed([text]);
    return r[0] || [];
  }

  async _embedBatch(slice, offset) {
    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
      try {
        const json = await this._post('/embeddings', { model: this.model, input: slice });
        const data = Array.isArray(json.data) ? json.data.slice() : [];
        // 按 index 排序, 保证和输入顺序一致 (有的网关不保证顺序)
        data.sort((a, b) => (a.index || 0) - (b.index || 0));
        if (data.length !== slice.length) {
          throw new Error(`向量条数对不上: 期望 ${slice.length}, 返回 ${data.length}`);
        }
        return data.map((d) => d.embedding || []);
      } catch (e) {
        lastErr = e;
        // 4xx (密钥/参数错) 重试没意义
        if (e.status && e.status >= 400 && e.status < 500) break;
        if (attempt < MAX_RETRY) await sleep(400 * attempt);
      }
    }
    throw lastErr || new Error('向量化失败');
  }
}

module.exports = { Embedder, PRESETS, DEFAULT_BATCH };
