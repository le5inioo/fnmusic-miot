# fnmusic-miot

小米 / 红米智能音箱（小爱音箱）控制层，**原生运行于 fnOS（飞牛音乐）**，不依赖 Docker。

把「飞牛音乐」当成曲库与取流源，让局域网里的小爱音箱能直接点播本地歌曲、收藏、音乐库，并通过语音口令播控。需要在线音源（QQ / 网易 / 酷狗 / 酷我）时，可选安装 `fnmusic-ext` 作为增强层；**不装也完全可用**（仅缺少在线榜单与在线流）。

## 功能特性

- 设备管理、在线状态、播放 / 暂停 / 上下首 / 音量 / 拖动进度条
- 语音口令：点播（`播放晴天`）、控制（`音量调到 30`）、自定义口令词（中文无乱码）
- 本地曲库视图：收藏、各音乐库、全部歌曲；在线榜单（需 `fnmusic-ext`）
- **语音搜索直接接入飞牛音乐搜索**，无需额外配置搜索源
- DLNA 投放、封面 / 歌词
- fnOS 桌面「独立 app」入口，控制台工具条可收起（飞牛窗口本身已带边框）

## 架构

| 目录 | 作用 |
|---|---|
| `miot-service/` | 控制层：Node 宿主（`host/`）、飞牛音乐适配（`adapter/`）、构建产物（`bundle/main.js`）、Vue 面板（`frontend/` → 构建到 `static/`） |
| `nodeconsole/` | 零依赖 Node 网关 + 控制台（替代旧 Python FastAPI 版 `webui/`） |
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

## 配置

- 语音口令、设备绑定、播放偏好等均在控制台 UI 内配置，持久化于应用数据目录
- 无 `fnmusic-ext` 时：在线榜单与在线流自动隐藏，其余功能不受影响
- 调试端点：`http://<NAS>:8775/compat/status`、`/compat/library-search?q=关键词`

## 开源协议

[MIT](./LICENSE)。
