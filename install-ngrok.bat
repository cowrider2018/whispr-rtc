@echo off
rem Downloads the official ngrok binary into this project folder (ngrok.exe).
rem Run this once; then copy .env.example to .env, paste your NGROK_AUTHTOKEN,
rem and run start-call.bat. ngrok.exe is gitignored (never committed).
title install-ngrok
cd /d "%~dp0"

if exist "ngrok.exe" (
    echo ngrok.exe is already installed:
    ngrok.exe version
    echo.
    echo Delete ngrok.exe and re-run this script to reinstall.
    pause
    exit /b 0
)

echo Downloading ngrok (official) for Windows...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {'arm64'} else {'amd64'}; $url = 'https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-' + $arch + '.zip'; $zip = Join-Path (Get-Location) 'ngrok.zip'; Write-Host ('Fetching ' + $url); try { Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing } catch { Write-Host ('Download failed: ' + $_.Exception.Message); exit 1 }; try { Expand-Archive -Path $zip -DestinationPath (Get-Location) -Force } catch { Write-Host ('Extract failed: ' + $_.Exception.Message); exit 1 }; Remove-Item $zip -Force -ErrorAction SilentlyContinue; if (Test-Path 'ngrok.exe') { Write-Host 'ngrok.exe installed.' } else { Write-Host 'ngrok.exe not found after extract.'; exit 1 }"

if errorlevel 1 (
    echo.
    echo [ERROR] Automatic install failed.
    echo Download manually from https://ngrok.com/download and put ngrok.exe in this folder.
    pause
    exit /b 1
)

echo.
ngrok.exe version
echo.
echo Done. Next: copy .env.example to .env, paste NGROK_AUTHTOKEN, run start-call.bat.
pause
