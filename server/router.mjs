/**
 * 灵枢 AI 中枢 — 消息解析、触发判断与上下文管理
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from './config.mjs';
import { estimateMessagesTokens, estimateTokens } from './memory.mjs';
import { nowBlock, messageStamp, formatTime } from './time.mjs';

const CONTEXT_DIR = path.join(ROOT_DIR, 'data', 'contexts');
fs.mkdirSync(CONTEXT_DIR, { recursive: true });

const MAX_STORED = 200;

function contextPath(talker) {
  const safe = String(talker || 'unknown').replace(/[^a-zA-Z0-9_@-]/g, '_').slice(0, 80);
  return path.join(CONTEXT_DIR, `${safe}.json`);
}

export class ChatContext {
  constructor(talker) {
    this.talker = talker;
    this._load();
  }

  _load() {
    const fp = contextPath(this.talker);
    try {
      this.data = JSON.parse(fs.readFileSync(fp, 'utf8').replace(/^\uFEFF/, ''));
      if (!Array.isArray(this.data.messages)) this.data.messages = [];
    } catch {
      this.data = { messages: [], metadata: { talker: this.talker, created: Date.now(), lastActive: Date.now() } };
    }
  }

  _save() {
    this.data.metadata = this.data.metadata || { talker: this.talker, created: Date.now() };
    this.data.metadata.lastActive = Date.now();
    if (this.data.messages.length > MAX_STORED) {
      this.data.messages = this.data.messages.slice(-MAX_STORED);
    }
    try {
      fs.writeFileSync(contextPath(this.talker), JSON.stringify(this.data, null, 2), 'utf8');
    } catch { /* ignore */ }
  }

  addMessage(role, content, extras = {}) {
    this.data.messages.push({ role, content, ts: Date.now(), ...extras });
    this._save();
  }

  getMessages(limit = 20) {
    return this.data.messages.slice(-limit);
  }

  /** 估算当前上下文 token */
  tokens() {
    return estimateMessagesTokens(this.data.messages.map(m => ({ role: m.role, content: m.content })));
  }

  getSummary() {
    return this.data.metadata?.summary?.text || '';
  }

  setSummary(text, meta = {}) {
    this.data.metadata = this.data.metadata || {};
    this.data.metadata.summary = {
      text: String(text || ''),
      coversUpTo: meta.coversUpTo || Date.now(),
      compressedCount: (this.data.metadata.summary?.compressedCount || 0) + (meta.compressedCount || 0),
      updatedAt: Date.now(),
    };
    this._save();
  }

  /**
   * 选出「可以压缩掉的旧消息」但不删除（压缩成功后才删）
   */
  previewCompression(keepRecent = 14, minBatch = 4) {
    const msgs = this.data.messages;
    if (msgs.length <= keepRecent + minBatch) return { head: [], cut: 0 };
    let cut = msgs.length - keepRecent;
    while (cut > 0 && msgs[cut]?.role !== 'user') cut--;
    if (cut < minBatch) cut = msgs.length - keepRecent;
    return { head: msgs.slice(0, cut), cut };
  }

  dropHead(count) {
    if (count <= 0) return this.data.messages.length;
    this.data.messages = this.data.messages.slice(count);
    this._save();
    return this.data.messages.length;
  }

  messageCount() {
    return this.data.messages.length;
  }

  setSystemPrompt(prompt) {
    this.data.metadata = this.data.metadata || {};
    this.data.metadata.systemPrompt = prompt;
    this._save();
  }

  clear() {
    this.data = { messages: [], metadata: { talker: this.talker, created: Date.now(), lastActive: Date.now() } };
    this._save();
  }

  stats() {
    const msgs = this.data.messages || [];
    return {
      talker: this.talker,
      count: msgs.length,
      lastActive: this.data.metadata?.lastActive || 0,
      lastUser: [...msgs].reverse().find(m => m.role === 'user')?.content?.slice(0, 80) || '',
    };
  }
}

// ── 消息路由 ──────────────────────────────────────────────
const IMAGE_TYPES = new Set([3, 47]);

export class MessageRouter {
  constructor() {
    this.rateLimits = new Map();
  }

