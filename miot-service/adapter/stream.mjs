// Playback stream endpoint: /api/v1/songs/:id/play
//
// Songloft's host used to provide format=mp3 / radio_transcode / normalize /
// seek / speed via its own ffmpeg layer. URLBuilder.buildSongURL() emits that
// exact URL shape, so this service must reproduce it. The audio source is
// FeiNiu Music's /track/stream (which already supports Range).
//
// Passthrough path: MP3/m4a with no seek/speed/normalize -> stream bytes
// through unchanged, preserving 206/Content-Range so the speaker can seek.
// Transcode path: pipe the source into ffmpeg and return a chunked MP3.

import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { nativeFetch } from '../host/fetch.mjs';
import { API_BASE } from './fnmusic.mjs';

// Formats a XiaoAI speaker can decode without help. Anything else goes
// through ffmpeg when force_mp3 is on (the default we recommend on fnOS).
const DIRECT_FORMATS = new Set(['mp3', 'm4a', 'aac']);
const KNOWN_LOSSLESS = new Set(['flac', 'ape', 'wav', 'wv', 'dsf', 'dff', 'aiff', 'alac', 'ogg', 'opus', 'wma']);
// The speaker URL must contain only access_token as a query parameter (any
// "&k=v" is swallowed by XiaoAI firmware and corrupts the token), so the
// force_mp3 option is usually absent from real playback URLs. Formats the
// firmware cannot decode at all therefore have to be transcoded here,
// unconditionally, instead of being passed through as raw ASF/APE/... bytes.
const MUST_TRANSCODE = new Set(['wma', 'ape', 'wv', 'dsf', 'dff', 'aiff', 'aif', 'ogg', 'opus', 'ac3', 'dts']);

const PASS_HEADERS = ['content-length', 'content-range', 'accept-ranges', 'content-type', 'etag', 'last-modified'];

function pickHeaders(resp) {
  const out = { 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' };
  for (const k of PASS_HEADERS) {
    const v = resp.headers.get(k);
    if (v) out[k] = v;
  }
  return out;
}

function atempoFilter(speed) {
  let s = Number(speed);
  if (!Number.isFinite(s) || s <= 0 || s === 1) return null;
  const parts = [];
  while (s > 2) { parts.push('atempo=2.0'); s /= 2; }
  while (s < 0.5) { parts.push('atempo=0.5'); s /= 0.5; }
  parts.push(`atempo=${s.toFixed(3)}`);
  return parts.join(',');
}

// ---------------------------------------------------------------------------
// Byte-range seek (replaces the ffmpeg transcode path for plain MP3).
//
// Why: the old seek path pipes the whole track through ffmpeg with `-ss` and
// returns a chunked 200 with no Content-Length and `Accept-Ranges: none`.
// XiaoAI firmware cannot position in such a stream and answers
// "播放失败，请检查网络或换一个试试吧" as soon as the progress bar is dragged.
// A normal (seek=0) play instead returns 200/206 + Content-Length +
// Accept-Ranges: bytes, which works. FeiNiu's /track/stream already honours
// Range, so we map seconds -> byte offset and proxy that 206, rewriting
// Content-Range so the speaker sees a fresh, complete resource whose byte 0
// is exactly the requested position.
// ---------------------------------------------------------------------------

function contentRangeOf(resp) {
  const v = resp?.headers?.get?.('content-range');
  if (!v) return null;
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(String(v).trim());
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]), total: Number(m[3]) };
}

/** Translate the speaker's Range header into offsets of our virtual stream. */
function clientRangeOf(range, total) {
  const m = /^bytes=(\d*)-(\d*)$/i.exec(String(range || '').trim());
  if (!m) return { requested: false, start: 0, end: total - 1 };
  let start, end;
  if (m[1] === '') {                       // suffix range: bytes=-N
    start = Math.max(0, total - Number(m[2] || 0));
    end = total - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1);
  }
  if (!Number.isFinite(start) || start >= total) {
    return { requested: false, start: 0, end: total - 1 };
  }
  return { requested: true, start, end: Math.max(start, end) };
}

