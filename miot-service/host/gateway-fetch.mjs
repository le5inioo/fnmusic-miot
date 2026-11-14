// 专供「飞牛音乐网关」的请求层。
//
// 背景：fnOS 的「强制 HTTPS 连接」会把 HTTP 端口上的请求 301 到独立的 HTTPS
// 端口（默认 5666 → 5667，也可自定义），而该 HTTPS 端口默认使用自签证书。
// 控制层原先全链路假设 http://：
//   - apiCall / login / openStream / cover 用 redirect:'manual'，拿到 301 后
//     按 JSON 解析直接失败（曲库空白）；
//   - normalizeBaseUrl / gateway probeBase 用 redirect:'follow'，跟到 HTTPS 后
//     Node fetch 抛 DEPTH_ZERO_SELF_SIGNED_CERT，连网关发现也全军覆没；
//   - 即使用户上传了正式证书，用 127.0.0.1 访问仍会 CN/SAN 不匹配。
//
// 本模块的处理：
//   1. 仅当目标是「内网网关的 https」时用 node:https 发请求并放宽证书校验；
//      http 与公网 https 一律走 nativeFetch，保持原有证书校验强度。
//   2. 自动吸收网关自身的 301（协议/端口升级），保留全部 headers 重发，
//      并把最终 origin 回调给调用方固化；跳转目标不是 /music/api/v1 时
//      不自动跟随（在线音源的 CDN 302 仍由 openStream 自己处理）。
//   3. 不写死任何端口 / 域名，对任意自定义 HTTP/HTTPS 端口都成立。
//
// 注意：绝不设置 NODE_TLS_REJECT_UNAUTHORIZED=0 —— 同一进程还要连小米云，
// 全局放宽会把公网请求的证书校验一起关掉。

import https from 'node:https';
import os from 'node:os';
import { Readable } from 'node:stream';
import { nativeFetch } from './fetch.mjs';

const API_PATH_PREFIX = '/music/api/v1';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

let cachedLanIps = null;
export function localIPv4s() {
  if (cachedLanIps) return cachedLanIps;
  const out = [];
  for (const list of Object.values(os.networkInterfaces() || {})) {
    for (const item of list || []) {
      if (item && item.family === 'IPv4' && !item.internal && item.address) out.push(item.address);
    }
  }
  cachedLanIps = [...new Set(out)];
  return cachedLanIps;
}

/** 是否属于「本机 / 内网网关」地址。放宽证书只在这个范围内生效。 */
export function isLocalGatewayHost(hostname, lanIps = localIPv4s()) {
  const h = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!h) return false;
  if (LOOPBACK.has(h) || h.startsWith('127.') || h === '::ffff:127.0.0.1') return true;
  if (h.endsWith('.local')) return true; // mDNS 内网域名同样用自签证书
  if (lanIps.includes(h)) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * 由 301 Location 推导新的网关基址（origin）。
 * 强制 HTTPS 常把 Location 写成访问时用的域名；若当前基址是内网直连，
 * 则保留当前 host，只采纳协议与端口，避免 DNS 不可达 / 证书域名不匹配。
 * 用户手填的域名 / 反向代理基址则完整采纳 Location 的 host。
 */
export function resolveRedirectBase(currentBase, location, lanIps = localIPv4s()) {
  if (!location) return null;
  let cur;
  let next;
  try {
    cur = new URL(currentBase);
    next = new URL(String(location), currentBase);
  } catch { return null; }
  if (!/^https?:$/.test(next.protocol)) return null;
  if (cur.protocol === 'https:' && next.protocol === 'http:') return null; // 不允许协议降级
  const curLocal = isLocalGatewayHost(cur.hostname, lanIps);
  const nextLocal = isLocalGatewayHost(next.hostname, lanIps);
  const hostname = curLocal && !nextLocal ? cur.hostname : next.hostname;
  const bracketed = hostname.includes(':') ? `[${hostname.replace(/^\[|\]$/g, '')}]` : hostname;
  const origin = `${next.protocol}//${bracketed}${next.port ? `:${next.port}` : ''}`;
  return origin === cur.origin ? null : origin;
}

function flatHeaders(source) {
  const out = {};
  if (!source) return out;
  if (typeof source.forEach === 'function' && typeof source.get === 'function') {
    source.forEach((v, k) => { out[k] = String(v); });
  } else if (Array.isArray(source)) {
    for (const [k, v] of source) out[k] = String(v);
  } else {
    for (const [k, v] of Object.entries(source)) if (v != null) out[k] = String(v);
  }
  return out;
}

