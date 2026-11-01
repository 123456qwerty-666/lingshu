#!/usr/bin/env node
/**
 * 灵枢 AI 中枢 — 首次初始化
 * 建目录、生成配置、检查环境。幂等，可以反复运行。
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const CONFIG = path.join(DATA, 'config.json');
const EXAMPLE = path.join(ROOT, 'config.example.json');

const ok = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const warn = (s) => console.log(`  \x1b[33m!\x1b[0m ${s}`);
const bad = (s) => console.log(`  \x1b[31m✗\x1b[0m ${s}`);

console.log('\n灵枢 AI 中枢 — 初始化\n');

// 1. Node 版本
const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  bad(`Node.js ${process.versions.node} 太旧了，需要 ≥ 20`);
  process.exit(1);
}
ok(`Node.js ${process.versions.node}`);

// 2. 目录
for (const d of ['', 'contexts', 'memory/scopes', 'memory/archived', 'media/pending-send', 'plugin-data', 'secrets', 'backups']) {
  fs.mkdirSync(path.join(DATA, d), { recursive: true });
}
ok('数据目录就绪 (data/)');

// 3. 配置
if (fs.existsSync(CONFIG)) {
  ok('配置已存在 (data/config.json)，跳过');
} else if (fs.existsSync(EXAMPLE)) {
  fs.copyFileSync(EXAMPLE, CONFIG);
  ok('已从 config.example.json 生成 data/config.json');
} else {
  warn('没找到 config.example.json，将使用内置默认值');
}

// 4. 配置体检
try {
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8').replace(/^\uFEFF/, ''));
  const providers = Object.entries(cfg.ai?.providers || {});
  const withKey = providers.filter(([, p]) => p.apiKey);
  const withModels = providers.filter(([, p]) => (p.models || []).length);

  if (!providers.length) warn('还没有配置 AI 提供商');
  else if (!withKey.length) warn(`有 ${providers.length} 个提供商，但都还没填 API Key`);
  else ok(`${providers.length} 个提供商，其中 ${withKey.length} 个已填 Key`);
  if (withKey.length && !withModels.length) warn('提供商还没有模型列表，启动后点「刷新模型」');

  const enabled = cfg.plugins?.enabled || [];
  ok(`已启用插件：${enabled.join(', ') || '（无）'}`);
  if (cfg.memory?.enabled) ok('记忆系统已开启');
} catch (e) {
  bad(`配置解析失败：${e.message}`);
}

// 5. 端口占用
const port = (() => {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8').replace(/^\uFEFF/, '')).app?.port || 17890; }
  catch { return 17890; }
})();

await new Promise((resolve) => {
  const srv = net.createServer();
  srv.once('error', () => {
    warn(`端口 ${port} 已被占用（可能已经启动了，直接用浏览器打开）`);
    resolve();
  });
  srv.once('listening', () => {
    srv.close(() => {
      ok(`端口 ${port} 空闲`);
      resolve();
    });
  });
  srv.listen(port, '127.0.0.1');
});

console.log(`
下一步：
  1. 启动服务    node server/index.mjs      （Windows 也可双击 start.cmd）
  2. 打开控制台  http://127.0.0.1:${port}
  3. 配模型      「AI 配置」→ 填 Base URL + API Key → 刷新模型 → 测试连通
  4. 想接微信    「微信设置」→ 填读取器/发送器地址（见 docs/WECHAT.md）

提示：没有微信也能用——控制台的「概览 → 发送自检」可以跑通整条链路。
`);
