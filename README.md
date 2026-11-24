# fnmusic-miot

小米 / 红米智能音箱（小爱音箱）控制层，原生运行于 fnOS（飞牛音乐），不依赖 Docker。

以飞牛音乐为曲库与取流源，让局域网内的小爱音箱直接点播本地歌曲、收藏、音乐库，并通过语音口令播控。需要在线音源（QQ / 网易 / 酷狗 / 酷我）时可选装 `fnmusic-ext`；不装也完全可用，仅缺在线榜单与在线流。

## 功能特性

- 设备管理、播放 / 暂停 / 上下首 / 音量 / 进度拖动
- 语音口令：点播（`播放晴天`）、控制（`音量调到 30`）、自定义口令词（中文无乱码）
- 本地曲库：收藏、音乐库、全部歌曲；在线榜单（需 `fnmusic-ext`）
- 语音与面板搜索均直接接入飞牛音乐全库搜索，点击即播
- DLNA 投放、封面 / 歌词
- fnOS 桌面独立 app 入口
- AI 对话：自定义模型与角色、联网搜索开关、触发词约束；日期 / 天气问答带时间与城市锚点；长回答分段播报
- 飞牛音乐网关地址自动发现，端口可自定义（默认 8775 / 8776），网络瞬时失败自动重试

## 架构

| 目录 | 作用 |
|---|---|
| `miot-service/` | 控制层：Node 宿主（`host/`）、飞牛音乐适配（`adapter/`）、构建产物（`bundle/main.js`）、Vue 面板（`frontend/` → 构建到 `static/`） |
| `nodeconsole/` | 零依赖 Node 网关（替代旧 Python FastAPI 版 `webui/`）；`static/console.html` 仅保留 `/console` 兼容跳转 |
| `runtime/` | systemd 进程守护（`start.mjs`） |
| `packaging/fpk/` | fnOS 应用中心安装包定义（`manifest.in`、`build.sh`、`wizard/`、`cmd/`） |

控制层经本机 `trim_music` unix socket 读写飞牛音乐 API；面板经 8776 网关与 8775 控制层通信，token 由服务端注入，浏览器不持有。

## 上游项目

基于开源项目 [songloft-org/songloft-plugin-miot](https://github.com/songloft-org/songloft-plugin-miot) 衍生，复用其 miot 控制层核心思路与协议适配，针对 fnOS（飞牛音乐）做了原生运行化改造（去 Docker、去 Python 依赖、接入飞牛音乐搜索与取流）。需要通用（非飞牛音乐定制）的小爱音箱控制方案，请直接参考上游项目。

> 本项目不使用 Songloft 宿主，也不使用 `.jsplugin.zip` 插件格式；交付物只有 fnOS 独立应用（`.fpk`）。

## 依赖

- **必需**：飞牛音乐（`trim.music`）+ Node.js v20+
- **可选**：`fnmusic-ext`（在线音源、在线榜单、边听边存）
- 系统 `ffmpeg`（WMA / APE 等格式转码）

## 安装

从 [Releases](https://github.com/le5inioo/fnmusic-miot/releases) 下载 `fnmusic-miot-<version>.fpk`，在 fnOS 应用中心「安装本地应用」即可。安装时自动检测飞牛音乐与 Node.js；未装 `fnmusic-ext` 自动降级为纯本地曲库。

## 从源码构建

```bash
cd miot-service && npm install --no-audit --no-fund
npm run build:all
```

`bundle/` 与 `static/` 为构建产物，已被 `.gitignore` 忽略；打包前须先构建。

## 配置

- 语音口令、设备绑定、播放偏好、AI 模型与角色均在面板「设置」内配置，持久化于应用数据目录
- 端口默认 8775（控制层）/ 8776（控制台），在「设置 → 设备 → 服务端口」中可改，升级不会覆盖
- 调试端点：`http://<NAS>:<MIOT_PORT>/compat/status`、`/compat/library-search?q=关键词`
- 排障：面板「设置 → 工具箱 → 导出日志」

## 开源协议

[MIT](./LICENSE)。
