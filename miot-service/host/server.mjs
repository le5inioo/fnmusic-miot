// Node HTTP + WebSocket server that drives the five Songloft lifecycle hooks.
//
//   onInit()                     -> called once before listen
//   onHTTPRequest(req)           -> REST (SDK createRouter, 95 routes)
//   onWebSocket(req, socket)     -> /status/ws, /conversation/ws, /chat/ws
//   onDeinit()                   -> graceful shutdown
//   onQueryBusy()                -> unused (no host hot-reload)
//
// It also owns three things the host used to provide: static hosting for the
// Vue panel, the /api/v1/songs/:id/play stream endpoint, and the legacy
// /health + /sync + /play compatibility surface for fnmusic-ext's WebUI.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// `ws` is the only runtime dependency left (the SDK and pako are inlined into
// bundle/main.js by esbuild). A vendored copy ships inside the fpk so the
// image never has to reach the npm registry; fall back to a normal install
// for local development.
const require = createRequire(import.meta.url);
let WebSocketServer;
try {
  ({ WebSocketServer } = require('../vendor/ws'));
} catch {
  ({ WebSocketServer } = await import('ws'));
}

const PLUGIN_PREFIXES = [
  '/app/fnmusic-ext/api/v1/jsplugin/miot',
  '/api/v1/jsplugin/miot',
];

const STATIC_RE = /^\/(index\.html|favicon\.ico|icon\.svg|static\/.+|js\/.+|css\/.+|assets\/.+)$/;

class InboundSocket {
  constructor(ws, id) {
    this.id = id;
    this.CONNECTING = 0; this.OPEN = 1; this.CLOSING = 2; this.CLOSED = 3;
    this._ws = ws;
    this._handlers = { message: [], close: [], error: [] };
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;

    ws.on('message', (data, isBinary) => {
      const event = {
        type: 'message',
        target: this,
        data: isBinary ? new Uint8Array(data) : String(data),
        isBinary: !!isBinary,
      };
      this._emit('message', event);
    });
    ws.on('close', (code, reason) => {
      this._emit('close', {
        type: 'close', target: this, code,
        reason: reason?.toString?.() || '', wasClean: code === 1000,
      });
    });
    ws.on('error', (err) => {
      this._emit('error', { type: 'error', target: this, message: err?.message || String(err) });
    });
  }

  get readyState() { return this._ws.readyState; }

  _emit(type, event) {
    const named = { message: 'onmessage', close: 'onclose', error: 'onerror' }[type];
    const all = [...(this._handlers[type] || [])];
    if (typeof this[named] === 'function') all.push(this[named]);
    for (const h of all) {
      Promise.resolve().then(() => h(event)).catch(() => {});
    }
  }

  send(data) {
    return new Promise((resolve, reject) => {
      if (this._ws.readyState !== 1) return reject(new Error('websocket not open'));
      this._ws.send(data, (err) => err ? reject(err) : resolve());
    });
  }
  close(code = 1000, reason = '') {
    return new Promise((resolve) => {
      try { this._ws.close(code, reason); } catch { /* already closed */ }
      resolve();
    });
  }
  onMessage(h) { this._handlers.message.push(h); }
  onClose(h) { this._handlers.close.push(h); }
  onError(h) { this._handlers.error.push(h); }
  addEventListener(type, h) { (this._handlers[type] ||= []).push(h); }
  removeEventListener(type, h) {
    this._handlers[type] = (this._handlers[type] || []).filter((x) => x !== h);
  }
}

function collectBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    // Decode here, as UTF-8 text, not as a byte array. The Go host used to
    // hand the plugin a []byte; several parseBody() copies in the bundle do
    // `String.fromCharCode.apply(null, bytes)`, which treats each UTF-8 byte
    // as a Latin-1 code point and turns every Chinese string in a POST body
    // into mojibake *before it is written to storage*. Handing them a string
    // takes the `typeof req.body === "string"` branch in all of them, so the
    // fix covers every handler at once. Empty bodies stay null.
    req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks).toString('utf8') : null));
    req.on('error', () => resolve(null));
  });
}

function flatHeaders(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) {
    out[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
  }
  return out;
}

