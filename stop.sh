#!/usr/bin/env bash
# 灵枢 AI 中枢 — 停止（macOS / Linux）
cd "$(dirname "$0")"
PORT=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('data/config.json','utf8').replace(/^\uFEFF/,'')).app.port)}catch(e){console.log(17890)}")
PIDS=$( { lsof -ti tcp:"$PORT" 2>/dev/null || ss -lptn "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2; } | sort -u )
if [ -z "$PIDS" ]; then
  echo "没有发现正在运行的服务（端口 $PORT）"
  exit 0
fi
for pid in $PIDS; do
  kill "$pid" 2>/dev/null && echo "  已结束进程 PID=$pid"
done
echo "完成。"