/** Snap an estimated byte offset forward to the next MP3 frame sync word. */
async function alignMp3Frame(fn, guid, start, total) {
  const end = Math.min(total - 1, start + 2047);
  const r = await fn.openStream(guid, `bytes=${start}-${end}`);
  if (r.status !== 206 || !r.body) { try { await r.body?.cancel?.(); } catch { /* ignore */ } return start; }
  const buf = Buffer.from(await r.arrayBuffer());
  for (let i = 0; i + 1 < buf.length; i++) {
    const b = buf[i + 1];
    // 0xFF + top 3 bits set = MPEG audio frame sync; reject reserved
    // version (01) and reserved layer (00) to avoid a false positive.
    if (buf[i] === 0xFF && (b & 0xE0) === 0xE0
        && ((b >> 3) & 3) !== 1 && ((b >> 1) & 3) !== 0) {
      return start + i;
    }
  }
  return start;
}

async function tryByteRangeSeek({ fn, guid, song, seek, range, method, log }) {
  const duration = Number(song?.duration || 0);
  if (!(duration > 0)) return null;

  // 1) Discover the real byte length. A 206 with Content-Range is required;
  //    sources that ignore Range are not seekable this way -> ffmpeg fallback.
  let probe;
  try { probe = await fn.openStream(guid, 'bytes=0-0'); }
  catch (err) { log.warn?.(`[stream] range probe failed: ${err.message}`); return null; }
  const probed = contentRangeOf(probe);
  const total = probe.status === 206 && probed ? probed.total : 0;
  try { await probe.body?.cancel?.(); } catch { /* ignore */ }
  if (total < 4096) return null;

  // 2) Seconds -> bytes (CBR approximation), then snap to a frame boundary.
  const byteStart = await alignMp3Frame(
    fn, guid,
    Math.min(total - 1, Math.max(0, Math.floor(total * Math.min(seek, duration) / duration))),
    total,
  ).catch((err) => {
    log.warn?.(`[stream] frame align skipped: ${err.message}`);
    return Math.min(total - 1, Math.max(0, Math.floor(total * Math.min(seek, duration) / duration)));
  });
  const virtualTotal = total - byteStart;
  if (virtualTotal < 4096) return null;

  // 3) Map the speaker's Range onto the real file and fetch that slice.
  const wanted = clientRangeOf(range, virtualTotal);
  const upStart = byteStart + wanted.start;
  const upEnd = wanted.end >= virtualTotal - 1 ? '' : byteStart + wanted.end;
  let resp;
  try { resp = await fn.openStream(guid, `bytes=${upStart}-${upEnd}`); }
  catch (err) { log.warn?.(`[stream] range fetch failed: ${err.message}`); return null; }
  const up = contentRangeOf(resp);
  if (resp.status !== 206 || !up || up.total !== total || up.start !== upStart) {
    try { await resp.body?.cancel?.(); } catch { /* ignore */ }
    return null;
  }

  const relStart = up.start - byteStart;
  const relEnd = up.end - byteStart;
  const headers = pickHeaders(resp);
  headers['content-length'] = String(relEnd - relStart + 1);
  headers['accept-ranges'] = 'bytes';
  if (wanted.requested) {
    headers['content-range'] = `bytes ${relStart}-${relEnd}/${virtualTotal}`;
  } else {
    // The speaker asked for a plain GET: present the slice as a complete
    // resource (200) rather than an unsolicited 206.
    delete headers['content-range'];
  }
  const statusCode = wanted.requested ? 206 : 200;
  if (method === 'HEAD') {
    try { await resp.body?.cancel?.(); } catch { /* ignore */ }
    return { statusCode, headers, body: '' };
  }
  return { statusCode, headers, stream: Readable.fromWeb(resp.body) };
}

