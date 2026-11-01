# 错误大全与调试手册

> 按「你看到什么」查，不用懂原理。
> 每条给出：日志原文 → 根因 → 一条命令验证 → 怎么修。

---

## 快速定位（先做这三件事）

```bash
# 1. 服务活着吗
curl -s http://127.0.0.1:17890/api/health

# 2. 最近 30 条日志里有没有 error
curl -s "http://127.0.0.1:17890/api/logs?limit=30" | grep -o '"level":"error"[^}]*' | head

# 3. 模型通路好吗
curl -X POST http://127.0.0.1:17890/api/ai/test \
  -H 'Content-Type: application/json' -d '{"prompt":"只回答两个字：正常"}'
```

三条都正常 → 问题在微信侧或触发规则；第 3 条不正常 → 先修模型，别看别的。

---

## 一、启动阶段

### `Error: listen EADDRINUSE: address already in use 127.0.0.1:17890`

**根因**：端口被占用，最常见是已经启动过一个实例。

```bash
# Windows
netstat -ano | findstr :17890
taskkill /F /PID <PID>
# 或直接双击 stop.cmd

# macOS / Linux
lsof -ti tcp:17890 | xargs kill -9
# 或 ./stop.sh
```

还不行就改端口：`data/config.json` → `app.port` 改成 17891，重启。

### `SyntaxError: Cannot use import statement outside a module`

**根因**：`package.json` 里缺 `"type": "module"`，或被别的 node 版本/工具链接管了。

```bash
node -e "console.log(require('./package.json').type)"   # 应该是 module
node -v                                                  # 应该 >= 20
```

### `Error [ERR_MODULE_NOT_FOUND]: Cannot find module ...`

**根因**：路径不对，或者用了 Windows 绝对路径直接 `import()`。

- 项目内一律用相对路径或 `path.join(ROOT_DIR, ...)`
- 动态导入 Windows 绝对路径必须 `pathToFileURL(p).href`（`server/plugins.mjs` 里有现成写法）

### 中文全是乱码（配置文件 / 日志）

**根因**：文件带 BOM 或不是 UTF-8。`JSON.parse` 遇到 BOM 会直接失败。

```bash
# 查有没有 BOM（前三个字节是 239 187 191 就是有）
node -e "const b=require('fs').readFileSync('data/config.json');console.log([...b.slice(0,3)])"
```

代码里已做 BOM 容错（`config.mjs` 的 `stripBom`），但写文件时别主动加 BOM。
Windows 终端乱码是 `chcp` 问题，`start.cmd` 已 `chcp 65001`。

### 启动就退出，日志只有一行 `灵枢 AI 中枢 v0.4 启动中…`

**根因**：`main()` 里抛异常被吞了。手动跑一遍看完整堆栈：

```bash
node server/index.mjs    # 前台跑，不要重定向
```

---

## 二、模型相关

### `AI 429(deepseek): You've reached the API rate limit for free users…`

**根因**：额度/频率限制。免费中转尤其常见。

**修**：配一个备用提供商，让它在 429 时自动接管。

```bash
curl -X POST http://127.0.0.1:17890/api/config -H 'Content-Type: application/json' \
  -d '{"ai":{"defaultProvider":"deepseek","fallbackProviders":["my-proxy"]}}'
```

日志里会出现 `已自动切换到 my-proxy/xxx`。
如果所有提供商都限流，用户会收到「额度被限流了，过几分钟再叫我」，这是预期行为。

### `AI 401(provider): {"error":{"message":"Invalid API key"}}`

**根因**：Key 错、过期、或写到了错误的提供商下。

```bash
# 看配置里到底存了什么（会打码）
curl -s http://127.0.0.1:17890/api/config | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);for(const[k,v]of Object.entries(j.ai.providers))console.log(k,'→',v.baseUrl,'| key:',v.apiKey||'(空)')})"
```

重写一次：

