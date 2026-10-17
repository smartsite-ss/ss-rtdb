@echo off
setlocal
REM Copyright (c) 2025 Smart Site Team
REM SPDX-License-Identifier: Apache-2.0
REM https://smartsite.top/
REM Contact: zkxxa@qq.com, zcwebms@gmail.com
REM
REM Start rtdb-server with the shared demo configuration, or run the demo client in
REM performance mode against a server that is ALREADY running.
REM
REM Config: src\packages\demo\conf\rtdb-server.json
REM Data:   src\packages\demo\data (created on first start, gitignored)
REM Token:  src\packages\demo\conf\rtdb.token (created on first start, gitignored)
REM
REM Environment variables (RTDB_PORT, RTDB_DATA_DIR, RTDB_AUTH_ENABLED, ...) still
REM override values from the config file.
REM
REM Usage:
REM   bin\start-demo-server.bat                        Start the server in this window
REM   bin\start-demo-server.bat help                   Show this help
REM   bin\start-demo-server.bat bench <pts/s> <seconds> [client options]
REM                                                    Load client only: rtdb-server must
REM                                                    already be running (started manually,
REM                                                    in another window or by a service)
REM
REM Examples:
REM   window 1: bin\start-demo-server.bat
REM   window 2: bin\start-demo-server.bat bench 20000 300000 --token-file rtdb.token

REM   window 2: bin\start-demo-server.bat bench 20000 30 --db perf_demo --interval 500
REM   window 2: bin\start-demo-server.bat bench 5000 60 --points-per-tick 5000
REM
REM The load client sends "rate * interval / 1000" points per batch: with the
REM default 1000 ms sampling interval, "--rate 20000" means 20000 points per batch
REM (one batch per second). Extra options are forwarded to the client unchanged.

set "SCRIPT_DIR=%~dp0"
set "SRC_DIR=%SCRIPT_DIR%..\src"
set "CONFIG_FILE=%SRC_DIR%\packages\demo\conf\rtdb-server.json"
set "SERVER_ENTRY=packages\server\src\main.ts"
set "CLIENT_ENTRY=packages\demo\client-smart-site\src\main.ts"

set "PORT=6180"
if defined RTDB_PORT set "PORT=%RTDB_PORT%"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found in PATH. Install Node 24 or newer.
  exit /b 1
)

set "ACTION=%~1"
if "%ACTION%"=="" goto check_files
if /I "%ACTION%"=="help" goto usage
if /I "%ACTION%"=="-h" goto usage
if /I "%ACTION%"=="--help" goto usage
if /I "%ACTION%"=="bench" goto prepare_bench

echo [ERROR] Unknown action: %ACTION%
call :print_short_usage
exit /b 1

:prepare_bench
shift
set "RATE=%~1"
if "%RATE%"=="" goto bench_usage
shift
set "SECONDS=%~1"
if "%SECONDS%"=="" goto bench_usage
shift
set "EXTRA="
:collect_extra
if "%~1"=="" goto check_files
set "EXTRA=%EXTRA% %1"
shift
goto collect_extra

:check_files
if /I "%ACTION%"=="bench" goto check_bench_files
if not exist "%CONFIG_FILE%" (
  echo [ERROR] Demo server config not found: "%CONFIG_FILE%"
  exit /b 1
)
if not exist "%SRC_DIR%\%SERVER_ENTRY%" (
  echo [ERROR] rtdb-server entry not found: "%SRC_DIR%\%SERVER_ENTRY%"
  exit /b 1
)
goto enter_src

:check_bench_files
if not exist "%SRC_DIR%\%CLIENT_ENTRY%" (
  echo [ERROR] Demo client entry not found: "%SRC_DIR%\%CLIENT_ENTRY%"
  exit /b 1
)

:enter_src
pushd "%SRC_DIR%" >nul
if errorlevel 1 (
  echo [ERROR] Cannot enter "%SRC_DIR%"
  exit /b 1
)

set "RTDB_CONFIG=%CONFIG_FILE%"

if /I "%ACTION%"=="bench" goto bench_start
goto server_foreground

