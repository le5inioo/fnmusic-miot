# miot-service — 音箱控制层

`songloft-plugin-miot` 以 **fnOS 主机原生 Node 进程**运行（systemd `fnmusic-miot.service`），
音乐源为飞牛音乐（trim.music）的官方 API。它替换了原来的 `miot-service/`
（xiaomusic 0.6.1 + miservice-fork + native 口令引擎）。

从 2.1.0 起 `fnmusic-ext` 是**可选增强**而非依赖：装了才有 `online:` 在线榜单与
在线音源，没装时自动降级为纯本地曲库模式（本地曲库 / 收藏 / 音乐库 / 播放 /
拖动进度条 / 语音口令均正常）。能力探测见 `adapter/fnmusic.mjs` 的 `detectExt()`，
控制台通过 `/compat/status` 展示当前模式。

## 为什么还能沿用 `xiaomusic` 这个名字

`[program:miot]`、容器内 `8006`、`FNMUSIC_MIOT_ENABLED`、`/health`、`/sync`、`/play?guid=`
是 WebUI / entrypoint / healthcheck / fpk cmd 共同绑定的标识符。全部保留，
外围代码几乎零改动；只有进程实际执行的东西换成了 Node。

## 目录

```
miot-service/
  host/            宿主兼容层（原 Songloft Go 宿主在 Node 里的替身）
    index.mjs        入口：加载 .env → polyfill → songloft.* → bundle → onInit → listen
    crypto.mjs       crypto.md5/randomBytes + __go_crypto_* / __go_buffer_* / RC4
    fetch.mjs        宿主 fetch 语义（no-redirect / timeout / getSetCookie 数组 / net.httpStream）
    songloft.mjs     songloft.{log,storage,songs,playlists,plugin,net,comm}
    storage.mjs      串行异步 KV → /data/miot/storage.json（原子写）
    server.mjs       Node http + ws → 5 个生命周期钩子；静态托管；token 中间件
  adapter/         飞牛音乐适配层
    fnmusic.mjs      authx 签名 + 登录/重登/取流（JS 移植，与 Python 原版逐字节一致）
    songs.mjs        Song/Playlist 映射（guid ↔ number；收藏歌单固定 id=1）
    stream.mjs       /api/v1/songs/:id/play（Range/ffmpeg/seek/speed/normalize）+ 封面 + 歌词
    compat.mjs       /health /healthz /sync 兼容字段
  src/              songloft-plugin-miot 的 src/（目录名刻意不改：前端有跨目录引用）
  frontend/         songloft-plugin-miot 的 frontend/（api.ts / main.ts 已按网关改过）
  bundle/main.js    esbuild 预构建产物（随 fpk 分发，镜像构建不联网）
  static/           Vite 预构建的 Vue 面板
  vendor/ws/        唯一运行时依赖，内联分发（ws 8.22.1，无传递依赖）
  build.mjs         esbuild 打包脚本
  container/        预留的替换片段（实际改动已落到仓库 container/）
```

## 构建（开发机）

```bash
cd miot-service
npm install                 # esbuild + @songloft/plugin-sdk + pako（仅构建期）
npm run build               # → bundle/main.js
npm run build:panel         # frontend npm install + vite build → static/
# 或 npm run build:all
```

构建完把 `node_modules/` 删掉再打 fpk；`packaging/fpk/build.sh` 也会自动排除它。

## 运行与端口

原生部署由 `runtime/start.mjs` 拉起控制层（`host/index.mjs`）与控制台网关
（`nodeconsole/server.mjs`）。端口写在已安装目录的 `.env`（安装脚本生成，
升级时保留用户自定义值），**8775 / 8776 只是默认值**：

| 键 | 默认 | 说明 |
|---|---|---|
| `MIOT_PORT` | `8775` | 控制层监听端口（0.0.0.0，音箱回访拉播放地址） |
| `MIOT_PUBLIC_PORT` | 同 `MIOT_PORT` | 音箱回访地址端口；写入 `server_host`，并经 `/config` 的 `control_port` 下发给面板 |
| `MIOT_UPSTREAM_PORT` | 同 `MIOT_PORT` | 控制台网关反代到控制层的目标端口 |
| `FNMUSIC_MIOT_CONSOLE_PORT` | `8776` | 控制台 TCP 网关（局域网浏览器直连）；桌面入口走 unix socket，与此端口无关 |
| `MIOT_SERVER_HOST` | `http://$FNMUSIC_NAS_IP:$MIOT_PORT` | 音箱拉流基址，写进 miot 的 `config.server_host`；手填的域名/反向代理地址不会被覆盖 |

