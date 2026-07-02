@echo off
chcp 65001 >nul
title SRC Agent

echo ========================================
echo   SRC Agent - Starting Services
echo ========================================
echo.

cd /d "%~dp0"

REM Check .env
if not exist "apps\server\.env" (
    echo [ERROR] apps\server\.env not found.
    echo Please copy apps\server\.env.example to apps\server\.env and fill in your API key.
    pause
    exit /b 1
)

REM Check for pnpm
where pnpm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] pnpm is not installed or not in PATH.
    echo Please install pnpm:  npm install -g pnpm
    pause
    exit /b 1
)

REM Install dependencies from root if needed
if not exist "apps\server\node_modules\.bin\tsx.cmd" (
    echo [WARN] Dependencies not found. Running pnpm install from root...
    pnpm install --prefer-offline
    if errorlevel 1 (
        echo [ERROR] pnpm install failed.
        pause
        exit /b 1
    )
)

echo [1/2] Starting backend (http://localhost:3001) ...
start "SRC Agent - Backend" cmd /k "cd /d %~dp0apps\server && node_modules\.bin\tsx.cmd src\index.ts"

timeout /t 3 /nobreak >nul

echo [2/2] Starting frontend (http://localhost:5173) ...
if not exist "apps\web\node_modules" (
    echo [WARN] Frontend node_modules not found, please run: pnpm install
) else (
    start "SRC Agent - Frontend" cmd /k "cd /d %~dp0apps\web && npm run dev"
)

echo.
echo ========================================
echo   Backend:  http://localhost:3001
echo   Frontend: http://localhost:5173
echo ========================================
echo.
echo Both services are starting in separate windows.
echo Close those windows to stop the services.
pause