:server_foreground
echo [demo] mode   : server (this window)
echo [demo] config : %RTDB_CONFIG%
echo [demo] data   : %SRC_DIR%\packages\demo\data
echo [demo] token  : %SRC_DIR%\packages\demo\conf\rtdb.token
echo [demo] console: http://127.0.0.1:%PORT%/admin/  (RTDB_PORT overrides the port)
echo.

node "%SERVER_ENTRY%"
set "CODE=%ERRORLEVEL%"
goto finish

:bench_start
set "URL_ARG="
if defined RTDB_PORT set "URL_ARG=--url http://127.0.0.1:%RTDB_PORT%"

echo [demo] mode   : bench (load client only, no server is started)
echo [demo] server : http://127.0.0.1:%PORT%  (must already be running)
echo [demo] target : %RATE% points/s for %SECONDS% s
if not "%EXTRA%"=="" echo [demo] options: %EXTRA%
echo.

REM The server creates the token file on its own start; the client resolves its token
REM once before the first request, so wait for the file instead of racing against it.
set "TOKEN_FILE=%SRC_DIR%\packages\demo\conf\rtdb.token"
set /a WAIT=0
:wait_token
if exist "%TOKEN_FILE%" goto run_client
set /a WAIT+=1
if %WAIT% GEQ 10 goto token_timeout
timeout /t 1 /nobreak >nul
goto wait_token

:token_timeout
echo [demo] token file not found after 10 s: %TOKEN_FILE%
echo [demo] continuing without it (authentication may be disabled, or the server is down).
echo.

:run_client
set /a ATTEMPT=0
:bench_attempt
set /a ATTEMPT+=1
node "%CLIENT_ENTRY%" --rate %RATE% --duration %SECONDS% --log-every 1 %URL_ARG%%EXTRA%
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="3" goto bench_done
if %ATTEMPT% GEQ 3 goto bench_done
echo.
echo [demo] rtdb-server not reachable yet (attempt %ATTEMPT%/3); retrying in 3 s ...
timeout /t 3 /nobreak >nul
goto bench_attempt

:bench_done
echo.
if "%CODE%"=="3" (
  echo [demo] the load client could not reach http://127.0.0.1:%PORT%
  echo [demo] start rtdb-server first, for example: bin\start-demo-server.bat
) else (
  echo [demo] benchmark finished with exit code %CODE%.
)
goto finish

:usage
echo Start rtdb-server with the shared demo configuration, or run the demo client
echo in performance mode against an already running server.
echo.
echo Usage:
echo   bin\start-demo-server.bat                        Start the server in this window
echo   bin\start-demo-server.bat bench ^<pts/s^> ^<seconds^> [client options]
echo                                                    Load client only; rtdb-server must
echo                                                    already be running
echo   bin\start-demo-server.bat help                   Show this help
echo.
echo Examples:
echo   window 1: bin\start-demo-server.bat
echo   window 2: bin\start-demo-server.bat bench 20000 30
echo   window 2: bin\start-demo-server.bat bench 20000 30 --db perf_demo --interval 500
echo   window 2: bin\start-demo-server.bat bench 5000 60 --points-per-tick 5000
echo.
echo Notes:
echo   - bench never starts a server: start it first in another window or as a service.
echo   - bench sends "rate * interval / 1000" points per batch; the interval comes
echo     from packages\demo\conf\client-smart-site.json (default 1000 ms).
echo   - extra options are forwarded to the demo client unchanged: --db, --interval,
echo     --points-per-tick, --total-points, --devices, --verify, ...
echo   - "duration" is in seconds; use a large value (or Ctrl+C) to run indefinitely.
echo     Ctrl+C stops only the client, the server keeps running.
echo   - set RTDB_PORT when the server listens on a port other than 6180.
exit /b 0

:bench_usage
echo [ERROR] bench needs two arguments: ^<pts/s^> ^<seconds^>
call :print_short_usage
exit /b 1

:print_short_usage
echo.
echo Usage:
echo   bin\start-demo-server.bat [help]
echo   bin\start-demo-server.bat bench ^<pts/s^> ^<seconds^> [client options]
echo.
exit /b 0

:finish
popd
exit /b %CODE%
