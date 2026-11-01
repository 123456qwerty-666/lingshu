# AI Agent 完全执行手册

> **这份文档是写给 AI 的**，不是写给人的。
> 你（一个能执行命令的 AI 代理）读完它，应该能在**一台陌生的电脑**上，把灵枢从零装好、配好模型、接上微信、验证通过，并给出交付说明。
>
> 人类用户看 [README](../README.md)；只想要提示词看 [DEPLOY-AI.md](DEPLOY-AI.md)；报错查 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。

---

## 0. 你的任务与成功标准

**目标**：让这台电脑上跑起灵枢，用户打开 <http://127.0.0.1:17890> 就能用。

**成功标准（全部满足才算完成）**：

| # | 检查项 | 命令 | 期望 |
|---|---|---|---|
| 1 | 服务活着 | `curl -s http://127.0.0.1:17890/api/health` | `"ok":true` |
| 2 | 模型通 | `POST /api/ai/test` | 返回正常文本 |
| 3 | 工具加载 | `curl -s /api/tools` | 8 个工具 |
| 4 | 链路通 | `POST /api/debug/send` + 看日志 | 出现「已回复」 |
| 5 | 无报错 | `GET /api/logs?limit=30` | 没有 `"level":"error"` |
| 6 | 无泄漏 | `git status` | 没有 `data/` |

**不要做的事**：不要 `npm install`（零依赖）；不要改 `app.bind`；不要把 Key 写进仓库。

---

## 1. 事实速查（记住这张表，90% 的命令都靠它）

| 项 | 值 |
|---|---|
| 项目名 | 灵枢 AI 中枢 / LingShu Hub |
| 仓库 | https://github.com/123456qwerty-666/lingshu |
| 运行时 | Node.js ≥ 20（ESM），**零依赖** |
| 入口 | `server/index.mjs` |
| 初始化 | `node scripts/bootstrap.mjs`（幂等） |
| 端口 | `127.0.0.1:17890`（只监听本机） |
| 数据目录 | `data/`（已在 .gitignore，含密钥/聊天/记忆） |
| 健康检查 | `GET /api/health` |
| 配置读写 | `GET/POST /api/config`（POST 是**局部深度合并**） |
| 冒烟测试 | `POST /api/debug/send` |
| 语法检查 | `npm run check` |
| 日志 | `GET /api/logs?limit=N`、SSE `GET /api/logs/stream` |

**Windows / macOS / Linux 三条命令差异**：

| 操作 | Windows | macOS / Linux |
|---|---|---|
| 启动 | `start.cmd` 或 `node server\index.mjs` | `./start.sh` 或 `node server/index.mjs` |
| 停止 | `stop.cmd` | `./stop.sh` |
| 看端口 | `netstat -ano \| findstr :17890` | `lsof -ti tcp:17890` |
| 杀进程 | `taskkill /F /PID <pid>` | `kill -9 <pid>` |

---

## 2. 阶段一：环境检测

```bash
node -v          # 必须 >= v20
git --version    # 没有 git 就下 ZIP
curl --version   # Windows 10+ 自带
```

### 判定分支

| 情况 | 动作 |
|---|---|
| Node 缺失或 < 20 | 让用户去 <https://nodejs.org> 装 LTS，或（有包管理器时）`choco install nodejs-lts` / `brew install node` |
| 没有 git | 让用户下载仓库 ZIP 解压，后续步骤完全一样 |
| 端口 17890 被占 | 见第 3 节「端口冲突」 |
| 无管理员权限 | 没关系，全程不需要管理员（除装 Node） |

**先问清楚一件事**（影响后面所有步骤）：**要不要接微信？**
- 要 → 需要用户自备「读取器 + 发送器」两个本地服务（第 6 节）
- 不要 → 直接跳到第 5 节收尾，控制台/记忆/插件/搜索都能用

---

## 3. 阶段二：获取 + 启动

```bash
git clone https://github.com/123456qwerty-666/lingshu.git
cd lingshu
node scripts/bootstrap.mjs
node server/index.mjs
```

### 期望输出

