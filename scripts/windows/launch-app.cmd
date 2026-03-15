@echo off
setlocal
for %%I in ("%~dp0..\..") do set "PROJECT_ROOT=%%~fI"
cd /d "%PROJECT_ROOT%"

if not exist "dist\main\index.js" (
  echo [BridgeGit] Missing build artifacts. Run npm.cmd run build first.
  pause
  endlocal & exit /b 1
)

call npm.cmd start
set "EXIT_CODE=%ERRORLEVEL%"
endlocal & exit /b %EXIT_CODE%
