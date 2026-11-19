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

### 2.3.12（2026-11-19 正式发布 GitHub v2.3.12）

- **新增「常用城市」，修复 AI 回答天气问题不能自动定位 / 推脱**。用户实测问天气，模型反问「哪个城市」或答「无法获取实时信息」。根因是请求里没有任何位置信息。本版在设置页「对话模型与角色」新增「常用城市」输入框（存 `chat_config:v1.city`，留空不注入），`chat/memory.ts` 新增 `isWeatherQuestion()`（天气/气温/下雨/空气质量/穿衣等）、`currentCityContext()` 与 `weatherUserAnchor()`：配置城市后，system 注入「用户所在城市为『XX』……默认就是指该城市，不要再反问城市；开启联网搜索后必须联网查询该城市实时天气，严禁推脱话术」，天气类问题的 user 消息再补一条贴近的城市锚点。与日期问答的加固思路一致（强约束 + 问题锚点），不改动用户自定义 system_prompt 正文（追加在其后）。
- **修复长回答播报「很久才播下一段 / 部分段落不出声」**。用户换 qwen4-max 后实测「历史上的今天」256 字回答，只有从「1995 年布冯…」开始的第 2 段播出，前面 183 字静默；且第一段空等 49 秒。抓包日志定位到两个叠加根因：
  - **TTS 分段过长触发设备静默失败**：这台电视的 MiIO TTS 命令通道（siid=7/aiid=3）对超长文本会静默失败——协议层仍返回 `code=0`，但设备端不播。实测 152 / 183 字（约 450+/500+ 字节）不出声，而 73 字（约 220 字节）正常。原分段上限 200 字正好踩雷。`speechSegments()` 单段上限改为 **60 字**（约 ≤180 字节，远低于阈值），并增加「；」等句末标点切分点。真实「历史今天」回答由 2 段（183+73）变为 6 段（48/48/60/27/59/14 字），全部 ≤156 字节。
  - **播放状态与 TTS 不互通导致空等死循环**：TTS 走 MiIO 命令通道，而 `getPlayState()` 读的是 mediaplayer 通道，两者不通，TTS 播报时 `status` 恒为 0。旧逻辑按 4 字/秒算 protection 后还要凑连续空闲，183 字空等约 49 秒。`SpeechService.speak()` 收尾判定重写为：TTS 回执非 false 即视为已播出（MiIO 命令成功即代表播出），等待时长贴合真实语速（4 字/秒 + 1 秒缓冲）用本地时钟计，`getPlayState` 观察到本轮 playing 再转空闲可提前结束；单段失败不中止整轮。既不再因 status 恒 0 空转死等，也不会早于实际播完就下发下一段造成打断。
- **回归验证**：`_miot_check/test_fix_2312.mjs` 12 项源码断言全过；`_miot_check/test_segment_2312.mjs` 用真实「历史今天」回答验证 6 段全部 ≤60 字 / ≤156 字节；`npx tsc --noEmit` 通过；前端 `npm run build` 通过，app.js 含「常用城市」+ 版本号 2.3.12。
- **累积**：包含 2.3.11 日期加固 + 2.3.10 日期注入基础 + 2.3.9 AI 长答案播报中断修复。
- **发布状态**：本版已于 2026-11-19 经用户单独授权正式发布 GitHub —— commit + annotated tag `v2.3.12` + push + Release + 3 附件齐备，latest 更新为 `v2.3.12`。产物本地 = NAS = GitHub 附件三处同源：fpk `c7262274cbb3851f7af6033ae9effa4405db3f79727ea43044c8596345aea474` / 1,292,070 B（以 `fnmusic-miot-2.3.12.fpk.sha256` 为准），源码包 `fnmusic-miot-2.3.12-src.tar.gz`（hash 见产物清单，README 不写自身 hash 以避免自引用）。NAS 验收 VERSION=2.3.12、systemd active、8775/8776 全 200、token `c345e65c…` 未变、用户 AI 配置完整保留（qwen4-max / dashscope / web_search=true / enabled=true）、`/chat/config` 已带 `city` 字段。逐文件对比 2.3.11：仅 bundle/main.js + static/css/style.css + static/js/app.js + README + VERSION 五个预期文件，无夹带。注：`appcenter-cli uninstall` 需 root 执行（普通用户会因 rpcbroker socket 权限 panic），本次升级已用 root 完成卸载/安装。
- **实测结论**：播报修复已验证生效——日志确认「历史今天」等多轮问答每段均 `played=true confirmed=true`、等待 12~16 秒不再空等 49 秒，从头到尾播完；「常用城市」注入已生效（回答带上所填城市）。**天气实时数据仍不可靠**：经对照实验确认百炼 `enable_search` / `forced_search` 实测未真正触发联网（问「此刻百度热搜第一」各模型均答查不到、响应无搜索字段），所谓实时天气多为模型编造；连接的 qwen4-max / qwen-plus 均如此。天气 API 直连方案（open-meteo）经评估后**放弃接入**，本版止步于「常用城市 + 强约束提示词」。

