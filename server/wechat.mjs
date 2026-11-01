/**
 * 灵枢 AI 中枢 — WeChat 驱动层
 * 对接本机已有的 WeChat NT 读取器（5031）与 Hook 发送端（30001）
 */
import { loadConfig, ROOT_DIR } from './config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ── 驱动状态 ──────────────────────────────────────────────
const _state = {
  connected: false,
  hookConnected: false,
  listening: false,
  sseConnected: false,
  ownWxid: '',
  ownNickname: '',
  accountDirectory: '',
  lastError: '',
  received: 0,
  sent: 0,
  skipped: 0,
  sseEvents: 0,
  sseReconnects: 0,
  lastEventAt: 0,
  readerUrl: '',
  hookUrl: '',
};

let _reader = null;
let _hook = null;
let _stop = false;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function resolveWorkspacePath(rel) {
  const candidates = [
    path.resolve(ROOT_DIR, '..', 'WeChatAgent-install', 'data', 'workspace', rel),
    path.resolve(ROOT_DIR, '..', rel),
    path.resolve(ROOT_DIR, rel),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return candidates[0];
}

/**
 * Hook 的 /SendFileMsg 只接受暂存区里的文件：
 *   <hook模块目录>/../../../../state/files/outgoing/<64位hex>/<文件名>
 * 且要求 size、md5 完全一致，否则直接 400 ret:1。所以发送前必须先"落地"。
 *
 * hook 模块目录 = wechatagent-hook.token 所在目录（它和注入的 DLL 同目录），
 * 往上四层才是它认的根（实际落在 WeChatAgent-install/data/state/files/outgoing）。
 */
function findHookModuleDir() {
  // 1) 优先用 WeChatAgent 配置里登记的微信可执行文件路径 —— hook DLL 就注入在它旁边
  try {
    const ws = resolveWorkspacePath(path.join('config', 'wechatagent.json'));
    const cfg = JSON.parse(fs.readFileSync(ws, 'utf8').replace(/^\uFEFF/, ''));
    const exe = cfg?.hook?.wechatExecutable;
    if (exe && fs.existsSync(path.dirname(exe))) return path.dirname(exe);
  } catch { /* 继续用下面的兜底 */ }

  // 2) 兜底：找 wechatagent-hook.token（和 DLL 同目录）
  const wsCandidates = [
    path.resolve(ROOT_DIR, '..', 'WeChatAgent-install', 'data', 'workspace'),
    path.resolve(ROOT_DIR, '..', 'WeChatAgent', 'data', 'workspace'),
  ];
  for (const ws of wsCandidates) {
    const hookDir = path.join(ws, 'state', 'hook');
    if (!fs.existsSync(hookDir)) continue;
    for (const d of fs.readdirSync(hookDir)) {
      const tokenFile = path.join(hookDir, d, 'wechatagent-hook.token');
      if (fs.existsSync(tokenFile)) return path.dirname(tokenFile);
    }
  }
  return null;
}

let _stagingRoot = null;
function stagingDir() {
  if (_stagingRoot) return _stagingRoot;
  const modDir = findHookModuleDir();
  if (modDir) {
    _stagingRoot = path.resolve(modDir, '..', '..', '..', '..', 'state', 'files', 'outgoing');
  } else {
    _stagingRoot = resolveWorkspacePath(path.join('state', 'files', 'outgoing'));
  }
  fs.mkdirSync(_stagingRoot, { recursive: true });
  return _stagingRoot;
}

function stageFileForSend(filePath) {
  const src = path.resolve(filePath);
  const buf = fs.readFileSync(src);
  const md5 = crypto.createHash('md5').update(buf).digest('hex');
  const slot = crypto.randomBytes(32).toString('hex');   // 64 位 hex
  const dir = path.join(stagingDir(), slot);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, path.basename(src));
  fs.copyFileSync(src, dest);
  return { dest, md5, size: buf.length, dir };
}


