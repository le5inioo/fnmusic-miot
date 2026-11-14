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
- AI 对话「播报结束未确认」的终态残留提示会自动隐藏并清理后端状态；应用图标为定制的紫粉渐变音箱图标（2.3.0 起，64/128/256 三档采用用户原生尺寸源图**零重采样**直用，其余尺寸档从 256 原图一次缩小；`ui/images/miot_*.png`、`ICON*.PNG` 与 `static/icon.*` 同源）
- 后端访问飞牛音乐网关优先走本机回环地址 `127.0.0.1`（2.3.0 起，新装由安装脚本直写，老 .env 遗留的 LAN IP 在启动时探测回环可用后自动迁移），并对网络层瞬时失败（如服务重启窗口的 `fetch failed` / `Errno 101`）自动退避重试；面板歌单/歌曲列表加载失败时前端再静默重试一次，双重兜底消除「歌曲加载失败」偶发提示

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

> **本项目不使用 Songloft 宿主，也不使用 `.jsplugin.zip` 插件格式**：交付物只有 fnOS 独立应用（`.fpk`）。上游的插件机制仅作为控制逻辑的来源参考；飞牛音乐本身没有可嵌入自定义 UI 页面的插件扩展点。早期实验性的「Songloft 薄壳插件」已废弃并移除，请勿在任何 Release 中安装它。

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
- 调试端点：`http://<NAS>:<MIOT_PORT>/compat/status`、`/compat/library-search?q=关键词`
- **端口可自定义**：控制层默认 `8775`、控制台 TCP 网关默认 `8776`。**从 2.3.4 起，自定义端口无需再手改 `.env`**——在「设置 → 设备 → 服务端口」中即可手动填两个端口、或点「自动填充」一次选好两个可用随机端口、应用后自动重启服务（`/ports/apply` 会先备份 `.env` 到 `.env.before-port-apply` 再写入并延迟重启，避免当前请求被 `systemctl restart` 杀死）。若两个默认端口恰好被其他程序占用，安装时会自动避开并挑选空闲端口，仍会在首次引导里让用户确认。升级不会覆盖自定义值，音箱回访地址、网关反代端口、探活检查都会自动跟随。直接改 `.env`（`MIOT_PORT` / `FNMUSIC_MIOT_CONSOLE_PORT`，1024~65535、两者不同）后重启应用也完全有效。桌面入口走 unix socket，不受 TCP 端口影响（详见「更新记录 2.3.3 / 2.3.4」）。
- **首次安装 / 老版本升级引导**：从 2.3.4 起，全新安装或从 2.3.4 之前的版本升级后，面板首次打开会直接跳到「设置 → 设备」（顶部即「服务端口」区块），提示用户确认或自定义两个端口（安装/升级脚本写入 `port_setup_state.json` 的 `pending` 标记，前端 `initialize()` 读取 `/ports/config` 后跳转）；在引导卡上点「保持默认并跳过引导」即清除标记，引导卡随之收起、不再常驻。该引导对功能无强制要求——跳过或保持默认都不影响使用。
- **飞牛网关端口自动发现（2.3.4 起，不依赖任何端口白名单）**：不同 NAS 的飞牛 HTTP 网关端口可能各不相同（`6688` / `5666` / `51666` / 任意自定义值）。2.3.4 会自动从系统网关配置与本机监听端口中找出真实网关，无需手填；网关只绑定 LAN IP、不监听回环时也会自动切换。只有「当前基址探测失败」才触发发现，配置正确的实例零扫描、零行为变化。排查请看「设置 → 工具箱 → 导出诊断日志」新增的「环境 / 网关发现」脱敏段。特殊场景（强制 HTTPS 自签、域名反向代理）可在 `.env` 手填 `FNMUSIC_BASE_URL`，手填的自定义地址不会被覆盖。

## 更新记录

### 2.3.5（2026-11-14 本地构建 + 部署 NAS，**尚未发布 GitHub**）

> **累积版本**：本版把「2.3.4 后续修复」（OH1P 兼容、扫码账号落盘）与下面新的
> 「强制 HTTPS 通用兼容」一起承接，正式发布时不再出现同号不同内容。

