// Map the FeiNiu Music library onto the SDK Song / Playlist shapes.
//
// Two important constraints discovered in songloft-plugin-miot:
//   * Song.id and Playlist.id are NUMBERS, while FeiNiu tracks use string GUIDs.
//     We keep a bidirectional map and generate a stable numeric id from the
//     GUID when the API does not expose a numeric primary key.
//   * src/utils/favorites.ts requires the favorites playlist to be id === 1
//     (type 'normal'), or named exactly '收藏'. We reserve id 1 for it and
//     offset real FeiNiu playlist ids to avoid collisions.

import { createHash } from 'node:crypto';

export const FAVORITE_PLAYLIST_ID = 1;
const PLAYLIST_ID_OFFSET = 1000;

// FeiNiu Music's "音乐库" (shared libraries) are directory-based browsing
// views, not real playlists. We expose them as read-only virtual playlists so
// the MIoT panel's "选择播放歌单" dropdown can play a whole library without
// importing anything into a playlist. The folder view was deliberately
// dropped: every first-level folder is already covered by its parent library,
// so listing both just duplicated the same songs in the dropdown.
// IDs live in a high, disjoint band: 1 = favorites,
// 1000..1000999 = real FeiNiu playlists, <0 = in-memory temp playlists.
const VIRTUAL_ID_BASE = 2_000_000_000;
const VIRTUAL_LIBRARY_OFFSET = 1;
const VIRTUAL_TTL_MS = 5 * 60 * 1000;
const TRACK_CACHE_TTL_MS = 60 * 1000;
const FAVORITE_COUNT_TTL_MS = 30 * 1000;
const VIRTUAL_READONLY_ERROR =
  '音乐库是飞牛音乐的只读视图，不能增删歌曲；请在飞牛音乐里管理歌单或文件。';

const isVirtualPlaylistId = (id) => Number(id) >= VIRTUAL_ID_BASE;

// 官方 /search/track 会忽略 size 参数、一次返回整库（实测 80 KB+）。先截断再
// register，否则一次搜索就把全库曲目灌进 songById 缓存，纯官方模式下尤其明显。
// 语音点播的兜底搜索走这里：size 要覆盖 fnmusic-ext 合并进同页的在线结果，
// 上限则防止官方忽略 size 时把几百首全灌进内存。
const SEARCH_PAGE_SIZE = 30;
const MAX_SEARCH_RESULTS = 50;

// fnmusic-ext 注入的在线虚拟歌单统一以 "online:" 开头。扩展不在位时把它们
// 从下拉里摘掉，避免用户选到一个必然为空、也取不到流的条目。
const isOnlinePlaylistGuid = (v) => /^online:/i.test(String(v ?? ''));

