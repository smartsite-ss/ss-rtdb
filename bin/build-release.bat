@echo off
REM Copyright (c) 2025 Smart Site Team
REM SPDX-License-Identifier: Apache-2.0
REM https://smartsite.top/
REM Contact: zkxxa@qq.com, zcwebms@gmail.com
REM
REM Build the workspace and assemble a self-contained release package under release\.
REM
REM Usage:
REM   bin\build-release.bat            package the current version (src\package.json)
REM   bin\build-release.bat 0.2.0      package an explicit version string
REM
REM The package contains everything a target machine needs with only Node.js >= 24 installed:
REM sources, the compiled admin console, documentation and start scripts. No node_modules are
REM copied, because the runtime closure (core / client-node / server / cli) has zero third-party
REM dependencies and uses relative imports of TypeScript sources.

setlocal enabledelayedexpansion

set "ROOT=%~dp0.."
cd /d "%ROOT%"

REM ------------------------------------------------------------------ sanity checks
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

REM ------------------------------------------------------------------ version and target
set "VERSION=%~1"
if "%VERSION%"=="" for /f "tokens=*" %%v in ('node -p "require('./src/package.json').version"') do set "VERSION=%%v"
if "%VERSION%"=="" set "VERSION=0.0.0"

set "TARGET=%ROOT%\release\ss-rtdb-%VERSION%"
echo [INFO] packaging ss-rtdb %VERSION%
echo [INFO] target directory: %TARGET%

REM ------------------------------------------------------------------ dependencies
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

REM ------------------------------------------------------------------ build
echo [INFO] building core, client-node and the admin console ...
pushd "%ROOT%\src"
call npm run build
if errorlevel 1 (
  echo [ERROR] npm run build failed.
  popd
  exit /b 1
)
popd

REM ------------------------------------------------------------------ assemble package
if exist "%TARGET%" (
  echo [INFO] removing the previous package ...
  rmdir /s /q "%TARGET%"
)
mkdir "%TARGET%"
if errorlevel 1 (
  echo [ERROR] cannot create %TARGET%.
  exit /b 1
)

echo [INFO] copying workspace sources ...
robocopy "%ROOT%\src" "%TARGET%\src" /E /XD node_modules __tests__ coverage bench-out /XF *.tsbuildinfo *.log >nul
if errorlevel 8 (
  echo [ERROR] robocopy failed while copying src.
  exit /b 1
)

echo [INFO] copying start scripts ...
mkdir "%TARGET%\bin" 2>nul
copy /y "%ROOT%\bin\start-server.bat" "%TARGET%\bin\start-server.bat" >nul
copy /y "%ROOT%\bin\rtdbctl.bat" "%TARGET%\bin\rtdbctl.bat" >nul

echo [INFO] copying the default configuration ...
robocopy "%ROOT%\conf" "%TARGET%\conf" /E >nul
if errorlevel 8 (
  echo [ERROR] robocopy failed while copying conf.
  exit /b 1
)

echo [INFO] copying documentation ...
robocopy "%ROOT%\docs-o" "%TARGET%\docs" /E >nul
if errorlevel 8 (
  echo [ERROR] robocopy failed while copying docs.
  exit /b 1
)

copy /y "%ROOT%\README.md" "%TARGET%\README.md" >nul
copy /y "%ROOT%\AGENTS.md" "%TARGET%\AGENTS.md" >nul
copy /y "%ROOT%\LICENSE" "%TARGET%\LICENSE" >nul

REM ------------------------------------------------------------------ summary
echo.
echo [OK] release package ready: %TARGET%
echo [OK]   start server : bin\start-server.bat
echo [OK]   management   : bin\rtdbctl.bat status
echo [OK]   web console  : http://127.0.0.1:6180/admin/
echo [OK] remember: the release\ directory is not tracked by git.
endlocal
exit /b 0