function resolveStatic(staticDir, pathname) {
  let p = pathname;
  if (p === '/miot' || p.startsWith('/miot/')) p = p.slice('/miot'.length) || '/';
  if (p === '/') p = '/index.html';
  if (!STATIC_RE.test(p)) return null;
  // Vite emits <staticDir>/js/app.js and <staticDir>/css/style.css, but the
  // generated index.html references "static/js/app.js" (the Songloft host
  // mounted the panel under a /static/ URL prefix). Try both layouts so the
  // same bundle works behind our /miot/* proxy and on a bare control-port URL.
  const root = path.resolve(staticDir);
  for (const q of [p.replace(/^\/static\//, '/'), p]) {
    const full = path.resolve(root, '.' + q);
    if (!full.startsWith(root)) continue;
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
  }
  return null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

function stripPluginPrefix(pathname) {
  for (const p of PLUGIN_PREFIXES) {
    if (pathname === p) return '/';
    if (pathname.startsWith(p + '/')) return pathname.slice(p.length);
  }
  return pathname;
}

function authorized(req, url, cfg) {
  if (!cfg.requireAuth) return true;
  const h = req.headers.authorization || '';
  const token = url.searchParams.get('access_token') || h.replace(/^Bearer\s+/i, '');
  return token === cfg.token;
}

function attachStream(res, result) {
  if (typeof result.onClose === 'function') res.once('close', result.onClose);
}

// XiaoAI firmware swallows the "&" separating query parameters in a play URL
// and appends the following "k=v" onto the access_token value, causing a 401.
// URLBuilder therefore encodes playback options into a base64url path segment
// (/o<...>) and leaves access_token as the only query parameter. Decode it
// here and merge into the params the stream handler already understands.
function decodePlayOptions(seg) {
  if (!seg) return {};
  try {
    const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
    const o = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch { return {}; }
}

function mergePlayParams(searchParams, opts) {
  const params = Object.fromEntries(searchParams.entries());
  const map = { s: 'seek', p: 'speed', f: 'format', r: 'radio_transcode', n: 'normalize' };
  for (const [k, name] of Object.entries(map)) {
    if (opts[k] === undefined || params[name] !== undefined) continue;
    if (k === 'n') { if (Number(opts[k])) params[name] = '1'; }
    else params[name] = String(opts[k]);
  }
  return params;
}

// 推流访问日志（[ACCESS]）跟随全局调试开关（diagnostics 状态），不再固定开启；
// 见 host/diagnostics.mjs 与工具箱「调试与诊断」。

export async function startServer({ cfg, streamHandler, coverHandler, lyricHandler, compat, log, diagnostics, ports }) {
  const accessLogEnabled = () => (diagnostics ? diagnostics.accessLogEnabled() : true);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let pathname = url.pathname;
    const queryString = url.search.replace(/^\?/, '');

    try {
      // 1) Legacy fnmusic-ext bridge compatibility (WebUI /api/xiaomusic/*).
      //    /compat/status 是给独立控制台用的只读能力状态（ext 可选增强标志），
      //    走 nodeconsole 的常规反代，令牌由它注入。
      if (pathname === '/health' || pathname === '/healthz' || pathname === '/sync'
          || pathname === '/compat/status' || pathname === '/compat/library-search') {
        const result = await compat.handle(pathname, req, url);
        res.writeHead(result.statusCode || 200, result.headers || { 'Content-Type': 'application/json' });
        res.end(result.body ?? '');
        return;
      }

      // 2) Audio stream endpoints (the speaker only fetches a bare HTTP URL).
      //    /play?guid= is the old bridge URL; /api/v1/songs/:id/play is the
      //    Songloft host contract produced by URLBuilder.buildSongURL().
      const legacyPlay = pathname === '/play' && url.searchParams.has('guid');
      const songPlay = pathname.match(/^\/(?:api\/v1\/)?songs\/(\d+)\/play(?:\/o([A-Za-z0-9_-]+))?$/);
      if (legacyPlay || songPlay) {
        const idOrGuid = legacyPlay ? url.searchParams.get('guid') : songPlay[1];
        const playParams = songPlay
          ? mergePlayParams(url.searchParams, decodePlayOptions(songPlay[2]))
          : Object.fromEntries(url.searchParams.entries());
        const __t0 = Date.now();
        const __tok = url.searchParams.get('access_token') || '';
        if (accessLogEnabled()) console.log(`[ACCESS] in id=${idOrGuid} method=${req.method} seek=${playParams.seek || 0} fmt=${playParams.format || ''} range=${req.headers.range || '-'} from=${req.socket.remoteAddress} ua=${String(req.headers['user-agent'] || '').slice(0, 24)} tokenLen=${__tok.length} tokenOk=${__tok === cfg.token}`);
        if (!authorized(req, url, cfg)) {
          if (accessLogEnabled()) console.log(`[ACCESS] DENY 401 id=${idOrGuid}`);
          res.writeHead(401); res.end('unauthorized'); return;
        }
        const result = await streamHandler({
          id: idOrGuid,
          range: req.headers.range || null,
          params: playParams,
          method: req.method,
        });
        if (accessLogEnabled()) {
          const __h = result.headers || {};
          console.log(`[ACCESS] out id=${idOrGuid} status=${result.statusCode} CL=${__h['content-length'] || '-'} CR=${__h['content-range'] || '-'} AR=${__h['accept-ranges'] || '-'} probeMs=${Date.now() - __t0}`);
        }
        res.writeHead(result.statusCode, result.headers);
        if (req.method === 'HEAD') { attachStream(res, result); res.end(); return; }
        attachStream(res, result);
        if (result.stream) {
          // The speaker abandons a stream on every skip/seek. Without this
          // handler undici's "other side closed" becomes an unhandled 'error'
          // event on the Readable and can take down the whole process.
          result.stream.on('error', (err) => {
            if (!res.writableEnded) res.destroy();
            if (accessLogEnabled()) console.log(`[ACCESS] stream closed id=${idOrGuid}: ${err.message}`);
          });
          result.stream.pipe(res);
        } else res.end(result.body ?? '');
        return;
      }

      // Lyric loopback: handlers/lyric.ts calls callHostAPI() which resolves to
      // plugin.getHostUrl() = this server. Serve it or the panel shows 502.
      const lyricMatch = pathname.match(/^\/(?:api\/v1\/)?songs\/(\d+)\/lyric$/);
      if (lyricMatch) {
        if (!authorized(req, url, cfg)) { res.writeHead(401); res.end('unauthorized'); return; }
        const result = await lyricHandler({ id: lyricMatch[1] });
        res.writeHead(result.statusCode, result.headers || { 'Content-Type': 'application/json' });
        res.end(result.body ?? '');
        return;
      }

      // 2b) Cover proxy: the official /static/cover is authx-signed, so the
      //     browser fetches it through us instead of hitting fnOS directly.
      const coverMatch = pathname.match(/^\/(?:api\/v1\/)?songs\/(\d+)\/cover$/);
      if (coverMatch) {
        const result = await coverHandler({ id: coverMatch[1] });
        res.writeHead(result.statusCode, result.headers || {});
        if (result.stream) result.stream.pipe(res); else res.end(result.body ?? '');
        return;
      }

      // 2d) 诊断端点（宿主级，Node 直接处理，不走插件 QuickJS）：
      //     GET  /diagnostics/logs     导出运行日志（text/plain 附件）
      //     POST /diagnostics/debug-mode  同步全局调试开关（门控 [ACCESS] 日志）
      //     控制台网关会把 /app/fnmusic-miot/* 反代到这里并注入 token。
      if (pathname === '/diagnostics/debug-mode' && diagnostics) {
        if (!authorized(req, url, cfg)) { res.writeHead(401); res.end('unauthorized'); return; }
        if (req.method !== 'POST') { res.writeHead(405, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'method not allowed' })); return; }
        try {
          const raw = await collectBody(req);
          const body = raw ? JSON.parse(raw) : {};
          diagnostics.setDebugMode(!!body.enabled);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, enabled: diagnostics.accessLogEnabled() }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err?.message || err) }));
        }
        return;
      }
      if (pathname === '/diagnostics/logs' && diagnostics) {
        if (!authorized(req, url, cfg)) { res.writeHead(401); res.end('unauthorized'); return; }
        if (req.method !== 'GET') { res.writeHead(405, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'method not allowed' })); return; }
        const result = await diagnostics.exportLogs({ lines: url.searchParams.get('lines') });
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="${diagnostics.attachmentName()}"`,
          'Cache-Control': 'no-store',
        });
        res.end(result.body);
        return;
      }

      // 2e) 服务端口设置与首次安装/升级引导（宿主级，Node 直接处理）：
      //     GET  /ports/config      当前端口与 pending 状态
      //     GET  /ports/suggest     探测两个可用的随机端口
      //     POST /ports/apply       写 .env + 延迟重启服务
      //     POST /ports/setup-done  只清除引导标记
      //     控制台网关会剥掉 /app/fnmusic-miot 前缀并注入 token。
      if (ports && pathname.startsWith('/ports/')) {
        if (!authorized(req, url, cfg)) { res.writeHead(401); res.end('unauthorized'); return; }
        const sendJson = (code, payload) => {
          res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify(payload));
        };
        try {
          if (pathname === '/ports/config' && req.method === 'GET') {
            sendJson(200, ports.config());
            return;
          }
          if (pathname === '/ports/suggest' && req.method === 'GET') {
            sendJson(200, await ports.suggest());
            return;
          }
          if (pathname === '/ports/apply' && req.method === 'POST') {
            const raw = await collectBody(req);
            sendJson(200, await ports.apply(raw ? JSON.parse(raw) : {}));
            return;
          }
          if (pathname === '/ports/setup-done' && req.method === 'POST') {
            sendJson(200, ports.setupDone());
            return;
          }
          sendJson(405, { error: 'method not allowed' });
        } catch (err) {
          sendJson(400, { error: String(err?.message || err) });
        }
        return;
      }

      // 3) Vue panel static assets (served behind the fnOS同源 gateway).
      const file = resolveStatic(cfg.staticDir, pathname);
      if (file) {
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
        return;
      }

      // 4) Everything else is the plugin's REST surface.
      if (!authorized(req, url, cfg)) { res.writeHead(401); res.end('unauthorized'); return; }
      const body = await collectBody(req);
      const hreq = {
        method: req.method || 'GET',
        path: stripPluginPrefix(pathname),
        headers: flatHeaders(req.headers),
        body,
        query: queryString,
        remoteAddr: req.socket.remoteAddress || '',
      };

      if (typeof globalThis.onHTTPRequest !== 'function') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'plugin bundle not loaded' }));
        return;
      }
      const hres = await globalThis.onHTTPRequest(hreq);
      const status = hres?.statusCode ?? 200;
      const headers = { ...(hres?.headers || {}) };

      // ServeFileDirective: the Go host used to send files zero-copy.
      if (hres?.serveFile?.filePath) {
        const fp = hres.serveFile.filePath;
        if (fs.existsSync(fp)) {
          res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
          fs.createReadStream(fp).pipe(res);
          return;
        }
      }
      if (hres?.serveFile?.songId != null) {
        const result = await streamHandler({ id: String(hres.serveFile.songId), range: req.headers.range || null, params: {}, method: req.method });
        res.writeHead(result.statusCode, result.headers);
        attachStream(res, result);
        if (result.stream) result.stream.pipe(res); else res.end(result.body ?? '');
        return;
      }

      const payload = hres?.body;
      res.writeHead(status, headers);
      res.end(payload == null ? '' : (typeof payload === 'string' ? payload : Buffer.from(payload)));
    } catch (err) {
      log.error(`[http] ${req.method} ${pathname}: ${err.stack || err.message}`);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err?.message || err) }));
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  let wsSeq = 0;
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (!authorized(req, url, cfg)) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const wsreq = {
        method: 'GET',
        path: stripPluginPrefix(url.pathname),
        headers: flatHeaders(req.headers),
        query: url.search.replace(/^\?/, ''),
        remoteAddr: req.socket.remoteAddress || '',
      };
      const inbound = new InboundSocket(ws, `ws-${++wsSeq}`);
      Promise.resolve(globalThis.onWebSocket?.(wsreq, inbound))
        .catch((err) => log.error(`[ws] ${err.stack || err.message}`));
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, () => { server.off('error', reject); resolve(); });
  });
  log.info(`[server] listening on ${cfg.host}:${cfg.port}`);

  return {
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