```
灵枢 AI 中枢 — 初始化
  ✓ Node.js v22.x
  ✓ 数据目录就绪 (data/)
  ✓ 已从 config.example.json 生成 data/config.json
  ! 有 1 个提供商，但都还没填 API Key     ← 正常
  ✓ 已启用插件：image-gen, vision, memory, web-search
  ✓ 记忆系统已开启
  ✓ 端口 17890 空闲
```

然后：

```
[INFO] 灵枢 AI 中枢 v0.4 启动中…
[INFO] 插件就绪，共 8 个工具
[INFO] Server listening on http://127.0.0.1:17890
```

### 后台运行

| 场景 | 做法 |
|---|---|
| Windows 长期跑 | 双击 `start.cmd`（有独立窗口，出错会 pause） |
| macOS / Linux | `nohup ./start.sh > /tmp/lingshu.log 2>&1 &` 或 `tmux new -d 'cd <dir> && ./start.sh'` |
| 你自己的沙箱 | 用后台任务跑 `node server/index.mjs`，注意记录 PID 便于停止 |

### 端口冲突

```
Error: listen EADDRINUSE: address already in use 127.0.0.1:17890
```

1. 先判断是不是已经跑起来了：`curl -s http://127.0.0.1:17890/api/health` 有响应 → 直接用，别重启
2. 不是自己起的 → 杀掉占用进程（见第 1 节表格）
3. 都不想动 → 改端口：`data/config.json` 的 `app.port`，如 17891，重启

---

## 4. 阶段三：接入 AI 模型

这是最关键的一步。**必须拿到两样东西：Base URL 和 API Key。**
用户没给就问，不要猜、不要编。

### 4.1 主流服务商参数表

| 服务 | Base URL | 常见模型 id | 备注 |
|---|---|---|---|
| **DeepSeek** | `https://api.deepseek.com` | `deepseek-chat` / `deepseek-reasoner`；新版本可能是 `deepseek-flash` / `deepseek-v4-pro` | 便宜、国内可直连，推荐默认 |
| **OpenAI** | `https://api.openai.com/v1` | `gpt-4o` / `gpt-4o-mini` | 需外网 |
| **OpenRouter** | `https://openrouter.ai/api/v1` | `openai/gpt-4o`、`anthropic/claude-3.5-sonnet` | 一个 Key 用多家 |
| **硅基流动** | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-72B-Instruct` 等 | 国内直连，有免费额度 |
| **月之暗面 Kimi** | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` 等 | 长上下文 |
| **智谱 GLM** | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-plus` 等 | 国内直连 |
| **阿里通义** | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` / `qwen-max` | 兼容模式 |
| **火山方舟** | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-*`（用接入点 id） | 需先在控制台建接入点 |
| **Gemini 官方** | `https://generativelanguage.googleapis.com/v1beta/openai/` | `gemini-2.5-flash` | OpenAI 兼容层 |
| **各类中转站** | 中转站给的地址 | 看它 `/v1/models` | 便宜但不稳定，适合当备用 |
| **本地 Ollama** | `http://127.0.0.1:11434/v1` | `qwen2.5` / `llama3.1` | 先 `ollama serve` |
| **本地 LM Studio** | `http://127.0.0.1:1234/v1` | 你加载的模型 | 开 Local Server |
| **vLLM** | `http://127.0.0.1:8000/v1` | 部署的模型 | 自建 |

> ⚠️ 模型 id 会随服务商更新而变化。**不要凭记忆写死**——用灵枢的「刷新模型」自动拉取，这才是唯一可靠来源。

### 4.2 标准接入流程（4 条命令）

