@echo off
rem Stop the voice call service: kill the node server on port 3000
rem (by PID, so unrelated node processes are untouched) and cloudflared.

echo Stopping voice call server (port 3000)...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000 " ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)

echo Stopping tunnel...
taskkill /F /IM ngrok.exe >nul 2>&1
taskkill /F /IM cloudflared.exe >nul 2>&1

rem Close the leftover tunnel window opened by start-call.bat
taskkill /F /FI "WINDOWTITLE eq voice-call-tunnel*" >nul 2>&1

echo Done.
pause
