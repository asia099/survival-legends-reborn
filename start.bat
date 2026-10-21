@echo off
setlocal
title Survival Legends: Reborn - server
cd /d "%~dp0"

set "NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  if exist "%ProgramFiles%\nodejs\node.exe" (
    set "NODE=%ProgramFiles%\nodejs\node.exe"
  ) else (
    echo.
    echo   Node.js is required to run the game server.
    echo   Download the LTS version from https://nodejs.org , install it, then run this file again.
    echo.
    pause
    exit /b 1
  )
)

rem Open the game in the default browser once the server has had a moment to start.
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start "" http://localhost:3000"

"%NODE%" server\index.js %*
echo.
echo   The server has stopped.
pause
