# 插件开发

## 最小插件

```
plugins/hello/
├── plugin.json
└── index.mjs
```

`plugin.json`

```json
{
  "id": "hello",
  "name": "打个招呼",
  "version": "1.0.0",
  "description": "示例插件",
  "entry": "index.mjs",
  "capabilities": ["tool"],
  "config": []
}
```

`index.mjs`

```js
export function setup(ctx) {
  ctx.log('hello 插件已加载');

  return {
    tools: [
      {
        name: 'say_hello',
        description: '跟某人打招呼。参数：name',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', description: '对方名字' } },
          required: ['name'],
        },
        async run(args, runtime) {
          return { message: `你好，${args.name}！` };
        },
      },
    ],
  };
}
```

放进 `plugins/` 目录 → 控制台「插件」页启用 → 点「重载插件」，模型就能用了。

## ctx（插件上下文）

| 字段 | 说明 |
|---|---|
| `ctx.id` | 插件 id |
| `ctx.log(msg, level?)` | 写日志（会显示在控制台） |
| `ctx.ai` | AI 客户端（`chat` / `chatWithTools` / `generateImage`） |
| `ctx.wechat` | 微信驱动（`sendText` / `sendImageFile` / `getReader`…） |
| `ctx.fs` / `ctx.path` | Node 的 fs / path |
| `ctx.dataDir` | 该插件的私有数据目录（已自动创建） |
| `ctx.config` | plugin.json 里的 `config` 默认值 |

## runtime（每次调用的上下文）

```js
async run(args, runtime) {
  runtime.talker         // 当前会话 id（wxid 或 xxx@chatroom）
  runtime.kind           // 'private' | 'group'
  runtime.conversationId // 平台侧会话 id
  runtime.senderWxid     // 说话的人
  runtime.senderName     // 说话的人昵称
  runtime.pluginId       // 自己的插件 id
}
```

用它来做"跟着当前聊天走"的事，比如记忆读写：

```js
import { addMemories } from '../../server/memory.mjs';

export function setup() {
  return {
    tools: [{
      name: 'note_down',
      description: '记下一条信息',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      async run(args, runtime) {
        addMemories(runtime.talker, [{ text: args.text, importance: 0.8 }], {
          memberKey: runtime.senderWxid,
          memberName: runtime.senderName,
        });
        return { success: true };
      },
    }],
  };
}
```

## 返回值约定

| 字段 | 作用 |
|---|---|
| `success: false` | 标记失败，主流程会打 warn 日志 |
| `error` | 错误描述（会喂给模型，让它如实转述） |
| `hint` | 给模型的额外指导，例如"打不开就告诉用户，不要编造" |
| `path` / `imagePath` / `images[]` | 图片路径，主流程会**自动发送到当前聊天**并清理 |

工具返回的 JSON 会被截断到 8000 字符再喂给模型，别返回超大对象。

## 与图片/文件打交道

工具只要返回图片路径，主流程就会：

1. `sendImageFile(talker, path)` 发到当前聊天
2. 若文件在 `data/media/pending-send/` 下，发送成功后删除
3. 结果里回填 `_note: '图片已自动发送…'`，避免模型重复发送

所以插件只管**生成**，不用管**发送**。

## 调试技巧

- 控制台「插件」页 → 代码 → 在线编辑 → 保存 → 重载，秒级生效
- `ctx.log()` 的输出直接进控制台日志页
- 想看工具被调用的参数：日志里会显示工具名与失败原因
- 想单独测一个工具：

```bash
curl -X POST http://127.0.0.1:17890/api/tools/call \
  -H 'Content-Type: application/json' \
  -d '{"pluginId":"hello","toolName":"say_hello","args":{"name":"世界"},"talker":"filehelper"}'
```

## 注意事项

- 插件里**不要写死密钥**，需要配置就放 `plugin.json` 的 `config`，或读 `data/config.json`
- 插件是 ESM，导入本地模块要用相对路径或 `pathToFileURL()`
- 插件运行在主进程里：别写死循环、别长时间阻塞（超过 30 秒会拖慢整个回复）
- 需要联网时自己控好超时（参考 `web-search` 的 `AbortSignal.timeout`）

## 内置插件怎么写的

| 插件 | 值得看的地方 |
|---|---|
| `web-search` | 三引擎降级、HTML 解析、编码识别、错误文案 |
| `image-gen` | 调图片接口、下载/落盘、失败分类提示 |
| `memory` | 借用核心记忆系统的读写接口，跟着 `runtime` 定作用域 |
| `vision` | 通过 `getReader()` 直接取图片元信息 |