export function createStreamHandler({ fn, music, cfg, log }) {
  let active = 0;
  const waiters = [];

  function acquire() {
    if (active < cfg.maxTranscodes) { active++; return Promise.resolve(); }
    return new Promise((resolve) => waiters.push(() => { active++; resolve(); }));
  }
  function release() {
    active = Math.max(0, active - 1);
    const next = waiters.shift();
    if (next) next();
  }

  return async function handle({ id, range = null, params = {}, method = 'GET' }) {
    const guid = music.guidOf(id);
    if (!guid) return { statusCode: 404, headers: { 'Content-Type': 'text/plain' }, body: 'unknown song' };

    const song = music.songOf(Number(id));
    const fmt = String(song?.format || '').toLowerCase();
    const seek = Number(params.seek || 0);
    const speed = Number(params.speed || 1);
    const normalize = params.normalize === '1' || params.normalize === 'true';
    const forceMp3 = params.format === 'mp3' || params.radio_transcode === 'mp3';

    // A seek must remain a normal seekable HTTP resource. Try the byte-range
    // proxy first; if the source cannot serve it, fall through to the original
    // ffmpeg -ss path below (lossless / m4a / speed / normalize still need it).
    if (seek > 0 && fmt === 'mp3' && !normalize && (!speed || speed === 1)) {
      const ranged = await tryByteRangeSeek({ fn, guid, song, seek, range, method, log });
      if (ranged) return ranged;
      log.warn?.(`[stream] byte-range seek unavailable for ${guid}, falling back to ffmpeg`);
    }
    // When force_mp3 is requested and the container format is unknown or
    // lossless, transcode. Only a known-direct format (mp3/m4a/aac) is safe
    // to pass through; a mis-detected FLAC would otherwise make the speaker
    // light up but stay silent (songloft-org/songloft-plugin-miot#62).
    const unsafeForSpeaker = !fmt || KNOWN_LOSSLESS.has(fmt) || !DIRECT_FORMATS.has(fmt);
    const needsTranscode = MUST_TRANSCODE.has(fmt) || (forceMp3 && unsafeForSpeaker)
      || seek > 0 || (speed && speed !== 1) || normalize;

    let resp;
    try {
      // ffmpeg cannot seek a piped source, so drop Range on the transcode path.
      resp = await fn.openStream(guid, needsTranscode ? null : range);
    } catch (err) {
      log.error(`[stream] openStream(${guid}): ${err.stack || err.message}`);
      return { statusCode: 502, headers: { 'Content-Type': 'text/plain' }, body: String(err.message || err) };
    }
    if (resp.status >= 400) {
      return { statusCode: resp.status, headers: { 'Content-Type': 'text/plain' }, body: `upstream HTTP ${resp.status}` };
    }
    if (method === 'HEAD' || !resp.body) {
      return { statusCode: resp.status, headers: pickHeaders(resp), body: '' };
    }

    if (!needsTranscode) {
      return {
        statusCode: resp.status,
        headers: pickHeaders(resp),
        stream: Readable.fromWeb(resp.body),
      };
    }

    await acquire();
    // -map 0:a:0 + -vn: FLAC/APE often embed cover art as a video stream;
    // letting ffmpeg pick it produces a stream the speaker cannot decode.
    const args = ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
      '-map', '0:a:0', '-vn'];
    if (seek > 0) args.push('-ss', String(Math.floor(seek)));
    const filters = [];
    const at = atempoFilter(speed);
    if (at) filters.push(at);
    if (normalize) filters.push('loudnorm=I=-16:TP=-1.5:LRA=11');
    if (filters.length) args.push('-af', filters.join(','));
    args.push('-map_metadata', '-1', '-f', 'mp3', '-b:a', '192k', 'pipe:1');

    const ff = spawn(cfg.ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let released = false;
    const done = () => { if (!released) { released = true; release(); } };
    const timer = setTimeout(() => { log.warn('[stream] ffmpeg timeout, killing'); cleanup(); }, 15 * 60 * 1000);
    ff.on('close', () => { clearTimeout(timer); done(); });
    ff.on('error', (err) => { log.error(`[stream] ffmpeg: ${err.message}`); clearTimeout(timer); done(); });
    ff.stderr?.on('data', (d) => log.warn(`[stream] ffmpeg: ${String(d).trim().slice(0, 300)}`));

    const source = Readable.fromWeb(resp.body);
    source.on('error', (err) => { log.warn(`[stream] source: ${err.message}`); ff.stdin.destroy(); });
    source.pipe(ff.stdin);

    // The speaker abandons a stream on every skip. Without this hook ffmpeg
    // keeps decoding the whole track and holds a transcode slot forever.
    let cleaned = false;
    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timer);
      try { source.unpipe(ff.stdin); ff.stdin.destroy(); } catch { /* closed */ }
      try { ff.kill('SIGTERM'); } catch { /* exited */ }
      const hardKill = setTimeout(() => { try { ff.kill('SIGKILL'); } catch { /* gone */ } }, 2000);
      hardKill.unref?.();
      done();
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
        // A live transcode cannot serve byte ranges; advertising 'bytes'
        // would make some firmwares retry a seek forever.
        'Accept-Ranges': 'none',
      },
      stream: ff.stdout,
      onClose: cleanup,
    };
  };
}

