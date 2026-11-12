// 通用「飞牛音乐网关」发现（宿主级，Node 侧）。
//
// 背景：不同 NAS 的飞牛 HTTP 网关端口各不相同（常见 6688 / 5666 / 51666，
// 也可以是任意自定义端口）。历史实现把 /usr/trim/etc/network_gateway_setting.conf
// 当文本用 sed 找 `schema.http.port`，但该文件实际是 JSON
// （{"schema":{"http":{"port":6688},...}}），正则从未命中，端口永远回落 6688；
// 而 .env 里已写错的值又因为 _miot_env_add「只补缺失」升级时不会被纠正，
// 最终表现为后端连不存在的端口：Errno 111 Connection refused。
//
// 本模块不依赖任何端口白名单，按「配置 → 环境变量 → 本机 LISTEN 端口」三路
// 生成候选，逐个用飞牛音乐的特征端点验证，因此对任意端口都成立：
//   GET /music/api/v1/initialization/state
//   → 200 + application/json + {"code":0,"msg":"","data":{"initialized":true}}
// 只有拿到这个形状的响应才算命中，避免把别的 HTTP 服务误判成网关。
//
// 触发时机：仅当现有基址探测失败时才调用（见 adapter/fnmusic.mjs
// normalizeBaseUrl），能通的用户完全不扫描、行为不变。结果带 15s 缓存，
// 避免网关短暂不可用时反复全扫。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeFetch } from './fetch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// host/ → miot-service/ → repo/
const REPO_ROOT = path.resolve(HERE, '../..');

const PROBE_PATH = '/music/api/v1/initialization/state';
const PROBE_TIMEOUT_MS = 700;
const CONCURRENCY = 10;
const MAX_CANDIDATE_PORTS = 120;
const CACHE_MS = 15_000;
const DEFAULT_CONF = '/usr/trim/etc/network_gateway_setting.conf';

function parsePort(value) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

function uniq(list) {
  return [...new Set(list.filter((v) => v !== null && v !== undefined))];
}

/** 本机所有非回环 IPv4（网关可能只绑在 LAN 地址上，不监听 127.0.0.1）。 */
export function localIPv4s() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces() || {})) {
    for (const item of list || []) {
      if (item && item.family === 'IPv4' && !item.internal && item.address) out.push(item.address);
    }
  }
  return uniq(out);
}

/**
 * 从 fnOS 网关配置取端口。同时兼容：
 *   - JSON：{"schema":{"http":{"port":6688},"https":{"port":6689}},...}
 *   - 老式文本：schema.http.port=5666 / http_port: 51666
 * 返回按可信度排序的端口列表（http 优先、https 次之、其余按出现顺序）。
 */
export function confPorts(confPath = process.env.FNMUSIC_GATEWAY_CONF || DEFAULT_CONF) {
  let text = '';
  try { text = fs.readFileSync(confPath, 'utf8'); } catch { return { ports: [], readable: false, path: confPath }; }
  const ports = [];
  try {
    const j = JSON.parse(text);
    const httpPort = parsePort(j?.schema?.http?.port);
    const httpsPort = parsePort(j?.schema?.https?.port);
    if (httpPort) ports.push(httpPort);
    if (httpsPort) ports.push(httpsPort);
    const walk = (node, depth = 0) => {
      if (!node || typeof node !== 'object' || depth > 6) return;
      for (const [k, v] of Object.entries(node)) {
        if (/port/i.test(k) && typeof v === 'number') {
          const p = parsePort(v);
          if (p) ports.push(p);
        } else if (v && typeof v === 'object') {
          walk(v, depth + 1);
        }
      }
    };
    walk(j);
  } catch { /* 非 JSON，交给下面的文本正则 */ }
  // 无条件再跑一遍正则：JSON 文本同样能命中，且能覆盖未来改版后新增的键名。
  for (const m of text.matchAll(/[A-Za-z0-9_.-]*port[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?(\d{2,5})/gi)) {
    const p = parsePort(m[1]);
    if (p) ports.push(p);
  }
  return { ports: uniq(ports).filter((p) => p >= 1024).slice(0, 20), readable: true, path: confPath };
}

/** /proc/net/tcp{,6} 中所有 LISTEN(0A) 端口。 */
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
      if (Number.isInteger(port) && port >= 1024) out.add(port);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** 单个候选：拿到飞牛音乐特征响应才算命中。 */
async function probeBase(host, port) {
  const base = `http://${host}:${port}`;
  try {
    const r = await nativeFetch(base + PROBE_PATH, {
      redirect: 'follow',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
    if (r.status !== 200 && r.status !== 401 && r.status !== 403) return null;
    if (!/json/i.test(r.headers.get('content-type') || '')) return null;
    const body = await r.text();
    let parsed;
    try { parsed = JSON.parse(body); } catch { return null; }
    if (!parsed || typeof parsed !== 'object' || !('code' in parsed)) return null;
    return base;
  } catch {
    return null;
  }
}

/** 分批并发探测，命中即返回（不等待同批剩余请求）。 */
async function firstHit(pairs, source, counter) {
  for (let i = 0; i < pairs.length; i += CONCURRENCY) {
    const batch = pairs.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async ({ host, port }) => {
      counter.tried += 1;
      const base = await probeBase(host, port);
      return base ? { baseUrl: base, host, port } : null;
    }));
    const hit = results.find(Boolean);
    if (hit) return { ...hit, source };
  }
  return null;
}

/** 原子替换 .env 中若干键，保留其余行 / 注释 / 顺序。 */
function writeEnvKeys(envFile, raw, updates) {
  const seen = new Set();
  const lines = raw.split(/\r?\n/).map((line) => {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && Object.prototype.hasOwnProperty.call(updates, m[1])) {
      seen.add(m[1]);
      return `${m[1]}=${updates[m[1]]}`;
    }
    return line;
  });
  for (const [k, v] of Object.entries(updates)) if (!seen.has(k)) lines.push(`${k}=${v}`);
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  const tmp = `${envFile}.gateway.tmp`;
  fs.writeFileSync(tmp, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o644 });
  fs.renameSync(tmp, envFile);
}

