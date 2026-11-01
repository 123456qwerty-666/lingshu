/**
 * 灵枢 AI 中枢 — 插件系统
 * 插件 = 目录 + plugin.json + index.mjs，导出 setup(ctx) => { tools: [...] }
 */
import { loadConfig, ROOT_DIR } from './config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILTIN_DIR = path.join(__dirname, '..', 'plugins');
const USER_PLUGIN_DIR = path.join(ROOT_DIR, 'data', 'plugins');

class PluginHost {
  constructor(ctx) {
    this.plugins = new Map();
    this.ctx = ctx;
  }

  async loadPlugin(id, entryPath, manifest) {
    try {
      const mod = await import(pathToFileURL(entryPath).href);
      const setup = mod.default?.setup || mod.setup;
      if (typeof setup !== 'function') throw new Error('缺少 setup()');

      const pluginCtx = {
        id,
        config: manifest.config || {},
        ai: this.ctx.ai,
        wechat: this.ctx.wechat,
        log: (msg) => this.ctx.log(`${id}: ${msg}`),
        dataDir: path.join(this.ctx.dataDir, id),
        fs,
        path,
      };
      fs.mkdirSync(pluginCtx.dataDir, { recursive: true });

      const instance = await setup(pluginCtx);
      this.plugins.set(id, { manifest: { ...manifest, id }, instance, entryPath });
      this.ctx.log(`插件 "${id}" 已加载 (${manifest.name || id})`);
      return true;
    } catch (e) {
      this.ctx.log(`插件 "${id}" 加载失败: ${e.message}`, 'error');
      return false;
    }
  }

  unload(id) {
    const p = this.plugins.get(id);
    if (!p) return;
    try { if (typeof p.instance?.destroy === 'function') p.instance.destroy(); } catch { /* ignore */ }
    this.plugins.delete(id);
  }

  unloadAll() { [...this.plugins.keys()].forEach(id => this.unload(id)); }

  /** OpenAI tools 定义（按插件过滤） */
  getTools(pluginFilter = null) {
    const allowed = pluginFilter ? new Set(pluginFilter) : null;
    const tools = [];
    for (const [pluginId, p] of this.plugins) {
      if (allowed && !allowed.has(pluginId)) continue;
      for (const t of p.instance?.tools || []) {
        tools.push({
          name: t.name,
          description: t.description || '',
          parameters: t.parameters || { type: 'object', properties: {} },
          pluginId,
        });
      }
    }
    return tools;
  }

  findTool(toolName) {
    for (const [pluginId, p] of this.plugins) {
      const tool = (p.instance?.tools || []).find(t => t.name === toolName);
      if (tool) return { pluginId, tool };
    }
    return null;
  }

  async callToolByName(toolName, args = {}, runtime = {}) {
    const found = this.findTool(toolName);
    if (!found) throw new Error(`未找到工具: ${toolName}`);
    return found.tool.run(args, { pluginId: found.pluginId, ...runtime });
  }

  async callTool(pluginId, toolName, args = {}, runtime = {}) {
    const p = this.plugins.get(pluginId);
    if (!p) throw new Error(`插件 ${pluginId} 未加载`);
    const tool = (p.instance?.tools || []).find(t => t.name === toolName);
    if (!tool) throw new Error(`插件 ${pluginId} 中没有工具 ${toolName}`);
    return tool.run(args, { pluginId, ...runtime });
  }

  manifests() {
    return [...this.plugins.entries()].map(([id, p]) => ({ id, ...p.manifest, loaded: true }));
  }
}

// ── 扫描 ──────────────────────────────────────────────────
function scanPluginDir(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(dir, entry.name, 'plugin.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
      out.push({ id: manifest.id || entry.name, manifest, dir: path.join(dir, entry.name) });
    } catch (e) {
      out.push({ id: entry.name, manifest: { id: entry.name, name: entry.name, error: e.message }, dir: path.join(dir, entry.name), broken: true });
    }
  }
  return out;
}

export function listAllPluginManifests() {
  const enabled = new Set(loadConfigSyncEnabled());
  const merged = new Map();
  for (const p of scanPluginDir(BUILTIN_DIR)) merged.set(p.id, { ...p, builtin: true });
  for (const p of scanPluginDir(USER_PLUGIN_DIR)) merged.set(p.id, { ...p, builtin: false });
  return [...merged.values()].map(p => ({
    ...p.manifest,
    id: p.id,
    builtin: p.builtin,
    broken: !!p.broken,
    enabled: enabled.has(p.id),
    tools: _host?.getTools([p.id]).map(t => t.name) || [],
  }));
}

function loadConfigSyncEnabled() {
  try {
    const fp = path.join(ROOT_DIR, 'data', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(fp, 'utf8').replace(/^\uFEFF/, ''));
    return cfg.plugins?.enabled || [];
  } catch {
    return [];
  }
}