### 2.3.11（2026-11-19 本地构建 + 部署 NAS，未发布 GitHub）

- **加固「AI 日期问答」：2.3.10 的日期注入生效但被模型随机忽略**。用户实测问「今天几号」仍答「无法获取实时信息」。抓包确认实际请求里 system **确实带了正确日期**，且历史里有 3 组「问日期→推脱」的旧答案。根因是 2.3.10 的措辞太温和（「以此为准」），小模型（sensenova flash-lite）的推脱倾向被历史答案强化后压过温和陈述，采样时随机出错。本版做两处加固：
  - **system 强约束**：`currentDateContext()` 措辞改为「这是本系统提供的权威当前时间，你已经确切知道今天的具体日期……**必须直接说出具体年月日，严禁回答『无法获取实时信息』『不能确定今天是哪一天』『请查看设备日历』之类的推脱话术**」。
  - **user 时间锚点**：新增 `isDateQuestion()`（今天/今日/几号/日期/昨天/明天/星期几/现在几点/几月等）与 `dateUserAnchor()`，仅对**日期类问题**在当前 user 消息末尾追加一段贴近问题的时间锚点；播放音乐、设备控制等其它指令完全不受影响。
- **回归验证**：`_miot_check/test_date_context_v2.mjs` **22 项全过**（强措辞/日期问题识别含正反例/user 锚点/messages 集成/非日期问题不误伤/自定义前缀保留）；用抓到的真实请求体（含 3 组推脱历史）做真实模型 5 次对照，**5/5 全部正确答出日期**（2.3.10 旧措辞对照 1/3 答错甚至答成别的月份）。`npx tsc --noEmit` 通过。
- **累积**：包含 2.3.10 日期注入基础 + 2.3.9 AI 长答案播报中断修复。
- **发布状态**：本版**未发布 GitHub**（按用户规则，发布需单独授权）；已重新打包并覆盖安装 NAS，产物本地 = NAS 一致：fpk `77c6442f0ad4c7ade848491e3e88e45ab3622fcacbf36af2fcb116fd897d7c47` / 1,290,041 B，源码包 `9d90ad0e359df5d175224a7877f283fd4eb6af8b681a2dac1fcfda50d82e6aa6` / 1,281,222 B。NAS 验收 VERSION=2.3.11、systemd active、8775/8776 全 200、token 与 AI 配置不变、17 歌单正常。包内三处修复落地确认（播报 `speech_segments_done`×1、日期基础 `currentDateContext`×2、日期加固 `isDateQuestion`×2/`dateUserAnchor`×2）。逐文件对比 2.3.10：唯一差异 bundle/main.js + README + VERSION + manifest，无夹带。**待用户在面板实测日期问答。**

### 2.3.10（2026-11-19 本地构建 + 部署 NAS，未发布 GitHub）

- **修复「AI 对话不知道今天几号 / 现在几点」**。面板上显示的 `2026/11/19 16:40` 只是前端本地渲染的对话时间戳，不进模型请求；而构造请求的 system 消息只有一句角色设定，没有任何日期锚点，模型拿不到「今天」的参照，只能按训练知识保守推脱。本版在 `chat/memory.ts` 的 `messages()` 里追加 `currentDateContext()`，把设备本地日期时间注入 system 消息末尾：
  - 内容形如「【当前时间】2026年11月19日 星期四 16:43（设备本地时区）。回答涉及『今天/现在/昨天/明天』等时间概念时，以此为准。」
  - 用 `getFullYear/getMonth/getDate/getDay/getHours` 等**本地时区** API（与面板、调度器、`holiday.ts` 一致，NAS 为 UTC+8），不用 `toISOString()`（UTC 会差 8 小时）；时分补零。
  - 追加在用户自定义 `system_prompt` **末尾**，不改动用户已保存提示词；摘要/记忆提取那两处独立请求不注入日期（与对话无关）。
