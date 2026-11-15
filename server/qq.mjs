/**
 * 灵枢 AI 中枢 — QQ 通道（OneBot 11 / NapCatQQ）
 *
 * 方案：NapCatQQ 用「个人 QQ 小号」登录，向外提供 OneBot 11 接口。
 *   - 发消息：灵枢 → NapCat HTTP 服务端（send_private_msg / send_group_msg）
 *   - 收消息：NapCat 的「HTTP 客户端」把事件 POST 到 /api/qq/event
 *
 * 真实语音气泡：QQ 只认 SILK v3，所以 TTS 出来的 wav/mp3 要过一道
 *   ffmpeg（统一成 16k 单声道 s16le PCM）→ silk-wasm encode → .silk
 * 这两个依赖本机都已具备，不需要额外下载。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT_DIR } from './config.mjs';

const CACHE_DIR = path.join(ROOT_DIR, 'data', 'media', 'qq');
const SILK_WASM = 'C:/Users/666/Desktop/接入微信/WeChatAgent-install/data/workspace/packages/voice-codec/silk-wasm/lib/index.mjs';
const DEFAULT_FFMPEG = 'C:/Users/666/Desktop/AI/AstrBot/ffmpeg.exe';

function ensure() { fs.mkdirSync(CACHE_DIR, { recursive: true }); }

/** 调 NapCat 的 OneBot HTTP API */
export async function qqApi(action, params = {}, cfg) {
  if (!cfg?.httpUrl) throw new Error('还没有配置 NapCat 地址（QQ 设置里填 HTTP 服务端地址）');
  const url = `${String(cfg.httpUrl).replace(/\/+$/, '')}/${action}`;
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(20000),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`NapCat ${action} HTTP ${resp.status}：${text.slice(0, 160)}`);
  let d = {};
  try { d = JSON.parse(text); } catch { throw new Error(`NapCat 返回非 JSON：${text.slice(0, 160)}`); }
  if (d.retcode !== undefined && d.retcode !== 0) {
    throw new Error(`NapCat ${action} 失败 ${d.retcode}：${d.message || d.wording || ''}`);
  }
  return d.data ?? d;
}

/** 连接状态 / 登录账号 */
export async function qqLoginInfo(cfg) {
  return qqApi('get_login_info', {}, cfg);
}

export async function qqFriendList(cfg) {
  const r = await qqApi('get_friend_list', {}, cfg);
  return Array.isArray(r) ? r : [];
}

export async function qqGroupList(cfg) {
  const r = await qqApi('get_group_list', {}, cfg);
  return Array.isArray(r) ? r : [];
}

/** target: 'private:12345' | 'group:67890' */
export async function sendQQ(target, message, cfg) {
  const [kind, id] = String(target).split(':');
  const num = Number(id);
  if (!Number.isFinite(num)) throw new Error(`QQ 目标格式不对：${target}`);
  const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg';
  const key = kind === 'group' ? 'group_id' : 'user_id';
  return qqApi(action, { [key]: num, message }, cfg);
}

function b64File(buf) { return `base64://${Buffer.from(buf).toString('base64')}`; }

export function sendQQText(target, text, cfg) {
  return sendQQ(target, [{ type: 'text', data: { text } }], cfg);
}

export function sendQQImage(target, buf, cfg) {
  return sendQQ(target, [{ type: 'image', data: { file: b64File(buf) } }], cfg);
}

/** QQ 表情（系统表情 id） */
export function sendQQFace(target, id, cfg) {
  return sendQQ(target, [{ type: 'face', data: { id: String(id) } }], cfg);
}

/**
 * wav/mp3 → SILK v3（QQ 语音气泡专用）
 * @returns {Buffer} silk 字节
 */
export async function toSilk(audioBuffer, ext = 'wav', cfg = {}) {
  ensure();
  const ffmpeg = cfg.ffmpegPath || DEFAULT_FFMPEG;
  if (!fs.existsSync(ffmpeg)) throw new Error(`找不到 ffmpeg：${ffmpeg}`);
  const inPath = path.join(CACHE_DIR, `in-${Date.now()}.${ext}`);
  const pcmPath = path.join(CACHE_DIR, `pcm-${Date.now()}.pcm`);
  fs.writeFileSync(inPath, audioBuffer);
  try {
    const r = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', inPath,
      '-ar', '16000', '-ac', '1', '-f', 's16le', pcmPath], { encoding: 'utf8', timeout: 60000 });
    if (r.status !== 0 || !fs.existsSync(pcmPath)) {
      throw new Error(`ffmpeg 转 PCM 失败：${(r.stderr || '').slice(0, 160)}`);
    }
    const wasmPath = cfg.silkWasmPath || SILK_WASM;
    const mod = await import(pathToFileURL(wasmPath).href);
    if (typeof mod.encode !== 'function') throw new Error('silk-wasm 没有 encode 能力');
    const pcm = fs.readFileSync(pcmPath);
    const out = await mod.encode(new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2)), 16000);
    const silk = Buffer.from(out.data ?? out);
    if (!silk.length) throw new Error('SILK 编码结果为空');
    return silk;
  } finally {
    for (const f of [inPath, pcmPath]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
  }
}

