// MIoT 智能音箱插件 - URL构造器
// 翻译自 Go 源码: plugins/songloft-plugin-xiaomi/player/url_builder.go

import { getHostBaseUrl } from '../utils/http';

function isLoopbackUrl(url: string): boolean {
  const protoIdx = url.indexOf('://');
  if (protoIdx < 0) return false;
  const rest = url.slice(protoIdx + 3);
  const slashIdx = rest.indexOf('/');
  const colonIdx = rest.indexOf(':');
  const host = rest.slice(0, slashIdx >= 0 ? Math.min(slashIdx, colonIdx >= 0 ? colonIdx : slashIdx) : (colonIdx >= 0 ? colonIdx : undefined)).toLowerCase();
  return host === 'localhost' || host.startsWith('127.') || host === '::1';
}

/** buildSongURL 的选项。baseUrl 见 buildSongURL 的 @param 说明。 */
export interface PlaybackURLOptions {
  forceMp3?: boolean;
  radioForceMp3?: boolean;
  normalize?: boolean;
  seekSeconds?: number;
  speed?: number;
  baseUrl?: string;
}

/**
 * 从插件配置推导播放 URL 选项（同步版，已经有 config 对象时用）。
 *
 * 所有把 URL 推给音箱的地方都必须经这里，不要各自手写读 config——独立歌曲直推路径
 * 当初就是漏了 force_mp3，音箱拿到不能解码的流后亮灯不出声
 * （songloft-org/songloft-plugin-miot#62）。
 */
export function playbackOptionsOf(
  config: { force_mp3?: boolean; radio_force_mp3?: boolean; volume_normalize?: boolean },
  extra?: { seekSeconds?: number; speed?: number },
): PlaybackURLOptions {
  return {
    forceMp3: !!config.force_mp3,
    radioForceMp3: !!config.radio_force_mp3,
    normalize: !!config.volume_normalize,
    seekSeconds: extra?.seekSeconds,
    speed: extra?.speed,
  };
}

/**
 * 从 ConfigManager 读取播放 URL 选项（异步版）。
 * 读配置失败按全 false：宁可播源格式，也不要因为读配置失败而播不出声。
 */
export async function playbackOptionsFromConfig(
  configManager: { getConfig(): Promise<any> },
  extra?: { seekSeconds?: number; speed?: number },
): Promise<PlaybackURLOptions> {
  try {
    return playbackOptionsOf(await configManager.getConfig(), extra);
  } catch (e) {
    songloft.log.warn('[URLBuilder] 读取播放选项失败，按源格式播放: ' + String(e));
    return { seekSeconds: extra?.seekSeconds, speed: extra?.speed };
  }
}

/**
 * URL构造器 - 构造歌曲和封面的播放URL
 */