- **回归验证**：`_miot_check/test_chat_date_context.mjs` 固定时钟 2026-11-19 16:43，**13 项全过**（本地日期/星期/时分补零/时区/前缀保留/注入位置/问题仍在末条）。`npx tsc --noEmit` 通过。
- **累积**：本版同时包含 2.3.9 的 AI 长答案播报中断修复（见下）。
- **发布状态**：本版**未发布 GitHub**（按用户规则，发布需单独授权）；已重新打包并覆盖安装 NAS，产物本地 = NAS 一致：fpk `c2719fea2b050f14c6961eb8afee3a43b31813c83b4f0f895949ec629200e0c3` / 1,288,518 B，源码包 `79558f8783f67d3edc334d1d6fac064470b9741addabe3283d957d6e10d05e13` / 1,279,673 B。NAS 验收 VERSION=2.3.10、systemd active、8775/8776 全 200、token 不变、用户 AI 配置未被改写、17 歌单索引正常；包内两处修复标记落地确认（日期 `currentDateContext`×2、播报 `speech_segments_done`×1）。逐文件对比 2.3.9：唯一差异 bundle/main.js + README + VERSION + manifest，无夹带。**待用户在音箱实测日期问答与长答案播报。**

### 2.3.9（2026-11-19 本地构建 + 部署 NAS，未发布 GitHub）

- **修复「AI 对话长答案播报未播完就中断」**。根因在 `chat/speech.ts:speak()`：长答案被切成多段逐段播报，旧实现任一段的「播完收尾判定」失败就 `return 'unknown'`，导致后面所有段都不播——段数越多（长答案 4–6 段）越容易撞上，短答案 1 段几乎不触发，正好解释「只有长答案中断」。本版做五处修复：
  1. **单段收尾判定失败不再中止整轮**：记录未确认段后继续播下一段，所有段都下发完再统一判定结果。
  2. **放行 `accepted === null`**：设备回执 3012 超时表示「可能已经播出、不能据以判失败」（见 `mina/client.ts`），旧逻辑把它排除在 idle 判定外，必然跑满超时。
  3. **`sampledAt` 停滞兜底**：设备空闲时不刷新采样时间时，改用本地轮询时刻继续累计 idle，不再卡死。
  4. **播完即进下一段**：观察到本轮 playing 后转空闲即快速确认（连续 2 次），不再被按字数估算的 protection（200字≈50s）拖住；设备不报 playing 时 protection 后用连续 3 次空闲兜底。
  5. **放宽单段上限**：从固定 90 秒改为 `protection + 60 秒`，超时只标记不中止；结果语义：至少一段播完 → `completed` 并恢复音乐，全部未确认 → `unknown` 提示手动恢复。
- **补强播报诊断日志**：每段与整轮输出 `speech_segment=x/n ... confirmed=...` / `speech_segments_done=... confirmed=... unconfirmed=...`，下次异常可现场定位到具体段。
- **回归验证**：`_miot_check/test_speech_long_answer.mjs` 用虚拟时钟 + 按段可控状态工厂，同一组 8 场景分别跑修复前（git HEAD）与修复后代码。修复前 4 个中断场景全部失败（accepted=null / sampledAt 停滞 / 单段收尾失败 / 全无状态，均只播 1–2 段即中止），修复后 **8/8 全过**、所有段完整下发；正常场景虚拟等待从 186s 降到 16s。`npx tsc --noEmit` 通过。
- **发布状态**：本版**未发布 GitHub**（按用户规则，发布需单独授权）；已重新打包并覆盖安装 NAS，产物本地 = NAS 一致：fpk `23fdc6bce4571470c80d95b3e989b0034991f42a4fa75bd9330555ab49ac98fb` / 1,286,092 B，源码包 `be3ea0c7…b18bbaeac` / 1,278,326 B。NAS 验收 VERSION=2.3.9、systemd active、8775/8776 全 200、token 与 AI 配置不变、17 个歌单索引正常；包内 bundle 修复标记 `speech_segments_done`×1 / `speech_cancelled_at`×5 / `confirmedCount`×5 确认入包。逐文件对比 2.3.8：唯一差异为 bundle/main.js（speech 修复）+ README + VERSION + manifest，无夹带。**待用户在音箱实测长答案播报不再中断。**

