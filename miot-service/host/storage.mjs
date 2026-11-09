// songloft.storage replacement: async string KV persisted to one JSON file.
//
// ConfigManager caches in memory and saves concurrently; ChatMemoryService
// uses a revision-based optimistic lock. Writes therefore MUST be serialised
// and must be atomic, otherwise accounts/tokens/playlist progress are lost.

import fs from 'node:fs';
import path from 'node:path';

export function createStorage(filePath, logger = console) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  let data = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn?.(`[storage] cannot read ${filePath}: ${err.message}`);
  }

  function flush() {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  }

  let queue = Promise.resolve();
  const enqueue = (fn) => {
    queue = queue.then(fn).catch((err) => {
      logger.error?.(`[storage] write failed: ${err.stack || err.message}`);
      throw err;
    });
    return queue;
  };

  // Songloft's Go host stores each value as a JSON-encoded string and returns
  // that string from get(); ConfigManager then does JSON.parse(raw) once.
  // Exports taken straight from jsplugins_data/miot/data are DOUBLE encoded
  // (the file contains a JSON string whose content is again JSON text), so
  // peel exactly one layer when the first parse still yields a string.
  function decode(raw) {
    if (typeof raw !== 'string') return raw === undefined ? null : raw;
    try {
      const once = JSON.parse(raw);
      if (typeof once === 'string') return once;
    } catch { /* plain string value */ }
    return raw;
  }

  return {
    async get(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? decode(data[key]) : null;
    },
    set(key, value) {
      // Plugin code always passes JSON.stringify(...) already; keep strings
      // verbatim and serialise anything else instead of producing
      // "[object Object]" (which would break every subsequent load()).
      return enqueue(() => {
        data[String(key)] = typeof value === 'string' ? value : JSON.stringify(value);
        flush();
      });
    },
    delete(key) {
      return enqueue(() => { delete data[String(key)]; flush(); });
    },
    async keys() {
      return Object.keys(data);
    },
    // Import a Songloft export (jsplugins_data/miot/data) verbatim: key names
    // such as accounts / ai_config / voice_commands / memory:v1:records match.
    import(entries) {
      return enqueue(() => {
        Object.assign(data, entries);
        flush();
      });
    },
    snapshot() {
      return { ...data };
    },
  };
}
