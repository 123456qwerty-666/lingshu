# HTTP API

默认监听 `http://127.0.0.1:17890`，全部为 JSON。
（`/api/logs/stream` 是 SSE；其余全部是 `application/json`。）

## 状态

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/health` | GET | 微信/Hook/SSE 状态、收发统计、reader 状态、最近日志 |
| `/api/logs?limit=100` | GET | 日志（最多 500 条） |
| `/api/logs/stream` | GET | SSE 实时日志流 |

## 配置

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/config` | GET | 读配置（API Key 打码为 `sk-xxx***`） |
| `/api/config` | POST | 局部更新（深度合并；`***` 结尾的值会被忽略，避免误覆盖密钥） |
| `/api/config/secret` | POST | 用 Windows DPAPI 加密保存密钥到 `data/secrets/` |

## 聊天

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/sessions` | GET | 微信会话列表 |
| `/api/chats` | GET | 已接入聊天 + 读取器白名单 |
| `/api/chats/search` | POST | 搜索好友/群 `{query, kind?}` |
| `/api/chats/add` | POST | 添加 `{talker, kind, conversationId?, name?}` |
| `/api/chats/remove` | POST | 移除 `{talker}` |
| `/api/chats/settings` | GET/POST | 单聊设置（模型/插件/人设/语气/触发/记忆/上下文） |
| `/api/chat/history?talker=&limit=` | GET | 历史消息 |
| `/api/send/text` | POST | 手动发文本 `{talker, text}` |
| `/api/send/image` | POST | 手动发图片 `{talker, filePath}` |

## AI

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/ai/quick` | POST | **一键接入 DeepSeek** `{apiKey, providerId?}`：写地址、拉模型、选 V4.1-Flash 作对话+识图模型，并测试连通 |
| `/api/ai/providers` | GET | 提供商列表（含是否配 Key、是否默认/备用） |
| `/api/ai/models?provider=` | GET | 某提供商的模型 |
| `/api/ai/models/refresh` | POST | 拉 `GET /v1/models` 并写回配置 `{providerId}` |
| `/api/ai/test` | POST | 测试对话 `{providerId?, model?, prompt?}` |
| `/api/ai/providers/delete` | POST | 删除提供商 `{providerId}` |

## 预设人格

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/personas` | GET | 人格列表（id / 名称 / 标签 / 简介，不含提示词正文） |
| `/api/personas/get?id=` | GET | 取完整定义（含 prompt） |
| `/api/personas/apply` | POST | 套用 `{id, talker?}`；不给 talker 就是全局 |

## 工具与插件

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/tools` | GET | 所有已加载工具 |
| `/api/tools/call` | POST | 直接调用 `{pluginId, toolName, args, talker?}` |
| `/api/plugins` | GET | 插件清单（含工具名、启用状态、是否内置） |
| `/api/plugins/scaffold` | POST | 新建插件 `{id, name, description}` |
| `/api/plugins/delete` | POST | 删除用户插件 `{id}` |
| `/api/plugins/reload` | POST | 重载全部插件 |
| `/api/plugins/code?id=` | GET/PUT | 读写插件代码。GET 返回 `{code, builtin, path}`；内置插件只读，PUT 会报错 |

## 上下文

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/context/usage?talker=` | GET | token 用量、压缩阈值、摘要 |
| `/api/context/compress` | POST | 压缩 `{talker, force?}` |
| `/api/context/clear` | POST | 清空 `{talker, keepSummary?}` |
| `/api/context/summary` | PUT | 直接改写滚动摘要 `{talker, summary}` |

## 记忆

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/memory` | GET | 总览（会话数、记忆数、即将遗忘数） |
| `/api/memory/detail?talker=` | GET | 会话记忆 + 成员记忆 + 画像 + 上下文用量 |
| `/api/memory/add` | POST | 新增 `{talker, memberKey?, memberName?, text, importance?, kind?, tags?}` |
| `/api/memory/update` | POST | 修改 `{talker, id, memberKey?, patch}` |
| `/api/memory/delete` | POST | 忘掉 `{talker, id, memberKey?}`（进归档） |
| `/api/memory/restore` | POST | 从归档捞回 `{talker, id}` |
| `/api/memory/archive?talker=` | GET | 归档列表 |
| `/api/memory/search` | POST | 检索 `{talker, query, memberKey?, limit?}` |
| `/api/memory/forget` | POST | 执行/预演遗忘 `{talker?, dryRun?}` |
| `/api/memory/compact` | POST | 压缩记忆 `{talker}` |
| `/api/memory/dedupe` | POST | 合并重复记忆 `{talker, dryRun?}`（同义改写会被并成一条） |
| `/api/memory/clear` | POST | 清空某会话全部记忆 `{talker}`（进归档，可捞回） |
| `/api/memory/profile` | POST | 重建画像 `{talker, memberKey}` |
| `/api/memory/sweep` | POST | 全库巡检（遗忘 + 压缩） |

## 调试

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/debug/send` | POST | 模拟收到一条消息，走完整链路（会真的发出回复） |
| `/api/debug/raw` | POST | 原样注入 reader 结构的 payload（用于复现边界情况） |
| `/api/wechat/reconnect` | POST | 重建微信连接 |

## 静态资源

| 路径 | 说明 |
|---|---|
| `/` | 控制台 |
| `/media/*` | `data/media` 下的文件（生成的图片等） |

## 示例

```bash
# 自检：模拟收到一条消息
curl -X POST http://127.0.0.1:17890/api/debug/send \
  -H 'Content-Type: application/json' \
  -d '{"talker":"filehelper","conversationId":"165338666","text":"你好"}'

# 看这个聊天想起来了什么
curl -X POST http://127.0.0.1:17890/api/memory/search \
  -H 'Content-Type: application/json' \
  -d '{"talker":"filehelper","query":"他喜欢吃什么"}'

# 手动压缩上下文
curl -X POST http://127.0.0.1:17890/api/context/compress \
  -H 'Content-Type: application/json' \
  -d '{"talker":"filehelper","force":true}'
```
