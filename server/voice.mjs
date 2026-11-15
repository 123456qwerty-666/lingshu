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
  /**
   * 豆包语音（火山引擎）
   * - 合成：POST /api/v3/tts/unidirectional，返回逐行 JSON，音频是 base64 分片
   * - 音色：官方音色走 seed-tts-2.0，复刻音色（S_ 开头）必须走 seed-icl-2.0
   * - 复刻：v1 mega_tts/audio/upload 异步训练，需要应用有复刻额度
   */
  doubao: {
    protocol: 'doubao',
    voices: [],                       // 音色是动态的，来自 speakers 列表
    ttsPath: '/api/v3/tts/unidirectional',
    clonePath: '/api/v1/mega_tts/audio/upload',
    cloneStatusPath: '/api/v1/mega_tts/status',
    resourceTts: 'seed-tts-2.0',
    resourceIcl: 'seed-icl-2.0',
    timeoutMs: 180000,
    note: '豆包语音合成 2.0 + 声音复刻 2.0：支持情绪（happy/sad/angry 等）与强度、语速',
  },
};

/** 豆包支持的情绪（中文音色） */
export const DOUBAO_EMOTIONS = [
  { id: 'happy', label: '开心' },
  { id: 'sad', label: '悲伤' },
  { id: 'angry', label: '生气' },
  { id: 'surprised', label: '惊讶' },
  { id: 'fear', label: '害怕' },
  { id: 'hate', label: '厌恶' },
  { id: 'excited', label: '兴奋' },
  { id: 'coldness', label: '冷淡' },
  { id: 'neutral', label: '平静' },
];

/**
 * 豆包官方 2.0 音色（*_uranus_bigtts），来自官方音色列表。
 * 这些音色走 seed-tts-2.0 资源；能不能用取决于账号是否开通了对应音色。
 */
