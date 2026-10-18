@echo off
setlocal enabledelayedexpansion
REM Copyright (c) 2025 Smart Site Team
REM SPDX-License-Identifier: Apache-2.0
REM https://smartsite.top/
REM Contact: zkxxa@qq.com, zcwebms@gmail.com
REM
REM Smart Site demo client wrapper (packages/demo/client-smart-site).
REM
REM Usage:
REM   bin\demo-smart-site.bat list                     Print the device/tag catalog
REM   bin\demo-smart-site.bat dry                      Print one write batch, send nothing
REM   bin\demo-smart-site.bat once                     Write one batch, then verify
REM   bin\demo-smart-site.bat stream [seconds]         Stream and verify (default 60 seconds)
REM   bin\demo-smart-site.bat run [client options]     Forward any client options unchanged
REM   bin\start-demo-server.bat bench 20000 300000 --token-file rtdb.token
REM Examples:
REM   bin\demo-smart-site.bat list
REM   bin\demo-smart-site.bat once --token-file rtdb.token
REM   bin\demo-smart-site.bat stream 60 --glitch-rate 0.002 --token-file ..\release\sea\rtdb.token
REM   bin\demo-smart-site.bat run --devices hvac-chiller --interval 500 --duration 10 --verify
REM   bin\demo-smart-site.bat run --help
REM   
REM Large-volume tests (the batch size is decoupled from the 44-tag catalog, so a
REM single client can saturate the write path):
REM   Target throughput - 20000 points/s for 60 s, then verify the written range:
REM   bin\demo-smart-site.bat run --rate 20000 --duration 60 --verify
REM   Fixed batches - 5000 points every second until 1000000 points are written:
REM   bin\demo-smart-site.bat run --points-per-tick 5000 --interval 1000 --total-points 1000000
REM   Rehearse the same batch size without writing (prints one wire batch):
REM   bin\demo-smart-site.bat dry --points-per-tick 5000
REM   
REM Notes:
REM   - The script always runs from the repository "src" directory, so relative
REM     paths such as ..\release\sea\rtdb.token resolve from there.
REM   - Without an explicit --token / --token-file the client reads RTDB_TOKEN,
REM     then src\rtdb.token, then rtdb.token next to the running executable.

set "SCRIPT_DIR=%~dp0"
set "SRC_DIR=%SCRIPT_DIR%..\src"
set "CLIENT=packages\demo\client-smart-site\src\main.ts"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found in PATH. Install Node 24 or newer.
  exit /b 1
)

if not exist "%SRC_DIR%\%CLIENT%" (
  echo [ERROR] Demo client not found: "%SRC_DIR%\%CLIENT%"
  exit /b 1
)

set "ACTION=%~1"
if "%ACTION%"=="" goto usage
if /I "%ACTION%"=="help" goto usage
if /I "%ACTION%"=="-h" goto usage
if /I "%ACTION%"=="--help" goto usage

shift

if /I "%ACTION%"=="stream" goto prepare_stream
goto collect

:prepare_stream
set "DURATION=%~1"
if "%DURATION%"=="" set "DURATION=60"
shift
goto collect

:collect
set "EXTRA="
:collect_loop
if "%~1"=="" goto dispatch
set "EXTRA=%EXTRA% %1"
shift
goto collect_loop

:dispatch
pushd "%SRC_DIR%" >nul
if errorlevel 1 (
  echo [ERROR] Cannot enter "%SRC_DIR%"
  exit /b 1
)

if /I "%ACTION%"=="list" goto action_list
if /I "%ACTION%"=="dry" goto action_dry
if /I "%ACTION%"=="once" goto action_once
if /I "%ACTION%"=="stream" goto action_stream
if /I "%ACTION%"=="run" goto action_run

echo [ERROR] Unknown action: %ACTION%
call :print_short_usage
popd
exit /b 1

:action_list
node "%CLIENT%" --list %EXTRA%
set "CODE=%ERRORLEVEL%"
goto finish

:action_dry
node "%CLIENT%" --dry-run %EXTRA%
set "CODE=%ERRORLEVEL%"
goto finish

:action_once
node "%CLIENT%" --once --verify %EXTRA%
set "CODE=%ERRORLEVEL%"
goto finish

:action_stream
node "%CLIENT%" --duration %DURATION% --verify --glitch-rate 0.002 %EXTRA%
set "CODE=%ERRORLEVEL%"
goto finish

:action_run
node "%CLIENT%" %EXTRA%
set "CODE=%ERRORLEVEL%"
goto finish

:usage
echo Smart Site demo client wrapper
echo.
echo Usage:
echo   bin\demo-smart-site.bat list                   Print the device/tag catalog
echo   bin\demo-smart-site.bat dry                    Print one write batch, send nothing
echo   bin\demo-smart-site.bat once                   Write one batch, then verify
echo   bin\demo-smart-site.bat stream [seconds]       Stream and verify (default 60 seconds)
echo   bin\demo-smart-site.bat run [client options]   Forward any client options unchanged
echo.
echo Examples:
echo   bin\demo-smart-site.bat list
echo   bin\demo-smart-site.bat once --token-file ..\release\sea\rtdb.token
echo   bin\demo-smart-site.bat stream 60 --glitch-rate 0.002 --token-file ..\release\sea\rtdb.token
echo   bin\demo-smart-site.bat run --help
echo.
echo Large-volume tests:
echo   bin\demo-smart-site.bat run --rate 20000 --duration 60 --verify
echo   bin\demo-smart-site.bat run --points-per-tick 5000 --interval 1000 --total-points 1000000
echo   bin\demo-smart-site.bat dry --points-per-tick 5000
exit /b 0

:print_short_usage
echo.
echo Usage: bin\demo-smart-site.bat list ^| dry ^| once ^| stream [seconds] ^| run [client options]
exit /b 0

:finish
popd
exit /b %CODE%
