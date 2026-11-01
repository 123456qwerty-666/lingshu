@echo off
chcp 65001 >nul
echo 正在停止灵枢服务（端口 17890）...
set FOUND=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":17890" ^| findstr "LISTENING"') do (
  taskkill /F /PID %%a >nul 2>&1
  echo   已结束进程 PID=%%a
  set FOUND=1
)
if "%FOUND%"=="0" echo   没有发现正在运行的服务
echo 完成。
timeout /t 2 >nul
