/**
 * 灵枢 AI 中枢 — 记忆系统
 *
 * 设计要点（对齐「像真人一样记忆」）：
 * 1. 分层：会话级记忆（这个聊天里发生过什么）+ 群成员级记忆（每个人的兴趣/性格/关系）
 * 2. 打标签：每轮对话后由模型提取「值得记住的事」，给出重要度 0~1 与标签
 * 3. 遗忘曲线：艾宾浩斯式指数衰减 R = e^(-Δt/S)，S 由重要度与访问次数决定
 *    - 琐碎的事几天就淡掉，非常重要的事能撑几个月
 *    - 每次被回忆（命中）算一次复习，强度回升
 *    - 被遗忘不是直接删掉，先进「归档」，后台可以捞回来
 * 4. 压缩：同一会话记忆过多时，把「不重要 + 同主题」的合并成一条摘要，保住信息骨架
 * 5. 画像：成员记忆积累到一定量，自动汇总成性格/爱好画像
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, loadConfig } from './config.mjs';

const MEM_DIR = path.join(DATA_DIR, 'memory');
const SCOPE_DIR = path.join(MEM_DIR, 'scopes');
const ARCHIVE_DIR = path.join(MEM_DIR, 'archived');

const LABELS = [
  { label: '非常重要', min: 0.85 },
  { label: '重要', min: 0.65 },
  { label: '一般', min: 0.4 },
  { label: '不太重要', min: 0.2 },
  { label: '琐碎', min: 0 },
];

const DEFAULT_MEMORY_CONFIG = {
  enabled: true,
  autoTag: true,
  maxChatMemories: 120,
  maxMemberMemories: 60,
  forgetThreshold: 0.26,      // 留存率低于这个就准备遗忘
  pinImportance: 0.85,        // 重要度 ≥ 这个视为「钉住」，永不自动遗忘
  archiveInsteadOfDelete: true,
  decay: {
    baseStabilityHours: 26,   // 高中等重要度、刚记住时的半衰基础值
    importanceExp: 4.6,       // 重要度对稳定性的指数放大
    accessBoost: 0.55,        // 每复习一次的稳定性增益
    touchCooldownMs: 60 * 1000,
  },
  retrieve: { maxChat: 8, maxMember: 6, minScore: 0.18 },
  tag: {
    maxItemsPerTurn: 4,
    minImportance: 0.12,      // 低于这个直接不存
  },
  profile: { everyN: 10 },
  sweepIntervalMinutes: 30,
};

export const MEMORY_LABELS = LABELS.map(l => l.label);

// ── 基础工具 ──────────────────────────────────────────────
function ensureDirs() {
  for (const d of [MEM_DIR, SCOPE_DIR, ARCHIVE_DIR]) fs.mkdirSync(d, { recursive: true });
}

function safeName(talker) {
  return String(talker || 'unknown').replace(/[^a-zA-Z0-9_@.-]/g, '_').slice(0, 90);
}

function nowTs() { return Date.now(); }

function readJson(fp, fallback) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}

function writeJson(fp, data) {
  const tmp = `${fp}.tmp`;
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, fp);
}

export function labelFor(importance) {
  const v = Number(importance) || 0;
  return (LABELS.find(l => v >= l.min) || LABELS[LABELS.length - 1]).label;
}

/** 粗略估算 token（中文 1 字≈0.7 token，英文 4 字符≈1 token） */
export function estimateTokens(text) {
  const s = String(text || '');
  let cjk = 0, other = 0;
  for (const ch of s) {
    if (/[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk * 0.7 + other / 4);
}

export function estimateMessagesTokens(messages) {
  let total = 0;
  for (const m of messages || []) {
    total += 4;
    if (typeof m.content === 'string') total += estimateTokens(m.content);
    else if (Array.isArray(m.content)) {
      for (const p of m.content) total += estimateTokens(p.text || p.type || '') + 4;
    }
  }
  return total;
}

/** 记忆配置：全局 + 每聊天覆盖 */
export function memoryConfig(config, talker) {
  const base = { ...DEFAULT_MEMORY_CONFIG, ...(config.memory || {}) };
  base.decay = { ...DEFAULT_MEMORY_CONFIG.decay, ...(config.memory?.decay || {}) };
  base.retrieve = { ...DEFAULT_MEMORY_CONFIG.retrieve, ...(config.memory?.retrieve || {}) };
  base.tag = { ...DEFAULT_MEMORY_CONFIG.tag, ...(config.memory?.tag || {}) };

  const chat = config.chats?.[talker];
  const over = chat?.memory || {};
  const merged = {
    ...base,
    ...over,
    decay: { ...base.decay, ...(over.decay || {}) },
    retrieve: { ...base.retrieve, ...(over.retrieve || {}) },
    tag: { ...base.tag, ...(over.tag || {}) },
  };
  if (chat?.memory?.enabled === false) merged.enabled = false;
  return merged;
}

// ── 存储 ──────────────────────────────────────────────────
function scopePath(talker) { return path.join(SCOPE_DIR, `${safeName(talker)}.json`); }
function archivePath(talker) { return path.join(ARCHIVE_DIR, `${safeName(talker)}.json`); }

function emptyScope(talker, meta = {}) {
  return {
    talker,
    name: meta.name || talker,
    kind: meta.kind || (String(talker).includes('@chatroom') ? 'group' : 'private'),
    createdAt: nowTs(),
    updatedAt: nowTs(),
    chat: [],           // 会话级记忆
    members: {},        // wxid -> { name, memories: [], profile, profileAt }
    stats: { turns: 0, added: 0, forgotten: 0, compressed: 0 },
  };
}

export function loadScope(talker, meta) {
  ensureDirs();
  const s = readJson(scopePath(talker), null);
  if (!s) return emptyScope(talker, meta);
  if (!Array.isArray(s.chat)) s.chat = [];
  if (!s.members) s.members = {};
  return s;
}

export function saveScope(scope) {
  scope.updatedAt = nowTs();
  writeJson(scopePath(scope.talker), scope);
}

function loadArchive(talker) {
  return readJson(archivePath(talker), { talker, items: [] });
}
function saveArchive(talker, data) {
  writeJson(archivePath(talker), data);
}

// ── 遗忘曲线 ──────────────────────────────────────────────
/**
 * 稳定性 S（小时）：重要度指数放大 + 复习次数对数增益
 */
export function stabilityHours(mem, decay = DEFAULT_MEMORY_CONFIG.decay) {
  const imp = clamp01(mem.importance);
  const access = Math.max(0, mem.accessCount || 0);
  const base = decay.baseStabilityHours * Math.exp(imp * decay.importanceExp);
  return base * (1 + Math.log1p(access) * decay.accessBoost);
}

/** 留存率 0~1：pinned/钉住恒为 1 */
export function retention(mem, now = nowTs(), decay = DEFAULT_MEMORY_CONFIG.decay) {
  if (mem.pinned) return 1;
  const last = mem.lastAccessAt || mem.createdAt || now;
  const hours = Math.max(0, (now - last) / 3600000);
  const S = Math.max(1, stabilityHours(mem, decay));
  return Math.exp(-hours / S);
}

function clamp01(v) { return Math.max(0, Math.min(1, Number(v) || 0)); }

// ── 记忆条目 ──────────────────────────────────────────────
function makeMemory(fields = {}) {
  const importance = clamp01(fields.importance ?? 0.5);
  const ts = nowTs();
  return {
    id: crypto.randomUUID(),
    kind: fields.kind || 'fact',
    text: String(fields.text || '').trim().slice(0, 500),
    tags: (fields.tags || []).map(t => String(t).slice(0, 20)).slice(0, 6),
    importance,
    label: fields.label || labelFor(importance),
    createdAt: fields.createdAt || ts,
    lastAccessAt: fields.lastAccessAt || ts,
    accessCount: fields.accessCount || 0,
    pinned: Boolean(fields.pinned),
    source: fields.source || 'auto',          // auto | manual | compressed | profile
    sourceName: fields.sourceName || '',      // 说话人昵称
    memberName: fields.memberName || '',
    mergedFrom: fields.mergedFrom || 0,
  };
}

/** 写入记忆（自动去重：文本高度相似则合并，提升重要度） */
export function addMemories(talker, items, { meta, memberKey = null, memberName = '' } = {}) {
  const scope = loadScope(talker, meta);
  const bucket = memberKey
    ? (scope.members[memberKey] = scope.members[memberKey] || { name: memberName || memberKey, memories: [], profile: '', profileAt: 0 }).memories
    : scope.chat;

  if (memberKey && memberName) scope.members[memberKey].name = memberName;

  // 跨桶去重：同一个事实不要既在会话记忆又在成员记忆里各存一份
  const siblings = [
    ...scope.chat,
    ...Object.values(scope.members || {}).flatMap(b => b.memories || []),
  ].filter(m => !bucket.includes(m));

  const added = [];
  for (const raw of items) {
    const text = String(raw.text || '').trim();
    if (!text) continue;
    const importance = clamp01(raw.importance ?? 0.5);

    const dup = bucket.find(m => similarity(m.text, text) > 0.82);
    if (dup) {
      dup.importance = clamp01(Math.max(dup.importance, importance) + 0.05);
      dup.label = labelFor(dup.importance);
      dup.lastAccessAt = nowTs();
      dup.accessCount += 1;
      dup.tags = [...new Set([...(dup.tags || []), ...(raw.tags || [])])].slice(0, 6);
      if (text.length > dup.text.length && importance >= dup.importance - 0.1) dup.text = text;
      added.push(dup);
      continue;
    }

    const cross = siblings.find(m => similarity(m.text, text) > 0.82);
    if (cross) {
      // 别处已经有了：只提升重要度与复习次数，不重复存
      cross.importance = clamp01(Math.max(cross.importance, importance));
      cross.label = labelFor(cross.importance);
      cross.accessCount += 1;
      cross.lastAccessAt = nowTs();
      continue;
    }

    const mem = makeMemory({
      ...raw,
      importance,
      memberName: memberKey ? (memberName || memberKey) : '',
    });
    bucket.push(mem);
    added.push(mem);
  }

  scope.stats.added += added.length;
  saveScope(scope);
  return added;
}

function bigrams(text) {
  const s = String(text || '').toLowerCase().replace(/[\s，。！？、,.!?;；:："'（）()【】\[\]]+/g, '');
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  for (const w of String(text || '').toLowerCase().match(/[a-z0-9]{2,}/g) || []) out.add(w);
  return out;
}

function similarity(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const x of A) if (B.has(x)) hit++;
  return hit / Math.min(A.size, B.size);
}

// ── 检索 ──────────────────────────────────────────────────
/**
 * 给本轮对话挑出「想起来的事」
 * 分数 = 关键词命中 0.45 + 留存率 0.25 + 重要度 0.2 + 新近度 0.1
 */
export function searchMemories(talker, { query = '', memberKey = null, limit = 8, cfg, touch = false } = {}) {
  const config = cfg || { memory: DEFAULT_MEMORY_CONFIG };
  const mc = config.__mc || memoryConfig(config, talker);
  const scope = loadScope(talker);
  const now = nowTs();
  const q = bigrams(query);

  const pool = [];
  for (const m of scope.chat) pool.push({ mem: m, scope: 'chat', member: '' });
  for (const [wxid, box] of Object.entries(scope.members)) {
    for (const m of box.memories) pool.push({ mem: m, scope: 'member', member: wxid, memberName: box.name });
  }

  const scored = pool.map(({ mem, scope: sc, member, memberName: mn }) => {
    const ret = retention(mem, now, mc.decay);
    const memTerms = bigrams(mem.text + ' ' + (mem.tags || []).join(' '));
    let hit = 0;
    for (const t of q) if (memTerms.has(t)) hit++;
    const kw = q.size ? hit / q.size : 0;
    const ageH = Math.max(0, (now - (mem.createdAt || now)) / 3600000);
    const recency = 1 / (1 + ageH / 72);
    // 同一个人说的优先给这个人的专属记忆
    const memberBoost = member && memberKey && member === memberKey ? 1 : 0;
    const score = kw * 0.45 + ret * 0.25 + clamp01(mem.importance) * 0.2 + recency * 0.1 + memberBoost * 0.12;
    return { ...mem, _score: score, _retention: ret, _scope: sc, _member: member, _memberName: mn };
  });

  scored.sort((a, b) => b._score - a._score);
  const picked = scored.filter(x => x._score >= mc.retrieve.minScore).slice(0, limit);

  if (touch && picked.length) touchMemories(talker, picked.map(p => ({ id: p.id, scope: p._scope, member: p._member })));
  return picked;
}

/** 被回忆 = 复习一次：强度回升 */
export function touchMemories(talker, refs) {
  if (!refs?.length) return 0;
  const scope = loadScope(talker);
  const now = nowTs();
  let n = 0;
  const find = (list, id) => list.find(m => m.id === id);
  for (const r of refs) {
    const list = r.scope === 'member' ? scope.members?.[r.member]?.memories : scope.chat;
    const mem = list && find(list, r.id);
    if (!mem) continue;
    mem.accessCount = (mem.accessCount || 0) + 1;
    mem.lastAccessAt = now;
    // 复习会让重要度略微上浮，但不超过 1
    mem.importance = clamp01(mem.importance + 0.03);
    mem.label = labelFor(mem.importance);
    n++;
  }
  if (n) saveScope(scope);
  return n;
}

/** 组装注入给模型的记忆提示词 */
export function buildMemoryPrompt(talker, { query = '', memberKey = null, memberName = '', cfg } = {}) {
  const config = cfg || {};
  const mc = memoryConfig(config, talker);
  if (!mc.enabled) return { prompt: '', used: [] };

  const picked = searchMemories(talker, {
    query,
    memberKey,
    limit: mc.retrieve.maxChat + mc.retrieve.maxMember,
    cfg: { ...config, __mc: mc },
    touch: true,
  });
  if (!picked.length) return { prompt: '', used: [] };

  const chatItems = picked.filter(p => p._scope === 'chat');
  const memberItems = picked.filter(p => p._scope === 'member');

  const lines = [];
  if (memberItems.length) {
    lines.push('【你记得关于聊天对象的事】');
    for (const m of memberItems.slice(0, mc.retrieve.maxMember)) {
      const who = m._memberName || m.memberName || '对方';
      lines.push(`- ${who}：${m.text}${m.tags?.length ? `（${m.tags.join('/')}）` : ''}`);
    }
  }
  if (chatItems.length) {
    lines.push('【这个聊天里你记得的事】');
    for (const m of chatItems.slice(0, mc.retrieve.maxChat)) {
      lines.push(`- ${m.text}${m.tags?.length ? `（${m.tags.join('/')}）` : ''}`);
    }
  }
  if (!lines.length) return { prompt: '', used: [] };

  const prompt = [
    ...lines,
    '以上是你凭记忆想起的旧事。自然地运用它们（别生硬复述），如果和当前话题无关就忽略。',
  ].join('\n');

  return { prompt, used: picked };
}

// ── 遗忘 ──────────────────────────────────────────────────
/**
 * 扫描所有会话，按遗忘曲线处理：
 * - 留存率 < 阈值 且 未钉住 → 归档（或删除）
 * - 重要度高于 pinImportance 的永不自动遗忘
 */
export function runForgetting({ talker = null, dryRun = false, cfg = null } = {}) {
  ensureDirs();
  const config = cfg || {};
  const files = talker ? [scopePath(talker)] : listScopeFiles();
  const report = { scanned: 0, forgotten: [], kept: 0, archived: 0 };

  for (const fp of files) {
    const scope = readJson(fp, null);
    if (!scope?.talker) continue;
    const mc = memoryConfig(config, scope.talker);
    if (!mc.enabled) continue;

    const now = nowTs();
    const archive = loadArchive(scope.talker);
    let changed = false;

    const sweep = (list, label) => {
      const keep = [];
      for (const mem of list) {
        report.scanned++;
        const ret = retention(mem, now, mc.decay);
        const pinned = mem.pinned || mem.importance >= mc.pinImportance;
        if (!pinned && ret < mc.forgetThreshold) {
          report.forgotten.push({
            talker: scope.talker, scope: label, id: mem.id,
            text: mem.text.slice(0, 60), importance: mem.importance,
            retention: Number(ret.toFixed(3)), label: mem.label,
          });
          if (!dryRun) {
            if (mc.archiveInsteadOfDelete) {
              archive.items.push({ ...mem, _forgottenAt: now, _retention: ret, _scopeLabel: label });
              if (archive.items.length > 600) archive.items = archive.items.slice(-600);
              report.archived++;
            }
            scope.stats.forgotten = (scope.stats.forgotten || 0) + 1;
            changed = true;
          } else {
            keep.push(mem);
          }
        } else {
          keep.push(mem);
          report.kept++;
        }
      }
      return keep;
    };

    const newChat = sweep(scope.chat, 'chat');
    for (const box of Object.values(scope.members || {})) {
      box.memories = sweep(box.memories, 'member');
    }
    if (!dryRun) {
      scope.chat = newChat;
      if (!dryRun && archive.items.length) saveArchive(scope.talker, archive);
      if (changed) saveScope(scope);
    }
  }
  return report;
}

function listScopeFiles() {
  ensureDirs();
  try {
    return fs.readdirSync(SCOPE_DIR).filter(f => f.endsWith('.json')).map(f => path.join(SCOPE_DIR, f));
  } catch { return []; }
}

// ── 压缩 ──────────────────────────────────────────────────
/**
 * 记忆太多时压缩：把「不重要 + 同 kind/同标签」的合并成一条摘要记忆
 * AI 可用时让它归纳，否则做朴素拼接
 */
export async function compactScope(talker, { aiClient = null, cfg = null, force = false } = {}) {
  const config = cfg || {};
  const mc = memoryConfig(config, talker);
  const scope = loadScope(talker);
  const result = { chat: 0, members: {}, merged: 0 };

  const compactList = async (list, limit, label) => {
    if (list.length <= limit && !force) return list;
    if (list.length < 6) return list;

    // 挑出可以压缩的：未钉住、重要度低、从旧到新
    const candidates = list
      .filter(m => !m.pinned && m.importance < 0.7)
      .sort((a, b) => (a.lastAccessAt || a.createdAt) - (b.lastAccessAt || b.createdAt));
    if (candidates.length < 4) return list;

    const overflow = force ? Math.max(4, Math.floor(candidates.length / 2)) : list.length - limit + 2;
    const take = candidates.slice(0, Math.max(3, overflow));
    const rest = list.filter(m => !take.includes(m));

    // 按 kind 聚簇
    const groups = new Map();
    for (const m of take) {
      const key = m.kind || 'fact';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }

    const digests = [];
    for (const [kind, items] of groups) {
      const detail = items.map(m => m.text).join('；');
      let text = `（浓缩记忆·${kind}）${detail}`;
      if (aiClient && detail.length > 120) {
        try {
          const r = await aiClient.chat([
            { role: 'system', content: '你是记忆压缩器。把多条零散记忆合并成一句不超过 80 字的摘要，保留人名/偏好/关键事实，不要评论。只输出摘要本身。' },
            { role: 'user', content: detail.slice(0, 2000) },
          ], { maxTokens: 200, temperature: 0.2 });
          if (r.content?.trim()) text = `（浓缩记忆·${kind}）${r.content.trim().slice(0, 160)}`;
        } catch { /* 用朴素拼接 */ }
      }
      const maxImp = Math.max(...items.map(m => m.importance));
      digests.push(makeMemory({
        kind,
        text,
        tags: [...new Set(items.flatMap(m => m.tags || []))].slice(0, 5),
        importance: clamp01(maxImp * 0.9 + 0.05),
        source: 'compressed',
        accessCount: Math.min(3, items.reduce((s, m) => s + (m.accessCount || 0), 0)),
        mergedFrom: items.length,
      }));
      result.merged += items.length;
    }

    return [...rest, ...digests];
  };

  scope.chat = await compactList(scope.chat, mc.maxChatMemories, 'chat');
  for (const [wxid, box] of Object.entries(scope.members || {})) {
    const before = box.memories.length;
    box.memories = await compactList(box.memories, mc.maxMemberMemories, 'member');
    result.members[wxid] = before - box.memories.length;
  }
  scope.stats.compressed = (scope.stats.compressed || 0) + result.merged;
  saveScope(scope);
  result.chat = scope.chat.length;
  return result;
}

// ── 成员画像 ──────────────────────────────────────────────
export async function rebuildProfile(talker, memberKey, { aiClient = null, cfg = null } = {}) {
  const scope = loadScope(talker);
  const box = scope.members?.[memberKey];
  if (!box || !box.memories.length) return null;

  const list = [...box.memories]
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 30)
    .map(m => `- ${m.text}`)
    .join('\n');

  let profile = '';
  if (aiClient) {
    try {
      const r = await aiClient.chat([
        { role: 'system', content: '你是人物画像生成器。根据记忆条目，用 100 字内描述这个人的性格、兴趣、说话习惯、和我的关系。不要编造，只基于给出的事实。只输出画像本身。' },
        { role: 'user', content: `人物：${box.name}\n记忆：\n${list}` },
      ], { maxTokens: 300, temperature: 0.5 });
      profile = (r.content || '').trim().slice(0, 400);
    } catch { /* 忽略 */ }
  }
  if (!profile) profile = list.replace(/\n/g, '；').slice(0, 300);

  box.profile = profile;
  box.profileAt = nowTs();
  saveScope(scope);
  return { member: memberKey, name: box.name, profile };
}

// ── 每轮对话后沉淀 ────────────────────────────────────────
const TAG_SYSTEM = `你是「记忆整理器」。读一段对话，只提取值得长期记住的信息。

判定标准：
- 非常重要(0.85~1)：身份、明确偏好、重要约定、亲密关系、健康/家庭等长期事实
- 重要(0.65~0.84)：稳定兴趣、习惯、工作学习情况、对事物的态度
- 一般(0.4~0.64)：有信息量的日常安排、近期计划
- 不太重要(0.2~0.39)：一次性的琐碎信息、随口一提
- 琐碎(0~0.19)：寒暄、语气词、没有任何信息量的内容

规则：
- 不要记录机器人自己说的话，只记用户透露的信息
- 不要记录「用户问了一个问题」这种交互事实
- 每条不超过 40 字，用陈述句，第三人称（如「喜欢猫，家里养了两只」）
- 没有值得记的内容就返回空数组

只输出 JSON，不要 markdown：
{"importance":0.0-1.0,"label":"非常重要|重要|一般|不太重要|琐碎","tags":["标签"],"items":[{"kind":"fact|preference|event|profile|relation","text":"...","importance":0.0-1.0,"tags":["..."],"member":"说话人昵称，不知道就空"}]}`;

/**
 * 观察一轮对话 → 打标签 → 写入记忆
 * @returns {{importance:number,label:string,tags:string[],added:number}}
 */
export async function observeTurn({
  talker, kind, userName = '', userWxid = '', userText = '', botText = '', history = [], aiClient, cfg,
}) {
  const config = cfg || await loadConfig();
  const mc = memoryConfig(config, talker);
  if (!mc.enabled || !mc.autoTag) return { skipped: 'memory_off' };
  if (!userText?.trim() || userText.trim().length < 2) return { skipped: 'empty_input' };
  if (!aiClient) return { skipped: 'no_ai' };

  const scope = loadScope(talker, { kind });
  scope.stats.turns = (scope.stats.turns || 0) + 1;
  saveScope(scope);

  const historyBlock = (history || []).slice(-6)
    .map(m => `${m.role === 'user' ? (userName || '用户') : '我'}：${String(m.content || '').slice(0, 160)}`)
    .join('\n');

  let parsed = null;
  try {
    const r = await aiClient.chat([
      { role: 'system', content: TAG_SYSTEM },
      {
        role: 'user',
        content: [
          `会话类型：${kind === 'group' ? '群聊' : '私聊'}`,
          historyBlock ? `最近对话：\n${historyBlock}` : '',
          `本轮新消息（${userName || '用户'}）：${userText.slice(0, 800)}`,
          botText ? `我的回复：${botText.slice(0, 300)}` : '',
        ].filter(Boolean).join('\n\n'),
      },
    ], { maxTokens: 700, temperature: 0.2 });
    const raw = String(r.content || '');
    const jsonText = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
    parsed = JSON.parse(jsonText);
  } catch (e) {
    return { skipped: 'tag_failed', error: e.message };
  }

  const items = (parsed.items || [])
    .filter(it => it && it.text && Number(it.importance ?? parsed.importance ?? 0.5) >= mc.tag.minImportance)
    .slice(0, mc.tag.maxItemsPerTurn);

  let added = 0;
  const chatItems = [];
  const memberItems = [];

  for (const it of items) {
    // 关于「这个人」的（身份/偏好/性格/关系）→ 他的专属记忆
    // 关于「这个聊天里发生的事」→ 会话记忆
    if (userWxid && it.kind !== 'event') memberItems.push(it);
    else chatItems.push(it);
  }

  if (chatItems.length) {
    added += addMemories(talker, chatItems, { meta: { kind } }).length;
  }
  if (memberItems.length && userWxid) {
    added += addMemories(talker, memberItems, {
      meta: { kind },
      memberKey: userWxid,
      memberName: userName || userWxid,
    }).length;

    // 画像定期重建
    const scope2 = loadScope(talker);
    const box = scope2.members?.[userWxid];
    if (box && box.memories.length >= mc.profile.everyN && box.memories.length % mc.profile.everyN === 0) {
      rebuildProfile(talker, userWxid, { aiClient, cfg: config }).catch(() => {});
    }
  }

  return {
    importance: clamp01(parsed.importance ?? 0.5),
    label: parsed.label || labelFor(parsed.importance ?? 0.5),
    tags: parsed.tags || [],
    added,
  };
}

// ── 后台管理所需的查询 ────────────────────────────────────
export function listScopes() {
  const out = [];
  for (const fp of listScopeFiles()) {
    const s = readJson(fp, null);
    if (!s?.talker) continue;
    const now = nowTs();
    const mc = { decay: DEFAULT_MEMORY_CONFIG.decay };
    const chatCount = s.chat?.length || 0;
    const memberCount = Object.keys(s.members || {}).length;
    const memberMemories = Object.values(s.members || {}).reduce((n, b) => n + (b.memories?.length || 0), 0);
    const fading = [...(s.chat || []), ...Object.values(s.members || {}).flatMap(b => b.memories || [])]
      .filter(m => retention(m, now, mc.decay) < 0.4).length;
    out.push({
      talker: s.talker,
      name: s.name,
      kind: s.kind,
      chatCount,
      memberCount,
      memberMemories,
      total: chatCount + memberMemories,
      fading,
      stats: s.stats || {},
      updatedAt: s.updatedAt,
    });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getScopeDetail(talker, { withRetention = true } = {}) {
  const scope = loadScope(talker);
  const now = nowTs();
  const decorate = (m) => ({
    ...m,
    retention: Number(retention(m, now).toFixed(3)),
    stabilityHours: Math.round(stabilityHours(m)),
    ageHours: Math.round((now - (m.createdAt || now)) / 3600000),
    idleHours: Math.round((now - (m.lastAccessAt || m.createdAt || now)) / 3600000),
  });
  return {
    talker: scope.talker,
    name: scope.name,
    kind: scope.kind,
    chat: withRetention ? scope.chat.map(decorate) : scope.chat,
    members: Object.fromEntries(Object.entries(scope.members || {}).map(([k, v]) => [k, {
      name: v.name,
      profile: v.profile || '',
      profileAt: v.profileAt || 0,
      memories: withRetention ? (v.memories || []).map(decorate) : (v.memories || []),
    }])),
    stats: scope.stats || {},
    updatedAt: scope.updatedAt,
  };
}

export function updateMemory(talker, id, patch, { memberKey = null } = {}) {
  const scope = loadScope(talker);
  const list = memberKey ? scope.members?.[memberKey]?.memories : scope.chat;
  if (!list) return null;
  const mem = list.find(m => m.id === id);
  if (!mem) return null;
  for (const k of ['text', 'kind', 'tags', 'pinned']) {
    if (patch[k] !== undefined) mem[k] = patch[k];
  }
  if (patch.importance !== undefined) {
    mem.importance = clamp01(patch.importance);
    mem.label = labelFor(mem.importance);
  }
  if (patch.resetDecay) mem.lastAccessAt = nowTs();
  saveScope(scope);
  return mem;
}

export function deleteMemory(talker, id, { memberKey = null, archive = true } = {}) {
  const scope = loadScope(talker);
  const list = memberKey ? scope.members?.[memberKey]?.memories : scope.chat;
  if (!list) return false;
  const idx = list.findIndex(m => m.id === id);
  if (idx < 0) return false;
  const [mem] = list.splice(idx, 1);
  if (archive) {
    const ar = loadArchive(talker);
    ar.items.push({ ...mem, _forgottenAt: nowTs(), _scopeLabel: memberKey ? 'member-manual' : 'chat-manual' });
    saveArchive(talker, ar);
  }
  saveScope(scope);
  return true;
}

export function getArchive(talker) {
  const ar = loadArchive(talker);
  return (ar.items || []).slice(-200).reverse();
}

export function restoreFromArchive(talker, id) {
  const ar = loadArchive(talker);
  const idx = (ar.items || []).findIndex(m => m.id === id);
  if (idx < 0) return false;
  const [mem] = ar.items.splice(idx, 1);
  saveArchive(talker, ar);
  const scope = loadScope(talker);
  mem.lastAccessAt = nowTs();
  mem.createdAt = mem.createdAt || nowTs();
  const isMember = mem._scopeLabel?.startsWith('member') && mem.memberName;
  const key = Object.entries(scope.members || {}).find(([, v]) => v.name === mem.memberName)?.[0];
  if (isMember && key) scope.members[key].memories.push(mem);
  else scope.chat.push(mem);
  saveScope(scope);
  return true;
}

export function memoryStats() {
  const scopes = listScopes();
  return {
    scopes: scopes.length,
    totalChat: scopes.reduce((n, s) => n + s.chatCount, 0),
    totalMember: scopes.reduce((n, s) => n + s.memberMemories, 0),
    fading: scopes.reduce((n, s) => n + s.fading, 0),
    items: scopes,
  };
}

/** 定期巡检：遗忘 + 超额压缩 */
export async function sweepAll({ aiClient = null, cfg = null } = {}) {
  const config = cfg || await loadConfig();
  const forget = runForgetting({ cfg: config });
  const compactResults = [];
  for (const s of listScopes()) {
    const mc = memoryConfig(config, s.talker);
    if (!mc.enabled) continue;
    if (s.chatCount > mc.maxChatMemories || s.memberMemories > mc.maxMemberMemories * Math.max(1, s.memberCount)) {
      compactResults.push({ talker: s.talker, ...(await compactScope(s.talker, { aiClient, cfg: config })) });
    }
  }
  return { forget, compact: compactResults };
}

export { DEFAULT_MEMORY_CONFIG };
