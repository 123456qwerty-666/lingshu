/**
 * 灵枢 AI 中枢 — 配置管理
 * 纯 Node 内置模块，无第三方依赖
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const SECRETS_DIR = path.join(DATA_DIR, 'secrets');

export const DEFAULT_CONFIG = {
  app: { name: '灵枢 AI 中枢', version: '0.4.0', port: 17890, bind: '127.0.0.1' },
  wechat: {
    readerUrl: 'http://127.0.0.1:5031',
    hookUrl: 'http://127.0.0.1:30001',
    readerToken: '',
    hookToken: '',
    account: '',
    ownWxid: '',
    botNames: [],                 // 机器人在微信里的昵称（群聊 @ 判定用，可留空）
    triggerMode: 'smart',         // smart | mention | prefix | all | off
    wakeWords: ['AI', '灵枢', 'bot'],
    whitelist: { groups: [], private: [] },   // 兼容字段，chats 为空时生效
    reply: { maxCharsPerMessage: 500, maxMessagesPerTurn: 3, minIntervalMs: 1200 },
    media: { maxImagesPerTurn: 4, autoViewImages: true, autoSendImages: true },
  },
  ai: {
    defaultProvider: 'deepseek',
    defaultModel: '',
    providers: {},
    modelOverrides: {},
    // 主提供商被限流/报错时的降级顺序；留空则自动尝试其它所有已配置的提供商
    fallbackProviders: [],
    /**
     * 识图模型。留空 = 用当前聊天的模型直接看图（要求它支持图片输入）。
     * 配了之后，如果当前聊天模型不支持图片，会先用这个模型把图描述成文字，再喂给聊天模型。
     */
    vision: { providerId: '', modelId: '' },
  },
  persona: {
    default: '你是一个友好、乐于助人的 AI 助手。用中文回复，简洁明了，不说教。',
    overrides: {},
  },
  plugins: { enabled: [] },
  /** 记忆系统（遗忘曲线、自动打标签、成员专属记忆） */
  memory: {
    enabled: true,
    autoTag: true,
    maxChatMemories: 120,
    maxMemberMemories: 60,
    forgetThreshold: 0.26,       // 留存率低于此值 → 准备遗忘
    pinImportance: 0.85,         // 重要度 ≥ 此值 → 永不自动遗忘
    archiveInsteadOfDelete: true,
    decay: { baseStabilityHours: 26, importanceExp: 4.6, accessBoost: 0.55, touchCooldownMs: 60000 },
    retrieve: { maxChat: 8, maxMember: 6, minScore: 0.18 },
    tag: { maxItemsPerTurn: 4, minImportance: 0.12 },
    profile: { everyN: 10 },
    sweepIntervalMinutes: 30,
  },
  /** 上下文压缩 */
  context: {
    maxTokens: 512000,           // 模型上下文上限（按 512K 设计）
    compressAtTokens: 48000,     // 超过这个 token 数就滚动压缩
    keepRecentMessages: 14,      // 压缩时保留的最近原文条数
    summaryMaxTokens: 700,
  },
  /**
   * 聊天注册表：talker(sessionId) -> {
   *   name, kind, conversationId, enabled,
   *   model: { providerId, modelId } | null,
   *   persona: string | null,
   *   style: string | null,       // 额外语气/风格要求
   *   plugins: string[] | null,   // null = 跟随全局启用列表
   *   triggerMode: string | null,
   *   notes: string
   * }
   */
  chats: {},
  rateLimit: { maxPerMinute: 10, maxPerChatPerMinute: 5 },
};

let _config = null;

export function loadDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(SECRETS_DIR, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'contexts'), { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'media', 'pending-send'), { recursive: true });
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readJsonSafe(fp, fallback) {
  try {
    return JSON.parse(stripBom(fs.readFileSync(fp, 'utf8')));
  } catch {
    return fallback;
  }
}

export async function loadConfig() {
  if (_config) return _config;
  const raw = readJsonSafe(CONFIG_PATH, null);
  _config = deepMerge(structuredClone(DEFAULT_CONFIG), raw || {});
  return _config;
}

export async function saveConfig(patch) {
  if (!_config) await loadConfig();
  _config = deepMerge(_config, patch || {});
  writeConfigSync(_config);
  return _config;
}

function writeConfigSync(cfg) {
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_PATH);
}

/** 直接替换整个配置（用于发布式修改） */
export async function replaceConfig(next) {
  _config = deepMerge(structuredClone(DEFAULT_CONFIG), next || {});
  writeConfigSync(_config);
  return _config;
}

export async function getConfig() { return loadConfig(); }

export function getConfigSync() { return _config || structuredClone(DEFAULT_CONFIG); }

function deepMerge(target, source) {
  if (!source || typeof source !== 'object') return target;
  const result = Array.isArray(target) ? [...target] : { ...target };
  for (const [k, v] of Object.entries(source)) {
    if (Array.isArray(v)) {
      result[k] = v;
    } else if (v && typeof v === 'object') {
      result[k] = deepMerge(result[k] && typeof result[k] === 'object' ? result[k] : {}, v);
    } else {
      result[k] = v;
    }
  }
  return result;
}

// ── DPAPI 密钥（Windows）────────────────────────────────────
export async function encryptSecret(plaintext) {
  const script = [
    'Add-Type -AssemblyName System.Security',
    '$bytes = [System.Text.Encoding]::UTF8.GetBytes($env:LS_PT)',
    '$enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    'Write-Output ([Convert]::ToBase64String($enc))',
  ].join('; ');
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', timeout: 15000, env: { ...process.env, LS_PT: plaintext } });
  if (r.error) throw new Error(`DPAPI encrypt failed: ${r.error.message}`);
  return (r.stdout || '').trim();
}

export async function decryptSecret(b64) {
  const script = [
    'Add-Type -AssemblyName System.Security',
    '$bytes = [Convert]::FromBase64String($env:LS_B64)',
    '$dec = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    'Write-Output ([System.Text.Encoding]::UTF8.GetString($dec))',
  ].join('; ');
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', timeout: 15000, env: { ...process.env, LS_B64: b64 } });
  if (r.error) throw new Error(`DPAPI decrypt failed: ${r.error.message}`);
  return (r.stdout || '').trim();
}

export async function saveSecret(key, plaintext) {
  const encrypted = await encryptSecret(plaintext);
  fs.mkdirSync(SECRETS_DIR, { recursive: true });
  fs.writeFileSync(path.join(SECRETS_DIR, `${key}.enc`), encrypted, 'utf8');
}

export async function loadSecret(key) {
  const fp = path.join(SECRETS_DIR, `${key}.enc`);
  if (!fs.existsSync(fp)) return null;
  try { return await decryptSecret(fs.readFileSync(fp, 'utf8').trim()); } catch { return null; }
}

export async function resolveApiKey(providerId) {
  const config = await loadConfig();
  const provider = config.ai.providers[providerId];
  if (!provider) return null;
  if (provider.apiKey) return provider.apiKey;
  const envKey = provider.apiKeyEnv;
  if (envKey && process.env[envKey]) return process.env[envKey];
  const secret = await loadSecret(`ai_${providerId}`);
  if (secret) return secret;
  return null;
}

// ── 状态文件 ───────────────────────────────────────────────
export function getStatePath(filename) {
  return path.join(DATA_DIR, filename);
}

export function readState(filename, fallback = null) {
  return readJsonSafe(getStatePath(filename), fallback);
}

export function writeState(filename, data) {
  const fp = getStatePath(filename);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf8');
}

export const ROOT_DIR = ROOT;
