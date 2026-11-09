// Reproduce the Songloft host's fetch semantics on top of Node 24 fetch.
//
// src/utils/http.ts depends on four host-specific behaviours:
//   1. X-Fetch-No-Redirect: 1  -> redirect:'manual' (login walks 3xx hops
//      itself and collects intermediate Set-Cookie values)
//   2. X-Fetch-Timeout-Ms      -> AbortSignal.timeout
//   3. getSetCookie(resp) from @songloft/plugin-sdk must see an UNFOLDED
//      array of Set-Cookie headers (undici folds them into one comma string)
//   4. Object.keys(resp.headers) must enumerate real header names -- the
//      plugin copies them into a plain object (ResponseHeaders).
//
// Without this shim, Xiaomi account/password and QR logins both fail.

export const nativeFetch = globalThis.fetch.bind(globalThis);

function shimResponse(resp) {
  const headerObj = {};
  for (const [k, v] of resp.headers.entries()) headerObj[k] = v;

  const setCookies = typeof resp.headers.getSetCookie === 'function'
    ? resp.headers.getSetCookie()
    : (headerObj['set-cookie'] ? [headerObj['set-cookie']] : []);
  if (setCookies.length) headerObj['set-cookie'] = setCookies;

  // SDK getSetCookie() prefers this method; keep it non-enumerable so the
  // plugin's Object.keys() copy only sees real headers.
  Object.defineProperty(headerObj, 'getSetCookie', {
    value: () => setCookies.slice(),
    enumerable: false,
  });

  const bufPromise = resp.arrayBuffer();
  const decode = (b) => new TextDecoder().decode(b);

  return {
    ok: resp.ok,
    status: resp.status,
    statusText: resp.statusText || '',
    headers: headerObj,
    text: () => bufPromise.then(decode),
    json: () => bufPromise.then((b) => JSON.parse(decode(b))),
    arrayBuffer: () => bufPromise,
  };
}

async function hostFetch(input, init = {}) {
  const headers = new Headers(init.headers || {});
  const noRedirect = headers.get('X-Fetch-No-Redirect') === '1';
  const timeoutRaw = headers.get('X-Fetch-Timeout-Ms');
  headers.delete('X-Fetch-No-Redirect');
  headers.delete('X-Fetch-Timeout-Ms');

  const opts = { ...init, headers };
  if (noRedirect) opts.redirect = 'manual';
  if (timeoutRaw) {
    const ms = Math.max(100, Number(timeoutRaw) || 30000);
    opts.signal = init.signal ?? AbortSignal.timeout(ms);
  }

  const resp = await nativeFetch(input, opts);
  return shimResponse(resp);
}

export function installHostFetch() {
  Object.defineProperty(globalThis, 'fetch', {
    value: hostFetch,
    configurable: true,
    writable: true,
  });
}

// Pull-based HTTPStream used by songloft.net.httpStream (AI SSE).
// SDK shape: { response: Promise<{status, headers: Record<string,string[]>}>,
//              read(): Promise<Uint8Array|null>, cancel(): Promise<void> }
export function createHttpStream(url, options = {}) {
  const controller = new AbortController();
  const timer = options.timeoutMs
    ? setTimeout(() => controller.abort(), Math.max(100, Number(options.timeoutMs) || 30000))
    : null;

  const ready = nativeFetch(url, {
    method: options.method || 'GET',
    headers: options.headers || {},
    body: options.body,
    signal: controller.signal,
  }).then((resp) => {
    const headers = {};
    for (const [k, v] of resp.headers.entries()) {
      headers[k] = (headers[k] || []).concat(v);
    }
    const reader = resp.body?.getReader() || null;
    return { response: { status: resp.status, headers }, reader };
  });

  let cancelled = false;
  return {
    response: ready.then((r) => r.response),
    async read() {
      if (cancelled) return null;
      const { reader } = await ready;
      if (!reader) return null;
      const { done, value } = await reader.read();
      return done ? null : value;
    },
    async cancel() {
      cancelled = true;
      if (timer) clearTimeout(timer);
      controller.abort();
      try {
        const { reader } = await ready;
        await reader?.cancel();
      } catch { /* already closed */ }
    },
  };
}