// ── Reader 客户端 ─────────────────────────────────────────
export class ReaderClient {
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  async fetchJson(route, options = {}) {
    const url = new URL(route, this.baseUrl);
    const resp = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
      redirect: 'error',
      signal: options.signal || AbortSignal.timeout(15000),
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`Reader ${resp.status}: ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { throw new Error(`Reader 返回非 JSON: ${text.slice(0, 120)}`); }
  }

  async getStatus() {
    return this.fetchJson('/api/v1/reader/status');
  }

  async getSessions(limit = 300) {
    const d = await this.fetchJson(`/api/v1/sessions?limit=${limit}`);
    return d.sessions || [];
  }

  async getContacts(keyword = '', kind = '', limit = 60) {
    const qs = new URLSearchParams({ keyword, limit: String(limit), refresh: '1' });
    if (kind) qs.set('kind', kind);
    const d = await this.fetchJson(`/api/v1/contacts?${qs}`);
    return d.contacts || [];
  }

  async getMessages(talker, limit = 50) {
    const d = await this.fetchJson(`/api/v1/messages?talker=${encodeURIComponent(talker)}&limit=${limit}`);
    return d.messages || [];
  }

  /**
   * 取图片（base64 JPEG）。reader 侧解析在子进程里跑，最多约 11 秒；
   * 首次失败会让 reader 重新准备一次再取一遍。
   */
  async getImage(imageId, { retries = 1 } = {}) {
    const id = encodeURIComponent(imageId);
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.fetchJson(`/api/v1/images/${id}`, { signal: AbortSignal.timeout(30000) });
      } catch (e) {
        lastErr = e;
        if (attempt < retries) {
          // 让 reader 重新解析（它会顺带重推一次事件，主流程按 rawid 去重）
          try {
            await this.fetchJson(`/api/v1/images/${id}/retry`, { method: 'POST', signal: AbortSignal.timeout(15000) });
          } catch { /* ignore */ }
          await sleep(1200);
        }
      }
    }
    throw lastErr;
  }

  /**
   * 长连接订阅 SSE。Reader 每 2 秒发一次心跳，因此把「90 秒无任何数据」视为死连接并重连。
   */
  async connectSSE(onEvent, { onStatus, onRaw } = {}) {
    const url = new URL('/api/v1/push/messages', this.baseUrl);
    let backoff = 1000;

    while (!_stop) {
      const controller = new AbortController();
      let idleTimer = null;
      const bump = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => controller.abort(), 90000);
      };

      try {
        bump();
        const resp = await fetch(url, {
          headers: { Authorization: `Bearer ${this.token}`, Accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!resp.ok || !resp.body) throw new Error(`SSE HTTP ${resp.status}`);

        _state.sseConnected = true;
        _state.listening = true;
        onStatus?.({ connected: true });

        const decoder = new TextDecoder();
        let buffer = '';

        for await (const chunk of resp.body) {
          bump();
          buffer += decoder.decode(chunk, { stream: true });
          let at;
          while ((at = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, at).replace(/\r$/, '');
            buffer = buffer.slice(at + 1);
            if (!line || line.startsWith(':')) continue;      // 心跳
            if (!line.startsWith('data:')) continue;
            const raw = line.slice(5).trim();
            if (!raw) continue;
            onRaw?.(raw);
            let payload;
            try { payload = JSON.parse(raw); } catch { continue; }
            _state.sseEvents++;
            _state.lastEventAt = Date.now();
            try { onEvent(payload); } catch (e) { console.error('[sse] handler error', e); }
          }
        }
        throw new Error('SSE 流结束');
      } catch (e) {
        _state.sseConnected = false;
        onStatus?.({ connected: false, error: e.message });
        if (_stop) break;
        _state.sseReconnects++;
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 10000);
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
      }
    }
  }

  stop() { _stop = true; }
}

// ── Hook 客户端 ───────────────────────────────────────────
export class HookClient {
  constructor(baseUrl, token, account) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.accountHeader = account ? { 'X-WeChatAgent-Account': account } : {};
  }

  async fetchJson(route, body) {
    const url = new URL(route, this.baseUrl);
    const opts = {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...this.accountHeader,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const resp = await fetch(url, opts);
    const text = await resp.text();
    if (!resp.ok) throw new Error(`Hook ${resp.status}: ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { return { raw: text }; }
  }