- **修复「飞牛 NAS 开启强制 HTTPS 连接后 miot 加载不了曲库」**（用户反馈）：
  - **根因**：fnOS ≥ 0.8.22 默认 HTTP 5666 / HTTPS 5667，开启「强制 HTTPS 连接」后把 HTTP 请求 301 到独立的 HTTPS 端口，而该端口默认使用自签证书。控制层原先全链路假设 `http://`：`apiCall` / `login` / `openStream` / 封面请求用 `redirect:'manual'`，拿到 301 后按 JSON 解析直接失败；`normalizeBaseUrl` / 网关发现用 `redirect:'follow'`，跟到 HTTPS 后 Node fetch 抛 `DEPTH_ZERO_SELF_SIGNED_CERT`，**2.3.4 的通用网关发现也救不了（它只解决端口，没解决协议）**。即使用户上传了正式证书，用 `127.0.0.1` 访问仍会 CN/SAN 不匹配。
  - **修复（不写死任何端口 / 域名）**：新增 `host/gateway-fetch.mjs` 作为网关专用请求层 ——
    - 仅当目标是**内网网关的 HTTPS**时用 `node:https` 并定向放宽证书校验；HTTP 与公网 HTTPS 一律走原生 fetch 严格校验，**不设置 `NODE_TLS_REJECT_UNAUTHORIZED=0`**（同一进程还要连小米云）。
    - 自动吸收「网关自身」的 301（协议/端口升级），保留全部 headers 重发，把最终 origin 回调固化为 `urlBase` 并写回 `.env`；跳转目标不是 `/music/api/v1` 时不自动跟随，在线音源的 CDN 302 仍由 `openStream` 自己处理。
    - `host/gateway.mjs` 的 `confPorts()` 结构化返回 `http` / `https` 端口与 `force_https` 标志，`probeBase()` 双协议探测、优先试 conf 里的 HTTPS 端口。
    - `scripts/fnmusic_token.py` 同步支持：内网网关直连（忽略环境 `HTTP_PROXY`，否则回环请求会被发到代理而超时）、重定向后的自签 HTTPS 放宽校验。
    - 安装脚本升级时保留已固化的 `https://` 基址，不覆盖回 `http`。
  - **诊断导出**新增「证书策略 / 强制 HTTPS 标志 / HTTPS 端口」，一眼可判定当前走的是 `http (no TLS)`、`https-local (self-signed allowed)` 还是 `https-remote (strict verification)`。
  - **用户侧无需操作**：升级后首次请求自动跟随 301、切换并持久化正确基址；音箱回访地址是 miot 自己的控制层端口，不受飞牛强制 HTTPS 影响。
- **顺手修复**：fnOS 覆盖安装实际是 uninstall → install（走 `install_callback`），之前每次普通升级都会误写「首次端口设置引导」。`install_callback` 现在按 `MIOT_DATA_ROOT/VERSION` 区分真·首次安装与老版本升级，2.3.4 → 2.3.5 不再重复弹引导。
- **验收**：`_miot_check/test_force_https.mjs` 本地 10 项 ALL PASS（普通 HTTP 零影响 / 301 吸收 / 自签证书 / CDN 302 不误跟随 / 内网判定 / 301 目标保持内网 host / conf 解析 / 网关发现命中 https / `createFnMusicClient` 固化基址 / python token 链路）；该自检在 NAS 上以已安装的 repo 模块复跑同样 ALL PASS。`verify_235.sh` 全绿：`VERSION=2.3.5`、token 不变、8774/8775/8776 全 200、351 首 /16 歌单 `loaded=16 failed=0`、现网零扫描、诊断 `证书策略: http (no TLS)`。
- 产物：`fnmusic-miot-2.3.5.fpk` 963,336 B / `481938d1…5f8fcbb42`，源码包 954,399 B / `b706b165…8d8a9951`；本地 = NAS = `.sha256` 三处一致，备份 `pre-2.3.5-20261114-222203`。
- **发布状态**：按用户规则，本轮**未** commit / push / tag / 建 Release；GitHub latest 仍是 `v2.3.4`，需单独授权后再发布。

