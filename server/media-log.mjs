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
 * 微信给的是秒级 createTime，这里允许 ±3 秒误差，并区分收发方向。
 */
export function mergeMediaIntoMessages(messages, talker) {
  const entries = listMedia(talker);
  if (!entries.length) return { messages, orphans: [] };

  const used = new Set();
  const out = messages.map(m => {
    const ts = Number(m.createTime) * 1000;
    const dir = m.isSend ? 'out' : 'in';
    let best = -1;
    let bestDiff = Infinity;
    entries.forEach((e, i) => {
      if (used.has(i) || e.dir !== dir) return;
      const d = Math.abs(e.ts - ts);
      if (d <= 3000 && d < bestDiff) { bestDiff = d; best = i; }
    });
    if (best < 0) return m;
    used.add(best);
    const e = entries[best];
    return { ...m, media: { kind: e.kind, url: `/media/${e.file}`, duration: e.duration, text: e.text } };
  });

  // 没能对上历史消息的（比如图片还没同步进消息库），单独作为补充条目返回
  const orphans = entries
    .map((e, i) => ({ e, i }))
    .filter(({ i }) => !used.has(i))
    .slice(-40)
    .map(({ e }) => ({
      localId: `media-${e.ts}-${e.file}`,
      localType: e.kind === 'voice' ? 34 : e.kind === 'sticker' ? 47 : 3,
      createTime: Math.floor(e.ts / 1000),
      isSend: e.dir === 'out' ? 1 : 0,
      senderDisplay: e.dir === 'out' ? '我' : '',
      parsedContent: e.kind === 'voice' ? '[语音]' : e.kind === 'sticker' ? '[表情]' : '[图片]',
      media: { kind: e.kind, url: `/media/${e.file}`, duration: e.duration, text: e.text },
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
