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

## 运行（容器内）

```bash
MIOT_ENV_FILE=/repo/.env MIOT_DATA_DIR=/data/miot node host/index.mjs
```

配置键（写在 `/repo/.env`，或直接用环境变量）：

| 键 | 默认 | 说明 |
|---|---|---|
| `MIOT_PORT` | `8006` | 容器内监听端口 |
| `MIOT_TOKEN` | 生成并持久化到 `/data/miot/token` | 面板/播放 URL 鉴权；WebUI 反代读同一文件 |
| `MIOT_REQUIRE_AUTH` | `true` | 8775 对局域网开放，不要关 |
| `MIOT_SERVER_HOST` | `http://$FNMUSIC_NAS_IP:8775` | 音箱拉流基址，写进 miot 的 `config.server_host` |
| `MIOT_SERVER_HOST_FORCE` | `false` | 从 Songloft 迁移旧配置时置 true 覆盖陈旧地址 |
| `FNMUSIC_NAS_IP` | — | NAS 局域网 IP（容器是 bridge 网络，自动探测不到） |
| `FNMUSIC_BASE_URL` | `http://$FNMUSIC_NAS_IP:6688` | 飞牛音乐网关（端口取自 `network_gateway_setting.conf`） |
| `FNMUSIC_GATEWAY_PORT` | `6688` | 未显式设 BASE_URL 时拼装用 |
| `FNMUSIC_MUSIC_DB_DIR` | `/usr/local/apps/@appdata/trim.music/db` | compose 只读挂载为 `/fnmusic-db` |
| `FNMUSIC_USERNAME` / `FNMUSIC_PASSWORD` | 回落 `FNMUSIC_IMPORT_*` | 有本地密码的账号才用得上（OAuth 账号见下） |
| `FFMPEG_BIN` | `/usr/bin/ffmpeg` | 转码 |
| `MIOT_MAX_TRANSCODES` | `2` | 并发转码上限 |

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
| `/index.html` `/static/*` `/assets/*` | Vue 面板 |
| 其余 | 交给 `onHTTPRequest`（SDK createRouter，95 条 REST） |
| `/status/ws` `/conversation/ws` `/chat/ws` | 交给 `onWebSocket` |

面板对外地址：`https://<NAS>/app/fnmusic-ext/miot/index.html`。
WebUI 的 `/miot/{path:path}` 反代会剥掉前缀、注入 `Authorization`，转到 `127.0.0.1:8006`。

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
