// 构建 fnmusic-miot 的 songloft 薄壳插件包（.jsplugin.zip）
//
// 纯 Node 实现，无需联网安装 @songloft/plugin-builder：
//   1. 读取 plugin/plugin.json（模板，entryHash/zipHash 为空）
//   2. 计算 entryHash = sha256(static/index.html)  —— WebView 入口页
//   3. 打包 plugin/ 下文件为 zip（store，无压缩）
//   4. 计算 zipHash = sha256(不含 zipHash 字段的 zip)  —— 规避自引用
//   5. 回填 zipHash 后重新打包，输出 plugin/dist/fnmusic-miot.jsplugin.zip
//
// 产物可直接作为飞牛音乐「从文件安装插件」的包。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_DIR = path.join(ROOT, 'plugin');
const OUT_DIR = path.join(PLUGIN_DIR, 'dist');
const OUT_ZIP = path.join(OUT_DIR, 'fnmusic-miot.jsplugin.zip');

// ---- CRC32（store 模式 ZIP 需要）----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- 收集 plugin/ 下要打包的文件（相对 plugin/ 的 POSIX 路径）----
function collectFiles(dir, base = '') {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'dist') continue; // 排除产物目录
    const full = path.join(dir, ent.name);
    const rel = base ? `${base}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...collectFiles(full, rel));
    else if (ent.isFile()) out.push(rel);
  }
  return out;
}

function buildZip(files) {
  const localParts = [];
  const central = [];
  let offset = 0;

  for (const rel of files) {
    const data = fs.readFileSync(path.join(PLUGIN_DIR, rel));
    const nameBuf = Buffer.from(rel, 'utf8');
    const crc = crc32(data);
    const size = data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method = store
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18); // compressed size
    local.writeUInt32LE(size, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len

    localParts.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // central dir signature
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8); // flags
    cd.writeUInt16LE(0, 10); // method
    cd.writeUInt16LE(0, 12); // mod time
    cd.writeUInt16LE(0, 14); // mod date
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(size, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra len
    cd.writeUInt16LE(0, 32); // comment len
    cd.writeUInt16LE(0, 34); // disk number
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42); // local header offset

    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const centralOffset = offset;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central dir signature
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // disk with central dir
  end.writeUInt16LE(files.length, 8); // entries on this disk
  end.writeUInt16LE(files.length, 10); // total entries
  end.writeUInt32LE(centralBuf.length, 12); // central dir size
  end.writeUInt32LE(centralOffset, 16); // central dir offset
  end.writeUInt16LE(0, 20); // comment len

  return Buffer.concat([...localParts, centralBuf, end]);
}

// ---- 执行 ----
function main() {
  const files = collectFiles(PLUGIN_DIR).sort();
  if (!files.includes('plugin.json') || !files.includes('main.js') || !files.includes('static/index.html')) {
    console.error('[build-plugin] 缺少必需文件：plugin.json / main.js / static/index.html');
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'plugin.json'), 'utf8'));
  const entryBytes = fs.readFileSync(path.join(PLUGIN_DIR, 'static/index.html'));
  manifest.entryHash = crypto.createHash('sha256').update(entryBytes).digest('hex');

  // 第一步：zipHash 留空，用于计算「不含 zipHash 字段」的 zip 摘要
  const manifestNoZip = { ...manifest, zipHash: '' };
  fs.writeFileSync(path.join(PLUGIN_DIR, 'plugin.json'), JSON.stringify(manifestNoZip, null, 2) + '\n');
  const zipNoHash = buildZip(files);
  manifest.zipHash = crypto.createHash('sha256').update(zipNoHash).digest('hex');

  // 第二步：回填 zipHash 后重新写入并打包为最终产物
  fs.writeFileSync(path.join(PLUGIN_DIR, 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
  const finalZip = buildZip(files);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_ZIP, finalZip);

  console.log('[build-plugin] 产物:', OUT_ZIP);
  console.log('[build-plugin] 文件:', files.join(', '));
  console.log('[build-plugin] entryHash:', manifest.entryHash);
  console.log('[build-plugin] zipHash  :', manifest.zipHash);
  console.log('[build-plugin] 大小     :', finalZip.length, 'bytes');
}

main();
