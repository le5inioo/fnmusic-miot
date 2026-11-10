# fnmusic-miot

小米 / 红米智能音箱（小爱音箱）控制层，**原生运行于 fnOS（飞牛音乐）**，不依赖 Docker。

把「飞牛音乐」当成曲库与取流源，让局域网里的小爱音箱能直接点播本地歌曲、收藏、音乐库，并通过语音口令播控。需要在线音源（QQ / 网易 / 酷狗 / 酷我）时，可选安装 `fnmusic-ext` 作为增强层；**不装也完全可用**（仅缺少在线榜单与在线流）。

## 功能特性

- 设备管理、在线状态、播放 / 暂停 / 上下首 / 音量 / 拖动进度条
- 语音口令：点播（`播放晴天`）、控制（`音量调到 30`）、自定义口令词（中文无乱码）
- 本地曲库视图：收藏、各音乐库、全部歌曲；在线榜单（需 `fnmusic-ext`）
- **语音搜索与面板搜索都直接接入飞牛音乐搜索**，无需额外配置搜索源：面板搜索框输入后弹出飞牛全库结果（本地 + `fnmusic-ext` 在线音源），点击即播，播放链路复用 `/api/v1/songs/:id/play?access_token=…` + `/mina/play-url`；后端由 `/compat/library-search?full=1` 提供完整候选（要求同源网关注入的 Bearer 令牌）
- DLNA 投放、封面 / 歌词
- fnOS 桌面「独立 app」入口；**显示比例固定 100%**；顶栏不显示标题文字，改为**定制连接图标（内嵌 PNG）+ 三个状态圆点**：音箱（红/蓝/绿 = 断开/待机/播放中）、控制层（红/绿 = 断开/在线）、曲库（红/绿，带歌曲数 = 未连接/已索引）。三个圆点下移 4px，与图标中间两根短竖条的垂直中心对齐；圆点悬停显示提示，图标无提示，全部去掉 help 问号光标；主题切换并入应用栏「选择设备」之前；无工具条、无缩放/刷新/全屏按钮；`/console` 为兼容跳转
- 桌面布局：圆形「继续播放」(44px) / 歌单选择器 / 搜索栏 (240px) 同排同高（「继续播放」移到歌单框之前），剩余宽度全部给歌单框；搜索栏去掉占位文字但输入文字清晰可见；底部收缩播放器的已播时长在进度条前端、总时长在末端，控制图标垂直居中
- 手机端：工具行三个控件压成一行且**全部 44px 同高**（继续播放圆钮 / 歌单框 / 搜索圆钮，「继续播放」在最前）；点圆形搜索会展开**铺满整行、同为 44px**、完全盖住下层歌单框的输入框，点外部收起；窄屏下把搜索输入字号锁为 16px 并收紧 viewport（仅手机/窄屏），避免 iOS 聚焦输入时自动放大页面；收缩播放条与全屏播放器底部控件各上移 20px 避开屏幕圆角和 homebar，**列表 20px 底部留白、播放条、播放条下方留白统一为 `#f8f8fc`**（暗色主题回落到 `--md-surface`）；全屏主播放键为 60px 正圆并隐藏「左滑看歌词 / 右滑看封面」提示
- 触屏按压反馈（手机 / 窄屏）：去掉 iOS 点击高亮与 M3 `:hover` 残留的灰色圆底，改为**按下时图标变主题色 `--md-primary`**；紫底白图标的主播放键按下时改浅紫底 + 紫色图标；用 `.pt-pressed` 类兜底 iOS 上纯 CSS `:active` 不触发的问题，松开约 110ms 后恢复。桌面端不受影响
- AI 对话「播报结束未确认」的终态残留提示会自动隐藏并清理后端状态；应用图标为定制的渐变音箱图标（`ui/images/miot_256.png`、`miot_64.png` 与 `static/icon.*`）

## 架构

| 目录 | 作用 |
|---|---|
| `miot-service/` | 控制层：Node 宿主（`host/`）、飞牛音乐适配（`adapter/`）、构建产物（`bundle/main.js`）、Vue 面板（`frontend/` → 构建到 `static/`） |
| `nodeconsole/` | 零依赖 Node 网关（替代旧 Python FastAPI 版 `webui/`）；`static/console.html` 仅保留 `/console` 兼容跳转 |
| `runtime/` | systemd 进程守护（`start.mjs`） |
| `packaging/fpk/` | fnOS 应用中心安装包定义（`manifest.in`、`build.sh`、`wizard/`、`cmd/`） |

控制层经本机 `trim_music` unix socket 读写飞牛音乐 API；面板经 8776 网关与 8775 控制层通信，token 由服务端注入，浏览器不持有。

## 上游项目