### 2.3.8（2026-11-18 本地构建 + 部署 NAS；后已于 11-19 发布 GitHub v2.3.8）

- **更换应用图标**（紫粉渐变音量柱新图案，替换旧的紫粉图标）。本次只换图标、不动任何功能代码，2.3.7 的歌单计数/fnId 修复、stale ID 自愈、全库随机起播、设置页版本号等全部保留。
- **按飞牛「档位占位符」机制处理，根治手机端图标发糊**：飞牛桌面/手机 App 图标由 `ui/config` 的 `"icon": "images/miot_{0}.png"` 注册，`{0}` 是按分辨率选档的占位符；手机 App 请求 `miot_{0}.png` 时不带 `size` 参数，服务端回落到 `miot_64.png`（旧版仅 64×64），在高分屏上放大即发糊。经真实访问日志验证，**飞牛直接返回文件原始字节、不按文件名强制缩放**——因此把 `app/ui/images/miot_*.png` 全部档位（16/32/48/64/72/96/128/160/192/256）内容统一换成同一张 256×256 高清图，手机无论回落哪一档拿到的都是高清图；官方应用（迅雷/DPanel/Motrix）同样是把所有档位塞同一张图。
- **同步替换外层图标**：`ICON.PNG`（按规范保持 64×64，用新图案高质量缩放）、`ICON_256.PNG`（256×256 高清）、面板 `static/icon.png` 与 `frontend/public/icon.png`，保证应用中心、桌面入口、面板各处图标一致。
- **验证方式**：部署后请在**手机飞牛 App 完全退出后台再重进**，让桌面重新拉取图标（可能有缓存延迟，必要时多杀一次进程）。如需从 NAS 访问日志确认：手机请求 `icon_{0}.png`（无 size）返回的字节数应等于高清图大小（约 43,380 B），而非旧的低清档。
- **发布状态**：本版**未发布 GitHub**（按用户规则，发布需单独授权）；GitHub latest 仍为 `v2.3.7`。已重新打包并覆盖安装 NAS，产物本地 = NAS 一致：fpk `9575a65e…069ee92a57` / 1,282,157 B，源码包 `59edec1c…66c47` / 1,275,973 B。NAS 验收 VERSION=2.3.8、systemd active、8775/8776 全 200、token 与 AI 配置不变、17 个歌单索引正常；落地图标 10 档全为 43380B 新高清图（md5 `695893ebf5c7…`）、ICON.PNG 64×64 新图案、ICON_256 43380B。**待用户在手机飞牛 App 杀后台重进后目视确认图标清晰。**

### 2.3.7（2026-11-17 正式发布）

- **修复「小爱音箱里歌单显示 0 首、语音『播放歌单1』播不了，但歌单下面能看到 33 首」**。这是同一个错误计数 `songCount=0` 引出的两个后果，再叠加一处语音口令解析缺陷，与 2.3.6 无关（相关文件最后实质改动停在 2.1.1）。
  - **计数回写**：飞牛 `/playlist/list` 的元数据 `trackCount` 常缺字段或恒为 0，而歌曲明细 `/track/playlist-detail/list` 才是准的。现在 `adapter/songs.mjs` 拉过明细后用真实数量记入 `realPlaylistCount` 并在 `listPlaylists()` 覆盖元数据；索引层 `runPlaylistCacheLoad()` 加载完 `plSongs` 后也回写 `pl.songCount`。面板显示与语音判空从此看到同一个准数。
  - **不再提前判空**：`executePlayPlaylist` 删掉 `songCount===0` 就跳去外部搜单曲的提前 return，改为照常 `pm.play()` 拉真实明细；只有播放层确认加载 0 首（`pm.getTotalSongs()===0` 且非 ID 失效）才走外部兜底，非空歌单不再被误判成空。
  - **歌单名多形态匹配**：新增 `playlistMatchKey`（中文数字→阿拉伯 + 折叠繁简/装饰 + 剥离「我的/歌单/列表」前缀），让「歌单1 / 歌单一 / 一 / 1 / 我的歌单1」都能命中同一歌单。
  - **口令兜底**：日志里 ASR 把「播放歌单1」吞成「歌单一」，旧关键词「播放歌单/放歌单/播放列表」零命中。现在补「歌单/列表 + 名称」前缀兜底，且仅在 `play_playlist` 口令启用时生效，尊重用户口令开关。