/** 发真实 QQ 语音气泡（自动转 SILK） */
export async function sendQQRecord(target, audioBuffer, ext, cfg) {
  const silk = await toSilk(audioBuffer, ext, cfg);
  return sendQQ(target, [{ type: 'record', data: { file: b64File(silk) } }], cfg);
}

/** 把 OneBot 事件翻译成灵枢的消息形状 */
/** QQ 文字表情 id → 中文名（常见的一批，AI 看得懂才有意义） */
const QQ_FACE_NAMES = {
  0: '微笑', 1: '撇嘴', 2: '色', 3: '发呆', 4: '得意', 5: '流泪', 6: '害羞', 7: '闭嘴',
  8: '睡', 9: '大哭', 10: '尴尬', 11: '发怒', 12: '调皮', 13: '呲牙', 14: '惊讶',
  15: '难过', 16: '酷', 18: '囧', 19: '抓狂', 20: '吐', 21: '偷笑', 22: '可爱',
  23: '白眼', 24: '傲慢', 25: '饥饿', 26: '困', 27: '惊恐', 28: '流汗', 29: '憨笑',
  30: '悠闲', 31: '奋斗', 32: '咒骂', 33: '疑问', 34: '嘘', 35: '晕', 36: '折磨',
  37: '衰', 38: '骷髅', 39: '敲打', 41: '再见', 42: '发抖', 43: '爱情', 46: '猪头',
  49: '拥抱', 53: '蛋糕', 54: '闪电', 55: '炸弹', 56: '刀', 57: '足球', 59: '便便',
  60: '咖啡', 61: '饭', 63: '玫瑰', 64: '凋谢', 66: '爱心', 67: '心碎', 69: '礼物',
  74: '太阳', 75: '月亮', 76: '赞', 77: '踩', 78: '握手', 79: '胜利', 85: '飞吻',
  86: '怄火', 89: '西瓜', 96: '冷汗', 97: '擦汗', 98: '抠鼻', 99: '鼓掌', 100: '糗大了',
  101: '坏笑', 102: '左哼哼', 103: '右哼哼', 104: '哈欠', 105: '鄙视', 106: '委屈',
  107: '快哭了', 108: '阴险', 109: '亲亲', 110: '吓', 111: '可怜', 112: '菜刀',
  113: '啤酒', 114: '篮球', 115: '乒乓', 116: '示爱', 117: '瓢虫', 118: '抱拳',
  119: '勾引', 120: '拳头', 121: '差劲', 122: '爱你', 123: 'NO', 124: 'OK',
  125: '转圈', 126: '磕头', 127: '回头', 128: '跳绳', 129: '挥手', 130: '激动',
  131: '街舞', 132: '献吻', 133: '左太极', 134: '右太极', 178: '呃', 179: '好棒',
  180: '拜托', 181: '点赞', 182: '无聊', 183: '托脸', 184: '吃', 185: '送花',
  186: '害怕', 187: '花痴', 188: '小样的', 189: '汗', 190: '我们都是好孩子',
  191: '啊', 192: '做鬼脸', 193: '吐舌', 194: '抛媚眼', 197: '惊讶', 198: '打call',
  199: '变形', 200: '仔细分析', 201: '菜汪', 202: '崇拜', 203: '比心',
};

/** 把 face 段转成可读文字 */
function faceLabel(d = {}) {
  const id = Number(d.id);
  if (Number.isFinite(id) && QQ_FACE_NAMES[id]) return `[表情:${QQ_FACE_NAMES[id]}]`;
  if (d.text) return `[表情:${d.text}]`;
  return '[表情]';
}

