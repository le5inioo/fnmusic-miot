#!/usr/bin/env node
// 挑选两个「当前确实可用」的随机端口。两个调用方共用这一套策略：
//   1. host/ports.mjs 的 GET /ports/suggest（面板「一键填充可用端口」）
//   2. packaging/fpk/cmd/install_callback（首次安装默认端口被占用时自动避让）
//
// 也可直接当 CLI 用：node runtime/pick_ports.mjs → 输出 "控制层端口 控制台端口"。
// 零依赖，只用 node 内置模块。

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

// 避开 Linux 默认 ephemeral 区间（32768~60999），降低被临时连接抢占的概率。
export const RANDOM_MIN = 10000;
export const RANDOM_MAX = 31000;

// 本机已知服务端口：随机分配避开，用户手填时若与之冲突也拒绝。
export const RESERVED_PORTS = new Set([
  20, 21, 22, 23, 25, 53, 80, 110, 143, 443, 445, 993, 995,
  3000, 3306, 5000, 5432, 5666, 6379, 6688, 8000, 8005, 8006,
  8080, 8443, 8768, 8770, 8772, 8774, 9000, 9090,
]);

/** 从 /proc/net/tcp{,6} 取所有 LISTEN(0A) 端口。 */
export function listeningPorts() {
  const out = new Set();
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4 || cols[3] !== '0A') continue;
      const hex = (cols[1] || '').split(':').pop();
      const port = Number.parseInt(hex, 16);
      if (Number.isInteger(port) && port > 0) out.add(port);
    }
  }
  return out;
}

/** 真实 bind 一次，兜住 /proc 看不到的占用。 */
export function canBind(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { srv.close(); } catch { /* already closed */ }
      resolve(ok);
    };
    srv.once('error', () => finish(false));
    try {
      srv.listen({ port, host: '0.0.0.0', exclusive: true }, () => finish(true));
    } catch {
      finish(false);
    }
  });
}

/**
 * 返回两个互不相同、当前空闲的随机端口。
 * @param {{exclude?: number[], extraBusy?: Set<number>}} opts
 */
export async function pickFreePorts(opts = {}) {
  const busy = listeningPorts();
  for (const p of RESERVED_PORTS) busy.add(p);
  for (const p of opts.exclude || []) {
    const n = Number(p);
    if (Number.isInteger(n)) busy.add(n);
  }
  if (opts.extraBusy) for (const p of opts.extraBusy) busy.add(p);

  const picked = [];
  for (let i = 0; i < 240 && picked.length < 2; i += 1) {
    const port = RANDOM_MIN + Math.floor(Math.random() * (RANDOM_MAX - RANDOM_MIN + 1));
    if (busy.has(port) || picked.includes(port)) continue;
    busy.add(port);
    if (await canBind(port)) picked.push(port);
  }
  if (picked.length < 2) {
    throw new Error('未能探测到两个可用端口，请手动填写（1024~65535 且两端口不同）');
  }
  return picked;
}

const isCli = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const exclude = String(process.argv[2] || '')
    .split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
  pickFreePorts({ exclude })
    .then(([control, consolePort]) => { process.stdout.write(`${control} ${consolePort}\n`); })
    .catch((err) => { console.error(err.message); process.exit(1); });
}