  /**
   * 把 Reader 的原始 SSE payload 归一化成内部消息对象。
   *
   * Reader 实际推送结构（reader-api.py: push_payload）：
   * {
   *   event: 'message.new', sessionId: 'wxid_xxx' | '123@chatroom',
   *   conversationId: '165338666', sessionType: 'private'|'group',
   *   rawid, groupName, sourceName, senderName, talkerId,
   *   content, type: 1|3|34|47|49, timestamp(秒),
   *   image?: { id }, file?, voice?, quoteReply?, forwardedRecord?, pat?
   * }
   * 同时兼容旧的/调试用的 { talker, text, kind, sender_wxid } 结构。
   */
  parseEvent(event, { ownWxid = '' } = {}) {
    const talker = event.sessionId || event.talker || event.username || event.sender_wxid || '';
    const kind = event.sessionType
      || event.kind
      || (String(talker).includes('@chatroom') ? 'group' : 'private');

    const type = Number(event.type ?? event.localType ?? 1);
    let text = String(event.content ?? event.text ?? '');
    if (type === 3 && !text) text = '[图片]';
    if (type === 47) text = text || '[表情包]';

    const images = [];
    if (event.image?.id) images.push({ id: event.image.id, kind: IMAGE_TYPES.has(type) ? 'image' : 'media' });
    for (const img of event.images || []) {
      if (img?.id) images.push({ id: img.id, kind: img.kind || 'image' });
    }

    const files = [];
    if (event.file) files.push(event.file);
    for (const f of event.files || []) files.push(f);

    const senderWxid = event.talkerId || event.sender_wxid || (kind === 'private' ? talker : '');
    const ts = event.timestamp ? Number(event.timestamp) * (String(event.timestamp).length > 11 ? 1 : 1000) : Date.now();

    const isOutgoing = Boolean(event.outgoing) || (ownWxid && senderWxid === ownWxid);

    return {
      id: event.rawid || event.id || `${talker}:${ts}`,
      rawid: event.rawid || '',
      talker,
      kind,
      conversationId: String(event.conversationId ?? event.conversation_id ?? ''),
      conversationName: event.groupName || event.conversation_name || '',
      senderWxid,
      senderName: event.senderName || event.sourceName || event.sender_name || senderWxid,
      text,
      contentType: type,
      images,
      files,
      voice: event.voice || null,
      quote: event.quoteReply || null,
      forwarded: event.forwardedRecord || null,
      isOutgoing,
      timestamp: ts,
      raw: event,
    };
  }

  /**
   * 是否应当回复。
   * 白名单：config.chats 非空时以它为准；否则用 legacy wechat.whitelist。
   */
  shouldTrigger(msg, config) {
    if (!msg.talker) return { reason: 'no_talker' };
    if (msg.isOutgoing) return { reason: 'outgoing' };

    const chat = config.chats?.[msg.talker];
    const registryUsed = Object.keys(config.chats || {}).length > 0;

    if (registryUsed) {
      if (!chat || chat.enabled === false) return { reason: 'chat_not_enabled' };
    } else {
      const wl = config.wechat.whitelist || { groups: [], private: [] };
      const ids = new Set([...(wl.groups || []), ...(wl.private || [])].map(String));
      const inList = ids.has(String(msg.conversationId)) || ids.has(String(msg.talker));
      if (ids.size > 0 && !inList) return { reason: 'not_whitelisted' };
    }

    const mode = chat?.triggerMode || config.wechat.triggerMode || 'smart';
    if (mode === 'off') return { reason: 'trigger_off' };
    if (mode === 'all') return { reason: null };

    const text = msg.text || '';
    const wakeWords = (config.wechat.wakeWords || []).filter(Boolean);
    const botNames = (config.wechat.botNames || []).filter(Boolean);
    const atHit = /@\S/.test(text) || botNames.some(n => text.includes(`@${n}`));
    const wordHit = wakeWords.some(w => text.toLowerCase().includes(String(w).toLowerCase()));

    if (mode === 'prefix') {
      return wakeWords.some(w => text.trimStart().toLowerCase().startsWith(String(w).toLowerCase()))
        ? { reason: null } : { reason: 'no_prefix' };
    }

    // smart：私聊直接回复；群聊必须 @ 或带唤醒词
    if (mode === 'smart') {
      if (msg.kind === 'private') return { reason: null };
      return (atHit || wordHit) ? { reason: null } : { reason: 'group_not_mentioned' };
    }

    // mention
    if (msg.kind === 'private') return { reason: null };
    return (atHit || wordHit) ? { reason: null } : { reason: 'no_mention' };
  }

