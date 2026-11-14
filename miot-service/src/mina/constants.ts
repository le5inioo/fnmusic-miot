// MIoT 智能音箱插件 - Mina API 常量定义
// 翻译自 Go 源码: plugins/songloft-plugin-xiaomi/pkg/mina/constants.go

import ttsCommandData from '../data/tts-commands.json';

/** 平台账号服务基础 URL */
export const ACCOUNT_BASE_URL = 'https://account.xiaomi.com';

/** 小爱音箱 API 主机 */
export const MINA_API_HOST = 'api2.mina.mi.com';

/** 小爱音箱 API 基础 URL */
export const MINA_API_BASE_URL = `https://${MINA_API_HOST}`;

/** 小爱音箱服务标识符 */
export const MINA_SID = 'micoapi';

/** 米家 / MIoT 服务标识符（用于 MiIO RPC） */
export const XIAOMI_IO_SID = 'xiaomiio';

/** 米家 MiIO API 基础 URL */
export const MIIO_API_BASE_URL = 'https://api.io.mi.com/app';

/** MiIO API User-Agent（与 mi-gpt / mi-service-lite 的 MiIOT 请求对齐） */
export const MIIO_USER_AGENT = 'MICO/AndroidApp/@SHIP.TO.2A2FE0D7@/2.4.40';

/** 用户代理模板（%s 将被替换为 deviceID） */
export const USER_AGENT_TEMPLATE = 'Android-7.1.1-1.0.0-ONEPLUS A3010-136-%s APP/xiaomi.smarthome APPV/62830';

/** 默认 HTTP 超时时间（毫秒） */
export const DEFAULT_HTTP_TIMEOUT = 30000;

/** serviceToken 有效期（小时） */
export const SERVICE_TOKEN_VALID_HOURS = 12;

/** serviceToken 主动刷新阈值（小时），剩余时间低于此值时触发刷新 */
export const TOKEN_REFRESH_THRESHOLD_HOURS = 3;

/** 小爱对话记录 API 模板 */
export const LATEST_ASK_API_TEMPLATE = 'https://userprofile.mina.mi.com/device_profile/v2/conversation?source=dialogu&hardware=%s&timestamp=%d&limit=%l';

/** 最大重定向次数 */
export const MAX_REDIRECTS = 10;

/** 最大重试次数（对话记录API） */
export const MAX_RETRIES = 3;

/** 登录状态 */
export const LoginState = {
  SUCCESS: 'success' as const,
  NEED_CAPTCHA: 'need_captcha' as const,
  NEED_VERIFY: 'need_verify' as const,
  FAILED: 'failed' as const,
};

export type LoginStateType = typeof LoginState[keyof typeof LoginState];

/**
 * 需要通过 Mina ubus 方式获取对话记录的设备型号列表
 * 这些设备不支持 LATEST_ASK_API，需要使用 ubus nlp_result_get 接口
 */
export const GET_ASK_BY_MINA: string[] = ['M01'];

/**
 * 默认走 PlayByMusicURL（player_play_music）接口的设备型号。
 * 用户可在配置中把某个型号加入 music_api_model_disabled 让它改走 player_play_url，
 * 或加入 music_api_model_enabled 让不在默认清单里的新型号也走 Music API。
 * 后者是通用兼容入口：小米每年都会发布新型号（例如 2026 年的 OH1P /
 * Xiaomi Sound 2 Pro），不必等插件发版，用户自己就能勾选试出来。
 */
export const DEFAULT_MUSIC_API_MODELS: readonly string[] = [
  'X08C',
  'X08E',
  'X8S',
  'X8F',
  'X4B',
  'LX05',
  'OH11',
  'OH2',
  'OH2P',
  // OH 系列同代 Sound / Sound Pro：TTS command 均为 "7-3"，与已在表内的
  // OH11 / OH2P 属同一播放链路。OH1P = xiaomi.wifispeaker.oh1p (米家 ID 26845)。
  'OH1P',
  'OH1M',
  'OH8',
  'OH27',
  'X6A',
  'LX04',
  'L05B',
  'L05C',
  'LX06',
  'L06A',
  'X08A',
  'X10A',
  'L15A',
  'L16A',
  'L17A',
];

/**
 * 支持通过 MIoT action 播放 TTS 的设备型号。
 * 映射值为 xiaomusic 的 TTS command: "<siid>-<aiid>"（intelligent-speaker 服务的 play-text action）。
 *
 * 数据源:src/data/tts-commands.json,由 `npm run sync:tts` 从 miot-spec 同步补充,
 * 人工确认的别名(如 ASX4B)与冲突值以该文件为准。切勿在此处硬编码。
 */
export const TTS_COMMAND: Record<string, string> = ttsCommandData;

/**
 * 判断指定硬件型号是否需要通过 Mina 方式获取对话记录
 */
export function shouldUseMinaForAsk(hardware: string): boolean {
  return GET_ASK_BY_MINA.includes(hardware);
}

/**
 * 判断指定硬件型号是否需要使用 player_play_music API
 *
 * 优先级：用户显式禁用 > 用户显式启用 > 内置默认清单 > 直链播放。
 * 型号统一按大写比较，允许配置里写小写或带空格。
 *
 * @param disabledModels - 用户显式禁用 Music API 的型号列表（最高优先级）
 * @param enabledModels - 用户显式启用 Music API 的型号列表（可覆盖默认清单之外的型号）
 */
export function needUsePlayMusicAPI(
  hardware: string,
  disabledModels?: string[],
  enabledModels?: string[],
): boolean {
  const hw = String(hardware || '').trim().toUpperCase();
  if (!hw) return false;
  const normalize = (list?: string[]): string[] => Array.isArray(list)
    ? list.map((m) => String(m || '').trim().toUpperCase()).filter(Boolean)
    : [];
  if (normalize(disabledModels).includes(hw)) return false;
  if (normalize(enabledModels).includes(hw)) return true;
  return DEFAULT_MUSIC_API_MODELS.includes(hw);
}

/**
 * 获取指定硬件型号的 MIoT TTS command。
 */
export function getTTSCommand(hardware: string): string {
  return TTS_COMMAND[hardware] || '';
}

/**
 * 格式化 UserAgent（替换 %s 为 deviceID）
 */
export function formatUserAgent(deviceId: string): string {
  return USER_AGENT_TEMPLATE.replace('%s', deviceId);
}

/**
 * 格式化对话记录API URL
 */
export function formatLatestAskUrl(hardware: string, timestamp: number, limit = 2): string {
  return LATEST_ASK_API_TEMPLATE.replace('%s', hardware).replace('%d', String(timestamp)).replace('%l', String(limit));
}
