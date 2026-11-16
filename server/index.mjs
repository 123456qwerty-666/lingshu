/**
 * 灵枢 AI 中枢 — 主服务器 v0.2
 * 纯 Node 内置模块，零第三方依赖
 */
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadConfig, saveConfig, replaceConfig, getConfig, loadDataDir,
  encryptSecret, ROOT_DIR, getConfigSync,
} from './config.mjs';
import {
  initDrivers, getReader, getHook, getState, sendText, sendImageFile, sendFileMsg,
  startListening, stopListening, getSessions, getChatHistory, searchChats,
  refreshReaderStatus, bumpReceived, bumpSkipped,
} from './wechat.mjs';
import { getAgentWhitelist, ensureWhitelisted, removeWhitelisted, ensureAudioPermission, AUDIO_PLUGIN_ID, conversationKeyOf } from './agent-bridge.mjs';
import { ai, setConfigSnapshot, endpoint, friendlyAIError } from './ai.mjs';
import { checkBalance, formatBalance, isDafeiyu, activeProviderId } from './balance.mjs';
import { router, ChatContext } from './router.mjs';
import {
  memoryConfig, buildMemoryPrompt, observeTurn, sweepAll, runForgetting, compactScope,
  listScopes, getScopeDetail, memoryStats, updateMemory, deleteMemory, clearScope,
  getArchive, restoreFromArchive, rebuildProfile, addMemories, searchMemories, dedupeScope,
  MEMORY_LABELS,
} from './memory.mjs';
import { compressContext, contextUsage } from './compressor.mjs';
import { stripTimeEcho } from './time.mjs';
import { saveToCache, copyToCache, recordMedia, mergeMediaIntoMessages, pruneCache } from './media-log.mjs';
import {
  qqApi, qqLoginInfo, qqFriendList, qqGroupList, sendQQ, sendQQText, sendQQImage,
  sendQQFace, sendQQRecord, normalizeOneBotEvent, cacheQQMedia, createProactiveEngine, qqVoiceToText,
} from './qq.mjs';
import {
  listMemoryLinks, addMemoryLink, removeMemoryLink, updateMemoryLink, syncAllMemory, broadcastMemory, mirrorTurn,
  listRooms, createRoom, deleteRoom, updateRoom, addRoomMember, removeRoomMember, syncRoom, syncAllRooms, propagateSettings,
  createPool, wipeTalker, poolOf,
  listSchedules, addSchedule, removeSchedule, toggleSchedule, dueSchedules, QQ_EXTENDED_ACTIONS,
} from './qq-extra.mjs';
import {
  voiceConfig, transcribe, synthesize, fetchVoiceWav, saveAudioFile,
  trimWav, wavInfo, cleanupAudio, VOICE_CATALOG, voiceCapabilityNote,
  DOUBAO_EMOTIONS, listSpeakers, addSpeaker, removeSpeaker, cloneDoubaoVoice, doubaoCloneStatus,
} from './voice.mjs';
import { listPersonasBrief, getPersona } from './personas.mjs';
import {
  initPlugins, getToolList, scaffoldPlugin, deletePlugin, reloadPlugins,
  callPluginTool, callToolByName, listAllPluginManifests,
  readPluginCode, writePluginCode,
} from './plugins.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const MEDIA_DIR = path.join(DATA_DIR, 'media');

// ── 日志 ──────────────────────────────────────────────────
const logs = [];
const MAX_LOGS = 800;
const logListeners = new Set();

function log(msg, level = 'info') {
  const entry = { ts: Date.now(), level, msg: String(msg) };
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.shift();
  for (const fn of logListeners) { try { fn(entry); } catch { /* ignore */ } }
  if (level === 'error') console.error(`[${new Date().toISOString()}] ERROR: ${entry.msg}`);
  else console.log(`[${new Date().toISOString()}] ${level.toUpperCase()}: ${entry.msg}`);
}

// ── 工具函数 ──────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error('JSON 格式错误'); }
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

/** 从工具返回值里提取待发送图片路径 */
function collectImagePaths(result) {
  const out = [];
  const push = (v) => {
    if (typeof v === 'string' && IMAGE_EXT.test(v) && fs.existsSync(v)) out.push(v);
    else if (v && typeof v === 'object') {
      for (const k of ['path', 'imagePath', 'filePath', 'file']) push(v[k]);
    }
  };
  if (!result || typeof result !== 'object') return out;
  push(result.path); push(result.imagePath); push(result.filePath);
  for (const k of ['paths', 'images', 'files', 'attachments']) {
    if (Array.isArray(result[k])) result[k].forEach(push);
  }
  return [...new Set(out)];
}

// ── 发送层：按平台分流（微信 / QQ） ──────────────────────
async function dispatchText(msg, text) {
  if (msg.platform === 'qq') return sendQQText(msg.qqTarget, text, (await loadConfig()).qq);
  return sendText(msg.talker, text);
}

async function sendReplyImage(msg, filePath) {
  if (msg.platform === 'qq') {
    const cfg = await loadConfig();
    return sendQQImage(msg.qqTarget, fs.readFileSync(filePath), cfg.qq);
  }
  return sendImageFile(msg.talker, filePath);
}

/** QQ 发真实语音气泡（SILK）；微信只能当音频文件发 */
async function sendReplyVoice(msg, filePath) {
  if (msg.platform === 'qq') {
    const cfg = await loadConfig();
    const ext = path.extname(filePath).slice(1) || 'wav';
    await sendQQRecord(msg.qqTarget, fs.readFileSync(filePath), ext, cfg.qq);
    log(`QQ 语音气泡已发送 → ${msg.qqTarget}`);
    return filePath;
  }
  await sendFileMsg(msg.talker, filePath);
  return filePath;
}

// ── 每聊天的有效设置 ──────────────────────────────────────
function chatSettings(config, talker) {
  const chat = config.chats?.[talker] || {};
  const globalEnabled = config.plugins?.enabled || [];
  // null = 跟随全局；[] = 该聊天一个插件都不用；[...] = 只用这些
  const pluginFilter = Array.isArray(chat.plugins) ? chat.plugins : globalEnabled;
  const providerId = chat.model?.providerId || config.ai.defaultProvider;
  // 只选了提供商没选模型时，用该提供商的默认/第一个模型，别把 undefined 丢给接口（会 400）
  const chatProv = config.ai.providers?.[chat.model?.providerId];
  const modelId = chat.model?.providerId
    ? (chat.model.modelId || chatProv?.model || chatProv?.models?.[0]?.id || undefined)
    : (chat.model?.modelId || config.ai.defaultModel || undefined);

  let systemPrompt = chat.persona || config.persona?.overrides?.[talker] || config.persona?.default || '';
  if (chat.style) systemPrompt += `\n\n【说话风格要求】${chat.style}`;

  return {
    chat,
    pluginFilter,
    providerId,
    modelId,
    systemPrompt,
    triggerMode: chat.triggerMode || config.wechat.triggerMode,
    reply: { ...config.wechat.reply, ...(chat.reply || {}) },
    memory: memoryConfig(config, talker),
    context: { ...config.context, ...(chat.context || {}) },
    voice: voiceConfig(config, talker),
    // 识图模型：聊天级优先，没设就跟随全局
    vision: { ...(config.ai.vision || {}), ...(chat.vision || {}) },
  };
}

// ── 消息处理主流程 ────────────────────────────────────────
const processing = new Set(); // talker 级别串行，避免同一聊天并发乱序
let audioPermissionReady = false;   // 是否已向 WeChatAgent 登记语音读取权限
let qqProactive = null;              // QQ 主动消息引擎
const seenRawids = new Map(); // rawid -> ts，SSE 重推 / 图片重试去重

/**
 * 微信库里「我们自己发出去的文字」经常读不到正文（parsedContent 变成
 * 「[未识别的消息类型 1]」）。灵枢自己存了原文，按时间补回去。
 */