```bash
BASE='http://127.0.0.1:17890'
KEY='<用户给的 key>'
PID='deepseek'          # 自己起个英文 id
URL='https://api.deepseek.com'

# 1) 写提供商
curl -s -X POST $BASE/api/config -H 'Content-Type: application/json' -d "{
  \"ai\": { \"providers\": { \"$PID\": {
    \"name\": \"DeepSeek\",
    \"baseUrl\": \"$URL\",
    \"apiKey\": \"$KEY\",
    \"models\": []
  } } }
}"

# 2) 拉模型列表（自动写回配置，别手抄）
curl -s -X POST $BASE/api/ai/models/refresh -H 'Content-Type: application/json' \
  -d "{\"providerId\":\"$PID\"}"

# 3) 看有哪些模型可选
curl -s "$BASE/api/ai/models?provider=$PID"

# 4) 设默认 + 验证
curl -s -X POST $BASE/api/config -H 'Content-Type: application/json' \
  -d "{\"ai\":{\"defaultProvider\":\"$PID\",\"defaultModel\":\"<从第3步挑一个>\"}}"
curl -s -X POST $BASE/api/ai/test -H 'Content-Type: application/json' \
  -d '{"prompt":"只回答两个字：正常"}'
```

第 4 步返回类似：

```json
{"ok":true,"content":"正常","provider":"deepseek","model":"deepseek-chat"}
```

就说明模型通了。

### 4.3 配多个提供商 + 自动降级（强烈建议）

```bash
curl -s -X POST $BASE/api/config -H 'Content-Type: application/json' -d '{
  "ai": {
    "defaultProvider": "deepseek",
    "fallbackProviders": ["my-proxy", "siliconflow"]
  }
}'
```

行为：主提供商 429 / 402 / 403 / 5xx / 网络错误 → 自动换下一个；并记住上次成功的那个。
日志会写 `已自动切换到 xxx/yyy`。

**这是免费额度用户的救命功能，几乎一定要配。**

### 4.4 接入图片生成模型（和对话模型分开配）

绘图走 `/v1/images/generations`，可以完全用另一个服务商：

```bash
curl -s -X POST $BASE/api/config -H 'Content-Type: application/json' -d '{
  "ai": { "providers": { "my-image": {
    "name": "绘图服务",
    "baseUrl": "https://api.example.com/v1",
    "apiKey": "<key>",
    "models": [
      { "id": "flux-1.1-pro", "name": "FLUX 1.1 Pro", "imageGen": true }
    ]
  } } }
}'
```

要点：

- `imageGen: true` 是标记，灵枢据此挑选绘图提供商（`id` 里带 `image` 也会被识别）
- **不需要**设成 defaultProvider，灵枢会自动找带绘图模型的提供商
- 先验证一下服务商是否真的实现了这个端点：

```bash
curl -s -X POST https://api.example.com/v1/images/generations \
  -H "Authorization: Bearer <key>" -H 'Content-Type: application/json' \
  -d '{"model":"flux-1.1-pro","prompt":"a cat","n":1}' | head -c 300
```

常见坑：`n` 只能为 1、返回的是 URL 而不是 base64、耗时 10~30 秒、免费额度 429。
这些灵枢都处理了（自动重试 4s/8s）。

### 4.5 本地模型

```bash
# Ollama
ollama serve            # 另开一个终端
ollama pull qwen2.5

curl -s -X POST http://127.0.0.1:17890/api/config -H 'Content-Type: application/json' -d '{
  "ai": {"providers": {"ollama": {
    "name":"本地 Ollama","baseUrl":"http://127.0.0.1:11434/v1",
    "apiKey":"ollama","models":[{"id":"qwen2.5","name":"qwen2.5"}]
  }}, "defaultProvider":"ollama", "defaultModel":"qwen2.5"}
}'
```

Ollama 不校验 Key，但字段不能空，随便填 `ollama`。

### 4.6 模型选型建议

| 用途 | 建议 |
|---|---|
| 日常聊天（中文） | DeepSeek / Qwen / GLM |
| 需要看图 | 支持 vision 的模型（DeepSeek flash 系、gpt-4o、gemini） |
| 要省钱 | 小模型做对话，大模型只做复杂任务（按聊天配不同模型） |
| 要稳定 | 至少配 2 个提供商 + fallback |

---

## 5. 阶段四：验证（不接微信也能做完）