// Lyric proxy. miot's /lyric handler calls callHostAPI('/api/v1/songs/:id/lyric'),
// which (via plugin.getHostUrl()) loops back to this very server. We must serve
// it or every lyric request ends up as a 502 in the panel.
//
// Sources, in order: a sidecar .lrc next to the audio file (FeiNiu Music keeps
// those), then the official /lyric/list API. Returning 404 is intentional --
// handlers/lyric.ts normalises it into an empty 200 payload.
function lyricTextOf(data) {
  if (typeof data === 'string') return data;
  if (!data || typeof data !== 'object') return '';
  for (const k of ['lyric', 'lyrics', 'content', 'text', 'lrc']) {
    if (typeof data[k] === 'string' && data[k].trim()) return data[k];
  }
  for (const k of ['list', 'items', 'data', 'result']) {
    const found = lyricTextOf(Array.isArray(data[k]) ? data[k][0] : data[k]);
    if (found) return found;
  }
  return '';
}

export function createLyricHandler({ fn, music, log }) {
  return async function handle({ id }) {
    const guid = music.guidOf(id);
    const song = music.songOf(Number(id));
    if (!guid) return { statusCode: 404, headers: { 'Content-Type': 'application/json' }, body: '{}' };

    // 1) Sidecar .lrc inside the shared music library (read-only).
    const audioPath = String(song?.file_path || '');
    if (audioPath) {
      const base = audioPath.replace(/\.[^.]+$/, '');
      for (const candidate of [`${base}.lrc`, `${path.dirname(audioPath)}/${path.basename(base)}.lrc`]) {
        try {
          const text = fs.readFileSync(candidate, 'utf8');
          if (text.trim()) {
            return {
              statusCode: 200,
              headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
              body: JSON.stringify({ lyric: text, tlyric: '', rlyric: '', lxlyric: '' }),
            };
          }
        } catch { /* no sidecar */ }
      }
    }

    // 2) Official lyric API.
    try {
      const data = await fn.getLyric(guid);
      const text = lyricTextOf(data);
      if (text) {
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
          body: JSON.stringify({ lyric: text, tlyric: '', rlyric: '', lxlyric: '' }),
        };
      }
    } catch (err) {
      log.warn?.(`[lyric] ${guid}: ${err.message}`);
    }
    return { statusCode: 404, headers: { 'Content-Type': 'application/json' }, body: '{}' };
  };
}

// Cover proxy: the official /static/cover endpoint is authx-signed, so the
// browser cannot request it directly. Song.cover_url points here instead.
export function createCoverHandler({ fn, music, log }) {
  return async function handle({ id }) {
    const song = music.songOf(Number(id));
    const coverId = song?.cover_id || music.guidOf(id);
    if (!coverId) return { statusCode: 404, headers: {}, body: '' };
    try {
      await fn.login();
      const path = '/static/cover';
      const query = { coverId: String(coverId) };
      const r = await nativeFetch(
        fn.baseUrl + API_BASE + path + `?coverId=${encodeURIComponent(String(coverId))}`,
        {
          headers: {
            Accept: 'image/*',
            'X-Music-API': 'v1',
            Cookie: `music-token=${fn.token || ''}`,
            authx: fn.signAuthx('GET', path, query, Buffer.alloc(0)),
          },
          redirect: 'manual',
        },
      );
      if (!r.ok || !r.body) return { statusCode: 404, headers: {}, body: '' };
      return {
        statusCode: r.status,
        headers: { 'Content-Type': r.headers.get('content-type') || 'image/jpeg', 'Cache-Control': 'public, max-age=86400' },
        stream: Readable.fromWeb(r.body),
      };
    } catch (err) {
      log.warn(`[cover] ${err.message}`);
      return { statusCode: 502, headers: {}, body: '' };
    }
  };
}
