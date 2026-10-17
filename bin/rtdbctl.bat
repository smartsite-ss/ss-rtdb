@echo off
REM Copyright (c) 2025 Smart Site Team
REM SPDX-License-Identifier: Apache-2.0
REM https://smartsite.top/
REM Contact: zkxxa@qq.com, zcwebms@gmail.com
REM
REM Wrapper for the rtdbctl management CLI.
REM Works both from the repository root and from a release package.
REM
REM Usage:
REM   bin\rtdbctl.bat status
REM   bin\rtdbctl.bat metrics plant_a
REM   bin\rtdbctl.bat --url http://127.0.0.1:6199 status
REM   bin\rtdbctl.bat --data-dir D:\rtdb-data size plant_a --by-day
REM
REM Offline subcommands (size / repair / restore / archive and retention without a day count)
REM need exclusive access to the data root, so stop the server first.

setlocal

set "ROOT=%~dp0.."
if not exist "%ROOT%\src\packages\cli\src\main.ts" set "ROOT=%~dp0"
if not exist "%ROOT%\src\packages\cli\src\main.ts" (
  echo [ERROR] src\packages\cli\src\main.ts not found.
  echo [ERROR] Run this script from the repository root or from a release package.
  exit /b 1
)

cd /d "%ROOT%"
node src\packages\cli\src\main.ts %*
set "EXITCODE=%ERRORLEVEL%"
endlocal & exit /b %EXITCODE%