```bash
BASE=http://127.0.0.1:17890

# 1) 健康
curl -s $BASE/api/health

# 2) 工具数量（应为 8）
curl -s $BASE/api/tools | grep -o '"name":"[^"]*"'

# 3) 建一个测试聊天（没有微信时 conversationId 随便填）
curl -s -X POST $BASE/api/chats/add -H 'Content-Type: application/json' \
  -d '{"talker":"demo","kind":"private","conversationId":"1","name":"演示"}'

# 4) 走全链路
curl -s -X POST $BASE/api/debug/send -H 'Content-Type: application/json' \
  -d '{"talker":"demo","text":"用一句话介绍你自己"}'

# 5) 看日志
curl -s "$BASE/api/logs?limit=20"
```

**判定**：

- 日志出现 `收到 [debug] private/demo: ...` → 说明解析+触发 OK
- 出现 `已回复 demo（1 条）` → 说明模型+发送 OK
- 出现 `发送失败: 发送端未初始化` → **正常**（没接微信），模型部分是成功的

做完这一步，就已经是一个能用的 AI 了（只是没接到微信）。

---

## 6. 阶段五：接入微信

### 6.1 先搞清楚拓扑

```
微信客户端 ←→ Reader(5031)  读会话/消息/图片，SSE 推新消息
           ←→ Hook(30001)   发文本/图片/文件
                  ↕
               灵枢 server (17890)
```

**这两个组件是第三方的，不在本仓库里。** 用户必须自己装好。
你要做的是：确认它们活着 → 把地址和账号填进灵枢 → 验证。

### 6.2 前置检查（先确认外部服务可用）

```bash
# Reader 活着吗
curl -s -H "Authorization: Bearer <readerToken>" http://127.0.0.1:5031/api/v1/reader/status
# 期望：{"success":true,"ownWxid":"wxid_xxx","accountDirectory":"wxid_xxx_1234",...}

# Hook 活着吗 + 能不能发文件
curl -s -H "Authorization: Bearer <hookToken>" \
  -H "X-WeChatAgent-Account: <accountDirectory>" \
  http://127.0.0.1:30001/WeChatAgent/health
# 期望：{"nativeFileSend":true,"nativeStickerSend":true,"version":"4.1.10.27",...}
```

`nativeFileSend: false` → 发图片会失败，只能发文本。

### 6.3 填进灵枢

```bash
curl -s -X POST http://127.0.0.1:17890/api/config -H 'Content-Type: application/json' -d '{
  "wechat": {
    "readerUrl": "http://127.0.0.1:5031",
    "hookUrl": "http://127.0.0.1:30001",
    "readerToken": "<可选，会自动从配置文件读>",
    "hookToken": "<可选>",
    "account": "wxid_xxx_1234",
    "botNames": ["<机器人在微信里的昵称>"],
    "wakeWords": ["AI", "灵枢"],
    "triggerMode": "smart"
  }
}'

# 重连并验证
curl -s -X POST http://127.0.0.1:17890/api/wechat/reconnect
curl -s http://127.0.0.1:17890/api/health
```

看 `state` 里三个布尔：

| 字段 | true 表示 |
|---|---|
| `connected` | Reader 通了（能读） |
| `sseConnected` | 推送订阅成功（能收） |
| `hookConnected` | Hook 通了（能发） |

三个都 true 才算接好。

### 6.4 授权会话（最容易卡住的一步）

读取器通常**只轮询它自己白名单里的会话**。灵枢加了聊天 ≠ 读取器会推。

```bash
# 看读取器会不会给你这个会话的消息
curl -s -H "Authorization: Bearer <readerToken>" \
  "http://127.0.0.1:5031/api/v1/messages?talker=<wxid或chatroom>&limit=1"
# 报 "Conversation is not selected" → 就是没授权
```

解法：去读取器的配置里把该会话加进白名单。
灵枢的 `server/agent-bridge.mjs` 会在 `/api/chats/add` 时尝试同步特定格式的配置，
但它只认某类项目的文件结构，不是万能的。

### 6.5 添加聊天

```bash
# 先搜（拿 conversationId）
curl -s -X POST http://127.0.0.1:17890/api/chats/search \
  -H 'Content-Type: application/json' -d '{"query":"文件传输"}'

# 再加
curl -s -X POST http://127.0.0.1:17890/api/chats/add \
  -H 'Content-Type: application/json' \
  -d '{"talker":"filehelper","kind":"private","conversationId":"<上一步拿到的>","name":"文件传输助手"}'
```

