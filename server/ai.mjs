/**
 * 灵枢 AI 中枢 — AI 客户端（OpenAI 兼容协议）
 *
 * 关键能力：
 * - 多提供商自动降级：主提供商 429/402/5xx/网络错误时，自动换下一个可用提供商
 * - 记住上次成功的提供商，避免每次都先撞一次限流
 * - 图片：内部 image_ref 会转成 data URI；不支持图片的模型退化成文字提示
 */
import { loadConfig, resolveApiKey, getConfigSync } from './config.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 拼出 OpenAI 兼容端点，兼容 baseUrl 已带 /v1 的情况 */
export function endpoint(baseUrl, suffix) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const path = suffix.startsWith('/') ? suffix : `/${suffix}`;
  if (/\/v1$/i.test(base) && path.startsWith('/v1/')) return base + path.slice(3);
  return base + path;
}

/** 这些错误值得换一个提供商再试 */
export function isRetryableError(err) {
  const m = String(err?.message || err || '');
  if (/\b(429|402|403|500|502|503|504)\b/.test(m)) return true;
  return /rate limit|quota|insufficient|余额|额度|overload|timeout|timed out|ECONNRESET|ECONNREFUSED|ENOTFOUND|fetch failed|socket hang up/i.test(m);
}

/** 把技术错误翻译成给用户看的话 */
export function friendlyAIError(err, { tried = [] } = {}) {
  const m = String(err?.message || err || '');
  if (/rate limit|quota|429|额度|insufficient/i.test(m)) {
    return tried.length > 1
      ? '我这边几个模型的额度都用满了（限流），过几分钟再叫我吧～'
      : '我这边模型额度被限流了，过几分钟再叫我吧～';
  }
  if (/401|403|unauthorized|invalid api key/i.test(m)) return '模型的 API Key 好像失效了，去「AI 配置」里检查一下～';
  if (/timeout|timed out|ETIMEDOUT/i.test(m)) return '模型响应太慢了，我这边等超时了，再说一次试试？';
  if (/ECONNREFUSED|ENOTFOUND|fetch failed|socket hang up/i.test(m)) return '我连不上模型服务，检查一下网络或中转地址～';
  return `我这边处理出错了：${m.slice(0, 80)}`;
}

export class AIClient {
  constructor() {
    this._lastGood = null;   // 上次成功的 providerId
  }

  async getProvider(providerId) {
    const config = await loadConfig();
    const id = providerId || config.ai.defaultProvider;
    const provider = config.ai.providers[id];
    if (!provider) throw new Error(`未找到提供商: ${id}`);
    const apiKey = await resolveApiKey(id);
    if (!apiKey) throw new Error(`提供商 ${id} 未配置 API Key`);
    return { id, ...provider, apiKey };
  }

  /** 该提供商可用的对话模型（跳过纯画图模型） */
  chatModelOf(provider) {
    const models = provider.models || [];
    const text = models.filter(m => !m.imageGen && !/image|dall-e|flux/i.test(m.id || ''));
    return text[0]?.id || models[0]?.id || 'gpt-3.5-turbo';
  }

  /**
   * 组装尝试顺序：上次成功的 → 指定的 → 配置的降级列表 → 其它有 key 的
   */
  async buildChain(preferredId, preferredModel, onLog) {
    const cfg = await loadConfig();
    const ordered = [];
    const push = (id) => { if (id && !ordered.includes(id)) ordered.push(id); };

    if (!preferredId) push(this._lastGood);
    push(preferredId || cfg.ai.defaultProvider);
    for (const id of cfg.ai.fallbackProviders || []) push(id);
    if (this._lastGood) push(this._lastGood);
    for (const id of Object.keys(cfg.ai.providers || {})) push(id);

    const chain = [];
    for (const id of ordered) {
      try {
        const p = await this.getProvider(id);
        const isPrimary = id === (preferredId || cfg.ai.defaultProvider);
        const model = (isPrimary && (preferredModel || cfg.ai.defaultModel)) || this.chatModelOf(p);
        chain.push({ ...p, model });
      } catch (e) {
        onLog?.(`提供商 ${id} 跳过：${e.message}`, 'debug');
      }
    }
    if (!chain.length) throw new Error('没有可用的 AI 提供商（检查 API Key）');
    return chain;
  }

