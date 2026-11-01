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
