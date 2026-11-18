/**
 * 灵枢 AI 中枢 — 媒体索引（给控制台显示图片/表情/语音用）
 *
 * 为什么需要它：微信历史消息里查不到图片/语音的字节，读取器只在「推送那一刻」
 * 才发放媒体 id。所以收到或发出时，我们顺手把字节存一份到 data/media/cache，
 * 并用时间戳登记，控制台就能按时间把消息和媒体对上。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT_DIR } from './config.mjs';

const MEDIA_DIR = path.join(ROOT_DIR, 'data', 'media');
const CACHE_DIR = path.join(MEDIA_DIR, 'cache');
const INDEX_PATH = path.join(MEDIA_DIR, 'index.json');
const MAX_ENTRIES_PER_CHAT = 400;

function ensure() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function readIndex() {
  try {
    const d = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8').replace(/^\uFEFF/, ''));
    return d && typeof d === 'object' ? d : {};
  } catch {
    return {};
  }
}

function writeIndex(idx) {
  ensure();
  const tmp = `${INDEX_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(idx), 'utf8');
  fs.renameSync(tmp, INDEX_PATH);
}

function extOf(mime, fallback = 'bin') {
  const m = String(mime || '').toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('png')) return 'png';
  if (m.includes('gif')) return 'gif';
  if (m.includes('webp')) return 'webp';
  if (m.includes('wav')) return 'wav';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  return fallback;
}

/** 把一段字节落到 cache 目录，返回相对路径（可直接拼 /media/...） */
export function saveToCache(buffer, { mime = '', ext = '', tag = 'm' } = {}) {
  if (!buffer?.length) return '';
  ensure();
  const e = ext || extOf(mime);
  const name = `${tag}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${e}`;
  fs.writeFileSync(path.join(CACHE_DIR, name), buffer);
  return `cache/${name}`;
}

/** 从已有文件复制一份进 cache（发送后原文件会被删掉，所以得先留底） */
export function copyToCache(filePath, { tag = 'm' } = {}) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return '';
    ensure();
    const e = path.extname(filePath).slice(1) || 'bin';
    const name = `${tag}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${e}`;
    fs.copyFileSync(filePath, path.join(CACHE_DIR, name));
    return `cache/${name}`;
  } catch {
    return '';
  }
}

/**
 * 登记一条媒体记录
 * @param {'in'|'out'} dir 收 / 发
 * @param {'image'|'sticker'|'voice'|'file'} kind
 */
export function recordMedia(talker, { dir, kind, file, ts = Date.now(), text = '', duration = null }) {
  if (!talker || !file) return null;
  const idx = readIndex();
  const key = String(talker);
  const entry = {
    ts: Number(ts) && Number(ts) > 1e12 ? Number(ts) : (Number(ts) ? Number(ts) * 1000 : Date.now()),
    dir, kind, file,
    text: String(text || '').slice(0, 200),
    duration: duration ?? null,
  };
  const box = idx[key] || { entries: [] };
  box.entries.push(entry);
  if (box.entries.length > MAX_ENTRIES_PER_CHAT) box.entries = box.entries.slice(-MAX_ENTRIES_PER_CHAT);
  idx[key] = box;
  try { writeIndex(idx); } catch { /* 索引写失败不影响主流程 */ }
  return entry;
}

export function listMedia(talker) {
  const idx = readIndex();
  return (idx[String(talker)]?.entries || []).slice();
}

/**
 * 把媒体按时间并进历史消息。
 *
 * 旧实现是「每条消息各自找最近的媒体」，效果差：一条消息会先把后面的媒体的
 * 抢走，导致真正该配的那条反而没配上，于是出现「语音跑到了前一条消息上、
 * 原位置只剩『[语音]』占位」的现象。
 *
 * 现在改成全局贪心：先把所有 (消息, 媒体) 的候选配对按时间差从小到大排序，
 * 再依次分配，每条消息和每条媒体都只能用一次。
 */
