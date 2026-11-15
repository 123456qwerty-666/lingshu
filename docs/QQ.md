# QQ 接入完整部署指南

> 把 QQ 接进灵枢（LingShu Hub），让 AI 在 QQ 上收发文字、语音、图片、表情。
> 这份文档同时写给**人**和**AI**：人照着一步步做，AI 可以整段读走当执行手册。
>
> 本文所有命令和路径都基于 **Windows**。macOS / Linux 只能跑灵枢本体，接 QQ 需要 Windows。

---

## 目录

- [零、先搞清楚原理](#零先搞清楚原理)
- [一、版本对照表（最重要）](#一版本对照表最重要)
- [二、准备 QQ 安装包](#二准备-qq-安装包)
- [三、安装 QQ](#三安装-qq)
- [四、安装 VC++ 运行库](#四安装-vc-运行库)
- [五、部署 NapCat](#五部署-napcat)
- [六、启动并登录](#六启动并登录)
- [七、配置 OneBot 网络](#七配置-onebot-网络)
- [八、接进灵枢](#八接进灵枢)
- [九、验收清单](#九验收清单)
- [十、常见问题逐条排查](#十常见问题逐条排查)
- [十一、给 AI 的自动部署指令](#十一给-ai-的自动部署指令)

---

## 零、先搞清楚原理

```
┌─────────────┐   注入 Hook   ┌──────────┐   OneBot 11   ┌──────────┐
│  QQ 客户端   │ ◄─────────── │ NapCat   │ ◄───────────► │  灵枢     │
│ (官方安装包) │              │ (注入层)  │   HTTP 3001   │ (AI 中枢) │
└─────────────┘              └──────────┘               └──────────┘
```

三件事必须同时成立：

1. **QQ 版本要对** —— NapCat 靠 hook 注入，QQ 版本一变，内存偏移就变，注入直接失败。
2. **VC++ 运行库要全** —— NapCat 的启动器是 C++ 写的，缺 `MSVCP140.dll` 就闪退。
3. **路径不能有中文** —— NapCat 的 C++ 组件对非 ASCII 路径处理有 bug。

任何一条不满足，现象都是"启动没反应"或"提示文件已损坏"，很容易误判成 QQ 坏了。

---

## 一、版本对照表（最重要）

| 组件 | 必须用这个版本 | 说明 |
|---|---|---|
| QQ | **9.9.31.49738** | NapCat v4.18.42 的构建脚本就是拿这个版本做的 |
| NapCat | **v4.18.42** | 官方仓库已删除，用社区留档 |
| Node.js | ≥ 20 | 灵枢本体要求 |

> **不要用 QQ 9.9.37 或更新版本。** 实测 9.9.37 注入后只有 `Process resumed`，没有
> `preload succeeded`，WebUI 永远起不来。换回 9.9.31 立刻正常。

---

## 二、准备 QQ 安装包

### 2.1 官方直链（腾讯 CDN）

腾讯的安装包地址有规律，但**老版本会 404**。9.9.31 的官方链接目前已经失效，
只能用下面的存档。

### 2.2 存档下载（推荐）

社区有人专门存档 QQ 安装包，文件来自腾讯官方、带 SHA256 校验：

```
https://github.com/Rodert/qq-versions/releases/download/qq-packages-20260528-3e8913a2/QQ_9.9.31_260528_x64_01.exe
```

同目录下还有 `SHA256SUMS.txt`，务必下载并核对。

### 2.3 校验（必做）

```powershell
# 校验值必须完全一致
Get-FileHash .\QQ_9.9.31_260528_x64_01.exe -Algorithm SHA256

# 期望值
# 0beb5cb4ff776cba822caa0abadbd53f5892f12628a86dabea1b372c82c086bc
```

文件大小应为 **310,074,032 字节**（约 296 MB）。对不上就重下，别装。

### 2.4 其他可用版本（备选）

| 版本 | 来源 | 备注 |
|---|---|---|
| 9.9.30.48762 | 腾讯 CDN `QQNT/9.9.30/guanwang/6a035910/` | 可能仍可用 |
| 9.9.33.52230 | 腾讯 CDN `QQNT/9.9.33/release/497e2f1f/` | **太新，注入会失败** |
| 9.9.36 / 9.9.37 | 官网当前版本 | **太新，注入会失败** |

---

## 三、安装 QQ

1. 双击安装包，**装到默认路径**：

   ```
   C:\Program Files\Tencent\QQNT
   ```

   换路径也能用，但下文所有脚本要跟着改。

2. 装完**先不要打开 QQ**。

3. 确认版本：

   ```powershell
   (Get-Item 'C:\Program Files\Tencent\QQNT\QQ.exe').VersionInfo.ProductVersion
   # 期望输出：9.9.31.49738-xxxxxxxx
   ```

### 3.1 禁止自动更新（关键）

QQ 一启动就会尝试升到最新版，升上去注入就废了。装完立刻锁版本：

编辑 `C:\Program Files\Tencent\QQNT\versions\config.json`，把新版本加进 `onErrorVersions`：

```json
{
  "baseVersion": "9.9.31-49738",
  "curVersion": "9.9.31-49738",
  "onErrorVersions": ["9.9.37-54395"]
}
```

> 注意：QQ 有时会把这个文件改回去。如果发现版本被升级了，重新执行一次，
> 或者把 QQ 目录的更新组件改名（`QQNT\versions\` 下的 `.zip` 缓存删掉）。

---

## 四、安装 VC++ 运行库

NapCat 的启动器依赖 VC++ 2015-2022 运行库。缺了就报：

```
无法启动此程序，因为计算机中丢失 MSVCP140.dll
```

### 方案 A：装官方运行库（推荐）

下载安装 [Microsoft Visual C++ Redistributable x64](https://aka.ms/vs/17/release/vc_redist.x64.exe)，
**必须装 x64 版**。装完重启。

### 方案 B：借用 QQ 自带的（免安装，最快）

QQ 安装目录里已经带了这几个 DLL，直接复制到 NapCat 目录即可：

```powershell
$qq = 'C:\Program Files\Tencent\QQNT'
$napcat = 'C:\NapCat'
Copy-Item "$qq\msvcp140.dll"      $napcat
Copy-Item "$qq\vcruntime140.dll"  $napcat
Copy-Item "$qq\vcruntime140_1.dll" $napcat
```

> 这三个文件是 x64 的，和 QQ 同架构，直接可用。

---

## 五、部署 NapCat

### 5.1 下载

官方仓库（`NapNeko/NapCatQQ`）的 Release 已被删除，用社区留档：

```
https://github.com/XingYunStar/NapCatQQ
```

下载 **NapCat.Shell.zip**，解压后应该看到：

```
NapCatWinBootMain.exe      ← 启动器
NapCatWinBootHook.dll      ← 注入用的 Hook
napcat.mjs                 ← NapCat 主体
loadNapCat.js              ← 加载器
qqnt.json                  ← 补丁包（版本标识）
package.json
node_modules/
```

### 5.2 放到纯英文路径（关键）

**不要放在含中文的目录**。NapCat 的 C++ 组件解析中文路径会截断，表现为：

```
argv[0]:C:\Users\xxx\Desktop\        ← 路径被截断在这里
```

正确做法：

```powershell
New-Item -ItemType Directory -Force C:\NapCat
Copy-Item .\NapCat.Shell\* C:\NapCat -Recurse -Force
```

最终结构：

```
C:\NapCat\
  NapCatWinBootMain.exe
  NapCatWinBootHook.dll
  napcat.mjs
  loadNapCat.js
  qqnt.json
  msvcp140.dll
  vcruntime140.dll
  vcruntime140_1.dll
```

### 5.3 对齐 qqnt.json 的版本标识

打开 `C:\NapCat\qqnt.json`，确认这几个字段和实际装的 QQ 一致：

```json
{
  "name": "qq-chat",
  "version": "9.9.31-49738",
  "buildVersion": "49738",
  "main": "./loadNapCat.js",
  "isPureShell": true,
  "platform": "win32",
  "eleArch": "x64"
}
```

`version` / `buildVersion` 必须和 `C:\Program Files\Tencent\QQNT\versions\config.json`
里的 `curVersion` 一致，否则注入会失败。

---

## 六、启动并登录

### 6.1 创建启动脚本

在 `C:\NapCat\` 新建 `start.bat`（**内容必须纯 ASCII**，中文路径会让 cmd 解析出错）：

```bat
@echo off
chcp 65001 >nul
cd /d "C:\NapCat"
set "QQEXE=C:\Program Files\Tencent\QQNT\QQ.exe"
set "NAPCAT_PATCH_PACKAGE=%cd%\qqnt.json"
set "NAPCAT_LOAD_PATH=%cd%\loadNapCat.js"
set "NAPCAT_INJECT_PATH=%cd%\NapCatWinBootHook.dll"
set "NAPCAT_MAIN_PATH=%cd%\napcat.mjs"
"%cd%\NapCatWinBootMain.exe" "%QQEXE%" "%NAPCAT_INJECT_PATH%"
pause
```

> `chcp 65001` 是为了让中文日志正常显示，否则控制台全是乱码。

### 6.2 启动

双击 `start.bat`。成功的标志：

```
[NapCat Backend] Main Process ID:12345
Creating pipe: \\.\pipe\NapCat_12345
[NapCat Backend] Process resumed
[preload] succeeded. ...\major.node
[preload] register done. major.node
[NapCat] [Core] NapCat.Core Version: 4.18.42
[NapCat] [WebUi] WebUi Token: xxxxxxxxxxxx
[NapCat] [WebUi] WebUi User Panel Url: http://127.0.0.1:6099/webui?token=xxxxxxxx
```

看到 `NapCat.Core Version` 和 `WebUi Token` 就说明**注入成功**。

### 6.3 登录

两种方式：

**二维码**：控制台会打印一个 ASCII 二维码（乱码也别管，能扫），同时把图片存到：

```
C:\NapCat\cache\qrcode.png
```

打开这个文件用手机 QQ 扫，2 分钟内有效，过期会自动刷新。

**快速登录**（推荐，免扫码）：

```bat
"%cd%\NapCatWinBootMain.exe" "%QQEXE%" "%NAPCAT_INJECT_PATH%" -q 你的QQ号
```

前提是这个号之前在本机登录过。

### 6.4 防止每次都要扫码

编辑 `C:\NapCat\config\webui.json`：

```json
{
  "autoLoginAccount": "你的QQ号"
}
```

配合启动参数 `-q`，之后就是全自动登录。

---

## 七、配置 OneBot 网络

登录成功后，NapCat 会生成：

```
C:\NapCat\config\onebot11_<QQ号>.json
```

手工改（或者用灵枢的 `setup-onebot.mjs` 自动改）：

```json
{
  "network": {
    "httpServers": [
      {
        "name": "lingshu-http",
        "enable": true,
        "host": "127.0.0.1",
        "port": 3001,
        "enableCors": true,
        "enableWebsocket": false,
        "messagePostFormat": "array",
        "token": "",
        "debug": false
      }
    ],
    "httpClients": [
      {
        "name": "lingshu-event",
        "enable": true,
        "url": "http://127.0.0.1:17890/api/qq/event",
        "messagePostFormat": "array",
        "reportSelfMessage": false,
        "token": "",
        "debug": false,
        "timeout": 10000
      }
    ],
    "httpSseServers": [],
    "websocketServers": [],
    "websocketClients": [],
    "plugins": []
  },
  "musicSignUrl": "",
  "enableLocalFile2Url": false,
  "parseMultMsg": false,
  "imageDownloadProxy": ""
}
```

**改完必须重启 NapCat**，配置才会生效。

各字段含义：

| 字段 | 作用 |
|---|---|
| `httpServers` | 灵枢 → NapCat 发消息（灵枢调 3001） |
| `httpClients` | NapCat → 灵枢 推事件（有人发消息时 POST） |
| `messagePostFormat: array` | 用数组格式传消息段，灵枢按这个解析 |
| `reportSelfMessage: false` | 不推送自己发的消息，避免死循环 |

---

## 八、接进灵枢

1. 启动灵枢：

   ```bash
   cd lingshu
   node server/index.mjs
   ```

2. 浏览器打开 `http://127.0.0.1:17890`

3. 切到 **🐧 QQ 专区**，右侧「QQ 通道设置」：

   - 勾选「启用 QQ 通道」
   - 地址填 `http://127.0.0.1:3001`
   - 保存

4. 点「刷新状态」，显示 `✅ 已连接：昵称 (QQ号)` 就成功了。

### 8.1 每个聊天独立设置

在 QQ 专区左侧选一个会话 → 点「该聊天设置」，可以单独配：

- 对话模型 / 识图模型（每个聊天可以不一样）
- 语音引擎、音色、情绪
- 人设、说话风格
- 记忆开关
- 插件（联网搜索、绘图、看图等）

### 8.2 会话同步（聊天池）

顶部「🔗 同步会话」可以把两个会话绑成一个聊天池，共享全部设置、记忆、历史：

- 可以两个都是微信、两个都是 QQ、或一微信一 QQ
- 同步方向：A→B（覆盖，会清空目标）、B→A、双向合并
- 绑定后实时同步：任一端聊天、改设置，另一端立刻跟着变

---

## 九、验收清单

按顺序确认，任何一步失败就先解决那一步：

```powershell
# 1. QQ 版本对不对
(Get-Item 'C:\Program Files\Tencent\QQNT\QQ.exe').VersionInfo.ProductVersion
# → 9.9.31.49738-xxxx

# 2. 运行库在不在
Test-Path C:\NapCat\msvcp140.dll
# → True

# 3. NapCat 在跑吗
Get-Process NapCatWinBootMain -ErrorAction SilentlyContinue
# → 有进程

# 4. WebUI 通不通
(Invoke-WebRequest http://127.0.0.1:6099/webui -UseBasicParsing -MaximumRedirection 0).StatusCode
# → 301 或 200

# 5. OneBot 接口通不通
Invoke-RestMethod -Uri http://127.0.0.1:3001/get_login_info -Method Post -ContentType 'application/json' -Body '{}'
# → user_id / nickname 是你的号

# 6. 灵枢通不通
Invoke-RestMethod http://127.0.0.1:17890/api/qq/status
# → online: true
```

再发一条 QQ 消息给这个号，日志里应该出现：

```
收到 [qq] private/xxx: 你好
已回复 qq:private:xxx（1 条）
```

---

## 十、常见问题逐条排查

### 10.1 双击启动器闪退，提示 `MSVCP140.dll 缺失`

见 [第四章](#四安装-vc-运行库)。注意必须是 **x64** 版，x86 的不行。

### 10.2 提示「QQ 文件已损坏，请重新安装」

**不要急着重装。** 通常是这两个原因：

1. 反复强杀 QQ 进程，把 `versions/config.json` 的自检状态写乱了
2. 用不匹配的版本注入过

先试：把 `C:\Program Files\Tencent\QQNT\versions\config.json` 里
`unzipRetryCount` 归零、`readyVersion` 清空。不行再重装 QQ。

### 10.3 日志只有 `Process resumed`，没有 `preload succeeded`

**版本不匹配。** QQ 太新（比如 9.9.37），NapCat 的 hook 偏移对不上。
换回 9.9.31.49738。

### 10.4 日志出现 `NapCat.Core Version` 但没有 WebUI

可能是 Worker 崩了。看日志里有没有：

```
[NapCat] [Fork] Worker进程意外退出 (1/3)
```

常见原因：还没扫码登录。先扫码，登录后 WebUI 才会完全起来。

### 10.5 WebUI 6099 打不开

1. 确认 NapCat 进程还在
2. 确认 `config/webui.json` 里 `host` 不是 `::`（改成 `127.0.0.1`）
3. 端口被占用：`netstat -ano | findstr :6099`

### 10.6 AI 说「听不见语音」

**先看日志有没有 `QQ 语音转文字：xxx`。**

- 有：说明识别成功，是 AI 的认知问题（历史里残留了错误说法），清一下历史
- 没有：看下一条

语音链路：下载 amr → ffmpeg 转 wav → ASR 识别。常见失败：

```
QQ 语音识别失败: 找不到 ffmpeg
```

在 `config.json` 里配 `ffmpegPath`，或者把 ffmpeg 放进 PATH。

### 10.7 AI 说「看不到图片」

看日志有没有 `QQ 图片已识别：xxx`。

没有的话检查识图模型是否配置：控制台 → AI 配置 → 识图模型。

图片链路：下载 → base64 → 识图模型描述 → 拼进消息。

### 10.8 AI 调工具报「未找到工具」

NapCat 的扩展动作（换头像、点赞等）走 `qq_action` 工具。
如果报这个错，说明工具没注册进分发器 —— 这是代码问题，不是配置问题。

### 10.9 主动消息乱发

三个参数要一起看：

| 参数 | 含义 | 推荐值 |
|---|---|---|
| `idleMinutes` | 对方多久没说话才发 | 120 |
| `intervalMin/Max` | 两次之间的随机间隔 | 40~120 |
| `maxPerDay` | 每天上限 | 3 |

如果几分钟就发一条，检查 `intervalMin` 是不是被设成 0 或 1。

### 10.10 二维码扫了没反应 / 一直过期

二维码 2 分钟过期。两种解法：

1. 打开 `C:\NapCat\cache\qrcode.png` 直接扫（比控制台那个 ASCII 版清晰）
2. 用快速登录：`NapCatWinBootMain.exe ... -q 你的QQ号`

---

## 十一、给 AI 的自动部署指令

把下面这段**整段**发给 AI（Claude / GPT / 灵枢自己都行），它就能照着自己装：

````text
你需要在 Windows 上部署 NapCat 把 QQ 接进灵枢。严格按以下步骤执行，
每步都要验证，失败就停下来报告，不要跳步。

【硬性约束】
1. QQ 必须用 9.9.31.49738，不能用更新版本（9.9.37 注入必失败）
2. NapCat 必须放纯英文路径，建议 C:\NapCat，不能有中文
3. 必须有 msvcp140.dll / vcruntime140.dll / vcruntime140_1.dll（x64）
4. OneBot 改完配置必须重启 NapCat 才生效

【步骤】

1. 检查现有 QQ 版本
   (Get-Item 'C:\Program Files\Tencent\QQNT\QQ.exe').VersionInfo.ProductVersion
   如果 >= 9.9.32，告知用户必须降级到 9.9.31，并提供安装包：
   https://github.com/Rodert/qq-versions/releases/download/qq-packages-20260528-3e8913a2/QQ_9.9.31_260528_x64_01.exe
   SHA256 必须是 0beb5cb4ff776cba822caa0abadbd53f5892f12628a86dabea1b372c82c086bc

2. 装完 QQ 后禁止自动更新
   编辑 C:\Program Files\Tencent\QQNT\versions\config.json，
   把 onErrorVersions 设为 ["9.9.37-54395"]

3. 准备 C:\NapCat
   - 从 https://github.com/XingYunStar/NapCatQQ 下载 NapCat.Shell.zip 并解压到 C:\NapCat
   - 从 C:\Program Files\Tencent\QQNT 复制三个 DLL 到 C:\NapCat：
     msvcp140.dll / vcruntime140.dll / vcruntime140_1.dll

4. 对齐版本标识
   把 C:\NapCat\qqnt.json 的 version 改成 "9.9.31-49738"、buildVersion 改成 "49738"

5. 创建 C:\NapCat\start.bat（内容必须全 ASCII）
   @echo off
   chcp 65001 >nul
   cd /d "C:\NapCat"
   set "QQEXE=C:\Program Files\Tencent\QQNT\QQ.exe"
   set "NAPCAT_PATCH_PACKAGE=%cd%\qqnt.json"
   set "NAPCAT_LOAD_PATH=%cd%\loadNapCat.js"
   set "NAPCAT_INJECT_PATH=%cd%\NapCatWinBootHook.dll"
   set "NAPCAT_MAIN_PATH=%cd%\napcat.mjs"
   "%cd%\NapCatWinBootMain.exe" "%QQEXE%" "%NAPCAT_INJECT_PATH%"
   pause

6. 让用户双击 start.bat 并扫码登录（这步必须用户手动，AI 做不了）
   成功标志：控制台出现 "NapCat.Core Version: 4.18.42" 和 "WebUi Token"

7. 配置 OneBot（登录后才会生成 onebot11_<QQ号>.json）
   httpServers: 127.0.0.1:3001
   httpClients: http://127.0.0.1:17890/api/qq/event
   messagePostFormat: array
   reportSelfMessage: false
   改完重启 NapCat

8. 验收
   Invoke-RestMethod -Uri http://127.0.0.1:3001/get_login_info -Method Post -ContentType 'application/json' -Body '{}'
   能返回 user_id 就算成功

【失败时的排查顺序】
- 闪退 + MSVCP140.dll → 装 VC++ 运行库或复制 DLL
- 只有 Process resumed → QQ 版本太新
- 没有 WebUI → 没扫码登录
- 3001 连不上 → OneBot 配置没生效，没重启
````

---

## 附：文件清单

部署完成后 `C:\NapCat\` 应该是这样：

```
NapCatWinBootMain.exe          启动器
NapCatWinBootHook.dll          Hook（注入用）
napcat.mjs                     NapCat 主体
loadNapCat.js                  加载器
qqnt.json                      版本标识（必须和 QQ 版本一致）
msvcp140.dll                   VC++ 运行库
vcruntime140.dll
vcruntime140_1.dll
start.bat                      启动脚本（纯 ASCII）
config/
  onebot11_<QQ号>.json         OneBot 网络配置
  webui.json                   WebUI 配置（含 autoLoginAccount）
  napcat.json                  日志级别等
cache/
  qrcode.png                   登录二维码（自动刷新）
```

---

## 相关文档

- [接入微信](./WECHAT.md)
- [AI 自动部署](./DEPLOY-AI.md)
- [故障排查总表](./TROUBLESHOOTING.md)
- [API 参考](./API.md)