### 6.6 三个必须知道的坑

| 坑 | 现象 | 说明 |
|---|---|---|
| **文件传输助手收不到消息** | 发给自己，机器人没反应 | 自发消息 `isSend=1`，读取器会丢弃。**只能用来测发送**。测收消息必须用联系人/群 |
| **白名单** | 日志一条 `收到 [sse]` 都没有，`pushed` 恒为 0 | 见 6.4 |
| **发文件 400** | `Hook 400: {"ret":1}` | 发送端要求文件落在 `state/files/outgoing/<64位hex>/` 且 md5/size 精确匹配。灵枢已自动处理；换版本后可能要改 `findHookModuleDir()` |

### 6.7 群聊配置

```bash
curl -s -X POST http://127.0.0.1:17890/api/chats/settings -H 'Content-Type: application/json' -d '{
  "talker":"<xxx@chatroom>",
  "patch": {
    "persona":"你是群里的助手，说话简短，别抢话",
    "triggerMode":"mention",
    "plugins":["web-search","memory"],
    "memory":{"enabled":true}
  }
}'
```

`botNames` 一定要填对（和微信里机器人昵称一致），否则群里 `@` 识别不到。

---

## 7. 阶段六：插件

完整开发指南见 [PLUGINS.md](PLUGINS.md)。这里只说 **AI 要做的事**。

### 安装别人的插件

```bash
cp -r <插件目录> plugins/
curl -s -X POST http://127.0.0.1:17890/api/plugins/reload
curl -s http://127.0.0.1:17890/api/plugins   # 确认 enabled=true 且有 tools
```

没启用就补进 `plugins.enabled` 再 reload。

### 给用户写一个新插件

**必须遵守的模板**（照抄，别自创结构）：

```js
export function setup(ctx) {
  return {
    tools: [{
      name: 'my_tool',
      description: '做什么用的。什么时候该调用。参数：a(说明), b(说明)',
      parameters: {
        type: 'object',
        properties: {
          a: { type: 'string', description: '...' },
        },
        required: ['a'],
      },
      async run(args, runtime) {
        try {
          // 所有网络请求都加超时
          const resp = await fetch('https://...', { signal: AbortSignal.timeout(10000) });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const data = await resp.json();
          return { success: true, data };
        } catch (e) {
          ctx.log(`my_tool 失败：${e.message}`);
          return {
            success: false,
            error: e.message,
            hint: '如实告诉用户失败了，不要编造结果',
          };
        }
      },
    }],
  };
}
```

配 `plugin.json`（id 和目录名一致），reload，然后用 `/api/tools/call` 单测。

### 插件相关的硬约束

- 不要 `npm install`（零依赖，用原生 `fetch` / `fs`）
- 不要在插件里写死密钥，需要就用 `ctx.config` 或读 `data/config.json`
- 每个网络请求都要有 `AbortSignal.timeout(...)`
- 返回图片用 `{ path: '/abs/path.png' }`（会自动发送）
- 失败要返回 `{ success:false, error, hint }`，`hint` 决定模型怎么跟用户解释

---

## 8. 阶段七：记忆与上下文（按需调）

默认配置已经能跑。用户有特殊要求时：

| 用户说 | 改什么 |
|---|---|
| "别记那么多没用的" | `memory.tag.minImportance` ↑（0.3）、`tag.maxItemsPerTurn` ↓（2） |
| "忘得太快了" | `memory.decay.baseStabilityHours` ↑（60）、`forgetThreshold` ↓（0.2） |
| "重要的事一定要记住" | `memory.pinImportance` ↓（0.75），或让用户手动「钉住」 |
| "省点 token" | `memory.autoTag=false`（不再每轮多一次调用） |
| "别压缩太快" | `context.compressAtTokens` ↑（120000）、`keepRecentMessages` ↑（30） |
| "只想清空某个聊天" | `POST /api/context/clear {talker}` |

改完不需要重启（配置热读），但 `memory` 段的部分参数在下次巡检时生效。

---

## 9. 阶段八：交付