function basename(p) {
  const s = String(p || '').replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

/** Is `filePath` the directory `root` itself or one of its descendants? */
function underPath(filePath, root) {
  if (!root) return true;
  const p = String(filePath || '');
  const r = String(root).replace(/\/+$/, '');
  return p === r || p.startsWith(r + '/');
}

function stableId(guid) {
  const n = createHash('md5').update(String(guid)).digest().readUInt32BE(0) & 0x7fffffff;
  return n || 1;
}

function text(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(text).filter(Boolean).join(' / ');
  if (typeof v === 'object') return text(v.name ?? v.title ?? v.artistName ?? '');
  return String(v);
}

function extOf(p) {
  const m = String(p || '').match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : '';
}

export function createMusicAdapter({ fn, storage, log, cfg }) {
  const guidById = new Map();
  const idByGuid = new Map();
  const songById = new Map();
  const fnPlaylistByMiotId = new Map();
  const miotPlaylistByFnId = new Map();
  let deleted = new Set();

  // Virtual (library/folder) playlist metadata and a short-lived cache of the
  // full track list. Both are rebuilt lazily; /playlists is called on every
  // panel init/refresh, so we must not re-walk the whole library each time.
  const virtualById = new Map();
  let virtualBuiltAt = 0;
  let virtualInflight = null;
  let trackCache = null;
  let trackCacheAt = 0;
  let favoriteCount = 0;
  let favoriteCountAt = 0;

  // fnOS 1.2.x /music/api/v1 puts all audio metadata in audioSpec and uses
  // nested artists[]/album/genres[] objects plus camelCase timestamps. The
  // original adapter expected flat Songloft-style fields, so format (needed
  // to decide FLAC/APE -> MP3 transcoding), duration and bitrate were empty.
  function isoTime(v, fallback) {
    if (v == null || v === '') return fallback || new Date().toISOString();
    const n = Number(v);
    if (Number.isFinite(n) && n > 0 && /^\d+(\.\d+)?$/.test(String(v))) {
      return new Date(n * (n < 1e12 ? 1000 : 1)).toISOString();
    }
    return String(v);
  }

  function register(raw) {
    const spec = (raw.audioSpec && typeof raw.audioSpec === 'object') ? raw.audioSpec : {};
    const guid = String(raw.guid ?? raw.trackGUID ?? raw.track_guid
      ?? (typeof raw.id === 'string' ? raw.id : '') ?? '');
    if (!guid) return null;
    const id = Number.isFinite(Number(raw.id)) && Number(raw.id) > 0
      ? Number(raw.id)
      : (idByGuid.get(guid) ?? stableId(guid));
    guidById.set(id, guid);
    idByGuid.set(guid, id);

    const filePath = String(spec.path ?? raw.path ?? raw.filePath ?? raw.file_path ?? '');
    // fnmusic-ext injects online charts (QQ / netease / kugou / kuwo) as
    // "online:" virtual playlists. Their rows carry is_online=true and a
    // disguised audioSpec.path like "<32hex>.flac" (no leading slash).
    // The upstream proxy actually streams these as MP3 through its internal
    // proxy path, so advertising FLAC here would make stream.mjs run an
    // unnecessary ffmpeg transcode and drop Range support for the speaker.
    const online = raw.is_online === true || raw.isOnline === true
      || (Boolean(raw.source) && Boolean(filePath) && !filePath.startsWith('/'));
    const durationMs = Number(spec.duration ?? raw.duration_ms ?? raw.durationMs ?? 0);
    const duration = durationMs > 0 ? Math.round(durationMs / 1000) : Number(raw.duration ?? 0);
    const song = {
      id,
      type: 'local',
      title: text(raw.title ?? raw.name ?? raw.track_name) || '未知歌曲',
      artist: text(raw.artist ?? raw.artist_name ?? raw.artists ?? spec.artists) || '未知歌手',
      album: text(raw.album ?? raw.album_name ?? spec.album) || '',
      year: Number(raw.year ?? raw.album?.year ?? 0),
      genre: text(raw.genre ?? raw.genres ?? ''),
      duration,
      file_path: filePath,
      // Relative URL: URLBuilder.buildSongURL() prepends server_host.
      url: `/api/v1/songs/${id}/play`,
      cover_url: `/api/v1/songs/${id}/cover`,
      cover_id: String(raw.coverId ?? raw.cover_id ?? raw.cover ?? spec.coverId ?? ''),
      lyric_url: '',
      file_size: Number(spec.size ?? raw.size ?? raw.file_size ?? 0),
      format: online ? 'mp3'
        : String(spec.format ?? spec.codec ?? raw.suffix ?? raw.format ?? extOf(filePath) ?? '').toLowerCase(),
      // 语音候选打分与 /compat/library-search 诊断用：同分时本地曲库优先于在线音源。
      // 这只是附加标记，不改变 Songloft SDK 的 Song 结构（多余字段被忽略）。
      is_online: online,
      bit_rate: Number(spec.bitrate ?? raw.bitrate ?? raw.bit_rate ?? 0),
      sample_rate: Number(spec.sampleRate ?? raw.sample_rate ?? raw.sampleRate ?? 0),
      is_live: false,
      is_video: false,
      added_at: isoTime(raw.created_at ?? raw.createdAt ?? raw.added_at),
      updated_at: isoTime(raw.updated_at ?? raw.updatedAt),
    };
    songById.set(id, song);
    return song;
  }

  function rowsOf(data) {
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.list)) return data.list;
    if (Array.isArray(data?.items)) return data.items;
    if (Array.isArray(data?.tracks)) return data.tracks;
    return [];
  }

  function toPlaylist(raw, favorite = false) {
    // FeiNiu playlists have a STRING guid (e.g. "online:playlist:hot:..."),
    // no numeric id. Coercing it to Number produced 0 -> miot id 1000 ->
    // "invalid arguments" from /track/playlist-detail/list. Keep the guid and
    // derive a stable numeric id for the Songloft-shaped API instead.
    const fnKey = String(raw.guid ?? raw.id ?? raw.playlistId ?? raw.playlist_id ?? '').trim();
    const fnId = /^\d+$/.test(fnKey) ? Number(fnKey) : fnKey;
    const key = String(fnId);
    let id = favorite ? FAVORITE_PLAYLIST_ID : miotPlaylistByFnId.get(key);
    if (!favorite && !id) {
      id = PLAYLIST_ID_OFFSET + (stableId(key) % 1000000);
      miotPlaylistByFnId.set(key, id);
    }
    if (!favorite && key) fnPlaylistByMiotId.set(id, fnId);
    return {
      id,
      type: 'normal',
      name: favorite ? '收藏' : (text(raw.name ?? raw.title) || `歌单 ${key}`),
      description: text(raw.description ?? ''),
      cover_url: String(raw.cover_url ?? raw.cover ?? raw.coverId ?? ''),
      labels: favorite ? ['built_in'] : [],
      song_count: Number(raw.trackCount ?? raw.song_count ?? raw.songCount ?? raw.track_count ?? 0),
      created_at: isoTime(raw.created_at ?? raw.createdAt),
      updated_at: isoTime(raw.updated_at ?? raw.updatedAt),
      sort_by: 'position',
      sort_order: 'asc',
    };
  }

  async function loadAllTracks(limit = 100000) {
    const out = [];
    for (let page = 1; page <= 500; page++) {
      const data = await fn.getTracks(page, 200);
      const rows = rowsOf(data);
      for (const r of rows) {
        const s = register(r);
        if (s) out.push(s);
      }
      const total = Number(data?.total ?? data?.count ?? 0);
      if (!rows.length || (total && out.length >= total) || out.length >= limit) break;
    }
    return out;
  }

  /** Full library with a short TTL. register() also warms guidById/songById,
   *  which is required by the playback URL resolver for songs that are not in
   *  any real playlist. */
  async function allTracks() {
    if (trackCache && Date.now() - trackCacheAt < TRACK_CACHE_TTL_MS) return trackCache;
    const rows = await loadAllTracks(100000);
    trackCache = rows;
    trackCacheAt = Date.now();
    return rows;
  }

  // The favorites playlist is synthetic (id 1) and has no row in
  // /playlist/list, so its count was hard-coded to 0. Ask the official
  // favorite endpoint for `total` instead, with a short TTL because the
  // panel calls /playlists on every init and refresh.
  async function favoriteSongCount() {
    if (favoriteCountAt && Date.now() - favoriteCountAt < FAVORITE_COUNT_TTL_MS) {
      return favoriteCount;
    }
    try {
      const data = await fn.getFavorites(1, 1);
      const total = Number(data?.total ?? 0);
      favoriteCount = Number.isFinite(total) && total > 0 ? total : rowsOf(data).length;
      favoriteCountAt = Date.now();
    } catch (err) {
      log.warn?.(`[songs] favorite-track/list: ${err.message}`);
    }
    return favoriteCount;
  }

  function toVirtualPlaylist(v) {
    return {
      id: v.id,
      type: 'normal',
      name: v.name,
      description: v.kind === 'all' ? '飞牛音乐全部曲目' : `飞牛音乐目录 ${v.root}`,
      cover_url: '',
      labels: ['built_in', 'virtual'],
      song_count: v.songCount,
      created_at: '1970-01-01T00:00:00.000Z',
      updated_at: '1970-01-01T00:00:00.000Z',
      sort_by: 'position',
      sort_order: 'asc',
    };
  }

  /** One shared-library list call. Failures are non-fatal: real playlists and
   *  favorites must still work if the directory API is temporarily down. */
  async function buildVirtualPlaylists() {
    const all = await allTracks();
    const next = new Map();
    const countOf = (root) => all.reduce(
      (n, s) => n + (!deleted.has(s.id) && underPath(s.file_path, root) ? 1 : 0), 0);
    const add = (id, name, root, kind) => next.set(id, {
      id, name, root, kind, songCount: countOf(root),
    });

    add(VIRTUAL_ID_BASE, '[音乐库]全部歌曲', '', 'all');
    let libs = [];
    try {
      libs = rowsOf(await fn.getSharedLibraries());
    } catch (err) {
      log.warn?.(`[songs] shared-library/list: ${err.message}`);
    }
    let libSeq = 0;
    for (const lib of libs) {
      const root = String(lib?.path || '').replace(/\/+$/, '');
      if (!root) continue;
      add(VIRTUAL_ID_BASE + VIRTUAL_LIBRARY_OFFSET + libSeq++,
        `[音乐库]${basename(root)}`, root, 'library');
    }

    virtualById.clear();
    for (const [key, value] of next) virtualById.set(key, value);
    virtualBuiltAt = Date.now();
    return virtualById;
  }

  async function ensureVirtualPlaylists(force = false) {
    if (!force && virtualById.size && Date.now() - virtualBuiltAt < VIRTUAL_TTL_MS) {
      return virtualById;
    }
    if (!virtualInflight) {
      virtualInflight = buildVirtualPlaylists().finally(() => { virtualInflight = null; });
    }
    return virtualInflight;
  }

  return {
    guidOf(idOrGuid) {
      const key = String(idOrGuid);
      if (guidById.has(Number(key))) return guidById.get(Number(key));
      return key; // already a guid
    },
    songOf(id) { return songById.get(Number(id)) || null; },

    async listSongs(options = {}) {
      const all = await allTracks();
      const offset = options.offset ?? 0;
      return all.filter((s) => !deleted.has(s.id)).slice(offset, offset + (options.limit ?? all.length));
    },
    async getSongById(id) {
      const cached = songById.get(Number(id));
      if (cached) return cached;
      const guid = guidById.get(Number(id));
      if (!guid) return null;
      try {
        const data = await fn.getTrackMeta(guid);
        const row = rowsOf(data)[0] || (data && typeof data === 'object' ? data : null);
        return row ? register({ ...row, guid, id }) : null;
      } catch (err) {
        log.warn?.(`[songs] getTrackMeta(${guid}): ${err.message}`);
        return null;
      }
    },
    async searchSongs(query) {
      // 飞牛音乐本体（或 fnmusic-ext 代理）就是现成的搜索源：ext 在位时会把
      // QQ/网易/酷狗/酷我的在线结果合并进同一页，标题带 [lx-xx] 前缀、
      // is_online=true，取流仍走 /track/stream。语音点播直接复用它，不再要求
      // 额外安装搜索源插件。register() 同时建立 id -> guid 映射，播放链路可用。
      const q = String(query ?? '').trim();
      if (!q) return [];
      const data = await fn.search(q, SEARCH_PAGE_SIZE);
      const out = [];
      const seen = new Set();
      for (const row of rowsOf(data)) {
        if (out.length >= MAX_SEARCH_RESULTS) break;
        const guid = String(row?.guid ?? row?.trackGUID ?? row?.track_guid ?? '');
        if (guid && seen.has(guid)) continue;
        const song = register(row);
        if (!song) continue;
        if (guid) seen.add(guid);
        out.push(song);
      }
      return out;
    },
    async markDeleted(id) {
      deleted.add(Number(id));
      trackCacheAt = 0; // next read rebuilds so counts/list agree
      favoriteCountAt = 0;
      await storage.set('fnmusic:deleted_songs', JSON.stringify([...deleted]));
    },

    async listPlaylists() {
      const favCount = await favoriteSongCount();
      // 没有 detectExt 的旧 client / 单测 mock 一律按「扩展在位」处理，保持原行为。
      const extAvailable = typeof fn.detectExt === 'function' ? await fn.detectExt() : true;
      const out = [toPlaylist({ id: 0, name: '收藏', song_count: favCount }, true)];
      try {
        const data = await fn.getPlaylists();
        for (const r of rowsOf(data)) {
          if (!extAvailable && isOnlinePlaylistGuid(r?.guid ?? r?.id)) continue;
          out.push(toPlaylist(r));
        }
      } catch (err) {
        log.warn?.(`[songs] listPlaylists: ${err.message}`);
      }
      try {
        const virtuals = await ensureVirtualPlaylists();
        for (const v of virtuals.values()) out.push(toVirtualPlaylist(v));
      } catch (err) {
        log.warn?.(`[songs] listPlaylists virtual: ${err.message}`);
      }
      return out;
    },
    async getPlaylistById(id) {
      const list = await this.listPlaylists();
      return list.find((p) => p.id === Number(id)) || null;
    },
    async searchPlaylists(query, _options) {
      const list = await this.listPlaylists();
      const q = String(query).toLowerCase();
      return list.filter((p) => p.name.toLowerCase().includes(q));
    },
    async getPlaylistSongs(id, options = {}) {
      const num = Number(id);

      // Virtual library views: /track/list ignores all path-filter
      // params, so filter the cached full library by audioSpec.path prefix.
      if (isVirtualPlaylistId(num)) {
        await ensureVirtualPlaylists();
        const view = virtualById.get(num);
        if (!view) return [];
        const all = await allTracks();
        // Copy before sorting: `all` is the shared cache and must not be
        // reordered by one caller's sort preference.
        const songs = all
          .filter((s) => !deleted.has(s.id) && underPath(s.file_path, view.root))
          .sort(options.sort === 'title'
            ? (a, b) => a.title.localeCompare(b.title, 'zh-CN')
            : (a, b) => String(a.file_path || '').localeCompare(String(b.file_path || ''), 'zh-CN'));
        const offset = options.offset ?? 0;
        return songs.slice(offset, offset + (options.limit ?? 100000));
      }

      let rows = [];
      if (num === FAVORITE_PLAYLIST_ID) {
        for (let page = 1; page <= 40; page++) {
          const data = await fn.getFavorites(page, 500);
          const chunk = rowsOf(data);
          rows.push(...chunk);
          const total = Number(data?.total ?? 0);
          if (!chunk.length || (total && rows.length >= total)) break;
        }
      } else {
        const fnId = fnPlaylistByMiotId.get(num);
        // Stale Songloft playlist_progress keys have no official API
        // counterpart. Returning an empty list keeps the library cache quiet.
        if (fnId === undefined) return [];
        try {
          // fnmusic-ext injects "online:" virtual playlists (daily picks and
          // public charts). They ARE readable through playlistGUID; the old
          // early return here made every one of them show an empty song list.
          for (let page = 1; page <= 40; page++) {
            const data = await fn.getPlaylistTracks(fnId, page, 500);
            const chunk = rowsOf(data);
            rows.push(...chunk);
            const total = Number(data?.total ?? 0);
            if (!chunk.length || (total && rows.length >= total)) break;
          }
        } catch (err) {
          log.warn?.(`[songs] getPlaylistSongs(${num}): ${err.message}`);
        }
      }
      let songs = rows.map(register).filter(Boolean).filter((s) => !deleted.has(s.id));
      if (options.sort === 'title') songs = songs.sort((a, b) => a.title.localeCompare(b.title));
      const offset = options.offset ?? 0;
      return songs.slice(offset, offset + (options.limit ?? 100000));
    },
    async addPlaylistSongs(id, songIds) {
      if (isVirtualPlaylistId(id)) throw new Error(VIRTUAL_READONLY_ERROR);
      const guids = songIds.map((x) => this.guidOf(x)).filter(Boolean);
      if (Number(id) === FAVORITE_PLAYLIST_ID) {
        for (const g of guids) await fn.addFavorite(g);
        favoriteCountAt = 0;
      } else {
        const fnId = fnPlaylistByMiotId.get(Number(id));
        if (fnId !== undefined) await fn.addPlaylistTracks(fnId, guids);
      }
      return { added: guids.length, skipped: 0 };
    },
    async removePlaylistSongs(id, songIds) {
      if (isVirtualPlaylistId(id)) throw new Error(VIRTUAL_READONLY_ERROR);
      const guids = songIds.map((x) => this.guidOf(x)).filter(Boolean);
      if (Number(id) === FAVORITE_PLAYLIST_ID) {
        for (const g of guids) await fn.removeFavorite(g);
        favoriteCountAt = 0;
      } else {
        const fnId = fnPlaylistByMiotId.get(Number(id));
        if (fnId !== undefined) await fn.removePlaylistTracks(fnId, guids);
      }
    },
    async createPlaylist(input) {
      const data = await fn.createPlaylist(String(input?.name || '新歌单'));
      const row = rowsOf(data)[0] || data || {};
      return toPlaylist(row);
    },
    async deletePlaylist(id) {
      if (isVirtualPlaylistId(id)) throw new Error(VIRTUAL_READONLY_ERROR);
      const fnId = fnPlaylistByMiotId.get(Number(id));
      if (fnId !== undefined) await fn.deletePlaylist(fnId);
    },

    // Used by /health compatibility and by the cover proxy.
    stats() {
      return {
        songs: songById.size,
        deleted: deleted.size,
        playlists: fnPlaylistByMiotId.size,
        virtuals: virtualById.size,
      };
    },
  };
}