本项目基于上游开源项目 **[songloft-org/songloft-plugin-miot](https://github.com/songloft-org/songloft-plugin-miot)** 衍生而来，复用了其 miot 控制层的核心思路与协议适配，并针对 fnOS（飞牛音乐）做了原生运行化改造（去 Docker、去 Python 依赖、接入飞牛音乐搜索与取流）。

- 上游仓库：<https://github.com/songloft-org/songloft-plugin-miot>
- 若你希望使用通用（非飞牛音乐定制）的小爱音箱控制方案，请直接参考上游项目。

## 依赖

- **必需**：飞牛音乐（`trim.music`）本体 + Node.js v20+（fnOS 应用商店可装）
- **可选增强**：`fnmusic-ext` —— 提供在线音源、在线榜单、边听边存
- 系统 `ffmpeg`（用于 WMA / APE 等格式的强制转码）

> miot 本身不打包任何 Python 依赖，反代与控制台均为零 npm 依赖的 Node 实现。

## 安装（推荐：fnOS 应用中心）

从 [Releases](https://github.com/le5inioo/fnmusic-miot/releases) 下载 `fnmusic-miot-<version>.fpk`，在 fnOS 应用中心「安装本地应用」即可。安装时会自动检测飞牛音乐与 Node.js；`fnmusic-ext` 为可选，未安装将自动降级为纯本地曲库模式。

## 从源码构建

```bash
# 1. 安装控制层构建依赖（esbuild / @songloft/plugin-sdk / typescript …）
cd miot-service && npm install --no-audit --no-fund

# 2. 一条命令：构建 bundle（src/ → bundle/main.js）+ 前端面板（frontend/ → static/）
npm run build:all
```

`bundle/` 与 `static/` 为构建产物，已被 `.gitignore` 忽略；fpk 打包前需先执行上述构建。

## Songloft 薄壳插件（控制页入口）

本项目额外提供一个 **songloft 薄壳插件**，让控制页出现在 **Songloft** 应用内（宿主以 WebView 渲染 `plugin.json` 声明的 `entryPath` 页面）。

> ⚠️ 适用范围说明：该插件是 **Songloft** 的插件格式（`.jsplugin.zip`），**不是飞牛音乐的插件**，因此它渲染在 **Songloft 的界面内**，并不会出现在飞牛音乐 app 中。若你的目标是"在飞牛音乐 app 内加播放页"，本插件**无法直接满足**——飞牛音乐目前没有可嵌入自定义 UI 页面的插件机制（其"扩展与插件"限于歌词 / 封面 / 解码等功能性扩展，以及 fnmusic-ext 这类独立 fpk 应用）。本插件仅适用于你同时运行 **Songloft** 的场景。

> 设计要点：插件本身**不实现任何音箱控制逻辑**。它只是一个壳——WebView 入口页（`plugin/static/index.html`）以全屏 iframe 加载同机运行的 **fnmusic-miot 原生应用**面板（nodeconsole `:8776` / 控制层 `:8775`）。真正的控制仍由原生应用提供。这样既能复用原生能力，又不必把整套控制栈迁回 QuickJS 宿主。

目录结构：

| 文件 | 作用 |
|---|---|
| `plugin/plugin.json` | 插件清单（`entryPath=fnmusic-miot`、`renderEngine=webview`、`main=main.js`） |
| `plugin/main.js` | 薄壳入口，仅满足宿主生命周期契约（`onInit`/`onHTTPRequest` 等），无后端逻辑 |
| `plugin/static/index.html` | WebView 入口页，全屏 iframe 加载原生面板 `http://127.0.0.1:8776/` |
| `plugin/static/icon.svg` | 插件图标 |

构建插件包（纯 Node，无需联网安装 `@songloft/plugin-builder`）：

```bash
node scripts/build-plugin.mjs
# 产出：plugin/dist/fnmusic-miot.jsplugin.zip（已自动计算 entryHash / zipHash）
```

### 安装（在 Songloft 后台，非飞牛音乐）

1. 确保 fnmusic-miot 原生应用（fpk）已在 fnOS 应用中心安装并运行；
2. 打开 **Songloft 后台**（`http://<NAS>:<Songloft端口>`，默认如 `:58091`）→ `设置` → `扩展`（或 `JS 插件管理`）；
3. 点击 **上传插件**，选择 `plugin/dist/fnmusic-miot.jsplugin.zip`（**不要解压**）；
4. 上传后自动安装，回到 Songloft 首页即可看到「fnmusic-miot」入口，点击进入即控制页。
   - 也可通过插件商店的订阅源安装（需提供 `registry.json`）。

**前置依赖**：fnmusic-miot 原生应用（fpk）必须已在 fnOS 应用中心安装并处于运行状态，否则插件页会显示"未能加载控制面板"的提示。

注意事项：
- WebView 能否加载 `http://127.0.0.1:8776` 取决于 Songloft 客户端（Web / App）的 WebView 策略；若被拦截，备选方案是让 `main.js` 在 `onHTTPRequest` 中做反向代理（页面对齐到同源 `/api/v1/jsplugin/fnmusic-miot/...`，由 `main.js` 转发到 `127.0.0.1:8775`），或把面板直接编译进 `plugin/static/`。
- 插件包与 fpk 安装包**并存**：fpk 是功能本体，插件只是它在 **Songloft 内的入口**。

## 配置

- 语音口令、设备绑定、播放偏好等均在控制台 UI 内配置，持久化于应用数据目录
- 无 `fnmusic-ext` 时：在线榜单与在线流自动隐藏，其余功能不受影响
- 调试端点：`http://<NAS>:8775/compat/status`、`/compat/library-search?q=关键词`

## 开源协议

[MIT](./LICENSE)。