export class URLBuilder {
  /**
   * 构造歌曲播放URL（带access_token认证）
   *
   * 新架构(2026):后端 MarshalJSON 已统一处理 song.url 字段:
   * - 所有类型(local/remote/radio): /api/v1/songs/{id}/play
   *
   * @param song 歌曲对象（需要 id 和 url 字段；type 用于电台转码判定）
   * @param options.forceMp3 是否追加 format=mp3 强制服务端转码（本地/网络歌曲）
   * @param options.radioForceMp3 电台转码：仅对 type=radio 的歌曲追加 radio_transcode=mp3，
   *   让服务端把电台流实时转码为 MP3（部分音箱无法解码 AAC/HE-AAC 或不支持 HLS）。
   *   与 forceMp3 刻意分离，互不影响。
   * @param options.seekSeconds 从第 N 秒起播：追加 seek=N，服务端产出以该位置为开头的 MP3 流。
   *   音箱只会从头拉 URL，续播位置只能这样表达（songloft-org/songloft-plugin-miot#60）。
   *   电台（直播）无位置概念，自动忽略。
   * @param options.speed 播放倍速 [0.5, 2.0]，追加 speed=N，服务端用 ffmpeg atempo 滤镜实时变速
   *   不变调。1.0 或缺省不追加（避免给不支持的后端塞噪音参数）。电台、电台直播流无倍速概念，忽略。
   * @param options.baseUrl 覆盖服务器地址。默认用 getHostBaseUrl()（用户配的 server_host，
   *   那是给**音箱**访问用的局域网/公网地址）。插件自己要发请求时必须传本机 API 地址
   *   （getHostAPIBaseUrl()），否则外网部署下会变成一次 hairpin NAT 出网回环
   *   （songloft-org/songloft-plugin-miot#62 的 URL 体检就是这么失败的）。
   * @returns 播放 URL（相对路径会自动附加 access_token）
   */
  static async buildSongURL(song: {
    id?: number;
    url?: string;
    type?: string;
  }, options?: PlaybackURLOptions): Promise<string> {
    const songUrl = song.url || '';

    if (!songUrl) {
      return '';
    }

    // 外部 URL 直接返回
    if (songUrl.startsWith('http://') || songUrl.startsWith('https://')) {
      return songUrl;
    }

    // 相对路径（/api/v1/songs/{id}/play）需要附加 access_token。
    //
    // 【重要】URL 里只能有 access_token 这一个 query 参数。
    // 小米音箱固件会把 URL 中的 "&" 吞掉（或替换成空格），把后面的 "k=v" 直接
    // 拼进 access_token 的值：实测正常 token 长 48，带 "&seek=70" 时设备发来的
    // access_token 变成 56 字符（48 + "seek=70"），服务端鉴权 401，音箱随即报
    // 「播放失败请检查网络」。Go 宿主时代的 auth 中间件会按空格把 token 剥离并
    // 还原后续参数，Node 移植版没有这层兼容，所以拖动进度条/强制转码/倍速全部失效。
    // 治本做法：把播放选项编码进 path 的最后一段（/o<base64url>），query 只留
    // access_token。host/server.mjs 的路由负责解码还原成 stream 参数。
    const serverHost = options?.baseUrl ?? getHostBaseUrl();
    const accessToken = await songloft.plugin.getToken();

    const opts: Record<string, string | number> = {};
    if (options?.forceMp3) opts.f = 'mp3';
    // 电台转码只对电台生效：服务端只认 radio_transcode，其他类型忽略此参数。
    if (options?.radioForceMp3 && song.type === 'radio') opts.r = 'mp3';
    // 音量均衡：服务端 loudnorm 滤镜统一音量，需要转码。
    if (options?.normalize) opts.n = 1;
    const seek = Math.floor(options?.seekSeconds || 0);
    if (seek > 0 && song.type !== 'radio') opts.s = seek;
    const speed = options?.speed;
    if (speed && speed !== 1 && song.type !== 'radio') opts.p = speed;

    // 选项里只有 ASCII（数字与 mp3），btoa 安全；转成 URL 安全的 base64url。
    const encodeOpts = (o: Record<string, string | number>): string => {
      if (!Object.keys(o).length) return '';
      const b64 = btoa(JSON.stringify(o))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      return '/o' + b64;
    };

    const qIdx = songUrl.indexOf('?');
    const basePath = qIdx >= 0 ? songUrl.slice(0, qIdx) : songUrl;
    const carried = qIdx >= 0 ? songUrl.slice(qIdx + 1) + '&' : '';
    const url = serverHost + basePath + encodeOpts(opts)
      + '?' + carried + 'access_token=' + accessToken;

    // 诊断：把音箱被指向的 host 落日志，配合后端是否出现 /songs/{id}/play 访问行，
    // 即可判定音箱是否真的拉到了该地址（songloft-org/songloft#405）。仅 host 基址，不含 token。
    if (!options?.baseUrl) {
      songloft.log.info('[URLBuilder] speaker play host=' + serverHost + ' loopback=' + isLoopbackUrl(url) + ' songId=' + (song.id ?? '') + ' opts=' + (encodeOpts(opts) || '-'));
    }

    // 回环告警只对「给音箱用的地址」有意义；显式覆盖成本机地址时（插件自己发请求）回环是正常的。
    if (!options?.baseUrl && isLoopbackUrl(url)) {
      songloft.log.warn('[URLBuilder] 播放 URL 包含回环地址，MIoT 音箱无法访问。请在插件配置中设置正确的局域网地址（如 http://192.168.x.x:58091）');
    }

    return url;
  }
}
