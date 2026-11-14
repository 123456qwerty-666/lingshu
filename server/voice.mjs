/**
 * 灵枢 AI 中枢 — 语音模块（ASR 语音识别 / TTS 语音合成）
 *
 * 两条链路：
 *   收：微信语音(34) → reader 取 WAV → ASR → 文字 → 交给模型
 *   发：模型回复 → TTS → 音频文件 → SendFileMsg
 *
 * 说明：微信「语音气泡」需要把 SILK 上传到微信 CDN 并构造 type=34 消息，
 * 当前底层 Hook 没有这个能力（源码里没有 voice/CDN 相关实现），
 * 所以这里把合成结果当成「音频文件」发出去 —— 对方能点开播放，
 * 但显示的是文件气泡而不是语音气泡。
 */
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { loadConfig, resolveApiKey, ROOT_DIR } from './config.mjs';
import { endpoint } from './ai.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 语音接口偶发连接超时（DNS 轮询/网络抖动），这里做一次轻量重试 */
async function fetchRetry(url, opts, { attempts = 2, timeoutMs = 120000, label = '语音接口' } = {}) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      const retryable = /timeout|timed out|fetch failed|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(msg);
      if (i < attempts - 1 && retryable) {
        await sleep(1200 * (i + 1));
        continue;
      }
      throw new Error(`${label}网络错误：${msg.slice(0, 100)}`);
    }
  }
  throw lastErr;
}

/** 内置音色表：按协议区分 */
export const VOICE_CATALOG = {
  deepseek: {
    protocol: 'deepseek',
    voices: [
      { id: 'stella', label: 'Stella · 女声（默认）' },
      { id: 'tide', label: 'Tide · 男声' },
    ],
    ttsPath: '/v1/tools/tts',
    asrPath: '/v1/tools/asr',
    note: 'DeepSeek 官方语音接口，音色固定两种，自动识别语种',
  },
  openai: {
    protocol: 'openai',
    voices: [
      { id: 'alloy', label: 'Alloy · 中性' },
      { id: 'echo', label: 'Echo · 男声' },
      { id: 'fable', label: 'Fable · 叙事' },
      { id: 'onyx', label: 'Onyx · 低沉男声' },
      { id: 'nova', label: 'Nova · 明亮女声' },
      { id: 'shimmer', label: 'Shimmer · 柔和女声' },
    ],
    ttsPath: '/v1/audio/speech',
    asrPath: '/v1/audio/transcriptions',
    note: 'OpenAI 兼容协议，多数中转/自建服务都用这个',
  },
};

/** OpenAI 兼容 / 自建服务统一按 openai 协议处理 */
export function protocolOf(preset) {
  return VOICE_CATALOG[preset] ? preset : 'openai';
}

// ── WAV 工具 ────────────────────────────────────────────────
/** 解析 WAV 头，返回 {durationSeconds, sampleRate, channels, bitsPerSample} */
export function wavInfo(buf) {
  try {
    if (buf.length < 44) return null;
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
    let offset = 12;
    let fmt = null;
    while (offset + 8 <= buf.length) {
      const id = buf.toString('ascii', offset, offset + 4);
      const size = buf.readUInt32LE(offset + 4);
      const body = offset + 8;
      if (id === 'fmt ' && body + 16 <= buf.length) {
        fmt = {
          channels: buf.readUInt16LE(body + 2),
          sampleRate: buf.readUInt32LE(body + 4),
          bitsPerSample: buf.readUInt16LE(body + 14),
        };
      }
      if (id === 'data') {
        const dataSize = Math.min(size, buf.length - body);
        const byteRate = fmt ? fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8) : 0;
        return {
          ...(fmt || {}),
          dataBytes: dataSize,
          durationSeconds: byteRate ? Number((dataSize / byteRate).toFixed(2)) : 0,
        };
      }
      offset = body + size + (size % 2);
    }
  } catch { /* ignore */ }
  return null;
}

/** 把 WAV 裁到指定秒数以内（按块重建，兼容带 LIST/fact 等额外块的文件） */
export function trimWav(buf, maxSeconds) {
  const info = wavInfo(buf);
  if (!info || !info.durationSeconds || info.durationSeconds <= maxSeconds) return { buf, info, trimmed: false };

  let fmt = null;
  let dataOff = -1;
  let dataLen = 0;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') fmt = buf.subarray(body, Math.min(body + size, buf.length));
    if (id === 'data') { dataOff = body; dataLen = Math.min(size, buf.length - body); break; }
    off = body + size + (size % 2);
  }
  if (!fmt || dataOff < 0) return { buf, info, trimmed: false };

  const byteRate = info.sampleRate * info.channels * (info.bitsPerSample / 8);
  if (!byteRate) return { buf, info, trimmed: false };
  const want = Math.min(dataLen, Math.floor(byteRate * maxSeconds));

  const head = Buffer.alloc(20 + fmt.length + 8);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(head.length - 8 + want, 4);
  head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(fmt.length, 16);
  fmt.copy(head, 20);
  const dOff = 20 + fmt.length;
  head.write('data', dOff, 'ascii');
  head.writeUInt32LE(want, dOff + 4);

  const out = Buffer.concat([head, buf.subarray(dataOff, dataOff + want)]);
  return { buf: out, info: wavInfo(out), trimmed: true };
}

