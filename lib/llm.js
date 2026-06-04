/**
 * OpenAI 兼容的 LLM 客户端
 * 通过原生 https/http 模块实现，避免引入额外依赖
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

class LLMClient {
  constructor(config) {
    this.config = {
      baseURL: (config.baseURL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
      apiKey: config.apiKey || '',
      model: config.model || 'gpt-4o-mini',
      temperature: typeof config.temperature === 'number' ? config.temperature : 0.2,
      maxTokens: config.maxTokens || 2048
    };
  }

  update(config) {
    this.config = { ...this.config, ...config };
  }

  _request(body, stream = false, onChunk = null) {
    return new Promise((resolve, reject) => {
      let url;
      try {
        url = new URL(this.config.baseURL + '/chat/completions');
      } catch (e) {
        return reject(new Error('LLM baseURL 格式不正确: ' + e.message));
      }
      const lib = url.protocol === 'https:' ? https : http;
      const payload = JSON.stringify({
        model: this.config.model,
        messages: body.messages,
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens,
        stream
      });

      const req = lib.request(
        {
          method: 'POST',
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            ...(this.config.apiKey ? { Authorization: 'Bearer ' + this.config.apiKey } : {})
          }
        },
        (res) => {
          if (stream) {
            let buffer = '';
            res.setEncoding('utf-8');
            res.on('data', (chunk) => {
              buffer += chunk;
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';
              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data:')) continue;
                const data = trimmed.slice(5).trim();
                if (data === '[DONE]') continue;
                try {
                  const json = JSON.parse(data);
                  const delta = json.choices?.[0]?.delta?.content || '';
                  if (delta && onChunk) onChunk(delta);
                } catch (e) {
                  // ignore
                }
              }
            });
            res.on('end', () => resolve());
            res.on('error', reject);
          } else {
            let data = '';
            res.setEncoding('utf-8');
            res.on('data', (c) => (data += c));
            res.on('end', () => {
              try {
                const json = JSON.parse(data);
                if (res.statusCode >= 400) {
                  return reject(new Error(json.error?.message || `HTTP ${res.statusCode}`));
                }
                resolve(json);
              } catch (e) {
                reject(new Error('LLM 返回解析失败: ' + e.message + ' / raw=' + data.slice(0, 200)));
              }
            });
            res.on('error', reject);
          }
        }
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  async chat(messages, opts = {}) {
    const res = await this._request({ messages });
    return res.choices?.[0]?.message?.content || '';
  }

  async chatStream(messages, onChunk) {
    await this._request({ messages }, true, onChunk);
  }

  /**
   * 让 LLM 输出严格的 JSON（用于工具调用与规划）
   * 兼容不支持 response_format 的服务
   */
  async chatJSON(messages) {
    const text = await this.chat(messages);
    return this._extractJSON(text);
  }

  _extractJSON(text) {
    if (!text) return null;
    // 尝试直接解析
    try {
      return JSON.parse(text);
    } catch (e) {}
    // 尝试抽取 ```json ... ``` 块
    const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) {
      try {
        return JSON.parse(m[1].trim());
      } catch (e) {}
    }
    // 尝试抽取首个 { ... } 块
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last > first) {
      try {
        return JSON.parse(text.slice(first, last + 1));
      } catch (e) {}
    }
    return null;
  }
}

module.exports = LLMClient;
