// 诊断与调试日志支持（host 级，Node 侧）。
//
// 组成两部分：
//   1. 全局调试开关状态：控制层进程内的 [ACCESS] 推流访问日志默认跟随
//      插件配置 debug_log_enabled（工具箱「调试与诊断」开关）。插件保存
//      配置后会 POST /diagnostics/debug-mode 通知这里；进程启动时从
//      storage 的 config 读取初始值。环境变量 FNMUSIC_MIOT_ACCESS_LOG
//      显式为 0/1 时优先生效（=0 永远关，=1 永远开）。
//   2. 日志导出：runtime/start.mjs 已把两个子进程（miot 控制层、console
//      网关）的 stdout 落盘到 <数据目录>/logs/<name>.log（超过 5 MB 轮转
//      成 .1），导出接口直接读取这些文件尾部拼装，不依赖 journalctl，
//      在原生与容器两种部署形态下行为一致。
//
// 路由在 server.mjs 注册（宿主级，不走插件 QuickJS）：
//   GET  /diagnostics/logs?lines=N   → text/plain 附件下载
//   POST /diagnostics/debug-mode     → {"enabled":bool} 同步调试开关

import fs from 'node:fs';
import path from 'node:path';

const MAX_LINES_DEFAULT = 2000;
const MAX_LINES_LIMIT = 20000;
const READ_LIMIT = 16 * 1024 * 1024; // 单文件最多读 16 MB，防止极端日志拖垮导出

function clampLines(raw) {
  const n = Number.parseInt(String(raw || ''), 10);
  if (!Number.isFinite(n)) return MAX_LINES_DEFAULT;
  return Math.max(100, Math.min(MAX_LINES_LIMIT, n));
}

function tailLines(file, maxLines) {
  let text;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size <= 0) return null;
    // 大文件只读尾部：日志行通常 <1 KB，多留 4 KB 余量
    const readBytes = Math.min(st.size, READ_LIMIT);
    const start = Math.max(0, st.size - readBytes);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(readBytes);
      fs.readSync(fd, buf, 0, readBytes, start);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    if (start > 0) text = text.slice(text.indexOf('\n') + 1); // 丢掉残行
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  return lines.length ? lines.slice(-maxLines) : null;
}

// 对话监听每 2 秒刷 6 行轮询（status/raw response/parsed/attempt/returned/after filter），
// 会把同一时间窗内真正有用的业务日志（索引构建、口令路由、播放结果、addMessage）挤出去。
// 这些聚合成一条摘要，既有"轮询确实在跑"的证据，又给业务日志腾出行数。
// 只匹配明确的轮询噪声，不误伤 addMessage / New messages / 错误 等行。
const POLL_NOISE_RE = /\[ConversationMonitor\] (doGetLatestAskFromXiaoai|getLatestAskFromXiaoai attempt=|pollDevice\s+\S+\s+(localNowMs=\d+ returned|after filter:|fetch failed))/;

/**
 * 对控制层日志做有界降噪。纯函数，便于离线自检。
 * 返回 { lines, dropped, keptPoll }：dropped 是被折叠的轮询行数。
 * 保底：若降噪后业务行不足 minBusinessLines，则回退原始尾部，避免误删导致信息缺失。
 */
export function denoiseControlLog(lines, { minBusinessLines = 40 } = {}) {
  if (!Array.isArray(lines) || lines.length === 0) return { lines: lines || [], dropped: 0, keptPoll: 0 };
  let dropped = 0;
  let keptPoll = 0;
  const firstPollIdx = lines.findIndex((l) => POLL_NOISE_RE.test(l));
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (POLL_NOISE_RE.test(line)) {
      // 保留每组轮询的首行与末行做证据，中间连续轮询折叠掉。
      const prevNoise = i > 0 && POLL_NOISE_RE.test(lines[i - 1]);
      const nextNoise = i + 1 < lines.length && POLL_NOISE_RE.test(lines[i + 1]);
      if (!prevNoise || !nextNoise) {
        out.push(i === firstPollIdx ? '[日志降噪] 以下对话轮询行已折叠，仅保留每组首尾：' : line);
        keptPoll++;
      } else {
        dropped++;
      }
    } else {
      out.push(line);
    }
  }
  const business = out.filter((l) => !POLL_NOISE_RE.test(l) && !l.startsWith('[日志降噪]')).length;
  if (business < minBusinessLines && dropped > 0) {
    return { lines, dropped: 0, keptPoll: 0, fallback: true };
  }
  return { lines: out, dropped, keptPoll };
}

