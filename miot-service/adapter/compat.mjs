// Compatibility surface for fnmusic-ext's WebUI.
//
// webui-service/app.py proxies /api/xiaomusic/status -> /health + wizard state,
// and app.js polls it every 5s expecting these field names. Keeping them means
// the WebUI keeps working while the real UI is replaced by the miot Vue panel.

export function createCompatHandler({ fn, music, cfg, log, storage }) {
  let lastSyncAt = 0;
  let lastError = '';

  async function probe(path, method = 'GET') {
    if (typeof globalThis.onHTTPRequest !== 'function') return {};
    try {
      const r = await globalThis.onHTTPRequest({
        method, path, headers: {}, body: null, query: '', remoteAddr: '127.0.0.1',
      });
      if (!r || r.statusCode >= 400 || !r.body) return {};
      return JSON.parse(typeof r.body === 'string' ? r.body : Buffer.from(r.body).toString('utf8'));
    } catch {
      return {};
    }
  }

  return {
    async handle(pathname, req, url) {
      // 只读诊断：语音点播的飞牛音乐搜索候选（含 ext 在线音源）实际命中了什么。
      // 会触发一次上游搜索，所以要求与播放端点同一个 token，避免被 LAN 侧滥用。
      if (pathname === '/compat/library-search') {
        const json = (statusCode, payload) => ({
          statusCode,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
          body: JSON.stringify(payload),
        });
        // 面板搜索经 nodeconsole 同源反代访问，令牌由网关以 Authorization: Bearer 注入；
        // 原来的 ?access_token= 诊断方式继续保留。两者都不把只读搜索开放给未授权访问。
        const bearer = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '').trim();
        const authorized = url.searchParams.get('access_token') === cfg.token || bearer === cfg.token;
        if (!authorized) return json(401, { error: 'unauthorized' });
        const q = String(url.searchParams.get('q') || '').trim().slice(0, 60);
        if (!q) return json(400, { error: 'q is required' });
        // full=1 给面板搜索用：返回完整候选（含可直接下发给音箱的播放 URL），
        // 不带 full 时仍是原来只回前 5 条的轻量诊断输出。
        const full = url.searchParams.get('full') === '1';
        try {
          const rows = await music.searchSongs(q);
          const extAvailable = typeof fn.detectExt === 'function' ? await fn.detectExt() : true;
          // play_url 与 URLBuilder.buildSongURL 同构：serverHost + /api/v1/songs/:id/play
          // + access_token。searchSongs() 里的 register() 已建立 id -> guid 映射，
          // 因此复用上午语音点播验证过的取流链路，不导入曲库、不需要额外搜索源。
          const hostBase = String(cfg.serverHost || '').replace(/\/$/, '');
          const songs = full ? rows.map((s) => {
            const rel = String(s.url || '');
            const sep = rel.includes('?') ? '&' : '?';
            return {
              id: s.id,
              // 在线音源标题带 [lx-xx] 来源前缀，展示时剥掉（打分逻辑同样处理）。
              title: String(s.title || '').replace(/^\[[^\]]+\]\s*/, ''),
              artist: s.artist || '',
              album: s.album || '',
              duration: Number(s.duration || 0),
              is_online: !!s.is_online,
              cover_url: s.cover_url || '',
              play_url: rel && hostBase
                ? hostBase + rel + sep + 'access_token=' + encodeURIComponent(cfg.token)
                : '',
            };
          }) : null;
          return json(200, {
            query: q,
            enabled: process.env.FNMUSIC_MIOT_LIB_SEARCH !== '0',
            ext_available: extAvailable,
            count: rows.length,
            online: rows.filter((s) => s.is_online).length,
            top: rows.slice(0, 5).map((s) => ({
              id: s.id, title: s.title, artist: s.artist,
              is_online: !!s.is_online, format: s.format, url: s.url,
            })),
            ...(full ? { songs } : {}),
          });
        } catch (err) {
          return json(502, { error: String(err?.message || err) });
        }
      }

      if (pathname === '/sync' && req.method === 'POST') {
        try {
          await probe('/indexing/refresh', 'POST');
          lastSyncAt = Date.now();
          lastError = '';
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ret: 'OK', updated: true, favorites: music.stats().songs }),
          };
        } catch (err) {
          lastError = String(err.message || err);
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ret: 'OK', updated: false, error: lastError }),
          };
        }
      }

      const [auth, player, conversation, indexing] = await Promise.all([
        probe('/auth/status'),
        probe('/player/status'),
        probe('/conversation/status'),
        probe('/indexing/status'),
      ]);
      // 2.1.0：fnmusic-ext 从硬依赖降为可选增强。控制台读 /compat/status
      // 拿到这个标志后提示当前是「在线增强」还是「纯本地曲库」模式。
      const extAvailable = typeof fn.detectExt === 'function' ? await fn.detectExt() : true;
      // /auth/status returns { success, data: [ { logged_in, is_valid, ... } ] }
      // -- an ARRAY, not an object with logged_in on it.
      const authRows = Array.isArray(auth?.data)
        ? auth.data
        : (Array.isArray(auth?.data?.accounts) ? auth.data.accounts : []);

      const name = player?.data?.song?.title
        || player?.data?.title
        || conversation?.data?.last_query
        || '';
      const body = {
        ok: !lastError,
        token: fn.loggedIn,
        mi_logged: !!(auth?.data?.logged_in ?? auth?.logged_in
          ?? authRows.some((a) => a?.logged_in === true || a?.is_valid === true)),
        wizard_done: true,
        favorites: indexing?.data?.song_count ?? music.stats().songs,
        playlist: indexing?.data?.playlist_count ?? 0,
        playlist_songs: indexing?.data?.song_count ?? music.stats().songs,
        last_sync_at: lastSyncAt,
        last_push_at: lastSyncAt,
        push_ok: !lastError,
        last_error: lastError,
        nas_ip: process.env.FNMUSIC_NAS_IP || url.hostname,
        // 宿主发布端口，不是容器内监听端口（容器 8006 -> 宿主 8775）。
        // 写错会让管理台把音箱地址拼成 8006，音箱根本连不上。
        public_port: Number(cfg.publicPort || 8775),
        fnmusic_base_url: fn.baseUrl,
        gateway: 'miot-fnos',
        // 没装 fnmusic-ext 时为空串；控制台据此给一次非阻断提示。
        ext_available: extAvailable,
        // 语音点播的零配置兜底搜索源：飞牛音乐（ext 在位时含在线音源）。
        // 设 FNMUSIC_MIOT_LIB_SEARCH=0 可整体关掉，回到旧的外部搜索源行为。
        lib_search_enabled: process.env.FNMUSIC_MIOT_LIB_SEARCH !== '0',
        lib_search_source: '飞牛音乐 /search/track',
        ext_hint: extAvailable ? ''
          : '未检测到飞牛音乐扩展（fnmusic-ext）：在线榜单与在线音源不可用；本地曲库、收藏、音乐库和播放不受影响。需要时在应用中心安装即可自动恢复。',
        // WebUI renders these two health rows; the miot engine always polls
        // the Xiaomi conversation API, so both are healthy by construction.
        pull_ask_on: true,
        ask_channel: 'conversation_api',
        poll_degraded: false,
        pull_ask_sec: 1,
        audio_id_cache: 0,
        now_playing: {
          name,
          is_playing: !!(player?.data?.playing ?? player?.data?.is_playing),
          source_label: '飞牛音乐',
          source: 'local',
          device: player?.data?.device_name || '',
        },
        // Kept for test_xiaomusic_page.py assertions.
        engine: 'miot',
      };
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify(body),
      };
    },
  };
}
