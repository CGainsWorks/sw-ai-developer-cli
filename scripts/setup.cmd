@echo off
REM One-time setup for a clean checkout on Windows.
REM Mirrors scripts/setup.sh — install, build, then verify with the offline demo.

setlocal
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install Node 20 or newer: https://nodejs.org
  exit /b 1
)

echo ==^> Installing dependencies
if exist package-lock.json (
  call npm ci || exit /b 1
) else (
  call npm install || exit /b 1
)

echo.
echo ==^> Building
call npm run build || exit /b 1

echo.
echo ==^> Running the offline demo
call npm run demo || exit /b 1

echo.
echo Setup complete.
echo.
echo To use a real model, pick a provider:
echo   set OPENAI_API_KEY=...       then: swai review --staged
echo   ollama serve                 then: swai --provider compat review --staged
echo   (the compat provider runs a local model with no key; code stays on this machine)
echo.
echo Run "node bin\swai.js --help" for the full command list.
endlocal
