@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist "data\config.json" (
  echo [首次运行] 正在初始化...
  node scripts\bootstrap.mjs
  echo.
)

echo ========================================
echo   灵枢 AI 中枢 LingShu Hub
echo ========================================
echo   控制台: http://127.0.0.1:17890
echo   停止:   Ctrl+C 或双击 stop.cmd
echo ========================================
echo.

node server\index.mjs

if errorlevel 1 (
  echo.
  echo [服务异常退出] 上一次的报错在上方，或查看 data\server.log
  pause
)
