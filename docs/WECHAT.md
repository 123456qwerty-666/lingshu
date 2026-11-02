# 微信接入

灵枢**不注入微信进程、不改客户端**。它对接两个本机 HTTP 服务，你只要能拿到这两个服务的地址和 token 就行。

```
微信客户端 ←→ Reader(5031)   读会话/消息/图片，SSE 推送
           ←→ Hook(30001)    发文本/图片/文件
                    ↕
                 灵枢 server
```

> 这两个组件属于第三方项目，不在本仓库内。本文只说明灵枢对它们的**调用契约**和踩过的坑。

## 零、微信版本要求（先读这段）

**灵枢不挑微信版本**，但你用的那套注入组件挑。

| 层 | 是否限定版本 | 说明 |
|---|---|---|
| 灵枢 server | 否 | 只调用本机 HTTP 接口，不碰微信进程 |
| Reader / Hook（第三方） | **是** | 靠微信内部偏移与函数表工作，版本必须严格对上 |

当前验证过的组合：**Windows x64 微信 4.1.10.27** + WeChatAgent 0.4.1+。

原因是 Hook 硬编码了微信内部的地址（如文件消息工厂 `0x1C4CE70`、构造函数 `0x18EEDC0`、
函数表 `0x84F96B8` / `0x84F9748`）。微信一升级，这些地址就变了，注入失效或发送直接报错。

实践建议：

1. 用注入组件安装包**自带的那份匹配微信**，不要拿自己装的微信硬上；
2. 装完**关掉微信自动更新**，否则某天静默升级后整套链路会突然失效；
3. 升级顺序永远是「先确认注入组件适配了新版微信」→ 再换微信；
4. 只支持 **Windows x64**，macOS 目前没有可用方案。

排查：如果 `expectedVersion` 与实际微信版本不一致，Hook 健康检查会失败，
控制台顶栏「发送」会显示「断开」。确认命令：

```bash
curl --noproxy '*' http://127.0.0.1:17890/api/health
```

---

## 一、配置

控制台 →「微信设置」：

| 字段 | 说明 |
|---|---|
| Reader 地址 | 默认 `http://127.0.0.1:5031` |
| Hook 地址 | 默认 `http://127.0.0.1:30001` |
| 账号标识 | 形如 `wxid_xxx_1234`，留空则从 reader 的 status 里自动读 |
| 唤醒词 | 群聊里出现这些词才回复，默认 `AI, 灵枢, bot` |
| 机器人昵称 | 与微信里的昵称一致，用于识别 `@` |

Reader token / Hook token 可以填在配置里，也会尝试从常见位置自动读取。

---

## 二、调用契约

### Reader（读）

| 用途 | 请求 |
|---|---|
| 健康 | `GET /api/v1/reader/status` → `{ownWxid, accountDirectory, subscribers, pushed}` |
| 会话 | `GET /api/v1/sessions?limit=N` |
| 联系人 | `GET /api/v1/contacts?keyword=&kind=&limit=` |
| 历史消息 | `GET /api/v1/messages?talker=<id>&limit=N` |
| 图片 | `GET /api/v1/images/<64位id>` → `{b64, mime, width, height}` |
| 图片重试 | `POST /api/v1/images/<id>/retry`（会**重推一次事件**） |
| 实时推送 | `GET /api/v1/push/messages`（SSE，2 秒一次心跳） |

SSE 推送的 payload（关键字段）：

```json
{
  "event": "message.new",
  "sessionId": "wxid_xxx 或 123@chatroom",
  "conversationId": "165338666",
  "sessionType": "private | group",
  "talkerId": "发送者 wxid",
  "senderName": "昵称",
  "content": "消息文本",
  "type": 1,
  "timestamp": 1793527803,
  "image": { "id": "..." }
}
```

`type`：`1` 文本、`3` 图片、`34` 语音、`47` 表情包、`49` 卡片/引用/文件。

