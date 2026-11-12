// Entry point for [program:xiaomusic] in fnmusic-ext's container.
//
// Load order matters: polyfills and globalThis.songloft must exist BEFORE the
// esbuild bundle is imported, because main.ts registers its hooks at module
// top level and ConfigManager may read storage during onInit.

import './crypto.mjs';
import path from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { installHostFetch } from './fetch.mjs';
import { createStorage } from './storage.mjs';
import { installSongloft } from './songloft.mjs';
import { startServer } from './server.mjs';
import { createDiagnostics } from './diagnostics.mjs';
import { createPorts } from './ports.mjs';
import { createGatewayDiscovery } from './gateway.mjs';
import { createFnMusicClient } from '../adapter/fnmusic.mjs';
import { createMusicAdapter } from '../adapter/songs.mjs';
import { createStreamHandler, createCoverHandler, createLyricHandler } from '../adapter/stream.mjs';
import { createCompatHandler } from '../adapter/compat.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const execFileAsync = promisify(execFile);

// fnmusic-ext keeps credentials in /repo/.env (bind-mounted into the container).
function loadEnvFile(file) {
  if (!file || !fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const m = s.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const v = m[2].trim().replace(/^['"]|['"]$/g, '');
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}
loadEnvFile(process.env.MIOT_ENV_FILE);
if (!process.env.FNMUSIC_USERNAME && process.env.FNMUSIC_IMPORT_USERNAME) {
  process.env.FNMUSIC_USERNAME = process.env.FNMUSIC_IMPORT_USERNAME;
}
if (!process.env.FNMUSIC_PASSWORD && process.env.FNMUSIC_IMPORT_PASSWORD) {
  process.env.FNMUSIC_PASSWORD = process.env.FNMUSIC_IMPORT_PASSWORD;
}

const dataDir = process.env.MIOT_DATA_DIR || '/data/miot';
fs.mkdirSync(dataDir, { recursive: true });

// The token is embedded in playback URLs handed to the speaker and is also
// used by the WebUI reverse proxy. It MUST survive restarts, otherwise every
// reboot invalidates every queued song and the panel loses its auth.
// Precedence: explicit env > persisted file > newly generated.
function loadOrCreateToken() {
  if (process.env.MIOT_TOKEN) return process.env.MIOT_TOKEN.trim();
  const file = path.join(dataDir, 'token');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch { /* first boot */ }
  const generated = randomBytes(24).toString('hex');
  fs.writeFileSync(file, generated, { encoding: 'utf8', mode: 0o600 });
  return generated;
}

// Address the speaker must use to fetch /api/v1/songs/:id/play. 127.0.0.1
// would make the speaker call itself, so derive from the NAS LAN IP.
const nasIp = process.env.FNMUSIC_NAS_IP || '';
// 端口以 .env 为唯一数据源：MIOT_PORT 是监听端口，MIOT_PUBLIC_PORT 是音箱
// 回访用的发布端口（自定义端口时由安装脚本一并对齐，不再有 8775 硬编码）。
const listenPort = Number(process.env.MIOT_PORT || 8775);
const publicPort = Number(process.env.MIOT_PUBLIC_PORT || listenPort);
const defaultServerHost = nasIp ? `http://${nasIp}:${publicPort}` : '';

const cfg = {
  host: process.env.MIOT_HOST || '0.0.0.0',
  port: listenPort,
  publicPort,
  dataDir,
  staticDir: path.resolve(process.env.MIOT_STATIC_DIR || path.join(ROOT, 'static')),
  distFile: path.resolve(process.env.MIOT_DIST || path.join(ROOT, 'bundle/main.js')),
  token: loadOrCreateToken(),
  // The control port is published on 0.0.0.0 for the speaker; auth must be ON.
  requireAuth: !/^(0|false|no|off)$/i.test(process.env.MIOT_REQUIRE_AUTH || 'true'),
  serverHost: (process.env.MIOT_SERVER_HOST || defaultServerHost).replace(/\/$/, ''),
  forceServerHost: /^(1|true|yes|on)$/i.test(process.env.MIOT_SERVER_HOST_FORCE || ''),
  // FeiNiu Music gateway. 端口因 NAS 而异（6688 / 5666 / 51666 / 任意自定义），
  // 所以这里只是「首次启动的初始猜测」：FNMUSIC_BASE_URL > FNMUSIC_GATEWAY_PORT
  // > 6688。真正兜底在 host/gateway.mjs —— 现有基址探测失败时会按配置 +
  // 本机 LISTEN 端口 × 回环/所有 LAN IP 自动发现并写回 .env。
  // 默认走回环可避开「服务已起、网络未就绪」时访问自身 LAN IP 的 Errno 101；
  // 网关只绑 LAN 地址时由发现逻辑换成 LAN IP。
  fnBaseUrl: process.env.FNMUSIC_BASE_URL
    || `http://127.0.0.1:${process.env.FNMUSIC_GATEWAY_PORT || '6688'}`,
  fnUsername: process.env.FNMUSIC_USERNAME || '',
  fnPassword: process.env.FNMUSIC_PASSWORD || '',
  // Read-only bind mount of trim.music/db (see docker-compose.yml). Used by
  // scripts/fnmusic_token.py to find a live music-token session.
  musicDbPath: process.env.FNMUSIC_DB_PATH || '/fnmusic-db/music.db',
  tokenScript: path.join(ROOT, 'scripts/fnmusic_token.py'),
  tokenCache: path.join(dataDir, 'fnmusic-token'),
  ffmpeg: process.env.FFMPEG_BIN || '/usr/bin/ffmpeg',
  ffprobe: process.env.FFPROBE_BIN || '/usr/bin/ffprobe',
  maxTranscodes: Number(process.env.MIOT_MAX_TRANSCODES || 2),
  // 诊断信息用：仓库根（miot-service 的上一级），VERSION 在那里
  repoRoot: path.dirname(ROOT),
};

const log = {
  info: (m) => console.log(`[miot] ${m}`),
  warn: (m) => console.warn(`[miot] WARN ${m}`),
  error: (m) => console.error(`[miot] ERROR ${m}`),
};

installHostFetch();
const storage = createStorage(path.join(cfg.dataDir, 'storage.json'), log);

// ConfigManager merges defaults, so writing just server_host is enough. When
// importing Songloft's old storage.json the stale host usually still points at
// the Songloft port; MIOT_SERVER_HOST_FORCE=true fixes that on first boot.
// 用户在 .env 里自定义端口后，自动生成的 http://<LAN IP>:<端口> 形式的地址
// 会跟随新端口；手填的域名 / 反向代理地址原样保留（与安装脚本的策略一致）。
async function ensureServerHost() {
  if (!cfg.serverHost) return;
  let stored = {};
  try {
    const raw = await storage.get('config');
    if (raw) stored = JSON.parse(String(raw)) || {};
  } catch { /* corrupted config: fall back to defaults */ }
  if (!stored.server_host || cfg.forceServerHost) {
    stored.server_host = cfg.serverHost;
    await storage.set('config', JSON.stringify(stored));
    log.info(`server_host=${cfg.serverHost} (init/force)`);
    return;
  }
  try {
    const cur = new URL(String(stored.server_host));
    const want = new URL(cfg.serverHost);
    const isGenerated = cur.protocol === 'http:' && cur.hostname === want.hostname
      && (cur.pathname === '/' || cur.pathname === '') && !cur.username && !cur.password;
    if (isGenerated && cur.port !== want.port) {
      log.warn(`server_host 端口 ${cur.port || '(默认)'} → ${want.port}（跟随 MIOT_PORT 变更）`);
      stored.server_host = cfg.serverHost;
      await storage.set('config', JSON.stringify(stored));
    }
  } catch { /* 非 URL 形式，保留用户配置 */ }
}
await ensureServerHost();

// OAuth-created fnOS accounts cannot use /user/password-login. Ask the
// helper to pick a token the server actually accepts; it probes music.db
// sessions and caches the winner, and is re-run (force) on 401 / 120001.
async function resolveFnToken(force) {
  if (!fs.existsSync(cfg.tokenScript)) return null;
  const args = [cfg.tokenScript, '--db', cfg.musicDbPath,
    // 用 fn.baseUrl（client 可能在启动探测后迁移到回环）而不是静态配置，
    // 保持 token 解析与 API 调用走同一条链路。
    '--base', fn.baseUrl, '--cache', cfg.tokenCache];
  if (force) args.push('--force');
  try {
    const { stdout } = await execFileAsync('python3', args, {
      timeout: 60000, maxBuffer: 64 * 1024,
    });
    return String(stdout).trim() || null;
  } catch (err) {
    const detail = String(err.stderr || err.message).trim().slice(0, 300);
    log.warn(`[fnmusic] token resolver failed: ${detail}`);
    return null;
  }
}

// 通用网关发现：只在基址探测失败时触发，能通的实例不做任何扫描。
const gateway = createGatewayDiscovery({ cfg, log });

const fn = createFnMusicClient({
  baseUrl: cfg.fnBaseUrl,
  username: cfg.fnUsername,
  password: cfg.fnPassword,
  tokenProvider: resolveFnToken,
  log,
  discoverGateway: gateway.discover,
  onGatewayResolved: gateway.persist,
});
const music = createMusicAdapter({ fn, storage, log, cfg });
installSongloft({ cfg, storage, music, log });

const streamHandler = createStreamHandler({ fn, music, cfg, log });
const coverHandler = createCoverHandler({ fn, music, log });
const lyricHandler = createLyricHandler({ fn, music, log });
const compat = createCompatHandler({ fn, music, cfg, log, storage });

if (!fs.existsSync(cfg.distFile)) {
  log.error(`bundle not found: ${cfg.distFile} -- run "npm run build" (see README)`);
  process.exit(1);
}
await import(pathToFileURL(cfg.distFile).href);

if (typeof globalThis.onInit !== 'function') {
  log.error('bundle did not register globalThis.onInit');
  process.exit(1);
}
await globalThis.onInit();

const diagnostics = createDiagnostics({ cfg, storage, log, gateway });
await diagnostics.initFromConfig();
const ports = createPorts({ cfg, log });
const server = await startServer({ cfg, streamHandler, coverHandler, lyricHandler, compat, log, diagnostics, ports });

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`received ${signal}, shutting down`);
  try { await globalThis.onDeinit?.(); } catch (err) { log.warn(`onDeinit: ${err.message}`); }
  await server.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

log.info(`token=${cfg.token.slice(0, 6)}… (persisted at ${path.join(cfg.dataDir, 'token')}) requireAuth=${cfg.requireAuth} dataDir=${cfg.dataDir}`);
