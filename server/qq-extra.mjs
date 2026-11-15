/**
 * QQ 扩展能力：记忆同步 / 定时发送 / 通用 OneBot 动作
 * 纯本地，不依赖 NapCat 在线即可配置；执行时才需要连上。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR, loadConfig, saveConfig } from './config.mjs';
import { loadScope, saveScope, clearScope } from './memory.mjs';
import { ChatContext } from './router.mjs';

const FILE = path.join(ROOT_DIR, 'data', 'qq-extra.json');

function read() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8').replace(/^\uFEFF/, ''));
    return { links: [], schedules: [], ...d };
  } catch { return { links: [], schedules: [] }; }
}
function write(d) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
}

// ── 聊天室：多端共享设置 / 历史 / 记忆 ─────────────────────
const SYNC_PARTS = ['memory', 'history', 'persona', 'model', 'voice', 'vision', 'profile'];

/** 统一成 { platforms: ['wx','qq'], members: [{platform,talker,name}] } */
function normalizeRoom(r) {
  const fixTalker = (t) => String(t || '').replace(/^qq:qq:/, 'qq:');
  return {
    id: r.id,
    name: r.name || '未命名聊天室',
    members: (r.members || []).map(m => {
      const talker = fixTalker(m.talker);
      return {
        platform: m.platform || (talker.startsWith('qq:') ? 'qq' : 'wx'),
        talker,
        name: m.name || talker,
      };
    }),
    sync: { messages: true, settings: true, memory: true, ...(r.sync || {}) },
    parts: { ...Object.fromEntries(SYNC_PARTS.map(k => [k, true])), ...(r.parts || {}) },
    createdAt: r.createdAt || Date.now(),
    lastSync: r.lastSync || 0,
  };
}

/** 把老的 links 迁移成 2 人聊天室（只做一次） */
function migrate(d) {
  if (d.migratedRooms) return d;
  d.rooms = d.rooms || [];
  for (const l of d.links || []) {
    const id = `room-${l.id}`;
    if (d.rooms.some(r => r.id === id)) continue;
    // 老数据的 qqTarget 可能是 private:xxx，也可能已经带了 qq: 前缀，统一成一个
    const qqTalker = `qq:${String(l.qqTarget || '').replace(/^qq:/, '')}`;
    d.rooms.push({
      id,
      name: `${l.wxTalker} ⇄ ${String(l.qqTarget || '').replace(/^qq:/, '')}`,
      members: [
        { platform: 'wx', talker: l.wxTalker, name: l.wxTalker },
        { platform: 'qq', talker: qqTalker, name: String(l.qqTarget || '').replace(/^qq:/, '') },
      ],
      sync: { messages: true, settings: true, memory: true },
      parts: l.parts || {},
      createdAt: l.createdAt || Date.now(),
      lastSync: l.lastSync || 0,
    });
  }
  d.migratedRooms = true;
  return d;
}

function readAll() { return migrate(read()); }

export function listRooms() {
  return readAll().rooms.map(normalizeRoom);
}

