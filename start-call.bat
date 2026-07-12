@echo off
rem Start the voice call service in a single window:
rem   - node server runs hidden (no console window)
rem   - ngrok runs right here; this window becomes "voice-call-tunnel"
rem
rem One-time setup:
rem   1. Paste your authtoken into ngrok.yml (this folder).
rem      Get it at: https://dashboard.ngrok.com/get-started/your-authtoken
rem   2. (Optional) Claim a free static domain at https://dashboard.ngrok.com/domains
rem      and put it on the first line of ngrok-domain.txt (this folder).
rem      Both ngrok.yml and ngrok-domain.txt are gitignored, so your token
rem      and personal URL never land in the repo.
title voice-call-tunnel
cd /d "%~dp0"

rem Read the fixed domain from an untracked file so it stays out of git.
set "NGROK_DOMAIN="
if exist "ngrok-domain.txt" set /p NGROK_DOMAIN=<ngrok-domain.txt

findstr /C:"PASTE_YOUR_AUTHTOKEN_HERE" ngrok.yml >nul 2>&1
if %errorlevel%==0 (
    echo [ERROR] ngrok.yml still contains the placeholder authtoken.
    echo Get yours at https://dashboard.ngrok.com/get-started/your-authtoken
    echo paste it into ngrok.yml, then run this script again.
    pause
    exit /b 1
)

if not exist node_modules (
    echo Installing dependencies...
    call npm install
)

netstat -ano | findstr ":3000 " | findstr "LISTENING" >nul
if %errorlevel%==0 (
    echo Server already running on port 3000, reusing it.
) else (
    echo Starting voice call server on port 3000 in the background...
    powershell -NoProfile -Command "Start-Process node -ArgumentList 'server.js' -WindowStyle Hidden"
)

echo.
if "%NGROK_DOMAIN%"=="" (
    echo No ngrok-domain.txt found - starting with a random URL.
    echo For a fixed URL: claim a free domain at https://dashboard.ngrok.com/domains
    echo and put it on the first line of ngrok-domain.txt in this folder.
    echo.
    ngrok http 3000 --config ngrok.yml
) else (
    echo Fixed URL: https://%NGROK_DOMAIN%
    echo Run stop-call.bat to stop everything, or press Ctrl+C here.
    echo.
    ngrok http 3000 --config ngrok.yml --domain %NGROK_DOMAIN%
)