最后给用户一段**可直接读**的总结，包含：

```
✅ 已部署完成

控制台：http://127.0.0.1:17890
启动：<双击 start.cmd / ./start.sh / node server/index.mjs>
停止：<stop.cmd / ./stop.sh>

模型：<提供商> / <模型 id>（备用：<...>）
工具：8 个（绘图 / 识图 / 记忆×4 / 联网搜索×2）
微信：<已接入：账号 xxx，已授权 N 个会话 / 未接入>

接下来你可以：
1. 浏览器打开控制台，在「AI 配置」里加更多模型
2. 「聊天」页搜索好友/群 → 添加 → 直接在微信里跟它聊
3. 「记忆」页看它记住了什么，可手动增删改

常见问题看 docs/TROUBLESHOOTING.md
```

---

## 10. 决策树

### 「用户没有微信工具」

→ 跳过第 6 节。做完第 5 节就算交付。
用 `/api/debug/send` 演示效果，告诉用户后续接微信看 `docs/WECHAT.md`。

### 「模型连不上」

1. `curl -s <baseUrl>/models -H "Authorization: Bearer <key>"` — 先确认这个 key 本身能用
2. 401 → key 错；404 → baseUrl 拼错；超时/ECONNREFUSED → 网络或代理
3. 都不行 → 换一个国内可直连的服务商（DeepSeek / 硅基流动 / 智谱）

### 「用户很在意花钱」

1. 对话用小模型（`gpt-4o-mini` / `deepseek-chat` / `qwen-turbo`）
2. `memory.autoTag=false`（省掉每轮一次打标签调用）
3. `context.compressAtTokens` 调小（如 24000），减少上下文长度
4. 配一个付费主 + 一个免费备用

### 「用户想让它像人」

1. `memory.enabled=true`、`autoTag=true`（默认）
2. 在「聊天设置」里写 `persona`（人设）+ `style`（语气）
3. 让它多聊几轮，记忆会自己长起来
4. 提醒用户：「记忆」页能看到它记住了什么，可以手动纠正

### 「要控制在局域网/远程访问」

**不要改 `app.bind`**。正确做法：用反向代理（Nginx/Caddy）+ 认证，或 SSH 隧道 `ssh -L 17890:127.0.0.1:17890 user@host`。

---

## 11. 绝对不要做

1. ❌ `npm install` —— 会把零依赖变成有依赖
2. ❌ 把 `data/` 提交到 git —— 里面有明文密钥、聊天记录、记忆
3. ❌ 把打码的 Key（`sk-xxx***`）当成真 Key 回传 —— 会被忽略，看起来像"没保存成功"
4. ❌ 改 `app.bind` 为 `0.0.0.0` —— 等于把聊天记录和密钥挂到局域网
5. ❌ 用「文件传输助手」验证收消息 —— 永远收不到，会误判成 bug
6. ❌ 对真实联系人做批量测试 —— 只在用户明确同意时发消息
7. ❌ 凭记忆写模型 id —— 一律用 `/api/ai/models/refresh` 拉
8. ❌ 在日志/回复/commit message 里打印完整 Key

---

## 12. 一页纸检查表

```
[ ] node -v ≥ 20
[ ] git clone && cd
[ ] node scripts/bootstrap.mjs   → 全绿（Key 除外）
[ ] node server/index.mjs        → 打印控制台地址
[ ] GET /api/health              → ok:true
[ ] POST /api/config             → 写 provider
[ ] POST /api/ai/models/refresh  → 拿到模型列表
[ ] POST /api/config             → 设 defaultProvider/defaultModel
[ ] POST /api/ai/test            → 返回正常文本
[ ] POST /api/config             → 配 fallbackProviders（建议）
[ ] GET /api/tools               → 8 个工具
[ ] POST /api/chats/add          → 建测试聊天
[ ] POST /api/debug/send         → 日志出现"已回复"
[ ] （可选）接微信：config + reconnect + health 三绿
[ ] （可选）chats/search + add   → 授权会话
[ ] GET /api/logs                → 无 error
[ ] git status                   → 无 data/
[ ] 给用户交付说明
```