  health() { return this.fetchJson('/WeChatAgent/health'); }
  setAccount(account) { this.accountHeader = account ? { 'X-WeChatAgent-Account': account } : {}; }
  sendText(wxidOrGroupId, text) { return this.fetchJson('/SendTextMsg', { wxidorgid: wxidOrGroupId, msg: text }); }
  sendFile(wxidOrGroupId, filePath, md5, size) {
    return this.fetchJson('/SendFileMsg', { wxidorgid: wxidOrGroupId, path: filePath, md5, size });
  }
}

// ── 初始化 ────────────────────────────────────────────────
export async function initDrivers() {
  const config = await loadConfig();
  _state.readerUrl = config.wechat.readerUrl;
  _state.hookUrl = config.wechat.hookUrl;

  // Reader token
  let readerToken = config.wechat.readerToken;
  if (!readerToken) {
    try {
      const io = JSON.parse(fs.readFileSync(resolveWorkspacePath('state/wechat-io-config.json'), 'utf8').replace(/^\uFEFF/, ''));
      readerToken = io.reader_token || io.readerToken || '';
    } catch { /* ignore */ }
  }
  if (!readerToken) throw new Error('无法获取 Reader Token');

  // Hook token
  let hookToken = config.wechat.hookToken;
  if (!hookToken) {
    try {
      const t = fs.readFileSync(resolveWorkspacePath('state/hook/native-token.txt'), 'utf8').trim();
      if (/^[a-f0-9]{64}$/.test(t)) hookToken = t;
    } catch { /* ignore */ }
  }
  if (!hookToken) throw new Error('无法获取 Hook Token');

  _reader = new ReaderClient(config.wechat.readerUrl, readerToken);
  _hook = new HookClient(config.wechat.hookUrl, hookToken, undefined);
  _stop = false;

  const status = await _reader.getStatus();
  _state.ownWxid = status.ownWxid || '';
  _state.accountDirectory = status.accountDirectory || '';
  _state.readerSubscribers = status.subscribers ?? null;
  _state.readerPushed = status.pushed ?? null;
  _state.connected = true;

  const account = config.wechat.account || _state.accountDirectory;
  if (account) _hook.setAccount(account);

  try {
    await _hook.health();
    _state.hookConnected = true;
  } catch (e) {
    _state.hookConnected = false;
    _state.lastError = `Hook: ${e.message}`;
  }

  return { ..._state };
}

export function getReader() { return _reader; }
export function getHook() { return _hook; }
export function getState() { return { ..._state }; }
export function bumpReceived() { _state.received++; }
export function bumpSkipped(reason) {
  _state.skipped++;
  _state.lastSkipReason = reason;
}

export async function refreshReaderStatus() {
  if (!_reader) return null;
  try {
    const s = await _reader.getStatus();
    _state.readerSubscribers = s.subscribers ?? null;
    _state.readerPushed = s.pushed ?? null;
    _state.readerLastPoll = s.lastPoll ?? null;
    _state.readerLastError = s.lastError || '';
    return s;
  } catch (e) {
    _state.readerLastError = e.message;
    return null;
  }
}