export function normalizeOneBotEvent(e) {
  if (!e || e.post_type !== 'message') return null;
  const isGroup = e.message_type === 'group';
  const uid = String(e.user_id ?? '');
  const gid = e.group_id !== undefined ? String(e.group_id) : '';
  const target = isGroup ? `group:${gid}` : `private:${uid}`;
  const segs = Array.isArray(e.message) ? e.message : [];
  const parts = [];
  const media = [];
  let firstType = 1;

  for (const s of segs) {
    const t = s?.type;
    const d = s?.data || {};
    if (t === 'text') parts.push(String(d.text ?? ''));
    else if (t === 'image') {
      media.push({ type: 'image', url: d.url || '', file: d.file || '' });
      if (firstType === 1) firstType = 3;
    } else if (t === 'record') {
      media.push({ type: 'record', url: d.url || '', file: d.file || '' });
      if (firstType === 1) firstType = 34;
    } else if (t === 'face') {
      parts.push(faceLabel(d));
      if (firstType === 1) firstType = 47;
    } else if (t === 'at') parts.push(`@${d.qq ?? ''}`);
    else if (t === 'reply') { parts.push('[引用了一条消息]'); }
    else if (t === 'file') media.push({ type: 'file', url: d.url || '', file: d.file || '', name: d.file_name || '' });
    else if (t === 'video') media.push({ type: 'video', url: d.url || '' });
  }

  // 兜底：QQ 有些消息段（如小程序、红包、位置、转发）暂时解析不出文字，
  // 至少给 AI 一个可回应的占位，而不是让它收到一条空消息。
  let content = parts.join('').trim();
  if (!content && !media.length) content = '[对方发来一条消息，类型暂时识别不了]';

  return {
    event: 'message.new',
    platform: 'qq',
    sessionId: `qq:${target}`,
    sessionType: e.message_type || 'private',
    conversationId: gid || uid,
    senderName: e.sender?.nickname || e.sender?.card || uid,
    talkerId: uid,
    content,
    type: firstType,
    timestamp: Number(e.time) || Math.floor(Date.now() / 1000),
    rawid: `qq-${e.message_id ?? `${Date.now()}-${uid}`}`,
    qqTarget: target,
    qqMedia: media,
    qqSelf: false,
  };
}

