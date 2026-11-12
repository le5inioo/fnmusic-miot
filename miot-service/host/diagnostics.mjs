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

export function createDiagnostics({ cfg, storage, log }) {
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
    for (const src of LOG_SOURCES) {
      out.push(`==== ${src.name} (${src.file}, 最近 ${maxLines} 行) ====`);
      const dir = logDir();
      const lines2 = tailLines(path.join(dir, src.file), maxLines);
      if (lines2) {
        out.push(...lines2);
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
