// FeiNiu Music (trim.music) private API client -- JS port of
// fnmusic-ext/xiaomusic-service/fnmusic_client.py.
//
// The authx signature is the key asset here: it is already fully reverse
// engineered in the downstream fork, so the Node control layer does not need
// to read music.db directly.

import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { gatewayFetch } from '../host/gateway-fetch.mjs';

export const AUTHX_PREFIX = 'NDzZTVxnRKP8Z0jXg1VAMonaG8akvh';
export const AUTHX_KEY = '6D5602D4-A342-4799-A0F0-BB795E7167D0';
export const API_BASE = '/music/api/v1';

// fnmusic-ext 是可选增强：它接管 /var/run/trim_music.socket 后在
// /_ext/healthz 暴露自身健康状态。官方 trim.music 没有这个端点，所以一次
// 本机 unix-socket 探测就能区分「扩展在位」与「纯官方模式」，不依赖网关
// 是否放行该路径，也不需要在包里带任何 ext 的代码。
const EXT_PROBE_TTL_MS = 60_000;
const EXT_PROBE_SOCKET = process.env.FNMUSIC_TRIM_SOCKET || '/var/run/trim_music.socket';

function probeExtOnce() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    let req;
    try {
      req = http.request({
        socketPath: EXT_PROBE_SOCKET,
        path: '/_ext/healthz',
        method: 'GET',
        timeout: 1200,
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { if (body.length < 512) body += chunk; });
        res.on('end', () => {
          let ok = false;
          try { ok = res.statusCode === 200 && JSON.parse(body)?.ok === true; } catch { /* 官方接口非 JSON */ }
          finish(ok);
        });
        res.on('error', () => finish(false));
      });
      req.on('timeout', () => { req.destroy(); finish(false); });
      req.on('error', () => finish(false));
      req.end();
    } catch {
      finish(false);
    }
  });
}

const md5 = (s) => createHash('md5').update(s).digest('hex');
export const sha256Hex = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');

