/**
 * 预设人格
 *
 * 内置：personas/*.mjs
 * 用户：data/personas/*.mjs（同 id 时覆盖内置，方便自己改）
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT_DIR } from './config.mjs';

const BUILTIN_DIR = path.join(ROOT_DIR, 'personas');
const USER_DIR = path.join(ROOT_DIR, 'data', 'personas');

function scan(dir, builtin) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.mjs')) continue;
    out.push({ file: path.join(dir, f), builtin });
  }
  return out;
}

const _cache = new Map();

async function load(file) {
  if (_cache.has(file)) return _cache.get(file);
  try {
    const mod = await import(pathToFileURL(file).href);
    const p = mod.default;
    if (!p || !p.id || !p.prompt) return null;
    const meta = {
      id: p.id,
      name: p.name || p.id,
      emoji: p.emoji || '🙂',
      tags: p.tags || [],
      summary: p.summary || '',
      greeting: p.greeting || '',
      style: p.style || '',
      prompt: p.prompt,
    };
    _cache.set(file, meta);
    return meta;
  } catch {
    return null;
  }
}

/** 全部预设（data/personas 覆盖同名内置） */
export async function listPersonas() {
  const map = new Map();
  for (const item of scan(BUILTIN_DIR, true)) {
    const p = await load(item.file);
    if (p) map.set(p.id, { ...p, builtin: true });
  }
  for (const item of scan(USER_DIR, false)) {
    const p = await load(item.file);
    if (p) map.set(p.id, { ...p, builtin: false });
  }
  return [...map.values()].sort((a, b) => (a.builtin === b.builtin ? 0 : a.builtin ? -1 : 1));
}

export async function getPersona(id) {
  const all = await listPersonas();
  return all.find(p => p.id === id) || null;
}

/** 列表里不需要正文，省点流量 */
export async function listPersonasBrief() {
  const all = await listPersonas();
  return all.map(({ prompt, ...rest }) => ({ ...rest, promptLength: prompt.length }));
}