  async request(provider, path, body, timeoutMs = 180000) {
    const url = endpoint(provider.baseUrl, path);
    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new Error(`网络错误(${provider.id}): ${e.message}`);
    }
    const text = await resp.text();
    if (!resp.ok) throw new Error(`AI ${resp.status}(${provider.id}): ${text.slice(0, 300)}`);
    try { return JSON.parse(text); } catch { throw new Error(`AI 返回非 JSON(${provider.id}): ${text.slice(0, 200)}`); }
  }

  /** 带降级的单次请求 */
  async requestWithFallback(chain, path, buildBody, { timeoutMs = 180000, onLog } = {}) {
    let lastErr = null;
    const tried = [];
    for (let i = 0; i < chain.length; i++) {
      const provider = chain[i];
      tried.push(provider.id);
      try {
        const data = await this.request(provider, path, buildBody(provider), timeoutMs);
        this._lastGood = provider.id;
        data._provider = provider.id;
        data._model = provider.model;
        if (i > 0) onLog?.(`已自动切换到 ${provider.id}/${provider.model}（前面 ${tried.slice(0, -1).join('、')} 不可用）`, 'warn');
        return data;
      } catch (e) {
        lastErr = e;
        const more = i < chain.length - 1;
        if (more && isRetryableError(e)) {
          onLog?.(`${provider.id} 不可用（${e.message.slice(0, 60)}），尝试下一个…`, 'warn');
          continue;
        }
        throw e;
      }
    }
    throw lastErr || new Error('所有提供商均调用失败');
  }

  /** 纯文本对话 */
  async chat(messages, options = {}) {
    const chain = await this.buildChain(options.providerId, options.modelOverride || options.model, options.onLog);
    const data = await this.requestWithFallback(chain, '/v1/chat/completions', (p) => ({
      model: p.model,
      messages: normalizeMessages(messages),
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 2000,
      stream: false,
    }), { onLog: options.onLog });

    const choice = data.choices?.[0];
    if (!choice) throw new Error('AI 返回为空');
    return {
      content: choice.message?.content || '',
      role: choice.message?.role || 'assistant',
      finishReason: choice.finish_reason,
      usage: data.usage,
      provider: data._provider,
      model: data._model,
    };
  }

  /** 支持工具调用的对话（返回原始响应） */
  async chatWithTools(messages, tools, options = {}) {
    const chain = options._chain || await this.buildChain(options.providerId, options.modelOverride || options.model, options.onLog);
    const body = (p) => {
      const b = {
        model: p.model,
        messages: normalizeMessages(messages),
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? 2000,
        stream: false,
      };
      if (tools?.length) {
        b.tools = tools.map(t => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description || '',
            parameters: t.parameters || { type: 'object', properties: {} },
          },
        }));
        b.tool_choice = 'auto';
      }
      return b;
    };
    return this.requestWithFallback(chain, '/v1/chat/completions', body, { onLog: options.onLog });
  }

  /**
   * 工具循环：自动执行 tool_calls，最多 maxRounds 轮
   * 整个循环复用同一条 chain，避免每轮都重新撞限流
   */
  async runToolLoop(messages, tools, options = {}) {
    const maxRounds = options.maxRounds ?? 4;
    const callTool = options.callTool;
    const chain = await this.buildChain(options.providerId, options.modelOverride || options.model, options.onLog);
    const transcript = [...messages];
    const toolRuns = [];
    let content = '';
    let providerUsed = '';

    for (let round = 0; round < maxRounds; round++) {
      const resp = await this.chatWithTools(transcript, tools, { ...options, _chain: chain });
      providerUsed = resp._provider || providerUsed;
      const choice = resp.choices?.[0];
      if (!choice) break;
      content = choice.message?.content || content;
      const toolCalls = choice.message?.tool_calls || [];
      if (!toolCalls.length || !callTool) break;

      transcript.push({
        role: 'assistant',
        content: choice.message?.content || '',
        tool_calls: toolCalls,
      });

      for (const tc of toolCalls) {
        const name = tc.function?.name;
        let args = {};
        try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { args = {}; }
        let result;
        const started = Date.now();
        try {
          result = await callTool(name, args);
        } catch (e) {
          result = { success: false, error: e.message };
        }
        toolRuns.push({ name, args, result, ms: Date.now() - started });
        transcript.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(result)?.slice(0, 8000) || '{}',
        });
      }
    }

    // 轮次用尽但模型还在调工具 → 强制它基于已有结果直接回答（关掉工具，避免死循环）
    if (!content.trim() && toolRuns.length) {
      try {
        const resp = await this.chatWithTools([
          ...transcript,
          { role: 'user', content: '（系统提示）资料已经够了，请不要再调用工具，直接用上面的结果回答对方的问题。' },
        ], [], { ...options, _chain: chain });
        const c = resp.choices?.[0]?.message?.content || '';
        if (c.trim()) {
          content = c;
          providerUsed = resp._provider || providerUsed;
          options.onLog?.('工具轮次用尽，已强制模型直接作答', 'debug');
        }
      } catch (e) {
        options.onLog?.(`强制作答失败：${e.message}`, 'warn');
      }
    }

    return { content, toolRuns, provider: providerUsed };
  }

  /** 图片生成（自动挑带绘图模型的提供商） */
  async generateImage(prompt, options = {}) {
    const config = await loadConfig();
    let providerId = options.providerId;
    let model = options.model;

    const pickImageModel = (p) => (p.models || []).find(x => x.imageGen || /image/i.test(x.id))?.id;

    if (!providerId) {
      for (const [id, p] of Object.entries(config.ai.providers)) {
        const m = pickImageModel(p);
        if (m) { providerId = id; model = m; break; }
      }
    }
    if (!providerId) throw new Error('没有可用的绘图提供商，请先添加带图片模型的提供商');

    const provider = await this.getProvider(providerId);
    if (!model) model = pickImageModel(provider);
    if (!model) throw new Error(`提供商 ${providerId} 没有图片生成模型`);
    const body = {
      model,
      prompt,
      size: options.size || '1024x1024',
      n: 1,
      response_format: 'url',
    };

    // 免费额度常见 429，隔几秒重试通常就好了
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const data = await this.request(provider, '/v1/images/generations', body, 180000);
        const item = data.data?.[0];
        if (!item) throw new Error('图片接口返回为空');
        if (item.url) return { format: 'url', data: item.url, model, provider: provider.id };
        if (item.b64_json) return { format: 'base64', data: item.b64_json, model, provider: provider.id };
        throw new Error('无法识别的图片返回格式');
      } catch (e) {
        lastErr = e;
        if (isRetryableError(e) && attempt < 2) {
          const wait = 4000 * (attempt + 1);
          options.onLog?.(`绘图接口限流/异常（${e.message.slice(0, 50)}），${wait / 1000}s 后重试…`, 'warn');
          await sleep(wait);
          continue;
        }
        break;
      }
    }
    throw lastErr || new Error('图片生成失败');
  }

  async listModels(providerId) {
    const config = await loadConfig();
    const id = providerId || config.ai.defaultProvider;
    return config.ai.providers[id]?.models || [];
  }

  async listProviders() {
    const config = await loadConfig();
    const out = [];
    for (const [id, p] of Object.entries(config.ai.providers)) {
      out.push({
        id,
        name: p.name || id,
        baseUrl: p.baseUrl,
        hasKey: Boolean(p.apiKey || p.apiKeyEnv),
        models: p.models || [],
        isDefault: config.ai.defaultProvider === id,
        isFallback: (config.ai.fallbackProviders || []).includes(id),
      });
    }
    return out;
  }
}