自定义端口：**从 2.3.4 起可在「设置 → 设备 → 服务端口」（设备页顶部的「服务端口」区块，替代原「服务器配置」卡片）内可视化操作**（手动填 / 「自动填充」随机选端口 / 应用并自动重启），
无需 SSH 改 `.env`；直接改 `.env` 后重启同样有效。修改 `MIOT_PORT` 与
`FNMUSIC_MIOT_CONSOLE_PORT`（1024~65535、互不相同）后重启服务即可；安装脚本会自动对齐其余三个端口键与
`MIOT_SERVER_HOST`。端口被占用时安装预检会给出占用进程，启动日志也会明确提示而不是无限重启；若默认端口
恰好被占，全新安装时会自动避开并挑选空闲端口，仍会在首次引导（见下）里让用户确认。

> **首次安装 / 老版本升级引导**：`port_setup_state.json`（`pending` / `reason` / `from_version`）位于
> `<数据目录>/`（即 `FNMUSIC_MIOT_DATA_ROOT`，默认 `/vol1/@appdata/fnmusic-miot/var`）。`pending=true`
> 时面板 `initialize()` 读取 `GET /ports/config` 后会直接跳到「设置 → 设备」（顶部「服务端口」区块）。清除方式：引导页点
> 「保持默认并跳过」（`POST /ports/setup-done`），或在设置页成功应用端口（`POST /ports/apply`）。

其余配置键：

| 键 | 默认 | 说明 |
|---|---|---|
| `MIOT_TOKEN` | 生成并持久化到 `<数据目录>/miot/token` | 面板/播放 URL 鉴权；WebUI 反代读同一文件 |
| `MIOT_REQUIRE_AUTH` | `true` | 控制层对局域网开放，不要关 |
| `MIOT_SERVER_HOST_FORCE` | `false` | 从 Songloft 迁移旧配置时置 true 覆盖陈旧地址 |
| `FNMUSIC_NAS_IP` | — | NAS 局域网 IP |
| `FNMUSIC_BASE_URL` | `http://127.0.0.1:<网关端口>` | 飞牛音乐网关；端口由 conf 探测 + 运行时自动发现（见下），**不要写死 6688** |
| `FNMUSIC_GATEWAY_PORT` | conf 解析值（失败时 `6688`） | 未显式设 BASE_URL 时拼装用 |
| `FNMUSIC_MUSIC_DB_DIR` | `/usr/local/apps/@appdata/trim.music/db` | compose 只读挂载为 `/fnmusic-db` |
| `FNMUSIC_USERNAME` / `FNMUSIC_PASSWORD` | 回落 `FNMUSIC_IMPORT_*` | 有本地密码的账号才用得上（OAuth 账号见下） |
| `FFMPEG_BIN` | `/usr/bin/ffmpeg` | 转码 |
| `MIOT_MAX_TRANSCODES` | `2` | 并发转码上限 |

**飞牛网关端口自动发现（2.3.4 起）**：各 NAS 的网关端口可能各不相同，代码里不带任何端口白名单。
`host/gateway.mjs` 只在 `adapter/fnmusic.mjs` 的 `normalizeBaseUrl()` 探测失败时触发，按
「conf 端口 → 环境变量端口 → `/proc/net/tcp{,6}` 全部 LISTEN 端口 × 回环/所有本机 IPv4」
生成候选，用 `GET /music/api/v1/initialization/state` 的 `200 + application/json + code`
特征精确识别；命中后切换运行时基址，并且只在 `.env` 里的值是自动生成的回环/本机 IP 地址时
写回（用户手填域名、反向代理、带路径地址不动）。conf 解析兼容 JSON / `key=value` / ini。
安装脚本 `fnmusic_miot_env_setup` 同步做了 JSON-aware 解析与历史错误值纠正。
`fnmusic_token.py --base` 由 `host/index.mjs` 显式传 `fn.baseUrl`，与 API 调用始终同一条链路。
诊断导出（`GET /diagnostics/logs`）含「环境 / 网关发现」脱敏段，可直接看到配置值、
conf 解析端口、LISTEN 端口数与最近一次自动发现结果；配置正确时应显示「未触发」，表示零扫描。