export function createRoom({ name, members = [], sync = null, parts = null }) {
  const list = (members || []).filter(m => m && m.talker);
  if (!list.length) throw new Error('至少要选一个会话');
  const d = readAll();
  const item = normalizeRoom({
    id: `room-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: name || '新聊天室',
    members: list,
    sync: sync || {},
    parts: parts || {},
    createdAt: Date.now(),
  });
  d.rooms.push(item);
  write(d);
  return item;
}

export function deleteRoom(id) {
  const d = readAll();
  d.rooms = d.rooms.filter(r => r.id !== id);
  write(d);
  return { ok: true };
}

export function updateRoom(id, patch = {}) {
  const d = readAll();
  const it = d.rooms.find(r => r.id === id);
  if (!it) throw new Error('没有这个聊天室');
  if (patch.name !== undefined) it.name = patch.name;
  if (patch.members) it.members = patch.members;
  if (patch.sync) it.sync = { ...(it.sync || {}), ...patch.sync };
  if (patch.parts) it.parts = { ...(it.parts || {}), ...patch.parts };
  write(d);
  return normalizeRoom(it);
}

export function addRoomMember(id, member) {
  const d = readAll();
  const it = d.rooms.find(r => r.id === id);
  if (!it) throw new Error('没有这个聊天室');
  const t = String(member.talker || '');
  if (!t) throw new Error('缺少会话');
  if (it.members.some(m => m.talker === t)) return normalizeRoom(it);
  it.members.push({
    platform: member.platform || (t.startsWith('qq:') ? 'qq' : 'wx'),
    talker: t,
    name: member.name || t,
  });
  write(d);
  return normalizeRoom(it);
}

export function removeRoomMember(id, talker) {
  const d = readAll();
  const it = d.rooms.find(r => r.id === id);
  if (!it) throw new Error('没有这个聊天室');
  it.members = it.members.filter(m => m.talker !== talker);
  write(d);
  return normalizeRoom(it);
}

// ── 记忆合并 ──
function flatten(scope) {
  const out = [];
  for (const m of scope.chat || []) if (String(m.text || '').trim()) out.push(m);
  for (const [key, bucket] of Object.entries(scope.members || {})) {
    for (const m of bucket?.memories || []) {
      if (!String(m.text || '').trim()) continue;
      out.push({ ...m, text: `[${bucket.name || key}] ${String(m.text).trim()}` });
    }
  }
  return out;
}

/** 把 src 的记忆搬进 dst，带上来源平台标记 */
function mergeMemories(srcTalker, dstTalker, { tag = '' } = {}) {
  const a = loadScope(srcTalker, null);
  const b = loadScope(dstTalker, null);
  const seen = new Set(flatten(b).map(m => String(m.text || '').trim()).filter(Boolean));
  let added = 0;
  for (const m of flatten(a)) {
    const t = String(m.text || '').trim();
    if (!t || seen.has(t)) continue;
    b.chat.push({
      ...m,
      text: tag ? `${tag}${t}` : t,
      id: m.id || `sync-${Date.now()}-${added}`,
      syncedFrom: srcTalker,
      syncedAt: Date.now(),
    });
    seen.add(t);
    added++;
  }
  if (added) saveScope(b);
  return added;
}

function mergeHistory(srcTalker, dstTalker) {
  const src = new ChatContext(srcTalker);
  const dst = new ChatContext(dstTalker);
  const srcMsgs = src.getMessages(100000) || [];
  const exist = new Set((dst.getMessages(100000) || []).map(m => `${m.ts}|${m.role}|${String(m.content || '').slice(0, 80)}`));
  let added = 0;
  for (const m of srcMsgs) {
    const key = `${m.ts}|${m.role}|${String(m.content || '').slice(0, 80)}`;
    if (exist.has(key)) continue;
    dst.addMessage(m.role, m.content, { ts: m.ts, mirrored: true, syncedFrom: srcTalker });
    exist.add(key);
    added++;
  }
  return added;
}

// QQ 独有的设置键：同步时不能拿微信的覆盖过去，各端保留自己的
const QQ_ONLY_KEYS = ['qqExtra', 'qqActions', 'qqVoiceFormat', 'recordProtocol'];

async function copySettings(srcTalker, dstTalker, parts) {
  const cfg = await loadConfig();
  const src = cfg.chats?.[srcTalker];
  if (!src) return 0;
  const patch = {};
  if (parts.persona) {
    if (src.persona !== undefined) patch.persona = src.persona;
    if (src.personaId !== undefined) patch.personaId = src.personaId;
    if (src.style !== undefined) patch.style = src.style;
  }
  if (parts.model && src.model) patch.model = { ...src.model };
  if (parts.voice && src.voice) patch.voice = JSON.parse(JSON.stringify(src.voice));
  if (parts.vision && src.vision) patch.vision = { ...src.vision };
  if (parts.context && src.context) patch.context = { ...src.context };
  // 把 QQ 独有的键剔除，目标端保留自己的值
  for (const k of QQ_ONLY_KEYS) {
    if (k in patch) delete patch[k];
    if (patch.voice && typeof patch.voice === 'object') delete patch.voice[k];
  }
  if (!Object.keys(patch).length) return 0;
  const cur = cfg.chats?.[dstTalker] || { name: dstTalker, kind: 'private', conversationId: '', enabled: true };
  await saveConfig({ chats: { [dstTalker]: { ...cur, ...patch } } });
  return Object.keys(patch).length;
}

/** 清空某个会话的聊天记录与记忆（覆盖式同步用） */
export function wipeTalker(talker) {
  let msgs = 0;
  try {
    const ctx = new ChatContext(talker);
    msgs = (ctx.data.messages || []).length;
    ctx.data.messages = [];
    ctx._save();
  } catch { /* ignore */ }
  let mems = 0;
  try {
    const s = loadScope(talker, null);
    mems = (s.chat || []).length + Object.values(s.members || {}).reduce((n, b) => n + (b.memories || []).length, 0);
    clearScope(talker, { archive: false });
  } catch { /* ignore */ }
  return { msgs, mems };
}

/**
 * 建立聊天池：两个会话共用一套设置/记忆/历史。
 *   direction: a2b = 用 A 覆盖 B；b2a = 用 B 覆盖 A；merge = 双向补齐（不清空）
 *   wipe: 覆盖前是否清空目标端旧数据
 */
export async function createPool({ a, b, direction = 'a2b', wipe = true, name = '', parts = null }) {
  const A = String(a || '').trim();
  const B = String(b || '').trim();
  if (!A || !B) throw new Error('两个会话都要选');
  if (A === B) throw new Error('不能把同一个会话和自己同步');

  const label = (t) => (t.startsWith('qq:') ? 'QQ ' + t.replace(/^qq:/, '').replace(/^private:/, '') : t);

  // 同一个聊天池已存在就复用
  const existed = readAll().rooms.find(r =>
    (r.members || []).length === 2 &&
    r.members.some(m => m.talker === A) && r.members.some(m => m.talker === B));
  let room = existed ? normalizeRoom(existed) : null;
  if (!room) {
    room = createRoom({
      name: name || `${label(A)} ⇄ ${label(B)}`,
      members: [
        { platform: A.startsWith('qq:') ? 'qq' : 'wx', talker: A, name: label(A) },
        { platform: B.startsWith('qq:') ? 'qq' : 'wx', talker: B, name: label(B) },
      ],
      parts: parts || {},
    });
  }

  const stats = { wiped: null, msgs: 0, mems: 0, settings: 0, direction };
  const memParts = room.parts;
  const doCopy = async (src, dst) => {
    if (wipe && direction !== 'merge') stats.wiped = wipeTalker(dst);
    stats.settings += await copySettings(src, dst, memParts);
    if (memParts.memory) stats.mems += mergeMemories(src, dst, { tag: src.startsWith('qq:') ? '[QQ] ' : '[微信] ' });
    if (memParts.history) stats.msgs += mergeHistory(src, dst);
  };

  if (direction === 'a2b') await doCopy(A, B);
  else if (direction === 'b2a') await doCopy(B, A);
  else {
    stats.settings += await copySettings(A, B, memParts);
    stats.settings += await copySettings(B, A, memParts);
    stats.mems += mergeMemories(A, B, { tag: A.startsWith('qq:') ? '[QQ] ' : '[微信] ' });
    stats.mems += mergeMemories(B, A, { tag: B.startsWith('qq:') ? '[QQ] ' : '[微信] ' });
    stats.msgs += mergeHistory(A, B);
    stats.msgs += mergeHistory(B, A);
  }

  const dd = readAll();
  const it = dd.rooms.find(r => r.id === room.id);
  if (it) { it.lastSync = Date.now(); write(dd); }
  return { room, stats };
}

/** 两个会话是否已经在同一个聊天池（避免重复建） */
export function poolOf(talker) {
  return listRooms().find(r => (r.members || []).some(m => m.talker === talker)) || null;
}



const roomOf = (talker) => {
  const room = readAll().rooms.find(r => (r.members || []).some(m => m.talker === talker));
  return room ? normalizeRoom(room) : null;
};

/** 全量同步一个聊天室：以第一个成员为基准，推给其他成员（再反向补记忆/历史） */
export async function syncRoom(id) {
  const d = readAll();
  const raw = d.rooms.find(r => r.id === id);
  if (!raw) throw new Error('没有这个聊天室');
  const room = normalizeRoom(raw);
  const [lead, ...rest] = room.members;
  let moved = 0, settings = 0;

  // 设置：所有人统一成 lead 的（聊天室共享一套）
  if (room.sync.settings) {
    for (const m of rest) settings += await copySettings(lead.talker, m.talker, room.parts);
    // 首个是 QQ 且微信是基准反过来的情况也补齐
    if (lead.platform === 'qq') {
      const wx = rest.find(x => x.platform !== 'qq');
      if (wx) settings += await copySettings(wx.talker, lead.talker, room.parts);
    }
  }
  // 记忆/历史：两两合并，保证每端都有全部内容
  if (room.sync.memory || room.parts.memory) {
    for (const m of rest) moved += mergeMemories(lead.talker, m.talker, { tag: lead.platform === 'qq' ? '[QQ] ' : '[微信] ' });
    for (const m of rest) moved += mergeMemories(m.talker, lead.talker, { tag: m.platform === 'qq' ? '[QQ] ' : '[微信] ' });
  }
  if (room.sync.messages || room.parts.history) {
    for (const m of rest) moved += mergeHistory(lead.talker, m.talker);
    for (const m of rest) moved += mergeHistory(m.talker, lead.talker);
  }

  const dd = readAll();
  const it = dd.rooms.find(r => r.id === id);
  if (it) { it.lastSync = Date.now(); write(dd); }
  return { moved, settings };
}

export async function syncAllRooms() {
  const rooms = listRooms();
  let moved = 0, settings = 0;
  for (const r of rooms) {
    const x = await syncRoom(r.id);
    moved += x.moved; settings += x.settings;
  }
  return { rooms: rooms.length, moved, settings };
}

/**
 * 实时镜像：某端聊完一轮，立刻写进同聊天室其它端的历史 + 记忆。
 * 消息带 fromPlatform，对端 AI 知道「这条是微信发来的」。
 */
export async function mirrorTurn(talker, { userText = '', aiText = '' } = {}) {
  const room = roomOf(talker);
  if (!room) return [];
  const me = room.members.find(m => m.talker === talker);
  const tag = me?.platform === 'qq' ? 'QQ' : '微信';
  const others = room.members.filter(m => m.talker !== talker);
  const done = [];

  for (const o of others) {
    if (room.sync.messages || room.parts.history) {
      const ctx = new ChatContext(o.talker);
      if (userText) ctx.addMessage('user', userText, { mirrored: true, fromPlatform: tag, originTalker: talker });
      if (aiText) ctx.addMessage('assistant', aiText, { mirrored: true, fromPlatform: tag, originTalker: talker });
    }
    if (room.sync.memory || room.parts.memory) {
      try { mergeMemories(talker, o.talker, { tag: `[${tag}] ` }); } catch { /* ignore */ }
    }
    done.push(o.talker);
  }
  return done;
}

/** 某端改了设置后，把改动推给同聊天室其他端（最后写入者获胜） */
export async function propagateSettings(talker) {
  const room = roomOf(talker);
  if (!room || !room.sync.settings) return 0;
  let n = 0;
  for (const o of room.members.filter(m => m.talker !== talker)) {
    n += await copySettings(talker, o.talker, room.parts);
  }
  return n;
}

/** 兼容旧接口 */
export function listMemoryLinks() {
  return listRooms().map(r => ({
    id: r.id, wxTalker: (r.members.find(m => m.platform !== 'qq') || {}).talker || '',
    qqTarget: (r.members.find(m => m.platform === 'qq') || {}).talker?.replace(/^qq:/, '') || '',
    direction: 'both', parts: r.parts, createdAt: r.createdAt, lastSync: r.lastSync,
  }));
}
export function addMemoryLink({ wxTalker, qqTarget, direction, parts }) {
  return createRoom({
    name: `${wxTalker} ⇄ ${qqTarget}`,
    members: [
      { platform: 'wx', talker: wxTalker, name: wxTalker },
      { platform: 'qq', talker: `qq:${qqTarget}`, name: qqTarget },
    ],
    parts: parts || {},
  });
}
export function removeMemoryLink(id) { return deleteRoom(id); }
export function updateMemoryLink(id, patch) { return updateRoom(id, patch); }
export function syncMemoryLink(id) { return syncRoom(typeof id === 'string' ? id : id.id); }
export async function syncAllMemory() { return syncAllRooms(); }
export function qqScopeId(target) { return `qq:${target}`; }
export function broadcastMemory(talker) {
  const room = roomOf(talker);
  if (!room) return [];
  const me = room.members.find(m => m.talker === talker);
  const tag = me?.platform === 'qq' ? '[QQ] ' : '[微信] ';
  return room.members
    .filter(m => m.talker !== talker)
    .map(m => ({ other: m.talker, added: mergeMemories(talker, m.talker, { tag }) }));
}

// ── 定时 / 循环发送 ────────────────────────────────────────
export function listSchedules() { return read().schedules; }

export function addSchedule({ target, text, at = null, everyMinutes = 0, enabled = true }) {
  if (!target || !text) throw new Error('目标和内容不能为空');
  const d = read();
  const item = {
    id: `sch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    target, text: String(text).slice(0, 2000),
    at: at ? Number(at) : null,
    everyMinutes: Number(everyMinutes) || 0,
    enabled: Boolean(enabled), lastRun: 0, createdAt: Date.now(),
  };
  d.schedules.push(item); write(d);
  return item;
}

export function removeSchedule(id) {
  const d = read();
  d.schedules = d.schedules.filter(x => x.id !== id);
  write(d);
  return { ok: true };
}

export function toggleSchedule(id, enabled) {
  const d = read();
  const it = d.schedules.find(x => x.id === id);
  if (!it) throw new Error('没有这条定时');
  it.enabled = !!enabled; write(d);
  return it;
}

/** 返回此刻该发的条目，并标记已执行 */
export function dueSchedules(now = Date.now()) {
  const d = read();
  const due = [];
  let changed = false;
  for (const s of d.schedules) {
    if (!s.enabled) continue;
    let hit = false;
    if (s.at && !s.lastRun && now >= s.at) hit = true;
    else if (s.everyMinutes > 0 && now - (s.lastRun || s.createdAt) >= s.everyMinutes * 60000) hit = true;
    if (hit) { due.push(s); s.lastRun = now; changed = true; }
  }
  if (changed) write(d);
  return due;
}

// ── 通用 OneBot 动作（QQ 空间 / 头像等扩展能力） ──────────
/**
 * 这些动作不在 OneBot 11 标准里，由 NapCat 自行实现，不同版本支持度不同。
 * 调不通时会把 NapCat 的原始错误返回，不做假装成功。
 */
export const QQ_EXTENDED_ACTIONS = [
  { action: 'set_qq_avatar', label: '换头像', params: 'file（base64:// 或本地路径）', risk: 'high', ok: true },
  { action: 'set_self_longnick', label: '改个性签名', params: 'longNick', risk: 'medium', ok: true },
  { action: 'send_like', label: '给好友点赞', params: 'user_id, times（不能给自己点）', risk: 'low', ok: true },
  { action: 'set_group_card', label: '改群名片', params: 'group_id, user_id, card', risk: 'medium', ok: true },
  { action: 'set_group_name', label: '改群名', params: 'group_id, group_name', risk: 'high', ok: true },
  { action: 'set_group_kick', label: '踢人', params: 'group_id, user_id', risk: 'high', ok: true },
  { action: 'set_group_ban', label: '禁言', params: 'group_id, user_id, duration', risk: 'high', ok: true },
  { action: 'send_group_sign', label: '群打卡', params: 'group_id', risk: 'low', ok: true },
  { action: 'get_qzone_feeds', label: '看空间动态', params: '无', risk: 'low', ok: true },
  // NapCat 4.18.42 实测不支持发说说，调用会返回「不支持的Api」
  { action: 'qzone_send_feed', label: '发 QQ 空间动态（NapCat 不支持）', params: '—', risk: 'high', ok: false },
];
