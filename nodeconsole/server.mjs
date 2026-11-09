#!/usr/bin/env node
// fnmusic-miot 控制台网关（零依赖 Node 实现，替代原 FastAPI + uvicorn 版 webui）。
//
// 职责与容器版完全一致：
//   1. 监听 fnOS 桌面网关 socket（<应用目录>/fnmusic-miot.sock，mode 0666）与
//      TCP 8776（局域网直连），两者共用同一套路由；
//   2. 网关转发进来的路径带 /app/fnmusic-miot 前缀，这里先剥掉；
//   3. /health、/console 本地处理；其余全部反代给控制层（默认 127.0.0.1:8775）
//      并在服务端注入 Authorization，浏览器无需持有 token；
//   4. WebSocket 握手用裸 socket 透传，token 同时放进 query 的 access_token；
//   5. 面板 bundle 里写死的旧基路径 /app/fnmusic-ext/miot 改写成本应用前缀。
//
// 之所以能零依赖：node 内置 http/net/fs 足够；WS 不需要 ws 包，直接把握手
// 请求重新写给上游然后双向 pipe 即可（不做帧解析）。

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(HERE, 'static');

const PREFIX = '/app/fnmusic-miot';

const UPSTREAM_HOST = process.env.MIOT_UPSTREAM_HOST || '127.0.0.1';
const UPSTREAM_PORT = Number(process.env.MIOT_UPSTREAM_PORT || 8775);

const TCP_HOST = process.env.FNMUSIC_MIOT_CONSOLE_HOST || '0.0.0.0';
const TCP_PORT = Number(process.env.FNMUSIC_MIOT_CONSOLE_PORT || 8776);
const SOCKET_PATH = (process.env.FNMUSIC_MIOT_SOCKET || '').trim();

const TOKEN_ENV = (process.env.MIOT_TOKEN || '').trim();
const TOKEN_FILE = (process.env.MIOT_TOKEN_FILE || '').trim();

const PANEL_OLD = Buffer.from('/app/fnmusic-ext/miot');
const PANEL_NEW = Buffer.from(PREFIX);

// 只回传这些响应头：hop-by-hop 头（connection/transfer-encoding 等）由 Node 自理，
// 其余（set-cookie、content-encoding…）面板用不到，透传反而会破坏流式/缓冲逻辑。
const SAFE_HEADERS = new Set([
  'content-type', 'content-range', 'accept-ranges', 'cache-control',
  'etag', 'last-modified', 'content-disposition', 'x-accel-buffering',
  'location',
]);

function log(msg) {
  console.log(`[console] ${msg}`);
}

// ---------------------------------------------------------------------------
// token：与控制层共享。env 优先，其次读控制层持久化到数据目录的 token 文件。
// 每次读都检查 mtime，控制层重建 token 后本进程无需重启即可跟上。
// ---------------------------------------------------------------------------
let tokenCache = '';
let tokenMtime = -1;

