@echo off
REM Copyright (c) 2025 Smart Site Team
REM SPDX-License-Identifier: Apache-2.0
REM https://smartsite.top/
REM Contact: zkxxa@qq.com, zcwebms@gmail.com
REM
REM Start the ss-rtdb server (Form B) in the foreground.
REM Works both from the repository root and from a release package, because both keep the same
REM layout (bin\ next to src\packages\server).
REM
REM Usage:
REM   bin\start-server.bat
REM
REM Configuration is resolved by the server itself: built-in defaults, then conf\rtdb-server.json
REM (loaded automatically when present, this is where the default configuration ships), then
REM environment variables. Precedence is defaults, config file, environment, explicit arguments.
REM Override the usual knobs before running:
REM
REM   set RTDB_PORT=6199
REM   set RTDB_DATA_DIR=D:\rtdb-data
REM   set RTDB_CONFIG=C:\rtdb\rtdb.custom.json
REM   set RTDB_LOG_LEVEL=debug
REM   bin\start-server.bat

setlocal

set "ROOT=%~dp0.."
if not exist "%ROOT%\src\packages\server\src\main.ts" set "ROOT=%~dp0"
if not exist "%ROOT%\src\packages\server\src\main.ts" (
  echo [ERROR] src\packages\server\src\main.ts not found.
  echo [ERROR] Run this script from the repository root or from a release package.
  exit /b 1
)

REM Display-only defaults (they are NOT exported, so the server keeps its own precedence rules).
set "SHOW_HOST=%RTDB_HOST%"
if "%SHOW_HOST%"=="" set "SHOW_HOST=127.0.0.1"
set "SHOW_PORT=%RTDB_PORT%"
if "%SHOW_PORT%"=="" set "SHOW_PORT=6180"
set "SHOW_DATA=%RTDB_DATA_DIR%"
if "%SHOW_DATA%"=="" set "SHOW_DATA=%ROOT%\rtdb-data"

REM Display-only: the file the server will actually load (RTDB_CONFIG wins over conf\rtdb-server.json).
set "SHOW_CONFIG=%RTDB_CONFIG%"
if not "%SHOW_CONFIG%"=="" goto :config_ready
if exist "%ROOT%\conf\rtdb-server.json" set "SHOW_CONFIG=%ROOT%\conf\rtdb-server.json"
if "%SHOW_CONFIG%"=="" set "SHOW_CONFIG=(built-in defaults; no config file)"
:config_ready

echo [INFO] ss-rtdb server
echo [INFO]   root     : %ROOT%
echo [INFO]   config   : %SHOW_CONFIG%
echo [INFO]   endpoint : http://%SHOW_HOST%:%SHOW_PORT%
echo [INFO]   data dir : %SHOW_DATA%
echo [INFO]   console  : q = quit gracefully, r = reload configuration (Ctrl+C also quits)
echo [INFO]   hint     : press Ctrl+C to stop gracefully
echo.

cd /d "%ROOT%"
node src\packages\server\src\main.ts
set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" echo [ERROR] server exited with code %EXITCODE%
endlocal & exit /b %EXITCODE%
