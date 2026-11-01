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
  encryptSecret, ROOT_DIR,
} from './config.mjs';
import {
  initDrivers, getReader, getHook, getState, sendText, sendImageFile,
  startListening, stopListening, getSessions, getChatHistory, searchChats,
  refreshReaderStatus, bumpReceived, bumpSkipped,
} from './wechat.mjs';
import { getAgentWhitelist, ensureWhitelisted, removeWhitelisted } from './agent-bridge.mjs';
import { ai, setConfigSnapshot, endpoint, friendlyAIError } from './ai.mjs';
import { router, ChatContext } from './router.mjs';
import {
  memoryConfig, buildMemoryPrompt, observeTurn, sweepAll, runForgetting, compactScope,
  listScopes, getScopeDetail, memoryStats, updateMemory, deleteMemory, clearScope,
  getArchive, restoreFromArchive, rebuildProfile, addMemories, searchMemories, dedupeScope,
  MEMORY_LABELS,
} from './memory.mjs';
import { compressContext, contextUsage } from './compressor.mjs';
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

// ── 每聊天的有效设置 ──────────────────────────────────────
function chatSettings(config, talker) {
  const chat = config.chats?.[talker] || {};
  const globalEnabled = config.plugins?.enabled || [];
  // null = 跟随全局；[] = 该聊天一个插件都不用；[...] = 只用这些
  const pluginFilter = Array.isArray(chat.plugins) ? chat.plugins : globalEnabled;
  const providerId = chat.model?.providerId || config.ai.defaultProvider;
  const modelId = chat.model?.providerId
    ? (chat.model.modelId || undefined)
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
  };
}

// ── 消息处理主流程 ────────────────────────────────────────
const processing = new Set(); // talker 级别串行，避免同一聊天并发乱序
const seenRawids = new Map(); // rawid -> ts，SSE 重推 / 图片重试去重

async function handleIncoming(event, { source = 'sse' } = {}) {
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

  const trigger = router.shouldTrigger(msg, config);
  if (trigger.reason) {
    bumpSkipped(trigger.reason);
    log(`跳过 [${trigger.reason}] ${msg.kind}/${msg.talker}: ${msg.text.slice(0, 40)}`, 'debug');
    return { skipped: trigger.reason };
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
  const sentImagePaths = [];

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
              await sendImageFile(msg.talker, p);
              sentImagePaths.push(p);
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
    } else {
      log('模型返回空内容，未回复', 'warn');
      return { ok: false, reason: 'empty_reply' };
    }
  }

  context.addMessage('user', msg.text, { images: msg.images.map(i => i.id), contentType: msg.contentType, ts: msg.timestamp });
  if (replyText.trim()) context.addMessage('assistant', replyText);

  const parts = replyText.trim() ? router.splitReply(replyText, config) : [];
  if (parts.length) {
    for (let i = 0; i < parts.length; i++) {
      try {
        await sendText(msg.talker, parts[i]);
      } catch (e) {
        log(`发送失败: ${e.message}`, 'error');
        break;
      }
      if (i < parts.length - 1) await new Promise(r => setTimeout(r, settings.reply?.minIntervalMs || 1200));
    }
    log(`已回复 ${msg.talker}（${parts.length} 条${sentImagePaths.length ? `，${sentImagePaths.length} 张图` : ''}${toolRuns.length ? `，${toolRuns.length} 次工具` : ''}）`);
  }

  // ── 记忆沉淀（异步，不阻塞回复）──
  if (settings.memory?.enabled && settings.memory?.autoTag) {
    afterTurnMemory(msg, config, context, replyText).catch(e => log(`记忆沉淀失败: ${e.message}`, 'warn'));
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

  const vp = config.ai.vision?.providerId || config.ai.defaultProvider;
  const vm = config.ai.vision?.modelId || config.ai.defaultModel || undefined;
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

  if (p === '/api/chat/history' && method === 'GET') {
    const talker = url.searchParams.get('talker');
    const limit = Math.min(200, parseInt(url.searchParams.get('limit') || '40', 10));
    if (!talker) { sendJson(res, 400, { error: '缺少 talker' }); return; }
    try {
      sendJson(res, 200, { messages: await getChatHistory(talker, limit) });
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
    const list = Object.entries(cfg.chats || {}).map(([talker, c]) => ({
      talker,
      ...c,
      context: new ChatContext(talker).stats(),
      settings: chatSettings(cfg, talker),
    }));
    sendJson(res, 200, { chats: list, agentWhitelist: agent });
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
    sendJson(res, 200, { ok: true, chat: merged });
    return;
  }

  // ── AI ──
  if (p === '/api/ai/providers' && method === 'GET') {
    try { sendJson(res, 200, { providers: await ai.listProviders() }); }
    catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  // ── 一键接入 DeepSeek（填 Key 就能用）──
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
    const fake = {
      event: 'message.new',
      sessionId: talker,
      sessionType: kind,
      conversationId: convId,
      senderName: b.senderName || talker,
      talkerId: talker,
      content: b.text || '',
      type: 1,
      timestamp: Math.floor(Date.now() / 1000),
      rawid: `debug-${Date.now()}`,
    };
    try {
      const r = await handleIncoming(fake, { source: 'debug' });
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

async function main() {
  loadDataDir();
  log('灵枢 AI 中枢 v0.4 启动中…');

  const cfg = await loadConfig();
  setConfigSnapshot(cfg);

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
