# AGENTS.md

> 给 AI 代理看的说明书。人类看 [README.md](README.md)。
> 目标：让你（AI）能独立完成「装起来 → 配模型 → 跑通 → 加功能」全流程，不需要人类点网页。

## 先看这份就够了

| 你要做的事 | 看这里 |
|---|---|
| **从零部署一台陌生电脑** | [docs/AGENT-GUIDE.md](docs/AGENT-GUIDE.md) ← 完整执行手册，按阶段走 |
| 快速上手（本文件） | 下面的 1~7 节 |
| 报错 / 日志看不懂 | [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) 按现象查 |
| 写插件 / 装插件 | [docs/PLUGINS.md](docs/PLUGINS.md) |
| 接微信（白名单、发文件、坑） | [docs/WECHAT.md](docs/WECHAT.md) |
| 记忆系统原理与调参 | [docs/MEMORY.md](docs/MEMORY.md) |
| HTTP 接口全量 | [docs/API.md](docs/API.md) |

**一句话上下文**：这是一个零依赖的 Node.js 微信 AI 助手，核心是「会遗忘的记忆」。
所有功能都能用 HTTP API 驱动，端口 17890，数据在 `data/`。

---

## 0. 项目是什么

一个本机的微信 AI 助手：Node.js 服务 + 单页控制台 + 插件系统 + 记忆系统。
所有能力都通过 HTTP API 暴露，**控制台能做的，curl 都能做**。

- 语言/运行时：Node.js ≥ 20，ESM，**零第三方依赖**（不要执行 `npm install`）
- 入口：`server/index.mjs`
- 默认端口：`17890`，只监听 `127.0.0.1`
- 数据目录：`data/`（配置、上下文、记忆、媒体）——**已 gitignore，不要提交**

## 1. 安装（3 步）

```bash
git clone <repo-url> lingshu && cd lingshu
node scripts/bootstrap.mjs        # 建目录 + 生成 data/config.json
node server/index.mjs             # 前台启动（后台用 start.sh / start.cmd）
```

验证：

```bash
curl -s http://127.0.0.1:17890/api/health
# -> {"ok":true,"state":{...},"logs":[...]}
```

Windows 下没有 bash 时用 `start.cmd`；停止用 `stop.cmd`（按端口杀进程）。

### ⚠️ 注意：这三步只装了「一半」

灵枢 = 大脑（记忆/人格/模型/插件/控制台）。**它自己不读微信、不发微信。**

```
灵枢（本仓库） ──HTTP──> WeChatAgent（第三方，另装） ──> 微信
```

只做完上面三步：控制台能开、模型人格插件能配、记忆库能手动增删，
但 **收不到微信消息、发不出微信消息、也没有对话入口**（控制台不是聊天工具）。