### 2.3.4 后续修复（2026-11-14 本地构建，**已由 2.3.5 承接**）

> **版本说明**：本段为历史记录 —— 改动发生在 v2.3.4 正式发布之后，当时产物仍标 `2.3.4`、
> GitHub Release v2.3.4 不含下列修复；现已统一由 **2.3.5** 承接并重新打包。

- **新型号音箱（含 OH1P / Xiaomi Sound 2 Pro）的播放兼容，做成通用能力**：
  - 起因：用户设备 `OH1P`（`xiaomi.wifispeaker.oh1p`，米家 ID 26845，2026-01 新品）。控制层的 TTS 命令表认识它，但它不在 `DEFAULT_MUSIC_API_MODELS` 里，默认走 `player_play_url` 直链；同代 Pro 系列（OH2 / OH2P）必须走 `player_play_music` 才能正常发声，否则「日志显示 Playing 但音箱无声」。
  - 默认表补入 `OH1P`、`OH1M`、`OH8`、`OH27`（OH 系列同代、TTS command 同为 `7-3`），共 24 个型号。
  - **通用解**：新增 `music_api_model_enabled` 用户配置，`needUsePlayMusicAPI()` 优先级改为「显式禁用 > 显式启用 > 内置默认 > 直链」，型号统一大写/去空格比较。面板「设置 → 设备 → 高级设备兼容」的型号勾选框**不再禁用**，任意已识别型号（包括以后发布的新型号）都能手动切换，无需等插件发版；徽标区分「默认 / 手动开启 / 手动关闭」。两个清单在后端做互斥归一化。
  - 播放链路 `playByUrl()` 的参数改为 `MusicApiModelPrefs { disabled, enabled }`（兼容旧的 `string[]` 传参），debug 日志同时打印两个清单。
- **修复扫码登录后账号配置丢失 / 账号 ID 错配**（来自 `fnmusic-miot-diag-20261114-155421.log`）：
  - 现象：登录成功但 `refreshToken: account config not found`、`No client for account, returning cached devices: 15623065800`、`getPlayerStatus: no client for account: 6306495`，设备列表只能回退缓存、状态查不到。
  - 根因：账号表用「共享可变数组 → 读改写 → 整表写回」，扫码登录、设备刷新、token 刷新并发时后写覆盖先写（lost update）；且 `updateAccount()` 在账号不存在时直接抛错，而 `ensureAccountExists()` 把所有异常静默吞掉；扫码流程又是「先删旧临时账号 → 再建新 userId 账号」，中途失败就留下「旧已删、新未建」的空洞。
  - 修复：`ConfigManager` 新增 `withAccounts()` 串行写队列，所有账号写入从最新缓存取副本、改完立即写回；`addAccount()` 幂等、`updateAccount()` 改为 **upsert**（账号不存在自动补建，不再丢 token）；`pollQRCode()` 调整顺序为「先完整落盘新账号 → 注册 client → 迁移旧账号设备与别名 → 最后删临时账号」；`AccountManager` 新增账号 ID 别名与 `user_id` 反查，残留的旧 ID 请求仍命中同一个 client；`ensureAccountExists()` 建完校验落盘，不再静默吞错。
- **验收**：`_miot_check/test_model_and_account.mjs` 离线自检 23 项 ALL PASS（型号判定 12 项 + 账号并发持久化 11 项）；`verify_234.sh` 新增 `[M]` 段核对 NAS 上的 bundle / 面板 / `/config` 字段，全绿；现网 `defaults 含 OH1P = True`、`defaults 数量 = 24`。

### 2.3.4