// ── 配置 ────────────────────────────────────────────────────
export function voiceConfig(config, talker = null) {
  const v = config.voice || {};
  const chat = talker ? (config.chats?.[talker]?.voice || {}) : {};
  const asr = { ...(v.asr || {}), ...(chat.asr && typeof chat.asr === 'object' ? chat.asr : {}) };
  const tts = { ...(v.tts || {}), ...(chat.tts && typeof chat.tts === 'object' ? chat.tts : {}) };
  // 聊天级可能只覆盖音色（chat.voice 是字符串 id）
  if (typeof chat.voice === 'string' && chat.voice) tts.voice = chat.voice;
  return {
    enabled: v.enabled !== false,
    // 0 = 不限制。音频是按文件发的，不受微信语音 60 秒限制
    maxSeconds: Number(chat.maxSeconds ?? v.maxSeconds ?? 0),
    asrEnabled: chat.asrEnabled !== undefined ? chat.asrEnabled !== false : asr.enabled !== false,
    asr,
    tts,
    sendMode: chat.sendMode || v.sendMode || 'off',   // off | withText | onlyVoice | random
    randomRate: Number(chat.randomRate ?? v.randomRate ?? 0.35),
    asrConfigured: Boolean(asr.providerId),
    ttsConfigured: Boolean(tts.providerId),
  };
}

async function providerFor(id) {
  const cfg = await loadConfig();
  const p = cfg.ai.providers?.[id];
  if (!p) throw new Error(`未找到提供商: ${id}`);
  const apiKey = await resolveApiKey(id);
  if (!apiKey) throw new Error(`提供商 ${id} 没有可用的 API Key`);
  return { ...p, id, apiKey };
}

function pickModel(section, provider, kind) {
  if (section?.modelId) return section.modelId;
  const models = provider.models || [];
  const kw = kind === 'asr' ? /(asr|whisper|transcri|audio.*text)/i : /(tts|speech|audio)/i;
  return models.find(m => kw.test(m.id || ''))?.id || '';
}

// ── ASR：音频 → 文字 ────────────────────────────────────────
/**
 * @param {Buffer} wavBuffer
 * @returns {Promise<{text:string, durationMs?:number, provider:string, model:string}>}
 */