export { POLL_NOISE_RE };

function readVersion(cfg) {
  const candidates = [
    process.env.MIOT_VERSION,
    // index.mjs 的 ROOT 是 miot-service/，仓库根在其上一级
    cfg && cfg.version,
    cfg && cfg.repoRoot ? path.join(cfg.repoRoot, 'VERSION') : null,
  ].filter(Boolean);
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() && fs.existsSync(c)) {
      try { return fs.readFileSync(c, 'utf8').trim(); } catch { /* fallthrough */ }
    }
    if (typeof c === 'string' && c.trim() && !fs.existsSync(c) && !c.includes('/') && !c.includes('\\')) {
      return c.trim(); // 直接就是版本号字符串
    }
  }
  return 'unknown';
}

// 诊断导出里允许出现的 .env 键（地址 / 端口类）。token、用户名、密码、
// 数据库路径一律不导出；URL 里若带 userinfo 也会被打码。
const DIAG_ENV_KEYS = new Set([
  'FNMUSIC_BASE_URL', 'FNMUSIC_GATEWAY_PORT', 'FNMUSIC_NAS_IP',
  'MIOT_PORT', 'MIOT_PUBLIC_PORT', 'MIOT_UPSTREAM_PORT',
  'FNMUSIC_MIOT_CONSOLE_PORT', 'MIOT_SERVER_HOST', 'MIOT_SERVER_HOST_FORCE',
  'MIOT_REQUIRE_AUTH',
]);

