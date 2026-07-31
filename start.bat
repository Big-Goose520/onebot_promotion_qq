@echo off
cd /d "%~dp0"

echo ========================================
echo   OneBot v11 Spam Bot
echo ========================================
echo.

echo Killing old instances...
taskkill /f /im node.exe >nul 2>&1
timeout /t 1 /nobreak >nul
echo Done.
echo.

if not exist "node_modules\" (
    echo Installing dependencies...
    call npm install
    echo.
)

echo Starting...
echo WebUI: http://localhost:3000
echo WS:    ws://127.0.0.1:3001/
echo.

node main.js
pause
