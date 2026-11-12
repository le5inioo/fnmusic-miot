// 服务端口设置与「首次安装 / 老版本升级」引导（宿主级，Node 侧）。
//
// 面板「设置 → 服务端口」用这四个宿主级路由（不走插件 QuickJS）：
//   GET  /ports/config      当前端口、引导 pending 状态、能力标志
//   GET  /ports/suggest     探测并返回两个可用的随机端口（只填表，不落盘）
//   POST /ports/apply       校验 → 写 .env → 清引导 → 延迟重启 systemd 单元
//   POST /ports/setup-done  只清引导（用户选择「保持默认」）
//
// 端口以 .env 为唯一数据源（见 packaging/fpk/cmd/_common）。改端口必须重启
// 服务：runtime/start.mjs 的两个子进程在启动时读取 .env，热改无效。
// 主入口（fnOS 桌面图标 / 6688 注入面板）走 unix socket，socket 路径不随
// 端口变化，因此改端口不会让主入口失联；只有局域网 TCP 直连控制台
// （默认 8776）需要改用新地址，前端会给出新地址并在重启后自动跳转。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { pickFreePorts, listeningPorts, canBind, RESERVED_PORTS } from '../../runtime/pick_ports.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// host/ → miot-service/ → repo/
const REPO_ROOT = path.resolve(HERE, '../..');

const DEFAULT_CONTROL_PORT = 8775;
const DEFAULT_CONSOLE_PORT = 8776;
const MIN_PORT = 1024;
const MAX_PORT = 65535;

function clampPort(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(n) && n >= MIN_PORT && n <= MAX_PORT ? n : fallback;
}

function currentPorts() {
  return {
    control: clampPort(process.env.MIOT_PORT, DEFAULT_CONTROL_PORT),
    console: clampPort(process.env.FNMUSIC_MIOT_CONSOLE_PORT, DEFAULT_CONSOLE_PORT),
  };
}

function repoVersion() {
  try { return fs.readFileSync(path.join(REPO_ROOT, 'VERSION'), 'utf8').trim(); }
  catch { return 'unknown'; }
}

/** 挑两个互不相同、当前确实空闲的随机端口（复用 runtime/pick_ports.mjs）。 */
async function suggestPorts(cur) {
  const [control_port, console_port] = await pickFreePorts({
    exclude: [cur.control, cur.console, clampPort(process.env.FNMUSIC_GATEWAY_PORT, 6688)],
  });
  return { control_port, console_port };
}

/** 原子替换 .env 中指定键，保留其余行、注释与顺序。 */
function writeEnvKeys(envFile, updates) {
  let original = '';
  try { original = fs.readFileSync(envFile, 'utf8'); } catch { /* 新建 */ }
  const keys = Object.keys(updates);
  const seen = new Set();
  const lines = original.split(/\r?\n/).map((line) => {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && Object.prototype.hasOwnProperty.call(updates, m[1])) {
      seen.add(m[1]);
      return `${m[1]}=${updates[m[1]]}`;
    }
    return line;
  });
  for (const key of keys) {
    if (!seen.has(key)) lines.push(`${key}=${updates[key]}`);
  }
  // 去掉尾部多余空行，保证文件以单个换行结束。
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  const content = `${lines.join('\n')}\n`;
  const tmp = `${envFile}.ports.tmp`;
  fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o644 });
  fs.renameSync(tmp, envFile);
}

function readEnvValue(envFile, key) {
  try {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && m[1] === key) return m[2].trim().replace(/^['"]|['"]$/g, '');
    }
  } catch { /* no env file yet */ }
  return '';
}

