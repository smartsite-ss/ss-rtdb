@echo off
REM Copyright (c) 2025 Smart Site Team
REM SPDX-License-Identifier: Apache-2.0
REM https://smartsite.top/
REM Contact: zkxxa@qq.com, zcwebms@gmail.com
REM
REM Build a single-file Windows executable (rtdb-server.exe) with Node's SEA support.
REM Output: release\sea\  (rtdb-server.exe + admin\dist + rtdb-data on first run).
REM
REM Requirements: Node.js >= 24, npm, and network access only on the first run
REM (postject is installed into bin\.sea-tools and is not tracked by git).
REM
REM Usage:
REM   bin\build-sea.bat

setlocal enabledelayedexpansion

set "ROOT=%~dp0.."
cd /d "%ROOT%"

if not exist "%ROOT%\src\packages\server\src\main.ts" (
  echo [ERROR] src\packages\server\src\main.ts not found. Run this script from the repository.
  exit /b 1
)

set "NODE_MAJOR="
for /f "tokens=*" %%v in ('node -p "process.versions.node.split('.')[0]" 2^>nul') do set "NODE_MAJOR=%%v"
if "%NODE_MAJOR%"=="" (
  echo [ERROR] Node.js was not found in PATH. Install Node.js 24 or newer.
  exit /b 1
)
if %NODE_MAJOR% LSS 24 (
  echo [ERROR] Node.js %NODE_MAJOR% detected. ss-rtdb requires Node.js 24 or newer.
  exit /b 1
)

if not exist "%ROOT%\src\node_modules" (
  echo [INFO] installing workspace dependencies ...
  pushd "%ROOT%\src"
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    popd
    exit /b 1
  )
  popd
)

echo [INFO] building the web console (required for /admin/) ...
pushd "%ROOT%\src"
call npm run build --workspace @ss/rtdb-admin
if errorlevel 1 (
  echo [ERROR] the admin console build failed.
  popd
  exit /b 1
)
popd

echo [INFO] assembling the single-file executable ...
node "%ROOT%\bin\sea\build-sea.mjs"
if errorlevel 1 (
  echo [ERROR] the SEA build failed.
  exit /b 1
)

echo.
echo [OK] done. See release\sea\rtdb-server.exe
endlocal
exit /b 0