function mergeContextText(messages, talker) {
  let ctx = [];
  try {
    ctx = new ChatContext(talker).getMessages(200)
      .filter(m => typeof m.content === 'string' && m.content.trim())
      .map(m => ({ role: m.role, text: m.content, ts: Number(m.ts) || 0 }));
  } catch { return messages; }
  if (!ctx.length) return messages;

  const used = new Set();
  return messages.map(m => {
    if (!m.isSend) return m;
    const shown = String(m.content || '');
    const parsed = String(m.parsedContent || '');
    const bad = !shown.trim()
      || /^\[未识别的消息类型|^\[非文本/.test(shown)
      || /^\[未识别的消息类型|^\[非文本/.test(parsed);
    if (!bad) return m;
    const ts = Number(m.createTime) * 1000;
    let best = -1;
    let diff = Infinity;
    ctx.forEach((c, i) => {
      if (used.has(i) || c.role !== 'assistant') return;
      const d = Math.abs(c.ts - ts);
      if (d < diff && d <= 8000) { diff = d; best = i; }
    });
    if (best < 0) return m;
    used.add(best);
    return { ...m, content: ctx[best].text, parsedContent: ctx[best].text };
  });
}

async function handleIncoming(event, { source = 'sse', force = false } = {}) {
  const config = await loadConfig();
  const msg = router.parseEvent(event, { ownWxid: config.wechat.ownWxid || getState().ownWxid });

  if (!msg.talker) { bumpSkipped('no_talker'); return { skipped: 'no_talker' }; }
  if (msg.isOutgoing) { bumpSkipped('outgoing'); return { skipped: 'outgoing' }; }

  // SSE 重连 / 图片重试都会重推同一条消息，按 rawid 去重
  if (msg.rawid) {
    if (seenRawids.has(msg.rawid)) {
      log(`重复事件已忽略 ${msg.rawid.slice(0, 12)}…`, 'debug');
      return { skipped: 'duplicate' };
    }
    seenRawids.set(msg.rawid, Date.now());
    if (seenRawids.size > 1500) {
      const cutoff = Date.now() - 30 * 60 * 1000;
      for (const [k, v] of seenRawids) { if (v < cutoff) seenRawids.delete(k); }
    }
  }

  // 控制台「→ AI」是手动投递，直接放行：群里 smart 模式要 @ 或唤醒词，
  // 但人造消息不该被这条规则挡掉，否则群聊里永远测不了。
  if (!force) {
    const trigger = router.shouldTrigger(msg, config);
    if (trigger.reason) {
      bumpSkipped(trigger.reason);
      log(`跳过 [${trigger.reason}] ${msg.kind}/${msg.talker}: ${msg.text.slice(0, 40)}`, 'debug');
      return { skipped: trigger.reason };
    }
  }

  const rl = router.checkRateLimit(msg.talker, config);
  if (!rl.allowed) {
    bumpSkipped('rate_limit');
    log(`限流 ${msg.talker}`, 'warn');
    return { skipped: 'rate_limit' };
  }

  bumpReceived();
  log(`收到 [${source}] ${msg.kind}/${msg.senderName || msg.talker}: ${msg.text.slice(0, 80)}`);

  if (processing.has(msg.talker)) {
    log(`${msg.talker} 上一条还在处理，本条排队等待`, 'debug');
  }
  while (processing.has(msg.talker)) await new Promise(r => setTimeout(r, 300));
  processing.add(msg.talker);

  try {
    return await processMessage(msg, config);
  } finally {
    processing.delete(msg.talker);
  }
}

async function processMessage(msg, config) {
  const settings = chatSettings(config, msg.talker);
  const context = new ChatContext(msg.talker);

  // ── 上下文预算：超了就先把旧消息压成摘要 ──
  const compressAt = settings.context?.compressAtTokens || 0;
  if (compressAt && context.tokens() >= compressAt) {
    try {
      const r = await compressContext(msg.talker, { aiClient: ai, config });
      if (r.summary) {
        log(`上下文压缩：${r.compressed} 条旧消息 → 摘要（${r.beforeTokens} → ${r.afterTokens} tokens，保留 ${r.kept} 条原文）`);
      } else if (r.skipped && r.skipped !== 'under_threshold') {
        log(`上下文压缩跳过：${r.skipped}${r.error ? ' — ' + r.error : ''}`, 'warn');
      }
    } catch (e) {
      log(`上下文压缩失败: ${e.message}`, 'warn');
    }
  }

  // ── 语音：先转成文字，后面全部按普通文本处理 ──
  const voiceCfg = voiceConfig(config, msg.talker);
  // QQ 的语音在 /api/qq/event 入口就已经下载并转成文字了（msg.text 形如「[语音] 内容」），
  // 这里不能再走一遍，否则会被当成「未识别的占位」把文字覆盖掉。
  if (msg.contentType === 34 && msg.platform !== 'qq') {
    // 读取器给的占位文案有几种："[语音]"、"[语音，尚未转写]" 等
    const rawText = String(msg.text || '').trim();
    const isPlaceholder = !rawText || /^[\[【]?\s*语音/.test(rawText);
    if (msg.voice?.id && voiceCfg.asrEnabled && voiceCfg.asrConfigured) {
      try {
        if (!audioPermissionReady) {
          const p = ensureAudioPermission();
          audioPermissionReady = p.ok;
          if (!p.ok) log(`语音权限登记失败：${p.reason || '未知'}`, 'warn');
          else if (p.changed) log('已向 WeChatAgent 登记语音读取权限（lingshu / audio_read）');
        }
        const key = conversationKeyOf(msg.kind, msg.conversationId);
        const got = await fetchVoiceWav(getReader(), msg.voice.id, key, AUDIO_PLUGIN_ID);
        const { buf, info, trimmed } = trimWav(got.buffer, 120);
        if (trimmed) log(`语音超过 120 秒，已截断后识别（${got.durationSeconds || info?.durationSeconds}s）`, 'warn');
        // 留底给控制台播放
        try {
          const cacheFile = saveToCache(buf, { ext: 'wav', tag: 'voice-in' });
          recordMedia(msg.talker, {
            dir: 'in', kind: 'voice', file: cacheFile,
            ts: msg.timestamp || Date.now(),
            duration: msg.voice.durationSeconds || got.durationSeconds || info?.durationSeconds || null,
          });
        } catch { /* ignore */ }
        const r = await transcribe(buf, { config, talker: msg.talker, onLog: (m) => log(m, 'debug') });
        const durSec = Math.round(msg.voice.durationSeconds || got.durationSeconds || info?.durationSeconds || 0);
        if (r.text) {
          msg.text = `[语音 ${durSec}s] ${r.text}`;
          log(`语音转文字：${r.text.slice(0, 50)}`);
        } else {
          msg.text = `[对方发来一条 ${durSec}s 的语音，但没听清内容（可能是空白或太短），可以请对方再说一遍]`;
          log(`语音 ${durSec}s 转写为空（太短或静音）`, 'warn');
        }
      } catch (e) {
        log(`语音转文字失败: ${e.message}`, 'warn');
        if (isPlaceholder) {
          msg.text = '[对方发来一条语音，但内容没能识别出来]';
        }
      }
    } else if (isPlaceholder) {
      msg.text = voiceCfg.asrEnabled
        ? '[对方发来一条语音，但内容没能识别出来]'
        : '[对方发来一条语音（该聊天未开启语音识别）]';
    }
  }

  // 平台感知：让 AI 清楚自己现在在微信还是 QQ，聊天时可以说出来
  if (msg.platform === 'qq') {
    settings.systemPrompt += '\n\n【当前平台】你正在 QQ 上和对方聊天，不是微信。'
      + '对方问起或语境合适时，可以自然提一句「QQ 这边」「我在 QQ 上」。'
      + 'QQ 能发真实语音气泡、表情包、图片，别再说「只能发文件」。';
  } else {
    settings.systemPrompt += '\n\n【当前平台】你正在微信上和对方聊天，不是 QQ。'
      + '对方问起或语境合适时，可以自然提一句「微信上」「我这边微信」。'
      + '微信目前只能把音频当文件发，不要说成语音气泡。';
  }

  // 大肥鱼 + DeepSeek：让它知道自己的「饭钱」（API 余额）
  try {
    const pid = activeProviderId(config, msg.talker);
    if (isDafeiyu(config, msg.talker) && /deepseek/i.test(pid)) {
      const b = await checkBalance(pid);
      if (b.ok) {
        settings.systemPrompt += `\n\n【你的饭钱】你（大肥鱼）现在还剩 ${b.total?.toFixed(2) ?? '未知'} 元 API 余额——这就是你的「饭钱」。`
          + '有人问起你的饭钱/还剩多少/还够聊多久，就照这个数回答，别说不知道，也别编大数字。'
          + '余额见底时可以顺势卖个惨、催对方充值，符合你的性格。'
          + `（数据由系统自动查询，5 分钟更新一次；需要最新数字可以调用 check_api_balance。）`;
      }
    }
  } catch { /* 余额查不到就不注入 */ }


  if (voiceCfg.enabled && voiceCfg.ttsConfigured) {
    settings.systemPrompt += '\n\n【语音】你能用 send_voice 把话念出来发给对方。'
      + '对方让你唱歌、要求用语音说、或者你想用语气表达情绪时，就调用它。'
      + 'text 只写要念出来的字，可以带语气词（唉、哈哈）和停顿「……」；不要写旁白或括号动作。'
      + '发完用一句话告诉对方已经发了，别把内容重复一遍。'
      + '**只有 send_voice 真的调用成功才能说「已经发给你了」**；没调用就绝不能说发了，否则对方会一直等一条不存在的语音。';
    // 豆包支持逐句情绪：教模型在每句话后面打标签
    if (voiceCfg.tts.protocol === 'doubao') {
      settings.systemPrompt += '\n【语音脚本的情绪】写 send_voice 的 text 时，'
        + '**每句话后面用方括号标一个情绪**，不同句子可以不一样。'
        + `可用情绪：${DOUBAO_EMOTIONS.map(e => `${e.label}(${e.id})`).join('、')}。`
        + '例如：我饿了[伤心]。不过我现在有钱了[开心]。你说吃什么好呢[兴奋]。'
        + '标签会按句切开分别合成，所以每句都要有自己的标签；'
        + '一句话里别塞两个情绪。整段实在只有一个情绪时，写一个标签就够了。'
        + '标签不会被念出来，也不要在正文里解释你标了什么。';
    }
  }

  // ── 记忆：想起旧事，拼进系统提示词 ──
  let memoryUsed = [];
  if (settings.memory?.enabled) {
    try {
      const mem = buildMemoryPrompt(msg.talker, {
        query: msg.text,
        memberKey: msg.kind === 'group' ? msg.senderWxid : msg.senderWxid,
        memberName: msg.senderName,
        cfg: config,
      });
      if (mem.prompt) {
        settings.systemPrompt = `${settings.systemPrompt}\n\n${mem.prompt}`;
        memoryUsed = mem.used;
        log(`回忆起 ${mem.used.length} 条记忆：${mem.used.slice(0, 3).map(u => u.text.slice(0, 14)).join(' / ')}`);
      }
    } catch (e) {
      log(`记忆检索失败: ${e.message}`, 'warn');
    }
  }

  let messages = router.buildMessages(context, msg, {
    systemPrompt: settings.systemPrompt,
    summary: context.getSummary(),
  });

  // 图片转 data URI（供多模态模型看图）
  if (msg.images.length) {
    log(`图片分支：${msg.images.length} 张 / autoView=${config.wechat.media?.autoViewImages}`, 'debug');
    if (config.wechat.media?.autoViewImages === false) {
      messages = withImageNotice(messages, msg.images.length, '用户关闭了自动识图');
    } else {
      const chatModel = settings.modelId || config.ai.defaultModel;
      const canSee = modelIsMultimodal(config, settings.providerId, chatModel);
      const visionConfigured = Boolean(config.ai.vision?.providerId);
      log(`图片分支：模型 ${settings.providerId}/${chatModel} canSee=${canSee} vision=${visionConfigured}`, 'debug');

      if (canSee || !visionConfigured) {
        // 聊天模型自己就能看图
        messages = await attachImages(messages, msg.images, msg);
      } else {
        // 聊天模型看不见 → 交给识图模型（默认 DeepSeek-V4.1-Flash）先描述
        const r = await describeImages(msg.images.map(i => i.id), { msg, config });
        if (r.ok) {
          messages = injectImageDescriptions(messages, r.descriptions, { isSticker: msg.contentType === 47 });
          log(`聊天模型不看图，已用识图模型 ${r.provider}/${r.model || '默认'} 转成文字`);
        } else {
          messages = withImageNotice(messages, msg.images.length, '识图模型也不可用');
        }
      }
    }
  }

  const tools = getToolList(settings.pluginFilter);
  // 这些是运行时临时加的工具（不经过插件注册表），必须单独登记，
  // 否则 AI 调用时会报「未找到工具」
  const dynamicTools = new Map();
  const addTool = (def) => { tools.push(def); dynamicTools.set(def.name, def); return def; };
  addTool({
    name: 'check_api_balance',
    description: '查询当前 AI 提供商的 API 余额。用户问「还剩多少钱」「饭钱还有多少」「余额够不够」时调用。',
    parameters: { type: 'object', properties: {}, required: [] },
    run: async () => {
      const pid = activeProviderId(config, msg.talker);
      const b = await checkBalance(pid);
      return { ok: b.ok, provider: pid, balance: b, text: formatBalance(b, { dafeiyu: isDafeiyu(config, msg.talker) }) };
    },
  });
  // QQ 通道：让 AI 能主动操作 QQ（发消息、发图、点赞、改签名、发动态…）
  if (msg.platform === 'qq' && config.qq?.enabled && config.qq?.aiActions?.enabled !== false) {
    const allowHigh = config.qq?.aiActions?.allowHighRisk === true;
    const usable = QQ_EXTENDED_ACTIONS.filter(a => a.ok !== false && (allowHigh || a.risk !== 'high'));
    addTool({
      name: 'qq_action',
      description: `操作 QQ。可用动作：${usable.map(a => `${a.action}(${a.label}，参数 ${a.params})`).join('；')}。`
        + '直接发消息用 send_qq_message，不要用它。高风险动作需要用户单独开启。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: '动作名' },
          params: { type: 'object', description: '该动作的参数，见动作说明' },
          target: { type: 'string', description: '可选，私聊/群目标，格式 private:QQ号 或 group:群号' },
          text: { type: 'string', description: '可选，要发送的文字' },
        },
        required: ['action'],
      },
      run: async (args) => {
        const act = String(args?.action || '');
        log(`AI 请求 QQ 动作: ${act} | 参数: ${JSON.stringify(args?.params || {}).slice(0, 120)}`);
        if (!usable.some(a => a.action === act)) throw new Error(`动作「${act}」未开放，可用：${usable.map(x => x.action).join('/')}`);
        const params = { ...(args?.params || {}) };
        if (args?.target) {
          const [kind, id] = String(args.target).split(':');
          params[kind === 'group' ? 'group_id' : 'user_id'] = Number(id);
        }
        if (args?.text) params.message = params.message || args.text;
        try {
          const r = await qqApi(act, params, config.qq);
          log(`AI 执行 QQ 动作 ${act} 成功`);
          return { ok: true, action: act, result: r };
        } catch (e) {
          log(`AI 执行 QQ 动作 ${act} 失败: ${e.message}`, 'warn');
          return { ok: false, action: act, error: e.message };
        }
      },
    });
    addTool({
      name: 'send_qq_message',
      description: '主动给某个 QQ 好友或群发消息（文字/图片/表情）。不需要别人先说话也能发。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'private:QQ号 或 group:群号' },
          text: { type: 'string', description: '要发的内容' },
          faceId: { type: 'number', description: '可选，附带一个 QQ 表情 ID' },
        },
        required: ['target', 'text'],
      },
      run: async (args) => {
        const target = String(args?.target || msg.qqTarget || '');
        const [kind, id] = target.split(':');
        if (!Number.isFinite(Number(id))) throw new Error('目标格式不对');
        const segs = [{ type: 'text', data: { text: String(args.text || '') } }];
        if (args?.faceId) segs.push({ type: 'face', data: { id: String(args.faceId) } });
        const key = kind === 'group' ? 'group_id' : 'user_id';
        const r = await qqApi(kind === 'group' ? 'send_group_msg' : 'send_private_msg',
          { [key]: Number(id), message: segs }, config.qq);
        log(`AI 主动发 QQ 消息 → ${target}`);
        return { ok: true, result: r };
      },
    });
  }
  // 内置语音工具：让模型自己决定「这条要不要用语音」
  if (voiceCfg.ttsConfigured && voiceCfg.enabled) {
    addTool({
      name: 'send_voice',
      pluginId: 'builtin-voice',
      description: '把一段话合成语音，以音频文件发给对方。适合：对方让你唱歌/说一遍/用语音、你需要用语气表达情绪、或者内容本身适合念出来。'
        + 'text 只写要念的内容，可以写歌词、语气词（如「唉」「哈哈」）和停顿「……」；不要写旁白、解释、括号动作。'
        + '发送成功后，用一句话简短告诉对方已经发了，不要再把内容重复一遍。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要念的内容。豆包支持逐句情绪：在每句话后面加 [情绪] 标签，如「我饿了[伤心]。现在有钱了[开心]。」标签不会被念出来' },
          voice: { type: 'string', description: '可选音色（名字或 ID），留空用当前聊天设置的音色' },
          emotion: {
            type: 'string',
            description: `可选情绪（豆包多情感音色支持）：${DOUBAO_EMOTIONS.map(e => e.id).join(' / ')}`,
          },
          emotionScale: {
            type: 'number',
            description: '情绪强度 1~5，越大越明显（默认 4），需配合 emotion 使用',
          },
        },
        required: ['text'],
      },
    });
  }
  const sentImagePaths = [];
  const sentVoicePaths = [];

  let replyText = '';
  let toolRuns = [];
  try {
    const result = await ai.runToolLoop(messages, tools, {
      providerId: settings.providerId,
      modelOverride: settings.modelId,
      temperature: 0.75,
      maxTokens: 1800,
      maxRounds: 4,
      onLog: (m, lvl) => log(m, lvl || 'info'),
      callTool: async (name, args) => {
        // send_voice 虽然也经过 addTool 注册，但它的执行逻辑在下面单独分支里，
        // 定义上没有 run 方法，必须排在这里，否则会命中动态表报
        // 「dyn.run is not a function」。
        if (name === 'send_voice') {
          return sendVoiceTool(args, msg, config, sentVoicePaths);
        }
        // 再查运行时临时注册的工具（qq_action / send_qq_message / check_api_balance）
        const dyn = dynamicTools.get(name);
        if (dyn && typeof dyn.run === 'function') {
          try {
            const r = await dyn.run(args);
            if (r && r.ok === false) log(`工具 ${name} 返回失败: ${String(r.error || '').slice(0, 120)}`, 'warn');
            return r;
          } catch (e) {
            log(`工具 ${name} 执行失败: ${e.message}`, 'warn');
            return { ok: false, error: e.message };
          }
        }
        const toolResult = await callToolByName(name, args, {
          talker: msg.talker, kind: msg.kind, conversationId: msg.conversationId,
          senderWxid: msg.senderWxid, senderName: msg.senderName,
        });
        if (toolResult && toolResult.success === false) {
          log(`工具 ${name} 失败: ${String(toolResult.error || '').slice(0, 120)}`, 'warn');
        }
        // 工具吐出图片 → 自动发送
        if (config.wechat.media?.autoSendImages !== false) {
          const paths = collectImagePaths(toolResult);
          for (const p of paths) {
            try {
              await sendReplyImage(msg, p);
              sentImagePaths.push(p);
              // 留底：原文件马上会被删，控制台需要一份能显示的副本
              try {
                const cacheFile = copyToCache(p, { tag: 'image-out' });
                recordMedia(msg.talker, { dir: 'out', kind: 'image', file: cacheFile, ts: Date.now() });
              } catch { /* ignore */ }
              log(`已发送图片 ${path.basename(p)} → ${msg.talker}`);
              if (p.startsWith(path.join(MEDIA_DIR, 'pending-send'))) {
                try { fs.unlinkSync(p); } catch { /* ignore */ }
              }
            } catch (e) {
              log(`图片发送失败: ${e.message}`, 'error');
            }
          }
          if (paths.length) {
            return { ...toolResult, _note: '图片已自动发送到当前聊天，无需再调用发送工具' };
          }
        }
        return toolResult;
      },
    });
    replyText = result.content || '';
    toolRuns = result.toolRuns;
  } catch (e) {
    log(`AI 调用失败: ${e.message}`, 'error');
    replyText = friendlyAIError(e);
  }

  if (!replyText.trim() && !sentImagePaths.length) {
    // 模型没吐文字但确实跑了工具（常见于搜索读页面用尽轮次）→ 兜底给点有用的
    const fallback = fallbackReplyFromTools(toolRuns);
    if (fallback) {
      replyText = fallback;
      log('模型未输出正文，已用工具结果兜底回复', 'warn');
    } else if (sentVoicePaths.length) {
      log('模型只调用了语音工具，没有额外文字', 'debug');
    } else {
      log('模型返回空内容，未回复', 'warn');
      return { ok: false, reason: 'empty_reply' };
    }
  }

  context.addMessage('user', msg.text, { images: msg.images.map(i => i.id), contentType: msg.contentType, ts: msg.timestamp });
  if (replyText.trim()) context.addMessage('assistant', replyText);

  // 兜底：模型偶尔会把我们注入的时间尾注抄进回复里，发出去很难看
  if (replyText.trim()) {
    const cleaned = stripTimeEcho(replyText);
    if (cleaned !== replyText.trim()) log('已清理回复中多余的时间尾注', 'debug');
    replyText = cleaned;
  }

  const parts = replyText.trim() ? router.splitReply(replyText, config) : [];

  // ── 语音合成：把回复念成音频，以音频文件发出 ──
  // 注意顺序：先把文字发出去，再做语音。豆包这类耗时几秒到十几秒、复刻训练要几分钟的模型
  // 如果挡在文字前面，对方会干等到以为死机。
  const wantVoice = Boolean(replyText.trim() && voiceCfg.ttsConfigured && voiceCfg.sendMode !== 'off')
    && (voiceCfg.sendMode !== 'random' || Math.random() < voiceCfg.randomRate);

  const onlyVoice = voiceCfg.sendMode === 'onlyVoice' && wantVoice;
  const textParts = onlyVoice ? [] : parts;

  if (textParts.length) {
    for (let i = 0; i < textParts.length; i++) {
      try {
        await dispatchText(msg, textParts[i]);
      } catch (e) {
        log(`发送失败: ${e.message}`, 'error');
        break;
      }
      if (i < textParts.length - 1) await new Promise(r => setTimeout(r, settings.reply?.minIntervalMs || 1200));
    }
  }

  let voiceSent = 0;
  if (wantVoice) {
    if (onlyVoice) {
      // 只发语音：必须等结果；失败就兜底发文字
      voiceSent = (await synthAndSendVoice(msg, replyText, config, voiceCfg)) ? 1 : 0;
      if (!voiceSent && parts.length) {
        log('只发语音但合成失败，已兜底发送文字', 'warn');
        for (const p of parts) { try { await dispatchText(msg, p); } catch { /* ignore */ } }
      }
    } else {
      // 文字已经发出去了，语音在后台慢慢合成，
      // 否则会把后续消息和处理队列一起堵住
      synthAndSendVoice(msg, replyText, config, voiceCfg)
        .catch(e => log(`后台语音失败: ${e.message}`, 'warn'));
    }
  }

  if (textParts.length || voiceSent || sentVoicePaths.length) {
    log(`已回复 ${msg.talker}（${textParts.length} 条${voiceSent || sentVoicePaths.length ? `，${voiceSent + sentVoicePaths.length} 条语音` : ''}${sentImagePaths.length ? `，${sentImagePaths.length} 张图` : ''}${toolRuns.length ? `，${toolRuns.length} 次工具` : ''}）`);
  }

  // ── 实时镜像 + 记忆沉淀（异步，不阻塞回复）──
  // 微信这边说一句，立刻写进绑定的 QQ 会话历史，反之亦然
  (async () => {
    try {
      const mirrored = await mirrorTurn(msg.talker, { userText: msg.text || '', aiText: replyText || '' });
      if (mirrored.length) log(`实时镜像：${msg.talker} → ${mirrored.join('、')}（用户+AI 共 2 条）`, 'debug');
    } catch (e) { log(`实时镜像失败: ${e.message}`, 'warn'); }
  })();

  if (settings.memory?.enabled && settings.memory?.autoTag) {
    afterTurnMemory(msg, config, context, replyText)
      .then(() => {
        // 记忆沉淀完，把新记忆推给绑定的另一端（微信 ↔ QQ 互通）
        try {
          const pushed = broadcastMemory(msg.talker);
          const n = pushed.reduce((s, x) => s + x.added, 0);
          if (n) log(`记忆同步：${msg.talker} → ${pushed.length} 个会话，新增 ${n} 条`);
        } catch (e) { log(`记忆同步失败: ${e.message}`, 'warn'); }
      })
      .catch(e => log(`记忆沉淀失败: ${e.message}`, 'warn'));
  }

  return { ok: true, parts: parts.length, images: sentImagePaths.length, tools: toolRuns.map(t => t.name), memories: memoryUsed.length };
}

