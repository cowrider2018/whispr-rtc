@echo off
rem Start the voice call service:
rem   - node server runs hidden (no console window)
rem   - ngrok runs hidden; this window prints the public URL to share
rem
rem One-time setup: run install-ngrok.bat, then copy .env.example to .env and
rem paste your NGROK_AUTHTOKEN.
rem   Get it at https://dashboard.ngrok.com/get-started/your-authtoken
rem   Nothing else to configure - the public URL is read back from ngrok.
title voice-call-tunnel
cd /d "%~dp0"

rem Prefer the project-local ngrok.exe (installed by install-ngrok.bat);
rem fall back to a ngrok on PATH.
set "NGROK_BIN=ngrok"
if exist "ngrok.exe" set "NGROK_BIN=%~dp0ngrok.exe"
if "%NGROK_BIN%"=="ngrok" (
    where ngrok >nul 2>&1
    if errorlevel 1 (
        echo [ERROR] ngrok not found. Run install-ngrok.bat first.
        pause
        exit /b 1
    )
)

rem Load config from .env (only NGROK_AUTHTOKEN is required; # lines skipped).
rem ngrok reads NGROK_AUTHTOKEN from the environment automatically.
if exist ".env" for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do set "%%a=%%b"

if "%NGROK_AUTHTOKEN%"=="" (
    echo [ERROR] NGROK_AUTHTOKEN is not set.
    echo Copy .env.example to .env and paste your ngrok authtoken.
    echo Get it at https://dashboard.ngrok.com/get-started/your-authtoken
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

rem Optional fixed domain; otherwise ngrok assigns one from your account/token.
set "NGROK_ARGS=http 3000 --log stdout"
if not "%NGROK_DOMAIN%"=="" set "NGROK_ARGS=%NGROK_ARGS% --domain %NGROK_DOMAIN%"
echo Starting tunnel...
powershell -NoProfile -Command "Start-Process '%NGROK_BIN%' -ArgumentList '%NGROK_ARGS%' -WindowStyle Hidden"

rem Derive the public URL from ngrok's local API (no domain to configure).
echo Reading public URL from ngrok...
powershell -NoProfile -Command "$u=$null; for($i=0;$i -lt 30 -and -not $u;$i++){try{$u=((Invoke-RestMethod http://127.0.0.1:4040/api/tunnels).tunnels | ?{$_.proto -eq 'https'})[0].public_url}catch{}; if(-not $u){Start-Sleep -Milliseconds 700}}; if($u){Write-Host ''; Write-Host ('  Share this link:  ' + $u); Write-Host ''}else{Write-Host 'Could not read tunnel URL - open http://127.0.0.1:4040 to see it.'}"

echo.
echo Tunnel + server run in the background. Run stop-call.bat to stop everything.
pause
