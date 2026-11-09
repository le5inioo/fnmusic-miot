// Bundle songloft-plugin-miot/src/main.ts into a single Node-ESM file.
//
// Why not unpack miot.jsplugin.zip: the released main.js is a QuickJS-target
// bundle and we must patch url_builder.ts / lyric.ts / online_searcher.ts and
// frontend api.ts. Building from source keeps those edits maintainable and
// keeps upstream cherry-picks possible.
//
// Usage:
//   MIOT_SRC=/srv/miot-service/miot-src node build.mjs
//   (default points at the research clone in this workspace)

import { build } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Keep the directory name "src" (same as the upstream repo): the Vue panel
// imports ../../../../src/chat/types and ../../src/utils/ai_headers across the
// tree. Renaming it to miot-src breaks `vite build`.
const MIOT_SRC = path.resolve(process.env.MIOT_SRC || path.resolve(ROOT, 'src'));
const ENTRY = path.join(MIOT_SRC, 'main.ts');
// `bundle/` (not `dist/`): packaging/fpk/build.sh excludes every directory
// named "dist", so a prebuilt bundle under dist/ would silently vanish from
// the fpk. Keeping the prebuilt artifact lets the image build fully offline.
const OUT = path.resolve(process.env.MIOT_OUT || path.join(ROOT, 'bundle/main.js'));

if (!fs.existsSync(ENTRY)) {
  console.error(`[build] cannot find ${ENTRY}`);
  console.error('[build] set MIOT_SRC to the directory containing main.ts (songloft-plugin-miot/src)');
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });

await build({
  entryPoints: [ENTRY],
  outfile: OUT,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: false,
  legalComments: 'none',
  loader: { '.json': 'json' },
  // The miot source tree lives outside this package during development, so
  // point module resolution at our own node_modules explicitly.
  nodePaths: [path.resolve(ROOT, 'node_modules')],
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  // @songloft/plugin-sdk ships real runtime code (createRouter, parseQuery,
  // jsonResponse, getSetCookie, parseSetCookie). Keep it external so npm's
  // ESM build is used verbatim instead of reimplementing it.
  external: [],
});

console.log(`[build] wrote ${OUT}`);

// The Vue panel is built separately with its own Vite config:
//   npm ci --prefix <miot-repo>/frontend && npm run build --prefix <miot-repo>/frontend
// then copy <miot-repo>/static -> ./static (and patch api.ts pluginBase first).