- **修复「飞牛网关端口不是 6688 就连不上」：通用网关自动发现**（来自两份 2.3.2 用户 debug 日志与 5666/51666 用户的反馈）。
  - **根因**：`/usr/trim/etc/network_gateway_setting.conf` 实际是 JSON（`{"schema":{"http":{"port":6688},...}}`），而安装脚本用 `sed` 匹配字面 `schema.http.port` —— **从未命中**，端口永远回落 6688；`.env` 里已写错的 `FNMUSIC_BASE_URL` 又因 `_miot_env_add`「只补缺失」在升级时不被纠正。结果后端一直连不存在的端口，日志满屏 `[fnmusic-token] ... Errno 111 Connection refused` + `base url probe failed: fetch failed`。2.3.0 那套「四层防御」针对的是 `Errno 101`（网络未就绪），对不上症；两份日志里 `Errno 101` 均为 0。
  - **修复（对任意端口成立，无端口白名单）**：新增 `host/gateway.mjs` —— ① 解析网关配置（JSON / `key=value` / ini 三种格式，任意端口，http 优先）；② 兜底扫描 `/proc/net/tcp{,6}` 全部 LISTEN 端口 × 回环与本机所有 IPv4，用 `GET /music/api/v1/initialization/state` 的 `200 + application/json + code` 特征**精确识别**，普通 HTML 服务 / 无 `code` 字段的 JSON 服务不会被误判；③ 只在现有基址探测失败时触发，命中后运行时切换并条件写回 `.env`（仅覆盖自动生成的回环 / 本机 IP 地址，用户手填域名、反向代理、带路径地址一律不动）。
  - **安装脚本同步**：conf 解析改为 JSON-aware；`FNMUSIC_GATEWAY_PORT` / `FNMUSIC_BASE_URL` 写入不再依赖 LAN IP 探测成功；conf 解析成功时对齐端口并纠正历史错误基址；安装日志记录 `gateway=<port>/conf|default`。每次发现重新读 conf 与 LISTEN 列表，运行期改端口也能跟上。
  - **诊断日志导出**新增「环境 / 网关发现」脱敏段：`FNMUSIC_BASE_URL`、网关端口、conf 解析结果、LISTEN 端口数、写回状态、最近一次自动发现结果。以后这类问题一眼定案，不必再靠猜（旧版导出只有 `miot.log` / `console.log`，看不到 `.env`）。
  - **用户侧无需操作**：升级后若基址错误，服务启动约 2 秒内自动发现并纠正；仍连不上时先按上面「导出诊断日志」看环境段，再检查网关是否只绑 LAN IP / 是否强制 HTTPS。