const OFFICIAL_PAIRS = [
  // 中文女声
  ['团子', 'zh_female_tuanzi_uranus_bigtts'],
  ['Vivi', 'zh_female_vv_uranus_bigtts'],
  ['小何', 'zh_female_xiaohe_uranus_bigtts'],
  ['魅力苏菲', 'zh_female_sophie_uranus_bigtts'],
  ['清新女声', 'zh_female_qingxinnvsheng_uranus_bigtts'],
  ['知性灿灿', 'zh_female_cancan_uranus_bigtts'],
  ['撒娇学妹', 'zh_female_sajiaoxuemei_uranus_bigtts'],
  ['甜美小源', 'zh_female_tianmeixiaoyuan_uranus_bigtts'],
  ['甜美桃子', 'zh_female_tianmeitaozi_uranus_bigtts'],
  ['爽快思思', 'zh_female_shuangkuaisisi_uranus_bigtts'],
  ['佩奇猪', 'zh_female_peiqi_uranus_bigtts'],
  ['邻家女孩', 'zh_female_linjianvhai_uranus_bigtts'],
  ['Tina老师', 'zh_female_yingyujiaoxue_uranus_bigtts'],
  ['暖阳女声', 'zh_female_kefunvsheng_uranus_bigtts'],
  ['儿童绘本', 'zh_female_xiaoxue_uranus_bigtts'],
  ['黑猫侦探社咪仔', 'zh_female_mizai_uranus_bigtts'],
  ['鸡汤女', 'zh_female_jitangnv_uranus_bigtts'],
  ['魅力女友', 'zh_female_meilinvyou_uranus_bigtts'],
  ['流畅女声', 'zh_female_liuchangnv_uranus_bigtts'],
  ['温柔妈妈', 'zh_female_wenroumama_uranus_bigtts'],
  ['TVB女声', 'zh_female_tvbnv_uranus_bigtts'],
  ['俏皮女声', 'zh_female_qiaopinv_uranus_bigtts'],
  ['直率英子', 'zh_female_zhishuaiyingzi_uranus_bigtts'],
  ['樱桃丸子', 'zh_female_yingtaowanzi_uranus_bigtts'],
  ['婆婆', 'zh_female_popo_uranus_bigtts'],
  ['高冷御姐', 'zh_female_gaolengyujie_uranus_bigtts'],
  ['温柔淑女', 'zh_female_wenroushunv_uranus_bigtts'],
  ['古风少御', 'zh_female_gufengshaoyu_uranus_bigtts'],
  ['萌丫头', 'zh_female_mengyatou_uranus_bigtts'],
  ['贴心女声', 'zh_female_tiexinnvsheng_uranus_bigtts'],
  ['鸡汤妹妹', 'zh_female_jitangmei_uranus_bigtts'],
  ['开朗姐姐', 'zh_female_kailangjiejie_uranus_bigtts'],
  ['林潇', 'zh_female_linxiao_uranus_bigtts'],
  ['玲玲姐姐', 'zh_female_lingling_uranus_bigtts'],
  ['春日部姐姐', 'zh_female_chunribu_uranus_bigtts'],
  ['谄媚女声', 'zh_female_chanmeinv_uranus_bigtts'],
  ['女雷神', 'zh_female_nvleishen_uranus_bigtts'],
  ['亲切女声', 'zh_female_qinqienv_uranus_bigtts'],
  ['文静毛毛', 'zh_female_wenjingmaomao_uranus_bigtts'],
  ['知性女声', 'zh_female_zhixingnv_uranus_bigtts'],
  ['清澈梓梓', 'zh_female_qingchezizi_uranus_bigtts'],
  ['甜美悦悦', 'zh_female_tianmeiyueyue_uranus_bigtts'],
  ['心灵鸡汤', 'zh_female_xinlingjitang_uranus_bigtts'],
  ['柔美女友', 'zh_female_roumeinvyou_uranus_bigtts'],
  ['温柔小雅', 'zh_female_wenrouxiaoya_uranus_bigtts'],
  ['武则天', 'zh_female_wuzetian_uranus_bigtts'],
  ['顾姐', 'zh_female_gujie_uranus_bigtts'],
  ['少儿故事', 'zh_female_shaoergushi_uranus_bigtts'],
  // 中文男声
  ['云舟', 'zh_male_m191_uranus_bigtts'],
  ['小天', 'zh_male_taocheng_uranus_bigtts'],
  ['刘飞', 'zh_male_liufei_uranus_bigtts'],
  ['少年梓辛', 'zh_male_shaonianzixin_uranus_bigtts'],
  ['猴哥', 'zh_male_sunwukong_uranus_bigtts'],
  ['大壹', 'zh_male_dayi_uranus_bigtts'],
  ['儒雅逸辰', 'zh_male_ruyayichen_uranus_bigtts'],
  ['解说小明', 'zh_male_jieshuoxiaoming_uranus_bigtts'],
  ['译制片男', 'zh_male_yizhipiannan_uranus_bigtts'],
  ['邻家男孩', 'zh_male_linjiananhai_uranus_bigtts'],
  ['四郎', 'zh_male_silang_uranus_bigtts'],
  ['儒雅青年', 'zh_male_ruyaqingnian_uranus_bigtts'],
  ['擎苍', 'zh_male_qingcang_uranus_bigtts'],
  ['熊二', 'zh_male_xionger_uranus_bigtts'],
  ['温暖阿虎', 'zh_male_wennuanahu_uranus_bigtts'],
  ['奶气萌娃', 'zh_male_naiqimengwa_uranus_bigtts'],
  ['傲娇霸总', 'zh_male_aojiaobazong_uranus_bigtts'],
  ['懒音绵宝', 'zh_male_lanyinmianbao_uranus_bigtts'],
  ['反卷青年', 'zh_male_fanjuanqingnian_uranus_bigtts'],
  ['活力小哥', 'zh_male_huolixiaoge_uranus_bigtts'],
  ['霸气青叔', 'zh_male_baqiqingshu_uranus_bigtts'],
  ['悬疑解说', 'zh_male_xuanyijieshuo_uranus_bigtts'],
  ['磁性解说男声', 'zh_male_cixingjieshuonan_uranus_bigtts'],
  ['亮嗓萌仔', 'zh_male_liangsangmengzai_uranus_bigtts'],
  ['高冷沉稳', 'zh_male_gaolengchenwen_uranus_bigtts'],
  ['深夜播客', 'zh_male_shenyeboke_uranus_bigtts'],
  ['鲁班七号', 'zh_male_lubanqihao_uranus_bigtts'],
  ['唐僧', 'zh_male_tangseng_uranus_bigtts'],
  ['庄周', 'zh_male_zhuangzhou_uranus_bigtts'],
  ['开朗弟弟', 'zh_male_kailangdidi_uranus_bigtts'],
  ['猪八戒', 'zh_male_zhubajie_uranus_bigtts'],
  ['快乐小东', 'zh_male_kuailexiaodong_uranus_bigtts'],
  ['开朗学长', 'zh_male_kailangxuezhang_uranus_bigtts'],
  ['悠悠君子', 'zh_male_youyoujunzi_uranus_bigtts'],
  ['清爽男大', 'zh_male_qingshuangnanda_uranus_bigtts'],
  ['渊博小叔', 'zh_male_yuanboxiaoshu_uranus_bigtts'],
  ['阳光青年', 'zh_male_yangguangqingnian_uranus_bigtts'],
  ['温柔小哥', 'zh_male_wenrouxiaoge_uranus_bigtts'],
  ['东方浩然', 'zh_male_dongfanghaoran_uranus_bigtts'],
  ['天才童声', 'zh_male_tiancaitongsheng_uranus_bigtts'],
  ['广告解说', 'zh_male_guanggaojieshuo_uranus_bigtts'],
  // 外语
  ['Tim（英）', 'en_male_tim_uranus_bigtts'],
  ['Dacey（英）', 'en_female_dacey_uranus_bigtts'],
  ['Stokie（英）', 'en_female_stokie_uranus_bigtts'],
];

