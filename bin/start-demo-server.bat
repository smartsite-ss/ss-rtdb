@echo off
setlocal
REM Copyright (c) 2025 Smart Site Team
REM SPDX-License-Identifier: Apache-2.0
REM https://smartsite.top/
REM Contact: zkxxa@qq.com, zcwebms@gmail.com
REM
REM Start rtdb-server with the shared demo configuration.
REM
REM Config: src\packages\demo\conf\rtdb-server.json
REM Data:   src\packages\demo\data (created on first start, gitignored)
REM Token:  src\packages\demo\conf\rtdb.token (created on first start, gitignored)
REM
REM Environment variables (RTDB_PORT, RTDB_DATA_DIR, RTDB_AUTH_ENABLED, ...) still
REM override values from the config file.

set "SCRIPT_DIR=%~dp0"
set "SRC_DIR=%SCRIPT_DIR%..\src"
set "CONFIG_FILE=%SRC_DIR%\packages\demo\conf\rtdb-server.json"
set "SERVER_ENTRY=packages\server\src\main.ts"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found in PATH. Install Node 24 or newer.
  exit /b 1
)

if not exist "%CONFIG_FILE%" (
  echo [ERROR] Demo server config not found: "%CONFIG_FILE%"
  exit /b 1
)

if not exist "%SRC_DIR%\%SERVER_ENTRY%" (
  echo [ERROR] rtdb-server entry not found: "%SRC_DIR%\%SERVER_ENTRY%"
  exit /b 1
)

pushd "%SRC_DIR%" >nul
if errorlevel 1 (
  echo [ERROR] Cannot enter "%SRC_DIR%"
  exit /b 1
)

set "RTDB_CONFIG=%CONFIG_FILE%"
echo [demo] config : %RTDB_CONFIG%
echo [demo] data   : %SRC_DIR%\packages\demo\data
echo [demo] token  : %SRC_DIR%\packages\demo\conf\rtdb.token
echo [demo] console: http://127.0.0.1:6180/admin/  (RTDB_PORT overrides the port)
echo.

node "%SERVER_ENTRY%"
set "CODE=%ERRORLEVEL%"

popd
exit /b %CODE%