export function mergeMediaIntoMessages(messages, talker) {
  const entries = listMedia(talker);
  if (!entries.length) return { messages, orphans: [] };

  // QQ 消息带的是毫秒时间戳 ts，微信带的是秒级 createTime
  const tsOf = (m) => {
    if (Number(m.ts) > 1e12) return Number(m.ts);
    if (Number(m.createTime)) return Number(m.createTime) * 1000;
    return Number(m.ts) || 0;
  };
  const dirOf = (m) => {
    if (m.role === 'assistant') return 'out';
    if (m.role === 'user') return 'in';
    return m.isSend ? 'out' : 'in';
  };
  // 消息正文里如果自带类型线索（[语音] / [图片] / [表情]），必须同类型才能配
  const kindOf = (m) => {
    const t = String(m.content ?? m.parsedContent ?? '');
    if (/\[语音\]/.test(t)) return 'voice';
    if (/\[图片\]/.test(t)) return 'image';
    if (/\[表情\]/.test(t)) return 'sticker';
    if (/\[文件\]/.test(t)) return 'file';
    return '';
  };

  const pairs = [];
  messages.forEach((m, mi) => {
    const ts = tsOf(m);
    if (!ts) return;
    const dir = dirOf(m);
    const wantKind = kindOf(m);
    entries.forEach((e, ei) => {
      if (e.dir !== dir) return;
      if (wantKind && e.kind !== wantKind) return;
      const d = Math.abs(e.ts - ts);
      if (d <= 8000) pairs.push({ mi, ei, d });
    });
  });

  // 时间差小的优先配对
  pairs.sort((a, b) => a.d - b.d);
  const usedMsg = new Set();
  const usedEntry = new Set();
  const attach = new Map();
  for (const p of pairs) {
    if (usedMsg.has(p.mi) || usedEntry.has(p.ei)) continue;
    usedMsg.add(p.mi);
    usedEntry.add(p.ei);
    const e = entries[p.ei];
    attach.set(p.mi, { kind: e.kind, url: '/media/' + e.file, duration: e.duration, text: e.text });
  }

  const out = messages.map((m, mi) => (attach.has(mi) ? { ...m, media: attach.get(mi) } : m));

  // 没能对上历史消息的媒体，只保留「落在当前消息时间范围内」的。
  // 历史只取最近 N 条，更早的媒体本来就不该出现在这个列表里——
  // 否则会堆一堆几天前的图在末尾，看着像消息乱序。
  const times = messages.map(tsOf).filter(Boolean);
  const minTs = times.length ? Math.min(...times) : 0;
  const maxTs = times.length ? Math.max(...times) : 0;
  const inRange = (e) => !times.length || (e.ts >= minTs - 120000 && e.ts <= maxTs + 120000);
  const orphans = entries
    .map((e, i) => ({ e, i }))
    .filter(({ e, i }) => !usedEntry.has(i) && inRange(e))
    .slice(-40)
    .map(({ e }) => ({
      localId: 'media-' + e.ts + '-' + e.file,
      localType: e.kind === 'voice' ? 34 : e.kind === 'sticker' ? 47 : 3,
      createTime: Math.floor(e.ts / 1000),
      isSend: e.dir === 'out' ? 1 : 0,
      senderDisplay: e.dir === 'out' ? '我' : '',
      parsedContent: e.kind === 'voice' ? '[语音]' : e.kind === 'sticker' ? '[表情]' : '[图片]',
      media: { kind: e.kind, url: '/media/' + e.file, duration: e.duration, text: e.text },
      // 标记成「未归档」：这类条目不是真实消息，前端固定放在末尾，
      // 否则按时间插进消息流会让人以为消息顺序乱了
      _orphan: true,
    }));

  return { messages: out, orphans };
}

/** 清理过期缓存文件（默认 14 天） */
export function pruneCache(maxAgeMs = 14 * 86400000) {
  try {
    ensure();
    const now = Date.now();
    let n = 0;
    for (const f of fs.readdirSync(CACHE_DIR)) {
      const fp = path.join(CACHE_DIR, f);
      try {
        if (now - fs.statSync(fp).mtimeMs > maxAgeMs) { fs.rmSync(fp, { force: true }); n++; }
      } catch { /* ignore */ }
    }
    if (n) {
      // 顺手清掉索引里指向已删文件的条目
      const idx = readIndex();
      for (const k of Object.keys(idx)) {
        idx[k].entries = (idx[k].entries || []).filter(e => fs.existsSync(path.join(MEDIA_DIR, e.file)));
      }
      writeIndex(idx);
    }
    return n;
  } catch {
    return 0;
  }
}
