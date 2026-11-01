# 把部署交给 AI

这份文档的目标：你把仓库地址丢给任意 AI 助手（Claude / GPT / Cursor / CodeBuddy / WorkBuddy…），
它照着做就能装好、配好、验证完，不需要你在旁边点网页。

---

## 一、直接复制的提示词（完整版）

```
帮我在这台电脑上部署「灵枢 AI 中枢」（LingShu Hub）。
仓库：https://github.com/123456qwerty-666/lingshu

【环境要求】
- Node.js ≥ 20（先检查 node -v，不够就告诉我怎么装）
- Windows / macOS / Linux 都行
- 不要 npm install（这个项目零依赖）

【部署步骤】
1. git clone 仓库到本地，进入目录
2. 执行 node scripts/bootstrap.mjs 初始化（会建 data/ 目录、生成配置、体检、检查端口）
3. 启动 node server/index.mjs（Windows 可用 start.cmd，mac 用 ./start.sh）
4. 验证：curl -s http://127.0.0.1:17890/api/health 应返回 {"ok":true,...}

【配置模型】（我会把 Base URL 和 API Key 给你）
5. POST /api/config 写入 ai.providers.<id> = { name, baseUrl, apiKey, models: [] }
6. POST /api/ai/models/refresh {"providerId":"<id>"} 自动拉模型列表
7. POST /api/config 设置 ai.defaultProvider 和 ai.defaultModel
8. POST /api/ai/test {"prompt":"只回答两个字：正常"} 验证连通

【冒烟测试】
9. POST /api/chats/add {"talker":"demo","kind":"private","conversationId":"1","name":"演示"}
10. POST /api/debug/send {"talker":"demo","text":"用一句话介绍你自己"}
11. GET /api/logs?limit=20 确认出现「收到」→「已回复」，且没有「AI 调用失败」

【交付】
告诉我：控制台地址、当前默认模型、健康检查结果、还缺什么（比如要接微信需要外部组件）

【硬性约束】
- 不要把 API Key 写进任何会被 git 提交的文件
- data/ 目录是运行时数据，不要提交
- 不要改 app.bind 为 0.0.0.0（会暴露聊天记录与密钥）
- 不要对真实联系人做批量测试，测发送优先用「文件传输助手」
```

---

## 二、分步详解

### 步骤 1：环境体检

```bash
node -v                 # 需要 v20 以上
echo $PORT              # 可选，看端口冲突
```

Windows 检查端口：

```powershell
netstat -ano | findstr :17890
```

- **结果**：`v20.x` 或更高
- **失败**：去 <https://nodejs.org> 装 LTS；Windows 也可以 `choco install nodejs-lts`

### 步骤 2：取代码

```bash
git clone https://github.com/123456qwerty-666/lingshu.git
cd lingshu
```

没有 git？直接下 ZIP 解压也行。

### 步骤 3：初始化

```bash
node scripts/bootstrap.mjs
```

预期输出：

```
灵枢 AI 中枢 — 初始化

  ✓ Node.js 22.22.2
  ✓ 数据目录就绪 (data/)
  ✓ 已从 config.example.json 生成 data/config.json
  ! 有 1 个提供商，但都还没填 API Key
  ✓ 已启用插件：image-gen, vision, memory, web-search
  ✓ 记忆系统已开启
  ✓ 端口 17890 空闲
```

这个脚本是**幂等**的，随便重复跑。它做四件事：建目录、生成配置、体检、检查端口占用。

### 步骤 4：启动

```bash
node server/index.mjs
```

Windows 双击 `start.cmd`（会自动初始化 + 启动 + 出错暂停），停止双击 `stop.cmd`。
macOS / Linux：`./start.sh` / `./stop.sh`。

预期输出：

```
[2026-11-01T13:00:00.000Z] INFO: 灵枢 AI 中枢 v0.4 启动中…
[2026-11-01T13:00:00.100Z] INFO: 插件就绪，共 8 个工具
[2026-11-01T13:00:00.200Z] INFO: Server listening on http://127.0.0.1:17890

╔═══════════════════════════════════════════════╗
║        灵枢 AI 中枢  LingShu Hub v0.4         ║
╚═══════════════════════════════════════════════╝
```

微信未接入时会多一行 `微信初始化失败: …`，**这是正常的**，不影响其它功能。

### 步骤 5：健康检查

```bash
curl -s http://127.0.0.1:17890/api/health
```

```json
{
  "ok": true,
  "state": { "connected": false, "sseConnected": false, "hookConnected": false, ... },
  "logs": [ ... ]
}
```

只要 `ok: true` 就算起来了。

### 步骤 6：配模型