function envValue(raw, key) {
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && m[1] === key) return m[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return '';
}

/**
 * 判断 .env 里的 FNMUSIC_BASE_URL 是否是「脚本自动生成」的地址。
 * 自动生成 = http(s) + 回环或本机任一 IPv4 + 端口，无路径 / 查询 / userinfo。
 * 用户手填的域名、反向代理地址、带路径的地址一律视为自定义，绝不覆盖。
 */
function isAutoGenerated(value, lanIps) {
  if (!value) return true;
  let u;
  try { u = new URL(value); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  if (u.username || u.password || u.search || u.hash) return false;
  if (u.pathname && u.pathname !== '/') return false;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || lanIps.includes(host);
}

/** 诊断用：去掉 URL 里可能存在的 userinfo，其余保留（内网地址不算敏感）。 */
function redact(value) {
  if (!value) return '(未设置)';
  try {
    const u = new URL(value);
    if (u.username || u.password) return `${u.protocol}//***@${u.host}${u.pathname}`;
    return value;
  } catch { return value; }
}

export function createGatewayDiscovery({ cfg, log = console }) {
  const lanIps = localIPv4s();
  const envFile = process.env.MIOT_ENV_FILE || path.join(REPO_ROOT, '.env');
  const selfPorts = new Set([
    parsePort(process.env.MIOT_PORT), parsePort(process.env.MIOT_PUBLIC_PORT),
    parsePort(process.env.MIOT_UPSTREAM_PORT), parsePort(process.env.FNMUSIC_MIOT_CONSOLE_PORT),
    8774,
  ].filter(Boolean));

  const state = {
    configured: cfg.fnBaseUrl,
    runtime: cfg.fnBaseUrl,
    persisting: { written: false, reason: 'not-needed' },
    last: null,
    // 每次发现都重新读：运行期用户改了网关端口也能跟上。
    conf: confPorts(),
    listen: listeningPorts(),
  };

  function portPool(conf, listen) {
    const envPort = parsePort(process.env.FNMUSIC_GATEWAY_PORT);
    return uniq([...conf.ports, envPort, ...listen])
      .filter((p) => !selfPorts.has(p))
      .slice(0, MAX_CANDIDATE_PORTS);
  }

  /**
   * 发现可用网关基址。只在现有基址探测失败时调用。
   * @returns {{ok:boolean, baseUrl?:string, host?:string, port?:number,
   *            source?:string, tried:number, elapsedMs:number, cached?:boolean}}
   */
  async function discover({ current, reason = 'base url probe failed' } = {}) {
    const now = Date.now();
    if (state.last && now - state.last.at < CACHE_MS) {
      return { ...state.last.result, cached: true };
    }
    const started = Date.now();
    const counter = { tried: 0 };
    const allHosts = uniq(['127.0.0.1', ...lanIps]);
    const envPort = parsePort(process.env.FNMUSIC_GATEWAY_PORT);
    state.conf = confPorts();
    state.listen = listeningPorts();
    const conf = state.conf;
    const listen = state.listen;
    const pool = portPool(conf, listen);

    // 阶段 1：配置文件里的端口（最可信，通常一次命中）
    // 阶段 2：环境变量指定的端口
    // 阶段 3：本机所有 LISTEN 端口 × 回环（覆盖 conf 缺失 / 改版 / 自定义端口）
    // 阶段 4：同上 × LAN IP（覆盖网关只绑 LAN 地址、不监听回环）
    const phases = [
      { source: 'conf', ports: conf.ports, hosts: allHosts },
      { source: 'env', ports: envPort ? [envPort] : [], hosts: allHosts },
      { source: 'listen-loopback', ports: pool, hosts: ['127.0.0.1'] },
      { source: 'listen-lan', ports: pool, hosts: lanIps },
    ];
    let hit = null;
    for (const phase of phases) {
      if (!phase.ports.length || !phase.hosts.length) continue;
      const pairs = [];
      for (const port of phase.ports) for (const host of phase.hosts) pairs.push({ host, port });
      hit = await firstHit(pairs, phase.source, counter);
      if (hit) break;
    }

    const result = hit
      ? {
        ok: true, baseUrl: hit.baseUrl, host: hit.host, port: hit.port,
        source: hit.source, tried: counter.tried, elapsedMs: Date.now() - started,
      }
      : {
        ok: false, tried: counter.tried, elapsedMs: Date.now() - started,
        reason: `no gateway answered ${PROBE_PATH}`,
      };
    state.last = { at: now, result, reason, current: current || state.runtime };
    if (result.ok) {
      log.info(`[gateway] 发现飞牛网关 ${result.baseUrl} (来源=${result.source}, 探测=${result.tried} 次, ${result.elapsedMs}ms)`);
    } else {
      log.warn(`[gateway] 未发现可用网关（${result.tried} 个候选，conf=${conf.ports.join(',') || '未读到'}，LISTEN=${listen.length} 个）`);
    }
    return result;
  }

  /** 运行时命中后把结果写回 .env，让重启后不必再扫。 */
  function persist(found) {
    if (!found?.ok || !found.baseUrl) return state.persisting;
    state.runtime = found.baseUrl;
    let raw = '';
    try { raw = fs.readFileSync(envFile, 'utf8'); } catch {
      state.persisting = { written: false, reason: 'env-file-unreadable' };
      return state.persisting;
    }
    const cur = envValue(raw, 'FNMUSIC_BASE_URL');
    if (!isAutoGenerated(cur, lanIps)) {
      state.persisting = { written: false, reason: 'user-custom-base-url', current: redact(cur) };
      log.info(`[gateway] 运行时改用 ${found.baseUrl}；.env 中是用户自定义地址，保持不动`);
      return state.persisting;
    }
    try {
      writeEnvKeys(envFile, raw, {
        FNMUSIC_BASE_URL: found.baseUrl,
        FNMUSIC_GATEWAY_PORT: String(found.port),
      });
      state.persisting = { written: true, from: redact(cur) || '(缺失)', to: found.baseUrl, port: found.port };
      log.info(`[gateway] 已把网关基址写回 .env：${redact(cur) || '(缺失)'} → ${found.baseUrl}`);
    } catch (err) {
      state.persisting = { written: false, reason: `write-failed: ${err.message}` };
      log.warn(`[gateway] 写回 .env 失败（不影响本次运行）：${err.message}`);
    }
    return state.persisting;
  }

  /** 诊断导出用：脱敏的环境 / 发现摘要。 */
  function snapshot() {
    return {
      configured: redact(state.configured),
      runtime: redact(state.runtime),
      envGatewayPort: process.env.FNMUSIC_GATEWAY_PORT || '(未设置)',
      confPath: state.conf.path,
      confReadable: state.conf.readable,
      confPorts: state.conf.ports,
      listenPortCount: state.listen.length,
      lanIps,
      selfPorts: [...selfPorts],
      persist: state.persisting,
      lastDiscover: state.last
        ? {
          at: new Date(state.last.at).toISOString(),
          reason: state.last.reason,
          current: redact(state.last.current),
          ...state.last.result,
        }
        : null,
    };
  }

  return { discover, persist, snapshot, state, lanIps };
}