export const DOUBAO_OFFICIAL_VOICES = OFFICIAL_PAIRS.map(([name, id]) => ({ id, name, kind: 'official' }));

/** 支持按名字或 ID 找到真实音色 ID（模型常直接说名字） */
export function resolveDoubaoVoice(nameOrId, extra = []) {
  const key = String(nameOrId || '').trim();
  if (!key) return '';
  if (/^(S_|zh_|en_|ja_|ko_|ICL_)/.test(key)) return key;
  const pool = [...DOUBAO_OFFICIAL_VOICES, ...extra];
  const hit = pool.find(v => v.name === key) || pool.find(v => v.name.includes(key) || key.includes(v.name));
  return hit ? hit.id : key;
}

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
  // 聊天级可能只覆盖音色（chat.voice 是字符串 id）；
  // 但如果这个聊天单独选了引擎（chat.tts.voice），以引擎的音色为准
  if (typeof chat.voice === 'string' && chat.voice && !chat.tts?.voice) tts.voice = chat.voice;
  return {
    enabled: v.enabled !== false,
    // 0 = 不限制。音频是按文件发的，不受微信语音 60 秒限制
    maxSeconds: Number(chat.maxSeconds ?? v.maxSeconds ?? 0),
    asrEnabled: chat.asrEnabled !== undefined ? chat.asrEnabled !== false : asr.enabled !== false,
    asr,
    tts,
    sendMode: chat.sendMode || v.sendMode || 'off',   // off | withText | onlyVoice | random
    randomRate: Number(chat.randomRate ?? v.randomRate ?? 0.35),
    // 豆包专用：情绪 / 情绪强度 / 语速
    emotion: chat.emotion ?? v.emotion ?? '',
    emotionScale: Number(chat.emotionScale ?? v.emotionScale ?? 4) || 4,
    speed: Number(chat.speed ?? v.speed ?? 1),
    asrConfigured: Boolean(asr.providerId),
    ttsConfigured: Boolean(tts.providerId),
  };
}