**飞牛音乐鉴权（3.8.1 实测修正）**：fnOS 账号若由 NAS OAuth 创建（`music.db` 里
`user.created_by='oauth'`），`/user/password-login` 恒返回 `code=120001`，账密这条路不可用。
控制层改为调用 `scripts/fnmusic_token.py`：只读 `music.db`，逐个探测 `user_token` 里的
`Cookie: music-token` 会话（优先 `is_auth_login=1`），挑出服务端认可的那条并缓存到
`/data/miot/fnmusic-token`；遇到 401 / `120001` 会带 `--force` 重新挑选，令牌过期后自愈。
`proxy/playlist_import.py` 也复用同一缓存文件，歌单导入不受影响。

## 端点

| 路径 | 说明 |
|---|---|
| `/health` `/healthz` `/sync` `/play?guid=` | fnmusic-ext WebUI 兼容面 |
| `/api/v1/songs/:id/play` | 音箱拉流（Range / format=mp3 / seek / speed / normalize） |
| `/api/v1/songs/:id/cover` `/lyric` | 封面与歌词代理 |
| `/ports/config` | 宿主级（不经插件 QuickJS）：返回当前控制层/控制台端口、`gateway_port`、`pending` 引导标记与 `reason`/`from_version` |
| `/ports/suggest` | 探测两个可用随机空闲端口（读 `/proc/net/tcp*`、`net.createServer` 兜底盲选 10000~31000） |
| `/ports/apply` | 校验并写入 `.env`（备份 `.env.before-port-apply`），按需 `systemd-run` 延迟重启服务 |
| `/ports/setup-done` | 仅清除 `pending` 引导标记（「保持默认并跳过」） |
| `/diagnostics/logs?lines=N` | 诊断日志导出（text/plain）；头部含「环境 / 网关发现」脱敏段 |
| `/index.html` `/static/*` `/assets/*` | Vue 面板 |
| 其余 | 交给 `onHTTPRequest`（SDK createRouter，95 条 REST） |
| `/status/ws` `/conversation/ws` `/chat/ws` | 交给 `onWebSocket` |

面板对外地址：`https://<NAS>/app/fnmusic-ext/miot/index.html`。
WebUI 的 `/miot/{path:path}` 反代会剥掉前缀、注入 `Authorization`，转到 `127.0.0.1:8006`。

## 设备型号与播放接口（Music API）

`src/mina/constants.ts` 的 `needUsePlayMusicAPI(hardware, disabled, enabled)` 决定下发歌曲时走
`player_play_music` 还是 `player_play_url`。优先级：**显式禁用 > 显式启用 > 内置默认表 > 直链**，
型号统一按大写、去空格比较。

| 来源 | 配置 / 常量 | 说明 |
| --- | --- | --- |
| 内置默认表 | `DEFAULT_MUSIC_API_MODELS`（24 个） | OH 系列含 `OH11` / `OH2` / `OH2P` / `OH1P` / `OH1M` / `OH8` / `OH27` |
| 用户显式启用 | `music_api_model_enabled` | 让默认表之外的新型号也走 Music API |
| 用户显式禁用 | `music_api_model_disabled` | 覆盖默认表，退回直链 |

部分 Pro / Sound 系列固件只认 `player_play_music`，走直链会「日志显示 Playing 但音箱无声」；
另一些型号在 ROM 更新后 Music API 反而更脆弱，需要关掉。因此**两条手动覆盖清单同时存在**，
面板「设置 → 设备 → 高级设备兼容」对**所有已识别型号**都提供勾选框（早期版本对不在默认表的型号
直接 `:disabled`，用户无法自救），以后小米发布新型号无需等插件发版即可自行试出来。
`POST /config` 对两个清单做互斥归一化（同时出现时以显式禁用为准）。

