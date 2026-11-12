import type { ApiEnvelope } from './types';

// fnOS / fnmusic-ext 部署：面板由 webui-service 的同源反代挂在
// /app/fnmusic-ext/miot/* 下（DesktopPrefixMiddleware 先剥掉 /app/fnmusic-ext，
// 再由 /miot/{path} 反代到容器内 127.0.0.1:8005 的同名路径）。
//
// 原实现从页面路径里正则提取 /api/v1/jsplugin/<name> 之前的前缀，但这里页面
// 路径是 /app/fnmusic-ext/miot/index.html，不含该段，前缀会被算成空字符串，
// 所有 API 都会打到飞牛网关根路径。故固定为网关前缀。
// REST、WS、封面绝对路径、静态资源全部共用这一个前缀，反代只需一条规则。
const BASE_PATH = '/app/fnmusic-ext/miot';

export function hostPathPrefix(): string {
  return BASE_PATH;
}

function pluginBase(): string {
  return BASE_PATH;
}

export class ApiError extends Error {
  constructor(message: string, public readonly status = 0) {
    super(message);
    this.name = 'ApiError';
  }
}

function pluginApi() {
  return window.SongloftPlugin;
}

async function browserRequest<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const token = pluginApi()?.getAuthToken?.();
  const response = await fetch(`${pluginBase()}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  return decodePayload<T>(payload, response.status, response.ok);
}

async function browserEnvelope<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const token = pluginApi()?.getAuthToken?.();
  const response = await fetch(`${pluginBase()}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (await response.json()) as { success?: boolean; error?: string } & T;
  if (!response.ok || payload.success !== true) {
    throw new ApiError(payload.error || `请求失败 (${response.status})`, response.status);
  }
  return payload;
}

export function unwrap<T>(value: unknown): T {
  return decodePayload<T>(value, 0, true);
}

function decodePayload<T>(value: unknown, status: number, ok: boolean): T {
  const payload = value as Partial<ApiEnvelope<T>> | null;
  if (payload && typeof payload === 'object' && 'success' in payload) {
    if (payload.success === true) {
      return payload.data as T;
    }
    throw new ApiError(payload.error || '请求失败，请稍后重试', status);
  }
  if (!ok) {
    const detail = (payload as { detail?: string } | null)?.detail
      || (payload as { error?: string; message?: string } | null)?.error
      || (payload as { error?: string; message?: string } | null)?.message
      || `请求失败 (${status})`;
    throw new ApiError(detail, status);
  }
  return value as T;
}

export async function get<T>(path: string): Promise<T> {
  const api = pluginApi();
  if (api?.apiGet) return decodePayload<T>(await api.apiGet(path), 0, true);
  return browserRequest<T>('GET', path);
}

export async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const api = pluginApi();
  if (api?.apiPost) return decodePayload<T>(await api.apiPost(path, body), 0, true);
  return browserRequest<T>('POST', path, body);
}

export async function put<T>(path: string, body: unknown): Promise<T> {
  return browserRequest<T>('PUT', path, body);
}

export async function postEnvelope<T>(path: string, body: unknown = {}): Promise<T> {
  const api = pluginApi();
  if (api?.apiPost) {
    const payload = (await api.apiPost(path, body)) as { success?: boolean; error?: string } & T;
    if (!payload || payload.success !== true) {
      throw new ApiError(payload?.error || '请求失败，请稍后重试');
    }
    return payload;
  }
  return browserEnvelope<T>('POST', path, body);
}

export async function del<T>(path: string): Promise<T> {
  const api = pluginApi();
  if (api?.apiDelete) return decodePayload<T>(await api.apiDelete(path), 0, true);
  return browserRequest<T>('DELETE', path);
}

export function query(params: Record<string, string | number | boolean | undefined>): string {
  const values: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') {
      values.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }
  return values.length ? `?${values.join('&')}` : '';
}

export function pluginWebSocketUrl(path: string): string {
  const location = window.location;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = pluginApi()?.getAuthToken?.() || '';
  return `${protocol}//${location.host}${pluginBase()}${path}${path.includes('?') ? '&' : '?'
    }${token ? `access_token=${encodeURIComponent(token)}` : ''}`;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '未知错误');
}

/**
 * 宿主级（Node / 控制层）原始接口调用助手，用于不经过插件 QuickJS、由宿主
 * `server.mjs` 直接处理的路由（如 /diagnostics/*、/ports/*）。
 * 与插件 REST 不同，这些接口直接返回 `{ success, ... }`（数据内联而非包在
 * `.data`），因此不走 `decodePayload` 的 `.data` 解包，原样返回 JSON 体。
 * 鉴权方式与主路由一致：注入 fnOS 网关 token。
 */
export async function hostRequest<T = unknown>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const token = window.SongloftPlugin?.getAuthToken?.() || '';
  const response = await fetch(`${hostPathPrefix()}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const detail =
      (payload as { error?: string; message?: string } | null)?.error
      || (payload as { error?: string; message?: string } | null)?.message
      || `请求失败 (${response.status})`;
    throw new ApiError(detail, response.status);
  }
  return payload as T;
}
