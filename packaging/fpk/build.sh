#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# fnmusic-miot fpk 打包脚本（本地与 CI 共用）
# 组装应用骨架 + 仓库主体 → fnpack build → dist/fnmusic-miot-<版本>.fpk
#
# 用法:
#   packaging/fpk/build.sh                     # 完整打包（fnpack 缺失时自动下载）
#   packaging/fpk/build.sh --stage-only DIR    # 只组装不打包（结构测试用）
#   packaging/fpk/build.sh --fnpack /path/fnpack --out dist
# 环境变量: FNPACK_VERSION（默认 1.2.3）
# ==============================================================================

FPK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${FPK_DIR}/../.." && pwd)"
VERSION="$(cat "${REPO_ROOT}/VERSION")"
if [ -z "${VERSION}" ]; then
    echo "ERROR: 无法读取 ${REPO_ROOT}/VERSION" >&2
    exit 1
fi

FNPACK_BIN="${FNPACK:-}"
STAGE_ONLY=0
STAGE=""
OUT_DIR="${REPO_ROOT}/dist"

while [ $# -gt 0 ]; do
    case "$1" in
        --stage-only)
            [ $# -ge 2 ] || { echo "用法: $0 --stage-only <dir>" >&2; exit 1; }
            STAGE_ONLY=1
            STAGE="$2"
            shift 2
            ;;
        --fnpack)
            [ $# -ge 2 ] || { echo "用法: $0 --fnpack <path>" >&2; exit 1; }
            FNPACK_BIN="$2"
            shift 2
            ;;
        --out)
            [ $# -ge 2 ] || { echo "用法: $0 --out <dir>" >&2; exit 1; }
            OUT_DIR="$2"
            shift 2
            ;;
        -h|--help)
            sed -n '3,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo "未知参数: $1" >&2
            exit 1
            ;;
    esac
done

if [ -z "${STAGE}" ]; then
    STAGE="${FPK_DIR}/.build/fpk"
fi

command -v rsync >/dev/null 2>&1 || {
    echo "ERROR: 需要 rsync（Debian: sudo apt-get install -y rsync）" >&2
    exit 1
}

# ------------------------------------------------------------------------------
# 1. 组装打包目录
# ------------------------------------------------------------------------------
rm -rf "${STAGE}"
mkdir -p "${STAGE}/app/repo" "${STAGE}/app/ui"

# 仓库主体（排除开发文件、前端源码与本地秘密）。
# 原生部署（2.0.0 起）不再需要容器：container/、docker-compose.yml 与旧 Python 版
# webui/ 一并排除，只保留 nodeconsole/（控制台网关）与 runtime/（进程守护）。
# .env 是安装时由安装脚本生成的，不进包。
# 已废弃的 Songloft 薄壳插件（plugin/ + scripts/build-plugin.mjs）也显式排除，
# 即使源码树里被误恢复，也不会混进正式包。
rsync -a --delete \
    --exclude='.env' --exclude='.env.*' \
    --exclude='.git/' --exclude='.git*' \
    --exclude='.github/' --exclude='.zcode/' --exclude='.cursor/' --exclude='.agents/' \
    --exclude='.tasks_archive/' --exclude='.tools/' \
    --exclude='packaging/' --exclude='dist/' \
    --exclude='tests/' --exclude='docs/' \
    --exclude='**/__pycache__/' --exclude='*.pyc' --exclude='*.log' --exclude='*.logzip' \
    --exclude='miot-service/frontend/' --exclude='miot-service/src/' --exclude='miot-service/tests/' \
    --exclude='container/' --exclude='docker-compose.yml' --exclude='.dockerignore' \
    --exclude='webui/' \
    --exclude='miot-data/' \
    --exclude='plugin/' --exclude='scripts/build-plugin.mjs' \
    --exclude='*.sock' \
    --exclude='**/node_modules/' --exclude='*.fpk' \
    "${REPO_ROOT}/" "${STAGE}/app/repo/"

# 正式和预发布的 manifest 均保留数字 -N；通道另存 RELEASE_CHANNEL。
sed "s/@VERSION@/${VERSION}/" "${FPK_DIR}/manifest.in" > "${STAGE}/manifest"
cp "${FPK_DIR}/ICON.PNG" "${FPK_DIR}/ICON_256.PNG" "${STAGE}/"
cp -a "${FPK_DIR}/app/ui/." "${STAGE}/app/ui/"
cp -a "${FPK_DIR}/cmd" "${STAGE}/cmd"
cp -a "${FPK_DIR}/config" "${STAGE}/config"
cp -a "${FPK_DIR}/wizard" "${STAGE}/wizard"
chmod +x "${STAGE}"/cmd/*

echo "[fpk] 组装完成: ${STAGE} (version=${VERSION})"

if [ "${STAGE_ONLY}" -eq 1 ]; then
    exit 0
fi

# ------------------------------------------------------------------------------
# 2. fnpack 打包
# ------------------------------------------------------------------------------
if [ -z "${FNPACK_BIN}" ]; then
    if command -v fnpack >/dev/null 2>&1; then
        FNPACK_BIN="$(command -v fnpack)"
    else
        case "$(uname -m)" in
            x86_64) FNARCH=amd64 ;;
            aarch64|arm64) FNARCH=arm64 ;;
            *) echo "ERROR: 不支持的架构 $(uname -m)" >&2; exit 1 ;;
        esac
        FNPACK_VERSION="${FNPACK_VERSION:-1.2.3}"
        TOOLS_DIR="${REPO_ROOT}/.tools"
        FNPACK_BIN="${TOOLS_DIR}/fnpack"
        if [ ! -x "${FNPACK_BIN}" ] || ! "${FNPACK_BIN}" --help >/dev/null 2>&1; then
            mkdir -p "${TOOLS_DIR}"
            echo "[fpk] 下载 fnpack ${FNPACK_VERSION} (linux-${FNARCH})..."
            curl -fsSL -o "${FNPACK_BIN}" \
                "https://static2.fnnas.com/fnpack/fnpack-${FNPACK_VERSION}-linux-${FNARCH}"
            chmod +x "${FNPACK_BIN}"
        fi
    fi
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT
if ! (cd "${WORK_DIR}" && "${FNPACK_BIN}" build --directory "${STAGE}"); then
    echo "ERROR: fnpack build 失败" >&2
    exit 1
fi

BUILT="$(find "${WORK_DIR}" "${STAGE}" -maxdepth 2 -name '*.fpk' -print -quit 2>/dev/null || true)"
if [ -z "${BUILT}" ]; then
    echo "ERROR: 未找到 fnpack 生成的 .fpk 文件" >&2
    exit 1
fi

mkdir -p "${OUT_DIR}"
FINAL="${OUT_DIR}/fnmusic-miot-${VERSION}.fpk"
mv "${BUILT}" "${FINAL}"
( cd "$(dirname "${FINAL}")" && sha256sum "$(basename "${FINAL}")" > "$(basename "${FINAL}").sha256" )

echo "[fpk] 打包完成: ${FINAL}"
