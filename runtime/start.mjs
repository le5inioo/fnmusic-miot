#!/usr/bin/env node
// fnmusic-miot 原生运行时入口（systemd Type=simple 的唯一前台进程）。
//
// 替代容器版里的 supervisord + entrypoint.sh：拉起两个子进程并守护，
// 子进程意外退出则退避重启；收到 SIGTERM 时按顺序优雅关闭。
//   · miot      —— 控制层（miot-service/host/index.mjs，监听 8775）
//   · console   —— 控制台网关（nodeconsole/server.mjs，监听 8776 + 桌面 socket）
//
// 日志：子进程输出加名前缀转 stdout（由 systemd/journald 收集），同时追加到
// <repo>/miot-data/logs/<name>.log（单文件超过 5 MB 轮转一份 .1）。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ENV_FILE = path.join(ROOT, '.env');
const LOG_MAX = 5 * 1024 * 1024;

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const m = s.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const v = m[2].trim().replace(/^['"]|['"]$/g, '');
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}
loadEnvFile(ENV_FILE);

// 运行期数据（token、storage.json、日志）必须放在升级不会覆盖的位置：
// 默认 <appdata>/var/miot-data，由安装脚本写进 .env 的 FNMUSIC_MIOT_DATA_ROOT。
// 兜底用 repo/miot-data，仅在 .env 缺失时出现。
const DATA_ROOT = process.env.FNMUSIC_MIOT_DATA_ROOT || path.join(ROOT, 'miot-data');
const LOG_DIR = path.join(DATA_ROOT, 'logs');
const DATA_DIR = path.join(DATA_ROOT, 'miot');

fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

// 原生部署下的默认值。.env 里的显式配置优先（loadEnvFile 不会覆盖已有环境变量，
// 但 .env 会写进 process.env，故这里只在「仍为空」时兜底）。
const APPDIR = path.dirname(ROOT);
const defaults = {
  MIOT_HOST: '0.0.0.0',
  MIOT_PORT: '8775',
  MIOT_PUBLIC_PORT: '8775',
  MIOT_DATA_DIR: DATA_DIR,
  MIOT_ENV_FILE: ENV_FILE,
  MIOT_REQUIRE_AUTH: 'true',
  MIOT_UPSTREAM_HOST: '127.0.0.1',
  MIOT_UPSTREAM_PORT: '8775',
  MIOT_TOKEN_FILE: path.join(DATA_DIR, 'token'),
  FNMUSIC_MIOT_SOCKET: path.join(APPDIR, 'fnmusic-miot.sock'),
  FNMUSIC_DB_PATH: '/usr/local/apps/@appdata/trim.music/db/music.db',
};
for (const [k, v] of Object.entries(defaults)) {
  if (!process.env[k]) process.env[k] = v;
}

// 子进程 PATH 必须能找到 python3（token 解析脚本）与 ffprobe 等宿主工具。
process.env.PATH = process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

function rotate(file) {
  try {
    if (fs.statSync(file).size <= LOG_MAX) return;
    fs.renameSync(file, file + '.1');
  } catch { /* 不存在或不可写，忽略 */ }
}

function makeLogger(name) {
  const file = path.join(LOG_DIR, `${name}.log`);
  return (chunk) => {
    const text = chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      if (line) console.log(`[${name}] ${line}`);
    }
    try {
      rotate(file);
      fs.appendFileSync(file, text);
    } catch { /* 磁盘满等，不能因日志拖垮进程 */ }
  };
}

const PROGRAMS = [
  { name: 'miot', entry: path.join(ROOT, 'miot-service', 'host', 'index.mjs'), critical: true },
  { name: 'console', entry: path.join(ROOT, 'nodeconsole', 'server.mjs'), critical: false },
];

const children = new Map();
let stopping = false;

function start(prog) {
  if (stopping) return;
  const out = makeLogger(prog.name);
  const child = spawn(process.execPath, [prog.entry], {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', out);
  child.stderr.on('data', out);

  const started = Date.now();
  const state = { child, restarts: 0, prog };
  children.set(prog.name, state);

  child.on('exit', (code, signal) => {
    children.delete(prog.name);
    if (stopping) return;
    const lived = Date.now() - started;
    state.restarts = lived > 60000 ? 1 : state.restarts + 1;
    const delay = Math.min(30000, 2000 * state.restarts);
    console.log(`[runtime] ${prog.name} 退出 (code=${code} signal=${signal})，${delay}ms 后重启`);
    setTimeout(() => start(prog), delay);
  });

  child.on('error', (err) => {
    console.log(`[runtime] ${prog.name} 启动失败：${err.message}`);
  });
}

for (const prog of PROGRAMS) start(prog);
console.log(`[runtime] fnmusic-miot 已启动 root=${ROOT} node=${process.execPath} (${process.version})`);

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[runtime] 收到 ${signal}，停止子进程`);
  for (const { child } of children.values()) {
    try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
  }
  const deadline = Date.now() + 8000;
  const wait = () => {
    if (children.size === 0 || Date.now() > deadline) {
      for (const { child } of children.values()) {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }
      process.exit(0);
    }
    setTimeout(wait, 100);
  };
  wait();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