async function providerFor(id, { needKey = true } = {}) {
  const cfg = await loadConfig();
  const p = cfg.ai.providers?.[id];
  if (!p) throw new Error(`未找到提供商: ${id}`);
  let apiKey = '';
  if (needKey) {
    apiKey = await resolveApiKey(id);
    if (!apiKey) throw new Error(`提供商 ${id} 没有可用的 API Key`);
  }
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

// ── 情绪脚本：把「句子[情绪]」拆成多段，分别合成再拼接 ──
const EMOTION_ALIAS = {
  开心: 'happy', 高兴: 'happy', 快乐: 'happy',
  悲伤: 'sad', 难过: 'sad', 伤心: 'sad',
  生气: 'angry', 愤怒: 'angry', 恼火: 'angry',
  惊讶: 'surprised', 吃惊: 'surprised',
  害怕: 'fear', 恐惧: 'fear',
  厌恶: 'hate', 反感: 'hate',
  兴奋: 'excited', 激动: 'excited',
  冷淡: 'coldness', 冷漠: 'coldness',
  平静: 'neutral', 中性: 'neutral', 平淡: 'neutral',
};
for (const e of DOUBAO_EMOTIONS) EMOTION_ALIAS[e.id] = e.id;

/**
 * 解析「我饿了[伤心] 但是我有钱了[开心]」这种脚本。
 * 标签写在句子后面，作用于它前面那段文字；不认识的标签当普通文字保留。
 * @returns {{text:string, emotion:string}[]}
 */
export function parseEmotionScript(input) {
  const s = String(input || '');
  if (!s.trim()) return [];
  const re = /[\[【]\s*([^\]】]{1,10})\s*[\]】]/g;
  const out = [];
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const raw = m[1].trim();
    const emo = EMOTION_ALIAS[raw] || EMOTION_ALIAS[raw.toLowerCase()];
    if (!emo) continue;                     // 不是情绪标签，保留原文
    const piece = s.slice(last, m.index).trim();
    last = re.lastIndex;
    if (piece) out.push({ text: piece, emotion: emo });
    else if (out.length) out[out.length - 1].emotion = emo;   // 标签紧跟在上一段后
  }
  const tail = s.slice(last).trim();
  if (tail) out.push({ text: tail, emotion: '' });
  // 只有标点的碎片（比如句末的「。」）并回上一段，避免单独合成一段
  const merged = [];
  for (const seg of out) {
    const hasWord = /[\p{L}\p{N}]/u.test(seg.text);
    if (!hasWord && merged.length) merged[merged.length - 1].text += seg.text;
    else if (seg.text) merged.push(seg);
  }
  return merged.length ? merged : [{ text: s.trim(), emotion: '' }];
}

/** 去掉 MP3 的 ID3v2 头（拼接时只保留第一段的头） */
function stripId3(buf) {
  if (!buf?.length) return buf;
  if (buf.toString('ascii', 0, 3) === 'ID3' && buf.length > 10) {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    const start = 10 + size;
    if (start > 0 && start < buf.length) return buf.subarray(start);
  }
  return buf;
}

function concatAudio(parts) {
  if (parts.length === 1) return parts[0];
  return Buffer.concat([parts[0], ...parts.slice(1).map(stripId3)]);
}

/** 调一次豆包合成，返回音频 Buffer */
async function doubaoOnce({ provider, preset, speaker, text, emotion, scale, speed, onLog }) {
  const resource = String(speaker).startsWith('S_') ? preset.resourceIcl : preset.resourceTts;
  const reqParams = {
    text,
    speaker,
    audio_params: { format: 'mp3', sample_rate: 24000 },
  };
  if (emotion) { reqParams.emotion = emotion; reqParams.emotion_scale = scale || 4; }
  if (speed && speed !== 1) reqParams.speed_ratio = speed;

  const resp = await fetchRetry(endpoint(provider.baseUrl, preset.ttsPath), {
    method: 'POST',
    headers: {
      'X-Api-Key': provider.apiKey,
      'X-Api-Resource-Id': resource,
      'X-Api-Request-Id': crypto.randomUUID(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ req_params: reqParams }),
  }, { label: '豆包合成', timeoutMs: preset.timeoutMs || 180000 });

  const raw = await resp.text();
  if (!resp.ok) throw new Error(`豆包合成失败 ${resp.status}：${raw.slice(0, 200)}`);

  const chunks = [];
  let errMsg = '';
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let j = null;
    try { j = JSON.parse(line); } catch { continue; }
    if (j.data) chunks.push(Buffer.from(j.data, 'base64'));
    const code = Number(j.code);
    if (j.message && code && code !== 20000000) errMsg = j.message;
  }
  if (!chunks.length) throw new Error(`豆包没有返回音频${errMsg ? '：' + errMsg : ''}`);
  return Buffer.concat(chunks);
}