- **修复上条「计数回写」引入的 `ReferenceError: fnId is not defined`**（发布前验收拦截）：`getPlaylistSongs()` 里回写 `realPlaylistCount` 时用到的 `fnId` 原先声明在 `else` 块内，块外引用触发块级作用域错误 —— 表现正是「自建/在线歌单加载歌曲失败 `fnId is not defined`」（收藏与虚拟歌单因短路/提前 return 不受影响）。现在把 `fnId` 提升到函数作用域声明、块内改为赋值，自建歌单可正常加载明细并回写计数。
- **诊断日志降噪**：对话监听每 2 秒刷 6 行轮询，把索引构建、口令路由、播放结果等业务日志挤出导出窗口。现在控制层日志导出时折叠连续轮询的中间行、保留首尾与全部业务行，并在段头注明折叠行数；业务行过少时自动回退原文。
- **修复「过一会儿自建歌单播不了、要重新说一次」（stale ID 根治）**：飞牛侧歌单 guid 变化（重新保存/扫描 auto-create）会让同一歌单被重新分配 miot id，旧的持久化 ID 变成 `resource not found`。原先只有语音/定时调用方各自做了 refresh+重试，**网页点播 `/player/play`、继续播放、重启恢复这三条路径直接用配置里的旧 ID 调 `pm.play()`，失败后不自愈也不回写**，于是旧 ID 一直留在设备配置里。
  - 现在把自愈下沉到播放层：`PlaylistManager.play()` / `playPlaylistFromSong()` 在检测到 ID 失效时调用注入的 `staleIdResolver`（`PlaylistManagerMap` 提供），refresh 索引→按歌单名重查新 ID→**回写所有仍引用旧 ID 的设备配置**→用新 ID 重试（带 `resolveDepth<2` 防死循环）。`restoreFromConfig` 同样在 ID 失效时重映射并用新 ID 初始化，避免 `persistState` 把旧 ID 写回。所有播放入口一次修好，不再需要用户重说口令。