// ── 对外 API ──────────────────────────────────────────────
export async function getSessions() {
  if (!_reader) throw new Error('微信驱动未初始化');
  const [sessions, contacts] = await Promise.all([
    _reader.getSessions().catch(() => []),
    _reader.getContacts('', '', 300).catch(() => []),
  ]);
  const byName = new Map(contacts.map(c => [c.username, c]));
  return sessions.map(s => {
    const c = byName.get(s.username) || {};
    const isGroup = s.type === 1 || String(s.username).includes('@chatroom');
    return {
      username: s.username,
      talker: s.username,
      displayName: s.displayName || c.displayName || s.username,
      conversationId: String(s.conversationId ?? c.conversationId ?? ''),
      kind: isGroup ? 'group' : 'private',
      type: isGroup ? 1 : 0,
      lastTime: s.lastTime || s.timestamp || 0,
    };
  });
}

export async function getChatHistory(talker, limit = 30) {
  if (!_reader) throw new Error('微信驱动未初始化');
  return _reader.getMessages(talker, limit);
}

export async function searchChats(query, kind = '') {
  if (!_reader) throw new Error('微信驱动未初始化');
  const [contacts, sessions] = await Promise.all([
    _reader.getContacts(query, kind, 80).catch(() => []),
    _reader.getSessions().catch(() => []),
  ]);
  const merged = new Map();
  for (const c of contacts) {
    const isGroup = String(c.username).includes('@chatroom');
    merged.set(c.username, {
      talker: c.username,
      displayName: c.displayName || c.username,
      conversationId: String(c.conversationId ?? ''),
      kind: isGroup ? 'group' : 'private',
      source: 'contact',
    });
  }
  const q = String(query || '').toLowerCase();
  for (const s of sessions) {
    const isGroup = s.type === 1 || String(s.username).includes('@chatroom');
    const name = s.displayName || s.username;
    if (q && !`${name}${s.username}`.toLowerCase().includes(q)) continue;
    if (!merged.has(s.username)) {
      merged.set(s.username, {
        talker: s.username,
        displayName: name,
        conversationId: String(s.conversationId ?? ''),
        kind: isGroup ? 'group' : 'private',
        source: 'session',
      });
    }
  }
  return [...merged.values()];
}

export async function sendText(wxidOrGroupId, text) {
  if (!_hook) throw new Error('发送端未初始化');
  const result = await _hook.sendText(wxidOrGroupId, text);
  if (result?.ret === 0 || result?.ok === true) {
    _state.sent++;
    return { ok: true, messageId: String(result.message_id ?? result.msgId ?? Date.now()) };
  }
  throw new Error(`发送失败 ret=${result?.ret} msg=${result?.retmsg || result?.msg || ''}`);
}

export async function sendImageFile(wxidOrGroupId, imagePath) {
  return sendFileMsg(wxidOrGroupId, imagePath);
}

/** 发送任意本地文件（微信会按扩展名渲染，图片走文件气泡） */
export async function sendFileMsg(wxidOrGroupId, filePath) {
  if (!_hook) throw new Error('发送端未初始化');
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) throw new Error(`文件不存在: ${absPath}`);
  const staged = stageFileForSend(absPath);
  try {
    const result = await _hook.sendFile(wxidOrGroupId, staged.dest, staged.md5, staged.size);
    if (result?.ret === 0 || result?.ok === true) {
      _state.sent++;
      return { ok: true };
    }
    throw new Error(`文件发送失败 ret=${result?.ret} ${result?.error || result?.retmsg || ''}`.trim());
  } finally {
    // 暂存区不留垃圾
    try { fs.rmSync(staged.dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

export async function startListening(onMessage, hooks = {}) {
  if (!_reader) throw new Error('微信驱动未初始化');
  _stop = false;
  _state.listening = true;
  // 不 await：常驻循环
  _reader.connectSSE(onMessage, {
    onStatus: (s) => {
      _state.sseConnected = s.connected;
      if (!s.connected && s.error) _state.lastSseError = s.error;
      hooks.onStatus?.(s);
    },
    onRaw: hooks.onRaw,
  }).catch(e => {
    _state.listening = false;
    hooks.onFatal?.(e);
  });
}

export function stopListening() {
  _stop = true;
  _state.listening = false;
  _state.sseConnected = false;
  _reader?.stop();
}