export async function transcribe(wavBuffer, { config = null, talker = null, providerId = null, modelId = null, onLog } = {}) {
  const cfg = config || await loadConfig();
  const vc = voiceConfig(cfg, talker);
  const pid = providerId || vc.asr.providerId;
  if (!pid) throw new Error('还没有配置语音识别模型（去「AI 配置 → 语音」里选一个）');
  const provider = await providerFor(pid);
  const protocol = protocolOf(vc.asr.protocol || provider.voiceProtocol);
  const model = modelId || pickModel(vc.asr, provider, 'asr');
  const preset = VOICE_CATALOG[protocol];

  const info = wavInfo(wavBuffer);
  if (info && info.durationSeconds > 120) {
    throw new Error(`语音太长（${info.durationSeconds.toFixed(0)}s），识别接口上限 120 秒`);
  }

  const form = new FormData();
  form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'voice.wav');
  if (model) form.append('model', model);
  if (protocol === 'openai') form.append('response_format', 'json');

  const url = endpoint(provider.baseUrl, preset.asrPath);
  onLog?.(`语音识别请求：${provider.id}/${model || '默认'} (${(wavBuffer.length / 1024).toFixed(0)}KB)`);

  const resp = await fetchRetry(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${provider.apiKey}` },
    body: form,
  }, { label: '语音识别' });
  const raw = await resp.text();
  if (!resp.ok) throw new Error(`语音识别失败 ${resp.status}：${raw.slice(0, 200)}`);

  let data;
  try { data = JSON.parse(raw); } catch { throw new Error(`语音识别返回非 JSON：${raw.slice(0, 160)}`); }

  const text = String(
    data.text ?? data.transcript ?? data.result ?? data.data?.text ?? data.choices?.[0]?.message?.content ?? '',
  ).trim();
  // 空白音频（太短/没人说话）不算错误，交给调用方决定怎么提示
  return { text, durationMs: data.duration_ms ?? data.durationMs ?? null, provider: provider.id, model };
}

// ── TTS：文字 → 音频 ────────────────────────────────────────
/**
 * @returns {Promise<{buffer:Buffer, format:string, ext:string, voice:string, provider:string, model:string}>}
 */
export async function synthesize(text, { config = null, talker = null, providerId = null, modelId = null, voice = null, onLog } = {}) {
  const cfg = config || await loadConfig();
  // 必须带上 talker，否则聊天级设置（音色/发送方式）永远不生效
  const vc = voiceConfig(cfg, talker);
  const pid = providerId || vc.tts.providerId;
  if (!pid) throw new Error('还没有配置语音合成模型（去「AI 配置 → 语音」里选一个）');
  const provider = await providerFor(pid);
  const protocol = protocolOf(vc.tts.protocol || provider.voiceProtocol);
  const preset = VOICE_CATALOG[protocol];
  const model = modelId || pickModel(vc.tts, provider, 'tts');
  const voiceId = voice || vc.tts.voice || preset.voices[0].id;

  const clean = String(text || '').replace(/```[\s\S]*?```/g, '（代码略）').trim();
  if (!clean) throw new Error('没有可合成的文本');

  const body = protocol === 'openai'
    ? { model: model || 'tts-1', input: clean, voice: voiceId, response_format: 'wav' }
    : { text: clean, voice: voiceId, format: 'wav' };

  const url = endpoint(provider.baseUrl, preset.ttsPath);
  onLog?.(`语音合成请求：${provider.id}/${model || '默认'} 音色=${voiceId} 字数=${clean.length}`);

  const resp = await fetchRetry(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, { label: '语音合成' });

  const type = resp.headers.get('content-type') || '';
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`语音合成失败 ${resp.status}：${t.slice(0, 200)}`);
  }
  if (/json/i.test(type)) {
    // 少数中转会返回 JSON 里带 base64 或 url
    const t = await resp.text();
    let d;
    try { d = JSON.parse(t); } catch { throw new Error(`语音合成返回异常：${t.slice(0, 160)}`); }
    const b64 = d.audio ?? d.data ?? d.b64_json;
    if (typeof b64 === 'string' && b64.length > 64) {
      const buf = Buffer.from(b64, 'base64');
      return { buffer: buf, format: 'wav', ext: 'wav', voice: voiceId, provider: provider.id, model };
    }
    throw new Error(`语音合成没有返回音频：${t.slice(0, 160)}`);
  }

  const buf = Buffer.from(await resp.arrayBuffer());
  if (!buf.length) throw new Error('语音合成返回空音频');
  return { buffer: buf, format: 'wav', ext: 'wav', voice: voiceId, provider: provider.id, model };
}

// ── 读微信语音（走 reader）─────────────────────────────────
/**
 * reader 的 /api/v1/voices/:id 需要 conversationKey 与 pluginId，
 * 且该 pluginId 必须在 WeChatAgent 的 config/plugins.json 里
 * 处于 enabled 且有 audio_read 权限（见 agent-bridge.mjs）。
 *
 * ⚠️ 它返回的不是裸音频，是 JSON 信封：
 *   { id, conversationKey, b64, sha256, mime, filename, sampleRate, durationSeconds }
 * 直接把这段 JSON 当 wav 交给 ASR，会报 "Unsupported audio format"。
 */
export async function fetchVoiceWav(reader, voiceId, conversationKey, pluginId, { format = 'wav' } = {}) {
  if (!reader) throw new Error('微信读取器未初始化');
  const qs = new URLSearchParams({ conversationKey, pluginId, format });
  const raw = await reader.fetchBinary(`/api/v1/voices/${encodeURIComponent(voiceId)}?${qs}`, { timeoutMs: 40000 });

  if (raw?.length && raw[0] === 0x7b) {          // '{' → JSON 信封
    let j = null;
    try { j = JSON.parse(raw.toString('utf8')); } catch { j = null; }
    if (j) {
      const b64 = j.b64 || j.audio || j.data;
      if (typeof b64 === 'string' && b64.length > 64) {
        return {
          buffer: Buffer.from(b64, 'base64'),
          mime: j.mime || 'audio/wav',
          durationSeconds: j.durationSeconds ?? null,
          sampleRate: j.sampleRate ?? null,
        };
      }
      throw new Error(j.error || '语音接口没有返回音频数据');
    }
  }
  if (!raw?.length) throw new Error('语音接口返回空数据');
  return { buffer: raw, mime: 'audio/wav', durationSeconds: null, sampleRate: null };
}

/** 把音频落到 data/media/pending-send，返回绝对路径 */
export function saveAudioFile(buffer, ext = 'wav', hint = 'reply') {
  const dir = path.join(ROOT_DIR, 'data', 'media', 'voice');
  fs.mkdirSync(dir, { recursive: true });
  const name = `${hint}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
  const fp = path.join(dir, name);
  fs.writeFileSync(fp, buffer);
  return fp;
}

/** 清理过期的合成音频（默认保留 1 小时） */
export function cleanupAudio(maxAgeMs = 3600000) {
  const dir = path.join(ROOT_DIR, 'data', 'media', 'voice');
  try {
    if (!fs.existsSync(dir)) return 0;
    const now = Date.now();
    let n = 0;
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      try {
        if (now - fs.statSync(fp).mtimeMs > maxAgeMs) { fs.rmSync(fp, { force: true }); n++; }
      } catch { /* ignore */ }
    }
    return n;
  } catch { return 0; }
}

/** 给用户看的语音能力说明 */
export function voiceCapabilityNote() {
  return [
    '收：微信语音 → 自动转文字交给模型（需要 reader 语音权限）',
    '发：模型回复 → 合成音频 → 以「音频文件」发送（微信语音气泡需底层组件支持，当前不支持）',
  ].join('\n');
}

export { sleep };