- **「播放音乐」无歌名口令的空队列行为**：`play_song` 空参数原先在内存队列为空时只打一条 warn、什么也不播。现在改为：队列非空仍续播（原行为不变）；**队列为空则从「音乐库全部歌曲」虚拟歌单（id `2_000_000_000`，与 adapter `VIRTUAL_ID_BASE` 对齐）随机挑一首起播**（`pm.play(id, undefined, mode, {randomStart:true})`，先打断当前播报、沿用设备 play_mode、开启切歌播报；全库为空则 TTS 提示）。带歌名的搜歌路径完全不受影响。
- **设置页显示版本号**：设置页顶部标题栏常驻显示当前版本（如 `v2.3.7`），所有屏宽与分类下可见。版本号由 `vite.config.ts` 在构建时从仓库根 `VERSION` 文件注入为编译期常量（`__APP_VERSION__`），避开面板为静态 bundle、运行时无法读文件的问题；`SettingsPage.vue` 经 script 变量引用后在 AppBar 渲染。**升级打包时必须重新构建前端 static**（单纯替换 bundle 不会更新版本号）。
- **验收**：`_miot_check/test_playlist_237.mjs` **28 项全过**（歌单名多形态匹配 / 轮询降噪含回退 / 5 处源码接线契约）；`_miot_check/test_fnid_scope.mjs` **6 项全过**（真实注入 mock 适配器跑自建歌单明细加载，证明修复前精确复现 `fnId is not defined` 3 项失败、修复后全绿）；`_miot_check/test_stale_id_heal.mjs` **17 项全过**（真实运行 `play()` 模拟 stale→新 ID，验证 resolver 调用、新 ID 重载、配置回写、无新 ID 时不误自愈，外加 11 条接线契约）；`_miot_check/test_play_random_noqueue.mjs` **20 项全过**（真实打包 service.ts 调用 `executePlaySong('')`，验证队列非空续播 / 队列为空全库随机起播 id+randomStart+沿用 play_mode / 带歌名不受影响，外加 6 条接线契约）；`_miot_check/test_version_in_settings.mjs` **8 项全过**（VERSION→vite define→app.js 字面量→设置页模板引用整条链路）；`tsc --noEmit` 控制层 0 报错（前端 `typecheck` 仍有 2 个既有 `navigation` 报错，与本版无关），官方 `build.mjs` 与前端 `vite build` 均成功。
- **发布状态**：本版已于 2026-11-17 经用户单独授权正式发布 GitHub —— commit + tag `v2.3.7` + push + Release + 3 个附件齐备，latest 更新为 `v2.3.7`。发布前用户实测发现自建歌单 `fnId is not defined`，已修复并补上回归自检；分析日志第 4 点后又做了 stale ID 根治（见上）。**已重新打包并覆盖安装 NAS**（最终 fpk `f3acc50e…b3d40bffb` / 983,574 B，源码包 `37e0fe79…95af41d7e2a` / 973,022 B，本地 = NAS = `.sha256` = GitHub Release 四处一致；包内 `playWholeLibraryRandom`×2 / 起播日志×1 确认随机起播入包、前端 `app.js` 含 `2.3.7`×1 / `settings-version`×1 确认版本号入包，且含此前 stale 自愈修复）。NAS 验收健康全绿，`/js/app.js` 与 `/static/js/app.js` 经 HTTP 均 200 且含版本号；全库虚拟歌单 `2000000000` 实测可加载 351 首（随机起播数据源）；当前飞牛侧返回 16 个歌单，用户此前自建的「1379」此刻不在列表中（数据源头状态，与播放层修复无关，待用户确认）。

### 2.3.6（2026-11-15 正式发布）

> **本版同时承接上一轮更换的紫粉渐变应用图标**（64/128/256 零重采样，其余档位从 256 一次缩小）。

- **修复「AI 设置里『启用 AI 对话』关不掉，刷新又显示打开」**
  - **实测根因不在服务端**：在现网按面板同一条链路做 `GET /chat/config` → 改成 `enabled:false` → `PUT /chat/config` → 再 `GET`，服务端 **200 且磁盘 `chat_config:v1` 同步变为 false**（验证后已恢复用户原值）。问题在面板：`enabled` 只是 `v-model` 本地值，必须滚到页面最底部点「保存设置」才下发；该按钮默认禁用，且失败提示在页面最顶部，很容易以为「已经关了」。
  - **修复**：「启用 AI 对话」及本版新增的两个约束开关改为**切换即局部 PUT `{key: value}`**，成功/失败就地提示、失败自动回滚，不再依赖底部保存按钮；局部更新不会覆盖同页其它未保存草稿。`GET /chat/config` 显式 `Cache-Control: no-store`，面板所有请求加 `cache: 'no-store'`，杜绝刷新读到旧开关值。
- **修复「触发词『请问 / 问一下』形同虚设，没说触发词也会触发 AI 对话」**
  - **实测根因**：现网 `chat_config:v1` 里 `enabled: true` 且 **`fallback_enabled: true`**（「音乐口令未命中后交给 AI」藏在高级设置折叠里）。`voicecmd/dispatcher.ts` 的兜底、60 秒追问窗口、对话活跃期三条分支都会**绕过触发词**把任何未命中音乐口令的语音提交给 LLM —— 包括「打开客厅顶灯」；聊天历史里确实存着商汤日日新模型对这条设备指令的长篇回复。
  - **修复**：新增 `require_trigger`（默认 **true**，旧配置缺省也按 true，升级即生效）作为首次提问的硬门槛；`fallback_enabled` 只能决定「带触发词或追问时是否兜底」，不能再单独把任意语音送进 LLM。上一轮 AI 回答后的追问仍可免触发词，不破坏连续对话体验。显式关闭该开关可恢复旧行为。