// ── TTS：文字 → 音频 ────────────────────────────────────────
/**
 * @returns {Promise<{buffer:Buffer, format:string, ext:string, voice:string, provider:string, model:string}>}
 */
export async function synthesize(text, {
  config = null, talker = null, providerId = null, modelId = null, voice = null,
  emotion = null, emotionScale = null, speed = null, onLog,
} = {}) {
  const cfg = config || await loadConfig();
  // 必须带上 talker，否则聊天级设置（音色/发送方式）永远不生效
  const vc = voiceConfig(cfg, talker);
  const pid = providerId || vc.tts.providerId;
  if (!pid) throw new Error('还没有配置语音合成模型（去「AI 配置 → 语音」里选一个）');
  const protocol = protocolOf(vc.tts.protocol || (cfg.ai.providers?.[pid]?.voiceProtocol));
  const provider = await providerFor(pid);
  const preset = VOICE_CATALOG[protocol];
  const model = modelId || pickModel(vc.tts, provider, 'tts');
  const voiceId = voice || vc.tts.voice || preset.voices[0].id;

  const clean = String(text || '').replace(/```[\s\S]*?```/g, '（代码略）').trim();
  if (!clean) throw new Error('没有可合成的文本');
  // ── 豆包：官方音色 / 复刻音色 + 逐句情绪 ──
  if (protocol === 'doubao') {
    const emoDefault = String(emotion ?? vc.emotion ?? '').trim();
    const scale = Number(emotionScale ?? vc.emotionScale ?? 4) || 4;
    const spd = Number(speed ?? vc.speed ?? 1) || 1;
    const speaker = resolveDoubaoVoice(voiceId, listCloned());

    // 脚本里带了 [情绪] 标签就逐段合成；否则整段一次合成
    const segments = parseEmotionScript(clean);
    const tagged = segments.filter(s => s.emotion).length;

    if (tagged >= 1 && segments.length >= 1) {
      onLog?.(`豆包分段合成：${segments.length} 段，情绪 ${segments.map(s => s.emotion || '-').join('/')}`);
      const parts = [];
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const buf = await doubaoOnce({
          provider, preset, speaker,
          text: seg.text,
          emotion: seg.emotion || emoDefault,
          scale, speed: spd, onLog,
        });
        parts.push(buf);
        if (i < segments.length - 1) await sleep(300);
      }
      const merged = concatAudio(parts);
      onLog?.(`豆包完成：${segments.length} 段拼接 ${(merged.length / 1024).toFixed(0)}KB`);
      return {
        buffer: merged, format: 'mp3', ext: 'mp3', voice: speaker,
        provider: provider.id, model: segments.map(s => s.emotion || '-').join(','),
      };
    }

    onLog?.(`豆包合成：音色=${speaker}${emoDefault ? ` 情绪=${emoDefault}(${scale})` : ''} 速度=${spd} 字数=${clean.length}`);
    const buf = await doubaoOnce({
      provider, preset, speaker, text: clean,
      emotion: emoDefault, scale, speed: spd, onLog,
    });
    onLog?.(`豆包完成：${(buf.length / 1024).toFixed(0)}KB`);
    return { buffer: buf, format: 'mp3', ext: 'mp3', voice: speaker, provider: provider.id, model: emoDefault || 'default' };
  }


  // ⚠️ DeepSeek 的音色字段叫 voice_id，不是 voice。
  // 传 voice 不会报错，但会被静默忽略 —— 结果永远是最默认的女声 stella。
  // 只有 stella / tide 两个值，其它值会直接 400。
  const voiceForApi = protocol === 'deepseek'
    ? (['stella', 'tide'].includes(voiceId) ? voiceId : 'stella')
    : voiceId;

  const body = protocol === 'openai'
    ? { model: model || 'tts-1', input: clean, voice: voiceForApi, response_format: 'wav' }
    : { text: clean, voice_id: voiceForApi, format: 'wav' };

  const url = endpoint(provider.baseUrl, preset.ttsPath);
  onLog?.(`语音合成请求：${provider.id}/${model || '默认'} 音色=${voiceId} 字数=${clean.length}`);

  const resp = await fetchRetry(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, { label: '语音合成', timeoutMs: preset.timeoutMs || 120000 });

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
      return { buffer: buf, format: 'wav', ext: 'wav', voice: voiceForApi, provider: provider.id, model };
    }
    throw new Error(`语音合成没有返回音频：${t.slice(0, 160)}`);
  }

  const buf = Buffer.from(await resp.arrayBuffer());
  if (!buf.length) throw new Error('语音合成返回空音频');
  return { buffer: buf, format: 'wav', ext: 'wav', voice: voiceForApi, provider: provider.id, model };
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