/** 自动生成形式 http://<LAN IP>:<port> 跟随控制层端口；自定义域名/反代原样保留。 */
function nextServerHost(envFile, controlPort) {
  const cur = readEnvValue(envFile, 'MIOT_SERVER_HOST');
  if (!cur) return '';
  if (/^http:\/\/(?:\d{1,3}\.){3}\d{1,3}:\d+\/?$/.test(cur)) {
    const host = cur.replace(/^http:\/\//, '').replace(/:\d+\/?$/, '');
    return `http://${host}:${controlPort}`;
  }
  return ''; // 用户自定义：不写这个键，保留原值
}

/**
 * 延迟重启整个 systemd 单元。当前进程就在该单元里，直接同步 restart 会把
 * 自己连同 HTTP 响应一起干掉，所以先返回响应、再交给一个独立进程组执行。
 * 优先用 systemd-run 建独立 transient unit（脱离本单元 cgroup，不会被
 * KillMode=mixed 的 stop 连带杀掉），不支持时退回 detached shell。
 */
function scheduleRestart(log) {
  const unit = process.env.FNMUSIC_MIOT_UNIT || 'fnmusic-miot.service';
  const script = `sleep 2; systemctl restart ${unit}`;
  try {
    const child = spawn(
      'systemd-run',
      ['--no-block', '--collect', '--unit=fnmusic-miot-port-apply', '/bin/sh', '-c', script],
      { detached: true, stdio: 'ignore' },
    );
    child.once('error', (err) => {
      log.warn(`[ports] systemd-run 不可用，改用 detached shell：${err.message}`);
      try {
        const fallback = spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' });
        fallback.unref();
      } catch (e) {
        log.error(`[ports] 无法触发重启：${e.message}`);
      }
    });
    child.unref();
    return 'systemd-run';
  } catch (err) {
    log.warn(`[ports] systemd-run 启动失败：${err.message}`);
    try {
      const fallback = spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' });
      fallback.unref();
      return 'detached-shell';
    } catch (e) {
      log.error(`[ports] 无法触发重启：${e.message}`);
      return 'failed';
    }
  }
}

export function createPorts({ cfg, log }) {
  const dataRoot = process.env.FNMUSIC_MIOT_DATA_ROOT || path.dirname(cfg.dataDir);
  const envFile = process.env.MIOT_ENV_FILE || path.join(REPO_ROOT, '.env');
  const stateFile = path.join(dataRoot, 'port_setup_state.json');
  const systemdAvailable = fs.existsSync('/run/systemd/system');

  function readState() {
    try {
      const raw = fs.readFileSync(stateFile, 'utf8');
      const value = JSON.parse(raw);
      return value && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  }

  function markDone(reason) {
    try {
      fs.mkdirSync(dataRoot, { recursive: true });
      fs.writeFileSync(stateFile, `${JSON.stringify({
        pending: false,
        done: true,
        reason: reason || 'panel',
        completed_at: new Date().toISOString(),
        version: repoVersion(),
      })}\n`, { encoding: 'utf8', mode: 0o644 });
    } catch (err) {
      log.warn(`[ports] 写引导完成标记失败：${err.message}`);
    }
  }

  function config() {
    const cur = currentPorts();
    const state = readState();
    try {
      fs.mkdirSync(dataRoot, { recursive: true });
    } catch { /* 只读文件系统时不阻断 */ }
    return {
      success: true,
      control_port: cur.control,
      console_port: cur.console,
      gateway_port: clampPort(process.env.FNMUSIC_GATEWAY_PORT, 6688),
      default_control_port: DEFAULT_CONTROL_PORT,
      default_console_port: DEFAULT_CONSOLE_PORT,
      server_host: readEnvValue(envFile, 'MIOT_SERVER_HOST'),
      pending: state.pending === true,
      reason: typeof state.reason === 'string' ? state.reason : '',
      from_version: typeof state.from_version === 'string' ? state.from_version : '',
      version: repoVersion(),
      restart_supported: systemdAvailable,
      env_file: envFile,
    };
  }

  async function suggest() {
    return { success: true, ...(await suggestPorts(currentPorts())) };
  }

  async function apply(body) {
    const cur = currentPorts();
    const wantedControl = Number(body?.control_port);
    const wantedConsole = Number(body?.console_port);
    if (!Number.isInteger(wantedControl) || !Number.isInteger(wantedConsole)
        || wantedControl < MIN_PORT || wantedControl > MAX_PORT
        || wantedConsole < MIN_PORT || wantedConsole > MAX_PORT) {
      throw new Error(`端口号须为 ${MIN_PORT}~${MAX_PORT} 的整数`);
    }
    if (wantedControl === wantedConsole) {
      throw new Error('控制层端口与控制台端口不能相同');
    }
    const gateway = clampPort(process.env.FNMUSIC_GATEWAY_PORT, 6688);
    for (const [label, port] of [['控制层', wantedControl], ['控制台', wantedConsole]]) {
      if (port === gateway) throw new Error(`${label}端口不能与飞牛音乐网关端口 ${gateway} 相同`);
      if (RESERVED_PORTS.has(port) && port !== cur.control && port !== cur.console) {
        throw new Error(`${label}端口 ${port} 是系统/常用服务保留端口，请换一个`);
      }
    }
    // 新端口（非当前正在用的）必须确实空闲；两个新端口之间也不能互相撞。
    const busy = listeningPorts();
    for (const [label, port] of [['控制层', wantedControl], ['控制台', wantedConsole]]) {
      if (port === cur.control || port === cur.console) continue;
      if (busy.has(port)) throw new Error(`${label}端口 ${port} 已被其他程序占用，请换一个`);
      if (!(await canBind(port))) throw new Error(`${label}端口 ${port} 当前不可用，请换一个`);
    }

    const changed = wantedControl !== cur.control || wantedConsole !== cur.console;
    if (changed) {
      if (!systemdAvailable) {
        throw new Error('当前部署形态不支持在线重启服务，请 SSH 修改 .env 后手工重启');
      }
      // 留一份可回退的 .env 快照，防止改错端口后失联。
      try {
        const backup = `${dataRoot}/.env.before-port-apply`;
        fs.copyFileSync(envFile, backup);
        fs.chmodSync(backup, 0o600);
      } catch (err) {
        log.warn(`[ports] .env 备份失败（继续）：${err.message}`);
      }
      const updates = {
        MIOT_PORT: String(wantedControl),
        MIOT_PUBLIC_PORT: String(wantedControl),
        MIOT_UPSTREAM_PORT: String(wantedControl),
        FNMUSIC_MIOT_CONSOLE_PORT: String(wantedConsole),
      };
      const host = nextServerHost(envFile, wantedControl);
      if (host) updates.MIOT_SERVER_HOST = host;
      writeEnvKeys(envFile, updates);
      log.info(`[ports] .env 已更新 control=${wantedControl} console=${wantedConsole}`);
    }

    markDone('apply');
    const mode = changed ? scheduleRestart(log) : 'not-needed';
    return {
      success: true,
      changed,
      restart: changed,
      restart_mode: mode,
      restart_delay_seconds: changed ? 2 : 0,
      control_port: wantedControl,
      console_port: wantedConsole,
      console_changed: wantedConsole !== cur.console,
      previous_console_port: cur.console,
      server_host: readEnvValue(envFile, 'MIOT_SERVER_HOST'),
    };
  }

  function setupDone() {
    markDone('keep-default');
    return { success: true };
  }

  return { config, suggest, apply, setupDone, stateFile };
}
