@echo off
echo Stopping LingShu...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :17890') do taskkill /F /PID %%a 2>nul
echo Done.
