/**
 * 图片生成/发送助手
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..', '..');
const MEDIA_DIR = path.join(ROOT_DIR, 'data', 'media');
const SEND_DIR = path.join(MEDIA_DIR, 'pending-send');
fs.mkdirSync(SEND_DIR, { recursive: true });

export async function generateImage(prompt, options = {}) {
  const { ai } = await import(pathToFileURL(path.join(ROOT_DIR, 'server', 'ai.mjs')).href);
  return ai.generateImage(prompt, options);
}

export async function saveImageForSend(result) {
  const { randomUUID } = await import('node:crypto');
  let buffer;
  if (result.format === 'base64') {
    buffer = Buffer.from(result.data, 'base64');
  } else if (result.format === 'url') {
    // 下载图片
    const resp = await fetch(result.data);
    if (!resp.ok) throw new Error(`下载图片失败: ${resp.status}`);
    buffer = Buffer.from(await resp.arrayBuffer());
  } else {
    throw new Error('Unknown image format: ' + result.format);
  }

  const id = randomUUID();
  const ext = detectExt(buffer);
  const fileName = `${id}.${ext}`;
  const dest = path.join(SEND_DIR, fileName);
  fs.writeFileSync(dest, buffer);
  return dest;
}

function detectExt(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'jpg';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46) return 'webp';
  return 'png';
}

export async function sendPendingImages(wxidOrGroupId) {
  const { sendImageFile } = await import(pathToFileURL(path.join(ROOT_DIR, 'server', 'wechat.mjs')).href);
  const files = fs.readdirSync(SEND_DIR);
  const results = [];
  for (const f of files) {
    try {
      await sendImageFile(wxidOrGroupId, path.join(SEND_DIR, f), f);
      results.push({ file: f, ok: true });
    } catch (e) {
      results.push({ file: f, ok: false, error: e.message });
    }
  }
  return results;
}