/** 从 QQ 消息段里下载图片/语音，落到本地缓存供控制台显示 */
export async function cacheQQMedia(url, tag = 'media') {
  if (!url || !/^https?:\/\//i.test(url)) return '';
  ensure();
  const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!resp.ok) throw new Error(`下载失败 ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  // 扩展名优先按 Content-Type 判断（QQ 的图片 URL 常常没有后缀，存成 .bin 后对方识别不了）
  const MIME_EXT = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
    'image/bmp': 'bmp', 'audio/amr': 'amr', 'audio/mpeg': 'mp3',
    'audio/wav': 'wav', 'audio/x-wav': 'wav', 'video/mp4': 'mp4',
  };
  const mime = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  let ext = MIME_EXT[mime] || '';
  if (!ext) {
    try {
      const m = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i);
      if (m) ext = m[1].toLowerCase();
    } catch { /* ignore */ }
  }
  if (!ext) ext = 'bin';
  const name = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  fs.writeFileSync(path.join(CACHE_DIR, name), buf);
  return `qq/${name}`;
}

/**
 * QQ 主动消息引擎
 *
 * 支持：时间段内随机发 + 隔一阵发一小串
 *   windows      [{ start:'09:00', end:'12:00', days:[1..7] }]  空 = 全天
 *   intervalMin/Max   两次「发一会儿」之间的随机间隔（分钟）
 *   burstMin/Max      每次「发一会儿」发几条
 *   gapMin/Max        这一串里每两条之间的随机间隔（秒）
 */
export function createProactiveEngine({ cfgProvider, sender, aiLine, log, now = () => Date.now() }) {
  let timer = null;
  let running = false;
  const lastActive = new Map();   // 对方最后一次互动
  const state = new Map();        // target -> { lastBurst, dayKey, count }

  const mark = (target) => { if (target) lastActive.set(target, now()); };

  const dayKey = () => new Date(now()).toDateString();
  // 每日计数落盘，避免重启后重新数一遍导致超发
  const COUNT_FILE = path.join(CACHE_DIR, "..", "qq-proactive-count.json");
  const readCounts = () => {
    try { return JSON.parse(fs.readFileSync(COUNT_FILE, "utf8")) || {}; } catch { return {}; }
  };
  const writeCounts = (obj) => {
    try { fs.mkdirSync(path.dirname(COUNT_FILE), { recursive: true }); fs.writeFileSync(COUNT_FILE, JSON.stringify(obj), "utf8"); } catch { /* ignore */ }
  };
  const st = (target) => {
    const k = dayKey();
    let s = state.get(target);
    if (!s || s.dayKey !== k) {
      const saved = readCounts();
      const rec = saved[k] && saved[k][target];
      s = { lastBurst: 0, dayKey: k, count: Number(rec) || 0, nextAt: 0 };
      state.set(target, s);
    }
    return s;
  };
  const bumpCount = (target) => {
    const s = st(target);
    s.count += 1;
    const saved = readCounts();
    saved[s.dayKey] = saved[s.dayKey] || {};
    saved[s.dayKey][target] = s.count;
    // 只保留最近两天的数据
    const keys = Object.keys(saved).sort().slice(-2);
    const trimmed = {};
    for (const key of keys) trimmed[key] = saved[key];
    writeCounts(trimmed);
  };

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const randInt = (a, b) => {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    return Math.floor(lo + Math.random() * (hi - lo + 1));
  };

  const parseHM = (s) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
    if (!m) return null;
    const h = Number(m[1]), mi = Number(m[2]);
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  };

  /** 当前是否落在某个时间窗口（支持 22:00-02:00 这种跨午夜） */
  function inWindows(d = new Date(now()), windows = null) {
    if (!Array.isArray(windows) || !windows.length) return true;   // 没配 = 全天
    const mins = d.getHours() * 60 + d.getMinutes();
    const dow = d.getDay() === 0 ? 7 : d.getDay();
    for (const w of windows) {
      const s = parseHM(w.start), e = parseHM(w.end);
      if (s === null || e === null) continue;
      if (Array.isArray(w.days) && w.days.length && !w.days.includes(dow)) continue;
      if (s === e) return true;                                     // 起止相同 = 全天
      if (s < e) { if (mins >= s && mins < e) return true; }
      else { if (mins >= s || mins < e) return true; }               // 跨午夜
    }
    return false;
  }

  function inQuiet(p, d = new Date(now())) {
    const [qf, qt] = p.quietHours || [23, 8];
    const h = d.getHours();
    return qf > qt ? (h >= qf || h < qt) : (h >= qf && h < qt);
  }

  async function makeLine(p, target = null) {
    if (p.aiGenerated !== false && typeof aiLine === 'function') {
      // 最多试两次：模型偶尔会蹦出「哎」这种一个字，太敷衍
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const t = String((await aiLine(target)) || '').trim().replace(/^["'「『]|["'」』]$/g, '');
          if (t.length >= 5) return t.slice(0, 200);
          log?.(`主动消息：AI 结果太短（${t.length} 字），${attempt === 0 ? '重试' : '改用预设'}`, 'debug');
        } catch (e) {
          log?.(`主动消息 AI 生成失败，改用预设：${e.message}`, 'warn');
          break;
        }
      }
    }
    const pool = (p.lines || []).filter(Boolean);
    const pick = pool.length ? pool[Math.floor(Math.random() * pool.length)] : '在吗？好久没聊了～';
    return pick;
  }

  async function tick() {
    if (running) return;          // 防止上一轮还没发完就重叠
    running = true;
    try {
      const cfg = await cfgProvider();
      const p = cfg?.qq?.proactive;
      if (!cfg?.qq?.enabled || !p?.enabled) return;
      if (inQuiet(p)) return;
      if (!inWindows(new Date(now()), p.windows)) return;

      const targets = (p.targets || []).filter(Boolean);
      const idleMs = (p.idleMinutes ?? 120) * 60000;
      const iMin = p.intervalMin ?? 20, iMax = p.intervalMax ?? 60;
      const bMin = p.burstMin ?? 1, bMax = p.burstMax ?? 3;
      const gMin = p.gapMin ?? 3, gMax = p.gapMax ?? 12;

      for (const target of targets) {
        const s = st(target);
        if (s.count >= (p.maxPerDay ?? 3)) continue;

        // 没有互动记录时，从「第一次见到它」开始计时，而不是当成很久没聊过
        if (!lastActive.has(target)) lastActive.set(target, now());
        // 对方刚说过话就别打扰（严格等满 idleMinutes）
        if (now() - (lastActive.get(target) || 0) < idleMs) continue;

        // 下次发送时间「只随机一次」并固定下来。
        // 旧写法每次 tick 都重新随机，等于总在等最小值，所以几分钟就发一条。
        if (!s.nextAt) { s.nextAt = now() + randInt(iMin, iMax) * 60000; continue; }
        if (now() < s.nextAt) continue;

        const burst = Math.min(randInt(bMin, bMax), (p.maxPerDay ?? 3) - s.count);
        if (burst <= 0) continue;

        log?.(`QQ 主动消息：${target} 开始发 ${burst} 条`);
        for (let i = 0; i < burst; i++) {
          try {
            const line = await makeLine(p, target);
            await sender(target, line);
            bumpCount(target);
            log?.(`QQ 主动消息 → ${target}（今日 ${s.count}/${p.maxPerDay ?? 3}）：${line.slice(0, 30)}`);
          } catch (e) {
            log?.(`QQ 主动消息失败 ${target}: ${e.message}`, 'warn');
            break;
          }
          if (i < burst - 1) await sleep(randInt(gMin, gMax) * 1000);
        }
        s.lastBurst = now();
        s.nextAt = now() + randInt(iMin, iMax) * 60000;   // 安排下一次
      }
    } finally {
      running = false;
    }
  }

  return {
    mark,
    tick,                       // 暴露出来，方便手动触发测试
    inWindows,
    start(intervalMs = 60000) {
      if (timer) return;
      timer = setInterval(() => tick().catch(e => log?.(`主动消息异常: ${e.message}`, 'warn')), intervalMs);
      timer.unref?.();
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
  };
}
/** PCM(16bit) → WAV，给 ASR 用 */
function pcmToWav(pcm, sampleRate = 16000, channels = 1, bits = 16) {
  const byteRate = (sampleRate * channels * bits) / 8;
  const blockAlign = (channels * bits) / 8;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22); h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(byteRate, 28); h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bits, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/**
 * QQ 语音（silk / amr / mp3 / wav）统一转成 16k 单声道 wav
 * 返回 { wav, format }
 */
export async function qqVoiceToWav(audioBuffer, cfg = {}) {
  if (!audioBuffer?.length) throw new Error('语音内容为空');
  const head = audioBuffer.subarray(0, 10).toString('latin1');
  const isSilk = head.startsWith('#!SILK') || head.startsWith('\x02#!SILK');
  const wasmPath = cfg.silkWasmPath || SILK_WASM;

  if (isSilk) {
    const mod = await import(pathToFileURL(wasmPath).href);
    if (typeof mod.decode !== 'function') throw new Error('silk-wasm 没有 decode 能力');
    const out = await mod.decode(audioBuffer, 16000);
    const raw = out?.data ?? out;
    const pcm = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer ?? raw, raw.byteOffset ?? 0, raw.byteLength ?? raw.length);
    if (!pcm.length) throw new Error('SILK 解码结果为空');
    return { wav: pcmToWav(pcm), format: 'silk' };
  }

  // 其他格式交给 ffmpeg 转 wav
  const ffmpeg = cfg.ffmpegPath || DEFAULT_FFMPEG;
  if (!fs.existsSync(ffmpeg)) throw new Error(`找不到 ffmpeg：${ffmpeg}`);
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const inPath = path.join(CACHE_DIR, `vin-${stamp}.bin`);
  const outPath = path.join(CACHE_DIR, `vin-${stamp}.wav`);
  fs.writeFileSync(inPath, audioBuffer);
  try {
    const r = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', inPath,
      '-ar', '16000', '-ac', '1', '-f', 'wav', outPath], { encoding: 'utf8', timeout: 60000 });
    if (r.status !== 0 || !fs.existsSync(outPath)) {
      throw new Error(`音频转换失败（可能是 QQ 的 silk 或 amr 格式）：${(r.stderr || '').slice(0, 140)}`);
    }
    return { wav: fs.readFileSync(outPath), format: 'converted' };
  } finally {
    for (const f of [inPath, outPath]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
  }
}

/** 下载 QQ 语音并转文字（失败返回空串，不抛） */
export async function qqVoiceToText(url, { cfg = {}, talker = null, transcribe = null, log = null } = {}) {
  if (!url) return { text: '', reason: '没有语音地址' };
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!resp.ok) throw new Error(`下载语音失败 HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    const { wav, format } = await qqVoiceToWav(buf, cfg);
    if (!transcribe) return { text: '', reason: '没有可用的识别接口', wav, format };
    const r = await transcribe(wav, { config: null, talker, onLog: (m) => log?.(m, 'debug') });
    return { text: String(r?.text || '').trim(), durationMs: r?.durationMs, format };
  } catch (e) {
    log?.(`QQ 语音识别失败: ${e.message}`, 'warn');
    return { text: '', reason: e.message };
  }
}