```bash
curl -X POST http://127.0.0.1:17890/api/config -H 'Content-Type: application/json' \
  -d '{"ai":{"providers":{"my-proxy":{"apiKey":"sk-真实key"}}}}'
```

> 注意：配置接口对 Key 打码为 `sk-xxx***`，**把打码值回传会被忽略**（不会覆盖真实 Key），
> 这是有意设计，别以为是没保存成功。

### `AI 404(provider): {"error":"Not Found"}`

**根因**：Base URL 拼错了。灵枢会自动补 `/v1`，所以填法有讲究：

| 服务商给的地址 | 该填什么 |
|---|---|
| `https://api.deepseek.com` | `https://api.deepseek.com` |
| `https://api.openai.com/v1` | `https://api.openai.com/v1` |
| `https://xxx.com/v1/chat/completions` | 去掉末尾路径，只留 `https://xxx.com/v1` |

代码逻辑（`server/ai.mjs` 的 `endpoint()`）：base 已以 `/v1` 结尾就不再重复拼接。

### `网络错误(provider): fetch failed` / `ECONNREFUSED`

- 公网服务：本机出网被墙/代理问题。换可直连的服务商，或配系统代理。
- 本地模型：服务没起。`curl http://127.0.0.1:11434/v1/models` 验证一下。

### 模型一直转圈，最后 `timeout`

- 长文本 / 推理模型会慢，属正常。灵枢单次请求超时 180s。
- 图片生成超时更常见，已内置 3 次退避重试（4s / 8s）。

### 回复内容为空（日志 `模型返回空内容，未回复`）

**根因**：模型只返回了工具调用没返回正文，或算了半天没输出。

灵枢已有三层兜底：关工具强制作答 → 工具结果兜底 → 才报空。
如果还是空，通常是 `maxTokens` 太小或模型异常，换个模型试。

---

## 三、微信相关

### 日志里一条 `收到 [sse]` 都没有，`/api/health` 的 `sseEvents` 一直是 0

**按顺序查**：

1. `state.sseConnected` 是否 `true`？不是 → 读取器没连上（地址/Token/服务没起）
2. 读取器的 `pushed` 是否在涨？
   ```bash
   curl -s http://127.0.0.1:17890/api/health | grep -o '"pushed":[0-9]*'
   ```
   一直是 0 → **读取器没推这个会话**（白名单问题，见下）
3. 是不是用「文件传输助手」在测？（见下下条）

### `Conversation is not selected` / 读取器返回 `PermissionError`

**根因**：读取器只轮询它自己授权的会话。灵枢加了聊天 ≠ 读取器会推。

**修**：在读取器那边把这个会话加进白名单。
灵枢的 `server/agent-bridge.mjs` 会在「添加聊天」时尝试同步特定格式的配置，但用别的读取器要手工授权。

验证：

```bash
# 换成你的读取器地址和 token
curl -s -H "Authorization: Bearer <readerToken>" \
  "http://127.0.0.1:5031/api/v1/messages?talker=<wxid>&limit=1"
# 返回 PermissionError → 就是没授权
```

### 用「文件传输助手」发消息，机器人没反应

**这是设计如此，不是 bug。**
你发给自己的消息在微信数据库里是 `isSend=1`（已发送），读取器会直接丢弃，永远不会推给灵枢。

**测收消息必须用**：另一个联系人，或你在里面的群（群里 `@机器人名` 或带唤醒词）。
文件传输助手只能用来测**发送**（控制台自检就是发到它）。

### 日志 `跳过 [group_not_mentioned]`

群聊没 `@` 也没唤醒词。三个办法：`@机器人`、消息里带「AI」、或把该群的触发模式改成「全部消息」。

### 日志 `跳过 [chat_not_enabled]`

这个聊天没在灵枢里启用：`GET /api/chats` 看 `enabled`，或去「聊天」页开启。

### 日志 `跳过 [rate_limit]`