```bash
# 1) 写提供商
curl -X POST http://127.0.0.1:17890/api/config \
  -H 'Content-Type: application/json' -d '{
  "ai": { "providers": { "deepseek": {
    "name": "DeepSeek",
    "baseUrl": "https://api.deepseek.com",
    "apiKey": "sk-你的key",
    "models": []
  } } }
}'

# 2) 拉模型列表（会自动写回配置）
curl -X POST http://127.0.0.1:17890/api/ai/models/refresh \
  -H 'Content-Type: application/json' -d '{"providerId":"deepseek"}'

# 3) 看有哪些模型可选
curl -s "http://127.0.0.1:17890/api/ai/models?provider=deepseek"

# 4) 设为默认
curl -X POST http://127.0.0.1:17890/api/config \
  -H 'Content-Type: application/json' \
  -d '{"ai":{"defaultProvider":"deepseek","defaultModel":"deepseek-chat"}}'

# 5) 验证
curl -X POST http://127.0.0.1:17890/api/ai/test \
  -H 'Content-Type: application/json' -d '{"prompt":"只回答两个字：正常"}'
```

预期返回：

```json
{"ok":true,"content":"正常","provider":"deepseek","model":"deepseek-chat","usage":{...}}
```

**失败对照**：

| 报错 | 原因 | 解决 |
|---|---|---|
| `401` / `invalid api key` | Key 错或没生效 | 重新 `POST /api/config` 写 key |
| `404` | Base URL 少了 `/v1` 或多了一层 | 试 `https://api.xxx.com` 与 `https://api.xxx.com/v1` |
| `429` | 免费额度限流 | 配 `fallbackProviders` 备用提供商 |
| `ECONNREFUSED` | 本地模型没起 | 先启动 vLLM / Ollama |

### 步骤 7：冒烟测试（不需要微信）

```bash
curl -X POST http://127.0.0.1:17890/api/chats/add \
  -H 'Content-Type: application/json' \
  -d '{"talker":"demo","kind":"private","conversationId":"1","name":"演示"}'

curl -X POST http://127.0.0.1:17890/api/debug/send \
  -H 'Content-Type: application/json' \
  -d '{"talker":"demo","text":"用一句话介绍你自己"}'

curl -s "http://127.0.0.1:17890/api/logs?limit=20"
```

成功的日志长这样：

```
info | 收到 [debug] private/demo: 用一句话介绍你自己
info | 已回复 demo（1 条）
```

没接微信时发送会失败（`发送失败: 发送端未初始化`），但**模型调用是成功的**，这就够验证链路了。

### 步骤 8：接微信（可选）

需要外部的读取器（5031）和发送器（30001）。见 [WECHAT.md](WECHAT.md)。

```bash
curl -X POST http://127.0.0.1:17890/api/config -H 'Content-Type: application/json' -d '{
  "wechat": {
    "readerUrl": "http://127.0.0.1:5031",
    "hookUrl": "http://127.0.0.1:30001",
    "account": "wxid_xxx_1234"
  }
}'
curl -X POST http://127.0.0.1:17890/api/wechat/reconnect
curl -s http://127.0.0.1:17890/api/health     # 看 state.connected / sseConnected
```

---

## 三、验收清单

部署完成后逐条确认：

- [ ] `node -v` ≥ 20
- [ ] `node scripts/bootstrap.mjs` 全部打勾（除了 Key）
- [ ] `GET /api/health` 返回 `ok:true`
- [ ] `POST /api/ai/test` 返回正常内容
- [ ] `GET /api/tools` 返回 8 个工具（image-gen / memory×4 / vision / web-search×2）
- [ ] `POST /api/plugins/reload` 成功
- [ ] `POST /api/debug/send` 后日志有「收到」与「已回复」
- [ ] `GET /api/logs` 没有 `error`
- [ ] 浏览器能打开 `http://127.0.0.1:17890`
- [ ] `git status` 里没有 `data/`

---

## 四、给 AI 的硬约束

1. **别装依赖**：零依赖，`npm install` 是错的
2. **别碰密钥**：不要用 `echo` / 日志 / commit message 输出完整 Key
3. **别改监听地址**：`app.bind` 保持 `127.0.0.1`
4. **别手改 config.json 结构**：用 `POST /api/config` 做局部合并，直接改容易丢字段
5. **别提交 data/**：里面有密钥、聊天记录、记忆
6. **别拿真实联系人做压测**：测发送用「文件传输助手」
7. **改代码后跑检查**：`npm run check`（对所有 `server/*.mjs` 做 `node --check`）

---

## 五、常见故障速查

| 现象 | 排查 |
|---|---|
| 启动报 `EADDRINUSE` | 端口被占：`stop.cmd` / `./stop.sh`，或改 `app.port` |
| 控制台打不开 | 确认进程还在；`curl /api/health` |
| 模型一直 401 | Key 打码值被误写回：重新 POST 一次真实 Key |
| 回复很慢 | 记忆打标签是异步的，慢通常在模型；看日志里的耗时 |
| 收到消息但不回 | 看日志 `跳过 [原因]`：`group_not_mentioned` / `chat_not_enabled` / `rate_limit` |
| 记忆是空的 | 多聊两轮；或 `memory.enabled` / 该聊天的 `memory.enabled` 被关 |
| 装了插件没工具 | 没启用或没重载：`POST /api/plugins/reload` |