// Go url.QueryEscape semantics as used by the official web client: keep
// A-Za-z0-9-_.~, percent-encode everything else (space -> %20).
function goQueryEscape(value) {
  let out = '';
  for (const ch of String(value)) {
    if (/^[A-Za-z0-9\-_.~]$/.test(ch)) { out += ch; continue; }
    for (const b of Buffer.from(ch, 'utf8')) {
      out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

export function signAuthx(method, pathname, query, body, nonce, timestamp) {
  const n = nonce || String(100000 + Math.floor(Math.random() * 900000));
  const ts = timestamp || String(Date.now());
  let payload;
  if (String(method).toUpperCase() === 'GET') {
    const parts = [];
    for (const key of Object.keys(query || {}).sort()) {
      const raw = query[key];
      for (const v of (Array.isArray(raw) ? raw : [raw])) {
        parts.push(`${goQueryEscape(key)}=${goQueryEscape(v)}`);
      }
    }
    const encoded = parts.join('&');
    let decoded = encoded;
    try { decoded = decodeURIComponent(encoded); } catch { /* keep encoded bytes */ }
    payload = Buffer.from(decoded, 'utf8');
  } else {
    payload = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '', 'utf8');
  }
  const source = `${AUTHX_PREFIX}_${pathname}_${n}_${ts}_${md5(payload)}_${AUTHX_KEY}`;
  return `nonce=${n}&timestamp=${ts}&sign=${md5(source)}`;
}

function encodeQuery(query) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) {
    for (const item of (Array.isArray(v) ? v : [v])) p.append(k, String(item));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

function pickToken(data) {
  if (!data || typeof data !== 'object') return null;
  for (const k of ['token', 'userToken', 'user_token', 'accessToken', 'access_token']) {
    if (typeof data[k] === 'string' && data[k]) return data[k];
  }
  for (const k of ['data', 'result', 'user']) {
    if (data[k] && typeof data[k] === 'object') {
      const found = pickToken(data[k]);
      if (found) return found;
    }
  }
  return null;
}

class FnMusicError extends Error {
  constructor(message, code, status) { super(message); this.code = code; this.status = status; }
}

// tokenProvider(force) -> Promise<string|null>. On fnOS installs where the
// account is OAuth-created, /user/password-login is unusable (code 120001);
// the host supplies a live `music-token` session read from music.db instead.
// Password login below remains as a fallback for accounts that do have one.
export function createFnMusicClient({
  baseUrl, username, password, tokenProvider = null, log = console,
  // 宿主注入的通用网关发现：仅当现有基址探测失败时调用，能通的用户零开销。
  // 见 host/gateway.mjs（不依赖任何端口白名单，适用于任意自定义网关端口）。
  discoverGateway = null, onGatewayResolved = null,
}) {
  let urlBase = String(baseUrl || 'http://127.0.0.1:5666').replace(/\/$/, '');
  let token = null;
  let useAuthx = true;
  let normalized = false;
  let lastNormAttempt = 0;
  const deviceId = randomBytes(16).toString('hex');

  // 网关请求统一走 gatewayFetch：内网 HTTPS 自签证书定向放行，并自动吸收
  // 「强制 HTTPS」的 301。命中升级时立刻把最终 origin 固化为 urlBase，
  // 同时通知宿主写回 .env，后续请求不再经过一次跳转。
  // 公网请求（含小米云）仍走严格证书校验，不受影响。
  const gatewayOpts = {
    onUpgrade: async (origin) => {
      if (!origin || origin === urlBase) return;
      const previous = urlBase;
      urlBase = origin;
      let port = null;
      try { port = Number(new URL(origin).port) || null; } catch { /* 无端口 */ }
      log.info?.(`[fnmusic] gateway base upgraded ${previous} -> ${origin} (force-https redirect)`);
      try {
        await onGatewayResolved?.({ ok: true, baseUrl: origin, port, source: 'https-redirect' });
      } catch (err) {
        log.warn?.(`[fnmusic] persist upgraded base failed: ${err.message}`);
      }
    },
  };
  const gwFetch = (url, init) => gatewayFetch(url, init, gatewayOpts);

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // 网络层瞬时失败（fetch failed / ECONNREFUSED / ENETUNREACH…）退避重试。
  // 只覆盖「请求没发出去或没收到响应」的失败——HTTP 状态错误会正常返回
  // Response 对象，不会进 catch。典型场景：miot 服务随安装/开机重启时，
  // 飞牛音乐网关链路晚几百毫秒才就绪，首波请求会整体 fetch failed。
  async function fetchRetry(run, { attempts = 3, baseDelayMs = 400 } = {}) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        return await run();
      } catch (err) {
        lastErr = err;
        if (i < attempts - 1) {
          log.warn?.(`[fnmusic] fetch retry ${i + 1}/${attempts - 1}: ${err.message}`);
          await sleep(baseDelayMs * (i + 1));
        }
      }
    }
    throw lastErr;
  }

  // 可选能力：fnmusic-ext 是否在位。结果带 60 秒 TTL，同一时刻只发一个探测，
  // 避免面板每次刷新 /playlists 都去碰一次系统 socket。
  let extAvailable = null;
  let extProbedAt = 0;
  let extInflight = null;

  async function detectExt(force = false) {
    if (!force && extAvailable !== null && Date.now() - extProbedAt < EXT_PROBE_TTL_MS) {
      return extAvailable;
    }
    if (!extInflight) {
      extInflight = probeExtOnce().then((value) => {
        extAvailable = value;
        extProbedAt = Date.now();
        extInflight = null;
        return value;
      });
    }
    return extInflight;
  }

  async function normalizeBaseUrl() {
    if (normalized) return;
    const now = Date.now();
    if (now - lastNormAttempt < 15_000) return; // 失败后 15s 内不重复探测
    lastNormAttempt = now;
    // 老版本 .env 把 FNMUSIC_BASE_URL 写成 LAN IP（本机访问自己的网络
    // 地址要绕经网络栈，网络未就绪时报 Errno 101）。回环地址永远先于
    // 网络就绪，探测可用就自动迁移；不可用（网关只听 LAN）则保持原值。
    try {
      const u = new URL(urlBase);
      const host = u.hostname.toLowerCase();
      const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
      if (!isLoopback && u.port) {
        const loopback = `${u.protocol}//127.0.0.1:${u.port}`;
        const probe = await fetchRetry(
          () => gwFetch(loopback + API_BASE + '/initialization/state'),
          { attempts: 2 },
        );
        // 若回环探测本身就撞上强制 HTTPS 的 301，采纳最终 origin，
        // 不要再把基址写回 http 让后续请求重复跳转。
        const settled = probe.gatewayBase || loopback;
        log.info?.(`[fnmusic] prefer loopback ${urlBase} -> ${settled}`);
        urlBase = settled;
      }
    } catch (err) {
      log.warn?.(`[fnmusic] loopback probe failed, keep ${urlBase}: ${err.message}`);
    }
    try {
      const r = await fetchRetry(
        () => gwFetch(urlBase + API_BASE + '/initialization/state'),
      );
      // gatewayFetch 已吸收网关 301 并通过 onUpgrade 固化 urlBase；这里保留
      // 兜底，兼容其它来源的最终地址变化。
      let origin = r.gatewayBase;
      if (!origin) { try { origin = new URL(r.url).origin; } catch { origin = null; } }
      if (origin && origin !== urlBase) {
        log.warn?.(`[fnmusic] redirect ${urlBase} -> ${origin}`);
        urlBase = origin;
      }
      normalized = true; // 探测成功才置位；失败保持 false，下次调用重试
    } catch (err) {
      log.warn?.(`[fnmusic] base url probe failed: ${err.message}`);
      // 基址连不上（自定义网关端口、只绑 LAN 地址、或 .env 里遗留的错误值）
      // 时交给宿主做通用发现：配置端口 / 本机 LISTEN 端口 × 回环与所有 LAN IP
      // 逐个用飞牛特征端点验证，任意端口都能命中，不写死 6688/5666/51666。
      if (discoverGateway) {
        try {
          const found = await discoverGateway({ current: urlBase, reason: err.message });
          if (found?.ok && found.baseUrl) {
            const previous = urlBase;
            urlBase = found.baseUrl;
            normalized = true;
            log.info?.(`[fnmusic] gateway switched ${previous} -> ${urlBase} (${found.source})`);
            await onGatewayResolved?.(found);
          }
        } catch (discoverErr) {
          log.warn?.(`[fnmusic] gateway discovery error: ${discoverErr.message}`);
        }
      }
    }
  }

  async function login(force = false) {
    if (token && !force) return token;
    await normalizeBaseUrl();
    if (tokenProvider) {
      const before = urlBase;
      try {
        const supplied = await tokenProvider(force);
        if (supplied) {
          token = supplied;
          return token;
        }
      } catch (err) {
        log.warn?.(`[fnmusic] token provider: ${err.message}`);
      }
      // token 解析失败常见于网络未就绪；此时 normalizeBaseUrl 可能刚把
      // 基址从 LAN IP 迁到回环，换链路再试一次。
      await normalizeBaseUrl();
      if (urlBase !== before) {
        try {
          const supplied = await tokenProvider(force);
          if (supplied) {
            token = supplied;
            return token;
          }
        } catch (err) {
          log.warn?.(`[fnmusic] token provider retry: ${err.message}`);
        }
      }
    }
    const path = '/user/password-login';
    const body = JSON.stringify({ username, password: sha256Hex(password), deviceId });
    let lastError = '';
    for (const mode of [useAuthx, !useAuthx]) {
      const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
      if (mode) headers.authx = signAuthx('POST', path, null, Buffer.from(body));
      const r = await fetchRetry(() => gwFetch(urlBase + API_BASE + path, { method: 'POST', headers, body, redirect: 'manual' }), { attempts: 2 });
      let payload;
      try { payload = await r.json(); } catch { lastError = `HTTP ${r.status}`; continue; }
      if (payload?.code === 0) {
        const t = pickToken(payload.data) || pickToken(payload);
        if (t) { token = t; useAuthx = mode; return token; }
        lastError = 'no token in login response';
      } else {
        lastError = `code=${payload?.code} msg=${payload?.msg}`;
      }
    }
    throw new FnMusicError(`login failed: ${lastError}`);
  }

  function apiHeaders(method, path, query, body, includeVersion = true) {
    const h = { Accept: 'application/json' };
    if (includeVersion) h['X-Music-API'] = 'v1';
    if (token) h.Cookie = `music-token=${token}`;
    if (useAuthx) h.authx = signAuthx(method, path, query, body);
    return h;
  }

  async function apiCall(method, path, query = {}, jsonBody = null, retried = false) {
    await login();
    const body = jsonBody == null ? '' : JSON.stringify(jsonBody);
    const headers = apiHeaders(method, path, query, Buffer.from(body));
    if (jsonBody != null) headers['Content-Type'] = 'application/json';
    const r = await fetchRetry(() => gwFetch(urlBase + API_BASE + path + encodeQuery(query), {
      method, headers, body: body || undefined, redirect: 'manual',
    }));
    if ((r.status === 401 || r.status === 403) && !retried) {
      await login(true);
      return apiCall(method, path, query, jsonBody, true);
    }
    let payload;
    try { payload = await r.json(); } catch {
      throw new FnMusicError(`non-JSON response: HTTP ${r.status}`, undefined, r.status);
    }
    if (payload?.code === 120001 && !retried) {
      await login(true);
      return apiCall(method, path, query, jsonBody, true);
    }
    if (payload?.code !== 0) {
      throw new FnMusicError(`API code=${payload?.code} msg=${payload?.msg}`, payload?.code, r.status);
    }
    return payload.data;
  }

  // Returns the RAW native Response (streaming), following 302 manually:
  // same-origin keeps credentials, cross-origin strips them all.
  async function openStream(guid, rangeHeader = null) {
    await login();
    const path = '/track/stream';
    // fnmusic-ext's "direct play" 302s the client straight to the online CDN.
    // Through the fnOS HTTP gateway that URL fails upstream's HTTPS-only
    // validation and the proxy answers 502 `scheme_not_https` -- which is why
    // QQ / netease / kugou / kuwo charts made the speaker say "播放失败".
    // `_ext_hls_stub=1` is the upstream's own switch for its internal proxied
    // stream: it skips the redirect and pushes the audio itself. For local
    // tracks the request is simply forwarded to the official API, which
    // ignores the extra param. Verified: online 200/206 audio/mpeg with Range,
    // local 200/206 unchanged.
    const query = { guid: String(guid), _ext_hls_stub: '1' };
    let current = urlBase + API_BASE + path + encodeQuery(query);
    let headers = {
      Accept: '*/*',
      'X-Music-API': 'v1',
      Cookie: `music-token=${token}`,
      ...(useAuthx ? { authx: signAuthx('GET', path, query, Buffer.alloc(0)) } : {}),
      ...(rangeHeader ? { Range: rangeHeader } : {}),
    };
    for (let hop = 0; hop <= 5; hop++) {
      const r = await fetchRetry(
        () => gwFetch(current, { method: 'GET', headers, redirect: 'manual' }),
        { attempts: 2 },
      );
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get('location');
        if (!loc) throw new FnMusicError('302 without Location');
        const next = new URL(loc, current);
        const cur = new URL(current);
        const same = next.origin === cur.origin;
        headers = same
          ? { ...headers }
          : { Accept: '*/*', 'User-Agent': 'miot-fnos/0.1', ...(rangeHeader ? { Range: rangeHeader } : {}) };
        current = next.toString();
        continue;
      }
      if ((r.status === 401 || r.status === 403) && hop === 0) {
        await login(true);
        headers['Cookie'] = `music-token=${token}`;
        if (useAuthx) headers.authx = signAuthx('GET', path, query, Buffer.alloc(0));
        continue;
      }
      return r;
    }
    throw new FnMusicError('too many redirects');
  }

  // 启动即做一次基址探测/回环迁移，不等首次登录失败才触发。
  void normalizeBaseUrl().catch(() => { /* 已在内部记日志 */ });

  return {
    get baseUrl() { return urlBase; },
    get loggedIn() { return !!token; },
    get token() { return token; },
    get useAuthx() { return useAuthx; },
    detectExt,
    get extAvailable() { return extAvailable; },
    login,
    apiCall,
    openStream,
    signAuthx,
    getTracks: (page = 1, size = 200) => apiCall('GET', '/track/list', { page, size }),
    getTrackMeta: (guid) => apiCall('GET', '/track/metadata', { guid }),
    getPlaylists: (page = 1, size = 200) => apiCall('GET', '/playlist/list', { page, size }),
    getPlaylistDetail: (id) => apiCall('GET', '/playlist/detail', { id }),
    // fnOS 1.2.x 官方前端用 playlistGUID（不是 playlistId）。传错参数时官方返回
    // code=100002 invalid arguments，歌单歌曲列表会整页空白。上游 proxy 注入的
    // "online:" 虚拟歌单同样只认 playlistGUID。
    getPlaylistTracks: (id, page = 1, size = 500) =>
      apiCall('GET', '/track/playlist-detail/list', { playlistGUID: id, page, size }),
    // 飞牛音乐「音乐库」视图。/track/list 不认任何路径过滤参数，因此按目录
    // 取歌由 adapter/songs.mjs 用 audioSpec.path 前缀完成。文件夹视图已不再
    // 暴露给下拉（内容与所属音乐库重复），接口定义保留备用。
    getSharedLibraries: () => apiCall('GET', '/shared-library/list', {}),
    getFolderView: (parentPath, sort = 'title,asc') =>
      apiCall('GET', '/folder-view/list', { parentPath, sort }),
    search: (q, size = 20) => apiCall('GET', '/search/track', { q, page: 1, size }),
    getFavorites: (page = 1, size = 500) =>
      apiCall('GET', '/favorite-track/list', { sort: 'favoriteAt,desc', page, size }),
    addFavorite: (guid) => apiCall('POST', '/favorite-track/create', {}, { trackGUID: guid }),
    removeFavorite: (guid) => apiCall('POST', '/favorite-track/delete', {}, { trackGUID: guid }),
    addPlaylistTracks: (id, guids) => apiCall('POST', '/playlist/add-track', {}, { playlistId: id, trackGUIDs: guids }),
    removePlaylistTracks: (id, guids) => apiCall('POST', '/playlist/remove-track', {}, { playlistId: id, trackGUIDs: guids }),
    createPlaylist: (name) => apiCall('POST', '/playlist/create', {}, { name }),
    deletePlaylist: (id) => apiCall('POST', '/playlist/delete', {}, { playlistId: id }),
    getLyric: (guid) => apiCall('GET', '/lyric/list', { guid }),
    getCover: (coverId) => apiCall('GET', '/static/cover', { coverId }),
  };
}

export { FnMusicError };