/**
 * 一轮对话结束后：让模型给这轮打标签、提取值得记住的事，写入会话/成员记忆。
 * 之后再视情况触发压缩。
 */
async function afterTurnMemory(msg, config, context, replyText) {
  const res = await observeTurn({
    talker: msg.talker,
    kind: msg.kind,
    userName: msg.senderName || msg.talker,
    userWxid: msg.senderWxid || '',
    userText: msg.text,
    botText: replyText,
    history: context.getMessages(6),
    aiClient: ai,
    cfg: config,
    // 用这条消息真实的发生时间，而不是"写入记忆的时间"
    occurredAt: msg.timestamp || Date.now(),
  });

  if (res.skipped) {
    if (res.skipped !== 'memory_off' && res.skipped !== 'empty_input') {
      log(`记忆沉淀跳过: ${res.skipped}${res.error ? ' — ' + res.error : ''}`, 'debug');
    }
    return;
  }
  if (res.added > 0) {
    log(`记忆沉淀：${res.label}（${(res.tags || []).join('/') || '无标签'}）新增 ${res.added} 条`);
  }

  // 超额则压缩该会话记忆
  const mc = memoryConfig(config, msg.talker);
  try {
    const detail = getScopeDetail(msg.talker);
    const memberTotal = Object.values(detail.members).reduce((n, m) => n + m.memories.length, 0);
    if (detail.chat.length > mc.maxChatMemories || memberTotal > mc.maxMemberMemories * Math.max(1, Object.keys(detail.members).length)) {
      const r = await compactScope(msg.talker, { aiClient: ai, cfg: config });
      if (r.merged) log(`记忆压缩：合并 ${r.merged} 条为摘要记忆（会话剩 ${r.chat} 条）`);
    }
  } catch (e) {
    log(`记忆压缩失败: ${e.message}`, 'warn');
  }
}

/** 自动语音：合成 → 落盘 → 发文件 → 记媒体。返回是否真的发出去了 */
async function synthAndSendVoice(msg, text, config, voiceCfg) {
  try {
    const tts = await synthesize(text, { config, talker: msg.talker, onLog: (m) => log(m, 'debug') });
    const info = wavInfo(tts.buffer);
    // TTS 返回 mp3 时 wavInfo 读不出时长，用 ffprobe 兜底
    const dur = info?.durationSeconds || 0;
    const limit = voiceCfg.maxSeconds || 0;
    if (limit > 0 && dur > limit) {
      log(`语音合成 ${dur.toFixed(1)}s 超过 ${limit}s 上限，不发送`, 'warn');
      return false;
    }
    const fp = saveAudioFile(tts.buffer, tts.ext, 'reply');
    await sendReplyVoice(msg, fp);
    log(`语音已发送：${dur ? dur.toFixed(1) + 's' : '时长未知'} · 音色 ${tts.voice} → ${msg.talker}`);
    try {
      const cacheFile = copyToCache(fp, { tag: 'voice-out' });
      recordMedia(msg.talker, {
        dir: 'out', kind: 'voice', file: cacheFile, ts: Date.now(), duration: dur || null, text,
      });
    } catch { /* ignore */ }
    return true;
  } catch (e) {
    log(`语音合成/发送失败: ${e.message}`, 'warn');
    return false;
  }
}

