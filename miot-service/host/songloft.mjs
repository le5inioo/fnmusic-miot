// Install globalThis.songloft.* for songloft-plugin-miot.
//
// Measured call sites in the plugin: log 637, storage 17 (+ ConfigManager),
// playlists 22, plugin 10, net 9, songs 7, comm 2. Songs/playlists are the
// only ones that change semantics: they now talk to FeiNiu Music.

import os from 'node:os';
import dgram from 'node:dgram';
import { createHttpStream } from './fetch.mjs';

function createUdpNet(log) {
  const sockets = new Map();
  let seq = 0;

  return {
    async udpBind(options = {}) {
      const bindSpec = options.address || '0.0.0.0:1900';
      const idx = bindSpec.lastIndexOf(':');
      const host = idx > 0 ? bindSpec.slice(0, idx) : '0.0.0.0';
      const port = idx > 0 ? Number(bindSpec.slice(idx + 1)) : 0;
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: options.reuseAddress !== false });
      const socketId = `udp-${++seq}`;
      const entry = { sock, handlers: [], groups: [] };
      sockets.set(socketId, entry);

      sock.on('message', (msg, rinfo) => {
        const event = {
          type: 'data',
          socketId,
          // receiver/receiver.ts does atob(event.data); SSDP is ASCII so a
          // latin1 round-trip through base64 is safe.
          data: Buffer.from(msg).toString('base64'),
          address: rinfo.address,
          port: rinfo.port,
          remoteAddr: `${rinfo.address}:${rinfo.port}`,
        };
        for (const h of entry.handlers) {
          try { h(event); } catch (err) { log.warn(`[udp] handler error: ${err.message}`); }
        }
      });
      sock.on('error', (err) => log.warn(`[udp] ${socketId}: ${err.message}`));

      await new Promise((resolve, reject) => {
        sock.once('error', reject);
        sock.bind(port, host || '0.0.0.0', () => { sock.off('error', reject); resolve(); });
      });
      return { socketId };
    },
    async udpJoinMulticast(socketId, group) {
      const e = sockets.get(socketId);
      if (!e) return;
      e.sock.addMembership(group);
      e.groups.push(group);
    },
    async udpLeaveMulticast(socketId, group) {
      const e = sockets.get(socketId);
      if (!e) return;
      try { e.sock.dropMembership(group); } catch { /* not joined */ }
    },
    onData(socketId, handler) {
      const e = sockets.get(socketId);
      if (e) e.handlers.push(handler);
    },
    async udpSend(socketId, data, addr) {
      const e = sockets.get(socketId);
      if (!e) return;
      const idx = addr.lastIndexOf(':');
      const host = addr.slice(0, idx);
      const port = Number(addr.slice(idx + 1));
      await new Promise((resolve, reject) => {
        e.sock.send(Buffer.from(String(data), 'utf8'), port, host, (err) => err ? reject(err) : resolve());
      });
    },
    async udpGetLocalAddr(socketId) {
      const e = sockets.get(socketId);
      const a = e?.sock.address();
      return { localAddr: a ? `${a.address}:${a.port}` : '' };
    },
    async udpClose(socketId) {
      const e = sockets.get(socketId);
      if (!e) return;
      sockets.delete(socketId);
      await new Promise((resolve) => { try { e.sock.close(resolve); } catch { resolve(); } });
    },
  };
}

export function installSongloft({ cfg, storage, music, log }) {
  const udp = createUdpNet(log);
  const commHandlers = new Map();

  const songloft = {
    log,

    storage,

    songs: {
      list: (options) => music.listSongs(options),
      getById: (id) => music.getSongById(Number(id)),
      // 语音点播的兜底搜索源。设 FNMUSIC_MIOT_LIB_SEARCH=0 可整体关掉，
      // 回到「本地索引 + 用户自配外部搜索源」的旧行为。
      search: async (query) => process.env.FNMUSIC_MIOT_LIB_SEARCH === '0' ? [] : music.searchSongs(query),
      // Deliberately no-op: never delete official FeiNiu Music files.
      delete: async (id) => { await music.markDeleted(Number(id)); },
      create: async () => { throw new Error('remote song import is disabled on fnOS'); },
      update: async (id) => music.getSongById(Number(id)),
      download: async () => { throw new Error('songs.download is not supported on fnOS'); },
      organizePreview: async () => [],
      organize: async () => [],
      refreshMetadata: async (ids) => ({ accepted: 0, skipped: ids.length }),
    },

    playlists: {
      list: () => music.listPlaylists(),
      getById: (id) => music.getPlaylistById(Number(id)),
      getSongs: (id, options) => music.getPlaylistSongs(Number(id), options),
      search: (query, options) => music.searchPlaylists(query, options),
      addSongs: (id, songIds) => music.addPlaylistSongs(Number(id), songIds),
      removeSongs: (id, songIds) => music.removePlaylistSongs(Number(id), songIds),
      create: async (input) => music.createPlaylist(input),
      update: async (id) => music.getPlaylistById(Number(id)),
      delete: async (id) => music.deletePlaylist(Number(id)),
      reorder: async () => { throw new Error('playlist reorder is not supported'); },
    },

    plugin: {
      // URLBuilder puts this first in the playback URL; keep it stable.
      getToken: async () => cfg.token,
      getHostUrl: async () => `http://127.0.0.1:${cfg.port}`,
      // SDK contract is Promise<string[]>: main.ts filters with
      // `typeof x === 'string'` and the settings page renders this list into
      // the server_host dropdown. Returning objects silently breaks both.
      // Skip Docker/bridge interfaces so the speaker is not pointed at a
      // container-internal address.
      getNetworkAddresses: async () => {
        // The container uses a bridge network, so os.networkInterfaces() only
        // sees 172.x addresses. Put the explicitly configured NAS LAN IP first
        // so the settings-page dropdown offers the address the speaker needs.
        const out = [];
        const preferred = (process.env.FNMUSIC_NAS_IP || '').trim();
        if (preferred) out.push(preferred);
        // main.ts compares these strings against the full server_host URL when
        // warning about a stale address; include it too, otherwise every boot
        // logs a false "音箱将无法访问" warning on a bridge-network container.
        const full = (process.env.MIOT_SERVER_HOST
          || (preferred ? `http://${preferred}:${cfg.publicPort}` : '')).trim();
        if (full) out.push(full.replace(/\/$/, ''));
        for (const [name, list] of Object.entries(os.networkInterfaces())) {
          if (/^(docker|br-|veth|tun|tap|virbr|flannel|cni)/.test(name)) continue;
          for (const item of list || []) {
            if (item.family === 'IPv4' && !item.internal) out.push(item.address);
          }
        }
        return [...new Set(out)];
      },
    },

    net: {
      httpStream: createHttpStream,
      ...udp,
      // TCP helpers are not used by the plugin; expose explicit failures.
      tcpConnect: async () => { throw new Error('tcpConnect is not implemented'); },
    },

    comm: {
      onMessage: (action, handler) => { commHandlers.set(action, handler); },
      call: async () => null,
      send: async () => {},
      // Independent process: no other plugins will register search sources.
      registry: () => [...commHandlers.keys()],
    },
  };

  Object.defineProperty(globalThis, 'songloft', {
    value: songloft,
    configurable: true,
    writable: true,
  });
  return songloft;
}