- **设备控制口令不再被自定义 OpenAI 兼容模型抢答**：新增 `bypass_native_commands`（默认 **true**）与 `src/voicecmd/intent.ts` 通用意图判定 —— 结构化 `domain/action`、文本「动作 + 设备/家居类别词」、云端已播报的执行确认三路信号，不写死任何设备名或品牌；疑问句与音乐口令一律放行。命中后保留小爱自己的执行答复，**不播报「未识别」提示、不启动 LLM、不追加 TTS**，连 `ai_config` 的「AI 口令分析」也一并跳过（两套 AI 常共用同一个连接，多发一次同样产生长回复和费用）。
- **面板**：「AI 对话」卡片新增「必须说触发词」「不代答设备控制指令」两个即时生效开关；「音乐口令未命中后交给 AI」补充说明其受触发词约束；保存按钮注明主开关已即时生效。
- **排障日志**：每条轮询语音打印 `[VoiceDispatcher] routing chat_enabled=… require_trigger=… fallback=… bypass=… followup=… intent=… q="…"`，导出诊断日志即可核对开关真实值与拦截原因，不用再猜。
- **验收**：
  - 离线：`_miot_check/test_chat_routing.mjs` **53 项全过**（设备意图分类 / 不误伤提问与音乐口令 / 触发词路由矩阵 / 配置默认值与旧配置升级兼容 / 局部保存 / 源码接线契约）。`tsc --noEmit` 只剩 2 个与本版无关的既有报错（`store.ts` 上游遗留 `navigation`），Vite 构建成功。
  - NAS（`install_236.sh` + `verify_236.sh`，输出 `VERIFY_DONE`）：`VERSION=2.3.6`、systemd active、8775 / 8776 全 200、351 首 / 16 歌单 `loaded=16 failed=0`、token `c345e65c…a546` 不变；`/chat/config` 返回 `Cache-Control: no-store`，旧配置运行时补齐 `require_trigger=true` / `bypass_native_commands=true`；模拟面板局部 PUT `{enabled:false}` 与 `{require_trigger:false}` 均即时落盘且 GET 读回一致（验收后恢复原值）；面板 5 个静态资源全 200、新文案与 3 处 `no-store` 均在。备份 `pre-2.3.6-20261115-131957`。
  - 升级**没有**擅自改写用户的 `enabled` / `fallback_enabled`（磁盘仍为 `true` / `true`）；仅因验收往返把两个新字段以默认安全值 `true` 写入磁盘，语义与升级后默认一致。
- 产物：`fnmusic-miot-2.3.6.fpk` **976,815 B** / `f07888c1…9dd03d9`（本地 = NAS `/vol1/` = `.fpk.sha256` 三处一致），源码包 `fnmusic-miot-2.3.6-src.tar.gz` **965,209 B** / `3ec10fc1…1a3bfe104`；`build_236.sh` 逐文件对比显示 `cmd/`、`wizard/`、`host/`、`runtime/`、`config/` 全部未变，差异只落在 bundle / 面板 / 图标 / 文档 / manifest。
- **待用户侧实测**：对音箱说「打开客厅顶灯」等家居指令，应保留小爱自己的简短答复，不再出现「收到，正在思考」和商汤长回复；说「请问……」仍能正常 AI 对话，回答后追问可免触发词。导出诊断日志可见 `[VoiceDispatcher] routing chat_enabled=… require_trigger=… fallback=… bypass=… followup=… intent=phrase|domain|native_reply`。
- **发布状态**：经用户明确授权，已发布为 GitHub 正式版 `v2.3.6`（非 draft / 非 prerelease，设为 latest）：https://github.com/le5inioo/fnmusic-miot/releases/tag/v2.3.6 。Release 附件为上述 fpk / `.fpk.sha256` / 源码包，与本地及 NAS 已装产物同源；打包时生成的 fpk 内 README 不含本节事后补记，运行代码不受影响。

### 2.3.5（2026-11-14 正式发布）

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
- **发布状态（2026-11-14 补记）**：用户明确授权后已发布 GitHub —— commit `18c0e36` 推到 `main`、annotated tag `v2.3.5`、正式 Release（`draft=false` / `prerelease=false` / `make_latest=true`）与 3 个附件，latest 已指向 **v2.3.5**：<https://github.com/le5inioo/fnmusic-miot/releases/tag/v2.3.5>。远端三个附件下载回来与本地逐字节一致（fpk `481938d1…5f8fcbb42`、源码包 `b706b165…8d8a9951`）。

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