function token() {
  if (TOKEN_ENV) return TOKEN_ENV;
  if (!TOKEN_FILE) return '';
  try {
    const st = fs.statSync(TOKEN_FILE);
    if (st.mtimeMs !== tokenMtime) {
      tokenCache = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
      tokenMtime = st.mtimeMs;
    }
    return tokenCache;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// 路径归一：剥掉桌面网关前缀（保留 query）。
// ---------------------------------------------------------------------------
function stripPrefix(rawUrl) {
  let url = rawUrl || '/';
  if (url === PREFIX || url === PREFIX + '/') return '/';
  if (url.startsWith(PREFIX + '/')) url = url.slice(PREFIX.length);
  else if (url.startsWith(PREFIX + '?')) url = '/' + url.slice(PREFIX.length);
  return url;
}

function splitUrl(url) {
  const i = url.indexOf('?');
  return i < 0 ? { path: url, query: '' } : { path: url.slice(0, i), query: url.slice(i + 1) };
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function safeHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (SAFE_HEADERS.has(k.toLowerCase()) && v != null) out[k] = v;
  }
  return out;
}

function bufferReplaceAll(buf, needle, repl) {
  if (needle.length === 0 || buf.indexOf(needle) < 0) return buf;
  const parts = [];
  let from = 0;
  for (;;) {
    const at = buf.indexOf(needle, from);
    if (at < 0) { parts.push(buf.subarray(from)); break; }
    parts.push(buf.subarray(from, at), repl);
    from = at + needle.length;
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// HTTP 反代
// ---------------------------------------------------------------------------
function proxyHttp(req, res, relUrl) {
  const { path: relPath } = splitUrl(relUrl);
  // 注意 relPath 带前导斜杠（/static/js/app.js），与 FastAPI 的 path 参数不同。
  const bare = relPath.startsWith('/') ? relPath.slice(1) : relPath;
  const rewrite = req.method === 'GET' && bare.startsWith('static/js/') && bare.endsWith('.js');

  const headers = { ...req.headers };
  delete headers.host;
  delete headers.authorization;
  delete headers['content-length'];
  // 上游统一不回压缩：既省掉解压，也保证 bundle 改写能按字节替换。
  delete headers['accept-encoding'];

  const t = token();
  if (t) headers.authorization = `Bearer ${t}`;

  let settled = false;
  const up = http.request({
    host: UPSTREAM_HOST,
    port: UPSTREAM_PORT,
    method: req.method,
    path: relUrl,
    headers,
  });

  up.setTimeout(30000, () => {
    up.destroy(new Error('上游 30s 无响应'));
  });

  up.on('response', (ur) => {
    up.setTimeout(0); // 头已到，后续可能是长连接音视频流，取消空闲超时
    settled = true;

    if (!rewrite) {
      res.writeHead(ur.statusCode || 502, safeHeaders(ur.headers));
      ur.pipe(res);
      ur.on('error', () => res.destroy());
      res.on('close', () => ur.destroy());
      return;
    }

    const chunks = [];
    ur.on('data', (c) => chunks.push(c));
    ur.on('error', () => {
      if (!res.headersSent) sendJson(res, 502, { ok: false, error: '上游读取中断' });
      else res.destroy();
    });
    ur.on('end', () => {
      let body = Buffer.concat(chunks);
      const before = body.length;
      body = bufferReplaceAll(body, PANEL_OLD, PANEL_NEW);
      const out = safeHeaders(ur.headers);
      delete out['content-encoding'];
      out['content-length'] = String(body.length);
      out['cache-control'] = 'no-cache';
      res.writeHead(ur.statusCode || 200, out);
      res.end(body);
      if (before !== body.length) {
        log(`bundle 基路径已改写 ${relPath} (${before} → ${body.length} B)`);
      }
    });
  });

  up.on('error', (err) => {
    if (settled) {
      if (!res.headersSent) sendJson(res, 502, { ok: false, error: `音箱控制台不可达：${err.message}` });
      else res.destroy();
      return;
    }
    if (!res.headersSent) {
      sendJson(res, 503, { ok: false, error: `音箱控制台不可达：${err.message}` });
    }
  });

  req.on('aborted', () => up.destroy());
  req.pipe(up);
}

// ---------------------------------------------------------------------------
// WebSocket 反代：不做帧解析，改写握手请求后双向 pipe。
// ---------------------------------------------------------------------------
function proxyUpgrade(req, socket, head) {
  const rel = stripPrefix(req.url);
  const { path: relPath, query } = splitUrl(rel);

  const params = new URLSearchParams(query);
  const t = token();
  if (t && !params.has('access_token')) params.set('access_token', t);
  const qs = params.toString();
  const target = relPath + (qs ? '?' + qs : '');

  const lines = [`GET ${target} HTTP/1.1`, `Host: ${UPSTREAM_HOST}:${UPSTREAM_PORT}`];
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (lk === 'host' || lk === 'authorization') continue;
    if (Array.isArray(v)) for (const item of v) lines.push(`${k}: ${item}`);
    else lines.push(`${k}: ${v}`);
  }
  if (t) lines.push(`Authorization: Bearer ${t}`);

  const up = net.connect(UPSTREAM_PORT, UPSTREAM_HOST, () => {
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });

  const kill = () => {
    up.destroy();
    socket.destroy();
  };
  up.on('error', kill);
  socket.on('error', kill);
  socket.setTimeout(0);
  log(`ws 升级 ${relPath}`);
}

// ---------------------------------------------------------------------------
// 主处理
// ---------------------------------------------------------------------------
function handle(req, res) {
  const rel = stripPrefix(req.url);
  const { path: relPath } = splitUrl(rel);

  if (relPath === '/health') {
    sendJson(res, 200, { ok: true, uptime: Math.round(process.uptime()) });
    return;
  }

  if (relPath === '/console' || relPath === '/console/' || relPath === '/console/index.html') {
    fs.readFile(path.join(STATIC_DIR, 'console.html'), (err, data) => {
      if (err) {
        sendJson(res, 500, { ok: false, error: `控制台页面缺失：${err.message}` });
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(data.length),
        'cache-control': 'no-cache',
      });
      res.end(data);
    });
    return;
  }

  proxyHttp(req, res, rel);
}

function attach(server, label) {
  server.on('request', handle);
  server.on('upgrade', proxyUpgrade);
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  server.on('error', (err) => {
    log(`ERROR ${label}: ${err.code || err.message}`);
    process.exit(1);
  });
  return server;
}

const tcpServer = attach(http.createServer(), `tcp ${TCP_HOST}:${TCP_PORT}`);
const servers = [tcpServer];

tcpServer.listen(TCP_PORT, TCP_HOST, () => {
  log(`TCP 已监听 ${TCP_HOST}:${TCP_PORT} → ${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
});

if (SOCKET_PATH) {
  // 陈旧 socket 文件会挡住 bind；先清掉（除非真有进程在听，那说明重复启动）。
  try {
    const st = fs.lstatSync(SOCKET_PATH);
    if (st.isSocket()) fs.unlinkSync(SOCKET_PATH);
    else fs.unlinkSync(SOCKET_PATH);
  } catch { /* 不存在，正常 */ }

  const sockServer = attach(http.createServer(), `socket ${SOCKET_PATH}`);
  servers.push(sockServer);
  sockServer.listen(SOCKET_PATH, () => {
    try {
      fs.chmodSync(SOCKET_PATH, 0o666); // fnOS 网关以其他 uid 连接
      log(`socket 已监听 ${SOCKET_PATH} (0666)`);
    } catch (err) {
      log(`WARN chmod socket 失败：${err.message}`);
    }
  });
}

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  log(`收到 ${signal}，关闭监听`);
  let left = servers.length;
  const done = () => { if (--left <= 0) process.exit(0); };
  for (const s of servers) {
    s.close(done);
    try { s.closeAllConnections?.(); } catch { /* Node <18.2 */ }
  }
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

log(`就绪 prefix=${PREFIX} token=${token() ? token().slice(0, 6) + '…' : '(未就绪)'}`);