用户要求「接微信」时，必须再装 WeChatAgent + 登录微信 + 加白名单，
完整步骤见 **[docs/AGENT-GUIDE.md 6.0](docs/AGENT-GUIDE.md#60-先装底层读写组件关键别跳)**。

要点速记（细节看 6.0）：

| 步 | 做什么 | 硬要求 |
|---|---|---|
| 1 | 确认微信版本 | 必须 Windows x64 **4.1.10.27** |
| 2 | 装 WeChatAgent（约 500MB 安装器） | 装前**完全退出微信**（含托盘） |
| 3 | 摆成兄弟目录 | `lingshu/` 与 `WeChatAgent-install/` 同级 |
| 4 | 验证 5031 / 30001 活着 | hook 返回 `"version":"4.1.10.27"` |
| 5 | 白名单加 conversationId | 纯数字，不是 `@chatroom` |
| 6 | 提醒用户关微信自动更新 | 否则过几天自升级会全线失效 |

## 2. 配置模型（不要手改 config.json 里的密钥，用 API）

```bash
# 1) 加/改提供商（OpenAI 兼容）
curl -X POST http://127.0.0.1:17890/api/config -H 'Content-Type: application/json' -d '{
  "ai": { "providers": { "deepseek": {
    "name": "DeepSeek",
    "baseUrl": "https://api.deepseek.com",
    "apiKey": "<API_KEY>",
    "models": []
  } } }
}'

# 2) 拉模型列表（会自动写回 config）
curl -X POST http://127.0.0.1:17890/api/ai/models/refresh \
  -H 'Content-Type: application/json' -d '{"providerId":"deepseek"}'

# 3) 设默认模型
curl -X POST http://127.0.0.1:17890/api/config -H 'Content-Type: application/json' \
  -d '{"ai":{"defaultProvider":"deepseek","defaultModel":"<MODEL_ID>"}}'

# 4) 连通性测试
curl -X POST http://127.0.0.1:17890/api/ai/test -H 'Content-Type: application/json' \
  -d '{"prompt":"只回答两个字：正常"}'
```

`/api/ai/providers` 里 `hasKey` 为 true 且 `isDefault` 正确，就算配好了。

## 3. 冒烟测试（不需要微信）

```bash
# 需要先有一个聊天；没接微信时可以这样造一个（conversationId 随便填）
curl -X POST http://127.0.0.1:17890/api/chats/add -H 'Content-Type: application/json' \
  -d '{"talker":"demo","kind":"private","conversationId":"1","name":"演示"}'

# 走完整链路（解析→触发→模型→发送）。没接微信时发送会失败，但模型调用会成功
curl -X POST http://127.0.0.1:17890/api/debug/send -H 'Content-Type: application/json' \
  -d '{"talker":"demo","text":"用一句话介绍你自己"}'

# 看结果
curl -s "http://127.0.0.1:17890/api/logs?limit=20"
```

判断标准：日志里出现 `收到 [debug] ...` → `已回复 ...`，且没有 `AI 调用失败`。

## 4. 常用任务

### 接微信

需要外部的读取器（5031）和发送器（30001）。见 [docs/WECHAT.md](docs/WECHAT.md)。
配置入口：

```bash
curl -X POST http://127.0.0.1:17890/api/config -H 'Content-Type: application/json' \
  -d '{"wechat":{"readerUrl":"http://127.0.0.1:5031","hookUrl":"http://127.0.0.1:30001"}}'
curl -X POST http://127.0.0.1:17890/api/wechat/reconnect
```

### 加一个聊天并单独设置

```bash
curl -X POST http://127.0.0.1:17890/api/chats/add -H 'Content-Type: application/json' \
  -d '{"talker":"<wxid或xxx@chatroom>","kind":"group","conversationId":"<id>","name":"某群"}'

curl -X POST http://127.0.0.1:17890/api/chats/settings -H 'Content-Type: application/json' -d '{
  "talker":"<wxid>",
  "patch":{
    "persona":"你叫小灵，说话简洁不客套",
    "style":"回复不超过 40 字",
    "triggerMode":"mention",
    "plugins":["web-search","memory"],
    "memory":{"enabled":true},
    "context":{"compressAtTokens":48000,"keepRecentMessages":14}
  }
}'
```

### 查 / 改记忆

```bash
curl -s http://127.0.0.1:17890/api/memory                      # 总览
curl -s "http://127.0.0.1:17890/api/memory/detail?talker=<id>" # 明细（含强度、画像）
curl -X POST http://127.0.0.1:17890/api/memory/add -H 'Content-Type: application/json' \
  -d '{"talker":"<id>","text":"对花生过敏","importance":0.9,"kind":"fact","tags":["健康"]}'
curl -X POST http://127.0.0.1:17890/api/memory/forget -H 'Content-Type: application/json' \
  -d '{"dryRun":true}'    # 先预演，看会遗忘哪些
```

### 写一个插件

```
plugins/<id>/plugin.json  +  index.mjs
```

- `index.mjs` 必须 `export function setup(ctx) { return { tools: [...] } }`
- 每个 tool：`{ name, description, parameters(JSON Schema), async run(args, runtime) }`
- 图片返回 `{ path: '...' }` 就会被自动发出
- 失败时返回 `{ success: false, error, hint }`，`hint` 会指导模型怎么跟用户说

写完 `curl -X POST http://127.0.0.1:17890/api/plugins/reload` 立即生效。
在线改代码用 `GET/PUT /api/plugins/code?id=<id>`。详见 [docs/PLUGINS.md](docs/PLUGINS.md)。

### 排查「不回消息」

按顺序查，别猜：

1. `curl -s http://127.0.0.1:17890/api/health` → `state.sseConnected` 是否 true、`state.sseEvents` 是否增长
2. `reader.pushed` 是否增长 → 不涨 = 读取器没推这个会话（见 WECHAT.md 坑 1）
3. `curl -s "http://127.0.0.1:17890/api/logs?limit=50"` → 找 `跳过 [原因]`
4. 是不是用「文件传输助手」测收消息（永远收不到，见坑 3）
5. `AI 调用失败: AI 429` → 额度/限流，看是否已配备用提供商

## 5. 硬性约束（违反会出事）

- **不要**把 `data/` 提交到 git（里面有 API Key、聊天记录、记忆）
- **不要**在日志、回复、commit message 里打印完整 API Key
- **不要**改 `data/config.json` 时丢掉其它字段——用 `POST /api/config` 做**局部**合并
- **不要**对真实联系人做批量/骚扰性测试；测发送优先发到「文件传输助手」
- 端口只监听 `127.0.0.1`，不要为了"方便"改成 `0.0.0.0`（会暴露聊天记录与密钥）

## 6. 代码地图

| 文件 | 职责 | 改动风险 |
|---|---|---|
| `server/index.mjs` | 路由 + 消息主流程 | 高（核心链路） |
| `server/wechat.mjs` | 读取器/发送器适配、SSE、文件暂存 | 中（换 hook 版本要改） |
| `server/ai.mjs` | 模型调用、多提供商降级、工具循环 | 中 |
| `server/memory.mjs` | 记忆引擎（遗忘曲线） | 中（参数敏感） |
| `server/compressor.mjs` | 上下文压缩 | 低 |
| `server/router.mjs` | 事件解析、触发、上下文 | 低 |
| `server/plugins.mjs` | 插件加载与调用 | 低 |
| `public/index.html` | 控制台（单文件，原生 JS） | 低（纯前端） |

改完跑一遍语法检查：

```bash
for f in server/*.mjs plugins/*/*.mjs; do node --check "$f" || echo "FAIL $f"; done
```

| 文档 | 内容 |
|---|---|
| [docs/AGENT-GUIDE.md](docs/AGENT-GUIDE.md) | **AI 完整执行手册**（环境→部署→模型→微信→插件→交付） |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | 错误大全：现象→根因→命令→修复 |
| [docs/PLUGINS.md](docs/PLUGINS.md) | 插件安装 / 开发 / 调试 / 分享 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构、消息流水线、设计取舍 |
| [docs/MEMORY.md](docs/MEMORY.md) | 记忆系统完整设计（公式、参数、调参） |
| [docs/API.md](docs/API.md) | HTTP API 全量清单 |
| [docs/WECHAT.md](docs/WECHAT.md) | 微信接入契约与排障 |
| [docs/DEPLOY-AI.md](docs/DEPLOY-AI.md) | 可直接复制的部署提示词 |
| [docs/PROMO-DOUYIN.md](docs/PROMO-DOUYIN.md) | 推广文案（人类用，AI 可忽略） |

## 7. 验收清单

完成任何改动后，至少确认：

- [ ] `node --check` 全部通过
- [ ] `/api/health` 返回 `ok:true`
- [ ] `/api/logs` 里没有新的 `error`
- [ ] `/api/debug/send` 能走通（有回复或明确的跳过原因）
- [ ] 没有把密钥/聊天内容写进代码或提交
