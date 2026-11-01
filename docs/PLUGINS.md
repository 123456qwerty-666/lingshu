# 插件开发与安装

> 插件 = 一个目录 + 两个文件。会写 `async function` 就能写插件。
> 本文覆盖：**怎么装、怎么写、怎么调、怎么发**。

---

## 目录

- [一、插件是什么](#一插件是什么)
- [二、安装插件的四种方式](#二安装插件的四种方式)
- [三、Hello World](#三hello-world)
- [四、接口手册](#四接口手册)
- [五、三个完整实战](#五三个完整实战)
- [六、调试](#六调试)
- [七、打包与分享](#七打包与分享)
- [八、常见错误](#八常见错误)
- [九、内置插件怎么写的](#九内置插件怎么写的)

---

## 一、插件是什么

```
plugins/
└── my-plugin/
    ├── plugin.json     # 元信息（id / 名称 / 描述 / 配置项）
    └── index.mjs       # 代码：export function setup(ctx) { return { tools } }
```

加载时机：服务启动时、点「重载插件」时。
装载后，插件的每个 tool 都会变成模型的**可调用函数**——模型自己决定什么时候调。

一个插件可以有多个 tool，也能只提供工具不提供别的（当前只支持 tools）。

---

## 二、安装插件的四种方式

### 方式 1：网页 30 秒新建（推荐入门）

控制台 →「插件」→ **+ 新建插件** → 填 ID / 名称 / 描述 → 创建
→ 会自动生成目录和脚手架代码，并自动启用 → 点「代码」直接在线改 → 保存 → 重载。

等价 API：

```bash
curl -X POST http://127.0.0.1:17890/api/plugins/scaffold \
  -H 'Content-Type: application/json' \
  -d '{"id":"my-plugin","name":"我的插件","description":"做什么用的"}'
```

### 方式 2：手动放目录（推荐分发）

把别人给你的插件目录，整个复制到 `plugins/` 下面，然后：

```bash
curl -X POST http://127.0.0.1:17890/api/plugins/reload
```

再确认已启用：

```bash
curl -s http://127.0.0.1:17890/api/plugins | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{JSON.parse(d).plugins.forEach(p=>console.log(p.id,'启用='+p.enabled,'工具='+(p.tools||[]).join(',')))})"
```

没启用就用网页打开开关，或：

```bash
curl -X POST http://127.0.0.1:17890/api/config -H 'Content-Type: application/json' \
  -d '{"plugins":{"enabled":["image-gen","vision","memory","web-search","my-plugin"]}}'
curl -X POST http://127.0.0.1:17890/api/plugins/reload
```

> 用户自己写的插件放在 `data/plugins/<id>/`（不在 git 里），内置插件在 `plugins/<id>/`。
> 两处都会被扫描，同 id 时 `data/plugins` 优先——所以改内置插件可以复制一份过去再改。

### 方式 3：从别人的仓库 / 网盘拿

插件就是一个目录，clone 或解压后复制进 `plugins/` 即可：

```bash
git clone https://github.com/someone/lingshu-plugin-weather /tmp/w
cp -r /tmp/w/plugins/weather plugins/
curl -X POST http://127.0.0.1:17890/api/plugins/reload
```

### 方式 4：让 AI 帮你写（本项目主推）

对 AI 说：

```
在 <项目路径>/plugins/ 下写一个插件，id 叫 weather，
提供一个 tool 叫 get_weather，参数 city，
调用 wttr.in 的 JSON 接口返回当前温度和天气。
要求：10 秒超时、失败返回 {success:false,error,hint}，写完帮我 reload。
```

AI 按 [接口手册](#四接口手册) 写就行，不需要额外依赖（用 `fetch` 即可）。

---

## 三、Hello World

`plugins/hello/plugin.json`

```json
{
  "id": "hello",
  "name": "打个招呼",
  "version": "1.0.0",
  "description": "最小示例",
  "entry": "index.mjs",
  "capabilities": ["tool"],
  "config": []
}
```

`plugins/hello/index.mjs`

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
          properties: {
            name: { type: 'string', description: '对方名字' },
          },
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

重载 → 在微信里说「跟张三打个招呼」→ 模型会调它。

---

## 四、接口手册

### setup(ctx)

```ts
function setup(ctx: PluginCtx): { tools: Tool[] } | Promise<{ tools: Tool[] }>
```

| ctx 字段 | 说明 |
|---|---|
| `ctx.id` | 插件 id |
| `ctx.log(msg, level?)` | 写日志（控制台可见）。`level` 可为 `'info'|'warn'|'error'|'debug'` |
| `ctx.ai` | AI 客户端：`chat(messages, opts)`；也可 `ctx.ai.generateImage(prompt, opts)` |
| `ctx.wechat` | 微信驱动：`sendText(talker, text)`、`sendImageFile(talker, path)`、`getReader()`、`getSessions()` |
| `ctx.fs` / `ctx.path` | Node 的 fs / path |
| `ctx.dataDir` | 插件私有目录，已自动创建（可直接读写文件） |
| `ctx.config` | `plugin.json` 里的 `config` 默认值 |

### Tool

```ts
interface Tool {
  name: string;                 // 模型看到的函数名，唯一，建议蛇形
  description: string;          // 决定模型会不会调它，写清楚"什么时候用"
  parameters: JSONSchema;       // 参数定义（OpenAI function calling 格式）
  run(args, runtime): Promise<any>;
}
```

### runtime（每次调用的上下文）

| 字段 | 说明 |
|---|---|
| `runtime.talker` | 当前会话 id（`wxid_xxx` 或 `xxx@chatroom`） |
| `runtime.kind` | `'private'` 或 `'group'` |
| `runtime.conversationId` | 平台侧会话 id |
| `runtime.senderWxid` | 说话的这个人 |
| `runtime.senderName` | 这个人的昵称 |
| `runtime.pluginId` | 自己的插件 id |

> 用它来"跟着当前聊天走"：记忆、文件、按人区分的状态。

### 返回值约定

| 字段 | 作用 |
|---|---|
| 任意对象 | 会 `JSON.stringify` 后喂给模型（截断 8000 字符） |
| `success: false` | 标失败，主流程打 warn 日志 |
| `error` | 错误描述，模型会据此如实告诉用户 |
| `hint` | 给模型的指导语，例如"打不开就说明打不开，别编造" |
| `path` / `imagePath` / `filePath` / `file` / `paths[]` / `images[]` / `files[]` | 图片路径，**自动发到当前聊天**并在成功后清理 |

### 写 description 的技巧

模型的决策全靠这三行：

```js
// ✅ 好：说清"何时用、参数是什么、别做什么"
description: '上网搜索。需要最新信息、实时数据、新闻、天气时调用。一轮最多 2 次。参数：query(关键词)，count(返回条数)'

// ❌ 差：模型不知道什么时候该用
description: '搜索功能'
```

### 参数 schema 参考

```js
parameters: {
  type: 'object',
  properties: {
    city:   { type: 'string', description: '城市名，如"杭州"' },
    days:   { type: 'number', description: '天数 1~7，默认 1' },
    unit:   { type: 'string', enum: ['c', 'f'], description: '摄氏/华氏' },
    tags:   { type: 'array', items: { type: 'string' } },
    notify: { type: 'boolean' },
  },
  required: ['city'],
}
```

### 调 AI（插件里用模型）

```js
const r = await ctx.ai.chat([
  { role: 'system', content: '你是翻译器，只输出译文' },
  { role: 'user', content: args.text },
], { maxTokens: 500, temperature: 0.2 });
return { text: r.content };
```

会用全局默认模型；也可以 `{ providerId: 'deepseek', modelOverride: 'deepseek-chat' }` 指定。

### 发消息（插件里主动说话）

```js
await ctx.wechat.sendText(runtime.talker, '我算完了：42');
await ctx.wechat.sendImageFile(runtime.talker, '/abs/path/a.png');
```

一般不需要——返回文本让主流程发就行。

---

## 五、三个完整实战

### 实战 1：查天气（调外部 API + 超时 + 错误处理）

```js
// plugins/weather/index.mjs
const UA = 'LingShu-Plugin-Weather/1.0';

export function setup(ctx) {
  return {
    tools: [{
      name: 'get_weather',
      description: '查询某城市当前天气。参数：city(城市名)',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: '城市名，如 杭州' } },
        required: ['city'],
      },
      async run(args) {
        const city = String(args.city || '').trim();
        if (!city) return { success: false, error: '缺少城市名' };

        try {
          const resp = await fetch(
            `https://wttr.in/${encodeURIComponent(city)}?format=j1`,
            { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) },
          );
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const j = await resp.json();
          const cur = j.current_condition?.[0] || {};
          const desc = cur.lang_zh?.[0]?.value || cur.weatherDesc?.[0]?.value || '';
          return {
            success: true,
            city,
            tempC: cur.temp_C,
            feelsLikeC: cur.FeelsLikeC,
            humidity: cur.humidity,
            desc,
            hint: '天气是实时数据，回答时说明来源与时间。',
          };
        } catch (e) {
          ctx.log(`weather 失败：${e.message}`);
          return {
            success: false,
            error: `查不到 ${city} 的天气（${e.message}）`,
            hint: '如实告诉用户没查到，不要编温度。',
          };
        }
      },
    }],
  };
}
```

### 实战 2：记一笔并在合适的时候提醒（用插件私有存储）

```js
// plugins/reminder/index.mjs
export function setup(ctx) {
  const file = ctx.path.join(ctx.dataDir, 'items.json');
  const load = () => { try { return JSON.parse(ctx.fs.readFileSync(file, 'utf8')); } catch { return []; } };
  const save = (v) => ctx.fs.writeFileSync(file, JSON.stringify(v, null, 2), 'utf8');

  return {
    tools: [
      {
        name: 'add_reminder',
        description: '记一条待办/提醒。参数：text(内容)，due(时间描述，如"明天下午三点"，可空)',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string' }, due: { type: 'string' } },
          required: ['text'],
        },
        async run(args, runtime) {
          const list = load();
          const item = {
            id: Date.now().toString(36),
            talker: runtime.talker,
            text: args.text,
            due: args.due || '',
            createdAt: Date.now(),
            done: false,
          };
          list.push(item);
          save(list);
          return { success: true, id: item.id, total: list.filter(x => !x.done).length };
        },
      },
      {
        name: 'list_reminders',
        description: '列出当前聊天所有未完成的提醒',
        parameters: { type: 'object', properties: {} },
        async run(args, runtime) {
          const list = load().filter(x => !x.done && x.talker === runtime.talker);
          return { success: true, count: list.length, items: list.map(x => ({ text: x.text, due: x.due })) };
        },
      },
      {
        name: 'done_reminder',
        description: '把某条提醒标记为完成。参数：id 或 text 片段',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string' }, text: { type: 'string' } },
        },
        async run(args, runtime) {
          const list = load();
          const hit = list.find(x => x.talker === runtime.talker && !x.done
            && (x.id === args.id || (args.text && x.text.includes(args.text))));
          if (!hit) return { success: false, error: '没找到这条提醒' };
          hit.done = true;
          save(list);
          return { success: true, done: hit.text };
        },
      },
    ],
  };
}
```

> `ctx.dataDir` 是 `data/plugin-data/reminder/`，重启不丢，也不会被提交到 git。

### 实战 3：把工具产出变成图片发出去

```js
// plugins/qrcode/index.mjs —— 假设用某个在线二维码接口生成 PNG
export function setup(ctx) {
  return {
    tools: [{
      name: 'make_qrcode',
      description: '把一段文字/网址生成二维码图片并发出去。参数：text',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      async run(args) {
        const url = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(args.text)}`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!resp.ok) return { success: false, error: `生成失败 HTTP ${resp.status}` };
        const buf = Buffer.from(await resp.arrayBuffer());

        const dest = ctx.path.join(ctx.dataDir, `qr-${Date.now()}.png`);
        ctx.fs.writeFileSync(dest, buf);

        // 只要返回 path，主流程就会自动发到当前聊天
        return { success: true, path: dest, note: '二维码已生成' };
      },
    }],
  };
}
```

---

## 六、调试

### 1. 在线改代码

控制台「插件」→ 代码 → 编辑 → 保存 → **重载插件**。不用重启服务。

### 2. 单独调一个工具（跳过模型）

```bash
curl -X POST http://127.0.0.1:17890/api/tools/call \
  -H 'Content-Type: application/json' \
  -d '{"pluginId":"weather","toolName":"get_weather","args":{"city":"杭州"},"talker":"filehelper"}'
```

`talker` 会作为 `runtime.talker` 传进去，方便测依赖会话的逻辑。

### 3. 看模型看到什么

```bash
curl -s http://127.0.0.1:17890/api/tools | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{JSON.parse(d).tools.forEach(t=>console.log(t.name,'|',t.description))})"
```

如果 description 写得太含糊，模型就不会调——这是最常见的问题。

### 4. 日志

```bash
curl -s "http://127.0.0.1:17890/api/logs?limit=50" | grep -i 你的插件id
```

`ctx.log()` 输出会带上 `插件id: 内容` 前缀。

### 5. 强制让模型调一次

在微信里直接说：「调用 get_weather 查一下杭州天气」。模型通常会照做，便于验证工具本身好不好使。

---

## 七、打包与分享

### 目录结构要求

```
my-plugin/
├── plugin.json      # 必须有
├── index.mjs        # 必须有
└── (其它文件)        # 可选：README、helper.mjs、数据模板
```

### 让别人能一键用

写清楚三件事：

1. **放哪**：`plugins/<id>/`
2. **要不要 Key**：需要就在 `plugin.json` 的 `config` 里声明，代码里从 `ctx.config` 读
3. **怎么验证**：给一条 `/api/tools/call` 的 curl

示例 README：

```markdown
# lingshu-plugin-weather

## 安装
把 weather/ 目录放到 lingshu/plugins/ 下，然后：
curl -X POST http://127.0.0.1:17890/api/plugins/reload

## 使用
在微信里说：「杭州今天天气怎么样」

## 验证
curl -X POST http://127.0.0.1:17890/api/tools/call -H 'Content-Type: application/json' \
  -d '{"pluginId":"weather","toolName":"get_weather","args":{"city":"杭州"}}'
```

### 让 AI 一次写好

```
帮我写一个灵枢插件（仓库 https://github.com/123456qwerty-666/lingshu），
放在 plugins/<id>/ 下，提供 tool <name>，做 <功能>。
要求：
- plugin.json 带 id/name/version/description/entry/capabilities
- index.mjs 用 export function setup(ctx) 返回 tools
- 所有网络请求 10 秒超时，失败返回 {success:false, error, hint}
- 需要密钥就从 ctx.config 读，不要写死
- 写完告诉我怎么验证
```

---

## 八、常见错误

| 现象 | 原因 | 修 |
|---|---|---|
| 插件列表里没有 | 没 `plugin.json` / 没 `index.mjs` / 没启用 | 检查 + `POST /api/plugins/reload` |
| `缺少 setup()` | 用了 `module.exports` | 改成 `export function setup` |
| `未找到工具` | `name` 不一致 / 该聊天禁用了这个插件 | 看 `/api/tools`，看 `chats[talker].plugins` |
| 模型不调用 | description 太含糊 | 写清"什么时候用" |
| 参数拿不到 | schema 里没声明 | `parameters.properties` 补上 |
| 图片没发出去 | 字段名不对 / 文件不存在 / 扩展名不支持 | 用 `path`，确认存在 |
| 整个服务变慢 | 插件里同步阻塞/无超时 | 加 `AbortSignal.timeout()` |
| 重载后还是旧代码 | 没点重载 / 缓存 | `POST /api/plugins/reload` |

---

## 九、内置插件怎么写的

想抄就抄，这四个都是完整实现：

| 插件 | 文件 | 值得看的地方 |
|---|---|---|
| `image-gen` | `plugins/image-gen/{index,helpers}.mjs` | 绘图接口调用、下载落盘、失败分类提示、返回 `path` 自动发送 |
| `vision` | `plugins/vision/index.mjs` | 通过 `getReader()` 直接拿图片元信息 |
| `memory` | `plugins/memory/index.mjs` | 借用核心记忆系统、用 `runtime` 定作用域（群成员 vs 会话） |
| `web-search` | `plugins/web-search/{index,providers}.mjs` | 三引擎降级、HTML 解析、编码识别、10 分钟缓存、错误文案 |

想加新能力，最省事的路径：**复制一个最接近的，改逻辑**。