链路：`service/service.ts::playURL` 读配置 → `mina/client.ts::playByUrl(modelPrefs)` →
`needUsePlayMusicAPI`。`MusicApiModelPrefs { disabled, enabled }` 兼容旧的 `string[]` 传参（视为 disabled）。
debug 日志 `[MinaClient] playByUrl` 会打印 `hardware` / `useMusicAPI` / 两个清单，便于定位无声问题。

## 飞牛网关协议 / 强制 HTTPS（2.3.5）

控制层所有对飞牛音乐网关的请求（`apiCall` / `login` / `openStream` / 封面 / token 脚本）
统一走 `host/gateway-fetch.mjs`，不再各自直接调 `nativeFetch`。

| 场景 | 行为 |
| --- | --- |
| `http://` 网关 | 原生 fetch，行为与旧版一致，零额外开销 |
| 内网 `https://` 网关（回环 / 私有 IPv4 / `*.local`） | `node:https` + `rejectUnauthorized:false`，容忍自签证书与 `127.0.0.1` 域名不匹配 |
| 公网 `https://` | 原生 fetch 严格校验，**不**放宽 |
| 网关自身的 301（强制 HTTPS） | 自动吸收，保留 headers 重发，并把最终 origin 回调固化为 `urlBase` + 写回 `.env` |
| 在线音源 CDN 302 | Location 不是 `/music/api/v1`，不自动跟随，交回 `openStream` 手动 hop |

设计要点：

- 绝不设 `NODE_TLS_REJECT_UNAUTHORIZED=0` —— 同一进程还要连小米云，全局放宽会把公网请求的证书校验一起关掉。放宽范围严格限定在 `isLocalGatewayHost()` 判定的内网网关。
- `resolveRedirectBase()` 在当前基址是内网直连、而 301 的 Location 写成域名时，**保留当前 host、只采纳协议与端口**，避免 DNS 不可达 / 证书域名不匹配；用户手填的域名 / 反向代理基址则完整采纳 Location。
- `host/gateway.mjs` 的 `confPorts()` 读 `{"schema":{"http":{"port":…},"https":{"port":…}},"force_https":…}`；`probeBase()` 对同一端口先试 http 再试 https，因此「HTTP 端口仍在但 301」「HTTP 端口被完全关闭只留 HTTPS」两种实现都能命中。
- `scripts/fnmusic_token.py` 对内网网关用 `ProxyHandler({})` 强制直连（环境里的 `HTTP_PROXY` 会把 `127.0.0.1` 请求发到代理导致超时），并用同一个放宽的 SSL context 覆盖重定向后的 HTTPS 连接。
- 音箱回访地址 `MIOT_SERVER_HOST` 指向 miot 自己的控制层端口，不经飞牛 nginx，**不受强制 HTTPS 影响**。

排查时导出诊断日志，看「环境 / 网关发现」段的 `证书策略` 与 `强制 HTTPS`：
`http (no TLS)` = 普通 HTTP；`https-local (self-signed allowed)` = 已切到内网 HTTPS；
`https-remote (strict verification)` = 公网/自定义域名严格校验。离线自检脚本
`_miot_check/test_force_https.mjs` 可用 `MIOT_SVC_DIR=<已安装 repo>/miot-service` 在 NAS 上直接复跑。

## 已知边界

- `songs.create` / `download` 禁用：不往飞牛官方曲库写文件。
- 收藏歌单固定 `id=1`（`src/utils/favorites.ts` 的硬约束）；飞牛歌单只有字符串 `guid`，
  用 `stableId(guid)` 映射成稳定数字 id（不能 `Number(guid)`，否则会变成 0 / 1000 导致
  `/track/playlist-detail/list` 报 `invalid arguments`）。`online:` 虚拟歌单官方接口取不到，降级为空列表。
- 曲目元数据来自 `audioSpec.*` / `artists[]` / `album` / `coverId`，不是扁平字段；
  `format` 决定 FLAC/APE 是否走 ffmpeg 转 MP3。
- 歌词优先读音频旁边的同名 `.lrc`，其次官方 `/lyric/list`；都没有时返回 404（miot 会归一化成空歌词）。
- `getNetworkAddresses()` 在 bridge 网络里只能看到 172.x，故把 `FNMUSIC_NAS_IP` 放在返回列表首位。
- DLNA/SSDP 的 UDP 组播已在 shim 里实现，但 NAS 上尚未做真机回归。