/** 把 IncomingMessage 包装成调用方需要的 fetch Response 形状。 */
function wrapResponse(res, url) {
  const webBody = Readable.toWeb(res);
  let buffered = null;
  const buffer = () => {
    if (!buffered) {
      buffered = (async () => {
        const chunks = [];
        for await (const chunk of webBody) chunks.push(Buffer.from(chunk));
        return Buffer.concat(chunks);
      })();
    }
    return buffered;
  };
  const headerValue = (name) => {
    const v = res.headers[String(name).toLowerCase()];
    if (v === undefined) return null;
    return Array.isArray(v) ? v.join(', ') : String(v);
  };
  const headers = {
    get: headerValue,
    forEach(fn) { for (const [k, v] of Object.entries(res.headers)) fn(Array.isArray(v) ? v.join(', ') : String(v), k); },
    entries() { return Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)]); },
  };
  return {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    statusText: res.statusMessage || '',
    url,
    headers,
    body: webBody,
    arrayBuffer: () => buffer().then((b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)),
    text: () => buffer().then((b) => b.toString('utf8')),
    json: () => buffer().then((b) => JSON.parse(b.toString('utf8'))),
  };
}

/** 内网 HTTPS：只在这里放宽证书校验。 */
function relaxedHttpsFetch(url, init) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };
    let req;
    try {
      req = https.request({
        hostname: u.hostname.replace(/^\[|\]$/g, ''),
        port: Number(u.port) || 443,
        path: `${u.pathname}${u.search}`,
        method: init.method || 'GET',
        headers: flatHeaders(init.headers),
        rejectUnauthorized: false,
        timeout: 15_000,
      }, (res) => {
        settled = true;
        resolve(wrapResponse(res, url));
      });
    } catch (err) { fail(err); return; }

    const signal = init.signal;
    if (signal) {
      if (signal.aborted) { req.destroy(); fail(new Error('aborted')); return; }
      const onAbort = () => req.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      signal.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => signal.removeEventListener('abort', onAbort));
    }
    req.on('timeout', () => req.destroy(new Error('gateway request timeout')));
    req.on('error', fail);
    const body = init.body;
    if (body == null) req.end();
    else if (typeof body === 'string' || Buffer.isBuffer(body)) req.end(body);
    else req.end(String(body));
  });
}

function fetchOnce(url, init) {
  const opts = { ...init, redirect: 'manual' };
  let u;
  try { u = new URL(url); } catch { return nativeFetch(url, opts); }
  if (u.protocol === 'https:' && isLocalGatewayHost(u.hostname)) {
    return relaxedHttpsFetch(url, opts);
  }
  return nativeFetch(url, opts);
}

function attachBase(resp, url) {
  try {
    Object.defineProperty(resp, 'gatewayBase', {
      value: new URL(url).origin, enumerable: false, configurable: true,
    });
  } catch { /* 只读对象，忽略 */ }
  return resp;
}

/**
 * 网关请求入口。自动吸收「网关自身的 301 协议/端口升级」，最多 3 跳。
 * @param {object} options - { onUpgrade?: (origin:string)=>void|Promise<void> }
 * @returns 与 fetch Response 兼容的对象，附带非枚举的 gatewayBase（最终 origin）
 */
export async function gatewayFetch(url, init = {}, options = {}) {
  const { onUpgrade = null, maxHops = 3, lanIps = localIPv4s() } = options;
  let current = String(url);
  for (let hop = 0; hop <= maxHops; hop++) {
    const resp = await fetchOnce(current, init);
    if (resp.status < 300 || resp.status >= 400) return attachBase(resp, current);
    const location = resp.headers.get('location');
    if (!location) return attachBase(resp, current);

    let next;
    let target;
    try { next = new URL(String(location), current); } catch { return attachBase(resp, current); }
    // 只吸收网关自身的跳转；在线音源的 CDN 302 交回 openStream 处理。
    if (!next.pathname.startsWith(API_PATH_PREFIX)) return attachBase(resp, current);
    const newBase = resolveRedirectBase(current, String(location), lanIps);
    if (!newBase) return attachBase(resp, current);
    target = `${newBase}${next.pathname}${next.search}`;
    if (target === current) return attachBase(resp, current);

    current = target;
    if (onUpgrade) await onUpgrade(newBase);
  }
  return attachBase(await fetchOnce(current, init), current);
}

/** 诊断用：当前请求的证书策略说明。 */
export function tlsPolicy(baseUrl) {
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== 'https:') return 'http (no TLS)';
    return isLocalGatewayHost(u.hostname)
      ? 'https-local (self-signed allowed)'
      : 'https-remote (strict verification)';
  } catch { return 'unknown'; }
}