  checkRateLimit(talker, config) {
    const now = Date.now();
    const limit = config.rateLimit?.maxPerChatPerMinute ?? 15;
    const entry = this.rateLimits.get(talker) || { count: 0, windowStart: now };
    if (now - entry.windowStart > 60000) {
      entry.count = 0;
      entry.windowStart = now;
    }
    entry.count++;
    this.rateLimits.set(talker, entry);
    return entry.count > limit ? { allowed: false, reason: 'rate_limit' } : { allowed: true };
  }

  /**
   * 构造发给模型的消息数组
   * summary 是早前对话的滚动摘要（上下文压缩产物）
   */
  buildMessages(context, msg, { systemPrompt, historyLimit = 20, summary = '', withTime = true } = {}) {
    const messages = [];
    const now = msg?.timestamp || Date.now();

    // 先告诉模型「现在几点」，否则「明天」「上周」这些话它没法换算
    const timeNote = nowBlock(now);
    if (systemPrompt) messages.push({ role: 'system', content: `${systemPrompt}\n\n${timeNote}` });
    else messages.push({ role: 'system', content: timeNote });

    if (summary) {
      messages.push({
        role: 'system',
        content: `【早前对话的压缩摘要】\n${summary}\n（以上是更早之前的对话，细节已省略；需要时可以向对方确认。）`,
      });
    }

    for (const m of context.getMessages(historyLimit)) {
      if (m.role === 'system') continue;
      const content = typeof m.content === 'string' ? m.content : String(m.content ?? '');
      if (!content.trim()) continue;
      // 每条历史消息都带上它真实的发送时间
      const stamp = withTime && m.ts ? messageStamp(m.ts) : '';
      messages.push({ role: m.role, content: content + stamp });
    }

    const parts = [];
    const stampText = withTime ? `\n（发送时间：${formatTime(now)}）` : '';
    if (msg.text) parts.push({ type: 'text', text: msg.text + stampText });
    else if (stampText) parts.push({ type: 'text', text: stampText.trim() });
    for (const img of msg.images) parts.push({ type: 'image_ref', imageId: img.id });

    messages.push({
      role: 'user',
      content: parts.length ? parts : [{ type: 'text', text: '[空消息]' }],
    });
    return messages;
  }

  /**
   * 把长回复切成多条微信消息
   */
  splitReply(text, config) {
    const maxChars = config.wechat?.reply?.maxCharsPerMessage || 500;
    const maxMessages = config.wechat?.reply?.maxMessagesPerTurn || 3;
    const clean = String(text || '').trim();
    if (!clean) return [];

    const chunks = [];
    let current = '';
    const push = () => {
      if (current.trim()) chunks.push(current.trim());
      current = '';
    };

    for (const paragraph of clean.split(/\n{1,}/)) {
      const line = paragraph.trim();
      if (!line) continue;
      if (current.length + line.length + 1 <= maxChars) {
        current = current ? `${current}\n${line}` : line;
        continue;
      }
      push();
      if (line.length <= maxChars) {
        current = line;
      } else {
        // 超长行按中文句末标点再切
        let rest = line;
        while (rest.length > maxChars) {
          const window = rest.slice(0, maxChars);
          const cut = Math.max(
            window.lastIndexOf('。'), window.lastIndexOf('！'), window.lastIndexOf('？'),
            window.lastIndexOf('\n'), window.lastIndexOf('. '),
          );
          const at = cut > maxChars * 0.5 ? cut + 1 : maxChars;
          chunks.push(rest.slice(0, at).trim());
          rest = rest.slice(at).trim();
        }
        current = rest;
      }
    }
    push();

    if (chunks.length <= maxMessages) return chunks;
    const kept = chunks.slice(0, maxMessages - 1);
    kept.push(chunks.slice(maxMessages - 1).join('\n'));
    return kept;
  }
}

export const router = new MessageRouter();