// ── 豆包专用：音色库 / 复刻 ────────────────────────────────
const SPEAKERS_FILE = path.join(ROOT_DIR, 'data', 'voice-speakers.json');

/** 默认音色：用户已有的复刻音色 */
const DEFAULT_SPEAKERS = [
  { id: 'S_kDqSH3h12', name: '威龙', kind: 'clone', createdAt: 0 },
];

export function listCloned() {
  try {
    if (!fs.existsSync(SPEAKERS_FILE)) return DEFAULT_SPEAKERS.slice();
    const d = JSON.parse(fs.readFileSync(SPEAKERS_FILE, 'utf8').replace(/^\uFEFF/, ''));
    const list = Array.isArray(d?.speakers) ? d.speakers : [];
    // 保证默认音色始终在列表里
    for (const s of DEFAULT_SPEAKERS) if (!list.some(x => x.id === s.id)) list.unshift({ ...s });
    return list;
  } catch {
    return DEFAULT_SPEAKERS.slice();
  }
}

/** 分组返回：官方音色 + 自己复刻的 */
export function listSpeakers() {
  const cloned = listCloned();
  return {
    official: DOUBAO_OFFICIAL_VOICES,
    cloned,
    all: [...DOUBAO_OFFICIAL_VOICES, ...cloned],
  };
}