每聊天每分钟上限（默认 15 条），防刷屏。改 `config.json` → `rateLimit.maxPerChatPerMinute`。

### 发图片/文件返回 `Hook 400: {"ret":1}`

**根因**：发送器（Hook）对文件有**暂存区沙箱**，文件必须落在：

```
<hook 模块目录>/../../../../state/files/outgoing/<64位hex>/<文件名>
```

且 `size`、`md5` 必须与文件完全一致。灵枢的 `sendFileMsg()` 已经自动做这件事
（找 hook 模块目录 → 复制进随机 hex 子目录 → 发送 → 清理）。

如果换了 hook 版本还是 400，看是不是：
1. `/WeChatAgent/health` 里 `nativeFileSend` 不是 `true`
2. 你的 hook 把暂存区换到别处了 → 改 `server/wechat.mjs` 的 `findHookModuleDir()`

### `Hook 409: {"ret":1,"error":"Version or account mismatch"}`

hook 只支持特定微信版本，且账号头必须对：

```bash
curl -s -H "Authorization: Bearer <hookToken>" \
  -H "X-WeChatAgent-Account: <账号目录>" http://127.0.0.1:30001/WeChatAgent/health
```

`account` 要填成 `wxid_xxx_1234` 这种**账号目录**形式，不是纯 wxid。

### 发出去的图片，微信里显示成"文件"而不是图片

读取器的 `/SendImgMsg` 在新版本里可能没实现（返回 404），只能走文件通道。
微信会按扩展名渲染，png/jpg 通常会显示缩略图。这是发送器侧的限制，不是灵枢的问题。

### 图片读不出来：`读取图片失败 xxx: IMAGE_LOCAL_COPY_UNAVAILABLE`

- 本地没有原图缓存：让微信客户端把那张图点开一次
- 或超时：`IMAGE_PROCESS_TIMEOUT`，重发一次通常会好（灵枢会自动调 retry 接口再取一遍）

### 同一个消息被回复了两次

理论上不会（按 `rawid` 去重 1500 条）。如果出现，看日志有没有 `重复事件已忽略`；
没有的话说明两条消息的 `rawid` 不同——可能是对方真的连发了两条。

---

## 四、记忆与上下文

### 记忆一直是空的

1. `GET /api/memory` 看 `scopes` 是不是 0
2. 确认 `memory.enabled` 和该聊天的 `memory.enabled` 都没关
3. 对话内容太短/太水，模型判定不值得记（这是对的）
4. 看日志有没有 `记忆沉淀跳过: tag_failed` → 模型打标签调用失败

### 日志 `记忆沉淀跳过: tag_failed`

打标签用的是一个独立模型调用，失败通常是限流/超时。不影响主流程，下一轮会补。

### 记忆太多/太少

| 想要 | 调 |
|---|---|
| 少存点 | `memory.tag.minImportance` 调高（如 0.3）、`tag.maxItemsPerTurn` 调低 |
| 忘得快点 | `memory.decay.baseStabilityHours` 调低（如 12） |
| 忘得慢点 | 同上调高（如 60），或 `forgetThreshold` 调低 |
| 重要的事更牢 | `decay.importanceExp` 调高（如 6） |

### 上下文压缩报 `too_short` / `under_threshold`

不是错误。消息太少（< keepRecent+4 条）或没到阈值，正常不压。

### 压缩后感觉"忘了刚才说什么"

摘要会保留人物/事实/约定/未完成事项，但细节会丢——这是压缩的本质。
想保守一点：`context.compressAtTokens` 调大（如 120000），`keepRecentMessages` 调大（如 30）。

### `上下文压缩失败: AI 429`

压缩和对话抢额度。要么配降级提供商，要么把阈值调大减少压缩频率。

---

## 五、插件相关

### 插件列表里没有我的插件

1. 目录名和 `plugin.json` 里的 `id` 要一致
2. 必须有 `index.mjs`，且 `export function setup(ctx)`
3. 必须在 `config.plugins.enabled` 里（控制台「插件」页打开开关）
4. 重载：`POST /api/plugins/reload`