> **注意**：读的不是 `text`/`kind`/`sender_wxid` 这类字段名。灵枢的 `router.parseEvent()`
> 同时兼容这个结构与调试用的简化结构。

### Hook（写）

| 用途 | 请求 | 说明 |
|---|---|---|
| 健康 | `GET /WeChatAgent/health` | `nativeFileSend` 必须为 `true` 才能发文件/图片 |
| 发文本 | `POST /SendTextMsg` `{wxidorgid, msg}` | 返回 `ret: 0` 表示**已受理**，不是已送达 |
| 发文件 | `POST /SendFileMsg` `{wxidorgid, path, md5, size}` | 见下方沙箱限制 |

需要两个请求头：

```
Authorization: Bearer <hookToken>
X-WeChatAgent-Account: <账号目录，如 wxid_xxx_1234>
```

---

## 三、三个必踩的坑

### 1. 只推送"白名单"里的会话

读取器通常只轮询它自己配置里授权的会话。**你在灵枢里加了聊天不代表能收到消息**，
还要让读取器那边也授权（灵枢的 `agent-bridge.mjs` 会在添加聊天时尝试同步，
但它只认特定项目的配置格式）。

表现：日志里一条 `收到 [sse]` 都没有，`reader.pushed` 一直是 0。

排查：看控制台「微信设置 → 读取器白名单」是不是空；或直接问读取器的 `/api/v1/messages`
能不能拿到这个 talker 的消息（拿不到会报 `Conversation is not selected`）。

### 2. 发文件有暂存区沙箱

`/SendFileMsg` 只接受落在特定目录里的文件：

```
<hook 模块目录>/../../../../state/files/outgoing/<64位hex>/<文件名>
```

且要求 `size`、`md5` 完全匹配，否则返回 `400 {"ret":1}`。

灵枢的做法（`wechat.mjs` 的 `stageFileForSend`）：先从配置里读出微信可执行文件路径
（hook 就注入在那旁边），据此推出暂存区根目录，复制文件进随机 64 位 hex 子目录，发完即清理。

如果你换了 hook 版本导致路径不同，改 `findHookModuleDir()` 即可。

### 3. 文件传输助手收不到"入站"消息

你发给自己的消息在数据库里是 `isSend=1`，读取器会直接丢弃。
**所以不要用文件传输助手测"收消息"**——它只能用来测"发消息"和控制台自检。

要测真实收消息，用另一个联系人，或一个你在里面的群（群里记得 `@机器人名` 或带唤醒词）。

---

## 四、触发规则

| 模式 | 行为 |
|---|---|
| `smart`（默认） | 私聊全回；群聊需 `@` 或含唤醒词 |
| `mention` | 只有 `@` / 唤醒词才回（私聊也回） |
| `prefix` | 消息必须以唤醒词开头 |
| `all` | 全部消息都回（慎用，群里会刷屏） |
| `off` | 不自动回，只保留手动发送与自检 |

可以给单个聊天覆盖（聊天设置 → 触发方式）。

## 五、排障顺序

1. `/api/health`：`sseConnected` 是否 true、`sseEvents` 是否在涨
2. 读取器 `pushed` 是否在涨 → 不涨说明会话没被授权（见坑 1）
3. 日志里有没有 `跳过 [group_not_mentioned]` / `[chat_not_enabled]`
4. 是不是用文件传输助手测收消息（见坑 3）
5. 发图片 400 → 看 `nativeFileSend` 是否为 true、暂存区路径是否对

常见日志含义：

| 日志 | 含义 |
|---|---|
| `收到 [sse] private/xxx: ...` | 正常收到真实消息 |
| `跳过 [outgoing]` | 自己发的消息，按设计忽略 |
| `跳过 [group_not_mentioned]` | 群聊没 @ 也没唤醒词 |
| `跳过 [chat_not_enabled]` | 这个聊天没在灵枢里启用 |
| `重复事件已忽略` | SSE 重推/图片重试造成的重复，已挡掉 |
| `已自动切换到 xxx` | 主模型限流，降级到备用提供商 |