- **「设置 → 设备 → 服务端口」可视化入口 + 首次安装/升级引导**（原需 SSH 改 `.env` 才能自定义端口）。
  - 在「设置 → 设备」页顶部新增「服务端口」区块（替代原「服务器配置」卡片）：显示当前控制层/控制台端口；支持**手动填两个端口**（校验 1024~65535、互不相同、不与当前飞牛网关端口（由 `/ports/config` 动态下发）冲突、避开系统预留 8774）、**一键自动填充两个可用随机端口**（`GET /ports/suggest`，服务端读 `/proc/net/tcp*` + `net.createServer` 兜底盲选 10000~31000 空闲端口）、**保存并应用**（`POST /ports/apply`，写 `.env` → 备份 `.env.before-port-apply` → `systemd-run` 延迟重启服务）、**保持默认并跳过引导**。
  - 首次安装 / 从 2.3.4 之前版本升级后，前端 `initialize()` 调用 `GET /ports/config`，若宿主标记 `pending` 即自动跳到「设置 → 设备」，并在该分类上显示「待设置」状态条（引导页即为设备页顶部的「服务端口」区块）。引导标记存于 `<数据目录>/port_setup_state.json`（`pending` / `reason` / `from_version`）；安装/升级回调据此写入。
  - 应用后若用户是从局域网 TCP 直连控制台（`window.location.port` 与旧控制台端口一致），前端会提示「在新地址打开控制台」并给出跳转链接；非直连（经桌面 socket 或飞牛内嵌）则提示刷新页面。
  - 后端新增宿主级 `host/ports.mjs`（不经插件 QuickJS），注册 `GET /ports/config`、`GET /ports/suggest`、`POST /ports/apply`、`POST /ports/setup-done`；前端新增 `hostRequest()` 助手绕过 plugin 响应 `.data` 解包。延迟重启用 `systemd-run --no-block --collect --unit=fnmusic-miot-port-apply` 脱离当前 systemd 单元 cgroup，避免重启把当前 HTTP 响应一起杀掉。
  - 安装/升级脚本（`packaging/fpk/cmd/_common`）新增 `MIOT_PORT_GUIDE_SINCE="2.3.4"`、`fnmusic_miot_version_lt`、`fnmusic_miot_record_version`、`fnmusic_miot_write_port_guide_pending`、`fnmusic_miot_pick_if_occupied`：默认端口被占用时自动挑选空闲端口（`env_setup` 内，仅 fresh-install 走默认端口时触发），`check_ports_preinstall` 对「fresh-install + 被占用的是默认端口」改为告警放行让自动避让接管。`install_callback` / `upgrade_callback` 写 `pending` 标记并记录版本。
  - **注意**：fnOS 应用中心的升级实际走「卸载 → 重装」，生命周期总是执行 `install_callback` 而非 `upgrade_callback`，因此现网升级后 `reason` 显示为 `fresh-install`（功能上仍正确触发首次启动引导跳转），引导文案不依赖 reason 文案，无需特殊处理。
  - **UI 细节（同属 2.3.4）**：「修改端口」里两个端口输入框与「**自动填充**」在桌面端**三者等宽**同排（grid `repeat(3, minmax(0, 1fr))`，`minmax(0,…)` 保证永不撑破容器），窄屏（≤599px，手机）自动换行为「两输入框并排 + 自动填充整行」，不再把「设备」子页面撑出横向拖动；「设置 → 设备 → DLNA 接收器」的「插件入口已关闭 / 总开关已关闭 / 等待投放」等运行状态文字统一移到「保存接收器设置」按钮**后面同一行**（多个接收器时带名称前缀，窄屏自动换行）；「**待设置**」徽标移到「首次端口设置引导」标题行（`SectionCard` 的 `#actions` 插槽），「**保持默认并跳过引导**」改为与「保存并应用」一致的填充按钮，且引导卡用 `SectionCard` 新增的 `flat` 模式去掉卡片描边（否则 `padding:0` 的卡片边框会紧贴按钮，看起来像按钮外多一圈灰框），点击后整张引导卡收起；「当前端口」不再显示回访 / 控制台地址行；设置相关可见文案中的 Songloft 统一改为 **Miot**（DLNA 默认名、故障与说明文案、以及 DLNA `manufacturer` / SSDP `SERVER` 标识）；安装向导提示精简为「安装前请确认」三点（依赖 / 可选增强 / 首次端口）。

### 2.3.3

- **8775 / 8776 全面支持用户自定义**：端口不再是硬编码默认值，`.env` 成为唯一数据源。
  - `MIOT_PORT`（控制层监听，默认 8775）与 `FNMUSIC_MIOT_CONSOLE_PORT`（控制台 TCP 网关，默认 8776）可直接修改，范围 1024~65535 且互不相同；安装/升级不再覆盖用户值（仅识别到 1.0.0 容器版遗留 `.env` 特征时才回落默认），`MIOT_PUBLIC_PORT` / `MIOT_UPSTREAM_PORT` / `MIOT_SERVER_HOST` 由安装脚本自动对齐，storage 里自动生成的 `server_host` 也会跟随端口变化，手工填的域名/反向代理地址保持不动。
  - `fnmusic_miot_wait_ready`、安装/升级/启动的超时文案全部按实际端口动态化；`install_init` 增加端口占用预检（能明确判定占用者不是本应用旧实例时提前报错），启动失败时额外输出「哪个端口被哪个进程占用」的诊断，不再只有笼统的「启动超时」。
  - `EADDRINUSE` 时控制台网关给出改端口指引，`runtime` 把重启退避拉长到 30 秒并打印明确提示，不再每 2 秒空转；前端「自动填充」的兜底端口改由服务端 `/config` 下发 `control_port`（来源 `MIOT_PUBLIC_PORT`），自定义端口下也不会误填 8775。
  - 桌面入口走 `fnmusic-miot.sock` unix socket，与 TCP 端口无关；安装向导与 README 同步补充端口说明。