export function createDiagnostics({ cfg, storage, log, gateway = null }) {
  const envAccessLog = String(process.env.FNMUSIC_MIOT_ACCESS_LOG || '').trim().toLowerCase();
  const forced = envAccessLog === '0' ? false : (/^(1|true|yes|on)$/i.test(envAccessLog) ? true : null);
  const state = {
    // null = 跟随配置；true/false = 环境变量强制
    debugMode: forced === true,
    forced,
  };

  function accessLogEnabled() {
    if (forced !== null) return forced;
    return state.debugMode;
  }

  /** 进程启动时从 storage 配置读初始开关值（插件还没来得及通知）。 */
  async function initFromConfig() {
    if (forced !== null) return;
    try {
      const raw = await storage.get('config');
      const stored = raw ? JSON.parse(String(raw)) : {};
      if (typeof stored.debug_log_enabled === 'boolean') {
        state.debugMode = stored.debug_log_enabled;
        log.info(`[diagnostics] debug log ${state.debugMode ? 'on' : 'off'} (from config)`);
      }
    } catch { /* 配置损坏时按默认关闭处理 */ }
  }

  function setDebugMode(enabled) {
    state.debugMode = !!enabled;
    log.info(`[diagnostics] debug log ${state.debugMode ? 'on' : 'off'} (set via panel)`);
  }

  function logDir() {
    // runtime/start.mjs：logs 与数据目录 miot/ 同级（<DATA_ROOT>/logs）
    return process.env.FNMUSIC_MIOT_LOG_DIR || path.join(cfg.dataDir, '..', 'logs');
  }

  const LOG_SOURCES = [
    { name: 'miot（控制层，旧）', file: 'miot.log.1' },
    { name: 'miot（控制层，当前）', file: 'miot.log' },
    { name: 'console（控制台网关，旧）', file: 'console.log.1' },
    { name: 'console（控制台网关，当前）', file: 'console.log' },
  ];

  /** 读取 .env 白名单键，供排查「网关端口不对 / 基址写错」类问题。 */
  function envKeyLines() {
    const file = process.env.MIOT_ENV_FILE || path.join(cfg.repoRoot || '', '.env');
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
    const out = [];
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m || !DIAG_ENV_KEYS.has(m[1])) continue;
      const v = m[2].trim().replace(/^['"]|['"]$/g, '').replace(/\/\/[^/@]+@/, '//***@');
      out.push(`${m[1]}=${v}`);
    }
    return out.length ? out : null;
  }

  /** 拼装诊断日志文本。 */
  async function exportLogs({ lines } = {}) {
    const maxLines = clampLines(lines);
    const out = [];
    out.push('==== fnmusic-miot 诊断日志导出 ====');
    out.push(`导出时间: ${new Date().toISOString()} (本地 ${new Date().toLocaleString('zh-CN', { hour12: false })})`);
    out.push(`版本: ${readVersion(cfg)}`);
    out.push(`node: ${process.version} (${process.platform}/${process.arch}) pid=${process.pid}`);
    out.push(`进程运行时长: ${Math.round(process.uptime())}s`);
    out.push(`数据目录: ${cfg.dataDir}`);
    out.push(`日志目录: ${logDir()}`);
    out.push(`调试日志开关: ${accessLogEnabled() ? '开' : '关'}${forced !== null ? '（由环境变量 FNMUSIC_MIOT_ACCESS_LOG 固定）' : ''}`);
    out.push('');
    out.push('==== 环境 / 网关发现（脱敏，不含任何凭据） ====');
    const envLines = envKeyLines();
    if (envLines) out.push(...envLines);
    else out.push('(.env 不可读或没有可导出的地址/端口键)');
    if (gateway) {
      const s = gateway.snapshot();
      out.push(`运行时网关基址: ${s.runtime}`);
      out.push(`证书策略: ${s.tlsPolicy}；强制 HTTPS=${s.forceHttps ? '是' : '否'}；HTTPS 端口=[${(s.confHttpsPorts || []).join(', ') || '无'}]`);
      out.push(`网关配置: ${s.confPath} 可读=${s.confReadable} 解析到端口=[${s.confPorts.join(', ') || '无'}]`);
      out.push(`本机 LISTEN 端口数: ${s.listenPortCount}；本机 LAN IPv4: [${s.lanIps.join(', ') || '无'}]`);
      out.push(`发现时排除的本应用端口: [${s.selfPorts.join(', ') || '无'}]`);
      out.push(`网关结果写回 .env: ${JSON.stringify(s.persist)}`);
      out.push(`最近一次自动发现: ${s.lastDiscover ? JSON.stringify(s.lastDiscover) : '未触发（当前基址可连通）'}`);
    }
    out.push('');
    // 控制层日志做有界降噪：对话监听每 2 秒 6 行轮询会淹没同窗的业务日志。
    // 降噪只折叠连续轮询的中间行，保留首尾与全部非轮询行；业务行过少时自动回退原文。
    for (const src of LOG_SOURCES) {
      const isControlLog = src.name.startsWith('miot');
      out.push(`==== ${src.name} (${src.file}, 最近 ${maxLines} 行${isControlLog ? '，对话轮询已降噪' : ''}) ====`);
      const dir = logDir();
      const lines2 = tailLines(path.join(dir, src.file), maxLines);
      if (lines2) {
        if (isControlLog) {
          const d = denoiseControlLog(lines2);
          if (d.dropped > 0) out.push(`[日志降噪] 本段折叠了 ${d.dropped} 行重复的对话轮询，业务日志与轮询首尾均保留。`);
          out.push(...d.lines);
        } else {
          out.push(...lines2);
        }
      } else {
        out.push('(不存在或为空)');
      }
      out.push('');
    }
    return { body: out.join('\n') + '\n' };
  }

  function attachmentName() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `fnmusic-miot-diag-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.log`;
  }

  return { state, accessLogEnabled, initFromConfig, setDebugMode, exportLogs, attachmentName };
}