let _cfgSnap = null;
/** 兼容旧接口：配置以 config.mjs 的内存对象为准 */
export function setConfigSnapshot(cfg) { _cfgSnap = cfg; }
function loadConfigCached() {
  try {
    const live = getConfigSync();
    if (live?.ai) return live;
  } catch { /* ignore */ }
  return _cfgSnap || { ai: { defaultProvider: '', defaultModel: '' } };
}

/**
 * 归一化消息：把内部 image_ref 转成 data URI；没有图的就退化为纯文本
 */
export function normalizeMessages(messages) {
  return messages.map(m => {
    if (!Array.isArray(m.content)) return m;
    const parts = [];
    for (const p of m.content) {
      if (p.type === 'text') parts.push({ type: 'text', text: p.text });
      else if (p.type === 'image_url') parts.push(p);
      else if (p.type === 'image_ref') {
        if (p.dataUrl) parts.push({ type: 'image_url', image_url: { url: p.dataUrl } });
        else parts.push({ type: 'text', text: '[图片，无法读取]' });
      }
    }
    if (!parts.length) parts.push({ type: 'text', text: '[空]' });
    if (parts.length === 1 && parts[0].type === 'text') return { ...m, content: parts[0].text };
    return { ...m, content: parts };
  });
}

export const ai = new AIClient();
export { sleep };