### 日志 `插件 "xxx" 加载失败: 缺少 setup()`

```js
// 对
export function setup(ctx) { return { tools: [...] }; }

// 错（这是 CommonJS 写法）
module.exports = { setup };
```

### 日志 `未找到工具: xxx`

模型调用的工具名和插件里 `name` 不一致，或该插件对这个聊天被禁用了（`chats[talker].plugins`）。

```bash
curl -s http://127.0.0.1:17890/api/tools | grep -o '"name":"[^"]*"'
```

### 工具执行了但没效果

- 看返回值里有没有 `success: false`
- 看日志 `工具 xxx 失败: ...`
- 单独测一次：
  ```bash
  curl -X POST http://127.0.0.1:17890/api/tools/call -H 'Content-Type: application/json' \
    -d '{"pluginId":"my-plugin","toolName":"my_tool","args":{}}'
  ```

### 插件返回的图片没发出去

只有这些字段会被识别：`path` / `imagePath` / `filePath` / `file` / `paths[]` / `images[]` / `files[]`，
且文件必须真实存在、扩展名是 `png/jpg/jpeg/gif/webp/bmp`。

---

## 六、控制台

### 页面白屏

1. F12 看 Console
2. 确认 `public/index.html` 是 UTF-8
3. `curl -s http://127.0.0.1:17890/ | head -3` 看返回是不是 HTML

### 状态灯一直是灰的

`/api/health` 里 `state.connected` 为 false。没接微信时这是正常的。

### 日志页不刷新

点「实时流」。它是 SSE，公司网络/代理可能掐长连接，改用「刷新」按钮。

---

## 七、诊断命令合集

```bash
# 健康总览
curl -s http://127.0.0.1:17890/api/health

# 配置（Key 已打码）
curl -s http://127.0.0.1:17890/api/config

# 提供商与是否配了 Key
curl -s http://127.0.0.1:17890/api/ai/providers

# 工具清单
curl -s http://127.0.0.1:17890/api/tools

# 已接入聊天
curl -s http://127.0.0.1:17890/api/chats

# 某个聊天的上下文用量
curl -s "http://127.0.0.1:17890/api/context/usage?talker=<talker>"

# 某个聊天的记忆明细
curl -s "http://127.0.0.1:17890/api/memory/detail?talker=<talker>"

# 记忆检索（看模型此刻会想起什么）
curl -X POST http://127.0.0.1:17890/api/memory/search -H 'Content-Type: application/json' \
  -d '{"talker":"<talker>","query":"他喜欢吃什么"}'

# 模拟一条消息走全链路
curl -X POST http://127.0.0.1:17890/api/debug/send -H 'Content-Type: application/json' \
  -d '{"talker":"filehelper","conversationId":"<id>","text":"你好"}'

# 语法检查（改完代码必跑）
npm run check
```

---

## 八、日志等级说明

| 等级 | 含义 | 要不要管 |
|---|---|---|
| `debug` | 跳过原因、SSE 原始事件、图片尺寸 | 排查时看 |
| `info` | 收到/回复/授权/记忆沉淀 | 正常 |
| `warn` | 限流、降级、工具失败、压缩跳过 | 通常可忽略，反复出现要查 |
| `error` | 模型调用失败、发送失败、路由异常 | 要查 |

控制台「日志」页顶上可以开实时流。

---

## 九、还是解决不了？按这个模板提问

```
【现象】具体做了什么，看到了什么（贴日志原文）
【环境】系统 / Node 版本 / 有没有接微信
【已试】做过哪些排查，结果如何
【关键输出】
  curl -s http://127.0.0.1:17890/api/health
  curl -s "http://127.0.0.1:17890/api/logs?limit=30"
```

日志原文 > 描述。一句 `Hook 400: {"ret":1}` 能省掉十轮猜测。