function saveSpeakers(list) {
  fs.mkdirSync(path.dirname(SPEAKERS_FILE), { recursive: true });
  const tmp = `${SPEAKERS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ speakers: list }, null, 2), 'utf8');
  fs.renameSync(tmp, SPEAKERS_FILE);
}

export function addSpeaker({ id, name, kind = 'clone' }) {
  const sid = String(id || '').trim();
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(sid)) throw new Error('音色 ID 格式不对（应形如 S_xxxxx）');
  const list = listCloned();
  const nm = String(name || '').trim() || sid;
  const exist = list.find(s => s.id === sid);
  if (exist) { exist.name = nm; saveSpeakers(list); return exist; }
  const item = { id: sid, name: nm, kind, createdAt: Date.now() };
  list.push(item);
  saveSpeakers(list);
  return item;
}

export function removeSpeaker(id) {
  const sid = String(id || '').trim();
  if (DEFAULT_SPEAKERS.some(s => s.id === sid)) throw new Error('内置音色不能删除');
  if (DOUBAO_OFFICIAL_VOICES.some(s => s.id === sid)) throw new Error('官方音色不需要维护，直接选就行');
  const list = listCloned().filter(s => s.id !== sid);
  saveSpeakers(list);
  return { ok: true };
}

async function doubaoProvider(config, providerId) {
  const cfg = config || await loadConfig();
  const vc = voiceConfig(cfg);
  const pid = providerId || vc.tts.providerId;
  if (!pid) throw new Error('还没有选择豆包提供商');
  const p = cfg.ai.providers?.[pid];
  if (!p) throw new Error(`未找到提供商: ${pid}`);
  const apiKey = await resolveApiKey(pid);
  if (!apiKey) throw new Error('豆包提供商没有配置 API Key');
  return { id: pid, baseUrl: p.baseUrl, apiKey, preset: VOICE_CATALOG.doubao };
}

/** 查询某个复刻音色的训练状态 */
export async function doubaoCloneStatus(speakerId, { providerId = null, config = null } = {}) {
  const { baseUrl, apiKey, preset } = await doubaoProvider(config, providerId);
  const r = await fetchRetry(endpoint(baseUrl, preset.cloneStatusPath), {
    method: 'POST',
    headers: {
      'X-Api-Key': apiKey,
      'Resource-Id': preset.resourceIcl,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ speaker_id: speakerId }),
  }, { label: '豆包复刻查询', timeoutMs: 30000, attempts: 1 });
  const t = await r.text();
  if (!r.ok) throw new Error(`查询失败 ${r.status}：${t.slice(0, 200)}`);
  try { return JSON.parse(t); } catch { return {}; }
}

/**
 * 上传参考音频做声音复刻，成功后自动加进音色库
 * @param {Buffer} audio
 */
export async function cloneDoubaoVoice({
  name, text, audio, filename = 'ref.wav', providerId = null, config = null, onLog,
}) {
  if (!name) throw new Error('给音色起个名字');
  if (!text || !String(text).trim()) throw new Error('要填参考音频里说的原话（一字不差）');
  if (!audio?.length) throw new Error('请上传参考音频（建议 5 秒以上干净人声）');

  const { baseUrl, apiKey, preset } = await doubaoProvider(config, providerId);
  const ext = (String(filename).split('.').pop() || 'wav').toLowerCase();
  const audioFormat = ['wav', 'mp3', 'm4a', 'ogg'].includes(ext) ? ext : 'wav';
  const speakerId = `S_${crypto.randomBytes(6).toString('hex')}`;

  onLog?.(`上传复刻音频：${name} → ${speakerId}（${(audio.length / 1024).toFixed(0)}KB）`);
  const r = await fetchRetry(endpoint(baseUrl, preset.clonePath), {
    method: 'POST',
    headers: {
      'X-Api-Key': apiKey,
      'Resource-Id': preset.resourceIcl,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      speaker_id: speakerId,
      audios: [{ audio_bytes: audio.toString('base64'), text: String(text).trim(), audio_format: audioFormat }],
      source: 2,
      model_type: 4,          // 声音复刻 2.0
    }),
  }, { label: '豆包复刻', timeoutMs: preset.timeoutMs, attempts: 1 });

  const raw = await r.text();
  let d = {};
  try { d = JSON.parse(raw); } catch { /* ignore */ }

  if (!r.ok || (d.BaseResp && Number(d.BaseResp.StatusCode) !== 0 && !d.speaker_id)) {
    const msg = d.BaseResp?.StatusMessage || d.message || raw.slice(0, 200);
    if (/license not found/i.test(msg)) {
      throw new Error('当前 API Key 所属应用没有「声音复刻」训练额度：需要到火山引擎控制台开通/购买声音复刻 2.0 的音色槽位后再试');
    }
    throw new Error(`复刻失败 ${r.status}：${msg}`);
  }

  // 训练是异步的，轮询到完成（最多约 2 分钟）
  let status = null;
  for (let i = 0; i < 12; i++) {
    await sleep(10000);
    try {
      status = await doubaoCloneStatus(speakerId, { providerId, config });
      const st = Number(status.status ?? status.Status ?? status.train_status ?? -1);
      onLog?.(`复刻状态：${st}${i === 0 ? '（训练中，通常 1~2 分钟）' : ''}`);
      if (st === 2) break;                 // 2 = 训练成功
      if (st === 3) throw new Error('复刻训练失败：音频质量或文本不匹配，换一段干净人声重试');
    } catch (e) {
      if (/复刻训练失败/.test(e.message)) throw e;
      onLog?.(`查询状态失败（继续等）：${e.message}`, 'warn');
    }
  }

  const item = addSpeaker({ id: speakerId, name, kind: 'clone' });
  return { ok: true, speakerId, name: item.name, status };
}

export { sleep };
