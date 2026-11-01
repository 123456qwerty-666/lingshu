#!/usr/bin/env bash
# 灵枢 AI 中枢 — 启动（macOS / Linux）
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "找不到 node，请先安装 Node.js ≥ 20： https://nodejs.org"
  exit 1
fi

if [ ! -f data/config.json ]; then
  echo "[首次运行] 正在初始化..."
  node scripts/bootstrap.mjs
  echo
fi

echo "========================================"
echo "  灵枢 AI 中枢 LingShu Hub"
echo "========================================"
echo "  控制台: http://127.0.0.1:17890"
echo "  停止:   Ctrl+C"
echo "========================================"

exec node server/index.mjs