- **修复「服务器地址 → 自动填充」误填飞牛网关端口**：该字段是音箱回访 miot 控制层的地址（`http://<NAS IP>:<MIOT_PORT>`），但旧实现直接取 `window.location.origin`。面板内嵌在飞牛音乐页面时浏览器 origin 是 `6688`（飞牛音乐 HTTP 网关，后端访问曲库用），从控制台网关打开时是控制台端口，两者都不是播放接口；保存后音箱会拿到错误地址而无法播放。现在优先采用后端 `suggested_addresses` 中的完整服务地址（来自 `MIOT_SERVER_HOST`），无推荐地址时兜底用浏览器主机名 + 服务端下发的控制层端口，并对回环地址给出警告。

### 2.3.2

- **修复 4 个图标空白**：UI 图标子集字体 `miot-ui-icons.otf` 缺少 `bug_report`、`cloud_off`、`delete_sweep`、`inbox` 的字形（该字体按码点渲染、无连字兜底，映射了码点但字形缺失即渲染为空白）。从官方 Material Symbols Outlined 可变字体重新子集化（固定 FILL=0/GRAD=0/opsz=24/wght=400），覆盖 `SlIcon` 码点表全部 75 个码点，75/75 全部命中。涉及：工具箱「调试与诊断」卡片图标、「歌曲加载失败」空态图标、操作记录空态图标、清空记忆/清空按钮图标。

### 2.3.1

- **工具箱新增「调试与诊断」**：
  - 全局调试日志开关（控制 `debug_log_enabled`）：开启后控制层输出会话轮询诊断日志，同时门控 Node 侧的音箱推流 `[ACCESS]` 访问日志（插件保存配置后经 `/diagnostics/debug-mode` 通知宿主，宿主重启后从配置读初始值；环境变量 `FNMUSIC_MIOT_ACCESS_LOG=0/1` 可强制关闭/开启）。日常使用建议关闭以减少日志噪音。
  - 诊断日志导出按钮（`GET /diagnostics/logs?lines=N`）：服务端拼装控制层与控制台网关日志文件（`<数据目录>/logs/miot.log|console.log` 及其 `.1` 轮转）尾部各 N 行（默认 2000，上限 20000）加版本 / 运行环境信息，以 text/plain 附件下载，不依赖 journalctl，原生与容器部署行为一致。
- 前端测试运行器在 Windows 上因 `URL.pathname` 路径格式无法启动，改用 `fileURLToPath` 转换（Linux 行为不变）。

### 2.3.0

正式版汇总（吸收 2.2.2 ~ 2.2.13 的全部内部迭代）：

- **应用图标定稿**：紫粉渐变圆角方形「声波」图标；64 / 128 / 256 三档直接用用户原生尺寸源图（零重采样），并补齐 16 / 32 / 48 / 72 / 96 / 160 / 192 共 10 档尺寸，桌面在任何 DPI 下都有原生匹配档位，不再有「拿 64px 放大显示」的模糊路径。
- **手机端底部色带修复**：收缩播放条与下方留白背景不一致——补底 `::after` 的 `z-index` 由 79 提到 85，盖住播放条阴影（`0 -5px 18px` 的 blur 会向下溢出约 13px）在条带上造成的渐变暗带，底部整块变为同一个 `#f8f8fc`。
- **偶发「歌曲加载失败 / fetch failed」四层防御**：
  1. 安装脚本新装直写 `FNMUSIC_BASE_URL=http://127.0.0.1:<网关端口>`，后端不再绕经网络栈访问自身 LAN IP；
  2. 老 `.env` 里的 LAN IP 由客户端启动探测回环可用后自动迁移（失败 15 秒退避重探，网关只听 LAN 时保持原值）；
  3. 登录 / 歌单 / 歌曲 / 流媒体的网络层瞬时失败自动退避重试 2~3 次（HTTP 业务错误不重试）；
  4. 面板对幂等的 `/playlists*` GET 再静默重试一次（仅网络错误与 5xx）。

### 2.2.1

- 应用图标改为定制渐变音箱图标（首个图标版本，后续在 2.3.0 定稿）。

### 2.2.0

- 面板搜索接入飞牛音乐全库搜索；桌面 / 手机端 UI 重构；移除已废弃的 Songloft 薄壳插件。

## 开源协议

[MIT](./LICENSE)。