/** 模型主动发语音：合成 → 落盘 → 发文件。不设时长上限（文件不受语音 60 秒限制） */
/** 用 ffprobe 读音频时长（TTS 返回 mp3 时 wavInfo 认不出来，否则日志会显示 0.0s） */
function audioDurationSeconds(filePath, cfg = {}) {
  try {
    // ffmpeg 路径在 qq 段里（voice 段没有），两个都试一下
    const ffmpeg = cfg.ffmpegPath || cfg.qq?.ffmpegPath || getConfigSync()?.qq?.ffmpegPath || '';
    if (!ffmpeg) return null;
    const probe = path.join(path.dirname(ffmpeg), 'ffprobe.exe');
    if (!fs.existsSync(probe)) return null;
    const r = spawnSync(probe, ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', filePath], { encoding: 'utf8', timeout: 15000 });
    const n = Number(String(r.stdout || '').trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}

async function sendVoiceTool(args, msg, config, sink) {
  const text = String(args?.text || '').trim();
  if (!text) return { success: false, error: 'text 不能为空' };
  try {
    const tts = await synthesize(text.slice(0, 4000), {
      config,
      talker: msg.talker,
      voice: args?.voice || null,
      emotion: args?.emotion || null,
      emotionScale: args?.emotionScale ?? null,
      onLog: (m) => log(m, 'debug'),
    });
    if (!tts.buffer?.length) return { success: false, error: '合成结果是空音频' };
    const info = wavInfo(tts.buffer);
    const fp = saveAudioFile(tts.buffer, tts.ext, 'ai');
    await sendReplyVoice(msg, fp);
    sink.push(fp);
    try {
      const cacheFile = copyToCache(fp, { tag: 'voice-out' });
      recordMedia(msg.talker, {
        dir: 'out', kind: 'voice', file: cacheFile, ts: Date.now(),
        duration: durSec ?? null,
        text: text.slice(0, 120),
      });
    } catch { /* ignore */ }
    const durSec = info?.durationSeconds ?? audioDurationSeconds(fp, config.voice);
    log(`AI 主动发语音：${durSec ? durSec.toFixed(1) + 's' : '已发送'} · 音色 ${tts.voice}`);
    return {
      success: true,
      sent: true,
      durationSeconds: info?.durationSeconds ?? null,
      voice: tts.voice,
      hint: '已发送成功。用一句话告诉对方已经发了即可，不要把内容再重复一遍。',
    };
  } catch (e) {
    log(`AI 发语音失败: ${e.message}`, 'warn');
    return { success: false, error: e.message };
  }
}

/** 模型没给出正文时，用工具结果拼一条兜底回复 */
function fallbackReplyFromTools(toolRuns = []) {
  const search = [...toolRuns].reverse().find(t => t.name === 'web_search' && t.result?.results?.length);
  if (search) {
    const top = search.result.results.slice(0, 3);
    return [
      `我查到这些（来自 ${search.result.engine || '网络'}）：`,
      ...top.map((r, i) => `${i + 1}. ${r.title}\n${r.url}`),
      '需要我细说哪一条？',
    ].join('\n');
  }
  const page = [...toolRuns].reverse().find(t => t.name === 'fetch_url' && t.result?.text);
  if (page) {
    return `我读了 ${page.result.url}\n${String(page.result.text).slice(0, 300)}…\n（原文较长，想看哪部分告诉我）`;
  }
  const img = [...toolRuns].reverse().find(t => (t.result?.path || t.result?.url) && /image|gen/i.test(t.name));
  if (img) {
    return `图已经画好了，你看一下${t0name(img.result) ? `：${t0name(img.result)}` : ''}`;
  }
  const any = [...toolRuns].reverse().find(t => t.result && t.result.success !== false);
  if (any) {
    const text = String(any.result.text || any.result.content || any.result.message || '').slice(0, 400);
    if (text) return `（${any.name}）${text}`;
  }
  return '';
}

function t0name(r) {
  return String(r?.path ? path.basename(r.path) : r?.url || '').slice(0, 80);
}

function withImageNotice(messages, count, reason) {  const out = [...messages];
  const last = out[out.length - 1];
  if (last && Array.isArray(last.content)) {
    out[out.length - 1] = {
      ...last,
      content: [...last.content, { type: 'text', text: `[用户发来 ${count} 张图片/表情，但${reason}，你看不到画面]` }],
    };
  }
  return out;
}

/**
 * 把消息里的 image_ref 换成真正的 data URI（inline 版，聊天模型自己看得见图时用）。
 * 失败不抛错：降级成一句说明，让模型仍然能给出合理回应。
 */
async function attachImages(messages, images, msg) {
  const reader = getReader();
  if (!reader) return withImageNotice(messages, images.length, '微信读取器未连接');

  const isSticker = msg?.contentType === 47;
  const cache = new Map();
  const out = [];
  let okCount = 0;
  const errors = [];

  for (const m of messages) {
    if (!Array.isArray(m.content)) { out.push(m); continue; }
    const parts = [];
    for (const p of m.content) {
      if (p.type !== 'image_ref') { parts.push(p); continue; }
      const t0 = Date.now();
      try {
        let data = cache.get(p.imageId);
        if (!data) {
          data = await reader.getImage(p.imageId);
          cache.set(p.imageId, data);
        }
        if (data?.b64) {
          const kb = Math.round((data.b64.length * 0.75) / 1024);
          parts.push({ type: 'image_ref', dataUrl: `data:${data.mime || 'image/jpeg'};base64,${data.b64}` });
          okCount++;
          // 留底给控制台显示（历史消息里取不到图片字节）
          try {
            const cacheFile = saveToCache(Buffer.from(data.b64, 'base64'), {
              mime: data.mime, tag: isSticker ? 'sticker' : 'image',
            });
            recordMedia(msg?.talker, {
              dir: 'in',
              kind: isSticker ? 'sticker' : 'image',
              file: cacheFile,
              ts: (msg?.timestamp || Date.now()),
              text: msg?.text || '',
            });
          } catch { /* ignore */ }
          log(`已读取${isSticker ? '表情包' : '图片'} ${p.imageId.slice(0, 10)}… ${data.width || '?'}x${data.height || '?'} ${kb}KB (${Date.now() - t0}ms)`, 'debug');
        } else {
          parts.push({ type: 'text', text: '[图片数据为空]' });
          errors.push('空数据');
        }
      } catch (e) {
        errors.push(e.message);
        log(`读取图片失败 ${p.imageId.slice(0, 10)}…: ${e.message} (${Date.now() - t0}ms)`, 'warn');
        parts.push({ type: 'text', text: `[图片读取失败：${e.message}]` });
      }
    }
    const hasText = parts.some(p => p.type === 'text' && !p.text.startsWith('[图片'));
    if (!hasText) {
      parts.unshift({
        type: 'text',
        text: isSticker ? '（用户发来一个表情包）' : '（用户发来一张图片）',
      });
    }
    out.push({ ...m, content: parts });
  }

  if (okCount === 0 && errors.length) {
    // 全部失败 → 明确告诉模型「看不到」，避免它瞎编
    return withImageNotice(out, images.length, '图片在本地解析失败');
  }
  return out;
}

// ── 识图：聊天模型看不见时，交给专门的识图模型（默认 DeepSeek-V4.1-Flash）──
function modelIsMultimodal(config, providerId, modelId) {
  const p = config.ai.providers?.[providerId];
  if (!p) return false;
  const m = (p.models || []).find(x => x.id === modelId);
  if (m && typeof m.multimodal === 'boolean') return m.multimodal;
  return /vision|4o|gemini|flash|vl\b/i.test(String(modelId || ''));
}

/** 用识图模型把图片转成文字描述 */
async function describeImages(imageIds, { msg, config }) {
  const reader = getReader();
  if (!reader) return { ok: false, reason: '读取器未连接' };

  // 这个聊天单独指定的识图模型优先，否则跟随全局
  const chatVision = config.chats?.[msg?.talker]?.vision || {};
  const vp = chatVision.providerId || config.ai.vision?.providerId || config.ai.defaultProvider;
  const vm = chatVision.modelId || config.ai.vision?.modelId || config.ai.defaultModel || undefined;
  const descriptions = [];
  let okCount = 0;

  for (const id of imageIds) {
    const t0 = Date.now();
    try {
      const data = await reader.getImage(id);
      if (!data?.b64) { descriptions.push('（这张图读不出来）'); continue; }
      const dataUrl = `data:${data.mime || 'image/jpeg'};base64,${data.b64}`;
      const isSticker = msg?.contentType === 47;
      const r = await ai.chat([
        {
          role: 'system',
          content: isSticker
            ? '你是表情包描述器。用一句中文说清这个表情想表达什么情绪或意思，20 字内，不要评价画质。'
            : '你是图片描述器。客观描述画面内容：主体、动作、场景、以及图上的文字。中文，80 字内，不要编造看不见的细节。',
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: isSticker ? '这个表情是什么意思？' : '描述这张图片。' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ], { providerId: vp, modelOverride: vm, maxTokens: 300, temperature: 0.3, onLog: (m, l) => log(m, l) });
      const text = (r.content || '').trim();
      if (text) {
        descriptions.push(text);
        okCount++;
        log(`识图模型 ${r.provider}/${r.model} 已描述图片 ${id.slice(0, 8)}… (${Date.now() - t0}ms)`, 'debug');
      } else {
        descriptions.push('（这张图没描述出来）');
      }
    } catch (e) {
      log(`识图失败 ${id.slice(0, 8)}…: ${e.message}`, 'warn');
      descriptions.push(`（识图失败：${e.message.slice(0, 40)}）`);
    }
  }
  return { ok: okCount > 0, descriptions, provider: vp, model: vm };
}

/** 把图片描述插进最后一条用户消息 */
function injectImageDescriptions(messages, descriptions, { isSticker }) {
  const out = [...messages];
  const last = out[out.length - 1];
  const label = isSticker ? '表情包' : '图片';
  const lines = descriptions.map((d, i) => `- 第 ${i + 1} 张${label}：${d}`).join('\n');
  const text = `【对方发来 ${descriptions.length} 张${label}，你看到的是文字描述】\n${lines}\n（这些描述由识图模型生成，你没看到原图，别说得比描述更具体。）`;

  if (last && Array.isArray(last.content)) {
    out[out.length - 1] = { ...last, content: [...last.content, { type: 'text', text }] };
  } else if (last) {
    out[out.length - 1] = { ...last, content: [{ type: 'text', text: String(last.content || '') + '\n' + text }] };
  }
  return out;
}


/** QQ 图片 → 文字描述（走识图模型，和微信那条链路口径一致） */
async function qqImageToText(url, { config, talker = null, isSticker = false } = {}) {
  if (!url) throw new Error('没有图片地址');
  const chatVision = config.chats?.[talker]?.vision || {};
  const vp = chatVision.providerId || config.ai.vision?.providerId || config.ai.defaultProvider;
  const vm = chatVision.modelId || config.ai.vision?.modelId || config.ai.defaultModel || undefined;

  const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!resp.ok) throw new Error(`下载图片失败 HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (!buf.length) throw new Error('图片内容为空');
  const mime = (resp.headers.get('content-type') || '').split(';')[0] || 'image/jpeg';
  const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;

  const r = await ai.chat([
    {
      role: 'system',
      content: isSticker
        ? '你是表情包描述器。用一句中文说清这个表情想表达什么情绪或意思，20 字内，不要评价画质。'
        : '你是图片描述器。客观描述画面内容：主体、动作、场景、以及图上的文字。中文，80 字内，不要编造看不见的细节。',
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: isSticker ? '这个表情是什么意思？' : '描述这张图片。' },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    },
  ], { providerId: vp, modelOverride: vm, maxTokens: 300, temperature: 0.3 });
  return String(r?.content || '').trim();
}

// ── HTTP 路由 ─────────────────────────────────────────────
async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) { sendJson(res, 403, { error: 'forbidden' }); return; }
  try {
    const data = await fs.promises.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'Not found', path: rel });
  }
}

async function serveMedia(res, urlPath) {  const rel = decodeURIComponent(urlPath.replace(/^\/media\/+/, ''));
  const filePath = path.join(MEDIA_DIR, rel);
  if (!filePath.startsWith(MEDIA_DIR)) { sendJson(res, 403, { error: 'forbidden' }); return; }
  try {
    const data = await fs.promises.readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'not found' });
  }
}

/** 拉取并写回某提供商的模型列表 */
async function refreshProviderModels(providerId) {
  const provider = await ai.getProvider(providerId);
  const resp = await fetch(endpoint(provider.baseUrl, '/v1/models'), {
    headers: { Authorization: `Bearer ${provider.apiKey}` },
    signal: AbortSignal.timeout(20000),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`模型列表 ${resp.status}: ${text.slice(0, 200)}`);
  const data = JSON.parse(text);
  const raw = data.data || data.models || [];
  const models = raw.map(m => {
    const id = m.id || m.name;
    return {
      id,
      name: m.name || id,
      multimodal: (m.input_modalities || []).includes('image') || /vision|4o|gemini|flash|vl\b/i.test(id),
      imageGen: /image|dall-e|flux|sd/i.test(id),
    };
  });
  if (!models.length) throw new Error('提供商没有返回任何模型');
  await saveConfig({ ai: { providers: { [providerId]: { models } } } });
  return models;
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const p = url.pathname;
  const method = req.method;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── 健康 / 状态 ──
  if (p === '/api/ai/balance' && method === 'GET') {
    const cfg = await loadConfig();
    const pid = url.searchParams.get('provider') || cfg.ai?.defaultProvider;
    const b = await checkBalance(pid, { force: url.searchParams.get('force') === '1' });
    sendJson(res, 200, { ...b, text: formatBalance(b, { dafeiyu: false }) });
    return;
  }

  if (p === '/api/health' && method === 'GET') {
    const readerInfo = await refreshReaderStatus();
    sendJson(res, 200, {
      ok: true,
      state: { ...getState(), processing: processing.size },
      reader: readerInfo ? {
        subscribers: readerInfo.subscribers,
        pushed: readerInfo.pushed,
        lastPoll: readerInfo.lastPoll,
        lastError: readerInfo.lastError,
        accountDirectory: readerInfo.accountDirectory,
      } : null,
      counts: {
        logs: logs.length,
        contexts: countContexts(),
      },
      logs: logs.slice(-15),
    });
    return;
  }

  // ── 配置 ──
  if (p === '/api/config' && method === 'GET') {
    const cfg = await loadConfig();
    const masked = structuredClone(cfg);
    for (const prov of Object.values(masked.ai.providers || {})) {
      if (prov.apiKey) prov.apiKey = `${String(prov.apiKey).slice(0, 6)}***`;
    }
    if (masked.wechat.readerToken) masked.wechat.readerToken = '***';
    if (masked.wechat.hookToken) masked.wechat.hookToken = '***';
    sendJson(res, 200, masked);
    return;
  }

  if (p === '/api/config' && method === 'POST') {
    const patch = await readJsonBody(req);
    // 掩码值不要覆盖真实密钥
    for (const prov of Object.values(patch.ai?.providers || {})) {
      if (typeof prov.apiKey === 'string' && prov.apiKey.endsWith('***')) delete prov.apiKey;
    }
    if (patch.wechat?.readerToken === '***') delete patch.wechat.readerToken;
    if (patch.wechat?.hookToken === '***') delete patch.wechat.hookToken;
    const cfg = await saveConfig(patch);
    setConfigSnapshot(cfg);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (p === '/api/config/secret' && method === 'POST') {
    const { providerId, apiKey } = await readJsonBody(req);
    if (!providerId || !apiKey) { sendJson(res, 400, { error: '缺少参数' }); return; }
    const { saveSecret } = await import('./config.mjs');
    await saveSecret(`ai_${providerId}`, apiKey);
    sendJson(res, 200, { ok: true });
    return;
  }

  // ── 会话 ──
  if (p === '/api/sessions' && method === 'GET') {
    try {
      sendJson(res, 200, { sessions: await getSessions() });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  // 群成员候选：优先用记忆里认识的人，其次用最近聊天记录里的发言人
  if (p === '/api/chats/members' && method === 'GET') {
    const talker = url.searchParams.get('talker');
    if (!talker) { sendJson(res, 400, { error: '缺少 talker' }); return; }
    const found = new Map();
    try {
      const d = getScopeDetail(talker);
      for (const [wxid, m] of Object.entries(d.members || {})) {
        if (wxid && !String(wxid).includes('@chatroom')) found.set(wxid, m.name || wxid);
      }
    } catch { /* ignore */ }
    try {
      const msgs = await getChatHistory(talker, 80);
      for (const m of msgs) {
        if (m.isSend) continue;
        const wxid = m.senderUsername;
        if (wxid && wxid !== talker && !String(wxid).includes('@chatroom') && !found.has(wxid)) {
          found.set(wxid, m.senderDisplay || wxid);
        }
      }
    } catch { /* ignore */ }
    sendJson(res, 200, { members: [...found].map(([wxid, name]) => ({ wxid, name })) });
    return;
  }

  if (p === '/api/chat/history' && method === 'GET') {
    const talker = url.searchParams.get('talker');
    const limit = Math.min(200, parseInt(url.searchParams.get('limit') || '40', 10));
    if (!talker) { sendJson(res, 400, { error: '缺少 talker' }); return; }
    try {
      const msgs = await getChatHistory(talker, limit);
      const { messages, orphans } = mergeMediaIntoMessages(msgs, talker);
      const withText = mergeContextText(messages, talker);
      const all = [...withText, ...orphans].sort((a, b) => (a.createTime || 0) - (b.createTime || 0));
      sendJson(res, 200, { messages: all, withMedia: true });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  if (p === '/api/send/text' && method === 'POST') {
    const { talker, text } = await readJsonBody(req);
    try {
      const r = await sendText(talker, text);
      log(`手动发送 → ${talker}: ${String(text).slice(0, 40)}`);
      sendJson(res, 200, { ok: true, ...r });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  if (p === '/api/send/image' && method === 'POST') {
    const { talker, filePath } = await readJsonBody(req);
    try {
      const r = await sendImageFile(talker, filePath);
      sendJson(res, 200, { ok: true, ...r });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  // ── 聊天注册表 ──
  if (p === '/api/chats' && method === 'GET') {
    const cfg = await loadConfig();
    const agent = getAgentWhitelist();
    const all = Object.entries(cfg.chats || {}).map(([talker, c]) => ({
      talker,
      ...c,
      platform: String(talker).startsWith('qq:') ? 'qq' : 'wx',
      context: new ChatContext(talker).stats(),
      settings: chatSettings(cfg, talker),
    }));
    // QQ 会话单独一组，别混进微信列表
    const chats = all.filter(c => c.platform === 'wx');
    const qqChats = all.filter(c => c.platform === 'qq');
    sendJson(res, 200, { chats, qqChats, agentWhitelist: agent });
    return;
  }

  if (p === '/api/chats/search' && method === 'POST') {
    const { query = '', kind = '' } = await readJsonBody(req);
    try {
      const results = await searchChats(query, kind);
      const cfg = await loadConfig();
      const existing = new Set(Object.keys(cfg.chats || {}));
      sendJson(res, 200, {
        results: results.map(r => ({ ...r, added: existing.has(r.talker) })),
      });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  if (p === '/api/chats/add' && method === 'POST') {
    const { talker, kind = 'private', conversationId = '', name = '' } = await readJsonBody(req);
    if (!talker) { sendJson(res, 400, { error: '缺少 talker' }); return; }
    try {
      const cfg = await loadConfig();
      let convId = String(conversationId || '');
      let chatKind = kind;
      let chatName = name || talker;

      // conversationId 缺失时向 reader 查一次（白名单要用它）
      if (!convId) {
        const found = (await searchChats(talker)).find(r => r.talker === talker);
        if (found) { convId = found.conversationId; chatKind = found.kind; chatName = name || found.displayName; }
      }

      const patch = {
        chats: {
          [talker]: {
            name: chatName,
            kind: chatKind,
            conversationId: convId,
            enabled: true,
            model: null,
            persona: null,
            style: null,
            plugins: null,
            triggerMode: null,
            addedAt: Date.now(),
          },
        },
      };
      await saveConfig(patch);

      // 同步到 WeChatAgent 白名单，否则 reader 根本不会推送这个会话
      let bridge = { added: false };
      try {
        bridge = ensureWhitelisted(chatKind, convId);
        log(`已加入 WeChatAgent 白名单: ${chatKind}/${convId}${bridge.added ? '' : '（已存在）'}`);
      } catch (e) {
        log(`同步 WeChatAgent 白名单失败: ${e.message}`, 'warn');
      }

      log(`新增聊天: ${chatName} (${talker})`);
      sendJson(res, 200, { ok: true, chat: { talker, name: chatName, kind: chatKind, conversationId: convId }, bridge });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  if (p === '/api/chats/remove' && method === 'POST') {
    const { talker, keepAgentWhitelist = true } = await readJsonBody(req);
    const cfg = await loadConfig();
    const chat = cfg.chats?.[talker];
    if (!chat) { sendJson(res, 404, { error: '聊天不存在' }); return; }
    const next = structuredClone(cfg);
    delete next.chats[talker];
    await replaceConfig(next);
    if (!keepAgentWhitelist) {
      try { removeWhitelisted(chat.kind, chat.conversationId); } catch { /* ignore */ }
    }
    log(`移除聊天: ${chat.name || talker}`);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (p === '/api/chats/settings' && method === 'GET') {
    const talker = url.searchParams.get('talker');
    if (!talker) { sendJson(res, 400, { error: '缺少 talker' }); return; }
    const cfg = await loadConfig();
    sendJson(res, 200, { talker, chat: cfg.chats?.[talker] || null, effective: chatSettings(cfg, talker) });
    return;
  }

  if (p === '/api/chats/settings' && method === 'POST') {
    const { talker, patch = {} } = await readJsonBody(req);
    if (!talker) { sendJson(res, 400, { error: '缺少 talker' }); return; }
    const cfg = await loadConfig();
    const current = cfg.chats?.[talker] || { name: talker, kind: 'private', conversationId: '', enabled: true };
    const merged = { ...current, ...patch };
    // 手动改过人设文本后，预设人格标签就失效了，别再显示成「大肥鱼」
    if (patch.persona !== undefined && patch.persona !== current.persona) merged.personaId = null;
    await saveConfig({ chats: { [talker]: merged } });
    log(`更新聊天设置: ${talker}`);
    // 同一聊天室里的其它端跟着改（微信改 → QQ 也改，反之亦然）
    let propagated = 0;
    try { propagated = await propagateSettings(talker); } catch (e) { log(`设置同步失败: ${e.message}`, 'warn'); }
    if (propagated) log(`设置已同步到同聊天室 ${propagated} 项`);
    sendJson(res, 200, { ok: true, chat: merged, propagated });
    return;
  }

  // ── AI ──
  if (p === '/api/ai/providers' && method === 'GET') {
    try { sendJson(res, 200, { providers: await ai.listProviders() }); }
    catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  // ── 一键接入 DeepSeek（填 Key 就能用）──
  // ── QQ 通道（NapCatQQ / OneBot 11）─────────────────────
  // NapCat 的「HTTP 客户端」把事件 POST 到这里
  if (p === '/api/qq/event' && method === 'POST') {
    const cfg = await loadConfig();
    if (!cfg.qq?.enabled) { sendJson(res, 200, { ok: false, reason: 'qq_disabled' }); return; }
    let raw = null;
    try { raw = await readJsonBody(req); } catch (e) { sendJson(res, 400, { error: e.message }); return; }
    const ev = normalizeOneBotEvent(raw);
    if (!ev) { sendJson(res, 200, { ok: true, ignored: true }); return; }
    // 媒体：缓存到本地 + 转成 AI 能理解的文字
    // QQ 的消息段不会进 msg.images/msg.voice，所以这里必须自己把内容补进 ev.content
    const pushLine = (t) => { ev.content = ev.content ? `${ev.content} ${t}` : t; };
    for (const m of ev.qqMedia || []) {
      // 1) 先缓存（控制台能直接看/听），失败不影响识别
      let savedAbs = '';
      if (m.url) {
        try {
          const rel = await cacheQQMedia(m.url, m.type === 'record' ? 'voice-in' : 'image-in');
          if (rel) savedAbs = path.join(MEDIA_DIR, rel);
          recordMedia(ev.sessionId, {
            dir: 'in', kind: m.type === 'record' ? 'voice' : m.type === 'image' ? 'image' : 'file',
            file: rel, ts: ev.timestamp * 1000,
          });
        } catch (e) { log(`QQ 媒体缓存失败: ${e.message}`, 'warn'); }
      }

      // 2) 语音 → 文字
      if (m.type === 'record') {
        if (!m.url) { pushLine('[对方发来一条语音，但没拿到音频地址]'); continue; }
        const vc = voiceConfig(cfg, ev.sessionId);
        if (!vc.asrEnabled || !vc.asrConfigured) {
          log('收到 QQ 语音，但还没配置语音识别模型（去「AI 配置 → 语音」里选一个）', 'warn');
          pushLine('[对方发来一条语音，但内容没能识别出来]');
          continue;
        }
        try {
          const r = await qqVoiceToText(m.url, {
            cfg: cfg.qq, talker: ev.sessionId, transcribe,
            log: (msg, lvl) => log(msg, lvl || 'debug'),
          });
          if (r.text) {
            pushLine(`[语音] ${r.text}`);
            log(`QQ 语音转文字：${r.text.slice(0, 50)}`);
          } else {
            log(`QQ 语音没转出文字：${r.reason || '内容为空或太短'}`, 'warn');
            pushLine('[对方发来一条语音，但内容没能识别出来]');
          }
        } catch (e) {
          log(`QQ 语音转文字失败: ${e.message}`, 'warn');
          pushLine('[对方发来一条语音，但内容没能识别出来]');
        }
        continue;
      }

      // 3) 图片 / 表情包 → 识图模型描述成文字
      if (m.type === 'image') {
        if (!m.url) { pushLine('[对方发来一张图片，但没拿到图片地址]'); continue; }
        try {
          const desc = await qqImageToText(m.url, { config: cfg, talker: ev.sessionId, isSticker: false });
          if (desc) {
            pushLine(`[图片] ${desc}${savedAbs ? `（原图已保存：${savedAbs}，需要换头像等操作时可直接用这个路径）` : ''}`);
            log(`QQ 图片已识别：${desc.slice(0, 50)}`);
          } else {
            pushLine('[对方发来一张图片，但没读出内容]');
          }
        } catch (e) {
          log(`QQ 识图失败: ${e.message}`, 'warn');
          pushLine(`[对方发来一张图片，但没读出来（${String(e.message).slice(0, 40)}）]`);
        }
        continue;
      }

      // 4) 文件 / 视频只给个说明，至少让 AI 知道对方发了东西
      if (m.type === 'file') { pushLine(`[文件] ${m.name || '对方发来一个文件'}`); continue; }
      if (m.type === 'video') { pushLine('[视频] 对方发来一段视频'); continue; }
    }
    qqProactive?.mark(ev.qqTarget);
    try {
      const r = await handleIncoming(ev, { source: 'qq', force: true });
      sendJson(res, 200, { ok: true, result: r });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  // QQ 会话历史：NapCat 实时消息（区分自己/对方）+ 灵枢 AI 回复（去重）
  if (p === '/api/qq/history' && method === 'GET') {
    const target = url.searchParams.get('target') || '';
    const count = Math.min(Number(url.searchParams.get('count')) || 40, 100);
    const cfg = await loadConfig();
    if (!cfg.qq?.enabled) { sendJson(res, 200, { messages: [] }); return; }
    const idx = target.indexOf(':');
    if (idx < 0) { sendJson(res, 400, { error: 'target 格式应为 private:QQ号 或 group:群号' }); return; }
    const kind = target.slice(0, idx);
    const numId = Number(target.slice(idx + 1));
    if (!Number.isFinite(numId)) { sendJson(res, 400, { error: 'target 里的号码不对' }); return; }

    // 先认自己是谁，否则自己发的消息会被当成对方
    let selfId = Number(cfg.qq?.selfUin) || 0;
    if (!selfId) {
      try { const me = await qqLoginInfo(cfg.qq); selfId = Number(me?.user_id) || 0; } catch { /* ignore */ }
    }

    const out = [];
    try {
      const r = await qqApi(kind === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history',
        { [kind === 'group' ? 'group_id' : 'user_id']: numId, count }, cfg.qq);
      for (const m of (r?.messages || [])) {
        const text = (m.message || []).map(x => {
          if (x.type === 'text') return x.data?.text || '';
          if (x.type === 'face') return '[表情]';
          if (x.type === 'image') return '[图片]';
          if (x.type === 'record') return '[语音]';
          if (x.type === 'video') return '[视频]';
          if (x.type === 'file') return '[文件]';
          if (x.type === 'reply') return '[回复]';
          if (x.type === 'at') return '@' + (x.data?.qq || '');
          return '';
        }).join('').trim();
        if (!text) continue;
        const fromSelf = Boolean(selfId) && Number(m.sender?.user_id) === selfId;
        out.push({
          role: fromSelf ? 'assistant' : 'user',
          content: text,
          ts: (Number(m.time) || 0) * 1000,
          sender: fromSelf ? '我' : (m.sender?.card || m.sender?.nickname || String(m.sender?.user_id || '')),
          platform: 'qq',
        });
      }
    } catch (e) {
      log('QQ 历史读取失败: ' + e.message, 'debug');
    }

    // 灵枢这边 AI 的回复（客户端历史里不一定有，且避免与上面重复）
    const seen = new Set(out.map(m => m.role + '|' + m.content));
    try {
      const ctx = new ChatContext('qq:' + target);
      for (const m of ctx.getMessages(count)) {
        if (m.role === 'system' || m.mirrored) continue;
        const role = m.role === 'assistant' ? 'assistant' : 'user';
        const content = String(m.content || '').trim();
        if (!content) continue;
        const key = role + '|' + content;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ role, content, ts: Number(m.ts) || 0, sender: role === 'assistant' ? 'AI' : '', platform: 'ai' });
      }
    } catch { /* ignore */ }

    out.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    sendJson(res, 200, { target, selfId, messages: out.slice(-count) });
    return;
  }

  if (p === '/api/qq/status' && method === 'GET') {
    const cfg = await loadConfig();
    if (!cfg.qq?.enabled) { sendJson(res, 200, { enabled: false, online: false }); return; }
    try {
      const info = await qqLoginInfo(cfg.qq);
      sendJson(res, 200, { enabled: true, online: true, account: info, httpUrl: cfg.qq.httpUrl });
    } catch (e) {
      sendJson(res, 200, { enabled: true, online: false, error: e.message, httpUrl: cfg.qq.httpUrl });
    }
    return;
  }

  if (p === '/api/qq/chats' && method === 'GET') {
    const cfg = await loadConfig();
    if (!cfg.qq?.enabled) { sendJson(res, 200, { chats: [], reason: 'disabled' }); return; }
    try {
      const [friends, groups] = await Promise.all([qqFriendList(cfg.qq), qqGroupList(cfg.qq)]);
      const chats = [
        ...friends.map(f => ({ talker: `qq:private:${f.user_id}`, name: f.nickname || String(f.user_id), kind: 'private', id: f.user_id })),
        ...groups.map(g => ({ talker: `qq:group:${g.group_id}`, name: g.group_name || String(g.group_id), kind: 'group', id: g.group_id })),
      ];
      sendJson(res, 200, { chats });
    } catch (e) {
      // NapCat 没启动 / 还没扫码登录时不要刷 500，控制台会显示提示
      sendJson(res, 200, { chats: [], reason: 'offline', error: e.message });
    }
    return;
  }

  if (p === '/api/qq/config' && method === 'POST') {
    const b = await readJsonBody(req);
    try {
      await saveConfig({ qq: b.qq || b });
      log('QQ 通道配置已更新');
      sendJson(res, 200, { ok: true });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  // 控制台里手动发：text / image / record / face
  if (p === '/api/qq/send' && method === 'POST') {
    const b = await readJsonBody(req);
    const cfg = await loadConfig();
    if (!cfg.qq?.enabled) { sendJson(res, 400, { error: 'QQ 通道未启用' }); return; }
    try {
      let r;
      const target = b.target;
      if (b.type === 'face') r = await sendQQFace(target, b.id, cfg.qq);
      else if (b.type === 'image' && b.audioBase64) r = await sendQQImage(target, Buffer.from(b.audioBase64, 'base64'), cfg.qq);
      else if (b.type === 'record' && b.audioBase64) {
        const buf = Buffer.from(b.audioBase64, 'base64');
        r = await sendQQRecord(target, buf, b.ext || 'wav', cfg.qq);
      } else r = await sendQQText(target, String(b.text || ''), cfg.qq);
      log(`QQ 已发送 → ${target}`);
      sendJson(res, 200, { ok: true, result: r });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  // 试发一条真实语音气泡（本地合成一小段，验证 SILK 链路）
  if (p === '/api/qq/test/voice' && method === 'POST') {
    const b = await readJsonBody(req);
    const cfg = await loadConfig();
    try {
      const tts = await synthesize(String(b.text || '这是一条 QQ 真实语音测试。'), {
        config: cfg, talker: b.talker || null, onLog: (m) => log(m, 'debug'),
      });
      await sendQQRecord(b.target, tts.buffer, tts.ext, cfg.qq);
      log(`QQ 语音气泡测试成功 → ${b.target}`);
      sendJson(res, 200, { ok: true, bytes: tts.buffer.length, ext: tts.ext });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  // ── 语音 ──────────────────────────────────────────────
  if (p === '/api/voice/catalog' && method === 'GET') {
    const cfg = await loadConfig();
    const talker = url.searchParams.get('talker') || null;
    sendJson(res, 200, {
      catalog: VOICE_CATALOG,
      config: talker ? voiceConfig(cfg, talker) : (cfg.voice || {}),
      note: voiceCapabilityNote(),
      emotions: DOUBAO_EMOTIONS,
      providers: Object.entries(cfg.ai.providers || {}).map(([id, p]) => ({ id, name: p.name || id })),
    });
    return;
  }

  if (p === '/api/voice/permission' && method === 'POST') {
    const r = ensureAudioPermission();
    audioPermissionReady = r.ok;
    if (r.ok) log(`语音读取权限已就绪${r.changed ? '（本次已写入 plugins.json）' : ''}`);
    else log(`语音读取权限登记失败：${r.reason}`, 'warn');
    sendJson(res, 200, r);
    return;
  }

  // 一键接入豆包：写提供商 + 切协议 + 默认用「威龙」
  if (p === '/api/voice/doubao/provider' && method === 'POST') {
    const b = await readJsonBody(req);
    const apiKey = String(b.apiKey || '').trim();
    if (!apiKey) { sendJson(res, 400, { error: '请填写豆包 API Key' }); return; }
    const id = 'doubao';
    const baseUrl = String(b.baseUrl || 'https://openspeech.bytedance.com').replace(/\/+$/, '');
    try {
      await saveConfig({ ai: { providers: { [id]: {
        name: '豆包语音',
        baseUrl,
        apiKey,
        models: [],
        voiceOnly: true,           // 只做语音，不进对话模型的降级链
        voiceProtocol: 'doubao',
      } } } });
      await saveConfig({ voice: { enabled: true, tts: {
        enabled: true, providerId: id, protocol: 'doubao', voice: b.voice || 'S_kDqSH3h12', modelId: '', format: 'mp3',
      } } });
      log(`已接入豆包语音：${baseUrl}`);
      sendJson(res, 200, { ok: true, providerId: id, baseUrl });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  // ── 豆包：音色库 / 复刻 ─────────────────────────────────
  if (p === '/api/voice/doubao/speakers' && method === 'GET') {
    sendJson(res, 200, listSpeakers());   // { official, cloned, all }
    return;
  }

  if (p === '/api/voice/doubao/speakers' && method === 'POST') {
    const b = await readJsonBody(req);
    try {
      const item = addSpeaker({ id: b.id, name: b.name, kind: b.kind || 'clone' });
      log(`音色库新增：${item.name} (${item.id})`);
      sendJson(res, 200, { ok: true, speaker: item });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  if (p === '/api/voice/doubao/speakers' && method === 'DELETE') {
    try {
      const r = removeSpeaker(url.searchParams.get('id'));
      log(`音色库删除：${url.searchParams.get('id')}`);
      sendJson(res, 200, r);
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  // 上传参考音频做复刻（异步训练，可能等 1~2 分钟）
  if (p === '/api/voice/doubao/clone' && method === 'POST') {
    const b = await readJsonBody(req);
    try {
      const audio = b.audioBase64 ? Buffer.from(String(b.audioBase64), 'base64') : null;
      const r = await cloneDoubaoVoice({
        name: String(b.name || '').trim(),
        text: String(b.text || b.promptText || '').trim(),
        audio,
        filename: String(b.filename || 'ref.wav'),
        providerId: b.providerId || null,
        onLog: (m, lvl) => log(m, lvl || 'info'),
      });
      log(`豆包复刻完成：${r.name} (${r.speakerId})`);
      sendJson(res, 200, r);
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  if (p === '/api/voice/doubao/clone-status' && method === 'GET') {
    try {
      const d = await doubaoCloneStatus(url.searchParams.get('id'), { providerId: url.searchParams.get('providerId') || null });
      sendJson(res, 200, d);
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  // ── 聊天室（多端共享设置/历史/记忆）──────────────
  // ── 聊天池（两个会话共用一套设置/记忆/历史）─────────
  if (p === '/api/sync/pools' && method === 'GET') {
    const cfg = await loadConfig();
    const pools = listRooms().map(r => ({
      ...r,
      members: r.members.map(m => ({
        ...m,
        name: cfg.chats?.[m.talker]?.name || m.name || m.talker,
      })),
    }));
    sendJson(res, 200, { pools });
    return;
  }
  if (p === '/api/sync/pools' && method === 'POST') {
    const b = await readJsonBody(req);
    try {
      const r = await createPool({
        a: b.a, b: b.b, direction: b.direction || 'a2b',
        wipe: b.wipe !== false, name: b.name || '', parts: b.parts || null,
      });
      const w = r.stats.wiped;
      log(`聊天池已建立：${r.room.name}（${b.direction}）`
        + `${w ? `，清空目标 ${w.msgs} 条消息/${w.mems} 条记忆` : ''}`
        + `，复制 ${r.stats.msgs} 条历史、${r.stats.mems} 条记忆、${r.stats.settings} 项设置`);
      sendJson(res, 200, { ok: true, ...r });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }
  if (p === '/api/sync/pools' && method === 'DELETE') {
    try { sendJson(res, 200, deleteRoom(url.searchParams.get('id'))); }
    catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }
  if (p === '/api/sync/pools/sync' && method === 'POST') {
    const b = await readJsonBody(req);
    try {
      const r = b.id ? await syncRoom(b.id) : await syncAllRooms();
      log(`聊天池重新同步：${JSON.stringify(r)}`);
      sendJson(res, 200, { ok: true, ...r });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  if (p === '/api/qq/rooms' && method === 'GET') {
    sendJson(res, 200, { rooms: listRooms() }); return;
  }
  if (p === '/api/qq/rooms' && method === 'POST') {
    const b = await readJsonBody(req);
    try {
      const room = createRoom({ name: b.name, members: b.members || [], sync: b.sync, parts: b.parts });
      log(`创建聊天室：${room.name}（${room.members.length} 个成员）`);
      const r = await syncRoom(room.id);
      sendJson(res, 200, { ok: true, room, synced: r });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }
  if (p === '/api/qq/rooms' && method === 'PATCH') {
    const b = await readJsonBody(req);
    try {
      const room = updateRoom(b.id, { name: b.name, sync: b.sync, parts: b.parts });
      sendJson(res, 200, { ok: true, room });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }
  if (p === '/api/qq/rooms' && method === 'DELETE') {
    try { sendJson(res, 200, deleteRoom(url.searchParams.get('id'))); }
    catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }
  if (p === '/api/qq/rooms/member' && method === 'POST') {
    const b = await readJsonBody(req);
    try {
      const room = b.remove ? removeRoomMember(b.id, b.talker) : addRoomMember(b.id, b);
      if (b.resync) await syncRoom(b.id);
      sendJson(res, 200, { ok: true, room });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }
  if (p === '/api/qq/rooms/sync' && method === 'POST') {
    const b = await readJsonBody(req);
    try {
      const r = b.id ? await syncRoom(b.id) : await syncAllRooms();
      log(`聊天室同步：${JSON.stringify(r)}`);
      sendJson(res, 200, { ok: true, ...r });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  // ── QQ 扩展：记忆同步 / 定时发送 / 通用动作 ──────────────
  if (p === '/api/qq/memory-links' && method === 'GET') {
    sendJson(res, 200, { links: listMemoryLinks() }); return;
  }
  if (p === '/api/qq/memory-links' && method === 'POST') {
    const b = await readJsonBody(req);
    try {
      const item = addMemoryLink({
        wxTalker: b.wxTalker, qqTarget: b.qqTarget,
        bidirectional: b.bidirectional !== false,
        direction: b.direction || null,
        parts: b.parts || null,
      });
      log(`会话镜像已绑定：${item.wxTalker} ↔ ${item.qqTarget}（${item.direction}）`);
      sendJson(res, 200, { ok: true, link: item });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }
  if (p === '/api/qq/memory-links' && method === 'PATCH') {
    const b = await readJsonBody(req);
    try {
      const item = updateMemoryLink(b.id, { direction: b.direction, parts: b.parts });
      sendJson(res, 200, { ok: true, link: item });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }
  if (p === '/api/qq/memory-links' && method === 'DELETE') {
    try {
      const r = removeMemoryLink(url.searchParams.get('id'));
      sendJson(res, 200, r);
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }
  if (p === '/api/qq/memory-sync' && method === 'POST') {
    try {
      const r = await syncAllMemory();
      log(`会话同步完成：${r.links} 对，记忆/历史 ${r.moved} 条，设置 ${r.settings} 项`);
      sendJson(res, 200, { ok: true, ...r });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  // 手动触发一轮主动消息（调试用，会真的发出去）
  if (p === '/api/qq/proactive/tick' && method === 'POST') {
    try {
      if (!qqProactive) { sendJson(res, 400, { error: '主动消息引擎未启动' }); return; }
      const cfg = await loadConfig();
      const pr = cfg.qq?.proactive;
      if (!pr?.enabled) { sendJson(res, 200, { sent: 0, reason: '主动消息未开启' }); return; }
      if (!(pr.targets || []).length) { sendJson(res, 200, { sent: 0, reason: '还没有设置目标会话' }); return; }
      await qqProactive.tick();
      sendJson(res, 200, { sent: 0, reason: '已执行一轮，若未发送说明不在时段或已达上限' });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  if (p === '/api/qq/schedules' && method === 'GET') {
    sendJson(res, 200, { schedules: listSchedules() }); return;
  }
  if (p === '/api/qq/schedules' && method === 'POST') {
    const b = await readJsonBody(req);
    try {
      const item = addSchedule(b);
      log(`新增 QQ 定时消息 → ${item.target}`);
      sendJson(res, 200, { ok: true, schedule: item });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }
  if (p === '/api/qq/schedules' && method === 'DELETE') {
    try { sendJson(res, 200, removeSchedule(url.searchParams.get('id'))); }
    catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }
  if (p === '/api/qq/schedules/toggle' && method === 'POST') {
    const b = await readJsonBody(req);
    try { sendJson(res, 200, { ok: true, schedule: toggleSchedule(b.id, b.enabled) }); }
    catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  // 通用 OneBot 动作：把 NapCat 的能力直接透给 AI / 控制台
  if (p === '/api/qq/actions' && method === 'GET') {
    sendJson(res, 200, { actions: QQ_EXTENDED_ACTIONS }); return;
  }
  if (p === '/api/qq/action' && method === 'POST') {
    const b = await readJsonBody(req);
    const cfg = await loadConfig();
    if (!cfg.qq?.enabled) { sendJson(res, 400, { error: 'QQ 通道未启用' }); return; }
    if (!b.action || !/^[a-z_][a-z0-9_]*$/i.test(String(b.action))) {
      sendJson(res, 400, { error: '动作名不合法' }); return;
    }
    try {
      const r = await qqApi(String(b.action), b.params || {}, cfg.qq);
      log(`QQ 动作 ${b.action} 执行成功`);
      sendJson(res, 200, { ok: true, result: r });
    } catch (e) { sendJson(res, 200, { ok: false, error: e.message }); }
    return;
  }

  // 试听：用当前 TTS 配置合成一段，返回 base64 给浏览器直接播
  if (p === '/api/voice/tts' && method === 'POST') {
    const body = await readJsonBody(req);
    const text = String(body.text || '你好，我是灵枢，这是一段语音测试。').slice(0, 300);
    try {
      const tts = await synthesize(text, {
        talker: body.talker || null,
        providerId: body.providerId || null,
        modelId: body.modelId || null,
        voice: body.voice || null,
        emotion: body.emotion || null,
        emotionScale: body.emotionScale ?? null,
        speed: body.speed ?? null,
        onLog: (m) => log(m, 'debug'),
      });
      const info = wavInfo(tts.buffer);
      sendJson(res, 200, {
        ok: true,
        voice: tts.voice,
        provider: tts.provider,
        model: tts.model,
        bytes: tts.buffer.length,
        durationSeconds: info?.durationSeconds || null,
        audio: tts.buffer.toString('base64'),
        mime: 'audio/wav',
      });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return;
  }

  if (p === '/api/ai/quick' && method === 'POST') {
    const body = await readJsonBody(req);
    const apiKey = String(body.apiKey || '').trim();
    const providerId = String(body.providerId || 'deepseek');
    if (!apiKey) { sendJson(res, 400, { error: '请填写 API Key' }); return; }

    const PRESETS = {
      deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', prefer: 'flash' },
    };
    const preset = PRESETS[providerId] || PRESETS.deepseek;

    try {
      // 1) 写入提供商
      await saveConfig({ ai: { providers: { [providerId]: {
        name: preset.name,
        baseUrl: preset.baseUrl,
        apiKey,
        models: [],
      } } } });

      // 2) 拉模型列表（拉不到就用兜底清单）
      let models = [];
      let refreshError = '';
      try {
        models = await refreshProviderModels(providerId);
      } catch (e) {
        refreshError = e.message;
        log(`快速接入：拉取模型列表失败（${e.message}），使用兜底清单`, 'warn');
        models = [
          { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', multimodal: true, imageGen: false },
          { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', multimodal: false, imageGen: false },
        ];
        await saveConfig({ ai: { providers: { [providerId]: { models } } } });
      }

      // 3) 优先选支持识图的 flash 模型
      const preferRe = new RegExp(preset.prefer, 'i');
      const pick = models.find(m => preferRe.test(m.id) && m.multimodal)
        || models.find(m => m.multimodal)
        || models.find(m => preferRe.test(m.id))
        || models[0];
      const visionPick = models.find(m => m.multimodal) || pick;

      // 4) 设为默认 + 识图模型
      await saveConfig({ ai: {
        defaultProvider: providerId,
        defaultModel: pick.id,
        vision: { providerId, modelId: visionPick.id },
      } });

      // 4.5) 语音：DeepSeek 的 ASR/TTS 是独立端点，模型名不用填
      let voiceReady = false;
      if (providerId === 'deepseek') {
        await saveConfig({ voice: {
          enabled: true,
          asr: { enabled: true, providerId, modelId: '', protocol: 'deepseek' },
          tts: { enabled: true, providerId, modelId: '', protocol: 'deepseek', voice: 'stella', format: 'wav' },
        } });
        voiceReady = true;
      }

      // 5) 顺手测一下
      let test = null;
      try {
        const r = await ai.chat([
          { role: 'system', content: '只回答两个字' },
          { role: 'user', content: '说：正常' },
        ], { providerId, modelOverride: pick.id, maxTokens: 60 });
        test = { ok: true, reply: (r.content || '').trim().slice(0, 20) };
      } catch (e) {
        test = { ok: false, error: e.message.slice(0, 160) };
      }

      log(`快速接入 ${preset.name}：默认 ${pick.id}，识图 ${visionPick.id}${test.ok ? '，连通正常' : '，测试失败'}`);
      sendJson(res, 200, {
        ok: true,
        providerId,
        provider: preset.name,
        model: pick.id,
        visionModel: visionPick.id,
        models,
        refreshError: refreshError || undefined,
        voiceReady,
        test,
      });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return;
  }

  if (p === '/api/ai/models' && method === 'GET') {
    const provider = url.searchParams.get('provider');
    sendJson(res, 200, { models: await ai.listModels(provider) });
    return;
  }

  if (p === '/api/ai/test' && method === 'POST') {
    const { providerId, model, prompt } = await readJsonBody(req);
    try {
      const r = await ai.chat([
        { role: 'system', content: '你是测试助手，用中文一句话回答。' },
        { role: 'user', content: prompt || '你好' },
      ], { providerId, modelOverride: model, maxTokens: 200 });
      sendJson(res, 200, { ok: true, ...r });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  if (p === '/api/ai/models/refresh' && method === 'POST') {
    const { providerId } = await readJsonBody(req);
    try {
      const models = await refreshProviderModels(providerId);
      log(`已刷新 ${providerId} 模型列表（${models.length} 个）`);
      sendJson(res, 200, { ok: true, models });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  if (p === '/api/ai/providers/delete' && method === 'POST') {
    const { providerId } = await readJsonBody(req);
    const cfg = await loadConfig();
    if (!cfg.ai.providers?.[providerId]) { sendJson(res, 404, { error: '提供商不存在' }); return; }
    const next = structuredClone(cfg);
    delete next.ai.providers[providerId];
    if (next.ai.defaultProvider === providerId) next.ai.defaultProvider = Object.keys(next.ai.providers)[0] || '';
    await replaceConfig(next);
    log(`已删除提供商: ${providerId}`);
    sendJson(res, 200, { ok: true });
    return;
  }

  // ── 工具 / 插件 ──
  if (p === '/api/tools' && method === 'GET') {
    sendJson(res, 200, { tools: getToolList() });
    return;
  }

  if (p === '/api/tools/call' && method === 'POST') {
    const { pluginId, toolName, args = {}, talker } = await readJsonBody(req);
    try {
      const result = toolName
        ? await callPluginTool(pluginId, toolName, args, { talker })
        : await callToolByName(pluginId, args, { talker });
      sendJson(res, 200, { ok: true, result });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  if (p === '/api/plugins' && method === 'GET') {
    sendJson(res, 200, { plugins: listAllPluginManifests() });
    return;
  }

  if (p === '/api/plugins/scaffold' && method === 'POST') {
    const { id, name, description } = await readJsonBody(req);
    try {
      const r = await scaffoldPlugin(String(id || '').trim(), name, description);
      sendJson(res, 200, { ok: true, ...r });
    } catch (e) { sendJson(res, 400, { error: e.message }); }
    return;
  }

  if (p === '/api/plugins/delete' && method === 'POST') {
    const { id } = await readJsonBody(req);
    try {
      const ok = await deletePlugin(id);
      sendJson(res, 200, { ok });
    } catch (e) { sendJson(res, 400, { error: e.message }); }
    return;
  }

  if (p === '/api/plugins/reload' && method === 'POST') {
    try {
      const tools = await reloadPlugins((m, lvl) => log(m, lvl || 'info'));
      sendJson(res, 200, { ok: true, tools });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  if (p === '/api/plugins/code' && method === 'GET') {
    const id = url.searchParams.get('id');
    const r = await readPluginCode(id);
    if (!r) { sendJson(res, 404, { error: '未找到插件代码' }); return; }
    sendJson(res, 200, { code: r.code, builtin: Boolean(r.builtin), path: r.path });
    return;
  }

  if (p === '/api/plugins/code' && method === 'PUT') {
    const id = url.searchParams.get('id');
    const code = await readBody(req);
    try {
      await writePluginCode(id, code);
      sendJson(res, 200, { ok: true });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  // ── 预设人格 ──
  if (p === '/api/personas' && method === 'GET') {
    sendJson(res, 200, { personas: await listPersonasBrief() });
    return;
  }

  if (p === '/api/personas/get' && method === 'GET') {
    const id = url.searchParams.get('id');
    const persona = await getPersona(id);
    if (!persona) { sendJson(res, 404, { error: '人格不存在' }); return; }
    sendJson(res, 200, { persona });
    return;
  }

  if (p === '/api/personas/apply' && method === 'POST') {
    const { id, talker } = await readJsonBody(req);
    const persona = await getPersona(id);
    if (!persona) { sendJson(res, 404, { error: '人格不存在' }); return; }
    try {
      if (talker) {
        await saveConfig({ chats: { [talker]: {
          persona: persona.prompt,
          style: persona.style || null,
          personaId: persona.id,
        } } });
        log(`聊天 ${talker} 套用预设人格：${persona.name}`);
      } else {
        await saveConfig({ persona: { default: persona.prompt } });
        log(`全局人格切换为：${persona.name}`);
      }
      sendJson(res, 200, { ok: true, scope: talker ? 'chat' : 'global', persona: { id: persona.id, name: persona.name } });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  // ── 上下文 ──
  if (p === '/api/context/clear' && method === 'POST') {
    const { talker, keepSummary = false } = await readJsonBody(req);
    if (talker) {
      const ctx = new ChatContext(talker);
      const summary = keepSummary ? ctx.getSummary() : '';
      ctx.clear();
      if (summary) ctx.setSummary(summary);
      log(`已清空上下文: ${talker}`);
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (p === '/api/context/usage' && method === 'GET') {
    const talker = url.searchParams.get('talker');
    if (!talker) { sendJson(res, 400, { error: '缺少 talker' }); return; }
    const cfg = await loadConfig();
    const merged = { ...cfg, context: { ...cfg.context, ...(cfg.chats?.[talker]?.context || {}) } };
    sendJson(res, 200, { usage: contextUsage(talker, merged), memory: memoryConfig(cfg, talker) });
    return;
  }

  // 手动改写滚动摘要（后台「看摘要」里编辑后保存）
  if (p === '/api/context/summary' && method === 'PUT') {
    const { talker, summary } = await readJsonBody(req);
    if (!talker) { sendJson(res, 400, { error: '缺少 talker' }); return; }
    const ctx = new ChatContext(talker);
    ctx.setSummary(String(summary || ''));
    log(`已更新上下文摘要: ${talker}`);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (p === '/api/context/compress' && method === 'POST') {
    const { talker, force = true } = await readJsonBody(req);
    if (!talker) { sendJson(res, 400, { error: '缺少 talker' }); return; }
    try {
      const cfg = await loadConfig();
      const r = await compressContext(talker, {
        aiClient: ai,
        config: { ...cfg, context: { ...cfg.context, ...(cfg.chats?.[talker]?.context || {}) } },
        force,
      });
      if (r.summary) log(`手动压缩 ${talker}：${r.compressed} 条 → 摘要（${r.beforeTokens}→${r.afterTokens} tokens）`);
      sendJson(res, 200, { ok: true, ...r });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  // ── 记忆 ──
  if (p === '/api/memory' && method === 'GET') {
    const cfg = await loadConfig();
    sendJson(res, 200, { stats: memoryStats(cfg), labels: MEMORY_LABELS });
    return;
  }

  if (p === '/api/memory/detail' && method === 'GET') {
    const talker = url.searchParams.get('talker');
    if (!talker) { sendJson(res, 400, { error: '缺少 talker' }); return; }
    const cfg = await loadConfig();
    const merged = { ...cfg, context: { ...cfg.context, ...(cfg.chats?.[talker]?.context || {}) } };
    sendJson(res, 200, {
      detail: getScopeDetail(talker, { cfg }),
      config: memoryConfig(cfg, talker),
      labels: MEMORY_LABELS,
      usage: contextUsage(talker, merged),
    });
    return;
  }

  if (p === '/api/memory/dedupe' && method === 'POST') {
    const { talker, dryRun = false } = await readJsonBody(req);
    if (!talker) { sendJson(res, 400, { error: '缺少 talker' }); return; }
    const r = dedupeScope(talker, { dryRun });
    const memberCut = Object.values(r.members || {}).reduce((n, x) => n + x, 0);
    log(`整理重复记忆${dryRun ? '（预演）' : ''} ${talker}：会话 -${r.chat}，成员 -${memberCut}`);
    sendJson(res, 200, { ok: true, ...r, memberCut });
    return;
  }

  if (p === '/api/memory/clear' && method === 'POST') {
    const { talker } = await readJsonBody(req);
    if (!talker) { sendJson(res, 400, { error: '缺少 talker' }); return; }
    const n = clearScope(talker);
    log(`清空记忆 ${talker}：${n} 条已归档`);
    sendJson(res, 200, { ok: true, archived: n });
    return;
  }

  if (p === '/api/memory/archive' && method === 'GET') {
    const talker = url.searchParams.get('talker');
    if (!talker) { sendJson(res, 400, { error: '缺少 talker' }); return; }
    sendJson(res, 200, { items: getArchive(talker) });
    return;
  }

  if (p === '/api/memory/add' && method === 'POST') {
    const { talker, memberKey = null, memberName = '', text, importance = 0.7, kind = 'fact', tags = [] } = await readJsonBody(req);
    if (!talker || !text) { sendJson(res, 400, { error: '缺少 talker 或 text' }); return; }
    try {
      const added = addMemories(talker, [{ text, importance, kind, tags, source: 'manual' }], {
        memberKey, memberName,
      });
      log(`手动新增记忆 → ${talker}${memberKey ? '/' + memberName : ''}: ${String(text).slice(0, 30)}`);
      sendJson(res, 200, { ok: true, added });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  if (p === '/api/memory/update' && method === 'POST') {
    const { talker, id, patch = {}, memberKey = null } = await readJsonBody(req);
    const updated = updateMemory(talker, id, patch, { memberKey });
    if (!updated) { sendJson(res, 404, { error: '记忆不存在' }); return; }
    sendJson(res, 200, { ok: true, memory: updated });
    return;
  }

  if (p === '/api/memory/delete' && method === 'POST') {
    const { talker, id, memberKey = null } = await readJsonBody(req);
    const ok = deleteMemory(talker, id, { memberKey });
    if (ok) log(`删除记忆 ${talker}/${id.slice(0, 8)}（已归档）`);
    sendJson(res, 200, { ok });
    return;
  }

  if (p === '/api/memory/restore' && method === 'POST') {
    const { talker, id } = await readJsonBody(req);
    sendJson(res, 200, { ok: restoreFromArchive(talker, id) });
    return;
  }

  if (p === '/api/memory/forget' && method === 'POST') {
    const { talker, dryRun = false } = await readJsonBody(req);
    try {
      const cfg = await loadConfig();
      const r = runForgetting({ talker: talker || null, dryRun, cfg });
      log(`遗忘扫描${dryRun ? '（预演）' : ''}：扫描 ${r.scanned} 条，遗忘 ${r.forgotten.length} 条，保留 ${r.kept} 条`);
      sendJson(res, 200, { ok: true, ...r });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  if (p === '/api/memory/compact' && method === 'POST') {
    const { talker } = await readJsonBody(req);
    if (!talker) { sendJson(res, 400, { error: '缺少 talker' }); return; }
    try {
      const cfg = await loadConfig();
      const r = await compactScope(talker, { aiClient: ai, cfg, force: true });
      log(`记忆压缩 ${talker}：合并 ${r.merged} 条`);
      sendJson(res, 200, { ok: true, ...r });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  if (p === '/api/memory/profile' && method === 'POST') {
    const { talker, memberKey } = await readJsonBody(req);
    try {
      const cfg = await loadConfig();
      const r = await rebuildProfile(talker, memberKey, { aiClient: ai, cfg });
      if (r) log(`重建成员画像：${r.name}`);
      sendJson(res, 200, { ok: Boolean(r), profile: r });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  if (p === '/api/memory/search' && method === 'POST') {
    const { talker, query = '', memberKey = null, limit = 20 } = await readJsonBody(req);
    try {
      const cfg = await loadConfig();
      const items = searchMemories(talker, { query, memberKey, limit, cfg });
      sendJson(res, 200, { items });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  if (p === '/api/memory/sweep' && method === 'POST') {
    try {
      const cfg = await loadConfig();
      const r = await sweepAll({ aiClient: ai, cfg });
      log(`记忆巡检：遗忘 ${r.forget.forgotten.length} 条，压缩 ${r.compact.length} 个会话`);
      sendJson(res, 200, { ok: true, ...r });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  // ── 日志 ──
  if (p === '/api/logs' && method === 'GET') {
    const limit = Math.min(500, parseInt(url.searchParams.get('limit') || '100', 10));
    sendJson(res, 200, { logs: logs.slice(-limit) });
    return;
  }

  if (p === '/api/logs/stream' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    for (const e of logs.slice(-50)) res.write(`data: ${JSON.stringify(e)}\n\n`);
    const listener = (entry) => { try { res.write(`data: ${JSON.stringify(entry)}\n\n`); } catch { /* ignore */ } };
    logListeners.add(listener);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 20000);
    req.on('close', () => { clearInterval(ping); logListeners.delete(listener); });
    return;
  }

  // ── 调试入口 ──
  if (p === '/api/debug/send' && method === 'POST') {
    const b = await readJsonBody(req);
    const talker = b.talker;
    if (!talker) { sendJson(res, 400, { error: '缺少 talker' }); return; }
    const convId = String(b.conversationId || '');
    const kind = b.kind || (String(talker).includes('@chatroom') ? 'group' : 'private');
    // 群聊里 talkerId 是「说话人」，sessionId 才是群 id。之前一律填成 talker，
    // 导致群里模拟进来的消息发言人被当成群本身。
    const senderWxid = String(b.senderWxid || '') || (kind === 'group' ? `fake_${Date.now()}` : talker);
    const fake = {
      event: 'message.new',
      sessionId: talker,
      sessionType: kind,
      conversationId: convId,
      senderName: b.senderName || (kind === 'group' ? '群成员' : talker),
      talkerId: senderWxid,
      content: b.text || '',
      type: 1,
      timestamp: Math.floor(Date.now() / 1000),
      rawid: `debug-${Date.now()}`,
      // 关键：qq: 开头的会话必须标成 QQ，否则语音/图片会走微信发送通道，静默失败
      platform: b.platform || (String(talker).startsWith('qq:') ? 'qq' : 'wechat'),
      qqTarget: String(talker).startsWith('qq:') ? String(talker).slice(3) : '',
    };
    try {
      const r = await handleIncoming(fake, { source: 'debug', force: b.force === true });
      sendJson(res, 200, { ok: true, result: r });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  if (p === '/api/debug/raw' && method === 'POST') {
    const payload = await readJsonBody(req);
    try {
      const r = await handleIncoming(payload, { source: 'raw' });
      sendJson(res, 200, { ok: true, result: r });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  // ── 重新连接微信 ──
  if (p === '/api/wechat/reconnect' && method === 'POST') {
    try {
      stopListening();
      await new Promise(r => setTimeout(r, 600));
      await initDrivers();
      await startListening(onSseEvent, sseHooks);
      log('微信连接已重建');
      sendJson(res, 200, { ok: true, state: getState() });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  // ── 媒体文件 ──
  if (p.startsWith('/media/')) { await serveMedia(res, p); return; }

  // ── 静态资源 ──
  await serveStatic(res, p);
}

function countContexts() {
  try { return fs.readdirSync(path.join(DATA_DIR, 'contexts')).filter(f => f.endsWith('.json')).length; }
  catch { return 0; }
}

// ── SSE 事件入口（带原始日志，方便排查）──────────────────
let _rawLogCount = 0;
function onSseEvent(payload) {
  if (payload?.event && payload.event !== 'message.new') return;
  handleIncoming(payload, { source: 'sse' }).catch(e => log(`处理消息异常: ${e.message}`, 'error'));
}

const sseHooks = {
  onStatus: (s) => {
    if (s.connected) log('SSE 已连接，开始接收微信消息');
    else log(`SSE 断开（${s.error || '未知'}），2 秒后重连…`, 'warn');
  },
  onRaw: (raw) => {
    _rawLogCount++;
    if (_rawLogCount <= 20) log(`SSE 原始事件: ${raw.slice(0, 400)}`, 'debug');
  },
};

// ── 启动 ──────────────────────────────────────────────────
const server = createServer((req, res) => {
  route(req, res).catch(e => {
    log(`路由异常 ${req.url}: ${e.message}`, 'error');
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
    else res.end();
  });
});
// 语音合成 + 复刻训练可能要几分钟，别让 Node 默认的 5 分钟把请求掐掉
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 75000;

async function main() {
  loadDataDir();
  log('灵枢 AI 中枢 v0.4 启动中…');

  const cfg = await loadConfig();
  setConfigSnapshot(cfg);

  // 清掉上次遗留的合成音频（超过 1 小时的）
  try {
    const n = cleanupAudio(3600000);
    if (n) log(`已清理 ${n} 个过期语音文件`, 'debug');
  } catch { /* ignore */ }
  try {
    const n = pruneCache(14 * 86400000);
    if (n) log(`已清理 ${n} 个过期媒体缓存`, 'debug');
  } catch { /* ignore */ }

  // QQ 主动消息引擎（没人的时候自己打招呼）
  qqProactive = createProactiveEngine({
    cfgProvider: loadConfig,
    sender: async (target, line) => sendQQText(target, line, (await loadConfig()).qq),
    log: (m, lvl) => log(m, lvl || 'info'),
    // 让 AI 按记忆和当前时间生成一句自然的开场白；失败会回退到预设句
    aiLine: async (target) => {
      const cfg = await loadConfig();
      const hour = new Date().getHours();
      const part = hour < 6 ? '凌晨' : hour < 11 ? '上午' : hour < 14 ? '中午' : hour < 18 ? '下午' : hour < 22 ? '晚上' : '深夜';
      // 把最近几轮对话带上，否则主动消息会和刚才聊的完全不相干
      let recent = '';
      try {
        const talker = target ? (String(target).startsWith('qq:') ? target : `qq:${target}`) : '';
        if (talker) {
          const ctx = new ChatContext(talker);
          recent = (ctx.getMessages(6) || [])
            .filter(m => m.role !== 'system' && String(m.content || '').trim())
            .map(m => `${m.role === 'assistant' ? '我' : '对方'}：${String(m.content).replace(/^\[语音[^\]]*\]\s*/, '').slice(0, 60)}`)
            .join('\n');
        }
      } catch { /* ignore */ }
      const r = await ai.chat([
        {
          role: 'system',
          content: '你在用 QQ 给一个朋友主动发消息（对方暂时没说话）。要求：'
            + '1) 一到两句完整的话，10~30 个字；'
            + '2) 口语、随意，像真人闲着没事戳一下对方；'
            + '3) 如果是接着之前的聊天，要自然接上那个话题，别突然换话题；'
            + '4) 不要像客服（禁止"有什么可以帮你"）；不要自称 AI；不要解释；'
            + '5) 只输出要发的那一句话本身。',
        },
        {
          role: 'user',
          content: recent
            ? `现在是${part}。这是你们刚才聊的内容：\n${recent}\n\n顺着这个话题，发一句自然的话。`
            : `现在是${part}。随便发一句自然的话。`,
        },
      ], { temperature: 1.0, maxTokens: 400, onLog: null });
      const txt = String(r?.content || '').trim();
      if (!txt) log(`主动消息 AI 返回空（provider=${r?.provider || '?'} model=${r?.model || '?'} finish=${r?.finishReason || '?'}）`, 'debug');
      return txt;
    },
  });
  qqProactive.start(60000);

  // QQ 定时消息：每分钟检查一次到点的条目
  const scheduleTicker = setInterval(async () => {
    try {
      const cfg = await loadConfig();
      if (!cfg.qq?.enabled) return;
      for (const s of dueSchedules()) {
        try {
          await sendQQText(s.target, s.text, cfg.qq);
          log(`QQ 定时消息已发 → ${s.target}：${s.text.slice(0, 30)}`);
        } catch (e) { log(`QQ 定时消息失败: ${e.message}`, 'warn'); }
      }
    } catch (e) { log(`定时检查异常: ${e.message}`, 'warn'); }
  }, 60000);
  scheduleTicker.unref?.();

  // 首次启动：把 wechatagent.json 里已授权的账号昵称同步过来，用于群聊 @ 判定
  try {
    const agent = getAgentWhitelist();
    if (agent.nicknames?.length && !cfg.wechat.botNames?.length) {
      await saveConfig({ wechat: { botNames: agent.nicknames } });
      log(`已同步机器人昵称: ${agent.nicknames.join(', ')}`);
    }
    if (agent.workspace) log(`WeChatAgent 工作区: ${agent.workspace}`);
    else log('未找到 WeChatAgent 工作区，白名单同步功能不可用', 'warn');
  } catch (e) { log(`同步 WeChatAgent 配置失败: ${e.message}`, 'warn'); }

  try {
    await initDrivers();
    log(`微信已连接 ownWxid=${getState().ownWxid}`);
  } catch (e) {
    log(`微信初始化失败: ${e.message}`, 'error');
  }

  try {
    await initPlugins({ sendText, sendImageFile, getReader, getSessions }, ai, (m, lvl) => log(m, lvl));
    log(`插件就绪，共 ${getToolList().length} 个工具`);
  } catch (e) { log(`插件初始化失败: ${e.message}`, 'warn'); }

  if (getState().connected) {
    try {
      await startListening(onSseEvent, sseHooks);
      log('已订阅微信消息推送（SSE）');
    } catch (e) { log(`订阅失败: ${e.message}`, 'error'); }
  }

  const cfg2 = await loadConfig();
  server.listen(cfg2.app.port, cfg2.app.bind, () => {
    console.log(`
╔═══════════════════════════════════════════════╗
║        灵枢 AI 中枢  LingShu Hub v0.4         ║
║                                               ║
║  控制台: http://127.0.0.1:${String(cfg2.app.port).padEnd(5)}                  ║
║  微信:   ${getState().connected ? '✅ 已连接' : '❌ 未连接'}                        ║
║  Hook:   ${getState().hookConnected ? '✅ 可发送' : '❌ 不可用'}                        ║
╚═══════════════════════════════════════════════╝
`);
  });

  // 定时任务：刷新 reader 状态 + 清理过期临时图片
  setInterval(() => {
    refreshReaderStatus().then(s => {
      if (s && s.lastError) log(`Reader 轮询异常: ${s.lastError}`, 'warn');
    }).catch(() => {});
  }, 60000);

  setInterval(cleanupPendingSend, 30 * 60 * 1000);

  // 记忆巡检：按遗忘曲线清理 + 超额压缩
  const sweepMinutes = Math.max(5, cfg2.memory?.sweepIntervalMinutes || 30);
  setInterval(async () => {
    try {
      const c = await loadConfig();
      if (c.memory?.enabled === false) return;
      const r = await sweepAll({ aiClient: ai, cfg: c });
      if (r.forget.forgotten.length || r.compact.length) {
        log(`记忆巡检：遗忘 ${r.forget.forgotten.length} 条，压缩 ${r.compact.length} 个会话`);
      }
    } catch (e) { log(`记忆巡检失败: ${e.message}`, 'warn'); }
  }, sweepMinutes * 60 * 1000);

  const shutdown = () => {
    log('正在关闭…');
    stopListening();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function cleanupPendingSend() {
  const dir = path.join(MEDIA_DIR, 'pending-send');
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      const st = fs.statSync(fp);
      if (now - st.mtimeMs > 24 * 3600 * 1000) fs.unlinkSync(fp);
    }
  } catch { /* ignore */ }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