// ── 初始化 ────────────────────────────────────────────────
let _host = null;
let _ctxRef = null;

export async function initPlugins(driverCtx, aiClient, logFn) {
  const config = await loadConfig();
  const enabled = config.plugins?.enabled || [];

  _ctxRef = {
    ai: aiClient,
    wechat: driverCtx,
    config,
    log: logFn,
    dataDir: path.join(ROOT_DIR, 'data', 'plugin-data'),
  };
  _host = new PluginHost(_ctxRef);

  for (const dir of [BUILTIN_DIR, USER_PLUGIN_DIR]) {
    for (const p of scanPluginDir(dir)) {
      if (!enabled.includes(p.id)) continue;
      const entry = path.join(p.dir, 'index.mjs');
      if (fs.existsSync(entry)) await _host.loadPlugin(p.id, entry, p.manifest);
    }
  }
  return getToolList();
}

export function getHost() { return _host; }

export function getToolList(pluginFilter = null) {
  return _host?.getTools(pluginFilter) || [];
}

export async function callPluginTool(a, b, c, runtime = {}) {
  if (!_host) throw new Error('插件系统未初始化');
  // 兼容两种调用：callPluginTool(toolName, args) / callPluginTool(pluginId, toolName, args)
  if (typeof c === 'undefined') return _host.callToolByName(a, b || {}, runtime);
  try {
    return await _host.callTool(a, b, c || {}, runtime);
  } catch (e) {
    // pluginId 传错（常见：传成工具名）时回退按工具名查找
    return _host.callToolByName(a, b || c || {}, runtime);
  }
}

export async function callToolByName(toolName, args, runtime = {}) {
  if (!_host) throw new Error('插件系统未初始化');
  return _host.callToolByName(toolName, args, runtime);
}

export async function reloadPlugins(logFn) {
  const config = await loadConfig();
  const enabled = config.plugins?.enabled || [];
  const ctx = _ctxRef || {
    ai: null, wechat: null, config, log: logFn,
    dataDir: path.join(ROOT_DIR, 'data', 'plugin-data'),
  };
  ctx.config = config;
  ctx.log = logFn || ctx.log;
  _host?.unloadAll();
  _host = new PluginHost(ctx);

  for (const dir of [BUILTIN_DIR, USER_PLUGIN_DIR]) {
    for (const p of scanPluginDir(dir)) {
      if (!enabled.includes(p.id)) continue;
      const entry = path.join(p.dir, 'index.mjs');
      if (fs.existsSync(entry)) await _host.loadPlugin(p.id, entry, p.manifest);
    }
  }
  return getToolList();
}

// ── 脚手架 / 删除 ─────────────────────────────────────────
export async function scaffoldPlugin(id, name, description) {
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id)) throw new Error('插件 ID 只能用小写字母、数字和连字符');
  const dir = path.join(USER_PLUGIN_DIR, id);
  if (fs.existsSync(dir)) throw new Error('插件已存在');
  fs.mkdirSync(dir, { recursive: true });

  const manifest = {
    id, name: name || id, version: '1.0.0',
    description: description || '', entry: 'index.mjs',
    capabilities: ['tool'], config: [],
  };
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf8');

  const template = `/**
 * 插件: ${name || id}
 * 说明: ${description || ''}
 */
export function setup(ctx) {
  ctx.log('插件 ${id} 已初始化');

  return {
    tools: [
      {
        name: '${id.replace(/-/g, '_')}_hello',
        description: '示例工具：说你好',
        parameters: { type: 'object', properties: {} },
        async run(args, runtime) {
          return { result: '你好！我是插件 ${id}。当前聊天: ' + (runtime.talker || '未知') };
        },
      },
    ],
  };
}
`;
  fs.writeFileSync(path.join(dir, 'index.mjs'), template, 'utf8');
  return { id, dir, manifest };
}

export async function deletePlugin(id) {
  const dir = path.join(USER_PLUGIN_DIR, id);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

export async function readPluginCode(id) {
  for (const base of [USER_PLUGIN_DIR, BUILTIN_DIR]) {
    const fp = path.join(base, id, 'index.mjs');
    if (fs.existsSync(fp)) return { path: fp, code: fs.readFileSync(fp, 'utf8'), builtin: base === BUILTIN_DIR };
  }
  return null;
}

export async function writePluginCode(id, code) {
  const fp = path.join(USER_PLUGIN_DIR, id, 'index.mjs');
  if (!fs.existsSync(fp)) throw new Error('内置插件代码不可直接编辑，请先复制到 data/plugins');
  fs.writeFileSync(fp, code, 'utf8');
  return true;
}
