/**
 * 灵枢 AI 中枢 — WeChatAgent 桥接
 *
 * 读取器（weflow-cli-nt）只会轮询 / 推送「WeChatAgent 自己白名单」里的会话。
 * 因此灵枢要把某个聊天加进来时，必须同时写进 WeChatAgent 的 config/wechatagent.json，
 * 否则 reader 的 /api/v1/messages 会直接抛 PermissionError，也不会推 SSE。
 *
 * 安全策略：先备份，再原子写；解析失败绝不覆盖原文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR, DATA_DIR } from './config.mjs';

const CANDIDATES = [
  path.resolve(ROOT_DIR, '..', 'WeChatAgent-install', 'data', 'workspace'),
  path.resolve(ROOT_DIR, '..', 'WeChatAgent', 'data', 'workspace'),
];

export function findWorkspace() {
  for (const c of CANDIDATES) {
    if (fs.existsSync(path.join(c, 'config', 'wechatagent.json'))) return c;
  }
  return null;
}

function configPath() {
  const ws = findWorkspace();
  if (!ws) return null;
  return path.join(ws, 'config', 'wechatagent.json');
}

export function readAgentConfig() {
  const fp = configPath();
  if (!fp) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

export function getAgentWhitelist() {
  const cfg = readAgentConfig();
  const w = cfg?.wechat?.whitelist;
  return {
    groups: (w?.groups || []).map(String),
    private: (w?.private || []).map(String),
    nicknames: cfg?.account?.nicknames || [],
    workspace: findWorkspace(),
  };
}

function backup(fp) {
  try {
    const dir = path.join(DATA_DIR, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(fp, path.join(dir, `wechatagent-${stamp}.json`));
  } catch { /* 备份失败不阻塞主流程，但会记录 */ }
}

function writeAgentConfig(cfg) {
  const fp = configPath();
  if (!fp) throw new Error('找不到 WeChatAgent 配置文件（wechatagent.json）');
  backup(fp);
  const tmp = `${fp}.lingshu.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, fp);
}

/**
 * 把会话加入 WeChatAgent 白名单
 * @param {'group'|'private'} kind
 * @param {string} conversationId
 */
export function ensureWhitelisted(kind, conversationId) {
  const id = String(conversationId || '').trim();
  if (!id) throw new Error('缺少 conversationId，无法加入白名单');
  const cfg = readAgentConfig();
  if (!cfg) throw new Error('读取 WeChatAgent 配置失败');

  cfg.wechat = cfg.wechat || {};
  cfg.wechat.whitelist = cfg.wechat.whitelist || { groups: [], private: [] };
  const key = kind === 'group' ? 'groups' : 'private';
  const list = (cfg.wechat.whitelist[key] || []).map(String);
  if (!list.includes(id)) {
    list.push(id);
    cfg.wechat.whitelist[key] = list;
    writeAgentConfig(cfg);
    return { added: true, key, id };
  }
  return { added: false, key, id };
}

export function removeWhitelisted(kind, conversationId) {
  const id = String(conversationId || '').trim();
  const cfg = readAgentConfig();
  if (!cfg || !id) return { removed: false };
  const key = kind === 'group' ? 'groups' : 'private';
  const list = (cfg.wechat?.whitelist?.[key] || []).map(String);
  if (!list.includes(id)) return { removed: false };
  cfg.wechat.whitelist[key] = list.filter(x => x !== id);
  writeAgentConfig(cfg);
  return { removed: true };
}

// ── 语音读取权限 ──────────────────────────────────────────
/**
 * reader 的 /api/v1/voices/:id 会去读 WeChatAgent 的 config/plugins.json，
 * 要求调用方以某个 pluginId 身份出现，且该条目满足：
 *   enabled === true、permissions 含 'audio_read'、chats 为 null 或包含该会话
 *
 * 灵枢并不真的是它的插件，但这一步只是查这个 JSON，
 * 所以把自己登记成一个只读语音的条目即可（不涉及注入，也不影响其它插件）。
 */
export const AUDIO_PLUGIN_ID = 'lingshu';

/**
 * 读取器在「推送阶段」用的是写死的默认 id（audio_policy 的默认参数），
 * 没有这个条目的话，语音消息会被 reader 直接丢弃 —— 连 SSE 都不会推。
 * 所以这里还要保证 speech-recognition 这条也具备 audio_read。
 */
export const AUDIO_PUSH_PLUGIN_ID = 'speech-recognition';

function pluginConfigPath() {
  const ws = findWorkspace();
  return ws ? path.join(ws, 'config', 'plugins.json') : null;
}

export function readPluginConfig() {
  const fp = pluginConfigPath();
  if (!fp) return null;
  try {
    if (!fs.existsSync(fp)) return { plugins: {} };
    return JSON.parse(fs.readFileSync(fp, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/**
 * 确保灵枢拥有语音读取权限。幂等，可反复调用。
 * @returns {{ok:boolean, changed:boolean, reason?:string}}
 */
export function ensureAudioPermission(pluginId = AUDIO_PLUGIN_ID) {
  const fp = pluginConfigPath();
  if (!fp) return { ok: false, changed: false, reason: '找不到 WeChatAgent 工作区' };

  const cfg = readPluginConfig();
  if (!cfg) return { ok: false, changed: false, reason: 'plugins.json 解析失败，已跳过（不会覆盖）' };

  cfg.plugins = cfg.plugins || {};

  let changed = false;
  // 1) 推送门禁：读取器登记语音引用时用的是默认 id，必须存在
  // 2) 读取门禁：灵枢自己取音频时用 lingshu 这个 id
  for (const pid of [AUDIO_PUSH_PLUGIN_ID, pluginId]) {
    const cur = cfg.plugins[pid] || {};
    const perms = new Set(cur.permissions || []);
    const need = cur.enabled !== true || !perms.has('audio_read') || (cur.chats !== null && cur.chats !== undefined);
    if (!need) continue;
    perms.add('audio_read');
    cfg.plugins[pid] = {
      ...cur,
      enabled: true,
      permissions: [...perms],
      chats: null,          // null = 白名单内所有会话都允许
      note: cur.note || (pid === AUDIO_PUSH_PLUGIN_ID
        ? '灵枢 AI 中枢：用于让读取器放行语音消息（不参与转写）'
        : '灵枢 AI 中枢：仅用于读取语音做转写'),
    };
    changed = true;
  }

  if (!changed) return { ok: true, changed: false };

  try {
    if (fs.existsSync(fp)) {
      const dir = path.join(DATA_DIR, 'backups');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(fp, path.join(dir, `plugins-${stamp}.json`));
    }
    const tmp = `${fp}.lingshu.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
    fs.renameSync(tmp, fp);
    return { ok: true, changed: true };
  } catch (e) {
    return { ok: false, changed: false, reason: e.message };
  }
}

/** reader 语音端点需要的 conversationKey：wechat:private:<conversationId> */
export function conversationKeyOf(kind, conversationId) {
  return `wechat:${kind === 'group' ? 'group' : 'private'}:${String(conversationId || '').trim()}`;
}
